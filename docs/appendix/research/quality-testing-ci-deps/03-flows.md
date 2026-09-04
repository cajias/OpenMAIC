# 03 — Traced end-to-end flows

Four flows, each traced by reading the workflow YAML and the scripts it invokes,
naming real functions in the order they execute.

---

## Flow 1 — A pull request reaches the merge gate

Trigger: `pull_request` targeting `main` (or one of five named feature/integration
branches), `.github/workflows/ci.yml:10-19`. All three jobs start in parallel;
this trace follows `check`.

| # | Hop | Where | Notes |
| --- | --- | --- | --- |
| 1 | `actions/checkout@v4` with `fetch-depth: 0` | `ci.yml:34-36` | Full history is required by the version gate's `merge-base` |
| 2 | `scripts/ci-run-parallel.sh ok true ok2 true`, then `… ok true bad 'exit 7'` inverted | `ci.yml:41-50` | Bash-only self-test before any install; `CI_PARALLEL_ANNOTATE=0` |
| 3 | `pnpm/action-setup@v4`, `actions/setup-node@v4` `node-version: 22`, `cache: pnpm` | `ci.yml:52-57` | |
| 4 | `node scripts/check-package-version-bumps.mjs "$BASE_SHA"` | `ci.yml:61` | `runDiffMode(base)` → `assertPackageListIsComplete()` → per-package `publishableInputsChanged()` → `readVersion()` / `compareVersions()` → `checkDslFormatVersionRule(base, mergeBaseWithHead(base), failures)` |
| 5 | `node scripts/check-internal-dependency-ranges.mjs` | `ci.yml:89` | `assertPackageListIsComplete()` first and fatally, then `workspace:^` / forbidden-field / bidirectional `INTERNAL_DEPENDENTS` checks |
| 6 | `pnpm install --frozen-lockfile` | `ci.yml:91` | Runs the 8-step `postinstall` chain (`package.json:10`) |
| 7 | `pnpm check:node-engine` | `ci.yml:94` | `semver.minVersion(root engines.node)` vs every installed direct dependency's `engines.node` |
| 8 | `git --no-replace-objects rev-parse HEAD` == `$GITHUB_SHA`, then `git --no-replace-objects diff --quiet "$GITHUB_SHA" -- packages/@openmaic` | `ci.yml:107-121` | Catches a stale generated file that `postinstall` rewrote (renderer's `fonts.css`, KaTeX font snapshot) |
| 9 | `scripts/ci-run-parallel.sh prettier 'pnpm check' eslint 'pnpm lint' tsc 'npx tsc --noEmit' i18n 'pnpm check:i18n-keys'` | `ci.yml:126-131` | The only parallel step; ESLint is the bound |
| 10 | `pnpm test` | `ci.yml:137` | Root Vitest — the root `tests/` suite only: 666 files / 6 385 cases, not the 837-file repo-wide set. All 5 app-level `*.pg.test.ts` skip (no database) |
| 11 | `pnpm --filter @openmaic/importer test`, then `dsl test` | `ci.yml:140-143` | |
| 12 | `generation typecheck` → `generation test` | `ci.yml:146-149` | `typecheck` chains `tsconfig.json` and `tsconfig.test.json` |
| 13 | Node consumer smoke: boot `scripts/generation-node-smoke-server.mjs --port 43127`, poll `/health` up to 50× at 100 ms, run `scripts/generation-node-smoke.mjs`, assert `outlines.length > 0 && scene && sceneValidation.valid === true` | `ci.yml:151-178` | Proves `@openmaic/generation` works in plain Node with no Next.js |
| 14 | `storage typecheck` (incl. tests) → `storage test` | `ci.yml:183-187` | Storage's `*.pg.test.ts` skip here; the contract job covers them |

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub Actions
  participant Runner as ubuntu-latest
  participant Parallel as ci-run-parallel.sh
  participant Ver as check-package-version-bumps.mjs
  participant Dep as check-internal-dependency-ranges.mjs
  participant Pkg as openmaic-packages.mjs
  participant Git as git no-replace-objects
  participant Vitest as vitest run

  GH->>Runner: checkout fetch-depth 0
  Runner->>Parallel: "ok true ok2 true" then inverted "bad exit 7"
  Parallel-->>Runner: 0 then 1 (expected)
  Runner->>Ver: runDiffMode(BASE_SHA)
  Ver->>Pkg: assertPackageListIsComplete()
  Pkg-->>Ver: problems[]
  Ver->>Ver: publishableInputsChanged(name, base)
  Ver->>Ver: checkDslFormatVersionRule(baseTip, mergeBase)
  Ver-->>Runner: exit 0
  Runner->>Dep: check workspace:^ shape
  Dep->>Pkg: assertPackageListIsComplete()
  Dep-->>Runner: exit 0
  Runner->>Runner: pnpm install --frozen-lockfile (postinstall x8)
  Runner->>Git: diff GITHUB_SHA -- packages/@openmaic
  Git-->>Runner: clean
  Runner->>Parallel: "prettier / eslint / tsc / i18n"
  Parallel-->>Runner: 4 grouped logs, exit 0
  Runner->>Vitest: pnpm test (666 files)
  Vitest-->>Runner: pass, pg suites skipped
  Runner->>Vitest: importer, dsl, generation, storage
  Vitest-->>Runner: pass
```

The step at hop 8 is the subtlest in the whole file. Its comment
(`ci.yml:101-106`) explains the choice of `$GITHUB_SHA` over `HEAD` or the index:
"a bare `git diff` misses staged changes, while install code can create a commit
and move HEAD. This check exists precisely because code ran before it, so its
reference point must be something that code cannot move." `--no-replace-objects`
additionally defeats a local `replace` ref.

---

## Flow 2 — A merged version bump becomes an npm release

Trigger: `push` to `main` touching any of the six
`packages/@openmaic/*/package.json` paths
(`.github/workflows/publish-packages.yml:39-47`). Concurrency group is
`publish-openmaic` — repository-wide, *not* keyed on ref, so two runs cannot each
independently decide a version is unpublished (lines 56-60).

| # | Hop | Job | Where |
| --- | --- | --- | --- |
| 1 | checkout, `persist-credentials: false` | validate | `:99-101` |
| 2 | `postgres:16` service comes up with `pg_isready` health check | validate | `:85-97` |
| 3 | `node scripts/check-package-version-bumps.mjs --release` → `runReleaseMode()` → `registryVersions(name)` per package → writes `RELEASE_PLAN_PATH` | validate | `:115` |
| 4 | `pnpm install --frozen-lockfile` | validate | `:117` |
| 5 | `pnpm -r --filter …×6 run build` in dependency order | validate | `:121-130` |
| 6 | `git --no-replace-objects diff --quiet "$GITHUB_SHA"` — whole tree this time | validate | `:143-157` |
| 7 | `pnpm pack --config.ignore-scripts=true` per package into `RELEASE_ARTIFACTS`, then `verify-package-artifacts.mjs --write` | validate | `:167-179` |
| 8 | `verify-package-artifacts.mjs "$RELEASE_ARTIFACTS"` (fresh verify) | validate | `:181-184` |
| 9 | `actions/upload-artifact@v4` — **immutable** snapshot uploaded *before* any test runs | validate | `:189-195` |
| 10 | `pnpm --filter dsl,generation,renderer,editor,importer run test` | validate | `:213-216` |
| 11 | `assert-pg-contract-suites.mjs --capture-baseline` → `vitest run --reporter=json` for storage → `assert-pg-contract-suites.mjs <results> --baseline <baseline>` | validate | `:217-222` |
| 12 | `typecheck` for dsl, generation, storage, renderer, editor (importer omitted) | validate | `:223-225` |
| 13 | `pnpm test:package-tarballs -- "$RELEASE_ARTIFACTS"` | validate | `:234-237` |
| 14 | checkout `fetch-depth: 0`, `persist-credentials: false`; `setup-node` with `registry-url` | publish | `:254-265` |
| 15 | `download-artifact` the sealed snapshot; `verify-package-artifacts.mjs` on it | publish | `:267-277` |
| 16 | `git rev-list --first-parent origin/main \| grep -cx "$GITHUB_SHA"` must be ≥ 1 | publish | `:284-296` |
| 17 | Poll `repos/…/actions/workflows/ci.yml/runs?head_sha=…&event=push` until `status == completed`; require `conclusion == success`; 1 800 s deadline | publish | `:301-331` |
| 18 | `git --no-replace-objects diff --quiet "$GITHUB_SHA"` again | publish | `:338-350` |
| 19 | Anchor `trusted_digests="$(< $RELEASE_ARTIFACTS/SHA256SUMS)"` in the shell scalar, re-verify, re-run `--release`, then per package: `sha256sum` re-check against the anchored digest, `npm publish "$tarball" --access public --provenance --ignore-scripts` | publish | `:359-413` |
| 20 | `mark` job: for each package, if published this run or `npm view` confirms it on the registry and no tag exists, `gh api POST repos/…/git/refs` creating `refs/tags/@openmaic/<pkg>@<version>` | mark | `:440-472` |

```mermaid
sequenceDiagram
  autonumber
  participant Push as push to main
  participant V as validate job — no token
  participant Art as upload-artifact — immutable
  participant P as publish job — release env
  participant API as GitHub Actions API
  participant NPM as registry.npmjs.org
  participant M as mark job — contents write

  Push->>V: start (postgres:16 service)
  V->>NPM: npm view <pkg> versions --json (release plan)
  NPM-->>V: published versions
  V->>V: "pnpm install, build x6, diff vs GITHUB_SHA"
  V->>V: "pnpm pack x6, verify-package-artifacts --write"
  V->>Art: upload openmaic-package-tarballs-<sha>
  V->>V: tests, pg contract audit, typechecks, tarball smoke
  V-->>P: needs: validate satisfied
  P->>Art: download sealed snapshot
  P->>P: verify SHA256SUMS
  P->>P: require GITHUB_SHA on main first-parent history
  P->>API: poll ci.yml runs for head_sha, event=push
  API-->>P: status=completed conclusion=success
  P->>P: anchor trusted_digests in shell scalar
  loop per package still in the release plan
    P->>P: sha256sum re-check vs anchored digest
    P->>NPM: npm publish <tarball> --provenance --ignore-scripts
    NPM-->>P: published
  end
  P-->>M: published_versions output
  M->>NPM: npm view (reconcile missing markers)
  M->>API: POST git/refs refs/tags/@openmaic/<pkg>@<v>
```

Two design decisions worth restating because they are the point of the whole
shape:

- The **security boundary is the job split**, stated at
  `publish-packages.yml:65-71`: install, build and pack happen only in
  `validate`, before any job can read `NPM_TOKEN`. The token-bearing job runs
  neither install nor build code, and receives immutable tarballs whose digests
  it re-verifies. `mark` is the only job with a git credential, and it installs
  and builds nothing.
- The **`grep -cx` rather than `grep -qx`** at line 291 is deliberate: `grep -q`
  exits at the first match, `git rev-list` then dies of `SIGPIPE`, and
  `pipefail` would turn a *found* commit into a failure once `main`'s history
  outgrows the pipe buffer.

The one acknowledged hole is at `:227-233`: the tarball smoke test reads the
writable local directory, not the uploaded snapshot, so a test process could in
principle replace a poisoned local tarball. The comment states plainly that this
cannot be closed while packing, uploading and testing share one job and
filesystem.

---

## Flow 3 — Proving the PostgreSQL contract suites touched PostgreSQL

Trigger: `push`/`pull_request` on `main` (and three feature branches),
`.github/workflows/storage-pg-contract.yml:3-7`. The same three steps also run
inside `publish-packages.yml`'s `validate` job.

| # | Hop | Function / command |
| --- | --- | --- |
| 1 | `postgres:16` service up | health-checked with `pg_isready -U postgres -d openmaic` |
| 2 | Job env set | `PG_CONTRACT_URL=postgresql://postgres:postgres@localhost:5432/openmaic`, `STORAGE_PG_CONTRACT_REQUIRED='1'` |
| 3 | `pnpm install --frozen-lockfile` | postinstall builds all packages |
| 4 | `node scripts/assert-pg-contract-suites.mjs --capture-baseline "$STORAGE_PG_BASELINE"` | `readCounters()` → per-table `n_tup_ins` snapshot written to disk |
| 5 | `pnpm --filter @openmaic/storage exec vitest run --reporter=default --reporter=json --outputFile.json=…` | Storage's own Vitest project; `test/setup.ts` shims IndexedDB / `URL.createObjectURL` / `crypto.subtle` |
| 6 | `node scripts/assert-pg-contract-suites.mjs "$STORAGE_VITEST_RESULTS" --baseline "$STORAGE_PG_BASELINE"` — **phase 1** | For each of 3 `REQUIRED_SUITES`: found in `testResults`, `status === 'passed'`, ≥ 1 passing case, 0 non-passing cases |
| 7 | same invocation — **phase 2** | `readCounters({ waitFor: baseline })`; for each of 7 `REQUIRED_TABLES`: table present, and `observed.inserts - baseline.inserts > 0` |
| 8 | `pnpm exec vitest run tests/lib/whiteboard/runtime-store.pg.test.ts` | The one app-domain PG suite explicitly invoked; its module-level `throw` fires if `PG_CONTRACT_URL` were missing |

```mermaid
sequenceDiagram
  autonumber
  participant W as storage-pg-contract.yml
  participant A as assert-pg-contract-suites.mjs
  participant PG as postgres 16 service
  participant VT as vitest storage project
  participant Suite as pg.test.ts modules

  W->>A: --capture-baseline STORAGE_PG_BASELINE
  A->>PG: SELECT n_tup_ins FROM pg_stat for 7 tables
  PG-->>A: baseline counters
  A-->>W: baseline written
  W->>VT: vitest run --reporter=json
  VT->>Suite: collect *.pg.test.ts
  Suite->>Suite: describe.skipIf(!PG_CONTRACT_URL) — false, so run
  Suite->>PG: CREATE tables, INSERT, assert, clean up
  VT-->>W: STORAGE_VITEST_RESULTS json
  W->>A: results + --baseline
  A->>A: phase 1 — suite files ran and reported passing cases
  A->>PG: SELECT n_tup_ins again
  PG-->>A: post-run counters
  A->>A: phase 2 — every table gained inserts vs baseline
  A-->>W: exit 0 with per-table delta log
  W->>VT: vitest run tests/lib/whiteboard/runtime-store.pg.test.ts
  VT-->>W: pass
```

Why the audit lives outside the tests, quoted from
`storage-pg-contract.yml:47-52`: the in-module
`STORAGE_PG_CONTRACT_REQUIRED` guard "only covers a missing database: it is a
`throw` inside the test modules, so it cannot fire if vitest stops collecting
them, and collection is decided by storage's `vitest.config.ts` — a file no
publishable-input rule covers, so excluding `*.pg.test.ts` there would silence
this whole job while it still reported success."

---

## Flow 4 — A developer runs the whiteboard-layout eval

Trigger: manual. `EVAL_CHAT_MODEL=<provider:model> EVAL_SCORER_MODEL=<provider:model>
pnpm eval:whiteboard --scenario physics-force-decomposition`
(`eval/whiteboard-layout/runner.ts:21-23`). Requires a locally running app on
`--base-url` (default `http://localhost:3000`).

| # | Hop | Function |
| --- | --- | --- |
| 1 | `parseArgs` over `scenario`, `repeat`, `base-url`, `output-dir`, `rescore` | `runner.ts:25-33` |
| 2 | Hard-fail if `EVAL_CHAT_MODEL`/`DEFAULT_MODEL` or `EVAL_SCORER_MODEL` unset | `runner.ts:40-51` |
| 3 | `loadScenarios()` reads every `scenarios/*.json`, filtering by `id` or filename substring | `runner.ts:60` |
| 4 | `createRunDir(OUTPUT_DIR, CHAT_MODEL)` → `results/<sanitized-model>/<timestamp>/` | `eval/shared/run-dir.ts:10` |
| 5 | `initCapture(BASE_URL)` launches the capture browser | `eval/whiteboard-layout/capture.ts:14` |
| 6 | Per scenario × repeat: `runScenario()` | `runner.ts:80` |
| 7 | `new EvalStateManager(scenario.initialStoreState)` resets `useCanvasStore`, `useWhiteboardHistoryStore`, `useStageStore`, and constructs the **real** `ActionEngine(useStageStore)` | `eval/whiteboard-layout/state-manager.ts:26-66` |
| 8 | Per turn: push the user message, then `runAgentLoop(…)` from `@/lib/chat/agent-loop` with a `fetchChat` that POSTs `${BASE_URL}/api/chat` | `runner.ts:135-168` |
| 9 | `onEvent` demultiplexes `agent_start` / `text_delta` / `action` / `cue_user` / `done` / `error`; each `action` is chained onto `actionChain` so `stateManager.executeAction()` applies in emission order | `runner.ts:170-215` |
| 10 | `onIterationEnd` awaits `actionChain`, then builds the assistant message from accumulated text + action parts | `runner.ts:217-250` |
| 11 | At each checkpoint turn (or the last): `stateManager.getWhiteboardElements()` → `captureWhiteboard(elements, scenarioDir, run<i>_turn<j>.png)` | `runner.ts:265-267` |
| 12 | `scoreScreenshot(screenshotPath, SCORER_MODEL)` → `resolveModel` → `generateText` with the rubric + image, `temperature: 0` | `eval/whiteboard-layout/scorer.ts:67-88` |
| 13 | On score failure: log and push `score: null`, preserving the screenshot | `runner.ts:274-278` |
| 14 | `stateManager.dispose()` in `finally` | `runner.ts:286` |
| 15 | `closeCapture()`, then `generateReport(report, runDir)` writes `report.json` + `report.md` | `runner.ts:377-388` |

```mermaid
sequenceDiagram
  autonumber
  participant Dev as Developer
  participant R as runner.ts main
  participant SM as EvalStateManager
  participant AE as ActionEngine
  participant App as app on 3000 api chat
  participant AgentLoop as runAgentLoop
  participant Cap as captureWhiteboard
  participant VLM as scoreScreenshot
  participant Rep as generateReport

  Dev->>R: pnpm eval:whiteboard --scenario X
  R->>R: "loadScenarios(), then createRunDir()"
  R->>Cap: initCapture(BASE_URL)
  R->>SM: new EvalStateManager(initialStoreState)
  SM->>AE: new ActionEngine(useStageStore)
  loop per turn
    R->>AgentLoop: runAgentLoop(config, callbacks, signal)
    AgentLoop->>App: POST /api/chat (SSE)
    App-->>AgentLoop: agent_start, text_delta*, action*, done
    AgentLoop->>R: onEvent(action)
    R->>SM: actionChain = actionChain.then(executeAction)
    SM->>AE: execute(action)
    AgentLoop->>R: onIterationEnd()
    R->>R: await actionChain
    opt checkpoint or last turn
      R->>Cap: captureWhiteboard(elements, dir, png)
      Cap-->>R: screenshotPath
      R->>VLM: scoreScreenshot(path, EVAL_SCORER_MODEL)
      VLM-->>R: VlmScore or throw
    end
  end
  R->>Cap: closeCapture()
  R->>Rep: generateReport(report, runDir)
  Rep-->>Dev: report.json + report.md
```

`EvalStateManager`'s docstring (`state-manager.ts:20-21`) states the reason for
using the real stores: "ActionEngine reads/writes these same stores — no
simulation drift." This harness is therefore an integration test of the action
pipeline as much as a layout scorer, which is also why it needs a live app.

Note the exit contract: `main()` here **never** exits non-zero on a bad score. It
only exits 1 on a missing model env var, an empty scenario set, or an unhandled
rejection (`runner.ts:44,50,356,393`). Compare Flow 4's siblings —
`eval/outline-language/runner.ts:168` demands 100 % judge pass and
`eval/pbl-v2-planner/runner.ts:913-919` demands every case pass its gate.

---

## Flow 5 (abbreviated) — the `e2e` job's browser chain

```mermaid
flowchart LR
  A["pnpm install"] --> B["restore ~/.cache/ms-playwright<br/>key: os-playwright-hash(pnpm-lock.yaml)"]
  B --> C["playwright install chromium<br/>3 attempts × timeout -k 10 240"]
  C --> D["vitest cover-card-layout.browser<br/>COVER_LAYOUT_BROWSER=1"]
  D --> E["vitest interactive-static-html.browser<br/>INTERACTIVE_STATIC_BROWSER=1"]
  E --> F["vitest e2e-materialize<br/>HF_E2E_DIR=runner.temp"]
  F --> G["hyperframes lint × 7 samples<br/>require '0 errors, 0 warnings'"]
  G --> H["restore .next/cache<br/>key: lock + next.config.ts"]
  H --> I["pnpm build<br/>NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true"]
  I --> J["playwright test<br/>webServer: pnpm start on :3002"]
  J -->|failure| K["upload playwright-report<br/>retention 7 days"]
```

Two operational lessons are baked in as comments. `ci.yml:251-254`: only the
browser tarball is installed, never `install-deps`, because "on this runner fleet
that mirror has sat through the whole 15-minute job budget". `ci.yml:324-326`:
the `pnpm build` step is dedicated so a cold build is not charged against
Playwright's 120-second `webServer` readiness budget, and
`NEXT_PUBLIC_MAIC_EDITOR_ENABLED` must be set *here* because it is compiled into
the bundle.
