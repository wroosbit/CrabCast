#!/usr/bin/env node
// Proof for KAN-163: a consumer can enumerate a fleet category COMPLETELY.
//
// WHAT FAILURE THIS WOULD CATCH: a `list_agents` category that answers 25 rows
// out of 89 and gives a consumer no way to reach the other 64 — the defect
// this ticket is about, which shipped in front of a consumer with no rollback.
// More precisely, it catches any of the four ways that can come back: a
// category with no `nextCursor` at all, a `nextCursor` that is null while rows
// remain, a cursor that silently resets to the first page instead of being
// refused, and an ordering with ties that hands the same row twice and another
// row never.
//
// WHY IT IS A CORRECTNESS DEFECT AND NOT A PAGINATION NICETY. §2 of
// docs/event-contract.md makes an authoritative `list` poll a CORRECTNESS
// requirement — events are a latency optimisation over it, and a subscriber
// with no timer is not entitled to the convergence property. `router.ts` then
// clipped what that poll returned, at 25, newest-first, silently. Each
// sentence was true. The composition was false: we told a consumer that
// polling `list` is what makes them correct, and `list` did not return the
// fleet. Because the order is newest-first, the row that fell off had been
// waiting longest — so an agent switched off long enough became permanently
// invisible to the reconciler responsible for restoring it, while every poll
// looked healthy and every `*Total` was honest. Butchr measured it on their
// real fleet: 89 standby agents, 25 returned, 72% invisible.
//
// THE STATE IS PRODUCED, NOT DESCRIBED. Section 1 stands up FORTY standby
// agents by calling `configure_agent`, `activate_agent` and `deactivate_agent`
// on the real router — the same three verbs a supervisor calls — against a
// herdr stub, and only then reads them back. Nothing here constructs a
// registry row and asserts on the field it just wrote, which is the failure
// KAN-145 shipped: two scripts that proved the daemon carries `activatedBy`
// correctly by handing it records that already had it.
//
// THE TWO PLACES THIS SCRIPT WRITES RECORDS DIRECTLY, named so no reader has
// to infer a coverage that is not there:
//
//   §5 (ties) calls `AgentRegistry.recordActivated(record, at)` with ONE
//   shared timestamp for thirty agents, because the verbs stamp `now` and
//   cannot be made to collide on demand. That override is not a test hook —
//   the in-place reconfiguration path uses it to carry an activation's
//   original time forward — but the rows in that section are written rather
//   than produced, and what it proves is the ORDERING property alone. The
//   completeness property on verb-produced rows is §§1-4.
//
//   Nothing else. §§1-4 and §§6-10 go through the verbs.
//
// WHAT THIS SCRIPT DOES NOT COVER, and who does:
//
//   * A REAL herdr. Every section replaces the `herdr` binary with a stub, so
//     what is proven is the daemon's own paging over a census, not a terminal
//     multiplexer's behaviour. The live half of this suite covers herdr; none
//     of it is about `list_agents` paging.
//   * THIRTY STANDBY AGENTS ON A LIVE DAEMON. §10 drives a real daemon, the
//     real CLI and the real MCP server, and it produces its thirty rows as
//     `unstartedAgents` — configure only — because thirty standby rows would
//     mean thirty real activations and thirty attached panes on a CI runner.
//     `standbyAgents` is the category the production symptom was measured in
//     and it is covered in §§1-3 against the same paging function, in-process.
//     So: no single section proves "thirty standby rows, end to end, through
//     MCP". That is the edge of this script, it is not covered by a sibling,
//     and it is filed as the gap it is rather than left to be inferred.
//   * WHETHER BUTCHR'S RECONCILER ACTUALLY WALKS THE CURSOR. That is the
//     consumer's side and is theirs to prove; §9 asserts only that the
//     contract now tells them to, in the same section as the obligation that
//     makes it necessary.
//
// Usage:
//   npm run build
//   node scripts/verify-fleet-enumeration.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan163-'));
const realPath = process.env.PATH;
const daemonPids = new Set();
const children = new Set();
function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  for (const pid of daemonPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(...parts) {
  const dir = path.join(tmp, 'owned', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// ----------------------------------------------------------------- the stub

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat ${JSON.stringify(CENSUS_FILE)}
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then
  echo '{"error":{"code":"agent_not_found","message":"no such agent"}}'
  exit 1
fi
echo '{"result":{}}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;

function setCensus(panes) {
  fs.writeFileSync(
    CENSUS_FILE,
    JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: panes } })
  );
}
setCensus([]);

const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
const foreignPane = (dir, paneId, name) => ({
  name, pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});

