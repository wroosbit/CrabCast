#!/usr/bin/env node
// KAN-302: one row an older CrabCast wrote does not take the daemon off the
// machine, and what it costs instead is disclosed rather than deleted.
//
// WHAT FAILURE THIS WOULD CATCH: a build in which an unreadable registry row
// stops the daemon starting, or in which it starts and says nothing — either
// the refusal coming back, or the disclosure being dropped so that a
// half-loaded registry becomes silent again. Both directions, because the two
// are opposite mistakes and a proof against only one of them licenses the
// other. It would also catch the quiet one underneath both: a compaction that
// carries the loadable rows and discards the unreadable ones, which turns
// "skip the row" into "delete the record" on a 500-record timer.
//
// THE SPECIMEN IS REAL AND IS PASTED IN BELOW, byte for byte. It came off
// `~/.local/share/crabcast/agents.jsonl` on the machine where this was found —
// 131 bytes, one row, written 2026-08-03 by a CrabCast that addressed agents
// by <type>/<key>. The agent it names had ALREADY been deactivated. On
// `origin/main` at 6e92d05 that row was enough to stop the daemon binding its
// socket at all, and the first remedy the refusal printed was "delete
// /home/brooswit/.local/share/crabcast/agents.jsonl and `configure` the fleet
// again" — every other agent record discarded to recover from one dead line.
//
// WHAT THIS SCRIPT SUPPLIES ITS OWN INPUT FOR, AND WHAT THAT LEAVES UNCOVERED
// (the disclosure `prompts/task.md` asks for, and it is not a formality here).
// Every registry in this file is one this script WROTE. So it does not test
// that a row of this shape ever reaches a registry in production — it tests
// what the daemon does with one that has. That gap is covered by observation
// rather than by a sibling script, and the observation is in the pull request:
// the real file on the real machine, run against the real daemon, before and
// after. Nothing in CI can own that half, because the specimen is eight days of
// somebody else's history and CI starts from an empty directory.
//
// §6 mutates the compiled build to restore the refusal and requires §1 to go
// red. That is this file's own answer to "has this assertion ever failed" —
// and it is the weaker of the two available answers. The stronger one is in
// the PR: the same registry file, the same command, run against a build of
// origin/main, which is the behaviour this replaces rather than a re-creation
// of it.
//
// WHAT THIS FILE ASSUMES ABOUT THE MACHINE (KAN-330, and it used to assume far
// more). `PATH` is pinned to a stub herdr plus the system directories before
// the first daemon starts, so no section can reach the host's herdr and no
// verdict here is a statement about which machine ran it. The one thing still
// read off the host is `readFdUsage()`'s /proc scan for a running herdr server,
// which is read-only and which nothing here asserts on. Before KAN-330 this
// file spawned REAL agents into the developer's shared herdr and leaked their
// panes, and its §2 verdict was a race against that server — see the ISOLATION
// block below for the mechanism and the three consequences.
//
// §7 is the red drive for the assertion KAN-330 introduced (§2's append-only
// preservation), because a new check with no history of failing is not yet a
// check. §8 asserts the residue directly — no daemon left running, no socket
// left listening, every pane inside this run's own scratch — rather than
// concluding it from the code, which is what the old file did about the only
// thing it ever cleaned up (its temp directory, which was never what leaked).
//
// WHAT §8 CANNOT DO IN CI, marked because a check that quietly skips is this
// epic's recurring defect: its last assertion — that the HOST's herdr holds no
// pane from this run — needs a host herdr to interrogate, and CI has none. It
// prints NOT RUN there and counts nothing. Isolation itself is structural and
// needs no host to hold; that assertion is the belt to its braces, and it is
// the half that would catch a future edit re-introducing an ambient spawn on a
// developer's machine.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const daemonJs = path.join(distDir, 'daemon.js');
if (!fs.existsSync(daemonJs)) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(1);
}

const { AgentRegistry, describeUnreadableLog, scanLogVersions } = await import(
  path.join(distDir, 'agent-registry.js')
);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};

// Short, because a unix socket address holds 104 characters and a data dir
// under a long temp root silently truncates it — the config loader refuses
// such a dir outright, which would fail every section here for the wrong
// reason.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan302-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// §6 spawns a mutated copy of `dist/` from under this directory, and
// `dist/daemon.js` imports `node-pty` and the MCP SDK by bare specifier. Node
// resolves those by walking UP from the importing file, which from a temp
// directory finds nothing — so without this the mutant dies on an unresolved
// import and produces "the daemon did not come up", which is the evidence §6
// is looking for and would have been meaningless. §6's precondition catches
// that, and this is what stops it happening in the first place. A symlink
// rather than a copy: it is 115 MB, and nothing here writes to it.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (err) {
  console.error(`could not link node_modules into the scratch dir: ${err?.message ?? err}`);
}

// ---------------------------------------------------------------------------
// ISOLATION FROM THE HOST'S herdr (KAN-330). Read this before adding a section.
// ---------------------------------------------------------------------------
//
// WHAT WAS WRONG. Until KAN-330 this file pinned no `PATH` and installed no
// shim, alone among the proofs in this suite that start a daemon and then give
// it something to restore. `daemon.ts` resolves `which('herdr')` off the
// ambient `PATH` (`env.ts`) and `HerdrBridge.runHerdr` spawns the bare name
// `herdr`, so the daemons started below found the REAL herdr on the developer's
// machine and §2's `activated` row was restored FOR REAL — against the shared
// per-machine herdr server every other agent is using. Three consequences, all
// three observed rather than reasoned about:
//
//   1. It spawned real agents and LEAKED THEM. Panes named
//      `crabcast-agent-a-*` outlived the run in temp directories that no longer
//      existed, and landed in every other agent's census as foreign panes.
//   2. Its verdict became a statement about the machine. The old §2 check
//      `the registry is byte-identical after a full daemon lifecycle` lost a
//      race: a real restore appends an `activated` row, and whether it landed
//      before `child.kill()` depended on an external server this file does not
//      control. That is KAN-171 exactly — a statement about the runner in the
//      words of a statement about the code.
//   3. And it degraded toward looking finished. It USUALLY passed, so the risk
//      was never a visible flake: it was a GREEN that meant "the real herdr
//      happened to refuse in time", reading as "the registry is immutable".
//      CI has no herdr, so CI could never have seen it.
//
// WHAT IS DONE ABOUT IT. A stub `herdr` first on a `PATH` that holds nothing
// else but the system directories, assigned to `process.env.PATH` here — before
// the first daemon starts — so that every child spawned anywhere below inherits
// it, including §6's and §7's mutant builds. There is no code path in this file
// that can reach `~/.local/bin/herdr`, and that is now structural rather than
// careful.
//
// WHICH SIBLING THIS COPIES, since inventing a new arrangement is the thing
// `prompts/task.md` asks me not to do: `verify-activated-by.mjs` §1 — its
// stateful shim, its `${bin}:/usr/local/bin:/usr/bin:/bin` system-only `PATH`,
// and its bash trampoline into a node implementation. The shim is stateful for
// that file's reason: `agent list` has to report what `agent start` actually
// started, so a pane count below is a measurement of what this script caused
// rather than a fixture that would agree with anything.
//
// WHAT ISOLATION DOES NOT COVER, named rather than left to be discovered.
// `readFdUsage()` inspects /proc for a running herdr SERVER, which no `PATH`
// hides. It is read-only, it touches no pane, and nothing in this file asserts
// on it — it only changes which of two fd-limit notices reaches `daemon.log`.
// So this file still reads one fact off the host; it no longer WRITES to it.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const shimState = path.join(tmp, 'shim');
fs.mkdirSync(shimState, { recursive: true });
const CENSUS_FILE = path.join(shimState, 'census.json');
const ARGV_LOG = path.join(shimState, 'argv.log');
const ATTACH_PIDS = path.join(shimState, 'attach-pids');
fs.writeFileSync(CENSUS_FILE, '[]');
fs.writeFileSync(ARGV_LOG, '');
fs.writeFileSync(ATTACH_PIDS, '');

