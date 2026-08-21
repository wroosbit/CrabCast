#!/usr/bin/env node
// KAN-530: sweep docs/ for a prose COUNT asserted about a machine-checked set.
//
// WHAT FAILURE THIS WOULD CATCH: a sentence in docs/ that states HOW MANY
// members a gated set has, while the gate under it checks only WHICH members
// it has. `docs/read-path-contract.md` said `the five fields` in six places
// about `BLOCK_SHAPES.ConfigEcho`, which has six members. Every field name on
// the page was present and correct, so `verify-read-contract.mjs` was green
// throughout — the false thing was a number in the sentence above the table,
// and a membership check has no member to match it against.
//
// THIS FILE IS THE SURVEY, NOT THE GATE. It reports; it does not fail a build
// on drift. `verify-doc-set-counts.mjs` is the gate, and it reconciles the
// same attribution this script discovers. The two are deliberately separate:
// the gate must be narrow enough to be trusted in CI, and a survey wants
// recall — so this script reports the LOOSE matches the gate declines to rule
// on, which is the population a human should read.
//
// WHAT IT CANNOT SEE, stated because the shape looks exhaustive:
//   - A count written in a form the noun list below does not carry ("all five
//     of them", "the quintet"). The noun list is the instrument; §1 prints it.
//   - A count about a set that no marker names. Attribution runs through the
//     document markers, so an ungated set's prose is out of scope BY
//     CONSTRUCTION — that is KAN-512's class, not this one.
//   - A count whose subject is a different sentence from its own line.
//     Attribution is line-local (§3 says why).
//
// Needs a build: it reads arities from `dist/`, so run `npm run build` first.
// Prints a report and exits 0 unless the sweep itself could not run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const distDir = path.join(repoRoot, 'dist');

const argv = new Set(process.argv.slice(2));
const showAll = argv.has('--all');

// --------------------------------------------------------------- §1 the instrument

/**
 * The number words this sweep can read, and the digits beside them. Written
 * out rather than generated so that the limit of the instrument is legible:
 * anything above twenty, and every spelled ordinal, is invisible to it.
 */
const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20]
]);

/**
 * The nouns a count has to land on to be a claim about a SET's size. Chosen to
 * match how these documents name the things a marker gates — fields in a
 * table, values in a value set, branches in a branch table.
 */
const SET_NOUNS = [
  'field', 'fields', 'member', 'members', 'key', 'keys', 'row', 'rows',
  'value', 'values', 'branch', 'branches', 'shape', 'shapes',
  'category', 'categories', 'entry', 'entries', 'column', 'columns'
];

const COUNT_RE = new RegExp(
  String.raw`\b(${[...NUMBER_WORDS.keys()].join('|')}|\d{1,3})[ \-](${SET_NOUNS.join('|')})\b`,
  'gi'
);

/** Every marker kind in docs/ that hands a named set to a gate. */
const MARKER_RE =
  /<!--\s*(contract-table|contract-values|contract-branches|contract-activate-branches|send-table|send-values|send-branches):\s*([A-Za-z0-9_.]+)\s*-->/g;

// ------------------------------------------------------------- §2 the declarations

const readContract = await import(path.join(distDir, 'read-contract.js'));
const sendContract = await import(path.join(distDir, 'send-contract.js'));

/**
 * Marker name -> how many members the declaration has.
 *
 * A marker names either a top-level export (`LIST_AGENTS_FIELDS`) or a member
 * of a container (`BLOCK_SHAPES.ConfigEcho`), so resolution walks the dotted
 * path through both modules. A name that resolves in NEITHER is reported by
 * §5 rather than skipped — an unresolvable marker is the sweep failing to
 * measure, and it must not read as "no drift here".
 */
function arityOf(name) {
  for (const mod of [readContract, sendContract]) {
    let node = mod;
    let ok = true;
    for (const part of name.split('.')) {
      if (node && typeof node === 'object' && part in node) node = node[part];
      else { ok = false; break; }
    }
    if (ok && node && typeof node === 'object') return Object.keys(node).length;
  }
  return null;
}

