import { NextResponse } from "next/server";
import { authenticatedFetch } from "@/lib/auth/authenticated-fetch";
import type {
  GetPartUrlsDto,
  PartUrlsResponse,
  ApiErrorEnvelope,
} from "@/lib/api/contracts";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = (await request.json()) as GetPartUrlsDto;

  const res = await authenticatedFetch(
    `/videos/uploads/${sessionId}/part-urls`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  const data = (await res.json()) as PartUrlsResponse | ApiErrorEnvelope;
  return NextResponse.json(data, { status: res.status });
}
