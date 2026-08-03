// Live proof (KAN-73): the CrabCast MCP server serves the daemon's socket API
// as tools — over real stdio, against a really-running daemon.
//
// What is proven, in sections:
//
//   1. handshake  — the server comes up over stdio as `crabcast-mcp`
//   2. tool list  — exactly the eight crabcast_* tools, no staleness tool, no
//                   butchr residue, descriptions free of ticket-product
//                   vocabulary while keeping the behavioural guidance
//                   (missing = silently stopped; preempted = decision owed)
//   3. round trip — through MCP tool calls only: activate a `shell`-type
//                   agent, list_agents shows it, send_to_agent reaches its
//                   terminal, tail_agent returns pane text, agent_status
//                   reports it, deactivate stands it down and the list no
//                   longer shows it
//   4. events     — the activation's agent_activated_event arrives as an MCP
//                   notification on a SECOND connected client, proving the
//                   daemon's broadcasts are forwarded, not just responses
//   5. reset      — reset_agent stands a second agent down AND deletes its
//                   workspace directory; a reset of nothing is isError (the
//                   mapping this port deliberately adds over the extraction
//                   source)
//   6. isError    — the other failures arrive flagged: a deactivation of
//                   nothing is isError (the same deliberately-added mapping),
//                   and `capacity` — an action that lands with the capacity
//                   slice (KAN-71) — is passed through faithfully whether or
//                   not this daemon serves it yet: isError exactly when the
//                   daemon answered success: false
//   7. startup    — an explicitly-named config that does not load refuses at
//                   startup (exit 1, before serving stdio), and the
//                   no-config fallback connects without ever spawning a
//                   daemon into the default data dir
//
// Everything on the daemon side is real: the real daemon process (spawned by
// the MCP server's own eager connect, exactly as a workspace-spawned server
// would), the real router, bridge, registry and loader, a real config loaded
// by the real loader, real NDJSON over a real unix socket. What is faked is
// the `herdr` binary: a shim on PATH that records invocations and answers in
// herdr's own JSON shapes without spawning terminal panes — including
// `agent read`, so tail_agent has pane text to return.
//
// Isolation is by a scratch dataDir in the config AND a scratch $HOME with a
// system-only PATH (plus the shim), so the daemon's PATH normalization cannot
// rediscover a real herdr install, and nothing touches real user state.
//
// Usage:
//   npm run build
//   node scripts/verify-mcp-tools.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const mcpJs = path.join(distDir, 'mcp.js');

const TYPE = 'shell';
const KEY = 'kan73-mcp-demo';
const AGENT_NAME = `crabcast-${TYPE}-${KEY}`;

