// Live check of the extraction source's KAN-32 fix against a real herdr, at
// the level the bug actually lived: HerdrBridge.
//
// WHAT FAILURE THIS WOULD CATCH: an agent's usable COLUMN WIDTH coming back to
// depend on how many other agents exist. Before the fix, `herdr agent start`
// was called with no placement flags, so every agent split whatever pane was
// current and the whole fleet piled into one tab. Panes in a rendered tab are
// sized by the app's split layout, so the width each agent got was the terminal
// divided by the fleet size — at seven agents, about four columns, and a tail
// came back as "*\nChan\nnell\ning…". The property the fix buys is that an
// agent's width no longer depends on how many other agents exist.
//
// This spawns scratch agents and asserts three things:
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
//
// ---------------------------------------------------------------------------
// KAN-198: WHY THERE ARE NOW TWO CANARIES, AND WHY ASSERTION 3 CAN SAY "NOT RUN"
// ---------------------------------------------------------------------------
//
// Assertion 3 used to be `after === widthsBefore[dir]` and nothing else — two
// reads of the same instrument, with nothing anywhere establishing that those
// two reads COULD have differed. A `widthOf()` that had stopped reflecting the
// pane (a stale cache, a changed herdr response shape, a parse falling back to
// a constant) returns equal values, which is exactly the answer the passing
// case returns. The `>= 60` readability floor rules out one degenerate value;
// it does not rule out a frozen one.
//
// Measuring the machine for KAN-198 turned up something sharper than that, and
// it is the reason there are two canaries rather than one. WIDTH IS PRODUCED BY
// A TERMINAL APP LAYING OUT A RENDERED TAB. `startAgentInOwnTab` says so in
// src/herdr.ts — "the app only lays out the tab it is *rendering*. An agent
// sitting in a background tab keeps whatever size its last attach asked for" —
// and `verify-proof-registry`'s exclusion entry for this script says the same
// thing about CI. What neither said is that IT IS ALSO TRUE OF A REAL HERDR
// WITH NO APP ATTACHED. On a machine running only `herdr server` plus a few
// `herdr agent attach` clients — which is every agent-driven run, and was the
// machine this was written on — no tab is laid out by anything. Every pane
// reports whatever size its attach client asked for, which for CrabCast's own
// spawns is the constant 80 in `initPty`.
//
// On such a machine assertion 3 is not merely undefended, it is UNFALSIFIABLE:
// the two reads are the same constant, so the third spawn could not have
// narrowed anything, and THE PROOF WOULD PASS AGAINST THE PRE-FIX CODE TOO —
// piling the whole fleet into one unrendered tab does not narrow it either.
// Reporting PASS there would be this suite's own recurring defect: an artifact
// whose sentence claims more than its mechanism covers, degrading toward
// looking finished.
//
// So the two canaries answer two different questions, and they are not
// interchangeable:
//
//   §3 THE READ-PATH CANARY resizes THIS RUN's own attach PTY and requires
//      `widthOf()` to report the number it was resized to. That exercises
//      pane -> shell -> `herdr agent read` -> parse. It says nothing about
//      layout, because a client resize is not a layout.
//
//   §4 THE LAYOUT CANARY is the one KAN-198 asked for: put a second pane in the
//      SAME tab, the way the pre-fix code did to the whole fleet, and require
//      the width to DROP. That exercises the mechanism KAN-32 was actually
//      about. If it drops, assertion 3 below is a measurement. If it does not,
//      nothing on this machine is laying tabs out, and assertion 3 is reported
//      NOT RUN rather than passed.
//
// Both canaries assert a POSITIVE FINGERPRINT rather than "the number moved".
// "Different" is satisfied by an instrument that has started returning noise: a
// narrowing must produce a number that is SMALLER, still parses as a width, and
// — for the read-path canary, which knows what it asked for — is EXACTLY the
// requested width. The restore half is required too, so the number is shown to
// move in both directions rather than to have fallen over once.
//
// ---------------------------------------------------------------------------
// WHAT "NOT RUN" COSTS HERE, WHICH IS NOT THE SAME FOR THE TWO PLACES IT APPEARS
// ---------------------------------------------------------------------------
//
// KAN-194 settled that NOT RUN keeps its meaning and that what it COSTS is a
// per-file judgement about the CAUSE. The two NOT RUNs here come out
// differently, and the reason is not that one matters more. THEY ARE DIFFERENT
// EPISTEMIC STATES WEARING THE SAME WORD "VACUOUS":
//
//   §4 -> assertion 3 NOT RUN is RED, because it is UNKNOWN. The central
//        assertion — the one the KAN-32 outage was about and the only one that
//        fails on the old code — was not measured. Nothing is known about
//        whether width independence holds on this run. An unknown reported as a
//        pass is precisely the defect this suite exists to prevent. To turn it
//        green: run this from a machine with the herdr APP attached and
//        rendering, which is what a human at a terminal has and what an agent
//        over a socket does not.
//
//   §6 -> the survivor conjunct's NOT RUN is AMBER, because it is TRIVIALLY
//        TRUE. `0 === 0` on an empty fleet is not an unmeasured claim; it is a
//        true claim about an empty set. Nothing was disturbed BECAUSE THERE WAS
//        NOTHING TO DISTURB. The assertion holds — it simply carries no
//        information, and no machine state could make it informative, because
//        you cannot conjure pre-existing agents. What was illegitimate was it
//        RENDERING AS COVERAGE, folded into the same conjunction as the real
//        assertions and indistinguishable in the output from a run that had a
//        fleet to disturb and disturbed none of it.
//
// Only the first is a hole. And the CI-excluded/hand-run status is what does
// the remaining work: `verify-readme-is-current` can afford amber because CI
// RUNS IT AGAIN — its `UNDER_CI` branch makes a skip an outright failure for
// exactly that reason. Nothing runs this script again, so an amber here is a
// gap that is never revisited. AMBER IS ONLY HONEST WHERE SOMETHING WILL RETRY.
//
// ---------------------------------------------------------------------------
// THE SEAMS — where this proof stops, named because the gap between two honest
// mechanisms is where this epic keeps finding defects
// ---------------------------------------------------------------------------
//
// §4'S GREEN ARM HAS NEVER BEEN OBSERVED (KAN-211). Every run of this script so
// far has been on a headless machine, where §4 correctly reports that the layout
// is not live — so what has been demonstrated is the canary FIRING, not the
// canary CLEARING. That a rendering app makes the width drop is inferred from
// `startAgentInOwnTab`'s header and from the KAN-32 outage itself; both are good
// reasons to believe it and neither is a measurement. Closing it costs one run
// from a session with the herdr app attached, which no agent can do.
//
// A CANARY ESTABLISHES THAT THE INSTRUMENT CAN MOVE. IT DOES NOT ESTABLISH THAT
// THE WIDTH IT REPORTS IS THE WIDTH A HUMAN WOULD SEE ON THAT PANE. Both
// canaries read the same way the assertions do — a shell printing its own
// $COLUMNS, tailed back through `herdr agent read` — so a fault common to the
// forcing and the reading (herdr reporting a grid it is not drawing) moves both
// together and is invisible to both. Nothing here covers that, and nothing else
// in this suite does either. Seeing it needs a human looking at the pane.
//
// AND NEITHER CANARY SAYS ANYTHING ABOUT THE KAN-32 THRESHOLD. The outage was
// at SEVEN agents, where a tail came back as "*\nChan\nnell\ning…". This runs
// THREE. What is asserted is that width does not depend on fleet size at all,
// which is the property the fix buys and is stronger than any particular count
// — but no run of this script has ever put seven agents on a machine and looked.
//
// §7's NEGATIVE CASE SUPPLIES ITS OWN INPUT, and that is the shape KAN-145 was.
// It feeds three synthetic censuses to `survivorVerdict` and requires PASS,
// NOT RUN and FAIL respectively, which exercises the PREDICATE. It does not
// exercise the census that feeds it in a real run. What covers that half is the
// live run itself, in §6, using the real `herdr agent list` — and only for
// whichever arm this machine happens to be in. On a machine with pre-existing
// crabcast agents that is the PASS arm; the NOT RUN arm is exercised for real
// only on an empty machine and the FAIL arm only by an actual regression. So:
// the predicate is covered here, the populated arm is covered live, and the
// other two arms are covered by nobody. That is the edge of this file.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HerdrBridge } from '../dist/herdr.js';
import { paneNameFor, PANE_NAME_PREFIX } from '../dist/identity.js';
import { DEFAULT_DATA_DIR } from '../dist/config.js';