const shimImpl = path.join(bin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
const CENSUS = ${JSON.stringify(CENSUS_FILE)};
const ARGV_LOG = ${JSON.stringify(ARGV_LOG)};
const ATTACH_PIDS = ${JSON.stringify(ATTACH_PIDS)};
const args = process.argv.slice(2);
// Logged BEFORE dispatch, so a call this shim REFUSES is as visible as one it
// serves — otherwise "the daemon never asked" and "the shim never answered"
// look identical afterwards. Whitespace is collapsed because \`agent start\`
// carries the launcher's whole prompt after \`--\`, newlines and all, and a log
// where one invocation spans forty lines cannot be counted.
fs.appendFileSync(ARGV_LOG, args.join(' ').replace(/\\s+/g, ' ').slice(0, 300) + '\\n');

const load = () => JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const save = (l) => fs.writeFileSync(CENSUS, JSON.stringify(l));
const out = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (a === 'agent' && b === 'start') {
  const panes = load();
  const cwdIdx = args.indexOf('--cwd');
  const pane = {
    name: args[2],
    pane_id: 'shim-' + (panes.length + 1),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    agent_status: 'working'
  };
  panes.push(pane);
  save(panes);
  out({ agent: { name: pane.name, pane_id: pane.pane_id } });
}
if (a === 'agent' && b === 'get') {
  const f = load().find((p) => p.name === args[2]);
  if (f) out({ agent: { name: f.name, pane_id: f.pane_id, cwd: f.cwd, agent_status: 'working' } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no such agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'list') {
  out({ agents: load().map((p) => ({ name: p.name, agent: 'shell', cwd: p.cwd, pane_id: p.pane_id, agent_status: p.agent_status })) });
}
if (a === 'agent' && b === 'attach') {
  // Holds the terminal open exactly as the real one does, so a restored
  // session does not go 'terminated' milliseconds later and make §2 assert
  // against a fleet that has already collapsed. The pid is recorded so §8 can
  // prove every one of them is gone rather than assume it.
  fs.appendFileSync(ATTACH_PIDS, process.pid + '\\n');
  setInterval(() => {}, 60000);
} else if (a === 'agent' && b === 'read') {
  out({ output: '' });
} else if (a === 'pane' && b === 'list') {
  out({ panes: [] });
} else if (a === 'pane' && b === 'close') {
  save(load().filter((p) => p.pane_id !== args[2]));
  out({});
} else if (a === 'tab' && b === 'create') {
  out({ tab: { tab_id: 'shim-tab' }, root_pane: { workspace_id: 'w-shim', terminal_id: 't-shim' } });
} else {
  out({});
}
`);
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`,
  { mode: 0o755 }
);

// ---------------------------------------------------------------------------
// PINNING `PATH` IS NECESSARY AND NOT SUFFICIENT, and this is the part that
// cost the afternoon — it is written down because the obvious fix is wrong in
// a way that looks right and leaves the leak in place.
// ---------------------------------------------------------------------------
//
// The daemon DOES NOT TRUST THE `PATH` IT INHERITS. `resolveUserPath()`
// (`src/env.ts`) rebuilds it at startup, deliberately and for a good reason —
// the daemon is auto-spawned by whichever client needed it first, and a client
// with a thin environment would otherwise break tool lookup for every agent in
// the fleet. It builds the list from, in order:
//
//   1. `$SHELL -lic env` — the user's LOGIN shell PATH, sourcing their
//      profile. On this machine that begins `/home/<user>/.local/bin`.
//   2. the inherited `process.env.PATH` — the only leg a naive fix controls,
//      and it is appended AFTER the login shell's.
//   3. `os.homedir() + '/.local/bin'`, added EXPLICITLY whether or not
//      anything above mentioned it. This is where the real herdr lives.
//   4. `path.dirname(process.execPath)`, then the standard system directories.
//
// So a daemon started with nothing but a pinned `PATH` still logged
// `herdr found at /home/<user>/.local/bin/herdr` and still spawned into the
// shared fleet — measured, not feared, and the shim sat unused on a `PATH`
// entry that legs 1 and 3 had already jumped in front of. The verdict looked
// exactly like the one a working fix produces, except for the panes.
//
// WHAT ACTUALLY CLOSES IT is pinning the three inputs that resolver reads —
// and it is what the sibling does, which is the half of the pattern easy to
// miss by copying only the line with `PATH` in it. `verify-activated-by.mjs`
// §1 sets `HOME` to a scratch directory and `SHELL` to `/bin/bash` alongside
// its `PATH`, and CI does the same thing from the other side (every proof runs
// under `HOME="$RUNNER_TEMP/verify-home-$s"`). With a scratch `HOME`:
//
//   - leg 1 sources no user profile, so it cannot contribute `~/.local/bin`;
//   - leg 3 resolves to a directory under `tmp` rather than the real one.
//
// And rather than leave leg 3 pointing at an empty directory, the stub is
// installed THERE TOO. Every leg that can name a directory now names one that
// holds only this run's stub, so the resolver reaching any of them is
// harmless — belt and braces, in that order, and the braces are the ones that
// would survive somebody reordering the resolver.
const realPath = process.env.PATH;
const fakeHome = path.join(tmp, 'home');
const fakeHomeBin = path.join(fakeHome, '.local', 'bin');
fs.mkdirSync(fakeHomeBin, { recursive: true });
fs.copyFileSync(path.join(bin, 'herdr'), path.join(fakeHomeBin, 'herdr'));
fs.chmodSync(path.join(fakeHomeBin, 'herdr'), 0o755);

// SYSTEM-ONLY, and the shim first. Not `${bin}:${process.env.PATH}`: that
// shadows the real herdr but leaves every other ambient binary reachable, and
// the property wanted here is that the host contributes nothing this file did
// not choose. `process.execPath` is absolute, so node is unaffected.
const PINNED_PATH = `${bin}:/usr/local/bin:/usr/bin:/bin`;

/**
 * The environment every daemon and every mutant in this file is started with.
 * Passed EXPLICITLY to each spawn rather than left to `process.env`, so that a
 * section added later cannot quietly opt out of the isolation by forgetting to
 * do anything — the only way to start a daemon here is `startDaemon`, and the
 * only env it offers is this one.
 */
const ISOLATED_ENV = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: PINNED_PATH,

  // AND THE COUNTING HALF OF THE CAPACITY GATE, which is the same defect one
  // layer along and was found by fixing the first one (KAN-330). §2 and §7 need
  // their restore to be ADMITTED — that is what writes the row whose
  // preservation they assert — so anything that can refuse it makes "did §2
  // actually run?" a question about the host. Pinning `PATH` and stopping there
  // would have swapped an ambient herdr for an ambient load average and left
  // the ticket's real complaint intact.
  //
  // `CRABCAST_MAX_AGENTS` sets the cap outright and skips the derivation
  // (`capacity.ts` calls it "the synthetic-capacity lever the acceptance proofs
  // use"); `verify-restore-admission.mjs` pins the same two, and is the sibling
  // this copies.
  //
  // THESE TWO ARE NOT SUFFICIENT ON THEIR OWN, and that is worth stating here
  // rather than leaving for somebody to rediscover: they bound the COUNTING
  // terms, and `atCapacity` can also be set by a CPU-headroom veto that no
  // environment variable is allowed to touch. Measured — with these pinned and
  // four CPU hogs running, three of three runs still deferred with "this
  // machine had no room". What closes that half is `RESTORABLE_CONFIG` on the
  // rows meant to be restored; see its definition.
  CRABCAST_MAX_AGENTS: '99',
  CRABCAST_AGENT_MEMORY_MB: '32'
};

// The in-process copy is pinned as well, for anything this script spawns
// itself, and restored on the way out so the value is not left changed for a
// caller that sourced us.
process.env.PATH = PINNED_PATH;
process.on('exit', () => { process.env.PATH = realPath; });

const shimCensus = () => JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));
const shimCalls = () =>
  fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter((l) => l.trim());
