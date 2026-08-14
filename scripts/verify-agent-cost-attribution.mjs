#!/usr/bin/env node
// KAN-338: the divisor is measured from the trees this daemon owns and charges
// for, and from nothing else.
//
// WHAT FAILURE THIS WOULD CATCH: the capacity gate dividing a budget for
// CHARGED agents by a per-tree cost averaged over process trees that are not
// its agents — another orchestrator's fleet, its own uncharged supervisors, or
// a human's `claude` in a terminal. KAN-275 bounded that with a one-sided floor
// and could not attribute it, because nothing joined a tree to an agent record.
// Measured on the machine this was written on, 2026-08-13, against the LIVE
// daemon: `agent cost: 0.04 core (measured) … across 7 tree(s)` printed one
// line above `running: 0 charged agent(s)`, deriving `capByCpu 62` on a
// four-core box — and all seven of those trees were resolved BY NAME to another
// orchestrator's agents.
//
// It would equally catch the two ways attribution can be wrong in the other
// direction. A divisor computed from an EMPTY sample is a gate that agrees with
// any register at all — §3 — and a sampler that read an unreachable herdr as
// "none of them are ours" would produce that emptiness on a machine full of our
// own agents (§5).
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER — read this before trusting a green run.
//
// THIS SCRIPT SUPPLIES ITS OWN ATTRIBUTOR. Every section below hands
// `finishMeasurement` a function it wrote itself, so what is proved is what the
// sampler DOES with an ownership answer — never that a real answer arrives.
// The join it stands on (a process's `HERDR_PANE_ID` → `herdr pane get` → the
// pane's name → `ourPaneIn`) is not exercised here at all, and a machine on
// which that join silently returned `false` for every tree would pass this file
// from top to bottom while measuring nothing.
//
// That gap is exactly the shape KAN-145 left behind — two scripts each honest,
// with the hole between them — so it is named here and owned there:
// `verify-agent-cost-attribution-live.mjs` drives the real join against a real
// herdr pane this daemon created. It cannot run on a GitHub runner (no herdr,
// no terminal), which is why it is in the EXCLUSIONS register of
// verify-proof-registry.mjs and why this half exists separately.
//
// §2 is the one section that reads real `/proc`, and it reads only processes
// this script started itself.
// ---------------------------------------------------------------------------

import { spawn } from 'child_process';
import {
  finishMeasurement,
  groupByAgent,
  paneHandleOf,
  startMeasurement
} from '../dist/agent-cost.js';
import { sampleFromMeasurement } from '../dist/agent-cost-damping.js';
import {
  MEASURED_AGENT_COST,
  computeCapacity,
  describeCapacity
} from '../dist/capacity.js';

const MIB = 1024 ** 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

// A synthetic /proc sample. The sampler's real input is a Map<pid,
// ProcessSample>, and building one by hand is what lets every arm of the
// attribution table be driven without a fleet — including the arms a real
// machine will not produce on demand, like a tree whose environment cannot be
// read.
const proc = (pid, comm, ppid, cpuTicks, rssMb) => [
  pid,
  { pid, comm, ppid, cpuTicks, rssBytes: rssMb * MIB }
];

/**
 * One window, start to finish, over a fixed pair of samples.
 *
 * `finishMeasurement` reads the LATER sample from /proc itself, so it cannot be
 * driven with a synthetic "after" — sections 1, 3 and 4 therefore assemble the
 * measurement the same way it does, from `groupByAgent` plus the same
 * arithmetic, and section 2 runs the real function against real processes. The
 * duplication is deliberate and is confined to this helper: what is being
 * proved here is WHICH TREES ARE IN `totals`, and that decision is data, not
 * timing.
 */
