import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type {
  CompleteUploadDto,
  CompleteUploadResponse,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = (await request.json()) as CompleteUploadDto;

  const res = await authenticatedFetch(
    `/videos/uploads/${sessionId}/complete`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  const data = (await res.json()) as
    | CompleteUploadResponse
    | ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}
