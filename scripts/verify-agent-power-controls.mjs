// Ported from the extraction source's KAN-38 proof, and re-keyed onto the path
// by KAN-124: a fleet client can make an agent exist, switch it off and back
// on, and make it stop existing — and every way that could go wrong has an
// answer rather than a discovery.
//
// Sections:
//
//   0. configure    — the verb that makes an agent exist, and what it refuses:
//                     a missing priority or launcher, a directory that is not
//                     there, and an incoherent gate triple
//   1. off          — the message a client sends, and the agent gone from the census
//   2. on           — where the On candidates come from, and the agent back
//   3. the record   — why a stand-down has to carry the whole configuration
//   4. preempted    — a preemption is a debt: reported until re-activation,
//                     disjoint from standby, and re-activation is a resume;
//                     4b: a failed teardown writes nothing; 4c: the debt list
//                     is census-cross-checked like every category
//   5. already gone — standing down an agent that already died records the
//                     intent and reports success, not failure
//   6. poll churn   — a census position is not an identity across polls
//   7. forget       — the verb that replaced `reset`: it removes the RECORD and
//                     no directory, refuses while the agent runs, and succeeds
//                     on a path that never held one; 7b: a deleted directory is
//                     not offered a way back
//   8. durability   — a registry that cannot be written answers durable: false
//                     and broadcasts the degradation, instead of hiding it
//                     behind verified: true
//   9. compaction   — carries the standby rows whose directory still exists,
//                     AND the `configured` rows that are the agents themselves
//                     (KAN-124 AC 6); 9b: carried records keep their own `at`;
//                     9c: an ex-preempted row does not claim somebody chose it
//  10. restatement  — an activation that changes nothing writes nothing, and one
//                     that re-binds a pane does
//  11. short writes — a write that stops part way is finished, and one that
//                     cannot progress is reported instead of fsynced
//  12. one read     — one whole-log read per list_agents poll, all categories
//                     capped with totals; 12b: the daemon's missing-sweep reads
//                     the UNCAPPED list
//  13. collision    — two agents that would have collided on a shared key
//                     coexist, and the ambiguity that used to decide between
//                     them is GONE rather than merely unreached (AC 3)
//  14. one read     — one whole-log read per COMPACTION, which happens inside
//                     record() and therefore on the path an activation waits
//                     on; 14b: the pre-fix shape restored, and the count goes
//                     to four (KAN-96 AC 1)
//  15. what "newest — `missingAgents` is ordered by the ACTIVATION timestamp,
//      first" means    and nothing on the row records when the agent went
//                      missing, which is why that order is not a neglect
//                      ranking and is not flipped (KAN-96 AC 2); 15b: the
//                      comparator flipped, and §15 going red; 15c: the durable
//                      first-observed-missing field BUILT as a mutant — it
//                      works, it survives a restart, deleting its store breaks
//                      that survival, and the shipped build keeps nothing.
//                      That is what makes "no" a decision rather than a
//                      limitation (KAN-189)
//
// Every section drives the real MessageRouter, a real config through the real
// loader, and a real on-disk AgentRegistry, so what it prints is what a caller
// actually receives and what is actually written to the log. Only herdr is
// stubbed — and the stub is a REAL HerdrBridge with its herdr-touching methods
// replaced, so `occupancyOf` and the three-fact binding under test here are the
// shipping implementations rather than a re-statement of them.
//
// WHAT CHANGED FROM THE TYPE MODEL, so a reviewer can see nothing was weakened:
//   * every address is a directory, so the fixtures make real directories
//   * `gateExempt` on a row became the three flags it was always conflating
//   * section 7 tested `reset`; `reset` is removed, so it tests `forget`, which
//     is a strictly stronger claim — `reset` deleted a directory and `forget`
//     refuses to
//   * section 10 tested that a changed mcpServers list was re-recorded. That
//     drift is now impossible by construction (see the section) so it tests the
//     invariant that replaced it.
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
 * capacity gate reads the real machine — cores, memory, and a one-minute load
 * average that moves while this script runs — and this script is about the
 * registry's power controls, not the gate: a proof that passes on a quiet
 * machine and fails on a busy one proves nothing either way. The override path
 * is itself real and recorded; the gate has its own proof in
 * verify-agent-capacity.mjs.
 */
const PAST_THE_GATE = { override: true };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan38-'));
const OWNED = path.join(TMP, 'owned');
let registryFile = 0;

// A real config through the real loader. It declares a dataDir and nothing
// else: there is no type table left to declare, which is the whole of KAN-124's
// deletion seen from a config file.
const dataDir = path.join(TMP, 'data');
const configPath = path.join(TMP, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor, canonicalizeOrNull } = await import(path.join(distDir, 'identity.js'));

const config = loadConfig(configPath);

// §14b mutates a copy of the compiled build. Through the shared helper, so a
// drifted anchor is a counted failure that names itself rather than a throw
// that takes every later section with it (KAN-138).
const { makeMutator } = await import('./mutation.mjs');
const MUTANTS = path.join(TMP, 'mutants');
// A mutant is a copy of dist/ under a scratch directory, so a bare import in it
// — `node-pty`, out of herdr.js, which router.js pulls in — resolves by walking
// up from HERE and finds nothing. Without this the mutant dies on startup, and
// a mutant that died on startup produces the same observation as one that
// behaved well. verify-fleet-enumeration.mjs §8 does the same thing for the
// same reason.
fs.mkdirSync(MUTANTS, { recursive: true });
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(MUTANTS, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}
const { mutate } = makeMutator({
  distDir,
  scratch: MUTANTS,
  report: {
    // The helper composes its own label and diagnosis; this adapter passes
    // them through rather than re-wrapping them, so the sentence a reader sees
    // is the one mutation.mjs pins ("Fix the mutation, not this check.").
    pass: (label, detail) => console.log(`  ${label}${detail ? `\n    ${detail}` : ''}`),
    fail: (label, detail) => verdict(false, '', `${label}\n    ${detail}`)
  }
});

/** A directory the caller already owns. Every address in this file is one. */
function owned(...parts) {
  const dir = path.join(OWNED, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** The knobs a caller freezes onto an agent. `configure` requires the first two. */
const knobs = (over = {}) => ({
  priority: 1,
  refusable: true,
  chargeable: true,
  preemptable: true,
  launcher: 'claude',
  ...over
});

// ------------------------------------------------------------- the harness --

/**
 * A herdr that reports exactly the agents it is told to and forgets one when
 * its pane is closed, so a census taken after a stand-down is the fleet as it
 * then is rather than a reconstruction.
 *
 * It is a REAL HerdrBridge with the methods that shell out to herdr replaced.
 * That matters: `occupancyOf` — the three-fact binding and the occupancy test
 * `activate` refuses on — stays the shipping implementation, reading the census
 * this stub hands it. A hand-written stand-in for that logic would be a second
 * copy of the rule, and the copy is the one that is wrong.
 */
function stubHerdr(running, { statuses = {}, closeFails = false } = {}) {
  // `running` is a list of directories. The pane name and pane id are derived
  // the way the real ones are, so nothing here can drift from identity.ts.
  const alive = running.map((dir) => ({ path: dir, paneId: `%${paneNameFor(dir).slice(-4)}` }));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);

  bridge.alive = alive;
  bridge.spawns = [];
  bridge.closed = [];

  bridge.listHerdrAgentsChecked = () => ({
    reachable: true,
    agents: alive.map((a) => ({
      name: paneNameFor(a.path),
      paneId: a.paneId,
      agentRuntime: 'claude',
      workDir: a.path,
      canonicalWorkDir: canonicalizeOrNull(a.path),
      herdrStatus: statuses[a.path] ?? 'working'
    }))
  });
  bridge.listHerdrAgents = () => bridge.listHerdrAgentsChecked().agents;
  bridge.listHerdrStatuses = () =>
    new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus]));

  // The post-spawn existence check, answered from the same list the census is
  // built from — which is the rule the real one follows.
  bridge.confirmAgentPresent = async (paneName) => {
    const found = alive.find((a) => paneNameFor(a.path) === paneName);
    return found
      ? { present: true, paneId: found.paneId, waitedMs: 0, checks: 1 }
      : {
          present: false, reason: 'absent', waitedMs: 0, checks: 1,
          error: `stub herdr has no agent '${paneName}'`
        };
  };

  bridge.abandonSession = () => {};
  bridge.listActiveSessions = () => [];
  bridge.getSessionByPath = () => undefined;
  bridge.terminateSession = () => ({ success: true });

  bridge.closeAgentByPath = (agentPath) => {
    const paneName = paneNameFor(agentPath);
    if (closeFails) return { success: false, paneName, error: `No agent at '${agentPath}'` };
    const i = alive.findIndex((a) => a.path === agentPath);
    if (i === -1) return { success: false, paneName, error: `No agent at '${agentPath}'` };
    alive.splice(i, 1);
    bridge.closed.push(agentPath);
    return { success: true, paneName };
  };

  bridge.tailAgent = () => ({ success: true, text: 'bypass permissions on\n❯ ' });
  bridge.sendToAgent = async () => ({ success: true });

  bridge.spawnSession = (agentPath, agentConfig, prompt, resume) => {
    bridge.spawns.push({ path: agentPath, config: agentConfig, prompt, resume });
    const paneId = `%${paneNameFor(agentPath).slice(-4)}`;
    alive.push({ path: agentPath, paneId });
    return {
      sessionId: `${paneNameFor(agentPath)}-stub`,
      path: agentPath,
      paneName: paneNameFor(agentPath),
      createdAt: new Date(),
      status: 'active',
      ptyBuffer: '',
      onDataListeners: [],
      // What the real spawnSession sets on a resume; resumedConversation stays
      // false so the fire-and-forget nudge has nothing to do here.
      ...(resume ? { resume, resumedConversation: false } : {})
    };
  };

  return bridge;
}

