---
kind: phase
name: phase-03-upload-processing
sources:
  - docs/project-plan.md
  - docs/decisions/technical-decisions-upload-processing.md
  - docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md
  - docs/phases/phase-02-auth/phase-02-auth.md
  - docs/phases/phase-02-auth-frontend/phase-02-auth-frontend.md
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver an authenticated, resumable upload pipeline for files up to 10 GB, with S3-compatible direct multipart transfer, durable asynchronous video processing, HLS playback assets, thumbnails, and owner-only media delivery before Phase 04 introduces publication visibility.

---

## Step Implementations

### SI-03.1 — Media Storage and Queue Configuration

**Description:** Add the backend dependencies and namespaced configuration needed to use an S3-compatible object store and BullMQ/Redis without exposing storage credentials to the browser.

**Technical actions:**

- Install `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `@nestjs/bullmq@^11.x`, and `bullmq@^5.x` in `nestjs-project`; retain FFmpeg as an OS-level worker dependency rather than a Node wrapper.
- Create `src/config/storage.config.ts` with separate internal and browser-reachable S3 endpoints, region, bucket, credentials, presigned-URL TTL (15 minutes), multipart lifecycle retention (7 days), and HLS/download URL TTL values; use the Docker service name `minio` for the internal endpoint.
- Create `src/config/queue.config.ts` with `REDIS_HOST=redis`, port, video-processing concurrency `1`, and retry policy defaults of three attempts with exponential backoff; load both namespaces through `ConfigModule`.
- Extend `env.validation.ts` and `.env.example` with all storage and Redis values, requiring credentials and bucket names while documenting distinct `S3_INTERNAL_ENDPOINT` and `S3_PUBLIC_ENDPOINT` values for Docker versus browser access.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | Required storage/Redis variables reject invalid startup configuration and the Docker-service defaults resolve into the typed namespaces |

**Dependencies:** None

**Acceptance criteria:**

- The API refuses to start when required S3 credentials, bucket name, or Redis configuration are invalid or absent.
- Inside Docker, backend storage and queue connections resolve through `minio` and `redis`, never `localhost`.
- A presigned upload URL uses the configured browser-reachable storage endpoint and expires after 15 minutes; no S3 credential is returned by an API response.

---

### SI-03.2 — Local Media Runtime in Docker Compose

**Description:** Provision the local S3-compatible store, Redis, and isolated media processes so the API never executes FFmpeg work and the browser can upload multipart parts directly to MinIO.

**Technical actions:**

- Extend `nestjs-project/compose.yaml` with persistent `minio` and `redis` services, health checks, and named volumes; make API, relay, and worker dependencies use their Compose service names.
- Add an idempotent MinIO initialization service that creates the private media bucket, applies a lifecycle rule that aborts incomplete multipart uploads after seven days, and configures CORS only for configured frontend origins with `PUT`, required upload headers, and exposed `ETag`.
- Update the development image to include `ffmpeg` and `ffprobe`; add distinct `video-worker` and `outbox-relay` Compose services that run the same application image with dedicated commands, resource limits, and no HTTP port.
- Add package scripts and worker entrypoint placeholders for `start:video-worker` and `start:outbox-relay`, so the Compose commands are explicit and independently scalable.

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up` starts healthy PostgreSQL, Redis, MinIO, Nest API, outbox relay, and video worker services without the worker exposing an HTTP port.
- The media bucket is private, has the incomplete-multipart lifecycle rule, and accepts a browser preflight/`PUT` only from an allowlisted frontend origin while exposing `ETag`.
- The API process does not start a BullMQ processor or FFmpeg command; processing runs only in the `video-worker` service.

---

### SI-03.3 — Video, Upload Session, and Transactional Outbox Persistence

**Description:** Introduce the durable catalog state for an uploaded video, its resumable multipart session, and the transactional outbox record that guarantees processing is eventually dispatched.

**Technical actions:**

- Create `Video` in `src/videos/entities/` with an immutable, unique `public_id`; owning `channel_id` FK; original-object key and declared file metadata; processing state (`uploading`, `uploaded`, `processing`, `ready`, `failed`, `cancelled`); extracted metadata; duration; derivative keys; failure reason; and processing version.
- Create `UploadSession` with an opaque public session ID, one-to-one video FK, private S3 `upload_id`, stable object key, expected file size, part size, declared MIME type, client file fingerprint, state (`active`, `completed`, `cancelled`, `expired`), and expiry timestamps; keep the S3 upload ID out of client response DTOs.
- Create `OutboxEvent` with aggregate ID, event type, JSON payload, deduplication key, creation/dispatched timestamps, and dispatch-attempt fields; enforce uniqueness for the upload-completed event and processing version of one video.
- Create `VideosModule` with `TypeOrmModule.forFeature([Video, UploadSession, OutboxEvent])`, generate and review a migration, and register the module in `AppModule` without modifying auth/channel ownership boundaries.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique public ID, channel foreign-key integrity, processing-state enum/defaults, and metadata persistence |
| `src/videos/entities/upload-session.entity.integration-spec.ts` | Integration | One-to-one video relation, unique session ID, terminal-state fields, expiry fields, and non-null multipart metadata |
| `src/videos/entities/outbox-event.entity.integration-spec.ts` | Integration | Deduplication constraint and persisted dispatch audit fields |
| `src/videos/videos.module.spec.ts` | Unit | `VideosModule` compiles with its TypeORM providers |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Running migrations creates the video, upload-session, and outbox tables with their foreign keys, unique indexes, and processing-state constraints.
- Creating two videos with the same `public_id`, or two upload-completed outbox events for the same video version, fails with a database constraint violation.
- A multipart upload ID is persisted for server-side reconciliation but never appears in the public video or upload-session representation.

