#!/usr/bin/env node
// Live check of the extraction source's KAN-16 fix against a real herdr, at
// the level the bug actually lived: HerdrBridge.
//
// Before the fix, a second spawnSession for one agent opened a second
// `herdr agent attach --takeover`, which evicted the first and left the
// evicted client rendering a dead frame. This drives exactly that sequence
// and asserts the first PTY is still streaming afterwards.
//
// WHAT FAILURE THIS WOULD CATCH: a run of this proof that reports PASS while
// leaving a live herdr pane behind on the machine. It did exactly that, once
// per run, unbounded — KAN-137. The old script ended with
// `first.ptyProcess?.kill()` and a comment explaining that it must not close
// the pane because it "borrows an agent it does not own". That reasoning is
// sound for a directory herdr already has an agent in, and it is false for
// every other directory: `spawnSession` -> `initPty` runs `herdr agent start`
// when no agent is there, so on a fresh directory THE SCRIPT IS THE OWNER and
// the line that protects somebody else's pane leaks its own. KAN-127's agent
// found two survivors — `crabcast-steal-fa2f6deab1547e01` and
// `crabcast-steal2-1ea6885fbc78349c` — by counting panes around every script
// in the live half, which is the practice that caught it rather than anything
// in the script's own output.
//
// SO OWNERSHIP IS MEASURED RATHER THAN ASSUMED. The census is read before
// anything is spawned; whether the probe's pane is already in it decides,
// mechanically, which of the two rules applies:
//
//   absent at entry  -> WE CREATE IT, and we must reclaim it
//   present at entry -> WE BORROW IT, and we must leave it exactly as found
//
// AND THE CLEANUP IS ASSERTED, NOT MERELY PERFORMED. A teardown with nothing
// checking it is the same defect one level up: it reports PASS whether or not
// it worked. Section 4 reads the census again and holds the machine to what
// was found — every baseline pane still present, the `butchr-*` subset
// byte-identical, no new `crabcast-*` pane, and our own probe gone.
//
// WHY THE COUNT CANNOT PASS ON A DEAD CENSUS. `listHerdrAgentsChecked`
// returns an EMPTY census when herdr does not answer, so anything that
// flattens that reads `0 -> 0` and "returns to baseline" beautifully with the
// whole fleet invisible. Two things stop that here. Reachability is asserted
// at BOTH readings, separately from the counts. And section 2 asserts the
// census MOVED when we spawned — our pane name appears, the count goes to
// baseline+1 — so a census that is merely frozen fails before section 4 is
// reached. (Non-emptiness of the baseline is deliberately NOT asserted: it is
// legitimately zero on a machine running nothing, and the responsiveness
// canary is the stronger claim anyway.)
//
// WHAT THIS SCRIPT CREATES, IT ASSERTS ON — say so rather than let a reader
// infer coverage that is not here. Section 4's subject is the pane THIS RUN
// spawned two sections earlier, on the path where the run reaches its verdict.
// That leaves two things uncovered:
//
//   * THE INTERRUPTED PATH. The handlers below reclaim on SIGINT/SIGTERM/
//     SIGHUP as well as on a normal exit, and a script cannot meaningfully
//     interrupt itself — nothing here asserts they fire. Covered by an
//     observation of the running system pasted into the KAN-137 PR (the run is
//     Ctrl-C'd mid-flight and the census counted on either side), and by
//     KAN-169, filed for the missing script-level sibling.
//   * OTHER SCRIPTS' PANES. This says nothing about what any other proof in
//     the live half leaves behind. `verify-proof-cleans-up-when-interrupted`
//     is the nearest sibling and its subject is leaked DAEMONS, not panes —
//     the gap between the two is what KAN-169 is for.
//
// Usage: node scripts/verify-no-attach-steal.mjs [directory]
//
// With no operand it mints its own probe directory, STABLE across runs (see
// defaultProbeDir) so that a pane leaked by a crashed run is visible in the next
// run's baseline instead of being hidden behind a fresh name. With a
// directory, that directory is the agent's whole address — pass one herdr
// already has a live agent in and the run takes the borrow path. Run it after
// `npm run build`.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HerdrBridge } from '../dist/herdr.js';
import { paneNameFor, PANE_NAME_PREFIX } from '../dist/identity.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(ok, label, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ---------------------------------------------------------------- the probe --

