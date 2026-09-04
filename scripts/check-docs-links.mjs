/**
 * Reference gate for the architecture documentation set under `docs/`.
 *
 * Assertions, in order of how often they have actually broken:
 *
 *   1. Every Markdown link is spelled from the REPO ROOT — no leading `/`, no
 *      `./`, no `../` — and resolves to a file on disk. The form is not a style
 *      preference: it is the only one measured navigating in JetBrains IDEA, by
 *      clicking every candidate in `docs/LINK-PROBE.md`. A `../`-relative or
 *      leading-slash target is reported with the corrected form, because the whole
 *      set was once written in the relative form and a single copied prefix is how
 *      it creeps back. Only links in prose: fenced blocks, indented code blocks,
 *      HTML comments and inline code spans are masked first, so an *illustration*
 *      of link syntax is not resolved as a link. Every rule below shares that one
 *      masking pass (`scanBlocks`/`maskNonProse` in `markdown-scan.mjs`) rather
 *      than tracking fences itself — three private trackers is how a ````markdown
 *      wrapper desynced the Mermaid scanner from the citation scanner.
 *      `scripts/rootrel-md-links.mjs` performs the conversion this rule enforces.
 *   2. Every `*.md` in a topic directory is registered in that directory's
 *      `index.md` (an unregistered section file is unreachable in a rendered
 *      site, and an index row pointing at nothing is a dead link), and every file
 *      anywhere is the target of at least one link from another file.
 *   3. Every ```mermaid fence is closed, declares an allowed diagram type, and
 *      avoids the three syntax traps that have broken blocks in this set:
 *      a bare `;` in a `sequenceDiagram` message or note (`;` is a statement
 *      separator, and quoting does not protect it), a `participant` alias that
 *      collides with a `sequenceDiagram` keyword, and a second `:` inside a
 *      `classDiagram` relationship label.
 *   4. Every `#fragment` on a Markdown link resolves to a real heading in the
 *      target file, under GitHub's heading-slug rules.
 *   5. Every `path:line` code citation names a tracked repo file and cites a line
 *      within that file. This is the rot detector: it turns a code refactor that
 *      moves or deletes a cited file into a failing docs check.
 *   6. Every `http(s)://` URL parses, and uses https unless the host is local or
 *      internal.
 *
 * Deliberately advisory rather than asserted by default:
 *
 *   - Navigability (`--navigability`): a code citation should be a Markdown link,
 *     not a bare code span. The set currently has ~20k bare spans, so this is
 *     opt-in; the count is always in the summary. Turning it on before the
 *     citations are converted would make the gate permanently red.
 *   - `--mermaid` sends every block through the real parser via `mmdc`
 *     (`@mermaid-js/mermaid-cli`, must be on PATH). One headless browser per
 *     block, serially: roughly a second per block, about fifteen minutes over the
 *     whole set. Pre-merge or nightly, not inner-loop.
 *   - `--external` probes external URLs over the network. Never in the default
 *     path: a gate that fails on flaky wifi gets deleted. Internal and templated
 *     hosts are never fetched.
 *
 * Usage: node scripts/check-docs-links.mjs [--mermaid] [--external]
 *                                          [--navigability] [--quiet]
 *        node scripts/check-docs-links.mjs --selftest
 *        node scripts/check-docs-links.mjs --slugtest=<path/to/github-slugger>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CODE_SPAN,
  headingSlugs,
  headingText,
  maskNonProse,
  RELATIVE_FORM,
  rootRelative,
  scanBlocks,
  slugify,
  splitLines,
} from './markdown-scan.mjs';

// Resolve from this file, not process.cwd(): a gate that reports "docs/ is
// absent — nothing to check" and exits 0 launders a wrong cwd as a pass.
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

/**
 * The one file under `docs/` this gate does not read.
 *
 * `LINK-PROBE.md` is a disposable diagnostic page whose whole purpose is to hold
 * link forms that are *meant* to fail — a leading-slash target, a lowercase `#l`,
 * a `../`-relative target — so a human can click each one and report which
 * navigates. Checking it produced eight permanent problems and made a green run
 * impossible, which is worse than not checking one throwaway page. Delete this
 * constant when the probe file is deleted.
 */
const LINK_PROBE = path.join(DOCS_DIR, 'LINK-PROBE.md');
const RUN_MERMAID = process.argv.includes('--mermaid');
const RUN_EXTERNAL = process.argv.includes('--external');
const RUN_NAVIGABILITY = process.argv.includes('--navigability');
const QUIET = process.argv.includes('--quiet');

const ALLOWED_DIAGRAMS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'classDiagram',
  'mindmap',
  'timeline',
];

// `sequenceDiagram` statement keywords. A participant alias that matches one of
// these (case-insensitively) makes every later reference to it a parse error.
const SEQUENCE_KEYWORDS = new Set([
  'activate',
  'alt',
  'and',
  'autonumber',
  'box',
  'break',
  'create',
  'critical',
  'deactivate',
  'destroy',
  'else',
  'end',
  'link',
  'links',
  'loop',
  'note',
  'opt',
  'option',
  'par',
  'participant',
  'rect',
  'title',
]);

// A sequenceDiagram statement whose text runs to end of line: an arrow message
// (`A->>B: …`, `A--xB: …`, `A-)B: …`) or a positional note (`Note over A,B: …`).
const SEQUENCE_MESSAGE = new RegExp(
  String.raw`^\s*(?:\S+\s*(?:-{1,2}[>x)]{1,2}|-{1,2}>>)\s*\S+` +
    String.raw`|Note\s+(?:over|left of|right of)\s[^:]+)\s*:`,
);

const problems = [];

function report(file, line, message) {
  problems.push({ file: path.relative(REPO_ROOT, file), line, message });
}

