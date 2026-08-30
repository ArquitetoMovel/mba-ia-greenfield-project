import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  internalEndpoint: process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET || 'streamtube-media',
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
  presignedUrlTtlSeconds: parseInt(
    process.env.S3_PRESIGNED_URL_TTL_SECONDS || '900',
    10,
  ),
  multipartLifecycleDays: parseInt(
    process.env.S3_MULTIPART_LIFECYCLE_DAYS || '7',
    10,
  ),
  hlsUrlTtlSeconds: parseInt(process.env.S3_HLS_URL_TTL_SECONDS || '3600', 10),
  downloadUrlTtlSeconds: parseInt(
    process.env.S3_DOWNLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
