# The C4 Level 1 Context Diagram

The canonical system-context picture, given room to breathe, plus three
role-scoped zooms and the notation legend every diagram in this documentation set
obeys.

**Sources:** all of [`./02-actors-and-personas.md`](docs/01-system-context/02-actors-and-personas.md) and [`./03-external-systems.md`](docs/01-system-context/03-external-systems.md),
plus [`middleware.ts:46-90`](middleware.ts#L46-L90), [`instrumentation.ts:14-102`](instrumentation.ts#L14-L102),
[`lib/workbench/entry-gate.ts:4`](lib/workbench/entry-gate.ts#L4), `next.config.ts`, `docker-compose.yml`,
[`render-service/src/main.ts:229-441`](render-service/src/main.ts#L229-L441).

## Notation legend (applies to the whole docs set)

Mermaid has no C4 vocabulary we are willing to use — the experimental
`C4Context` / `C4Container` blocks are not stable, so C4 levels are expressed
with `subgraph` boundaries and node labels instead. The conventions below are
uniform across topics 01 through 17.

```mermaid
flowchart LR
  P(["Stadium node = a person / actor"])
  S["Rectangle = a software system,<br/>container, or component"]
  D[("Cylinder = a data store")]
  E["Rectangle inside no boundary<br/>= external system we do not own"]

  subgraph BOUNDARY["subgraph = a boundary: system at L1,<br/>container at L2, component at L3"]
    S
  end

  P -->|"solid arrow = synchronous call,<br/>label reads 'what + protocol'"| S
  S -.->|"dashed arrow = optional, conditional,<br/>degraded, or out-of-band (event/NOTIFY)"| E
  S --> D
```

Additional rules used everywhere:

| Convention | Meaning |
| --- | --- |
| `path/to/file.ts:123` inside a node label | The definition site of that box. Always repo-relative. |
| A node label naming a function with `()` | The box *is* that function, not a vague responsibility |
| `sequenceDiagram` | One traced request or one playback turn; every `participant` is declared before use |
| `stateDiagram-v2` | A machine whose states are a real union type in the code, named verbatim |
| `erDiagram` | Persistence shape only. Relationship labels are the FK or the invariant, not prose |
| `classDiagram` | An interface/implementation seam, used only where the seam is the point |
| A box drawn dashed-in via a `-.->` edge only | Present in the deployment only under a flag or an env var |
| `Inferred:` prefix in prose | A reading of intent, not a reading of code |

## The canonical L1 diagram

```mermaid
flowchart TD
  LEARNER(["Learner"])
  AUTHOR(["Course author"])
  OPERATOR(["Self-hoster / operator"])
  AGENTWB(["External agent workbench<br/>OpenClaw / Codex / DeepSeek / WorkBuddy<br/>via skills/openmaic/SKILL.md"])
  HOSTED(["Hosted-mode access-code user<br/>one shared password, no identity"])

  subgraph SYS["OpenMAIC deployment"]
    direction TB
    APP["OpenMAIC web application<br/>Next.js 16 App Router<br/>6 page routes + 69 api/route.ts (86 handlers)"]
    RUNNER["Durable agent runner<br/>in-process timer started at instrumentation.ts:49<br/>only when isAgentRuntimeConfigured()"]
    RENDER["render-service<br/>separate container, Hono + puppeteer-core<br/>zero outbound network (iptables DROP)"]
    DB[("PostgreSQL 16<br/>documents, runtime records, agent sessions,<br/>materials, skills, asset bytes")]
    OBJ[("S3-compatible object store<br/>alternative asset byte layer")]
    APP --- RUNNER
    APP -->|"HTTP multipart ZIP up / MP4 down"| RENDER
    APP <-->|"pg pool + LISTEN/NOTIFY"| DB
    RUNNER <-->|"claim / lease / durable event log"| DB
    APP <-->|"AWS SigV4 GetObject/PutObject"| OBJ
  end

  BROWSERSTORE[("Learner's browser storage<br/>IndexedDB + localStorage<br/>DEFAULT persistence backend")]

  LLM["Text LLM providers (19)<br/>OpenAI, Azure OpenAI, AtlasCloud, Anthropic,<br/>Bedrock, Google, DeepSeek, Qwen, Kimi, MiniMax,<br/>GLM, SiliconFlow, Doubao, OpenRouter, Grok,<br/>Tencent Hunyuan, Xiaomi, Lemonade, Ollama"]
  SPEECH["TTS (10) and ASR (6)<br/>OpenAI, Azure, GLM, Qwen, VoxCPM, Doubao,<br/>ElevenLabs, MiniMax, Lemonade, browser Web Speech;<br/>Whisper, Qwen, Azure, FunASR, Lemonade"]
  VISUAL["Image (8) and video (6) generation<br/>Seedream, GPT-Image, Qwen-Image, Nano Banana,<br/>MiniMax, Grok, ComfyUI, Lemonade;<br/>Seedance, Kling, Veo, MiniMax, Grok, HappyHorse"]
  EXTRACT["Document + media extraction (5 + 2)<br/>plain-text, unpdf, MinerU (self-hosted),<br/>MinerU Cloud, AliDocMind; AliDocMind, local ffmpeg"]
  SEARCH["Web search (9)<br/>Tavily, Exa, Bocha, Brave, Baidu,<br/>Claude, MiniMax, Doubao, SearXNG"]
  MEDIAURL["Arbitrary user-supplied media URLs<br/>fetched only through /api/proxy-media"]

  LEARNER -->|"HTTPS: / and /classroom/:id;<br/>SSE for chat turns"| APP
  AUTHOR -->|"HTTPS: / then /generation-preview;<br/>/workspace when Pro is enabled"| APP
  AGENTWB -->|"HTTPS: GET /api/health then<br/>POST /api/generate-classroom then poll"| APP
  HOSTED -->|"HTTPS: any page, then everything a learner<br/>or author can do; gated by the openmaic_access<br/>HMAC cookie (middleware.ts:71)"| APP
  OPERATOR -->|".env.local, server-providers.yml,<br/>docker-compose.yml — never through the UI"| SYS

  APP -->|"HTTPS, 5 SDK transports, streaming"| LLM
  APP -->|"HTTPS REST; SSML / hex / concatenated JSON"| SPEECH
  APP -->|"HTTPS REST, sync or async job + poll"| VISUAL
  APP -->|"HTTPS REST or local HTTP"| EXTRACT
  APP -->|"HTTPS REST"| SEARCH
  APP -->|"HTTPS GET, SSRF-guarded, manual redirects"| MEDIAURL
  LEARNER <-->|"reads and writes locally"| BROWSERSTORE

  RUNNER -->|"same provider registry as APP"| LLM
```

Three things in that picture are load-bearing and easy to miss.

1. **The default persistence backend is the learner's browser, not the
   database.** [`lib/persistence/bootstrap.ts:15-68`](lib/persistence/bootstrap.ts#L15-L68) switches documents and
   runtime records to HTTP-backed stores *only* when
   `NEXT_PUBLIC_PERSISTENCE === '1'` in a browser. A stock deployment stores
   courses in IndexedDB.
2. **The runner is not a separate process.** It is a `setInterval` inside the
   Next server, installed once per server instance from [`instrumentation.ts:49`](instrumentation.ts#L49).
   Horizontal scaling therefore multiplies runners, which is why PostgreSQL —
   not the process — owns claims and leases.
3. **`render-service` is the only thing that is genuinely a second container**,
   and it is optional (`RENDER_SERVICE_URL`).

## Zoom 1: learner-facing

```mermaid
flowchart TD
  L(["Learner"])

  subgraph SURF["Surfaces the learner touches"]
    HOME["/ — course discovery + folders"]
    CLS["/classroom/:id"]
  end

  subgraph RT["Runtime the learner drives"]
    ENG["PlaybackEngine<br/>lib/playback/engine.ts:62<br/>modes: idle | playing | paused | live"]
    AE["ActionEngine<br/>lib/action/engine.ts:178"]
    LOOP["runAgentLoop()<br/>lib/chat/agent-loop.ts:154<br/>browser owns the loop, re-posts full state"]
    BUF["StreamBuffer<br/>lib/buffer/stream-buffer.ts<br/>30ms per character pacing"]
    IFR["InteractiveIframeHost<br/>sandbox='allow-scripts allow-forms allow-popups'<br/>NO allow-same-origin; pool cap 3"]
  end

  CHATAPI["POST /api/chat  (LangGraph, default)<br/>POST /api/chat/pi (Pi, flagged)"]
  TTSAPI["POST /api/generate/tts"]
  GRADE["POST /api/quiz-grade"]
  PBL["POST /api/pbl/v2/task/update<br/>+ 4 SSE routes"]
  MEDIA["GET /api/classroom-media/:id/*<br/>HTTP Range supported"]
  IDB[("IndexedDB: course document,<br/>chat log, quiz state, resume cursor")]

  L --> HOME
  L --> CLS
  CLS --> ENG
  ENG --> AE
  ENG --> LOOP
  LOOP -->|SSE| CHATAPI
  CHATAPI -->|"StatelessEvent frames"| BUF
  BUF --> AE
  AE --> IFR
  ENG --> TTSAPI
  CLS --> GRADE
  CLS --> PBL
  CLS --> MEDIA
  CLS <--> IDB
  ENG -.->|"no pre-generated audio:<br/>estimateSpeechDurationMs() reading timer"| AE
```

The learner never talks to an LLM provider directly; every model call is
server-side. But the learner's *browser* holds the conversation state — the
in-class runtime is stateless server-side and the client re-posts everything each
iteration ([`lib/chat/agent-loop.ts:181-192`](lib/chat/agent-loop.ts#L181-L192)).

## Zoom 2: author-facing

```mermaid
flowchart TD
  A(["Course author"])

  subgraph ONECLICK["One-click path (always available)"]
    C1["/ composer<br/>writes sessionStorage 'generationSession'<br/>app/page.tsx:671"]
    C2["/generation-preview<br/>previewPhase state machine<br/>app/generation-preview/types.ts:22"]
    C1 --> C2
  end

  subgraph PRO["Pro workbench path (triple-gated)"]
    W1["/workspace — server gate<br/>app/workspace/page.tsx:34, redirect('/') if off"]
    W2["POST /api/agent/sessions"]
    W3["GET /api/agent/sessions/:id/events (SSE)<br/>Last-Event-ID replay, never closes at session_end"]
    W1 --> W2 --> W3
  end

  EXTRACT["POST /api/extract-document"]
  OUTLINE["POST /api/generate/scene-outlines-stream (SSE)<br/>512 KiB buffer ceiling, 3-attempt retry"]
  CONTENT["POST /api/generate/scene-content"]
  ACTIONS["POST /api/generate/scene-actions"]
  MAT["POST /api/materials<br/>per-class byte caps, owner quota 429"]
  STAGES["/api/stages/** (9 routes / 13 handlers)<br/>owner-scoped course documents"]
  RUNNER2["Durable agent runner<br/>40 tools, 9 sequential stage writers"]
  DOC[("Stage document")]

  A --> C1
  A --> W1
  C2 --> EXTRACT
  C2 --> OUTLINE
  C2 --> CONTENT
  C2 --> ACTIONS
  W1 --> MAT
  W3 -.->|"reads durable event log written by"| RUNNER2
  RUNNER2 --> STAGES
  ACTIONS --> DOC
  STAGES --> DOC
  DOC -->|"pptx / .maic.zip / video ZIP or MP4"| A
```

The two paths never share code for orchestration. The one-click path is
browser-sequenced with `sessionStorage` handoffs; the Pro path is
PostgreSQL-sequenced with a durable event log. They converge only on the `Stage`
document and on `@openmaic/generation`.

## Zoom 3: operator-facing

```mermaid
flowchart TD
  O(["Self-hoster / operator"])

  subgraph CONFIG["Configuration inputs (all outside the app UI)"]
    ENV[".env.local — 525-line template<br/>provider keys, flags, DATABASE_URL, ACCESS_CODE"]
    YAML["server-providers.yml<br/>lib/server/provider-config.ts:417<br/>can declare gateway-only model capabilities"]
    COMPOSE["docker-compose.yml<br/>services: openmaic, postgres, render-service;<br/>networks: default, render (internal: true)"]
  end

  subgraph BOOT["Boot-time consumption"]
    REG["instrumentation.ts register()<br/>Node runtime only"]
    VAL["validateServerConfig()<br/>warn-only; flags a missing<br/>maic-agent-driver route"]
    COL["startAssetCollectorSchedule()<br/>the ONLY reclamation job"]
    RUN["startAgentRunner() + startMaterialExtractionRunner()<br/>+ startAgentEventNotifyBus()"]
    REG --> COL --> VAL --> RUN
  end

  subgraph GATES["Gates the operator controls"]
    MW["middleware.ts<br/>/workbench* 404 gate, then ACCESS_CODE HMAC cookie"]
    FF["lib/config/feature-flags.ts<br/>14 predicates, readBoolean('true'|'1')"]
    HDR["next.config.ts headers()<br/>X-Frame-Options + CSP frame-ancestors"]
  end

  PROBE["GET /api/health — capability report<br/>GET /api/server-providers — which providers are managed<br/>POST /api/verify-model, /api/verify-{pdf,image,video}-provider"]
  USAGE["GET /api/usage — aggregates data/usage/*.jsonl<br/>by model / day / modality"]

  O --> ENV
  O --> YAML
  O --> COMPOSE
  ENV --> REG
  YAML --> VAL
  ENV --> FF
  ENV --> MW
  ENV --> HDR
  O --> PROBE
  O --> USAGE
  FF -.->|"isAgentRuntimeConfigured() false<br/>skips the whole RUN group"| RUN
```

The operator's authority is asymmetric on purpose. `/api/health` and
`/api/server-providers` publish *whether* a capability exists without publishing
the credential; [`middleware.ts:66`](middleware.ts#L66) allowlists `/api/health` precisely so an
external agent can probe capability before authenticating.

## System boundary: what is in and what is out

| In the boundary | Out of the boundary |
| --- | --- |
| The Next.js app (pages + API + `lib/`) | Every LLM / TTS / ASR / image / video / search / extraction provider |
| The six `@openmaic/*` packages it consumes as workspace deps | The `@openmaic/*` packages *as published npm artefacts* consumed by third parties |
| The in-process agent runner and material-extraction runner | The external agent workbench that drives the API |
| The optional `render-service` container | The learner's browser storage (owned by the browser, not the server) |
| The optional PostgreSQL database and S3 bucket | `open.maic.chat`'s bearer auth and daily quota (not in this repo) |
| `data/usage/*.jsonl` on the app's filesystem | The two vendored forks' upstreams (`pptxgenjs`, `mathml2omml`) |

## Cross-links

- Actors in detail: [`./02-actors-and-personas.md`](docs/01-system-context/02-actors-and-personas.md)
- External systems in detail: [`./03-external-systems.md`](docs/01-system-context/03-external-systems.md)
- The next level down: [`../02-container-view/index.md`](docs/02-container-view/index.md)
- Every endpoint on the boundary: [`../12-api-reference/index.md`](docs/12-api-reference/index.md)
- Physical topology of these boxes: [`../17-deployment-view/index.md`](docs/17-deployment-view/index.md)
