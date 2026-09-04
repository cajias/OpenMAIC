#!/usr/bin/env node
/**
 * Make the references in `docs/` clickable in JetBrains IDEA, without changing a
 * word of the prose. Two conversions, both wrapping an existing inline code span
 * in a link so the rendered text is byte-identical apart from becoming navigable:
 *
 *   1. A code citation naming a file:
 *        `lib/ai/providers.ts:412`  ->  [`lib/ai/providers.ts:412`](lib/ai/providers.ts#L412)
 *   2. A code citation naming only a line, whose file is stated earlier in the
 *      prose:
 *        `:877`                     ->  [`:877`](lib/chat/pi/tools/call-agent.ts#L877)
 *   3. A bare relative path to a Markdown file:
 *        `../02-container-view/index.md`
 *                                   ->  [`../02-container-view/index.md`](docs/02-container-view/index.md)
 *
 * Every target is spelled from the REPO ROOT, with no leading `/` and no `../`.
 * That form is not a style preference: it is the one the maintainer measured
 * navigating in JetBrains IDEA, by clicking every candidate in
 * `docs/LINK-PROBE.md`. Note conversion 3 — the visible TEXT keeps whatever the
 * author wrote, including a `../` prefix, because the text is prose; only the
 * target is spelled from the root. `scripts/check-docs-links.mjs` rule 1a asserts
 * the same form, and `scripts/rootrel-md-links.mjs` converts a page that predates
 * it.
 *
 * The anchor form is IDEA's, not GitHub's, because IDEA is the renderer that has to
 * navigate: `#L412` is resolved by `LineNumberPathReferenceProvider` and opens the
 * file at line 412 in both the editor and the Preview pane. Uppercase `L` is
 * required — the provider's regexes carry no IGNORE_CASE flag, so `#l412` resolves
 * the path and silently drops the line. A Markdown target gets a plain path and no
 * line anchor, since a heading fragment is what reads correctly there.
 *
 * usage: node scripts/link-md-refs.mjs [--dry-run] [--json] <file.md> [...]
 *        node scripts/link-md-refs.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert';
import { CODE_SPAN, headingSlugs, maskNonProse, scanBlocks, splitLines } from './markdown-scan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** A citation span's body: `<path>:<line>[-<line>]`, where `<path>` may be empty. */
const CITATION = /^([A-Za-z0-9._@/-]*):(\d+)(?:-(\d+))?$/;

/**
 * A code span holding nothing but a relative path to a Markdown file.
 *
 * A `/` is required. That is the whole safety margin for conversion 3: a bare
 * `` `index.md` `` resolves against the citing file's own directory, and the
 * sibling `index.md` almost always exists, so linking it would be a confident
 * guess at which of the set's 30-odd `index.md` files the prose meant. There is no
 * same-line evidence to recover the directory from either — a line that already
 * names a directory-qualified doc path is naming *that* file, not a sibling of it —
 * so these are skipped as `bare-basename` and counted, never guessed.
 */
const DOC_PATH = /^\.{0,2}[A-Za-z0-9._@-]*(?:\/[A-Za-z0-9._@-]+)+\.mdx?$/;

const trackedFiles = (root) =>
  execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);

/**
 * suffix -> [paths]: every `/`-boundary suffix of every tracked path, so a citation
 * may name a bare basename (`version.ts`) or any trailing fragment
 * (`course-edit/apply.ts`). A suffix matching more than one path is ambiguous and
 * is refused, not ranked — `route.ts` alone matches 235 paths.
 */
function buildIndex(files) {
  const ix = new Map();
  for (const f of files) {
    const seg = f.split('/');
    for (let i = 0; i < seg.length; i++) {
      const key = seg.slice(i).join('/');
      const bucket = ix.get(key);
      if (bucket) bucket.push(f);
      else ix.set(key, [f]);
    }
  }
  return ix;
}

const lineCache = new Map();
function lineCount(root, rel) {
  if (!lineCache.has(rel)) {
    const buf = readFileSync(path.join(root, rel));
    let n = 0;
    for (const b of buf) if (b === 0x0a) n++;
    if (buf.length && buf[buf.length - 1] !== 0x0a) n++; // no trailing newline
    lineCache.set(rel, n);
  }
  return lineCache.get(rel);
}

