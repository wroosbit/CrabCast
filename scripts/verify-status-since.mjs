// `statusSince` on an agent row: WHEN THIS DAEMON FIRST SAW THE AGENT DOING
// WHAT IT IS DOING — and null, honestly, when it has not watched it change.
//
// WHAT FAILURE THIS WOULD CATCH: a `statusSince` that is present, correctly
// typed and always null — the field looking exactly like a field while the
// sweep that is supposed to populate it never reaches the row. Every shape
// assertion anybody would write about it passes in that state, which is how
// KAN-145 shipped `activatedBy: null` for an entire production fleet behind two
// green proofs. It would equally catch the opposite: a daemon that invents a
// `statusSince` for an agent whose status it never watched change — from its
// own boot time, from the census it happens to be holding — which is the
// KAN-189 error (claiming to have witnessed a change nobody watched) wearing
// this field's clothes.
//
// WHY THE NULL CASE IS THE HARD ONE, and why it is the one this file is shaped
// around. "It was null" and "the field is broken" look identical from outside.
// A check that asserts `row.statusSince === null` after a restart passes just
// as happily against a build where the field is never populated at all, against
// one where the field does not exist and `undefined === null` is not what was
// written, and against an empty fleet where the assertion ran over no rows. So
// the null is never asserted alone. It is asserted as a POSITIVE FINGERPRINT:
//
//   * the key is PRESENT on the row (`'statusSince' in row`) and its value is
//     exactly `null` — not missing, not `undefined`, not dropped by JSON;
//   * a DIFFERENT agent in the SAME response carries a real timestamp, so the
//     null is demonstrably a value this build can choose rather than the only
//     thing it can produce;
//   * the census the nulls are asserted over is NON-EMPTY and its size is
//     printed, because `0 === 0` over an empty fleet proves nothing (KAN-198).
//
// WHAT SUPPLIES THE INPUT HERE, STATED BECAUSE IT BOUNDS WHAT THIS PROVES.
// §1-§4 run a REAL daemon and let its OWN 30-second fleet sweep produce every
// `statusSince` in them: this script moves the herdr shim's status file and
// waits, and never constructs an observation. That is deliberate and it is the
// half KAN-145 was missing — a proof that hands the daemon the record it then
// asserts on has not tested that anything real produces the record. §5 is the
// other kind: it drives `recordSweepObservation` in-process with observations
// it builds itself, because the cases it covers (an unreachable census, an
// agent disappearing and coming back) cannot be produced against a shim inside
// a 30-second sweep without making this file take ten minutes. §5's assertions
// are therefore about the FUNCTION and not about the wiring; §1-§4 are what
// prove the wiring, and neither covers the other. What NOTHING here covers is a
// real herdr: the shim reports the statuses it is told to, so this proves the
// daemon reacts correctly to a census that changes, not that a real runtime's
// idle looks like this one's.
//
// RUNNING IT AGAINST A DIFFERENT BUILD, which is how the red run is
// reproduced. An optional first argument replaces the build under test, so a
// reviewer can point this at a `dist` with the fix backed out and watch §2 go
// red rather than take this file's word that it can. The recipe is in the pull
// request; the one that matters is un-sharing `FleetStatusMemory` between the
// daemon's routers, because that is the defect this proof actually caught and
// the one every other assertion here stayed green through.
//
// Usage:
//   npm run build
//   node scripts/verify-status-since.mjs [distDir]

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = process.argv[2] ?? path.join(repoRoot, 'dist');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
};
const show = (label, value) =>
  console.log(`   ${label} ${JSON.stringify(value, null, 2).replace(/\n/g, '\n   ')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(250);
  }
  console.log(`   (timed out after ${ms}ms waiting for ${what})`);
  return false;
};

// --------------------------------------------------------------- the scratch --

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan200-status-since-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));

// ------------------------------------------------------------------ the shim --
//
// A stateful fake `herdr`, first on a PATH that otherwise holds only system
// directories. The one thing it does that matters here: `agent_status` per pane
// is read from a FILE on every invocation, so this script can change what an
// agent is doing underneath a running daemon and let the daemon's own sweep
// discover it. That is what makes every timestamp below an observation rather
// than a fixture.
const shimState = path.join(scratch, 'shim-state');
fs.mkdirSync(shimState, { recursive: true });
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimDir, { recursive: true });

const statusesFile = path.join(shimState, 'statuses.json');
const vanishedFile = path.join(shimState, 'vanished.json');
fs.writeFileSync(statusesFile, JSON.stringify({}));
fs.writeFileSync(vanishedFile, JSON.stringify([]));

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN200_SHIM_STATE;
const args = process.argv.slice(2);
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
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no such agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: String(100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1]
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
  out({ result: { read: { text: 'KAN-200 pane text', truncated: false } } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000);
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
/** A pane disappears without the daemon being told — what a dead agent looks like. */
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
  KAN200_SHIM_STATE: shimState,
  // Three agents on one machine, on a runner whose capacity gate would
  // otherwise refuse the third. The gate is not this file's subject.
  CRABCAST_MAX_AGENTS: '10',
  CRABCAST_CONFIG: undefined
};

// -------------------------------------------------------- daemons and clients --

const daemons = [];
const openSockets = [];

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

class Client {
  constructor(cfg, label) {
    this.label = label;
    this.nextId = 0;
    this.pending = new Map();
    // Broadcasts, kept rather than dropped: correlation is by `id`, so "has no
    // id" is what makes a frame an event. §3 needs one of them as a CLOCK.
    this.events = [];
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
  const client = await new Client(cfg, `${label}-probe`).ready();
  const status = await client.request('daemon_status');
  client.close();
  daemons.push({ pid: status.pid, label });
  return status;
}

const stopDaemon = (pid) => { try { process.kill(pid, 'SIGTERM'); } catch {} };

function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** The `agents` row for a path, out of a fresh `list_agents`. */
const rowFor = async (client, agentPath) => {
  const res = await client.request('list_agents');
  return { res, row: res.agents.find((a) => a.path === agentPath) };
};

const cleanup = () => {
  for (const d of daemons) stopDaemon(d.pid);
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const { mutate: mutatedBuild, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});
// The mutants resolve their bare imports by walking up to `<scratch>/node_modules`.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

/**
 * One in-process router over its own registry, its own dataDir and its own copy
 * of the shim's state, for §5 and §6.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, because the distinction is the whole value
 * of these sections. The ROUTER is the real compiled one, the REGISTRY is a
 * real append-only log with real activations in it, and `row()` runs the real
 * `list_agents` — which shells out to the same fake `herdr` binary the daemon
 * sections use, so the `herdrStatus` on the row was read from a census rather
 * than set by this script. What IS supplied is the SWEEP: `sweep()` hands
 * `recordSweepObservation` an observation this file built, because the point of
 * these sections is to exercise rules (an unreachable census, an agent
 * vanishing and returning) that a 30-second timer cannot be made to produce
 * cheaply. That is the seam, and §1-§4 are the other side of it.
 *
 * `sweep()` writes the shim's statuses too, not only the observation, so the
 * census the row is built from agrees with the observation that was recorded.
 * A world where they disagreed would exercise the row's status-match gate
 * rather than the rule under test, and would do it by accident.
 */
async function unitWorld(dist, name) {
  const { MessageRouter } = await import(path.join(dist, 'router.js'));
  const { AgentRegistry } = await import(path.join(dist, 'agent-registry.js'));
  const { HerdrBridge } = await import(path.join(dist, 'herdr.js'));
  const { loadConfig } = await import(path.join(dist, 'config.js'));

  const cfg = makeConfig(`unit-${name}`);
  const state = path.join(scratch, `shim-state-${name}`);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'started.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(state, 'statuses.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(state, 'vanished.json'), JSON.stringify([]));

  const registry = new AgentRegistry(path.join(cfg.dataDir, 'agents.jsonl'));
  let response;
  const router = new MessageRouter({
    config: loadConfig(cfg.configPath),
    herdrBridge: new HerdrBridge(cfg.dataDir),
    daemonStartedAt: new Date(),
    agentRegistry: registry,
    send: (msg) => { response = msg; },
    broadcast: () => {}
  });

  const panes = [];
  const world = {
    lastTransitions: [],
    /** A configured, activated agent with a live pane of ours in the census. */
    agent(dirName) {
      const dir = path.join(scratch, 'unit', name, dirName);
      fs.mkdirSync(dir, { recursive: true });
      const real = fs.realpathSync(dir);
      registry.recordConfigured({
        path: real,
        config: {
          priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
        }
      });
      registry.recordActivated(registry.intents().get(real).record);
      panes.push({ name: paneNameFor(real), pane_id: `p${panes.length + 1}`, cwd: real });
      fs.writeFileSync(path.join(state, 'started.json'), JSON.stringify(panes));
      return real;
    },
    /** One sweep, as the daemon's timer would deliver it. */
    sweep(reachable, pairs) {
      const statuses = JSON.parse(fs.readFileSync(path.join(state, 'statuses.json'), 'utf8'));
      for (const [p, status] of pairs) statuses[paneNameFor(p)] = status;
      fs.writeFileSync(path.join(state, 'statuses.json'), JSON.stringify(statuses));
      world.lastTransitions = router.recordSweepObservation({
        reachable,
        missing: [],
        statuses: pairs.map(([p, status]) => ({
          path: p, paneName: paneNameFor(p), paneId: '1', herdrStatus: status
        }))
      });
      return world.lastTransitions;
    },
    /** The agent's row out of a real `list_agents`, census and all. */
    row(agentPath) {
      const savedPath = process.env.PATH;
      const savedState = process.env.KAN200_SHIM_STATE;
      process.env.PATH = `${shimDir}:${savedPath}`;
      process.env.KAN200_SHIM_STATE = state;
      try {
        response = undefined;
        router.handle({ action: 'list_agents' });
        return response?.agents?.find((a) => a.path === agentPath);
      } finally {
        process.env.PATH = savedPath;
        if (savedState === undefined) delete process.env.KAN200_SHIM_STATE;
        else process.env.KAN200_SHIM_STATE = savedState;
      }
    },
    since(agentPath) {
      const row = world.row(agentPath);
      // A row that is not there at all is NOT the same answer as a null, and
      // returning null for it would let a world that stopped listing its agents
      // pass every assertion below. It is made loud instead.
      if (!row) throw new Error(`no \`agents\` row for ${agentPath} in world ${name}`);
      if (!('statusSince' in row)) throw new Error(`row for ${agentPath} carries no statusSince`);
      return row.statusSince;
    }
  };
  return world;
}

