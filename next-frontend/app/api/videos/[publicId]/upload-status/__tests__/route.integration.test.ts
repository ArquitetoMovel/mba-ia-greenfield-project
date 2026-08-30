import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  FORBIDDEN_PUBLIC_ID,
  NOT_FOUND_PUBLIC_ID,
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

let GET: (
  req: Request,
  ctx: { params: Promise<{ publicId: string }> },
) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import(
    "@/app/api/videos/[publicId]/upload-status/route"
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

describe("GET /api/videos/[publicId]/upload-status", () => {
  const validParams = Promise.resolve({
    publicId: "testvideo123456789012",
  });

  it("rejects unauthenticated request with 401 when local session is missing", async () => {
    cookieMap.clear();
    const res = await GET(
      new Request("http://localhost/api/videos/test/upload-status"),
      { params: validParams },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  it("returns 200 with VideoUploadStatusResponse on valid request", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/upload-status"),
      { params: validParams },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      public_id: "testvideo123456789012",
      processing_status: "ready",
      thumbnail_available: true,
      playback_available: true,
    });
  });

  it("returns 404 when video is not found", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/upload-status"),
      { params: Promise.resolve({ publicId: NOT_FOUND_PUBLIC_ID }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 404,
      error: "VIDEO_NOT_FOUND",
    });
  });

  it("returns 403 when video belongs to another user", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/upload-status"),
      { params: Promise.resolve({ publicId: FORBIDDEN_PUBLIC_ID }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 403,
      error: "VIDEO_ACCESS_DENIED",
    });
  });
});
