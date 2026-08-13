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
// AND (KAN-323) §8 catches a failure of this script's own housekeeping: a
// daemon left running under this run's scratch root when the script exits.
// That is not hypothetical and it is not about the pristine build. Driving §3
// red requires a mutation that makes `crabcast daemon` spawn detached — red
// drive 2 on PR #74 — and under it the daemon is a GRANDCHILD: the child this
// script holds exits 0, `started` has nothing left to kill, and the daemon
// serving on the scratch socket outlives the run. Measured on 2026-08-11:
// `pid 538617` still listening on
// `/tmp/crabcast-fg-hsd8WC/one/.crabcast/crabcast.sock` twenty-eight minutes
// after the run finished; reproduced at `197dd46` on 2026-08-12 as `pid
// 1533487` on `/tmp/crabcast-fg-abDNiK/one/.crabcast/crabcast.sock`. Harmless
// in itself — its own scratch dataDir, its own socket — and the cost is a
// later reader's false lead, because a stray process answering on a path
// ending `crabcast.sock` is exactly what a socket check trips over. They also
// accumulate, one per mutation run, unbounded.
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
// NOTHING HERE OBSERVES A REBOOT, and nothing in CI ever will: a GitHub
// runner has no user session bus. That has not changed and is not what moved.
//
// WHAT MOVED (KAN-345): the claim itself was PREDICTED until 2026-08-12, when
// the machine this was developed on rebooted cleanly and `crabcast.service`
// came back by itself eleven seconds later — `ActiveState=active`,
// `MainPID=872`, `NRestarts=0`, socket present. So reboot survival is now
// OBSERVED ONCE, out of band, on one machine, after a clean shutdown rather
// than a crash. `docs/supervision.md` carries that observation with its date
// and its limits, and §7 below guards the SHAPE of that claim.
//
// The distinction that matters here: THIS SCRIPT still covers none of it.
// One observation is evidence, not a guarantee, and it was not taken by
// anything in this repository — see §7's own comment for what its guard can
// and cannot detect.
//
// WHO COVERS THE REST: nobody, and it is named rather than implied. A real
// `systemctl --user start` under a real unit is a manual step; the transcript
// of one goes on the PR for KAN-322, and the reboot observation on the PR for
// KAN-345, rather than into CI.
//
// §7 is the guard against this document and the code drifting apart: it reads
// the ExecStart out of docs/supervision.md and requires the command it names
// to be one this CLI actually has, and it holds the reboot claim to the shape
// of its evidence. A unit template in prose is exactly the artifact that rots
// silently — and KAN-345 is the case where the PROSE was right and the GUARD
// was the stale artifact.
//
// ---------------------------------------------------------------------------
// §8 STAGES ITS OWN SURVIVOR, AND THAT IS THE EDGE OF WHAT IT COVERS (KAN-323).
//
// On the pristine build every daemon here is a direct child, so the reaper
// §8 guards would have nothing to catch and "no survivors" would be true of a
// run that never risked one — the vacuous pass this suite exists to distrust.
// So §8 stages a survivor of the shape the mutation produces: an intermediate
// process that spawns `dist/daemon.js` detached and exits, leaving a daemon
// that is nobody's child and is not in `started`. It then runs the same reaper
// the teardown runs, and ASSERTS nothing answers on any scratch socket and no
// process under this run's scratch root is left on the process table.
//
// WHAT THAT LEAVES UNCOVERED, named rather than implied: §8 supplies its own
// survivor, so it proves the reaper catches one — not that red drive 2's
// grandchild takes the same route. Nothing in this file can cover that, because
// the mutation is a source edit applied by hand and is not in the repository.
// WHO COVERS IT: the PR that applies the mutation, by pasting the process-table
// count taken after the run. Before this change that count was 1; the PR for
// KAN-323 records it at 0 over five consecutive mutated runs. There is no
// standing check, and there will not be one while the mutation lives in prose.
//
// A DIFFERENT FAILURE, DELIBERATELY NOT FIXED HERE: an INTERRUPTED run.
// `process.on('exit')` does not fire for SIGINT, so Ctrl-C during a run still
// leaves whatever was up. That is the subject of
// `verify-proof-cleans-up-when-interrupted.mjs`, whose target is
// `verify-send-confirms-delivery.mjs` and not this script — so the gap is real
// and is named here rather than half-closed with a handler nobody has watched
// go red.
//
// No herdr and no network: nothing below activates an agent. Every child runs
// under a scratch $HOME, so the DEFAULT data dir this script reasons about in
// §1 is a scratch one and never the machine's real ~/.local/share/crabcast —
// which on a developer box may well have a live daemon in it.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

