#!/usr/bin/env node
// Live proof for the daemon skeleton (KAN-69): config validation refuses
// rather than repairs, the socket round-trips daemon_status, and exactly one
// daemon owns the socket. Run `npm run build` first, then this script; it is
// self-contained (temp config + temp data dir) and exits non-zero on any
// failure so a reviewer can re-run it against the PR head.

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

const goodConfig = {
  dataDir,
  workspaceTypes: [
    {
      name: 'shell',
      priority: 1,
      promptFile: 'prompts/shell.md',
      defaultLauncher: 'shell'
    }
  ]
};
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

console.log('=== 1. Config validation refuses rather than repairs ===');
{
  const dashed = writeConfig('dashed.config.json', (c) => {
    c.workspaceTypes[0].name = 'shell-agent';
  });
  const result = startDaemonSync(dashed);
  console.log(`stderr: ${result.stderr.trim()}`);
  check(result.status === 1, 'dashed type name: daemon refuses with exit 1', `exit ${result.status}`);
  check(
    result.stderr.includes('"name"') && result.stderr.includes('shell-agent'),
    'dashed type name: error names the field and the type'
  );

  const noPriority = writeConfig('no-priority.config.json', (c) => {
    delete c.workspaceTypes[0].priority;
  });
  const result2 = startDaemonSync(noPriority);
  console.log(`stderr: ${result2.stderr.trim()}`);
  check(result2.status === 1, 'missing priority: daemon refuses with exit 1', `exit ${result2.status}`);
  check(
    result2.stderr.includes('"priority"') && result2.stderr.includes('shell'),
    'missing priority: error names the field and the type'
  );

  // Boot-time check rather than the config loader's: the launcher table lives
  // in launchers.ts, and a typo'd launcher surviving to first activation
  // would break the fail-at-load contract in the one field the loader cannot
  // check itself.
  const badLauncher = writeConfig('bad-launcher.config.json', (c) => {
    c.workspaceTypes[0].defaultLauncher = 'clade';
  });
  const result3 = startDaemonSync(badLauncher);
  console.log(`stderr: ${result3.stderr.trim()}`);
  check(result3.status === 1, 'unknown defaultLauncher: daemon refuses at boot with exit 1', `exit ${result3.status}`);
  check(
    result3.stderr.includes('clade') &&
      result3.stderr.includes('shell') &&
      result3.stderr.includes('claude') &&
      result3.stderr.includes('Valid launchers'),
    'unknown defaultLauncher: error names the typo, the type, and the valid launchers'
  );
}

console.log('\n=== 2. Daemon starts from config; daemon_status round-trips ===');
const first = startDaemon(configPath);
{
  check(await waitForSocket(), 'daemon came up and owns the socket', socketPath);
  const reply = await roundTrip({ action: 'daemon_status', id: 42 });
  console.log(`daemon_status reply: ${JSON.stringify(reply)}`);
  check(reply.success === true && reply.id === 42, 'daemon_status replies success with echoed id');
  const names = (reply.workspaceTypes ?? []).map((t) => t.name);
  check(
    names.length === 1 && names[0] === 'shell' && reply.workspaceTypes[0].priority === 1,
    'reply lists the config-declared types',
    `types: ${JSON.stringify(names)}`
  );
  check(reply.dataDir === dataDir, 'reply reports the config-declared dataDir');
  const unknown = await roundTrip({ action: 'no_such_action', id: 43 });
  check(
    unknown.success === false && typeof unknown.error === 'string' && unknown.id === 43,
    'unknown action answers {success:false, error, id}',
    unknown.error
  );
  const logged = fs.readFileSync(logPath, 'utf8');
  check(
    logged.includes('Loaded 1 workspace type(s):') && logged.includes('shell — priority 1'),
    'daemon log records the loaded workspace types'
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
