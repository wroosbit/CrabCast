// Ported from the extraction source's KAN-38 proof: a fleet client can switch
// an agent off and back on, and every way that could go wrong has an answer
// rather than a discovery.
//
// Eight sections, one per thing that had to be decided:
//
//   1. off          — the message a client sends, and the agent gone from the census
//   2. on           — where the On candidates come from, and the agent back
//   3. launcher     — why a stand-down has to carry the activation record with it
//   4. preempted    — a preemption is a debt: reported until re-activation,
//                     disjoint from standby, and re-activation is a resume;
//                     4b: a failed teardown writes nothing; 4c: the debt list
//                     is census-cross-checked like every category
//   5. already gone — standing down an agent that already died records the
//                     intent and reports success, not failure
//   6. poll churn   — a census position is not an identity across polls
//   7. reset        — a deleted workspace is not offered a way back;
//                     7b: reset resolves the full address, never a key-twin
//   8. durability   — a registry that cannot be written answers durable: false
//                     and broadcasts the degradation, instead of hiding it
//                     behind verified: true
//
// KAN-88 added four more, for the deferred findings from PR #6's review:
//
//   9. compaction   — compaction carries the standby rows whose workspace still
//                     exists, so a stood-down agent keeps its way back past the
//                     500-record mark (B5)
//  10. mcpServers   — a changed server list is re-recorded, so a restart does
//                     not replay the list the agent first started with (B6)
//  11. short writes — a write that stops part way is finished, and one that
//                     cannot progress is reported instead of fsynced (B7)
//  12. one read     — one whole-log read per list_agents poll instead of four,
//                     and all three registry-derived categories capped with
//                     totals rather than only standby (B9); 12b: the daemon's
//                     missing-sweep reads the UNCAPPED list, so a loss past
//                     position 25 is still announced rather than silently
//                     never reported
//
// Every section drives the real MessageRouter, the real WorkspaceRegistry, a
// real config through the real loader and a real on-disk AgentRegistry, so
// what it prints is what a caller actually receives and what is actually
// written to the log. herdr is stubbed — nothing here reaches it except a
// census and a pane close, and the live half of this proof (a real daemon, a
// real herdr, `herdr agent list` as ground truth) is
// verify-fleet-switch-live.mjs.
//
// What did NOT travel from the extraction source: the work-state confirmation
// (its git probe stays in Butchr per the story's NOT-ported list), the
// hardcoded supervisor set (CrabCast marks rows with the type's `gateExempt`
// from config instead), and the capacity refusal (the measured gate landed
// with KAN-71 and has its own proof in verify-agent-capacity.mjs; activations
// here pass it with the recorded override — see PAST_THE_GATE).
//
// Usage:
//   npm run build
//   node scripts/verify-agent-power-controls.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
let failures = 0;

/**
 * Every activation in this script passes this, and it is not a shortcut. The
 * capacity gate (KAN-71's slice) reads the real machine — cores, memory, and
 * a one-minute load average that moves while this script runs — and this
 * script is about the registry's power controls, not the gate: a proof that
 * passes on a quiet machine and fails on a busy one proves nothing either
 * way. The override path is itself real and recorded; the gate has its own
 * proof in verify-agent-capacity.mjs.
 */
const PAST_THE_GATE = { override: true };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan38-'));
const WORKSPACES = path.join(TMP, 'workspaces');
let registryFile = 0;

// A real config through the real loader: an exempt supervisor-ish type and an
// ordinary one, so the rows a client renders carry the flag from config.
const dataDir = path.join(TMP, 'data');
const configPath = path.join(TMP, 'crabcast.config.json');
fs.mkdirSync(path.join(TMP, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'prompts', 'any.md'), 'KAN-38 proof {{KEY}}.\n');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: 'epic', priority: 10, promptFile: 'prompts/any.md', defaultLauncher: 'claude', gateExempt: true },
    { name: 'task', priority: 1, promptFile: 'prompts/any.md', defaultLauncher: 'claude' }
  ]
}, null, 2));

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));

const config = loadConfig(configPath);
const registry = new WorkspaceRegistry(config.workspaceTypes);
const prompts = new PromptLoader(config.baseDir);

// ------------------------------------------------------------- the harness --

/**
 * A herdr that reports exactly the agents it is told to and forgets one when
 * its pane is closed, so a census taken after a stand-down is the fleet as it
 * then is rather than a reconstruction. This is the stand-in for
 * `herdr agent list`, and the live script proves the same sequence against the
 * real one.
 */
function stubHerdr(running, { statuses = {}, workDirs = {}, closeFails = false } = {}) {
  const alive = [...running];
  const bridge = {
    alive,
    spawns: [],
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: workDirs[name] ?? path.join(WORKSPACES, name),
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    // The post-spawn existence check, answered from the same list the census
    // is built from — which is the rule the real one follows.
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
    // Type-aware, like the real one: a caller that gives the full address must
    // only ever close that address's pane — that precision is what section 7's
    // cross-type reset check leans on.
    closeAgentByKey: (key, type) => {
      if (closeFails) return { success: false, error: `No agent found for key '${key}'` };
      const i = type
        ? alive.findIndex((n) => n === `crabcast-${type}-${key.toLowerCase()}`)
        : alive.findIndex((n) => n.endsWith(`-${key.toLowerCase()}`));
      if (i === -1) return { success: false, error: `No agent found for key '${key}'` };
      const [agentName] = alive.splice(i, 1);
      return { success: true, agentName };
    },
    tailAgent: () => ({ success: true, text: 'bypass permissions on\n❯ ' }),
    sendToAgent: async () => ({ success: true }),
    resetWorkspace: () => ({ success: true }),
    spawnSession: (type, key, url, prompt, defaultAgent, mcpServers, resume) => {
      const workDir = path.join(WORKSPACES, type, key.toLowerCase());
      fs.mkdirSync(workDir, { recursive: true });
      bridge.spawns.push({ type, key, url, defaultAgent, resume });
      alive.push(`crabcast-${type}-${key.toLowerCase()}`);
      return {
        sessionId: `${type}-${key.toLowerCase()}-stub`,
        type,
        key,
        url,
        createdAt: new Date(),
        status: 'active',
        workDir,
        ptyBuffer: '',
        onDataListeners: [],
        // What the real spawnSession sets on a resume; resumedConversation
        // stays false so the fire-and-forget nudge has nothing to do here.
        ...(resume ? { resume, resumedConversation: false } : {})
      };
    }
  };
  return bridge;
}