// ------------------------------------------------------------------ reaping
//
// KAN-323. Killing the children in `started` is not the same job as leaving
// nothing running, and the difference is a whole process: a daemon this script
// caused to exist but never fathered is invisible to every handle here. So the
// instrument is the PROCESS TABLE, filtered by this run's scratch root — which
// `mkdtempSync` makes unique, so nothing below can match a process this run did
// not cause. The idiom, and the reason for the canary under it, are
// `verify-proof-cleans-up-when-interrupted.mjs`'s.

/** Sleep without an await, so the same reaper serves `process.on('exit')`. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Pids of this repo's node entrypoints whose command line names this run's
 * scratch root.
 *
 * TWO CONDITIONS, and the second is not belt-and-braces. Anchoring on the full
 * scratch path is what keeps a scratch socket from being confused with the
 * machine's real one — but a path substring matches ANY process that merely
 * mentions it, a shell included, and this list is a kill list. Measured while
 * writing this section: a `bash -c` line that named the scratch root was
 * counted as a survivor by a hand-run version of exactly this match. So a row
 * also has to BE one of the two programs this script starts, read off `argv[1]`
 * where a shell cannot put it.
 */
function processesUnderScratch() {
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(scratch))
    .filter((line) => /dist\/(daemon|cli)\.js$/.test(line.split(/\s+/)[2] ?? ''))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
}

/** That `ps` is answering at all, so a zero from it is a measurement. */
function psWorks() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').length > 5;
  } catch {
    return false;
  }
}

/**
 * SIGTERM everything under the scratch root, then SIGKILL what is left.
 *
 * SIGTERM first because §4 is the assertion that it is a clean stop — a reaper
 * that reaches for SIGKILL immediately would leave the socket file behind and
 * make this script's own debris look different from the debris it is judging.
 * Returns whatever is STILL running, so the caller asserts on a measurement
 * rather than on the fact that the calls were made.
 */
