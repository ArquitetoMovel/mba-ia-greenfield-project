import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'stream';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  CompletedPart,
  MultipartSession,
  PresignedUrlResult,
  StorageObjectMetadata,
  UploadPartUrl,
} from './storage.types';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as Record<string, unknown>;
  const name = typeof e.name === 'string' ? e.name : '';
  const metadata = e.$metadata as Record<string, unknown> | undefined;
  const httpStatus = metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatus === 404;
}

@Injectable()
export class S3MediaStorageService {
  private readonly logger = new Logger(S3MediaStorageService.name);
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;

    const credentials = {
      accessKeyId: this.config.accessKey || 'minioadmin',
      secretAccessKey: this.config.secretKey || 'minioadmin',
    };

    this.internalClient = new S3Client({
      endpoint: this.config.internalEndpoint,
      region: this.config.region,
      credentials,
      forcePathStyle: true,
    });

    this.publicClient = new S3Client({
      endpoint: this.config.publicEndpoint,
      region: this.config.region,
      credentials,
      forcePathStyle: true,
    });
  }

  // Key generation helpers rooted at videos/{publicId}/
  getOriginalKey(publicId: string, filename = 'video.mp4'): string {
    const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
    return `videos/${publicId}/original/source.${ext}`;
  }

  getHlsMasterKey(publicId: string, version = 1): string {
    return `videos/${publicId}/hls/v${version}/master.m3u8`;
  }

  getHlsVariantKey(publicId: string, rendition: string, version = 1): string {
    return `videos/${publicId}/hls/v${version}/${rendition}/playlist.m3u8`;
  }

  getHlsPrefix(publicId: string, version = 1): string {
    return `videos/${publicId}/hls/v${version}/`;
  }

  getThumbnailKey(publicId: string, version = 1): string {
    return `videos/${publicId}/thumbnails/v${version}/thumbnail.jpg`;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<MultipartSession> {
    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      });

      const response = await this.internalClient.send(command);

      if (!response.UploadId) {
        throw new InternalServerErrorException(
          'Storage did not return an uploadId for multipart initiation',
        );
      }

      return {
        uploadId: response.UploadId,
        key,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Failed to create multipart upload for key ${key}: ${getErrorMessage(err)}`,
      );
      if (err instanceof BadRequestException) {
        throw err;
      }
      throw new InternalServerErrorException(
        'Failed to initiate multipart upload with storage backend',
      );
    }
  }

  async getPresignedUploadPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrl[]> {
    if (!partNumbers || partNumbers.length === 0) {
      throw new BadRequestException('At least one part number is required');
    }

    const ttlSeconds = this.config.presignedUrlTtlSeconds || 900;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const results: UploadPartUrl[] = [];

    for (const partNumber of partNumbers) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10000
      ) {
        throw new BadRequestException(
          `Invalid part number ${partNumber}. Must be an integer between 1 and 10000.`,
        );
      }

      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const url = await getSignedUrl(this.publicClient, command, {
        expiresIn: ttlSeconds,
      });

      results.push({
        partNumber,
        url,
        expiresAt,
      });
    }

    return results;
  }

  async listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; eTag: string; size: number }[]> {
    try {
      const command = new ListPartsCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      });

      const response = await this.internalClient.send(command);

      if (!response.Parts) {
        return [];
      }

      return response.Parts.map((p) => ({
        partNumber: p.PartNumber ?? 0,
        eTag: (p.ETag ?? '').replace(/"/g, ''),
        size: p.Size ?? 0,
      }));
    } catch (err: unknown) {
      this.logger.error(
        `Failed to list parts for key ${key} and uploadId ${uploadId}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to list parts from storage backend',
      );
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ key: string; eTag: string; location?: string }> {
    if (!parts || parts.length === 0) {
      throw new BadRequestException('At least one completed part is required');
    }

    // Sort parts by partNumber ascending
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    for (const part of sortedParts) {
      if (
        !Number.isInteger(part.partNumber) ||
        part.partNumber < 1 ||
        part.partNumber > 10000
      ) {
        throw new BadRequestException(
          `Invalid part number ${part.partNumber}. Must be between 1 and 10000.`,
        );
      }
      if (!part.eTag || typeof part.eTag !== 'string') {
        throw new BadRequestException(
          `Part ${part.partNumber} is missing a valid ETag`,
        );
      }
    }

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.eTag.startsWith('"') ? p.eTag : `"${p.eTag}"`,
          })),
        },
      });

      const response = await this.internalClient.send(command);

      // Verify final object existence with HeadObject
      const metadata = await this.headObject(key);
      if (!metadata) {
        throw new InternalServerErrorException(
          'Multipart upload completed with storage but object was not verified by HeadObject',
        );
      }

      return {
        key,
        eTag: (response.ETag ?? '').replace(/"/g, ''),
        location: response.Location,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Failed to complete multipart upload for key ${key}: ${getErrorMessage(err)}`,
      );
      if (
        err instanceof BadRequestException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      throw new InternalServerErrorException(
        'Failed to complete multipart upload with storage backend',
      );
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      });

      await this.internalClient.send(command);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to abort multipart upload for key ${key}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to abort multipart upload with storage backend',
      );
    }
  }

  async headObject(key: string): Promise<StorageObjectMetadata | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.internalClient.send(command);

      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType,
        eTag: (response.ETag ?? '').replace(/"/g, ''),
        lastModified: response.LastModified,
      };
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return null;
      }
      this.logger.error(
        `Failed to execute headObject for key ${key}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to inspect storage object',
      );
    }
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<{ eTag?: string }> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === 'string' ? Buffer.from(body) : body,
        ContentType: contentType,
      });

      const response = await this.internalClient.send(command);

      return {
        eTag: (response.ETag ?? '').replace(/"/g, ''),
      };
    } catch (err: unknown) {
      this.logger.error(
        `Failed to putObject for key ${key}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to write object to storage backend',
      );
    }
  }

  async getObject(
    key: string,
  ): Promise<{ body: Readable; contentLength?: number; contentType?: string }> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.internalClient.send(command);

      return {
        body: response.Body as Readable,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
      };
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new NotFoundException(`Object at key ${key} not found`);
      }
      this.logger.error(
        `Failed to getObject for key ${key}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to read object from storage backend',
      );
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.internalClient.send(command);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to deleteObject for key ${key}: ${getErrorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Failed to delete object from storage backend',
      );
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      let continuationToken: string | undefined = undefined;
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const listResponse: ListObjectsV2CommandOutput =
          await this.internalClient.send(listCommand);
        if (listResponse.Contents && listResponse.Contents.length > 0) {
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: listResponse.Contents.filter(
                (obj): obj is { Key: string } => typeof obj.Key === 'string',
              ).map((obj) => ({ Key: obj.Key })),
            },
          });
          await this.internalClient.send(deleteCommand);
        }
        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to delete prefix ${prefix}: ${getErrorMessage(err)}`,
      );
    }
  }

  async getPresignedDownloadUrl(
    key: string,
    ttlSeconds?: number,
    downloadFilename?: string,
  ): Promise<PresignedUrlResult> {
    const ttl = ttlSeconds ?? this.config.downloadUrlTtlSeconds ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: downloadFilename
        ? `attachment; filename="${downloadFilename}"`
        : undefined,
    });

    const url = await getSignedUrl(this.publicClient, command, {
      expiresIn: ttl,
    });

    return {
      url,
      expiresAt,
    };
  }

  async getPresignedPlaybackUrl(
    key: string,
    ttlSeconds?: number,
  ): Promise<PresignedUrlResult> {
    const ttl = ttlSeconds ?? this.config.hlsUrlTtlSeconds ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const url = await getSignedUrl(this.publicClient, command, {
      expiresIn: ttl,
    });

    return {
      url,
      expiresAt,
    };
  }
}