function newRouter(bridge, seed = []) {
  const events = [];
  let last;
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFile}.jsonl`));
  for (const record of seed) agentRegistry.recordActivated(record);
  const router = new MessageRouter({
    registry,
    config,
    promptLoader: prompts,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry,
    send: (msg) => { last = msg; },
    broadcast: (msg) => events.push(msg)
  });
  return { router, events, agentRegistry, sent: () => last };
}

/** What `list_agents` answers right now — the payload a client renders. */
function list(router, sent) {
  router.handle({ action: 'list_agents' });
  return sent();
}

async function quiet(fn) {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const seedOf = (names, workDirs = {}) =>
  names.map((agentName) => {
    const [, type, ...rest] = agentName.split('-');
    const key = rest.join('-');
    return {
      agentName,
      type,
      key: key.toUpperCase(),
      workDir: workDirs[agentName] ?? path.join(WORKSPACES, type, key),
      defaultAgent: 'claude'
    };
  });

// ------------------------------------------------------------------ 1. off --
rule('1. OFF — what a client sends, and the agent gone from the census');

{
  const FLEET = ['crabcast-epic-kan-39', 'crabcast-task-kan-38', 'crabcast-task-kan-25'];
  const workDirs = Object.fromEntries(
    FLEET.map((n) => [n, path.join(WORKSPACES, ...n.replace('crabcast-', '').split(/-(.*)/s).slice(0, 2))])
  );
  for (const dir of Object.values(workDirs)) fs.mkdirSync(dir, { recursive: true });

  const bridge = stubHerdr(FLEET, { workDirs });
  const { router, events, sent } = newRouter(bridge, seedOf(FLEET, workDirs));

  const listed = list(router, sent);
  const before = listed.agents.map((a) => a.agentName);
  console.log(`census before: ${before.join(', ')}\n`);

  const exempt = listed.agents.find((a) => a.type === 'epic')?.gateExempt;
  const charged = listed.agents.find((a) => a.type === 'task')?.gateExempt;
  console.log(`rows carry the config's gateExempt flag: epic=${exempt}, task=${charged}`);
  console.log('(the flag comes from crabcast.config.json, not from a client-side type list)\n');

  console.log('a client sends exactly one message — by KEY, not by session id, because an');
  console.log('agent that outlived the daemon holding its terminal has no session id and is');
  console.log('exactly as stoppable:\n');
  console.log(`  { action: 'deactivate_by_key', type: 'task', key: 'KAN-38' }\n`);

  const res = await quiet(async () => {
    router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' });
    return sent();
  });
  console.log(`response: ${JSON.stringify({ success: res.success, type: res.type, key: res.key })}`);

  const after = list(router, sent).agents.map((a) => a.agentName);
  console.log(`census after:  ${after.join(', ')}`);

  const broadcast = events.find((e) => e.action === 'agent_deactivated_event');
  console.log(`\nbroadcast to every connected client: ${broadcast.action} ${broadcast.type}/${broadcast.key}`);

  verdict(
    res.success === true && !after.includes('crabcast-task-kan-38') && after.length === before.length - 1 &&
      exempt === true && charged === false,
    'the agent is gone from the census a client renders, nothing else moved, and the\n' +
    '    response carries the address a fleet list needs to attribute it to a row.',
    `off did not take: success=${res.success} after=${after.join(',')}`
  );
}

// ------------------------------------------------------------------- 2. on --
rule('2. ON — where the candidates come from, and the agent back');

{
  const FLEET = ['crabcast-epic-kan-39', 'crabcast-task-kan-38'];
  const workDirs = Object.fromEntries(FLEET.map((n) => [n, path.join(WORKSPACES, 'live', n)]));
  for (const dir of Object.values(workDirs)) fs.mkdirSync(dir, { recursive: true });

  const bridge = stubHerdr(FLEET, { workDirs });
  const { router, sent } = newRouter(bridge, seedOf(FLEET, workDirs));

  console.log(
    'A fleet client lists what is running, and something that is off is not in that\n' +
    'list. So the candidates cannot come from the client. They come from the durable\n' +
    'registry — the only record of activation INTENT this system has — in three\n' +
    'disjoint ways; one agent never gets two switches:\n'
  );
  console.log('  missingAgents    last word `activated`, not running    a loss    → restore');
  console.log('  preemptedAgents  stood down for capacity              a debt    → put back');
  console.log('  standbyAgents    stood down because a person said so  a choice  → turn on');
  console.log('\nNo parallel registry is written. All three are reductions of the same');
  console.log('append-only log that boot-time restoration already reads.\n');

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' }));
  const off = list(router, sent);
  console.log(`after switching task/KAN-38 off, list_agents carries:\n`);
  console.log(JSON.stringify({ standbyAgents: off.standbyAgents, standbyTotal: off.standbyTotal }, null, 2));

  const candidate = off.standbyAgents[0];
  console.log(`\na client sends, from that row:\n`);
  console.log(`  { action: 'activate_by_key', type: '${candidate.type}', key: '${candidate.key}',`);
  console.log(`    defaultAgent: '${candidate.defaultAgent}' }`);

  const res = await quiet(async () => {
    let out;
    await router.handleActivateByKey(
      { type: candidate.type, key: candidate.key, defaultAgent: candidate.defaultAgent, ...PAST_THE_GATE },
      (msg) => { out = msg; }
    );
    return out;
  });

  const back = list(router, sent);
  console.log(`\nactivate_by_key → success: ${res.success}`);
  console.log(`census:     ${back.agents.map((a) => a.agentName).join(', ')}`);
  console.log(`stood down: ${back.standbyAgents.length === 0 ? '(empty — it left the list the moment it came back)' : back.standbyAgents.map((a) => a.key).join(', ')}`);

  verdict(
    res.success === true &&
      back.agents.some((a) => a.agentName === 'crabcast-task-kan-38') &&
      back.standbyAgents.length === 0,
    'off and on are a round trip from one client, and the candidate list empties itself\n' +
    '    — an agent that is running is never offered an On button.',
    `the round trip did not close: success=${res.success} standby=${back.standbyAgents.length}`
  );
}

// ------------------------------------------------------------- 3. launcher --
rule('3. LAUNCHER — why a stand-down has to carry the activation record with it');

