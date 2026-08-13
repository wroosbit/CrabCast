#!/usr/bin/env node
// The one proof in this suite that edits a TRACKED file has to survive being
// killed, and has to refuse to build on what a killed run left behind.
//
// WHAT FAILURE THIS WOULD CATCH: `scripts/verify-ci-wiring-guards.mjs` snapshots
// `.github/workflows/ci.yml` off disk at startup and restores that snapshot at
// the end. Started over a previous run's residue it therefore adopts the
// RESIDUE as its baseline, restores the residue, and PASSES its own
// "byte-identical to how this run found it" check — because the file does match
// what it found. Section 5 below backs that fix out of the CURRENT code over a
// seeded residue and shows the result print ALL CHECKS PASSED, exit 0, and leave
// the corrupted workflow in the tree. A cleanup assertion reporting an all-clear
// over a corrupted tracked file is the failure-as-success shape this epic exists
// to catch, sitting in the cleanup path of the script that guards CI.
//
// SECTION 5 IS NAMED THERE AND SECTION 4 IS NOT, AND THAT IS THE CORRECTION
// KAN-363 MADE (2026-08-12). Section 4 used to hold that demonstration by
// loading the version that shipped on `main` at 0edd2c1 and running it. It has
// asserted NOTHING since KAN-172 merged at 13a247d — 44 merged pull requests —
// because it reaches for that version through `origin/main`, and `origin/main`
// has carried the fix ever since. Section 4 now states that dormancy, refuses
// the obvious pin with a fixture rather than a story, and checks that section 5
// really did the work it hands off to. See the section header for the decision
// and the rejected options.
//
// AND THE HALF THAT COMES FIRST: SIGKILL, a reboot or a power cut lands between
// the write and the restore and ci.yml is left carrying a deliberately-broken
// construct with nothing recording that a test put it there. That is not noise
// like a leaked daemon — it is a tracked file under review, so it reads as a
// change somebody made. It has already cost real time: KAN-138's agent watched
// ci.yml change under it across several minutes, could not attribute it, and
// reported it on a PR as an unattributed actor editing CI. This machine rebooted
// twice in the two days before KAN-172 was filed, which is precisely the ending
// no handler can catch.
//
// WHY THIS IS ITS OWN SCRIPT, the same reason
// `verify-proof-cleans-up-when-interrupted` is: a script cannot meaningfully
// SIGKILL itself, and it cannot show what a SECOND run does over the first run's
// leftovers without being that second run. The only way to find out what a
// process leaves behind when it is killed is to be a different process, kill it,
// and look.
//
// IT NEVER TOUCHES THIS REPOSITORY'S OWN ci.yml. Everything below happens inside
// a throwaway git clone of the working tree, in a temp directory: the subject is
// a script whose whole hazard is corrupting a tracked file, and a proof of that
// which corrupted the real one when IT was killed would be the defect wearing
// the fix's clothes. So the target is run with its repoRoot pointing at the
// sandbox, and the file every section seeds, kills over and inspects is the
// sandbox's copy. Nothing here can leave residue a reviewer would see.
//
// WHAT THE SANDBOX CHANGES, said because a fixture that differs from the real
// thing silently is worse than one that differs loudly. Section 0 below requires
// the target to go GREEN in the sandbox before anything else is measured, so a
// sandbox that had broken the target in some other way is a failed precondition
// rather than a quiet distortion of every section after it.
//
// THIS PARAGRAPH USED TO SAY the clone "has no `main` ref", so the target's own
// section 2 — which loaded the PRE-FIX ci-workflow parser out of `origin/main` —
// reported NOT RUN there. BOTH HALVES WERE FALSE, and KAN-361 found the first:
// cloning this worktree DOES produce `refs/remotes/origin/main`, because the
// shared clone it came from has a local `main` and a clone copies it. Re-measured
// by KAN-363 at 2dd39eb: the sandbox's `origin/main` resolves to the shared
// clone's LOCAL main, 20 commits behind the real one, and it is `refs/heads/main`
// that is absent rather than the remote. So the ref that existed was the one this
// paragraph said was missing. The second half is stale rather than wrong: KAN-354
// pinned the target's section 2 to a SHA, so it no longer consults a ref at all,
// and the NOT RUN this described cannot happen any more.
//
// THE MECHANISM IS UNCHANGED — this is a correction to a false disclosure, not a
// fix. The sandbox's ref environment is still whatever the developer's shared
// clone happens to carry, and still differs silently from a GitHub runner's.
// That is Finding 3 in `docs/moving-baselines.md`, still open, and making it
// deterministic is a fixture change with its own red-drive obligations. Nothing
// in this script depends on it today: sections 5–7 drive the CURRENT target,
// whose baseline is pinned, and section 4c pins BOTH arms' refs precisely so that
// it does not inherit this.
//
// WHAT THIS DOES NOT COVER, marked here because two scripts that are each honest
// about themselves can still leave a hole between them. Every section below
// SUPPLIES ITS OWN RESIDUE — seeded by this script, or produced by a kill this
// script timed. So it proves the marker is written and the refusal fires on
// residue that reaches them; it does NOT prove that a real reboot mid-row leaves
// exactly this, because nothing here can cause a reboot. The nearest available
// evidence is the SIGKILL in section 1, which is the same ending from the
// process's point of view — no handler runs either way — and that is the whole
// of the claim. Nobody else covers the reboot, and that is written here rather
// than left for a reader to assume.
//
// AND THE SECOND FAILURE THIS WOULD CATCH (KAN-341, section 6): the target's
// marker is written by `fs.writeFileSync`, which truncates before it writes, so
// the file passes through EMPTY on every single write — mutated, tracked, and
// with no bytes in it to carry the marker layer 2 exists for. Sections 1–3 kill
// the target and read what is left, so they inherit that window rather than
// testing it: `killWhileMutated` aims at the first state that differs from the
// committed file, and a truncated file differs. Landing there it leaves an empty
// ci.yml, and the five AC1 assertions fail against a file with nothing in it.
// That is what made this script flaky on `main` — run 31590166769 at 60a6b8b,
// red on six assertions with a residue diff of `@@ -1,933 +0,0 @@`, green on
// re-run over the identical tree. Section 6 tests the property directly instead
// of inheriting it, and it is deterministic where a kill is not.
//
// HOW BIG THE WINDOW IS, timed rather than counted, because section 6 counts
// OBSERVATIONS and an empty file is cheaper to read than a 61KB one — so a
// sample count over-reports it and is not a measure of duration. Timed with the
// rename backed out: ~100 empty episodes per run of the target, median 0.07 ms,
// longest 7.9 ms, ~50 ms in total. Section 6's counts are evidence that the
// window exists or does not; these are what it is.
//
// Needs node, git and a build (`npm run build`) — the target refuses without
// `dist/cli.js`, because one of the two guards it drives reads the built command
// table. No daemon, no herdr, no network.
//
// Usage:
//   npm run build
//   node scripts/verify-ci-proof-residue-is-legible.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const WORKFLOW_REL = path.join('.github', 'workflows', 'ci.yml');
const TARGET_REL = path.join('scripts', 'verify-ci-wiring-guards.mjs');

/** The marker the target writes while ci.yml is mutated. Matched, not retyped. */
const MARKER_TAG = 'MUTATED BY scripts/verify-ci-wiring-guards.mjs';
/** The target's own refusal headline. */
const REFUSAL = 'REFUSING TO RUN';

