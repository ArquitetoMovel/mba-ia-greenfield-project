import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ChannelsService } from '../channels/channels.service';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import {
  InvalidUploadPartsException,
  UploadFileTooLargeException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  UnsupportedMediaTypeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  UploadSession,
  UploadSessionState,
} from './entities/upload-session.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { CreateUploadDto } from './dto/create-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  CompleteUploadResponseDto,
  PartUrlsResponseDto,
  UploadSessionDetailDto,
  UploadSessionResponseDto,
  VideoUploadStatusResponseDto,
} from './dto/upload-responses.dto';

const MAX_UPLOAD_SIZE = 10737418240; // 10 GB
const DEFAULT_PART_SIZE = 16777216; // 16 MiB
const SESSION_TTL_DAYS = 7;

@Injectable()
export class UploadSessionsService {
  private readonly logger = new Logger(UploadSessionsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storageService: S3MediaStorageService,
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
    @InjectRepository(UploadSession)
    private readonly sessionRepo: Repository<UploadSession>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
  ) {}

  generatePublicId(): string {
    return crypto.randomBytes(16).toString('base64url');
  }

  async initiateUpload(
    userId: string,
    dto: CreateUploadDto,
  ): Promise<UploadSessionResponseDto> {
    if (dto.size_bytes > MAX_UPLOAD_SIZE) {
      throw new UploadFileTooLargeException();
    }

    if (!dto.content_type || !dto.content_type.startsWith('video/')) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }

