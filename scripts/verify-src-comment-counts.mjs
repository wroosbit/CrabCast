#!/usr/bin/env node
// KAN-578: a source COMMENT's count about a declared set is reconciled against
// the set — for the one construction where the comment says which set it means.
//
// WHAT FAILURE THIS WOULD CATCH: the comment above `parseTables` in
// `scripts/verify-read-contract.mjs`, which said the config-echo shorthand
// expands into FIVE fields of `BLOCK_SHAPES.ConfigEcho` while that constant has
// six members. It was live on `origin/main` at `234243d`; run against that tree
// this script goes RED naming the file, the count and the constant, and §7 says
// how to reproduce it. KAN-528 moved the arity from 5 to 6 and nothing read the
// sentence: KAN-530's gate takes its corpus from `docs/`, and
// `verify-read-contract.mjs` is the gate this comment was sitting INSIDE, green
// throughout, because it reconciles WHICH fields a table lists and a count has
// no member to match.
//
// ⚠ THAT PARAGRAPH IS WRITTEN THE WAY IT IS BECAUSE OF A LIMIT OF THIS CHECK,
// AND THE LIMIT IS WORTH MORE THAN THE PARAGRAPH. This rule cannot tell a CLAIM
// from a QUOTATION OF A CLAIM. The first draft of this header reproduced the
// defective sentence verbatim, in the construction §1 rules on, and this script
// went red on its OWN header — correctly, by its own rule, about a count nobody
// was asserting. So when you cite a stale count as a specimen, DESCRIBE the
// construction instead of reproducing it, exactly as above. A gate over source
// comments has no way to mark quoted text, and the corpus that documents this
// defect is the corpus most full of quotations of it.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS RULES ON IS A NARROW SLICE, AND THE SCRIPT PRINTS ITS OWN
// DENOMINATOR EVERY RUN SO THE GREEN CANNOT BE READ AS MORE THAN IT IS
// ---------------------------------------------------------------------------
//
// This epic's recurring defect is an artifact whose SENTENCE claims more than
// its MECHANISM covers, and a count gate over source comments is an unusually
// easy place to commit it: the corpus is large, the reachable part is tiny, and
// a green check named after the whole corpus reads as coverage of it. So §6
// reports `ruled on N of M`, where M is every count phrase in every comment
// this instrument can see — currently a ratio of a few percent — and that line
// is not decoration. It is the honest reading of this check.
//
// KAN-578 measured the alternatives before settling here. The figures below are
// taken at `234243d` — BEFORE this ticket's own two scripts existed — because a
// script about `BLOCK_SHAPES.ConfigEcho` mentions that constant on every other
// line and would flatter the handle it is arguing against. That tree is 152
// files, 6197 comment blocks and 312 count phrases:
//
//   - THE DEFINITE ARTICLE DOES NOT DISCRIMINATE HERE. In `docs/` it cut 22
//     candidates to 6 with no false positive (KAN-530). In this corpus 150 of
//     the 312 count phrases — 48% — are `the one X` meaning `the ONLY X`:
//     article present, not a count at all. Subset claims carry it too.
//   - THE THREE HANDLES THE TICKET PROPOSED ALL FAIL, and they fail by REDDENING
//     CORRECT PROSE. Across all three, 17 disagreements, of which 2 are the
//     defect: `{@link SET}` in the block, 3 disagreements and none real; the
//     constant's identifier anywhere in the block, 9 and 2 real; the block being
//     the declaration's own leading comment, 5 and none real. 12% precision.
//     ⚠ AND ONE OF THE FALSE REDS IS PERMANENT: `src/router.ts`'s `the other
//     five fields of that shape` is a SUBSET of `ROW_SHAPES.UnreadableRecord`
//     (11 fields, 5 of them durable), so it disagrees with the arity while
//     stale AND after it is corrected to six. A gate nobody can make green by
//     writing correct prose is not a gate.
//   - A BLOCK THAT MENTIONS A CONSTANT IS NOT A BLOCK ABOUT IT. That is the
//     whole of why `docs/` was easier: an anchor link is an author's deliberate
//     act of attribution, and a comment has no anchors.
//   - ADJACENCY DOES DISCRIMINATE, and it is the only thing measured that did.
//     At `234243d` it rules on exactly one comment and that comment is the
//     defect; at `21a29fa` it rules and agrees. No false positive on either.
//
// `scripts/kan578-src-count-sweep.mjs` is the wider-recall survey those numbers
// come from, and re-takes them. It reports the population this gate declines;
// neither script owns the gap between them, and this paragraph is where the
// edge of mine is marked.
//
// ---------------------------------------------------------------------------
// THE RULE — two constructions, and why each is a SIZE claim
// ---------------------------------------------------------------------------
//
//   FORM A   `the six fields of `BLOCK_SHAPES.ConfigEcho``
//   FORM B   ``BLOCK_SHAPES.ConfigEcho`, which has six members`
//
// Both spell the subject beside the number, so attribution is the author's act
// and not this script's guess.
//
// THE DEFINITE ARTICLE IS REQUIRED IN FORM A, and it does work here that it
// could not do alone. `the six fields of X` is the whole set; `six fields of X`
// is SOME six of them — "nine fields are conditionally spread" is the live
// example in `src/read-contract.ts`, correct prose that an article-blind rule
// would redden. The article is not the discriminator here, adjacency is; the
// article is what keeps adjacency from dragging partitives in with it.
//
// A COUNT OF ONE IS NEVER RULED ON. `the one field a consumer is meant to
// branch on` is "the ONLY field", and this corpus is nearly half that idiom —
// 150 of 312 count phrases at `234243d`. It reaches the adjacency form too:
// `One row of `list_agents``, `one field of `send_to_agent_response``. Excluding
// `one` costs nothing, because a set of size one is not a set whose arity
// drifts.
//
// A SUBSET QUALIFIER DISQUALIFIES. `the other five fields of that shape` was
// one of the four instances this ticket was filed for, and its correct value is
// the arity MINUS the five named above it. Reconciling it against the arity
// would be a false red on correct prose, which is the failure this whole class
// keeps producing.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT SEE — named because a gate looks complete
// ---------------------------------------------------------------------------
//
//   - A comment naming its subject anaphorically. `the other five fields of
//     that shape` (src/router.ts) and `the config echo is five fields`
//     (src/agent-registry.ts) are two of this ticket's own four specimens, and
//     no mechanism in this file reaches either. THEY ARE THE MAJORITY, and
//     that is the honest shape of this check.
//   - A count whose subject is a TYPE rather than a declared constant.
//     `{@link SendVerdict} has three members` in `src/delivery.ts` is correct
//     today and held by nothing here: arities come from `dist/`, and a type has
//     no runtime object to count. §6 prints these as DECLINED rather than
//     dropping them, because a subject this script cannot resolve is this
//     script failing to measure and must not read as agreement.
//   - A QUOTATION of a count, as the ⚠ above the rule explains at length.
//   - Any count in a form §1's noun list or number list does not carry.
//   - A set declared only in `dist/daemon.js`, `dist/mcp.js` or `dist/cli.js`.
//     §2 excludes those three BY NAME because importing them starts a daemon,
//     and states the cost rather than hiding it.
//
// Needs a build (arities come from `dist/`) and `typescript` (a devDependency)
// for its PARSER — §3 says why neither a regex nor `ts.createScanner` can do
// that job, and why the second of those is the more dangerous answer. No
// daemon, no network. Exits non-zero on any failure so a reviewer can re-run it
// against the PR head.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const distDir = path.join(repoRoot, 'dist');
const require = createRequire(import.meta.url);