---

### SI-03.4 — S3-Compatible Multipart Storage Adapter

**Description:** Encapsulate all MinIO/S3 commands behind a backend storage module so upload orchestration and the worker operate on stable media keys rather than SDK details.

**Technical actions:**

- Create `StorageModule` and `S3MediaStorageService` using the configured internal client for server operations and a browser-endpoint signing client for presigned URLs; use `forcePathStyle` where required for local MinIO compatibility.
- Define private, immutable key conventions rooted at `videos/{publicId}/`: `original/`, `hls/{processingVersion}/`, and `thumbnails/{processingVersion}/`; never use an untrusted filename as an object key.
- Implement typed operations for multipart creation, batched `UploadPartCommand` URL signing, `ListParts`, ordered completion, abort, object-head verification, original/derived upload, object retrieval, and short-lived `GetObject` URL signing.
- Validate part numbers (1–10,000), upload ownership inputs, and returned ETags at the adapter boundary; convert recoverable S3/MinIO failures into domain-facing errors without logging credentials or presigned query strings.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/s3-media-storage.service.integration-spec.ts` | Integration | Real MinIO multipart initiate/list/complete/abort, ordered ETag completion, object-head verification, and presigned upload/download URL behavior |
| `src/storage/storage.module.spec.ts` | Unit | `StorageModule` compiles with the typed storage configuration |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- A multipart upload initiated by the adapter can be completed only with its ordered part-number/ETag pairs; `HeadObject` confirms the final object before it is reported as present.
- Retrying a failed part does not require retransmitting successful parts, and aborting a session removes its unfinished multipart state from MinIO.
- Backend-to-MinIO operations use the internal endpoint, while returned presigned URLs use the browser-reachable endpoint and contain no static access key in the response body.

---

### SI-03.5 — Authenticated Upload Control Plane

**Description:** Implement the video-upload API that creates a draft and multipart session, reconciles resumptions, completes or cancels the upload safely, and records the processing outbox event atomically.

**Technical actions:**

- Extend `ChannelsService` with the owner lookup needed to resolve the authenticated user’s channel, then create `UploadSessionsService` to authorize every operation against that channel and generate a 128-bit URL-safe `publicId` with unique-constraint retry.
- On `POST /videos/uploads`, validate declared size (positive and at most 10 GB) and video MIME metadata, create the video/session and S3 multipart upload with compensation on partial failure, and return only the public session metadata, part plan, and canonical `/v/{publicId}` URL.
- Implement owner-only session read and batched part-URL issuance; reconcile persisted browser state with `ListParts`, reject expired or terminal sessions, and expose only confirmed part numbers/ETags for client resumption.
- Implement owner-only completion and cancellation under a row lock: completion validates the ordered parts and `HeadObject`, then commits `uploaded` state plus one `video.upload.completed` outbox record; cancellation aborts storage and marks the session/video cancelled, while network interruption leaves the active session resumable until expiry.
- Create upload DTOs, domain exceptions, `VideosController` OpenAPI annotations, and authenticated endpoints; return `201` for initiation, `200` for status/part URLs, `202` for accepted completion, and `204` for successful cancellation.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/upload-sessions.service.spec.ts` | Unit | Ownership, size/state branches, public-ID collision retry, terminal-operation conflict, and outbox creation decisions |
| `src/videos/upload-sessions.service.integration-spec.ts` | Integration | Video/session persistence, row-locked completion, outbox atomicity, and cancellation/expiry transitions against PostgreSQL + MinIO |
| `src/channels/channels.service.integration-spec.ts` | Integration | Authenticated user-to-channel lookup used by the video boundary |
| `test/video-uploads.e2e-spec.ts` | E2E | Auth enforcement, DTO validation, create/status/part-URL/complete/cancel HTTP contracts and standardized error envelopes |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos/uploads` with an authenticated owner and a file at or below 10 GB returns 201 with a unique `public_id`, canonical `/v/{publicId}` URL, resumable session ID, and multipart part plan; an unauthenticated request returns 401.
- `POST /videos/uploads` with a declared size above 10 GB returns 413 with `UPLOAD_FILE_TOO_LARGE`; malformed input returns a 400 validation error.
- `GET /videos/uploads/{sessionId}` returns the storage-confirmed part list to its owner, allowing a resumed client to upload only missing parts; another user receives 403 `VIDEO_ACCESS_DENIED`.
- `POST /videos/uploads/{sessionId}/complete` with valid ordered ETags returns 202 and transitions the video to `uploaded` with exactly one pending `video.upload.completed` outbox event.
- Repeating completion or racing it with cancellation does not duplicate the outbox event; the request that observes a terminal session returns 409 `UPLOAD_SESSION_NOT_ACTIVE`.
- `DELETE /videos/uploads/{sessionId}` returns 204, aborts the unfinished multipart upload, and marks the video/session cancelled; an interrupted browser session remains resumable until its configured expiry.

---

### SI-03.6 — Transactional Outbox Relay and BullMQ Dispatch

**Description:** Deliver pending upload-completed events to BullMQ from a separate relay process, preserving at-least-once delivery while preventing duplicate active processing work.

**Technical actions:**

- Create `OutboxModule` and `OutboxRelayService`, configuring `BullModule.forRoot()` with the typed Redis connection and registering the `video-processing` queue.
- Add a dedicated `outbox-relay` application-context entrypoint that polls pending events in bounded batches using database row locking, so concurrent relay replicas do not claim the same event.
- Publish each `video.upload.completed` payload with `videoId`, original key, and processing version under a deterministic BullMQ job ID; mark the outbox row dispatched only after `queue.add()` succeeds.
- Record failed dispatch attempts for observability, leave failed rows eligible for retry, and retain completed jobs long enough for duplicate job-ID protection rather than relying on Redis as source of truth.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/outbox/outbox-relay.service.spec.ts` | Unit | Claim, publish, dispatch-marking, queue failure, and duplicate job-ID branches |
| `src/outbox/outbox-relay.service.integration-spec.ts` | Integration | PostgreSQL row locking and a real Redis queue deliver one processing job for one pending outbox record |
| `src/outbox/outbox.module.spec.ts` | Unit | `OutboxModule` compiles with BullMQ queue and configuration wiring |

