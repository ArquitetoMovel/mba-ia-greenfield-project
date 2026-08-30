import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoProcessingStatus } from './video.entity';
import { UploadSession } from './upload-session.entity';
import { OutboxEvent } from './outbox-event.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('OutboxEvent entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let outboxRepository: Repository<OutboxEvent>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    outboxRepository = dataSource.getRepository(OutboxEvent);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `outbox_user_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        public_id: `pub_out_${counter.toString().padStart(14, '0')}`,
        channel_id: channel.id,
        original_key: `originals/chan_${counter}/vid_${counter}.mp4`,
        original_filename: `vid_${counter}.mp4`,
        declared_content_type: 'video/mp4',
        declared_size_bytes: '52428800',
        processing_status: VideoProcessingStatus.UPLOADED,
      }),
    );
  }

  it('should persist outbox event with payload and audit defaults', async () => {
    const video = await createVideo();
    const event = await outboxRepository.save(
      outboxRepository.create({
        aggregate_id: video.id,
        aggregate_version: 1,
        event_type: 'video.upload.completed',
        deduplication_key: `video.upload.completed:${video.id}:1`,
        payload: {
          videoId: video.id,
          originalKey: video.original_key,
          processingVersion: 1,
        },
      }),
    );

    expect(event.id).toBeDefined();
    expect(event.dispatch_attempts).toBe(0);
    expect(event.dispatched_at).toBeNull();
    expect(event.last_error).toBeNull();
    expect(event.created_at).toBeInstanceOf(Date);
    expect(event.payload).toEqual({
      videoId: video.id,
      originalKey: video.original_key,
      processingVersion: 1,
    });
  });

  it('should enforce unique deduplication_key constraint', async () => {
    const video = await createVideo();
    const dedupKey = `video.upload.completed:${video.id}:1`;

    await outboxRepository.save(
      outboxRepository.create({
        aggregate_id: video.id,
        aggregate_version: 1,
        event_type: 'video.upload.completed',
        deduplication_key: dedupKey,
        payload: { videoId: video.id },
      }),
    );

    await expect(
      outboxRepository.save(
        outboxRepository.create({
          aggregate_id: video.id,
          aggregate_version: 1,
          event_type: 'video.upload.completed',
          deduplication_key: dedupKey,
          payload: { videoId: video.id },
        }),
      ),
    ).rejects.toThrow();
  });

  it('should record dispatch audit fields on successful dispatch', async () => {
    const video = await createVideo();
    const event = await outboxRepository.save(
      outboxRepository.create({
        aggregate_id: video.id,
        aggregate_version: 1,
        event_type: 'video.upload.completed',
        deduplication_key: `video.upload.completed:${video.id}:1`,
        payload: { videoId: video.id },
      }),
    );

    const now = new Date();
    event.dispatch_attempts = 1;
    event.dispatched_at = now;
    await outboxRepository.save(event);

    const found = await outboxRepository.findOneBy({ id: event.id });
    expect(found?.dispatch_attempts).toBe(1);
    expect(found?.dispatched_at).toBeDefined();
  });
});
