#!/usr/bin/env node
/**
 * Rewrite every Markdown link TARGET under `docs/` to be relative to the repository
 * root, with no leading `/`, no `./` and no `../`:
 *
 *   [`lib/ai/providers.ts:412`](../../lib/ai/providers.ts#L412)
 *                            -> [`lib/ai/providers.ts:412`](lib/ai/providers.ts#L412)
 *   [Container view](../02-container-view/index.md)
 *                            -> [Container view](docs/02-container-view/index.md)
 *   [x](./09-conventions.md#size-limits)
 *                            -> [x](docs/12-api-reference/09-conventions.md#size-limits)
 *
 * That form is the one the maintainer measured navigating in JetBrains IDEA, by
 * clicking every candidate in `docs/LINK-PROBE.md`. Nothing else about a link
 * changes: the link TEXT and the `#fragment` are copied byte for byte, so `#L412`,
 * `#L412-L420`, `#-license` and `#some-heading` survive exactly as written —
 * `#L`'s uppercase `L` included, since a lowercase `#l412` resolves the path and
 * silently drops the line.
 *
 * This is a sibling of `link-md-refs.mjs`, not a mode of it, because the two take
 * different input and answer different questions. `link-md-refs.mjs` reads a bare
 * inline code span and decides whether it can become a link at all; this reads a
 * link that already exists and only re-expresses where it points.
 *
 * Only links in PROSE are touched. Fenced blocks, indented blocks, HTML comments
 * and inline code spans are masked first (`markdown-scan.mjs`, the same pass both
 * reference gates use), so an *illustration* of link syntax keeps whatever form it
 * illustrates.
 *
 * usage: node scripts/rootrel-md-links.mjs [--dry-run] [--json] [<file.md> ...]
 *        node scripts/rootrel-md-links.mjs --selftest
 *
 * With no file arguments it walks `docs/**` and skips `docs/LINK-PROBE.md`, which
 * deliberately holds forms that must not resolve.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';
import { maskNonProse, scanBlocks, splitLines } from './markdown-scan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const PROBE = 'docs/LINK-PROBE.md';

/** An inline link, same shape both reference gates match. Group 1 is the target. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** A target with nothing to re-express: a scheme, `//host`, or a bare `#fragment`. */
const NOT_A_PATH = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * One link target -> where it should point, or why it is left alone.
 *
 * Resolution is RELATIVE-FIRST, and that ordering is what makes the pass
 * idempotent rather than merely re-entrant. A `../`-relative target resolves
 * against the citing file and gets rewritten; the rewritten target no longer
 * resolves that way, so the second pass falls through to the repo-root reading,
 * finds the same file, and produces itself. A target that resolves BOTH ways is
 * read as relative — that is the form the set is being converted from — and the
 * selftest pins the whole-buffer fixed point.
 */
export function retarget(root, docFile, raw) {
  if (NOT_A_PATH.test(raw)) return { reason: 'not-a-path' };
  const hash = raw.indexOf('#');
  const p = hash === -1 ? raw : raw.slice(0, hash);
  const frag = hash === -1 ? '' : raw.slice(hash); // byte for byte, `#` included
  if (!p) return { reason: 'not-a-path' };

  const decoded = decodeURIComponent(p);
  const fromDir = path.dirname(path.join(root, docFile));
  // A leading `/` means the repo root in this set, never the filesystem root, so
  // `path.resolve` would throw the whole path away. Join it on instead.
  const candidates = decoded.startsWith('/')
    ? [path.join(root, decoded)]
    : [path.resolve(fromDir, decoded), path.resolve(root, decoded)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) return { reason: 'unresolved' };

  const dest = toPosix(path.relative(root, hit));
  // A target that climbs out of the repo cannot be expressed in this form at all.
  if (dest === '' || dest.startsWith('..')) return { reason: 'outside-repo' };
  return { dest: (p === decoded ? dest : encodeURI(dest)) + frag };
}

/**
 * One buffer -> the rewritten buffer plus a decision per link.
 *
 * Split out from file IO so the selftest drives the real code. The mask preserves
 * every offset, so a target located in the mask splices straight into the raw
 * line; a link inside a fence masks to spaces, matches nothing, and comes back
 * untouched.
 */
