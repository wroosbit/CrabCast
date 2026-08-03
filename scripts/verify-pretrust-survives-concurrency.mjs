// Live proof (ported from the extraction source's KAN-54): the pre-trust
// write to ~/.claude.json survives concurrent activations and competing
// writers, is verified before the spawn, and a clobber that will not repair
// refuses the activation honestly instead of answering `success: true` with
// an agent wedged on the folder-trust dialog.
//
// Everything here runs against real processes: a real daemon from dist/, a
// private herdr server, real panes. Isolation is by $HOME, an explicit
// scratch dataDir in the config, and HERDR_SOCKET_PATH; the live daemon and
// the live herdr are never contacted. The one stand-in is the `claude`
// binary itself: a stub that sleeps is placed on the daemon's PATH, because
// a *real* claude booting against the temp HOME would rewrite ~/.claude.json
// from its own in-memory state — that behaviour is the KAN-54 incident, it
// was reproduced separately with the real binary (see the comment above
// trustClaudeWorkspace in launchers.ts), and letting it loose here would
// make every stage nondeterministic. The competing writer is instead played
// by this script's clobber injector, which does to the file exactly what the
// reproduction showed claude doing: rewriting it without our entry.
//
// Usage:
//   npm run build
//   node scripts/verify-pretrust-survives-concurrency.mjs [--dist <dir>]
//
// Exit code 0 means every stage passed.

import { execFileSync, spawn } from 'child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync
} from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

const argv = process.argv.slice(2);
const distIdx = argv.indexOf('--dist');
const distDir = distIdx === -1 ? path.join(packageDir, 'dist') : path.resolve(argv[distIdx + 1]);

if (!existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`${distDir}/daemon.js is missing — run \`npm run build\` first.`);
  process.exit(1);
}

let realHerdr;
try {
  realHerdr = execFileSync('which', ['herdr'], { encoding: 'utf8' }).trim();
} catch {
  console.error('herdr is not on PATH; every stage here needs a real spawn. Nothing verified.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, env) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });

// Socket paths must fit sockaddr_un.sun_path (~108 bytes) — /tmp, not TMPDIR.
const scratch = mkdtempSync('/tmp/kan54-');
const fakeHome = path.join(scratch, 'home');
const herdrSocket = path.join(scratch, 'h.sock');
const herdrState = path.join(scratch, 'herdr-state');
const stubBin = path.join(fakeHome, '.local', 'bin');
mkdirSync(stubBin, { recursive: true });
mkdirSync(herdrState, { recursive: true });

// The stub agent binary. It must exist so the launcher command's `claude`
// resolves and the pane stays alive, and it must NOT be the real claude for
// the reason in the header. It sleeps; trust is what's under test, not the
// agent.
const stubClaude = path.join(stubBin, 'claude');
writeFileSync(stubClaude, '#!/bin/bash\n# KAN-54 verify stub: stands in for claude.\nsleep 600\n');
chmodSync(stubClaude, 0o755);
symlinkSync(realHerdr, path.join(stubBin, 'herdr'));

// The daemon under test loads a real config: a `task` type whose
// defaultLauncher is `claude` — the launcher whose setup writes the trust
// entry under proof.
const dataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const configPath = path.join(fakeHome, 'crabcast.config.json');
mkdirSync(path.join(fakeHome, 'prompts'), { recursive: true });
writeFileSync(path.join(fakeHome, 'prompts', 'task.md'), 'KAN-54 proof workspace {{KEY}}.\n');
writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: 'task', priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'claude' }
  ]
}, null, 2));

