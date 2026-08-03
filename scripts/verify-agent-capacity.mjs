#!/usr/bin/env node
// Live proof for the capacity model (KAN-71, ported from the extraction
// source's KAN-34/36/41/44/56/57/60 lineage): the concurrent-agent cap is
// derived from the hardware, travels between machines, refuses legibly, moves
// with load, honours per-type gateExempt from config, and can be overridden
// on purpose.
//
// Sixteen sections:
//
//   1. derivation    — the cap on THIS machine, with the arithmetic
//   2. reservation   — the removed supervisor reservation, before and after
//   3. exempt agents — running gate-exempt agents change no arithmetic
//   4. portability   — the same arithmetic against hardware we don't have
//   5. census        — exempt + charged agents through the real `capacity` action
//   6. refusal       — a real activate call at capacity, and what it answers
//   7. re-attach     — the same call for an agent that is already running
//   8. load          — the same fleet idle and busy, answering differently
//   9. override      — the refusal bypassed deliberately, and recorded
//  10. provenance    — measured cost vs seed: the divisor moves, and says so
//  11. damping       — step response both directions: up fast, down slow
//  12. degrade       — the instrument breaks; capacity answers from the seed
//  13. precedence    — env overrides beat the measurement beats the seed,
//                      and a zero agent COST is rejected where a zero cap is honoured
//  14. gateExempt gate — exempt types activate at zero headroom, no override
//  15. refusal headline — the headline names the constraint that bound
//  16. cores floor  — an idle fleet's measurement cannot round the CPU
//                      dimension to a zero divisor
//
// Sections 5 through 7, 9 and 14 drive the real MessageRouter — handleCapacity
// and handleActivateByKey, the same calls an MCP caller makes — so what they
// print is what a caller actually receives, not a reconstruction. herdr is
// stubbed rather than run: this proves the capacity gate, and the gate
// refuses *before* herdr is ever asked to spawn anything.
//
// Run `npm run build` first. Usage: node scripts/verify-agent-capacity.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

// Scratch home for the durable registry each router carries (T4), so this
// script's activations never touch a real fleet record.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan71-capacity-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let registryFile = 0;

