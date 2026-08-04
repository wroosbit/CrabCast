#!/usr/bin/env node
// Live proof for the event contract (KAN-128): CrabCast's fleet events are a
// published surface with named events, structured payloads and stated delivery
// guarantees — on the socket AND on the MCP notification path.
//
// WHAT FAILURE THIS WOULD CATCH: the MCP event surface going silent, or going
// prose. Before this slice the forwarder decided what to pass on by asking
// whether the action ended in `_event` (a convention masquerading as a filter,
// which the rename to dot-names would have made match NOTHING — all events
// dropped, no error on either side), and what it did pass on was the string
// `[CrabCast Event] <action> - <subject>`, which a subscriber cannot act on.
// Section 3 rebuilds that exact forwarder and watches it drop every published
// event; section 4 mutates the daemon to emit an off-contract action and
// watches the allowlist refuse it out loud rather than forward it malformed.
//
// Sections, against the ticket's acceptance criteria:
//
//   1. the contract    — the published set is what docs/event-contract.md says
//                        it is, in both directions, so the document and the
//                        code cannot drift apart
//   2. all nine events — every published event PRODUCED BY A REAL OPERATION on
//                        a real daemon and received by two subscribers: a raw
//                        socket client and an MCP client over stdio. Payloads
//                        pasted. A payload that is a rendered string fails.
//                        (AC 1)
//   3. the regression  — the OLD `endsWith('_event')` forwarder, rebuilt from
//                        the compiled output, against the SAME daemon: it
//                        receives nothing. The current build receives them
//                        all. Both halves; the pair is the proof. (AC 2)
//   4. off-allowlist   — a daemon mutated to broadcast an action nobody
//                        published: warned in daemon.log, warned in the MCP
//                        server's stderr, DROPPED on the MCP path, and still
//                        delivered unsequenced on the socket, where the
//                        contract says a subscriber must ignore what it does
//                        not recognise. (AC 3)
//   5. status_changed  — a real herdr status transition, timed against the
//                        documented 30-second bound. (AC 4)
//   6. resync          — a subscriber reconnecting across a daemon restart
//                        sees a NEW bootId and recovers the fleet from the
//                        authoritative `list` without missing an agent. (AC 5)
//
// Everything on the daemon side is real: real daemon processes, real router,
// bridge, registry and config loader, real NDJSON over a real unix socket, a
// real MCP server over real stdio. What is faked is the `herdr` binary — a
// shim on PATH answering in herdr's own JSON shapes, whose reported
// `agent_status` and pane set this script can change from underneath a running
// daemon, which is what makes sections 2 and 5 observations rather than
// fixtures.
//
// Isolation is a scratch dataDir and a scratch $HOME with a system-only PATH,
// so the daemon's PATH normalization cannot rediscover a real herdr install.
//
// Usage:
//   npm run build
//   node scripts/verify-event-contract.mjs [distDir]

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const repoRoot = path.join(scriptDir, '..');

const LAUNCHER = 'shell';

// --------------------------------------------------------------- the harness --

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  console.log(`   (timed out after ${ms}ms waiting for ${what})`);
  return false;
};

// ---------------------------------------------------------------- the scratch --

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan128-events-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// ------------------------------------------------------------------ the shim --
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs.
// Two things it does that the other shims in this suite do not, and both are
// what make this script an observation rather than a fixture:
//
//   - `agent_status` per pane, read from a file on every invocation, so the
//     script can flip an agent from `working` to `blocked` underneath a
//     running daemon and watch the sweep notice.
//   - a `vanished` list, so a pane can disappear without the daemon being told,
//     which is what an agent dying really looks like from here.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

