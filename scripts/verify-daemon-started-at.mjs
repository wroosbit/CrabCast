// KAN-214: `startedAt` — WHEN THIS DAEMON'S PROCESS BEGAN — on both surfaces
// that answer a caller, agreeing with each other, and tracking a real start.
//
// WHAT FAILURE THIS WOULD CATCH: a `startedAt` that is present, correctly typed
// and always wrong — the field looking exactly like a field while the value
// behind it is the moment of the CALL rather than the moment of the BOOT. That
// defect is invisible to every shape assertion anybody would write: the key is
// there, it is a string, it parses as a date, and it is always plausible. It is
// also the exact defect this epic keeps re-finding — KAN-145 shipped
// `activatedBy: null` for a whole production fleet behind two green proofs, and
// KAN-200 and KAN-208 were the same shape one slice apart: a value present,
// correctly typed, and never once read from a real daemon over a real socket.
//
// It would equally catch the regression the field was ADDED to prevent: the two
// surfaces disagreeing. `daemon_status` and `list_agents` are fed by one
// `eventWatermark()` precisely so they cannot, and §3 breaks that on purpose to
// show the assertion is load-bearing rather than decorative.
//
// WHY A SHAPE ASSERTION IS NOT ENOUGH HERE, AND WHY A SINGLE READING IS NOT
// EITHER. One reading of a clock is indistinguishable from a constant: assert
// `typeof startedAt === 'string'` against a build that hard-codes the daemon's
// compile date and it passes forever. So the value is never asserted alone. It
// is asserted as a POSITIVE FINGERPRINT, four ways, each of which a wrong build
// fails differently:
//
//   * IT IS IN THE PAST BY THE DAEMON'S REAL AGE (§1c). The script sleeps a
//     known interval after the socket opens and before it asks, then requires
//     the reported age to be at least that interval. A `new Date()` computed
//     per request reports an age of ~0 and fails here — and that is the single
//     most likely wrong implementation, because it is what every OTHER
//     timestamp on these responses correctly is.
//   * IT DOES NOT MOVE BETWEEN TWO CALLS TO THE SAME DAEMON (§1d). A boot time
//     is fixed for the life of the process. `observedAt` on the very same
//     response DOES move, and §1d reads both, so the comparison is against a
//     field known to be live rather than against an assumption.
//   * THE TWO SURFACES AGREE BYTE FOR BYTE (§2).
//   * IT CHANGES ACROSS A REAL RESTART, BY ROUGHLY THE GAP WE IMPOSED (§4).
//     This is the positive control, and it is not a second happy-path test: a
//     constant passes §1 completely and can only be caught by making the value
//     move. The daemon is stopped, a measured pause is taken, a NEW process is
//     started, and the new value must be later than the old one by about that
//     pause — with a different pid and a different bootId beside it, so "the
//     same daemon answered twice" cannot be mistaken for a restart.
//
// WHAT SUPPLIES THE INPUT, STATED BECAUSE IT BOUNDS WHAT THIS PROVES. Nothing
// here constructs a start time or hands one to the daemon. Every value asserted
// on is read back over a unix socket from a daemon this script spawned as a
// real OS process, and the only thing the script controls is WHEN it spawns it
// and how long it waits before asking. That is deliberate and it is the half
// KAN-145 was missing: a proof that supplies its own input has not tested that
// the input arrives. The clock is the machine's; the boot is the daemon's; this
// file only measures the distance between them.
//
// WHAT THIS DOES NOT ESTABLISH, said plainly because a timestamp invites more
// than it says:
//
//   * NOT HEALTH. It says when the process started, not that it is working. A
//     daemon wedged since boot reports exactly what a healthy one reports.
//   * NOT THAT ANY AGENT'S STATUS IS MEANINGFUL. It bounds how long this daemon
//     COULD have been watching. What it actually watched is `statusSince`, one
//     field per row, proven by verify-status-since.mjs — and still null when it
//     has not watched. Reading a young `startedAt` as "the fleet is fine" is the
//     same error in the opposite direction.
//   * NOT THE MCP SURFACE. This drives the daemon's socket directly. That
//     `crabcast_list_agents` carries the field through to an MCP caller is
//     asserted by verify-mcp-tools.mjs against the tool description, and by
//     nothing here. Neither script covers the other.
//   * NOT WALL-CLOCK CORRECTNESS. If the machine's clock is wrong, this reports
//     the same wrong time confidently. Every window below is a DURATION between
//     two readings of one clock, which is why a wrong clock does not make this
//     file flap — and also why it cannot notice one.
//
// FOUR OF THESE ASSERTIONS WERE CONVINCING AND WRONG WHEN FIRST WRITTEN, and
// the red run is what found them — which is the argument for never trusting a
// check that has only ever been watched passing. Run against a pre-fix build,
// where `list_agents` carries no `startedAt` at all, they went GREEN:
//
//   * §1d compared `undefined === undefined` and reported "it did not move".
//   * §2's two agreement checks compared two absent fields and called it
//     agreement.
//   * §3a asserted `!(NaN >= threshold)` and reported the mutant as CAUGHT when
//     the field was simply not there.
//
// Every one of them was satisfied by the FIELD NOT EXISTING — the section
// claiming its strongest result at the exact instant it tested nothing. Each is
// now guarded by a `typeof … === 'string'` or a `Number.isFinite`, so the
// comparison is a statement about a value rather than about two absences. That
// is the same defect this file's header warns about, found in this file, by
// running it against the build it was written to distinguish.
//
// RUNNING IT AGAINST A DIFFERENT BUILD, which is how the red run is reproduced.
// An optional first argument replaces the build under test, so a reviewer can
// point this at a `dist` with the fix backed out and watch §1c and §2 go red
// rather than take this file's word that they can. §3 does that automatically
// against two mutated copies; the recipe for the by-hand version is in the pull
// request.
//
// Usage:
//   npm run build
//   node scripts/verify-daemon-started-at.mjs [distDir]

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator, FIX_THE_MUTATION } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = process.argv[2] ?? path.join(repoRoot, 'dist');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  // A SETUP GUARD AND NOT A VERDICT. It says the build is missing, which is a
  // fact about the checkout rather than about the code under test.
  console.error(`No build at ${distDir}. Run \`npm run build\` first.`);
  process.exit(1);
}

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan214-started-at-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

