---
name: shepherd-pr
description: |
  Shepherd a GitHub PR in this repo to green — open it against the right remote, triage CI
  failures to a specific line, push fixes safely. Use when the operator says "shepherd this
  PR", "open a PR", "fix the failing checks", "get PR N green", or "why is CI red". This is
  the GitHub counterpart to the installed `shepherd-mr` / `code-review:mr-*` skills, which
  drive `glab` and GitLab discussion threads and are the WRONG tool here.
disable-model-invocation: true
---

# Shepherd a PR (GitHub, this repo)

## Why this skill exists

Every installed shepherding skill — `shepherd-mr`, `code-review:mr-review`,
`code-review:mr-submit`, `code-review:mr-shepherd`, `code-review:mr-watcher` — drives `glab`
and GitLab discussion threads. **This is a GitHub repo.** Both `gh` and `glab` are on `PATH`,
so a `glab` command does not fail loudly with "not installed" — it fails obscurely, or worse,
authenticates against an unrelated GitLab host. That is how the trap stays hidden. Use `gh`.

## Remotes (verify, do not assume)

```
origin    https://github.com/cajias/OpenMAIC.git      # the fork — push here
upstream  https://github.com/THU-MAIC/OpenMAIC.git    # never push here
```

**`gh pr create` on a fork defaults to the upstream parent.** Always pass the fork explicitly:

```bash
gh pr create --repo cajias/OpenMAIC --base main --head "$(git branch --show-current)" ...
```

Skip that flag and `gh` opens the PR against `THU-MAIC/OpenMAIC`. Re-check the remotes with
`git remote -v` before every create — this list is a snapshot, not a guarantee.

## Before blaming the PR for a red check

```bash
gh run list --branch main --limit 10
```

In this repo that returns **nothing**: CI had never run on `main`. Two broken commits had
already landed there — `1a9608cd` (a `tsc` error) and `c2c9553a` (an unformatted file) — and
the first PR that actually triggered CI inherited the blame for both. If `main` has no runs,
the baseline is unknown and a red check on your PR may be pre-existing. Establish the baseline
before you fix anything.

## Known failure modes in this repo's CI

- **`pnpm check` is `prettier . --check`, repo-wide.** One unformatted file *anywhere* fails
  the whole job — including files your branch never touched. Fix with `pnpm format`, then
  check what it actually rewrote (`git diff --stat`) before committing; an unrelated rewrite
  belongs in its own commit.
- **Stale check-runs linger as "pending."** Earlier pushes leave check-runs attached to the PR
  that never resolve. Trust `mergeStateStatus` and the check-runs on the *current* head SHA,
  not the accumulated list:
  ```bash
  gh pr view <N> --json mergeStateStatus,statusCheckRollup,headRefOid
  ```

## Triage

Triage every failure to a **specific line** before calling anything flaky. Pull the failing
job's log, find the first error, map it to a file and line, then fix that. Compare the failing
run against a passing run of the same workflow — the diff in the logs is the answer. "Flake",
"CPU contention", and "infra hiccup" are conclusions that require evidence; without a
reproduction, say "root cause unknown."

## Pushing

- `git push --force-with-lease` — **never** bare `--force`.
- Never push to `upstream`.
- Never force-push `main`.

## Loop

1. `git remote -v`, `git status`, `gh pr view <N> --json mergeStateStatus,statusCheckRollup,headRefOid`
2. `gh run list --branch main --limit 10` — establish the baseline
3. For each failure on the current head: fetch the log, triage to a line, fix
4. `pnpm check` locally before pushing (it is repo-wide; it will catch what CI catches)
5. `git push --force-with-lease`
6. Re-poll the current head's check-runs. Ignore anything attached to an older SHA.
