#!/usr/bin/env node
// Live proof for KAN-125: the state read echoes back what an agent is actually
// configured with — on EVERY fleet category, not only the healthy rows — plus
// `unstartedAgents` and `configVersion`.
//
// THE PROBLEM THIS EXISTS FOR, stated once so the sections below read as
// answers rather than as arbitrary scenarios:
//
//   A consumer that cannot read back what an agent is running with has to keep
//   a shadow copy of what it asked for. Then the two can disagree with no way
//   to tell which is right — the drift detector becomes the drift.
//
// CrabCast already held the record and read it back nowhere: `agent_status`
// and `list_agents` reported liveness. Every value — priority, the three gate
// flags, launcher, prompt, mcpServers, label — was written on the durable
// record and echoed by nothing.
//
// THE FAILURE THIS SCRIPT IS SHAPED AROUND is a category that silently omits
// the attributes. A consumer reading `agents` would see the echo, conclude the
// API has it, and then find `standbyAgents` answering nothing about the agent
// it is deciding whether to restart. So every category is PRODUCED here —
// running, missing, standby, unstarted, preempted, foreign, unbacked — and
// each is asserted non-empty before it is asserted correct, because a
// completeness check over an empty list passes vacuously and proves nothing.
//
// Sections:
//   1. every knob non-default, read back field for field through `status` and
//      `list` (the daemon-level half of AC 1; the CLI and MCP halves are 9)
//   2. every category carries the echo, each one produced rather than assumed
//   3. unstarted and standby side by side, and the different resume paths
//   4. the trap: reconfiguring a STOPPED agent is standby, never unstarted
//   5. configVersion — minted, monotonic, and carried by activate/deactivate
//   6. the echo survives a daemon restart, because it was never in memory
//   7. `provenance` is exhaustive: every key on every row is classified
//   8. THE CHECKS CAN FAIL — the compiled daemon is mutated and they go red
//   9. all four surfaces: socket, CLI and MCP against a real daemon, and a
//      real daemon restart in between
//
// Sections 1-8 drive the real MessageRouter, HerdrBridge and AgentRegistry
// with only the external `herdr` binary replaced by a stub on PATH. Section 9
// spawns a real daemon and drives the real CLI and the real MCP server.
//
// Usage:
//   npm run build
//   node scripts/verify-state-read-echoes-config.mjs [distDir]

import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { claudeTranscriptDir, hasRestorableConversation } = await import(path.join(distDir, 'resume.js'));
const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => {
  // `JSON.stringify(undefined)` is `undefined`, and `.replace` on that threw —
  // which took the whole run down mid-section under a mutation, so sections
  // after it never reported at all. The exit code stayed 1 so CI was never
  // wrong, but a script that dies silently past its halfway point is one whose
  // later assertions nobody can claim ran.
  const body = value === undefined ? '(undefined)' : JSON.stringify(value, null, 2);
  console.log(`   ${label}\n${String(body).replace(/^/gm, '     ')}`);
};

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan125-'));
const realPath = process.env.PATH;
const daemonPids = new Set();
function cleanup() {
  for (const pid of daemonPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(...parts) {
  const dir = path.join(tmp, 'owned', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// ----------------------------------------------------------------- the stub
//
// Only the external binary is replaced. `agent list` prints whatever
// CENSUS_FILE holds, which is how every fleet state below is produced without
// a terminal multiplexer: the census IS what the daemon joins its registry
// against.

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ "$(cat ${JSON.stringify(CENSUS_FILE)})" = "DOWN" ]; then
    echo 'herdr: could not connect to the herdr server' >&2
    exit 1
  fi
  cat ${JSON.stringify(CENSUS_FILE)}
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then
  echo '{"error":{"code":"agent_not_found","message":"no such agent"}}'
  exit 1
fi
echo '{"result":{}}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;

function setCensus(payload) {
  fs.writeFileSync(
    CENSUS_FILE,
    payload === 'DOWN'
      ? 'DOWN'
      : JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: payload } })
  );
}
setCensus([]);

/** A live pane of OURS in a directory: the name that path derives, plus a runtime. */
const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
/** A live pane that is somebody else's. Its name is not one we would ever mint. */
const foreignPane = (dir, paneId, name = 'butchr-task-kan-77') => ({
  name, pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
/** One of ours with nothing behind it: the name is registered, the agent is gone. */
const emptyOurPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent_status: 'unknown', cwd: dir
});

/**
 * A router over a named registry file, so a section can rebuild one over the
 * SAME file and call it a daemon restart.
 */