**Dependencies:** SI-03.1, SI-03.3, SI-03.5

**Acceptance criteria:**

- Completing an upload eventually places one `video-processing` job containing the video ID, original key, and processing version on Redis, even when the relay is restarted after the database transaction commits.
- A queue outage leaves the outbox event undispatched and retryable; it is not lost or marked dispatched prematurely.
- Two relay instances cannot publish the same claimed outbox event concurrently, and redelivery uses the deterministic job ID rather than creating duplicate active work.

---

### SI-03.7 — Isolated FFmpeg Video Worker

**Description:** Consume processing jobs in the dedicated worker, derive metadata, adaptive HLS VOD assets and a thumbnail, and make media state transitions idempotent across retries.

**Technical actions:**

- Create `VideoWorkerModule` and a non-HTTP Nest application-context entrypoint that imports only the video, storage, queue, and configuration modules required by the worker; register a `@Processor('video-processing')` worker with configured concurrency `1`.
- Implement an idempotent processor that locks the video/version, ignores stale or already-ready jobs, changes `uploaded` to `processing`, downloads the private original to a job-specific temporary directory, and always removes temporary files.
- Invoke `ffprobe` to extract duration/container/stream metadata, then invoke FFmpeg to emit source-bounded H.264/AAC HLS VOD renditions (360p/720p, adding 1080p only when the source supports it), a master playlist, and a representative JPEG thumbnail.
- Upload all derivatives under the versioned keys, then atomically persist `ready`, duration, metadata, manifest key, thumbnail key, and processing completion time; remove partial derivative prefixes on failures.
- On each retry rethrow the failure for BullMQ; when the final configured attempt is exhausted, persist `failed` with a safe diagnostic message while preserving the original for later reprocessing support.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/video-processor.service.spec.ts` | Unit | Idempotent state/version branches, FFprobe/FFmpeg failure handling, and final-attempt failure state |
| `src/video-worker/video-processor.integration-spec.ts` | Integration | A small real media fixture in MinIO produces persisted duration/metadata, HLS playlist/segments, and thumbnail through the FFmpeg binary |
| `src/video-worker/video-worker.module.spec.ts` | Unit | Worker module compiles with BullMQ, storage, and video dependencies |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.6

**Acceptance criteria:**

- A dispatched upload changes from `uploaded` to `processing` and then `ready`, with stored duration, stream metadata, a master HLS manifest, at least one segment, and a generated thumbnail.
- Reprocessing the same video/version job leaves an already-ready video unchanged and does not create duplicate derivative records or a conflicting state transition.
- A transient processing failure is retried according to the configured backoff; after the final attempt, the video is `failed`, partial derivatives are removed, and the original remains private and retained.
- The HTTP API remains responsive while FFmpeg processes a video because the work runs only in the dedicated worker process.

---

### SI-03.8 — Owner-Authorized Media Delivery

**Description:** Expose small control-plane responses for private HLS playback, thumbnail access, and original-file download without proxying media bytes through NestJS or Next.js.

**Technical actions:**

- Create `MediaDeliveryService` that resolves a video by immutable `publicId`, verifies the authenticated owner’s channel, and rejects video states other than `ready` before issuing media access.
- Serve the HLS master playlist through a small authenticated manifest endpoint whose variant references remain same-origin; serve each variant playlist through a second authenticated endpoint that replaces every segment URI with a short-lived MinIO `GetObject` URL, so the browser retrieves only segment bytes directly from storage.
- Implement owner-only thumbnail and original-download endpoints as 302 redirects to short-lived signed object URLs, setting a safe `Content-Disposition` filename for download and never returning the private object key.
- Add media domain exceptions, `VideosController` OpenAPI annotations, and endpoint contracts for processing status, master/variant manifests, thumbnail redirect, and download redirect.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/media-delivery.service.spec.ts` | Unit | Ownership and ready-state branches, playlist URI rewriting, and redirect-signing decisions |
| `src/videos/media-delivery.service.integration-spec.ts` | Integration | Real MinIO playlists resolve to signed segment URLs while originals/thumbnails remain private |
| `test/video-media.e2e-spec.ts` | E2E | Owner-only status/playback/thumbnail/download contracts, 409 before readiness, and 302 media redirects |

