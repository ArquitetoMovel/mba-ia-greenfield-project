import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  CONFLICT_SESSION_ID,
  FORBIDDEN_SESSION_ID,
  NOT_FOUND_SESSION_ID,
  UNPROCESSABLE_SESSION_ID,
} from "@/mocks/handlers/videos";

const cookieMap = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: (name: string) =>
      cookieMap.has(name) ? { name, value: cookieMap.get(name)! } : undefined,
    set: (name: string, value: string) => {
      cookieMap.set(name, value);
    },
    delete: (name: string) => {
      cookieMap.delete(name);
    },
  }),
}));

let POST: (
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import(
    "@/app/api/videos/uploads/[sessionId]/complete/route"
  ));
});

const { setSession } = await import("@/lib/auth/session");

beforeEach(async () => {
  cookieMap.clear();
  await setSession({
    accessToken: "active-at",
    refreshToken: "active-rt",
    userId: "u1",
    email: "uploader@example.com",
    channelSlug: "uploader",
  });
});

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/videos/uploads/test/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/videos/uploads/[sessionId]/complete", () => {
  const validParams = Promise.resolve({
    sessionId: "a0000000-0000-0000-0000-000000000001",
  });

  it("rejects unauthenticated request with 401 when local session is missing", async () => {
    cookieMap.clear();
    const res = await POST(
      makeRequest({ parts: [{ part_number: 1, etag: "etag1" }] }),
      { params: validParams },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  it("returns 202 with CompleteUploadResponse on successful upload completion", async () => {
    const res = await POST(
      makeRequest({ parts: [{ part_number: 1, etag: "etag1" }] }),
      { params: validParams },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      public_id: expect.any(String),
      processing_status: "uploaded",
    });
  });

  it("returns 422 when parts list does not match storage session", async () => {
    const res = await POST(
      makeRequest({ parts: [{ part_number: 99, etag: "invalid" }] }),
      { params: Promise.resolve({ sessionId: UNPROCESSABLE_SESSION_ID }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 422,
      error: "INVALID_UPLOAD_PARTS",
    });
  });

  it("returns 409 when session is no longer active", async () => {
    const res = await POST(
      makeRequest({ parts: [{ part_number: 1, etag: "etag1" }] }),
      { params: Promise.resolve({ sessionId: CONFLICT_SESSION_ID }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 409,
      error: "UPLOAD_SESSION_NOT_ACTIVE",
    });
  });

  it("returns 404 when session is not found", async () => {
    const res = await POST(
      makeRequest({ parts: [{ part_number: 1, etag: "etag1" }] }),
      { params: Promise.resolve({ sessionId: NOT_FOUND_SESSION_ID }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when session belongs to another user", async () => {
    const res = await POST(
      makeRequest({ parts: [{ part_number: 1, etag: "etag1" }] }),
      { params: Promise.resolve({ sessionId: FORBIDDEN_SESSION_ID }) },
    );
    expect(res.status).toBe(403);
  });
});
