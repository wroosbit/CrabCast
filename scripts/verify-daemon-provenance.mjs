#!/usr/bin/env node
// Live proof for KAN-122: `daemon_status` answers WHICH BUILD IS RUNNING, and
// answers "I don't know" when it does not know — never something plausible.
//
// WHY THIS SCRIPT IS SHAPED THE WAY IT IS. The one claim that matters here
// cannot be checked by reading the filesystem, because the filesystem is the
// thing that lies: a daemon started before a rebuild goes on executing the old
// `dist/` while the checkout on disk looks perfectly current. So section 3
// runs TWO daemons off ONE tree at ONE instant — one booted before the rebuild
// and one after — and shows them disagreeing. Nothing short of that
// distinguishes a status that reports build provenance from one that reports
// the tree it happens to be sitting in.
//
// Everything on the daemon side is real: real compiled `dist/`, real daemon
// processes, real NDJSON over real unix sockets, the real CLI, and the real
// `scripts/daemon-status.mjs` with no edits. What is fabricated is only the
// TREES the daemons are booted from — copies of `dist/` and `src/` in a
// scratch directory, each with a different provenance situation arranged
// deliberately (a real little git repo, a tree with no git metadata at all, a
// build rewritten without re-stamping) — because those situations are the
// product and a script that could not construct them would be asserting that
// the happy path is happy.
//
// It needs no herdr and no network: `daemon_status` touches neither. Each
// daemon gets a scratch $HOME and its own dataDir.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED (KAN-170).
//
// A proof that supplies its own input has not tested that the input arrives.
// Three sections here construct the situation they then assert on, and each is
// bounded differently:
//
//   §4b (no `git` binary) constructs only the ENVIRONMENT — an empty PATH —
//   and then runs the REAL `scripts/stamp-build.mjs` against a REAL git
//   working tree. The stamp it asserts on is one the shipping stamper wrote,
//   so nothing is faked but the machine. Fully covered.
//
//   §5b (a stamp from a future format version) WRITES THE STAMP IT ASSERTS ON,
//   and it has no choice: `stamp-build.mjs` imports `BUILD_STAMP_VERSION` from
//   the build it is stamping, so no writer in this tree can emit a version
//   this reader would reject. What that leaves uncovered is whether any writer
//   would ever produce one — the real case is a FUTURE daemon's stamp read by
//   THIS one, which cannot exist at one commit. §5b closes what it can instead:
//   it asserts that the stamper takes the version from the shared constant
//   rather than from a literal of its own, so writer and reader cannot drift
//   apart WITHIN a version. Nobody covers cross-version reading, and nobody
//   can until there is a version 2.
//
//   §6c (the file-times bound) constructs a rebuild that preserves the newest
//   mtime and the file count, to MEASURE the bound the wording claims rather
//   than only match the wording. It does not cover a rebuild that happens to
//   do this by accident in the wild — it arranges one, which is the only way
//   to observe the property deliberately.
//
//   §3b (the README block, KAN-180) is HALF self-supplied and the halves are
//   worth telling apart. The OUTPUT side is this script's own: a fixture tree,
//   a daemon it started, a rebuild it performed. The PAGE side is not — README.md
//   is a real artifact written by people, and the whole assertion is that it has
//   not fallen behind. So the thing under test is the page, and the output is
//   the yardstick. WHAT THAT LEAVES UNCOVERED: that a reader following the
//   recipe in that README section, in a real checkout rather than a copied
//   fixture, sees these lines. Nobody covers that, and it is the same hole §2
//   and §3 have had since KAN-122 — the fixture is a copy of `dist/` and `src/`,
//   which is what makes the provenance situations constructible at all. It is
//   also blind to VALUES: `commit:` and the newest-source basename are masked
//   (scripts/readme-blocks.mjs prints the register and what each rule costs),
//   so §3b checks that the block shows every LINE, and §1 above is what checks
//   that the commit a stamp names is the commit it was built from.
//
// Usage:
//   npm run build
//   node scripts/verify-daemon-provenance.mjs
//
// §3b reads README.md and two historical revisions of it (`git show`), and
// reports NOT RUN — a failure, not a pass — rather than skipping if a shallow
// clone cannot reach them.
//
// Exits non-zero on any failure, so a reviewer can re-run it against the PR
// head. It is meant to be ABLE to fail: make the provenance reader answer
// "clean" for a tree it knows nothing about and sections 4 and 5 go red.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// §3b compares this script's own daemon-status output against the README block
// that pastes it. The mask and the page parser are IMPORTED rather than copied:
// verify-readme-is-current.mjs uses the same module for the six blocks it
// reproduces, and two copies of a mask would mean two checks blind to different
// things while both reporting the page current. See that module's header.
import {
  BUILD_BLOCK_FIRST_LINE,
  buildFreshnessBlock,
  compareSegment
} from './readme-blocks.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const repoDist = path.join(repoRoot, 'dist');
const repoSrc = path.join(repoRoot, 'src');
const stamperJs = path.join(scriptDir, 'stamp-build.mjs');
const daemonStatusMjs = path.join(scriptDir, 'daemon-status.mjs');

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, text) => console.log(`   ${label}\n${String(text).replace(/^/gm, '     ')}`);

let failures = 0;
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

if (!fs.existsSync(path.join(repoDist, 'daemon.js'))) {
  console.error('FAIL  dist/daemon.js not found — run `npm run build` first. This script drives\n' +
                '      real daemons off the BUILT output; it will not report on code it did not run.');
  process.exit(1);
}
if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
  console.error('FAIL  node_modules/ not found — run `npm ci` first. The fixture trees below link\n' +
                '      to it so a copied dist/ can resolve its dependencies.');
  process.exit(1);
}

const { BUILD_STAMP_FILENAME, BUILD_STAMP_VERSION } = await import(
  path.join(repoDist, 'provenance.js')
);
const { connectToDaemon, onJsonLines, socketPathFor, writeJsonLine } =
  await import(path.join(repoDist, 'ipc.js'));

