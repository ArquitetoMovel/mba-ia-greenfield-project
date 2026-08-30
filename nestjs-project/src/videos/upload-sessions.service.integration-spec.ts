import { DataSource, Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  UploadSessionNotActiveException,
  VideoAccessDeniedException,
} from '../common/exceptions/domain.exception';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  UploadSession,
  UploadSessionState,
} from './entities/upload-session.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { UploadSessionsService } from './upload-sessions.service';
import { VideosModule } from './videos.module';
import storageConfig from '../config/storage.config';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('UploadSessionsService (integration with PostgreSQL + MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let uploadSessionsService: UploadSessionsService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let outboxRepository: Repository<OutboxEvent>;

  const testEndpoint = process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000';
  const testBucket = process.env.S3_BUCKET || 'streamtube-media';

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
        }),
        TypeOrmModule.forRoot(dataSource.options),
        ChannelsModule,
        StorageModule,
        VideosModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        internalEndpoint: testEndpoint,
        publicEndpoint: testEndpoint,
        region: 'us-east-1',
        bucket: testBucket,
        accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
        secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
        presignedUrlTtlSeconds: 900,
        multipartLifecycleDays: 7,
        hlsUrlTtlSeconds: 3600,
        downloadUrlTtlSeconds: 3600,
      })
      .compile();

    uploadSessionsService = module.get<UploadSessionsService>(
      UploadSessionsService,
    );
    channelsService = module.get<ChannelsService>(ChannelsService);
    userRepository = dataSource.getRepository(User);
    outboxRepository = dataSource.getRepository(OutboxEvent);
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserAndChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `uploader_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { user, channel };
  }

  it('completes the full lifecycle: initiate, upload part via presigned URL, get session, complete with atomic outbox event, and check status', async () => {
    const { user } = await createUserAndChannel();

    // 1. Initiate upload
    const initRes = await uploadSessionsService.initiateUpload(user.id, {
      filename: 'sample_video.mp4',
      content_type: 'video/mp4',
      size_bytes: 5242880, // 5 MiB
      file_fingerprint: 'fp_sample_video_5242880',
    });

    expect(initRes.video_id).toBeDefined();
    expect(initRes.public_id).toBeDefined();
    expect(initRes.upload_session_id).toBeDefined();
    expect(initRes.state).toBe(UploadSessionState.ACTIVE);
    expect(initRes.canonical_url).toBe(`/v/${initRes.public_id}`);

    // 2. Get presigned part URL for part 1
    const partUrlsRes = await uploadSessionsService.getPartUrls(
      user.id,
      initRes.upload_session_id,
      [1],
    );
    expect(partUrlsRes.parts).toHaveLength(1);
    expect(partUrlsRes.parts[0].part_number).toBe(1);

    // 3. Upload 5MB payload to the presigned URL
    const partBuffer = Buffer.alloc(5 * 1024 * 1024, 99);
    const putRes = await fetch(partUrlsRes.parts[0].url, {
      method: 'PUT',
      body: partBuffer,
    });
    expect(putRes.ok).toBe(true);
    const eTag = (putRes.headers.get('etag') || '').replace(/"/g, '');
    expect(eTag).toBeTruthy();

    // 4. Get session status and verify reconciled uploaded parts
    const sessionDetail = await uploadSessionsService.getSession(
      user.id,
      initRes.upload_session_id,
    );
    expect(sessionDetail.state).toBe(UploadSessionState.ACTIVE);
    expect(sessionDetail.processing_status).toBe(
      VideoProcessingStatus.UPLOADING,
    );
    expect(sessionDetail.uploaded_parts).toHaveLength(1);
    expect(sessionDetail.uploaded_parts[0].part_number).toBe(1);

    // 5. Complete multipart upload atomically
    const completeRes = await uploadSessionsService.completeUpload(
      user.id,
      initRes.upload_session_id,
      {
        parts: [{ part_number: 1, etag: eTag }],
      },
    );
    expect(completeRes.public_id).toBe(initRes.public_id);
    expect(completeRes.processing_status).toBe(VideoProcessingStatus.UPLOADED);
    expect(completeRes.processing_version).toBe(1);

    // 6. Verify outbox event was created atomically
    const outboxEvents = await outboxRepository.find({
      where: { aggregate_id: initRes.video_id },
    });
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0].event_type).toBe('video.upload.completed');
    expect(outboxEvents[0].deduplication_key).toBe(
      `video.upload.completed:${initRes.video_id}:1`,
    );
    expect(outboxEvents[0].payload).toEqual({
      videoId: initRes.video_id,
      originalKey: `videos/${initRes.public_id}/original/source.mp4`,
      processingVersion: 1,
    });

    // 7. Verify upload status
    const status = await uploadSessionsService.getUploadStatus(
      user.id,
      initRes.public_id,
    );
    expect(status.processing_status).toBe(VideoProcessingStatus.UPLOADED);
    expect(status.thumbnail_available).toBe(false);
    expect(status.playback_available).toBe(false);

    // 8. Re-completing or completing a completed session throws 409
    await expect(
      uploadSessionsService.completeUpload(user.id, initRes.upload_session_id, {
        parts: [{ part_number: 1, etag: eTag }],
      }),
    ).rejects.toThrow(UploadSessionNotActiveException);
  });

  it('cancels an upload session and marks video and session cancelled', async () => {
    const { user } = await createUserAndChannel();

    const initRes = await uploadSessionsService.initiateUpload(user.id, {
      filename: 'cancel_me.mp4',
      content_type: 'video/mp4',
      size_bytes: 10485760,
      file_fingerprint: 'fp_cancel',
    });

    await uploadSessionsService.cancelUpload(
      user.id,
      initRes.upload_session_id,
    );

    const sessionDetail = await uploadSessionsService.getSession(
      user.id,
      initRes.upload_session_id,
    );
    expect(sessionDetail.state).toBe(UploadSessionState.CANCELLED);
    expect(sessionDetail.processing_status).toBe(
      VideoProcessingStatus.CANCELLED,
    );
  });

  it('rejects access from non-owner users with VideoAccessDeniedException', async () => {
    const user1 = await createUserAndChannel();
    const user2 = await createUserAndChannel();

    const initRes = await uploadSessionsService.initiateUpload(user1.user.id, {
      filename: 'private.mp4',
      content_type: 'video/mp4',
      size_bytes: 10485760,
      file_fingerprint: 'fp_private',
    });

    await expect(
      uploadSessionsService.getSession(
        user2.user.id,
        initRes.upload_session_id,
      ),
    ).rejects.toThrow(VideoAccessDeniedException);

    await expect(
      uploadSessionsService.getUploadStatus(user2.user.id, initRes.public_id),
    ).rejects.toThrow(VideoAccessDeniedException);
  });
});
