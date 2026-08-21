#!/usr/bin/env node
// Proof for KAN-594: a registry record whose DIRECTORY IS GONE is reported,
// exactly once, and in a sentence that does not assert the directory.
//
// WHAT FAILURE THIS WOULD CATCH: a fleet read that answers for fewer records
// than the registry holds and says nothing about the difference. Before this
// ticket a record whose directory had been deleted reached a reader in one of
// two wrong ways, and this script fails on either coming back:
//
//   (a) SILENTLY DROPPED. `standbyAgents` and `unstartedAgents` each ended with
//       a bare `if (!fs.existsSync(agentPath)) continue`. That filter is right
//       about what it was written for — neither list may offer a switch that
//       cannot be thrown — and it was quietly doing a SECOND job nobody argued
//       for, which was deciding the record should not be REPORTED either. The
//       row left the response altogether: still in the registry, still counted
//       by anything counting intents, and visible on no surface.
//   (b) KEPT AND DESCRIBED WRONGLY. `missingAgents` had no existence check at
//       all, so an `activated`-last record with no directory was reported with
//       *"herdr has no live agent in its directory and this daemon holds no
//       session for it"* — a sentence asserting a directory that is not there,
//       inviting a re-activation that `activate` then refuses.
//
// ⚠ THE TWO FAILURES POINT IN OPPOSITE DIRECTIONS AND BOTH ARE CHECKED, because
// a proof against only one of them licenses the other: a build that fixed the
// silent drop by pushing every stranded row into `missingAgents` would satisfy
// a §1 that only counted rows, and would be defect (b) at a larger size.
//
// ---------------------------------------------------------------------------
// THE POPULATION THIS WAS FILED ABOUT, because it decides the fixture
// ---------------------------------------------------------------------------
//
// Thirteen rows in the live registry on 2026-08-21, from one proof family's
// fixtures: `configure`d at directories under `/tmp` that EXISTED at the time,
// then deleted at teardown with no `forget`. So the fixture below does not
// write a stranded row and then assert that stranded rows are reported — that
// is the KAN-145 shape, and a proof that supplies its own input has not tested
// that the input arrives. It stands the agents up THROUGH THE ROUTER, which is
// what proves `configure` accepted them (their directories were real), and then
// deletes the directories, which is what a teardown does.
//
// ⚠ AND THE TEST IS THE FILESYSTEM, NEVER A `/tmp` PREFIX. KAN-594 named that
// trap when it asked for this: a prefix filter would have made exactly these
// rows stop being counted — invisible rather than accounted for, the defect
// wearing the fix's clothes — and a prefix is not a fact about provenance
// anyway. §5 is the check that keeps this honest, and it is the reason this
// script's stranded fixtures are NOT all under the scratch root.
//
// ---------------------------------------------------------------------------
// WHAT IS PRODUCED, WHAT IS WRITTEN, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// EVERYTHING ASSERTED ON IS PRODUCED. Every registry row here is written by the
// real `configure_agent` / `activate_agent` / `deactivate_agent` handlers on the
// real router, and every response is a real `list_agents` off a fresh router
// over that registry. Nothing hand-writes a row and nothing hand-builds a
// response.
//
// WHAT THIS SCRIPT DOES NOT COVER, and who does:
//
//   * A REAL herdr. The census is a shell stub, so what is established is the
//     daemon's reconciliation over a census rather than herdr's reporting of
//     one. `verify-fleet-enumeration.mjs` drives a real daemon over a socket.
//   * THE CLI AND MCP RENDERINGS of this category beyond §4's one assertion
//     that the heading exists and the rows print. `verify-cli-parity.mjs` owns
//     the general claim that every category reaches both surfaces.
//   * WHETHER A REAL PROOF TEARDOWN leaves rows behind. That is the Butchr side
//     and is deliberately not this ticket — see KAN-524 §6 and KAN-519.
//   * WHETHER `forget` RETIRES A STRANDED ROW. §6 asserts it, and it is the one
//     section here whose subject is another verb; `verify-idempotent-lifecycle`
//     owns `forget` in general.
//
// Usage:
//   npm run build
//   node scripts/verify-stranded-agents.mjs [distDir]

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
const { commandNamed, ResponseReader } = await import(path.join(distDir, 'cli.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan594-'));
// §5 needs one stranded record whose path is NOT under the scratch root, so
// that "reported because the directory is gone" can be told apart from
// "reported because the path looked like a fixture". It is created, configured
// and deleted exactly like the others; it simply lives somewhere else.
const offRoot = fs.mkdtempSync(path.join(os.homedir(), '.crabcast-kan594-'));
const realPath = process.env.PATH;
function cleanup() {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(offRoot, { recursive: true, force: true });
}
process.on('exit', cleanup);
// TEARDOWN OFF THE HAPPY PATH. Nothing here spawns a daemon or a PTY — the
// router is driven in-process and the herdr binary is a shell stub that exits —
// so what an interrupt would leave behind is two scratch trees and a mutated
// PATH. All three are put back here rather than only at the end of a clean run.
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
setCensus([]);

