import { DataSource, EntityManager, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import {
  VIDEO_PROCESSING_JOB_NAME,
  VideoUploadCompletedPayload,
} from './outbox.types';

describe('OutboxRelayService (unit)', () => {
  let service: OutboxRelayService;
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let outboxRepo: jest.Mocked<Partial<Repository<OutboxEvent>>>;
  let queue: jest.Mocked<Partial<Queue<VideoUploadCompletedPayload>>>;

  const mockConfig = {
    host: 'redis',
    port: 6379,
    videoConcurrency: 1,
    retryAttempts: 3,
    retryBackoffDelayMs: 1000,
  };

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' } as any),
    };

    outboxRepo = {
      find: jest.fn(),
      save: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn(),
    };

    service = new OutboxRelayService(
      dataSource as DataSource,
      outboxRepo as Repository<OutboxEvent>,
      queue as Queue<VideoUploadCompletedPayload>,
      mockConfig,
    );
  });

  describe('processBatch', () => {
    it('returns 0 when no pending events are found', async () => {
      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };

      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      } as unknown as EntityManager;

      (dataSource.transaction as jest.Mock).mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(mockManager),
      );

      const count = await service.processBatch();
      expect(count).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('claims pending events with FOR UPDATE SKIP LOCKED, dispatches with deterministic jobId, and marks dispatched', async () => {
      const event: Partial<OutboxEvent> = {
        id: 'outbox-1',
        event_type: 'video.upload.completed',
        deduplication_key: 'video.upload.completed:vid-1:1',
        payload: {
          videoId: 'vid-1',
          originalKey: 'videos/pub1/original/source.mp4',
          processingVersion: 1,
        },
        dispatched_at: null,
        dispatch_attempts: 0,
      };

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([event]),
      };

      const savedEntities: any[] = [];
      const saveSpy = jest.fn().mockImplementation((_, entity) => {
        savedEntities.push(entity);
        return Promise.resolve(entity);
      });
      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
        save: saveSpy,
      } as unknown as EntityManager;

      (dataSource.transaction as jest.Mock).mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(mockManager),
      );

      const count = await service.processBatch();
      expect(count).toBe(1);

      expect(mockQueryBuilder.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
      );
      expect(mockQueryBuilder.setOnLocked).toHaveBeenCalledWith('skip_locked');

      expect(queue.add).toHaveBeenCalledWith(
        VIDEO_PROCESSING_JOB_NAME,
        event.payload,
        expect.objectContaining({
          jobId: 'video.upload.completed:vid-1:1',
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }),
      );

      expect(event.dispatched_at).toBeInstanceOf(Date);
      expect(event.last_error).toBeNull();
      expect(saveSpy).toHaveBeenCalled();
    });

    it('records dispatch error and leaves row undispatched when queue.add fails', async () => {
      const event: Partial<OutboxEvent> = {
        id: 'outbox-1',
        event_type: 'video.upload.completed',
        deduplication_key: 'video.upload.completed:vid-1:1',
        payload: {
          videoId: 'vid-1',
          originalKey: 'videos/pub1/original/source.mp4',
          processingVersion: 1,
        },
        dispatched_at: null,
        dispatch_attempts: 0,
      };

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([event]),
      };

      const saveSpy = jest
        .fn()
        .mockImplementation((_, entity) => Promise.resolve(entity));
      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
        save: saveSpy,
      } as unknown as EntityManager;

      (dataSource.transaction as jest.Mock).mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(mockManager),
      );

      (queue.add as jest.Mock).mockRejectedValueOnce(
        new Error('Redis connection down'),
      );

      const count = await service.processBatch();
      expect(count).toBe(0);

      expect(event.dispatched_at).toBeNull();
      expect(event.dispatch_attempts).toBe(1);
      expect(event.last_error).toBe('Redis connection down');
      expect(saveSpy).toHaveBeenCalled();
    });
  });
});
