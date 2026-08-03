#!/usr/bin/env node
// Live proof for priority and preemption (KAN-71): a higher-priority agent
// can take a lower-priority one's slot when the machine is full — visibly,
// reversibly, and never automatically.
//
// In the extraction source this proof also drove the durable registry (a
// preempted agent's record, its resumption, and why a reboot does not bring
// it back). That registry is the T4 slice of KAN-68 and has not landed;
// until it does, the preemption record's only carrier is the
// `agent_preempted_event` broadcast and the deactivate payload — so that is
// what section 5 pins down, field by field, as the seam T4 plugs into
// (`recordDeactivated(record, preemption)`).
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
// WorkspaceRegistry — handleActivateByKey and handleDeactivateByKey, the same
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
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
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
// `watchdog` is a LOW-priority gate-exempt type — legitimate config, because
// `gateExempt` and `priority` are independent fields — and the shape section
// 7 exists for: an agent that outranks nothing and must still never be
// offered as a victim, because standing it down frees no charged slot.
const registry = new WorkspaceRegistry([
  { name: 'epic',     priority: 3, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: true },
  { name: 'story',    priority: 2, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: true },
  { name: 'hotfix',   priority: 2, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: false },
  { name: 'task',     priority: 1, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: false },
  { name: 'watchdog', priority: 1, promptFile: 'prompts/shell.md', defaultLauncher: 'shell', mcpServers: [], gateExempt: true }
]);

// A charged agent plus however many more this machine's own derivation says
// it can carry. Filling to the derived cap rather than to a number this
// script picked means the refusals below are produced by the real arithmetic.
const HERE = readCapacity(0, 1);

// ------------------------------------------------------------- the harness --

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
        name,
        agentRuntime: 'claude',
        workDir: `/tmp/${name}`,
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    // The post-spawn existence check (KAN-23), answered from the same list the
    // census is built from — which is the rule the real one follows.
    confirmAgentPresent: async (agentName) =>
      alive.includes(agentName)
        ? { present: true, waitedMs: 0, checks: 1 }
        : { present: false, reason: 'absent', waitedMs: 0, checks: 1,
            error: `stub herdr has no agent '${agentName}'` },
    abandonSession: () => {},
    listHerdrStatuses: () => new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    terminateSession: () => ({ success: true }),
    // The real bridge's rule: a caller that knows the type names the agent
    // exactly; a bare key falls back to the suffix match. Section 8 is what
    // holds this stub to the exact-address half.
    closeAgentByKey: (key, type) => {
      const i = type
        ? alive.indexOf(`crabcast-${type}-${key.toLowerCase()}`)
        : alive.findIndex((n) => n.endsWith(`-${key.toLowerCase()}`));
      if (i === -1) return { success: false, error: `No agent found for key '${key}'` };
      const [agentName] = alive.splice(i, 1);
      return { success: true, agentName };
    },
    spawnSession: (type, key, url, prompt, defaultAgent) => {
      const session = {
        sessionId: `${type}-${key.toLowerCase()}-stub`,
        type,
        key,
        url,
        createdAt: new Date(),
        status: 'active',
        workDir: `/tmp/workspaces/${type}/${key.toLowerCase()}`,
        ptyBuffer: '',
        expectsRuntime: false
      };
      spawns.push({ type, key, defaultAgent });
      alive.push(`crabcast-${type}-${key.toLowerCase()}`);
      return session;
    }
  };
  return bridge;
}

const stubPrompts = { loadAndRender: () => '# prompt' };
const stubConfig = { configPath: '/tmp/crabcast.config.json', dataDir: '/tmp' };

function newRouter(bridge) {
  const events = [];
  const router = new MessageRouter({
    registry,
    config: stubConfig,
    promptLoader: stubPrompts,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry: new AgentRegistry(path.join(scratch, `agents-${++registryFile}.jsonl`)),
    send: () => {},
    broadcast: (msg) => events.push(msg)
  });
  return { router, events };
}

/**
 * The running fleet as priority candidates, read off whatever the stub herdr
 * is currently reporting.
 */
