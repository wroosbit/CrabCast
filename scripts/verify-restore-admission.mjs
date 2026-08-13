#!/usr/bin/env node
// KAN-263: a restore sequence cannot admit more agents than the machine has
// room for — the gate composes, not merely per activation.
//
// WHAT FAILURE THIS WOULD CATCH: a boot restoration that starts every agent the
// registry expects, onto a machine that can carry three of them, with every
// individual decision correct. Two distinct mechanisms produced that, one
// nested in the other, and both are asserted here:
//
//   1. THE BYPASS. `reconcile.ts` activated with `override: true`, which makes
//      `capacityGate` return `refusal: null` unconditionally — so the number of
//      agents a restore pass could admit was bounded by nothing at all. §8a
//      restores that one line and requires this file to go red.
//   2. THE BLIND SPOT, which is the one the ticket was filed for. Restores are
//      serial, awaited and staggered by `RESTORE_STAGGER_MS` = 3s, and each one
//      IS gated — against a CPU observation the daemon refreshes every
//      `CPU_SAMPLE_INTERVAL_MS` = 30s. So roughly ten restores happen between
//      two samples and every one is measured against a reading taken before any
//      of them existed. True alone, false in composition. §8b deletes the
//      charge that fixes it; §8c deletes the ledger write that feeds it.
//
// It would equally catch the opposite mistake — a charge welded on that refuses
// a quiet machine. §3's counterfactual runs the same MachineFacts with an empty
// ledger and REQUIRES an admission, and §6 fails by name if the drive never
// observed both an admission and a refusal.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF AND WHAT IT DOES NOT — the KAN-145 line
// ---------------------------------------------------------------------------
//
// A proof that supplies its own input has not tested that the input arrives, so
// the split is stated rather than left to be worked out:
//
//   SUPPLIED — THE BUSY MACHINE. §3 and §4 publish a `CpuObservation` through
//   `setObservedCpu`. A proof running on a shared desktop may not saturate its
//   cores on demand, and this ticket's own brief says so in as many words: an
//   honest "a mechanism derived from measured constants, driven against a
//   fixture" beats a real fleet that costs the human their desktop (KAN-216
//   took the same route for I/O saturation). §1 exercises the real instrument
//   against this machine's real /proc/stat so the path from kernel counters to
//   an observation runs at least once with nothing hand-written in it, but it
//   cannot assert a threshold.
//
//   NOT SUPPLIED — THE LEDGER. This is the half that matters and it is why §4
//   exists. The starts §4 charges for are PRODUCED BY REAL ACTIVATIONS: the
//   real `reconcileAgents` drives the real `MessageRouter` through the real
//   `HerdrBridge` against a real on-disk `AgentRegistry`, and every entry in
//   the ledger got there because `handleActivate` actually spawned something.
//   Nothing in §4 writes to the ledger. That is the assertion §3 cannot make
//   and the one KAN-145 was about — its two scripts proved the daemon carries
//   `activatedBy` correctly by constructing records that already had it, and
//   the field was null in production for every agent.
//
//   NOT SUPPLIED EITHER — THE REFUSAL. §4 does not construct a `Capacity` and
//   ask it a question; it counts what a restore pass actually did.
//
// AND THE SEAM BETWEEN THIS FILE AND ITS SIBLING, named because two scripts
// that are each honest about what they test can still leave a hole between
// them, and this is where ours is:
//
//   * THIS FILE proves that a restore pass divides whatever observation is
//     published — through the real router, the real gate and the real
//     reconciler — but it publishes that observation itself.
//   * `verify-cpu-headroom` §7 proves the other half: a REAL daemon, over a
//     real socket, runs its sampler and publishes a real figure into the same
//     module slot this file writes. It is what makes "the sampler is alive" a
//     claim rather than an assumption.
//
//   NOTHING RUNS BOTH AT ONCE — a real daemon's sampler, a real reconcile pass,
//   and a machine genuinely short of CPU — and nothing will, on a shared
//   desktop, because the third ingredient is the incident this ticket was filed
//   after. WHO COVERS IT: nobody. That is stated rather than left to be
//   inferred. What narrows it is that the value is the only thing supplied:
//   the READ path from the module slot to a refusal is the production one and
//   runs here in full, and §8c is the assertion that the WRITE path is wired,
//   since deleting the ledger write turns this file red while leaving the
//   arithmetic sections green.
//
// NO AGENT WITH A MODEL BEHIND IT IS STARTED, and that is structural rather
// than careful: `herdr` is a stub on PATH, so `herdr agent start` appends a row
// to a JSON file and no launcher command is ever executed. The only processes
// this script creates are the stub's own node processes holding attach PTYs
// open, exactly as `verify-restart-survival` does in CI. §6 counts panes before
// and after and every PTY is killed on the way out, including on a signal.
//
// ---------------------------------------------------------------------------
// THE FIXTURE IS DERIVED, NOT A LITERAL (AC4, and KAN-245 is why)
// ---------------------------------------------------------------------------
//
// "The machine is busy" here is `cores − reserved − (K + 0.5) × costCores`,
// computed at run time from THIS machine's core count, the shipped human
// reserve and the shipped cost divisor. There is no /proc/stat tick literal
// anywhere in this file, so nothing here can expire the way a hard-coded
// `9_999_999` expired as machines accumulated uptime — the quantity it is
// derived from is a core count, which does not accumulate.
//
// AND ITS EXERCISE IS ASSERTED SEPARATELY, because "derived" is not "used": §6
// requires the constructed capacity to have been CPU-bound with headroom
// exactly K before the drive, requires the busy figure to lie strictly inside
// (0, cores), and holds two observations to the end of the run — at least one
// restore ADMITTED and at least one REFUSED — failing by name if either went
// unobserved. A fixture that has stopped saturating and a machine that had room
// anyway produce the same clean pass without them.
//
// EIGHT SECTIONS:
//   1. the instrument   — a real /proc/stat window, and the weight function's
//                         edges: window-open 0, window-close 1, after 1
//   2. the rate         — a start is charged the seed, not a settled agent's
//                         measured cost; an operator override is still honoured
//   3. the arithmetic   — N charges walk headroomByCpu down to 0, and the SAME
//                         machine with an empty ledger admits (counterfactual)
//   4. the drive        — the REAL reconciler restores a fleet larger than
//                         headroom and stops at headroom; the rest are DEFERRED
//   5. the words        — the deferral names cpu, quotes the charge, and its
//                         figures reproduce the verdict by hand
//   6. vacuity          — the fixture was exercised, both verdicts were seen,
//                         the observation stayed fresh, panes balance
//   7. the ledger       — the horizon cannot prune anything still chargeable
//   8. the red          — three mutations: the bypass restored, the charge
//                         deleted, the ledger write deleted
//
// Run `npm run build` first.
// Usage: node scripts/verify-restore-admission.mjs [distDir]

