import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  CONFLICT_SESSION_ID,
  FORBIDDEN_SESSION_ID,
  NOT_FOUND_SESSION_ID,
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
    "@/app/api/videos/uploads/[sessionId]/part-urls/route"
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
  return new Request("http://localhost/api/videos/uploads/test/part-urls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/videos/uploads/[sessionId]/part-urls", () => {
  const validParams = Promise.resolve({
    sessionId: "a0000000-0000-0000-0000-000000000001",
  });

  it("rejects unauthenticated request with 401 when local session is missing", async () => {
    cookieMap.clear();
    const res = await POST(makeRequest({ part_numbers: [1, 2] }), {
      params: validParams,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  it("returns 200 with PartUrlsResponse on valid request", async () => {
    const res = await POST(makeRequest({ part_numbers: [1, 2] }), {
      params: validParams,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("parts");
    expect(body.parts.length).toBeGreaterThan(0);
    expect(body.parts[0]).toHaveProperty("part_number");
    expect(body.parts[0]).toHaveProperty("url");
  });

  it("returns 409 when session is no longer active", async () => {
    const res = await POST(makeRequest({ part_numbers: [1] }), {
      params: Promise.resolve({ sessionId: CONFLICT_SESSION_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 409,
      error: "UPLOAD_SESSION_NOT_ACTIVE",
    });
  });

  it("returns 404 when session is not found", async () => {
    const res = await POST(makeRequest({ part_numbers: [1] }), {
      params: Promise.resolve({ sessionId: NOT_FOUND_SESSION_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 404,
      error: "UPLOAD_SESSION_NOT_FOUND",
    });
  });

  it("returns 403 when session belongs to another user", async () => {
    const res = await POST(makeRequest({ part_numbers: [1] }), {
      params: Promise.resolve({ sessionId: FORBIDDEN_SESSION_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 403,
      error: "VIDEO_ACCESS_DENIED",
    });
  });
});