function harness(logName, RouterCtor = MessageRouter, RegistryCtor = AgentRegistry) {
  const agentRegistry = new RegistryCtor(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const events = [];
  const invoke = (request) =>
    new Promise((resolve) => {
      const router = new RouterCtor({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: (msg) => events.push(msg)
      });
      router.handle(request);
    });
  return { agentRegistry, bridge, events, invoke };
}

// ---------------------------------------------------------------- the fixture
//
// NON-DEFAULT ON EVERY KNOB, which is the whole of criterion 1: a field that
// happens to match its default proves nothing about whether it was echoed or
// re-derived. `priority` is not 1, the launcher is not the default `claude`,
// the prompt is real text rather than absent, mcpServers is not empty, the
// label is set, and two of the three gate flags are off.
//
// `chargeable: true` with `preemptable: false` rather than all three false:
// `chargeable: false` with `preemptable: true` is refused as incoherent, so
// this is the non-default combination the API actually accepts.
const KNOBS = {
  priority: 7,
  refusable: false,
  chargeable: true,
  preemptable: false,
  launcher: 'shell',
  prompt: 'KAN-125: read this back to me, byte for byte.',
  // A MAP of definitions keyed by name (KAN-111), not the array of names this
  // used to be. Both forms of the union are used on purpose: `'builtin'` is the
  // one entry CrabCast constructs itself, and the other is a caller's own JSON
  // that must come back byte for byte. The echo is of the SPEC rather than of
  // the expansion — what `configure` was handed, not what provisioning makes of
  // it — which is exactly what a caller diffing against its desired state needs.
  mcpServers: {
    crabcast: 'builtin',
    'kan125-example': {
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://example.invalid/mcp'],
      env: { KAN125: 'written verbatim' }
    }
  },
  label: 'the state read'
};

/** The knobs as they must come back: exactly what was sent. */
const EXPECTED_CONFIG = { ...KNOBS };

/** The same, for the one agent that has to run a runtime-bearing launcher. */
const UNBACKED_CONFIG = { ...KNOBS, launcher: 'claude' };

/**
 * Whether one row carries the whole echo, and carries the RIGHT values.
 *
 * Extracted so section 8 can run it against a deliberately broken daemon and
 * watch it go red. A check that cannot fail is not a check.
 */
function echoProblems(row, where, expected = EXPECTED_CONFIG) {
  const problems = [];
  if (!row) return [`${where}: the row itself is missing`];
  if (!row.config) {
    problems.push(`${where}: no \`config\` block at all`);
    return problems;
  }
  for (const [key, want] of Object.entries(expected)) {
    const got = row.config[key];
    // Structural for anything that is not a primitive: `mcpServers` is a map
    // of the caller's own JSON now, and `===` on two equal objects is false.
    const same =
      want !== null && typeof want === 'object'
        ? JSON.stringify(got) === JSON.stringify(want)
        : got === want;
    if (!same) problems.push(`${where}: config.${key} is ${JSON.stringify(got)}, configured ${JSON.stringify(want)}`);
  }
  for (const extra of Object.keys(row.config)) {
    if (!(extra in expected)) problems.push(`${where}: config.${extra} was never configured`);
  }
  if (typeof row.configVersion !== 'number') {
    problems.push(`${where}: configVersion is ${JSON.stringify(row.configVersion)}, not a number`);
  }
  if (typeof row.configuredAt !== 'string') {
    problems.push(`${where}: configuredAt is ${JSON.stringify(row.configuredAt)}, not a timestamp`);
  }
  if (typeof row.everActivated !== 'boolean') {
    problems.push(`${where}: everActivated is ${JSON.stringify(row.everActivated)}, not a boolean`);
  }
  return problems;
}

// ===========================================================================
rule('1. every knob non-default, read back field for field — `status` and `list`');
// ===========================================================================
//
// Configure with a non-default value for every knob, activate, and read the
// whole record back. The comparison is against the object that was SENT, so a
// value quietly re-derived from anywhere else fails it.

const runningDir = ownedDir('s1', 'running');
{
  const h = harness('s1');
  const configured = await h.invoke({ action: 'configure_agent', path: runningDir, ...KNOBS });
  show('configure_agent:', configured);

  check(configured.success === true, 'configure accepted every knob');
  check(
    configured.configVersion === 1,
    'and answered configVersion 1 — the token exists from the first accepted configure',
    `configVersion: ${configured.configVersion}`
  );
  check(
    typeof configured.configuredAt === 'string',
    'with the time it was frozen, which is not the same question as when it last ran'
  );

  // Ours is live in the census, so this is the `alreadyRunning` path: no PTY,
  // no real terminal, and the agent is nonetheless genuinely running by the
  // one ownership test this daemon has.
  setCensus([ourPane(runningDir, '%10')]);
  const activated = await h.invoke({ action: 'activate_agent', path: runningDir });
  check(activated.success === true && activated.alreadyRunning === true,
    'the agent is running (census-confirmed, by the pane name its path derives)');
  check(
    echoProblems(activated, 'activate_response').length === 0,
    'and the activation response itself echoes the record',
    echoProblems(activated, 'activate_response').join('; ')
  );

  const status = await h.invoke({ action: 'agent_status', path: runningDir });
  show('agent_status:', status);
  const statusProblems = echoProblems(status, 'agent_status');
  check(statusProblems.length === 0,
    'STATUS reads back every knob, field for field, exactly as configured',
    statusProblems.join('; '));
  check(status.state === 'running', "and names the category: state 'running'", status.state);

  const listed = await h.invoke({ action: 'list_agents' });
  const row = listed.agents.find((a) => a.path === runningDir);
  show('list_agents → agents[0]:', row);
  const listProblems = echoProblems(row, 'list_agents.agents[]');
  check(listProblems.length === 0,
    'LIST reads back every knob on the running row, field for field',
    listProblems.join('; '));
  check(
    row?.state === status.state,
    'and the two reads agree about the category — one derivation, not two that can drift',
    `list ${row?.state} vs status ${status.state}`
  );
  // The pane id is the sharpest case of durable-versus-observed: it looks as
  // stable as `priority` on the wire and is not, because herdr renumbers panes
  // whenever any pane anywhere closes.
  const stored = h.agentRegistry.intents().get(runningDir).record;
  check(
    row.paneId === '%10' && status.paneId === '%10',
    'both reads report the pane id LIVE from the same census',
    `list ${row.paneId}, status ${status.paneId}`
  );
  check(
    !('paneId' in stored) && !('paneId' in (stored.config ?? {})),
    'and it is on NEITHER the durable record nor the config block — it is not configuration ' +
      'and is not stored as any',
    JSON.stringify(stored)
  );
}

// ===========================================================================
rule('2. every category carries the echo — and every category is PRODUCED');
// ===========================================================================
//
// The failure this task exists to prevent is a category that silently omits
// the attributes, so each one is made real here. Every assertion is preceded
// by a non-empty check: a completeness assertion over an empty list passes and
// proves nothing.

const cat = {
  running: ownedDir('s2', 'running'),
  missing: ownedDir('s2', 'missing'),
  standby: ownedDir('s2', 'standby'),
  unstarted: ownedDir('s2', 'unstarted'),
  preempted: ownedDir('s2', 'preempted'),
  occupied: ownedDir('s2', 'occupied'),
  unbacked: ownedDir('s2', 'unbacked')
};

{
  const h = harness('s2');
  const reg = h.agentRegistry;

  // Written through the REGISTRY rather than through the verbs, because
  // producing `preempted` and `missing` through the verbs would need a real
  // capacity squeeze and a real crash. The rows are the shapes the verbs
  // write — every one carries a version and a configure time, exactly as
  // `configure` mints them.
  const rec = (p, n) => ({
    path: p, config: { ...KNOBS }, configVersion: n, configuredAt: new Date().toISOString()
  });
  reg.recordConfigured(rec(cat.running, 1));
  reg.recordActivated(rec(cat.running, 1));
  reg.recordConfigured(rec(cat.missing, 1));
  reg.recordActivated(rec(cat.missing, 1));
  reg.recordConfigured(rec(cat.standby, 1));
  reg.recordActivated(rec(cat.standby, 1));
  reg.recordDeactivated(rec(cat.standby, 1));
  reg.recordConfigured(rec(cat.unstarted, 1));
  reg.recordConfigured(rec(cat.preempted, 1));
  reg.recordActivated(rec(cat.preempted, 1));
  reg.recordDeactivated(rec(cat.preempted, 1), {
    path: cat.preempted, paneName: paneNameFor(cat.preempted), priority: 7,
    herdrStatus: 'working', byPath: '/tmp/whoever', byPaneName: 'crabcast-whoever-0',
    byPriority: 9, at: new Date().toISOString(), derivation: 'the arithmetic that took it'
  });
  reg.recordConfigured(rec(cat.occupied, 1));
  // A `shell` agent CANNOT have an unbacked pane — a bare prompt with nothing
  // running in it is what `shell` delivers, and `ourPaneIn` claims it as a live
  // agent. Only a runtime-bearing launcher can leave a pane with nothing behind
  // it, so this one is configured `claude` and checked against those knobs.
  reg.recordConfigured({ ...rec(cat.unbacked, 1), config: UNBACKED_CONFIG });
  reg.recordActivated({ ...rec(cat.unbacked, 1), config: UNBACKED_CONFIG });

  setCensus([
    ourPane(cat.running, '%20'),
    // `missing` is recorded active and simply is not here — a loss.
    // `standby`, `unstarted`, `preempted` are down, which is what they mean.
    foreignPane(cat.occupied, '%21'),
    emptyOurPane(cat.unbacked, '%22')
  ]);

  const listed = await h.invoke({ action: 'list_agents' });
  show('list_agents (categories only):', {
    agents: listed.agents.map((a) => a.path),
    missingAgents: listed.missingAgents.map((a) => a.path),
    standbyAgents: listed.standbyAgents.map((a) => a.path),
    unstartedAgents: listed.unstartedAgents.map((a) => a.path),
    preemptedAgents: listed.preemptedAgents.map((a) => a.path),
    foreignPanes: listed.foreignPanes.map((p) => `${p.paneName} occupies ${p.occupies}`),
    unbackedPanes: listed.unbackedPanes.map((p) => p.path)
  });

  const categories = [
    ['agents', listed.agents.find((a) => a.path === cat.running)],
    ['missingAgents', listed.missingAgents.find((a) => a.path === cat.missing)],
    ['standbyAgents', listed.standbyAgents.find((a) => a.path === cat.standby)],
    ['unstartedAgents', listed.unstartedAgents.find((a) => a.path === cat.unstarted)],
    ['preemptedAgents', listed.preemptedAgents.find((a) => a.path === cat.preempted)],
    ['unbackedPanes', listed.unbackedPanes.find((a) => a.path === cat.unbacked), UNBACKED_CONFIG],
    // A foreign pane has no configuration of its own. What it carries is OUR
    // agent for the directory it is sitting in — the one whose activation it
    // will refuse — nested so the two cannot be confused.
    ['foreignPanes[].occupiedAgent',
      listed.foreignPanes.find((p) => p.occupies === cat.occupied)?.occupiedAgent]
  ];

  for (const [name, row, expected] of categories) {
    if (!check(Boolean(row), `${name} is NON-EMPTY — the state was produced, not assumed`)) continue;
    const problems = echoProblems(row, name, expected ?? EXPECTED_CONFIG);
    check(problems.length === 0, `${name} carries the whole echo with the configured values`,
      problems.join('; '));
  }

  // And the one row that must NOT claim a configuration, because it has none.
  const strangerDir = ownedDir('s2', 'stranger');
  setCensus([
    ourPane(cat.running, '%20'),
    foreignPane(cat.occupied, '%21'),
    emptyOurPane(cat.unbacked, '%22'),
    foreignPane(strangerDir, '%23', 'butchr-task-kan-80')
  ]);
  const withStranger = await h.invoke({ action: 'list_agents' });
  const unowned = withStranger.foreignPanes.find((p) => p.paneName === 'butchr-task-kan-80');
  show('a foreign pane in a directory we hold NO record for:', unowned);
  check(
    unowned?.occupies === null && unowned?.occupiedAgent === null,
    'a foreign pane in a directory we have no record for carries an explicit null rather ' +
      'than an invented configuration — and never a bare `config`, which would read as the ' +
      "stranger's own",
    JSON.stringify({ occupies: unowned?.occupies, occupiedAgent: unowned?.occupiedAgent })
  );
}

// ===========================================================================
rule('3. unstarted and standby, side by side, and their different resume paths');
// ===========================================================================
//
// The distinction is BEHAVIOURAL rather than taxonomic, and this is where that
// is shown rather than asserted: switching a standby agent back on resumes the
// conversation it was stopped in, and activating an agent that has never run
// starts a fresh one. Every standby row promises the first in as many words,
// so folding the two together makes that promise false for half the list.

const s3standby = ownedDir('s3', 'ran-and-stopped');
const s3unstarted = ownedDir('s3', 'never-ran');
{
  const h = harness('s3');
  const reg = h.agentRegistry;
  const claudeKnobs = { ...KNOBS, launcher: 'claude' };
  const rec = (p) => ({ path: p, config: { ...claudeKnobs }, configVersion: 1, configuredAt: new Date().toISOString() });

  reg.recordConfigured(rec(s3standby));
  reg.recordActivated(rec(s3standby));
  reg.recordDeactivated(rec(s3standby));
  reg.recordConfigured(rec(s3unstarted));

  setCensus([]);
  const listed = await h.invoke({ action: 'list_agents' });
  const standbyRow = listed.standbyAgents.find((a) => a.path === s3standby);
  const unstartedRow = listed.unstartedAgents.find((a) => a.path === s3unstarted);

  console.log('\n   the two rows, side by side:\n');
  show('standbyAgents[]:', standbyRow);
  show('unstartedAgents[]:', unstartedRow);

  check(Boolean(standbyRow), 'the agent that ran and stopped is in standbyAgents');
  check(Boolean(unstartedRow), 'the agent that was configured and never activated is in unstartedAgents');
  check(
    !listed.standbyAgents.some((a) => a.path === s3unstarted) &&
      !listed.unstartedAgents.some((a) => a.path === s3standby),
    'and neither is in the other list — one agent, one switch'
  );
  check(
    standbyRow?.everActivated === true && unstartedRow?.everActivated === false,
    'the machine-readable difference is `everActivated`, and it is on both rows',
    `standby ${standbyRow?.everActivated}, unstarted ${unstartedRow?.everActivated}`
  );
  check(
    /resumes the conversation/.test(standbyRow?.reason ?? '') &&
      /starts\s+a fresh one|starts a fresh/.test(unstartedRow?.reason ?? ''),
    'and the prose says the opposite thing about each, which is the promise being kept',
    `standby: ${standbyRow?.reason}\n          unstarted: ${unstartedRow?.reason}`
  );

  // ---- and now the resume paths themselves, through the real code ---------
  //
  // `claude --continue || claude <prompt>` is the command both would run. What
  // differs is what `--continue` finds, and `hasRestorableConversation`
  // (resume.ts) is the predictor the daemon uses to decide which framing the
  // agent gets. It reads Claude Code's own transcript directory for the path,
  // so an agent that has worked has one and an agent that has never run does
  // not. Seeded here as Claude Code writes it: a non-empty .jsonl.
  const transcriptDir = claudeTranscriptDir(s3standby);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, 'session-abc.jsonl'),
    JSON.stringify({ type: 'user', text: 'the conversation it was stopped in' }) + '\n'
  );

  const standbyHasHistory = hasRestorableConversation(s3standby);
  const unstartedHasHistory = hasRestorableConversation(s3unstarted);
  console.log(`\n   hasRestorableConversation(${s3standby}) = ${standbyHasHistory}`);
  console.log(`   hasRestorableConversation(${s3unstarted}) = ${unstartedHasHistory}`);
  check(
    standbyHasHistory === true && unstartedHasHistory === false,
    'the resume predictor answers differently for the two: there is a conversation to ' +
      'continue for one and nothing for the other'
  );

  // Through the bridge, which is what actually decides — and fed the SAME way
  // the router feeds it: `spawnSession`'s `ranBefore` argument is
  // `intent.everActivated`, read from the durable record (router.ts). That
  // wiring is KAN-111's resume rule taking this slice's field as its input, and
  // passing it here is what makes this an assertion about the daemon rather
  // than about a call the daemon never makes. Reading it out of the registry
  // rather than hardcoding true/false is the point: if the field were derived
  // wrongly, this would go red with it.
  const intents3 = h.agentRegistry.intents();
  const ranStandby = intents3.get(s3standby).everActivated;
  const ranUnstarted = intents3.get(s3unstarted).everActivated;
  const resumed = h.bridge.spawnSession(
    s3standby, claudeKnobs, claudeKnobs.prompt, 'daemon-restart', ranStandby
  );
  const fresh = h.bridge.spawnSession(
    s3unstarted, claudeKnobs, claudeKnobs.prompt, 'daemon-restart', ranUnstarted
  );
  console.log(`\n   everActivated from the record: standby=${ranStandby}, unstarted=${ranUnstarted}`);
  console.log(`   spawnSession(${path.basename(s3standby)}).resumedConversation   = ${resumed.resumedConversation}`);
  console.log(`   spawnSession(${path.basename(s3unstarted)}).resumedConversation = ${fresh.resumedConversation}`);
  check(
    resumed.resumedConversation === true && fresh.resumedConversation === false,
    'and the daemon TAKES the different path: the one that ran is handed its conversation ' +
      'and nudged to carry on; the one that never ran gets the fresh-start prompt instead',
    `standby ${resumed.resumedConversation}, unstarted ${fresh.resumedConversation}`
  );
  check(
    ranStandby === true && ranUnstarted === false,
    "and the input that decided it is this slice's own `everActivated`, read off the " +
      "durable record — the resume rule (KAN-111) and the fleet category are one fact"
  );
  h.bridge.abandonSession(resumed.sessionId, 'verify: done with this session');
  h.bridge.abandonSession(fresh.sessionId, 'verify: done with this session');
}