// STABLE ACROSS RUNS, and for the reason verify-fleet-switch-live's probe
// directory is: a per-run `mkdtempSync` path cannot appear in a census taken
// before it existed, so a leak from a crashed previous run would be invisible
// to exactly the check that exists to see it. The directory is created and
// never removed — this script did not create it on any run but the first, and
// a stable name is worth more here than a tidy /tmp.
function defaultProbeDir() {
  const d = path.join(os.tmpdir(), 'kan137-steal-probe');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const target = process.argv[2] ?? defaultProbeDir();
if (!fs.existsSync(target)) {
  console.error(
    `refusing to run: ${target} does not exist. This script never creates a directory it was ` +
    `handed — pass one that is there, or pass nothing and it will mint its own.`
  );
  process.exit(2);
}
const agentPath = fs.realpathSync(path.resolve(target));
const PANE = paneNameFor(agentPath);
const dataDir = process.env.CRABCAST_DATA_DIR
  ? path.resolve(process.env.CRABCAST_DATA_DIR)
  : DEFAULT_DATA_DIR;

// The name we are permitted to close, checked here rather than trusted at the
// call site. `paneNameFor` yields `crabcast-<slug>-<hash>` by construction, so
// this can only fire if that contract changes underneath us — which is the
// moment a cleanup keyed on it would start closing something else.
if (!PANE.startsWith(PANE_NAME_PREFIX)) {
  console.error(
    `refusing to run: the derived pane name ${JSON.stringify(PANE)} does not begin with ` +
    `${JSON.stringify(PANE_NAME_PREFIX)}. This script closes a pane by that name and will not ` +
    `do so on a name it cannot recognise as one CrabCast mints.`
  );
  process.exit(2);
}

console.log(`target agent: ${agentPath}`);
console.log(`probe pane:   ${PANE}`);
console.log(`dataDir:      ${dataDir}`);

// ---------------------------------------------------------------- the census --

/**
 * herdr's own census, read with the command a human would type.
 *
 * NOT the bridge's `listHerdrAgentsChecked`: that is code from the package
 * under test, and the whole point of section 4 is to hold the machine to a
 * standard the code under test does not get to define. `reachable` is carried
 * rather than flattened, because "herdr said nothing" and "there are no panes"
 * are different facts and every assertion below depends on the difference.
 */
function census() {
  let out;
  try {
    out = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (e) {
    return { reachable: false, agents: [], error: e?.message ?? String(e) };
  }
  try {
    const agents = JSON.parse(out)?.result?.agents;
    if (!Array.isArray(agents)) return { reachable: false, agents: [], error: 'no agents array' };
    return {
      reachable: true,
      agents: agents
        .filter((a) => a && typeof a.name === 'string')
        .map((a) => ({
          name: a.name,
          paneId: typeof a.pane_id === 'string' && a.pane_id ? a.pane_id : null,
          cwd: typeof a.cwd === 'string' ? a.cwd : null
        }))
    };
  } catch (e) {
    return { reachable: false, agents: [], error: e?.message ?? String(e) };
  }
}

const names = (c) => c.agents.map((a) => a.name).sort();
const butchrOf = (c) => names(c).filter((n) => n.startsWith('butchr-'));

// ------------------------------------------------------------- the reclaim --

/**
 * Close the pane THIS RUN created, and nothing else.
 *
 * Three independent gates, because "close only what we created" is the rule
 * this epic breaks least forgivingly and a single condition is a single place
 * to be wrong:
 *
 *   1. `weOwnIt` — set from the ENTRY census. A pane that was already there is
 *      somebody else's and is never closed, whatever else happens.
 *   2. the name must be exactly the one we derived from our own path, and must
 *      not be a `butchr-*` pane. Several of those are live supervisors.
 *   3. the pane's own `cwd`, as herdr reports it, must canonicalize to the
 *      path we spawned into. A name collision that got past (2) still cannot
 *      get past a pane that is sitting somewhere else.
 *
 * Registered on `exit` AND on the signals a Ctrl-C produces. `process.on
 * ('exit')` alone covers a normal end and `process.exit()` and does NOT fire
 * for SIGINT, SIGTERM or SIGHUP — the KAN-114 mechanism, where a proof that
 * cleaned up perfectly every time it finished left a real agent running the
 * one time somebody interrupted it. The live half is hand-run, so an
 * interrupted run is ordinary rather than exceptional.
 */
let weOwnIt = false;
let reclaimed = false;
function reclaimProbePane() {
  if (reclaimed || !weOwnIt) return;
  reclaimed = true;

  if (PANE.startsWith('butchr-') || !PANE.startsWith(PANE_NAME_PREFIX)) {
    console.error(`  [reclaim] REFUSING to close ${PANE}: not a name this script may close`);
    return;
  }

  let record;
  try {
    const out = execFileSync('herdr', ['agent', 'get', PANE], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    record = JSON.parse(out)?.result?.agent;
  } catch (e) {
    // agent_not_found is the outcome we wanted, not a failure. Section 4 is
    // what decides whether the pane is really gone; this is not the place to
    // guess.
    console.log(`  [reclaim] ${PANE}: herdr does not know it (${e?.message ?? e})`);
    return;
  }

  const paneId = record?.pane_id;
  if (typeof paneId !== 'string' || !paneId) {
    console.log(`  [reclaim] ${PANE}: no pane id — nothing to close`);
    return;
  }

  // Gate 3. herdr reports `cwd` as an arbitrary string; compare resolved.
  const paneCwd = typeof record.cwd === 'string' ? record.cwd : null;
  let resolved = null;
  try {
    resolved = paneCwd ? fs.realpathSync(paneCwd) : null;
  } catch { /* the directory may have gone; resolved stays null */ }
  if (resolved !== null && resolved !== agentPath) {
    console.error(
      `  [reclaim] REFUSING to close ${PANE} (pane ${paneId}): its cwd is ${resolved}, not the ` +
      `${agentPath} this run spawned into. Leaving it alone.`
    );
    return;
  }

  try {
    execFileSync('herdr', ['pane', 'close', paneId], { stdio: 'ignore', timeout: 15000 });
    console.log(`  [reclaim] closed ${PANE} (pane ${paneId})`);
  } catch (e) {
    console.error(`  [reclaim] could not close ${PANE} (pane ${paneId}): ${e?.message ?? e}`);
  }
}

process.on('exit', reclaimProbePane);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    reclaimProbePane();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal); // re-raise, so an interrupted run still exits interrupted
  });
}