// --------------------------------------------------------------- the scratch
//
// Short path segments on purpose: the config loader refuses a dataDir whose
// socket path would exceed the 104-character unix address limit, and a refusal
// about path length in the middle of a provenance check would be a red mark
// about this script rather than about the daemon.
//
// OUTSIDE the repository, deliberately. `stamp-build.mjs` asks git about the
// package root beside the `dist/` it is stamping, and a fixture nested inside
// this checkout would have git answer about THIS repository — so the "a tree
// with no git metadata" fixture would quietly become "a tree in CrabCast's own
// git repo", and section 4 would prove nothing.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prov-'));
const fakeHome = path.join(scratch, 'h');
fs.mkdirSync(fakeHome, { recursive: true });
// The fixture dists are ES modules and there is no package.json beside them;
// without this node would read every copied `.js` as CommonJS and refuse it.
fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const daemons = [];
function cleanup() {
  for (const d of daemons) {
    try { process.kill(d.pid, 'SIGTERM'); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const ENV = {
  ...process.env,
  HOME: fakeHome,
  // No herdr, and no chance of rediscovering an installed one: this script is
  // about build provenance, and a herdr version notice riding the first
  // response would be a variable it has no reason to carry.
  PATH: '/usr/local/bin:/usr/bin:/bin',
  CRABCAST_CONFIG: undefined
};

// ------------------------------------------------------------- fixture trees

/** Copy `dist/` and `src/` into a fresh tree, optionally as a real git repo. */
function makeTree(name, { git }) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(repoDist, path.join(dir, 'dist'), { recursive: true });
  fs.cpSync(repoSrc, path.join(dir, 'src'), { recursive: true });
  // A copy carries the previous tree's stamp; every fixture decides its own
  // provenance below, so start from none.
  fs.rmSync(path.join(dir, 'dist', BUILD_STAMP_FILENAME), { force: true });

  if (git) {
    // `dist/` ignored exactly as it is in the real repository, so building
    // cannot make the tree look dirty to `git status --porcelain`.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n');
    const g = (...args) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'verify@crabcast.invalid');
    g('config', 'user.name', 'KAN-122 verify');
    g('add', '-A');
    g('commit', '-q', '-m', 'KAN-122 fixture: a checkout to stamp a build from');
  }

  const dataDir = path.join(scratch, `${name}-d`);
  fs.mkdirSync(dataDir, { recursive: true });
  // The config lives OUTSIDE the tree. Written into it, it would be an
  // untracked file and `git status --porcelain` would report the fixture dirty
  // — so the "clean checkout" fixture would be dirty because this script put
  // something there, and the one check that proves `clean` carries information
  // would be measuring its own scaffolding.
  const configPath = path.join(scratch, `${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dir, dist: path.join(dir, 'dist'), src: path.join(dir, 'src'), dataDir, configPath };
}

/**
 * Run the real stamper against a fixture's `dist/`, as `npm run build` would.
 *
 * `env` is an override rather than a fixed constant so §4b can run the very
 * same stamper on a machine with no `git` on PATH — the shipping script,
 * unedited, in the environment that exercises its ENOENT branch. Node itself is
 * reached through `process.execPath`, an absolute path, so stripping PATH
 * removes git without also removing the interpreter.
 */
function stamp(tree, env = ENV) {
  const out = execFileSync(process.execPath, [stamperJs, tree.dist], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return out.trimEnd();
}

const stampPathOf = (tree) => path.join(tree.dist, BUILD_STAMP_FILENAME);

const readStamp = (tree) => JSON.parse(fs.readFileSync(stampPathOf(tree), 'utf8'));

/**
 * Pin the fixture's file times so every comparison below is arranged rather
 * than raced.
 *
 * `fs.cpSync` stamps copies with the current time, which would leave `src/`
 * and `dist/` within milliseconds of each other and the outcome of
 * "are the sources newer than the build" decided by copy order. So: sources a
 * minute before the build, compiled output a second before its own stamp
 * (which is what a real `npm run build` produces, `tsc` then postbuild).
 */
function pinTimes(tree) {
  const builtAtMs = Date.parse(readStamp(tree).builtAt);
  for (const f of walkFiles(tree.src)) touch(f, builtAtMs - 60_000);
  for (const f of walkFiles(tree.dist)) {
    if (path.basename(f) !== BUILD_STAMP_FILENAME) touch(f, builtAtMs - 1_000);
  }
  touch(path.join(tree.dist, BUILD_STAMP_FILENAME), builtAtMs);
  return builtAtMs;
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));

const newestMs = (dir) =>
  Math.max(...walkFiles(dir).map((f) => fs.statSync(f).mtimeMs));

// ------------------------------------------------------------- the daemons

/** Start a daemon from a fixture's own `dist/`, and wait until it answers. */
async function startDaemon(tree, label) {
  const errFile = path.join(tree.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(tree.dist, 'daemon.js'), tree.configPath], {
    env: ENV,
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPathFor(tree.dataDir))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(socketPathFor(tree.dataDir))) {
    throw new Error(
      `daemon for ${label} never opened its socket. Its stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const status = await raw(tree, 'daemon_status');
  daemons.push({ pid: status.pid, label });
  return status;
}

let rawId = 0;
/** One raw NDJSON round trip. The wire, unmediated by any renderer. */
async function raw(tree, action, payload = {}) {
  const socket = await connectToDaemon(tree.dataDir, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `verify-${++rawId}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw ${action} timed out`));
    }, 20_000);
    onJsonLines(socket, (msg) => {
      if (msg?.id !== id) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(msg);
    });
    writeJsonLine(socket, { action, ...payload, id });
  });
}

/** Stop a daemon and wait for its socket to go, so the next one can claim it. */
async function stopDaemon(tree, pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(socketPathFor(tree.dataDir))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try { fs.unlinkSync(socketPathFor(tree.dataDir)); } catch {}
}

/**
 * The CLI, run against a fixture exactly as a human would run it — and from the
 * FIXTURE's own `dist/`, so what is rendered is the same build the daemon
 * under test is running.
 */
