import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — media storage (S3/MinIO)', () => {
  it('should reject when S3 credentials are absent', () => {
    const env = { ...requiredEnv };
    delete (env as Record<string, string>).S3_ACCESS_KEY;
    delete (env as Record<string, string>).S3_SECRET_KEY;
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should reject non-numeric TTL values', () => {
    const { error } = validate({ S3_PRESIGNED_URL_TTL_SECONDS: 'abc' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_PRESIGNED_URL_TTL_SECONDS');
  });

  it('should resolve Docker-service defaults and TTL values into typed values', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_INTERNAL_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_BUCKET).toBe('streamtube-media');
    expect(value.S3_PRESIGNED_URL_TTL_SECONDS).toBe(900);
    expect(value.S3_MULTIPART_LIFECYCLE_DAYS).toBe(7);
    expect(value.S3_HLS_URL_TTL_SECONDS).toBe(3600);
    expect(value.S3_DOWNLOAD_URL_TTL_SECONDS).toBe(3600);
  });
});

describe('envValidationSchema — queue (Redis/BullMQ)', () => {
  it('should reject non-numeric Redis port', () => {
    const { error } = validate({ REDIS_PORT: 'redis' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });

  it('should resolve Docker-service defaults and retry policy into typed values', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_VIDEO_CONCURRENCY).toBe(1);
    expect(value.QUEUE_VIDEO_RETRY_ATTEMPTS).toBe(3);
    expect(value.QUEUE_VIDEO_RETRY_BACKOFF_DELAY_MS).toBe(1000);
  });
});