const repoRel = (p) => path.relative(REPO_ROOT, p);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.md') && full !== LINK_PROBE) acc.push(full);
  }
  return acc;
}

/** Every `#fragment` seen on a link, for rule 4. Filled by rule 1's link walk. */
const anchorRefs = [];

// Rule 1a's two predicates — the form, and the arithmetic that prints the fix —
// live in `markdown-scan.mjs`, shared with the PostToolUse hook so the pre-merge
// gate and the inner loop cannot disagree about what a valid target looks like.

/**
 * Rule 1 — relative links resolve. Also harvests fragments for rule 4.
 *
 * `prose` is the file with fences, indented blocks, HTML comments and inline code
 * spans blanked out, offsets preserved. Scanning raw text here is what made the
 * page documenting this convention unable to show the convention: a bracketed
 * label followed by a parenthesised placeholder path, inside a fence, was resolved
 * as a real link and reported dead.
 */
function checkLinks(file, prose) {
  prose.forEach((text, i) => {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
      const hash = raw.indexOf('#');
      const target = hash === -1 ? raw : raw.slice(0, hash);
      // Rule 1a — the FORM, checked before anything else so a wrongly spelled
      // target is reported once, as a form error, rather than a second time as a
      // dead link and a third time as a dead anchor.
      if (target && RELATIVE_FORM.test(target)) {
        report(
          file,
          i + 1,
          `link "${raw}" is ${target.startsWith('/') ? 'leading-slash absolute' : 'relative to this file'} — ` +
            'every target in this set is spelled from the repo root with no leading slash; write ' +
            `"${rootRelative(repoRel(file), raw)}"`,
        );
        continue;
      }
      if (hash !== -1) {
        anchorRefs.push({
          file,
          line: i + 1,
          raw,
          target,
          frag: decodeURIComponent(raw.slice(hash + 1)),
        });
      }
      if (!target) continue; // a same-file `#fragment` has no path to resolve
      const resolved = path.join(REPO_ROOT, decodeURIComponent(target));
      if (!fs.existsSync(resolved)) {
        report(file, i + 1, `dead link: ${raw}`);
        continue;
      }
      // Rule 1b — a trailing slash. `path.join` strips it, so `fs.existsSync`
      // above is happy and the link looks fine here; IDEA resolves the directory
      // reference with `endingSlashNotAllowed=true` and it does not resolve at all.
      // `docs/appendix` navigates, `docs/appendix/` is dead.
      if (target.endsWith('/')) {
        report(
          file,
          i + 1,
          `link "${raw}" ends in a slash — IDEA resolves directory references with ` +
            `endingSlashNotAllowed, so this does not navigate; write "${target.replace(/\/+$/, '')}"`,
        );
      }
    }
  });
}

/**
 * Rule 2b — every file is the target of at least one link from another file.
 *
 * Rule 2 only covers directories that have an `index.md`. The evidence packs under
 * `appendix/research/*` do not, and 25 of their files were once reachable from nothing in
 * a rendered site because their pack overview named siblings in prose instead of linking
 * them. This rule is the one that catches that.
 *
 * Reads the masked prose, not the raw file: a link inside a fenced example is a
 * sample, and letting it count as an inbound link would make an unreachable page
 * look reachable.
 */
function checkReachability(files, proseByFile) {
  const linked = new Set();
  for (const file of files) {
    const text = proseByFile.get(file).join('\n');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      const target = decodeURIComponent(raw.split('#')[0]);
      if (!target) continue;
      // BOTH readings count as an inbound link. A wrongly spelled target is rule
      // 1a's finding, and reporting the page it points at as unreachable as well
      // would bury the one message that names the fix.
      for (const resolved of [
        path.join(REPO_ROOT, target),
        path.resolve(path.dirname(file), target),
      ]) {
        if (resolved !== file) linked.add(resolved);
      }
    }
  }
  const root = path.join(DOCS_DIR, 'README.md');
  for (const file of files) {
    if (file !== root && !linked.has(file)) {
      report(file, 0, 'no other file links to this one — it is unreachable in a rendered site');
    }
  }
}

/** Rule 2 — every section file is registered in its directory's index.md. */
function checkRegistration(dir) {
  const indexPath = path.join(dir, 'index.md');
  if (!fs.existsSync(indexPath)) return;
  const index = fs.readFileSync(indexPath, 'utf8');
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md') || name === 'index.md') continue;
    if (!index.includes(name)) {
      report(indexPath, 0, `${name} exists but is not registered in this index`);
    }
  }
}

/**
 * Rule 3 — Mermaid fence hygiene plus the three known syntax traps.
 *
 * The blocks come from the shared scan, not from a private one. A private scanner
 * that opens on ` ```mermaid ` and closes on the next ` ``` ` reads a ```mermaid
 * example nested inside a ````markdown block as a real diagram, and then its idea
 * of where fences end disagrees with every other rule's.
 */
