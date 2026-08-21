#!/usr/bin/env node
// Proof for KAN-572: one run of `crabcast list` cannot name a live pane in one
// section and say the same directory is empty in another.
//
// WHAT FAILURE THIS WOULD CATCH: a `missingAgents` row that asserts *"herdr has
// no live agent in its directory"* about a directory the SAME RESPONSE reports
// under `foreignPanes` as occupied by a live pane. Not a wrong classification —
// no agent OF OURS is running there, and that verdict is correct and stays
// correct. What it catches is a correct verdict travelling with a FALSE
// "because" attached, and the "because" is the half nobody re-checks.
//
// ---------------------------------------------------------------------------
// THE DEFECT, AS MEASURED
// ---------------------------------------------------------------------------
//
// `epic/KAN-203` read one `crabcast list` top to bottom on 2026-08-21. Under
// `foreign panes (6) — live agents this daemon did not start`:
//
//     claude [blocked]  runtime claude  pane_id w1:p4
//       cwd .../workspaces/epic/kan-203
//       OCCUPIES .../workspaces/epic/kan-203
//
// and sixty lines further down, in the same output, under `missing agents (7) —
// recorded active, not running: their work has stopped while still looking
// staffed`:
//
//     .../workspaces/epic/kan-203 — since 2026-08-20T17:11:36.623Z
//       The registry records this agent as active, but herdr has no live agent
//       in its directory and this daemon holds no session for it. It is not
//       running.
//
// That workspace was the guardian, and it produced the output.
//
// ⚠ IT IS NOT COSMETIC, and this is why the proof exists rather than a doc fix.
// The section header reads *"their work has stopped"*, every row ends with
// `next activate: RESUMES the conversation it was stopped in`, and 3 of the 7
// workspaces listed were demonstrably alive at that moment. So the output
// invites a supervisor to resume three conversations nobody stopped. **A false
// red that recommends a destructive remedy is worse than a false green, because
// the remedy is the damage.**
//
// THE MECHANISM, established here rather than assumed. Ownership is NAME-scoped
// and the sentence was DIRECTORY-scoped. `ourPaneIn` (src/herdr.ts) asks the
// census for a pane called `paneNameFor(path)`; a stranger's pane in that very
// directory carries a name CrabCast did not derive, so the answer is "no pane of
// ours" — correct — and the row then went on to say herdr had nothing there at
// all. §1's fixture is that exact shape and §6's first mutant is that exact
// build.
//
// ---------------------------------------------------------------------------
// WHAT IS PRODUCED AND WHAT IS WRITTEN — read this before trusting a section
// ---------------------------------------------------------------------------
//
// THE STATE IS PRODUCED. §1 stands the agent up through `configure_agent` and
// `activate_agent` on the real router against a herdr stub, then takes its pane
// out of the census and puts a foreign one in its place — which is what an
// occupied loss IS. Nothing here writes a registry row carrying an `occupiedBy`
// and then asserts that the daemon carries `occupiedBy`; that is the KAN-145
// shape, and a proof that supplies its own input has not tested that the input
// arrives.
//
// ONE THING IS WRITTEN, named so nobody infers a coverage that is not here: §4
// builds the `agent.lost` ENVELOPE by hand (`action`/`at`/`seq`/`bootId`) around
// a row it got from the real `findMissingAgents()`. The daemon's own line is
// `broadcast({ action: 'agent.lost', ...agent })`, so the payload under test is
// produced and only the four envelope fields are synthetic. What that leaves
// uncovered is whether the sweep TIMER fires and whether `announcedMissing`
// latches correctly — `verify-event-contract.mjs` owns the first and KAN-79's
// latch is not this ticket's subject.
//
// WHAT THIS SCRIPT DOES NOT COVER, and who does:
//
//   * A REAL herdr. The census is a stub, so what is proven is the daemon's own
//     reconciliation over a census rather than herdr's reporting of one.
//   * A REAL FOREIGN PANE — a second `claude` genuinely started by hand in a
//     configured directory. That is what `epic/KAN-203` observed live and what
//     the ticket records; nothing on a CI runner can reproduce it.
//   * WHETHER `activate` REFUSES an occupied directory. The rows here SAY it
//     will, and `verify-refuses-occupied-directory.mjs` is what establishes it.
//     This proof asserts the sentence is written, never that the refusal works.
//
// Usage:
//   npm run build
//   node scripts/verify-missing-agent-occupancy.mjs [distDir]

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
const { projectEvent } = await import(path.join(distDir, 'events.js'));
const { commandNamed, ResponseReader } = await import(path.join(distDir, 'cli.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan572-'));
const realPath = process.env.PATH;
function cleanup() {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
// TEARDOWN OFF THE HAPPY PATH. Nothing here spawns a daemon or a PTY — the
// router is driven in-process and the herdr binary is a shell stub that exits —
// so what an interrupt would leave behind is the scratch tree and a mutated
// PATH. Both are put back here rather than only at the end of a clean run.
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

/** A pane CrabCast would recognise as its own: the name is derived from the path. */
const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});