    let publicId = this.generatePublicId();
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.videoRepo.findOneBy({ public_id: publicId });
      if (!existing) {
        break;
      }
      publicId = this.generatePublicId();
    }

    const originalKey = this.storageService.getOriginalKey(
      publicId,
      dto.filename,
    );

    const s3Session = await this.storageService.createMultipartUpload(
      originalKey,
      dto.content_type,
    );

    const expiresAt = new Date(
      Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      return await this.dataSource.transaction(async (manager) => {
        const video = manager.create(Video, {
          public_id: publicId,
          channel_id: channel.id,
          original_key: originalKey,
          original_filename: dto.filename,
          declared_content_type: dto.content_type,
          declared_size_bytes: String(dto.size_bytes),
          processing_status: VideoProcessingStatus.UPLOADING,
          processing_version: 1,
        });
        const savedVideo = await manager.save(Video, video);

        const session = manager.create(UploadSession, {
          video_id: savedVideo.id,
          s3_upload_id: s3Session.uploadId,
          object_key: originalKey,
          file_fingerprint: dto.file_fingerprint,
          expected_size_bytes: String(dto.size_bytes),
          part_size_bytes: DEFAULT_PART_SIZE,
          declared_content_type: dto.content_type,
          state: UploadSessionState.ACTIVE,
          expires_at: expiresAt,
        });
        const savedSession = await manager.save(UploadSession, session);

        return {
          video_id: savedVideo.id,
          public_id: savedVideo.public_id,
          canonical_url: `/v/${savedVideo.public_id}`,
          upload_session_id: savedSession.id,
          state: savedSession.state,
          part_size_bytes: savedSession.part_size_bytes,
          expires_at: savedSession.expires_at.toISOString(),
        };
      });
    } catch (err) {
      this.logger.error(
        `Database save failed for upload session; aborting S3 multipart: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.storageService
        .abortMultipartUpload(originalKey, s3Session.uploadId)
        .catch(() => {});
      throw err;
    }
  }

  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<UploadSessionDetailDto> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      relations: ['video', 'video.channel'],
    });

    if (!session) {
      throw new UploadSessionNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || session.video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }

    const now = new Date();
    if (
      session.state === UploadSessionState.ACTIVE &&
      now > session.expires_at
    ) {
      session.state = UploadSessionState.EXPIRED;
      await this.sessionRepo.save(session);
    }

    let uploadedParts: { part_number: number; etag: string }[] = [];
    if (session.state === UploadSessionState.ACTIVE) {
      try {
        const s3Parts = await this.storageService.listParts(
          session.object_key,
          session.s3_upload_id,
        );
        uploadedParts = s3Parts.map((p) => ({
          part_number: p.partNumber,
          etag: p.eTag,
        }));
      } catch {
        uploadedParts = [];
      }
    }

    return {
      video_id: session.video_id,
      public_id: session.video.public_id,
      state: session.state,
      processing_status: session.video.processing_status,
      part_size_bytes: session.part_size_bytes,
      expected_size_bytes: Number(session.expected_size_bytes),
      expires_at: session.expires_at.toISOString(),
      uploaded_parts: uploadedParts,
    };
  }

  async getPartUrls(
    userId: string,
    sessionId: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      relations: ['video'],
    });

    if (!session) {
      throw new UploadSessionNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || session.video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }

    if (
      session.state !== UploadSessionState.ACTIVE ||
      new Date() > session.expires_at
    ) {
      throw new UploadSessionNotActiveException();
    }

    const signedParts = await this.storageService.getPresignedUploadPartUrls(
      session.object_key,
      session.s3_upload_id,
      partNumbers,
    );

    return {
      parts: signedParts.map((p) => ({
        part_number: p.partNumber,
        url: p.url,
        expires_at: p.expiresAt.toISOString(),
      })),
    };
  }

  async completeUpload(
    userId: string,
    sessionId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }

    // Validate parts are strictly ordered
    for (let i = 0; i < dto.parts.length - 1; i++) {
      if (dto.parts[i].part_number >= dto.parts[i + 1].part_number) {
        throw new InvalidUploadPartsException();
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(UploadSession, {
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!session) {
        throw new UploadSessionNotFoundException();
      }

      const video = await manager.findOne(Video, {
        where: { id: session.video_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!video) {
        throw new VideoNotFoundException();
      }

      if (video.channel_id !== channel.id) {
        throw new VideoAccessDeniedException();
      }

      if (
        session.state !== UploadSessionState.ACTIVE ||
        new Date() > session.expires_at
      ) {
        throw new UploadSessionNotActiveException();
      }

      try {
        await this.storageService.completeMultipartUpload(
          session.object_key,
          session.s3_upload_id,
          dto.parts.map((p) => ({
            partNumber: p.part_number,
            eTag: p.etag,
          })),
        );
      } catch (err) {
        this.logger.error(
          `S3 multipart completion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new InvalidUploadPartsException();
      }

      session.state = UploadSessionState.COMPLETED;
      session.completed_at = new Date();
      await manager.save(UploadSession, session);

      video.processing_status = VideoProcessingStatus.UPLOADED;
      await manager.save(Video, video);

      const outboxEvent = manager.create(OutboxEvent, {
        aggregate_id: video.id,
        aggregate_version: video.processing_version,
        event_type: 'video.upload.completed',
        deduplication_key: `video.upload.completed:${video.id}:${video.processing_version}`,
        payload: {
          videoId: video.id,
          originalKey: session.object_key,
          processingVersion: video.processing_version,
        },
        dispatch_attempts: 0,
      });
      await manager.save(OutboxEvent, outboxEvent);

      return {
        public_id: video.public_id,
        processing_status: video.processing_status,
        processing_version: video.processing_version,
      };
    });
  }

  async cancelUpload(userId: string, sessionId: string): Promise<void> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }

    await this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(UploadSession, {
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!session) {
        throw new UploadSessionNotFoundException();
      }

      const video = await manager.findOne(Video, {
        where: { id: session.video_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!video) {
        throw new VideoNotFoundException();
      }

      if (video.channel_id !== channel.id) {
        throw new VideoAccessDeniedException();
      }

      if (session.state !== UploadSessionState.ACTIVE) {
        throw new UploadSessionNotActiveException();
      }

      try {
        await this.storageService.abortMultipartUpload(
          session.object_key,
          session.s3_upload_id,
        );
      } catch (err) {
        this.logger.warn(
          `Storage abort encountered non-fatal error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      session.state = UploadSessionState.CANCELLED;
      session.cancelled_at = new Date();
      await manager.save(UploadSession, session);

      video.processing_status = VideoProcessingStatus.CANCELLED;
      await manager.save(Video, video);
    });
  }

  async getUploadStatus(
    userId: string,
    publicId: string,
  ): Promise<VideoUploadStatusResponseDto> {
    const video = await this.videoRepo.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }

    return {
      public_id: video.public_id,
      canonical_url: `/v/${video.public_id}`,
      processing_status: video.processing_status,
      duration_seconds: video.duration_seconds
        ? Number(video.duration_seconds)
        : null,
      processing_error: video.processing_error,
      thumbnail_available: Boolean(
        video.thumbnail_key &&
        video.processing_status === VideoProcessingStatus.READY,
      ),
      playback_available: Boolean(
        video.hls_master_key &&
        video.processing_status === VideoProcessingStatus.READY,
      ),
    };
  }
}