function reapScratchProcesses(waitMs = 5_000) {
  let pids = processesUnderScratch();
  if (pids.length === 0) return [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    pids = processesUnderScratch();
    if (pids.length === 0) return [];
    sleepSync(100);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  sleepSync(500);
  return processesUnderScratch();
}

process.on('exit', () => {
  for (const child of started) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {}
  }
  // The backstop, not the mechanism: §8 reaps and then asserts, so by the time
  // this runs there is normally nothing left. It is what covers a run that
  // threw before reaching §8.
  try {
    reapScratchProcesses(2_000);
  } catch {}
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

/** Every dataDir this run has pointed a daemon at, for §8 to sweep. */
const managed = [];

function makeConfig(name) {
  const dir = path.join(scratch, name);
  const dataDir = path.join(dir, '.crabcast');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'crabcast.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const cfg = { name, dir, dataDir, configPath, socket: path.join(dataDir, 'crabcast.sock') };
  managed.push(cfg);
  return cfg;
}

/**
 * How many times a daemon was positively observed answering on a scratch
 * socket. §8's anti-vacuity precondition: a sweep that finds no survivors
 * proves nothing about a run where nothing was ever up to survive.
 */
let listenersObserved = 0;

/**
 * Who is serving on `cfg`'s socket, asked over that socket.
 *
 * `daemon-status` is the right question and the safe one: `spawnsDaemon` is
 * false for it, so asking cannot create the thing it is asking about. The
 * `data dir:` cross-check is the path anchoring again — a pid this script is
 * willing to signal has to have said, on the socket inside this run's own
 * scratch root, that it is serving that dataDir.
 */
function daemonOnSocket(cfg) {
  const r = cli(['daemon-status', '--config', cfg.configPath], { timeout: 30_000 });
  const out = r.stdout ?? '';
  const pid = Number((out.match(/pid:\s+(\d+)/) ?? [])[1]);
  const dataDir = ((out.match(/data dir:\s+(.+)/) ?? [])[1] ?? '').trim();
  const mine = r.status === 0 && Number.isFinite(pid) && dataDir === cfg.dataDir;
  if (mine) listenersObserved += 1;
  return { exit: r.status, pid, dataDir, mine };
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

const status = daemonOnSocket(one);
check(status.exit === 0, '`daemon-status` answers over that socket', `exit ${status.exit}`);

// THE distinguishing assertion. A detached spawn would also produce a working
// socket; what makes this a foreground process a supervisor can own is that
// the daemon's pid IS the child this script is holding.
const reportedPid = status.pid;
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
const afterRace = daemonOnSocket(one);
const afterPid = afterRace.pid;
check(
  afterRace.exit === 0 && afterPid === incumbent.pid,
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
// ---------------------------------------------------------------- KAN-345
// The reboot claim is pinned to the SHAPE OF ITS EVIDENCE, not to a word.
//
// What this replaces: `check(/predicted|not observed/i.test(doc), 'and it
// states that reboot survival is predicted rather than observed')`.
//
// That guard existed for a real risk — an honest caveat being quietly
// upgraded to a guarantee — and it worked by requiring the word "predicted"
// somewhere in the file. It had TWO independent defects, and the second was
// only found while fixing the first:
//
//   1. It could hold the claim at "predicted" AND NOWHERE ELSE. The page
//      itself nominated the two commands that would turn the prediction into
//      an observation; on 2026-08-12 they were run and they answered. From
//      that moment the guard defended the stale claim, and a contributor
//      writing the true sentence could be told they had broken the build —
//      with the cheapest way back to green being to put the false sentence
//      back. A guard whose only expressible verdict is "predicted" has no way
//      to hold the page at "observed, on this date, with these limits".
//
//   2. It tested the WHOLE FILE for a word, so it was coupled to nothing in
//      particular. Measured against the corrected page rather than assumed
//      (the three runs are in KAN-345's PR): the section's own heading
//      `## What is predicted and what is observed` satisfies it, and so does
//      any sentence QUOTING the retired wording. Both of those pass while
//      printing a verdict that is now false. It goes red only for a
//      correction that happens to drop the vocabulary everywhere.
//
// So it was simultaneously too loose to constrain the claim and too tight to
// let it move. What follows constrains the claim and lets it move: the
// reboot paragraph must open with a status label from a closed vocabulary,
// an observation must date itself and the section must carry its limits, and
// no sentence may assert the survival as settled. BOTH states are sayable,
// which is the point — the honest page is the one that passes most easily,
// whichever way the world has gone.
//
// WHAT THIS CANNOT DETECT, named rather than implied. It enforces the FORM of
// the claim and never its truth: `**Observed once, on 2099-01-01**` satisfies
// every check below, because nothing here reboots anything and no check in
// this repository can — a GitHub runner has no user session bus. It reads
// only this one section, so an overclaim in prose elsewhere on the page is
// outside it. And "asserted" is decided per sentence by looking for a
// negation in the same sentence, so an overclaim spread across two sentences
// ("Is it handled? Yes.") is not caught.
//
// ---------------------------------------------------------------------------
// WHERE EACH CLAIM CHECK ACTUALLY LOOKS (KAN-349). The four checks below read
// as four independent constraints on the observation, and they are not. Every
// one of them tests `rebootSection` — the WHOLE section — so which of them can
// see the EVIDENCE is a property of how this page happens to be written rather
// than of the check. Measured by `scripts/kan349-red-drive.mjs` at `a9e9565`,
// where `docs/supervision.md` and this section are byte-identical to what
// KAN-345 landed at `5b5a200`:
//
//   * the STATUS LABEL check reads the label, by construction.
//   * `not a guarantee` and `once` both sit INSIDE the label sentence —
//     "**Observed once, on 2026-08-12, and not a guarantee:**" — so the
//     GUARANTEE and NARROWNESS checks are satisfied by the label they sit
//     beside. Delete every paragraph after the claim and keep the label, and
//     both still pass; the section reads 1054 chars and only the commands
//     check goes red. That is the mutation `epic/KAN-59` ran reviewing #81.
//   * the COMMANDS check is the only one that can read anything outside the
//     label, and it reads the SECTION rather than the evidence. The section's
//     closing paragraph recommends the same two commands for a FUTURE reboot,
//     so it is satisfied by advice as readily as by evidence: delete the two
//     EVIDENCE paragraphs and keep that closing one and ALL FOUR are green,
//     the section reads 1273 chars, and the whole proof exits 0.
//
// SO THE HONEST STATEMENT is that three of the four are satisfied by the label
// sentence and the fourth by any paragraph in the section that names one of
// three commands. NONE of them binds the evidence. The only thing standing
// between this guard and an evidence-free page is the vacuity floor above —
// and 1273 chars of label and advice clears it.
//
// LEFT AS IT IS, DELIBERATELY, and the reasoning is the record KAN-349 asked
// for rather than a preference. Requiring the caveats IN THE LABEL is a
// defensible design and probably the right one: a reader meets the label
// first, and KAN-345's whole point was that the honest page should be the one
// that passes most easily. Two tightenings were considered and both were
// refused for the same reason. (a) Reading the caveats from the section MINUS
// the claim paragraph reds the pristine page — "not a guarantee" appears
// nowhere else, which `kan349-red-drive.mjs`'s calibration C shows by deleting
// it from the label alone and watching the check go red. That is a red at a
// maintainer who did nothing wrong — the failure `verify-proof-defences.mjs`
// twice calls the worse one when it declines to gate cardinals under ten — and
// it is the opposite of KAN-345's stated design goal, that the honest page be
// the one that passes most easily. (b) Requiring a substantial
// evidence region after the claim needs a length floor chosen to sit above the
// one paragraph that happened to defeat the commands check, which is a check
// drawn from its own mutation's vocabulary — the defect this epic keeps
// finding, applied one level down inside the fix for it.
//
// WHO COVERS THE GAP: nobody, and there is no standing check for it. It is
// named here, in the PROOF_DEFENCES entry, and reproduced on demand by
// `scripts/kan349-red-drive.mjs`, which is a demonstration rather than a gate.
// ---------------------------------------------------------------------------

/**
 * The body of one `##` section, heading line excluded. Everything below reads
 * this slice, which is exactly why it is asserted on rather than trusted:
 * see the two checks immediately after it.
 */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

const REBOOT_HEADING = 'What is predicted and what is observed';
const rebootSection = sectionBody(doc, REBOOT_HEADING);

// VACUITY, first because every check after it reads that slice. A renamed or
// deleted heading makes it the empty string, and an empty string satisfies
// the NEGATIVE check at the bottom of this block without one word of the
// document being right. Starving the helper has to go red HERE.
check(
  rebootSection.length > 500,
  `the "${REBOOT_HEADING}" section is present and substantial`,
  `${rebootSection.length} chars`
);

// The other direction on the same helper, because a slice that had widened to
// the whole document would also make the checks below pass too easily.
check(
  rebootSection.length > 0 && !/^##\s/m.test(rebootSection),
  'and the slice is that section only — no other heading fell into it'
);

// The claim this section exists to keep honest. Finding it by what it CLAIMS
// rather than by how it is labelled is deliberate: the label is the thing
// under test below, so matching on the label would make that test circular.
const rebootParas = rebootSection
  .split(/\n\s*\n/)
  .map((p) => p.trim())
  .filter((p) => /after an actual reboot|comes back with a working socket/i.test(p));

check(
  rebootParas.length > 0,
  'it still makes the reboot-survival claim explicitly',
  `${rebootParas.length} paragraph(s)`
);

const claim = rebootParas[0] ?? '';

// The status label, from a closed vocabulary. This is the replacement for
// "the word predicted must appear": the claim must say WHICH IT IS, and an
// observation must date itself. A paragraph that just asserts the survival
// with no label matches neither and fails.
const isPredicted = /^\*\*Predicted, not observed[:*]/.test(claim);
const observedOn = (claim.match(/^\*\*Observed\b[^*]*?\bon (\d{4}-\d{2}-\d{2})\b/) ?? [])[1];

check(
  isPredicted || Boolean(observedOn),
  'and the claim opens with a status label saying which it is — predicted, or observed on a date',
  isPredicted
    ? 'predicted, not observed'
    : observedOn
      ? `observed on ${observedOn}`
      : `unlabelled: ${claim.slice(0, 60)}…`
);

// An observation has to carry what makes it one, and its edges. These run
// only when the page claims one, which is what lets the claim move without
// the guard having to be rewritten again.
//
// READ THE HAYSTACK BEFORE READING THE LABELS (KAN-349): all three test
// `rebootSection`, and on the current page the first two match INSIDE the
// label sentence and the third matches a closing paragraph of advice. They
// constrain the LABEL's completeness; none of them binds the evidence. The
// header block "WHERE EACH CLAIM CHECK ACTUALLY LOOKS" has the measurement and
// the reasons this was left as it is — read it before tightening any of them.
if (observedOn) {
  check(
    /not a guarantee/i.test(rebootSection),
    'an observation is stated as evidence rather than a guarantee'
  );
  check(
    /\bonce\b|\bone reboot\b|\bone machine\b/i.test(rebootSection),
    'and says how narrow it is — one observation, one machine'
  );
  check(
    /NRestarts|systemctl --user|daemon-status/.test(rebootSection),
    'and names the commands it was taken with'
  );
}

// The ORIGINAL risk, still guarded — now on the claim rather than on a word.
// The negation carve-out is load-bearing rather than a convenience: this page
// has always warned against the word "handled" in those very words, so what
// is banned is the ASSERTION, not the mention.
const OVERCLAIM = /\b(guaranteed|handled|supported|bulletproof|foolproof)\b/i;
const NEGATED = /\b(not|never|no|isn't|doesn't|don't|rather than|until|unless)\b/i;
const asserted = rebootSection
  .split(/(?<=[.!?])\s+/)
  .filter((s) => OVERCLAIM.test(s) && !NEGATED.test(s));

check(
  asserted.length === 0,
  'and no sentence asserts reboot survival is handled, guaranteed or supported',
  asserted.length ? `asserted: ${asserted[0].slice(0, 70)}…` : 'no guarantee asserted'
);

// ------------------------------------------- 8. this proof leaves nothing up

rule('8. NOTHING IS STILL RUNNING UNDER THIS RUN’S SCRATCH ROOT');

// The instrument first. An absence read off a `ps` that did not answer is the
// same false negative this suite keeps finding, so the zero below has to be a
// measurement before it is allowed to be a verdict.
check(psWorks(), 'CANARY: the process table is readable, so a zero from it means zero');

// And the vacuity precondition, in the shape KAN-330 used: a sweep for
// survivors over a run that never had a daemon up would pass with nothing
// behind it. §3 and §5 asked `daemon-status` on a scratch socket and got a pid;
// this is that count.
check(
  listenersObserved > 0,
  'PRECONDITION: a daemon really was serving on a scratch socket earlier in this run',
  `${listenersObserved} observation(s)`
);

// A survivor of the shape red drive 2 produces: an intermediate that spawns the
// daemon detached and exits, so the daemon is nobody's child. `dist/daemon.js`
// detached with `unref()` is what `spawnDaemon` (src/ipc.ts) does on every
// client verb, which is what that mutation makes `crabcast daemon` do too.
const three = makeConfig('three');
const spawnerPath = path.join(scratch, 'detach-and-exit.mjs');
fs.writeFileSync(
  spawnerPath,
  `import { spawn } from 'node:child_process';\n` +
    `const child = spawn(process.execPath, [process.argv[2], process.argv[3]], ` +
    `{ detached: true, stdio: 'ignore' });\n` +
    `child.unref();\n`
);
const spawner = spawnSync(
  process.execPath,
  [spawnerPath, path.join(repoRoot, 'dist', 'daemon.js'), three.configPath],
  { encoding: 'utf8', env: ENV, cwd: scratch, timeout: 30_000 }
);
check(spawner.status === 0, 'the intermediate that detaches the daemon exits', `exit ${spawner.status}`);
check(await waitFor(() => fs.existsSync(three.socket)), 'and an orphaned daemon is serving', three.socket);

const orphan = daemonOnSocket(three);
const trackedPids = started.map((c) => c.pid);
check(
  orphan.mine && !trackedPids.includes(orphan.pid),
  'PRECONDITION: it is a survivor `started` cannot reach — the case the child handles miss',
  `pid ${orphan.pid}; started holds ${JSON.stringify(trackedPids)}`
);

// The reaper, and then the measurement. This is the assertion the ticket asked
// for: not "the cleanup ran" and not "the code says nothing should be left",
// but the process table and the sockets, read after the sweep.
const survivors = reapScratchProcesses();
check(
  survivors.length === 0,
  'REAPED: nothing under this run’s scratch root is left on the process table',
  `survivors ${JSON.stringify(survivors)}`
);

const answering = managed.filter((cfg) => daemonOnSocket(cfg).mine);
check(
  answering.length === 0,
  'and nothing answers on any socket this run created',
  answering.map((cfg) => cfg.socket).join(', ')
);

// -------------------------------------------------------------------- verdict

// Order matters: reaping happens above, while the sockets still exist to be
// asked. Removing the scratch root first would unlink them and leave a live
// daemon holding a socket nothing on disk can find — measured on 2026-08-12,
// where `rmSync` succeeded and `pid 1533487` went on listening on the deleted
// path.
try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch {}

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
