// Runs ONE imported Butchr proof against a REAL CrabCast built from this PR.
//
// KAN-519. This is the join KAN-117's task 1 left unowned: task 1 showed a
// script going red on a developer machine, against a real herdr and a
// hand-started socket. This runs the same class of proof on a RUNNER, herdr-free,
// against a CI-built daemon — and that transition is what this ticket owns.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A PEER AT ALL, WHICH IS THE WHOLE DESIGN
//
// KAN-518 measured that against a PINNED Butchr every input the CI-runnable
// sections read is a constant — Butchr's own source text, its own dist, or a
// socket the script stands up itself — so "a required check built from them
// cannot change its answer in response to anything in CrabCast". Wiring those
// sections would cost twenty minutes and gate nothing.
//
// The way through, which KAN-518 recommended and this script implements: stand
// up a REAL CrabCast daemon from the PR build, behind a shimmed `herdr`, in a
// scratch HOME — and point the proof at it. The proof's live sections then read
// CrabCast's OWN behaviour, which is the only thing on the path that a CrabCast
// PR can move. Measured under this ticket: with the peer up, three proofs go red
// on a deliberate CrabCast change; see redDrive on each WIRED entry in
// scripts/butchr-proof-import-registry.mjs.
//
// ⚠ THE METHODOLOGY TRAP, WHICH KAN-518 HIT AND CORRECTED (comment 13503).
// `defaultCrabCastSocket()` in Butchr IGNORES `BUTCHR_CRABCAST_SOCKET` — it
// returns `$HOME/.local/share/crabcast/crabcast.sock` and nothing else
// (daemon/src/crabcast-link.ts:174-176 at the pin). Two of the three wired
// proofs resolve their peer that way. Setting only the env var left KAN-518's
// scripts talking to the machine's LIVE peer and produced a misleading
// "EXIT=0 All assertions passed".
//
// So this script does BOTH, and they must agree: the daemon's dataDir IS
// `$HOME/.local/share/crabcast`, and `BUTCHR_CRABCAST_SOCKET` names that same
// path. A scratch HOME is therefore not tidiness here — it is the only thing
// that makes the measurement be about the peer this script started.
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node scripts/butchr-proof-harness.mjs <proof-name> [--no-peer]
//
//   --no-peer   start NO CrabCast daemon, and assert nothing. Used by
//               scripts/butchr-proof-reconcile.mjs to measure the missing-socket
//               disposition. The scratch HOME still applies, so "no peer" means
//               no peer rather than "the machine's live one".
//
// Exit: the proof's own exit code, unchanged. 0 passed / 1 an assertion failed /
// 2 INCOMPLETE (nothing failed and something did not run), per Butchr's
// daemon/scripts/lib/verdict-exit.mjs. It is NOT collapsed here — the caller
// decides what an INCOMPLETE means, and the workflow treats it as a failure.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WIRED } from './butchr-proof-import-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const noPeer = args.includes('--no-peer');
const proofName = args.find((a) => !a.startsWith('--'));

if (!proofName) {
  console.error('usage: node scripts/butchr-proof-harness.mjs <proof-name> [--no-peer]');
  process.exit(64);
}

// The checkout the workflow made, at the ref in .butchr-proof-pin.json.
const checkout = process.env.BUTCHR_PROOF_CHECKOUT ?? path.join(repoRoot, '.butchr-proofs');
const proofPath = path.join(checkout, 'daemon', 'scripts', `${proofName}.mjs`);

// A SETUP GUARD, NOT A VERDICT. If the checkout is not there the run has not
// measured anything, and saying so with a distinct code keeps it from being
// read as a proof result.
if (!fs.existsSync(proofPath)) {
  console.error(`SETUP: no proof at ${proofPath}`);
  console.error('       The butchr-proofs job checks out wroosbit/butchr at the pinned ref first.');
  console.error('       Nothing was measured — this is not a verdict about CrabCast.');
  process.exit(65);
}