function crabcast(tree, args) {
  const r = spawnSync(
    process.execPath,
    [path.join(tree.dist, 'cli.js'), '--config', tree.configPath, ...args],
    { env: ENV, encoding: 'utf8', timeout: 60_000 }
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

console.log(`repo:     ${repoRoot}`);
console.log(`dist:     ${repoDist}`);
console.log(`scratch:  ${scratch}`);
console.log(`stamper:  ${stamperJs}`);

// ---------------------------------------------------------------------------
// 1. THE STAMP — a build in a git checkout knows what it was built from.
// ---------------------------------------------------------------------------

rule('1. A BUILD MADE IN A GIT CHECKOUT REPORTS ITS COMMIT');

const clean = makeTree('t-clean', { git: true });
show('stamp-build against a clean checkout:', stamp(clean));
const cleanStamp = readStamp(clean);
show(`${BUILD_STAMP_FILENAME}:`, JSON.stringify(cleanStamp, null, 2));

const cleanHead = execFileSync('git', ['-C', clean.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
check(cleanStamp.commit === cleanHead, `the stamp records the checkout's real HEAD`, cleanHead);
check(cleanStamp.clean === true, 'and records that the checkout was clean when the build was made');
check(
  Object.keys(cleanStamp.unknown).length === 0,
  'with nothing listed as unknown — everything was established'
);
const cleanBuiltAt = pinTimes(clean);

// A dirty checkout is a DIFFERENT answer, not a missing one. Proving the two
// apart is what makes `clean: true` worth anything.
const dirty = makeTree('t-dirty', { git: true });
fs.writeFileSync(path.join(dirty.src, 'uncommitted-edit.ts'), 'export const KAN122 = 1;\n');
stamp(dirty);
const dirtyStamp = readStamp(dirty);
check(dirtyStamp.clean === false, 'an uncommitted edit in the tree is reported as DIRTY, not as unknown');
check(
  dirtyStamp.commit === execFileSync('git', ['-C', dirty.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  'and the commit is still reported — a dirty tree still has a HEAD'
);
check(
  cleanStamp.clean === true && dirtyStamp.clean === false && cleanStamp.clean !== dirtyStamp.clean,
  'clean and dirty are distinguishable — the field carries information rather than a constant'
);

// ---------------------------------------------------------------------------
// 2. CURRENT — a real daemon reports the build it loaded, through both clients.
// ---------------------------------------------------------------------------

rule('2. A RUNNING DAEMON REPORTS THE BUILD IT WAS LOADED FROM');

const cleanStatus = await startDaemon(clean, 't-clean');
show('daemon_status on the wire (build + freshness):', JSON.stringify(
  { action: cleanStatus.action, pid: cleanStatus.pid, build: cleanStatus.build, freshness: cleanStatus.freshness },
  null,
  2
));

check(
  cleanStatus.action === 'daemon_status_response',
  'the reply carries an `action` — the one handler in the router that answered without one now does',
  String(cleanStatus.action)
);
check(cleanStatus.build?.commit === cleanHead, 'the daemon reports the commit its dist/ was built at');
check(cleanStatus.build?.clean === true, 'and that that checkout was clean at build time');
check(
  cleanStatus.build?.builtAt === cleanStamp.builtAt,
  'and when it was built, byte for byte the stamp the build wrote'
);
check(
  cleanStatus.build?.distDir === clean.dist,
  'and names the dist/ it was loaded from — this daemon, not whatever tree the caller is standing in',
  String(cleanStatus.build?.distDir)
);
check(cleanStatus.freshness?.state === 'current', 'freshness: CURRENT', String(cleanStatus.freshness?.state));
check(
  cleanStatus.freshness?.processIsCurrentBuild === true &&
    cleanStatus.freshness?.sourcesNewerThanBuild === false,
  'both axes measured and both good: running the build on disk, and that build is newer than src/'
);

const cliRun = crabcast(clean, ['daemon-status']);
show('$ crabcast daemon-status', `${cliRun.stdout.trimEnd()}\n$ echo $?\n${cliRun.code}`);
check(cliRun.code === 0, `the CLI renders it and exits 0 (got ${cliRun.code})`);
check(cliRun.stdout.includes(cleanHead), 'the rendered output carries the full commit — a human can paste it into a ticket');
check(/freshness: CURRENT/.test(cliRun.stdout), 'and names the freshness state in words');
check(
  !/other fields in the daemon's response/.test(cliRun.stdout),
  'and nothing landed in the residue — every field the daemon sent has a renderer'
);

// The free end-to-end check: this script was not edited for KAN-122 and never
// referenced any of these fields. It prints the reply.
const statusScript = execFileSync(process.execPath, [daemonStatusMjs, clean.configPath], {
  encoding: 'utf8',
  env: ENV
});
show('$ node scripts/daemon-status.mjs <config>   (unedited)', statusScript.trimEnd());
const statusJson = JSON.parse(statusScript);
check(
  statusJson.pid === cleanStatus.pid,
  'the unedited script reached the same daemon',
  `pid ${statusJson.pid}`
);
check(
  statusJson.build?.commit === cleanHead && statusJson.freshness?.state === 'current',
  'and the new fields show up in it with no edit — it prints the raw reply'
);

// ---------------------------------------------------------------------------
// 3. THE CASE THE FILESYSTEM CANNOT SEE.
// ---------------------------------------------------------------------------

rule('3. A DAEMON THAT PREDATES THE BUILD — the failure no filesystem check finds');

// A rebuild under the live daemon: `tsc` rewrites the compiled output, the
// postbuild step re-stamps. Reproduced by hand here rather than by running the
// real build, because the fixture is a copy and `tsc` would emit into the
// repository instead.
for (const f of walkFiles(clean.dist)) {
  if (path.basename(f) !== BUILD_STAMP_FILENAME) touch(f, Date.now());
}
stamp(clean);
const rebuiltStamp = readStamp(clean);
console.log(`\n  rebuilt ${clean.dist} under the running daemon (pid ${cleanStatus.pid})`);
console.log(`    was:  ${cleanStamp.builtAt}`);
console.log(`    now:  ${rebuiltStamp.builtAt}`);

const staleStatus = await raw(clean, 'daemon_status');
check(
  staleStatus.pid === cleanStatus.pid,
  'the same daemon process is still serving — nothing restarted',
  `pid ${staleStatus.pid}`
);
check(
  staleStatus.freshness?.state === 'process-predates-build',
  'and it now reports process-predates-build',
  String(staleStatus.freshness?.state)
);
check(
  staleStatus.freshness?.processIsCurrentBuild === false,
  'in as many words: it is not running the build that is on disk'
);
check(
  staleStatus.build?.builtAt === cleanStamp.builtAt,
  'the build it reports is still the one it LOADED — the boot snapshot did not follow the disk'
);
check(
  staleStatus.freshness?.onDiskBuiltAt === rebuiltStamp.builtAt,
  'while the disk reads as the new build — both facts on one reply, which is what makes the gap visible'
);
check(
  /restart the daemon/i.test(String(staleStatus.freshness?.summary)),
  'and the summary says what to do about it'
);

const staleCli = crabcast(clean, ['daemon-status']);
show('$ crabcast daemon-status   (against the daemon that predates the build)', staleCli.stdout.trimEnd());

// The heart of it. Same tree, same instant, two daemons: only the one that was
// running before the rebuild knows. A staleness checker reading this directory
// from outside sees the fresh one's answer and nothing else.
const freshStatus = await startDaemonAlongside(clean);
show('a SECOND daemon booted from that same tree, one instant later:', JSON.stringify(
  {
    pid: freshStatus.pid,
    'build.builtAt': freshStatus.build?.builtAt,
    'freshness.state': freshStatus.freshness?.state
  },
  null,
  2
));
check(
  freshStatus.freshness?.state === 'current' && freshStatus.build?.builtAt === rebuiltStamp.builtAt,
  'the fresh daemon reads the same tree as CURRENT — so the tree itself is not the problem'
);
check(
  staleStatus.freshness?.state === 'process-predates-build' && freshStatus.freshness?.state === 'current',
  'ONE TREE, ONE INSTANT, TWO ANSWERS: the difference is the process, and only the process could report it'
);
check(
  freshStatus.freshness?.sourcesNewerThanBuild === false,
  'and the filesystem question a consumer can ask themselves reads healthy throughout — src/ is not newer than dist/'
);

/**
 * A second daemon off the same tree, on its own dataDir.
 *
 * Its own dataDir because exactly one daemon may own a socket — a second one
 * finding a live socket exits 0 by design — and the point here is to have both
 * alive at once.
 */
async function startDaemonAlongside(tree) {
  const dataDir = path.join(scratch, `${tree.name}-d2`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `${tree.name}-2.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return await startDaemon({ ...tree, dataDir, configPath }, `${tree.name}-second`);
}

// ---------------------------------------------------------------------------
// 3b. AND THE README SHOWS WHAT IT PRINTS.
// ---------------------------------------------------------------------------
//
// WHAT FAILURE THIS WOULD CATCH (KAN-180): the README's `build`/`freshness`
// block going stale. The page says of those two blocks that they are
// "reproduced here in full and verbatim", and until this section nothing on
// earth went red when they stopped being. It had already happened once — at
// e7ffb58 the block was four lines short in `build` and had lost the entire
// evidence tail under `freshness`, and it was found by a person reading the
// page months later, which is the failure mode this whole epic exists to end.
//
// WHY IT IS HERE AND NOT IN verify-readme-is-current.mjs, which is the script
// whose NAME says it checks the README. Because the state this block describes
// is expensive and §3 above has already paid for it: a daemon still serving the
// `dist/` it booted from while a newer build sits on disk. Reproducing that in
// the README checker meant a second fixture tree and a second rebuild inside a
// check that otherwise finishes in seconds. So the assertion goes where the
// state already is, and `staleCli` — the very `crabcast daemon-status` §3
// captured eleven lines ago — is what gets compared. KAN-180 decided this
// deliberately over the alternative; the reasoning is on that ticket.
//
// WHAT THE SPLIT COSTS, AND WHAT PAYS FOR IT. "The README is current" is now
// answered by two scripts rather than one, and a reader running only
// verify-readme-is-current gets a green that does not include this block. Two
// things stop that from being the seam-between-two-scripts defect KAN-180 was
// filed about:
//
//   - that script's section 1 register names this block as COVERED_ELSEWHERE
//     and cites this file AND this section, so the enumeration of the page stays
//     complete rather than quietly losing an entry;
//   - the mask is IMPORTED from scripts/readme-blocks.mjs rather than copied, so
//     the two scripts cannot become blind to different things while both
//     reporting the page current.
//
// AND THE MASK ITSELF IS GUARDED BY verify-readme-is-current, NOT BY THIS
// SECTION — which is the dependency to know about before editing either. This
// comparison masks BOTH sides with the same function, so a mask that is too
// WIDE makes §3b agree with itself: widen `maskLine` to a catch-all and every
// check in this section still passes, exit 0, asserting nothing. It was
// measured rather than reasoned about — a one-line catch-all in
// readme-blocks.mjs left this whole section green while turning
// verify-readme-is-current red seven times, and its expected-GREEN canaries
// (`timestamps-and-pane-ids-rewritten`, `a-number-changed`) are what noticed:
// they are graded green precisely BECAUSE the mask hides those values, so a
// wider mask breaks the grading. Nothing here can make that measurement,
// because there is no unmasked side to compare against.
//
// So: WEAKENING THOSE CANARIES SILENTLY WEAKENS THIS SECTION, and it would
// weaken it into a PASS. CI runs both scripts, so a widened mask goes red
// before it merges — the protection is real, it is simply not owned here. Do
// not answer this by adding a canary to this file: a second copy of that guard
// is exactly the drift the shared module exists to prevent. Found in review of
// KAN-180, in the fix for KAN-180 — the gap between two scripts, one level over.
//
// The §3b red/green history pair below does NOT cover it either, and the reason
// is worth stating so it is not mistaken for coverage: under a catch-all mask
// `e7ffb58` still reports red, but only because that revision's block has FEWER
// LINES than the capture, so the subsequence check runs out of page. It is
// counting, not comparing.
//
// AND THE FAILURE NAMES THE README, which matters more than it looks. When this
// goes red it goes red inside a script called `verify-daemon-provenance`, and
// the person reading the output will usually be somebody who just edited a
// documentation page and has no reason to think provenance is involved. A
// diagnostic that said "provenance mismatch" would send them to src/provenance.ts
// to look for a bug that is not there.

rule('3b. AND THE README SHOWS WHAT IT PRINTS — the page’s block against that output');

const README_PATH = path.join(repoRoot, 'README.md');

/**
 * The directory prefix the README's block shows, as a SUBSTITUTION rather than
 * a mask.
 *
 * The page was captured in `/tmp/kan174/crabcast` and this run's fixture is a
 * scratch directory; rewriting one to the other lets the four path lines
 * (`git root`, `loaded from`, `stamp`, `sources`) and the summary be compared
 * for what they say rather than skipped. A substitution and not a `<PATH>` mask
 * on purpose — a path the renderer got WRONG still shows up as a difference,
 * whereas masking every path would make four of this block's lines unfalsifiable.
 *
 * IF THE PAGE IS EVER RE-CAPTURED SOMEWHERE ELSE this constant goes stale and
 * this section goes red on every path line. That is a true red — the page did
 * change — but the fix is to update this constant, and the check below says so
 * by name rather than leaving it to be deduced from a pile of missing lines.
 */
const PAGE_TREE = '/tmp/kan174/crabcast';

/** `daemon-status` from the `build —` line to the end: the two blocks the page pastes. */
function buildFreshnessLines(stdout) {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const at = lines.findIndex((l) => BUILD_BLOCK_FIRST_LINE.test(l));
  return at === -1 ? [] : lines.slice(at);
}

const capturedBlock = buildFreshnessLines(staleCli.stdout).map((l) => l.split(clean.dir).join(PAGE_TREE));

// PRECONDITIONS, because every one of them is a way this comparison could pass
// while checking nothing. An empty capture compares zero lines against the page
// and reports zero missing — a green that means "I did not look" — and a capture
// taken from a daemon that was NOT in the stale state would be comparing the
// wrong block's worth of output against a block about staleness.
check(capturedBlock.length > 0,
  'the daemon-status output has a `build — what THIS process was loaded from` block to compare',
  capturedBlock.length > 0 ? `${capturedBlock.length} lines` :
    'NOTHING WAS CAPTURED — the comparison below would be vacuously green');
check(capturedBlock.some((l) => /^freshness: PROCESS-PREDATES-BUILD$/.test(l)),
  'and it is the PROCESS-PREDATES-BUILD state, which is the state the page documents',
  'the block the README pastes is of a daemon that predates its build; a capture in any other ' +
  'state would be a comparison against the wrong page block');
check(!capturedBlock.some((l) => l.includes(scratch)),
  'and every fixture path in it was rewritten to the prefix the page shows',
  `a leftover ${scratch} path would go red as README drift when it is this script’s own scratch dir`);

const pageBlock = buildFreshnessBlock(fs.readFileSync(README_PATH, 'utf8'));

if (!check(pageBlock !== null,
  'README.md still pastes that block',
  pageBlock ? `README.md:${pageBlock.start}-${pageBlock.end}` :
    'THE README NO LONGER SHOWS A build/freshness BLOCK AT ALL. If it was removed on purpose, ' +
    'remove this section and the COVERED_ELSEWHERE entry in scripts/verify-readme-is-current.mjs ' +
    'that cites it — a citation pointing at coverage of nothing is worse than no citation')) {
  // Nothing below can mean anything without a block to compare against.
} else {
  check(pageBlock.body.some((l) => l.includes(PAGE_TREE)),
    `and it still shows the ${PAGE_TREE} prefix this section substitutes for`,
    pageBlock.body.some((l) => l.includes(PAGE_TREE)) ? '' :
      `THE PAGE WAS RE-CAPTURED SOMEWHERE ELSE. Update PAGE_TREE in ${path.relative(repoRoot, scriptDir)}/` +
      'verify-daemon-provenance.mjs to the prefix the block now shows; until then every path line ' +
      'below reports as missing for this reason and not because the README is wrong');

  const missing = compareSegment({ output: capturedBlock }, { output: pageBlock.body });
  show('$ crabcast daemon-status   (this run, fixture paths rewritten to the page’s)',
    capturedBlock.join('\n'));
  check(missing.length === 0,
    'THE README’S build/freshness BLOCK SHOWS EVERY LINE THIS daemon-status PRINTED',
    missing.length === 0
      ? `README.md:${pageBlock.start}-${pageBlock.end}, ${capturedBlock.length} captured line(s) all present`
      : `THE README IS STALE — README.md:${pageBlock.start}-${pageBlock.end} is missing ` +
        `${missing.length} line(s) that \`crabcast daemon-status\` prints today. This is a ` +
        `DOCUMENTATION failure, not a provenance one: the daemon is answering correctly above ` +
        `and the page has fallen behind it. Re-run the recipe in that README section and paste ` +
        `the new output over the block`);
  for (const m of missing) {
    console.log(`          the page does not show: ${JSON.stringify(m.line)}`);
    console.log(`                         masked as: ${JSON.stringify(m.shape)}`);
  }
}

/**
 * The page's own history: this comparison goes RED against the revision that
 * really had drifted, and GREEN against one that had not.
 *
 * KAN-180's AC 2 asks for this to be watched going red, and wiring it in beats
 * pasting one red run into a pull request: a demonstration nobody can re-run is
 * a claim. `e7ffb58` is the README as it stood before KAN-174 re-ran this block,
 * and it is genuinely stale rather than synthetically broken — nobody
 * constructed it to fail, it simply was.
 *
 * THE GREEN DIRECTION IS WHAT KEEPS THIS FROM MEASURING THE CALENDAR. A check
 * that called every older page stale would go red on `e7ffb58` for the wrong
 * reason and nobody would notice. `0edd2c1` is the newest README before KAN-200,
 * and its copy of THIS block is byte-identical to today's — so it is a page from
 * the past that must stay green, and the pair of expectations together is the
 * evidence. If a future change to the build or freshness renderer makes that
 * revision go red, the honest fix is a NEWER revision to carry the green, never
 * an empty list.
 */
const BLOCK_HISTORY = [
  {
    rev: 'e7ffb58',
    expect: 'red',
    note: 'before KAN-174 re-ran this block: `build` was missing git root/loaded from/stamp/read ' +
          'at, and `freshness` had lost its whole evidence tail behind an ellipsis'
  },
  {
    rev: '0edd2c1',
    expect: 'green',
    note: 'the newest README before KAN-200 — this block was already accurate there and is ' +
          'unchanged since, so a red here would mean this check is measuring age'
  }
];

for (const h of BLOCK_HISTORY) {
  const shown = spawnSync('git', ['show', `${h.rev}:README.md`], { cwd: repoRoot, encoding: 'utf8' });
  // NOT RUN IS A FAILURE. A shallow clone that cannot reach these revisions has
  // demonstrated nothing, and reporting that is the difference between the
  // demonstration happening and its absence being announced.
  if (!check(shown.status === 0 && shown.stdout.length > 0,
    `${h.rev}:README.md is reachable`,
    shown.status === 0 ? '' : 'NOT RUN — git could not read that revision (a shallow clone?)')) {
    continue;
  }
  const old = buildFreshnessBlock(shown.stdout);
  if (!check(old !== null, `${h.rev} has a build/freshness block to audit`,
    old ? '' : 'the revision does not paste one — this history entry is stale, not the page')) {
    continue;
  }
  const oldMissing = compareSegment({ output: capturedBlock }, { output: old.body });
  const got = oldMissing.length ? 'red' : 'green';
  check(got === h.expect,
    `${h.rev}: the block is ${h.expect.toUpperCase()} — ${h.note.replace(/\s+/g, ' ')}`,
    got === h.expect
      ? h.expect === 'red'
        ? `${oldMissing.length} line(s) that revision did not show`
        : 'every line today’s daemon prints was already on that page'
      : `EXPECTED ${h.expect.toUpperCase()}, GOT ${got.toUpperCase()}`);
  if (h.expect === 'red' && oldMissing.length) {
    for (const m of oldMissing.slice(0, 6)) {
      console.log(`          ${h.rev} did not show: ${JSON.stringify(m.line)}`);
    }
    if (oldMissing.length > 6) console.log(`          … and ${oldMissing.length - 6} more`);
  }
}

// ---------------------------------------------------------------------------
// 4. UNKNOWN — and it must not be mistakable for clean.
// ---------------------------------------------------------------------------

rule('4. A TREE WITH NO GIT METADATA REPORTS UNKNOWN — not a plausible default');

const nogit = makeTree('t-nogit', { git: false });
show('stamp-build against a tree with no .git:', stamp(nogit));
const nogitStamp = readStamp(nogit);
show(`${BUILD_STAMP_FILENAME}:`, JSON.stringify(nogitStamp, null, 2));

check(nogitStamp.commit === null, 'the stamp records no commit');
check(
  nogitStamp.clean === null,
  'AND NO CLEANLINESS. `git status --porcelain` in a directory git will not look at prints nothing, ' +
    'and an empty answer to a question that was never asked is not "clean"',
  `clean: ${JSON.stringify(nogitStamp.clean)}`
);
check(
  typeof nogitStamp.unknown.commit === 'string' && /not inside a git working tree/.test(nogitStamp.unknown.commit),
  'with a reason recorded that names the situation'
);
pinTimes(nogit);

const nogitStatus = await startDaemon(nogit, 't-nogit');
show('daemon_status.build:', JSON.stringify(nogitStatus.build, null, 2));
check(nogitStatus.build?.commit === null, 'the daemon answers commit: null');
check(nogitStatus.build?.clean === null, 'and clean: null — never false, which would read as a verdict');
check(
  Object.keys(nogitStatus.build?.unknown ?? {}).length >= 2,
  'and carries the reasons, so "unknown" is an answer rather than an absence'
);

const nogitCli = crabcast(nogit, ['daemon-status']);
show('$ crabcast daemon-status   (a build with no git metadata)', nogitCli.stdout.trimEnd());
check(
  /commit:\s+UNKNOWN/.test(nogitCli.stdout),
  'the rendered output says the word UNKNOWN against `commit` rather than leaving the line out'
);
check(
  /checkout:\s+UNKNOWN/.test(nogitCli.stdout),
  'and against `checkout` — a blank line there would read as an unremarkable status'
);
// KAN-170 item 10. `git root` was the one field in this block rendered with
// `field()` rather than `knownOrUnknown()`, so a null one did not print
// UNKNOWN — it VANISHED, between two neighbours that both say the word. Back
// that render out and this check goes red on a line that is simply not there.
check(
  /git root:\s+UNKNOWN/.test(nogitCli.stdout),
  'and against `git root` — the field that used to disappear instead of saying UNKNOWN',
  JSON.stringify(
    (nogitCli.stdout.split('\n').find((l) => /^\s*git root:/.test(l)) ?? '(no line at all)').trim()
  )
);
// An UNKNOWN with no reason underneath it is the blank this block exists to
// prevent, one indirection later — so the reason has to be there too.
check(
  typeof nogitStatus.build?.unknown?.gitRoot === 'string' &&
    new RegExp(`gitRoot — `).test(nogitCli.stdout),
  'with a reason for it in the COULD NOT BE ESTABLISHED block, so the new UNKNOWN is answered rather than bare',
  String(nogitStatus.build?.unknown?.gitRoot).slice(0, 80) + '…'
);
check(
  /COULD NOT BE ESTABLISHED/.test(nogitCli.stdout) && /NOT a clean result/.test(nogitCli.stdout),
  'under a heading that refuses to be read as an all-clear'
);
// The exact trap the ticket names: "clean at an unknown commit". The word
// itself is allowed to appear in a REASON — "whether the checkout was clean
// was not asked, because HEAD did not resolve" is the honest sentence — so
// what is asserted is that nothing is RENDERED as clean.
const nogitBuildBlock = nogitCli.stdout.split('freshness:')[0];
const checkoutLine = nogitBuildBlock.split('\n').find((l) => /^\s*checkout:/.test(l)) ?? '(no line)';
check(
  /^\s*checkout:\s+UNKNOWN\s*$/.test(checkoutLine),
  'the rendered `checkout` value is the word UNKNOWN and NOTHING else',
  JSON.stringify(checkoutLine.trim())
);
check(
  !/clean when this build was made/.test(nogitBuildBlock),
  'the affirmative rendering — "clean when this build was made" — appears nowhere in the block'
);
const cleanMentions = nogitBuildBlock.split('\n').filter((l) => /\bclean\b/i.test(l));
check(
  cleanMentions.length > 0 &&
    cleanMentions.every((l) => /NOT a clean result/.test(l) || /^\s*clean — /.test(l)),
  'and every remaining mention of cleanliness is either the "NOT a clean result" heading or the ' +
    'reason line saying it could not be established',
  `${cleanMentions.length} line(s)`
);

// The other shape of not-knowing: no stamp at all, which is what a bare `tsc`
// leaves behind. It must be as loud as the git-less case and for the same
// reason.
const unstamped = makeTree('t-unstamped', { git: true });
const unstampedStatus = await startDaemon(unstamped, 't-unstamped');
check(
  !fs.existsSync(path.join(unstamped.dist, BUILD_STAMP_FILENAME)),
  'a dist/ built without the postbuild step has no stamp in it'
);
check(
  unstampedStatus.build?.stampPresent === false &&
    unstampedStatus.build?.commit === null &&
    unstampedStatus.build?.clean === null,
  'and the daemon reports UNKNOWN for all of it rather than falling back to reading git at boot'
);
check(
  unstampedStatus.build?.stampPresent === false && unstampedStatus.build?.stampUsable === false,
  'reported as genuinely absent — there is no file there'
);
check(
  /build-stamp\.json/.test(String(unstampedStatus.build?.unknown?.commit)),
  'naming the missing stamp as the reason',
  String(unstampedStatus.build?.unknown?.commit).slice(0, 90) + '…'
);
// Freshness is a separate question and is still answerable from file times —
// an unstamped build is not a black hole, it is a build with no name.
check(
  unstampedStatus.freshness?.basis === 'file-times',
  'freshness falls back to file times and SAYS SO on the reply, rather than quietly weakening'
);

// ---------------------------------------------------------------------------
// 4b. NO `git` BINARY — the third shape of not-knowing, and the one CI never
//     saw (KAN-170 item 9).
//
// `stamp-build.mjs` tells three failure shapes apart because they send a
// reader to three different places, and until now only two of them were ever
// exercised here: a real repository (§1) and a tree with no `.git` (§4). The
// third — `git` is not installed on the machine doing the build — was reachable
// only by hand, because ENV pins PATH to directories that have git in them.
//
// The fixture is a REAL git working tree with a REAL commit in it. That is what
// makes the section sharp rather than a restatement of §4: the commit is right
// there on disk, and the build still reports UNKNOWN, because the machine that
// built it could not ask. A reader that "helpfully" fell back to anything would
// have every opportunity to.
// ---------------------------------------------------------------------------

rule('4b. A BUILD MADE ON A MACHINE WITH NO `git` REPORTS UNKNOWN — from inside a real checkout');

const nogitbin = makeTree('t-nogitbin', { git: true });
const emptyBin = path.join(scratch, 'empty-bin');
fs.mkdirSync(emptyBin, { recursive: true });
const NO_GIT_ENV = { ...ENV, PATH: emptyBin };

// PRECONDITIONS. Both halves, because either one failing on its own would make
// this section pass while measuring nothing: a fixture that is not really a
// repository would report unknown for §4's reason, and a `git` that is broken
// under the NORMAL environment too would mean the empty PATH did nothing.
const gitUnderStripped = spawnSync('git', ['--version'], { env: NO_GIT_ENV, encoding: 'utf8' });
const gitUnderNormal = spawnSync('git', ['--version'], { env: ENV, encoding: 'utf8' });
check(
  gitUnderStripped.error?.code === 'ENOENT',
  'PRECONDITION: `git` cannot be spawned through the stripped PATH',
  `PATH=${emptyBin} → ${gitUnderStripped.error?.code ?? `exit ${gitUnderStripped.status}`}`
);
check(
  gitUnderNormal.status === 0,
  'PRECONDITION: and CAN be through the normal one — so the difference below is the PATH, not a broken git',
  String(gitUnderNormal.stdout).trim()
);
const nogitbinHead = execFileSync('git', ['-C', nogitbin.dir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8'
}).trim();
check(
  fs.existsSync(path.join(nogitbin.dir, '.git')) && /^[0-9a-f]{40}$/.test(nogitbinHead),
  'PRECONDITION: the fixture IS a git working tree with a resolvable HEAD — the commit is there to be found',
  nogitbinHead
);

show('stamp-build with no `git` on PATH, in a tree that has a commit:', stamp(nogitbin, NO_GIT_ENV));
const nogitbinStamp = readStamp(nogitbin);
show(`${BUILD_STAMP_FILENAME}:`, JSON.stringify(nogitbinStamp, null, 2));

check(
  fs.existsSync(stampPathOf(nogitbin)),
  'the build was still STAMPED — a machine with no git is a supported case, not a build failure'
);
check(
  nogitbinStamp.commit === null && nogitbinStamp.clean === null && nogitbinStamp.gitRoot === null,
  'and every git-derived field is null — none of them guessed, with a real HEAD sitting one directory away'
);
check(
  /there is no `git` on PATH/.test(String(nogitbinStamp.unknown.commit)),
  'the reason names the machine, not the tree',
  String(nogitbinStamp.unknown.commit).slice(0, 88) + '…'
);
// The distinction the stamper goes to the trouble of drawing is worth nothing
// if nothing ever checks that it draws it. "No git binary" and "not a git
// repository" send a reader to two different places — one is a machine to fix,
// the other is an ordinary tarball — and this fixture is emphatically the first.
check(
  !/not inside a git working tree/.test(JSON.stringify(nogitbinStamp.unknown)),
  'and NOT the tarball reason — the two failure shapes stay apart, which is why the stamper tells them apart'
);
check(
  /HEAD did not resolve/.test(String(nogitbinStamp.unknown.clean)),
  'cleanliness was not asked at all, and says why — an unasked question answered "clean" is the fabrication this file exists to avoid',
  String(nogitbinStamp.unknown.clean).slice(0, 88) + '…'
);

// And end to end. The daemon boots with git perfectly available to it, and
// still reports UNKNOWN — because provenance comes from the stamp the BUILD
// wrote, never from a git call at boot. This is the rejected alternative in
// src/provenance.ts's header, measured.
pinTimes(nogitbin);
const nogitbinStatus = await startDaemon(nogitbin, 't-nogitbin');
check(
  nogitbinStatus.build?.stampPresent === true && nogitbinStatus.build?.stampUsable === true,
  'the daemon BELIEVES this stamp — it is a perfectly good stamp that happens to know nothing'
);
check(
  nogitbinStatus.build?.commit === null,
  'and reports commit: null while running inside a checkout whose HEAD it could resolve in one call',
  `HEAD on disk is ${nogitbinHead}`
);
const nogitbinCli = crabcast(nogitbin, ['daemon-status']);
show('$ crabcast daemon-status   (built where there was no git)',
  nogitbinCli.stdout.split('freshness:')[0].trimEnd());
check(
  /commit:\s+UNKNOWN/.test(nogitbinCli.stdout) && /no `git` on PATH/.test(nogitbinCli.stdout),
  'and the CLI prints UNKNOWN with the machine named underneath it'
);

// ---------------------------------------------------------------------------
// 5. A STAMP THE CODE BESIDE IT HAS OUTLIVED.
// ---------------------------------------------------------------------------

rule('5. A STAMP THAT NO LONGER DESCRIBES THE CODE BESIDE IT IS DISBELIEVED');

const restamped = makeTree('t-restale', { git: true });
stamp(restamped);
const restaleStamp = readStamp(restamped);
pinTimes(restamped);
// `tsc` run by hand: the compiled output is rewritten, the stamp is not. The
// stamp now names a commit the loaded code does not come from.
touch(path.join(restamped.dist, 'router.js'), Date.parse(restaleStamp.builtAt) + 10_000);

const restaleStatus = await startDaemon(restamped, 't-restale');
show('daemon_status.build:', JSON.stringify(restaleStatus.build, null, 2));
check(
  restaleStamp.commit !== null,
  'the stamp on disk still names a commit — a reader that trusted it would report that commit'
);
check(
  restaleStatus.build?.commit === null && restaleStatus.build?.clean === null,
  'the daemon reports UNKNOWN instead: a confidently wrong provenance is worse than an absent one'
);
check(
  restaleStatus.build?.stampPresent === true && restaleStatus.build?.stampUsable === false,
  'and says PRESENT BUT NOT BELIEVED rather than absent — there is a file there naming a commit, ' +
    'and whoever is looking at that directory can see it'
);
const restaleCli = crabcast(restamped, ['daemon-status']);
check(
  /PRESENT BUT NOT BELIEVED/.test(restaleCli.stdout),
  'which is what the CLI prints too'
);
show('$ crabcast daemon-status   (a dist/ rewritten without re-stamping)',
  restaleCli.stdout.split('freshness:')[0].trimEnd());
check(
  /without re-stamping/.test(String(restaleStatus.build?.unknown?.commit)),
  'and says why, naming the file that outlived the stamp',
  String(restaleStatus.build?.unknown?.commit).slice(0, 110) + '…'
);

// ---------------------------------------------------------------------------
// 5b. A STAMP FROM A FORMAT THIS DAEMON DOES NOT READ (KAN-170 item 8).
//
// `src/provenance.ts` demotes a stamp whose `stampVersion` is not the one it
// reads, on the grounds that the fields ARE the product and guessing at a shape
// whose meaning has moved is the same class of error as reporting "clean" for a
// build nothing was known about. Nothing exercised that branch: the only
// `stampVersion` in scripts/ is the writer's, and it takes its value from the
// same constant the reader checks against, so no fixture could produce a
// mismatch by building.
//
// SO THIS SECTION WRITES THE STAMP IT ASSERTS ON, and that is a real bound, not
// a formality — see the header. The situation it stands in for is a stamp
// written by a LATER CrabCast and read by this one, which cannot be produced at
// one commit. What CAN be closed here is the other half: that no writer in this
// tree could drift from the reader within a version. The last two checks do
// that, structurally.
// ---------------------------------------------------------------------------

rule('5b. A STAMP FROM A FORMAT VERSION THIS DAEMON DOES NOT READ IS DISBELIEVED');

const future = makeTree('t-future', { git: true });
stamp(future);
const futureOriginal = readStamp(future);
const futureVersion = BUILD_STAMP_VERSION + 1;
// Everything else left exactly as the real stamper wrote it: a stamp that is
// wrong in ONE way, so what the daemon does with it cannot be attributed to
// anything but the version.
fs.writeFileSync(
  stampPathOf(future),
  JSON.stringify({ ...futureOriginal, stampVersion: futureVersion }, null, 2) + '\n'
);
// Pinned so the STALENESS branch — the §5 one, which is checked after this one
// and would produce the same outward verdict — cannot be what fires. The
// section has to be able to say which branch answered.
pinTimes(future);
show(`${BUILD_STAMP_FILENAME}, rewritten as version ${futureVersion}:`,
  JSON.stringify(readStamp(future), null, 2));

const futureStatus = await startDaemon(future, 't-future');
check(
  futureOriginal.commit !== null && readStamp(future).commit === futureOriginal.commit,
  'the stamp still names the real commit — a reader that skipped the version check would report it',
  String(futureOriginal.commit)
);
check(
  futureStatus.build?.commit === null && futureStatus.build?.clean === null,
  'the daemon reports UNKNOWN instead: a shape whose meaning may have changed is not guessed at'
);
check(
  futureStatus.build?.stampPresent === true && futureStatus.build?.stampUsable === false,
  'and PRESENT BUT NOT BELIEVED, not absent — there is a file there and whoever is looking at that directory can see it'
);
check(
  new RegExp(`stamp version ${futureVersion}`).test(String(futureStatus.build?.unknown?.commit)) &&
    new RegExp(`reads version ${BUILD_STAMP_VERSION}`).test(String(futureStatus.build?.unknown?.commit)),
  'the reason names BOTH versions — the one on disk and the one this daemon reads',
  String(futureStatus.build?.unknown?.commit).slice(0, 110) + '…'
);
// The section's own precondition, in the form that matters here: TWO branches
// demote a stamp, and without this the mtime branch could be doing the work
// while the version check sat dead.
check(
  !/without re-stamping/.test(String(futureStatus.build?.unknown?.commit)),
  'PRECONDITION: and it is the VERSION branch answering, not §5\'s staleness branch — the mtimes are pinned consistent',
);
const futureCli = crabcast(future, ['daemon-status']);
check(
  /PRESENT BUT NOT BELIEVED/.test(futureCli.stdout) && /commit:\s+UNKNOWN/.test(futureCli.stdout),
  'which is what the CLI prints too'
);
show('$ crabcast daemon-status   (a stamp from a format this daemon does not read)',
  futureCli.stdout.split('freshness:')[0].trimEnd());

// The half that is coverable: writer and reader cannot disagree WITHIN a
// version, because there is only one definition of the number and the writer
// imports it out of the build it has just stamped. A sweep rather than a list —
// any script that grew its own literal would show up here without this check
// being updated.
const stampVersionHits = [];
for (const f of fs.readdirSync(scriptDir)) {
  if (!f.endsWith('.mjs')) continue;
  const text = fs.readFileSync(path.join(scriptDir, f), 'utf8');
  for (const line of text.split('\n')) {
    if (/\bstampVersion\b/.test(line)) stampVersionHits.push(`${f}: ${line.trim()}`);
  }
}
show('every `stampVersion` in scripts/:', stampVersionHits.join('\n') || '(none)');
const writerHits = stampVersionHits.filter((h) => h.startsWith('stamp-build.mjs:'));
check(
  writerHits.length === 1 && /stampVersion:\s*BUILD_STAMP_VERSION\b/.test(writerHits[0]),
  'the ONE stampVersion the writer emits is the shared constant, not a literal of its own',
  writerHits[0] ?? '(no hit in stamp-build.mjs)'
);
check(
  /BUILD_STAMP_VERSION\s*}\s*=\s*await import\(/.test(
    fs.readFileSync(stamperJs, 'utf8').replace(/\n\s*/g, ' ')
  ),
  'and it imports it from the dist/ it is stamping — one definition, so a mismatch needs two CrabCasts'
);

// ---------------------------------------------------------------------------
// 6. THE BUILD IS OLDER THAN ITS SOURCES.
// ---------------------------------------------------------------------------

rule('6. src/ NEWER THAN dist/ — the third state, measured rather than assumed');

const stale = makeTree('t-stale-src', { git: true });
stamp(stale);
pinTimes(stale);
const editedSource = path.join(stale.src, 'router.ts');
touch(editedSource, newestMs(stale.dist) + 5_000);

const staleSrcStatus = await startDaemon(stale, 't-stale-src');
show('daemon_status.freshness:', JSON.stringify(staleSrcStatus.freshness, null, 2));
check(
  staleSrcStatus.freshness?.state === 'build-predates-sources',
  'the state is build-predates-sources',
  String(staleSrcStatus.freshness?.state)
);
check(
  staleSrcStatus.freshness?.sourcesNewerThanBuild === true &&
    staleSrcStatus.freshness?.processIsCurrentBuild === true,
  'and both axes are reported: this daemon IS running the build on disk, and that build is behind src/'
);
check(
  staleSrcStatus.freshness?.sourceNewestFile === 'router.ts',
  'naming the source that moved',
  String(staleSrcStatus.freshness?.sourceNewestFile)
);
check(
  /npm run build/.test(String(staleSrcStatus.freshness?.summary)),
  'and telling a human what to do about it'
);

const staleSrcCli = crabcast(stale, ['daemon-status']);
show('$ crabcast daemon-status', staleSrcCli.stdout.trimEnd());
check(
  /freshness: BUILD-PREDATES-SOURCES/.test(staleSrcCli.stdout),
  'the CLI names the state rather than printing a boolean'
);

// The three states are three, and none of them is another.
const states = {
  'the process is running the build on disk': freshStatus.freshness?.state,
  'the process predates the current build': staleStatus.freshness?.state,
  'the build is older than its sources': staleSrcStatus.freshness?.state
};
console.log('');
for (const [question, state] of Object.entries(states)) {
  console.log(`  ${state.padEnd(24)}  ${question}`);
}
check(
  new Set(Object.values(states)).size === 3,
  'three situations, three distinct states — none collapses into another'
);

// ---------------------------------------------------------------------------
// 6b. A DIST-ONLY INSTALL — half the question is unanswerable, and saying so
//     is not the same as saying everything is fine.
// ---------------------------------------------------------------------------

rule('6b. A DIST-ONLY INSTALL DOES NOT GET A CLEAN BILL OF HEALTH IT DID NOT EARN');

// This is what `npm install -g .` produces: package.json's `files` is
// ["dist"], so the installed package has no src/ in it at all. The
// process-against-disk question is still answerable there; "is the build
// older than its sources" is not, because there are no sources.
const distOnly = makeTree('t-distonly', { git: true });
fs.rmSync(distOnly.src, { recursive: true, force: true });
stamp(distOnly);

const distOnlyStatus = await startDaemon(distOnly, 't-distonly');
show('daemon_status.freshness:', JSON.stringify(distOnlyStatus.freshness, null, 2));
check(
  distOnlyStatus.build?.commit !== null,
  'the build still names its commit — the stamp travels inside dist/, which is the point of putting it there'
);
check(
  distOnlyStatus.freshness?.processIsCurrentBuild === true,
  'and the process-against-disk question is still answered: this daemon is running the build on disk'
);
check(
  distOnlyStatus.freshness?.sourcesNewerThanBuild === null,
  'while "are the sources newer" answers null — there are no sources, and an unread directory is not a pass'
);
check(
  distOnlyStatus.freshness?.state === 'unknown',
  'so the STATE is unknown rather than current: a check that reports success when it could not run ' +
    'is worse than no check',
  String(distOnlyStatus.freshness?.state)
);
check(
  /this daemon is running the build that is on disk/.test(String(distOnlyStatus.freshness?.summary)) &&
    /could not be read/.test(String(distOnlyStatus.freshness?.summary)),
  'and the summary still reports what WAS established, alongside what was not — unknown is not a shrug'
);

// ---------------------------------------------------------------------------
// 6c. THE file-times FALLBACK SAYS WHAT IT CANNOT SEE (KAN-170 item 11).
//
// With no usable stamp on either side, `sameBuild()` falls back to newest-mtime
// equality plus file count. `compared by: file-times` told a reader the basis
// without telling them the bound, and "running the build on disk: yes" on that
// basis is a weaker sentence than the same words on a stamped comparison.
//
// The decision on KAN-138 was to state the bound in the output as ONE CLAUSE,
// with no behaviour change — `sameBuild()` keeps its semantics and the fallback
// stays the fallback. So this section does two things: it checks the clause is
// there, and then it MEASURES the bound, by performing exactly the rebuild the
// clause says cannot be distinguished and watching the daemon fail to see it.
// A string check alone would go green against a sentence that had become false.
//
// IF SOMEBODY STRENGTHENS THE FALLBACK — hashes the contents, say — the
// measurement below goes red, and that is correct: the wording would then be a
// lie and would have to change with the mechanism.
// ---------------------------------------------------------------------------

rule('6c. THE file-times FALLBACK NAMES ITS OWN BOUND — and the bound is real');

const ft = makeTree('t-filetimes', { git: true });
// Unstamped on purpose: the fallback is only reached when neither side has a
// usable stamp. Times pinned by hand rather than by pinTimes(), which dates
// everything from a stamp this tree does not have.
const ftBase = Date.now() - 300_000;
for (const f of walkFiles(ft.src)) touch(f, ftBase - 60_000);
for (const f of walkFiles(ft.dist)) touch(f, ftBase);

const ftStatus = await startDaemon(ft, 't-filetimes');
check(
  ftStatus.freshness?.basis === 'file-times' && ftStatus.freshness?.state === 'current',
  'PRECONDITION: an unstamped build reaches the fallback and reads as CURRENT on it',
  `${ftStatus.freshness?.basis} / ${ftStatus.freshness?.state}`
);
show('freshness.summary:', String(ftStatus.freshness?.summary));
check(
  /unchanged as far as file times can tell/.test(String(ftStatus.freshness?.summary)) &&
    /cannot distinguish/.test(String(ftStatus.freshness?.summary)),
  'the evidence sentence states what mtime-plus-count equality cannot distinguish'
);
const ftCli = crabcast(ft, ['daemon-status']);
const comparedByLine =
  ftCli.stdout.split('\n').find((l) => /^\s*compared by:/.test(l)) ?? '(no line)';
check(
  /mtime and file count only/.test(comparedByLine) &&
    /reads as unchanged/.test(comparedByLine),
  'and the CLI line that names the basis carries the same caveat, in one clause',
  JSON.stringify(comparedByLine.trim())
);

// Now the measurement. A rebuild that genuinely changes the compiled code and
// happens to leave the newest mtime and the file count where they were.
const ftTarget = path.join(ft.dist, 'router.js');
const ftBefore = fs.readFileSync(ftTarget, 'utf8');
const ftFilesBefore = walkFiles(ft.dist).length;
// Read back rather than compared against `ftBase`. `utimesSync` stores
// nanoseconds and `mtimeMs` converts back, and the round trip has been observed
// to land on 1785930363095.999 for a value set as …096 — so comparing the
// restored time to the number we asked for is a flake, while comparing it to
// what the same statSync path reported a moment earlier is exact. It is also
// the honest claim: the fallback looks at this number, and this number has not
// moved. (Caught by watching this section run under item 9's revert, which is
// the argument for backing each item out rather than trusting a green run.)
const ftNewestBefore = newestMs(ft.dist);
fs.writeFileSync(ftTarget, ftBefore + '\n// KAN-170 item 11: this build is not the one that booted.\n');
for (const f of walkFiles(ft.dist)) touch(f, ftBase);

check(
  fs.readFileSync(ftTarget, 'utf8') !== ftBefore,
  'PRECONDITION: dist/router.js really differs from what the daemon booted on',
  `${ftBefore.length} → ${fs.readFileSync(ftTarget, 'utf8').length} bytes`
);
check(
  newestMs(ft.dist) === ftNewestBefore && walkFiles(ft.dist).length === ftFilesBefore,
  'PRECONDITION: and the two things the fallback looks at are exactly where they were',
  `newest ${newestMs(ft.dist)} (was ${ftNewestBefore}), ${ftFilesBefore} file(s)`
);

const ftAfter = await raw(ft, 'daemon_status');
check(
  ftAfter.pid === ftStatus.pid,
  'the same daemon is still serving',
  `pid ${ftAfter.pid}`
);
check(
  ftAfter.freshness?.processIsCurrentBuild === true && ftAfter.freshness?.state === 'current',
  'AND IT STILL SAYS "running the build on disk: yes" — which is the bound, measured rather than asserted about'
);
check(
  /cannot distinguish/.test(String(ftAfter.freshness?.summary)),
  'with the caveat riding the very reply that is wrong about it — the sentence is on the screen where it is needed'
);

// ---------------------------------------------------------------------------
// 7. THE SNAPSHOT IS TAKEN AT BOOT, AND THE SOURCE SAYS SO.
//
// Everything above rests on one property: the provenance the daemon reports is
// read ONCE, when the process starts. A refactor that "simplified" it into a
// per-request read would leave every check in sections 1, 2, 4, 5 and 6 green
// and silently delete the only thing this ticket asked for — section 3 is the
// one that would catch it, and section 3 is also the one a future editor is
// most likely to find slow and skip. So the property is also asserted
// mechanically, against the source, where it is cheap.
// ---------------------------------------------------------------------------

rule('7. THE BOOT SNAPSHOT IS TAKEN ONCE, AT BOOT — asserted against the source');

const daemonTs = fs.readFileSync(path.join(repoSrc, 'daemon.ts'), 'utf8');
const routerTs = fs.readFileSync(path.join(repoSrc, 'router.ts'), 'utf8');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const daemonCode = stripComments(daemonTs);
const routerCode = stripComments(routerTs);

const snapshotCalls = (daemonCode.match(/snapshotBuild\s*\(/g) ?? []).length;
check(
  snapshotCalls === 1,
  'daemon.ts calls snapshotBuild() exactly once',
  `${snapshotCalls} call(s)`
);
check(
  !/snapshotBuild\s*\(/.test(routerCode),
  'and the router never calls it — a per-request read would answer about the tree, not about the process'
);
check(
  /bootBuild/.test(routerCode) && /buildProvenanceReport\s*\(\s*bootBuild\s*\)/.test(routerCode),
  'the router reports from the snapshot it was handed'
);
// The snapshot must be taken before the socket opens, or the first client can
// be answered about a tree that has already moved.
const snapshotAt = daemonCode.indexOf('snapshotBuild(');
const listenAt = daemonCode.indexOf('server.listen(');
check(
  snapshotAt !== -1 && listenAt !== -1 && snapshotAt < listenAt,
  'and it is taken before the daemon starts listening',
  `snapshotBuild() at offset ${snapshotAt}, server.listen() at ${listenAt}`
);

// -------------------------------------------------------------------- verdict

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
