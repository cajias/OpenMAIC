# 10 — Quiz attempt and PBL v2 task session

Two learner-assessment flows. The quiz is short and mostly local; the PBL v2
session is a stateless-server design where the client POSTs the whole project
and applies patches. Both are graded by an LLM at some point, and both have a
silent-fallback edge worth knowing.

**Sources:** `components/scene-renderers/quiz-view.tsx`, `lib/quiz/grading.ts`,
`lib/quiz/runtime.ts`, `lib/quiz/persistence.ts`, `lib/quiz/view-state.ts`,
`app/api/quiz-grade/route.ts`, `app/api/pbl/v2/task/update/route.ts`,
`app/api/pbl/v2/{open-task,evaluate,instructor,simulator}/route.ts`,
`lib/pbl/v2/api/sse.ts`, `lib/pbl/v2/agents/instructor.ts`,
`packages/@openmaic/generation/src/pbl/operations/kernel/task-completion.ts`,
`lib/pbl/v2/operations/kernel/progress.ts`, `lib/pbl/legacy/read.ts`;
`../appendix/research/classroom-runtime/03b-flows-scenes-and-pbl.md`,
`../appendix/research/generation-pipeline/03b-flows-scenes-and-quiz.md`.

## Flow A — quiz attempt to feedback

### Phase machine

```mermaid
stateDiagram-v2
  [*] --> loading: "loadQuizAttemptState for this stage and scene"
  loading --> not_started: "runtimeGate ready, attempt has no answers"
  loading --> reviewing: "runtimeGate ready, attempt already reviewed"
  loading --> error: "hydration threw, runtimeGate set to error"
  not_started --> answering: "learner clicks Start"
  answering --> answering: "handleSetAnswer -> writeDraftRecovery + scheduleDraft"
  answering --> submitting: "handleSubmit (blocked when attemptId is null)"
  submitting --> grading: "persistQuizSubmission succeeded"
  submitting --> error: "persistence threw"
  grading --> reviewing: "results merged and persistQuizReview succeeded"
  grading --> error: "persistQuizReview threw"
  reviewing --> not_started: "handleRetry -> persistQuizRetry"
```

Every phase transition is gated on persistence succeeding first. `handleSubmit`
returns immediately when `attemptId` is null (`quiz-view.tsx:783`), so a quiz
whose runtime never hydrated cannot be submitted at all.

### Sequence

```mermaid
sequenceDiagram
  autonumber
  participant L as "Learner"
  participant QV as "QuizView"
  participant RT as "lib/quiz/runtime.ts"
  participant SS as "sessionStorage draft recovery"
  participant RS as "RuntimeStore"
  participant GC as "gradeChoiceQuestions (local)"
  participant API as "POST /api/quiz-grade"
  participant M as "LLM"

  QV->>RT: "loadQuizAttemptState({stageId, sceneId})"
  RT->>RS: "read the attempt record"
  RT-->>QV: "{ attemptId, state } -> quizViewStateFromAttempt"
  loop "per answer change"
    L->>QV: "select or type an answer"
    QV->>SS: "writeDraftRecovery(sceneId, attemptId, next)"
    QV->>RT: "runtimeWriter.scheduleDraft({stageId, sceneId, attemptId, answers})"
  end
  L->>QV: "Submit"
  QV->>RT: "persistQuizSubmission(...) then phase 'grading'"
  QV->>GC: "gradeChoiceQuestions(questions, answers)"
  GC-->>QV: "results for every non-short-answer question, instantly"
  QV->>API: "Promise.all over questions.filter(isShortAnswer)"
  API->>API: "validate question, userAnswer, points (positive finite)"
  API->>API: "resolveModelFromRequest(req, body, 'quiz-grade')"
  API->>M: "callLLM(system pinning {\"score\": n, \"comment\": s}, userPrompt)"
  M-->>API: "text"
  API->>API: "first /\\{[\\s\\S]*\\}/ match then JSON.parse"
  API-->>QV: "{ score, comment }"
  QV->>QV: "merge into original question order"
  QV->>RT: "persistQuizReview(...) then phase 'reviewing'"
```

### Hop table

