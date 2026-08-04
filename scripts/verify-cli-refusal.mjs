#!/usr/bin/env node
// Live proof (KAN-93) for the half of the CLI contract that a machine can
// check without a real herdr: a refusal is legible and non-zero, `--json` is
// the daemon's response and nothing else, the exit codes mean what `--help`
// says they mean, and `--override`/`--preempt` cross the wire as real
// booleans.
//
// Nine sections:
//
//   1. refusal      — at CRABCAST_MAX_AGENTS=0, `crabcast activate shell demo`
//                     exits non-zero and its stdout carries the daemon's
//                     derivation verbatim, line for line
//   2. verbatim     — the same claim proven deterministically: the renderer,
//                     handed a response with a known multi-line derivation,
//                     reproduces it byte for byte and unindented
//   3. --json       — field for field what the daemon sent, compared against a
//                     raw socket client's answer to the same request
//   4. exit codes   — 0 / 1 / 2 / 3 / 4, each one produced on purpose
//   5. flags        — --override and --preempt round-trip as booleans: they
//                     take effect when set, `=false` is a real false (not the
//                     truthy string "false" the router now refuses), and a
//                     non-boolean is a usage error that never reaches the wire
//   6. help         — `--help` lists exactly the exported command table, and
//                     every command in it renders its own help
//   7. dashed text  — an operand that looks like a flag is sent as text: flag
//                     parsing stops where a `rest` positional begins, so
//                     `send <key> --help` delivers "--help" instead of
//                     printing help and exiting 0 having sent nothing
//   8. unusable dir — a dataDir whose socket path cannot fit in sun_path is
//                     refused at load, by the CLI and the daemon alike; and
//                     the bin is runnable through a symlink, which is the
//                     `npm link` path and the reason the direct-invocation
//                     guard resolves paths at all
//   9. relative paths — a relative path is refused BY NAME by every verb that
//                     takes one, including the three that fall back to a
//                     lexical resolve for a deleted directory; the fallback
//                     still works for the case it exists for; and both
//                     clients (CLI and MCP) resolve against THEIR OWN cwd
//                     before the request goes on the wire
//
// Everything on the daemon side is real: the real daemon (spawned by the CLI
// itself, which is how a human gets one), the real router, capacity model,
// registry and config loader, real NDJSON over a real unix socket. What is
// faked is the `herdr` binary — a shim on PATH answering in herdr's own JSON
// shapes. The capacity gate refuses BEFORE anything is spawned (router.ts),
// so sections 1-4 would pass with no herdr at all; section 5 needs one only
// because proving `--override` worked means an agent actually starting.
//
// Isolation is by scratch dataDirs and a scratch $HOME with a system-only
// PATH, so the daemon's PATH normalization cannot rediscover a real herdr and
// nothing here touches a real fleet.
//
// Usage:
//   npm run build
//   node scripts/verify-cli-refusal.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const cliJs = path.join(distDir, 'cli.js');

const { COMMANDS, EXIT, ResponseReader, renderHelp } = await import(path.join(distDir, 'cli.js'));
const { connectToDaemon, onJsonLines, writeJsonLine } = await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, text) => console.log(`   ${label}\n${String(text).replace(/^/gm, '     ')}`);

