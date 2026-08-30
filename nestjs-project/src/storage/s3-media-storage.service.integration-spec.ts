import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3MediaStorageService } from './s3-media-storage.service';
import { StorageModule } from './storage.module';

describe('S3MediaStorageService (integration with MinIO)', () => {
  let service: S3MediaStorageService;
  let module: TestingModule;

  const testEndpoint = process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000';
  const testBucket = process.env.S3_BUCKET || 'streamtube-media';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
        }),
        StorageModule,
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

    service = module.get<S3MediaStorageService>(S3MediaStorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should generate standardized keys rooted at videos/{publicId}/', () => {
    const publicId = 'test_pub_123456789012';
    expect(service.getOriginalKey(publicId, 'sample.mp4')).toBe(
      `videos/${publicId}/original/source.mp4`,
    );
    expect(service.getHlsMasterKey(publicId, 1)).toBe(
      `videos/${publicId}/hls/v1/master.m3u8`,
    );
    expect(service.getThumbnailKey(publicId, 1)).toBe(
      `videos/${publicId}/thumbnails/v1/thumbnail.jpg`,
    );
  });

  it('should put, head, get, and delete single objects', async () => {
    const key = 'test/integration/simple-object.txt';
    const content = 'StreamTube storage integration test';

    const putRes = await service.putObject(key, content, 'text/plain');
    expect(putRes.eTag).toBeDefined();

    const headRes = await service.headObject(key);
    expect(headRes).toBeDefined();
    expect(headRes?.contentLength).toBe(Buffer.byteLength(content));

    const getRes = await service.getObject(key);
    expect(getRes.body).toBeDefined();

    await service.deleteObject(key);

    const deletedHead = await service.headObject(key);
    expect(deletedHead).toBeNull();
  });

  it('should initiate, sign parts, upload via presigned URL, list parts, complete, and verify with HeadObject', async () => {
    const publicId = 'test_multipart_000001';
    const key = service.getOriginalKey(publicId, 'test.bin');

    // 1. Create multipart upload
    const session = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(session.uploadId).toBeDefined();
    expect(session.key).toBe(key);

    // 2. Generate presigned part URLs for part 1 and part 2
    const partUrls = await service.getPresignedUploadPartUrls(
      key,
      session.uploadId,
      [1, 2],
    );
    expect(partUrls).toHaveLength(2);
    expect(partUrls[0].partNumber).toBe(1);
    expect(partUrls[1].partNumber).toBe(2);

    // 3. Upload 5MB payload for part 1 and part 2 (MinIO enforces 5MB min for non-final parts)
    const part1Buffer = Buffer.alloc(5 * 1024 * 1024, 1);
    const part2Buffer = Buffer.alloc(5 * 1024 * 1024, 2);

    const res1 = await fetch(partUrls[0].url, {
      method: 'PUT',
      body: part1Buffer,
    });
    expect(res1.ok).toBe(true);
    const eTag1 = (res1.headers.get('etag') || '').replace(/"/g, '');
    expect(eTag1).toBeTruthy();

    const res2 = await fetch(partUrls[1].url, {
      method: 'PUT',
      body: part2Buffer,
    });
    expect(res2.ok).toBe(true);
    const eTag2 = (res2.headers.get('etag') || '').replace(/"/g, '');
    expect(eTag2).toBeTruthy();

    // 4. List parts
    const partsList = await service.listParts(key, session.uploadId);
    expect(partsList).toHaveLength(2);
    expect(partsList.map((p) => p.partNumber)).toEqual([1, 2]);

    // 5. Complete multipart upload
    const completeRes = await service.completeMultipartUpload(
      key,
      session.uploadId,
      [
        { partNumber: 2, eTag: eTag2 },
        { partNumber: 1, eTag: eTag1 },
      ],
    );
    expect(completeRes.key).toBe(key);
    expect(completeRes.eTag).toBeDefined();

    // 6. Verify object existence and final size with HeadObject
    const head = await service.headObject(key);
    expect(head).toBeDefined();
    expect(head?.contentLength).toBe(10 * 1024 * 1024);

    // 7. Verify presigned download and playback URLs
    const downloadRes = await service.getPresignedDownloadUrl(
      key,
      300,
      'original-test.bin',
    );
    expect(downloadRes.url).toContain(encodeURIComponent('original-test.bin'));
    expect(downloadRes.expiresAt).toBeInstanceOf(Date);

    const playbackRes = await service.getPresignedPlaybackUrl(key, 300);
    expect(playbackRes.url).toBeDefined();

    // Cleanup
    await service.deleteObject(key);
  });

  it('should abort multipart upload and clean up unfinished state', async () => {
    const key = 'test/abort/upload.bin';
    const session = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(session.uploadId).toBeDefined();

    await service.abortMultipartUpload(key, session.uploadId);

    // Listing parts on aborted session should throw / return error
    await expect(service.listParts(key, session.uploadId)).rejects.toThrow();
  });

  it('should reject invalid part numbers when generating presigned part URLs', async () => {
    const key = 'test/invalid-part.bin';
    const session = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await expect(
      service.getPresignedUploadPartUrls(key, session.uploadId, [0]),
    ).rejects.toThrow();

    await expect(
      service.getPresignedUploadPartUrls(key, session.uploadId, [10001]),
    ).rejects.toThrow();

    await service.abortMultipartUpload(key, session.uploadId);
  });
});
