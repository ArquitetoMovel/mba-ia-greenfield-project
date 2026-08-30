import { DataSource, EntityManager, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import {
  InvalidUploadPartsException,
  UploadFileTooLargeException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  UnsupportedMediaTypeException,
  VideoAccessDeniedException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import {
  UploadSession,
  UploadSessionState,
} from './entities/upload-session.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { UploadSessionsService } from './upload-sessions.service';

describe('UploadSessionsService (unit)', () => {
  let service: UploadSessionsService;
  let channelsService: jest.Mocked<Partial<ChannelsService>>;
  let storageService: jest.Mocked<Partial<S3MediaStorageService>>;
  let videoRepo: jest.Mocked<Partial<Repository<Video>>>;
  let sessionRepo: jest.Mocked<Partial<Repository<UploadSession>>>;
  let outboxRepo: jest.Mocked<Partial<Repository<OutboxEvent>>>;
  let dataSource: jest.Mocked<Partial<DataSource>>;

  beforeEach(() => {
    channelsService = {
      findByUserId: jest.fn(),
      createChannel: jest.fn(),
    };

    storageService = {
      getOriginalKey: jest
        .fn()
        .mockReturnValue('videos/pub1/original/source.mp4'),
      createMultipartUpload: jest.fn().mockResolvedValue({
        uploadId: 's3_up_1',
        key: 'videos/pub1/original/source.mp4',
      }),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest
        .fn()
        .mockResolvedValue({ key: 'k', eTag: 'etag' }),
      getPresignedUploadPartUrls: jest
        .fn()
        .mockResolvedValue([
          { partNumber: 1, url: 'http://signed', expiresAt: new Date() },
        ]),
      listParts: jest.fn().mockResolvedValue([]),
    };

    videoRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    sessionRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    outboxRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (cb: (manager: EntityManager) => Promise<unknown>) => {
            const mockManager = {
              create: jest.fn((_, data: object) => ({
                ...data,
                id: 'mock-id',
              })),
              save: jest.fn((_, data: object) =>
                Promise.resolve({ ...data, id: 'mock-id' }),
              ),
              findOne: jest.fn(),
            } as unknown as EntityManager;
            const result: unknown = await cb(mockManager);
            return result;
          },
        ),
    };

    service = new UploadSessionsService(
      dataSource as DataSource,
      channelsService as ChannelsService,
      storageService as S3MediaStorageService,
      videoRepo as Repository<Video>,
      sessionRepo as Repository<UploadSession>,
      outboxRepo as Repository<OutboxEvent>,
    );
  });

  describe('initiateUpload', () => {
    it('throws UploadFileTooLargeException when size exceeds 10 GB', async () => {
      await expect(
        service.initiateUpload('user-1', {
          filename: 'video.mp4',
          content_type: 'video/mp4',
          size_bytes: 10737418241, // 10 GB + 1 byte
          file_fingerprint: 'fp_1',
        }),
      ).rejects.toThrow(UploadFileTooLargeException);
    });

    it('throws UnsupportedMediaTypeException when content_type does not start with video/', async () => {
      await expect(
        service.initiateUpload('user-1', {
          filename: 'image.png',
          content_type: 'image/png',
          size_bytes: 1048576,
          file_fingerprint: 'fp_1',
        }),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it('throws VideoAccessDeniedException when user channel does not exist', async () => {
      (channelsService.findByUserId as jest.Mock).mockResolvedValue(null);

      await expect(
        service.initiateUpload('user-1', {
          filename: 'video.mp4',
          content_type: 'video/mp4',
          size_bytes: 1048576,
          file_fingerprint: 'fp_1',
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('retries publicId generation on collision and creates session', async () => {
      const mockChannel = {
        id: 'channel-1',
        user_id: 'user-1',
      } as Channel;
      (channelsService.findByUserId as jest.Mock).mockResolvedValue(
        mockChannel,
      );

      (videoRepo.findOneBy as jest.Mock)
        .mockResolvedValueOnce({ id: 'existing-video' } as Video)
        .mockResolvedValueOnce(null);

      const result = await service.initiateUpload('user-1', {
        filename: 'video.mp4',
        content_type: 'video/mp4',
        size_bytes: 52428800,
        file_fingerprint: 'fp_1',
      });

      expect(result.upload_session_id).toBeDefined();
      expect(result.state).toBe(UploadSessionState.ACTIVE);
      expect(result.part_size_bytes).toBe(16777216);
      expect(videoRepo.findOneBy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPartUrls', () => {
    it('throws UploadSessionNotFoundException when session not found', async () => {
      (sessionRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getPartUrls('user-1', 'session-1', [1, 2]),
      ).rejects.toThrow(UploadSessionNotFoundException);
    });

    it('throws VideoAccessDeniedException when session belongs to another channel', async () => {
      (sessionRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'session-1',
        video: { channel_id: 'other-channel' },
      } as UploadSession);
      (channelsService.findByUserId as jest.Mock).mockResolvedValue({
        id: 'my-channel',
      } as Channel);

      await expect(
        service.getPartUrls('user-1', 'session-1', [1, 2]),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws UploadSessionNotActiveException when session is completed or expired', async () => {
      (sessionRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'session-1',
        state: UploadSessionState.COMPLETED,
        video: { channel_id: 'my-channel' },
        expires_at: new Date(Date.now() + 10000),
      } as UploadSession);
      (channelsService.findByUserId as jest.Mock).mockResolvedValue({
        id: 'my-channel',
      } as Channel);

      await expect(
        service.getPartUrls('user-1', 'session-1', [1, 2]),
      ).rejects.toThrow(UploadSessionNotActiveException);
    });
  });

  describe('completeUpload', () => {
    it('throws InvalidUploadPartsException if parts are not strictly sorted', async () => {
      (channelsService.findByUserId as jest.Mock).mockResolvedValue({
        id: 'my-channel',
      } as Channel);

      await expect(
        service.completeUpload('user-1', 'session-1', {
          parts: [
            { part_number: 2, etag: 'etag2' },
            { part_number: 1, etag: 'etag1' },
          ],
        }),
      ).rejects.toThrow(InvalidUploadPartsException);
    });
  });
});
