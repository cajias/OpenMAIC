# CI Workflows

Five GitHub Actions workflows and twelve jobs in total. This file covers the whole
trigger graph plus the three workflows on the merge path — `ci.yml` (three jobs),
`storage-pg-contract.yml` and `docs-build.yml`. The two publish workflows are in
[`08b-release-workflows.md`](./08b-release-workflows.md).

**Sources:** all five files under `.github/workflows/`, plus
`tests/workflows/ci-video-export-contract.test.ts`,
`tests/workflows/publish-packages-workflow.test.ts`,
`scripts/assert-pg-contract-suites.mjs`. Evidence:
[`quality-testing-ci-deps/01b`](../appendix/research/quality-testing-ci-deps/01b-modules-ci-and-build.md),
[`quality-testing-ci-deps/03`](../appendix/research/quality-testing-ci-deps/03-flows.md),
[`quality-testing-ci-deps/04`](../appendix/research/quality-testing-ci-deps/04-dependencies-and-config.md).

## The workflow graph

```mermaid
flowchart TD
  PR["pull_request -> main<br/>+ 5 named branches"] --> CI
  PUSHMAIN["push -> main"] --> CI
  PUSHINT["push -> integration/kv-asset-server-backend<br/>push -> integration/agent-workbench"] --> CI

  subgraph CI["ci.yml — 3 independent jobs, no needs: between them"]
    CHK["check: Lint, Typecheck & Unit Tests<br/>timeout 15 min"]
    RSJ["render-service: typecheck + tests + docker build<br/>timeout 10 min"]
    E2EJ["e2e: browser suites + build + playwright<br/>timeout 15 min"]
  end

  PR --> PGC["storage-pg-contract.yml<br/>postgres:16 service, timeout 10 min"]
  PUSHMAIN --> PGC

  PRDOCS["pull_request touching packages/docs/**"] --> DOCS["docs-build.yml<br/>single build job"]
  PUSHDOCS["push -> main touching packages/docs/**"] --> DOCS

  PUSHPKG["push -> main touching one of the six<br/>packages/@openmaic/*/package.json"] --> PUB
  DISPATCH1["workflow_dispatch (dry_run input)"] --> PUB

  subgraph PUB["publish-packages.yml"]
    VAL["validate<br/>permissions: contents:read<br/>NO token, postgres:16 service"]
    PUBJ["publish<br/>environment: release<br/>permissions: actions:read, id-token:write"]
    MARK["mark<br/>permissions: contents:write"]
    VAL -->|"needs: validate"| PUBJ
    PUBJ -->|"needs: publish"| MARK
  end

  PUSHSKILL["push -> main touching skills/openmaic/**<br/>or the 2 .github/scripts helpers"] --> CLAW
  PRSKILL["pull_request touching the same paths"] --> CLAW
  DISPATCH2["workflow_dispatch (dry_run, version)"] --> CLAW

  subgraph CLAW["publish-openmaic-skill.yml — 4 conditional jobs"]
    REJ["reject-invalid-dispatch<br/>non-main manual publish"]
    B3["bash-3-compatibility<br/>runs-on macos-15, PR only"]
    PREV["preview<br/>contents:read, PR or dry run"]
    PUBS["publish<br/>environment: clawhub-release"]
  end

  PUBJ -.->|"polls the Actions API for a completed,<br/>successful ci.yml run on this head_sha<br/>1800s deadline"| CI
```

`publish` does **not** depend on `ci.yml` through GitHub's machinery. It polls
`repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&event=push`
with a 1800-second deadline (`publish-packages.yml:301-331`). The comment names
the reason: `ci.yml` runs concurrently with the publish on a push to `main` and
"blocks nothing".

## Trigger and concurrency table

