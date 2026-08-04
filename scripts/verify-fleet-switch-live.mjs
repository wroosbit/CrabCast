// The live half of the fleet-switch and restart-survival proofs: a real
// daemon, a real herdr, and `herdr agent list` as the ground truth for
// whether an agent is running. Ported from the extraction source's KAN-38
// live proof and extended with the daemon-restart sequences its KAN-21
// registry exists for — the parts a stubbed herdr cannot prove.
//
// Sections:
//
//   1. baseline  — what herdr says is running before anything happens
//   2. on        — a pane that was not there, and then is
//   3. restart   — SIGKILL the daemon; a fresh daemon restores the probe
//                  through the real activation path, re-verified against
//                  herdr's census, without double-spawning it
//   4. off+restart — deactivate, restart the daemon again: the stand-down
//                  STAYS down and is reported in standbyAgents, not restored
//   5. way back  — the standby row is what switches it back on
//   6. lost      — close the pane behind the daemon's back: one
//                  agent_lost_event per loss, not one per sweep, and
//                  missingAgents names it until someone decides
//   7. teardown  — the machine as it was found
//
// WHAT IT TOUCHES
//
// One probe agent, `task/KAN72-PROBE`, and nothing else. Every request names
// that key. The daemon runs against a scratch config whose dataDir is a temp
// directory, so its socket, its log and its registry are its own; the live
// install's registry is never written to. herdr is deliberately NOT isolated:
// its server is per-machine, which is exactly what makes this a live proof.
// The probe pane is closed on every exit path including a crash.
//
// The probe launches `shell`, not `claude`: this proves panes open, survive,
// and close on command, and starting a real language model to demonstrate
// that would cost money to prove nothing extra. (The claude-launcher resume
// framing is proved end-to-end in verify-agent-resumption.mjs section 5.)
//
// The extraction source's live refusal section did not travel: the capacity
// gate is the capacity slice (T3 of KAN-68); activation here passes the
// always-admit seam it will replace.
//
// Usage:
//   npm run build
//   node scripts/verify-fleet-switch-live.mjs
// Run it on a machine with herdr running.

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// The one thing this live proof needs from the code under test: the pane name
// a directory derives, so the herdr census can be searched for our probe
// without parsing anything back out of the name.
const { paneNameFor } = await import(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'identity.js')
);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

// The probe is a DIRECTORY now — that is the whole address — and its pane
// name is a one-way function of it. Both are filled in once the scratch exists.
let PROBE_DIR;
let PROBE_AGENT;

if (!existsSync(path.join(rootDir, 'dist', 'daemon.js'))) {
  console.error('dist/daemon.js is missing — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(path.join(rootDir, 'node_modules', 'node-pty'))) {
  console.error('node_modules/node-pty is missing — run `npm install` first.');
  process.exit(1);
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

/**
 * Ground truth. Not the daemon's `list_agents`, which is the thing under test —
 * this is herdr's own census, read with the same command a human would type.
 */
function herdrAgents() {
  try {
    const out = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return (JSON.parse(out)?.result?.agents ?? []).map((a) => a.name);
  } catch (e) {
    console.error(`herdr agent list failed: ${e?.message ?? e}`);
    return null;
  }
}

const probeRunning = () => (herdrAgents() ?? []).includes(PROBE_AGENT);

/**
 * Close the probe's pane the way the daemon itself does: resolve the pane id
 * with `agent get`, close it with `pane close`. herdr has no `agent close`
 * subcommand.
 */
function closeProbePane() {
  const out = execFileSync('herdr', ['agent', 'get', PROBE_AGENT], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const paneId = JSON.parse(out)?.result?.agent?.pane_id;
  if (typeof paneId !== 'string' || !paneId) {
    throw new Error(`no pane id for ${PROBE_AGENT}`);
  }
  execFileSync('herdr', ['pane', 'close', paneId], { stdio: 'ignore', timeout: 15000 });
}

/** Wait for herdr to agree, or give up. Panes do not open or close instantly. */
async function waitForProbe(present, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeRunning() === present) return true;
    await sleep(500);
  }
  return false;
}

// ------------------------------------------------------------- the scratch --

const scratch = mkdtempSync(path.join(tmpdir(), 'kan72-live-'));
const dataDir = path.join(scratch, 'data');
const configPath = path.join(scratch, 'crabcast.config.json');
// A dataDir and nothing else: no type table left to declare.
writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

// The probe's directory. THIS SCRIPT creates it, because CrabCast creates none
// — and removes it at the end, because CrabCast may not.
mkdirSync(path.join(scratch, 'owned', 'probe'), { recursive: true });
PROBE_DIR = realpathSync(path.join(scratch, 'owned', 'probe'));
PROBE_AGENT = paneNameFor(PROBE_DIR);

const socketPath = path.join(dataDir, 'crabcast.sock');
const registryPath = path.join(dataDir, 'agents.jsonl');
const daemonLog = path.join(dataDir, 'daemon.log');

let daemon = null;
let cleanedUp = false;

/**
 * Close the probe's pane whatever happened. Registered on exit and on the
 * signals a Ctrl-C produces, because the one outcome this script must not have
 * is leaving an orphan pane on a machine whose capacity is rationed.
 */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if ((herdrAgents() ?? []).includes(PROBE_AGENT)) closeProbePane();
  } catch {}
  daemon?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(1); });