const distDaemon = path.join(repoRoot, 'dist', 'daemon.js');
if (!fs.existsSync(distDaemon)) {
  console.error(`SETUP: no CrabCast build at ${distDaemon} — run \`npm run build\` first.`);
  console.error('       Nothing was measured.');
  process.exit(65);
}

// ─────────────────────────────────────────────────────────────────────────────
// The scratch world.
//
// HOME is taken from the environment when the caller set one (the workflow
// gives every proof its own, under $RUNNER_TEMP, exactly as the `verify` job
// does). Falling back to a fresh mkdtemp keeps a hand-run honest rather than
// letting it inherit the developer's real HOME and its live peer.
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE COMPARISON IS AGAINST passwd, NOT AGAINST os.homedir().
//
// `os.homedir()` RETURNS $HOME when it is set, so `process.env.HOME !==
// os.homedir()` is a condition that can never be true — it would silently send
// every run down the mkdtemp branch and quietly ignore the per-script $HOME the
// workflow went to the trouble of creating. `os.userInfo().homedir` reads the
// password database and ignores the environment, which is the only way to ask
// "is this the real login home, or a scratch one somebody handed me?".
//
// Getting this backwards is not cosmetic: falling through to the LOGIN home
// would put the daemon's dataDir at the developer's real
// ~/.local/share/crabcast — i.e. point the proofs at the machine's LIVE peer,
// which is exactly the trap KAN-518 hit and corrected. So the fallback is a
// fresh scratch directory rather than the caller's home, and a hand-run is
// isolated by default.
const callerHome = process.env.HOME;
let loginHome = null;
try {
  loginHome = os.userInfo().homedir;
} catch {
  /* no passwd entry (some containers) — fall through to the scratch branch */
}
const usingCallerHome = !!callerHome && callerHome !== loginHome;
const home = usingCallerHome ? callerHome : fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-proof-'));

// Belt and braces on the above: whichever branch we took, this HOME must not
// already hold a CrabCast socket. If it does, some other daemon owns it and the
// measurement would be about that peer rather than about the one this run
// starts — a green from the wrong daemon is the failure mode here.
if (!noPeer && fs.existsSync(path.join(home, '.local', 'share', 'crabcast', 'crabcast.sock'))) {
  console.error(`SETUP: ${home} already holds a CrabCast socket — refusing to measure another daemon's peer.`);
  console.error('       Nothing was measured.');
  process.exit(65);
}
const dataDir = path.join(home, '.local', 'share', 'crabcast');
const socketPath = path.join(dataDir, 'crabcast.sock');
const bin = path.join(home, 'shim-bin');
const shimState = path.join(home, 'shim-state');
for (const d of [dataDir, bin, shimState]) fs.mkdirSync(d, { recursive: true });

// A stateful `herdr` shim: `agent start` really adds a pane and `agent list`
// reports what was started, so the census CrabCast joins against is a
// measurement of what the proof actually caused rather than a fixture. This is
// the same shape CrabCast's own `verify` job uses for its daemons
// (.github/workflows/ci.yml, "Every script below that starts a daemon shims the
// `herdr` binary"), which is what makes "no herdr installed" true of this job in
// the sense KAN-117's AC1 means it.
const shimImpl = path.join(bin, 'herdr-shim.mjs');
fs.writeFileSync(
  shimImpl,
  `
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
`
);
fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(bin, 'herdr'), 0o755);

