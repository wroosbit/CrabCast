#!/usr/bin/env node
// KAN-528 — `crabcast list` must answer on a fleet whose prompts do not fit the
// wire, and a size failure must not be reported as an unreachable daemon.
//
// WHAT FAILURE THIS WOULD CATCH: a fleet read that echoes each agent's `prompt`
// text, so the response grows with the fleet until it exceeds the socket's 1 MiB
// framing bound — at which point `list` does not truncate, it STOPS ANSWERING,
// the connection is destroyed, and the CLI reports the transport exit code for a
// daemon it in fact reached and got an answer out of.
//
// FOUND LIVE, NOT HYPOTHESISED. On 2026-08-18 `crabcast list --json` on this
// machine's own fleet exited 3 with `Line exceeded 1048576 characters`, while
// `daemon-status` and `capacity` answered 0 over the same socket. Measured on
// that fleet's registry: prompts were 97.0% of its bytes.
//
// ---------------------------------------------------------------------------
// THE ARMS
// ---------------------------------------------------------------------------
//
//   0. CONTROL       the unmutated build, a small fleet. `list` must ANSWER.
//                    Without it every arm below measures the harness rather
//                    than the code: a scratch daemon that simply would not come
//                    up would redden §1 and be read as a reproduction.
//
//   1. THE RED       a copy of the build with the summary REMOVED — the
//                    pre-fix echo, `config` whole, prompt included — against 12
//                    synthetic agents carrying 110,000-character prompts. `list`
//                    must FAIL, on the framing bound, with no response at all.
//                    ⚠ This is the arm that makes the rest evidence: a fix
//                    whose failure mode was never reproduced has not been shown
//                    to fix anything.
//
//   2. THE GREEN     the SAME registry, the SAME 12 agents, the unmutated
//                    build. `list` must answer, exit 0, parseable.
//                    ⚠ Same fixture as §1 by construction — it is the same
//                    `dataDir`, not an equivalent one — so the two arms differ
//                    in the BUILD and in nothing else.
//
//   3. COMPLETENESS  the answer in §2 must carry all 12 agents, an exact
//                    count, the exact character count per agent, and must say
//                    in the response that it summarised the prompt. A census
//                    that under-reports is worse than one that fails loudly.
//
//   4. THE EXIT CODE oversize and unreachable must be DIFFERENT codes, shown
//                    both ways against the same CLI — and a third mutant, with
//                    the old mapping restored, must show them COLLAPSING back
//                    onto 3, which is the defect this arm is about.
//
//   5. THE SENTENCE  the retired reassurance — "no message this daemon serves
//                    approaches that size" — must be absent from the shipped
//                    build, and the message actually emitted in §1 must name
//                    the failure as a size failure. A claim its own error
//                    refutes is the defect this ticket was filed about.
//
//   6. THE GATE     ⚠ a build that silently DROPS rows must be caught by §3's
//                    own predicates. Without this arm §3 is a formality: a
//                    clipped census is a well-formed exit-0 response that looks
//                    exactly like a smaller fleet.
//
//   7. UNDISTURBED   this proof must not have touched the running fleet.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS SCRIPT DOES NOT COVER — it writes the records it then asserts on
// ---------------------------------------------------------------------------
//
// The 12 agents here are created by this script, through `configure`, and never
// activated: they land in `unstartedAgents`, which carries the same config echo
// every other category does. So this proof establishes what the RESPONSE does
// with records of that size. It does NOT establish that a real activation
// produces a fleet of that shape, and it does not exercise `agents[]` — the
// running category — because that needs herdr and real panes.
//
// THAT GAP IS REAL AND IT IS NAMED HERE RATHER THAN LEFT TO BE INFERRED
// (KAN-145's defect: two honest scripts, a hole between them that neither
// owned). What covers it: the echo is built in ONE function, `configEcho`, that
// every category spreads — so a category carrying a different shape is a
// compile error against `ROW_SHAPES`, not a runtime surprise — and
// `verify-state-read-echoes-config.mjs` is what holds that single-source
// property. The live half was observed by hand on the fleet that produced this
// ticket, and that observation is pasted in the PR rather than asserted here,
// because a proof that needs this machine's own fleet is not re-runnable.
//
// Needs a build and no herdr, no network and no panes.
//
// Usage:
//   npm run build
//   node scripts/verify-fleet-read-fits-the-wire.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');