function measureOver(before, after, elapsed, ownershipOf) {
  const groups = groupByAgent(after);
  const agents = [];
  for (const [root, pids] of groups) {
    let ticks = 0;
    let rss = 0;
    for (const pid of pids) {
      const now = after.get(pid);
      if (!now) continue;
      ticks += now.cpuTicks - (before.get(pid)?.cpuTicks ?? 0);
      rss += now.rssBytes;
    }
    agents.push({
      pid: root,
      processes: pids.length,
      cores: ticks / 100 / elapsed,
      residentMb: rss / MIB,
      ownership: ownershipOf(root)
    });
  }
  const charged = agents.filter((a) => a.ownership.charged);
  const excluded = (why) =>
    agents.filter((a) => !a.ownership.charged && a.ownership.why === why).length;
  return {
    elapsed,
    loadStart: 0,
    loadEnd: 0,
    agents,
    totals: {
      agents: charged.length,
      cores: charged.reduce((s, a) => s + a.cores, 0),
      residentMb: charged.reduce((s, a) => s + a.residentMb, 0)
    },
    seen: {
      trees: agents.length,
      foreign: excluded('foreign'),
      noHandle: excluded('no-handle'),
      handleUnreadable: excluded('handle-unreadable')
    }
  };
}

// ------------------------------------------------------- 1. the exclusion --
rule('1. THE SAMPLE IS OURS — a foreign tree is measured and not charged');

// The shape of the incident, in the proportions it was measured in: two of our
// own agents working, and a majority of cheap trees belonging to somebody else.
// The numbers are chosen so the two answers differ by more than rounding, and
// so the FOREIGN average is the cheaper one — that is the direction that buys a
// bigger cap, which is the direction that hurts.
const OURS = ['p_ours_a', 'p_ours_b'];
const before = new Map([
  proc(100, 'claude', 1, 0, 0), proc(101, 'node', 100, 0, 0),
  proc(200, 'claude', 1, 0, 0),
  proc(300, 'claude', 1, 0, 0),
  proc(400, 'claude', 1, 0, 0),
  proc(500, 'claude', 1, 0, 0)
]);
// These are the proportions of the worked example in `flooredCost`'s own
// comment, and they are chosen so the CPU term can move at all: with the
// KAN-275 floor in force, only a divisor ABOVE the 0.75 seed changes capByCpu,
// so a fixture where both averages sit under the seed would prove that the
// floor works and nothing about attribution.
//
// THE MEMORY FIGURES ARE DERIVED FROM THE SEED AND NOT WRITTEN DOWN (KAN-245,
// and KAN-390 is what made it bite). They used to be the literals 900 and 300,
// which straddled the 800 MB seed of the day — so the fixture encoded a
// relationship to the seed that nothing in it declared. When KAN-390 raised
// `residentBytes` to 1050 the literal 900 fell BELOW the new seed, the
// attributed divisor was floored where the assertion needs it believed
// outright, and two checks went red: `flooredDimensions` gained `residentBytes`
// on the attributed side, and both cap terms landed on 13 because both were
// floored to the same seed. Nothing was wrong with the model — the fixture was
// stale, and it went red in a way that reads like a defect in the code it
// tests. Expressed as multiples of the seed, the arms keep their proportions
// (1.125x and 0.375x, the 900/800 and 300/800 they have always been) under any
// future move of it.
const SEED_MB = MEASURED_AGENT_COST.residentBytes / MIB;
const OURS_TREE_MB = 1.125 * SEED_MB; // above the seed: believed, never floored
const THEIRS_TREE_MB = 0.375 * SEED_MB; // well below it: the cheap foreign tree
const after = new Map([
  // ours: 1200 ticks over a 10s window = 1.2 core, and a tree above the seed
  proc(100, 'claude', 1, 800, (2 / 3) * OURS_TREE_MB),
  proc(101, 'node', 100, 400, (1 / 3) * OURS_TREE_MB),
  proc(200, 'claude', 1, 1200, OURS_TREE_MB),
  // theirs: 50 ticks = 0.05 core — cheap, and three of them
  proc(300, 'claude', 1, 50, THEIRS_TREE_MB),
  proc(400, 'claude', 1, 50, THEIRS_TREE_MB),
  proc(500, 'claude', 1, 50, THEIRS_TREE_MB)
]);
const HANDLE_OF = { 100: 'p_ours_a', 200: 'p_ours_b', 300: 'p_x', 400: 'p_y', 500: 'p_z' };
const attributed = measureOver(before, after, 10, (root) => {
  const handle = HANDLE_OF[root];
  return OURS.includes(handle)
    ? { charged: true, paneHandle: handle }
    : { charged: false, why: 'foreign' };
});
// The same window with nobody attributed — what the sampler did before KAN-338,
// and the figure this section exists to be different from.
const unattributed = measureOver(before, after, 10, (root) => ({
  charged: true,
  paneHandle: HANDLE_OF[root]
}));

