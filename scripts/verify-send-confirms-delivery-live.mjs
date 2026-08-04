#!/usr/bin/env node
// KAN-114 — the live half: the same delivery check against a REAL Claude Code
// pane, read through a REAL herdr.
//
// WHAT FAILURE THIS WOULD CATCH, and there are two:
//
//   1. `COMPOSER_MARKERS` naming a caret that a real Claude Code pane does not
//      draw. That is the load-bearing assumption of the whole mechanism —
//      everything else in `src/delivery.ts` is arithmetic over where that
//      marker is — and it is the one assumption a shimmed pane CANNOT test,
//      because a shim renders the marker it is then checked against. If the
//      list is wrong, `verify-send-confirms-delivery.mjs` still passes every
//      section and every send in production reports the wrong verdict.
//
//   2. CONFIRMATION THAT STOPS WORKING WHEN THE RECIPIENT IS BUSY — which is
//      the only state `send_to_agent` exists for. A suite whose every send goes
//      to an agent at an empty composer would keep passing while the contended
//      case rotted, which is the shape KAN-138 collects. §1b drives all three
//      recipient states: idle, mid-task, and blocked in a shell command. The
//      third had never been tested anywhere.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE, AND WHAT IS INDUCED. Read both lists.
// ---------------------------------------------------------------------------
//
//   REAL — the herdr server and its `agent list` / `agent read` / `pane
//   send-*` commands; the terminal pane; Claude Code itself, drawing its own
//   transcript, its own wrapping, its own input box. Nothing in this file
//   writes a line of pane text. Section 0 reads the composer marker off a pane
//   this script did not compose, which is the fact the CI script cannot
//   establish.
//
//   INDUCED — two events, through a passthrough wrapper (`herdr-lossy`) that
//   forwards every command to the real herdr unchanged except:
//     * it can swallow N `pane send-keys … Enter`, which is the witnessed
//       failure — the keystroke is dispatched, herdr answers success, and the
//       text stays in the composer. A transient loss cannot be waited for
//       deterministically, so it is induced; the STATE it produces is the real
//       one, drawn by Claude Code.
//     * it can make `agent read` fail, standing in for a herdr that has
//       stopped answering.
//   Everything the daemon then observes about those events is a real read of a
//   real pane.
//
// COSTS ONE CLAUDE AGENT for the length of the run, in a scratch directory,
// closed at the end. It is in the live half of this suite (registered in
// verify-proof-registry.mjs's EXCLUSIONS): no GitHub runner has herdr or
// terminal panes, so this is run by hand and its output goes on the PR.
//
// Usage:
//   npm run build
//   node scripts/verify-send-confirms-delivery-live.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.resolve(scriptDir, '../dist');

