#!/usr/bin/env node
// Live proof for KAN-181: what CrabCast does against ONE named herdr release,
// run out-of-place so the machine's own herdr is never replaced.
//
// WHAT FAILURE THIS WOULD CATCH: a README that claims a herdr RANGE — "0.6.x is
// supported" — when exactly one release in that range was ever run. That
// sentence was on the page for the length of this epic: every proof in the
// repository was produced on 0.6.4, 0.6.5 through 0.6.10 exist and are
// downloadable, and nobody had started a single pane on any of them. Nothing
// was false about the evidence; the claim was simply wider than it. This script
// is the mechanism that makes each version in the table a version somebody ran,
// and it goes red — by name, with the release in the failure line — when the
// release under test does not do what the table says it does.
//
// ---------------------------------------------------------------------------
// WHY IT TAKES THE RELEASE AS AN ARGUMENT
//
// A script hard-coded to 0.6.10 would answer the question this ticket asked and
// no other. The table has rows for 0.6.x, 0.7.x and 0.8; the next reader's
// question is about whatever upstream ships next. So the binary is a parameter
// and the EXPECTED VERDICT is a parameter, which is also what makes the check
// falsifiable in the only way that matters here: the same code path that
// reports 0.6.10 green reports 0.7.5 red when told to expect green, and the
// pull request shows both runs.
//
//   --expect supported     activation starts a real pane, herdr's own census
//                          agrees, the lifecycle completes, and the daemon
//                          emits NO version notice
//   --expect spawn-broken  activation FAILS at `herdr agent start` with
//                          `unknown option: --cwd`, NOTHING is spawned, the
//                          census stays empty, and the notice IS emitted
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT COVER. Read this before citing a green run.
//
// * ONE RELEASE PER RUN, AND ONLY THE ONES SOMEBODY RUNS. A green 0.6.10 says
//   nothing about 0.6.5–0.6.9. The README must name the releases this was run
//   on and nothing wider; that discipline is a human's, not this script's.
//
// * IT IS A LIFECYCLE, NOT THE PRODUCT. configure → activate → census → status
//   → tail → deactivate → census → forget, with a `shell` launcher. A release
//   that broke `pane send-text`, the preemption path, or the capacity gate
//   would pass here. The rest of scripts/ is what covers those, and every one
//   of them runs against the herdr on PATH — which on this machine is 0.6.4.
//   So: THIS script is the only thing that has ever run any other release, and
//   what it proves for that release is exactly the sequence below.
//
// * IT SUPPLIES ITS OWN HERDR. The binary is downloaded by a human and named on
//   the command line, so this does not test that a READER following the
//   README's install block ends up with the same bytes. What covers that is the
//   URL pattern in the block being the one this script was pointed at — stated
//   in the PR with the curl that produced it, and re-runnable by the reviewer.
//   Nobody automates it; there is no fixture for "GitHub still serves this".
//
// * THE LIVE FLEET IS EVIDENCE-BY-ABSENCE. Section 6 asserts that no pane named
//   for this probe exists in the DEFAULT herdr's census at exit. That is a
//   check on this script's isolation, not a guarantee: a release that damaged
//   the live server some other way would not be seen here.
//
// * THE PANE-HANDLE JOIN IS NOW EXERCISED (§4b, KAN-386) — ON THE `supported`
//   BRANCH ONLY, AND ONLY THE HERDR SIDE OF IT. Until 2026-08-14 this bullet
//   said the opposite, and it was the sharpest gap in the file: the cost
//   attribution reads `HERDR_PANE_ID` — a `p_NNN` token — off a process and
//   calls `herdr pane get` with it, `herdr pane --help` documents that
//   parameter as `<pane_id>`, which that token is not, and a release that
//   stopped accepting the form passed every other section green while
//   `paneNameForHandle` returned null for every tree, all of them were
//   classified `foreign`, and the charged sample dropped to zero —
//   indistinguishable from a machine running none of our agents. §4b now reads
//   the handle out of a real process inside the pane this run created and
//   requires `pane get` to resolve it to the name CrabCast minted, with a
//   mutated-handle control beside it. Three things it still does not cover:
//     - `--expect spawn-broken` runs skip it entirely (no pane exists to read),
//       so a green on that branch is not evidence about the join;
//     - it makes the `pane get` subprocess call itself rather than routing
//       through `HerdrBridge.paneNameForHandle`. That the DAEMON makes this
//       exact call is covered by `verify-agent-cost-attribution-live.mjs`,
//       which runs the bridge for real — but against the herdr on PATH, which
//       is 0.6.4. So neither script runs OUR code against the release under
//       test, and that hole is between them rather than inside either;
//     - it says nothing about the `p_NNN` form being documented. It is not
//       (docs/herdr-pane-handle-join.md §2.7); this pins the behaviour, not
//       the contract, which is why the ask to herdr's maintainer stands.
//
// ---------------------------------------------------------------------------
// ISOLATION — the hazard this script exists inside of
//
// The herdr on this machine's PATH is running a live fleet. Overwriting it to
// test another release would take that fleet down, and 0.7+ is a known break,
// so the failure would be immediate and total. Nothing here writes to
// ~/.local/bin. The release under test is symlinked into a scratch bin
// directory that is first on the daemon's PATH; the server it talks to is a
// private one on its own HERDR_SOCKET_PATH, with its own $HOME and XDG dirs;
// the daemon under test has its own dataDir, socket and registry. Section 1
// prints `herdr --version` from INSIDE and OUTSIDE that environment, because a
// version test that silently ran the old binary proves nothing.
//
// Usage:
//   npm run build
//   curl -fsSL -o /tmp/herdr-0.6.10 \
//     https://github.com/herdrdev/herdr/releases/download/v0.6.10/herdr-linux-x86_64
//   chmod +x /tmp/herdr-0.6.10
//   node scripts/verify-herdr-release.mjs /tmp/herdr-0.6.10 --expect supported
//
// Exit code 0 means every check passed for the verdict that was asked for.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && ['--expect', '--dist'].includes(argv[i - 1])));

