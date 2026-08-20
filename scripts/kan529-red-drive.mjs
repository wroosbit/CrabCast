#!/usr/bin/env node
// KAN-529 RED DRIVE — can the teardown check fail, and did the one it replaced
// ever have a chance of failing?
//
// WHAT FAILURE THIS WOULD CATCH: a proof that sweeps up after itself and
// asserts it did, where the assertion cannot go red — either because the sweep
// is doing nothing and the check cannot tell, or because the check is asking a
// question whose answer was decided before the machine was consulted. The
// second is not hypothetical: it is what KAN-529 was filed for, and it survived
// review twice.
//
// ---------------------------------------------------------------------------
// THE ARMS
// ---------------------------------------------------------------------------
//
//   0. CONTROL           each proof, unmutated. Must exit 0, its boundary check
//                        must be GREEN, the sweep must report it actually SWEPT
//                        SOMETHING, and nothing may carry that run's TMPDIR
//                        afterwards. The third clause is the anti-vacuity one:
//                        "no survivors" from a sweep that found nothing is the
//                        same green as from a sweep that worked.
//
//   1. THE SWEEP         `scratch-processes.mjs` mutated so its kill is a
//      DISARMED          no-op. The boundary check must go RED **and** the
//                        processes must really still be there when this drive
//                        looks. Two independent readings, and the second is
//                        what stops the arm passing on a check that reddens for
//                        some unrelated reason.
//
//   2. ⚠ THE PRE-FIX     the teardown exactly as it was merged — kill
//      TEARDOWN,         `spawnedPids`, call `crabcast(['daemon','stop'])`,
//      RESTORED          assert the remembered pids are gone. The old check
//                        must go **GREEN** while this drive measures processes
//                        LEFT ALIVE. That conjunction is the defect itself,
//                        reproduced on demand: a proof reporting success at the
//                        moment it is leaking.
//
//   3. THE INSTRUMENT    `processesUnder` must FIND a process known to exist
//                        (a green from a query that cannot see anything is not
//                        a measurement), and `assertSweepableRoot` must REFUSE
//                        every root that would make the sweep dangerous.
//
//   4. THE ROOT CAUSE    `crabcast daemon stop` must still be a usage error.
//                        Pinned here so that if somebody ever adds the command,
//                        this arm reddens and the comments explaining why the
//                        old teardown could not work stop being true quietly.
//
// ⚠ WHY ARM 2 IS THE ONE WORTH READING. Arm 1 shows the NEW check discriminates.
// Only arm 2 shows the OLD one did not — and without it this drive would
// demonstrate that the fix works while saying nothing about whether there was
// anything to fix, which is the shape of red drive that gets written when
// nobody has watched the original fail.
//
// THE WORKING TREE IS NEVER TOUCHED: every arm runs a copy of `scripts/`.
//
// Usage:
//   npm run build
//   node scripts/kan529-red-drive.mjs

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';
import {
  processesUnder,
  killScratchRootSync,
  assertSweepableRoot,
  describe
} from './scratch-processes.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');

/** The two proofs KAN-529 is about, driven identically. */
const PROOFS = ['verify-launcher-args', 'verify-variadic-args-swallow-prompt'];

let failures = 0;
let checks = 0;

const report = {
  pass: (label, detail = '') => {
    checks += 1;
    console.log(`  PASS  ${label}${detail ? `\n          ${detail}` : ''}`);
  },
  fail: (label, detail = '') => {
    checks += 1;
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
};
const check = (ok, label, detail = '') => (ok ? report.pass(label, detail) : report.fail(label, detail));
const rule = (title) => console.log(`\n${title}\n${'='.repeat(title.length)}`);

// SHORT ON PURPOSE — see `runProof`: every run's TMPDIR hangs off this, and a
// scratch root plus its `data/` hangs off that, against a 104-character unix
// socket limit.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc529r-'));

// The same symlink every drive in this suite needs: a mutated copy of
// `scripts/` resolves its imports by walking UP, so without this its siblings
// find no `node_modules` and every arm dies at import time — a failure that
// reads as "the proof caught the mutation" on every arm at once.
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

function cleanUp() {
  let swept = 0;
  try { swept = killScratchRootSync(scratch); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  return swept;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    const swept = cleanUp();
    console.log(`\n[kan529-red-drive] ${signal} — killed ${swept} process(es) carrying ` +
      `${scratch} and removed it`);
    process.exit(130);
  });
}

