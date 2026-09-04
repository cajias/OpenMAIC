# Document ingestion and the material library

Five routes that turn bytes into text: `extract-document` (the current path),
`parse-pdf` (the legacy path it superseded), `transcription` (ASR), and the two
`materials` routes that hold an owner's durable upload library.

They split cleanly on identity: `materials/**` is owner-scoped and
runtime-gated; the other three are unauthenticated beyond the access-code
middleware and treat the caller's credentials as request data.

**Sources:** `app/api/extract-document/route.ts` (659 lines),
`app/api/parse-pdf/route.ts`, `app/api/transcription/route.ts`,
`app/api/materials/route.ts` (416 lines), `app/api/materials/[id]/route.ts`,
`lib/constants/generation.ts`, `lib/server/agent-runtime/config.ts`,
`lib/workbench/material-upload-policy.ts`,
`lib/persistence/resolve-server-asset.ts`; evidence
[`../appendix/research/api-surface/01b-modules-routes-a-to-e.md`](../appendix/research/api-surface/01b-modules-routes-a-to-e.md),
[`../appendix/research/generation-pipeline/`](../appendix/research/generation-pipeline/00-overview.md).

## The group

```mermaid
flowchart TD
  UP["Upload UI / generation-preview"]
  WB["Workbench composer"]

  subgraph Ex["Unauthenticated extraction — credentials are request data"]
    ED["POST /api/extract-document<br/>runtime=nodejs, 2 request forms"]
    PP["POST /api/parse-pdf<br/>legacy multipart, no size cap"]
    TR["POST /api/transcription<br/>multipart, no size cap, maxDuration 60"]
  end
  subgraph Mat["Owner-scoped library — runtime=nodejs + isAgentRuntimeConfigured"]
    ML["GET /api/materials?sessionId=&limit=&before="]
    MU["POST /api/materials — raw body upload"]
    MI["GET /api/materials/:id?sessionId="]
  end

  RSA["resolveServerAsset(assetId, req.headers, cap)"]
  DR["lib/document: selectDocumentExtractorProvider<br/>getDocumentExtractorProvider / getMediaExtractorProvider"]
  DPr["5 document extractors:<br/>unpdf, mineru self-hosted, mineru-cloud,<br/>alidocmind, plain-text"]
  MPr["2 media extractors:<br/>alidocmind cloud, local-ffmpeg + ASR"]
  ASR["lib/audio/asr-providers.ts<br/>transcribeAudio (6 backends)"]
  SS["validateUrlForSSRF — production only on these routes"]
  PG[("owner_materials + session_materials<br/>plus the material byte store")]

  UP --> ED
  UP --> PP
  UP --> TR
  WB --> MU
  WB --> ML
  WB --> MI

  ED --> RSA --> PG
  ED --> DR
  PP --> DR
  DR --> DPr
  DR --> MPr
  MPr --> ASR
  TR --> ASR
  ED --> SS
  PP --> SS
  TR --> SS
  MU --> PG
  ML --> PG
  MI --> PG
```

## `POST /api/extract-document`

`runtime = 'nodejs'` (`:31`) because the asset-id form reads from PostgreSQL. No
`maxDuration`. Two request forms, discriminated on `content-type` (`:451`,
`:497`); anything else is a 400 that **echoes the received content type**
(`:625-631`).

### Multipart form (`multipart/form-data`)

| Field | Type | Notes |
| --- | --- | --- |
| `file` or `pdf` | File | `pdf` is the legacy name; either is accepted (`:456`) |
| `providerId` | string | optional; `undefined` means auto-select by registry order |
| `apiKey`, `baseUrl` | string | ignored when the provider is server-managed |
| `accessKeyId`, `accessKeySecret` | string | AliDocMind AK/SK |

Checks, in order: file present → `400 MISSING_REQUIRED_FIELD`;
`normalizeDocumentMimeType({mimeType, fileName})` must resolve → `400` naming
the file (`:474-480`); `size <= MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES`
(50 MiB, `lib/constants/generation.ts:16`) → `413` (`:481-489`). The route's
comment states this form's observable behaviour is frozen for backward
compatibility (`:442-444`).

### JSON asset-id form (`application/json`)

