#!/usr/bin/env node
// KAN-529 SUITE SURVEY — which proofs leave processes behind on a run that
// SUCCEEDS, measured per file rather than asserted as a class.
//
// WHY THIS IS A SURVEY AND NOT A PROOF. KAN-529 asks, as its third item, to
// "sweep the suite for the same shape before assuming it is one file's problem,
// and report what was measured per file rather than a blanket claim." That is a
// measurement to be run and reported, not a gate: it runs every proof in the CI
// list end to end, which is minutes rather than seconds, and its answer is a
// table for a ticket. The GATE that keeps the class from coming back is
// `verify-proof-teardown-sweeps.mjs`, which is static and cheap and runs in CI.
//
// ⚠ WHAT MAKES THE COUNT ATTRIBUTABLE. Each script gets its own `TMPDIR` and
// its own `HOME`, so every scratch root that script creates — and therefore the
// config path on its daemon's process table, and the shim paths under it — sits
// beneath a directory unique to that one run. Nothing here matches on a pattern
// broad enough to see another script's processes, or the live fleet's. This is
// the same isolation `verify-proof-cleans-up-when-interrupted.mjs` uses, and
// for the same reason.
//
// ⚠ AND WHAT MAKES IT A DIFFERENT QUESTION FROM THAT FILE'S. That proof asks
// what an INTERRUPTED run leaves behind. This asks what a SUCCESSFUL one does.
// The two are not the same question and the gap between them is exactly where
// KAN-529 lived: `verify-launcher-args` exited 0, printed `53/53 checks passed`
// and `every process this proof started is gone`, and left four processes up.
// No interrupt was involved, so nothing in the suite was looking.
//
// THE SURVEY REAPS WHAT IT FINDS. Leaving the survivors up would make the next
// script's measurement wrong and would do to this machine exactly what the
// defect does.
//
// Usage:
//   npm run build
//   node scripts/kan529-suite-leak-survey.mjs            # the CI list
//   node scripts/kan529-suite-leak-survey.mjs a.mjs b.mjs # named scripts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { readVerifyArray } from './ci-workflow.mjs';
import { processesUnder, killScratchRootSync, describe } from './scratch-processes.mjs';

/**
 * How long to let signalled processes actually leave the table before calling
 * what remains a leak, and how often to look. See the poll below for why this
 * is a wait-for-zero rather than a fixed sleep.
 */
const LEAK_SETTLE_MS = 5_000;
const LEAK_POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const named = process.argv.slice(2);
const targets = named.length
  ? named.map((n) => path.basename(n, '.mjs'))
  : readVerifyArray(fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'))
      .entries.map((e) => e.name);

if (targets.length === 0) {
  console.log('no targets — could not read the CI list and none were named.');
  process.exit(1);
}

// SHORT ON PURPOSE. Every script's TMPDIR hangs off this, its own mkdtemp
// scratch root hangs off that, and a `data/` under that again — against a
// 104-character unix socket limit the daemon REFUSES to exceed. A long name
// here stops the daemon starting, and that failure looks exactly like a clean
// run: nothing started, so nothing leaked. See the `tooLong` guard below.
const surveyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc529s-'));
function cleanUp() {
  try { killScratchRootSync(surveyRoot); } catch {}
  try { fs.rmSync(surveyRoot, { recursive: true, force: true }); } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.log(`\n[kan529-suite-leak-survey] ${signal} — reaping and removing ${surveyRoot}`);
    cleanUp();
    process.exit(130);
  });
}

console.log(`${targets.length} script(s), each with its own TMPDIR and HOME under ${surveyRoot}\n`);