import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const report = {
  pass: (label, detail) => check(label, true, detail),
  fail: (label, detail) => check(label, false, detail)
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan263-restore-'));
const realPath = process.env.PATH;

// ---------------------------------------------------------------------------
// The stub herdr. The same shape verify-restart-survival uses, and for its
// reasons: stateful so a pane count is a real count, `agent attach` holds the
// terminal open so a session does not go 'terminated' milliseconds later, and
// every argv is logged BEFORE dispatch so a refused call is as visible as a
// served one.
// ---------------------------------------------------------------------------
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
const ARGV_LOG = path.join(tmp, 'herdr-argv.log');
const PANE_SEQ = path.join(tmp, 'pane-seq');

fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/usr/bin/env node
const fs = require('fs');
const CENSUS = ${JSON.stringify(CENSUS_FILE)};
const ARGV_LOG = ${JSON.stringify(ARGV_LOG)};
const PANE_SEQ = ${JSON.stringify(PANE_SEQ)};
const argv = process.argv.slice(2);
fs.appendFileSync(ARGV_LOG, argv.join(' ') + '\\n');

const panes = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const save = () => fs.writeFileSync(CENSUS, JSON.stringify(panes));
const ok = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const err = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};

if (argv[0] === 'agent' && argv[1] === 'list') ok({ type: 'agent_list', agents: panes });

if (argv[0] === 'agent' && argv[1] === 'get') {
  const found = panes.find((p) => p.name === argv[2]);
  if (!found) err('agent_not_found', 'no such agent');
  ok({ agent: found });
}

if (argv[0] === 'agent' && argv[1] === 'start') {
  const name = argv[2];
  if (panes.some((p) => p.name === name)) err('agent_name_taken', 'agent name is taken');
  const cwdFlag = argv.indexOf('--cwd');
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    agent_status: 'working',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1]
  });
  save();
  ok({});
}

if (argv[0] === 'pane' && argv[1] === 'close') {
  const at = panes.findIndex((p) => p.pane_id === argv[2]);
  if (at === -1) err('pane_not_found', 'no such pane');
  panes.splice(at, 1);
  save();
  ok({});
}

if (argv[0] === 'agent' && argv[1] === 'attach') {
  setInterval(() => {}, 60000);
} else if (argv[0] === 'tab' && argv[1] === 'create') {
  ok({ result: undefined, tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } });
} else if (argv[0] === 'pane' && argv[1] === 'list') {
  ok({ panes: [] });
} else {
  ok({});
}
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;
fs.writeFileSync(PANE_SEQ, '0');
fs.writeFileSync(ARGV_LOG, '');
fs.writeFileSync(CENSUS_FILE, '[]');

// ---------------------------------------------------------------------------
// THE LEVERS, set before the daemon modules are imported so `optionsFromEnv`
// sees them, and each one named with what it is holding still.
//
// A proof about the CPU term must not be decided by the count term or the
// memory term, and on a shared machine either could bind at any moment. So both
// are opened up deliberately and §6 ASSERTS that neither ended up binding —
// without that assertion, a memory-bound refusal would look exactly like this
// term working.
// ---------------------------------------------------------------------------
process.env.CRABCAST_MAX_AGENTS = '99';
process.env.CRABCAST_AGENT_MEMORY_MB = '32';
delete process.env.CRABCAST_AGENT_CORES;

const capacityMod = await import(path.join(distDir, 'capacity.js'));
const {
  computeCapacity,
  describeCapacity,
  capacityReason,
  readMachineFacts,
  chargeAgainstCpuWindow,
  chargeAgainstLoad1,
  startingAgentCores,
  MEASURED_AGENT_COST,
  LOAD1_PERIOD_MS
} = capacityMod;
const { setObservedCpu, freshObservedCpu, measureMachineCpu, MAX_OBSERVATION_AGE_MS } =
  await import(path.join(distDir, 'machine-cpu.js'));
const { clearStartsInFlight, startsInFlight, recordAgentStart, START_LEDGER_HORIZON_MS } =
  await import(path.join(distDir, 'starts-in-flight.js'));
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

const openBridges = [];
function newBridge() {
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  openBridges.push(bridge);
  return bridge;
}
function killPtys() {
  for (const bridge of openBridges) {
    for (const session of bridge.listActiveSessions()) {
      try {
        session.ptyProcess?.kill();
      } catch {}
    }
  }
}
// ON SIGNALS AS WELL AS ON EXIT. A proof interrupted halfway must not leave the
// machine holding node processes it started — the residue rule this suite holds
// every proof to (verify-proof-cleans-up-when-interrupted).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killPtys();
    process.exit(130);
  });
}
process.on('exit', killPtys);

const censusPanes = () => JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));
const ownedDir = (name) => {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
};

// ===========================================================================
console.log('\n=== 1. the instrument, and where a start sits in a window ===\n');
// ===========================================================================

