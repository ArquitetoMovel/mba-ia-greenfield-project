import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Channel } from '../src/channels/entities/channel.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { S3MediaStorageService } from '../src/storage/s3-media-storage.service';
import storageConfig from '../src/config/storage.config';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

describe('Video Media Delivery Endpoints (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let authService: AuthService;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: S3MediaStorageService;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;

  let userA: { id: string; token: string; channelId: string };
  let userB: { id: string; token: string; channelId: string };

  beforeAll(async () => {
    const testEndpoint =
      process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000';
    const testBucket = process.env.S3_BUCKET || 'streamtube-media';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
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

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );

    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
    authService = moduleFixture.get<AuthService>(AuthService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get<S3MediaStorageService>(
      S3MediaStorageService,
    );
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  let userCounter = 0;
  async function createAuthenticatedUser(): Promise<{
    id: string;
    token: string;
    channelId: string;
  }> {
    const email = `media_user_${++userCounter}@example.com`;
    const password = 'Password123!';

    const registered = await authService.register({ email, password });
    await dataSource.query(
      `UPDATE users SET is_confirmed = true WHERE id = $1`,
      [registered.id],
    );

    const loginRes = await authService.login({ email, password });
    const channel = await channelRepo.findOneBy({ user_id: registered.id });

    return {
      id: registered.id,
      token: loginRes.access_token,
      channelId: channel!.id,
    };
  }

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    userA = await createAuthenticatedUser();
    userB = await createAuthenticatedUser();
  });

  let counter = 0;
  async function createVideo(
    channelId: string,
    status: VideoProcessingStatus,
    withAssets = false,
  ) {
    const publicId = `media_e2e_${++counter}_${Date.now()}`
      .padEnd(22, '0')
      .slice(0, 22);
    const originalKey = storageService.getOriginalKey(publicId, 'source.mp4');
    const masterKey = storageService.getHlsMasterKey(publicId, 1);
    const variantKey = storageService.getHlsVariantKey(publicId, '360p', 1);
    const thumbnailKey = storageService.getThumbnailKey(publicId, 1);
    const segmentKey = `videos/${publicId}/hls/v1/360p/segment_000.ts`;

    if (withAssets) {
      await storageService.putObject(
        originalKey,
        Buffer.from('mp4 binary'),
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
        Buffer.from('ts binary'),
        'video/MP2T',
      );
      await storageService.putObject(
        thumbnailKey,
        Buffer.from('jpeg binary'),
        'image/jpeg',
      );
    }

    return videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        channel_id: channelId,
        original_key: originalKey,
        original_filename: 'source.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '1000',
        processing_status: status,
        processing_version: 1,
        duration_seconds: status === VideoProcessingStatus.READY ? 6.0 : null,
        hls_master_key:
          status === VideoProcessingStatus.READY ? masterKey : null,
        thumbnail_key:
          status === VideoProcessingStatus.READY ? thumbnailKey : null,
        processed_at:
          status === VideoProcessingStatus.READY ? new Date() : null,
      }),
    );
  }

  describe('Unauthenticated requests (401)', () => {
    it('returns 401 for playback master without token', async () => {
      const res = await request(app.getHttpServer() as App).get(
        '/videos/some-id/playback/master',
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 for playback rendition without token', async () => {
      const res = await request(app.getHttpServer() as App).get(
        '/videos/some-id/playback/360p',
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 for thumbnail without token', async () => {
      const res = await request(app.getHttpServer() as App).get(
        '/videos/some-id/thumbnail',
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 for download without token', async () => {
      const res = await request(app.getHttpServer() as App).get(
        '/videos/some-id/download',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('Access Control & Not Found (403 & 404)', () => {
    it('returns 404 for non-existent video', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/videos/non-existent-public-id/playback/master')
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(404);
      const body = res.body as ErrorResponseBody;
      expect(body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 403 when User B attempts to access User A video', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.READY,
        true,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/playback/master`)
        .set('Authorization', `Bearer ${userB.token}`);
      expect(res.status).toBe(403);
      const body = res.body as ErrorResponseBody;
      expect(body.error).toBe('VIDEO_ACCESS_DENIED');
    });
  });

  describe('Readiness validation (409)', () => {
    it('returns 409 when video is still UPLOADED / PROCESSING', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.PROCESSING,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/playback/master`)
        .set('Authorization', `Bearer ${userA.token}`);
      expect(res.status).toBe(409);
      const body = res.body as ErrorResponseBody;
      expect(body.error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('Successful Media Delivery (Ready video)', () => {
    it('GET /videos/:publicId/playback/master returns master playlist with proper headers', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.READY,
        true,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/playback/master`)
        .set('Authorization', `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.apple.mpegurl',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('#EXTM3U');
      expect(res.text).toContain('360p/playlist.m3u8');
    });

    it('GET /videos/:publicId/playback/360p returns variant playlist with signed segment URLs', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.READY,
        true,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/playback/360p`)
        .set('Authorization', `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.apple.mpegurl',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('#EXTM3U');
      expect(res.text).toMatch(
        /http:\/\/.*\/streamtube-media\/videos\/.*\/hls\/v1\/360p\/segment_000\.ts\?/,
      );
    });

    it('GET /videos/:publicId/thumbnail returns 302 redirect with Location header', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.READY,
        true,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/thumbnail`)
        .set('Authorization', `Bearer ${userA.token}`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(
        /http:\/\/.*\/streamtube-media\/videos\/.*\/thumbnails\/v1\/thumbnail\.jpg\?/,
      );
    });

    it('GET /videos/:publicId/download returns 302 redirect with Location header and disposition', async () => {
      const video = await createVideo(
        userA.channelId,
        VideoProcessingStatus.READY,
        true,
      );
      const res = await request(app.getHttpServer() as App)
        .get(`/videos/${video.public_id}/download`)
        .set('Authorization', `Bearer ${userA.token}`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(
        /http:\/\/.*\/streamtube-media\/videos\/.*\/original\/source\.mp4\?/,
      );
      expect(res.headers.location).toContain('response-content-disposition');
    });
  });
});