| Workflow | Triggers | `concurrency.group` | `cancel-in-progress` |
| --- | --- | --- | --- |
| `ci.yml` | push to `main`, `integration/kv-asset-server-backend`, `integration/agent-workbench`; PR to `main`, `feat/maic-editor-v0`, `feat/maic-editor-v1`, `runtime-server-backend`, and both integration branches | `ci-${{ github.ref }}` | `${{ github.event_name == 'pull_request' }}` |
| `storage-pg-contract.yml` | push to `main`; PR to `main`, `runtime-server-backend`, `feat/maic-editor-v0`, `feat/maic-editor-v1` | `storage-pg-contract-${{ github.ref }}` | `true` |
| `docs-build.yml` | push/PR to `main` **path-filtered** to `packages/docs/**` and its own file | `docs-build-${{ github.ref }}` | `true` |
| `publish-packages.yml` | push to `main` path-filtered to the six package manifests; `workflow_dispatch` with a `dry_run` boolean | `publish-openmaic` (repository-wide) | `false` |
| `publish-openmaic-skill.yml` | push/PR to `main` path-filtered to `skills/openmaic/**` + both `.github/scripts` helpers; `workflow_dispatch` with `dry_run` and `version` | per job: `clawhub-bash3-<PR>`, `clawhub-preview-<PR-or-run>`, `publish-openmaic-skill` | `true` for the PR jobs, `false` for publish |

Two conditional-concurrency decisions worth understanding:

- **A `main` run of `ci.yml` is never cancelled** (`ci.yml:23-26`): each `main` run
  validates only its own push range, so cancelling a superseded run "takes the
  range that contained a package change with it and the replacement, comparing
  against the cancelled tip, sees nothing".
- **`publish-openmaic` is keyed on nothing but the literal string**
  (`publish-packages.yml:55-60`): keying it on the ref "would let two runs race for
  the same version, each deciding independently that the version is unpublished".

**Why the push triggers list the integration branches as well as the PR triggers**
(`ci.yml:5-9`): a `pull_request` run "only ever proves one part merged into the
branch", so without a push trigger the accumulated state of the branch that
eventually reaches `main` is never built on its own.

## `ci.yml` — job `check`

Nineteen steps. Everything after the four parallel linters is deliberately
sequential.

```mermaid
flowchart TD
  A1["actions/checkout@v4 fetch-depth: 0"] --> A2
  A2["Parallel runner self-test<br/>bash only, before install"] --> A3
  A3["pnpm/action-setup@v4"] --> A4
  A4["actions/setup-node@v4 node 22, cache pnpm"] --> A5
  A5{"event_name"} -->|pull_request| A6["check-package-version-bumps.mjs BASE_SHA"]
  A5 -->|push| A7["validate BEFORE_SHA is a real commit,<br/>else ::error:: and exit 1"]
  A7 --> A8["check-package-version-bumps.mjs $base"]
  A6 --> A9
  A8 --> A9
  A9["check-internal-dependency-ranges.mjs"] --> A10
  A10["pnpm install --frozen-lockfile"] --> A11
  A11["pnpm check:node-engine"] --> A12
  A12["Verify the install did not rewrite<br/>tracked files under packages/@openmaic"] --> A13
  A13["ci-run-parallel.sh:<br/>prettier | eslint | tsc | i18n"] --> A14
  A14["pnpm test — root vitest"] --> A15
  A15["importer test"] --> A16
  A16["dsl test"] --> A17
  A17["generation typecheck"] --> A18
  A18["generation test"] --> A19
  A19["Node consumer smoke: port 43127,<br/>50 health polls, assert outlines/scene/valid"] --> A20
  A20["storage typecheck (incl. tests)"] --> A21
  A21["storage test"]
```

The push-range guard at `ci.yml:66-79` is unusually strict on purpose: a branch
creation or a force push reports an unusable `github.event.before`, and rather
than substituting `HEAD^` the step fails — "a force push can replace many commits
at once, so the previous commit is not the range that needs checking, and
publishing requires this run to be green."

