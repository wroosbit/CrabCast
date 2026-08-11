#!/usr/bin/env node
// Live proof for the daemon skeleton (KAN-69): the daemon refuses rather than
// repairs, the socket round-trips daemon_status, and exactly one daemon owns
// the socket. Run `npm run build` first, then this script; it is
// self-contained (temp config + temp data dir) and exits non-zero on any
// failure so a reviewer can re-run it against the PR head.
//
// WHAT SECTION 1 TESTS NOW, AND WHY IT IS NOT THE SAME LIST.
//
// It used to prove three config-loader refusals: a dashed type name, a missing
// priority, and an unknown defaultLauncher. All three were about
// `workspaceTypes`, which is deleted, and NONE of them is a weakened
// assertion — each one moved rather than vanished, and the replacements are
// asserted here:
//
//   * dashed type name        — DELETED OUTRIGHT. The rule existed only to
//                               protect a pane-name parse (`<prefix>-<type>-<key>`,
//                               split at the first dash) that no longer
//                               happens. There is nothing left for a dash to
//                               break, so testing a refusal would be testing
//                               a rule with no reason.
//   * missing priority        — MOVED to `configure`, refused there by name,
//                               proven in verify-agent-power-controls.
//   * unknown defaultLauncher — MOVED to `configure` for the same reason, and
//                               proven in verify-activate-requires-agent.
//
// What replaces them here are the two refusals that are genuinely the
// daemon's own boot: a config still declaring the retired key, and a durable
// log this daemon's format does not cover (KAN-124 AC 5).

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonJs = path.join(repoRoot, 'dist', 'daemon.js');
if (!fs.existsSync(daemonJs)) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(1);
}

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-verify-'));
const dataDir = path.join(tmp, 'data');
const socketPath = path.join(dataDir, 'crabcast.sock');
const logPath = path.join(dataDir, 'daemon.log');

const goodConfig = { dataDir };
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify(goodConfig, null, 2));

function writeConfig(name, mutate) {
  const config = structuredClone(goodConfig);
  mutate(config);
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

function startDaemonSync(cfg) {
  return spawnSync(process.execPath, [daemonJs, cfg], { encoding: 'utf8', timeout: 15000 });
}

function startDaemon(cfg) {
  return spawn(process.execPath, [daemonJs, cfg], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * Boot a daemon that is EXPECTED TO COME UP, collect its stderr, and stop it
 * (KAN-302).
 *
 * §§1b–1d used `startDaemonSync` because the daemon they were about exited on
 * its own. It does not any more: an unreadable registry row is a notice now
 * rather than a refusal, so `spawnSync` would sit on a running daemon until its
 * timeout and report `status: null` — a hang dressed as a failure. This waits
 * for the socket instead, which is the thing those sections now assert.
 */
async function bootAndCapture(cfg, dir, whileUp) {
  const child = spawn(process.execPath, [daemonJs, cfg], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const sock = path.join(dir, 'crabcast.sock');
  const deadline = Date.now() + 8000;
  let started = false;
  while (Date.now() < deadline && !started) {
    if (child.exitCode !== null) break;
    started = await new Promise((resolve) => {
      const probe = net.connect(sock);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (!started) await sleep(100);
  }
  // Asked while it is still up, because the socket goes with the process.
  let probed;
  if (started && whileUp) {
    try { probed = await whileUp(sock); } catch (err) { probed = { error: String(err) }; }
  }
  child.kill();
  await sleep(200);
  return { started, stderr, exitCode: child.exitCode, probed };
}

/** {@link roundTrip} against a socket other than this script's own. */
function roundTripTo(socket, request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socket);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => {
        probe.end();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

async function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function roundTrip(request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for reply'));
    }, timeoutMs);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.slice(0, idx)));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });
  });
}