// ===========================================================================
rule('4. the trap: an agent that RAN and was then reconfigured is standby');
// ===========================================================================
//
// The obvious implementation of `unstartedAgents` is "last event is
// `configured`". It is wrong, and this is the case that shows it: reconfiguring
// a STOPPED agent writes a `configured` row, so an agent with a conversation on
// disk has that event. Calling it unstarted would put it in the list that
// promises a fresh start, which is the exact false promise the category was
// split off to prevent — the same bug, in the other direction.

const s4 = ownedDir('s4', 'ran-then-reconfigured');
{
  const h = harness('s4');
  setCensus([]);
  await h.invoke({ action: 'configure_agent', path: s4, ...KNOBS });
  h.agentRegistry.recordActivated({
    path: s4, config: { ...KNOBS }, configVersion: 1, configuredAt: new Date().toISOString()
  });
  h.agentRegistry.recordDeactivated({
    path: s4, config: { ...KNOBS }, configVersion: 1, configuredAt: new Date().toISOString()
  });
  const reconfigured = await h.invoke({ action: 'configure_agent', path: s4, ...KNOBS, priority: 3 });
  check(reconfigured.success === true && reconfigured.reconfigured === true,
    'reconfiguring a stopped agent is accepted, and its last event is now `configured`');
  check(
    h.agentRegistry.intents().get(s4).event === 'configured',
    'the naive test would therefore call it unstarted',
    `last event: ${h.agentRegistry.intents().get(s4).event}`
  );

  const listed = await h.invoke({ action: 'list_agents' });
  const status = await h.invoke({ action: 'agent_status', path: s4 });
  check(
    listed.standbyAgents.some((a) => a.path === s4) &&
      !listed.unstartedAgents.some((a) => a.path === s4),
    'it is reported as STANDBY — it has a conversation, and switching it on resumes it'
  );
  check(
    status.state === 'standby' && status.everActivated === true,
    "and `status` says the same word: state 'standby'",
    `state ${status.state}, everActivated ${status.everActivated}`
  );
  check(
    status.config.priority === 3 && status.configVersion === 2,
    'while the echo shows the NEW configuration and the bumped version',
    `priority ${status.config.priority}, configVersion ${status.configVersion}`
  );
  const stood = await h.invoke({ action: 'deactivate_agent', path: s4 });
  check(
    stood.state === 'standby',
    "and `deactivate` uses the same vocabulary rather than answering 'unstarted' for an " +
      'agent that has run',
    `state: ${stood.state}`
  );
}

