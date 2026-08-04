#!/usr/bin/env node
// Live proof for priority and preemption (KAN-71): a higher-priority agent
// can take a lower-priority one's slot when the machine is full — visibly,
// reversibly, and never automatically.
//
// In the extraction source this proof also drove the durable registry (a
// preempted agent's record, its resumption, and why a reboot does not bring
// it back). That registry is the T4 slice of KAN-68 and has not landed;
// until it does, the preemption record's only carrier is the ONE
// `agent.deactivated` event the stand-down broadcasts and the deactivate
// payload — so that is what section 5 pins down, field by field, as the seam
// T4 plugs into (`recordDeactivated(record, preemption)`).
//
// KAN-128 MERGED THE TWO EVENTS THIS USED TO READ. A preemption used to
// broadcast `agent_preempted_event` AND `agent_deactivated_event` for the same
// agent, naming the victim `victim.path` on one and `path` on the other, and
// leaving a subscriber to correlate them. The event contract publishes one
// `agent.deactivated` carrying `reason: 'preempted'` and a `preemption` block
// holding everything the second event carried. Every assertion below reads
// that one event; nothing it used to check has been dropped.
//
// Eight sections:
//
//   1. the scale        — where priority comes from: the config, not code
//   2. ordering         — which agent is chosen as victim, and why that one
//   3. refusal          — equal or lower priority is refused, told why, and
//                         preempt: true at equal priority changes nothing
//   4. consent          — what is shown BEFORE anything is killed
//   5. preemption       — capacity before and after, and the record of what went
//   6. gateExempt safety — the top of the scale cannot be touched, and an
//                         exempt activation never preempts
//   7. exempt victims   — a low-priority gateExempt agent is never offered and
//                         never killed: standing it down would free no charged
//                         slot, so admitting over it would be a false premise
//   8. victim address   — with two types sharing a key, the preempt stand-down
//                         resolves the victim by full address: the named agent
//                         dies, its same-key neighbour survives
//
// Sections 3 through 6 drive the real MessageRouter and the real
// durable registry — handleActivate and handleDeactivateAgent, the same
// calls an MCP caller makes — so what they print is what a caller actually
// receives. herdr is stubbed: this proves the gate, the ordering and the
// record, and none of those reach herdr for anything but a census and a pane
// close.
//
// Run `npm run build` first. Usage: node scripts/verify-agent-preemption.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

// Scratch home for the durable registry each router carries (T4): the
// preempt path persists its PreemptionRecord through it, and a scratch file
// keeps that write out of any real fleet record.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan71-preempt-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let registryFile = 0;

