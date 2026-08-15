#!/usr/bin/env node
// KAN-433: a table that lists proofs in one uniform format must say which of
// them CI does not run — and the saying is checked against the workflow.
//
// WHAT FAILURE THIS WOULD CATCH: a markdown table in `docs/` presenting several
// proofs in one uniform format where CI runs some of them and not others, with
// nothing on the page saying which. `docs/read-path-contract.md`'s
// uncovered-surfaces table was exactly that: seven rows, one format, five
// proofs in the `ci.yml` verify array and two in `verify-proof-registry.mjs`'s
// `EXCLUSIONS` — and the document did not use the token "CI" once in 2000
// lines, so the column could not have been disclosing a CI class for any row.
// A reader who has learned that these documents state where a proof runs reads
// the omission as continuity.
//
// AND THE FAILURE IT WOULD CATCH SECOND, which is why it is not a phrase check:
// a row marked as a hand-run whose proof has since been ADDED to the CI array.
// That mark is then a false warning rather than a missing one, and it degrades
// in the comfortable direction — a reader who believes a guard is weaker than
// it is goes and re-runs something by hand, and nothing ever tells them they
// need not have.
//
// ⚠ WHY THIS IS NOT THE HONESTY-PHRASE MATCHING KAN-391 REJECTED, because it
// looks like it from a distance and the distinction is the whole design.
// KAN-391's AC5 refused to gate on prose containing an honesty phrase, on the
// grounds that A GATE A PHRASE CAN SILENCE IS WORSE THAN NO GATE, BECAUSE IT
// CONVERTS A JUDGEMENT INTO A GREEN TICK. That objection is about a
// ONE-DIRECTIONAL check: phrase present, therefore green, whatever the world
// says. This is BIDIRECTIONAL and joined to the workflow. Writing the mark
// where it is not true is as red as omitting it where it is, so the mark cannot
// silence anything — it can only be right or wrong, and which one is read off
// `.github/workflows/ci.yml` rather than off the sentence. A phrase that must
// agree with a measurement is not an honesty phrase; it is a claim with a
// checker.
//
// ⚠ AND IT IS DELIBERATELY STRICTER THAN THE FRAMING IT CAME FROM. `epic/KAN-59`
// raised this as *"assert that a uniform list or table presents proofs of a
// uniform CI class"* — heterogeneity in a uniform presentation. Under that rule
// a table naming ONLY excluded proofs is uniform and passes in silence, which
// is finding 1's harm with the numbers changed: uniformity is not the property
// a reader needs, KNOWING WHICH CLASS is. So the rule here is per-cell rather
// than per-table — any cell naming a proof CI does not run must say so — and a
// table whose proofs are all in CI satisfies it by carrying no marks at all.
// The uniform-class rule is the special case of this one where the answer
// happens to be "all of them".
//
// WHAT IT DOES NOT COVER, named because the gap is between scripts and no
// script owns it (KAN-145's shape):
//
//   1. PROSE. KAN-433's findings 2 and 3 are sentences in
//      `docs/send-contract.md` and `docs/herdr-pane-handle-join.md` that rest a
//      claim on an excluded proof. Both were fixed in the same change as this
//      file and NEITHER IS HELD BY ANYTHING MECHANICAL, here or elsewhere. A
//      later edit can undo them silently. That is a real hole, it is not
//      closed, and it is not closeable by this design: the rule below needs a
//      cell to attach a mark to, and a paragraph has none.
//   2. A TABLE NAMING ONE PROOF. Two distinct proofs is the threshold for
//      "presents a class", and a single-proof table is a sentence in a box.
//      Deliberate, and the reason findings 2 and 3 were never in reach.
//   3. A PROOF NAMED BY INTERPOLATION, or leaned on without being named. A
//      literal match cannot see either, and no control here catches that — the
//      sweep reports the same clean answer.
//   4. WHETHER THE JOB IS A REQUIRED CONTEXT in branch protection. That is
//      repository settings, which nothing in this tree can read. See
//      `scripts/ci-workflow.mjs` boundary 1.
//
// `scripts/kan433-doc-proof-sweep.mjs` is the wider survey — every proof named
// anywhere in `docs/*.md`, joined to what CI runs — and it asserts nothing. It
// is how hole 1 above is measured rather than guessed at; it is not a gate, and
// running it does not close anything.
//
// WHAT IT READS. `docs/*.md` and `.github/workflows/ci.yml`, both AS TEXT, plus
// `git ls-files`. It imports nothing from `dist/`, starts no daemon and needs no
// build — so its verdict is about the source you actually edited, and a stale or
// failed build cannot make it pass or fail for the wrong reason. The workflow is
// read with `readVerifyArray` and `findRunInvocations` from
// `scripts/ci-workflow.mjs`, which are the same two functions
// `verify-proof-registry.mjs` uses to make exactly this judgement. A second
// reader of that workflow, free to drift from the first, is the defect
// `ci-workflow.mjs` was extracted to prevent.
//
// VACUITY. Every parse below fails LOUDLY and in its own words when its input is
// empty or unfindable. "I found no tables" and "the tables are all consistent"
// are the same exit code and must never be the same sentence — this check's
// entire population is discovered rather than declared, so a scanner that
// matched nothing would report a clean tree forever.
//
// Exits non-zero on any failure so a reviewer can re-run it against the PR head.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRunInvocations, readVerifyArray } from './ci-workflow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const workflowRel = path.join('.github', 'workflows', 'ci.yml');