/** A router over a named registry file, so a section can build its own fleet. */
function harness(logName, RouterCtor = MessageRouter, RegistryCtor = AgentRegistry) {
  const agentRegistry = new RegistryCtor(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const invoke = (request) =>
    new Promise((resolve) => {
      const router = new RouterCtor({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: () => {}
      });
      router.handle(request);
    });
  return { agentRegistry, bridge, invoke };
}

const KNOBS = { priority: 1, launcher: 'shell' };

/**
 * Stand an agent up and switch it off, through the three verbs a supervisor
 * uses. What lands in `standbyAgents` is what those verbs left behind.
 */
async function produceStandby(invoke, dir, paneId) {
  await invoke({ action: 'configure_agent', path: dir, ...KNOBS });
  setCensus([ourPane(dir, paneId)]);
  await invoke({ action: 'activate_agent', path: dir });
  await invoke({ action: 'deactivate_agent', path: dir });
  setCensus([]);
}

/**
 * THE WALK A CONSUMER IS TOLD TO MAKE, written once here so every section
 * exercises the same one.
 *
 * The overrun guard is an ASSERTION rather than a convenience. A cursor that
 * silently resets — the plausible wrong implementation, and the one §8's
 * second mutant restores — makes this loop run forever on a correct-looking
 * response, and a proof that hangs is a proof nobody reads. It stops and
 * reports instead.
 */
async function walk(invoke, category, { limit, budget } = {}) {
  const rows = [];
  const pages = [];
  let after = null;
  const cap = budget ?? 40;
  for (let n = 0; n <= cap; n += 1) {
    if (n === cap) return { rows, pages, overran: true };
    const request = { action: 'list_agents' };
    if (after !== null || limit !== undefined) {
      request.pages = { [category]: { ...(after !== null ? { after } : {}), ...(limit !== undefined ? { limit } : {}) } };
    }
    const res = await invoke(request);
    if (res.success !== true) return { rows, pages, refused: res.error };
    const page = res.pages?.[category];
    if (!page) return { rows, pages, missingPageBlock: true };
    rows.push(...res[category]);
    pages.push({ returned: page.returned, total: page.total, remaining: page.remaining,
                 nextCursor: page.nextCursor });
    if (page.nextCursor === null || page.nextCursor === undefined) {
      return { rows, pages, overran: false };
    }
    after = page.nextCursor;
  }
  return { rows, pages, overran: true };
}

const paths = (rows) => rows.map((r) => r.path);
const setOf = (list) => new Set(list);
const sameSet = (a, b) => a.length === b.length && setOf(a).size === a.length &&
  b.every((x) => setOf(a).has(x));

// ===========================================================================
rule('1. THE STARVATION, PRODUCED — 40 standby agents, 25 returned, oldest gone');
// ===========================================================================
//
// Forty agents configured, activated and switched off through the real verbs.
// A default read is what a reconciler polling on a timer gets, and this is the
// shipped defect stated as a measurement rather than as a story.

const STANDBY_COUNT = 40;
const s1 = harness('s1');
const standbyDirs = [];

{
  // The FIRST agent is stood down and then left alone for a beat, so it is
  // unambiguously the oldest row in the category by timestamp rather than by
  // tiebreaker. It is the one this section is about: the agent nobody has
  // switched back on for longest is the first thing to vanish from the list
  // somebody would switch it back on from.
  const oldest = ownedDir('s1', 'agent-oldest');
  standbyDirs.push(oldest);
  await produceStandby(s1.invoke, oldest, '%1');
  await new Promise((r) => setTimeout(r, 25));

  for (let i = 1; i < STANDBY_COUNT; i += 1) {
    const dir = ownedDir('s1', `agent-${String(i).padStart(2, '0')}`);
    standbyDirs.push(dir);
    await produceStandby(s1.invoke, dir, `%${100 + i}`);
  }

  const listed = await s1.invoke({ action: 'list_agents' });
  const shown = paths(listed.standbyAgents);
  const oldestRow = listed.standbyAgents.find((r) => r.path === oldest);

  console.log(`   produced ${standbyDirs.length} standby agents through configure → activate → deactivate`);
  console.log(`   a default list_agents carries ${shown.length} of ${listed.standbyTotal}`);
  console.log(`   pages.standbyAgents: ${JSON.stringify(listed.pages?.standbyAgents)}`);

  check(
    listed.standbyTotal === STANDBY_COUNT,
    `the category really holds ${STANDBY_COUNT} rows — the state was produced, not described`,
    `standbyTotal ${listed.standbyTotal}`
  );
  check(
    shown.length === 25,
    'and a default read carries 25 of them, which is the cheap poll a fleet UI wants',
    `${shown.length} rows`
  );
  check(
    oldestRow === undefined,
    'THE OLDEST ROW IS NOT IN IT. Newest-first plus a cap means the row that falls off has ' +
      'been waiting longest — starvation of precisely the rows a reconciler exists to restore',
    oldestRow ? `it was at index ${shown.indexOf(oldest)}` : `absent: ${path.basename(oldest)}`
  );
  check(
    listed.standbyTotal - shown.length === 15,
    'the 15 rows this response withheld are exactly the 15 oldest — `standbyTotal` says how ' +
      'many are missing and never which, which is why it was never a remedy'
  );

  // Ordering is the reason the clip starves rather than merely truncates, so
  // it is asserted rather than assumed.
  const sinces = listed.standbyAgents.map((r) => r.since);
  check(
    sinces.every((s, i) => i === 0 || sinces[i - 1] >= s),
    'the page is newest-first, which is what makes "the row that falls off" mean "the oldest"'
  );
}

// ===========================================================================
rule('2. THE WALK — every one of the 40, including the oldest, through the cursor');
// ===========================================================================

{
  const walked = await walk(s1.invoke, 'standbyAgents');
  console.log(`   pages: ${walked.pages.map((p) => `${p.returned}/${p.total} remaining ${p.remaining}`).join(' → ') || '(none)'}`);

  // The pre-fix signature, named rather than left to arrive as five confusing
  // failures: the response carried rows and a total and no handle at all.
  check(
    walked.missingPageBlock !== true,
    'the response carries a `pages.standbyAgents` block — without one there is nothing to walk ' +
      'and no way for a consumer to learn there is more',
    walked.missingPageBlock ? 'no `pages` on the response' : undefined
  );

  check(walked.overran === false && !walked.refused && !walked.missingPageBlock,
    'the walk TERMINATES — a cursor that reset would loop here forever, and this guard is ' +
      'what says it did not',
    walked.refused ?? (walked.overran ? 'ran past its page budget' : undefined));

  const reached = paths(walked.rows);
  check(
    sameSet(reached, standbyDirs),
    `following nextCursor reaches all ${STANDBY_COUNT} rows, once each — no row hidden, no row twice`,
    `${reached.length} rows, ${new Set(reached).size} distinct, ${standbyDirs.length} produced`
  );
  check(
    reached.includes(standbyDirs[0]),
    'AND THE OLDEST ROW SPECIFICALLY — the one the default read starved, and the whole point ' +
      'of the mechanism',
    `${path.basename(standbyDirs[0])} at index ${reached.indexOf(standbyDirs[0])} of ${reached.length}`
  );
  check(
    reached[reached.length - 1] === standbyDirs[0],
    'and it arrives LAST, which is the ordering doing what it says: oldest is furthest from ' +
      'a default read'
  );
  const lastPage = walked.pages[walked.pages.length - 1] ?? {};
  check(
    walked.pages.length === 2 && walked.pages[0]?.nextCursor !== null &&
      lastPage.nextCursor === null,
    'nextCursor is non-null exactly while rows remain and null exactly once they do not — the ' +
      'only "you have everything" signal there is',
    walked.pages.map((p) => (p.nextCursor === null ? 'null' : 'cursor')).join(', ')
  );
  check(
    lastPage.remaining === 0,
    'and `remaining` agrees with it at the end'
  );
}

// ===========================================================================
rule('3. PAGE SIZE IS NOT THE MECHANISM — the same 40 at limit 7, 25 and 200');
// ===========================================================================
//
// "Raise the limit to 200" moves the cliff rather than removing it, so the
// property asserted is that completeness does not depend on the page size.

{
  const sizes = [7, 25, 200];
  const results = [];
  for (const limit of sizes) {
    const walked = await walk(s1.invoke, 'standbyAgents', { limit });
    results.push({ limit, walked });
    console.log(`   limit ${String(limit).padStart(3)}: ${walked.pages.length} page(s), ` +
      `${walked.rows.length} rows, overran=${walked.overran}`);
  }
  for (const { limit, walked } of results) {
    check(
      walked.overran === false && sameSet(paths(walked.rows), standbyDirs),
      `at limit ${limit} the walk reaches every row exactly once`,
      `${walked.rows.length} rows, ${new Set(paths(walked.rows)).size} distinct`
    );
  }
  check(
    results[0].walked.pages.length === 6 && results[2].walked.pages.length === 1,
    'a smaller page means more round trips and the same answer; a page big enough for the ' +
      'category still says nextCursor: null rather than leaving it to arithmetic',
    `limit 7 → ${results[0].walked.pages.length} pages, limit 200 → ${results[2].walked.pages.length}`
  );

  const tooBig = await s1.invoke({ action: 'list_agents', pages: { standbyAgents: { limit: 201 } } });
  check(
    tooBig.success === false && /follow .*nextCursor.* until it/.test(tooBig.error ?? ''),
    'and a limit past the maximum is REFUSED with the mechanism named, rather than quietly ' +
      'clamped back to a number that would truncate',
    tooBig.error?.slice(0, 140)
  );
}

// ===========================================================================
rule('4. NOT WIRED TO ONE CATEGORY — unstartedAgents, produced and enumerated');
// ===========================================================================
//
// A fix applied to the category somebody happened to measure is a fix that
// leaves four more. This one is produced by `configure` alone and ordered by a
// different field's value.

const s4 = harness('s4');
const unstartedDirs = [];

{
  for (let i = 0; i < 33; i += 1) {
    const dir = ownedDir('s4', `never-run-${String(i).padStart(2, '0')}`);
    unstartedDirs.push(dir);
    await s4.invoke({ action: 'configure_agent', path: dir, ...KNOBS });
  }
  setCensus([]);

  const first = await s4.invoke({ action: 'list_agents' });
  check(
    first.unstartedTotal === 33 && first.unstartedAgents.length === 25,
    'unstartedAgents holds 33 rows and a default read carries 25 of them',
    `${first.unstartedAgents.length} of ${first.unstartedTotal}`
  );

  const walked = await walk(s4.invoke, 'unstartedAgents', { limit: 10 });
  check(
    walked.overran === false && sameSet(paths(walked.rows), unstartedDirs),
    'and the same cursor walk reaches all 33 — the mechanism is the response\'s, not one ' +
      'category\'s',
    `${walked.rows.length} rows over ${walked.pages.length} pages`
  );

  // The other three paged categories answer a page block even when empty, so a
  // consumer can write one loop rather than five special cases.
  const blocks = Object.keys(first.pages ?? {}).sort();
  check(
    JSON.stringify(blocks) === JSON.stringify(
      ['foreignPanes', 'missingAgents', 'preemptedAgents', 'standbyAgents', 'unstartedAgents']),
    'every paged category carries a `pages` entry on every response, empty or not — a ' +
      'consumer checking nextCursor is doing the ordinary thing, not handling an exception',
    blocks.join(', ')
  );
  const emptyBlock = first.pages?.missingAgents ?? {};
  check(
    'nextCursor' in emptyBlock && emptyBlock.nextCursor === null && emptyBlock.total === 0,
    'and an empty category answers total 0 with nextCursor null, which is the same "that is ' +
      'all of them" a completed walk ends on'
  );
}

// ===========================================================================
rule('5. TIES — 30 rows sharing one timestamp, and the order is still TOTAL');
// ===========================================================================
//
// Thirty agents stood down in one loop can share a millisecond, and a paged
// read over an order with ties hands a caller the same row twice and another
// row never — this defect, reintroduced one level down and much harder to see.
//
// HOW THESE ROWS ARE MADE, stated because it is the one place this script
// writes what it then reads: `configure` is the real verb, and the activation
// is written with `AgentRegistry.recordActivated(record, at)` — the timestamp
// override the in-place reconfiguration path uses — because the verbs stamp
// `now` and cannot be made to collide on demand. What this section proves is
// the ORDERING property alone. Completeness on verb-produced rows is §§1-4.

const s5 = harness('s5');
const tiedDirs = [];

{
  const SHARED_AT = '2026-08-04T06:11:03.114Z';
  for (let i = 0; i < 30; i += 1) {
    const dir = ownedDir('s5', `tied-${String(i).padStart(2, '0')}`);
    tiedDirs.push(dir);
    await s5.invoke({ action: 'configure_agent', path: dir, ...KNOBS });
    const intent = s5.agentRegistry.intents().get(dir);
    s5.agentRegistry.recordActivated(intent.record, SHARED_AT);
  }
  // Recorded active and absent from the census: every one of them is missing.
  setCensus([]);

  const first = await s5.invoke({ action: 'list_agents' });
  const distinctSince = new Set(first.missingAgents.map((r) => r.since));
  console.log(`   ${first.missingTotal} missing rows, ${distinctSince.size} distinct \`since\` value(s) on the first page`);
  check(
    first.missingTotal === 30 && distinctSince.size === 1,
    'thirty rows share one timestamp, so `since` alone cannot order them',
    `${first.missingTotal} rows, ${distinctSince.size} distinct timestamps`
  );

  const walked = await walk(s5.invoke, 'missingAgents', { limit: 4 });
  check(
    walked.overran === false && sameSet(paths(walked.rows), tiedDirs),
    'and the walk still reaches all 30, once each — the tiebreaker makes the order total, so ' +
      'no page boundary can fall inside a group of equal rows and lose one',
    `${walked.rows.length} rows, ${new Set(paths(walked.rows)).size} distinct, over ${walked.pages.length} pages`
  );
}

// ===========================================================================
rule('6. THE CURSOR REFUSES rather than resets');
// ===========================================================================
//
// A cursor answered from the beginning is worse than one that errors: the
// caller's loop is now an infinite walk over page one that looks like a
// working enumeration, which is this ticket's own defect in a costume.

{
  const cases = [
    ['a cursor this daemon never issued', { standbyAgents: { after: 'not-a-cursor' } }, /not a cursor this daemon/],
    ['a cursor that is not a string', { standbyAgents: { after: 42 } }, /not a cursor this daemon/],
    ['a base64 blob that decodes to the wrong shape',
      { standbyAgents: { after: Buffer.from('{"nope":1}', 'utf8').toString('base64url') } },
      /not a cursor this daemon/],
    ['a misspelled category', { standbyagents: {} }, /not a paged category/],
    ['a category that is never paged', { agents: {} }, /never\s*\n?\s*clipped and take no page|not a paged category/],
    ['a limit of zero', { standbyAgents: { limit: 0 } }, /between 1 and 200/],
    ['a fractional limit', { standbyAgents: { limit: 2.5 } }, /between 1 and 200/],
    ['a pages block that is not an object', 'standbyAgents', /keyed by category name/]
  ];
  for (const [what, pages, expected] of cases) {
    const res = await s1.invoke({ action: 'list_agents', pages });
    const refused = res.success === false && expected.test(res.error ?? '');
    check(refused, `${what} is REFUSED, and the refusal says what to pass instead`,
      `success=${res.success} error=${(res.error ?? '(none)').slice(0, 110)}`);
  }

  // The refusal is a refusal of the WHOLE read, not a category quietly served
  // from the start. A caller must not be able to mistake it for data.
  const bad = await s1.invoke({ action: 'list_agents', pages: { standbyAgents: { after: 'nope' } } });
  check(
    bad.success === false && bad.standbyAgents === undefined,
    'and it carries no rows at all — a refusal that also returned page one would be read as ' +
      'an answer'
  );
}

// ===========================================================================
rule('7. THE CURSOR IS A POSITION, NOT AN INDEX — a walk survives the fleet moving');
// ===========================================================================
//
// The contract says a page walk is not a transaction, and this is the half of
// that claim which must not be true: the row the cursor NAMES disappearing
// between pages must not break the walk. An implementation that resumed from
// an index into a list, or looked its cursor row up by identity, would.

{
  const first = await s1.invoke({ action: 'list_agents', pages: { standbyAgents: { limit: 20 } } });
  const cursor = first.pages?.standbyAgents?.nextCursor ?? null;
  const cursorRow = first.standbyAgents?.[first.standbyAgents.length - 1]?.path;
  if (!check(typeof cursor === 'string' && Boolean(cursorRow),
    'a first page of 20 answered a cursor to continue from',
    `cursor ${typeof cursor}, row ${cursorRow ?? '(none)'}`)) {
    console.log('   (the rest of this section needs that cursor and is not run)');
  } else {

  // `forget` removes the record, so the row the cursor names leaves the
  // category entirely between the two reads.
  const forgotten = await s1.invoke({ action: 'forget_agent', path: cursorRow });
  check(forgotten.success === true,
    `the row the cursor names (${path.basename(cursorRow)}) is forgotten between pages`,
    forgotten.error);

  const rest = await s1.invoke({ action: 'list_agents', pages: { standbyAgents: { after: cursor, limit: 20 } } });
  const seen = [...paths(first.standbyAgents), ...paths(rest.standbyAgents)];
  const expected = standbyDirs.filter((d) => d !== cursorRow);
  console.log(`   page 1: ${first.standbyAgents.length} rows, page 2 after the vanished cursor: ` +
    `${rest.standbyAgents.length} rows, total category now ${rest.pages.standbyAgents.total}`);

  check(
    rest.success === true,
    'and the next page is still answered rather than refused — the cursor is a position in an ' +
      'order, not a handle on a row'
  );
  check(
    sameSet(seen.filter((p) => p !== cursorRow), expected) &&
      rest.pages.standbyAgents.nextCursor === null,
    'the walk still reaches every surviving row exactly once, and ends where it should',
    `${seen.length} seen, ${expected.length} expected to survive`
  );

  // Put it back, so the sections after this one see the fleet §1 built.
  await produceStandby(s1.invoke, cursorRow, '%199');
  }
}

// ===========================================================================
rule('8. THE CHECKS CAN FAIL — the compiled daemon is mutated four ways');
// ===========================================================================
//
// A completeness assertion is exactly the kind that passes vacuously, and the
// shipped defect looked like a working list. So the mechanism is backed out of
// the COMPILED daemon — not out of a stub, not out of a copy of the assertion
// — and the same walks are re-run against it. If they still pass, they were
// never testing the code.

try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

/**
 * Run one mutation section, and turn a missing anchor into a RED CHECK rather
 * than into a dead run.
 *
 * The sibling scripts throw here, deliberately: an anchor that no longer
 * matches means the mutation target moved and the section is unproven, which
 * must not read as a pass. That is right, and it has one consequence this
 * script cannot afford — a throw takes the sections after it down with it, and
 * §9 and §10 are where the contract and the two consumer surfaces are checked.
 * So the failure is recorded with the same weight and the run continues, which
 * is also what makes this script legible when it is pointed at a build that
 * has no paging in it at all.
 */
async function mutationSection(name, body) {
  try {
    await body();
  } catch (e) {
    check(false,
      `MUTATION '${name}' could not be applied — the section is unproven, which is a failure ` +
        'rather than a skip',
      String(e?.message ?? e).slice(0, 300));
  }
}

/** A copy of dist with one string replaced. Returns the mutated module dir. */
/**
 * A copy of dist with one string replaced, or NULL when the edit did not apply.
 *
 * THIS FILE ALREADY HAD THE HARD HALF RIGHT — `mutationSection` below caught the
 * throw, counted it as a failure and let the run continue, which is exactly the
 * property KAN-138 went looking for and found missing in the other seven copies.
 * What it gains from the shared helper is that the failure now arrives as a
 * NAMED verdict from the mutation itself rather than as a stringified exception,
 * and that this file no longer carries a private implementation that can drift
 * from the other eight. `mutationSection` stays: it is a second net under any
 * OTHER throw a mutant section can produce, which is not what `mutate` covers.
 */
const { mutate: mutantDist, mutationsSkipped } = makeMutator({
  distDir,
  scratch: tmp,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

/** The same 40-agent fleet, against a broken build. */
async function mutantFleet(name, file, from, to, logName) {
  const dir = mutantDist(name, file, from, to);
  // The mutation did not apply and is already a counted failure. Null rather
  // than a harness built over a build that was never mutated: the caller skips
  // its section, and the sections after it still run.
  if (!dir) return null;
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness(logName, Broken, BrokenReg);
  const dirs = [];
  for (let i = 0; i < 30; i += 1) {
    const d = ownedDir(logName, `m-${String(i).padStart(2, '0')}`);
    dirs.push(d);
    await produceStandby(h.invoke, d, `%${200 + i}`);
  }
  return { h, dirs };
}

await mutationSection('no-cursor', async () => {
  // MUTATION 1: THE SHIPPED DEFECT, RESTORED. The response still carries 25
  // rows and an honest total, and no handle to the rest — which is exactly
  // what `sorted.slice(0, FLEET_CATEGORY_LIMIT)` with a `*Total` alongside was.
  const fleet = await mutantFleet(
    'no-cursor', 'router.js',
    'nextCursor: remaining > 0 && page.length > 0 ? encodeFleetCursor(page[page.length - 1].at) : null',
    'nextCursor: null',
    's8a'
  );
  // The mutation did not apply and is already a counted failure — asserting
  // about a build that was never mutated would prove the opposite of this
  // section. Return, and let the sections after it run.
  if (!fleet) return;
  const { h, dirs } = fleet;
  const walked = await walk(h.invoke, 'standbyAgents');
  const listed = await h.invoke({ action: 'list_agents' });
  console.log(`   the mutant answers ${walked.rows.length} of ${listed.standbyTotal} rows and stops`);
  check(
    walked.rows.length === 25 && dirs.length === 30 &&
      !sameSet(paths(walked.rows), dirs),
    'with nextCursor forced to null the walk reaches 25 of 30 and cannot go further — §2 goes ' +
      'RED, which is what makes §2 a measurement of the daemon rather than of its own hopes',
    `${walked.rows.length} reached, ${dirs.length} produced`
  );
  check(
    listed.standbyTotal === 30,
    'and the mutant is still HONEST about the total, which is the shipped defect exactly: ' +
      '`*Total` says how many rows are missing and never which'
  );
});

await mutationSection('cursor-ignored', async () => {
  // MUTATION 2: the cursor is accepted and ignored — every page is page one.
  // This is the plausible wrong implementation, and its signature is not a
  // wrong answer but a walk that never ends.
  const fleet = await mutantFleet(
    'cursor-ignored', 'router.js',
    'const start = from === null ? 0 : ordered.findIndex((r) => compareFleetRows(r.at, from) > 0);',
    'const start = 0;',
    's8b'
  );
  // The mutation did not apply and is already a counted failure — asserting
  // about a build that was never mutated would prove the opposite of this
  // section. Return, and let the sections after it run.
  if (!fleet) return;
  const { h, dirs } = fleet;
  const walked = await walk(h.invoke, 'standbyAgents', { budget: 12 });
  console.log(`   the mutant returned ${walked.pages.length} pages before the budget stopped it, ` +
    `${new Set(paths(walked.rows)).size} distinct rows among ${walked.rows.length}`);
  check(
    walked.overran === true && new Set(paths(walked.rows)).size < dirs.length,
    'a cursor that resets makes the walk run forever over its first page — §2\'s termination ' +
      'guard is what catches it, and it goes RED',
    `overran=${walked.overran}, ${new Set(paths(walked.rows)).size} distinct of ${dirs.length}`
  );
});

await mutationSection('no-tiebreak', async () => {
  // MUTATION 3: the tiebreaker is dropped, so equal timestamps are an order
  // with no position in it. Ties then swallow every row after the cursor's
  // group — the defect one level down, which §5 exists for.
  const dir = mutantDist(
    'no-tiebreak', 'router.js',
    'return byTime !== 0 ? byTime : a.k.localeCompare(b.k);',
    'return byTime;'
  );
  // The mutation did not apply and is already a counted failure — asserting
  // about a build that was never mutated would prove the opposite of this
  // section. Return, and let the sections after it run.
  if (!dir) return;
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s8c', Broken, BrokenReg);
  const SHARED_AT = '2026-08-04T06:11:03.114Z';
  const dirs = [];
  for (let i = 0; i < 30; i += 1) {
    const d = ownedDir('s8c', `tied-${String(i).padStart(2, '0')}`);
    dirs.push(d);
    await h.invoke({ action: 'configure_agent', path: d, ...KNOBS });
    h.agentRegistry.recordActivated(h.agentRegistry.intents().get(d).record, SHARED_AT);
  }
  setCensus([]);
  const walked = await walk(h.invoke, 'missingAgents', { limit: 4, budget: 12 });
  const distinct = new Set(paths(walked.rows)).size;
  console.log(`   the mutant's walk over 30 tied rows reached ${distinct} distinct row(s) ` +
    `in ${walked.pages.length} page(s)`);
  check(
    distinct < dirs.length || walked.overran === true,
    'without the tiebreaker a page boundary inside a group of equal rows loses the rest of ' +
      'them — §5 goes RED',
    `${distinct} distinct of ${dirs.length}, overran=${walked.overran}`
  );
});

await mutationSection('cursor-silently-resets', async () => {
  // MUTATION 4: an unrecognised cursor is answered from the beginning instead
  // of refused. Nothing errors, every response looks well-formed, and the
  // consumer's enumeration is a loop over page one.
  const dir = mutantDist(
    'cursor-silently-resets', 'router.js',
    "if (typeof after !== 'string' || (from = decodeFleetCursor(after)) === null) {",
    "if ((typeof after !== 'string' || (from = decodeFleetCursor(after)) === null) && false) {"
  );
  // The mutation did not apply and is already a counted failure — asserting
  // about a build that was never mutated would prove the opposite of this
  // section. Return, and let the sections after it run.
  if (!dir) return;
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  const h = harness('s8d', Broken, BrokenReg);
  for (let i = 0; i < 30; i += 1) {
    await produceStandby(h.invoke, ownedDir('s8d', `r-${String(i).padStart(2, '0')}`), `%${300 + i}`);
  }
  const res = await h.invoke({ action: 'list_agents', pages: { standbyAgents: { after: 'not-a-cursor' } } });
  console.log(`   the mutant answers a garbage cursor with success=${res.success} and ` +
    `${res.standbyAgents?.length ?? 0} rows`);
  check(
    res.success === true && (res.standbyAgents?.length ?? 0) === 25,
    'a cursor that silently resets answers page one to a caller who asked for page five — §6 ' +
      'goes RED, and this is the failure mode that turns an enumeration into an infinite loop ' +
      'while every response looks correct'
  );
});

// ===========================================================================
rule('9. THE CONTRACT SAYS SO, in the same section as the obligation');
// ===========================================================================
//
// The defect was never only in the code. §2 of docs/event-contract.md made an
// authoritative poll a correctness requirement and said nothing about the clip
// — two true sentences that were false together. This asserts the two now live
// in one section, and pins the documented number to the constant so they
// cannot drift apart quietly.

{
  const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'event-contract.md'), 'utf8');
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'router.ts'), 'utf8');
  const limitInCode = /const FLEET_CATEGORY_LIMIT = (\d+);/.exec(source)?.[1];
  const maxInCode = /const FLEET_CATEGORY_MAX_LIMIT = (\d+);/.exec(source)?.[1];

  const sectionStart = doc.indexOf('## 2. Delivery guarantees');
  const sectionEnd = doc.indexOf('## 3. ');
  const section2 = doc.slice(sectionStart, sectionEnd);
  check(sectionStart >= 0 && sectionEnd > sectionStart, '§2 of the contract was located',
    `chars ${sectionStart}..${sectionEnd}`);

  check(
    /is not\s*\n?>?\s*entitled to the convergence property/.test(section2),
    '§2 still states the obligation — polling `list` is a correctness requirement'
  );
  check(
    Boolean(limitInCode) && section2.includes(`${limitInCode} rows a page`),
    `and the SAME SECTION now states the page size, using the number in router.ts (${limitInCode})`,
    `FLEET_CATEGORY_LIMIT=${limitInCode}`
  );
  check(
    Boolean(maxInCode) && section2.includes(`1–${maxInCode}`),
    `and the maximum page size, also from the source (${maxInCode})`
  );
  for (const [what, needle] of [
    ['the mechanism', 'nextCursor'],
    ['the request shape', '"pages": { "standbyAgents"'],
    ['the CLI form', 'crabcast list --category standbyAgents --after'],
    ['the MCP form', 'crabcast_list_agents` takes `category`'],
    ['which categories are paged', '`standbyAgents`, `unstartedAgents`, `foreignPanes`'],
    ['which are not', '`agents`, `unbackedPanes`'],
    ['the null-cursor rule', 'the only "you have everything" signal'],
    ['that *Total was never the remedy', 'never a remedy'],
    ['that a walk is not a transaction', 'not a transaction']
  ]) {
    check(section2.includes(needle), `§2 names ${what}`, needle);
  }
  check(
    section2.includes('scripts/verify-fleet-enumeration.mjs'),
    'and points at this script, so a reader can check the claim rather than take it'
  );
}

