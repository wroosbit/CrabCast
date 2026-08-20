#!/usr/bin/env node
// KAN-504: a caller's `args` reach the spawned process — on BOTH invocations.
//
// WHAT FAILURE THIS WOULD CATCH: `args` put on only the cold-start branch of a
// launcher's command line, leaving every agent that already exists — which is
// every agent that RESUMES, the common path — without them, while appearing to
// work on any newly created agent somebody tests with. That is a green that
// cannot fail: the fresh branch is the one a test reaches by default, and the
// resumed branch is the one production runs. §2 is the section that would go
// red, and `scripts/kan504-red-drive.mjs` is the mutation that drives it there.
//
// It would also catch: a launcher that cannot carry args accepting them
// silently (§3); a change to argv accepted under a running agent, which would
// record arguments a live process was never given (§4); and argv vanishing from
// the surfaces an operator reads it off (§5).
//
// ---------------------------------------------------------------------------
// HOW §1 AND §2 MEASURE, because "it reaches the process" is exactly the claim
// a schema check will happily fake.
//
// The acceptance criterion is the LIVE PROCESS'S OWN COMMAND LINE, so that is
// what is read, from the kernel:
//
//   the herdr shim  really executes what CrabCast handed it — the `bash -c`
//                   argv after `--` — rather than recording it and returning
//                   success. So the command line under test is one that RAN.
//   a fake `claude` on PATH writes its own PID to a file and then sleeps,
//                   holding the process open.
//   this script     reads `/proc/<that pid>/cmdline` and asserts on THOSE
//                   bytes.
//
// ⚠ THE SPLIT MATTERS AND IS THE POINT: the fake claude says only WHICH
// process to look at; what that process's argv IS comes from the kernel. A
// script that trusted the child's own report of its `process.argv` would be
// asserting on a string the fixture composed — which is the schema check this
// criterion exists to rule out, wearing a live process's clothes.
//
// WHAT THIS DOES NOT PROVE, named rather than left to be assumed: that the real
// Claude Code binary does anything particular with the arguments it is handed.
// It cannot, and no proof here could — that is the runtime's behaviour, not
// CrabCast's. The claim bounded here is CrabCast's whole half: the bytes a
// caller froze onto a record are the bytes on the argv of the process CrabCast
// started. What the program does with them is between the caller and the
// program, which is the entire reason this field is generic argv rather than a
// flag CrabCast knows the meaning of.
//
// ---------------------------------------------------------------------------
// IT MUST NOT TOUCH THE RUNNING FLEET, and §6 is where it says so rather than
// where it hopes so. CrabCast is the live production runtime on the machine
// this was written on, so a proof that spawned into the real daemon could take
// somebody's session. Every daemon, socket, data dir, HOME, PATH and process
// here is scratch and under one temp root; §6 asserts the real one was never
// addressed and that this run left nothing of its own behind.
//
// Needs node and bash. No real herdr, no real claude, no network, no PTY.
//
// Usage:
//   npm run build
//   node scripts/verify-launcher-args.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { sweepScratchRoot, killScratchRootSync, describe } from './scratch-processes.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

