import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type {
  UploadSessionDetail,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const res = await authenticatedFetch(`/videos/uploads/${sessionId}`);

  const data = (await res.json()) as UploadSessionDetail | ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const res = await authenticatedFetch(`/videos/uploads/${sessionId}`, {
    method: "DELETE",
  });

  if (res.status === 204) {
    return new Response(null, { status: 204 });
  }

  const data = (await res.json()) as ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}