**Dependencies:** SI-03.4, SI-03.5, SI-03.7

**Acceptance criteria:**

- `GET /videos/{publicId}/playback/master` by the owning user returns an HLS master manifest whose variants resolve through authenticated same-origin manifest routes, while each variant exposes short-lived direct-storage segment URLs.
- A browser can retrieve a playlist and its segments without any media byte passing through NestJS or Next.js; requests for a video that is not `ready` return 409 `VIDEO_NOT_READY`.
- `GET /videos/{publicId}/download` and `/thumbnail` return 302 to expiring URLs for the original and generated thumbnail respectively; neither response contains the private object key.
- A non-owner receives 403 `VIDEO_ACCESS_DENIED` for status, playback, thumbnail, and download endpoints; public/unlisted access remains deferred to the Phase 04 visibility model.

---

### SI-03.9 — OpenAPI, Frontend Contracts, and Media-Test Boundary

**Description:** Publish the new backend wire contracts to the strict BFF, generate frontend types, and formally document the narrow direct-MinIO exception required by multipart upload and HLS segments.

**Technical actions:**

- Complete Swagger decorators for every Phase 03 request, response, redirect, and domain-error contract; run the established backend export, copy the generated `openapi.json` into `next-frontend/`, and regenerate `lib/api/types.gen.ts`.
- Extend `next-frontend/lib/api/contracts.ts` with named aliases for upload-session requests/responses, part URL batches, upload status, processing status, and media manifest responses; do not allow components or Route Handlers to import `paths` directly.
- Add typed `mocks/handlers/videos.ts` handlers and factories for all NestJS video control-plane endpoints used by BFF route-handler integration tests, then register the domain handler through the existing barrel.
- Update `next-frontend/CLAUDE.md` and its media-test guidance to record the TD-02 exception: browser code may call only presigned MinIO upload/segment URLs, while every video control-plane call remains same-origin BFF; the full multipart/CORS browser test uses the local Compose stack rather than browser request interception.

**Dependencies:** SI-03.5, SI-03.8

**Acceptance criteria:**

- The exported OpenAPI document describes every Phase 03 backend endpoint and regeneration leaves `next-frontend/openapi.json` and `lib/api/types.gen.ts` fresh.
- TypeScript rejects a frontend consumer that bypasses `lib/api/contracts.ts` for a Phase 03 video wire shape.
- MSW covers every upstream endpoint invoked by the Phase 03 BFF handlers; an unhandled upstream request fails the Vitest suite.
- The frontend documentation explicitly limits browser-to-storage traffic to presigned URLs and retains the strict BFF boundary for NestJS calls.

---

### SI-03.10 — Upload Control-Plane BFF Route Handlers

**Description:** Add same-origin BFF handlers for every authenticated upload control-plane operation while retaining token custody in the encrypted iron-session cookie.

**Technical actions:**

- Create a shared server-only authenticated-upstream helper that reads the iron-session, adds the access-token header, uses the existing single-flight refresh behavior on 401, and returns a uniform 401 response after a failed refresh.
- Implement `POST /api/videos/uploads`, `GET`/`DELETE /api/videos/uploads/{sessionId}`, `POST /api/videos/uploads/{sessionId}/part-urls`, and `POST /api/videos/uploads/{sessionId}/complete` as typed Route Handlers that proxy JSON control-plane traffic only.
- Implement `GET /api/videos/{publicId}/upload-status` for the uploader’s processing poll, forwarding backend status/error envelopes without exposing access tokens, private object keys, or the internal S3 upload ID.
- Preserve upstream status semantics (`201`, `200`, `202`, `204`, and domain errors) and make all control-plane Route Handlers reject a missing local session before attempting an upstream request.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `app/api/videos/uploads/__tests__/route.integration.test.ts` | Integration (MSW) | Start request forwarding, 201 response projection, 413/validation errors, and missing-session rejection |
| `app/api/videos/uploads/[sessionId]/__tests__/route.integration.test.ts` | Integration (MSW) | Session-status forwarding and idempotent cancellation response mapping |
| `app/api/videos/uploads/[sessionId]/part-urls/__tests__/route.integration.test.ts` | Integration (MSW) | Batched part-number forwarding, signed-URL response projection, and ownership errors |
| `app/api/videos/uploads/[sessionId]/complete/__tests__/route.integration.test.ts` | Integration (MSW) | Ordered ETag completion forwarding, 202 mapping, and terminal-session conflict mapping |
| `app/api/videos/[publicId]/upload-status/__tests__/route.integration.test.ts` | Integration (MSW) | Authenticated processing-status polling and refresh/failure behavior |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- An authenticated browser can create, inspect, request URLs for, complete, and cancel an upload only through same-origin `/api/videos/**` endpoints; the BFF forwards the access token server-side only.
- A BFF response never serializes the access token, refresh token, private S3 upload ID, or static storage credential to the browser.
- An upstream 401 triggers one transparent refresh for concurrent BFF requests; an unsuccessful refresh destroys the local session and returns 401.
- A BFF route preserves the upstream 202 completion response and standardized 4xx domain-error envelope without inventing a success-message wrapper.

