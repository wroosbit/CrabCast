#!/usr/bin/env node
// Live proof for KAN-113: `activatedBy` — the supervisor of record, as the
// parent's canonical path, on every fleet category, surviving a restart.
//
// WHAT FAILURE THIS WOULD CATCH: an `activatedBy` that is present, correctly
// typed, and ALWAYS NULL — because the caller's identity never actually reaches
// the daemon. That is not a hypothetical. It is the defect the customer shipped
// in their own version of this feature and had to fix in a follow-up release:
// the field was on the record, on the wire and in every response, and nothing
// anywhere set it, so their whole org chart was empty while the code looked
// finished. It is this task's named enemy, and §1 is shaped entirely around it.
//
// WHY THAT DEFECT SURVIVES ORDINARY PROOFS, which is worth stating because it
// is the reason this file is arranged the way it is:
//
//     "an activation whose caller has no identity records no parent"
//
// is one of this ticket's acceptance criteria, and it passes PERFECTLY against
// a daemon that records no parent for ANYONE. So does "the field is present on
// every category", if every value on every category is null. Every negative
// assertion in this file is worthless until a positive one has been earned.
// Hence the order: §1 builds a real chain through the real channel before
// anything else is asked, and §4 — the negative case — refuses to run unless
// §1 left a non-null parent behind for it to be different from.
//
// AND THE SHARPER FORM OF THE SAME TRAP, which this script is deliberately
// arranged against: A PROOF THAT SUPPLIES ITS OWN INPUT HAS NOT TESTED THAT THE
// INPUT ARRIVES. Handing the router `{agentPath: '/some/parent'}` and asserting
// the parent comes back tests the router and nothing else — the daemon could
// still be shipping with no way for a real agent to ever be identified, and
// this file would be green. So §1 never types an identity in. It reads the
// `.mcp.json` the daemon WROTE into an agent's own directory, takes the
// environment out of that file, spawns the real MCP server with it, and lets
// that server say who it is. File → env → process → wire → durable record, with
// no step supplied by the script.
//
//   §2-§7 DO supply their own input: they hand the in-process router an
//   `agentPath` directly, because producing a preempted agent, a 500-record
//   compaction and a failed registry write through four real MCP servers would
//   be a slower proof of the same properties. What that leaves uncovered is
//   exactly the KAN-145 hole — "does an identity ever arrive at all" — and §1
//   is what covers it. That is the seam between the two halves of this file,
//   named here so no reader has to infer a coverage that is not there.
//
// Sections:
//   1. THE CHANNEL IS REAL — a real daemon, the real `.mcp.json` the daemon
//      wrote, two real MCP servers, and a three-level chain built by agents
//      identifying themselves rather than by this script asserting they did
//   2. the chain survives a real daemon restart, through socket, CLI and MCP
//   3. every fleet category carries a REAL parent — each state produced, each
//      asserted non-empty, and each value checked rather than merely present
//   4. no identity records NO parent; a malformed claim becomes no parent
//      rather than half a one; and an agent cannot be its own supervisor
//   5. parentage survives compaction past the 500-record threshold
//   6. the durable record and the response agree when the write fails
//   7. THE CHECKS CAN FAIL — the compiled daemon is mutated and they go red,
//      with each mutation's own preconditions asserted first
//
// Usage:
//   npm run build
//   node scripts/verify-activated-by.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
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
const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => {
  const body = value === undefined ? '(undefined)' : JSON.stringify(value, null, 2);
  console.log(`   ${label}\n${String(body).replace(/^/gm, '     ')}`);
};

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

/**
 * A precondition of a claim, rather than the claim itself.
 *
 * Separated in the output because the two fail for different reasons and want
 * different fixes: a failed CHECK means the daemon is wrong, a failed GIVEN
 * means this script did not manage to build the world its check was about — and
 * a check whose world was never built is the vacuous pass this whole file
 * exists to rule out. Every section that asserts an absence states its givens
 * first.
 */