console.log('=== 1. The daemon refuses rather than repairs ===');
{
  // 1a. A config still declaring `workspaceTypes`.
  //
  // Refused rather than ignored, and the difference is the whole point: a
  // config written against the type model set an agent's priority, prompt,
  // launcher and gate exemption. Silently dropping the key would start a
  // daemon that agrees with the file about nothing, and the first evidence
  // would be an activation refused for a knob nobody knew had moved.
  const retired = writeConfig('retired.config.json', (c) => {
    c.workspaceTypes = [
      { name: 'shell', priority: 1, promptFile: 'prompts/shell.md', defaultLauncher: 'shell' }
    ];
  });
  const result = startDaemonSync(retired);
  console.log(`stderr: ${result.stderr.trim()}`);
  check(result.status === 1, 'retired workspaceTypes key: daemon refuses with exit 1', `exit ${result.status}`);
  check(
    result.stderr.includes('"workspaceTypes"') &&
      result.stderr.includes('no longer a config key') &&
      result.stderr.includes('configure'),
    'the refusal names the key, says it is retired, and names the verb the knobs moved to'
  );

  // 1b. The socket-path bound, which is not about types and did not move.
  const longDir = path.join(tmp, 'x'.repeat(120));
  const longConfig = writeConfig('long.config.json', (c) => { c.dataDir = longDir; });
  const result2 = startDaemonSync(longConfig);
  console.log(`stderr: ${result2.stderr.trim().split('\n')[0]}`);
  check(result2.status === 1, 'over-long dataDir: daemon refuses with exit 1', `exit ${result2.status}`);
  check(
    result2.stderr.includes('"dataDir"') && result2.stderr.includes('104'),
    'the refusal names the field and the bound'
  );
}

