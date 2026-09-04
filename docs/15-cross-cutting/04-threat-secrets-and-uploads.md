# Threats: Secret Exposure and File-Upload Abuse

Two unrelated threats sharing one property — both are decided at the boundary
where bytes or values cross from a place that keeps them to a place that does
not. Secret exposure is about which values reach a browser bundle; upload abuse
is about what a caller can make the server buffer, parse or store.

**Sources:** `lib/config/feature-flags.ts:1-12`, `lib/persistence/bootstrap.ts:31-39`,
`lib/persistence/server-auth.ts:1-13`, `Dockerfile:51-72`, `docker-compose.yml:8-21`,
`lib/server/provider-config.ts:693-706`, `lib/server/proxy-fetch.ts:134`,
`app/api/materials/route.ts`, `lib/server/capped-stream.ts`,
`lib/constants/generation.ts:16`, `render-service/src/config.ts:100-110`,
`render-service/src/unzip.ts`,
[`../appendix/research/persistence-storage-state/04-dependencies-and-config.md`](../appendix/research/persistence-storage-state/04-dependencies-and-config.md),
[`../appendix/research/api-surface/02b-interfaces-egress-body-sse.md`](../appendix/research/api-surface/02b-interfaces-egress-body-sse.md).

## Part 1 — secret exposure

### The rule and its one deliberate exception

`lib/config/feature-flags.ts:1-8` states the rule: public flags use
`NEXT_PUBLIC_*` because Next inlines them at build time and they are therefore
safe to read from client components; **server-only flags must not use the prefix**.
Every one of the 14 predicates in that file obeys it.

The exception is `NEXT_PUBLIC_PERSISTENCE_TOKEN`, and it is documented as such:

> The token is NOT a secret: `NEXT_PUBLIC_PERSISTENCE_TOKEN` is compiled into the
> public browser bundle, so it is fully visible to every visitor and provides no
> confidentiality and no user isolation — anyone who can load the page can read
> and write EVERY learner partition and all documents by supplying an arbitrary
> `x-learner-key`.
> — `lib/persistence/server-auth.ts:3-8`

```mermaid
flowchart LR
  subgraph Build["Build time"]
    ARG["Dockerfile ARG (11 values)"] --> ENV["ENV in the builder stage"]
    ENV --> NB["next build inlines NEXT_PUBLIC_* literals"]
  end
  subgraph Image["Shipped image"]
    NB --> JS[".next/static/**.js"]
    NB --> SS[".next/standalone/server.js"]
  end
  subgraph Runtime["Runtime env (never inlined)"]
    RT["OPENAI_API_KEY, ANTHROPIC_API_KEY, ...<br/>ACCESS_CODE, DATABASE_URL,<br/>PERSISTENCE_DEV_TOKEN, MODEL_ROUTES"]
  end
  JS -->|"visible to every visitor"| Browser["Browser"]
  RT --> SS
  SS -.->|"never serialised to the client"| Browser
```

The 11 build args are `ALLOWED_FRAME_ANCESTORS`, `NEXT_PUBLIC_PERSISTENCE`,
`NEXT_PUBLIC_PERSISTENCE_TOKEN`, `NEXT_PUBLIC_MAIC_EDITOR_ENABLED`,
`NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED`,
`NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED`, `NEXT_PUBLIC_PI_CHAT_ENABLED`,
`NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI`, `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT`,
`NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION`, `NEXT_PUBLIC_ENABLE_PPTX_IMPORT`
(`Dockerfile:51-72`, mirrored at `docker-compose.yml:11-21`).

`NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` is documented in `.env.example` and read by
`isProWorkbenchEnabled()` (`lib/config/feature-flags.ts:33`) but appears in
**neither** the Dockerfile ARG list nor the Compose build args. The container
build path cannot enable the Pro workbench.

### What the server refuses to tell the client

`getServerProviders()` returns only `{ models?: string[] }` per provider — never
the API key, never the base URL, with the reason stated inline: a base URL "can
reveal internal gateway/proxy infrastructure"
(`lib/server/provider-config.ts:693-706`). The client learns *that* a provider is
managed (by its presence in the map) and nothing more. `GET /api/health` reports
four booleans and a version string (`app/api/health/route.ts:12-23`).

### Where a secret can still reach a log

Two verified paths:

| Path | Mechanism |
| --- | --- |
| Forward-proxy URL | `lib/server/proxy-fetch.ts:134` does `log.info('Using proxy', cachedProxyUrl, 'for:', url)`. `cachedProxyUrl` is the raw `https_proxy` value, so `http://user:pass@proxy:3128` is written verbatim. `LOG_LEVEL` defaults to `info` (`lib/logger.ts:5`), so this fires by default. |
| Error objects | `formatLine` stringifies an `Error` as `a.stack ?? a.message` (`lib/logger.ts:18`). A provider SDK that embeds a request URL — including a query-string key — in its message will have it logged. Not traced to a specific provider that does. |