const given = (ok, claim, detail) => {
  console.log(`  ${ok ? 'GIVEN' : 'NOT-GIVEN'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(`PRECONDITION UNMET: ${claim}`);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113-'));
const realPath = process.env.PATH;
const daemonPids = new Set();
const children = new Set();
function cleanup() {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
  }
  for (const pid of daemonPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};

// ===========================================================================
// SECTION 1 — the live half: a real daemon, real .mcp.json files, real MCP
// servers, and a chain nobody in this script asserted into existence.
// ===========================================================================

const liveHome = path.join(tmp, 'live-home');
const liveDir = path.join(tmp, 'live');
const liveData = path.join(liveDir, 'data');
const liveConfigPath = path.join(liveDir, 'crabcast.config.json');
const liveState = path.join(liveDir, 'shim-state');
for (const d of [liveHome, liveDir, liveState]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(liveConfigPath, JSON.stringify({ dataDir: liveData }, null, 2));

// A stateful herdr shim: `agent start` really adds a pane and `agent list`
// reports what was started, so the census the daemon joins against is a
// measurement of what this script actually caused rather than a fixture.
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

/** A directory the caller already owns. An agent is one of these and nothing else. */
function liveOwnedDir(name) {
  const dir = path.join(liveDir, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const cliJs = path.join(distDir, 'cli.js');
const crabcast = (args) =>
  spawnSync(process.execPath, [cliJs, '--config', liveConfigPath, ...args], {
    env: liveEnv, encoding: 'utf8', timeout: 120_000
  });

async function raw(action, payload = {}) {
  const socket = await connectToDaemon(liveData, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `kan113-${Math.random().toString(36).slice(2)}`;
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

/**
 * The real `dist/mcp.js`, spoken to over stdio exactly as a runtime does.
 *
 * The `env` it is given is the whole point of this class in this script: in §1
 * it is not composed here, it is read out of the `.mcp.json` the daemon wrote.
 */
class LiveMcp {
  constructor(cwd, env) {
    this.child = spawn(process.execPath, [path.join(distDir, 'mcp.js')], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe']
    });
    children.add(this.child);
    this.id = 0;
    this.pending = new Map();
    this.stderr = '';
    this.child.stderr.on('data', (c) => { this.stderr += c.toString(); });
    let buf = '';
    this.child.stdout.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && this.pending.has(m.id)) {
          const { resolve, timer } = this.pending.get(m.id);
          this.pending.delete(m.id); clearTimeout(timer); resolve(m.result ?? m.error);
        }
      }
    });
  }
  request(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 40_000);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start(who) {
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: `verify-activated-by (${who})`, version: '0.0.0' }
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }
  /** A tool call, with the JSON body the daemon answered parsed back out. */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    const text = String(res?.content?.[0]?.text ?? JSON.stringify(res));
    try { return JSON.parse(text); } catch { return { success: false, error: text }; }
  }
  kill() { try { this.child.kill(); } catch {} children.delete(this.child); }
}

/** Configure through the CLI, as a human with no identity would. */
const configureByHuman = (dir, extra = []) =>
  crabcast(['configure', dir, '--priority', '5', '--launcher', 'shell', '--mcp', 'crabcast', ...extra]);

// ===========================================================================
rule('1. THE CHANNEL IS REAL — the identity is issued, carried and recorded');
// ===========================================================================
//
// Three agents: `boss` started by a human, `mid` started by `boss`, `leaf`
// started by `mid`. Nothing in this section tells the daemon who is calling.
// The identity travels the way it will in production:
//
//   the daemon writes <agent>/.mcp.json, baking CRABCAST_AGENT_PATH into the
//   `crabcast` server's env  →  this script reads that FILE  →  spawns the real
//   MCP server with that env  →  the server puts it on the wire  →  the router
//   derives the parent  →  the append-only log records it
//
// If any link is missing the chain is flat and every check below goes red,
// which is exactly what the customer's shipped defect would have done.

const boss = liveOwnedDir('boss');
const mid = liveOwnedDir('mid');
const leaf = liveOwnedDir('leaf');

let bossMcp;
let midMcp;

{
  const configured = configureByHuman(boss);
  check(configured.status === 0, 'a human configures `boss` from the CLI, asking for the crabcast builtin',
    configured.status === 0 ? undefined : configured.stderr?.slice(0, 400));

  const status = await raw('daemon_status');
  daemonPids.add(status.pid);
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 20_000, 'the daemon socket');

  const activated = crabcast(['activate', boss, '--override']);
  check(activated.status === 0, 'and activates it — a real spawn through the real provisioning path',
    activated.status === 0 ? undefined : activated.stderr?.slice(0, 400));

  // ---- link 1: the daemon ISSUED an identity, into the caller's own file ----
  const bossMcpFile = path.join(boss, '.mcp.json');
  given(fs.existsSync(bossMcpFile), 'the daemon wrote boss/.mcp.json at activation',
    bossMcpFile);
  const bossServers = JSON.parse(fs.readFileSync(bossMcpFile, 'utf8')).mcpServers;
  show('boss/.mcp.json → mcpServers.crabcast (written by the daemon):', bossServers?.crabcast);
  check(
    bossServers?.crabcast?.env?.CRABCAST_AGENT_PATH === boss,
    'LINK 1 — the `crabcast` server definition the daemon wrote into boss\'s own directory ' +
      'carries boss\'s canonical path as CRABCAST_AGENT_PATH: the identity is ISSUED by the ' +
      'daemon, per agent, in the one artifact a caller may not write for itself',
    `CRABCAST_AGENT_PATH: ${JSON.stringify(bossServers?.crabcast?.env?.CRABCAST_AGENT_PATH)}`
  );
  check(
    bossServers?.crabcast?.env?.CRABCAST_CONFIG === liveConfigPath,
    'and still carries the config path beside it, so adding identity did not displace the ' +
      'thing that decides WHICH daemon this agent addresses'
  );

  // ---- link 2: a real MCP server carries it, and the router derives from it -
  //
  // The env comes OUT OF THE FILE. Nothing here composes it, so a daemon that
  // wrote no identity produces an MCP server with no identity, and the chain
  // below flattens.
  bossMcp = await new LiveMcp(boss, {
    ...liveEnv, ...bossServers.crabcast.env
  }).start('boss');

  const midConfigured = await bossMcp.call('crabcast_configure_agent', {
    path: mid, priority: 5, launcher: 'shell', mcpServers: { crabcast: 'builtin' }
  });
  check(midConfigured.success === true, 'boss — through its own MCP server — configures `mid`',
    midConfigured.error);
  const midActivated = await bossMcp.call('crabcast_activate_agent', { path: mid, override: true });
  check(midActivated.success === true, 'and activates it', midActivated.error);

  show('activate_response for `mid`, as boss saw it:', {
    path: midActivated.path, activatedBy: midActivated.activatedBy,
    started: midActivated.started, durable: midActivated.durable
  });
  check(
    midActivated.activatedBy === boss,
    'LINK 2 — the activation RESPONSE names boss as mid\'s supervisor of record, derived from ' +
      'an identity this script never typed: it came out of the file the daemon wrote',
    `activatedBy: ${JSON.stringify(midActivated.activatedBy)} (boss is ${boss})`
  );

  // ---- link 3: one more level, so this is a CHAIN and not a pair -----------
  const midMcpFile = path.join(mid, '.mcp.json');
  given(fs.existsSync(midMcpFile), 'mid got its own .mcp.json at activation, so mid can call too');
  const midServers = JSON.parse(fs.readFileSync(midMcpFile, 'utf8')).mcpServers;
  midMcp = await new LiveMcp(mid, { ...liveEnv, ...midServers.crabcast.env }).start('mid');

  const leafConfigured = await midMcp.call('crabcast_configure_agent', {
    path: leaf, priority: 5, launcher: 'shell'
  });
  check(leafConfigured.success === true, 'mid — through ITS server — configures `leaf`', leafConfigured.error);
  const leafActivated = await midMcp.call('crabcast_activate_agent', { path: leaf, override: true });
  check(leafActivated.success === true, 'and activates it', leafActivated.error);
  check(
    leafActivated.activatedBy === mid,
    'LINK 3 — leaf\'s supervisor is mid, not boss: parentage is who ACTIVATED you, one level, ' +
      'rather than a root the daemon fills in for everybody',
    `activatedBy: ${JSON.stringify(leafActivated.activatedBy)} (mid is ${mid})`
  );

  // ---- the chain, read back off the durable record -------------------------
  const listed = await raw('list_agents');
  const chain = Object.fromEntries(
    listed.agents.map((a) => [path.basename(a.path), a.activatedBy])
  );
  show('list_agents → the org chart, as the daemon reports it:', chain);

  const levels = [
    ['leaf', leaf, mid],
    ['mid', mid, boss],
    ['boss', boss, null]
  ];
  for (const [name, dir, parent] of levels) {
    const row = listed.agents.find((a) => a.path === dir);
    if (!given(Boolean(row), `${name} is in the running fleet`)) continue;
    check(
      row.activatedBy === parent,
      `THE CHAIN — ${name}'s supervisor of record is ${parent ? path.basename(parent) : 'null (a human started it)'}`,
      `activatedBy: ${JSON.stringify(row.activatedBy)}`
    );
  }

  // The claim this section makes is "MULTI-LEVEL", so that is asserted rather
  // than left to be read off the three lines above. Two distinct non-null
  // parents and a null root is what makes it a chain rather than a flat fleet
  // that happens to have a field on it.
  const parents = listed.agents.map((a) => a.activatedBy);
  const distinctParents = new Set(parents.filter((p) => p !== null));
  check(
    distinctParents.size === 2 && parents.filter((p) => p === null).length === 1,
    'and it is genuinely MULTI-LEVEL: two distinct non-null supervisors and exactly one root — ' +
      'an always-null implementation and an everyone-has-the-same-parent implementation both ' +
      'fail this line',
    `distinct supervisors: ${distinctParents.size}, roots: ${parents.filter((p) => p === null).length}`
  );
}