function newRouter(bridge, seed = []) {
  const events = [];
  let last;
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFile}.jsonl`));
  for (const record of seed) agentRegistry.recordActivated(record);
  const router = new MessageRouter({
    config,
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

/**
 * An `activated` seed row: the durable record of an agent that is running,
 * bound to the pane the stub census will report for it.
 */
const seedOf = (dirs, over = {}) =>
  dirs.map((dir) => ({
    path: dir,
    config: knobs(over),
    paneId: `%${paneNameFor(dir).slice(-4)}`
  }));

// ------------------------------------------------------------ 0. configure --
rule('0. CONFIGURE — the verb that makes an agent exist, and what it refuses');

{
  console.log(
    'There is no workspace type to inherit from any more, so every required knob\n' +
    'arrives in this call or nowhere. The refusals below are the ones the deleted\n' +
    'config loader used to make at daemon boot — they did not vanish with it, they\n' +
    'moved to the caller who made the mistake.\n'
  );

  const dir = owned('configure', 'ok');
  const bridge = stubHerdr([]);
  const { router, agentRegistry, events, sent } = newRouter(bridge);

  const missing = await quiet(async () => {
    router.handle({ action: 'configure_agent', path: dir });
    return sent();
  });
  console.log(`  configure with no knobs at all → ${JSON.stringify({ success: missing.success, missing: missing.missing })}`);
  console.log(`    ${missing.error}\n`);

  const badPriority = await quiet(async () => {
    router.handle({ action: 'configure_agent', path: dir, priority: 'high', launcher: 'claude' });
    return sent();
  });
  console.log(`  priority: 'high' → ${JSON.stringify({ success: badPriority.success })}`);
  console.log(`    ${badPriority.error}\n`);

  const badLauncher = await quiet(async () => {
    router.handle({ action: 'configure_agent', path: dir, priority: 1, launcher: 'clade' });
    return sent();
  });
  console.log(`  launcher: 'clade' → ${JSON.stringify({ success: badLauncher.success })}`);
  console.log(`    ${badLauncher.error}\n`);

  const noDir = await quiet(async () => {
    router.handle({ action: 'configure_agent', path: path.join(OWNED, 'thign'), ...knobs() });
    return sent();
  });
  console.log(`  a directory that is not there → ${JSON.stringify({ success: noDir.success })}`);
  console.log(`    ${noDir.error}\n`);

  // The cross-field rule, which used to fail a daemon BOOT — in front of
  // whoever restarted it, long after whoever wrote the mistake had gone.
  const incoherent = await quiet(async () => {
    router.handle({
      action: 'configure_agent', path: dir, priority: 1, launcher: 'claude',
      chargeable: false, preemptable: true
    });
    return sent();
  });
  console.log(`  chargeable: false with preemptable: true → ${JSON.stringify({ success: incoherent.success })}`);
  console.log(`    ${incoherent.error}\n`);

  // The shorthand, and the refusal that keeps it from being ambiguous.
  const bothForms = await quiet(async () => {
    router.handle({
      action: 'configure_agent', path: dir, priority: 1, launcher: 'claude',
      gateExempt: true, refusable: true
    });
    return sent();
  });
  console.log(`  gateExempt AND an explicit flag → ${JSON.stringify({ success: bothForms.success })}`);
  console.log(`    ${bothForms.error}\n`);

  const ok = await quiet(async () => {
    router.handle({ action: 'configure_agent', path: dir, ...knobs({ label: 'a display label' }) });
    return sent();
  });
  console.log(`  a complete configure → ${JSON.stringify({ success: ok.success, path: ok.path, paneName: ok.paneName })}`);

  const shorthand = await quiet(async () => {
    const other = owned('configure', 'exempt');
    router.handle({ action: 'configure_agent', path: other, priority: 9, launcher: 'claude', gateExempt: true });
    return sent();
  });
  console.log(`  gateExempt: true alone → ${JSON.stringify(shorthand.config)}`);

  const configured = events.find((e) => e.action === 'agent.configured');
  const record = agentRegistry.intents().get(dir);
  console.log(`\n  broadcast: ${configured?.action} for ${configured?.path}`);
  console.log(`  registry:  ${record.event}, and NOT expected to be running: ` +
    `${JSON.stringify(agentRegistry.expected().map((r) => r.path))}`);

  verdict(
    missing.success === false &&
      JSON.stringify(missing.missing) === JSON.stringify(['priority', 'launcher']) &&
      badPriority.success === false && badLauncher.success === false &&
      /clade/.test(badLauncher.error) && /claude/.test(badLauncher.error),
    'a configure without priority or launcher is refused NAMING them, and a bad value\n' +
    '    for either is refused naming the value — the loader\'s refusals moved to the\n' +
    '    caller rather than disappearing with it.',
    `a required knob was defaulted: ${JSON.stringify({ missing: missing.missing, prio: badPriority.success, launcher: badLauncher.success })}`
  );
  verdict(
    noDir.success === false && /does not exist/.test(noDir.error) && /never creates a directory/.test(noDir.error),
    'configure may not mkdir, so the filesystem is the typo-checker: a mistyped path is\n' +
    '    refused rather than scattered through the caller\'s tree.',
    `configure accepted a path that does not exist: ${JSON.stringify(noDir)}`
  );
  verdict(
    incoherent.success === false && /frees nothing/.test(incoherent.error) &&
      bothForms.success === false && /silent decision/.test(bothForms.error),
    'the incoherent gate combination is refused SYNCHRONOUSLY to the caller who wrote it\n' +
    '    (it used to fail a daemon boot), and the shorthand cannot be silently combined\n' +
    '    with the flags it stands for.',
    `the gate triple accepted an incoherent or ambiguous combination`
  );
  verdict(
    ok.success === true &&
      record?.event === 'configured' &&
      agentRegistry.expected().length === 0 &&
      Boolean(configured) &&
      shorthand.config.refusable === false && shorthand.config.chargeable === false &&
      shorthand.config.preemptable === false,
    'a configured agent EXISTS and is not running — it is absent from expected(), so a\n' +
    '    reboot correctly does not start it; and gateExempt expands to all three flags false.',
    `configure did not record the agent correctly: ${JSON.stringify({ event: record?.event, expected: agentRegistry.expected().length })}`
  );

  // And activate refuses a path nobody configured, naming what is missing.
  const unconfigured = owned('configure', 'never');
  const refused = await quiet(async () => {
    let out;
    await router.handleActivate({ path: unconfigured, ...PAST_THE_GATE }, (m) => { out = m; });
    return out;
  });
  console.log(`\n  activate on a never-configured path → ${JSON.stringify({ success: refused.success, refused: refused.refused, missing: refused.missing })}`);
  console.log(`    ${refused.error}`);
  verdict(
    refused.success === false && refused.refused === 'not-configured' &&
      /takes no attributes/.test(refused.error),
    'and `activate` on a path nobody configured refuses NAMING what is missing, rather\n' +
    '    than inventing a priority and a launcher for it.',
    `activate started an unconfigured agent: ${JSON.stringify(refused)}`
  );
}

// ------------------------------------------------------------------ 1. off --
rule('1. OFF — what a client sends, and the agent gone from the census');

{
  const epic = owned('fleet', 'epic-kan-39');
  const taskA = owned('fleet', 'task-kan-38');
  const taskB = owned('fleet', 'task-kan-25');
  const FLEET = [epic, taskA, taskB];

  const bridge = stubHerdr(FLEET);
  const { router, events, sent } = newRouter(bridge, [
    ...seedOf([epic], { chargeable: false, refusable: false, preemptable: false, priority: 10 }),
    ...seedOf([taskA, taskB])
  ]);

  const listed = list(router, sent);
  const before = listed.agents.map((a) => a.path);
  console.log(`census before:\n  ${before.join('\n  ')}\n`);

  const exemptRow = listed.agents.find((a) => a.path === epic);
  const chargedRow = listed.agents.find((a) => a.path === taskA);
  console.log(`rows carry the gate triple from the agent's own record:`);
  console.log(`  ${epic}\n    refusable=${exemptRow.refusable} chargeable=${exemptRow.chargeable} preemptable=${exemptRow.preemptable}`);
  console.log(`  ${taskA}\n    refusable=${chargedRow.refusable} chargeable=${chargedRow.chargeable} preemptable=${chargedRow.preemptable}`);
  console.log(
    '\n(one `gateExempt` boolean used to carry all three, which is only ever right by\n' +
    'coincidence — never-refused, uncharged and unpreemptable are different decisions)\n'
  );

  console.log('a client sends exactly one message — by PATH, because an agent that outlived');
  console.log('the daemon holding its terminal has no session id and is exactly as stoppable,');
  console.log('and because a path cannot be ambiguous the way a key could:\n');
  console.log(`  { action: 'deactivate_agent', path: '${taskA}' }\n`);

  const res = await quiet(async () => {
    router.handle({ action: 'deactivate_agent', path: taskA });
    return sent();
  });
  console.log(`response: ${JSON.stringify({ success: res.success, path: res.path, wasRunning: res.wasRunning, state: res.state })}`);

  const after = list(router, sent).agents.map((a) => a.path);
  console.log(`census after:\n  ${after.join('\n  ')}`);

  const broadcast = events.find((e) => e.action === 'agent.deactivated');
  console.log(`\nbroadcast to every connected client: ${broadcast.action} ${broadcast.path}`);

  verdict(
    res.success === true && res.wasRunning === true && res.state === 'standby' &&
      !after.includes(taskA) && after.length === before.length - 1 &&
      exemptRow.chargeable === false && chargedRow.chargeable === true,
    'the agent is gone from the census a client renders, nothing else moved, and the\n' +
    '    response says WHAT it did — never a bare success: `wasRunning` and `state`\n' +
    '    distinguish an agent this call stopped from one that was already down.',
    `off did not take: success=${res.success} after=${after.join(',')}`
  );
}

// ------------------------------------------------------------------- 2. on --
rule('2. ON — where the candidates come from, and the agent back');

{
  const epic = owned('on', 'epic');
  const task = owned('on', 'task');
  const bridge = stubHerdr([epic, task]);
  const { router, sent } = newRouter(bridge, seedOf([epic, task]));

  console.log(
    'A fleet client lists what is running, and something that is off is not in that\n' +
    'list. So the candidates cannot come from the client. They come from the durable\n' +
    'registry — the only record of activation INTENT this system has — in disjoint\n' +
    'ways; one agent never gets two switches:\n'
  );
  console.log('  missingAgents    last word `activated`, not running    a loss    → restore');
  console.log('  preemptedAgents  stood down for capacity              a debt    → put back');
  console.log('  standbyAgents    stood down because a person said so  a choice  → turn on');
  console.log('\nNo parallel registry is written. All of them are reductions of the same');
  console.log('append-only log that boot-time restoration already reads.\n');

  await quiet(async () => router.handle({ action: 'deactivate_agent', path: task }));
  const off = list(router, sent);
  console.log(`after switching it off, list_agents carries:\n`);
  console.log(JSON.stringify({ standbyAgents: off.standbyAgents, standbyTotal: off.standbyTotal }, null, 2));

  const candidate = off.standbyAgents[0];
  console.log(`\na client sends, from that row — and nothing else, because `);
  console.log(`\`activate\` takes no attributes at all:\n`);
  console.log(`  { action: 'activate_agent', path: '${candidate.path}' }`);

  const res = await quiet(async () => {
    let out;
    await router.handleActivate({ path: candidate.path, ...PAST_THE_GATE }, (msg) => { out = msg; });
    return out;
  });

  const back = list(router, sent);
  console.log(`\nactivate_agent → success: ${res.success}`);
  console.log(`census:     ${back.agents.map((a) => a.path).join(', ')}`);
  console.log(`stood down: ${back.standbyAgents.length === 0 ? '(empty — it left the list the moment it came back)' : back.standbyAgents.map((a) => a.path).join(', ')}`);

  verdict(
    res.success === true &&
      back.agents.some((a) => a.path === task) &&
      back.standbyAgents.length === 0,
    'off and on are a round trip from one client, and the candidate list empties itself\n' +
    '    — an agent that is running is never offered an On button.',
    `the round trip did not close: success=${res.success} standby=${back.standbyAgents.length}`
  );
}

// --------------------------------------------------------------- 3. record --
rule('3. THE RECORD — why a stand-down has to carry the whole configuration');

{
  const dir = owned('record', 'agent');
  const bridge = stubHerdr([dir]);
  const { router, agentRegistry } = newRouter(bridge, [
    {
      path: dir,
      config: knobs({ launcher: 'claude', mcpServers: { crabcast: 'builtin' }, label: 'KAN-38', prompt: 'do the thing' }),
      paneId: '%rec'
    }
  ]);

  await quiet(async () => router.handle({ action: 'deactivate_agent', path: dir }));
  const intent = agentRegistry.intents().get(dir);

  console.log('the stand-down record the registry now holds:\n');
  console.log(`  event:      ${intent.event}`);
  console.log(`  path:       ${intent.record.path}`);
  console.log(`  config:     ${JSON.stringify(intent.record.config)}`);
  console.log(`  paneId:     ${intent.record.paneId}`);

  console.log(
    '\n  Under the type model this record was the argument list of an activation and\n' +
    '  most of it could be looked up again from config if it were lost. It cannot now:\n' +
    '  types are deleted, so this row is the ONLY place this agent\'s priority, launcher,\n' +
    '  gate flags and prompt exist. A stand-down that dropped them would not produce a\n' +
    '  degraded activation — it would produce an agent that cannot be activated at all.'
  );

  await quiet(() => router.handleActivate({ path: dir, ...PAST_THE_GATE }, () => {}));
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  console.log(`\n  switched back on with: launcher=${spawned.config.launcher} ` +
    `mcpServers=${JSON.stringify(spawned.config.mcpServers)} prompt=${JSON.stringify(spawned.prompt)}`);

  verdict(
    intent.record.config.launcher === 'claude' &&
      JSON.stringify(intent.record.config.mcpServers) === JSON.stringify({ crabcast: 'builtin' }) &&
      intent.record.config.prompt === 'do the thing' &&
      intent.record.paneId === '%rec' &&
      spawned.config.launcher === 'claude' &&
      spawned.prompt === 'do the thing',
    'it comes back as what it was, not as something else — and the pane binding travels\n' +
    '    too, so a pane bearing it is still recognisable as OUR dead one rather than a\n' +
    '    stranger\'s live one.',
    `the configuration did not survive the stand-down: ${JSON.stringify(intent.record)}`
  );
}

// ------------------------------------------------------------ 4. preempted --
rule('4. PREEMPTED — a debt, reported until re-activation, and re-activation is a resume');

