import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type { ApiErrorEnvelope } from "@/lib/api/contracts";

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ publicId: string; rendition: string }>;
  },
) {
  const { publicId, rendition } = await params;
  const res = await authenticatedFetch(
    `/videos/${publicId}/playback/${rendition}`,
    { redirect: "manual" },
  );

  if (res.status === 200) {
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }

  const errData = (await res.json().catch(() => ({}))) as ApiErrorEnvelope;
  return NextResponse.json(errData, { status: res.status });
}
