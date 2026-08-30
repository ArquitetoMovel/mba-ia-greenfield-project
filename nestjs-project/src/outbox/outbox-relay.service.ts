import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import {
  VIDEO_PROCESSING_JOB_NAME,
  VIDEO_PROCESSING_QUEUE,
  VideoUploadCompletedPayload,
} from './outbox.types';

@Injectable()
export class OutboxRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<VideoUploadCompletedPayload>,
    @Inject(queueConfig.KEY)
    private readonly qConfig: ConfigType<typeof queueConfig>,
  ) {}

  async processBatch(batchSize = 20): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const events = await manager
        .createQueryBuilder(OutboxEvent, 'event')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('event.dispatched_at IS NULL')
        .orderBy('event.created_at', 'ASC')
        .limit(batchSize)
        .getMany();

      if (events.length === 0) {
        return 0;
      }

      let dispatchedCount = 0;

      for (const event of events) {
        try {
          await this.videoProcessingQueue.add(
            VIDEO_PROCESSING_JOB_NAME,
            event.payload as VideoUploadCompletedPayload,
            {
              jobId: event.deduplication_key,
              attempts: this.qConfig.retryAttempts,
              backoff: {
                type: 'exponential',
                delay: this.qConfig.retryBackoffDelayMs,
              },
              removeOnComplete: {
                age: 7 * 24 * 3600, // Retain completed jobs for 7 days
                count: 10000,
              },
              removeOnFail: false,
            },
          );

          event.dispatched_at = new Date();
          event.last_error = null;
          await manager.save(OutboxEvent, event);
          dispatchedCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Failed to dispatch outbox event ${event.id} (${event.deduplication_key}): ${errorMsg}`,
          );
          event.dispatch_attempts = (event.dispatch_attempts || 0) + 1;
          event.last_error = errorMsg;
          await manager.save(OutboxEvent, event);
        }
      }

      return dispatchedCount;
    });
  }

  async startRelayLoop(intervalMs = 1000): Promise<void> {
    this.isRunning = true;
    this.logger.log(
      `Outbox relay loop started (poll interval: ${intervalMs}ms)`,
    );

    const runLoop = async (): Promise<void> => {
      if (!this.isRunning) return;

      try {
        const dispatched = await this.processBatch();
        if (dispatched > 0) {
          this.logger.debug(`Dispatched ${dispatched} outbox events`);
        }
      } catch (err) {
        this.logger.error(
          `Unexpected error in outbox relay loop: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (this.isRunning) {
        this.timer = setTimeout(() => {
          void runLoop();
        }, intervalMs);
      }
    };

    await runLoop();
  }

  stopRelayLoop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log('Outbox relay loop stopped');
  }

  onModuleDestroy(): void {
    this.stopRelayLoop();
  }
}