/**
 * The heading a cited LINE falls under, as a slug — the nearest heading at or above
 * it — or null when the line precedes every heading in the file.
 *
 * A Markdown target must not take an `#L` anchor: IDEA opens the raw source at that
 * line rather than the rendered section, so the click leaves the reading experience.
 * A cited line is still the most precise thing the prose knows, and the enclosing
 * heading is the mechanical, checkable projection of it onto something a Markdown
 * renderer can address. It is also the convention this set already writes by hand —
 * `[`README.md:1041`](../../README.md#-license)` — so converted citations match the
 * ones an author wrote.
 */
const headingCache = new Map();
function enclosingHeading(root, rel, line) {
  if (!headingCache.has(rel)) {
    headingCache.set(rel, headingSlugs(splitLines(readFileSync(path.join(root, rel), 'utf8'))));
  }
  let found = null;
  for (const h of headingCache.get(rel)) {
    if (h.line > line) break;
    found = h.slug;
  }
  return found || null; // an empty slug addresses nothing
}

/** The tracked repo file a citation's path names, or a reason it names none. */
function resolvePath(root, index, docFile, cited) {
  // `../appendix/…` in a doc is relative to the citing document, not the repo root.
  const clean = /^\.\.?\//.test(cited)
    ? path.relative(root, path.resolve(path.dirname(path.join(root, docFile)), cited))
    : cited;
  if (!clean.includes('.')) {
    return { reason: clean.includes('/') ? 'path-no-extension' : 'symbol-only' };
  }
  const cands = index.get(clean) ?? [];
  if (cands.length === 0) return { reason: 'unresolved' };
  // An EXACT tracked path is the file, not one candidate among its own suffix
  // matches. A bucket holds every path the key is a suffix OF, including the path
  // equal to it, so without this tier the repo-root `package.json` is drowned by
  // the eleven tracked `*/package.json` and `instrumentation.ts` by
  // `packages/docs/instrumentation.ts`; both came back `ambiguous` and 15 citations
  // that name a file exactly stayed bare. Same precedence the checker's
  // `candidateTiers` already applies.
  if (cands.includes(clean)) return { target: clean };
  if (cands.length > 1) return { reason: 'ambiguous', candidates: cands };
  return { target: cands[0] };
}

/**
 * One citation span -> a decision.
 *
 * `inherited` is the file carried by the nearest preceding citation ON THE SAME
 * LINE, or null. That scope is deliberate and measured. Over `docs/` it recovers
 * the file for 1118 of the 6518 line-only citations, 98.6% of which land inside the
 * inferred file, and 45 sampled instances were correct 45 for 45. Widening it to
 * the paragraph adds 1347 more but only 88.0% of those even land inside the file,
 * so the wider rule is not adopted. Document scope was measured misfiring 101
 * times and is never used.
 *
 * Two properties make the same-line rule hold. Every table row, cell and list item
 * in this set is a single line, so "same line" is "same claim"; and the source is
 * the NEAREST preceding citation, so a row naming two files attributes each
 * line-only reference to the file it actually follows.
 */
function classify(root, index, docFile, body, inherited) {
  const m = CITATION.exec(body);
  if (!m) {
    if (!DOC_PATH.test(body)) {
      // A bare Markdown basename is the one doc path deliberately left alone.
      return /^[A-Za-z0-9._@-]+\.mdx?$/.test(body) ? { reason: 'bare-basename' } : null;
    }
    const abs = path.resolve(path.dirname(path.join(root, docFile)), body);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { reason: 'unresolved' };
    // The span TEXT is read the way the author wrote it — relative to this page —
    // but the TARGET is spelled from the repo root, and a Markdown target takes no
    // line anchor: a heading fragment is what reads correctly there.
    return { dest: path.relative(root, abs), kind: 'doc-path' };
  }

  const [, cited, aStr, bStr] = m;
  const a = Number(aStr);
  const b = bStr ? Number(bStr) : null;
  if (b !== null && b < a) return { reason: 'inverted-range' };

  const { target, reason, candidates } = cited
    ? resolvePath(root, index, docFile, cited)
    : inherited
      ? { target: inherited }
      : { reason: 'line-only-no-context' };
  if (!target) return { reason, candidates };

  if (a < 1 || (b ?? a) > lineCount(root, target)) {
    return { reason: 'line-beyond-eof', target, lines: lineCount(root, target) };
  }
  // A Markdown target takes the enclosing heading, never `#L` — see
  // `enclosingHeading`. Everything else takes the line anchor, uppercase `L`.
  const anchor = /\.mdx?$/i.test(target)
    ? (() => {
        const slug = enclosingHeading(root, target, a);
        return slug ? `#${slug}` : '';
      })()
    : `#L${a}${b === null ? '' : `-L${b}`}`;
  // `target` is already a tracked repo path, which IS the repo-root-relative form,
  // so there is no depth to count. Counting it from the page is what the set used
  // to do and what `docs/LINK-PROBE.md` measured as not navigating.
  return {
    dest: `${target}${anchor}`,
    kind: cited ? 'citation' : 'inherited',
    target,
  };
}

