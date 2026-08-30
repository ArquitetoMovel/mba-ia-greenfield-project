// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveUploadSession,
  getUploadSession,
  addUploadedPart,
  deleteUploadSession,
  type StoredUploadSession,
} from "../resume-store";

describe("resume-store (IndexedDB)", () => {
  const sampleSession: StoredUploadSession = {
    fingerprint: "fp_test_1000_video_mp4_123456",
    sessionId: "sess-1",
    publicId: "pub-1",
    canonicalUrl: "/v/pub-1",
    partSizeBytes: 5242880,
    totalParts: 3,
    uploadedParts: [{ part_number: 1, etag: "etag1" }],
    updatedAt: Date.now(),
  };

  beforeEach(async () => {
    await deleteUploadSession(sampleSession.fingerprint);
  });

  it("saves and retrieves an upload session by fingerprint", async () => {
    await saveUploadSession(sampleSession);
    const retrieved = await getUploadSession(sampleSession.fingerprint);

    expect(retrieved).toBeDefined();
    expect(retrieved?.sessionId).toBe("sess-1");
    expect(retrieved?.publicId).toBe("pub-1");
    expect(retrieved?.uploadedParts).toHaveLength(1);
    expect(retrieved?.uploadedParts[0].etag).toBe("etag1");
  });

  it("returns undefined for non-existent fingerprint", async () => {
    const retrieved = await getUploadSession("non_existent_fp");
    expect(retrieved).toBeUndefined();
  });

  it("adds and updates uploaded parts incrementally", async () => {
    await saveUploadSession(sampleSession);
    await addUploadedPart(sampleSession.fingerprint, {
      part_number: 2,
      etag: "etag2",
    });

    const retrieved = await getUploadSession(sampleSession.fingerprint);
    expect(retrieved?.uploadedParts).toHaveLength(2);
    expect(retrieved?.uploadedParts.map((p) => p.part_number)).toEqual([1, 2]);
  });

  it("deletes an upload session on completion or invalidation", async () => {
    await saveUploadSession(sampleSession);
    await deleteUploadSession(sampleSession.fingerprint);

    const retrieved = await getUploadSession(sampleSession.fingerprint);
    expect(retrieved).toBeUndefined();
  });
});