// --------------------------------------------------------------- the daemon --

let socket = null;
let buffer = '';
const pending = new Map();
/** Unsolicited broadcasts (agent_lost_event and friends), in arrival order. */
const events = [];
let nextId = 0;

function attachSocket(sock) {
  socket = sock;
  buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else {
        events.push(msg);
      }
    }
  });
  sock.on('error', () => {});
}

const call = (action, data = {}, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const id = `kan72-${++nextId}`;
    // A watchdog, not a nicety: a request written to a socket that died
    // between connect and write is simply never answered, and a proof that
    // hangs forever proves less than one that fails saying where.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no response to ${action} (id ${id}) within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

/** Start a fresh daemon on the scratch config and connect to it. */
async function startDaemon(label) {
  console.log(`starting a real daemon (${label}) from ${rootDir}/dist against ${configPath}`);
  daemon = spawn(process.execPath, [path.join(rootDir, 'dist', 'daemon.js'), configPath], {
    stdio: ['ignore', 'ignore', 'inherit']
  });
  // Round-trip readiness, not connect-based readiness. A `connect` that
  // succeeds is not evidence of a daemon: a unix listener accepts into its
  // kernel backlog without the owning process ever calling accept(), so a
  // connect racing a predecessor's death can land in a dead daemon's backlog
  // and then hang silently. Only an answered daemon_status counts.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) {
      console.error('daemon never answered daemon_status');
      process.exit(1);
    }
    const attempt = await new Promise((resolve) => {
      const sock = net.connect(socketPath);
      const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 2000);
      sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
      sock.once('error', () => { clearTimeout(timer); sock.destroy(); resolve(null); });
    });
    if (attempt) {
      attachSocket(attempt);
      try {
        const status = await call('daemon_status', {}, 3000);
        if (status?.success && status?.pid === daemon.pid) return;
      } catch {}
      socket?.destroy();
      socket = null;
    }
    await sleep(250);
  }
}

/** SIGKILL the daemon — no shutdown hook, exactly like a crash. */
async function killDaemon() {
  socket?.destroy();
  socket = null;
  const pid = daemon.pid;
  const gone = new Promise((resolve) => daemon.once('exit', resolve));
  daemon.kill('SIGKILL');
  // Wait for the kernel to actually reap it: kill() is asynchronous, and a
  // successor started against a listener that is still dying can race into
  // its backlog (see startDaemon).
  await gone;
  console.log(`daemon pid ${pid} SIGKILLed (no shutdown hook ran; its socket file is now stale)`);
}

const grepReconcile = () => {
  try {
    return readFileSync(daemonLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('[reconcile]'))
      .slice(-8);
  } catch {
    return [];
  }
};

await startDaemon('daemon #1');

// ------------------------------------------------------------- 1. baseline --
rule('1. BASELINE — what herdr says is running before anything happens');

