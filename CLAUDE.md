# CLAUDE.md

Non-obvious facts about this repo, each one measured here. Generic advice is deliberately absent.

## Toolchain

- `pnpm`, never npm, at the repo root. Node floor is `>=22.19.0` (`package.json` `engines.node`);
  `scripts/check-node-engine-contract.mjs` asserts that floor is not below any workspace package's
  own `engines.node`, so bumping a package's floor without bumping the root fails CI.
- `pnpm check` is `prettier . --check` **repo-wide** — one unformatted file anywhere fails the whole
  `Lint, Typecheck & Unit Tests` job. `pnpm format` writes.
- `pnpm test` is `vitest run`; `pnpm test:e2e` is Playwright.
- `render-service/` is outside the pnpm workspace and outside root eslint/tsc. It has its own
  `node_modules` and `package-lock.json`, and CI installs it with `npm ci`, not pnpm.
- `postinstall` is a long ordered chain: builds `mathml2omml`, `pptxgenjs`, then `@openmaic/`
  `dsl` → `generation` → `storage` → `importer` → `renderer` → `editor`, then runs
  `scripts/sync-maic-importer.mjs`. Read it before touching package layout.

## Do not add a line to `package.json`

176 citations across 59 files under `docs/` point at `package.json#L<n>`. Inserting a line silently
invalidates them, and the reference gate cannot tell (a shifted line is still in range). That is why
the docs gate has no npm alias and CI calls `node scripts/...` directly. If you must edit
`package.json`, re-run the gate and re-point the citations in the same change.

## Verification traps

Each of these produced a wrong answer in this repo.

- `grep` on this machine is an **RTK wrapper**, not GNU grep. Use `/usr/bin/grep` explicitly for
  anything you will report as a number. RTK's bracket-expression semantics differ from POSIX
  (338 vs 62 on one real pattern), the `grep`→`rg` rewrite skips hidden directories without `-uu`,
  and `rtk prettier --check` has printed an error while exiting 0. When a command's **exit code or
  verdict line IS the evidence**, run `rtk proxy <cmd>` and echo `$?`.
- `grep -E` is POSIX ERE: no `\w`, `\d`, `\s`. A count came back **0** where the truth was
  **9,016** because of this. Use `[[:alnum:]_]`, `[[:digit:]]`, `[[:space:]]`.
- `prettier` resolves config by file **location**. Checking a copy outside the repo silently passes
  against defaults instead of `.prettierrc`.
- Counting occurrences is not counting things. Real errors from here: "84 setters" was 84 lines for
  42 setters; "54 e2e tests" included 13 `describe` blocks and 11 hooks; "20 call sites" counted the
  declaration itself. Always ask whether the command counts the thing the label names.
- zsh eats unquoted `--include=*.ts`. Quote it: `--include='*.ts'`.

## `docs/` — 318 files under an enforced reference contract

- Link targets are **repo-root-relative with no leading `/`**: `lib/ai/providers.ts#L412`,
  `docs/README.md#open-questions`. Both `../`-relative and leading-`/` forms are rejected by the
  gate. Uppercase `L` is required — `#l412` resolves the path but silently drops the line.
- `node scripts/check-docs-links.mjs` is the gate (flags include `--selftest`, `--mermaid`,
  `--external`, `--navigability`). It runs in ~1s (measured 980 ms) and must stay green.
- **Citation rot is real and mostly invisible.** 64% of line citations pointed at different content
  after 25 days, and the gate catches only ~51% because a shifted line is still in range. If you
  move code in a cited file, re-point its citations deliberately — CI will not tell you. One
  16-line fix invalidated 44 citations across 15 files.
- Conventions (see `docs/CONTRIBUTING-DOCS.md`): every number prints the command that reproduces it;
  inferences are marked `Inferred:`; unknowns go in an "Open questions" section, never guessed.

## Git and CI

- `origin` is the fork `cajias/OpenMAIC`; `upstream` is `THU-MAIC/OpenMAIC`. **Never push to
  upstream.** `gh pr create` on a fork **defaults to the upstream parent** — always pass
  `--repo cajias/OpenMAIC`.
- `main` requires four checks: `Lint, Typecheck & Unit Tests`, `E2E Tests`,
  `Render Service (typecheck + tests)`, `Storage Contract (PostgreSQL 16)`. `Reference Gate` is
  deliberately not required because it is path-filtered.
- Do not add `paths-ignore` to `ci.yml` or `storage-pg-contract.yml`. Their checks are required, and
  a path-skipped workflow never reports at all — that blocks merges forever. Neither has a `paths`
  filter today; keep it that way.
- `--force-with-lease`, never bare `--force`. Never force-push `main`.

## Two known open defects — do not rediscover these

- **SSRF.** `validateUrlForSSRF` (`lib/server/ssrf-guard.ts:253`) never consults
  `CLOUD_METADATA_ADDRESSES`, and `isPrivateIP` (`lib/server/ssrf-guard.ts:178`) has no CGNAT
  `100.64.0.0/10` branch. So Alibaba `100.100.100.200` and Oracle `192.0.0.192` pass, reaching all
  20 call sites across 16 files — including `app/api/proxy-media/route.ts`, which returns the
  upstream response body and is unauthenticated whenever `ACCESS_CODE` is unset (`middleware.ts:60`
  returns `next()` early). The strict path `assertSafeIp` already does this correctly with
  `ipaddr.js`. Written up in `docs/15-cross-cutting/02-threat-ssrf.md`.
- **Transcription is un-metered.** The ESLint ban keys on `generateText`/`streamText`
  (`eslint.config.mjs:626`), so `experimental_transcribe` (`lib/audio/asr-providers.ts:149`)
  bypasses `callLLM`/`streamLLM`. `UsageKind` declares `'asr'` (`lib/server/usage-storage.ts:21`)
  and no caller ever writes that row — `recordGenerationUsage` is only called for image, video,
  and tts.
