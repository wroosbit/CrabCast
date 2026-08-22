#!/usr/bin/env node
// Proof for KAN-619: `daemon_status` accounts for the records `expectedAgents`
// counts and cannot start, and it agrees with `list_agents` about the registry
// they both read.
//
// WHAT FAILURE THIS WOULD CATCH: two instruments giving different answers about
// one registry record. `daemon_status` counted a record whose directory had
// been deleted under `expectedAgents` — a field whose sentence is "expected to
// be RUNNING" — while `list_agents`, one call away on the same head and the
// same registry, reported that same record under `strandedAgents`. Measured on
// `origin/main` at `4233960` before this ticket: `configuredAgents 2,
// expectedAgents 2` beside `strandedTotal 1`. Nothing was broken and nothing
// went red; a count's sentence outran its population, which is the shape this
// repository keeps re-finding in a new costume.
//
// ---------------------------------------------------------------------------
// THE FIXTURE IS DISCRIMINATING, WHICH IS THE PART THAT DECIDES WHAT THIS IS
// WORTH
// ---------------------------------------------------------------------------
//
// The obvious fixture — one activated record, its directory deleted — makes
// `expectedStranded` and `strandedTotal` BOTH 1, and a build that computed one
// number and published it twice under two names would pass every assertion
// drawn on it. That build is not hypothetical: it is the likeliest wrong
// implementation of this ticket, because `list_agents.strandedTotal` is already
// there and reusing it is one line.
//
// So the registry below holds FOUR stranded records with THREE different last
// events, and exactly one of them is `activated`. `expectedStranded` must read
// 1 and `strandedTotal` must read 4, and §4 asserts they differ — which is an
// assertion that CANNOT be satisfied by publishing either number twice.
//
// ⚠ AND THERE IS A SURVIVOR THAT IS NEVER DELETED. A build that reported every
// record as stranded, or none, satisfies a §2 that only counts the deleted
// ones. The survivor is what makes `expectedAgents - expectedStranded` a
// number about the world rather than an identity.
//
// ---------------------------------------------------------------------------
// WHAT IS PRODUCED, WHAT THAT LEAVES UNCOVERED, AND WHO COVERS IT
// ---------------------------------------------------------------------------
//
// THIS SCRIPT WRITES THE REGISTRY IT THEN ASSERTS ON, and says so here rather
// than leaving a reader to infer a coverage that does not exist (KAN-145: a
// proof that supplies its own input has not tested that the input arrives).
// Every row is written by the real `configure_agent` / `activate_agent` /
// `deactivate_agent` handlers on the real router — which is what proves
// `configure` accepted these paths, since their directories were real when it
// ran — and the directories are then deleted, which is what a proof teardown
// does and is exactly how the population that commissioned KAN-594 arose. Every
// response asserted on is a real `daemon_status` or `list_agents` off a FRESH
// router over that registry, so no session of this script's masks the state.
//
// What this script does NOT establish, and who does:
//
//   * THAT THE TWO FIELDS REACH THE WIRE. The router is driven in-process here.
//     `verify-daemon-status-over-mcp.mjs` §3 compares the MCP payload field for
//     field against what the raw socket returns for the same action from the
//     same daemon in the same second, so a field that existed in the response
//     object and not on either surface is red there. It needed no change for
//     this ticket, which is the point of naming it.
//   * THAT THE DECLARATION, THE DOCUMENT AND THE LIVE DAEMON AGREE about the
//     field set and the contract version. `verify-read-contract.mjs` §1 and §3.
//   * THE `strandedAgents` CATEGORY ITSELF — its membership rule, its
//     disjointness from `missingAgents`, and that `forget` retires a row.
//     `verify-stranded-agents.mjs` (KAN-594). This script asserts only that
//     `daemon_status`' counts agree with that category, not that the category
//     is right.
//   * A REAL herdr. The census is a shell stub, so what is established is this
//     daemon's arithmetic over a census rather than herdr's reporting of one.
//
// ⚠ AND ONE GAP IS COVERED BY NOBODY YET, named because the sections below read
// as complete: nothing here or anywhere else observes a REAL fleet's registry
// accumulating stranded rows and a supervisor reading these counts off it. The
// population is real — thirteen such rows on 2026-08-21, which is what KAN-594
// was filed on — and every proof that touches it, including this one, builds
// its own.
//
// Usage:
//   npm run build
//   node scripts/verify-daemon-status-accounts-for-stranded.mjs [distDir]

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
const { snapshotBuild } = await import(path.join(distDir, 'provenance.js'));
const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));
const { commandNamed, ResponseReader } = await import(path.join(distDir, 'cli.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan619-'));
const realPath = process.env.PATH;
function cleanup() {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
// TEARDOWN OFF THE HAPPY PATH. Nothing here spawns a daemon or a PTY — the
// router is driven in-process and the herdr binary is a shell stub — so what an
// interrupt would leave behind is one scratch tree and a mutated PATH. Both are
// put back here rather than only at the end of a clean run.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

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
// Before the first `configure`, which reads the census: an absent file is a
// parse error in the bridge, not an empty fleet.
setCensus([]);

const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});