// ===========================================================================
rule('5. configVersion — minted, monotonic, and carried by every later event');
// ===========================================================================

const s5 = ownedDir('s5', 'versioned');
{
  const h = harness('s5');
  setCensus([]);
  const first = await h.invoke({ action: 'configure_agent', path: s5, ...KNOBS });
  const second = await h.invoke({ action: 'configure_agent', path: s5, ...KNOBS, priority: 2 });
  const third = await h.invoke({ action: 'configure_agent', path: s5, ...KNOBS, priority: 3 });
  check(
    first.configVersion === 1 && second.configVersion === 2 && third.configVersion === 3,
    'each accepted configure bumps the version by one',
    `${first.configVersion} → ${second.configVersion} → ${third.configVersion}`
  );
  check(
    second.previousConfigVersion === 1 && third.previousConfigVersion === 2,
    'and each reconfigure reports the version it replaced, so a caller can see it move'
  );

  // Activate, then stand down. Neither is a configure, so neither may move the
  // token — and neither may LOSE it, which is the failure worth guarding: a
  // rebuilt record that dropped the field would reset the version to 1 on the
  // next read, and a compare-and-set token that goes backwards is worse than
  // no token at all.
  //
  // The activation row is written the way a confirmed spawn writes it. The
  // stub answers herdr's shapes but cannot deliver a real PTY, so a spawning
  // `activate` would correctly fail verification and record nothing — and what
  // is under test here is what the RECORD carries across events, not the spawn.
  h.agentRegistry.recordActivated(h.agentRegistry.intents().get(s5).record);

  setCensus([ourPane(s5, '%50')]);
  const activated = await h.invoke({ action: 'activate_agent', path: s5 });
  check(activated.alreadyRunning === true && activated.configVersion === 3,
    'activation carries the version forward unchanged',
    `configVersion: ${activated.configVersion}`);

  setCensus([]);
  await h.invoke({ action: 'deactivate_agent', path: s5 });
  const afterDown = await h.invoke({ action: 'agent_status', path: s5 });
  check(
    afterDown.configVersion === 3 && afterDown.config.priority === 3,
    'and so does the stand-down: the record travels whole through both verbs',
    `configVersion ${afterDown.configVersion}, priority ${afterDown.config.priority}`
  );

  // -- THE MERGE CASE, and it is new code that nobody had proven ------------
  //
  // T5 (KAN-127) made the idempotent `activate` CONVERGE a record that had
  // fallen behind: when the census shows our pane live and the record does not
  // say `activated`, that call writes the activation and reports
  // `recordReconciled`. It is the repair a supervisor makes after a durable
  // write failed.
  //
  // A converging write that loses a field is not a repair. The branch rebuilt
  // the record as `{path, config}` — the two fields it happened to have named
  // — which drops `configVersion` and `configuredAt`, and `intents()`
  // normalizes an absent version to 1. So the call whose whole job is fixing
  // the record would have silently reset the compare-and-set token to 1 on an
  // agent configured three times, and a reconciler diffing on it would see the
  // version go BACKWARDS. Neither slice has this defect alone; the merge of
  // the two is where it lives, which is why the case is here.
  {
    const behind = ownedDir('s5', 'record-behind');
    const b = harness('s5-behind');
    setCensus([]);
    await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS });
    await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS, priority: 2 });
    const third = await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS, priority: 3 });
    check(third.configVersion === 3, 'a record configured three times is at version 3');

    // The record says `configured` while our pane is live: exactly the state a
    // failed durable write leaves behind.
    setCensus([ourPane(behind, '%55')]);
    const repaired = await b.invoke({ action: 'activate_agent', path: behind });
    show('the converging activate:', {
      alreadyRunning: repaired.alreadyRunning,
      started: repaired.started,
      recordReconciled: repaired.recordReconciled,
      configVersion: repaired.configVersion,
      everActivated: repaired.everActivated
    });
    check(
      repaired.recordReconciled === true && repaired.alreadyRunning === true,
      "T5's converge path fired: the record was behind and this call settled it"
    );
    check(
      repaired.configVersion === 3,
      'and the version it reports is still 3 — the repair did not reset the token it repaired',
      `configVersion: ${repaired.configVersion}`
    );
    const written = b.agentRegistry.intents().get(behind);
    check(
      written.event === 'activated' && written.configVersion === 3 &&
        written.record.configuredAt === third.configuredAt,
      'the ROW it wrote carries the version and the configure time, not a rebuilt pair of ' +
        'fields — read back off the log rather than off the response',
      `${written.event}, v${written.configVersion}, configuredAt ${written.record.configuredAt}`
    );
    const after = await b.invoke({ action: 'agent_status', path: behind });
    check(
      after.configVersion === 3 && after.config.priority === 3 && after.everActivated === true,
      'and the state read agrees with all three of them afterwards',
      `v${after.configVersion}, priority ${after.config.priority}, everActivated ${after.everActivated}`
    );
  }

  // It also has to survive the log being rewritten, because compaction emits
  // one row per agent and a preserve set that dropped the field would reset
  // every version on a busy fleet.
  h.agentRegistry.compact();
  const afterCompact = await h.invoke({ action: 'agent_status', path: s5 });
  check(
    afterCompact.configVersion === 3 && afterCompact.everActivated === true,
    'and it survives COMPACTION, along with the fact that this agent has run',
    `configVersion ${afterCompact.configVersion}, everActivated ${afterCompact.everActivated}`
  );

  // -- A REFUSED CONFIGURE MUST NOT MOVE THE TOKEN --------------------------
  //
  // The property with the most weight on it and, until now, the least evidence:
  // it was true, and nothing anywhere asserted it. Mutating the refusal branch
  // to bump the version passed every script in the suite.
  //
  // It matters because the version is a COMPARE-AND-SET token and the next
  // slice builds a reconciler on it. A token that changes on a refusal tells a
  // caller its change landed when it did not — so the caller stops retrying,
  // and the agent keeps running the configuration nobody wanted. The refusal
  // says `applied: []`; the version has to say the same thing.
  {
    const refused = ownedDir('s5', 'refused-while-running');
    const r = harness('s5-refused');
    setCensus([]);
    await r.invoke({ action: 'configure_agent', path: refused, ...KNOBS });
    const before = await r.invoke({ action: 'configure_agent', path: refused, ...KNOBS, priority: 4 });
    check(before.configVersion === 2, 'a stopped agent reconfigures to version 2');

    // Live in the census, so `configure` refuses the whole call.
    setCensus([ourPane(refused, '%60')]);
    const no = await r.invoke({ action: 'configure_agent', path: refused, ...KNOBS, priority: 9 });
    show('the refused reconfigure:', {
      success: no.success, refused: no.refused, applied: no.applied,
      configVersion: no.configVersion, priority: no.config?.priority
    });
    check(no.success === false && no.refused === 'running' && no.applied?.length === 0,
      'reconfiguring a RUNNING agent is refused whole, applying nothing');
    check(
      no.configVersion === before.configVersion,
      'and the version it reports is UNCHANGED — a refusal that moved the token would tell ' +
        'a compare-and-set caller its write landed when nothing was applied',
      `${before.configVersion} → ${no.configVersion}`
    );
    check(
      no.config?.priority === 4,
      'and the config it reports is the one still in force, not the one that was refused',
      `priority ${no.config?.priority} (refused call asked for 9)`
    );
    const onDisk = r.agentRegistry.intents().get(refused);
    check(
      onDisk.configVersion === before.configVersion && onDisk.record.config.priority === 4,
      'and the RECORD is untouched — read off the log rather than off the response, because ' +
        'a response can say "unchanged" over a row that changed',
      `v${onDisk.configVersion}, priority ${onDisk.record.config.priority}`
    );
    setCensus([]);
  }
}

// ===========================================================================
rule('6. the echo survives a daemon restart — it was never in memory');
// ===========================================================================
//
// A second registry and a second router over the SAME log file is what a
// daemon restart is, as far as durable state is concerned: nothing in the
// first process is carried across. Section 9 does it again with a real daemon
// process, killed and respawned.

