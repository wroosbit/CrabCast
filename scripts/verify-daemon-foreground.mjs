#!/usr/bin/env node
// Live proof for KAN-322: a supervisor can own a CrabCast daemon, because
// there is a foreground entrypoint reachable BY NAME — `crabcast daemon`.
//
// WHAT FAILURE THIS WOULD CATCH: the gap KAN-320 found on this machine's first
// shared bring-up — CrabCast spawns a daemon only from a client, detached, and
// only from one of five write verbs with a loadable config, so after a reboot
// there is no client, nothing spawns anything, and the socket is simply absent
// with nothing saying so. It lasted eight days. §1 reproduces exactly that,
// against the current build, so the rest of this file is not asserting into a
// vacuum; §3 shows the entrypoint that answers it actually serving.
//
// It would also catch the narrower regression that reintroduces the gap while
// looking fine: `crabcast daemon` losing its config hand-off and reading
// `process.argv[2]` again (which on this path is the string "daemon"), or the
// command quietly becoming a detached spawn — §3 pins the daemon's own pid to
// the child this script started, which a detached spawn cannot satisfy.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED (KAN-170).
//
// Every daemon below is started BY THIS SCRIPT, so this script is the
// supervisor. That covers the contract a supervisor needs — a foreground
// process that serves, exits 0 on SIGTERM, releases its socket, refuses
// non-zero on a bad config, and does not thrash when it loses a race — and it
// does NOT cover systemd itself running any of it, nor a real boot.
//
// NOTHING HERE OBSERVES A REBOOT, and nothing can: the machine this was
// developed on runs a live fleet. Reboot survival is PREDICTED from the links
// below being individually true, not observed. `docs/supervision.md` states
// the same limit in the same words, and that is deliberate — the honest
// version of this claim has to survive in the document a user reads, not only
// in the proof a contributor runs.
//
// WHO COVERS THE REST: nobody yet, and it is named rather than implied.
// A real `systemctl --user start` under a real unit is a manual step; the
// transcript of one goes on the PR for KAN-322 rather than into CI, because a
// GitHub runner has no user session bus.
//
// §7 is the guard against this document and the code drifting apart: it reads
// the ExecStart out of docs/supervision.md and requires the command it names
// to be one this CLI actually has. A unit template in prose is exactly the
// artifact that rots silently.
//
// No herdr and no network: nothing below activates an agent. Every child runs
// under a scratch $HOME, so the DEFAULT data dir this script reasons about in
// §1 is a scratch one and never the machine's real ~/.local/share/crabcast —
// which on a developer box may well have a live daemon in it.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function rule(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

