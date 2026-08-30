import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionState } from '../entities/upload-session.entity';
import { VideoProcessingStatus } from '../entities/video.entity';

export class UploadSessionResponseDto {
  @ApiProperty({ example: 'a0000000-0000-0000-0000-000000000001' })
  video_id: string;

  @ApiProperty({ example: 'abc123xyz456_demo78901' })
  public_id: string;

  @ApiProperty({ example: '/v/abc123xyz456_demo78901' })
  canonical_url: string;

  @ApiProperty({ example: 'b0000000-0000-0000-0000-000000000002' })
  upload_session_id: string;

  @ApiProperty({ enum: UploadSessionState, example: UploadSessionState.ACTIVE })
  state: UploadSessionState;

  @ApiProperty({ example: 16777216 })
  part_size_bytes: number;

  @ApiProperty({ example: '2026-09-05T20:00:00.000Z' })
  expires_at: string;
}

export class UploadedPartItemDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'd41d8cd98f00b204e9800998ecf8427e' })
  etag: string;
}

export class UploadSessionDetailDto {
  @ApiProperty({ example: 'a0000000-0000-0000-0000-000000000001' })
  video_id: string;

  @ApiProperty({ example: 'abc123xyz456_demo78901' })
  public_id: string;

  @ApiProperty({ enum: UploadSessionState, example: UploadSessionState.ACTIVE })
  state: UploadSessionState;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ example: 16777216 })
  part_size_bytes: number;

  @ApiProperty({ example: 52428800 })
  expected_size_bytes: number;

  @ApiProperty({ example: '2026-09-05T20:00:00.000Z' })
  expires_at: string;

  @ApiProperty({ type: [UploadedPartItemDto] })
  uploaded_parts: UploadedPartItemDto[];
}

export class PartUrlItemDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'http://localhost:9000/streamtube-media/videos/...' })
  url: string;

  @ApiProperty({ example: '2026-08-29T20:15:00.000Z' })
  expires_at: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlItemDto] })
  parts: PartUrlItemDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'abc123xyz456_demo78901' })
  public_id: string;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.UPLOADED,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ example: 1 })
  processing_version: number;
}

export class VideoUploadStatusResponseDto {
  @ApiProperty({ example: 'abc123xyz456_demo78901' })
  public_id: string;

  @ApiProperty({ example: '/v/abc123xyz456_demo78901' })
  canonical_url: string;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.READY,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ type: Number, example: 124.55, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: String, example: null, nullable: true })
  processing_error: string | null;

  @ApiProperty({ example: true })
  thumbnail_available: boolean;

  @ApiProperty({ example: true })
  playback_available: boolean;
}