// `distDir` here is the directory the MUTANTS ARE COPIED FROM, and for this
// drive that is `scripts/` rather than `dist/`: what KAN-529 is about lives in
// the proofs and in their sweeper, not in the compiled daemon. The exact-count
// discipline is the reason to use this helper rather than a private copy — an
// edit that matches zero or three times is a counted FAILURE here, never a
// silently unmutated copy that the arm below would then report success about.
const { mutate, mutationsSkipped } = makeMutator({ distDir: scriptDir, scratch, report });

/**
 * Run one proof, from `fromScripts`, with a TMPDIR nothing else uses.
 *
 * ⚠ THE TMPDIR IS THE MEASUREMENT. `os.tmpdir()` honours it, so every scratch
 * root the proof makes — and therefore its daemon's config path and its shims'
 * executable paths — sits under a directory unique to this one run. What is
 * still carrying it after the process has exited outlived that run and could
 * not have come from anywhere else.
 */
let runSeq = 0;
function runProof(name, fromScripts, label) {
  // ⚠ SHORT DIRECTORY NAMES, AND THE REASON IS NOT TIDINESS. The daemon
  // refuses a `dataDir` whose unix socket path would exceed 104 characters,
  // and a scratch root sits BELOW this directory with its own mkdtemp segment
  // and a `data/` under that. Naming these after the proof — `tmpdir-control-
  // verify-variadic-args-swallow-prompt` — pushed the socket path to 124 and
  // the daemon refused to start.
  //
  // ⚠ THAT FAILED TOWARD CLEAN, which is why it gets a comment and a
  // precondition rather than a shorter string. No daemon started, so nothing
  // could leak, so the sweep found nothing and every teardown check passed on
  // a run that had proved nothing. Measured here on 2026-08-18: the control
  // arm reported `0 swept` and stayed green on that clause while 30 other
  // checks in the same run were red.
  runSeq += 1;
  const slot = `run-${String(runSeq).padStart(4, '0')}`;
  const tmpdir = path.join(scratch, slot);
  const home = path.join(scratch, `${slot}-h`);
  fs.mkdirSync(tmpdir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (tmpdir.length > 55) {
    throw new Error(
      `TMPDIR ${tmpdir} is ${tmpdir.length} characters; a scratch root and its data/ go ` +
        `underneath it and the daemon refuses a socket path over 104. Shorten the scratch root.`
    );
  }

  const res = spawnSync(
    process.execPath,
    [path.join(fromScripts, `${name}.mjs`), distDir, repoRoot],
    {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: tmpdir, HOME: home },
      encoding: 'utf8',
      timeout: 900_000
    }
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { exit: res.status, out, tmpdir, survivors: processesUnder(tmpdir) };
}

/** Reap whatever an arm deliberately left alive, so the next arm is clean. */
function reap(tmpdir) {
  try { return killScratchRootSync(tmpdir); } catch { return 0; }
}

/**
 * The verdict on the boundary check, read off the proof's own output.
 *
 * Matched on the stable half of each label rather than the whole sentence, so
 * that rewording the check does not silently stop this drive from finding it —
 * and `null` when neither is present, which is a THIRD answer and not a red:
 * an arm that cannot find the line has not measured it passing or failing.
 */
function boundaryVerdict(out) {
  const NEW = 'every process carrying this run';
  const OLD = 'every process this proof started is gone';
  for (const line of out.split('\n')) {
    if (!line.includes(NEW) && !line.includes(OLD)) continue;
    if (line.trim().startsWith('PASS')) return { verdict: 'PASS', line: line.trim() };
    if (line.trim().startsWith('FAIL')) return { verdict: 'FAIL', line: line.trim() };
  }
  return { verdict: null, line: '(the boundary check printed no PASS/FAIL line this drive could find)' };
}

/** What the control's detail line says the sweep actually swept. */
function sweptCount(out) {
  const m = out.match(/^\s+(\d+) swept \((\d+) of them never in spawnedPids\)/m);
  return m ? { swept: Number(m[1]), untracked: Number(m[2]) } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
rule('0. CONTROL — unmutated, green, and the sweep really swept something');
// ===========================================================================
const controls = {};
for (const proof of PROOFS) {
  const run = runProof(proof, scriptDir, `control-${proof}`);
  controls[proof] = run;
  check(run.exit === 0, `[${proof}] passes unmutated`, `exit ${run.exit}`);

  const b = boundaryVerdict(run.out);
  check(b.verdict === 'PASS', `[${proof}] its boundary check is GREEN to start with`, b.line);

  // ⚠ THE ANTI-VACUITY CLAUSE. "No survivors" is the same green whether the
  // sweep cleaned up four processes or never found one, and only the first
  // means the instrument is working.
  const s = sweptCount(run.out);
  check(
    s !== null && s.swept > 0 && s.untracked > 0,
    `[${proof}] and the sweep swept processes the old pid set never held`,
    s === null ? 'could not read the swept count off the output' :
      `${s.swept} swept, ${s.untracked} of them never in spawnedPids`
  );

  check(
    run.survivors.length === 0,
    `[${proof}] nothing carries its TMPDIR once it has exited`,
    run.survivors.length ? describe(run.survivors) : `none under ${run.tmpdir}`
  );
  reap(run.tmpdir);
}

if (Object.values(controls).some((r) => r.exit !== 0)) {
  console.log('\n  ⚠ a control is red, so every arm below would measure the harness rather ' +
    'than the proof. Stopping.\n');
  for (const [proof, run] of Object.entries(controls)) {
    if (run.exit !== 0) console.log(`--- ${proof} ---\n${run.out.split('\n').slice(-30).join('\n')}`);
  }
  cleanUp();
  process.exit(1);
}

// ===========================================================================
rule('1. THE SWEEP DISARMED — the new check must go RED, and really leak');
// ===========================================================================
{
  const mutant = mutate('sweep-disarmed', 'scratch-processes.mjs',
    '        process.kill(pid, signal);',
    '        void pid; void signal; // KAN-529 red drive: the kill, removed.');

  if (mutant) {
    for (const proof of PROOFS) {
      const run = runProof(proof, mutant, `disarmed-${proof}`);
      const b = boundaryVerdict(run.out);

      check(
        b.verdict === 'FAIL',
        `[${proof}] ⚠ THE BOUNDARY CHECK GOES RED when the sweep stops killing`,
        b.line
      );
      check(
        run.exit !== 0,
        `[${proof}] and the proof's exit code carries it`,
        `exit ${run.exit}`
      );
      // THE SECOND, INDEPENDENT READING. Without it this arm would pass on a
      // check that reddened for any reason at all.
      check(
        run.survivors.length > 0,
        `[${proof}] and the processes are MEASURABLY still there, which is what the ` +
          `check was reporting`,
        run.survivors.length ? `${run.survivors.length} alive:\n          ${describe(run.survivors)}`
          : 'nothing survived — so the red above was not about a leak'
      );
      const reaped = reap(run.tmpdir);
      console.log(`          (this drive reaped ${reaped} of them)`);
    }
  }
}

// ===========================================================================
rule('2. ⚠ THE PRE-FIX TEARDOWN — the merged check goes GREEN while leaking');
// ===========================================================================
//
// The replacement below is the teardown exactly as it shipped: SIGKILL the pids
// the script added by hand, call a command that does not exist, wait, and ask
// whether the remembered pids are gone. They are — they were killed on the line
// above — so the check passes, and says so in the words it shipped with.
{
  const PRE_FIX = `  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  crabcast(['daemon', 'stop']);
  await new Promise((r) => setTimeout(r, 500));
  const survivors = [...spawnedPids].filter((pid) => {
    try { fs.readFileSync(\`/proc/\${pid}/cmdline\`); return true; } catch { return false; }
  });
  check(
    survivors.length === 0,
    'every process this proof started is gone',
    survivors.length ? \`still alive: \${survivors.join(', ')}\` : \`\${spawnedPids.size} ended\`
  );`;

  // ⚠ THIS MUST TRACK THE PROOFS' ACTUAL TEXT. `mutate` requires exactly one
  // occurrence, so if the boundary block is edited and this constant is not,
  // the arm reports a COUNTED FAILURE ("expected exactly 1 occurrence … found
  // 0") rather than silently running an unmutated copy and calling it a pass.
  // The precondition check below joined the block when KAN-529's review found
  // that the boundary check passed vacuously on a run whose daemon never
  // started.
  const CURRENT = `  const { found, survivors } = await sweepScratchRoot(tmp);

  check(
    found.length > 0,
    '(precondition) the sweep had something to sweep — so the verdict below is about a ' +
      'teardown rather than about a run that never started',
    \`\${found.length} process(es) carried \${tmp}\`
  );
  check(
    survivors.length === 0,
    'every process carrying this run\\'s scratch root is gone — the daemon and its ' +
      'attaches included, not merely the pids this script remembered',
    survivors.length
      ? \`still alive:\\n          \${describe(survivors)}\`
      : \`\${found.length} swept (\${found.length - spawnedPids.size} of them never in spawnedPids)\`
  );`;

  const mutant = mutate('pre-fix-teardown',
    PROOFS.map((p) => ({ file: `${p}.mjs`, find: CURRENT, replace: PRE_FIX })));

  if (mutant) {
    for (const proof of PROOFS) {
      const run = runProof(proof, mutant, `prefix-${proof}`);
      const b = boundaryVerdict(run.out);

      check(
        b.verdict === 'PASS',
        `[${proof}] the pre-fix check reports SUCCESS`,
        b.line
      );
      check(
        run.exit === 0,
        `[${proof}] and the whole proof exits 0 — nothing anywhere reports a problem`,
        `exit ${run.exit}`
      );
      // ⚠ THE CONJUNCTION IS THE FINDING. Neither line above is a defect on its
      // own; together they are a proof announcing that it cleaned up while the
      // machine says otherwise.
      check(
        run.survivors.length > 0,
        `[${proof}] ⚠ WHILE ${run.survivors.length} PROCESS(ES) IT CAUSED ARE STILL RUNNING — ` +
          `the green above is the defect KAN-529 was filed for`,
        run.survivors.length ? describe(run.survivors)
          : 'nothing survived, so this machine did not reproduce the leak'
      );
      const reaped = reap(run.tmpdir);
      console.log(`          (this drive reaped ${reaped} of them)`);
    }
  }
}

// ===========================================================================
rule('3. THE INSTRUMENT — it can see a process, and it refuses a bad root');
// ===========================================================================
{
  // POSITIVE CONTROL. `processesUnder` returning an empty list is the answer
  // every arm above reads as success, so a version that could never return
  // anything would make all of them vacuous.
  const probeRoot = path.join(scratch, 'instrument-probe');
  fs.mkdirSync(probeRoot, { recursive: true });
  const marker = path.join(probeRoot, 'a-process-that-carries-this-path');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', marker], {
    detached: true, stdio: 'ignore'
  });
  child.unref();
  await sleep(400);

  const seen = processesUnder(probeRoot);
  check(
    seen.length === 1 && seen[0].pid === child.pid,
    'processesUnder FINDS a process that carries the root — so an empty answer elsewhere ' +
      'is a fact about the machine and not about the query',
    `found ${seen.length}: ${describe(seen)}`
  );

  const killed = killScratchRootSync(probeRoot);
  await sleep(300);
  check(
    killed === 1 && processesUnder(probeRoot).length === 0,
    'and killScratchRootSync ends it',
    `signalled ${killed}, ${processesUnder(probeRoot).length} left`
  );

  // THE REFUSALS. This sweep SIGKILLs what it matches, on a machine running
  // the live fleet, so a root that would match too much must be refused rather
  // than warned about.
  const dangerous = [
    ['', 'the empty string'],
    ['relative/path', 'a relative path'],
    ['/', 'the filesystem root'],
    [os.tmpdir(), 'the temp directory itself'],
    [path.join(os.tmpdir(), 'ab'), 'a leaf too short to be a mkdtemp root']
  ];
  for (const [root, what] of dangerous) {
    let refused = false;
    try { assertSweepableRoot(root); } catch { refused = true; }
    check(refused, `assertSweepableRoot REFUSES ${what}`, JSON.stringify(root));
  }
}

// ===========================================================================
rule('4. THE ROOT CAUSE — `crabcast daemon stop` is still not a command');
// ===========================================================================
//
// Every comment written for KAN-529 says the old teardown could not have worked
// because this call is a usage error nobody read. If somebody adds the command,
// that reasoning becomes false and this arm is what notices.
{
  const probe = path.join(scratch, 'daemon-stop-probe');
  fs.mkdirSync(probe, { recursive: true });
  const res = spawnSync(
    process.execPath,
    [path.join(distDir, 'cli.js'), '--config', path.join(probe, 'crabcast.config.json'),
      'daemon', 'stop'],
    { encoding: 'utf8', timeout: 60_000 }
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  check(
    res.status !== 0,
    '`crabcast daemon stop` exits non-zero — it never stopped anything',
    `exit ${res.status}`
  );
  check(
    /takes no arguments/.test(out),
    'and says so as a usage error rather than failing silently',
    out.trim().split('\n')[0]
  );
}

// ---------------------------------------------------------------------------
if (mutationsSkipped().length) {
  console.log(`\n⚠ mutations that did not apply: ${mutationsSkipped().join(', ')}`);
}
console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

cleanUp();

process.exit(failures ? 1 : 0);