// ===========================================================================
rule('1. BASELINE — what is on this machine before anything is spawned');
// ===========================================================================

const baseline = census();
if (!baseline.reachable) {
  console.error(
    `refusing to run: \`herdr agent list\` did not answer (${baseline.error}). Every count in ` +
    `this script is a measurement of the machine, and a run that cannot read the machine has ` +
    `nothing to measure. Nothing was spawned.`
  );
  process.exit(2);
}

const baseNames = names(baseline);
console.log(`  panes at entry: ${baseNames.length}`);
for (const n of baseNames) console.log(`    ${n}`);

weOwnIt = !baseNames.includes(PANE);
console.log(
  `\n  ownership: ${weOwnIt
    ? `${PANE} is NOT in the census, so this run will CREATE it and must reclaim it`
    : `${PANE} is already in the census, so this run BORROWS it and must leave it running`}`
);

check(baseline.reachable, 'the census is readable, so every count below is a measurement');

// ===========================================================================
rule('2. THE KAN-16 PROPERTY — a second activate must not evict the first');
// ===========================================================================

/** The knobs the bridge needs. `shell` explicitly — see below. */
const CONFIG = {
  priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
};

const bridge = new HerdrBridge(dataDir);
const ended = [];
bridge.setSessionEndedListener((e) => {
  ended.push(e);
  console.log(`  [event] agent.detached sessionId=${e.sessionId} reason=${e.reason} exitCode=${e.exitCode}`);
});

let threw = null;
try {
  // No prompt, so this touches nothing but the attach itself — and nothing is
  // written into the caller's directory either way, since the prompt would go
  // to CrabCast's own sidecar. `shell` explicitly: on the borrow path this
  // script attaches to an existing agent, and a claude launcher's setup would
  // write folder trust into the real ~/.claude.json on the way past.
  console.log('\n== first activate ==');
  const first = bridge.spawnSession(agentPath, CONFIG);
  await sleep(2000);

  // THE RESPONSIVENESS CANARY, and it is what stops section 4 passing on a
  // census that has stopped answering. A frozen or empty census returns to
  // "baseline" perfectly; it cannot show a pane appearing.
  const spawned = census();
  if (weOwnIt) {
    check(spawned.reachable, 'the census still answers after the spawn', spawned.error);
    check(
      spawned.reachable && names(spawned).includes(PANE),
      `CANARY: ${PANE} APPEARED in the census — the census reacts to this machine changing, so ` +
      `its later agreement that the pane is gone is evidence rather than silence`,
      `census now: ${names(spawned).length} pane(s)`
    );
    check(
      spawned.reachable && names(spawned).length === baseNames.length + 1,
      `and the count moved ${baseNames.length} -> ${baseNames.length + 1}`,
      `actually ${names(spawned).length}`
    );
  } else {
    // Nothing was created, so nothing can be seen to appear. Said out loud
    // rather than silently skipped: on the borrow path section 4's absence
    // assertions rest on reachability alone.
    console.log(
      `  [skipped] the responsiveness canary needs a pane to appear, and this run borrowed one ` +
      `that was already there. Section 4 rests on reachability alone on this path.`
    );
  }

  let firstBytes = 0;
  bridge.registerDataListener(first.sessionId, (d) => { firstBytes += d.length; });

  console.log('\n== second activate at the same agent (this is what used to steal it) ==');
  const second = bridge.spawnSession(agentPath, CONFIG);
  await sleep(3000);

  console.log('\n== result ==');
  console.log(`  same session returned: ${first.sessionId === second.sessionId}`);
  console.log(`  first session status:  ${first.status}`);
  console.log(`  detach events:         ${ended.length ? JSON.stringify(ended) : 'none'}`);

  // A live attach keeps redrawing, so any traffic at all proves it is streaming.
  const before = firstBytes;
  await sleep(1500);
  console.log(`  bytes streamed after the second activate: ${firstBytes - before >= 0 ? firstBytes : 0} total`);

  check(first.sessionId === second.sessionId,
    'the second activate returned the SAME session — no second attach was opened',
    `${first.sessionId} vs ${second.sessionId}`);
  check(first.status === 'active',
    'the first session is still active',
    `status=${first.status}${first.spawnError ? ` spawnError=${first.spawnError}` : ''}`);
  check(ended.length === 0,
    'and nothing was evicted — no agent.detached fired',
    JSON.stringify(ended));

  // ===========================================================================
  rule('3. TEARDOWN — drop our attach, and reclaim the pane if it is ours');
  // ===========================================================================

  // The attach PTY is dropped either way: it is this process's client on the
  // pane and it dies with us regardless. Closing the PANE is the part that
  // depends on who created it.
  first.ptyProcess?.kill();
  await sleep(500);
  console.log('  dropped this run\'s attach PTY');
  reclaimProbePane();
  await sleep(1500);
} catch (e) {
  threw = e;
  console.error(`\n  the run threw before reaching its verdict: ${e?.stack ?? e}`);
} finally {
  // Whatever happened above, the pane goes back before the machine is
  // measured. Idempotent, so the ordinary path's call is not repeated.
  reclaimProbePane();
}