if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(2);
}

// ---------------------------------------------------------------- the verdict

let failures = 0;
const failed = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
    failed.push(label);
  }
}
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};

// ------------------------------------------------------------------- scratch
//
// EVERYTHING THIS SCRIPT WRITES LIVES UNDER ONE ROOT IN `os.tmpdir()`, and
// nothing it runs is ever pointed at the default data dir. That is what §7
// checks rather than assumes.

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kan528-wire-'));

// The mutant builds are copies of `dist/` placed in the scratch root, and a
// copy outside the repo cannot resolve `node-pty` — the daemon's own dependency
// — by walking its parents. One symlink at the scratch root puts the real
// `node_modules` on that walk. Without it every mutant daemon dies at module
// load, which reads as "the red reproduced" while proving nothing whatever.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratchRoot, 'node_modules'));
} catch (err) {
  console.error(`could not link node_modules into the scratch root: ${err?.message ?? err}`);
  process.exit(2);
}

const daemonPids = new Set();

/** Daemons this run started that are still on the process table. */
function daemonsForThisRun() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('daemon.js') && line.includes(scratchRoot))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

let cleanedUp = false;
function cleanUp() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const pid of new Set([...daemonPids, ...daemonsForThisRun()])) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
// ON THE SIGNALS AND NOT ONLY ON `exit`: a proof that tears down only when it
// FINISHES leaves a real daemon and a real scratch directory behind every time
// it is interrupted, which is ordinary rather than exceptional for a hand-run
// script. See verify-proof-cleans-up-when-interrupted.mjs.
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

const { mutate, mutationsSkipped } = makeMutator({ distDir, scratch: scratchRoot, report });

