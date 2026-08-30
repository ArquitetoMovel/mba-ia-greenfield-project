import { NextResponse } from "next/server";

import type {
  ApiErrorEnvelope,
  ResetPasswordDto,
} from "@/lib/api/contracts";
import { upstream } from "@/lib/api/upstream";

export async function POST(request: Request) {
  const body = (await request.json()) as ResetPasswordDto;

  const { error, response } = await upstream.POST("/auth/reset-password", {
    body: body as never,
  });

  if (error) {
    return NextResponse.json<ApiErrorEnvelope>(error as ApiErrorEnvelope, {
      status: response.status,
    });
  }

  return new Response(null, { status: 204 });
}