const s6 = ownedDir('s6', 'survivor');
let beforeRestart;
{
  const h = harness('s6');
  setCensus([]);
  await h.invoke({ action: 'configure_agent', path: s6, ...KNOBS });
  beforeRestart = await h.invoke({ action: 'agent_status', path: s6 });
  show('before the restart:', {
    config: beforeRestart.config,
    configVersion: beforeRestart.configVersion,
    configuredAt: beforeRestart.configuredAt,
    everActivated: beforeRestart.everActivated,
    state: beforeRestart.state
  });
}
{
  // A brand-new registry object and a brand-new bridge, over the same file.
  const h = harness('s6');
  const after = await h.invoke({ action: 'agent_status', path: s6 });
  show('after the restart:', {
    config: after.config,
    configVersion: after.configVersion,
    configuredAt: after.configuredAt,
    everActivated: after.everActivated,
    state: after.state
  });
  const same = ['config', 'configVersion', 'configuredAt', 'everActivated', 'state'].filter(
    (k) => JSON.stringify(after[k]) !== JSON.stringify(beforeRestart[k])
  );
  check(same.length === 0,
    'every echoed field is identical across the restart, because it comes from the ' +
      'append-only registry rather than from anything the old process held',
    same.length ? `differed: ${same.join(', ')}` : undefined);
  check(
    echoProblems(after, 'agent_status after restart').length === 0,
    'and it is still the whole record, not a remembered fragment of one'
  );
}

// ===========================================================================
rule('7. `provenance` classifies every key on every row');
// ===========================================================================
//
// The response says which fields are durable, which were observed just now,
// and which this daemon computed — because conflating a live pane id with
// stored configuration is exactly the ambiguity the echo exists to remove.
//
// The legend has to be exhaustive or it is worse than nothing: a field added
// later and left unclassified would silently join whichever bucket a reader
// assumed. That is what this section fails on.

{
  const h = harness('s2');
  setCensus([
    ourPane(cat.running, '%20'),
    foreignPane(cat.occupied, '%21'),
    emptyOurPane(cat.unbacked, '%22')
  ]);
  const listed = await h.invoke({ action: 'list_agents' });
  const p = listed.provenance;
  show('provenance:', { ...p, note: `${p.note.slice(0, 60)}…` });

  check(
    Array.isArray(p?.durable) && Array.isArray(p?.observed) && Array.isArray(p?.derived),
    'list_agents carries the legend as data rather than as prose'
  );
  check(
    p.durable.includes('config') && p.durable.includes('configVersion'),
    'the config echo is declared DURABLE'
  );
  check(
    p.observed.includes('paneId') && !p.durable.includes('paneId'),
    'and `paneId` is declared OBSERVED and never durable — herdr renumbers panes whenever ' +
      'any pane anywhere closes, so a consumer that stored one would hold a stale value'
  );
  check(typeof p.observedAt === 'string' && p.censusReachable === true,
    'with the moment the census answered, and whether it answered at all');

  const buckets = new Map();
  for (const bucket of ['durable', 'observed', 'derived']) {
    for (const key of p[bucket]) {
      if (buckets.has(key)) {
        check(false, `\`${key}\` is in two buckets (${buckets.get(key)} and ${bucket})`);
      }
      buckets.set(key, bucket);
    }
  }

  const rows = [
    ...listed.agents, ...listed.missingAgents, ...listed.standbyAgents,
    ...listed.unstartedAgents, ...listed.preemptedAgents, ...listed.unbackedPanes,
    ...listed.foreignPanes,
    ...listed.foreignPanes.map((f) => f.occupiedAgent).filter(Boolean)
  ];
  const unclassified = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!buckets.has(key)) unclassified.add(key);
  }
  check(
    unclassified.size === 0,
    `every key on all ${rows.length} rows of every category is classified by the legend`,
    unclassified.size ? `unclassified: ${[...unclassified].join(', ')}` : undefined
  );

  // ---- THE CLASSIFICATION ITSELF, not merely its completeness --------------
  //
  // WHY THIS SECTION EXISTS IN THIS SHAPE. Everything above asserts that each
  // key is in SOME bucket. That is a check about the legend's coverage and says
  // nothing about whether the bucket is RIGHT — and a legend that confidently
  // mislabels a field is worse than none, because a consumer will store what it
  // is told is durable.
  //
  // It shipped mislabelled: `everActivated` was computed as
  // `record || live`, sat in `durable`, and therefore changed with the census
  // and reverted on restart. The completeness check passed throughout. So each
  // bucket is now made to demonstrate the property it claims:
  //
  //   durable   — must NOT change when only the census changes, and must
  //               survive a rebuilt daemon over the same log
  //   observed  — must change when the census does, or it is not an observation
  //   derived   — `paneName` must equal the pure function of the path
  //
  // The durable half is the one that catches the defect, and the observed half
  // is what stops the whole legend being satisfied by calling everything
  // durable and never looking.
  const probe = ownedDir('s7', 'classified');
  {
    const c = harness('s7');
    await c.invoke({ action: 'configure_agent', path: probe, ...KNOBS });
    c.agentRegistry.recordActivated(c.agentRegistry.intents().get(probe).record);

    setCensus([ourPane(probe, '%77')]);
    const withPane = await c.invoke({ action: 'agent_status', path: probe });
    setCensus([]);
    const withoutPane = await c.invoke({ action: 'agent_status', path: probe });
    // A second daemon over the SAME log, with the pane back: durable fields
    // must be indifferent to the process as well as to the census.
    setCensus([ourPane(probe, '%78')]);
    const afterRebuild = await harness('s7').invoke({ action: 'agent_status', path: probe });

    const legend = withPane.provenance;
    const bucketOf = (key) =>
      legend.durable.includes(key) ? 'durable'
        : legend.observed.includes(key) ? 'observed'
          : legend.derived.includes(key) ? 'derived' : null;

    const drifted = [];
    for (const key of Object.keys(withPane)) {
      if (bucketOf(key) !== 'durable') continue;
      const a = JSON.stringify(withPane[key]);
      if (JSON.stringify(withoutPane[key]) !== a) {
        drifted.push(`${key}: ${a} with a pane, ${JSON.stringify(withoutPane[key])} without`);
      } else if (JSON.stringify(afterRebuild[key]) !== a) {
        drifted.push(`${key}: ${a} before a restart, ${JSON.stringify(afterRebuild[key])} after`);
      }
    }
    console.log(`\n   durable fields checked against a census change and a restart: ` +
      `${Object.keys(withPane).filter((k) => bucketOf(k) === 'durable').join(', ')}`);
    check(
      drifted.length === 0,
      'every field the legend calls DURABLE is identical with the pane, without the pane, ' +
        'and through a rebuilt daemon over the same log — it is a fact about the record ' +
        'rather than about the moment it was read',
      drifted.join('; ')
    );
    check(
      withPane.everActivated === true && withoutPane.everActivated === true &&
        afterRebuild.everActivated === true,
      '`everActivated` in particular, since it is the one that shipped mislabelled: the ' +
        'record carries an activation, so it reads true whether or not a pane is there',
      `${withPane.everActivated} / ${withoutPane.everActivated} / ${afterRebuild.everActivated}`
    );

    const observedThatMoved = Object.keys(withPane).filter(
      (k) => bucketOf(k) === 'observed' &&
        JSON.stringify(withPane[k]) !== JSON.stringify(withoutPane[k])
    );
    console.log(`   observed fields that moved with the census: ${observedThatMoved.join(', ') || '(none)'}`);
    check(
      observedThatMoved.includes('paneId'),
      'and a field the legend calls OBSERVED does move with the census — `paneId` is ' +
        `%77 with the pane and ${JSON.stringify(withoutPane.paneId)} without, which is what ` +
        'makes "observed" a claim rather than a label',
      `moved: ${observedThatMoved.join(', ')}`
    );
    check(
      withPane.paneName === paneNameFor(probe) && withoutPane.paneName === withPane.paneName,
      'and a DERIVED field is the pure function it says it is: paneName === paneNameFor(path), ' +
        'census or no census'
    );

    // The state read and the record must also agree about what a `configured`-
    // last row over a LIVE pane means — the exact probe that found the defect.
    const behind = ownedDir('s7', 'record-behind-live');
    const d = harness('s7-behind');
    await d.invoke({ action: 'configure_agent', path: behind, ...KNOBS });
    setCensus([ourPane(behind, '%79')]);
    const liveButUnrecorded = await d.invoke({ action: 'agent_status', path: behind });
    show('a live pane whose record never recorded an activation:', {
      state: liveButUnrecorded.state,
      everActivated: liveButUnrecorded.everActivated,
      configVersion: liveButUnrecorded.configVersion
    });
    check(
      liveButUnrecorded.state === 'running' && liveButUnrecorded.everActivated === false,
      'a live pane whose record carries no activation reads `running` AND ' +
        '`everActivated: false` — the two are answers to different questions, and the ' +
        'disagreement is the signal that the record is behind rather than something to hide',
      `state ${liveButUnrecorded.state}, everActivated ${liveButUnrecorded.everActivated}`
    );
    setCensus([]);
  }

  // And the unreachable case, because an empty census is silence rather than
  // evidence and the legend must say so rather than implying a clean read.
  setCensus('DOWN');
  const blind = await h.invoke({ action: 'list_agents' });
  check(
    blind.provenance.censusReachable === false,
    'when herdr does not answer, the legend says the observed fields are UNREAD rather ' +
      'than reporting a clean look at an empty machine'
  );
  check(
    blind.unstartedAgents.length > 0 && blind.standbyAgents.length > 0,
    'while the durable categories still answer in full — they never needed herdr'
  );

  // AND THE STATE WORD ITSELF MUST NOT LIE. Every state below `running` is a
  // claim that the agent is NOT running, and only a census that answered can
  // support one. An unreachable herdr reporting `missing` for a live agent
  // would hand a reconciler "your agent died" as the report of our own outage.
  const blindMissing = await h.invoke({ action: 'agent_status', path: cat.missing });
  const blindUnstarted = await h.invoke({ action: 'agent_status', path: cat.unstarted });
  check(
    blindMissing.state === 'unknown',
    "with herdr down, an agent that HAS run is 'unknown' rather than 'missing' — an empty " +
      'census is silence, not a death certificate',
    `state: ${blindMissing.state}`
  );
  check(
    blindUnstarted.state === 'unstarted',
    "while one that has NEVER run is still 'unstarted': there is no activation for a census " +
      'to be stale about',
    `state: ${blindUnstarted.state}`
  );
  check(
    echoProblems(blindMissing, 'agent_status with herdr down').length === 0,
    'and the echo is unaffected either way — it never needed herdr to answer',
    echoProblems(blindMissing, 'agent_status with herdr down').join('; ')
  );
  setCensus([]);
}

