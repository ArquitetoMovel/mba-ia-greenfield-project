import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type {
  VideoUploadStatusResponse,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;
  const res = await authenticatedFetch(`/videos/${publicId}/upload-status`);

  const data = (await res.json()) as
    | VideoUploadStatusResponse
    | ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}