let failures = 0;
let checks = 0;
function check(ok, name, detail) {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function showPane(label, text) {
  console.log(`   ${label}`);
  if (typeof text !== 'string') {
    console.log('     (no tail — the pane could not be read)');
    return;
  }
  console.log('     ┌────────────────────────────────────────────────────────');
  for (const line of text.split('\n')) console.log(`     │ ${line}`);
  console.log('     └────────────────────────────────────────────────────────');
}
function showVerdict(label, r) {
  console.log(
    `   ${label.padEnd(24)} verdict=${String(r.verdict).padEnd(14)} ` +
    `delivered=${String(r.delivered).padEnd(6)} success=${String(r.success).padEnd(6)} ` +
    `interrupts=${r.interrupts} submits=${r.submits} retried=${r.retried} ` +
    `inComposer=${r.evidence?.inComposer} landed=${r.evidence?.landedBefore}→${r.evidence?.landedAfter} ` +
    `readable=${r.evidence?.readable}`
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------- the real herdr --

const realHerdr = spawnSync('bash', ['-lc', 'command -v herdr'], { encoding: 'utf8' })
  .stdout.trim();
if (!realHerdr) {
  console.error(
    'No herdr on PATH. This is the LIVE half of the delivery proof and it needs a real herdr ' +
    'server and real terminal panes. Run scripts/verify-send-confirms-delivery.mjs for the ' +
    'part that runs anywhere.'
  );
  process.exit(1);
}
console.log(`   real herdr: ${realHerdr}`);
console.log(`   ${spawnSync(realHerdr, ['--version'], { encoding: 'utf8' }).stdout.trim()}`);

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan114-live-'));
const wrapState = path.join(scratchRoot, 'wrap');
const wrapDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(wrapState, { recursive: true });
fs.mkdirSync(wrapDir, { recursive: true });

// A PASSTHROUGH, not a fake. Every argv is forwarded to the real binary and
// its stdout, stderr and exit code are handed back untouched — except for the
// two events named in the header, which are what we cannot wait for.
fs.writeFileSync(path.join(wrapDir, 'herdr'), `#!/bin/bash
state="${wrapState}"
printf '%s\\n' "$*" >> "$state/invocations.log"

if [ "$1" = "pane" ] && [ "$2" = "send-keys" ] && [ "$4" = "Enter" ]; then
  left=$(cat "$state/drop-enters" 2>/dev/null || echo 0)
  if [ "$left" -gt 0 ]; then
    echo $((left - 1)) > "$state/drop-enters"
    echo '{"result":{}}'          # herdr's own success shape: dispatched, and lost
    exit 0
  fi
fi

if [ "$1" = "agent" ] && [ "$2" = "read" ] && [ -f "$state/unreadable" ]; then
  echo '{"error":{"code":"herdr_unreachable","message":"could not connect to the herdr server"}}' >&2
  exit 1
fi

exec "${realHerdr}" "$@"
`);
fs.chmodSync(path.join(wrapDir, 'herdr'), 0o755);
fs.writeFileSync(path.join(wrapState, 'drop-enters'), '0');
process.env.PATH = `${wrapDir}:${process.env.PATH}`;

const dropEnters = (n) => fs.writeFileSync(path.join(wrapState, 'drop-enters'), String(n));
const setUnreadable = (on) => {
  const f = path.join(wrapState, 'unreadable');
  if (on) fs.writeFileSync(f, '1');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
};
const invocations = () => {
  const f = path.join(wrapState, 'invocations.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
const keysSince = (mark) =>
  invocations().slice(mark).filter((l) => l.startsWith('pane send-keys '));

// ------------------------------------------------------- one real agent --

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { COMPOSER_MARKERS, landedCount, messageInComposer, deliveryFingerprint } =
  await import(path.join(distDir, 'delivery.js'));

/** The same flattening the shipped code does, for assertions about real output. */
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan114-live-agent-'));
const AGENT_PATH = fs.realpathSync(agentDir);
const AGENT_NAME = paneNameFor(AGENT_PATH);
const dataDir = path.join(scratchRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scratchRoot, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const bridge = new HerdrBridge(dataDir, configPath);

function closeAgent() {
  try {
    const got = JSON.parse(
      spawnSync(realHerdr, ['agent', 'get', AGENT_NAME], { encoding: 'utf8' }).stdout || '{}'
    );
    const paneId = got?.result?.agent?.pane_id;
    if (paneId) spawnSync(realHerdr, ['pane', 'close', paneId], { encoding: 'utf8' });
  } catch { /* best effort */ }
}
// ON SIGNALS TOO, AND THIS IS A LEAK I CAUSED RATHER THAN A PRECAUTION.
// `exit` does not fire for SIGINT or SIGTERM, so a run somebody Ctrl-Cs — which
// is the ordinary way to stop a hand-run proof, and which happened to this one
// — leaves a REAL CLAUDE CODE AGENT running in a scratch directory, costing
// tokens and holding a slot with nobody watching it. Measured rather than
// assumed: `herdr agent list` still held a `crabcast-kan114-live-agent-…` pane
// from an interrupted run. Re-raising after cleanup preserves the exit status
// so the shell still sees an interrupted run as interrupted.
process.on('exit', closeAgent);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    closeAgent();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// THROUGH THE REAL SPAWN PATH, and the first version of this script did not,
// which cost it two whole sections. Starting the agent with a bare `herdr
// agent start` skips two things `HerdrBridge.spawnSession` does and the
// difference is not cosmetic:
//
//   * TAB PER AGENT. With no tab the agent splits whatever pane is current, and
//     on a busy board that was NINETEEN COLUMNS wide — Claude Code hard-wrapped
//     every message into four-word fragments and the pane was unreadable to a
//     human, never mind to a check.
//   * FOLDER PRE-TRUST. Without the `~/.claude.json` entry the launcher writes,
//     Claude Code opens on "Is this a project you trust?" — a MODAL whose menu
//     row is itself drawn with `❯`. So the readiness probe matched a caret that
//     was not a composer, and the section that types into the composer typed
//     into a dialog.
//
// The second one is the more interesting miss, and it is this ticket's own
// subject one level up: a marker check that matched the right glyph in the
// wrong place, and looked like it was working.
console.log(`\n   starting ONE real Claude Code agent through the REAL spawn path: ${AGENT_NAME}`);
console.log(`   in ${AGENT_PATH}`);
const session = bridge.spawnSession(AGENT_PATH, {
  priority: 5,
  refusable: false,
  chargeable: false,
  preemptable: false,
  launcher: 'claude'
});
console.log(`   session ${session.sessionId}`);

// Wait for Claude Code to draw its INPUT BOX specifically. `bypass permissions`
// is the footer of a live composer and appears nowhere else, so unlike a bare
// caret it cannot be satisfied by a modal.
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(2000);
  const t = bridge.tailAgent(AGENT_PATH, 60);
  ready = t.success && typeof t.text === 'string' &&
    t.text.toLowerCase().includes('bypass permissions');
}
if (!ready) {
  console.error('   the agent never reached a Claude Code composer; nothing below would mean anything.');
  console.error(bridge.tailAgent(AGENT_PATH, 40).text ?? '(unreadable)');
  process.exit(1);
}
console.log('   the agent reached its composer.\n');

const FAST = { confirmTimeoutMs: 25_000, pollMs: 1_000 };
const send = (message) => bridge.sendToAgent(AGENT_PATH, message, FAST);

// ===========================================================================
rule('0. THE MARKER IS REAL — the composer caret is read off a pane Claude Code drew');
// ===========================================================================
//
// THIS IS THE SECTION THE SHIMMED PROOF CANNOT HAVE. It puts text into the
// real input box WITHOUT submitting it — the exact witnessed state — and asks
// the shipped predicates about a pane nobody here wrote.

{
  const marker = 'kan114-live-marker-probe';
  const paneId = JSON.parse(
    spawnSync(realHerdr, ['agent', 'get', AGENT_NAME], { encoding: 'utf8' }).stdout
  ).result.agent.pane_id;
  spawnSync(realHerdr, ['pane', 'send-text', paneId, marker], { encoding: 'utf8' });
  await sleep(2500);

  const tail = bridge.tailAgent(AGENT_PATH, 60);
  showPane('a real Claude Code pane with text sitting UNSUBMITTED in its composer:', tail.text);

  check(tail.success && typeof tail.text === 'string',
    'herdr read the real pane', tail.error);
  check(COMPOSER_MARKERS.some((m) => tail.text.includes(m)),
    'a COMPOSER_MARKERS entry IS present in a real Claude Code pane — the assumption the ' +
    'whole mechanism rests on, checked against a pane this script did not compose',
    `looked for ${JSON.stringify(COMPOSER_MARKERS)}`);
  check(flat(tail.text).includes(deliveryFingerprint(marker)),
    'the unsent text is in the buffer — which is why a substring check reports it as delivered');
  check(messageInComposer(tail.text, marker) === true,
    'and messageInComposer places it IN THE COMPOSER, on real terminal output');
  check(landedCount(tail.text, marker) === 0,
    'while landedCount counts it as NOT submitted — the positional split works on a real pane',
    `landedCount=${landedCount(tail.text, marker)}`);

  // Leave the box empty for the sections below.
  spawnSync(realHerdr, ['pane', 'send-keys', paneId, 'C-c'], { encoding: 'utf8' });
  await sleep(1500);
}

// ===========================================================================
rule('1. A CONFIRMED DELIVERY against a real agent');
// ===========================================================================

let deliveredResult;
{
  dropEnters(0);
  setUnreadable(false);
  const message = 'live section one: reply with the single word ACK and nothing else';
  const mark = invocations().length;
  const r = await send(message);
  deliveredResult = r;
  showVerdict('delivered:', r);
  showPane('the REAL pane the verdict was read from:', r.evidence.tail);

  check(r.verdict === 'delivered' && r.success === true,
    'a real send to a real Claude Code agent is confirmed DELIVERED',
    JSON.stringify({ ...r.evidence, tail: undefined }));
  check(r.evidence.landedAfter > r.evidence.landedBefore,
    'and the verdict is a measurement off the real transcript, not the absence of an exception',
    `${r.evidence.landedBefore}→${r.evidence.landedAfter}`);
  check(keysSince(mark).filter((l) => l.endsWith(' C-c')).length === 1,
    'exactly one Ctrl+C', JSON.stringify(keysSince(mark)));
}

// ===========================================================================
rule('1b. A CONTENDED RECIPIENT — the condition this ticket is actually about');
// ===========================================================================
//
// ROUND 2, ITEM 2. Every other send in both proofs goes to an agent sitting at
// an empty composer — an agent that would have been idle anyway. But
// `send_to_agent` exists to give NEW INSTRUCTIONS TO A STILL-RUNNING AGENT, so
// a suite whose every send addresses an idle one has not exercised the case the
// feature is for. That is the shape KAN-138 collects: a check that stops
// measuring under the conditions it exists for.
//
// THREE RECIPIENT STATES, and §1 above is the first of them:
//
//   idle              at an empty composer                        (§1)
//   mid-task          generating, no tool call outstanding        (1b-i)
//   blocked in a long shell command                               (1b-ii)
//
// The third is the one the epic reports hitting most in practice and it had
// never been tested. It is also where the COST is measurable: the send's first
// keystroke is a Ctrl+C, and here that stops being an abstract caveat and
// becomes a line of pane text.
//
// The shell command is deliberately SHORT. A contended recipient is contended
// whether it has 25 seconds of work left or 120 — a confirmed send answers in
// about a second either way — so the fixture buys nothing by being slow.

/**
 * Wait until the pane satisfies `ready`, or give up and show why.
 *
 * TWO DIFFERENT PREDICATES, AND CONFLATING THEM COST THIS SECTION A ROUND.
 * The first version waited on `esc to interrupt` for BOTH states. That marker
 * proves a turn is in flight and nothing more — so the "blocked in a shell
 * command" precondition passed while the agent was merely generating, no
 * `sleep` was ever running, and the assertion about terminating a tool call
 * went red having had no tool call to terminate. It is the same error as the
 * trust-modal `❯` one section up: the right glyph, read in the wrong state.
 */
async function waitForPane(what, ready, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = bridge.tailAgent(AGENT_PATH, 60);
    if (t.success && typeof t.text === 'string' && ready(t.text)) return true;
    if (Date.now() >= deadline) {
      console.log(`   never reached the state (${what}); last pane:`);
      showPane('', t.text);
      return false;
    }
    await sleep(1500);
  }
}

/** A turn is in flight. Drawn only while Claude Code is working. */
const turnInFlight = (text) => /esc to interrupt/i.test(text);

/**
 * A SHELL COMMAND IS ACTUALLY RUNNING, which is a different claim.
 *
 * Matched on the tool-invocation echo — Claude Code renders an executing Bash
 * call as `⎿  $ <command>` — rather than on the word `sleep`, which also
 * appears in the instruction WE typed. Matching that would be the proof
 * reading its own input back and calling it evidence.
 */
const shellRunning = (text) => /⎿\s+\$\s.*sleep/.test(text) && turnInFlight(text);

/** One contended send, asserted the same way whatever put the agent to work. */
async function contendedSend(label, message) {
  const mark = invocations().length;
  const r = await send(message);
  showVerdict(`${label}:`, r);
  showPane('the REAL pane the verdict was read from:', r.evidence.tail);
  check(r.verdict === 'delivered',
    `${label}: a send to a CONTENDED agent is confirmed DELIVERED`,
    JSON.stringify({ ...r.evidence, tail: undefined }));
  check(r.evidence.landedAfter > r.evidence.landedBefore,
    `${label}: and by the same measurement — the submitted count went up on a pane that was read`);
  check(keysSince(mark).filter((l) => l.endsWith(' C-c')).length === 1,
    `${label}: exactly one Ctrl+C, at an agent that was NOT idle`,
    JSON.stringify(keysSince(mark)));
  return r;
}

let busyResult;
{
  // --- 1b-i: mid-task, generating -----------------------------------------
  dropEnters(0);
  setUnreadable(false);
  const setupI = await send('live 1b-i setup: count slowly from 1 to 40, one number per line, nothing else');
  check(setupI.verdict === 'delivered',
    'SETUP 1b-i: the setup instruction itself landed as its own submission',
    JSON.stringify({ verdict: setupI.verdict }));
  const busyGenerating = await waitForPane('mid-task', turnInFlight);
  check(busyGenerating,
    'PRECONDITION 1b-i: the agent is genuinely mid-task — its pane offers "esc to interrupt"');
  if (busyGenerating) {
    await contendedSend('1b-i mid-task', 'live 1b-i: reply with the single word MIDACK and nothing else');
  }

  // --- 1b-ii: blocked in a long shell command ------------------------------
  //
  // The setup is waited out to COMPLETION before the next one is typed, and
  // that is this ticket's own disclosed limit applied to its own fixture: two
  // sends in quick succession can be submitted as one concatenated line. The
  // first version of this section did exactly that — the setup and the
  // contended message arrived as `…nothing elselive 1b-ii: reply with…`, so
  // `sleep 25` never ran at all. The limit is real, and this is what respecting
  // it looks like.
  await waitForPane('the previous turn to finish', (t) => !turnInFlight(t), 120_000);
  await sleep(2000);
  const setupII = await send('live 1b-ii setup: run `sleep 25` with your Bash tool right now, nothing else');
  check(setupII.verdict === 'delivered',
    'SETUP 1b-ii: the setup instruction itself landed as its own submission, NOT concatenated ' +
    'onto the next one — the failure mode this ticket documents, respected in its own fixture',
    JSON.stringify({ verdict: setupII.verdict }));
  const busyInShell = await waitForPane('blocked in a shell command', shellRunning);
  check(busyInShell,
    'PRECONDITION 1b-ii: a SHELL COMMAND IS ACTUALLY RUNNING — matched on the `⎿  $ …` tool ' +
    'invocation echo rather than on the word "sleep" in the instruction we typed');
  if (busyInShell) {
    busyResult = await contendedSend(
      '1b-ii in-shell', 'live 1b-ii: reply with the single word SHELLACK and nothing else');

    // THE COST, MEASURED RATHER THAN CAVEATED. The MCP description used to say
    // this call is "safe for the recipient's in-flight work". It is not — the
    // first Ctrl+C terminates the tool call — and round 2 narrowed the
    // sentence. This is the evidence that correction rests on, taken here
    // rather than borrowed from a reviewer's transcript.
    await sleep(3000);
    const after = bridge.tailAgent(AGENT_PATH, 80);
    const interrupted = after.success && typeof after.text === 'string' &&
      /Interrupted|What should Claude do instead/i.test(after.text);
    showPane('the pane after the send — what the interrupt did to the in-flight work:', after.text);
    check(interrupted,
      'AND THE IN-FLIGHT TOOL CALL WAS TERMINATED by the interrupt — so "safe for the recipient\'s ' +
      'in-flight work" would have been FALSE, which is why the tool description no longer says it',
      after.text?.slice(-400));
  }
}

// ===========================================================================
rule('2. THE ENTER DID NOT TAKE — reported NOT DELIVERED, on a real composer');
// ===========================================================================

let notDeliveredResult;
{
  const message = 'live section two: this message must never reach you';
  dropEnters(99);          // every Enter swallowed, including the retry's
  const mark = invocations().length;
  const r = await send(message);
  notDeliveredResult = r;
  dropEnters(0);
  showVerdict('not-delivered:', r);
  showPane('the REAL pane — the text is sitting in Claude Code\'s input box:', r.evidence.tail);

  check(r.verdict === 'not-delivered' && r.success === false && r.delivered === false,
    'a send whose Enter never took reports NOT DELIVERED rather than success: true',
    JSON.stringify({ verdict: r.verdict, success: r.success }));
  check(r.evidence.inComposer === true,
    'and names the state: sitting unsubmitted in the composer of a real agent');
  check(r.evidence.readable === true && r.evidence.landedAfter === r.evidence.landedBefore,
    'evidence of absence — the real pane answered and the submitted count did not move');
  // THE RAW SUBSTRING CHECK IS WRONG TWICE ON REAL OUTPUT, and this is the
  // section that can say so with evidence. Claude Code hard-wraps the message
  // in its input box, so `tail.includes(message)` misses it entirely — and
  // once flattening repairs that, the text is plainly there, which is what a
  // naive check would have read as a delivery.
  console.log(
    `   on this REAL pane: raw tail.includes(message) = ${r.evidence.tail.includes(message)}, ` +
    `flattened = ${flat(r.evidence.tail).includes(deliveryFingerprint(message))}`
  );
  check(flat(r.evidence.tail).includes(deliveryFingerprint(message)),
    'the message IS in the real pane buffer once wrapping is flattened — which is what a ' +
    'substring check would have called a delivery');

  // THE RAW RESULT IS REPORTED, NOT ASSERTED, and that is a correction. This
  // used to assert `raw === false` — "Claude Code wraps the echo, so the raw
  // check cannot find it" — which is true only when the message is longer than
  // the pane is wide. It held at the 19- and 43-column panes this proof ran on
  // earlier and went red at 80 columns, where the message fits on one line.
  // That made it an assertion about the terminal's width rather than about the
  // daemon: a check that stops measuring the thing it names as soon as the
  // window changes. What is invariant is the direction — flattening can only
  // ever find MORE than the raw check — so that is what is asserted.
  const rawFound = r.evidence.tail.includes(message);
  const flatFound = flat(r.evidence.tail).includes(deliveryFingerprint(message));
  check(!(rawFound && !flatFound),
    'and flattening never finds LESS than a raw substring check would — the invariant that ' +
    'makes it safe, as opposed to the width-dependent case where it finds more',
    `raw=${rawFound} flattened=${flatFound}`);
  if (!rawFound) {
    console.log('   (and on THIS pane the raw check missed a message that is plainly there — ' +
      'the width-dependent case that makes flattening load-bearing rather than tidiness)');
  }
  check(keysSince(mark).filter((l) => l.endsWith(' C-c')).length === 1,
    'still exactly one Ctrl+C', JSON.stringify(keysSince(mark)));
}

// ===========================================================================
rule('3. THE RETRY DELIVERS — one lost Enter, and no second interrupt');
// ===========================================================================

{
  // Clear the stuck text from section 2 first, so what is measured below is
  // this send rather than the leftovers of the last one.
  const paneId = JSON.parse(
    spawnSync(realHerdr, ['agent', 'get', AGENT_NAME], { encoding: 'utf8' }).stdout
  ).result.agent.pane_id;
  spawnSync(realHerdr, ['pane', 'send-keys', paneId, 'C-c'], { encoding: 'utf8' });
  await sleep(1500);

  const message = 'live section three: reply with the single word RETRIED and nothing else';
  dropEnters(1);           // the first Enter is lost; the second takes
  const mark = invocations().length;
  const r = await send(message);
  dropEnters(0);
  showVerdict('delivered on retry:', r);
  showPane('the REAL pane the verdict was read from:', r.evidence.tail);
  console.log(`   keystrokes this send issued: ${JSON.stringify(keysSince(mark))}`);

  check(r.verdict === 'delivered' && r.retried === true && r.submits === 2,
    'the Enter-only retry DELIVERS the message that was stuck in a real composer',
    JSON.stringify({ ...r.evidence, tail: undefined }));

  const keys = keysSince(mark);
  check(keys.filter((l) => l.endsWith(' C-c')).length === 1 && r.interrupts === 1,
    'NO SECOND Ctrl+C — one interrupt for the whole send including its retry',
    JSON.stringify(keys));
  check(invocations().slice(mark).filter((l) => l.startsWith('pane send-text ')).length === 1,
    'and one send-text: the message was never retyped over a real agent\'s composer');

  // The reason the rule exists. A second Ctrl+C would have quit Claude Code,
  // so the agent is COUNTED afterwards rather than assumed.
  const census = bridge.listHerdrAgentsChecked();
  const alive = census.agents.find((x) => x.name === AGENT_NAME);
  check(census.reachable && !!alive && alive.agentRuntime !== null,
    'and the agent is STILL ALIVE — herdr lists it with a live runtime behind the pane',
    JSON.stringify(alive ?? null));
}

// ===========================================================================
rule('4. UNVERIFIABLE — the send goes out and the pane cannot be observed');
// ===========================================================================

let unverifiableResult;
{
  const message = 'live section four: an unobservable send';
  dropEnters(0);
  // Readable for the baseline, then blind. The message really is typed at a
  // real agent; only the confirmation is impossible.
  const baseline = bridge.tailAgent(AGENT_PATH, 60);
  check(baseline.success, 'the pane is readable before the blackout (the precondition)', baseline.error);

  const mark = invocations().length;
  const p = send(message);
  // The blackout starts once the baseline read is behind us.
  setTimeout(() => setUnreadable(true), 400);
  const r = await p;
  setUnreadable(false);
  unverifiableResult = r;
  showVerdict('unverifiable:', r);
  console.log(`   keystrokes this send issued: ${JSON.stringify(keysSince(mark))}`);

  check(r.verdict === 'unverifiable',
    'a send nobody can observe is UNVERIFIABLE, not a failed delivery', JSON.stringify(r));
  check(r.interrupts === 1 && r.submits === 1,
    'and the message really WAS typed at the real agent — which is why "it did not arrive" ' +
    'would have been the wrong thing to tell the caller',
    JSON.stringify({ interrupts: r.interrupts, submits: r.submits }));
  check(r.delivered === false && r.success === false,
    'it claims no delivery — `delivered` and `success` are both false');
  check(r.verdict !== notDeliveredResult.verdict && r.verdict !== deliveredResult.verdict,
    'and it is a THIRD word, distinct from both of the others',
    `${r.verdict} / ${notDeliveredResult.verdict} / ${deliveredResult.verdict}`);
  check(r.evidence.readable === false && r.evidence.landedAfter === null,
    'the evidence says the pane could not be read rather than reporting a count of zero',
    JSON.stringify(r.evidence));
}

console.log('\n   ALL THREE VERDICTS, SIDE BY SIDE, ALL AGAINST ONE REAL CLAUDE CODE AGENT:');
showVerdict('  delivered', deliveredResult);
showVerdict('  not-delivered', notDeliveredResult);
showVerdict('  unverifiable', unverifiableResult);

// ===========================================================================

console.log('\n   final state of the real pane:');
setUnreadable(false);
dropEnters(0);
showPane('', bridge.tailAgent(AGENT_PATH, 40).text);

closeAgent();
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