const statusesFile = path.join(shimState, 'statuses.json');
const vanishedFile = path.join(shimState, 'vanished.json');
fs.writeFileSync(statusesFile, JSON.stringify({}));
fs.writeFileSync(vanishedFile, JSON.stringify([]));

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN128_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const load = () => readJson(startedFile, []);
const save = (list) => fs.writeFileSync(startedFile, JSON.stringify(list, null, 2));
const statuses = () => readJson(path.join(state, 'statuses.json'), {});
const vanished = () => readJson(path.join(state, 'vanished.json'), []);
const visible = () => load().filter((s) => !vanished().includes(s.name));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (a === 'agent' && b === 'get') {
  const found = visible().find((s) => s.name === args[2]);
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
  const st = statuses();
  out({ result: { agents: visible().map((s) => ({
    name: s.name,
    agent: 'shell',
    cwd: s.cwd,
    pane_id: s.pane_id,
    agent_status: st[s.name] ?? 'working'
  })) } });
}
if (a === 'agent' && b === 'read') {
  const found = visible().find((s) => s.name === args[2]);
  if (!found) {
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
    process.exit(1);
  }
  out({ result: { read: { text: \`$ KAN-128 pane text for \${args[2]}\\n$\`, truncated: false } } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'pane' && b === 'close') {
  save(load().filter((s) => s.pane_id !== args[2]));
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

const setStatus = (paneName, status) => {
  const all = JSON.parse(fs.readFileSync(statusesFile, 'utf8'));
  all[paneName] = status;
  fs.writeFileSync(statusesFile, JSON.stringify(all));
};
const vanish = (paneName) => {
  const all = JSON.parse(fs.readFileSync(vanishedFile, 'utf8'));
  all.push(paneName);
  fs.writeFileSync(vanishedFile, JSON.stringify(all));
};

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN128_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined
};

// ------------------------------------------------------------- owned dirs --

/** A directory the caller owns. CrabCast never creates one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));
const { EVENT_NAMES, EVENT_CONTRACT } = await import(path.join(distDir, 'events.js'));

// ------------------------------------------------------- mutated builds --
//
// SECTIONS 3 AND 4 BREAK THINGS ON PURPOSE. A proof that has only ever passed
// is evidence of nothing: an event contract is unusually easy to "verify"
// against a subscriber that would have stayed silent anyway, so both the
// old-filter forwarder and the off-contract action are built and RUN rather
// than described.
//
// Every mutation asserts its own edit count. A find-and-replace that silently
// matched nothing would produce an unmutated build, a green result, and a
// section proving the opposite of what it claims.
//
// The mutated builds live at `<scratch>/dist-<name>`, so node resolves their
// bare imports by walking up to `<scratch>/node_modules` — which is a symlink
// to the real one. Without it the mutant cannot load the MCP SDK or node-pty
// and the section using it fails as a startup error rather than as a verdict.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

function mutatedBuild(name, edits) {
  const target = path.join(scratch, `dist-${name}`);
  fs.cpSync(distDir, target, { recursive: true });
  for (const { file, find, replace } of edits) {
    const p = path.join(target, file);
    const before = fs.readFileSync(p, 'utf8');
    const count = before.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
        `mutation "${name}" expected exactly 1 occurrence of ${JSON.stringify(find)} in ` +
        `${file}, found ${count}. The build was NOT mutated, so the section using it ` +
        `would have proved nothing. Fix the mutation, not this check.`
      );
    }
    fs.writeFileSync(p, before.replace(find, replace));
    console.log(`   mutated ${name}/${file}: ${JSON.stringify(find)} → (${replace.length} chars)`);
  }
  return target;
}

// -------------------------------------------------------- daemons & clients --

const daemons = [];
const clients = [];
const openSockets = [];

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
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
    throw new Error(`daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`);
  }
  const status = await new SocketClient(cfg, `${label}-probe`).ready().then(async (c) => {
    const s = await c.request('daemon_status');
    c.close();
    return s;
  });
  daemons.push({ pid: status.pid, label });
  return status;
}

function stopDaemon(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/**
 * A raw socket subscriber. It is the point of half this script: the socket is
 * where the events live, and a client that only makes requests would never
 * find out whether they arrive.
 */
class SocketClient {
  constructor(cfg, label) {
    this.label = label;
    this.events = [];
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
        } else if (msg.id === undefined) {
          // Correlation is by `id` and never by action name: the same socket
          // carries answers and unsolicited broadcasts. This branch is the rule.
          this.events.push(msg);
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
  eventsNamed(action) { return this.events.filter((e) => e.action === action); }
}

/** MCP over stdio is newline-delimited JSON-RPC 2.0. Hand-rolled on purpose. */
class McpClient {
  constructor(label, { dist = distDir, config }) {
    this.label = label;
    this.child = spawn(process.execPath, [path.join(dist, 'mcp.js'), config], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    clients.push(this);
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
  request(method, params = {}, timeoutMs = 40_000) {
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
    let r;
    try {
      r = await this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: `verify-event-contract (${this.label})`, version: '0.0.0' }
      });
    } catch (err) {
      // A server that never handshakes has already said why on stderr, and
      // losing that leaves the section failing as a bare timeout.
      throw new Error(`${err.message}\n--- ${this.label} stderr ---\n${this.stderr}`);
    }
    this.notify('notifications/initialized');
    return r;
  }
  callTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  /** Every event notification's structured payload, in arrival order. */
  eventPayloads() {
    return this.notifications
      .filter((n) => n.method === 'notifications/message')
      .map((n) => n.params?.data);
  }
  kill() { try { this.child.kill(); } catch {} }
}

const parsedText = (toolResult) => {
  const text = toolResult?.content?.find((c) => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
};

function cleanup() {
  for (const c of clients) c.kill();
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  for (const d of daemons) stopDaemon(d.pid);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

console.log(`dist under test: ${distDir}`);
console.log(`fake herdr:      ${path.join(shimDir, 'herdr')} (state ${shimState})`);
console.log(`scratch:         ${scratch}`);

// ============================================================ 1. the contract --

rule('1. THE CONTRACT — the published set, and the document that publishes it');

const CONTRACT_DOC = path.join(repoRoot, 'docs', 'event-contract.md');
const docText = fs.readFileSync(CONTRACT_DOC, 'utf8');

console.log(`   published events (${EVENT_NAMES.length}):`);
for (const name of EVENT_NAMES) {
  const spec = EVENT_CONTRACT[name];
  console.log(
    `     ${name.padEnd(22)} was ${String(spec.formerly ?? '(new)').padEnd(24)} ` +
    `payload: ${[...spec.required, ...spec.optional.map((f) => `${f}?`)].join(', ')}`
  );
}

// The document and the code are two copies of one table, so they are checked
// against each other rather than each against nothing. Every published name
// must appear in the doc, and — the direction that catches a name deleted from
// the code but left in the doc — every event name the doc mentions in a
// backticked cell must be published.
const undocumented = EVENT_NAMES.filter((n) => !docText.includes(`\`${n}\``));
const docNames = [...new Set(
  (docText.match(/`(agent|capacity|registry)\.[a-z_]+`/g) ?? []).map((m) => m.slice(1, -1))
)];
const unpublished = docNames.filter((n) => !EVENT_NAMES.includes(n));

console.log(`\n   names the doc mentions: ${docNames.join(', ')}`);
console.log(`   published but undocumented: ${undocumented.length ? undocumented.join(', ') : '(none)'}`);
console.log(`   documented but unpublished: ${unpublished.length ? unpublished.join(', ') : '(none)'}`);

verdict(
  EVENT_NAMES.length === 9 &&
    undocumented.length === 0 && unpublished.length === 0 &&
    // The consumer obligation, and it is an acceptance criterion rather than
    // prose polish: the contract must NOT be reducible to "we guarantee
    // convergence", because that property is joint and depends on the
    // subscriber having a timer.
    /does not independently poll `list` on a timer \*\*is not\s*\n?>?\s*entitled to the convergence property\*\*/.test(docText) &&
    /at-most-once/.test(docText) &&
    !/we guarantee convergence/i.test(docText),
  'nine published events, every one of them documented and no documented name that is\n' +
  '    not published — and the delivery section states the CONSUMER OBLIGATION rather\n' +
  '    than a convergence guarantee CrabCast cannot make alone',
  `contract and document disagree: ${EVENT_NAMES.length} names, ` +
  `undocumented=[${undocumented}], unpublished=[${unpublished}]`
);

// ======================================================== 2. all nine, live --

rule('2. ALL NINE EVENTS — produced by real operations, received on BOTH paths');

const main = makeConfig('main');
const mainStatus = await startDaemon(main, distDir, 'main');
console.log(`   daemon: pid ${mainStatus.pid}, bootId ${mainStatus.bootId}, dataDir ${main.dataDir}`);

// Both subscribers connect BEFORE anything happens. A subscriber that connects
// afterwards would be testing replay, and there is none — at-most-once, to
// whoever is connected.
const sub = await new SocketClient(main, 'sub').ready();
const mcp = new McpClient('mcp', { config: main.configPath });
await mcp.initialize();
await sleep(400); // let the MCP server's eager connect land

const AGENT = owned('subject');
const LOST = owned('will-be-lost');
const LOST_PANE = paneNameFor(LOST);

const call = async (tool, args) => parsedText(await mcp.callTool(tool, args));

// --- agent.configured, agent.activated ---
await call('crabcast_configure_agent', { path: AGENT, priority: 1, launcher: LAUNCHER });
await call('crabcast_activate_agent', { path: AGENT, override: true });
await call('crabcast_configure_agent', { path: LOST, priority: 1, launcher: LAUNCHER });
await call('crabcast_activate_agent', { path: LOST, override: true });

// --- capacity.overridden: the gate has to actually refuse before an override
// --- is an override, so the machine is filled until it does.
let fillers = 0;
let cap = await mcp.callTool('crabcast_capacity').then(parsedText);
while (!cap.atCapacity && fillers < 5) {
  const dir = owned(`filler-${fillers++}`);
  await call('crabcast_configure_agent', { path: dir, priority: 1, launcher: LAUNCHER });
  await call('crabcast_activate_agent', { path: dir, override: true });
  cap = await mcp.callTool('crabcast_capacity').then(parsedText);
}
console.log(`   filled the machine with ${fillers} extra agent(s); atCapacity=${cap.atCapacity} ` +
  `(cap ${cap.cap}, running ${cap.running}, headroom ${cap.headroom})`);
const OVERRIDDEN = owned('over-the-cap');
await call('crabcast_configure_agent', { path: OVERRIDDEN, priority: 1, launcher: LAUNCHER });
await call('crabcast_activate_agent', { path: OVERRIDDEN, override: true });

// --- agent.deactivated with reason: 'preempted' — a priority-2 activation
// --- taking a priority-1 slot on a full machine.
//
// WHICH agent gets taken is decided by the victim ordering (lowest priority,
// then least to lose, then oldest), and this script needs to know: the agent
// that goes missing in the sweep below must still be RECORDED ACTIVE, and a
// preempted one is not. So the subject is made idle — the best victim on the
// machine — and the ordering does the rest. Left to chance, a run where the
// preemption happened to take `will-be-lost` would fail section 2 for a reason
// that has nothing to do with the contract.
setStatus(paneNameFor(AGENT), 'idle');
const PREEMPTOR = owned('preemptor');
await call('crabcast_configure_agent', { path: PREEMPTOR, priority: 2, launcher: LAUNCHER });
const preemptRes = await call('crabcast_activate_agent', { path: PREEMPTOR, preempt: true });
console.log(`   preempting activation → success=${preemptRes.success}, ` +
  `victim=${preemptRes.preempted?.victim?.path ?? '(none)'}`);

// --- agent.deactivated with reason: 'requested', and agent.detached with it
// --- (the stand-down kills the PTY, and the PTY's death is its own event).
//
// A dedicated agent, activated after the preemption, because standing down
// something that is ALREADY down broadcasts nothing — that is the idempotence
// contract, and reusing the preemption's victim here would produce a section
// that passes only when the preemption failed.
const STOPPED = owned('stood-down');
await call('crabcast_configure_agent', { path: STOPPED, priority: 1, launcher: LAUNCHER });
await call('crabcast_activate_agent', { path: STOPPED, override: true });
const stopRes = await call('crabcast_deactivate_agent', { path: STOPPED });
console.log(`   requested stand-down → wasRunning=${stopRes.wasRunning}, state=${stopRes.state}`);

// --- agent.forgotten ---
await call('crabcast_forget_agent', { path: STOPPED });

// --- registry.degraded: a registry that cannot be written to. BOTH the file
// --- and its directory — appending to a file that already exists needs write
// --- permission on the FILE, and sealing only the directory would leave the
// --- append working and this proving nothing.
const registryPath = path.join(main.dataDir, 'agents.jsonl');
fs.chmodSync(registryPath, 0o400);
fs.chmodSync(main.dataDir, 0o500);
const DEGRADED = owned('degraded');
const degradedRes = await call('crabcast_configure_agent', {
  path: DEGRADED, priority: 1, launcher: LAUNCHER
});
fs.chmodSync(main.dataDir, 0o700);
fs.chmodSync(registryPath, 0o600);
console.log(`   configure against a sealed registry → durable=${degradedRes.durable}`);

// --- agent.status_changed and agent.lost: one sweep answers both, which is
// --- the point of folding the status watcher into the sweep that already runs.
//
// THE SEEDING SWEEP HAS TO HAPPEN FIRST, and waiting for it is not padding —
// it is the contract being obeyed. A first sighting is not a transition: an
// agent the daemon has never observed seeds the map silently, because there is
// no `from` anybody watched. Flip the status before that first sweep and the
// daemon's first sighting IS `blocked`, so there is nothing to report and this
// section would fail for the right reason at the wrong time. So: let one full
// sweep observe the fleet as it is, THEN change it.
const bootMs = new Date(mainStatus.startedAt).getTime();
const seedDeadline = bootMs + 33_000;
console.log(`\n   waiting ${Math.max(0, Math.round((seedDeadline - Date.now()) / 1000))}s for the ` +
  `first fleet sweep to observe the fleet as it is (a first sighting is not a transition)…`);
while (Date.now() < seedDeadline) await sleep(500);

setStatus(paneNameFor(OVERRIDDEN), 'blocked');
vanish(LOST_PANE); // the pane disappears without the daemon being told
const transitionAt = Date.now();
console.log(`   flipped ${paneNameFor(OVERRIDDEN)} to 'blocked' and vanished ${LOST_PANE};`);
console.log(`   waiting for the next 30-second fleet sweep…`);

const sawStatus = await waitFor(
  () => sub.eventsNamed('agent.status_changed').length > 0, 75_000, 'agent.status_changed');
const sawLost = await waitFor(
  () => sub.eventsNamed('agent.lost').length > 0, 75_000, 'agent.lost');
const sweepLatencyMs = Date.now() - transitionAt;

// ---- what arrived, on both paths ----

const socketByName = new Map();
for (const e of sub.events) if (!socketByName.has(e.action)) socketByName.set(e.action, e);
const mcpByName = new Map();
for (const d of mcp.eventPayloads()) if (d && !mcpByName.has(d.action)) mcpByName.set(d.action, d);

console.log(`\n   ONE OF EACH, as received on the SOCKET (${sub.events.length} events total):`);
for (const name of EVENT_NAMES) {
  const e = socketByName.get(name);
  show(`socket · ${name}:`, e ?? '(NOT RECEIVED)');
}

console.log(`\n   ONE OF EACH, as received on the MCP path (${mcp.eventPayloads().length} notifications):`);
for (const name of EVENT_NAMES) {
  show(`mcp · ${name}:`, mcpByName.get(name) ?? '(NOT RECEIVED)');
}

const missingSocket = EVENT_NAMES.filter((n) => !socketByName.has(n));
const missingMcp = EVENT_NAMES.filter((n) => !mcpByName.has(n));

// The payload assertion, field by field against the contract. A rendered
// string is a failure — that is the defect this slice closed, and asserting
// "a notification arrived" would pass over it.
const payloadProblems = [];
for (const [name, payload] of mcpByName) {
  const spec = EVENT_CONTRACT[name];
  if (typeof payload !== 'object' || payload === null) {
    payloadProblems.push(`${name}: payload is ${typeof payload}, not an object`);
    continue;
  }
  for (const field of ['at', 'seq', 'bootId']) {
    if (payload[field] === undefined) payloadProblems.push(`${name}: envelope field ${field} missing`);
  }
  for (const field of spec.required) {
    if (!(field in payload)) payloadProblems.push(`${name}: declared field ${field} missing`);
  }
  if (payload.bootId !== mainStatus.bootId) {
    payloadProblems.push(`${name}: bootId ${payload.bootId} is not this daemon's ${mainStatus.bootId}`);
  }
}

// `seq` is monotonic and there are no duplicates: a subscriber's gap detection
// is only worth anything if the numbers really increase.
const seqs = sub.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
const seqMonotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);

const deactivations = sub.eventsNamed('agent.deactivated');
const preempted = deactivations.find((e) => e.reason === 'preempted');
const requested = deactivations.find((e) => e.reason === 'requested');

console.log(`\n   seq: ${seqs.length} sequenced events, ${seqMonotonic ? 'strictly increasing' : 'OUT OF ORDER'} ` +
  `(${seqs.slice(0, 12).join(', ')}${seqs.length > 12 ? ', …' : ''})`);
console.log(`   agent.deactivated: ${deactivations.length} — reasons ` +
  `${JSON.stringify(deactivations.map((e) => e.reason))}`);
console.log(`   the preemption merged in: ${JSON.stringify(preempted?.preemption?.by ?? null)}`);
console.log(`   payload problems: ${payloadProblems.length ? payloadProblems.join('; ') : '(none)'}`);
console.log(`   no event carries \`success\`: ` +
  `${sub.events.every((e) => e.success === undefined)}`);

// THE DRIFT CHECK, and it is the one that keeps the document honest over time.
// The forwarder warns in both directions — a field the contract declares that
// the daemon did not send, and a field the daemon sent that nobody published —
// and a clean run means the table in docs/event-contract.md and the frames on
// the wire are the same table. A future slice that grows a payload field
// without writing it down turns this red.
const driftLines = mcp.stderr.split('\n').filter(
  (l) => /carried undeclared field|arrived without contract field/.test(l));
console.log(`   contract drift reported by the forwarder: ` +
  `${driftLines.length ? '\n     ' + driftLines.join('\n     ') : '(none — the wire matches the table)'}`);

verdict(
  missingSocket.length === 0 && missingMcp.length === 0 &&
    payloadProblems.length === 0 && seqMonotonic &&
    sawStatus && sawLost &&
    Boolean(preempted) && Boolean(requested) &&
    // The merge: everything the retired agent_preempted_event carried is on
    // the one event, and the victim is the event's own `path`.
    preempted.preemption?.by?.path === PREEMPTOR &&
    typeof preempted.preemption?.derivation === 'string' &&
    typeof preempted.preemption?.at === 'string' &&
    sub.events.every((e) => e.success === undefined) &&
    driftLines.length === 0,
  `all ${EVENT_NAMES.length} published events were produced by real operations and arrived on\n` +
  '    BOTH paths — the socket frames and the MCP notifications carry the same structured\n' +
  '    payload, envelope and all, none of them is a rendered string, and the forwarder\n' +
  '    reported no drift in either direction between the wire and the published table',
  `socket missing [${missingSocket}], mcp missing [${missingMcp}], ` +
  `payload problems [${payloadProblems.join('; ')}], seqMonotonic=${seqMonotonic}, ` +
  `drift [${driftLines.join(' | ')}]`
);

// =========================================== 3. the forwarder regression --

rule('3. THE REGRESSION — the old endsWith(\'_event\') forwarder, rebuilt and run');

// THE RED HALF. Not a description of the old filter: the old filter, compiled,
// pointed at the SAME daemon that just delivered nine events to the current
// build. If this section's mutation ever stops applying, mutatedBuild throws
// rather than passing.
const oldForwarderDist = mutatedBuild('old-filter', [{
  file: 'mcp.js',
  find: 'forwardEvent(msg);',
  replace:
    `{ /* KAN-128 section 3: the pre-contract forwarder, restored verbatim */\n` +
    `            if (typeof msg?.action === 'string' && msg.action.endsWith('_event')) {\n` +
    `                const subject = msg.path ?? msg.what ?? '(no subject)';\n` +
    `                server.notification({ method: "notifications/message", params: {\n` +
    `                    level: "info", data: \`[CrabCast Event] \${msg.action} - \${subject}\`\n` +
    `                } }).catch(() => {});\n` +
    `            } }`
}]);

const oldClient = new McpClient('old-filter', { dist: oldForwarderDist, config: main.configPath });
await oldClient.initialize();
const freshClient = new McpClient('current', { config: main.configPath });
await freshClient.initialize();
await sleep(600);

// One activation, seen by both forwarders at once.
const PROBE = owned('regression-probe');
await call('crabcast_configure_agent', { path: PROBE, priority: 1, launcher: LAUNCHER });
await call('crabcast_activate_agent', { path: PROBE, override: true });
await waitFor(() => freshClient.eventPayloads().some((d) => d?.action === 'agent.activated'),
  8000, 'the activation on the current forwarder');
await sleep(1000); // give the old forwarder the same chance to say something

const oldNotes = oldClient.eventPayloads();
const freshNotes = freshClient.eventPayloads();

console.log(`\n   the SAME daemon, the SAME activation, two forwarders:\n`);
console.log(`   OLD  endsWith('_event')  → ${oldNotes.length} notification(s)`);
show('old forwarder received:', oldNotes);
console.log(`\n   NEW  positive allowlist → ${freshNotes.length} notification(s)`);
show('new forwarder received (first three):', freshNotes.slice(0, 3));

console.log(`\n   why: no published name ends in '_event' any more —`);
console.log(`   ${EVENT_NAMES.map((n) => `${n}: ${n.endsWith('_event')}`).join('\n   ')}`);

verdict(
  oldNotes.length === 0 && freshNotes.length > 0 &&
    freshNotes.some((d) => d?.action === 'agent.activated' && d?.path === PROBE) &&
    EVENT_NAMES.every((n) => !n.endsWith('_event')),
  'the retired filter received NOTHING while the allowlist received every event — the\n' +
  '    MCP surface would have gone silent entirely, on all nine events, with no error on\n' +
  '    either side. Both halves are here because either one alone proves nothing.',
  `the regression is not demonstrated: old=${oldNotes.length}, new=${freshNotes.length}`
);
oldClient.kill();
freshClient.kill();

// =============================================== 4. an off-allowlist action --

rule('4. OFF-ALLOWLIST — dropped on the MCP path, logged on both sides, never malformed');

// A daemon that broadcasts an action nobody published. This is what a future
// event added without updating the contract looks like, and the whole point of
// an allowlist over a suffix test is that this case is loud.
const rogueDist = mutatedBuild('rogue-action', [{
  file: 'router.js',
  find: `action: 'agent.configured',`,
  replace: `action: 'agent.teleported',`
}]);

const rogueCfg = makeConfig('rogue');
const rogueStatus = await startDaemon(rogueCfg, rogueDist, 'rogue');
const rogueSub = await new SocketClient(rogueCfg, 'rogue-sub').ready();
const rogueMcp = new McpClient('rogue-mcp', { config: rogueCfg.configPath });
await rogueMcp.initialize();
await sleep(500);

const ROGUE_PATH = owned('rogue-subject');
await parsedText(await rogueMcp.callTool('crabcast_configure_agent', {
  path: ROGUE_PATH, priority: 1, launcher: LAUNCHER
}));
await sleep(1200);

const daemonLog = fs.readFileSync(path.join(rogueCfg.dataDir, 'daemon.log'), 'utf8');
const daemonWarning = daemonLog.split('\n').find((l) => l.includes('not on the event contract'));
const mcpWarning = rogueMcp.stderr.split('\n').find((l) => l.includes('not on the event contract'));
const rogueOnSocket = rogueSub.events.find((e) => e.action === 'agent.teleported');
const rogueOnMcp = rogueMcp.eventPayloads().filter((d) => d?.action === 'agent.teleported');

console.log(`\n   daemon-side log line (${path.join(rogueCfg.dataDir, 'daemon.log')}):\n`);
console.log(`     ${daemonWarning ?? '(NONE)'}`);
console.log(`\n   MCP-server-side log line (its stderr):\n`);
console.log(`     ${mcpWarning ?? '(NONE)'}`);
console.log(`\n   what the MCP client received for it: ${rogueOnMcp.length} notification(s)`);
show('what the SOCKET subscriber received for it:', rogueOnSocket ?? '(nothing)');

verdict(
  Boolean(daemonWarning) && /agent\.teleported/.test(daemonWarning ?? '') &&
    Boolean(mcpWarning) && /agent\.teleported/.test(mcpWarning ?? '') &&
    rogueOnMcp.length === 0 &&
    // The socket half of the contract: broadcast filters nothing, matching is
    // the subscriber's, and an unrecognised action must be ignored rather than
    // errored on. It arrives UNSEQUENCED — no seq, no bootId — because
    // burning a sequence number on something no subscriber recognises would
    // put a gap in the sequence that means nothing.
    Boolean(rogueOnSocket) && rogueOnSocket.seq === undefined && rogueOnSocket.bootId === undefined,
  'the off-contract action was DROPPED on the MCP path and named in a warning on both\n' +
  '    sides of the boundary; on the socket it arrived unsequenced, where the contract\n' +
  '    says a subscriber must ignore what it does not recognise. Nothing reached a\n' +
  '    subscriber malformed.',
  `daemonWarning=${Boolean(daemonWarning)} mcpWarning=${Boolean(mcpWarning)} ` +
  `mcpNotifications=${rogueOnMcp.length} socketFrame=${Boolean(rogueOnSocket)}`
);
rogueMcp.kill();
rogueSub.close();
stopDaemon(rogueStatus.pid);

// ============================================ 5. status_changed and latency --

rule('5. agent.status_changed — a real transition, timed against the documented bound');

const statusEvents = sub.eventsNamed('agent.status_changed');
const statusEvent = statusEvents.find((e) => e.path === OVERRIDDEN);
const statusOnMcp = mcp.eventPayloads().find(
  (d) => d?.action === 'agent.status_changed' && d?.path === OVERRIDDEN);

console.log(`\n   the transition was made at t+0 by rewriting the shim's status file;`);
console.log(`   the daemon was told nothing and had to observe it.\n`);
show('socket:', statusEvent ?? '(NOT RECEIVED)');
show('mcp:', statusOnMcp ?? '(NOT RECEIVED)');
console.log(`\n   observed latency:   ${(sweepLatencyMs / 1000).toFixed(1)}s`);
console.log(`   documented bound:   30s (the fleet sweep) plus one census read`);
console.log(`   additional herdr invocations for this event: 0 — it reads the census the`);
console.log(`   missing-agent sweep was taking anyway.`);
console.log(`\n   all status transitions observed this run:`);
for (const e of statusEvents) console.log(`     ${e.path} ${e.from} → ${e.to} (seq ${e.seq})`);

verdict(
  Boolean(statusEvent) && statusEvent.from === 'working' && statusEvent.to === 'blocked' &&
    statusEvent.paneName === paneNameFor(OVERRIDDEN) &&
    'paneId' in statusEvent &&
    Boolean(statusOnMcp) && statusOnMcp.to === 'blocked' &&
    sweepLatencyMs < 45_000 &&
    // A first sighting is not a transition: every agent that came up during
    // this run was seeded silently, so the only transitions reported are ones
    // this daemon actually watched happen.
    statusEvents.every((e) => typeof e.from === 'string' && e.from !== e.to),
  `the transition working → blocked was observed and published within ` +
  `${(sweepLatencyMs / 1000).toFixed(1)}s of a\n` +
  '    30-second documented bound, on both paths, and no first sighting was reported as a\n' +
  '    transition',
  `status_changed not proven: event=${JSON.stringify(statusEvent)} latency=${sweepLatencyMs}ms`
);

// ================================================== 6. resync across a restart --

rule('6. RESYNC — a new bootId across a daemon restart, and the fleet recovered from `list`');

const before = await sub.request('list_agents');
const beforePaths = before.agents.map((a) => a.path).sort();
console.log(`\n   before the restart: bootId ${before.bootId}, eventSeq ${before.eventSeq}`);
console.log(`   agents: ${beforePaths.length}`);

sub.close();
mcp.kill();
stopDaemon(mainStatus.pid);
await waitFor(() => !fs.existsSync(socketPathFor(main.dataDir)), 15_000, 'the daemon to shut down');

const restarted = await startDaemon(main, distDir, 'main-restarted');
// Boot reconcile re-attaches surviving panes; give it a moment to settle
// before asking what it can see.
await sleep(3000);
const sub2 = await new SocketClient(main, 'sub2').ready();
const after = await sub2.request('list_agents');
const afterPaths = after.agents.map((a) => a.path).sort();

console.log(`\n   after the restart:  bootId ${after.bootId}, eventSeq ${after.eventSeq}`);
console.log(`   agents: ${afterPaths.length}`);
console.log(`\n   the four-step resync a subscriber performs:`);
console.log(`     1. reconnect                          → done`);
console.log(`     2. list_agents                        → ${afterPaths.length} agents`);
console.log(`     3. bootId changed?                    → ${before.bootId} → ${after.bootId} ` +
  `(${before.bootId !== after.bootId ? 'YES — resync' : 'no'})`);
console.log(`     4. the response IS the new baseline   → every row carries configVersion: ` +
  `${after.agents.every((a) => typeof a.configVersion === 'number')}`);
console.log(`\n   recovered without missing an agent: ${JSON.stringify(afterPaths.map((p) => path.basename(p)))}`);

// Every agent the registry still expects to be running is in the recovered
// view. That is the "without missing an agent" half, and it is asked of the
// registry rather than of a list the script wrote down — a script comparing
// its own two lists could agree with itself while both were wrong.
const expectedAfter = (after.missingAgents ?? []).map((a) => a.path);
verdict(
  before.bootId !== after.bootId &&
    typeof after.bootId === 'string' && after.bootId === restarted.bootId &&
    typeof after.eventSeq === 'number' &&
    afterPaths.length > 0 &&
    beforePaths.every((p) => afterPaths.includes(p) || expectedAfter.includes(p)) &&
    after.agents.every((a) => typeof a.configVersion === 'number'),
  'the reconnecting subscriber saw a NEW bootId — the signal that its seq watermark is\n' +
  '    meaningless — and recovered the whole fleet from the authoritative list in one\n' +
  '    round trip, every row carrying the configVersion that makes the resync cheap',
  `resync not proven: bootId ${before.bootId} → ${after.bootId}, ` +
  `${beforePaths.length} agents before, ${afterPaths.length} after`
);
sub2.close();
stopDaemon(restarted.pid);

// ------------------------------------------------------------------ verdict --

console.log(`\n${'='.repeat(78)}`);
if (failures > 0) {
  console.log(`${failures} SECTION(S) FAILED`);
} else {
  console.log('all sections passed');
}
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