const EXPECTATIONS = new Set(['supported', 'spawn-broken']);
const herdrArg = positional[0];
const expect = flag('--expect');
const distDir = path.resolve(flag('--dist', path.join(repoRoot, 'dist')));

if (!herdrArg || !EXPECTATIONS.has(expect)) {
  console.error(
    'usage: node scripts/verify-herdr-release.mjs <herdr-binary> --expect supported|spawn-broken [--dist <dir>]'
  );
  process.exit(2);
}

const herdrBin = path.resolve(herdrArg);
if (!fs.existsSync(herdrBin)) {
  console.error(`${herdrBin} does not exist. Download the release asset first — see the header.`);
  process.exit(2);
}
if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`${distDir}/daemon.js is missing — run \`npm run build\` first.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

let failures = 0;
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The scratch world.
// ---------------------------------------------------------------------------

// Socket paths must fit sockaddr_un.sun_path (~108 bytes) — /tmp, not TMPDIR.
const scratch = fs.realpathSync(fs.mkdtempSync('/tmp/kan181-'));
const fakeHome = path.join(scratch, 'home');
const stubBin = path.join(fakeHome, '.local', 'bin');
const herdrState = path.join(scratch, 'herdr-state');
const herdrSocket = path.join(scratch, 'h.sock');
fs.mkdirSync(stubBin, { recursive: true });
fs.mkdirSync(herdrState, { recursive: true });
fs.symlinkSync(herdrBin, path.join(stubBin, 'herdr'));

const dataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const configPath = path.join(fakeHome, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const isolatedEnv = {
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${stubBin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_CONFIG: configPath,
  HERDR_SOCKET_PATH: herdrSocket,
  XDG_CONFIG_HOME: path.join(herdrState, 'config'),
  XDG_STATE_HOME: path.join(herdrState, 'state')
};
fs.mkdirSync(isolatedEnv.XDG_CONFIG_HOME, { recursive: true });
fs.mkdirSync(isolatedEnv.XDG_STATE_HOME, { recursive: true });

/** The probe's directory, created by this script because CrabCast never does. */
const probeDir = path.join(fakeHome, 'owned', 'kan181probe');
fs.mkdirSync(probeDir, { recursive: true });

let daemon;
let herdrServer;
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  daemon?.kill('SIGKILL');
  // Ask the private server to stop through its own socket before killing the
  // process we spawned: a server left holding a socket in a directory that is
  // about to vanish is how a scratch run leaves litter on a real machine.
  try {
    execFileSync(path.join(stubBin, 'herdr'), ['server', 'stop'], {
      env: { ...process.env, ...isolatedEnv }, timeout: 10_000, stdio: 'ignore'
    });
  } catch {}
  herdrServer?.kill('SIGKILL');
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}

/** The release under test, through the scratch environment. */
const herdr = (...args) =>
  spawnSync('herdr', args, {
    env: { ...process.env, ...isolatedEnv }, encoding: 'utf8', timeout: 30_000
  });

/** The CLI, exactly as a reader would run it, from inside the probe directory. */
function crabcast(...args) {
  const r = spawnSync(process.execPath, [path.join(distDir, 'cli.js'), ...args], {
    cwd: probeDir,
    env: { ...process.env, ...isolatedEnv },
    encoding: 'utf8',
    timeout: 180_000
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  console.log(`\n  $ crabcast ${args.join(' ')}    [exit ${r.status}]`);
  for (const line of text.replace(/\n$/, '').split('\n')) console.log(`  | ${line}`);
  return { code: r.status, text };
}

/** herdr's own census, which is the ground truth this script trusts. */
function census() {
  const r = herdr('agent', 'list');
  if (r.status !== 0) return { ok: false, agents: [] };
  try {
    return { ok: true, agents: JSON.parse(r.stdout).result?.agents ?? [] };
  } catch {
    return { ok: false, agents: [] };
  }
}

const ours = (agents) => agents.filter((a) => String(a.name ?? '').startsWith('crabcast-kan181probe-'));

// ---------------------------------------------------------------------------
// Finding a process INSIDE the pane this run created — the input to §4b.
//
// ⚠ THE HAZARD, AND IT IS NOT HYPOTHETICAL. The machine this runs on is a live
// fleet, and this script is itself launched from one of its panes. So the
// obvious selector — "any process carrying THIS run's private
// HERDR_SOCKET_PATH, that also has a HERDR_PANE_ID" — is WRONG, and it is wrong
// in the direction that measures the other machine. Measured 2026-08-13 while
// writing this, four processes matched it:
//
//     227228  herdr   HERDR_PANE_ID=p_300   <- the private SERVER we spawned
//     227245  node    (no handle)
//     227311  bash    HERDR_PANE_ID=p_1     <- the pane under test. The one.
//     227316  herdr   (no handle)
//
// `p_300` is a LIVE pane: the server inherited it from the pane this script was
// run in, because we spawned it and set HERDR_SOCKET_PATH in its environment
// without clearing what it already carried. A selector that took the first
// match would have read a handle belonging to the live fleet and asked the
// PRIVATE server to resolve it — a red that says nothing about the release, or,
// on some other arrangement of pids, a green measured off the wrong population.
//
// So the walk is DOWNWARD from the server we started, and the socket-path match
// is kept as a second gate rather than the first. Two properties follow, and
// both matter: only processes descended from a server THIS run spawned are
// candidates, and `/proc/<pid>/environ` — the sensitive read — is opened for
// those and for nothing else. The live fleet's environs are never read.
//
// ⚠ AND THE WALK ALONE IS STILL NOT ENOUGH, which is the second thing the red
// drive found and the reason there are two more gates below. The server's OWN
// CHILDREN inherit the server's environment, `p_300` and all. Caught on
// 2026-08-14, twice in three runs:
//
//     244105/bash p_1     <- the pane. What we want.
//     244174/curl p_300   <- a child the private server spawned itself
//
// The `curl` is a descendant, it carries the private socket path, and it
// carries a LIVE pane's handle. Both earlier gates pass it. It is not an
// exotic race: it reproduces, and it would have put a live handle into the
// assertion. So two more, either of which alone would have caught it:
//
//   * ANYTHING CARRYING THE SERVER'S OWN HANDLE IS REJECTED. That value was
//     inherited from the pane this script was launched in; a process inside
//     the pane under test cannot legitimately carry it. (If the private server
//     ever minted a handle equal to the one it inherited, this would reject the
//     real pane too — and produce a loud "none found" red, not a quiet pass.)
//   * AND THE PROCESS MUST BE SITTING INSIDE THIS RUN'S SCRATCH TREE. The pane
//     was created with `--cwd` into it; nothing else on the machine is in it.
//
// Rejected candidates are PRINTED with the reason. The next surprise here will
// be some third process nobody predicted, and a selector that silently drops
// things teaches you nothing when that happens.
// ---------------------------------------------------------------------------

/**
 * Every process as `pid -> { comm, ppid }`, from `/proc/<pid>/stat`.
 *
 * `comm` is unquoted and may contain spaces and parentheses, so the fields
 * after it are taken from the LAST `)` rather than by splitting the line.
 */
function processTable() {
  const table = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'latin1');
    } catch {
      continue; // exited between readdir and read; ordinary
    }
    const close = stat.lastIndexOf(')');
    if (close === -1) continue;
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const ppid = Number(stat.slice(close + 2).split(' ')[1]);
    if (Number.isFinite(ppid)) table.set(Number(name), { comm, ppid });
  }
  return table;
}

/** Every descendant of `root`, excluding `root` itself. */
function descendantsOf(table, root) {
  const children = new Map();
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The pane handles carried by processes inside this run's own panes — read the
 * same way `agent-cost.ts` reads them, out of `/proc/<pid>/environ`, because
 * that is the leg of the join being pinned. Nothing here is supplied by this
 * script: the release under test put the value there.
 */
function handlesInOurPanes() {
  const table = processTable();

  // The handle the SERVER itself carries — inherited from the pane this script
  // was launched in, and therefore a live one. See the header.
  let serverHandle = '';
  try {
    const own = fs.readFileSync(`/proc/${herdrServer.pid}/environ`, 'latin1')
      .split('\0')
      .find((e) => e.startsWith('HERDR_PANE_ID='));
    if (own) serverHandle = own.slice('HERDR_PANE_ID='.length);
  } catch {}

  const kept = [];
  const rejected = [];
  const walked = descendantsOf(table, herdrServer.pid);
  for (const pid of walked) {
    let entries;
    try {
      entries = fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0');
    } catch {
      continue;
    }
    // Second gate: it must be talking to OUR server, not to a default socket
    // inherited from somewhere else.
    if (!entries.includes(`HERDR_SOCKET_PATH=${herdrSocket}`)) continue;
    const entry = entries.find((e) => e.startsWith('HERDR_PANE_ID='));
    const handle = entry ? entry.slice('HERDR_PANE_ID='.length) : '';
    if (!handle) continue;

    const comm = table.get(pid)?.comm ?? '?';
    let cwd = '';
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}

    if (serverHandle && handle === serverHandle) {
      rejected.push({ pid, comm, handle, why: `carries the SERVER's own inherited handle ${serverHandle}` });
      continue;
    }
    if (!cwd || !cwd.startsWith(`${scratch}/`)) {
      rejected.push({ pid, comm, handle, why: `sits at ${cwd || '(cwd unreadable)'}, outside this run's scratch tree` });
      continue;
    }
    kept.push({ pid, comm, handle, cwd });
  }
  return { kept, rejected, serverHandle, walked: walked.length };
}