const liveWindow = await measureMachineCpu(1);
check(
  'a real 1s window off this machine\'s /proc/stat yields an observation, so the path from ' +
    'kernel counters to a CpuObservation runs here with nothing hand-written in it',
  liveWindow === null || (liveWindow.busyCores >= 0 && liveWindow.windowSeconds >= 1),
  liveWindow
    ? `busyCores=${liveWindow.busyCores.toFixed(2)} over ${liveWindow.windowSeconds.toFixed(1)}s`
    : 'NOT RUN — no readable /proc/stat on this machine (the CPU term is inert here and the ' +
      'load average is what §3 would bind on; that branch is asserted in §3 separately)'
);

// The weight function through its public front door, on a synthetic window
// whose edges are exact. THE EDGES ARE THE WHOLE CLAIM: a start at the opening
// edge is fully contained by the average and must cost nothing, one at the
// closing edge was absent for all of it and must cost a full agent, and one
// after the close is the ticket's case.
const W_END = 2_000_000;
const W_SECONDS = 30;
const window30 = { busyCores: 1, windowSeconds: W_SECONDS, sampledAt: W_END };
const W_OPEN = W_END - W_SECONDS * 1000;
const seedCost = { residentBytes: MEASURED_AGENT_COST.residentBytes, cores: MEASURED_AGENT_COST.cores };
const weightOf = (at) =>
  chargeAgainstCpuWindow([{ path: '/x', at }], window30, seedCost, 'seed').agentEquivalents;

const edges = [
  ['before the window opened', W_OPEN - 1_000, 0],
  ['exactly at the opening edge', W_OPEN, 0],
  ['halfway through the window', W_OPEN + 15_000, 0.5],
  ['exactly at the closing edge', W_END, 1],
  ['after the window closed — the ticket\'s case', W_END + 5_000, 1]
];
for (const [label, at, expected] of edges) {
  const got = weightOf(at);
  check(
    `a start ${label} weighs ${expected}`,
    Math.abs(got - expected) < 1e-9,
    `weight=${got}`
  );
}

// The load branch's own predicate, which is a step and says so.
const loadNow = 5_000_000;
const loadCharge = (at) =>
  chargeAgainstLoad1([{ path: '/x', at }], seedCost, 'seed', loadNow).charged;
check(
  'on the load-average branch a start inside the minute it means over is charged in full, and ' +
    'one older than that is not — a step, because load1 is an exponential mean that weights ' +
    'the newest work least and a linear ramp over it would understate',
  loadCharge(loadNow - 1_000) === 1 && loadCharge(loadNow - LOAD1_PERIOD_MS - 1) === 0,
  `inside=${loadCharge(loadNow - 1_000)} outside=${loadCharge(loadNow - LOAD1_PERIOD_MS - 1)}`
);

// ===========================================================================
console.log('\n=== 2. what a STARTING agent is charged, which is not what a settled one costs ===\n');
// ===========================================================================

// The case wroosbit/butchr's live capacity report showed on this machine:
// a measured divisor of 0.117 cores against a 0.75 core seed. Charging a start
// at the settled rate would have made this whole term inert.
const settledMeasured = {
  residentBytes: 748 * 1024 ** 2,
  cores: 0.117,
  sampledAt: Date.now(),
  windowSeconds: 60,
  agentTrees: 6, treesSeen: 6
};
const measuredRate = startingAgentCores({ residentBytes: 0, cores: 0.117 }, 'measured');
check(
  'a start is charged the seed rather than a settled agent\'s measured cost — both cost figures ' +
    'in this model are steady-state by construction, and ten simultaneously-booting agent trees ' +
    'are not 1.17 cores',
  measuredRate === MEASURED_AGENT_COST.cores,
  `rate=${measuredRate} seed=${MEASURED_AGENT_COST.cores} measured=0.117`
);
check(
  'a measurement ABOVE the seed is not lowered to it — the rate is the larger of the two, not ' +
    'the seed outright',
  startingAgentCores({ residentBytes: 0, cores: 2 }, 'measured') === 2
);
check(
  'but an explicit operator override is honoured outright, because this file\'s precedence rule ' +
    'is an argument and not a convenience: a fleet that argues with its operator gets turned off',
  startingAgentCores({ residentBytes: 0, cores: 0.2 }, 'override') === 0.2,
  `rate=${startingAgentCores({ residentBytes: 0, cores: 0.2 }, 'override')}`
);

// ===========================================================================
console.log('\n=== 3. the arithmetic: N starts inside one window walk headroom to 0 ===\n');
// ===========================================================================

const NOW = 3_000_000;
const FIXTURE_CORES = 4;
const fixtureMachine = (starts) => ({
  cores: FIXTURE_CORES,
  totalBytes: 16 * 1024 ** 3,
  availableBytes: 12 * 1024 ** 3,
  load1: 0.5,
  cpu: { busyCores: 1.0, windowSeconds: 30, sampledAt: NOW - 5_000 },
  stall: null
});
// The count and memory terms are held wide open so the CPU term is what the
// section is actually about; §3's own checks then require `bound by cpu`, which
// is what makes that holding-open visible rather than assumed.
const ROOMY = { configuredCap: 99, overrides: { residentBytes: 32 * 1024 ** 2 } };
const fixtureAt = (n) =>
  computeCapacity(fixtureMachine(), 0, {
    ...ROOMY,
    now: NOW,
    // Starts AFTER the window closed, which is the ticket's scenario exactly:
    // a 3-second stagger inside a 30-second sample interval.
    startedAt: Array.from({ length: n }, (_, i) => ({ path: `/a${i}`, at: NOW - 5_000 + i })),
    measured: settledMeasured
  });