// ------------------------------------------------------------- the scratch --

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan73-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs —
// the daemon normalizes PATH at boot from a login shell and $HOME, and the
// scratch $HOME keeps ~/.local/bin (where a real herdr may live) out of every
// candidate list, so this shim is the only herdr any process here can find.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN73_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (list) => fs.writeFileSync(startedFile, JSON.stringify(list, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === '--version') {
  process.stdout.write('herdr 0.6.4\\n');
  process.exit(0);
}
if (a === 'agent' && b === 'get') {
  const found = load().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: String(100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, agent: 'shell', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'read') {
  const found = load().find((s) => s.name === args[2]);
  if (!found) {
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
    process.exit(1);
  }
  out({ result: { read: { text: \`$ echo KAN-73 pane text for \${args[2]}\\nKAN-73 pane text for \${args[2]}\\n$\`, truncated: false } } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'pane' && b === 'close') {
  save(load().filter((s) => s.pane_id !== args[2])); // a closed pane takes its agent with it
  out({ result: {} });
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else if (a !== 'agent') {
  out({ result: {} });
}
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

// -------------------------------------------------------------- the config --

const dataDir = path.join(scratch, 'data');
const configPath = path.join(scratch, 'crabcast.config.json');
fs.mkdirSync(path.join(scratch, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'prompts', 'shell.md'), 'KAN-73 proof workspace {{KEY}}.\n');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: TYPE, priority: 1, promptFile: 'prompts/shell.md', defaultLauncher: 'shell' }
  ]
}, null, 2));

// The environment every child gets: scratch HOME, shim-first system-only
// PATH, deterministic shell for the daemon's login-shell PATH probe.
const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN73_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined
};

// ------------------------------------------------------- a tiny MCP client --
//
// MCP over stdio is newline-delimited JSON-RPC 2.0. This client is
// deliberately hand-rolled: the point is to prove the server speaks the wire
// protocol to any client, not that two copies of the SDK agree with
// themselves.
class McpClient {
  constructor(label) {
    this.label = label;
    this.child = spawn(process.execPath, [mcpJs, configPath], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${this.label}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        } else if (msg.method && msg.id === undefined) {
          this.notifications.push(msg);
        }
      }
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `verify-mcp-tools (${this.label})`, version: '0.0.0' }
    });
    this.notify('notifications/initialized');
    return result;
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  kill() {
    try { this.child.kill(); } catch {}
  }
}

/** The daemon's JSON answer rides inside the tool result's text content. */
const parsedText = (toolResult) => {
  const text = toolResult?.content?.find((c) => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

// ------------------------------------------------------------- the harness --

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

const clients = [];
let daemonPid;
function cleanup() {
  for (const c of clients) c.kill();
  if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log(`mcp server under test: ${mcpJs}`);
console.log(`fake herdr: ${path.join(shimDir, 'herdr')} (records to ${shimState})`);
console.log(`config for this run: ${configPath} (dataDir ${dataDir})`);

// --------------------------------------------------------- 1. the handshake --

rule('1. handshake — the server comes up over stdio as crabcast-mcp');

const clientA = new McpClient('client A');
clients.push(clientA);
const hello = await clientA.initialize();
show('initialize result:', hello);

verdict(
  hello?.serverInfo?.name === 'crabcast-mcp' && hello?.capabilities?.tools !== undefined,
  `the server introduces itself as crabcast-mcp with a tools capability`,
  `unexpected initialize result`
);

// --------------------------------------------------------- 2. the tool list --

rule('2. the tool list — eight crabcast_* tools, rewritten descriptions');

const EXPECTED_TOOLS = [
  'crabcast_capacity',
  'crabcast_activate_agent',
  'crabcast_deactivate_agent',
  'crabcast_send_to_agent',
  'crabcast_tail_agent',
  'crabcast_agent_status',
  'crabcast_list_agents',
  'crabcast_reset_agent'
];

const { tools } = await clientA.request('tools/list');
for (const t of tools) {
  console.log(`\n   ${t.name}`);
  console.log(`     ${t.description.replace(/\n/g, '\n     ')}`);
}

const names = tools.map((t) => t.name).sort();
verdict(
  JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
  'exactly the eight crabcast_* tools, and no staleness tool',
  `tool names differ from the expected eight: ${JSON.stringify(names)}`
);

// No product residue anywhere in the advertised surface: not the extraction
// source's name, and none of its ticket-workflow vocabulary. ("Jira", "epic",
// "story", "ticket", and the hardcoded scale prose are what the rewrite
// removed; their absence is checkable, so it is checked.)
const surface = JSON.stringify(tools);
const residue = surface.match(/butchr|staleness|jira|\bepic\b|\bstory\b|ticket|To Do|In Progress/i);
verdict(
  residue === null,
  'no butchr/Jira/ticket vocabulary anywhere in the tool surface',
  `product residue survives in the tool surface: ${JSON.stringify(residue?.[0])}`
);

const listDesc = tools.find((t) => t.name === 'crabcast_list_agents')?.description ?? '';
verdict(
  /missingAgents/.test(listDesc) && /silently stopped/.test(listDesc) &&
    /preemptedAgents/.test(listDesc) && /decision/.test(listDesc),
  'list_agents keeps the behavioural guidance: missing = silently stopped, preempted = decision owed',
  'the behavioural guidance was lost in the rewrite'
);

// ------------------------------------------- the daemon behind the socket --

// The MCP server's eager connect spawns the daemon (none is running in this
// scratch dataDir). Wait for its socket, then fetch its pid over a raw NDJSON
// socket connection — the same wire the MCP server uses — for cleanup.
const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(distDir, 'ipc.js'));
await waitFor(() => fs.existsSync(socketPathFor(dataDir)), 20_000, 'the daemon socket');

const rawSocket = await connectToDaemon(dataDir, { spawnIfMissing: false });
rawSocket.on('error', () => {});
const daemonStatus = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no daemon_status reply')), 5000);
  onJsonLines(rawSocket, (msg) => {
    if (msg.id !== 'status-1') return;
    clearTimeout(timer);
    resolve(msg);
  });
  writeJsonLine(rawSocket, { action: 'daemon_status', id: 'status-1' });
});
rawSocket.end();
daemonPid = daemonStatus.pid;
console.log(`\n   daemon spawned by the MCP server's eager connect: pid ${daemonPid}, ` +
  `config ${daemonStatus.configPath}`);

// ------------------------------------------------------------ 3. round trip --

rule('3. the round trip — activate, list, send, tail, status, deactivate, through MCP only');

// The second client connects before the activation so section 4 can prove
// the broadcast reached a client that did not make the request.
const clientB = new McpClient('client B');
clients.push(clientB);
await clientB.initialize();

const activated = await clientA.callTool('crabcast_activate_agent', { type: TYPE, key: KEY });
const activatedRes = parsedText(activated);
show('crabcast_activate_agent:', activatedRes);
verdict(
  activated.isError !== true && activatedRes?.success === true && activatedRes?.verified === true,
  'the shell agent activated, verified against herdr\'s census',
  'the activation did not answer verified success'
);

const listed = parsedText(await clientA.callTool('crabcast_list_agents'));
show('crabcast_list_agents (agents only):', listed?.agents);
verdict(
  Array.isArray(listed?.agents) && listed.agents.some((a) => a.type === TYPE && a.key === KEY),
  `list_agents shows ${TYPE}/${KEY}`,
  'the activated agent is not in the list'
);

const sent = await clientA.callTool('crabcast_send_to_agent', {
  key: KEY, type: TYPE, message: 'echo KAN-73 send round trip'
});
const sentRes = parsedText(sent);
show('crabcast_send_to_agent:', sentRes);
verdict(
  sent.isError !== true && sentRes?.success === true,
  'send_to_agent delivered to the agent\'s terminal',
  'send_to_agent did not report delivery'
);

const tailed = await clientA.callTool('crabcast_tail_agent', { key: KEY, type: TYPE });
const tailedRes = parsedText(tailed);
show('crabcast_tail_agent:', tailedRes);
verdict(
  tailed.isError !== true && tailedRes?.success === true &&
    typeof tailedRes?.text === 'string' && tailedRes.text.includes(AGENT_NAME),
  'tail_agent returned the pane text',
  'tail_agent did not return pane text'
);

const status = parsedText(await clientA.callTool('crabcast_agent_status', { key: KEY, type: TYPE }));
show('crabcast_agent_status:', status);
verdict(
  status?.success === true && status?.sessionless === false &&
    status?.type === TYPE && status?.key === KEY,
  'agent_status reports the live session by address',
  'agent_status did not report the session'
);

const deactivated = await clientA.callTool('crabcast_deactivate_agent', { key: KEY });
const deactivatedRes = parsedText(deactivated);
show('crabcast_deactivate_agent:', deactivatedRes);
const listedAfter = parsedText(await clientA.callTool('crabcast_list_agents'));
verdict(
  deactivated.isError !== true && deactivatedRes?.success === true &&
    Array.isArray(listedAfter?.agents) &&
    !listedAfter.agents.some((a) => a.type === TYPE && a.key === KEY),
  'the deactivation succeeded and the agent is gone from the list',
  'the agent did not stand down cleanly'
);

// ---------------------------------------------- 4. events on a second client --

rule('4. broadcasts — the activation event arrived on the second client');

await waitFor(
  () => clientB.notifications.some((n) =>
    n.method === 'notifications/message' &&
    String(n.params?.data ?? '').includes('agent_activated_event')),
  5000,
  'the activation event on client B'
).catch(() => {});

const eventNotes = clientB.notifications.filter((n) => n.method === 'notifications/message');
show('client B notifications:', eventNotes.map((n) => n.params?.data));

const activationNote = eventNotes.find((n) =>
  String(n.params?.data ?? '').includes(`agent_activated_event - ${TYPE}/${KEY}`));
verdict(
  activationNote !== undefined,
  'client B — which made no request — received the agent_activated_event notification',
  'no activation event reached the second client'
);

// ----------------------------------------------------------------- 5. reset --

rule('5. reset_agent — the workspace is deleted, and a reset of nothing is flagged');

const RESET_KEY = 'kan73-reset-demo';
const resetActivate = parsedText(
  await clientA.callTool('crabcast_activate_agent', { type: TYPE, key: RESET_KEY }));
const resetWorkDir = resetActivate?.workDir;
console.log(`   activated ${TYPE}/${RESET_KEY} to reset (workDir ${resetWorkDir})`);
console.log(`   workspace exists before reset: ${fs.existsSync(resetWorkDir ?? '')}`);

const reset = await clientA.callTool('crabcast_reset_agent', { type: TYPE, key: RESET_KEY });
const resetRes = parsedText(reset);
show('crabcast_reset_agent:', resetRes);
const resetListed = parsedText(await clientA.callTool('crabcast_list_agents'));
console.log(`   workspace exists after reset: ${fs.existsSync(resetWorkDir ?? '')}`);

verdict(
  resetActivate?.success === true && typeof resetWorkDir === 'string' &&
    reset.isError !== true && resetRes?.success === true && resetRes?.agentClosed === true &&
    !fs.existsSync(resetWorkDir) &&
    !resetListed?.agents?.some((a) => a.type === TYPE && a.key === RESET_KEY),
  'reset stood the agent down and its workspace directory is gone',
  'reset did not remove both the agent and its workspace'
);

const resetGhost = await clientA.callTool('crabcast_reset_agent', { type: TYPE, key: 'kan73-never-existed' });
show('reset of nothing:', { isError: resetGhost.isError, response: parsedText(resetGhost) });
verdict(
  resetGhost.isError === true && parsedText(resetGhost)?.success === false,
  'a failed reset is flagged isError (the mapping this port adds deliberately)',
  'a failed reset arrived as ordinary text'
);

// ------------------------------------------------------ 6. isError mappings --

rule('6. failures arrive flagged — isError mappings');

const ghost = await clientA.callTool('crabcast_deactivate_agent', { key: 'kan73-no-such-agent' });
show('deactivate of nothing:', { isError: ghost.isError, response: parsedText(ghost) });
verdict(
  ghost.isError === true && parsedText(ghost)?.success === false,
  'a failed deactivation is flagged isError (the mapping this port adds deliberately)',
  'a failed deactivation arrived as ordinary text'
);

// `capacity` is a pass-through to an action that lands with the capacity
// slice (KAN-71). Whether or not this daemon serves it yet, the MCP layer's
// contract is the same: the daemon's answer comes back verbatim, flagged
// isError exactly when the daemon said success: false. Both futures pass;
// which one ran is printed.
const capacity = await clientA.callTool('crabcast_capacity');
const capacityRes = parsedText(capacity);
show('crabcast_capacity:', capacityRes);
console.log(
  capacityRes?.success === false
    ? '   (this daemon does not serve `capacity` yet — the refusal passed through, flagged)'
    : '   (this daemon serves `capacity` — the report passed through unflagged)'
);
verdict(
  capacity.isError === (capacityRes?.success === false),
  'capacity passes the daemon\'s answer through, isError exactly on success: false',
  'the capacity pass-through mislabeled the daemon\'s answer'
);

// ---------------------------------------------------- 7. startup refusals --

rule('7. startup — explicit-but-unloadable config refuses; no-config fallback never spawns');

// An explicitly named config that does not load must refuse at startup —
// falling back would connect (or worse, spawn) some other daemon than the
// one asked for, and every tool call would steer the wrong fleet.
const badConfigPath = path.join(scratch, 'broken.config.json');
fs.writeFileSync(badConfigPath, '{ this is not json');
const refused = spawnSync(process.execPath, [mcpJs, badConfigPath], {
  env: childEnv,
  input: '',
  encoding: 'utf8',
  timeout: 15_000
});
console.log(`   exit code with unloadable explicit config: ${refused.status}`);
console.log(`   stderr: ${refused.stderr.trim().split('\n')[0]}`);
verdict(
  refused.status === 1 && /refusing to start/.test(refused.stderr),
  'the server exited 1 before serving stdio, naming the refusal',
  'an unloadable explicit config did not refuse at startup'
);

// With nothing named at all, the fallback is the default data dir under
// $HOME — connect-only. A daemon spawned there could not resolve a config of
// its own, so the fallback must never spawn one: after the connect retries
// have run their course, the default data dir must not even exist.
const fallbackDataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const noConfigCwd = path.join(scratch, 'empty-cwd');
fs.mkdirSync(noConfigCwd, { recursive: true });
const fallbackEnv = { ...childEnv };
delete fallbackEnv.CRABCAST_CONFIG;
const fallbackChild = spawn(process.execPath, [mcpJs], {
  cwd: noConfigCwd,
  env: fallbackEnv,
  stdio: ['pipe', 'pipe', 'pipe']
});
let fallbackStderr = '';
fallbackChild.stderr.on('data', (d) => { fallbackStderr += d.toString(); });
await sleep(7000); // past connectToDaemon's full retry budget (20 × 250ms)
const spawnedAnything = fs.existsSync(fallbackDataDir);
fallbackChild.kill();
console.log(`   fallback stderr: ${fallbackStderr.trim().split('\n')[0]}`);
console.log(`   ${fallbackDataDir} exists after the retry budget: ${spawnedAnything}`);
verdict(
  /connecting only to an already-running daemon/.test(fallbackStderr) && !spawnedAnything,
  'the no-config fallback announced itself and spawned nothing into the default data dir',
  'the no-config fallback spawned (or provisioned for) a daemon it could not configure'
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
if (failures > 0) {
  console.log('\nclient A stderr:\n' + clientA.stderr);
}
process.exit(failures === 0 ? 0 : 1);
