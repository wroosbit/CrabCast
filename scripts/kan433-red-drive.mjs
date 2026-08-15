#!/usr/bin/env node
// KAN-433 RED DRIVE — does verify-doc-proof-ci-class.mjs actually go red, and
// does it go red from BOTH SIDES OF ITS JOIN?
//
// WHAT FAILURE THIS WOULD CATCH: a check that reports every docs table honest
// whatever the tree says. It is a substring test over table cells joined to a
// workflow parse, which is exactly the shape that passes forever if either half
// is subtly wrong, and its output looks identical either way.
//
// ⚠ THE ARM THAT DECIDES WHETHER THIS CHECK IS WORTH HAVING IS ARM 3, and it is
// worth saying why before the code. KAN-391's AC5 rejected gating on prose
// containing an honesty phrase, because A GATE A PHRASE CAN SILENCE IS WORSE
// THAN NO GATE. The defence in verify-doc-proof-ci-class.mjs is that its mark is
// joined to the workflow in both directions and therefore cannot be silenced by
// writing it. THAT IS A CLAIM, and arm 3 is the measurement of it: the DOCUMENT
// IS NOT TOUCHED AT ALL and a proof is added to the `ci.yml` verify array, so
// the marks become false without a character of prose changing. If arm 3 does
// not go red, the check is a phrase check wearing a join, and the argument in
// its header is wrong.
//
// Arm 4 drives the same join from the other direction — a proof REMOVED from
// the array, document again untouched — because a join asserted in one
// direction only is half a join.
//
// THE TWO FAILURE MODES ARE NOT THE SAME REPAIR, and the check distinguishes
// them in its own words:
//
//   THE MARK IS MISSING  — a cell names a proof CI does not run and says
//                          nothing. Arms 1 and 4. The repair is to the page.
//   THE MARK IS FALSE    — a cell warns about a proof CI now runs. Arms 2 and
//                          3. The repair is to remove a warning, and it
//                          degrades toward looking MORE cautious, which is why
//                          nobody notices it.
//
// ⚠ THE WORKING TREE IS NEVER TOUCHED. Every arm runs against a COPY, in a temp
// directory laid out in the same shape so the proof's `..`-relative paths
// resolve. That is mutate-then-restore met more strongly, because an interrupted
// run cannot leave the repository holding a deliberately falsified document —
// there is nothing to restore. The last section asserts byte-identity of every
// source file afterwards regardless, because "I did not intend to write to the
// tree" is a claim and not a measurement.
//
// EVERY MUTATION'S ANCHOR IS REQUIRED TO OCCUR EXACTLY ONCE. An anchor matching
// zero times applies nothing, and the arm then reads as a guard that failed to
// bite; an anchor matching twice mutates more than the arm describes, and the
// red that follows is not the red the arm claims. Both render as a well-formed
// answer to a question nobody asked, and the second is the comfortable
// direction.
//
// ARM 0 IS THE CONTROL AND ARM 7 IS THE FALSE-POSITIVE CONTROL. Without the
// first, a broken staging layout would redden every arm and read as seven
// successes. Without the second, a check that reddened on ANY edit would pass
// every arm here and be worthless — arm 7 makes an edit of exactly the shape
// the check is about and requires it to stay GREEN.
//
// Exits non-zero if any arm behaves differently. No daemon, no herdr, no
// network, no build.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');

const PROOF = path.join('scripts', 'verify-doc-proof-ci-class.mjs');
const DOC = path.join('docs', 'read-path-contract.md');
const CI = path.join('.github', 'workflows', 'ci.yml');

/** Whole directories, copied faithfully rather than shimmed. */
const STAGED_DIRS = ['docs', 'scripts', '.github'];

/** Files this drive mutates, and therefore must prove it did not mutate here. */
const WITNESSED = [PROOF, DOC, CI, path.join('scripts', 'ci-workflow.mjs')];

let failures = 0;

const before = Object.fromEntries(
  WITNESSED.map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan433-'));
  for (const d of STAGED_DIRS) {
    fs.cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  }
  return dir;
}

function runProof(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROOF)], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Replace a LITERAL anchor that must occur EXACTLY ONCE in the staged file.
 * Loudly refuses at any other count — see the header.
 */