const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});

function harness(logName, Ctors = {}) {
  const Router = Ctors.MessageRouter ?? MessageRouter;
  const Registry = Ctors.AgentRegistry ?? AgentRegistry;
  const agentRegistry = new Registry(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const invoke = (request) =>
    new Promise((resolve) => {
      new Router({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: () => {}
      }).handle(request);
    });
  return { agentRegistry, invoke };
}

function workspace(root, ...parts) {
  const dir = path.join(root, 'dirs', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const KNOBS = { priority: 1, launcher: 'shell' };

/** The sentence a stranded row must NOT carry: it asserts a directory. */
const ASSERTS_A_DIRECTORY = 'herdr has no live agent in its directory';

const strandedFor = (res, dir) => (res.strandedAgents ?? []).find((r) => r.path === dir);
const pathsIn = (rows) => (rows ?? []).map((r) => r.path);

// ===========================================================================
rule('1. THE STATE, PRODUCED — three records, three last events, no directories');
// ===========================================================================
//
// The three shapes a stranded record can have, because `intents()` keeps the
// last event per path and drops `forgotten`. Each is stood up through the real
// verbs, and only then is its directory removed — which is the order a proof
// teardown does it in, and the order that makes `configure`'s own existence
// check irrelevant to how the row got here.

const produce = harness('fleet');
const read = harness('fleet');

const neverRan = workspace(tmp, 'never-ran');
const ranThenGone = workspace(tmp, 'ran-then-gone');
const stoodDown = workspace(tmp, 'stood-down');
const offRootDir = workspace(offRoot, 'off-root');
const survivor = workspace(tmp, 'survivor');

for (const dir of [neverRan, ranThenGone, stoodDown, offRootDir, survivor]) {
  const res = await produce.invoke({ action: 'configure_agent', path: dir, ...KNOBS });
  if (!res.success) throw new Error(`fixture configure failed for ${dir}: ${res.error}`);
}

// `ranThenGone` is activated and left activated — the `missingAgents` shape.
setCensus([ourPane(ranThenGone, '%100'), ourPane(stoodDown, '%101')]);
await produce.invoke({ action: 'activate_agent', path: ranThenGone });
await produce.invoke({ action: 'activate_agent', path: stoodDown });
// `stoodDown` is then switched off — the `standbyAgents` shape.
await produce.invoke({ action: 'deactivate_agent', path: stoodDown });

check(
  produce.agentRegistry.intents().size === 5,
  '(precondition) the registry holds all five records, so the assertions below are not ' +
    'over an empty log',
  `${produce.agentRegistry.intents().size} intents`
);

// THE TEARDOWN THAT CREATES THE DEFECT. Directories only — no `forget`, which
// is precisely what the proof runs that commissioned this ticket did.
setCensus([]);
for (const dir of [neverRan, ranThenGone, stoodDown, offRootDir]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

check(
  [neverRan, ranThenGone, stoodDown, offRootDir].every((d) => !fs.existsSync(d)) &&
    fs.existsSync(survivor),
  '(precondition) four directories are gone and the fifth is not — so a category that ' +
    'reported all five, or none, would be measuring something other than the filesystem',
  `survivor present: ${fs.existsSync(survivor)}`
);

const fleet = await read.invoke({ action: 'list_agents' });
check(fleet.success === true, '(precondition) the fleet read succeeded', fleet.error);

// ===========================================================================
rule('2. EVERY STRANDED RECORD IS REPORTED — none falls out of the response');
// ===========================================================================

check(
  fleet.strandedTotal === 4,
  'strandedTotal counts all four records whose directory is gone — the count is the claim ' +
    'the registry is accounted for, and before this category it was silently 0',
  `strandedTotal=${fleet.strandedTotal}, paths=${JSON.stringify(pathsIn(fleet.strandedAgents))}`
);

for (const [dir, expected, label] of [
  [neverRan, 'configured', 'configured and never run'],
  [ranThenGone, 'activated', 'recorded active'],
  [stoodDown, 'deactivated', 'switched off']
]) {
  const row = strandedFor(fleet, dir);
  check(
    row?.lastEvent === expected,
    `a ${label} record is reported with lastEvent="${expected}" — the field that says ` +
      'whether it ever ran, which is the configured-versus-line-count distinction KAN-594 ' +
      'asked to be made explicit',
    `lastEvent=${row?.lastEvent}`
  );
}

check(
  (fleet.strandedAgents ?? []).every((r) => typeof r.reason === 'string' && r.reason.length > 0) &&
    (fleet.strandedAgents ?? []).every((r) => r.config !== undefined),
  'every stranded row carries a reason and the durable config echo — a row a reader can act ' +
    'on rather than a bare path',
  `${(fleet.strandedAgents ?? []).length} row(s)`
);

// ===========================================================================
rule('3. EXACTLY ONE CATEGORY — the disjointness the other four are drawn on');
// ===========================================================================
//
// The half that stops the opposite defect. A build that "fixed" the silent drop
// by leaving these rows in `missingAgents` as well would pass §2 and would be
// the pre-fix daemon at a larger size.

for (const [dir, label] of [
  [neverRan, 'a configured record'],
  [ranThenGone, 'an activated record'],
  [stoodDown, 'a stood-down record']
]) {
  const elsewhere = [
    ['missingAgents', pathsIn(fleet.missingAgents)],
    ['standbyAgents', pathsIn(fleet.standbyAgents)],
    ['unstartedAgents', pathsIn(fleet.unstartedAgents)],
    ['preemptedAgents', pathsIn(fleet.preemptedAgents)],
    ['agents', pathsIn(fleet.agents)]
  ].filter(([, paths]) => paths.includes(dir)).map(([name]) => name);
  check(
    elsewhere.length === 0 && !!strandedFor(fleet, dir),
    `${label} whose directory is gone is in strandedAgents and in NO other category`,
    elsewhere.length ? `also in: ${elsewhere.join(', ')}` : 'in strandedAgents only'
  );
}

check(
  !(fleet.missingAgents ?? []).some((r) => r.reason?.includes(ASSERTS_A_DIRECTORY) &&
    !fs.existsSync(r.path)),
  'no missingAgents row says "herdr has no live agent in its directory" about a directory ' +
    'that does not exist — the sentence that was asserting a thing that was not there',
  `missingTotal=${fleet.missingTotal}`
);

check(
  pathsIn(fleet.unstartedAgents).includes(survivor),
  '(control) the record whose directory SURVIVES is still in unstartedAgents — so §3 is ' +
    'measuring the existence test rather than an emptied response',
  `unstartedTotal=${fleet.unstartedTotal}`
);

// ===========================================================================
rule('4. IT REACHES A PERSON — the category prints, with its rows');
// ===========================================================================

const rendered = commandNamed('list').render(new ResponseReader({ ...fleet }), {});
const heading = rendered.split('\n').find((l) => l.startsWith('stranded agents ('));
check(
  typeof heading === 'string' && heading.includes('(4)'),
  '`crabcast list` prints a stranded agents heading carrying the count',
  heading
);
check(
  rendered.includes(neverRan) && rendered.includes(ranThenGone) && rendered.includes(stoodDown),
  'and prints the paths, so the record a reader has to `forget` is one they can copy',
  `${rendered.split('\n').filter((l) => l.includes('forget')).length} line(s) mention forget`
);

// ===========================================================================
rule('5. THE TEST IS THE FILESYSTEM AND NOT A PATH PREFIX');
// ===========================================================================
//
// ⚠ THE CHECK KAN-594 ASKED FOR BY NAME. A `/tmp` filter would have satisfied
// every section above on this fixture, because four of the five directories are
// under the scratch root. `offRootDir` is not, and `survivor` is under it and
// still exists — so the two together separate "gone" from "looks like a
// fixture" in both directions.

check(
  !!strandedFor(fleet, offRootDir),
  'a stranded record OUTSIDE the scratch root is reported — a prefix filter would have ' +
    'missed it, so this row is what says the test is existence rather than location',
  offRootDir
);
check(
  !strandedFor(fleet, survivor) && survivor.startsWith(tmp),
  'and a record INSIDE the scratch root whose directory still exists is NOT reported — the ' +
    'other direction, without which a category that reported every scratch path would pass',
  survivor
);

// ===========================================================================
rule('6. NOTHING IS DELETED — the record is disclosed, and `forget` retires it');
// ===========================================================================
//
// The limit stated in `strandedAgents`' own doc comment, checked rather than
// asserted: compaction never drops an agent, because a directory can also be
// absent because a mount is late. Reporting is not retiring.

const rowsAfterRead = read.agentRegistry.intents().size;
check(
  rowsAfterRead === 5,
  'reading the fleet removed no record — all five intents survive a `list_agents` that ' +
    'reported four of them as stranded',
  `${rowsAfterRead} intents after the read`
);

const forgotten = await produce.invoke({ action: 'forget_agent', path: neverRan });
check(
  forgotten.success === true,
  '`forget` accepts a stranded record — the verb addresses a RECORD rather than a directory, ' +
    'which is what makes it the remedy this category names',
  forgotten.error ?? 'success'
);

const afterForget = await harness('fleet').invoke({ action: 'list_agents' });
check(
  afterForget.strandedTotal === 3 && !strandedFor(afterForget, neverRan),
  'and the forgotten record leaves the category — so the count is a live measurement a ' +
    'person can drive to zero, not a tally that only grows',
  `strandedTotal ${fleet.strandedTotal} -> ${afterForget.strandedTotal}`
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

/** Stand the SAME fixture up against a mutated build and read it back. */
async function fleetOn(mutantDir, tag) {
  const Router = (await import(path.join(mutantDir, 'router.js'))).MessageRouter;
  const Registry = (await import(path.join(mutantDir, 'agent-registry.js'))).AgentRegistry;
  const mProduce = harness(`mut-${tag}`, { MessageRouter: Router, AgentRegistry: Registry });
  const mRead = harness(`mut-${tag}`, { MessageRouter: Router, AgentRegistry: Registry });
  const gone = workspace(tmp, 'mut', tag, 'gone');
  await mProduce.invoke({ action: 'configure_agent', path: gone, ...KNOBS });
  setCensus([ourPane(gone, '%900')]);
  await mProduce.invoke({ action: 'activate_agent', path: gone });
  setCensus([]);
  fs.rmSync(gone, { recursive: true, force: true });
  return { res: await mRead.invoke({ action: 'list_agents' }), gone };
}

theSilentDrop: {
  // Defect (a), reproduced: the category stops collecting, which is what the
  // response looked like before it existed. §2's subject.
  const dir = mutate('stranded-collects-nothing', 'router.js',
    `        for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
            if (fs.existsSync(agentPath))
                continue;`,
    `        for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
            if (true)
                continue;`);
  if (!dir) break theSilentDrop;

  const { res, gone } = await fleetOn(dir, 'silent');
  check(
    res.strandedTotal === 0 && !pathsIn(res.standbyAgents).includes(gone) &&
      !pathsIn(res.unstartedAgents).includes(gone),
    '§2 GOES RED against a build whose stranded category collects nothing: the record is in ' +
      'the registry, in no category, and no total on the response says so. The silent drop, ' +
      'reproduced',
    `strandedTotal=${res.strandedTotal}`
  );
}

theWrongSentence: {
  // Defect (b), reproduced: `missingAgents` keeps its existence-blind behaviour
  // and describes a directory that is not there. §3's subject, and the opposite
  // error from the one above.
  const dir = mutate('missing-is-blind-to-the-filesystem', 'router.js',
    `            if (!fs.existsSync(agentPath))
                continue;
            const occupant = occupants.get(agentPath) ?? null;`,
    `            const occupant = occupants.get(agentPath) ?? null;`);
  if (!dir) break theWrongSentence;

  const { res, gone } = await fleetOn(dir, 'blind');
  const row = (res.missingAgents ?? []).find((r) => r.path === gone);
  check(
    !!row && row.reason?.includes(ASSERTS_A_DIRECTORY) && !fs.existsSync(gone),
    '§3 GOES RED against a build whose missingAgents is blind to the filesystem: the row ' +
      'asserts herdr has no live agent "in its directory" for a directory that does not ' +
      'exist, and invites a re-activation `activate` would refuse. The wrong sentence, ' +
      'reproduced',
    row?.reason
  );
  check(
    !!row && !!(res.strandedAgents ?? []).find((r) => r.path === gone),
    'and the same mutant puts one record in TWO categories, which is why §3 checks ' +
      'disjointness rather than only counting rows',
    `in missingAgents and strandedAgents: ${!!row}`
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