| # | Where | Call | Notes |
| --- | --- | --- | --- |
| 1 | `quiz-view.tsx:727` | `loadQuizAttemptState({stageId, sceneId})` | a throw sets `runtimeGate: 'error'` and the quiz is unusable, not silently local |
| 2 | `quiz-view.tsx:763-780` | `handleSetAnswer` | writes **two** places: a `sessionStorage` recovery key and a debounced `RuntimeStore` draft |
| 3 | `quiz-view.tsx:782-794` | `handleSubmit` | `persistQuizSubmission` **before** phase `grading` — grading never runs on unpersisted answers |
| 4 | `lib/quiz/grading.ts:34` | `gradeChoiceQuestions(questions, answers)` | exact set comparison via `arraysEqual` (order-insensitive, sorted); `earned = correct ? points : 0` |
| 5 | `lib/quiz/grading.ts:29` | `isShortAnswer(q)` | classification is by **`type === 'short_answer'` only** — "an unanswered choice question (empty `answer`) is still a choice question and must not be re-routed to AI grading. `hasAnswer` does not override the type" |
| 6 | `quiz-view.tsx:807-811` | `Promise.all` over the short-answer questions | fully parallel, one request each; no concurrency bound |
| 7 | `app/api/quiz-grade/route.ts:37-44` | validation | missing `question`/`userAnswer` ⇒ 400; `points` must be a positive finite number ⇒ 400 |
| 8 | `route.ts:55-69` | prompt | two hardcoded variants selected by `language === 'zh-CN'`; the system prompt pins `{"score": <0..points>, "comment": …}` |
| 9 | `route.ts:88-94` | parse | first `{…}` regex match, then `JSON.parse`; score clamped to `[0, points]` and rounded |
| 10 | `route.ts:95-103` | **fallback** | any parse failure ⇒ `score = round(points × 0.5)` with a generic comment, returned as a **200 success** |
| 11 | `quiz-view.tsx:123-130` | client-side clamp | re-clamps to `[0, pts]`; `correct = earned >= pts * 0.8` |
| 12 | `quiz-view.tsx:131-144` | client-side fallback | a non-OK response or a throw also yields `round(pts * 0.5)`, with `correct: null` and a "grading service unavailable" comment |
| 13 | `quiz-view.tsx:826-838` | `persistQuizReview` then `setResults` + phase `reviewing` | a persistence failure sets `runtimeGate: 'error'` and the results are **not** shown |

### Two independent 50 % fallbacks

```mermaid
flowchart TD
  S["short-answer submission"] --> R["POST /api/quiz-grade"]
  R --> LLM["callLLM"]
  LLM --> P{"first {...} match parses?"}
  P -->|yes| C["score clamped to 0..points, rounded"]
  P -->|no| F1["SERVER fallback: round(points * 0.5)<br/>route.ts:95-103 — returned as 200"]
  R -->|"non-OK, or fetch threw"| F2["CLIENT fallback: round(pts * 0.5), correct: null<br/>quiz-view.tsx:131-144"]
  C --> M["merge with local choice results"]
  F1 --> M
  F2 --> M
  M --> RV["reviewing phase"]
```

The server-side one is the sharper edge: it returns HTTP 200 with a
plausible-looking score, so neither the client nor the learner can distinguish
"the model graded this at 50 %" from "the model's output was unparseable". The
client-side fallback at least sets `correct: null` and says so in the comment.

The distinction matters because the two thresholds interact: `correct` is
`earned >= pts * 0.8`, and a 50 % fallback therefore always reports *incorrect*
on a question the learner may have answered perfectly.

## Flow B — a PBL v2 task session

### The stateless-server contract

```mermaid
flowchart LR
  C["Client owns PBLProjectV2<br/>(scene.content.projectV2 + learner runtime state)"] -->|"POST the whole project"| S["/api/pbl/v2/* (4 routes)"]
  S -->|"SSE: token, tool_call, project_patch, sim_phase, reset_draft, error, done"| C
  C -->|"applyInstructorEvent -> apply patches"| C
  C -->|"drainProjectRuntime (at-least-once, id-deduped)"| RS[("RuntimeStore")]
  C -->|"document save"| DS[("DocumentStore")]
  DS -.->|"synchronizePBLProjectRuntime then stripToDesignTemplate"| STRIP["learner state REMOVED from scene.content.projectV2"]
```

`PBLSSEEvent` (`lib/pbl/v2/api/sse.ts:168`) is the **only formally typed SSE
event union in the whole HTTP surface** — seven variants, six `project_patch`
kinds. Every other stream in OpenMAIC agrees by convention.

`createSSEResponse` (`:211`) adds a 15 s `: keepalive` heartbeat and
`X-Accel-Buffering: no`, and guarantees that a generator throw still emits an
`error` frame followed by `done` before closing (`:265-273`).

### Sequence — submission to the next task

