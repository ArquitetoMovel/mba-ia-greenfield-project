import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type { ApiErrorEnvelope } from "@/lib/api/contracts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;
  const res = await authenticatedFetch(
    `/videos/${publicId}/download`,
    { redirect: "manual" },
  );

  const location = res.headers.get("Location");
  if (location && (res.status === 302 || res.status === 307 || res.status === 308)) {
    return new Response(null, {
      status: 302,
      headers: { Location: location },
    });
  }

  const errData = (await res.json().catch(() => ({}))) as ApiErrorEnvelope;
  return NextResponse.json(errData, { status: res.status });
}
