import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoConcurrency: parseInt(process.env.QUEUE_VIDEO_CONCURRENCY || '1', 10),
  retryAttempts: parseInt(process.env.QUEUE_VIDEO_RETRY_ATTEMPTS || '3', 10),
  retryBackoffDelayMs: parseInt(
    process.env.QUEUE_VIDEO_RETRY_BACKOFF_DELAY_MS || '1000',
    10,
  ),
}));