/**
 * One line, left to right -> the rewritten line, appending to `decisions`.
 *
 * `raw` is the source line and `maskLine` is the same line with every non-prose
 * region blanked to spaces. Masking preserves every offset, so a span located in
 * the mask splices straight into `raw`; a line inside a fence masks to all spaces,
 * finds no spans, and comes back untouched.
 */
function convertLine(root, index, docFile, raw, maskLine, lineNo, decisions) {
  let inherited = null; // the same-line rule, carried left to right
  let result = '';
  let cursor = 0;

  for (const span of maskLine.matchAll(CODE_SPAN)) {
    const body = (span[1] ?? span[2]).trim();
    const start = span.index;
    const end = start + span[0].length;
    const isLink = raw.slice(0, start).endsWith('[') && /^\]\(/.test(raw.slice(end));
    const d = classify(root, index, docFile, body, inherited);

    // A citation that NAMES a file updates the same-line context, whether this pass
    // converted it or a previous one already had — that is what makes the
    // transformer idempotent rather than merely re-entrant. One that names a file
    // and fails to resolve sets the context to null rather than leaving a stale
    // file behind: `route.ts:12` followed by `:99` must infer nothing, not the file
    // from some earlier column.
    if (d && CITATION.exec(body)?.[1]) inherited = d.target ?? null;

    if (!d) continue; // not a reference at all — invisible to this tool
    if (isLink) {
      decisions.push({ line: lineNo, text: body, action: 'skip', reason: 'already-linked' });
      continue;
    }
    if (!d.dest) {
      decisions.push({ line: lineNo, text: body, action: 'skip', ...d });
      continue;
    }
    decisions.push({ line: lineNo, text: body, action: 'convert', kind: d.kind, dest: d.dest });
    result += raw.slice(cursor, start) + `[${raw.slice(start, end)}](${d.dest})`;
    cursor = end;
  }
  return result + raw.slice(cursor);
}

/** A whole buffer. Split out from file IO so the selftest drives the real code. */
function convertText(root, index, docFile, src) {
  const lines = splitLines(src);
  // The shared scanner, not a private fence tracker: it is the one that knows a
  // ```mermaid inside a ````markdown wrapper does not close the wrapper, that an
  // indented block and an HTML comment are not prose, and that a list item's
  // four-space continuation is not a code block.
  const mask = maskNonProse(lines, scanBlocks(lines));
  const decisions = [];
  const out = lines
    .map((raw, i) => convertLine(root, index, docFile, raw, mask[i], i + 1, decisions))
    .join('\n');
  return { out, decisions, converted: decisions.filter((d) => d.action === 'convert').length };
}

function convert(root, index, docFile) {
  const abs = path.join(root, docFile);
  const src = readFileSync(abs, 'utf8');
  const r = convertText(root, index, docFile, src);
  return { file: docFile, ...r, changed: r.out !== src, abs };
}