{
  const FLEET = ['crabcast-task-kan-38'];
  const workDir = path.join(WORKSPACES, 'launcher', 'kan-38');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr(FLEET, { workDirs: { 'crabcast-task-kan-38': workDir } });
  const { router, agentRegistry } = newRouter(bridge, [
    {
      agentName: 'crabcast-task-kan-38',
      type: 'task',
      key: 'KAN-38',
      workDir,
      url: 'https://example.invalid/browse/KAN-38',
      defaultAgent: 'claude',
      mcpServers: ['crabcast']
    }
  ]);

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' }));
  const intent = agentRegistry.intents().get('crabcast-task-kan-38');

  console.log('the stand-down record the registry now holds:\n');
  console.log(`  event:        ${intent.event}`);
  console.log(`  workDir:      ${intent.record.workDir}`);
  console.log(`  url:          ${intent.record.url}`);
  console.log(`  defaultAgent: ${intent.record.defaultAgent}`);
  console.log(`  mcpServers:   ${JSON.stringify(intent.record.mcpServers)}`);

  console.log(
    '\n  `AgentRecord` is the argument list of an activation, and `defaultAgent` is one\n' +
    '  of its arguments: an agent recorded without it and then switched back on falls\n' +
    '  to the type\'s defaultLauncher, which may not be the launcher it actually ran —\n' +
    '  it would come back as something other than what it was. The url and workDir\n' +
    '  travel for the same reason. The extraction source learned this when stood-down\n' +
    '  agents with no recorded launcher came back as bare shells wearing agent names.'
  );

  await quiet(() =>
    router.handleActivateByKey(
      { type: 'task', key: 'KAN-38', defaultAgent: intent.record.defaultAgent, url: intent.record.url, ...PAST_THE_GATE },
      () => {}
    )
  );
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  console.log(`\n  switched back on with:  defaultAgent=${spawned.defaultAgent}  url=${spawned.url}`);

  verdict(
    intent.record.defaultAgent === 'claude' &&
      intent.record.url === 'https://example.invalid/browse/KAN-38' &&
      spawned.defaultAgent === 'claude',
    'it comes back as what it was, not as something else.',
    `the activation record did not survive the stand-down: ${JSON.stringify(intent.record)}`
  );
}

// ------------------------------------------------------------ 4. preempted --
rule('4. PREEMPTED — a debt, reported until re-activation, and re-activation is a resume');

{
  const FLEET = ['crabcast-task-kan-40'];
  const workDir = path.join(WORKSPACES, 'task', 'kan-40');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr(FLEET, { workDirs: { 'crabcast-task-kan-40': workDir } });
  const { router, sent } = newRouter(bridge, seedOf(FLEET, { 'crabcast-task-kan-40': workDir }));

  // The record a preempting caller (the capacity slice, T3) attaches: why this
  // stand-down was not the agent's own idea.
  const preemption = {
    byAgentName: 'crabcast-epic-kan-59',
    byType: 'epic',
    byKey: 'KAN-59',
    byPriority: 10,
    priority: 1,
    herdrStatus: 'working',
    derivation: 'cap 2, running 2, incoming priority 10 > 1 — the slot had to come from the lowest-priority agent'
  };

  await quiet(async () =>
    router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-40', preemption })
  );

  const listed = list(router, sent);
  const owed = listed.preemptedAgents.find((a) => a.agentName === 'crabcast-task-kan-40');
  console.log('list_agents now carries the debt:\n');
  console.log(JSON.stringify(listed.preemptedAgents, null, 2));
  console.log(`\ndisjoint from standby (one agent, one switch): standbyAgents = ${JSON.stringify(listed.standbyAgents.map((a) => a.agentName))}`);

  const res = await quiet(async () => {
    let out;
    await router.handleActivateByKey({ type: 'task', key: 'KAN-40', defaultAgent: 'claude', ...PAST_THE_GATE }, (m) => { out = m; });
    return out;
  });
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  const after = list(router, sent);
  console.log(`\nre-activated: success=${res.success}, and spawnSession was told resume='${spawned.resume}'`);
  console.log(`preemptedAgents after: ${JSON.stringify(after.preemptedAgents)}`);

  verdict(
    Boolean(owed) &&
      owed.by.agentName === 'crabcast-epic-kan-59' &&
      owed.derivation === preemption.derivation &&
      /interrupted, not finished/.test(owed.reason) &&
      listed.standbyAgents.length === 0 &&
      res.success === true &&
      spawned.resume === 'preempted' &&
      after.preemptedAgents.length === 0,
    'the debt is reported with who took the slot and the arithmetic that made it\n' +
    '    necessary; nothing restarts it on its own; and switching it back on is\n' +
    '    recognised as resuming interrupted work — the caller did not have to say so.',
    `the preemption lifecycle broke: owed=${Boolean(owed)} resume=${spawned?.resume} after=${after.preemptedAgents.length}`
  );

  // -- 4b. a teardown that fails writes nothing --------------------------------
  console.log('\n  4b. the record follows the teardown — a failed stand-down writes nothing:\n');
  console.log('  The gate aborts the whole preemption when the stand-down fails. A durable');
  console.log('  record written before that check would say the victim was preempted while it');
  console.log('  is alive and working: owed a resume it is not owed, absent from expected()');
  console.log('  so a reboot forgets it, and framed as interrupted on its next activation.\n');

  const survivorDir = path.join(WORKSPACES, 'task', 'kan-42');
  fs.mkdirSync(survivorDir, { recursive: true });
  const failBridge = stubHerdr(['crabcast-task-kan-42'], { workDirs: { 'crabcast-task-kan-42': survivorDir } });
  // A live session whose teardown fails — the pane stays, the agent works on.
  failBridge.getSessionByAddress = () => ({
    sessionId: 'task-kan-42-stub', type: 'task', key: 'KAN-42',
    createdAt: new Date(), status: 'active', workDir: survivorDir,
    ptyBuffer: '', onDataListeners: []
  });
  failBridge.terminateSession = () => ({ success: false, error: 'stub: the pane would not close' });
  const failHarness = newRouter(failBridge, seedOf(['crabcast-task-kan-42'], { 'crabcast-task-kan-42': survivorDir }));

  const failed = await quiet(async () => {
    failHarness.router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-42', preemption });
    return failHarness.sent();
  });
  const survivorIntent = failHarness.agentRegistry.intents().get('crabcast-task-kan-42');
  const failedList = list(failHarness.router, failHarness.sent);
  console.log(`  deactivate_by_key (teardown fails) → ${JSON.stringify({ success: failed.success, error: failed.error })}`);
  console.log(`  registry intent after: ${survivorIntent.event}`);
  console.log(`  preemptedAgents after: ${JSON.stringify(failedList.preemptedAgents)}`);

  verdict(
    failed.success === false &&
      survivorIntent.event === 'activated' &&
      failedList.preemptedAgents.length === 0 &&
      failedList.agents.some((a) => a.agentName === 'crabcast-task-kan-42'),
    'the failed stand-down wrote nothing: the survivor is still expected, still\n' +
    '    listed as running, and owed nothing.',
    `a failed teardown left a durable lie: ${JSON.stringify({ success: failed.success, intent: survivorIntent.event, owed: failedList.preemptedAgents.length })}`
  );

  // -- 4c. a record that contradicts the census is not reported as fact --------
  console.log('\n  4c. preemptedAgents is cross-checked against the census, like every category:\n');
  const phantomDir = path.join(WORKSPACES, 'task', 'kan-43');
  fs.mkdirSync(phantomDir, { recursive: true });
  // The census says the agent is RUNNING; the registry (via some past failure
  // this rule exists to contain) says it was preempted.
  const phantomBridge = stubHerdr(['crabcast-task-kan-43'], { workDirs: { 'crabcast-task-kan-43': phantomDir } });
  const phantomHarness = newRouter(phantomBridge, []);
  phantomHarness.agentRegistry.recordActivated({
    agentName: 'crabcast-task-kan-43', type: 'task', key: 'KAN-43', workDir: phantomDir, defaultAgent: 'claude'
  });
  phantomHarness.agentRegistry.recordDeactivated(
    { agentName: 'crabcast-task-kan-43', type: 'task', key: 'KAN-43', workDir: phantomDir, defaultAgent: 'claude' },
    preemption
  );
  const phantomList = list(phantomHarness.router, phantomHarness.sent);
  console.log(`  census: ${phantomList.agents.map((a) => a.agentName).join(', ')}`);
  console.log(`  preemptedAgents: ${JSON.stringify(phantomList.preemptedAgents)}`);

  verdict(
    phantomList.agents.some((a) => a.agentName === 'crabcast-task-kan-43') &&
      phantomList.preemptedAgents.length === 0,
    'an agent herdr can show running is never simultaneously reported as preempted\n' +
    '    debt — reality outranks the record, in this category as in the other three.',
    `a phantom debt was reported over a live agent: ${JSON.stringify(phantomList.preemptedAgents)}`
  );
}

