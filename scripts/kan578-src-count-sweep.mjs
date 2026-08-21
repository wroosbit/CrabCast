#!/usr/bin/env node
// KAN-578: sweep `src/` and `scripts/` for a COMMENT COUNT asserted about a
// declared set, and measure whether any attribution handle could gate it.
//
// WHAT FAILURE THIS WOULD CATCH: a source comment that states HOW MANY members
// a declared constant has, while the constant's arity has moved underneath it.
// Four such comments were live on `origin/main` at `234243d` — three about
// `BLOCK_SHAPES.ConfigEcho` (6 members, prose said five) and one about
// `ROW_SHAPES.UnreadableRecord` — and one of the four was inside
// `scripts/verify-read-contract.mjs`, the gate whose greenness made the
// surrounding claims credible. They were found by a person reading. KAN-530's
// gate cannot see them: it takes its corpus from `docs/` and its attribution
// from `<!-- contract-table: NAME -->` markers, and a source comment has no
// marker.
//
// THIS FILE IS THE SURVEY, NOT THE GATE. It reports; it never fails a build on
// drift, and it exits 0 with disagreements on the screen. The gate is
// `scripts/verify-src-comment-counts.mjs`, and this script is the measurement
// its shape was chosen from — deliberately separate, for KAN-530's reason: a
// gate must be narrow enough to be trusted in CI, and a survey wants recall.
//
// WHAT THE MEASUREMENT DECIDED, in one paragraph. Of the three attribution
// handles KAN-578's ticket proposed, NONE is gateable: across all three, at
// `234243d`, 17 disagreements of which 2 are the defect — and one of the false
// reds is on prose that cannot be made correct, because it is a claim about a
// SUBSET and no wording of it will equal the arity. What does work is
// ADJACENCY, which is not one of the three: a count whose subject is spelled
// beside it. That is the gate's rule, it reaches ~2% of this population, and
// the gate prints that fraction on every run so its green cannot be read as
// more. Run this script with `--why` for the short form.
//
// WHAT IT CANNOT SEE, stated because the output looks exhaustive:
//   - A count written in a form the noun list does not carry ("all six of
//     them", "the whole quintet"). §1 prints the instrument.
//   - A count above twenty spelled out, or any spelled ordinal.
//   - A count about a set this sweep cannot resolve to an arity. Arities come
//     from `dist/`, and three modules are excluded from that import by name
//     because importing them starts a daemon — §2 says which and why.
//   - A count whose subject is named in a DIFFERENT comment block. Attribution
//     is block-local, and §4 says why that is the ceiling rather than a
//     shortcut.
//
// Needs a build: arities come from `dist/`, so run `npm run build` first.
// Needs `typescript` (a devDependency) for its lexer — §3 says why a regex
// cannot do that job. No daemon, no network.
//
// Prints a report and exits 0. It exits 1 only when the sweep could not run at
// all, or when its own control fails to catch a planted disagreement.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const require = createRequire(import.meta.url);

const argv = new Set(process.argv.slice(2));
const showAll = argv.has('--all');
const whyOnly = argv.has('--why');

// Sweep a tree other than this repository — used by the retro-measurement in
// the PR body, which runs this same instrument over `234243d`, the commit the
// four known instances were live on. Arities still come from THIS build, which
// is sound only because KAN-530 changed comments and no declaration: `git diff
// 234243d 21a29fa -- src` is three one-line comment edits.
const treeArg = [...argv].find((a) => a.startsWith('--tree='));
const treeRoot = treeArg ? path.resolve(treeArg.slice('--tree='.length)) : repoRoot;

// --------------------------------------------------------------- §1 the instrument

/**
 * The number words this sweep can read. Deliberately the SAME list KAN-530's
 * `docs/` sweep uses, so the two populations are comparable: a difference
 * between the corpora must not be an artifact of a different instrument.
 */
const NUMBERS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20]
]);

/** The nouns a count must land on. Also KAN-530's list, for the same reason. */
const NOUNS = [
  'fields', 'field', 'members', 'member', 'keys', 'key', 'rows', 'row',
  'values', 'value', 'branches', 'branch', 'shapes', 'shape',
  'categories', 'category', 'entries', 'entry', 'columns', 'column'
];

const NUM = [...NUMBERS.keys()].join('|');
const COUNT = new RegExp(String.raw`\b(${NUM}|\d{1,3})[\s\-](${NOUNS.join('|')})\b`, 'gi');

