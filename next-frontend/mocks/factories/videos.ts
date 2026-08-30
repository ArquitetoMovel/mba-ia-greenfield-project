import type {
  UploadSessionResponse,
  UploadSessionDetail,
  PartUrlsResponse,
  CompleteUploadResponse,
  VideoUploadStatusResponse,
} from "@/lib/api/contracts";

export function createUploadSessionResponse(
  overrides: Partial<UploadSessionResponse> = {},
): UploadSessionResponse {
  return {
    video_id: "a0000000-0000-0000-0000-000000000001",
    public_id: "testvideo123456789012",
    canonical_url: "/v/testvideo123456789012",
    upload_session_id: "b0000000-0000-0000-0000-000000000002",
    state: "active",
    part_size_bytes: 52428800,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  };
}

export function createUploadSessionDetail(
  overrides: Partial<UploadSessionDetail> = {},
): UploadSessionDetail {
  return {
    video_id: "a0000000-0000-0000-0000-000000000001",
    public_id: "testvideo123456789012",
    state: "active",
    processing_status: "uploading",
    part_size_bytes: 52428800,
    expected_size_bytes: 104857600,
    uploaded_parts: [{ part_number: 1, etag: "etag1" }],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  };
}

export function createPartUrlsResponse(
  overrides: Partial<PartUrlsResponse> = {},
): PartUrlsResponse {
  return {
    parts: [
      {
        part_number: 1,
        url: "http://localhost:9000/streamtube-media/part1?signed=true",
        expires_at: new Date(Date.now() + 900000).toISOString(),
      },
      {
        part_number: 2,
        url: "http://localhost:9000/streamtube-media/part2?signed=true",
        expires_at: new Date(Date.now() + 900000).toISOString(),
      },
    ],
    ...overrides,
  };
}

export function createCompleteUploadResponse(
  overrides: Partial<CompleteUploadResponse> = {},
): CompleteUploadResponse {
  return {
    public_id: "testvideo123456789012",
    processing_status: "uploaded",
    processing_version: 1,
    ...overrides,
  };
}

export function createVideoUploadStatusResponse(
  overrides: Partial<VideoUploadStatusResponse> = {},
): VideoUploadStatusResponse {
  return {
    public_id: "testvideo123456789012",
    canonical_url: "/v/testvideo123456789012",
    processing_status: "ready",
    duration_seconds: 120.5,
    processing_error: null,
    thumbnail_available: true,
    playback_available: true,
    ...overrides,
  };
}