let failures = 0;
const check = (ok, claim) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}`);
  if (!ok) failures += 1;
  return ok;
};

// ----------------------------------------------------------------- the scratch

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-verify-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const daemonPids = new Set();
function cleanup() {
  for (const pid of daemonPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

// -------------------------------------------------------------------- the shim
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs. The
// daemon normalizes PATH at boot from a login shell and $HOME; the scratch
// $HOME keeps ~/.local/bin (where a real herdr may live) out of every
// candidate list, so this shim is the only herdr any process here can find.

const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimDir, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_VERIFY_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (list) => fs.writeFileSync(startedFile, JSON.stringify(list, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === '--version') {
  process.stdout.write('herdr 0.6.4\\n');
  process.exit(0);
}
if (a === 'agent' && b === 'get') {
  const found = load().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id, cwd: found.cwd, agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: String(100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, agent: 'shell', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'read') {
  const found = load().find((s) => s.name === args[2]);
  if (!found) {
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
    process.exit(1);
  }
  out({ result: { read: { text: \`KAN-93 pane text for \${args[2]}\`, truncated: false } } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
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

// ------------------------------------------------------------------- fixtures

/**
 * One daemon's worth of scratch: its own config, its own dataDir, and the
 * environment every CLI call against it must carry.
 *
 * The environment matters more than it looks. The daemon is spawned BY the
 * CLI and inherits its environment, so `CRABCAST_MAX_AGENTS` is fixed for a
 * daemon's whole life by whichever invocation happened to start it. One env
 * per fixture, used for every call against it, is what keeps that honest.
 */
function fixture(name, _unusedTypes, env = {}) {
  const dir = path.join(scratch, name);
  const dataDir = path.join(dir, 'data');
  // Its own shim state as well as its own dataDir: the shim records started
  // agents on disk, and one shared file would have each fixture's daemon
  // counting every other fixture's agents against its cap.
  const state = path.join(dir, 'shim-state');
  fs.mkdirSync(state, { recursive: true });
  const configPath = path.join(dir, 'crabcast.config.json');
  // A dataDir and nothing else: there is no type table left to declare, and
  // every knob this script used to put in it is now a `configure` flag.
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return {
    name,
    configPath,
    dataDir,
    state,
    /** A directory this fixture's agents run in. The address, and all of it. */
    dirFor(agent) {
      const d = path.join(dir, 'owned', agent);
      fs.mkdirSync(d, { recursive: true });
      return fs.realpathSync(d);
    },
    env: {
      ...process.env,
      HOME: fakeHome,
      SHELL: '/bin/bash',
      PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
      CRABCAST_VERIFY_SHIM_STATE: state,
      // Never inherited from whoever runs this script: the fixtures below are
      // the only thing allowed to set the capacity levers.
      CRABCAST_CONFIG: undefined,
      CRABCAST_MAX_AGENTS: undefined,
      CRABCAST_AGENT_CORES: undefined,
      CRABCAST_AGENT_MEMORY_MB: undefined,
      ...env
    }
  };
}

/**
 * Run the CLI as a human would, and hand back everything it produced.
 *
 * `--config` goes FIRST, not last. It used to be appended, which was fine
 * until flag parsing learned to stop at a `rest` positional — after which a
 * trailing `--config …` became part of `send`'s message, and this harness was
 * testing its own argument order rather than the CLI's. Leading is also what
 * the help tells a human to do with flags on a rest command.
 */
function crabcast(fx, args, extraEnv = {}, cwd = undefined) {
  const result = spawnSync(process.execPath, [cliJs, '--config', fx.configPath, ...args], {
    env: { ...fx.env, ...extraEnv },
    // Section 9 is the only caller that sets this, and it needs both ends of
    // it: the CLI's own cwd is what a relative operand must resolve against,
    // and the daemon — spawned by whichever call finds none running, with no
    // `cwd` of its own (ipc.ts) — inherits it from that first call.
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    timeout: 120_000
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    argv: args
  };
}

let rawRequestId = 0;

/** A raw socket round trip against a fixture's daemon — the wire, unmediated. */
async function raw(fx, action, payload = {}) {
  const socket = await connectToDaemon(fx.dataDir, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `verify-${++rawRequestId}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw ${action} timed out`));
    }, 30_000);
    onJsonLines(socket, (msg) => {
      if (msg?.id !== id) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(msg);
    });
    writeJsonLine(socket, { action, ...payload, id });
  });
}

/** Remember the daemon a fixture started, so it is not left behind. */
async function trackDaemon(fx) {
  try {
    const status = await raw(fx, 'daemon_status');
    if (typeof status?.pid === 'number') daemonPids.add(status.pid);
    return status;
  } catch {
    return null;
  }
}

const CAP_ZERO = { CRABCAST_MAX_AGENTS: '0' };

console.log(`cli under test: ${cliJs}`);
console.log(`fake herdr:     ${path.join(shimDir, 'herdr')}`);
console.log(`scratch:        ${scratch}`);

// ------------------------------------------------------------- 1. the refusal

rule('1. REFUSAL — at CRABCAST_MAX_AGENTS=0, activate exits non-zero and prints the derivation');

const capped = fixture('capped', null, CAP_ZERO);

/**
 * `crabcast configure <dir> …` — mandatory before anything can be activated,
 * and the only place a priority and a launcher exist now.
 */
function configure(fx, agent, extra = []) {
  const dir = fx.dirFor(agent);
  const run = crabcast(fx, ['configure', dir, '--priority', '1', '--launcher', 'shell', ...extra]);
  if (run.code !== EXIT.OK) {
    console.log(`  configure ${dir} FAILED: ${run.stdout}${run.stderr}`);
  }
  return dir;
}

const demoDir = configure(capped, 'demo');

// Two invocations, because one process prints one of the two modes. Their
// figures come from two readings of a live machine a second apart, so load
// average and available memory can genuinely move between them — retried
// rather than tolerated, because the assertion being made is byte equality
// and weakening it would prove nothing.
let human = null;
let asJson = null;
for (let attempt = 1; attempt <= 5; attempt++) {
  human = crabcast(capped, ['activate', demoDir]);
  const jsonRun = crabcast(capped, ['activate', demoDir, '--json']);
  try {
    asJson = { ...jsonRun, parsed: JSON.parse(jsonRun.stdout) };
  } catch {
    asJson = { ...jsonRun, parsed: null };
    break;
  }
  if (typeof asJson.parsed.derivation === 'string' && human.stdout.includes(asJson.parsed.derivation)) break;
  if (attempt < 5) {
    console.log(`  (attempt ${attempt}: the machine's figures moved between the two runs; re-reading)`);
  }
}
await trackDaemon(capped);

show('the session, unedited:', `$ CRABCAST_MAX_AGENTS=0 crabcast activate ${demoDir}\n${human.stdout}$ echo $?\n${human.code}`);

check(human.code !== 0, `it exits non-zero (${human.code})`);
check(human.code === EXIT.REFUSED, `the code is ${EXIT.REFUSED} — "the daemon said no", not "no daemon" (${EXIT.TRANSPORT})`);