let failures = 0;
let checks = 0;
function check(ok, name, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  } else if (detail) {
    console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (text, limit = 8) =>
  text
    .split('\n')
    .slice(0, limit)
    .map((l) => `   | ${l}`)
    .join('\n');

// ---------------------------------------------------------------------------
// The sandbox: a real git clone of this working tree, with the untracked build
// carried in, committed so its tree is CLEAN. Clean matters — the whole subject
// here is what a run does when it finds that file dirty, so a sandbox that
// started dirty would make section 0's green run impossible and every later
// section unreadable.
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan172-residue-'));
const sandbox = path.join(scratch, 'sandbox');
const sandboxWorkflow = path.join(sandbox, WORKFLOW_REL);

/** Every child this script starts, so nothing outlives it. */
const spawned = new Set();
let cleanedUp = false;
function cleanUp() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of spawned) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function buildSandbox() {
  git(['clone', '--quiet', repoRoot, sandbox]);
  // The clone carries HEAD's committed content; this run is about the working
  // tree's version of the target, which on a branch under development is not the
  // same file. Copy what git tracks, over the top.
  const carry = new Set(git(['ls-files']).split('\n').filter(Boolean));
  // THIS FILE TOO, tracked or not. The sandbox commits everything it is given,
  // so the `verify-proof-registry` run the target spawns inside it reconciles
  // ci.yml's script array against what is there — and this script is IN that
  // array. Left out while still untracked here, it would be an array entry with
  // no file, the registry would fail, and section 0 would report the target
  // broken in the sandbox for a reason that has nothing to do with the target.
  carry.add(path.relative(repoRoot, fileURLToPath(import.meta.url)));
  for (const rel of carry) {
    const dest = path.join(sandbox, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), dest);
  }
  // dist/ is untracked and the target refuses without it; node_modules is
  // symlinked rather than copied because it is 115MB and nothing here writes to
  // it.
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(sandbox, 'dist'), { recursive: true });
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(sandbox, 'node_modules'));
  } catch { /* absent is fine: the guards the target drives need only node builtins and dist */ }
  git(['add', '-A'], sandbox);
  git(['-c', 'user.email=proof@crabcast.invalid', '-c', 'user.name=KAN-172 proof',
    'commit', '--quiet', '-m', 'sandbox baseline'], sandbox);
}

/** git's own answer about the sandbox's ci.yml, which is what the target asks. */
const sandboxPorcelain = () =>
  git(['status', '--porcelain', '--', WORKFLOW_REL], sandbox).trim();

const readSandboxWorkflow = () => fs.readFileSync(sandboxWorkflow, 'utf8');

function restoreSandbox() {
  git(['checkout', '--', WORKFLOW_REL], sandbox);
}

/**
 * Run a variant of the target inside the sandbox to completion.
 *
 * `variantRel` is relative to the sandbox, and every variant lives in the
 * sandbox's own scripts/ directory because the target resolves its repoRoot from
 * its own file location — a copy run from anywhere else would mutate a workflow
 * that is not the one under test. Variants are written AFTER the sandbox commit
 * and so stay untracked, which keeps them invisible to
 * `verify-proof-registry.mjs`'s `git ls-files` sweep when the target runs it as
 * a child process.
 */