const walk = [0, 1, 2, 3].map((n) => ({ n, c: fixtureAt(n) }));
for (const { n, c } of walk) {
  console.log(
    `    ${n} start(s) in flight: charge ${c.startsCharge.cores} cores, ` +
    `headroomByCpu ${c.headroomByCpu}, bound by ${c.headroomBoundBy}`
  );
}
check(
  'headroomByCpu falls MONOTONICALLY as starts accumulate against one unchanged observation — ' +
    'the defect is that it did not move at all',
  walk.every((w, i) => i === 0 || w.c.headroomByCpu <= walk[i - 1].c.headroomByCpu) &&
    walk[3].c.headroomByCpu < walk[0].c.headroomByCpu,
  walk.map((w) => `${w.n}→${w.c.headroomByCpu}`).join(' ')
);
check(
  'and it reaches 0 — a sequence of starts inside one sample window closes the gate on itself ' +
    'rather than running to the count term',
  walk[3].c.headroomByCpu === 0 && walk[3].c.atCapacity === true,
  `headroomByCpu=${walk[3].c.headroomByCpu} atCapacity=${walk[3].c.atCapacity}`
);

// THE COUNTERFACTUAL, and it is what stops a refusal caused by anything else
// from passing as this term working. Same machine, same everything, empty
// ledger: it must ADMIT.
const noStarts = walk[0].c;
check(
  'COUNTERFACTUAL: the same machine with an empty ledger ADMITS — so a gate welded shut fails ' +
    'here as loudly as one welded open',
  noStarts.headroomByCpu > 0 && noStarts.atCapacity === false,
  `headroomByCpu=${noStarts.headroomByCpu} atCapacity=${noStarts.atCapacity}`
);
check(
  'the refusal names cpu as what bound, not the count and not memory',
  walk[3].c.headroomBoundBy === 'cpu',
  `bound by ${walk[3].c.headroomBoundBy}`
);

// The load branch, which fills the CPU-side slot where nothing measured CPU and
// would otherwise carry the blindness intact onto every machine without
// /proc/stat.
const loadFixture = (n) =>
  computeCapacity(
    { ...fixtureMachine(), cpu: null, load1: 1.0 },
    0,
    {
      ...ROOMY,
      now: NOW,
      startedAt: Array.from({ length: n }, (_, i) => ({ path: `/a${i}`, at: NOW - i * 100 })),
      measured: settledMeasured
    }
  );
check(
  'the LOAD branch is charged too — a machine with no /proc/stat must not keep the blindness ' +
    'this ticket removed, and it is the branch that would have kept it invisibly',
  loadFixture(3).headroomByLoad < loadFixture(0).headroomByLoad &&
    loadFixture(0).headroomBoundBy === 'load' &&
    loadFixture(3).headroomBoundBy === 'load',
  `0 starts→${loadFixture(0).headroomByLoad} (bound by ${loadFixture(0).headroomBoundBy}), ` +
    `3 starts→${loadFixture(3).headroomByLoad} (bound by ${loadFixture(3).headroomBoundBy})`
);

// ===========================================================================
console.log('\n=== 4. the drive: the REAL reconciler against a fleet larger than headroom ===\n');
// ===========================================================================

// --- the derived fixture -----------------------------------------------------
const probe = computeCapacity(readMachineFacts(), 0, { configuredCap: 99 });
const REAL_CORES = probe.machine.cores;
const RESERVED = probe.reservedForHuman.cores;
const COST_CORES = probe.cost.cores;
const K = 2; // agents this machine will be made to have room for

// busy = cores − reserved − (K + 0.5) × cost, so floor((cores−reserved−busy)/cost) === K
// exactly, with half an agent of slack either side of the boundary. Every input
// is read off this machine or off the shipped model; no tick counter, no
// literal, nothing that accumulates with uptime.
const BUSY_CORES = REAL_CORES - RESERVED - (K + 0.5) * COST_CORES;
const machineCanHostFixture = BUSY_CORES > 0 && BUSY_CORES < REAL_CORES && !probe.stalled;

console.log(
  `    derived: ${REAL_CORES} cores − ${RESERVED} reserved − ` +
  `(${K} + 0.5) × ${COST_CORES} core/agent = ${BUSY_CORES.toFixed(3)} busy cores`
);

const N_AGENTS = 5;
let drive = null;