/**
 * `herdr pane get <target>`, as a resolved-or-not answer.
 *
 * BOTH STREAMS, and that is not a detail: herdr puts its error JSON on STDERR
 * with a non-zero exit. A reader of stdout alone turns `pane_not_found` and
 * "the command said nothing" into the same empty string, and the control below
 * — a deliberately mutated handle — then scores as RESOLVED. Two drafts of the
 * KAN-385 survey died on exactly that; docs/herdr-pane-handle-join.md §2.5
 * records it.
 *
 * A record-or-error rather than a bare name, so "resolved to a pane with no
 * label" cannot collapse into "did not resolve".
 */
function resolvePaneHandle(target) {
  const r = herdr('pane', 'get', target);
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const start = raw.indexOf('{');
  let parsed = null;
  if (start !== -1) {
    try { parsed = JSON.parse(raw.slice(start)); } catch {}
  }
  const pane = parsed?.result?.pane;
  if (pane) return { ok: true, label: typeof pane.label === 'string' ? pane.label : '', pane };
  return { ok: false, label: '', why: parsed?.error?.code ?? `no answer (exit ${r.status})` };
}

// ===========================================================================
rule(`0. What is under test`);
// ===========================================================================

console.log(`  release binary:  ${herdrBin}`);
console.log(`  expected verdict: ${expect}`);
console.log(`  dist:            ${distDir}`);
console.log(`  scratch:         ${scratch}\n`);