// ===========================================================================
rule('8. THE CHECKS CAN FAIL — the compiled daemon is mutated, and they go red');
// ===========================================================================
//
// A check that cannot fail is not a check, and a completeness assertion is
// exactly the kind that passes vacuously. So the two things this script exists
// to guard are backed out of the COMPILED daemon — not out of a stub, not out
// of a copy of the assertion — and the same assertions are re-run against it.
// If they still pass, they were never testing the code.

// The mutants live outside the package, so Node would not find `node-pty`
// walking up from them. One symlink at the scratch root puts the real
// dependencies on their resolution path without copying them.
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

/** A copy of dist with one string replaced. Returns the mutated module dir. */
function mutantDist(name, file, from, to) {
  const dir = path.join(tmp, `mutant-${name}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const target = path.join(dir, file);
  const before = fs.readFileSync(target, 'utf8');
  const occurrences = before.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${name}' expected exactly one occurrence of ${JSON.stringify(from)} in ` +
        `${file}, found ${occurrences}. The mutation target moved; fix this script rather ` +
        `than deleting the section — an un-mutatable check is an unproven one.`
    );
  }
  fs.writeFileSync(target, before.replace(from, to));
  return dir;
}

{
  // MUTATION 1: the echo itself. `configEcho` stops reading the record.
  const dir = mutantDist(
    'no-echo', 'router.js', 'config: intent.record.config,', 'config: null,'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s2', Broken, BrokenReg);
  setCensus([ourPane(cat.running, '%20'), emptyOurPane(cat.unbacked, '%22')]);
  const listed = await h.invoke({ action: 'list_agents' });
  const problems = [
    ...echoProblems(listed.agents.find((a) => a.path === cat.running), 'agents'),
    ...echoProblems(listed.standbyAgents.find((a) => a.path === cat.standby), 'standbyAgents'),
    ...echoProblems(listed.unstartedAgents.find((a) => a.path === cat.unstarted), 'unstartedAgents')
  ];
  console.log(`   the mutant's rows produce ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 4)) console.log(`     ${p}`);
  check(
    problems.length >= 3,
    'backing the config echo out of the compiled daemon makes section 2 FAIL on every ' +
      'category — so section 2 is testing the daemon rather than its own expectations'
  );
}

{
  // MUTATION 1b: the record loses its provenance on the way to the disk.
  //
  // This is what T5's converging `activate` did before these slices met: it
  // rebuilt the record as `{path, config}`, the two fields that branch happens
  // to name, and a repair that drops `configVersion` resets the token it was
  // repairing.
  //
  // MUTATED AT THE WRITE ITSELF RATHER THAN AT ONE CALL SITE, and that is a
  // correction. This used to anchor on the converge branch's own two lines —
  // and KAN-136 inserted its re-attach block between them, so the anchor
  // stopped matching and this script REFUSED TO RUN rather than skipping the
  // section. That refusal is the guard working; the fix is to stop anchoring
  // on a neighbourhood that other slices legitimately edit. `rememberActivated`
  // is the one place every activation's record reaches the log through, so
  // mutating it states the property directly — "the record travels whole" —
  // and covers both the spawn path and the converge path at once.
  const dir = mutantDist(
    'record-loses-provenance', 'router.js',
    'rememberActivated(record) {\n        const current',
    'rememberActivated(record) {\n        record = { path: record.path, config: record.config };\n        const current'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const behind = ownedDir('s8', 'record-behind');
  const b = harness('s8-behind', Broken, BrokenReg);
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS });
  await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS, priority: 3 });
  setCensus([ourPane(behind, '%56')]);
  await b.invoke({ action: 'activate_agent', path: behind });
  const written = b.agentRegistry.intents().get(behind);
  console.log(`   the mutant's repaired record reads: v${written.configVersion} ` +
    `(configuredAt ${written.record.configuredAt ?? 'DROPPED'})`);
  check(
    written.configVersion === 1 && written.record.configuredAt === undefined,
    'rebuilding the record in the converge path resets configVersion from 2 to 1 and drops ' +
      'the configure time — a compare-and-set token going BACKWARDS, which section 5 catches',
    `v${written.configVersion}, configuredAt ${written.record.configuredAt}`
  );
}

{
  // MUTATION 1c: the refusal bumps the token it is supposed to leave alone.
  //
  // This is the mutation that found the gap: it was applied to the shipping
  // daemon during review and NOTHING in this suite went red, because the
  // property was true and unasserted. Kept as the standing proof that the new
  // section 5 assertion is wired to the code rather than to its own hopes.
  const dir = mutantDist(
    'refusal-bumps-version', 'router.js',
    'configVersion: existing.configVersion,',
    'configVersion: existing.configVersion + 1,'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const refused = ownedDir('s8', 'refusal-bumps');
  const b = harness('s8-refusal', Broken, BrokenReg);
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: refused, ...KNOBS });
  const accepted = await b.invoke({ action: 'configure_agent', path: refused, ...KNOBS, priority: 4 });
  setCensus([ourPane(refused, '%61')]);
  const no = await b.invoke({ action: 'configure_agent', path: refused, ...KNOBS, priority: 9 });
  console.log(`   the mutant's refusal reports v${no.configVersion} where the record still holds ` +
    `v${accepted.configVersion}`);
  check(
    no.configVersion === accepted.configVersion + 1,
    'a refusal that bumps the version is exactly what section 5 now catches — and until this ' +
      'assertion existed, this mutation passed the entire suite',
    `refusal said v${no.configVersion}, record holds v${accepted.configVersion}`
  );
  setCensus([]);
}