driveSection: {
  if (!machineCanHostFixture) {
    check(
      'the fixture can be constructed on this machine',
      false,
      `NOT RUN — busyCores=${BUSY_CORES.toFixed(3)} against ${REAL_CORES} cores, ` +
        `stalled=${probe.stalled}. This machine is too small (or too stalled) to host a ` +
        `CPU-bound fixture with room for ${K}; the drive cannot run and is FAILED rather than ` +
        `skipped, because a silently skipped drive is this file measuring nothing.`
    );
    break driveSection;
  }

  const registryFile = path.join(tmp, 'agents.jsonl');
  const dirs = Array.from({ length: N_AGENTS }, (_, i) => ownedDir(`agent-${i}`));

  // --- setup: N agents exist and are expected, then the machine goes down ----
  // Activated PAST THE GATE deliberately: this is arranging the precondition,
  // not the assertion. The assertion is what the RESTORE pass does.
  const registry1 = new AgentRegistry(registryFile);
  const bridge1 = newBridge();
  const setupRouter = new MessageRouter({
    config,
    herdrBridge: bridge1,
    daemonStartedAt: new Date(),
    agentRegistry: registry1,
    send: () => {},
    broadcast: () => {}
  });
  for (const dir of dirs) {
    registry1.recordConfigured({
      path: dir,
      config: { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell' }
    });
    await new Promise((resolve) => {
      new MessageRouter({
        config,
        herdrBridge: bridge1,
        daemonStartedAt: new Date(),
        agentRegistry: registry1,
        send: (msg) => resolve(msg),
        broadcast: () => {}
      }).handle({ action: 'activate_agent', path: dir, override: true });
    });
  }
  void setupRouter;

  const panesAfterSetup = censusPanes().length;
  check(
    `(setup) ${N_AGENTS} agents exist and the registry expects them all`,
    panesAfterSetup === N_AGENTS && registry1.expected().length === N_AGENTS,
    `panes=${panesAfterSetup} expected=${registry1.expected().length}`
  );

  // The machine goes down: panes die with it, PTYs die with the daemon, and a
  // fresh process comes up over the same registry file. THE LEDGER IS CLEARED
  // HERE and that is not a convenience — it is what a restart really does. It
  // is module state in a process that has just been replaced, so a restoration
  // starts with no memory of any start, which is precisely the state in which
  // the defect bit.
  killPtys();
  fs.writeFileSync(CENSUS_FILE, '[]');
  clearStartsInFlight();

  check(
    '(setup) and the ledger is empty, as it is in a daemon that has just come up — so every ' +
      'start this drive charges for is one the drive itself produced',
    startsInFlight().length === 0
  );

  // --- the busy machine, published through the real front door ---------------
  const fixture = { busyCores: BUSY_CORES, windowSeconds: 30, sampledAt: Date.now() };
  setObservedCpu(fixture);

  const before = computeCapacity(readMachineFacts(), 0, { configuredCap: 99 });
  console.log(`    before the pass: headroom ${before.headroom}, bound by ${before.headroomBoundBy}`);
  check(
    `(precondition) the machine now has room for exactly ${K}, and CPU is what bounds it — ` +
      'this is the assertion that the fixture was actually exercised rather than merely built',
    before.headroom === K && before.headroomBoundBy === 'cpu',
    `headroom=${before.headroom} bound by ${before.headroomBoundBy} ` +
      `(count ${before.headroomByCap}, cpu ${before.headroomByCpu}, memory ${before.headroomByMemory})`
  );

  // --- the drive -------------------------------------------------------------
  const registry2 = new AgentRegistry(registryFile);
  const bridge2 = newBridge();
  const router2 = new MessageRouter({
    config,
    herdrBridge: bridge2,
    daemonStartedAt: new Date(),
    agentRegistry: registry2,
    send: () => {},
    broadcast: () => {}
  });

  const log = [];
  const startedAtMs = Date.now();
  const result = await reconcileAgents({
    registry: registry2,
    herdrBridge: bridge2,
    router: router2,
    cause: 'reboot',
    log: (...a) => log.push(a.join(' '))
  });
  const elapsed = Date.now() - startedAtMs;

  const restored = result.outcomes.filter((o) => o.result === 'restored');
  const deferred = result.outcomes.filter((o) => o.result === 'deferred');
  const failed = result.outcomes.filter((o) => o.result === 'failed');
  drive = { result, log, restored, deferred, failed, before, fixture, elapsed, dirs };

  console.log(
    `    outcome: ${restored.length} restored, ${deferred.length} deferred, ` +
    `${failed.length} failed of ${result.expected} expected (${(elapsed / 1000).toFixed(0)}s)`
  );

  check(
    `A RESTORE SEQUENCE OF ${N_AGENTS} CANNOT ADMIT MORE THAN THE MACHINE'S ${K} — this is the ` +
      'central assertion, and it is counted off a real pass rather than computed',
    restored.length === K,
    `restored=${restored.length} expected room for ${K}`
  );
  check(
    'the rest were DEFERRED and not FAILED — a transient refusal must not become the permanent ' +
      'verdict a human reads at boot beside a perfectly restorable agent',
    deferred.length === N_AGENTS - K && failed.length === 0,
    `deferred=${deferred.length} failed=${failed.length}`
  );
  check(
    'and each deferral says the MACHINE refused it, not herdr — two conditions with different ' +
      'remedies, and a reader who cannot tell them apart cannot act on either',
    deferred.length > 0 && deferred.every((o) => o.deferredBy === 'capacity'),
    JSON.stringify(deferred.map((o) => o.deferredBy))
  );
  check(
    'NOTHING WAS RECORDED for the deferred agents — they are still expected, which is the whole ' +
      'reason a refusal here is safe: the registry is what stops a busy minute becoming a ' +
      'permanent disappearance',
    deferred.every((o) => registry2.expected().some((r) => r.path === o.path)),
    `expected=${registry2.expected().length} of ${N_AGENTS}`
  );
  check(
    'and the panes agree with the outcomes: exactly the restored agents exist',
    censusPanes().length === K,
    `panes=${censusPanes().length}`
  );
}

// ===========================================================================
console.log('\n=== 5. the words: the refusal names its constraint in figures that reproduce ===\n');
// ===========================================================================

wordsSection: {
  if (!drive) {
    check('the deferral log can be read', false, 'NOT RUN — §4 did not produce a drive');
    break wordsSection;
  }

  const deferralLines = drive.log.filter((l) => /Deferring .*no room for it right now/.test(l));
  for (const line of deferralLines.slice(0, 1)) console.log(line.split('\n').map((l) => `    ${l}`).join('\n'));

  // EVERY deferred agent is named in the log, not merely counted. The count of
  // LINES is deliberately not asserted: the deferred pass retries each one once,
  // so a refusal that stands is logged twice, and pinning the number would make
  // this assertion about the retry policy rather than about the logging.
  check(
    'every capacity deferral is logged BY PATH, with the gate\'s own words and not a summary — ' +
      'a boot log that says "3 deferred" and does not say which is a log nobody can act on',
    drive.deferred.length > 0 &&
      drive.deferred.every((o) => deferralLines.some((l) => l.includes(o.path))),
    `${deferralLines.length} line(s) covering ${drive.deferred.length} deferred agent(s)`
  );
  const firstDeferral = deferralLines[0] ?? '';
  check(
    'the refusal leads with the binding constraint as a HEADLINE — `cpu too busy`, which is a ' +
      'different fact from `at capacity` and from `load too high` and tells the reader which',
    /cpu too busy/.test(firstDeferral),
    (firstDeferral.match(/Refusing to activate [^\n]*/) ?? ['(absent)'])[0].slice(0, 130)
  );
  check(
    'and the derivation ends by naming the same term, so the headline and the arithmetic cannot ' +
      'drift apart',
    /bound by cpu/.test(firstDeferral),
    /bound by (\w+)/.exec(firstDeferral)?.[0] ?? '(absent)'
  );
  check(
    'AC3: it says starts in flight were counted, and how many — a charge the reader cannot see ' +
      'is a subtraction that does not come out',
    /cores charged for \d+ agent\(s\) that started too recently/.test(firstDeferral),
    (firstDeferral.match(/cores charged for [^,.]*/) ?? ['(absent)'])[0]
  );
  check(
    'and the derivation carries the charge inside the cpu term\'s own parentheses, so the ' +
      'arithmetic can be checked by adding up the numbers in front of you',
    /cpu allows \d+ \(\([\d.]+ cores − [\d.]+ reserved − [\d.]+ in use − [\d.]+ starting\)/.test(
      firstDeferral
    ),
    (firstDeferral.match(/cpu allows [^,]*/) ?? ['(absent)'])[0]
  );
  check(
    'the starts line names the window the charge was measured against, so a reader can date it',
    /starts in flight: [\d.]+ core\(s\) charged against the CPU window/.test(firstDeferral) &&
      /began after the CPU window opened at \d{4}-/.test(firstDeferral),
    (firstDeferral.match(/starts in flight: [^\n]*/) ?? ['(absent)'])[0]?.slice(0, 150)
  );

  // Reproduce the verdict by hand out of the figures the log printed. This is
  // the AC3 claim taken literally: "reproducible figures" means a reader can
  // recompute the refusal, so this file does.
  const m = firstDeferral.match(
    /cpu allows (\d+) \(\(([\d.]+) cores − ([\d.]+) reserved − ([\d.]+) in use − ([\d.]+) starting\) ÷ ([\d.]+)\)/
  );
  if (m) {
    const [, allows, cores, reserved, inUse, starting, divisor] = m;
    const recomputed = Math.max(
      0,
      Math.floor(
        (parseFloat(cores) - parseFloat(reserved) - parseFloat(inUse) - parseFloat(starting)) /
          parseFloat(divisor)
      )
    );
    check(
      'THE PRINTED FIGURES REPRODUCE THE PRINTED VERDICT — recomputed by hand from the log line ' +
        'alone, which is what "reproducible figures" has to mean if it means anything',
      recomputed === Number(allows),
      `(${cores} − ${reserved} − ${inUse} − ${starting}) ÷ ${divisor} = ${recomputed}, ` +
        `log says ${allows}`
    );
  } else {
    check('the cpu term is printed in a shape a reader can recompute from', false, 'no match');
  }

  const summary = drive.log.find((l) => /still deferred of \d+ expected/.test(l));
  check(
    'and the pass says out loud that it came back short, naming the agents it held back — a boot ' +
      'that quietly returns 2 of 5 is indistinguishable from a machine that only ever had 2',
    Boolean(summary) && /held back because this machine had no room/.test(summary ?? ''),
    summary?.slice(0, 160) ?? '(absent)'
  );
}

// ===========================================================================
console.log('\n=== 6. vacuity: was any of that actually exercised? ===\n');
// ===========================================================================

check(
  'the busy figure is DERIVED and lies strictly inside (0, cores) — a fixture outside that range ' +
    'is one that stopped describing a machine, which is how KAN-245\'s literal expired unnoticed',
  BUSY_CORES > 0 && BUSY_CORES < REAL_CORES,
  `busy=${BUSY_CORES.toFixed(3)} of ${REAL_CORES} cores`
);

if (drive) {
  check(
    'BOTH VERDICTS WERE OBSERVED in the drive: at least one restore ADMITTED and at least one ' +
      'REFUSED. A fixture that has stopped saturating and a machine that had room anyway both ' +
      'produce a clean pass without this',
    drive.restored.length > 0 && drive.deferred.length > 0,
    `admitted=${drive.restored.length} refused=${drive.deferred.length}`
  );
  check(
    'the observation the drive was gated on was still FRESH when the pass ended — otherwise this ' +
      'file spent its run measuring the load-average fallback and would never have said so',
    drive.elapsed < MAX_OBSERVATION_AGE_MS && freshObservedCpu() !== null,
    `pass took ${(drive.elapsed / 1000).toFixed(0)}s against a ${MAX_OBSERVATION_AGE_MS / 1000}s ` +
      `staleness bound; observation ${freshObservedCpu() ? 'still fresh' : 'EXPIRED'}`
  );
  check(
    'neither the count term nor the memory term bound — they were opened up on purpose, and ' +
      'without this a memory-bound refusal would look exactly like the term under test working',
    drive.before.headroomByCap > K && drive.before.headroomByMemory > K,
    `count=${drive.before.headroomByCap} memory=${drive.before.headroomByMemory} cpu=${drive.before.headroomByCpu}`
  );
  check(
    'and the machine was not stalled, so the veto is not what refused these agents',
    drive.before.stalled === false,
    `stalled=${drive.before.stalled} (${drive.before.stallPercent ?? 'no reading'}%)`
  );
}

// ===========================================================================
console.log('\n=== 7. the ledger horizon cannot prune anything still chargeable ===\n');
// ===========================================================================

// The horizon is documented as a MEMORY BOUND rather than a correctness
// parameter, and that claim is only true while it exceeds the oldest instant
// any term can charge. Asserted rather than trusted: a horizon that crept below
// it would silently stop charging real starts, and every other assertion in
// this file would stay green.
const OLDEST_CHARGEABLE_MS = MAX_OBSERVATION_AGE_MS + 30_000; // believed observation + its window
check(
  'START_LEDGER_HORIZON_MS exceeds the oldest instant any term can charge, so pruning changes ' +
    'no answer and is a memory bound rather than a tuning knob',
  START_LEDGER_HORIZON_MS > OLDEST_CHARGEABLE_MS && START_LEDGER_HORIZON_MS > LOAD1_PERIOD_MS,
  `horizon=${START_LEDGER_HORIZON_MS}ms vs oldest chargeable ≈ ${OLDEST_CHARGEABLE_MS}ms ` +
    `(${MAX_OBSERVATION_AGE_MS}ms staleness + a 30s window) and a ${LOAD1_PERIOD_MS}ms load period`
);

clearStartsInFlight();
const t = Date.now();
recordAgentStart('/recent', t - 1_000);
recordAgentStart('/ancient', t - START_LEDGER_HORIZON_MS - 60_000);
check(
  'and it really prunes: an entry past the horizon is dropped and a recent one is kept',
  startsInFlight().length === 1 && startsInFlight()[0].path === '/recent',
  JSON.stringify(startsInFlight().map((s) => s.path))
);
clearStartsInFlight();

// ===========================================================================
console.log('\n=== 8. the red: three ways this file goes red on a build that has the defect ===\n');
// ===========================================================================

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch: path.join(tmp, 'mutants'),
  report
});

