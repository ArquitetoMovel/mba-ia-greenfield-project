export interface UploadPartUrl {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface StorageObjectMetadata {
  contentLength: number;
  contentType?: string;
  eTag?: string;
  lastModified?: Date;
}

export interface MultipartSession {
  uploadId: string;
  key: string;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: Date;
}
