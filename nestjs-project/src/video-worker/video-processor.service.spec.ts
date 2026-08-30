import { DataSource, EntityManager, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { VideoProcessorService } from './video-processor.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import { FFmpegService } from './ffmpeg.service';
import { VideoUploadCompletedPayload } from '../outbox/outbox.types';

describe('VideoProcessorService (unit)', () => {
  let service: VideoProcessorService;
  let dataSource: DataSource;
  let storageService: S3MediaStorageService;
  let ffmpegService: FFmpegService;
  let videoRepo: Repository<Video>;

  let getObjectSpy: jest.Mock;
  let deleteObjectSpy: jest.Mock;
  let deletePrefixSpy: jest.Mock;
  let findOneBySpy: jest.Mock;

  beforeEach(() => {
    dataSource = {
      transaction: jest.fn(
        async (cb: (m: EntityManager) => Promise<unknown>) => {
          const mockManager = {
            findOne: jest.fn(),
            save: jest.fn((_, entity) => Promise.resolve(entity)),
          } as unknown as EntityManager;
          return cb(mockManager);
        },
      ),
    } as unknown as DataSource;

    getObjectSpy = jest.fn();
    deleteObjectSpy = jest.fn().mockResolvedValue(undefined);
    deletePrefixSpy = jest.fn().mockResolvedValue(undefined);

    storageService = {
      getObject: getObjectSpy,
      putObject: jest.fn().mockResolvedValue({ eTag: 'etag' }),
      deleteObject: deleteObjectSpy,
      deletePrefix: deletePrefixSpy,
      getHlsMasterKey: jest
        .fn()
        .mockReturnValue('videos/pub1/hls/v1/master.m3u8'),
      getThumbnailKey: jest
        .fn()
        .mockReturnValue('videos/pub1/thumbnails/v1/thumbnail.jpg'),
      getHlsPrefix: jest.fn().mockReturnValue('videos/pub1/hls/v1/'),
    } as unknown as S3MediaStorageService;

    ffmpegService = {
      probe: jest.fn(),
      determineRenditions: jest.fn(),
      transcodeHlsRendition: jest.fn(),
      buildMasterPlaylist: jest.fn(),
      generateThumbnail: jest.fn(),
    } as unknown as FFmpegService;

    findOneBySpy = jest.fn();
    videoRepo = {
      findOneBy: findOneBySpy,
      save: jest.fn((entity) => Promise.resolve(entity)),
    } as unknown as Repository<Video>;

    service = new VideoProcessorService(
      dataSource,
      storageService,
      ffmpegService,
      videoRepo,
    );
  });

  function makeJob(
    data: VideoUploadCompletedPayload,
    attemptsMade = 0,
    maxAttempts = 3,
  ): Job<VideoUploadCompletedPayload, void, string> {
    return {
      id: 'job-1',
      data,
      attemptsMade,
      opts: { attempts: maxAttempts },
    } as unknown as Job<VideoUploadCompletedPayload, void, string>;
  }

  it('skips gracefully when video is not found', async () => {
    findOneBySpy.mockResolvedValue(null);

    const job = makeJob({
      videoId: 'non-existent',
      originalKey: 'videos/pub1/original/source.mp4',
      processingVersion: 1,
    });

    await expect(service.process(job)).resolves.toBeUndefined();
    expect(getObjectSpy).not.toHaveBeenCalled();
  });

  it('skips duplicate processing when video is already READY for the same version', async () => {
    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = VideoProcessingStatus.READY;
    video.processing_version = 1;
    findOneBySpy.mockResolvedValue(video);

    const job = makeJob({
      videoId: 'v-1',
      originalKey: 'videos/pub-1/original/source.mp4',
      processingVersion: 1,
    });

    await expect(service.process(job)).resolves.toBeUndefined();
    expect(getObjectSpy).not.toHaveBeenCalled();
  });

  it('skips stale job when video has higher version', async () => {
    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = VideoProcessingStatus.PROCESSING;
    video.processing_version = 2;
    findOneBySpy.mockResolvedValue(video);

    const job = makeJob({
      videoId: 'v-1',
      originalKey: 'videos/pub-1/original/source.mp4',
      processingVersion: 1,
    });

    await expect(service.process(job)).resolves.toBeUndefined();
    expect(getObjectSpy).not.toHaveBeenCalled();
  });

  it('skips processing when video is CANCELLED', async () => {
    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = VideoProcessingStatus.CANCELLED;
    video.processing_version = 1;
    findOneBySpy.mockResolvedValue(video);

    const job = makeJob({
      videoId: 'v-1',
      originalKey: 'videos/pub-1/original/source.mp4',
      processingVersion: 1,
    });

    await expect(service.process(job)).resolves.toBeUndefined();
    expect(getObjectSpy).not.toHaveBeenCalled();
  });

  it('cleans up partial S3 derivative files and rethrows on intermediate failure', async () => {
    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = VideoProcessingStatus.UPLOADED;
    video.processing_version = 1;
    findOneBySpy.mockResolvedValue(video);

    (dataSource.transaction as jest.Mock).mockImplementation(
      async (cb: (m: EntityManager) => Promise<unknown>) => {
        const mockManager = {
          findOne: jest.fn().mockResolvedValue({ ...video }),
          save: jest.fn().mockImplementation((_, e) => Promise.resolve(e)),
        } as unknown as EntityManager;
        return cb(mockManager);
      },
    );

    getObjectSpy.mockRejectedValue(new Error('S3 download failed'));

    const job = makeJob(
      {
        videoId: 'v-1',
        originalKey: 'videos/pub-1/original/source.mp4',
        processingVersion: 1,
      },
      0, // attemptsMade = 0
      3, // maxAttempts = 3
    );

    await expect(service.process(job)).rejects.toThrow('S3 download failed');
    expect(deletePrefixSpy).toHaveBeenCalledWith('videos/pub1/hls/v1/');
    expect(deleteObjectSpy).toHaveBeenCalledWith(
      'videos/pub1/thumbnails/v1/thumbnail.jpg',
    );
  });

  it('marks video as FAILED when max retry attempts are exhausted', async () => {
    const video = new Video();
    video.id = 'v-1';
    video.public_id = 'pub-1';
    video.processing_status = VideoProcessingStatus.UPLOADED;
    video.processing_version = 1;
    findOneBySpy.mockResolvedValue(video);

    let savedVideo: Video | null = null;
    (dataSource.transaction as jest.Mock).mockImplementation(
      async (cb: (m: EntityManager) => Promise<unknown>) => {
        const mockManager = {
          findOne: jest.fn().mockResolvedValue({ ...video }),
          save: jest.fn().mockImplementation((_, e) => {
            savedVideo = e as Video;
            return Promise.resolve(e);
          }),
        } as unknown as EntityManager;
        return cb(mockManager);
      },
    );

    getObjectSpy.mockRejectedValue(new Error('Corrupt video file'));

    const job = makeJob(
      {
        videoId: 'v-1',
        originalKey: 'videos/pub-1/original/source.mp4',
        processingVersion: 1,
      },
      2, // attemptsMade = 2 (this is 3rd and final attempt)
      3, // maxAttempts = 3
    );

    await expect(service.process(job)).rejects.toThrow('Corrupt video file');
    expect(savedVideo).not.toBeNull();
    expect((savedVideo as unknown as Video).processing_status).toBe(
      VideoProcessingStatus.FAILED,
    );
    expect((savedVideo as unknown as Video).processing_error).toContain(
      'Video processing failed',
    );
  });
});
