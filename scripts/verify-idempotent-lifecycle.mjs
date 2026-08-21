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

/**
 * A directory the caller already owns, outside any CrabCast data dir.
 *
 * Namespaced by launcher, because sections 1 to 5 now run once per launcher and
 * a shared directory would have the second pass find the first pass's pane —
 * which would make the claude run a test of leftovers rather than of claude.
 */
function ownedDir(name) {
  const dir = path.join(tmp, 'owned', LAUNCHER, name);
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
  const sep = argv.indexOf('--');
  const command = sep === -1 ? '' : argv.slice(sep + 1).join(' ');
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    agent_status: 'idle',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1],
    // THE RUNTIME, and it is the whole of KAN-138 item 1. herdr reports an
    // \`agent\` behind a pane running a real agent and nothing behind a bare
    // shell, and that single field is what puts the two launchers on different
    // branches of every "does an agent exist here" question in this daemon —
    // \`ourPaneIn\`, \`confirmAgentPresent\`, \`occupancyOf\`. A stub that always
    // reported none (which is what this one used to do) proves the shell path
    // and quietly skips the path every real consumer is on.
    ...(/\\bclaude\\b/.test(command) ? { agent: 'claude' } : {})
  });
  save();
  ok({});
}

// \`agent attach\` HOLDS THE TERMINAL, and modelling that is load-bearing rather
// than cosmetic. Real herdr hands this process the agent's terminal and stays
// in the foreground for as long as the client wants it; CrabCast spawns it
// under a PTY and treats that PTY's lifetime AS the session's lifetime
// (\`getSessionByPath\` answers only for a session whose status is still
// \`active\`). A stub that fell through to the \`ok({})\` below exited at once, so
// every session this daemon opened was dead microseconds after it was created,
// and the ONLY thing keeping section 1 green was a race: activate #2 and #3
// had to arrive before the exit event was processed. \`shell\` won that race and
// \`claude\` lost it — the launcher settles for ~8.6s answering the startup trust
// dialog, by which time the session had died, so activate #2 legitimately
// RE-ATTACHED and legitimately broadcast a second \`agent.activated\`. The event
// count read 2 for a daemon whose no-op guard was working perfectly.
//
// So this branch is not here to make an assertion pass. It is here so the
// fixture models the one property the assertion depends on. Blocking on stdin
// is what a real attach does and it is what a PTY teardown ends: destroying
// the PTY closes this process's stdin and it exits, which is how \`deactivate\`
// still tears a session down in every section below.
if (argv[0] === 'agent' && argv[1] === 'attach') {
  process.stdin.resume();
  return;
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

/**
 * A pane of ours in `dir`, carrying whatever runtime the current launcher
 * delivers — `agent: 'claude'` for claude, nothing for shell, exactly as the
 * stub's own `agent start` does. Hand-seeded fixtures have to agree with the
 * stub about this or they describe a world the daemon never produces.
 */
function ourPaneAt(dir, paneId) {
  return {
    name: paneNameFor(dir),
    pane_id: paneId,
    agent_status: 'idle',
    cwd: dir,
    ...(LAUNCHER === 'shell' ? {} : { agent: LAUNCHER })
  };
}

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

/**
 * THE LAUNCHER THIS PASS IS RUNNING, and the reason this file has a loop in it
 * at all (KAN-138 item 1).
 *
 * Every agent here used to be `shell`, chosen so an agent that never gets a
 * runtime is the expected product rather than a twenty-second confirmation
 * timeout. That is a real cost and the choice was right; what was wrong was
 * leaving it as the ONLY launcher. `shell` is precisely the launcher whose pane
 * reports no runtime, and `launcherDeliversRuntime` puts it on the other branch
 * of `ourPaneIn` (herdr.ts) from every launcher a real consumer uses. So the
 * whole of the idempotence contract — three activations, one pane; a repeat
 * activation converging a stale record; a foreign pane still refusing — was
 * asserted only on the special case.
 *
 * That is the same blind spot that produced KAN-136, where the one
 * restart-survival assertion in the suite ran `shell` for the same good reason
 * and missed a regression affecting every real agent. KAN-136 fixed it for
 * restart survival by running both launchers against a stub that reports a
 * runtime behind a claude pane; this is that fix applied here, and the stub
 * above now carries the same one field.
 *
 * No model is spawned and none is needed: `agent: 'claude'` in the census is
 * the entire difference between the two as far as this daemon is concerned.
 */
let LAUNCHER = 'shell';

const KNOBS = () => ({
  priority: 1,
  refusable: true,
  chargeable: true,
  preemptable: true,
  launcher: LAUNCHER
});

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
// ===========================================================================
// SECTIONS 1 TO 5, ONCE PER LAUNCHER.
//
// The claude pass is not a copy of the shell pass with a different string in
// it: `ourPaneIn` takes a different branch under it (herdr.ts), so "is this
// pane ours" is answered by a different test, and every assertion below about
// one pane, about a no-op, and about a record converging rests on that answer.
// See LAUNCHER above for why this file only ever asked the question one way.
// ===========================================================================
for (LAUNCHER of ['shell', 'claude']) {
  console.log(`\n${'='.repeat(76)}\nLAUNCHER: ${LAUNCHER}\n${'='.repeat(76)}`);
  // 1. CRITERION 1 — activate three times. One spawn, two no-ops, ONE pane.
  // ---------------------------------------------------------------------------
  console.log('\n== 1. activate called three times on the same configured path ==');
  {
    const dir = ownedDir('thrice');
    setCensus([]);
    const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS() }));
    resetArgvLog();

    const first = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    console.log('--- activate #1\n' + JSON.stringify(first, null, 2));
    const second = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    console.log('--- activate #2\n' + JSON.stringify(second, null, 2));
    const third = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    console.log('--- activate #3\n' + JSON.stringify(third, null, 2));

    check(
      `[${LAUNCHER}] ` +
      'the FIRST call starts the agent, and says so rather than leaving it to be inferred',
      first.success === true && first.alreadyRunning === false && first.started === true,
      JSON.stringify({ success: first.success, alreadyRunning: first.alreadyRunning, started: first.started })
    );
    check(
      `[${LAUNCHER}] ` +
      'and it is VERIFIED — the agent was found in the census before success was reported',
      first.verified === true
    );
    for (const [n, res] of [['second', second], ['third', third]]) {
      check(
        `[${LAUNCHER}] ` +
      `the ${n} call answers ALREADY AS SPECIFIED — success, not an error`,
        res.success === true && res.alreadyRunning === true,
        `success=${res.success} alreadyRunning=${res.alreadyRunning} error=${res.error ?? '(none)'}`
      );
      check(
        `[${LAUNCHER}] ` +
      `the ${n} call says started: false, so a caller can tell the two answers apart ` +
          `without reading prose`,
        res.started === false,
        String(res.started)
      );
      check(
        `[${LAUNCHER}] ` +
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
      `[${LAUNCHER}] ` +
      'EXACTLY ONE PANE exists in that directory after three activations',
      panes.length === 1,
      `counted ${panes.length}: ${JSON.stringify(panes.map((p) => p.pane_id))}`
    );
    check(
      `[${LAUNCHER}] ` +
        'and the census reports the runtime THIS launcher delivers — the one field that ' +
        'puts the two passes on different branches of `ourPaneIn`. Without this the loop ' +
        'above would be running the same world twice and reporting it as two',
      (panes[0]?.agent ?? null) === (LAUNCHER === 'shell' ? null : LAUNCHER),
      `agent=${JSON.stringify(panes[0]?.agent ?? null)}`
    );
    check(
      `[${LAUNCHER}] ` +
      'and exactly one `agent start` was ever issued — asserted against the stub\'s own ' +
        'argv log, so a spawn herdr refused would still be counted',
      startsIssued() === 1,
      `starts: ${startsIssued()}, all calls: ${JSON.stringify(herdrCalls())}`
    );
    check(
      `[${LAUNCHER}] ` +
      'the durable record was written once and says activated',
      deps.agentRegistry.intents().get(dir)?.event === 'activated'
    );
    check(
      `[${LAUNCHER}] ` +
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
    const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS() }));
    await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    check('(setup) the agent is running: one pane', panesIn(dir).length === 1);

    resetArgvLog();
    const first = await invoke(deps, { action: 'deactivate_agent', path: dir });
    console.log('--- deactivate #1\n' + JSON.stringify(first, null, 2));
    const second = await invoke(deps, { action: 'deactivate_agent', path: dir });
    console.log('--- deactivate #2\n' + JSON.stringify(second, null, 2));

    check(
      `[${LAUNCHER}] ` +
      'the FIRST stand-down reports it WAS running and is now standby',
      first.success === true && first.wasRunning === true && first.state === 'standby',
      JSON.stringify({ success: first.success, wasRunning: first.wasRunning, state: first.state })
    );
    check('and the pane is really gone — counted, not assumed', panesIn(dir).length === 0);

    check(
      `[${LAUNCHER}] ` +
      'the SECOND stand-down DOES NOT ERROR',
      second.success === true && second.error === undefined,
      `success=${second.success} error=${second.error ?? '(none)'}`
    );
    check(
      `[${LAUNCHER}] ` +
      'and it says it was NOT running rather than reporting a bare success',
      second.wasRunning === false,
      String(second.wasRunning)
    );
    check(
      `[${LAUNCHER}] ` +
      'naming the state it is in: standby — it ran, and it is down',
      second.state === 'standby',
      second.state
    );
    check(
      `[${LAUNCHER}] ` +
      'and saying plainly that nothing changed',
      second.alreadyGone === true && /Nothing changed/.test(second.note ?? ''),
      second.note
    );
    check(
      `[${LAUNCHER}] ` +
      'no second stand-down was RECORDED — a repeated row would say a decision was taken twice',
      deps.agentRegistry
        .readLog()
        .filter((e) => e.path === dir && e.event === 'deactivated').length === 1,
      JSON.stringify(deps.agentRegistry.readLog().map((e) => e.event))
    );
    check(
      `[${LAUNCHER}] ` +
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
      reg.recordConfigured({ path: neverRan, config: KNOBS() });
      reg.recordConfigured({ path: ranAndStopped, config: KNOBS() });
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
      `[${LAUNCHER}] ` +
      'it does not error',
      unstarted.success === true && unstarted.error === undefined,
      unstarted.error
    );
    check('it says it was not running', unstarted.wasRunning === false);
    check("and it calls that state 'unstarted'", unstarted.state === 'unstarted', unstarted.state);
    check(
      `[${LAUNCHER}] ` +
      'DISTINCTLY from an agent that ran and stopped, which is standby — flattening the two ' +
        'would tell a supervisor that switching this one on resumes a conversation it does ' +
        'not have',
      unstarted.state !== standby.state && standby.state === 'standby',
      `${unstarted.state} vs ${standby.state}`
    );
    check(
      `[${LAUNCHER}] ` +
      'and NOTHING was recorded for it: an unstarted agent must not land on the standby list',
      deps.agentRegistry
        .readLog()
        .filter((e) => e.path === neverRan && e.event === 'deactivated').length === 0,
      JSON.stringify(deps.agentRegistry.readLog().filter((e) => e.path === neverRan).map((e) => e.event))
    );
    check(
      `[${LAUNCHER}] ` +
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
    const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS() }));
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
      `[${LAUNCHER}] ` +
      'and `alreadyRunning` is ABSENT — not `false`. `!== true` was the assertion here, and a ' +
        'literal `false` satisfies it while being a claim this branch cannot support: it found ' +
        'a pane that is NOT ours, so it established nothing about whether our agent is ' +
        'running. The key itself is the thing checked (KAN-138 item 6)',
      !('alreadyRunning' in first),
      `alreadyRunning ${'alreadyRunning' in first ? `present as ${JSON.stringify(first.alreadyRunning)}` : 'absent'}`
    );
    check('the foreign pane is named: pane_id', (first.error ?? '').includes('%900'));
    check('and by herdr name', (first.error ?? '').includes('butchr-task-kan-124'));
    check('machine-readably too, on occupiedBy',
      Array.isArray(first.occupiedBy) && first.occupiedBy[0]?.paneId === '%900');
    check(
      `[${LAUNCHER}] ` +
      'NOTHING was started — counted against the stub\'s argv log',
      startsIssued() === 0,
      `calls: ${JSON.stringify(herdrCalls())}`
    );
    check(
      `[${LAUNCHER}] ` +
      'and nothing was closed: CrabCast never closes a pane it did not start',
      !herdrCalls().some((l) => /^pane close\b/.test(l))
    );
    check(
      `[${LAUNCHER}] ` +
      'the foreign pane is still there, untouched',
      panesIn(dir).length === 1 && panesIn(dir)[0].name === 'butchr-task-kan-124'
    );

    // AND IT DOES NOT DECAY. A guard that refuses once and then gives up on the
    // second try is worse than one that never refused, because the caller has
    // already been told the rule.
    const second = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    const third = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    check(
      `[${LAUNCHER}] ` +
      'calling it again does NOT wear the refusal down — the second and third refuse too',
      second.refused === 'occupied' && third.refused === 'occupied',
      `${second.refused} / ${third.refused}`
    );
    check(
      `[${LAUNCHER}] ` +
      'and after three refused activations there is still exactly ONE pane, the stranger\'s',
      panesIn(dir).length === 1,
      `counted ${panesIn(dir).length}`
    );

    // The stand-down side of the same boundary: refusing to stand down a path we
    // never configured, where a bare success would be a claim about a world that
    // does not exist.
    const ghost = await invoke(deps, { action: 'deactivate_agent', path: ownedDir('no-record') });
    check(
      `[${LAUNCHER}] ` +
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
    // OUR pane, seeded by hand — and it carries the runtime THIS launcher
    // delivers, which is the fixture half of KAN-138 item 1. Seeded without it
    // (which is how this line read) the pane is not ours under `claude` at all:
    // `ourPaneIn` requires a runtime for every launcher but `shell`, so the
    // repeat activation below would find an empty directory and SPAWN, and the
    // convergence this section exists to prove would never be exercised. The
    // first run of the claude pass failed here, which is the blind spot
    // reproducing itself inside the fixture rather than in the daemon.
    setCensus([ourPaneAt(dir, '%500')]);
    // The damaged state, stated directly: the pane is live and ours, the record
    // says configured.
    const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS() }));

    check(
      `[${LAUNCHER}] ` +
      '(setup) the record does NOT expect this agent, though it is running',
      deps.agentRegistry.expected().every((r) => r.path !== dir)
    );

    resetArgvLog();
    const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    console.log(JSON.stringify(res, null, 2));

    check(
      `[${LAUNCHER}] ` +
      'activate answers alreadyRunning — the agent is up and no second pane is wanted',
      res.success === true && res.alreadyRunning === true && startsIssued() === 0
    );
    check(
      `[${LAUNCHER}] ` +
      'and it says the record was RECONCILED, rather than repairing something silently',
      res.recordReconciled === true,
      String(res.recordReconciled)
    );
    check(
      `[${LAUNCHER}] ` +
      'the durable record now says activated',
      deps.agentRegistry.intents().get(dir)?.event === 'activated',
      deps.agentRegistry.intents().get(dir)?.event
    );
    check(
      `[${LAUNCHER}] ` +
      'so a restart WOULD restore it: it is in expected() now. This is the whole point — a ' +
        'retry that reports success and repairs nothing is a retry that cannot converge',
      deps.agentRegistry.expected().some((r) => r.path === dir)
    );

    // And the steady state stays quiet: nothing to repair, nothing claimed.
    const again = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    check(
      `[${LAUNCHER}] ` +
      'calling it once more claims NO reconciliation, because there was nothing to reconcile',
      again.alreadyRunning === true && again.recordReconciled === undefined,
      String(again.recordReconciled)
    );
    check(
      `[${LAUNCHER}] ` +
      'and writes no row for it — the repair costs a row only on the call that needed one',
      deps.agentRegistry.readLog().filter((e) => e.path === dir && e.event === 'activated').length === 1,
      JSON.stringify(deps.agentRegistry.readLog().map((e) => e.event))
    );
  }

}

