#!/usr/bin/env node
// KAN-338, the live half: the join from a running process tree to one of THIS
// daemon's agents, against a real herdr and a pane CrabCast created.
//
// WHAT FAILURE THIS WOULD CATCH: the attribution added by KAN-338 silently
// answering "not ours" for every tree — a herdr that stopped setting the pane
// handle, a `pane get` that stopped resolving it, a pane-name mismatch between
// what CrabCast mints and what herdr reports back. The sampler would then
// measure nothing on a machine full of our own agents, degrade to the seed
// every minute, and look exactly like a correctly-idle fleet. Its sibling,
// `verify-agent-cost-attribution.mjs`, cannot see any of that: it supplies its
// own attributor, so it proves what the sampler does with an answer and never
// that an answer arrives. THIS FILE IS THE OTHER HALF, and neither is coverage
// on its own.
//
// It would also catch the join succeeding too broadly — a handle that resolved
// to somebody else's pane, or an attributor that charged every tree on the
// machine. §3 asserts the foreign trees on this box stay out, and this box has
// seven of them.
//
// HOW IT WORKS, and why it does not need a claude:
//
//   1. It spawns ONE scratch `shell` agent through `HerdrBridge`, the same code
//      path an activation uses, in a directory it minted itself.
//   2. It starts, inside that pane, a copy of `/bin/sleep` named `claude`. The
//      cost sampler groups trees under the process names in the launcher table
//      (AGENT_RUNTIME_COMMS), so that is a real agent tree by the only
//      definition this daemon has — and it costs a sleep rather than a model.
//   3. It then runs the REAL `finishMeasurement` with the REAL attributor over
//      real /proc, and asserts that tree is charged and every other tree on the
//      machine is not.
//   4. §5 is the red drive: the same run against a build whose pane-handle
//      variable has been renamed, where the tree must fall out of the sample.
//
// WHY IT IS EXCLUDED FROM CI: it needs a running herdr server and a real
// terminal pane, which no GitHub runner has. See the EXCLUSIONS register in
// scripts/verify-proof-registry.mjs.
//
// Usage: node scripts/verify-agent-cost-attribution-live.mjs   (no arguments)
// Run it after `npm run build`. It creates and removes its own scratch agent
// and touches nothing else; agents already running are left alone, and the run
// reports the pane census before and after so a teardown defect is visible.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  finishMeasurement,
  groupByAgent,
  paneHandleOf,
  sampleProcesses,
  startMeasurement
} from '../dist/agent-cost.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';
import { HerdrBridge, ourPaneIn } from '../dist/herdr.js';
import { PANE_NAME_PREFIX, paneNameFor } from '../dist/identity.js';
import { makeMutator } from './mutation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[2]) {
  console.error(
    'refusing to run: this script takes no arguments. It mints its own scratch ' +
    `directory under ${os.tmpdir()} and removes only that.`
  );
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kan338-verify-'));
const AGENT_DIR = fs.realpathSync(
  (() => {
    const d = path.join(SCRATCH, 'agent');
    fs.mkdirSync(d, { recursive: true });
    return d;
  })()
);
// A copy of `sleep` under the name the launcher table calls an agent runtime.
// The sampler's notion of "agent tree" is a process whose `comm` is in
// AGENT_RUNTIME_COMMS, so this is not a stand-in for a tree — it IS one.
const FAKE_RUNTIME = path.join(SCRATCH, 'claude');
fs.copyFileSync('/bin/sleep', FAKE_RUNTIME);
fs.chmodSync(FAKE_RUNTIME, 0o755);

const CONFIG = {
  priority: 1,
  refusable: true,
  chargeable: true,
  preemptable: true,
  launcher: 'shell'
};
const dataDir = process.env.CRABCAST_DATA_DIR
  ? path.resolve(process.env.CRABCAST_DATA_DIR)
  : DEFAULT_DATA_DIR;

const herdrCli = (args) => JSON.parse(execFileSync('herdr', args, { encoding: 'utf8' }));

const bridge = new HerdrBridge(dataDir);
const OUR_NAME = paneNameFor(AGENT_DIR);

const panesBefore = (herdrCli(['agent', 'list'])?.result?.agents ?? []).filter((a) =>
  a.name.startsWith(PANE_NAME_PREFIX)
);
console.log(`scratch agent: ${AGENT_DIR}`);
console.log(`pane name it derives: ${OUR_NAME}`);
console.log(`pre-existing crabcast panes: ${panesBefore.length}`);

