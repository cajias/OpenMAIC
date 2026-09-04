#!/usr/bin/env node
/**
 * PostToolUse hook — validate the references in the ONE markdown file just written.
 *
 * Single-file scope, no network, no whole-set walk. It always exits 0 in hook mode
 * and hands its findings back as PostToolUse `additionalContext`: authoring is
 * iterative and a blocking hook on markdown edits is a hook that gets uninstalled.
 * The pre-merge gate is `scripts/check-docs-links.mjs`; this is the inner loop.
 *
 * Checks, all local to the edited file:
 *   1. Markdown links resolve to a FILE. `fs.existsSync` is true for a directory,
 *      which is why the whole-set gate misses this class. Under `docs/` a target
 *      must also be spelled from the repo root — no leading `/`, no `./`, no `../`
 *      — because that is the only form measured navigating in JetBrains IDEA (see
 *      `docs/LINK-PROBE.md`), and the corrected form is printed with the finding.
 *      Markdown OUTSIDE `docs/` keeps ordinary relative resolution: the root-
 *      relative convention is this documentation set's, not the whole repo's.
 *   2. `#L<n>` / `#L<a>-L<b>` line anchors address a real line range and are within
 *      the target's length, and are flagged when the target is Markdown — GitHub
 *      renders .md and drops the anchor.
 *   3. `path:line` citations in code spans: the path resolves (repo-root-relative,
 *      or as a unique path suffix of a tracked file) and the line is within EOF.
 *   4. A cited start line that is blank — the cheapest available drift signal.
 *   5. `...` elided paths in a citation, which resolve to nothing anywhere.
 *   6. Heading anchors (`#slug`), same-file and cross-file, against a GitHub slugger.
 *
 * Bare-basename citations (`route.ts:412` — `route.ts` matches 70 paths in this
 * repo) are NOT resolved by guessing; they are reported as ambiguous so the author
 * writes the repo-root-relative path instead.
 *
 * Non-prose regions are skipped: fenced blocks, indented code blocks and HTML
 * comments hold example syntax and Mermaid node labels, and Mermaid labels take no
 * inline Markdown so nothing there is fixable. `scanBlocks` in
 * `../markdown-scan.mjs` decides what counts, once, for every rule here.
 *
 * Renderer caveat, recorded and not solved: `#L` anchors are a GitHub blob-view
 * convention. `packages/docs` is a Fumadocs workspace and would not honour them.
 *
 * Usage:
 *   echo '{"tool_input":{"file_path":"docs/x.md"}}' | node scripts/hooks/check-md-refs.mjs
 *   node scripts/hooks/check-md-refs.mjs docs/x.md      # CLI mode: prints, exits 1 on problems
 *   node scripts/hooks/check-md-refs.mjs --selftest     # positive + negative control
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  headingSlugs,
  lineRangeError,
  maskNonProse,
  RELATIVE_FORM,
  rootRelative,
  scanBlocks,
  splitLines,
} from '../markdown-scan.mjs';

// Resolved from this file, never process.cwd(): a gate that cannot find its input
// and exits 0 launders absence as a pass.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs') + path.sep;

/**
 * The one file this hook stays quiet about. `docs/LINK-PROBE.md` deliberately holds
 * link forms that must not resolve so a human can click each one; the pre-merge
 * gate skips it for the same reason. Delete both skips with the probe file.
 */
const LINK_PROBE = path.join(ROOT, 'docs', 'LINK-PROBE.md');

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CITE = /`\s*([A-Za-z0-9_@.\-/[\]]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?\s*`/g;

let trackedCache = null;
const tracked = () => (trackedCache ??= execFileSync('git', ['-C', ROOT, 'ls-files'], {
  maxBuffer: 1 << 28,
}).toString().split('\n').filter(Boolean));

const bodyCache = new Map();
/** Real lines of a file (a trailing newline is a terminator, not an empty line). */
function bodyOf(abs) {
  if (!bodyCache.has(abs)) {
    let lines = null;
    try {
      lines = splitLines(fs.readFileSync(abs, 'utf8'));
      if (lines.at(-1) === '') lines.pop();
    } catch {}
    bodyCache.set(abs, lines);
  }
  return bodyCache.get(abs);
}