function editOnce(dir, rel, anchor, replacement) {
  const p = path.join(dir, rel);
  const text = fs.readFileSync(p, 'utf8');
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    console.log(`  FAIL  the mutation anchor occurs ${count}× in ${rel}, expected exactly 1`);
    console.log(`        anchor: ${JSON.stringify(anchor.slice(0, 76))}`);
    console.log('        The arm did NOT run as described. This is a broken arm, not a finding.');
    failures += 1;
    return false;
  }
  fs.writeFileSync(p, text.replace(anchor, replacement));
  return true;
}

/** The two failure wordings the arms must tell apart. */
const MISSING = /Add "hand-run, not in CI" to the cell/;
const FALSE_MARK = /but CI runs every proof it names/;

const MARK = ' — **hand-run, not in CI**';
const PTY_INIT_CELL = '`verify-pty-init-rejects-unknown-session.mjs`' + MARK + ' |';
/** The whole `tail_agent` row — the table's cleanest example of a proof CI runs. */
const TAIL_ROW =
  '| `tail_agent` | reads the tail and which source answered | `verify-tail-asks-every-source.mjs` |';
const ARRAY_ENTRY = (n) => `            ${n}\n`;

// --------------------------------------------------------------- arm 0
console.log('\narm 0  CONTROL — unmutated staged copy');
{
  const dir = stage();
  const { code, out } = runProof(dir);
  check(code === 0, 'the proof exits 0 on an unmutated tree', `exit ${code}`);
  check(/3 presenting a class/.test(out), 'and finds the three tables that present a class');
  check(
    /PASS {2}docs\/read-path-contract\.md:\d+ marks `verify-pty-init-rejects-unknown-session`/.test(out),
    'and reports the pty_init row as marked'
  );
  check(!MISSING.test(out) && !FALSE_MARK.test(out), 'and reports neither failure wording');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 1
console.log('\narm 1  MARK DELETED — the pty_init row stops saying its proof is a hand-run');
{
  const dir = stage();
  if (editOnce(dir, DOC, PTY_INIT_CELL, '`verify-pty-init-rejects-unknown-session.mjs` |')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}docs\/read-path-contract\.md:\d+ marks `verify-pty-init-rejects-unknown-session`/.test(out),
      'and names the cell that went quiet'
    );
    check(MISSING.test(out), 'and says the mark is MISSING, which is the repair to the page');
    check(!FALSE_MARK.test(out), 'and does NOT report a false mark — that is the other repair entirely');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 2
//
// The direction a phrase check cannot see. The document GAINS the honesty
// phrase, on a row whose proof CI runs, and that must be red.
console.log('\narm 2  FALSE MARK — a row whose proof CI DOES run claims to be a hand-run');
{
  const dir = stage();
  const falselyMarked = TAIL_ROW.replace('.mjs` |', '.mjs`' + MARK + ' |');
  if (editOnce(dir, DOC, TAIL_ROW, falselyMarked)) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red on a mark that was ADDED, not removed', `exit ${code}`);
    check(
      /FAIL {2}docs\/read-path-contract\.md:\d+ does NOT falsely mark `verify-tail-asks-every-source`/.test(out),
      'and names the cell carrying the false warning'
    );
    check(FALSE_MARK.test(out), 'and says CI runs every proof that cell names');
    check(!MISSING.test(out), 'and does not confuse it with a missing mark');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 3
//
// ⚠ THE ARM THIS DRIVE EXISTS FOR. Not one character of any document changes.
// A proof moves into the CI array, and the marks that were true this morning are
// false this afternoon. A check that only reads prose CANNOT go red here, and
// that is the whole difference between this and the honesty-phrase matching
// KAN-391 rejected.
console.log('\narm 3  THE WORLD MOVED — a marked proof is added to the CI array, document untouched');
{
  const dir = stage();
  const docBefore = fs.readFileSync(path.join(dir, DOC), 'utf8');
  if (
    editOnce(
      dir,
      CI,
      ARRAY_ENTRY('verify-pty-consumer-named'),
      ARRAY_ENTRY('verify-pty-consumer-named') + ARRAY_ENTRY('verify-pty-payload-refusal')
    )
  ) {
    const docAfter = fs.readFileSync(path.join(dir, DOC), 'utf8');
    check(docAfter === docBefore, 'the document is byte-identical — only the workflow moved');

    const { code, out } = runProof(dir);
    check(code !== 0, 'and the proof goes red anyway', `exit ${code}`);
    check(FALSE_MARK.test(out), 'naming the marks as false now that CI runs the proof');
    // Both pty_payload rows, and NOT the pty_init row, whose proof did not move.
    check(
      /FAIL {2}docs\/read-path-contract\.md:\d+ does NOT falsely mark `verify-pty-payload-refusal`/.test(out),
      'on the rows whose proof moved'
    );
    check(
      /PASS {2}docs\/read-path-contract\.md:\d+ marks `verify-pty-init-rejects-unknown-session`/.test(out),
      'and leaves the row whose proof did NOT move green — the join is per-proof, not per-table'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 4
//
// The same join from the other side: a proof LEAVES the array and a row that
// was honest this morning is silent this afternoon. This is the shape a merge
// resolution produces — see verify-proof-registry.mjs's founding failure.
console.log('\narm 4  THE WORLD MOVED THE OTHER WAY — a proof leaves the CI array, document untouched');
{
  const dir = stage();
  const docBefore = fs.readFileSync(path.join(dir, DOC), 'utf8');
  if (editOnce(dir, CI, ARRAY_ENTRY('verify-tail-asks-every-source'), '')) {
    check(
      fs.readFileSync(path.join(dir, DOC), 'utf8') === docBefore,
      'the document is byte-identical — only the workflow moved'
    );
    const { code, out } = runProof(dir);
    check(code !== 0, 'and the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}docs\/read-path-contract\.md:\d+ marks `verify-tail-asks-every-source`/.test(out),
      'naming the row that is now unmarked and should not be'
    );
    check(MISSING.test(out), 'and asking for the mark rather than reporting a false one');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 5
console.log('\narm 5  EXPLANATION DELETED — the mark is used in a table and defined nowhere');
{
  const dir = stage();
  const anchor = 'The three rows marked **hand-run, not in CI**';
  if (editOnce(dir, DOC, anchor, 'The three rows marked in the third column')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}docs\/read-path-contract\.md explains "hand-run, not in CI" in prose/.test(out),
      'and names §3 — a reader meets a phrase nothing on the page defines'
    );
    // The table itself is untouched, so §2 must stay quiet. A check that
    // reported the cells broken here would send a reader to the wrong repair.
    check(!MISSING.test(out) && !FALSE_MARK.test(out), 'while §2 stays green — the cells are still right');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 6
//
// A BROKEN INSTRUMENT MUST NOT READ AS A CLEAN TREE. With the array unreadable
// every proof classifies as not-run, which is the state in which a silent check
// would produce its most reassuring output.
console.log('\narm 6  VACUITY — the CI array cannot be read at all');
{
  const dir = stage();
  if (editOnce(dir, CI, '          scripts=(\n', '          scripts_disabled=(\n')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(/VACUITY/.test(out), 'and says VACUITY — a broken instrument, not a finding about the tree');
    check(
      /was not read whole/.test(out),
      'and names what broke, so nobody repairs a document over a workflow parse'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- arm 7
//
// FALSE-POSITIVE CONTROL. A check that reddened on any edit to these tables
// would have passed every arm above and been worthless. This adds a row of
// exactly the shape the check is about — a new uncovered surface held by a
// proof CI runs, carrying no mark — and requires it to stay GREEN.
console.log('\narm 7  FALSE-POSITIVE CONTROL — a new row whose proof CI runs needs no mark');
{
  const dir = stage();
  const newRow = '| `probe_response` | a fabricated row for this control | `verify-cli-parity.mjs` |';
  if (editOnce(dir, DOC, TAIL_ROW, newRow + '\n' + TAIL_ROW)) {
    const { code, out } = runProof(dir);
    check(code === 0, 'the proof stays green — a uniform row is not a finding', `exit ${code}`);
    check(!MISSING.test(out) && !FALSE_MARK.test(out), 'and reports neither failure wording');
    check(/PASS {2}docs\/read-path-contract\.md:\d+ does NOT falsely mark `verify-cli-parity`/.test(out),
      'while having actually judged the new row — the control is not vacuous');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- the tree
console.log('\nthe working tree was not written to');
for (const rel of WITNESSED) {
  const now = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  check(now === before[rel], `${rel} is byte-identical to before this drive ran`);
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} arm assertion(s) behaved differently.`);
} else {
  console.log(
    'OK — the check goes red when the mark goes, when the mark is false, and — with no document ' +
      'edit at all — when the workflow moves underneath it in either direction.'
  );
}

process.exit(failures ? 1 : 0);
