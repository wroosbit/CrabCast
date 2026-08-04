#!/usr/bin/env node
// KAN-114 — the live half: the same delivery check against a REAL Claude Code
// pane, read through a REAL herdr.
//
// WHAT FAILURE THIS WOULD CATCH: `COMPOSER_MARKERS` naming a caret that a real
// Claude Code pane does not draw. That is the load-bearing assumption of the
// whole mechanism — everything else in `src/delivery.ts` is arithmetic over
// where that marker is — and it is the one assumption a shimmed pane CANNOT
// test, because a shim renders the marker it is then checked against. If the
// list is wrong, `verify-send-confirms-delivery.mjs` still passes every section
// and every send in production reports the wrong verdict.
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
process.on('exit', closeAgent);

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
  check(r.evidence.tail.includes(message) === false,
    'and the RAW substring check does not even find it, because Claude Code wraps the echo — ' +
    'so flattening is load-bearing rather than tidiness');
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
