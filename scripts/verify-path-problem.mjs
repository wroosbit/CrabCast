#!/usr/bin/env node
// Live proof for KAN-382: `pathProblem` — WHY an address was refused, on the
// `bad-address` branch of `activate_response` and `agent_status`, mandatory
// there, and DISCRIMINATING between the five causes rather than merely present.
//
// WHAT FAILURE THIS WOULD CATCH: a `pathProblem` that is present, correctly
// typed, on both surfaces — AND REPORTS THE SAME VALUE WHATEVER WAS WRONG WITH
// THE PATH. That is what you get from any field wired to a constant, to the
// first branch of a switch, or to a re-derivation that only ever sees one input;
// and every "is the key there, is it in the published set, do both surfaces
// carry it" assertion in this file passes PERFECTLY against a daemon that always
// answers `not-absolute`. §2 is what rules that out, by producing FOUR distinct
// causes on one surface and requiring four distinct answers. Nothing else here
// can tell the difference, and §1 and §3 are worth nothing until §2 has run.
//
// THE SECOND FAILURE, and it is the one the commissioning ticket is about: a
// discriminator that is correct on the cause a proof reaches for naturally and
// ABSENT on the cause production actually meets. A relative path is what every
// existing proof uses to produce this branch — it is one line and needs no
// world — and it is a CALLER BUG. The cause this field was published for is
// `does-not-exist`: a directory configured, then deleted, which
// `addressOfRequest`'s own header calls "the normal way an agent ends" and whose
// remedy is the opposite kind of thing. §2 builds that world for real — it
// configures an agent at a directory that exists and then removes it — rather
// than passing a path that never existed, because those are different states and
// only the first is the one a running fleet reaches.
//
// THE VACUITY GUARD, stated because it is the failure this file is shaped
// against: a proof that never sees a `bad-address` refusal passes trivially. So
// every section states as a PRECONDITION that the response it is about really
// took that branch — `success: false` and no `path` — and a section whose world
// was not built is a counted failure rather than a silent skip. §0 additionally
// asserts that a SUCCESSFUL call carries no `pathProblem` at all, so "present on
// every response" cannot be mistaken for the claim being made.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND THEREFORE DOES NOT TEST. It builds
// every bad address it then asserts on — a relative string, a deleted
// directory, a file, an empty string. So it tests the daemon's whole path from
// that request onward, and it does NOT test that any real consumer reads the
// field or acts on it differently per cause.
//
//   WHO COVERS THAT: nobody yet, and saying so is the point of this paragraph
//   rather than an apology for it. `src/reconcile.ts` is the one in-repo caller
//   that branches on an activate refusal (`response?.refused === 'unverifiable'`,
//   `response?.refusedBy === 'capacity'`), and at this commit it does NOT branch
//   on `pathProblem` — a boot restore of an agent whose directory has been
//   deleted still reports `result: 'failed'`. That is unchanged by this ticket
//   deliberately: publishing the discriminator and changing what the restore
//   pass DOES with it are two decisions, and only the first was taken. The seam
//   is therefore: this file proves the daemon reports the cause truthfully, and
//   nothing yet proves a consumer uses it.
//
// Sections:
//   0. the branch exists and is not everywhere — a successful `activate` and a
//      successful `agent_status` carry no `pathProblem`, so §1's presence claim
//      is about a branch rather than about every response
//   1. both surfaces carry it on `bad-address`, its value is one the contract
//      publishes, and both agree for the same bad path
//   2. IT DISCRIMINATES — four causes produced on `activate`, four distinct
//      values, including `does-not-exist` built by deleting a real configured
//      directory and one caller-bug cause
//   3. the asymmetry the contract states is real: `agent_status` is `strict:
//      false`, so the SAME deleted directory that answers `does-not-exist` on
//      `activate` does not refuse there at all
//   4. THE RED HALF — the daemon is mutated to flatten the cause again, and §1
//      and §2 are shown to go red; and mutated to answer a constant, and §2
//      alone is shown to go red while §1 stays green, which is the whole reason
//      §2 exists
//
// Usage:
//   npm run build
//   node scripts/verify-path-problem.mjs [distDir]

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));
const { VALUE_SETS, ACTIVATE_RESPONSE_BRANCHES, AGENT_STATUS_BRANCHES } = await import(
  path.join(distDir, 'read-contract.js')
);

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label} ${value === undefined ? '(undefined)' : JSON.stringify(value)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

/**
 * A precondition of a claim rather than the claim itself. Every section here
 * asserts something about a REFUSAL, and a refusal that never happened would
 * make each of those assertions pass over `undefined` — the vacuous pass this
 * file's header is about. So each section states first that the branch it is
 * about was really taken, and an unmet precondition is a counted failure.
 */
const given = (ok, claim, detail) => {
  console.log(`  ${ok ? 'GIVEN' : 'NOT-GIVEN'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(`PRECONDITION UNMET: ${claim}`);
  return ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan382-'));
const daemonPids = new Set();
const openSockets = [];
function cleanup() {
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  for (const pid of daemonPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

// A herdr shim. `bad-address` is refused before any census is read, so nothing
// in §1–§3 depends on what this answers — but the daemon probes herdr at start,
// and §0 needs one real activation to succeed, which needs a pane to come back.
const fakeHome = path.join(scratch, 'home');
const shimDir = path.join(scratch, 'bin');
const shimState = path.join(scratch, 'shim-state');
for (const d of [fakeHome, shimDir, shimState]) fs.mkdirSync(d, { recursive: true });

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.KAN382_SHIM_STATE;
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
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN382_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

/** A directory the caller already owns. CrabCast never creates one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

class SocketClient {
  constructor(cfg, label) {
    this.label = label;
    this.nextId = 0;
    this.pending = new Map();
    this.socket = net.connect(socketPathFor(cfg.dataDir));
    openSockets.push(this.socket);
    this.socket.on('error', () => {});
    let buf = '';
    this.socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          resolve(msg);
        }
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve(this));
      this.socket.once('error', reject);
    });
  }
  /** The response with the correlation id stripped — `id` is the socket's, not the contract's. */
  async ask(action, data = {}) {
    const id = `${this.label}-${++this.nextId}`;
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out on ${action}`));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.socket.write(JSON.stringify({ action, ...data, id }) + '\n');
    });
    const { id: _drop, ...body } = msg;
    return body;
  }
  close() { try { this.socket.end(); } catch {} }
}