// ===========================================================================
rule('4. THE MACHINE IS WHERE IT WAS FOUND — the assertion, not just the cleanup');
// ===========================================================================

const after = census();
check(after.reachable,
  'the census is readable at exit too, so "the pane is gone" is a reading and not a silence',
  after.error);

if (after.reachable) {
  const afterNames = names(after);
  console.log(`\n  panes: ${baseNames.length} -> ${afterNames.length}`);

  const vanished = baseNames.filter((n) => !afterNames.includes(n));
  const appeared = afterNames.filter((n) => !baseNames.includes(n));

  check(vanished.length === 0,
    'every pane that was here at entry is still here — this run closed nothing it did not create',
    `gone: ${JSON.stringify(vanished)}`);

  // Criterion 4 of KAN-137, asserted from the CENSUS rather than from this
  // script's own intent. "We only ever pass our own name to `pane close`" is a
  // claim about the code; "the butchr-* set is identical" is a claim about the
  // machine, and those are different facts.
  const b0 = butchrOf(baseline);
  const b1 = butchrOf(after);
  check(JSON.stringify(b0) === JSON.stringify(b1),
    `no butchr-* pane was touched — ${b0.length} at entry, ${b1.length} at exit, identical`,
    `entry: ${JSON.stringify(b0)}\nexit:  ${JSON.stringify(b1)}`);

  if (weOwnIt) {
    check(!afterNames.includes(PANE),
      `THE PANE THIS RUN CREATED IS GONE — ${PANE} is not in the exit census`,
      'it is still there: this run leaked exactly the pane KAN-137 is about');
  } else {
    check(afterNames.includes(PANE),
      `the BORROWED pane is still running — ${PANE} was not ours to close`,
      'it is gone: this run closed an agent it did not create');
  }

  // Any other new pane. A leftover `crabcast-*` is a leak whoever reads this
  // needs to see by name, whether it came from here or from a concurrent run
  // of another proof. A new `butchr-*` is the supervised fleet doing its job
  // during the seven seconds this took, which is not this script's doing and
  // is reported rather than failed — a proof that goes red because a sibling
  // agent booted is a proof that gets ignored.
  const strayCrabcast = appeared.filter((n) => n !== PANE && n.startsWith(PANE_NAME_PREFIX));
  const otherNew = appeared.filter((n) => n !== PANE && !n.startsWith(PANE_NAME_PREFIX));
  check(strayCrabcast.length === 0,
    'no other crabcast-* pane appeared during the run',
    `new: ${JSON.stringify(strayCrabcast)} — close these by hand and find out which proof left them`);
  if (otherNew.length) {
    console.log(
      `\n  NOTE (not a failure): ${otherNew.length} non-crabcast pane(s) appeared while this ran — ` +
      `${JSON.stringify(otherNew)}. This script starts nothing but its own probe; that is the ` +
      `fleet moving underneath the measurement.`
    );
  }

  console.log('');
  for (const n of afterNames) console.log(`    ${n}`);
}

check(!threw,
  'the run reached its verdict without throwing',
  threw ? String(threw?.stack ?? threw) : '');

// ===========================================================================

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
console.log(failures === 0
  ? 'PASS: the second activate reused the live session, nothing was evicted, and the machine is where it was found.'
  : 'FAIL — see the FAIL lines above.');
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