/**
 * Run §4's drive against a mutated build, in a child process.
 *
 * A CHILD RATHER THAN AN IMPORT, because the modules under test hold process
 * state — the ledger, the published observation, the capacity env — and a
 * second copy of them in this process would either share that state or fight
 * over it. The child re-runs the real reconciler over its own registry and
 * prints one line of JSON.
 */
/**
 * Make a mutant under `os.tmpdir()` able to resolve `node-pty`.
 *
 * THE SAME BLOCKER `verify-restart-survival` HIT AND FOR ITS REASON, restated
 * because this file would otherwise look like it invented a symlink for fun: a
 * mutant that reaches `reconcile.js` pulls in `herdr.js` as a VALUE, and
 * `herdr.js` imports a native addon. From a scratch directory outside the
 * repository that does not resolve, and the failure is `ERR_MODULE_NOT_FOUND`
 * at import time — which looks from outside exactly like a mutant that ran and
 * changed nothing. That is the inversion `mutation.mjs`'s header says it cannot
 * cover for its callers, so this is the caller covering it.
 *
 * The alternative — putting the mutant inside the repo so resolution walks up —
 * writes a mutated build into a working tree other checks read. This stays in
 * scratch, and is taken down by name at the end of §8.
 */
const linkedMutantDeps = [];
function linkRuntimeDepsInto(mutantDir) {
  const link = path.join(mutantDir, 'node_modules');
  if (fs.existsSync(link)) return { ok: true, link, detail: 'already linked' };
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve('node-pty');
  } catch (err) {
    return { ok: false, link, detail: `node-pty is not resolvable from this script (${err?.message ?? err})` };
  }
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = entry.lastIndexOf(marker);
  if (at === -1) {
    return { ok: false, link, detail: `node-pty resolved to ${entry}, outside any node_modules` };
  }
  const real = entry.slice(0, at + marker.length - 1);
  fs.symlinkSync(real, link, 'dir');
  // READ BACK THROUGH THE LINK rather than reporting what was asked for: the
  // two differ exactly when something is wrong, and this is the setup a whole
  // section depends on.
  const ok = fs.existsSync(path.join(link, 'node-pty'));
  linkedMutantDeps.push({ link, real });
  return { ok, link, real, detail: ok ? `${link} -> ${real}` : `${link} created but node-pty is not readable through it` };
}

