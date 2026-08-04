#!/usr/bin/env node
// Live proof for KAN-127: calling `activate` and `deactivate` again is SAFE,
// and safe is a contract rather than something that happens to be true today.
//
// WHY THIS EXISTS. A supervisor reconciles by diffing desired state against
// actual and calling the verbs to close the gap. That means calling them,
// constantly, on things that are ALREADY in the desired state. If the second
// call errors, the supervisor sees a failure it cannot act on; if it starts a
// second pane, two agents share a directory and overwrite each other's work;
// if it answers a bare success, a caller polling "is it down" and a caller who
// mistyped a path get the same answer.
//
// THE TRAP THIS SCRIPT IS BUILT AGAINST, stated first because idempotence
// tests are its classic victim: "nothing bad happened" and "nothing happened
// at all" look identical from the outside. A script that activates three times
// and asserts no error passes just as green against a daemon that refuses
// every activation. So every case here asserts a POSITIVE fact:
//
//   * the pane count is COUNTED, from a stub census that really gains a pane
//     on `agent start` and really loses one on `pane close` — 1 is asserted
//     against a stub that would have shown 2 or 0;
//   * the refusal in case (d) is asserted as a refusal, with `refused:
//     'occupied'` and the foreign pane named — not as the absence of a
//     success;
//   * the two ways of not running are asserted to be DIFFERENT strings, so
//     flattening them to one is a failure rather than a simplification.
//
// The mutation proof is in the PR body: each assertion was watched go red
// against a deliberately broken daemon before it was trusted green.
//
// ONE RESULT OF THAT EXERCISE BELONGS HERE RATHER THAN ONLY IN THE PR, because
// it changes how section 1 should be read. The pane count is defended by THREE
// independent mechanisms, not one: the bridge's session map (a second activate
// finds the first's session), the ownership test (`ourPaneIn` recognises the
// pane), and herdr's own name uniqueness (a pane name is a pure function of
// the path, so a second `agent start` is refused as a taken name). Breaking
// any ONE of them still leaves exactly one pane. It took breaking two at once
// — an impure pane name AND no session reuse — to make the count read 3, which
// is how the count was confirmed to be a live measurement rather than a
// constant. So a green count here is evidence about the system, not about the
// ownership check alone; the assertions that isolate the ownership check are
// `alreadyRunning`, `started: false`, and the `agent start` tally.
//
// FIVE SECTIONS, one per acceptance criterion plus the record-convergence
// case that running this found:
//
//   1. activate x3          -> spawn, then two `alreadyRunning`, and EXACTLY
//                              ONE pane in the census at the end
//   2. deactivate x2        -> the second says it was not running, does not
//                              error, and writes no second stand-down row
//   3. deactivate unstarted -> `unstarted`, distinctly from `standby`
//   4. the T1 BOUNDARY      -> a FOREIGN live pane still REFUSES. This is the
//                              criterion that would otherwise silently
//                              regress T1's guard: an idempotent no-op and a
//                              safety refusal meet in one function, and
//                              turning the refusal into the no-op is the way
//                              this task breaks the epic.
//   5. record convergence   -> `activate` on a live agent whose durable record
//                              does not say so WRITES the activation. Without
//                              it the retry a supervisor makes to repair a
//                              failed registry write answers success and
//                              repairs nothing.
//
// Only the external `herdr` binary is replaced — a STATEFUL stub on PATH,
// answering in herdr's own JSON shapes, mutating its census on `agent start`
// and `pane close`, refusing a name that is already taken exactly as herdr
// does, and RECORDING every argv it is called with. The daemon's router,
// bridge and registry are the real compiled code.
//
// Usage:
//   npm run build
//   node scripts/verify-idempotent-lifecycle.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan127-idem-'));
const realPath = process.env.PATH;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** A directory the caller already owns, outside any CrabCast data dir. */
function ownedDir(name) {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
const ARGV_LOG = path.join(tmp, 'herdr-argv.log');
const PANE_SEQ = path.join(tmp, 'pane-seq');

// ---------------------------------------------------------------------------
// THE STATEFUL STUB.
//
// T1's occupancy proof could use a fixed census because it never needed to
// know what a spawn DID. Counting panes needs the opposite: a census that
// really changes, so "exactly one pane" is a measurement rather than a
// restatement of the fixture.
//
//   agent list          -> the census as it stands
//   agent start <name>  -> ADDS a pane; REFUSES if the name is taken, which is
//                          herdr's real behaviour and CrabCast's last line of
//                          defence against starting two of its own in one
//                          directory
//   agent get <name>    -> that pane, or agent_not_found
//   pane close <id>     -> REMOVES it
//
// Written in node rather than sh because it has to parse argv and rewrite
// JSON, and a stub nobody can read is a stub nobody can trust.
// ---------------------------------------------------------------------------
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/usr/bin/env node
const fs = require('fs');
const CENSUS = ${JSON.stringify(CENSUS_FILE)};
const ARGV_LOG = ${JSON.stringify(ARGV_LOG)};
const PANE_SEQ = ${JSON.stringify(PANE_SEQ)};
const argv = process.argv.slice(2);

// Appended BEFORE any dispatch, so a refused call is as visible in the log as
// a served one. This log is the evidence for "no second \`agent start\` was
// issued" — asserted, not inferred from the response.
fs.appendFileSync(ARGV_LOG, argv.join(' ') + '\\n');

const raw = fs.readFileSync(CENSUS, 'utf8');
if (raw.trim() === 'DOWN') {
  process.stderr.write('herdr: could not connect to the herdr server\\n');
  process.exit(1);
}
const panes = JSON.parse(raw);
const save = () => fs.writeFileSync(CENSUS, JSON.stringify(panes));
const ok = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const err = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};

