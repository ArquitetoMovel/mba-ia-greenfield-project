import { beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { env } from "@/lib/env";
import { server } from "@/mocks/server";

let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/auth/reset-password/route"));
});

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/reset-password", () => {
  it("returns 204 for a valid reset token and new password", async () => {
    const res = await POST(
      makeRequest({ token: "valid-token", new_password: "NewPassword1!" })
    );

    expect(res.status).toBe(204);
  });

  it("passes through a 401 for an invalid or expired reset token", async () => {
    server.use(
      http.post(`${env.API_URL}/auth/reset-password`, () =>
        HttpResponse.json(
          {
            statusCode: 401,
            error: "INVALID_TOKEN",
            message: "Invalid or expired reset token",
          },
          { status: 401 }
        )
      )
    );

    const res = await POST(
      makeRequest({ token: "expired-token", new_password: "NewPassword1!" })
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      statusCode: 401,
      error: "INVALID_TOKEN",
    });
  });

  it("does not establish a session cookie", async () => {
    const res = await POST(
      makeRequest({ token: "valid-token", new_password: "NewPassword1!" })
    );

    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