/**
 * `the other five fields`, `the first 5 rows` — a count about a SUBSET of a
 * declared set. The arity is the wrong number to reconcile these against even
 * when attribution succeeds, which is one half of why no gate is possible
 * here; §6 carries the other half.
 */
const SUBSET_QUALIFIER = /\b(other|others|remaining|rest|first|last|next|only|top|bottom|another|further|extra|additional|same)\s+$/i;

/** `four of the six rows`, `two in the five branches` — explicitly a subset. */
const PARTITIVE = /\b(of|in|from|among|across|within)\s+(the\s+|its\s+|these\s+|those\s+)?$/i;

// ------------------------------------------------------------- §2 the declarations

/**
 * Every exported SCREAMING_CASE object, array, Set or Map in `dist/`, and one
 * level of nesting inside the objects, as `name -> arity`. This is the set of
 * things a comment could be making a size claim about.
 *
 * ⚠ THREE MODULES ARE EXCLUDED BY NAME, AND THAT IS A SAFETY RULE RATHER THAN
 * A TIDINESS ONE. `dist/daemon.js`, `dist/mcp.js` and `dist/cli.js` execute at
 * import: importing them from this script contacts the running daemon's socket
 * and prints its registry to stdout. Nothing else in `dist/` imports any of
 * them, so excluding the three excludes them transitively as well — verified
 * by grepping every `dist/*.js` for an import of the four side-effecting or
 * re-exporting modules, with `router.js` added to the same pattern as a
 * positive control to show the grep can find an importer that exists.
 *
 * The cost of the exclusion is stated rather than hidden: a set declared only
 * in one of those three is invisible to this sweep, and a count about it is
 * reported as unattributed rather than as agreeing.
 */
const SIDE_EFFECTING = new Set(['daemon.js', 'mcp.js', 'cli.js']);

