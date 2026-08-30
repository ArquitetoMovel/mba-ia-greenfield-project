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
  ctx: { params: Promise<{ publicId: string }> },
) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import(
    "@/app/api/videos/[publicId]/download/route"
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

describe("GET /api/videos/[publicId]/download", () => {
  const validParams = Promise.resolve({
    publicId: "testvideo123456789012",
  });

  it("rejects unauthenticated request with 401 when session is missing", async () => {
    cookieMap.clear();
    const res = await GET(
      new Request("http://localhost/api/videos/test/download"),
      { params: validParams },
    );
    expect(res.status).toBe(401);
  });

  it("returns 302 redirect with Location header on success", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/download"),
      { params: validParams },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /http:\/\/localhost:9000\/streamtube-media\/source\.mp4/,
    );
  });

  it("returns 409 when video original is not ready", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/download"),
      { params: Promise.resolve({ publicId: NOT_READY_PUBLIC_ID }) },
    );
    expect(res.status).toBe(409);
  });

  it("returns 403 when video belongs to another channel", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/download"),
      { params: Promise.resolve({ publicId: FORBIDDEN_PUBLIC_ID }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when video does not exist", async () => {
    const res = await GET(
      new Request("http://localhost/api/videos/test/download"),
      { params: Promise.resolve({ publicId: NOT_FOUND_PUBLIC_ID }) },
    );
    expect(res.status).toBe(404);
  });
});
