#!/usr/bin/env node
// KAN-394 RED DRIVE — does verify-pty-consumer-named.mjs actually go red, and
// does it go red for the reason it claims?
//
// WHAT FAILURE THIS WOULD CATCH: a guard that reports the tree clean whatever
// the tree says. `verify-pty-consumer-named.mjs` is a handful of substring and
// membership tests over two text files, which is exactly the shape that passes
// forever if a regex is subtly wrong — and its output looks identical either
// way. Nine arms mutate the four files the proof reads and require it to go
// red NAMING THE RIGHT THING; an arm that goes red by the wrong route is
// reported as a failure of this drive rather than as a success of the guard.
//
// ARMS 6-9 EXIST BECAUSE THE FIRST FIVE WERE NOT ENOUGH, and that is worth
// keeping rather than smoothing over. Arms 1-5 all mutate what the proof
// asserts is TRUE. `epic/KAN-59` pointed out on review that §4 asserts only
// that SENTENCES ARE PRESENT — and the sentences carry factual claims about
// `src/cli.ts` and `scripts/verify-cli-parity.mjs`. They falsified two of them
// and the proof returned `exit 0 · 17 PASS · 0 FAIL` to both. Arms 6-8 are
// those mutations, kept as arms so the gap cannot reopen quietly.
//
// AND ARM 9 IS WHY ONE ROUND OF THAT WAS NOT ENOUGH EITHER. Arm 6's fix
// unanchored the parse from line position and left it anchored to QUOTE STYLE;
// the same reviewer caught that one generalisation short, with the counts that
// make it a durability gap rather than a live falsehood. Each of these three
// rounds was found by somebody rather than foreseen, which is the honest
// summary of what a red drive is for.
//
// ⚠ THE WORKING TREE IS NEVER TOUCHED. Every arm runs against a COPY of the
// files the proof reads, in a temp directory, laid out in the same shape
// so the proof's own `..`-relative paths resolve. In-place mutation with a
// restore is the obvious alternative and it is worse: an interrupted run
// leaves the repository holding a deliberately broken contract document, and
// this suite has a rule about interrupted proofs for a reason. Section 6
// asserts `git status` is clean at the end regardless, because "I did not
// intend to write to the tree" is a claim and not a measurement.
//
// THE CONTROL IS ARM 0 AND IT IS NOT A FORMALITY. A drive whose baseline is
// not demonstrated is measuring the runner as much as the guard: if the copied
// layout were wrong, every arm would go red and the drive would read as nine
// successes.
//
// THE VACUITY ARM IS THE ONE WORTH THE MOST. Arm 5 does not remove `pty_init`
// from the list — it removes the LIST, by renaming the declaration. A guard
// whose parse silently returns nothing and then reports "everything I looked
// at was fine" is the failure this epic keeps meeting, so the requirement is
// not merely that arm 5 goes red: it must go red in DIFFERENT WORDS from arm
// 1, naming vacuity rather than reporting a missing surface. Same exit code,
// different finding, and conflating them is how a broken instrument gets read
// as a clean tree.
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
/** §5's subjects: the files the document makes factual claims ABOUT. */
const CLI = path.join('src', 'cli.ts');
const PARITY = path.join('scripts', 'verify-cli-parity.mjs');

let failures = 0;

/** Every mutated file as it stood BEFORE any arm ran — see section 6. */
const digestsBefore = Object.fromEntries(
  [SRC, DOC, CLI, PARITY].map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A fresh temp tree holding just the files the proof reads. */
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan394-'));
  for (const rel of [PROOF, SRC, DOC, CLI, PARITY]) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), dest);
  }
  return dir;
}

/** Run the proof in a staged tree. Returns { code, out }. */
function runProof(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROOF)], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const edit = (dir, rel, fn) => {
  const p = path.join(dir, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) {
    console.log(`  FAIL  the mutation changed nothing in ${rel} — the arm did not run`);
    failures += 1;
    return false;
  }
  fs.writeFileSync(p, after);
  return true;
};

