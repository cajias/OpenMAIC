# 11 — Concurrency, serialisation, and backpressure

Where parallelism exists, where it is deliberately forbidden, which queues and
buffers absorb bursts, and which four places actually bottleneck a real run.

**Sources:** `lib/utils/concurrency.ts`, [`lib/hooks/use-scene-generator.ts:686-760`](lib/hooks/use-scene-generator.ts#L686-L760),
[`lib/server/provider-config.ts:1112`](lib/server/provider-config.ts#L1112), `lib/server/agent-runtime/config.ts`,
[`lib/server/agent-runtime/runner.ts:1861`](lib/server/agent-runtime/runner.ts#L1861),
`lib/agent-runtime/stage-writer-tools.ts`,
[`app/api/agent/sessions/[id]/events/route.ts:52-60`](app/api/agent/sessions/[id]/events/route.ts#L52-L60),
[`lib/buffer/stream-buffer.ts:206-212`](lib/buffer/stream-buffer.ts#L206-L212), [`lib/video-export-app/timeline-deps.ts:112-114`](lib/video-export-app/timeline-deps.ts#L112-L114),
`render-service/src/{render-coordinator,resource-profile,config}.ts`,
`lib/chat/pi/config.ts`, `app/api/generate/scene-outlines-stream/route.ts`.

## Concurrency domains

Six domains. Nothing crosses a domain boundary without a queue, a semaphore or a
durable row in between.

```mermaid
flowchart TD
  subgraph D1["Browser: generation loop"]
    G1["lazyBoundedMap semaphore<br/>PARALLEL_SCENE_CONCURRENCY, clamped [0,10]"]
    G2["actions + TTS: STRICTLY SERIAL<br/>previousSpeeches chain"]
    G3["generateMediaForOutlines: serial, fire-and-forget beside the loop"]
    G1 --> G2
  end
  subgraph D2["Browser: playback"]
    P1["one PlaybackEngine per scene"]
    P2["StreamBuffer: ONE 30 ms tick loop"]
    P3["useDiscussionTTS queue: one segment at a time"]
    P2 --> P3
  end
  subgraph D3["Browser: export"]
    E1["module-level acquireExport() mutex"]
    E2["probe lanes: PROBE_CONCURRENCY 6, PROBE_TIMEOUT_MS 10 s"]
    E3["compile + emit + collect + zip: single-threaded"]
    E1 --> E2 --> E3
  end
  subgraph D4["Next server: request-scoped"]
    R1["one route handler per request, no shared mutable state"]
    R2["chat/pi: maxAgentTurns 6, maxActionsPerAgent 8"]
    R3["outline SSE: 512 KiB buffer, 3 attempts"]
  end
  subgraph D5["Next server: durable runner"]
    A1["scan every 1000 ms"]
    A2["maxConcurrent sessions = 2"]
    A3["per-session: leaseTtlMs 10 s heartbeat 2000 ms"]
    A4["stage writers: executionMode 'sequential'"]
    A1 --> A2 --> A3 --> A4
  end
  subgraph D6["render-service container"]
    S1["reserve(identity): maxQueue 20, maxJobsPerUser 1"]
    S2["extractionGate: maxConcurrentExtractions = 1"]
    S3["executionGate: maxConcurrency = 1"]
    S4["producerWorkers = 1, jobDeadlineMs 45 min"]
    S1 --> S2 --> S3 --> S4
  end
  D1 -->|"HTTP, one request per scene step"| D4
  D2 -->|"HTTP SSE"| D4
  D3 -->|"one 300 MiB upload"| D4
  D4 -->|"durable row + pg_notify"| D5
  D3 -->|"project.zip via the relay"| D6
```

## The parallelism primitive

`lazyBoundedMap` ([`lib/utils/concurrency.ts:47`](lib/utils/concurrency.ts#L47)) is the no-barrier primitive that
makes the generation pipeline's pipelining possible:

- returns one promise per item **immediately, in input order**, without awaiting;
- each item acquires a slot on a FIFO counting semaphore before `fn` runs;
- the caller may `await` in any order, and each resolves as soon as *its* work
  finishes while later items keep running;
- `limit` is clamped to `[1, items.length]`, so a raw or oversized value is safe;
- `shouldContinue` is checked **when an item reaches the front of the queue** —
  once false, the remaining items resolve to `undefined` without running `fn`.

`mapWithConcurrency` (`:68`) is the barrier form, and the doc comment tells you to
prefer the lazy one when results can be consumed incrementally.

```mermaid
flowchart LR
  I["pending outlines [1..5]"] --> LM["lazyBoundedMap(pending, 3, fetchContent)"]
  LM --> S["FIFO semaphore, max 3"]
  S --> C1["content(1) running"]
  S --> C2["content(2) running"]
  S --> C3["content(3) running"]
  S -.->|"queued"| C4["content(4)"]
  S -.->|"queued"| C5["content(5)"]
  LM --> PR["Promise[] returned immediately, in order"]
  PR --> L["serial for-loop awaits promise[i] IN ORDER"]
  L --> A["actions(i) — serial"]
  A --> T["TTS(i) — serial"]
  T --> AD["addScene(i)"]
  AD --> FR["a slot frees, content(4) starts"]
```

Effect: scene 1 paints after `content(1) + actions(1) + TTS(1)` — the same
latency as the fully serial loop — while `content(2..3)` run hidden behind scene
1's actions and TTS.

## What is serialised, and why

| Serialised thing | Where | Reason, from the source |
| --- | --- | --- |
| Scene **actions** and **TTS** | [`use-scene-generator.ts:698-706`](lib/hooks/use-scene-generator.ts#L698-L706) | preserve the `previousSpeeches` chain and the pause-on-failure UX |
| Media generation | [`lib/media/media-orchestrator.ts:41`](lib/media/media-orchestrator.ts#L41) | serial loop over tasks; runs beside the scene loop, never blocking it |
| Agent stage writers | [`lib/agent-runtime/stage-writer-tools.ts:20`](lib/agent-runtime/stage-writer-tools.ts#L20) → `executionMode: 'sequential'` | "so parallel writers cannot clobber each other (a consistency test pins the relation)" |
| SSE event polling on the agent tail | [`events/route.ts:260-272`](app/api/agent/sessions/[id]/events/route.ts#L260-L272) | `tick()` reschedules only after the previous poll **settles**, so a NOTIFY storm cannot stack reads |
| The 30 ms reveal loop | [`stream-buffer.ts:206-212`](lib/buffer/stream-buffer.ts#L206-L212) | "ONE source of pacing (this tick loop) — no double typewriter" |
| `render-service` execution | [`resource-profile.ts:26-30`](render-service/src/resource-profile.ts#L26-L30) | `maxConcurrency: 1` and `maxConcurrentExtractions: 1` in **both** profiles |
| Asset collector passes | [`asset-collector-schedule.ts:149-153`](lib/persistence/asset-collector-schedule.ts#L149-L153) | "a pass slower than the interval must not stack on itself; the next tick finds this one still running and skips" |
| Agent runner claim scan | [`runner.ts:1866-1868`](lib/server/agent-runtime/runner.ts#L1866-L1868) | `if (scanning \|\| ctx.shuttingDown) return` |
| Whiteboard runtime append | [`lib/whiteboard/runtime/store.ts:174`](lib/whiteboard/runtime/store.ts#L174) | the whole append runs under `withRuntimeStorageSharedLock` |

## What runs in parallel

| Parallel thing | Bound | Where |
| --- | --- | --- |
| Document extraction | **unbounded** — `Promise.all` over every attached source | [`app/generation-preview/page.tsx:340`](app/generation-preview/page.tsx#L340) |
| Scene content fetches | `PARALLEL_SCENE_CONCURRENCY`, clamped `[0, 10]` server-side, re-clamped twice more client-side | [`lib/server/provider-config.ts:1112`](lib/server/provider-config.ts#L1112), [`use-scene-generator.ts:689-695`](lib/hooks/use-scene-generator.ts#L689-L695) |
| Short-answer quiz grading | **unbounded** — `Promise.all` over every short-answer question | [`components/scene-renderers/quiz-view.tsx:807-811`](components/scene-renderers/quiz-view.tsx#L807-L811) |
| Audio + video duration probes | `PROBE_CONCURRENCY = 6`, each with a `PROBE_TIMEOUT_MS = 10_000` watchdog | [`lib/video-export-app/timeline-deps.ts:112-114`](lib/video-export-app/timeline-deps.ts#L112-L114) |
| Importer media uploads | `createConcurrencyLimiter(6)` | `packages/@openmaic/importer/src/import-pipeline/transformParsedToSlides.ts` |
| DI deps + quiz layout probe | 2-way `Promise.all` | [`build-export-zip.ts:95`](lib/video-export-app/build-export-zip.ts#L95) |
| Durable agent sessions | `maxConcurrent = 2` per application instance | [`lib/server/agent-runtime/config.ts:17`](lib/server/agent-runtime/config.ts#L17) |
| Render jobs per identity | `maxJobsPerUser = 1` (`RENDER_MAX_JOBS_PER_USER`) | `render-service/src/config.ts` |

The two **unbounded** rows are the ones to watch. Five attached documents means
five concurrent extractor calls, and a twelve-question short-answer quiz means
twelve concurrent LLM calls with no rate limiting anywhere in `app/api/**`.

## Queues and buffers, by location

```mermaid
flowchart TD
  subgraph client["Browser"]
    B1["lazyBoundedMap FIFO queue<br/>(unbounded length, bounded execution)"]
    B2["StreamBuffer items array<br/>UNBOUNDED — SSE pushes, tick drains at 1 char / 30 ms"]
    B3["useDiscussionTTS segment queue"]
    B4["runtimeWriter debounced draft (quiz)"]
    B5["scheduleCursorSave: 1000 ms debounce, last-write-wins"]
  end
  subgraph server["Next server"]
    Q1["outline SSE read buffer<br/>HARD CEILING 512 KiB, then finalise with what parsed"]
    Q2["agent event log: durable rows, read in 500-row pages"]
    Q3["classroom job row: polled every 5000 ms"]
  end
  subgraph svc["render-service"]
    R1["reserve(): pending counter"]
    R2["queue[]: maxQueue 20 total in-system"]
    R3["extractionGate semaphore: 1"]
    R4["executionGate semaphore: 1"]
  end
  B2 -.->|"the only unbounded in-memory queue<br/>with a slow drain"| RISK["a fast model outruns the reveal loop"]
```

`StreamBuffer` is worth naming precisely: SSE deltas append to `items` with no
cap, while the tick loop reveals **one character per 30 ms** (`charsPerTick = 1`,
`tickMs = 30`). A 2000-character agent turn therefore takes 60 seconds of
wall-clock reveal regardless of how fast the model produced it. The `shouldHold`
protocol adds *more* delay on top when TTS audio is still playing.

That is a deliberate presentation choice, not a bug — but it means the buffer is
the largest latency contributor in a live turn, and it is not tunable from any
env var found in the tree.

## Where the real bottlenecks are

```mermaid
flowchart TD
  T["a full generation-plus-playback run"] --> B1["1. Outline LLM call — one round trip,<br/>up to 3 whole-stream retries<br/>NOTHING downstream starts until 'done'"]
  B1 --> B2["2. Scene loop: actions + TTS serial<br/>N scenes x (actions latency + TTS latency)<br/>content parallelism cannot help this"]
  B2 --> B3["3. StreamBuffer reveal: 30 ms per character<br/>bounded by text length, not by the model"]
  B3 --> B4["4. render-service: maxConcurrency 1, producerWorkers 1<br/>one MP4 at a time per container, 45 min deadline"]
  B1 -.->|"secondary"| S1["review gate can hold indefinitely<br/>(or 2500 ms auto-continue)"]
  B2 -.->|"secondary"| S2["durable agent runner: maxConcurrent 2 per instance"]
  B4 -.->|"secondary"| S3["300 MiB upload over the relay,<br/>SUBMIT_TIMEOUT_MS 300 s"]
```

Ranked by what a staff engineer would actually measure:

1. **The outline call is a hard barrier.** It is one LLM request whose output the
   whole run depends on. Parallelising scenes cannot start before it resolves,
   and a zero-outline parse restarts the *entire* stream (up to 3 attempts).
2. **Actions + TTS serialisation dominates a multi-scene course.** With content
   parallelism on, the loop's wall-clock time is
   `Σ(actions_i + tts_i)` plus one `content_1`. Raising
   `PARALLEL_SCENE_CONCURRENCY` beyond ~3 buys almost nothing because the serial
   tail is unchanged.
3. **The 30 ms reveal loop** caps live-turn throughput at ~33 characters/second
   of visible text, independent of the model.
4. **`render-service` is single-slot by construction.** Both resource profiles
   pin `maxConcurrency: 1`, `maxConcurrentExtractions: 1`, `producerWorkers: 1`
   ([`resource-profile.ts:26-30`](render-service/src/resource-profile.ts#L26-L30)). Concurrency there is a deployment-count
   decision, not a config one.

## Backpressure, per boundary

| Boundary | Mechanism | On overload |
| --- | --- | --- |
| Browser → scene-content route | the semaphore itself — at most `n` requests in flight | requests queue client-side; the server sees at most `n` |
| Browser → `/api/quiz-grade` | **none** | every short-answer question fires at once |
| Browser → `/api/extract-document` | **none** | every attached document fires at once |
| Client → agent SSE tail | serialised polling + NOTIFY wakeup coalescing | a burst of events collapses into one 500-row page read |
| Client → render relay | `capBodyStream(req.body, 300 MiB)` | the stream aborts; the relay translates it to 413 |
| Relay → render-service | `coordinator.reserve(identity)` **before** buffering | 429 with `queue_full` or `per_identity_limit`; the body is never read |
| render-service internal | `extractionGate` then `executionGate` | requests wait with their body **unconsumed**, so only `maxConcurrentExtractions` bodies are buffered at once |
| Any route | **no rate limiting exists anywhere in `app/api/**`** | nothing |

The render-service ordering is the only place in the system that gets admission
control right: reserve → gate → buffer → extract → submit, with every failure
path releasing the reservation and cleaning the project directory
([`main.ts:322-330`](render-service/src/main.ts#L322-L330)).

## Timeline of a generation run

Illustrative shape, with real constants. Wall-clock values depend on the model.

```mermaid
timeline
  title Generation run, browser path, 5 scenes, PARALLEL_SCENE_CONCURRENCY 3
  section Ingestion
    unbounded parallel extract per attached document : buildDocumentBundle : storeImages
  section Outline
    one streamLLM call, SSE frames as outlines parse : 15 s heartbeat : 512 KiB ceiling : up to 3 whole-stream retries
  section Review gate
    reviewOutlineEnabled holds indefinitely : otherwise a 2500 ms auto-continue timer
  section Scene 1
    content 1 : actions 1 : TTS 1 : addScene 1 then push to the classroom route
  section Scenes 2 to 5
    content 2 to 4 prewarmed behind scene 1 : actions 2 : TTS 2 : addScene 2 : content 5 starts as a slot frees : repeat through scene 5
  section Beside the loop
    generateMediaForOutlines runs serially and fire-and-forget : never blocks the loop
  section Persistence
    saveToStorage before navigation : per-scene debounced saves afterwards
```

## Cancellation and epoch discipline

Three different cancellation mechanisms, one per domain. Confusing them is the
most common source of "why did this stale callback fire" bugs.

| Mechanism | Domain | Semantics |
| --- | --- | --- |
| `AbortController` / `AbortSignal` | HTTP requests, LLM streams, tool calls | standard; `AbortSignal.any([callerSignal, timeout(...)])` in `generateTTS` |
| `generationEpoch` (Zustand counter) | the generation loop | a stage switch bumps it; every step re-checks and reclaims fresh TTS allocations before breaking |
| `playbackGeneration` (instance counter) | `PlaybackEngine` | 20 guard call sites; every async continuation captures its generation and checks `isCurrentGeneration` |
| `sceneEpochRef` | `PlaybackChromeRoot` | discards stale `onLiveSpeech` / `onThinking` microtasks from the previous scene's buffer |
| `loadToken` | classroom load | `claimStageSceneLoadToken()` + `isCurrentStageSceneLoadToken` gate every write in `runClassroomLoad` |
| PG lease | durable agent runtime | `leaseTtlMs = 10_000`, heartbeat 2000 ms; a lost lease throws `AgentSessionLeaseLostError` from inside the transaction |

```mermaid
stateDiagram-v2
  [*] --> Work
  Work --> Cancelled: "AbortSignal — request-scoped, propagates into the provider"
  Work --> Superseded: "epoch or generation counter bumped"
  Work --> LeaseLost: "another worker claimed the session"
  Cancelled --> [*]: "fetch rejects, provider connection closed"
  Superseded --> Reclaimed: "removeFreshTtsAllocations, revokeObjectUrls"
  Reclaimed --> [*]: "callback returns without touching state"
  LeaseLost --> Requeued: "markLeaseLost, planUndeliveredRequeue"
  Requeued --> [*]
```

The counters are used *instead of* `AbortController` in the browser because the
work being cancelled is not a single request — it is a chain of state writes
across many awaits, and a counter check is cheaper and impossible to forget to
plumb through a callback.

## Open questions

- No committed configuration sets `PARALLEL_SCENE_CONCURRENCY`,
  `OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT`, or `RENDER_MAX_JOBS_PER_USER` above
  their defaults, so the tuned values for a real deployment are unknown.
- `StreamBuffer`'s `tickMs` and `charsPerTick` are constructor options
  ([`stream-buffer.ts:208-209`](lib/buffer/stream-buffer.ts#L208-L209)) but no caller found in this trace overrides them,
  and no env var reaches them.
- The two unbounded `Promise.all` fan-outs (document extraction, quiz grading)
  have no recorded rationale — unlike the scene loop, whose comment explains
  exactly why the knob is server-side ("many deployments use API keys with low
  per-key concurrency quotas, where a bursty default would surface as 429s",
  [`provider-config.ts:1108-1110`](lib/server/provider-config.ts#L1108-L1110)).

## Related

- [`02-topic-to-classroom.md`](docs/11-data-flows/02-topic-to-classroom.md) — the loop these bounds govern.
- [`06-edit-with-ai.md`](docs/11-data-flows/06-edit-with-ai.md) — leases and sequential writers in context.
- [`08-export-video.md`](docs/11-data-flows/08-export-video.md) — the render-service gates in their flow.
- [`../15-cross-cutting/index.md`](docs/15-cross-cutting/index.md) — rate limiting, retries and timeouts as cross-cutting concerns.
