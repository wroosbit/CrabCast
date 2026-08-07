// Live proof that a failed agent spawn is REPORTED rather than swallowed — the
// extraction source's KAN-24 legibility fix, exercised against a real herdr and
// then watched going red against a build that swallows it.
//
// WHAT FAILURE THIS WOULD CATCH: a refused `herdr agent start` that comes back
// looking like a success — a session carrying no `spawnError`, so `activate`
// answers `success: true` for an agent that does not exist. That is the KAN-24
// outage exactly, and it stayed invisible for an afternoon. It also catches the
// softer regression the fix was really about: a `spawnError` that quotes the
// raw operating-system error with none of the diagnosis that says WHICH of the
// two failures you are in, and the opposite mistake of a diagnosis that has
// REPLACED herdr's own words instead of following them.
//
// ---------------------------------------------------------------------------
// WHAT IT USED TO CATCH — nothing, and that is why this revision exists
// ---------------------------------------------------------------------------
//
// Until KAN-197 this file drove the two failure modes, PRINTED what HerdrBridge
// reported for each, and ended `process.exit(0)`. No check, no counter, no
// `process.exitCode`. Back the KAN-24 fix out and it printed
// `spawnError .. (none)`, printed `== done ==`, and exited green: it was the
// only proof in this suite with no verdict at all, and nothing in the
// repository noticed, because its EXCLUSIONS entry in `verify-proof-registry`
// answers why CI cannot run it and was never asked whether it reports anything.
// The filename and the word "proof" in this header were the whole of the claim.
//
// §2 is the difference. Writing assertions was the easy half; what makes them
// evidence is that the SAME predicates are run against a build with the KAN-24
// fix taken out and are required to come back FALSE.
//
// ---------------------------------------------------------------------------
// WHY §3 IS LAST
// ---------------------------------------------------------------------------
//
// Dropping the herdr server's file-descriptor ceiling cripples it for the rest
// of the process, so every spawn after §3 would fail for the wrong reason and
// §1 and §2 would be asserting about fd exhaustion while claiming to be about
// geometry. The ordering is load-bearing, not editorial.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROOF DOES NOT COVER, said plainly because the gap between two
// honest mechanisms is where this epic keeps finding defects
// ---------------------------------------------------------------------------
//
// IT DOES NOT DRIVE `activate`. Everything here is asserted at the
// `HerdrBridge` level, and the "activate would say" line is RECONSTRUCTED from
// `session.spawnError` rather than read out of a real `MessageRouter`. That
// reconstruction is not left as an assumption — §0 reads the compiled
// `router.js` under test and requires the activate path to still branch on
// `session.spawnError` and nothing else, so the reconstruction goes red if the
// daemon's predicate moves. What that still does not do is run the route:
// nothing here proves a request arriving over the socket reaches that branch.
// `verify-activate-verified-existence` is what drives the real router, and it
// says in its own header that this file covers the other half.
//
// IT SUPPLIES ITS OWN INPUT IN §2, in the exact shape KAN-145's two scripts
// did. The mutant is a build this script wrote, so §2 proves that the
// assertions above respond to a bridge that swallows a refusal — NOT that the
// bridge shipped in `dist/` is the one CrabCast runs. §1 and §3 are what assert
// on the real build; §0's build-stamp line names which revision that was.
//
// IT PROVES NOTHING ABOUT ANY OTHER SPAWN FAILURE. Two modes are induced
// because two are what a real herdr can be made to produce here. A refusal
// arriving by some third mechanism is not covered by anything in this file.
//
// ---------------------------------------------------------------------------
//
// Everything runs against a private herdr server on its own socket, so it
// cannot disturb a live session; workspaces land in a scratch dataDir and no
// pane outside that server is touched, read or closed.
//
// Usage: node scripts/verify-spawn-failure-legibility.mjs [distDir]
//
// distDir defaults to ../dist. Run it after `npm run build`.
//
// Exit status: 0 when every assertion passed, 1 on any failure or NOT RUN, 2
// when the run refused to start at all.

import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync, readFileSync, symlinkSync, existsSync, readlinkSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