Body `AssetIdExtractRequest`: `assetId` plus the seven optional strings in
`ASSET_ID_EXTRACT_STRING_FIELDS` (`fileName`, `mimeType`, `providerId`,
`apiKey`, `baseUrl`, `accessKeyId`, `accessKeySecret`, `:64-73`).

| Failure | Status / code |
| --- | --- |
| unparseable JSON | `400 INVALID_REQUEST 'Invalid JSON body for asset-id extraction.'` |
| body is `null`, an array, or a scalar | `400 INVALID_REQUEST` — generic, checked before any field access (`:514-516`) |
| `assetId` missing or not a non-empty string | `400 MISSING_REQUIRED_FIELD` |
| any of the seven fields present but not a string | `400 INVALID_REQUEST` — **generic; the offending value is never echoed** (`:524-529`) |
| `resolveServerAsset` throws | `500 INTERNAL_ERROR` with a fixed message; the real error is logged only (`:538-548`) |
| `resolution.status === 'unconfigured'` | `503 INVALID_REQUEST` |
| `'unauthenticated'` | `401 UNAUTHENTICATED` |
| `'missing'` | `404 ASSET_NOT_FOUND` |
| `'too_large'` | `413 INVALID_REQUEST` — the recorded length exceeded the cap **before** any bytes were materialised (`:570-580`) |

### Shared extraction (`runExtraction`, `:219-438`)

```mermaid
flowchart TD
  A["runExtraction(source, requestConfig, logState, isAssetIdForm)"] --> B{"mimeType in<br/>SUPPORTED_MEDIA_MIME_TYPES?"}
  B -- yes --> M1{"explicit providerId that is not<br/>media-capable for this mime?"}
  M1 -- yes --> M2["400 INVALID_REQUEST naming the provider"]
  M1 -- no --> M3["managed = providerId != local-ffmpeg<br/>AND alidocmind is server-configured"]
  M3 --> M4{"client baseUrl AND<br/>NODE_ENV === production?"}
  M4 -- yes --> M5["validateUrlForSSRF, 403 INVALID_URL on failure"]
  M4 -- no --> M6["extractMedia(...)"]
  M5 --> M6
  M6 --> M7{"mediaArtifactToText is blank?"}
  M7 -- yes --> M8["422 PARSE_FAILED"]
  M7 -- no --> M9["200 {success:true, data: ParsedPdfContent}<br/>images: [], pageCount: 0"]

  B -- no --> D1{"explicit providerId unknown?"}
  D1 -- yes --> D2["400 'Unknown document extractor provider: X'"]
  D1 -- no --> D3["drop the provider if it<br/>does not support the mime"]
  D3 --> D4["selectDocumentExtractorProvider<br/>by registry order"]
  D4 -- throws --> D5["400: interpolated message on multipart,<br/>static message on the JSON form"]
  D4 --> D6{"self-hosted MinerU selected<br/>but no base URL?"}
  D6 -- "cloud available AND<br/>ALLOW_MINERU_CLOUD_FALLBACK" --> D7["switch to mineru-cloud"]
  D6 -- otherwise --> D8["422 INVALID_REQUEST naming what<br/>was configured and what was missing"]
  D7 --> D9["SSRF check, production only"]
  D6 -- no --> D9
  D9 --> D10["provider.extract(...)"]
  D10 --> D11["200 {success:true, data: ParsedPdfContent}"]
```

Two deliberate asymmetries between the forms, both documented in the code:

- **Error text.** The JSON form never echoes caller-controlled input. Its
  catch-all returns a fixed `500 PARSE_FAILED 'The course material could not be
  parsed. Please try again later.'`; multipart still returns `error.message`
  (`:642-652`). Same for the registry-selection 400 (`:341-349`) and the blank
  media artifact 422 (`:292-300`).
- **Provider pre-validation.** `validateJsonPathProvider(providerId, mimeType)`
  pre-blocks an unknown or media-incompatible provider on the JSON form with a
  static message, so the shared path's echoing 400s are unreachable from it
  (`:600-601`).

`sanitizeLogValue` strips `\r` and `\n` from caller-controlled log values
(`:657-659`). This is the only log-injection defence in the whole HTTP surface.

