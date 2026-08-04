// Live proof that a failed agent spawn is reported rather than swallowed —
// the extraction source's KAN-24 legibility fix, exercised against a real
// herdr.
//
// Before that fix, `herdr agent start` was a bare spawnSync whose result was
// discarded. A refused spawn produced a session marked 'active' and an
// activate response of `success: true`, which is how an outage stayed
// invisible for an afternoon. This drives two real failure modes and prints
// what HerdrBridge now reports for each.
//
// Everything runs against a private herdr server on its own socket, so it
// cannot disturb a live session; workspaces land in a scratch dataDir.
//
// Usage: node scripts/verify-spawn-failure-legibility.mjs [distDir]
//
// distDir defaults to ../dist.

import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

// sockaddr_un.sun_path is ~108 bytes, so the socket cannot live under a long
// TMPDIR. /tmp directly is the only reliably short option.
const runDir = mkdtempSync('/tmp/herdr-k24-');
const stateDir = mkdtempSync(path.join(tmpdir(), 'k24-state-'));
const dataDir = path.join(stateDir, 'data');

process.env.HERDR_SOCKET_PATH = path.join(runDir, 'h.sock');
process.env.XDG_CONFIG_HOME = path.join(stateDir, 'config');
process.env.XDG_STATE_HOME = path.join(stateDir, 'state');
process.env.HERDR_LOG = 'herdr=info';
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const herdr = (...args) => {
  try {
    return execFileSync('herdr', args, { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    return e.stdout ?? String(e);
  }
};

let server;
let tinyClient;
function cleanup() {
  tinyClient?.kill('SIGKILL');
  server?.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log('== starting a private herdr server ==');
server = spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env: process.env });
for (let i = 0; i < 20; i++) {
  if (herdr('pane', 'list').includes('"panes"')) break;
  await sleep(500);
}
console.log(`   pid ${server.pid}, socket ${process.env.HERDR_SOCKET_PATH}`);

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const bridge = new HerdrBridge(dataDir);

function report(label, session) {
  console.log(`   session.status ...... ${session.status}`);
  console.log(`   session.spawnError .. ${session.spawnError ?? '(none)'}`);
  // What handleActivateByKey would answer for this session.
  const activateSaid = session.spawnError
    ? { success: false, error: session.spawnError }
    : { success: true, sessionId: session.sessionId, status: session.status };
  console.log(`   activate would say .. ${JSON.stringify(activateSaid, null, 2).replace(/\n/g, '\n' + ' '.repeat(27))}`);
}

// The `shell` launcher, explicitly: what is under proof is spawn-failure
// reporting, not launcher provisioning, and `shell` touches nothing outside
// the scratch (a claude launcher would write folder trust into the real
// ~/.claude.json).
const AS_SHELL = {
  priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
};

/**
 * A directory for one of this script's scratch agents.
 *
 * It has to be created here, because an agent is its directory and CrabCast
 * creates none: `spawnSession` runs the pane in a path the caller supplies and
 * `configure` refuses one that is not there.
 */
function agentDir(name) {
  const dir = path.join(stateDir, 'owned', name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

// ---------------------------------------------------------------- geometry --
console.log('\n== failure mode 1: collapsed pane geometry (the real KAN-24 outage) ==');
herdr('agent', 'start', 'anchor', '--cwd', '/tmp', '--', 'bash', '-c', 'while true; do sleep 5; done');
await sleep(1000);
// A pty with no window size reports 1x1, which shrinks the workspace layout
// until a new pane's share rounds to zero. This is the exact mechanism.
tinyClient = spawn('script', ['-q', '-c', 'herdr agent attach anchor --takeover', '/dev/null'],
  { stdio: 'ignore', env: process.env });
await sleep(3000);

const geometrySession = bridge.spawnSession(agentDir('geometry'), AS_SHELL);
await sleep(500);
report('geometry', geometrySession);

tinyClient.kill('SIGKILL');
tinyClient = null;
await sleep(2000);

// ------------------------------------------------------------ fd exhaustion --
console.log('\n== failure mode 2: file-descriptor exhaustion (prlimit) ==');
const openNow = readdirSync(`/proc/${server.pid}/fd`).length;
console.log(`   server currently holds ${openNow} fds; dropping its soft limit to ${openNow + 1}`);
try {
  execFileSync('prlimit', ['--pid', String(server.pid), `--nofile=${openNow + 1}:1048576`]);
} catch (e) {
  console.log(`   prlimit failed (${e.message}); skipping this mode`);
}
console.log(`   limit now: ${readFileSync(`/proc/${server.pid}/limits`, 'utf8')
  .split('\n').find(l => l.startsWith('Max open files')).trim()}`);

const fdSession = bridge.spawnSession(agentDir('fdlimit'), AS_SHELL);
await sleep(500);
report('fdlimit', fdSession);

console.log('\n== done ==');
process.exit(0);