There is no key-redaction helper anywhere in `lib/`. Nothing scrubs `Authorization`
headers or `apiKey` fields before logging.

### Where BYO keys live

```mermaid
flowchart TD
  User["User types a key in Settings"] --> Store["useSettingsStore providersConfig"]
  Store --> KV["createKVPersistStorage('account')<br/>lib/store/settings.ts:1987"]
  KV --> LSB["BrowserKVStore = localStorage<br/>lib/store/kv-persist.ts:430, :473"]
  Store --> HDR["x-api-key / x-base-url / x-provider-type headers"]
  HDR --> RM["resolveModel<br/>lib/server/resolve-model.ts:79-81"]
  RM --> MGD{"isServerConfiguredProvider('providers', id)?"}
  MGD -- yes --> DROP["client key and base URL DISCARDED;<br/>operator's values used"]
  MGD -- no --> USE["client key used verbatim"]
  RM --> ROUTED{"MODEL_ROUTES has this stage?"}
  ROUTED -- yes --> DROP2["client key, base URL and providerType<br/>all set to undefined before resolution"]
```

Consequences worth stating plainly: a BYO key sits in `localStorage` in
cleartext, so the Path-1 XSS sink in
[`03-threat-injection.md`](./03-threat-injection.md) is a key-exfiltration
primitive; and a BYO key travels to the OpenMAIC server on every request that
uses it, so a self-hosted deployment's operator can always read its users' keys.

## Part 2 — file-upload abuse

### The three upload surfaces

| Surface | Route | Body form |
| --- | --- | --- |
| Workbench material | `POST /api/materials` | raw body + `content-type` + `x-material-filename` |
| Document / media extraction | `POST /api/extract-document` | multipart `File`, or an asset id |
| Video-export archive | `POST /api/export-video/render` | multipart ZIP, forwarded unparsed |

```mermaid
flowchart TD
  Req["POST /api/materials"] --> G1{"isAgentRuntimeConfigured()?"}
  G1 -- no --> R404["404 'Not found'"]
  G1 -- yes --> OWN["withRequestOwnerId → anon:&lt;uuid&gt;"]
  OWN --> G2{"normalizeWorkbenchMaterialMime(content-type)<br/>in the 19-entry allowlist?"}
  G2 -- no --> R415["415 unsupported material mime type"]
  G2 -- yes --> LIM["uploadLimit = media ? maxUploadBytes<br/>: min(maxDocumentBytes, maxUploadBytes)"]
  LIM --> G3{"declared content-length > uploadLimit?"}
  G3 -- yes --> R413a["413 (courtesy reject)"]
  G3 -- no --> G4{"x-material-filename present?"}
  G4 -- no --> R400["400 MISSING_REQUIRED_FIELD"]
  G4 -- yes --> RES["reserve: content-length, or the FULL cap when absent"]
  RES --> G5{"registerOwnerMaterial within<br/>maxMaterialsPerOwner and maxMaterialBytesPerOwner?"}
  G5 -- no --> R429["429 quota exceeded"]
  G5 -- yes --> METER["readMeteredBody(req, uploadLimit): counts streamed bytes<br/>(app/api/materials/route.ts:400-416)"]
  METER -- "over cap" --> COMP["MaterialPayloadTooLarge →<br/>abandonOwnerMaterial (compensating write) → 413"]
  METER -- ok --> HASH["createHash('sha256') over the complete buffer (:341)"]
  HASH --> FIN["finalize: shrink reservation to actual bytes"]
```

Three properties of this chain are worth copying elsewhere:

1. **The cap is enforced on streamed bytes, not on `Content-Length`.**
   `readMeteredBody` (`app/api/materials/route.ts:400-416`) adds up each chunk as
   it arrives and, the instant the running total exceeds the cap, cancels the
   reader and throws `MaterialPayloadTooLarge` — so a chunked upload with no
   declared length cannot bypass it. The sha256 is *not* computed while counting;
   it runs afterwards over the completed buffer (`:341`). The export-video archive
   applies the same idea through a different helper: `capBodyStream`
   (`lib/server/capped-stream.ts:19-46`) wraps the body in a `TransformStream` and
   `controller.error(...)`s over the cap, and its docstring states exactly that
   threat. It has one caller in the repo,
   `app/api/export-video/render/route.ts:70`, which is where it matters — a
   300 MiB ZIP must never be buffered just to measure it.
2. **A missing `Content-Length` reserves the per-file maximum** rather than zero
   (`app/api/materials/route.ts:228-229`), so an unmeasured stream cannot slip past
   the owner byte quota; `finalize` shrinks the reservation afterwards.
3. **Every failure branch compensates.** A cap trip, a byte-store failure or a
   finalise failure all call `abandonOwnerMaterial`, and stale reservations older
   than 24 h are reclaimed at the start of the *next* upload
   (`:231-257`) — byte object first, reservation second, so a failure keeps the
   pointer to the bytes.

### Caps and quotas, with defaults