const {
  computeCapacity,
  describeCapacity,
  readMachineFacts,
  readCapacity,
  humanReserveCores,
  humanReserveBytes,
  HERDR_OVERHEAD_CORES,
  MEASURED_AGENT_COST,
  optionsFromEnv,
  capacityRefusal,
  summarizeCapacity,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { dampCost, sampleFromMeasurement, ALPHA_UP, ALPHA_DOWN, MIN_MEASURED_CORES } =
  await import(path.join(distDir, 'agent-cost-damping.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

let failures = 0;
const flag = (ok, complaint) => {
  if (!ok) failures += 1;
  return ok;
};

// ------------------------------------------------------- 1. derivation --
rule('1. DERIVATION — the cap on this machine, and the arithmetic behind it');

const here = readCapacity(0, 0);
console.log(describeCapacity(here));
console.log(
  `\n  → cap on this machine: ${here.cap} concurrent charged agents ` +
  `(bound by ${here.capBoundBy}). Only charged types are charged; nothing is\n` +
  '    reserved for gate-exempt types and none are counted.'
);
console.log(
  '  The incident that opened this lineage (KAN-34) was seven agents on 4 cores.'
);

// ------------------------------------------------------ 2. reservation --
rule('2. THE REMOVED RESERVATION — the same hardware, before and after');

// The fixed hardware the model was specified on — 4 cores, 15.4 GiB — so the
// numbers reproduce anywhere this script runs, not only on that laptop.
const FACTS = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(12 * GIB),
  load1: 0.2
};

// The old model, reconstructed from the constants as they stood before the
// reservation was removed: one supervisor slot — an agent's worth of core and
// memory — held off the top, unconditionally. That code never travelled, so
// it is recomputed here rather than re-run.
const RESERVED_SLOTS = 1;
const oldCpuBudget =
  FACTS.cores -
  humanReserveCores(FACTS.cores) -
  HERDR_OVERHEAD_CORES -
  RESERVED_SLOTS * MEASURED_AGENT_COST.cores;
const oldCapByCpu = Math.floor(Math.max(0, oldCpuBudget) / MEASURED_AGENT_COST.cores);
const oldCapByMemory = Math.floor(
  Math.max(
    0,
    FACTS.totalBytes -
      humanReserveBytes(FACTS.totalBytes) -
      RESERVED_SLOTS * MEASURED_AGENT_COST.residentBytes
  ) / MEASURED_AGENT_COST.residentBytes
);
const oldCap = Math.min(oldCapByCpu, oldCapByMemory);
const oldBoundBy = oldCapByCpu <= oldCapByMemory ? 'cpu' : 'memory';

const after = computeCapacity(FACTS, 0);

console.log(`on ${FACTS.cores} cores, ${(FACTS.totalBytes / GIB).toFixed(1)} GiB:\n`);
console.log(
  `  before (reservation, reconstructed)  cap ${oldCap}  ` +
  `(CPU allows ${oldCapByCpu}: (4 − 1 human − 0.5 herdr − 0.75 supervisor) ÷ 0.75; ` +
  `memory allows ${oldCapByMemory}; bound by ${oldBoundBy})`
);
console.log(
  `  after  (no reservation, live code)   cap ${after.cap}  ` +
  `(CPU allows ${after.capByCpu}, memory allows ${after.capByMemory}; ` +
  `bound by ${after.capBoundBy})`
);
console.log('\nthe live derivation line, with no supervisor term in it:\n');
console.log(describeCapacity(after));
console.log(
  `\n  → the cap rises by exactly the slot the reservation held: ${oldCap} → ${after.cap}. ` +
  'The reservation\n' +
  '    was right while there was one always-on supervisor; once supervising\n' +
  '    agents were staffed and stood down as work came and went, the slot was\n' +
  '    being held for something that may not exist.'
);

// ---------------------------------------------------- 3. exempt agents --
rule('3. EXEMPT AGENTS — reported, never charged: the arithmetic does not move');

const quiet = computeCapacity(FACTS, 2, { exemptRunning: 0 });
const staffed = computeCapacity(FACTS, 2, { exemptRunning: 3 });

for (const [label, c] of [['exemptRunning: 0', quiet], ['exemptRunning: 3', staffed]]) {
  console.log(
    `  ${label.padEnd(18)} cap ${c.cap}, headroom ${c.headroom}, ` +
    `headroomByCap ${c.headroomByCap}, exemptAgents ${c.exemptAgents}`
  );
}
const unmoved =
  quiet.cap === staffed.cap &&
  quiet.headroom === staffed.headroom &&
  quiet.headroomByCap === staffed.headroomByCap;
console.log(
  `\n  → cap, headroom and headroomByCap identical: ${flag(unmoved) ? 'yes' : 'NO — CHECK THIS'}. ` +
  'Only the reported\n' +
  '    count differs. Gate-exempt agents supervise, file work and wait; their\n' +
  '    real (usually small) usage is felt through the measured load and\n' +
  '    available memory, not charged in the model.'
);

// ------------------------------------------------------ 4. portability --
rule('4. PORTABILITY — the same code, against hardware this machine is not');

const idleLoad = (cores) => Math.min(0.2, cores * 0.05);
const machines = [
  { label: 'Raspberry Pi 4',        cores: 4,  gib: 4 },
  { label: 'small laptop (4c/15G)', cores: 4,  gib: 15 },
  { label: 'mid desktop',           cores: 8,  gib: 32 },
  { label: 'workstation',           cores: 16, gib: 64 },
  { label: 'big iron',              cores: 64, gib: 256 },
  { label: 'CPU-rich, RAM-poor',    cores: 32, gib: 8 }
];

console.log(
  'cap is charged agents; nothing is reserved for exempt types on any of them.\n'
);
console.log(
  'machine                 cores      RAM   cap   by CPU   by RAM   bound by'
);
for (const m of machines) {
  const totalBytes = m.gib * GIB;
  const c = computeCapacity(
    {
      cores: m.cores,
      totalBytes,
      // A machine at rest: most RAM available, load near zero.
      availableBytes: Math.floor(totalBytes * 0.9),
      load1: idleLoad(m.cores)
    },
    0
  );
  console.log(
    `${m.label.padEnd(22)} ${String(m.cores).padStart(5)} ${String(m.gib + 'G').padStart(8)}` +
    ` ${String(c.cap).padStart(5)} ${String(c.capByCpu).padStart(8)} ${String(c.capByMemory).padStart(8)}` +
    `   ${c.capBoundBy}`
  );
}
console.log(
  '\n  → the number moves with the hardware. The last row is the case a fixed\n' +
  '    constant gets wrong in the other direction: plenty of cores, not enough\n' +
  '    memory to feed them, and memory is what kills rather than slows.\n' +
  '    The first row still answers with a number the product can be used with,\n' +
  '    not zero.'
);

// --------------------------------------------- 5, 6, 7, 9 & 14: the real path --
// The workspace types as crabcast.config.json would declare them: two
// gate-exempt supervising types above a charged worker type. This is the
// generalization under proof — the exemption is the config flag, not a
// hardcoded set of names.
const registry = new WorkspaceRegistry([
  { name: 'epic',  priority: 3, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: true },
  { name: 'story', priority: 2, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: true },
  { name: 'task',  priority: 1, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: false }
]);

// A herdr that reports exactly the agents we tell it to, and a prompt loader
// that answers enough for the router to reach the gate.
function stubBridge(runningAgentNames) {
  const agents = runningAgentNames.map((name) => ({
    name,
    agentRuntime: 'claude',
    workDir: '/tmp',
    herdrStatus: 'working'
  }));
  return {
    listHerdrAgentsChecked: () => ({ reachable: true, agents }),
    listHerdrAgents: () => agents,
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    spawnSession: () => {
      throw new Error('spawnSession must not be reached when capacity refuses');
    }
  };
}

const stubPrompts = { loadAndRender: () => '# prompt' };
const stubConfig = { configPath: '/tmp/crabcast.config.json', dataDir: '/tmp' };

function makeRouter(runningAgentNames, onRespond, onBroadcast) {
  return new MessageRouter({
    registry,
    config: stubConfig,
    promptLoader: stubPrompts,
    herdrBridge: stubBridge(runningAgentNames),
    daemonStartedAt: new Date(),
    agentRegistry: new AgentRegistry(path.join(scratch, `agents-${++registryFile}.jsonl`)),
    send: onRespond,
    broadcast: onBroadcast ?? onRespond
  });
}

async function activate(runningAgentNames, args) {
  const events = [];
  let response;
  let reachedSpawn = false;
  const router = makeRouter(
    runningAgentNames,
    (msg) => { response = msg; },
    (msg) => { events.push(msg); }
  );
  try {
    await router.handleActivateByKey(args, (msg) => { response = msg; });
  } catch (e) {
    // The stub throws from spawnSession, which is how we know the gate let the
    // call through rather than answering it.
    if (!String(e.message).includes('spawnSession')) throw e;
    reachedSpawn = true;
  }
  return { response, events, reachedSpawn };
}

// ----------------------------------------------------------- 5. census --
rule('5. THE CENSUS — one epic, one story, one task through the capacity action');

// A supervising fleet: two gate-exempt agents and one charged worker. The
// names are what agentNameFor would build, so the router recovers each type
// from the name alone — the same path a real sessionless census takes.
const MIXED_FLEET = ['crabcast-epic-kan-40', 'crabcast-story-kan-41', 'crabcast-task-kan-50'];
console.log(`running: ${MIXED_FLEET.join(', ')}\n`);

let censusResponse;
makeRouter(MIXED_FLEET, (msg) => { censusResponse = msg; }).handle({ action: 'capacity' });
console.log('what the capacity action answers:\n');
console.log(JSON.stringify(censusResponse, null, 2));
console.log(
  `\n  → running: ${censusResponse.running} (the task agent), ` +
  `exemptAgents: ${censusResponse.exemptAgents} (the epic and story agents,\n` +
  '    visible in the report, absent from every figure the arithmetic uses).' +
  (flag(censusResponse.running === 1 && censusResponse.exemptAgents === 2)
    ? ''
    : '\n    EXPECTED running 1 and exemptAgents 2 — CHECK THIS.')
);

// ---------------------------------------------------------- 6. refusal --
// Fill the machine to exactly the derived cap, so the refusal is produced by
// the derivation rather than by a number this script chose — and add an epic
// and a story agent, which are running on any real fleet and must not consume
// a slot.
const running = [
  'crabcast-epic-kan-40',
  'crabcast-story-kan-41',
  ...Array.from({ length: here.cap }, (_, i) => `crabcast-task-kan-${i + 1}`)
];

rule(
  `6. REFUSAL — two exempt agents plus ${here.cap} charged agent(s) against a cap of ${here.cap}, ` +
  'asking for one more'
);
console.log(`running: ${running.join(', ')}\n`);

const refused = await activate(running, { type: 'task', key: 'KAN-99' });
console.log('what the caller receives:\n');
console.log(JSON.stringify(refused.response, null, 2));
console.log(
  `\n  → success: ${refused.response.success}, refusedBy: ${refused.response.refusedBy}. ` +
  'The reason and the numbers are\n' +
  '    fields on the response, not buried in a log the caller cannot see and not\n' +
  '    only inside a paragraph a client would have to parse.\n' +
  `    running counts ${refused.response.capacity.running} charged agent(s) and reports the ` +
  `epic and story agents\n    separately as exemptAgents: ${refused.response.capacity.exemptAgents}.`
);
flag(refused.response.success === false && refused.response.refusedBy === 'capacity');

// -------------------------------------------------------- 7. re-attach --
rule('7. RE-ATTACH — the same call, for an agent that is already running');

// Same over-full fleet, but asking for an agent that is already on it. The
// daemon holds no session for it (that map dies with the daemon while the
// herdr pane does not), so this is the path every client takes after a
// daemon restart. Refusing it would strand the caller away from work already
// in flight, and would do so exactly when the machine is busiest.
const reattach = await activate(running, { type: 'task', key: 'KAN-1' });
// The gate letting it through means the stub's spawnSession throws, so there
// is no response at all — reaching the attach path IS the result here.
console.log(
  'asking to activate task/KAN-1, which is already running as crabcast-task-kan-1:\n\n' +
  `  refused: ${reattach.response?.success === false}` +
  (reattach.response?.reason ? ` (${reattach.response.reason})` : '') + '\n' +
  `  reached the spawn/attach path: ${reattach.reachedSpawn}\n`
);
console.log(
  flag(reattach.reachedSpawn && reattach.response?.success !== false)
    ? '  → allowed through. Attaching to an agent that already exists starts nothing\n' +
      '    and costs the machine nothing, so the gate has nothing to ration. This\n' +
      '    is the path every client takes after a daemon restart; gating it\n' +
      '    would strand the caller away from work already in flight.'
    : '  → REFUSED — CHECK THIS. A re-attach must never be gated on capacity.'
);

// ------------------------------------------------------------- 8. load --
rule('8. LOAD SENSITIVITY — same machine, same agent count, different load');

const facts = readMachineFacts();
for (const [label, load1] of [['idle fleet', 0.15], ['busy fleet (compiling)', facts.cores * 2]]) {
  const c = computeCapacity({ ...facts, load1 }, 1);
  console.log(
    `${label.padEnd(24)} load ${String(load1.toFixed(2)).padStart(5)}  →  headroom ${c.headroom} ` +
    `(count says ${c.headroomByCap}, load says ${c.headroomByLoad}, memory says ${c.headroomByMemory}; ` +
    `bound by ${c.headroomBoundBy})`
  );
}
console.log(
  '\n  → one agent is running in both rows. A count-only cap cannot tell these\n' +
  '    apart; the load average is what the human actually felt.'
);

// --------------------------------------------------------- 9. override --
rule('9. OVERRIDE — the same call, deliberately');

const overridden = await activate(running, { type: 'task', key: 'KAN-99', override: true });
console.log('the gate now allows it, and records that it did:\n');
console.log(JSON.stringify(overridden.events, null, 2));
console.log(
  '\n  → broadcast as capacity_override_event, logged to the daemon log with the\n' +
  '    full derivation, and echoed to the caller as capacityOverride on the\n' +
  '    activate response. The spawn itself then proceeds — this stub throws on\n' +
  `    spawnSession, which is how we know the gate was passed: ${
    flag(overridden.reachedSpawn) ? 'it was' : 'IT WAS NOT — CHECK THIS'
  }.`
);
flag(overridden.events.some((e) => e.action === 'capacity_override_event'));

// ----------------------------------------------------- 10. provenance --
rule('10. PROVENANCE — the same hardware, seed vs measured divisor');

const MIB = 1024 ** 2;

// A measurement shaped exactly like the daemon's sampler publishes: per-tree
// averages, already damped, with the metadata a reader needs to judge it.
const MEASURED = {
  residentBytes: 680 * MIB,
  cores: 0.3,
  sampledAt: Date.parse('2026-08-02T19:00:00Z'),
  windowSeconds: 60,
  agentTrees: 4
};

const seeded = computeCapacity(FACTS, 0);
const measuredCap = computeCapacity(FACTS, 0, { measured: MEASURED });

console.log('with nothing measured — the seed, and the report says so:\n');
console.log(describeCapacity(seeded));
console.log("\nwith the daemon's damped measurement in place of the seed:\n");
console.log(describeCapacity(measuredCap));
console.log(
  `\n  → cap ${seeded.cap} → ${measuredCap.cap} on the same hardware, because the measured tree ` +
  `(${MEASURED.cores} core)\n    is cheaper than the seed's calibrated 0.75. Every figure above carries its\n` +
  '    provenance — (seed) or (measured) — plus the window, tree count and\n' +
  '    timestamp, so the moving divisor stays checkable by hand.'
);
flag(measuredCap.cap > seeded.cap);

// -------------------------------------------------------- 11. damping --
rule('11. DAMPING — quick to believe expensive, slow to believe cheap');

const meta = { sampledAt: MEASURED.sampledAt, windowSeconds: 60, agentTrees: 4 };
const capFor = (est) => computeCapacity(FACTS, 0, { measured: { ...est, ...meta } }).cap;
const row = (i, est) =>
  console.log(
    `  window ${String(i).padStart(2)}: cost ${est.cores.toFixed(3)} core, ` +
    `${Math.round(est.residentBytes / MIB)} MB → cap ${capFor(est)}`
  );

const CHEAP = { residentBytes: 600 * MIB, cores: 0.15 };
const EXPENSIVE = { residentBytes: 900 * MIB, cores: 1.5 };

console.log(
  `cheap→expensive: the fleet wakes up (alpha up ${ALPHA_UP} — the protective direction):\n`
);
let est = { ...CHEAP };
row(0, est);
let upWindows = 0;
for (let i = 1; i <= 6; i++) {
  est = dampCost(est, EXPENSIVE);
  row(i, est);
  if (upWindows === 0 && est.cores >= EXPENSIVE.cores * 0.9) upWindows = i;
}
const capAfterUp = capFor(est);

console.log(
  `\nexpensive→cheap: the fleet goes idle (alpha down ${ALPHA_DOWN} — the sceptical direction):\n`
);
est = { ...EXPENSIVE };
row(0, est);
let downWindows = 0;
for (let i = 1; i <= 24; i++) {
  est = dampCost(est, CHEAP);
  if (i <= 4 || i % 4 === 0) row(i, est);
  if (downWindows === 0 && est.cores <= CHEAP.cores + (EXPENSIVE.cores - CHEAP.cores) * 0.1) {
    downWindows = i;
  }
}
console.log(
  `\n  → the cap falls within ${upWindows} window(s) of the fleet getting expensive and needs ` +
  `${downWindows || '>24'}\n    windows to believe it got cheap — at the daemon's 60s window, minutes down,\n` +
  '    the better part of half an hour back up. A single good-looking reading is\n' +
  '    not evidence of damping; this staircase is. Under-estimating cost makes\n' +
  '    the desktop unusable; over-estimating refuses an activation — the errors\n' +
  '    are not symmetric, so neither are the alphas.' +
  (flag(capAfterUp <= capFor(EXPENSIVE) + 1) ? '' : '\n    EXPECTED the cap near its expensive-fleet value — CHECK THIS.')
);
// The stated step response: ~87% believed after three windows up (the 90%
// mark this loop watches lands on window 4), ~22 windows to 90% believed
// down. Fast up, slow down — the asymmetry is the point.
flag(upWindows > 0 && upWindows <= 4 && (downWindows === 0 || downWindows >= 15));

// -------------------------------------------------------- 12. degrade --
rule('12. DEGRADE — the instrument breaks; capacity still answers, from the seed');

const window60 = { elapsed: 60, loadStart: 0.2, loadEnd: 0.2, agents: [] };
const badWindows = [
  ['zero agent trees ', { ...window60, totals: { agents: 0, cores: 0, residentMb: 0 } }],
  ['negative cores   ', { ...window60, totals: { agents: 3, cores: -0.2, residentMb: 1800 } }],
  ['zero cores       ', { ...window60, totals: { agents: 3, cores: 0, residentMb: 1800 } }],
  ['absurd rss       ', {
    ...window60,
    totals: { agents: 3, cores: 0.4, residentMb: (FACTS.totalBytes / MIB) * 9 }
  }],
  ['zero-length window', { ...window60, elapsed: 0, totals: { agents: 3, cores: 0.4, residentMb: 1800 } }]
];
console.log('what sampleFromMeasurement makes of windows that prove nothing:\n');
let allRejected = true;
for (const [label, m] of badWindows) {
  const s = sampleFromMeasurement(m, FACTS.totalBytes);
  allRejected &&= s === null;
  console.log(`  ${label} → ${s === null ? 'null (rejected)' : JSON.stringify(s) + ' — CHECK THIS'}`);
}
console.log(
  `\n  → every bad window rejects to null${flag(allRejected) ? '' : ' — EXCEPT SOME, CHECK THIS'}. ` +
  'The daemon clears the live measurement on\n' +
  '    null (and on a /proc read throwing), so what capacity answers is:\n'
);
console.log(describeCapacity(computeCapacity(FACTS, 1, { measured: null })));
console.log(
  '\n  → the figures are the seed constants and the report *says* seed — whatever\n' +
  '    breaks, capacity still answers, conservatively, and a figure nobody\n' +
  '    measured is labelled as such.'
);

// ----------------------------------------------------- 13. precedence --
rule('13. PRECEDENCE — the operator beats the measurement beats the seed');

console.log(
  'CRABCAST_AGENT_CORES=0.75 set by hand, memory left alone, measurement live:\n'
);
console.log(
  describeCapacity(computeCapacity(FACTS, 0, { measured: MEASURED, overrides: { cores: 0.75 } }))
);
console.log(
  '\n  → cores says (override) and the measured 0.3 is named as ignored; memory\n' +
  '    stays (measured). Overrides are per-dimension: overriding cores does not\n' +
  '    silently discard the memory measurement.\n'
);

console.log('CRABCAST_MAX_AGENTS=2 on top of everything:\n');
console.log(
  describeCapacity(
    computeCapacity(FACTS, 0, { measured: MEASURED, overrides: { cores: 0.75 }, configuredCap: 2 })
  )
);
console.log('\n  → the configured cap pins the answer and skips the derivation entirely.\n');

// The env plumbing itself, with the variables controlled for the demo and
// restored after it.
const savedEnv = {};
for (const name of ['CRABCAST_AGENT_CORES', 'CRABCAST_AGENT_MEMORY_MB', 'CRABCAST_MAX_AGENTS']) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
process.env.CRABCAST_AGENT_CORES = '0.15';
console.log('optionsFromEnv() with only CRABCAST_AGENT_CORES=0.15 in the environment:\n');
console.log(`  ${JSON.stringify(optionsFromEnv())}`);
console.log(
  '\n  → only the dimension actually set becomes an override; an unset variable\n' +
  '    leaves room for the measurement rather than pinning the seed.\n'
);

// A zero agent COST is a typo, not a decision: a cap of zero means "run no
// charged agents", but a cost of zero means dividing the budget by nothing.
// Both cost variables reject non-positive values (with a warning) and fall
// back as if unset.
process.env.CRABCAST_AGENT_CORES = '0';
const zeroCost = optionsFromEnv();
console.log('optionsFromEnv() with CRABCAST_AGENT_CORES=0:\n');
console.log(`  ${JSON.stringify(zeroCost)}`);
console.log(
  `  → cores override ${zeroCost.overrides.cores === undefined ? 'ignored (undefined)' : 'ACCEPTED — CHECK THIS'}: ` +
  'a zero divisor is refused where a zero cap is honoured.'
);
flag(zeroCost.overrides.cores === undefined && zeroCost.configuredCap === null);
delete process.env.CRABCAST_AGENT_CORES;

// CRABCAST_MAX_AGENTS accepts zero — "run no charged agents" is an operator
// decision (and the synthetic-capacity lever the acceptance proofs use),
// where a zero agent *cost* could only be a typo.
process.env.CRABCAST_MAX_AGENTS = '0';
const pinnedZero = optionsFromEnv();
console.log('optionsFromEnv() with CRABCAST_MAX_AGENTS=0:\n');
console.log(`  ${JSON.stringify(pinnedZero)}`);
const zeroCap = readCapacity(0, 0);
console.log(`  → cap ${zeroCap.cap} (${zeroCap.capBoundBy}), atCapacity ${zeroCap.atCapacity}`);
flag(pinnedZero.configuredCap === 0 && zeroCap.cap === 0 && zeroCap.atCapacity === true);
for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ------------------------------------------------ 14. gateExempt gate --
rule('14. GATEEXEMPT GATE — exempt types activate at zero headroom, no override');

// The model has never charged gate-exempt types (sections 3 and 5), but a
// gate that still refused them whenever headroom hit 0 would be arguing with
// its own arithmetic — and desktop baseline load alone can pin headroomByLoad
// at 0 indefinitely, so always-on supervising agents could never start or
// auto-restore without a human pressing "Start anyway".
//
// Zero headroom is forced the same way an operator could force it: a per-agent
// core cost so large that the load term answers 0 on any machine this script
// runs on. That drives the refusal through the real readCapacity/env path
// rather than through figures this script invented.
const savedCores = process.env.CRABCAST_AGENT_CORES;
process.env.CRABCAST_AGENT_CORES = '1000';

const gateCheck = readCapacity(0, 0);
console.log(
  `with CRABCAST_AGENT_CORES=1000: headroomByLoad ${gateCheck.headroomByLoad}, ` +
  `headroom ${gateCheck.headroom}, atCapacity ${gateCheck.atCapacity} ` +
  `(bound by ${gateCheck.headroomBoundBy})\n`
);

// Nothing is running at all — an empty machine whose load average alone says
// no.
const epicAtZero = await activate([], { type: 'epic', key: 'KAN-40' });
const storyAtZero = await activate([], { type: 'story', key: 'KAN-41' });
const taskAtZero = await activate([], { type: 'task', key: 'KAN-99' });

const overrideEvents = [...epicAtZero.events, ...storyAtZero.events]
  .filter((e) => e.action === 'capacity_override_event');

console.log(
  `  epic/KAN-40  (gateExempt, no override) → refused: ${epicAtZero.response?.success === false}, ` +
  `reached spawn: ${epicAtZero.reachedSpawn}\n` +
  `  story/KAN-41 (gateExempt, no override) → refused: ${storyAtZero.response?.success === false}, ` +
  `reached spawn: ${storyAtZero.reachedSpawn}\n` +
  `  task/KAN-99  (charged,    no override) → refused: ${taskAtZero.response?.success === false}` +
  (taskAtZero.response?.reason ? ` (${taskAtZero.response.reason})` : '') + '\n' +
  `  capacity_override_event broadcast for the exempt types: ${overrideEvents.length}\n`
);

const exemptPassed =
  epicAtZero.reachedSpawn && storyAtZero.reachedSpawn && overrideEvents.length === 0;
const taskStillRefused =
  taskAtZero.response?.success === false &&
  taskAtZero.response?.refusedBy === 'capacity' &&
  String(taskAtZero.response?.reason ?? '').includes('load average');

console.log(
  flag(exemptPassed)
    ? '  → both gateExempt types pass the gate with no override asked for and none\n' +
      '    recorded. Their cost was reserved by the model from the start —\n' +
      '    never counted in running, never charged a slot — so a refusal here\n' +
      '    would be the gate arguing with its own arithmetic. The flag comes\n' +
      '    from the type config alone: no type name is special-cased anywhere.'
    : '  → A GATEEXEMPT TYPE WAS REFUSED OR AN OVERRIDE WAS RECORDED — CHECK THIS.'
);
console.log(
  flag(taskStillRefused)
    ? '  → the charged type is still refused, load-bound, with the same legible\n' +
      '    reason as before: the exemption is exactly as wide as the gateExempt\n' +
      '    flag and no wider.'
    : '  → THE CHARGED TYPE WAS NOT REFUSED LOAD-BOUND — CHECK THIS.'
);

if (savedCores === undefined) delete process.env.CRABCAST_AGENT_CORES;
else process.env.CRABCAST_AGENT_CORES = savedCores;

// ---------------------------------------------- 15. refusal headline --
rule('15. REFUSAL HEADLINE — the headline names the constraint that bound');

// The KAN-60 lesson, ported deliberately: a load-bound refusal was once
// headlined "at capacity" with the cap count leading — false by its own
// numbers (2 running against a cap of 10), and pointing at the wrong
// constraint entirely. The refusal string and the one-line summary render
// from headroomBoundBy, so "at capacity" is said only when the count bound.

// Load-bound, count headroom positive: the same env trick as section 14 —
// a per-agent core cost so large the load term answers 0 on any machine this
// script runs on, while the count term still has room (nothing is running).
{
  const saved = process.env.CRABCAST_AGENT_CORES;
  process.env.CRABCAST_AGENT_CORES = '1000';

  const loadBound = await activate([], { type: 'task', key: 'KAN-99' });
  const error = String(loadBound.response?.error ?? '');
  const headline = error.split('\n')[0];
  const summary = String(loadBound.response?.capacity?.summary ?? '');

  console.log('load-bound (headroomByLoad 0, headroomByCap positive), the refusal headline:\n');
  console.log(`  ${headline}\n`);
  console.log(`and the one-line summary:\n\n  ${summary}\n`);

  const headlineOk =
    /load too high/.test(headline) &&
    /load average is \d/.test(headline) &&
    !/at capacity/i.test(headline) &&
    !/\d+ of \d+|\d+\/\d+/.test(headline);
  console.log(
    flag(headlineOk && summary.startsWith('load too high'))
      ? '  → the headline names load, quotes the live load figure and the cores, and\n' +
        '    says neither "at capacity" nor "N of cap". The summary leads the same way.'
      : '  → THE HEADLINE DID NOT NAME LOAD, OR STILL SAYS AT CAPACITY / N-OF-CAP — CHECK THIS.'
  );

  if (saved === undefined) delete process.env.CRABCAST_AGENT_CORES;
  else process.env.CRABCAST_AGENT_CORES = saved;
}

// Count-bound: the cap genuinely reached, on an otherwise idle machine.
// Synthetic facts through the pure function, so a busy host running this
// script cannot flip the binding constraint to load.
{
  const idle = {
    cores: 8,
    totalBytes: 16 * GIB,
    availableBytes: 12 * GIB,
    load1: 0.5
  };
  const c = computeCapacity(idle, computeCapacity(idle, 0).cap);
  const headline = capacityRefusal(c, 'task/KAN-99').split('\n')[0];
  const summary = summarizeCapacity(c);

  console.log(`\ncount-bound (${c.running} running against a cap of ${c.cap}, load ${idle.load1}), the refusal headline:\n`);
  console.log(`  ${headline}\n`);
  console.log(`and the one-line summary:\n\n  ${summary}\n`);

  const headlineOk =
    c.headroomBoundBy === 'cap' &&
    /at capacity/.test(headline) &&
    headline.includes(`${c.running} charged agents are already running against a cap of ${c.cap}`);
  console.log(
    flag(headlineOk && summary.startsWith(`at capacity: ${c.running}/${c.cap}`))
      ? '  → at capacity is said here, with N of cap — because here the count is\n' +
        '    the constraint that bound, and the headline is rendered from it.'
      : '  → THE COUNT-BOUND HEADLINE DID NOT SAY AT CAPACITY WITH N OF CAP — CHECK THIS.'
  );
}

// ------------------------------------------------- 16. cores floor --
rule('16. CORES FLOOR — an idle fleet cannot measure the CPU dimension away');

// The daemon publishes the damped estimate rounded to 3 decimals; a genuinely
// idle fleet measures below 0.0005 per tree, which would round to a zero
// divisor — capByCpu and headroomByLoad become Infinity and the CPU
// constraint this model exists to enforce goes silently inert while the
// report prints "÷ 0 core/agent". sampleFromMeasurement floors the figure at
// MIN_MEASURED_CORES (and the publish site floors again after rounding), so
// the divisor is always a number.
const idleWindow = {
  elapsed: 60,
  loadStart: 0.1,
  loadEnd: 0.1,
  agents: [],
  // 4 trees, 0.0004 cores TOTAL — 0.0001/tree, far below rounding resolution.
  totals: { agents: 4, cores: 0.0004, residentMb: 2400 }
};
const idleSample = sampleFromMeasurement(idleWindow, FACTS.totalBytes);
console.log(`an idle fleet's window (0.0001 core/tree) samples as: ${JSON.stringify(idleSample)}\n`);

const flooredCap = computeCapacity(FACTS, 0, {
  measured: { ...idleSample, sampledAt: Date.parse('2026-08-03T17:00:00Z'), windowSeconds: 60, agentTrees: 4 }
});
console.log(describeCapacity(flooredCap));
console.log(
  `\n  → cores floored to ${MIN_MEASURED_CORES} (${idleSample.cores === MIN_MEASURED_CORES ? 'exactly' : 'NOT — CHECK THIS'}), ` +
  `so capByCpu is ${flooredCap.capByCpu} — finite, and huge honestly:\n` +
  '    agents this cheap really do fit in droves, and the load term still\n' +
  '    binds the moment they wake. What can never happen is a zero divisor\n' +
  '    reading as infinite room with the arithmetic unprintable.'
);
flag(
  idleSample !== null &&
  idleSample.cores === MIN_MEASURED_CORES &&
  Number.isFinite(flooredCap.capByCpu) &&
  Number.isFinite(flooredCap.headroomByLoad) &&
  Number.isFinite(flooredCap.cap)
);

if (failures > 0) {
  console.log(`\n== ${failures} CHECK(S) FAILED ==`);
  process.exit(1);
}
console.log('\n== done ==');