const rows = [];
for (const name of targets) {
  const file = path.join(scriptDir, `${name}.mjs`);
  if (!fs.existsSync(file)) {
    rows.push({ name, exit: null, leaked: 0, note: 'no such script' });
    console.log(`  SKIP  ${name} — no such script`);
    continue;
  }
  // Numbered rather than named, for the socket-length reason above. The row
  // carries the script name, so nothing is lost by not putting it in the path.
  const slot = `run-${String(rows.length + 1).padStart(4, '0')}`;
  const tmpdir = path.join(surveyRoot, slot);
  const home = path.join(surveyRoot, `${slot}-h`);
  fs.mkdirSync(tmpdir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // ⚠ THE GUARD THE COMMENT AT THE TOP PROMISES. A daemon refuses a dataDir
  // whose socket path would exceed 104 characters, and every path this survey
  // hands a script is a prefix of one. Over the limit no daemon starts, the
  // script fails for a reason that is this survey's fault, and the leak count
  // reads ZERO — a false clean, in the same words a real clean produces.
  if (tmpdir.length > 55) {
    console.log(`  STOP  ${tmpdir} is ${tmpdir.length} chars; scratch roots go under it and ` +
      `the daemon refuses a socket path over 104. Shorten surveyRoot.`);
    cleanUp();
    process.exit(1);
  }

  const t0 = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: tmpdir, HOME: home },
    encoding: 'utf8',
    timeout: 900_000
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  // The measurement, taken AFTER the process has exited: anything still
  // carrying this run's TMPDIR outlived the run that made it.
  //
  // ⚠ POLLED TO A TIMEOUT RATHER THAN SAMPLED ONCE, and the reason is a false
  // positive this survey actually produced. `epic/KAN-59` ran it on 2026-08-20
  // and got `verify-activated-by — LEAKED 10`, then could not reproduce it
  // standalone: one run had 2 attaches present immediately after exit and gone
  // seconds later, another had 0 at t+0.1s. A process that has been signalled
  // is still on the process table while it winds down, so a single sample taken
  // at t+0 counts processes that are LEAVING as processes that STAYED — and it
  // counts more of them the more contended the machine is, which is exactly
  // when this survey runs.
  //
  // ⚠ THE POLL IS ONE-SIDED ON PURPOSE: it waits for the count to reach ZERO
  // and reports whatever is left when it gives up. A real leak never reaches
  // zero, so waiting costs a clean run nothing but a few hundred milliseconds
  // and costs a leaking run the full timeout ONCE. Anything that survives this
  // long is not winding down.
  const settleDeadline = Date.now() + LEAK_SETTLE_MS;
  let survivors = processesUnder(tmpdir);
  let settleWaited = 0;
  while (survivors.length > 0 && Date.now() < settleDeadline) {
    await sleep(LEAK_POLL_MS);
    settleWaited += LEAK_POLL_MS;
    survivors = processesUnder(tmpdir);
  }
  rows.push({
    name,
    exit: res.status,
    leaked: survivors.length,
    secs,
    settleWaited,
    detail: survivors.length ? describe(survivors) : ''
  });

  // ⚠ THREE OUTCOMES, NOT TWO. A script that exited non-zero may have died
  // before it started anything, in which case "nothing survived" is a fact
  // about a run that did not happen — and it is INDISTINGUISHABLE from a clean
  // teardown unless it is labelled. This survey met exactly that on its first
  // outing: an over-long TMPDIR stopped the daemon starting and three scripts
  // were reported `clean`. `leaked > 0` is still a finding whatever the exit
  // code — processes that are up are up.
  const verdict = survivors.length > 0
    ? { tag: 'LEAK', text: `⚠ LEAKED ${survivors.length}` }
    : res.status === 0
      ? { tag: 'ok  ', text: 'clean' }
      : { tag: '????', text: 'INCONCLUSIVE — exited non-zero, so nothing may have started' };
  // `settled after Nms` is printed on every row that had to wait, so a reader
  // can see the difference between "nothing was ever there" and "it went away
  // while I watched" — the distinction the single sample could not make.
  const settleNote = settleWaited ? `, settled after ${settleWaited}ms` : '';
  console.log(`  ${verdict.tag}  ${name} — exit ${res.status}, ${secs}s${settleNote}, ${verdict.text}`);
  if (survivors.length) console.log(`          ${describe(survivors)}`);

  // Reap before the next script, so no row is measured against another's mess.
  try { killScratchRootSync(tmpdir); } catch {}
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(`\n${'='.repeat(78)}`);
const leaked = rows.filter((r) => r.leaked > 0);
const failed = rows.filter((r) => r.exit !== 0 && r.exit !== null);
const inconclusive = failed.filter((r) => r.leaked === 0);
const clean = rows.filter((r) => r.leaked === 0 && r.exit === 0);
console.log(`${rows.length} surveyed · ${clean.length} clean · ${leaked.length} LEAKED · ` +
  `${inconclusive.length} inconclusive (exited non-zero with nothing left, so possibly ` +
  `nothing ever started)`);
if (leaked.length) {
  console.log('\nLEAKED (script — processes left alive after a run that had already exited):');
  for (const r of leaked) console.log(`  ${r.name}  ${r.leaked}  (exit ${r.exit})`);
}
if (inconclusive.length) {
  console.log('\nINCONCLUSIVE (exited non-zero and left nothing — this is NOT a clean result):');
  for (const r of inconclusive) console.log(`  ${r.name}  exit ${r.exit}`);
}
console.log('='.repeat(78));

cleanUp();
// The survey's verdict is the leak count. A non-zero exit from a surveyed
// script is reported above and does NOT redden this run: a proof failing for
// its own reasons is not this survey's subject, and folding the two together
// would make the number unreadable.
process.exit(leaked.length ? 1 : 0);