const slugCache = new Map();
/** slug -> true for every heading in a markdown file, with -1/-2 dedupe suffixes. */
function slugsOf(abs) {
  if (!slugCache.has(abs)) {
    slugCache.set(abs, new Set(headingSlugs(bodyOf(abs) ?? []).map((h) => h.slug)));
  }
  return slugCache.get(abs);
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

/** A cited path -> its absolute location, or why we refuse to name one. */
function resolveCited(p, fromDir) {
  // An elision is `.../` or `/...`; `[...path]` is a Next.js catch-all segment and
  // `...nextTs` is a spread operator, neither of which is one.
  if (/(^|\/)\.\.\.(\/|$)/.test(p.replace(/\[\.\.\.[^\]]*\]/g, ''))) return { elided: true };
  // A leading `/` is a container or URL path in this set (`/root/.cache`), never a citation.
  if (p.startsWith('/')) return { skip: true };
  if (p.startsWith('./') || p.startsWith('../')) {
    const to = path.resolve(fromDir, p);
    return isFile(to) ? { abs: to } : { missing: true };
  }
  // Repo-root-relative covers root-level files too: `package.json:12`, `Dockerfile:95`.
  const direct = path.join(ROOT, p);
  if (isFile(direct)) return { abs: direct };
  if (!p.includes('/')) return { basename: true };
  const hits = tracked().filter((f) => f.endsWith(`/${p}`));
  if (hits.length === 1) return { abs: path.join(ROOT, hits[0]) };
  if (hits.length > 1) return { candidates: hits.length, missing: true };
  return { missing: true };
}