The generation Node-consumer smoke (`ci.yml:151-178`) is the only step in the job
that starts a background process. It launches `scripts/generation-node-smoke-server.mjs`
on port 43127 with a `trap cleanup EXIT`, polls `/health` up to 50 times at 100 ms,
runs `scripts/generation-node-smoke.mjs` against it, and validates the printed
JSON with an inline `node -e`: `outlines` must be a non-empty array, `scene` must
be present, and `sceneValidation.valid` must be exactly `true`.

## `ci.yml` — job `render-service`

Six steps, and the only job in the repository that builds a container image. The
table below covers the five after `actions/checkout@v4` (`ci.yml:199`).

| Step | Detail |
| --- | --- |
| `actions/setup-node@v4` | `cache: npm`, `cache-dependency-path: render-service/package-lock.json` — the service is its own npm package, "excluded from the root eslint/tsc/pnpm workspace — so it gets its own install + quality gate here" |
| `npm ci` | `working-directory: render-service` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run`, 16 test files |
| `docker build --tag openmaic-render-service:ci render-service` | proves the Dockerfile still builds; no push, no registry |

Job-level `env: PUPPETEER_SKIP_DOWNLOAD: "true"` — "the producer dep bundles
puppeteer; skip its Chromium download — the unit tests exercise the service's
boundaries (unzip, admission, body caps) and never launch a browser."

## `ci.yml` — job `e2e`

```mermaid
flowchart TD
  B1["checkout + pnpm + node 22"] --> B2
  B2["pnpm install --frozen-lockfile"] --> B3
  B3["actions/cache@v4 ~/.cache/ms-playwright<br/>key: os-playwright-hash(pnpm-lock.yaml)"] --> B4
  B4["playwright install chromium<br/>3 attempts, timeout -k 10 240 each"] --> B5
  B5["vitest cover-card-layout.browser.test.ts<br/>COVER_LAYOUT_BROWSER=1"] --> B6
  B6["vitest interactive-static-html.browser.test.ts<br/>INTERACTIVE_STATIC_BROWSER=1"] --> B7
  B7["vitest e2e-materialize.test.ts<br/>HF_E2E_DIR=runner.temp/openmaic-hyperframes-samples"] --> B8
  B8["hyperframes lint x7 samples:<br/>quiz pbl-v2 pbl-legacy pbl-dense<br/>mixed arabic interactive-static<br/>require exit 0 AND '0 errors, 0 warnings'"] --> B9
  B9["actions/cache@v4 .next/cache<br/>key: os-nextjs-hash(lock)-hash(next.config.ts)<br/>restore-keys: os-nextjs-hash(lock)-"] --> B10
  B10["pnpm build<br/>NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true"] --> B11
  B11["pnpm exec playwright test"] --> B12
  B12{"failure()?"}
  B12 -->|yes| B13["upload-artifact playwright-report<br/>retention 7 days"]
  B12 -->|no| B14["done"]
```

Four operational decisions with their stated reasons:

- **Only the browser tarball is installed, not `install-deps`** (`ci.yml:251-254`):
  "`install-deps` talks to Ubuntu apt; on this runner fleet that mirror has sat
  through the whole 15-minute job budget. `ubuntu-latest` already ships the
  libraries Chromium needs."
- **The download is bounded and retried** — `timeout -k 10 240` × 3 attempts —
  because "a cold download of Chromium from the Playwright CDN has sat for 20+
  minutes on this runner fleet".
- **`pnpm build` is a dedicated step**, not left to Playwright's `webServer`, "so a
  cold `next build` is not charged against Playwright's webServer readiness budget
  (120s)". And `NEXT_PUBLIC_MAIC_EDITOR_ENABLED` "is a build-time flag and must be
  set here, not only on `pnpm start`".
- **The Next cache key includes `next.config.ts`** so a dependency or config change
  misses, while source edits still reuse the restore-key prefix.

The two browser suites' `env` blocks and the main-push gate body are themselves
pinned by `tests/workflows/ci-video-export-contract.test.ts`, so narrowing them
fails a test.

## `storage-pg-contract.yml`

One job, one `postgres:16` service with a `pg_isready` health check, and two
job-level environment variables:
`PG_CONTRACT_URL=postgresql://postgres:postgres@localhost:5432/openmaic` and
`STORAGE_PG_CONTRACT_REQUIRED='1'`.

