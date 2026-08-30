import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { UploadSessionsService } from './upload-sessions.service';
import { MediaDeliveryService } from './media-delivery.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { GetPartUrlsDto } from './dto/get-part-urls.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  CompleteUploadResponseDto,
  PartUrlsResponseDto,
  UploadSessionDetailDto,
  UploadSessionResponseDto,
  VideoUploadStatusResponseDto,
} from './dto/upload-responses.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploadSessionsService: UploadSessionsService,
    private readonly mediaDeliveryService: MediaDeliveryService,
  ) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate video upload',
    description:
      'Creates a video draft, initiates an S3 multipart upload session, and returns upload session metadata.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload session created successfully',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the 10 GB upload limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Only video media types are accepted',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<UploadSessionResponseDto> {
    return this.uploadSessionsService.initiateUpload(user.sub, dto);
  }

  @Get('uploads/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get upload session details',
    description:
      'Returns upload session status, metadata, and confirmed uploaded parts from storage for resumption.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload session details',
    type: UploadSessionDetailDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getSession(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<UploadSessionDetailDto> {
    return this.uploadSessionsService.getSession(user.sub, sessionId);
  }

  @Post('uploads/:sessionId/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Generate presigned part URLs',
    description:
      'Issues presigned S3 PUT URLs for the requested batch of part numbers.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() dto: GetPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.uploadSessionsService.getPartUrls(
      user.sub,
      sessionId,
      dto.part_numbers,
    );
  }

  @Post('uploads/:sessionId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete multipart upload',
    description:
      'Completes the S3 multipart upload, transitions the video to uploaded, and creates an outbox event.',
  })
  @ApiResponse({
    status: 202,
    description:
      'Multipart upload completed; video is now queued for processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Upload parts do not match the storage session',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.uploadSessionsService.completeUpload(user.sub, sessionId, dto);
  }

  @Delete('uploads/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cancel upload session',
    description:
      'Aborts the S3 multipart upload and marks the session and video as cancelled.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload session cancelled successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<void> {
    return this.uploadSessionsService.cancelUpload(user.sub, sessionId);
  }

  @Get(':publicId/upload-status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video upload status',
    description:
      'Returns video processing state, duration, error diagnostics, and playback/thumbnail readiness.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video upload and processing status',
    type: VideoUploadStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoUploadStatusResponseDto> {
    return this.uploadSessionsService.getUploadStatus(user.sub, publicId);
  }

  @Get(':publicId/playback/master')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get HLS master playlist',
    description:
      'Returns the HLS master playlist for the video with same-origin variant URLs.',
  })
  @ApiResponse({
    status: 200,
    description: 'HLS master manifest',
    content: {
      'application/vnd.apple.mpegurl': {
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getMasterManifest(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<string> {
    return this.mediaDeliveryService.getMasterManifest(user.sub, publicId);
  }

  @Get(':publicId/playback/:rendition')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get HLS variant playlist',
    description:
      'Returns the HLS variant playlist with direct signed segment URLs.',
  })
  @ApiResponse({
    status: 200,
    description: 'HLS variant manifest',
    content: {
      'application/vnd.apple.mpegurl': {
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video or rendition not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getRenditionManifest(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('rendition') rendition: string,
  ): Promise<string> {
    return this.mediaDeliveryService.getRenditionManifest(
      user.sub,
      publicId,
      rendition,
    );
  }

  @Get(':publicId/thumbnail')
  @Redirect()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get thumbnail redirect',
    description:
      'Redirects to a short-lived presigned URL for the video thumbnail.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned thumbnail URL',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Thumbnail is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getThumbnail(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.mediaDeliveryService.getThumbnailRedirectUrl(
      user.sub,
      publicId,
    );
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':publicId/download')
  @Redirect()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get original download redirect',
    description:
      'Redirects to a short-lived presigned URL for downloading the original video file.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned original download URL',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'You do not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video original is not available yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.mediaDeliveryService.getDownloadRedirectUrl(
      user.sub,
      publicId,
    );
    return { url, statusCode: HttpStatus.FOUND };
  }
}