const perTree = (m) => ({
  cores: m.totals.cores / m.totals.agents,
  mb: m.totals.residentMb / m.totals.agents
});
const A = perTree(attributed);
const U = perTree(unattributed);
console.log(
  `attributed  : ${attributed.totals.agents} of ${attributed.seen.trees} tree(s) — ` +
  `${A.cores.toFixed(3)} core, ${Math.round(A.mb)} MB per tree`
);
console.log(
  `unattributed: ${unattributed.totals.agents} of ${unattributed.seen.trees} tree(s) — ` +
  `${U.cores.toFixed(3)} core, ${Math.round(U.mb)} MB per tree`
);

check(
  attributed.totals.agents === 2 && attributed.seen.trees === 5 && attributed.seen.foreign === 3,
  'only our trees are in the charged sample, and the ones that left are counted',
  `${attributed.totals.agents} charged, ${attributed.seen.foreign} foreign, ` +
  `${attributed.seen.trees} seen`
);
// VACUITY GUARD. Everything above would also pass if `totals` had been computed
// over the right trees by accident — if all five trees cost the same, the two
// averages would agree and the assertion would be about nothing. This is the
// assertion that the exclusion MOVED the figure, and in which direction.
check(
  A.cores > U.cores && A.mb > U.mb,
  'VACUITY: the foreign trees were dragging the divisor DOWN, and no longer are',
  `cores ${U.cores.toFixed(3)} → ${A.cores.toFixed(3)}, mb ${Math.round(U.mb)} → ${Math.round(A.mb)}`
);
// A cheaper divisor is a LARGER cap: that is the whole reason a foreign
// discount is dangerous rather than merely wrong. Asserted per term, because
// `cap` is a `min` and can hide a term that moved (KAN-275).
// A FIXED machine, not this one, and the reason is portability rather than
// taste. `computeCapacity` is pure precisely so it can be run against hardware
// nobody here owns, and the assertions below need the two divisors to produce
// DIFFERENT cap terms: on a 2-core CI runner the whole CPU budget is
// `2 − 1 reserved − 0.5 for herdr = 0.5` core, which floors to zero agents for
// every divisor above half a core, so both columns would read 0 and the
// "both terms moved" guard would go red on the runner rather than on a defect.
// verify-agent-capacity.mjs pins its machine for the same reason.
//
// This is a fixture and not a claim about any box. The live machine is still
// read where a live reading is the subject — §2 measures real /proc.
const FACTS = {
  cores: 4,
  totalBytes: 16 * 1024 * MIB,
  availableBytes: 8 * 1024 * MIB,
  load1: 0.2,
  cpu: null,
  stall: null
};
const capOf = (m, trees, seen) =>
  computeCapacity(FACTS, 0, {
    measured: {
      cores: m.cores,
      residentBytes: m.mb * MIB,
      sampledAt: Date.parse('2026-08-13T00:00:00Z'),
      windowSeconds: 10,
      agentTrees: trees,
      treesSeen: seen
    }
  });
