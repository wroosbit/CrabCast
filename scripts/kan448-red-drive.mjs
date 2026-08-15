#!/usr/bin/env node
// KAN-448 RED DRIVE — does §1 of `verify-cli-refusal.mjs` tell a machine that
// moved from a renderer that broke, or does it only now have two words for the
// same red?
//
// WHAT FAILURE THIS WOULD CATCH: a §1 that reports GATE FAULT for everything it
// used to report FAIL for. That is the comfortable direction and it is worse
// than the defect it replaces — the old wording accused the renderer of a fault
// nobody had, and the lazy fix excuses a renderer that really is broken. Both
// look identical from outside: a well-formed answer to a question nobody asked.
//
// SO EVERY ARM HERE IS A PAIR OF CLAIMS, never one. An arm asserts what the run
// SAID and what it did NOT say — a gate fault arm requires the absence of a
// §1 check failure, and a defect arm requires the absence of a gate fault. An
// arm that only required its own words would pass against a script that emitted
// both every time.
//
// ---------------------------------------------------------------------------
// THE FIVE CONDITIONS, and why the fourth is the one worth the runtime
// ---------------------------------------------------------------------------
//
//   0. CONTROL      the unmutated build. Green, and no gate fault. Without it
//                   every arm below measures the runner: a staged layout that
//                   was simply broken would redden all four and read as four
//                   successes.
//
//   1. THE MACHINE  the machine SNAPSHOT carries a figure that cannot be the
//                   same on two consecutive readings — a counter added to
//                   `load1` in `readMachineFacts`. The retry must lose all five
//                   times, and the run must be red saying GATE FAULT, without a
//                   single §1 check failure and without the sentence that
//                   accused the renderer.
//
//   2. THE RENDERER the refusal's error text — which is where a LIVE
//                   derivation travels — indented two spaces. A real defect,
//                   and the run must say FAIL. This is the arm the lazy fix
//                   fails, because the retry exhausts here too and a fix that
//                   keyed on exhaustion alone would call it the machine's
//                   fault.
//
//   3. A LINE GONE  one derivation line dropped out of that error text. The
//                   literal defect §1's own wording names, and it must still be
//                   a FAIL rather than a gate fault.
//
//   4. ONLY DIGITS  every digit in that error text mangled and nothing else. §1
//                   CANNOT see this and calls it the machine — that is the
//                   stated cost of classifying by normalised figures, and this
//                   arm exists to DEMONSTRATE the cost rather than describe it.
//                   §2 catches it in the same run, which is the other half of
//                   the claim, so this arm requires BOTH: a gate fault from §1
//                   and a check failure from §2. If §2 ever stopped covering
//                   it, this arm goes red and the trade stops being honest.
//
//   5. THE PIN       the derivation made to carry a live-selected binding word.
//                   §1's classifier is only sound while a difference between
//                   two readings is a FIGURE and never a WORD, and that is a
//                   property of the FIXTURE rather than of derivations
//                   (epic/KAN-59, on review). §1 asserts the pin; this arm is
//                   what shows the assertion can fail.
//
// ⚠ ARMS 2-4 MUTATE `failure()` AND NOT `verbatim()`, AND THAT IS THIS DRIVE'S
// OWN FINDING rather than a design choice made up front — see
// FAILURE_PRINTS_ERROR below. Mutating the obvious one left §1 green three
// times running.
//
// EVERY MUTATION'S ANCHOR MUST OCCUR EXACTLY ONCE, which `makeMutator` enforces
// and reports through this script's own verdict. An anchor matching zero times
// applies nothing, and an unapplied mutation reads exactly like a clean pass.
//
// THE WORKING TREE IS NEVER TOUCHED: every arm runs `verify-cli-refusal.mjs`
// against a COPY of `dist/`, which that script accepts as its first argument.
//
// This spawns real daemons through the proof it drives, in scratch data dirs
// under a scratch $HOME, exactly as that proof does. It needs `npm run build`
// first. No network.
//
// Usage:
//   npm run build
//   node scripts/kan448-red-drive.mjs [distDir]

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const proof = path.join(scriptDir, 'verify-cli-refusal.mjs');