const derivation = asJson.parsed?.derivation;
check(typeof derivation === 'string' && derivation.includes('\n'), 'the response carries a multi-line derivation');
check(
  typeof derivation === 'string' && human.stdout.includes(derivation),
  'stdout carries that derivation VERBATIM — every line, contiguous, unaltered'
);
if (typeof derivation === 'string') {
  const missing = derivation.split('\n').filter((line) => !human.stdout.includes(line));
  check(missing.length === 0, `no line of the derivation is missing from stdout${missing.length ? `: ${JSON.stringify(missing)}` : ''}`);
  // Unindented, so the arithmetic can be pasted back into an argument about
  // it. A derivation shifted two spaces to the right is no longer the text
  // the daemon produced.
  const first = derivation.split('\n')[0];
  check(
    human.stdout.split('\n').some((line) => line === first),
    'the derivation is unindented — its first line stands alone on a line of stdout'
  );
}
check(
  human.stdout.includes('refused by:') && human.stdout.includes('reason:'),
  'refusedBy and reason are named, not buried in the error text'
);
check(human.stdout.length > 0 && human.stderr.trim() === '', 'the refusal is on stdout, where a human piping it will see it');

// ------------------------------------------------------------ 2. verbatim, exactly

rule('2. VERBATIM, DETERMINISTICALLY — the renderer reproduces a derivation byte for byte');

// Section 1 compares two readings of a live machine. This one removes the
// machine: a synthetic response with a derivation nobody's load average can
// move, rendered by the same code path, compared byte for byte.
const SYNTHETIC_DERIVATION = [
  'machine: 4 cores, 15.4 GiB RAM (7.7 GiB available), load average 3.00',
  'agent cost: 650 MB resident (seed), 0.75 core while active (seed)',
  '  no live measurement; seed figures are the 2026-07-31 constants, not a measurement of this fleet',
  'reserved for you: 1 core(s), 2.3 GiB',
  'cap: 3 task agents — CPU allows 3, memory allows 20; bound by cpu',
  'running: 2 task agent(s)',
  'headroom: 0 more — count allows 1, load allows 0, memory allows 8; bound by load'
].join('\n');

const activateSpec = COMMANDS.find((c) => c.name === 'activate');
const rendered = activateSpec.render(new ResponseReader({
  action: 'activate_response',
  success: false,
  type: 'task',
  key: 'KAN-93',
  error: 'Refusing to activate task/KAN-93: load too high.',
  refusedBy: 'capacity',
  reason: 'the load average is 3.00',
  derivation: SYNTHETIC_DERIVATION,
  id: 'cli-1-1'
}), { path: '/home/someone/work' });
show('rendered:', rendered);
check(rendered.includes(SYNTHETIC_DERIVATION), 'the rendered text contains the derivation as one contiguous verbatim block');
check(
  SYNTHETIC_DERIVATION.split('\n').every((line) => rendered.split('\n').includes(line)),
  'every derivation line appears as its own line, with no indent added'
);

// The other half of "never swallow": a field no renderer knows about is
// printed rather than dropped. This is what keeps a future daemon field from
// disappearing into a CLI written before it existed.
const withUnknown = activateSpec.render(new ResponseReader({
  action: 'activate_response',
  success: true,
  path: '/home/someone/work',
  sessionId: 's1',
  status: 'active',
  verified: true,
  somethingTheCliHasNeverHeardOf: 'must still be visible'
}), { path: '/home/someone/work' });
check(
  withUnknown.includes('somethingTheCliHasNeverHeardOf') && withUnknown.includes('must still be visible'),
  'an unrecognised response field is printed, not silently dropped'
);

// ---------------------------------------------------------------- 3. --json

rule('3. --json — the daemon\'s response, field for field, unmodified');

const wire = await raw(capped, 'activate_agent', { path: demoDir });
const viaCli = asJson.parsed;

show('what the CLI printed (--json):', JSON.stringify(viaCli, null, 2));

check(viaCli !== null, '--json output parses as JSON and nothing else is written to stdout');
if (viaCli) {
  const wireKeys = Object.keys(wire).sort();
  const cliKeys = Object.keys(viaCli).sort();
  check(
    JSON.stringify(wireKeys) === JSON.stringify(cliKeys),
    `the same fields as a raw socket client sees, no more and no fewer\n        wire: ${wireKeys.join(', ')}\n        cli:  ${cliKeys.join(', ')}`
  );
  check(
    JSON.stringify(Object.keys(wire.capacity ?? {}).sort()) ===
      JSON.stringify(Object.keys(viaCli.capacity ?? {}).sort()),
    'nested objects are passed through whole — the capacity block is not flattened or clipped'
  );
  check(viaCli.success === false && viaCli.action === 'activate_response', 'success and action are the daemon\'s own');
  check(viaCli.refusedBy === wire.refusedBy, `refusedBy survives the trip (${viaCli.refusedBy})`);
  check(
    typeof viaCli.id === 'string' && viaCli.id.startsWith('cli-'),
    'the `id` is present too: it is this invocation\'s correlation token, echoed by the daemon and not stripped'
  );
  check(
    typeof viaCli.error === 'string' && viaCli.error.includes(viaCli.derivation),
    'the derivation is inside the error text as well, both verbatim'
  );
}