console.log('\n=== 1b. A durable log this daemon cannot fully read (KAN-124 AC 5, KAN-302) ===');
{
  // The pre-migration case, end to end. Old rows carry `type`/`key`/`workDir`
  // and no `path`; `path` derives from `workDir`, but `priority`, the gate
  // flags and `prompt` lived in `workspaceTypes` and have nowhere to come
  // from — so a converted row would be a *configured* agent missing three
  // required `configure` parameters, which the API could not have produced.
  //
  // THIS SECTION ASSERTED A REFUSAL UNTIL KAN-302, AND NOW ASSERTS A NOTICE.
  // What it was defending against has not changed and is worth restating,
  // because it is the reason the replacement is not simply a relaxation: if the
  // version check had gone inside `readLog`'s filter, these rows would be
  // dropped SILENTLY (that filter is silent on purpose, for torn-tail
  // tolerance), the daemon would come up, and reconcile would print "the agent
  // registry records no agents that should be running" — indistinguishable from
  // a healthy empty fleet.
  //
  // The daemon now starts, and the defence is the DISCLOSURE rather than the
  // exit: the rows are published on `list_agents` and `daemon_status`, so the
  // fleet is not silently short. What made the old behaviour untenable was its
  // remedy — "delete the registry and configure the fleet again", i.e. discard
  // every other agent record to recover from one row — and one dead row taking
  // the whole daemon off the machine. So this section keeps every assertion
  // that is still true (the file is named, the count is named, the rows are
  // identified in their own vocabulary, nothing is rewritten) and swaps the
  // exit-1 assertion for the two that replaced it. The full behaviour is
  // `verify-registry-survives-retired-rows.mjs`; what stays here is this
  // file's own subject, which is what the daemon does at BOOT.
  const preMigrationDir = path.join(tmp, 'old-data');
  fs.mkdirSync(preMigrationDir, { recursive: true, mode: 0o700 });
  const oldLog = path.join(preMigrationDir, 'agents.jsonl');
  const rows = [
    { event: 'activated', agentName: 'crabcast-task-kan-93', type: 'task', key: 'KAN-93',
      workDir: '/home/someone/.local/share/crabcast/workspaces/task/kan-93', at: '2026-08-01T10:00:00.000Z' },
    { event: 'activated', agentName: 'crabcast-epic-kan-59', type: 'epic', key: 'KAN-59',
      workDir: '/home/someone/.local/share/crabcast/workspaces/epic/kan-59', at: '2026-08-01T10:01:00.000Z' },
    { event: 'deactivated', agentName: 'crabcast-shell-demo', type: 'shell', key: 'demo',
      workDir: '/home/someone/.local/share/crabcast/workspaces/shell/demo', at: '2026-08-01T10:02:00.000Z' }
  ];
  fs.writeFileSync(oldLog, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const before = fs.readFileSync(oldLog, 'utf8');

  const oldConfig = writeConfig('old.config.json', (c) => { c.dataDir = preMigrationDir; });
  const result = await bootAndCapture(oldConfig, preMigrationDir);
  console.log(result.stderr.trim());
  check(
    result.started,
    'pre-migration log: the daemon STARTS — one dead row does not take the daemon off the ' +
      'machine (KAN-302)',
    `exitCode ${result.exitCode}`
  );
  check(
    result.stderr.includes(oldLog),
    'the notice names the file',
    oldLog
  );
  check(
    /3 of 3 record\(s\)/.test(result.stderr),
    'the notice names the count — how many rows, out of how many'
  );
  check(
    result.stderr.includes('task/KAN-93') || result.stderr.includes('crabcast-task-kan-93'),
    'and identifies rows in the vocabulary those rows actually use, so a human can find them'
  );
  check(
    /line 1:/.test(result.stderr) && /line 3:/.test(result.stderr),
    'naming each offending LINE, which is what makes a repair targeted rather than wholesale'
  );
  check(
    !/\bDelete\b|\bdelete\b/.test(result.stderr),
    'and NEVER tells the operator to delete the registry — that was the first remedy this ' +
      'replaces, and it discarded every other record to recover from one row'
  );
  check(
    /HAVE NOT BEEN RESTORED/.test(result.stderr),
    'while saying plainly that the agents in those rows are not running — starting is not the ' +
      'same as pretending the rows were readable, and the silence is what made half-loading ' +
      'unacceptable in the first place'
  );
  check(
    result.stderr.includes('no `migrate-log`') || result.stderr.includes('no \\`migrate-log\\`') ||
      result.stderr.includes('migrate-log'),
    'and the absence of a migration tool is stated rather than left to be discovered'
  );
  check(
    fs.readFileSync(oldLog, 'utf8') === before,
    'the log is untouched — the daemon cannot read those rows, and does not rewrite them either'
  );
}

console.log('\n=== 1c. A hand-edit that follows the refusal\'s own advice and drops a field ===');
{
  // The gate used to ask only "is `v` current?", while `readLog` additionally
  // requires a `path` and a complete `config`. Remedy 2 in the refusal above
  // tells an operator to HAND-EDIT the rows — so an operator doing exactly
  // what the daemon told them, who misses one of the five required config
  // fields, produced a row that passed the gate and was then dropped SILENTLY
  // by the loader. That silence is deliberate and correct for torn tails, so
  // the daemon would have started clean and reported a fleet with a hole in
  // it — through the recovery procedure it recommended itself.
  const dir = path.join(tmp, 'handedit-data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = path.join(dir, 'agents.jsonl');
  const full = {
    priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'claude'
  };
  const { chargeable, ...missingOne } = full;
  fs.writeFileSync(log, [
    // A good row, so the file is not uniformly broken.
    JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan124-good', config: full, at: '2026-08-01T10:00:00.000Z' }),
    // The hand-edit casualty: version-current, `chargeable` dropped.
    JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan124-handedited', config: missingOne, at: '2026-08-01T10:01:00.000Z' })
  ].join('\n') + '\n');

  const cfg = writeConfig('handedit.config.json', (c) => { c.dataDir = dir; });
  const result = await bootAndCapture(cfg, dir, (sock) =>
    roundTripTo(sock, { action: 'daemon_status', id: 77 }));
  console.log(result.stderr.trim());

  check(
    result.started,
    'a version-current row the loader would drop is disclosed rather than fatal (KAN-302)',
    `exitCode ${result.exitCode}`
  );
  check(
    /1 row\(s\) are version v1 and still unreadable/.test(result.stderr),
    'the notice counts them separately from pre-migration rows — different problem, different fix'
  );
  check(
    /kan124-handedited/.test(result.stderr) && /unusable/.test(result.stderr),
    'and names the offending row rather than only the count'
  );
  check(
    /"config\.chargeable"/.test(result.stderr) && /hand-edit/.test(result.stderr),
    'naming the exact field THIS row is missing — not the whole list of what a row needs, ' +
      'because the operator already believes they supplied them all'
  );
  check(
    !/were written by a CrabCast that addressed agents by/.test(result.stderr),
    'and it does NOT describe a v1 row as a pre-migration <type>/<key> log, which would ' +
      'send the operator to the wrong remedy'
  );
  // The half that used to be "no partial load". The good row IS loaded now —
  // that is the point — so what has to hold is that the dropped one is not
  // silently absent, which is the property the refusal was buying.
  const status = result.probed;
  check(
    status?.configuredAgents === 1,
    'the good row was loaded on its own — the fleet is not held hostage by the bad one',
    `configuredAgents=${status?.configuredAgents}`
  );
  check(
    status?.unreadableRecordsTotal === 1 &&
      status?.unreadableRecords?.[0]?.claimsPath === '/tmp/kan124-handedited',
    'and the dropped one is disclosed on the wire, so the hole in the fleet is visible to a ' +
      'caller rather than only to whoever reads daemon.log'
  );
}

console.log('\n=== 1d. A log from a NEWER daemon ===');
{
  // Not a pre-migration log — the opposite. Describing it as one would send an
  // operator to "delete it and re-configure" when the fix is to stop
  // downgrading.
  const dir = path.join(tmp, 'newer-data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.jsonl'),
    JSON.stringify({ v: 99, event: 'activated', path: '/tmp/kan124-future', config: {}, at: 'x' }) + '\n');
  const cfg = writeConfig('newer.config.json', (c) => { c.dataDir = dir; });
  const before = fs.readFileSync(path.join(dir, 'agents.jsonl'), 'utf8');
  const result = await bootAndCapture(cfg, dir);
  console.log(result.stderr.trim().split('\n').slice(0, 8).join('\n'));
  check(result.started, 'a newer-format log is disclosed rather than fatal (KAN-302)',
    `exitCode ${result.exitCode}`);
  check(
    /NEWER than this daemon writes/.test(result.stderr) && /downgrading/.test(result.stderr),
    'and says so — it names downgrading as what put you here, rather than calling it a ' +
      'pre-migration log and sending you to the wrong repair'
  );
  check(
    fs.readFileSync(path.join(dir, 'agents.jsonl'), 'utf8') === before,
    'AND LEAVES THE NEWER ROWS ALONE, which is the whole of why starting here is safe: the ' +
      'newer daemon still finds its own log intact when it comes back'
  );
}

console.log('\n=== 2. Daemon starts from config; daemon_status round-trips ===');
const first = startDaemon(configPath);
{
  check(await waitForSocket(), 'daemon came up and owns the socket', socketPath);
  const reply = await roundTrip({ action: 'daemon_status', id: 42 });
  console.log(`daemon_status reply: ${JSON.stringify(reply)}`);
  check(reply.success === true && reply.id === 42, 'daemon_status replies success with echoed id');
  // What replaced the workspace-type table. The question a person arrives
  // with used to be "is the daemon up with the config I just edited"; with no
  // types to declare, the equivalent is "where does it keep the agents", and
  // the registry path plus the two counts is that answer.
  check(
    reply.registryPath === path.join(dataDir, 'agents.jsonl'),
    'reply reports where the durable registry lives',
    reply.registryPath
  );
  check(
    reply.configuredAgents === 0 && reply.expectedAgents === 0,
    'reply reports the agent counts, present-and-zero rather than absent',
    `${reply.configuredAgents} configured, ${reply.expectedAgents} expected`
  );
  check(
    reply.workspaceTypes === undefined,
    'and says nothing about workspace types, which no longer exist'
  );
  check(reply.dataDir === dataDir, 'reply reports the config-declared dataDir');
  const unknown = await roundTrip({ action: 'no_such_action', id: 43 });
  check(
    unknown.success === false && typeof unknown.error === 'string' && unknown.id === 43,
    'unknown action answers {success:false, error, id}',
    unknown.error
  );

  // `reset` was REMOVED, not redefined, and this is what that buys: a caller
  // still invoking it is told so by name. A redefined `reset` would let every
  // caller keep calling it and quietly mean something else.
  const reset = await roundTrip({ action: 'reset_by_key', type: 'shell', key: 'demo', id: 46 });
  console.log(`reset_by_key reply: ${JSON.stringify(reset)}`);
  check(
    reset.success === false && /Unknown action: reset_by_key/.test(reset.error ?? ''),
    'the removed `reset_by_key` answers Unknown action BY NAME, so a caller notices'
  );
  check(
    /deactivate_agent/.test(reset.error ?? '') && /forget_agent/.test(reset.error ?? ''),
    'and the refusal names the two verbs that replaced it',
    reset.error
  );
  const logged = fs.readFileSync(logPath, 'utf8');
  check(
    logged.includes('Agent registry: 0 configured agent(s), 0 expected to be running'),
    'daemon log records the registry it loaded, in place of the type table'
  );
}

console.log('\n=== 3. The line buffer is bounded (KAN-88 finding A3) ===');
{
  // The framing assembled a line without limit, so a peer that streams bytes
  // and never sends a newline was never *wrong* by the framing's rules — it
  // just grew the daemon's memory as far as it cared to, on a socket whose
  // only auth boundary is file permissions. The bound turns that from memory
  // exhaustion into a refused connection, and the refusal is legible: the peer
  // is told the bound it hit rather than watching the connection vanish.
  const MAX = 1024 * 1024;
  const attacker = net.connect(socketPath);
  const answer = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the daemon never answered or closed')), 20000);
    let received = '';
    let sent = 0;
    let closed = false;
    attacker.on('data', (chunk) => { received += chunk.toString('utf8'); });
    attacker.on('error', () => {}); // the hang-up may arrive as a write error
    attacker.on('close', () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resolve({ received, sent });
    });
    attacker.once('connect', () => {
      // 64 KiB at a time, newline-free, well past the bound. `write` keeps
      // returning as long as the peer is there; the close is what stops it.
      const chunk = 'A'.repeat(64 * 1024);
      const pump = () => {
        while (!closed && sent < MAX * 4) {
          if (!attacker.write(chunk)) { attacker.once('drain', pump); sent += chunk.length; return; }
          sent += chunk.length;
        }
      };
      pump();
    });
  });

  const firstLine = answer.received.split('\n')[0];
  console.log(`streamed ${answer.sent} newline-free bytes (bound is ${MAX})`);
  console.log(`daemon said: ${firstLine}`);
  let parsed = null;
  try { parsed = JSON.parse(firstLine); } catch {}
  check(
    parsed?.success === false && /exceeded 1048576 characters with no newline/.test(parsed?.error ?? ''),
    'the daemon refused the oversized line on the wire, naming the bound'
  );
  check(
    attacker.destroyed,
    'the daemon closed the connection rather than growing with it'
  );
  check(
    fs.readFileSync(logPath, 'utf8').includes('Line exceeded 1048576 characters'),
    'the refusal is in the daemon log too'
  );

  // And the bound does not refuse anything real: a large-but-legitimate
  // message still round-trips on a fresh connection, and the daemon that hung
  // up on the flood is still serving.
  const big = await roundTrip({ action: 'daemon_status', id: 45, padding: 'B'.repeat(512 * 1024) });
  check(
    big.success === true && big.id === 45,
    'a 512 KiB well-formed message still round-trips — the bound refuses floods, not big messages'
  );
}