if (!fs.existsSync(cliJs)) {
  console.error(`SETUP: ${cliJs} is missing — run \`npm run build\` first.`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-fg-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// Every child gets this. HOME is what DEFAULT_DATA_DIR is derived from, so
// pinning it is what keeps §1 away from the real machine's daemon.
const ENV = { ...process.env, HOME: fakeHome, CRABCAST_CONFIG: '' };
delete ENV.CRABCAST_CONFIG;

const defaultDataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const defaultSocket = path.join(defaultDataDir, 'crabcast.sock');

const started = [];
process.on('exit', () => {
  for (const child of started) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {}
  }
});

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    env: ENV,
    cwd: opts.cwd ?? scratch,
    timeout: opts.timeout ?? 60_000
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

/** Start `crabcast daemon` in the foreground and return the child. */
function startForeground(configPath, label) {
  const outFile = path.join(scratch, `${label}.out`);
  const fd = fs.openSync(outFile, 'a');
  const child = spawn(process.execPath, [cliJs, 'daemon', '--config', configPath], {
    env: ENV,
    cwd: scratch,
    stdio: ['ignore', fd, fd]
  });
  child.outFile = outFile;
  started.push(child);
  return child;
}

function makeConfig(name) {
  const dir = path.join(scratch, name);
  const dataDir = path.join(dir, '.crabcast');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'crabcast.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { dir, dataDir, configPath, socket: path.join(dataDir, 'crabcast.sock') };
}

// ---------------------------------------------------------------- 1. the gap

rule('1. THE GAP IS REAL — with no config named, nothing brings a socket back');

check(
  !fs.existsSync(defaultSocket),
  'PRECONDITION: the scratch default data dir has no socket',
  defaultSocket
);

// The five write verbs are the only spawners, and `resolveTarget` refuses to
// spawn into a data dir nobody named. So with no config anywhere, a WRITE verb
// does not produce a daemon either — which is the part that makes this a
// product gap rather than a missing unit file.
const writeVerbNoConfig = cli(['deactivate', path.join(scratch, 'nowhere')]);
check(
  !fs.existsSync(defaultSocket),
  'a WRITE verb with no config named spawns NOTHING into the default data dir',
  `exit ${writeVerbNoConfig.status}`
);
check(
  /no loadable config/.test(writeVerbNoConfig.stderr ?? ''),
  'and it says why on stderr rather than failing silently',
  (writeVerbNoConfig.stderr ?? '').trim().split('\n')[0]
);

const readVerbNoConfig = cli(['list']);
check(
  !fs.existsSync(defaultSocket) && readVerbNoConfig.status === 3,
  'a READ verb refuses with exit 3 and spawns nothing',
  `exit ${readVerbNoConfig.status}`
);

// This is the sentence a stranded operator actually needs, and before KAN-322
// it named a path inside a checkout or inside a global node_modules. On
// stderr, which is where the whole diagnostic goes — the README's transcript
// shows it interleaved with stdout because a terminal shows both.
check(
  /crabcast daemon/.test(readVerbNoConfig.stderr ?? ''),
  'the refusal names a foreground command the reader can actually run',
  ((readVerbNoConfig.stderr ?? '').match(/.*crabcast daemon.*/) ?? [''])[0].trim()
);

// ------------------------------------------------------- 2. it has a name

rule('2. THE ENTRYPOINT IS REACHABLE BY NAME, and is not a socket command');

const help = cli(['--help']);
check(help.status === 0, '`crabcast --help` exits 0');
check(
  /^\s+daemon\s/m.test(help.stdout ?? ''),
  '`daemon` is listed in --help'
);

const daemonHelp = cli(['daemon', '--help']);
check(daemonHelp.status === 0, '`crabcast daemon --help` exits 0');
check(
  /--config/.test(daemonHelp.stdout ?? ''),
  'its help names the flag that chooses the config'
);

// The socket-API parity check (verify-cli-parity) reconciles COMMANDS against
// the router's dispatch. A server command in that table would be a command
// with an action no router serves — so it must NOT be there, and this is what
// says so if somebody "tidies" the two tables into one.
const { COMMANDS, SERVER_COMMANDS } = await import(cliJs);
check(
  Array.isArray(SERVER_COMMANDS) && SERVER_COMMANDS.some((c) => c.name === 'daemon'),
  'it is exported in SERVER_COMMANDS'
);
check(
  !COMMANDS.some((c) => c.name === 'daemon'),
  'and NOT in COMMANDS, whose entries are socket actions the router dispatches'
);

// A stray positional is the expected mistake: `node dist/daemon.js <config>`
// took the config there, and this command replaces that invocation.
const stray = cli(['daemon', '/tmp/some-config.json']);
check(
  stray.status === 2 && /--config/.test(stray.stderr ?? ''),
  'a config passed as a positional is a usage error naming --config, not a silent drop',
  `exit ${stray.status}`
);

// ------------------------------------------------------------- 3. it serves

rule('3. IT RUNS IN THE FOREGROUND AND THE SOCKET ANSWERS');

const one = makeConfig('one');
const fg = startForeground(one.configPath, 'fg1');

const cameUp = await waitFor(() => fs.existsSync(one.socket));
check(cameUp, 'the socket appears', one.socket);
check(
  fg.exitCode === null,
  'and the foreground process is still running — it did not detach and exit',
  `exitCode ${fg.exitCode}`
);

const status = cli(['daemon-status', '--config', one.configPath]);
check(status.status === 0, '`daemon-status` answers over that socket', `exit ${status.status}`);

// THE distinguishing assertion. A detached spawn would also produce a working
// socket; what makes this a foreground process a supervisor can own is that
// the daemon's pid IS the child this script is holding.
const reportedPid = Number(((status.stdout ?? '').match(/pid:\s+(\d+)/) ?? [])[1]);
check(
  reportedPid === fg.pid,
  'the daemon reporting on that socket IS the foreground child',
  `daemon says pid ${reportedPid}; the child this script started is ${fg.pid}`
);

// ------------------------------------------------ 4. the supervisor contract

rule('4. SIGTERM IS A CLEAN STOP — exit 0, and the socket is released');

fg.kill('SIGTERM');
const exited = await waitFor(() => fg.exitCode !== null || fg.signalCode !== null);
check(exited, 'it exits on SIGTERM');
check(
  fg.exitCode === 0,
  'with status 0, so a supervisor does not read a normal stop as a crash',
  `exitCode ${fg.exitCode}, signal ${fg.signalCode}`
);
check(
  await waitFor(() => !fs.existsSync(one.socket), 5_000),
  'and it removes its socket, leaving nothing stale behind'
);

// ------------------------------------------------- 5. the restart-policy race

rule('5. A SECOND DAEMON LOSES CLEANLY — the measurement behind Restart=on-failure');

const incumbent = startForeground(one.configPath, 'fg2');
check(await waitFor(() => fs.existsSync(one.socket)), 'an incumbent is serving again');

const loser = cli(['daemon', '--config', one.configPath], { timeout: 30_000 });
check(
  loser.status === 0,
  'a second `crabcast daemon` on the same dataDir exits 0 — a CLEAN loss, not a crash',
  `exit ${loser.status}`
);
// This is the whole reason the shipped unit says on-failure. Under
// Restart=always this exit-0 loser is restarted every RestartSec forever,
// against a socket it can never win, and nothing anywhere goes red.
check(
  /already running/.test(loser.stderr ?? ''),
  'and it SAYS so on stderr — the stream a supervisor journals and an operator watches',
  (loser.stderr ?? '').trim().split('\n')[0]
);
check(
  incumbent.exitCode === null,
  'the incumbent is untouched by the attempt'
);
const afterRace = cli(['daemon-status', '--config', one.configPath]);
const afterPid = Number(((afterRace.stdout ?? '').match(/pid:\s+(\d+)/) ?? [])[1]);
check(
  afterRace.status === 0 && afterPid === incumbent.pid,
  'and it is still the one serving',
  `pid ${afterPid} vs incumbent ${incumbent.pid}`
);

incumbent.kill('SIGTERM');
await waitFor(() => incumbent.exitCode !== null);

// -------------------------------------------------- 6. a bad config refuses

rule('6. A CONFIG THAT WILL NOT LOAD IS A VISIBLE, NON-ZERO REFUSAL');

const missing = cli(['daemon', '--config', path.join(scratch, 'no-such-config.json')], {
  timeout: 30_000
});
check(
  missing.status !== 0,
  'it refuses non-zero, so a supervisor sees a failure rather than a silent no-op',
  `exit ${missing.status}`
);
check(
  /refusing to start/.test(missing.stderr ?? ''),
  'and names the refusal on stderr',
  (missing.stderr ?? '').trim().split('\n')[0]
);

const two = makeConfig('two');
fs.writeFileSync(two.configPath, '{ this is not json');
const broken = cli(['daemon', '--config', two.configPath], { timeout: 30_000 });
check(
  broken.status !== 0 && !fs.existsSync(two.socket),
  'a malformed config is refused BEFORE the socket is created',
  `exit ${broken.status}`
);

// ------------------------------------------- 7. the documented unit is real

rule('7. THE UNIT TEMPLATE IN docs/supervision.md NAMES A COMMAND THAT EXISTS');

const docPath = path.join(repoRoot, 'docs', 'supervision.md');
check(fs.existsSync(docPath), 'docs/supervision.md exists', docPath);
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';

const execStart = (doc.match(/^ExecStart=(.+)$/m) ?? [])[1];
check(Boolean(execStart), 'it carries an ExecStart line', execStart ?? '(none)');
if (execStart) {
  // The point of reading it out of the document: a template that names a verb
  // the CLI does not have is a file a user pastes into systemd and gets a
  // failed unit from, and prose cannot go red on its own.
  const verb = (execStart.match(/crabcast(?:\s+|-)([a-z-]+)/) ?? [])[1];
  check(
    SERVER_COMMANDS.some((c) => c.name === verb),
    `the verb its ExecStart runs (\`${verb}\`) is a real server command`
  );
}

// The restart policy and its reason must both be in the document. The setting
// without the reasoning is what KAN-320 warned against: a supervisor that
// silently restarts a broken thing is another green light over a failure.
check(/Restart=on-failure/.test(doc), 'it specifies Restart=on-failure');
check(
  /StartLimitBurst=/.test(doc) && /StartLimitIntervalSec=/.test(doc),
  'and bounds a genuine crash-loop so it lands somewhere visible'
);
check(
  /always/.test(doc) && /race|loser|incumbent/i.test(doc),
  'and explains why NOT Restart=always, naming the race that makes it wrong'
);
check(
  /Environment=PATH=/.test(doc),
  'it pins PATH — the daemon resolves `herdr` off it and a bad PATH fails every activation while looking healthy'
);
check(
  /predicted|not observed/i.test(doc),
  'and it states that reboot survival is predicted rather than observed'
);

// -------------------------------------------------------------------- verdict

try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch {}

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
