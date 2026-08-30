import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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

let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/videos/uploads/route"));
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
  return new Request("http://localhost/api/videos/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/videos/uploads", () => {
  it("rejects unauthenticated request with 401 when local session is missing", async () => {
    cookieMap.clear();
    const res = await POST(
      makeRequest({
        filename: "test.mp4",
        content_type: "video/mp4",
        size_bytes: 1048576,
        file_fingerprint: "fp123",
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  it("returns 201 with UploadSessionResponse on valid upload initiation", async () => {
    const res = await POST(
      makeRequest({
        filename: "test.mp4",
        content_type: "video/mp4",
        size_bytes: 1048576,
        file_fingerprint: "fp123",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("upload_session_id");
    expect(body).toHaveProperty("public_id");
    expect(body).toHaveProperty("canonical_url");
    expect(body).toHaveProperty("part_size_bytes");
  });

  it("returns 413 error envelope when file exceeds 10 GB limit", async () => {
    const res = await POST(
      makeRequest({
        filename: "huge.mp4",
        content_type: "video/mp4",
        size_bytes: 10737418241, // 10 GB + 1 byte
        file_fingerprint: "fp_huge",
      }),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toMatchObject({
      statusCode: 413,
      error: "UPLOAD_FILE_TOO_LARGE",
    });
  });
});