/**
 * How long to let a daemon age before asking it how old it is.
 *
 * The whole of §1c rests on this being comfortably larger than the noise in
 * "when did the socket appear" versus "when did the process construct its start
 * time". Two seconds is far above that and still cheap.
 */
const AGE_BEFORE_ASKING_MS = 2_000;

/** The pause between stopping one daemon and starting the next, for §4. */
const RESTART_GAP_MS = 3_000;

/**
 * How much slop a duration comparison gets.
 *
 * Generous on purpose. These are real processes on a CI runner that may be
 * loaded, and the assertions are all of the form "at least this much elapsed" —
 * a bound, not an equality — so slack costs the check nothing it was relying on.
 */
const SLOP_MS = 1_500;

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  CRABCAST_CONFIG: undefined
};

const spawned = [];
const openSockets = [];

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

class Client {
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
  request(action, data = {}) {
    const id = `${this.label}-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out on ${action}`));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.socket.write(JSON.stringify({ action, ...data, id }) + '\n');
    });
  }
  close() { try { this.socket.end(); } catch {} }
}

/**
 * Start a real daemon and return the moment its socket appeared.
 *
 * The caller needs that moment rather than the moment this function returns,
 * because §1c measures the daemon's age from a point it can defend: the socket
 * exists only after the process has constructed its start time and bound.
 */
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
    await sleep(50);
  }
  if (!fs.existsSync(sock)) {
    throw new Error(
      `daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const socketAppearedAt = Date.now();
  const probe = await new Client(cfg, `${label}-probe`).ready();
  const status = await probe.request('daemon_status');
  probe.close();
  spawned.push({ pid: status.pid, label });
  return { socketAppearedAt, pid: status.pid };
}

async function stopDaemon(cfg, pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && fs.existsSync(sock)) await sleep(50);
}

/** Both surfaces of one daemon, read back to back over one socket. */
async function readBothSurfaces(cfg, label) {
  const client = await new Client(cfg, label).ready();
  const status = await client.request('daemon_status');
  const list = await client.request('list_agents');
  client.close();
  return { status, list };
}

const isoOf = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

// ===========================================================================
rule('1. `startedAt` is on both surfaces of a REAL daemon, read over a REAL socket — ' +
  'and it is the BOOT, not the call');
// ===========================================================================

const main = makeConfig('main');
const first = await startDaemon(main, distDir, 'first');

// Let it age a known amount BEFORE asking. This is what makes §1c an assertion
// about the boot rather than about the response.
await sleep(AGE_BEFORE_ASKING_MS);

const askedAt = Date.now();
const firstRead = await readBothSurfaces(main, 'first-read');

console.log(`   daemon pid ${first.pid}; socket appeared at ` +
  `${new Date(first.socketAppearedAt).toISOString()}, asked at ${new Date(askedAt).toISOString()}`);
console.log(`   daemon_status.startedAt = ${JSON.stringify(firstRead.status.startedAt)}`);
console.log(`   list_agents.startedAt   = ${JSON.stringify(firstRead.list.startedAt)}`);

// (a) PRESENT, not merely absent-and-undefined. `'startedAt' in res` separates
// "the daemon answered with nothing" from "the daemon did not answer this key",
// which `=== undefined` cannot.
check(
  'startedAt' in firstRead.status,
  'the key is PRESENT on daemon_status',
  `keys: ${Object.keys(firstRead.status).length}`
);
check(
  'startedAt' in firstRead.list,
  'the key is PRESENT on list_agents — the response the statusSince nulls are on',
  `keys: ${Object.keys(firstRead.list).length}`
);

// (b) A parseable ISO instant on both.
check(
  Number.isFinite(isoOf(firstRead.status.startedAt)),
  'daemon_status.startedAt parses as an instant',
  String(firstRead.status.startedAt)
);
check(
  Number.isFinite(isoOf(firstRead.list.startedAt)),
  'list_agents.startedAt parses as an instant',
  String(firstRead.list.startedAt)
);

// (c) THE ASSERTION THAT CATCHES THE LIKELY WRONG BUILD. The daemon must report
// a start at least AGE_BEFORE_ASKING_MS in the past, because that is how long
// ago its socket appeared. A per-request `new Date()` reports ~0 and fails.
const reportedAge = askedAt - isoOf(firstRead.list.startedAt);
check(
  reportedAge >= AGE_BEFORE_ASKING_MS - SLOP_MS,
  `the reported start is in the PAST by at least the daemon's real age ` +
    `(${AGE_BEFORE_ASKING_MS}ms slept before asking)`,
  `reported age ${reportedAge}ms — a per-request \`new Date()\` would report ~0 here`
);
// And it is not in the future, nor absurdly old: it sits between "this process
// was spawned" and "we asked".
check(
  isoOf(firstRead.list.startedAt) <= askedAt + SLOP_MS &&
    isoOf(firstRead.list.startedAt) >= first.socketAppearedAt - 60_000,
  'and it sits between this process being spawned and this call being made',
  `startedAt ${firstRead.list.startedAt}, socket appeared ` +
    `${new Date(first.socketAppearedAt).toISOString()}`
);

// (d) IT DOES NOT MOVE, while a field known to be live DOES. Read the same
// daemon again and compare both.
await sleep(1_200);
const secondRead = await readBothSurfaces(main, 'second-read');
const observedMoved =
  secondRead.list.provenance?.observedAt !== firstRead.list.provenance?.observedAt;
console.log(`   second read: startedAt = ${JSON.stringify(secondRead.list.startedAt)}, ` +
  `provenance.observedAt = ${JSON.stringify(secondRead.list.provenance?.observedAt)}`);
check(
  observedMoved,
  'CONTROL: provenance.observedAt DID move between the two calls, so this daemon is ' +
    'demonstrably capable of emitting a fresh timestamp',
  `${firstRead.list.provenance?.observedAt} → ${secondRead.list.provenance?.observedAt}`
);
// THE TYPE GUARD IS NOT DECORATION. `undefined === undefined` is true, so a
// build that does not carry the field AT ALL satisfies "it did not move"
// perfectly — this assertion passed vacuously against a pre-fix build the first
// time it was run, which is the exact shape (a check that is green because it
// measured nothing) this whole suite exists to refuse. Requiring a string first
// is what makes the equality a statement about a value.
check(
  typeof firstRead.list.startedAt === 'string' &&
    secondRead.list.startedAt === firstRead.list.startedAt,
  'while startedAt did NOT move — it is a property of the process, not of the response',
  `${firstRead.list.startedAt} on both calls`
);

// ===========================================================================
rule('2. The two surfaces AGREE — the property one shared eventWatermark() buys');
// ===========================================================================

// Same guard as §1d, for the same reason: two absent fields are equal to each
// other, and "both surfaces agree that there is nothing here" is not agreement.
check(
  typeof firstRead.status.startedAt === 'string' &&
    firstRead.status.startedAt === firstRead.list.startedAt,
  'daemon_status.startedAt and list_agents.startedAt are identical, byte for byte',
  `${firstRead.status.startedAt}`
);
check(
  typeof secondRead.status.startedAt === 'string' &&
    secondRead.status.startedAt === secondRead.list.startedAt,
  'and still identical on a second round trip',
  `${secondRead.status.startedAt}`
);
// The neighbours it travels with, asserted here because a caller reading
// `startedAt` off `list_agents` is reading it INSTEAD of correlating a bootId,
// and the two must be describing the same process.
check(
  firstRead.status.bootId === firstRead.list.bootId &&
    typeof firstRead.list.bootId === 'string',
  'and both surfaces report the same bootId beside it, so the pair describes one process',
  `bootId ${firstRead.list.bootId}`
);

// ===========================================================================
rule('3. MUTATION — break each property and require the assertion above to go RED');
// ===========================================================================

// A mutant build lives under `scratch`, so its runtime dependencies have to
// resolve from there too. Without this a mutant daemon dies on `node-pty` and
// never opens its socket — which reads as "the mutant did nothing", i.e. the
// section passing its subject while proving the opposite of what it claims.
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};
const { mutate, mutationsSkipped } = makeMutator({ distDir, scratch, report });