/** Every agent-runtime tree on the machine right now, as the sampler sees it. */
const treeRoots = () => [...groupByAgent(sampleProcesses()).keys()];

let threw = null;
try {
  bridge.spawnSession(AGENT_DIR, CONFIG);
  await sleep(2500);
  // Backgrounded rather than `exec`ed, so the pane keeps a shell and teardown
  // is the ordinary path rather than a special case.
  await bridge.sendToAgent(AGENT_DIR, `${FAKE_RUNTIME} 900 &`);
  await sleep(2000);

  // ------------------------------------------------- 1. the pane is ours --
  rule('1. THE PANE — created by CrabCast, and OURS by the one ownership test');

  const census = bridge.listHerdrAgentsChecked();
  check(census.reachable, 'herdr answered the census, so what follows is evidence rather than silence');
  const ours = ourPaneIn(census, AGENT_DIR, CONFIG.launcher);
  check(
    ours !== null && ours.name === OUR_NAME,
    'ourPaneIn — THE ownership test — recognises the pane, by name',
    ours ? ours.name : 'no pane'
  );

  // --------------------------------------------------------- 2. the join --
  rule('2. THE JOIN — a process in that pane resolves back to that pane name');

  const roots = treeRoots();
  const resolved = roots.map((pid) => {
    const handle = paneHandleOf(pid);
    return {
      pid,
      handle: handle.handle,
      unreadable: handle.unreadable,
      paneName: handle.handle ? bridge.paneNameForHandle(handle.handle) : null
    };
  });
  for (const r of resolved) {
    console.log(
      `  pid ${String(r.pid).padStart(8)}  handle ${String(r.handle ?? '—').padEnd(8)}  ` +
      `→ ${r.paneName ?? (r.unreadable ? '<environ unreadable>' : '<no pane>')}`
    );
  }
  const mine = resolved.filter((r) => r.paneName === OUR_NAME);
  check(
    mine.length === 1,
    'exactly one agent tree on this machine resolves to our pane name',
    `${mine.length} tree(s): ${mine.map((m) => m.pid).join(', ') || 'none'}`
  );
  check(
    mine.length === 1 && typeof mine[0].handle === 'string' && mine[0].handle.length > 0,
    'and it got there from a handle the PROCESS was carrying — herdr reports no pid, so the join runs this way round',
    mine.length === 1 ? `HERDR_PANE_ID=${mine[0].handle}` : ''
  );
  // VACUITY GUARD. A machine where nothing else was running would make §3's
  // exclusion assertion trivially true. This box has another orchestrator's
  // fleet on it, which is the population the whole ticket is about.
  const foreignResolved = resolved.filter((r) => r.paneName !== OUR_NAME);
  check(
    foreignResolved.length > 0,
    'VACUITY: there ARE other agent trees on this machine, so excluding them is a real test',
    `${foreignResolved.length} foreign tree(s)`
  );

  // ------------------------------------------------ 3. the real sampler  --
  rule('3. THE SAMPLER — the real attributor over real /proc');

  const attribute = (handle) => bridge.paneNameForHandle(handle) === OUR_NAME;
  const window = startMeasurement();
  await sleep(1500);
  const measurement = finishMeasurement(window, attribute);
  console.log(
    `  seen ${measurement.seen.trees} tree(s): ${measurement.totals.agents} charged, ` +
    `${measurement.seen.foreign} foreign, ${measurement.seen.noHandle} no-handle, ` +
    `${measurement.seen.handleUnreadable} unreadable`
  );
  check(
    measurement.totals.agents === 1,
    'exactly our tree is in the charged sample',
    `${measurement.totals.agents} charged of ${measurement.seen.trees} seen`
  );
  check(
    measurement.seen.foreign === measurement.seen.trees - 1 && measurement.seen.foreign > 0,
    'every other tree on the machine is excluded as foreign, and counted as such',
    `${measurement.seen.foreign} foreign`
  );
  const chargedTree = measurement.agents.find((a) => a.ownership.charged);
  check(
    chargedTree !== undefined && chargedTree.pid === mine[0]?.pid,
    'and the charged tree is the one §2 identified — not some other tree that happened to be counted',
    chargedTree ? `pid ${chargedTree.pid}` : 'none charged'
  );

  // ------------------------------------------ 4. false-positive control  --
  rule('4. FALSE-POSITIVE CONTROL — the attributor is consulted, not assumed');

  // The same window, attributed to a pane name no pane has. If the sampler
  // charged trees regardless of the answer, §3 would pass against a broken
  // join; this is what rules that out without touching the build.
  const strangerWindow = startMeasurement();
  await sleep(500);
  const stranger = finishMeasurement(strangerWindow, (h) => h === 'p_no_such_pane');
  check(
    stranger.totals.agents === 0 && stranger.seen.trees === measurement.seen.trees,
    'an attributor that recognises nothing charges nothing, over the same trees',
    `${stranger.totals.agents} charged of ${stranger.seen.trees} seen`
  );

  // ------------------------------------------------------- 5. red drive  --
  rule('5. RED DRIVE — rename the variable herdr sets, and the tree must fall out');

  const { mutate, mutationsSkipped } = makeMutator({
    distDir: path.join(repoRoot, 'dist'),
    scratch: SCRATCH,
    // Bound to this script's own verdict, which is what makeMutator requires:
    // a mutation that does not apply exactly once is a FAILURE of this run, not
    // a section quietly skipped.
    report: {
      pass: (label, detail) => check(true, label, detail),
      fail: (label, detail) => check(false, label, detail)
    }
  });
  redDrive: {
    // The one string the whole join stands on. Renaming it is the smallest
    // edit that breaks the join without breaking anything else — the build
    // still compiles, the sampler still runs, and every tree simply stops
    // carrying a handle.
    const dir = mutate('handle-var', 'agent-cost.js', "'HERDR_PANE_ID'", "'HERDR_PANE_ID_NOT'");
    if (!dir) break redDrive;
    const mutant = await import(path.join(dir, 'agent-cost.js'));
    const mutantWindow = mutant.startMeasurement();
    await sleep(500);
    const mutantMeasurement = mutant.finishMeasurement(mutantWindow, attribute);
    console.log(
      `  mutant: seen ${mutantMeasurement.seen.trees} tree(s): ` +
      `${mutantMeasurement.totals.agents} charged, ${mutantMeasurement.seen.foreign} foreign, ` +
      `${mutantMeasurement.seen.noHandle} no-handle`
    );
    check(
      mutantMeasurement.totals.agents === 0,
      'RED: with the handle variable renamed, our own live agent is no longer attributed',
      `${mutantMeasurement.totals.agents} charged`
    );
    check(
      mutantMeasurement.seen.noHandle === mutantMeasurement.seen.trees,
      'and the reason recorded is NO-HANDLE — the failure names itself rather than reading as "not ours"',
      `${mutantMeasurement.seen.noHandle} of ${mutantMeasurement.seen.trees}`
    );
    check(
      mutantMeasurement.seen.trees === measurement.seen.trees,
      'VACUITY: the mutant still SEES the same trees, so what changed is attribution and not the sampler',
      `${mutantMeasurement.seen.trees} vs ${measurement.seen.trees}`
    );
  }
  // A mutation that did not apply is already a counted failure, but a reader
  // scanning the output needs to see that §5 ran rather than infer it.
  const skipped = mutationsSkipped();
  check(
    skipped.length === 0,
    'every mutation in this run applied, so no section above silently tested an unmutated build',
    skipped.length ? skipped.join(', ') : 'none skipped'
  );
} catch (e) {
  threw = e;
  console.error(`\nRESULT: FAIL — the run threw before reaching its verdict: ${e?.stack ?? e}`);
  failures += 1;
} finally {
  console.log('\n== cleanup ==');
  const r = bridge.closeAgentByPath(AGENT_DIR);
  console.log(`  ${AGENT_DIR}: ${r.success ? 'closed' : r.error}`);
  const panesAfter = (herdrCli(['agent', 'list'])?.result?.agents ?? []).filter((a) =>
    a.name.startsWith(PANE_NAME_PREFIX)
  );
  console.log(`  crabcast panes: ${panesBefore.length} before, ${panesAfter.length} after`);
  if (panesAfter.length > panesBefore.length) {
    console.log(
      `  LEFT BEHIND: ${panesAfter
        .map((a) => a.name)
        .filter((n) => !panesBefore.some((b) => b.name === n))
        .join(', ')}`
    );
    failures += 1;
  }
  // This script minted SCRATCH two lines into the run and nothing else can name
  // it, so removing it recursively can only remove what this run created.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  await sleep(500);

  console.log(`\n${'='.repeat(78)}`);
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  console.log('='.repeat(78));
  process.exit(failures ? 1 : 0);
}
