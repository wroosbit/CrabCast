#!/usr/bin/env node
// Live proof for KAN-281: `channelEnabled` — whether the spawn an agent is
// running from was channel-enabled, on `activate_response` AND `agent_status`,
// sourced from the launcher that made the decision, and surviving a restart.
//
// WHAT FAILURE THIS WOULD CATCH: a `channelEnabled` that is present, correctly
// typed, on both surfaces — AND REPORTS THE SAME VALUE WHATEVER THE LAUNCHER
// DID. That is the vacuity case the commissioning ticket named, and it is not a
// hypothetical shape: it is what you get from any field wired to a constant, to
// the wrong side of a boolean, or to a config re-read that happens to agree with
// the launcher today. Every "is the field there, is it a boolean, do the two
// surfaces match" assertion in this file passes PERFECTLY against a daemon whose
// answer is hardcoded `true`. §6 is the section that rules that out, by changing
// what the launcher decides and requiring BOTH surfaces to move; nothing else
// here can tell the difference, and the positive sections are worth nothing
// until it has run.
//
// THE SECOND FAILURE, which is the one that would actually have shipped: a
// field that is correct on the branch a proof naturally exercises and WRONG on
// the branch production spends its life on. `attachSession` resolves no MCP
// servers, so a value read from the live session would be `false` for every
// agent that outlived a daemon restart — indistinguishable from an agent
// genuinely spawned without a channel, and `false` is precisely what a consumer
// branches on to conclude the channel is unavailable. §4 restarts a real daemon
// and asks again; §5 covers the same decay from the other direction, where a
// reconciler's idempotent `activate` overwrites the real spawn's verdict.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND THEREFORE DOES NOT TEST — stated here
// because a proof that supplies its own input has not tested that the input
// arrives, and this file does supply some of it. This script writes the agent
// configuration (`mcpServers: {crabcast: 'builtin'}`) that it later asserts on.
// So it tests the daemon's whole path from that request onward — resolution,
// durable write, both responses, a restart — and it does NOT test that a
// channel so provisioned is one a real agent can actually talk over.
//
//   WHO COVERS THAT: `scripts/verify-activated-by.mjs` §1, which does not
//   assert a channel exists but USES one — it reads the `.mcp.json` the daemon
//   wrote, spawns the real MCP server out of it, and builds a three-level
//   supervisor chain through it. A `crabcast` builtin that did not really work
//   would turn that file red. The seam between the two files is therefore:
//   this one proves the daemon reports the decision truthfully, that one proves
//   the thing being reported on is real. Neither covers the other, and the gap
//   would be a `channelEnabled: true` that is honest about a resolution that
//   produced a server nothing can reach.
//
// Sections:
//   1. a real activation over a real socket: both surfaces carry it, both say
//      `true`, and they agree for the same agent
//   2. the other value from the same build — an agent configured without the
//      channel reads `false` on both surfaces, so the field DISTINGUISHES
//   3. `null` is not `false` — configured-and-never-activated, and a path that
//      has never been an agent, both answer `null` rather than "no channel"
//   4. it survives a real daemon restart, answered on the sessionless branch
//      where no session of ours exists to have remembered it
//   5. an idempotent `activate` on a running agent does not overwrite it
//   6. THE RED HALF — the launcher's decision is mutated and BOTH surfaces
//      move; and the §5 guard is mutated and the value decays, so the check
//      that protects it is shown to be capable of failing
//
// Usage:
//   npm run build
//   node scripts/verify-channel-enabled.mjs [distDir]

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label} ${value === undefined ? '(undefined)' : JSON.stringify(value)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

/**
 * A precondition of a claim rather than the claim itself — the same separation
 * `verify-activated-by.mjs` makes, for the same reason. A check whose world was
 * never built is the vacuous pass this file exists to rule out, so every
 * section that asserts a DIFFERENCE states first that both sides of it exist.
 */
const given = (ok, claim, detail) => {
  console.log(`  ${ok ? 'GIVEN' : 'NOT-GIVEN'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(`PRECONDITION UNMET: ${claim}`);
  return ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan281-'));
const daemonPids = new Set();
const openSockets = [];
function cleanup() {
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  for (const pid of daemonPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

// A stateful herdr shim: `agent start` really adds a pane and `agent list`
// reports what was started, so the census the daemon joins against is a
// measurement of what this script actually caused rather than a fixture. It
// survives the daemon restart in §4 because its state is a file, which is what
// makes that section a restart of the DAEMON rather than of the world.
const fakeHome = path.join(scratch, 'home');
const shimDir = path.join(scratch, 'bin');
const shimState = path.join(scratch, 'shim-state');
for (const d of [fakeHome, shimDir, shimState]) fs.mkdirSync(d, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.KAN281_SHIM_STATE;
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
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN281_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

/** A directory the caller already owns. CrabCast never creates one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

class SocketClient {
  constructor(cfg, label) {
    this.label = label;
    this.nextId = 0;
    this.pending = new Map();
    this.socket = net.connect(socketPathFor(cfg.dataDir));
    openSockets.push(this.socket);
    this.socket.on('error', () => {});
    let buf = '';
    this.socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          resolve(msg);
        }
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve(this));
      this.socket.once('error', reject);
    });
  }
  request(action, data = {}) {
    const id = `${this.label}-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out on ${action}`));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.socket.write(JSON.stringify({ action, ...data, id }) + '\n');
    });
  }
  close() { try { this.socket.end(); } catch {} }
}

async function startDaemon(cfg, dist, label) {
  const errFile = path.join(cfg.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg.configPath], {
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) break;
    await sleep(100);
  }
  if (!fs.existsSync(sock)) {
    throw new Error(
      `daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const probe = await new SocketClient(cfg, `${label}-probe`).ready();
  const status = await probe.request('daemon_status');
  probe.close();
  daemonPids.add(status.pid);
  return status.pid;
}

async function stopDaemon(pid, cfg) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  daemonPids.delete(pid);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(sock)) return;
    await sleep(100);
  }
}

