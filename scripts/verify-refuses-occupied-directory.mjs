#!/usr/bin/env node
// Live proof for KAN-124's blocker: `activate` refuses to spawn into a
// directory somebody else's agent is already working in — and refuses just as
// hard when it cannot find out.
//
// THE BUG THIS EXISTS FOR, stated once so the cases below read as answers
// rather than as arbitrary scenarios:
//
//   "Not ours" and "nothing is there" are different facts. Only the census
//   answers the second, and it must be asked separately.
//
// Ownership answers "is this pane ours?" — a live pane bearing the name this
// path derives. Occupancy answers "is anything live in this directory?" — a
// live pane whose canonical cwd is this path. They read the same census and
// are NOT complements, and reading a no to the first as a yes to the second
// sends `activate` down the spawn branch straight into an occupied directory.
// The path-derived pane name protects CrabCast against CrabCast; a foreign
// pane has a foreign name and is invisible to it. Adopting a fleet of
// directories that already have agents in them is exactly the foreign case,
// for every directory at once.
//
// Case (c3) is the round-2 regression test, and it is the one to read first:
// ownership must not depend on a value that moves.
//
// Five cases, all five from ONE census read per activation:
//
//   a. live foreign pane in the target      -> REFUSED, names pane_id + name,
//                                              and NO `agent start` was issued
//   b. foreign pane with NO runtime         -> activation proceeds
//   c. our own pane                         -> alreadyRunning, no second pane
//   c2. ours PLUS a foreign co-occupant     -> alreadyRunning, and the
//                                              co-occupant is REPORTED
//   c3. our pane after herdr RENUMBERED it  -> still ours (the round-2 blocker)
//   d. herdr unreachable                    -> REFUSED as unverifiable, and
//                                              again no `agent start`
//   e. configure on an occupied path        -> SUCCEEDS, carrying occupiedBy
//
// (d) is the case that would otherwise fail silently:
// `listHerdrAgentsChecked` returns an EMPTY census when herdr does not answer,
// so a guard built the obvious way reads its own failure as an all-clear and
// spawns into an occupied directory precisely when it cannot see it.
//
// Only the external `herdr` binary is replaced — a stub on PATH answering in
// herdr's own JSON shapes and RECORDING every argv it is called with, which is
// how "no `agent start` was issued" is asserted rather than assumed. The
// daemon's router, bridge and registry are the real compiled code.
//
// Usage:
//   npm run build
//   node scripts/verify-refuses-occupied-directory.mjs [distDir]

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan124-occupied-'));
const realPath = process.env.PATH;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// A config declaring nothing but a dataDir — there is no type table left.
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

// The stub. Every invocation is appended to ARGV_LOG first — that log is the
// evidence for "no `agent start` was issued", and it has to be written before
// any dispatch so a refused call is as visible as a served one.
//
// `agent list` prints whatever CENSUS_FILE holds, or exits 1 when the file
// says the server is down: that is how case (d) makes herdr unreachable
// without removing it from PATH, which is a different failure.
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ARGV_LOG)}
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ "$(cat ${JSON.stringify(CENSUS_FILE)})" = "DOWN" ]; then
    echo 'herdr: could not connect to the herdr server' >&2
    exit 1
  fi
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

/** Point the stub's `agent list` at a census (or at "DOWN"). */
function setCensus(payload) {
  fs.writeFileSync(
    CENSUS_FILE,
    payload === 'DOWN'
      ? 'DOWN'
      : JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: payload } })
  );
}

/** Forget every herdr call so far, so an assertion is about ONE activation. */
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

/** Whether this daemon asked herdr to START anything. The load-bearing assertion. */
function agentStartIssued() {
  return herdrCalls().some((line) => /^agent start\b/.test(line));
}

/**
 * Cases that reach the spawn pass the capacity gate deliberately. The gate
 * reads the real machine and this script is about the occupancy guard, which
 * is checked BEFORE the gate — so the refusal cases are unaffected either way,
 * and the one case that proceeds must not be a coin toss on the load average.
 */
