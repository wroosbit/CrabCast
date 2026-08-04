#!/usr/bin/env node
// Proof for KAN-165: the three lifecycle events REPORT whether the durable
// write landed, instead of asserting that it did.
//
// WHAT FAILURE THIS WOULD CATCH: an `agent.configured` / `agent.activated` /
// `agent.deactivated` that fires identically whether or not the registry write
// succeeded, while the contract's sentence for it says the record was written.
// That was the shipped behaviour at `f2056a5`: the registry deliberately never
// throws — an unwritable log must not fail the lifecycle operation in flight —
// so the failure was answered on the RESPONSE (`durable: false`,
// `durabilityError`) and withheld from the EVENT. An event-only subscriber was
// told an agent had been configured, activated or stood down and had no signal
// at all that the disk did not know it. This script makes the write genuinely
// fail and reads what the events say.
//
// It is KAN-72's defect on a second surface. That one was recorded as "the
// durable record and the response must agree; a swallowed registry write behind
// `verified: true` is restart-amnesia re-entering through the error path". The
// event path was built afterwards and did not inherit it.
//
// Sections, against the ticket's acceptance criteria:
//
//   1. static      — all THREE lifecycle events declare `durable` required and
//                    `durabilityError` optional; the document says so for each;
//                    and EVERY emission site in src/router.ts carries it. The
//                    site count is asserted rather than assumed, so the scan
//                    cannot pass over an empty set. (AC 3, AC 4)
//   2. healthy     — a real daemon, real operations: all three events carry
//                    `durable: true` and no `durabilityError`, on the socket AND
//                    projected onto the MCP notification path.
//   3. degraded    — THE REGISTRY LOG IS MADE UNWRITABLE FOR REAL (chmod 0400,
//                    with the injection proven by an append this script itself
//                    attempts and requires to throw), and the same three
//                    operations are run. Every event carries `durable: false`
//                    and a `durabilityError` naming the real errno, and each
//                    one AGREES WITH ITS OWN RESPONSE. (AC 1)
//   4. mutation    — three mutants, each asserting its own edit count, each
//                    watched going red. (AC 2)
//                      4A restores the unconditional claim (`durability()`
//                         always answers true): the events say the record is on
//                         disk while the responses say it is not — the exact
//                         pre-fix disagreement, reproduced.
//                      4B removes the field entirely (`durability()` answers
//                         `{}`): the events go silent about durability, which is
//                         literally the behaviour on `origin/main`, and the MCP
//                         forwarder warns that a contract field is missing.
//                      4C deletes ONE site's spread from the SOURCE and re-runs
//                         section 1's scan over the mutated text, so the static
//                         audit is shown to be measuring something rather than
//                         counting to six.
//
// WHAT THIS SCRIPT DOES NOT COVER, because it is the script that produces the
// state it then reads:
//
//   - It INJECTS the write failure (chmod) rather than encountering one. It
//     therefore proves that the daemon reports a failed append truthfully; it
//     does NOT prove that a real full disk, quota boundary or short write
//     reaches the same code path. `writeFully` and `AgentRegistry.record` own
//     that boundary and are asserted at the unit of "the append threw" here.
//     The one production-shaped failure it does reproduce faithfully is
//     permissions, which is the one the daemon's own remedy text names.
//   - THE LIVE HALF REACHES THREE OF THE SIX EMISSION SITES, and the other
//     three are covered by section 1's scan and by `durability()`'s two returns
//     — which is a weaker thing, and is said here rather than left to be
//     inferred from six sites appearing in a passing section. Reached live:
//     `configure`'s site, `activate`'s SPAWN site, and `deactivate`'s
//     path-addressed-with-a-session site. NOT reached live: `activate`'s
//     CONVERGING re-attach site (it needs an agent already running that this
//     daemon has lost the terminal of — `verify-restart-survival.mjs` produces
//     that state but asserts nothing about durability), the SESSION-addressed
//     stand-down, and the close path for an agent whose pane is already gone.
//     Nobody covers those three at runtime today. What guarantees them is that
//     all six spread ONE function, that the scan fails by name if a site stops
//     doing so (section 4C), and that both of that function's returns carry the
//     field. The re-attach site is the one worth a runtime assertion if this is
//     ever revisited: its `durable: false` is the sharpest case the field has —
//     the repair a supervisor made precisely to get an agent back into
//     `expected()`, not reaching the disk.
//   - It says nothing about whether a SUBSCRIBER acts on `durable: false`. That
//     is Butchr's half, filed by them as KAN-162 and linked `Relates` to
//     KAN-165. Nobody on this side covers it and nothing here should be read as
//     though somebody does.
//   - `registry.degraded`'s own payload is `verify-event-contract.mjs`'s, which
//     produces that event by the same sealing technique. This script asserts
//     only that it STILL fires alongside the new field, so the machine-level
//     alarm and the per-operation answer are not confused for each other.
//
// Everything on the daemon side is real: real daemon processes, real router,
// bridge, registry and config loader, real NDJSON over a real unix socket, a
// real MCP server over real stdio. What is faked is the `herdr` binary — a shim
// on PATH answering in herdr's own JSON shapes. The registry is the real one
// writing to a real file, which is the whole point: the failure is a syscall
// failing, not a flag being set.
//
// Usage:
//   npm run build
//   node scripts/verify-event-durability.mjs [distDir]

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

