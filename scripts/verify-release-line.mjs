#!/usr/bin/env node
// Live proof for KAN-592: `daemon-status` says whether the build it is running
// is on a RELEASED line, and says "cannot tell" when it cannot — never a green.
//
// WHAT FAILURE THIS WOULD CATCH: `crabcast daemon-status` on the live daemon
// reporting `freshness: CURRENT`, `running the build on disk: yes` and
// `checkout: clean when this build was made` for a process built from
// `c730a98`, a commit on `incident/kan-552-herdr-0.8-port` and on no release
// line at all. Every one of those three was TRUE. The fleet served that build
// for roughly 24 hours and nothing on this response asked the one question an
// operator reads `CURRENT` as having answered. Run against a tree with that
// defect, §1 below goes red naming the commit, the ref and the tree.
//
// ---------------------------------------------------------------------------
// WHAT EACH SECTION EXERCISES, AND HOW FAR DOWN IT REACHES
// ---------------------------------------------------------------------------
//
// The sections do not all reach the same depth, and saying which is which is
// the difference between this header being a description and being a claim.
//
//   §1, §2  A REAL DAEMON, over a real unix socket, rendered by the real CLI.
//           These are the two acceptance cases — a build off the line and a
//           build on it — and they are the ones where the HEADLINE WORD is the
//           product, so they are asserted on the bytes a human actually reads.
//
//   §3-§6   THE COMPILED `provenance.js`, IN PROCESS, against real git
//           repositories this script builds. No daemon and no socket. That is
//           a deliberate trade and not a shortcut: every one of these is about
//           what the provenance reader does with a tree, the daemon adds
//           nothing to that question but seconds, and `verify-daemon-status-
//           over-mcp` already holds the socket and MCP surfaces to carrying
//           these blocks unchanged. WHAT IT LEAVES UNCOVERED: that the fields
//           §3-§6 assert on survive the wire. §1 and §2 cover exactly that for
//           the fields they read, and no section covers it for the rest.
//
//   §7      THE RED DRIVE. Three mutations of the compiled build, each a shape
//           a real regression could take, each required to turn a named
//           assertion above RED. Without this, everything above is a set of
//           observations that have only ever passed.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// A proof that supplies its own input has not tested that the input arrives.
// Every git repository below is one this script created, because the situations
// under test — a build made from an unmerged branch, a clone whose remote-
// tracking ref is behind the remote, a detached HEAD, a `dist/` with no
// repository beside it — are the PRODUCT, and a script that could not construct
// them would be asserting that the happy path is happy.
//
// What that leaves uncovered, precisely: nothing here observes the REAL
// deployment. The incident this ticket was filed for was found by a human
// running `crabcast daemon-status` against the live daemon and then asking git
// a question this response did not, and no script can be in that position. This
// proof shows the response would have named it. It does not show that anybody
// ran the response.
//
// AND ONE MORE, WHICH IS THE SHARPEST: `RELEASE_REF_CANDIDATES` IS A CLAIM
// ABOUT WHAT "RELEASED" MEANS, AND NOTHING BELOW TESTS THAT CLAIM. Every
// section takes that list as given and asserts the machinery around it. If this
// repository's release line stopped being `main`, every check here would stay
// green while every answer became wrong. That is a judgement, it is reviewed
// like code, and it is written down here rather than left to be discovered.
//
// ---------------------------------------------------------------------------
// NOTHING BELOW REACHES THE NETWORK, AND §5 IS WHAT ESTABLISHES THAT
// ---------------------------------------------------------------------------
//
// The whole point of the design is that this answer is computed from LOCAL refs
// — `daemon-status` has to work on a machine with no route out. Asserting that
// by reading the source would be asserting the code says what it says. §5b
// asserts it BY CONSEQUENCE instead: a clone whose remote-tracking ref is
// behind a remote that HAS the commit must answer `no`, and must answer `yes`
// only once this script itself runs `git fetch`. A build that reached the
// network would answer `yes` the first time, and the section would go red.
//
// Usage:
//   npm run build
//   node scripts/verify-release-line.mjs
//
// Needs `git` and node. No herdr, no network, no installed CrabCast: each
// daemon gets a scratch $HOME and its own dataDir.
//
// Exits non-zero on any failure, so a reviewer can re-run it against the PR
// head.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const repoDist = path.join(repoRoot, 'dist');
const repoSrc = path.join(repoRoot, 'src');
const stamperJs = path.join(scriptDir, 'stamp-build.mjs');

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, text) => console.log(`   ${label}\n${String(text).replace(/^/gm, '     ')}`);

let failures = 0;
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

