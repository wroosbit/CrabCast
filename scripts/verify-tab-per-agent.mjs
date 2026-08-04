// Live check of the extraction source's KAN-32 fix against a real herdr, at
// the level the bug actually lived: HerdrBridge.
//
// Before the fix, `herdr agent start` was called with no placement flags, so
// every agent split whatever pane was current and the whole fleet piled into
// one tab. Panes in a rendered tab are sized by the app's split layout, so the
// width each agent got was the terminal divided by the fleet size — at seven
// agents, about four columns, and a tail came back as "*\nChan\nnell\ning…".
// The property the fix buys is that an agent's width no longer depends on how
// many other agents exist.
//
// This spawns three scratch agents and asserts three things:
//
//   1. placement    — each lands in a tab of its own, one pane per tab
//   2. readability  — each tails at full width, not a few columns
//   3. independence — spawning the third does not change the width of the
//                     first two. This is the assertion that fails on the old
//                     code, and it is the whole point of the change.
//
// Usage: node scripts/verify-tab-per-agent.mjs [scratch-root]
//
// Run it after `npm run build`, against the live herdr. It creates and
// removes its own scratch agents and touches nothing else; agents that were
// already running are left alone, which the run also reports on.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HerdrBridge } from '../dist/herdr.js';
import { paneNameFor, PANE_NAME_PREFIX } from '../dist/identity.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';

// Three directories this script owns outright. An agent IS its directory now,
// so the scratch agents are scratch DIRECTORIES — and the script creates them
// itself, because `configure` refuses a path that is not there and CrabCast
// creates none of its own.
const SCRATCH = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kan32-verify-'));
const DIRS = ['a', 'b', 'c'].map((suffix) => {
  const dir = path.join(SCRATCH, suffix);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
});
const CONFIG = {
  priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell'
};
const dataDir = process.env.CRABCAST_DATA_DIR
  ? path.resolve(process.env.CRABCAST_DATA_DIR)
  : DEFAULT_DATA_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function herdr(args) {
  const out = execFileSync('herdr', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

/** herdr's view of one agent: which tab it is in, and how full that tab is. */
function placementOf(dir) {
  const name = paneNameFor(dir);
  const agent = herdr(['agent', 'get', name])?.result?.agent;
  if (!agent) return undefined;
  const tabs = herdr(['tab', 'list', '--workspace', agent.workspace_id])?.result?.tabs ?? [];
  const tab = tabs.find((t) => t.tab_id === agent.tab_id);
  return {
    name,
    tabId: agent.tab_id,
    terminalId: agent.terminal_id,
    panesInTab: tab?.pane_count ?? 0
  };
}

// The width of a pane is what the bug was about, so measure it rather than
// eyeball the tail: a shell that prints its own $COLUMNS reports the grid it
// was actually given.
function widthOf(dir) {
  const tail = bridge.tailAgent(dir, 40);
  if (!tail.success) return { error: tail.error };
  const cols = [...(tail.text ?? '').matchAll(/COLS=(\d+)/g)].map((m) => Number(m[1]));
  return { cols: cols.length ? cols[cols.length - 1] : undefined, text: tail.text ?? '' };
}

const bridge = new HerdrBridge(dataDir);

// Agents already running, so the report can show the change disturbed none of
// them. Recorded by terminal id: pane and tab ids renumber as panes come and
// go, and comparing those would produce false alarms.
const before = (herdr(['agent', 'list'])?.result?.agents ?? [])
  .filter((a) => a.name.startsWith(PANE_NAME_PREFIX))
  .map((a) => ({ name: a.name, terminalId: a.terminal_id }));
console.log(`pre-existing crabcast agents: ${before.length}`);
for (const a of before) console.log(`  ${a.name} (${a.terminalId})`);

// A shell that reports its own width every second is enough of an agent for
// this, and far cheaper than launching a real one.
const REPORT_WIDTH = 'while true; do echo "COLS=$COLUMNS"; sleep 1; done';

try {
  console.log('\n== spawn two agents ==');
  for (const dir of DIRS.slice(0, 2)) {
    bridge.spawnSession(dir, CONFIG);
    await sleep(2500);
  }
  for (const dir of DIRS.slice(0, 2)) {
    await bridge.sendToAgent(dir, REPORT_WIDTH);
  }
  await sleep(3000);

  const placed = DIRS.slice(0, 2).map(placementOf);
  for (const p of placed) console.log(`  ${p?.name}: tab=${p?.tabId} panes-in-tab=${p?.panesInTab}`);

  const distinctTabs = new Set(placed.map((p) => p?.tabId)).size === 2;
  const alone = placed.every((p) => p?.panesInTab === 1);
  console.log(`  different tabs: ${distinctTabs}`);
  console.log(`  one pane per tab: ${alone}`);

  console.log('\n== tails (this is what tail_agent returns) ==');
  const widthsBefore = {};
  for (const dir of DIRS.slice(0, 2)) {
    const w = widthOf(dir);
    widthsBefore[dir] = w.cols;
    console.log(`  ${paneNameFor(dir)}: COLUMNS=${w.cols}`);
    console.log(
      (w.text ?? '').trimEnd().split('\n').slice(-3).map((l) => `    | ${l}`).join('\n')
    );
  }

  console.log('\n== spawn a third; the first two must not narrow ==');
  bridge.spawnSession(DIRS[2], CONFIG);
  await sleep(2500);
  await bridge.sendToAgent(DIRS[2], REPORT_WIDTH);
  await sleep(3000);

  let unchanged = true;
  for (const dir of DIRS.slice(0, 2)) {
    const after = widthOf(dir).cols;
    const same = after === widthsBefore[dir];
    unchanged &&= same;
    console.log(`  ${paneNameFor(dir)}: ${widthsBefore[dir]} -> ${after} ${same ? '(unchanged)' : '(CHANGED)'}`);
  }
  console.log(`  ${placementOf(DIRS[2])?.name}: tab=${placementOf(DIRS[2])?.tabId}`);

  console.log('\n== pre-existing agents ==');
  const after = herdr(['agent', 'list'])?.result?.agents ?? [];
  const survivors = before.filter((a) => after.some((b) => b.terminal_id === a.terminalId));
  console.log(`  still present: ${survivors.length}/${before.length}`);

  // A tail proves more than presence: it is the operation a fleet supervisor
  // actually depends on, and it fails on an agent whose terminal has gone.
  const tailable = before.filter((a) => {
    try {
      return herdr(['agent', 'read', a.name, '--source', 'visible', '--lines', '1'])?.result?.read;
    } catch {
      return false;
    }
  });
  console.log(`  still tailable: ${tailable.length}/${before.length}`);

  const readable = Object.values(widthsBefore).every((c) => c && c >= 60);
  const ok = distinctTabs && alone && readable && unchanged && survivors.length === before.length;
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  console.log('\n== cleanup ==');
  for (const dir of DIRS) {
    const r = bridge.closeAgentByPath(dir);
    // Closing the agent's last pane is also what closes its tab, so there is
    // no tab to tidy up separately.
    console.log(`  ${dir}: ${r.success ? 'closed' : r.error}`);
  }
  // The scratch directories are THIS SCRIPT's, not CrabCast's — it created
  // them and so it removes them. CrabCast neither made nor may delete them,
  // which is the point of `configure` refusing a path that does not exist.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  // The bridge still holds attach PTYs, which would keep the loop alive.
  await sleep(500);
  process.exit(process.exitCode ?? 0);
}