/** The three events that sit on the durable write path. */
const LIFECYCLE = ['agent.configured', 'agent.activated', 'agent.deactivated'];

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
    await sleep(150);
  }
  console.log(`   (timed out after ${ms}ms waiting for ${what})`);
  return false;
};

// ---------------------------------------------------------------- the scratch --

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan165-durability-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// ------------------------------------------------------------------ the shim --
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs, so
// the daemon's PATH normalization cannot rediscover a real herdr install. It is
// stateful — `agent start` really adds a pane and `pane close` really removes
// one — because this script stands agents down and the deactivate path branches
// on whether the pane was really there.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN165_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const load = () => readJson(startedFile, []);
const save = (list) => fs.writeFileSync(startedFile, JSON.stringify(list, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
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
  out({ result: { agents: load().map((s) => ({
    name: s.name, agent: 'shell', cwd: s.cwd, pane_id: s.pane_id, agent_status: 'working'
  })) } });
}
if (a === 'agent' && b === 'read') {
  const found = load().find((s) => s.name === args[2]);
  if (!found) {
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
    process.exit(1);
  }
  out({ result: { read: { text: \`$ KAN-165 pane text for \${args[2]}\\n$\`, truncated: false } } });
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

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN165_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined
};

/** A directory the caller owns. CrabCast never creates one. */
let ownedSeq = 0;
function owned(name) {
  const dir = path.join(scratch, 'owned', `${name}-${ownedSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));
const { registryPathFor } = await import(path.join(distDir, 'agent-registry.js'));
const { EVENT_CONTRACT } = await import(path.join(distDir, 'events.js'));

// ---------------------------------------------------------- mutated builds --
//
// Section 4 breaks things on purpose, and every mutation asserts its own edit
// count: a find-and-replace that silently matched nothing would produce an
// unmutated build, a green result, and a section proving the opposite of what it
// claims.
//
// The mutants live at `<scratch>/dist-<name>`, so node resolves their bare
// imports by walking up to `<scratch>/node_modules` — a symlink to the real one.
// Without it the mutant cannot load the MCP SDK or node-pty and the section
// using it fails as a startup error rather than as a verdict.
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
    console.log(`   mutated ${name}/${file}: ${JSON.stringify(find.slice(0, 60))}… → (${replace.length} chars)`);
  }
  return target;
}

// -------------------------------------------------------- daemons & clients --

const daemons = [];
const clients = [];
const openSockets = [];
/** Registry files this script sealed, so cleanup can unseal them. */
const sealed = new Set();

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath, registry: registryPathFor(dataDir) };
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
 * A raw socket subscriber. The socket is where the events live, and a client
 * that only made requests would never find out what they carry.
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
  /** The event of this action for a given path, latest wins. */
  eventFor(action, agentPath) {
    return [...this.events].reverse().find((e) => e.action === action && e.path === agentPath);
  }
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
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: `verify-event-durability (${this.label})`, version: '0.0.0' }
      });
    } catch (err) {
      // A server that never handshakes has already said why on stderr, and
      // losing that leaves the section failing as a bare timeout.
      throw new Error(`${err.message}\n--- ${this.label} stderr ---\n${this.stderr}`);
    }
    this.notify('notifications/initialized');
  }
  callTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  /** Every event notification's structured payload, in arrival order. */
  eventPayloads() {
    return this.notifications
      .filter((n) => n.method === 'notifications/message')
      .map((n) => n.params?.data);
  }
  payloadFor(action, agentPath) {
    return [...this.eventPayloads()].reverse().find((p) => p?.action === action && p?.path === agentPath);
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
  // Unseal before the recursive remove: a 0400 registry inside a scratch tree
  // is exactly the state that leaves a temp directory behind.
  for (const f of sealed) { try { fs.chmodSync(f, 0o600); } catch {} }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

console.log(`dist under test: ${distDir}`);
console.log(`fake herdr:      ${path.join(shimDir, 'herdr')} (state ${shimState})`);
console.log(`scratch:         ${scratch}`);

// ================================================== 1. static — all three --

rule('1. STATIC — all THREE lifecycle events, in the contract, the document and every site');

const routerSrc = fs.readFileSync(path.join(repoRoot, 'src', 'router.ts'), 'utf8');
const docText = fs.readFileSync(path.join(repoRoot, 'docs', 'event-contract.md'), 'utf8');

/** The object literal passed to `broadcast(...)` around a given index. */
function enclosingLiteral(src, at) {
  const open = src.lastIndexOf('{', at);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return src.slice(open);
}

/**
 * Every lifecycle emission site, and whether it carries a durability answer.
 *
 * A site "carries" it by spreading the one helper that computes it or by writing
 * the field out; both are the answer, and neither is "probably fine". Taken as a
 * function of the source text rather than of a file, so section 4C can run the
 * same scan over a deliberately broken copy.
 *
 * IT MUST NOT BE ABLE TO PASS VACUOUSLY. A scan that found no sites — because an
 * action was renamed or the emitting shape changed — would satisfy "every site
 * carries durable" over an empty set, which is the failure this epic keeps
 * finding in new costumes. So the count is asserted and printed.
 */
function lifecycleSites(src) {
  const sites = [];
  for (const action of LIFECYCLE) {
    const needle = `action: '${action}'`;
    for (let i = -1; (i = src.indexOf(needle, i + 1)) !== -1; ) {
      // Only broadcasts. `action:` also appears on every `respond(...)`, and a
      // response's shape is deliberately NOT the event's.
      const literal = enclosingLiteral(src, i);
      const before = src.slice(Math.max(0, src.lastIndexOf('{', i) - 200), i);
      if (!/broadcast\(\s*$|broadcast\(\{[\s\S]*$/.test(before)) continue;
      sites.push({
        action,
        line: src.slice(0, i).split('\n').length,
        carriesDurable: /\.\.\.durability\(/.test(literal) || /\bdurable:/.test(literal)
      });
    }
  }
  return sites;
}

const sites = lifecycleSites(routerSrc);
console.log(`   lifecycle emission sites in src/router.ts: ${sites.length}`);
for (const s of sites) {
  console.log(`     router.ts:${String(s.line).padEnd(5)} ${s.action.padEnd(20)} carries a durability answer: ${s.carriesDurable}`);
}

// WHICH OF THESE THE LIVE HALF ACTUALLY REACHES, printed where a reader of a
// PASSING run sees it. Six green rows above look like six exercised sites, and
// they are not: sections 2 and 3 drive three of them. The other three are held
// by this scan plus `durability()`'s two returns, which is weaker, and saying so
// is the difference between a proof and a proof-shaped thing. See the header.
const LIVE_REACHED = 3;
console.log(
  `\n   of those, the live half (§2/§3) reaches ${LIVE_REACHED}: configure, activate's SPAWN branch,\n` +
  `   and deactivate's path-addressed-with-a-session branch. The other ${sites.length - LIVE_REACHED} —\n` +
  `   activate's converging RE-ATTACH branch, the session-addressed stand-down, and the\n` +
  `   already-gone close path — are covered by this scan and by durability()'s returns ONLY.`
);
if (sites.length !== 6) {
  console.log(
    `   NOTE: the site count moved from 6 to ${sites.length}. The split above was written for six ` +
    `sites and needs re-stating in this script's header.`
  );
}

// The helper every site spreads. Both of its branches must produce `durable`,
// or a site that looks correct inherits an absence — the same reasoning
// verify-event-contract applies to `deactivationCause`'s returns.
// Taken to the first column-0 `}`, NOT by brace-matching from the signature:
// this function's return TYPE is itself a braced literal, so matching from the
// first `{` after the parameter list yields the annotation — a body with no
// `return` in it, over which "every return carries durable" passes vacuously.
// That is the exact failure this check exists to catch, and it caught itself.
const durAt = routerSrc.indexOf('function durability(');
const durEnd = durAt === -1 ? -1 : routerSrc.indexOf('\n}\n', durAt);
const durBody = durAt === -1 || durEnd === -1 ? '' : routerSrc.slice(durAt, durEnd);
const durReturns = [...durBody.matchAll(/\breturn\b/g)].map((m) => durBody.slice(m.index, m.index + 120));
const durAllCarry = durReturns.length >= 2 && durReturns.every((r) => /durable:/.test(r));
console.log(`   durability() returns: ${durReturns.length}, every one carrying durable: ${durAllCarry}`);

const contractRows = LIFECYCLE.map((name) => {
  const spec = EVENT_CONTRACT[name];
  return {
    name,
    requiresDurable: spec.required.includes('durable') && !spec.optional.includes('durable'),
    errorOptional: spec.optional.includes('durabilityError') && !spec.required.includes('durabilityError'),
    // The `fires` sentence must not assert the write. This is the exact wording
    // the ticket was filed about: "`configure` was accepted and the record was
    // written", on an event that fires when it was not.
    assertsTheWrite: /record was written|record written/.test(spec.fires)
  };
});
console.log();
for (const r of contractRows) {
  console.log(
    `   ${r.name.padEnd(20)} durable REQUIRED: ${String(r.requiresDurable).padEnd(5)} ` +
    `durabilityError optional: ${String(r.errorOptional).padEnd(5)} ` +
    `fires-sentence asserts the write: ${r.assertsTheWrite}`
  );
}

// The document is the other copy of the same table, so it is checked against the
// code rather than against nothing. Each lifecycle row must name `durable` in
// its payload column, and the section explaining it must exist.
const docRows = LIFECYCLE.map((name) => {
  const row = docText.split('\n').find((l) => l.startsWith(`| \`${name}\``));
  return { name, row, namesDurable: Boolean(row && /`durable`/.test(row)) };
});
const docExplains =
  /### `durable` on the three lifecycle events/.test(docText) &&
  /\*\*`durable: false`\*\* — the operation happened and the registry write did not/.test(docText);
console.log();
for (const r of docRows) {
  console.log(`   docs §1 row for ${r.name.padEnd(20)} names \`durable\`: ${r.namesDurable}`);
}
console.log(`   docs §1 has the section explaining it, both values: ${docExplains}`);

verdict(
  sites.length >= 6 &&
    sites.every((s) => s.carriesDurable) &&
    // All three, not just the one a reviewer named. Asserted as a set, so
    // fixing two of three cannot pass.
    new Set(sites.map((s) => s.action)).size === 3 &&
    durAllCarry &&
    contractRows.every((r) => r.requiresDurable && r.errorOptional && !r.assertsTheWrite) &&
    docRows.every((r) => r.namesDurable) &&
    docExplains,
  `all three lifecycle events declare \`durable\` REQUIRED and \`durabilityError\` optional;\n` +
  `    no fires-sentence asserts a write it has not checked; all ${sites.length} emission sites carry\n` +
  `    the answer; and docs/event-contract.md §1 says the same for each of the three`,
  `sites=${sites.length} (${sites.filter((s) => !s.carriesDurable).length} without a durability answer), ` +
  `distinct actions=${new Set(sites.map((s) => s.action)).size}, durability() returns all carry=${durAllCarry}, ` +
  `contract=${JSON.stringify(contractRows)}, doc rows=${JSON.stringify(docRows.map((r) => r.namesDurable))}, ` +
  `doc explains=${docExplains}`
);

// ============================================ the run both live sections share --

/**
 * Drive one daemon through the three lifecycle operations twice: once against a
 * healthy registry, once against a registry that CANNOT BE WRITTEN.
 *
 * The failure is produced, not simulated. `AgentRegistry.record` does
 * `openSync(file, 'a')` and appends; sealing the file to 0400 makes that syscall
 * fail with a real EACCES, which is the same path a full disk or a bad
 * permission in a real data directory takes. Nothing here sets a flag, and the
 * daemon is not told anything.
 *
 * THE INJECTION IS PROVEN RATHER THAN ASSUMED. This script attempts the same
 * append itself and REQUIRES it to throw before going on. A sealing that
 * silently did not take — running as root, an exotic filesystem — would
 * otherwise leave the degraded half exercising the healthy path and reporting
 * green, which is precisely the shape of failure this whole epic is about.
 */
async function driveLifecycle(dist, label) {
  const cfg = makeConfig(label);
  const status = await startDaemon(cfg, dist, label);
  console.log(`   daemon ${label}: pid ${status.pid}, bootId ${status.bootId}`);

  // Both subscribers connect BEFORE anything happens. A subscriber that
  // connected afterwards would be testing replay, and there is none.
  const sub = await new SocketClient(cfg, `${label}-sub`).ready();
  const mcp = new McpClient(`${label}-mcp`, { dist, config: cfg.configPath });
  await mcp.initialize();
  await sleep(400); // let the MCP server's eager connect land

  const call = async (tool, args) => parsedText(await mcp.callTool(tool, args));

  // ---- healthy: one agent all the way through the three events -------------
  const HEALTHY = owned(`${label}-healthy`);
  const responses = { healthy: {}, degraded: {} };
  responses.healthy.configure =
    await call('crabcast_configure_agent', { path: HEALTHY, priority: 1, launcher: LAUNCHER });
  responses.healthy.activate =
    await call('crabcast_activate_agent', { path: HEALTHY, override: true });
  responses.healthy.deactivate =
    await call('crabcast_deactivate_agent', { path: HEALTHY });

  // ---- the agent the degraded half will activate and stand down ------------
  //
  // CONFIGURED WHILE THE REGISTRY STILL WORKS, deliberately: `activate` and
  // `deactivate` both read the record to find out what the agent is, and a
  // registry nobody can read is a different failure from one nobody can write.
  // This script is about the write.
  const VICTIM = owned(`${label}-victim`);
  await call('crabcast_configure_agent', { path: VICTIM, priority: 1, launcher: LAUNCHER });

  // ---- seal the registry, and prove the seal took --------------------------
  const registry = cfg.registry;
  if (!fs.existsSync(registry)) {
    throw new Error(`${label}: no registry at ${registry} to seal — the healthy half wrote nothing`);
  }
  fs.chmodSync(registry, 0o400);
  sealed.add(registry);

  let injectionProven = false;
  let injectionDetail = '';
  try {
    const fd = fs.openSync(registry, 'a');
    fs.closeSync(fd);
    injectionDetail = 'the append SUCCEEDED — the registry is still writable';
  } catch (e) {
    injectionProven = true;
    injectionDetail = `${e.code}: ${e.message}`;
  }
  console.log(`   sealed ${registry} to 0400; an append now throws: ${injectionProven} (${injectionDetail})`);
  if (!injectionProven) {
    throw new Error(
      `${label}: the write-failure injection did not take — appending to a 0400 file still ` +
      `succeeded (${injectionDetail}). Running as root will do this. The degraded half would ` +
      `have exercised the healthy path and reported green, so it is refused instead.`
    );
  }

  // ---- degraded: the same three events, against a registry that cannot be
  // ---- written. A NEW path for the configure, so the assertion is about a
  // ---- write that was attempted and failed rather than one that was skipped.
  const DEGRADED = owned(`${label}-degraded`);
  responses.degraded.configure =
    await call('crabcast_configure_agent', { path: DEGRADED, priority: 1, launcher: LAUNCHER });
  responses.degraded.activate =
    await call('crabcast_activate_agent', { path: VICTIM, override: true });
  responses.degraded.deactivate =
    await call('crabcast_deactivate_agent', { path: VICTIM });

  // The MCP notification path is asynchronous — it is a second process reading
  // the same socket — so it is waited for rather than assumed to have arrived.
  await waitFor(
    () => mcp.eventPayloads().some((p) => p?.action === 'agent.deactivated' && p?.path === VICTIM),
    10_000, `${label}: the MCP forwarder to deliver the last event`
  );

  fs.chmodSync(registry, 0o600);
  sealed.delete(registry);

  const paths = { HEALTHY, VICTIM, DEGRADED };
  const events = {
    healthy: {
      'agent.configured': sub.eventFor('agent.configured', HEALTHY),
      'agent.activated': sub.eventFor('agent.activated', HEALTHY),
      'agent.deactivated': sub.eventFor('agent.deactivated', HEALTHY)
    },
    degraded: {
      'agent.configured': sub.eventFor('agent.configured', DEGRADED),
      'agent.activated': sub.eventFor('agent.activated', VICTIM),
      'agent.deactivated': sub.eventFor('agent.deactivated', VICTIM)
    }
  };
  const mcpPayloads = {
    healthy: {
      'agent.configured': mcp.payloadFor('agent.configured', HEALTHY),
      'agent.activated': mcp.payloadFor('agent.activated', HEALTHY),
      'agent.deactivated': mcp.payloadFor('agent.deactivated', HEALTHY)
    },
    degraded: {
      'agent.configured': mcp.payloadFor('agent.configured', DEGRADED),
      'agent.activated': mcp.payloadFor('agent.activated', VICTIM),
      'agent.deactivated': mcp.payloadFor('agent.deactivated', VICTIM)
    }
  };
  const degradedEvents = sub.events.filter((e) => e.action === 'registry.degraded');

  mcp.kill();
  sub.close();
  stopDaemon(status.pid);

  return { cfg, paths, responses, events, mcpPayloads, degradedEvents, mcpStderr: mcp.stderr };
}

/**
 * The assertion sections 3 and 4 share, as a value rather than as a verdict.
 *
 * Section 3 requires it to be TRUE against the real build; section 4 requires it
 * to be FALSE against each mutant. One function, so a mutant cannot go green by
 * being measured more gently than the thing it is a mutation of.
 */
function degradedHolds(run) {
  const reasons = [];
  for (const name of LIFECYCLE) {
    const ev = run.events.degraded[name];
    if (!ev) { reasons.push(`${name}: no event was received at all`); continue; }
    if (ev.durable !== false) {
      reasons.push(`${name}: durable=${JSON.stringify(ev.durable)} (expected false)`);
    }
    if (typeof ev.durabilityError !== 'string' || ev.durabilityError.length === 0) {
      reasons.push(`${name}: durabilityError=${JSON.stringify(ev.durabilityError)} (expected a reason)`);
    }
    const mcpPayload = run.mcpPayloads.degraded[name];
    if (!mcpPayload || mcpPayload.durable !== false) {
      reasons.push(`${name}: the MCP projection carried durable=${JSON.stringify(mcpPayload?.durable)}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ============================================================ 2. healthy --

rule('THE LIVE RUN — one daemon, both halves (sections 2 and 3 assert on it)');

const real = await driveLifecycle(distDir, 'real');

rule('2. HEALTHY — the three events against a registry that works');

for (const name of LIFECYCLE) {
  show(`socket ${name}:`, real.events.healthy[name]);
}
console.log();
for (const name of LIFECYCLE) {
  const p = real.mcpPayloads.healthy[name];
  console.log(`   MCP ${name.padEnd(20)} durable=${JSON.stringify(p?.durable)} ` +
    `durabilityError present=${p ? 'durabilityError' in p : '(no payload)'}`);
}

const healthyOk = LIFECYCLE.every((name) => {
  const ev = real.events.healthy[name];
  const p = real.mcpPayloads.healthy[name];
  return ev && ev.durable === true && ev.durabilityError === undefined &&
    p && p.durable === true && !('durabilityError' in p);
});

verdict(
  healthyOk,
  'every lifecycle event carries `durable: true` and NO `durabilityError`, on the socket\n' +
  '    and projected onto the MCP notification path — so the field is really declared and\n' +
  '    really forwarded, rather than reaching socket subscribers and being dropped',
  'the healthy half did not carry durable: true on both paths — ' +
  LIFECYCLE.map((n) => `${n}: socket=${JSON.stringify(real.events.healthy[n]?.durable)} ` +
    `mcp=${JSON.stringify(real.mcpPayloads.healthy[n]?.durable)}`).join('; ')
);

// =========================================================== 3. degraded --

rule('3. DEGRADED — the registry made genuinely unwritable, and what the events say');

for (const name of LIFECYCLE) {
  show(`socket ${name}:`, real.events.degraded[name]);
}

const held = degradedHolds(real);

// The response is the surface that was ALREADY honest. The point of this slice
// is that the two now agree, so the comparison is made rather than assumed.
const responseSaysDegraded = {
  'agent.configured': real.responses.degraded.configure?.durable === false,
  'agent.activated': real.responses.degraded.activate?.durable === false,
  'agent.deactivated': real.responses.degraded.deactivate?.durable === false
};
console.log();
for (const name of LIFECYCLE) {
  console.log(
    `   ${name.padEnd(20)} response durable:false = ${String(responseSaysDegraded[name]).padEnd(5)} ` +
    `event durable = ${JSON.stringify(real.events.degraded[name]?.durable)}  → they agree: ` +
    `${responseSaysDegraded[name] && real.events.degraded[name]?.durable === false}`
  );
}
const agree = LIFECYCLE.every(
  (n) => responseSaysDegraded[n] === true && real.events.degraded[n]?.durable === false
);

// The machine-level alarm is unchanged, and is NOT what makes the per-operation
// answer legible: it carries no `path` and is on no path, so correlating it back
// to the operation it invalidates means parsing prose. It still fires, and this
// says so rather than letting the new field look like a replacement.
console.log(`\n   registry.degraded events also received: ${real.degradedEvents.length}`);
if (real.degradedEvents.length) {
  console.log(`     what: ${real.degradedEvents.map((e) => JSON.stringify(e.what)).join(', ')}`);
  console.log(`     (no \`path\` on any of them: ` +
    `${real.degradedEvents.every((e) => e.path === undefined)})`);
}

verdict(
  held.ok && agree && real.degradedEvents.length >= 3 &&
    real.degradedEvents.every((e) => e.path === undefined),
  'a real EACCES on the registry append reaches all three events as `durable: false` with a\n' +
  '    `durabilityError`, on the socket and on the MCP path, and each one AGREES WITH ITS OWN\n' +
  '    RESPONSE — which is KAN-72\'s rule ("the durable record and the response must agree")\n' +
  '    finally holding on the event surface. registry.degraded still fires, still without a path',
  `degraded half did not hold: ${held.reasons.join('; ') || '(field assertions passed)'}` +
  `${agree ? '' : ' | event and response disagree'} | ` +
  `registry.degraded count=${real.degradedEvents.length}`
);

// =========================================================== 4. mutations --

rule('4. MUTATION — the fix removed three ways, and every check watched going red');

// ---- 4A: restore the unconditional claim --------------------------------------
//
// `durability()` always answers true, which is the pre-fix assertion made
// explicit: the event says the record is on disk whatever the disk did. The
// RESPONSES are untouched by this mutation because they compute their own
// answer, so the mutant reproduces the exact disagreement KAN-165 was filed
// about — event says written, response says not — rather than an invented one.
console.log('\n  4A. `durability()` always answers `durable: true` — the unconditional claim, restored.\n');
const CLAIM = `    if (outcome === undefined || outcome.ok)
        return { durable: true };
    return { durable: false, durabilityError: outcome.error ?? 'registry write failed' };`;
const alwaysTrue = mutatedBuild('always-true', [
  { file: 'router.js', find: CLAIM, replace: `    return { durable: true };` }
]);
const mutantA = await driveLifecycle(alwaysTrue, 'always-true');
const heldA = degradedHolds(mutantA);
for (const name of LIFECYCLE) {
  console.log(`   ${name.padEnd(20)} event durable=${JSON.stringify(mutantA.events.degraded[name]?.durable)} ` +
    `while its response says durable=${JSON.stringify(
      { 'agent.configured': mutantA.responses.degraded.configure,
        'agent.activated': mutantA.responses.degraded.activate,
        'agent.deactivated': mutantA.responses.degraded.deactivate }[name]?.durable
    )}`);
}
console.log(`\n   section 3's assertion against this build: ${heldA.ok ? 'PASSED (wrong)' : 'FAILED (right)'}`);
if (!heldA.ok) console.log(`     ${heldA.reasons.join('\n     ')}`);

verdict(
  !heldA.ok,
  'restoring the unconditional claim turns section 3 RED. The events assert a record that is\n' +
  '    not on disk while the responses on the same daemon say it is not — the defect as filed,\n' +
  '    reproduced and caught',
  'section 3 PASSED against a daemon whose events always claim durability. It is not\n' +
  '    measuring what it says it measures'
);

// ---- 4B: remove the field entirely -------------------------------------------
//
// `durability()` answers `{}`, so the events carry no `durable` at all. That is
// literally the behaviour on `origin/main`: the event silent, the response
// honest. It also exercises the OTHER half of the contract — a declared field a
// broadcast did not carry is the `undefined`-at-a-subscriber defect, and the MCP
// forwarder is supposed to say so on our side of the boundary.
console.log('\n  4B. `durability()` answers `{}` — the field gone, which is what `origin/main` sends.\n');
const silent = mutatedBuild('silent', [
  { file: 'router.js', find: CLAIM, replace: `    return {};` }
]);
const mutantB = await driveLifecycle(silent, 'silent');
const heldB = degradedHolds(mutantB);
const warned = LIFECYCLE.filter((name) =>
  new RegExp(`${name.replace('.', '\\.')} arrived without contract field\\(s\\)[^\\n]*durable`).test(mutantB.mcpStderr)
);
console.log(`   events carrying durable at all: ` +
  LIFECYCLE.map((n) => `${n}=${'durable' in (mutantB.events.degraded[n] ?? {})}`).join(', '));
console.log(`   MCP forwarder warned "arrived without contract field(s) … durable" for: ` +
  `${warned.length ? warned.join(', ') : '(none)'}`);
console.log(`\n   section 3's assertion against this build: ${heldB.ok ? 'PASSED (wrong)' : 'FAILED (right)'}`);
if (!heldB.ok) console.log(`     ${heldB.reasons.join('\n     ')}`);

verdict(
  !heldB.ok && warned.length === 3,
  'removing the field turns section 3 RED, and the MCP forwarder names all three events as\n' +
  '    arriving without a contract field — so the drift is loud on our side of the boundary\n' +
  '    rather than rendering as an absence on the subscriber\'s',
  `section 3 passed=${heldB.ok} (expected false), forwarder warned for ${warned.length}/3 events`
);

// ---- 4C: the static audit, shown to be measuring something ---------------------
//
// Sections 4A and 4B mutate the helper, which turns all six sites at once — a
// good test of the runtime assertion and NO test of the scan in section 1, which
// is what catches a site that never spread the helper in the first place. This
// mutation is against the SOURCE TEXT rather than a build, because that is what
// the scan reads; nothing is written to disk.
console.log('\n  4C. one site\'s spread deleted from the source — does the section 1 scan notice?\n');
const spawnSite = routerSrc.indexOf(`action: 'agent.activated'`, routerSrc.indexOf(`action: 'agent.activated'`) + 1);
const spreadAt = routerSrc.indexOf('...durability(durable)', spawnSite);
if (spreadAt === -1) {
  throw new Error(
    'mutation 4C found no `...durability(durable)` after the second agent.activated site. ' +
    'The scan would have been run over an unmutated source, proving nothing. Fix the mutation.'
  );
}
const mutatedSrc = routerSrc.slice(0, spreadAt) + '/* deleted by 4C */' + routerSrc.slice(spreadAt + '...durability(durable)'.length);
const mutatedSites = lifecycleSites(mutatedSrc);
const uncovered = mutatedSites.filter((s) => !s.carriesDurable);
console.log(`   sites found in the mutated source: ${mutatedSites.length} (same as before: ${mutatedSites.length === sites.length})`);
console.log(`   sites the scan reports WITHOUT a durability answer: ${uncovered.length}`);
for (const s of uncovered) console.log(`     router.ts:${s.line} ${s.action}`);

verdict(
  mutatedSites.length === sites.length && uncovered.length === 1 &&
    uncovered[0].action === 'agent.activated',
  'deleting one site\'s spread is reported BY NAME and by line. The scan in section 1 is a\n' +
  '    measurement of the sites, not a count of them — so a fourteenth instance of "fix the\n' +
  '    member the reviewer named and leave its siblings" would fail this check',
  `the scan did not notice a deleted spread: ${mutatedSites.length} sites (was ${sites.length}), ` +
  `${uncovered.length} reported uncovered ${JSON.stringify(uncovered)}`
);

// ================================================================== verdict --

rule('VERDICT');
console.log(
  failures === 0
    ? `  All sections passed.\n` +
      `  All three lifecycle events report durability instead of asserting it; the answer is\n` +
      `  on the socket and on the MCP projection; a real unwritable registry produces\n` +
      `  \`durable: false\` on every one of them and agrees with the response; and three\n` +
      `  mutations — the unconditional claim restored, the field removed, one site's spread\n` +
      `  deleted — each turn a named check red.`
    : `  ${failures} section(s) FAILED.`
);
process.exit(failures ? 1 : 0);