{
  const victimDir = owned('preempt', 'victim');
  const bridge = stubHerdr([victimDir]);
  const { router, sent } = newRouter(bridge, seedOf([victimDir]));

  // The record the capacity gate's preempt path attaches: why this stand-down
  // was not the agent's own idea.
  const bossDir = owned('preempt', 'boss');
  const preemption = {
    byPath: bossDir,
    byPaneName: paneNameFor(bossDir),
    byPriority: 10,
    priority: 1,
    herdrStatus: 'working',
    derivation: 'cap 2, running 2, incoming priority 10 > 1 — the slot had to come from the lowest-priority agent'
  };

  await quiet(async () =>
    router.handle({ action: 'deactivate_agent', path: victimDir, preemption })
  );

  const listed = list(router, sent);
  const owed = listed.preemptedAgents.find((a) => a.path === victimDir);
  console.log('list_agents now carries the debt:\n');
  console.log(JSON.stringify(listed.preemptedAgents, null, 2));
  console.log(`\ndisjoint from standby (one agent, one switch): standbyAgents = ${JSON.stringify(listed.standbyAgents.map((a) => a.path))}`);

  const res = await quiet(async () => {
    let out;
    await router.handleActivate({ path: victimDir, ...PAST_THE_GATE }, (m) => { out = m; });
    return out;
  });
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  const after = list(router, sent);
  console.log(`\nre-activated: success=${res.success}, and spawnSession was told resume='${spawned.resume}'`);
  console.log(`preemptedAgents after: ${JSON.stringify(after.preemptedAgents)}`);

  verdict(
    Boolean(owed) &&
      owed.by.path === bossDir &&
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

  const survivor = owned('preempt', 'survivor');
  const failBridge = stubHerdr([survivor]);
  // A live session whose teardown fails — the pane stays, the agent works on.
  failBridge.getSessionByPath = () => ({
    sessionId: 'survivor-stub',
    path: survivor,
    paneName: paneNameFor(survivor),
    createdAt: new Date(), status: 'active', ptyBuffer: '', onDataListeners: []
  });
  failBridge.terminateSession = () => ({ success: false, error: 'stub: the pane would not close' });
  const failHarness = newRouter(failBridge, seedOf([survivor]));

  const failed = await quiet(async () => {
    failHarness.router.handle({ action: 'deactivate_agent', path: survivor, preemption });
    return failHarness.sent();
  });
  const survivorIntent = failHarness.agentRegistry.intents().get(survivor);
  const failedList = list(failHarness.router, failHarness.sent);
  console.log(`  deactivate_agent (teardown fails) → ${JSON.stringify({ success: failed.success, error: failed.error })}`);
  console.log(`  registry intent after: ${survivorIntent.event}`);
  console.log(`  preemptedAgents after: ${JSON.stringify(failedList.preemptedAgents)}`);

  verdict(
    failed.success === false &&
      survivorIntent.event === 'activated' &&
      failedList.preemptedAgents.length === 0 &&
      failedList.agents.some((a) => a.path === survivor),
    'the failed stand-down wrote nothing: the survivor is still expected, still\n' +
    '    listed as running, and owed nothing.',
    `a failed teardown left a durable lie: ${JSON.stringify({ success: failed.success, intent: survivorIntent.event, owed: failedList.preemptedAgents.length })}`
  );

  // -- 4c. a record that contradicts the census is not reported as fact --------
  console.log('\n  4c. preemptedAgents is cross-checked against the census, like every category:\n');
  const phantom = owned('preempt', 'phantom');
  // The census says the agent is RUNNING; the registry (via some past failure
  // this rule exists to contain) says it was preempted.
  const phantomBridge = stubHerdr([phantom]);
  const phantomHarness = newRouter(phantomBridge, []);
  phantomHarness.agentRegistry.recordActivated({ path: phantom, config: knobs() });
  phantomHarness.agentRegistry.recordDeactivated({ path: phantom, config: knobs() }, preemption);
  const phantomList = list(phantomHarness.router, phantomHarness.sent);
  console.log(`  census: ${phantomList.agents.map((a) => a.path).join(', ')}`);
  console.log(`  preemptedAgents: ${JSON.stringify(phantomList.preemptedAgents)}`);

  verdict(
    phantomList.agents.some((a) => a.path === phantom) &&
      phantomList.preemptedAgents.length === 0,
    'an agent herdr can show running is never simultaneously reported as preempted\n' +
    '    debt — reality outranks the record, in this category as in the others.',
    `a phantom debt was reported over a live agent: ${JSON.stringify(phantomList.preemptedAgents)}`
  );
}

// ---------------------------------------------------------- 5. already gone --
rule('5. ALREADY GONE — standing down a dead agent records the intent, not a failure');

{
  const dir = owned('gone', 'agent');
  // herdr is reachable and has NO agent here — it died on its own.
  const bridge = stubHerdr([], { closeFails: true });
  const { router, agentRegistry, sent } = newRouter(bridge, seedOf([dir]));

  const before = list(router, sent);
  console.log(`before: recorded active but not running → missingAgents = ${JSON.stringify(before.missingAgents.map((m) => m.path))}\n`);

  const res = await quiet(async () => {
    router.handle({ action: 'deactivate_agent', path: dir });
    return sent();
  });
  console.log(`deactivate_agent with no live pane → ${JSON.stringify({ success: res.success, alreadyGone: res.alreadyGone, state: res.state, note: res.note })}`);

  const intent = agentRegistry.intents().get(dir);
  const after = list(router, sent);
  console.log(`\nregistry intent: ${intent.event}`);
  console.log(`missingAgents after: ${JSON.stringify(after.missingAgents)}`);

  verdict(
    res.success === true && res.alreadyGone === true &&
      intent.event === 'deactivated' &&
      after.missingAgents.length === 0,
    'the thing actually asked for — "stop expecting this agent back" — succeeded, the\n' +
    '    registry write landed, and the loss alarm stands down with it.',
    `already-gone did not work: ${JSON.stringify({ res, intent: intent?.event })}`
  );

  // The other half of the same rule: a path with no record at all REFUSES,
  // because there is no agent to make a claim about.
  const never = owned('gone', 'never-configured');
  const refused = await quiet(async () => {
    router.handle({ action: 'deactivate_agent', path: never });
    return sent();
  });
  console.log(`\ndeactivate on a never-configured path → ${JSON.stringify({ success: refused.success, refused: refused.refused })}`);
  console.log(`  ${refused.error}`);
  verdict(
    refused.success === false && refused.refused === 'not-configured',
    'and a path that never held an agent is REFUSED rather than answered "stopped" —\n' +
    '    that would be success: true about a world that does not exist.',
    `deactivate claimed to stop an agent that never existed: ${JSON.stringify(refused)}`
  );
}

// ------------------------------------------------------------ 6. poll churn --
rule('6. POLL CHURN — a census position is not an identity across polls');

{
  const a = owned('churn', 'a');
  const b = owned('churn', 'b');
  const bridge = stubHerdr([a, b]);
  const { router, sent } = newRouter(bridge, seedOf([a, b]));

  const poll1 = list(router, sent).agents.map((x) => x.path);
  await quiet(async () => router.handle({ action: 'deactivate_agent', path: a }));
  const poll2 = list(router, sent).agents.map((x) => x.path);
  console.log(`poll n:   [0]=${poll1[0]}  [1]=${poll1[1]}`);
  console.log(`poll n+1: [0]=${poll2[0]}`);
  console.log(
    '\n  Index 0 is a different agent between polls. A client keying rows — or pending\n' +
    '  controls — by array index would carry state from one agent onto another; the\n' +
    '  PATH is the only stable identity a census offers, and unlike the agent name it\n' +
    '  used to offer, it is the same string the caller already had.'
  );

  verdict(
    poll1[0] !== poll2[0] && poll1.length === 2 && poll2.length === 1,
    'the census shifts under a stand-down, so position is not identity and nothing\n' +
    '    should be keyed by it.',
    'the census did not shift as expected; the demonstration proves nothing.'
  );
}

// --------------------------------------------------------------- 7. forget --
rule('7. FORGET — the verb that replaced `reset`, and what it will not do');

{
  console.log(
    '`reset` was a stand-down plus a directory delete. CrabCast no longer creates the\n' +
    'directory an agent runs in, so the set of directories it may delete is empty BY\n' +
    'CONSTRUCTION — and what was left of `reset` was `deactivate` with extra words. It\n' +
    'is removed rather than redefined, so a caller still invoking it is told by name.\n' +
    '\n`forget` is the half it never had: removing the RECORD.\n'
  );

  const dir = owned('forget', 'agent');
  const bridge = stubHerdr([dir]);
  const { router, agentRegistry, events, sent } = newRouter(bridge, seedOf([dir]));

  // While it is running: refused, and there is deliberately no force flag.
  bridge.getSessionByPath = (p) => (p === dir
    ? { sessionId: 'stub', path: dir, paneName: paneNameFor(dir), createdAt: new Date(),
        status: 'active', ptyBuffer: '', onDataListeners: [] }
    : undefined);
  const whileRunning = await quiet(async () => {
    router.handle({ action: 'forget_agent', path: dir });
    return sent();
  });
  console.log(`  forget while it runs → ${JSON.stringify({ success: whileRunning.success, refused: whileRunning.refused })}`);
  console.log(`    ${whileRunning.error}\n`);
  bridge.getSessionByPath = () => undefined;

  await quiet(async () => router.handle({ action: 'deactivate_agent', path: dir }));
  const forgotten = await quiet(async () => {
    router.handle({ action: 'forget_agent', path: dir });
    return sent();
  });
  console.log(`  deactivate, then forget → ${JSON.stringify({ success: forgotten.success, existed: forgotten.existed, removed: forgotten.removed })}`);

  const stillThere = fs.existsSync(dir);
  const gone = !agentRegistry.intents().has(dir);
  console.log(`  the record is gone:      ${gone}`);
  console.log(`  the DIRECTORY is intact: ${stillThere}  (${dir})`);

  const never = path.join(OWNED, 'forget', 'never-configured');
  const noRecord = await quiet(async () => {
    router.handle({ action: 'forget_agent', path: never });
    return sent();
  });
  console.log(`\n  forget on a path that never held an agent → ${JSON.stringify({ success: noRecord.success, existed: noRecord.existed })}`);
  console.log(`    ${noRecord.note}`);

  const broadcast = events.find((e) => e.action === 'agent.forgotten');

  verdict(
    whileRunning.success === false && whileRunning.refused === 'running' &&
      /no force flag/.test(whileRunning.error),
    'forget REFUSES while an agent is running, and says there is no force flag — no call\n' +
    '    that is not named "stop it" may terminate an agent as a side effect, and a force\n' +
    '    flag is that path with a label on it.',
    `forget destroyed a running agent's record: ${JSON.stringify(whileRunning)}`
  );
  verdict(
    forgotten.success === true && gone && stillThere && Boolean(broadcast),
    'after a stand-down it removes the RECORD and nothing else: the caller\'s directory\n' +
    '    is untouched, which is the whole difference from the `reset` it replaced.',
    `forget did not do exactly one thing: recordGone=${gone} dirIntact=${stillThere}`
  );
  verdict(
    noRecord.success === true && noRecord.existed === false,
    'and on a path that never held an agent it SUCCEEDS with existed: false — its\n' +
    '    postcondition is the absence of a record, and absence is verifiable: it already\n' +
    '    held. (`deactivate` on the same path refuses, because ITS postcondition is a\n' +
    '    claim about an agent, and there is no agent to make one about.)',
    `forget refused a postcondition that already held: ${JSON.stringify(noRecord)}`
  );

  // -- 7c. forget asks "is anything live here", not only "is it mine" ---------
  console.log('\n  7c. a live pane this daemon cannot claim still blocks a forget:\n');
  console.log('  The running-check read `ours` and never `occupants` — it computed the whole');
  console.log('  occupancy result and consulted one field. Herdr reachable + a live pane in');
  console.log('  the directory + not recognised as ours meant forget SUCCEEDED and deleted');
  console.log('  the record, which is the outcome its own refusal text names as the reason');
  console.log('  it exists: a live agent, with bypassPermissions, in a caller\'s repository,');
  console.log('  that nothing can any longer address.\n');
  console.log('  This daemon states the rule for `activate`: "not ours" and "nothing is');
  console.log('  there" are different facts. It has to hold one verb over.\n');

  const shared = owned('forget', 'shared');
  const strangerBridge = stubHerdr([]);
  // A live pane in the directory that is NOT ours: a foreign name, a runtime,
  // our cwd. `ours` is null; `occupants` is not empty.
  strangerBridge.listHerdrAgentsChecked = () => ({
    reachable: true,
    agents: [{
      name: 'butchr-task-kan-77',
      paneId: '%stranger',
      agentRuntime: 'claude',
      workDir: shared,
      canonicalWorkDir: canonicalizeOrNull(shared),
      herdrStatus: 'working'
    }]
  });
  strangerBridge.listHerdrAgents = () => strangerBridge.listHerdrAgentsChecked().agents;
  const h7c = newRouter(strangerBridge, seedOf([shared]));
  const refusedForget = await quiet(async () => {
    h7c.router.handle({ action: 'forget_agent', path: shared });
    return h7c.sent();
  });
  console.log(`  forget → ${JSON.stringify({ success: refusedForget.success, refused: refusedForget.refused })}`);
  console.log(`    ${refusedForget.error?.split('\n')[0]}`);

  verdict(
    refusedForget.success === false &&
      refusedForget.refused === 'occupied' &&
      h7c.agentRegistry.intents().has(shared) &&
      /different facts/.test(refusedForget.error ?? ''),
    'the record is KEPT and the live pane is named. Dropping the only record of an agent\n' +
    '    while something is live where it runs is the one way to produce a live agent\n' +
    '    nothing can address.',
    `forget deleted the record with a live pane in the directory: ${JSON.stringify(refusedForget)}`
  );

  // -- 7d. deactivate does not answer "unstarted" without looking -------------
  console.log('\n  7d. `unstarted` is a claim about the world, so it is checked against one:\n');
  console.log('  A record whose last event is `configured` is not evidence that nothing is');
  console.log('  running — a durable write that failed after an activation leaves exactly');
  console.log('  that state over a live pane. Answering "nothing was running" without a');
  console.log('  census read is the claim-without-looking this daemon refuses everywhere.\n');

  const stale = owned('forget', 'stale-record');
  const staleBridge = stubHerdr([stale]);
  const h7d = newRouter(staleBridge);
  // The record says `configured`. The census says our agent is live there.
  h7d.agentRegistry.recordConfigured({ path: stale, config: knobs() });
  const stood = await quiet(async () => {
    h7d.router.handle({ action: 'deactivate_agent', path: stale });
    return h7d.sent();
  });
  console.log(`  deactivate → ${JSON.stringify({ success: stood.success, wasRunning: stood.wasRunning, state: stood.state })}`);

  verdict(
    stood.success === true && stood.state !== 'unstarted' &&
      !staleBridge.alive.some((a) => a.path === stale),
    'it took the close path instead: the pane is what is real, and the stale record does\n' +
    '    not get to answer a question about the world on its own.',
    `deactivate reported "${stood.state}" over a live pane: ${JSON.stringify(stood)}`
  );

  // -- 7b. a deleted directory is not offered a way back ----------------------
  console.log('\n  7b. a directory the caller deleted is not offered a way back:\n');
  const doomed = owned('forget', 'doomed');
  const bridge2 = stubHerdr([doomed]);
  const h2 = newRouter(bridge2, seedOf([doomed]));
  await quiet(async () => h2.router.handle({ action: 'deactivate_agent', path: doomed }));
  const withDir = list(h2.router, h2.sent).standbyAgents.map((a) => a.path);
  console.log(`  stood down, directory present: standbyAgents = [${withDir.join(', ')}]`);
  fs.rmSync(doomed, { recursive: true, force: true });
  const withoutDir = list(h2.router, h2.sent).standbyAgents.map((a) => a.path);
  console.log(`  directory deleted:             standbyAgents = [${withoutDir.join(', ')}]`);
  console.log(
    '\n  The directory is the only thing that tells "stopped" from "finished with".\n' +
    '  Offering a way back for one that is gone would start an agent in a directory\n' +
    '  that does not exist, with nothing to continue.'
  );
  verdict(
    withDir.includes(doomed) && !withoutDir.includes(doomed),
    'a directory on disk is what makes an agent restorable, and a deleted one is not\n' +
    '    offered.',
    'a deleted directory was still offered a way back.'
  );
}

// ------------------------------------------------------------ 8. durability --
rule('8. DURABILITY IS REPORTED — a registry that cannot be written says so');

{
  const dir = owned('durable', 'agent');
  const bridge = stubHerdr([]);

  // A registry whose directory refuses writes: the append's openSync fails,
  // which is what a full or read-only data dir looks like from here. It is
  // seeded by hand first, because `configure` would fail on the same wall.
  const sealedDir = path.join(TMP, 'sealed');
  fs.mkdirSync(sealedDir, { recursive: true });
  const sealedLog = path.join(sealedDir, 'agents.jsonl');
  const seedReg = new AgentRegistry(sealedLog);
  seedReg.recordConfigured({ path: dir, config: knobs() });
  // BOTH, and the file matters more than the directory: appending to a file
  // that already exists needs write permission on the FILE, not on the
  // directory holding it. Sealing only the directory would leave the append
  // working and this section proving nothing.
  fs.chmodSync(sealedLog, 0o400);
  fs.chmodSync(sealedDir, 0o500);

  const events = [];
  let last;
  const router = new MessageRouter({
    config,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry: new AgentRegistry(sealedLog),
    send: (msg) => { last = msg; },
    broadcast: (msg) => events.push(msg)
  });

  const res = await quiet(async () => {
    let out;
    await router.handleActivate({ path: dir, ...PAST_THE_GATE }, (msg) => { out = msg; });
    return out;
  });
  fs.chmodSync(sealedDir, 0o755); // so cleanup can remove the scratch
  fs.chmodSync(sealedLog, 0o600);

  const degraded = events.find((e) => e.action === 'registry.degraded');
  console.log('the agent exists and is verified — but the disk does not know it, and that');
  console.log('gap must be somebody\'s to act on rather than a line in a log nobody reads:\n');
  console.log(`  activate_agent → ${JSON.stringify({ success: res.success, verified: res.verified, durable: res.durable, durabilityError: Boolean(res.durabilityError) })}`);
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

// --------------------------------------------------------- 9. compaction --
rule('9. COMPACTION KEEPS EVERY AGENT — including the ones that never ran (AC 6)');

{
  console.log('Compaction preserves an ALLOWLIST: whatever a preserve set does not name is');
  console.log('dropped when the log is rewritten. That allowlist was `activated` plus');
  console.log('`deactivated`, which happened to be every terminal state there was — and the');
  console.log('`configured` event broke it silently. A configured-last row matched neither');
  console.log('set, and since `configure` is MANDATORY (there is no other place an agent\'s');
  console.log('priority, launcher and gate flags can live), compaction at 500 records would');
  console.log('have made a perfectly good agent STOP EXISTING. Not stop running: stop');
  console.log('existing, with no row anywhere saying it ever had.\n');
  console.log('The general rule, for whoever adds the next event: compaction\'s preserve set');
  console.log('is an allowlist, so every new terminal event state must be added explicitly');
  console.log('or it is silently dropped.\n');

  const logPath = path.join(TMP, 'compaction.jsonl');
  const reg = new AgentRegistry(logPath);

  // The row this section exists for: configured, never activated. It is the
  // agent — delete the row and the agent has never existed.
  const unstarted = owned('compact', 'unstarted');
  reg.recordConfigured({ path: unstarted, config: knobs({ priority: 7, label: 'never run' }) });

  // One agent switched off with its directory intact — the row a client's On
  // button is built from.
  const kept = owned('compact', 'kept');
  reg.recordActivated({ path: kept, config: knobs() });
  reg.recordDeactivated({ path: kept, config: knobs() });

  // One switched off whose directory the caller has since deleted.
  const goneDir = path.join(OWNED, 'compact', 'gone');
  fs.mkdirSync(goneDir, { recursive: true });
  const gone = fs.realpathSync(goneDir);
  reg.recordActivated({ path: gone, config: knobs() });
  reg.recordDeactivated({ path: gone, config: knobs() });
  fs.rmSync(gone, { recursive: true, force: true });

  // One preempted, directory intact: the annotation is the deliberate loss,
  // the route back is not.
  const victim = owned('compact', 'victim');
  const boss = owned('compact', 'boss');
  reg.recordActivated({ path: victim, config: knobs() });
  reg.recordDeactivated({ path: victim, config: knobs() }, {
    byPath: boss, byPaneName: paneNameFor(boss), byPriority: 10,
    priority: 1, herdrStatus: 'working', derivation: 'at capacity'
  });

  // One still expected, so the activated half is provably untouched.
  const live = owned('compact', 'live');
  reg.recordActivated({ path: live, config: knobs() });

  const beforeCompaction = reg.readLog().length;
  const intentsBefore = reg.intents();
  const atBefore = new Map([...intentsBefore].map(([p, i]) => [p, i.at]));
  // A second expected agent recorded a measurable moment later, so "all the
  // carried timestamps collapsed onto one value" is distinguishable from "they
  // were preserved" rather than being a coin flip on clock resolution.
  await new Promise((r) => setTimeout(r, 25));
  const later = owned('compact', 'later');
  reg.recordActivated({ path: later, config: knobs() });
  atBefore.set(later, reg.intents().get(later).at);
  await new Promise((r) => setTimeout(r, 25));

  console.log(`  BEFORE compaction — ${beforeCompaction} records:`);
  for (const [p, i] of intentsBefore) console.log(`    ${i.event.padEnd(12)} ${p}`);

  reg.compact();
  const after = reg.readLog();
  const intentsAfter = reg.intents();
  // Captured HERE, before the activation below proves the carried row is still
  // usable — that activation appends a row of its own, and reading `expected()`
  // after it would be measuring this script rather than the compaction.
  const expectedAfterCompaction = reg.expected().map((r) => r.path).sort().join();

  console.log(`\n  AFTER compaction — ${after.length} records:`);
  for (const [p, i] of intentsAfter) console.log(`    ${i.event.padEnd(12)} ${p}`);

  // And through a real router, because "the agent still exists" is a claim
  // about what a caller can do with it, not about the file.
  const bridge = stubHerdr([]);
  let sent9;
  const router9 = new MessageRouter({
    config, herdrBridge: bridge,
    daemonStartedAt: new Date(), agentRegistry: reg,
    send: (msg) => { sent9 = msg; }, broadcast: () => {}
  });
  router9.handle({ action: 'list_agents' });
  const standbyPaths = sent9.standbyAgents.map((a) => a.path);

  const unstartedAfter = intentsAfter.get(unstarted);
  console.log(`\n  the configured-but-never-run agent after compaction: ` +
    `${unstartedAfter ? `${unstartedAfter.event}, priority ${unstartedAfter.record.config.priority}` : 'GONE'}`);

  // The proof that it is still a usable agent rather than merely a row.
  const activated = await quiet(async () => {
    let out;
    await router9.handleActivate({ path: unstarted, ...PAST_THE_GATE }, (m) => { out = m; });
    return out;
  });
  console.log(`  and it can still be activated: success=${activated.success}`);

  verdict(
    Boolean(unstartedAfter) &&
      unstartedAfter.event === 'configured' &&
      unstartedAfter.record.config.priority === 7 &&
      activated.success === true,
    'a configured-but-never-run agent SURVIVES compaction with its knobs intact, and is\n' +
    '    still activatable afterwards — because `configure` is mandatory, dropping that\n' +
    '    row would not have stopped an agent, it would have deleted one.',
    `compaction deleted an agent: ${unstartedAfter ? JSON.stringify(unstartedAfter) : 'the configured row is gone'}`
  );
  verdict(
    intentsBefore.get(kept)?.event === 'deactivated' && standbyPaths.includes(kept),
    'a stood-down agent whose directory still exists is still offered a way back after\n' +
    '    compaction — the switch a person turned off is still a switch.',
    `the standby row was lost to compaction: ${JSON.stringify(standbyPaths)}`
  );
  verdict(
    !standbyPaths.includes(gone) && intentsAfter.has(gone),
    'a stood-down agent whose directory is gone is NOT OFFERED a way back — but its record\n' +
    '    survives compaction. Those are different decisions and they belong in different\n' +
    '    places: what to show a person is a reporting question (standbyAgents checks the\n' +
    '    disk), and whether the agent exists is not. Compaction dropping it would delete\n' +
    '    the agent because a mount was slow.',
    'compaction deleted an agent whose directory happened to be missing'
  );
  verdict(
    !intentsAfter.get(victim)?.preemption &&
      sent9.preemptedAgents.length === 0 &&
      standbyPaths.includes(victim),
    'a preempted agent keeps the deliberate half of the old behaviour — the debt stops\n' +
    '    being reported past 500 records — while the route back to its work survives.',
    'the preemption annotation outlived compaction, or the victim lost its way back'
  );
  verdict(
    expectedAfterCompaction === [later, live].sort().join() &&
      after.length < beforeCompaction + 2,
    'and compaction still compacts: the expected fleet is exactly what it was, in fewer\n' +
    '    records than it took to get here.',
    `compaction changed the expected fleet or did not shrink the log`
  );

  // -- 9b. carried records keep their own `at` --------------------------------
  //
  // Compaction used to stamp every carried `activated` record with the time of
  // the compaction. That is not a cosmetic loss: `missingAgents` reports it as
  // `since`, and the reporting path sorts newest-first before clipping at 25 —
  // so one shared timestamp turns that sort into an all-ties comparison and
  // the clip hides an arbitrary twenty-five instead of the oldest ones.
  console.log('\n  9b. carried records keep the timestamp of the event, not of the compaction:\n');
  const atAfter = new Map([...intentsAfter].map(([p, i]) => [p, i.at]));
  for (const p of [live, later, kept, victim, unstarted]) {
    console.log(`    ${path.basename(p)}: before=${atBefore.get(p)} after=${atAfter.get(p)}`);
  }
  const preserved = [live, later, kept, victim, unstarted].every((p) => atBefore.get(p) === atAfter.get(p));
  const activatedStamps = new Set([live, later].map((p) => atAfter.get(p)));
  console.log(`  distinct timestamps among the two expected agents after compaction: ${activatedStamps.size}`);
  verdict(
    preserved && activatedStamps.size === 2,
    'every carried record kept its own `at` — so `since` still says when the agent was\n' +
    '    activated, and the newest-first clip is still an ordering rather than a tie.',
    `compaction rewrote timestamps: preserved=${preserved}, distinct=${activatedStamps.size}`
  );

  // -- 9c. an ex-preempted row does not claim somebody chose it ---------------
  console.log('\n  9c. the carried ex-preempted row says what actually happened to it:\n');
  const victimRow = sent9.standbyAgents.find((a) => a.path === victim);
  const keptRow = sent9.standbyAgents.find((a) => a.path === kept);
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

// ------------------------------------- 9e. a compacted preemption still resumes --
rule('9e. A COMPACTED PREEMPTION IS STILL A RESUME');

{
  console.log('Compaction forgets the DEBT — who took the slot, at what priority — and keeps');
  console.log('the FACT as `wasPreempted`. This file already argues that split: "How the');
  console.log('agent stopped is not a debt, it is a fact about the work."\n');
  console.log('But the resume path read only the annotation. So a preempted agent that had');
  console.log('been through a compaction came back with NO resume cause: Claude Code');
  console.log('restored its whole conversation, nothing thought this was a resume, the nudge');
  console.log('never fired, and it sat at an empty prompt with all of its memory and no turn');
  console.log('to take — while standbyAgents told the reader that switching it on "resumes');
  console.log('the conversation it was stopped in". That is the KAN-21 idle-forever failure.\n');

  const victim = owned('resume', 'compacted-victim');
  const boss = owned('resume', 'boss');
  const reg = new AgentRegistry(path.join(TMP, 'compacted-preemption.jsonl'));
  reg.recordActivated({ path: victim, config: knobs() });
  reg.recordDeactivated({ path: victim, config: knobs() }, {
    byPath: boss, byPaneName: paneNameFor(boss), byPriority: 10,
    priority: 1, herdrStatus: 'working', derivation: 'at capacity'
  });

  console.log(`  before compaction: preemption annotation present = ` +
    `${Boolean(reg.intents().get(victim)?.preemption)}, ` +
    `stoppedByPreemption = ${reg.stoppedByPreemption(victim)}`);
  reg.compact();
  const after = reg.intents().get(victim);
  console.log(`  after  compaction: preemption annotation present = ${Boolean(after?.preemption)}, ` +
    `wasPreempted = ${after?.wasPreempted}, stoppedByPreemption = ${reg.stoppedByPreemption(victim)}`);

  const bridge = stubHerdr([]);
  const router9e = new MessageRouter({
    config, herdrBridge: bridge, daemonStartedAt: new Date(), agentRegistry: reg,
    send: () => {}, broadcast: () => {}
  });
  await quiet(async () => router9e.handleActivate({ path: victim, ...PAST_THE_GATE }, () => {}));
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  console.log(`  re-activated after compaction: spawnSession was told resume='${spawned?.resume}'`);

  verdict(
    Boolean(reg.intents().get(victim)) &&
      after?.preemption === undefined &&
      after?.wasPreempted === true &&
      spawned?.resume === 'preempted',
    'the debt is forgotten and the FACT is not: an agent whose annotation compaction\n' +
    '    dropped still comes back framed as interrupted work, so it is told to carry on\n' +
    '    instead of sitting on a restored conversation with no turn to take.',
    `a compacted preemption lost its resume framing: resume=${spawned?.resume}, ` +
    `wasPreempted=${after?.wasPreempted}`
  );
}

// ------------------------------------------------ 9d. the standby clip (AC 6's branch) --
rule('9d. COMPACTION KEEPS EVERY STOOD-DOWN AGENT — the clip that deleted them');

{
  console.log('The same defect as 9, in the branch next door, and it did not need a new');
  console.log('event to introduce it — it was reachable at 101 stood-down agents.\n');
  console.log('`standbyToPreserve` clipped to the newest 100. A `deactivated`-last row is');
  console.log('matched by NEITHER of the other two preserve sets, so it is that agent\'s only');
  console.log('record: clipping it does not cost the route back, it DELETES THE AGENT —');
  console.log('priority, launcher, prompt, gate flags — and a later activate(path) answers');
  console.log('"no agent is configured" for a directory whose work is still on disk.\n');
  console.log('It was safe under the type model, where priority and launcher lived in');
  console.log('config and anyone could rebuild the activation. There is no config now.\n');

  // 170 agents × 3 rows = 510, past the 500-record compaction threshold, and
  // 70 past the clip that used to be there.
  const N = 170;
  const reg = new AgentRegistry(path.join(TMP, 'standby-clip.jsonl'));
  const dirs = [];
  for (let i = 0; i < N; i++) {
    const dir = owned('clip', `agent-${i}`);
    dirs.push(dir);
    const record = { path: dir, config: knobs({ priority: i, label: `agent ${i}` }) };
    reg.recordConfigured(record);
    reg.recordActivated(record);
    reg.recordDeactivated(record);
  }

  const rows = reg.readLog().length;
  const before = reg.intents();
  console.log(`  ${N} agents configured, activated and stood down → ${rows} records ` +
    `(threshold is 500)`);
  console.log(`  agents known BEFORE compaction: ${before.size}`);

  reg.compact();
  const after = reg.intents();
  console.log(`  agents known AFTER  compaction: ${after.size}`);
  console.log(`  records after compaction:       ${reg.readLog().length}`);

  const missing = dirs.filter((d) => !after.has(d));
  console.log(`  agents that stopped existing:    ${missing.length}` +
    (missing.length ? ` (e.g. ${missing[0]})` : ''));

  // The oldest one is the one a clip would take first, so it is the one to
  // prove is still usable — not merely still listed.
  const oldest = after.get(dirs[0]);
  const bridge = stubHerdr([]);
  let sent9d;
  const router9d = new MessageRouter({
    config, herdrBridge: bridge, daemonStartedAt: new Date(), agentRegistry: reg,
    send: (msg) => { sent9d = msg; }, broadcast: () => {}
  });
  const revived = await quiet(async () => {
    let out;
    await router9d.handleActivate({ path: dirs[0], ...PAST_THE_GATE }, (m) => { out = m; });
    return out;
  });
  console.log(`  the OLDEST stood-down agent still activates: ${revived?.success === true}`);
  console.log(`  and its knobs survived: priority ${oldest?.record.config.priority}, ` +
    `label ${JSON.stringify(oldest?.record.config.label)}`);

  verdict(
    missing.length === 0 && after.size === N,
    `every one of the ${N} stood-down agents survived compaction. Compaction drops\n` +
    '    HISTORY — superseded rows — which is its whole job; it never drops an AGENT. The\n' +
    '    output is one row per agent that exists, a bound proportional to the fleet rather\n' +
    '    than to how long the daemon has been running.',
    `compaction deleted ${missing.length} agent(s) outright`
  );
  verdict(
    revived?.success === true &&
      oldest?.record.config.priority === 0 &&
      oldest?.record.config.label === 'agent 0',
    'and the oldest of them is still a usable agent afterwards, with the knobs it was\n' +
    '    configured with — not merely a row that survived a count.',
    `the oldest stood-down agent did not survive usefully: ${JSON.stringify(oldest?.record.config)}`
  );
  verdict(
    reg.readLog().length < rows,
    'while compaction still compacts.',
    `the log did not shrink: ${rows} → ${reg.readLog().length}`
  );
}

// ----------------------------------------------------------- 10. restatement --
rule('10. AN ACTIVATION THAT CHANGES NOTHING WRITES NOTHING');

{
  console.log('This section used to prove that a CHANGED mcpServers list was re-recorded:');
  console.log('`rememberActivated` compared workDir, url and defaultAgent but not the server');
  console.log('list, so an agent whose TYPE gained a server in config was still "exactly');
  console.log('this", the restatement was skipped, and a restart replayed the list the agent');
  console.log('first started with.\n');
  console.log('That drift is now impossible by construction: `activate` takes NO attributes,');
  console.log('and every value lives on the record, so there is no second source for the');
  console.log('record to fall out of step with. What is left to check is that the dedupe');
  console.log('still discriminates — it skips a restatement of the same configuration and');
  console.log('does NOT skip a genuine change.\n');
  console.log('It deliberately does not key on the pane. An earlier revision compared the');
  console.log('pane id an activation landed in, which meant a herdr renumber (see section 0');
  console.log('and verify-refuses-occupied-directory case c3) wrote a spurious row every');
  console.log('time an unrelated agent finished.\n');

  const dir = owned('restate', 'agent');
  const agentRegistry = new AgentRegistry(path.join(TMP, 'restatement.jsonl'));
  const bridge = stubHerdr([]);
  let last;
  const routerFor = () => new MessageRouter({
    config, herdrBridge: bridge, daemonStartedAt: new Date(), agentRegistry,
    send: (msg) => { last = msg; }, broadcast: () => {}
  });

  await quiet(async () => {
    routerFor().handle({ action: 'configure_agent', path: dir, ...knobs() });
  });
  const afterConfigure = agentRegistry.readLog().length;

  await quiet(async () => routerFor().handleActivate({ path: dir, ...PAST_THE_GATE }, () => {}));
  const afterFirst = agentRegistry.readLog().length;

  // Re-activating an agent that is already running: answered `alreadyRunning`
  // without touching the log. A fleet client reconciling towards desired state
  // does this on every pass.
  await quiet(async () => routerFor().handleActivate({ path: dir, ...PAST_THE_GATE }, () => {}));
  const afterSame = afterFirst === agentRegistry.readLog().length
    ? agentRegistry.readLog().length
    : agentRegistry.readLog().length;

  // The pane renumbers underneath it. Nothing about the agent changed, so
  // nothing may be written.
  bridge.alive[0].paneId = '%RENUMBERED';
  await quiet(async () => routerFor().handleActivate({ path: dir, ...PAST_THE_GATE }, () => {}));
  const afterRenumber = agentRegistry.readLog().length;

  // Now a genuine change: the agent is stood down and reconfigured, then
  // activated. The configuration on the record is different, so the
  // activation is not a restatement of anything.
  await quiet(async () => routerFor().handle({ action: 'deactivate_agent', path: dir }));
  bridge.alive.length = 0;
  await quiet(async () => {
    routerFor().handle({ action: 'configure_agent', path: dir, ...knobs({ priority: 9 }) });
  });
  const afterReconfigure = agentRegistry.readLog().length;
  await quiet(async () => routerFor().handleActivate({ path: dir, ...PAST_THE_GATE }, () => {}));
  const afterChanged = agentRegistry.readLog().length;
  const recorded = agentRegistry.intents().get(dir);

  console.log(`  configure                                   → ${afterConfigure} record(s)`);
  console.log(`  activate                                    → ${afterFirst} record(s)`);
  console.log(`  activate again, already running             → ${afterSame} record(s) (skipped)`);
  console.log(`  activate again after herdr RENUMBERED it    → ${afterRenumber} record(s) (skipped)`);
  console.log(`  deactivate + configure(priority 9)          → ${afterReconfigure} record(s)`);
  console.log(`  activate with the new configuration         → ${afterChanged} record(s)`);
  console.log(`  what a restart would replay: priority ${recorded?.record.config.priority}`);

  verdict(
    afterSame === afterFirst,
    'an activation that changes nothing writes nothing — the dedupe that keeps fleet\n' +
    '    clients from filling the log with restatements is intact.',
    `an unchanged re-activation appended a record: ${afterFirst} → ${afterSame}`
  );
  verdict(
    afterRenumber === afterSame,
    'and a herdr RENUMBER writes nothing either: the pane an agent happens to be in is\n' +
    '    not part of what the record says, so a position that moved is not a change.',
    `a renumber appended a record: ${afterSame} → ${afterRenumber}`
  );
  verdict(
    afterChanged > afterReconfigure &&
      recorded?.event === 'activated' &&
      recorded?.record.config.priority === 9,
    'a genuine configuration change IS recorded, so a restart replays what the agent is\n' +
    '    now rather than what it was — the dedupe discriminates rather than just skipping.',
    `the changed configuration was not recorded: ${afterReconfigure} → ${afterChanged}, ` +
    `priority ${recorded?.record.config.priority}`
  );
}

// -------------------------------------------------- 11. short writes --
rule('11. A SHORT WRITE IS NOT SILENTLY A TORN RECORD');

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
  path: '/tmp/kan88-shortwrite',
  config: { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'claude' }
};
const outcome = reg.record('activated', record);
const raw = fsCjs.readFileSync(file, 'utf8');
process.stdout.write(JSON.stringify({
  outcome,
  raw,
  parsedPaths: reg.readLog().map((e) => e.path)
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
  console.log(`    readable records: ${JSON.stringify(partial.parsedPaths)}`);
  console.log(`  writeSync making no progress at all:`);
  console.log(`    record() → ${JSON.stringify(stuck.outcome)}`);
  console.log(`    file holds: ${JSON.stringify(stuck.raw)}`);

  verdict(
    partial.outcome?.ok === true &&
      partial.parsedPaths?.length === 1 &&
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
    (stuck.parsedPaths ?? []).length === 0,
    'and it left nothing readable behind pretending to be a record.',
    `a stuck write left a phantom record: ${JSON.stringify(stuck.parsedPaths)}`
  );
}

// ------------------------------------------- 12. one read, one cap --
rule('12. ONE REGISTRY READ PER POLL, AND EVERY CATEGORY CAPPED');

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
  const boss = owned('cap', 'boss');

  for (let i = 0; i < N; i++) {
    // missing: last word `activated`, and herdr will not have it.
    reg.recordActivated({ path: owned('cap', `miss-${i}`), config: knobs() });
    // standby: deliberately off, directory on disk.
    const standby = owned('cap', `standby-${i}`);
    reg.recordActivated({ path: standby, config: knobs() });
    reg.recordDeactivated({ path: standby, config: knobs() });
    // preempted: a debt.
    const victim = owned('cap', `victim-${i}`);
    reg.recordActivated({ path: victim, config: knobs() });
    reg.recordDeactivated({ path: victim, config: knobs() }, {
      byPath: boss, byPaneName: paneNameFor(boss), byPriority: 10,
      priority: 1, herdrStatus: 'working', derivation: 'at capacity'
    });
  }

  // A registry that counts what the response actually costs. Every one of
  // these entry points reads and parses the whole log once, so the tally is
  // the number of whole-file parses this one response paid for.
  //
  // `read` joined the list in KAN-302 and the section's claim did not change.
  // `handleListAgents` needs two answers from the log now — the rows it can
  // load and the rows it cannot, published as `unreadableRecords` — and takes
  // both from ONE parse through `read()`, which is the same one-read-per-poll
  // property this section has always asserted. Adding it here is what keeps
  // the instrument pointed at the cost: without it this tally reads 0, which
  // would report a response that reads the log zero times as though that were
  // an improvement, and the section's own `=== 1` assertion is what caught it.
  const reads = { read: 0, readLog: 0, intents: 0, preempted: 0 };
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
    config, herdrBridge: bridge,
    daemonStartedAt: new Date(), agentRegistry: counting,
    send: (msg) => { sent12 = msg; }, broadcast: () => {}
  });

  const records = reg.readLog().length;
  for (const k of Object.keys(reads)) reads[k] = 0;
  router12.handle({ action: 'list_agents' });
  const wholeLogReads = Object.values(reads).reduce((a, b) => a + b, 0);

  console.log(`  seeded: ${N} missing, ${N} preempted, ${N} standby (${records} records)`);
  console.log(`  whole-log reads for one list_agents response: ${wholeLogReads} ${JSON.stringify(reads)}`);
  console.log(`  missingAgents   ${sent12.missingAgents.length} of missingTotal ${sent12.missingTotal}`);
  console.log(`  preemptedAgents ${sent12.preemptedAgents.length} of preemptedTotal ${sent12.preemptedTotal}`);
  console.log(`  standbyAgents   ${sent12.standbyAgents.length} of standbyTotal ${sent12.standbyTotal}`);

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
    // The claim is about ORDER, and it stops there deliberately. It used to end
    // "clipping a newest-first one hides the least urgent", which is true of
    // standby — its `since` is when somebody switched the agent off — and is
    // NOT true of missingAgents, whose `since` is when the agent was last
    // ACTIVATED and therefore ranks lifetime rather than neglect. Section 15
    // is that distinction, measured. A page ordered by nothing hides an
    // arbitrary subset, which is what this verdict is here to exclude.
    'and what is kept is the newest of each — clipping an unordered list would hide an\n' +
    '    arbitrary subset, which is a page nobody can reason about at all. What "newest"\n' +
    '    MEANS differs by category, and §15 is where that is pinned down.',
    'a clipped category was not ordered newest-first'
  );

  // -- 12b. the sweep reads the UNCAPPED list ---------------------------------
  //
  // The one invariant here whose regression is silent. `list_agents` is a
  // report and clipping it costs a reader the tail of a list they can see the
  // total of; the daemon's 30s missing-sweep is not a report, it is the thing
  // that announces a loss — exactly once, latched — so an agent that fell past
  // position 25 in a clipped sweep would never be announced at all.
  console.log('\n  12b. the daemon\'s missing-sweep is not the report, and must not be clipped:\n');
  const swept = router12.findMissingAgents();
  const sweptPaths = new Set(swept.map((row) => row.path));
  const reportedPaths = new Set(sent12.missingAgents.map((row) => row.path));
  const onlyInSweep = [...sweptPaths].filter((p) => !reportedPaths.has(p));
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

// ------------------------------------------------------------ 13. collision --
rule('13. THE KEY COLLISION IS GONE, NOT MERELY UNREACHED (AC 3)');

{
  console.log('Two agents whose directories share a basename would once have shared a KEY,');
  console.log('and the daemon resolved a bare key by matching herdr agent names by suffix:');
  console.log('one match won, several threw `Key \'<key>\' is ambiguous`, and a caller had to');
  console.log('remember a --type flag to avoid it. The failure that mattered was not the');
  console.log('throw — it was the SINGLE match: address the wrong agent and a stand-down,');
  console.log('a message or a teardown lands on somebody else\'s work.\n');

  const a = owned('collide', 'alpha', 'kan-38');
  const b = owned('collide', 'beta', 'kan-38');
  console.log(`  two directories, same basename:\n    ${a}\n    ${b}\n`);
  console.log(`  and two DIFFERENT pane names, derived from the paths:`);
  console.log(`    ${paneNameFor(a)}`);
  console.log(`    ${paneNameFor(b)}\n`);

  const bridge = stubHerdr([a, b]);
  const { router, agentRegistry, sent } = newRouter(bridge, [
    ...seedOf([a], { priority: 1, label: 'alpha' }),
    ...seedOf([b], { priority: 5, label: 'beta' })
  ]);

  const listed = list(router, sent);
  console.log('  both coexist in one census, addressed unambiguously:\n');
  for (const row of listed.agents) {
    console.log(`    ${row.path}\n      pane ${row.paneName}  label ${row.label}`);
  }

  // Address one of them and only one of them.
  await quiet(async () => router.handle({ action: 'deactivate_agent', path: a }));
  const after = list(router, sent);
  const intentA = agentRegistry.intents().get(a);
  const intentB = agentRegistry.intents().get(b);
  console.log(`\n  deactivate ${a}`);
  console.log(`    census after: ${after.agents.map((r) => r.path).join(', ')}`);
  console.log(`    registry: alpha=${intentA.event}, beta=${intentB.event}`);

  // And the ambiguity path is GONE from the source rather than merely
  // unreached: there is no resolver left that could produce it.
  const srcDir = path.join(scriptDir, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const text = fs.readFileSync(full, 'utf8');
      if (/is ambiguous|resolveAgentName|agentNameFor|addressFromAgentName|typeFromAgentName/.test(text)) {
        offenders.push(path.relative(path.join(scriptDir, '..'), full));
      }
    }
  };
  walk(srcDir);
  console.log(`\n  source files still containing the ambiguity path or a name parser: ` +
    `${offenders.length ? offenders.join(', ') : '(none)'}`);

  verdict(
    listed.agents.length === 2 &&
      paneNameFor(a) !== paneNameFor(b) &&
      !after.agents.some((r) => r.path === a) &&
      after.agents.some((r) => r.path === b) &&
      intentA.event === 'deactivated' && intentB.event === 'activated',
    'two agents that would have collided on a shared key coexist, and addressing one\n' +
    '    touches only that one — the path IS the disambiguation, so there is nothing left\n' +
    '    for a --type flag to resolve.',
    `the two agents were not independently addressable: ${JSON.stringify({ a: intentA.event, b: intentB.event })}`
  );
  verdict(
    offenders.length === 0,
    'and the old path is gone rather than merely unreached: no `Key \'<key>\' is\n' +
    '    ambiguous`, and no function anywhere that builds or parses an agent name.',
    `the name-parsing machinery survives in: ${offenders.join(', ')}`
  );
}

