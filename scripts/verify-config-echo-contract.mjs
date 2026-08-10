#!/usr/bin/env node
// Live proof for KAN-166 and KAN-168: the `config` echo on BOTH read paths —
// `list_agents` and `agent_status` — has a declared-field contract, and it is
// the SAME declaration the event path enforces.
//
// WHAT FAILURE THIS WOULD CATCH: a field travelling inside `config` on a read
// response with nothing looking at it. That is not hypothetical and it was not
// old — KAN-164 made the MCP event projection walk `config`'s interior, and for
// one day afterwards the SAME `AgentConfig` object was guarded on the event
// surface and unguarded on the poll surface. The asymmetry mattered because of
// which half is which: §2 of `docs/event-contract.md` makes an authoritative
// `list` poll a CORRECTNESS requirement for every consumer of our events, so
// the unguarded half was the half a consumer is told to depend on. Remove the
// sweep this script exercises and section 3 shows exactly what that looked
// like: the field on the wire, and nothing on the response saying so.
//
// AND THEN IT HAPPENED AGAIN ONE SURFACE OVER, which is why this script now
// covers two (KAN-168). Closing the poll path left `agent_status` — the same
// object, the same `configEcho`, one agent instead of a fleet — unswept for
// four more days. It was named in §2 and in this header as a known hole, and a
// named hole is still a hole: a consumer polling ONE agent got no block at all
// and could not tell that from a clean sweep. The sections below read both
// surfaces off the SAME daemon and the same injected knob, and §3's third
// mutation removes the `agent_status` sweep while leaving `list_agents` swept —
// so this proof cannot pass the single-agent read on the fleet read's evidence.
//
// Sections, against the ticket's acceptance criteria:
//
//   1. the ordinary read — a real fleet with every echo-carrying category
//                          populated, on an UNMUTATED build: the block is on
//                          the response — on BOTH read surfaces, with
//                          `agent_status`'s `declared` identical to
//                          `list_agents`'s — `declared` IS the declaration
//                          rather than a copy of it, and `undeclared` is empty.
//                          Also the declared hole, observed: the caller's own
//                          `config.mcpServers` keys arrive and are NOT reported.
//                          SECTION 1 CANNOT TELL "nothing was there" FROM
//                          "nobody looked" — `undeclared: []` is what a daemon
//                          with no sweep at all answers, and this section is
//                          green against exactly that build. That is section
//                          2's job, and it is measured: with the sweep
//                          neutered, sections 2-5 go red and this one does not.
//                          A section that renders its own failure as an
//                          all-clear is worse than no section, so what makes
//                          this one worth anything is the one below it.
//   2. drift, by path     — a knob injected at a REAL emission site, reported
//                           as `agents[0].config.telemetryToken` and
//                           `standbyAgents[0].config.telemetryToken` — and
//                           STILL DELIVERED, because this surface reports and
//                           does not drop. The same daemon's MCP event
//                           notification DROPS it. (AC 1, AC 4)
//                           The SAME knob on the SAME daemon read back through
//                           `agent_status`, named `config.telemetryToken` —
//                           relative to the one row that response is about —
//                           and delivered there too (KAN-168 AC 1, AC 2).
//   3. the red half       — three mutations, each watched going red. The sweep
//                           removed: the field travels and the response says
//                           nothing, which is what `main` did before this
//                           change. The warning silenced with the sweep left
//                           in: the response still reports, so which artifact
//                           carries the answer is measured rather than
//                           asserted. (AC 2)
//                           And the `agent_status` sweep removed ALONE, with
//                           `list_agents` left swept: the fleet read still
//                           reports and the single-agent read goes silent,
//                           which is the four-day defect KAN-168 closed and the
//                           one a shared-call-site proof could not see
//                           (KAN-168 AC 3).
//   4. one declaration    — the same injected knob plus ONE edit adding it to
//                           `CONFIG_FIELDS`, and both surfaces move: the event
//                           notification publishes it and stops warning, the
//                           poll response stops reporting it. No second list is
//                           touched anywhere. (AC 3)
//   5. the residue        — the sweep walks the RESPONSE, so a category added
//                           straight into `respond({…})` — which no type can
//                           catch, and which `FleetCategories` says so — is
//                           swept the day it ships.
//   6. the scaffolding    — the fixture every section above depends on
//                           ACTIVATES agents, so it goes through the capacity
//                           gate, so a loaded machine used to decide what this
//                           proof observed (KAN-171). The activations are past
//                           the gate now, and this section backs that out and
//                           watches sections 1 and 2's exact failure come back.
//
// A PROOF THAT GOES RED ABOUT THE RUNNER (KAN-171). §1 and §2 read a fleet
// spanning three categories, and the fleet is built by activating agents. On a
// machine whose load average is above ~2.25 the gate refused both activations,
// every row landed in `unstartedAgents`, and this script reported "drift not
// proven" — a statement about the laptop wearing the words of a statement about
// the echo. Measured: 8/8 failures at load 2.6–2.8, 2/2 passes quiet, and green
// on the GitHub runner throughout, because the runner is quiet. The fixture
// passes `override` now (see PAST_THE_GATE), every lifecycle call it makes is
// checked, and the load average is PRINTED rather than compared against.
//
// WHAT THIS SCRIPT SUPPLIES, AND WHAT IT THEREFORE DOES NOT TEST. Sections 2-5
// INJECT the undeclared knob into a compiled build, at the place `configure`
// assembles the config object. What they prove is "an undeclared field inside
// an echoed config IS reported by path", not "no undeclared field exists
// today". That second claim is section 1's, on the unmutated build, over a
// fleet with every echo-carrying category non-empty — and it reads the same
// sweep, so a knob that really did grow inside `config` turns section 1 red
// with nothing here being touched. Two claims, and neither substitutes for the
// other. The injection is at a real emission site rather than in a hand-built
// row precisely because a proof that constructs the record it then asserts on
// has not tested that the field ARRIVES (KAN-145): the knob here travels parse
// → durable record → `configEcho` → response, and this script only reads the
// far end.
//
// WHAT NOTHING HERE COVERS, named rather than left to be inferred.
//
// This used to name `crabcast_agent_status` — the same object, one agent, no
// block at all. That is now covered, in every section, and the sentence is
// replaced rather than deleted because what it recorded is the pattern worth
// keeping: the hole was NAMED here from KAN-166 (#29, 2026-08-04) until
// KAN-168 and stayed open the whole time, so naming one is not closing one.
//
// What is genuinely outside this script today:
//
//   * The OTHER blocks on both read responses — `capacity`, `provenance`,
//     `pages`, the `*Total`s on `list_agents`, and everything outside the echo
//     on `agent_status`. They are contract by `docs/event-contract.md` and by
//     their own proofs, never by a declared-field check, and nothing here
//     examines them. KAN-166 named them as candidates and KAN-168 measured
//     them: none is nearly free (see that ticket's PR), so none was absorbed.
//   * `crabcast_daemon_status` (KAN-227), checked rather than assumed while
//     KAN-168 was open: its response carries pid, config and registry paths,
//     agent COUNTS, the event watermark, build and freshness — no `config`
//     echo, no `configEcho()` call, nothing for this sweep to walk. It is not a
//     fourth surface and needs no block. If it ever grows one, the sweep
//     applies unchanged and this bullet is the thing to come back to.
//
// Everything on the daemon side is real: a real daemon process, real router,
// bridge, registry and config loader, real NDJSON over a real unix socket, a
// real MCP server over real stdio. What is faked is the `herdr` binary — a shim
// on PATH answering in herdr's own JSON shapes. Isolation is a scratch dataDir
// and a scratch $HOME with a system-only PATH.
//
// Usage:
//   npm run build
//   node scripts/verify-config-echo-contract.mjs [distDir]

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const repoRoot = path.join(scriptDir, '..');

const LAUNCHER = 'shell';

/** The knob every mutated build grows, and the value it carries. */
const KNOB = 'telemetryToken';
const KNOB_VALUE = 'sk-live-UNDECLARED';

// --------------------------------------------------------------- the harness --

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => {
  const body = value === undefined ? '(undefined)' : JSON.stringify(value, null, 2);
  console.log(`   ${label}\n${String(body).replace(/^/gm, '     ')}`);
};
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
/**
 * A PRECONDITION, reported apart from a verdict.
 *
 * A completeness check over an empty list passes vacuously, so the things this
 * script asserts ON have to be asserted to EXIST first, and a failure here is a
 * failure of the run rather than of the code under test.
 */