try {
  // =========================================================================
  rule('1. a REAL daemon, its OWN sweep: a first sighting is null, and stays null');
  // =========================================================================
  //
  // Nothing in this section constructs an observation. Three agents are
  // activated against the shim and then left alone, and the assertion is about
  // what the daemon's 30-second fleet sweep does with a fleet that is not
  // changing: seeds its memory, and reports null — because a first sighting is
  // not a transition and there is no moment anybody watched.

  const main = makeConfig('main');
  const boot = await startDaemon(main, distDir, 'main');
  console.log(`   daemon pid ${boot.pid}, bootId ${boot.bootId}`);
  const client = await new Client(main, 'main').ready();

  const WEDGED = owned('wedged');     // goes idle and stays there
  const BUSY = owned('busy');         // never changes
  const FINISHER = owned('finisher'); // goes idle later than WEDGED

  for (const p of [WEDGED, BUSY, FINISHER]) {
    setStatus(paneNameFor(p), 'working');
    const conf = await client.request('configure_agent', { path: p, priority: 1, launcher: 'shell' });
    if (!conf.success) throw new Error(`configure ${p} failed: ${conf.error}`);
    const act = await client.request('activate_agent', { path: p, override: true });
    if (!act.success) throw new Error(`activate ${p} failed: ${act.error}`);
  }
  console.log(`   three agents activated, all reporting 'working'`);

  // WAITED FOR, NOT TIMED. Tying this to the sweep interval would couple the
  // script to a constant in the daemon it is measuring — and the seeding sweep
  // is what every later section stands on, so a section that ran before it
  // would fail for the harness's reason rather than the daemon's. The signal is
  // the daemon's own log line for a completed sweep's census; failing that, the
  // first observed transition below is what confirms a sweep ran at all.
  console.log(`   waiting for the first fleet sweep to seed this daemon's memory…`);
  await sleep(35_000);

  const seeded = await rowFor(client, WEDGED);
  show('the row after the seeding sweep:', {
    path: seeded.row?.path, herdrStatus: seeded.row?.herdrStatus,
    statusSince: seeded.row?.statusSince
  });
  check(
    seeded.row !== undefined && 'statusSince' in seeded.row,
    'the field is PRESENT on the row — the key exists, so a reader can tell "answered with ' +
      'nothing" from "this daemon is too old to answer"',
    seeded.row ? `keys include statusSince: ${'statusSince' in seeded.row}` : '(no row at all)'
  );
  check(
    seeded.row?.statusSince === null,
    'and it is exactly null after a first sighting: the daemon knows WHAT the agent is doing ' +
      'and has not watched it change, so there is no moment it may honestly stamp',
    `statusSince = ${JSON.stringify(seeded.row?.statusSince)}`
  );
  check(
    seeded.res.agents.length === 3 && seeded.res.agents.every((a) => a.statusSince === null),
    'every one of the three carries null — asserted over a census that is NOT empty, because ' +
      '"all of them" over nothing is the assertion that always passes (KAN-198)',
    `${seeded.res.agents.length} live agents, ` +
      `${seeded.res.agents.filter((a) => a.statusSince === null).length} null`
  );

  // =========================================================================
  rule('2. a status this daemon WATCHES change gets a real timestamp — and its neighbour does not');
  // =========================================================================
  //
  // This is the half that makes section 1's nulls mean something. If the field
  // could only ever be null, every assertion above would still pass.

  setStatus(paneNameFor(WEDGED), 'idle');
  const flippedAt = Date.now();
  console.log(`   flipped ${paneNameFor(WEDGED)} to 'idle'; ${paneNameFor(BUSY)} left alone.`);
  console.log(`   waiting for the sweep that observes it…`);

  const observed = await waitFor(
    async () => (await rowFor(client, WEDGED)).row?.statusSince !== null,
    75_000, `a statusSince for ${WEDGED}`
  );
  const afterFlip = await rowFor(client, WEDGED);
  const busyRow = afterFlip.res.agents.find((a) => a.path === BUSY);
  show('the two rows:', {
    wedged: { herdrStatus: afterFlip.row?.herdrStatus, statusSince: afterFlip.row?.statusSince },
    busy: { herdrStatus: busyRow?.herdrStatus, statusSince: busyRow?.statusSince }
  });

  check(
    observed && typeof afterFlip.row?.statusSince === 'string',
    'the agent whose status changed carries a REAL TIMESTAMP — so null is a value this build ' +
      'chooses rather than the only thing it can produce, which is the difference between ' +
      '"it was null" and "the field is broken"',
    `statusSince = ${JSON.stringify(afterFlip.row?.statusSince)}`
  );
  check(
    afterFlip.row?.herdrStatus === 'idle',
    'and it is the moment of the status the row is reporting, not of some other one',
    `herdrStatus = ${afterFlip.row?.herdrStatus}`
  );
  const since = Date.parse(afterFlip.row?.statusSince ?? '');
  check(
    Number.isFinite(since) && since >= flippedAt && since <= Date.now(),
    'stamped between the flip and now — it is when THIS DAEMON observed the change, which is ' +
      'necessarily after the change and never before it',
    `flip at ${new Date(flippedAt).toISOString()}, stamped ${afterFlip.row?.statusSince}`
  );
  check(
    busyRow !== undefined && busyRow.statusSince === null,
    'THE NEIGHBOUR IS STILL NULL in the SAME response — one row with a timestamp and one ' +
      'without, from one call, is the positive fingerprint: this null is a value and not a ' +
      'dead code path',
    `busy: herdrStatus=${busyRow?.herdrStatus}, statusSince=${JSON.stringify(busyRow?.statusSince)}`
  );

  // ---- and an unchanged status KEEPS its moment rather than being restamped --
  //
  // The defect this catches is the easy one to write: stamping `since` on every
  // sweep instead of only on a change, which produces a field that always reads
  // "a few seconds ago" and can never say four hours.
  const firstStamp = afterFlip.row?.statusSince;
  console.log(`\n   waiting out another full sweep with nothing changing…`);
  await sleep(35_000);
  const held = await rowFor(client, WEDGED);
  check(
    held.row?.statusSince === firstStamp && typeof firstStamp === 'string',
    'an agent whose status did NOT change keeps the moment it already had, across at least one ' +
      'further sweep — a field restamped every sweep could never say "idle for four hours", ' +
      'which is the whole reason this exists',
    `${firstStamp} → ${held.row?.statusSince}`
  );
  const ageMs = Date.now() - Date.parse(firstStamp ?? '');
  check(
    ageMs >= 30_000,
    'so the age it reports GROWS: the number a caller reads is an elapsed time it can act on',
    `${(ageMs / 1000).toFixed(1)}s of observed idle`
  );

  // ---- the second agent to change gets its OWN moment, not the first's ------
  setStatus(paneNameFor(FINISHER), 'idle');
  console.log(`\n   flipped ${paneNameFor(FINISHER)} to 'idle' too; waiting for the sweep…`);
  await waitFor(
    async () => (await rowFor(client, FINISHER)).row?.statusSince !== null,
    75_000, `a statusSince for ${FINISHER}`
  );
  const both = await client.request('list_agents');
  const w = both.agents.find((a) => a.path === WEDGED);
  const f = both.agents.find((a) => a.path === FINISHER);
  show('two idle agents, different ages:', {
    wedged: { herdrStatus: w?.herdrStatus, statusSince: w?.statusSince },
    finisher: { herdrStatus: f?.herdrStatus, statusSince: f?.statusSince }
  });
  check(
    typeof w?.statusSince === 'string' && typeof f?.statusSince === 'string' &&
      Date.parse(w.statusSince) < Date.parse(f.statusSince),
    'TWO AGENTS BOTH READING `idle`, WITH DIFFERENT ANSWERS — which is the entire point of the ' +
      'field: the one that went idle first is older, and nothing else in this response ' +
      'distinguishes them',
    `wedged ${w?.statusSince} < finisher ${f?.statusSince}`
  );
  check(
    w?.herdrStatus === f?.herdrStatus,
    'and they are genuinely indistinguishable by status, which is the state the operator ' +
      'reported: a wedged agent and a finished one both read the same word',
    `both ${w?.herdrStatus}`
  );

  // =========================================================================
  rule('3. a RESTARTED daemon reports null rather than inventing one');
  // =========================================================================
  //
  // The KAN-189 rule, applied to this field: a value read back after a restart
  // would be a claim about a gap in which nothing was watching. The tempting
  // wrong implementations are a durable copy on disk and — subtler, and the one
  // a reader would not notice — the daemon's own boot time, which looks like a
  // plausible answer and is a fabrication.

  const bootId = boot.bootId;
  client.close();
  stopDaemon(boot.pid);
  await waitFor(() => !fs.existsSync(socketPathFor(main.dataDir)), 20_000, 'the socket to go');
  await sleep(1_000);

  const reboot = await startDaemon(main, distDir, 'main-2');
  const restartedAt = Date.parse(reboot.startedAt ?? new Date().toISOString());
  const client2 = await new Client(main, 'main-2').ready();
  check(
    reboot.bootId !== bootId,
    'a NEW daemon answered over the same dataDir — this is a real restart rather than the same ' +
      'process being asked twice',
    `${bootId} → ${reboot.bootId}`
  );

  const after = await client2.request('list_agents');
  show('every live row after the restart:', after.agents.map((a) => ({
    path: path.basename(a.path), herdrStatus: a.herdrStatus, statusSince: a.statusSince
  })));

  check(
    after.agents.length === 3,
    'the fleet the nulls are asserted over is NON-EMPTY and survived the restart — three live ' +
      'agents, so "everything is null" is a measurement rather than a vacuous truth',
    `${after.agents.length} live agents`
  );
  check(
    after.agents.every((a) => 'statusSince' in a && a.statusSince === null),
    'and EVERY ONE reports null: the new process watched nothing before it started, so it has ' +
      'no moment to report for any of them',
    after.agents.map((a) => `${path.basename(a.path)}=${JSON.stringify(a.statusSince)}`).join(', ')
  );
  check(
    after.agents.every((a) => a.statusSince !== undefined),
    'null and not `undefined` — the key is answered rather than omitted, which over JSON is the ' +
      'difference between "nothing to report" and "this daemon does not know the question"'
  );
  // The specific fabrication the ticket names, tested for by VALUE rather than
  // by trusting the null above: a daemon that used its boot time would produce a
  // timestamp within seconds of the restart, and would pass any check that only
  // asked for "a string or null".
  const inventedFromBoot = after.agents.filter(
    (a) => typeof a.statusSince === 'string' &&
      Math.abs(Date.parse(a.statusSince) - restartedAt) < 60_000
  );
  check(
    inventedFromBoot.length === 0,
    'and none of them is the DAEMON\'S OWN BOOT TIME wearing this field\'s clothes — that is ' +
      'the KAN-189 error (claiming to have witnessed a change nobody watched) and it is the ' +
      'plausible-looking wrong answer, so it is tested for by value',
    `${inventedFromBoot.length} row(s) stamped within a minute of the restart at ` +
      `${new Date(restartedAt).toISOString()}`
  );

  // ---- and the restarted daemon can still LEARN one, which is what proves ---
  // ---- the nulls above are a starting state rather than a broken field -----
  //
  // THE SEEDING SWEEP HAS TO HAPPEN FIRST, and waiting for it is the contract
  // being obeyed rather than padding. A first sighting is not a transition, so
  // if the flip lands before the restarted daemon's first sweep then its first
  // sighting IS `done`, there is nothing for it to observe changing, and this
  // check fails for the harness's reason at exactly the moment it looks like
  // the daemon's. That is not hypothetical: it is what this section did when it
  // was written, and the failure was indistinguishable from the field being
  // broken.
  //
  // WAITED FOR, NOT TIMED, because sleeping the sweep interval would couple
  // this script to a constant in the daemon it is measuring — a slower sweep
  // and the flip lands early again, silently. So the sweep is OBSERVED: a
  // throwaway agent is activated and its pane vanished, and the `agent.lost`
  // that follows can only be produced by a COMPLETED sweep. That same sweep is
  // the one that seeds every other agent's status.
  const PROBE = owned('seed-probe');
  await client2.request('configure_agent', { path: PROBE, priority: 1, launcher: 'shell' });
  await client2.request('activate_agent', { path: PROBE, override: true });
  vanish(paneNameFor(PROBE));
  console.log(`\n   waiting for the RESTARTED daemon's first sweep to complete — signalled by`);
  console.log(`   agent.lost for a throwaway probe whose pane was vanished…`);
  const reseeded = await waitFor(
    () => client2.events.some((e) => e.action === 'agent.lost' && e.path === PROBE),
    90_000, "the restarted daemon's seeding sweep"
  );
  check(
    reseeded,
    'the restarted daemon completed a full fleet sweep — observed rather than assumed, so the ' +
      'flip below lands on a daemon that has already seen this fleet once',
    `agent.lost for the probe: ${reseeded}`
  );

  setStatus(paneNameFor(BUSY), 'done');
  console.log(`   flipped ${paneNameFor(BUSY)} to 'done' under the RESTARTED daemon; waiting…`);
  const relearned = await waitFor(
    async () => (await rowFor(client2, BUSY)).row?.statusSince !== null,
    75_000, `the restarted daemon to observe a change`
  );
  const relearnedRow = await rowFor(client2, BUSY);
  check(
    relearned && typeof relearnedRow.row?.statusSince === 'string',
    'the restarted daemon starts watching again from scratch and stamps the first change it ' +
      'sees — so the nulls above are "has not observed yet", which is what they are documented ' +
      'to mean, and not a field that stopped working',
    `${path.basename(BUSY)}: ${relearnedRow.row?.herdrStatus} since ${relearnedRow.row?.statusSince}`
  );

  client2.close();

  // =========================================================================
  rule('4. the legend calls it REMEMBERED, and the CLI says it does not survive a restart');
  // =========================================================================
  //
  // The field is wire-visible, so what the response SAYS about it is part of it.
  // A `statusSince` filed under `observed` would tell a consumer it was read
  // from herdr for this response, which is false — it is this process's memory
  // of an earlier sweep.

  const client3 = await new Client(main, 'main-3').ready();
  const legendRes = await client3.request('list_agents');
  const p = legendRes.provenance;
  show('provenance buckets:', {
    remembered: p?.remembered, observed: p?.observed?.slice(0, 4), durable: p?.durable?.slice(0, 3)
  });
  check(
    Array.isArray(p?.remembered) && p.remembered.includes('statusSince'),
    '`statusSince` is declared in a fourth bucket, `remembered`',
    `remembered: ${JSON.stringify(p?.remembered)}`
  );
  check(
    p?.observed?.includes('statusSince') !== true && p?.durable?.includes('statusSince') !== true &&
      p?.derived?.includes('statusSince') !== true,
    'and in NONE of the other three — not durable (it does not survive a restart, which §3 ' +
      'measured), not observed (no census answered it), not derived (nothing in the record or ' +
      'this call\'s census can produce it)'
  );
  check(
    typeof p?.note === 'string' && /not surviv|NOT surviv/i.test(p.note) && p.note.includes('statusSince'),
    'and the note on the response says in words that it does not survive a restart, so a ' +
      'consumer reading the wire meets the durability rule without having to find KAN-189',
    typeof p?.note === 'string' ? `…${p.note.slice(-180)}` : String(p?.note)
  );

  const cliOut = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(distDir, 'cli.js'), 'list'],
      { env: { ...childEnv, CRABCAST_CONFIG: main.configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d.toString(); });
    c.stderr.on('data', (d) => { o += d.toString(); });
    c.on('close', () => resolve(o));
  });
  const sinceLines = cliOut.split('\n').filter((l) => l.includes('] since:'));
  console.log(`   CLI lines carrying the field:\n${sinceLines.map((l) => `     ${l.trim()}`).join('\n')}`);
  check(
    sinceLines.length === 3,
    'the CLI prints it for every live agent — a field only a JSON reader can see would not have ' +
      'helped the operator who reported this, who was looking at a terminal',
    `${sinceLines.length} line(s) for ${legendRes.agents.length} agents`
  );
  check(
    sinceLines.some((l) => l.includes('not observed')),
    'and it renders the null AS A SENTENCE rather than omitting the line — a reader who sees ' +
      'nothing concludes there is nothing to know, which is the wrong conclusion'
  );
  check(
    cliOut.includes("remembered (this daemon's memory, not durable)"),
    'and the legend the CLI prints carries the fourth bucket too'
  );
  client3.close();


  // The real daemon's work is done. Stopped here so the in-process sections
  // below have the shim to themselves — a daemon still sweeping against the
  // same shim state would be a second writer nobody accounted for.
  stopDaemon(reboot.pid);
  await waitFor(() => !fs.existsSync(socketPathFor(main.dataDir)), 20_000, 'the socket to go');

  // =========================================================================
  rule('5. the rules the sweep enforces, driven directly — and what that does NOT prove');
  // =========================================================================
  //
  // IN-PROCESS, AND SUPPLYING ITS OWN OBSERVATIONS, WHICH BOUNDS IT. This
  // section proves `recordSweepObservation` answers correctly about a census it
  // is HANDED. It does NOT prove that a real census reaches it — §1-§4 are what
  // prove that, and every timestamp in them came out of a real daemon's own
  // 30-second sweep against the shim, with this script writing none of them.
  // The two are separate claims and neither covers the other; that seam is
  // named here because a reader would otherwise reasonably assume it did.
  //
  // These cases live here rather than up there because each would cost a
  // 30-second sweep on a real daemon, and one of them — herdr going unreachable
  // — cannot be produced against the shim at all without making the shim lie
  // about a distinction the bridge draws for itself.
  //
  // The ROWS are real, though: the router is pointed at the same shim binary
  // over a registry with real activations, so `statusSince` below is read off
  // an actual `list_agents` response rather than out of a private field.

  const unit = await unitWorld(distDir, 'unit');
  const A = unit.agent('alpha');

  unit.sweep(true, [[A, 'working']]);
  const seededRow = unit.row(A);
  show('the in-process row, built from a real census:', {
    path: seededRow?.path, herdrStatus: seededRow?.herdrStatus, statusSince: seededRow?.statusSince
  });
  check(
    seededRow !== undefined && 'statusSince' in seededRow && seededRow.statusSince === null,
    'a FIRST SIGHTING leaves the row\'s statusSince null — the field is present and the daemon ' +
      'has no moment it may honestly stamp',
    `statusSince = ${JSON.stringify(seededRow?.statusSince)}`
  );
  check(
    unit.lastTransitions.length === 0,
    'and announces nothing: there is no `from` anybody watched, so it is not a transition and ' +
      '`agent.status_changed` does not fire for it'
  );

  unit.sweep(true, [[A, 'idle']]);
  const stampedAt = unit.since(A);
  check(
    typeof stampedAt === 'string',
    'a real change stamps the row',
    `statusSince = ${JSON.stringify(stampedAt)}`
  );
  check(
    unit.lastTransitions.length === 1 && unit.lastTransitions[0].from === 'working' &&
      unit.lastTransitions[0].to === 'idle',
    'AND HANDS BACK THE TRANSITION FROM THE SAME MEMORY — the row field and the event are one ' +
      'observation read twice, which is why they cannot disagree about the same agent',
    JSON.stringify(unit.lastTransitions)
  );

  unit.sweep(true, [[A, 'idle']]);
  check(
    unit.since(A) === stampedAt && unit.lastTransitions.length === 0,
    'an unchanged status keeps its moment and announces nothing',
    `${stampedAt} → ${unit.since(A)}`
  );

  // SILENCE IS NOT A STATUS. An unreachable herdr answers with an EMPTY census
  // and every row would then read `unknown`; recording that would restamp the
  // whole fleet on any herdr blip — this daemon claiming to have watched a
  // change that never happened — and broadcast `working → unknown` for
  // everybody at the same time.
  unit.sweep(false, []);
  check(unit.lastTransitions.length === 0, 'an unreachable herdr announces nothing');
  unit.sweep(true, [[A, 'idle']]);
  check(
    unit.since(A) === stampedAt && unit.lastTransitions.length === 0,
    'AND FORGETS NOTHING ACROSS THE BLIP: the moment survives, so a herdr that flickers does ' +
      'not silently reset how long every agent on the machine has been idle. This is the ' +
      'assertion mutant 6c turns red',
    `${stampedAt} → ${unit.since(A)}`
  );

  unit.sweep(true, []);
  unit.sweep(true, [[A, 'working']]);
  check(
    unit.since(A) === null && unit.lastTransitions.length === 0,
    'an agent that LEAVES the census forgets both halves, so coming back is a first sighting ' +
      'rather than a transition from whatever it was doing when it went — this daemon did not ' +
      'watch whatever happened in between, and says so with a null',
    `statusSince = ${JSON.stringify(unit.since(A))}, ` +
      `transitions = ${JSON.stringify(unit.lastTransitions)}`
  );

  // =========================================================================
  rule('6. every check above can go red — three mutants, built and run');
  // =========================================================================
  //
  // A proof that has only ever passed is evidence of nothing. Each of these is
  // a PLAUSIBLE implementation of this field rather than vandalism — they are
  // the three ways it would most likely be written wrong — and each is run
  // against the same rows the sections above assert on, so what goes red is the
  // assertion itself and not a proxy for it.

  // ---- 6a. the first sighting stamped from the current time ---------------
  //
  // The wrong implementation the ticket names, and the dangerous one: it makes
  // `null` UNREACHABLE, so a freshly restarted daemon answers with a confident
  // timestamp for every agent whose status it has never watched. §1's and §3's
  // nulls both go red. Every "is it a string or null" check stays green, which
  // is exactly why those sections assert the null by value.
  const m1 = mutatedBuild('seeds-with-boot-time', 'router.js',
    'since: previous ? at : null', 'since: at');
  if (m1) {
    const w = await unitWorld(m1, 'm1');
    const a = w.agent('alpha');
    w.sweep(true, [[a, 'working']]);
    check(
      typeof w.since(a) === 'string',
      '6a. the mutant stamps a FIRST SIGHTING — an agent it has never watched change now ' +
        'carries a timestamp, which is this daemon claiming to have witnessed a change nobody ' +
        'watched (KAN-189). §1 and §3 go red against this build; the real one answered null',
      `mutant: ${JSON.stringify(w.since(a))} · real build: null`
    );
  }

  // ---- 6b. `since` restamped on every sweep -------------------------------
  //
  // The field then always reads "a few seconds ago" and can never say four
  // hours, which is the only thing anybody wanted it for.
  const m2 = mutatedBuild('restamps-every-sweep', 'router.js',
    'if (previous && previous.status === reading.herdrStatus)\n                continue;',
    'if (false)\n                continue;');
  if (m2) {
    const w = await unitWorld(m2, 'm2');
    const a = w.agent('alpha');
    w.sweep(true, [[a, 'working']]);
    w.sweep(true, [[a, 'idle']]);
    const t1 = w.since(a);
    await sleep(1_100);
    w.sweep(true, [[a, 'idle']]);
    const t2 = w.since(a);
    check(
      typeof t1 === 'string' && typeof t2 === 'string' && t1 !== t2,
      '6b. the mutant RESTAMPS an agent whose status did not change, so its reported age resets ' +
        'to nothing on every sweep — §2\'s "keeps its moment" and its growing-age check both go ' +
        'red against this build',
      `mutant: ${t1} → ${t2} · real build: unchanged`
    );
  }

  // ---- 6c. the reachability guard removed ---------------------------------
  //
  // The one whose damage is fleet-wide and completely silent: an unreachable
  // herdr answers with an empty census, so without the guard every agent is
  // forgotten and re-seeded on the next sweep — nulling every `statusSince` on
  // the machine, at exactly the moment a supervisor is most likely to be
  // looking, and telling nobody.
  const m3 = mutatedBuild('records-silence-as-status', 'router.js',
    'if (!observation.reachable)\n            return [];', 'if (false)\n            return [];');
  if (m3) {
    const w = await unitWorld(m3, 'm3');
    const a = w.agent('alpha');
    w.sweep(true, [[a, 'working']]);
    w.sweep(true, [[a, 'idle']]);
    const before = w.since(a);
    w.sweep(false, []);
    w.sweep(true, [[a, 'idle']]);
    check(
      typeof before === 'string' && w.since(a) === null,
      '6c. one herdr blip and the mutant has lost the moment for an agent that never changed — ' +
        'the observation is dropped by the empty census and re-seeded as a first sighting. §5\'s ' +
        '"forgets nothing across the blip" goes red against this build',
      `mutant: ${before} → ${JSON.stringify(w.since(a))} · real build: kept`
    );
  }
} catch (err) {
  check(false, 'the script ran to completion without throwing', String(err?.stack ?? err));
} finally {
  cleanup();
}

console.log(`\n${'='.repeat(78)}`);
if (mutationsSkipped().length) {
  console.log(`mutations that did not apply: ${mutationsSkipped().join(', ')}`);
}
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