{
  // MUTATION 1d: a durable field inferred from liveness — the round-1 blocker,
  // restored so the new classification check is provably the thing that finds
  // it. `everActivated` reverts to `record || live`, which the completeness
  // half of section 7 passed for its entire life.
  const dir = mutantDist(
    'everactivated-follows-liveness', 'router.js',
    'everActivated: intent.everActivated\n    };',
    'everActivated: intent.everActivated || globalThis.__kan125_live === true\n    };'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const behind = ownedDir('s8', 'liveness-leak');
  const b = harness('s8-liveness', Broken, BrokenReg);
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: behind, ...KNOBS });

  // The mutant's echo consults a live flag the real one does not have. With it
  // set, a record that carries NO activation reports `everActivated: true` —
  // and reverts the moment it is cleared, which is a restart.
  setCensus([ourPane(behind, '%62')]);
  globalThis.__kan125_live = true;
  const whileLive = await b.invoke({ action: 'agent_status', path: behind });
  globalThis.__kan125_live = false;
  const afterRestart = await b.invoke({ action: 'agent_status', path: behind });
  console.log(`   the mutant reports everActivated=${whileLive.everActivated} while live and ` +
    `${afterRestart.everActivated} after — from one unchanged record`);
  check(
    whileLive.everActivated === true && afterRestart.everActivated === false,
    'a field the legend calls DURABLE changing with liveness is what section 7 now catches: ' +
      'one record, two answers, and the completeness check would have passed both',
    `${whileLive.everActivated} → ${afterRestart.everActivated}`
  );
  delete globalThis.__kan125_live;
  setCensus([]);
}