/**
 * Configure an agent, with or without the channel. `launcher: 'shell'` keeps
 * the spawn free of a real CLI while still travelling the whole resolution
 * path — the `'builtin'` sentinel, `builtinMcpServer`, the written `.mcp.json`
 * — which is the path the field is sourced from.
 */
const withChannel = { crabcast: 'builtin' };
const withoutChannel = {
  // A caller's OWN definition, not a builtin. This is the case that must read
  // `false`: the agent has an MCP server, it is simply not the channel. An
  // agent with no servers at all would also read `false` and would be a weaker
  // test — it could pass against a daemon that answered "did you ask for any
  // servers?" rather than "did you get the channel?".
  notes: { command: '/bin/true', args: [] }
};

async function configure(client, dir, mcpServers) {
  return client.request('configure_agent', {
    path: dir,
    launcher: 'shell',
    // Required — `configure` refuses without it, deliberately: there is no
    // workspace type to inherit from, so every knob arrives here or nowhere.
    priority: 5,
    ...(mcpServers ? { mcpServers } : {})
  });
}

// ===========================================================================
rule('1. A REAL ACTIVATION — both surfaces carry it, and they agree');
// ===========================================================================

const cfg = makeConfig('main');
let pid = await startDaemon(cfg, distDir, 'main');
let client = await new SocketClient(cfg, 'main').ready();

const channelDir = owned('with-channel');
const plainDir = owned('without-channel');

const configuredChannel = await configure(client, channelDir, withChannel);
given(
  configuredChannel.success === true,
  'an agent is configured asking CrabCast to supply the `crabcast` builtin',
  `success=${configuredChannel.success} ${configuredChannel.error ?? ''}`
);

const activated = await client.request('activate_agent', { path: channelDir, override: true });
given(
  activated.success === true && activated.started === true,
  'and a REAL activation spawned it — the resolution this field is read off actually ran',
  `success=${activated.success} started=${activated.started} verified=${activated.verified}`
);
given(
  activated.durable !== false,
  'and the durable write landed, so the record this field is answered from exists',
  `durable=${activated.durable ?? true} ${activated.durabilityError ?? ''}`
);