const argv = new Set(process.argv.slice(2));
const showAll = argv.has('--all');

/**
 * Sweep a tree other than this one. §7 uses it to run the whole rule over
 * `234243d`, the commit the historical instance was live on, which is this
 * script's red drive on real text rather than on a fixture.
 */
const treeArg = [...argv].find((a) => a.startsWith('--tree='));
const treeRoot = treeArg ? path.resolve(treeArg.slice('--tree='.length)) : repoRoot;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ------------------------------------------------------------------ §1 the rule

const NUMBERS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20]
]);

/** KAN-530's noun list, unchanged, so the two corpora stay comparable. */
const NOUNS = [
  'fields', 'field', 'members', 'member', 'keys', 'key', 'rows', 'row',
  'values', 'value', 'branches', 'branch', 'shapes', 'shape',
  'categories', 'category', 'entries', 'entry', 'columns', 'column'
];

const NUM = [...NUMBERS.keys()].join('|');

/** Every count phrase this instrument can see at all — §6's denominator. */
const ANY_COUNT = new RegExp(String.raw`\b(${NUM}|\d{1,3})[\s\-](${NOUNS.join('|')})\b`, 'gi');

/** A backticked or `{@link}`ed reference to something SCREAMING_CASE-rooted. */
const REF = String.raw`(?:\{@link\s+|\x60)([A-Z][A-Z0-9_]*(?:\.[A-Za-z0-9_]+)*)\x60?`;