// ===========================================================================
rule('1. The release under test is the one that ran, and the live herdr is not it');
// ===========================================================================

/**
 * A version test that silently ran the machine's own binary proves nothing, so
 * both sides are read and printed: the herdr the CALLER has on PATH, and the
 * herdr the daemon's environment resolves.
 *
 * What must differ is the FILE, not the version string. Requiring different
 * versions would be the tighter-looking rule and it would forbid a legitimate
 * run — re-downloading the pinned release from the README's own URL and
 * checking that what a reader gets still works is exactly a thing to want, and
 * it reports the same version by construction. So the guard is on the path: the
 * binary under test must not BE the installed one. Where the two versions match,
 * that is printed as a note rather than a pass, because a same-version run is
 * evidence about an install route and not about a release.
 */
const outside = spawnSync('herdr', ['--version'], { encoding: 'utf8', timeout: 30_000 });
const outsideVersion = (outside.stdout ?? '').trim() || '(no herdr on the caller’s PATH)';
const insideVersion = (herdr('--version').stdout ?? '').trim();
const directVersion = execFileSync(herdrBin, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();

let installedPath = '';
try {
  installedPath = fs.realpathSync(
    execFileSync('which', ['herdr'], { encoding: 'utf8', timeout: 30_000 }).trim()
  );
} catch {}

console.log(`  outside this script's environment:    ${outsideVersion}${installedPath ? `  (${installedPath})` : ''}`);
console.log(`  the binary named on the command line: ${directVersion}  (${fs.realpathSync(herdrBin)})`);
console.log(`  what \`herdr\` resolves to INSIDE it:   ${insideVersion}\n`);

check(insideVersion.length > 0, 'the release under test answers `herdr --version`', insideVersion);
check(insideVersion === directVersion,
  'the PATH the daemon will use resolves to that same binary',
  insideVersion === directVersion ? '' : `inside says ${JSON.stringify(insideVersion)}`);
check(!installedPath || installedPath !== fs.realpathSync(herdrBin),
  'and it is NOT the file the caller has installed',
  installedPath && installedPath === fs.realpathSync(herdrBin)
    ? 'they are the same file — this run would be a re-test of the installed herdr'
    : installedPath ? `installed: ${installedPath}` : 'nothing is installed to confuse it with');
if (insideVersion === outsideVersion) {
  console.log(
    `  ....  NOTE: the release under test reports the same version as the installed one.\n` +
    `        This is a different FILE (checked above), so the run is real — but what it is\n` +
    `        evidence for is an install route, not a release. Compare checksums if you need\n` +
    `        to say the two are the same bytes; this script does not.`
  );
}

const RELEASE = insideVersion.replace(/^herdr\s+/, '');

// ===========================================================================
rule('2. A private herdr server, so no pane of this run can reach the live one');
// ===========================================================================

const already = herdr('pane', 'list');
if (!check(already.status !== 0,
  `nothing is already answering on ${herdrSocket}`,
  already.status === 0 ? 'something is — refusing to run' : '')) {
  process.exit(1);
}

herdrServer = spawn(path.join(stubBin, 'herdr'), ['server'], {
  env: { ...process.env, ...isolatedEnv }, detached: true, stdio: 'ignore'
});
let up = false;
for (let i = 0; i < 30 && !up; i += 1) {
  if (herdr('pane', 'list').status === 0) up = true;
  else await sleep(500);
}
if (!check(up, `a private herdr ${RELEASE} server came up on its own socket`,
  up ? `pid ${herdrServer.pid}` : 'it never answered. NOTHING VERIFIED.')) {
  process.exit(2);
}

const before = census();
check(before.ok && before.agents.length === 0,
  'its census starts empty — this run owns every pane it will see',
  `${before.agents.length} agent(s)`);

// ===========================================================================
rule('3. A real daemon, from dist/, against that server');
// ===========================================================================

daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: isolatedEnv, stdio: ['ignore', 'ignore', 'inherit']
});
const socketPath = path.join(dataDir, 'crabcast.sock');
for (let i = 0; i < 80 && !fs.existsSync(socketPath); i += 1) await sleep(250);
if (!check(fs.existsSync(socketPath), 'the daemon claimed its socket', socketPath)) process.exit(1);