function runVariant(variantRel) {
  const r = spawnSync(process.execPath, [variantRel], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 300_000
  });
  return { code: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Start a variant, wait until it really has ci.yml mutated on disk, and SIGKILL
 * it there.
 *
 * WAITING FOR THE MUTATION IS THE PRECONDITION that keeps this honest: killing
 * the target before it had written anything would leave no residue whatever its
 * marker does, and the section would pass against a script that writes no marker
 * at all. Retried, because the window in which any one row is on disk is short
 * and losing the race is a missed measurement rather than a result.
 *
 * AND IT WAITS FOR A ROW THAT REALLY BREAKS THE WORKFLOW, not merely for the
 * file to differ. The target's baseline row writes the committed workflow with
 * the marker on top, so a kill there leaves a comment and nothing else — true
 * residue, but the mildest kind, and the alarming case KAN-138 hit is a
 * disabling construct sitting in a tracked CI file. `stripLeadingComments` is
 * how the two are told apart, and it works for the unmarked variant in section 2
 * as well, which has no comment to strip.
 */
const stripLeadingComments = (text) => text.replace(/^(?:#[^\n]*\n)+/, '');

async function killWhileMutated(variantRel, label) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    restoreSandbox();
    const committed = readSandboxWorkflow();
    const child = spawn(process.execPath, [variantRel], { cwd: sandbox, stdio: 'ignore' });
    spawned.add(child);
    const exited = new Promise((resolve) => child.on('exit', resolve));

    let sawMutation = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      let onDisk;
      try { onDisk = readSandboxWorkflow(); } catch { onDisk = committed; }
      if (stripLeadingComments(onDisk) !== committed) { sawMutation = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(10);
    }

    child.kill('SIGKILL');
    await exited;
    spawned.delete(child);

    const residue = readSandboxWorkflow();
    if (sawMutation && stripLeadingComments(residue) !== committed) {
      return {
        attempt,
        pid: child.pid,
        signal: child.signalCode,
        residue,
        porcelain: sandboxPorcelain(),
        diff: git(['diff', '--', WORKFLOW_REL], sandbox)
      };
    }
    console.log(`   (${label}: attempt ${attempt} lost the race — the mutated row was restored before the kill landed; retrying)`);
  }
  return null;
}

// The two residues every later section is seeded with. Both are real shapes, and
// neither is chosen for being convenient.
//
//   MARKED    exactly what section 1's SIGKILL leaves: the marker plus row C's
//             `continue-on-error: true` on the proof-registry job. Note that
//             this shape survives the target's OLD backstop — the setup guards
//             count the `- run:` line and the `proof-registry:` line, and this
//             residue adds a key rather than removing either.
//
//   COMMENT   a comment-only dirty ci.yml. Under the fixed target this is the
//             residue a run killed during the BASELINE row leaves, because that
//             row's yaml is the committed file and the marker is all that is
//             added. It is also what a human's uncommitted edit to a comment
//             looks like. It matters because it is the residue that makes
//             absorption completely invisible: the target's every row still
//             behaves as designed, so the run goes fully GREEN over a corrupted
//             baseline. Section 5 is that run; section 4 was, until it went
//             dormant.
const STEP_LINE = '      - run: node scripts/verify-proof-registry.mjs';
const JOB_LINE = '  proof-registry:';
const DEAD_PID = 424242;
const MARKED_RESIDUE = (yaml) =>
  [
    `# ${MARKER_TAG} — row C (\`continue-on-error: true\` on the job), pid ${DEAD_PID}, started 2026-08-05T00:00:00.000Z`,
    '# IF YOU ARE READING THIS IN `git status`, THAT RUN DIED BEFORE IT COULD RESTORE.',
    ''
  ].join('\n') + yaml.replace(JOB_LINE, `${JOB_LINE}\n    continue-on-error: true`);
const COMMENT_RESIDUE = (yaml) =>
  '# left behind by a run that died before it could restore this file\n' + yaml;

function seed(shape) {
  restoreSandbox();
  const committed = readSandboxWorkflow();
  const seeded = shape(committed);
  if (seeded === committed) {
    check(false, 'PRECONDITION: the seeded residue really changed ci.yml',
      'the seed was a no-op, so the section below would have measured a clean tree');
    return null;
  }
  fs.writeFileSync(sandboxWorkflow, seeded);
  return seeded;
}

// ===========================================================================
rule('0. THE INSTRUMENT IS LIVE — a clean sandbox, and the target green inside it');
// ===========================================================================

buildSandbox();

check(sandboxPorcelain() === '', 'the sandbox clone starts with ci.yml clean, so "dirty" below means this script put it there',
  `git status --porcelain -- ${WORKFLOW_REL}: ${JSON.stringify(sandboxPorcelain())}`);

const green = runVariant(TARGET_REL);
check(green.code === 0 && green.out.includes('ALL CHECKS PASSED'),
  'PRECONDITION: the target passes in the sandbox — every section below is read against this, and ' +
  'a sandbox that had broken it some other way would make each of them measure the breakage instead',
  green.code === 0 ? `exit 0, ${(green.out.match(/^PASS/gm) ?? []).length} checks` : `exit ${green.code}\n${green.out.slice(-1500)}`);
check(sandboxPorcelain() === '',
  'and it left the sandbox\'s ci.yml clean — which is also KAN-172 AC4 restated: the mutation ' +
  'table and the byte-identical assertion still hold with the marker being written',
  `git status: ${JSON.stringify(sandboxPorcelain())}`);

// ===========================================================================
rule('1. SIGKILLED MID-ROW — the residue says what put it there');
// ===========================================================================
//
// AC1. No `finally`, no `process.on(\'exit\')` and no signal handler runs after
// SIGKILL, so the only thing left that can explain the file is the file.

let killed;
{
  killed = await killWhileMutated(TARGET_REL, 'pristine');
  check(killed !== null,
    'PRECONDITION: the run really had ci.yml mutated when it was killed — killing it earlier would ' +
    'leave nothing behind and this section would pass against a script with no marker at all',
    killed ? `caught on attempt ${killed.attempt}, pid ${killed.pid}` : 'never caught the file mutated in 6 attempts');

  if (killed) {
    check(killed.signal === 'SIGKILL', 'and it died by SIGKILL, the ending no handler can catch',
      `signal=${killed.signal}`);
    check(killed.porcelain !== '',
      'the residue survived the kill — this is the situation a reviewer walks into',
      `git status --porcelain -- ${WORKFLOW_REL}:\n${killed.porcelain}`);

    // KAN-341, and it goes FIRST because it is the one that explains the other
    // five when they go. A kill that lands between open(O_TRUNC) and write()
    // leaves a file with no bytes in it, and five assertions about what the
    // marker says is a very confusing way to be told that. Section 6 is what
    // holds the property; this is what makes a regression in it legible here.
    check(killed.residue !== '',
      'KAN-341: the residue is a whole file rather than a torn write — the five assertions below are ' +
      'about what the marker SAYS, and an empty ci.yml fails all of them for a reason that is not the marker',
      `${Buffer.byteLength(killed.residue)} bytes on disk after the kill`);

    const markerLine = killed.residue.split('\n').find((l) => l.includes(MARKER_TAG)) ?? '';
    check(markerLine !== '',
      'AC1: the residue NAMES THE SCRIPT that wrote it, in the file itself');
    check(new RegExp(`pid ${killed.pid}\\b`).test(markerLine),
      'AC1: …and the pid of the run that died, so it can be told from any other run',
      `expected pid ${killed.pid}`);
    check(/row \S+ \(/.test(markerLine),
      'AC1: …and WHICH ROW it was on, which is what settles "is this construct a test fixture or a change?"');
    check(killed.residue.includes('RUN DIED BEFORE IT COULD RESTORE') && killed.residue.includes('EDITED CI'),
      'AC1: …and it says in words that the run died and that nobody edited CI — the claim KAN-138\'s ' +
      'agent had no way to check and reported as an unattributed actor editing CI');
    check(killed.residue.includes(`git checkout -- ${WORKFLOW_REL}`),
      'AC1: …and how to take it back out, so the reader does not have to work that out under alarm');

    console.log('\n   what a reviewer actually finds — the head of the residue:\n');
    console.log(quote(killed.residue, 9));
    console.log('\n   and the diff they would be reading:\n');
    console.log(quote(killed.diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('@@')).join('\n'), 12));
  }
  restoreSandbox();
}

// ===========================================================================
rule('2. THE MARKER CHECKED GOING RED — take it back out and the same kill leaves residue that says nothing');
// ===========================================================================
//
// Section 1 asserts that a string is present, and a string is present for all
// sorts of reasons. Remove the one line that puts it there and kill the same way:
// if the residue still explains itself, section 1 was not measuring the marker.

const { mutateScript, mutationsSkipped } = makeMutator({
  distDir: path.join(sandbox, 'dist'),
  // Variants must live in the sandbox's scripts/ — see runVariant.
  scratch: path.join(sandbox, 'scripts'),
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

noMarker: {
  const variant = mutateScript(
    'strip-the-marker',
    path.join(repoRoot, TARGET_REL),
    [{ find: 'writeWorkflow(markerFor(id, what) + yaml);',
      replace: 'writeWorkflow(yaml); /* marker removed by the mutation */' }]
  );
  if (!variant) break noMarker;

  const rel = path.join('scripts', path.basename(variant));
  const dead = await killWhileMutated(rel, 'no-marker');
  check(dead !== null,
    'PRECONDITION: the unmarked variant also really had ci.yml mutated when it was killed — a variant ' +
    'that died before writing would leave no residue and make this section prove the opposite of what it says',
    dead ? `caught on attempt ${dead.attempt}, pid ${dead.pid}` : 'never caught the file mutated in 6 attempts');

  if (dead) {
    check(!dead.residue.includes(MARKER_TAG),
      'WITHOUT THE MARKER THE RESIDUE IS ANONYMOUS — so section 1 is measuring the marker rather than ' +
      'restating a hope. This is the state that cost KAN-138\'s review its time, reproduced on demand.',
      `marker present: ${dead.residue.includes(MARKER_TAG)}`);
    check(dead.porcelain !== '',
      'and it is the same alarming diff: a tracked CI workflow modified, with nothing anywhere saying why',
      `git status --porcelain:\n${dead.porcelain}`);
    console.log('\n   what a reviewer finds without the marker — the whole of what the file tells them:\n');
    console.log(quote(dead.diff.split('\n').filter((l) => l.startsWith('+')).join('\n') || '(nothing)', 6));
  }
  restoreSandbox();
}

// ===========================================================================
rule('3. A RUN STARTED OVER RESIDUE REFUSES, AND NAMES IT');
// ===========================================================================
//
// AC2. Two residues, because the two cases must be answered differently and a
// refusal that invented a dead run for a human's uncommitted edit would be its
// own kind of fabrication.

marked: {
  // THE RESIDUE FROM SECTION 1'S REAL KILL where there is one, rather than a
  // fixture this script wrote: a refusal proved against residue the proof
  // manufactured would be one step further from the thing that happens. The
  // synthetic shape is the fallback so this section still reports when the kill
  // lost its race.
  const shape = killed ? () => killed.residue : MARKED_RESIDUE;
  const seeded = seed(shape);
  if (seeded === null) break marked;
  const markerLine = (seeded.split('\n').find((l) => l.includes(MARKER_TAG)) ?? '').trim();
  const r = runVariant(TARGET_REL);

  check(r.code !== 0 && r.out.includes(REFUSAL),
    `AC2: over MARKED residue (${killed ? `section 1's real killed run, pid ${killed.pid}` : 'a seeded marker'}) the target refuses to run at all`,
    `exit ${r.code}`);
  check(markerLine !== '' && r.out.includes(markerLine),
    'AC2: …and NAMES THE PRIOR RUN by echoing its marker line verbatim — the script, the row it died ' +
    'on and its pid, read out of the residue rather than guessed',
    markerLine);
  check(!r.out.includes('ALL CHECKS PASSED') && !/^PASS\s/m.test(r.out) && !r.out.includes('=== 1. Baseline'),
    'AC2: …and asserts NOTHING — not one PASS line, and it never reaches its baseline section. A ' +
    'refusal that also reported an all-clear would be the defect with a warning printed above it',
    `PASS lines: ${(r.out.match(/^PASS\s/gm) ?? []).length}, reached section 1: ${r.out.includes('=== 1. Baseline')}`);
  check(readSandboxWorkflow() === seeded,
    'AC2: …and leaves the residue exactly where it was, rather than absorbing it as a baseline or ' +
    'silently discarding an edit that might have been somebody\'s work');
  check(r.code !== 0,
    'AC2: …and it is a RED check, not a skip — a refusal that exited 0 would be a way to stop the ' +
    'guarding, which is the one thing worse than absorbing the residue',
    `exit ${r.code}`);

  console.log('\n   what the refusal says:\n');
  console.log(quote(r.out, 10));
}

unmarked: {
  const seeded = seed(COMMENT_RESIDUE);
  if (seeded === null) break unmarked;
  const r = runVariant(TARGET_REL);

  check(r.code !== 0 && r.out.includes(REFUSAL),
    'AC2: over residue with NO marker — a pre-marker run\'s leftovers, or a human mid-edit — it also refuses',
    `exit ${r.code}`);
  check(r.out.includes('no marker') && !r.out.includes(String(DEAD_PID)),
    'AC2: …and says so rather than inventing a dead run to blame it on, because "somebody is editing CI" ' +
    'and "a proof died here" are different answers and only one of them is safe to discard',
    `says "no marker": ${r.out.includes('no marker')}`);
  check(readSandboxWorkflow() === seeded,
    'AC2: …and it does not run `git checkout` over an edit that may be a person\'s work');
}

// ===========================================================================
rule('4. THE HISTORICAL DEMONSTRATION IS DORMANT — the dormancy stated, and the pin refused with a fixture');
// ===========================================================================
//
// WHAT THIS SECTION USED TO DO, and stopped. It ran the SAME seeded residue
// through the target as `origin/main` carried it, showing a run that absorbs the
// residue and reports an all-clear over it — the defect as it actually shipped,
// rather than as a mutation of today's code reconstructs it.
//
// WHAT IT STOPPED ASSERTING, WHEN, AND WHAT COVERS IT NOW (KAN-363, AC3):
//
//   * STOPPED ASSERTING: that the version of `verify-ci-wiring-guards.mjs` which
//     really shipped absorbed a residue, restored it, and exited 0 reporting ALL
//     CHECKS PASSED — the seven assertions in the `else` branch below.
//   * WHEN: KAN-172 merged at 13a247d and `origin/main` began carrying the fix.
//     `preFixTarget()` then returns no text and the section announces NOT RUN.
//     Measured 2026-08-12 at 2dd39eb: 44 merged pull requests since, every one of
//     them with this section silent inside a green job.
//   * WHAT COVERS IT: SECTION 5, deliberately and from the day this was written —
//     it backs the same fix out of the CURRENT code and makes the same two
//     observations. It is the durable half because its subject moves when the
//     code moves. The pointer to it is no longer prose: the check after section 5
//     asserts section 5 really ran, so this hand-off cannot outlive its referent.
//
// WHY IT IS NOT PINNED, which is the decision KAN-363 was filed to take. Pinning
// the ref is the fix section 2 of the target got from KAN-354, and it does not
// work here — but not for the reason it first appears, and the difference is the
// whole finding:
//
//   * PINNING THE REF ALONE MAKES THIS SECTION RED. The target at 0edd2c1
//     contains, at its own line 360, `for (const ref of ['origin/main','main'])`
//     — it predates KAN-354, so the historical script REACHES FOR A MOVING REF
//     ITSELF when executed. Its nested section 2 then resolves `origin/main` to a
//     post-KAN-148 parser, emits eleven `pre-fix:` FAILs, and the headline
//     assertion here fails on an exit code that has nothing to do with residue.
//     PINNING A REF PINS THE BYTES. IT DOES NOT PIN WHAT THOSE BYTES DO.
//
//   * AND PINNING BOTH WOULD WORK, which is the part that had to be measured
//     rather than assumed. Force the sandbox's `origin/main` to KAN148_PARENT as
//     well and the historical script goes fully green — measured at 2dd39eb: 119
//     PASS, 0 FAIL, exit 0. So this section is NOT refused because the pin is
//     impossible. The fixture below is that measurement, wired in.
//
//   * IT IS REFUSED BECAUSE A REVIVED SECTION 4 COULD ONLY EVER GO RED FOR A
//     REASON THAT IS NOT ITS SUBJECT. Its subject is 0edd2c1's bytes, and those
//     are frozen. Its verdict is a function of {frozen bytes} x {seeded residue}
//     x {environment}, and the first two cannot move — so nothing a future change
//     does to the behaviour under test can ever change what this section says.
//     Only environment drift can, and the historical script is coupled to a
//     moving present in ways no ref pin reaches: its setup guard demands exactly
//     one `      - run: node scripts/verify-proof-registry.mjs` and exactly one
//     `  proof-registry:` line in a ci.yml that has been edited 21 times since
//     13a247d, and it runs today's `verify-proof-registry.mjs` and
//     `verify-cli-parity.mjs` as child processes. Those lines have survived all
//     21 — measured — but surviving is not a mechanism. So every red a revived
//     section 4 could emit would be a FALSE red, misattributed to whoever last
//     touched ci.yml. That is section 2 of the target's own failure mode, which
//     KAN-354 was filed to remove, reintroduced here one level up.
//
// THE OPTIONS REJECTED, named because the ticket asked for them by name:
//
//   * DELETE SECTION 4 AND RELY ON SECTION 5. Rejected: the dormancy statement
//     above is the repository's only record of why the historical demonstration
//     cannot be re-run, and deleting the section deletes the explanation along
//     with the code. It would also remove the natural home for the checked
//     pointer to section 5, which is new coverage rather than a consolation.
//   * ASSERT SOMETHING ELSE ENTIRELY. Adopted in part rather than rejected — the
//     fixture below and the section-5 pointer check are both "something else",
//     and both hold today's code rather than history. What is rejected is the
//     pure form, replacing section 4 outright, for the reason directly above.
//   * TREAT NOT RUN AS A FAILURE, which `verify-daemon-provenance` does in its
//     own words: "a shallow clone that cannot reach these revisions has
//     demonstrated nothing." REJECTED AGAINST WHAT THAT FILE DOES, and adopted
//     for the half where it is true. Its revisions are pinned AND reachable, so
//     the only thing that makes them unreadable is a shallow clone — a fixable
//     environment defect. This section's NOT RUN fires because `origin/main`
//     carries the fix, which is the PERMANENT, EXPECTED consequence of the very
//     change it demonstrates: making that red would make CI red for succeeding,
//     for ever, with no fix available to anyone. The two conditions print the
//     same three words and are structurally opposite. So the first assertion
//     below adopts the principle exactly where it holds — an UNREACHABLE ref is
//     red here now, where until KAN-363 it printed the same quiet NOT RUN as a
//     baseline that had caught up.

/** KAN-172's merge: the first `origin/main` to carry the fix, and so the commit
 *  at which this section went dormant. Used below as the POST-fix arm. */
const KAN172_MERGE = '13a247da47add54bdc28219553cf99e752a832c8';
/** 13a247d^ — the last target that absorbed residue, and the bytes this section
 *  would have been pinned to. */
const PRE_FIX_TARGET_REV = '0edd2c1d203987fa9013f5a6e142aa0f61e456d2';
/** KAN-148's parent, the last tree with the PRE-fix ci-workflow parser. This is
 *  what the historical target's own section 2 has to find to behave as it did
 *  when it shipped.
 *
 *  IT IS A FACT ABOUT THIS REPOSITORY'S HISTORY, NOT A COPY OF ANOTHER FILE'S
 *  PIN, and the difference cost this section a guard. `verify-ci-wiring-guards`
 *  names the same commit today because KAN-354 chose the pre-fix point as its
 *  own baseline — a coincidence with a reason, not a dependency. The first draft
 *  of section 4c asserted that the two still agree, modelled on section 7's
 *  ANTI-DRIFT check, and THE ANALOGY DOES NOT HOLD: section 7 PLANTS a file that
 *  the target then SWEEPS for, so a rename in the target leaves section 7
 *  planting something nothing looks for — a real coupling whose failure is a
 *  false GREEN. Section 4c reads nothing from the target at all.
 *
 *  MEASURED by `epic/KAN-59` reviewing #87 and reproduced here before removing
 *  it: repin the target's section 2 to current `main` — a repin under which the
 *  target itself still exits 0 — and the proof goes 52/53 with exactly ONE FAIL,
 *  that precondition, while all three arms below stay correct in the same run
 *  (11 `pre-fix:` FAILs, 0, and guard 2 passing 11 vs 0). The fixture is
 *  unharmed and the guard announces that it is not. `docs/moving-baselines.md`
 *  tables section 2's pin as a maintenance site, so the repin is FORESEEN and
 *  the false red was scheduled, to land on whoever performs it.
 *
 *  A guard whose every possible red is false is the thing section 4 above
 *  refuses to revive itself into being. It was three hundred lines from the
 *  paragraph refusing it. It is gone, and the precondition that replaced it
 *  guards a failure this section really has. */
const KAN148_PARENT = 'dff24229869f2eb1b3089d2d4674582aaf065a49';

function preFixTarget() {
  const current = fs.readFileSync(path.join(repoRoot, TARGET_REL), 'utf8');
  for (const ref of ['origin/main', 'main']) {
    let text;
    try {
      text = git(['show', `${ref}:${TARGET_REL}`]);
    } catch {
      continue;
    }
    if (text === current) return { ref, text: null, why: `${ref} already carries this fix` };
    if (text.includes(REFUSAL)) return { ref, text: null, why: `${ref}'s copy already refuses over a dirty ci.yml` };
    return { ref, text, why: null };
  }
  return { ref: null, text: null, why: 'neither `origin/main` nor `main` is present in this clone' };
}

const preFix = preFixTarget();

if (!preFix.text) {
  // THE ONE DORMANCY THAT IS A DEFECT. `preFixTarget()` returns `ref: null` only
  // when NEITHER `origin/main` NOR `main` exists — a shallow clone, which is a
  // fixable environment defect and is exactly the condition
  // `verify-daemon-provenance` refuses to pass over. The other two whys (the ref
  // carries the fix, the ref already refuses) are the expected steady state and
  // are reported without a verdict. Before KAN-363 all three printed the same
  // NOT RUN and exited 0, so a shallow clone was indistinguishable from success.
  check(preFix.ref !== null,
    'THE BASELINE REF IS REACHABLE — a clone that cannot reach it has demonstrated nothing, and ' +
    'saying so is the difference between the demonstration happening and its absence being ' +
    'announced. Red ONLY for this cause: an unreachable ref is a fixable environment defect, ' +
    'where a ref that has caught up is the permanent expected consequence of the fix this ' +
    'section was written to demonstrate',
    preFix.ref !== null
      ? `reachable at \`${preFix.ref}\` — dormant because ${preFix.why}, which is the expected steady state`
      : `NOT RUN — ${preFix.why}. This is a shallow clone, not a caught-up baseline.`);

  console.log(`\n  DORMANT — ${preFix.why}.`);
  console.log('  NOTHING ABOUT THE SHIPPED VERSION IS ASSERTED HERE, and has not been since KAN-172');
  console.log(`  merged at ${KAN172_MERGE.slice(0, 7)}. What is missing is the demonstration that the shipped`);
  console.log('  version absorbed the residue. SECTION 5 makes the same measurement against the current');
  console.log('  code with the fix backed out, and the check after it asserts that section 5 really ran');
  console.log('  — so this hand-off is a checked pointer rather than a sentence. The run on the KAN-172');
  console.log('  pull request has this section live, and nothing can make it live again: see the header');
  console.log('  above for why it is not pinned, and the fixture below for that reason measured.');
} else {
  const rel = path.join('scripts', 'kan172-prefix-verify-ci-wiring-guards.mjs');
  fs.writeFileSync(path.join(sandbox, rel), preFix.text);
  console.log(`   pre-fix target loaded from ${preFix.ref}:${TARGET_REL}\n`);

  // 4a. The comment-only residue: the run goes entirely green over it.
  green: {
    const seeded = seed(COMMENT_RESIDUE);
    if (seeded === null) break green;
    const r = runVariant(rel);

    check(r.code === 0 && r.out.includes('ALL CHECKS PASSED'),
      'THE SHIPPED VERSION RAN TO COMPLETION OVER THE RESIDUE AND REPORTED ALL CHECKS PASSED — it ' +
      'never looked at whether the file it snapshotted was the committed one',
      `exit ${r.code}`);
    check(/PASS\s+\.github\/workflows\/ci\.yml restored/.test(r.out),
      '…including the assertion whose entire job is "the tree is as I found it". It is true and it is ' +
      'useless: the thing it compared against WAS the residue',
      (r.out.split('\n').find((l) => l.includes('ci.yml restored')) ?? '').trim());
    check(readSandboxWorkflow() === seeded,
      'AND THE CORRUPTED WORKFLOW IS STILL IN THE TREE afterwards, faithfully restored by the ' +
      'cleanup path, by a run that exited 0. That is the failure-as-success this ticket is about.',
      `residue byte-identical to what was seeded: ${readSandboxWorkflow() === seeded}`);
    check(!r.out.includes(REFUSAL),
      '…and at no point did it mention that ci.yml was dirty');
  }

  // 4b. And the residue a killed run actually leaves: it goes red, but for
  //     entirely the wrong reason, and never says the file is corrupt.
  wrongReason: {
    const seeded = seed(MARKED_RESIDUE);
    if (seeded === null) break wrongReason;
    const r = runVariant(rel);

    check(/PASS\s+\.github\/workflows\/ci\.yml restored/.test(r.out),
      'over a real killed-run residue the shipped version again PASSES its byte-identical check, ' +
      'having restored the corruption',
      (r.out.split('\n').find((l) => l.includes('ci.yml restored')) ?? '').trim());
    check(readSandboxWorkflow() === seeded,
      '…leaving the broken workflow in the tree');
    check(!r.out.includes(REFUSAL) && !/ci\.yml is already modified/.test(r.out),
      '…and its output never says the file was dirty. Whatever red it does produce is about its own ' +
      'rows, which sends the reader to hunt a parser bug that does not exist',
      `exit ${r.code}; rows it reported red: ${(r.out.match(/^FAIL\s+\S+/gm) ?? []).slice(0, 4).map((s) => s.trim()).join(' | ') || '(none — it was entirely green)'}`);
  }
}

// ---------------------------------------------------------------------------
// 4c. THE PIN REFUSED, AS A FIXTURE RATHER THAN A STORY (KAN-363 AC2).
//
// The paragraphs above assert that pinning the ref would not restore this
// section, because the pinned bytes reach for a moving ref of their own. A
// paragraph is exactly the artifact that goes stale, and this epic's whole
// subject is a sentence claiming more than its mechanism covers — so the reason
// is measured here instead, on every run.
//
// TWO ARMS, AND WHAT MAKES THE COMPARISON MEAN ANYTHING: the loaded bytes are
// THE SAME FILE in both, asserted by hash, and both are pinned. The ONLY thing
// that differs is what `origin/main` resolves to inside the sandbox. If the
// verdict flips, the flip is caused by the ref environment and by nothing else —
// which is the fourth shape demonstrated rather than described.
//
// WHY BOTH ARMS ARE PINNED, and this is the trap this section had to avoid
// walking into while documenting it. The obvious fixture is "ambient refs
// misfire, pinned refs do not" — but the ambient arm's verdict would then depend
// on whatever `origin/main` happens to be, which differs between CI and every
// developer machine (moving-baselines.md Finding 3, re-measured at 2dd39eb: the
// sandbox's `origin/main` is the shared clone's LOCAL main, 20 commits behind).
// A fixture for the moving-baseline class must not have one. So the POST-fix arm
// is pinned to KAN172_MERGE, which MODELS the ambient reality deterministically.
//
// WHAT THIS DOES NOT COVER: the arms assert only on the nested section 2's
// `pre-fix:` lines, deliberately. Asserting that the historical script goes
// WHOLLY green — which it does today, 119 PASS and 0 FAIL — would couple this
// fixture to today's ci.yml and to today's `verify-proof-registry.mjs` and
// `verify-cli-parity.mjs`, and re-create the very coupling the header rejects
// section 4's revival for. Scoping to `pre-fix:` is what keeps this section from
// being the thing it is about.
const HISTORICAL_REL = path.join('scripts', 'kan363-prefix-target-under-pinned-refs.mjs');

async function runHistoricalUnder(refSha) {
  const sandboxGitRefs = () => {
    const read = (ref) => { try { return git(['rev-parse', ref], sandbox).trim(); } catch { return null; } };
    return { origin: read('refs/remotes/origin/main'), local: read('refs/heads/main') };
  };
  const before = sandboxGitRefs();

  git(['update-ref', 'refs/remotes/origin/main', refSha], sandbox);
  // `main` is consulted second by the historical lookup, so leaving a stale one
  // behind would make this arm's ref environment two things rather than one.
  if (before.local !== null) git(['update-ref', '-d', 'refs/heads/main'], sandbox);

  const seeded = seed(COMMENT_RESIDUE);
  const r = seeded === null ? { code: null, out: '' } : runVariant(HISTORICAL_REL);
  restoreSandbox();

  if (before.origin !== null) git(['update-ref', 'refs/remotes/origin/main', before.origin], sandbox);
  else git(['update-ref', '-d', 'refs/remotes/origin/main'], sandbox);
  if (before.local !== null) git(['update-ref', 'refs/heads/main', before.local], sandbox);

  return {
    seeded,
    code: r.code,
    preFixFails: (r.out.match(/^FAIL\s+pre-fix:/gm) ?? []).length,
    // BOTH ARM ASSERTIONS REQUIRE THIS NON-EMPTY, and that is the guard rather
    // than a nicety: if a ref were wrong the nested section 2 would print NOT RUN
    // and emit ZERO `pre-fix:` failures — which is exactly what the pre-fix arm
    // expects to see. Without this the arm would pass for having skipped.
    loadedLine: (r.out.split('\n').find((l) => l.includes('pre-fix parser loaded from')) ?? '').trim()
  };
}

pinRefused: {
  let historical;
  try {
    historical = git(['show', `${PRE_FIX_TARGET_REV}:${TARGET_REL}`]);
  } catch (err) {
    check(false, `PRECONDITION: ${PRE_FIX_TARGET_REV.slice(0, 7)}:${TARGET_REL} is reachable — without the ` +
      'historical bytes there is nothing to demonstrate the pin against',
      `git show failed: ${err?.message ?? err}`);
    break pinRefused;
  }

  // WHAT REPLACED THE ANTI-DRIFT CHECK, and it is not a softer version of it —
  // it covers a failure that one never reached and that this section really has.
  //
  // The two SHAs above go straight to `git update-ref` inside
  // `runHistoricalUnder`, with no `try` anywhere on the path. An unreachable one
  // therefore does not FAIL, it THROWS, uncaught, and takes the verdict line
  // with it — the defect `scripts/mutation.mjs`'s header exists for, where a run
  // dies mid-file and every section after it silently never reports. Measured
  // before this guard existed, with KAN148_PARENT set to a well-formed SHA that
  // is not an object in this repository:
  //
  //     PROOF_EXIT=1
  //     verdict line printed: NONE — the run died without reporting
  //     fatal: update_ref failed for ref 'refs/remotes/origin/main'
  //
  // AND IT CANNOT EMIT A FALSE RED, which is the whole of what was wrong with
  // what it replaces. An unreachable pinned commit is a shallow clone or a
  // rewritten history — a fixable environment defect — and that is the SAME
  // distinction section 4 draws for its own baseline a few hundred lines above,
  // drawn the same way: red for a deficiency somebody can act on, silence for a
  // legitimate change elsewhere that costs this section nothing.
  const unreachable = [KAN172_MERGE, KAN148_PARENT].filter((sha) => {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
      return false;
    } catch {
      return true;
    }
  });
  check(unreachable.length === 0,
    'PRECONDITION: BOTH of this fixture\'s OWN pinned commits are reachable — they are handed to ' +
    '`git update-ref` below, where an unreachable one throws rather than fails and the run dies ' +
    'with no verdict at all. This is the only thing section 4c needs of the world outside its own ' +
    'two arms: it reads nothing from the target, and a repin ANYWHERE else cannot reach it',
    unreachable.length === 0
      ? `${KAN172_MERGE.slice(0, 7)} and ${KAN148_PARENT.slice(0, 7)} both resolve to commits`
      : `unreachable: ${unreachable.map((s) => s.slice(0, 7)).join(', ')} — a shallow clone, or history rewritten under this pin`);
  if (unreachable.length) break pinRefused;

  // DERIVED, NOT LITERAL. The expected FAIL count is read out of the historical
  // script's own case table. Writing `11` here would keep passing if that file
  // were ever a different file than this fixture thinks it is.
  const expectedFails = historical.split('gap: true').length - 1;
  const MOVING_REF_CONSTRUCT = "for (const ref of ['origin/main', 'main'])";
  check(historical.includes(MOVING_REF_CONSTRUCT) && expectedFails > 0,
    `PRECONDITION: the historical target really does reach for a moving ref itself, and really does ` +
    `carry gap cases to misfire — this is the whole premise, read out of the loaded bytes rather than ` +
    `taken from the ticket that reported it`,
    `${JSON.stringify(MOVING_REF_CONSTRUCT)} present: ${historical.includes(MOVING_REF_CONSTRUCT)}; ` +
    `\`gap: true\` cases: ${expectedFails}`);

  fs.writeFileSync(path.join(sandbox, HISTORICAL_REL), historical);
  const bytesBefore = fs.readFileSync(path.join(sandbox, HISTORICAL_REL));

  const post = await runHistoricalUnder(KAN172_MERGE);
  const pre = await runHistoricalUnder(KAN148_PARENT);

  const bytesAfter = fs.readFileSync(path.join(sandbox, HISTORICAL_REL));
  check(bytesBefore.equals(bytesAfter) && bytesAfter.equals(Buffer.from(historical)),
    'VACUITY GUARD 1: both arms ran THE SAME BYTES — nothing in this fixture edited the historical ' +
    'script between them, so the contrast below cannot be an artifact of two different files',
    `${bytesAfter.length} bytes, unchanged across both arms`);

  check(post.seeded !== null && pre.seeded !== null,
    'PRECONDITION: both arms really were seeded with residue — an arm that ran over a clean tree ' +
    'would be measuring something else entirely',
    `post-fix arm seeded: ${post.seeded !== null}, pre-fix arm seeded: ${pre.seeded !== null}`);

  check(post.preFixFails === expectedFails && post.loadedLine !== '',
    `PINNING THE BYTES IS NOT ENOUGH: with \`origin/main\` pinned to ${KAN172_MERGE.slice(0, 7)} — the ` +
    'commit that carries the fix, which is what every clone has resolved it to since KAN-172 merged — ' +
    `the historical script's OWN section 2 loads a post-fix parser and misfires with ${expectedFails} ` +
    '`pre-fix:` FAILs. Its exit code then has nothing to do with residue, which is why section 4 above ' +
    'is not simply repinned',
    `${post.preFixFails} \`pre-fix:\` FAIL(s) (expected ${expectedFails}), exit ${post.code}; ${post.loadedLine}`);

  check(pre.preFixFails === 0 && pre.loadedLine !== '',
    `AND THE BYTES ARE NOT AT FAULT: the SAME historical script, with \`origin/main\` pinned instead to ` +
    `${KAN148_PARENT.slice(0, 7)} — the last tree carrying the parser it was written against — loads a ` +
    'genuine pre-fix parser and misfires not at all. So the eleven failures above are caused by the ref ' +
    'environment and by nothing in the file',
    `${pre.preFixFails} \`pre-fix:\` FAIL(s), exit ${pre.code}; ${pre.loadedLine}`);

  check(post.preFixFails !== pre.preFixFails,
    'VACUITY GUARD 2: the two arms really did disagree. Identical bytes, identical residue, two pinned ' +
    'ref environments, opposite verdicts — A PINNED BASELINE DOES NOT PIN WHAT THE BASELINE DOES. If ' +
    'this ever reads equal, the fixture has stopped demonstrating anything and the paragraph above it ' +
    'has become a story again',
    `post-fix arm ${post.preFixFails} vs pre-fix arm ${pre.preFixFails}`);
}

// ===========================================================================
rule('5. THE REFUSAL CHECKED GOING RED — back it out of the CURRENT code and the residue is absorbed again');
// ===========================================================================
//
// The durable half of section 4: it measures the code in this tree rather than a
// ref that stops being pre-fix the moment this merges. Same seeded residue, same
// two observations.
//
// AND SINCE KAN-363 IT IS ALSO SECTION 4'S NAMED COVER, which makes it load
// bearing in a second way: section 4 tells its reader that what it stopped
// asserting happens here. That sentence is checked below rather than trusted.

/**
 * What section 4's dormancy message promises about this section, recorded as it
 * happens so the promise can be checked rather than read.
 *
 * WHY THIS IS NOT ENOUGH ON ITS OWN, and it is the reason the counter is here
 * rather than a bare boolean: `mutateScript` already reports a failed mutation
 * as a counted FAIL, so a section 5 that could not run is already red today. The
 * hole this closes is the other one — a section 5 that is DELETED, or quietly
 * reduced to preconditions, while section 4 goes on printing a pointer to
 * coverage that no longer exists, inside a green job. That is this epic's own
 * signature defect sitting in the hand-off between two honest sections.
 */
const sectionFive = { central: false, checks: 0, failures: 0 };
sectionFive.checks = checks;
sectionFive.failures = failures;

noRefusal: {
  const variant = mutateScript(
    'strip-the-dirty-refusal',
    path.join(repoRoot, TARGET_REL),
    [{ find: '  if (porcelain.trim()) {', replace: '  if (false && porcelain.trim()) {' }]
  );
  if (!variant) break noRefusal;
  const rel = path.join('scripts', path.basename(variant));

  const seeded = seed(COMMENT_RESIDUE);
  if (seeded === null) break noRefusal;
  const r = runVariant(rel);

  sectionFive.central = true;
  check(!r.out.includes(REFUSAL) && r.out.includes('=== 3. Every shape'),
    'WITHOUT THE REFUSAL THE CURRENT CODE RUNS ANYWAY over the residue — so section 3 is measuring ' +
    'the refusal, and the defect is one deleted condition away rather than closed by something else ' +
    'in the file',
    `refused: ${r.out.includes(REFUSAL)}, exit ${r.code}`);
  check(/PASS\s+\.github\/workflows\/ci\.yml restored/.test(r.out),
    '…and its byte-identical assertion passes over the corrupted baseline, exactly as it did on main',
    (r.out.split('\n').find((l) => l.includes('ci.yml restored')) ?? '(not present)').trim());
  check(readSandboxWorkflow() === seeded,
    '…having faithfully restored the residue, which is still there afterwards');

  // AND THE ANSWER TO "what would have to be true for this proof to pass while
  // the feature is broken?" — the refusal could be deleted and something else in
  // the file could happen to catch it, leaving section 3 green for a reason that
  // is not the refusal. It does not: the ONLY thing that notices here is the
  // companion assertion added by this same change. That is deliberate defence in
  // depth rather than a second copy of the same check — "byte-identical to what
  // I found" and "git says clean" are the same sentence only while the refusal
  // holds, and this is the run where they come apart.
  check(/FAIL\s+…and git agrees it is clean/.test(r.out),
    'and the ONE thing that notices is the companion assertion this change adds to the target\'s ' +
    'own section 4: "git agrees it is clean" goes red where "byte-identical to how this run found ' +
    'it" stayed green. Two assertions doing different work, on the run where they disagree.',
    (r.out.split('\n').find((l) => l.includes('git agrees it is clean')) ?? '(not present)').trim());
}

// ---------------------------------------------------------------------------
// 5b. SECTION 4'S HAND-OFF, CHECKED (KAN-363).
//
// Section 4 is dormant and says so, and it names section 5 as what covers what
// it stopped asserting. Until now that was prose in a `console.log` — and a
// pointer nothing checks is precisely the artifact this epic keeps finding: it
// goes on claiming coverage after the coverage has gone, and it does so inside a
// green job, which is the direction these things always degrade in.
//
// SO THE POINTER IS AN ASSERTION. If section 5 is deleted, renamed past its own
// mutation anchor, or reduced to preconditions, section 4's message becomes false
// and this goes red naming that — rather than section 4 quietly continuing to
// promise a demonstration nobody is doing.
//
// THE LIMIT, AT ITS NEAREST POINT RATHER THAN ITS MOST GENERAL: this asserts that
// section 5 RAN and PASSED. It does not, and cannot, assert that section 5's
// assertions are strong ones — a section 5 weakened to `check(true, …)` would
// satisfy every word of this. That is one file over: `verify-proof-defences`
// records what stands behind this script's central assertion, and
// `verify-proof-verdicts` says in its own header that a reachable verdict "does
// NOT establish that any of their assertions can be false". The thing that holds
// section 5's strength is section 5's own red drive, and nothing here replaces
// it.

const sectionFiveChecks = checks - sectionFive.checks;
const sectionFiveFailures = failures - sectionFive.failures;
check(sectionFive.central && sectionFiveChecks > 0 && sectionFiveFailures === 0,
  'SECTION 4 NAMES SECTION 5 AS ITS COVER, AND SECTION 5 REALLY RAN — its central assertion executed ' +
  'and its checks all passed. A dormant section pointing at a section that no longer asserts would be ' +
  'a claim of coverage with nothing behind it, which is the shape this whole script exists to catch',
  `section 5 central assertion reached: ${sectionFive.central}; ${sectionFiveChecks} check(s), ` +
  `${sectionFiveFailures} failure(s)`);

// ===========================================================================
rule('6. NO STATE IN BETWEEN — every version of ci.yml a reader could catch explains itself');
// ===========================================================================
//
// KAN-341. Sections 1–3 all rest on one unstated assumption: that the residue a
// kill leaves is a WHOLE file. `killWhileMutated` aims its SIGKILL at the first
// on-disk state that differs from the committed file, and `fs.writeFileSync` is
// open(O_TRUNC) then write() — so "differs from the committed file" was also
// true of the file EMPTY, mid-write, with no bytes in it to carry a marker.
//
// That is not a hypothesis. Run 31590166769 on `main` at 60a6b8b went red with
// exactly this: five AC1 assertions and one AC2 assertion failed, the residue
// diff read `@@ -1,933 +0,0 @@`, and the re-run over the identical tree was
// green. Measured here before the fix: zero-length observations plus torn reads
// at 4096, 8192 … 57344 bytes — the write() caught page by page. Measured again
// at 6f47df7, the commit BEFORE the CI-array line that was suspected of
// triggering it, at the same rate — so the array line is not the trigger, and
// the eight preceding greens were a race won eight times rather than evidence
// that anything changed. Reproducing the kill 40 times at 60a6b8b left torn
// residue once; the whole of what made this a flake is that 1 in 40.
//
// WHY THIS SECTION IS AN OBSERVER AND NOT ANOTHER KILL. A section that killed
// and then asserted the residue was whole would be measuring the same race that
// produced the flake, and would be green on every run where the race was lost —
// which is most of them. Watching every state the file passes through tests the
// property directly and deterministically: hundreds of observations per run
// rather than one bit.
//
// AND IT IS ALSO WHY SECTION 2 IS NOT THE PROOF IT LOOKS LIKE. Section 2 asserts
// the residue of a marker-stripped variant is anonymous — and a TORN residue is
// anonymous too, for a reason that has nothing to do with the mutation. Every
// run whose kill landed in the truncation window passed section 2 while
// measuring nothing. That is not fixed by anything in section 2; it is fixed by
// the window not existing, which is what this section holds.

/**
 * Run a variant while sampling ci.yml as fast as the loop allows, and report
 * every state it was caught in that is neither the committed file nor a complete
 * marked mutation.
 *
 * IT STOPS AFTER `ROWS_WATCHED` DISTINCT MUTATIONS rather than watching the
 * whole run, and the bound is stated here because a silent cap reads as full
 * coverage. Watching all ~30 rows costs about 40s per variant and this section
 * runs two; the window under test opens on EVERY write, so the rows after the
 * bound are more samples of a property already sampled thousands of times.
 *
 * `keepGoingUntilTorn` IS WHAT KEEPS THE BOUND HONEST, and it exists because of
 * a measurement rather than a worry. The red drive below has to CATCH the torn
 * window, and how many times it is caught in a fixed number of rows is itself
 * variable — 241, 68 and 14 on three runs of this machine, against 908 when the
 * whole run is watched. A red drive that has to win a race is the same defect
 * this ticket is about, one level up: on a slower runner 14 could be 0, and the
 * section would go red saying the window was not observed. So the broken
 * variant watches AT LEAST as many rows as the fixed one did and then keeps
 * watching until it catches one, to the end of the run if that is what it
 * takes. The comparison stays like-for-like and the drive stops being a gamble.
 */
const ROWS_WATCHED = 16;

async function observeWorkflowStates(variantRel, { keepGoingUntilTorn = false } = {}) {
  restoreSandbox();
  const committed = readSandboxWorkflow();
  const child = spawn(process.execPath, [variantRel], { cwd: sandbox, stdio: 'ignore' });
  spawned.add(child);
  const exited = new Promise((resolve) => child.on('exit', resolve));

  let samples = 0;
  let marked = 0;
  let tornTotal = 0;
  const tornSizes = new Map();
  const distinctMutations = new Set();

  while (child.exitCode === null && child.signalCode === null) {
    let body = null;
    try { body = fs.readFileSync(sandboxWorkflow, 'utf8'); } catch { /* mid-rename is fine */ }
    samples += 1;
    if (body !== null && body !== committed) {
      if (body.includes(MARKER_TAG)) {
        marked += 1;
        distinctMutations.add(body);
        if (distinctMutations.size >= ROWS_WATCHED && (!keepGoingUntilTorn || tornTotal > 0)) break;
      } else {
        tornTotal += 1;
        const size = Buffer.byteLength(body);
        tornSizes.set(size, (tornSizes.get(size) ?? 0) + 1);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  child.kill('SIGKILL');
  await exited;
  spawned.delete(child);
  restoreSandbox();
  return { samples, marked, rows: distinctMutations.size, tornTotal, tornSizes };
}

const describeTorn = (sizes) =>
  [...sizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([size, n]) => `${size} bytes x${n}${size === 0 ? ' (EMPTY — truncated, not yet rewritten)' : ''}`)
    .join(', ');

{
  const seen = await observeWorkflowStates(TARGET_REL);

  check(seen.marked > 0,
    'PRECONDITION: the observer really watched ci.yml being mutated — a target that died early ' +
    'would show no torn states either, and this section would report the property holding over a ' +
    'run that never exercised it',
    `${seen.samples} samples, ${seen.marked} of them a marked mutation on disk, across ${seen.rows} distinct row(s)`);

  check(seen.tornTotal === 0,
    'ci.yml is NEVER observed in a state that is neither the committed file nor a complete marked ' +
    'mutation — so the residue any ending leaves is one a reader can attribute, which is what ' +
    'sections 1–3 have been assuming all along',
    seen.tornTotal === 0
      ? `0 torn states in ${seen.samples} samples`
      : `${seen.tornTotal} torn state(s) in ${seen.samples} samples: ${describeTorn(seen.tornSizes)}`);
}

// The red drive: back the rename out and the window comes straight back.
tornWindow: {
  const variant = mutateScript(
    'back-out-the-atomic-write',
    path.join(repoRoot, TARGET_REL),
    [{ find: '  fs.writeFileSync(stagingPath, content);\n  fs.renameSync(stagingPath, workflowPath);',
      replace: '  fs.writeFileSync(workflowPath, content); /* KAN-341: the rename backed out by the mutation */' }]
  );
  if (!variant) break tornWindow;
  const rel = path.join('scripts', path.basename(variant));

  const seen = await observeWorkflowStates(rel, { keepGoingUntilTorn: true });

  check(seen.marked > 0,
    'PRECONDITION: the unmutated-write variant also really ran and mutated the file',
    `${seen.samples} samples, ${seen.marked} of them a marked mutation on disk, across ${seen.rows} distinct row(s)`);

  check(seen.tornTotal > 0,
    'WITH THE RENAME BACKED OUT the same observer catches ci.yml mutated-and-silent — so the check ' +
    'above is measuring the atomic write rather than restating a hope, and this is the state run ' +
    '31590166769 was SIGKILLed in',
    seen.tornTotal > 0
      ? `${seen.tornTotal} torn state(s) in ${seen.samples} samples: ${describeTorn(seen.tornSizes)}`
      : `none caught in ${seen.samples} samples across ${seen.rows} row(s) — and this variant watched ` +
        'to the end of the run rather than stopping at the bound, so the window was not merely ' +
        'missed by a short look. The check above is UNPROVEN on this machine rather than passed');

  check(seen.tornSizes.has(0),
    '…and among them the file EMPTY: the whole of what a run killed there leaves behind, which is ' +
    'a tracked CI workflow with nothing in it to say who emptied it — layer 2\'s marker defeated by ' +
    'the write that was supposed to carry it',
    `zero-length observations: ${seen.tornSizes.get(0) ?? 0}`);
}

// ===========================================================================
rule('7. THE STAGING FILE IS SWEPT — the residue the atomic write introduces');
// ===========================================================================
//
// KAN-341, and it exists because the review of this change starved
// `sweepStagingFiles()` to `return []` and every section above stayed green.
// The rename in section 6 removed one kind of residue and introduced a smaller
// one: a run killed between the write and the rename leaves the staging file
// behind. That is a better failure than an empty ci.yml — it is untracked, and
// it carries the marker as its first line, so it explains itself where an empty
// file could not — but "better" is not "covered", and the sweep that removes it
// was the one behaviour in this change with nothing holding it.
//
// A sweep that silently stopped working would leave every run green while
// leftovers accumulated, in a directory where a stray file is exactly what
// section 3's refusal exists to refuse to build on.
//
// IT PLANTS ITS OWN RESIDUE, which is the same limit sections 1–3 carry and is
// stated here for the same reason: this proves the sweep removes a staging file
// that reaches it, NOT that a real kill between the write and the rename
// produces exactly this. Nothing here can land a SIGKILL in a window that is
// microseconds wide on purpose. Section 6 is what says the window is the only
// place such a file can come from.

const STAGING_PREFIX = '.ci.yml.staging-';
const sandboxWorkflowDir = path.dirname(sandboxWorkflow);
const plantedName = `${STAGING_PREFIX}424243`;
const plantedPath = path.join(sandboxWorkflowDir, plantedName);

const plantStagingFile = () => {
  fs.writeFileSync(plantedPath,
    `# ${MARKER_TAG} — row C (\`continue-on-error: true\` on the job), pid 424243, started 2026-08-05T00:00:00.000Z\n` +
    '# IF YOU ARE READING THIS IN `git status`, THAT RUN DIED BETWEEN THE WRITE AND THE RENAME.\n');
};

staging: {
  // ANTI-DRIFT: the prefix above is retyped rather than imported, so it can go
  // stale silently and leave this section planting a file the sweep was never
  // looking for — which would pass while proving nothing.
  const targetSource = fs.readFileSync(path.join(repoRoot, TARGET_REL), 'utf8');
  check(targetSource.includes(`'${STAGING_PREFIX}'`),
    `PRECONDITION: the target still names ${JSON.stringify(STAGING_PREFIX)} as its staging prefix — retyped here, ` +
    'so a rename in the target would otherwise leave this section sweeping for a file nothing writes',
    `found in ${TARGET_REL}: ${targetSource.includes(`'${STAGING_PREFIX}'`)}`);

  restoreSandbox();
  plantStagingFile();
  check(fs.existsSync(plantedPath), 'PRECONDITION: the staging residue really is on disk before the run', plantedName);

  const r = runVariant(TARGET_REL);

  check(!fs.existsSync(plantedPath),
    'A RUN SWEEPS AWAY A STAGING FILE A PREVIOUS RUN LEFT — so the residue this change introduces does ' +
    'not accumulate, and the directory section 3 refuses over stays clean of it',
    `still present afterwards: ${fs.existsSync(plantedPath)}`);
  check(r.out.includes('swept') && r.out.includes(plantedName),
    '…and it SAYS SO, naming the file, rather than deleting something silently',
    (r.out.split('\n').find((l) => l.includes('swept')) ?? '(nothing said)').trim());
  check(r.code === 0 && r.out.includes('ALL CHECKS PASSED'),
    '…and the run was not otherwise disturbed by finding one — sweeping its own leftover is not a ' +
    'refusal, because unlike a dirty ci.yml a staging file cannot be somebody\'s work',
    `exit ${r.code}`);
  check(sandboxPorcelain() === '',
    '…and git still calls the tree clean, so the sweep did not reach for anything tracked');
}

// The red drive: starve the sweep and the leftover survives. This is the exact
// mutation the reviewer applied by hand to show nothing here was holding it.
noSweep: {
  const variant = mutateScript(
    'starve-the-staging-sweep',
    path.join(repoRoot, TARGET_REL),
    [{ find: '    swept = fs.readdirSync(workflowDir).filter((n) => n.startsWith(STAGING_PREFIX));',
      replace: '    swept = []; /* KAN-341: the sweep starved by the mutation */' }]
  );
  if (!variant) break noSweep;
  const rel = path.join('scripts', path.basename(variant));

  restoreSandbox();
  plantStagingFile();
  const r = runVariant(rel);

  check(fs.existsSync(plantedPath),
    'WITH THE SWEEP STARVED the leftover is still there afterwards — so the check above is measuring ' +
    'the sweep rather than a file that was never going to survive anything',
    `present afterwards: ${fs.existsSync(plantedPath)}`);
  check(!r.out.includes('swept'),
    '…and nothing in the run mentions it, which is what makes an unguarded sweep invisible: the run ' +
    'is green, the tree looks clean to git, and the leftovers accumulate',
    `exit ${r.code}`);

  try { fs.unlinkSync(plantedPath); } catch { /* the point of the section is that it is still there */ }
}

// ===========================================================================

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY, so their section did not run: ${skipped.join(', ')}`);
}
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