// ===========================================================================
// 6. THE OTHER RECORD THAT CAN FALL BEHIND: `deactivated`, over a live pane.
// ===========================================================================
//
// KAN-138 item 5. Section 5 seeds a `configured`-last record, and the branch it
// exercises is `recordWasBehind = intent.event !== 'activated'` (router.ts) —
// which covers `deactivated` too, and nothing asked it to. `router.ts` names
// this case in its own comment: "a stand-down whose pane outlived the daemon
// that recorded it".
//
// It is a different world from section 5's, not a relabelling of it: the agent
// is on the STANDBY list, so a reader of the fleet is being told it ran and
// stopped, while its pane is working away. A repeat `activate` must converge
// that too, or the standby list stays wrong until somebody notices by hand.
LAUNCHER = 'claude';
console.log(`\n${'='.repeat(76)}\n6. a DEACTIVATED record over a live pane converges too\n${'='.repeat(76)}`);
{
  const dir = ownedDir('stood-down-but-live');
  setCensus([ourPaneAt(dir, '%600')]);

  const deps = newCase((reg) => {
    reg.recordConfigured({ path: dir, config: KNOBS() });
    // Activated and then stood down in the record — the pane, in this world,
    // outlived the daemon that wrote that row.
    reg.recordActivated({ path: dir, config: KNOBS() });
    reg.recordDeactivated({ path: dir, config: KNOBS() });
  });

  check(
    '(setup) the record says DEACTIVATED while our pane is live — the agent reads as standby ' +
      'and is working',
    deps.agentRegistry.intents().get(dir)?.event === 'deactivated' &&
      deps.agentRegistry.expected().every((r) => r.path !== dir) &&
      panesIn(dir).length === 1,
    `record ${deps.agentRegistry.intents().get(dir)?.event}, panes ${panesIn(dir).length}`
  );

  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log(JSON.stringify(
    { success: res.success, alreadyRunning: res.alreadyRunning, started: res.started,
      recordReconciled: res.recordReconciled }, null, 2));

  check(
    'activate finds it already running and starts nothing',
    res.success === true && res.alreadyRunning === true && startsIssued() === 0,
    `success=${res.success} alreadyRunning=${res.alreadyRunning} starts=${startsIssued()}`
  );
  check(
    'and it says the record was RECONCILED — the `deactivated` case, not just `configured`',
    res.recordReconciled === true,
    String(res.recordReconciled)
  );
  check(
    'the durable record now says activated, so the agent has left the standby list it should ' +
      'never have been on',
    deps.agentRegistry.intents().get(dir)?.event === 'activated' &&
      deps.agentRegistry.expected().some((r) => r.path === dir),
    deps.agentRegistry.intents().get(dir)?.event
  );
  check(
    'and exactly one pane, still — converging a record must not cost a spawn',
    panesIn(dir).length === 1,
    `counted ${panesIn(dir).length}`
  );
}