---

### SI-03.11 — Resumable Upload Client and Upload Workspace

**Description:** Provide the authenticated `/studio/upload` workspace and client-side multipart state machine that persists resumable progress in IndexedDB and transfers bytes directly to presigned MinIO URLs.

**Technical actions:**

- Install `idb@^8.x` and the test-only `fake-indexeddb@^6.x`; create a typed browser upload-state store keyed by BFF session ID and a file fingerprint built from name, size, MIME type, and last-modified timestamp.
- Create a client-side multipart coordinator that calls only same-origin BFF control-plane routes, requests part URLs in bounded batches, uploads missing `Blob` slices with browser `fetch`, records the returned `ETag` after each success, retries only failed parts, and limits active part requests to three.
- Reconcile a selected file’s persisted state with the BFF-confirmed `ListParts` status before resuming; expired, cancelled, changed, or fingerprint-mismatched sessions must not reuse old ETags or upload URLs.
- Create `app/(studio)/studio/upload/page.tsx` and a `VideoUploader` Client Component with file selection, start/resume/cancel controls, accessible byte/part progress, processing polling, terminal failure feedback, and the canonical video URL once processing is ready; a full playback UI remains Phase 05 scope.
- Add the narrow media E2E mode that runs this flow against the real local NestJS/MinIO Compose stack to verify direct-browser multipart and CORS without `page.route()` interception.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `lib/uploads/__tests__/upload-state.test.ts` | Unit | File fingerprinting, missing-part planning, bounded-concurrency state transitions, and terminal-session invalidation |
| `lib/uploads/__tests__/resume-store.test.ts` | Unit | IndexedDB save/load/clear behavior and rejection of a changed-file fingerprint |
| `components/videos/__tests__/video-uploader.test.tsx` | Unit | File selection, visible progress/status branches, resume/cancel interactions, and user-visible errors |
| `tests/video-upload.e2e-spec.ts` | E2E | Real Compose upload of a small fixture through presigned MinIO URLs, browser CORS/ETag visibility, resume after an interrupted part, completion, and processing status |

**Dependencies:** SI-03.2, SI-03.10

**Acceptance criteria:**

- Selecting a supported file in `/studio/upload` starts a BFF-negotiated multipart upload whose file bytes travel from the browser directly to the presigned MinIO URLs, never through Next.js or NestJS.
- Interrupting a part upload and selecting the same file again resumes from confirmed storage parts; completed parts are not transmitted again and expired signatures are replaced through the BFF.
- The upload workspace visibly reports uploading, processing, ready, failed, and cancelled outcomes; cancelling an active upload prevents further part transfer and reports the server-confirmed cancellation.
- Browser-based upload verification succeeds against the local MinIO emulator with an allowlisted origin and readable `ETag`; it does not use Playwright request interception or a public backend URL.

---

### SI-03.12 — Media BFF Route Handlers

**Description:** Expose owner-authorized playback manifests, thumbnails, and downloads through same-origin BFF routes, leaving only signed media objects as direct browser-to-storage traffic.

**Technical actions:**

- Implement `GET /api/videos/{publicId}/playback/master` and `GET /api/videos/{publicId}/playback/{rendition}` Route Handlers that use the authenticated upstream helper and preserve the HLS content type, manifest body, and no-store cache semantics.
- Implement `GET /api/videos/{publicId}/thumbnail` and `/download` handlers that forward the upstream 302 response and `Location` header unchanged, without reading, buffering, or proxying the object body.
- Return upstream `403`/`409` error envelopes consistently, and make all media routes session-gated so temporary object URLs are never issued to an unauthenticated browser.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `app/api/videos/[publicId]/playback/master/__tests__/route.integration.test.ts` | Integration (MSW) | Authenticated master-manifest forwarding, content type, and not-ready/ownership error mapping |
| `app/api/videos/[publicId]/playback/[rendition]/__tests__/route.integration.test.ts` | Integration (MSW) | Variant-manifest forwarding with signed segment URIs preserved |
| `app/api/videos/[publicId]/thumbnail/__tests__/route.integration.test.ts` | Integration (MSW) | 302 thumbnail redirect forwarding and session rejection |
| `app/api/videos/[publicId]/download/__tests__/route.integration.test.ts` | Integration (MSW) | 302 original-download forwarding and no media-body buffering |

**Dependencies:** SI-03.9, SI-03.10

**Acceptance criteria:**