async function declaredSets() {
  const found = new Map();
  if (!fs.existsSync(distDir)) return found;
  const files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js') && !SIDE_EFFECTING.has(f)).sort();
  for (const f of files) {
    let mod;
    try { mod = await import(path.join(distDir, f)); } catch { continue; }
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
 * Every comment in a source file, as blocks, taken from TypeScript's PARSER.
 *
 * ⚠ THE PARSER IS NOT A PREFERENCE, AND THE LEXER IS NOT ENOUGH. Two cheaper
 * instruments were tried here first. Both were wrong, both silently, and the
 * second looked exactly like the fix for the first:
 *
 *   1. A HAND-ROLLED SCANNER was wrong in BOTH directions.
 *      It LOST files: `scripts/verify-read-contract.mjs` contains the regex
 *      literal `/[\`*_]/g`, whose character class holds a BACKTICK, and a
 *      scanner tracking template literals but not regex literals reads it as
 *      the start of a template and swallows the rest of the file — including
 *      the `BLOCK_SHAPES.ConfigEcho` comment that is this ticket's own fourth
 *      specimen. It also INVENTED comments: the verify scripts embed other
 *      files' source as fixtures inside template literals, so lines beginning
 *      `//` and ` * ` that are STRING CONTENT were counted as prose.
 *
 *   2. `ts.createScanner` HAS THE SAME REGEX BLINDNESS. A token scanner cannot
 *      know whether `/` opens a regex or divides — the parser decides that and
 *      calls `reScanSlashToken` — so on the fixture above it returns ZERO
 *      comments. On the real tree it appeared to work, because these files
 *      carry enough later backticks to resync by luck. Measured: it reported
 *      747 comments in `src/router.ts` where the parser reports 1967, and 267
 *      in `verify-read-contract.mjs` against 559. It was reading about half the
 *      corpus and printing a healthy-looking total.
 *
 * Every one of those failures produces a well-formed report, and every one of
 * them fails toward FINDING LESS — which is the direction this sweep must not
 * fail in, because its output is an argument about how big a population is.
 *
 * Line comments that are vertically adjacent are merged into one block,
 * because a paragraph of `//` lines is one comment to its author and
 * attribution has to see all of it.
 */
function commentBlocks(source, fileName) {
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

  // A comment is trivia of some token, so walking every node and its token
  // children reaches all of them. Ranges dedupe by start offset, because one
  // comment is both trailing trivia of what precedes it and leading trivia of
  // what follows.
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

  const lines = source.split('\n');
  for (const b of merged) {
    let k = b.end; // 0-based index of the first line after the block
    while (k < lines.length) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { k += 1; continue; }
      break;
    }
    b.nextCode = k < lines.length ? lines[k].trim() : '';
    b.file = fileName;
  }
  return merged;
}

// ------------------------------------------------------------------ §4 attribution

/**
 * Which declared sets a comment block could be talking about, and by which
 * handle. These are the three candidates KAN-578's ticket proposed, measured
 * rather than argued about:
 *
 *   `link`     — a `{@link NAME}` in the block names a declared set. The
 *                strongest handle available, because it is the language's own
 *                reference mechanism and the author wrote it deliberately.
 *   `named`    — the set's identifier appears literally in the block.
 *   `attached` — the block is the leading comment of the set's own
 *                declaration.
 *
 * ATTRIBUTION IS BLOCK-LOCAL, and that is the ceiling rather than a shortcut.
 * `docs/` could reach further because a document publishes anchors and
 * sentences link to them; a comment has no anchors and nothing to link to. The
 * three handles above are the whole of what a comment offers, which is why §6
 * can rule on the question rather than leaving it open.
 */
function subjectsOf(block, sets) {
  const found = [];
  const add = (name, how) => { if (!found.some((f) => f.name === name)) found.push({ name, how }); };

  for (const m of block.text.matchAll(/\{@link\s+([A-Za-z0-9_.]+)/g)) {
    if (sets.has(m[1])) add(m[1], 'link');
  }

  for (const name of sets.keys()) {
    const re = new RegExp(String.raw`\b${name.replace(/\./g, '\\.')}\b`);
    if (re.test(block.text)) add(name, 'named');
  }

  const decl = /^export\s+const\s+([A-Z][A-Z0-9_]*)\b/.exec(block.nextCode);
  if (decl && sets.has(decl[1])) add(decl[1], 'attached');

  return found;
}

// --------------------------------------------------------------------- §5 the sweep

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

const sets = await declaredSets();
if (sets.size === 0) {
  console.error('kan578-src-count-sweep: no declared sets found in dist/. Run `npm run build` first.');
  process.exit(1);
}

const files = [...walk(path.join(treeRoot, 'src'), '.ts'), ...walk(path.join(treeRoot, 'scripts'), '.mjs')];
if (files.length === 0) {
  console.error(`kan578-src-count-sweep: no source files under ${treeRoot}. Nothing to sweep.`);
  process.exit(1);
}

const buckets = { onlyIdiom: [], subset: [], partitive: [], plain: [] };
const byHandle = { link: [], named: [], attached: [], none: [] };
let candidates = 0;
let blockCount = 0;

function classify(block, rel) {
  COUNT.lastIndex = 0;
  let m;
  while ((m = COUNT.exec(block.text)) !== null) {
    candidates += 1;
    const stated = NUMBERS.get(m[1].toLowerCase()) ?? Number(m[1]);
    const head = block.text.slice(0, m.index);
    const lineOffset = (head.match(/\n/g) || []).length;
    const rec = {
      rel,
      line: block.start + lineOffset,
      quote: m[0],
      stated,
      context: (block.text.split('\n')[lineOffset] || '').replace(/^\s*(\/\/|\*|\/\*\*?)\s?/, '').trim()
    };
    const before = head.slice(-40);

    // `the one field a consumer is meant to branch on` is "the ONLY field",
    // not a count of one. KAN-530 measured three of these in `docs/`; §6
    // reports what this corpus holds, and it is not three.
    if (stated === 1) { buckets.onlyIdiom.push(rec); continue; }
    if (SUBSET_QUALIFIER.test(before)) { rec.why = 'subset qualifier'; buckets.subset.push(rec); continue; }
    if (PARTITIVE.test(before)) { rec.why = 'partitive'; buckets.partitive.push(rec); continue; }

    buckets.plain.push(rec);
    const subjects = subjectsOf(block, sets);
    const best = subjects.find((s) => s.how === 'link')
      ?? subjects.find((s) => s.how === 'named')
      ?? subjects.find((s) => s.how === 'attached');
    if (!best) { byHandle.none.push(rec); continue; }
    const scoped = subjects.filter((s) => s.how === best.how);
    byHandle[best.how].push({
      ...rec,
      subjects: scoped.map((s) => ({ name: s.name, arity: sets.get(s.name) })),
      agrees: scoped.some((s) => sets.get(s.name) === stated)
    });
  }
}

for (const file of files) {
  const rel = path.relative(treeRoot, file);
  const source = fs.readFileSync(file, 'utf8');
  const blocks = commentBlocks(source, rel);
  blockCount += blocks.length;
  for (const block of blocks) classify(block, rel);
}

// -------------------------------------------------------------------- §6 the report

if (!whyOnly) {
  console.log('KAN-578 — counts asserted about declared sets in src/ and scripts/\n');
  console.log(`tree       : ${treeRoot === repoRoot ? '(this worktree)' : treeRoot}`);
  console.log(`instrument : ${NUMBERS.size} number words (one..twenty) + digits 0-999`);
  console.log(`             × ${NOUNS.length} set nouns (${NOUNS.join(', ')})`);
  console.log(`corpus     : ${files.length} files — src/**/*.ts and scripts/**/*.mjs`);
  console.log(`             ${blockCount} comment blocks, read with TypeScript's parser (§3)`);
  console.log(`declared   : ${sets.size} sets resolvable to an arity from dist/`);
  console.log(`             (${[...sets.keys()].filter((k) => !k.includes('.')).length} top-level, ${[...sets.keys()].filter((k) => k.includes('.')).length} nested)`);
  console.log(`candidates : ${candidates} count phrases in comments\n`);

  console.log('--- what the count phrases turned out to be ---\n');
  const pct = (n) => `${((n / candidates) * 100).toFixed(1)}%`;
  console.log(`  "the one X" — the ONLY-X idiom, not a count : ${String(buckets.onlyIdiom.length).padStart(3)}  ${pct(buckets.onlyIdiom.length)}`);
  console.log(`  a subset of a set ("the other five fields") : ${String(buckets.subset.length).padStart(3)}  ${pct(buckets.subset.length)}`);
  console.log(`  partitive ("four of the six rows")          : ${String(buckets.partitive.length).padStart(3)}  ${pct(buckets.partitive.length)}`);
  console.log(`  everything else — a possible size claim     : ${String(buckets.plain.length).padStart(3)}  ${pct(buckets.plain.length)}\n`);

  console.log(`--- attribution of those ${buckets.plain.length} ---\n`);
  console.log(`  {@link SET} in the same block  : ${byHandle.link.length}`);
  console.log(`  SET identifier in the block    : ${byHandle.named.length}`);
  console.log(`  block attached to SET's decl   : ${byHandle.attached.length}`);
  console.log(`  no handle of any kind          : ${byHandle.none.length}\n`);

  for (const how of ['link', 'named', 'attached']) {
    const rows = byHandle[how];
    if (rows.length === 0) {
      console.log(`  ${how}: none.\n`);
      continue;
    }
    console.log(`  === ${how} (${rows.length}) ===`);
    for (const r of rows) {
      const names = r.subjects.map((s) => `${s.name}=${s.arity}`).join(', ');
      console.log(`  ${r.agrees ? 'AGREES  ' : 'DISAGREES'} ${r.rel}:${r.line}  "${r.quote}" says ${r.stated}`);
      console.log(`            attributed to ${names}`);
      console.log(`            ${r.context.slice(0, 118)}`);
    }
    console.log('');
  }

  if (showAll) {
    console.log(`  === no handle (${byHandle.none.length}) ===`);
    for (const r of byHandle.none) console.log(`  ${r.rel}:${r.line}  "${r.quote}"  ${r.context.slice(0, 100)}`);
    console.log('');
    console.log(`  === "the one X" idiom (${buckets.onlyIdiom.length}) ===`);
    for (const r of buckets.onlyIdiom) console.log(`  ${r.rel}:${r.line}  "${r.quote}"  ${r.context.slice(0, 100)}`);
    console.log('');
  } else {
    console.log('  (re-run with --all to list the unattributed population and the idiom)\n');
  }
}

// ----------------------------------------------------------------- §7 the control

// A sweep that reports a population has said nothing about its own recall
// until the same path is shown finding a planted instance. This runs the whole
// pipeline — lexer, count regex, subset filters, attribution — over a
// synthetic source file whose comment states a count that is deliberately
// wrong about a set that really exists, and requires the disagreement back.
//
// The fixture also carries the backtick-in-a-regex that broke the hand-rolled
// scanner (§3), BEFORE the comment under test, so the control fails if this
// script is ever moved back onto a lexer that cannot read past it.
const controlSet = [...sets.keys()].find((k) => k.includes('.')) ?? [...sets.keys()][0];
const controlArity = sets.get(controlSet);
const controlStated = controlArity + 7;
const controlWord = [...NUMBERS.entries()].find(([, v]) => v === controlStated)?.[0] ?? String(controlStated);
const controlSource = [
  "const plain = (cell) => cell.replace(/[`*_]/g, '').trim();",
  '/**',
  ` * A planted claim: the ${controlWord} fields of {@link ${controlSet}}.`,
  ' */',
  'export const CONTROL_DECLARATION = {};'
].join('\n');

const controlBlocks = commentBlocks(controlSource, '<control>');
let controlRec = null;
for (const block of controlBlocks) {
  COUNT.lastIndex = 0;
  const m = COUNT.exec(block.text);
  if (!m) continue;
  const subjects = subjectsOf(block, sets);
  const link = subjects.find((s) => s.how === 'link');
  if (link) {
    const stated = NUMBERS.get(m[1].toLowerCase()) ?? Number(m[1]);
    controlRec = { stated, set: link.name, arity: sets.get(link.name) };
  }
}

const controlCaught = controlRec !== null
  && controlRec.set === controlSet
  && controlRec.stated === controlStated
  && controlRec.arity !== controlStated;

console.log('--- control ---');
console.log(`  a planted "the ${controlWord} fields of {@link ${controlSet}}" against an arity of ${controlArity}`);
console.log(`  past a regex literal containing a backtick, which is what broke the hand-rolled scanner`);
console.log(`  attribution: ${controlRec ? `${controlRec.set} = ${controlRec.arity}, comment says ${controlRec.stated}` : 'NOTHING'}`);
console.log(`  ${controlCaught ? 'CAUGHT — the pipeline can report a disagreement' : 'MISSED — this sweep proves nothing'}`);

if (!controlCaught) {
  console.error('\ncontrol failed: the sweep could not find a planted disagreement, so its report is void.');
  process.exit(1);
}

console.log('');
console.log('--- the finding ---');
console.log('');
console.log('  NONE OF THE THREE HANDLES THE TICKET PROPOSED IS GATEABLE, and the rows');
console.log('  above are why. A gate needs both halves and these have neither:');
console.log('');
console.log('  1. DISCRIMINATION. KAN-530 separated a size claim from a delta in docs/');
console.log('     with the definite article, cutting 22 candidates to 6 with no false');
console.log('     positive. It does not transfer. Nearly half this corpus is "the one X"');
console.log('     meaning "the ONLY X" — the article is present and it is not a count.');
console.log('     Subset claims carry it too, and "the other five fields of that shape"');
console.log('     is one of the four instances this ticket was filed for: the number to');
console.log('     reconcile it against is the arity MINUS the five named above it.');
console.log('');
console.log('  2. ATTRIBUTION. Most possible size claims name no set by any handle. Of');
console.log('     those that do, the handle is usually wrong — a comment block that');
console.log('     MENTIONS a constant is not a comment block ABOUT it. Read the `named`');
console.log('     rows above: `THE THREE SHAPES NOT TAKEN` attributed to COMPOSER_MARKERS');
console.log('     is the shape of the whole class.');
console.log('');
console.log('  ⚠ AND ONE FALSE RED CANNOT BE FIXED BY WRITING CORRECT PROSE. src/router.ts');
console.log('     says "the other five fields of that shape" about a SUBSET of an 11-field');
console.log('     ROW_SHAPES.UnreadableRecord. It disagreed with the arity while stale and');
console.log('     it disagrees now that it is corrected. A check nobody can turn green is');
console.log('     not a strict check; it is a check that gets deleted.');
console.log('');
console.log('  WHAT IS GATEABLE IS ADJACENCY, which is NOT one of the three: a count whose');
console.log('  subject is spelled beside it — `the six fields of `SET``, or ``SET` has six');
console.log('  members`. It rules on a small fraction of the population above and produced');
console.log('  no false positive on either tree measured. That is');
console.log('  scripts/verify-src-comment-counts.mjs, which prints the fraction it reaches');
console.log('  on every run so its green cannot be read as coverage of this whole page.');
console.log('');
console.log('  THE MAJORITY REMAINS UNGATED AND IS NOT CLAIMED OTHERWISE. Three of the four');
console.log('  instances this ticket was filed for name their subject anaphorically — "that');
console.log('  shape", "the config echo" — or not at all, and no mechanism proposed here');
console.log('  reaches them. They were found by a person reading, and that is still the');
console.log('  only thing that finds them.');
console.log('');
process.exit(0);