// ---------------------------------------------------------- 5. already gone --
rule('5. ALREADY GONE — standing down a dead agent records the intent, not a failure');

{
  const workDir = path.join(WORKSPACES, 'task', 'kan-41');
  fs.mkdirSync(workDir, { recursive: true });
  // herdr is reachable and has NO agent for this key — it died on its own.
  const bridge = stubHerdr([], { closeFails: true });
  const { router, agentRegistry, sent } = newRouter(bridge, seedOf(['crabcast-task-kan-41'], { 'crabcast-task-kan-41': workDir }));

  const before = list(router, sent);
  console.log(`before: recorded active but not running → missingAgents = ${JSON.stringify(before.missingAgents.map((m) => m.agentName))}\n`);

  const res = await quiet(async () => {
    router.handle({ action: 'deactivate_by_key', key: 'KAN-41' });
    return sent();
  });
  console.log(`deactivate_by_key with no live pane → ${JSON.stringify({ success: res.success, alreadyGone: res.alreadyGone, note: res.note })}`);

  const intent = agentRegistry.intents().get('crabcast-task-kan-41');
  const after = list(router, sent);
  console.log(`\nregistry intent: ${intent.event} (resolved through the registry — herdr could not name the type)`);
  console.log(`missingAgents after: ${JSON.stringify(after.missingAgents)}`);

  verdict(
    res.success === true && res.alreadyGone === true &&
      intent.event === 'deactivated' &&
      after.missingAgents.length === 0,
    'the thing actually asked for — "stop expecting this agent back" — succeeded, the\n' +
    '    registry write landed, and the loss alarm stands down with it.',
    `already-gone did not work: ${JSON.stringify({ res, intent: intent?.event })}`
  );
}

// ------------------------------------------------------------ 6. poll churn --
rule('6. POLL CHURN — a census position is not an identity across polls');

{
  const FLEET = ['crabcast-epic-kan-39', 'crabcast-task-kan-38'];
  for (const n of FLEET) fs.mkdirSync(path.join(WORKSPACES, n), { recursive: true });
  const bridge = stubHerdr(FLEET);
  const { router, sent } = newRouter(bridge, seedOf(FLEET));

  const poll1 = list(router, sent).agents.map((a) => a.agentName);
  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'epic', key: 'KAN-39' }));
  const poll2 = list(router, sent).agents.map((a) => a.agentName);
  console.log(`poll n:   [0]=${poll1[0]}  [1]=${poll1[1]}`);
  console.log(`poll n+1: [0]=${poll2[0]}`);
  console.log(
    '\n  Index 0 is a different agent between polls. A client keying rows — or pending\n' +
    '  controls — by array index would carry state from one agent onto another; agent\n' +
    '  NAME is the only stable identity a census offers. (In the extraction source this\n' +
    '  was a rendering bug waiting to happen; the daemon-side truth it rests on is\n' +
    '  proved here.)'
  );

  verdict(
    poll1[0] !== poll2[0] && poll1.length === 2 && poll2.length === 1,
    'the census shifts under a stand-down, so position is not identity and nothing\n' +
    '    should be keyed by it.',
    'the census did not shift as expected; the demonstration proves nothing.'
  );
}

// ---------------------------------------------------------------- 7. reset --
rule('7. RESET — a deleted workspace is not offered a way back');

{
  const workDir = path.join(WORKSPACES, 'resettable', 'kan-77');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr(['crabcast-task-kan-77'], { workDirs: { 'crabcast-task-kan-77': workDir } });
  const { router, agentRegistry, sent } = newRouter(bridge, seedOf(['crabcast-task-kan-77'], { 'crabcast-task-kan-77': workDir }));

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-77' }));
  const before = list(router, sent).standbyAgents.map((a) => a.key);
  console.log(`stood down, workspace present: standbyAgents = [${before.join(', ')}]`);

  // What a reset leaves behind: the same `deactivated` record, and no directory.
  fs.rmSync(workDir, { recursive: true, force: true });
  const after = list(router, sent).standbyAgents.map((a) => a.key);
  console.log(`workspace deleted:             standbyAgents = [${after.join(', ')}]`);

  // And reset itself records the stand-down, so the next boot cannot
  // resurrect an agent whose working directory was deliberately deleted.
  await quiet(async () => router.handle({ action: 'reset_by_key', type: 'task', key: 'KAN-77' }));
  const intent = agentRegistry.intents().get('crabcast-task-kan-77');
  console.log(`\nreset_by_key recorded: ${intent.event}`);

  console.log(
    '\n  A reset is indistinguishable from an ordinary Off in the log, and the directory\n' +
    '  is the only thing that tells them apart: it is the difference between "stopped"\n' +
    '  and "finished with". Offering a way back for one of those would create an empty\n' +
    '  workspace and start an agent in it with nothing to continue.'
  );

  verdict(
    before.includes('KAN-77') && !after.includes('KAN-77') && intent.event === 'deactivated',
    'a workspace on disk is what makes an agent restorable, and a reset one is not\n' +
    '    offered.',
    'a reset workspace was still offered a way back.'
  );

  // -- 7b. reset resolves the full address -------------------------------------
  console.log('\n  7b. reset is by full address — with task/K and epic/K live, resetting one');
  console.log('  must not tear down or record against the other:\n');
  const twinTask = path.join(WORKSPACES, 'twin', 'task-kan-88');
  const twinEpic = path.join(WORKSPACES, 'twin', 'epic-kan-88');
  fs.mkdirSync(twinTask, { recursive: true });
  fs.mkdirSync(twinEpic, { recursive: true });
  const twinBridge = stubHerdr(
    ['crabcast-task-kan-88', 'crabcast-epic-kan-88'],
    { workDirs: { 'crabcast-task-kan-88': twinTask, 'crabcast-epic-kan-88': twinEpic } }
  );
  const twins = newRouter(twinBridge, seedOf(
    ['crabcast-task-kan-88', 'crabcast-epic-kan-88'],
    { 'crabcast-task-kan-88': twinTask, 'crabcast-epic-kan-88': twinEpic }
  ));

  await quiet(async () => twins.router.handle({ action: 'reset_by_key', type: 'task', key: 'KAN-88' }));
  const taskIntent = twins.agentRegistry.intents().get('crabcast-task-kan-88');
  const epicIntent = twins.agentRegistry.intents().get('crabcast-epic-kan-88');
  const twinCensus = list(twins.router, twins.sent).agents.map((a) => a.agentName);
  console.log(`  after reset task/KAN-88: census = [${twinCensus.join(', ')}]`);
  console.log(`  registry: task=${taskIntent.event}, epic=${epicIntent.event}`);

  verdict(
    taskIntent.event === 'deactivated' &&
      epicIntent.event === 'activated' &&
      !twinCensus.includes('crabcast-task-kan-88') &&
      twinCensus.includes('crabcast-epic-kan-88'),
    'the addressed agent was torn down and recorded; its key-twin of another type\n' +
    '    was neither touched nor written about.',
    `reset crossed types: task=${taskIntent.event} epic=${epicIntent.event} census=${twinCensus.join(',')}`
  );
}

