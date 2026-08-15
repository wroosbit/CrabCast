#!/usr/bin/env node
// KAN-428 RED DRIVE — does §6 of verify-pty-consumer-named.mjs actually go red,
// and does it distinguish the TWO WAYS the decision can stop being true?
//
// WHAT FAILURE THIS WOULD CATCH: a §6 that reports the decision intact whatever
// the tree says. It is five substring tests and one boolean over two parses,
// which is exactly the shape that passes forever if a needle is subtly wrong,
// and its output looks identical either way.
//
// THE TWO FAILURE MODES ARE NOT THE SAME REPAIR, and separating them is the
// whole point of the section:
//
//   THE CLAIM GOES  — somebody tidies the decision out of §10. The repository
//                     is still right; the page stopped saying why. Arms 1, 2, 5.
//   THE WORLD GOES  — somebody contracts the pty triple and never returns to
//                     the paragraph. The page still states a decision that has
//                     been overturned underneath it, and every present-tense
//                     assertion about its WORDING stays green. Arms 3 and 4.
//
// The second is the one KAN-428 was written for and the one nothing caught
// before: a document asserting a live decision about code that no longer holds
// it. So arms 3 and 4 require the red to arrive in the CONTRADICTION's own
// words, and arm 1 requires it NOT to — a missing sentence reported as a lie
// would send the next reader to rewrite a paragraph that was fine.
//
// ⚠ THE WORKING TREE IS NEVER TOUCHED. Every arm runs against a COPY, in a temp
// directory laid out in the same shape so the proof's `..`-relative paths
// resolve. KAN-428 asked for mutate-then-restore; staging is that requirement
// met more strongly, because an interrupted run cannot leave the repository
// holding a deliberately falsified contract document — there is nothing to
// restore. Section 7 asserts byte-identity of every source file afterwards
// regardless, because "I did not intend to write to the tree" is a claim and
// not a measurement.
//
// EVERY MUTATION'S ANCHOR IS REQUIRED TO OCCUR EXACTLY ONCE, and that is a rule
// about this drive rather than about the proof. An anchor matching zero times
// applies nothing and the arm reads as a guard that failed to bite; an anchor
// matching twice mutates more than the arm describes and the red that follows
// is not the red the arm claims. Both render as a well-formed result to a
// question nobody asked, and the second is the comfortable direction.
//
// THE CONTROL IS ARM 0 AND IT IS NOT A FORMALITY. A drive whose baseline is not
// demonstrated measures the runner as much as the guard: if the staged layout
// were wrong, every arm would go red and this would read as six successes.
//
// Exits non-zero if any arm behaves differently. No daemon, no herdr, no
// network, no build.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');

const PROOF = path.join('scripts', 'verify-pty-consumer-named.mjs');
const SRC = path.join('src', 'read-contract.ts');
const DOC = path.join('docs', 'read-path-contract.md');
/** §5's subjects — staged because the proof reads them, never mutated here. */
const CLI = path.join('src', 'cli.ts');
const PARITY = path.join('scripts', 'verify-cli-parity.mjs');

const STAGED = [PROOF, SRC, DOC, CLI, PARITY];

let failures = 0;

/** Every staged file as it stood BEFORE any arm ran — see section 7. */
const before = Object.fromEntries(
  STAGED.map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan428-'));
  for (const rel of STAGED) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), dest);
  }
  return dir;
}

function runProof(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROOF)], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Replace a LITERAL anchor that must occur EXACTLY ONCE in the staged file.
 * Returns false — loudly — if the count is anything else, because an arm that
 * did not apply and an arm that applied twice both produce output a reader
 * takes at face value.
 */
function editOnce(dir, rel, anchor, replacement) {
  const p = path.join(dir, rel);
  const text = fs.readFileSync(p, 'utf8');
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    console.log(`  FAIL  the mutation anchor occurs ${count}× in ${rel}, expected exactly 1`);
    console.log(`        anchor: ${JSON.stringify(anchor.slice(0, 72))}`);
    console.log('        The arm did NOT run as described. This is a broken arm, not a finding.');
    failures += 1;
    return false;
  }
  fs.writeFileSync(p, text.replace(anchor, replacement));
  return true;
}

/** The contradiction's own wording — the thing arms 3/4 must see and arm 1 must not. */
const LYING = /THE DOCUMENT IS NOW LYING/;