/**
 * A mutant build is a copy of `dist` under this script's scratch directory,
 * OUTSIDE the repository — so Node resolving `import * as pty from 'node-pty'`
 * in `herdr.js` walks up from `/tmp/…` and finds no `node_modules`. Measured
 * here: importing the `herdr.js` inside a freshly-copied mutant build fails
 * `ERR_MODULE_NOT_FOUND`, and the daemon spawned from it dies before opening its
 * socket.
 *
 * THE FAILURE MODE THAT MAKES THIS WORTH A HELPER RATHER THAN A LINE. A mutant
 * that cannot start does not look like a broken harness — `startDaemon` throws
 * with the child's stderr, which is loud here only because this script's
 * `startDaemon` reads that file. A section written to tolerate a dead mutant
 * would instead report "the mutant did not carry the field", which is the
 * mutation's expected result: the proof would credit its own broken setup with
 * the guard's verdict.
 *
 * A symlink rather than a copy: the mutant must run the MUTATED build and the
 * REAL dependencies, and 115M copied per mutant would be the only other way.
 */
function linkDependencies(dist) {
  const link = path.join(dist, 'node_modules');
  if (fs.existsSync(link)) return dist;
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), link, 'dir');
  return dist;
}

async function startDaemon(cfg, dist, label) {
  const errFile = path.join(cfg.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg.configPath], {
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) break;
    await sleep(100);
  }
  if (!fs.existsSync(sock)) {
    throw new Error(
      `daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const probe = await new SocketClient(cfg, `${label}-probe`).ready();
  const status = await probe.ask('daemon_status');
  probe.close();
  daemonPids.add(status.pid);
  return status.pid;
}

async function stopDaemon(pid, cfg) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  daemonPids.delete(pid);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(sock)) return;
    await sleep(100);
  }
}

/** Did this response really take the `bad-address` branch? */
const isBadAddress = (res) => res?.success === false && !('path' in res);

// The shared mutator, bound to this script's own verdict. It asserts an EXACT
// occurrence count of 1 for every anchor before it edits anything, and reports a
// drifted anchor as a counted failure rather than a throw — so a mutation that
// silently matched nothing cannot hand this file an unmutated build to report
// success about.
const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

// ===========================================================================
rule('SETUP — one real daemon, one configured agent, one directory about to die');

const cfg = makeConfig('main');
const pid = await startDaemon(cfg, distDir, 'main');
const client = await new SocketClient(cfg, 'main').ready();

const liveDir = owned('lives-here');
const doomedDir = owned('deleted-under-us');
const aFile = path.join(scratch, 'owned', 'a-file');
fs.writeFileSync(aFile, 'not a directory\n');

for (const dir of [liveDir, doomedDir]) {
  const r = await client.ask('configure_agent', { path: dir, launcher: 'shell', priority: 5 });
  if (r.success !== true) throw new Error(`setup: configure ${dir} failed: ${r.error}`);
}
console.log(`   configured ${liveDir}`);
console.log(`   configured ${doomedDir}  ← this one gets deleted in §2`);

// ===========================================================================
rule('§0 — the field is on a BRANCH, not on every response');

{
  const ok = await client.ask('activate_agent', { path: liveDir, override: true });
  const status = await client.ask('agent_status', { path: liveDir });
  show('activate(success).success:', ok.success);
  show('agent_status(success).success:', status.success);

  given(
    ok.success === true && status.success === true,
    'a successful activation and a successful status read were really produced — without ' +
      'them "absent on success" is a claim about two failures'
  );
  check(
    !('pathProblem' in ok) && !('pathProblem' in status),
    'NEITHER successful response carries `pathProblem` — the field is the `bad-address` ' +
      "branch's, and a daemon that put it on everything would satisfy every presence check " +
      'in §1 while saying nothing',
    `activate keys carry it: ${'pathProblem' in ok} · status keys carry it: ${'pathProblem' in status}`
  );
  check(
    ACTIVATE_RESPONSE_BRANCHES['bad-address'].always.includes('pathProblem') &&
      AGENT_STATUS_BRANCHES['bad-address'].includes('pathProblem'),
    'the contract declares it MANDATORY on that branch on both surfaces (`always` / the ' +
      'branch key list), which is what makes the wire checks below equalities rather than ' +
      'presence checks',
    `activate.always=${JSON.stringify(ACTIVATE_RESPONSE_BRANCHES['bad-address'].always)}`
  );
}

// ===========================================================================
rule('§1 — both surfaces carry it on `bad-address`, and agree about the same bad path');

{
  const relative = 'a/relative/path';
  const act = await client.ask('activate_agent', { path: relative });
  const sts = await client.ask('agent_status', { path: relative });
  show('activate(bad-address):', act);
  show('agent_status(bad-address):', sts);

  given(
    isBadAddress(act) && isBadAddress(sts),
    'BOTH responses really took the `bad-address` branch — `success: false` and no `path`. ' +
      'Every assertion below is about a refusal, and would pass over `undefined` if none happened',
    `activate: success=${act.success} hasPath=${'path' in act} · status: success=${sts.success} hasPath=${'path' in sts}`
  );
  check(
    act.pathProblem === 'not-absolute' && sts.pathProblem === 'not-absolute',
    'both surfaces name the SAME cause for the same bad path — one vocabulary, not two ' +
      'per-surface dialects a consumer would have to learn separately',
    `activate=${JSON.stringify(act.pathProblem)} status=${JSON.stringify(sts.pathProblem)}`
  );
  check(
    VALUE_SETS.pathProblem.includes(act.pathProblem),
    'the value is one the contract publishes — an unpublished value is one no consumer was ' +
      'told to expect, which is the whole failure a closed vocabulary exists to prevent',
    `${JSON.stringify(act.pathProblem)} ∈ ${JSON.stringify(VALUE_SETS.pathProblem)}`
  );
  check(
    typeof act.error === 'string' && act.error.length > 0,
    'the human `error` is untouched beside it — this is additive, and a consumer reading the ' +
      'prose today keeps reading it',
    `${act.error.slice(0, 70)}…`
  );
}

// ===========================================================================
rule('§2 — IT DISCRIMINATES: four causes, four answers, on one surface');

let discriminated = null;
{
  // `does-not-exist` is BUILT rather than faked: a directory that really
  // existed, was really configured, and is then really removed. A path that
  // never existed would reach the same branch by a different route and would
  // not be the state a running fleet meets.
  fs.rmSync(doomedDir, { recursive: true, force: true });
  const gone = !fs.existsSync(doomedDir);

  const cases = [
    ['does-not-exist', { path: doomedDir }],
    ['not-absolute', { path: 'a/relative/path' }],
    ['not-a-directory', { path: aFile }],
    ['not-a-string', { path: '' }]
  ];

  const seen = {};
  for (const [expected, req] of cases) {
    const res = await client.ask('activate_agent', req);
    seen[expected] = res;
    show(`activate(${expected}) →`, { success: res.success, pathProblem: res.pathProblem });
  }

  given(
    gone,
    'the configured directory was really deleted, so `does-not-exist` is the state a running ' +
      'fleet reaches rather than a string that never named anything',
    `${doomedDir} exists: ${fs.existsSync(doomedDir)}`
  );
  given(
    Object.values(seen).every(isBadAddress),
    'all four calls really took the `bad-address` branch',
    Object.entries(seen).map(([k, v]) => `${k}:${v.success}/${!('path' in v)}`).join(' · ')
  );

  for (const [expected] of cases) {
    check(
      seen[expected].pathProblem === expected,
      `\`${expected}\` is reported as \`${expected}\``,
      `got ${JSON.stringify(seen[expected].pathProblem)}`
    );
  }

  const values = cases.map(([e]) => seen[e].pathProblem);
  discriminated = new Set(values).size;
  check(
    discriminated === 4,
    'FOUR DISTINCT VALUES from four distinct conditions — this is the section that rules out ' +
      'a constant, and every other check in this file passes against a daemon that always ' +
      'answers `not-absolute`',
    `distinct values: ${discriminated} of 4 — ${JSON.stringify(values)}`
  );
  check(
    seen['does-not-exist'].pathProblem !== seen['not-absolute'].pathProblem,
    'THE PAIR THE TICKET IS ABOUT is separable: a deleted directory (recreate it, or ' +
      '`forget_agent`) no longer reports identically to a relative path (fix your code). ' +
      'Those remedies are not the same kind of thing, and before v10 the response could not ' +
      'tell them apart',
    `does-not-exist=${JSON.stringify(seen['does-not-exist'].pathProblem)} ` +
      `not-absolute=${JSON.stringify(seen['not-absolute'].pathProblem)}`
  );
}

