import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoUploadCompletedPayload,
} from '../outbox/outbox.types';
import { FFmpegService } from './ffmpeg.service';

@Injectable()
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessorService extends WorkerHost {
  private readonly logger = new Logger(VideoProcessorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storageService: S3MediaStorageService,
    private readonly ffmpegService: FFmpegService,
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
  ) {
    super();
  }

  async process(
    job: Job<VideoUploadCompletedPayload, void, string>,
  ): Promise<void> {
    const { videoId, originalKey, processingVersion } = job.data;
    this.logger.log(
      `Starting video processing for job ${job.id} (videoId: ${videoId}, version: ${processingVersion})`,
    );

    let video = await this.videoRepo.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(
        `Video ${videoId} not found for job ${job.id}; skipping`,
      );
      return;
    }

    // Idempotency check
    if (
      video.processing_status === VideoProcessingStatus.READY &&
      video.processing_version >= processingVersion
    ) {
      this.logger.log(
        `Video ${videoId} is already in READY status for version ${processingVersion}; skipping duplicate processing`,
      );
      return;
    }

    if (video.processing_version > processingVersion) {
      this.logger.log(
        `Video ${videoId} has newer processing version ${video.processing_version} > ${processingVersion}; skipping stale job`,
      );
      return;
    }

    if (video.processing_status === VideoProcessingStatus.CANCELLED) {
      this.logger.log(`Video ${videoId} was cancelled; skipping processing`);
      return;
    }

    // Transition state to PROCESSING
    await this.dataSource.transaction(async (manager) => {
      const lockedVideo = await manager.findOne(Video, {
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedVideo) {
        lockedVideo.processing_status = VideoProcessingStatus.PROCESSING;
        video = await manager.save(Video, lockedVideo);
      }
    });

    const jobTmpDir = path.join(
      os.tmpdir(),
      'streamtube-jobs',
      job.id || String(Date.now()),
    );
    await fs.mkdir(jobTmpDir, { recursive: true });

    try {
      // 1. Download original video from S3/MinIO
      const sourcePath = path.join(jobTmpDir, 'source.mp4');
      const getObjResult = await this.storageService.getObject(originalKey);
      const fileStream = createWriteStream(sourcePath);
      await pipeline(getObjResult.body, fileStream);

      // 2. Probe video metadata with ffprobe
      const probeResult = await this.ffmpegService.probe(sourcePath);
      this.logger.debug(
        `Probed metadata for video ${videoId}: duration=${probeResult.duration}s, resolution=${probeResult.width}x${probeResult.height}`,
      );

      // 3. Determine renditions & transcode HLS
      const renditions = this.ffmpegService.determineRenditions(
        probeResult.height,
      );

      for (const rendition of renditions) {
        const renditionDir = path.join(jobTmpDir, 'hls', rendition.name);
        await this.ffmpegService.transcodeHlsRendition(
          sourcePath,
          renditionDir,
          rendition,
        );

        // Upload rendition playlist & segments to S3
        const files = await fs.readdir(renditionDir);
        for (const file of files) {
          const filePath = path.join(renditionDir, file);
          const fileContent = await fs.readFile(filePath);
          const s3Key = `videos/${video.public_id}/hls/v${processingVersion}/${rendition.name}/${file}`;
          const contentType = file.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/MP2T';

          await this.storageService.putObject(s3Key, fileContent, contentType);
        }
      }

      // 4. Build and upload master playlist
      const masterPlaylistContent =
        this.ffmpegService.buildMasterPlaylist(renditions);
      const masterKey = this.storageService.getHlsMasterKey(
        video.public_id,
        processingVersion,
      );
      await this.storageService.putObject(
        masterKey,
        masterPlaylistContent,
        'application/vnd.apple.mpegurl',
      );

      // 5. Generate and upload thumbnail
      const thumbnailPath = path.join(jobTmpDir, 'thumbnails', 'thumbnail.jpg');
      await this.ffmpegService.generateThumbnail(
        sourcePath,
        thumbnailPath,
        probeResult.duration,
      );
      const thumbnailContent = await fs.readFile(thumbnailPath);
      const thumbnailKey = this.storageService.getThumbnailKey(
        video.public_id,
        processingVersion,
      );
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailContent,
        'image/jpeg',
      );

      // 6. Atomically persist READY state & metadata in database
      await this.dataSource.transaction(async (manager) => {
        const lockedVideo = await manager.findOne(Video, {
          where: { id: videoId },
          lock: { mode: 'pessimistic_write' },
        });

        if (lockedVideo) {
          lockedVideo.processing_status = VideoProcessingStatus.READY;
          lockedVideo.duration_seconds = probeResult.duration;
          lockedVideo.media_metadata = probeResult.raw;
          lockedVideo.hls_master_key = masterKey;
          lockedVideo.thumbnail_key = thumbnailKey;
          lockedVideo.processing_error = null;
          lockedVideo.processed_at = new Date();
          await manager.save(Video, lockedVideo);
        }
      });

      this.logger.log(
        `Successfully processed video ${videoId} (publicId: ${video.public_id})`,
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Video processing failed for ${videoId}: ${errorMsg}`);

      // Cleanup partial derivative objects in S3
      await this.storageService
        .deletePrefix(
          this.storageService.getHlsPrefix(video.public_id, processingVersion),
        )
        .catch(() => {});
      await this.storageService
        .deleteObject(
          this.storageService.getThumbnailKey(
            video.public_id,
            processingVersion,
          ),
        )
        .catch(() => {});

      const maxAttempts = job.opts?.attempts ?? 3;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (isFinalAttempt) {
        await this.dataSource.transaction(async (manager) => {
          const lockedVideo = await manager.findOne(Video, {
            where: { id: videoId },
            lock: { mode: 'pessimistic_write' },
          });

          if (lockedVideo) {
            lockedVideo.processing_status = VideoProcessingStatus.FAILED;
            lockedVideo.processing_error =
              'Video processing failed. Please try re-uploading.';
            await manager.save(Video, lockedVideo);
          }
        });
      }

      throw err;
    } finally {
      await fs.rm(jobTmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