/** `the six fields of \`BLOCK_SHAPES.ConfigEcho\`` — see the header. */
const FORM_A = new RegExp(
  String.raw`\bthe\s+(${NUM}|\d{1,3})[\s\-](${NOUNS.join('|')})\s+of\s+${REF}`,
  'gi'
);

/** `\`BLOCK_SHAPES.ConfigEcho\`, which has six members` — see the header. */
const FORM_B = new RegExp(
  String.raw`${REF}[^.\n]{0,24}?\b(?:has|holds|carries|lists|declares)\s+(?:exactly\s+)?(${NUM}|\d{1,3})[\s\-](${NOUNS.join('|')})\b`,
  'gi'
);

/**
 * `the other five fields of X`, `the first five rows of X` — a subset. The
 * arity is the wrong number to reconcile these against, and one of this
 * ticket's four specimens is exactly this shape.
 */
const SUBSET_QUALIFIER = /\b(other|others|remaining|rest|first|last|next|only|top|bottom|another|further|extra|additional|same)\s+$/i;

// ---------------------------------------------------------------- §2 the arities

/**
 * ⚠ `dist/daemon.js`, `dist/mcp.js` and `dist/cli.js` EXECUTE AT IMPORT. Any of
 * them imported from here contacts the running daemon's socket and prints its
 * registry; measured while building this script, on a machine with a live
 * daemon. Nothing else under `dist/` imports any of the three, so excluding
 * them by name excludes them transitively too — established by grepping every
 * `dist/*.js` for an import of them with `router.js` added to the same pattern
 * as a positive control, which returned three importers and so showed the grep
 * could find one that exists.
 *
 * THE COST IS REAL AND IS STATED RATHER THAN HIDDEN: a set declared only in one
 * of the three has no arity here, so a comment naming it is DECLINED and
 * printed by §6, never silently counted as agreeing.
 */
const SIDE_EFFECTING = new Set(['daemon.js', 'mcp.js', 'cli.js']);

async function declaredSets() {
  const found = new Map();
  const files = fs.readdirSync(distDir)
    .filter((f) => f.endsWith('.js') && !SIDE_EFFECTING.has(f))
    .sort();
  for (const file of files) {
    let mod;
    try { mod = await import(path.join(distDir, file)); } catch { continue; }
    for (const [name, value] of Object.entries(mod)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
      if (!value || typeof value !== 'object') continue;
      const arity = value instanceof Set || value instanceof Map
        ? value.size
        : Object.keys(value).length;
      if (!found.has(name)) found.set(name, arity);
      if (Array.isArray(value) || value instanceof Set || value instanceof Map) continue;
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue && typeof innerValue === 'object' && !Array.isArray(innerValue)) {
          const dotted = `${name}.${inner}`;
          if (!found.has(dotted)) found.set(dotted, Object.keys(innerValue).length);
        }
      }
    }
  }
  return found;
}

// ------------------------------------------------------------ §3 reading a comment

/**
 * Every comment in a source file, taken from TypeScript's PARSER.
 *
 * ⚠ IT IS THE PARSER AND NOT THE LEXER, AND THE DIFFERENCE IS THE WHOLE POINT.
 * Two instruments were tried before this one. Both were wrong, both silently,
 * and the second was wrong in a way that LOOKED like the fix for the first:
 *
 *   1. A HAND-ROLLED SCANNER lost whole files. `scripts/verify-read-contract.mjs`
 *      contains the regex literal `/[\`*_]/g`, whose character class holds a
 *      BACKTICK; a scanner tracking template literals but not regex literals
 *      reads it as the start of a template and swallows the rest of the file.
 *      It also INVENTED comments, because the verify scripts embed other files'
 *      source as fixtures inside template literals — lines beginning `//` and
 *      ` * ` that are string content, not comments.
 *
 *   2. `ts.createScanner` HAS THE SAME BLINDNESS. A bare token scanner cannot
 *      know whether `/` opens a regex or divides: the PARSER decides that and
 *      calls `reScanSlashToken`. Given the fixture above the scanner returns
 *      ZERO comments. It appeared to work on the real file only because that
 *      file contains enough later backticks to resync by luck — measured, it
 *      reported 747 comments in `src/router.ts` where the parser reports 1967,
 *      and 267 in `verify-read-contract.mjs` against 559. It was reading
 *      roughly half the corpus and reporting a healthy total.
 *
 * ⚠ SO A GREEN FROM THIS CHECK IS A CLAIM ABOUT AN INSTRUMENT AS MUCH AS ABOUT
 * THE CORPUS, and §1's fixtures all carry that backtick-bearing regex ahead of
 * the comment under test precisely so that a regression to either instrument
 * fails the self-test rather than quietly shrinking the corpus.
 *
 * Vertically adjacent line comments are merged, because a paragraph of `//`
 * lines is one comment to its author.
 */
