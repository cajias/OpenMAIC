# Authoring contract for this documentation set

[`../CONTRIBUTING.md`](CONTRIBUTING.md) governs contributions to the code. This
page governs contributions to the 316 Markdown files under `docs/`, and it only
covers what enforcement cannot reach.

The conventions this set already follows — one section per file at 120–350 lines,
the restricted Mermaid subset, `Inferred:` markers, open-questions sections,
absences stated as findings — are recorded once in
[`README.md` §Conventions used in these docs](docs/README.md#conventions-used-in-these-docs)
and are not repeated here. What follows is five rules, each one behind a defect
this set actually shipped.

## 1. Cite code as a link, and name the symbol in the sentence

Write the citation as a Markdown link with a line anchor, and name the symbol
beside it:

```markdown
`validateUrlForSSRF` returns `null` at
[`lib/server/ssrf-guard.ts:266-269`](lib/server/ssrf-guard.ts#L266-L269) when
`ALLOW_LOCAL_NETWORKS` is set.
```

That source renders as:

> `validateUrlForSSRF` returns `null` at
> [`lib/server/ssrf-guard.ts:266-269`](lib/server/ssrf-guard.ts#L266-L269) when
> `ALLOW_LOCAL_NETWORKS` is set.

The line number is the volatile half of that citation and the symbol name is the
durable half. When `getModel` moves, [`lib/ai/providers.ts:2033`](lib/ai/providers.ts#L2033) becomes a lie
that still resolves; the word `getModel` is what lets the next reader re-find it
in one grep. A citation with no symbol named beside it cannot be repaired, only
deleted.

**Always write the path from the repository root.** A bare basename is not a
citation, it is a guess — `route.ts` matches 70 tracked files in this repo,
`index.ts` matches 46, `types.ts` 39:

```bash
git ls-files | /usr/bin/grep -c '/route\.ts$'   # 70
```

Neither a reader nor the gate can resolve `route.ts:412`, and `:412` on its own is
worse — recovering the file from surrounding prose is inference, and an audit
measured that inference picking the wrong file 101 times.

**Write the link target from the repository root too — no leading `/`, no `./`,
no `../`.** The target is the same string at every page depth, so there is no
prefix to count and none to copy wrong:

```markdown
docs/<file>.md                              [`lib/x.ts:12`](lib/x.ts#L12)
docs/<topic>/<file>.md                      [`lib/x.ts:12`](lib/x.ts#L12)
docs/appendix/research/<slug>/<file>.md     [`lib/x.ts:12`](lib/x.ts#L12)
```

A link to another page in this set carries its `docs/` prefix, because that is
where the page sits relative to the root — from anywhere,
`[Container view](docs/02-container-view/index.md)`.

This is not a style preference and it is not GitHub's convention. It is the one
form measured navigating in JetBrains IDEA, which resolves a Markdown link
destination against the project base directory rather than the containing file;
the `../`-relative form the set was originally written in resolves on GitHub and
does nothing on Ctrl-click. Every candidate was clicked in
[LINK-PROBE.md](docs/LINK-PROBE.md) and this one won. Rule 1a of
[`../scripts/check-docs-links.mjs`](scripts/check-docs-links.mjs) now rejects the
other forms and prints the corrected target with the finding, and
`node scripts/rootrel-md-links.mjs docs/<file>.md` converts a page that predates
the rule.

One thing the convention does *not* touch: the visible label. A citation whose
text reads `` `../02-container-view/index.md` `` keeps that text, because the text
is prose and rewriting it would change what the sentence says. Only the
destination in parentheses is spelled from the root.

**Line anchors are for code, never for Markdown.** `#L266` and `#L266-L269` are a
GitHub blob-view convention. Point one at a `.md` file and GitHub renders the
page and silently drops the anchor, landing the reader at the top — the gate
rejects that case outright. Link to a heading instead.

**Two caveats worth knowing before you convert a page's citations.** `#L` anchors
are honoured by GitHub's blob view, which is the only renderer this set has
today; a static site renderer would ignore them, so if `docs/` is ever published
the anchor form has to be revisited. And a Mermaid node label takes no inline
Markdown at all, so a citation inside a diagram can never be a link — leave it as
plain `path:line` text and link the same citation in the prose beneath the
diagram.

## 2. Write a heading you can link to, or do not link to it

GitHub's slug — the same one a static renderer would use — lowercases the
heading, deletes every character that is not a letter, digit, mark, space,
hyphen or underscore, then turns each remaining space into a hyphen. Nothing is
collapsed, so punctuation disappears while the spaces around it do not:

| Heading | Anchor |
| --- | --- |
| ``## Gate 3 — `tsc --noEmit` `` | `#gate-3--tsc---noemit` |
| `## 3. Self-hoster / operator` | `#3-self-hoster--operator` |

Nobody hand-writes `#gate-3--tsc---noemit` correctly. Copy the anchor from the
rendered page or run it through the slugger; do not derive it from the heading
text by eye. If a heading is meant to be a link target, keep it plain words —
em dashes, arrows, slashes and parentheses each leave a hyphen run behind, and
renaming the heading breaks every inbound anchor at once.

**Never link to a heading that repeats.** GitHub disambiguates duplicates by
document order: the second `## Hops` is `#hops-1`, the third is `#hops-2`.
[`appendix/research/classroom-runtime/03a-flows-playback.md`](docs/appendix/research/classroom-runtime/03a-flows-playback.md)
has three `### Hops` under a repeated per-flow template, so inserting a fourth
flow silently repoints every anchor after it. If you want to link a repeated
section, make its heading unique first (`### Hops — Flow C`).

## 3. Link a fact; never copy it

One page owns a fact. Every other page links to that page. Copying the fact
instead creates N copies that drift independently and then get corrected one at a
time, by N separate people who each believe they fixed it.

- **`validateUrlForSSRF` has 20 call sites in 16 modules**, measured with the
  command below, which returns 20 lines across 16 files. The figure was originally
  written as "13 callers" from the route files alone, missing
  `lib/server/resolve-model.ts` and the two agent-runtime redirect loops. It was
  restated in six places. Correcting
  [`15-cross-cutting/02-threat-ssrf.md`](docs/15-cross-cutting/02-threat-ssrf.md)
  and [`12-api-reference/09-conventions.md`](docs/12-api-reference/09-conventions.md)
  fixed two of them and left the rest asserting a number the code disagrees with.

  ```bash
  /usr/bin/grep -rn 'validateUrlForSSRF(' app components lib packages render-service scripts \
    | /usr/bin/grep -v ssrf-guard | /usr/bin/grep -v '\.test\.'
  ```

- **The `ALLOW_LOCAL_NETWORKS` short-circuit is not total.** It returns `null`
  *after* the `new URL()` parse and the http/https check, which still reject, and
  *before* the hostname, private-IP and DNS checks, which do not run
  ([`lib/server/ssrf-guard.ts:266-269`](lib/server/ssrf-guard.ts#L266-L269)).
  The topic page was corrected to say exactly that. Pages that had copied the
  earlier "disables the entire check" wording were not, because nothing connects
  a copy to its original — a topic page and the evidence pack behind it are two
  files, and fixing one is invisible to the other.

If a sentence is unreadable without restating a number, restate it *and* link the
page that owns it in the same sentence. If you copy a number without a link, you
have volunteered to own its next correction.

## 4. A number without its command is not a number

The measuring command belongs beside every load-bearing figure, because in this
repo the command *is* the definition of the count.

- **7 836 or 7 837 test cases, depending on one character class.** A
  lowercase-only modifier pattern misses `it.skipIf(...)`; `\.\w+` catches it.
  Same corpus, two answers one apart. The reconciliation, the trap and the
  canonical figure live in
  [`14-code-quality/05-test-strategy.md`](docs/14-code-quality/05-test-strategy.md);
  three pages had each been corrected once, in different directions, before that
  page was made the owner.
- **42 setters, 84 occurrences.** Two commands over
  [`lib/store/settings.ts`](lib/store/settings.ts) disagree by exactly a factor
  of two, because each setter is declared once in the state type and once in the
  implementation. The 84 was published as the setter count — a true measurement
  with a false label, which no link checker will ever catch.

  ```bash
  /usr/bin/grep -cE '^  set[A-Z]' lib/store/settings.ts        # 42 — the setters
  /usr/bin/grep -coE 'set[A-Z][A-Za-z]*:' lib/store/settings.ts # 84 — occurrences
  ```

When two commands disagree, publish the stricter one, say which command produced
it, and name the trap. A figure that arrives without its command is unverifiable
and will be re-measured differently by the next person.

## 5. Shape and diagrams

The file-size and diagram conventions are stated once in
[`README.md` §Conventions](docs/README.md#conventions-used-in-these-docs); read them
there. Only the measured state of the set is worth adding here, and only because
it tells you what "normal" looks like before you add a page:

- 14 of the 316 files exceed the 350-line ceiling, none by more than 38 lines,
  and one file sits below the 120-line floor. Neither bound is enforced by the
  gate — see [`README.md` §Open questions](docs/README.md#open-questions). A section
  that outgrows the ceiling gets split with a `b` suffix and both halves
  registered in the topic's `index.md`.
- 837 Mermaid blocks across 316 files: every file has at least one, the median is
  two, and the ceiling in practice is six
  ([`11-data-flows/08-export-video.md`](docs/11-data-flows/08-export-video.md)). A
  page that wants a seventh diagram is a page that wants splitting.
- Diagram nodes carry real symbol and file names. A diagram that only restates
  the table above it is a defect, not an illustration.

## Before you push

Run the gate:

```bash
node scripts/check-docs-links.mjs
```

It is fast enough to run on every save. Its own header comment in
[`../scripts/check-docs-links.mjs`](scripts/check-docs-links.mjs) is the
authoritative list of what it asserts and what is opt-in behind a flag — read it
there rather than trusting a summary here, and see
[`07-quality-gates.md` §Gate 6](docs/16-development-view/07-quality-gates.md#gate-6--the-documentation-set-check)
for where it sits among the other gates.

Two things the gate cannot do for you, which are the reason this page exists:

- **It cannot check a quantifier or a label.** "All 13 callers", "roughly thirty
  citations", "84 setters" all resolve, parse and pass. Rules 3 and 4 above are
  the only defence.
- **It cannot tell a resolved citation from a correct one.** [`lib/ai/providers.ts:2033`](lib/ai/providers.ts#L2033)
  passes as long as the file has 2033 lines. The one drift signal the gate has is a
  cited line that is *blank*, which is why rule 1 above asks for the symbol name:
  the gate checks that the address exists, and only the symbol name lets a reader
  check that it still points at the right thing.
- **It refuses ambiguous citations rather than resolving them.** 919 of this set's
  8916 citations name a path that matches more than one tracked file, and the gate
  skips every one instead of guessing — so a bare basename is not checked at all.
  That is the other half of why rule 1 asks for the repo-root-relative path.

The examples in §1 are written inside fences on purpose. Illustrated syntax
belongs in a fence, an indented block, an HTML comment or a code span; the gate
masks all four before rule 1 runs, so a placeholder path in one of them is not
resolved as a real link. This page is the regression test for that: it once had to
describe the citation convention in prose because showing it tripped the gate.