if (!fs.existsSync(path.join(repoDist, 'provenance.js'))) {
  console.error(
    'FAIL  dist/provenance.js not found — run `npm run build` first. This script drives the\n' +
      '      BUILT output; it will not report on code it did not run.'
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
  console.error(
    'FAIL  node_modules/ not found — run `npm ci` first. The fixture trees below link to it so\n' +
      '      a copied dist/ can resolve its dependencies.'
  );
  process.exit(1);
}

const { BUILD_STAMP_FILENAME, RELEASE_REF_CANDIDATES } = await import(
  path.join(repoDist, 'provenance.js')
);
const { connectToDaemon, onJsonLines, socketPathFor, writeJsonLine } = await import(
  path.join(repoDist, 'ipc.js')
);

// --------------------------------------------------------------- the scratch
//
// Short path segments: the config loader refuses a dataDir whose socket path
// would exceed the 104-character unix address limit.
//
// OUTSIDE the repository, deliberately and for the reason
// `verify-daemon-provenance` gives: `stamp-build.mjs` asks git about the
// package root beside the `dist/` it stamps, so a fixture nested inside this
// checkout would have git answer about CRABCAST'S OWN repository — and every
// fixture below whose whole point is a particular git situation would quietly
// become "a tree inside crabcast", with `refs/remotes/origin/main` present and
// this script proving nothing.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rel-'));
const fakeHome = path.join(scratch, 'h');
fs.mkdirSync(fakeHome, { recursive: true });
fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const daemons = [];
function cleanup() {
  for (const d of daemons) {
    try {
      process.kill(d.pid, 'SIGTERM');
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const ENV = {
  ...process.env,
  HOME: fakeHome,
  PATH: '/usr/local/bin:/usr/bin:/bin',
  CRABCAST_CONFIG: undefined
};

const { mutate } = makeMutator({
  distDir: repoDist,
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

// ------------------------------------------------------------- fixture trees

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

/** Run git in a fixture. Throws — a fixture that will not build is not a verdict. */
const g = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  }).trim();

/**
 * A package tree — `dist/` and `src/` copied out of this checkout — optionally
 * inside a real little git repository.
 *
 * The copies are whole packages for an UNMUTATED daemon to describe, which is
 * why this script is not in `verify-mutation-harness`'s
 * COPIES_BUT_DOES_NOT_MUTATE register: the mutants it does make go through the
 * shared helper, and these do not overlap.
 */
function makeTree(name, { git = true } = {}) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(repoDist, path.join(dir, 'dist'), { recursive: true });
  fs.cpSync(repoSrc, path.join(dir, 'src'), { recursive: true });
  // A copy carries the source tree's stamp; every fixture stamps its own.
  fs.rmSync(path.join(dir, 'dist', BUILD_STAMP_FILENAME), { force: true });

  if (git) {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\nnode_modules/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'config', 'user.email', 'verify@crabcast.invalid');
    g(dir, 'config', 'user.name', 'KAN-592 verify');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'KAN-592 fixture: the release line');
  }

  return { name, dir, dist: path.join(dir, 'dist'), src: path.join(dir, 'src') };
}

/** A commit on a new branch, with a real file change so it is a real commit. */
function commitOnBranch(tree, branch, message) {
  g(tree.dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(tree.dir, `${branch}.txt`), `${message}\n`);
  g(tree.dir, 'add', '-A');
  g(tree.dir, 'commit', '-q', '-m', message);
  return g(tree.dir, 'rev-parse', 'HEAD');
}

/** Run the real, unedited stamper against a fixture's dist, as `npm run build` does. */
function stamp(tree, env = ENV) {
  return execFileSync(process.execPath, [stamperJs, tree.dist], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trimEnd();
}

const readStamp = (tree) =>
  JSON.parse(fs.readFileSync(path.join(tree.dist, BUILD_STAMP_FILENAME), 'utf8'));

/**
 * Pin file times so "are the sources newer than the build" is ARRANGED rather
 * than raced: `fs.cpSync` stamps every copy with the current time, which would
 * leave `src/` and `dist/` milliseconds apart and let copy order decide.
 * Sources a minute before the build, compiled output a second before its own
 * stamp — which is what a real `npm run build` produces.
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

/**
 * The provenance report for a fixture, computed by a named build's compiled
 * `provenance.js`.
 *
 * `distDir` selects the CODE; `tree` selects the SUBJECT. The two are separate
 * arguments precisely so §7 can point a MUTATED reader at an UNCHANGED fixture
 * and watch the verdict move — if the mutation had to be applied to the fixture
 * as well, the section would be measuring its own scaffolding.
 */
async function reportFor(tree, distDir = repoDist) {
  const provenance = await import(path.join(distDir, 'provenance.js'));
  const boot = provenance.snapshotBuild(tree.dist);
  return provenance.buildProvenanceReport(boot);
}

// -------------------------------------------------------------- the daemons

/** A config for a fixture, written OUTSIDE the tree so it cannot dirty it. */
function configFor(tree) {
  const dataDir = path.join(scratch, `${tree.name}-d`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `${tree.name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { dataDir, configPath };
}

async function startDaemon(tree, cfg) {
  const errFile = path.join(cfg.dataDir, 'spawn.err');
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(tree.dist, 'daemon.js'), cfg.configPath], {
    env: ENV,
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPathFor(cfg.dataDir))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(socketPathFor(cfg.dataDir))) {
    throw new Error(
      `daemon for ${tree.name} never opened its socket. Its stderr:\n` +
        fs.readFileSync(errFile, 'utf8')
    );
  }
  const status = await raw(cfg, 'daemon_status');
  daemons.push({ pid: status.pid, label: tree.name });
  return status;
}

let rawId = 0;
/** One raw NDJSON round trip: the wire, unmediated by any renderer. */
async function raw(cfg, action, payload = {}) {
  const socket = await connectToDaemon(cfg.dataDir, { spawnIfMissing: false });
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

/** The real CLI, rendering the real response. */
function cli(tree, cfg) {
  const run = spawnSync(process.execPath, [path.join(tree.dist, 'cli.js'), 'daemon-status'], {
    encoding: 'utf8',
    env: { ...ENV, CRABCAST_CONFIG: cfg.configPath }
  });
  return `${run.stdout ?? ''}${run.stderr ?? ''}`;
}

/** `daemon-status` output from the `freshness:` headline down. */
const freshnessLines = (stdout) => {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const at = lines.findIndex((l) => /^freshness: /.test(l));
  return at === -1 ? [] : lines.slice(at);
};

// ===========================================================================
// 1. A BUILD FROM A COMMIT THAT NEVER LANDED IS NAMED AS SUCH
// ===========================================================================

rule('1. OFF THE RELEASE LINE — the incident shape, over a real daemon and the real CLI');

const off = makeTree('off');
const offMain = g(off.dir, 'rev-parse', 'HEAD');
const offCommit = commitOnBranch(off, 'incident', 'KAN-592 fixture: an incident branch nobody merged');
stamp(off);
pinTimes(off);

// PRECONDITIONS. Each of these is a way this section could pass while checking
// nothing: a fixture whose branch commit IS on main would make `off-release-
// line` unreachable, and a stamp naming a different commit would have the
// daemon answering about a build this script did not make.
check(
  offCommit !== offMain,
  'the fixture really has a commit off its own main',
  `main ${offMain.slice(0, 12)}, incident ${offCommit.slice(0, 12)}`
);
check(
  spawnSync('git', ['-C', off.dir, 'merge-base', '--is-ancestor', offCommit, offMain]).status === 1,
  'and git agrees that commit is NOT reachable from main',
  'if it were, the state under test could not occur and every assertion below would be vacuous'
);
check(
  readStamp(off).commit === offCommit,
  'and the stamp the daemon will read names that commit',
  `${readStamp(off).commit}`
);

const offCfg = configFor(off);
const offStatus = await startDaemon(off, offCfg);
const offFresh = offStatus.freshness ?? {};

check(
  offFresh.state === 'off-release-line',
  'THE STATE IS `off-release-line` — not `current`',
  `state: ${JSON.stringify(offFresh.state)}. Before KAN-592 this tree read \`current\`, because ` +
    `every question the response asked of it had a clean answer`
);
check(offFresh.onReleaseLine === false, '`onReleaseLine` is false', JSON.stringify(offFresh.onReleaseLine));
check(
  offFresh.processIsCurrentBuild === true && offFresh.sourcesNewerThanBuild === false,
  'and the OTHER TWO answers are still clean, which is the whole finding',
  `processIsCurrentBuild=${offFresh.processIsCurrentBuild}, ` +
    `sourcesNewerThanBuild=${offFresh.sourcesNewerThanBuild} — a tree that is internally ` +
    `consistent and still not released is exactly what "three true greens" was`
);
check(
  offFresh.releaseRef === 'refs/heads/main' && offFresh.releaseRefCommit === offMain,
  'the ref it rested on is named, and is the object it actually compared against',
  `${offFresh.releaseRef} at ${offFresh.releaseRefCommit}`
);
check(
  typeof offFresh.summary === 'string' &&
    offFresh.summary.includes(offCommit) &&
    offFresh.summary.includes('refs/heads/main'),
  'THE SUMMARY NAMES THE COMMIT AND THE REF IT IS NOT ON',
  offFresh.summary?.includes(offCommit) ? 'both present' : 'the commit or the ref is missing'
);
check(
  /NOTHING WAS FETCHED/.test(offFresh.summary ?? '') && /git fetch/.test(offFresh.summary ?? ''),
  'and it states the bound on its own `no`: nothing was fetched, so fetch and ask again',
  'a `no` read off a stale ref is the one branch that can be wrong, and it says so'
);
check(
  /REBUILDING WILL\s+NOT CLEAR IT|REBUILDING WILL NOT CLEAR IT/.test(offFresh.summary ?? ''),
  'and it distinguishes itself from the two staleness states by naming a different remedy',
  'the other states say "restart the daemon" or "run npm run build"; this one says neither works'
);

const offCli = freshnessLines(cli(off, offCfg));
show('$ crabcast daemon-status   (fixture built from an unmerged branch)', offCli.join('\n'));
check(
  offCli[0] === 'freshness: OFF-RELEASE-LINE',
  'AND THE HEADLINE A HUMAN READS IS `freshness: OFF-RELEASE-LINE`',
  `first line: ${JSON.stringify(offCli[0])}. The headline is the product here — a fourth green ` +
    `line under three others is what nobody read the first time`
);
check(
  offCli.some((l) => /^ {2}on the release line: +no$/.test(l)),
  'the block carries `on the release line: no`',
  offCli.find((l) => l.includes('on the release line')) ?? 'absent'
);
check(
  offCli.some((l) => l.includes(`refs/heads/main at ${offMain}`)),
  'and the evidence line names the ref, the object and the tree',
  offCli.find((l) => l.trim().startsWith('release line:')) ?? 'absent'
);

// ===========================================================================
// 2. A BUILD ON THE RELEASE LINE STILL READS CLEAN
// ===========================================================================

rule('2. ON THE RELEASE LINE — the clean case still reads CURRENT, and gains two lines');

const on = makeTree('on');
const onCommit = g(on.dir, 'rev-parse', 'HEAD');
stamp(on);
pinTimes(on);

const onCfg = configFor(on);
const onStatus = await startDaemon(on, onCfg);
const onFresh = onStatus.freshness ?? {};

check(
  onFresh.state === 'current',
  'THE STATE IS STILL `current` for a build on the line',
  `state: ${JSON.stringify(onFresh.state)}`
);
check(onFresh.onReleaseLine === true, '`onReleaseLine` is true', JSON.stringify(onFresh.onReleaseLine));
check(
  onFresh.releaseRef === 'refs/heads/main' && onFresh.releaseRefCommit === onCommit,
  'and it names the ref that answered',
  `${onFresh.releaseRef} at ${onFresh.releaseRefCommit}`
);
check(
  Object.keys(onFresh.unknown ?? {}).length === 0,
  'nothing is unknown, so no `COULD NOT BE ESTABLISHED` block is printed',
  JSON.stringify(onFresh.unknown)
);
check(
  !/NOTHING WAS FETCHED|fetch and ask again/i.test(onFresh.summary ?? ''),
  'AND THE `yes` CARRIES NO STALENESS CAVEAT, because it has not earned one',
  'reachability is monotonic under fast-forward, so a stale ref can make a `yes` LATE but never ' +
    'wrong. The caveat rides the `no` in §1 and nowhere else'
);

const onCli = freshnessLines(cli(on, onCfg));
show('$ crabcast daemon-status   (fixture built from its own main)', onCli.join('\n'));
check(onCli[0] === 'freshness: CURRENT', 'the headline is unchanged for a clean tree', onCli[0]);
check(
  onCli.filter((l) => /UNKNOWN/.test(l)).length === 0,
  'and the clean block prints no UNKNOWN anywhere',
  'AC2 is "no new noise", and a diagnostic that shouts on a healthy machine gets ignored on a sick one'
);
const addedLines = onCli.filter((l) => /^ {2}(on the release line|release line):/.test(l));
check(
  addedLines.length === 2,
  'the whole cost of this change on a clean run is TWO LINES',
  `${addedLines.length}: ${addedLines.map((l) => l.trim().split(':')[0]).join(', ')} — AC2 is ` +
    `"no new noise", and the summary sentence gains one clause rather than a paragraph`
);

// ===========================================================================
// 3. THE FOUR VERDICTS ARE DISTINGUISHABLE FROM EACH OTHER
// ===========================================================================

rule('3. OFF-THE-LINE vs BEHIND vs DIRTY vs UNKNOWN — four situations, four readings');

// BEHIND: the build on disk is older than `src/`. Same tree as §2, so the ONLY
// thing that differs between this reading and that one is the file times —
// which is what makes the two readings comparable at all.
const behind = makeTree('behind');
stamp(behind);
const behindBuiltAt = pinTimes(behind);
touch(path.join(behind.src, 'router.ts'), behindBuiltAt + 60_000);
const behindReport = await reportFor(behind);

// DIRTY: a tree with an uncommitted edit at stamp time. The commit is still on
// main, so this is the case that separates "not clean" from "not released".
const dirty = makeTree('dirty');
fs.writeFileSync(path.join(dirty.dir, 'uncommitted.txt'), 'an edit nobody committed\n');
stamp(dirty);
pinTimes(dirty);
const dirtyReport = await reportFor(dirty);

// UNKNOWN: a repository with no branch called `main` and no remote at all, so
// none of the candidate refs resolves. Also §4's fixture; built once.
const noRef = makeTree('noref');
g(noRef.dir, 'branch', '-m', 'main', 'trunk');
const noRefCommit = g(noRef.dir, 'rev-parse', 'HEAD');
stamp(noRef);
pinTimes(noRef);
const noRefReport = await reportFor(noRef);

const states = {
  'off the line': offFresh.state,
  behind: behindReport.freshness.state,
  dirty: dirtyReport.freshness.state,
  unknown: noRefReport.freshness.state
};
show('the four states', JSON.stringify(states, null, 2));

check(
  behindReport.freshness.state === 'build-predates-sources',
  'BEHIND reads `build-predates-sources`, not `off-release-line`',
  behindReport.freshness.state
);
check(
  behindReport.freshness.onReleaseLine === true,
  'and it is still ON the line — the two questions are independent and both are answered',
  `onReleaseLine=${behindReport.freshness.onReleaseLine}`
);
check(
  dirtyReport.build.clean === false && dirtyReport.freshness.state === 'current',
  'DIRTY is a fact about `build.clean` and does not touch the state',
  `clean=${dirtyReport.build.clean}, state=${dirtyReport.freshness.state}. A build made from ` +
    `uncommitted edits to a commit that IS released is a different problem from a build made ` +
    `from a branch that never landed, and conflating them would lose both`
);
check(
  dirtyReport.freshness.onReleaseLine === true,
  'and a dirty checkout at a released commit still reads ON the line',
  'the question is about the COMMIT the stamp names, which is what git can answer about'
);
check(
  noRefReport.freshness.state === 'unknown' && noRefReport.freshness.onReleaseLine === null,
  'UNKNOWN reads `unknown` with `onReleaseLine: null` — never `current`, never `false`',
  `state=${noRefReport.freshness.state}, onReleaseLine=${noRefReport.freshness.onReleaseLine}`
);
check(
  new Set([states['off the line'], states.behind, states.unknown]).size === 3,
  'off-the-line, behind and unknown are three DISTINCT states, so a reader can act on the word',
  JSON.stringify(states)
);
check(
  states.dirty === onFresh.state,
  'and DIRTY deliberately shares the clean case\'s state rather than getting one of its own',
  `dirty=${states.dirty}, clean=${onFresh.state} — cleanliness is reported by \`build.clean\`, ` +
    `and giving it a state would assert that a RELEASED build made from a dirty tree is not ` +
    `released, which is a different claim and a false one`
);

// ===========================================================================
// 4. "CANNOT TELL" IS A THIRD ANSWER AND READS AS NEITHER OF THE OTHER TWO
// ===========================================================================

rule('4. THE OFFLINE CASE — no ref to compare against, and it says so');

// An unreachable remote, so this really is an offline clone rather than one
// that merely has no remote configured. 203.0.113.0/24 is TEST-NET-3 (RFC 5737)
// and is reserved for documentation: nothing routes there, by definition.
g(noRef.dir, 'remote', 'add', 'origin', 'https://203.0.113.1/unreachable.git');
const offlineStart = Date.now();
const offlineReport = await reportFor(noRef);
const offlineMs = Date.now() - offlineStart;
const offlineReason = offlineReport.freshness.unknown?.onReleaseLine ?? '';

show('the reason it could not tell', offlineReason);

check(
  offlineReport.freshness.onReleaseLine === null,
  'with an unreachable remote and no candidate ref, the answer is `null` — COULD NOT TELL',
  `onReleaseLine=${offlineReport.freshness.onReleaseLine}`
);
check(
  offlineReport.freshness.onReleaseLine !== false,
  'and it is NOT reported as `false`, which would be a finding this run has not made',
  '"I could not ask" and "I asked and the answer is no" send a reader to two different places'
);
check(
  offlineReport.freshness.state === 'unknown',
  'the state is demoted to `unknown` rather than left at `current`',
  `state=${offlineReport.freshness.state} — this is the ticket's task 2: an unanswerable ` +
    `release-line question reporting CURRENT would recreate the defect one layer down`
);
check(
  /NOTHING WAS FETCHED/.test(offlineReason) &&
    RELEASE_REF_CANDIDATES.every((ref) => offlineReason.includes(ref)),
  'the reason names every ref it looked for and says nothing was fetched',
  `${RELEASE_REF_CANDIDATES.length} candidate ref(s) named`
);
check(
  /FRESHNESS COULD NOT BE ESTABLISHED|could not be established/i.test(
    offlineReport.freshness.summary
  ) || offlineReport.freshness.summary.includes(offlineReason),
  'and the summary carries that reason rather than swallowing it',
  'the CLI renders `unknown` under a heading that refuses to be read as an all-clear'
);
// SUPPORTING EVIDENCE, AND IT IS THE WEAK KIND — said so rather than dressed
// up. A fast answer is consistent with no network attempt and does not
// establish it: a connection refused instantly is fast too. §4b is the control
// that actually discriminates.
check(
  offlineMs < 5_000,
  '(supporting, weak) the answer came back promptly rather than waiting on a socket',
  `${offlineMs}ms — consistent with no network attempt and NOT evidence of one; §5b is what ` +
    `discriminates`
);

// ===========================================================================
// 5. IT DOES NOT FETCH — SHOWN BY MAKING A FETCH CHANGE THE ANSWER
// ===========================================================================

rule('5. THE CONTROL: a fetch would flip this answer, and only this script may perform it');

// A clone whose remote-tracking ref is BEHIND a remote that already has the
// built commit. That is what every machine looks like between somebody else's
// merge and your next fetch, and it is the one arrangement where "did this code
// reach the network" has an observable answer.
const upstream = path.join(scratch, 'upstream.git');
g(scratch, 'init', '-q', '--bare', '-b', 'main', upstream);

const stale = makeTree('stale');
const staleBase = g(stale.dir, 'rev-parse', 'HEAD');
g(stale.dir, 'remote', 'add', 'origin', upstream);
g(stale.dir, 'push', '-q', 'origin', 'main');
const staleCommit = commitOnBranch(stale, 'feature', 'KAN-592 fixture: a commit that has landed upstream');
g(stale.dir, 'push', '-q', 'origin', 'feature:main');
// `git push` updates the remote-tracking ref for what it pushed, so rewind it
// by hand. THIS IS SCAFFOLDING AND IT IS SAID OUT LOUD: what it manufactures is
// an ordinary clone that has not fetched since somebody else's merge, produced
// in one command instead of by waiting for one.
g(stale.dir, 'update-ref', 'refs/remotes/origin/main', staleBase);
stamp(stale);
pinTimes(stale);

check(
  g(upstream, 'rev-parse', 'main') === staleCommit,
  '(setup) the REMOTE already has the built commit on its main',
  `upstream main = ${staleCommit.slice(0, 12)}`
);
check(
  g(stale.dir, 'rev-parse', 'refs/remotes/origin/main') === staleBase,
  '(setup) and this clone\'s remote-tracking ref is still behind it',
  `origin/main = ${staleBase.slice(0, 12)} — one fetch away from ${staleCommit.slice(0, 12)}`
);

const beforeFetch = await reportFor(stale);
check(
  beforeFetch.freshness.onReleaseLine === false,
  'IT ANSWERS `no` — so it did not fetch, because a fetch would have made this `yes`',
  `onReleaseLine=${beforeFetch.freshness.onReleaseLine}, ref=${beforeFetch.freshness.releaseRef} ` +
    `at ${beforeFetch.freshness.releaseRefCommit?.slice(0, 12)}. This is the whole of the ` +
    `no-network claim, asserted by consequence rather than by reading the source`
);
check(
  beforeFetch.freshness.releaseRef === 'refs/remotes/origin/main',
  'and it preferred the remote-tracking ref over the local branch',
  `${beforeFetch.freshness.releaseRef}`
);

// THE POSITIVE CONTROL. Without this the `no` above is satisfied by a check
// that answers `no` to everything, which is the failure this whole suite is
// built around. The fetch is run BY THIS SCRIPT, from outside the code under
// test, and nothing else about the fixture changes.
g(stale.dir, 'fetch', '-q', 'origin');
const afterFetch = await reportFor(stale);
check(
  g(stale.dir, 'rev-parse', 'refs/remotes/origin/main') === staleCommit,
  '(control) after THIS SCRIPT fetches, the remote-tracking ref has moved',
  `origin/main = ${staleCommit.slice(0, 12)}`
);
check(
  afterFetch.freshness.onReleaseLine === true && afterFetch.freshness.state === 'current',
  'AND THE SAME BUILD NOW READS `yes` — so the `no` above was about the ref and nothing else',
  `onReleaseLine=${afterFetch.freshness.onReleaseLine}, state=${afterFetch.freshness.state}`
);
check(
  g(stale.dir, 'rev-parse', 'refs/heads/main') === staleBase,
  'and the LOCAL main is still behind, so the flip came from the remote-tracking ref\'s precedence',
  `refs/heads/main = ${staleBase.slice(0, 12)} — a reader that preferred the local branch would ` +
    `still say no here, and this assertion is what tells the two apart`
);

// ===========================================================================
// 6. NO REPOSITORY, NO GIT, A FOREIGN REPOSITORY, A DETACHED HEAD
// ===========================================================================

rule('6. THE STATES A DEVELOPER MACHINE REALLY HAS — each an answer, none of them "clean"');

// 6a. No git metadata at all. The stamp has no commit, so there is nothing to
// look for, and the reason says where the explanation lives rather than
// carrying a second copy of it.
const bare = makeTree('bare', { git: false });
stamp(bare);
pinTimes(bare);
const bareReport = await reportFor(bare);
check(
  bareReport.freshness.onReleaseLine === null && bareReport.freshness.state === 'unknown',
  '6a. a tree with no `.git` answers `null`, and the state is `unknown`',
  `${JSON.stringify(bareReport.freshness.onReleaseLine)} / ${bareReport.freshness.state}`
);
check(
  /names no commit/.test(bareReport.freshness.unknown?.onReleaseLine ?? ''),
  '    and the reason is that the BUILD names no commit, pointing at the block that says why',
  bareReport.freshness.unknown?.onReleaseLine?.slice(0, 90) ?? 'no reason recorded'
);

// 6b. No `git` binary. The environment is constructed; the code is the shipped
// code. `process.env` is what `spawnSync` reads, so stripping it here strips it
// for the compiled reader too.
const noGitPath = process.env.PATH;
let noGitReport;
try {
  process.env.PATH = '';
  noGitReport = await reportFor(on);
} finally {
  process.env.PATH = noGitPath;
}
check(
  spawnSync('git', ['--version'], { env: { ...process.env, PATH: '' } }).error?.code === 'ENOENT',
  '(setup) `git` really cannot be spawned through the stripped PATH',
  'without this the section below would be measuring an unstripped environment'
);
check(
  noGitReport.freshness.onReleaseLine === null &&
    /no `git` on PATH/.test(noGitReport.freshness.unknown?.onReleaseLine ?? ''),
  '6b. a machine with no `git` answers `null` and names the missing binary',
  noGitReport.freshness.unknown?.onReleaseLine?.slice(0, 90) ?? 'no reason recorded'
);
check(
  (await reportFor(on)).freshness.onReleaseLine === true,
  '    and the SAME fixture answers `true` again once PATH is restored',
  'the difference measured is the PATH and not the fixture'
);

// 6c. A dist-only install: a stamped `dist/` sitting in a tree with no
// repository beside it. The commit IS known, so this reaches the git call and
// exercises the branch 6a cannot.
const distOnly = path.join(scratch, 'dist-only');
fs.mkdirSync(distOnly, { recursive: true });
// `preserveTimestamps`, and it is load-bearing: a copy stamped with the
// current time is NEWER than its own `build-stamp.json`, which this reader
// correctly disbelieves — so without it this fixture would have no commit and
// would exercise 6a's branch again instead of its own.
fs.cpSync(on.dist, path.join(distOnly, 'dist'), { recursive: true, preserveTimestamps: true });
const distOnlyReport = await reportFor({ dist: path.join(distOnly, 'dist') });
check(
  distOnlyReport.freshness.onReleaseLine === null &&
    /not inside a git working tree/.test(distOnlyReport.freshness.unknown?.onReleaseLine ?? ''),
  '6c. a `dist`-only install answers `null` and says there is no working tree to walk',
  distOnlyReport.freshness.unknown?.onReleaseLine?.slice(0, 90) ?? 'no reason recorded'
);

// 6d. A repository that does not contain the commit — the same `dist/` dropped
// into somebody else's checkout. `merge-base --is-ancestor` exits 128 here, and
// a reader that only tested for zero would report this as a plain `no`.
const foreign = makeTree('foreign');
fs.rmSync(foreign.dist, { recursive: true, force: true });
fs.cpSync(on.dist, foreign.dist, { recursive: true, preserveTimestamps: true });
const foreignReport = await reportFor(foreign);
check(
  foreignReport.freshness.onReleaseLine === null,
  '6d. a repository that has never heard of the commit answers `null`, NOT `false`',
  `onReleaseLine=${foreignReport.freshness.onReleaseLine} — git exits 128 rather than 1 here, ` +
    `and collapsing the two would report a released build as unreleased`
);
check(
  /does not contain/.test(foreignReport.freshness.unknown?.onReleaseLine ?? '') &&
    foreignReport.freshness.unknown?.onReleaseLine?.includes(onCommit),
  '    and the reason names the commit and the tree that could not find it',
  foreignReport.freshness.unknown?.onReleaseLine?.slice(0, 110) ?? 'no reason recorded'
);

// 6e. A detached HEAD. The answer is about the commit the STAMP names, so a
// detached HEAD changes nothing — which is the thing worth stating, because the
// obvious guess is that it would break the check.
const detachedOn = makeTree('det-on');
g(detachedOn.dir, 'checkout', '-q', '--detach', 'HEAD');
stamp(detachedOn);
pinTimes(detachedOn);
const detachedOnReport = await reportFor(detachedOn);

const detachedOff = makeTree('det-off');
commitOnBranch(detachedOff, 'incident', 'KAN-592 fixture: detached at an unmerged commit');
g(detachedOff.dir, 'checkout', '-q', '--detach', 'HEAD');
stamp(detachedOff);
pinTimes(detachedOff);
const detachedOffReport = await reportFor(detachedOff);

check(
  g(detachedOn.dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD' &&
    g(detachedOff.dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD',
  '(setup) both detached fixtures really have a detached HEAD',
  'a fixture still on a branch would make the two assertions below say nothing'
);
check(
  detachedOnReport.freshness.onReleaseLine === true &&
    detachedOffReport.freshness.onReleaseLine === false,
  '6e. A DETACHED HEAD CHANGES NOTHING — both directions still answer',
  `detached at a released commit: ${detachedOnReport.freshness.onReleaseLine}; detached at an ` +
    `unmerged one: ${detachedOffReport.freshness.onReleaseLine}. HEAD is not consulted: the ` +
    `question is whether the commit the STAMP names is reachable from the release ref, and a ` +
    `check that read HEAD would answer about the wrong commit entirely`
);

// ===========================================================================
// 7. THE RED DRIVE
// ===========================================================================

rule('7. AND EVERY ASSERTION ABOVE CAN FAIL — three mutations, three named reds');

/**
 * Run a section's central predicate against a mutated build and REQUIRE it to
 * fail. A mutation that leaves the predicate green has either not applied or
 * landed somewhere the assertion does not look — both of which mean the
 * assertion was never load-bearing.
 */
async function expectRed(label, mutantDir, tree, predicate, why) {
  const report = await reportFor(tree, mutantDir);
  const stillGreen = predicate(report);
  check(
    !stillGreen,
    `RED: ${label}`,
    stillGreen
      ? `THE MUTANT STILL PASSES. ${why} — so the assertion above is not measuring what its ` +
        `wording claims, and this run's green is worth nothing.`
      : `the mutant reads state=${report.freshness.state}, ` +
        `onReleaseLine=${JSON.stringify(report.freshness.onReleaseLine)}`
  );
  return report;
}

// M1. THE VERDICT IS INVERTED. `--is-ancestor` exiting 1 means "not an
// ancestor"; a reader that answered `true` there would report every build as
// released. This is the shape a copy-paste regression takes.
mutationVerdict: {
  const dir = mutate(
    'verdict-always-yes',
    'provenance.js',
    'if (ancestry.status === 1)\n        return { onReleaseLine: false, ...evidence, reason: null };',
    'if (ancestry.status === 1)\n        return { onReleaseLine: true, ...evidence, reason: null };'
  );
  if (!dir) break mutationVerdict;
  await expectRed(
    '§1\'s `onReleaseLine is false` goes red when the verdict is inverted',
    dir,
    off,
    (r) => r.freshness.onReleaseLine === false,
    'a build made from an unmerged branch still reads `false` with the `false` branch removed'
  );
}

// M2. THE PRE-KAN-592 STATE MACHINE, restored in two edits: the branch that
// sets `off-release-line` is disabled, and `current` stops requiring the
// release-line answer. The flag stays correct on the wire and the headline says
// `CURRENT` — which is not a synthetic breakage but THE INCIDENT ITSELF, and it
// is the reason this ticket asked for a qualifier on `freshness` rather than a
// fourth field. A response can carry the right answer and print a word that
// contradicts it, and the word is what gets read.
mutationHeadline: {
  const dir = mutate('headline-never-moves', [
    {
      file: 'provenance.js',
      find: 'else if (releaseLine.onReleaseLine === false) {',
      replace: 'else if (false) {'
    },
    {
      file: 'provenance.js',
      find:
        'else if (processIsCurrentBuild === true &&\n        sourcesNewerThanBuild === false &&\n' +
        '        releaseLine.onReleaseLine === true) {',
      replace:
        'else if (processIsCurrentBuild === true &&\n        sourcesNewerThanBuild === false) {'
    }
  ]);
  if (!dir) break mutationHeadline;
  const report = await expectRed(
    '§1\'s `freshness: OFF-RELEASE-LINE` headline goes red when the state stops moving',
    dir,
    off,
    (r) => r.freshness.state === 'off-release-line',
    'the state still reads `off-release-line` with the branch that sets it disabled'
  );
  check(
    report.freshness.onReleaseLine === false && report.freshness.state === 'current',
    '    and the mutant reproduces THE INCIDENT: the right answer under the word `current`',
    `onReleaseLine=${report.freshness.onReleaseLine} while state=${report.freshness.state}. ` +
      `That is a response carrying the correct fact and printing a headline that contradicts ` +
      `it — which is what a fourth green line under three others would have shipped`
  );
}

// M3. "CANNOT TELL" COLLAPSES INTO "CLEAN". Dropping the release-line conjunct
// from the `current` branch lets an unanswerable question read as CURRENT —
// the ticket's task 2, one layer down.
mutationUnknown: {
  const dir = mutate(
    'unknown-reads-current',
    'provenance.js',
    'else if (processIsCurrentBuild === true &&\n        sourcesNewerThanBuild === false &&\n        releaseLine.onReleaseLine === true) {',
    'else if (processIsCurrentBuild === true &&\n        sourcesNewerThanBuild === false) {'
  );
  if (!dir) break mutationUnknown;
  await expectRed(
    '§4\'s `the state is demoted to unknown` goes red when the conjunct is dropped',
    dir,
    noRef,
    (r) => r.freshness.state === 'unknown',
    'an offline tree with no candidate ref still reads `unknown` with the guard removed'
  );
}

// ---------------------------------------------------------------- the verdict

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
