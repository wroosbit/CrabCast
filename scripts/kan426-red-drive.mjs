#!/usr/bin/env node
// KAN-426 RED DRIVE — an event that does not arrive must be a NAMED, COUNTED
// FAIL that names WHICH event, and it must not take the rest of the file with
// it.
//
// WHAT FAILURE THIS WOULD CATCH: `verify-event-durability.mjs` reporting an
// absent event as an exception from a display path instead of as a verdict.
// That was the shipped behaviour: `show(`socket ${name}:`, real.events.<half>[name])`
// handed `undefined` to a formatter whose body was
// `JSON.stringify(value, null, 2).replace(/^/gm, '     ')`, and `JSON.stringify`
// answers `undefined` — the value, not a string — so `.replace` threw. The
// observed result was
// `TypeError: Cannot read properties of undefined (reading 'replace')`, which is
// true of ANY absent event, names none of them, and kills every section below.
// It would also catch the regression this fix could plausibly acquire later: a
// FAIL message that names a HARD-CODED event rather than the one that is
// actually missing. Arms 2 and 3 make different events absent and require the
// verdict to name the right one AND not the others, so a hard-coded message
// goes red here.
//
// ⚠ THE WORKING TREE IS NEVER TOUCHED. Every arm runs the proof from a COPY in
// a temp directory, laid out in the same shape so the proof's own
// `..`-relative reads (`src/router.ts`, `docs/event-contract.md`,
// `node_modules`) resolve. In-place mutation with a restore is worse: an
// interrupted run would leave the repository holding a deliberately broken
// proof. §5 asserts `git status` is clean at the end anyway, because "I did not
// intend to write to the tree" is a claim and not a measurement.
//
// THE CONTROL IS ARM 0 AND IT IS NOT A FORMALITY. Arms 1-4 assert that things
// are ABSENT from the output (no TypeError; no mention of the events that are
// still fine). An absence proves nothing unless the same instrument is shown
// printing those strings when they are true — so arm 0 runs the unmutated copy
// and requires the section rules, the VERDICT block and exit 0. If the staging
// were wrong, every arm would go red and this drive would read as four
// successes.
//
// EVERY MUTATION ASSERTS IT APPLIED, WITH AN EXACT ANCHOR COUNT. An unapplied
// mutation reads exactly like a clean pass, which is the near-miss `epic/KAN-59`
// reported on this ticket. `edit()` requires the anchor to occur EXACTLY ONCE
// and fails the arm loudly otherwise, so a later rename of any anchored text
// turns this drive red rather than quietly voiding an arm.
//
// WHAT THIS DRIVE DOES NOT COVER: it does not reproduce the original crash's
// CAUSE. Every absent event here is INJECTED by replacing an `eventFor(...)`
// read with `undefined` — this drive supplies its own input, so it tests what
// the proof SAYS about an absent event and says nothing about how often, or
// whether, an event really goes missing. That question is KAN-445, linked
// `Relates` to KAN-426. Nothing here should be read as evidence about the race.
//
// Runs the full proof four times; each spawns real daemons, so allow a couple
// of minutes. Requires `npm run build` first.
//
// Usage:
//   npm run build
//   node scripts/kan426-red-drive.mjs

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');

const PROOF = path.join('scripts', 'verify-event-durability.mjs');
const MUTATOR = path.join('scripts', 'mutation.mjs');
const ROUTER = path.join('src', 'router.ts');
const DOC = path.join('docs', 'event-contract.md');
const STAGED = [PROOF, MUTATOR, ROUTER, DOC];

const distDir = path.join(repoRoot, 'dist');

let failures = 0;

/**
 * Every file this drive reads, as it stood BEFORE any arm ran — see §5.
 *
 * §5 compares against THIS rather than asking `git status`, and the difference
 * is not stylistic: `git status` cannot tell a file this drive wrote from a file
 * the author has not committed yet, so it reports the author's own work in
 * progress as a containment failure. It did exactly that on this drive's first
 * run. A before/after comparison answers the question actually being asked —
 * "did I write to the tree?" — and answers it identically whether the checkout
 * is clean or not.
 */
