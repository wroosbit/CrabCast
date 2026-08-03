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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
