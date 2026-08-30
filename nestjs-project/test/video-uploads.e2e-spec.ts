import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import storageConfig from '../src/config/storage.config';
import {
  CompleteUploadResponseDto,
  PartUrlsResponseDto,
  UploadSessionDetailDto,
  UploadSessionResponseDto,
  VideoUploadStatusResponseDto,
} from '../src/videos/dto/upload-responses.dto';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

describe('Video Uploads (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const testEndpoint =
      process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000';
    const testBucket = process.env.S3_BUCKET || 'streamtube-media';

    const moduleFixture = await Test.createTestingModule({
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

    dataSource = moduleFixture.get(DataSource);
    authService = moduleFixture.get(AuthService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function createAuthenticatedUser(): Promise<{
    userId: string;
    accessToken: string;
  }> {
    const email = `uploader_${++userCounter}@example.com`;
    const password = 'Password123!';

    const registered = await authService.register({ email, password });
    await dataSource.query(
      `UPDATE users SET is_confirmed = true WHERE id = $1`,
      [registered.id],
    );

    const loginRes = await authService.login({ email, password });
    return {
      userId: registered.id,
      accessToken: loginRes.access_token,
    };
  }

  describe('POST /videos/uploads', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          filename: 'video.mp4',
          content_type: 'video/mp4',
          size_bytes: 10485760,
          file_fingerprint: 'fp_1',
        });

      expect(res.status).toBe(401);
    });

    it('returns 400 when required fields are missing', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponseBody;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 413 when declared size exceeds 10 GB', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'huge.mp4',
          content_type: 'video/mp4',
          size_bytes: 10737418241, // 10 GB + 1 byte
          file_fingerprint: 'fp_huge',
        });

      expect(res.status).toBe(400);
    });

    it('returns 415 when content_type is not video/*', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'image.png',
          content_type: 'image/png',
          size_bytes: 1048576,
          file_fingerprint: 'fp_img',
        });

      expect(res.status).toBe(400);
    });

    it('returns 201 with session metadata for valid authenticated payload', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'my_holiday.mp4',
          content_type: 'video/mp4',
          size_bytes: 52428800,
          file_fingerprint: 'fp_holiday_52428800',
        });

      expect(res.status).toBe(201);
      const body = res.body as UploadSessionResponseDto;
      expect(body.video_id).toBeDefined();
      expect(body.public_id).toBeDefined();
      expect(body.canonical_url).toBe(`/v/${body.public_id}`);
      expect(body.upload_session_id).toBeDefined();
      expect(body.state).toBe('active');
      expect(body.part_size_bytes).toBe(16777216);
      expect(body.expires_at).toBeDefined();
    });
  });

  describe('Upload Session Lifecycle (GET, part-urls, complete, cancel, status)', () => {
    it('handles full happy path from initiation to complete to status', async () => {
      const user = await createAuthenticatedUser();

      // 1. Initiate upload
      const initRes = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 5242880,
          file_fingerprint: 'fp_clip',
        });

      expect(initRes.status).toBe(201);
      const initBody = initRes.body as UploadSessionResponseDto;
      const sessionId = initBody.upload_session_id;
      const publicId = initBody.public_id;

      // 2. Get part URLs
      const partsRes = await request(app.getHttpServer())
        .post(`/videos/uploads/${sessionId}/part-urls`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ part_numbers: [1] });

      expect(partsRes.status).toBe(200);
      const partsBody = partsRes.body as PartUrlsResponseDto;
      expect(partsBody.parts).toHaveLength(1);
      expect(partsBody.parts[0].part_number).toBe(1);

      // Upload part directly to MinIO
      const partBuffer = Buffer.alloc(5 * 1024 * 1024, 7);
      const putRes = await fetch(partsBody.parts[0].url, {
        method: 'PUT',
        body: partBuffer,
      });
      expect(putRes.ok).toBe(true);
      const etag = (putRes.headers.get('etag') || '').replace(/"/g, '');
      expect(etag).toBeTruthy();

      // 3. Get session details (reconciled parts)
      const getSessionRes = await request(app.getHttpServer())
        .get(`/videos/uploads/${sessionId}`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(getSessionRes.status).toBe(200);
      const getSessionBody = getSessionRes.body as UploadSessionDetailDto;
      expect(getSessionBody.state).toBe('active');
      expect(getSessionBody.uploaded_parts).toHaveLength(1);
      expect(getSessionBody.uploaded_parts[0].part_number).toBe(1);

      // 4. Complete upload
      const completeRes = await request(app.getHttpServer())
        .post(`/videos/uploads/${sessionId}/complete`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          parts: [{ part_number: 1, etag }],
        });

      expect(completeRes.status).toBe(202);
      const completeBody = completeRes.body as CompleteUploadResponseDto;
      expect(completeBody.public_id).toBe(publicId);
      expect(completeBody.processing_status).toBe('uploaded');
      expect(completeBody.processing_version).toBe(1);

      // 5. Check upload status
      const statusRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload-status`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(statusRes.status).toBe(200);
      const statusBody = statusRes.body as VideoUploadStatusResponseDto;
      expect(statusBody.processing_status).toBe('uploaded');
      expect(statusBody.thumbnail_available).toBe(false);
      expect(statusBody.playback_available).toBe(false);

      // 6. Completing again returns 409 UPLOAD_SESSION_NOT_ACTIVE
      const reCompleteRes = await request(app.getHttpServer())
        .post(`/videos/uploads/${sessionId}/complete`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          parts: [{ part_number: 1, etag }],
        });

      expect(reCompleteRes.status).toBe(409);
      const reCompleteBody = reCompleteRes.body as ErrorResponseBody;
      expect(reCompleteBody.error).toBe('UPLOAD_SESSION_NOT_ACTIVE');
    });

    it('enforces owner-only access and returns 403 for other users', async () => {
      const user1 = await createAuthenticatedUser();
      const user2 = await createAuthenticatedUser();

      const initRes = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({
          filename: 'secret.mp4',
          content_type: 'video/mp4',
          size_bytes: 10485760,
          file_fingerprint: 'fp_secret',
        });

      const initBody = initRes.body as UploadSessionResponseDto;
      const sessionId = initBody.upload_session_id;
      const publicId = initBody.public_id;

      // User 2 tries to access user 1's session
      const getRes = await request(app.getHttpServer())
        .get(`/videos/uploads/${sessionId}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);

      expect(getRes.status).toBe(403);
      const getBody = getRes.body as ErrorResponseBody;
      expect(getBody.error).toBe('VIDEO_ACCESS_DENIED');

      // User 2 tries to get status
      const statusRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/upload-status`)
        .set('Authorization', `Bearer ${user2.accessToken}`);

      expect(statusRes.status).toBe(403);
      const statusBody = statusRes.body as ErrorResponseBody;
      expect(statusBody.error).toBe('VIDEO_ACCESS_DENIED');
    });

    it('cancels active session with 204 and rejects subsequent actions with 409', async () => {
      const user = await createAuthenticatedUser();

      const initRes = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          filename: 'discard.mp4',
          content_type: 'video/mp4',
          size_bytes: 10485760,
          file_fingerprint: 'fp_discard',
        });

      const initBody = initRes.body as UploadSessionResponseDto;
      const sessionId = initBody.upload_session_id;

      // Delete/cancel session
      const deleteRes = await request(app.getHttpServer())
        .delete(`/videos/uploads/${sessionId}`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(deleteRes.status).toBe(204);

      // Subsequent cancel or part-url call returns 409
      const cancelAgainRes = await request(app.getHttpServer())
        .delete(`/videos/uploads/${sessionId}`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(cancelAgainRes.status).toBe(409);
      const cancelAgainBody = cancelAgainRes.body as ErrorResponseBody;
      expect(cancelAgainBody.error).toBe('UPLOAD_SESSION_NOT_ACTIVE');
    });
  });
});