// ---- 3a. the value becomes the moment of the CALL rather than the BOOT ------
//
// This is the defect named at the top of this file: present, correctly typed,
// always wrong. §1c and §1d are the assertions that should catch it.
const perRequestDist = mutate(
  'startedAt-becomes-the-call-time',
  'router.js',
  'startedAt: daemonStartedAt.toISOString()',
  'startedAt: new Date().toISOString()'
);

if (perRequestDist) {
  const mutCfg = makeConfig('mutant-call-time');
  const mut = await startDaemon(mutCfg, perRequestDist, 'mutant-call-time');
  await sleep(AGE_BEFORE_ASKING_MS);
  const mutAskedAt = Date.now();
  const mutFirst = await readBothSurfaces(mutCfg, 'mutant-call-time-1');
  await sleep(1_200);
  const mutSecond = await readBothSurfaces(mutCfg, 'mutant-call-time-2');

  const mutAge = mutAskedAt - isoOf(mutFirst.list.startedAt);
  console.log(`   mutant reported age: ${mutAge}ms (real build reported ${reportedAge}ms)`);
  // A MUTANT THAT PRODUCED NO VALUE HAS NOT DEMONSTRATED ANYTHING. Without the
  // `Number.isFinite` half, `!(NaN >= x)` is true and this reports the mutant
  // as caught when the field was simply absent — the section claiming its
  // strongest result at the moment it tested nothing. Run against a pre-fix
  // build, that is exactly what it did.
  check(
    Number.isFinite(mutAge) && !(mutAge >= AGE_BEFORE_ASKING_MS - SLOP_MS),
    '§1c GOES RED against the mutant: it reports an age of ~0 for a daemon that has ' +
      'been up for seconds',
    `reported age ${mutAge}ms — the field is present and correctly typed and wrong`
  );
  check(
    typeof mutFirst.list.startedAt === 'string' &&
      typeof mutSecond.list.startedAt === 'string' &&
      mutSecond.list.startedAt !== mutFirst.list.startedAt,
    '§1d GOES RED against the mutant: the value moves between two calls to one daemon',
    `${mutFirst.list.startedAt} → ${mutSecond.list.startedAt}`
  );
  await stopDaemon(mutCfg, mut.pid);
} else {
  console.log(`   (mutant not built — ${FIX_THE_MUTATION})`);
}

