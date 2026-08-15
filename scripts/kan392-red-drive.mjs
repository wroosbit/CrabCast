#!/usr/bin/env node
// KAN-392 RED DRIVE — back the behaviour out and watch it go red.
//
// WHAT FAILURE THIS WOULD CATCH: a runner that reports isolation it does not
// perform. `scripts/run-verify.mjs` prints "no key matching this suite's
// scratch prefixes was added to it" at the end of every run, and that sentence
// would print unchanged if the `HOME` it sets were being ignored, if the build
// had stopped resolving its config path from `$HOME`, or if its own before/after
// count were comparing a number to itself. All three go green forever while
// every proof writes into the operator's real `~/.claude.json`. Each arm below
// removes one and requires the NAMED outcome, not merely a non-zero exit.
//
// ---------------------------------------------------------------------------
// ⚠ NOTHING HERE RUNS AGAINST THE OPERATOR'S REAL $HOME
// ---------------------------------------------------------------------------
//
// Arms 0 and 1 run the runner under a SIMULATED operator home — a scratch
// directory seeded with a `.claude.json` — so that `os.homedir()` inside the
// runner answers there. Arm 1 deliberately breaks the isolation, and the whole
// point of an arm that breaks isolation is that something then gets written; it
// is written into the simulation. The real config is never a target and never a
// subject, and this drive asserts at the end that it did not move.
//
// That is also why the control the ticket sketched — "the same proof run
// WITHOUT the runner adds exactly one key to the real file" — is taken this way
// instead. It is the same measurement with the same instrument; what it does
// not do is add a permanent key to a file KAN-392 forbids us to remove one from.
//
// ---------------------------------------------------------------------------
// MUTATIONS ARE IN PLACE, BY EXACT COUNT, AND RESTORED
// ---------------------------------------------------------------------------
//
// The subjects are tracked files that the shipped mechanism reads from disk —
// `scripts/run-verify.mjs`, `src/launchers.ts`, `.github/workflows/ci.yml` — so
// a scratch copy would be a copy of the thing rather than the thing. Every
// patch asserts EXACTLY ONE occurrence of its anchor before applying (a
// mutation that hit nothing is a refusal, never an unmutated run reported as a
// successful red drive), every patch is undone in a `finally`, a signal handler
// restores on interrupt, and §5 requires `git status --porcelain` to be
// byte-identical to what it was before this script started.
//
// ⚠ IT READS THE OUTPUT, NOT ONLY THE EXIT CODE. A non-zero exit from a run
// that never reached the mechanism — a syntax error in the mutant, a missing
// build — is a plausible-looking red that is evidence about nothing. Every arm
// asserts on the sentence the arm was designed to produce.
//
// ARM 2 REBUILDS THE TREE TWICE and restores `src/launchers.ts` between them.
//
// Usage:
//   npm run build
//   node scripts/kan392-red-drive.mjs

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

/** The proof the arms drive. In the CI array, and one of the six that leak. */
const SUBJECT = 'verify-refuses-occupied-directory';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan392-drive-'));

/**
 * A child killed by a signal did not answer the question the arm asked.
 *
 * ⚠ MEASURED, 2026-08-14: this drive was run on a machine at load average 23
 * and arms 1 and 2 both came back with `status: null` — the mutated runner and
 * `npm run build` were each SIGKILLed part-way. Read as exit codes those are
 * two failing arms, and they read EXACTLY like a mutation that did not go red:
 * "the mutated run exits 1 — exit null", "the mutant build compiled — npm run
 * build exited null". Both are non-answers wearing a verdict's clothes, and the
 * comfortable misreading is available in both directions — an arm that never
 * ran can look like a mechanism that failed, and on a different day like one
 * that held. So a signalled child is reported as INCONCLUSIVE by name, the arm
 * is skipped rather than judged, and the run still goes red: this drive has not
 * established anything and must not print as though it had.
 */
const signalOf = (r) => (r.status === null ? (r.signal ?? 'an unknown signal') : null);

// ---------------------------------------------------------------------------
// In-place patching with an exact-count anchor and a guaranteed restore.
// ---------------------------------------------------------------------------