const contentsBefore = Object.fromEntries(
  STAGED.map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// A setup guard, not a verdict: with no build there is nothing to drive, and
// reporting that as a failed arm would be a lie about the proof.
if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(
    `REFUSING TO RUN. ${distDir}/daemon.js does not exist, so every arm would fail for a\n` +
    'reason that is about this checkout rather than about the proof. Run `npm run build` first.'
  );
  process.exit(2);
}

/** A fresh temp tree holding just the files the proof reads. */
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan426-'));
  for (const rel of STAGED) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), dest);
  }
  // The proof symlinks `<repoRoot>/node_modules` into its own scratch. A
  // dangling link there would fail the daemon for a staging reason, so the
  // staged root points at the real one.
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Run the staged proof against the REAL dist. Returns { code, out }. */
function runProof(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROOF), distDir], {
    encoding: 'utf8',
    timeout: 300_000
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Apply one textual edit to a staged file, requiring the anchor to occur
 * EXACTLY ONCE.
 *
 * The count is the point. A mutation that did not apply produces a clean pass
 * indistinguishable from a fix that works, and a mutation that applied TWICE is
 * measuring something other than what the arm describes. Either one is a failed
 * arm here, not a silent skip.
 */
function edit(dir, rel, find, replace) {
  const p = path.join(dir, rel);
  const before = fs.readFileSync(p, 'utf8');
  const hits = before.split(find).length - 1;
  if (hits !== 1) {
    console.log(
      `  FAIL  the anchor occurs ${hits}x in ${rel}, expected exactly 1 — THE ARM DID NOT RUN. ` +
      `Anchor: ${JSON.stringify(find.slice(0, 70))}`
    );
    failures += 1;
    return false;
  }
  fs.writeFileSync(p, before.replace(find, replace));
  return true;
}

/** Make one lifecycle event unreachable, as though it had never arrived. */
const ABSENT = {
  healthyActivated: {
    find: "'agent.activated': sub.eventFor('agent.activated', HEALTHY)",
    replace: "'agent.activated': undefined"
  },
  degradedDeactivated: {
    find: "'agent.deactivated': sub.eventFor('agent.deactivated', VICTIM)",
    replace: "'agent.deactivated': undefined"
  }
};

/** Restore the pre-fix formatter, exactly: the guard removed, nothing else. */
const UNGUARD_SHOW = { find: 'json === undefined', replace: 'false' };

const TYPE_ERROR = /TypeError: Cannot read properties of undefined \(reading 'replace'\)/;

// ---------------------------------------------------------- arm 0: control --
console.log('\narm 0  CONTROL — unmutated copy, so the later absence checks mean something');
{
  const dir = stage();
  const { code, out } = runProof(dir);
  check(code === 0, 'the proof exits 0 on an unmutated staged tree', `exit ${code}`);
  check(/2\. HEALTHY/.test(out), 'section 2 reports');
  check(/3\. DEGRADED/.test(out), 'section 3 reports');
  check(/4\. MUTATION/.test(out), 'section 4 reports');
  check(/All sections passed\./.test(out), 'and the VERDICT block says all sections passed');
  check(!TYPE_ERROR.test(out), 'no TypeError — the formatter is not being exercised by accident');
  check(
    !/EVENT ARRIVED/.test(out),
    'and NO event is reported missing, so the absence verdict is not firing on a healthy run'
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------- arm 1: the defect, reproduced --
console.log('\narm 1  PRE-FIX — the formatter guard removed AND an event made absent');
console.log('       (this is the bug as filed: it must crash, and it must take the file with it)');
{
  const dir = stage();
  if (
    edit(dir, PROOF, UNGUARD_SHOW.find, UNGUARD_SHOW.replace) &&
    edit(dir, PROOF, ABSENT.degradedDeactivated.find, ABSENT.degradedDeactivated.replace)
  ) {
    const { code, out } = runProof(dir);
    check(code !== 0, 'the proof dies', `exit ${code}`);
    check(TYPE_ERROR.test(out), "and dies with the ticket's exact TypeError, from the formatter");
    check(
      !/4\. MUTATION/.test(out),
      'and section 4 NEVER REPORTS — the stack trace took the rest of the file with it'
    );
    check(
      !/All sections passed\.|section\(s\) FAILED\./.test(out),
      'and no VERDICT is reached at all, so the run yields no count of anything'
    );
    check(
      !/EVENT ARRIVED/.test(out),
      'and nothing names the event that was missing — which is the whole defect'
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------- arm 2: absence on the healthy half --
console.log('\narm 2  POST-FIX, HEALTHY HALF — `agent.activated` never arrives');
{
  const dir = stage();
  if (edit(dir, PROOF, ABSENT.healthyActivated.find, ABSENT.healthyActivated.replace)) {
    const { code, out } = runProof(dir);
    check(!TYPE_ERROR.test(out), 'NO TypeError — the formatter survived an undefined');
    check(
      /\(no value — this is `undefined`, which JSON\.stringify does not render\)/.test(out),
      'the formatter rendered the absence instead of throwing on it'
    );
    check(
      /FAILED — healthy half: NO `agent\.activated` EVENT ARRIVED/.test(out),
      'the absence is a FAIL that names the half AND the event'
    );
    check(
      !/NO `agent\.configured` EVENT ARRIVED/.test(out) &&
        !/NO `agent\.deactivated` EVENT ARRIVED/.test(out),
      'and names ONLY that event — the two that did arrive are not reported missing'
    );
    check(/3\. DEGRADED/.test(out), 'section 3 still reports after the failure');
    check(/4\. MUTATION/.test(out), 'section 4 still reports after the failure');
    check(/section\(s\) FAILED\./.test(out), 'and the VERDICT block is reached and counts it');
    check(code !== 0, 'the proof exits non-zero', `exit ${code}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------- arm 3: absence on the degraded half --
console.log('\narm 3  POST-FIX, DEGRADED HALF — `agent.deactivated` never arrives');
console.log('       (the half the reporter\'s run actually died in)');
{
  const dir = stage();
  if (edit(dir, PROOF, ABSENT.degradedDeactivated.find, ABSENT.degradedDeactivated.replace)) {
    const { code, out } = runProof(dir);
    check(!TYPE_ERROR.test(out), 'NO TypeError — the formatter survived an undefined');
    check(
      /FAILED — degraded half: NO `agent\.deactivated` EVENT ARRIVED/.test(out),
      'the absence is a FAIL naming the degraded half and that event'
    );
    check(
      !/healthy half: NO `/.test(out),
      'and the healthy half is NOT reported missing — the two halves are told apart'
    );
    check(
      /no event was received at all/.test(out),
      "section 3's own field assertion also reports it, so the two agree rather than one masking the other"
    );
    check(/4\. MUTATION/.test(out), 'section 4 still reports after the failure');
    check(/section\(s\) FAILED\./.test(out), 'and the VERDICT block is reached and counts it');
    check(code !== 0, 'the proof exits non-zero', `exit ${code}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- arm 4: the LATE case ------
console.log('\narm 4  LATE — the wait for the last event gives up');
console.log('       (its answer used to be computed and discarded)');
{
  const dir = stage();
  if (
    edit(
      dir,
      PROOF,
      "() => mcp.eventPayloads().some((p) => p?.action === 'agent.deactivated' && p?.path === VICTIM),",
      '() => false,'
    ) &&
    edit(dir, PROOF, '10_000', '400')
  ) {
    const { code, out } = runProof(dir);
    check(!TYPE_ERROR.test(out), 'no TypeError');
    check(
      /FAILED — real: THE WAIT FOR THE LAST EVENT TIMED OUT/.test(out),
      'a wait that gives up is a FAIL naming the run it gave up on'
    );
    check(
      /may be\n?\s*LATE rather than never sent/.test(out),
      'and says the absence below it may be lateness rather than silence'
    );
    check(/section\(s\) FAILED\./.test(out), 'the VERDICT block is reached and counts it');
    check(code !== 0, 'the proof exits non-zero', `exit ${code}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------ 5: the tree is untouched --
console.log('\n5  THE WORKING TREE');
{
  const changed = STAGED.filter(
    (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8') !== contentsBefore[rel]
  );
  check(
    changed.length === 0,
    `none of the ${STAGED.length} files this drive reads changed while it ran`,
    changed.length ? changed.join(' | ') : 'all byte-identical to before arm 0'
  );
}

console.log(
  failures === 0
    ? '\nOK — an absent event is a named, counted FAIL that names WHICH event, the run\n' +
      'continues past it, and removing the guard restores the original TypeError.\n'
    : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures ? 1 : 0);