async function driveMutant(name, mutantDir) {
  const linked = linkRuntimeDepsInto(mutantDir);
  if (!linked.ok) {
    check(`the '${name}' mutant can resolve its native dependency`, false, linked.detail);
    return null;
  }
  const runner = path.join(tmp, `run-${name}.mjs`);
  fs.writeFileSync(
    runner,
    `import * as fs from 'fs';
import * as path from 'path';
const dist = ${JSON.stringify(mutantDir)};
const tmp = ${JSON.stringify(tmp)};
process.env.PATH = ${JSON.stringify(process.env.PATH)};
process.env.CRABCAST_MAX_AGENTS = '99';
process.env.CRABCAST_AGENT_MEMORY_MB = '32';
const { setObservedCpu } = await import(path.join(dist, 'machine-cpu.js'));
const { clearStartsInFlight } = await import(path.join(dist, 'starts-in-flight.js'));
const { HerdrBridge } = await import(path.join(dist, 'herdr.js'));
const { MessageRouter } = await import(path.join(dist, 'router.js'));
const { AgentRegistry } = await import(path.join(dist, 'agent-registry.js'));
const { loadConfig } = await import(path.join(dist, 'config.js'));
const { reconcileAgents } = await import(path.join(dist, 'reconcile.js'));

const scratch = fs.mkdtempSync(path.join(tmp, 'mutant-run-'));
const configPath = path.join(scratch, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir: path.join(scratch, 'data') }));
const config = loadConfig(configPath);
fs.writeFileSync(${JSON.stringify(CENSUS_FILE)}, '[]');

const dirs = [];
for (let i = 0; i < ${N_AGENTS}; i++) {
  const d = path.join(scratch, 'owned', 'a' + i);
  fs.mkdirSync(d, { recursive: true });
  dirs.push(fs.realpathSync(d));
}
const registryFile = path.join(scratch, 'agents.jsonl');
const reg1 = new AgentRegistry(registryFile);
const bridge1 = new HerdrBridge(config.dataDir, config.configPath);
const bridges = [bridge1];
for (const dir of dirs) {
  reg1.recordConfigured({ path: dir, config: { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell' } });
  await new Promise((resolve) => {
    new MessageRouter({ config, herdrBridge: bridge1, daemonStartedAt: new Date(), agentRegistry: reg1, send: resolve, broadcast: () => {} })
      .handle({ action: 'activate_agent', path: dir, override: true });
  });
}
const kill = () => { for (const b of bridges) for (const s of b.listActiveSessions()) { try { s.ptyProcess?.kill(); } catch {} } };
process.on('exit', kill);
for (const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig, () => { kill(); process.exit(130); });

kill();
fs.writeFileSync(${JSON.stringify(CENSUS_FILE)}, '[]');
clearStartsInFlight();
setObservedCpu({ busyCores: ${BUSY_CORES}, windowSeconds: 30, sampledAt: Date.now() });

const reg2 = new AgentRegistry(registryFile);
const bridge2 = new HerdrBridge(config.dataDir, config.configPath);
bridges.push(bridge2);
const router2 = new MessageRouter({ config, herdrBridge: bridge2, daemonStartedAt: new Date(), agentRegistry: reg2, send: () => {}, broadcast: () => {} });
const out = await reconcileAgents({ registry: reg2, herdrBridge: bridge2, router: router2, cause: 'reboot', log: () => {} });
kill();
console.log('RESULT ' + JSON.stringify({
  restored: out.outcomes.filter((o) => o.result === 'restored').length,
  deferred: out.outcomes.filter((o) => o.result === 'deferred').length,
  failed: out.outcomes.filter((o) => o.result === 'failed').length
}));
`
  );

  const { spawn } = await import('child_process');
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) {
        // A MUTANT THAT DIED IS NOT A MUTANT THAT BEHAVED, and the two produce
        // the same observation — nothing happened — which is exactly the
        // inversion `mutation.mjs`'s header warns every caller it cannot cover.
        // So a dead mutant says so, loudly, with what killed it.
        console.log(`    mutant '${name}' exited ${code} without a result:`);
        for (const l of err.trim().split('\n').slice(-6)) console.log(`      ${l}`);
      }
      resolve(line ? JSON.parse(line.slice(7)) : null);
    });
  });
}