- An authenticated owner receives HLS playlists through same-origin BFF routes; segment requests then target only short-lived signed MinIO URLs.
- Download and thumbnail requests return the upstream 302 location without proxying the original or image bytes through the BFF.
- Missing session, non-owner access, and not-ready media are observable as 401, 403 `VIDEO_ACCESS_DENIED`, and 409 `VIDEO_NOT_READY` respectively.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier |
| public_id | varchar(22) | unique, not null | 128-bit URL-safe opaque identifier used in `/v/{publicId}` |
| channel_id | uuid | FK → channels.id, not null | Owner channel |
| original_key | text | unique, not null | Private, immutable object-store key |
| original_filename | varchar(255) | not null | Display/download metadata; never used as object key |
| declared_content_type | varchar(127) | not null | Browser-declared `video/*` type; worker verifies actual media |
| declared_size_bytes | bigint | not null, check `> 0` and `<= 10737418240` | Ten-gigabyte upload ceiling |
| processing_status | enum | not null, default `uploading` | `uploading`, `uploaded`, `processing`, `ready`, `failed`, `cancelled` |
| processing_version | integer | not null, default `1` | Included in outbox/job/derivative keys |
| duration_seconds | numeric | nullable | Set by FFprobe when ready |
| media_metadata | jsonb | nullable | Container, streams, dimensions, codecs, and bitrate |
| hls_master_key | text | nullable | Private versioned HLS master-manifest key |
| thumbnail_key | text | nullable | Private generated JPEG key |
| processing_error | text | nullable | Safe terminal diagnostic; no command line or credential data |
| processed_at | timestamp | nullable | Set when processing reaches `ready` |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one; `channel_id` owns the FK), Video → UploadSession (one-to-one), Video → OutboxEvent (one-to-many)

**Indexes:** `(public_id)` — unique; `(channel_id, processing_status)` — owner-status lookup; `(processing_status, updated_at)` — operational/reconciliation lookup

---

#### UploadSession

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Opaque BFF-visible session identifier |
| video_id | uuid | FK → videos.id, unique, not null | One multipart attempt for the newly created video |
| s3_upload_id | text | unique, not null, server-only | Native S3/MinIO multipart identifier; never exposed to browser DTOs |
| object_key | text | unique, not null | Same stable private original key as the video |
| file_fingerprint | varchar(512) | not null | Client-provided name/size/MIME/last-modified fingerprint for resume matching |
| expected_size_bytes | bigint | not null, check `> 0` and `<= 10737418240` | Declared original size |
| part_size_bytes | integer | not null, default `16777216` | 16 MiB; satisfies S3 non-final-part limits |
| declared_content_type | varchar(127) | not null | |
| state | enum | not null, default `active` | `active`, `completed`, `cancelled`, `expired` |
| expires_at | timestamp | not null | Seven-day lifecycle horizon |
| completed_at | timestamp | nullable | Set only after S3 completion and `HeadObject` verification |
| cancelled_at | timestamp | nullable | Set after explicit abort succeeds |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** UploadSession → Video (one-to-one, owning side via `video_id`)

**Indexes:** `(video_id)` — unique; `(s3_upload_id)` — unique; `(state, expires_at)` — expiration/reconciliation lookup

---

#### OutboxEvent

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| aggregate_id | uuid | FK → videos.id, not null | Video whose state transitioned |
| aggregate_version | integer | not null | Video processing version |
| event_type | varchar(100) | not null | Initially `video.upload.completed` |
| deduplication_key | varchar(180) | unique, not null | `video.upload.completed:{videoId}:{version}` |
| payload | jsonb | not null | `{ videoId, originalKey, processingVersion }` |
| dispatch_attempts | integer | not null, default `0` | Incremented for each relay attempt |
| dispatched_at | timestamp | nullable | Set after Redis accepts the job |
| last_error | text | nullable | Safe relay error summary |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** OutboxEvent → Video (many-to-one; `aggregate_id` owns the FK)

**Indexes:** `(deduplication_key)` — unique; `(dispatched_at, created_at)` — relay pending-batch lookup; `(aggregate_id, aggregate_version)` — event audit lookup

---

### API Contracts

#### POST /videos/uploads (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 characters
- content_type: string, required — must begin with `video/`
- size_bytes: integer, required — positive and at most `10,737,418,240`
- file_fingerprint: string, required — 1–512 characters; identifies the selected browser file for resume safety

**Response 201:**
- video_id: string (uuid)
- public_id: string
- canonical_url: string — `/v/{public_id}`
- upload_session_id: string (uuid)
- state: `active`
- part_size_bytes: integer — `16,777,216`
- expires_at: string (ISO 8601)

**Error responses:**
- 401: missing or invalid access token
- 413 UPLOAD_FILE_TOO_LARGE: declared size exceeds 10 GB
- 415 UNSUPPORTED_MEDIA_TYPE: declared content type is not `video/*`
- 400 validation error: malformed request body

---

#### GET /videos/uploads/{sessionId} (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- video_id: string (uuid)
- public_id: string
- state: `active` | `completed` | `cancelled` | `expired`
- processing_status: Video processing state
- part_size_bytes: integer
- expected_size_bytes: integer
- expires_at: string (ISO 8601)
- uploaded_parts: array of `{ part_number: integer, etag: string }` — source of truth reconciled from S3/MinIO

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: session does not belong to the authenticated owner
- 404 UPLOAD_SESSION_NOT_FOUND: no session matches the opaque ID

---

#### POST /videos/uploads/{sessionId}/part-urls (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: integer array, required — 1–100 unique values, each in range `1..10,000`