// ===========================================================================
// 7. THE REPAIR CAN FAIL, AND SAYS SO.
// ===========================================================================
//
// KAN-138 item 4. The converge branch reports `durable: false` when its write
// does not reach the disk, and `router.ts` says why in a comment — "or the
// repair could fail as silently as the damage it exists to undo". A comment is
// not a test, and this is the one claim on that branch nothing exercised.
//
// THE WRITE IS MADE TO FAIL FOR REAL, by sealing the registry log, and THE SEAL
// IS PROVEN TO HAVE TAKEN before anything is asserted on it: a run as root
// would sail through a chmod and then exercise the healthy path while reporting
// that the unhealthy one is covered. That is the same discipline
// verify-event-durability uses, and for the same reason.
console.log(`\n${'='.repeat(76)}\n7. a repair that cannot reach the disk REPORTS it\n${'='.repeat(76)}`);
{
  const dir = ownedDir('repair-fails');
  setCensus([ourPaneAt(dir, '%700')]);

  const logFile = path.join(tmp, `agents-sealed.jsonl`);
  const agentRegistry = new AgentRegistry(logFile);
  agentRegistry.recordConfigured({ path: dir, config: KNOBS() });
  const deps = {
    agentRegistry,
    events: [],
    bridge: new HerdrBridge(config.dataDir, config.configPath)
  };

  fs.chmodSync(logFile, 0o400);
  let sealHolds = false;
  try {
    fs.appendFileSync(logFile, '{"probe":true}\n');
  } catch {
    sealHolds = true;
  }
  check(
    '(setup) THE SEAL TOOK — this process cannot append to the registry log. Asserted by ' +
      'trying it, because a run as root would chmod happily and then prove the healthy path ' +
      'while reporting on the broken one',
    sealHolds,
    sealHolds ? '0400, append refused' : 'the append SUCCEEDED — this run cannot test a failed write'
  );

  if (sealHolds) {
    resetArgvLog();
    const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    console.log(JSON.stringify(
      { success: res.success, alreadyRunning: res.alreadyRunning, durable: res.durable,
        durabilityError: res.durabilityError, recordReconciled: res.recordReconciled }, null, 2));

    check(
      'the activation still SUCCEEDS — the agent is up and the daemon says so; an unwritable ' +
        'log must not fail the operation in flight',
      res.success === true && res.alreadyRunning === true && startsIssued() === 0,
      `success=${res.success} starts=${startsIssued()}`
    );
    check(
      'and it reports `durable: false` rather than answering a bare success — the repair ' +
        'failing as silently as the damage is exactly what this field exists to prevent',
      res.durable === false,
      `durable=${JSON.stringify(res.durable)}`
    );
    check(
      'with a REASON attached, so the caller can act rather than guess',
      typeof res.durabilityError === 'string' && res.durabilityError.length > 0,
      JSON.stringify(res.durabilityError)
    );
    check(
      'and the record really did not converge — the response is telling the truth about the ' +
        'disk rather than about its intention',
      agentRegistry.intents().get(dir)?.event === 'configured',
      agentRegistry.intents().get(dir)?.event
    );
    fs.chmodSync(logFile, 0o600);
  }
}