// ===========================================================================
rule('§3 — the strictness asymmetry the contract states is real');

{
  // The SAME deleted directory. `activate` is strict and refuses; `agent_status`
  // is not, resolves it lexically, and answers about the record — which is why
  // §9 says `does-not-exist` never appears on that surface.
  const act = await client.ask('activate_agent', { path: doomedDir });
  const sts = await client.ask('agent_status', { path: doomedDir });
  show('activate(deleted dir):', { success: act.success, pathProblem: act.pathProblem });
  show('agent_status(deleted dir):', {
    success: sts.success, pathProblem: sts.pathProblem, path: sts.path, state: sts.state
  });

  given(
    act.pathProblem === 'does-not-exist',
    'the strict verb really answered `does-not-exist` for this directory, so the comparison ' +
      'below is between two answers about the same world'
  );
  check(
    !isBadAddress(sts) && !('pathProblem' in sts),
    '`agent_status` does NOT take the `bad-address` branch for a deleted directory — it ' +
      "resolves lexically and answers about the record, which is what §9's \"`does-not-exist` " +
      'never appears on this surface" means. A contract sentence about which members a ' +
      'surface can emit, held against the wire rather than only asserted',
    `status: success=${sts.success} hasPath=${'path' in sts} hasPathProblem=${'pathProblem' in sts}`
  );
  check(
    sts.path === doomedDir,
    'and it answers about the record under the path the directory had — the fallback this ' +
      'whole discriminator was originally introduced to scope',
    `${JSON.stringify(sts.path)}`
  );
}