show('activate_response.channelEnabled:', activated.channelEnabled);
check(
  Object.prototype.hasOwnProperty.call(activated, 'channelEnabled'),
  'activate_response CARRIES `channelEnabled` — the constraint the requesting consumer called ' +
    'load-bearing: the answer at the moment of the spawn, not only on a later poll'
);
check(
  activated.channelEnabled === true,
  'and it is `true` for an agent whose spawn was given the channel',
  `got ${JSON.stringify(activated.channelEnabled)}`
);

const status = await client.request('agent_status', { path: channelDir });
show('agent_status.channelEnabled:', status.channelEnabled);
check(
  Object.prototype.hasOwnProperty.call(status, 'channelEnabled'),
  'agent_status CARRIES `channelEnabled` too — the steady-state surface'
);
check(
  status.channelEnabled === true,
  'and it is `true` there as well',
  `got ${JSON.stringify(status.channelEnabled)}`
);
check(
  activated.channelEnabled === status.channelEnabled,
  'THE TWO SURFACES AGREE for the same agent — which is what lets a consumer read either one ' +
    'and get the same answer about the same spawn',
  `activate=${JSON.stringify(activated.channelEnabled)} status=${JSON.stringify(status.channelEnabled)}`
);
check(
  status.sessionless === false,
  'and this was the live-session branch, so §4 has a different branch left to prove',
  `sessionless=${status.sessionless}`
);

// ===========================================================================
rule('2. THE OTHER VALUE — an agent without the channel reads `false` on both');
// ===========================================================================

// WHY THIS SECTION IS NOT OPTIONAL. §1 alone is satisfied by a field hardcoded
// to `true`. This is the cheapest thing that is not: two agents, one build, one
// daemon, one moment — and a field that must tell them apart.

await configure(client, plainDir, withoutChannel);
const plainActivated = await client.request('activate_agent', { path: plainDir, override: true });
given(
  plainActivated.success === true && plainActivated.started === true,
  'a second agent is configured with a NON-builtin MCP server and really spawned',
  `success=${plainActivated.success} started=${plainActivated.started} ${plainActivated.error ?? ''}`
);

const plainStatus = await client.request('agent_status', { path: plainDir });
show('activate_response.channelEnabled (no channel):', plainActivated.channelEnabled);
show('agent_status.channelEnabled  (no channel):', plainStatus.channelEnabled);
check(
  plainActivated.channelEnabled === false,
  'activate_response says `false` for a spawn that did not get the channel',
  `got ${JSON.stringify(plainActivated.channelEnabled)}`
);
check(
  plainStatus.channelEnabled === false,
  'and agent_status says `false` for it too',
  `got ${JSON.stringify(plainStatus.channelEnabled)}`
);
check(
  activated.channelEnabled !== plainActivated.channelEnabled,
  'THE FIELD DISTINGUISHES: two agents on one daemon at one moment get DIFFERENT answers, so it ' +
    'is reporting something about each spawn rather than restating a constant',
  `channel=${JSON.stringify(activated.channelEnabled)} plain=${JSON.stringify(plainActivated.channelEnabled)}`
);

// ===========================================================================
rule('3. `null` IS NOT `false` — no spawn to be about');
// ===========================================================================

// The one genuinely damaging value this field can take is a wrong `false`,
// because `false` is what a consumer branches on to conclude the channel is
// unavailable. So the two "there is nothing here" cases must not produce one.

const neverRanDir = owned('configured-never-activated');
await configure(client, neverRanDir, withChannel);
const neverRan = await client.request('agent_status', { path: neverRanDir });
show('configured, never activated:', neverRan.channelEnabled);
given(
  neverRan.success === true && neverRan.configured === true,
  'an agent is configured — asking for the channel — and never activated',
  `configured=${neverRan.configured} state=${neverRan.state}`
);
check(
  neverRan.channelEnabled === null,
  'it reads `null`, NOT `false`: it has no spawn, so there is nothing to be channel-enabled. A ' +
    '`false` here would be a config re-read answering a question about a spawn that never happened',
  `got ${JSON.stringify(neverRan.channelEnabled)}`
);