```mermaid
sequenceDiagram
  participant J as storage-pg-contract job
  participant A as assert-pg-contract-suites.mjs
  participant V as vitest (@openmaic/storage)
  participant P as postgres:16 service
  J->>A: --capture-baseline $STORAGE_PG_BASELINE
  A->>P: read pg_stat n_tup_ins for 7 tables
  A-->>J: baseline JSON written
  J->>V: vitest run --reporter=default --reporter=json --outputFile.json=$STORAGE_VITEST_RESULTS
  V->>P: the 6 *.pg.test.ts suites execute
  V-->>J: JSON results
  J->>A: $STORAGE_VITEST_RESULTS --baseline $STORAGE_PG_BASELINE
  A->>A: phase 1 — 3 REQUIRED_SUITES passed with >=1 case, 0 non-passing
  A->>P: phase 2 — n_tup_ins delta > 0 for all 7 REQUIRED_TABLES
  A-->>J: exit 0 or gate failure
  J->>V: vitest run tests/lib/whiteboard/runtime-store.pg.test.ts
```

The comment at `:46-52` explains why the audit lives outside the tests: the
in-module `STORAGE_PG_CONTRACT_REQUIRED` guard is a `throw` inside the test
modules, so it cannot fire if Vitest stops collecting them, and collection is
decided by `packages/@openmaic/storage/vitest.config.ts` — "a file no
publishable-input rule covers, so excluding `*.pg.test.ts` there would silence
this whole job while it still reported success."

## `docs-build.yml`

One job, `defaults.run.working-directory: packages/docs`,
`cache-dependency-path: packages/docs/pnpm-lock.yaml`, then
`pnpm install --frozen-lockfile --ignore-workspace` and `pnpm build`. The
`--ignore-workspace` flag carries the comment "Excluded from the root pnpm
workspace, so install it standalone."

## The two release workflows

`publish-packages.yml` and `publish-openmaic-skill.yml` — their job graphs, the
job-boundary security model, and the `.github/scripts` helpers — are in
[`08b-release-workflows.md`](./08b-release-workflows.md).

## Security posture across the three merge-path workflows

| Property | `ci.yml` | `storage-pg-contract.yml` | `docs-build.yml` |
| --- | --- | --- | --- |
| Actions pinned to a commit SHA | no (`@v4` tags) | no | no |
| explicit `permissions:` block | none (inherits the repository default) | none | none |
| `persist-credentials: false` | no | no | no |
| holds a secret | none | none | none |
| runs install and build code | yes | yes | yes |

The two publish workflows invert every row of that table; see
[`08b-release-workflows.md`](./08b-release-workflows.md).

## Open questions

- No workflow uploads a coverage report, and no coverage provider is installed, so
  no CI job can report coverage.
- `ci.yml`, `storage-pg-contract.yml` and `docs-build.yml` declare no
  `permissions:` block, so they inherit the repository default. What that default
  is set to is a repository setting and not visible in the tree.
- `ci.yml` runs `renderer` and `editor` tests nowhere; they execute only inside
  `publish-packages.yml`'s `validate` job. So a change to either package can merge
  with its own suite never having run, and is then first exercised on the release
  path — where a failure has already consumed a version number in review.
- Whether any of these workflows is configured as a **required** status check is a
  branch-protection setting, not recorded in the repository.
  `publish-openmaic-skill.yml:8-9` explicitly asks that it *not* be required for
  every PR because it is path-filtered.