const capA = capOf(A, 2, 5);
const capU = capOf(U, 5, 5);
console.log(
  `\ncapByCpu    : ${capU.capByCpu} (unattributed) → ${capA.capByCpu} (attributed)\n` +
  `capByMemory : ${capU.capByMemory} (unattributed) → ${capA.capByMemory} (attributed)\n` +
  `cap         : ${capU.cap} → ${capA.cap}`
);
check(
  capA.capByCpu <= capU.capByCpu && capA.capByMemory <= capU.capByMemory,
  'PER TERM: neither cap term rises when the foreign discount is removed',
  `cpu ${capU.capByCpu} → ${capA.capByCpu}, memory ${capU.capByMemory} → ${capA.capByMemory}`
);
check(
  capA.capByCpu < capU.capByCpu && capA.capByMemory < capU.capByMemory,
  'and BOTH terms actually moved, so the assertion above is not vacuous',
  `capByCpu ${capU.capByCpu} → ${capA.capByCpu}, capByMemory ${capU.capByMemory} → ${capA.capByMemory}`
);
// The half the floor could never have delivered, asserted rather than argued:
// the unattributed divisor here is BELOW the seed, so KAN-275 floors it to the
// seed — and the true, attributed divisor is above the seed. A floor raises to
// the seed and never to the truth, so this cap is one no floor could reach.
check(
  capU.flooredDimensions.includes('cores') && capA.flooredDimensions.length === 0,
  'WHAT ATTRIBUTION BUYS: the foreign average was floored to the seed; the attributed one is believed outright',
  `unattributed floored [${capU.flooredDimensions.join(', ')}], attributed floored ` +
  `[${capA.flooredDimensions.join(', ') || 'none'}]`
);

// ------------------------------------------------- 2. the /proc read half --
rule('2. THE HANDLE IS READ FROM /proc, on processes this script starts itself');

// paneHandleOf reads `/proc/<pid>/environ`. This is the one section that
// touches a real process, and both processes below are this script's own
// children — nothing here reads any other process's environment.
const child = (env) =>
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    env: { ...process.env, ...env },
    stdio: 'ignore'
  });
const withHandle = child({ HERDR_PANE_ID: 'p_probe_42' });
const withoutHandle = child({ HERDR_PANE_ID: undefined });
// A child spawned with the variable explicitly emptied: the sampler must not
// hand an empty string to herdr as if it were a pane.
const withEmptyHandle = child({ HERDR_PANE_ID: '' });
await new Promise((r) => setTimeout(r, 300));

const readWith = paneHandleOf(withHandle.pid);
const readWithout = paneHandleOf(withoutHandle.pid);
const readEmpty = paneHandleOf(withEmptyHandle.pid);
const readGone = paneHandleOf(2 ** 22 - 1); // a pid that cannot exist on Linux

console.log(`with handle    : ${JSON.stringify(readWith)}`);
console.log(`without handle : ${JSON.stringify(readWithout)}`);
console.log(`empty handle   : ${JSON.stringify(readEmpty)}`);
console.log(`no such pid    : ${JSON.stringify(readGone)}`);

check(
  readWith.handle === 'p_probe_42' && readWith.unreadable === false,
  'the pane handle a process is carrying is read back exactly'
);
check(
  readWithout.handle === null && readWithout.unreadable === false,
  'a process with no handle is "no handle" and NOT "unreadable" — the two degrade differently'
);
check(
  readEmpty.handle === null,
  'an empty assignment is not a handle, so no empty string reaches a herdr argv'
);
check(
  readGone.handle === null && readGone.unreadable === true,
  'a pid that is not there is UNREADABLE, not a tree that happens to lack a handle'
);
for (const c of [withHandle, withoutHandle, withEmptyHandle]) c.kill('SIGKILL');

// A real window over the real machine, with an attributor that charges nothing.
// This exercises `finishMeasurement` itself — the function the daemon calls —
// rather than this script's re-implementation of its accounting.
const liveWindow = startMeasurement();
await new Promise((r) => setTimeout(r, 250));
const liveMeasurement = finishMeasurement(liveWindow, () => false);
console.log(
  `\nlive window: ${liveMeasurement.seen.trees} agent tree(s) on this machine, ` +
  `${liveMeasurement.totals.agents} charged, ` +
  `${liveMeasurement.seen.foreign} foreign / ${liveMeasurement.seen.noHandle} no-handle / ` +
  `${liveMeasurement.seen.handleUnreadable} unreadable`
);
check(
  liveMeasurement.totals.agents === 0 &&
    liveMeasurement.seen.trees ===
      liveMeasurement.seen.foreign +
        liveMeasurement.seen.noHandle +
        liveMeasurement.seen.handleUnreadable,
  'the real sampler charges nothing when the attributor claims nothing, and every tree it saw is accounted for',
  `${liveMeasurement.seen.trees} seen`
);