// ------------------------------------------------------------------ §3 attribution

/**
 * Read one document into the two things attribution needs: where each marker
 * sits, and which anchor names the section it sits in.
 *
 * ATTRIBUTION IS LINE-LOCAL, and that is a decision rather than a shortcut.
 * The six occurrences this ticket was filed for are spread across ~1250 lines
 * of one document and only ONE of them is near the marker it describes — the
 * other five say `the five fields [above](#configecho)` from inside unrelated
 * tables. So proximity to the marker finds 1 of 6, and the ANCHOR LINK is what
 * finds the rest. A sentence that names its subject in a different line than
 * its number is out of reach of both, and §5 says so.
 */
function readDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // anchor id -> the markers declared under it, until the next anchor.
  const anchorSets = new Map();
  // line index -> marker names declared on that line.
  const markerAt = new Map();

  let currentAnchor = null;
  lines.forEach((line, i) => {
    const anchor = /<a\s+id="([^"]+)"\s*>/.exec(line);
    if (anchor) currentAnchor = anchor[1].toLowerCase();

    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(line)) !== null) {
      const name = m[2];
      if (!markerAt.has(i)) markerAt.set(i, []);
      markerAt.get(i).push(name);
      if (currentAnchor) {
        if (!anchorSets.has(currentAnchor)) anchorSets.set(currentAnchor, new Set());
        anchorSets.get(currentAnchor).add(name);
      }
    }
  });

  return { lines, anchorSets, markerAt };
}

/**
 * Which named sets a line is talking about, and how confidently.
 *
 * `linked`  — the line carries a markdown link to an anchor whose section
 *             declares markers. The subject is named by the author, in the
 *             document's own reference mechanism. This is what the gate rules on.
 * `named`   — the line spells a marker's constant name.
 * `heading` — the line is within HEADING_REACH lines above a marker and
 *             declares no other subject. This covers the section heading that
 *             introduces a table.
 * `loose`   — a count with no subject this instrument can resolve. Reported,
 *             never ruled on.
 */
const HEADING_REACH = 3;

