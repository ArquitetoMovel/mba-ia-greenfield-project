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

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashedpassword',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist a valid video with defaults and correct fields', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'abc123xyz456_demo78901',
        channel_id: channel.id,
        original_key: 'originals/channel1/video1.mp4',
        original_filename: 'my_video.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '52428800',
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(video.processing_version).toBe(1);
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
    expect(video.duration_seconds).toBeNull();
    expect(video.media_metadata).toBeNull();
  });

  it('should enforce unique public_id constraint', async () => {
    const channel1 = await createChannel();
    const channel2 = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        public_id: 'duplicate_public_id_01',
        channel_id: channel1.id,
        original_key: 'originals/c1/v1.mp4',
        original_filename: 'v1.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '10485760',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'duplicate_public_id_01',
          channel_id: channel2.id,
          original_key: 'originals/c2/v2.mp4',
          original_filename: 'v2.mp4',
          declared_content_type: 'video/mp4',
          declared_size_bytes: '10485760',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce channel_id foreign key constraint', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'invalid_channel_id_01',
          channel_id: 'a0000000-0000-0000-0000-000000000000',
          original_key: 'originals/bad/v.mp4',
          original_filename: 'v.mp4',
          declared_content_type: 'video/mp4',
          declared_size_bytes: '10485760',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should persist media metadata and derivative keys on processing completion', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'processed_vid_00000001',
        channel_id: channel.id,
        original_key: 'originals/processed.mp4',
        original_filename: 'processed.mp4',
        declared_content_type: 'video/mp4',
        declared_size_bytes: '10485760',
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: 124.55,
        media_metadata: {
          width: 1920,
          height: 1080,
          codec: 'h264',
          fps: 30,
        },
        hls_master_key: 'hls/vid1/master.m3u8',
        thumbnail_key: 'thumbnails/vid1/thumb.jpg',
        processed_at: new Date(),
      }),
    );

    const found = await videoRepository.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });

    expect(found).toBeDefined();
    expect(found?.processing_status).toBe(VideoProcessingStatus.READY);
    expect(Number(found?.duration_seconds)).toBeCloseTo(124.55, 2);
    expect(found?.media_metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
      fps: 30,
    });
    expect(found?.hls_master_key).toBe('hls/vid1/master.m3u8');
    expect(found?.thumbnail_key).toBe('thumbnails/vid1/thumb.jpg');
    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