// ===========================================================================
// 8. THE SESSION-ADDRESSED STAND-DOWN, which nothing was sending.
// ===========================================================================
//
// KAN-138 item 3. `deactivate` (by sessionId) is a wire-reachable action with
// its own handler; the CLI deliberately does not expose it and MCP uses
// `deactivate_agent`, so no proof in this suite had ever sent it. It answers on
// the same `deactivate_response` shape as its path-addressed sibling, and a
// contract that holds for one addressing form and not the other is not a
// contract.
//
// BOTH BRANCHES, because `state` is conditional: it is claimed only when there
// is a record for the agent to be in a state ON. A session with no record
// behind it is stood down, but calling that "standby" would name a durable
// resting place that does not exist.
console.log(`\n${'='.repeat(76)}\n8. deactivate BY SESSION ID answers the same contract\n${'='.repeat(76)}`);
{
  const dir = ownedDir('by-session');
  setCensus([]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS() }));
  const up = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  check(
    '(setup) the agent is running and handed back a session id to address it by',
    up.success === true && typeof up.sessionId === 'string' && panesIn(dir).length === 1,
    `sessionId=${up.sessionId} panes=${panesIn(dir).length}`
  );

  const bySession = await invoke(deps, { action: 'deactivate', sessionId: up.sessionId });
  console.log(JSON.stringify(bySession, null, 2));

  check(
    'it stands the agent down',
    bySession.success === true && bySession.error === undefined,
    `success=${bySession.success} error=${bySession.error ?? '(none)'}`
  );
  check(
    'and reports `wasRunning: true` — a session we held and tore down was, by definition, ' +
      'running',
    bySession.wasRunning === true,
    String(bySession.wasRunning)
  );
  check(
    "naming the state it left the agent in: 'standby'",
    bySession.state === 'standby',
    bySession.state
  );
  check(
    'it echoes the path and pane name, so a caller holding only a session id learns which ' +
      'agent it just stopped',
    bySession.path === dir && bySession.paneName === paneNameFor(dir),
    `${bySession.path} / ${bySession.paneName}`
  );
  check(
    'the pane is really gone — counted from the census, not taken from the response',
    panesIn(dir).length === 0,
    `counted ${panesIn(dir).length}`
  );
  check(
    'and the stand-down was RECORDED, so a reboot will not bring it back',
    deps.agentRegistry.intents().get(dir)?.event === 'deactivated',
    deps.agentRegistry.intents().get(dir)?.event
  );

  // A missing session id is a refusal, not a stand-down of something arbitrary.
  const noId = await invoke(deps, { action: 'deactivate' });
  check(
    'without a sessionId it refuses rather than guessing at one',
    noId.success === false && /Missing sessionId/.test(noId.error ?? ''),
    noId.error
  );

  // THE SECOND BRANCH: a session whose path this daemon holds no record for.
  // `state` must be absent — there is no durable resting place to name.
  const orphan = ownedDir('session-no-record');
  setCensus([]);
  const bare = newCase((reg) => reg.recordConfigured({ path: orphan, config: KNOBS() }));
  const orphanUp = await invoke(bare, { action: 'activate_agent', path: orphan, ...PAST_THE_GATE });
  // The record is dropped out from under the live session: a fresh registry
  // over the same bridge is exactly "a session we hold whose path has no row".
  const forgetful = {
    agentRegistry: new AgentRegistry(path.join(tmp, 'agents-forgetful.jsonl')),
    events: [],
    bridge: bare.bridge
  };
  const orphanDown = await invoke(forgetful, { action: 'deactivate', sessionId: orphanUp.sessionId });
  console.log(JSON.stringify(orphanDown, null, 2));
  check(
    'a session with NO record behind it is still stood down, and still says it was running',
    orphanDown.success === true && orphanDown.wasRunning === true,
    `success=${orphanDown.success} wasRunning=${orphanDown.wasRunning}`
  );
  check(
    "but claims NO `state` — calling that 'standby' would name a durable resting place that " +
      'does not exist, and the standby list promises a conversation to resume',
    !('state' in orphanDown),
    `state ${'state' in orphanDown ? `present as ${JSON.stringify(orphanDown.state)}` : 'absent'}`
  );
}