/**
 * The mark a cell must carry when it names a proof CI does not run.
 *
 * ONE LITERAL, matched case-sensitively, and it is the document's own words
 * rather than a token invented for this checker: `docs/herdr-pane-handle-join.md`
 * already wrote "It is hand-run and not in CI" of `verify-herdr-release` before
 * this check existed. A marker a human would write anyway is one a human will
 * keep writing.
 */
const MARK = 'hand-run, not in CI';

/**
 * How many distinct proofs a table must name before it counts as PRESENTING A
 * CLASS. One proof is a sentence in a box; two in one format is a comparison a
 * reader will draw. See "what it does not cover" item 2.
 */
const MIN_PROOFS = 2;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A parse that came back empty is a broken instrument, not a finding. */
function vacuity(ok, what) {
  if (!ok) {
    console.log(`FAIL  VACUITY: ${what}`);
    console.log('      This is a broken instrument, NOT a finding about the tree.');
    console.log('      Nothing below it has been measured. Fix the parse before reading any verdict.');
    failures += 1;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// §1  The world: which proofs does ci.yml run?
// ---------------------------------------------------------------------------

console.log(`§1  what ${workflowRel} runs, read with scripts/ci-workflow.mjs\n`);

const yaml = fs.readFileSync(path.join(repoRoot, workflowRel), 'utf8');
const array = readVerifyArray(yaml);

// A short read would take the entries it never saw with it and then report an
// all-clear over the remainder — every unread entry would classify as NOT RUN
// and demand a mark the document is right not to have.
const arrayReadWhole = array.opens === 1 && array.closed;
vacuity(
  arrayReadWhole,
  `${workflowRel} gave ${array.opens} \`scripts=(\` array(s), closed=${array.closed} — ` +
    'the verify array was not read whole, so every classification below would be about a prefix of it. ' +
    'verify-proof-registry.mjs is the check that owns this failure.'
);

const inArray = new Set(array.entries.map((e) => e.name));
vacuity(!arrayReadWhole || inArray.size > 0, 'the verify array parsed to ZERO entries');

/**
 * Proof files present in `scripts/`.
 *
 * READ OFF THE FILESYSTEM RATHER THAN FROM `git ls-files`, which is what
 * `verify-proof-registry.mjs` uses and what the first draft of this file used.
 * Two reasons, and the second is the one that decided it. (a) The question here
 * is narrower than the registry's: it asks whether CI RUNS a proof, and for a
 * name with no file behind it the answer is no however git feels about it —
 * the tracked/untracked distinction the registry needs, because its subject is
 * a merge resolution, does not change any verdict below. (b) A `git` dependency
 * makes this proof unrunnable against a staged COPY of the tree, which is how
 * `scripts/kan433-red-drive.mjs` mutates it without ever writing to the working
 * tree. A proof whose red cannot be demonstrated safely is a proof nobody
 * demonstrates.
 */
const proofsPresent = new Set(
  fs
    .readdirSync(path.join(repoRoot, 'scripts'))
    .filter((f) => /^verify-.*\.mjs$/.test(f))
    .map((f) => path.basename(f, '.mjs'))
);
vacuity(proofsPresent.size > 0, 'scripts/ holds no verify-*.mjs at all');

/**
 * A live, top-level `node scripts/<name>.mjs` OUTSIDE the array's own region —
 * how `verify-proof-registry.mjs` itself runs, and the reason "not in the array"
 * is not the same question as "not run by CI".
 */
const ownJobCache = new Map();
function hasOwnJob(name) {
  if (ownJobCache.has(name)) return ownJobCache.get(name);
  const needle = new RegExp(`node\\s+scripts/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mjs`);
  const live = findRunInvocations(yaml, needle)
    .filter((f) => !array.region || f.line < array.region.start || f.line > array.region.end)
    .some((f) => f.position === 'command' && f.disabled.length === 0);
  ownJobCache.set(name, live);
  return live;
}

/**
 * Does CI run this proof on every pull request?
 *
 * A name with no file in `scripts/` is FOREIGN — `verify-crabcast-runtime-live`
 * is Butchr's script, in another repository, and `docs/moving-baselines.md`
 * names it. This CI does not run it, so it answers false, and a table cell
 * naming one would be required to say so. That is the right answer for the
 * right reason: a reader of a CrabCast table has no way to know the proof is
 * somebody else's.
 */
function ciRuns(name) {
  if (inArray.has(name)) return true;
  if (!proofsPresent.has(name)) return false;
  return hasOwnJob(name);
}

if (arrayReadWhole) {
  console.log(
    `      ${inArray.size} entries in the verify array; ${proofsPresent.size} proof file(s) in scripts/`
  );
}

// The join's two answers, each demonstrated. A classifier that could only ever
// return one of them would pass every table below and mean nothing.
console.log('\n      controls on the classifier:');
const controlRuns = 'verify-pty-consumer-named';
const controlNot = 'verify-pty-payload-refusal';
const controlOwnJob = 'verify-proof-registry';
check(ciRuns(controlRuns), `the classifier can say RUN — \`${controlRuns}\` is in the verify array`);
check(!ciRuns(controlNot), `and can say NOT RUN — \`${controlNot}\` is in neither the array nor a job of its own`);
check(
  ciRuns(controlOwnJob),
  `and RUN is not merely "in the array" — \`${controlOwnJob}\` runs from a live step of its own`,
  inArray.has(controlOwnJob) ? 'WEAKENED: it is in the array now, so this control no longer tests the own-job path' : ''
);

// ---------------------------------------------------------------------------
// §2  The claim: every markdown table in docs/ that presents a class.
// ---------------------------------------------------------------------------

console.log('\n§2  every table in docs/*.md naming two or more proofs\n');

const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
vacuity(docFiles.length > 0, 'docs/ contains no .md files');

/**
 * Contiguous runs of lines beginning with `|`. Markdown tables are not parsed
 * further than this on purpose: the question is about CELLS, and a run of pipe
 * lines is exactly the shape a reader sees as one uniform presentation.
 *
 * The two leading rows — header and delimiter — are dropped. A run of fewer
 * than three lines is not a table with a body.
 */
function tablesIn(text) {
  const lines = text.split('\n');
  const out = [];
  let block = [];
  let start = 0;
  const flush = () => {
    if (block.length >= 3) out.push({ line: start, rows: block.slice(2) });
    block = [];
  };
  lines.forEach((l, i) => {
    if (l.trim().startsWith('|')) {
      if (!block.length) start = i + 1;
      block.push(l);
    } else {
      flush();
    }
  });
  flush();
  return out;
}

/** Cells of one row, outer pipes stripped. */
const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

/** Every distinct `verify-<name>` token in a string. */
const proofsIn = (s) => [...new Set([...s.matchAll(/verify-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]))];

let tablesScanned = 0;
let tablesPresentingAClass = 0;
let cellsJudged = 0;

for (const f of docFiles) {
  const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  for (const table of tablesIn(text)) {
    tablesScanned += 1;
    const named = proofsIn(table.rows.join('\n'));
    if (named.length < MIN_PROOFS) continue;
    tablesPresentingAClass += 1;

    const notRun = named.filter((n) => !ciRuns(n));
    console.log(
      `  docs/${f}:${table.line}  ${table.rows.length} row(s), ${named.length} proof(s), ` +
        `${notRun.length} not run by CI`
    );

    for (const [r, row] of table.rows.entries()) {
      for (const cell of cellsOf(row)) {
        const inCell = proofsIn(cell);
        if (!inCell.length) continue;
        cellsJudged += 1;

        const unrun = inCell.filter((n) => !ciRuns(n));
        const marked = cell.includes(MARK);
        const where = `docs/${f}:${table.line + 2 + r}`;

        if (unrun.length) {
          // The omission this ticket was filed for.
          check(
            marked,
            `${where} marks \`${unrun.join('`, `')}\` as not run by CI`,
            marked
              ? ''
              : `this cell names a proof CI does not run, in a table where ${named.length - notRun.length} ` +
                `of ${named.length} proof(s) ARE run, and says nothing about the difference. ` +
                `Add "${MARK}" to the cell.`
          );
        } else {
          // The other direction, and the reason the mark is not a phrase check:
          // a mark on a proof CI DOES run is a false warning, and it degrades
          // toward looking more cautious rather than less.
          check(
            !marked,
            `${where} does NOT falsely mark \`${inCell.join('`, `')}\``,
            marked
              ? `this cell carries "${MARK}" but CI runs every proof it names. ` +
                'The proof was added to the workflow and the mark was left behind — remove it.'
              : ''
          );
        }
      }
    }
  }
}

// The population is DISCOVERED, so a scanner that matched nothing would report
// a clean tree forever. This is the guard that makes the zero above a
// measurement.
vacuity(tablesScanned > 0, 'no markdown table was found in any docs/*.md — the table scanner matched nothing');
vacuity(
  tablesPresentingAClass > 0,
  `no table in docs/*.md names ${MIN_PROOFS} or more proofs — either the scanner is broken or ` +
    'every such table has been removed. It is not a clean result; nothing was judged.'
);
vacuity(cellsJudged > 0, 'no cell naming a proof was judged, though tables presenting a class were found');

console.log(
  `\n      ${tablesScanned} table(s) scanned, ${tablesPresentingAClass} presenting a class, ` +
    `${cellsJudged} cell(s) judged`
);

// ---------------------------------------------------------------------------
// §3  The mark is explained where a reader meets it.
//
// ⚠ THIS IS A PRESENCE CHECK AND IT IS THE WEAK HALF. It asserts a paragraph is
// on the page, not that the paragraph is true — §2 is what makes it true, and
// the two are separated here so that nobody reads this section as carrying more
// than it does. It is worth having anyway: a marked cell whose mark nothing
// explains is a piece of jargon, and the next author tidies jargon out.
// ---------------------------------------------------------------------------

console.log('\n§3  and where the mark is used, the document explains it\n');

for (const f of docFiles) {
  const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  const inTables = tablesIn(text).some((t) => t.rows.some((r) => r.includes(MARK)));
  if (!inTables) continue;

  // Outside a table row: the same literal in running prose.
  const inProse = text
    .split('\n')
    .some((l) => !l.trim().startsWith('|') && l.includes(MARK));
  check(
    inProse,
    `docs/${f} explains "${MARK}" in prose as well as using it in a table`,
    inProse ? '' : 'the mark appears only inside table cells — a reader meets a phrase nothing on the page defines'
  );
}

// ---------------------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} problem(s) above.`);
} else {
  console.log(
    'OK — every docs table presenting a class of proofs marks the ones CI does not run, ' +
      'marks none that it does, and explains the mark where it uses it.'
  );
}

process.exit(failures ? 1 : 0);