const baseline = herdrAgents();
if (baseline === null) {
  console.error('herdr is not answering; this script cannot prove anything without it.');
  process.exit(1);
}
console.log(`herdr agent list → ${baseline.length} agents:`);
for (const name of baseline) console.log(`  ${name}`);
console.log(`\n  probe present: ${baseline.includes(PROBE_AGENT)}`);

// ------------------------------------------------------------------- 2. on --
rule('2. ON — a pane that was not there, and then is');

// The plain request first, so the real gate answers about the real machine.
// Whether it refuses depends on what this machine is carrying right now —
// that is the point of a live proof — and a refusal is not a failure of this
// script: the refusal's own [Start anyway] (override: true, recorded) is the
// path a supervisor takes next, and the rest of the proof needs a probe.
// `configure` first: it is mandatory, and `activate` takes no attributes, so
// the launcher and priority this probe runs with arrive here or nowhere.
const configured = await call('configure_agent', {
  path: PROBE_DIR, priority: 1, launcher: 'shell'
});
console.log(`configure_agent → success: ${configured.success}, ` +
  `occupiedBy: ${JSON.stringify(configured.occupiedBy)}`);

let started = await call('activate_agent', { path: PROBE_DIR });
if (started.success === false && started.refusedBy === 'capacity') {
  console.log(`the real gate refused first: ${started.reason}`);
  started = await call('activate_agent', { path: PROBE_DIR, override: true });
  console.log(`[Start anyway] → activate_agent with override: true`);
}
console.log(`activate_agent → success: ${started.success}, verified: ${started.verified}, sessionId: ${started.sessionId}`);
if (!started.success) {
  console.error(`could not start the probe: ${started.error}`);
  process.exit(1);
}

const appeared = await waitForProbe(true);
const withProbe = herdrAgents() ?? [];
console.log(`\nherdr agent list → ${withProbe.length} agents`);
console.log(`  ${PROBE_AGENT}   ← the one that was not there in section 1`);

const listedOn = await call('list_agents');
const rowOn = listedOn.agents.find((a) => a.path === PROBE_DIR);
console.log(`\nand on the daemon's own poll:`);
console.log(`  ${JSON.stringify({ path: rowOn?.path, paneName: rowOn?.paneName, sessionless: rowOn?.sessionless, chargeable: rowOn?.chargeable, herdrStatus: rowOn?.herdrStatus })}`);
console.log(`\nthe registry line behind it, fsynced before the response went out:`);
console.log(`  ${readFileSync(registryPath, 'utf8').trim().split('\n').pop()}`);

verdict(
  appeared && Boolean(rowOn) && !baseline.includes(PROBE_AGENT),
  'the agent is running, and herdr says so — not just the daemon that started it.',
  `the probe never appeared in herdr agent list (daemon row: ${Boolean(rowOn)})`
);

// -------------------------------------------------------------- 3. restart --
rule('3. RESTART SURVIVAL — SIGKILL the daemon; a fresh one restores the fleet');

const sessionBefore = started.sessionId;
await killDaemon();
console.log(`probe pane still alive without its daemon: ${probeRunning()} (herdr owns the pane, not the daemon)\n`);

await startDaemon('daemon #2');

// Reconciliation runs at onListen; give it a moment to restore one agent.
let restoredRow = null;
for (let i = 0; i < 60 && !restoredRow; i++) {
  await sleep(1000);
  const listed = await call('list_agents');
  const row = listed.agents.find((a) => a.path === PROBE_DIR);
  if (row && row.sessionless === false) restoredRow = row;
}
const censusAfterRestart = herdrAgents() ?? [];
const paneCount = censusAfterRestart.filter((n) => n === PROBE_AGENT).length;
const listedAfter = await call('list_agents');

console.log('daemon #2 reconcile log:');
for (const line of grepReconcile()) console.log(`  ${line}`);
console.log(`\nherdr agent list → probe pane count: ${paneCount} (a double-spawn would need a second name or an error)`);
console.log(`daemon #2 list_agents row:`);
console.log(`  ${JSON.stringify({ path: restoredRow?.path, sessionless: restoredRow?.sessionless, sessionId: restoredRow?.sessionId, status: restoredRow?.status })}`);
console.log(`  (session id ${restoredRow?.sessionId} ≠ daemon #1's ${sessionBefore} — a fresh attach, re-verified through`);
console.log(`   the activation path's confirmAgentPresent, not a persisted name taken on faith)`);
console.log(`missingAgents after reconcile: ${JSON.stringify(listedAfter.missingAgents)}`);