/** Files this run has modified, so a crash or a Ctrl+C still puts them back. */
const open = new Map();

/**
 * Backups that survive this process, because SIGKILL cannot be caught.
 *
 * ⚠ MEASURED on the same run as the note above: this machine kills children
 * under load, and a SIGKILL delivered to THIS script would leave a mutated
 * tracked file in the working tree with no handler having run. `git checkout`
 * is not the recovery — the subjects carry uncommitted work — so a copy of each
 * file as it was goes here BEFORE the write, the path is printed at the moment
 * of patching, and the directory is removed only on a clean finish. A leftover
 * directory is therefore itself the signal that a run died mid-patch.
 */
const restoreDir = path.join(os.tmpdir(), `kan392-drive-restore-${process.pid}`);

function restoreAll() {
  for (const [file, original] of open) fs.writeFileSync(file, original);
  open.clear();
  fs.rmSync(restoreDir, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restoreAll();
  console.error(e);
  process.exit(1);
});

/**
 * Replace `find` with `replace` in a tracked file, exactly once.
 *
 * @returns true when it applied. A false is already counted as a failure, and
 *          the caller must skip its arm — an arm that runs against an unmutated
 *          file reports the strongest available result at the moment it tested
 *          nothing.
 */
function patch(rel, find, replace) {
  const file = path.join(repoRoot, rel);
  const before = fs.readFileSync(file, 'utf8');
  const count = before.split(find).length - 1;
  if (count !== 1) {
    check(false, `mutation anchor in ${rel} is unique`, `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 60))}, found ${count}. Fix the mutation, not this check.`);
    return false;
  }
  if (find === replace) {
    check(false, `mutation in ${rel} changes something`, 'find === replace');
    return false;
  }
  if (!open.has(file)) {
    open.set(file, before);
    fs.mkdirSync(restoreDir, { recursive: true });
    const backup = path.join(restoreDir, rel.replace(/[/\\]/g, '__'));
    fs.writeFileSync(backup, before);
    console.log(`  (patching ${rel}; if this run is killed: cp ${backup} ${file})`);
  }
  fs.writeFileSync(file, before.replace(find, replace));
  return true;
}

function unpatch(rel) {
  const file = path.join(repoRoot, rel);
  const original = open.get(file);
  if (original !== undefined) {
    fs.writeFileSync(file, original);
    open.delete(file);
  }
}

const gitStatus = () =>
  spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '';

const statusBefore = gitStatus();

// ---------------------------------------------------------------------------
// The simulated operator home, and the instrument that reads it.
// ---------------------------------------------------------------------------

const sim = path.join(tmp, 'sim-operator-home');
fs.mkdirSync(sim, { recursive: true });
const simConfig = path.join(sim, '.claude.json');
const seed = {
  projects: {
    '/home/someone/repo-a': { hasTrustDialogAccepted: true },
    '/home/someone/repo-b': { hasTrustDialogAccepted: true }
  }
};
const reseed = () => fs.writeFileSync(simConfig, JSON.stringify(seed, null, 2));
const simKeys = () =>
  Object.keys(JSON.parse(fs.readFileSync(simConfig, 'utf8')).projects ?? {}).length;