// SHELL=/bin/bash + HOME=fakeHome make the daemon's loginShellPath() resolve
// to bare system dirs (no real claude), so PATH lookups land on the stub.
const isolatedEnv = {
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${stubBin}:/usr/bin:/bin`,
  CRABCAST_CONFIG: configPath,
  HERDR_SOCKET_PATH: herdrSocket,
  XDG_CONFIG_HOME: path.join(herdrState, 'config'),
  XDG_STATE_HOME: path.join(herdrState, 'state')
};
mkdirSync(isolatedEnv.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(isolatedEnv.XDG_STATE_HOME, { recursive: true });

let daemon;
let herdrServer;
process.on('exit', () => {
  daemon?.kill('SIGKILL');
  herdrServer?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

const claudeConfigPath = path.join(fakeHome, '.claude.json');
const socketPath = path.join(dataDir, 'crabcast.sock');
const workDirFor = (key) => path.join(dataDir, 'workspaces', 'task', key.toLowerCase());

const readConfig = () => JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
const entryPresent = (key) => {
  try {
    return readConfig().projects?.[workDirFor(key)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};

/**
 * The competing writer. Watches ~/.claude.json and, whenever the target
 * workspace's trust entry appears, rewrites the file without it — the same
 * effect as a sibling claude's boot write-back from a snapshot taken before
 * the entry existed. `once` is the transient case (one write-back, like the
 * incident); without it the writer never stops, which no bounded retry can
 * beat and which must therefore end in an honest refusal.
 */
const startClobberer = (key, { once }) => {
  const target = workDirFor(key);
  let deletions = 0;
  const iv = setInterval(() => {
    try {
      const config = readConfig();
      if (config.projects && Object.prototype.hasOwnProperty.call(config.projects, target)) {
        delete config.projects[target];
        writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
        deletions++;
        if (once) clearInterval(iv);
      }
    } catch {
      // A read torn by the daemon's own rename loses one poll, nothing more.
    }
  }, 4);
  return { stop: () => clearInterval(iv), count: () => deletions };
};

// --- seed the config with unrelated user state --------------------------------
// The end-state checks prove these keys survive untouched: the write is
// add-only, not a replacement.
const seeded = {
  numStartups: 7,
  theme: 'dark',
  projects: {
    '/home/user/preexisting-project': { hasTrustDialogAccepted: true, history: [] }
  }
};
writeFileSync(claudeConfigPath, JSON.stringify(seeded, null, 2));

// --- a private herdr, so no pane can reach the live server --------------------
try {
  run('herdr', ['pane', 'list'], { ...process.env, ...isolatedEnv });
  console.error(`something is already answering on ${herdrSocket} — refusing to run`);
  process.exit(1);
} catch {
  // Nothing listening, which is what we want.
}
console.log(`starting a private herdr server on ${herdrSocket}`);
herdrServer = spawn(realHerdr, ['server'], {
  env: { ...process.env, ...isolatedEnv },
  detached: true,
  stdio: 'ignore'
});
let herdrUp = false;
for (let i = 0; i < 20 && !herdrUp; i++) {
  try {
    run('herdr', ['pane', 'list'], { ...process.env, ...isolatedEnv });
    herdrUp = true;
  } catch {
    await sleep(500);
  }
}
if (!herdrUp) {
  console.error('the private herdr server never came up. Nothing verified.');
  process.exit(2);
}

// --- the daemon under test -----------------------------------------------------
console.log(`starting a real daemon from ${distDir} with HOME=${fakeHome}`);
daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  // No process.env spread: the daemon must resolve its PATH from the crafted
  // environment, or the panes would find the real claude.
  env: isolatedEnv,
  stdio: ['ignore', 'ignore', 'inherit']
});

for (let i = 0; i < 60 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

const socket = net.connect(socketPath);
await new Promise((resolve) => socket.once('connect', resolve));

let buffer = '';
const pending = new Map();
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
let nextId = 0;
const call = (action, data = {}) =>
  new Promise((resolve) => {
    const id = `kan54-${++nextId}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

// `override: true`: the capacity gate measures the real machine, and whether
// this box is busy is not what is being proved. The override is recorded
// with the figures at the time, as it is for anyone.
const activate = (key) =>
  call('activate_by_key', { type: 'task', key, defaultAgent: 'claude', override: true });

const banner = (title) => {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
};
const results = [];
const record = (name, passed, note) => {
  results.push({ name, passed, note });
  console.log(`\n  ${passed ? 'PASS' : 'FAIL'}: ${name}${note ? ` — ${note}` : ''}`);
};
const summarize = (response) =>
  JSON.stringify(
    { success: response.success, verified: response.verified, error: response.error },
    null, 2
  );

// --- 1. before -----------------------------------------------------------------
banner('1. before — the seeded ~/.claude.json (unrelated user state)');
console.log(readFileSync(claudeConfigPath, 'utf8'));

// --- 2. the solo path ------------------------------------------------------------
banner('2. solo activation — one agent, nobody competing (the regression check)');
const solo = await activate('KAN54-SOLO');
console.log('activate_by_key →', summarize(solo));
record('a solo activation succeeds', solo.success === true, solo.error);
record(
  'its trust entry is in ~/.claude.json',
  entryPresent('KAN54-SOLO'),
  `projects['${workDirFor('KAN54-SOLO')}']`
);

// --- 3. N concurrent activations -------------------------------------------------
const BURST = ['KAN54-C1', 'KAN54-C2', 'KAN54-C3', 'KAN54-C4', 'KAN54-C5'];
banner(`3. ${BURST.length} concurrent activations — the incident's shape, no competing writer`);
const burst = await Promise.all(BURST.map((key) => activate(key)));
burst.forEach((r, i) => console.log(`${BURST[i]} →`, summarize(r)));
record(
  'every concurrent activation succeeds',
  burst.every((r) => r.success === true),
  burst.map((r, i) => `${BURST[i]}:${r.success}`).join(' ')
);
record(
  'every workspace has its trust entry',
  BURST.every(entryPresent),
  BURST.map((k) => `${k}:${entryPresent(k)}`).join(' ')
);

// --- 4. transient clobber ---------------------------------------------------------
banner('4. clobber injection, transient — one competing write-back erases the entry once');
const transient = startClobberer('KAN54-TRANSIENT', { once: true });
const transientResp = await activate('KAN54-TRANSIENT');
transient.stop();
console.log('activate_by_key →', summarize(transientResp));
console.log(`the injector clobbered the entry ${transient.count()} time(s)`);
record(
  'the clobber actually happened',
  transient.count() === 1,
  `${transient.count()} deletion(s)`
);
record(
  'the activation still succeeds — the write was retried',
  transientResp.success === true,
  transientResp.error
);
record(
  'the entry is present at the end',
  entryPresent('KAN54-TRANSIENT'),
  `projects['${workDirFor('KAN54-TRANSIENT')}']`
);

// --- 5. persistent clobber ----------------------------------------------------------
banner('5. clobber injection, persistent — a writer that never stops rewriting the file');
const hostile = startClobberer('KAN54-HOSTILE', { once: false });
const hostileResp = await activate('KAN54-HOSTILE');
hostile.stop();
console.log('activate_by_key →', summarize(hostileResp));
console.log(`the injector clobbered the entry ${hostile.count()} time(s)`);
record(
  'the activation fails honestly: success is false, not a wedged agent behind success: true',
  hostileResp.success === false,
  `success=${hostileResp.success}`
);
record(
  'the refusal names the trust file',
  typeof hostileResp.error === 'string' && hostileResp.error.includes('.claude.json'),
  hostileResp.error
);

// --- 6. after ------------------------------------------------------------------------
banner('6. after — ~/.claude.json, in full');
console.log(readFileSync(claudeConfigPath, 'utf8'));
let finalConfig = {};
try {
  finalConfig = readConfig();
} catch {}
record(
  'unrelated user state survived untouched',
  finalConfig.numStartups === 7 &&
    finalConfig.theme === 'dark' &&
    finalConfig.projects?.['/home/user/preexisting-project']?.hasTrustDialogAccepted === true,
  'numStartups, theme, preexisting project'
);

// --- verdict ---------------------------------------------------------------------------
banner('verdict');
for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? ` (${r.note})` : ''}`);
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

socket.end();
process.exit(failed.length === 0 ? 0 : 1);
