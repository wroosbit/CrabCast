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
// Usage:
//   npm run build
//   node scripts/verify-daemon-provenance.mjs
//
// Exits non-zero on any failure, so a reviewer can re-run it against the PR
// head. It is meant to be ABLE to fail: make the provenance reader answer
// "clean" for a tree it knows nothing about and sections 4 and 5 go red.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { BUILD_STAMP_FILENAME } = await import(path.join(repoDist, 'provenance.js'));
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

/** Run the real stamper against a fixture's `dist/`, as `npm run build` would. */
function stamp(tree) {
  const out = execFileSync(process.execPath, [stamperJs, tree.dist], {
    encoding: 'utf8',
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return out.trimEnd();
}

const readStamp = (tree) =>
  JSON.parse(fs.readFileSync(path.join(tree.dist, BUILD_STAMP_FILENAME), 'utf8'));

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