const configPath = path.join(home, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const env = {
  ...process.env,
  HOME: home,
  PATH: `${bin}:${process.env.PATH}`,
  CRABCAST_VERIFY_SHIM_STATE: shimState,
};

const waitForSocket = async (deadlineMs) => {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (fs.existsSync(socketPath)) {
      const ok = await new Promise((res) => {
        const s = net.connect(socketPath);
        s.once('connect', () => { s.destroy(); res(true); });
        s.once('error', () => res(false));
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

let daemon = null;
const daemonLog = [];

if (!noPeer) {
  daemon = spawn(process.execPath, [distDaemon, configPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', (c) => daemonLog.push(String(c)));
  daemon.stderr.on('data', (c) => daemonLog.push(String(c)));

  const up = await waitForSocket(30_000);
  if (!up) {
    // A SETUP GUARD, NOT A VERDICT — same reasoning as the missing checkout.
    console.error(`SETUP: the CrabCast daemon did not come up on ${socketPath} within 30s.`);
    console.error('       Nothing was measured — this is not a verdict about CrabCast.');
    console.error(daemonLog.join('').slice(-4000));
    daemon.kill('SIGKILL');
    process.exit(65);
  }
  console.log(`peer:  CrabCast from this PR's build, pid ${daemon.pid}, at ${socketPath}`);
  console.log(`herdr: shimmed at ${path.join(bin, 'herdr')} — nothing is installed on this runner`);
} else {
  console.log(`peer:  NONE (--no-peer). ${socketPath} deliberately does not exist.`);
}
console.log(`proof: ${path.relative(repoRoot, proofPath)}`);
console.log('');

const result = spawnSync(process.execPath, [proofPath], {
  env: noPeer ? env : { ...env, BUTCHR_CRABCAST_SOCKET: socketPath },
  // Butchr's proofs resolve their own repoRoot from their own location, so they
  // must run inside Butchr's tree. That is the whole reason this is a pinned
  // checkout rather than a vendored copy (docs/butchr-proof-import.md).
  cwd: path.join(checkout, 'daemon'),
  stdio: 'inherit',
  timeout: 15 * 60 * 1000,
});

if (daemon) {
  daemon.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 750));
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}
if (!usingCallerHome) fs.rmSync(home, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────────
// THE FAILURE OUTPUT NAMES THE CONSUMER BEHAVIOUR (KAN-519 task 3).
//
// "verify-crabcast-census-disclosure exited 1" tells a reader which file was
// unhappy and nothing about what broke. What they need is the sentence that
// says a consumer of CrabCast has stopped being served — so that is what is
// printed, and the script name is the citation rather than the headline.
// ─────────────────────────────────────────────────────────────────────────────
const entry = WIRED.find((w) => w.script === proofName);
const status = result.status;

console.log('');
if (status === 0) {
  console.log(`PASS  ${proofName}`);
  if (entry) console.log(`      still holds: ${entry.consumerBehaviour.replace(/\s+/g, ' ')}`);
} else if (result.error?.code === 'ETIMEDOUT' || result.signal) {
  console.log(`TIMEOUT/SIGNAL  ${proofName} — signal ${result.signal ?? '(none)'}, error ${result.error?.code ?? '(none)'}`);
  console.log('      Nothing was proved. This is a run that did not finish, not a verdict.');
} else {
  const verdict =
    status === 1 ? 'AN ASSERTION FAILED' :
    status === 2 ? 'INCOMPLETE — nothing failed, and something did not run' :
    `exited ${status}`;
  console.log(`FAIL  CrabCast consumer behaviour broke — ${verdict}`);
  if (entry) {
    console.log('');
    console.log(`      WHAT BROKE: ${entry.consumerBehaviour.replace(/\s+/g, ' ')}`);
    console.log(`      THE ARM THAT SAW IT: ${entry.gatingSection}`);
    console.log(`      PROVEN ABLE TO CATCH THIS: ${entry.redDrive.mutation}`);
    console.log(`                        produced: ${entry.redDrive.result}`);
    console.log('');
    if (status === 2) {
      console.log('      ⚠ AN INCOMPLETE IS A FAILURE OF THIS JOB, DELIBERATELY. It means the live');
      console.log('        arm — the only one that can notice CrabCast — did not run, so a green here');
      console.log('        would be a gate that had silently downgraded to nothing. The usual cause is');
      console.log('        that the peer this job starts did not come up or was not reached.');
    }
  }
  console.log(`      cited in: scripts/butchr-proof-import-registry.mjs (WIRED: ${proofName})`);
}

process.exit(status === null ? 70 : status);
