import "server-only";

import { env } from "@/lib/env";
import { getSession } from "./session";
import { withRefresh } from "./refresh";

export async function authenticatedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const session = await getSession();

  if (!session.isLoggedIn || !session.accessToken) {
    return new Response(
      JSON.stringify({
        statusCode: 401,
        error: "UNAUTHORIZED",
        message: "Unauthorized",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const url = path.startsWith("http") ? path : `${env.API_URL}${path}`;

  return withRefresh(async () => {
    const currentSession = await getSession();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${currentSession.accessToken}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url, {
      ...init,
      headers,
    });
  });
}