// ===========================================================================
rule('10. THE CONSUMER SURFACES — a real daemon, the real CLI, the real MCP server');
// ===========================================================================
//
// Everything above drives the router in-process. What a consumer actually
// holds is an MCP tool and a command line, and a mechanism that exists in the
// router and not on those is a mechanism nobody can use — which is the shape
// of failure this epic keeps finding. So: a real daemon over a real socket,
// thirty rows produced through it, and the category walked to completeness
// through BOTH surfaces.
//
// THE CATEGORY HERE IS `unstartedAgents` and the reason is on the record in
// this script's header: thirty standby rows would mean thirty real
// activations and thirty attached panes on a CI runner. The paging function is
// the same one §§1-3 walk for standby.

const liveHome = path.join(tmp, 'live-home');
const liveDir = path.join(tmp, 'live');
const liveData = path.join(liveDir, 'data');
const liveConfigPath = path.join(liveDir, 'crabcast.config.json');
const liveState = path.join(liveDir, 'shim-state');
fs.mkdirSync(liveHome, { recursive: true });
fs.mkdirSync(liveState, { recursive: true });
fs.mkdirSync(liveDir, { recursive: true });
fs.writeFileSync(liveConfigPath, JSON.stringify({ dataDir: liveData }, null, 2));

const liveBin = path.join(tmp, 'live-bin');
fs.mkdirSync(liveBin, { recursive: true });
const shimImpl = path.join(liveBin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
const args = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const [a, b] = args;
if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (a === 'agent' && b === 'get') {
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'list') out({ result: { agents: [] } });
out({ result: {} });
`);
fs.writeFileSync(path.join(liveBin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(liveBin, 'herdr'), 0o755);

const liveEnv = {
  ...process.env,
  HOME: liveHome,
  SHELL: '/bin/bash',
  PATH: `${liveBin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

const cliJs = path.join(distDir, 'cli.js');
const crabcast = (args) =>
  spawnSync(process.execPath, [cliJs, '--config', liveConfigPath, ...args], {
    env: liveEnv, encoding: 'utf8', timeout: 120_000
  });

async function raw(action, payload = {}) {
  const socket = await connectToDaemon(liveData, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `kan163-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply to ${action}`)); }, 20_000);
    onJsonLines(socket, (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.end();
      resolve(msg);
    });
    writeJsonLine(socket, { action, id, ...payload });
  });
}