if (argv[0] === 'agent' && argv[1] === 'list') ok({ type: 'agent_list', agents: panes });

if (argv[0] === 'agent' && argv[1] === 'get') {
  const found = panes.find((p) => p.name === argv[2]);
  if (!found) err('agent_not_found', 'no such agent');
  ok({ agent: found });
}

if (argv[0] === 'agent' && argv[1] === 'start') {
  const name = argv[2];
  // herdr keeps agent names unique. Modelled because it is exactly what makes
  // a duplicate CrabCast spawn impossible rather than merely unlikely — and a
  // stub that let the name be reused would hide a double-spawn as a pass.
  if (panes.some((p) => p.name === name)) err('agent_name_taken', 'agent name is taken');
  const cwdFlag = argv.indexOf('--cwd');
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    agent_status: 'idle',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1]
    // No \`agent\` field: a \`shell\` pane reports no runtime, which is what
    // every agent in this script launches.
  });
  save();
  ok({});
}

if (argv[0] === 'pane' && argv[1] === 'close') {
  const at = panes.findIndex((p) => p.pane_id === argv[2]);
  if (at === -1) err('pane_not_found', 'no such pane');
  panes.splice(at, 1);
  save();
  ok({});
}

ok({});
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;
fs.writeFileSync(PANE_SEQ, '0');

/** Point the stub's census at a set of panes (or at "DOWN"). */
function setCensus(panes) {
  fs.writeFileSync(CENSUS_FILE, panes === 'DOWN' ? 'DOWN' : JSON.stringify(panes));
}

function censusPanes() {
  const raw = fs.readFileSync(CENSUS_FILE, 'utf8');
  return raw.trim() === 'DOWN' ? [] : JSON.parse(raw);
}

/** How many panes exist in a directory, whosever they are. THE measurement. */
function panesIn(dir) {
  return censusPanes().filter((p) => p.cwd === dir);
}

function resetArgvLog() {
  fs.writeFileSync(ARGV_LOG, '');
}