const strangerDir = owned('never-an-agent');
const stranger = await client.request('agent_status', { path: strangerDir });
show('never an agent at all:', stranger.channelEnabled);
given(
  stranger.success === false && stranger.configured === false,
  'and a path that has never been an agent answers on the no-record-no-pane branch',
  `success=${stranger.success} state=${stranger.state}`
);
check(
  Object.prototype.hasOwnProperty.call(stranger, 'channelEnabled') && stranger.channelEnabled === null,
  'which carries the field as an explicit `null` rather than omitting it — the same sentence the ' +
    'echo says with `config: null`, and an absent key would read as "not answered"',
  `got ${JSON.stringify(stranger.channelEnabled)}`
);

// ===========================================================================
rule('4. IT SURVIVES A REAL DAEMON RESTART — the `durable` claim, tested');
// ===========================================================================

// This is the section the bucket was chosen for. `agent_status` answers here on
// the SESSIONLESS branch — no session of ours, because the process that spawned
// the agent is gone — which is where a `remembered` field reads null and a
// session-sourced one reads a confident, wrong `false`.

client.close();
await stopDaemon(pid, cfg);
check(true, 'the daemon that performed the spawn has been stopped', `pid ${pid}`);

pid = await startDaemon(cfg, distDir, 'restarted');
client = await new SocketClient(cfg, 'restarted').ready();

const afterRestart = await client.request('agent_status', { path: channelDir });
show('agent_status.channelEnabled after restart:', afterRestart.channelEnabled);

// MEASURED RATHER THAN ASSUMED, and it was assumed wrongly first: a restarted
// daemon RECONCILES, so it re-attaches the surviving pane and answers on the
// LIVE-SESSION branch, not the sessionless one. That makes this the sharper
// test rather than a weaker one — the session backing this answer came from
// `attachSession`, which resolves no MCP servers and therefore carries no
// verdict at all. A field read off the live session would be at its most
// plausible here and would answer `false`.
given(
  afterRestart.success === true && afterRestart.sessionless === false,
  'the agent is answered by a NEW daemon that reconciled and RE-ATTACHED — a live session that ' +
    'this process never spawned, and whose session object holds no channel verdict',
  `sessionless=${afterRestart.sessionless} state=${afterRestart.state}`
);
check(
  afterRestart.channelEnabled === true,
  'and `channelEnabled` is STILL `true` — read from the registry, not from a session that never ' +
    'held it and not from a memory that died with the old process. This is what `durable` means, ' +
    'rather than what it is labelled',
  `got ${JSON.stringify(afterRestart.channelEnabled)}`
);

const plainAfterRestart = await client.request('agent_status', { path: plainDir });
check(
  plainAfterRestart.channelEnabled === false,
  'and the no-channel agent is still `false` across the same restart — so the survival is of the ' +
    'VALUE and not of a default that happens to match',
  `got ${JSON.stringify(plainAfterRestart.channelEnabled)}`
);

// THE SESSIONLESS BRANCH, REACHED DELIBERATELY. Stopping the agent leaves a
// record with no pane and no session of ours, which is the branch every
// stopped agent is read on. The verdict is about a spawn that has ENDED, and it
// is still the honest answer to "was the spawn this agent last ran from
// channel-enabled" — so it must not evaporate with the pane.
// A DEDICATED AGENT, so that stopping it does not disturb the running one §5
// still needs. Configured and spawned with the channel by this daemon, then
// stood down.
const stoppedDir = owned('stopped-with-channel');
await configure(client, stoppedDir, withChannel);
const stoppedActivated = await client.request('activate_agent', { path: stoppedDir, override: true });
given(
  stoppedActivated.success === true && stoppedActivated.channelEnabled === true,
  'a third agent is spawned with the channel, so there is a `true` to watch survive being stopped',
  `started=${stoppedActivated.started} channelEnabled=${JSON.stringify(stoppedActivated.channelEnabled)}`
);
const stopped = await client.request('deactivate_agent', { path: stoppedDir });
given(
  stopped.success === true,
  'and it is stood down, leaving a record with no session of ours',
  `success=${stopped.success} ${stopped.error ?? ''}`
);
const sessionless = await client.request('agent_status', { path: stoppedDir });
show('agent_status.channelEnabled once stopped:', sessionless.channelEnabled);
given(
  sessionless.success === true && sessionless.sessionless === true,
  'and it now answers on the SESSIONLESS branch',
  `sessionless=${sessionless.sessionless} state=${sessionless.state}`
);
check(
  sessionless.channelEnabled === true,
  'where `channelEnabled` is still `true`: the record outlives the pane, so a stopped agent ' +
    'reports the spawn it last ran from rather than degrading to `false`',
  `got ${JSON.stringify(sessionless.channelEnabled)}`
);

