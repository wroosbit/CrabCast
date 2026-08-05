#!/usr/bin/env node
// KAN-136: a daemon restart leaves the fleet REACHABLE, for EVERY launcher.
//
// WHY THIS SCRIPT EXISTS AT ALL, which is the finding rather than the fix.
//
// Restart survival had exactly one assertion in this suite —
// `verify-fleet-switch-live` section 3 — and that script runs a `shell`
// launcher, chosen deliberately so a live proof does not have to pay for a
// language model. `shell` is also the one launcher whose pane reports no
// runtime, and for a long time that put it on a different branch of every
// "does an agent exist here" question in the daemon. So the single proof of
// the single most expensive behaviour in this codebase was running on the
// special case, and the general case — a real `claude` agent — was never
// asserted anywhere. T1 did not create that hole; it made it universal.
//
// This is the CI-half counterpart, and it runs BOTH launchers through the
// same sequence. A real `claude` spawn cannot go in the live half (it costs
// model money on every run, which is why the live probe is a shell in the
// first place) so the runtime is what is stubbed — the census reports
// `agent: "claude"` behind the pane, which is the only fact about a claude
// agent any of this code reads. Everything on the daemon side is the real
// compiled code: the real `reconcileAgents`, the real `MessageRouter`, the
// real `HerdrBridge` including `initPty` and a real PTY attach, a real
// on-disk `AgentRegistry`.
//
// WHAT A DAEMON RESTART ACTUALLY IS, and how it is reproduced here without
// SIGKILLing anything: herdr owns the panes and the daemon owns the session
// map, so a daemon that dies loses every session and not one pane. That state
// is a NEW `HerdrBridge` and a NEW `MessageRouter` over the SAME registry file
// and the SAME stub census — no sessions, all the panes. The old bridge's PTYs
// are killed first, exactly as the operating system would have.
//
// THE REGRESSION IT IS BUILT AGAINST. `reconcile` built its "already running,
// leave it alone" set from the ownership test alone. Every surviving pane is
// still ours after a restart, so at boot that set was the whole fleet:
// reconcile skipped all of it, nothing was attached, and `activate` — which
// returned early on the same fact — handed back no session id either. The
// fleet came back visible and unreachable, with a boot log saying it was fine.
// Both halves are asserted here as POSITIVE facts:
//
//   * the row reports `sessionless: false` with a session id that is NOT the
//     one from before the restart — a fresh attach, not a remembered name;
//   * the pane count is COUNTED, from a stub census that really gains a pane
//     on `agent start` and really loses one on `pane close`;
//   * `agent start` is counted from the stub's argv log across the restart, so
//     "it re-attached rather than re-spawning" is evidence rather than
//     inference — and a double-spawn would be caught even if herdr refused it.
//
// SIX SECTIONS, the first four run once per launcher and the last two once:
//
//   1. start        — the agent runs, one pane, one `agent start`
//   2. restart      — a fresh daemon RE-ATTACHES: sessionless false, new
//                     session id, no `agent start`, still one pane
//   3. call again   — `activate` on the now-attached agent is the no-op it has
//                     always been: alreadyRunning, started false, and NOTHING
//                     issued to herdr at all
//   4. reconcile
//      again        — the alive set is still meaningful for a non-boot caller:
//                     recognised AND attached is 'already-running', and no
//                     second attach is opened
//   5. boundary     — a FOREIGN pane after a restart still REFUSES. The attach
//                     is reached from the ours-branch, so widening it by an
//                     inch would re-attach to a stranger's terminal.
//   6. no writes    — `attachSession` is a separate verb because a re-attach
//                     must not re-provision a directory somebody has been
//                     working in. Sections 1–5 count panes and count calls;
//                     this one reads the FILES (KAN-170 item 12).
//
// AND EVERY NEGATIVE CLAIM ABOUT THE ARGV LOG WAITS BEFORE IT LOOKS. The attach
// is issued through `pty.spawn` and lands in the log milliseconds later, so
// "no second attach was opened", asked at the instant the call resolved, could
// not tell a refusal from one still in flight (KAN-170 item 13). See
// `afterQuiescence`.
//
// Usage:
//   npm run build
//   node scripts/verify-restart-survival.mjs [distDir]

