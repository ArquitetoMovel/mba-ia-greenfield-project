export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_JOB_NAME = 'process-video';

export interface VideoUploadCompletedPayload {
  videoId: string;
  originalKey: string;
  processingVersion: number;
}