// ===========================================================================
rule('2. the chain survives a real daemon restart — socket, CLI and MCP');
// ===========================================================================
//
// Criterion 1. The record was never in memory, so this should cost nothing —
// which is the claim, and a claim is not a measurement. The daemon is killed
// outright (SIGKILL: a power cut has no shutdown hook) and a fresh one is
// started over the same data directory.

{
  const before = await raw('list_agents');
  const beforeChain = Object.fromEntries(before.agents.map((a) => [path.basename(a.path), a.activatedBy]));
  // THE PRECONDITION OF A SURVIVAL CLAIM: something has to have been alive.
  // "It survived the restart" is trivially true of an empty chain.
  given(
    before.agents.length === 3 &&
      new Set(before.agents.map((a) => a.activatedBy).filter(Boolean)).size === 2,
    'BEFORE the restart there is a three-agent, two-level chain to lose',
    JSON.stringify(beforeChain)
  );

  const status = await raw('daemon_status');
  console.log(`   killing daemon pid ${status.pid} with SIGKILL — no shutdown hook, like a power cut`);
  process.kill(status.pid, 'SIGKILL');
  daemonPids.delete(status.pid);
  await waitFor(async () => {
    try { process.kill(status.pid, 0); return false; } catch { return true; }
  }, 20_000, 'the daemon to die');

  // A fresh daemon over the same data dir. Nothing carried over but the log.
  //
  // `configure` on a throwaway directory rather than a read: `status` is
  // deliberately not one of the verbs that spawns a daemon, and a read that
  // silently started one would make "the daemon was restarted" ambiguous. The
  // witness directory is never activated — it exists to be the call that brings
  // a daemon up.
  const witness = liveOwnedDir('restart-witness');
  const restarted = configureByHuman(witness);
  check(restarted.status === 0, 'a fresh daemon starts over the same data directory',
    restarted.status === 0 ? undefined : restarted.stderr?.slice(0, 400));
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 30_000, 'the new daemon socket');
  const newStatus = await raw('daemon_status');
  daemonPids.add(newStatus.pid);
  check(newStatus.pid !== status.pid, 'and it is genuinely a different process',
    `${status.pid} → ${newStatus.pid}`);

  // --- surface 1: the socket ------------------------------------------------
  const after = await raw('list_agents');
  const afterChain = Object.fromEntries(after.agents.map((a) => [path.basename(a.path), a.activatedBy]));
  show('list_agents AFTER the restart:', afterChain);
  check(
    JSON.stringify(afterChain) === JSON.stringify(beforeChain),
    'SURFACE 1/3 — the socket reports the identical chain after the restart: it was read from ' +
      'the append-only log, not remembered',
    `${JSON.stringify(beforeChain)} → ${JSON.stringify(afterChain)}`
  );

  // --- surface 2: the CLI ---------------------------------------------------
  const cliStatus = crabcast(['status', mid]);
  console.log(`   $ crabcast status ${mid}`);
  console.log(cliStatus.stdout.replace(/^/gm, '     '));
  check(
    cliStatus.stdout.includes(`activated by: ${boss}`),
    'SURFACE 2/3 — the CLI prints mid\'s supervisor by path',
    cliStatus.stdout.split('\n').find((l) => l.includes('activated by')) ?? '(no such line)'
  );
  const cliRoot = crabcast(['status', boss]);
  check(
    /activated by: none — no supervisor of record/.test(cliRoot.stdout),
    'and prints an explicit "none" for the root rather than dropping the line, so a human ' +
      'cannot mistake "no supervisor" for "this CLI does not know about supervisors"',
    cliRoot.stdout.split('\n').find((l) => l.includes('activated by')) ?? '(no such line)'
  );

  // --- surface 3: the MCP tool ----------------------------------------------
  const humanMcp = await new LiveMcp(liveDir, { ...liveEnv, CRABCAST_CONFIG: liveConfigPath }).start('a human');
  const mcpList = await humanMcp.call('crabcast_list_agents', {});
  const mcpLeaf = mcpList.agents?.find((a) => a.path === leaf);
  check(
    mcpLeaf?.activatedBy === mid,
    'SURFACE 3/3 — the MCP tool answers the same value, to a client that is not an agent itself',
    `activatedBy: ${JSON.stringify(mcpLeaf?.activatedBy)}`
  );
  humanMcp.kill();
  bossMcp.kill();
  midMcp.kill();
}