// ===========================================================================
rule(`4. The lifecycle, against herdr ${RELEASE}`);
// ===========================================================================

const configure = crabcast('configure', probeDir, '--priority', '1', '--launcher', 'shell');
check(configure.code === 0, '`configure` succeeded', `exit ${configure.code}`);

const activate = crabcast('activate', probeDir);
const afterActivate = census();
const live = ours(afterActivate.agents);

/**
 * The version notice the daemon computes at startup and rides out on the first
 * response. Its presence is a claim about the band this release is in, so it is
 * asserted rather than glanced at.
 */
const notice = [configure.text, activate.text]
  .flatMap((t) => t.split('\n'))
  .find((l) => /^crabcast: note: herdr /.test(l)) ?? '';

if (expect === 'supported') {
  check(activate.code === 0, '`activate` succeeded', `exit ${activate.code}`);
  check(/^\s*verified:\s+true/m.test(activate.text),
    'and it answered `verified: true` — the pane was confirmed to exist, not assumed');
  check(live.length === 1,
    "herdr's OWN census shows exactly one pane of ours",
    live.length ? live.map((a) => `${a.name} (${a.pane_id})`).join(', ') : 'none — nothing was started');
  check(live.length === 1 && live[0].cwd === probeDir,
    'and it is in the directory that was configured',
    live[0] ? live[0].cwd : '');
  check(!notice,
    'the daemon emitted NO version notice for this release',
    notice ? `it emitted: ${notice.trim()}` : '');

  const status = crabcast('status', probeDir);
  check(status.code === 0 && /^\s*state:\s+running/m.test(status.text), '`status` reports it running');
  check(Boolean(live[0]) && status.text.includes(live[0].pane_id),
    "and names the same pane id herdr does",
    live[0] ? live[0].pane_id : '');

  // =========================================================================
  rule(`4b. The pane-handle join, against herdr ${RELEASE} (KAN-386)`);
  // =========================================================================

  /**
   * THE ONE CHECK IN THIS FILE THAT IS NOT ABOUT THE LIFECYCLE, and the reason
   * it is here is that its failure is SILENT. `src/agent-cost.ts` attributes
   * CPU to an agent by reading `HERDR_PANE_ID` off a process and calling
   * `herdr pane get` with it (`paneNameForHandle`, src/herdr.ts). A release
   * that stopped resolving that form breaks nothing a user can see: every tree
   * resolves to null, every tree is classified `foreign`, the charged sample
   * goes to zero, and the fleet reads as though none of our agents are
   * running. Every other section of this script would still be green — the
   * lifecycle never makes that call.
   *
   * THE HANDLE IS NOT SUPPLIED BY THIS SCRIPT. It is read out of the environ
   * of a real process inside the pane the release under test just created, so
   * this tests that the value ARRIVES as well as that it resolves. A proof
   * that constructs its own input has not tested the input.
   */
  const { kept: inPanes, rejected, serverHandle, walked } = handlesInOurPanes();
  const expectedLabel = live[0]?.name ?? '';
  const observed = inPanes[0];

  console.log(
    `  processes inside this run's panes carrying a handle: ` +
    (inPanes.length
      ? inPanes.map((p) => `${p.pid}/${p.comm} ${p.handle}`).join(', ')
      : '(none)')
  );
  console.log(`  the private server's own inherited handle (excluded): ${serverHandle || '(it carries none)'}`);
  for (const r of rejected) console.log(`  rejected  ${r.pid}/${r.comm} ${r.handle} — ${r.why}`);
  if (observed && live[0]) {
    console.log(
      `  the two identifiers on the same pane:  environ handle ${observed.handle}  |  ` +
      `published pane_id ${live[0].pane_id}` +
      (observed.handle === live[0].pane_id
        ? '  — NOTE: they are the SAME on this release, so this run cannot distinguish\n' +
          '        "resolves the environment form" from "resolves the published form".'
        : '  — different forms, which is what makes this check load-bearing.')
    );
  }

  check(Boolean(observed),
    'a process inside the pane under test carries a handle in its environment',
    observed
      ? `pid ${observed.pid} (${observed.comm}) carries HERDR_PANE_ID=${observed.handle}`
      : walked === 0
        // Told apart deliberately. "The release stopped setting the handle" and
        // "this script lost track of the server it started" produce the same
        // empty answer, and only one of them is a finding about the release. A
        // future release that daemonises differently — forking and letting the
        // pid we hold exit — would land here, and a reader must not read it as
        // a broken join.
        ? `none found, AND the server pid ${herdrServer.pid} has no live descendants at all. ` +
          'That is more likely this script having lost the server than the release having lost ' +
          'the handle: DO NOT read it as a verdict on the join until the walk is fixed.'
        : `none found among ${walked} descendant(s) of the server. The release put no handle ` +
          'in the pane, or the pane has no process. EITHER WAY THE JOIN IS BROKEN: ' +
          'agent-cost.ts reads exactly this.');

  // NOT "exactly one process". A pane's shell forks — this went red once during
  // the KAN-386 red drive with two candidates on a run that was working
  // perfectly — and every child inherits the same handle, so a count is the
  // wrong invariant and a flaky one. AGREEMENT is the right invariant, and it
  // is also the stronger one: this run has exactly one pane, so two DIFFERENT
  // handles would mean the walk had reached a process outside it — which is
  // precisely the hazard the selector above exists to prevent, and the shape it
  // would take if it ever failed.
  const distinct = [...new Set(inPanes.map((p) => p.handle))];
  check(distinct.length === 1 && Boolean(expectedLabel),
    'every process inside our panes agrees on ONE handle, and the census names one pane',
    distinct.length > 1
      ? `${distinct.length} DIFFERENT handles: ${inPanes.map((p) => `${p.pid}/${p.comm}=${p.handle}`).join(', ')}` +
        ' — the walk reached a process outside the pane under test'
      : distinct.length === 0
        ? 'no process inside our panes carries a handle at all — nothing to agree on'
        : expectedLabel
          ? `${inPanes.length} process(es), handle ${distinct[0]}, pane ${expectedLabel}`
          : `handle ${distinct[0]}, but the census named no pane of ours`);

  const resolved = observed ? resolvePaneHandle(observed.handle) : { ok: false, label: '', why: 'no handle to resolve' };
  check(resolved.ok && Boolean(expectedLabel) && resolved.label === expectedLabel,
    '`herdr pane get <handle>` resolves it to the pane CrabCast named',
    resolved.ok
      ? `${observed.handle} -> ${JSON.stringify(resolved.label)}` +
        (resolved.label === expectedLabel ? '' : `, expected ${JSON.stringify(expectedLabel)}`)
      : `${observed ? observed.handle : '(none)'} -> UNRESOLVED (${resolved.why}). ` +
        'THE COST ATTRIBUTION WOULD CHARGE NOTHING ON THIS RELEASE.');

  // CONTROL. Without it, the check above passes on a `pane get` that resolves
  // ANY target to the only pane it has — which is the same shape as the
  // finding we want, and would read as green. One digit appended is the
  // mutation KAN-385 measured (`pane_not_found`, 7/7).
  const mutated = observed ? `${observed.handle}1` : 'p_definitely-not-a-pane';
  const control = resolvePaneHandle(mutated);
  check(!control.ok,
    'CONTROL: a mutated handle does NOT resolve, so the pass above discriminates',
    control.ok
      ? `${mutated} resolved to ${JSON.stringify(control.label)} — this resolver answers anything, ` +
        'and the check above is worth nothing'
      : `${mutated} -> UNRESOLVED (${control.why})`);

  const tail = crabcast('tail', probeDir, '--lines', '5');
  check(tail.code === 0, '`tail` read the pane back', `exit ${tail.code}`);

  const deactivate = crabcast('deactivate', probeDir);
  check(deactivate.code === 0, '`deactivate` succeeded', `exit ${deactivate.code}`);
  const afterDeactivate = census();
  check(ours(afterDeactivate.agents).length === 0,
    "and herdr's census no longer shows it — the pane really closed",
    `${ours(afterDeactivate.agents).length} still there`);

  const forget = crabcast('forget', probeDir);
  check(forget.code === 0, '`forget` succeeded', `exit ${forget.code}`);
} else {
  // spawn-broken: the 0.7 redesign. What is asserted is not merely that it
  // failed, but that it failed AT HERDR, named the flag, and left nothing
  // behind — a half-spawned pane reported as a failure would be a worse defect
  // than the break itself.
  check(activate.code !== 0, '`activate` FAILED, as this band predicts', `exit ${activate.code}`);
  check(/unknown option: --cwd/.test(activate.text),
    "and failed at `herdr agent start`, naming the flag: `unknown option: --cwd`");
  check(/started:\s+false — NOTHING was spawned/.test(activate.text),
    'and said so: `started: false — NOTHING was spawned`');
  check(live.length === 0,
    "herdr's own census is empty — nothing was half-started",
    live.length ? live.map((a) => a.name).join(', ') : '');
  check(Boolean(notice),
    'the daemon DID emit a version notice for this release',
    notice ? notice.trim().slice(0, 120) + '…' : 'it emitted none — a reader gets the raw flag error and no diagnosis');

  // §4b is UNREACHABLE on this branch and is deliberately not run. The
  // pane-handle join needs a pane, and the premise of `spawn-broken` is that
  // nothing was spawned — so there is no process to read a handle out of. A
  // green `--expect spawn-broken` therefore says NOTHING about whether this
  // release still resolves `p_NNN`; only a `--expect supported` run does.
  console.log(
    '\n  ....  §4b (the pane-handle join) NOT RUN: it needs a pane, and this branch' +
    '\n        asserts that none was created. A green run here is not evidence about' +
    '\n        the join — see the header.'
  );

  // `deactivate` first, and unasserted: against a genuinely spawn-broken
  // release it is a no-op that answers "was not running". It is here for the
  // case this section goes RED — a release that DID start a pane while being
  // told it could not — so that the run still stands its own pane down instead
  // of leaving one behind for the scratch teardown to kill.
  crabcast('deactivate', probeDir);
  const forget = crabcast('forget', probeDir);
  check(forget.code === 0, '`forget` cleans up the record it could not activate', `exit ${forget.code}`);
}