function commentBlocks(source, fileName = 'input.ts') {
  const ts = require('typescript');
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind
  );

  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  // Every comment is trivia of some token, so walking every node AND its token
  // children reaches all of them. Ranges are deduplicated by start offset
  // because one comment is both the trailing trivia of what precedes it and
  // the leading trivia of what follows.
  const seen = new Set();
  const raw = [];
  const take = (range) => {
    if (seen.has(range.pos)) return;
    seen.add(range.pos);
    const text = source.slice(range.pos, range.end);
    raw.push({
      pos: range.pos,
      start: lineOf(range.pos),
      end: lineOf(range.pos) + (text.match(/\n/g) || []).length,
      text,
      single: range.kind === ts.SyntaxKind.SingleLineCommentTrivia
    });
  };
  const visit = (node) => {
    (ts.getLeadingCommentRanges(source, node.pos) ?? []).forEach(take);
    (ts.getTrailingCommentRanges(source, node.end) ?? []).forEach(take);
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  raw.sort((a, b) => a.pos - b.pos);

  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && r.single && prev.single && r.start === prev.end + 1) {
      prev.end = r.end;
      prev.text += `\n${r.text}`;
    } else merged.push({ ...r });
  }
  return merged;
}

/**
 * A comment with its line breaks and leading `*` furniture flattened away, so a
 * construction that wraps across two lines still reads as one phrase. The
 * historical instance wraps — `the five fields` ends one line and `of
 * \`BLOCK_SHAPES.ConfigEcho\`` begins the next — so a rule that did not flatten
 * would miss the very comment this script exists for.
 */
function flatten(text) {
  const re = /\n\s*\*?\s?/g;
  let flat = '';
  const map = [];            // map[i] = offset in `text` of flat[i]
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (let i = last; i < m.index; i += 1) { flat += text[i]; map.push(i); }
    flat += ' ';
    map.push(m.index);
    last = m.index + m[0].length;
  }
  for (let i = last; i < text.length; i += 1) { flat += text[i]; map.push(i); }
  return { flat, map };
}

/** Which line of the comment block a flattened-text offset came from. */
function lineOffsetOf(text, map, flatIndex) {
  const at = map[Math.min(flatIndex, map.length - 1)] ?? 0;
  return (text.slice(0, at).match(/\n/g) || []).length;
}

// ------------------------------------------------------------------ §4 the ruling

/**
 * Every ruling a comment supports, as `{form, stated, ref, arity}`. A reference
 * that resolves to no declared set is returned with `arity: null` and is
 * DECLINED rather than dropped — §6 prints it, because a subject this script
 * cannot resolve is this script failing to measure and must not read as
 * agreement.
 */
function rulingsIn(commentText, sets) {
  const { flat, map } = flatten(commentText);
  const out = [];
  for (const [form, re, numIndex, refIndex] of [['A', FORM_A, 1, 3], ['B', FORM_B, 2, 1]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(flat)) !== null) {
      const stated = NUMBERS.get(m[numIndex].toLowerCase()) ?? Number(m[numIndex]);
      if (stated === 1) continue;                       // the ONLY-X idiom; header says why
      // A subset qualifier sits BETWEEN the article and the number — `the
      // other five fields of X` — so FORM A already refuses it by requiring
      // the number to follow `the` directly. This second filter is for the
      // qualifier that precedes the whole phrase, and for FORM B, which has
      // no article to lean on.
      if (SUBSET_QUALIFIER.test(flat.slice(Math.max(0, m.index - 40), m.index))) continue;
      const ref = m[refIndex];
      out.push({
        form,
        stated,
        ref,
        arity: sets.has(ref) ? sets.get(ref) : null,
        quote: m[0].replace(/\s+/g, ' ').trim(),
        lineOffset: lineOffsetOf(commentText, map, m.index)
      });
    }
  }
  return out;
}

