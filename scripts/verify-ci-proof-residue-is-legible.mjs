#!/usr/bin/env node
// The one proof in this suite that edits a TRACKED file has to survive being
// killed, and has to refuse to build on what a killed run left behind.
//
// WHAT FAILURE THIS WOULD CATCH: `scripts/verify-ci-wiring-guards.mjs` snapshots
// `.github/workflows/ci.yml` off disk at startup and restores that snapshot at
// the end. Started over a previous run's residue it therefore adopts the
// RESIDUE as its baseline, restores the residue, and PASSES its own
// "byte-identical to how this run found it" check — because the file does match
// what it found. Section 4 below runs the version that shipped on `main` at
// 0edd2c1 over a seeded residue and shows it print ALL CHECKS PASSED, exit 0,
// and leave the corrupted workflow in the tree. A cleanup assertion reporting an
// all-clear over a corrupted tracked file is the failure-as-success shape this
// epic exists to catch, sitting in the cleanup path of the script that guards CI.
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
// thing silently is worse than one that differs loudly: the clone's `origin` is
// this working tree rather than GitHub, so it has no `main` ref and the target's
// own section 2 — which loads the PRE-FIX ci-workflow parser out of
// `origin/main` — reports NOT RUN there. That section is KAN-148's subject, not
// this one's, it asserts nothing when it does not run, and it runs for real on
// every PR from the `verify` job's full-history checkout. Section 0 below
// requires the target to go GREEN in the sandbox before anything else is
// measured, so a sandbox that had broken the target in some other way is a
// failed precondition rather than a quiet distortion of every section after it.
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
//             baseline. Section 4 is that run.
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
    [{ find: 'fs.writeFileSync(workflowPath, markerFor(id, what) + yaml);',
      replace: 'fs.writeFileSync(workflowPath, yaml); /* marker removed by the mutation */' }]
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
rule('4. THE DEFECT, REPRODUCED AGAINST THE VERSION THAT SHIPPED ON main');
// ===========================================================================
//
// Sections 1–3 are a table of greens that could equally well describe a script
// that was always right. This is where the claim earns its keep: the SAME seeded
// residue, through the target as `origin/main` carries it, showing a run that
// absorbs the residue and reports an all-clear over it.
//
// WHEN THE PRE-FIX SOURCE IS UNREACHABLE — a shallow clone with no `origin/main`,
// or a run on `main` after this has merged, where `origin/main` IS this code —
// that is ANNOUNCED and asserts nothing. It is not a pass. Section 5 is the
// durable half for exactly that reason: it backs the fix out of the CURRENT code
// and gets the same result, and it keeps working after this merges.

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
  console.log(`  NOT RUN — ${preFix.why}.`);
  console.log('  NOTHING IS ASSERTED IN THIS SECTION. It is not a pass. What is missing is the');
  console.log('  demonstration that the shipped version absorbed the residue; section 5 below makes');
  console.log('  the same measurement against the current code with the fix backed out, and the run');
  console.log('  on the KAN-172 pull request has this section live.');
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

// ===========================================================================
rule('5. THE REFUSAL CHECKED GOING RED — back it out of the CURRENT code and the residue is absorbed again');
// ===========================================================================
//
// The durable half of section 4: it measures the code in this tree rather than a
// ref that stops being pre-fix the moment this merges. Same seeded residue, same
// two observations.

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

// ===========================================================================

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY, so their section did not run: ${skipped.join(', ')}`);
}
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
