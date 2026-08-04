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
// Usage: node scripts/verify-tab-per-agent.mjs
//
// It takes NO arguments. See the SCRATCH note below.
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
//
// THE ROOT IS NOT AN ARGUMENT, and that is a deliberate removal.
//
// An earlier revision accepted `process.argv[2]` as the scratch root and then
// `rm -rf`'d it in the `finally` block. The operand it replaced was a key
// PREFIX, so on the old code cleanup only ever removed CrabCast's own
// subtrees; re-keying it onto a directory turned the same line into "delete
// whatever you were handed". This project's hardest rule is that it never
// deletes a directory it did not create — `configure` refuses to `mkdir` for
// exactly that reason — and a script in its own suite that recursively deletes
// its argument is that rule broken one layer out, on the machine of whoever
// runs the proof.
//
// So the root is minted here and nowhere else. There is nothing to pass, and
// therefore nothing to pass by mistake.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kan32-verify-'));
if (process.argv[2]) {
  console.error(
    `refusing to run: this script takes no arguments, and it used to take a scratch root ` +
    `that it then deleted recursively. Got ${JSON.stringify(process.argv[2])}. It makes ` +
    `its own scratch directory under ${os.tmpdir()} and removes only that.`
  );
  process.exit(2);
}
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

let threw = null;
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
} catch (e) {
  threw = e;
  console.error(`\nRESULT: FAIL — the run threw before reaching its verdict: ${e?.stack ?? e}`);
} finally {
  console.log('\n== cleanup ==');
  for (const dir of DIRS) {
    const r = bridge.closeAgentByPath(dir);
    // Closing the agent's last pane is also what closes its tab, so there is
    // no tab to tidy up separately.
    console.log(`  ${dir}: ${r.success ? 'closed' : r.error}`);
  }
  // The scratch directory is THIS SCRIPT's — it minted it two lines into the
  // run and nothing else can name it, so removing it recursively can only
  // remove what this run created. CrabCast neither made nor may delete these,
  // which is the point of `configure` refusing a path that does not exist.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  // The bridge still holds attach PTYs, which would keep the loop alive.
  await sleep(500);
  // `process.exitCode ?? 0` in a `finally` exits 0 when the `try` THREW —
  // a thrown error never reaches the RESULT line above, so `exitCode` is
  // still unset and the script reports success for a run that crashed. That
  // is a false PASS in a proof, which is the one thing a proof may not do.
  // `threw` is set by the catch below, so a crash exits non-zero and says so.
  process.exit(threw ? 1 : (process.exitCode ?? 0));
}