function checkMermaid(file, lines, scan) {
  const blocks = scan.fences
    .filter((f) => f.info === 'mermaid')
    .map((f) => ({
      start: f.start,
      body: lines
        .slice(f.start, f.end === null ? lines.length : f.end - 1)
        .map((text, i) => ({ text, line: f.start + 1 + i })),
      closed: f.end !== null,
    }));
  for (const block of blocks) {
    if (!block.closed) report(file, block.start, 'unclosed ```mermaid fence');
  }

  for (const block of blocks) {
    const first = block.body.find((l) => l.text.trim().length > 0);
    if (!first) {
      report(file, block.start, 'empty mermaid block');
      continue;
    }
    const kind = first.text.trim().split(/[\s{]/)[0];
    if (!ALLOWED_DIAGRAMS.includes(kind)) {
      report(file, first.line, `mermaid diagram type not in the allowed set: ${kind}`);
    }

    if (kind === 'sequenceDiagram') {
      for (const { text, line } of block.body) {
        const alias = text.match(/^\s*participant\s+(\S+)\s+as\s/);
        if (alias && SEQUENCE_KEYWORDS.has(alias[1].toLowerCase())) {
          report(
            file,
            line,
            `participant alias "${alias[1]}" collides with a sequenceDiagram keyword`,
          );
        }
        const isMessage = SEQUENCE_MESSAGE.test(text);
        // Only the NUMERIC entity is safe here. `#59;` renders as ";" and parses;
        // named entities such as `&lt;` do not survive the sequence lexer.
        const body = text.slice(text.indexOf(':') + 1).replace(/#\d+;/g, '');
        if (isMessage && body.includes(';')) {
          report(
            file,
            line,
            'bare ";" in a sequenceDiagram message ends the statement — use "#59;" or reword',
          );
        }
      }
    }

    if (kind === 'classDiagram') {
      for (const { text, line } of block.body) {
        const rel = text.match(/^\s*\S+\s+(?:[<*o|]?[.\-]{2,}[>*o|]?|\.{2}[>|])\s+\S+\s+:\s*(.+)$/);
        if (rel && rel[1].includes(':')) {
          report(file, line, 'second ":" in a classDiagram relationship label is a parse error');
        }
      }
    }
  }
  return blocks;
}

/**
 * Rule 4 — heading anchors. GitHub's slug: lowercase, drop everything outside
 * letters, numbers, combining marks, space, `-` and `_`, then space -> `-`.
 * Nothing is collapsed, so `UC-01 — Topic (one-click)` becomes
 * `uc-01--topic-one-click`. Nobody writes those by hand correctly, which is why
 * the rule has to exist. `slugify` and `headingSlugs` live in `markdown-scan.mjs`,
 * shared with the PostToolUse hook — they used to be two copies that disagreed.
 *
 * The calibration against the real library is reproducible from this checkout
 * rather than asserted from memory. github-slugger is not a root dependency
 * (`packages/docs/pnpm-lock.yaml` pins it for fumadocs-core), so fetch it into a
 * scratch directory and point `--slugtest` at it:
 *
 *   dir=$(mktemp -d) && npm install --prefix "$dir" --silent github-slugger@2.0.0
 *   node scripts/check-docs-links.mjs --slugtest="$dir/node_modules/github-slugger/index.js"
 *
 * Last run: 0 mismatches over 3625 headings in 372 files. The number this comment
 * used to carry was 0 as well, and it was wrong — measured against the library it
 * was 23, every one of them a heading holding a Markdown link or an HTML tag whose
 * text this slugger was not rendering away first.
 */
function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * The line-anchor forms IDEA's `LineNumberPathReferenceProvider` accepts:
 * `#L412`, `#L412-L420`, `#L412-420`, bare `#412`, `#lines-412`.
 *
 * Uppercase `L` is REQUIRED — the provider's regexes carry no IGNORE_CASE flag,
 * so `#l412` resolves the path and silently drops the line, opening the file at
 * line 1. That failure is invisible in review: the link works, it just lands in
 * the wrong place.
 */
const LINE_ANCHOR = /^(?:L\d+(?:-L?\d+)?|\d+|lines?-\d+)$/;
const LOWER_L_ANCHOR = /^l\d+(?:-l?\d+)?$/;

function checkAnchors(slugIndex) {
  /**
   * Heading slugs of ANY Markdown file, not just the ones under `docs/`.
   *
   * The docs-only index is exactly the gap that let three dead anchors ship: all
   * three pointed at a `## 🚀`-style heading in `README.md`/`CONTRIBUTING.md`, and
   * a target absent from the index fell through the `if (!slugs) continue` below
   * as "rule 1 already reported it" when rule 1 had reported nothing, because the
   * file resolves fine. Links out of `docs/` into the rest of the repo are the
   * point of the set, so they get checked like any other.
   */
  const slugsOf = (abs) => {
    if (!slugIndex.has(abs)) {
      let lines;
      try {
        lines = splitLines(fs.readFileSync(abs, 'utf8'));
      } catch {
        return null; // rule 1 already reported the missing file
      }
      slugIndex.set(abs, headingSlugs(lines));
    }
    return slugIndex.get(abs);
  };

  for (const { file, line, raw, target, frag } of anchorRefs) {
    // Repo-root-relative, like every other target — rule 1a has already rejected
    // anything that is not.
    const targetFile = target === '' ? file : path.join(REPO_ROOT, decodeURIComponent(target));

    // Rule 4a — lowercase `l`. Asserted for EVERY target, code included: that is
    // where nearly every line anchor points, and it is the only rule here whose
    // subject is not a heading.
    if (LOWER_L_ANCHOR.test(frag)) {
      report(
        file,
        line,
        `anchor "#${frag}" uses a lowercase "l" — IDEA opens ${repoRel(targetFile)} but drops ` +
          `the line and lands on line 1; write "#${frag.replace(/l/g, 'L')}"`,
      );
      continue;
    }

    if (!/\.mdx?$/i.test(targetFile)) continue; // no headings to resolve against

    const slugs = slugsOf(targetFile);
    if (!slugs) continue; // rule 1 already reported the missing file
    if (slugs.some((h) => h.slug === frag)) continue;

    // Rule 4c — a line anchor on a Markdown target. Checked only AFTER the
    // headings, so a real `## 412` heading is not mistaken for `#412`.
    if (LINE_ANCHOR.test(frag)) {
      report(
        file,
        line,
        `"#${frag}" is a line anchor but ${repoRel(targetFile)} is Markdown — IDEA opens the ` +
          'source at that line rather than the rendered section; link to a heading instead',
      );
      continue;
    }

    // The emoji case. `slugify` does not trim, so a heading with a leading or
    // trailing emoji slugs with a leading or trailing hyphen — `## 📄 License` is
    // `#-license`, not `#license`. Every anchor an author writes by hand for such a
    // heading is wrong, and `sharedPrefix` scores that pair at 0, so the generic
    // near-miss hint below degrades to "no heading produces that slug" on exactly
    // the class of defect that is most common. Name the fix instead.
    const edgeHyphen = slugs.find(
      (h) => h.slug.replace(/^-+|-+$/g, '') === frag && h.slug !== frag,
    );
    if (edgeHyphen) {
      report(
        file,
        line,
        `anchor "${raw}" is missing a hyphen — the heading at ${repoRel(targetFile)}:` +
          `${edgeHyphen.line} starts or ends with a character the slugger drops, leaving its ` +
          `space behind, so it slugs to "#${edgeHyphen.slug}"`,
      );
      continue;
    }

    const lower = frag.toLowerCase();
    const wrongCase = slugs.find((h) => h.slug.toLowerCase() === lower);
    if (wrongCase) {
      report(
        file,
        line,
        `anchor "${raw}" is the wrong case — the heading at ${repoRel(targetFile)}:${wrongCase.line} ` +
          `slugs to "#${wrongCase.slug}"`,
      );
      continue;
    }
    const near = slugs
      .map((h) => ({ h, score: sharedPrefix(h.slug, frag) }))
      .sort((x, y) => y.score - x.score)[0];
    const hint =
      near && near.score >= Math.min(near.h.slug.length, frag.length) / 2
        ? ` — did you mean "#${near.h.slug}" (${repoRel(targetFile)}:${near.h.line})?`
        : ` — no heading in ${repoRel(targetFile)} produces that slug`;
    report(file, line, `dead anchor "${raw}"${hint}`);
  }
}

/**
 * Rules 5 and 6 — code citations and external URLs.
 *
 * Only a citation that names a file is asserted on. Bare `:412` and bare symbols
 * like `assertSafeIp:46` are skipped: recovering the file from surrounding prose
 * is inference, and inference picks the wrong file often enough that the reports
 * would be confident nonsense. Silence beats a wrong answer.
 */
const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'yml',
  'yaml',
  'md',
  'mdx',
  'sql',
  'sh',
  'bash',
  'css',
  'scss',
  'toml',
  'ini',
  'prisma',
  'graphql',
  'py',
  'html',
  'svg',
  'txt',
  'conf',
  'xml',
  'proto',
  'lock',
  'example',
  'dockerfile',
]);
const EXTLESS = new Set(['Dockerfile', 'Makefile', 'Procfile']);