function rule(title) {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

/**
 * The live fleet's registry mtime, taken BEFORE this proof does anything.
 *
 * Read at the top rather than in §6, because a baseline taken afterwards would
 * be a comparison against a value this run could already have changed — which
 * is a check that cannot fail. `null` when there is no live CrabCast on this
 * machine, and §6 says so in words rather than reporting a vacuous pass as a
 * measurement.
 */
const realAgentsLogMtimeAtStart = (() => {
  const f = path.join(os.homedir(), '.local', 'share', 'crabcast', 'agents.jsonl');
  try { return fs.statSync(f).mtimeMs; } catch { return null; }
})();

// --------------------------------------------------------------- the scratch
//
// ONE ROOT, so §6 can assert the whole footprint is inside it and remove it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan504-'));
const home = path.join(tmp, 'home');
const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
const shimState = path.join(tmp, 'shim-state');
const bin = path.join(tmp, 'bin');
for (const d of [home, shimState, bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

/**
 * The fake `claude` spawns this script makes by hand.
 *
 * ⚠ THIS IS NO LONGER WHAT §6 ASSERTS ON, and the distinction is the whole of
 * KAN-529. It is kept because the sections above genuinely want it — "this arm
 * produced a live process" is a claim about a pid — but as a TEARDOWN
 * population it was wrong in two directions at once: it missed the scratch
 * daemon and its `herdr agent attach` children entirely, and it did not even
 * hold every fake `claude`, because the pid a fixture reports is not the pid of
 * the `bash` wrapper that `exec`s toward it. §6 asks the machine instead. See
 * `scratch-processes.mjs`.
 */
const spawnedPids = new Set();

/**
 * CLEAN UP ON A SIGNAL TOO, and this one is not tidiness.
 *
 * The fake `claude` this proof spawns holds itself open with `sleep 600`, and
 * the scratch daemon holds itself open forever. On the ordinary path §6 sweeps
 * them and asserts they are gone — but a Ctrl+C, or a CI job hitting its
 * timeout, skips §6 entirely and would leave those processes and a scratch tree
 * behind on a machine other people are using. A proof whose failure mode is
 * litter on a shared box is a proof that gets disabled.
 *
 * Handlers rather than only a `finally`, because a signal does not run one.
 *
 * ⚠ SYNCHRONOUS, and `killScratchRootSync` says why: a handler that awaited
 * would call `process.exit` before the sweep it started had finished.
 */
function cleanUp() {
  let swept = 0;
  try { swept = killScratchRootSync(tmp); } catch {}
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return swept;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    // The count is printed AFTER the sweep because it is the sweep's own
    // answer — `spawnedPids.size` was what this line used to print, and it
    // named a population that was never the one being cleaned up.
    const swept = cleanUp();
    console.log(`\n[verify-launcher-args] ${signal} — killed ${swept} process(es) carrying ` +
      `${tmp} and removed it`);
    process.exit(130);
  });
}

/**
 * The fake `claude`.
 *
 * A BASH SCRIPT AND NOT AN `exec`, deliberately: it stays as the process it
 * was started as, so `/proc/<pid>/cmdline` holds the argv the launcher built.
 * An `exec` into something else would replace exactly the bytes under test.
 *
 * `--continue` exits 1 when there is no marker file, which is what the REAL
 * claude does in a directory with no history ("No conversation found to
 * continue") and what makes the launcher's `||` fallback reachable. §1 relies
 * on that failing; §2 relies on it succeeding.
 */
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
for a in "$@"; do
  if [ "$a" = "--continue" ]; then
    if [ ! -f "$CRABCAST_KAN504_CONVERSATION" ]; then
      echo "No conversation found to continue" >&2
      exit 1
    fi
  fi
done
echo $$ > "$CRABCAST_KAN504_PIDFILE"
sleep 600
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);

/**
 * The herdr shim — stateful, and it REALLY STARTS what it is given.
 *
 * `agent start` takes everything after `--` and spawns it detached. That is
 * the whole reason this script can read a live command line at all: a shim
 * that acknowledged the start without running it would leave every assertion
 * below about a string CrabCast composed rather than a process it created.
 */