// --------------------------------------------------------- 3. the vacuity --
rule('3. ZERO TREES — an empty sample must not become a divisor');

// This is the state of the machine this was written on: agent trees running,
// none of them ours. Before attribution it produced a confident measurement of
// somebody else's fleet; the requirement is that it now produces NO measurement
// at all, and therefore the labelled seed.
const noneOurs = measureOver(before, after, 10, () => ({ charged: false, why: 'foreign' }));
const emptySample = sampleFromMeasurement(noneOurs, FACTS.totalBytes);
console.log(
  `charged trees: ${noneOurs.totals.agents}, seen: ${noneOurs.seen.trees} ` +
  `(${noneOurs.seen.foreign} foreign) → sample: ${JSON.stringify(emptySample)}`
);
check(
  noneOurs.seen.trees > 0,
  'the machine is BUSY in this fixture — the guard is being asked about an empty SAMPLE, not an empty machine',
  `${noneOurs.seen.trees} tree(s) running`
);
check(
  emptySample === null,
  'a window with no attributable tree yields no sample, so nothing is published and capacity answers from the seed'
);
// The guard is `totals.agents <= 0` in sampleFromMeasurement, and it predates
// this ticket — what is new is that attribution can REACH it on a busy machine.
// Asserted here as the arithmetic it prevents: an average over zero trees.
check(
  !Number.isFinite(noneOurs.totals.cores / noneOurs.totals.agents),
  'VACUITY: the arithmetic the guard prevents really is undefined — 0/0, not merely small'
);
const seedCap = computeCapacity(FACTS, 0);
check(
  seedCap.costSource.cores === 'seed' && seedCap.cost.cores === MEASURED_AGENT_COST.cores,
  'and the fallback is the SEED, labelled as one — not a stale estimate posing as live'
);

// ------------------------------------------------------------ 4. one tree --
rule('4. ONE TREE — more correct, less stable, and the floor is what stands under it');

// Attribution makes the sample smaller as well as truer, and a one-tree sample
// is an average over one number. The ticket asks what happens there; this is
// the answer, in both directions.
const oneBefore = new Map([proc(100, 'claude', 1, 0, 0), proc(300, 'claude', 1, 0, 0)]);
const oneIdle = new Map([proc(100, 'claude', 1, 1, 120), proc(300, 'claude', 1, 5, 300)]);
// 1200 ticks over 10s = 1.2 core, above the 0.75 seed. Below it the floor would
// bind and this section would assert the floor twice instead of once each way.
const oneBusy = new Map([proc(100, 'claude', 1, 1200, 1600), proc(300, 'claude', 1, 5, 300)]);
const onlyOurs = (root) =>
  root === 100 ? { charged: true, paneHandle: 'p_ours_a' } : { charged: false, why: 'foreign' };

