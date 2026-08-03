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
// Usage: node scripts/verify-tab-per-agent.mjs [key-prefix]
//
// Run it after `npm run build`, against the live herdr. It creates and
// removes its own scratch agents and touches nothing else; agents that were
// already running are left alone, which the run also reports on.

import { execFileSync } from 'child_process';
import { rmSync } from 'fs';
import path from 'path';
import { HerdrBridge, agentNameFor, workspaceDirFor, AGENT_NAME_PREFIX } from '../dist/herdr.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';

const PREFIX = process.argv[2] ?? 'kan32-verify';
const TYPE = 'shell';
const KEYS = [`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`];
const dataDir = process.env.CRABCAST_DATA_DIR
  ? path.resolve(process.env.CRABCAST_DATA_DIR)
  : DEFAULT_DATA_DIR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function herdr(args) {
  const out = execFileSync('herdr', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

/** herdr's view of one agent: which tab it is in, and how full that tab is. */
function placementOf(key) {
  const name = agentNameFor(TYPE, key);
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
function widthOf(key) {
  const tail = bridge.tailAgent(key, TYPE, 40);
  if (!tail.success) return { error: tail.error };
  const cols = [...(tail.text ?? '').matchAll(/COLS=(\d+)/g)].map((m) => Number(m[1]));
  return { cols: cols.length ? cols[cols.length - 1] : undefined, text: tail.text ?? '' };
}

const bridge = new HerdrBridge(dataDir);

// Agents already running, so the report can show the change disturbed none of
// them. Recorded by terminal id: pane and tab ids renumber as panes come and
// go, and comparing those would produce false alarms.
const before = (herdr(['agent', 'list'])?.result?.agents ?? [])
  .filter((a) => a.name.startsWith(AGENT_NAME_PREFIX))
  .map((a) => ({ name: a.name, terminalId: a.terminal_id }));
console.log(`pre-existing crabcast agents: ${before.length}`);
for (const a of before) console.log(`  ${a.name} (${a.terminalId})`);

// A shell that reports its own width every second is enough of an agent for
// this, and far cheaper than launching a real one.
const REPORT_WIDTH = 'while true; do echo "COLS=$COLUMNS"; sleep 1; done';

try {
  console.log('\n== spawn two agents ==');
  for (const key of KEYS.slice(0, 2)) {
    bridge.spawnSession(TYPE, key, undefined, '', 'shell');
    await sleep(2500);
  }
  for (const key of KEYS.slice(0, 2)) {
    await bridge.sendToAgent(key, REPORT_WIDTH, TYPE);
  }
  await sleep(3000);

  const placed = KEYS.slice(0, 2).map(placementOf);
  for (const p of placed) console.log(`  ${p?.name}: tab=${p?.tabId} panes-in-tab=${p?.panesInTab}`);

  const distinctTabs = new Set(placed.map((p) => p?.tabId)).size === 2;
  const alone = placed.every((p) => p?.panesInTab === 1);
  console.log(`  different tabs: ${distinctTabs}`);
  console.log(`  one pane per tab: ${alone}`);

  console.log('\n== tails (this is what tail_agent returns) ==');
  const widthsBefore = {};
  for (const key of KEYS.slice(0, 2)) {
    const w = widthOf(key);
    widthsBefore[key] = w.cols;
    console.log(`  ${agentNameFor(TYPE, key)}: COLUMNS=${w.cols}`);
    console.log(
      (w.text ?? '').trimEnd().split('\n').slice(-3).map((l) => `    | ${l}`).join('\n')
    );
  }

  console.log('\n== spawn a third; the first two must not narrow ==');
  bridge.spawnSession(TYPE, KEYS[2], undefined, '', 'shell');
  await sleep(2500);
  await bridge.sendToAgent(KEYS[2], REPORT_WIDTH, TYPE);
  await sleep(3000);

  let unchanged = true;
  for (const key of KEYS.slice(0, 2)) {
    const after = widthOf(key).cols;
    const same = after === widthsBefore[key];
    unchanged &&= same;
    console.log(`  ${agentNameFor(TYPE, key)}: ${widthsBefore[key]} -> ${after} ${same ? '(unchanged)' : '(CHANGED)'}`);
  }
  console.log(`  ${placementOf(KEYS[2])?.name}: tab=${placementOf(KEYS[2])?.tabId}`);

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
  for (const key of KEYS) {
    const r = bridge.closeAgentByKey(key);
    // Closing the agent's last pane is also what closes its tab, so there is
    // no tab to tidy up separately.
    rmSync(workspaceDirFor(dataDir, TYPE, key), { recursive: true, force: true });
    console.log(`  ${key}: ${r.success ? 'closed' : r.error}`);
  }
  // The bridge still holds attach PTYs, which would keep the loop alive.
  await sleep(500);
  process.exit(process.exitCode ?? 0);
}
