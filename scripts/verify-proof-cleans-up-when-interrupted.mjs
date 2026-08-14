#!/usr/bin/env node
// A proof that cleans up only when it FINISHES is not a proof that cleans up.
//
// WHAT FAILURE THIS WOULD CATCH: a verify script whose teardown sits on the
// happy path, so every run that throws or is interrupted leaves a real daemon
// running against a scratch directory the process then never removes. Nothing
// reports it. The script's own output says PASS or FAIL and says nothing at all
// about what it left behind, which is why this went unnoticed until somebody
// counted.
//
// OBSERVED IN THE WILD, not argued from the code. After a working session on
// KAN-114, two orphaned daemons were still up:
//
//   1013315  /tmp/crabcast-kan114-2ZqiY8/crabcast.config.json
//   1033788  /tmp/crabcast-kan114-DxsS0h/crabcast.config.json
//
// Both were `verify-send-confirms-delivery.mjs` daemons, holding unix sockets
// in scratch directories that no longer existed, from runs that threw before
// reaching the teardown at the bottom of the file. `process.on('exit')` would
// not have saved them either: it does not fire for SIGINT, and interrupting a
// hand-run proof is ordinary rather than exceptional.
//
// WHY THIS IS ITS OWN SCRIPT rather than a section inside the one it tests: a
// script cannot meaningfully interrupt itself. The only way to find out what a
// process leaves behind when it is killed is to be a different process, kill
// it, and count. So this drives the target as a subprocess and measures the
// machine on either side.
//
// HOW THE COUNT IS MADE UNAMBIGUOUS. Each run gets its own TMPDIR, which
// `os.tmpdir()` honours, so the target's scratch root — and therefore its
// daemon's config path on the process table — is unique to that run. Nothing
// here can be confused by a concurrent verify run, or by a daemon somebody
// else's session left lying about. It also means this script never matches on
// a pattern broad enough to kill a process it did not start.
//
// WHAT THIS SCRIPT COUNTS, AND WHAT IT DOES NOT (KAN-169). Its subject is
// DAEMONS. The driving, the interrupting and the counting now live in
// `interrupt-probe.mjs` with the counted thing as a parameter, because until
// KAN-169 they lived here with the counted thing hard-wired: the word "pane"
// did not appear in this file, so a herdr pane leaked by an interrupted run
// was invisible to the one script in this suite whose whole job is to notice
// what an interrupted run leaves behind. `verify-pane-reclaim-when-interrupted`
// is the pane half, and it is in the live half of the suite because it needs a
// real herdr. THIS FILE'S BEHAVIOUR IS UNCHANGED BY THAT MOVE — same target,
// same counter, same two sections — and its counter is stricter in one place:
// `ps` answering something too short to be a process table is now a refusal at
// the point of counting rather than a canary asserted once at the top, so "no
// daemons survived" cannot be read off a failed `ps` however far apart the
// canary and the count drift.
//
// Needs node and nothing else: the target supplies its own herdr shim.
//
// Usage:
//   npm run build
//   node scripts/verify-proof-cleans-up-when-interrupted.mjs

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { makeMutator } from './mutation.mjs';
import { daemonCounter, driveAndInterrupt, reapDaemons } from './interrupt-probe.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(scriptDir, 'verify-send-confirms-delivery.mjs');
const DIST = process.argv[2] ?? path.resolve(scriptDir, '..', 'dist');