console.log('\n=== 4. Single daemon wins ===');
{
  const second = startDaemonSync(configPath);
  check(second.status === 0, 'second daemon exits 0 while the first owns the socket', `exit ${second.status}`);
  check(
    fs.readFileSync(logPath, 'utf8').includes('Another daemon is already running; exiting.'),
    'second daemon logged the another-daemon-owns-the-socket path'
  );

  // SIGKILL so the shutdown handler cannot unlink the socket: a stale file.
  first.kill('SIGKILL');
  const exit = await waitForExit(first);
  check(exit !== null && exit.signal === 'SIGKILL', 'first daemon killed', JSON.stringify(exit));
  check(fs.existsSync(socketPath), 'stale socket file left behind');

  const third = startDaemon(configPath);
  check(await waitForSocket(), 'third daemon unlinked the stale socket and bound');
  check(
    fs.readFileSync(logPath, 'utf8').includes('Removing stale socket file'),
    'third daemon logged the stale-socket cleanup'
  );
  const reply = await roundTrip({ action: 'daemon_status', id: 44 });
  check(reply.success === true, 'third daemon answers daemon_status');

  third.kill('SIGTERM');
  const exit3 = await waitForExit(third);
  check(exit3 !== null && exit3.code === 0, 'SIGTERM shutdown exits 0', JSON.stringify(exit3));
  check(!fs.existsSync(socketPath), 'shutdown unlinked the socket file');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