| Limit | Env var | Default | Enforced at |
| --- | --- | --- | --- |
| Audio/video material | `OPENMAIC_AGENT_MAX_UPLOAD_BYTES` | 50 MiB | `lib/server/agent-runtime/config.ts:46` |
| Document/image material | `MATERIALS_MAX_DOCUMENT_BYTES` | 50 MiB, `min`-ed with the above | `config.ts:48`, `app/api/materials/route.ts:70-73` |
| Materials per owner | `MATERIALS_MAX_COUNT_PER_OWNER` | 100 → 429 | `config.ts:50` |
| Bytes per owner | `MATERIALS_MAX_TOTAL_BYTES_PER_OWNER` | 2 GiB → 429 | `config.ts:52-55` |
| Extraction upload | — (hardcoded) | 50 MiB | `lib/constants/generation.ts:16`, checked at `extract-document/route.ts:481`, `:572`, `:602` |
| Proxy-media response | — (hardcoded) | 25 MiB, checked on `content-length` **and** on the buffered blob | `app/api/proxy-media/route.ts:67-75` |
| Export archive (app side) | — (hardcoded) | 300 MiB, streamed cap | `app/api/export-video/render/route.ts:18`, `:70` |
| Next proxy body | — | `proxyClientMaxBodySize: '200mb'` | `next.config.ts:36` |
| Preview JSON | `RENDER_PREVIEW_MAX_JSON_BYTES` | 32 MiB → 413 | `render-service/src/config.ts:96` |

The 200 MB `proxyClientMaxBodySize` sits *below* the 300 MiB export cap, so on a
Vercel/proxy deployment the smaller value wins. Inferred: the two were set
independently.

### ZIP-bomb guards on the render service

```mermaid
flowchart LR
  Zip["uploaded .zip"] --> D1{"declared compressed size<br/>> RENDER_MAX_UPLOAD_BYTES (300 MiB)?"}
  D1 -- yes --> Rej["reject before decompressing"]
  D1 -- no --> D2{"entry count > RENDER_MAX_ENTRIES (5000)?"}
  D2 -- yes --> Rej
  D2 -- no --> D3{"any declared entry size<br/>> RENDER_MAX_ENTRY_BYTES (200 MiB)?"}
  D3 -- yes --> Rej
  D3 -- no --> D4{"sum of declared sizes<br/>> RENDER_MAX_EXPANDED_BYTES (512 MiB)?"}
  D4 -- yes --> Rej
  D4 -- no --> D5{"any entry ratio<br/>> RENDER_MAX_COMPRESSION_RATIO (200:1)?"}
  D5 -- yes --> Rej
  D5 -- no --> Ext["extract; maxConcurrentExtractions bounds the RAM multiplier"]
```

Every check reads the **declared** sizes from the central directory, before any
decompression (`render-service/src/config.ts:100-110`, applied in
`render-service/src/unzip.ts`). The service admits before it buffers — reserve,
then extraction gate, then `formData` — so an oversized upload is refused without
being held in memory.

### Parsing untrusted documents

Extraction hands bytes to third-party parsers: `unpdf` + `sharp` locally,
self-hosted MinerU or MinerU Cloud or AliDocMind remotely, `ffmpeg` + ASR for
media. Native decoders are the highest-risk code in the system. Two mitigations
exist and neither is a sandbox:

- Pathological raster dimensions are refused in the text-only path
  (`lib/pdf/pdf-providers.ts:256`).
- Documents never silently leave the operator's infrastructure: a self-hosted
  MinerU selection with no base URL fails with a 422 naming both remedies unless
  `ALLOW_MINERU_CLOUD_FALLBACK` is `true`/`1`
  (`app/api/extract-document/route.ts:144-147`, checked at `:369`, 422 at `:375`).

There is no seccomp profile, no separate process, and no memory limit around
local parsing. The render service is the only component in the system that gets
container-level isolation.

### Path traversal on stored media

`GET /api/classroom-media/[classroomId]/[...path]` is the one route that maps a
caller-supplied path onto the filesystem. It rejects `..` and NUL in the joined
segments (`:53`), then resolves symlinks with `fs.realpath` and requires the real
path to sit under `resolve(CLASSROOMS_DIR, classroomId)` (`:63-69`).
`CLASSROOMS_DIR` is a fixed `path.join(process.cwd(), 'data', 'classrooms')` —
not configurable (`lib/server/classroom-storage.ts:6`).

## Open questions

- No rate limiting bounds upload attempts. The owner quotas cap *stored* bytes,
  not the number of 50 MiB bodies a caller can make the server buffer and hash.
- Whether `sharp`'s and `unpdf`'s versions carry known decoder CVEs is a
  dependency question, not answered here — see
  [`../13-dependencies/index.md`](../13-dependencies/index.md).
- `NEXT_PUBLIC_PERSISTENCE_TOKEN` is a Docker **build arg**, so it is recorded in
  the image's build history as well as the client bundle. Whether any published
  image ships a non-empty value is not verifiable from this repository.