const PAST_THE_GATE = { override: true };

const KNOBS = {
  priority: 1,
  refusable: true,
  chargeable: true,
  preemptable: true,
  // `shell` so a confirmation that must time out does so in seconds rather
  // than in the twenty a runtime-bearing launcher is given.
  launcher: 'shell'
};

let caseNumber = 0;
/**
 * A fresh registry and a fresh bridge per case, so each one starts from a
 * state it declared rather than from the previous case's leftovers. The bridge
 * is shared within a case because its session map is part of what is under
 * test — case (e) activates against the same bridge it configured with.
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

/**
 * One request through the real router. `handle` is synchronous for everything
 * but activate, so both are driven through the response callback rather than
 * through a return value.
 */
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
// a. A live foreign pane in the target directory.
// ---------------------------------------------------------------------------
console.log('\n== a. a live foreign pane is in the directory ==');
{
  const dir = ownedDir('case-a');
  setCensus([
    {
      name: 'butchr-task-kan-77',
      pane_id: '%41',
      agent: 'claude',
      agent_status: 'working',
      cwd: dir
    }
  ]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir });
  console.log(JSON.stringify(res, null, 2));

  check('activate is REFUSED', res.success === false);
  check("the refusal is labelled 'occupied', not something a caller has to parse prose for",
    res.refused === 'occupied', res.refused);
  check("the message names the foreign pane's pane_id", (res.error ?? '').includes('%41'));
  check("the message names the foreign pane's herdr name",
    (res.error ?? '').includes('butchr-task-kan-77'));
  check('and its agent_status, so a human can see what they would be interrupting',
    (res.error ?? '').includes('working'));
  check('the pane is also machine-readable on `occupiedBy`',
    Array.isArray(res.occupiedBy) && res.occupiedBy[0]?.paneId === '%41');
  check(
    'NO `agent start` was issued — asserted against the herdr stub\'s own argv log, ' +
      'not inferred from the response',
    agentStartIssued() === false,
    `herdr calls: ${JSON.stringify(herdrCalls())}`
  );
  check('the response says so too: started: false', res.started === false);
  check(
    'and the refusal neither claims nor closes that pane — no `pane close` was issued',
    !herdrCalls().some((l) => /^pane close\b/.test(l))
  );
}

// ---------------------------------------------------------------------------
// b. A foreign pane with no runtime. A dead pane does not occupy.
// ---------------------------------------------------------------------------
console.log('\n== b. a foreign pane with NO runtime is in the directory ==');
{
  const dir = ownedDir('case-b');
  setCensus([
    { name: 'butchr-task-kan-77', pane_id: '%42', agent_status: 'unknown', cwd: dir }
  ]);
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log(JSON.stringify(res, null, 2));

  check(
    'activation PROCEEDS — `agent start` was issued',
    agentStartIssued() === true,
    `herdr calls: ${JSON.stringify(herdrCalls())}`
  );
  check(
    'it is not refused as occupied or as unverifiable — a pane with nothing behind it ' +
      'is not an occupant',
    res.refused !== 'occupied' && res.refused !== 'unverifiable',
    `refused: ${res.refused ?? '(not refused for occupancy)'}`
  );
  // The stub is not a real herdr, so the agent never appears in the census and
  // the activation correctly fails verification. That failure is the KAN-23
  // guarantee working, not this case's subject — what this case proves is that
  // the occupancy guard let it through to the spawn at all.
  check(
    'and it fails afterwards on VERIFICATION rather than on occupancy, which is the ' +
      'stub having no real agent behind it',
    res.success === false && res.verified === false
  );
}