// ------------------------------------------------------------- arm 0: control
console.log('\narm 0  CONTROL — unmutated copy');
{
  const dir = stage();
  const { code, out } = runProof(dir);
  check(code === 0, 'the proof exits 0 on an unmutated tree', `exit ${code}`);
  check(
    /PASS {2}the decision itself/.test(out),
    'and §6 reports the decision as recorded'
  );
  check(
    /PASS {2}and the document and the code are not in contradiction about it/.test(out),
    'and reports the claim and the world agreeing'
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- arm 1: the decision is gone
console.log('\narm 1  DECISION DELETED — §10 stops saying the rule does not fire');
{
  const dir = stage();
  if (editOnce(dir, DOC, 'The rule does not fire here', 'This is worth thinking about')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}the decision itself/.test(out),
      'and names the decision as the thing that went'
    );
    // THE DISCRIMINATION THIS ARM EXISTS FOR.
    check(
      !LYING.test(out),
      'and does NOT report a contradiction — the code is still right, only the page went quiet'
    );
    check(
      /PASS {2}the code still agrees/.test(out),
      'while confirming the world is unchanged, so the reader knows which half to repair'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------ arm 2: the reopening condition goes
//
// The most likely single casualty of a tidy-up: it reads as a hedge, and it is
// the only sentence that tells a future consumer they are the case that
// overturns this. Losing it leaves a decision with no stated way back.
console.log('\narm 2  REOPENING CONDITION DELETED — the way back is no longer written down');
{
  const dir = stage();
  if (editOnce(dir, DOC, 'branches on a documented field', 'uses this surface')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}the REOPENING CONDITION/.test(out),
      'and names the reopening condition specifically'
    );
    check(
      /PASS {2}the decision itself/.test(out),
      'while the decision itself still passes — the arm is specific, not a blanket red'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------- arm 3: THE WORLD MOVES, the page does not
//
// ⚠ THIS IS THE ARM KAN-428 WAS WRITTEN FOR. Before §6 existed, this mutation
// left every sentence-level assertion green: the document went on stating a
// live decision about code that had already overturned it, and the only red was
// a membership row, which reads as a list to fix rather than a paragraph to
// retake.
console.log("\narm 3  WORLD MOVED — 'pty_init' promoted to COVERED_SURFACES, decision text untouched");
{
  const dir = stage();
  if (
    editOnce(
      dir,
      SRC,
      'export const COVERED_SURFACES = {\n',
      "export const COVERED_SURFACES = {\n  pty_init: ['AGENT_STATUS_FIELDS'],\n"
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}and the document and the code are not in contradiction about it/.test(out),
      'and §6 names the contradiction — NOT merely the membership change'
    );
    check(
      /the document RECORDS A DECISION the repository has already overturned/.test(out),
      'and says what is wrong in a sentence about the DOCUMENT rather than about a list'
    );
    check(LYING.test(out), 'and prints the loud explanation, because this is the silent direction');
    check(
      /PASS {2}the decision itself/.test(out),
      'while every sentence-level check still PASSES — which is exactly why §6 had to exist'
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------- arm 4: the same, by deletion rather than promotion
console.log("\narm 4  WORLD MOVED, OTHER DIRECTION — 'pty_resize' tidied out of UNCOVERED_SURFACES");
{
  const dir = stage();
  if (editOnce(dir, SRC, "  'pty_resize',\n", '')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}the code still agrees/.test(out),
      'and §6 reports the code no longer agreeing'
    );
    check(LYING.test(out), 'and reaches the contradiction, not only §1\'s membership failure');
    check(
      /FAIL {2}'pty_resize' is in UNCOVERED_SURFACES/.test(out),
      "and §1 still reports its own finding — two failures for one mutation is the intent"
    );
    check(!/VACUITY/.test(out), 'and reports no vacuity — the list was found, it was short');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------- arm 5: the retired framing returns
//
// A merge resolving in favour of the older side is the ordinary way this comes
// back, and the result is a page that both poses the question and answers it.
// Of the two a reader believes the one that sounds like a standing instruction.
console.log('\narm 5  STALE FRAMING RESTORED — the pre-decision wording returns beside the decision');
{
  const dir = stage();
  if (
    editOnce(
      dir,
      DOC,
      '#### The decision: the rule does not fire for the pty triple',
      'Until that is taken, the rows stay where they are.\n\n#### The decision: the rule does not fire for the pty triple'
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}and does NOT still frame the question as open and awaiting a decision/.test(out),
      'and names the resurrected framing'
    );
    check(
      /the pre-KAN-428 wording is back beside the decision it was replaced by/.test(out),
      'and says what is wrong with having both, rather than only that a string was found'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------- arm 6: vacuity
//
// THE ARM WORTH THE MOST, for the same reason KAN-394's arm 5 was. §6 must not
// convert an input it could not read into a finding about a lie. With the
// section unlocatable there is nothing to have decided and nothing to
// contradict, and a run that reported five missing sentences plus a
// contradiction would send somebody to rewrite a paragraph that is fine.
console.log('\narm 6  VACUITY — the Not-covered section anchor removed entirely');
{
  const dir = stage();
  if (editOnce(dir, DOC, '<!-- contract-uncovered-surfaces -->', '<!-- anchor renamed away -->')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}VACUITY: the contract-uncovered-surfaces anchor is not in the document/.test(out),
      'and reports VACUITY by name'
    );
    check(
      /This is a broken instrument, NOT a finding about the tree/.test(out),
      'and says so in words a reader cannot mistake for a finding'
    );
    check(
      !/FAIL {2}the decision itself/.test(out),
      '§6 does NOT report the decision as deleted — it could not read the section at all'
    );
    check(!LYING.test(out), 'and manufactures no contradiction out of an unreadable input');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------- §7 the working tree is untouched
//
// A BEFORE/AFTER DIGEST, NOT `git status` — the same reasoning KAN-394's drive
// records: whether the repository has uncommitted work in it is the author's
// business, and whether THIS SCRIPT dirtied it is the only claim this section
// is entitled to make. It will always pass as the arms stand, because they
// write only into a temp tree; what it guards is the next edit. "Just mutate
// the real file and restore it" is the obvious simplification of the staging
// dance above, and the moment somebody takes it, a run interrupted between
// mutation and restore leaves a deliberately falsified contract document in the
// repository.
console.log('\n§7  this drive did not write to the working tree');
{
  for (const [rel, text] of Object.entries(before)) {
    const after = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    check(after === text, `${rel} is byte-for-byte what it was before arm 0`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} problem(s) above.`);
} else {
  console.log(
    'OK — §6 goes red on all six mutations, and tells a deleted claim apart from an overturned decision.'
  );
}

process.exit(failures ? 1 : 0);