function walk(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

/** Run the whole rule over one tree. Returns the ruled, the declined and the denominator. */
function sweep(root, sets) {
  const files = [...walk(path.join(root, 'src'), '.ts'), ...walk(path.join(root, 'scripts'), '.mjs')];
  const ruled = [];
  const declined = [];
  let candidates = 0;
  let blocks = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const block of commentBlocks(source, rel)) {
      blocks += 1;
      const { flat } = flatten(block.text);
      ANY_COUNT.lastIndex = 0;
      while (ANY_COUNT.exec(flat) !== null) candidates += 1;
      for (const r of rulingsIn(block.text, sets)) {
        const rec = { ...r, rel, line: block.start + r.lineOffset };
        if (r.arity === null) declined.push(rec);
        else ruled.push(rec);
      }
    }
  }
  return { files: files.length, blocks, candidates, ruled, declined };
}

// --------------------------------------------------------------- §5 the self-test

/**
 * ⚠ THE MUST-REJECT FIXTURE IS THE ONE THAT EARNS THIS SCRIPT'S KEEP, and it
 * runs BEFORE anything real is swept. A detector that ruled on everything would
 * pass the accept case and fail the reject case; one that ruled on nothing
 * would pass the reject case and fail the accept case. Neither test alone says
 * anything at all.
 *
 * The reject fixtures are not invented. `the other five fields of` is
 * `src/router.ts`'s own wording about `ROW_SHAPES.UnreadableRecord`, which is
 * this ticket's fourth specimen and a SUBSET claim whose correct value is not
 * the arity; and `the one field of` is the ONLY-X idiom that is 45% of every
 * count phrase in this corpus.
 *
 * Each fixture is prefixed with the regex literal carrying a backtick that
 * broke the hand-rolled scanner (§3), so the self-test also fails if this file
 * is ever moved back onto a lexer that cannot read past it.
 */
function selfTest(sets) {
  console.log('\n=== 1. The rule accepts what it must and refuses what it must ===\n');

  const anySet = [...sets.entries()].find(([k]) => k.includes('.')) ?? [...sets.entries()][0];
  const [fixtureSet, fixtureArity] = anySet;
  const wrong = fixtureArity + 3;
  const wordFor = (n) => [...NUMBERS.entries()].find(([, v]) => v === n)?.[0] ?? String(n);
  const preamble = "const plain = (cell) => cell.replace(/[`*_]/g, '').trim();\n";

  const mustAccept = [
    {
      why: 'FORM A — a size claim naming its subject beside it',
      source: `${preamble}/**\n * Expanded into the ${wordFor(wrong)} fields of \`${fixtureSet}\`, which is wrong.\n */\n`,
      expect: { form: 'A', stated: wrong, ref: fixtureSet }
    },
    {
      why: 'FORM B — the subject first, then the count',
      source: `${preamble}/**\n * \`${fixtureSet}\`, which has ${wordFor(wrong)} members, is wrong.\n */\n`,
      expect: { form: 'B', stated: wrong, ref: fixtureSet }
    },
    {
      why: 'FORM A wrapped across two lines, as the historical instance is',
      source: `${preamble}/**\n * Expanded into the ${wordFor(wrong)} fields\n * of \`${fixtureSet}\`, which is wrong.\n */\n`,
      expect: { form: 'A', stated: wrong, ref: fixtureSet }
    }
  ];

  const mustReject = [
    {
      why: 'a SUBSET claim — src/router.ts\'s own wording, whose correct value is not the arity',
      source: `${preamble}// The other ${wordFor(wrong)} fields of \`${fixtureSet}\` are derived.\n`
    },
    {
      why: 'the ONLY-X idiom — "the one field" is not a count of one',
      source: `${preamble}// It is the one field of \`${fixtureSet}\` a consumer branches on.\n`
    },
    {
      why: 'a PARTITIVE — no definite article, so some N of them rather than all',
      source: `${preamble}// ${wordFor(wrong)} fields of \`${fixtureSet}\` are conditionally spread.\n`
    },
    {
      why: 'a count with no subject beside it — the majority of this corpus',
      source: `${preamble}// The config echo is ${wordFor(wrong)} fields and \`prompt\` is not among them.\n`
    }
  ];

  for (const fx of mustAccept) {
    const got = commentBlocks(fx.source, 'fixture.mjs').flatMap((b) => rulingsIn(b.text, sets));
    const ok = got.length === 1
      && got[0].form === fx.expect.form
      && got[0].stated === fx.expect.stated
      && got[0].ref === fx.expect.ref;
    check(ok, `MUST ACCEPT: ${fx.why}`,
      ok ? `ruled ${got[0].ref} says ${got[0].stated}` : `ruled ${JSON.stringify(got)}`);
  }

  for (const fx of mustReject) {
    const got = commentBlocks(fx.source, 'fixture.mjs').flatMap((b) => rulingsIn(b.text, sets));
    check(got.length === 0, `MUST REJECT: ${fx.why}`,
      got.length === 0 ? 'declined, as it must be' : `WRONGLY RULED ${JSON.stringify(got)}`);
  }

  // A detector that rules on nothing passes every must-reject above. This is
  // the positive control on the self-test itself: the accept fixtures had to
  // have produced a ruling, and the line above says they did.
  const acceptCount = mustAccept.filter((fx) =>
    commentBlocks(fx.source, 'fixture.mjs').flatMap((b) => rulingsIn(b.text, sets)).length === 1).length;
  check(acceptCount === mustAccept.length,
    'the must-accept fixtures really did produce rulings',
    `${acceptCount}/${mustAccept.length} — without this, "refuses everything" would pass §1`);
}

