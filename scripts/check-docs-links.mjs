/**
 * Structural gate for the architecture documentation set under `docs/`.
 *
 * Three assertions, in order of how often they have actually broken:
 *
 *   1. Every relative Markdown link resolves to a file on disk.
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
 *
 * Pass `--mermaid` to additionally send every block through the real Mermaid
 * parser via `mmdc` (`@mermaid-js/mermaid-cli`), which must be on PATH. That is
 * the authoritative check; rule 3 is the cheap subset CI can run without
 * installing a headless browser.
 *
 * `--mermaid` launches one `mmdc` (and therefore one headless browser) per block,
 * serially: budget roughly a second per block — about fifteen minutes over the
 * whole set. It is a pre-merge or nightly check, not an inner-loop one. The
 * default mode is milliseconds.
 *
 * Usage: node scripts/check-docs-links.mjs [--mermaid]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DOCS_DIR = path.join(process.cwd(), 'docs');
const RUN_MERMAID = process.argv.includes('--mermaid');

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
  problems.push({ file: path.relative(process.cwd(), file), line, message });
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/** Rule 1 — relative links resolve. */
function checkLinks(file, lines) {
  lines.forEach((text, i) => {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      const target = raw.split('#')[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!fs.existsSync(resolved)) report(file, i + 1, `dead link: ${raw}`);
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
 */
function checkReachability(files) {
  const linked = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      const target = raw.split('#')[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (resolved !== file) linked.add(resolved);
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

/** Rule 3 — Mermaid fence hygiene plus the three known syntax traps. */
function checkMermaid(file, lines) {
  const blocks = [];
  let open = null;
  lines.forEach((text, i) => {
    if (open === null) {
      if (/^\s*```mermaid\s*$/.test(text)) open = { start: i + 1, body: [] };
      return;
    }
    if (/^\s*```/.test(text)) {
      blocks.push(open);
      open = null;
      return;
    }
    open.body.push({ text, line: i + 1 });
  });
  if (open !== null) report(file, open.start, 'unclosed ```mermaid fence');

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

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.log('docs/ is absent — nothing to check.');
    return;
  }

  const files = walk(DOCS_DIR).sort();
  const mermaidJobs = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    checkLinks(file, lines);
    for (const block of checkMermaid(file, lines)) mermaidJobs.push({ file, block });
  }

  checkReachability(files);

  const dirs = new Set(files.map((f) => path.dirname(f)));
  for (const dir of [...dirs].sort()) checkRegistration(dir);

  if (RUN_MERMAID) parseWithMmdc(mermaidJobs);

  if (problems.length === 0) {
    const how = RUN_MERMAID
      ? 'parsed with mmdc'
      : 'structural rules only; pass --mermaid for a full parse';
    console.log(
      `docs check passed: ${files.length} files, ${mermaidJobs.length} mermaid blocks (${how}).`,
    );
    return;
  }

  console.error(`docs check failed with ${problems.length} problem(s):`);
  for (const p of problems) {
    console.error(`  ${p.file}${p.line ? `:${p.line}` : ''} — ${p.message}`);
  }
  process.exit(1);
}

main();