const shimImpl = path.join(bin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
const state = process.env.CRABCAST_KAN504_SHIM_STATE;
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
  const cwd = cwdIdx === -1 ? process.cwd() : args[cwdIdx + 1];
  const sep = args.indexOf('--');
  const argv = sep === -1 ? [] : args.slice(sep + 1);
  // THE REAL EXECUTION. Detached so it outlives this shim invocation, exactly
  // as a pane's process outlives the herdr call that created it.
  let pid = null;
  if (argv.length) {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid;
  }
  const rec = { name: args[2], pane_id: String(100 + started.length), cwd, argv, pid };
  started.push(rec);
  save(started);
  out({ result: { agent: { name: rec.name, pane_id: rec.pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(bin, 'herdr'), 0o755);

const pidFile = path.join(tmp, 'claude.pid');
const conversationMarker = path.join(tmp, 'conversation-exists');

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
  PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_KAN504_SHIM_STATE: shimState,
  CRABCAST_KAN504_PIDFILE: pidFile,
  CRABCAST_KAN504_CONVERSATION: conversationMarker,
  CRABCAST_CONFIG: undefined,
  // ⚠ THE CAP IS SET HERE, ON THE ENVIRONMENT THE DAEMON INHERITS, AND THAT IS
  // THE WHOLE OF WHY §5's CAPACITY ARM IS DETERMINISTIC.
  //
  // It was set on the one CLI invocation instead until CI said otherwise, and
  // that was simply wrong: capacity is computed in the DAEMON (`optionsFromEnv`
  // in capacity.ts), which is auto-spawned by the FIRST CLI call and never sees
  // an environment handed to a later one.
  //
  // ⚠ AND IT PASSED LOCALLY ANYWAY, WHICH IS THE PART WORTH KEEPING. The machine
  // this was written on runs a large agent fleet, so the real derived cap was
  // already exceeded and the activation was refused for a reason that had
  // nothing to do with this proof. A clean GitHub runner has headroom, so the
  // same code activated successfully and the section went red there. A green
  // that came from the author's machine being busy is not a green.
  //
  // Every activation this proof WANTS to succeed passes `--override`, so a cap
  // of 1 constrains only the one activation §5 needs refused.
  CRABCAST_MAX_AGENTS: '1'
};

const cliJs = path.join(distDir, 'cli.js');
const crabcast = (argv) =>
  spawnSync(process.execPath, [cliJs, '--config', configPath, ...argv], {
    env, encoding: 'utf8', timeout: 120_000
  });

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(name) {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** What the shim recorded starting. */
const started = () => {
  const f = path.join(shimState, 'started.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
};

/**
 * The argv of a LIVE process, read from the kernel — NUL-separated in
 * `/proc/<pid>/cmdline`, which is the one place it is not a string somebody
 * composed. `null` when the process is gone.
 */
function liveCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Wait for the fake claude to report its pid, up to `ms`. */
async function awaitClaudePid(ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function forgetClaudePid() {
  try { fs.unlinkSync(pidFile); } catch {}
}

/** The arguments under test. Deliberately awkward, to exercise the quoting. */
const ARGS = ['--dangerously-load-development-channels', '--tag', 'a b'];

// ===========================================================================
rule('0. the launcher table declares, per launcher, whether it carries args');
// ===========================================================================
//
// The capability is a DECLARED FIELD rather than a name test anywhere else, so
// that a launcher added later must answer the question to compile. This
// section reads the declarations off the real table.
const { AGENT_LAUNCHERS, launchersAcceptingArgs, launcherAcceptsArgs } =
  await import(path.join(distDir, 'launchers.js'));

for (const [name, launcher] of Object.entries(AGENT_LAUNCHERS)) {
  check(
    typeof launcher.acceptsArgs === 'boolean',
    `launcher '${name}' declares acceptsArgs`,
    `acceptsArgs = ${JSON.stringify(launcher.acceptsArgs)}`
  );
}
check(launcherAcceptsArgs('claude') === true, "claude declares that it carries args");
check(launcherAcceptsArgs('anti-gravity') === true, "anti-gravity declares that it carries args");
check(launcherAcceptsArgs('shell') === false, "shell declares that it does NOT carry args");
check(
  !launchersAcceptingArgs().includes('shell') && launchersAcceptingArgs().includes('claude'),
  'the accepting-launcher list is derived from the table',
  `launchersAcceptingArgs() = ${JSON.stringify(launchersAcceptingArgs())}`
);

// THE COMMAND STRINGS, both branches, before any process is involved. This is
// the cheap half of §1/§2 — it can be wrong in exactly the way a schema check
// can be wrong, which is why the live sections below exist and why this one
// does not stand in for them.
const resumed = AGENT_LAUNCHERS.claude.command({ args: ARGS, promptCommand: 'go', mayResume: true });
const fresh = AGENT_LAUNCHERS.claude.command({ args: ARGS, promptCommand: 'go', mayResume: false });
const [continueSide, fallbackSide] = resumed.split('||');
check(
  continueSide.includes("'--dangerously-load-development-channels'") &&
    continueSide.includes("'a b'"),
  'the --continue invocation carries the args',
  continueSide.trim()
);
check(
  fallbackSide.includes("'--dangerously-load-development-channels'") &&
    fallbackSide.includes("'a b'"),
  'the cold-start fallback carries the args too',
  fallbackSide.trim()
);
check(
  fresh.trimEnd().endsWith("'go'") && fallbackSide.trimEnd().endsWith("'go'"),
  'the prompt is still the FINAL argument on both forms',
  `fresh: ${fresh}`
);
check(
  AGENT_LAUNCHERS.claude.command({ args: [], promptCommand: 'go', mayResume: true }) ===
    "claude --permission-mode bypassPermissions --continue || claude --permission-mode bypassPermissions 'go'",
  'an agent with NO args gets byte-for-byte the command line it got before this field existed'
);
{
  // The quoting contract: one element in, one argument out, whatever it holds.
  const nasty = AGENT_LAUNCHERS.claude.command({
    args: ["it's", '; rm -rf /', '$(whoami)'], mayResume: false
  });
  check(
    nasty.includes(`'it'\\''s'`) && nasty.includes(`'; rm -rf /'`) && nasty.includes(`'$(whoami)'`),
    'every element is shell-quoted, so none can become a second argument or a command',
    nasty
  );
}

// ===========================================================================
rule('1. COLD START — the args are on the live process, read from /proc');
// ===========================================================================
const coldDir = ownedDir('cold');
{
  const configured = crabcast([
    'configure', coldDir, '--priority', '5', '--launcher', 'claude',
    '--args-json', JSON.stringify(ARGS), '--prompt', 'go'
  ]);
  check(configured.status === 0, 'configure accepts args for the claude launcher',
    (configured.stderr || configured.stdout || '').trim().split('\n')[0]);

  const activated = crabcast(['activate', coldDir, '--override']);
  check(activated.status === 0, 'the agent activates',
    (activated.stderr || activated.stdout || '').trim().split('\n').slice(-1)[0]);

  const pid = await awaitClaudePid();
  check(pid !== null, 'the launcher really started a claude process');

  const cmdline = pid === null ? null : liveCmdline(pid);
  console.log(`\n   /proc/${pid}/cmdline, as the kernel holds it:\n     ${JSON.stringify(cmdline)}\n`);

  check(
    cmdline !== null && cmdline.includes('--dangerously-load-development-channels'),
    "the caller's first argument is on the live process's own command line",
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && cmdline.includes('a b'),
    'an argument containing a space arrived as ONE argument, not two',
    // The discriminating check: 'a b' present as a single element is the whole
    // quoting contract. Split, it would appear as 'a' and 'b'.
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && !cmdline.includes('a') && !cmdline.includes('b'),
    'and it was NOT split — no bare "a" or "b" element exists',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  // THE PROMPT IS THE INSTRUCTION, NOT THE CONFIGURED TEXT — a cold-started
  // agent is pointed at the prompt file in its sidecar (`promptInstruction`),
  // and the configured bytes are what that file holds. So the assertion is
  // about POSITION and ARITY rather than content: it is last, and it is one
  // element, which is the property no number of args may weaken.
  const last = cmdline?.[cmdline.length - 1] ?? '';
  check(
    cmdline !== null &&
      /^Please read and follow the instructions in .* to begin\.$/.test(last),
    'the prompt is still the FINAL argument of the live process, and still exactly ONE',
    `last element = ${JSON.stringify(last)}`
  );
  check(
    cmdline !== null &&
      cmdline.filter((a) => a.startsWith('Please read and follow')).length === 1,
    'the prompt did not fragment across several arguments',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && !cmdline.includes('--continue'),
    'this was the COLD branch — no --continue on it',
    `cmdline = ${JSON.stringify(cmdline)}`
  );

  if (pid !== null) spawnedPids.add(pid);
}

// ===========================================================================
rule('2. RESUMED — the --continue invocation carries them too (the common path)');
// ===========================================================================
//
// ⚠ THE SECTION THIS PROOF EXISTS FOR. Every agent that already exists takes
// this branch; only a brand-new one reaches §1. Args on §1 alone would look
// entirely correct to anybody who tested by creating an agent.
//
// `mayResume` is CrabCast's own record of having run here before, so the agent
// is stood down and activated a SECOND time — which is what a real resume is.
// The conversation marker makes the fake claude's `--continue` succeed, so the
// process left holding the pane is the resumed invocation rather than the
// fallback.
{
  forgetClaudePid();
  fs.writeFileSync(conversationMarker, 'a conversation exists here');

  const down = crabcast(['deactivate', coldDir]);
  check(down.status === 0, 'the agent is stood down',
    (down.stderr || down.stdout || '').trim().split('\n').slice(-1)[0]);

  const again = crabcast(['activate', coldDir, '--override']);
  check(again.status === 0, 're-activated — this is the resume path',
    (again.stderr || again.stdout || '').trim().split('\n').slice(-1)[0]);

  const rec = started()[started().length - 1];
  const command = rec?.argv?.[rec.argv.length - 1] ?? '';
  check(
    command.includes('--continue'),
    'the command CrabCast handed herdr has a --continue invocation in it',
    command
  );

  const pid = await awaitClaudePid();
  check(pid !== null, 'a claude process is live on the resumed branch');

  const cmdline = pid === null ? null : liveCmdline(pid);
  console.log(`\n   /proc/${pid}/cmdline for the RESUMED invocation:\n     ${JSON.stringify(cmdline)}\n`);

  check(
    cmdline !== null && cmdline.includes('--continue'),
    'the live process is the --continue one, not the cold-start fallback',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && cmdline.includes('--dangerously-load-development-channels'),
    '⚠ THE ARGS ARE ON THE --continue INVOCATION',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && cmdline.includes('a b'),
    'including the one with a space in it, still unsplit',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    cmdline !== null && !cmdline.some((a) => a.startsWith('Please read and follow')),
    'and the prompt instruction is ABSENT — which is what makes this the resumed invocation rather than the fallback',
    `cmdline = ${JSON.stringify(cmdline)}`
  );

  if (pid !== null) spawnedPids.add(pid);
}

// ===========================================================================
rule('3. a launcher that cannot carry args REFUSES, and does not quietly drop them');
// ===========================================================================
{
  const shellDir = ownedDir('shelly');
  const refused = crabcast([
    'configure', shellDir, '--priority', '5', '--launcher', 'shell',
    '--args-json', JSON.stringify(['--flag'])
  ]);
  const text = (refused.stderr || '') + (refused.stdout || '');
  console.log(`\n   the refusal, as a caller sees it:\n${text.trim().split('\n').map((l) => `     ${l}`).join('\n')}\n`);

  check(refused.status !== 0, 'configure is REFUSED', `exit ${refused.status}`);
  check(text.includes("'shell'"), 'the refusal names the launcher');
  check(/claude/.test(text), 'and names a launcher that does carry args');
  check(/NOTHING WAS CONFIGURED/.test(text), 'and says nothing was configured');

  // THE DISCRIMINATING HALF: refused means no record, not a record without args.
  const status = crabcast(['status', shellDir]);
  check(
    status.status !== 0 || !/priority/.test(status.stdout || ''),
    'nothing was written — the refusal is not an accept-minus-the-args',
    (status.stdout || status.stderr || '').trim().split('\n')[0]
  );

  // And an EMPTY array is not refused: it asks for nothing, so nothing can fail
  // to arrive, and a reconciler sending `args: []` uniformly must not be broken.
  const empty = crabcast([
    'configure', shellDir, '--priority', '5', '--launcher', 'shell', '--args-json', '[]'
  ]);
  check(empty.status === 0, 'an EMPTY args array is accepted on shell — it asks for nothing',
    (empty.stderr || '').trim().split('\n')[0]);
}

// ===========================================================================
rule('4. argv cannot change under a running agent');
// ===========================================================================
//
// Argv is fixed at process start, so accepting this would write a record that
// says something untrue about a live process. Refused the way `launcher` and
// `prompt` are, through the same table.
{
  const changed = crabcast([
    'configure', coldDir, '--priority', '5', '--launcher', 'claude',
    '--args-json', JSON.stringify([...ARGS, '--extra']), '--prompt', 'go'
  ]);
  const text = (changed.stderr || '') + (changed.stdout || '');
  console.log(`\n   the refusal, as a caller sees it:\n${text.trim().split('\n').map((l) => `     ${l}`).join('\n')}\n`);

  check(changed.status !== 0, 'the reconfiguration is REFUSED while the agent runs', `exit ${changed.status}`);
  check(/\bargs\b/.test(text), 'the refusal names `args` as the attribute that forced it');
  check(
    /fixed at process start|argument vector/i.test(text),
    'and gives the mechanical reason rather than a bare "cannot change that"'
  );
  check(/NOTHING WAS APPLIED/.test(text), 'and says nothing was applied');

  // The agent is untouched: same live argv as before the refusal.
  const rec = started()[started().length - 1];
  check(
    !JSON.stringify(rec?.argv ?? []).includes('--extra'),
    'the running agent was not respawned and its argv is unchanged'
  );
}

// ===========================================================================
rule('5. DISCLOSURE — argv is readable in list, in status, and in a capacity refusal');
// ===========================================================================
{
  const list = crabcast(['list']);
  const listOut = (list.stdout || '') + (list.stderr || '');
  const listLine = listOut.split('\n').find((l) => /args:/.test(l)) ?? '';
  console.log(`\n   list:\n     ${listLine.trim()}\n`);
  check(
    /--dangerously-load-development-channels/.test(listOut),
    'list shows what the agent was spawned with',
    listLine.trim()
  );

  const status = crabcast(['status', coldDir]);
  const statusOut = (status.stdout || '') + (status.stderr || '');
  const statusLine = statusOut.split('\n').find((l) => /args:/.test(l)) ?? '';
  console.log(`   status:\n     ${statusLine.trim()}\n`);
  check(
    /--dangerously-load-development-channels/.test(statusOut) && /'a b'/.test(statusOut),
    'status shows them too, quoted as the command line quotes them',
    statusLine.trim()
  );

  // THE CAPACITY REFUSAL. Deliberately included: `list` and `status` describe
  // agents that EXIST, and an activation the gate refused never becomes one —
  // so without this, the one configuration a caller most wants to see is the
  // only one no read can show them.
  const denied = ownedDir('denied');
  crabcast([
    'configure', denied, '--priority', '1', '--launcher', 'claude',
    '--args-json', JSON.stringify(['--would-have-had-this']), '--prompt', 'go'
  ]);
  // No `--override`: this is the one activation in the proof that must meet the
  // gate. The cap comes from the daemon's own environment — see CRABCAST_MAX_AGENTS
  // above — rather than from this call, which cannot reach the daemon.
  const refusal = crabcast(['activate', denied]);
  const refusalText = (refusal.stderr || '') + (refusal.stdout || '');
  const refusalLine = refusalText.split('\n').find((l) => /would have been started with/.test(l)) ?? '';
  console.log(`   the capacity refusal:\n     ${refusalLine.trim() || '(no such line)'}\n`);

  const wasRefused = refusal.status !== 0 && /capacity/i.test(refusalText);
  check(wasRefused, 'the activation is refused at capacity',
    `exit ${refusal.status}${wasRefused ? '' : ` — output: ${refusalText.trim().split('\n').slice(0, 2).join(' / ')}`}`);

  // ⚠ MATCHED ON THE REFUSAL'S OWN SENTENCE, NOT ON THE ARGUMENT STRING, AND CI
  // IS WHY. This check read `/--would-have-had-this/` against the whole output
  // and PASSED on a run where the activation had SUCCEEDED — because a
  // successful `activate` echoes the config, and the config contains the args.
  // So the one check that was supposed to establish "the refusal discloses the
  // argv" was equally satisfied by there being no refusal at all: a check that
  // could not fail in the direction that mattered, sitting green beside two that
  // had gone red.
  //
  // `would have been started with` is emitted only by the refusal path, so this
  // now distinguishes them — and §5b below is what shows that claim is true
  // rather than asserted.
  check(
    /would have been started with '--would-have-had-this'/.test(refusalText),
    'and the refusal names what WOULD have been spawned — matched on the refusal\'s own ' +
      'sentence, which a successful activation does not print',
    refusalLine.trim() || refusalText.trim().split('\n').slice(0, 2).join(' / ')
  );
  check(
    /nothing was started/i.test(refusalText),
    'while being clear that nothing was',
    refusalLine.trim()
  );

  // ------------------------------------------------------------------ §5b
  // THE POSITIVE CONTROL FOR THE CHECK ABOVE.
  //
  // "This sentence appears only on a refusal" is a claim about the code, and a
  // check resting on it is only as good as the claim. So the SAME agent is now
  // activated successfully with `--override`, and the sentence must be ABSENT
  // while the args are still disclosed by `status`. Without this, the matcher
  // above could be tightened to something that never appears anywhere and the
  // section would go green forever.
  const allowed = crabcast(['activate', denied, '--override']);
  const allowedText = (allowed.stderr || '') + (allowed.stdout || '');
  check(allowed.status === 0, '(control) the same agent activates when the gate is overridden',
    `exit ${allowed.status}`);
  check(
    !/would have been started with/.test(allowedText),
    '⚠ and the refusal sentence is ABSENT from that success — so the check above is reading ' +
      'the refusal, not merely finding the argument text somewhere in the output',
    allowedText.trim().split('\n').slice(0, 2).join(' / ')
  );
  const allowedStatus = crabcast(['status', denied]);
  check(
    /--would-have-had-this/.test((allowedStatus.stdout || '') + (allowedStatus.stderr || '')),
    'while the argv itself is still disclosed for the now-running agent'
  );
  // §5b really started a process, so §6's "every process this proof started is
  // gone" has to know about it. A control that quietly leaks a `sleep` would
  // make the very next section's claim false.
  {
    const pid = await awaitClaudePid(5_000);
    if (pid !== null) spawnedPids.add(pid);
  }
}

// ===========================================================================
rule('6. the RUNNING FLEET was never touched');
// ===========================================================================
//
// CrabCast is the live runtime for a whole fleet on the machine this was
// written on, so this is a safety assertion rather than a tidiness one: a proof
// that spawned into the real daemon could take somebody's session.
{
  const realDataDir = path.join(os.homedir(), '.local', 'share', 'crabcast');
  check(
    !dataDir.startsWith(realDataDir) && dataDir.startsWith(tmp),
    'the data dir this proof drove is scratch, not the fleet\'s',
    `used ${dataDir}`
  );
  check(
    env.HOME === home && home.startsWith(tmp),
    'HOME was scratch, so no real ~/.claude.json trust entry or transcript was read or written',
    `HOME = ${env.HOME}`
  );
  check(
    env.PATH.startsWith(bin),
    'PATH put the shim first, so no real herdr or real claude binary was ever invoked',
    `PATH = ${env.PATH}`
  );
  const realAgentsLog = path.join(realDataDir, 'agents.jsonl');
  const realMtimeNow = fs.existsSync(realAgentsLog) ? fs.statSync(realAgentsLog).mtimeMs : null;
  check(
    realMtimeNow === realAgentsLogMtimeAtStart,
    "the live fleet's own agents.jsonl was not written",
    realMtimeNow === null
      ? '(no live registry on this machine — vacuously true, and stated so it is not read as a measurement)'
      : `mtime unchanged at ${realMtimeNow}`
  );

  // -------------------------------------------------------------------------
  // EVERY PROCESS CARRYING THIS RUN'S SCRATCH ROOT, ENDED (KAN-529)
  // -------------------------------------------------------------------------
  //
  // This block used to kill `spawnedPids`, call `crabcast(['daemon', 'stop'])`
  // and assert that the pids it remembered were gone. All three parts were
  // wrong together, which is why it went green while leaking:
  //
  //   * `crabcast daemon stop` IS NOT A COMMAND. It exits 2 with a usage error
  //     ("`crabcast daemon` takes no arguments, and got \"stop\"") and stops
  //     nothing. The status was never read.
  //   * `spawnedPids` never held the scratch daemon — nothing here spawns it;
  //     the first CLI call does, detached — nor any `herdr agent attach` the
  //     daemon then spawns.
  //   * and it did not hold every fake `claude` either: the pid the fixture
  //     reports is the process that writes the record, not the `bash` wrapper
  //     that `exec`s toward it.
  //
  // Measured on 2026-08-18: a run of this file printing `53/53 checks passed`
  // and `every process this proof started is gone — 3 ended` left FOUR live
  // processes carrying its own scratch root.
  //
  // ⚠ THE POPULATION IS NOW READ OFF THE MACHINE rather than remembered, keyed
  // on this run's scratch root — six random characters from `mkdtempSync` that
  // exist nowhere else — so a process this run caused carries it and nothing
  // else can. `found` is reported beside the verdict because a sweep that
  // matched nothing and a sweep that cleaned up correctly are the same verdict
  // with different evidence, and only one of them means the instrument is
  // working.
  const { found, survivors } = await sweepScratchRoot(tmp);
  check(
    survivors.length === 0,
    'every process carrying this run\'s scratch root is gone — the daemon and its ' +
      'attaches included, not merely the pids this script remembered',
    survivors.length
      ? `still alive:\n          ${describe(survivors)}`
      : `${found.length} swept (${found.length - spawnedPids.size} of them never in spawnedPids)`
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

process.exit(failures ? 1 : 0);
