import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Video } from './video.entity';

@Entity('outbox_events')
@Index('IDX_outbox_events_dedup', ['deduplication_key'], { unique: true })
@Index('IDX_outbox_events_pending', ['dispatched_at', 'created_at'])
@Index('IDX_outbox_events_audit', ['aggregate_id', 'aggregate_version'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  aggregate_id: string;

  @Column({ type: 'integer' })
  aggregate_version: number;

  @Column({ type: 'varchar', length: 100 })
  event_type: string;

  @Column({ type: 'varchar', length: 180, unique: true })
  deduplication_key: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @Column({ type: 'integer', default: 0 })
  dispatch_attempts: number;

  @Column({ type: 'timestamp', nullable: true })
  dispatched_at: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Video, (video) => video.outbox_events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'aggregate_id' })
  video: Video;
}
