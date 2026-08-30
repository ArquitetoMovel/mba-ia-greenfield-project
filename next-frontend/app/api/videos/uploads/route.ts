import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type {
  CreateUploadDto,
  UploadSessionResponse,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export async function POST(request: Request) {
  const body = (await request.json()) as CreateUploadDto;

  const res = await authenticatedFetch("/videos/uploads", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as UploadSessionResponse | ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}