// ------------------------------------------------------------ 8. durability --
rule('8. DURABILITY IS REPORTED — a registry that cannot be written says so');

{
  const workDir = path.join(WORKSPACES, 'task', 'kan-90');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr([], { workDirs: { 'crabcast-task-kan-90': workDir } });

  // A registry whose directory refuses writes: the append's openSync fails,
  // which is what a full or read-only data dir looks like from here.
  const sealedDir = path.join(TMP, 'sealed');
  fs.mkdirSync(sealedDir, { recursive: true });
  fs.chmodSync(sealedDir, 0o500);
  const events = [];
  let last;
  const router = new MessageRouter({
    registry,
    config,
    promptLoader: prompts,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry: new AgentRegistry(path.join(sealedDir, 'agents.jsonl')),
    send: (msg) => { last = msg; },
    broadcast: (msg) => events.push(msg)
  });

  const res = await quiet(async () => {
    let out;
    await router.handleActivateByKey(
      { type: 'task', key: 'KAN-90', defaultAgent: 'claude', ...PAST_THE_GATE },
      (msg) => { out = msg; }
    );
    return out;
  });
  fs.chmodSync(sealedDir, 0o755); // so cleanup can remove the scratch

  const degraded = events.find((e) => e.action === 'registry_degraded_event');
  console.log('the agent exists and is verified — but the disk does not know it, and that');
  console.log('gap must be somebody\'s to act on rather than a line in a log nobody reads:\n');
  console.log(`  activate_by_key → ${JSON.stringify({ success: res.success, verified: res.verified, durable: res.durable, durabilityError: Boolean(res.durabilityError) })}`);
  console.log(`  broadcast: ${JSON.stringify(degraded && { action: degraded.action, what: degraded.what })}`);

  verdict(
    res.success === true &&
      res.verified === true &&
      res.durable === false &&
      typeof res.durabilityError === 'string' &&
      Boolean(degraded) &&
      /re-issue|restart/i.test(degraded.consequence ?? ''),
    'the activation is honest twice over: success because the agent provably lives,\n' +
    '    durable: false because a restart will not know it — and every connected client\n' +
    '    heard the registry degrade.',
    `the write failure was swallowed: ${JSON.stringify({ durable: res.durable, degraded: Boolean(degraded) })}`
  );
}

// ------------------------------------------------------- 9. compaction (B5) --
rule('9. COMPACTION KEEPS THE WAY BACK — KAN-88 finding B5');