// ===========================================================================
// 9. EVERY REFUSAL SAYS THE SAME TWO THINGS.
// ===========================================================================
//
// KAN-138 item 6, second half. `started` used to be present as `false` on four
// of `activate`'s nine refusals and absent from the other five, so a caller
// could not read it without first knowing which KIND of refusal it had — a
// field whose presence varies by refusal kind makes callers branch on absence,
// which is the guess this daemon refuses everywhere else.
//
// FOUR KINDS, PRODUCED RATHER THAN LISTED, and each one is a different arm of
// the handler: no record at all, a bad flag, a census that could not answer,
// and a stranger in the directory. The rule now lives in `fail()` itself
// (router.ts), so this section is what stops it being quietly unpicked.
//
// The other half — `alreadyRunning` is never `false` — is held by the COMPILER:
// `ActivateRefusalFields` types it `true`, so `alreadyRunning: false` does not
// build. That is the stronger instrument and it is used where it reaches;
// section 4's absence assertion covers the part no type can, because `true` is
// correct one branch over.
console.log(`\n${'='.repeat(76)}\n9. every activate refusal reports started: false\n${'='.repeat(76)}`);
{
  const configured = ownedDir('refusals-configured');
  const stranger = ownedDir('refusals-occupied');
  setCensus([
    { name: 'butchr-task-kan-900', pane_id: '%900', agent: 'claude', agent_status: 'working', cwd: stranger }
  ]);
  const deps = newCase((reg) => {
    reg.recordConfigured({ path: configured, config: KNOBS() });
    reg.recordConfigured({ path: stranger, config: KNOBS() });
  });

  const refusals = [
    ['not-configured', await invoke(deps, { action: 'activate_agent', path: ownedDir('never-configured'), ...PAST_THE_GATE })],
    ['bad-flag', await invoke(deps, { action: 'activate_agent', path: configured, override: 'yes' })],
    ['occupied', await invoke(deps, { action: 'activate_agent', path: stranger, ...PAST_THE_GATE })]
  ];
  // The census that could not answer — herdr down is silence, not evidence.
  setCensus('DOWN');
  refusals.push([
    'unverifiable',
    await invoke(deps, { action: 'activate_agent', path: configured, ...PAST_THE_GATE })
  ]);
  setCensus([]);

  for (const [kind, res] of refusals) {
    console.log(`--- ${kind}: ${JSON.stringify({
      success: res.success, started: res.started, refused: res.refused,
      alreadyRunning: 'alreadyRunning' in res ? res.started : '(absent)'
    })}`);
    check(
      `${kind}: it is a refusal`,
      res.success === false,
      `success=${res.success}`
    );
    check(
      `${kind}: and it says \`started: false\` — PRESENT, on every kind, so a caller reads one ` +
        `field rather than first working out which refusal it got`,
      res.started === false,
      `started ${'started' in res ? JSON.stringify(res.started) : 'ABSENT'}`
    );
    check(
      `${kind}: with \`alreadyRunning\` never false — absent here, because this refusal never ` +
        `reached the question`,
      res.alreadyRunning !== false,
      `alreadyRunning ${'alreadyRunning' in res ? JSON.stringify(res.alreadyRunning) : 'absent'}`
    );
  }
  check(
    'all four kinds were really produced — a loop over an empty list would pass this section ' +
      'without asserting anything',
    refusals.length === 4 && refusals.every(([, r]) => r.success === false),
    JSON.stringify(refusals.map(([k]) => k))
  );
}

// ---------------------------------------------------------------------------
process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