// ------------------------------------------------------------- 4. exit codes

rule('4. EXIT CODES — a shell script can tell a refusal from an unreachable daemon');

const codes = [];

codes.push(['0 success', crabcast(capped, ['capacity']), EXIT.OK]);
codes.push(['1 refused', human, EXIT.REFUSED]);
codes.push(['2 usage (missing operand)', crabcast(capped, ['activate']), EXIT.USAGE]);
codes.push(['2 usage (unknown command)', crabcast(capped, ['frobnicate']), EXIT.USAGE]);
codes.push(['2 usage (unknown flag)', crabcast(capped, ['list', '--colour']), EXIT.USAGE]);

// Nothing has ever run in this data dir, and `list` does not start a daemon.
const cold = fixture('cold', null);
const transport = crabcast(cold, ['list']);
codes.push(['3 transport (no daemon, and list does not start one)', transport, EXIT.TRANSPORT]);

// A config that was NAMED and will not load: a refusal, never a fallback onto
// whatever daemon happens to be running somewhere else.
const brokenConfig = path.join(scratch, 'broken.config.json');
// A config that still declares the retired key. It is refused rather than
// ignored — a config written against the type model set an agent's priority,
// prompt, launcher and gate exemption, and silently dropping it would start a
// daemon that agrees with the file about nothing.
fs.writeFileSync(brokenConfig, '{ "workspaceTypes": [ { "name": "shell" } ] }');
const configRefusal = spawnSync(process.execPath, [cliJs, 'list', '--config', brokenConfig], {
  env: capped.env,
  encoding: 'utf8'
});
codes.push([
  '4 config (named config will not load)',
  { code: configRefusal.status, stdout: configRefusal.stdout, stderr: configRefusal.stderr },
  EXIT.CONFIG
]);

for (const [label, run, expected] of codes) {
  check(run.code === expected, `${label} → exit ${run.code} (expected ${expected})`);
}
show('the transport failure names where a failed daemon leaves its stderr:', transport.stderr.trim());
check(
  transport.stderr.includes('daemon-spawn.err'),
  'a transport failure names <dataDir>/daemon-spawn.err — where a daemon that died during load left its reason'
);
show('the config refusal:', codes[codes.length - 1][1].stderr.trim());
check(
  /workspaceTypes/.test(codes[codes.length - 1][1].stderr) &&
    /no longer a config key/.test(codes[codes.length - 1][1].stderr),
  'the config refusal repeats the loader\'s own complaint rather than inventing one — and\n' +
  '        names the retired key rather than silently ignoring it'
);

// ------------------------------------------------------------------ 5. flags

rule('5. --override AND --preempt — real booleans, proven in both directions');

// (a) --override, against a daemon whose cap is zero: the only way anything
//     starts here is the flag arriving as a boolean true. The router refuses a
//     non-boolean before it looks anything up (invalidFlag), so a CLI that
//     forwarded the string "true" would be refused instead.
const overrides = fixture('override', null, CAP_ZERO);
const keptDir = configure(overrides, 'kept');
const notkeptDir = configure(overrides, 'notkept');
const junkDir = configure(overrides, 'junk');
const overrode = crabcast(overrides, ['activate', keptDir, '--override']);
await trackDaemon(overrides);
show(`$ crabcast activate ${keptDir} --override`, overrode.stdout + overrode.stderr);
check(overrode.code === EXIT.OK, `--override starts an agent past a cap of 0 (exit ${overrode.code})`);
check(/started past the cap on purpose/.test(overrode.stdout), 'the override is reported, with the figures it bypassed');

const overrideFalse = crabcast(overrides, ['activate', notkeptDir, '--override=false']);
show(`$ crabcast activate ${notkeptDir} --override=false`, overrideFalse.stdout + overrideFalse.stderr);
check(overrideFalse.code === EXIT.REFUSED, '--override=false is a real false: the activation is refused');
check(
  !/Invalid override/.test(overrideFalse.stdout),
  'and it is refused BY CAPACITY, not as an invalid flag — the wire carried a boolean, not the string "false"'
);

const overrideJunk = crabcast(overrides, ['activate', junkDir, '--override=yes']);
check(overrideJunk.code === EXIT.USAGE, '--override=yes is a usage error (exit 2) that never reaches the daemon');
show(`$ crabcast activate ${junkDir} --override=yes`, overrideJunk.stderr.trim());

// (b) --preempt, end to end: one agent running, a higher-priority activation
//     refused with a preemption offer, then the same call with the flag.
//     Costs are pinned tiny so the cap — not this machine's live load — is
//     what binds, which is the constraint the preemption is about.
const fleet = fixture(
  'preempt',
  null,
  { CRABCAST_MAX_AGENTS: '1', CRABCAST_AGENT_CORES: '0.01', CRABCAST_AGENT_MEMORY_MB: '1' }
);
// Priority is a `configure` flag now rather than a property of a type, so the
// two agents differ by what their own records say they are worth.
const humbleDir = configure(fleet, 'humble');
const chiefDir = fleet.dirFor('chief');
crabcast(fleet, ['configure', chiefDir, '--priority', '5', '--launcher', 'shell']);