// ===========================================================================
rule('5. AN IDEMPOTENT `activate` DOES NOT OVERWRITE IT');
// ===========================================================================

// A reconciler calls `activate` on running agents constantly. That path did not
// spawn anything — its session may have come from `attachSession`, which
// resolves no MCP servers — so if it recorded a verdict, every `true` in the
// fleet would decay to `false` within minutes of the first reconcile. A durable
// field that changes without the thing it describes changing is worse than none.

const reactivated = await client.request('activate_agent', { path: channelDir, override: true });
given(
  reactivated.success === true && reactivated.alreadyRunning === true,
  'the already-running branch really ran — it found the agent up and started nothing',
  `alreadyRunning=${reactivated.alreadyRunning} started=${reactivated.started}`
);
show('activate_response.channelEnabled (idempotent):', reactivated.channelEnabled);
check(
  reactivated.channelEnabled === true,
  'the idempotent activate CARRIES the field and still says `true` — the branch a reconciling ' +
    'caller reads most often is not the one that says less',
  `got ${JSON.stringify(reactivated.channelEnabled)}`
);

const afterReactivate = await client.request('agent_status', { path: channelDir });
check(
  afterReactivate.channelEnabled === true,
  'and the durable record was not rewritten by it — `agent_status` still says `true` afterwards',
  `got ${JSON.stringify(afterReactivate.channelEnabled)}`
);

client.close();
await stopDaemon(pid, cfg);

// ===========================================================================
rule('6. THE RED HALF — mutate the launcher\'s decision, watch BOTH surfaces move');
// ===========================================================================

try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

mutationA: {
  // MUTATION A — THE VACUITY CASE, DIRECTLY. The launcher stops deciding: the
  // resolution runs exactly as before, the `crabcast` builtin is still supplied
  // and still written into the agent's `.mcp.json`, and the agent still comes
  // up with a working channel. Only the DECISION THIS FIELD REPORTS is changed.
  //
  // So a `channelEnabled` wired to anything other than the launcher's verdict —
  // a constant, the config, the presence of any MCP server at all — is
  // UNAFFECTED by this mutation and both surfaces keep saying `true`. That is
  // the whole test, and it is the one the commissioning ticket asked for in as
  // many words: mutate the launcher's decision and require both to move.
  const dir = mutate('launcher-decides-nothing', [
    {
      file: 'herdr.js',
      find: 'session.channelEnabled = builtinNames.includes(CHANNEL_MCP_SERVER);',
      replace: 'session.channelEnabled = false;'
    }
  ]);
  if (!dir) break mutationA;

  const mcfg = makeConfig('mutantA');
  const mpid = await startDaemon(mcfg, dir, 'mutantA');
  const mclient = await new SocketClient(mcfg, 'mutantA').ready();

  const mDir = owned('mutant-with-channel');
  await configure(mclient, mDir, withChannel);
  const mActivated = await mclient.request('activate_agent', { path: mDir, override: true });
  given(
    mActivated.success === true && mActivated.started === true,
    'the mutant still spawns the agent successfully — only the decision moved, not the behaviour',
    `success=${mActivated.success} started=${mActivated.started}`
  );
  given(
    Array.isArray(mActivated.provisioned) &&
      mActivated.provisioned.some((a) => JSON.stringify(a).includes('mcp')),
    'AND THE CHANNEL WAS STILL REALLY PROVISIONED — the mutant wrote the same MCP config, so ' +
      'what follows is a difference in the REPORT and not in what happened',
    JSON.stringify(mActivated.provisioned?.map((a) => a.kind ?? a.file))
  );

  const mStatus = await mclient.request('agent_status', { path: mDir });
  show('mutant activate_response.channelEnabled:', mActivated.channelEnabled);
  show('mutant agent_status.channelEnabled  :', mStatus.channelEnabled);

  check(
    mActivated.channelEnabled === false,
    'ACTIVATE_RESPONSE MOVED with the launcher\'s decision — §1\'s `true` was reading the ' +
      'resolution, not restating a constant',
    `real=true mutant=${JSON.stringify(mActivated.channelEnabled)}`
  );
  check(
    mStatus.channelEnabled === false,
    'AGENT_STATUS MOVED TOO — both surfaces track the same decision, so neither is independently ' +
      'hardcoded and the agreement in §1 was not a coincidence of two constants',
    `real=true mutant=${JSON.stringify(mStatus.channelEnabled)}`
  );
  check(
    mActivated.channelEnabled === mStatus.channelEnabled,
    'and they still agree with each other while doing so',
    `activate=${JSON.stringify(mActivated.channelEnabled)} status=${JSON.stringify(mStatus.channelEnabled)}`
  );

  mclient.close();
  await stopDaemon(mpid, mcfg);
}