// ---------------------------------------------------------------------------
// c. Our own pane.
// ---------------------------------------------------------------------------
console.log('\n== c. our own pane is in the directory ==');
{
  const dir = ownedDir('case-c');
  setCensus([
    {
      // Ours because the name is the one this path derives, and it has a
      // runtime. Nothing else is consulted.
      name: paneNameFor(dir),
      pane_id: '%43',
      agent: 'claude',
      agent_status: 'idle',
      cwd: dir
    }
  ]);
  const deps = newCase((reg) => reg.recordActivated({ path: dir, config: KNOBS }));
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir });
  console.log(JSON.stringify(res, null, 2));

  check('activate SUCCEEDS rather than erroring', res.success === true);
  check('and says alreadyRunning rather than claiming it started something',
    res.alreadyRunning === true);
  check('naming the pane it is already in, READ LIVE from the census', res.paneId === '%43');
  check(
    'NO second pane: no `agent start` and no `tab create` were issued',
    !agentStartIssued() && !herdrCalls().some((l) => /^tab create\b/.test(l)),
    `herdr calls: ${JSON.stringify(herdrCalls())}`
  );
}

// ---------------------------------------------------------------------------
// c2. Ours AND a stranger, in the same directory.
// ---------------------------------------------------------------------------
console.log('\n== c2. our pane AND a foreign pane, both live in the directory ==');
{
  const dir = ownedDir('case-c2');
  setCensus([
    { name: paneNameFor(dir), pane_id: '%44', agent: 'claude', agent_status: 'working', cwd: dir },
    { name: 'butchr-task-kan-80', pane_id: '%45', agent: 'claude', agent_status: 'idle', cwd: dir }
  ]);
  const deps = newCase((reg) => reg.recordActivated({ path: dir, config: KNOBS }));
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir });
  console.log(JSON.stringify(res, null, 2));

  // Ours is asked FIRST. Asking "is anything here" first would take the
  // refusal branch and report our own live agent as unstartable because a
  // stranger is sharing its directory.
  check('activate still answers alreadyRunning — our agent IS running',
    res.success === true && res.alreadyRunning === true);
  check(
    'and the co-occupant is REPORTED rather than swallowed: two agents in one directory ' +
      'is the thing this guard exists to make visible',
    Array.isArray(res.occupiedBy) &&
      res.occupiedBy.length === 1 &&
      res.occupiedBy[0].name === 'butchr-task-kan-80',
    JSON.stringify(res.occupiedBy)
  );
  check('ours is not listed as its own co-occupant',
    !(res.occupiedBy ?? []).some((o) => o.name === paneNameFor(dir)));
  check('and nothing was started or closed', !agentStartIssued() &&
    !herdrCalls().some((l) => /^pane close\b/.test(l)));
}