const first = crabcast(fleet, ['activate', humbleDir]);
await trackDaemon(fleet);
check(first.code === EXIT.OK, `the one slot is taken by the priority-1 agent (exit ${first.code})`);

const refusedForRoom = crabcast(fleet, ['activate', chiefDir]);
show(`$ crabcast activate ${chiefDir}`, refusedForRoom.stdout);
check(refusedForRoom.code === EXIT.REFUSED, 'a second activation is refused: the cap is 1');
check(
  /preemption available/.test(refusedForRoom.stdout) && refusedForRoom.stdout.includes(humbleDir),
  'the refusal names the agent that could be stood down, by path'
);

const preemptFalse = crabcast(fleet, ['activate', chiefDir, '--preempt=false']);
check(preemptFalse.code === EXIT.REFUSED, '--preempt=false is a real false: still refused');
check(
  !/Invalid preempt/.test(preemptFalse.stdout),
  'and refused by capacity rather than by the router\'s flag validation'
);

const preempted = crabcast(fleet, ['activate', chiefDir, '--preempt']);
show(`$ crabcast activate ${chiefDir} --preempt`, preempted.stdout);
check(preempted.code === EXIT.OK, `--preempt makes room and the activation succeeds (exit ${preempted.code})`);
check(
  /preempted to make room/.test(preempted.stdout) && preempted.stdout.includes(humbleDir),
  'the CLI says whose work was interrupted, by path'
);

const afterwards = crabcast(fleet, ['list']);
show('$ crabcast list', afterwards.stdout);
check(
  /preempted agents \(1\)/.test(afterwards.stdout),
  'the stood-down agent is reported as preempted — a decision still owed, not a tidy disappearance'
);
check(
  /preempted agents \(\d+\)/.test(afterwards.stdout) &&
    /missing agents \(\d+\)/.test(afterwards.stdout) &&
    /standby agents \(\d+\)/.test(afterwards.stdout),
  'every fleet category is headed with its UNCLIPPED total, so a clipped list cannot read as "that is all of them"'
);

// ------------------------------------------------------------------- 6. help

rule('6. --help IS HONEST — it is rendered from the exported command table');

const help = crabcast(capped, ['--help']);
check(help.code === EXIT.OK, '`crabcast --help` exits 0');
check(help.stdout.trim() === renderHelp().trim(), 'the help printed is exactly what renderHelp() produces from COMMANDS');

for (const spec of COMMANDS) {
  const listed = new RegExp(`^\\s+${spec.name}\\s`, 'm').test(help.stdout);
  const own = crabcast(capped, [spec.name, '--help']);
  check(
    listed && own.code === EXIT.OK && own.stdout.includes(spec.action),
    `${spec.name}: listed in --help, has its own help, and names its socket action (${spec.action})`
  );
}

const helpCommands = help.stdout
  .split('\ncommands:\n')[1]
  .split('\n\n')[0]
  .split('\n')
  .map((l) => l.trim().split(/\s+/)[0])
  .filter(Boolean);
check(
  JSON.stringify(helpCommands) === JSON.stringify(COMMANDS.map((c) => c.name)),
  `every command in the help exists in the table and vice versa: ${helpCommands.join(', ')}`
);

// ------------------------------------------------------------ 7. dashed text

rule('7. AN OPERAND THAT LOOKS LIKE A FLAG IS SENT AS TEXT, not read as a flag');