**Response 200:**
- parts: array of `{ part_number: integer, url: string, expires_at: string (ISO 8601) }`

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: session does not belong to the authenticated owner
- 404 UPLOAD_SESSION_NOT_FOUND: no session matches the opaque ID
- 409 UPLOAD_SESSION_NOT_ACTIVE: session is completed, cancelled, or expired
- 400 validation error: invalid part-number batch

---

#### POST /videos/uploads/{sessionId}/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: array, required — strictly ordered by `part_number`, with `{ part_number: integer, etag: string }` for every uploaded part

**Response 202:**
- public_id: string
- processing_status: `uploaded`
- processing_version: integer

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: session does not belong to the authenticated owner
- 404 UPLOAD_SESSION_NOT_FOUND: no session matches the opaque ID
- 409 UPLOAD_SESSION_NOT_ACTIVE: session already reached a terminal state
- 422 INVALID_UPLOAD_PARTS: part list does not match confirmed S3/MinIO parts or final-object verification fails
- 400 validation error: malformed or unordered parts list

---

#### DELETE /videos/uploads/{sessionId} (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 204:** No content.

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: session does not belong to the authenticated owner
- 404 UPLOAD_SESSION_NOT_FOUND: no session matches the opaque ID
- 409 UPLOAD_SESSION_NOT_ACTIVE: session was already completed, cancelled, or expired

---

#### GET /videos/{publicId}/upload-status (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- public_id: string
- canonical_url: string
- processing_status: `uploading` | `uploaded` | `processing` | `ready` | `failed` | `cancelled`
- duration_seconds: number, nullable
- processing_error: string, nullable — safe only
- thumbnail_available: boolean
- playback_available: boolean

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: video does not belong to the authenticated owner
- 404 VIDEO_NOT_FOUND: no video matches the public ID

---

#### GET /videos/{publicId}/playback/master (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:** HLS master-manifest body with `Content-Type: application/vnd.apple.mpegurl` and `Cache-Control: no-store`; variant URIs remain same-origin manifest routes.

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: video does not belong to the authenticated owner
- 404 VIDEO_NOT_FOUND: no video matches the public ID
- 409 VIDEO_NOT_READY: video processing has not completed successfully

---

#### GET /videos/{publicId}/playback/{rendition} (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:** HLS media-playlist body with `Content-Type: application/vnd.apple.mpegurl` and `Cache-Control: no-store`; every media segment URI is a short-lived presigned object-storage URL.

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: video does not belong to the authenticated owner
- 404 VIDEO_NOT_FOUND: no video/rendition matches the request
- 409 VIDEO_NOT_READY: video processing has not completed successfully

---

#### GET /videos/{publicId}/thumbnail (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 302:** No body.

**Response headers:**
- Location: short-lived presigned JPEG URL

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: video does not belong to the authenticated owner
- 404 VIDEO_NOT_FOUND: no video matches the public ID
- 409 VIDEO_NOT_READY: thumbnail does not exist yet

---

#### GET /videos/{publicId}/download (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 302:** No body.

**Response headers:**
- Location: short-lived presigned original-file URL with attachment disposition

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: video does not belong to the authenticated owner
- 404 VIDEO_NOT_FOUND: no video matches the public ID
- 409 VIDEO_NOT_READY: original is not available for download yet

---

#### BFF tier — `/api/videos/**` (SI-03.10, SI-03.12)

| Browser endpoint | Forwards to NestJS | BFF behavior |
|---|---|---|
| POST `/api/videos/uploads` | POST `/videos/uploads` | Adds the server-held bearer token; returns the upload-session representation |
| GET/DELETE `/api/videos/uploads/{sessionId}` | GET/DELETE `/videos/uploads/{sessionId}` | Adds the server-held bearer token; forwards status or empty 204 |
| POST `/api/videos/uploads/{sessionId}/part-urls` | POST `/videos/uploads/{sessionId}/part-urls` | Returns only transient part URLs; never credentials or S3 upload ID |
| POST `/api/videos/uploads/{sessionId}/complete` | POST `/videos/uploads/{sessionId}/complete` | Preserves 202 accepted response |
| GET `/api/videos/{publicId}/upload-status` | GET `/videos/{publicId}/upload-status` | Provides uploader polling state |
| GET `/api/videos/{publicId}/playback/master` | GET `/videos/{publicId}/playback/master` | Preserves small HLS manifest body and content type |
| GET `/api/videos/{publicId}/playback/{rendition}` | GET `/videos/{publicId}/playback/{rendition}` | Preserves rewritten playlist; browser fetches only its signed segments directly |
| GET `/api/videos/{publicId}/thumbnail` and `/download` | Corresponding media endpoints | Preserves upstream 302 and `Location` without buffering bytes |

The only browser requests that are not same-origin BFF calls are the temporary part `PUT`s and HLS-segment `GET`s represented by signed URLs. They target the object-storage endpoint directly and are never NestJS API calls.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Role |
|----------|--------|---------------|------|
| POST /videos/uploads | | ✓ | Owner channel resolved from JWT |
| GET /videos/uploads/{sessionId} | | ✓ | Owner of session video |
| POST /videos/uploads/{sessionId}/part-urls | | ✓ | Owner of session video |
| POST /videos/uploads/{sessionId}/complete | | ✓ | Owner of session video |
| DELETE /videos/uploads/{sessionId} | | ✓ | Owner of session video |
| GET /videos/{publicId}/upload-status | | ✓ | Owner of video |
| GET /videos/{publicId}/playback/master | | ✓ | Owner of video; public/unlisted deferred to Phase 04 |
| GET /videos/{publicId}/playback/{rendition} | | ✓ | Owner of video; public/unlisted deferred to Phase 04 |
| GET /videos/{publicId}/thumbnail | | ✓ | Owner of video; public/unlisted deferred to Phase 04 |
| GET /videos/{publicId}/download | | ✓ | Owner of video; public/unlisted deferred to Phase 04 |

