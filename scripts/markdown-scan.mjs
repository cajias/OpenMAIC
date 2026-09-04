/**
 * Markdown scanning primitives shared by the two reference gates:
 * `check-docs-links.mjs` (pre-merge, whole set) and
 * `hooks/check-md-refs.mjs` (PostToolUse, one file).
 *
 * They live in one module because they were duplicated, and the copies diverged
 * in ways that only showed up as false reports:
 *
 *   - Each tool had its own `slugify`. One trimmed before dropping characters and
 *     one after, so `## 📖 Overview` slugged two different ways and every real
 *     link to it was reported dead by one tool and accepted by the other.
 *   - Each rule tracked fences with its own scanner. Three trackers over one file
 *     is how a ````markdown wrapper desynced the Mermaid scanner from the link
 *     scanner, and how the link rule ended up with no fence tracking at all.
 *
 * One implementation per concern, one set of edge cases, validated once.
 */

/**
 * A file's lines. Splitting on `\n` alone leaves a `\r` on every line of a CRLF
 * file, and `.` does not match `\r`, so `^#{1,6}\s+(.*)$` matches NO heading
 * there — the file's whole slug table comes back empty and every anchor into it
 * is reported dead. Three tracked files in this repo are CRLF.
 */
export const splitLines = (text) => text.split(/\r?\n/);

/**
 * github-slugger@2.0.0's `slug()`, which is what GitHub and fumadocs-core both
 * use: lowercase, drop everything outside letters, numbers, combining marks,
 * space, `-` and `_`, then every remaining space becomes `-`.
 *
 * It does not trim, and that is the whole subtlety. A stripped leading character
 * leaves its space behind, so `📖 Overview` becomes ` overview` becomes
 * `-overview`. Trimming after the drop yields `overview`, which no renderer ever
 * produces. Validated at 0 mismatches — see `--slugtest`.
 */
export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');

/**
 * A heading's source content -> the text a renderer produces, which is what the
 * slugger actually receives.
 *
 * The `.trim()` is CommonMark's, not the slugger's: an ATX heading's content is
 * stripped of outer whitespace *before* inline parsing. Doing it here and not
 * inside `slugify` is what keeps both `📖 Overview` -> `-overview` (leading space
 * created by the drop, kept) and `Overview  ` -> `overview` (leading space present
 * in the source, stripped) correct at the same time.
 *
 * Underscores are deliberately left alone: CommonMark does not read
 * `session_active_stage` as emphasis, so GitHub keeps the underscores.
 */
export const headingText = (raw) =>
  raw
    .replace(/\s+#+\s*$/, '') // the optional closing #-sequence
    .trim()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]|<[^>]+>/g, '');

/** An ATX heading line -> its raw content, or null. */
const HEADING = /^#{1,6}[ \t]+(.*)$/;

/** A fence marker line -> [, indent, run, info]. */
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

/** A list item marker -> [all, indent]; `all.length` is the content column. */
const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * Inline code spans, ``double`` before `single` so a span containing a backtick is
 * not split in half. Group 1 or 2 is the span's body, whichever matched.
 *
 * The body may cross a line break — CommonMark renders one as a space — but not a
 * blank line, which ends the paragraph and so ends any unclosed span. Both halves
 * of that are load-bearing. Refusing to wrap makes the CLOSING backtick of a
 * wrapped span look like an opening one, and the masker then eats forward from it
 * and swallows the `[` of the link that follows; that measured out at 7 links in
 * this set silently dropping out of rule 1. Allowing it to cross a blank line
 * would let one stray backtick mask the rest of the file.
 */
const spanChar = String.raw`[^\`\n]|\n(?![ \t]*\n)`;
export const CODE_SPAN = new RegExp(
  String.raw`\`\`((?:${spanChar}|\`(?!\`))+?)\`\`|\`((?:${spanChar})+?)\``,
  'g',
);

/**
 * Classify every line's block context in one pass.
 *
 * Returns `{ code, fences }`:
 *   - `code[i]` — true when line `i` is not prose: a fence marker, a fence body,
 *     or an indented code block. Every rule consults this instead of tracking
 *     fences itself.
 *   - `fences` — one `{ char, len, info, start, end }` per fence in document
 *     order, 1-based line numbers, `end === null` when it never closed. The
 *     Mermaid rule picks its own blocks out of this rather than running a second
 *     scanner that can disagree with the first.
 *
 * HTML comments are NOT handled here: a comment can open and close inside a prose
 * line, so masking it is character work. `maskNonProse` does it.
 */
