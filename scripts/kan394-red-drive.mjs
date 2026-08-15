#!/usr/bin/env node
// KAN-394 RED DRIVE — does verify-pty-consumer-named.mjs actually go red, and
// does it go red for the reason it claims?
//
// WHAT FAILURE THIS WOULD CATCH: a guard that reports the tree clean whatever
// the tree says. `verify-pty-consumer-named.mjs` is a handful of substring and
// membership tests over two text files, which is exactly the shape that passes
// forever if a regex is subtly wrong — and its output looks identical either
// way. Eleven arms mutate the four files the proof reads and require it to go
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
// AND ARMS 10-11 ARE THE FOURTH ROUND, WHICH IS DIFFERENT IN KIND (KAN-431).
// Arm 9's fix widened the character class to admit a BACKTICK and lowercased
// the captured name, so a backtick-quoted and a capitalised command name are
// both caught. NEITHER CHARACTER WAS EXERCISED BY ANY ARM: arm 9 writes the
// command with DOUBLE QUOTES only, so the obvious tidy — narrowing the class
// back to two quote characters, since backticks appear nowhere in `src/cli.ts`
// — left arm 9 green and the backtick case silently unseen. Dropping the
// `.toLowerCase()` did the same to capitalisation. Both mutations already went
// red when `epic/KAN-59` ran them by hand on the pull request for KAN-394; a
// run nobody repeats is not evidence, and moving them into the tree is the
// whole of what these two arms are for.
//
// THE CONTROL ON ARMS 10 AND 11 IS THE PART THAT MATTERS, and it is a section
// of its own below rather than an arm. Arms 10 and 11 show the proof goes red
// when the two shapes reach `src/cli.ts`. They do NOT show that the two
// characters in the parse are WHY — so the control tidies each character out of
// the PROOF itself and re-drives all three spellings underneath it, requiring
// each tidy to disable exactly one arm while leaving arm 9 and the other arm
// alone. Without that, "these two characters are load-bearing" is an argument
// rather than a result, and an argument is what this ticket was filed to
// retire.
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
// layout were wrong, every arm would go red and the drive would read as eleven
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

/**
 * Every mutated file as it stood BEFORE any arm ran — see section 6.
 *
 * PROOF IS IN THIS LIST SINCE KAN-431, and it was not before, because until the
 * control on arms 10 and 11 nothing in this drive mutated the proof itself. The
 * control tidies characters out of a STAGED COPY of it; this is what says so
 * against the tree rather than in a comment.
 */