// sockaddr_un.sun_path is ~108 bytes, so the socket cannot live under a long
// TMPDIR. /tmp directly is the only reliably short option.
const runDir = mkdtempSync('/tmp/herdr-k24-');
const stateDir = mkdtempSync(path.join(tmpdir(), 'k24-state-'));
const dataDir = path.join(stateDir, 'data');
const scratch = path.join(stateDir, 'scratch');

process.env.HERDR_SOCKET_PATH = path.join(runDir, 'h.sock');
process.env.XDG_CONFIG_HOME = path.join(stateDir, 'config');
process.env.XDG_STATE_HOME = path.join(stateDir, 'state');
process.env.HERDR_LOG = 'herdr=info';
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
mkdirSync(scratch, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const herdr = (...args) => {
  try {
    return execFileSync('herdr', args, { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    return e.stdout ?? String(e);
  }
};

// ---------------------------------------------------------------- verdict --

let failures = 0;
/**
 * TWO DETAILS RATHER THAN ONE, because they are answers to different questions.
 * `whenFalse` is the reason this went wrong; `whenTrue` is the evidence that it
 * did not. Written as one field, the reason for failing is printed on the
 * passing line too — `PASS  the failure mode was actually induced — nothing was
 * refused` — which is a sentence a reader has to stop and unpick, on the line
 * that was supposed to cost them nothing. Measured, not reasoned: the first
 * draft of this file did exactly that.
 */
const check = (ok, claim, whenFalse = '', whenTrue = '') => {
  const detail = ok ? whenTrue : whenFalse;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

/**
 * Something this run could not measure — and in THIS file that is a FAILURE,
 * counted, not a third quiet verdict.
 *
 * `verify-readme-is-current` is where the three-verdict shape in this
 * repository was worked out, and it can afford SKIP locally precisely because
 * it is a CI array entry: the runner runs it again and its `skip` is
 * `check(false)` there, so nothing goes uncovered without something going red
 * somewhere. THIS FILE IS EXCLUDED FROM CI (verify-proof-registry's EXCLUSIONS
 * register says why: it needs a real herdr server and real panes). It is
 * hand-run and its output is pasted onto a pull request, so the run in front of
 * you is the only run there will ever be, and a NOT RUN that exited 0 would be
 * read as a pass by the one reader it has. That is the KAN-197 defect in a new
 * costume, which is the one thing this revision may not ship.
 *
 * So NOT RUN keeps its word — the reader has to be able to tell "this was
 * checked and held" from "this was never checked" — and loses the exit code.
 */
const notRun = [];
const skip = (claim, detail = '') => {
  notRun.push(claim);
  return check(
    false,
    `NOT RUN — ${claim}`,
    `${detail}${detail ? '. ' : ''}NOT RUN is red here rather than amber because this proof is ` +
      `excluded from CI and hand-run: nothing runs it again, so an exit 0 would be the only ` +
      `verdict anyone ever saw`
  );
};

let server;
let tinyClient;
function cleanup() {
  tinyClient?.kill('SIGKILL');
  server?.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
process.on('exit', cleanup);
// `exit` handlers do not run on a signal, and the thing left behind would be a
// herdr SERVER — so the two signals a hand-run proof actually meets are wired
// to a path that goes through cleanup rather than around it.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${sig}] cleaning up the private server and scratch before exiting`);
    process.exit(130);
  });
}

// =========================================================================
rule('0. THE MACHINE, AND THE PREDICATE THIS SCRIPT RECONSTRUCTS');
// =========================================================================

console.log('\n== starting a private herdr server ==');
server = spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env: process.env });
let serverUp = false;
for (let i = 0; i < 20; i++) {
  if (herdr('pane', 'list').includes('"panes"')) { serverUp = true; break; }
  await sleep(500);
}
console.log(`   pid ${server.pid}, socket ${process.env.HERDR_SOCKET_PATH}`);

// A setup guard, not a verdict: with no server there is no refusal to observe,
// and every section below would fail about the wrong thing. Exit 2 is what the
// live proofs in this suite use for "refusing to run" (verify-no-attach-steal,
// verify-pretrust-survives-concurrency, verify-tab-per-agent).
if (!serverUp) {
  console.error(
    `refusing to run: the private herdr server on ${process.env.HERDR_SOCKET_PATH} never answered ` +
    `\`herdr pane list\`. Nothing was spawned and nothing was measured — this is a fact about the ` +
    `machine, and a red verdict here would point at HerdrBridge, which was never reached.`
  );
  process.exit(2);
}