// ---- 3b. the two surfaces are re-split, and disagree -----------------------
//
// The regression this field's PLACEMENT exists to prevent. Feeding
// `list_agents` from anything but the shared watermark is exactly the edit a
// later refactor makes without noticing, and §2 is what stops it.
const splitDist = mutate(
  'surfaces-re-split-and-disagree',
  'router.js',
  '...eventWatermark(this.deps.daemonStartedAt)',
  '...eventWatermark(new Date(this.deps.daemonStartedAt.getTime() + 60000))'
);

if (splitDist) {
  const splitCfg = makeConfig('mutant-split');
  const split = await startDaemon(splitCfg, splitDist, 'mutant-split');
  const splitRead = await readBothSurfaces(splitCfg, 'mutant-split-read');
  console.log(`   mutant daemon_status.startedAt = ${splitRead.status.startedAt}`);
  console.log(`   mutant list_agents.startedAt   = ${splitRead.list.startedAt}`);
  check(
    typeof splitRead.status.startedAt === 'string' &&
      typeof splitRead.list.startedAt === 'string' &&
      splitRead.status.startedAt !== splitRead.list.startedAt,
    '§2 GOES RED against the mutant: the two surfaces disagree once they stop sharing ' +
      'one expression',
    `daemon_status ${splitRead.status.startedAt} vs list_agents ${splitRead.list.startedAt}`
  );
  await stopDaemon(splitCfg, split.pid);
} else {
  console.log(`   (mutant not built — ${FIX_THE_MUTATION})`);
}

