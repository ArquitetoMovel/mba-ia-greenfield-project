import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { UploadSession } from './upload-session.entity';
import { OutboxEvent } from './outbox-event.entity';

export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  UPLOADED = 'uploaded',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('videos')
@Index('IDX_videos_public_id', ['public_id'], { unique: true })
@Index('IDX_videos_channel_status', ['channel_id', 'processing_status'])
@Index('IDX_videos_status_updated', ['processing_status', 'updated_at'])
@Check(`"declared_size_bytes" > 0 AND "declared_size_bytes" <= 10737418240`)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 22, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'text', unique: true })
  original_key: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  declared_content_type: string;

  @Column({ type: 'bigint' })
  declared_size_bytes: string;

  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'integer', default: 1 })
  processing_version: number;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: number | string | null;

  @Column({ type: 'jsonb', nullable: true })
  media_metadata: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  hls_master_key: string | null;

  @Column({ type: 'text', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @OneToOne(() => UploadSession, (session) => session.video)
  upload_session?: UploadSession;

  @OneToMany(() => OutboxEvent, (event) => event.video)
  outbox_events?: OutboxEvent[];
}