let failures = 0;
let checks = 0;
function check(ok, name, detail) {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Print a counter result without ever flattening a refusal into a number.
 *
 * `${result.survivors.length}` on a refusal reads `undefined`, which is at
 * least loud; `?? 0` would read `0`, which is the exact false negative the
 * discriminated shape exists to prevent. So a refusal prints its reason and no
 * count at all.
 */
const describe = (r) => (r.ok ? `${r.survivors.length} ${JSON.stringify(r.survivors)}` : `REFUSED: ${r.reason}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan-cleanup-'));

// The shared mutator, bound to THIS script's verdict — so a mutation that stops
// applying lands in the same failure count every other assertion here lands in,
// rather than in a throw (KAN-170). `distDir` is unused: this script mutates a
// SOURCE FILE, not a build, and `mutateScript` is the entry point for that.
// `check` here is `check(ok, name, detail)`, hence the adapter.
const { mutateScript, mutationsSkipped } = makeMutator({
  distDir: DIST,
  scratch: root,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

/**
 * THE COUNTER, and it is the parameter this script used to have hard-wired.
 *
 * Daemons whose config path is under this run's TMPDIR, read off the process
 * table — the only place that answers the question this script asks. It returns
 * a RESULT rather than a count, so an unreadable `ps` is a refusal rather than
 * a confident zero; see the counter contract in `interrupt-probe.mjs`.
 */
const countDaemons = daemonCounter();

/**
 * Drive the target and interrupt it, with `distDir` PASSED EXPLICITLY as an
 * operand — the mutant copy lives outside the repository and the target
 * resolves `../dist` relative to its own file. The first version left that
 * implicit; the mutant looked for `/tmp/dist`, died on import in milliseconds,
 * and section 2 then measured a run that had never started a daemon. A mutant
 * that cannot run is not a mutant.
 */
const interruptMidRun = (scriptPath, label) =>
  driveAndInterrupt({ target: scriptPath, argv: [DIST], root, label, count: countDaemons });

// ===========================================================================
rule('0. THE COUNTER IS LIVE — a zero from it means zero, not "could not look"');
// ===========================================================================

check(countDaemons({ runTmp: root }).ok,
  'the process table is readable, so every count below is a measurement');

// ===========================================================================
rule('1. INTERRUPTED MID-RUN, the daemon does not survive');
// ===========================================================================

let pristine;
{
  pristine = await interruptMidRun(TARGET, 'pristine');
  console.log(`   daemons under this run's TMPDIR while running: ${describe(pristine.during)}`);
  console.log(`   daemons under this run's TMPDIR after SIGINT:  ${describe(pristine.after)}`);

  check(pristine.during.ok && pristine.during.survivors.length > 0 && !pristine.diedEarly,
    'PRECONDITION: the run really had a daemon up when it was interrupted — otherwise there ' +
    'would be nothing to leak and this section would pass against a script with no cleanup at all',
    `during=${describe(pristine.during)} diedEarly=${pristine.diedEarly}`);
  check(pristine.after.ok && pristine.after.survivors.length === 0,
    'and NOTHING survived the interrupt: the signal handler killed the daemon it started',
    `survivors=${describe(pristine.after)}`);
  check(!fs.existsSync(pristine.runTmp) || fs.readdirSync(pristine.runTmp).every((e) => !e.startsWith('crabcast-')),
    "and it took its scratch directory with it, so the machine is where it was found");
  if (pristine.after.ok) reapDaemons(pristine.after.survivors);
}

// ===========================================================================
rule('2. THE CHECK CAN FAIL — strip the signal handler and the daemon leaks');
// ===========================================================================
//
// Section 1 asserts an absence, and an absence is exactly what a check reports
// when it has quietly stopped testing anything. So the handler is removed from
// a copy of the target and the same measurement re-run: if the survivor count
// does not go up, section 1 was not measuring the handler.

mutation: {
  const HANDLER = `process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}`;

  // THROUGH THE SHARED HELPER (KAN-170). This block used to count occurrences
  // itself — correctly — and then THROW when the count was wrong, which killed
  // the process: the verdict line never printed and the script never chose its
  // own exit status. It was the one mutating proof `scripts/mutation.mjs` did
  // not reach, because the helper copies a BUILD and this copies a single
  // source file, and `verify-mutation-harness`'s sweep looked for scripts that
  // copy a build. Two mechanisms, each honest about itself, with this script in
  // the space between them. `mutateScript` is that gap closed: the same
  // exact-occurrence rule, the same "Fix the mutation, not this check."
  // sentence, and a failure that is a COUNTED VERDICT returning null — so this
  // section skips and the rest of the file still reports.
  //
  // `deps` carries `mutation.mjs` next to the mutant because THE MUTANT RUNS
  // FROM THIS RUN'S OWN SCRATCH ROOT and the target imports it (KAN-138).
  // Without that the mutant dies on an unresolved import milliseconds after
  // spawning — which does not fail loudly, it fails as "the mutant leaked
  // nothing", i.e. as this section PASSING its subject while proving the
  // opposite. The precondition below is what caught that, and it is still the
  // only thing that could: the helper closes one way for a mutant to die on
  // startup, not the class.
  const mutantPath = mutateScript(
    'strip-cleanup-handler',
    TARGET,
    [{ find: HANDLER, replace: '/* handler removed by the mutation */' }],
    { deps: ['mutation.mjs'] }
  );
  // Already a counted failure. Skip the section rather than asserting about a
  // script that was never mutated.
  if (!mutantPath) break mutation;

  const mutant = await interruptMidRun(mutantPath, 'mutant');
  console.log(`   mutant: daemons while running: ${describe(mutant.during)}`);
  console.log(`   mutant: daemons after SIGINT:  ${describe(mutant.after)}`);

  check(mutant.during.ok && mutant.during.survivors.length > 0 && !mutant.diedEarly,
    'PRECONDITION: the mutant also really had a daemon up when it was interrupted — a mutant ' +
    'that died on startup would leak nothing and make this section prove the opposite of what ' +
    'it says',
    `during=${describe(mutant.during)} diedEarly=${mutant.diedEarly}`);
  check(mutant.after.ok && mutant.after.survivors.length > 0,
    'WITHOUT THE HANDLER THE DAEMON SURVIVES — so section 1 is measuring the handler rather ' +
    'than restating a hope. This is the leak, reproduced on demand.',
    `survivors=${describe(mutant.after)}`);

  // Never leave the mutant's leak behind: this script must not become the
  // thing it exists to catch.
  if (mutant.after.ok) reapDaemons(mutant.after.survivors);
  await sleep(500);
  const reaped = countDaemons(mutant.ctx);
  check(reaped.ok && reaped.survivors.length === 0,
    'and the mutant\'s leaked daemon was reaped, so this proof leaves nothing running either',
    describe(reaped));
}

// ===========================================================================

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
// Named next to the verdict so "1 FAILED" is not read as an ordinary assertion
// failure when what actually happened is that a section never executed.
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY, so their section did not run: ` +
    skipped.join(', '));
}
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