function fleetNow(bridge) {
  return bridge.listHerdrAgents().map((a) => {
    const [, type, ...rest] = a.name.split('-');
    return {
      agentName: a.name,
      type,
      key: rest.join('-'),
      priority: registry.priorityFor(type),
      herdrStatus: a.herdrStatus,
      activatedAt: null
    };
  });
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
  for (const c of fleetNow(bridge)) {
    if (registry.get(c.type)?.gateExempt) exempt++;
    else fleet++;
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

const call = async (router, data) => {
  let response;
  await router.handleActivateByKey(data, (msg) => { response = msg; });
  return response;
};

// ----------------------------------------------------------- 1. the scale --
rule('1. THE SCALE — where priority comes from');

console.log(
  'Priority is a property of the WORKSPACE TYPE, declared in crabcast.config.json\n' +
  '(required — the loader refuses a type without one). The type is already\n' +
  'resolved before activation, so no external lookup sits on the activation path,\n' +
  'and every caller — CLI or MCP — gets the same answer by the same route.\n'
);
console.log('  type      priority   gateExempt');
for (const type of ['epic', 'story', 'hotfix', 'task', 'watchdog']) {
  const c = registry.get(type);
  console.log(`  ${type.padEnd(9)} ${String(c.priority).padStart(4)}       ${c.gateExempt}`);
}
console.log(
  `  ${'(unknown)'.padEnd(9)} ${String(registry.priorityFor('nonesuch')).padStart(4)}       ` +
  `falls to the floor — the lowest declared priority — so it can preempt nothing`
);

const scaleOk =
  registry.priorityFor('epic') === 3 &&
  registry.priorityFor('story') === 2 &&
  registry.priorityFor('hotfix') === 2 &&
  registry.priorityFor('task') === 1 &&
  registry.priorityFor('nonesuch') === 1;
verdict(
  scaleOk,
  'the scale is the config, read back: epic 3 > {story, hotfix} 2 > task 1, unknown → floor.',
  'the scale is not what the config declared.'
);

console.log(
  '\n  Strictly-greater, not greater-or-equal:\n' +
  `    task(1) over task(1):     ${outranks(1, 1)}   ← the common case, and a refusal\n` +
  `    hotfix(2) over task(1):   ${outranks(2, 1)}\n` +
  `    epic(3) over epic(3):     ${String(outranks(3, 3)).padStart(5)}   ← nothing can outrank the top of the scale`
);

// ------------------------------------------------------------ 2. ordering --
rule('2. ORDERING — which agent is chosen, and why that one');

const fleet = [
  { agentName: 'crabcast-epic-kan-39',  type: 'epic',  key: 'KAN-39', priority: 3, herdrStatus: 'working', activatedAt: '2026-08-01T09:00:00Z' },
  { agentName: 'crabcast-story-kan-50', type: 'story', key: 'KAN-50', priority: 2, herdrStatus: 'idle',    activatedAt: '2026-08-01T10:00:00Z' },
  { agentName: 'crabcast-task-kan-10',  type: 'task',  key: 'KAN-10', priority: 1, herdrStatus: 'working', activatedAt: '2026-08-01T11:00:00Z' },
  { agentName: 'crabcast-task-kan-11',  type: 'task',  key: 'KAN-11', priority: 1, herdrStatus: 'idle',    activatedAt: '2026-08-01T12:00:00Z' },
  { agentName: 'crabcast-task-kan-12',  type: 'task',  key: 'KAN-12', priority: 1, herdrStatus: 'idle',    activatedAt: '2026-08-01T08:00:00Z' }
];

console.log('victim order (best victim first), over a fleet of five:\n');
for (const c of [...fleet].sort(compareVictims)) {
  console.log(`  ${String(c.priority)}  ${c.herdrStatus.padEnd(8)} ${c.activatedAt}  ${c.agentName}`);
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
  console.log(`  an activation at priority ${incoming} would take: ${v ? v.agentName : '(nothing — it outranks nothing)'}`);
}
const orderOk =
  selectVictim(fleet, 1) === null &&
  selectVictim(fleet, 2)?.agentName === 'crabcast-task-kan-12' &&
  selectVictim(fleet, 3)?.agentName === 'crabcast-task-kan-12';
verdict(
  orderOk,
  'priority 1 takes nothing; 2 and 3 both take the oldest idle task agent, not the working one.',
  'the ordering did not choose as documented.'
);

// ------------------------------------------------------------- 3. refusal --
rule('3. REFUSAL — a task agent at capacity, on a machine full of task agents');

// Filled to the machine's own derived cap, plus an epic supervisor, which is
// gate-exempt and does not occupy one of those slots.
const FULL = [
  'crabcast-epic-kan-39',
  ...Array.from({ length: HERE.cap }, (_, i) => `crabcast-task-kan-${10 + i}`)
];

{
  const bridge = stubHerdr(FULL, { statuses: { 'crabcast-task-kan-10': 'idle' } });
  const { router } = newRouter(bridge);
  const res = await quiet(() => call(router, { type: 'task', key: 'KAN-99' }));

  console.log(`running: ${FULL.join(', ')}\n`);
  console.log(res.error);
  console.log(`\n  capacity: ${summarizeCapacity({ ...HERE, running: HERE.cap })}`);
  console.log(`  refusedBy: ${res.refusedBy}   priority of the refused activation: ${res.priority}`);
  console.log(`  preemption offered: ${res.preemption ? 'yes' : 'no'}`);

  const namesFleet = /priority 1/.test(res.error) && /task\/kan-1\d \(priority 1/i.test(res.error);
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
  const forced = await quiet(() => call(router, { type: 'task', key: 'KAN-99', preempt: true }));
  console.log(`\n  the same call again with preempt: true → success: ${forced.success}, ` +
    `preempted: ${forced.preempted ? forced.preempted.victim.agentName : '(nothing)'}`);
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
  const bridge = stubHerdr(FULL, { statuses: { 'crabcast-task-kan-10': 'idle' } });
  const { router } = newRouter(bridge);
  // A story activation would sail through the gate — gateExempt types are
  // never refused, so they are never offered a victim. The consent flow is
  // reached by a priority-2 *charged* type, which is what `hotfix` is.
  const res = await quiet(() => call(router, { type: 'hotfix', key: 'KAN-50' }));

  console.log('a priority-2 charged activation arrives while the machine is full.\n');
  console.log('what the caller receives:\n');
  console.log(JSON.stringify({ success: res.success, type: res.type, key: res.key, priority: res.priority, preemption: res.preemption }, null, 2));

  const nothingDied = bridge.alive.length === FULL.length;
  verdict(
    res.success === false && res.preemption && nothingDied &&
      res.preemption.agentName === 'crabcast-task-kan-10' &&
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
  const bridge = stubHerdr(FULL, { statuses: { 'crabcast-task-kan-10': 'idle' } });
  const { router, events } = newRouter(bridge);

  const before = capacityOfFleet(bridge);
  console.log(`BEFORE  ${summarizeCapacity(before)}`);
  console.log(`        at capacity: ${before.atCapacity}`);
  console.log(`        running, in the order they would be taken:`);
  for (const c of [...fleetNow(bridge)].sort(compareVictims)) {
    console.log(`          ${c.priority}  ${c.herdrStatus.padEnd(8)} ${c.agentName}`);
  }

  const res = await call(router, { type: 'hotfix', key: 'KAN-50', preempt: true });

  console.log(`\nactivate hotfix/KAN-50 (priority 2) with preempt: true\n`);
  console.log('what was preempted, and why (on the activate response):\n');
  console.log(JSON.stringify(res.preempted, null, 2).split('\n').slice(0, 12).join('\n'));

  const after = capacityOfFleet(bridge);
  console.log(`\nAFTER   ${summarizeCapacity(after)}`);
  console.log(`        alive: ${bridge.alive.join(', ')}`);

  const preemptedEvent = events.find((e) => e.action === 'agent_preempted_event');
  const deactivatedEvent = events.find((e) => e.action === 'agent_deactivated_event');
  console.log(`\nbroadcast to every connected client:\n`);
  console.log(`  ${preemptedEvent.action}: ${preemptedEvent.victim.type}/${preemptedEvent.victim.key} ` +
    `(priority ${preemptedEvent.victim.priority}, ${preemptedEvent.victim.herdrStatus}) ` +
    `stood down for ${preemptedEvent.by.type}/${preemptedEvent.by.key} (priority ${preemptedEvent.by.priority})`);
  console.log(`  ${deactivatedEvent.action}: ${deactivatedEvent.type}/${deactivatedEvent.key} preempted=${deactivatedEvent.preempted}`);

  // The full PreemptionRecord rides the event. Until the durable registry
  // (T4 of KAN-68) lands, this payload is the record's only carrier — it is
  // the exact shape T4's recordDeactivated(record, preemption) persists, so
  // every field is pinned here.
  const record = preemptedEvent.record;
  console.log(`\nthe PreemptionRecord on the event — the seam the durable registry (T4) plugs into:\n`);
  console.log(JSON.stringify(record, null, 2).split('\n').map((l) => '  ' + l).slice(0, 10).join('\n'));
  const recordOk =
    record &&
    record.byAgentName === 'crabcast-hotfix-kan-50' &&
    record.byType === 'hotfix' &&
    record.byKey === 'KAN-50' &&
    record.byPriority === 2 &&
    record.priority === 1 &&
    record.herdrStatus === 'idle' &&
    /cap:/.test(record.derivation);

  const startedIt = res.success === true && res.verified === true;
  const tookTheIdleOne = res.preempted?.victim?.key?.toUpperCase() === 'KAN-10';
  const gone = !bridge.alive.includes('crabcast-task-kan-10');
  const started = bridge.alive.includes('crabcast-hotfix-kan-50');
  verdict(
    startedIt && tookTheIdleOne && gone && started && recordOk,
    'the low-priority agent was stood down and the higher-priority one started. The\n' +
    '    victim chosen was the idle one, not either of the working ones, and the whole\n' +
    '    decision — who, for whom, both priorities, what the victim was doing, and the\n' +
    '    capacity arithmetic that forced it — is on the wire and in the activate\n' +
    '    response, in the exact record shape the durable registry will persist.',
    `preemption did not do what it claimed: started=${startedIt} victim=${res.preempted?.victim?.key} gone=${gone} new=${started} recordOk=${recordOk}`
  );
}

// ------------------------------------------------- 6. gateExempt safety --
rule('6. GATEEXEMPT SAFETY — the top of the scale cannot be touched');

{
  // A fleet where an epic supervisor is the ONLY thing running, and an
  // activation at the very top of the scale asking for room.
  const epicOnly = [{ ...fleet[0] }];
  const topOfScale = selectVictim(epicOnly, 3);
  console.log(`fleet: crabcast-epic-kan-39 (priority 3)`);
  console.log(`an activation at the highest declared priority (3) would take: ${topOfScale ?? '(nothing)'}\n`);

  // And through the real router, on a full machine. A gateExempt activation
  // never consults the rationing half of the gate at all: the epic agent
  // starts alongside the full fleet, preempt: true notwithstanding, and
  // nothing is stood down for it — its cost was never charged, so there is
  // no slot to free.
  const bridge = stubHerdr(FULL, { statuses: { 'crabcast-task-kan-10': 'idle' } });
  const { router, events } = newRouter(bridge);
  const res = await quiet(() => call(router, { type: 'epic', key: 'KAN-77', preempt: true }));

  console.log(`on a full machine including crabcast-epic-kan-39, a priority-3 epic activation`);
  console.log(`with preempt: true → success: ${res.success}, stood down: ${res.preempted?.victim?.agentName ?? '(nothing)'}`);
  console.log(`  crabcast-epic-kan-39 still running: ${bridge.alive.includes('crabcast-epic-kan-39')}`);
  console.log(`  every prior agent still running:    ${FULL.every((n) => bridge.alive.includes(n))}`);
  console.log(`  agent_preempted_event broadcast:    ${events.some((e) => e.action === 'agent_preempted_event')}`);

  console.log(
    '\n  Two protections, and only one of them is a rule anyone wrote. The ordering\n' +
    '  half: the epic type is the top of the declared scale and the comparison is\n' +
    '  strictly-greater, so no activation at any priority can select an epic agent\n' +
    '  as victim — a fact about the ordering, not a special case. The gate half:\n' +
    '  a gateExempt activation is never refused and never preempts, because the\n' +
    '  capacity model never charged it a slot — standing something down would free\n' +
    '  room it does not take.'
  );

  verdict(
    topOfScale === null &&
      bridge.alive.includes('crabcast-epic-kan-39') &&
      res.success === true &&
      !res.preempted &&
      FULL.every((n) => bridge.alive.includes(n)) &&
      !events.some((e) => e.action === 'agent_preempted_event'),
    'an epic agent cannot be selected at any priority, and a top-of-scale gateExempt\n' +
    '    activation on a full machine started without standing anything down.',
    'the epic activation was refused, or something was stood down for it.'
  );
}

// ------------------------------------------------- 7. exempt victims --
rule('7. EXEMPT VICTIMS — a low-priority gateExempt agent is never offered, never killed');

{
  // The machine is full of priority-2 charged agents, and the ONLY thing any
  // priority-2 activation would outrank is the priority-1 watchdog — which is
  // gateExempt. It was never counted in `running`, so standing it down frees
  // no charged slot: offering it would let the preempt path admit the
  // newcomer over the cap on a false premise. In the extraction source the
  // exempt set was the top of the scale and the ordering protected it; here
  // the fields are independent, and only the candidate exclusion protects it.
  const FULL_HOTFIX = [
    'crabcast-watchdog-kan-90',
    ...Array.from({ length: HERE.cap }, (_, i) => `crabcast-hotfix-kan-${10 + i}`)
  ];
  const bridge = stubHerdr(FULL_HOTFIX, { statuses: { 'crabcast-watchdog-kan-90': 'idle' } });
  const { router, events } = newRouter(bridge);

  console.log(`running: ${FULL_HOTFIX.join(', ')}`);
  console.log(`the watchdog is idle — the "best victim" by every rule except the one under proof\n`);

  const res = await quiet(() => call(router, { type: 'hotfix', key: 'KAN-99', preempt: true }));

  console.log(`activate hotfix/KAN-99 (priority 2) with preempt: true →`);
  console.log(`  success: ${res.success}, preemption offered: ${'preemption' in res}, ` +
    `stood down: ${res.preempted?.victim?.agentName ?? '(nothing)'}`);
  console.log(`  crabcast-watchdog-kan-90 still running: ${bridge.alive.includes('crabcast-watchdog-kan-90')}`);
  console.log(`  refusal names the watchdog: ${/watchdog/.test(res.error ?? '')}`);

  verdict(
    res.success === false &&
      !res.preemption &&
      !res.preempted &&
      bridge.alive.includes('crabcast-watchdog-kan-90') &&
      bridge.alive.length === FULL_HOTFIX.length &&
      !/watchdog/.test(res.error ?? '') &&
      !events.some((e) => e.action === 'agent_preempted_event'),
    'the exempt agent is not offered, not named in the fleet list, and not killed —\n' +
    '    even with preempt: true and even though it is the only lower-priority agent\n' +
    '    running. Standing down an uncharged agent frees no charged slot, so it is\n' +
    '    never a valid victim.',
    `the watchdog was offered or killed: offered=${Boolean(res.preemption)} ` +
    `alive=${bridge.alive.includes('crabcast-watchdog-kan-90')}`
  );
}

// ------------------------------------------------- 8. victim address --
rule('8. VICTIM ADDRESS — two types share a key; the stand-down takes the named one');

{
  // task/SHARED (idle — the best victim) and hotfix/SHARED are both live.
  // The gate selects task/SHARED and stands it down by FULL ADDRESS; a
  // key-only stand-down here could tear down hotfix/SHARED instead — killing
  // an agent the refusal never named, the same wrong-victim hazard class the
  // activate path documents.
  const SHARED_FLEET = [
    'crabcast-task-shared',
    'crabcast-hotfix-shared',
    ...Array.from({ length: HERE.cap }, (_, i) => `crabcast-task-kan-${10 + i}`)
  ];
  const bridge = stubHerdr(SHARED_FLEET, { statuses: { 'crabcast-task-shared': 'idle' } });
  const { router, events } = newRouter(bridge);

  console.log(`running: ${SHARED_FLEET.join(', ')}\n`);

  const res = await quiet(() => call(router, { type: 'hotfix', key: 'KAN-99', preempt: true }));

  const preemptedEvent = events.find((e) => e.action === 'agent_preempted_event');
  const deactivatedEvent = events.find((e) => e.action === 'agent_deactivated_event');
  console.log(`activate hotfix/KAN-99 (priority 2) with preempt: true →`);
  console.log(`  success: ${res.success}, stood down: ${res.preempted?.victim?.agentName}`);
  console.log(`  broadcast victim: ${preemptedEvent?.victim?.agentName}`);
  console.log(`  deactivated event address: ${deactivatedEvent?.type}/${deactivatedEvent?.key}`);
  console.log(`  crabcast-task-shared gone:      ${!bridge.alive.includes('crabcast-task-shared')}`);
  console.log(`  crabcast-hotfix-shared survives: ${bridge.alive.includes('crabcast-hotfix-shared')}`);

  verdict(
    res.success === true &&
      res.preempted?.victim?.agentName === 'crabcast-task-shared' &&
      preemptedEvent?.victim?.agentName === 'crabcast-task-shared' &&
      deactivatedEvent?.type === 'task' &&
      !bridge.alive.includes('crabcast-task-shared') &&
      bridge.alive.includes('crabcast-hotfix-shared'),
    'the agent the refusal would have named is the agent that died: the stand-down\n' +
    '    resolved task/shared by full address, its same-key hotfix neighbour survived,\n' +
    '    and every broadcast names the right victim.',
    `wrong victim: stood down ${res.preempted?.victim?.agentName ?? deactivatedEvent?.key ?? '(nothing)'}, ` +
    `hotfix-shared alive=${bridge.alive.includes('crabcast-hotfix-shared')}`
  );
}

if (failures > 0) {
  console.log(`\n== ${failures} SECTION(S) FAILED ==`);
  process.exit(1);
}
console.log('\n== done ==');