import { createHash } from 'crypto';
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
const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan136-restart-'));
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
// THE STUB. Stateful, like verify-idempotent-lifecycle's, plus the two things
// a restart proof needs that an idempotence proof did not:
//
//   * `agent start` records a RUNTIME behind the pane when the command it was
//     handed runs `claude`, and none when it runs a bare shell. That single
//     field is the entire difference between the two launchers as far as this
//     daemon is concerned — it is what `ourPaneIn`, `confirmAgentPresent` and
//     the fleet census all read — so a stub that always reported one would
//     prove the claude path and quietly skip the shell path, and vice versa.
//
//   * `agent attach` HOLDS THE TERMINAL OPEN instead of exiting. A real attach
//     does; a stub that returned immediately would have the PTY exit
//     milliseconds later, the session go 'terminated', and the row report
//     `sessionless: true` again — the proof would fail for a reason that is
//     about the stub. It is killed on the way out.
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
// a served one. This log is the evidence for "no \`agent start\` was issued
// across the restart" — asserted, not inferred from a response.
fs.appendFileSync(ARGV_LOG, argv.join(' ') + '\\n');

const panes = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
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
  // herdr keeps agent names unique, and modelling that is what makes a
  // double-spawn impossible rather than merely unlikely.
  if (panes.some((p) => p.name === name)) err('agent_name_taken', 'agent name is taken');
  const cwdFlag = argv.indexOf('--cwd');
  const sep = argv.indexOf('--');
  const command = sep === -1 ? '' : argv.slice(sep + 1).join(' ');
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    agent_status: 'working',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1],
    // The runtime herdr reports behind the pane — the one fact that puts the
    // two launchers on different branches everywhere in this daemon.
    ...(/\\bclaude\\b/.test(command) ? { agent: 'claude' } : {})
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

if (argv[0] === 'agent' && argv[1] === 'attach') {
  // What a real attach does: hold the terminal until it is killed.
  setInterval(() => {}, 60000);
} else if (argv[0] === 'tab' && argv[1] === 'create') {
  ok({ result: undefined, tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } });
} else if (argv[0] === 'pane' && argv[1] === 'list') {
  ok({ panes: [] });
} else {
  ok({});
}
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;
fs.writeFileSync(PANE_SEQ, '0');

const setCensus = (panes) => fs.writeFileSync(CENSUS_FILE, JSON.stringify(panes));
const censusPanes = () => JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));
/** How many panes exist in a directory, whosever they are. THE measurement. */
const panesIn = (dir) => censusPanes().filter((p) => p.cwd === dir);