const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

{
  const LIVE_COUNT = 30;
  const liveDirs = [];
  for (let i = 0; i < LIVE_COUNT; i += 1) {
    const d = path.join(liveDir, 'owned', `never-run-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(d, { recursive: true });
    liveDirs.push(fs.realpathSync(d));
  }

  // The first configure spawns the daemon; the rest go over its socket.
  const firstConfigure = crabcast(['configure', liveDirs[0], '--priority', '1', '--launcher', 'shell']);
  check(firstConfigure.status === 0, 'the CLI configured the first agent and brought a daemon up',
    firstConfigure.status === 0 ? undefined : firstConfigure.stderr?.slice(0, 300));
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 20_000, 'the daemon socket');
  const daemon = await raw('daemon_status');
  daemonPids.add(daemon.pid);

  for (const d of liveDirs.slice(1)) {
    const res = await raw('configure_agent', { path: d, priority: 1, launcher: 'shell' });
    if (res.success !== true) throw new Error(`configure failed for ${d}: ${res.error}`);
  }

  const socketFirst = await raw('list_agents');
  console.log(`   a real daemon (pid ${daemon.pid}) holds ${socketFirst.unstartedTotal} unstarted ` +
    `agents and answers ${socketFirst.unstartedAgents.length} by default`);
  check(
    socketFirst.unstartedTotal === LIVE_COUNT && socketFirst.unstartedAgents.length === 25,
    `SURFACE 1/3 — the socket: ${LIVE_COUNT} rows produced through a real daemon, 25 in a ` +
      'default read',
    `${socketFirst.unstartedAgents.length} of ${socketFirst.unstartedTotal}`
  );
  const socketWalk = await walk(
    (request) => raw(request.action, { pages: request.pages }), 'unstartedAgents');
  check(
    socketWalk.overran === false && sameSet(paths(socketWalk.rows), liveDirs),
    'and the cursor walk over the socket reaches every one of them',
    `${socketWalk.rows.length} rows over ${socketWalk.pages.length} pages`
  );

  // --- surface 2: the CLI, driven by the command it printed itself ----------
  //
  // The remedy has to be findable from where the truncation is visible, so the
  // cursor is taken from `crabcast list`'s own output and the printed command
  // is run verbatim. A `more:` line naming a command that does not work would
  // pass any check that only looked for the line.
  const cliFirst = crabcast(['list']);
  const more = /^ +more: crabcast list --category unstartedAgents --after (\S+)$/m.exec(cliFirst.stdout);
  console.log(cliFirst.stdout.split('\n').filter((l) => /unstarted agents|more:/.test(l))
    .map((l) => `     ${l.trim()}`).join('\n'));
  check(
    Boolean(more),
    'SURFACE 2/3 — `crabcast list` prints the next command UNDER THE CATEGORY IT TRUNCATED, ' +
      'cursor and all, so the sentence naming the gap is the one that closes it',
    more ? undefined : 'no `more:` line was printed'
  );
  check(
    /unstarted agents \(30\) — showing 25, 5 older not shown/.test(cliFirst.stdout),
    'beside the count it withheld'
  );
  if (more) {
    const cliRest = crabcast(['list', '--category', 'unstartedAgents', '--after', more[1]]);
    const shown = [...cliRest.stdout.matchAll(/^ {2}(\/\S+) — configured /gm)].map((m) => m[1]);
    check(
      cliRest.status === 0 && shown.length === 5,
      'and running that command verbatim returns the 5 rows the first read withheld',
      `exit ${cliRest.status}, ${shown.length} rows`
    );
    check(
      /unstarted agents \(30\)$/m.test(cliRest.stdout) === false ||
        !/more: crabcast list --category unstartedAgents/.test(cliRest.stdout),
      'and prints no further `more:` line, because there is nothing further'
    );
    const badCursor = crabcast(['list', '--category', 'unstartedAgents', '--after', 'not-a-cursor']);
    check(
      badCursor.status !== 0 && /not a cursor this daemon issued/.test(badCursor.stdout + badCursor.stderr),
      'and an invented cursor is refused at the CLI too, rather than answered from the start',
      `exit ${badCursor.status}`
    );
  }

  // --- surface 3: MCP ------------------------------------------------------
  const mcp = spawn(process.execPath, [path.join(distDir, 'mcp.js')], {
    env: { ...liveEnv, CRABCAST_CONFIG: liveConfigPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  children.add(mcp);
  let mcpBuf = '';
  const mcpPending = new Map();
  mcp.stdout.on('data', (chunk) => {
    mcpBuf += chunk.toString();
    let nl;
    while ((nl = mcpBuf.indexOf('\n')) !== -1) {
      const line = mcpBuf.slice(0, nl).trim();
      mcpBuf = mcpBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = mcpPending.get(msg.id);
      if (resolve) { mcpPending.delete(msg.id); resolve(msg); }
    }
  });
  mcp.stderr.on('data', () => {});
  let mcpId = 0;
  const mcpRequest = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++mcpId;
      const timer = setTimeout(() => reject(new Error(`no MCP reply to ${method}`)), 30_000);
      mcpPending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kan163', version: '1' }
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = (await mcpRequest('tools/list', {})).result.tools;
  const listTool = tools.find((t) => t.name === 'crabcast_list_agents');
  check(
    Boolean(listTool?.inputSchema?.properties?.category) &&
      Boolean(listTool?.inputSchema?.properties?.after),
    'SURFACE 3/3 — the MCP tool DECLARES the paging arguments, so a client that reads the ' +
      'schema can page without being told',
    Object.keys(listTool?.inputSchema?.properties ?? {}).join(', ')
  );
  check(
    /nextCursor/.test(listTool?.description ?? '') &&
      /until it comes back null/.test(listTool?.description ?? ''),
    'and its description tells the caller to walk the cursor rather than trust one response'
  );

  const mcpCall = async (args) => JSON.parse(
    (await mcpRequest('tools/call', { name: 'crabcast_list_agents', arguments: args }))
      .result.content[0].text
  );
  const mcpRows = [];
  let mcpCursor = null;
  let mcpPages = 0;
  for (let n = 0; n < 20; n += 1) {
    const res = await mcpCall(mcpCursor === null ? {} : { category: 'unstartedAgents', after: mcpCursor });
    mcpPages += 1;
    mcpRows.push(...res.unstartedAgents.map((r) => r.path));
    mcpCursor = res.pages.unstartedAgents.nextCursor;
    if (mcpCursor === null) break;
  }
  console.log(`   MCP: ${mcpPages} tool call(s), ${mcpRows.length} rows, ` +
    `${new Set(mcpRows).size} distinct`);
  check(
    sameSet(mcpRows, liveDirs) && mcpCursor === null,
    `walking crabcast_list_agents reaches all ${LIVE_COUNT} rows through the tool a consumer ` +
      'actually holds — which is the assertion no `pages` field in a router unit test can make',
    `${mcpRows.length} rows over ${mcpPages} calls`
  );

  const mcpBad = await mcpRequest('tools/call', {
    name: 'crabcast_list_agents', arguments: { after: 'a-cursor-with-no-category' }
  });
  check(
    mcpBad.result?.isError === true,
    'and `after` without a category is an ERROR at the tool rather than a default read that ' +
      'silently ignored the caller\'s cursor',
    JSON.stringify(mcpBad.result?.content?.[0]?.text ?? mcpBad.error).slice(0, 160)
  );

  mcp.kill('SIGTERM');
  children.delete(mcp);
}

// ---------------------------------------------------------------------------
if (mutationsSkipped().length) {
  // Named next to the verdict, because "N FAILED" reads as N ordinary assertion
  // failures when what actually happened is that a section never executed.
  console.log(
    `\n${mutationsSkipped().length} MUTATION(S) DID NOT APPLY, so their sections did not run: ` +
      mutationsSkipped().join(', ')
  );
}
console.log(
  failures.length
    ? `\n${failures.length} CHECK(S) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : `\nALL PASS — a consumer can enumerate a fleet category completely, the oldest row ` +
      `included, and the contract says so where the obligation is stated.`
);
process.exit(failures.length ? 1 : 0);
