#!/usr/bin/env node
// Live proof for KAN-227: `daemon_status` is REACHABLE FROM MCP, and what an
// MCP caller gets is the same answer the socket gives — driven over real MCP
// stdio against a really-running daemon.
//
// WHAT FAILURE THIS WOULD CATCH: the tenth tool not being registered at all,
// which is the defect KAN-227 was filed about and the one an in-process test
// cannot see. `daemon_status` had been on the socket and the CLI since before
// the MCP server existed, and `src/mcp.ts` registered nine tools that did not
// include it. `build` and `freshness` — the whole of "which CrabCast is
// running", which by construction cannot be answered from the filesystem —
// were therefore reachable from every surface but the one an MCP consumer has.
// Nothing was broken; a capability was unreachable, which is why nothing went
// red. It would also catch the tool being registered and answering something
// of its own rather than the daemon's answer (§3), and answering something
// STALE rather than the daemon's answer NOW (§4).
//
// ---------------------------------------------------------------------------
// WHY REGISTRATION IS THE LAYER, AND WHY THAT DICTATES THE SHAPE
//
// This slice is about whether a tool EXISTS on the wire. An in-process
// assertion — importing the module, inspecting an array of tool definitions —
// would prove nothing here, because "registered" is a claim about what a client
// receives from `tools/list` over a transport, not about what a variable holds.
// KAN-200 and KAN-208 were both a value correctly typed and permanently wrong
// because nothing read it over a real transport. So this script speaks
// newline-delimited JSON-RPC 2.0 to a real `dist/mcp.js` over real stdio, with
// a hand-rolled client: the point is that the server speaks the wire protocol
// to ANY client, not that two copies of the SDK agree with themselves.
//
// THE ASSERTION THAT MAKES IT A MIRROR RATHER THAN A COPY is §3: the MCP
// payload is compared, field for field, against what the RAW SOCKET returns for
// the same action, in the same second, from the same daemon. A tool that
// subsetted, renamed or reshaped anything would pass "the tool answers" and
// fail this. Two ways to reach one `daemon_status` is the product; a second
// `daemon_status` computed elsewhere is the failure, and the difference between
// them is only visible in a comparison.
//
// AND §4 IS WHY §3 IS NOT ENOUGH ON ITS OWN. Ask what would have to be true for
// §3 to pass while the feature is broken: a payload built independently but
// plausibly — cached at boot, or recomputed by the tool layer from the same
// inputs — agrees with the socket on a quiescent tree and goes on agreeing
// forever. So §4 CHANGES THE ANSWER underneath a running daemon (rebuilds its
// `dist/`, which is the real KAN-122 situation) and requires that both surfaces
// move together to the new answer. A cached mirror passes §3 and fails §4.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// A proof that supplies its own input has not tested that the input arrives, so
// here is the line in this one. This script CONSTRUCTS the fixture tree (a copy
// of `dist/` and `src/` in a scratch git repo, stamped by the real
// `scripts/stamp-build.mjs`) and, in §4, constructs the rebuild. It does NOT
// construct anything it asserts on: the tool list comes from the real server's
// `tools/list`, the payloads come from a real daemon computing them, and the
// registration under test is read off the wire rather than arranged. The
// fixture decides WHICH build the daemon is running; it does not decide whether
// the tool exists or what it answers.
//
// WHAT NOBODY HERE COVERS, named rather than left to be inferred:
//
//   - THE BEHAVIOUR of `build` and `freshness` — that they report the right
//     thing for a tree with no git, a stamp from a future format version, a
//     build rewritten without re-stamping. That is
//     `verify-daemon-provenance.mjs`, which owns those cases over the socket
//     and does not touch MCP. This script asserts those blocks ARRIVE and that
//     the two surfaces agree about them; it re-checks none of their semantics.
//   - THE EXACTNESS OF THE TOOL COUNT in the other direction — that there are
//     ten and no eleventh. `verify-mcp-tools.mjs` §2 holds the full list and
//     fails on any name that is not on it. This script asserts the tenth is
//     present and does not enumerate the rest.
//
//   Neither of those scripts covers this one's half either, and the hole
//   between all three is the one KAN-227 was found in: each was honest and the
//   gap was BETWEEN them. Nothing anywhere had asked whether a capability the
//   socket had was reachable from MCP at all. That question now has an owner,
//   and this file is it.
//
// It needs no herdr and no network: `daemon_status` touches neither. Each
// daemon gets a scratch $HOME and its own dataDir.
//
// Usage:
//   npm run build
//   node scripts/verify-daemon-status-over-mcp.mjs
//
// Exits non-zero on any failure, so a reviewer can re-run it against the PR
// head. It is meant to be ABLE to fail: remove the `crabcast_daemon_status`
// registration from `src/mcp.ts` and §1 goes red on a missing tool while §2
// goes red on a JSON-RPC -32601; make the tool answer anything of its own and
// §3 goes red naming the fields that differ.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const repoDist = path.join(repoRoot, 'dist');
const repoSrc = path.join(repoRoot, 'src');
const stamperJs = path.join(scriptDir, 'stamp-build.mjs');