// ------------------------------------------------------------- arm 0: control
console.log('\narm 0  CONTROL — unmutated copy');
{
  const dir = stage();
  const { code, out } = runProof(dir);
  check(code === 0, 'the proof exits 0 on an unmutated tree', `exit ${code}`);
  check(/OK — the pty triple is still uncovered/.test(out), 'and prints its OK verdict');
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------- arm 1: tidied out of list
console.log("\narm 1  TIDY-OUT — 'pty_init' removed from UNCOVERED_SURFACES");
{
  const dir = stage();
  if (edit(dir, SRC, (t) => t.replace(/^\s*'pty_init',\n/m, ''))) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}'pty_init' is in UNCOVERED_SURFACES/.test(out),
      'and names the surface that was tidied out'
    );
    check(!/VACUITY/.test(out), 'and does NOT report vacuity — the list was found, it was short');
    check(
      /parsed 6 declared uncovered surface\(s\)/.test(out),
      'and reports the list it actually parsed, so the reader can see it was not empty'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ arm 2: promoted
console.log("\narm 2  PROMOTION — 'pty_init' added to COVERED_SURFACES");
{
  const dir = stage();
  if (
    edit(dir, SRC, (t) =>
      t.replace(
        /export const COVERED_SURFACES = \{\n/,
        "export const COVERED_SURFACES = {\n  pty_init: ['AGENT_STATUS_FIELDS'],\n"
      )
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}'pty_init' is NOT in COVERED_SURFACES/.test(out),
      'and names the promotion specifically'
    );
    check(
      /naming a consumer was not authorisation to contract the surface/.test(out),
      'and says why that is wrong rather than only that it happened'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- arm 3: the disclaimer goes
console.log('\narm 3  DISCLAIMER DROPPED — consumer still named, refusal sentence deleted');
{
  const dir = stage();
  if (edit(dir, DOC, (t) => t.replace(/does not change what this document promises/, 'is worth knowing')))
    {
      const { code, out } = runProof(dir);
      check(code !== 0, 'the proof goes red', `exit ${code}`);
      check(
        /FAIL {2}the section states that naming a consumer does not change what the document promises/.test(out),
        'and names the missing refusal'
      );
      check(
        /a contract document\n {8}and the sentence refusing to promise them anything is GONE/.test(out) ||
          /READ THIS ONE CAREFULLY/.test(out),
        'and prints the loud explanation, because this arm is the one a tidy-up causes'
      );
      check(
        /PASS {2}the section names Butchr as a consumer/.test(out),
        'while the consumer is STILL named — which is precisely what makes it dangerous'
      );
    }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------- arm 4: doc row cut
console.log("\narm 4  DOC ROW CUT — the 'pty_resize' row removed from §10's table");
{
  const dir = stage();
  if (edit(dir, DOC, (t) => t.replace(/^\| `pty_resize` \|.*\n/m, ''))) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}§10's Not-covered table has a 'pty_resize' row/.test(out),
      'and names the row that went'
    );
    check(
      /parsed 6 documented row\(s\)/.test(out),
      'and reports the row count it parsed rather than asserting into the void'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- arm 5: vacuity
console.log('\narm 5  VACUITY — the whole UNCOVERED_SURFACES declaration renamed away');
{
  const dir = stage();
  if (edit(dir, SRC, (t) => t.replace(/export const UNCOVERED_SURFACES =/, 'export const RENAMED_AWAY ='))) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}VACUITY: UNCOVERED_SURFACES was not found/.test(out),
      'and reports VACUITY by name'
    );
    check(
      /This is a broken instrument, NOT a finding about the tree/.test(out),
      'and says so in words a reader cannot mistake for a finding'
    );
    // The distinction this arm exists for.
    check(
      !/FAIL {2}'pty_init' is in UNCOVERED_SURFACES/.test(out),
      'and does NOT also report the ordinary arm-1 failure — a missing LIST and a missing SURFACE are different findings'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------ arm 6: the claimed-absent command exists
//
// ARMS 6-8 ARE `epic/KAN-59`'S FINDING ON REVIEW, TURNED INTO ARMS. They ran
// the first two of these against the proof as it stood and got `exit 0 · 17
// PASS · 0 FAIL` from both: §1-§4 assert that things are true and that
// sentences are present, and the sentences are where the section's factual
// claims about OTHER FILES IN THIS REPOSITORY live. Nothing checked those.
console.log("\narm 6  CLAIM FALSIFIED — an 'attach' command added to src/cli.ts");
{
  const dir = stage();
  if (
    edit(dir, CLI, (t) =>
      t.replace(/export const COMMANDS: CommandSpec\[\] = \[\n/, (m) => `${m}  { name: 'attach' },\n`)
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}no CLI command is named 'attach'/.test(out),
      "and names the command whose existence falsifies the section's headline sentence"
    );
    check(
      /the command now EXISTS and the section's headline sentence is false/.test(out),
      'and says what that does to the document rather than only that a name was found'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------- arm 7: the CLI reaches for the surface
console.log("\narm 7  STRONGER CLAIM FALSIFIED — src/cli.ts starts driving 'pty_input'");
{
  const dir = stage();
  if (edit(dir, CLI, (t) => `${t}\n// send raw keystrokes: { action: 'pty_input', sessionId }\n`)) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}src\/cli\.ts does not mention 'pty_input'/.test(out),
      'and names the action the CLI has started to reach for'
    );
    check(
      /PASS {2}src\/cli\.ts does not mention 'pty_init'/.test(out),
      'while the other two still pass — the arm is specific, not a blanket red'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------ arm 8: the quotation rots
//
// The document reproduces a phrase from the exclusion register verbatim, and
// until this arm nothing tied them: a reword on either side left the document
// MISQUOTING a file sitting beside it in the same repository, silently. That is
// KAN-245's class — a hand-maintained copy of another file's text.
console.log('\narm 8  QUOTATION ROTS — verify-cli-parity.mjs reworded away from the quoted phrase');
{
  const dir = stage();
  if (
    edit(dir, PARITY, (t) =>
      t.replace(
        'CrabCast is a management layer and never embeds a terminal',
        'CrabCast does not ship an embedded terminal'
      )
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}the phrase the section quotes appears literally in scripts\/verify-cli-parity\.mjs/.test(out),
      'and names the file the document now misquotes'
    );
    check(
      /the document now MISQUOTES it/.test(out),
      'and prints the phrase it went looking for, so the fix is one edit rather than a hunt'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------- arm 9: the same claim, a different style
//
// ARM 9 IS ARM 6 ONE GENERALISATION OUT, and it exists because arm 6's fix was
// not enough. Unanchoring the parse from line position left it anchored to
// QUOTE STYLE — `epic/KAN-59` measured that `src/cli.ts` already holds 63
// double-quoted string literals and `src/mcp.ts` uses double-quoted `name:`
// keys eleven times, with nothing enforcing either style. So this arm writes
// the command the way neither of us happened to write it: double quotes, extra
// spacing, its own line. A check that only sees the styles its author used is
// a check that expires at the next reformat.
console.log('\narm 9  SAME CLAIM, DIFFERENT STYLE — `name:   "attach",` with double quotes');
{
  const dir = stage();
  if (
    edit(dir, CLI, (t) =>
      t.replace(/export const COMMANDS: CommandSpec\[\] = \[\n/, (m) => `${m}  { name:   "attach" },\n`)
    )
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}no CLI command is named 'attach'/.test(out),
      'and names it, exactly as it does for the single-quoted spelling in arm 6'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- §6 the tree is still clean
//
// A BEFORE/AFTER COMPARISON, NOT `git status`. The first draft of this section
// asked git whether the two files were modified, and it went red on the very
// run that introduced them — because the ticket's own edit was sitting
// uncommitted in the working tree. That check conflates "this drive wrote to
// the tree" with "the tree has uncommitted work in it", which are different
// claims and only the first is this drive's to make. Whether the repository is
// clean is the author's business; whether THIS SCRIPT dirtied it is what
// section 6 exists to answer, and a digest taken before the arms ran is what
// answers it.
//
// AND IT IS NOT A CHECK THAT CANNOT FAIL, which is worth saying because as the
// arms stand today it will always pass — they write only into a temp tree. What
// it guards is the next edit, not this one: "just mutate the file and restore
// it afterwards" is the obvious simplification of this whole staging dance, and
// the moment somebody takes it, a run interrupted between mutation and restore
// leaves a deliberately broken contract document in the repository. Section 6
// is what turns that from a silent hazard into a red check.
console.log('\n§6  this drive did not write to the working tree');
{
  for (const [rel, before] of Object.entries(digestsBefore)) {
    const after = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    check(after === before, `${rel} is byte-for-byte what it was before arm 0`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} problem(s) above.`);
} else {
  console.log('OK — the guard goes red on all nine mutations, and vacuity is distinguishable from a finding.');
}

process.exit(failures ? 1 : 0);