mutationB: {
  // MUTATION B — §5's guard, watched failing. §5 asserts that an idempotent
  // `activate` does not overwrite the verdict, and until this runs that check
  // has only ever passed. Here the converging path is made to record a verdict
  // it did not earn, which is exactly the regression a future edit would
  // introduce by "helpfully" passing the session through on both branches.
  const dir = mutate('converging-activate-overwrites', [
    {
      file: 'router.js',
      find: 'const durable = this.rememberActivated(intent.record, null);',
      replace: 'const durable = this.rememberActivated(intent.record, null, false);'
    }
  ]);
  if (!dir) break mutationB;

  const mcfg = makeConfig('mutantB');
  const mpid = await startDaemon(mcfg, dir, 'mutantB');
  const mclient = await new SocketClient(mcfg, 'mutantB').ready();

  const mDir = owned('mutant-decay');
  await configure(mclient, mDir, withChannel);
  const first = await mclient.request('activate_agent', { path: mDir, override: true });
  given(
    first.channelEnabled === true,
    'the mutant records the SPAWN correctly — the decay is not present at the first activation',
    `got ${JSON.stringify(first.channelEnabled)}`
  );

  const second = await mclient.request('activate_agent', { path: mDir, override: true });
  given(
    second.alreadyRunning === true,
    'and a second activate takes the converging branch',
    `alreadyRunning=${second.alreadyRunning}`
  );
  const decayed = await mclient.request('agent_status', { path: mDir });
  show('mutant after an idempotent activate:', decayed.channelEnabled);
  check(
    second.channelEnabled === false && decayed.channelEnabled === false,
    'THE VALUE DECAYS in the mutant — a reconciler\'s no-op activate silently rewrote a fact ' +
      'about a spawn it did not perform. §5 is what turns that red, and nothing else here would',
    `activate=${JSON.stringify(second.channelEnabled)} status=${JSON.stringify(decayed.channelEnabled)}`
  );

  mclient.close();
  await stopDaemon(mpid, mcfg);
}

// ===========================================================================

rule('VERDICT');
// `.length`, because the helper returns an ARRAY and an empty one is truthy —
// which printed this notice on a clean run and would have taught a reader to
// ignore the line that exists to tell them a section never executed.
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(
    `  ${skipped.length} MUTATION(S) DID NOT APPLY, so their sections did not run: ` +
      `${skipped.join(', ')}\n` +
      '  Those are counted as failures above. Fix the mutation, not the check it was protecting.'
  );
}
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED');
} else {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
