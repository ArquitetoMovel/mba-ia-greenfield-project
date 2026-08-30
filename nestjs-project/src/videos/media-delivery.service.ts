import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Readable } from 'stream';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { S3MediaStorageService } from '../storage/s3-media-storage.service';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString('utf-8');
}

@Injectable()
export class MediaDeliveryService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepo: Repository<Video>,
    private readonly storageService: S3MediaStorageService,
  ) {}

  private async getAuthorizedReadyVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepo.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }

    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  async getMasterManifest(userId: string, publicId: string): Promise<string> {
    const video = await this.getAuthorizedReadyVideo(userId, publicId);

    if (!video.hls_master_key) {
      throw new VideoNotReadyException();
    }

    const obj = await this.storageService.getObject(video.hls_master_key);
    return streamToString(obj.body);
  }

  async getRenditionManifest(
    userId: string,
    publicId: string,
    rendition: string,
  ): Promise<string> {
    const video = await this.getAuthorizedReadyVideo(userId, publicId);

    const cleanRendition = rendition.replace(/\/playlist\.m3u8$/, '');
    const variantKey = this.storageService.getHlsVariantKey(
      video.public_id,
      cleanRendition,
      video.processing_version,
    );

    let obj: { body: Readable };
    try {
      obj = await this.storageService.getObject(variantKey);
    } catch {
      throw new VideoNotFoundException();
    }

    const playlistText = await streamToString(obj.body);
    const lines = playlistText.split('\n');
    const rewrittenLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        const segmentKey = `videos/${video.public_id}/hls/v${video.processing_version}/${cleanRendition}/${trimmed}`;
        const presigned =
          await this.storageService.getPresignedPlaybackUrl(segmentKey);
        rewrittenLines.push(presigned.url);
      } else {
        rewrittenLines.push(line);
      }
    }

    return rewrittenLines.join('\n');
  }

  async getThumbnailRedirectUrl(
    userId: string,
    publicId: string,
  ): Promise<string> {
    const video = await this.getAuthorizedReadyVideo(userId, publicId);

    if (!video.thumbnail_key) {
      throw new VideoNotReadyException();
    }

    const presigned = await this.storageService.getPresignedPlaybackUrl(
      video.thumbnail_key,
    );
    return presigned.url;
  }

  async getDownloadRedirectUrl(
    userId: string,
    publicId: string,
  ): Promise<string> {
    const video = await this.getAuthorizedReadyVideo(userId, publicId);

    const presigned = await this.storageService.getPresignedDownloadUrl(
      video.original_key,
      undefined,
      video.original_filename,
    );
    return presigned.url;
  }
}