function subjectsOf(doc, lineIndex) {
  const line = doc.lines[lineIndex];
  const found = [];

  for (const m of line.matchAll(/\]\(#([^)]+)\)/g)) {
    const sets = doc.anchorSets.get(m[1].toLowerCase());
    if (sets) for (const name of sets) found.push({ name, how: 'linked' });
  }

  for (const sets of doc.anchorSets.values()) {
    for (const name of sets) {
      const tail = name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
      const re = new RegExp(String.raw`\b${name.replace('.', '\\.')}\b|\`${tail}\``);
      if (re.test(line) && !found.some((f) => f.name === name)) {
        found.push({ name, how: 'named' });
      }
    }
  }

  if (found.length === 0) {
    for (let ahead = 1; ahead <= HEADING_REACH; ahead += 1) {
      const names = doc.markerAt.get(lineIndex + ahead);
      if (names) {
        for (const name of names) found.push({ name, how: 'heading' });
        break;
      }
    }
  }

  return found;
}

// --------------------------------------------------------------------- §4 the sweep

const docFiles = fs
  .readdirSync(docsDir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => path.join(docsDir, f));

const attributed = [];
const loose = [];
const unresolvable = new Set();
let candidates = 0;

for (const file of docFiles) {
  const doc = readDoc(file);
  const rel = path.relative(repoRoot, file);

  doc.lines.forEach((line, i) => {
    COUNT_RE.lastIndex = 0;
    let m;
    while ((m = COUNT_RE.exec(line)) !== null) {
      candidates += 1;
      const word = m[1].toLowerCase();
      const stated = NUMBER_WORDS.get(word) ?? Number(word);
      const quote = m[0];
      const subjects = subjectsOf(doc, i);

      if (subjects.length === 0) {
        loose.push({ rel, line: i + 1, quote, text: line.trim() });
        continue;
      }
      for (const s of subjects) {
        const arity = arityOf(s.name);
        if (arity === null) unresolvable.add(s.name);
        attributed.push({
          rel, line: i + 1, quote, stated, set: s.name, how: s.how, arity,
          agrees: arity !== null && arity === stated
        });
      }
    }
  });
}

// -------------------------------------------------------------------- §5 the report

console.log('KAN-530 — counts asserted about machine-checked sets in docs/\n');
console.log(`instrument : ${NUMBER_WORDS.size} number words (one..twenty) + digits 0-999`);
console.log(`             × ${SET_NOUNS.length} set nouns (${SET_NOUNS.join(', ')})`);
console.log(`corpus     : ${docFiles.length} files under docs/`);
console.log(`markers     : ${MARKER_RE.source.match(/\|/g).length + 1} marker kinds recognised`);
console.log(`candidates : ${candidates} count phrases matched anywhere in the corpus\n`);

const disagreeing = attributed.filter((a) => a.arity !== null && !a.agrees);
const agreeing = attributed.filter((a) => a.agrees);

console.log(`--- attributed to a named set: ${attributed.length} ---\n`);

if (disagreeing.length === 0) {
  console.log('DISAGREEING WITH THE DECLARATION: none.\n');
} else {
  console.log(`DISAGREEING WITH THE DECLARATION: ${disagreeing.length}\n`);
  for (const d of disagreeing) {
    console.log(
      `  ${d.rel}:${d.line}  "${d.quote}"  [${d.how}]\n` +
      `      says ${d.stated}, ${d.set} has ${d.arity}`
    );
  }
  console.log('');
}

console.log(`AGREEING WITH THE DECLARATION: ${agreeing.length}`);
for (const a of agreeing) {
  console.log(`  ${a.rel}:${a.line}  "${a.quote}"  [${a.how}]  ${a.set} = ${a.arity}`);
}
console.log('');

if (unresolvable.size > 0) {
  console.log(`⚠ MARKERS THIS SWEEP COULD NOT RESOLVE TO A DECLARATION: ${unresolvable.size}`);
  for (const n of unresolvable) console.log(`  ${n}`);
  console.log('  A count attributed to one of these was NOT checked.\n');
} else {
  console.log('markers unresolvable to a declaration: none — every attributed set was measured.\n');
}

console.log(`--- counts with no set this instrument could name: ${loose.length} ---`);
if (showAll) {
  for (const l of loose) console.log(`  ${l.rel}:${l.line}  "${l.quote}"  ${l.text.slice(0, 110)}`);
} else {
  console.log('  (re-run with --all to list them; they are prose about things no marker gates)');
}
console.log('');

// THE CONTROL. A sweep that reports "none" has said nothing until the same
// instrument is shown finding something. This runs the whole attribution path
// over a synthetic document whose count is deliberately wrong, and requires
// the disagreement to come back — so a "none" above is a fact about docs/
// rather than a fact about a regex that matches nothing.
const controlSet = 'BLOCK_SHAPES.ConfigEcho';
const controlArity = arityOf(controlSet);
const controlDoc = {
  lines: [
    '<a id="controlecho"></a>',
    '### A control section',
    `<!-- contract-table: ${controlSet} -->`,
    '| *config echo* | durable | the nineteen fields [above](#controlecho) |'
  ],
  anchorSets: new Map([['controlecho', new Set([controlSet])]]),
  markerAt: new Map([[2, [controlSet]]])
};
const controlSubjects = subjectsOf(controlDoc, 3);
const controlSaw =
  controlArity !== null &&
  controlSubjects.some((s) => s.name === controlSet && s.how === 'linked') &&
  controlArity !== 19;

console.log('--- control ---');
console.log(`  a planted "nineteen fields [above](#controlecho)" against ${controlSet} (${controlArity})`);
console.log(`  attribution: ${controlSubjects.map((s) => `${s.name}[${s.how}]`).join(', ') || 'NOTHING'}`);
console.log(`  ${controlSaw ? 'CAUGHT — the instrument can report a disagreement' : 'MISSED — this sweep proves nothing'}`);

if (!controlSaw) {
  console.error('\ncontrol failed: the sweep could not find a planted disagreement, so its report is void.');
  process.exit(1);
}
process.exit(0);