// `lib/ai/providers.ts:412`, `resume.ts:32-36`, `.env.example:460-526`.
const CITATION = /^([A-Za-z0-9._@/-]+):(\d+)(?:-(\d+))?$/;
// The same shape as a bare token, for Mermaid node labels — no backticks there.
const BARE_CITATION =
  /(?:^|[\s"'([|<>{},;=])((?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+:\d+(?:-\d+)?)/g;

const stats = {
  citations: 0,
  ambiguous: 0,
  unresolvable: 0,
  bareSpans: 0,
  bareDocPaths: 0,
  urls: 0,
};

/**
 * The extension a citation names, or null when it names no file at all. This one
 * predicate is the whole noise filter: it rejects `:412`, `assertSafeIp:46`,
 * `3000:3000`, `postgres:16`, `0.0.0.0:3000` and the IPv6 prefixes in the trust
 * boundary diagrams, so none of them ever reaches resolution.
 */
function citedExt(cited) {
  const base = cited.slice(cited.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    // At least one letter: an all-digit "extension" is an IP or a version, not a
    // file (`0.0.0.0:3000`, `2001:0000`).
    const ext = base.slice(dot + 1);
    return /^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(ext) ? ext.toLowerCase() : null;
  }
  return EXTLESS.has(base) ? base.toLowerCase() : null;
}

let tracked = [];
let trackedSet = new Set();
const candidateCache = new Map();

/**
 * Candidate repo paths for a citation, best evidence first:
 *   1. the exact tracked path;
 *   2. tracked paths this is a path *suffix* of (which covers a bare basename);
 *   3. tracked paths whose basename this abbreviates past a hyphen — the docs
 *      write `shared.ts` for `lib/export/inline-assets-shared.ts`. Without this
 *      tier a resolver locks onto the repo's one literal `shared.ts` (10 lines)
 *      and reports rot that is not there.
 */
function candidateTiers(cited) {
  if (!candidateCache.has(cited)) {
    const clean = cited.replace(/^\.\//, '');
    candidateCache.set(
      cited,
      trackedSet.has(clean)
        ? [[clean]]
        : [
            tracked.filter((p) => p.endsWith(`/${clean}`)),
            tracked.filter((p) => p.endsWith(`-${clean}`)),
          ].filter((tier) => tier.length > 0),
    );
  }
  return candidateCache.get(cited);
}

/**
 * The cited line is itself evidence: a file shorter than it cannot be the target.
 * Filtering candidates by length is what lets `Dockerfile:112` pick the 112-line
 * root Dockerfile over render-service's 95-line one, and it is why an ambiguous
 * basename is reported as ambiguous rather than as fake rot.
 *
 * Returns one of: {hit}, {ambiguous:[...]}, {tooShort:[...]}, or {} for no match.
 */
function resolveCitation(cited, needLines) {
  const tiers = candidateTiers(cited);
  let tooShort = null;
  for (const tier of tiers) {
    const fits = tier.filter((p) => lineCount(p) >= needLines);
    if (fits.length === 1) return { hit: fits[0] };
    if (fits.length > 1) return { ambiguous: fits };
    tooShort ??= tier;
  }
  return tooShort ? { tooShort } : {};
}

const lineCounts = new Map();

function lineCount(relPath) {
  if (!lineCounts.has(relPath)) {
    let n = 0;
    try {
      const buf = fs.readFileSync(path.join(REPO_ROOT, relPath));
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
      if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
    } catch {
      n = 0; // tracked in the index but not in the worktree
    }
    lineCounts.set(relPath, n);
  }
  return lineCounts.get(relPath);
}

function checkCitation(file, line, raw, { linkable, isLink }) {
  const match = CITATION.exec(raw);
  if (!match) return;
  const [, rawPath, from, to] = match;
  if (citedExt(rawPath) === null) return; // `:412`, `assertSafeIp:46`, `3000:3000`, `postgres:16`
  if (rawPath.startsWith('path/to/')) return; // the documented placeholder

  stats.citations++;
  const cites = Math.max(Number(from), Number(to ?? 0));

  if (linkable && !isLink) {
    stats.bareSpans++;
    if (RUN_NAVIGABILITY) {
      // The span TEXT may be written relative to the page; the link TARGET never
      // is. Only the target is rewritten, so the visible citation is unchanged.
      const dest = /^\.\.?\//.test(rawPath)
        ? path.relative(REPO_ROOT, path.resolve(path.dirname(file), rawPath))
        : rawPath;
      report(
        file,
        line,
        `code citation \`${raw}\` is a bare code span, not a link — write ` +
          `[\`${raw}\`](${dest}#L${from}) so a reader can jump to it`,
      );
    }
  }

  if (rawPath.includes('...')) {
    stats.unresolvable++;
    report(
      file,
      line,
      `code citation \`${raw}\` elides part of the path with "..." — spell the path out ` +
        'in full so it resolves',
    );
    return;
  }
  // `../appendix/…` in a doc is relative to the citing document, not the repo root.
  const cited = /^\.\.?\//.test(rawPath)
    ? path.relative(REPO_ROOT, path.resolve(path.dirname(file), rawPath))
    : rawPath;

  const { hit, ambiguous, tooShort } = resolveCitation(cited, cites);
  if (ambiguous) {
    stats.ambiguous++; // `route.ts` matches 70 files — refuse rather than guess
    return;
  }
  if (hit) return;
  if (tooShort) {
    const best = tooShort.reduce((a, b) => (lineCount(a) >= lineCount(b) ? a : b));
    report(
      file,
      line,
      `code citation \`${raw}\` cites line ${cites} but ${best} has ${lineCount(best)} lines — ` +
        're-read the file and update the line number',
    );
    return;
  }
  if (!CODE_EXT.has(citedExt(cited)) || /[*?[\]]/.test(cited)) {
    stats.unresolvable++;
    return; // a glob, an npm package name, or a file this repo has never had
  }
  report(
    file,
    line,
    `code citation \`${raw}\` names no tracked repo file — write the path from the ` +
      'repo root, or drop the citation if the file is gone',
  );
}

/**
 * A code span holding nothing but a relative path to a Markdown file, e.g.
 * `` `../02-container-view/index.md` ``. Rendered it is monospace prose, not a
 * link, so there is nothing to click.
 *
 * A `/` is required, which is the whole safety margin: a bare `` `index.md` ``
 * resolves against the citing file's own directory, and the sibling `index.md`
 * usually exists, so recommending a link to it would be a confident guess at
 * which `index.md` the prose meant. Directory-qualified paths are unambiguous.
 * Same discipline as rule 5 — refuse rather than guess.
 */
const DOC_PATH_SPAN = /^\.{0,2}[A-Za-z0-9._@-]*(?:\/[A-Za-z0-9._@-]+)+\.mdx?$/;

/** Rule 5b — advisory, `--navigability` only, like the bare citations above. */
function checkBareDocPath(file, line, raw, isLink) {
  if (isLink || !DOC_PATH_SPAN.test(raw)) return;
  // The span text is prose, so it is read the way it is written: relative to this
  // page. Only the suggested TARGET is spelled from the repo root.
  const abs = fs.existsSync(path.resolve(path.dirname(file), raw))
    ? path.resolve(path.dirname(file), raw)
    : path.join(REPO_ROOT, raw);
  if (!fs.existsSync(abs)) return; // rule 1's business, not this one
  stats.bareDocPaths++;
  if (!RUN_NAVIGABILITY) return;
  report(
    file,
    line,
    `\`${raw}\` is a bare Markdown path in a code span, not a link — write ` +
      `[\`${raw}\`](${path.relative(REPO_ROOT, abs)}) so a reader can jump to it`,
  );
}

// One span can hold several citations: `:128-130, :146-154`.
const splitSpan = (body) =>
  /^[^\s,]+(?:\s*,\s*[^\s,]+)+$/.test(body.trim())
    ? body.split(',').map((s) => s.trim())
    : [body.trim()];

// At least one character after `//`, so the bare `https://` the docs use as prose
// about scheme coercion is not mistaken for a URL.
const URL_TOKEN = /\bhttps?:\/\/[^\s`)'"|<>\]]+/g;

/**
 * Never fetched, and never required to be https: loopback, RFC1918, CGNAT (which
 * covers the 100.100.100.200 metadata address), link-local, reserved TLDs, and
 * any single-label host. A dotless name like `render-service` is a container
 * service name that resolves through the local search domain, so treating it as
 * internal is a safety requirement — a link checker that fetches it is itself an
 * SSRF vector — not just noise reduction.
 */
function isInternalHost(h) {
  return (
    !h.includes('.') ||
    /\.(?:internal|local|localhost|test|example|invalid|corp|arpa)$/i.test(h) ||
    /^(?:0|10|127)\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    /^\[?(?:::1|fc|fd|fe80)/i.test(h)
  );
}

/**
 * Rules 5 and 6 over one file: citations in spans and Mermaid labels, plus URLs.
 *
 * `spans` is the masked prose with inline code spans LEFT IN — a citation lives
 * inside one, so masking them here would switch rule 5 off entirely. Fenced
 * bodies, indented blocks and HTML comments are already blanked; Mermaid labels
 * are handled separately above because a label takes no inline Markdown.
 */
function checkRefs(file, spans, mermaidBlocks, externalQueue) {
  for (const block of mermaidBlocks) {
    for (const { text, line } of block.body) {
      for (const m of text.matchAll(BARE_CITATION)) {
        // A Mermaid node label takes no inline Markdown, so it can never be a
        // link. Check the line number; do not ask it to be navigable.
        checkCitation(file, line, m[1], { linkable: false, isLink: false });
      }
    }
  }

  spans.forEach((text, i) => {
    const line = i + 1;

    for (const span of text.matchAll(CODE_SPAN)) {
      const body = span[1] ?? span[2];
      const isLink =
        text.slice(0, span.index).endsWith('[') &&
        /^\]\(/.test(text.slice(span.index + span[0].length));
      for (const raw of splitSpan(body)) {
        checkCitation(file, line, raw, { linkable: true, isLink });
        checkBareDocPath(file, line, raw, isLink);
      }
    }

    for (const token of text.matchAll(URL_TOKEN)) {
      const url = token[0].replace(/[.,;:!?]+$/, '');
      if (/[{}$<>]/.test(url)) continue; // templated: `registry.ai-sdk.dev/{name}.json`
      stats.urls++;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        report(file, line, `malformed URL "${url}" — it does not parse as a URL`);
        continue;
      }
      if (!parsed.hostname) {
        report(file, line, `URL "${url}" has no host — complete it or remove it`);
        continue;
      }
      if (parsed.protocol === 'http:' && !isInternalHost(parsed.hostname)) {
        report(file, line, `"${url}" uses http — use https://${url.slice(7)}`);
      }
      if (RUN_EXTERNAL && !isInternalHost(parsed.hostname)) {
        const isLink = /\]\(\s*$/.test(text.slice(0, token.index));
        externalQueue.push({ file, line, url, isLink });
      }
    }
  });
}