{
  // MUTATION 2: the category test. `everActivated` is derived the plausible
  // wrong way — from the row's own last event instead of from the log — which
  // is precisely the implementation section 4 exists to rule out.
  const dir = mutantDist(
    'naive-everactivated', 'agent-registry.js',
    'everActivated: ran,',
    "everActivated: event === 'activated',"
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s3', Broken, BrokenReg);
  setCensus([]);
  const listed = await h.invoke({ action: 'list_agents' });
  const misfiled = listed.unstartedAgents.some((a) => a.path === s3standby);
  console.log(`   the mutant files the ran-and-stopped agent under: ` +
    `${misfiled ? 'unstartedAgents' : listed.standbyAgents.some((a) => a.path === s3standby) ? 'standbyAgents' : '(nowhere)'}`);
  check(
    misfiled === true,
    'deriving `everActivated` from the last event instead of from the log puts an agent ' +
      'with a conversation into unstartedAgents — the false promise section 3 asserts ' +
      'against, and it goes red there'
  );
}

// ===========================================================================
rule('9. all four surfaces — socket, CLI and MCP, across a real daemon restart');
// ===========================================================================
//
// Sections 1-8 drive the router in-process. Criterion 1 asks for the same
// values through the daemon socket, the CLI and the MCP tool, and criterion 4
// asks for them to survive a restart — so this section spawns a real daemon,
// reads through all three, kills it, and reads again.

const liveHome = path.join(tmp, 'live-home');
fs.mkdirSync(liveHome, { recursive: true });
const liveDir = path.join(tmp, 'live');
const liveData = path.join(liveDir, 'data');
const liveConfigPath = path.join(liveDir, 'crabcast.config.json');
const liveState = path.join(liveDir, 'shim-state');
fs.mkdirSync(liveState, { recursive: true });
fs.mkdirSync(liveDir, { recursive: true });
fs.writeFileSync(liveConfigPath, JSON.stringify({ dataDir: liveData }, null, 2));

// A stateful shim for the live half: it remembers what it started, so the
// daemon's census and this script's expectations come from the same place.
const liveBin = path.join(tmp, 'live-bin');
fs.mkdirSync(liveBin, { recursive: true });
const shimImpl = path.join(liveBin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.CRABCAST_VERIFY_SHIM_STATE;
const args = process.argv.slice(2);
const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const [a, b] = args;
if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (a === 'agent' && b === 'get') {
  const f = load().find((s) => s.name === args[2]);
  if (f) out({ result: { agent: { name: f.name, pane_id: f.pane_id, cwd: f.cwd, agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({ name: args[2], pane_id: String(100 + started.length), cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1] });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, agent: 'shell', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(liveBin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(liveBin, 'herdr'), 0o755);

const liveEnv = {
  ...process.env,
  HOME: liveHome,
  SHELL: '/bin/bash',
  PATH: `${liveBin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_VERIFY_SHIM_STATE: liveState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

const liveAgent = path.join(liveDir, 'owned', 'the-agent');
fs.mkdirSync(liveAgent, { recursive: true });
const livePath = fs.realpathSync(liveAgent);

const cliJs = path.join(distDir, 'cli.js');
const crabcast = (args) =>
  spawnSync(process.execPath, [cliJs, '--config', liveConfigPath, ...args], {
    env: liveEnv, encoding: 'utf8', timeout: 120_000
  });

async function raw(action, payload = {}) {
  const socket = await connectToDaemon(liveData, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `kan125-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply to ${action}`)); }, 20_000);
    onJsonLines(socket, (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.end();
      resolve(msg);
    });
    writeJsonLine(socket, { action, id, ...payload });
  });
}

const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// The caller's own server DEFINITIONS, in a file, exactly as a caller supplies
// them (KAN-111). `--mcp` now names only the servers CrabCast builds itself,
// so the two halves of the union arrive through two different flags — and both
// have to come back on the echo under one `mcpServers` map.
const MCP_CONFIG_FILE = path.join(liveDir, 'my-servers.json');
fs.writeFileSync(
  MCP_CONFIG_FILE,
  JSON.stringify({ 'kan125-example': KNOBS.mcpServers['kan125-example'] }, null, 2)
);

/** The CLI's own argv for the fixture, so the proof is reproducible by hand. */
const CONFIGURE_ARGV = [
  'configure', livePath,
  '--priority', String(KNOBS.priority),
  '--launcher', KNOBS.launcher,
  '--prompt', KNOBS.prompt,
  '--mcp', 'crabcast',
  '--mcp-config', MCP_CONFIG_FILE,
  '--label', KNOBS.label,
  // A boolean flag with no value means `true`, so the exemptions are said with
  // `=false` — which is the form the help prints.
  '--refusable=false',
  '--preemptable=false'
];

{
  const configured = crabcast(CONFIGURE_ARGV);
  console.log(`   $ crabcast ${CONFIGURE_ARGV.join(' ')}`);
  console.log(configured.stdout.replace(/^/gm, '     '));
  if (configured.status !== 0) console.log(configured.stderr.replace(/^/gm, '     '));
  check(configured.status === 0, 'the CLI configured the agent with every knob non-default',
    configured.status === 0 ? undefined : `exit ${configured.status}: ${configured.stderr?.slice(0, 300)}`);

  const status = await raw('daemon_status');
  daemonPids.add(status.pid);
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 20_000, 'the daemon socket');

  const activated = crabcast(['activate', livePath, '--override']);
  console.log(`   $ crabcast activate ${livePath} --override`);
  console.log(activated.stdout.replace(/^/gm, '     '));
  check(activated.status === 0, 'and activated it against the daemon',
    activated.status === 0 ? undefined : activated.stderr.slice(0, 400));

  // --- surface 1: the socket -----------------------------------------------
  const socketStatus = await raw('agent_status', { path: livePath });
  show('SOCKET agent_status:', {
    state: socketStatus.state, config: socketStatus.config,
    configVersion: socketStatus.configVersion, everActivated: socketStatus.everActivated
  });
  check(echoProblems(socketStatus, 'socket agent_status').length === 0,
    'SURFACE 1/4 — the socket `agent_status` reads every knob back',
    echoProblems(socketStatus, 'socket agent_status').join('; '));

  const socketList = await raw('list_agents');
  const socketRow = socketList.agents.find((a) => a.path === livePath);
  check(echoProblems(socketRow, 'socket list_agents').length === 0,
    'SURFACE 2/4 — the socket `list_agents` row reads every knob back',
    echoProblems(socketRow, 'socket list_agents').join('; '));

  // --- surface 3: the CLI --------------------------------------------------
  const cliStatus = crabcast(['status', livePath]);
  console.log(`\n   $ crabcast status ${livePath}`);
  console.log(cliStatus.stdout.replace(/^/gm, '     '));
  const cliText = cliStatus.stdout;
  // ANCHORED TO WHOLE LINES (`^…$` with /m), not floated over the whole
  // stdout. A bare /priority 7/ would match inside any other agent's block, so
  // on a fleet-shaped output it could pass while saying nothing about THIS
  // agent — a check that cannot distinguish its own subject is not measuring
  // one. The knobs are asserted as the single line that carries them together,
  // which also proves they are rendered as one block rather than scattered.
  const cliShows = [
    ['the whole knob line, with the version',
      /^ +config v1 frozen \S+: priority 7, launcher shell, refusable false, chargeable true, preemptable false$/m],
    ['the prompt size', /^ +prompt: \d+ characters$/m],
    ['the mcp servers, with the builtin marked',
      /^ +mcp servers: crabcast \(builtin\), kan125-example$/m],
    ['the label', /^ +label: the state read$/m],
    ['what the next activate would do', /^ +next activate: RESUMES .+recorded activation\)$/m],
    ['the state', /^ +state: +running$/m]
  ].filter(([, re]) => !re.test(cliText));
  check(cliShows.length === 0,
    'SURFACE 3/4 — `crabcast status` prints every knob, the version and the state',
    cliShows.length ? `missing from the output: ${cliShows.map(([n]) => n).join(', ')}` : undefined);

  const cliList = crabcast(['list']);
  console.log(`\n   $ crabcast list`);
  console.log(cliList.stdout.replace(/^/gm, '     '));
  check(
    /^ +config v1 frozen \S+: priority 7, launcher shell, refusable false, chargeable true, preemptable false$/m
      .test(cliList.stdout),
    'and `crabcast list` prints the same block on the fleet row, line for line'
  );
  check(
    /unstarted agents \(\d+\)/.test(cliList.stdout) &&
      /where these fields came from/.test(cliList.stdout),
    'along with the unstarted category and the durable-versus-observed legend'
  );

  // --- surface 4: MCP ------------------------------------------------------
  const mcp = spawn(process.execPath, [path.join(distDir, 'mcp.js')], {
    env: { ...liveEnv, CRABCAST_CONFIG: liveConfigPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let mcpBuf = '';
  const mcpPending = new Map();
  mcp.stdout.on('data', (chunk) => {
    mcpBuf += chunk.toString();
    let nl;
    while ((nl = mcpBuf.indexOf('\n')) !== -1) {
      const line = mcpBuf.slice(0, nl).trim();
      mcpBuf = mcpBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = mcpPending.get(msg.id);
      if (resolve) { mcpPending.delete(msg.id); resolve(msg); }
    }
  });
  mcp.stderr.on('data', () => {});
  let mcpId = 0;
  const mcpRequest = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++mcpId;
      mcpPending.set(id, resolve);
      const timer = setTimeout(() => reject(new Error(`no MCP reply to ${method}`)), 30_000);
      mcpPending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kan125', version: '1' }
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const mcpStatus = await mcpRequest('tools/call', {
    name: 'crabcast_agent_status', arguments: { path: livePath }
  });
  const mcpParsed = JSON.parse(mcpStatus.result.content[0].text);
  show('MCP crabcast_agent_status:', {
    state: mcpParsed.state, config: mcpParsed.config,
    configVersion: mcpParsed.configVersion, everActivated: mcpParsed.everActivated
  });
  check(echoProblems(mcpParsed, 'MCP crabcast_agent_status').length === 0,
    'SURFACE 4/4 — the MCP tool reads every knob back',
    echoProblems(mcpParsed, 'MCP crabcast_agent_status').join('; '));

  const mcpList = JSON.parse(
    (await mcpRequest('tools/call', { name: 'crabcast_list_agents', arguments: {} }))
      .result.content[0].text
  );
  const mcpRow = mcpList.agents.find((a) => a.path === livePath);
  check(echoProblems(mcpRow, 'MCP crabcast_list_agents').length === 0,
    'and so does the MCP fleet list',
    echoProblems(mcpRow, 'MCP crabcast_list_agents').join('; '));

  // All four surfaces answered the SAME thing, which is the criterion.
  const four = [socketStatus, socketRow, mcpParsed, mcpRow].map((r) =>
    JSON.stringify({ config: r.config, configVersion: r.configVersion }));
  check(new Set(four).size === 1,
    'and all four surfaces answer byte-for-byte the same configuration and version',
    new Set(four).size === 1 ? undefined : four.join('\n          '));

  mcp.kill('SIGTERM');

  // --- the restart ---------------------------------------------------------
  const before = { config: socketStatus.config, configVersion: socketStatus.configVersion,
                   configuredAt: socketStatus.configuredAt, everActivated: socketStatus.everActivated };

  process.kill(status.pid, 'SIGTERM');
  await waitFor(async () => {
    try { process.kill(status.pid, 0); return false; } catch { return true; }
  }, 20_000, 'the daemon to exit');
  daemonPids.delete(status.pid);
  console.log(`\n   the daemon (pid ${status.pid}) was killed; its session map died with it`);

  // A fresh daemon has to be spawned by a command that is allowed to spawn
  // one. `list` and `status` deliberately are not: starting a daemon is a side
  // effect nobody asked for by typing a read. `activate` is, and on an agent
  // the census still shows it answers `alreadyRunning` and writes nothing — so
  // it brings the daemon back without touching the record being compared.
  const respawn = crabcast(['activate', livePath]);
  check(
    respawn.status === 0 && /already running/.test(respawn.stdout),
    'a read does not spawn a daemon, so the restart is driven by `activate`, which finds ' +
      'the agent still running and starts nothing',
    respawn.status === 0 ? undefined : respawn.stderr?.slice(0, 300)
  );
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 30_000, 'the new daemon socket');

  const afterCli = crabcast(['status', livePath]);
  console.log(`   $ crabcast status ${livePath}   (against a daemon that has just booted)`);
  console.log(afterCli.stdout.replace(/^/gm, '     '));
  const restarted = await raw('daemon_status');
  daemonPids.add(restarted.pid);
  check(restarted.pid !== status.pid, 'a NEW daemon answered — this is a real restart',
    `${status.pid} → ${restarted.pid}`);

  const afterStatus = await raw('agent_status', { path: livePath });
  show('after the restart:', {
    state: afterStatus.state, config: afterStatus.config,
    configVersion: afterStatus.configVersion, everActivated: afterStatus.everActivated
  });
  const after = { config: afterStatus.config, configVersion: afterStatus.configVersion,
                  configuredAt: afterStatus.configuredAt, everActivated: afterStatus.everActivated };
  check(
    JSON.stringify(before) === JSON.stringify(after),
    'and every echoed field is identical across a real daemon restart, byte for byte',
    JSON.stringify(before) === JSON.stringify(after)
      ? undefined
      : `before ${JSON.stringify(before)}\n          after  ${JSON.stringify(after)}`
  );
  // THIS ASSERTION CHANGED, AND THE CHANGE IS SOMEBODY ELSE'S FIX RATHER THAN
  // A CONCESSION. It used to require `sessionless: true` after the restart —
  // the agent alive in herdr, no session of ours — because that is what a
  // restart left behind when this script was written. KAN-136 made that false
  // on purpose: `activate` now RE-ATTACHES a surviving pane instead of
  // returning on ownership alone, so the call that brings the daemon back also
  // takes the terminal back. The old expectation was of the defect, not of the
  // contract.
  //
  // What criterion 4 is actually about is untouched and asserted above: every
  // echoed field is identical across the restart, because it comes from the
  // append-only registry rather than from anything the dead process held. That
  // is true whether or not a session was re-established — which is the point,
  // and is why this assertion is now about the stronger fact.
  check(
    afterStatus.state === 'running' && afterStatus.sessionless === false &&
      typeof afterStatus.sessionId === 'string',
    'the agent is still running AND the new daemon re-attached to it (KAN-136), so the ' +
      'restart is survivable rather than merely observable — while the echoed record, ' +
      'which never needed a session, is unchanged either way',
    `state ${afterStatus.state}, sessionless ${afterStatus.sessionless}, ` +
      `sessionId ${afterStatus.sessionId}`
  );
  check(
    respawn.stdout.includes('reattached') || /already running/.test(respawn.stdout),
    'and the activate that revived the daemon reported it as a re-attach rather than as a ' +
      'start — nothing was spawned to make the record readable again'
  );
}

// ---------------------------------------------------------------------------
console.log(
  failures.length
    ? `\n${failures.length} CHECK(S) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