/**
 * A pane in `dir` that CrabCast did NOT start, and the whole fixture in one
 * object: its `name` is a name this daemon never derives, which is what makes
 * the name-scoped ownership test answer "not ours" while the directory is very
 * much occupied.
 */
const foreignPane = (dir, paneId, name) => ({
  name, pane_id: paneId, agent: 'claude', agent_status: 'blocked', cwd: dir
});

function harness(logName, Ctors = {}) {
  const Router = Ctors.MessageRouter ?? MessageRouter;
  const Registry = Ctors.AgentRegistry ?? AgentRegistry;
  const agentRegistry = new Registry(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const build = () =>
    new Router({
      config,
      herdrBridge: bridge,
      daemonStartedAt: new Date(),
      agentRegistry,
      send: () => {},
      broadcast: () => {}
    });
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
  return { agentRegistry, invoke, build };
}

function workspace(...parts) {
  const dir = path.join(tmp, 'dirs', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const KNOBS = { priority: 1, launcher: 'shell' };

/** The sentence the row must NOT say about an occupied directory. */
const FLAT_CLAIM = 'herdr has no live agent in its';
/** The gloss the section header must NOT carry while a row is occupied. */
const STOPPED_GLOSS = 'their work has stopped while still looking staffed';

const rowFor = (res, dir) => (res.missingAgents ?? []).find((m) => m.path === dir);
const foreignFor = (res, dir) => (res.foreignPanes ?? []).find((p) => p.occupies === dir);

// ===========================================================================
rule('1. THE COLLISION, PRODUCED — one response, one directory, both sections');
// ===========================================================================
//
// THE PRECONDITION FOR EVERYTHING BELOW. If the fixture does not really produce
// a directory that is in `missingAgents` AND named by a `foreignPanes` row, then
// §§2-5 assert over rows that do not exist and report a completeness nobody
// achieved. That is the vacuous pass this suite is shaped against.
//
// TWO ROUTERS OVER ONE REGISTRY, and the second is not a convenience: a router
// that performed the activation still holds that agent's SESSION, and an agent
// this daemon is attached to is running whatever the census says. So the state
// is produced by one and read by a FRESH one — which is exactly the situation a
// missing agent arises in.

const produce = harness('fleet');
const read = harness('fleet');

const OCCUPIED = workspace('occupied');
const EMPTY = workspace('empty');
const FOREIGN_PANE_NAME = 'a-pane-crabcast-never-named';
const FOREIGN_PANE_ID = 'w1:p4';

let occupiedRow;
let emptyRow;
let fleet;

{
  for (const dir of [OCCUPIED, EMPTY]) {
    await produce.invoke({ action: 'configure_agent', path: dir, ...KNOBS });
    setCensus([ourPane(dir, '%100')]);
    await produce.invoke({ action: 'activate_agent', path: dir });
  }

  // THE CENSUS THE WHOLE SUITE READS. `OCCUPIED` holds a live pane under a name
  // this daemon never derives; `EMPTY` holds nothing at all. Both agents are
  // recorded as activated, so both are losses — and only one of them is a
  // directory where work has stopped.
  setCensus([foreignPane(OCCUPIED, FOREIGN_PANE_ID, FOREIGN_PANE_NAME)]);

  fleet = await read.invoke({ action: 'list_agents' });
  occupiedRow = rowFor(fleet, OCCUPIED);
  emptyRow = rowFor(fleet, EMPTY);
  const foreign = foreignFor(fleet, OCCUPIED);

  check(
    fleet.success === true && !!occupiedRow && !!emptyRow,
    '(precondition) both agents are reported as missing — the classification is unchanged, ' +
      'and this proof is not about changing it',
    `missingAgents: ${(fleet.missingAgents ?? []).map((m) => path.basename(m.path)).join(', ')}`
  );
  check(
    !!foreign && foreign.paneName === FOREIGN_PANE_NAME,
    '(precondition) the SAME response reports a live foreign pane OCCUPYING that directory — ' +
      'this is the contradiction, in one response, reproduced',
    `foreignPanes[].occupies=${foreign?.occupies} paneName=${foreign?.paneName} ` +
      `paneId=${foreign?.paneId} runtime=${foreign?.agentRuntime}`
  );
  check(
    !foreignFor(fleet, EMPTY),
    '(precondition) and the control directory is occupied by nothing — without it every ' +
      'predicate below would be applied only to rows that satisfy it',
    `foreignPanes for ${path.basename(EMPTY)}: none`
  );
}

// ===========================================================================
rule('2. THE OCCUPIED ROW SAYS SO — the field, and the sentence that stopped lying');
// ===========================================================================
{
  check(
    !!occupiedRow?.occupiedBy,
    'the missing row carries `occupiedBy` rather than leaving the join to the reader',
    JSON.stringify(occupiedRow?.occupiedBy)
  );
  check(
    occupiedRow?.occupiedBy?.paneName === FOREIGN_PANE_NAME &&
      occupiedRow?.occupiedBy?.paneId === FOREIGN_PANE_ID &&
      occupiedRow?.occupiedBy?.herdrStatus === 'blocked' &&
      occupiedRow?.occupiedBy?.agentRuntime === 'claude',
    'and it quotes the same census record `foreignPanes` quotes — all four fields, so the two ' +
      'sections of one response cannot disagree about one directory',
    `occupiedBy=${JSON.stringify(occupiedRow?.occupiedBy)}`
  );
  check(
    typeof occupiedRow?.reason === 'string' && !occupiedRow.reason.includes(FLAT_CLAIM),
    `the reason no longer asserts ${JSON.stringify(FLAT_CLAIM)} about a directory this ` +
      'response shows occupied — that assertion is the defect',
    occupiedRow?.reason
  );
  check(
    typeof occupiedRow?.reason === 'string' &&
      occupiedRow.reason.includes(FOREIGN_PANE_NAME) &&
      /refused/i.test(occupiedRow.reason),
    'and it names the pane and says the remedy this category invites — re-activation — will ' +
      'be REFUSED, which is the half a reader acts on',
    occupiedRow?.reason
  );
}

// ===========================================================================
rule('3. THE CONTROL ROW IS UNTOUCHED — the predicate discriminates');
// ===========================================================================
//
// ⚠ WITHOUT THIS SECTION §2 IS A CLAIM ABOUT ONE ROW RATHER THAN ABOUT THE
// RULE. A build that dropped the flat sentence for EVERY row, occupied or not,
// would pass every check above — and would have deleted a true statement about
// an agent that really did stop. The ordinary loss must still read exactly as
// it did.
{
  check(
    emptyRow?.occupiedBy === null,
    '`occupiedBy` is null on an ordinary loss — the answer "nothing is running there", not ' +
      'an absent key that could be read as "we did not look"',
    `occupiedBy=${JSON.stringify(emptyRow?.occupiedBy)}`
  );
  check(
    typeof emptyRow?.reason === 'string' && emptyRow.reason.includes(FLAT_CLAIM),
    'and its reason still says herdr has no live agent in its directory — because for THIS ' +
      'row that is true, and the fix must not delete a true sentence',
    emptyRow?.reason
  );
}

// ===========================================================================
rule('4. `agent.lost` CARRIES IT — the fix is where the classification is computed');
// ===========================================================================
//
// The epic's own corroboration was on a DIFFERENT surface from the one the
// ticket was filed against, which is why this section exists: repaired at the
// printing surface only, the event and every consumer polling it would keep
// carrying the sentence the list had stopped saying. `missingAgents` rows and
// `agent.lost` payloads are the same object, produced by the same
// `missingAgents()`, and this asserts that they still are.
{
  const sweepRows = read.build().findMissingAgents();
  const sweptOccupied = sweepRows.find((m) => m.path === OCCUPIED);
  check(
    !!sweptOccupied?.occupiedBy,
    'the SWEEP path — `findMissingAgents`, which the daemon broadcasts from, not the request ' +
      'path §1 read — produces the same reconciled row',
    `occupiedBy=${JSON.stringify(sweptOccupied?.occupiedBy)}`
  );

  // The envelope is this script's; the payload is the swept row. See the header.
  const projected = projectEvent({
    action: 'agent.lost',
    at: new Date().toISOString(),
    seq: 1,
    bootId: 'kan572-proof',
    ...sweptOccupied
  });
  check(
    projected?.payload?.occupiedBy?.paneName === FOREIGN_PANE_NAME,
    'and the event contract PUBLISHES it rather than dropping it — an undeclared composite is ' +
      'reported as drift and dropped, which would have removed the qualification on exactly ' +
      'the rows it exists for',
    `payload.occupiedBy=${JSON.stringify(projected?.payload?.occupiedBy)}`
  );
  check(
    (projected?.undeclared ?? []).length === 0 && (projected?.missing ?? []).length === 0,
    'with no drift in either direction — every field declared and every declared field present',
    `undeclared=${JSON.stringify(projected?.undeclared)} missing=${JSON.stringify(projected?.missing)}`
  );

  // THE CONTROL, again: a build that published `occupiedBy` unconditionally as
  // an object would pass the three checks above.
  const sweptEmpty = sweepRows.find((m) => m.path === EMPTY);
  const projectedEmpty = projectEvent({
    action: 'agent.lost', at: new Date().toISOString(), seq: 2, bootId: 'kan572-proof',
    ...sweptEmpty
  });
  check(
    projectedEmpty?.payload?.occupiedBy === null &&
      (projectedEmpty?.undeclared ?? []).length === 0,
    'and null survives projection as null on an ordinary loss, without being reported as drift',
    `payload.occupiedBy=${JSON.stringify(projectedEmpty?.payload?.occupiedBy)}`
  );
}

// ===========================================================================
rule('5. THE RENDERED OUTPUT — the header stops asserting work has stopped');
// ===========================================================================
//
// Acceptance criterion 2, read against the REAL renderer: `commandNamed('list')`
// out of the compiled CLI, handed the response §1 produced. The heading is the
// only place that can qualify a category, and it is what an operator reads
// before any row.
let renderedFleet;
{
  renderedFleet = commandNamed('list').render(new ResponseReader({ ...fleet }), {});
  const heading = renderedFleet
    .split('\n')
    .find((l) => l.startsWith('missing agents ('));

  check(
    typeof heading === 'string' && !heading.includes(STOPPED_GLOSS),
    `the heading does not assert ${JSON.stringify(STOPPED_GLOSS)} while a row shown under it ` +
      'is occupied — the header reads as an instruction to intervene, and that is the ' +
      'instruction this defect was giving about live agents',
    heading
  );
  check(
    typeof heading === 'string' && /OCCUPIED/.test(heading) && /refused/i.test(heading),
    'and it says instead how many rows are occupied and that re-activating them is refused',
    heading
  );
  check(
    renderedFleet.includes(`OCCUPIED by ${FOREIGN_PANE_NAME}`) &&
      renderedFleet.includes(FOREIGN_PANE_ID),
    'and the occupied ROW names the pane and its id, so a reader skimming rows meets the fact ' +
      'without reading the paragraph',
    renderedFleet.split('\n').filter((l) => l.includes('OCCUPIED by')).join('\n          ')
  );
}

// ===========================================================================
rule('6. RED DRIVE — the same checks against builds with the fix taken out');
// ===========================================================================
//
// ⚠ WITHOUT THIS SECTION EVERY PASS ABOVE IS A CLAIM ABOUT THIS BUILD AND NOT
// ABOUT THE CHECKS. Each mutant reproduces one half of the pre-fix daemon in the
// COMPILED build and requires the section that guards it to go red. A proof that
// has only ever passed is evidence of nothing.

// A MUTANT LIVES OUTSIDE THE REPOSITORY AND STILL HAS TO RESOLVE `node-pty`.
// The compiled `router.js` imports `herdr.js`, which imports it, and Node walks
// up from the IMPORTING file — so a build copied to a scratch directory fails at
// load with ERR_MODULE_NOT_FOUND. ⚠ That failure is the DANGEROUS kind rather
// than the loud kind: a mutant that dies on startup produces no observation, and
// a section written less carefully would read the absence as "the check held".
// Each mutant section below therefore requires the mutant to ANSWER — a
// `list_agents` response, or a rendered heading — which a build that never
// loaded cannot produce. `verify-owner-filter.mjs` and
// `verify-fleet-enumeration.mjs` do the same thing for the same reason.
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
  const occupied = workspace('mut', tag, 'occupied');
  await mProduce.invoke({ action: 'configure_agent', path: occupied, ...KNOBS });
  setCensus([ourPane(occupied, '%800')]);
  await mProduce.invoke({ action: 'activate_agent', path: occupied });
  setCensus([foreignPane(occupied, FOREIGN_PANE_ID, FOREIGN_PANE_NAME)]);
  return { res: await mRead.invoke({ action: 'list_agents' }), occupied };
}

blindToOccupancy: {
  // §2's subject, and it IS the pre-fix daemon rather than a caricature of one:
  // with the lookup blinded, `occupiedBy` is null on every row and the reason
  // falls back to the flat sentence — while `foreignPanes` on the same response
  // still names the pane. That is the ticket's verbatim contradiction.
  const dir = mutate('blind-to-occupancy', 'router.js',
    'const occupant = occupants.get(agentPath) ?? null;',
    'const occupant = null;');
  if (!dir) break blindToOccupancy;

  const { res, occupied } = await fleetOn(dir, 'blind');
  const row = rowFor(res, occupied);
  const foreign = foreignFor(res, occupied);
  check(
    !!foreign,
    '(precondition) the mutant still reports the foreign pane — otherwise the contradiction ' +
      'below would be one section being silent rather than two disagreeing',
    `foreignPanes[].occupies=${foreign?.occupies}`
  );
  check(
    row?.occupiedBy === null && row?.reason?.includes(FLAT_CLAIM),
    '§2 GOES RED against a build blind to occupancy: the row asserts herdr has no live agent ' +
      'in a directory the SAME response reports as occupied. The defect, reproduced',
    row?.reason
  );
}

glossIgnoresTheRows: {
  // §5's subject: the standing sentence the heading used to carry whatever was
  // in the category. One expression is the whole distance between a header that
  // reads the rows and one that asserts over them.
  const dir = mutate('gloss-ignores-the-rows', 'cli.js',
    'const occupied = rows.filter((m) => m?.occupiedBy).length;',
    'const occupied = 0;');
  if (!dir) break glossIgnoresTheRows;

  const mutantCli = await import(path.join(dir, 'cli.js'));
  const rendered = mutantCli
    .commandNamed('list')
    .render(new mutantCli.ResponseReader({ ...fleet }), {});
  const heading = rendered.split('\n').find((l) => l.startsWith('missing agents ('));
  check(
    typeof heading === 'string' && heading.includes(STOPPED_GLOSS),
    '§5 GOES RED against a build whose heading ignores its own rows: it tells an operator the ' +
      'work has stopped, over a row the output shows occupied',
    heading
  );
}

// ===========================================================================
console.log(`\n${'='.repeat(78)}`);
const skipped = mutationsSkipped();
if (skipped.length) {
  // Named beside the verdict so "2 FAILED" is not read as two ordinary
  // assertion failures when what happened is that two sections never ran.
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