verdict(
  Boolean(restoredRow) &&
    restoredRow.sessionId !== sessionBefore &&
    paneCount === 1 &&
    listedAfter.missingAgents.length === 0,
  'the agent survived the daemon dying, was re-verified live against herdr, was not\n' +
  '    double-spawned, and the fleet reads whole again.',
  `restart survival failed: row=${Boolean(restoredRow)} panes=${paneCount} missing=${listedAfter.missingAgents.length}`
);

// -------------------------------------------------------- 4. off + restart --
rule('4. OFF, THEN RESTART — a deliberate stand-down stays down');

const off = await call('deactivate_agent', { path: PROBE_DIR });
console.log(`deactivate_agent → ${JSON.stringify({ success: off.success, path: off.path, wasRunning: off.wasRunning, state: off.state })}`);
const vanished = await waitForProbe(false);
console.log(`probe gone from herdr: ${vanished}`);
console.log(`registry line recorded for the stand-down:`);
console.log(`  ${readFileSync(registryPath, 'utf8').trim().split('\n').pop()}`);

await killDaemon();
await startDaemon('daemon #3');
// Give reconciliation the same window it had in section 3 — the assertion is
// that it does NOT use it.
await sleep(5000);
const afterStandDownRestart = await call('list_agents');
const standbyRow = afterStandDownRestart.standbyAgents.find((a) => a.path === PROBE_DIR);
console.log('\ndaemon #3 reconcile log:');
for (const line of grepReconcile()) console.log(`  ${line}`);
console.log(`\nprobe running after the restart: ${probeRunning()}`);
console.log(`standbyAgents: ${JSON.stringify(afterStandDownRestart.standbyAgents.map((a) => ({ path: a.path, launcher: a.launcher, since: a.since })))}`);
console.log(`standbyTotal: ${afterStandDownRestart.standbyTotal}, missingAgents: ${JSON.stringify(afterStandDownRestart.missingAgents)}`);

verdict(
  off.success === true && vanished && !probeRunning() &&
    Boolean(standbyRow) &&
    afterStandDownRestart.missingAgents.length === 0 &&
    !afterStandDownRestart.agents.some((a) => a.path === PROBE_DIR),
  'the reboot did not overturn the human\'s decision: the agent stayed down, and the\n' +
  '    way back is reported in standbyAgents rather than taken automatically.',
  `the stand-down did not stay down: running=${probeRunning()} standby=${Boolean(standbyRow)}`
);

// ------------------------------------------------------------- 5. way back --
rule('5. THE WAY BACK — off is reversible from the list that reported it');

console.log('a client sends, from that standby row — and nothing else, because');
console.log('`activate` takes no attributes: the launcher it comes back as is the one on');
console.log('its own record, not one the caller has to remember to repeat:\n');
console.log(`  { action: 'activate_agent', path: '${standbyRow?.path}' }`);
console.log(`  (the row also reports launcher '${standbyRow?.launcher}', for the human reading it)\n`);

const backOn = await call('activate_agent', {
  path: standbyRow?.path ?? PROBE_DIR,
  // Past the gate for the same reason section 2 ends up there: this machine
  // is busy, and the point being proved here is the round trip, not the gate.
  override: true
});
const returned = await waitForProbe(true);
const listedBack = await call('list_agents');
console.log(`activate_agent → success: ${backOn.success}`);
console.log(`herdr agent list → ${PROBE_AGENT} present: ${(herdrAgents() ?? []).includes(PROBE_AGENT)}`);
console.log(`list_agents → running: ${listedBack.agents.some((a) => a.path === PROBE_DIR)}, still on the stood-down list: ${listedBack.standbyAgents.some((a) => a.path === PROBE_DIR)}`);