// What `daemon.ts` hands the router at boot. `daemon_status` recomputes
// freshness per request off it, and the response throws without one.
const bootBuild = snapshotBuild();

function harness(logName, Ctors = {}) {
  const Router = Ctors.MessageRouter ?? MessageRouter;
  const Registry = Ctors.AgentRegistry ?? AgentRegistry;
  const agentRegistry = new Registry(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const deps = {
    config,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry,
    bootBuild,
    broadcast: () => {}
  };
  const invoke = (request) =>
    new Promise((resolve) => {
      new Router({ ...deps, send: (msg) => resolve(msg) }).handle(request);
    });
  return { agentRegistry, bridge, deps, Router, invoke };
}

function workspace(...parts) {
  const dir = path.join(tmp, 'dirs', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const KNOBS = { priority: 1, launcher: 'shell' };

// ===========================================================================
rule('1. THE STATE, PRODUCED — four stranded records, three last events, one survivor');
// ===========================================================================

const produce = harness('fleet');
const read = harness('fleet');

const goneActive = workspace('gone-activated');
const goneStandby = workspace('gone-stood-down');
const goneUnstarted = workspace('gone-never-activated');
const goneUnstarted2 = workspace('gone-never-activated-2');
const survivor = workspace('survivor');

const all = [goneActive, goneStandby, goneUnstarted, goneUnstarted2, survivor];
for (const dir of all) {
  const res = await produce.invoke({ action: 'configure_agent', path: dir, ...KNOBS });
  if (!res.success) throw new Error(`fixture configure failed for ${dir}: ${res.error}`);
}

setCensus([ourPane(goneActive, '%100'), ourPane(goneStandby, '%101'), ourPane(survivor, '%102')]);
for (const dir of [goneActive, goneStandby, survivor]) {
  const res = await produce.invoke({ action: 'activate_agent', path: dir });
  if (!res.success) throw new Error(`fixture activate failed for ${dir}: ${res.error}`);
}
// `goneStandby` is switched off, so its last event is `deactivated` — a
// stranded record that `expectedAgents` never counted.
await produce.invoke({ action: 'deactivate_agent', path: goneStandby });

check(
  produce.agentRegistry.intents().size === 5,
  '(precondition) the registry holds all five records, so nothing below is asserted over an ' +
    'empty log',
  `${produce.agentRegistry.intents().size} intents`
);

// THE CONTROL, TAKEN BEFORE THE DELETION. Both counts must read 0 while every
// directory is real — otherwise the numbers after the deletion are not evidence
// that the deletion is what moved them.
setCensus([ourPane(goneActive, '%100'), ourPane(survivor, '%102')]);
const before = await read.invoke({ action: 'daemon_status' });
check(
  before.success === true &&
    before.configuredAgents === 5 &&
    before.expectedAgents === 2 &&
    before.expectedStranded === 0 &&
    before.strandedTotal === 0,
  '(control) with every directory present: 5 configured, 2 expected, and BOTH stranded counts ' +
    'read 0 — so a build that reported a non-zero regardless of the filesystem fails here ' +
    'rather than passing §2 by accident',
  `configured=${before.configuredAgents} expected=${before.expectedAgents} ` +
    `expectedStranded=${before.expectedStranded} strandedTotal=${before.strandedTotal}`
);

// THE TEARDOWN THAT CREATES THE DEFECT. Directories only — no `forget`, which
// is precisely what a proof teardown does.
setCensus([ourPane(survivor, '%102')]);
for (const dir of [goneActive, goneStandby, goneUnstarted, goneUnstarted2]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

check(
  [goneActive, goneStandby, goneUnstarted, goneUnstarted2].every((d) => !fs.existsSync(d)) &&
    fs.existsSync(survivor),
  '(precondition) four directories are gone and the fifth is not — so a count that reported ' +
    'all five, or none, would be measuring something other than the filesystem',
  `survivor present: ${fs.existsSync(survivor)}`
);

const status = await read.invoke({ action: 'daemon_status' });
const fleet = await read.invoke({ action: 'list_agents' });
check(
  status.success === true && fleet.success === true,
  '(precondition) both reads succeeded',
  `${status.error ?? ''} ${fleet.error ?? ''}`.trim()
);

// ===========================================================================
rule('2. `expectedAgents` IS ACCOUNTED FOR — what it counts and cannot start is said');
// ===========================================================================

check(
  status.expectedAgents === 2,
  '`expectedAgents` still counts both records whose last event is `activated`, including the ' +
    'one with no directory — the count is NOT narrowed, so it goes on describing the set ' +
    '`reconcile` restores from (`registry.expected()`, the same filter with no existence check)',
  `expectedAgents=${status.expectedAgents}`
);

check(
  status.expectedStranded === 1,
  '`expectedStranded` names the one of them that cannot be started, so the response says what ' +
    '`expectedAgents` alone could not: before this field, "2 expected to be running" was the ' +
    'whole answer and one of the two had nowhere to run',
  `expectedStranded=${status.expectedStranded}`
);

check(
  status.expectedAgents - status.expectedStranded === 1 &&
    fs.existsSync(survivor),
  'the subtraction a reader actually does lands on the survivor: `expectedAgents - ' +
    'expectedStranded` is 1, and there is exactly one activated record whose directory is ' +
    'still there',
  `${status.expectedAgents} - ${status.expectedStranded} = ` +
    `${status.expectedAgents - status.expectedStranded}`
);

check(
  status.configuredAgents === 5,
  '`configuredAgents` is unchanged and unqualified — it answers "what is in my registry", and a ' +
    'stranded record IS in the registry, so narrowing it would be the silent exclusion this ' +
    'ticket exists to remove rather than a second fix',
  `configuredAgents=${status.configuredAgents}`
);

// ===========================================================================
rule('3. THE TWO INSTRUMENTS AGREE — same registry, same head, same number');
// ===========================================================================

check(
  status.strandedTotal === fleet.strandedTotal,
  '`daemon_status.strandedTotal` and `list_agents.strandedTotal` report the same number for ' +
    'the same registry. THIS IS THE TICKET: the two responses disagreed about one row, and ' +
    'they now read one expression (`strandedIntents` in router.ts) rather than two copies of ' +
    'the membership test',
  `daemon_status=${status.strandedTotal} list_agents=${fleet.strandedTotal}`
);

check(
  status.strandedTotal === 4,
  'and the number they agree on is the right one: four records, three last events, no ' +
    'directories',
  `strandedTotal=${status.strandedTotal} paths=` +
    JSON.stringify((fleet.strandedAgents ?? []).map((r) => path.basename(r.path)).sort())
);

// ===========================================================================
rule('4. THEY ARE TWO POPULATIONS — an assertion no single number can satisfy');
// ===========================================================================
//
// The section the discriminating fixture exists for. A build that computed one
// count and published it under both names — the likeliest wrong implementation,
// because `list_agents.strandedTotal` was already there — passes §2 and §3 on a
// one-record fixture and fails here.

check(
  status.strandedTotal > status.expectedStranded,
  '`strandedTotal` (4) is strictly greater than `expectedStranded` (1) on this registry, so ' +
    'the two fields cannot be one number under two names. The difference is the three stranded ' +
    'records `expectedAgents` never counted: one `deactivated`-last and two ' +
    '`configured`-and-never-activated',
  `strandedTotal=${status.strandedTotal} expectedStranded=${status.expectedStranded}`
);

const strandedActivated = (fleet.strandedAgents ?? []).filter((r) => r.lastEvent === 'activated');
check(
  strandedActivated.length === status.expectedStranded,
  '`expectedStranded` is exactly the `activated`-last subset of the rows `list_agents` ' +
    'publishes — checked against those rows rather than against a second count, so the two ' +
    'surfaces are reconciled row by row and not only total by total',
  `activated-last rows=${strandedActivated.length} (${strandedActivated.map((r) => path.basename(r.path)).join(', ')})`
);

// ===========================================================================
rule('5. IT REACHES A PERSON — `crabcast daemon-status` says it, and only when true');
// ===========================================================================

const renderStatus = (res) =>
  commandNamed('daemon-status').render(new ResponseReader(res), {});

const rendered = renderStatus(status);
console.log(rendered.split('\n').filter((l) => /agents|stranded|cannot be started/.test(l))
  .map((l) => `    | ${l}`).join('\n'));

check(
  /cannot be started/.test(rendered) && /directory is gone/.test(rendered),
  'the caveat prints: a human running `crabcast daemon-status` is told that one of the ' +
    'expected agents has no directory, rather than reading "2 expected to be running" and ' +
    'being contradicted by `crabcast list` one command later',
  null
);

check(
  /forget/.test(rendered) && /stranded agents/.test(rendered),
  'and it names the verb that retires the record and the category that lists them, so the ' +
    'remedy is in the output rather than something the reader must already know',
  null
);

check(
  !/leftovers|other fields in the daemon/.test(rendered),
  'both new fields are CONSUMED by the renderer rather than falling into the "other fields in ' +
    "the daemon's response\" residue block — which is what a field added to the wire and not to " +
    'the CLI looks like',
  null
);

const cleanRender = renderStatus(before);
check(
  !/cannot be started/.test(cleanRender),
  'and it is silent on a clean registry: the control response renders the plain sentence with ' +
    'no caveat, so the line is a finding rather than boilerplate',
  cleanRender.split('\n').find((l) => /agents:/.test(l))?.trim()
);

// ===========================================================================
rule('6. THE RECONCILE RULING — a restore of a vanished path, as a run (KAN-619 Q2)');
// ===========================================================================
//
// Question 2 was whether `reconcile` should stop retrying a restore whose path
// cannot resolve. The ruling is that it keeps trying and stops calling it
// `failed` — see `RECONCILE_STRANDED` in reconcile.ts for why. This section is
// that ruling as a run rather than an assertion about one.

const recon = harness('reconcile-fleet');
const reconGone = workspace('reconcile-gone');
await recon.invoke({ action: 'configure_agent', path: reconGone, ...KNOBS });
setCensus([ourPane(reconGone, '%200')]);
await recon.invoke({ action: 'activate_agent', path: reconGone });
setCensus([]);
fs.rmSync(reconGone, { recursive: true, force: true });

const expectedBefore = recon.agentRegistry.expected().map((r) => r.path);
const reconLog = [];
const result = await reconcileAgents({
  registry: recon.agentRegistry,
  herdrBridge: recon.bridge,
  router: new recon.Router({ ...recon.deps, send: () => {} }),
  cause: 'reboot',
  log: (...a) => reconLog.push(a.join(' '))
});
const expectedAfter = recon.agentRegistry.expected().map((r) => r.path);
const outcome = result.outcomes.find((o) => o.path === reconGone);
console.log(reconLog.map((l) => `    | ${l}`).join('\n'));

check(
  outcome?.result === 'stranded',
  'the outcome is `stranded` and not `failed`. Before this ticket it was `failed`, carrying ' +
    "`canonicalPath`'s admission message — which ends \"create it first, then configure it\", " +
    'the remedy for a typo at `configure` time and the opposite of what this record wants',
  `result=${outcome?.result}`
);

check(
  reconLog.some((l) => /is stranded/.test(l) && /forget/.test(l) && /mount is late/.test(l)),
  'and the log line names the verb that retires it AND why this pass will try again anyway, so ' +
    'a boot summary reading "1 stranded" does not send anybody to recreate a directory nobody ' +
    'wants back',
  null
);

check(
  expectedBefore.includes(reconGone) && expectedAfter.includes(reconGone),
  'NOTHING WAS RECORDED: the record is in `expected()` before the pass and after it, so the ' +
    'retry the ruling preserves is still there. A build that "stopped retrying" by writing a ' +
    'durable row would be the delete KAN-594 refused, reached by a different door',
  `before=${expectedBefore.length} after=${expectedAfter.length}`
);

check(
  result.outcomes.filter((o) => o.result === 'failed').length === 0,
  'and no outcome in the pass is `failed`, so the ordinary residue of finished workspaces no ' +
    'longer reads as a fleet that came back short',
  JSON.stringify(result.outcomes.map((o) => o.result))
);

// ===========================================================================
rule('7. THE RED HALF — the checks above, watched failing');
// ===========================================================================

const mutationScratch = path.join(tmp, 'mutants');
fs.mkdirSync(mutationScratch, { recursive: true });
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch: mutationScratch,
  report: {
    pass: (claim, detail) => check(true, claim, detail),
    fail: (claim, detail) => check(false, claim, detail)
  }
});

/** Stand the SAME five-record fixture up against a mutated build and read it back. */
async function statusOn(mutantDir, tag) {
  const Router = (await import(path.join(mutantDir, 'router.js'))).MessageRouter;
  const Registry = (await import(path.join(mutantDir, 'agent-registry.js'))).AgentRegistry;
  const mp = harness(`mut-${tag}`, { MessageRouter: Router, AgentRegistry: Registry });
  const mr = harness(`mut-${tag}`, { MessageRouter: Router, AgentRegistry: Registry });
  const live = workspace('mut', tag, 'survivor');
  const dead = workspace('mut', tag, 'gone-activated');
  const deadUnstarted = workspace('mut', tag, 'gone-never-activated');
  for (const d of [live, dead, deadUnstarted]) {
    await mp.invoke({ action: 'configure_agent', path: d, ...KNOBS });
  }
  setCensus([ourPane(live, '%900'), ourPane(dead, '%901')]);
  for (const d of [live, dead]) await mp.invoke({ action: 'activate_agent', path: d });
  setCensus([ourPane(live, '%900')]);
  fs.rmSync(dead, { recursive: true, force: true });
  fs.rmSync(deadUnstarted, { recursive: true, force: true });
  return {
    status: await mr.invoke({ action: 'daemon_status' }),
    fleet: await mr.invoke({ action: 'list_agents' })
  };
}

theSilentCount: {
  // THE DEFECT AS FILED, reproduced: `daemon_status` counts the record and
  // discloses nothing about it. §2's subject.
  const dir = mutate('daemon-status-discloses-nothing', 'router.js',
    `            expectedStranded: strandedRecords.filter(([, i]) => i.event === 'activated').length,`,
    `            expectedStranded: 0,`);
  if (!dir) break theSilentCount;

  const { status: mutant, fleet: mutantFleet } = await statusOn(dir, 'silent');
  check(
    mutant.expectedAgents === 2 && mutant.expectedStranded === 0 &&
      mutantFleet.strandedTotal === 2,
    '§2 GOES RED against a build whose `expectedStranded` is blind to the filesystem: ' +
      '`daemon_status` says 2 expected to be running with nothing stranded, while ' +
      '`list_agents` on the same registry reports 2 stranded records. The defect as filed, ' +
      'reproduced',
    `expectedAgents=${mutant.expectedAgents} expectedStranded=${mutant.expectedStranded} ` +
      `list_agents.strandedTotal=${mutantFleet.strandedTotal}`
  );
}

theOneNumberTwice: {
  // THE LIKELIEST WRONG FIX, reproduced: both fields carry the whole-registry
  // count, so `expectedAgents - expectedStranded` under-reports what can be
  // started. §4's subject, and the reason §4 exists.
  const dir = mutate('one-number-under-two-names', 'router.js',
    `            expectedStranded: strandedRecords.filter(([, i]) => i.event === 'activated').length,`,
    `            expectedStranded: strandedRecords.length,`);
  if (!dir) break theOneNumberTwice;

  const { status: mutant } = await statusOn(dir, 'twice');
  check(
    mutant.expectedStranded === mutant.strandedTotal &&
      mutant.expectedAgents - mutant.expectedStranded === 0,
    '§4 GOES RED against a build that publishes one count under both names: the two fields are ' +
      'equal, and `expectedAgents - expectedStranded` reads 0 startable agents on a registry ' +
      'whose survivor is running. A one-stranded-record fixture could not have caught this',
    `expectedStranded=${mutant.expectedStranded} strandedTotal=${mutant.strandedTotal} ` +
      `startable=${mutant.expectedAgents - mutant.expectedStranded}`
  );
}

theSecondCopy: {
  // THE DEFECT CLASS, reproduced: a SECOND membership test, which is how the
  // two instruments came to disagree in the first place. §3's subject.
  const dir = mutate('daemon-status-keeps-its-own-membership-test', 'router.js',
    `        const strandedRecords = this.strandedIntents(intents);`,
    `        const strandedRecords = Array.from(intents.entries()).filter(([p]) => p.includes('/tmp/nowhere'));`);
  if (!dir) break theSecondCopy;

  const { status: mutant, fleet: mutantFleet } = await statusOn(dir, 'copy');
  check(
    mutant.strandedTotal !== mutantFleet.strandedTotal,
    '§3 GOES RED against a build whose `daemon_status` keeps a membership test of its own: the ' +
      'two responses disagree about one registry again, which is the whole defect and is ' +
      'exactly what a second copy of the rule buys',
    `daemon_status=${mutant.strandedTotal} list_agents=${mutantFleet.strandedTotal}`
  );
}

// ===========================================================================
console.log(`\n${'='.repeat(78)}`);
const skipped = mutationsSkipped();
if (skipped.length) {
  // Named beside the verdict so a failure count is not read as ordinary
  // assertion failures when what happened is that a section never ran.
  console.log(`MUTATIONS THAT DID NOT APPLY: ${skipped.join(', ')}`);
}
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log('ALL CHECKS PASSED');
}
console.log('='.repeat(78));
process.exit(failures.length ? 1 : 0);
