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
import { UploadSession, UploadSessionState } from './upload-session.entity';
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

describe('UploadSession entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let sessionRepository: Repository<UploadSession>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    sessionRepository = dataSource.getRepository(UploadSession);
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
        email: `session_user_${++counter}@example.com`,
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
        public_id: `pub_vid_${counter.toString().padStart(14, '0')}`,
        channel_id: channel.id,
        original_key: `originals/chan_${counter}/vid_${counter}.mp4`,
        original_filename: `vid_${counter}.mp4`,
        declared_content_type: 'video/mp4',
        declared_size_bytes: '52428800',
        processing_status: VideoProcessingStatus.UPLOADING,
      }),
    );
  }

  it('should persist an active upload session with defaults and relations', async () => {
    const video = await createVideo();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const session = await sessionRepository.save(
      sessionRepository.create({
        video_id: video.id,
        s3_upload_id: 's3_upload_id_12345',
        object_key: video.original_key,
        file_fingerprint: 'fp_abc123_size52428800',
        expected_size_bytes: '52428800',
        part_size_bytes: 16777216,
        declared_content_type: 'video/mp4',
        expires_at: expiresAt,
      }),
    );

    expect(session.id).toBeDefined();
    expect(session.state).toBe(UploadSessionState.ACTIVE);
    expect(session.part_size_bytes).toBe(16777216);
    expect(session.completed_at).toBeNull();
    expect(session.cancelled_at).toBeNull();

    const loaded = await sessionRepository.findOne({
      where: { id: session.id },
      relations: ['video'],
    });
    expect(loaded?.video.id).toBe(video.id);
  });

  it('should enforce one-to-one relation: one upload session per video', async () => {
    const video = await createVideo();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sessionRepository.save(
      sessionRepository.create({
        video_id: video.id,
        s3_upload_id: 's3_upload_1',
        object_key: video.original_key,
        file_fingerprint: 'fp_1',
        expected_size_bytes: '10485760',
        declared_content_type: 'video/mp4',
        expires_at: expiresAt,
      }),
    );

    await expect(
      sessionRepository.save(
        sessionRepository.create({
          video_id: video.id,
          s3_upload_id: 's3_upload_2',
          object_key: 'originals/other.mp4',
          file_fingerprint: 'fp_2',
          expected_size_bytes: '10485760',
          declared_content_type: 'video/mp4',
          expires_at: expiresAt,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce unique s3_upload_id constraint', async () => {
    const video1 = await createVideo();
    const video2 = await createVideo();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sessionRepository.save(
      sessionRepository.create({
        video_id: video1.id,
        s3_upload_id: 'duplicate_s3_upload_id',
        object_key: video1.original_key,
        file_fingerprint: 'fp_1',
        expected_size_bytes: '10485760',
        declared_content_type: 'video/mp4',
        expires_at: expiresAt,
      }),
    );

    await expect(
      sessionRepository.save(
        sessionRepository.create({
          video_id: video2.id,
          s3_upload_id: 'duplicate_s3_upload_id',
          object_key: video2.original_key,
          file_fingerprint: 'fp_2',
          expected_size_bytes: '10485760',
          declared_content_type: 'video/mp4',
          expires_at: expiresAt,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should update terminal state to completed with completed_at timestamp', async () => {
    const video = await createVideo();
    const session = await sessionRepository.save(
      sessionRepository.create({
        video_id: video.id,
        s3_upload_id: 'term_s3_upload_id',
        object_key: video.original_key,
        file_fingerprint: 'fp_term',
        expected_size_bytes: '10485760',
        declared_content_type: 'video/mp4',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    const completedTime = new Date();
    session.state = UploadSessionState.COMPLETED;
    session.completed_at = completedTime;
    await sessionRepository.save(session);

    const found = await sessionRepository.findOneBy({ id: session.id });
    expect(found?.state).toBe(UploadSessionState.COMPLETED);
    expect(found?.completed_at).toBeDefined();
  });
});