// ===========================================================================
rule('5. The machine, as it was found');
// ===========================================================================

const finalCensus = census();
check(ours(finalCensus.agents).length === 0,
  'no pane of this run is left in the private census',
  ours(finalCensus.agents).map((a) => a.name).join(', '));

// Evidence by absence, and only that: the live server is asked whether it can
// see anything named for this probe. It cannot, because this run never spoke to
// it — which is the claim, stated as something checked rather than intended.
const liveCensus = spawnSync('herdr', ['agent', 'list'], { encoding: 'utf8', timeout: 30_000 });
if (liveCensus.status === 0) {
  let liveAgents = [];
  try { liveAgents = JSON.parse(liveCensus.stdout).result?.agents ?? []; } catch {}
  check(ours(liveAgents).length === 0,
    `the LIVE herdr (${outsideVersion}) has no pane from this run`,
    `${liveAgents.length} pane(s) there, none of them ours`);
} else {
  console.log('  ....  no live herdr answered on the default socket; nothing to compare against');
}

// The isolation named in the header, asserted rather than described: the only
// `herdr` this run put on a PATH is a symlink inside the scratch tree, pointing
// at the binary the caller named. No install location is written to anywhere in
// this file — which is a property of the source a reader can check, and this is
// the line that says where to look.
const installedHere = fs.realpathSync(path.join(stubBin, 'herdr'));
check(installedHere === fs.realpathSync(herdrBin) && path.join(stubBin, 'herdr').startsWith(scratch),
  'the only herdr this run installed anywhere is the scratch symlink',
  `${path.join(stubBin, 'herdr')} → ${installedHere}`);

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(78)}`);
console.log(
  failures
    ? `\n${failures} CHECK(S) FAILED for herdr ${RELEASE} against the '${expect}' verdict.\n` +
      `The README must not claim ${RELEASE} behaves as '${expect}' while this is red.`
    : `\nALL CHECKS PASSED — herdr ${RELEASE} behaves as '${expect}'.\n` +
      `That is a statement about ${RELEASE} and about no other release, including the ones\n` +
      `next to it in the same minor line.`
);
process.exit(failures ? 1 : 0);