export function check(abs) {
  if (abs === LINK_PROBE) return [];
  const rel = path.relative(ROOT, abs);
  // The repo-root-relative link convention is this documentation set's. A README
  // or a package DESIGN.md is still read relative to itself.
  const inDocs = abs.startsWith(DOCS);
  const lines = bodyOf(abs);
  if (lines === null) return [];
  const problems = [];
  const add = (line, message) => problems.push(`${rel}:${line} — ${message}`);
  const anchors = [];

  // One masking pass, two views of it. `prose` also blanks inline code spans, so
  // documented link syntax inside backticks is not resolved as a link; `spans`
  // keeps them, because a code citation lives inside one. Both preserve offsets,
  // so line numbers below are the file's own.
  const blocks = scanBlocks(lines);
  const prose = maskNonProse(lines, blocks, { spans: true });
  const spans = maskNonProse(lines, blocks);

  lines.forEach((_, i) => {
    const line = i + 1;

    for (const m of prose[i].matchAll(LINK)) {
      const raw = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
      const hash = raw.indexOf('#');
      const targetPath = hash === -1 ? raw : raw.slice(0, hash);
      const frag = hash === -1 ? '' : raw.slice(hash + 1);
      if (!targetPath) {
        if (frag) anchors.push({ line, frag, abs, raw });
        continue;
      }
      // Form before resolution, so a wrongly spelled target is one finding that
      // names the fix rather than three that describe its consequences.
      if (inDocs && RELATIVE_FORM.test(targetPath)) {
        add(
          line,
          `link target is ${targetPath.startsWith('/') ? 'leading-slash absolute' : 'relative to this file'}` +
            ` — spell it from the repo root: ${raw} -> ${rootRelative(rel, raw)}`,
        );
        continue;
      }
      const to = inDocs
        ? path.join(ROOT, decodeURIComponent(targetPath))
        : path.resolve(path.dirname(abs), decodeURIComponent(targetPath));
      if (!fs.existsSync(to)) {
        add(line, `dead link: ${raw}`);
        continue;
      }
      if (!fs.statSync(to).isFile()) {
        add(line, `link resolves to a directory, not a document: ${raw}`);
        continue;
      }
      if (!frag) continue;
      const range = frag.match(/^L(\d+)(?:-L(\d+))?$/);
      if (!range) {
        // A lowercase `l` is the dangerous one: IDEA resolves the path, drops the
        // line and lands on line 1, so the link works and points at the wrong
        // place. Named here rather than left to the heading check, which would
        // report "no heading slugs to l412" about a TypeScript file.
        if (/^l\d+(?:-l?\d+)?$/.test(frag)) {
          add(
            line,
            `anchor "#${frag}" uses a lowercase "l" — IDEA opens ${path.relative(ROOT, to)} but drops ` +
              `the line and lands on line 1; write "#${frag.replace(/l/g, 'L')}"`,
          );
        } else if (/\.mdx?$/i.test(to)) {
          anchors.push({ line, frag, abs: to, raw });
        }
        // Anything else on a non-Markdown target has no headings to resolve
        // against — same boundary the whole-set gate's rule 4 draws.
        continue;
      }
      if (/\.mdx?$/i.test(to)) {
        add(line, `#L anchor on a markdown target is dropped by GitHub: ${raw}`);
      }
      const start = Number(range[1]);
      const last = Number(range[2] ?? range[1]);
      const bad = lineRangeError(start, last);
      if (bad) {
        add(line, `#L anchor ${bad}: ${raw}`);
        continue;
      }
      const n = (bodyOf(to) ?? []).length;
      if (last > n) add(line, `#L anchor past end of ${path.relative(ROOT, to)} (${n} lines): ${raw}`);
    }

    // `path:line` citations.
    for (const m of spans[i].matchAll(CITE)) {
      const [span, p, startStr, endStr] = m;
      const r = resolveCited(p, path.dirname(abs));
      if (r.elided) {
        add(line, `elided path in a citation resolves to nothing: ${span}`);
        continue;
      }
      if (!r.abs) {
        // Without a line number a path is a MENTION, not a citation: npm package names,
        // globs, build outputs, `.env.local`, Next.js convention filenames. Reporting
        // those buries the real findings. A line number makes it a claim about repo
        // content, and then it has to resolve. A bare basename is a shape defect, not a
        // truth defect — 3298 already exist, so flagging them here would bury the real
        // findings on every edit to a legacy file. Enforce the shape at authoring time.
        if (startStr && r.missing) {
          add(
            line,
            r.candidates
              ? `citation matches ${r.candidates} tracked paths — write it repo-root-relative: ${span}`
              : `cited path is not a tracked file: ${span}`,
          );
        }
        continue;
      }
      if (!startStr) continue;
      const body = bodyOf(r.abs) ?? [];
      const start = Number(startStr);
      const end = Number(endStr ?? startStr);
      const shown = path.relative(ROOT, r.abs);
      // Validate before indexing: `body[start - 1]` on line 0 or on a backwards
      // range throws, and in hook mode that used to silence the whole file.
      const bad = lineRangeError(start, end);
      if (bad) {
        add(line, `citation ${bad}: ${span}`);
      } else if (end > body.length) {
        add(line, `cited line past end of ${shown} (${body.length} lines): ${span}`);
      } else if (body[start - 1].trim() === '') {
        add(line, `cited line ${start} of ${shown} is blank — the citation has drifted: ${span}`);
      }
    }
  });

  for (const a of anchors) {
    if (!slugsOf(a.abs).has(a.frag)) {
      const where = a.abs === abs ? 'this file' : path.relative(ROOT, a.abs);
      add(a.line, `no heading in ${where} slugs to "${a.frag}": ${a.raw}`);
    }
  }

  const lineOf = (s) => Number(s.match(/:(\d+) —/)?.[1] ?? 0);
  return problems.sort((a, b) => lineOf(a) - lineOf(b));
}

// ── entry points ─────────────────────────────────────────────────────────────

/**
 * `check`, with an internal failure surfaced as a finding instead of as silence.
 *
 * This wrapper exists because the alternative was measured: one citation with an
 * unusable line number threw, the hook's bare `catch {}` discarded it, and the
 * hook printed nothing — so a file full of broken references came back clean. A
 * gate that cannot run has to say so louder than a gate that found nothing.
 */