const TOOL = 'crabcast_daemon_status';
const ACTION = 'daemon_status';

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
/**
 * `JSON.stringify(undefined)` returns `undefined` — the value, not the string —
 * so the `String(...)` here is load-bearing rather than defensive noise. Without
 * it this helper throws on an ABSENT field, which is the one case it is most
 * needed for: §3 calls it to print the fields that differ, and a mirror that
 * DROPPED a field is exactly how one comes to differ. That crashed the failure
 * report before it could name the field, turning a legible red into a stack
 * trace — found by deliberately breaking the mirror and watching this go.
 */
const show = (label, value) =>
  console.log(`   ${label}\n${String(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    .replace(/^/gm, '     ')}`);

let failures = 0;
/**
 * `detail` is DIAGNOSIS and prints only on FAIL. Every detail string in this
 * file is written to explain a failure ("these fields disagree: …"), and
 * printing those beside a PASS produces lines that contradict their own verdict
 * — a green check reading "nothing was compared at all" is worse than no
 * detail, because it is the exact sentence a reader skimming for problems would
 * stop on. Evidence for the passing case is printed by `show` and the
 * `console.log`s above each check, where it belongs.
 */
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

// A setup guard, NOT a verdict: it exits before any claim has been made, which
// is a different thing from a claim that failed.
if (!fs.existsSync(path.join(repoDist, 'mcp.js'))) {
  console.error(
    'dist/mcp.js not found — run `npm run build` first. This script drives the REAL compiled\n' +
    'MCP server over stdio; there is nothing here it could assert against a source tree.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------- the scratch

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan227-'));
const fakeHome = path.join(scratch, 'h');
fs.mkdirSync(fakeHome, { recursive: true });
// The fixture dist is an ES module tree with no package.json beside it; without
// this node reads every copied `.js` as CommonJS and refuses it.
fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const children = [];
const daemonPids = [];
function cleanup() {
  for (const c of children) { try { c.kill(); } catch {} }
  for (const pid of daemonPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const ENV = {
  ...process.env,
  HOME: fakeHome,
  // No herdr, and no chance of rediscovering an installed one. `daemon_status`
  // needs neither, and a herdr version notice riding the first response would
  // be a variable this script has no reason to carry.
  PATH: '/usr/local/bin:/usr/bin:/bin',
  CRABCAST_CONFIG: undefined
};

// ----------------------------------------------------------- the fixture tree
//
// A real git repo whose `dist/` is stamped by the real stamper, so `build`
// carries a real commit rather than a null this script would then be unable to
// tell from a mirror that dropped the field.

const treeDir = path.join(scratch, 'tree');
const treeDist = path.join(treeDir, 'dist');
const treeSrc = path.join(treeDir, 'src');
fs.mkdirSync(treeDir, { recursive: true });
fs.cpSync(repoDist, treeDist, { recursive: true });
fs.cpSync(repoSrc, treeSrc, { recursive: true });
fs.rmSync(path.join(treeDist, 'build-stamp.json'), { force: true });

// `dist/` ignored exactly as in the real repository, so stamping cannot make
// the fixture look dirty to `git status --porcelain`.
fs.writeFileSync(path.join(treeDir, '.gitignore'), 'dist/\nnode_modules/\n');
const git = (...args) =>
  execFileSync('git', ['-C', treeDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'verify@crabcast.invalid');
git('config', 'user.name', 'KAN-227 verify');
git('add', '-A');
git('commit', '-q', '-m', 'KAN-227 fixture: a checkout to stamp a build from');

const dataDir = path.join(scratch, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// Outside the tree: written into it, the config would be an untracked file and
// the fixture would be dirty because this script put something there.
const configPath = path.join(scratch, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const stamp = () =>
  execFileSync(process.execPath, [stamperJs, treeDist], {
    encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe']
  }).trimEnd();

const walkFiles = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
};
const touch = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);

/**
 * Put the tree in a state whose freshness is unambiguously `current`.
 *
 * `fs.cpSync` stamps every copy with the current time, which would leave `src/`
 * and `dist/` with times decided by copy order rather than by anything real —
 * so "are the sources newer than the build" would be an artefact of this
 * script. Sources a minute before the build, compiled output a second before
 * the stamp, the stamp last: the order a real build produces.
 */
function pinTimes() {
  const builtAtMs = Date.parse(JSON.parse(
    fs.readFileSync(path.join(treeDist, 'build-stamp.json'), 'utf8')).builtAt);
  for (const f of walkFiles(treeSrc)) touch(f, builtAtMs - 60_000);
  for (const f of walkFiles(treeDist)) {
    if (path.basename(f) !== 'build-stamp.json') touch(f, builtAtMs - 1_000);
  }
  touch(path.join(treeDist, 'build-stamp.json'), builtAtMs);
  return builtAtMs;
}

console.log(`fixture tree:     ${treeDir}`);
console.log(`mcp server:       ${path.join(treeDist, 'mcp.js')}`);
console.log(`stamper said:     ${stamp()}`);
pinTimes();

// --------------------------------------------------------- a tiny MCP client
//
// MCP over stdio is newline-delimited JSON-RPC 2.0. Hand-rolled deliberately:
// the claim is that the server speaks the wire protocol to any client, and two
// copies of the SDK agreeing with themselves would not be evidence of it.

class McpClient {
  constructor(label) {
    this.label = label;
    this.child = spawn(process.execPath, [path.join(treeDist, 'mcp.js'), configPath], {
      env: ENV, stdio: ['pipe', 'pipe', 'pipe']
    });
    children.push(this.child);
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${this.label}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
      }
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `verify-daemon-status-over-mcp (${this.label})`, version: '0.0.0' }
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    return result;
  }

  callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }
}

/** The daemon's JSON answer rides inside the tool result's text content. */
const parsedText = (toolResult) => {
  const text = toolResult?.content?.find((c) => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

// ----------------------------------------------------- the raw socket caller
//
// The other half of §3's comparison, and it must not go anywhere near the MCP
// server: the whole assertion is that two INDEPENDENT routes to the daemon
// produce one answer.

const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(treeDist, 'ipc.js'));

let socketSeq = 0;
async function socketStatus() {
  const sock = await connectToDaemon(dataDir, { spawnIfMissing: false });
  sock.on('error', () => {});
  const id = `kan227-${++socketSeq}`;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${ACTION} reply on the socket`)), 15_000);
      onJsonLines(sock, (msg) => {
        if (msg.id !== id) return;
        clearTimeout(timer);
        resolve(msg);
      });
      writeJsonLine(sock, { action: ACTION, id });
    });
  } finally {
    sock.end();
  }
}

// =========================================================== 1. the tool list

rule(`1. the tool list — ${TOOL} is advertised over real MCP stdio`);

const client = new McpClient('client A');
const hello = await client.initialize();
check(
  hello?.serverInfo?.name === 'crabcast-mcp',
  'the server came up over stdio as crabcast-mcp',
  `serverInfo: ${JSON.stringify(hello?.serverInfo)}`
);

const { tools } = await client.request('tools/list');
const names = tools.map((t) => t.name);
console.log(`\n   tools/list returned ${names.length}:`);
for (const n of names) console.log(`     ${n}${n === TOOL ? '   <- KAN-227' : ''}`);

check(
  names.includes(TOOL),
  `${TOOL} is on the tool list a real MCP client receives`,
  `tools/list returned ${JSON.stringify(names)}`
);
// The count, stated deliberately rather than left to drift. Ten is what this
// slice makes it; `verify-mcp-tools.mjs` §2 is what holds the full list to
// exactly these names, and this is the count that must move with it.
check(
  names.length === 10,
  'and the surface is TEN tools — nine plus this one',
  `tools/list returned ${names.length}`
);

const tool = tools.find((t) => t.name === TOOL);
const desc = tool?.description ?? '';
check(
  tool?.inputSchema?.type === 'object' &&
    Object.keys(tool?.inputSchema?.properties ?? {}).length === 0 &&
    (tool?.inputSchema?.required ?? []).length === 0,
  'it takes no arguments — there is nothing about the daemon to address',
  `inputSchema: ${JSON.stringify(tool?.inputSchema)}`
);

/**
 * THE DESCRIPTION IS API, and it is the largest documentation claim in this
 * slice — the only place an MCP caller who never reads this repository meets
 * any of it. The fields below read like a health check and are not one, so the
 * claims that say what this response does NOT establish are load-bearing rather
 * than decorative, and they are the first thing a later rewrite would trim as
 * hedging.
 *
 * WHAT THIS WILL NOT CATCH, said plainly: it defends against REMOVAL and not
 * against CONTRADICTION. A rewrite that keeps these phrases and adds a sentence
 * calling the call a health check passes here. It is a presence check, worth
 * exactly what a presence check is worth — and more than the none these claims
 * would otherwise have.
 */
const CLAIMS = [
  ['it names the question — which CrabCast is running', /WHICH CRABCAST IS RUNNING/i],
  ['and why the filesystem cannot answer it', /filesystem is the thing that lies/i],
  ['a green freshness is NOT a healthy daemon', /IS NOT A HEALTHY DAEMON/],
  ['and what it is silent about — the fleet, herdr, the registry',
    /silently stopped, a herdr that is not answering and a registry that failed/i],
  ['stampPresent and stampUsable are different questions', /NOT THE SAME QUESTION/],
  ['basis says how strong the comparison was', /`file-times` merely dates it/],
  ['a non-empty `unknown` is not a clean bill of health', /NOT a clean bill of health/],
  ['the per-request cost is disclosed, with "do not poll this"', /Do not poll this/]
];
for (const [what, re] of CLAIMS) {
  console.log(`     claim: ${what}${re.test(desc) ? '' : '   <- MISSING'}`);
}
const missing = CLAIMS.filter(([, re]) => !re.test(desc));
check(
  missing.length === 0,
  'the description carries all eight load-bearing claims, including what the response does NOT\n' +
  '        establish — which is the half a reader will otherwise supply for themselves',
  `missing: ${missing.map(([w]) => w).join('; ')}`
);

// ====================================================== 2. the tenth answers

rule(`2. ${TOOL} ANSWERS — the KAN-122 blocks reach an MCP caller`);

// The MCP server's eager connect spawns the daemon from the fixture dist.
await waitFor(() => fs.existsSync(socketPathFor(dataDir)), 30_000, 'the daemon socket');

/**
 * The call, with the ORIGIN STATE handled as a verdict rather than as a crash.
 *
 * Before KAN-227 this tool was neither registered nor dispatched, so
 * `tools/call` came back as JSON-RPC -32601 MethodNotFound — which the client
 * above turns into a rejected promise. Left unhandled that is an uncaught
 * exception: the script exits non-zero, which is right, but it exits with a
 * stack trace instead of saying which claim failed. The defect this file exists
 * to catch is precisely the one that produced a stack trace, so it is the one
 * case whose output most needs to be legible.
 */
async function statusOverMcp() {
  try {
    return { result: await client.callTool(TOOL), protocolError: null };
  } catch (err) {
    return { result: null, protocolError: err.message };
  }
}

const first = await statusOverMcp();
if (first.protocolError) {
  console.log(`   tools/call rejected: ${first.protocolError}`);
  check(
    false,
    `${TOOL} answered over MCP`,
    /-32601/.test(first.protocolError)
      ? 'the server has no such method — the tool is not registered at all, which is exactly ' +
        'the KAN-227 defect. Sections 3 and 4 cannot run: there is no MCP payload to hold ' +
        'against the socket.'
      : first.protocolError
  );
  rule(`${failures} check(s) FAILED`);
  console.log('\nMCP server stderr:\n' + client.stderr);
  process.exit(1);
}

const mcpResult = first.result;
const mcp = parsedText(mcpResult);
show(`${TOOL} over MCP:`, mcp);
daemonPids.push(mcp.pid);

// §2 CALLS A TOOL §1 FOUND ON THE LIST, and that dependency is the point rather
// than a formality: a server that dispatches `crabcast_daemon_status` without
// advertising it would answer every check below while remaining exactly as
// unreachable as before — no client discovers a tool it is not told about. So
// the advertisement is asserted here too, against the name this section
// actually called.
check(
  names.includes(TOOL),
  'the tool this section just called is one a client could have DISCOVERED — answering is not\n' +
  '        reachability if nothing lists it',
  `tools/list did not advertise ${TOOL}, so these answers are unreachable in practice`
);

check(
  mcpResult.isError !== true && mcp?.success === true &&
    mcp?.action === `${ACTION}_response`,
  'the call succeeded and carries the action it answers for',
  `isError ${mcpResult.isError}, action ${JSON.stringify(mcp?.action)}`
);

// The two blocks KAN-122 built, which were on `daemon_status` alone and are
// what KAN-227 was filed about. Asserted as PRESENT AND POPULATED — a mirror
// that dropped either would otherwise pass every other check in this file.
check(
  typeof mcp?.build === 'object' && mcp.build !== null &&
    typeof mcp.build.commit === 'string' && mcp.build.commit.length > 0 &&
    mcp.build.stampUsable === true,
  'an MCP caller can now read WHICH COMMIT the running process was built from',
  `build: ${JSON.stringify(mcp?.build)}`
);
check(
  typeof mcp?.freshness === 'object' && mcp.freshness !== null &&
    mcp.freshness.state === 'current' &&
    mcp.freshness.processIsCurrentBuild === true &&
    mcp.freshness.sourcesNewerThanBuild === false &&
    typeof mcp.freshness.summary === 'string' && mcp.freshness.summary.length > 0,
  'and whether that build is the one on disk — `current`, with the sentence that says so',
  `freshness: ${JSON.stringify(mcp?.freshness)}`
);

// The process facts the ticket lists as reachable from nowhere else.
const PROCESS_FACTS = ['pid', 'configPath', 'dataDir', 'registryPath',
  'configuredAgents', 'expectedAgents', 'startedAt', 'bootId'];
const absent = PROCESS_FACTS.filter((f) => mcp?.[f] === undefined);
check(
  absent.length === 0,
  `and the process facts alongside them: ${PROCESS_FACTS.join(', ')}`,
  `absent: ${absent.join(', ')}`
);

// =============================================== 3. THE MIRROR — same answer

rule('3. THE MIRROR — the MCP payload is what the socket returns for the same action');

// Back to back, on a quiescent daemon, from two independent routes: this MCP
// server over stdio, and a raw NDJSON socket this script opens itself.
const mcpNow = parsedText(await client.callTool(TOOL));
const sockNow = await socketStatus();

/**
 * `id` is CORRELATION, not content. The socket caller chooses it and the daemon
 * echoes it back; the MCP server strips it when it resolves the request
 * (`const { id, ...body } = msg`), because by then the correlation has been
 * done. Removing it here compares the two answers rather than the two
 * bookkeeping tokens — and it is named rather than quietly excluded, because a
 * silent exclusion list is how a comparison stops covering what it claims to.
 */
const { id: _correlation, ...sockBody } = sockNow;

/**
 * `eventSeq` IS THE ONE FIELD ALLOWED TO DIFFER, and it is asserted rather than
 * dropped. It counts events this daemon has broadcast, so it moves whenever the
 * fleet does — the two calls below are microseconds apart on an idle daemon and
 * it will not move, but "will not" is not "cannot", and a comparison that goes
 * red on a legitimate event is a flake that teaches people to ignore it.
 * Checked for shape and direction instead: both present, both numbers, and
 * monotonic in call order (the socket call is second).
 */
const seqOk =
  typeof mcpNow.eventSeq === 'number' && typeof sockBody.eventSeq === 'number' &&
  sockBody.eventSeq >= mcpNow.eventSeq;
const mcpCompare = { ...mcpNow }; delete mcpCompare.eventSeq;
const sockCompare = { ...sockBody }; delete sockCompare.eventSeq;

const differing = [];
for (const key of new Set([...Object.keys(mcpCompare), ...Object.keys(sockCompare)])) {
  if (JSON.stringify(mcpCompare[key]) !== JSON.stringify(sockCompare[key])) differing.push(key);
}

console.log(`   fields compared: ${Object.keys(sockCompare).length}`);
console.log(`   eventSeq: MCP ${mcpNow.eventSeq} → socket ${sockBody.eventSeq} (allowed to advance)`);
console.log(`   differing: ${differing.length ? differing.join(', ') : '(none)'}`);
if (differing.length) {
  for (const k of differing) {
    show(`  ${k} — MCP:`, mcpCompare[k]);
    show(`  ${k} — socket:`, sockCompare[k]);
  }
}

check(
  differing.length === 0 && Object.keys(sockCompare).length > 0,
  'EVERY field of the MCP payload equals the socket\'s for the same action — nothing subsetted,\n' +
  '        nothing renamed, nothing reshaped. Two ways to reach one `daemon_status`',
  differing.length ? `these fields disagree: ${differing.join(', ')}` : 'nothing was compared at all'
);
check(
  seqOk,
  'and eventSeq — the one field entitled to move — is on both and did not go backwards',
  `MCP ${JSON.stringify(mcpNow.eventSeq)}, socket ${JSON.stringify(sockBody.eventSeq)}`
);

// ============================== 4. AND IT STILL AGREES WHEN THE ANSWER MOVES

rule('4. the answer CHANGES under the running daemon — and both surfaces move together');

// §3 proves the two agree. It cannot distinguish a mirror from a payload
// computed independently but plausibly, or cached at boot: on a quiescent tree
// every such payload agrees, forever. So change what the true answer IS.
//
// A rebuild under a live daemon is the exact KAN-122 situation and the reason
// that module exists: the process goes on executing what it loaded while the
// tree on disk moves on. Nothing on the filesystem shows it; only the process
// knows. Here it is arranged deliberately, at a known instant.
console.log('   rebuilding the fixture `dist/` under the running daemon...');
await sleep(1100); // a stamp whose builtAt is distinguishable from the last
const rebuiltFile = path.join(treeDist, 'router.js');
touch(rebuiltFile, Date.now());
console.log(`   re-stamped:    ${stamp()}`);

const mcpAfter = parsedText(await client.callTool(TOOL));
const sockAfter = await socketStatus();
const { id: _c2, ...sockAfterBody } = sockAfter;

console.log(`   freshness.state over MCP:    ${mcpAfter?.freshness?.state}`);
console.log(`   freshness.state over socket: ${sockAfterBody?.freshness?.state}`);
show('   freshness.summary over MCP:', mcpAfter?.freshness?.summary);

check(
  mcpAfter?.freshness?.state === 'process-predates-build' &&
    mcpAfter?.freshness?.processIsCurrentBuild === false,
  'the MCP caller sees the NEW answer — the daemon is no longer the build on disk. A payload\n' +
  '        cached at boot, or computed anywhere but in that daemon, would still say `current`',
  `freshness over MCP: ${JSON.stringify(mcpAfter?.freshness)}`
);
check(
  mcpAfter?.freshness?.runningCommit === mcp?.build?.commit &&
    mcpAfter?.build?.builtAt === mcp?.build?.builtAt,
  'and `build` still describes the build the PROCESS loaded, not the one now on disk —\n' +
  '        which is the whole of what the filesystem cannot tell you',
  `build.builtAt was ${mcp?.build?.builtAt}, now ${mcpAfter?.build?.builtAt}`
);

const afterDiffering = [];
for (const key of new Set([...Object.keys(mcpAfter), ...Object.keys(sockAfterBody)])) {
  if (key === 'eventSeq') continue;
  if (JSON.stringify(mcpAfter[key]) !== JSON.stringify(sockAfterBody[key])) afterDiffering.push(key);
}
console.log(`   differing after the rebuild: ${afterDiffering.length ? afterDiffering.join(', ') : '(none)'}`);
check(
  afterDiffering.length === 0,
  'and the two surfaces STILL agree field for field, on the changed answer — they move\n' +
  '        together because there is one computation behind them, not two that happen to match',
  `these fields disagree: ${afterDiffering.join(', ')}`
);

// A daemon running a stale build answered the question CORRECTLY. Flagging that
// as a failed call would tell a caller their call broke when what it did was
// work — `isError` is for `success: false`, and this response is a true report.
const staleResult = await client.callTool(TOOL);
check(
  staleResult.isError !== true && parsedText(staleResult)?.success === true,
  'a daemon running a stale build is NOT an isError — the call worked, and its answer is the\n' +
  '        bad news. isError is reserved for `success: false`',
  `isError ${staleResult.isError}`
);

// ----------------------------------------------------------------- the verdict

rule(failures === 0 ? 'all sections passed' : `${failures} check(s) FAILED`);
if (failures > 0) console.log('\nMCP server stderr:\n' + client.stderr);
process.exit(failures === 0 ? 0 : 1);