const given = (ok, what, detail) => {
  console.log(`   ${ok ? 'given' : 'GIVEN FAILED'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan166-echo-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// ------------------------------------------------------------------ the shim --
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs. It
// is stateful: `agent start` really adds a pane and `pane close` really removes
// one, so the categories below are PRODUCED by real lifecycle calls rather than
// written into the registry by this script.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN166_SHIM_STATE;
const args = process.argv.slice(2);
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
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
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
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
    process.exit(1);
  }
  out({ result: { read: { text: '$ KAN-166 pane text\\n$', truncated: false } } });
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
  KAN166_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined
};

/** A directory the caller owns. CrabCast never creates one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));
const { CONFIG_FIELDS } = await import(path.join(distDir, 'events.js'));

// ------------------------------------------------------- mutated builds --
//
// EVERY MUTATION ASSERTS ITS OWN EDIT COUNT. A find-and-replace that silently
// matched nothing would produce an unmutated build, a green result, and a
// section proving the opposite of what it claims.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

/**
 * A copy of dist with one string replaced, or NULL when the edit did not apply.
 *
 * THIS USED TO THROW. A mutation whose anchor had drifted killed the process,
 * so every section after it — including the ones whose whole job is proving the
 * other checks can fail — never ran, and the reader got a stack trace with no
 * signal that anything had been skipped (KAN-138 item 18). `scripts/mutation.mjs`
 * keeps the exact-occurrence guard that was already right here and changes only
 * what happens when it fires: the failure is COUNTED into this script's own
 * verdict and the call returns null, so the rest of the file still reports.
 */
const { mutate: mutatedBuild, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => verdict(true, `${label}${detail ? ` — ${detail}` : ''}`, ''),
    fail: (label, detail) => verdict(false, '', `${label} — ${detail}`)
  }
});

/**
 * THE INJECTION, at the place `configure` assembles the config object.
 *
 * This is the same emission site KAN-164's depth proof uses, on purpose: it is
 * where a future slice adding a knob and forgetting to declare it would really
 * put it, and it is upstream of everything — the parse, the durable record, the
 * echo and the broadcast all carry whatever it produces.
 */
const INJECT_KNOB = {
  file: 'router.js',
  find: 'launcher: launcher.trim(),',
  replace:
    `launcher: launcher.trim(),\n` +
    `            /* KAN-166: a knob a future slice added and forgot to declare */\n` +
    `            ${KNOB}: '${KNOB_VALUE}',`
};

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

async function startDaemon(cfg, dist, label, env = {}) {
  const errFile = path.join(cfg.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg.configPath], {
    env: { ...childEnv, ...env },
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
  const client = await new SocketClient(cfg, `${label}-probe`).ready();
  const status = await client.request('daemon_status');
  client.close();
  daemons.push({ pid: status.pid, label });
  return status;
}

function stopDaemon(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/** A raw socket client: requests, and the broadcasts that arrive without an id. */
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
  constructor(label, { dist = distDir, config, env = {} }) {
    this.label = label;
    this.child = spawn(process.execPath, [path.join(dist, 'mcp.js'), config], {
      env: { ...childEnv, ...env },
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
        clientInfo: { name: `verify-config-echo-contract (${this.label})`, version: '0.0.0' }
      });
    } catch (err) {
      throw new Error(`${err.message}\n--- ${this.label} stderr ---\n${this.stderr}`);
    }
    this.notify('notifications/initialized');
    return r;
  }
  callTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
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
// A proof that cleans up only when it FINISHES is not a proof that cleans up:
// an interrupted run would leave a daemon holding a socket in a scratch
// directory that is about to be deleted (verify-proof-cleans-up-when-interrupted).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

console.log(`dist under test: ${distDir}`);
console.log(`fake herdr:      ${path.join(shimDir, 'herdr')} (state ${shimState})`);
console.log(`scratch:         ${scratch}`);

// --------------------------------------------------------------- the fleet --
//
// The caller's own MCP server definitions, which the contract promises are
// written verbatim and never read. They ride along on every agent so the ONE
// declared hole in the sweep is observed rather than only asserted in prose.
const CALLER_SERVERS = {
  'consumer-private': { command: 'true', args: ['--their-flag'], env: { THEIR_TOKEN: 'x' } }
};

/**
 * PAST THE GATE — and the distinction that makes it legitimate (KAN-171).
 *
 * The two activations below are SCAFFOLDING. Their purpose is to put a row in
 * `agents[]` and a row in `standbyAgents[]` so the sweep has more than one
 * category to walk; nothing in this file is a claim about the capacity gate.
 * Without this flag the gate is consulted, and on a machine whose 1-minute load
 * average is above ~2.25 (4 cores − 1 reserved for the human, ÷ 0.75 core per
 * agent) `headroomByLoad` is 0, both activations are refused, all three rows
 * land in `unstartedAgents`, and this proof goes red about the MACHINE:
 *
 *   §1  GIVEN FAILED  across at least three categories … unstartedAgents
 *   §2  FAILED — drift not proven: undeclared=["unstartedAgents[0].config.…"]
 *
 * Measured, not reasoned about: 8/8 failures at load 2.6–2.8 and 2/2 passes
 * quiet (KAN-170's table), reproduced at load 2.77 with the refusal printed —
 * `load too high — the load average is 2.77, against the 3.0 cores this machine
 * leaves to agents`. Every other artifact §2 prints is byte-identical between a
 * passing and a failing run; only the categories move. It passes on the GitHub
 * runner because the runner is quiet, which is what kept it hidden.
 *
 * THIS IS NOT "ADD A RETRY", AND IT IS NOT STEPPING AROUND THE CAP. `override`
 * on a fixture inside a proof is the established pattern here —
 * `verify-reconfiguration-refuses` and `verify-agent-power-controls` both name
 * a constant exactly like this one, and boot reconciliation (src/reconcile.ts)
 * passes `override: true` for the same reason. What remains forbidden is a
 * supervisor passing `override` to start REAL work past the machine's cap; the
 * gate exists because a human found their desktop unusable (KAN-34). Immunising
 * a fixture is not that.
 *
 * §6 is where this flag is shown to be load-bearing, deterministically.
 */
const PAST_THE_GATE = { override: true };

/**
 * Produce three echo-carrying categories on a daemon, through real lifecycle
 * calls: `agents` (running), `standbyAgents` (ran, stopped) and
 * `unstartedAgents` (configured, never run).
 *
 * EVERY LIFECYCLE CALL IS CHECKED, and that is the second half of the fix. The
 * flag above stops the known refusal; the preconditions below stop the NEXT one
 * from being read as evidence about the echo. A fleet that did not build is a
 * failure of the run — reported here, naming the refusal — rather than an empty
 * category the sweep then draws a conclusion from three sections later.
 *
 * The load average is PRINTED and never compared against. It is a measurement a
 * reader may want when something else goes wrong; a verdict derived from it
 * would be this script going red about the runner again, one level up.
 *
 * `gate` and `expectRefusals` are seams for §6 alone: they are how the red half
 * backs this defence out and says, on the line, that the refusals it gets are
 * the result rather than a failure. Every ordinary caller takes the defaults,
 * and an ordinary caller that IS refused fails the run.
 */
async function buildFleet(mcp, tag, { gate = PAST_THE_GATE, expectRefusals = false } = {}) {
  const running = owned(`${tag}-running`);
  const standby = owned(`${tag}-standby`);
  const unstarted = owned(`${tag}-unstarted`);
  // AWAITED. This used to read `parsedText(mcp.callTool(…))` with no `await`,
  // so it parsed a Promise, answered `{unparseable: ''}`, and the loop below
  // did not wait for the configure it had just issued — the three configures
  // and the activate that depends on them were in flight together. Nothing
  // asserted on the result, so it never showed. It has to be awaited now
  // because the preconditions below read it.
  const configure = async (p) => parsedText(await mcp.callTool('crabcast_configure_agent', {
    path: p, priority: 2, launcher: LAUNCHER, label: `${tag} row`, mcpServers: CALLER_SERVERS
  }));
  const configured = [];
  for (const p of [running, standby, unstarted]) configured.push(await configure(p));
  const upRunning = parsedText(
    await mcp.callTool('crabcast_activate_agent', { path: running, ...gate }));
  const upStandby = parsedText(
    await mcp.callTool('crabcast_activate_agent', { path: standby, ...gate }));
  const down = parsedText(await mcp.callTool('crabcast_deactivate_agent', { path: standby }));

  const why = (r) => String(r?.error ?? JSON.stringify(r)).split('\n')[0].slice(0, 200);
  const steps = [
    ...configured.map((r, i) => [`configure ${['running', 'standby', 'unstarted'][i]}`, r]),
    ['activate running', upRunning],
    ['activate standby', upStandby],
    ['deactivate standby', down]
  ];
  const refused = steps.filter(([, r]) => r?.success !== true);
  console.log(
    `   [${tag}] load average while this fleet was built: ` +
    `${fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ')} ` +
    `(reported, never asserted on — see PAST_THE_GATE)`
  );
  for (const [what, r] of refused) console.log(`   [${tag}] ${what} → REFUSED: ${why(r)}`);

  if (expectRefusals) {
    // Not a `given`: §6 asks for these refusals, and counting them as failures
    // of the run would put "GIVEN FAILED" in the log next to the section that
    // exists to produce them. The verdict there asserts on `refused` directly.
    console.log(`   [${tag}] ${refused.length} refusal(s) — EXPECTED by the caller (§6)`);
  } else {
    given(
      refused.length === 0,
      `[${tag}] every lifecycle call the fixture makes succeeded, so the categories below are ` +
        'what the daemon produced rather than what the machine refused',
      refused.length === 0
        ? `${steps.length} calls: ${steps.map(([w]) => w).join(', ')}`
        : `${refused.length} of ${steps.length} refused — ${refused.map(([w]) => w).join(', ')}`
    );
  }

  return { running, standby, unstarted, refused: refused.map(([what, r]) => ({ what, why: why(r) })) };
}

/** The categories one fleet's three directories actually landed in. */
function categoriesOf(listed, fleet) {
  const mine = new Set([fleet.running, fleet.standby, fleet.unstarted]);
  return new Set(
    echoRows(listed)
      .filter(({ row }) => mine.has(row.path))
      .map(({ at }) => at.replace(/\[\d+\].*/, ''))
  );
}

const listAgents = async (mcp) => parsedText(await mcp.callTool('crabcast_list_agents'));

/**
 * The OTHER read surface (KAN-168) — the same `config` object for one agent,
 * through the same `configEcho`, and since KAN-168 through the same sweep.
 *
 * DRIVEN THROUGH THE REAL MCP TOOL, exactly as `listAgents` is, so what these
 * sections read is what a consumer holds rather than a socket frame the tool
 * layer might reshape.
 */
const agentStatus = async (mcp, p) =>
  parsedText(await mcp.callTool('crabcast_agent_status', { path: p }));

/**
 * The two read surfaces' `declared` lists, compared to each other AND to the
 * exported table. "One declaration" is the whole claim of this file, and two
 * surfaces that each copied the same list would satisfy any check that only
 * looked at one of them.
 */
const sameDeclaration = (a, b) =>
  Array.isArray(a?.declared) && Array.isArray(b?.declared) &&
  JSON.stringify([...a.declared].sort()) === JSON.stringify([...b.declared].sort());

/** Every row on a response that carries a `config` echo, with where it was. */
function echoRows(listed) {
  const rows = [];
  for (const [key, value] of Object.entries(listed)) {
    if (!Array.isArray(value)) continue;
    value.forEach((row, i) => {
      if (row && typeof row === 'object' && 'config' in row) rows.push({ at: `${key}[${i}]`, row });
      const nested = row?.occupiedAgent;
      if (nested && typeof nested === 'object' && 'config' in nested) {
        rows.push({ at: `${key}[${i}].occupiedAgent`, row: nested });
      }
    });
  }
  return rows;
}

const driftLines = (client) => client.stderr.split('\n')
  .filter((l) => /carried undeclared field/.test(l));

// ==================================== 1. THE ORDINARY READ — nothing drifting --

rule('1. THE ORDINARY READ — the block is there, the list IS the declaration, and nothing is drifting');

const cleanCfg = makeConfig('clean');
const cleanStatus = await startDaemon(cleanCfg, distDir, 'clean');
const cleanMcp = new McpClient('clean', { config: cleanCfg.configPath });
await cleanMcp.initialize();
const cleanFleet = await buildFleet(cleanMcp, 'clean');
const cleanList = await listAgents(cleanMcp);
const cleanContract = cleanList.configEchoContract;
const cleanRows = echoRows(cleanList);

show('configEchoContract, as it arrives on an ordinary poll:', cleanContract);
console.log(`\n   echo-carrying rows on this response: ${cleanRows.length}`);
for (const { at, row } of cleanRows) {
  console.log(`     ${at.padEnd(22)} ${row.path ?? '(no path)'} — config ${row.config ? 'present' : 'null'}`);
}

// A COMPLETENESS CHECK OVER AN EMPTY LIST PASSES VACUOUSLY. `undeclared: []`
// over a response with no config echoes on it would be the same green as a
// clean fleet and would mean nothing, so the rows are asserted to exist and to
// span more than one category before anything is asserted about them.
//
// AND EVEN SO, THIS SECTION ALONE PROVES LESS THAN IT LOOKS LIKE IT DOES: a
// daemon whose sweep does nothing answers `undeclared: []` too, and this
// section is green against that build. Everything that makes the empty list
// MEAN something is in section 2 and section 3. Said here rather than only in
// the header, because this is where a reader would otherwise take the verdict
// line at face value.
const cleanCategories = new Set(cleanRows.map(({ at }) => at.replace(/\[\d+\].*/, '')));
given(
  cleanRows.filter(({ row }) => row.config).length >= 3,
  'the response carries at least three NON-NULL config echoes',
  `${cleanRows.filter(({ row }) => row.config).length} of ${cleanRows.length} rows`
);
given(
  cleanCategories.size >= 3,
  'across at least three categories — an empty or single-category fleet would pass ' +
    'the next check while proving nothing',
  [...cleanCategories].join(', ')
);

// `declared` must BE the declaration rather than a copy that happens to agree
// today. Compared against the exported table, in both directions.
const declaredKnobs = Object.keys(CONFIG_FIELDS);
const declaredIsTheDeclaration =
  Array.isArray(cleanContract?.declared) &&
  cleanContract.declared.length === declaredKnobs.length &&
  declaredKnobs.every((k) => cleanContract.declared.includes(k)) &&
  cleanContract.declared.every((k) => declaredKnobs.includes(k));

// The declared hole, observed on the wire rather than asserted in prose: the
// caller's own server names live inside `config.mcpServers`, and reporting them
// would be this daemon complaining about bytes it promised never to read.
const runningRow = cleanRows.find(({ row }) => row.path === cleanFleet.running)?.row;
const callerBytesArrived =
  JSON.stringify(runningRow?.config?.mcpServers) === JSON.stringify(CALLER_SERVERS);
show('the caller\'s own mcpServers, echoed back whole:', runningRow?.config?.mcpServers);

verdict(
  cleanContract !== undefined &&
    declaredIsTheDeclaration &&
    cleanContract.drops === false &&
    Array.isArray(cleanContract.verbatim) && cleanContract.verbatim.includes('mcpServers') &&
    Array.isArray(cleanContract.undeclared) && cleanContract.undeclared.length === 0 &&
    callerBytesArrived &&
    // Every echo-carrying row really has the echo, so "no drift" is a statement
    // about a populated response.
    cleanRows.every(({ row }) => 'config' in row),
  `every response carries the block; \`declared\` is CONFIG_FIELDS itself (${declaredKnobs.join(', ')})\n` +
  `    rather than a copy; \`drops\` is false; and across ${cleanRows.length} echo-carrying rows in\n` +
  `    ${cleanCategories.size} categories NOTHING is undeclared — while the caller's own\n` +
  `    config.mcpServers keys arrived whole and were correctly not reported, which is the one\n` +
  `    region the declaration deliberately does not examine`,
  `ordinary read wrong: block=${JSON.stringify(cleanContract)}, ` +
  `declaredIsTheDeclaration=${declaredIsTheDeclaration}, callerBytes=${callerBytesArrived}, ` +
  `rows=${cleanRows.length}`
);

// ---- the SAME block on the single-agent read, same daemon (KAN-168) ----
//
// A SEPARATE VERDICT rather than more clauses on the one above. These are two
// surfaces, and a reader who sees one line go red needs to know which of them
// it was — the failure this ticket closed was precisely one surface behaving
// unlike the other while a single sentence covered both.
//
// THREE READS, because `agent_status` answers on branches `list_agents` does
// not have: a live agent, a configured-and-stopped one, and a path that is
// neither. The third is a REFUSAL, and it carries the block too — §2 makes the
// block ride every response so "nothing was there" and "nobody looked" stay
// apart, and a refusal exempted from that rule would be the one response whose
// `extra` can carry an echo and say nothing about it.
const statusRunning = await agentStatus(cleanMcp, cleanFleet.running);
const statusStandby = await agentStatus(cleanMcp, cleanFleet.standby);
// A REAL directory that was never configured, so this lands on the
// neither-a-record-nor-a-pane branch — the refusal that carries an echo
// (`config: null`) — rather than on the bad-address one that carries nothing.
const statusNoSuch = await agentStatus(cleanMcp, owned('never-an-agent'));

show('agent_status (running) — configEchoContract:', statusRunning.configEchoContract);
show('agent_status (standby) — configEchoContract.undeclared:',
  statusStandby.configEchoContract?.undeclared);
console.log(
  `\n   agent_status on a path that is neither a record nor a pane: ` +
  `success=${statusNoSuch.success}, block ` +
  `${statusNoSuch.configEchoContract ? 'PRESENT' : 'ABSENT'}`
);

given(
  statusRunning.success === true && Boolean(statusRunning.config),
  'the single-agent read answered with a non-null echo to sweep',
  `success=${statusRunning.success}, config=${statusRunning.config ? 'present' : 'null'}`
);
given(
  statusNoSuch.success === false,
  'the third read really is the refusal branch — otherwise the block on it proves nothing',
  `success=${statusNoSuch.success}`
);

verdict(
  statusRunning.configEchoContract !== undefined &&
    // THE SAME DECLARATION, compared surface-to-surface and then to the
    // exported table. Two surfaces each holding their own copy of the same
    // eight knobs would pass a check that only looked at one.
    sameDeclaration(statusRunning.configEchoContract, cleanContract) &&
    statusRunning.configEchoContract.declared.length === declaredKnobs.length &&
    declaredKnobs.every((k) => statusRunning.configEchoContract.declared.includes(k)) &&
    statusRunning.configEchoContract.drops === false &&
    (statusRunning.configEchoContract.verbatim ?? []).includes('mcpServers') &&
    statusRunning.configEchoContract.undeclared.length === 0 &&
    // The caller's own bytes arrive here too, and are not reported here either.
    JSON.stringify(statusRunning.config?.mcpServers) === JSON.stringify(CALLER_SERVERS) &&
    // A stopped agent is still a record, so it still carries an echo and still
    // gets swept.
    statusStandby.configEchoContract?.undeclared.length === 0 &&
    Boolean(statusStandby.config) &&
    // …and the refusal.
    statusNoSuch.configEchoContract !== undefined &&
    statusNoSuch.configEchoContract.drops === false,
  `the single-agent read carries the same block from the same declaration — identical \`declared\`\n` +
  `    on both surfaces and identical to CONFIG_FIELDS, \`drops\` false, nothing undeclared — on a\n` +
  `    running agent, on a stopped one, and on the REFUSAL for a path that was never an agent`,
  `agent_status block wrong: running=${JSON.stringify(statusRunning.configEchoContract)}, ` +
  `sameDeclaration=${sameDeclaration(statusRunning.configEchoContract, cleanContract)}, ` +
  `standby=${JSON.stringify(statusStandby.configEchoContract?.undeclared)}, ` +
  `refusal=${JSON.stringify(statusNoSuch.configEchoContract)}`
);

cleanMcp.kill();
stopDaemon(cleanStatus.pid);

// ===================================== 2. DRIFT — reported by path, delivered --

rule('2. DRIFT — a knob injected at a REAL emission site, named by its path and still delivered');

// WHY THE SAME SECTION MEASURES BOTH SURFACES. The claim is not "the poll path
// reports" alone; it is that the two paths are guarded by one declaration and
// answer DIFFERENTLY on purpose. Asserting the poll side by itself would leave
// "and the event path drops it" as prose, which is the half a consumer reading
// one response cannot check.
// Hoisted so this section can be SKIPPED WHOLE when an edit does not apply,
// without changing what anything after it can see. See scripts/mutation.mjs.
let driftContract, configuredEvent, driftDist;
mutation1: {
  driftDist = mutatedBuild('drift', [INJECT_KNOB]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!driftDist) break mutation1;
  const driftCfg = makeConfig('drift');
  const driftStatus = await startDaemon(driftCfg, driftDist, 'drift');
  const driftSub = await new SocketClient(driftCfg, 'drift-sub').ready();
  const driftMcp = new McpClient('drift', { config: driftCfg.configPath });
  await driftMcp.initialize();
  await sleep(500);

  const driftFleet = await buildFleet(driftMcp, 'drift');
  await waitFor(
    () => driftMcp.eventPayloads().some(
      (d) => d?.action === 'agent.configured' && d?.path === driftFleet.running),
    15_000,
    'agent.configured on the MCP forwarder'
  );
  const driftList = await listAgents(driftMcp);
  driftContract = driftList.configEchoContract;
  const driftRows = echoRows(driftList);

  configuredEvent = driftMcp.eventPayloads()
    .find((d) => d?.action === 'agent.configured' && d?.path === driftFleet.running);
  const socketEvent = driftSub.eventsNamed('agent.configured')
    .find((e) => e.path === driftFleet.running);

  console.log(`\n   injected at the emission site: config.${KNOB} = ${KNOB_VALUE}\n`);
  show('POLL — configEchoContract.undeclared:', driftContract?.undeclared);
  show('POLL — the echo on the running row (the field is STILL THERE):',
    driftRows.find(({ row }) => row.path === driftFleet.running)?.row?.config);
  show('MCP EVENT — the same config, projected (the field is GONE):', configuredEvent?.config);
  show('SOCKET EVENT — a minimum, so it arrives:', socketEvent?.config?.[KNOB]);
  console.log(`\n   drift the MCP forwarder reported:`);
  console.log(`     ${driftLines(driftMcp).join('\n     ') || '(NONE)'}`);

  const daemonLogPath = path.join(driftCfg.dataDir, 'daemon.log');
  const daemonLog = fs.readFileSync(daemonLogPath, 'utf8');
  const daemonWarnings = daemonLog.split('\n')
    .filter((l) => /echoed undeclared config field/.test(l));
  console.log(`\n   daemon-side warning (${daemonLogPath}):`);
  console.log(`     ${daemonWarnings.join('\n     ') || '(NONE)'}`);

  // A SECOND POLL, to measure the once-per-boot damping claim rather than assert
  // it. `list_agents` is polled continuously by design, so a per-response warning
  // would be a log flood — and a claim about a log is exactly the kind that is
  // easy to write and never checked.
  await listAgents(driftMcp);
  const secondList = await listAgents(driftMcp);
  const warningsAfter = fs.readFileSync(daemonLogPath, 'utf8').split('\n')
    .filter((l) => /echoed undeclared config field/.test(l));

  // BY PATH, not by name: the same knob is on every row, and which row is what
  // the path adds. Both an `agents` row and a `standbyAgents` row are required,
  // so a report that named the field once with no address would fail here.
  const namesPath = (list, prefix) =>
    (list ?? []).some((p) => new RegExp(`^${prefix}\\[\\d+\\]\\.config\\.${KNOB}$`).test(p));
  const stillDelivered = driftRows.every(({ row }) => !row.config || row.config[KNOB] === KNOB_VALUE);

  given(
    driftRows.filter(({ row }) => row.config).length >= 3,
    'the mutated fleet carries at least three non-null echoes to sweep',
    `${driftRows.filter(({ row }) => row.config).length} rows`
  );

  verdict(
    namesPath(driftContract?.undeclared, 'agents') &&
      namesPath(driftContract?.undeclared, 'standbyAgents') &&
      namesPath(driftContract?.undeclared, 'unstartedAgents') &&
      // REPORTED AND NOT DROPPED, which is this surface's stated behaviour. A
      // response that reported the field and withheld it would satisfy the line
      // above and break the echo's own promise to be the record verbatim.
      driftContract?.drops === false &&
      stillDelivered &&
      // The other surface, on the SAME daemon and the same broadcast: dropped and
      // named. One declaration, two behaviours, both observed.
      configuredEvent?.config?.[KNOB] === undefined &&
      driftLines(driftMcp).some((l) => new RegExp(`config\\.${KNOB}`).test(l)) &&
      // The socket is a minimum and filters nothing — §4 — so it still arrives
      // there, which is what makes the MCP drop a projection rather than a filter
      // somewhere upstream.
      socketEvent?.config?.[KNOB] === KNOB_VALUE &&
      // Every declared knob survived on both paths. A sweep that "found" the
      // drift by mangling the echo would pass every line above.
      driftRows.find(({ row }) => row.path === driftFleet.running)?.row?.config?.launcher === LAUNCHER &&
      configuredEvent?.config?.launcher === LAUNCHER &&
      // The daemon says it out loud too, once per field per boot — three polls,
      // one line.
      daemonWarnings.length === 1 && warningsAfter.length === 1 &&
      // …and the RESPONSE says it every time, which is the half that matters.
      secondList.configEchoContract?.undeclared?.length === driftContract.undeclared.length,
    `a knob injected where \`configure\` assembles the config travelled to every category and\n` +
    `    was named by its FULL PATH on each — agents[], standbyAgents[], unstartedAgents[] — and\n` +
    `    was STILL DELIVERED in the echo, because this surface reports and does not drop. The\n` +
    `    same daemon's MCP event notification DROPPED it and named it \`config.${KNOB}\`,\n` +
    `    while the socket subscriber received it, which is §4's asymmetry. Every declared knob\n` +
    `    survived on both paths. The daemon warned ONCE across three polls; the response\n` +
    `    reported on all three`,
    `drift not proven: undeclared=${JSON.stringify(driftContract?.undeclared)}, ` +
    `drops=${driftContract?.drops}, stillDelivered=${stillDelivered}, ` +
    `event=${JSON.stringify(configuredEvent?.config?.[KNOB])}, ` +
    `mcpDrift=[${driftLines(driftMcp).join(' | ')}], ` +
    `socket=${JSON.stringify(socketEvent?.config?.[KNOB])}, ` +
    `daemonWarnings=${daemonWarnings.length}/${warningsAfter.length}`
  );

  // ---- the same injected knob, read back off `agent_status` (KAN-168) ----
  //
  // THE SAME DAEMON, THE SAME BUILD, THE SAME KNOB. Nothing is injected a
  // second time and no payload is hand-built: the field went in once where
  // `configure` assembles the config, and both surfaces are read off the far
  // end of that one journey. That is what makes this "produced, not simulated"
  // — the claim is that the field ARRIVES on this surface, and a probe that
  // constructed its own row would have tested the sweep and not the arrival
  // (KAN-145's defect, and this epic's central one).
  //
  // BY PATH, and the path is SHORTER here on purpose. `list_agents` names the
  // row it found the field on (`agents[0].config.telemetryToken`) because it
  // carries many; `agent_status` answers about ONE agent, so the same walker
  // over a payload whose `config` sits at the top level yields
  // `config.telemetryToken`. Asserting the fleet spelling here would be
  // asserting a bug.
  const driftStatusRunning = await agentStatus(driftMcp, driftFleet.running);
  const driftStatusUnstarted = await agentStatus(driftMcp, driftFleet.unstarted);

  show('AGENT_STATUS — configEchoContract.undeclared:',
    driftStatusRunning.configEchoContract?.undeclared);
  show('AGENT_STATUS — the echo (the field is STILL THERE):', driftStatusRunning.config);

  // ONE DEFECT, NOT TWO. The daemon's warning is deduped per FIELD across both
  // read surfaces, because the undeclared knob is on the record and the record
  // is one object. Measured rather than asserted in prose: the log still holds
  // exactly the one line it held after three polls, now that two more reads on
  // a different surface have seen the same field.
  const warningsAfterStatus = fs.readFileSync(daemonLogPath, 'utf8').split('\n')
    .filter((l) => /echoed undeclared config field/.test(l));
  console.log(
    `\n   daemon.log lines after 3 list_agents + 2 agent_status reads: ` +
    `${warningsAfterStatus.length} (one defect, one line)`
  );

  const statusNames = (list) =>
    (list ?? []).some((p) => p === `config.${KNOB}`);

  given(
    Boolean(driftStatusRunning.config) && Boolean(driftStatusUnstarted.config),
    'both single-agent reads carry a non-null echo — an absent echo would report no drift ' +
      'for the wrong reason',
    `running=${Boolean(driftStatusRunning.config)}, unstarted=${Boolean(driftStatusUnstarted.config)}`
  );

  verdict(
    // Reported, by the path this surface uses…
    statusNames(driftStatusRunning.configEchoContract?.undeclared) &&
      statusNames(driftStatusUnstarted.configEchoContract?.undeclared) &&
      // …and STILL DELIVERED, which is this surface's stated behaviour too.
      driftStatusRunning.configEchoContract?.drops === false &&
      driftStatusRunning.config?.[KNOB] === KNOB_VALUE &&
      driftStatusUnstarted.config?.[KNOB] === KNOB_VALUE &&
      // Every declared knob survived. A sweep that "found" the drift by
      // mangling the echo would pass every line above.
      driftStatusRunning.config?.launcher === LAUNCHER &&
      // The two surfaces agree about what a config IS, while disagreeing about
      // nothing: same declaration, same verdict, different path spellings.
      sameDeclaration(driftStatusRunning.configEchoContract, driftContract) &&
      // And the log did not grow a second complaint about the same knob.
      warningsAfterStatus.length === 1,
    `the SAME knob, injected once where \`configure\` assembles the config, came back named on\n` +
    `    the single-agent read as \`config.${KNOB}\` — for a running agent and for a\n` +
    `    never-started one — and was STILL DELIVERED there, off the same declaration the fleet\n` +
    `    read used. The daemon's log still carries ONE line across both surfaces, because the\n` +
    `    undeclared knob is one defect on one record rather than one per verb that echoes it`,
    `agent_status drift not proven: running.undeclared=` +
    `${JSON.stringify(driftStatusRunning.configEchoContract?.undeclared)}, ` +
    `unstarted.undeclared=${JSON.stringify(driftStatusUnstarted.configEchoContract?.undeclared)}, ` +
    `drops=${driftStatusRunning.configEchoContract?.drops}, ` +
    `onWire=${JSON.stringify(driftStatusRunning.config?.[KNOB])}, ` +
    `warnings=${warningsAfterStatus.length}`
  );

  driftMcp.kill();
  driftSub.close();
  stopDaemon(driftStatus.pid);

}
// ============================================ 3. THE RED HALF — two mutations --

rule('3. THE RED HALF — the sweep removed, and the warning silenced');

// A FIX WITHOUT A PROOF SHOWN TO FAIL IS NOT PROVEN. The first mutation is not
// an invented breakage: `sweepConfigEchoes` doing nothing IS what `main` did
// before this change — the echo went out whole with nothing examining it — so
// what section 2 asserts is measured against the behaviour it replaced.
// Hoisted so this section can be SKIPPED WHOLE when an edit does not apply,
// without changing what anything after it can see. See scripts/mutation.mjs.
let noSweepDist, quietDist;
mutation2: {
  noSweepDist = mutatedBuild('no-sweep', [
    INJECT_KNOB,
    {
      file: 'router.js',
      find: "sweepConfigEchoes(payload, '', echoDrift);",
      replace: "/* KAN-166 section 3: the sweep removed — what main did before this change */;"
    }
  ]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!noSweepDist) break mutation2;
  const noSweepCfg = makeConfig('no-sweep');
  const noSweepStatus = await startDaemon(noSweepCfg, noSweepDist, 'no-sweep');
  const noSweepMcp = new McpClient('no-sweep', { config: noSweepCfg.configPath });
  await noSweepMcp.initialize();
  await buildFleet(noSweepMcp, 'no-sweep');
  const noSweepList = await listAgents(noSweepMcp);
  const noSweepRows = echoRows(noSweepList);
  const noSweepWarnings = fs.readFileSync(path.join(noSweepCfg.dataDir, 'daemon.log'), 'utf8')
    .split('\n').filter((l) => /echoed undeclared config field/.test(l));

  show('with the sweep removed — configEchoContract:', noSweepList.configEchoContract);
  show('…and the field on the wire anyway:',
    noSweepRows.find(({ row }) => row.config)?.row?.config?.[KNOB]);

  // The second mutation separates the two artifacts. KAN-152's framing — WHICH
  // ARTIFACT CARRIES WHICH GUARANTEE — is the thing this ticket exists to adopt,
  // and a log line is not a contract: a consumer never reads our daemon.log.
  quietDist = mutatedBuild('quiet', [
    INJECT_KNOB,
    {
      file: 'router.js',
      // The surface argument is KAN-168's: one warning function now serves both
      // read paths and names which one saw the field first.
      find: "this.warnOnEchoDrift(echoDrift, 'list_agents');",
      replace: '/* KAN-166 section 3: the warning silenced, the sweep left alone */;'
    }
  ]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!quietDist) break mutation2;
  const quietCfg = makeConfig('quiet');
  const quietStatus = await startDaemon(quietCfg, quietDist, 'quiet');
  const quietMcp = new McpClient('quiet', { config: quietCfg.configPath });
  await quietMcp.initialize();
  await buildFleet(quietMcp, 'quiet');
  const quietList = await listAgents(quietMcp);
  const quietWarnings = fs.readFileSync(path.join(quietCfg.dataDir, 'daemon.log'), 'utf8')
    .split('\n').filter((l) => /echoed undeclared config field/.test(l));

  show('with only the WARNING silenced — configEchoContract.undeclared:',
    quietList.configEchoContract?.undeclared);
  console.log(`   daemon.log lines: ${quietWarnings.length}`);

  const noSweepEchoes = noSweepRows.filter(({ row }) => row.config).length;
  given(noSweepEchoes >= 3,
    'the sweep-removed build produced echoes to miss — an empty fleet would report ' +
      'no drift for the wrong reason',
    `${noSweepEchoes} rows`);

  verdict(
    // MUTATION 1: the response is green while the field is on the wire. That is
    // section 2's assertion going red, and it is the shipped defect exactly.
    noSweepList.configEchoContract?.undeclared?.length === 0 &&
      noSweepRows.some(({ row }) => row.config?.[KNOB] === KNOB_VALUE) &&
      noSweepWarnings.length === 0 &&
      // MUTATION 2: the log goes quiet and the RESPONSE still answers. Which is
      // what makes the response the contract and the log a convenience.
      quietWarnings.length === 0 &&
      (quietList.configEchoContract?.undeclared ?? []).some((p) => p.endsWith(`.config.${KNOB}`)),
    `removing the sweep turned section 2 red exactly as it must: the injected field reached\n` +
    `    ${noSweepEchoes} echoes and \`undeclared\` came back EMPTY, with nothing in daemon.log —\n` +
    `    a response that looks identical to a clean fleet, which is what main shipped. And with\n` +
    `    only the WARNING removed the response still named the field, so the answer is carried by\n` +
    `    the response rather than by a log nobody downstream reads`,
    `the red half did not go red: noSweep.undeclared=` +
    `${JSON.stringify(noSweepList.configEchoContract?.undeclared)}, ` +
    `fieldOnWire=${noSweepRows.some(({ row }) => row.config?.[KNOB] === KNOB_VALUE)}, ` +
    `noSweepWarnings=${noSweepWarnings.length}, quietWarnings=${quietWarnings.length}, ` +
    `quiet.undeclared=${JSON.stringify(quietList.configEchoContract?.undeclared)}`
  );

  noSweepMcp.kill();
  stopDaemon(noSweepStatus.pid);
  quietMcp.kill();
  stopDaemon(quietStatus.pid);

}
// ============ 3b. THE RED HALF, ONE SURFACE OVER — agent_status unswept alone --

rule('3b. THE RED HALF for the single-agent read — its sweep removed, the fleet sweep left in');

// WHY THIS MUTATION IS DIFFERENT FROM THE TWO ABOVE, and why the section is
// worth its runtime. Mutations 1 and 2 remove machinery BOTH surfaces share, so
// either would turn every assertion in this file red at once — which proves the
// assertions can fail, and proves nothing about the two surfaces being
// separately guarded. This one removes the `agent_status` call site ALONE and
// leaves `list_agents` swept.
//
// THAT IS THE ACTUAL DEFECT KAN-168 CLOSED, reproduced rather than imagined:
// from KAN-166 (#29, 2026-08-04) until KAN-168, `main` swept the fleet read and
// not the single-agent read, and every proof here was green. So the build below is what
// `main` was, and the section's whole job is to show that this file now
// notices. A proof that could pass the single-agent read on the fleet read's
// evidence would be exactly the artifact this epic keeps finding — one whose
// sentence claims more than its mechanism covers.
//
// THE REPLACEMENT RESTORES THE PRE-FIX BEHAVIOUR EXACTLY, rather than
// approximating it: `respond(payload)` with no sweep, no warning and NO BLOCK,
// which is what a caller met before this change. Reporting `undeclared: []`
// would be a weaker mutant and a different bug.
mutation3: {
  const statusUnsweptDist = mutatedBuild('status-unswept', [
    INJECT_KNOB,
    {
      file: 'router.js',
      find:
        '            const drift = [];\n' +
        "            sweepConfigEchoes(payload, '', drift);\n" +
        "            this.warnOnEchoDrift(drift, 'agent_status');\n" +
        '            respond({ ...payload, configEchoContract: configEchoContract(drift) });',
      replace:
        '            /* KAN-168 §3b: agent_status unswept — main from #29 to KAN-168 */\n' +
        '            respond(payload);'
    }
  ]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!statusUnsweptDist) break mutation3;

  const unsweptCfg = makeConfig('status-unswept');
  const unsweptStatus = await startDaemon(unsweptCfg, statusUnsweptDist, 'status-unswept');
  const unsweptMcp = new McpClient('status-unswept', { config: unsweptCfg.configPath });
  await unsweptMcp.initialize();
  const unsweptFleet = await buildFleet(unsweptMcp, 'status-unswept');

  const unsweptList = await listAgents(unsweptMcp);
  const unsweptStatusRead = await agentStatus(unsweptMcp, unsweptFleet.running);

  show('fleet read on the mutant — still reports (this half is untouched):',
    unsweptList.configEchoContract?.undeclared);
  show('single-agent read on the mutant — configEchoContract:',
    unsweptStatusRead.configEchoContract);
  show('…and the field on the wire there anyway:', unsweptStatusRead.config?.[KNOB]);

  given(
    Boolean(unsweptStatusRead.config),
    'the mutant answered the single-agent read with an echo to miss',
    `config=${unsweptStatusRead.config ? 'present' : 'null'}`
  );

  verdict(
    // THE SURVIVING HALF. If this went quiet too, the mutation was broader than
    // designed and the section would be measuring mutation 1 again under a new
    // name.
    (unsweptList.configEchoContract?.undeclared ?? []).some(
      (p) => p.endsWith(`.config.${KNOB}`)) &&
      // THE REMOVED HALF: no block at all, which is what "not swept" looked
      // like — indistinguishable, to a caller, from a daemon that had looked
      // and found nothing, and that indistinguishability IS the defect.
      unsweptStatusRead.configEchoContract === undefined &&
      // The field travelled to that response regardless. Nothing was protecting
      // anybody; the answer was simply not being given.
      unsweptStatusRead.config?.[KNOB] === KNOB_VALUE,
    `with the single-agent sweep removed ALONE, the fleet read still named the knob on all three\n` +
    `    categories while agent_status carried NO configEchoContract at all — and the undeclared\n` +
    `    field rode that response anyway. Those are the exact conditions §1 and §2 assert against\n` +
    `    (\`configEchoContract !== undefined\`, \`undeclared\` naming config.${KNOB}), so this build is\n` +
    `    the one that makes them fail. That is the state main was really in from KAN-166 (#29,\n` +
    `    2026-08-04) until KAN-168, with every proof in this suite green, which is why this file\n` +
    `    reads both surfaces rather than assuming one call site covers them. The whole-script red is\n` +
    `    pasted in KAN-168's PR: this section shows the cause, that run shows §1 and §2 going red`,
    `the single-surface red half did not go red: list.undeclared=` +
    `${JSON.stringify(unsweptList.configEchoContract?.undeclared)}, ` +
    `status.block=${JSON.stringify(unsweptStatusRead.configEchoContract)}, ` +
    `onWire=${JSON.stringify(unsweptStatusRead.config?.[KNOB])}`
  );

  unsweptMcp.kill();
  stopDaemon(unsweptStatus.pid);
}
// =========================== 4. ONE DECLARATION — one edit moves both surfaces --

rule('4. ONE DECLARATION — one edit to CONFIG_FIELDS, and BOTH surfaces move');

// THE CLAIM, EXACTLY. The build below differs from section 2's by ONE edit: the
// knob is added to `CONFIG_FIELDS`. Nothing on the poll path is touched — there
// is no second list of knobs to touch — and both surfaces change behaviour.
//
// STATED PRECISELY, because the easy version of this sentence is broader than
// what is under it: in SOURCE, adding a knob means editing `AgentConfig` in
// types.ts as well, because `CONFIG_FIELDS` is a mapped type total over it and
// a missing line does not compile. That is a compiler requirement, not a second
// declaration. What this section measures is that no THIRD edit is needed for
// the poll path to honour it, which is what "do not duplicate the field list"
// means in practice.
// Hoisted so this section can be SKIPPED WHOLE when an edit does not apply,
// without changing what anything after it can see. See scripts/mutation.mjs.
let sharedDist;
mutation3: {
  sharedDist = mutatedBuild('shared', [
    INJECT_KNOB,
    {
      file: 'events.js',
      find: 'export const CONFIG_FIELDS = {',
      replace:
        `export const CONFIG_FIELDS = {\n` +
        `    /* KAN-166 section 4: THE ONE EDIT — the knob, declared */\n` +
        `    ${KNOB}: SCALAR,`
    }
  ]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!sharedDist) break mutation3;
  const sharedCfg = makeConfig('shared');
  const sharedStatus = await startDaemon(sharedCfg, sharedDist, 'shared');
  const sharedMcp = new McpClient('shared', { dist: sharedDist, config: sharedCfg.configPath });
  await sharedMcp.initialize();
  await sleep(500);
  const sharedFleet = await buildFleet(sharedMcp, 'shared');
  await waitFor(
    () => sharedMcp.eventPayloads().some(
      (d) => d?.action === 'agent.configured' && d?.path === sharedFleet.running),
    15_000,
    'agent.configured on the MCP forwarder'
  );
  const sharedList = await listAgents(sharedMcp);
  const sharedEvent = sharedMcp.eventPayloads()
    .find((d) => d?.action === 'agent.configured' && d?.path === sharedFleet.running);
  const sharedRow = echoRows(sharedList).find(({ row }) => row.path === sharedFleet.running)?.row;

  console.log(`\n   the ONE edit: ${KNOB} added to CONFIG_FIELDS in events.js. Nothing else moved.\n`);
  show('EVENT path — the notification now PUBLISHES it:', sharedEvent?.config);
  show('POLL path — declared, so no longer reported:', sharedList.configEchoContract);
  console.log(`\n   MCP forwarder drift lines: ${driftLines(sharedMcp).join(' | ') || '(NONE)'}`);

  verdict(
    // The event path: published rather than dropped, and it stopped warning.
    sharedEvent?.config?.[KNOB] === KNOB_VALUE &&
      !driftLines(sharedMcp).some((l) => new RegExp(`config\\.${KNOB}`).test(l)) &&
      // The poll path: the knob is in `declared`, and `undeclared` is empty —
      // from the same edit, with nothing on this path touched.
      (sharedList.configEchoContract?.declared ?? []).includes(KNOB) &&
      sharedList.configEchoContract?.undeclared?.length === 0 &&
      // And it is still on the wire, so "no longer reported" is not "no longer
      // there" — the field is present and declared rather than absent.
      sharedRow?.config?.[KNOB] === KNOB_VALUE &&
      // The comparison that makes this a measurement: section 2's build carried
      // the SAME injected knob and both surfaces answered the other way.
      driftContract?.undeclared?.length > 0 &&
      configuredEvent?.config?.[KNOB] === undefined,
    `ONE edit — the knob added to CONFIG_FIELDS — and both surfaces moved together: the MCP\n` +
    `    event notification now publishes config.${KNOB} and stopped reporting drift, and the\n` +
    `    poll response lists it under \`declared\` with \`undeclared\` empty. Section 2's build\n` +
    `    carried the identical injected knob and answered the opposite way on BOTH, so the\n` +
    `    declaration is genuinely shared rather than two lists that happen to agree`,
    `shared declaration not proven: event=${JSON.stringify(sharedEvent?.config?.[KNOB])}, ` +
    `declared=${JSON.stringify(sharedList.configEchoContract?.declared)}, ` +
    `undeclared=${JSON.stringify(sharedList.configEchoContract?.undeclared)}, ` +
    `row=${JSON.stringify(sharedRow?.config?.[KNOB])}, ` +
    `mcpDrift=[${driftLines(sharedMcp).join(' | ')}]`
  );

  sharedMcp.kill();
  stopDaemon(sharedStatus.pid);

}
// ================= 5. THE RESIDUE — a category no type system can see is swept --

rule('5. THE RESIDUE — a category added straight into respond() is swept anyway');

// WHY THIS SECTION EXISTS. `FleetCategories` holds every DECLARED category to
// `ConfigEcho[]` at compile time, and its own comment says what that cannot
// cover: TypeScript has no exact-object type for the payload, so a category
// added straight into the `respond({…})` call compiles clean. That residue is
// the reason this sweep walks the RESPONSE rather than the six categories this
// method knows it built — and "walks the response" is a claim worth producing
// rather than asserting.
// Hoisted so this section can be SKIPPED WHOLE when an edit does not apply,
// without changing what anything after it can see. See scripts/mutation.mjs.
let rogueDist;
mutation4: {
  rogueDist = mutatedBuild('rogue', [{
    file: 'router.js',
    find: "const payload = {\n            action: 'list_agents_response',\n            success: true,",
    replace:
      "const payload = {\n            action: 'list_agents_response',\n            success: true,\n" +
      "            /* KAN-166 section 5: a category nobody declared, added straight to the payload */\n" +
      "            shadowAgents: [{ path: '/tmp/kan166-shadow', config: { priority: 1, " +
      "refusable: true, chargeable: true, preemptable: true, launcher: 'shell', " +
      `shadowKnob: '${KNOB_VALUE}' } }],`
  }]);
  // Already a counted failure. Skip the rest of this section rather
  // than asserting about a build that was never mutated.
  if (!rogueDist) break mutation4;
  const rogueCfg = makeConfig('rogue');
  const rogueStatus = await startDaemon(rogueCfg, rogueDist, 'rogue');
  const rogueMcp = new McpClient('rogue', { config: rogueCfg.configPath });
  await rogueMcp.initialize();
  await buildFleet(rogueMcp, 'rogue');
  const rogueList = await listAgents(rogueMcp);

  show('the undeclared category, on the response:', rogueList.shadowAgents);
  show('what the sweep found:', rogueList.configEchoContract?.undeclared);

  given(
    Array.isArray(rogueList.shadowAgents) && rogueList.shadowAgents.length === 1,
    'the rogue category really is on the response — a mutation that did not take ' +
      'would leave nothing to find',
  );

  verdict(
    (rogueList.configEchoContract?.undeclared ?? []).includes('shadowAgents[0].config.shadowKnob') &&
      // And the rest of the fleet is swept in the same pass, so this is the sweep
      // widening rather than a special case for one key.
      (rogueList.configEchoContract?.undeclared ?? []).length === 1,
    `a category added straight into respond() — which no type in this codebase can catch, and\n` +
    `    FleetCategories says so — was swept the moment it shipped: its undeclared knob came\n` +
    `    back as \`shadowAgents[0].config.shadowKnob\`, with the six real categories reporting\n` +
    `    nothing, because the sweep walks the payload that goes out rather than a list of names`,
    `the residue is not covered: undeclared=${JSON.stringify(rogueList.configEchoContract?.undeclared)}`
  );

  rogueMcp.kill();
  stopDaemon(rogueStatus.pid);

}

// ============ 6. THE SCAFFOLDING — this proof measures the echo, not the box --

rule('6. THE SCAFFOLDING — the fixture\'s activations are past the gate, shown red by backing it out');

// WHY THIS SECTION EXISTS (KAN-171). Everything above depends on a fleet that
// spans three categories, and the fleet is built by ACTIVATING agents — which
// goes through the capacity gate. On a loaded machine the gate refused, all
// three rows collapsed into `unstartedAgents`, and §1 and §2 went red about the
// load average. `PAST_THE_GATE` is the fix. A fix whose proof has only ever
// passed is evidence of nothing, so this section backs it out and watches it.
//
// AT CRABCAST_MAX_AGENTS=0, NOT UNDER LOAD, and that is the point rather than a
// convenience. `configuredCap` skips the derivation entirely — cap 0, headroom
// 0, `atCapacity` on any machine — so the red half below is red on a quiet
// GitHub runner exactly as it is on a busy laptop. A section that reproduced
// the defect by GENERATING load would be a second load-dependent check bolted
// on to fix the first, and it would be green on the runner for the same reason
// the original defect was.
//
// THE THREE FLEETS ARE ON ONE DAEMON, on purpose: the red and the green differ
// by the flag and by nothing else — same daemon, same cap, same census.
let gateDist;
mutation5: {
  const gateCfg = makeConfig('gate');
  const gateStatus = await startDaemon(gateCfg, distDir, 'gate', { CRABCAST_MAX_AGENTS: '0' });
  const gateMcp = new McpClient('gate', { config: gateCfg.configPath, env: { CRABCAST_MAX_AGENTS: '0' } });
  await gateMcp.initialize();

  const capacity = parsedText(await gateMcp.callTool('crabcast_capacity'));
  console.log(`\n   the daemon under this section: CRABCAST_MAX_AGENTS=0`);
  console.log(`     atCapacity=${capacity?.atCapacity} headroom=${capacity?.headroom} ` +
    `cap=${capacity?.cap} boundBy=${capacity?.headroomBoundBy}`);

  // --- RED: the defence backed out, on a daemon that will refuse ------------
  const ungatedFleet = await buildFleet(gateMcp, 'ungated', { gate: {}, expectRefusals: true });
  const ungatedList = await listAgents(gateMcp);
  const ungatedCategories = categoriesOf(ungatedList, ungatedFleet);

  const ungatedRows = echoRows(ungatedList)
    .filter(({ row }) => [ungatedFleet.running, ungatedFleet.standby, ungatedFleet.unstarted]
      .includes(row.path));
  console.log(`\n   WITHOUT the flag — categories the three rows reached: ` +
    `${[...ungatedCategories].join(', ') || '(none)'}`);
  // WHERE the rows are, not what the sweep said about them. This daemon is the
  // UNMUTATED build, so `undeclared` is `[]` here whatever happens — printing
  // it would be showing an empty list as though it were evidence, which is the
  // vacuous read §1's own comment warns about. The addresses are the evidence:
  // three rows, all present, all in the one category.
  show('…and the addresses those rows arrived at:', ungatedRows.map(({ at }) => at));

  // --- GREEN: the shipped default, same daemon, same cap -------------------
  const gatedFleet = await buildFleet(gateMcp, 'gated');
  const gatedList = await listAgents(gateMcp);
  const gatedCategories = categoriesOf(gatedList, gatedFleet);
  console.log(`\n   WITH the flag — categories the three rows reached: ` +
    `${[...gatedCategories].join(', ')}`);

  gateMcp.kill();
  stopDaemon(gateStatus.pid);

  // --- and the flag is honoured by the DAEMON, not merely accepted ---------
  //
  // The green half above proves the fleet built. It does NOT by itself prove
  // the flag is why: a daemon that ignored `override` and had room anyway would
  // look identical. This mutation removes the branch that honours it, leaving
  // everything else — including the flag on the wire — exactly as it is.
  gateDist = mutatedBuild('override-ignored', [{
    file: 'router.js',
    find: 'if (!override) {',
    replace: '/* KAN-171 section 6: the override branch backed out */ if (true) {'
  }]);
  if (!gateDist) break mutation5;
  const deafCfg = makeConfig('deaf');
  const deafStatus = await startDaemon(deafCfg, gateDist, 'deaf', { CRABCAST_MAX_AGENTS: '0' });
  const deafMcp = new McpClient('deaf', { config: deafCfg.configPath, env: { CRABCAST_MAX_AGENTS: '0' } });
  await deafMcp.initialize();

  const deafFleet = await buildFleet(deafMcp, 'deaf', { expectRefusals: true });
  const deafList = await listAgents(deafMcp);
  const deafCategories = categoriesOf(deafList, deafFleet);
  console.log(`\n   with the daemon's override branch removed, the SAME flag reached: ` +
    `${[...deafCategories].join(', ')}`);

  deafMcp.kill();
  stopDaemon(deafStatus.pid);

  given(
    capacity?.atCapacity === true && capacity?.headroom === 0,
    'the daemon really was at capacity — a daemon with room would let the red half through ' +
      'and this section would prove nothing',
    `atCapacity=${capacity?.atCapacity}, headroom=${capacity?.headroom}`
  );

  verdict(
    // RED: without the flag the fixture collapses to exactly the reported shape
    // — one category, and it is `unstartedAgents`.
    ungatedCategories.size === 1 && ungatedCategories.has('unstartedAgents') &&
      ungatedFleet.refused.length === 2 &&
      ungatedFleet.refused.every(({ why }) => /Refusing to activate/.test(why)) &&
      // …and all three rows ARE on the response, carrying echoes. The collapse
      // is rows in the wrong category, not rows that never arrived — which is
      // what made §1's precondition the thing that caught it and §2's
      // by-path assertion the thing that failed.
      ungatedRows.length === 3 && ungatedRows.every(({ row }) => row.config) &&
      // GREEN: the shipped default, on the same at-capacity daemon.
      gatedCategories.size === 3 && gatedFleet.refused.length === 0 &&
      // And the flag is honoured rather than merely tolerated: with the branch
      // that honours it removed, the identical call collapses again.
      deafCategories.size === 1 && deafCategories.has('unstartedAgents') &&
      deafFleet.refused.length === 2,
    `on one daemon pinned at CRABCAST_MAX_AGENTS=0 — at capacity on any machine, quiet runner\n` +
    `    included — the fixture WITHOUT \`override\` had both activations refused and all three\n` +
    `    rows collapsed into unstartedAgents, which is KAN-171's report reproduced from its\n` +
    `    cause rather than from a load average. The shipped default spanned all three categories\n` +
    `    on that same daemon. And with the daemon's override branch mutated away the same flag\n` +
    `    collapsed again, so the green half is the gate being overridden rather than a machine\n` +
    `    that happened to have room`,
    `the scaffolding defence is not proven: ungated=${JSON.stringify([...ungatedCategories])}, ` +
    `ungatedRefusals=${ungatedFleet.refused.length}, gated=${JSON.stringify([...gatedCategories])}, ` +
    `gatedRefusals=${gatedFleet.refused.length}, ` +
    `overrideIgnored=${JSON.stringify([...deafCategories])}`
  );

}

// ------------------------------------------------------------------ verdict --

// AT TOP LEVEL, and it did not used to be. The verdict and the exit lived
// INSIDE section 5's `mutation4:` block, so the one thing that block is built
// to do — `break` out when its edit does not apply — skipped the verdict line
// and the exit status with it: a run with failures already counted would print
// no total and exit 0. Found while adding section 6 below it (KAN-171).
const skipped = mutationsSkipped();
console.log(`\n${'='.repeat(78)}`);
if (skipped.length) {
  // Named separately from the count, because "3 FAILED" reads as three
  // assertions disagreeing when what happened is that three sections never ran.
  console.log(`mutations that did not apply, so their sections were SKIPPED: ${skipped.join(', ')}`);
}
if (failures > 0) {
  console.log(`${failures} CHECK(S) FAILED`);
} else {
  console.log('all sections passed');
}
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
