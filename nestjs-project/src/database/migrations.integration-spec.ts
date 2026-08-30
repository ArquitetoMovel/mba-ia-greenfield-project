import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideosUploadSessionsAndOutbox1777600000000 } from './migrations/1777600000000-CreateVideosUploadSessionsAndOutbox';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'upload_sessions',
  'outbox_events',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [
        User,
        Channel,
        RefreshToken,
        VerificationToken,
        Video,
        UploadSession,
        OutboxEvent,
      ],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideosUploadSessionsAndOutbox1777600000000,
        ],
      },
    );

    await dataSource.initialize();

    await dataSource.query(
      `DROP TABLE IF EXISTS "outbox_events", "upload_sessions", "videos", "refresh_tokens", "verification_tokens", "channels", "users", "migrations" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."videos_processing_status_enum", "public"."upload_sessions_state_enum", "public"."verification_tokens_type_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all seven tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'outbox_events',
      'refresh_tokens',
      'upload_sessions',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove video tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['outbox_events', 'upload_sessions', 'videos']],
    );
    expect(result).toHaveLength(0);
  });
});