// ===========================================================================
rule('4. POSITIVE CONTROL — the value CHANGES across a real restart, by about the gap');
// ===========================================================================

// A single reading proves a constant just as well as it proves a clock. This is
// the section that tells them apart, and it is why §1 alone is not enough.
const beforeRestart = secondRead.list.startedAt;
const beforeBootId = secondRead.list.bootId;

await stopDaemon(main, first.pid);
const stoppedAt = Date.now();
await sleep(RESTART_GAP_MS);

const second = await startDaemon(main, distDir, 'second');
const afterRead = await readBothSurfaces(main, 'after-restart');
const afterRestart = afterRead.list.startedAt;

console.log(`   before restart: pid ${first.pid}, startedAt ${beforeRestart}, bootId ${beforeBootId}`);
console.log(`   after restart:  pid ${second.pid}, startedAt ${afterRestart}, ` +
  `bootId ${afterRead.list.bootId}`);

// A REAL restart, established three ways rather than assumed. Without these the
// "it changed" assertion below could be satisfied by the same process answering
// twice — which is exactly what a cached or recomputed value would look like.
check(
  second.pid !== first.pid,
  'a NEW OS process answered — different pid',
  `${first.pid} → ${second.pid}`
);
check(
  typeof afterRead.list.bootId === 'string' && afterRead.list.bootId !== beforeBootId,
  'and a new bootId, so this is a restart rather than one daemon answering twice',
  `${beforeBootId} → ${afterRead.list.bootId}`
);

const moved = isoOf(afterRestart) - isoOf(beforeRestart);
check(
  isoOf(afterRestart) > isoOf(beforeRestart),
  'startedAt MOVED FORWARD across the restart — it is a clock, not a constant',
  `+${moved}ms`
);
// And it moved by about the gap we imposed, which is what makes it the NEW
// process's start rather than any later time that happens to be larger.
check(
  moved >= RESTART_GAP_MS - SLOP_MS,
  `and it moved by at least the ${RESTART_GAP_MS}ms pause taken between the two processes`,
  `+${moved}ms, with the daemon down from ${new Date(stoppedAt).toISOString()}`
);
check(
  typeof afterRead.status.startedAt === 'string' &&
    afterRead.status.startedAt === afterRead.list.startedAt,
  'and the two surfaces still agree after the restart',
  `${afterRestart}`
);

await stopDaemon(main, second.pid);

// ===========================================================================
rule('5. Nothing this run started is still running');
// ===========================================================================

for (const s of openSockets) { try { s.destroy(); } catch {} }

const alive = spawned.filter(({ pid }) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
});
for (const { pid } of alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
await sleep(300);
const stillAlive = spawned.filter(({ pid }) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
});
check(
  stillAlive.length === 0,
  'every daemon this run spawned has exited',
  `${spawned.length} spawned, ${alive.length} needed a SIGKILL, ${stillAlive.length} left behind`
);

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${'='.repeat(78)}`);
// A mutation that did not apply means its section did not run. Naming them is
// the difference between "the mutants were caught" and "nothing was tested and
// nothing said so" — see mutation.mjs property 1.
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(
    `${skipped.length} mutation(s) DID NOT APPLY, so their section did not run: ` +
    `${skipped.join(', ')}. ${FIX_THE_MUTATION}`
  );
}
console.log(
  failures
    ? `${failures} CHECK(S) FAILED`
    : 'ALL CHECKS PASSED — `startedAt` is on both surfaces, agrees across them, is the ' +
      'boot rather than the call, and moves across a real restart.'
);
console.log(
  '\nRemember what a green run does NOT say: that the daemon is HEALTHY (a process wedged\n' +
  'since boot reports exactly this), that any agent\'s statusSince is meaningful (that is\n' +
  'verify-status-since.mjs), or that an MCP caller receives the field (that is\n' +
  'verify-mcp-tools.mjs, against the tool description). Neither of those covers this, and\n' +
  'this covers neither of them.'
);
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
