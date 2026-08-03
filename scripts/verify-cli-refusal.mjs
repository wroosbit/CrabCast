#!/usr/bin/env node
// Live proof (KAN-93) for the half of the CLI contract that a machine can
// check without a real herdr: a refusal is legible and non-zero, `--json` is
// the daemon's response and nothing else, the exit codes mean what `--help`
// says they mean, and `--override`/`--preempt` cross the wire as real
// booleans.
//
// Six sections:
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

import { spawnSync } from 'child_process';
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
function fixture(name, types, env = {}) {
  const dir = path.join(scratch, name);
  const dataDir = path.join(dir, 'data');
  // Its own shim state as well as its own dataDir: the shim records started
  // agents on disk, and one shared file would have each fixture's daemon
  // counting every other fixture's agents against its cap.
  const state = path.join(dir, 'shim-state');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const type of types) {
    fs.writeFileSync(path.join(dir, 'prompts', `${type.name}.md`), `KAN-93 proof workspace {{KEY}}.\n`);
  }
  const configPath = path.join(dir, 'crabcast.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    workspaceTypes: types.map((t) => ({
      name: t.name,
      priority: t.priority,
      promptFile: `prompts/${t.name}.md`,
      defaultLauncher: 'shell',
      mcpServers: [],
      gateExempt: false
    }))
  }, null, 2));
  return {
    name,
    configPath,
    dataDir,
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

/** Run the CLI as a human would, and hand back everything it produced. */
function crabcast(fx, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cliJs, ...args, '--config', fx.configPath], {
    env: { ...fx.env, ...extraEnv },
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

const capped = fixture('capped', [{ name: 'shell', priority: 1 }], CAP_ZERO);

// Two invocations, because one process prints one of the two modes. Their
// figures come from two readings of a live machine a second apart, so load
// average and available memory can genuinely move between them — retried
// rather than tolerated, because the assertion being made is byte equality
// and weakening it would prove nothing.
let human = null;
let asJson = null;
for (let attempt = 1; attempt <= 5; attempt++) {
  human = crabcast(capped, ['activate', 'shell', 'demo']);
  const jsonRun = crabcast(capped, ['activate', 'shell', 'demo', '--json']);
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

show('the session, unedited:', `$ CRABCAST_MAX_AGENTS=0 crabcast activate shell demo\n${human.stdout}$ echo $?\n${human.code}`);

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
}), { type: 'task', key: 'KAN-93' }));
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
  type: 'shell',
  key: 'demo',
  sessionId: 's1',
  status: 'active',
  verified: true,
  somethingTheCliHasNeverHeardOf: 'must still be visible'
}), { type: 'shell', key: 'demo' }));
check(
  withUnknown.includes('somethingTheCliHasNeverHeardOf') && withUnknown.includes('must still be visible'),
  'an unrecognised response field is printed, not silently dropped'
);

// ---------------------------------------------------------------- 3. --json

rule('3. --json — the daemon\'s response, field for field, unmodified');

const wire = await raw(capped, 'activate_by_key', { type: 'shell', key: 'demo' });
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
codes.push(['2 usage (missing operand)', crabcast(capped, ['activate', 'shell']), EXIT.USAGE]);
codes.push(['2 usage (unknown command)', crabcast(capped, ['frobnicate']), EXIT.USAGE]);
codes.push(['2 usage (unknown flag)', crabcast(capped, ['list', '--colour']), EXIT.USAGE]);

// Nothing has ever run in this data dir, and `list` does not start a daemon.
const cold = fixture('cold', [{ name: 'shell', priority: 1 }]);
const transport = crabcast(cold, ['list']);
codes.push(['3 transport (no daemon, and list does not start one)', transport, EXIT.TRANSPORT]);

// A config that was NAMED and will not load: a refusal, never a fallback onto
// whatever daemon happens to be running somewhere else.
const brokenConfig = path.join(scratch, 'broken.config.json');
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
  /priority/.test(codes[codes.length - 1][1].stderr),
  'the config refusal repeats the loader\'s own complaint rather than inventing one'
);

