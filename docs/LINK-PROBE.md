# Link form probe — which link syntax navigates in your IDE?

**Ctrl/Cmd-click every numbered link below, then note which ones jump and which
do nothing.** Every one of them aims at the same two real targets, so the only
variable is the syntax. Reply with the numbers that worked.

This file is **disposable**. It exists to settle one empirical question and
should be deleted once the answer is recorded. It deliberately contains link
forms that are meant to fail, so `scripts/check-docs-links.mjs` and
`scripts/hooks/check-md-refs.mjs` **will** flag it — neither script excludes it
today. Expect that noise; do not copy anything from here into a real page.

## Is it the IDE or the syntax? Click these first

None of forms 1-11 navigated last time — that rules out link syntax, since
form 3 is the standard `../`-relative form and works in a healthy IDEA. Click
these seven letters before touching the numbered forms below; they separate
"the IDE has no project model" from "the link syntax is wrong."

A. **The simplest possible link** — same directory, no `../`, no anchor:
   [glossary](glossary.md). **If this one fails, the problem is the IDE's
   project model, not the link syntax — no further form-testing is useful.**
B. Sibling directory's index, no anchor: [container view](02-container-view/index.md)
C. Raw HTML anchor, `../`-relative: <a href="../lib/ai/providers.ts">providers.ts via &lt;a&gt;</a>
D. Raw HTML anchor with a line fragment: <a href="../lib/ai/providers.ts#L2033">providers.ts:2033 via &lt;a&gt;</a>
E. Raw HTML anchor, leading slash: <a href="/lib/ai/providers.ts#L2033">providers.ts:2033 via &lt;a&gt;, leading slash</a>
F. Plain markdown link, label is **not** a code span (every real code link's
   label is a code span — this isolates whether the backticks matter):
   [lib/ai/providers.ts:2033](../lib/ai/providers.ts#L2033)
G. **External URL, the cheapest possible control:** [anthropic.com](https://www.anthropic.com).
   If even this doesn't open, the failure is the preview/IDE layer, not path
   resolution — stop and fix the IDE before clicking anything else here.

### Where are you clicking?

IDEA has two separate click surfaces: the **editor** (source markdown,
Ctrl/Cmd+Click) and the **Preview pane** (rendered HTML, plain click). They're
different subsystems — Markdown Preview is already confirmed broken for
Mermaid in Remote Development (YouTrack IJPL-248352), so a Preview failure
doesn't tell you anything about the editor. Try **both** for A-G and report
which surface you used for each result.

### If nothing at all works, check these in the IDE

1. **Is this open as a project, or as a folder/LightEdit?** The repo's
   `.idea/workspace.xml` is 126 bytes with an empty `PropertiesComponent` and
   there is no `.iml` anywhere — that's consistent with no project model ever
   being created. File → Open the repo root as a project and let indexing
   finish, then retry A-G.
2. **Is `docs/` marked Excluded in Project Structure?** `docs/` was in
   `.gitignore` until today, and IDEA excludes VCS-ignored directories from
   the project model — it may still be excluded even after the `.gitignore`
   change. Settings → Project Structure → Modules; un-exclude `docs/` if so.
3. **Has indexing finished?** A project in Dumb Mode resolves nothing. Check
   the progress indicator in the bottom-right status bar.

## The two targets

- **Code:** `export function getModel(config: ModelConfig): ModelWithInfo` is the
  2033rd line of `lib/ai/providers.ts`, a 2420-line file. A working click lands
  on that `export function getModel` line, not merely at the top of the file.
- **Markdown:** `## Topic overview` is the 53rd line of
  `docs/02-container-view/index.md`. A working click lands on that heading.

## Code target — same file, same line, six syntaxes

1. Root-relative, line anchor — [`lib/ai/providers.ts:2033`](lib/ai/providers.ts#L2033)
2. Root-relative, no anchor — [`lib/ai/providers.ts`](lib/ai/providers.ts)
3. `../`-relative, line anchor (what the set uses today) — [`lib/ai/providers.ts:2033`](../lib/ai/providers.ts#L2033)
4. Leading-slash absolute — [`lib/ai/providers.ts:2033`](/lib/ai/providers.ts#L2033)
5. Root-relative, **lowercase** `l` — [`lib/ai/providers.ts:2033`](lib/ai/providers.ts#l2033)
6. Root-relative, line range — [`lib/ai/providers.ts:2033-2040`](lib/ai/providers.ts#L2033-L2040)

For 1, 3 and 4: did it land **on line 2033**, or at the top of the file? For 5
the interesting answer is the same question — a form that opens the file but
ignores the line is a false positive, not a success.

## Markdown target — same heading, two syntaxes

7. Root-relative, heading fragment — [Container view §Topic overview](docs/02-container-view/index.md#topic-overview)
8. `../`-relative, heading fragment — [Container view §Topic overview](../docs/02-container-view/index.md#topic-overview)

## Backticks with no link syntax — the likely culprit

IDEA resolves a bare code span as a path too, but from the **repo root**, not
from this file's directory. That different rule is probably why root-relative
*looks* like the fix. Click the span itself, not a surrounding link:

9. `lib/ai/providers.ts` — no line number, no link.
10. `lib/ai/providers.ts:2033` — same span **with** `:2033` appended.
11. `../lib/ai/providers.ts` — `../`-relative inside a code span.

**Prediction: 9 opens the file; 10 and 11 do nothing.** If that holds, the
`:2033` suffix is what breaks it — and note that the *visible label* of every
one of the 7,515 real code links is exactly form 10. Ctrl+clicking the label
text does nothing while the destination beside it works fine.

## What to report back

For each number: **jumped to the right line / opened the file at the top /
nothing happened**. 1 vs 3 vs 4 decides the convention for the whole set; 5
decides whether anchor case matters; 9 vs 10 decides whether the reported
breakage is in the link *destinations* or only in their *labels*.