function selftest() {
  const index = buildIndex([
    'lib/server/ssrf-guard.ts',
    'a/route.ts',
    'b/route.ts',
    'core/index.ts',
    'docs/02-container-view/index.md',
    'package.json',
    'packages/@openmaic/dsl/package.json',
  ]);
  assert.deepEqual(index.get('route.ts'), ['a/route.ts', 'b/route.ts']);
  lineCache.set('lib/server/ssrf-guard.ts', 303);
  lineCache.set('a/route.ts', 50);
  lineCache.set('package.json', 210);
  const C = (t, inh = null, doc = 'docs/x/y.md') => classify(REPO_ROOT, index, doc, t, inh);

  // Non-references stay invisible: no decision, no report.
  for (const t of [
    'fd00:ec2::254',
    'http://render-service:9000',
    '169.254.169.254',
    'ipaddr.js@^2.5.0',
    '2001:0000::/32',
    'additionalProperties: false',
    'el-<nanoid(8)>',
    'lib/ai/providers.ts',
    '96/72',
  ])
    assert.equal(C(t), null, t);

  // Conversion 1 — a citation naming a file. The target is spelled from the repo
  // root, so the SAME dest comes out at every page depth: there is no prefix to
  // count and therefore no prefix to get wrong.
  assert.equal(C('lib/server/ssrf-guard.ts:11-12').dest, 'lib/server/ssrf-guard.ts#L11-L12');
  assert.equal(C('ssrf-guard.ts:11').dest, 'lib/server/ssrf-guard.ts#L11');
  assert.equal(
    C('lib/server/ssrf-guard.ts:12', null, 'docs/appendix/research/s/f.md').dest,
    'lib/server/ssrf-guard.ts#L12',
  );
  assert.equal(
    C('lib/server/ssrf-guard.ts:12', null, 'docs/x.md').dest,
    'lib/server/ssrf-guard.ts#L12',
  );
  // Uppercase L, always: `#l12` resolves the path but loses the line in IDEA.
  assert.match(C('ssrf-guard.ts:12').dest, /#L12$/);

  // Conversion 2 — the same-line rule, and every way it refuses.
  assert.equal(C(':112', 'lib/server/ssrf-guard.ts').dest, 'lib/server/ssrf-guard.ts#L112');
  assert.equal(C(':11-12', 'lib/server/ssrf-guard.ts').dest, 'lib/server/ssrf-guard.ts#L11-L12');
  assert.equal(C(':112').reason, 'line-only-no-context'); // no same-line file: refuse
  // Inference is still bounded by the target's length — inheriting a file does not
  // license an out-of-range line.
  assert.equal(C(':400', 'lib/server/ssrf-guard.ts').reason, 'line-beyond-eof');
  assert.equal(C(':999', 'a/route.ts').reason, 'line-beyond-eof'); // 50-line file
  assert.equal(C('assertSafeIp:46').reason, 'symbol-only');
  assert.equal(C('route.ts:12').reason, 'ambiguous');
  // An exact tracked path wins over its own suffix matches. `package.json` is a
  // suffix of every workspace package's manifest, so treating the bucket as
  // undifferentiated candidates reports the repo-root file ambiguous.
  assert.deepEqual(index.get('package.json'), [
    'package.json',
    'packages/@openmaic/dsl/package.json',
  ]);
  assert.equal(C('package.json:52').dest, 'package.json#L52');
  assert.equal(C('nope/gone.ts:12').reason, 'unresolved');
  assert.equal(C('lib/server/ssrf-guard.ts:9-4').reason, 'inverted-range');
  assert.equal(C('ssrf-guard.ts:400').reason, 'line-beyond-eof');

  // Conversion 3 — a bare doc path is READ relative to the citing page and
  // TARGETED from the repo root, and takes no line anchor; a bare basename is
  // refused rather than resolved against the sibling.
  const dp = classify(
    REPO_ROOT,
    index,
    'docs/01-system-context/01-x.md',
    '../02-container-view/index.md',
    null,
  );
  assert.deepEqual(dp, { dest: 'docs/02-container-view/index.md', kind: 'doc-path' });
  assert.equal(C('index.md').reason, 'bare-basename');
  assert.equal(C('../nope/gone.md').reason, 'unresolved');

  // A citation whose target is MARKDOWN takes the enclosing heading, not `#L`:
  // IDEA would open the raw source at that line instead of the rendered section,
  // and the checker's rule 4c rejects it. Measured against the real README, whose
  // `## 📄 License` at line 1041 slugs with a leading hyphen because the slugger
  // does not trim.
  const mdIndex = buildIndex(['README.md', 'CONTRIBUTING.md']);
  const M = (t) => classify(REPO_ROOT, mdIndex, 'docs/x/y.md', t, null);
  assert.equal(M('README.md:1041').dest, 'README.md#-license');
  assert.equal(M('README.md:1044').dest, 'README.md#-license'); // still inside that section
  // The NEAREST heading wins, so a line under a nested `###` gets the subsection
  // rather than its parent — `### Third-Party Components` is at README.md:1045.
  assert.equal(M('README.md:1050').dest, 'README.md#third-party-components');
  assert.equal(M('CONTRIBUTING.md:165').dest, 'CONTRIBUTING.md#ai-assisted-prs-');
  assert.ok(!/#L/.test(M('README.md:1041').dest), 'no #L anchor on a markdown target');
  // A line above every heading has no enclosing section: link the file, no anchor.
  assert.equal(M('README.md:1').dest, 'README.md');

  // End to end over one buffer, exercising the properties that matter: the mask
  // (fence, nested fence, indented block, HTML comment), the same-line rule and its
  // poisoning by an ambiguous file, and idempotence.
  const doc = 'docs/x/y.md';
  const body = [
    'Guard [`ssrf-guard.ts:11`](lib/server/ssrf-guard.ts#L11) and `:12` on one line.',
    '',
    '`route.ts:12` then `:99` — ambiguous source, so nothing is inferred.',
    '',
    '`ssrf-guard.ts:20` then `:21`, and `:22`.',
    '',
    '```mermaid',
    'A[`ssrf-guard.ts:30`] --> B',
    '```',
    '',
    '    `ssrf-guard.ts:31`',
    '',
    '<!-- `ssrf-guard.ts:32` -->',
    '',
    'Line-only with no file at all: `:33`.',
  ].join('\n');
  const once = convertText(REPO_ROOT, index, doc, body).out;
  // An existing link on the line seeds the rule, so `:12` converts.
  assert.match(once, /and \[`:12`\]\(lib\/server\/ssrf-guard\.ts#L12\)/);
  // An ambiguous file poisons it: neither `route.ts:12` nor `:99` converts.
  assert.match(once, /^`route\.ts:12` then `:99`/m);
  // Both line-only refs after a resolvable file convert, including across a comma.
  assert.match(once, /then \[`:21`\]\([^)]*#L21\), and \[`:22`\]\([^)]*#L22\)/);
  // Nothing inside a fence, an indented block or an HTML comment is touched.
  assert.match(once, /^A\[`ssrf-guard\.ts:30`\] --> B$/m);
  assert.match(once, /^ {4}`ssrf-guard\.ts:31`$/m);
  assert.match(once, /^<!-- `ssrf-guard\.ts:32` -->$/m);
  // A line-only ref with no same-line file is refused, not guessed.
  assert.match(once, /no file at all: `:33`\.$/m);
  // Idempotent: a second pass over the output is a fixed point.
  assert.equal(convertText(REPO_ROOT, index, doc, once).out, once, 'second pass must be a no-op');

  console.log('selftest ok');
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  selftest();
  process.exit(0);
}
const dry = argv.includes('--dry-run');
const asJson = argv.includes('--json');
const targets = argv.filter((a) => !a.startsWith('--'));
if (targets.length === 0) {
  console.error('usage: link-md-refs.mjs [--dry-run] [--json] <file.md> ...');
  process.exit(2);
}

const index = buildIndex(trackedFiles(REPO_ROOT));
const results = targets.map((t) => {
  const rel = path.relative(REPO_ROOT, path.resolve(t));
  if (!existsSync(path.join(REPO_ROOT, rel))) {
    console.error(`missing: ${t}`);
    process.exit(1);
  }
  const r = convert(REPO_ROOT, index, rel);
  if (!dry && r.changed) writeFileSync(r.abs, r.out);
  return r;
});

if (asJson) {
  // `out` (whole rewritten file) and `abs` are stripped: the JSON report is the
  // decision log, not a copy of every file's contents.
  console.log(
    JSON.stringify(
      results.map(({ out: _out, abs: _abs, ...r }) => r),
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    const skips = r.decisions.filter((d) => d.action === 'skip' && d.reason !== 'already-linked');
    const kinds = {};
    for (const d of r.decisions.filter((x) => x.action === 'convert')) {
      kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    }
    const tally = {};
    for (const s of skips) tally[s.reason] = (tally[s.reason] ?? 0) + 1;
    console.log(
      `${r.file}: converted ${r.converted} ${JSON.stringify(kinds)}, ` +
        `skipped ${skips.length} ${JSON.stringify(tally)}${dry ? ' (dry-run)' : ''}`,
    );
    for (const s of skips) {
      console.log(
        `  skip ${r.file}:${s.line} \`${s.text}\` — ${s.reason}` +
          `${s.candidates ? ` (${s.candidates.length}: ${s.candidates.slice(0, 3).join(', ')})` : ''}` +
          `${s.lines ? ` (${s.target} has ${s.lines} lines)` : ''}`,
      );
    }
  }
}
