import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Video } from './video.entity';

export enum UploadSessionState {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

@Entity('upload_sessions')
@Index('IDX_upload_sessions_video_id', ['video_id'], { unique: true })
@Index('IDX_upload_sessions_s3_upload_id', ['s3_upload_id'], { unique: true })
@Index('IDX_upload_sessions_state_expires', ['state', 'expires_at'])
@Check(`"expected_size_bytes" > 0 AND "expected_size_bytes" <= 10737418240`)
export class UploadSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  video_id: string;

  @Column({ type: 'text', unique: true })
  s3_upload_id: string;

  @Column({ type: 'text', unique: true })
  object_key: string;

  @Column({ type: 'varchar', length: 512 })
  file_fingerprint: string;

  @Column({ type: 'bigint' })
  expected_size_bytes: string;

  @Column({ type: 'integer', default: 16777216 })
  part_size_bytes: number;

  @Column({ type: 'varchar', length: 127 })
  declared_content_type: string;

  @Column({
    type: 'enum',
    enum: UploadSessionState,
    default: UploadSessionState.ACTIVE,
  })
  state: UploadSessionState;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToOne(() => Video, (video) => video.upload_session, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