const stampPath = path.join(distDir, 'build-stamp.json');
console.log(
  `   build under test: ${distDir}` +
  (existsSync(stampPath) ? ` — ${readFileSync(stampPath, 'utf8').replace(/\s+/g, ' ').trim()}` : ' (no build stamp)')
);

/**
 * The daemon's own activate predicate, in the compiled build under test.
 *
 * `activateWouldSay` below RECONSTRUCTS what `activate` answers for a session,
 * because this script asserts at the HerdrBridge level and never drives the
 * router. A reconstruction nobody checks is a claim about code that has moved
 * on: `fail(…)` could grow a second condition, or the refusal could move behind
 * `confirmActivation`, and every "activate would say" line here would go on
 * being printed in the same words while describing a daemon that no longer
 * exists. So the branch is read out of the build under test and required to
 * still be exactly this.
 */
const ACTIVATE_REFUSES_ON_SPAWN_ERROR =
  '        if (session.spawnError) {\n' +
  '            fail(session.spawnError, { path: agentPath });\n' +
  '            return;\n' +
  '        }\n';

routerPredicate: {
  let routerJs;
  try {
    routerJs = readFileSync(path.join(distDir, 'router.js'), 'utf8');
  } catch (e) {
    check(false, 'the compiled router can be read, so its activate predicate can be checked',
      `${path.join(distDir, 'router.js')}: ${e?.message ?? e}`);
    break routerPredicate;
  }
  const n = routerJs.split(ACTIVATE_REFUSES_ON_SPAWN_ERROR).length - 1;
  check(
    n === 1,
    "activate's spawn path still refuses on `session.spawnError` alone — so this script's " +
      '"activate would say" reconstruction is about the daemon that is here',
    `found ${n} occurrences. Either the predicate changed (in which case the reconstruction ` +
      `below is now wrong and this file has to follow it) or it was reworded (in which case ` +
      `move the anchor). Not a HerdrBridge failure.`,
    `${path.join(distDir, 'router.js')}, exactly one occurrence`
  );
}

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const bridge = new HerdrBridge(dataDir);

// The `shell` launcher, explicitly: what is under proof is spawn-failure
// reporting, not launcher provisioning, and `shell` touches nothing outside
// the scratch (a claude launcher would write folder trust into the real
// ~/.claude.json).
const AS_SHELL = {
  priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
};

/**
 * A directory for one of this script's scratch agents.
 *
 * It has to be created here, because an agent is its directory and CrabCast
 * creates none: `spawnSession` runs the pane in a path the caller supplies and
 * `configure` refuses one that is not there.
 */
