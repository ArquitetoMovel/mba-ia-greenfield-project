import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
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

let GET: (
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) => Promise<Response>;
let DELETE: (
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) => Promise<Response>;

beforeAll(async () => {
  ({ GET, DELETE } = await import("@/app/api/videos/uploads/[sessionId]/route"));
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

describe("GET & DELETE /api/videos/uploads/[sessionId]", () => {
  const validParams = Promise.resolve({
    sessionId: "a0000000-0000-0000-0000-000000000001",
  });

  describe("GET /api/videos/uploads/[sessionId]", () => {
    it("rejects unauthenticated request with 401 when local session is missing", async () => {
      cookieMap.clear();
      const res = await GET(
        new Request("http://localhost/api/videos/uploads/test"),
        { params: validParams },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
    });

    it("returns 200 with UploadSessionDetail on valid session", async () => {
      const res = await GET(
        new Request("http://localhost/api/videos/uploads/test"),
        { params: validParams },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("video_id");
      expect(body).toHaveProperty("public_id");
      expect(body).toHaveProperty("uploaded_parts");
    });

    it("returns 404 error envelope when upload session is not found", async () => {
      const res = await GET(
        new Request("http://localhost/api/videos/uploads/test"),
        { params: Promise.resolve({ sessionId: NOT_FOUND_SESSION_ID }) },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toMatchObject({
        statusCode: 404,
        error: "UPLOAD_SESSION_NOT_FOUND",
      });
    });

    it("returns 403 error envelope when session belongs to another user", async () => {
      const res = await GET(
        new Request("http://localhost/api/videos/uploads/test"),
        { params: Promise.resolve({ sessionId: FORBIDDEN_SESSION_ID }) },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({
        statusCode: 403,
        error: "VIDEO_ACCESS_DENIED",
      });
    });
  });

  describe("DELETE /api/videos/uploads/[sessionId]", () => {
    it("rejects unauthenticated request with 401 when local session is missing", async () => {
      cookieMap.clear();
      const res = await DELETE(
        new Request("http://localhost/api/videos/uploads/test", {
          method: "DELETE",
        }),
        { params: validParams },
      );
      expect(res.status).toBe(401);
    });

    it("returns 204 on successful session cancellation", async () => {
      const res = await DELETE(
        new Request("http://localhost/api/videos/uploads/test", {
          method: "DELETE",
        }),
        { params: validParams },
      );
      expect(res.status).toBe(204);
    });

    it("returns 404 when cancelling non-existent session", async () => {
      const res = await DELETE(
        new Request("http://localhost/api/videos/uploads/test", {
          method: "DELETE",
        }),
        { params: Promise.resolve({ sessionId: NOT_FOUND_SESSION_ID }) },
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toMatchObject({
        statusCode: 404,
        error: "UPLOAD_SESSION_NOT_FOUND",
      });
    });
  });
});