```mermaid
sequenceDiagram
  autonumber
  participant L as "Learner"
  participant Sub as "pbl/v2/submission.tsx"
  participant WS as "pbl/v2/workspace.tsx"
  participant Chat as "pbl/v2/chat.tsx"
  participant Ev as "POST /api/pbl/v2/evaluate"
  participant Up as "POST /api/pbl/v2/task/update"
  participant Open as "POST /api/pbl/v2/open-task"
  participant K as "progress.ts + task-completion.ts"
  participant RS as "RuntimeStore"

  L->>Sub: "submit text / file / link (a PDF goes through POST /api/parse-pdf first)"
  Sub->>Ev: "SSE { project, kind:'task', milestoneId, microtaskId }"
  Ev->>Ev: "hasVision = !!modelInfo?.capabilities?.vision — an image submission can reach a vision model"
  Ev-->>Sub: "token stream, then project_patch kind='evaluation'"
  Sub->>Sub: "latestTaskEvaluation(...) — trackSubmissionScore(score) feeds the proficiency EWMA"
  alt "score >= TASK_EVAL_PASS_SCORE (60)"
    Sub->>K: "recordPendingTaskCompletionEvidence + setPendingTaskCompletion"
    K->>K: "appendRuntimeEvent kind='task_completion_staged'"
    Sub->>Chat: "appendTaskCompletionReadyMessage (localized, deduped by content)"
    Note over L,WS: "GATE 2 — the learner must click Done"
    L->>WS: "click Done"
    WS->>Up: "{ action: 'complete_pending_task' }"
    Up->>K: "currentMicrotask -> currentPendingTaskCompletion -> advanceMicrotask"
    K-->>Up: "{ milestoneCompleted, projectCompleted, nextMicrotaskId }"
    Up->>K: "appendTaskDividerMessage"
    Up-->>WS: "the mutated project + flags"
    alt "milestoneCompleted"
      WS->>Ev: "kind='milestone'"
      Ev-->>WS: "project_patch evaluation + project_patch handover"
      Note over L,WS: "GATE 3 — a milestone boundary needs Continue"
      L->>WS: "click Continue"
      WS->>Up: "{ action: 'continue_handover' }"
    else "another task in this milestone"
      WS->>Open: "{ phase: 'setup' }"
      Open-->>Chat: "instructor opener tokens"
    end
    opt "projectCompleted"
      WS->>Ev: "kind='final'"
      Ev-->>WS: "final evaluation -> uiPhase 'completed'"
    end
  else "score < 60"
    Sub->>Chat: "buildRevisionGuidanceMessage -> revision hint in the instructor thread"
  end
  WS->>RS: "drainProjectRuntime (two device-scoped watermarks)"
```

### The three-gate completion chain

Task completion is deliberately **not** something the instructor agent can do.

```mermaid
flowchart TD
  E["task evaluation returns a score"] --> G1{"taskEvaluationCanComplete?<br/>kind == 'task' AND typeof score == 'number'<br/>AND score >= 60"}
  G1 -->|no| REV["buildRevisionGuidanceMessage -> revision hint, task stays open"]
  G1 -->|yes| ST["setPendingTaskCompletion + task_completion_staged runtime event<br/>task-completion.ts:53"]
  ST --> RDY["appendTaskCompletionReadyMessage — localized in 6 languages"]
  RDY --> G2{"learner clicks Done in the sidebar"}
  G2 --> UP["POST task/update action='complete_pending_task'"]
  UP --> AD["advanceMicrotask: refuse already_terminal,<br/>clearPendingTaskCompletion, status -> completed,<br/>FREEZE microtask.engagement, activate the next todo"]
  AD --> G3{"milestoneCompleted?"}
  G3 -->|no| NEXT["open-task phase='setup' for the next task"]
  G3 -->|yes| HO["milestone eval + staged PBLHandover"]
  HO --> G4{"learner clicks Continue"}
  G4 --> CAH["continueAfterHandover -> unlock the next milestone"]
```

The instructor agent has exactly **two** non-advance tools —
`record_observation` and `adjust_difficulty` — and cannot advance a task at all
(`lib/pbl/v2/agents/instructor.ts`). Tools are attached only when
`phase === 'instructing' && !scenarioPrepStage` (`instructor.ts:1500`).

`setPendingTaskCompletion` preserves the original `createdAt` when re-staging the
same microtask (`task-completion.ts:63-71`), so a re-evaluation does not restart
the clock. `appendTaskCompletionReadyMessage` dedupes by exact content match on
the same `microtaskId` (`:131-134`), which is also why
`TASK_COMPLETION_READY_TEXTS` is a precomputed set of all six localizations
(`:104-112`) — so a language switch mid-session cannot produce a duplicate.