export function convertText(root, docFile, src) {
  const lines = splitLines(src);
  const prose = maskNonProse(lines, scanBlocks(lines), { spans: true });
  const decisions = [];
  const out = lines
    .map((raw, i) => {
      let result = '';
      let cursor = 0;
      for (const m of prose[i].matchAll(LINK)) {
        // `[^\]]*` cannot hold a `]`, so the first `](` in the match is the one
        // that separates the text from the target.
        const start = m.index + m[0].indexOf('](') + 2;
        const end = start + m[1].length;
        const d = retarget(root, docFile, m[1]);
        const entry = { line: i + 1, target: m[1] };
        if (!d.dest) {
          if (d.reason !== 'not-a-path') decisions.push({ ...entry, action: 'skip', reason: d.reason });
          continue;
        }
        if (d.dest === m[1]) {
          decisions.push({ ...entry, action: 'keep' });
          continue;
        }
        decisions.push({ ...entry, action: 'convert', dest: d.dest });
        result += raw.slice(cursor, start) + d.dest;
        cursor = end;
      }
      return result + raw.slice(cursor);
    })
    .join('\n');
  return { out, decisions, converted: decisions.filter((d) => d.action === 'convert').length };
}

function convert(root, docFile) {
  const abs = path.join(root, docFile);
  const src = readFileSync(abs, 'utf8');
  const r = convertText(root, docFile, src);
  return { file: docFile, ...r, changed: r.out !== src, abs };
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function selftest() {
  // The arithmetic, at the three depths this set uses. Real files, because
  // resolution is a filesystem question and a mock would prove nothing.
  const R = (doc, t) => retarget(REPO_ROOT, doc, t);
  assert.equal(R('docs/README.md', '../lib/ai/providers.ts#L412').dest, 'lib/ai/providers.ts#L412');
  assert.equal(
    R('docs/11-data-flows/02-topic-to-classroom.md', '../../lib/ai/providers.ts#L412').dest,
    'lib/ai/providers.ts#L412',
  );
  assert.equal(
    R('docs/appendix/research/agent-runtime/00-overview.md', '../../../../lib/ai/providers.ts#L412').dest,
    'lib/ai/providers.ts#L412',
  );
  // `./sibling` and a bare sibling both take the citing file's own directory.
  assert.equal(
    R('docs/12-api-reference/index.md', './09-conventions.md#size-limits').dest,
    'docs/12-api-reference/09-conventions.md#size-limits',
  );
  assert.equal(
    R('docs/12-api-reference/index.md', '09-conventions.md').dest,
    'docs/12-api-reference/09-conventions.md',
  );
  // A leading `/` means the repo root here, not the filesystem root.
  assert.equal(R('docs/README.md', '/lib/ai/providers.ts#L412').dest, 'lib/ai/providers.ts#L412');
  // Fragments are copied, never parsed: uppercase `L`, a range, a hyphen-led
  // emoji slug, an ordinary heading.
  assert.equal(R('docs/README.md', '../README.md#L1041-L1050').dest, 'README.md#L1041-L1050');
  assert.equal(R('docs/README.md', '../README.md#-license').dest, 'README.md#-license');
  assert.equal(
    R('docs/README.md', './02-container-view/index.md#topic-overview').dest,
    'docs/02-container-view/index.md#topic-overview',
  );
  // A directory link loses its trailing slash — IDEA resolves directory
  // references with endingSlashNotAllowed, so `docs/appendix/` does not navigate.
  assert.equal(R('docs/README.md', './appendix/').dest, 'docs/appendix');
  // Nothing to re-express, and nothing reported.
  for (const t of ['https://example.com/x', 'http://h/x', 'mailto:a@b.c', '#same-file', '//cdn/x'])
    assert.equal(R('docs/README.md', t).reason, 'not-a-path', t);
  // Refused rather than guessed.
  assert.equal(R('docs/README.md', '../nope/gone.md').reason, 'unresolved');
  assert.equal(R('docs/README.md', '../../..').reason, 'outside-repo');
  // Already converted: a fixed point, reported as `keep`, not rewritten.
  assert.equal(R('docs/README.md', 'lib/ai/providers.ts#L412').dest, 'lib/ai/providers.ts#L412');
  assert.equal(R('docs/README.md', 'docs/02-container-view/index.md').dest, 'docs/02-container-view/index.md');

  // End to end over one buffer: the mask (fence, nested fence, indented block,
  // HTML comment, inline code span), link text preserved byte for byte, and
  // idempotence.
  const doc = 'docs/12-api-reference/index.md';
  const body = [
    'Guard [`lib/ai/providers.ts:412`](../../lib/ai/providers.ts#L412) and',
    '[conventions](./09-conventions.md#size-limits) and [license](../../README.md#-license).',
    '',
    '```markdown',
    '[fenced](../../lib/ai/providers.ts#L412)',
    '```',
    '',
    '    [indented](../../lib/ai/providers.ts#L412)',
    '',
    '<!-- [commented](../../lib/ai/providers.ts#L412) -->',
    '',
    '````markdown',
    '```mermaid',
    '[nested](../../lib/ai/providers.ts#L412)',
    '```',
    '````',
    '',
    'Inline `[spanned](../../lib/ai/providers.ts#L412)` stays a span.',
    '',
    '[external](https://example.com/a) and [dead](../../nope/gone.ts#L1).',
  ].join('\n');
  const { out: once, decisions } = convertText(REPO_ROOT, doc, body);
  assert.match(once, /^Guard \[`lib\/ai\/providers\.ts:412`\]\(lib\/ai\/providers\.ts#L412\) and$/m);
  assert.match(once, /^\[conventions\]\(docs\/12-api-reference\/09-conventions\.md#size-limits\) and /m);
  assert.match(once, /\[license\]\(README\.md#-license\)\.$/m);
  // Non-prose keeps whatever form it illustrates.
  for (const label of ['fenced', 'indented', 'commented', 'nested', 'spanned']) {
    assert.match(once, new RegExp(`\\[${label}\\]\\(\\.\\./\\.\\./lib/ai/providers\\.ts#L412\\)`), label);
  }
  // An unresolvable target is left exactly as written and reported.
  assert.match(once, /\[dead\]\(\.\.\/\.\.\/nope\/gone\.ts#L1\)\.$/m);
  assert.equal(decisions.filter((d) => d.action === 'skip' && d.reason === 'unresolved').length, 1);
  // An external URL is invisible to this tool: no decision, no report.
  assert.ok(!decisions.some((d) => d.target.startsWith('https://')));
  assert.equal(convertText(REPO_ROOT, doc, once).out, once, 'second pass must be a no-op');

  console.log('selftest ok');
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const asJson = argv.includes('--json');
  const args = argv.filter((a) => !a.startsWith('--'));
  const targets = (
    args.length
      ? args.map((t) => toPosix(path.relative(REPO_ROOT, path.resolve(t))))
      : walk(DOCS_DIR)
          .map((f) => toPosix(path.relative(REPO_ROOT, f)))
          .filter((f) => f !== PROBE)
          .sort()
  ).filter((f) => {
    if (!existsSync(path.join(REPO_ROOT, f))) {
      console.error(`missing: ${f}`);
      process.exit(1);
    }
    // The convention is this documentation set's, not the whole repo's. Pointing
    // this at README.md would silently rewrite every relative link in it, and
    // nothing downstream expects or enforces that.
    if (!f.startsWith('docs/')) {
      console.error(`refusing ${f}: this convention applies to docs/ only`);
      process.exit(1);
    }
    return true;
  });

  const results = targets.map((f) => {
    const r = convert(REPO_ROOT, f);
    if (!dry && r.changed) writeFileSync(r.abs, r.out);
    return r;
  });

  if (asJson) {
    console.log(JSON.stringify(results.map(({ out, abs, ...r }) => r), null, 2));
    return;
  }
  const total = { convert: 0, keep: 0, skip: 0 };
  for (const r of results) {
    for (const d of r.decisions) total[d.action]++;
    const skips = r.decisions.filter((d) => d.action === 'skip');
    if (r.converted || skips.length) {
      console.log(
        `${r.file}: converted ${r.converted}, kept ${
          r.decisions.filter((d) => d.action === 'keep').length
        }, skipped ${skips.length}${dry ? ' (dry-run)' : ''}`,
      );
    }
    for (const s of skips) console.log(`  skip ${r.file}:${s.line} ${s.target} — ${s.reason}`);
  }
  console.log(
    `${results.length} files: ${total.convert} converted, ${total.keep} already root-relative, ` +
      `${total.skip} skipped${dry ? ' (dry-run, nothing written)' : ''}`,
  );
}

// Only when run as a script. `convertText` and `retarget` are exported so a gate or
// a test can drive them, and an import must never silently rewrite 317 files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else main(argv);
}