client.close();
await stopDaemon(pid, cfg);

// ===========================================================================
rule('§4 — THE RED HALF: back the change out, and watch §1 and §2 go red');

// ---------------------------------------------------------------- the control
// A false-positive control. The sections above ran against the UNMUTATED tree
// and are expected to have passed; if they did not, the reds below are not
// evidence about the guard, they are evidence about a broken baseline.
const baselineFailures = failures.length;
check(
  baselineFailures === 0,
  'FALSE-POSITIVE CONTROL: the unmutated tree passed every check above. A red drive whose ' +
    'baseline is not demonstrated measures the runner as much as the guard',
  `failures before any mutation: ${baselineFailures}`
);

flatten: {
  // The pre-KAN-382 behaviour, restored exactly: the cause is dropped at the
  // boundary and the refusal is prose alone.
  const dir = mutate(
    'flatten-the-cause',
    'router.js',
    'return { error: e.message, problem: e.problem };',
    'return { error: e.message };'
  );
  if (!dir) break flatten;

  const mcfg = makeConfig('flattened');
  const mpid = await startDaemon(mcfg, linkDependencies(dir), 'flattened');
  const mclient = await new SocketClient(mcfg, 'flattened').ready();

  const act = await mclient.ask('activate_agent', { path: 'a/relative/path' });
  const sts = await mclient.ask('agent_status', { path: 'a/relative/path' });
  show('mutant activate(bad-address):', { success: act.success, pathProblem: act.pathProblem });
  show('mutant agent_status(bad-address):', { success: sts.success, pathProblem: sts.pathProblem });

  given(
    isBadAddress(act) && isBadAddress(sts),
    'the mutant still REFUSES — the mutation removed the discriminator and not the refusal, ' +
      'so what goes red below is the field rather than the branch'
  );
  check(
    act.pathProblem === undefined && sts.pathProblem === undefined,
    '§1 GOES RED against the flattened build: neither surface carries the cause, which is ' +
      'exactly the state the contract described before v10. So §1 is a check that can fail',
    `activate=${JSON.stringify(act.pathProblem)} status=${JSON.stringify(sts.pathProblem)}`
  );
  check(
    !ACTIVATE_RESPONSE_BRANCHES['bad-address'].always.every((k) => k in act),
    "and the branch's `always` set is no longer an equality against the wire — which is how " +
      '`verify-read-contract.mjs` §2d would catch the same regression from the other side',
    `absent: ${ACTIVATE_RESPONSE_BRANCHES['bad-address'].always.filter((k) => !(k in act)).join(' ')}`
  );

  mclient.close();
  await stopDaemon(mpid, mcfg);
}