export function scanBlocks(lines) {
  const code = new Array(lines.length).fill(false);
  const fences = [];
  let fence = null;
  let listIndent = -1;
  let prevBlank = true; // start of file behaves like a preceding blank line
  let prevCode = false;

  for (let i = 0; i < lines.length; i++) {
    // A tab is a 4-column stop, so a tab-indented block is an indented block.
    const text = lines[i].replace(/^\t+/, (t) => '    '.repeat(t.length));
    const blank = text.trim() === '';
    const marker = text.match(FENCE);

    if (fence) {
      code[i] = true;
      // A closing fence is the same character, at least as long, and carries no
      // info string. Both halves matter: without the length rule a ```mermaid
      // inside a ````markdown block ends the wrapper, and without the info rule
      // a ```js line does.
      if (marker && marker[2][0] === fence.char && marker[2].length >= fence.len && !marker[3]) {
        fence.end = i + 1;
        fence = null;
      }
      prevBlank = false;
      prevCode = true;
      continue;
    }

    if (marker) {
      fence = {
        char: marker[2][0],
        len: marker[2].length,
        info: marker[3],
        start: i + 1,
        end: null,
      };
      fences.push(fence);
      code[i] = true;
      prevBlank = false;
      prevCode = true;
      continue;
    }

    if (blank) {
      prevBlank = true;
      // A blank line neither opens nor closes an indented block or a list item.
      continue;
    }

    const indent = text.search(/\S/);
    // A list item's continuation is indented to its own content column; code
    // inside it starts four columns further in. Without this, the four-space
    // continuation of a `10. ` item reads as a code block and every reference on
    // it stops being checked.
    const item = text.match(LIST_ITEM);
    if (item) listIndent = item[0].length;
    else if (indent === 0) listIndent = -1;

    // An indented code block cannot interrupt a paragraph, so it has to start
    // after a blank line (or continue one already open).
    code[i] = indent >= (listIndent >= 0 ? listIndent : 0) + 4 && (prevBlank || prevCode);
    prevBlank = false;
    prevCode = code[i];
  }

  return { code, fences };
}

const blankOut = (s) => s.replace(/[^\n]/g, ' ');

/**
 * A file's prose, with every non-prose region replaced by spaces so that offsets
 * and line numbers survive unchanged. Fences and indented blocks come from
 * `scanBlocks`; HTML comments are masked here because they are not line-aligned.
 *
 * `spans: true` also masks inline code spans. Rule 1 needs that — documented link
 * syntax inside backticks is not a link — and rule 5 must not have it, because a
 * code citation lives inside a code span.
 */
export function maskNonProse(lines, blocks, { spans = false } = {}) {
  let text = lines.map((l, i) => (blocks.code[i] ? blankOut(l) : l)).join('\n');
  // An unterminated `<!--` masks to end of file, which is what a renderer does.
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, blankOut);
  if (spans) text = text.replace(CODE_SPAN, blankOut);
  return text.split('\n');
}

/**
 * Heading slugs of one file in document order, with GitHub's `-1`/`-2` dedupe for
 * repeats. Frontmatter is skipped; so is anything `scanBlocks` calls code.
 */
export function headingSlugs(lines, blocks = scanBlocks(lines)) {
  const slugs = [];
  const seen = new Map();
  let frontmatter = lines[0] === '---';
  for (let i = 0; i < lines.length; i++) {
    if (frontmatter) {
      if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(lines[i])) frontmatter = false;
      continue;
    }
    if (blocks.code[i]) continue;
    const heading = lines[i].match(HEADING);
    if (!heading) continue;
    const base = slugify(headingText(heading[1]));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.push({ slug: n ? `${base}-${n}` : base, line: i + 1 });
  }
  return slugs;
}

/**
 * A link target that is NOT spelled from the repo root: a leading `/`, a `./` or
 * `../` prefix, or a bare `.`/`..`.
 *
 * Every target under `docs/` is repo-root-relative with no leading slash, because
 * that is the only form measured navigating in JetBrains IDEA — see
 * `docs/LINK-PROBE.md`. Both gates assert it, and they share this one regex rather
 * than each carrying a copy: the last pair of duplicated predicates in this module's
 * history disagreed for months and reported each other's valid links dead.
 */
export const RELATIVE_FORM = /^(?:\/|\.{1,2}(?:\/|$))/;

/**
 * A target as written in `fromFile` (itself repo-root-relative), re-expressed from
 * the repo root — the fix both gates print, and pure path arithmetic so it is
 * testable without a filesystem.
 *
 * The `#fragment` is carried across untouched. `#L412`'s uppercase `L` is
 * load-bearing — a lowercase `#l412` resolves the path and silently drops the line
 * — and a heading slug may hold anything, including a leading hyphen, so nothing
 * here may normalise it.
 */
export function rootRelative(fromFile, raw) {
  const hash = raw.indexOf('#');
  const target = hash === -1 ? raw : raw.slice(0, hash);
  const frag = hash === -1 ? '' : raw.slice(hash);
  const fixed = target.startsWith('/')
    ? target.slice(1) // a leading slash means the repo root in this set
    : posixNormalize(`${fromFile.slice(0, fromFile.lastIndexOf('/') + 1)}${target}`);
  return fixed.replace(/\/+$/, '') + frag;
}

/** `a/b/../c` -> `a/c`, on `/`-separated paths only. */
function posixNormalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out.at(-1) !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Why a cited line range cannot address a file, or null when it can.
 *
 * Both gates index `body[start - 1]`, and line 0 and a backwards range are the
 * two inputs that reach that index out of bounds. The resulting `TypeError` was
 * caught and discarded by the hook, which then reported nothing at all for the
 * file — one malformed citation gave a 400-line document a clean bill of health.
 * Validate before indexing, and the crash becomes the finding it should be.
 */
export function lineRangeError(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) {
    return 'line numbers are 1-based integers, so this cannot address a line';
  }
  return end < start ? `line range runs backwards (${start} > ${end})` : null;
}