// Four directories this script owns outright. An agent IS its directory now,
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
// a, b, c are the fleet under test. `canary` is the fourth pane §4 puts into
// a's TAB — a scratch directory like the others, so it is named by
// `paneNameFor` and torn down by the same `closeAgentByPath` in the same
// `finally`, rather than being a special case that could be left behind.
const DIRS = ['a', 'b', 'c', 'canary'].map((suffix) => {
  const dir = path.join(SCRATCH, suffix);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
});
const FLEET = DIRS.slice(0, 3);
const CANARY_DIR = DIRS[3];
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

// ---------------------------------------------------------------------------
// Verdicts. Three of them, and the difference between the second and third is
// what KAN-198 was about: `skip` is a claim this run COULD NOT MEASURE and that
// costs nothing, `check(false, …)` is a claim that was measured and is wrong,
// and a NOT RUN whose cause is red goes through `check` on purpose so it is
// counted rather than announced. Every one of the three is NAMED in the output;
// none of them is folded into a neighbouring pass.
// ---------------------------------------------------------------------------
let failures = 0;
const skipped = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}     ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
/** Amber: named, not counted. For a claim whose cause is a benign machine state. */
const skip = (label, detail = '') => {
  console.log(`  [NOT RUN] ${label}${detail ? ` — ${detail}` : ''}`);
  skipped.push(label);
  return false;
};
/** Red: named AND counted. For a claim this proof exists to make. */
const notRunRed = (label, detail = '') => check(false, `NOT RUN — ${label}`, detail);

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
    workspaceId: agent.workspace_id,
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