// ---------------------------------------------------------------------------
// c3. THE ROUND-2 REGRESSION. herdr renumbered our pane; it is still ours.
// ---------------------------------------------------------------------------
console.log('\n== c3. herdr renumbered our pane between activations ==');
{
  // WHAT THIS EXISTS FOR.
  //
  // Ownership was originally three facts agreeing, the first being that a
  // paneId PERSISTED on the durable record still appears in the census. herdr
  // pane ids are positions in a list that compacts whenever any pane anywhere
  // closes — this repository documents that itself, in `closeTabPlaceholder`,
  // which re-resolves by terminal id for exactly that reason.
  //
  // So an unrelated agent two tabs over finishing renumbers ours, fact 1
  // fails, and "is this ours" answers NO about our own live agent. Under
  // refuse-on-occupied that is not a cosmetic wrong answer: `activate` reports
  // our own agent as a foreign occupant and refuses to start it, FOREVER,
  // while telling the caller it never closes a pane it did not start.
  //
  // It was measured, not deduced: in this PR's own AC 3 transcript, activating
  // two agents and deactivating the first renumbered the second's pane from
  // `…-12` to `…-11` on herdr 0.6.4.
  const dir = ownedDir('case-c3');
  const deps = newCase((reg) => reg.recordActivated({ path: dir, config: KNOBS }));

  // First activation: the agent is in pane %70.
  setCensus([
    { name: paneNameFor(dir), pane_id: '%70', agent: 'claude', agent_status: 'working', cwd: dir }
  ]);
  resetArgvLog();
  const before = await invoke(deps, { action: 'activate_agent', path: dir });
  check('before the renumber, activate says alreadyRunning',
    before.success === true && before.alreadyRunning === true && before.paneId === '%70');

  // An unrelated pane closes. Ours is the SAME pane, the SAME agent, in the
  // SAME directory — and herdr now calls it %69.
  setCensus([
    { name: paneNameFor(dir), pane_id: '%69', agent: 'claude', agent_status: 'working', cwd: dir }
  ]);
  resetArgvLog();
  const after = await invoke(deps, { action: 'activate_agent', path: dir });
  console.log(JSON.stringify(after, null, 2));

  check(
    'AFTER the renumber it is STILL OURS — ownership does not depend on how many ' +
      'unrelated panes have closed',
    after.success === true && after.alreadyRunning === true,
    after.error
  );
  check('and the pane id it reports is the new one, read live', after.paneId === '%69');
  check(
    'it is NOT refused as occupied — that refusal about our own agent is the bug this ' +
      'case exists for',
    after.refused !== 'occupied',
    after.refused
  );
  check(
    'and NOTHING was started: no second pane for an agent that is already running',
    agentStartIssued() === false,
    `herdr calls: ${JSON.stringify(herdrCalls())}`
  );

  // And the durable record never held a pane id to go stale in the first
  // place — the structural half of the fix rather than the behavioural one.
  const stored = deps.agentRegistry.intents().get(dir)?.record;
  check(
    'the durable record carries NO paneId — a volatile value is not kept in durable storage',
    stored !== undefined && !('paneId' in stored),
    JSON.stringify(stored)
  );
}

// ---------------------------------------------------------------------------
// c4. A `shell` agent is ours even though it has no runtime.
// ---------------------------------------------------------------------------
console.log('\n== c4. a shell agent, which by design has no runtime ==');
{
  // The second always-false ownership answer, and it was introduced by the fix
  // for the first: `ourPaneIn` originally required `agentRuntime !== null`
  // unconditionally, which is right for every launcher but `shell` — where a
  // bare prompt with nothing running in it IS the delivered product, and the
  // name is all there is to see. `confirmAgentPresent` has always drawn that
  // distinction; ownership did not, so a shell agent could never be its own.
  //
  // Found by running the live proof rather than by reading it, which is why
  // there is a case for it here now.
  const dir = ownedDir('case-c4');
  setCensus([
    // No `agent` field: exactly what herdr reports for a `shell` pane.
    { name: paneNameFor(dir), pane_id: '%80', agent_status: 'idle', cwd: dir }
  ]);
  const deps = newCase((reg) =>
    reg.recordActivated({ path: dir, config: { ...KNOBS, launcher: 'shell' } })
  );
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  console.log(JSON.stringify(res, null, 2));

  check(
    'a runtime-less `shell` pane bearing our name IS ours',
    res.success === true && res.alreadyRunning === true,
    res.error
  );
  check('and nothing was started for an agent already running', agentStartIssued() === false);

  // And the same census with a runtime-BEARING launcher configured is NOT
  // ours, because for those a name over a dead pane is not an agent (KAN-58).
  const strict = ownedDir('case-c4-strict');
  setCensus([
    { name: paneNameFor(strict), pane_id: '%81', agent_status: 'idle', cwd: strict }
  ]);
  const deps2 = newCase((reg) =>
    reg.recordActivated({ path: strict, config: { ...KNOBS, launcher: 'claude' } })
  );
  resetArgvLog();
  const res2 = await invoke(deps2, { action: 'activate_agent', path: strict, ...PAST_THE_GATE });
  check(
    'while the SAME empty pane under a runtime-bearing launcher is not ours — it takes ' +
      'the spawn path, because a name registration over a dead pane is not an agent',
    res2.alreadyRunning !== true && agentStartIssued() === true,
    `alreadyRunning=${res2.alreadyRunning} started=${agentStartIssued()}`
  );
}

