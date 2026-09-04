# 02 — Container diagram (C4 L2)

The canonical container diagram, then one reduced variant per major slice —
generation, playback, export — so each can be read without the noise of the
other two. Every edge is labelled with its protocol and its purpose.

**Sources:** `docker-compose.yml`, `middleware.ts`, `next.config.ts`,
`app/api/generate/scene-outlines-stream/route.ts`,
`app/api/generate/scene-content/route.ts`, `app/api/generate/scene-actions/route.ts`,
`app/api/generate/tts/route.ts`, `app/api/extract-document/route.ts`,
`app/api/chat/route.ts`, `app/api/chat/pi/route.ts`,
`app/api/agent/sessions/[id]/events/route.ts`,
`app/api/persistence/[...path]/route.ts`,
`app/api/classroom-media/[classroomId]/[...path]/route.ts`,
`app/api/export-video/render/route.ts`, `lib/store/video-render.ts`,
`lib/server/render-service.ts`, `render-service/src/main.ts`,
`lib/persistence/bootstrap.ts`, `lib/persistence/server-provider.ts`.
Evidence: [api-surface/00](docs/appendix/research/api-surface/00-overview.md),
[media-audio-video/02g](docs/appendix/research/media-audio-video/02g-interfaces-render-service.md).

## Canonical C4 L2

Mermaid's experimental `C4Container` block is not used; the C4 system boundary is
a `subgraph` and each node label carries `[technology]` the way a C4 element
would.

```mermaid
flowchart TD
  PERSON["Teacher / learner<br/>(browser user)"]

  subgraph boundary["OpenMAIC deployment"]
    direction TB

    BROWSER["Browser runtime<br/>(Next client bundle: React 19, Zustand, Dexie)<br/>generation orchestration, playback engine,<br/>video-export compiler, user API keys"]

    subgraph nextproc["Next.js server process — node server.js, port 3000"]
      MW["Edge middleware<br/>(middleware.ts)<br/>workbench 404 gate + ACCESS_CODE HMAC cookie"]
      API["Route handlers<br/>(69 route.ts, 86 exported handlers)<br/>generation, agent control plane, persistence,<br/>provider probes, egress proxies"]
      BG["Background schedules<br/>(instrumentation.ts register)<br/>agent runner, material extraction,<br/>NOTIFY bus, asset collector"]
    end

    RS["render-service<br/>(Node 22 + Chromium + FFmpeg, Hono)<br/>frame capture and MP4 encode only"]

    PGDB[("PostgreSQL 16<br/>(relational store)<br/>20 tables: documents, runtime,<br/>agent sessions, assets")]
    OBJ[("Object store<br/>(S3, optional)<br/>asset bytes when ASSET_S3_BUCKET is set")]
    DISK[("Server volume<br/>(filesystem)<br/>data/usage, data/classrooms,<br/>data/classroom-jobs")]
    LOCAL[("Browser storage<br/>(IndexedDB x4 + localStorage)<br/>MAIC-Database v17, maic-documents,<br/>maic-runtime, maic-asset-pool")]
  end

  EXTLLM["LLM vendor APIs<br/>(19 built-in providers)"]
  EXTMEDIA["TTS / ASR / image / video APIs<br/>(10 / 6 / 8 / 6 providers)"]
  EXTSEARCH["Web search APIs<br/>(9 backends)"]
  EXTDOC["Document extraction APIs<br/>(MinerU, MinerU Cloud, AliDocMind)"]

  PERSON -->|"HTTPS — uses the product"| BROWSER
  BROWSER -->|"HTTPS + SSE — every request passes the matcher at middleware.ts:89"| MW
  MW -->|"in-process — 401 for /api/*, pass-through for pages"| API
  BROWSER -->|"IndexedDB / localStorage — default persistence mode"| LOCAL
  BROWSER -->|"HTTP JSON — only when NEXT_PUBLIC_PERSISTENCE=1 (bootstrap.ts:15)"| API
  API -->|"pg protocol over one pooled Pool — server-provider.ts:72"| PGDB
  BG -->|"pg LISTEN/NOTIFY + claim scan — instrumentation.ts:44,49"| PGDB
  API -->|"AWS SDK S3 — optional peer, next.config.ts:32"| OBJ
  API -->|"fs read/write — atomic temp+rename"| DISK
  API -->|"HTTPS — chat/generation completions, operator or user key"| EXTLLM
  API -->|"HTTPS — narration, transcription, illustration, clips"| EXTMEDIA
  API -->|"HTTPS — grounding for agent and generation"| EXTSEARCH
  API -->|"HTTPS — uploaded PDF/media to text + images"| EXTDOC
  API -->|"HTTP multipart ZIP in, JSON poll, MP4 stream out — export-video/render"| RS
  RS -.->|"no route: render network is internal:true and OUTPUT DROP"| EXTLLM
```

Two structural facts the diagram encodes:

1. **There is exactly one inbound gate.** `middleware.ts` matches
   `/((?!_next/static|_next/image|favicon.ico|logos/).*)`
   ([`middleware.ts:89`](middleware.ts#L89)) and is the only place `ACCESS_CODE` gates *traffic*; **no
   route file behind it re-checks the cookie**
   ([api-surface/00](docs/appendix/research/api-surface/00-overview.md)). Two
   allowlisted routes do read `ACCESS_CODE` themselves, because the gate skipped
   them: [`access-code/verify/route.ts:26`](app/api/access-code/verify/route.ts#L26) is the login — it `timingSafeEqual`s the
   submitted code against the env value and mints the cookie — and
   [`access-code/status/route.ts:13`](app/api/access-code/status/route.ts#L13) re-verifies an existing cookie. The gate is
   also conditional: [`middleware.ts:60-61`](middleware.ts#L60-L61) returns early when `ACCESS_CODE` is
   unset, and in that state `verify` answers `{valid:true}` to any caller (`:8-9`).
2. **The browser talks to the store directly in the default mode.** The
   `BROWSER → LOCAL` edge is not a cache — it is the primary system of record
   unless `NEXT_PUBLIC_PERSISTENCE=1` flips documents and runtime onto HTTP
   ([`lib/persistence/bootstrap.ts:41-68`](lib/persistence/bootstrap.ts#L41-L68)).

## Slice 1 — generation path

The browser drives the pipeline. The server is a stateless per-step LLM proxy
plus one SSE endpoint.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser — generation-preview page
  participant MW as middleware.ts
  participant EX as POST /api/extract-document
  participant OS as GET /api/generate/scene-outlines-stream
  participant SC as POST /api/generate/scene-content
  participant SA as POST /api/generate/scene-actions
  participant TT as POST /api/generate/tts
  participant LLM as LLM vendor API
  participant ST as Document store — IndexedDB or /api/persistence

  B->>MW: multipart upload, x-* provider headers
  MW->>EX: passes the access-code gate
  EX->>EX: selectDocumentExtractorProvider by MIME + capability
  EX-->>B: DocumentArtifact / MediaArtifact
  B->>B: buildDocumentBundle — multi-document renumber, text budget
  B->>OS: SSE request with the bundle
  OS->>LLM: streamLLM, stage scene-outlines
  LLM-->>OS: token stream
  OS-->>B: text/event-stream, incremental outline JSON
  loop per scene
    B->>SC: scene + type, stage scene-content per scene type
    SC->>LLM: callLLM
    SC-->>B: typed SlideContent / QuizContent / PBLContent
    B->>SA: content + previousSpeeches, stage scene-actions
    SA-->>B: Action[] and the assembled DSL Scene
    opt narration requested
      B->>TT: speech text + voice
      TT-->>B: base64 audio + measured duration
    end
    B->>ST: persist scene + audio asset
  end
```

The whole loop lives client-side in `lib/hooks/use-scene-generator.ts`; the
headless server twin is `lib/server/classroom-generation.ts`, strictly serial and
polled through a job row under `data/classroom-jobs/`. See
[../06-generation-pipeline/index.md](docs/06-generation-pipeline/index.md) for why
both exist.

## Slice 2 — playback path

```mermaid
flowchart LR
  subgraph browsertab["Browser tab — the /classroom/:id route"]
    LOAD["runClassroomLoad<br/>lib/classroom/load-classroom.ts"]
    ENGINE["PlaybackEngine<br/>lib/playback/engine.ts"]
    AE["ActionEngine<br/>lib/action/engine.ts"]
    BUF["StreamBuffer<br/>lib/buffer/stream-buffer.ts"]
    IFR["InteractiveIframeHost<br/>sandbox=allow-scripts allow-forms allow-popups"]
  end

  subgraph stores["Storage read on load"]
    IDB[("IndexedDB<br/>maic-documents + MAIC-Database")]
    HTTPST["GET /api/persistence/documents/*"]
    MEDIA["GET /api/classroom-media/:classroomId/*<br/>Range-capable byte stream"]
  end

  subgraph serverchat["Server, per turn"]
    CHAT["POST /api/chat<br/>LangGraph director (default)"]
    PI["POST /api/chat/pi<br/>Pi director, NEXT_PUBLIC_PI_CHAT_ENABLED"]
    TTSR["POST /api/generate/tts"]
    PBL["POST /api/pbl/v2/* — 4 SSE endpoints"]
  end

  LOAD -->|"IndexedDB read first"| IDB
  LOAD -->|"HTTP fallback when server mode is on"| HTTPST
  LOAD -->|"deferred media hydration"| MEDIA
  LOAD --> ENGINE
  ENGINE -->|"awaits execute() for blocking actions"| AE
  ENGINE -->|"per-sentence browser TTS or pre-generated audio"| TTSR
  AE --> IFR
  ENGINE -->|"SSE turn, full state re-posted each iteration"| CHAT
  ENGINE -->|"SSE turn when the flag is on"| PI
  CHAT -->|"30ms/char pacing, holding/segmentDone protocol"| BUF
  PI --> BUF
  BUF -->|"sealed segment queued for TTS"| TTSR
  ENGINE -->|"whole PBLProjectV2 posted, project_patch events applied"| PBL
```

The classroom server is stateless per turn: the browser owns the loop and
re-posts full state each iteration, and PBL v2 posts the entire project and
applies returned `project_patch` events. Detail in
[../08-classroom-runtime/index.md](docs/08-classroom-runtime/index.md).

## Slice 3 — export path

This is the only slice that involves a second container, and the only one where
the app hands work to a process it cannot reach back into.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser — lib/store/video-render.ts
  participant APP as POST /api/export-video/render
  participant POLL as GET /api/export-video/render/:jobId
  participant DL as GET /api/export-video/render/:jobId/download
  participant RS as render-service — Hono on port 9000
  participant PROD as hyperframes producer plus Chromium and FFmpeg

  B->>B: compileVideoTimeline — 9 pure passes to the VideoTimeline IR
  B->>B: buildExportZip — emitHyperframes + Dexie assets + fonts
  B->>APP: multipart/form-data, project(zip) + fps/quality/format
  APP->>APP: 413 on declared length over 300 MiB, then byte-counted cap
  APP->>RS: POST /render, body streamed verbatim, x-openmaic-client identity
  RS->>RS: coordinator.reserve(identity) BEFORE buffering
  RS->>RS: extractionGate, then unzipProject with declared-size ZIP guards
  RS-->>APP: 202 { jobId }
  APP-->>B: 202 { jobId, pollIntervalMs: 3000 }
  RS->>PROD: executionGate permit, one paused GSAP timeline driven frame by frame
  loop until terminal
    B->>POLL: GET status
    POLL->>RS: GET /render/:jobId
    RS-->>POLL: { status, progress, currentStage }
    POLL-->>B: relayed status
  end
  B->>DL: GET download
  DL->>RS: GET /render/:jobId/download
  RS-->>DL: MP4 stream (or 302 to a presigned URL)
  DL-->>B: MP4 bytes
```

Three deliberate orderings in that sequence, each with a comment in the source:

| Ordering | Why | Where |
| --- | --- | --- |
| `reserve()` before buffering the body | Admission must not require holding a 300 MiB archive in RAM first | `render-service/src/render-coordinator.ts` `reserve`/`submit` split |
| ZIP guards on **declared** sizes before decompressing | A ZIP bomb must be rejected without being expanded | `render-service/src/unzip.ts` |
| Body streamed, never `formData()`-parsed in the app | Parsing would defeat the streaming byte cap; the service derives identity from `x-openmaic-client` and ignores any multipart `userId` | [`app/api/export-video/render/route.ts:66-84`](app/api/export-video/render/route.ts#L66-L84) |

Degradation is explicit rather than an error: `RENDER_SERVICE_URL` unset makes
the route answer `501 PROVIDER_DISABLED`
([`app/api/export-video/render/route.ts:47-50`](app/api/export-video/render/route.ts#L47-L50)), and the client falls back to
downloading the ZIP for local CLI rendering.

## Protocol summary

| Edge | Protocol | Purpose | Verified at |
| --- | --- | --- | --- |
| Browser → Next | HTTPS JSON | 86 method handlers across 69 route files | `app/api/**/route.ts` |
| Browser → Next | `text/event-stream` | 10 streaming endpoints: 6 hand-rolled SSE, 4 via `createSSEResponse` | [api-surface/00](docs/appendix/research/api-surface/00-overview.md) |
| Browser → Next | byte stream + `Range` | classroom media, MP4 download | `app/api/classroom-media/.../route.ts` |
| Next → PostgreSQL | pg wire, one pooled `Pool` | documents, runtime, agent sessions, assets | [`lib/persistence/server-provider.ts:40,72`](lib/persistence/server-provider.ts#L40) |
| Next → PostgreSQL | `LISTEN` / `pg_notify` | one dedicated connection per app instance for SSE wakeups | [`instrumentation.ts:39-45`](instrumentation.ts#L39-L45) |
| Next → render-service | HTTP multipart / JSON / octet-stream | submit, poll, cancel, download | `app/api/export-video/**` |
| Next → S3 | AWS SDK (HTTPS) | asset bytes; optionally a presigned 302 | `lib/persistence/asset-byte-store.ts`, [`app/api/persistence/[...path]/route.ts:105-107`](app/api/persistence/[...path]/route.ts#L105-L107) |
| Next → provider APIs | HTTPS | LLM, TTS, ASR, image, video, search, extraction | `lib/ai/providers.ts`, `lib/audio/tts-providers.ts`, … |
| Browser → IndexedDB | structured clone | primary system of record in local mode | `lib/utils/database.ts`, `packages/@openmaic/storage/src/*/browser*.ts` |

## Open questions

- The app never opens a connection *to* the browser (no WebSocket anywhere in
  `app/api/**`); every push is SSE over a client-initiated request. Whether a
  bidirectional channel was considered is not recorded in the code.
- `render-service` exposes `POST /preview` ([`render-service/src/main.ts:333`](render-service/src/main.ts#L333)) and
  the compose file configures `RENDER_PREVIEW_*` limits, but no `app/api` route
  proxies `/preview`. Which client is intended to call it could not be
  determined from this repository.