/**
 * Optional — network reachability. Off by default on purpose: a gate that fails
 * on someone's flaky wifi gets deleted.
 *
 * An endpoint literal answering 401/403/404 proves its host is alive, which is
 * all a rot check can ask of an API root with no GET handler — 19 of this set's
 * 26 fetchable URLs are exactly that. Only a real Markdown link is held to its
 * exact path.
 */
async function probeExternal(queue) {
  const pending = [...queue];
  const worker = async () => {
    for (let job = pending.pop(); job; job = pending.pop()) {
      let res;
      try {
        res = await fetch(job.url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        report(
          job.file,
          job.line,
          `external URL ${job.url} is unreachable (${err.name}: ${err.message}) — ` +
            'confirm the host still exists, or drop the reference',
        );
        continue;
      }
      if (job.isLink && res.status >= 400) {
        report(
          job.file,
          job.line,
          `external link ${job.url} returned HTTP ${res.status} — update or remove the link`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** Optional — the authoritative parse, one `mmdc` invocation per block. */
function parseWithMmdc(jobs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-mermaid-'));
  for (const { file, block } of jobs) {
    const src = path.join(tmp, 'block.mmd');
    fs.writeFileSync(src, block.body.map((l) => l.text).join('\n') + '\n');
    try {
      execFileSync('mmdc', ['-i', src, '-o', path.join(tmp, 'block.svg'), '-q'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      const detail = String(err.stderr ?? err.message)
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
        .find((l) => /Parse error|Error:/.test(l));
      report(file, block.start, `mmdc rejected this block: ${detail ?? 'unknown parse failure'}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/**
 * `--selftest` — the two predicates that fail silently in the dangerous
 * direction if someone edits them. `citedExt` is the entire noise filter for rule
 * 5: loosen it and the gate floods with false positives, tighten it and rule 5
 * quietly stops checking anything. `isInternalHost` is a safety boundary: a
 * checker that fetches a dotless or private host under `--external` is itself an
 * SSRF vector. Slug rules are included because they are impossible to eyeball.
 */
function selftest() {
  const eq = (got, want, label) => {
    if (got !== want) throw new Error(`selftest ${label}: got ${got}, want ${want}`);
  };
  const dupes = headingSlugs(['# Hops', '## Hops', '```', '# in a fence', '```', '### Hops']);
  // Every reference below sits somewhere the mask must cover, except the last two.
  const masked = (() => {
    const lines = [
      '```markdown',
      '[a](./nope-a.md)',
      '```',
      '    [b](./nope-b.md)',
      '',
      '<!-- [c](./nope-c.md) -->',
      '````markdown',
      '```mermaid',
      '[d](./nope-d.md)',
      '```',
      '````',
      'Inline `[e](./nope-e.md)` and ``[f](./nope-f.md)``.',
      '[g](./nope-g.md)',
      '15. item',
      '    [h](./nope-h.md)',
    ];
    const prose = maskNonProse(lines, scanBlocks(lines), { spans: true });
    return (
      prose
        .join('\n')
        .match(/nope-[a-h]/g)
        ?.join(',') ?? ''
    );
  })();
  const cases = [
    // Punctuation is dropped in place, so each surviving space becomes its own hyphen.
    [slugify('UC-01 — Topic (one-click)'), 'uc-01--topic-one-click'],
    [slugify('`session_active_stage` — a mismatch'), 'session_active_stage--a-mismatch'],
    [slugify('A -> B'), 'a---b'],
    [slugify('Transport 4: rev-diffing'), 'transport-4-rev-diffing'],
    [dupes.map((h) => h.slug).join(), 'hops,hops-1,hops-2'],
    // A leading character the slugger strips leaves its space, which becomes a
    // hyphen. Trimming after the drop yields `overview`, which no renderer emits.
    [slugify(headingText('📖 Overview')), '-overview'],
    [slugify(headingText('AI-Assisted PRs 🤖')), 'ai-assisted-prs-'],
    [slugify(headingText('Heading ##')), 'heading'],
    // Only prose survives the mask: a fence, an indented block, an HTML comment, a
    // nested fence and an inline span are all gone; a plain link and a link on a
    // four-space list continuation are not.
    [masked, 'nope-g,nope-h'],
    // Citations that name a file.
    [citedExt('lib/ai/providers.ts'), 'ts'],
    [citedExt('.env.example'), 'example'],
    [citedExt('Dockerfile'), 'dockerfile'],
    // ...and the tokens that only look like one: no file part, a port map, an
    // image tag, an IP, an IPv6 prefix, an elision.
    ...['', 'assertSafeIp', '3000', 'postgres', '0.0.0.0', '2001', '...'].map((s) => [
      citedExt(s),
      null,
    ]),
    // Never fetched, never required to be https. A dotless name resolves through
    // the local search domain, so it counts as internal.
    ...[
      'localhost',
      'render-service',
      'proxy',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '100.100.100.200',
      'gateway.internal',
      'x.local',
      '::1',
    ].map((h) => [isInternalHost(h), true]),
    ...['api.openai.com', 'github.com', '8.8.8.8', '172.15.0.1'].map((h) => [
      isInternalHost(h),
      false,
    ]),
    // Rule 4a/4c — the line-anchor forms IDEA's provider accepts. Uppercase `L`
    // is required; the lowercase form resolves the path and drops the line, so it
    // has to be recognised separately rather than just failing to match.
    ...['L412', 'L412-L420', 'L412-420', '412', 'lines-412', 'line-9'].map((f) => [
      LINE_ANCHOR.test(f),
      true,
    ]),
    ...['l412', 'quick-start', '-license', 'L', 'Lx', ''].map((f) => [LINE_ANCHOR.test(f), false]),
    ...['l412', 'l412-l420', 'l412-420'].map((f) => [LOWER_L_ANCHOR.test(f), true]),
    // ...and the anchors that must NOT be read as a lowercase line anchor: the
    // correct form, a heading slug that merely starts with `l`, and `lines-412`.
    ...['L412', 'lines-412', 'logging-412', 'l', 'l412x'].map((f) => [
      LOWER_L_ANCHOR.test(f),
      false,
    ]),
    [
      'l412-l420'.replace(/l/g, 'L'), // the suggested fix the message prints
      'L412-L420',
    ],
    // Rule 5b — a directory-qualified markdown path in a code span is a link
    // candidate; a bare basename is not, because which `index.md` is a guess.
    ...['../02-container-view/index.md', 'skills/openmaic/SKILL.md', './a/b.mdx'].map((p) => [
      DOC_PATH_SPAN.test(p),
      true,
    ]),
    ...['index.md', 'README.md', '../lib/x.ts', 'providers.ts:412', 'a/b.md:12', 'a/*.md'].map(
      (p) => [DOC_PATH_SPAN.test(p), false],
    ),
    // Rule 1a — the FORM. A target is spelled from the repo root; the two forms
    // this set was written in before are both rejected, including the bare `..`
    // and `.` that no prefix regex catches.
    ...['../x.md', '../../lib/a.ts#L1', './x.md', '/x.md', '/lib/a.ts#L1', '..', '.', './'].map(
      (t) => [RELATIVE_FORM.test(t), true],
    ),
    ...[
      'docs/02-container-view/index.md',
      'README.md',
      'lib/ai/providers.ts',
      'docs/appendix',
      'docs/x.md#-license',
      '.env.example',
      '.github/workflows/ci.yml',
    ].map((t) => [RELATIVE_FORM.test(t), false]),
    // ...and the arithmetic that prints the fix, at each of the four depths this
    // set uses. Nobody counts `../../../../` correctly by eye, which is the whole
    // reason the message carries the answer.
    [rootRelative('docs/README.md', '../lib/x.ts#L12'), 'lib/x.ts#L12'],
    [
      rootRelative('docs/11-data-flows/02-topic-to-classroom.md', '../../lib/x.ts#L12'),
      'lib/x.ts#L12',
    ],
    [
      rootRelative(
        'docs/appendix/research/agent-runtime/00-overview.md',
        '../../../../lib/x.ts#L12',
      ),
      'lib/x.ts#L12',
    ],
    [
      rootRelative('docs/12-api-reference/index.md', './09-conventions.md#size-limits'),
      'docs/12-api-reference/09-conventions.md#size-limits',
    ],
    // A sibling directory, a leading slash, and a trailing slash on a directory.
    [
      rootRelative('docs/11-data-flows/02-x.md', '../02-container-view/index.md'),
      'docs/02-container-view/index.md',
    ],
    [rootRelative('docs/README.md', '/lib/x.ts#L12'), 'lib/x.ts#L12'],
    [rootRelative('docs/README.md', './appendix/'), 'docs/appendix'],
    // The fragment is carried across byte for byte: uppercase `L`, a range, and a
    // slug whose leading hyphen is real.
    [rootRelative('docs/README.md', '../README.md#L1041-L1050'), 'README.md#L1041-L1050'],
    [rootRelative('docs/README.md', '../README.md#-license'), 'README.md#-license'],
  ];
  cases.forEach(([got, want], i) => eq(got, want, `case ${i}`));
  console.log(`selftest ok (${cases.length} cases)`);
}

/**
 * `--slugtest=<path>` — diff `slugify(headingText(...))` against the real
 * github-slugger, heading for heading, over every Markdown file that this set
 * links into. This is the calibration the rule-4 comment cites; it is a runnable
 * mode rather than a remembered number because the previous claim ("0 mismatches")
 * could not be reproduced from this checkout and was, when finally measured, 23.
 *
 * github-slugger is not a root dependency, so the module path is an argument:
 *
 *   dir=$(mktemp -d) && npm install --prefix "$dir" --silent github-slugger@2.0.0
 *   node scripts/check-docs-links.mjs --slugtest="$dir/node_modules/github-slugger/index.js"
 */
async function slugtest(spec) {
  let GithubSlugger;
  try {
    ({ default: GithubSlugger } = await import(spec));
  } catch (err) {
    console.error(
      `--slugtest could not load github-slugger from "${spec}" (${err.message}).\n` +
        'It is not a root dependency. Fetch it into a scratch directory:\n' +
        '  dir=$(mktemp -d) && npm install --prefix "$dir" --silent github-slugger@2.0.0\n' +
        '  node scripts/check-docs-links.mjs --slugtest="$dir/node_modules/github-slugger/index.js"',
    );
    process.exit(1);
  }

  // Every file the set can link a heading into: docs/ plus the root pages and the
  // package docs that `docs/` anchors into. The CRLF files among them are the
  // point: a `\r` left on a heading line empties a whole file's slug table.
  const targets = [
    ...walk(DOCS_DIR),
    ...['README.md', 'CONTRIBUTING.md'].map((f) => path.join(REPO_ROOT, f)),
    ...tracked
      .filter((p) => p.startsWith('packages/') && p.endsWith('.md'))
      .map((p) => path.join(REPO_ROOT, p)),
  ]
    .filter((f) => fs.existsSync(f))
    .sort();

  let headings = 0;
  const mismatches = [];
  for (const file of targets) {
    const lines = splitLines(fs.readFileSync(file, 'utf8'));
    const scan = scanBlocks(lines);
    const ref = new GithubSlugger();
    // Walk the same headings `headingSlugs` walks, so the two stay in step.
    const ours = headingSlugs(lines, scan);
    for (const { slug, line } of ours) {
      headings++;
      const want = ref.slug(headingText(lines[line - 1].replace(/^#{1,6}[ \t]+/, '')));
      if (slug !== want) {
        mismatches.push(`${repoRel(file)}:${line} got "${slug}" want "${want}"`);
      }
    }
  }
  console.log(
    `slugtest: ${headings} headings in ${targets.length} files, ${mismatches.length} mismatches`,
  );
  for (const m of mismatches.slice(0, 20)) console.log(`  ${m}`);
  if (mismatches.length > 20) console.log(`  ... and ${mismatches.length - 20} more`);
  if (mismatches.length) process.exit(1);
}

async function main() {
  if (process.argv.includes('--selftest')) {
    selftest();
    return;
  }
  const slugArg = process.argv.find((a) => a === '--slugtest' || a.startsWith('--slugtest='));
  if (slugArg) {
    tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\0')
      .filter(Boolean);
    await slugtest(
      slugArg.includes('=') ? slugArg.slice(slugArg.indexOf('=') + 1) : 'github-slugger',
    );
    return;
  }
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`${DOCS_DIR} does not exist — this script must sit in <repo>/scripts/.`);
    process.exit(1);
  }

  tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);
  trackedSet = new Set(tracked);

  const files = walk(DOCS_DIR).sort();
  const mermaidJobs = [];
  const slugIndex = new Map();
  const proseByFile = new Map();
  const externalQueue = [];

  for (const file of files) {
    const lines = splitLines(fs.readFileSync(file, 'utf8'));
    // One scan, two views. `prose` blanks inline code spans as well, for the rules
    // that must not read them; `spans` keeps them, for rule 5, which must.
    const scan = scanBlocks(lines);
    const prose = maskNonProse(lines, scan, { spans: true });
    const spans = maskNonProse(lines, scan);
    proseByFile.set(file, prose);
    slugIndex.set(file, headingSlugs(lines, scan));
    checkLinks(file, prose);
    const blocks = checkMermaid(file, lines, scan);
    for (const block of blocks) mermaidJobs.push({ file, block });
    checkRefs(file, spans, blocks, externalQueue);
  }

  checkReachability(files, proseByFile);
  checkAnchors(slugIndex);

  const dirs = new Set(files.map((f) => path.dirname(f)));
  for (const dir of [...dirs].sort()) checkRegistration(dir);

  if (RUN_MERMAID) parseWithMmdc(mermaidJobs);
  if (RUN_EXTERNAL) await probeExternal(externalQueue);

  if (problems.length === 0) {
    if (QUIET) return;
    const skipped = [
      RUN_MERMAID ? null : '--mermaid for a real parse',
      RUN_EXTERNAL ? null : '--external for network reachability',
      RUN_NAVIGABILITY ? null : '--navigability to require citations be links',
    ].filter(Boolean);
    console.log(
      `docs check passed: ${files.length} files, ${mermaidJobs.length} mermaid blocks, ` +
        `${anchorRefs.length} anchors, ${stats.citations} code citations ` +
        `(${stats.ambiguous} ambiguous, ${stats.unresolvable} unresolvable, ` +
        `${stats.bareSpans} not links), ${stats.bareDocPaths} bare doc paths, ` +
        `${stats.urls} urls.`,
    );
    if (skipped.length) console.log(`  not run: ${skipped.join('; ')}`);
    return;
  }

  console.error(`docs check failed with ${problems.length} problem(s):`);
  for (const p of problems) {
    console.error(`  ${p.file}${p.line ? `:${p.line}` : ''} — ${p.message}`);
  }
  process.exit(1);
}

await main();
