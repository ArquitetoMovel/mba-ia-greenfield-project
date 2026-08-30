import { http, HttpResponse } from "msw";
import { env } from "@/lib/env";
import {
  createUploadSessionResponse,
  createUploadSessionDetail,
  createPartUrlsResponse,
  createCompleteUploadResponse,
  createVideoUploadStatusResponse,
} from "../factories/videos";
import type { ApiErrorEnvelope } from "@/lib/api/contracts";

export const FORBIDDEN_SESSION_ID = "00000000-0000-0000-0000-000000000403";
export const NOT_FOUND_SESSION_ID = "00000000-0000-0000-0000-000000000404";
export const CONFLICT_SESSION_ID = "00000000-0000-0000-0000-000000000409";
export const UNPROCESSABLE_SESSION_ID = "00000000-0000-0000-0000-000000000422";

export const FORBIDDEN_PUBLIC_ID = "forbidden12345678901";
export const NOT_FOUND_PUBLIC_ID = "notfound123456789012";
export const NOT_READY_PUBLIC_ID = "notready123456789012";

function errorEnvelope(
  statusCode: number,
  error: string,
  message: string,
): ApiErrorEnvelope {
  return { statusCode, error, message, code: null };
}

export const handlers = [
  // POST /videos/uploads
  http.post(`${env.API_URL}/videos/uploads`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const declaredSize = Number(body.size_bytes ?? body.declared_size_bytes ?? 0);

    if (declaredSize > 10737418240) {
      return HttpResponse.json(
        errorEnvelope(
          413,
          "UPLOAD_FILE_TOO_LARGE",
          "File exceeds maximum upload size of 10 GB",
        ),
        { status: 413 },
      );
    }

    return HttpResponse.json(createUploadSessionResponse(), { status: 201 });
  }),

  // GET /videos/uploads/:sessionId
  http.get(`${env.API_URL}/videos/uploads/:sessionId`, ({ params }) => {
    const { sessionId } = params;

    if (sessionId === NOT_FOUND_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found"),
        { status: 404 },
      );
    }
    if (sessionId === FORBIDDEN_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }

    return HttpResponse.json(createUploadSessionDetail());
  }),

  // POST /videos/uploads/:sessionId/part-urls
  http.post(`${env.API_URL}/videos/uploads/:sessionId/part-urls`, ({ params }) => {
    const { sessionId } = params;

    if (sessionId === NOT_FOUND_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found"),
        { status: 404 },
      );
    }
    if (sessionId === FORBIDDEN_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }
    if (sessionId === CONFLICT_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(409, "UPLOAD_SESSION_NOT_ACTIVE", "Upload session is no longer active"),
        { status: 409 },
      );
    }

    return HttpResponse.json(createPartUrlsResponse());
  }),

  // POST /videos/uploads/:sessionId/complete
  http.post(`${env.API_URL}/videos/uploads/:sessionId/complete`, ({ params }) => {
    const { sessionId } = params;

    if (sessionId === NOT_FOUND_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found"),
        { status: 404 },
      );
    }
    if (sessionId === FORBIDDEN_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }
    if (sessionId === CONFLICT_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(409, "UPLOAD_SESSION_NOT_ACTIVE", "Upload session is no longer active"),
        { status: 409 },
      );
    }
    if (sessionId === UNPROCESSABLE_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(422, "INVALID_UPLOAD_PARTS", "Invalid upload parts"),
        { status: 422 },
      );
    }

    return HttpResponse.json(createCompleteUploadResponse(), { status: 202 });
  }),

  // DELETE /videos/uploads/:sessionId
  http.delete(`${env.API_URL}/videos/uploads/:sessionId`, ({ params }) => {
    const { sessionId } = params;

    if (sessionId === NOT_FOUND_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found"),
        { status: 404 },
      );
    }
    if (sessionId === FORBIDDEN_SESSION_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }

    return new HttpResponse(null, { status: 204 });
  }),

  // GET /videos/:publicId/upload-status
  http.get(`${env.API_URL}/videos/:publicId/upload-status`, ({ params }) => {
    const { publicId } = params;

    if (publicId === NOT_FOUND_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"),
        { status: 404 },
      );
    }
    if (publicId === FORBIDDEN_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }

    return HttpResponse.json(
      createVideoUploadStatusResponse({ public_id: String(publicId) }),
    );
  }),

  // GET /videos/:publicId/playback/master
  http.get(`${env.API_URL}/videos/:publicId/playback/master`, ({ params }) => {
    const { publicId } = params;

    if (publicId === NOT_FOUND_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"),
        { status: 404 },
      );
    }
    if (publicId === FORBIDDEN_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }
    if (publicId === NOT_READY_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(409, "VIDEO_NOT_READY", "Video is not ready"),
        { status: 409 },
      );
    }

    const masterManifest =
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=640x360\n360p/playlist.m3u8\n";
    return new HttpResponse(masterManifest, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }),

  // GET /videos/:publicId/playback/:rendition
  http.get(
    `${env.API_URL}/videos/:publicId/playback/:rendition`,
    ({ params }) => {
      const { publicId } = params;

      if (publicId === NOT_FOUND_PUBLIC_ID) {
        return HttpResponse.json(
          errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"),
          { status: 404 },
        );
      }
      if (publicId === FORBIDDEN_PUBLIC_ID) {
        return HttpResponse.json(
          errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
          { status: 403 },
        );
      }
      if (publicId === NOT_READY_PUBLIC_ID) {
        return HttpResponse.json(
          errorEnvelope(409, "VIDEO_NOT_READY", "Video is not ready"),
          { status: 409 },
        );
      }

      const variantManifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nhttp://localhost:9000/streamtube-media/segment0.ts?signed=true\n#EXT-X-ENDLIST\n`;
      return new HttpResponse(variantManifest, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    },
  ),

  // GET /videos/:publicId/thumbnail
  http.get(`${env.API_URL}/videos/:publicId/thumbnail`, ({ params }) => {
    const { publicId } = params;

    if (publicId === NOT_FOUND_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"),
        { status: 404 },
      );
    }
    if (publicId === FORBIDDEN_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }
    if (publicId === NOT_READY_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(409, "VIDEO_NOT_READY", "Video is not ready"),
        { status: 409 },
      );
    }

    return new HttpResponse(null, {
      status: 302,
      headers: {
        Location:
          "http://localhost:9000/streamtube-media/thumbnail.jpg?signed=true",
      },
    });
  }),

  // GET /videos/:publicId/download
  http.get(`${env.API_URL}/videos/:publicId/download`, ({ params }) => {
    const { publicId } = params;

    if (publicId === NOT_FOUND_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(404, "VIDEO_NOT_FOUND", "Video not found"),
        { status: 404 },
      );
    }
    if (publicId === FORBIDDEN_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(403, "VIDEO_ACCESS_DENIED", "Access denied"),
        { status: 403 },
      );
    }
    if (publicId === NOT_READY_PUBLIC_ID) {
      return HttpResponse.json(
        errorEnvelope(409, "VIDEO_NOT_READY", "Video is not ready"),
        { status: 409 },
      );
    }

    return new HttpResponse(null, {
      status: 302,
      headers: {
        Location:
          "http://localhost:9000/streamtube-media/source.mp4?download=true",
      },
    });
  }),
];