const resetArgvLog = () => fs.writeFileSync(ARGV_LOG, '');
const herdrCalls = () => {
  try {
    return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const callsMatching = (re) => herdrCalls().filter((line) => re.test(line));

/**
 * Wait for a call to show up in the stub's log.
 *
 * The attach is the one herdr call this daemon makes through `pty.spawn`
 * rather than `execSync`, so it is genuinely asynchronous: the bridge returns
 * as soon as the PTY exists and the stub appends its argv a few milliseconds
 * later. Asserting straight after `reconcileAgents` resolves therefore asks
 * the log a question it cannot answer yet — and a fixed sleep would be a
 * flake waiting for a slow runner. Bounded, so a missing call still FAILS
 * rather than hanging.
 */
async function waitForCall(re, timeoutMs = 10000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (callsMatching(re).length > 0) {
      observedAttachLatencies.push(Date.now() - startedAt);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * NEGATIVE assertions about herdr calls, which need a wait the positive ones
 * do not — and did not have (KAN-170 item 13).
 *
 * `callsMatching(/^agent attach/).length === 0` asked the log a question at the
 * instant the operation returned. The attach is the one herdr call this daemon
 * makes through `pty.spawn` rather than `execSync`, so it lands in the log
 * MILLISECONDS AFTER the call that issued it resolves: a spurious second attach
 * would have been issued, and counted zero, and the check would have passed
 * while the thing it forbids was in flight. The positive assertion two sections
 * up already knew this — it uses `waitForCall` — so the file held both shapes
 * at once, one waiting and one not.
 *
 * THE WINDOW IS DERIVED, NOT PICKED. A magic sleep is a guess that goes stale
 * on a slower runner, so this uses what THIS RUN has already measured: the
 * longest time a positive attach actually took to appear, multiplied out, with
 * a floor for the case where no attach has been observed yet. The multiplier is
 * the margin; the floor is the fallback. Both are reported in the detail string
 * so a reader can see what the silence was worth.
 */
const observedAttachLatencies = [];
const QUIESCE_FLOOR_MS = 500;
const QUIESCE_MULTIPLIER = 20;
function quiesceMs() {
  const worst = observedAttachLatencies.length ? Math.max(...observedAttachLatencies) : 0;
  return Math.max(QUIESCE_FLOOR_MS, worst * QUIESCE_MULTIPLIER);
}

/**
 * Wait long enough that a call issued before now would have been logged, then
 * report what is there. Returns the matching lines and the basis, so the caller
 * asserts on the count AND says what the silence rests on.
 */
async function afterQuiescence(re) {
  const waited = quiesceMs();
  await new Promise((r) => setTimeout(r, waited));
  const worst = observedAttachLatencies.length ? Math.max(...observedAttachLatencies) : 0;
  return {
    calls: callsMatching(re),
    basis:
      `waited ${waited}ms — ${QUIESCE_MULTIPLIER}× the slowest attach this run has actually ` +
      `observed (${worst}ms), floor ${QUIESCE_FLOOR_MS}ms`
  };
}

/**
 * Cases that reach a spawn pass the capacity gate deliberately. The gate reads
 * the real machine; this script is about restart survival, and a proof that
 * depends on the runner's load average is a proof that goes red about the
 * runner. Reconciliation passes `override` for its own reasons and does not
 * need this.
 */
const PAST_THE_GATE = { override: true };

/** Every session this script has opened a PTY for, so none outlives it. */
const openBridges = [];
function newBridge() {
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  openBridges.push(bridge);
  return bridge;
}

/**
 * A daemon dying: its PTYs go with the process. Called before the successor
 * bridge is built, so the successor's `--takeover` is taking over from a
 * client that is genuinely gone — which is what happens on a real restart.
 */
function killPtys(bridge) {
  for (const session of bridge.listActiveSessions()) {
    try {
      session.ptyProcess?.kill();
    } catch {}
  }
}

function invoke(bridge, registry, events, request) {
  return new Promise((resolve) => {
    new MessageRouter({
      config,
      herdrBridge: bridge,
      daemonStartedAt: new Date(),
      agentRegistry: registry,
      send: (msg) => resolve(msg),
      broadcast: (msg) => events.push(msg)
    }).handle(request);
  });
}

const routerFor = (bridge, registry, events) =>
  new MessageRouter({
    config,
    herdrBridge: bridge,
    daemonStartedAt: new Date(),
    agentRegistry: registry,
    send: () => {},
    broadcast: (msg) => events.push(msg)
  });

const KNOBS = { priority: 1, refusable: true, chargeable: true, preemptable: true };

// ===========================================================================
// The sequence, run once per launcher.
// ===========================================================================
for (const launcher of ['shell', 'claude']) {
  console.log(`\n${'='.repeat(76)}\nLAUNCHER: ${launcher}\n${'='.repeat(76)}`);

  const dir = ownedDir(`survivor-${launcher}`);
  const paneName = paneNameFor(dir);
  const registryFile = path.join(tmp, `agents-${launcher}.jsonl`);
  setCensus([]);

  // ----------------------------------------------------------- 1. it starts
  console.log(`\n-- 1. the agent starts under daemon #1`);
  const registry1 = new AgentRegistry(registryFile);
  const bridge1 = newBridge();
  const events1 = [];
  registry1.recordConfigured({ path: dir, config: { ...KNOBS, launcher } });
  resetArgvLog();

  const started = await invoke(bridge1, registry1, events1, {
    action: 'activate_agent', path: dir, ...PAST_THE_GATE
  });
  console.log(JSON.stringify({
    success: started.success, started: started.started, verified: started.verified,
    sessionId: started.sessionId, paneId: started.paneId
  }, null, 2));

  check(
    `[${launcher}] the agent starts, verified against the census before success is reported`,
    started.success === true && started.started === true && started.verified === true,
    `success=${started.success} started=${started.started} verified=${started.verified} ` +
      `error=${started.error ?? '(none)'}`
  );
  check(
    `[${launcher}] one pane, one \`agent start\``,
    panesIn(dir).length === 1 && callsMatching(/^agent start\b/).length === 1,
    `panes=${panesIn(dir).length} starts=${callsMatching(/^agent start\b/).length}`
  );
  check(
    `[${launcher}] and the census reports the runtime this launcher delivers — the fact ` +
      `that puts the two launchers on different branches`,
    (panesIn(dir)[0]?.agent ?? null) === (launcher === 'claude' ? 'claude' : null),
    `agent=${JSON.stringify(panesIn(dir)[0]?.agent ?? null)}`
  );

  const sessionBefore = started.sessionId;

  // --------------------------------------------------------- 2. the restart
  console.log(`\n-- 2. the daemon dies; a fresh one reconciles`);
  killPtys(bridge1);
  const registry2 = new AgentRegistry(registryFile);
  const bridge2 = newBridge();
  const events2 = [];
  const router2 = routerFor(bridge2, registry2, events2);

  check(
    `[${launcher}] (setup) the pane survived the daemon, and the fresh daemon holds no ` +
      `session for it — recognised, unattached, which is the whole state under test`,
    panesIn(dir).length === 1 && bridge2.getSessionByPath(dir) === undefined,
    `panes=${panesIn(dir).length} session=${bridge2.getSessionByPath(dir)?.sessionId ?? 'none'}`
  );
  check(
    `[${launcher}] (setup) and the registry still expects it`,
    registry2.expected().some((r) => r.path === dir)
  );

  resetArgvLog();
  const reconcileLog = [];
  const result = await reconcileAgents({
    registry: registry2,
    herdrBridge: bridge2,
    router: router2,
    cause: 'reboot',
    log: (...a) => reconcileLog.push(a.join(' '))
  });
  for (const line of reconcileLog) console.log(`    ${line}`);

  const outcome = result.outcomes.find((o) => o.path === dir);
  check(
    `[${launcher}] reconcile REATTACHED it — not "already running; leaving it alone", which ` +
      `is the answer that left the fleet unreachable`,
    outcome?.result === 'reattached',
    `result=${outcome?.result} error=${outcome?.error ?? '(none)'}`
  );
  check(
    `[${launcher}] NOTHING was started — counted from the stub's argv log across the whole ` +
      `restart, so a double-spawn herdr refused would still show`,
    callsMatching(/^agent start\b/).length === 0,
    `starts=${callsMatching(/^agent start\b/).length}: ${JSON.stringify(herdrCalls())}`
  );
  const attachRe = new RegExp(`^agent attach ${paneName} --takeover$`);
  await waitForCall(attachRe);
  check(
    `[${launcher}] and the terminal was taken back: exactly one \`agent attach --takeover\` ` +
      `for this pane. \`--takeover\` is load-bearing here rather than defensive — the dead ` +
      `daemon's PTY still held herdr's one attach slot`,
    callsMatching(attachRe).length === 1,
    JSON.stringify(callsMatching(/^agent attach\b/))
  );
  check(
    `[${launcher}] STILL EXACTLY ONE PANE — counted, from a census that would have shown two`,
    panesIn(dir).length === 1,
    `counted ${panesIn(dir).length}: ${JSON.stringify(panesIn(dir).map((p) => p.pane_id))}`
  );

  const listed = await invoke(bridge2, registry2, events2, { action: 'list_agents' });
  const row = listed.agents.find((a) => a.path === dir);
  console.log(`    row: ${JSON.stringify({
    sessionless: row?.sessionless, sessionId: row?.sessionId, status: row?.status,
    herdrStatus: row?.herdrStatus
  })}`);

  check(
    `[${launcher}] the fleet row reports sessionless: FALSE — the daemon can reach it again`,
    row?.sessionless === false,
    `sessionless=${row?.sessionless} sessionId=${row?.sessionId}`
  );
  check(
    `[${launcher}] with a NEW session id, not the dead daemon's — a fresh attach rather than ` +
      `a remembered name`,
    typeof row?.sessionId === 'string' && row.sessionId !== sessionBefore,
    `${row?.sessionId} vs ${sessionBefore}`
  );
  check(
    `[${launcher}] and nothing is reported missing`,
    listed.missingAgents.length === 0,
    JSON.stringify(listed.missingAgents)
  );
  check(
    `[${launcher}] the re-attach was ANNOUNCED, so a client that could not reach the agent ` +
      `learns that it can`,
    events2.filter((e) => e.action === 'agent.activated' && e.path === dir).length === 1,
    JSON.stringify(events2.map((e) => e.action))
  );

  // ------------------------------------------- 3. the no-op is still a no-op
  console.log(`\n-- 3. activate on the now-attached agent (KAN-127's contract, unchanged)`);
  resetArgvLog();
  const again = await invoke(bridge2, registry2, events2, {
    action: 'activate_agent', path: dir, ...PAST_THE_GATE
  });
  console.log(JSON.stringify({
    success: again.success, alreadyRunning: again.alreadyRunning, started: again.started,
    reattached: again.reattached, sessionId: again.sessionId
  }, null, 2));

  check(
    `[${launcher}] it still answers alreadyRunning: true, started: false`,
    again.success === true && again.alreadyRunning === true && again.started === false,
    `success=${again.success} alreadyRunning=${again.alreadyRunning} started=${again.started}`
  );
  const quietAfterActivate = await afterQuiescence(/^agent attach\b/);
  check(
    `[${launcher}] it STARTS NOTHING and ATTACHES NOTHING — no \`agent start\`, no second ` +
      `\`agent attach\`, asserted against the argv log AFTER waiting long enough for one to land`,
    callsMatching(/^agent start\b/).length === 0 && quietAfterActivate.calls.length === 0,
    `${quietAfterActivate.basis}; log=${JSON.stringify(herdrCalls())}`
  );
  check(
    `[${launcher}] it hands back the session it already holds, and does not claim to have ` +
      `re-attached`,
    again.sessionId === row?.sessionId && again.reattached === undefined,
    `${again.sessionId} vs ${row?.sessionId}, reattached=${again.reattached}`
  );
  check(
    `[${launcher}] and there is still exactly one pane`,
    panesIn(dir).length === 1,
    `counted ${panesIn(dir).length}`
  );

  // ------------------------------- 4. the alive set still means something
  console.log(`\n-- 4. reconcile again, with the session held`);
  resetArgvLog();
  const secondPass = await reconcileAgents({
    registry: registry2, herdrBridge: bridge2, router: router2, cause: 'reboot', log: () => {}
  });
  check(
    `[${launcher}] recognised AND attached is 'already-running' — the guard still means ` +
      `something for a caller that is not booting, and "always re-attach" is not what was ` +
      `written`,
    secondPass.outcomes.find((o) => o.path === dir)?.result === 'already-running',
    `result=${secondPass.outcomes.find((o) => o.path === dir)?.result}`
  );
  const quietAfterReconcile = await afterQuiescence(/^agent attach\b/);
  check(
    `[${launcher}] so no second attach was opened — and the log was read after a wait, not at ` +
      `the instant reconcile resolved`,
    quietAfterReconcile.calls.length === 0,
    `${quietAfterReconcile.basis}; log=${JSON.stringify(herdrCalls())}`
  );
}

// ===========================================================================
// 5. THE BOUNDARY. A foreign pane after a restart still refuses.
// ===========================================================================
console.log(`\n${'='.repeat(76)}\n5. THE BOUNDARY — a stranger's pane is not something to re-attach to\n${'='.repeat(76)}`);
{
  // WHY THIS IS HERE. The attach is reached from the `occupancy.ours` branch,
  // and the refusal is the branch next door. Widening "ours" by an inch to
  // make a restart work would have this daemon take over the terminal of an
  // agent it did not start — strictly worse than the bug being fixed, and
  // invisible except to whoever was typing in that pane.
  const dir = ownedDir('foreign-after-restart');
  setCensus([
    {
      name: 'butchr-task-kan-124',
      pane_id: '%900',
      agent: 'claude',
      agent_status: 'working',
      cwd: dir
    }
  ]);
  const registry = new AgentRegistry(path.join(tmp, 'agents-foreign.jsonl'));
  // The damaged shape this is really about: the registry expects an agent
  // here, and what is live in the directory is somebody else's.
  registry.recordActivated({ path: dir, config: { ...KNOBS, launcher: 'claude' } });
  const bridge = newBridge();
  const events = [];
  const router = routerFor(bridge, registry, events);
  resetArgvLog();

  const outcomes = await reconcileAgents({
    registry, herdrBridge: bridge, router, cause: 'reboot', log: () => {}
  });
  const outcome = outcomes.outcomes.find((o) => o.path === dir);
  console.log(`    outcome: ${JSON.stringify(outcome)}`);

  check(
    'reconcile does NOT re-attach to a pane that is not ours',
    outcome?.result === 'failed' && /none of them is ours/.test(outcome?.error ?? ''),
    `result=${outcome?.result} error=${outcome?.error ?? '(none)'}`
  );
  const quietAfterRefusal = await afterQuiescence(/^agent attach\b/);
  check(
    'nothing was started and nothing was attached — after a wait, because an attach that is ' +
      'refused and an attach that has not been logged yet look identical at time zero',
    callsMatching(/^agent start\b/).length === 0 && quietAfterRefusal.calls.length === 0,
    `${quietAfterRefusal.basis}; log=${JSON.stringify(herdrCalls())}`
  );
  check(
    "and the stranger's pane is untouched — CrabCast never closes a pane it did not start",
    panesIn(dir).length === 1 && panesIn(dir)[0].name === 'butchr-task-kan-124' &&
      !herdrCalls().some((l) => /^pane close\b/.test(l)),
    JSON.stringify(panesIn(dir).map((p) => p.name))
  );
}

// ===========================================================================
// 6. THE RE-ATTACH PROVISIONS NOTHING (KAN-170 item 12).
//
// `attachSession` is a separate verb from `spawnSession` for one stated reason,
// and it is a reason about WRITES: routing a restart through the spawn path
// would re-run `launcher.setup`, rewrite the workspace `.mcp.json` and rewrite
// the sidecar prompt file for an agent that has been working in that directory
// for an hour. Those steps are idempotent, so doing them would MOSTLY be
// harmless — which is exactly why nothing noticed that no assertion anywhere
// held the separation. Sections 1–5 above count panes and count `agent start`;
// not one of them reads a file.
//
// SO THIS SECTION OBSERVES THE BYTES. The agent is configured with the two
// artifacts the doc comment names — an `.mcp.json` in the caller's own
// directory and a bootstrap prompt in CrabCast's sidecar — so the spawn has
// something to write and the re-attach has something to leave alone. The
// contrast is the claim: the same run watches the spawn verb create them and
// the attach verb not touch them.
//
// WHAT IT DOES NOT REACH, said here rather than left to be inferred. It watches
// the agent's directory and CrabCast's sidecar. A `launcher.setup` that writes
// into the user's GLOBAL config — the claude launcher's folder-trust entry is
// the live example — is outside both, and this section runs the `shell`
// launcher, which has no such write. Nothing covers that one today.
// ===========================================================================
console.log(`\n${'='.repeat(76)}\n6. THE RE-ATTACH WRITES NOTHING — observed as files, not as calls\n${'='.repeat(76)}`);
{
  const dir = ownedDir('provisioned-survivor');
  const paneName = paneNameFor(dir);
  setCensus([]);
  const PROVISIONED = {
    ...KNOBS,
    launcher: 'shell',
    prompt: 'KAN-170 item 12: this agent has been working for an hour. Do not rewrite this file.\n',
    mcpServers: { crabcast: 'builtin' }
  };

  const registry1 = new AgentRegistry(path.join(tmp, 'agents-provisioned.jsonl'));
  const bridge1 = newBridge();
  const sidecar = bridge1.sidecarDirFor(dir);
  registry1.recordConfigured({ path: dir, config: PROVISIONED });
  resetArgvLog();

  check(
    '(setup) nothing is in the caller\'s directory before the agent is activated',
    Object.keys(snapshotTree(dir)).length === 0,
    JSON.stringify(Object.keys(snapshotTree(dir)))
  );

  const started = await invoke(bridge1, registry1, [], {
    action: 'activate_agent', path: dir, ...PAST_THE_GATE
  });
  const afterSpawn = { ...snapshotTree(dir, 'workspace'), ...snapshotTree(sidecar, 'sidecar') };
  console.log(`    after the spawn: ${JSON.stringify(Object.keys(afterSpawn))}`);

  check(
    'the agent started, and the SPAWN verb wrote both artifacts — without this the assertion ' +
      'below would be about a directory nobody ever writes to',
    started.success === true &&
      started.started === true &&
      Object.keys(afterSpawn).some((f) => f === 'workspace/.mcp.json') &&
      Object.keys(afterSpawn).some((f) => f.startsWith('sidecar/') && /prompt/i.test(f)),
    `success=${started.success} error=${started.error ?? '(none)'} files=${JSON.stringify(Object.keys(afterSpawn))}`
  );

  // Backdated so that a rewrite CANNOT hide inside mtime granularity. An
  // idempotent rewrite produces identical bytes, so content alone could never
  // detect one — the mtime is the whole detector, and pushing it an hour into
  // the past makes any write at all unmissable.
  const backdated = Date.now() - 3_600_000;
  for (const f of [...walkAllFiles(dir), ...walkAllFiles(sidecar)]) {
    fs.utimesSync(f, new Date(backdated), new Date(backdated));
  }
  const beforeRestart = { ...snapshotTree(dir, 'workspace'), ...snapshotTree(sidecar, 'sidecar') };

  // The restart, exactly as sections 1–5 stage it.
  killPtys(bridge1);
  const registry2 = new AgentRegistry(path.join(tmp, 'agents-provisioned.jsonl'));
  const bridge2 = newBridge();
  const events = [];
  const router2 = routerFor(bridge2, registry2, events);
  resetArgvLog();

  const reconciled = await reconcileAgents({
    registry: registry2, herdrBridge: bridge2, router: router2, cause: 'reboot', log: () => {}
  });
  const outcome = reconciled.outcomes.find((o) => o.path === dir);
  await waitForCall(new RegExp(`^agent attach ${paneName}\\b`));

  // PRECONDITION, and it is the one that matters: "nothing was written" is
  // trivially true of an operation that did not happen. The re-attach has to
  // have really occurred for the observation below to mean anything.
  check(
    'PRECONDITION: the re-attach really happened — reattached, with the attach in the argv log',
    outcome?.result === 'reattached' &&
      callsMatching(new RegExp(`^agent attach ${paneName}\\b`)).length === 1,
    `result=${outcome?.result} error=${outcome?.error ?? '(none)'} ` +
      `attaches=${JSON.stringify(callsMatching(/^agent attach\b/))}`
  );

  const afterAttach = { ...snapshotTree(dir, 'workspace'), ...snapshotTree(sidecar, 'sidecar') };
  const moved = [];
  for (const rel of new Set([...Object.keys(beforeRestart), ...Object.keys(afterAttach)])) {
    const a = beforeRestart[rel];
    const b = afterAttach[rel];
    if (!a) moved.push(`${rel} APPEARED`);
    else if (!b) moved.push(`${rel} VANISHED`);
    else if (a.mtimeMs !== b.mtimeMs) moved.push(`${rel} REWRITTEN (mtime moved)`);
    else if (a.sha !== b.sha) moved.push(`${rel} CHANGED (same mtime, different bytes)`);
  }
  console.log(`    after the re-attach: ${JSON.stringify(Object.keys(afterAttach))}`);

  check(
    'and NOT ONE BYTE was written: no artifact appeared, vanished, was rewritten or changed — ' +
      'this is `attachSession` being an attach rather than a spawn with the spawn skipped',
    moved.length === 0,
    moved.length ? moved.join('; ') : `${Object.keys(afterAttach).length} file(s) untouched`
  );
  // Named separately from the sweep above because it is the artifact the doc
  // comment argues about — "a prompt file whose write fails would refuse an
  // activation that needed no prompt" — so it is worth failing by name rather
  // than as one entry in a list.
  //
  // Compared to what the SAME statSync path reported before the restart, never
  // to the number handed to `utimesSync`: that round trip loses sub-millisecond
  // precision and reports a value set as …573 back as …572.999. Asserting
  // against the literal is a flake, and it is the second time this file's
  // author has walked into it — see verify-daemon-provenance §6c.
  const promptFiles = Object.entries(afterAttach).filter(
    ([rel]) => rel.startsWith('sidecar/') && /prompt/i.test(rel)
  );
  check(
    'the prompt file in particular still carries the mtime it had before the restart, and that ' +
      'mtime is still an hour old — the file whose rewrite would be the rudest of the three, ' +
      'since the agent read it once and moved on',
    promptFiles.length === 1 &&
      promptFiles.every(
        ([rel, meta]) =>
          meta.mtimeMs === beforeRestart[rel]?.mtimeMs && Date.now() - meta.mtimeMs > 3_540_000
      ),
    JSON.stringify(
      promptFiles.map(
        ([rel, m]) =>
          `${rel} @ ${new Date(m.mtimeMs).toISOString()} ` +
          `(${Math.round((Date.now() - m.mtimeMs) / 60_000)} min old)`
      )
    )
  );
}

/** Every regular file under `dir`, at any depth. Absent directory → nothing. */
function walkAllFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkAllFiles(abs));
    else out.push(abs);
  }
  return out;
}

/**
 * What a directory holds, at a resolution that makes a rewrite visible: the
 * file set, each file's mtime, and a hash of its bytes. All three, because each
 * catches something the others do not — a new file, an idempotent rewrite that
 * changed nothing but the timestamp, and an edit that somehow kept the
 * timestamp.
 */
function snapshotTree(dir, prefix = '') {
  const out = {};
  for (const abs of walkAllFiles(dir)) {
    const rel = path.relative(dir, abs);
    const st = fs.statSync(abs);
    out[prefix ? `${prefix}/${rel}` : rel] = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      sha: createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
for (const bridge of openBridges) killPtys(bridge);
process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