// ------------------------------------------------------------------ the fleet
//
// 12 AGENTS AT 110,000 CHARACTERS, and both numbers are derived rather than
// picked. The framing bound is 1,048,576 characters; `MAX_PROMPT_CHARS` caps one
// prompt at 131,072, so 110,000 is a prompt this daemon genuinely accepts and is
// the size the live fleet's supervisor prompts actually run at (103,839 bytes
// measured, 2026-08-18). Twelve of them is 1,320,000 characters of prompt — over
// the bound with enough margin that the arm is not sitting on the cliff edge,
// which is what would make it flake.
const AGENT_COUNT = 12;
const PROMPT_CHARS = 110000;
const PROMPT = 'P'.repeat(PROMPT_CHARS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every instance this run created, so §7 can check ALL of them rather than the
 * three a reader happened to list. A hand-written list is the version that goes
 * stale the first time an arm is added — and it would go stale silently, in the
 * direction of checking less.
 */
const instances = [];

/** A scratch daemon's directories and config, created but not started. */
function makeInstance(name) {
  const root = path.join(scratchRoot, name);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(root, 'crabcast.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const instance = { root, dataDir, configPath, socketPath: path.join(dataDir, 'crabcast.sock') };
  instances.push(instance);
  return instance;
}

/** Start `build`'s daemon against `instance`, and wait for its socket. */
async function startDaemon(build, instance) {
  const child = spawn(process.execPath, [path.join(build, 'daemon.js'), instance.configPath], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  if (child.pid) daemonPids.add(child.pid);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { child, up: false, stderr };
    }
    const up = await new Promise((resolve) => {
      const probe = net.connect(instance.socketPath);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (up) return { child, up: true, stderr };
    await sleep(100);
  }
  return { child, up: false, stderr };
}

async function stopDaemon(handle) {
  if (!handle?.child) return;
  try { handle.child.kill('SIGTERM'); } catch { /* already gone */ }
  if (handle.child.pid) daemonPids.delete(handle.child.pid);
  await sleep(250);
}

/**
 * Run `build`'s CLI. Returns the raw result — status, stdout, stderr.
 *
 * `maxBuffer` is raised deliberately: the red arm's whole subject is a response
 * larger than a megabyte, and a default buffer would kill the child and hand
 * back an error that looks exactly like the failure being measured.
 */
function cli(build, instance, args) {
  return spawnSync(
    process.execPath,
    [path.join(build, 'cli.js'), ...args, '--config', instance.configPath],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }
  );
}

/** Configure `AGENT_COUNT` agents with realistic prompts. */
function seedFleet(build, instance) {
  const paths = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const dir = path.join(instance.root, `agent-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const res = cli(build, instance, [
      'configure', dir, '--priority', '1', '--launcher', 'shell', '--prompt', PROMPT
    ]);
    if (res.status !== 0) {
      return { paths, error: `configure ${i} exited ${res.status}: ${res.stderr?.slice(0, 400)}` };
    }
    paths.push(dir);
  }
  return { paths, error: null };
}

// ---------------------------------------------------------------------------
// §0 CONTROL — the harness works on the unmutated build
// ---------------------------------------------------------------------------

console.log('\n== 0. CONTROL: the unmutated build answers on a small fleet ==');

const control = makeInstance('control');
let controlDaemon = await startDaemon(distDir, control);
check(controlDaemon.up, 'a scratch daemon comes up on the unmutated build',
  controlDaemon.up ? control.socketPath : controlDaemon.stderr.slice(0, 300));

if (controlDaemon.up) {
  const dir = path.join(control.root, 'small');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = cli(distDir, control, [
    'configure', dir, '--priority', '1', '--launcher', 'shell', '--prompt', 'a short prompt'
  ]);
  check(cfg.status === 0, 'one agent configures', `exit=${cfg.status}`);

  const listed = cli(distDir, control, ['list', '--json']);
  check(listed.status === 0, '`list` answers on a small fleet', `exit=${listed.status}`);

  let parsed = null;
  try { parsed = JSON.parse(listed.stdout); } catch { /* stays null */ }
  check(parsed?.success === true, 'and the answer parses as a successful response');
  check(parsed?.unstartedAgents?.[0]?.promptChars === 'a short prompt'.length,
    'with the prompt reported as its exact character count',
    `promptChars=${parsed?.unstartedAgents?.[0]?.promptChars}`);
}
await stopDaemon(controlDaemon);

// ---------------------------------------------------------------------------
// §1 THE RED — the pre-fix echo, on a fleet big enough to break it
// ---------------------------------------------------------------------------

console.log('\n== 1. THE RED: with the summary removed, `list` stops answering ==');

// THE MUTATION IS THE PRE-FIX CODE, not an approximation of it. Before KAN-528
// the fleet echo was `intent.record.config` — the frozen object, prompt and all.
// `summariseConfig` is the only thing standing between that object and the wire,
// so returning its argument unchanged restores exactly the shipped behaviour
// that broke. It is applied to the COMPILED build, so `tsc` never sees it and no
// red here can be the compiler's catch credited to this proof.
const preFix = mutate(
  'pre-fix-echo',
  'router.js',
  '    const { prompt: _prompt, ...rest } = config;\n    return rest;',
  '    return config;'
);

const big = makeInstance('big');
let redSaw = null;

if (preFix) {
  const redDaemon = await startDaemon(preFix, big);
  check(redDaemon.up, 'a scratch daemon comes up on the pre-fix build',
    redDaemon.up ? '' : redDaemon.stderr.slice(0, 300));

  if (redDaemon.up) {
    const seeded = seedFleet(preFix, big);
    check(seeded.error === null, `${AGENT_COUNT} agents configure, each with a ${PROMPT_CHARS}-character prompt`,
      seeded.error ?? `paths=${seeded.paths.length}`);

    if (seeded.error === null) {
      const res = cli(preFix, big, ['list', '--json']);
      redSaw = res;

      check(res.status !== 0, '⚠ `list` FAILS on the pre-fix build — the defect reproduces',
        `exit=${res.status}`);
      // ⚠ `typeof` FIRST, AND NOT `(res.stdout ?? '')`. This check asserts an
      // ABSENCE, and a `?? ''` fallback supplies exactly the emptiness being
      // asserted — so a spawn that never ran would pass it, reporting "the
      // defect reproduced" about a command that produced no output because it
      // did not execute. The string has to have been produced to be empty.
      check(typeof res.stdout === 'string' && res.stdout.trim() === '',
        'and NO response arrives: this is not a truncated answer, it is no answer',
        `stdout=${typeof res.stdout === 'string' ? `${res.stdout.length} bytes` : `NOT A STRING (${typeof res.stdout}) — the CLI did not run`}`);
      check(/Line exceeded 1048576 characters/.test(res.stderr ?? ''),
        'and the failure is the framing bound, named',
        (res.stderr ?? '').slice(0, 120));
    }
  }
  await stopDaemon(redDaemon);
}

// ---------------------------------------------------------------------------
// §2 THE GREEN — the same registry, the shipped build
// ---------------------------------------------------------------------------

console.log('\n== 2. THE GREEN: the same 12 agents, the shipped build, answered ==');

// THE SAME `dataDir`, deliberately. A second fixture built the same way would
// leave "the two arms differ in the build" as a claim rather than a property;
// re-pointing the shipped daemon at the registry §1 just failed on makes the
// build the only variable there is.
const greenDaemon = await startDaemon(distDir, big);
check(greenDaemon.up, 'the shipped build comes up on the registry the pre-fix build choked on',
  greenDaemon.up ? '' : greenDaemon.stderr.slice(0, 300));

let answer = null;
let greenRes = null;
if (greenDaemon.up) {
  greenRes = cli(distDir, big, ['list', '--json']);
  check(greenRes.status === 0, '⚠ `list` ANSWERS — exit 0 where the pre-fix build could not reply',
    `exit=${greenRes.status}`);
  try { answer = JSON.parse(greenRes.stdout); } catch (err) {
    check(false, 'and the answer parses', String(err?.message ?? err));
  }
  if (answer) check(answer.success === true, 'and the answer parses as a successful response');
}

// ---------------------------------------------------------------------------
// §3 COMPLETENESS — nothing was dropped, and the reduction is on the record
// ---------------------------------------------------------------------------

console.log('\n== 3. COMPLETENESS: every agent present, counted exactly, reduction named ==');

/**
 * Every way `answer` fails to be a complete census, as a list of sentences.
 *
 * A FUNCTION RATHER THAN A RUN OF `check` CALLS, so §7 can point the SAME
 * predicates at a build that drops rows and require them to fire. A checker
 * that has only ever been asked about a good response is not a checker that has
 * been shown to reject a bad one — and the specific defect it exists to catch,
 * a census that silently under-reports, is invisible by construction: a clipped
 * list looks exactly like a short fleet.
 *
 * @param {any} answer   the parsed `list_agents` response
 * @param {string} root  the instance root whose `agent-N` directories to expect
 * @returns {string[]}   empty when the census is complete
 */
function censusFailures(answer, root) {
  const problems = [];
  const rows = answer?.unstartedAgents ?? [];

  if (answer?.unstartedTotal !== AGENT_COUNT) {
    problems.push(`unclipped total is ${answer?.unstartedTotal}, expected ${AGENT_COUNT}`);
  }
  if (rows.length !== AGENT_COUNT) {
    problems.push(`${rows.length} row(s) carried, expected ${AGENT_COUNT}`);
  }

  const seen = new Set(rows.map((r) => r.path));
  const missing = [];
  for (let i = 1; i <= AGENT_COUNT; i += 1) {
    const dir = path.join(root, `agent-${i}`);
    if (!seen.has(dir)) missing.push(dir);
  }
  if (missing.length) problems.push(`${missing.length} configured agent(s) have no row`);

  // ⚠ THE ASSERTION THAT MAKES THE SUMMARY HONEST. A count is only worth having
  // if it is the real one: an approximate or clipped figure here would be the
  // same defect as a dropped row, one field smaller.
  const wrongCount = rows.filter((r) => r.promptChars !== PROMPT_CHARS);
  if (wrongCount.length) {
    problems.push(
      `${wrongCount.length} row(s) report a promptChars other than ${PROMPT_CHARS} ` +
      `(e.g. ${wrongCount[0]?.promptChars})`
    );
  }
  return problems;
}

if (answer) {
  const rows = answer.unstartedAgents ?? [];
  const problems = censusFailures(answer, big.root);

  check(problems.length === 0,
    '⚠ the census is COMPLETE — every configured agent has a row, the total is exact, and every character count is the real one',
    problems.length ? problems.join('; ') : `${rows.length} rows, total ${answer.unstartedTotal}, all ${PROMPT_CHARS} chars`);

  const stillCarrying = rows.filter((r) => r.config && 'prompt' in r.config);
  check(stillCarrying.length === 0,
    'and no row carries the prompt TEXT — which is what makes the response fit',
    `${stillCarrying.length} row(s) still carried config.prompt`);

  const summarised = answer.configEchoContract?.summarised ?? [];
  check(Array.isArray(summarised) && summarised.length === 1,
    'the response DECLARES that it summarised something — a reduction nobody is told about is the failure this ticket forbids',
    `summarised=${JSON.stringify(summarised.map((s) => s.knob))}`);
  check(summarised[0]?.knob === 'config.prompt' && summarised[0]?.replacedBy === 'promptChars',
    'and names the knob and what stands in for it',
    `${summarised[0]?.knob} -> ${summarised[0]?.replacedBy}`);
  check(typeof summarised[0]?.wholeAt === 'string' && /agent_status/.test(summarised[0].wholeAt),
    'and where the whole value is still readable');

  // THE NOTE MOVED WITH THE CODE. It used to open "config on every row is the
  // durable record VERBATIM" unconditionally; on a response that summarises
  // something that sentence is false, and a claim its own response refutes is
  // the defect this ticket is about.
  // Same shape as above: the note must be PRESENT and must not make the claim.
  // `?? ''` would let a response with no note at all satisfy this.
  const note = answer.configEchoContract?.note;
  check(typeof note === 'string' && !/durable record VERBATIM/.test(note),
    'the contract note no longer claims VERBATIM on a response that summarised a knob',
    typeof note === 'string' ? note.slice(0, 90) : `no note on the response (${typeof note})`);

  // A response that was never produced is 0 bytes and would sail under the
  // bound, so presence is asserted before size.
  const produced = typeof greenRes?.stdout === 'string' && greenRes.stdout.length > 0;
  const sizeBytes = produced ? Buffer.byteLength(greenRes.stdout) : -1;
  check(produced && sizeBytes < 1048576,
    'and the whole response fits the framing bound with room to spare',
    produced ? `${sizeBytes} bytes against a 1048576 bound` : 'NO response was produced to measure');
}

// ---------------------------------------------------------------------------
// §4 THE EXIT CODE — oversize and unreachable, shown both ways
// ---------------------------------------------------------------------------

console.log('\n== 4. THE EXIT CODE: a size failure is not an unreachable daemon ==');

// (a) UNREACHABLE. A data dir with no daemon in it, and `list` does not spawn
// one. This is what exit 3 is FOR, and it is measured rather than assumed so the
// comparison below has two real readings in it instead of one.
const empty = makeInstance('empty');
const unreachable = cli(distDir, empty, ['list', '--json']);
check(unreachable.status === 3, 'an unreachable daemon exits 3 — transport, nothing was asked',
  `exit=${unreachable.status}`);

// (b) OVERSIZE, from the red arm above: the same CLI, a daemon that WAS reached
// and DID answer.
check(redSaw?.status === 5, 'a response too large to frame exits 5 — oversize',
  `exit=${redSaw?.status}`);

check(unreachable.status !== redSaw?.status,
  '⚠ and the two are DISTINGUISHABLE — which is the whole of what defect 1 was',
  `unreachable=${unreachable.status}, oversize=${redSaw?.status}`);

// (c) ⚠ THE ARM THAT SHOWS THE CHECK ABOVE CAN FAIL. With the old mapping
// restored, the oversize failure reports 3 — indistinguishable from a daemon
// that was never reached, which is what sent the agent who filed this ticket
// looking for a dead daemon. Without this arm, (a) and (b) would pass against a
// build where the two codes were never separated in the first place.
const oldMapping = mutate(
  'pre-fix-exit-code',
  [
    {
      file: 'router.js',
      find: '    const { prompt: _prompt, ...rest } = config;\n    return rest;',
      replace: '    return config;'
    },
    {
      file: 'cli.js',
      find: 'return err instanceof OversizeError ? EXIT.OVERSIZE : EXIT.TRANSPORT;',
      replace: 'return EXIT.TRANSPORT;'
    }
  ]
);

if (oldMapping) {
  const old = makeInstance('old-mapping');
  const oldDaemon = await startDaemon(oldMapping, old);
  if (oldDaemon.up) {
    const seeded = seedFleet(oldMapping, old);
    if (seeded.error === null) {
      const res = cli(oldMapping, old, ['list', '--json']);
      check(res.status === 3,
        '⚠ with the OLD mapping restored the same size failure reports 3 — the defect, reproduced',
        `exit=${res.status}`);
      check(res.status === unreachable.status,
        'and is therefore indistinguishable from a daemon that was never reached',
        `both ${res.status}`);
    } else {
      check(false, 'the old-mapping fleet seeds', seeded.error);
    }
  } else {
    check(false, 'a scratch daemon comes up on the old-mapping build',
      oldDaemon.stderr.slice(0, 300));
  }
  await stopDaemon(oldDaemon);
}

// ---------------------------------------------------------------------------
// §5 THE SENTENCE — a claim its own error refutes
// ---------------------------------------------------------------------------

console.log('\n== 5. THE SENTENCE: the reassurance its own failure refuted is gone ==');

const RETIRED = 'no message this daemon serves approaches that size';
const ipcJs = fs.readFileSync(path.join(distDir, 'ipc.js'), 'utf8');

// READ OFF THE SHIPPED ARTIFACT rather than off `src/`, because `dist/` is what
// the running daemon loads and what actually prints. A source-only check would
// go green over a stale build still emitting the sentence.
check(!ipcJs.includes(RETIRED),
  'the retired reassurance is absent from the shipped build',
  `searched dist/ipc.js for ${JSON.stringify(RETIRED)}`);

// ⚠ AND A POSITIVE CONTROL, because an absence proves nothing unless the search
// could have found something. The same read must find the text that REPLACED it
// — otherwise this section would pass just as happily against an empty file, a
// renamed module, or a read that silently returned nothing.
check(ipcJs.includes('Line exceeded'),
  'positive control: the same read DOES find the message that replaced it, so the absence above is a finding rather than a failed search');

check(/SIZE failure, not a transport one/.test(redSaw?.stderr ?? ''),
  'and the message a caller actually meets names it a size failure',
  (redSaw?.stderr ?? '').slice(0, 100));
// ⚠ THE STDERR MUST HAVE BEEN CAPTURED FOR ITS CONTENT TO MEAN ANYTHING. With
// `?? ''` a skipped §1 — a mutation that did not apply, a daemon that never came
// up — would satisfy this check about a message nobody ever read.
check(typeof redSaw?.stderr === 'string' && redSaw.stderr.length > 0
  && !redSaw.stderr.includes(RETIRED),
  '⚠ and does NOT tell the reader that what just happened cannot happen',
  typeof redSaw?.stderr === 'string' && redSaw.stderr.length > 0
    ? 'checked against the stderr §1 actually captured'
    : 'NO stderr was captured in §1 — this check measured nothing');

// ---------------------------------------------------------------------------
// §6 ⚠ THE CENSUS CHECK CAN FAIL — a build that drops rows must be caught
// ---------------------------------------------------------------------------
//
// THE ARM THIS PROOF WOULD BE WORTHLESS WITHOUT, and the one the ticket asks
// for most sharply: "whatever is chosen must not silently drop agents. A census
// that under-reports is worse than one that fails loudly."
//
// §3 asserts the census is complete. Against a build that answers correctly it
// passes — and it would pass just as contentedly against a `censusFailures`
// that could not return anything, or one pointed at the wrong field. A clipped
// census is INVISIBLE by construction: it is a well-formed response, exit 0,
// and it looks exactly like a smaller fleet. Nothing about reading it says
// otherwise, which is precisely why the checker has to be watched failing.
//
// So: a build that keeps the first 5 rows and drops the rest, and the SAME
// predicates §3 used, required to fire on it.

console.log('\n== 6. ⚠ THE CENSUS CHECK CAN FAIL: a build that drops rows is caught ==');

const dropsRows = mutate(
  'silently-drops-rows',
  'router.js',
  '            unstartedAgents: unstarted',
  '            unstartedAgents: unstarted.slice(0, 5)'
);

if (dropsRows) {
  const clipped = makeInstance('clipped');
  const clippedDaemon = await startDaemon(dropsRows, clipped);
  if (clippedDaemon.up) {
    const seeded = seedFleet(dropsRows, clipped);
    if (seeded.error === null) {
      const res = cli(dropsRows, clipped, ['list', '--json']);

      // ⚠ THE PRECONDITION, and it is what stops a broken run being read as a
      // catch. If this build had simply failed to answer, `censusFailures`
      // would report problems for the wrong reason entirely and the arm below
      // would go green having measured nothing.
      check(res.status === 0,
        'the row-dropping build still ANSWERS — so what §3 catches below is the drop and not a failure',
        `exit=${res.status}`);

      let clippedAnswer = null;
      try { clippedAnswer = JSON.parse(res.stdout); } catch { /* stays null */ }
      check(clippedAnswer?.success === true, 'and its answer parses as a successful response');

      if (clippedAnswer) {
        const problems = censusFailures(clippedAnswer, clipped.root);
        check(problems.length > 0,
          '⚠ and §3\'s OWN predicates REJECT it — the completeness check is a gate rather than a formality',
          problems.join('; '));

        // THE SILENT-DROP SIGNATURE, asserted specifically rather than left
        // inside the count above: the total still says 12 while 5 rows arrive.
        // A consumer reading only the rows concludes the fleet is 5 agents.
        check(clippedAnswer.unstartedTotal === AGENT_COUNT
          && (clippedAnswer.unstartedAgents ?? []).length < AGENT_COUNT,
          'and the drop is exactly the shape that is invisible without the check: the total still reads 12 while 5 rows arrive',
          `total=${clippedAnswer.unstartedTotal}, rows=${(clippedAnswer.unstartedAgents ?? []).length}`);
      }
    } else {
      check(false, 'the row-dropping fleet seeds', seeded.error);
    }
  } else {
    check(false, 'a scratch daemon comes up on the row-dropping build',
      clippedDaemon.stderr.slice(0, 300));
  }
  await stopDaemon(clippedDaemon);
}

// ---------------------------------------------------------------------------
// §7 UNDISTURBED — the running fleet was never touched
// ---------------------------------------------------------------------------

console.log('\n== 7. UNDISTURBED: the running fleet was not touched ==');

// The boundary this proof was given: scratch daemon, own config, own data dir.
// Checked rather than asserted — every instance's dataDir must sit under this
// run's own scratch root, which is in `os.tmpdir()`.
const outside = instances.filter((i) => !i.dataDir.startsWith(scratchRoot + path.sep));
check(outside.length === 0,
  'every daemon this proof started used a data dir under its own scratch root',
  outside.length ? outside.map((i) => i.dataDir).join(', ') : `${instances.length} instances, all under ${scratchRoot}`);

const defaultRegistry = path.join(os.homedir(), '.local', 'share', 'crabcast', 'agents.jsonl');
check(!instances.some((i) => i.dataDir.includes(path.join('.local', 'share', 'crabcast'))),
  'and none of them was the default data dir',
  defaultRegistry);

await stopDaemon(greenDaemon);

// --------------------------------------------------------------------- verdict

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed:`);
  for (const label of failed) console.log(`  - ${label}`);
} else {
  console.log('all checks passed');
}
cleanUp();
process.exit(failures ? 1 : 0);