if (!fs.existsSync(path.join(distDir, 'cli.js'))) {
  console.error(`no build at ${distDir} — run \`npm run build\` first.`);
  process.exit(1);
}

const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

let failures = 0;
const report = {
  pass: (label, detail) => {
    console.log(`  PASS  ${label}`);
    if (detail) console.log(`        ${detail}`);
  },
  fail: (label, detail) => {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    failures += 1;
  }
};
const check = (ok, claim) => {
  (ok ? report.pass : report.fail)(claim);
  return ok;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan448-drive-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// A MUTANT BUILD OUTSIDE THE REPOSITORY CANNOT RESOLVE ITS DEPENDENCIES, and
// the way it fails is the reason this line has a comment. `dist/herdr.js`
// imports `node-pty`, so a copy of `dist/` under /tmp dies at module load with
// ERR_MODULE_NOT_FOUND — before the proof prints a single line. The first run
// of this drive did exactly that on all four arms, and three of the arm checks
// PASSED anyway, because "the run is red" is satisfied by a process that never
// started. `mutation.mjs` says every section spawning a mutant owes a
// precondition that it really ran; `expectRan` below is this file's, and this
// symlink is what stops it firing for a reason nobody would have guessed.
fs.symlinkSync(path.join(scriptDir, '..', 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const { mutate, mutationsSkipped } = makeMutator({ distDir, scratch, report });

/**
 * The proof's output, split at its own section banners.
 *
 * ATTRIBUTION BY SECTION IS LOAD-BEARING HERE, not tidiness. The first draft of
 * this file picked §1's failures out of the whole transcript by matching `FAIL`
 * lines containing the word "derivation" — which is also how §2 words two of
 * its own claims. Arm 4 requires §1 to stay quiet while §2 goes red, and that
 * detector could never have seen the difference: it would have read §2's red as
 * §1's and reported the arm failing for a reason that was not true.
 */
function sectionsOf(out) {
  const lines = out.split('\n');
  const map = new Map();
  let current = '(preamble)';
  map.set(current, []);
  for (let i = 0; i < lines.length; i++) {
    if (/^={70,}$/.test(lines[i]) && /^={70,}$/.test(lines[i + 2] ?? '')) {
      current = (lines[i + 1] ?? '').trim();
      if (!map.has(current)) map.set(current, []);
      i += 2;
      continue;
    }
    map.get(current).push(lines[i]);
  }
  return map;
}

/** Run the proof against one build and hand back everything it said. */
function runProof(against) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [proof, against], {
    encoding: 'utf8',
    timeout: 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const map = sectionsOf(out);
  const bodyOf = (re) => (([...map].find(([t]) => re.test(t)) ?? [null, []])[1] ?? []).join('\n');
  const failLines = (text) => text.split('\n').filter((l) => /^\s*FAIL\s/.test(l));
  const gateLines = (text) => text.split('\n').filter((l) => /^\s*GATE FAULT\s/.test(l));
  const one = bodyOf(/^1\. REFUSAL/);
  const two = bodyOf(/^2\. VERBATIM/);
  return {
    code: run.status,
    out,
    seconds: Math.round((Date.now() - started) / 1000),
    /** Present so an arm can say the split found the sections at all. */
    sawSection1: one !== '',
    sawSection2: two !== '',
    section1Failures: failLines(one),
    section1GateFaults: gateLines(one),
    section2Failures: failLines(two),
    failures: failLines(out),
    gateFaults: gateLines(out),
    verdict: (out.match(/^(ALL SECTIONS PASSED|.*CHECK\(S\) FAILED.*|.*GATE FAULT\(S\).*)$/m) ?? [''])[0]
  };
}

const summarise = (r) => {
  console.log(`   exit ${r.code}, ${r.seconds}s`);
  console.log(`   verdict:          ${r.verdict}`);
  console.log(`   §1 FAIL / GATE:   ${r.section1Failures.length} / ${r.section1GateFaults.length}`);
  console.log(`   §2 FAIL:          ${r.section2Failures.length}`);
  console.log(`   whole run:        ${r.failures.length} FAIL, ${r.gateFaults.length} GATE FAULT`);
  for (const l of [...r.gateFaults, ...r.failures]) console.log(`     ${l.trim().slice(0, 150)}`);
};

/**
 * THE PRECONDITION EVERY ARM OWES: the proof really ran.
 *
 * Without it, "the run is red" is satisfied by a mutant that died at module
 * load, and an arm reads as a success having observed nothing. That is not
 * hypothetical here — see the symlink above.
 */
const expectRan = (r) => {
  const ran = check(
    r.sawSection1 && r.sawSection2,
    'the proof ran far enough to print §1 and §2 — so what follows is a measurement'
  );
  if (!ran) {
    console.log('   what it printed instead:');
    console.log(r.out.split('\n').slice(0, 12).map((l) => `     ${l}`).join('\n'));
  }
  return ran;
};

/**
 * THE LINE THAT PUTS A REFUSAL'S ERROR TEXT ON STDOUT, and it is the one every
 * defect arm below mutates.
 *
 * ⚠ IT IS NOT THE OBVIOUS ONE, and the first version of this file got it wrong
 * in the way that reads as a pass. `renderActivate` prints a derivation two
 * ways and chooses: a capacity refusal's `error` ALREADY contains it, so
 * `alreadyInError` is true and `verbatim('derivation:', …)` is skipped. Arms 2,
 * 3 and 4 broke `verbatim` and §1 stayed GREEN through all three — the mutation
 * applied exactly once, the build really changed, and it changed a branch a
 * live refusal never walks. §2 went red and §1 said nothing, which is the whole
 * finding: SAME RENDERER, DIFFERENT BRANCH.
 *
 * That is why §2 now drives the `alreadyInError` branch too, and why these
 * arms mutate `failure()` instead.
 */
const FAILURE_PRINTS_ERROR =
  'error ? `\\n${error}` : `${INDENT}(the daemon reported failure without an error message)`';

// THE SENTENCE THE OLD CODE PRODUCED for a machine that moved. It is what
// `task/KAN-431` was handed, and arm 1 requires it to be absent — a gate fault
// that ALSO printed this would have relabelled nothing.
const ACCUSATION = 'no line of the derivation is missing from stdout:';

// ---------------------------------------------------------------- 0. control

rule('0. CONTROL — the unmutated build');

const control = runProof(distDir);
summarise(control);
check(control.code === 0, 'the proof passes against an unmutated build');
check(control.gateFaults.length === 0, 'and reports no gate fault, so every arm below is measuring its mutation');
check(
  /ALL SECTIONS PASSED/.test(control.out),
  'the verdict line reads ALL SECTIONS PASSED'
);
// A detector that found no sections would attribute nothing to either, and
// every "§1 stayed quiet" claim below would be satisfied by an empty string.
check(
  control.sawSection1 && control.sawSection2,
  'and the transcript really did split into §1 and §2 — every claim below is attributed by section'
);

// ------------------------------------------------------------- 1. the machine

rule('1. THE MACHINE MOVED — a snapshot figure that cannot be the same on two readings');

machine: {
  // MUTATE THE MEASUREMENT, NOT ITS FORMATTING, and the difference is a defect
  // this arm shipped with until `epic/KAN-59` reproduced it and got a different
  // exit code (PR #119).
  //
  // The first version replaced `load average ${m.load1.toFixed(2)}` with
  // `${Date.now()}` — inside `describeCapacity`, which made that function
  // IMPURE. A capacity refusal renders it TWICE from one snapshot:
  // `capacityRefusal` builds `error` with it, and the router separately takes
  // `describeCapacity(capacity)` for the `derivation` field. Unmutated those
  // are two pure renderings of one reading and are identical, which is what §3
  // asserts. Mutated, they agreed only when both landed in the same
  // millisecond — so §3 failed on the reviewer's machine and not on mine, and
  // `DRIVE_EXIT` was 1 there and 0 here on the same commit.
  //
  // ⚠ THAT IS THIS TICKET'S OWN SENTENCE, INSIDE THE ARTEFACT BUILT TO PROVE
  // IT: an assertion whose subject is not stable. Disclosing it was on offer
  // and is not what it deserved.
  //
  // The fix moves the nonce into the SNAPSHOT — one `readMachineFacts()` per
  // `readCapacity()`, so both renderings of one response see one value and §3
  // is untouched — and makes it a COUNTER rather than a clock, so consecutive
  // snapshots cannot collide at all rather than colliding rarely. It stays a
  // FIGURE, which is the point: it moves between the two invocations exactly as
  // a load average does and reconciles under normalisation exactly as one does.
  // Anything that changed a WORD would be arm 2's condition wearing arm 1's
  // clothes. The added quantity is under one core, so no other section's
  // arithmetic changes regime.
  const mutant = mutate(
    'machine-moves',
    'capacity.js',
    'load1: os.loadavg()[0],',
    'load1: os.loadavg()[0] + ((globalThis.__kan448 = ((globalThis.__kan448 ?? 0) + 1) % 100) / 100),'
  );
  if (!mutant) break machine;

  const r = runProof(mutant);
  summarise(r);
  if (!expectRan(r)) break machine;
  check(
    /attempts exhausted, giving up/.test(r.out),
    'the retry ran out and SAID SO — the run that gives up is no longer the silent one'
  );
  check(r.section1GateFaults.length > 0, 'the exhaustion is reported as a GATE FAULT, in §1');
  check(
    r.section1Failures.length === 0,
    'and NOT as a check failure about the derivation — the renderer is not accused'
  );
  check(!r.out.includes(ACCUSATION), `the old accusation is absent: ${JSON.stringify(ACCUSATION)}`);
  check(r.code !== 0, 'the run is still RED — a gate that could not put its question has not passed');
  // THE VERDICT LINE IS A WHOLE-RUN STATEMENT, so this reads the section
  // counters beside it rather than the sentence alone. The sentence's shape
  // depends on the mutation's blast radius, and an arm that asserted only the
  // sentence would go red for a failure in a section it never aimed at — which
  // is what happened when this arm's mutation reached §3.
  check(
    /GATE FAULT\(S\)/.test(r.verdict) && r.gateFaults.length === 1 && r.failures.length === 0,
    'and the verdict line says which of the two happened — one gate fault, no check failure,\n' +
    '        anywhere in the run'
  );
}

// ------------------------------------------------------------ 2. the renderer

rule("2. THE RENDERER BROKE — the refusal's error text indented two spaces");

indented: {
  const mutant = mutate(
    'renderer-indents',
    'cli.js',
    FAILURE_PRINTS_ERROR,
    "error ? '\\n' + error.split('\\n').map((l) => '  ' + l).join('\\n') : " +
      '`${INDENT}(the daemon reported failure without an error message)`'
  );
  if (!mutant) break indented;

  const r = runProof(mutant);
  summarise(r);
  if (!expectRan(r)) break indented;
  check(r.section1Failures.length > 0, '§1 reports a check FAILURE — a real defect is still a verdict');
  check(
    r.gateFaults.length === 0,
    'and NO gate fault anywhere: exhausting the retry is not on its own enough to blame the machine'
  );
  check(r.code !== 0, 'the run is red');
  check(
    /CHECK\(S\) FAILED/.test(r.out),
    'the verdict line names check failures rather than gate faults'
  );
}

// -------------------------------------------------------------- 3. a line gone

rule('3. A LINE GONE — a derivation line dropped out of the error text');

dropped: {
  const mutant = mutate(
    'renderer-drops-a-line',
    'cli.js',
    FAILURE_PRINTS_ERROR,
    "error ? '\\n' + error.split('\\n').filter((l, i) => i !== 2).join('\\n') : " +
      '`${INDENT}(the daemon reported failure without an error message)`'
  );
  if (!mutant) break dropped;

  const r = runProof(mutant);
  summarise(r);
  if (!expectRan(r)) break dropped;
  check(r.section1Failures.length > 0, 'a missing line is a check FAILURE in §1 — the defect its own wording names');
  check(r.gateFaults.length === 0, 'and not a gate fault');
  check(r.code !== 0, 'the run is red');
}

// -------------------------------------------------------------- 4. only digits

rule('4. ONLY DIGITS — the cost of classifying by normalised figures, demonstrated');

digits: {
  const mutant = mutate(
    'renderer-mangles-digits',
    'cli.js',
    FAILURE_PRINTS_ERROR,
    "error ? '\\n' + error.replace(/[0-9]/g, '9') : " +
      '`${INDENT}(the daemon reported failure without an error message)`'
  );
  if (!mutant) break digits;

  const r = runProof(mutant);
  summarise(r);
  if (!expectRan(r)) break digits;
  // The honest half: §1 gets this WRONG, and the header says so.
  check(
    r.section1GateFaults.length > 0 && r.section1Failures.length === 0,
    '§1 calls this the machine — the stated cost, demonstrated rather than described:\n' +
    '        a defect that moves only digits is indistinguishable from a load average moving'
  );
  // The half that makes the cost survivable, and it is checked rather than
  // asserted in prose. If §2 ever stopped covering digit fidelity, this goes red.
  check(
    r.section2Failures.length > 0,
    '§2 catches it in the same run, byte for byte, against a derivation nothing can move'
  );
  check(r.code !== 0, 'so the run is red either way, and by §2\'s words');
}

// --------------------------------------------- 5. the classifier's precondition

rule("5. THE PRECONDITION — a derivation that DOES carry a live-selected word");

precondition: {
  // `epic/KAN-59` found on review that `withoutFigures` can only classify while
  // no WORD in the derivation is chosen by comparing live measurements, and that
  // §1's fixture pins those words rather than the code guaranteeing it. §1 now
  // asserts the pin. THIS ARM IS WHAT SHOWS THAT ASSERTION CAN FAIL.
  //
  // The tie rule is what pins `bound by cap` at a zero cap: `headroomByCap` is
  // 0, every other term is `Math.max(0, …)`, so the first branch always wins.
  // Disabling that branch makes `countingBoundBy` fall through to
  // `cpuSideName`/'memory' — a word selected by which instrument answered and by
  // which term is smaller, which is precisely the world the precondition guards
  // against. The refusal itself is untouched: cap 0 still gives headroom 0.
  const mutant = mutate(
    'binding-word-goes-live',
    'capacity.js',
    'headroomByCap <= cpuSideTerm && headroomByCap <= headroomByMemory',
    'false && headroomByCap <= headroomByMemory'
  );
  if (!mutant) break precondition;

  const r = runProof(mutant);
  summarise(r);
  if (!expectRan(r)) break precondition;
  check(
    r.section1Failures.some((l) => /PRECONDITION for the classifier/.test(l)),
    'the precondition goes RED by name when the derivation starts carrying a live-selected word'
  );
  check(r.code !== 0, 'and the run is red');
}

// -------------------------------------------------------------------- verdict

// A skipped mutation has already been counted as a failure by the helper; this
// says WHICH, so a run that lost an arm to anchor drift cannot be read as a run
// in which that arm passed.
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`\nmutations that did not apply, so their arms never ran: ${skipped.join(', ')}`);
}

rule(failures === 0 ? 'ALL ARMS BEHAVED AS CLAIMED' : `${failures} ARM CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