// Defensive because it is read from an exit handler: the handler that removes
// `tmp` was registered first and therefore runs first, so by the time the
// killer below reads this file the file may be gone. A throw out of an exit
// handler would turn a clean run into a stack trace after the verdict line.
const attachPids = () => {
  try {
    return fs.readFileSync(ATTACH_PIDS, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch { return []; }
};

// Every attach process this run created dies with it, on every exit path —
// including a signal, which `process.on('exit')` alone does not cover.
let knownPids = [];
const killAttaches = () => {
  for (const pid of [...new Set([...knownPids, ...attachPids()])]) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
};
process.on('exit', killAttaches);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAttaches(); process.exit(130); });
}

/**
 * THE SPECIMEN. Off the real machine, unedited. Kept as a literal string
 * rather than built from an object so that a field order or a spelling
 * changing here is a visible diff rather than a re-derivation.
 */
const SPECIMEN =
  '{"agentName":"crabcast-shell-demo","type":"shell","key":"demo","workDir":"",' +
  '"event":"deactivated","at":"2026-08-03T20:37:38.900Z"}';

const GOOD_CONFIG = {
  priority: 5, launcher: 'shell', refusable: true, chargeable: true, preemptable: true
};
/**
 * The config for a row this file expects to be RESTORED (KAN-330).
 *
 * Identical to GOOD_CONFIG but `refusable: false`, and that one field is what
 * makes §2 and §7 stop being a statement about the machine. Restore admission
 * runs through `capacityGate` (`router.ts`), which refuses when the machine is
 * `atCapacity` — and `atCapacity` is not only a count: a CPU-headroom veto can
 * zero it on a busy host. Measured while fixing this ticket: with four CPU
 * hogs running, three consecutive runs had their restore DEFERRED with "this
 * machine had no room", and the daemon was behaving perfectly correctly.
 *
 * `capacityGate` returns a pass unconditionally for an unrefusable agent —
 * `if (!refusable) return pass(capacity)` — so this is the supported way to
 * say "admit this one regardless of the machine", and it is a property of the
 * fixture rather than a knob turned on the gate. The alternatives were worse:
 * there is deliberately no CPU-busyness environment variable in this codebase
 * (`capacity.ts` says so twice, and rejects the idea as a footgun aimed at the
 * gate), and `override: true` is the restore pass's own decision to make, not
 * this file's.
 *
 * WHAT THIS COSTS: nothing this file asserts. No section here is about the
 * capacity gate — `verify-restore-admission.mjs` owns that, and owns it with a
 * fixture that deliberately DOES saturate the machine.
 */
const RESTORABLE_CONFIG = { ...GOOD_CONFIG, refusable: false };

const goodRow = (p, event = 'activated', at = '2026-08-01T10:00:00.000Z', config = GOOD_CONFIG) =>
  JSON.stringify({ v: 1, event, path: p, config, activatedBy: null, at });