verdict(
  Boolean(standbyRow) &&
    standbyRow.launcher === 'shell' &&
    backOn.success === true &&
    returned &&
    !listedBack.standbyAgents.some((a) => a.path === PROBE_DIR),
  'the agent that was switched off is the agent that came back, with the launcher it\n' +
  '    was started with, and it left the candidate list the moment it did.',
  `the round trip did not close: standby=${Boolean(standbyRow)} launcher=${standbyRow?.launcher} back=${returned}`
);

// ----------------------------------------------------------------- 6. lost --
rule('6. LOST — a pane closed behind the daemon\'s back is announced once, not every sweep');

console.log('closing the probe pane with herdr directly — the daemon is not consulted:\n');
console.log(`  herdr agent get ${PROBE_AGENT} → herdr pane close <pane_id>\n`);
closeProbePane();
await waitForProbe(false);

// The sweep runs every 30s. Wait up to 45s for the first announcement…
const eventsBefore = events.filter((e) => e.action === 'agent_lost_event').length;
let lostEvent = null;
for (let i = 0; i < 90 && !lostEvent; i++) {
  await sleep(500);
  lostEvent = events.find((e) => e.action === 'agent_lost_event' && e.path === PROBE_DIR);
}
console.log(`agent_lost_event received: ${JSON.stringify(lostEvent && {
  action: lostEvent.action, path: lostEvent.path, paneName: lostEvent.paneName,
  key: lostEvent.key, since: lostEvent.since, reason: lostEvent.reason
}, null, 2)}`);

const listedLost = await call('list_agents');
const missingRow = listedLost.missingAgents.find((m) => m.path === PROBE_DIR);
console.log(`\nmissingAgents on the next poll: ${JSON.stringify(missingRow && { path: missingRow.path, since: missingRow.since })}`);

// …then sit through one more full sweep and count the announcements.
console.log('\nwaiting out one more 30s sweep to prove the event does not repeat…');
await sleep(35000);
const lostEvents = events.filter((e) => e.action === 'agent_lost_event' && e.path === PROBE_DIR);
const stillListed = (await call('list_agents')).missingAgents.some((m) => m.path === PROBE_DIR);
console.log(`agent_lost_event count after a second sweep: ${lostEvents.length - eventsBefore >= 1 ? lostEvents.length : 0} (still exactly ${lostEvents.length})`);
console.log(`missingAgents still reports it on every poll: ${stillListed}`);

verdict(
  Boolean(lostEvent) && Boolean(missingRow) && lostEvents.length === 1 && stillListed,
  'the loss was announced exactly once, while every list_agents poll keeps reporting\n' +
  '    it until somebody decides — an alarm that repeats twice a minute forever would\n' +
  '    be an alarm everyone learns to ignore.',
  `lost accounting broke: event=${Boolean(lostEvent)} count=${lostEvents.length} listed=${stillListed}`
);

// ------------------------------------------------------------- 7. teardown --
rule('7. TEARDOWN — the machine as it was found');

// The loss is still on the books; standing the dead agent down is the decision
// that clears it (and proves the already-gone path against the real herdr).
const standDown = await call('deactivate_agent', { path: PROBE_DIR });
console.log(`deactivate_agent for the lost agent → ${JSON.stringify({ success: standDown.success, alreadyGone: standDown.alreadyGone })}`);
const finalList = await call('list_agents');
const final = herdrAgents() ?? [];
console.log(`\nherdr agent list → ${final.length} agents`);
console.log(`  probe present:                            ${final.includes(PROBE_AGENT)}`);
console.log(`  every agent from section 1 still running: ${baseline.every((n) => final.includes(n))}`);
console.log(`  missingAgents cleared by the stand-down:  ${!finalList.missingAgents.some((m) => m.path === PROBE_DIR)}`);

verdict(
  !final.includes(PROBE_AGENT) &&
    baseline.every((n) => final.includes(n)) &&
    standDown.success === true &&
    !finalList.missingAgents.some((m) => m.path === PROBE_DIR),
  'no orphan pane, the loss was resolved by a recorded decision, and every agent that\n' +
  '    was working when this started still is.',
  'this script did not leave the machine as it found it.'
);

socket.end();
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
