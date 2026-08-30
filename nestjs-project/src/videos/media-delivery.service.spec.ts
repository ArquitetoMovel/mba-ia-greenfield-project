import { Repository } from 'typeorm';
import { Readable } from 'stream';
import { MediaDeliveryService } from './media-delivery.service';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

describe('MediaDeliveryService (unit)', () => {
  let service: MediaDeliveryService;
  let videoRepo: Repository<Video>;
  let storageService: S3MediaStorageService;

  let findOneSpy: jest.Mock;
  let getObjectSpy: jest.Mock;
  let getPresignedPlaybackUrlSpy: jest.Mock;
  let getPresignedDownloadUrlSpy: jest.Mock;

  beforeEach(() => {
    findOneSpy = jest.fn();
    videoRepo = {
      findOne: findOneSpy,
    } as unknown as Repository<Video>;

    getObjectSpy = jest.fn();
    getPresignedPlaybackUrlSpy = jest.fn();
    getPresignedDownloadUrlSpy = jest.fn();

    storageService = {
      getObject: getObjectSpy,
      getPresignedPlaybackUrl: getPresignedPlaybackUrlSpy,
      getPresignedDownloadUrl: getPresignedDownloadUrlSpy,
      getHlsVariantKey: jest
        .fn()
        .mockReturnValue('videos/pub1/hls/v1/360p/playlist.m3u8'),
    } as unknown as S3MediaStorageService;

    service = new MediaDeliveryService(videoRepo, storageService);
  });

  function makeVideo(status = VideoProcessingStatus.READY, ownerId = 'user-1') {
    const channel = new Channel();
    channel.id = 'chan-1';
    channel.user_id = ownerId;

    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = status;
    video.processing_version = 1;
    video.original_key = 'videos/pub-1/original/source.mp4';
    video.original_filename = 'source.mp4';
    video.hls_master_key = 'videos/pub-1/hls/v1/master.m3u8';
    video.thumbnail_key = 'videos/pub-1/thumbnails/v1/thumbnail.jpg';
    video.channel = channel;
    return video;
  }

  describe('authorization and readiness validation', () => {
    it('throws VideoNotFoundException when video does not exist', async () => {
      findOneSpy.mockResolvedValue(null);

      await expect(
        service.getMasterManifest('user-1', 'non-existent'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException when requesting user is not channel owner', async () => {
      const video = makeVideo(VideoProcessingStatus.READY, 'owner-user');
      findOneSpy.mockResolvedValue(video);

      await expect(
        service.getMasterManifest('intruder-user', 'pub-1'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoNotReadyException when video is not in READY status', async () => {
      const video = makeVideo(VideoProcessingStatus.PROCESSING, 'user-1');
      findOneSpy.mockResolvedValue(video);

      await expect(
        service.getMasterManifest('user-1', 'pub-1'),
      ).rejects.toThrow(VideoNotReadyException);
    });
  });

  describe('getMasterManifest', () => {
    it('returns raw master playlist string from storage', async () => {
      const video = makeVideo();
      findOneSpy.mockResolvedValue(video);

      const manifestContent =
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=896000\n360p/playlist.m3u8\n';
      getObjectSpy.mockResolvedValue({
        body: Readable.from([Buffer.from(manifestContent)]),
      });

      const result = await service.getMasterManifest('user-1', 'pub-1');
      expect(result).toBe(manifestContent);
      expect(getObjectSpy).toHaveBeenCalledWith(video.hls_master_key);
    });
  });

  describe('getRenditionManifest', () => {
    it('rewrites media segment filenames with presigned playback URLs', async () => {
      const video = makeVideo();
      findOneSpy.mockResolvedValue(video);

      const variantPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.000,',
        'segment_000.ts',
        '#EXTINF:4.000,',
        'segment_001.ts',
        '#EXT-X-ENDLIST',
      ].join('\n');

      getObjectSpy.mockResolvedValue({
        body: Readable.from([Buffer.from(variantPlaylist)]),
      });

      getPresignedPlaybackUrlSpy.mockImplementation((key: string) =>
        Promise.resolve({
          url: `https://storage.local/${key}?signed=true`,
          expiresAt: new Date(),
        }),
      );

      const result = await service.getRenditionManifest(
        'user-1',
        'pub-1',
        '360p',
      );

      expect(result).toContain(
        'https://storage.local/videos/pub-1/hls/v1/360p/segment_000.ts?signed=true',
      );
      expect(result).toContain(
        'https://storage.local/videos/pub-1/hls/v1/360p/segment_001.ts?signed=true',
      );
      expect(result).toContain('#EXT-X-ENDLIST');
    });
  });

  describe('getThumbnailRedirectUrl', () => {
    it('returns presigned URL for the video thumbnail', async () => {
      const video = makeVideo();
      findOneSpy.mockResolvedValue(video);

      getPresignedPlaybackUrlSpy.mockResolvedValue({
        url: 'https://storage.local/thumbnail.jpg?signed=true',
        expiresAt: new Date(),
      });

      const result = await service.getThumbnailRedirectUrl('user-1', 'pub-1');
      expect(result).toBe('https://storage.local/thumbnail.jpg?signed=true');
      expect(getPresignedPlaybackUrlSpy).toHaveBeenCalledWith(
        video.thumbnail_key,
      );
    });
  });

  describe('getDownloadRedirectUrl', () => {
    it('returns presigned download URL for the original video with attachment disposition', async () => {
      const video = makeVideo();
      findOneSpy.mockResolvedValue(video);

      getPresignedDownloadUrlSpy.mockResolvedValue({
        url: 'https://storage.local/source.mp4?download=true',
        expiresAt: new Date(),
      });

      const result = await service.getDownloadRedirectUrl('user-1', 'pub-1');
      expect(result).toBe('https://storage.local/source.mp4?download=true');
      expect(getPresignedDownloadUrlSpy).toHaveBeenCalledWith(
        video.original_key,
        undefined,
        video.original_filename,
      );
    });
  });
});