/** Run the runner under the simulated home. Returns { status, out }. */
function runRunner(label, extra = []) {
  const root = path.join(tmp, `root-${label}`);
  const r = spawnSync(
    process.execPath,
    [path.join('scripts', 'run-verify.mjs'), '--root', root, SUBJECT, ...extra],
    { cwd: repoRoot, env: { ...process.env, HOME: sim }, encoding: 'utf8' }
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const realConfig = path.join(os.homedir(), '.claude.json');
const realKeysBefore = fs.existsSync(realConfig)
  ? Object.keys(JSON.parse(fs.readFileSync(realConfig, 'utf8')).projects ?? {}).length
  : 0;

try {
  // =========================================================================
  // 0. CONTROL. The runner unmutated. A red drive whose baseline is not
  //    demonstrated measures the runner as much as the assertion.
  // =========================================================================

  console.log(`=== 0. control: the runner, unmutated, on ${SUBJECT} ===\n`);

  reseed();
  const control = runRunner('control');

  check(control.status === 0, 'the control run exits 0', `exit ${control.status}`);
  check(
    control.out.includes('HOME redirection reaches the shipped path'),
    'it got past §0 — the shipped path was observed following $HOME'
  );
  check(
    control.out.includes(`--- ${SUBJECT} PASSED`),
    'the proof ran and passed',
    'so this arm is about isolation, not about a broken proof'
  );
  check(
    /1 trust key\(s\) landed in its scratch HOME/.test(control.out),
    'exactly 1 trust key landed in the proof\'s scratch HOME',
    'the write happened — this arm is not green for want of a write'
  );
  check(
    control.out.includes("PASS  no key matching this suite's scratch prefixes was added to it"),
    'and the runner reports the simulated operator config untouched'
  );
  check(simKeys() === 2, 'the simulated operator config still holds its 2 seeded keys', `${simKeys()} found`);

  // =========================================================================
  // 1. ISOLATION REMOVED. The runner stops handing the child a scratch HOME.
  //    This is the defect KAN-392 was filed about, reproduced.
  // =========================================================================

  console.log('\n=== 1. red: the runner no longer sets HOME for the child ===\n');

  arm1: {
    if (!patch('scripts/run-verify.mjs', 'env: { ...process.env, HOME: home },', 'env: { ...process.env },')) break arm1;

    reseed();
    const red = runRunner('no-home');

    const redSignal = signalOf(red);
    if (redSignal) {
      check(
        false,
        'ARM 1 INCONCLUSIVE — the mutated runner was killed, not judged',
        `killed by ${redSignal}. This arm proved nothing in either direction; it is NOT evidence ` +
          `that the isolation check failed to go red. Re-run on a quieter machine.`
      );
      unpatch('scripts/run-verify.mjs');
      break arm1;
    }

    check(red.status === 1, 'the mutated run exits 1', `exit ${red.status}`);
    check(
      red.out.includes(`--- ${SUBJECT} PASSED`),
      'the proof itself still PASSED',
      'so the red below is the isolation check and not a proof failure — the two are distinguishable'
    );
    check(
      /FAIL\s+1 key\(s\) matching this suite's scratch prefixes appeared in the real config/.test(red.out),
      'and the runner FAILS by name on the key that appeared',
      'the sentence "no key … was added to it" is a measurement, not a constant'
    );
    check(
      simKeys() === 3,
      'the simulated operator config gained EXACTLY ONE key',
      `2 seeded, ${simKeys()} now — one per scratch directory, exactly as the ticket measured`
    );
    check(
      /0 trust key\(s\) landed in its scratch HOME/.test(red.out),
      'and nothing landed in the scratch HOME',
      'which is where the key went instead in the control — the two arms account for the same write'
    );

    unpatch('scripts/run-verify.mjs');
  }

  // =========================================================================
  // 2. THE BUILD STOPS FOLLOWING $HOME. The runner's §0 must REFUSE, because
  //    a HOME nothing reads is a redirect that isolates nothing.
  // =========================================================================

  console.log('\n=== 2. red: a build whose config path ignores $HOME ===\n');

  const decoy = path.join(tmp, 'decoy', '.claude.json');
  arm2: {
    if (
      !patch(
        'src/launchers.ts',
        `return path.join(os.homedir(), '.claude.json');`,
        `return ${JSON.stringify(decoy)};`
      )
    )
      break arm2;

    const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
    // Read the build's own status, not a pipeline's: a proof run after a failed
    // build runs on the previous dist and both of its outcomes mislead.
    const buildSignal = signalOf(build);
    if (buildSignal) {
      check(
        false,
        'ARM 2 INCONCLUSIVE — the mutant build was killed, not failed',
        `npm run build was killed by ${buildSignal}. Nothing was compiled and nothing was ` +
          `measured; this is not evidence that the runner failed to refuse. Re-run on a quieter ` +
          `machine.`
      );
      unpatch('src/launchers.ts');
      spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
      break arm2;
    }
    if (build.status !== 0) {
      check(false, 'the mutant build compiled', `npm run build exited ${build.status} — ${(build.stdout ?? '').split('\n').slice(-6).join(' | ')}`);
      unpatch('src/launchers.ts');
      spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
      break arm2;
    }
    check(true, 'the mutant build compiled', 'exit 0, so what follows ran against the mutation');

    reseed();
    const refused = runRunner('ignores-home');

    check(refused.status === 2, 'the runner REFUSES — exit 2, "could not run", not a proof verdict', `exit ${refused.status}`);
    check(refused.out.includes('REFUSING TO RUN'), 'and says so');
    check(
      refused.out.includes('does not resolve its global config from $HOME'),
      'naming the reason rather than failing generically'
    );
    check(
      !refused.out.includes(`--- ${SUBJECT} ---`),
      'and no proof was started at all',
      'the refusal is before the run, which is the only place it is worth anything'
    );
    check(simKeys() === 2, 'nothing was written to the simulated operator config', `${simKeys()} keys`);

    unpatch('src/launchers.ts');
    const rebuild = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
    check(rebuild.status === 0, 'the tree rebuilds clean after the mutation is backed out', `exit ${rebuild.status}`);
  }

  // =========================================================================
  // 3. THE NEW PROOF UNWIRED. Dropping it from the ci.yml array — the merge
  //    resolution this repository has already paid for six times — must be a
  //    red naming it, not a quieter suite.
  // =========================================================================

  console.log('\n=== 3. red: the new proof dropped from the ci.yml array ===\n');

  arm3: {
    if (!patch('.github/workflows/ci.yml', '            verify-trust-write-follows-home\n', '')) break arm3;

    const reg = spawnSync(process.execPath, [path.join('scripts', 'verify-proof-registry.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    const out = `${reg.stdout ?? ''}${reg.stderr ?? ''}`;

    check(reg.status === 1, 'verify-proof-registry exits 1', `exit ${reg.status}`);
    check(
      /FAIL\s+scripts\/verify-trust-write-follows-home\.mjs is accounted for/.test(out),
      'and fails BY NAME on the proof that was dropped',
      'a red that does not name it sends the reader through 76 entries'
    );

    unpatch('.github/workflows/ci.yml');
    const back = spawnSync(process.execPath, [path.join('scripts', 'verify-proof-registry.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    check(back.status === 0, 'and goes green again once it is restored', `exit ${back.status}`);
  }

  // =========================================================================
  // 4. NOT DRIVEN HERE, AND SAID SO RATHER THAN LEFT TO INFERENCE.
  // =========================================================================

  console.log('\n=== 4. what this drive does not cover ===\n');
  console.log(
    "  verify-trust-write-follows-home §1 — 'the shipped path resolves inside the scratch home' —\n" +
      '  carries its own mutation (§6 of that file), so it is not repeated here.\n' +
      '  NOBODY drives the claim that anyone USES the runner. Every proof header still documents\n' +
      '  `node scripts/verify-<name>.mjs`, which writes to the real config, and no check in this\n' +
      '  repository can see a route somebody takes at their own shell. That is the gap KAN-392\n' +
      '  weighed a register-shaped sweep for and deferred; it is open.\n'
  );

  // =========================================================================
  // 5. THE TREE IS AS IT WAS.
  // =========================================================================

  console.log('=== 5. restore ===\n');
} finally {
  restoreAll();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const statusAfter = gitStatus();
check(
  statusAfter === statusBefore,
  'git status --porcelain is byte-identical to what it was before this drive',
  statusAfter === statusBefore
    ? 'every mutation was backed out'
    : `before:\n${statusBefore}\nafter:\n${statusAfter}`
);

const realKeysAfter = fs.existsSync(realConfig)
  ? Object.keys(JSON.parse(fs.readFileSync(realConfig, 'utf8')).projects ?? {}).length
  : 0;
check(
  realKeysAfter === realKeysBefore,
  "the operator's real ~/.claude.json was not written by this drive",
  `${realKeysBefore} keys before, ${realKeysAfter} after` +
    (realKeysAfter === realKeysBefore ? '' : ' — another local run on this machine can also add keys; re-run alone')
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