// The regression this section exists for: `crabcast send <key> --help` used
// to print the help, send NOTHING, and exit 0 — a success reported over work
// that never happened. Flag parsing now stops where a `rest` positional
// begins, and what the daemon was actually asked to type is read back out of
// the herdr shim's own invocation log rather than inferred from the exit code.
const shimSent = () => {
  const file = path.join(overrides.state, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((args) => args[0] === 'pane' && args[1] === 'send-text')
    .map((args) => args[3]);
};

// shell/kept is the agent section 5 started with --override, and it is still
// running against the same daemon.
const before = shimSent().length;
const sentHelp = crabcast(overrides, ['send', keptDir, '--help']);
const afterHelp = shimSent();
show('$ crabcast send kept --help', sentHelp.stdout + sentHelp.stderr);
show('what herdr was asked to type:', JSON.stringify(afterHelp[afterHelp.length - 1]));

check(
  afterHelp.length === before + 1 && afterHelp[afterHelp.length - 1] === '--help',
  'the daemon was asked to type the literal text "--help" — the message was not swallowed'
);
check(
  !/usage: crabcast/.test(sentHelp.stdout) && !/^crabcast send <key>/m.test(sentHelp.stdout),
  'it did not print help instead'
);
check(sentHelp.code === EXIT.OK, `it exits on the daemon's verdict (${sentHelp.code}), not on a phantom success`);

const sentDash = crabcast(overrides, ['send', keptDir, '-x']);
check(
  shimSent().pop() === '-x' && sentDash.code === EXIT.OK,
  'a single-dash message is text too: "-x" was delivered'
);

// A flag written after the message is message text, and there is no longer a
// note about it — the assertion that used to be here is deleted along with the
// code it checked, for a reason worth stating precisely rather than gesturing
// at.
//
// The note fired when a word in the message matched one of the COMMAND's own
// flags. `send` is the only command with a `rest` positional and it now has no
// flags of its own (`--type` went with the types, because a path cannot be
// ambiguous), so the branch was unreachable: it could not fire for any input.
// Widening it to global flags was the alternative and would have been worse —
// `send <dir> --timeout 5000` is an ordinary message, and warning about a
// mistake the caller did not make is the opposite of this CLI's rule that what
// it prints is what happened.
const sentAfter = crabcast(overrides, ['send', keptDir, 'hi', 'there']);
check(
  shimSent().pop() === 'hi there' && sentAfter.code === EXIT.OK,
  'the whole message is joined and delivered, not clipped at the first word'
);
check(
  sentAfter.stderr.trim() === '' || !/is part of the/.test(sentAfter.stderr),
  'and no note is printed about it, because there is no longer a branch that could'
);

const sentTimeout = crabcast(overrides, ['send', keptDir, '--timeout', '5000']);
check(
  shimSent().pop() === '--timeout 5000',
  'a global flag inside a message no longer retunes the client: "--timeout 5000" was delivered as text'
);
show('what the daemon was asked to type:', JSON.stringify(shimSent().pop()));

// `--` still does its job for the commands that have no rest positional. The
// path does not exist, so the daemon refuses — which is the point: the operand
// reached it intact rather than being read as a flag.
const dashedKey = crabcast(capped, ['status', '--', '-odd-path']);
check(
  dashedKey.code === EXIT.REFUSED && /-odd-path/.test(dashedKey.stdout),
  '`--` still ends flag parsing where there is no rest positional: `status -- -odd-path` asked about "-odd-path"'
);

// And the command's own help is still reachable, because the rest positional
// has not started consuming when the flag appears first.
const sendHelp = crabcast(capped, ['send', '--help']);
check(
  sendHelp.code === EXIT.OK && sendHelp.stdout.includes('send_to_agent'),
  '`crabcast send --help` (no key yet) still prints the command help'
);
check(
  /flag parsing STOPS where it begins/.test(sendHelp.stdout),
  "and that help states the rule, so the behaviour is documented where it is met"
);

const hexLines = crabcast(capped, ['tail', demoDir, '--lines', '0x10']);
check(
  hexLines.code === EXIT.USAGE && /plain decimal/.test(hexLines.stderr),
  '--lines 0x10 is a usage error rather than a silent 16'
);

// ----------------------------------------------------------- 8. unusable dir

rule('8. A dataDir WHOSE SOCKET CANNOT FIT IS REFUSED AT LOAD, by both consumers');

// A unix socket address is a fixed buffer and an over-long path is truncated,
// not rejected: the daemon then binds outside its own data directory, cannot
// chmod or unlink what it bound, and the NEXT daemon reports a stale socket
// file in a directory that is empty. The config loader refuses rather than
// repairs, so it refuses this too.
const longDir = path.join(scratch, 'x'.repeat(120));
fs.mkdirSync(longDir, { recursive: true });
const longConfig = path.join(longDir, 'crabcast.config.json');
fs.writeFileSync(longConfig, JSON.stringify({ dataDir: path.join(longDir, 'data') }));

const cliLong = spawnSync(process.execPath, [cliJs, 'list', '--config', longConfig], {
  env: capped.env, encoding: 'utf8'
});
show('$ crabcast list --config <150-byte socket path>', cliLong.stderr.trim());
check(cliLong.status === EXIT.CONFIG, `the CLI refuses with exit ${EXIT.CONFIG} (got ${cliLong.status})`);
check(
  /socket path is \d+ characters/.test(cliLong.stderr) && /at most 104/.test(cliLong.stderr),
  'the refusal names the length it measured and the limit it broke'
);

const daemonLong = spawnSync(process.execPath, [path.join(distDir, 'daemon.js'), longConfig], {
  env: capped.env, encoding: 'utf8'
});
check(
  daemonLong.status === 1 && /"dataDir" is too long/.test(daemonLong.stderr),
  'and the daemon refuses to start on the same config, rather than binding a truncated address'
);
check(
  !fs.existsSync(path.join(longDir, 'data')),
  'nothing was created for it — the refusal happens before any directory is made'
);

// The `npm link` shape: the bin is a symlink to dist/cli.js, so the
// direct-invocation guard only agrees with itself after resolving paths.
// Proven by running through one rather than by reasoning about it.
const linkPath = path.join(scratch, 'crabcast-link');
fs.symlinkSync(cliJs, linkPath);
const viaLink = spawnSync(process.execPath, [linkPath, '--help'], { env: capped.env, encoding: 'utf8' });
check(
  viaLink.status === EXIT.OK && viaLink.stdout.trim() === renderHelp().trim(),
  'invoked through a symlink (the npm link path) the CLI runs — it does not exit 0 having done nothing'
);

// =============================================================================
rule('9. A relative path is refused by every verb, and each client resolves against ITS OWN cwd');
// =============================================================================
//
// This section exists because the fix it covers had no test. Two mutations
// against a fresh clone proved that rather than argued it: deleting the
// `isAbsolute` refusal from identity.js, and reverting the CLI's
// `agentPathOf` and the MCP server's `agentPath()` to return the raw string —
// the exact round-1 blocker — and the whole CI suite stayed green through
// both. A fix for a verified defect rested entirely on a reviewer having read
// it. A check that cannot fail is not a check.
//
// The fixture is the failure itself rather than a proxy for it. TWO
// directories are named `victim`: one under the daemon's cwd, one under a
// client's. The daemon is detached and inherits its cwd from whichever call
// first spawned it — here, deliberately, the first one — so if a relative
// path ever reaches `path.resolve` on the daemon side, `victim` means the
// daemon's namesake no matter who asked. Every check below is about which of
// those two directories a request lands on.
//
// It also covers the narrower half of the same bug: `addressOfRequest`'s
// lexical fallback. `forget`, `deactivate` and `status` must keep working
// after a caller deletes a directory, so they fall back to a lexical resolve
// — and that fallback caught every PathError, including `not-absolute`. So
// the rule identity.ts states by name was true in seven verbs and false in
// three, and the three were the ones that mutate or read a record without
// needing the directory to exist. `PathError` now carries a discriminable
// `problem`; only `does-not-exist` may fall back. Both halves are here
// because they are one question — does a relative path ever get resolved
// somewhere other than the caller's own cwd — and it has to be answered no in
// every verb and every client at once.

const rel = fixture('relative-paths');

const daemonCwd = path.join(scratch, 'relative-daemon-cwd');
const clientCwd = path.join(scratch, 'relative-client-cwd');
fs.mkdirSync(path.join(daemonCwd, 'victim'), { recursive: true });
fs.mkdirSync(path.join(clientCwd, 'victim'), { recursive: true });
const daemonVictim = fs.realpathSync(path.join(daemonCwd, 'victim'));
const clientVictim = fs.realpathSync(path.join(clientCwd, 'victim'));

// The FIRST call, from the daemon's cwd — this is what spawns the daemon
// there. Absolute path, so it is a legitimate configure; the label is how
// every later check names which directory it reached.
const cfgDaemonSide = crabcast(
  rel,
  ['configure', daemonVictim, '--priority', '5', '--launcher', 'shell', '--label', 'DAEMON-CWD VICTIM'],
  {},
  daemonCwd
);
check(cfgDaemonSide.code === EXIT.OK, 'a real agent is configured at <daemon cwd>/victim');

const cfgClientSide = crabcast(
  rel,
  ['configure', clientVictim, '--priority', '5', '--launcher', 'shell', '--label', 'CLIENT-CWD VICTIM'],
  {},
  clientCwd
);
check(cfgClientSide.code === EXIT.OK, 'and a second, different agent at <client cwd>/victim');
show(
  'two agents, same relative name, different directories:',
  `${daemonVictim}   (DAEMON-CWD VICTIM)\n${clientVictim}   (CLIENT-CWD VICTIM)`
);

// The premise, measured rather than assumed. If the daemon did NOT inherit
// daemonCwd then every check below would pass for the wrong reason — a
// relative path would resolve somewhere neither directory is, and "it did not
// reach the daemon-cwd victim" would be true by accident.
// `trackDaemon`, not a bare `raw`: this fixture spawns a daemon like every
// other one, and a detached daemon nobody remembers outlives the script.
const dstatus = await trackDaemon(rel);
const procCwd = `/proc/${dstatus.pid}/cwd`;
if (fs.existsSync(procCwd)) {
  check(
    fs.realpathSync(fs.readlinkSync(procCwd)) === fs.realpathSync(daemonCwd),
    `the daemon's own cwd IS ${daemonCwd} — so a daemon-side resolve would land on its victim`
  );
} else {
  console.log('  SKIP  /proc unavailable; cannot read the daemon cwd directly on this platform');
}

// --- 9a. The three verbs that fall back. -------------------------------------
//
// Raw socket, so no client is between the relative string and the router.
// Each one is checked twice: refused BY NAME, and the daemon-cwd record still
// there afterwards. The second check is the one that describes the damage —
// before the fix, `forget_agent` with `path: 'victim'` resolved onto a
// stranger's real agent and deleted its record.

for (const action of ['forget_agent', 'deactivate_agent', 'agent_status']) {
  const res = await raw(rel, action, { path: 'victim' });
  check(
    res.success === false && /is not absolute/.test(String(res.error)),
    `${action} refuses a relative path by name (it falls back lexically, and must not for this)`
  );
}

// `success` is TRUE, and that changed with the config echo: a record is an
// answer. `agent_status` used to fail whenever herdr had no pane — true of
// every configured-and-stopped agent — which made a stopped agent's
// configuration unreadable through the one verb that addresses a single agent.
// `success` is now about whether the question could be answered; liveness is
// what `state` and `herdrStatus` say. Only a path with neither a record nor a
// pane fails, and only that means the caller mistyped.
//
// `configured` and `state` are the record, and the record is the subject here:
// "this agent is configured and not running" stays distinguishable from "there
// is no such agent" (router.ts).
const survived = await raw(rel, 'agent_status', { path: daemonVictim });
check(
  survived.success === true &&
    survived.configured === true && survived.state === 'unstarted' && survived.path === daemonVictim,
  'and the daemon-cwd agent still has its record — no relative request ever landed on it'
);
check(
  survived.config?.launcher === 'shell' && typeof survived.configVersion === 'number',
  'and the record is ECHOED rather than merely acknowledged: a stopped agent still reads ' +
    'back its own configuration'
);
// The one case that IS a failure, so `success: true` above is a decision
// rather than a check that cannot fail.
const neverHeardOf = await raw(rel, 'agent_status', { path: path.join(scratch, 'no-such-agent-here') });
check(
  neverHeardOf.success === false && neverHeardOf.state === 'unconfigured',
  'while a path with neither a record nor a pane still fails — the answer that means you mistyped'
);

// --- 9b. Every other verb that takes a path. ---------------------------------
//
// These were already strict, and the point of listing them is universality:
// identity.ts:96-98 promises a relative path is "refused by name rather than
// silently resolved somewhere plausible", and a promise that holds in seven
// verbs out of ten is the shape this whole section is about.

for (const [action, extra] of [
  ['configure_agent', { priority: 5, launcher: 'shell' }],
  ['activate_agent', {}],
  ['send_to_agent', { message: 'hello' }],
  ['tail_agent', { lines: 5 }]
]) {
  const res = await raw(rel, action, { path: 'victim', ...extra });
  check(
    res.success === false && /is not absolute/.test(String(res.error)),
    `${action} refuses a relative path by name`
  );
}

// The refusal is worth reading once: it is what teaches a caller to resolve
// their own paths, and it has to say why rather than just no.
show('the refusal, verbatim:', (await raw(rel, 'forget_agent', { path: 'victim' })).error);

// --- 9c. The fallback still does the job it was written for. -----------------
//
// Narrowing it would be no fix at all if it broke this: a caller who has
// deleted a directory must still be able to say "stop expecting this", and
// that is precisely when they ask. Absolute path, directory gone.

const goneParent = path.join(scratch, 'relative-gone');
fs.mkdirSync(path.join(goneParent, 'temp'), { recursive: true });
const gonePath = fs.realpathSync(path.join(goneParent, 'temp'));
crabcast(rel, ['configure', gonePath, '--priority', '5', '--launcher', 'shell', '--label', 'DELETED']);
fs.rmSync(gonePath, { recursive: true, force: true });

const statusOfGone = await raw(rel, 'agent_status', { path: gonePath });
check(
  statusOfGone.configured === true && statusOfGone.path === gonePath,
  'status on a DELETED directory still finds the record — the fallback is narrowed, not removed'
);
const forgetGone = await raw(rel, 'forget_agent', { path: gonePath });
check(
  forgetGone.success === true,
  'and forget on a deleted directory still succeeds, which is the whole reason the fallback exists'
);

// --- 9d. The CLI resolves before the wire. -----------------------------------
//
// The same relative operand, from the client's cwd. The daemon can no longer
// resolve it at all, so the only way this can succeed is if the CLI did.

const relViaCli = crabcast(rel, ['status', 'victim', '--json'], {}, clientCwd);
let cliJson = null;
try { cliJson = JSON.parse(relViaCli.stdout); } catch {}
check(
  cliJson?.path === clientVictim,
  `the CLI resolves 'victim' against its own cwd before sending: got ${cliJson?.path}`
);
check(
  cliJson?.configured === true && cliJson?.path !== daemonVictim,
  'and it reached the CLIENT-cwd agent — a real, different record — not the daemon-cwd namesake'
);

// --- 9e. The MCP server resolves before the wire. ----------------------------
//
// A second client, with its own cwd, and the same question. Both clients were
// reverted together in the mutation that stayed green, so both are covered.

class MiniMcp {
  constructor(cwd, env) {
    this.child = spawn(process.execPath, [path.join(distDir, 'mcp.js')], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.id = 0;
    this.pending = new Map();
    this.child.stderr.on('data', () => {});
    let buf = '';
    this.child.stdout.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && this.pending.has(m.id)) {
          const { resolve, timer } = this.pending.get(m.id);
          this.pending.delete(m.id); clearTimeout(timer); resolve(m.result ?? m.error);
        }
      }
    });
  }
  request(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 30_000);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  kill() { try { this.child.kill(); } catch {} }
}

const mcp = new MiniMcp(clientCwd, { ...rel.env, CRABCAST_CONFIG: rel.configPath });
await mcp.request('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'verify-cli-refusal §9', version: '0.0.0' }
});
mcp.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const mcpRes = await mcp.request('tools/call', {
  name: 'crabcast_agent_status', arguments: { path: 'victim' }
});
mcp.kill();
const mcpText = String(mcpRes?.content?.[0]?.text ?? JSON.stringify(mcpRes));
check(
  mcpText.includes(clientVictim) && !mcpText.includes(daemonVictim),
  'the MCP server resolves against ITS cwd too — it reached the client-cwd agent, not the namesake'
);
check(
  !/is not absolute/.test(mcpText),
  'and the daemon never saw a relative path from it, so the refusal never fired'
);

// ------------------------------------------------------------------- verdict

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
