#!/usr/bin/env node
// Live proof (KAN-102) that the herdr version verdict reaches a person, and
// that what it says is what the evidence supports.
//
// Two defects are being proven fixed, and they are separate:
//
//   1. THE VERDICT REACHED NOBODY. The daemon read `herdr --version`, called
//      checkHerdrVersion, and wrote the answer to <dataDir>/daemon.log — a
//      file inside a directory a new user does not know exists, written by a
//      process that was spawned detached and has no terminal. A user on an
//      unverified herdr got a failed activation and a perfectly good
//      explanation they would never read.
//
//   2. THE MESSAGE OVERCLAIMED. It told a 0.8 user that "every activation
//      will fail with 'unknown option: --cwd'" — a failure observed on 0.7.5,
//      on a clean machine (KAN-33), asserted as certain for a version nobody
//      has ever run. Deferring 0.7/0.8 validation was a schedule decision, not
//      a finding (KAN-59 decision 7).
//
//      KAN-181 CLOSED THAT GAP FROM THE OTHER END, and this script moved with
//      it. 0.8.0 has now been run — `scripts/verify-herdr-release.mjs`, against
//      a real private herdr 0.8.0 server — and it fails exactly as 0.7.5 does.
//      So the 0.8.0 verdict is now a FINDING and section 1 requires it to read
//      like one, while a release nobody has run (0.8.1, 1.2.0) must still not
//      be predicted. The rule did not change: say what was seen, on the release
//      it was seen on, and nothing wider.
//
// Six sections:
//
//   1. bands        — checkHerdrVersion, the one version comparison, across
//                     every band: 0.6.x silent, 0.7.x specific and evidenced,
//                     0.8.0 observed-broken with its evidence, everything else
//                     above the line untested-not-predicted, below 0.6 unchanged
//   2. 0.8.0 live   — a shimmed herdr reporting 0.8.0: the notice arrives on a
//                     normal command, and the activation PROCEEDS (no refusal)
//   3. 0.6.4 live   — the supported release produces no notice anywhere: not
//                     on stdout, not on stderr, not in the JSON, not in the log
//   4. 0.7.5 live   — the specific --cwd claim still arrives, evidence intact
//   5. one rule     — exactly one version comparison exists in src/: nothing
//                     outside herdr-health.ts compares a herdr version, and
//                     the CLI renders a sentence it did not write
//   6. still logged — surfacing did not replace the log line; both happen
//
// Everything on the daemon side is real: the real daemon (spawned by the CLI
// itself, which is how a human gets one), the real router, config loader,
// registry and herdr bridge, real NDJSON over a real unix socket. What is
// faked is the `herdr` binary — a shim on PATH whose only interesting property
// here is what it prints for `--version`.
//
// It never touches the machine's real herdr: each fixture runs with a scratch
// $HOME and a PATH holding the shim plus system directories, so the daemon's
// PATH normalization (env.ts, which searches ~/.local/bin) cannot rediscover
// an installed one.
//
// Usage:
//   npm run build
//   node scripts/verify-herdr-version-notice.mjs [distDir]

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoDir, 'dist'));
const cliJs = path.join(distDir, 'cli.js');

const { EXIT } = await import(path.join(distDir, 'cli.js'));
const {
  HERDR_VERSION_NOTICE_FIELD,
  SUPPORTED_HERDR_MAJOR_MINOR,
  VERIFIED_HERDR_RELEASE,
  checkHerdrVersion
} = await import(path.join(distDir, 'herdr-health.js'));
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

// --------------------------------------------------------------- the scratch

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-verify-version-'));
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

