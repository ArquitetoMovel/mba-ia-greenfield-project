// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFileFingerprint } from "../fingerprint";
import {
  uploadVideo,
  type UploadProgress,
} from "../upload-coordinator";
import { saveUploadSession } from "../resume-store";

describe("upload-state & upload-coordinator", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
  });

  describe("generateFileFingerprint", () => {
    it("generates deterministic fingerprint for identical file metadata", () => {
      const file1 = new File(["dummy content"], "video.mp4", {
        type: "video/mp4",
        lastModified: 1700000000000,
      });
      const file2 = new File(["dummy content"], "video.mp4", {
        type: "video/mp4",
        lastModified: 1700000000000,
      });

      expect(generateFileFingerprint(file1)).toBe(
        generateFileFingerprint(file2),
      );
    });

    it("generates different fingerprints when size or lastModified change", () => {
      const file1 = new File(["dummy 1"], "video.mp4", {
        type: "video/mp4",
        lastModified: 1700000000000,
      });
      const file2 = new File(["dummy 1"], "video.mp4", {
        type: "video/mp4",
        lastModified: 1700000000001,
      });

      expect(generateFileFingerprint(file1)).not.toBe(
        generateFileFingerprint(file2),
      );
    });
  });

  describe("uploadVideo workflow", () => {
    it("coordinates full multipart upload: create -> part-urls -> PUT chunks -> complete -> poll ready", async () => {
      const file = new File(
        [new Uint8Array(10 * 1024 * 1024)],
        "sample.mp4",
        { type: "video/mp4", lastModified: 1700000000000 },
      );

      const progressSnapshots: UploadProgress[] = [];

      // Mock fetch responses for BFF endpoints
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/videos/uploads" && init?.method === "POST") {
          return {
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                upload_session_id: "sess-123",
                public_id: "pub-123",
                canonical_url: "/v/pub-123",
                part_size_bytes: 5 * 1024 * 1024,
                total_parts: 2,
                expires_at: new Date().toISOString(),
                state: "active",
                video_id: "v-1",
              }),
          };
        }

        if (url === "/api/videos/uploads/sess-123/part-urls" && init?.method === "POST") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                parts: [
                  { part_number: 1, url: "http://storage.local/part1" },
                  { part_number: 2, url: "http://storage.local/part2" },
                ],
              }),
          };
        }

        if (url.startsWith("http://storage.local/part") && init?.method === "PUT") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (header: string) =>
                header.toLowerCase() === "etag" ? '"sample-etag-123"' : null,
            },
          };
        }

        if (url === "/api/videos/uploads/sess-123/complete" && init?.method === "POST") {
          return {
            ok: true,
            status: 202,
            json: () =>
              Promise.resolve({
                public_id: "pub-123",
                processing_status: "uploaded",
                processing_version: 1,
              }),
          };
        }

        if (url === "/api/videos/pub-123/upload-status") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                public_id: "pub-123",
                canonical_url: "/v/pub-123",
                processing_status: "ready",
                duration_seconds: 45.2,
                thumbnail_available: true,
                playback_available: true,
              }),
          };
        }

        return { ok: false, status: 404, json: () => Promise.resolve({}) };
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      const result = await uploadVideo(file, {
        onProgress: (p) => progressSnapshots.push({ ...p }),
        pollIntervalMs: 10,
      });

      expect(result.publicId).toBe("pub-123");
      expect(result.canonicalUrl).toBe("/v/pub-123");
      expect(progressSnapshots.some((s) => s.stage === "uploading")).toBe(true);
      expect(progressSnapshots.some((s) => s.stage === "completing")).toBe(true);
      expect(progressSnapshots.some((s) => s.stage === "ready")).toBe(true);
    });

    it("resumes an active session and skips already confirmed parts", async () => {
      const file = new File(
        [new Uint8Array(10 * 1024 * 1024)],
        "resumable.mp4",
        { type: "video/mp4", lastModified: 1700000000000 },
      );
      const fp = generateFileFingerprint(file);

      // Pre-seed local session with part 1 completed
      await saveUploadSession({
        fingerprint: fp,
        sessionId: "sess-resumable",
        publicId: "pub-resumable",
        canonicalUrl: "/v/pub-resumable",
        partSizeBytes: 5 * 1024 * 1024,
        totalParts: 2,
        uploadedParts: [{ part_number: 1, etag: "etag1" }],
        updatedAt: Date.now(),
      });

      const requestedPartBatches: number[][] = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/videos/uploads/sess-resumable") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                video_id: "v-1",
                public_id: "pub-resumable",
                state: "active",
                processing_status: "uploading",
                part_size_bytes: 5 * 1024 * 1024,
                expected_size_bytes: 10 * 1024 * 1024,
                uploaded_parts: [{ part_number: 1, etag: "etag1" }],
              }),
          };
        }

        if (url === "/api/videos/uploads/sess-resumable/part-urls") {
          const body = JSON.parse(String(init?.body)) as { part_numbers: number[] };
          requestedPartBatches.push(body.part_numbers);
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                parts: [{ part_number: 2, url: "http://storage.local/part2" }],
              }),
          };
        }

        if (url === "http://storage.local/part2") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: () => '"etag2"',
            },
          };
        }

        if (url === "/api/videos/uploads/sess-resumable/complete") {
          return {
            ok: true,
            status: 202,
            json: () =>
              Promise.resolve({
                public_id: "pub-resumable",
                processing_status: "uploaded",
                processing_version: 1,
              }),
          };
        }

        if (url === "/api/videos/pub-resumable/upload-status") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                public_id: "pub-resumable",
                canonical_url: "/v/pub-resumable",
                processing_status: "ready",
                thumbnail_available: true,
                playback_available: true,
              }),
          };
        }

        return { ok: false, status: 404, json: () => Promise.resolve({}) };
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      const result = await uploadVideo(file, { pollIntervalMs: 10 });
      expect(result.publicId).toBe("pub-resumable");

      // Verify that only part 2 was requested (part 1 was skipped)
      expect(requestedPartBatches).toEqual([[2]]);
    });

    it("clears stale local session when server reports session is no longer active", async () => {
      const file = new File(
        [new Uint8Array(10 * 1024 * 1024)],
        "stale.mp4",
        { type: "video/mp4", lastModified: 1700000000000 },
      );
      const fp = generateFileFingerprint(file);

      await saveUploadSession({
        fingerprint: fp,
        sessionId: "sess-stale",
        publicId: "pub-stale",
        canonicalUrl: "/v/pub-stale",
        partSizeBytes: 5 * 1024 * 1024,
        totalParts: 2,
        uploadedParts: [],
        updatedAt: Date.now(),
      });

      let createCalled = false;

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === "/api/videos/uploads/sess-stale") {
          // Server says session cancelled/expired
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                state: "cancelled",
                uploaded_parts: [],
              }),
          };
        }

        if (url === "/api/videos/uploads") {
          createCalled = true;
          return {
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                upload_session_id: "sess-fresh",
                public_id: "pub-fresh",
                canonical_url: "/v/pub-fresh",
                part_size_bytes: 10 * 1024 * 1024,
                total_parts: 1,
                state: "active",
              }),
          };
        }

        if (url === "/api/videos/uploads/sess-fresh/part-urls") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                parts: [{ part_number: 1, url: "http://storage.local/part1" }],
              }),
          };
        }

        if (url === "http://storage.local/part1") {
          return {
            ok: true,
            status: 200,
            headers: { get: () => '"etag1"' },
          };
        }

        if (url === "/api/videos/uploads/sess-fresh/complete") {
          return {
            ok: true,
            status: 202,
            json: () =>
              Promise.resolve({
                public_id: "pub-fresh",
                processing_status: "uploaded",
              }),
          };
        }

        if (url === "/api/videos/pub-fresh/upload-status") {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                public_id: "pub-fresh",
                canonical_url: "/v/pub-fresh",
                processing_status: "ready",
                thumbnail_available: true,
                playback_available: true,
              }),
          };
        }

        return { ok: false, status: 404, json: () => Promise.resolve({}) };
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      await uploadVideo(file, { pollIntervalMs: 10 });
      expect(createCalled).toBe(true);
    });
  });
});