// ------------------------------------------ 14. one read per compaction --
rule('14. ONE WHOLE-LOG READ PER COMPACTION, ON THE ACTIVATION PATH (KAN-96 AC 1)');

{
  console.log('Section 12 is the same defect one file over: `list_agents` asked the registry');
  console.log('four separate times per poll. Compaction had it too, and in a worse place.');
  console.log('`compactIfLarge()` read the log to decide whether to compact, and `compact()`');
  console.log('then called three preserve sets that each called `intents()` — a whole-file');
  console.log('read and parse each. Four passes over a 500-record file, INSIDE `record()`,');
  console.log('which is on the path an activation is blocked on.\n');
  console.log('Four reads are also four DIFFERENT reads: a compaction that decided what to');
  console.log('keep from a later parse than the one it sized the file with would be rewriting');
  console.log('the log against two disagreeing pictures of it.\n');

  // WHAT THIS MEASURES, AND HOW. `readLog()` is the only function in
  // agent-registry.ts that opens the log — `fs.readFileSync(this.file)` appears
  // there once and nowhere else in the class — so counting calls to it counts
  // passes over the file.
  //
  // Counted by SUBCLASS rather than by the Proxy §12 uses, for a mechanical
  // reason worth stating: the reads under test are the registry's own internal
  // `this.readLog()` calls, and a Proxy wrapping the instance never sees those
  // — an internal call goes through `this`, not through the wrapper. A subclass
  // does see them, because the call dispatches virtually. A Proxy here would
  // have counted zero and this section would have passed against anything.
  const counting = (Registry) => {
    const reads = { readLog: 0, intents: 0 };
    class Counting extends Registry {
      readLog() { reads.readLog++; return super.readLog(); }
      intents() { reads.intents++; return super.intents(); }
    }
    return { Counting, reads };
  };

  // A log of `rows` records over `agents` distinct paths, written as the daemon
  // writes them: ONE genuine `record()` supplies the line, and the copies vary
  // only the path. Hand-built JSON here would be this proof asserting against
  // its own idea of the format rather than against the daemon's.
  //
  // Seeded rather than driven, because 640 real `record()` calls are 640
  // fsyncs. What that leaves uncovered is the THRESHOLD — whether the daemon
  // really compacts at 500 records rather than at some other number — and this
  // section does not cover it: it seeds past whatever the threshold is and
  // asserts a compaction happened. §9 drives compaction through the real
  // `compact()`; §9d and verify-activated-by.mjs §6 drive a real log past the
  // real threshold. This one owns the READ COUNT and nothing else.
  const seedLog = (file, rows, agents) => {
    const template = path.join(TMP, `seed-${path.basename(file)}`);
    new AgentRegistry(template).recordActivated({
      path: owned('reads', 'template'), config: knobs()
    });
    const row = JSON.parse(fs.readFileSync(template, 'utf8').trim());
    const lines = [];
    for (let i = 0; i < rows; i++) {
      lines.push(JSON.stringify({ ...row, path: path.join(OWNED, 'reads', `agent-${i % agents}`) }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
  };

  const AGENTS = 8;
  const ROWS = 640;

  /**
   * One activation's worth of registry work, measured.
   *
   * Returns the reads that activation paid for, and — the part that makes the
   * number mean anything — what the log looked like either side of it.
   */
  const activationCost = (Registry, file) => {
    seedLog(file, ROWS, AGENTS);
    const { Counting, reads } = counting(Registry);
    const reg = new Counting(file);
    const before = reg.readLog().length;
    reads.readLog = 0;
    reads.intents = 0;
    const outcome = reg.recordActivated({
      path: path.join(OWNED, 'reads', 'the-activation'), config: knobs()
    });
    const cost = { ...reads };
    return { before, after: reg.readLog().length, cost, outcome, reg };
  };

  const fixed = activationCost(AgentRegistry, path.join(TMP, 'compaction-reads.jsonl'));
  const keptRows = fixed.reg.readLog().map((e) => `${e.event} ${path.basename(e.path)}`).sort();

  console.log(`  seeded ${fixed.before} records over ${AGENTS} agents, then ONE recordActivated():`);
  console.log(`    log after that call: ${fixed.after} records (${AGENTS} agents + the new one)`);
  console.log(`    whole-log reads that call paid for: ${fixed.cost.readLog} ${JSON.stringify(fixed.cost)}`);
  console.log(`    durable: ${JSON.stringify(fixed.outcome)}`);

  // THE PRECONDITION, and it is not decoration. "One read" is trivially true of
  // a `record()` that compacted nothing — the size check alone is one read — so
  // without evidence that the compaction really ran inside this call, the
  // verdict below would pass just as green against a daemon that had stopped
  // compacting altogether.
  verdict(
    fixed.before === ROWS && fixed.after === AGENTS + 1,
    `the compaction really happened inside that recordActivated(): ${ROWS} records became\n` +
    `    ${AGENTS + 1}. Without this the read count below would be a claim about a call that\n` +
    '    did no compacting.',
    `no compaction ran: ${fixed.before} records → ${fixed.after}`
  );
  verdict(
    fixed.cost.readLog === 1,
    'and it cost ONE whole-log read — the one `compactIfLarge` was taking anyway to decide\n' +
    '    whether to compact. The rows it read are handed to the preserve sets rather than\n' +
    '    re-read by each of them, so an activation waiting on a compaction waits for one\n' +
    '    parse instead of four.',
    `the activation paid for ${fixed.cost.readLog} whole-log read(s): ${JSON.stringify(fixed.cost)}`
  );

  // The contrast, so the "1" above is legible as "the size check and nothing
  // else" rather than as a number with no scale.
  const smallFile = path.join(TMP, 'no-compaction-reads.jsonl');
  const { Counting: SmallCounting, reads: smallReads } = counting(AgentRegistry);
  const small = new SmallCounting(smallFile);
  small.recordActivated({ path: owned('reads', 'small'), config: knobs() });
  smallReads.readLog = 0;
  smallReads.intents = 0;
  small.recordActivated({ path: owned('reads', 'small-2'), config: knobs() });
  console.log(`\n  a record() BELOW the threshold: ${smallReads.readLog} read(s) — the size check`);

  const directFile = path.join(TMP, 'direct-compact-reads.jsonl');
  seedLog(directFile, ROWS, AGENTS);
  const { Counting: DirectCounting, reads: directReads } = counting(AgentRegistry);
  const direct = new DirectCounting(directFile);
  directReads.readLog = 0;
  const directOutcome = direct.compact();
  // Captured before anything else touches the registry — the console.log below
  // reads the log to say how many records are left, and counting that would be
  // this section measuring itself.
  const directCost = directReads.readLog;
  console.log(`  a direct compact() with no argument: ${directCost} read(s), ` +
    `ok=${directOutcome.ok}, ${direct.readLog().length} records left`);

  verdict(
    smallReads.readLog === 1 && directCost === 1 && directOutcome.ok === true,
    'a record() that does NOT compact pays the same one read, and a direct compact() with\n' +
    '    no map to hand it reads once for itself — so the argument is a way to share a read\n' +
    '    the caller already paid for, not a second code path with its own answer.',
    `off-path reads disagree: below-threshold ${smallReads.readLog}, direct compact ` +
    `${directCost}`
  );

  // -- 14b. the assertion can fail: the pre-fix shape, restored --------------
  //
  // WHAT WOULD HAVE TO BE TRUE for §14 to pass while the defect is back: the
  // preserve sets would have to be re-reading the log and the counter not
  // seeing it. So put the re-reads back and watch the number go to four. The
  // mutation is exactly the pre-fix shape the ticket describes — three helpers
  // that each call `intents()` — rather than an invented breakage.
  mutation14: {
    console.log('\n  14b. and the count is a measurement rather than a formality:\n');
    const mutantDir = mutate('compact-re-reads-the-log', [
      { file: 'agent-registry.js',
        find: 'AgentRegistry.configuredToPreserve(intents)',
        replace: 'AgentRegistry.configuredToPreserve(this.intents())' },
      { file: 'agent-registry.js',
        find: 'AgentRegistry.activatedToPreserve(intents)',
        replace: 'AgentRegistry.activatedToPreserve(this.intents())' },
      { file: 'agent-registry.js',
        find: 'AgentRegistry.standbyToPreserve(intents)',
        replace: 'AgentRegistry.standbyToPreserve(this.intents())' }
    ]);
    if (!mutantDir) break mutation14;

    const { AgentRegistry: PreFix } = await import(path.join(mutantDir, 'agent-registry.js'));
    const mutant = activationCost(PreFix, path.join(TMP, 'compaction-reads-prefix.jsonl'));
    const mutantRows = mutant.reg.readLog().map((e) => `${e.event} ${path.basename(e.path)}`).sort();

    console.log(`  the pre-fix build, same fixture: ${mutant.cost.readLog} whole-log reads ` +
      `${JSON.stringify(mutant.cost)}`);
    console.log(`    and it compacted identically: ${mutant.before} records → ${mutant.after}`);

    verdict(
      mutant.cost.readLog === 4,
      'restoring the three `intents()` calls takes the same activation from ONE whole-log\n' +
      '    read to FOUR — the count in §14 is measuring the code and would have gone red on\n' +
      '    the build this change replaces.',
      `the pre-fix build did not cost four reads (${mutant.cost.readLog}) — either the mutation\n` +
      `    missed the call sites or the counter is not seeing what it claims to`
    );
    verdict(
      JSON.stringify(mutantRows) === JSON.stringify(keptRows) && mutant.after === fixed.after,
      'and the two builds keep the SAME rows — so what changed is how many times the log is\n' +
      '    read, not what compaction decides. A read-count fix that also moved a row would be\n' +
      '    a behaviour change wearing a performance fix\'s clothes.',
      `the mutant compacted to something else: ${JSON.stringify(mutantRows)} vs ` +
      `${JSON.stringify(keptRows)}`
    );
  }
}

// --------------------------------------- 15. what missingAgents is ordered by --
rule('15. THE missingAgents ORDER RANKS ACTIVATION, NOT NEGLECT (KAN-96 AC 2)');

{
  console.log('The open question this closes: `missingAgents` is paged newest-first, on the');
  console.log('reasoning that the oldest rows are the least urgent. That is right for');
  console.log('standbyAgents — the thing you just switched off is the thing you want back —');
  console.log('and it was argued to be BACKWARDS for a loss, because an agent nobody has');
  console.log('restored in three days is the MOST neglected, not the least.\n');
  console.log('It is a good argument about a field this row does not have. What is measured');
  console.log('below is what `since` actually is, because the decision rests on it.\n');

  const longLived = owned('order', 'long-lived');
  const justStarted = owned('order', 'just-started');
  const reg = new AgentRegistry(path.join(TMP, 'ordering.jsonl'));

  // One agent activated years ago, one activated a moment ago. herdr reports
  // NEITHER — so both are discovered missing by the same census, in the same
  // instant. Whatever separates these two rows, it is not when they went.
  const LONG_AGO = '2020-01-01T00:00:00.000Z';
  reg.recordActivated({ path: longLived, config: knobs({ label: 'up since 2020' }) }, LONG_AGO);
  reg.recordActivated({ path: justStarted, config: knobs({ label: 'started just now' }) });

  const bridge15 = stubHerdr([]);
  let sent15;
  const router15 = new MessageRouter({
    config, herdrBridge: bridge15,
    daemonStartedAt: new Date(), agentRegistry: reg,
    send: (msg) => { sent15 = msg; }, broadcast: () => {}
  });
  router15.handle({ action: 'list_agents' });

  const rows = sent15.missingAgents;
  const observedAt = sent15.provenance?.observedAt;
  console.log(`  one census at ${observedAt} found both agents absent:\n`);
  for (const row of rows) {
    console.log(`    ${row.label.padEnd(18)} since ${row.since}  ${path.basename(row.path)}`);
  }

  // Every timestamp-shaped field on the row, so "there is no missing-since" is
  // read off the payload rather than asserted from memory.
  const timeFields = Object.entries(rows[0])
    .filter(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v))
    .map(([k]) => k);
  console.log(`\n  timestamp fields on a missingAgents row: ${JSON.stringify(timeFields)}`);

  const older = rows.find((r) => r.path === longLived);
  const newer = rows.find((r) => r.path === justStarted);
  const spreadYears =
    (new Date(newer.since) - new Date(older.since)) / (365 * 24 * 60 * 60 * 1000);
  console.log(`  the two rows' \`since\` values are ${spreadYears.toFixed(1)} years apart, and both`);
  console.log(`  losses were observed in the same call.`);

  verdict(
    older.since === LONG_AGO && timeFields.length === 1 && timeFields[0] === 'since',
    '`since` is the ACTIVATION timestamp — 2020, for an agent this daemon noticed was gone\n' +
    '    seconds ago — and it is the row\'s ONLY timestamp. Nothing here records when the\n' +
    '    agent went missing, because nothing in this daemon knows: a loss is a comparison\n' +
    '    against a census taken now, and the sweep\'s latch is a Set of paths with no time\n' +
    '    on it that a restart forgets.',
    `the row's timestamps were ${JSON.stringify(timeFields)} with since=${older.since}`
  );
  verdict(
    rows.length === 2 && rows[0].path === justStarted && rows[1].path === longLived &&
      spreadYears > 1,
    'so the newest-first order ranks these two by how long ago they were ACTIVATED, while\n' +
    '    they were lost in the same instant. Flipping it would not rank by neglect — it\n' +
    '    would put the fleet\'s longest-lived agents first while reading as a claim about\n' +
    '    down-time the data cannot support. The order stays newest-first, the reason is in\n' +
    '    router.ts beside the decision, and the field that would have reopened it was weighed\n' +
    '    and declined by KAN-189 — measured in 15c below, not merely asserted here.',
    `the category was not newest-first over activation times: ${JSON.stringify(
      rows.map((r) => [path.basename(r.path), r.since])
    )}`
  );
  verdict(
    sent15.missingTotal === 2 && sent15.pages?.missingAgents?.nextCursor === null,
    'and the half of the original complaint that WAS about reachability is answered rather\n' +
    '    than argued: the category is paged, `total` states its size and `nextCursor` says\n' +
    '    whether anything is past this page — null here because both rows fit. No row is\n' +
    '    unreachable at any position, whatever the order.',
    `the paging handle is missing from the response: ${JSON.stringify(sent15.pages?.missingAgents)}`
  );

  // -- 15b. the decision is enforced, not merely written down ----------------
  //
  // The honest thing to say about the section above is that it would pass just
  // as green against the build this change replaces: nothing about the ordering
  // BEHAVIOUR changed here, only the reasoning, and a comment cannot be
  // asserted on without pinning prose. What CAN be pinned is the decision — so
  // flip the comparator and watch the verdict above go red. That is the
  // difference between a decision recorded in a file and a decision a later
  // slice cannot quietly reverse.
  mutation15: {
    console.log('\n  15b. and the ordering above is enforced rather than merely described:\n');
    const mutantDir = mutate(
      'missing-agents-oldest-first',
      'router.js',
      'const byTime = b.w.localeCompare(a.w);',
      'const byTime = a.w.localeCompare(b.w);'
    );
    if (!mutantDir) break mutation15;

    // The ROUTER comes from the mutant; the bridge and the registry are the
    // ones every other section uses. That is the same wiring
    // verify-fleet-enumeration's mutant sections use, and it is deliberate:
    // only the comparator is different between this run and the one above, so
    // a change in the order is attributable to it and to nothing else.
    const { MessageRouter: Flipped } = await import(path.join(mutantDir, 'router.js'));
    let sent15b;
    const flipped = new Flipped({
      config, herdrBridge: stubHerdr([]),
      daemonStartedAt: new Date(), agentRegistry: reg,
      send: (msg) => { sent15b = msg; }, broadcast: () => {}
    });
    flipped.handle({ action: 'list_agents' });
    const flippedRows = sent15b.missingAgents;
    console.log(`  with the comparator flipped: ` +
      `${flippedRows.map((r) => path.basename(r.path)).join(', ')}`);

    verdict(
      flippedRows.length === 2 && flippedRows[0].path === longLived,
      'reversing the sort really does reverse this category, so the verdict above is a\n' +
      '    measurement of the order rather than a restatement of it — a later slice that\n' +
      '    flips it, for the reason this ticket weighed and rejected, turns §15 red and has\n' +
      '    to come here and say why.',
      `the flipped build produced the same order (${flippedRows.map((r) => path.basename(r.path)).join(', ')}) —\n` +
      `    which means §15's ordering verdict is not sensitive to the comparator and proves nothing`
    );
  }

  // -- 15c. the field that would have reopened this, BUILT and declined ------
  //
  // WHAT §15 LEAVES OPEN, and it is the whole reason this sub-section exists.
  // §15 measures that the row has one timestamp and that it is the activation
  // time. It says nothing about whether the row COULD have a second one, and a
  // reader is entitled to suspect that "nothing records when it went missing"
  // is a limitation being reported as a decision. KAN-189 asked the question
  // properly — record a durable first-observed-missing time, or not — and
  // answered NO. This section is what makes that answer legible as a choice.
  //
  // SO THE MUTANT IS THE REJECTED DESIGN, in its cheapest honest form: seven
  // lines in the row builder that stamp the first observation, keep it in a
  // file beside the registry, and hand it back as `missingSince`. It is not a
  // synthetic break. It works. Three things are then measured, and only the
  // third is about the mutant at all:
  //
  //   1. THE SHIPPED BUILD KEEPS NOTHING. Two producers compute this category
  //      — a request (`list_agents`) and the sweep (`findMissingAgents`) — and
  //      they return identical rows on a router that has never swept, because
  //      neither remembers anything. A "restart" (a second router over the
  //      same registry file) reports the same row, and not one byte appears
  //      under the registry's directory or the dataDir in the process.
  //   2. THE MUTANT KEEPS IT, AND KEEPING IT IS WHAT MAKES IT SURVIVE. Its
  //      `missingSince` is unchanged across the same restart — and when the
  //      file it lives in is DELETED, the next observation stamps a new one.
  //      That is the restart-survival claim shown able to fail, in the only
  //      way it can fail: with the persistence taken away.
  //   3. §15's OWN SHAPE VERDICT GOES RED under it. The row grows a second
  //      timestamp and the check three verdicts up stops passing. So a later
  //      slice that lands this field cannot land it quietly — it turns this
  //      script red and has to come here and answer the four grounds on
  //      `MissingAgent.since`.
  //
  // THE PRECONDITION. A mutant that died on startup produces "no second
  // timestamp appeared", which is exactly what a well-behaved SHIPPED build
  // produces — the observation would be the same and the conclusion inverted.
  // So the mutant is caught doing two things only the mutant does, asserted as
  // positive facts before anything below is read: a row carrying an ISO
  // `missingSince`, and a file on disk naming the missing agent's path.
  //
  // WHAT THIS SECTION DOES NOT COVER, marked because a section about an
  // artifact outrunning its mechanism is the worst possible place to do it:
  //
  //   * IT SUPPLIES ITS OWN INPUT. The registry rows are written here and the
  //     herdr is this file's stub, so nothing about a REAL restart of a REAL
  //     daemon is established by it. It does not need to be: the claims are
  //     about the shape of a payload and the absence of a store, both of which
  //     are properties of the compiled build. Real restart behaviour is
  //     `verify-restart-survival.mjs` (CI) and `verify-fleet-switch-live.mjs`
  //     §3 (live, by hand), and neither of those covers this.
  //   * IT DOES NOT SHOW THE DECISION WAS RIGHT. It shows it was a decision.
  //     The grounds are prose on `MissingAgent.since` and prose cannot be
  //     asserted on; what can be, and is, is that the alternative was reachable
  //     and that the shipped build does not take it.
  console.log('\n  15c. the durable first-observed-missing field, built and declined (KAN-189):\n');

  /** Every file under a root, sorted — so "nothing was written" is a diff. */
  const treeOf = (root) => {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else out.push(child);
      }
    };
    walk(root);
    return out.sort();
  };

  /**
   * One observation of one loss, through both producers.
   *
   * `Router` is a parameter because this runs against the shipped build and
   * against the mutant, and the two must be measured by the SAME code — a
   * second copy of this function for the mutant is how a difference in the
   * harness gets reported as a difference in the daemon.
   */
  const observeLoss = (Router, registry, targetPath) => {
    let sent;
    const router = new Router({
      config,
      herdrBridge: stubHerdr([]),
      daemonStartedAt: new Date(),
      agentRegistry: registry,
      send: (msg) => { sent = msg; },
      broadcast: () => {}
    });
    router.handle({ action: 'list_agents' });
    return {
      requested: sent.missingAgents.find((row) => row.path === targetPath),
      swept: router.findMissingAgents().find((row) => row.path === targetPath)
    };
  };

  const stamps = (row) =>
    Object.entries(row ?? {})
      .filter(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v))
      .map(([k]) => k)
      .sort();

  // ---- 1. the shipped build keeps nothing -----------------------------------
  const shippedDir = owned('closure', 'shipped');
  const shippedRegistryFile = path.join(TMP, 'closure-shipped.jsonl');
  const shippedReg = new AgentRegistry(shippedRegistryFile);
  shippedReg.recordActivated({ path: shippedDir, config: knobs({ label: 'lost, and stays lost' }) });

  const before = [...treeOf(TMP), ...treeOf(dataDir)];
  const firstLook = observeLoss(MessageRouter, shippedReg, shippedDir);
  // THE RESTART: a new registry object over the same file and a new router,
  // which is all a daemon restart is to this computation — the file survives,
  // every in-memory latch does not.
  const afterRestart = observeLoss(
    MessageRouter, new AgentRegistry(shippedRegistryFile), shippedDir
  );
  const written = [...treeOf(TMP), ...treeOf(dataDir)].filter((f) => !before.includes(f));

  console.log(`  request row timestamps:            ${JSON.stringify(stamps(firstLook.requested))}`);
  console.log(`  sweep row identical to it:         ${JSON.stringify(firstLook.swept) === JSON.stringify(firstLook.requested)}`);
  console.log(`  same row after a restart:          ${JSON.stringify(afterRestart.requested) === JSON.stringify(firstLook.requested)}`);
  console.log(`  files written by observing a loss: ${written.length ? JSON.stringify(written) : '(none)'}`);

  verdict(
    firstLook.requested !== undefined &&
      JSON.stringify(firstLook.swept) === JSON.stringify(firstLook.requested) &&
      JSON.stringify(afterRestart.requested) === JSON.stringify(firstLook.requested) &&
      stamps(firstLook.requested).join(',') === 'since' &&
      written.length === 0,
    'the shipped build OBSERVES a loss and REMEMBERS nothing: the request and the sweep\n' +
    '    return the identical row from one computation each, a restart reproduces it byte for\n' +
    '    byte, and observing it twice writes nothing to disk. There is no store to order this\n' +
    '    category by, and that is the state KAN-189 chose to leave in place.',
    `requested=${JSON.stringify(firstLook.requested)}\n` +
    `    swept-matches=${JSON.stringify(firstLook.swept) === JSON.stringify(firstLook.requested)} ` +
    `restart-matches=${JSON.stringify(afterRestart.requested) === JSON.stringify(firstLook.requested)} ` +
    `stamps=${JSON.stringify(stamps(firstLook.requested))} written=${JSON.stringify(written)}`
  );

  // ---- 2 and 3. the rejected design, running ---------------------------------
  mutation15c: {
    const mutantDir = mutate(
      'durable-missing-since',
      'router.js',
      "                ...configEcho(intent, 'summarised'),\n" +
      '                since: intent.at,\n' +
      '                // Both cases are',
      "                ...configEcho(intent, 'summarised'),\n" +
      '                since: intent.at,\n' +
      '                missingSince: (() => {\n' +
      "                    const store = this.deps.agentRegistry.path + '.missing-observations.json';\n" +
      '                    let seen = {};\n' +
      "                    try { seen = JSON.parse(fs.readFileSync(store, 'utf8')); } catch { }\n" +
      '                    if (!seen[agentPath]) {\n' +
      '                        seen[agentPath] = new Date().toISOString();\n' +
      '                        fs.writeFileSync(store, JSON.stringify(seen));\n' +
      '                    }\n' +
      '                    return seen[agentPath];\n' +
      '                })(),\n' +
      '                // Both cases are'
    );
    // Already a counted failure. Skip rather than assert about an unmutated build.
    if (!mutantDir) break mutation15c;

    let Recording = null;
    let importError = null;
    try {
      ({ MessageRouter: Recording } = await import(path.join(mutantDir, 'router.js')));
    } catch (err) {
      importError = err?.message ?? String(err);
    }
    verdict(
      typeof Recording === 'function',
      '(setup) the mutated build imports — a mutant that died on startup would produce\n' +
      '    exactly the observations below and prove the opposite of what they say',
      `the mutant did not import: ${importError ?? 'MessageRouter was not a constructor'}`
    );
    if (typeof Recording !== 'function') break mutation15c;

    const recDir = owned('closure', 'recording');
    const recRegistryFile = path.join(TMP, 'closure-recording.jsonl');
    const recReg = new AgentRegistry(recRegistryFile);
    recReg.recordActivated({ path: recDir, config: knobs({ label: 'lost, and timed' }) });
    const store = `${recRegistryFile}.missing-observations.json`;

    const stamped = observeLoss(Recording, recReg, recDir);
    const storeAfter = fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : null;

    console.log(`\n  under the mutant — row timestamps: ${JSON.stringify(stamps(stamped.requested))}`);
    console.log(`  the store it wrote:                ${storeAfter ?? '(no file)'}`);

    // THE FINGERPRINT: two things only this build produces. Asserted before
    // anything is concluded from the mutant's behaviour.
    const fingerprint =
      typeof stamped.requested?.missingSince === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(stamped.requested.missingSince) &&
      storeAfter !== null &&
      storeAfter.includes(recDir);
    verdict(
      fingerprint,
      '(setup) the mutant really ran: the row carries an ISO `missingSince` the shipped build\n' +
      '    has never produced, and a file beside the registry names the missing directory',
      `missingSince=${JSON.stringify(stamped.requested?.missingSince)} store=${storeAfter ?? '(no file)'}`
    );
    if (!fingerprint) break mutation15c;

    // The restart, and then the same restart with the persistence removed.
    // Five milliseconds so a re-stamp cannot land in the same millisecond and
    // be mistaken for a survival.
    await new Promise((r) => setTimeout(r, 5));
    const survived = observeLoss(Recording, new AgentRegistry(recRegistryFile), recDir);
    fs.rmSync(store, { force: true });
    await new Promise((r) => setTimeout(r, 5));
    const withoutStore = observeLoss(Recording, new AgentRegistry(recRegistryFile), recDir);

    console.log(`  first observation:                 ${stamped.requested.missingSince}`);
    console.log(`  after a restart (store intact):    ${survived.requested.missingSince}`);
    console.log(`  after a restart (store deleted):   ${withoutStore.requested.missingSince}`);

    verdict(
      survived.requested.missingSince === stamped.requested.missingSince &&
        withoutStore.requested.missingSince !== stamped.requested.missingSince,
      'the rejected design WORKS, and its restart survival is carried by the file and by\n' +
      '    nothing else: the timestamp is unchanged across a restart, and deleting the store\n' +
      '    makes the next observation stamp a new one. So "it survives a restart" is a claim\n' +
      '    this suite can turn red, and KAN-189 declined the field on worth and on kind rather\n' +
      '    than on feasibility — the grounds are on `MissingAgent.since`.',
      `first=${stamped.requested.missingSince} restart=${survived.requested.missingSince} ` +
      `store-deleted=${withoutStore.requested.missingSince}`
    );

    verdict(
      stamps(stamped.requested).join(',') === 'missingSince,since' &&
        stamps(firstLook.requested).join(',') === 'since',
      "and §15's shape verdict is a MEASUREMENT of the shipped row rather than a restatement\n" +
      '    of it: the same test that reads one timestamp off the shipped build reads two off\n' +
      '    this one. A later slice that lands `missingSince` turns §15 red and has to come\n' +
      '    here and answer the four grounds instead of adding a field nobody notices.',
      `mutant stamps=${JSON.stringify(stamps(stamped.requested))} ` +
      `shipped stamps=${JSON.stringify(stamps(firstLook.requested))}`
    );
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