**A self-hosted extractor never silently becomes a cloud one.** The MinerU
Cloud fallback requires the explicit operator opt-in
`ALLOW_MINERU_CLOUD_FALLBACK`, default off; otherwise the request fails loudly
with a 422 naming exactly what to configure (`:364-384`).

## `POST /api/parse-pdf` — the legacy path

| Property | Value |
| --- | --- |
| Runtime | default, no `maxDuration` |
| Content type | must include `multipart/form-data`, checked on the header (`:20-27`) |
| Fields | `pdf` (required), `providerId`, `apiKey`, `baseUrl` |
| Provider default | `'unpdf'` when the client omits it (`:40`) |
| Managed providers | client `apiKey`/`baseUrl` discarded (`:45-46`) |
| SSRF | `validateUrlForSSRF(clientBaseUrl)` **only when `NODE_ENV === 'production'`** (`:47-52`) |
| Size cap | **none** — the whole file is buffered with `arrayBuffer()` (`:61-62`) |
| Hardcoded mime | `'application/pdf'` regardless of the uploaded type (`:69`) |
| Success | `200 {success:true, data: ParsedPdfContent}` with `fileName`/`fileSize` merged into metadata |
| Errors | `400 INVALID_REQUEST`, `400 MISSING_REQUIRED_FIELD`, `403 INVALID_URL`, `500 PARSE_FAILED` with the raw message |

Prefer `extract-document` for anything new: it supports non-PDF documents and
media, caps the upload, and has the asset-id form.

## `POST /api/transcription`

`maxDuration = 60`, runtime default. `multipart/form-data` with fields `audio`
(required), `providerId`, `modelId`, `language`, `apiKey`, `baseUrl`
(`:23-32`).

Gate ladder, in order:

1. `audio` present → else `400 MISSING_REQUIRED_FIELD` (`:34-36`).
2. `providerId || resolveServerASRProviderId()`; neither → `400 MISSING_PROVIDER
   'No enabled ASR provider is configured'` (`:40-44`). The comment is explicit:
   never guess a vendor.
3. `isServerProviderDisabled('asr', id)` → `403 PROVIDER_DISABLED` — server
   precedence over any client key (`:50-52`).
4. `isServerConfiguredProvider('asr', id)` → managed, so the client
   `apiKey`/`baseUrl` are dropped (`:55-56`).
5. Client base URL SSRF-checked **only in production** (`:57-62`).
6. `resolveASRModel(id, modelId)` — an allowlisted client model wins, otherwise
   the first server-pinned entry (`:70`).

Success `200 {success:true, text}`. Failure
`500 TRANSCRIPTION_FAILED 'Transcription failed'` with the raw message in
`details` (`:87-93`). **No size cap on this route either.**

## `materials` — the owner's durable library

| Route | Method | Request | Success | Errors |
| --- | --- | --- | --- | --- |
| `/api/materials` | GET | `?sessionId=` (required), `?limit=` 1…200, `?before=` keyset cursor | `200 {materials:[…]}` newest first (`:134-138`) | `400 MISSING_REQUIRED_FIELD`; `400 INVALID_REQUEST 'limit must be an integer between 1 and 200'`; 404 plain text |
| `/api/materials` | POST | **raw body**; `content-type` is the MIME type; `x-material-filename` is the display name; `x-request-id` optional | `201 {materialId, originalName, bytes, mime, extraction}` (`:353-362`) | see below |
| `/api/materials/[id]` | GET | `?sessionId=` (required) | `200 {material: <publicMaterialView>}` (`:42`) | `400 MISSING_REQUIRED_FIELD`; 404 plain text |

`POST` is deliberately **not** multipart. Every response — success, rejection,
and the catch-all 500 — carries `x-request-id` (`:363`, `:166`, `:392`).

### Upload limits

| Limit | Value | Source |
| --- | --- | --- |
| Media MIME cap | `agentRuntimeConfig.maxUploadBytes`, default 50 MiB, env `OPENMAIC_AGENT_MAX_UPLOAD_BYTES` | `lib/server/agent-runtime/config.ts:46` |
| Everything else | `min(maxDocumentBytes, maxUploadBytes)`, both default 50 MiB | `route.ts:70-73`, `config.ts:48` |
| Materials per owner | 100, env `MATERIALS_MAX_COUNT_PER_OWNER` | `config.ts:50` |
| Total bytes per owner | 2 GiB, env `MATERIALS_MAX_TOTAL_BYTES_PER_OWNER` | `config.ts:52-55` |
| List page ceiling | 200 | `route.ts:77` |
| Filename length | 512 chars after `basename` | `route.ts:91` |