function checkSafe(abs) {
  try {
    return check(abs);
  } catch (err) {
    // Deliberately no `path.relative` here: a handler that can itself throw is
    // the same defect one level up.
    const where = err?.stack?.split('\n').slice(0, 2).join(' | ') ?? String(err);
    return [
      `${String(abs)}:0 — reference check CRASHED, so this file was NOT checked. ` +
        `Report this: ${where}`,
    ];
  }
}

function selftest() {
  const assert = (ok, what) => {
    if (!ok) throw new Error(`selftest FAILED: ${what}`);
    console.log(`  ok  ${what}`);
  };
  const fixture = path.join(ROOT, 'docs', '.check-md-refs-selftest.md');
  // Every line is a deliberate defect except the ones marked GOOD.
  fs.writeFileSync(
    fixture,
    [
      '# Heading One',
      '',
      '[self](#heading-one) GOOD',
      '[nope](#heading-two)',
      '[ok](README.md) GOOD',
      '[gone](lib/does-not-exist.ts)',
      '[dir](docs/appendix)',
      '[past](lib/ai/providers.ts#L999999)',
      '[mdanchor](README.md#L3)',
      '[good line](lib/ai/providers.ts#L1) GOOD',
      '`lib/ai/providers.ts:999999`',
      '`lib/ai/providers.ts:1` GOOD',
      '`lib/does/not/exist.ts:4`',
      '`app/api/.../route.ts:63`',
      '`route.ts:12`',
      '`package.json:1`',
      // Line numbers that cannot index a body. Before these were validated they
      // threw, and hook mode swallowed the throw and reported nothing at all.
      '`lib/ai/providers.ts:0`',
      '`lib/ai/providers.ts:400-300`',
      '[zero](lib/ai/providers.ts#L0)',
      // A leading character the slugger strips leaves its space behind, so the
      // anchor keeps a leading hyphen. Trimming after the drop breaks this.
      '[emoji heading](README.md#-overview) GOOD',
      // A CRLF target: splitting on `\n` alone leaves a `\r` that stops every
      // heading in it from matching, emptying its whole slug table.
      '[crlf](packages/@openmaic/importer/DESIGN.md#分层职责) GOOD',
      '',
      '```',
      '[fenced dead link](../lib/does-not-exist.ts)',
      '`lib/does/not/exist.ts:4`',
      '```',
      '',
      '    [indented dead link](../lib/does-not-exist.ts)',
      '',
      '<!-- [commented dead link](../lib/does-not-exist.ts) -->',
      '',
      '````markdown',
      '```mermaid',
      '[dead link in a nested fence](../lib/does-not-exist.ts)',
      '```',
      '````',
      '',
      'Inline: `[spanned](../lib/does-not-exist.ts)` and ``[doubled](../lib/does-not-exist.ts)``.',
      '',
      // A four-space list continuation is paragraph text, not a code block: the
      // reference on it has to stay checked.
      '15. A list item',
      '    [continuation dead link](lib/does-not-exist.ts)',
      '',
      // The three forms the set was written in before, all of which resolve
      // perfectly well from this file and none of which navigates in IDEA. Each
      // must come back as ONE finding carrying the corrected target.
      '[relform](../README.md)',
      '[dotslash](./README.md)',
      '[slashform](/README.md)',
      '',
    ].join('\n'),
  );
  try {
    const got = check(fixture);
    const has = (needle) => got.some((p) => p.includes(needle));
    assert(got.length === 15, `15 problems in the broken fixture, got ${got.length}\n${got.join('\n')}`);
    assert(has(':4 — no heading in this file slugs to "heading-two"'), 'broken same-file anchor');
    assert(has(':6 — dead link'), 'dead relative link');
    assert(has(':7 — link resolves to a directory'), 'directory link');
    assert(has(':8 — #L anchor past end of lib/ai/providers.ts'), '#L past EOF');
    assert(has(':9 — #L anchor on a markdown target'), '#L on markdown');
    assert(has(':11 — cited line past end of lib/ai/providers.ts'), 'citation past EOF');
    assert(has(':13 — cited path is not a tracked file'), 'citation to missing file');
    assert(has(':14 — elided path in a citation'), 'elided citation path');
    assert(!has(':15'), 'bare-basename citation deliberately silent (hookify owns shape)');
    assert(!has(':16'), 'package.json:1 accepted (root-level file is repo-root-relative)');
    assert(has(':17 — citation line numbers are 1-based'), 'cited line 0 is a finding, not a crash');
    assert(has(':18 — citation line range runs backwards'), 'backwards citation range');
    assert(has(':19 — #L anchor line numbers are 1-based'), '#L0 is a finding, not a crash');
    assert(!has(':20 ') && !has(':21 '), 'emoji-stripped and CRLF anchors resolve');
    // Fence body, indented block, HTML comment, nested fence, inline spans.
    assert(
      !got.some((p) => /:(?:24|25|28|30|34|38) —/.test(p)),
      'non-prose defects are ignored',
    );
    assert(has(':41 — dead link'), 'a four-space list continuation stays checked');
    assert(!has(':3 ') && !has(':5 ') && !has(':10 ') && !has(':12 '), 'the GOOD lines pass');
    // The old link forms, each rejected once, each carrying the corrected target.
    // A `../` target inside a fence (line 24) is still NOT a form error, which is
    // what keeps this rule from reporting illustrated syntax.
    assert(
      has(':43 — link target is relative to this file — spell it from the repo root: ../README.md -> README.md'),
      'a `../`-relative target is rejected with its fix',
    );
    assert(
      has(':44 — link target is relative to this file — spell it from the repo root: ./README.md -> docs/README.md'),
      'a `./`-relative target is rejected with its fix',
    );
    assert(
      has(':45 — link target is leading-slash absolute — spell it from the repo root: /README.md -> README.md'),
      'a leading-slash target is rejected with its fix',
    );
  } finally {
    fs.unlinkSync(fixture);
  }

  // Markdown OUTSIDE `docs/` keeps ordinary relative resolution. Without this the
  // hook would flag every relative link in the repo's 132 non-docs pages the first
  // time anyone edited one.
  const outside = path.join(ROOT, '.check-md-refs-selftest-outside.md');
  fs.writeFileSync(outside, ['# Outside', '', '[a](README.md)', '[b](./README.md)', '[c](docs/README.md)', ''].join('\n'));
  try {
    const got = check(outside);
    assert(got.length === 0, `a non-docs page's relative links pass, got ${JSON.stringify(got)}`);
  } finally {
    fs.unlinkSync(outside);
  }

  // The probe page is deliberately full of forms that must not resolve.
  assert(check(LINK_PROBE).length === 0, 'docs/LINK-PROBE.md is skipped');

  // The failure this whole wrapper exists for: an internal crash must arrive as a
  // finding. Nothing else in the file proves the catch is not a silencer.
  assert(
    checkSafe(path.join(ROOT, 'docs', '.no-such-selftest-file.md')).length === 0,
    'an unreadable file is not a crash — bodyOf returns null and check returns []',
  );
  const crashed = checkSafe(42); // not a path: check() throws on it
  assert(
    crashed.length === 1 && crashed[0].includes('CRASHED'),
    `an internal error surfaces as a finding, got ${JSON.stringify(crashed)}`,
  );
  console.log('selftest ok');
}

const readStdin = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};

const arg = process.argv[2];
if (arg === '--selftest') {
  selftest();
} else if (arg) {
  const problems = checkSafe(path.resolve(ROOT, arg));
  for (const p of problems) console.log(p);
  process.exit(problems.length ? 1 : 0);
} else {
  // Hook mode: never fail the session, never block. Report, or say nothing.
  let file;
  try {
    file = JSON.parse(await readStdin())?.tool_input?.file_path;
  } catch (err) {
    // A hook that cannot read its own payload is broken, not satisfied.
    process.stderr.write(`check-md-refs: unreadable hook payload (${err.message})\n`);
  }
  if (file && /\.mdx?$/i.test(file)) {
    const abs = path.resolve(ROOT, file);
    if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs)) {
      const problems = checkSafe(abs);
      if (problems.length) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: `Broken references in the file you just wrote — fix them now:\n${problems.join('\n')}`,
            },
          }),
        );
      }
    }
  }
}