constant: {
  // THE MUTATION THAT MATTERS, and the one §2 exists for: the field is present,
  // correctly typed, published, on both surfaces, mandatory on the branch — and
  // a constant. Every check in §0, §1 and §3 passes against this build.
  const dir = mutate(
    'answer-a-constant',
    'router.js',
    'return { error: e.message, problem: e.problem };',
    "return { error: e.message, problem: 'not-absolute' };"
  );
  if (!dir) break constant;

  const mcfg = makeConfig('constant');
  const mpid = await startDaemon(mcfg, linkDependencies(dir), 'constant');
  const mclient = await new SocketClient(mcfg, 'constant').ready();

  const mDoomed = owned('constant-doomed');
  await mclient.ask('configure_agent', { path: mDoomed, launcher: 'shell', priority: 5 });
  fs.rmSync(mDoomed, { recursive: true, force: true });

  const gone = await mclient.ask('activate_agent', { path: mDoomed });
  const rel = await mclient.ask('activate_agent', { path: 'a/relative/path' });
  const file = await mclient.ask('activate_agent', { path: aFile });
  show('mutant does-not-exist →', gone.pathProblem);
  show('mutant not-absolute  →', rel.pathProblem);
  show('mutant not-a-directory →', file.pathProblem);

  given(
    isBadAddress(gone) && isBadAddress(rel) && isBadAddress(file),
    'all three mutant calls really took the `bad-address` branch'
  );
  check(
    gone.pathProblem !== undefined &&
      VALUE_SETS.pathProblem.includes(gone.pathProblem) &&
      ACTIVATE_RESPONSE_BRANCHES['bad-address'].always.every((k) => k in gone),
    '§1 STAYS GREEN against the constant build — present, published, and the branch key set ' +
      'is still an equality. This is the point: presence and typing cannot see this defect',
    `pathProblem=${JSON.stringify(gone.pathProblem)}`
  );
  check(
    new Set([gone.pathProblem, rel.pathProblem, file.pathProblem]).size === 1,
    '§2 GOES RED and nothing else does: three different conditions, ONE answer. A field wired ' +
      'to a constant is what "present and correctly typed" looks like, and only a check that ' +
      'produces more than one cause can tell them apart',
    `distinct values: ${new Set([gone.pathProblem, rel.pathProblem, file.pathProblem]).size} of 3`
  );

  mclient.close();
  await stopDaemon(mpid, mcfg);
}

// ===========================================================================

rule('VERDICT');
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(
    `  ${skipped.length} MUTATION(S) DID NOT APPLY, so their sections did not run: ` +
      `${skipped.join(', ')}\n` +
      '  Those are counted as failures above. Fix the mutation, not the check it was protecting.'
  );
}
console.log(`  causes discriminated on one surface: ${discriminated ?? '(section did not run)'} of 4`);
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED');
} else {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