`x-material-filename` is percent-decoded (failure preserved verbatim), `\` is
normalised to `/`, `basename` is taken, and the result is trimmed and truncated
(`:82-93`). `x-request-id` is echoed only if it matches
`/^[A-Za-z0-9._:-]{1,128}$/`, else a UUID is minted (`:95-98`).

### The upload lifecycle and its compensations

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as "POST /api/materials"
  participant Q as owner_materials table
  participant B as material byte store

  C->>R: raw bytes, content-type mime, x-material-filename
  R->>R: normalize mime, reject 415 if not allowlisted
  R->>R: reject 413 if declared content-length over the per-class cap
  R->>R: reject 400 on an empty body or a missing filename
  R->>Q: reclaimStaleOwnerMaterialUploads, older than 24h
  Note over R,Q: byte object deleted BEFORE the reservation row,<br/>so a failure keeps a durable pointer for the next pass
  R->>Q: registerOwnerMaterial, reserving declaredBytes or the full cap
  alt MaterialQuotaExceededError
    Q-->>R: quota refusal
    R-->>C: 429 INVALID_REQUEST with the store message
  end
  R->>R: readMeteredBody(req, uploadLimit) counting REAL bytes
  alt over the cap mid-stream
    R->>Q: abandonOwnerMaterial
    R-->>C: 413 "upload exceeds N bytes"
  else zero bytes
    R->>Q: abandonOwnerMaterial
    R-->>C: 400 "empty body"
  else larger than the declared length
    R->>Q: abandonOwnerMaterial
    R-->>C: 413 "upload body exceeds its declared content length"
  end
  R->>R: sha256 over the buffer
  R->>B: put(ossKey, bytes, mime)
  R->>Q: finalizeOwnerMaterial(id, byteLength, hash)
  Q-->>R: row
  R-->>C: 201 with x-request-id
  Note over R,B: on any throw after put: delete the bytes first,<br/>then abandon the reservation only if the delete succeeded
```

The reservation trick matters: when an intermediary strips `Content-Length`, the
route reserves the **full per-file maximum** so an unmeasured stream cannot slip
past the owner byte quota, then shrinks the reservation at finalisation
(`:224-229`).

### Structured logging

Every branch logs through `context()`, which emits `requestId`, `phase`,
`materialId`, `mime`, `declaredBytes`, `receivedBytes`, `durationMs`
(`:154-163`). `phase` walks
`feature_gate → validate_request → reclaim_stale_uploads → reserve_material → store_bytes`.
This is the most observable route in the surface.

## Notes and caveats

- **`materials/[id]` exposes no DELETE.** The file states why: the underlying
  session-material store has no delete operation yet (`materials/[id]/route.ts:10-13`).
- **Two of these five routes have no upload cap at all.** `parse-pdf` and
  `transcription` both `arrayBuffer()`/`formData()` the whole body. Only
  `extract-document` (50 MiB) and `materials` (per-class, byte-counted) bound it.
- **SSRF strictness differs.** All three extraction routes gate the client base
  URL check on `NODE_ENV === 'production'`; `generate/tts` does not. See
  [`09-conventions.md`](./09-conventions.md).
- **`extract-document` is the only route that sanitises log values.** Every other
  route interpolates caller-controlled strings into log lines unchanged.
- **No rate limiting.** `POST /api/materials` is bounded by the per-owner quota,
  which is the closest thing to a rate limit in the surface — and it caps
  *storage*, not request frequency.

## Open questions

- `resolveServerAsset` returns a five-state union; the `'unauthenticated'` state
  maps to `401`, which implies a credential path into the asset store, but which
  credential (the persistence dev token? the anonymous owner?) was not traced from
  the route.
- `publicMaterialView` versus `publicMaterial` — the list/detail routes use the
  former and the upload success path the latter (`materials/route.ts:352`,
  `[id]/route.ts:42`). Whether the two projections are field-identical was not
  verified.

Next: [`04-classroom-and-pbl.md`](./04-classroom-and-pbl.md).