// ===========================================================================
// The in-process half. From here the router is driven directly, and the
// `agentPath` on each request is supplied by this script — see the header for
// what that does and does not prove, and which section covers the difference.
// ===========================================================================

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
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
    JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: payload } })
  );
}
setCensus([]);

const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
const foreignPane = (dir, paneId, name = 'butchr-task-kan-80') => ({
  name, pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
const emptyOurPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent_status: 'unknown', cwd: dir
});

function ownedDir(...parts) {
  const dir = path.join(tmp, 'owned', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

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

// The three gate flags are spelled out rather than left to `configure`'s
// defaults, because the sections below write rows straight to the registry and
// a row missing any of them is not a usable record — it is dropped SILENTLY, on
// purpose, for torn-tail tolerance. A fixture that gets this wrong produces
// empty categories, which is the vacuous pass this file is arranged against;
// the non-empty GIVENs are what caught it.
const KNOBS = {
  priority: 5, launcher: 'shell', refusable: true, chargeable: true, preemptable: true
};

// ===========================================================================
rule('3. every fleet category carries a REAL parent — each state produced');
// ===========================================================================
//
// Criterion 2, and the shape of it matters. "The field is present on every
// category" passes against a daemon whose every value is null, so every agent
// below is given a REAL supervisor and the VALUE is what is asserted. Each
// category is produced rather than assumed, and asserted non-empty before it is
// asserted correct — a completeness check over an empty list proves nothing.

const supervisor = ownedDir('s3', 'supervisor');
const cat = {
  running: ownedDir('s3', 'running'),
  missing: ownedDir('s3', 'missing'),
  standby: ownedDir('s3', 'standby'),
  unstarted: ownedDir('s3', 'unstarted'),
  preempted: ownedDir('s3', 'preempted'),
  occupied: ownedDir('s3', 'occupied'),
  unbacked: ownedDir('s3', 'unbacked')
};

{
  const h = harness('s3');
  const reg = h.agentRegistry;

  // Written through the registry, because producing `preempted` and `missing`
  // through the verbs needs a real capacity squeeze and a real crash. The rows
  // are the shape the verbs write.
  const rec = (p, over = {}) => ({
    path: p,
    config: { ...KNOBS, ...(over.config ?? {}) },
    configVersion: 1,
    configuredAt: new Date().toISOString(),
    activatedBy: supervisor
  });
  reg.recordConfigured(rec(cat.running));
  reg.recordActivated(rec(cat.running));
  reg.recordConfigured(rec(cat.missing));
  reg.recordActivated(rec(cat.missing));
  reg.recordConfigured(rec(cat.standby));
  reg.recordActivated(rec(cat.standby));
  reg.recordDeactivated(rec(cat.standby));
  reg.recordConfigured(rec(cat.unstarted));
  reg.recordConfigured(rec(cat.preempted));
  reg.recordActivated(rec(cat.preempted));
  reg.recordDeactivated(rec(cat.preempted), {
    path: cat.preempted, paneName: paneNameFor(cat.preempted), priority: 5,
    herdrStatus: 'working', byPath: supervisor, byPaneName: paneNameFor(supervisor),
    byPriority: 9, at: new Date().toISOString(), derivation: 'the arithmetic that took it'
  });
  reg.recordConfigured(rec(cat.occupied));
  // Only a runtime-bearing launcher can leave a pane with nothing behind it.
  reg.recordConfigured(rec(cat.unbacked, { config: { launcher: 'claude' } }));
  reg.recordActivated(rec(cat.unbacked, { config: { launcher: 'claude' } }));

  setCensus([
    ourPane(cat.running, '%20'),
    foreignPane(cat.occupied, '%21'),
    emptyOurPane(cat.unbacked, '%22')
  ]);

  const listed = await h.invoke({ action: 'list_agents' });
  show('every category, with the supervisor each row reports:', {
    agents: listed.agents.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    missingAgents: listed.missingAgents.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    standbyAgents: listed.standbyAgents.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    unstartedAgents: listed.unstartedAgents.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    preemptedAgents: listed.preemptedAgents.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    unbackedPanes: listed.unbackedPanes.map((a) => `${path.basename(a.path)} ← ${a.activatedBy}`),
    foreignPanes: listed.foreignPanes.map((p) => `${p.paneName} → ${p.occupiedAgent?.activatedBy}`)
  });

  const categories = [
    ['agents', listed.agents.find((a) => a.path === cat.running)],
    ['missingAgents', listed.missingAgents.find((a) => a.path === cat.missing)],
    ['standbyAgents', listed.standbyAgents.find((a) => a.path === cat.standby)],
    ['unstartedAgents', listed.unstartedAgents.find((a) => a.path === cat.unstarted)],
    ['preemptedAgents', listed.preemptedAgents.find((a) => a.path === cat.preempted)],
    ['unbackedPanes', listed.unbackedPanes.find((a) => a.path === cat.unbacked)],
    ['foreignPanes[].occupiedAgent',
      listed.foreignPanes.find((p) => p.occupies === cat.occupied)?.occupiedAgent]
  ];

  for (const [name, row] of categories) {
    if (!given(Boolean(row), `${name} is NON-EMPTY — the state was produced, not assumed`)) continue;
    check(
      Object.prototype.hasOwnProperty.call(row, 'activatedBy'),
      `${name} carries an \`activatedBy\` key at all`
    );
    check(
      row.activatedBy === supervisor,
      `${name} names the RIGHT supervisor — the value, not merely the field`,
      `activatedBy: ${JSON.stringify(row.activatedBy)}`
    );
  }

  // `agent_status` is the other read of the same question, and two derivations
  // of one fact can disagree. It answers through the same `configEcho`, and
  // this is what says so.
  for (const [name, dir] of Object.entries(cat)) {
    if (name === 'occupied') continue;
    const status = await h.invoke({ action: 'agent_status', path: dir });
    check(
      status.activatedBy === supervisor,
      `agent_status agrees with list_agents about ${name} — one derivation, two reads`,
      `state ${status.state}, activatedBy ${JSON.stringify(status.activatedBy)}`
    );
  }
}

// ===========================================================================
rule('4. no identity records NO parent — and the negative case has earned it');
// ===========================================================================
//
// Criterion 3, and it comes AFTER §1 on purpose. This assertion is satisfied by
// a daemon that records no parent for anyone, so it means nothing until a real
// parent has been recorded somewhere — which §1 did, through the real channel.
// The precondition below is what refuses to let this section pass alone.

{
  const h = harness('s4');
  const parent = ownedDir('s4', 'parent');
  const child = ownedDir('s4', 'child');
  const orphan = ownedDir('s4', 'orphan');
  const garbled = ownedDir('s4', 'garbled');
  const selfish = ownedDir('s4', 'selfish');

  // THE PRECONDITION. A positive case, in this same harness, so "no identity →
  // no parent" is a DIFFERENCE rather than the only behaviour on offer.
  await h.invoke({ action: 'configure_agent', path: parent, ...KNOBS });
  await h.invoke({ action: 'configure_agent', path: child, ...KNOBS, agentPath: parent });
  const childRow = await h.invoke({ action: 'agent_status', path: child });
  given(
    childRow.activatedBy === parent,
    'this daemon DOES record a parent when it is told one — otherwise everything below is ' +
      'a check that cannot fail',
    `activatedBy: ${JSON.stringify(childRow.activatedBy)}`
  );

  // --- an activation whose caller has no identity ---------------------------
  await h.invoke({ action: 'configure_agent', path: orphan, ...KNOBS });
  setCensus([ourPane(orphan, '%40')]);
  const activated = await h.invoke({ action: 'activate_agent', path: orphan });
  show('activate_agent with no caller identity:', {
    success: activated.success, activatedBy: activated.activatedBy
  });
  check(
    activated.activatedBy === null,
    'an activation whose caller has no identity records NO parent',
    `activatedBy: ${JSON.stringify(activated.activatedBy)}`
  );
  check(
    Object.prototype.hasOwnProperty.call(activated, 'activatedBy'),
    'and says so EXPLICITLY — the key is present and null, never omitted. Over JSON a missing ' +
      'key reads as "not answered", which is a different claim from "this agent has no parent"'
  );

  // The durable row, not just the response: a null in the response over a
  // fabricated value on disk would be the same lie the other way round.
  const rawLog = fs.readFileSync(path.join(tmp, 's4.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const orphanRows = rawLog.filter((r) => r.path === orphan);
  show('the raw log rows for the orphan:', orphanRows.map((r) => ({ event: r.event, activatedBy: r.activatedBy })));
  check(
    orphanRows.length > 0 && orphanRows.every((r) => 'activatedBy' in r && r.activatedBy === null),
    'and the DISK says the same: every row carries an explicit null rather than omitting the ' +
      'key or defaulting to something plausible'
  );

  // --- a malformed claim becomes NO parent, never half a one ---------------
  for (const [label, claim] of [
    ['a relative path', '../somewhere'],
    ['an empty string', '   '],
    ['a number', 12345],
    ['an object', { path: '/tmp' }]
  ]) {
    const dir = ownedDir('s4', `garbled-${label.replace(/\W+/g, '-')}`);
    await h.invoke({ action: 'configure_agent', path: dir, ...KNOBS, agentPath: claim });
    const row = await h.invoke({ action: 'agent_status', path: dir });
    check(
      row.activatedBy === null,
      `a caller identity that is ${label} becomes NO parent rather than half a parent`,
      `claimed ${JSON.stringify(claim)} → ${JSON.stringify(row.activatedBy)}`
    );
  }
  void garbled;

  // --- an agent cannot be its own supervisor -------------------------------
  await h.invoke({ action: 'configure_agent', path: selfish, ...KNOBS, agentPath: parent });
  const beforeSelf = await h.invoke({ action: 'agent_status', path: selfish });
  given(beforeSelf.activatedBy === parent, 'the self-claiming agent starts with a real supervisor',
    `activatedBy: ${JSON.stringify(beforeSelf.activatedBy)}`);
  setCensus([ourPane(selfish, '%41')]);
  const selfActivated = await h.invoke({ action: 'activate_agent', path: selfish, agentPath: selfish });
  check(
    selfActivated.activatedBy === parent,
    'an agent that activates ITSELF does not become its own supervisor — and does not lose the ' +
      'one it had either: a converging self-activation is an ordinary reconciling call, so the ' +
      'claim is refused rather than the agent orphaned',
    `activatedBy: ${JSON.stringify(selfActivated.activatedBy)}`
  );

  // --- re-recording must not silently orphan -------------------------------
  setCensus([]);
  const deactivated = await h.invoke({ action: 'deactivate_agent', path: selfish });
  check(deactivated.success === true, 'the agent is stood down', deactivated.error);
  const afterStop = await h.invoke({ action: 'agent_status', path: selfish });
  check(
    afterStop.activatedBy === parent,
    'a STAND-DOWN — which re-records the whole agent, with no caller identity behind it — ' +
      'carries the supervisor forward rather than orphaning the agent it stopped',
    `activatedBy: ${JSON.stringify(afterStop.activatedBy)}`
  );
  const reconfigured = await h.invoke({ action: 'configure_agent', path: selfish, ...KNOBS, priority: 9 });
  check(
    reconfigured.success === true && (await h.invoke({ action: 'agent_status', path: selfish })).activatedBy === parent,
    'and so does a RECONFIGURE by a human: changing an agent\'s knobs is not a change of ' +
      'supervisor, and a fresh row that dropped the field would be a silent orphaning'
  );
}

// ===========================================================================
rule('5. parentage survives compaction past the 500-record threshold');
// ===========================================================================
//
// Criterion 4. Compaction's preserve set is an allowlist over ROWS — T1's rule
// — and the field rides on the record that each preserved row spreads. That is
// a sentence; the log on disk is the fact, so the log is what is read here.

{
  const h = harness('s5');
  const reg = h.agentRegistry;
  const logFile = path.join(tmp, 's5.jsonl');
  const chief = ownedDir('s5', 'chief');

  // One agent per terminal state the preserve set names, so this covers the
  // allowlist rather than only the branch that happens to be easiest.
  const survivors = {
    activated: ownedDir('s5', 'activated'),
    configured: ownedDir('s5', 'configured'),
    deactivated: ownedDir('s5', 'deactivated')
  };
  const rec = (p) => ({
    path: p, config: { ...KNOBS }, configVersion: 1,
    configuredAt: new Date().toISOString(), activatedBy: chief
  });
  reg.recordConfigured(rec(survivors.activated));
  reg.recordActivated(rec(survivors.activated));
  reg.recordConfigured(rec(survivors.configured));
  reg.recordConfigured(rec(survivors.deactivated));
  reg.recordActivated(rec(survivors.deactivated));
  reg.recordDeactivated(rec(survivors.deactivated));

  const readRows = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const before = readRows();
  given(
    before.length > 0 && before.every((r) => r.activatedBy === chief),
    `BEFORE: ${before.length} rows, every one naming the supervisor`,
    `first row: ${JSON.stringify({ event: before[0].event, activatedBy: before[0].activatedBy })}`
  );

  // Past the threshold. Churn on a throwaway agent so the three above are
  // superseded history rather than the thing being rewritten.
  const churn = ownedDir('s5', 'churn');
  for (let i = 0; i < 300; i++) {
    reg.recordActivated(rec(churn));
    reg.recordDeactivated(rec(churn));
  }
  const after = readRows();
  given(
    after.length < before.length + 600,
    `COMPACTION RAN: the log went from ${before.length} rows, through 600 appends, to ` +
      `${after.length} — a rewrite, not an append`,
    `if this reads ~${before.length + 600} the threshold was never crossed and everything ` +
      `below would pass without compaction ever having happened`
  );
  show('AFTER compaction — every row that survived:',
    after.map((r) => ({ path: path.basename(r.path), event: r.event, activatedBy: r.activatedBy })));

  for (const [state, dir] of Object.entries(survivors)) {
    const row = after.find((r) => r.path === dir);
    if (!given(Boolean(row), `the ${state} agent survived compaction at all`)) continue;
    check(
      row.activatedBy === chief,
      `the ${state}-last row carries its supervisor through the rewrite`,
      `activatedBy: ${JSON.stringify(row.activatedBy)}`
    );
  }
  check(
    (await h.invoke({ action: 'agent_status', path: survivors.deactivated })).activatedBy === chief,
    'and the daemon still reads it back after the rewrite, so the surviving row is usable ' +
      'rather than merely present'
  );
}

// ===========================================================================
rule('6. the durable record and the response agree when the write fails');
// ===========================================================================
//
// Criterion 5. A failed registry write must not appear as a successful
// activation carrying parentage — that is KAN-72's lesson, and a new field is a
// new way for it to be broken.

{
  const h = harness('s6');
  const oldBoss = ownedDir('s6', 'old-boss');
  const newBoss = ownedDir('s6', 'new-boss');
  const child = ownedDir('s6', 'child');
  const sixLog = path.join(tmp, 's6.jsonl');

  // THE SCENARIO IS CHOSEN SO THE RIGHT AND WRONG ANSWERS DIFFER. An activation
  // that merely restates the parent already on disk cannot tell a response that
  // echoes the RECORD from one that echoes the REQUEST — both say the same
  // thing. So this activation would establish a NEW supervisor: `child` belongs
  // to oldBoss on disk, `newBoss` activates it, and the write fails. A response
  // built from the request would report newBoss for a fact nothing persisted.
  await h.invoke({ action: 'configure_agent', path: child, ...KNOBS, agentPath: oldBoss });
  given(
    (await h.invoke({ action: 'agent_status', path: child })).activatedBy === oldBoss,
    'the agent has a supervisor on disk while the registry is writable',
    `activatedBy: ${JSON.stringify(oldBoss)}`
  );

  // Read-only rather than removed: `readLog` must keep WORKING (the daemon has
  // to still know the agent exists) while the append fails. A log that could not
  // be read would refuse the activation for a different reason and prove
  // nothing about this one.
  fs.chmodSync(sixLog, 0o400);
  let appendRefused = false;
  try {
    fs.closeSync(fs.openSync(sixLog, 'a'));
  } catch {
    appendRefused = true;
  }
  given(
    appendRefused && fs.readFileSync(sixLog, 'utf8').length > 0,
    'PRECONDITION: the registry is now unappendable but still readable — if this run is root, ' +
      'the chmod does nothing and everything below would pass against a HEALTHY write',
    `append refused: ${appendRefused}`
  );

  setCensus([ourPane(child, '%60')]);
  const activated = await h.invoke({ action: 'activate_agent', path: child, agentPath: newBoss });
  show('activate_agent by a NEW supervisor against an unwritable registry:', {
    success: activated.success, durable: activated.durable,
    durabilityError: activated.durabilityError?.slice(0, 80),
    activatedBy: activated.activatedBy
  });
  check(
    activated.durable === false,
    'the response says `durable: false` rather than reporting a clean activation',
    `durable: ${JSON.stringify(activated.durable)}`
  );
  check(
    typeof activated.durabilityError === 'string' && activated.durabilityError.length > 0,
    "and names what went wrong, so the gap is somebody's to act on",
    activated.durabilityError?.slice(0, 120)
  );
  // THE POINT OF THIS SECTION. The echo is re-read from the record AFTER the
  // write, so a failed write cannot produce a response claiming a supervisor
  // the disk never accepted.
  check(
    activated.activatedBy === oldBoss,
    'and the echoed supervisor is the one the DISK still holds, not the one this call tried ' +
      'to establish: a failed write does not appear as a successful re-parenting',
    `disk holds ${path.basename(oldBoss)}, the call claimed ${path.basename(newBoss)}, ` +
      `the response said ${JSON.stringify(activated.activatedBy)}`
  );
  const degraded = h.events.find((e) => e.action === 'registry_degraded_event');
  check(
    Boolean(degraded),
    'and a registry_degraded_event is broadcast, so the failure is not only in the reply to ' +
      'whoever happened to be calling',
    degraded ? degraded.what : '(none)'
  );

  fs.chmodSync(sixLog, 0o600);
  const afterRepair = await h.invoke({ action: 'agent_status', path: child });
  check(
    afterRepair.activatedBy === oldBoss,
    'and the durable record was genuinely untouched — the re-parenting did not half-happen',
    `activatedBy: ${JSON.stringify(afterRepair.activatedBy)}`
  );
  setCensus([]);
}

// ===========================================================================
rule('7. THE CHECKS CAN FAIL — the compiled daemon is mutated, and they go red');
// ===========================================================================
//
// A check that cannot fail is not a check, and a field that is always null
// passes most of the checks above. So each property is backed out of the
// COMPILED daemon and the same assertions are re-run against it.
//
// AND EACH MUTATION ASSERTS ITS OWN PRECONDITIONS. A section whose entire
// purpose is proving that checks can fail must not itself be able to pass
// vacuously: `mutantDist` refuses to run when the mutation did not apply, and
// each block states the world its claim is about before making the claim.

try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

/**
 * A copy of dist with one string replaced.
 *
 * THE GUARD IS THE POINT, and it is shared rather than remembered per section:
 * a mutation whose `find` string has drifted applies nothing, the assertions
 * pass against an UNMUTATED daemon, and the section reads exactly like
 * coverage. So a mutation that did not apply is a hard error, not a warning.
 */
function mutantDist(name, file, from, to) {
  const dir = path.join(tmp, `mutant-${name}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const target = path.join(dir, file);
  const before = fs.readFileSync(target, 'utf8');
  const occurrences = before.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${name}' expected exactly one occurrence of ${JSON.stringify(from)} in ` +
        `${file}, found ${occurrences}. THE BUILD WAS NOT MUTATED, so the section using it ` +
        `would have proved nothing. Fix the mutation, not this check — an un-mutatable check ` +
        `is an unproven one.`
    );
  }
  fs.writeFileSync(target, before.replace(from, to));
  return dir;
}

{
  // MUTATION A — THE CUSTOMER'S OWN DEFECT, REPRODUCED. The daemon stops baking
  // the agent's identity into the MCP server definition it writes. Everything
  // else is untouched: the field exists, the router derives it, every category
  // reports it. It is simply always null, because nothing can ever say who is
  // calling. This is the mutation that matters most in this file.
  const dir = mutantDist(
    'identity-never-issued', 'launchers.js',
    '...(agentPath ? { CRABCAST_AGENT_PATH: agentPath } : {})',
    '...(false ? { CRABCAST_AGENT_PATH: agentPath } : {})'
  );
  const { builtinMcpServer: Broken } = await import(path.join(dir, 'launchers.js'));
  const { builtinMcpServer: Real } = await import(path.join(distDir, 'launchers.js'));

  const realDef = Real('crabcast', '/tmp/cfg.json', '/tmp/the-agent');
  given(
    realDef?.env?.CRABCAST_AGENT_PATH === '/tmp/the-agent',
    'PRECONDITION: the real build DOES issue an identity, so what follows is a difference',
    JSON.stringify(realDef?.env)
  );
  const brokenDef = Broken('crabcast', '/tmp/cfg.json', '/tmp/the-agent');
  show('the mutant\'s server definition:', brokenDef);
  check(
    brokenDef?.env?.CRABCAST_AGENT_PATH === undefined && brokenDef?.env?.CRABCAST_CONFIG === '/tmp/cfg.json',
    'backing the identity out of `builtinMcpServer` leaves a definition that looks entirely ' +
      'healthy — right command, right args, right daemon — and carries no identity. §1 LINK 1 ' +
      'is what turns that red, and nothing else in this file would',
    `env: ${JSON.stringify(brokenDef?.env)}`
  );
  check(
    JSON.stringify(brokenDef) !== JSON.stringify(realDef),
    'and the two definitions genuinely differ, so LINK 1 is comparing against something'
  );
}

{
  // MUTATION B — the echo stops reading the record. Every category keeps its
  // key and answers null: the always-null field wearing the shape of a working
  // one, which is what §3 asserts VALUES rather than presence to catch.
  const dir = mutantDist(
    'echo-drops-parent', 'router.js',
    'activatedBy: intent.record.activatedBy',
    'activatedBy: null'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s3', Broken, BrokenReg);
  setCensus([ourPane(cat.running, '%20'), emptyOurPane(cat.unbacked, '%22')]);
  const listed = await h.invoke({ action: 'list_agents' });

  const rows = [
    ['agents', listed.agents.find((a) => a.path === cat.running)],
    ['standbyAgents', listed.standbyAgents.find((a) => a.path === cat.standby)],
    ['unstartedAgents', listed.unstartedAgents.find((a) => a.path === cat.unstarted)],
    ['preemptedAgents', listed.preemptedAgents.find((a) => a.path === cat.preempted)],
    ['missingAgents', listed.missingAgents.find((a) => a.path === cat.missing)]
  ];
  given(rows.every(([, r]) => Boolean(r)),
    'PRECONDITION: the mutant still produces every category, so this is about the VALUE',
    rows.map(([n, r]) => `${n}:${r ? 'present' : 'MISSING'}`).join(' '));
  const stillPresent = rows.filter(([, r]) => r && 'activatedBy' in r).length;
  const nowNull = rows.filter(([, r]) => r && r.activatedBy === null).length;
  console.log(`   the mutant: ${stillPresent}/${rows.length} rows still carry the KEY, ` +
    `${nowNull}/${rows.length} now answer null`);
  check(
    stillPresent === rows.length && nowNull === rows.length,
    'the mutant keeps the field on every category and empties it — so a presence-only check ' +
      'would PASS here. §3 asserts the value, and goes red',
    `present ${stillPresent}, null ${nowNull}`
  );
}

{
  // MUTATION C — `intents()` pulls the parent out of the record, which is the
  // one edit that orphans a whole fleet at the next re-record and at the next
  // compaction. Named in the comment on that destructure.
  const dir = mutantDist(
    'intents-strips-parent', 'agent-registry.js',
    'const { v, event, at, preemption, wasPreempted, everActivated, ...record } = entry;',
    'const { v, event, at, preemption, wasPreempted, everActivated, activatedBy, ...record } = entry;'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s7c', Broken, BrokenReg);
  const parent = ownedDir('s7c', 'parent');
  const child = ownedDir('s7c', 'child');

  await h.invoke({ action: 'configure_agent', path: child, ...KNOBS, agentPath: parent });
  const rows = fs.readFileSync(path.join(tmp, 's7c.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  given(
    rows.some((r) => r.path === child && r.activatedBy === parent),
    'PRECONDITION: the mutant still WRITES the parent to disk — the damage is on the read side',
    `disk says: ${JSON.stringify(rows.at(-1)?.activatedBy)}`
  );
  const status = await h.invoke({ action: 'agent_status', path: child });
  check(
    status.activatedBy === null || status.activatedBy === undefined,
    'stripping the parent out of `intents()` makes the daemon report no supervisor for an ' +
      'agent whose DISK row names one — the field goes on being emitted, empty, for a fleet ' +
      'that is fully parented. §3 and §5 go red',
    `disk: ${parent}, reported: ${JSON.stringify(status.activatedBy)}`
  );
}

{
  // MUTATION D — self-parentage is allowed. The refusal is a decision, not
  // incidental behaviour, so it gets its own mutation.
  const dir = mutantDist(
    'self-parentage-allowed', 'router.js',
    // Anchored on the emitted form: tsc puts the `return` on its own line, so
    // the source text is not what lands in dist.
    'if (caller !== null && caller !== target)',
    'if (caller !== null && caller !== target || caller !== null)'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s7d', Broken, BrokenReg);
  const parent = ownedDir('s7d', 'parent');
  const selfish = ownedDir('s7d', 'selfish');

  await h.invoke({ action: 'configure_agent', path: selfish, ...KNOBS, agentPath: parent });
  given(
    (await h.invoke({ action: 'agent_status', path: selfish })).activatedBy === parent,
    'PRECONDITION: the agent has a real supervisor before it claims itself'
  );
  setCensus([ourPane(selfish, '%70')]);
  const selfActivated = await h.invoke({ action: 'activate_agent', path: selfish, agentPath: selfish });
  check(
    selfActivated.activatedBy === selfish,
    'the mutant lets an agent become its own supervisor — a cycle of length one, which any ' +
      'consumer walking to a root walks forever. §4 goes red',
    `activatedBy: ${JSON.stringify(selfActivated.activatedBy)}`
  );
  setCensus([]);
}

{
  // MUTATION E — the no-op short-circuit stops comparing the parent, so the one
  // call that establishes a NEW supervisor over a running agent is swallowed.
  // A quiet one, and it was a real risk while writing this: the short-circuit
  // predates the field.
  const dir = mutantDist(
    'noop-ignores-new-supervisor', 'router.js',
    'current.record.activatedBy === toWrite.activatedBy',
    'true'
  );
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));

  const runScenario = async (Router, Registry, logName) => {
    const h = harness(logName, Router, Registry);
    const first = ownedDir(logName, 'first');
    const second = ownedDir(logName, 'second');
    const agent = ownedDir(logName, 'agent');
    await h.invoke({ action: 'configure_agent', path: agent, ...KNOBS, agentPath: first });
    setCensus([ourPane(agent, '%80')]);
    await h.invoke({ action: 'activate_agent', path: agent, agentPath: first });
    // A DIFFERENT supervisor re-activates the already-running agent.
    await h.invoke({ action: 'activate_agent', path: agent, agentPath: second });
    const status = await h.invoke({ action: 'agent_status', path: agent });
    setCensus([]);
    return { got: status.activatedBy, first, second };
  };

  const real = await runScenario(MessageRouter, AgentRegistry, 's7e-real');
  given(
    real.got === real.second,
    'PRECONDITION: the real daemon re-parents a running agent when a different supervisor ' +
      'activates it — otherwise the mutant below would match it by accident',
    `real: ${JSON.stringify(real.got)} (second is ${real.second})`
  );
  const broken = await runScenario(Broken, BrokenReg, 's7e-broken');
  check(
    broken.got === broken.first,
    'the mutant treats the re-activation as a no-op and keeps the OLD supervisor: the only ' +
      'call that could establish a new one is exactly the call it swallows',
    `mutant: ${JSON.stringify(broken.got)} (first is ${broken.first})`
  );
}

// ------------------------------------------------------------------- verdict

rule(failures.length === 0 ? 'ALL PASS' : `${failures.length} CHECK(S) FAILED`);
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