const digestsBefore = Object.fromEntries(
  [PROOF, SRC, DOC, CLI, PARITY].map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

/**
 * THE THREE SPELLINGS OF ONE MUTATION — an `attach` command added to the
 * COMMANDS table — held in ONE PLACE because the control below re-drives all
 * three under a tidied parse, and a second copy of the text an assertion is
 * about is precisely what KAN-245 is about. Arms 9, 10 and 11 each drive one.
 *
 * The backtick and the capital are written as literal characters inside quoted
 * strings rather than built from escapes or char codes, so a reader can SEE the
 * shape each arm is about. That is the whole subject of these two arms.
 */
const ATTACH_ANCHOR = 'export const COMMANDS: CommandSpec[] = [\n';
const SPELLINGS = {
  doubleQuoted: '  { name:   "attach" },\n',
  backtick: '  { name: `attach` },\n',
  capitalised: "  { name: 'Attach' },\n",
};

/**
 * KAN-431 acceptance criterion 2. `edit` below already refuses a mutation that
 * changed NOTHING, and this is a different claim: an anchor occurring TWICE
 * means the replace hit the first and left the second, so the file the proof
 * reads is not the file the arm's name describes. AN UNAPPLIED — OR
 * HALF-APPLIED — MUTATION READS EXACTLY LIKE A CLEAN PASS, which is the one
 * outcome a red drive must never be able to produce.
 */
function anchoredExactlyOnce(dir, rel, anchor, label) {
  const n = fs.readFileSync(path.join(dir, rel), 'utf8').split(anchor).length - 1;
  check(n === 1, `${label}: its anchor occurs exactly once in ${rel}`, `found ${n}`);
  return n === 1;
}

/** And that the mutation actually left the spelling this arm is named for. */
function nowContains(dir, rel, needle, label) {
  const ok = fs.readFileSync(path.join(dir, rel), 'utf8').includes(needle);
  check(ok, `${label}: the staged ${rel} now literally holds the spelling this arm is about`);
  return ok;
}

/** Insert one spelling of the `attach` command, anchor asserted exactly once. */
function addAttach(dir, spelling, label) {
  if (!anchoredExactlyOnce(dir, CLI, ATTACH_ANCHOR, label)) return false;
  if (!edit(dir, CLI, (t) => t.replace(ATTACH_ANCHOR, ATTACH_ANCHOR + spelling))) return false;
  return nowContains(dir, CLI, spelling.trim(), label);
}

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
  if (addAttach(dir, SPELLINGS.doubleQuoted, 'arm 9')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}no CLI command is named 'attach'/.test(out),
      'and names it, exactly as it does for the single-quoted spelling in arm 6'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------- arm 10: the same claim, in backticks
//
// ARM 10 IS THE BACKTICK IN THE CHARACTER CLASS, ARMED (KAN-431). It went into
// the parse in response to arm 9's review finding and no arm exercised it, so
// narrowing the class back to the two quote characters would have left arm 9
// green and this shape unseen. `epic/KAN-59` ran exactly this mutation against
// `82063a4` as its A4 and reported `exit 1 · 21 · 2` on the pull request for
// KAN-394. THAT RUN IS NOT EVIDENCE ANY MORE — a comment on a merged pull
// request is not the repository, and this arm is that run moved into the tree.
//
// It requires the SAME RED AS ARM 6, not merely a non-zero exit: a red is worth
// having only when it names the thing that broke, and this drive's own header
// says an arm going red by the wrong route is a failure of the drive.
console.log('\narm 10  SAME CLAIM, IN BACKTICKS — `name: `attach`,`');
{
  const dir = stage();
  if (addAttach(dir, SPELLINGS.backtick, 'arm 10')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}no CLI command is named 'attach'/.test(out),
      "and names the command whose existence falsifies the section's headline sentence"
    );
    check(
      /the command now EXISTS and the section's headline sentence is false/.test(out),
      'and says what that does to the document — the same red arm 6 requires'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------- arm 11: the same claim, capitalised
//
// ARM 11 IS THE `.toLowerCase()`, ARMED. Same history as arm 10 and the same
// standing: `epic/KAN-59`'s A5, `exit 1 · 21 · 2` against `82063a4`, reported on
// a pull request and nowhere else until now.
//
// NOTE WHAT THIS ARM DOES NOT CLAIM. It shows the parse still finds a command
// whose name is spelled with a capital; it says nothing about whether a
// capitalised command name would WORK, and that is not this proof's business —
// §5 asserts that the document's sentence about `src/cli.ts` is true, and a
// command the CLI would reject is still a command the sentence would be wrong
// about.
console.log("\narm 11  SAME CLAIM, CAPITALISED — `name: 'Attach',`");
{
  const dir = stage();
  if (addAttach(dir, SPELLINGS.capitalised, 'arm 11')) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      /FAIL {2}no CLI command is named 'attach'/.test(out),
      "and names the command whose existence falsifies the section's headline sentence"
    );
    check(
      /the command now EXISTS and the section's headline sentence is false/.test(out),
      'and says what that does to the document — the same red arm 6 requires'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------- CONTROL ON ARMS 10 AND 11 — each character is load-bearing
//
// WHY THIS IS A CONTROL AND NOT AN ARM. Every arm above mutates a file the
// proof READS and requires the proof to notice. This mutates the PROOF, and
// requires it to STOP noticing — which is the only way to show that a character
// in the parse is doing work rather than sitting there looking careful.
//
// THE CLAIM IT DRIVES is KAN-431's, and until this section it was an argument:
// "narrowing the character class back to the two quote characters leaves arm 9
// green and the backtick case silently unseen." A tidy-up author has every
// reason to make that edit — backticks appear nowhere in `src/cli.ts` — and
// nothing would have told them.
//
// ⚠ THE DISCRIMINATING HALF IS WHAT MAKES IT WORTH RUNNING. It is not enough
// that a tidy breaks something: a tidy that reddened every arm would show only
// that the proof is brittle, and one that reddened nothing would show the
// characters are decoration. Each tidy must disable EXACTLY ONE of the two new
// arms and leave arm 9 AND the other new arm alone. That is four probes per
// tidy, and the first of them is the one a reader should look at hardest —
// ON AN UNMUTATED `src/cli.ts` THE TIDIED PROOF STILL EXITS 0. That is why the
// tidy looks safe, and it is the entire reason this ticket exists.
//
// IF THE FIRST PROBE OF EITHER TIDY GOES RED, the premise is wrong and the
// finding is that, not a broken drive — say so rather than adjusting until it
// passes.
console.log('\nCONTROL ON ARMS 10 AND 11 — tidy each character out of the PROOF, and see what stops firing');

/**
 * Both characters as they appear in §5, and the tidy a later author would
 * plausibly make to each. Read as literal strings — no regex, so there is no
 * escaping between this file and the characters it is about. `epic/KAN-59` had
 * a check on exactly this question return the wrong answer through an escaping
 * error, in the reassuring direction, so the form matters here.
 */
const TIDIES = [
  {
    label: 'narrow the character class back to the two quote characters',
    from: "['\"`]",
    to: "['\"]",
    occurrences: 2,
    disables: 'backtick',
    disabledArm: 'arm 10',
    survives: 'capitalised',
    survivingArm: 'arm 11',
  },
  {
    label: 'drop the .toLowerCase() from the captured name',
    from: 'm[1].toLowerCase()',
    to: 'm[1]',
    occurrences: 1,
    disables: 'capitalised',
    disabledArm: 'arm 11',
    survives: 'backtick',
    survivingArm: 'arm 10',
  },
];

/** A staged tree whose PROOF has had one character tidied out of §5. */
function stageTidied(tidy) {
  const dir = stage();
  const text = fs.readFileSync(path.join(dir, PROOF), 'utf8');
  const n = text.split(tidy.from).length - 1;
  if (n !== tidy.occurrences) {
    check(false, `the tidy's target occurs ${tidy.occurrences}x in ${PROOF}`, `found ${n} — §5 was reworded`);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(dir, PROOF), text.split(tidy.from).join(tidy.to));
  const after = fs.readFileSync(path.join(dir, PROOF), 'utf8');
  if (after.split(tidy.from).length - 1 !== 0) {
    check(false, 'the tidy removed every occurrence of its target', 'some survived');
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return dir;
}

for (const tidy of TIDIES) {
  console.log(`\n  TIDY — ${tidy.label}`);

  // (a) the reason nobody would notice: on today's tree the tidy changes nothing.
  {
    const dir = stageTidied(tidy);
    if (dir) {
      const { code, out } = runProof(dir);
      check(code === 0, 'the tidied proof still exits 0 on an UNMUTATED src/cli.ts', `exit ${code}`);
      check(
        /OK — the pty triple is still uncovered/.test(out),
        'and still prints its OK verdict — which is why the tidy looks safe'
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // (b) arm 9 is untouched by the tidy — the claim's first half.
  {
    const dir = stageTidied(tidy);
    if (dir && addAttach(dir, SPELLINGS.doubleQuoted, `${tidy.disabledArm} control, arm 9 spelling`)) {
      const { code, out } = runProof(dir);
      check(code !== 0, "arm 9's double-quoted spelling STILL goes red under the tidy", `exit ${code}`);
      check(
        /FAIL {2}no CLI command is named 'attach'/.test(out),
        'and still names the command — so nothing about arm 9 would have warned anybody'
      );
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  // (c) and the arm the character carries goes SILENT — the claim's second half.
  {
    const dir = stageTidied(tidy);
    if (dir && addAttach(dir, SPELLINGS[tidy.disables], `${tidy.disabledArm} control, ${tidy.disables} spelling`)) {
      const { code, out } = runProof(dir);
      check(
        code === 0,
        `⚠ the ${tidy.disables} spelling is now UNSEEN — the tidied proof exits 0 with the command present`,
        `exit ${code}`
      );
      check(
        /PASS {2}no CLI command is named 'attach'/.test(out),
        `and reports the claim INTACT — this is ${tidy.disabledArm} going silent, not going red`
      );
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }

  // (d) while the OTHER character still carries its own arm. Without this the
  //     section would show the proof is brittle rather than that the two
  //     characters are independently load-bearing.
  {
    const dir = stageTidied(tidy);
    if (dir && addAttach(dir, SPELLINGS[tidy.survives], `${tidy.survivingArm} control, ${tidy.survives} spelling`)) {
      const { code } = runProof(dir);
      check(
        code !== 0,
        `while the ${tidy.survives} spelling STILL goes red — ${tidy.survivingArm} is carried by the other character`,
        `exit ${code}`
      );
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
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
  console.log(
    'OK — the guard goes red on all eleven mutations, vacuity is distinguishable from a finding, and\n' +
      '     each of §5\'s two contested characters is independently load-bearing.'
  );
}

process.exit(failures ? 1 : 0);
