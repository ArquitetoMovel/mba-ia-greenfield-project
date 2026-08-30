import { DataSource, Repository } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OutboxModule } from './outbox.module';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoUploadCompletedPayload,
} from './outbox.types';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('OutboxRelayService (integration with PostgreSQL + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let relayService: OutboxRelayService;
  let outboxRepo: Repository<OutboxEvent>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  let queue: Queue<VideoUploadCompletedPayload>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [queueConfig],
        }),
        TypeOrmModule.forRoot(dataSource.options),
        OutboxModule,
      ],
    }).compile();

    relayService = module.get<OutboxRelayService>(OutboxRelayService);
    outboxRepo = dataSource.getRepository(OutboxEvent);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
    queue = module.get<Queue<VideoUploadCompletedPayload>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    await queue.drain();
    await queue.clean(0, 1000, 'completed');
    await queue.clean(0, 1000, 'failed');
    await queue.clean(0, 1000, 'wait');
    await queue.clean(0, 1000, 'active');
    await queue.close();
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
    await queue.clean(0, 1000, 'completed');
    await queue.clean(0, 1000, 'failed');
    await queue.clean(0, 1000, 'wait');
    await queue.clean(0, 1000, 'active');
  });

  let counter = 0;
  async function createVideo(): Promise<Video> {
    const user = await userRepo.save(
      userRepo.create({
        email: `outbox_user_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        user_id: user.id,
        name: `Channel ${counter}`,
        nickname: `outbox_nick_${counter}`,
      }),
    );
    const publicId = `pub_id_${counter}_${Date.now()}`
      .padEnd(22, '0')
      .slice(0, 22);

    return videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        channel_id: channel.id,
        original_key: `videos/${publicId}/original/source.mp4`,
        original_filename: 'source.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '52428800',
        processing_status: VideoProcessingStatus.UPLOADED,
        processing_version: 1,
      }),
    );
  }

  it('delivers a pending outbox record to BullMQ and marks it dispatched', async () => {
    const video = await createVideo();
    const deduplicationKey = `video.upload.completed:${video.id}:1`;

    const outboxEvent = await outboxRepo.save(
      outboxRepo.create({
        aggregate_id: video.id,
        aggregate_version: 1,
        event_type: 'video.upload.completed',
        deduplication_key: deduplicationKey,
        payload: {
          videoId: video.id,
          originalKey: video.original_key,
          processingVersion: 1,
        },
        dispatch_attempts: 0,
      }),
    );

    const dispatchedCount = await relayService.processBatch();
    expect(dispatchedCount).toBe(1);

    // Verify row was updated in database
    const refreshed = await outboxRepo.findOneBy({ id: outboxEvent.id });
    expect(refreshed).not.toBeNull();
    expect(refreshed?.dispatched_at).not.toBeNull();
    expect(refreshed?.last_error).toBeNull();

    // Verify BullMQ job exists in Redis
    const job = await queue.getJob(deduplicationKey);
    expect(job).not.toBeNull();
    expect(job?.id).toBe(deduplicationKey);
    expect(job?.data).toEqual({
      videoId: video.id,
      originalKey: video.original_key,
      processingVersion: 1,
    });
  });

  it('handles multiple concurrent relay processBatch calls without duplicate dispatch', async () => {
    const video = await createVideo();
    const deduplicationKey = `video.upload.completed:${video.id}:1`;

    await outboxRepo.save(
      outboxRepo.create({
        aggregate_id: video.id,
        aggregate_version: 1,
        event_type: 'video.upload.completed',
        deduplication_key: deduplicationKey,
        payload: {
          videoId: video.id,
          originalKey: video.original_key,
          processingVersion: 1,
        },
        dispatch_attempts: 0,
      }),
    );

    // Run 3 concurrent processBatch calls
    const results = await Promise.all([
      relayService.processBatch(),
      relayService.processBatch(),
      relayService.processBatch(),
    ]);

    const totalDispatched = results.reduce((sum, count) => sum + count, 0);
    expect(totalDispatched).toBe(1);

    const job = await queue.getJob(deduplicationKey);
    expect(job).not.toBeNull();
  });
});