{
  console.log('Compaction rewrote the log as one `activated` record per expected agent, which');
  console.log('silently emptied the standby list the moment the 501st record landed: every');
  console.log('agent a person had switched off stopped being offered a way back, while its');
  console.log('workspace — and the conversation in it — sat on disk. That was never decided,');
  console.log('it is what dropping `deactivated` records happened to do. It is decided now:');
  console.log('standby records travel (bounded by "workspace still exists" and by a cap),');
  console.log('preemption annotations still do not.\n');

  const logPath = path.join(TMP, 'compaction.jsonl');
  const reg = new AgentRegistry(logPath);

  // One agent switched off with its workspace intact — the row a client's On
  // button is built from.
  const keptDir = path.join(WORKSPACES, 'compact', 'kept');
  fs.mkdirSync(keptDir, { recursive: true });
  const kept = { agentName: 'crabcast-task-kept', type: 'task', key: 'KEPT', workDir: keptDir, defaultAgent: 'claude' };
  reg.recordActivated(kept);
  reg.recordDeactivated(kept);

  // One switched off whose workspace is gone — `reset` looks like this, and
  // re-activating it would make an empty directory and start an agent in it.
  const goneDir = path.join(WORKSPACES, 'compact', 'gone');
  const gone = { agentName: 'crabcast-task-gone', type: 'task', key: 'GONE', workDir: goneDir, defaultAgent: 'claude' };
  reg.recordActivated(gone);
  reg.recordDeactivated(gone);

  // One preempted, workspace intact: the annotation is the deliberate loss,
  // the route back is not.
  const preemptedDir = path.join(WORKSPACES, 'compact', 'preempted');
  fs.mkdirSync(preemptedDir, { recursive: true });
  const victim = { agentName: 'crabcast-task-victim', type: 'task', key: 'VICTIM', workDir: preemptedDir, defaultAgent: 'claude' };
  reg.recordActivated(victim);
  reg.recordDeactivated(victim, {
    byAgentName: 'crabcast-epic-boss', byType: 'epic', byKey: 'BOSS', byPriority: 10,
    priority: 1, herdrStatus: 'working', derivation: 'at capacity'
  });

  // One still expected, so the activated half is provably untouched.
  const liveDir = path.join(WORKSPACES, 'compact', 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  reg.recordActivated({ agentName: 'crabcast-task-live', type: 'task', key: 'LIVE', workDir: liveDir, defaultAgent: 'claude' });

  const beforeCompaction = reg.readLog().length;
  const standbyBefore = reg.intents();
  const atBefore = new Map([...standbyBefore].map(([name, i]) => [name, i.at]));
  // A second expected agent recorded a measurable moment later, so "all the
  // carried timestamps collapsed onto one value" is distinguishable from "they
  // were preserved" rather than being a coin flip on clock resolution.
  await new Promise((r) => setTimeout(r, 25));
  const laterDir = path.join(WORKSPACES, 'compact', 'later');
  fs.mkdirSync(laterDir, { recursive: true });
  reg.recordActivated({ agentName: 'crabcast-task-later', type: 'task', key: 'LATER', workDir: laterDir, defaultAgent: 'claude' });
  atBefore.set('crabcast-task-later', reg.intents().get('crabcast-task-later').at);
  await new Promise((r) => setTimeout(r, 25));
  reg.compact();
  const after = reg.readLog();
  const intentsAfter = reg.intents();

  console.log(`  records before compaction: ${beforeCompaction}`);
  console.log(`  records after:             ${after.length}`);
  console.log(`  events after: ${JSON.stringify(after.map((e) => `${e.agentName}:${e.event}`))}`);
  console.log(`  preemption annotation survived: ${Boolean(intentsAfter.get('crabcast-task-victim')?.preemption)}`);

  // Through a real router, because "the standby list survived" is a claim
  // about what a client renders, not about the file.
  const bridge = stubHerdr([]);
  let sent9;
  const router9 = new MessageRouter({
    registry, config, promptLoader: prompts, herdrBridge: bridge,
    daemonStartedAt: new Date(), agentRegistry: reg,
    send: (msg) => { sent9 = msg; }, broadcast: () => {}
  });
  router9.handle({ action: 'list_agents' });
  const standbyNames = sent9.standbyAgents.map((a) => a.agentName);
  console.log(`\n  standbyAgents after compaction: ${JSON.stringify(standbyNames)}`);
  console.log(`  expected() after compaction:    ${JSON.stringify(reg.expected().map((r) => r.agentName))}`);
  console.log(`  preemptedAgents after:          ${JSON.stringify(sent9.preemptedAgents.map((a) => a.agentName))}`);

  verdict(
    standbyBefore.get('crabcast-task-kept')?.event === 'deactivated' &&
      standbyNames.includes('crabcast-task-kept'),
    'a stood-down agent whose workspace still exists is still offered a way back after\n' +
    '    compaction — the switch a person turned off is still a switch.',
    `the standby row was lost to compaction: ${JSON.stringify(standbyNames)}`
  );
  verdict(
    !standbyNames.includes('crabcast-task-gone'),
    'a stood-down agent whose workspace is gone is not carried — a reset stays a reset,\n' +
    '    and the bound on what compaction preserves is "the work still exists".',
    'compaction carried a record whose workspace had been deleted'
  );
  verdict(
    !intentsAfter.get('crabcast-task-victim')?.preemption &&
      sent9.preemptedAgents.length === 0 &&
      standbyNames.includes('crabcast-task-victim'),
    'a preempted agent keeps the deliberate half of the old behaviour — the debt stops\n' +
    '    being reported past 500 records — while the route back to its work survives.',
    'the preemption annotation outlived compaction, or the victim lost its way back'
  );
  verdict(
    reg.expected().map((r) => r.agentName).sort().join() === 'crabcast-task-later,crabcast-task-live' &&
      after.length < beforeCompaction + 1,
    'and compaction still compacts: the expected fleet is exactly what it was, in fewer\n' +
    '    records than it took to get here.',
    `compaction changed the expected fleet or did not shrink the log`
  );

  // -- 9b. carried records keep their own `at` (KAN-88 round-2 blocker 1) ------
  //
  // Compaction used to stamp every carried `activated` record with the time of
  // the compaction. That is not a cosmetic loss: `missingAgents` reports it as
  // `since`, and the reporting path sorts newest-first before clipping at 25 —
  // so one shared timestamp turns that sort into an all-ties comparison and
  // the clip hides an arbitrary twenty-five instead of the oldest ones. The
  // ordering guarantee the clip rests on only exists if the timestamps are
  // real.
  console.log('\n  9b. carried records keep the timestamp of the event, not of the compaction:\n');
  const atAfter = new Map([...intentsAfter].map(([name, i]) => [name, i.at]));
  for (const name of ['crabcast-task-live', 'crabcast-task-later', 'crabcast-task-kept', 'crabcast-task-victim']) {
    console.log(`  ${name}: before=${atBefore.get(name)} after=${atAfter.get(name)}`);
  }
  const preserved = ['crabcast-task-live', 'crabcast-task-later', 'crabcast-task-kept', 'crabcast-task-victim']
    .every((name) => atBefore.get(name) === atAfter.get(name));
  const activatedStamps = new Set(
    ['crabcast-task-live', 'crabcast-task-later'].map((name) => atAfter.get(name))
  );
  console.log(`  distinct timestamps among the two expected agents after compaction: ${activatedStamps.size}`);
  verdict(
    preserved && activatedStamps.size === 2,
    'every carried record kept its own `at` — so `since` still says when the agent was\n' +
    '    activated, and the newest-first clip is still an ordering rather than a tie.',
    `compaction rewrote timestamps: preserved=${preserved}, distinct=${activatedStamps.size}`
  );

  // -- 9c. an ex-preempted row does not claim somebody chose it ---------------
  //
  // Dropping the debt is the decision this file already argued for. Asserting
  // that a person switched the agent off is a different thing entirely: its
  // work was taken to make room, and the row a human reads must not say
  // otherwise just because the annotation naming the taker has been compacted
  // away.
  console.log('\n  9c. the carried ex-preempted row says what actually happened to it:\n');
  const victimRow = sent9.standbyAgents.find((a) => a.agentName === 'crabcast-task-victim');
  const keptRow = sent9.standbyAgents.find((a) => a.agentName === 'crabcast-task-kept');
  console.log(`  victim: wasPreempted=${victimRow?.wasPreempted} reason=${JSON.stringify(victimRow?.reason)}`);
  console.log(`  kept:   wasPreempted=${keptRow?.wasPreempted} reason=${JSON.stringify(keptRow?.reason)}`);
  verdict(
    victimRow?.wasPreempted === true &&
      !/[Ss]witched off deliberately/.test(victimRow?.reason ?? '') &&
      /free capacity/.test(victimRow?.reason ?? '') &&
      keptRow?.wasPreempted === undefined &&
      /[Ss]witched off deliberately/.test(keptRow?.reason ?? ''),
    'the ex-preempted row carries wasPreempted and a reason describing a slot that was\n' +
    '    taken; the genuinely switched-off row is unchanged. One list, two honest rows.',
    `a carried row misdescribes how its work stopped: ${JSON.stringify({ victim: victimRow?.reason, kept: keptRow?.reason })}`
  );
}

// --------------------------------------------------- 10. mcpServers (B6) --
rule('10. A CHANGED SERVER LIST IS RE-RECORDED — KAN-88 finding B6');

{
  console.log('rememberActivated skips a restatement when the disk already knows exactly this');
  console.log('activation — workDir, url, defaultAgent were compared, and mcpServers was not.');
  console.log('So an agent whose type gained an MCP server in the config was still "exactly');
  console.log('this", the restatement was skipped, and a restart brought it back with the');
  console.log('server list it had the first time anyone ever activated it.\n');

  const typeWith = (servers) => ({
    ...config.workspaceTypes.find((t) => t.name === 'task'),
    mcpServers: servers
  });
  const routerFor = (servers, agentRegistry, bridge) => {
    let last;
    const router = new MessageRouter({
      registry: new WorkspaceRegistry([
        config.workspaceTypes.find((t) => t.name === 'epic'),
        typeWith(servers)
      ]),
      config, promptLoader: prompts, herdrBridge: bridge,
      daemonStartedAt: new Date(), agentRegistry,
      send: (msg) => { last = msg; }, broadcast: () => {}
    });
    return { router, sent: () => last };
  };

  const agentRegistry = new AgentRegistry(path.join(TMP, 'mcpservers.jsonl'));
  const bridge = stubHerdr([]);
  const activate = async (servers) => {
    const { router } = routerFor(servers, agentRegistry, bridge);
    await quiet(async () => {
      await router.handleActivateByKey({ type: 'task', key: 'KAN-91', ...PAST_THE_GATE }, () => {});
    });
    return agentRegistry.readLog().length;
  };

  const afterFirst = await activate(['crabcast']);
  const afterSame = await activate(['crabcast']);
  const afterChanged = await activate(['crabcast', 'extra-server']);
  const recorded = agentRegistry.intents().get('crabcast-task-kan-91')?.record.mcpServers;

  console.log(`  activate with mcpServers ['crabcast']              → ${afterFirst} record(s)`);
  console.log(`  re-activate, list unchanged                        → ${afterSame} record(s) (restatement skipped)`);
  console.log(`  re-activate after the config gained a server       → ${afterChanged} record(s)`);
  console.log(`  what a restart would replay: ${JSON.stringify(recorded)}`);

  verdict(
    afterSame === afterFirst,
    'an unchanged re-activation still writes nothing — the dedupe that keeps fleet clients\n' +
    '    from filling the log with restatements is intact.',
    `an unchanged re-activation appended a record: ${afterFirst} → ${afterSame}`
  );
  verdict(
    afterChanged > afterSame &&
      JSON.stringify(recorded) === JSON.stringify(['crabcast', 'extra-server']),
    'a changed server list IS re-recorded, so a restart replays the list the config\n' +
    '    actually declares rather than the one this agent first started with.',
    `the changed list was not recorded: ${afterSame} → ${afterChanged}, recorded ${JSON.stringify(recorded)}`
  );
}

// -------------------------------------------------- 11. short writes (B7) --
rule('11. A SHORT WRITE IS NOT SILENTLY A TORN RECORD — KAN-88 finding B7');

{
  console.log('fs.writeSync returns how much it wrote and is under no obligation for that to');
  console.log('be everything — a full disk, a quota edge or a signal can stop it part way.');
  console.log('Both registry write paths discarded that number, which made a short write');
  console.log('indistinguishable from a complete one: an fsync and a success over half a');
  console.log('record on the append path, and a truncated file renamed over the whole log on');
  console.log('the compaction path.\n');
  console.log('Proven in a child process that injects a short writeSync before importing the');
  console.log('registry — the same shape as this suite\'s herdr shim: the code under test is');
  console.log('real, one syscall is not.\n');

  const child = path.join(TMP, 'short-write-child.mjs');
  fs.writeFileSync(child, `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fsCjs = require('fs');
const realWriteSync = fsCjs.writeSync;

// mode 'partial': every call writes at most 7 bytes, so a record takes many
// calls and a caller that trusted one call would truncate it.
// mode 'stuck':   every call writes 0 — no progress is possible.
const mode = process.argv[3];
fsCjs.writeSync = (fd, data, ...rest) => {
  if (mode === 'stuck') return 0;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const offset = typeof rest[0] === 'number' ? rest[0] : 0;
  const length = typeof rest[1] === 'number' ? rest[1] : buf.length - offset;
  return realWriteSync(fd, buf, offset, Math.min(7, length));
};

// Imported AFTER the patch so the registry's own fs namespace picks it up.
const { AgentRegistry } = await import(process.argv[2]);

const file = process.argv[4];
const reg = new AgentRegistry(file);
const record = {
  agentName: 'crabcast-task-shortwrite', type: 'task', key: 'SHORTWRITE',
  workDir: '/tmp/kan88-shortwrite', defaultAgent: 'claude'
};
const outcome = reg.record('activated', record);
const raw = realWriteSync ? fsCjs.readFileSync(file, 'utf8') : '';
process.stdout.write(JSON.stringify({
  outcome,
  raw,
  parsedAgents: reg.readLog().map((e) => e.agentName)
}));
`);

  const { spawnSync } = await import('child_process');
  const run = (mode, file) => {
    const res = spawnSync(
      process.execPath,
      [child, path.join(distDir, 'agent-registry.js'), mode, file],
      { encoding: 'utf8', timeout: 20000 }
    );
    return JSON.parse(res.stdout || '{}');
  };

  const partial = run('partial', path.join(TMP, 'shortwrite-partial.jsonl'));
  const stuck = run('stuck', path.join(TMP, 'shortwrite-stuck.jsonl'));

  console.log(`  writeSync capped at 7 bytes/call:`);
  console.log(`    record() → ${JSON.stringify(partial.outcome)}`);
  console.log(`    file holds: ${JSON.stringify(partial.raw)}`);
  console.log(`    readable records: ${JSON.stringify(partial.parsedAgents)}`);
  console.log(`  writeSync making no progress at all:`);
  console.log(`    record() → ${JSON.stringify(stuck.outcome)}`);
  console.log(`    file holds: ${JSON.stringify(stuck.raw)}`);

  verdict(
    partial.outcome?.ok === true &&
      partial.parsedAgents?.length === 1 &&
      partial.raw?.endsWith('\n'),
    'a write that stops part way is finished rather than fsynced half-written — the record\n' +
    '    on disk is complete and readable.',
    `the partial write left a torn record: ${JSON.stringify(partial)}`
  );
  verdict(
    stuck.outcome?.ok === false && /short write/.test(stuck.outcome?.error ?? ''),
    'a write that cannot make progress is reported — ok: false naming the short write, which\n' +
    '    is what becomes durable: false and the degraded-registry broadcast (section 8).',
    `a stuck write claimed success: ${JSON.stringify(stuck.outcome)}`
  );
  verdict(
    (stuck.parsedAgents ?? []).length === 0,
    'and it left nothing readable behind pretending to be a record.',
    `a stuck write left a phantom record: ${JSON.stringify(stuck.parsedAgents)}`
  );
}

// ------------------------------------------- 12. one read, one cap (B9) --
rule('12. ONE REGISTRY READ PER POLL, AND ALL THREE CATEGORIES CAPPED — KAN-88 finding B9');

{
  console.log('list_agents asked the registry four separate times per poll — missing,');
  console.log('preempted, standby and the priority list each re-read and re-parsed the whole');
  console.log('log. That is four whole-file parses on a client that polls continuously, and');
  console.log('four *different* reads: an append landing between them produced one response');
  console.log('whose own categories disagreed about the same agent.\n');
  console.log('And of the three registry-derived lists, only standby was capped — so the');
  console.log('fleet that had lost forty agents was exactly the one whose response grew');
  console.log('without limit.\n');

  const N = 30;
  const reg = new AgentRegistry(path.join(TMP, 'capping.jsonl'));
  const mkDir = (name) => {
    const dir = path.join(WORKSPACES, 'cap', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  for (let i = 0; i < N; i++) {
    // missing: last word `activated`, and herdr will not have it.
    reg.recordActivated({
      agentName: `crabcast-task-miss-${i}`, type: 'task', key: `MISS-${i}`,
      workDir: mkDir(`miss-${i}`), defaultAgent: 'claude'
    });
    // standby: deliberately off, workspace on disk.
    const standby = {
      agentName: `crabcast-task-standby-${i}`, type: 'task', key: `STANDBY-${i}`,
      workDir: mkDir(`standby-${i}`), defaultAgent: 'claude'
    };
    reg.recordActivated(standby);
    reg.recordDeactivated(standby);
    // preempted: a debt.
    const victim = {
      agentName: `crabcast-task-victim-${i}`, type: 'task', key: `VICTIM-${i}`,
      workDir: mkDir(`victim-${i}`), defaultAgent: 'claude'
    };
    reg.recordActivated(victim);
    reg.recordDeactivated(victim, {
      byAgentName: 'crabcast-epic-boss', byType: 'epic', byKey: 'BOSS', byPriority: 10,
      priority: 1, herdrStatus: 'working', derivation: 'at capacity'
    });
  }

  // A registry that counts what the response actually costs. Every one of
  // these entry points reads and parses the whole log once — `intents` and
  // `preempted` both go through `readLog` — so the tally is the number of
  // whole-file parses this one response paid for.
  const reads = { readLog: 0, intents: 0, preempted: 0 };
  const counting = new Proxy(reg, {
    get(target, prop, receiver) {
      if (prop in reads) {
        reads[prop]++;
        return target[prop].bind(target);
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  const bridge = stubHerdr([]);
  let sent12;
  const router12 = new MessageRouter({
    registry, config, promptLoader: prompts, herdrBridge: bridge,
    daemonStartedAt: new Date(), agentRegistry: counting,
    send: (msg) => { sent12 = msg; }, broadcast: () => {}
  });

  const records = reg.readLog().length;
  reads.readLog = 0;
  reads.intents = 0;
  reads.preempted = 0;
  router12.handle({ action: 'list_agents' });
  const wholeLogReads = reads.readLog + reads.intents + reads.preempted;

  console.log(`  seeded: ${N} missing, ${N} preempted, ${N} standby (${records} records)`);
  console.log(`  whole-log reads for one list_agents response: ${wholeLogReads} ${JSON.stringify(reads)}`);
  console.log(`  missingAgents   ${sent12.missingAgents.length} of missingTotal ${sent12.missingTotal}`);
  console.log(`  preemptedAgents ${sent12.preemptedAgents.length} of preemptedTotal ${sent12.preemptedTotal}`);
  console.log(`  standbyAgents   ${sent12.standbyAgents.length} of standbyTotal ${sent12.standbyTotal}`);
  console.log(`  newest first: missing[0]=${sent12.missingAgents[0].agentName} since ${sent12.missingAgents[0].since}`);

  verdict(
    wholeLogReads === 1,
    'one read of the log for the whole response — so it costs one parse, and every category\n' +
    '    in it is describing the same instant.',
    `the response read the log ${wholeLogReads} time(s): ${JSON.stringify(reads)}`
  );
  verdict(
    sent12.missingAgents.length === 25 && sent12.missingTotal === N &&
      sent12.preemptedAgents.length === 25 && sent12.preemptedTotal === N &&
      sent12.standbyAgents.length === 25 && sent12.standbyTotal === N,
    'all three registry-derived categories cap at the same 25 and report the unclipped\n' +
    '    total, so no list can silently read as "that is all of them".',
    `capping is still inconsistent: ${JSON.stringify({
      missing: sent12.missingAgents.length, missingTotal: sent12.missingTotal,
      preempted: sent12.preemptedAgents.length, preemptedTotal: sent12.preemptedTotal,
      standby: sent12.standbyAgents.length, standbyTotal: sent12.standbyTotal
    })}`
  );
  const descending = (rows, field) =>
    rows.every((row, i) => i === 0 || rows[i - 1][field] >= row[field]);
  verdict(
    descending(sent12.missingAgents, 'since') &&
      descending(sent12.preemptedAgents, 'at') &&
      descending(sent12.standbyAgents, 'since'),
    'and what is kept is the newest of each — clipping an unordered list would hide an\n' +
    '    arbitrary subset; clipping a newest-first one hides the least urgent.',
    'a clipped category was not ordered newest-first'
  );

  // -- 12b. the sweep reads the UNCAPPED list ---------------------------------
  //
  // The one invariant here whose regression is silent. `list_agents` is a
  // report and clipping it costs a reader the tail of a list they can see the
  // total of; the daemon's 30s missing-sweep is not a report, it is the thing
  // that announces a loss — exactly once, latched — so an agent that fell
  // past position 25 in a clipped sweep would never be announced at all, and
  // nothing anywhere would say so. It was protected by code reading alone
  // until now.
  console.log('\n  12b. the daemon\'s missing-sweep is not the report, and must not be clipped:\n');
  const swept = router12.findMissingAgents();
  const sweptNames = new Set(swept.map((row) => row.agentName));
  const reportedNames = new Set(sent12.missingAgents.map((row) => row.agentName));
  const onlyInSweep = [...sweptNames].filter((name) => !reportedNames.has(name));
  console.log(`  findMissingAgents() returned ${swept.length}; list_agents reported ${sent12.missingAgents.length} of ${sent12.missingTotal}`);
  console.log(`  agents the sweep can announce that the clipped report omits: ${onlyInSweep.length}`);

  verdict(
    swept.length === N &&
      swept.length === sent12.missingTotal &&
      onlyInSweep.length === N - 25,
    'the sweep sees every missing agent, including the five the response clipped — so a\n' +
    '    loss past position 25 is still announced rather than silently never reported.',
    `the sweep is clipped too: ${swept.length} of ${N} (that is an agent nobody is ever told about)`
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
