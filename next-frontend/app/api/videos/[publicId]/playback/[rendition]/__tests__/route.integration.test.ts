import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  FORBIDDEN_PUBLIC_ID,
  NOT_FOUND_PUBLIC_ID,
  NOT_READY_PUBLIC_ID,
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
  ctx: { params: Promise<{ publicId: string; rendition: string }> },
) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import(
    "@/app/api/videos/[publicId]/playback/[rendition]/route"
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

describe("GET /api/videos/[publicId]/playback/[rendition]", () => {
  const validParams = Promise.resolve({
    publicId: "testvideo123456789012",
    rendition: "360p",
  });

  it("rejects unauthenticated request with 401 when session is missing", async () => {
    cookieMap.clear();
    const res = await GET(
      new Request("http://localhost/api/videos/test/playback/360p"),
      { params: validParams },
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with variant manifest and signed segment URLs on success", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/playback/360p"),
      { params: validParams },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/vnd.apple.mpegurl",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("#EXTM3U");
    expect(text).toContain("http://localhost:9000/streamtube-media/segment0.ts");
  });

  it("returns 409 when video is not ready", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/playback/360p"),
      {
        params: Promise.resolve({
          publicId: NOT_READY_PUBLIC_ID,
          rendition: "360p",
        }),
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 409,
      error: "VIDEO_NOT_READY",
    });
  });

  it("returns 403 when video belongs to another channel", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/playback/360p"),
      {
        params: Promise.resolve({
          publicId: FORBIDDEN_PUBLIC_ID,
          rendition: "360p",
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when video is not found", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/playback/360p"),
      {
        params: Promise.resolve({
          publicId: NOT_FOUND_PUBLIC_ID,
          rendition: "360p",
        }),
      },
    );
    expect(res.status).toBe(404);
  });
});