// ------------------------------------------------------------------- §6 the sweep

const sets = await declaredSets();
check(sets.size > 0, 'dist/ yields declared sets to reconcile against',
  sets.size > 0 ? `${sets.size} sets` : 'run `npm run build` first');
if (sets.size === 0) {
  console.error('\nverify-src-comment-counts: no arities available; nothing could be ruled on.');
  process.exit(1);
}

selfTest(sets);

console.log('\n=== 2. Every ruled count agrees with its declaration ===\n');

const result = sweep(treeRoot, sets);

console.log(
  `corpus     : ${result.files} files, ${result.blocks} comment blocks` +
  `${treeRoot === repoRoot ? '' : ` (tree: ${treeRoot})`}`
);
console.log(`candidates : ${result.candidates} count phrases this instrument can see`);
console.log(`RULED ON   : ${result.ruled.length} of ${result.candidates}` +
  ` (${((result.ruled.length / Math.max(1, result.candidates)) * 100).toFixed(1)}%)` +
  ` — the rest name no subject beside them, and are NOT held by this check`);
console.log(`declined   : ${result.declined.length} adjacency matches whose subject is not a declared set\n`);

for (const r of result.ruled) {
  check(
    r.arity === r.stated,
    `${r.rel}:${r.line} — ${r.ref}`,
    r.arity === r.stated
      ? `says ${r.stated}, declaration has ${r.arity}`
      : `says ${r.stated}, ${r.ref} has ${r.arity} — "${r.quote}"`
  );
}

if (result.declined.length > 0) {
  console.log('\n  declined (subject named, but not a declared set with a countable arity):');
  for (const d of result.declined) {
    console.log(`    ${d.rel}:${d.line}  ${d.ref} — "${d.quote}"`);
  }
}

// ⚠ FAILS CLOSED. Zero rulings is a FAILURE, never a clean sweep: the bug class
// being hunted is a check that quietly matches nothing, and a rule that has
// stopped matching reports exactly what a corpus with no drift reports.
console.log('');
check(
  result.ruled.length > 0,
  'the rule matched something in the real tree',
  result.ruled.length > 0
    ? `${result.ruled.length} ruling(s)`
    : 'zero rulings — this check has stopped measuring and must not report green'
);

if (showAll) {
  console.log('\n  every count phrase seen, ruled or not:');
  const files = [...walk(path.join(treeRoot, 'src'), '.ts'), ...walk(path.join(treeRoot, 'scripts'), '.mjs')];
  for (const file of files) {
    const rel = path.relative(treeRoot, file);
    for (const block of commentBlocks(fs.readFileSync(file, 'utf8'), rel)) {
      const { flat, map } = flatten(block.text);
      ANY_COUNT.lastIndex = 0;
      let m;
      while ((m = ANY_COUNT.exec(flat)) !== null) {
        console.log(`    ${rel}:${block.start + lineOffsetOf(block.text, map, m.index)}  "${m[0]}"`);
      }
    }
  }
}

// ------------------------------------------------------------ §7 the red on record

// The red drive for this script is a RUN OVER REAL HISTORY rather than a
// fixture: `--tree=<a checkout of 234243d>` puts the rule over the text the
// four filed instances were live in, and the one this rule reaches goes red
// naming the file, the count and the constant. The PR body carries the pasted
// output and the two commands that produce it. Nothing here runs git.

console.log('');
console.log(`=== verdict: ${failures === 0 ? 'green' : `${failures} failure(s)`} ===`);
process.exit(failures ? 1 : 0);