const { compareVictims, outranks, selectVictim } = await import(path.join(distDir, 'priority.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { paneNameFor, canonicalizeOrNull } = await import(path.join(distDir, 'identity.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { readCapacity, summarizeCapacity } = await import(path.join(distDir, 'capacity.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

let failures = 0;
const verdict = (ok, yes, no) => {
  if (!ok) failures += 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// The workspace types as crabcast.config.json would declare them. `epic` and
// `story` are gate-exempt supervising types; `task` is the ordinary charged
// worker; `hotfix` is a charged priority-2 worker — the shape of any type
// that outranks `task` without being gate-exempt, and the type this proof
// drives preemption with (an exempt activation is never refused, so it never
// has anything to preempt for — section 6 proves that half directly).
// `watchdog` is a LOW-priority agent that is CHARGED but never preemptable —
// legitimate, because the three gate decisions are independent knobs now — and
// the shape section 7 exists for: an agent that outranks nothing and must
// still never be offered as a victim.
//
// The old single `gateExempt` boolean could not say this. It meant all three
// at once, so "protected from preemption" came bundled with "never counted",
// and the only way to have an uncharged agent was to make it unrefusable too.
const EXEMPT = { refusable: false, chargeable: false, preemptable: false };
const CHARGED = { refusable: true, chargeable: true, preemptable: true };
/** Charged and refusable, but nothing may take its slot. */
const PROTECTED = { refusable: true, chargeable: true, preemptable: false };

const KNOBS = {
  epic: { priority: 3, gate: EXEMPT },
  story: { priority: 2, gate: EXEMPT },
  hotfix: { priority: 2, gate: CHARGED },
  task: { priority: 1, gate: CHARGED },
  watchdog: { priority: 1, gate: PROTECTED }
};

// A charged agent plus however many more this machine's own derivation says
// it can carry. Filling to the derived cap rather than to a number this
// script picked means the refusals below are produced by the real arithmetic.
const HERE = readCapacity(0, 1);

// ------------------------------------------------------------- the harness --

const owned = path.join(scratch, 'owned');
const dirs = new Map();
/** A directory a caller owns, one per agent. The address, and the whole of it. */
function agentDir(name) {
  if (!dirs.has(name)) {
    const dir = path.join(owned, name);
    fs.mkdirSync(dir, { recursive: true });
    dirs.set(name, fs.realpathSync(dir));
  }
  return dirs.get(name);
}
/** `epic-kan-39` -> the knobs its leading token names. */
const knobsFor = (name) => {
  const kind = name.split('-')[0];
  const { priority, gate } = KNOBS[kind] ?? KNOBS.task;
  return { priority, launcher: 'shell', ...gate };
};

/**
 * A herdr that reports exactly the agents it is told to, and forgets one when
 * its pane is closed — so the capacity report *after* a preemption is the
 * machine as it then is, not a reconstruction.
 */
function stubHerdr(running, { statuses = {} } = {}) {
  const alive = [...running];
  const spawns = [];

  const bridge = {
    alive,
    spawns,
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name: paneNameFor(agentDir(name)),
        paneId: `p-${name}`,
        agentRuntime: 'claude',
        workDir: agentDir(name),
        canonicalWorkDir: canonicalizeOrNull(agentDir(name)),
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    // The post-spawn existence check (KAN-23), answered from the same list the
    // census is built from — which is the rule the real one follows.
    confirmAgentPresent: async (paneName) => {
      const found = alive.find((n) => paneNameFor(agentDir(n)) === paneName);
      return found
        ? { present: true, paneId: `p-${found}`, waitedMs: 0, checks: 1 }
        : { present: false, reason: 'absent', waitedMs: 0, checks: 1,
            error: `stub herdr has no agent '${paneName}'` };
    },
    abandonSession: () => {},
    listHerdrStatuses: () => new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
    listActiveSessions: () => [],
    getSessionByPath: () => undefined,
    terminateSession: () => ({ success: true }),
    occupancyOf: (census, agentPath) => ({
      reachable: true,
      // The honest reading of this stub's own census: whatever it says is live
      // in that directory, and ours when the pane bearing this path's derived
      // name is among them. Same shape as the real one, which is what makes
      // the "already running" branch reachable below.
      //
      // Like verify-agent-capacity's, this stub is not coverage of the
      // occupancy guard — verify-refuses-occupied-directory.mjs is.
      occupants: census.agents.filter((a) => a.canonicalWorkDir === agentPath),
      ours: census.agents.find((a) => a.name === paneNameFor(agentPath)) ?? null
    }),
    closeAgentByPath: (agentPath) => {
      const i = alive.findIndex((n) => agentDir(n) === agentPath);
      const paneName = paneNameFor(agentPath);
      if (i === -1) return { success: false, paneName, error: `No agent at '${agentPath}'` };
      alive.splice(i, 1);
      return { success: true, paneName };
    },
    spawnSession: (agentPath, agentConfig) => {
      const name = [...dirs].find(([, dir]) => dir === agentPath)?.[0] ?? path.basename(agentPath);
      spawns.push({ path: agentPath, config: agentConfig });
      alive.push(name);
      return {
        sessionId: `${paneNameFor(agentPath)}-stub`,
        path: agentPath,
        paneName: paneNameFor(agentPath),
        createdAt: new Date(),
        status: 'active',
        ptyBuffer: '',
        onDataListeners: [],
        expectsRuntime: false
      };
    }
  };
  return bridge;
}

const stubConfig = { configPath: path.join(scratch, 'crabcast.config.json'), baseDir: scratch, dataDir: scratch };

function newRouter(bridge, extraConfigured = []) {
  const events = [];
  const agentRegistry = new AgentRegistry(path.join(scratch, `agents-${++registryFile}.jsonl`));
  // Every running agent needs a record: priority and the gate flags live there
  // now, so the census alone can no longer say what an agent is worth.
  for (const name of bridge.alive) {
    agentRegistry.recordActivated({ path: agentDir(name), config: knobsFor(name) });
  }
  for (const name of extraConfigured) {
    agentRegistry.recordConfigured({ path: agentDir(name), config: knobsFor(name) });
  }
  const router = new MessageRouter({
    config: stubConfig,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry,
    send: () => {},
    broadcast: (msg) => events.push(msg)
  });
  return { router, events, agentRegistry };
}

/**
 * The running fleet as priority candidates, read off whatever the stub herdr
 * is currently reporting.
 */
function fleetNow(bridge) {
  return bridge.alive.map((name) => ({
    path: agentDir(name),
    paneName: paneNameFor(agentDir(name)),
    priority: knobsFor(name).priority,
    herdrStatus: bridge.listHerdrAgentsChecked().agents
      .find((a) => a.canonicalWorkDir === agentDir(name))?.herdrStatus ?? 'working',
    activatedAt: null
  }));
}

/**
 * Capacity as the router computes it, from that same census. Used for the
 * before/after pair in section 5, so those two lines are readings of the
 * fleet as it then is rather than numbers this script chose and then
 * asserted.
 */
function capacityOfFleet(bridge) {
  let fleet = 0;
  let exempt = 0;
  for (const name of bridge.alive) {
    if (knobsFor(name).chargeable) fleet++;
    else exempt++;
  }
  return readCapacity(fleet, exempt);
}

/**
 * Run something with the daemon's own console output suppressed.
 *
 * Section 5 deliberately does NOT use this: the `[capacity] preemption:` line
 * it prints is part of what is being proved — the decision reaches the daemon
 * log with its full derivation, not only the caller. Everywhere else the same
 * line is a repeat.
 */
async function quiet(fn) {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

/** configure-then-activate, addressed by the directory the agent is. */
const call = async (harness, name, extra = {}) => {
  let response;
  const dir = agentDir(name);
  if (!harness.agentRegistry.intents().has(dir)) {
    harness.agentRegistry.recordConfigured({ path: dir, config: knobsFor(name) });
  }
  await harness.router.handleActivate({ path: dir, ...extra }, (msg) => { response = msg; });
  return response;
};

// ----------------------------------------------------------- 1. the scale --
rule('1. THE SCALE — where priority comes from');

console.log(
  'Priority is a property of the AGENT, frozen onto its record by `configure`\n' +
  '(required — there is no default, because a silently-floored priority is\n' +
  'preemptable by everything and nobody finds out until the work is destroyed).\n' +
  'It used to come from the workspace type; types are deleted, so there is nothing\n' +
  'left to look it up in and the value lives with every other per-agent knob.\n' +
  '\nAND THERE IS NO FLOOR ANY MORE. `priorityFor` used to give an unresolvable\n' +
  'type the lowest declared priority, so a resolution failure landed where it\n' +
  'could not kill another agent\'s work. Nothing resolves now: an agent with no\n' +
  'record cannot be activated at all, so the failure that fallback contained has\n' +
  'no way to occur.\n'
);
// READ BACK THROUGH THE REAL REGISTRY, not out of this script's own object.
//
// An earlier revision printed `knobsFor(...)` and asserted on it — a script
// literal compared against itself, with no `dist/` code in the loop at all,
// under a verdict whose text said "read back". It passed and asserted nothing.
// The version before the re-key called `registry.priorityFor()` on production
// code; this restores that property by putting the knobs through the durable
// registry and reading what comes out.
const scaleReg = new AgentRegistry(path.join(scratch, `agents-scale.jsonl`));
for (const kind of ['epic', 'story', 'hotfix', 'task', 'watchdog']) {
  scaleReg.recordConfigured({ path: agentDir(`${kind}-scale`), config: knobsFor(`${kind}-scale`) });
}
const readBack = (kind) => scaleReg.intents().get(agentDir(`${kind}-scale`))?.record.config;

console.log('  agent      priority   refusable  chargeable  preemptable   (from the registry)');
for (const kind of ['epic', 'story', 'hotfix', 'task', 'watchdog']) {
  const k = readBack(kind);
  console.log(
    `  ${kind.padEnd(10)} ${String(k?.priority).padStart(4)}       ` +
    `${String(k?.refusable).padEnd(10)} ${String(k?.chargeable).padEnd(11)} ${k?.preemptable}`
  );
}

const scaleOk =
  readBack('epic')?.priority === 3 &&
  readBack('story')?.priority === 2 &&
  readBack('hotfix')?.priority === 2 &&
  readBack('task')?.priority === 1 &&
  readBack('watchdog')?.preemptable === false &&
  readBack('watchdog')?.chargeable === true;
// And the floor is gone rather than merely unused: an unconfigured path has no
// priority to fall back to, which is what `priorityFor`'s floor used to
// supply. The registry answers "nothing" instead of "the lowest declared".
const unconfigured = scaleReg.intents().get(agentDir('never-configured'));
console.log(`  ${'(unknown)'.padEnd(10)} ${unconfigured === undefined ? 'no record at all — there is no floor to fall to' : 'HAS A RECORD, which is wrong'}`);

verdict(
  scaleOk && unconfigured === undefined,
  'the scale is what each agent was configured with, read back OUT OF THE DURABLE\n' +
  '    REGISTRY: epic 3 > {story, hotfix} 2 > task 1 — and `watchdog` is CHARGED yet\n' +
  '    unpreemptable, which the single gateExempt boolean could not express. An\n' +
  '    unconfigured path has no record and therefore no priority: the floor is gone\n' +
  '    rather than unreached.',
  'the scale is not what the registry holds.'
);

console.log(
  '\n  Strictly-greater, not greater-or-equal:\n' +
  `    task(1) over task(1):     ${outranks(1, 1)}   ← the common case, and a refusal\n` +
  `    hotfix(2) over task(1):   ${outranks(2, 1)}\n` +
  `    epic(3) over epic(3):     ${String(outranks(3, 3)).padStart(5)}   ← nothing can outrank the top of the scale`
);

// ------------------------------------------------------------ 2. ordering --
rule('2. ORDERING — which agent is chosen, and why that one');

const candidate = (name, priority, herdrStatus, activatedAt) => ({
  path: agentDir(name), paneName: paneNameFor(agentDir(name)), priority, herdrStatus, activatedAt
});
const fleet = [
  candidate('epic-kan-39', 3, 'working', '2026-08-01T09:00:00Z'),
  candidate('story-kan-50', 2, 'idle', '2026-08-01T10:00:00Z'),
  candidate('task-kan-10', 1, 'working', '2026-08-01T11:00:00Z'),
  candidate('task-kan-11', 1, 'idle', '2026-08-01T12:00:00Z'),
  candidate('task-kan-12', 1, 'idle', '2026-08-01T08:00:00Z')
];

console.log('victim order (best victim first), over a fleet of five:\n');
for (const c of [...fleet].sort(compareVictims)) {
  console.log(`  ${String(c.priority)}  ${c.herdrStatus.padEnd(8)} ${c.activatedAt}  ${c.path}`);
}
console.log(
  '\n  Lowest priority first; among equals, whatever has least in flight. There is no\n' +
  '  last-active timestamp in this daemon — but herdr already reports what each agent\n' +
  '  is DOING, which is what "least recently active" was reaching for. done → idle →\n' +
  '  blocked → unknown → working. Remaining ties break on oldest, then name, purely so\n' +
  '  the same fleet always yields the same victim: a refusal that names one agent and\n' +
  '  a preemption that kills another would be the same request.\n'
);

for (const incoming of [1, 2, 3]) {
  const v = selectVictim(fleet, incoming);
  console.log(`  an activation at priority ${incoming} would take: ${v ? v.path : '(nothing — it outranks nothing)'}`);
}
const orderOk =
  selectVictim(fleet, 1) === null &&
  selectVictim(fleet, 2)?.path === agentDir('task-kan-12') &&
  selectVictim(fleet, 3)?.path === agentDir('task-kan-12');
verdict(
  orderOk,
  'priority 1 takes nothing; 2 and 3 both take the oldest idle task agent, not the working one.',
  'the ordering did not choose as documented.'
);

// ------------------------------------------------------------- 3. refusal --
rule('3. REFUSAL — a task agent at capacity, on a machine full of task agents');

// Filled to the machine's own derived cap, plus an epic supervisor, which is
// unchargeable and does not occupy one of those slots.
const FULL = [
  'epic-kan-39',
  ...Array.from({ length: HERE.cap }, (_, i) => `task-kan-${10 + i}`)
];

{
  const bridge = stubHerdr(FULL, { statuses: { 'task-kan-10': 'idle' } });
  const harness = newRouter(bridge);
  const res = await quiet(() => call(harness, 'task-kan-99'));

  console.log(`running: ${FULL.map(agentDir).join(', ')}\n`);
  console.log(res.error);
  console.log(`\n  capacity: ${summarizeCapacity({ ...HERE, running: HERE.cap })}`);
  console.log(`  refusedBy: ${res.refusedBy}   priority of the refused activation: ${res.priority}`);
  console.log(`  preemption offered: ${res.preemption ? 'yes' : 'no'}`);

  const namesFleet = /priority 1/.test(res.error) && /task-kan-1\d \(priority 1/i.test(res.error);
  const strictlyGreater = /strictly-greater/.test(res.error);
  verdict(
    res.success === false && !res.preemption && namesFleet && strictlyGreater,
    'refused, and the message names what is running and what each one is worth — so the\n' +
    '    person who lost the slot can see who they lost it to. Equal priority offers no\n' +
    '    preemption at all, and the refusal says why: strictly-greater, an agent may not\n' +
    '    displace one of its own priority.',
    'an equal-priority activation was not refused, or the refusal did not explain itself.'
  );

  // And preempt: true changes nothing at equal priority — consent to preempt
  // is not the same as anything being preemptable. Nothing may die.
  const forced = await quiet(() => call(harness, 'task-kan-99', { preempt: true }));
  console.log(`\n  the same call again with preempt: true → success: ${forced.success}, ` +
    `preempted: ${forced.preempted ? forced.preempted.victim.path : '(nothing)'}`);
  console.log(`  agents alive before and after: ${FULL.length}/${bridge.alive.length}`);
  verdict(
    forced.success === false && !forced.preempted && bridge.alive.length === FULL.length &&
      /strictly-greater/.test(forced.error),
    'preempt: true at equal priority is still a refusal with the strictly-greater\n' +
    '    explanation, and nothing was stood down. The flag authorises a kill the\n' +
    '    ordering has offered; it does not create one.',
    'an equal-priority activation with preempt: true killed something or succeeded.'
  );
}

// ------------------------------------------------------------- 4. consent --
rule('4. CONSENT — what is shown BEFORE anything is killed');

{
  const bridge = stubHerdr(FULL, { statuses: { 'task-kan-10': 'idle' } });
  const harness = newRouter(bridge);
  // A story activation would sail through the gate — an unrefusable agent is
  // never refused, so it is never offered a victim. The consent flow is
  // reached by a priority-2 *refusable* agent, which is what `hotfix` is.
  const res = await quiet(() => call(harness, 'hotfix-kan-50'));

  console.log('a priority-2 charged activation arrives while the machine is full.\n');
  console.log('what the caller receives:\n');
  console.log(JSON.stringify({ success: res.success, path: res.path, priority: res.priority, preemption: res.preemption }, null, 2));

  const nothingDied = bridge.alive.length === FULL.length;
  verdict(
    res.success === false && res.preemption && nothingDied &&
      res.preemption.path === agentDir('task-kan-10') &&
      res.preemption.herdrStatus === 'idle' &&
      res.preemption.incomingPriority === 2,
    `nothing was killed. The activation was REFUSED and the caller was handed the name\n` +
    `    of the agent that would be stopped, its priority, and what it is doing right now\n` +
    `    — the sentence a client turns into a button that says whose work it ends.\n` +
    `    ${FULL.length} agents were running before and ${bridge.alive.length} after.`,
    'something was stood down without consent, or no offer was made.'
  );
}

// ---------------------------------------------------------- 5. preemption --
rule('5. PREEMPTION — capacity before and after, and the record of what went');

{
  const bridge = stubHerdr(FULL, { statuses: { 'task-kan-10': 'idle' } });
  const harness = newRouter(bridge);
  const { events } = harness;

  const before = capacityOfFleet(bridge);
  console.log(`BEFORE  ${summarizeCapacity(before)}`);
  console.log(`        at capacity: ${before.atCapacity}`);
  console.log(`        running, in the order they would be taken:`);
  for (const c of [...fleetNow(bridge)].sort(compareVictims)) {
    console.log(`          ${c.priority}  ${c.herdrStatus.padEnd(8)} ${c.path}`);
  }

  const res = await call(harness, 'hotfix-kan-50', { preempt: true });

  console.log(`\nactivate the priority-2 hotfix agent with preempt: true\n`);
  console.log('what was preempted, and why (on the activate response):\n');
  console.log(JSON.stringify(res.preempted, null, 2).split('\n').slice(0, 12).join('\n'));

  const after = capacityOfFleet(bridge);
  console.log(`\nAFTER   ${summarizeCapacity(after)}`);
  console.log(`        alive: ${bridge.alive.join(', ')}`);

  const deactivatedEvent = events.find((e) => e.action === 'agent.deactivated');
  console.log(`\nbroadcast to every connected client — ONE event, not two:\n`);
  console.log(`  ${deactivatedEvent.action}: ${deactivatedEvent.path} ` +
    `(priority ${deactivatedEvent.preemption.priority}, ${deactivatedEvent.preemption.herdrStatus}) ` +
    `stood down for ${deactivatedEvent.preemption.by.path} ` +
    `(priority ${deactivatedEvent.preemption.by.priority}), reason=${deactivatedEvent.reason}`);
  console.log(`  and there is no second broadcast: ` +
    `${events.filter((e) => e.action === 'agent.deactivated').length} agent.deactivated, ` +
    `${events.filter((e) => e.reason === 'preempted').length} of them preempted`);

  // The full PreemptionRecord rides the event AND is what the durable registry
  // persists through recordDeactivated(record, preemption). Every field is
  // pinned here because it is also what a client renders.
  const record = deactivatedEvent.preemption;
  console.log(`\nthe preemption block on the event, and the PreemptionRecord in the durable log:\n`);
  console.log(JSON.stringify(record, null, 2).split('\n').map((l) => '  ' + l).slice(0, 12).join('\n'));
  const recordOk =
    record &&
    deactivatedEvent.reason === 'preempted' &&
    deactivatedEvent.path === agentDir('task-kan-10') &&
    record.by?.path === agentDir('hotfix-kan-50') &&
    record.by?.paneName === paneNameFor(agentDir('hotfix-kan-50')) &&
    record.by?.priority === 2 &&
    record.priority === 1 &&
    record.herdrStatus === 'idle' &&
    typeof record.at === 'string' &&
    /cap:/.test(record.derivation) &&
    // The capacity arithmetic the retired event carried separately.
    typeof record.capacity?.cap === 'number' &&
    // And ONE event describes this stand-down, not two.
    events.filter((e) => e.action === 'agent.deactivated').length === 1;

  // And it really reached the disk: the victim's last event is a stand-down
  // carrying the annotation, which is what keeps the debt reported.
  const owed = harness.agentRegistry.preempted();
  console.log(`\n  the durable log now owes: ${JSON.stringify(owed.map((o) => o.path))}`);

  const startedIt = res.success === true && res.verified === true;
  const tookTheIdleOne = res.preempted?.victim?.path === agentDir('task-kan-10');
  const gone = !bridge.alive.includes('task-kan-10');
  const started = bridge.alive.includes('hotfix-kan-50');
  verdict(
    startedIt && tookTheIdleOne && gone && started && recordOk &&
      owed.length === 1 && owed[0].path === agentDir('task-kan-10'),
    'the low-priority agent was stood down and the higher-priority one started. The\n' +
    '    victim chosen was the idle one, not either of the working ones, and the whole\n' +
    '    decision — who, for whom, both priorities, what the victim was doing, and the\n' +
    '    capacity arithmetic that forced it — is on the wire, in the activate response,\n' +
    '    and durably recorded as a debt the fleet list keeps reporting.',
    `preemption did not do what it claimed: started=${startedIt} victim=${res.preempted?.victim?.path} gone=${gone} new=${started} recordOk=${recordOk}`
  );
}

// ------------------------------------------------- 6. top-of-scale safety --
rule('6. TOP-OF-SCALE SAFETY — the highest priority cannot be touched');

{
  // A fleet where an epic supervisor is the ONLY thing running, and an
  // activation at the very top of the scale asking for room.
  const epicOnly = [{ ...fleet[0] }];
  const topOfScale = selectVictim(epicOnly, 3);
  console.log(`fleet: ${agentDir('epic-kan-39')} (priority 3)`);
  console.log(`an activation at the highest declared priority (3) would take: ${topOfScale ?? '(nothing)'}\n`);

  // And through the real router, on a full machine. An unrefusable activation
  // never consults the rationing half of the gate at all: the epic agent
  // starts alongside the full fleet, preempt: true notwithstanding, and
  // nothing is stood down for it — its cost was never charged, so there is
  // no slot to free.
  const bridge = stubHerdr(FULL, { statuses: { 'task-kan-10': 'idle' } });
  const harness = newRouter(bridge);
  const { events } = harness;
  const res = await quiet(() => call(harness, 'epic-kan-77', { preempt: true }));

  console.log(`on a full machine including the epic supervisor, a priority-3 epic activation`);
  console.log(`with preempt: true → success: ${res.success}, stood down: ${res.preempted?.victim?.path ?? '(nothing)'}`);
  console.log(`  the epic supervisor still running: ${bridge.alive.includes('epic-kan-39')}`);
  console.log(`  every prior agent still running:    ${FULL.every((n) => bridge.alive.includes(n))}`);
  console.log(`  preemption broadcast:               ${events.some((e) => e.reason === 'preempted')}`);

  console.log(
    '\n  Two protections, and only one of them is a rule anyone wrote. The ordering\n' +
    '  half: the epic agents are the top of the scale their caller declared and the\n' +
    '  comparison is strictly-greater, so no activation at any priority can select\n' +
    '  one as victim — a fact about the ordering, not a special case. The gate half:\n' +
    '  an unrefusable activation is never refused and never preempts, because the\n' +
    '  capacity model never charged it a slot — standing something down would free\n' +
    '  room it does not take.'
  );

  verdict(
    topOfScale === null &&
      bridge.alive.includes('epic-kan-39') &&
      res.success === true &&
      !res.preempted &&
      FULL.every((n) => bridge.alive.includes(n)) &&
      !events.some((e) => e.reason === 'preempted'),
    'an epic agent cannot be selected at any priority, and a top-of-scale unrefusable\n' +
    '    activation on a full machine started without standing anything down.',
    'the epic activation was refused, or something was stood down for it.'
  );
}

// ------------------------------------------------- 7. exempt victims --
rule('7. PROTECTED VICTIMS — a low-priority unpreemptable agent is never offered, never killed');

{
  // The machine is full of priority-2 charged agents, and the ONLY thing any
  // priority-2 activation would outrank is the priority-1 watchdog — which is
  // `preemptable: false`.
  //
  // AND IT IS ALSO CHARGED, which the old single boolean could not say. Under
  // `gateExempt` this protection came bundled with never being counted, so
  // "do not take this one" and "this one is free" were the same statement.
  // Splitting them means the watchdog occupies a real slot AND is still never
  // a victim — and the exclusion has to be doing the work on its own, because
  // there is no longer an uncharged-ness to hide behind.
  const FULL_HOTFIX = [
    'watchdog-kan-90',
    ...Array.from({ length: HERE.cap - 1 }, (_, i) => `hotfix-kan-${10 + i}`)
  ];
  const bridge = stubHerdr(FULL_HOTFIX, { statuses: { 'watchdog-kan-90': 'idle' } });
  const harness = newRouter(bridge);
  const { events } = harness;

  console.log(`running: ${FULL_HOTFIX.map(agentDir).join(', ')}`);
  console.log(`the watchdog is idle and CHARGED — the "best victim" by every rule except the`);
  console.log(`one under proof\n`);

  const res = await quiet(() => call(harness, 'hotfix-kan-99', { preempt: true }));

  console.log(`activate a priority-2 hotfix agent with preempt: true →`);
  console.log(`  success: ${res.success}, preemption offered: ${'preemption' in res}, ` +
    `stood down: ${res.preempted?.victim?.path ?? '(nothing)'}`);
  console.log(`  the watchdog still running: ${bridge.alive.includes('watchdog-kan-90')}`);
  console.log(`  refusal names the watchdog: ${/watchdog/.test(res.error ?? '')}`);

  verdict(
    res.success === false &&
      !res.preemption &&
      !res.preempted &&
      bridge.alive.includes('watchdog-kan-90') &&
      bridge.alive.length === FULL_HOTFIX.length &&
      !/watchdog/.test(res.error ?? '') &&
      !events.some((e) => e.reason === 'preempted'),
    'the unpreemptable agent is not offered, not named in the fleet list, and not\n' +
    '    killed — even with preempt: true, even though it is the only lower-priority\n' +
    '    agent running, and even though it IS charged. `preemptable` is doing the work\n' +
    '    on its own.',
    `the watchdog was offered or killed: offered=${Boolean(res.preemption)} ` +
    `alive=${bridge.alive.includes('watchdog-kan-90')}`
  );
}

// ------------------------------------------------- 8. victim address --
rule('8. VICTIM ADDRESS — the stand-down takes the agent the refusal named');

{
  // WHAT THIS STILL PROVES, AND WHAT IT NO LONGER CAN.
  //
  // Under the old model these were task/SHARED and hotfix/SHARED — one key,
  // told apart only by a type flag the caller had to remember — and the
  // hazard was real: a stand-down that fell back to a suffix match could tear
  // down the neighbour, killing an agent the refusal never named.
  //
  // That hazard is designed away rather than defended against, so this section
  // can no longer discriminate the way it did: there is no resolver left to
  // pick wrongly. It is kept because the PROPERTY still has to hold — the
  // agent named in the refusal is the agent that dies — and the fixture uses
  // two different directory names because two identical ones would suggest the
  // old collision is still expressible. It is not.
  const SHARED_FLEET = [
    'task-shared',
    'hotfix-shared',
    ...Array.from({ length: HERE.cap - 1 }, (_, i) => `task-kan-${10 + i}`)
  ];
  const bridge = stubHerdr(SHARED_FLEET, { statuses: { 'task-shared': 'idle' } });
  const harness = newRouter(bridge);
  const { events } = harness;

  console.log(`running:`);
  for (const n of SHARED_FLEET) console.log(`  ${agentDir(n)}  (pane ${paneNameFor(agentDir(n))})`);
  console.log(`\nthe two "shared" agents have different pane names, derived from their paths\n`);

  const res = await quiet(() => call(harness, 'hotfix-kan-99', { preempt: true }));

  const deactivatedEvent = events.find((e) => e.action === 'agent.deactivated');
  console.log(`activate a priority-2 hotfix agent with preempt: true →`);
  console.log(`  success: ${res.success}, stood down: ${res.preempted?.victim?.path}`);
  console.log(`  broadcast victim: ${deactivatedEvent?.path} (reason ${deactivatedEvent?.reason})`);
  console.log(`  the agent that took the slot: ${deactivatedEvent?.preemption?.by?.path}`);
  console.log(`  task-shared gone:        ${!bridge.alive.includes('task-shared')}`);
  console.log(`  hotfix-shared survives:  ${bridge.alive.includes('hotfix-shared')}`);

  verdict(
    res.success === true &&
      res.preempted?.victim?.path === agentDir('task-shared') &&
      deactivatedEvent?.reason === 'preempted' &&
      deactivatedEvent?.path === agentDir('task-shared') &&
      !bridge.alive.includes('task-shared') &&
      bridge.alive.includes('hotfix-shared'),
    'the agent the refusal would have named is the agent that died: the stand-down\n' +
    '    resolved it by path, its same-basename neighbour survived, and every broadcast\n' +
    '    names the right victim. There is no suffix match left to get this wrong.',
    `wrong victim: stood down ${res.preempted?.victim?.path ?? deactivatedEvent?.path ?? '(nothing)'}, ` +
    `hotfix-shared alive=${bridge.alive.includes('hotfix-shared')}`
  );
}

if (failures > 0) {
  console.log(`\n== ${failures} SECTION(S) FAILED ==`);
  process.exit(1);
}
console.log('\n== done ==');