for (const [label, sampleAfter] of [['idle', oneIdle], ['busy', oneBusy]]) {
  const m = measureOver(oneBefore, sampleAfter, 10, onlyOurs);
  const s = sampleFromMeasurement(m, FACTS.totalBytes);
  const cap = computeCapacity(FACTS, 0, {
    measured: {
      ...s,
      sampledAt: Date.parse('2026-08-13T00:00:00Z'),
      windowSeconds: 10,
      agentTrees: m.totals.agents,
      treesSeen: m.seen.trees
    }
  });
  console.log(
    `one ${label} tree: ${s.cores.toFixed(3)} core / ${Math.round(s.residentBytes / MIB)} MB → ` +
    `capByCpu ${cap.capByCpu}, capByMemory ${cap.capByMemory}, ` +
    `floored: [${cap.flooredDimensions.join(', ') || 'none'}]`
  );
  if (label === 'idle') {
    check(
      cap.flooredDimensions.includes('cores') && cap.cost.cores === MEASURED_AGENT_COST.cores,
      'ONE IDLE TREE: the KAN-275 floor is what divides, so a quiet minute cannot buy a bigger cap',
      `measured ${s.cores.toFixed(3)} core, divided by ${cap.cost.cores}`
    );
    // THE FLOOR IS NOT REDUNDANT, asserted as a counterfactual rather than
    // claimed. An override is the one input `flooredCost` honours outright, so
    // feeding the same measurement back as an override is this arithmetic with
    // the floor taken out — and that is the cap this one idle tree would have
    // bought. The ticket asked whether attribution makes the floor unnecessary;
    // this is the number that answers no.
    const unfloored = computeCapacity(FACTS, 0, {
      overrides: { cores: s.cores, residentBytes: s.residentBytes }
    });
    check(
      unfloored.capByCpu > cap.capByCpu,
      'VACUITY / KAN-275 STAYS: without the floor the same idle tree buys a far bigger cap',
      `capByCpu ${cap.capByCpu} (floored) vs ${unfloored.capByCpu} (unfloored)`
    );
  } else {
    check(
      cap.flooredDimensions.length === 0 && cap.cost.cores === s.cores,
      'ONE BUSY TREE: an expensive single tree is believed in full — the floor is one-sided',
      `divided by ${cap.cost.cores.toFixed(3)} core`
    );
  }
}
// The claim the ticket asked to be tested rather than asserted: attribution
// does NOT make the floor redundant. It is asked at the one-tree sample
// attribution itself creates.
console.log(
  '\nso the floor stays: it binds exactly in the small-sample case attribution makes\n' +
  'ordinary, and the counterfactual above is what that is worth. See flooredCost in\n' +
  'capacity.ts for the per-dimension argument.'
);

// ------------------------------------------------------------ 5. silence  --
rule('5. SILENCE IS NOT EVIDENCE — an unreachable herdr must not attribute the machine away');

// If a census this daemon could not read were treated as "no pane is ours",
// every tree would be foreign, the sample would empty, and the report would say
// the fleet is not running. The daemon's guard is that `chargedPaneNames()`
// returns null on an unreachable census and the window degrades BEFORE
// attribution is attempted. Asserted here on the source, because the branch
// needs a herdr that is failing rather than absent.
const daemonSrc = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')
);
check(
  /if \(!census\.reachable\) return null;/.test(daemonSrc),
  'an unreachable census returns null rather than an empty set of our pane names'
);
check(
  /charged === null[\s\S]{0,400}degradeCostMeasurement\(/.test(daemonSrc),
  'and null degrades the measurement rather than being spread over the trees as "not ours"'
);
check(
  /const charged = costWindow \? chargedPaneNames\(\) : null;/.test(daemonSrc),
  'the census is read ONCE per window, so "herdr is down" cannot arrive as N indistinguishable nulls'
);

// -------------------------------------------------------- 6. the report   --
rule('6. THE REPORT SAYS WHAT IT AVERAGED AND WHAT IT LEFT OUT');

const reportCap = computeCapacity(FACTS, 0, {
  measured: {
    cores: MEASURED_AGENT_COST.cores * 2,
    residentBytes: MEASURED_AGENT_COST.residentBytes * 2,
    sampledAt: Date.parse('2026-08-13T00:00:00Z'),
    windowSeconds: 60,
    agentTrees: 2,
    treesSeen: 9
  }
});
const text = describeCapacity(reportCap);
console.log(text.split('\n').filter((l) => l.includes('measured (damped)')).join('\n'));
check(
  text.includes('averaged over 2 of 9 agent-runtime tree(s)'),
  'a divisor drawn from 2 of 9 trees says so, rather than reporting 2 and letting a reader assume 2 was all there was'
);
check(
  text.includes('chargeable agent of this daemon'),
  'and it names the population, so "tree" is not left meaning "process tree on this box"'
);

console.log(`\n${'='.repeat(78)}`);
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