function herdrCalls() {
  try {
    return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function startsIssued() {
  return herdrCalls().filter((line) => /^agent start\b/.test(line)).length;
}

/**
 * Cases that reach the spawn pass the capacity gate deliberately. The gate
 * reads the real machine; this script is about idempotence, which is decided
 * before the gate is consulted, and a proof that depends on the runner's load
 * average is a proof that goes red about the runner.
 */
const PAST_THE_GATE = { override: true };

const KNOBS = {
  priority: 1,
  refusable: true,
  chargeable: true,
  preemptable: true,
  // `shell`, so an agent that never gets a runtime is the expected product
  // rather than a twenty-second confirmation timeout.
  launcher: 'shell'
};

let caseNumber = 0;
/**
 * A fresh registry per section, and ONE bridge per section — the bridge's
 * session map is part of what is under test here, since the second activate
 * must not reuse it to open a second attach and the second deactivate must
 * find it gone.
 */
function newCase(seed = () => {}) {
  const agentRegistry = new AgentRegistry(path.join(tmp, `agents-${++caseNumber}.jsonl`));
  seed(agentRegistry);
  return {
    agentRegistry,
    events: [],
    bridge: new HerdrBridge(config.dataDir, config.configPath)
  };
}

function invoke(deps, request) {
  return new Promise((resolve) => {
    const router = new MessageRouter({
      config,
      herdrBridge: deps.bridge,
      daemonStartedAt: new Date(),
      agentRegistry: deps.agentRegistry,
      send: (msg) => resolve(msg),
      broadcast: (msg) => deps.events.push(msg)
    });
    router.handle(request);
  });
}

// ---------------------------------------------------------------------------
// 1. CRITERION 1 — activate three times. One spawn, two no-ops, ONE pane.
// ---------------------------------------------------------------------------
console.log('\n== 1. activate called three times on the same configured path ==');
{
  const dir = ownedDir('thrice');
  setCensus([]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  resetArgvLog();

  const first = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log('--- activate #1\n' + JSON.stringify(first, null, 2));
  const second = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log('--- activate #2\n' + JSON.stringify(second, null, 2));
  const third = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log('--- activate #3\n' + JSON.stringify(third, null, 2));

  check(
    'the FIRST call starts the agent, and says so rather than leaving it to be inferred',
    first.success === true && first.alreadyRunning === false && first.started === true,
    JSON.stringify({ success: first.success, alreadyRunning: first.alreadyRunning, started: first.started })
  );
  check(
    'and it is VERIFIED — the agent was found in the census before success was reported',
    first.verified === true
  );
  for (const [n, res] of [['second', second], ['third', third]]) {
    check(
      `the ${n} call answers ALREADY AS SPECIFIED — success, not an error`,
      res.success === true && res.alreadyRunning === true,
      `success=${res.success} alreadyRunning=${res.alreadyRunning} error=${res.error ?? '(none)'}`
    );
    check(
      `the ${n} call says started: false, so a caller can tell the two answers apart ` +
        `without reading prose`,
      res.started === false,
      String(res.started)
    );
    check(
      `and it names the pane the agent is already in`,
      res.paneId === first.paneId && res.paneName === first.paneName,
      `${res.paneId} vs ${first.paneId}`
    );
  }

  // THE MEASUREMENT. Not "no error was returned" — a count, taken from a stub
  // census that gains a pane whenever `agent start` succeeds.
  const panes = panesIn(dir);
  console.log(`\n--- panes in ${dir} at the end:\n` + JSON.stringify(panes, null, 2));
  check(
    'EXACTLY ONE PANE exists in that directory after three activations',
    panes.length === 1,
    `counted ${panes.length}: ${JSON.stringify(panes.map((p) => p.pane_id))}`
  );
  check(
    'and exactly one `agent start` was ever issued — asserted against the stub\'s own ' +
      'argv log, so a spawn herdr refused would still be counted',
    startsIssued() === 1,
    `starts: ${startsIssued()}, all calls: ${JSON.stringify(herdrCalls())}`
  );
  check(
    'the durable record was written once and says activated',
    deps.agentRegistry.intents().get(dir)?.event === 'activated'
  );
  check(
    'and only the first call announced an activation — a no-op broadcasts nothing, ' +
      'because nothing in the world changed',
    deps.events.filter((e) => e.action === 'agent.activated').length === 1,
    JSON.stringify(deps.events.map((e) => e.action))
  );
}

// ---------------------------------------------------------------------------
// 2. CRITERION 2 — deactivate twice.
// ---------------------------------------------------------------------------
console.log('\n== 2. deactivate called twice ==');
{
  const dir = ownedDir('twice-down');
  setCensus([]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  check('(setup) the agent is running: one pane', panesIn(dir).length === 1);

  resetArgvLog();
  const first = await invoke(deps, { action: 'deactivate_agent', path: dir });
  console.log('--- deactivate #1\n' + JSON.stringify(first, null, 2));
  const second = await invoke(deps, { action: 'deactivate_agent', path: dir });
  console.log('--- deactivate #2\n' + JSON.stringify(second, null, 2));

  check(
    'the FIRST stand-down reports it WAS running and is now standby',
    first.success === true && first.wasRunning === true && first.state === 'standby',
    JSON.stringify({ success: first.success, wasRunning: first.wasRunning, state: first.state })
  );
  check('and the pane is really gone — counted, not assumed', panesIn(dir).length === 0);

  check(
    'the SECOND stand-down DOES NOT ERROR',
    second.success === true && second.error === undefined,
    `success=${second.success} error=${second.error ?? '(none)'}`
  );
  check(
    'and it says it was NOT running rather than reporting a bare success',
    second.wasRunning === false,
    String(second.wasRunning)
  );
  check(
    'naming the state it is in: standby — it ran, and it is down',
    second.state === 'standby',
    second.state
  );
  check(
    'and saying plainly that nothing changed',
    second.alreadyGone === true && /Nothing changed/.test(second.note ?? ''),
    second.note
  );
  check(
    'no second stand-down was RECORDED — a repeated row would say a decision was taken twice',
    deps.agentRegistry
      .readLog()
      .filter((e) => e.path === dir && e.event === 'deactivated').length === 1,
    JSON.stringify(deps.agentRegistry.readLog().map((e) => e.event))
  );
  check(
    'and no second deactivation was BROADCAST',
    deps.events.filter((e) => e.action === 'agent.deactivated').length === 1,
    JSON.stringify(deps.events.map((e) => e.action))
  );
}

// ---------------------------------------------------------------------------
// 3. CRITERION 3 — deactivate on a configured-but-never-activated path.
// ---------------------------------------------------------------------------
console.log('\n== 3. deactivate on a configured-but-NEVER-ACTIVATED path ==');
{
  const neverRan = ownedDir('never-ran');
  const ranAndStopped = ownedDir('ran-and-stopped');
  setCensus([]);

  const deps = newCase((reg) => {
    reg.recordConfigured({ path: neverRan, config: KNOBS });
    reg.recordConfigured({ path: ranAndStopped, config: KNOBS });
  });

  // The comparison agent: activated, then stood down. Both are "not running";
  // the point is that they are not the SAME not-running.
  await invoke(deps, { action: 'activate_agent', path: ranAndStopped, ...PAST_THE_GATE });
  await invoke(deps, { action: 'deactivate_agent', path: ranAndStopped });

  const unstarted = await invoke(deps, { action: 'deactivate_agent', path: neverRan });
  const standby = await invoke(deps, { action: 'deactivate_agent', path: ranAndStopped });
  console.log('--- never activated\n' + JSON.stringify(unstarted, null, 2));
  console.log('--- ran, then stopped\n' + JSON.stringify(standby, null, 2));

  check(
    'it does not error',
    unstarted.success === true && unstarted.error === undefined,
    unstarted.error
  );
  check('it says it was not running', unstarted.wasRunning === false);
  check("and it calls that state 'unstarted'", unstarted.state === 'unstarted', unstarted.state);
  check(
    'DISTINCTLY from an agent that ran and stopped, which is standby — flattening the two ' +
      'would tell a supervisor that switching this one on resumes a conversation it does ' +
      'not have',
    unstarted.state !== standby.state && standby.state === 'standby',
    `${unstarted.state} vs ${standby.state}`
  );
  check(
    'and NOTHING was recorded for it: an unstarted agent must not land on the standby list',
    deps.agentRegistry
      .readLog()
      .filter((e) => e.path === neverRan && e.event === 'deactivated').length === 0,
    JSON.stringify(deps.agentRegistry.readLog().filter((e) => e.path === neverRan).map((e) => e.event))
  );
  check(
    'the record still says configured, so `activate` will still start it',
    deps.agentRegistry.intents().get(neverRan)?.event === 'configured'
  );
}

// ---------------------------------------------------------------------------
// 4. CRITERION 4 — THE BOUNDARY WITH T1. A foreign pane still refuses.
// ---------------------------------------------------------------------------
console.log('\n== 4. the T1 boundary: a FOREIGN occupant is not an idempotent no-op ==');
{
  // WHY THIS IS HERE AND NOT ONLY IN T1'S SCRIPT.
  //
  // The no-op path and the refusal path are two branches of ONE function,
  // separated by a single ownership test. Widening "already as specified" by
  // one inch — treating any live pane in the directory as evidence that the
  // agent is already up — turns a safety refusal into a silent success, and
  // the only symptom is that two agents quietly share a directory. That
  // regression would leave every other assertion in this file green, which is
  // exactly why the criterion is stated as a positive refusal here.
  const dir = ownedDir('occupied');
  setCensus([
    {
      name: 'butchr-task-kan-124',
      pane_id: '%900',
      agent: 'claude',
      agent_status: 'working',
      cwd: dir
    }
  ]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  resetArgvLog();

  const first = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log('--- activate on an occupied directory\n' + JSON.stringify(first, null, 2));

  check('activate is REFUSED', first.success === false, `success=${first.success}`);
  check(
    "labelled 'occupied' — a refusal, not a quiet success",
    first.refused === 'occupied',
    first.refused
  );
  check(
    'and it is emphatically NOT reported as already running, which is the swallow this ' +
      'criterion exists to catch',
    first.alreadyRunning !== true,
    String(first.alreadyRunning)
  );
  check('the foreign pane is named: pane_id', (first.error ?? '').includes('%900'));
  check('and by herdr name', (first.error ?? '').includes('butchr-task-kan-124'));
  check('machine-readably too, on occupiedBy',
    Array.isArray(first.occupiedBy) && first.occupiedBy[0]?.paneId === '%900');
  check(
    'NOTHING was started — counted against the stub\'s argv log',
    startsIssued() === 0,
    `calls: ${JSON.stringify(herdrCalls())}`
  );
  check(
    'and nothing was closed: CrabCast never closes a pane it did not start',
    !herdrCalls().some((l) => /^pane close\b/.test(l))
  );
  check(
    'the foreign pane is still there, untouched',
    panesIn(dir).length === 1 && panesIn(dir)[0].name === 'butchr-task-kan-124'
  );

  // AND IT DOES NOT DECAY. A guard that refuses once and then gives up on the
  // second try is worse than one that never refused, because the caller has
  // already been told the rule.
  const second = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  const third = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  check(
    'calling it again does NOT wear the refusal down — the second and third refuse too',
    second.refused === 'occupied' && third.refused === 'occupied',
    `${second.refused} / ${third.refused}`
  );
  check(
    'and after three refused activations there is still exactly ONE pane, the stranger\'s',
    panesIn(dir).length === 1,
    `counted ${panesIn(dir).length}`
  );

  // The stand-down side of the same boundary: refusing to stand down a path we
  // never configured, where a bare success would be a claim about a world that
  // does not exist.
  const ghost = await invoke(deps, { action: 'deactivate_agent', path: ownedDir('no-record') });
  check(
    'and `deactivate` on a NEVER-CONFIGURED path refuses rather than answering an ' +
      'idempotent success about an agent that never existed',
    ghost.success === false && ghost.refused === 'not-configured',
    `success=${ghost.success} refused=${ghost.refused}`
  );
}

// ---------------------------------------------------------------------------
// 5. The one this found: `activate` on a live agent CONVERGES the record.
// ---------------------------------------------------------------------------
console.log('\n== 5. a repeat activation repairs a durable record that fell behind ==');
{
  // WHAT THIS IS. A registry write can fail — the activate response says
  // `durable: false` when it does — and this daemon already notes elsewhere
  // that "a durable write that failed after an activation leaves exactly that
  // state over a live pane". The record then says the agent was never started
  // while our pane works away.
  //
  // The supervisor's response to `durable: false` is to call `activate` again.
  // Before this task that call answered `success: true, alreadyRunning: true`
  // and CHANGED NOTHING: the agent stayed out of `expected()`, so a daemon
  // restart would not restore it, and it read as never-started while running.
  // A verb whose whole contract is "safe to call again" must have a second
  // call that can converge, or "safe" only means "harmless".
  const dir = ownedDir('behind');
  setCensus([
    { name: paneNameFor(dir), pane_id: '%500', agent_status: 'idle', cwd: dir }
  ]);
  // The damaged state, stated directly: the pane is live and ours, the record
  // says configured.
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));

  check(
    '(setup) the record does NOT expect this agent, though it is running',
    deps.agentRegistry.expected().every((r) => r.path !== dir)
  );

  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log(JSON.stringify(res, null, 2));

  check(
    'activate answers alreadyRunning — the agent is up and no second pane is wanted',
    res.success === true && res.alreadyRunning === true && startsIssued() === 0
  );
  check(
    'and it says the record was RECONCILED, rather than repairing something silently',
    res.recordReconciled === true,
    String(res.recordReconciled)
  );
  check(
    'the durable record now says activated',
    deps.agentRegistry.intents().get(dir)?.event === 'activated',
    deps.agentRegistry.intents().get(dir)?.event
  );
  check(
    'so a restart WOULD restore it: it is in expected() now. This is the whole point — a ' +
      'retry that reports success and repairs nothing is a retry that cannot converge',
    deps.agentRegistry.expected().some((r) => r.path === dir)
  );

  // And the steady state stays quiet: nothing to repair, nothing claimed.
  const again = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  check(
    'calling it once more claims NO reconciliation, because there was nothing to reconcile',
    again.alreadyRunning === true && again.recordReconciled === undefined,
    String(again.recordReconciled)
  );
  check(
    'and writes no row for it — the repair costs a row only on the call that needed one',
    deps.agentRegistry.readLog().filter((e) => e.path === dir && e.event === 'activated').length === 1,
    JSON.stringify(deps.agentRegistry.readLog().map((e) => e.event))
  );
}

// ---------------------------------------------------------------------------
process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