function agentDir(name) {
  const dir = path.join(stateDir, 'owned', name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** What `handleActivateByKey` would answer for this session — see §0. */
const activateWouldSay = (session) =>
  session.spawnError
    ? { success: false, error: session.spawnError }
    : { success: true, sessionId: session.sessionId, status: session.status };

/**
 * The properties KAN-24 requires of a refused spawn, as predicates over one
 * session.
 *
 * RETURNED AS ROWS RATHER THAN CHECKED IN PLACE, and that is the whole design
 * of this file. §1 and §3 require every row to be TRUE against the real build;
 * §2 requires the central ones to be FALSE against a build with the fix taken
 * out. Two callers over ONE predicate set is the only arrangement in which the
 * second says anything about the first — a separate "and here is what the old
 * build did" written by hand would be a demonstration again.
 *
 * `central` marks the rows that ARE the KAN-24 property, and §2 requires
 * exactly those to flip. `status` is deliberately not one of them: the mutant
 * falls through to `attachPty`, whose pty exits within a second or so when the
 * agent it attaches to was never created, and the session-ended listener then
 * writes `terminated` — so on the swallowing build `status` is a race and
 * `spawnError` is not. The KAN-23 note in `router.ts` says the same thing from
 * the other side: activate checks `spawnError` ALONE, and a session can be
 * `terminated` and still be answered `success: true`.
 */
function kan24Properties(diagnosis) {
  return [
    {
      id: 'recorded',
      central: true,
      claim: 'the failure is recorded on the session',
      ok: (s) => typeof s.spawnError === 'string' && s.spawnError.length > 0,
      detail: (s) => `spawnError is ${JSON.stringify(s.spawnError ?? null)} — the refusal was swallowed`
    },
    {
      id: 'not-active',
      central: false,
      claim: 'the session is not left marked active',
      ok: (s) => s.status !== 'active',
      detail: (s) => `status: ${s.status}`
    },
    {
      id: 'activate-refuses',
      central: true,
      claim: 'activate would report the failure rather than success',
      ok: (s) => activateWouldSay(s).success === false,
      detail: (s) => `activate would have said success: ${activateWouldSay(s).success}`
    },
    {
      id: 'verbatim',
      central: true,
      claim: "herdr's own words are kept, and kept FIRST",
      ok: (s) => typeof s.spawnError === 'string' && / — /.test(s.spawnError) &&
        s.spawnError.split(' — ')[0].trim().length > 0 && !/^This is |^The herdr server is/.test(s.spawnError),
      detail: (s) =>
        `a diagnosis that paraphrases the error it does not recognise is how the original gets ` +
        `lost: ${JSON.stringify((s.spawnError ?? '').slice(0, 80))}`
    },
    {
      id: 'diagnosed',
      central: true,
      claim: 'the error diagnoses the cause rather than only quoting the OS',
      ok: (s) => diagnosis.test(s.spawnError ?? ''),
      detail: (s) => `expected ${diagnosis} in: ${s.spawnError ?? '(none)'}`
    }
  ];
}

/** Print what the bridge reported, so the demonstration survives the verdict. */
function show(session) {
  console.log(`   session.status ...... ${session.status}`);
  console.log(`   session.spawnError .. ${session.spawnError ?? '(none)'}`);
  console.log(`   activate would say .. ${JSON.stringify(activateWouldSay(session), null, 2).replace(/\n/g, '\n' + ' '.repeat(27))}`);
  console.log('');
}

/**
 * The real build's answer, held to every property.
 *
 * The first check is the one that stops the rest from being vacuous: if the
 * spawn SUCCEEDED, the failure mode was never induced and this section has
 * proved nothing about reporting a refusal — which is a failure of the proof,
 * not a pass.
 */
function requireReported(label, session, diagnosis) {
  show(session);
  check(
    session.status !== 'active' || Boolean(session.spawnError),
    `${label}: the failure mode was actually induced`,
    `status ${session.status} with no spawnError — nothing was refused, so nothing below is a ` +
      `statement about refusals`,
    // REPORTS WHAT IT SAW rather than restating the claim. The predicate is a
    // disjunction, and on a build that swallows the refusal the LEFT arm is
    // what satisfies it — a detail reading "spawnError set" would then be a
    // sentence claiming more than the check covers, three lines under a header
    // about that exact defect.
    `status ${session.status}, spawnError ${session.spawnError ? 'set' : 'ABSENT'}`
  );
  for (const p of kan24Properties(diagnosis)) {
    check(p.ok(session), `${label}: ${p.claim}`, p.detail(session));
  }
}

/** The collapsed-geometry failure mode: a client attached reporting a 1x1 window. */
async function collapseGeometry() {
  // A pty with no window size reports 1x1, which shrinks the workspace layout
  // until a new pane's share rounds to zero. This is the exact mechanism.
  tinyClient = spawn('script', ['-q', '-c', 'herdr agent attach anchor --takeover', '/dev/null'],
    { stdio: 'ignore', env: process.env });
  await sleep(3000);
}
async function releaseGeometry() {
  tinyClient?.kill('SIGKILL');
  tinyClient = null;
  await sleep(2000);
}

const GEOMETRY_DIAGNOSIS = /This is a pane-geometry failure, not a resource failure/;

/**
 * THE FD MODE HAS TWO SHAPES, and this was found by running it rather than by
 * reading `herdr-health.ts` — the first draft asserted only the first and went
 * red on a run where the server hit its ceiling one syscall earlier.
 *
 * A server one fd from its limit can fail at `openpty` (`No file descriptors
 * available`, which `diagnoseSpawnFailure` recognises by name and answers with
 * the "out of file descriptors" note) or it can refuse the CONNECTION before
 * the spawn is ever asked for (`Os { code: 111, kind: ConnectionRefused }`,
 * which it does not recognise). Which one you get depends on how many fds the
 * server happens to be holding at that instant, and neither is a wrong answer.
 *
 * Both are covered because `diagnoseSpawnFailure` attaches fd pressure WHENEVER
 * IT IS HIGH, even for an error it does not recognise — a deliberate arm, and
 * the one that saves the unrecognised case from being a bare OS string. So the
 * property asserted is what that arm is for: the message NAMES THE FD NUMBERS,
 * whichever syscall gave way. A run that produced only `Os { code: 111 }` with
 * no pressure note would fail this, and should.
 *
 * The old script would have printed either and exited 0, which is why nobody
 * knew the mode had two shapes.
 */
const FD_DIAGNOSIS =
  /The herdr server is out of file descriptors|Resource pressure at the time: herdr server \(pid \d+\) holds \d+\/\d+ open files/;

// =========================================================================
rule('1. FAILURE MODE 1 — collapsed pane geometry (the real KAN-24 outage)');
// =========================================================================

herdr('agent', 'start', 'anchor', '--cwd', '/tmp', '--', 'bash', '-c', 'while true; do sleep 5; done');
await sleep(1000);
await collapseGeometry();

const geometrySession = bridge.spawnSession(agentDir('geometry'), AS_SHELL);
await sleep(500);
requireReported('geometry', geometrySession, GEOMETRY_DIAGNOSIS);

// =========================================================================
rule('2. THE MUTATION — the pre-KAN-24 bridge, and §1 going red on it');
// =========================================================================
//
// The geometry client from §1 is still attached, so the server is still
// refusing every spawn for the same reason and by the same mechanism. Two
// spawns are taken through it, back to back:
//
//   the CONTROL, on the real build — which is what makes the mutant's silence
//     evidence rather than an observation. A mutant that reported nothing
//     because the machine had stopped refusing looks identical to one that
//     swallowed a refusal, and `scripts/mutation.mjs` says in its own header
//     that a mutation can apply perfectly and still land on a build that
//     behaves like the original. The control is what tells those apart, in the
//     same seconds and against the same server.
//
//   the MUTANT, on a copy of the build with the KAN-24 catch arm removed — the
//     bare `spawnSync` whose result was discarded, which is what the fix
//     replaced. Its central properties must come back FALSE.
//
// WHAT THE MUTANT IS NOT: the build CrabCast ships. §2 proves these assertions
// respond to a bridge that swallows a refusal; §1 and §3 are what say anything
// about `dist/`.

/**
 * The KAN-24 catch arm, as `tsc` emits it. If this drifts, `mutate` counts a
 * verdict and this section is skipped rather than the file dying inside it.
 */
const REPORTS_THE_REFUSAL =
  '                else {\n' +
  '                    session.spawnError = diagnoseSpawnFailure(e?.message ?? String(e));\n' +
  "                    // 'terminated' rather than 'active': there is no agent to attach to,\n" +
  '                    // and a session left active would advertise a terminal that can never\n' +
  '                    // produce output.\n' +
  "                    session.status = 'terminated';\n" +
  '                    console.error(`[HerdrBridge] Could not start herdr agent ${paneName}: ${session.spawnError}`);\n' +
  '                    return;\n' +
  '                }\n';
const SWALLOWS_THE_REFUSAL =
  '                else {\n' +
  '                    // KAN-197 MUTANT: the pre-KAN-24 bridge, where `herdr agent start` was a\n' +
  '                    // bare spawnSync whose result was discarded. The refusal is dropped on the\n' +
  '                    // floor and the session falls through to attachPty as though it had worked.\n' +
  '                }\n';

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => check(true, label, '', detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

/**
 * Give a mutant build somewhere to resolve `node-pty` from.
 *
 * `herdr.js` imports node-pty as a VALUE, and from a mutant under the scratch
 * directory that does not resolve — the failure is an exception at import time.
 * The shape and the reasoning are `verify-restart-survival`'s
 * `linkRuntimeDepsInto`, which hit this first and recorded why the alternative
 * (putting the mutant inside the repo tree so resolution walks up to the real
 * `node_modules`) was rejected: it writes a mutated build into a working tree
 * other checks read.
 *
 * The link is READ BACK rather than reported as intended, because the two
 * differ exactly when something is wrong and this is a setup step a whole
 * section is skipped on.
 */
function linkRuntimeDepsInto(mutantDir) {
  const link = path.join(mutantDir, 'node_modules');
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve('node-pty');
  } catch (err) {
    return { ok: false, detail: `node-pty is not resolvable from this script (${err?.message ?? err})` };
  }
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = entry.lastIndexOf(marker);
  if (at === -1) {
    return { ok: false, detail: `node-pty resolved to ${entry}, which is not under a node_modules directory` };
  }
  symlinkSync(entry.slice(0, at + marker.length - 1), link, 'dir');
  const resolved = existsSync(path.join(link, 'node-pty'));
  const pointsAt = (() => {
    try { return readlinkSync(link); } catch (err) { return `unreadable (${err?.message ?? err})`; }
  })();
  return {
    ok: resolved,
    detail: resolved
      ? `${link} -> ${pointsAt}`
      : `${link} was created but node-pty is not readable through it — it points at ${pointsAt}`
  };
}

mutation: {
  const mutantDir = mutate('pre-kan24-swallowed-spawn', 'herdr.js', REPORTS_THE_REFUSAL, SWALLOWS_THE_REFUSAL);
  // Already a counted failure. Skip the section rather than asserting about a
  // build that was never mutated.
  if (!mutantDir) break mutation;

  const linked = linkRuntimeDepsInto(mutantDir);
  check(
    linked.ok,
    '(setup) the mutant can resolve node-pty — without it the import throws and a mutant that ' +
      'died on startup reports exactly what a well-behaved one reports',
    linked.detail,
    linked.detail
  );
  if (!linked.ok) break mutation;

  console.log('\n   -- the control: the real build, same server, same collapsed geometry --\n');
  const controlSession = bridge.spawnSession(agentDir('control'), AS_SHELL);
  await sleep(500);
  show(controlSession);
  const controlReported = check(
    Boolean(controlSession.spawnError) && GEOMETRY_DIAGNOSIS.test(controlSession.spawnError ?? ''),
    'CONTROL: the geometry mode is STILL being refused at this moment, on the real build',
    controlSession.spawnError
      ? `refused, but not for the geometry reason: ${controlSession.spawnError}`
      : 'no spawnError — the server stopped refusing, so a silent mutant below would prove nothing ' +
        'and this section is not evidence',
    'the same server refused this spawn seconds before the mutant asked it the same question'
  );
  if (!controlReported) break mutation;

  console.log('\n   -- the mutant: the same refusal, through a build that discards it --\n');
  const { HerdrBridge: MutantBridge } = await import(path.join(mutantDir, 'herdr.js'));
  const mutantSession = new MutantBridge(path.join(scratch, 'mutant-data'))
    .spawnSession(agentDir('mutant'), AS_SHELL);
  await sleep(500);
  show(mutantSession);

  const rows = kan24Properties(GEOMETRY_DIAGNOSIS).map((p) => ({ ...p, held: p.ok(mutantSession) }));
  for (const p of rows.filter((r) => r.central)) {
    check(
      !p.held,
      `MUTANT: "${p.claim}" goes RED, as it must on a build that swallows the refusal`,
      'it still passed. Either the mutation landed somewhere that no longer matters, or this ' +
        'assertion is not measuring what it says — and an assertion that cannot fail on the ' +
        'pre-fix build is the KAN-197 defect with a check() in front of it',
      p.detail(mutantSession)
    );
  }

  console.log('\n   --- the matrix: one predicate set, two builds ---\n');
  const w = Math.max(...rows.map((r) => r.claim.length));
  console.log(`   ${'property'.padEnd(w)}  real build   mutant       required of the mutant`);
  for (const r of rows) {
    const real = kan24Properties(GEOMETRY_DIAGNOSIS).find((p) => p.id === r.id).ok(controlSession);
    console.log(
      `   ${r.claim.padEnd(w)}  ${(real ? 'PASS' : 'FAIL').padEnd(11)}  ${(r.held ? 'PASS' : 'FAIL').padEnd(11)}  ` +
      `${r.central ? 'FAIL' : '(not required — see kan24Properties)'}`
    );
  }
  console.log(
    `\n   'the session is not left marked active' is not required to flip: the mutant falls through\n` +
    `   to attachPty, whose pty exits when the agent it attaches to was never created, and the\n` +
    `   session-ended listener writes 'terminated' shortly after. It is a race on that build.\n` +
    `   'the failure is recorded' is not a race, which is why activate checks it and this does too.`
  );
}

await releaseGeometry();

// =========================================================================
rule('3. FAILURE MODE 2 — file-descriptor exhaustion (prlimit)');
// =========================================================================

const openNow = readdirSync(`/proc/${server.pid}/fd`).length;
const wantSoft = openNow + 1;
console.log(`\n   server currently holds ${openNow} fds; dropping its soft limit to ${wantSoft}`);

let prlimitError = null;
try {
  execFileSync('prlimit', ['--pid', String(server.pid), `--nofile=${wantSoft}:1048576`]);
} catch (e) {
  // Flattened: prlimit's own stderr is multi-line, and a detail with newlines
  // in it breaks the one-line-per-verdict shape a reader scans.
  prlimitError = String(e?.message ?? e).replace(/\s+/g, ' ').trim();
}

/** What the kernel says the limit is now — asked, not assumed. */
const softNow = (() => {
  const line = readFileSync(`/proc/${server.pid}/limits`, 'utf8')
    .split('\n').find((l) => l.startsWith('Max open files'));
  console.log(`   limit now: ${line?.trim() ?? '(no "Max open files" line)'}`);
  const soft = Number(line?.split(/\s{2,}/)[1]);
  return Number.isFinite(soft) ? soft : null;
})();

// THE STEP THAT HAS TO BE RECORDED AS HAVING TAKEN EFFECT, not merely
// attempted. The old file printed `prlimit failed (…); skipping this mode` and
// carried on to exit 0 — a mode that could not be induced reported as a mode
// that held. A `prlimit` that returned 0 and changed nothing has the same
// shape, so the limit is read back out of /proc rather than inferred from the
// exit status.
fdMode: {
  if (prlimitError !== null) {
    skip(
      'failure mode 2: prlimit could not drop the herdr server\'s fd ceiling, so nothing here ' +
        'exercises the fd path',
      prlimitError
    );
    break fdMode;
  }
  if (softNow !== wantSoft) {
    skip(
      'failure mode 2: prlimit returned success but the ceiling did not move, so a spawn failing ' +
        'here would be failing for some other reason',
      `asked for ${wantSoft}, /proc/${server.pid}/limits says ${softNow}`
    );
    break fdMode;
  }
  check(true, 'the fd ceiling really moved — the mode below is induced by this script', '',
    `soft limit ${softNow}, and the server already holds ${openNow}`);

  const fdSession = bridge.spawnSession(agentDir('fdlimit'), AS_SHELL);
  await sleep(500);
  requireReported('fdlimit', fdSession, FD_DIAGNOSIS);
}

// -------------------------------------------------------------------------

const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`\n${skipped.length} mutation(s) DID NOT APPLY and their section never ran: ${skipped.join(', ')}`);
}

console.log(`\n${'='.repeat(78)}`);
if (failures) {
  console.log(
    `\n${failures} CHECK(S) FAILED` +
    (notRun.length
      ? `, of which ${notRun.length} because something could not be measured:\n` +
        notRun.map((s) => `  - NOT RUN: ${s}`).join('\n')
      : '')
  );
} else {
  console.log(
    '\nALL CHECKS PASSED — both refused spawns were recorded, diagnosed and never passed off as\n' +
    'running, and the assertions that say so were watched going red against a build that\n' +
    'swallowed the refusal.'
  );
}
console.log(
  '\nRemember what a green run does NOT say: that a request over the socket reaches the branch\n' +
  "§0 anchored (verify-activate-verified-existence drives the router), or anything about a\n" +
  'spawn refusal arriving by some third mechanism.\n'
);
process.exit(failures ? 1 : 0);