---

### Error Catalog

This phase inherits the nestjs-project error response shape from Phase 02:

```
{ statusCode: number, error: string, message: string }
```

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| UPLOAD_FILE_TOO_LARGE | 413 | File exceeds the 10 GB upload limit | POST /videos/uploads with `size_bytes` above 10 GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | Only video media types are accepted | POST /videos/uploads with a `content_type` outside `video/*` |
| UPLOAD_SESSION_NOT_FOUND | 404 | Upload session not found | Any upload-session endpoint with an unknown opaque session ID |
| UPLOAD_SESSION_NOT_ACTIVE | 409 | Upload session is no longer active | Part URL, completion, or cancellation request after completed, cancelled, or expired state |
| INVALID_UPLOAD_PARTS | 422 | Upload parts do not match the storage session | Completion parts are unordered, incomplete, or have ETags that differ from S3/MinIO state |
| VIDEO_NOT_FOUND | 404 | Video not found | Status or media request with an unknown public ID |
| VIDEO_ACCESS_DENIED | 403 | You do not have access to this video | Authenticated user does not own the target video/session in Phase 03 |
| VIDEO_NOT_READY | 409 | Video processing is not complete | Playback, thumbnail, or download requested before the video reaches `ready` |

---

### Events/Messages

| Event | Payload | Publisher | Consumer | Delivery |
|-------|---------|-----------|----------|----------|
| `video.upload.completed` | `{ videoId: string, originalKey: string, processingVersion: number }` | `UploadSessionsService` (Outbox) | `OutboxRelayService` | at-least-once / ack-required (DB transactional outbox) |
| `video-processing` | `{ videoId: string, originalKey: string, processingVersion: number }` | `OutboxRelayService` (BullMQ Queue) | `VideoProcessorService` (`video-worker`) | at-least-once / ack-required (BullMQ retries with backoff) |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   └── SI-03.4
└── SI-03.3

SI-03.3 + SI-03.4
└── SI-03.5
    ├── SI-03.6 (also deps SI-03.1, SI-03.3)
    └── SI-03.8 (also deps SI-03.4, SI-03.7)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.6
└── SI-03.7
    └── SI-03.8

SI-03.5 + SI-03.8
└── SI-03.9
    ├── SI-03.10
    │   ├── SI-03.11 (also deps SI-03.2)
    │   └── SI-03.12
```

**Linearized implementation order:**
1. **Infrastructure & Config:** SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4
2. **Backend Control Plane:** SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8
3. **Contracts & BFF:** SI-03.9 → SI-03.10, SI-03.12 (parallel)
4. **Client & UI:** SI-03.11

---

## Deliverables

- [ ] S3/MinIO and BullMQ/Redis configuration namespaces with validation in `nestjs-project`
- [ ] Local Docker Compose stack with MinIO (media bucket, CORS, 7-day multipart lifecycle), Redis, `video-worker`, and `outbox-relay` services
- [ ] TypeORM entities and migration for `Video`, `UploadSession`, and `OutboxEvent` with unique constraints and state transitions
- [ ] S3/MinIO multipart storage adapter with presigned URL generation, part listing, ordered completion, abort, and `HeadObject` verification
- [ ] Authenticated upload control plane (`POST /videos/uploads`, `GET/DELETE /videos/uploads/{sessionId}`, `POST .../part-urls`, `POST .../complete`, `GET /videos/{publicId}/upload-status`)
- [ ] Transactional outbox relay polling pending events with database row locking and dispatching to BullMQ
- [ ] Isolated FFmpeg video worker consuming jobs, extracting metadata with `ffprobe`, generating HLS VOD renditions (360p, 720p, 1080p) and thumbnails with `ffmpeg`
- [ ] Owner-authorized media delivery endpoints for HLS master/variant playlists, thumbnail redirect (302), and original file download redirect (302)
- [ ] Exported backend OpenAPI document and regenerated typed contracts (`openapi.json`, `types.gen.ts`, `contracts.ts`, MSW handlers)
- [ ] Next.js BFF Route Handlers for upload session lifecycle, part URLs, completion, status polling, playback playlists, thumbnail, and download
- [ ] Resumable upload client with IndexedDB state persistence, bounded concurrency (max 3 parts), fingerprint validation, and `/studio/upload` UI workspace
- [ ] All backend SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] All backend E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Backend Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Backend project builds successfully (`docker compose exec nestjs-api npm run build`)
- [ ] All frontend tests pass (`docker compose exec next-frontend npm test`)
- [ ] Frontend Type/compilation check passes (`docker compose exec next-frontend npx tsc --noEmit`)
- [ ] Frontend project builds successfully (`docker compose exec next-frontend npm run build`)