function makeCase(name, lines) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const registry = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(registry, lines.join('\n') + '\n');
  const cfg = path.join(tmp, `${name}.config.json`);
  fs.writeFileSync(cfg, JSON.stringify({ dataDir: dir }));
  return { dir, registry, cfg, socket: path.join(dir, 'crabcast.sock') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(socketPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

function ask(socketPath, request, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Wait until `predicate` holds, polling. Returns true, or false on timeout.
 * Used instead of a sleep wherever this file needs the daemon to have FINISHED
 * something: a fixed sleep is what made the old §2 a race, and lengthening one
 * would only have made the race rarer rather than absent.
 */
/**
 * How long to wait for a RESTORE specifically. Longer than it looks like it
 * needs to be, deliberately: reconciliation defers a restore when the machine
 * is short of capacity and logs `waiting up to 15s for herdr to answer, then
 * retry`, so any budget at or below that races the daemon's own retry — which
 * is the same species of defect as the one this ticket is fixing, a verdict
 * that depends on how busy the machine is. Measured: a 10s budget passed on an
 * idle host and failed §7 on a loaded one, with nothing wrong with the build.
 */
const RESTORE_WAIT_MS = 30000;

async function waitUntil(predicate, timeoutMs = RESTORE_WAIT_MS, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(everyMs);
  }
  return false;
}

/**
 * THE ROW-PRESERVATION PREDICATE — what §2 asserts now that the shim has made
 * the restore deterministic, and what AC2 of KAN-330 asked to be decided rather
 * than pinned.
 *
 * The old assertion was `the registry is byte-identical after a full daemon
 * lifecycle`. Under the real herdr that was a race; under the shim it would be
 * deterministically FALSE, because a restore legitimately appends an
 * `activated` row and always will. Pinning it — sleeping longer, or killing the
 * daemon sooner — would have kept a green by arranging for the daemon to be
 * interrupted before it did its job, which tests the interruption rather than
 * the registry.
 *
 * So the honest property is the one the file's title is actually about:
 * NOTHING IS EVER LOST OR REWRITTEN. Every byte that was in the file is still
 * in it, in the same order, at the same offset — the file may only have GROWN,
 * by whole appended lines, and every appended line must be a row the daemon is
 * entitled to write. That is strictly stronger than byte-identity where it
 * matters (byte-identity says nothing about WHAT was appended) and strictly
 * weaker only in permitting the append that legitimate operation requires.
 *
 * @returns {{ok: boolean, why: string, added: string[]}}
 */
function preservedByAppendOnly(beforeBuf, afterBuf) {
  if (afterBuf.length < beforeBuf.length) {
    return { ok: false, why: `the file SHRANK, ${beforeBuf.length} → ${afterBuf.length} bytes`, added: [] };
  }
  const prefix = afterBuf.subarray(0, beforeBuf.length);
  if (Buffer.compare(prefix, beforeBuf) !== 0) {
    // Name the first differing line, because "it changed" is not a repairable
    // sentence and this is the check somebody will meet at 2am.
    const b = beforeBuf.toString('utf8').split('\n');
    const a = afterBuf.toString('utf8').split('\n');
    let i = 0;
    while (i < b.length && b[i] === a[i]) i++;
    return {
      ok: false,
      why: `line ${i + 1} was REWRITTEN — before: ${JSON.stringify(b[i]?.slice(0, 80))} after: ${JSON.stringify(a[i]?.slice(0, 80))}`,
      added: []
    };
  }
  const added = afterBuf.subarray(beforeBuf.length).toString('utf8').split('\n').filter((l) => l.trim());
  return { ok: true, why: `${added.length} row(s) appended, every earlier byte untouched`, added };
}

/**
 * The daemon's own account of a restore that did not happen, read off its log.
 *
 * A precondition that fails saying only "the agent never came up" sends its
 * reader to reproduce the run by hand to find out why — and the interesting
 * answers here are all the daemon's, not this script's: a capacity refusal, a
 * deferral, a spawn error. The daemon already wrote the sentence; this only
 * carries it up to where the verdict is.
 */
function whyNotRestored(c) {
  try {
    const lines = fs.readFileSync(path.join(path.dirname(c.registry), 'daemon.log'), 'utf8')
      .split('\n')
      .filter((l) => /\[reconcile\]|cap:|no room|deferred|refus|spawn/i.test(l));
    return lines.length
      ? `the daemon said: ${lines.slice(-2).map((l) => l.trim().slice(0, 220)).join(' // ')}`
      : 'and its log says nothing about a reconcile at all';
  } catch (err) {
    return `and its log could not be read (${err?.code ?? err?.message})`;
  }
}

const running = [];
function startDaemon(cfg, dist = distDir) {
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // ISOLATED_ENV, never the ambient one — see the block above for why a
    // pinned PATH alone does not hold.
    env: ISOLATED_ENV
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  running.push(child);
  return { child, stderr: () => stderr };
}
process.on('exit', () => { for (const c of running) { try { c.kill(); } catch {} } });

// ---------------------------------------------------------------------------
console.log('\n=== 1. The specimen alone: the daemon starts, and says what it could not read ===');
// ---------------------------------------------------------------------------
{
  const c = makeCase('specimen', [SPECIMEN]);
  const before = fs.readFileSync(c.registry);

  const d = startDaemon(c.cfg);
  const up = await waitForSocket(c.socket);
  check(up, 'the daemon bound its socket on a registry whose only row it cannot read',
    up ? c.socket : `stderr: ${d.stderr().slice(0, 400)}`);

  if (up) {
    const status = await ask(c.socket, { action: 'daemon_status', id: 1 });

    // THE CENTRAL ASSERTION of this file, and §6 is what shows it can fail.
    check(status.success === true, 'daemon_status answers over the socket');
    check(
      status.unreadableRecordsTotal === 1,
      'and the fleet read DISCLOSES the row — on the wire, not only in a log line',
      `unreadableRecordsTotal=${status.unreadableRecordsTotal}`
    );

    const row = status.unreadableRecords?.[0] ?? {};
    check(row.line === 1, 'the disclosure names the LINE, which is what makes a repair targeted',
      `line=${row.line}`);
    check(row.problem === 'pre-migration', 'classified as pre-migration rather than as a hand-edit',
      `problem=${row.problem}`);
    check(
      row.identity === 'crabcast-shell-demo',
      "identified in the row's OWN vocabulary — an old row does not know the word `path`",
      `identity=${row.identity}`
    );
    check(row.raw === SPECIMEN, 'and carries the row verbatim, so the operator need not open the file');
    check(
      typeof row.reason === 'string' && /workspaceTypes/.test(row.reason),
      'saying what could not be read about it, rather than only that something could not'
    );
    check(
      row.claimsPath === null,
      'and reports that this row names no directory — its `workDir` is the empty string',
      `claimsPath=${JSON.stringify(row.claimsPath)}`
    );

    // The counts beside it are the reason the disclosure has to be HERE. Both
    // read zero, which is exactly what an empty registry reads.
    check(
      status.configuredAgents === 0 && status.expectedAgents === 0,
      'the agent counts are zero — indistinguishable from an empty registry, which is why ' +
        'the disclosure sits beside them rather than somewhere else',
      `${status.configuredAgents} configured, ${status.expectedAgents} expected`
    );

    const fleet = await ask(c.socket, { action: 'list_agents', id: 2 });
    check(
      fleet.success === true && fleet.unreadableRecordsTotal === 1 &&
        fleet.unreadableRecords?.[0]?.raw === SPECIMEN,
      'the same disclosure is on `list_agents`, so the two surfaces cannot disagree'
    );
  }

  d.child.kill();
  await waitUntil(async () => d.child.exitCode !== null || d.child.signalCode !== null, 5000);

  // BYTE-IDENTITY IS STILL RIGHT HERE, AND IS NOT IN §2 — the difference is the
  // fixture rather than the standard (KAN-330 AC2). This registry's only row is
  // unreadable, so the daemon has NOTHING to restore and nothing to record: it
  // reports `0 expected, 0 restored`, and a single byte of difference would
  // mean the boot path wrote to a file it was only ever asked to read. §2 seeds
  // a restorable agent, so a legitimate append is expected there and the
  // property has to be stated as append-only instead. Neither is a weakening of
  // the other; asserting byte-identity in §2 is what made it a race, and
  // asserting only append-only here would stop catching a boot that writes.
  check(
    Buffer.compare(before, fs.readFileSync(c.registry)) === 0,
    'THE REGISTRY IS BYTE-IDENTICAL: nothing was deleted, migrated or rewritten to achieve this ' +
      '— and with nothing restorable in the file this is deterministic, not a race won'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. One bad row among good ones: the good ones survive ===');
// ---------------------------------------------------------------------------
{
  // All three unreadable classes at once, so a build that handles one and
  // refuses on another is caught here rather than by whoever meets it.
  const alive = path.join(tmp, 'agent-a');
  const stood = path.join(tmp, 'agent-b');
  fs.mkdirSync(alive, { recursive: true });
  fs.mkdirSync(stood, { recursive: true });
  const { chargeable, ...missingOne } = GOOD_CONFIG;

  const c = makeCase('mixed', [
    // RESTORABLE_CONFIG, so the restore below is admitted on a busy machine as
    // well as an idle one — see its definition.
    goodRow(alive, 'activated', undefined, RESTORABLE_CONFIG),       // line 1
    SPECIMEN,                                                        // line 2  pre-migration
    goodRow(stood, 'deactivated', '2026-08-01T11:00:00.000Z'),       // line 3
    JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan302-handedit',
      config: missingOne, at: '2026-08-01T12:00:00.000Z' }),         // line 4  unusable
    JSON.stringify({ v: 99, event: 'activated', path: '/tmp/kan302-future',
      config: GOOD_CONFIG, at: '2026-08-01T13:00:00.000Z' })         // line 5  from-newer
  ]);
  const before = fs.readFileSync(c.registry);

  const d = startDaemon(c.cfg);
  const up = await waitForSocket(c.socket);
  check(up, 'the daemon starts with three unreadable rows of three different kinds',
    up ? '' : `stderr: ${d.stderr().slice(0, 400)}`);

  if (up) {
    const status = await ask(c.socket, { action: 'daemon_status', id: 3 });
    check(
      status.configuredAgents === 2,
      'BOTH readable agents survived — the valid rows were loaded, not discarded with the file',
      `configuredAgents=${status.configuredAgents}`
    );
    check(status.expectedAgents === 1, 'and the one expected agent is still expected',
      `expectedAgents=${status.expectedAgents}`);

    check(status.unreadableRecordsTotal === 3, 'all three unreadable rows are disclosed',
      `total=${status.unreadableRecordsTotal}`);
    const byLine = Object.fromEntries((status.unreadableRecords ?? []).map((r) => [r.line, r]));
    check(byLine[2]?.problem === 'pre-migration', 'line 2 is named pre-migration');
    check(byLine[4]?.problem === 'unusable', 'line 4 is named unusable — a hand-edit, not a migration');
    check(
      /config\.chargeable/.test(byLine[4]?.reason ?? ''),
      'and names the EXACT field that was dropped, which is the only useful sentence for a ' +
        'hand-edit: the operator already believes they supplied them all',
      byLine[4]?.reason?.slice(0, 90)
    );
    check(byLine[5]?.problem === 'from-newer', 'line 5 is named from-newer — downgrading, not migrating');
    check(
      /downgrading/.test(byLine[5]?.reason ?? ''),
      'and points at the downgrade rather than at a repair that would not help'
    );
    check(
      byLine[4]?.claimsPath === '/tmp/kan302-handedit',
      'a row that DOES name a directory reports it, so a caller can see a collision coming',
      `claimsPath=${byLine[4]?.claimsPath}`
    );

    const fleet = await ask(c.socket, { action: 'list_agents', id: 4 });
    const known = [
      ...(fleet.standbyAgents ?? []), ...(fleet.unstartedAgents ?? []),
      ...(fleet.missingAgents ?? []), ...(fleet.agents ?? [])
    ].map((r) => r.path);
    check(known.includes(stood), 'the stood-down agent is offered on the fleet read as usual',
      known.join(', ') || '(none)');
    check(
      !known.includes('/tmp/kan302-future') && !known.includes('/tmp/kan302-handedit'),
      'and NO unreadable row is reported as an agent — disclosed as unreadable, never half-loaded'
    );

    // THE RESTORE IS WAITED FOR, NOT SLEPT THROUGH (KAN-330). The `activated`
    // row on line 1 names a directory that exists, so the daemon restores it —
    // and the row that restore appends is the one the old check raced. Waiting
    // on the daemon's own report of the finished restore makes the state below
    // a fact rather than a timing outcome.
    const restored = await waitUntil(async () => {
      const f = await ask(c.socket, { action: 'list_agents', id: 5 });
      return (f.agents ?? []).some((r) => r.path === alive);
    });
    check(
      restored,
      'PRECONDITION for the preservation check: the restore has COMPLETED — the daemon reports ' +
        'the agent running, so what follows is measured against a finished lifecycle rather than ' +
        'against whichever moment `kill` happened to land in',
      restored ? alive : `the agent never came up within ${RESTORE_WAIT_MS}ms — ${whyNotRestored(c)}`
    );
    check(
      shimCensus().some((p) => p.cwd === alive),
      'and it was restored THROUGH the spawn path — the stub herdr was asked to start it, so ' +
        'this section exercises a real restore rather than a daemon that declined to try',
      shimCensus().map((p) => `${p.name}@${p.cwd}`).join(', ') || '(the stub started nothing)'
    );
  }

  d.child.kill();
  // The daemon is gone before the file is read: waiting on the process rather
  // than on a duration, so nothing can still be writing while we compare.
  await waitUntil(async () => d.child.exitCode !== null || d.child.signalCode !== null, 5000);

  // ---------------------------------------------------------------------
  // THE ASSERTION THAT REPLACED `byte-identical` (KAN-330 AC2).
  // ---------------------------------------------------------------------
  const after = fs.readFileSync(c.registry);
  const preserved = preservedByAppendOnly(before, after);
  check(
    preserved.ok,
    'NOTHING WAS LOST OR REWRITTEN across a full daemon lifecycle: every byte that was in the ' +
      'registry is still there, at the same offset, in the same order — the file may only have ' +
      'GROWN. This is what the old `byte-identical` check was reaching for; byte-identity was ' +
      'both too strong (a restore legitimately appends) and too weak (it never said what was ' +
      'appended)',
    preserved.why
  );

  // Too weak in exactly that way, so the appended rows are read rather than
  // waved through: a build that preserved the old bytes and appended a
  // compaction of its own would satisfy append-only and still be wrong.
  const addedRows = preserved.added.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check(
    addedRows.length > 0 && addedRows.every((r) => r && r.path === alive),
    'and every row the daemon DID append belongs to the one agent it restored — the append is ' +
      'the restore, not a rewrite wearing an append\'s clothes',
    preserved.added.length
      ? addedRows.map((r) => `${r?.event ?? '(unparseable)'} ${r?.path ?? ''}`).join(' | ')
      : '(nothing was appended, so the restore wrote no record of itself)'
  );
  check(
    fs.readFileSync(c.registry, 'utf8').includes(SPECIMEN),
    'and the unreadable specimen is still in the file afterwards, byte for byte — the row the ' +
      'daemon could not read is the one with no owner to notice it had gone'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Compaction carries the unreadable rows — the 500-record trap ===');
// ---------------------------------------------------------------------------
{
  // THE SECTION THIS FILE EXISTS FOR AS MUCH AS §1. Compaction rewrites the log
  // from the rows it could LOAD, so skipping an unreadable row does not hide it
  // — it schedules its deletion at the 500th record, silently, long after
  // anybody is watching. Without this, "we never delete your registry" is true
  // of the boot and false of the daemon.
  const dir = path.join(tmp, 'compaction');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agents.jsonl');
  const handEdit = JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan302-he', config: {} });
  fs.writeFileSync(file, [SPECIMEN, handEdit].join('\n') + '\n');

  const registry = new AgentRegistry(file);
  const scanBefore = scanLogVersions(file);
  check(scanBefore.unreadable.length === 2, 'two unreadable rows to start with',
    `${scanBefore.unreadable.length}`);

  // Past COMPACT_AFTER_RECORDS (500) so `record()` triggers a real compaction —
  // and over a SMALL set of paths, deliberately. 520 distinct paths would write
  // 520 rows that compaction has to keep (one per agent), so the file would not
  // shrink and "did a compaction happen?" would be unanswerable from its size.
  // Ten paths churned 52 times each collapses to ten rows, which makes the
  // rewrite observable — and observing the rewrite is the whole precondition
  // for this section, since a compaction that never ran would preserve the
  // unreadable rows trivially and prove nothing.
  const AGENTS = 10;
  for (let i = 0; i < 520; i++) {
    registry.record(i % 2 ? 'activated' : 'configured', {
      path: path.join(tmp, 'compaction', `a${i % AGENTS}`), config: GOOD_CONFIG, activatedBy: null
    });
  }

  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  check(
    lines.length < 100,
    'PRECONDITION: a compaction really happened — the log collapsed to roughly one row per ' +
      'agent, so this section is reading a REWRITTEN file rather than an untouched one',
    `${lines.length} lines from 520 records`
  );
  check(
    lines.includes(SPECIMEN),
    'THE SPECIMEN SURVIVED COMPACTION, byte for byte. This is the assertion that stops ' +
      '"skip the row" from becoming "delete the record" 500 records later.'
  );
  check(lines.includes(handEdit), 'and so did the hand-edit casualty');

  const after = scanLogVersions(file);
  check(after.unreadable.length === 2, 'the rewritten log still discloses both',
    `${after.unreadable.length}`);
  check(
    registry.intents().size === AGENTS,
    'while every readable agent is still there',
    `${registry.intents().size} intents`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A prompt in an unreadable row is not published by the back door ===');
// ---------------------------------------------------------------------------
{
  // `config.prompt` is the one field a caller freezes onto an agent that the
  // ordinary config echo does NOT carry. Publishing an unreadable row's bytes
  // unfiltered would hand it back on the same response that withholds it one
  // field to the left, which is a surface widening nobody asked for.
  const secret = 'BOOTSTRAP-TEXT-THAT-MUST-NOT-APPEAR-' + 'x'.repeat(40);
  const dir = path.join(tmp, 'redact');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    v: 1, event: 'activated', path: '/tmp/kan302-prompt',
    config: { ...GOOD_CONFIG, launcher: '', prompt: secret }
  }) + '\n');

  const rows = scanLogVersions(file).unreadable;
  check(rows.length === 1, 'the row is unreadable (its launcher is empty)', `${rows.length}`);
  check(rows[0]?.promptRedacted === true, 'and the disclosure says a prompt was withheld');
  check(!rows[0]?.raw.includes(secret), 'the prompt is NOT in the published bytes');
  check(
    /prompt withheld/.test(rows[0]?.raw ?? ''),
    'the withholding is marked in place rather than the field silently vanishing',
    rows[0]?.raw?.slice(0, 120)
  );
  // A redaction that also broke the repair would be a poor trade: everything
  // else about the row still has to be there for the operator to fix it.
  check(
    /"launcher":""/.test(rows[0]?.raw ?? ''),
    'and every other field survives, so the row is still repairable from the disclosure'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. No repair the daemon offers destroys the durable record ===');
// ---------------------------------------------------------------------------
{
  // The text this replaces named "Delete <registry> and `configure` the fleet
  // again" as remedy 1 and called it "the right answer for every real
  // deployment". On a machine with a fleet that is every agent record thrown
  // away to recover from one row. This section is a grep, and it is deliberate
  // that it is a grep: the failure it guards against is a sentence coming back.
  const scan = scanLogVersions(path.join(tmp, 'specimen', 'agents.jsonl'));
  const text = describeUnreadableLog(scan);
  console.log('--- the notice, verbatim ---\n' + text + '\n---');

  check(scan.unreadable.length === 1, 'the notice is about the real specimen', `${scan.unreadable.length}`);
  check(
    !/\bDelete\b|\bdelete\b|\brm\b|\btruncate\b|start from an empty log/.test(text),
    'THE NOTICE NEVER TELLS THE OPERATOR TO DESTROY THE REGISTRY — no "delete", no "rm", ' +
      'no "start from an empty log", at any severity'
  );
  check(/line 1/.test(text), 'it names the offending LINE');
  check(/crabcast-shell-demo/.test(text), 'and the offending row');
  check(
    /repair a row, edit THAT LINE/.test(text) && /every other record in this file is fine/.test(text),
    'and the repair it offers is per-row, stating that every other record is untouched'
  );
  check(
    !/refusing to start/.test(text),
    'and it no longer claims to be refusing, because it is not'
  );
  check(
    /HAVE NOT BEEN RESTORED/.test(text),
    'while still saying plainly that the agents in those rows are NOT running — starting is ' +
      'not the same as pretending the rows were readable'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. MUTATION: restore the refusal, and require §1 to go red ===');
// ---------------------------------------------------------------------------
{
  const { mutate } = makeMutator({
    distDir, scratch: path.join(tmp, 'mutants'), report
  });

  // Restores exactly the pre-KAN-302 behaviour: notice, then exit(1). The
  // fingerprint is what the precondition below reads, so that a mutant which
  // died on an unresolved import cannot be mistaken for one that refused.
  const mutantDist = mutate(
    'refuse-on-unreadable-row',
    'daemon.js',
    'const unreadableAtBoot = logScan.preMigration + logScan.fromNewer + logScan.unusable;',
    'const unreadableAtBoot = logScan.preMigration + logScan.fromNewer + logScan.unusable;\n' +
      'if (unreadableAtBoot > 0) { process.stderr.write("MUTANT-REFUSED: pre-KAN-302 boot ' +
      'refusal restored\\n"); process.exit(1); }'
  );

  if (mutantDist) {
    const c = makeCase('mutant', [SPECIMEN]);
    const result = spawnSync(process.execPath, [path.join(mutantDist, 'daemon.js'), c.cfg], {
      encoding: 'utf8', timeout: 15000, env: ISOLATED_ENV
    });

    // THE PRECONDITION `scripts/mutation.mjs` demands of every caller. "The
    // daemon did not come up" is trivially true of a mutant that died on
    // startup, which would produce this section's evidence while proving
    // nothing at all. So the mutant is caught doing the one thing only the
    // mutant does, as a positive fact, before anything below is read.
    check(
      /MUTANT-REFUSED/.test(result.stderr ?? ''),
      'PRECONDITION: the mutant ran and took its own branch — this is the mutant refusing, ' +
        'not a mutant that failed to load',
      (result.stderr ?? '').split('\n')[0]?.slice(0, 80)
    );
    check(result.status === 1, 'the mutated build EXITS 1 where the real one starts',
      `exit ${result.status}`);
    check(
      !fs.existsSync(c.socket),
      "and binds no socket — §1's central assertion goes red against it, which is what makes " +
        '§1 a measurement rather than an observation that has only ever passed'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. MUTATION: break row preservation, and require §2 to name it ===');
// ---------------------------------------------------------------------------
{
  // KAN-330 AC3. §6 shows §1's central assertion can fail; this shows §2's
  // REPLACEMENT one can, which is the assertion this ticket introduced and
  // therefore the one with no track record. A check nobody has watched fail has
  // not been shown to be a check.
  //
  // THE MUTATION IS THE REAL SEAM, not a contrivance: `agent-registry` opens
  // its log with `openSync(file, 'a')` — O_APPEND is the single character that
  // makes every write additive. Turning it into `'w'` truncates the file on the
  // next record written, which is exactly "skip the row" becoming "delete the
  // record" — the failure this whole file exists to catch, injected at the one
  // place it would really come from.
  const { mutate } = makeMutator({
    distDir, scratch: path.join(tmp, 'mutants'), report
  });

  const mutantDist = mutate(
    'truncate-instead-of-append',
    'agent-registry.js',
    "fd = fs.openSync(this.file, 'a', 0o600);",
    "fd = fs.openSync(this.file, 'w', 0o600);"
  );

  if (mutantDist) {
    // §2's fixture, rebuilt: one good `activated` row whose directory exists,
    // the specimen, and a stood-down agent. The mutant restores the agent
    // exactly as the real build does — and destroys the file doing it.
    const alive2 = path.join(tmp, 'agent-c');
    fs.mkdirSync(alive2, { recursive: true });
    const c = makeCase('mutant-append', [
      goodRow(alive2, 'activated', undefined, RESTORABLE_CONFIG),
      SPECIMEN
    ]);
    const before = fs.readFileSync(c.registry);

    const d = startDaemon(c.cfg, mutantDist);
    const up = await waitForSocket(c.socket);
    check(
      up,
      'PRECONDITION: the mutant daemon came up — so what §2 catches below is the mutation ' +
        'doing its work, not a build that failed to load',
      up ? '' : `stderr: ${d.stderr().slice(0, 300)}`
    );

    if (up) {
      const restored = await waitUntil(async () => {
        const f = await ask(c.socket, { action: 'list_agents', id: 7 });
        return (f.agents ?? []).some((r) => r.path === alive2);
      });
      check(
        restored,
        'PRECONDITION: and it really restored the agent, so a row was really written — without ' +
          'a write there is nothing for a truncating open to destroy and this section would ' +
          'pass by never firing',
        restored ? alive2 : `the mutant never restored it within ${RESTORE_WAIT_MS}ms — ${whyNotRestored(c)}`
      );

      d.child.kill();
      await waitUntil(async () => d.child.exitCode !== null || d.child.signalCode !== null, 5000);

      // THE VERDICT. Feed the mutant's before/after to the SAME predicate §2
      // uses — not a re-implementation of it, which could agree with §2 while
      // both were wrong.
      //
      // Gated on the precondition rather than run regardless: with no restore
      // there is no write, so the predicate would correctly report "nothing was
      // damaged" and this section would report three further failures that all
      // say the same thing as the precondition above and none of which is about
      // the build. One honest failure beats four that need untangling.
      const verdict = restored
        ? preservedByAppendOnly(before, fs.readFileSync(c.registry))
        : null;
      if (verdict) {
        check(
          verdict.ok === false,
          "§2'S PRESERVATION CHECK GOES RED against a build that truncates instead of appending. " +
            'This is the measurement that makes it a check rather than an observation that has ' +
            'only ever passed',
          `the predicate says: ${verdict.why}`
        );
        check(
          /SHRANK|REWRITTEN/.test(verdict.why),
          'and it NAMES the damage rather than only reporting a mismatch — a preservation check ' +
            'that cannot say what was lost sends its reader to diff two files by hand',
          verdict.why
        );
        check(
          !fs.readFileSync(c.registry, 'utf8').includes(SPECIMEN),
          'and the specimen really is gone from the mutant\'s file — confirming the mutation ' +
            'destroyed the record rather than merely reordering it, which is the defect this ' +
            'file is named for'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. RESIDUE: this run left nothing running and nothing behind ===');
// ---------------------------------------------------------------------------
{
  // KAN-330 AC3 asks for this to be ASSERTED rather than concluded from the
  // code, because "the script cleans up" was true of the old file too — of its
  // temp directory, which was never the thing that leaked.
  knownPids = attachPids();

  // 1. Every daemon this script started is dead. `running` holds all of them,
  //    including §6's and §7's mutants.
  const alive = running.filter((c) => c.exitCode === null && c.signalCode === null && c.pid);
  const stillUp = [];
  for (const c of alive) {
    // Signal 0 tests for existence without delivering anything.
    try { process.kill(c.pid, 0); stillUp.push(c.pid); } catch {}
  }
  check(
    stillUp.length === 0,
    'no daemon this script started is still running',
    stillUp.length ? `still up: ${stillUp.join(', ')}` : `${running.length} started, ${running.length} gone`
  );

  // 2. No socket is left listening. A dead daemon that left a bound socket
  //    behind is the residue that makes the NEXT run refuse its data dir.
  const listening = [];
  for (const name of fs.readdirSync(tmp)) {
    const sock = path.join(tmp, name, 'crabcast.sock');
    if (!fs.existsSync(sock)) continue;
    const answered = await new Promise((resolve) => {
      const probe = net.connect(sock);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (answered) listening.push(sock);
  }
  check(listening.length === 0, 'and no socket of theirs is still accepting connections',
    listening.join(', ') || '(none)');

  // 3. THE ONE THIS TICKET IS ABOUT. Every pane this run caused was caused on
  //    the STUB, so the stub's census is the complete record of what was
  //    spawned — and the real herdr, if this machine has one, cannot have been
  //    touched. The stub census is expected to be non-empty: agents really were
  //    started. What matters is WHERE.
  const census = shimCensus();
  const calls = shimCalls();
  check(
    calls.length > 0,
    'PRECONDITION: the stub herdr was actually consulted — a shim nothing calls would make ' +
      'every claim below vacuously true',
    `${calls.length} herdr invocation(s), including: ${[...new Set(calls.map((l) => l.split(' ').slice(0, 2).join(' ')))].join(', ')}`
  );
  check(
    census.every((p) => p.cwd.startsWith(tmp)),
    'and every pane this run started is inside this run\'s own scratch directory — nothing was ' +
      'spawned anywhere a later run, or another agent, could find it',
    census.map((p) => `${p.name} @ ${p.cwd}`).join(' | ') || '(no panes)'
  );

  // 4. And the direct statement of the KAN-330 defect: the host's herdr, if it
  //    has one, has no pane from this run. Conditional BY DESIGN and reported
  //    either way — CI has no herdr, so this is the check that cannot run
  //    there, and a check that silently passes when it did not execute is the
  //    exact shape of defect this epic keeps finding. It is not counted as a
  //    pass when it is skipped.
  // Resolved off the PATH THIS SCRIPT WAS STARTED WITH — saved before the shim
  // replaced it — rather than a hard-coded location. A literal
  // `~/.local/bin/herdr` would be one developer's machine written into a repo
  // script, and would report "no herdr on this host" on a machine that has one
  // somewhere else: a false NOT-RUN is worse than no check, because it reads as
  // CI's honest skip while hiding a real leak.
  const hostHerdr = (realPath ?? '').split(':')
    .filter(Boolean)
    .map((d) => path.join(d, 'herdr'))
    .find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (hostHerdr) {
    const listed = spawnSync(hostHerdr, ['agent', 'list'], { encoding: 'utf8', timeout: 15000 });
    let ours = null;
    try {
      // SCOPED TO THIS RUN BY WORKING DIRECTORY, and deliberately not by pane
      // name. `crabcast-agent-*` matches residue from any earlier run on this
      // machine — including runs of the very version this replaces — so a
      // name-based filter turns "somebody leaked once, last week" into a
      // failure of the run reading it, which is a check that cannot go green
      // until a human tidies up by hand. The scratch root is unique per run
      // (`mkdtemp`), so a cwd under it is this run's doing and nothing else's.
      // herdr reports a vanished directory as `<path> (deleted)`, which still
      // carries the prefix.
      ours = (JSON.parse(listed.stdout).result.agents ?? [])
        .filter((a) => String(a.cwd ?? '').startsWith(tmp));
    } catch { /* a host herdr that will not answer is not this script's business */ }
    if (ours === null) {
      console.log('  NOT RUN  the host herdr did not answer `agent list`; this run made no claim ' +
        'about it (and could not have spawned into it — PATH holds only the stub)');
    } else {
      check(
        ours.length === 0,
        'THE HOST HERDR HAS NO PANE FROM THIS RUN — the leak KAN-330 was filed for, asserted ' +
          'against the real server rather than argued from the PATH',
        ours.length ? ours.map((a) => `${a.name} @ ${a.cwd}`).join(' | ') : `${hostHerdr} is clean`
      );
    }
  } else {
    console.log('  NOT RUN  no herdr on the PATH this script started with, so the "no real pane" ' +
      'check could not execute. This is the CI case: isolation is structural — PATH holds the ' +
      'stub and the system directories and nothing else — but on this machine it is ' +
      'unexercised, and an unexercised check is reported rather than counted.');
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
