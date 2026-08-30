import { DataSource, Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { VideoWorkerModule } from './video-worker.module';
import { VideoProcessorService } from './video-processor.service';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoUploadCompletedPayload,
} from '../outbox/outbox.types';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('VideoProcessorService (integration with PostgreSQL, MinIO, and FFmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessorService;
  let storageService: S3MediaStorageService;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  let fixturePath: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(dataSource.options),
        VideoWorkerModule,
      ],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue({ add: jest.fn() })
      .compile();

    processor = module.get<VideoProcessorService>(VideoProcessorService);
    storageService = module.get<S3MediaStorageService>(S3MediaStorageService);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);

    // Generate synthetic 1-second video fixture using ffmpeg
    fixturePath = path.join(os.tmpdir(), 'streamtube-integration-fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=640x360:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      fixturePath,
    ]);
  }, 30000);

  afterAll(async () => {
    await fs.rm(fixturePath, { force: true }).catch(() => {});
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUploadedVideo(): Promise<Video> {
    const user = await userRepo.save(
      userRepo.create({
        email: `worker_user_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        user_id: user.id,
        name: `Worker Channel ${counter}`,
        nickname: `worker_nick_${counter}`,
      }),
    );
    const publicId = `worker_pub_${counter}_${Date.now()}`
      .padEnd(22, '0')
      .slice(0, 22);

    const originalKey = storageService.getOriginalKey(publicId, 'fixture.mp4');
    const fixtureBuffer = await fs.readFile(fixturePath);
    await storageService.putObject(originalKey, fixtureBuffer, 'video/mp4');

    return videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        channel_id: channel.id,
        original_key: originalKey,
        original_filename: 'fixture.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: String(fixtureBuffer.length),
        processing_status: VideoProcessingStatus.UPLOADED,
        processing_version: 1,
      }),
    );
  }

  it('processes video: transcode HLS, generates thumbnail, updates database to READY', async () => {
    const video = await createUploadedVideo();

    const job = {
      id: `job-worker-${video.id}`,
      data: {
        videoId: video.id,
        originalKey: video.original_key,
        processingVersion: 1,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<VideoUploadCompletedPayload, void, string>;

    await processor.process(job);

    // Verify DB record
    const updated = await videoRepo.findOneBy({ id: video.id });
    expect(updated).not.toBeNull();
    expect(updated?.processing_status).toBe(VideoProcessingStatus.READY);
    expect(Number(updated?.duration_seconds)).toBeGreaterThanOrEqual(0.9);
    expect(updated?.media_metadata).not.toBeNull();
    expect(updated?.hls_master_key).toBe(
      `videos/${video.public_id}/hls/v1/master.m3u8`,
    );
    expect(updated?.thumbnail_key).toBe(
      `videos/${video.public_id}/thumbnails/v1/thumbnail.jpg`,
    );
    expect(updated?.processed_at).toBeInstanceOf(Date);
    expect(updated?.processing_error).toBeNull();

    // Verify S3 assets exist
    const masterHead = await storageService.headObject(
      `videos/${video.public_id}/hls/v1/master.m3u8`,
    );
    expect(masterHead).not.toBeNull();

    const renditionHead = await storageService.headObject(
      `videos/${video.public_id}/hls/v1/360p/playlist.m3u8`,
    );
    expect(renditionHead).not.toBeNull();

    const thumbnailHead = await storageService.headObject(
      `videos/${video.public_id}/thumbnails/v1/thumbnail.jpg`,
    );
    expect(thumbnailHead).not.toBeNull();
  }, 45000);
});
