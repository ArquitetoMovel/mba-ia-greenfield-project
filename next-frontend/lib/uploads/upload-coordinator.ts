import { generateFileFingerprint } from "./fingerprint";
import {
  addUploadedPart,
  deleteUploadSession,
  getUploadSession,
  saveUploadSession,
  type StoredUploadSession,
} from "./resume-store";
import type {
  CreateUploadDto,
  UploadSessionResponse,
  UploadSessionDetail,
  GetPartUrlsDto,
  PartUrlsResponse,
  CompleteUploadDto,
  CompleteUploadResponse,
  VideoUploadStatusResponse,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export type UploadStage =
  | "idle"
  | "initializing"
  | "uploading"
  | "completing"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";

export interface UploadProgress {
  stage: UploadStage;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  uploadedPartsCount: number;
  totalPartsCount: number;
  publicId?: string;
  canonicalUrl?: string;
  error?: string;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  concurrency?: number;
}

export interface UploadResult {
  publicId: string;
  canonicalUrl: string;
  durationSeconds?: number | null;
}

const MAX_CONCURRENCY = 3;
const DEFAULT_POLL_INTERVAL_MS = 1500;

export async function uploadVideo(
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const {
    onProgress,
    signal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    concurrency = MAX_CONCURRENCY,
  } = options;

  const fingerprint = generateFileFingerprint(file);

  const report = (partial: Partial<UploadProgress>) => {
    if (onProgress) {
      onProgress({
        stage: "idle",
        loadedBytes: 0,
        totalBytes: file.size,
        percent: 0,
        uploadedPartsCount: 0,
        totalPartsCount: 1,
        ...partial,
      });
    }
  };

  report({ stage: "initializing", percent: 0 });

  if (signal?.aborted) {
    report({ stage: "cancelled" });
    throw new Error("Upload aborted");
  }

  // 1. Check local resume store
  let sessionData: StoredUploadSession | undefined =
    await getUploadSession(fingerprint);

  if (sessionData) {
    // Reconcile with server state
    try {
      const res = await fetch(
        `/api/videos/uploads/${sessionData.sessionId}`,
        { signal },
      );
      if (res.ok) {
        const detail = (await res.json()) as UploadSessionDetail;
        if (detail.state === "active") {
          // Reconcile confirmed parts from server
          sessionData.uploadedParts = detail.uploaded_parts.map((p) => ({
            part_number: p.part_number,
            etag: p.etag,
          }));
          await saveUploadSession(sessionData);
        } else {
          await deleteUploadSession(fingerprint);
          sessionData = undefined;
        }
      } else {
        await deleteUploadSession(fingerprint);
        sessionData = undefined;
      }
    } catch {
      await deleteUploadSession(fingerprint);
      sessionData = undefined;
    }
  }

  // 2. Initiate fresh session if none exists
  if (!sessionData) {
    const createPayload: CreateUploadDto = {
      filename: file.name,
      content_type: file.type || "video/mp4",
      size_bytes: file.size,
      file_fingerprint: fingerprint,
    };

    const res = await fetch("/api/videos/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
      signal,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as ApiErrorEnvelope;
      const errMsg = Array.isArray(errBody?.message)
        ? errBody.message.join(", ")
        : errBody?.message || `Upload initiation failed (HTTP ${res.status})`;
      report({ stage: "failed", error: errMsg });
      throw new Error(errMsg);
    }

    const created = (await res.json()) as UploadSessionResponse;
    const totalParts = Math.max(
      1,
      Math.ceil(file.size / created.part_size_bytes),
    );

    sessionData = {
      fingerprint,
      sessionId: created.upload_session_id,
      publicId: created.public_id,
      canonicalUrl: created.canonical_url,
      partSizeBytes: created.part_size_bytes,
      totalParts,
      uploadedParts: [],
      updatedAt: Date.now(),
    };

    await saveUploadSession(sessionData);
  }

  const { sessionId, publicId, canonicalUrl, partSizeBytes, totalParts } =
    sessionData;
  const uploadedPartsMap = new Map<number, string>(
    sessionData.uploadedParts.map((p) => [p.part_number, p.etag]),
  );

  const calculateLoadedBytes = () => {
    let bytes = 0;
    for (const [partNumber] of uploadedPartsMap.entries()) {
      const start = (partNumber - 1) * partSizeBytes;
      const end = Math.min(partNumber * partSizeBytes, file.size);
      bytes += end - start;
    }
    return bytes;
  };

  report({
    stage: "uploading",
    loadedBytes: calculateLoadedBytes(),
    totalBytes: file.size,
    percent: Math.min(
      99,
      Math.round((calculateLoadedBytes() / file.size) * 100),
    ),
    uploadedPartsCount: uploadedPartsMap.size,
    totalPartsCount: totalParts,
    publicId,
    canonicalUrl,
  });

  // 3. Find missing parts
  const allPartNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
  const missingParts = allPartNumbers.filter(
    (partNum) => !uploadedPartsMap.has(partNum),
  );

  if (missingParts.length > 0) {
    // Request part URLs in batches
    const partUrlsMap = new Map<number, string>();
    const batchSize = 20;

    for (let i = 0; i < missingParts.length; i += batchSize) {
      if (signal?.aborted) throw new Error("Upload aborted");

      const batch = missingParts.slice(i, i + batchSize);
      const urlPayload: GetPartUrlsDto = { part_numbers: batch };

      const urlRes = await fetch(
        `/api/videos/uploads/${sessionId}/part-urls`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(urlPayload),
          signal,
        },
      );

      if (!urlRes.ok) {
        const errBody = (await urlRes
          .json()
          .catch(() => ({}))) as ApiErrorEnvelope;
        const errMsg = Array.isArray(errBody?.message)
          ? errBody.message.join(", ")
          : errBody?.message || "Failed to generate part URLs";
        report({ stage: "failed", error: errMsg, publicId, canonicalUrl });
        throw new Error(errMsg);
      }

      const urlData = (await urlRes.json()) as PartUrlsResponse;
      for (const item of urlData.parts) {
        partUrlsMap.set(item.part_number, item.url);
      }
    }

    // Upload missing slices with bounded concurrency
    let currentIndex = 0;
    const activeWorkers: Promise<void>[] = [];

    const uploadWorker = async () => {
      while (currentIndex < missingParts.length) {
        if (signal?.aborted) throw new Error("Upload aborted");

        const partNumber = missingParts[currentIndex++];
        const partUrl = partUrlsMap.get(partNumber);
        if (!partUrl) {
          throw new Error(`Missing presigned URL for part ${partNumber}`);
        }

        const start = (partNumber - 1) * partSizeBytes;
        const end = Math.min(partNumber * partSizeBytes, file.size);
        const chunk = file.slice(start, end);

        const putRes = await fetch(partUrl, {
          method: "PUT",
          body: chunk,
          signal,
        });

        if (!putRes.ok) {
          throw new Error(
            `Failed to upload part ${partNumber} (HTTP ${putRes.status})`,
          );
        }

        const rawEtag = putRes.headers.get("etag") || "";
        const etag = rawEtag.replace(/^["']|["']$/g, "");
        if (!etag) {
          throw new Error(
            `Storage did not return ETag for part ${partNumber}`,
          );
        }

        uploadedPartsMap.set(partNumber, etag);
        await addUploadedPart(fingerprint, { part_number: partNumber, etag });

        const loadedBytes = calculateLoadedBytes();
        report({
          stage: "uploading",
          loadedBytes,
          totalBytes: file.size,
          percent: Math.min(
            99,
            Math.round((loadedBytes / file.size) * 100),
          ),
          uploadedPartsCount: uploadedPartsMap.size,
          totalPartsCount: totalParts,
          publicId,
          canonicalUrl,
        });
      }
    };

    const workerCount = Math.min(concurrency, missingParts.length);
    for (let w = 0; w < workerCount; w++) {
      activeWorkers.push(uploadWorker());
    }

    try {
      await Promise.all(activeWorkers);
    } catch (err: unknown) {
      if (signal?.aborted) {
        report({ stage: "cancelled", publicId, canonicalUrl });
        throw new Error("Upload aborted");
      }
      const errMsg =
        err instanceof Error ? err.message : "Multipart chunk transfer failed";
      report({ stage: "failed", error: errMsg, publicId, canonicalUrl });
      throw err;
    }
  }

  // 4. Complete upload session
  report({
    stage: "completing",
    loadedBytes: file.size,
    totalBytes: file.size,
    percent: 99,
    uploadedPartsCount: totalParts,
    totalPartsCount: totalParts,
    publicId,
    canonicalUrl,
  });

  const sortedParts = Array.from(uploadedPartsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([part_number, etag]) => ({ part_number, etag }));

  const completePayload: CompleteUploadDto = { parts: sortedParts };
  const completeRes = await fetch(
    `/api/videos/uploads/${sessionId}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(completePayload),
      signal,
    },
  );

  if (!completeRes.ok && completeRes.status !== 202) {
    const errBody = (await completeRes
      .json()
      .catch(() => ({}))) as ApiErrorEnvelope;
    const errMsg = Array.isArray(errBody?.message)
      ? errBody.message.join(", ")
      : errBody?.message || "Failed to complete upload session";
    report({ stage: "failed", error: errMsg, publicId, canonicalUrl });
    throw new Error(errMsg);
  }

  const completeData =
    (await completeRes.json()) as CompleteUploadResponse;
  await deleteUploadSession(fingerprint);

  // 5. Poll for video processing status
  report({
    stage: "processing",
    loadedBytes: file.size,
    totalBytes: file.size,
    percent: 100,
    uploadedPartsCount: totalParts,
    totalPartsCount: totalParts,
    publicId: completeData.public_id,
    canonicalUrl,
  });

  while (true) {
    if (signal?.aborted) {
      report({ stage: "cancelled", publicId, canonicalUrl });
      throw new Error("Upload aborted");
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const statusRes = await fetch(
      `/api/videos/${completeData.public_id}/upload-status`,
      { signal },
    );

    if (statusRes.ok) {
      const statusData =
        (await statusRes.json()) as VideoUploadStatusResponse;

      if (statusData.processing_status === "ready") {
        report({
          stage: "ready",
          loadedBytes: file.size,
          totalBytes: file.size,
          percent: 100,
          uploadedPartsCount: totalParts,
          totalPartsCount: totalParts,
          publicId: statusData.public_id,
          canonicalUrl: statusData.canonical_url,
        });

        return {
          publicId: statusData.public_id,
          canonicalUrl: statusData.canonical_url,
          durationSeconds: statusData.duration_seconds,
        };
      }

      if (statusData.processing_status === "failed") {
        const errMsg =
          statusData.processing_error || "Video transcode processing failed";
        report({
          stage: "failed",
          error: errMsg,
          publicId: statusData.public_id,
          canonicalUrl: statusData.canonical_url,
        });
        throw new Error(errMsg);
      }

      if (statusData.processing_status === "cancelled") {
        report({
          stage: "cancelled",
          publicId: statusData.public_id,
          canonicalUrl: statusData.canonical_url,
        });
        throw new Error("Video processing was cancelled");
      }
    }
  }
}

export async function cancelUpload(
  sessionId: string,
  fingerprint?: string,
): Promise<void> {
  if (fingerprint) {
    await deleteUploadSession(fingerprint);
  }
  await fetch(`/api/videos/uploads/${sessionId}`, {
    method: "DELETE",
  }).catch(() => {});
}
