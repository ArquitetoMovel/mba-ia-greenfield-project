import { DataSource, Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideosModule } from './videos.module';
import { MediaDeliveryService } from './media-delivery.service';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { UploadSession } from './entities/upload-session.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
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

describe('MediaDeliveryService (integration with PostgreSQL + MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: MediaDeliveryService;
  let storageService: S3MediaStorageService;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
        }),
        TypeOrmModule.forRoot(dataSource.options),
        VideosModule,
      ],
    }).compile();

    service = module.get<MediaDeliveryService>(MediaDeliveryService);
    storageService = module.get<S3MediaStorageService>(S3MediaStorageService);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createReadyVideoFixture() {
    const user = await userRepo.save(
      userRepo.create({
        email: `media_user_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        user_id: user.id,
        name: `Media Channel ${counter}`,
        nickname: `media_nick_${counter}`,
      }),
    );
    const publicId = `media_pub_${counter}_${Date.now()}`
      .padEnd(22, '0')
      .slice(0, 22);

    const originalKey = storageService.getOriginalKey(
      publicId,
      'test_video.mp4',
    );
    const masterKey = storageService.getHlsMasterKey(publicId, 1);
    const variantKey = storageService.getHlsVariantKey(publicId, '360p', 1);
    const segmentKey = `videos/${publicId}/hls/v1/360p/segment_000.ts`;
    const thumbnailKey = storageService.getThumbnailKey(publicId, 1);

    // Seed MinIO objects
    await storageService.putObject(
      originalKey,
      Buffer.from('fake mp4 binary content'),
      'video/mp4',
    );
    await storageService.putObject(
      masterKey,
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=896000\n360p/playlist.m3u8\n',
      'application/vnd.apple.mpegurl',
    );
    await storageService.putObject(
      variantKey,
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nsegment_000.ts\n#EXT-X-ENDLIST\n',
      'application/vnd.apple.mpegurl',
    );
    await storageService.putObject(
      segmentKey,
      Buffer.from('fake ts binary content'),
      'video/MP2T',
    );
    await storageService.putObject(
      thumbnailKey,
      Buffer.from('fake jpeg binary content'),
      'image/jpeg',
    );

    const video = await videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        channel_id: channel.id,
        original_key: originalKey,
        original_filename: 'test_video.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '1000',
        processing_status: VideoProcessingStatus.READY,
        processing_version: 1,
        duration_seconds: 6.0,
        hls_master_key: masterKey,
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
      }),
    );

    return { user, channel, video };
  }

  it('retrieves HLS master manifest', async () => {
    const { user, video } = await createReadyVideoFixture();
    const manifest = await service.getMasterManifest(user.id, video.public_id);
    expect(manifest).toContain('#EXTM3U');
    expect(manifest).toContain('360p/playlist.m3u8');
  });

  it('retrieves HLS rendition playlist with signed segment URLs', async () => {
    const { user, video } = await createReadyVideoFixture();
    const playlist = await service.getRenditionManifest(
      user.id,
      video.public_id,
      '360p',
    );
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(playlist).toMatch(
      /http:\/\/.*\/streamtube-media\/videos\/.*\/hls\/v1\/360p\/segment_000\.ts\?/,
    );
  });

  it('generates presigned thumbnail redirect URL', async () => {
    const { user, video } = await createReadyVideoFixture();
    const url = await service.getThumbnailRedirectUrl(user.id, video.public_id);
    expect(url).toMatch(
      /http:\/\/.*\/streamtube-media\/videos\/.*\/thumbnails\/v1\/thumbnail\.jpg\?/,
    );
  });

  it('generates presigned download redirect URL with filename disposition', async () => {
    const { user, video } = await createReadyVideoFixture();
    const url = await service.getDownloadRedirectUrl(user.id, video.public_id);
    expect(url).toMatch(
      /http:\/\/.*\/streamtube-media\/videos\/.*\/original\/source\.mp4\?/,
    );
    expect(url).toContain('response-content-disposition');
  });
});