/**
 * Does a number read off a pane look like a width at all?
 *
 * THE POINT OF THE FLOOR IS THE FINGERPRINT, NOT THE THRESHOLD. A canary that
 * required only "the number changed" is satisfied by an instrument that has
 * started returning noise, or `undefined`, or 0 — every one of which is
 * "different from before" and none of which is a measurement. So a narrowing
 * has to land on something that is still a plausible terminal width.
 */
const parsesAsWidth = (c) => Number.isInteger(c) && c >= 8 && c <= 1000;

/**
 * The "we disturbed nobody" claim, as a predicate with three answers rather
 * than a conjunct with two.
 *
 * `survivors.length === before.length` is `0 === 0` on a machine with no
 * pre-existing crabcast agents. That is not wrong, and it is not coverage
 * either — the run where the claim MEANS something is the one with a live fleet
 * on the machine, and that is the run nobody does deliberately. Separated out
 * so §7 can put all three answers through it in one run.
 */
function survivorVerdict(before, after) {
  if (before.length === 0) {
    return {
      verdict: 'not-run',
      survivors: [],
      why:
        'there were no pre-existing crabcast agents to disturb, so "we disturbed nobody" is ' +
        'satisfied by there being nobody. Vacuous on this machine, and reported rather than ' +
        'folded into the pass'
    };
  }
  const survivors = before.filter((a) => after.some((b) => b.terminal_id === a.terminalId));
  return survivors.length === before.length
    ? { verdict: 'pass', survivors, why: `all ${before.length} still present` }
    : {
        verdict: 'fail',
        survivors,
        why:
          `${before.length - survivors.length} of ${before.length} pre-existing agent(s) are gone: ` +
          before
            .filter((a) => !survivors.some((s) => s.terminalId === a.terminalId))
            .map((a) => `${a.name} (${a.terminalId})`)
            .join(', ')
      };
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
// this, and far cheaper than launching a real one. The loop is what makes both
// canaries readable: a resize or a reflow raises SIGWINCH, and the next tick
// prints the new grid.
const REPORT_WIDTH = 'while true; do echo "COLS=$COLUMNS"; sleep 1; done';

/**
 * The width §3 resizes to. Distinctive on purpose: a canary that asked for 40
 * and read back 40 has not ruled out a coincidence nearly as well as one that
 * asked for 37. Comfortably under the `>= 60` readability floor too, so the
 * narrowing is unmistakably a narrowing.
 */
const CANARY_COLS = 37;

const sessions = new Map();
let threw = null;
try {
  console.log('\n== spawn two agents ==');
  for (const dir of FLEET.slice(0, 2)) {
    sessions.set(dir, bridge.spawnSession(dir, CONFIG));
    await sleep(2500);
  }
  for (const dir of FLEET.slice(0, 2)) {
    await bridge.sendToAgent(dir, REPORT_WIDTH);
  }
  await sleep(3000);

  console.log('\n== 1. placement ==');
  const placed = FLEET.slice(0, 2).map(placementOf);
  for (const p of placed) console.log(`  ${p?.name}: tab=${p?.tabId} panes-in-tab=${p?.panesInTab}`);

  check(new Set(placed.map((p) => p?.tabId)).size === 2,
    'the two agents are in DIFFERENT tabs',
    `tabs: ${placed.map((p) => p?.tabId).join(', ')}`);
  check(placed.every((p) => p?.panesInTab === 1),
    'each is ALONE in its tab',
    `pane counts: ${placed.map((p) => p?.panesInTab).join(', ')}`);

  // =========================================================================
  console.log('\n== 2. readability ==');
  // =========================================================================
  const widthsBefore = {};
  for (const dir of FLEET.slice(0, 2)) {
    const w = widthOf(dir);
    widthsBefore[dir] = w.cols;
    console.log(`  ${paneNameFor(dir)}: COLUMNS=${w.cols}`);
    console.log(
      (w.text ?? '').trimEnd().split('\n').slice(-3).map((l) => `    | ${l}`).join('\n')
    );
  }
  check(Object.values(widthsBefore).every((c) => c && c >= 60),
    'each tails at a readable width (>= 60 columns)',
    `widths: ${Object.values(widthsBefore).join(', ')}`);

  // =========================================================================
  console.log('\n== 3. THE READ-PATH CANARY — the number this run reads can move ==');
  // =========================================================================
  // Resize THIS RUN's own attach PTY and require the read to follow it. What
  // this establishes is pane -> shell -> `herdr agent read` -> parse: the
  // reading half of the instrument is live rather than returning a cached or
  // constant number. What it does NOT establish is anything about LAYOUT — a
  // client resize is not a tab being laid out — which is why §4 exists.
  //
  // NOT REQUIRED ON ITS OWN, and that is deliberate rather than a softening.
  // On a machine where an app IS rendering these tabs, the app owns the pane
  // geometry and may simply refuse or immediately undo a client's resize; a
  // hard requirement here would go red on exactly the machine where this proof
  // is at its most valid. What IS required is the disjunction at the end of §4:
  // at least one of the two deliberate changes must have moved the number, or
  // every width in this run is unfalsifiable and the whole thing is a FAIL.
  const canarySubject = FLEET[0];
  const nativeWidth = widthOf(canarySubject).cols;
  let readPathMoved = false;
  const pty = sessions.get(canarySubject)?.ptyProcess;
  if (!pty || typeof pty.resize !== 'function') {
    skip('the read-path canary needs this run\'s own attach PTY, and there is none to resize',
      `session for ${paneNameFor(canarySubject)} has no resizable pty`);
  } else if (!parsesAsWidth(nativeWidth)) {
    // THE PRECONDITION, and it is not pedantry: the restore step is
    // `pty.resize(nativeWidth, 24)`, so an unreadable starting width would be
    // handed to node-pty as `undefined` and throw out of the canary — killing
    // the run before §4, §5 and the verdict, which is the shape mutation.mjs
    // exists to prevent ("a failed mutation is a counted verdict, never a
    // throw"). Named and counted instead, and §4 then carries the disjunction.
    skip('the read-path canary needs a readable starting width to resize away from and back to',
      `${paneNameFor(canarySubject)} read ${JSON.stringify(nativeWidth)}, which does not parse as a width`);
  } else {
    console.log(`  resizing this run's attach on ${paneNameFor(canarySubject)}: ${nativeWidth} -> ${CANARY_COLS}`);
    pty.resize(CANARY_COLS, 24);
    await sleep(4000);
    const narrowed = widthOf(canarySubject).cols;
    console.log(`  reads back: ${narrowed}`);

    // The positive fingerprint, all three parts. Smaller, EXACTLY what was
    // asked for, and still a plausible width — "different" would have been
    // satisfied by noise.
    const narrowedOk =
      parsesAsWidth(narrowed) && narrowed === CANARY_COLS && narrowed < nativeWidth;

    console.log(`  restoring: ${CANARY_COLS} -> ${nativeWidth}`);
    pty.resize(nativeWidth, 24);
    await sleep(4000);
    const restored = widthOf(canarySubject).cols;
    console.log(`  reads back: ${restored}`);
    const restoredOk = restored === nativeWidth;

    readPathMoved = narrowedOk && restoredOk;
    if (readPathMoved) {
      check(true,
        `CANARY: the width read off ${paneNameFor(canarySubject)} FOLLOWED a deliberate resize ` +
        `both ways (${nativeWidth} -> ${CANARY_COLS} -> ${restored})`,
        'so the reading half of the instrument is live, not a cached or constant number');
    } else {
      console.log(
        `  [diagnostic] the read did not follow the resize ` +
        `(asked ${CANARY_COLS}, read ${narrowed}; asked ${nativeWidth} back, read ${restored}). ` +
        `Not a failure on its own — something else may own this pane's geometry — but §4's ` +
        `disjunction now rests entirely on the layout canary.`
      );
    }

    // Whatever happened, the assertions below must run against the width the
    // agent actually has now. A canary that left the subject narrowed would
    // have broken the thing it exists to make trustworthy.
    const settled = widthOf(canarySubject).cols;
    widthsBefore[canarySubject] = settled;
    if (settled !== nativeWidth) {
      console.log(`  note: ${paneNameFor(canarySubject)} settled at ${settled}, not ${nativeWidth}; assertions below use ${settled}`);
    }
  }

  // =========================================================================
  console.log('\n== 4. THE LAYOUT CANARY — a second pane in the SAME tab must narrow it ==');
  // =========================================================================
  // This is the canary KAN-198 asked for, and it is the one that decides
  // whether assertion 3 below is a measurement. It reproduces the pre-fix
  // placement in miniature: a second pane in an agent's own tab, which is what
  // `herdr agent start` with no placement flags did to the whole fleet. If the
  // width drops, this machine lays tabs out and the KAN-32 property is
  // observable here. If it does not, nothing is laying tabs out — every pane is
  // just reporting its attach client's size — and a third spawn could not have
  // narrowed anything either.
  let layoutLive = false;
  // THE MODE LINE. Which of the two machines this run was on, recorded in the
  // output on every run — PASS, FAIL or NOT RUN alike — because the defect
  // KAN-198 found was never that the proof was WRONG. It was that this proof
  // has been valid exactly when a human ran it and vacuous exactly when an
  // agent did, AND NOTHING IN ITS OUTPUT SAID WHICH. A verdict alone still does
  // not say: a green run on a machine with no layout looks identical to a green
  // run that measured something. UNKNOWN is a first-class value here for the
  // same reason it is everywhere else in this project — it never renders as
  // clean.
  let layoutMode = 'UNKNOWN (the narrowing was never attempted)';
  const subjectPlacement = placementOf(canarySubject);
  const wideBeforeSplit = widthOf(canarySubject).cols;
  const canaryName = paneNameFor(CANARY_DIR);

  if (!subjectPlacement?.tabId) {
    // Counted, not thrown, and not silently folded into the layout verdict:
    // "we could not find the tab" is a different fact from "the tab did not
    // narrow", and reading the first as the second is the whole defect class.
    layoutMode = `UNKNOWN (no placement for ${paneNameFor(canarySubject)}, so the narrowing could not be performed)`;
    notRunRed('the layout canary could not locate the subject\'s tab',
      `no placement for ${paneNameFor(canarySubject)}`);
  } else {
    let started = false;
    try {
      herdr([
        'agent', 'start', canaryName,
        '--cwd', CANARY_DIR,
        '--tab', subjectPlacement.tabId,
        '--split', 'right',
        '--no-focus',
        '--', 'bash', '-lc', REPORT_WIDTH
      ]);
      started = true;
    } catch (e) {
      // Same rule as above: an unperformed narrowing is NOT a narrowing that
      // did not happen. It is counted and named, and §4's disjunction then
      // rests on §3.
      layoutMode = `UNKNOWN (herdr refused the second pane, so the narrowing could not be performed: ${e?.message ?? e})`;
      notRunRed('the layout canary could not put a second pane in the tab',
        `herdr agent start --tab ${subjectPlacement.tabId} failed: ${e?.message ?? e}`);
    }

    if (started) {
      await sleep(5000);
      const after = placementOf(canarySubject);
      const narrowed = widthOf(canarySubject).cols;
      console.log(`  ${paneNameFor(canarySubject)}: panes-in-tab ${subjectPlacement.panesInTab} -> ${after?.panesInTab}`);
      console.log(`  ${paneNameFor(canarySubject)}: COLUMNS ${wideBeforeSplit} -> ${narrowed}`);

      // The precondition for reading anything from this at all: the split must
      // actually have happened. A canary whose setup silently did nothing
      // reports "did not narrow" in the same words as a machine that does not
      // lay out tabs.
      const splitHappened = check(after?.panesInTab === 2,
        'the canary pane really is in the subject\'s tab (the narrowing was performed)',
        `pane_count is ${after?.panesInTab}`);

      if (!splitHappened) {
        layoutMode =
          `UNKNOWN (the tab reports ${after?.panesInTab} pane(s), so the narrowing this reads ` +
          `from did not happen)`;
      } else {
        // Positive fingerprint again: SMALLER, and still a plausible width.
        layoutLive = parsesAsWidth(narrowed) && parsesAsWidth(wideBeforeSplit) && narrowed < wideBeforeSplit;
        if (layoutLive) {
          layoutMode = `LIVE (same-tab narrowing ${wideBeforeSplit} -> ${narrowed})`;
          check(true,
            `CANARY: sharing a tab NARROWED ${paneNameFor(canarySubject)} ` +
            `${wideBeforeSplit} -> ${narrowed}`,
            'so this machine lays tabs out, and assertion 3 below is a measurement rather than a coincidence');
        } else {
          layoutMode =
            `NONE (no rendering client; sharing a tab did not narrow ${wideBeforeSplit} -> ` +
            `${narrowed}, so widths are the attach PTY's own ${wideBeforeSplit})`;
          console.log(
            `  [diagnostic] width did not drop when a second pane joined the tab ` +
            `(${wideBeforeSplit} -> ${narrowed}).`
          );
        }
      }

      // Put the tab back to one pane before anything else is measured.
      const closed = bridge.closeAgentByPath(CANARY_DIR);
      await sleep(4000);
      const reflowed = widthOf(canarySubject).cols;
      console.log(`  canary pane closed (${closed.success ? 'ok' : closed.error}); COLUMNS ${narrowed} -> ${reflowed}`);
      if (layoutLive) {
        check(reflowed === wideBeforeSplit,
          'and the width came BACK when the canary pane closed',
          `${wideBeforeSplit} -> ${narrowed} -> ${reflowed}`);
      }
      widthsBefore[canarySubject] = reflowed;
    }
  }

  console.log(`\n  layout: ${layoutMode}`);

  // The disjunction. Either deliberate change is enough to establish that the
  // number this run reads is capable of moving; NEITHER moving means every
  // width printed above is a value nothing could have made different, and no
  // assertion resting on one is worth anything.
  check(readPathMoved || layoutLive,
    'at least one deliberate change MOVED the width this run reads',
    readPathMoved || layoutLive
      ? `read-path canary: ${readPathMoved ? 'moved' : 'did not move'}; layout canary: ${layoutLive ? 'moved' : 'did not move'}`
      : 'neither the attach resize nor the shared tab changed the number — every width above is ' +
        'unfalsifiable, so nothing measured in this run can be trusted');

  // =========================================================================
  console.log('\n== 5. independence — spawn a third; the first two must not narrow ==');
  // =========================================================================
  sessions.set(FLEET[2], bridge.spawnSession(FLEET[2], CONFIG));
  await sleep(2500);
  await bridge.sendToAgent(FLEET[2], REPORT_WIDTH);
  await sleep(3000);

  let unchanged = true;
  for (const dir of FLEET.slice(0, 2)) {
    const after = widthOf(dir).cols;
    const same = after === widthsBefore[dir];
    unchanged &&= same;
    console.log(`  ${paneNameFor(dir)}: ${widthsBefore[dir]} -> ${after} ${same ? '(unchanged)' : '(CHANGED)'}`);
  }
  console.log(`  ${placementOf(FLEET[2])?.name}: tab=${placementOf(FLEET[2])?.tabId}`);

  if (layoutLive) {
    check(unchanged,
      'a third agent did NOT narrow the first two — width does not depend on fleet size',
      'this is the assertion that fails on the pre-KAN-32 code');
  } else {
    // The central assertion, and this run could not measure it. RED: see the
    // header. The numbers are printed above either way, and they agree — but
    // they agree the way two reads of a constant agree.
    notRunRed(
      'a third agent did NOT narrow the first two (the KAN-32 property, and this proof\'s subject)',
      `§4's layout canary showed this machine does not lay tabs out, so the widths above could ` +
      `not have differed and "unchanged" (${unchanged}) is true by construction rather than by ` +
      `measurement. On a machine like this the pre-fix code would pass this assertion too. Run ` +
      `this from a session with the herdr APP attached and rendering to measure it`);
  }

  // =========================================================================
  console.log('\n== 6. pre-existing agents were not disturbed ==');
  // =========================================================================
  const afterList = herdr(['agent', 'list'])?.result?.agents ?? [];
  const survived = survivorVerdict(before, afterList);
  console.log(`  still present: ${survived.survivors.length}/${before.length}`);

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

  if (survived.verdict === 'pass') check(true, 'every pre-existing crabcast agent survived this run', survived.why);
  else if (survived.verdict === 'fail') check(false, 'every pre-existing crabcast agent survived this run', survived.why);
  else skip('every pre-existing crabcast agent survived this run', survived.why);

  // =========================================================================
  console.log('\n== 7. NEGATIVE CASE — the survivor predicate returns all three answers ==');
  // =========================================================================
  // §6 exercises whichever arm this machine happens to be in, and it is one arm
  // per run. This puts all three through the same predicate in the same run, so
  // "NOT RUN" is shown to be a verdict the code can actually reach rather than
  // a branch nobody has executed. It SUPPLIES ITS OWN INPUT — see the header's
  // seam note; what it covers is the predicate, not the census.
  const fleetOf = (...ids) => ids.map((t) => ({ name: `crabcast-fixture-${t}`, terminalId: t }));
  const censusOf = (...ids) => ids.map((t) => ({ terminal_id: t }));
  const cases = [
    { want: 'pass', label: 'a populated fleet that all survived', before: fleetOf('t1', 't2'), after: censusOf('t1', 't2', 'tX') },
    { want: 'not-run', label: 'an EMPTY fleet is NOT RUN, not a pass', before: fleetOf(), after: censusOf('tX') },
    { want: 'fail', label: 'a populated fleet with one lost is a FAIL', before: fleetOf('t1', 't2'), after: censusOf('t2', 'tX') }
  ];
  for (const c of cases) {
    const got = survivorVerdict(c.before, c.after).verdict;
    check(got === c.want, c.label, `survivorVerdict -> ${got}`);
  }

  // THE MODE GOES IN THE PASSING OUTPUT TOO, and that is the point rather than
  // a detail. A green run on a machine with no layout is exactly what this
  // proof has been producing for its whole life; a verdict line cannot tell it
  // apart from a green run that measured something, and only this can.
  console.log(`\nlayout: ${layoutMode}`);
  console.log(
    `RESULT: ${failures === 0 ? 'PASS' : 'FAIL'}` +
    (skipped.length ? ` (with ${skipped.length} NOT RUN, listed below)` : '')
  );
  if (!layoutLive) {
    console.log(
      '  and the KAN-32 property — the thing this proof is FOR — was not measured on this run. ' +
      'See §5.'
    );
  }
  for (const s of skipped) console.log(`  NOT RUN, AND SO CHECKED BY NOTHING THIS RUN: ${s}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  threw = e;
  console.error(`\nRESULT: FAIL — the run threw before reaching its verdict: ${e?.stack ?? e}`);
} finally {
  console.log('\n== cleanup ==');
  // CANARY_DIR is in DIRS, so the fourth pane §4 may have started is closed by
  // the same loop as the rest even if §4 threw between starting it and closing
  // it. Idempotent: closing an agent that is already closed reports it and
  // moves on.
  for (const dir of DIRS) {
    const r = bridge.closeAgentByPath(dir);
    // Closing the agent's last pane is also what closes its tab, so there is
    // no tab to tidy up separately.
    console.log(`  ${dir}: ${r.success ? 'closed' : r.error}`);
  }
  // The census this run is judged by, printed rather than assumed. A run that
  // leaves more crabcast panes than it found has a teardown defect, and that is
  // the `catch {}` shape that hid 433 orphaned daemons in KAN-191.
  const left = (herdr(['agent', 'list'])?.result?.agents ?? [])
    .filter((a) => a.name.startsWith(PANE_NAME_PREFIX));
  console.log(`  crabcast panes: ${before.length} before, ${left.length} after`);
  if (left.length > before.length) {
    console.log(`  LEFT BEHIND: ${left.map((a) => a.name).filter((n) => !before.some((b) => b.name === n)).join(', ')}`);
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