// ---------------------------------------------------------------------------
// d. herdr unreachable. The case that would otherwise fail silently.
// ---------------------------------------------------------------------------
console.log('\n== d. herdr does not answer at all ==');
{
  const dir = ownedDir('case-d');
  setCensus('DOWN');
  const deps = newCase((reg) => reg.recordConfigured({ path: dir, config: KNOBS }));
  resetArgvLog();
  const res = await invoke(deps, { action: 'activate_agent', path: dir });
  console.log(JSON.stringify(res, null, 2));

  check('activate is REFUSED', res.success === false);
  check(
    "labelled 'unverifiable' — a third outcome, distinct from both spawn and refuse-occupied",
    res.refused === 'unverifiable',
    res.refused
  );
  check(
    'the message says the check could not be PERFORMED rather than that the directory is free',
    /did not answer/.test(res.error ?? '') && /silence, not evidence/.test(res.error ?? ''),
    res.error
  );
  check(
    'NO `agent start` was issued. This is the assertion that matters: an empty census ' +
      'from an unreachable herdr must not read as an all-clear',
    agentStartIssued() === false,
    `herdr calls: ${JSON.stringify(herdrCalls())}`
  );
  check('the response says so: started: false', res.started === false);
}

// ---------------------------------------------------------------------------
// e. configure does NOT refuse — it reports.
// ---------------------------------------------------------------------------
console.log('\n== e. configure on an occupied path ==');
{
  const dir = ownedDir('case-e');
  setCensus([
    { name: 'butchr-task-kan-80', pane_id: '%45', agent: 'claude', agent_status: 'blocked', cwd: dir }
  ]);
  const deps = newCase();
  resetArgvLog();
  const res = await invoke(deps, { action: 'configure_agent', path: dir, ...KNOBS });
  console.log(JSON.stringify(res, null, 2));

  check('configure SUCCEEDS on an occupied directory', res.success === true);
  check(
    'carrying occupiedBy as advisory: pane_id, name and agent_status',
    Array.isArray(res.occupiedBy) &&
      res.occupiedBy.length === 1 &&
      res.occupiedBy[0].paneId === '%45' &&
      res.occupiedBy[0].name === 'butchr-task-kan-80' &&
      res.occupiedBy[0].agentStatus === 'blocked',
    JSON.stringify(res.occupiedBy)
  );
  check(
    'and a note saying activate WILL refuse until that pane is gone, so the ordering ' +
      'is discoverable at configure time rather than hours later',
    /activate will REFUSE/i.test(res.note ?? ''),
    res.note
  );
  check(
    'the record really was written — this is a success, not a soft refusal',
    deps.agentRegistry.intents().has(dir)
  );
  // Why it must not refuse: adopting a fleet means configure-then-stand-down-
  // then-activate, and a configure that inherited the guard would fail every
  // call on day one and make the required ordering undiscoverable.
  const activate = await invoke(deps, { action: 'activate_agent', path: dir });
  check(
    'and the guard is still in place one call later: activate on that same path refuses',
    activate.success === false && activate.refused === 'occupied'
  );
}

// e2. configure when herdr cannot be asked. It still succeeds — but it does
// NOT report an empty occupiedBy as though it had looked and found nothing.
console.log('\n== e2. configure when herdr does not answer ==');
{
  const dir = ownedDir('case-e2');
  setCensus('DOWN');
  const deps = newCase();
  const res = await invoke(deps, { action: 'configure_agent', path: dir, ...KNOBS });
  check('configure still succeeds — it never refuses on occupancy', res.success === true);
  check(
    'and says the occupancy is UNKNOWN rather than reporting an empty list, which would be ' +
      'the check rendering its own failure as an all-clear',
    res.occupancyUnknown === true && (res.occupiedBy ?? []).length === 0,
    JSON.stringify({ occupancyUnknown: res.occupancyUnknown, occupiedBy: res.occupiedBy })
  );
}

// ---------------------------------------------------------------------------
process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