// ------------------------------------------------------------------ the shim
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs, and
// answering `--version` with whatever the fixture that started the daemon put
// in CRABCAST_VERIFY_SHIM_VERSION. Everything else it does is the same in all
// three fixtures — the version is the ONLY variable in this script, which is
// what makes "the activation proceeded on 0.8" mean something.

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
  process.stdout.write((process.env.CRABCAST_VERIFY_SHIM_VERSION ?? 'herdr 0.6.4') + '\\n');
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
  out({ result: { read: { text: \`KAN-102 pane text for \${args[2]}\`, truncated: false } } });
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

// ------------------------------------------------------------------ fixtures

/**
 * One daemon's worth of scratch, pinned to one reported herdr version.
 *
 * The version is fixed for a daemon's whole life by whichever invocation
 * happened to start it — the verdict is computed once, at startup — so the
 * environment belongs to the fixture and every call against it carries the
 * same one.
 *
 * The capacity levers are pinned tiny for the same reason the other verify
 * scripts pin them: this script is about a version notice, and an activation
 * refused because the runner was busy would be a red check about the machine.
 */
function fixture(name, herdrVersion) {
  const dir = path.join(scratch, name);
  const dataDir = path.join(dir, 'data');
  const state = path.join(dir, 'shim-state');
  fs.mkdirSync(state, { recursive: true });
  const configPath = path.join(dir, 'crabcast.config.json');
  // A dataDir and nothing else — there is no type table left to declare.
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const agentDir = path.join(dir, 'owned', 'demo');
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    name,
    herdrVersion,
    configPath,
    dataDir,
    state,
    /** The directory this fixture's one agent runs in. Its whole address. */
    agentPath: fs.realpathSync(agentDir),
    logPath: path.join(dataDir, 'daemon.log'),
    env: {
      ...process.env,
      HOME: fakeHome,
      SHELL: '/bin/bash',
      PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
      CRABCAST_VERIFY_SHIM_STATE: state,
      CRABCAST_VERIFY_SHIM_VERSION: herdrVersion,
      CRABCAST_CONFIG: undefined,
      CRABCAST_MAX_AGENTS: '4',
      CRABCAST_AGENT_CORES: '0.01',
      CRABCAST_AGENT_MEMORY_MB: '1'
    }
  };
}

/** Run the CLI as a human would, and hand back everything it produced. */
function crabcast(fx, args) {
  const result = spawnSync(process.execPath, [cliJs, '--config', fx.configPath, ...args], {
    env: fx.env,
    encoding: 'utf8',
    timeout: 120_000
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The session a human would have seen, both streams, in order. */
function session(fx, args, run) {
  return [
    `$ crabcast ${args.join(' ')}`,
    run.stderr.trimEnd(),
    run.stdout.trimEnd(),
    `$ echo $?`,
    String(run.code)
  ].filter((l) => l.length).join('\n');
}

let rawRequestId = 0;

/** A raw socket round trip — the wire, unmediated by any renderer. */
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

const readLog = (fx) => {
  try { return fs.readFileSync(fx.logPath, 'utf8'); } catch { return ''; }
};

console.log(`cli under test: ${cliJs}`);
console.log(`fake herdr:     ${path.join(shimDir, 'herdr')}`);
console.log(`scratch:        ${scratch}`);
console.log(`the one rule:   checkHerdrVersion (src/herdr-health.ts), supported line ` +
            `${SUPPORTED_HERDR_MAJOR_MINOR}.x, verified release ${VERIFIED_HERDR_RELEASE}`);

// ------------------------------------------------------------- 1. the bands

rule('1. THE BANDS — one comparison, three verdicts, each carrying its own evidence');

const verdicts = [
  ['herdr 0.6.4', 'the verified release'],
  ['herdr 0.6.0', 'the supported line, lower patch'],
  ['herdr 0.6.10', 'the supported line, the other release that was run'],
  ['herdr 0.6.11', 'the supported line, higher patch'],
  ['herdr 0.7.0', 'the redesign line'],
  ['herdr 0.7.5', 'the redesign line, as observed'],
  ['herdr 0.8.0', 'above the redesign line, and RUN (KAN-181)'],
  ['herdr 0.8.1', 'next to a release that was run, and not run itself'],
  ['herdr 1.2.0', 'well above it, untouched'],
  ['herdr 0.5.9', 'below the supported line'],
  ['herdr (unreleased build)', 'unparseable']
].map(([version, label]) => ({ version, label, verdict: checkHerdrVersion(version) }));

for (const { version, label, verdict } of verdicts) {
  show(`${version}  (${label})`, verdict ?? '(no notice)');
}

const verdictFor = (version) => verdicts.find((v) => v.version === version).verdict;

check(
  ['herdr 0.6.4', 'herdr 0.6.0', 'herdr 0.6.10', 'herdr 0.6.11'].every((v) => verdictFor(v) === undefined),
  'every 0.6.x is silent — the supported configuration produces no notice at all'
);
// Said out loud because it is the one place this module is deliberately wider
// than its evidence: 0.6.0 and 0.6.11 are silent and nobody has run either. The
// README carries that fact where a reader is choosing a version; the daemon
// does not fire a notice at a user whose herdr is probably fine.
console.log('        (0.6.4 and 0.6.10 were run; the rest of the line is silent on no evidence either way — README.md is where that is stated)');
check(
  verdictFor('herdr (unreleased build)') === undefined,
  'an unreadable version is silent too: an unknown is not evidence of a problem'
);

const sevenFive = verdictFor('herdr 0.7.5');
check(/--cwd/.test(sevenFive) && /unknown option/.test(sevenFive), '0.7.5 keeps the specific claim: activations fail with `unknown option: --cwd`');
check(/0\.7\.5/.test(sevenFive) && /KAN-33/.test(sevenFive), 'and it carries the evidence it rests on — observed on 0.7.5, KAN-33');
check(/agent start/.test(sevenFive) && /--kind/.test(sevenFive), 'naming the mechanism: `agent start` was redesigned around --kind/--pane');
check(verdictFor('herdr 0.7.0') !== undefined, '0.7.0 gets the same band as 0.7.5 — the redesign is the line, not the patch');

const eight = verdictFor('herdr 0.8.0');
check(/was RUN against CrabCast/.test(eight) && /failed with 'unknown option: --cwd'/.test(eight),
  '0.8.0 states a FINDING: it was run, and this is what happened');
check(/KAN-181/.test(eight) && /2026-08-05/.test(eight),
  'and carries the evidence it rests on — the run, and when');
check(!/may well work/.test(eight) && !/nobody has (looked|run)/.test(eight),
  'it no longer calls 0.8.0 an unknown: somebody looked, and saying otherwise would be the KAN-102 defect pointing backwards');
check(new RegExp(VERIFIED_HERDR_RELEASE.replace(/\./g, '\\.')).test(eight), `and names ${VERIFIED_HERDR_RELEASE} as a release CrabCast was run against`);

// The other side of the same rule, and the one that keeps this honest: a
// release NOBODY has run must still not be predicted, however strong the prior.
const untested = verdictFor('herdr 1.2.0');
check(untested !== undefined, '1.2.0 still gets a verdict — the band is "above 0.7", not "0.8.0 exactly"');
check(/not been tested/.test(untested) && /above the herdr line/.test(untested),
  '1.2.0 says it is ABOVE the verified line and UNTESTED');
check(
  !/every activation will fail/.test(untested) && !/will fail/.test(untested),
  'and does NOT assert that its activations will fail — nobody has run it, and a prediction nobody checked is not a finding'
);
check(/may well work/.test(untested), 'it says so in as many words: an unknown, not a known breakage');
check(/0\.7\.5, 0\.8\.0/.test(untested),
  'while still handing over the prior — the releases above the line that WERE run, named');
check(verdictFor('herdr 0.8.1') === untested.replace('1.2.0', '0.8.1'),
  '0.8.1 gets that same untested verdict: being next to 0.8.0 is not the same as having been run');

const old = verdictFor('herdr 0.5.9');
check(/older than/.test(old), 'below 0.6 is unchanged: older than the supported line');

// ---------------------------------------------------------------- 2. 0.8.0

rule('2. 0.8.0 LIVE — the notice reaches a person, and the activation PROCEEDS');

const eightFx = fixture('untested', 'herdr 0.8.0');
// `configure` is mandatory now, so the activation this section is about needs
// a record first. It is a separate call and its own daemon round trip, which
// is also the first response of the connection — the notice rides that one.
crabcast(eightFx, ['configure', eightFx.agentPath, '--priority', '1', '--launcher', 'shell']);
// `--override`: the capacity gate reads the real machine, and this script is
// about a version notice. An activation refused because the runner was busy
// would be a red check about the machine rather than about the notice.
const eightArgs = ['activate', eightFx.agentPath, '--override'];
const eightRun = crabcast(eightFx, eightArgs);
await trackDaemon(eightFx);

show('the session (both streams as captured, stderr first):', session(eightFx, eightArgs, eightRun));

check(
  eightRun.stderr.includes('was RUN against CrabCast and every activation failed'),
  'a normal command carries the notice to the terminal — not only to a log file nobody opens'
);
check(
  eightRun.stderr.includes('herdr 0.8.0'),
  'and it names the version that is actually installed'
);
check(
  eightRun.code === EXIT.OK,
  `NO HARD REFUSAL: the activation proceeded and exited ${EXIT.OK} (got ${eightRun.code})`
);
check(
  /status:\s+active/.test(eightRun.stdout) || /active/.test(eightRun.stdout),
  'the agent really started — the notice is a notice, not a gate'
);

// The second command matters as much as the first: the daemon is already
// running by now, so this is the ordinary case — someone who types a command
// at a daemon that has been up for a week still hears about it.
const eightSecondArgs = ['list'];
const eightSecond = crabcast(eightFx, eightSecondArgs);
show('a second, read-only command against the daemon that is already up:', session(eightFx, eightSecondArgs, eightSecond));
check(
  eightSecond.stderr.includes('was RUN against CrabCast and every activation failed'),
  'the next command hears it too: the notice rides the first response of every connection, not just the one that started the daemon'
);
check(eightSecond.code === EXIT.OK, `and that command works normally (exit ${eightSecond.code})`);

// `--json` is the wire, and stdout must stay parseable: the notice is a field
// there, and the rendered sentence went to stderr.
const eightJson = crabcast(eightFx, ['list', '--json']);
let parsed = null;
try { parsed = JSON.parse(eightJson.stdout); } catch {}
check(parsed !== null, '--json stdout still parses as JSON and nothing else — the notice did not land in it');
check(
  typeof parsed?.[HERDR_VERSION_NOTICE_FIELD] === 'string',
  `the response itself carries the verdict, on \`${HERDR_VERSION_NOTICE_FIELD}\` — the daemon computed it, the CLI only printed it`
);
check(
  parsed?.[HERDR_VERSION_NOTICE_FIELD] === verdictFor('herdr 0.8.0'),
  'and the sentence on the wire is byte for byte the one checkHerdrVersion produced'
);

// ---------------------------------------------------------------- 3. 0.6.4

rule('3. 0.6.4 LIVE — the supported release produces NO notice anywhere');

const goodFx = fixture('verified', 'herdr 0.6.4');
crabcast(goodFx, ['configure', goodFx.agentPath, '--priority', '1', '--launcher', 'shell']);
// `--override`: the capacity gate reads the real machine, and this script is
// about a version notice. An activation refused because the runner was busy
// would be a red check about the machine rather than about the notice.
const goodArgs = ['activate', goodFx.agentPath, '--override'];
const goodRun = crabcast(goodFx, goodArgs);
await trackDaemon(goodFx);

show('the session (both streams as captured, stderr first):', session(goodFx, goodArgs, goodRun));

check(goodRun.code === EXIT.OK, `the activation succeeds (exit ${goodRun.code})`);
check(goodRun.stderr.trim() === '', 'stderr is EMPTY — nothing was said about the version at all');
check(
  !/verified against|not been tested|older than|unknown option/.test(goodRun.stdout),
  'and stdout carries no version verdict either — not the notice, not a softened version of it'
);

const goodJson = crabcast(goodFx, ['list', '--json']);
let goodParsed = null;
try { goodParsed = JSON.parse(goodJson.stdout); } catch {}
check(
  goodParsed !== null && goodParsed[HERDR_VERSION_NOTICE_FIELD] === undefined,
  `the response has no \`${HERDR_VERSION_NOTICE_FIELD}\` field: there is nothing to render, so nothing is sent`
);
check(goodJson.stderr.trim() === '', 'a second command is silent too — this is not a once-per-daemon suppression, there is simply no verdict');

const goodLog = readLog(goodFx);
check(/herdr version: herdr 0\.6\.4/.test(goodLog), 'the daemon did read the version (it is in the log)');
check(!/WARNING: herdr 0\.6\.4/.test(goodLog), 'and said nothing about it — a notice that fires for the supported configuration teaches people to ignore notices');

// ---------------------------------------------------------------- 4. 0.7.5

rule('4. 0.7.5 LIVE — the specific, evidenced claim still arrives');

const sevenFx = fixture('redesign', 'herdr 0.7.5');
crabcast(sevenFx, ['configure', sevenFx.agentPath, '--priority', '1', '--launcher', 'shell']);
// `--override`: the capacity gate reads the real machine, and this script is
// about a version notice. An activation refused because the runner was busy
// would be a red check about the machine rather than about the notice.
const sevenArgs = ['activate', sevenFx.agentPath, '--override'];
const sevenRun = crabcast(sevenFx, sevenArgs);
await trackDaemon(sevenFx);

show('the session (both streams as captured, stderr first):', session(sevenFx, sevenArgs, sevenRun));

check(sevenRun.stderr.includes('unknown option: --cwd'), 'the terminal gets the exact symptom a 0.7 user will see: `unknown option: --cwd`');
check(sevenRun.stderr.includes('KAN-33'), 'with the evidence intact — observed on a clean machine, KAN-33');
check(sevenRun.stderr.includes('herdr 0.7.5'), 'and the installed version named');
check(sevenRun.code === EXIT.OK, `still no hard refusal here either (exit ${sevenRun.code}) — CrabCast reports, it does not veto`);

// --------------------------------------------------------------- 5. one rule

rule('5. ONE RULE, ONE PLACE — exactly one version comparison exists in src/');

const srcFiles = fs.readdirSync(path.join(repoDir, 'src')).filter((f) => f.endsWith('.ts'));
// Comments are stripped before scanning: a file is allowed to *explain* the
// rule (daemon.ts and cli.ts both do), and what this section is looking for is
// a second copy of it in code.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = new Map(srcFiles.map((f) => [f, stripComments(fs.readFileSync(path.join(repoDir, 'src', f), 'utf8'))]));

const VERSION_IDENTIFIERS = /parseHerdrVersion|SUPPORTED_HERDR_MAJOR_MINOR|HERDR_AGENT_START_REDESIGN_MAJOR_MINOR|VERIFIED_HERDR_RELEASE/;
const elsewhere = [...code].filter(([f, text]) => f !== 'herdr-health.ts' && VERSION_IDENTIFIERS.test(text));
check(
  elsewhere.length === 0,
  `no file but herdr-health.ts touches the version constants or the parser${elsewhere.length ? `: ${elsewhere.map(([f]) => f).join(', ')}` : ''}`
);

// A quoted herdr version literal in code, anywhere but the one module: the
// shape a second copy of the rule would have, whether it compared or merely
// told somebody which version to install. Two scopings keep it honest —
// the line must mention herdr (`version: "0.1.0"` in mcp.ts is this project's
// own MCP server version), and the number must be quoted (`HERDR_OVERHEAD_CORES
// = 0.5` in capacity.ts is a core count, not a version).
const QUOTED_VERSION = /['"`][^'"`]*\d+\.\d+/;
const literals = [...code].flatMap(([f, text]) =>
  f === 'herdr-health.ts'
    ? []
    : text
        .split('\n')
        .filter((l) => /herdr/i.test(l) && QUOTED_VERSION.test(l))
        .map((l) => `${f}: ${l.trim()}`)
);
check(
  literals.length === 0,
  `and no file but herdr-health.ts writes a herdr version number into code${literals.length ? `:\n        ${literals.join('\n        ')}` : ''}`
);

const definitions = [...code].filter(([, text]) => /function checkHerdrVersion/.test(text));
const callers = [...code].filter(([, text]) => /checkHerdrVersion\(/.test(text) && !/function checkHerdrVersion/.test(text));
check(
  definitions.length === 1 && definitions[0][0] === 'herdr-health.ts',
  `checkHerdrVersion is defined exactly once, in ${definitions.map(([f]) => f).join(', ') || '(nowhere)'}`
);
check(
  callers.length === 1 && callers[0][0] === 'daemon.ts',
  `and called from exactly one place: ${callers.map(([f]) => f).join(', ') || '(nowhere)'} — the daemon decides, and it decides once`
);
check(
  code.get('cli.ts').includes('HERDR_VERSION_NOTICE_FIELD') &&
    !/checkHerdrVersion|parseHerdrVersion/.test(code.get('cli.ts')),
  'the CLI reads the verdict off the response by its shared field name, and calls no version function of its own — it renders a sentence it did not write'
);

// ------------------------------------------------------------ 6. still logged

rule('6. THE LOG DID NOT LOSE IT — surfacing is in addition to logging, not instead of');

const eightLog = readLog(eightFx);
show('from <dataDir>/daemon.log:', eightLog.split('\n').filter((l) => /herdr version|WARNING: herdr/.test(l)).join('\n'));
check(/WARNING: herdr 0\.8\.0 was RUN against CrabCast/.test(eightLog), 'the daemon still writes the verdict to its log for whoever is reading it there');
check(
  eightRun.stderr.includes('was RUN against CrabCast and every activation failed') &&
    /WARNING: herdr 0\.8\.0/.test(eightLog),
  'both channels carry it: the file for the operator, the terminal for the person who just typed a command'
);

// -------------------------------------------------------------------- verdict

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
