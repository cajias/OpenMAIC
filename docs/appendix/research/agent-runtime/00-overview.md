# Agent runtime — overview

Survey of the agent loop, tool calling, orchestration and skills subsystem of
OpenMAIC. Everything below was read out of the working tree at commit
`c2c9553a` (`git log --oneline -1`).

## Charter

There are **two independent agent runtimes** in this repo. They share one
harness (`@earendil-works/pi-agent-core` 0.78.0, [`package.json:52-53`](package.json#L52-L53)) and one
LLM adapter (`lib/agent/runtime/stream-fn.ts`), and nothing else.

| Runtime | Purpose | Lifetime owner | Entry |
| --- | --- | --- | --- |
| **Durable background runtime** ("agent runtime", "workbench agent") | One long-lived authoring conversation that builds and edits classroom *stage documents*. Survives worker death, deploys and client disconnects. | PostgreSQL lease + `startAgentRunner()` timer ([`lib/server/agent-runtime/runner.ts:1861`](lib/server/agent-runtime/runner.ts#L1861)) | [`instrumentation.ts:49`](instrumentation.ts#L49) |
| **In-class chat runtime** ("Pi chat", "director loop") | The multi-agent classroom conversation the *student* sees: a director LLM delegates turns to teacher/assistant/student personas that speak and drive the slide + whiteboard. Request-scoped, fully stateless server-side. | The HTTP request (`req.signal`) | [`app/api/chat/pi/route.ts:42`](app/api/chat/pi/route.ts#L42) → [`lib/chat/pi/director-loop.ts:29`](lib/chat/pi/director-loop.ts#L29) |

A third, older path still ships: the LangGraph `StateGraph` director in
[`lib/orchestration/director-graph.ts:484`](lib/orchestration/director-graph.ts#L484), driven by [`app/api/chat/route.ts:44`](app/api/chat/route.ts#L44)
via `statelessGenerate` ([`lib/orchestration/stateless-generate.ts:392`](lib/orchestration/stateless-generate.ts#L392)). It
produces the same `StatelessEvent` SSE protocol as the Pi path, so the browser
loop ([`lib/chat/agent-loop.ts:154`](lib/chat/agent-loop.ts#L154)) drives either one. `NEXT_PUBLIC_PI_CHAT_ENABLED`
selects which ([`lib/config/feature-flags.ts:72`](lib/config/feature-flags.ts#L72)).

[`lib/action/engine.ts:178`](lib/action/engine.ts#L178) (`ActionEngine`) is the client-side executor for
whatever the classroom agents emit — it is the sink for both classroom paths.

## Internal parts

```mermaid
flowchart TD
  subgraph HARNESS["Shared harness (lib/agent/)"]
    BA["buildAgent()<br/>lib/agent/runtime/build-agent.ts:65"]
    SF["createCallLlmStreamFn()<br/>lib/agent/runtime/stream-fn.ts:250"]
    TT["withAgentToolTimeout()<br/>lib/agent/runtime/tool-timeout.ts:98"]
    AL["makeAllowlistGate()<br/>lib/agent/runtime/allowlist.ts:5"]
    RNC["runNativeChild()<br/>lib/agent/runtime/run-native-child.ts:189"]
    BA --> TT
    BA --> AL
    RNC --> BA
  end

  subgraph DURABLE["Durable background runtime (lib/server/agent-runtime/)"]
    SCAN["startAgentRunner() scan loop<br/>runner.ts:1861"]
    RUN["runSession()<br/>runner.ts:889"]
    TOOLS["assembleRunnerTools()<br/>runner-contract.ts:7"]
    SKILLS["listSkills / buildSkillPreload<br/>skills.ts:211, skill-preload.ts:224"]
    TREE["AgentSessionEntryStorage<br/>entry-tree-storage.ts:163"]
    SCAN --> RUN
    RUN --> TOOLS
    RUN --> SKILLS
    RUN --> TREE
    RUN --> BA
  end

  subgraph CLASSROOM["In-class runtime (lib/chat/)"]
    DL["runPiDirectorLoop()<br/>lib/chat/pi/director-loop.ts:29"]
    CA["call_agent tool<br/>lib/chat/pi/tools/call-agent.ts:531"]
    WB["wb_* whiteboard tools<br/>lib/chat/pi/tools/native-whiteboard.ts:662"]
    DC["director compaction<br/>lib/chat/pi/director-compaction.ts:106"]
    DL --> CA
    CA --> RNC
    CA --> WB
    DL --> DC
    DL --> BA
  end

  subgraph LEGACY["LangGraph path (lib/orchestration/)"]
    DG["createOrchestrationGraph()<br/>director-graph.ts:484"]
    SG["statelessGenerate()<br/>stateless-generate.ts:392"]
    REG["useAgentRegistry<br/>registry/store.ts:207"]
    SG --> DG
    DG --> REG
  end

  subgraph HTTP["Control plane (app/api/)"]
    R1["POST /api/agent/sessions"]
    R2["GET /api/agent/sessions/:id/events (SSE)"]
    R3["POST /api/agent/sessions/:id/messages"]
    R4["POST /api/agent/sessions/:id/cancel"]
    R5["POST /api/chat/pi"]
    R6["POST /api/chat"]
  end

  PG[("PostgreSQL<br/>agent session store + entry tree")]
  R1 --> PG
  R3 --> PG
  R4 --> PG
  PG --> SCAN
  RUN --> PG
  PG --> R2
  R5 --> DL
  R6 --> SG
  BA --> SF
```

## Client / server split at a glance

```mermaid
flowchart LR
  subgraph BROWSER["Browser"]
    WSTREAM["useWorkbenchStream()<br/>lib/workbench/use-workbench-session.ts:107"]
    ALOOP["runAgentLoop()<br/>lib/chat/agent-loop.ts:154"]
    AENG["ActionEngine<br/>lib/action/engine.ts:178"]
    PRES["presentTool()<br/>components/workbench/chat/tool-presentation.ts:271"]
  end
  subgraph SERVER["Node server"]
    RUNNER["Agent runner (background timer)"]
    PIROUTE["/api/chat/pi (request-scoped)"]
  end
  DB[("PostgreSQL")]

  WSTREAM -->|"EventSource, Last-Event-ID"| DB
  RUNNER --> DB
  WSTREAM --> PRES
  ALOOP -->|"POST per iteration, SSE"| PIROUTE
  PIROUTE -->|"StatelessEvent frames"| ALOOP
  ALOOP --> AENG
```

The asymmetry is deliberate and load-bearing: the durable runtime never streams
to a client at all — it writes durable events, and the browser reads the log.
The classroom runtime has no durable log; the browser holds all state and
re-posts it every iteration ([`lib/chat/agent-loop.ts:181-192`](lib/chat/agent-loop.ts#L181-L192)).

## File inventory

Measured with
`find <dir> -type f | xargs wc -l | sort -rn` and
`for d in …; do printf '%s ' $d; find $d -type f | xargs cat | wc -l; done`.

| Directory | Lines | Role |
| --- | --- | --- |
| `lib/server/agent-runtime/` | 16154 | Durable runner, the whole server tool catalogue, skills loader, session store binding |
| `lib/chat/` | 6025 | In-class Pi director loop, classroom tools, prompts, browser agent loop |
| `skills/` | 6801 | 23 builtin agent-runtime skills + the `openmaic` external-driver skill |
| `components/workbench/chat/` | 5024 | Chat fold rendering: tool cards, thinking bars, question cards |
| `lib/orchestration/` | 3477 | LangGraph director graph, agent registry, prompt builders, summarizers |
| `components/agent/` | 1544 | Agent bar / config panel / reveal modal (classroom roster UI) |
| `lib/agent/` | 1537 | Shared harness: `buildAgent`, stream adapter, tool timeout, native child |
| `app/api/agent/` | 1245 | Durable-runtime control plane (sessions, events, messages, cancel, skills) |
| `lib/action/` | 902 | `ActionEngine` — client-side executor for classroom actions |
| `app/api/chat/` | 568 | `/api/chat` (LangGraph) and `/api/chat/pi` (Pi director) |
| `lib/agent-runtime/` | 175 | Isomorphic contracts: lifecycle event names, stage-writer registry |
| `app/api/skills/` | 49 | Skill zip export |

### Largest modules

| File | Lines |
| --- | --- |
| `lib/server/agent-runtime/runner.ts` | 1923 |
| `lib/chat/pi/tools/native-whiteboard.ts` | 1113 |
| `lib/chat/pi/tools/call-agent.ts` | 1004 |
| `components/workbench/chat/tool-presentation.ts` | 1002 |
| `lib/server/agent-runtime/dsl-tools.ts` | 994 |
| `components/agent/agent-bar.tsx` | 941 |
| `lib/action/engine.ts` | 902 |
| `lib/server/agent-runtime/skills.ts` | 895 |
| `skills/agent-runtime/slide-dsl/SKILL.md` | 892 |

## This pack

Thirteen files. Every row links, so this table is the pack's navigation as well as its
manifest.

| File | Contents |
| --- | --- |
| `00-overview.md` | this file |
| [`01a-modules-server.md`](docs/appendix/research/agent-runtime/01a-modules-server.md) | durable runtime modules, path:line anchors |
| [`01b-modules-classroom.md`](docs/appendix/research/agent-runtime/01b-modules-classroom.md) | classroom runtime + orchestration + client modules |
| [`02-interfaces.md`](docs/appendix/research/agent-runtime/02-interfaces.md) | verbatim public types: harness, runner, recovery, skills |
| [`02b-tool-catalogue.md`](docs/appendix/research/agent-runtime/02b-tool-catalogue.md) | every registered tool, what it mutates, how it is authorised |
| [`02c-interfaces-tools-and-events.md`](docs/appendix/research/agent-runtime/02c-interfaces-tools-and-events.md) | verbatim types: tool layer and classroom |
| [`02d-durable-events.md`](docs/appendix/research/agent-runtime/02d-durable-events.md) | the durable event vocabulary, write channels, and storage shape |
| [`03-flows.md`](docs/appendix/research/agent-runtime/03-flows.md) | traced flows through the durable runtime |
| [`03b-flows-classroom-and-external.md`](docs/appendix/research/agent-runtime/03b-flows-classroom-and-external.md) | traced flows: in-class round, and the external `openmaic` skill driver |
| [`04-dependencies-and-config.md`](docs/appendix/research/agent-runtime/04-dependencies-and-config.md) | packages, env vars, config resolution |
| [`05-failure-modes.md`](docs/appendix/research/agent-runtime/05-failure-modes.md) | error handling and failure behaviour |
| [`06-quality-and-metrics.md`](docs/appendix/research/agent-runtime/06-quality-and-metrics.md) | quality observations, measured numbers with commands |
| [`07-open-questions.md`](docs/appendix/research/agent-runtime/07-open-questions.md) | what could not be determined |

Nothing was omitted: the subsystem has real content for every section. Pack→topic mapping
and the shared chapter convention: [`../index.md`](docs/appendix/research/index.md).
