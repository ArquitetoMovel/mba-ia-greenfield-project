import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosUploadSessionsAndOutbox1777600000000 implements MigrationInterface {
  name = 'CreateVideosUploadSessionsAndOutbox1777600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."upload_sessions_state_enum" AS ENUM('active', 'completed', 'cancelled', 'expired')`,
    );

    await queryRunner.query(
      `CREATE TABLE "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "public_id" character varying(22) NOT NULL,
        "channel_id" uuid NOT NULL,
        "original_key" text NOT NULL,
        "original_filename" character varying(255) NOT NULL,
        "declared_content_type" character varying(127) NOT NULL,
        "declared_size_bytes" bigint NOT NULL,
        "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'uploading',
        "processing_version" integer NOT NULL DEFAULT 1,
        "duration_seconds" numeric(10,3),
        "media_metadata" jsonb,
        "hls_master_key" text,
        "thumbnail_key" text,
        "processing_error" text,
        "processed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_videos_public_id" UNIQUE ("public_id"),
        CONSTRAINT "UQ_videos_original_key" UNIQUE ("original_key"),
        CONSTRAINT "CHK_videos_declared_size" CHECK ("declared_size_bytes" > 0 AND "declared_size_bytes" <= 10737418240),
        CONSTRAINT "PK_videos_id" PRIMARY KEY ("id")
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_videos_public_id" ON "videos" ("public_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_status" ON "videos" ("channel_id", "processing_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status_updated" ON "videos" ("processing_status", "updated_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "upload_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "video_id" uuid NOT NULL,
        "s3_upload_id" text NOT NULL,
        "object_key" text NOT NULL,
        "file_fingerprint" character varying(512) NOT NULL,
        "expected_size_bytes" bigint NOT NULL,
        "part_size_bytes" integer NOT NULL DEFAULT 16777216,
        "declared_content_type" character varying(127) NOT NULL,
        "state" "public"."upload_sessions_state_enum" NOT NULL DEFAULT 'active',
        "expires_at" TIMESTAMP NOT NULL,
        "completed_at" TIMESTAMP,
        "cancelled_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_upload_sessions_video_id" UNIQUE ("video_id"),
        CONSTRAINT "UQ_upload_sessions_s3_upload_id" UNIQUE ("s3_upload_id"),
        CONSTRAINT "UQ_upload_sessions_object_key" UNIQUE ("object_key"),
        CONSTRAINT "CHK_upload_sessions_expected_size" CHECK ("expected_size_bytes" > 0 AND "expected_size_bytes" <= 10737418240),
        CONSTRAINT "PK_upload_sessions_id" PRIMARY KEY ("id")
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_upload_sessions_video_id" ON "upload_sessions" ("video_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_upload_sessions_s3_upload_id" ON "upload_sessions" ("s3_upload_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_upload_sessions_state_expires" ON "upload_sessions" ("state", "expires_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "upload_sessions" ADD CONSTRAINT "FK_upload_sessions_video_id" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "aggregate_id" uuid NOT NULL,
        "aggregate_version" integer NOT NULL,
        "event_type" character varying(100) NOT NULL,
        "deduplication_key" character varying(180) NOT NULL,
        "payload" jsonb NOT NULL,
        "dispatch_attempts" integer NOT NULL DEFAULT 0,
        "dispatched_at" TIMESTAMP,
        "last_error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_outbox_events_dedup" UNIQUE ("deduplication_key"),
        CONSTRAINT "PK_outbox_events_id" PRIMARY KEY ("id")
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_outbox_events_dedup" ON "outbox_events" ("deduplication_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_pending" ON "outbox_events" ("dispatched_at", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_audit" ON "outbox_events" ("aggregate_id", "aggregate_version")`,
    );

    await queryRunner.query(
      `ALTER TABLE "outbox_events" ADD CONSTRAINT "FK_outbox_events_aggregate_id" FOREIGN KEY ("aggregate_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "outbox_events" DROP CONSTRAINT "FK_outbox_events_aggregate_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_events_audit"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_events_pending"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_events_dedup"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);

    await queryRunner.query(
      `ALTER TABLE "upload_sessions" DROP CONSTRAINT "FK_upload_sessions_video_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_upload_sessions_state_expires"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_upload_sessions_s3_upload_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_upload_sessions_video_id"`,
    );
    await queryRunner.query(`DROP TABLE "upload_sessions"`);

    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_status_updated"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_public_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);

    await queryRunner.query(`DROP TYPE "public"."upload_sessions_state_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
  }
}