### `/api/pbl/v2/task/update`: five actions, zero LLM

| Action | Precondition | Effect |
| --- | --- | --- |
| `start` | `microtaskId` present | `startMicrotask(project, id)` |
| `continue_handover` | a pending handover exists | `continueAfterHandover`; 400 `'No pending handover to consume.'` otherwise |
| `complete_pending_task` | an active microtask **and** a matching `pendingTaskCompletion` | `advanceMicrotask(project, id, pending.reason, pending.assessment ?? {})` + `appendTaskDividerMessage` |
| `enter_scenario` | `project.scenario` set **and** the active milestone's `scenarioStage === 'prep'` | completes the prep microtask, seals the milestone, then consumes the handover in one call — no LLM, no milestone eval |
| `complete_act` | `project.scenario` set | `completeRoleplayAct(project, 'act_completed_by_learner')` — completes the whole roleplay milestone at once; per-beat achievement is scored later by the final evaluator |

Both scenario actions are *strictly gated* so "it can never affect ordinary
projects" (`route.ts:118-119`, `:147-148`). `maxDuration = 60` despite no LLM
call.

## Persistence points

| Point | Store | Written when |
| --- | --- | --- |
| Quiz draft recovery | `sessionStorage` (`quizDraft:` / `quizAnswers:` / `quizResults:` / `quizAttemptId:` prefixes, `lib/quiz/persistence.ts:19-22`) | synchronously on every answer change |
| Quiz attempt | `RuntimeStore` via `createQuizAttemptWriter` | debounced draft, then on submit and on review; flushed on unmount (`quiz-view.tsx:717-721`) |
| PBL runtime events | `RuntimeStore` via `drainProjectRuntime` | at-least-once, id-deduped, behind two device-scoped watermarks |
| PBL document | `DocumentStore` | `synchronizePBLProjectRuntime` then `stripToDesignTemplate` — learner state is **removed** from `scene.content.projectV2` before the save |

That last row is the design's load-bearing separation: the *document* holds the
project template, the *runtime store* holds one learner's progress through it.

## Failure modes

| Failure | Posture | Where |
| --- | --- | --- |
| Quiz runtime hydration throws | `runtimeGate: 'error'` — the quiz refuses to run rather than grading unpersistably | `quiz-view.tsx:736-739` |
| `persistQuizSubmission` throws | phase stays `submitting`, `runtimeGate: 'error'` | `quiz-view.tsx:789-792` |
| `persistQuizReview` throws | results computed but **not displayed**; `runtimeGate: 'error'` | `quiz-view.tsx:831-835` |
| LLM grading output unparseable | **silent 50 %**, HTTP 200 | `app/api/quiz-grade/route.ts:95-103` |
| `/api/quiz-grade` returns 5xx | client-side 50 % with `correct: null` and an explicit comment | `quiz-view.tsx:131-144` |
| PBL: no active microtask | `error NO_ACTIVE_MICROTASK` + `done` frame | `lib/pbl/v2/agents/instructor.ts:1306` |
| PBL: instructor generator throws | `createSSEResponse` emits `error` then `done` before closing | `lib/pbl/v2/api/sse.ts:265-273` |
| PBL: `advanceMicrotask` refuses | 400 `'Could not complete task: <error>'` | `app/api/pbl/v2/task/update/route.ts:91-93` |
| PBL: client aborts | `signal` listener calls `safeClose()`; the generator is abandoned | `sse.ts:237-246` |
| Legacy PBL project | read-time upgrade to a synthetic v2 project for rendering, **never persisted back** — progress on an upgraded v1 project is lost from the document | `lib/pbl/legacy/read.ts` |

## Open questions

- The 50 % grading fallback (`quiz-grade/route.ts:96-103`) has **no test
  coverage** according to the generation-pipeline evidence pack, and no telemetry
  distinguishes it from a real 50 % score.
- `correct = earned >= pts * 0.8` (`quiz-view.tsx:126`) is a hardcoded threshold
  that appears nowhere else and is not configurable per question.
- The legacy-PBL upgrade path is read-only-reachable but the write side is
  absent; whether any deployment still holds v1 projects is unknown from the tree.

## Related

- [`04-scene-playback.md`](./04-scene-playback.md) — how a `quiz` or `pbl` scene is reached, and why auto-advance refuses to leave one.
- [`02-topic-to-classroom.md`](./02-topic-to-classroom.md) — how quiz questions and PBL projects are generated.
- `../08-classroom-runtime/index.md` — the PBL v2 component structure and its scenario model.