// ------------------------------------------------------------------ 5. flags

rule('5. --override AND --preempt — real booleans, proven in both directions');

// (a) --override, against a daemon whose cap is zero: the only way anything
//     starts here is the flag arriving as a boolean true. The router refuses a
//     non-boolean before it looks anything up (invalidFlag), so a CLI that
//     forwarded the string "true" would be refused instead.
const overrides = fixture('override', [{ name: 'shell', priority: 1 }], CAP_ZERO);
const overrode = crabcast(overrides, ['activate', 'shell', 'kept', '--override']);
await trackDaemon(overrides);
show('$ crabcast activate shell kept --override', overrode.stdout + overrode.stderr);
check(overrode.code === EXIT.OK, `--override starts an agent past a cap of 0 (exit ${overrode.code})`);
check(/started past the cap on purpose/.test(overrode.stdout), 'the override is reported, with the figures it bypassed');

const overrideFalse = crabcast(overrides, ['activate', 'shell', 'notkept', '--override=false']);
show('$ crabcast activate shell notkept --override=false', overrideFalse.stdout + overrideFalse.stderr);
check(overrideFalse.code === EXIT.REFUSED, '--override=false is a real false: the activation is refused');
check(
  !/Invalid override/.test(overrideFalse.stdout),
  'and it is refused BY CAPACITY, not as an invalid flag — the wire carried a boolean, not the string "false"'
);

const overrideJunk = crabcast(overrides, ['activate', 'shell', 'junk', '--override=yes']);
check(overrideJunk.code === EXIT.USAGE, '--override=yes is a usage error (exit 2) that never reaches the daemon');
show('$ crabcast activate shell junk --override=yes', overrideJunk.stderr.trim());

// (b) --preempt, end to end: one agent running, a higher-priority activation
//     refused with a preemption offer, then the same call with the flag.
//     Costs are pinned tiny so the cap — not this machine's live load — is
//     what binds, which is the constraint the preemption is about.
const fleet = fixture(
  'preempt',
  [{ name: 'shell', priority: 1 }, { name: 'boss', priority: 5 }],
  { CRABCAST_MAX_AGENTS: '1', CRABCAST_AGENT_CORES: '0.01', CRABCAST_AGENT_MEMORY_MB: '1' }
);
const first = crabcast(fleet, ['activate', 'shell', 'humble']);
await trackDaemon(fleet);
check(first.code === EXIT.OK, `the one slot is taken by shell/humble (exit ${first.code})`);

const refusedForRoom = crabcast(fleet, ['activate', 'boss', 'chief']);
show('$ crabcast activate boss chief', refusedForRoom.stdout);
check(refusedForRoom.code === EXIT.REFUSED, 'a second activation is refused: the cap is 1');
check(
  /preemption available/.test(refusedForRoom.stdout) && /shell\/humble/.test(refusedForRoom.stdout),
  'the refusal names the agent that could be stood down, by address'
);

const preemptFalse = crabcast(fleet, ['activate', 'boss', 'chief', '--preempt=false']);
check(preemptFalse.code === EXIT.REFUSED, '--preempt=false is a real false: still refused');
check(
  !/Invalid preempt/.test(preemptFalse.stdout),
  'and refused by capacity rather than by the router\'s flag validation'
);

const preempted = crabcast(fleet, ['activate', 'boss', 'chief', '--preempt']);
show('$ crabcast activate boss chief --preempt', preempted.stdout);
check(preempted.code === EXIT.OK, `--preempt makes room and the activation succeeds (exit ${preempted.code})`);
check(
  /preempted to make room/.test(preempted.stdout) && /shell\/humble/.test(preempted.stdout),
  'the CLI says whose work was interrupted, by address'
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

// ------------------------------------------------------------------- verdict

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