if (!drive) {
  check(
    'the mutation sections can run',
    false,
    'NOT RUN — §4 produced no baseline to compare a mutant against, so a mutant result would ' +
      'have nothing to be red relative to'
  );
} else {
  // --- 8a: the bypass restored -----------------------------------------------
  mutationA: {
    const dir = mutate('bypass-restored', 'reconcile.js', 'resume: cause', 'resume: cause, override: true');
    if (!dir) break mutationA;
    const r = await driveMutant('bypass', dir);
    console.log(`    bypass restored: ${JSON.stringify(r)}`);
    check(
      '8a. RESTORING `override: true` admits the WHOLE fleet onto a machine with room for ' +
        `${K} — the unbounded half of this defect, and the reason AC1 was unreachable before ` +
        'this change',
      r !== null && r.restored === N_AGENTS && r.deferred === 0,
      r ? `restored=${r.restored} of ${N_AGENTS}, deferred=${r.deferred}` : 'mutant produced no result'
    );
  }

  // --- 8b: the charge deleted -------------------------------------------------
  mutationB: {
    const dir = mutate(
      'charge-deleted',
      'capacity.js',
      '- startsChargeByCpu.cores) / cost.cores',
      '- 0 * startsChargeByCpu.cores) / cost.cores'
    );
    if (!dir) break mutationB;
    const r = await driveMutant('charge', dir);
    console.log(`    charge deleted: ${JSON.stringify(r)}`);
    check(
      '8b. DELETING THE CPU CHARGE — the gate still runs, still refuses in principle, and admits ' +
        `more than ${K} because every restore is measured against one observation none of them ` +
        'is in. This is the ticket\'s defect with the bypass already fixed',
      r !== null && r.restored > K,
      r ? `restored=${r.restored} against room for ${K}` : 'mutant produced no result'
    );
  }

  // --- 8c: the ledger write deleted -------------------------------------------
  mutationC: {
    const dir = mutate('ledger-unwired', 'router.js', 'recordAgentStart(agentPath);', 'void agentPath;');
    if (!dir) break mutationC;
    const r = await driveMutant('ledger', dir);
    console.log(`    ledger unwired: ${JSON.stringify(r)}`);
    check(
      '8c. DELETING THE LEDGER WRITE with the arithmetic left perfectly intact — the KAN-145 ' +
        'shape, where a mechanism is correct and permanently fed nothing. Everything in §1-§3 ' +
        'stays green against this build; only a drive that PRODUCES its own starts catches it',
      r !== null && r.restored > K,
      r ? `restored=${r.restored} against room for ${K}` : 'mutant produced no result'
    );
  }
}

// Removed BY NAME rather than left to a recursive delete. `rmSync` unlinks a
// symlink instead of descending it, so the scratch tree was already safe — but
// "the proof that deleted the repository's node_modules" is a bad enough
// outcome to take the link down explicitly and check its target afterwards.
for (const { link, real } of linkedMutantDeps) {
  fs.unlinkSync(link);
  check(
    `the scratch symlink ${path.basename(path.dirname(link))}/node_modules is gone and the REAL ` +
      'node_modules it pointed at is untouched',
    !fs.existsSync(link) && fs.existsSync(path.join(real, 'node-pty')),
    `removed=${!fs.existsSync(link)} target intact=${fs.existsSync(path.join(real, 'node-pty'))}`
  );
}

if (typeof mutationsSkipped === 'function' && mutationsSkipped().length) {
  check(
    'every mutation applied — a skipped one leaves its section unrun, and the run must say so ' +
      'rather than reporting the sections that did run as the whole story',
    false,
    JSON.stringify(mutationsSkipped())
  );
}

// ===========================================================================
killPtys();
console.log(`\n${'='.repeat(76)}`);
if (failures.length) {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log('All checks passed.');
}
console.log(`${'='.repeat(76)}\n`);

process.exit(failures.length ? 1 : 0);
