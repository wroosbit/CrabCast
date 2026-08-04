#!/usr/bin/env node
// KAN-114 — a send that CONFIRMS rather than dispatches.
//
// WHAT FAILURE THIS WOULD CATCH: a `send_to_agent` that answers `success: true`
// having typed three keystrokes and observed nothing, so a message left sitting
// UNSUBMITTED in the recipient's composer is reported to its sender as
// delivered. That happened three times in one fleet on 2026-08-03 — once
// arriving only because a human noticed and pressed Enter, once found in a
// design agent's composer while its terminal showed a plausible final frame,
// and once never acted on at all with its sender presumably believing
// otherwise. The text is on screen the whole time, which is exactly why nobody
// spots it.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT WRITES AND WHAT THAT LEAVES UNCOVERED — read this before
// trusting a green run.
// ---------------------------------------------------------------------------
//
// THIS SCRIPT SUPPLIES THE PANE IT THEN ASSERTS ON. The `herdr` binary is a
// shim, and the pane it models — a transcript, a `❯` caret, a composer after
// it — is written by this file. A proof that supplies its own input has not
// tested that the input arrives, and KAN-145 is the cautionary case: two
// scripts asserted a field was carried correctly by constructing records that
// already had it, while the real path produced `null` for every agent in
// production and both stayed green. Nothing was wrong with either script; the
// gap was between them and no script owned it.
//
// So, precisely:
//
//   COVERED HERE — that `sendToAgent` reads the pane back, that it separates
//   submitted text from text sitting in the composer by POSITION, that the
//   three verdicts are distinct and reach the caller through the router and
//   the CLI, that exactly one Ctrl+C is ever issued including across the
//   retry, and that an unreadable pane answers `unverifiable` rather than
//   collapsing into `not-delivered`.
//
//   NOT COVERED HERE — that a REAL Claude Code composer looks like what this
//   shim draws. `COMPOSER_MARKERS` is the load-bearing assumption of the whole
//   mechanism: if a real Claude Code pane marks its input line with something
//   this list does not contain, every section below still passes and every
//   send in production reports the wrong verdict. This shim cannot fail that
//   way because this shim renders the marker it is checked against.
//
//   WHO COVERS IT — `scripts/verify-send-confirms-delivery-live.mjs`, which
//   runs the same code against a real herdr and a real Claude Code agent and
//   reads the marker off a pane nobody here wrote. It is in the live half of
//   this suite (no GitHub runner has herdr or terminal panes), so its output
//   goes on the PR rather than into CI. A green run of THIS file is not
//   evidence about the real composer.
//
// Everything under test is the real compiled code: the real HerdrBridge, the
// real MessageRouter, a real daemon over a real unix socket, and the real CLI.
//
// Usage:
//   npm run build
//   node scripts/verify-send-confirms-delivery.mjs [distDir]

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.resolve(scriptDir, '../dist');

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan114-'));
const fakeHome = path.join(scratchRoot, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

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

/** A pane, printed the way a reviewer needs to see it: verbatim and framed. */
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

/** The verdict block, so all three can be put side by side in the PR. */
function showVerdict(label, r) {
  console.log(
    `   ${label.padEnd(22)} verdict=${String(r.verdict).padEnd(14)} ` +
    `delivered=${String(r.delivered).padEnd(6)} success=${String(r.success).padEnd(6)} ` +
    `interrupts=${r.interrupts} submits=${r.submits} retried=${r.retried} ` +
    `inComposer=${r.evidence?.inComposer} landed=${r.evidence?.landedBefore}→${r.evidence?.landedAfter} ` +
    `readable=${r.evidence?.readable}`
  );
}

// ===========================================================================
// The herdr shim: a pane that can lose an Enter, and can stop answering.
// ===========================================================================
//
// Two modes, both marker files rather than env vars, so a running daemon picks
// them up between calls without a restart:
//
//   drop-enters   a count. Each `send-keys Enter` decrements it and does
//                 NOTHING — the witnessed failure, reproduced exactly: the
//                 keystroke was dispatched, herdr answered success, and the
//                 text stayed in the composer.
//   unreadable    `agent read` fails the way a herdr that cannot answer does.
//                 Everything else keeps working, which is the point: the send
//                 succeeds and only the OBSERVATION is impossible.

const shimState = path.join(scratchRoot, 'shim-state');
const shimDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.CRABCAST_KAN114_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_KAN114_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));

const paneFileFor = (name) => path.join(state, 'pane-' + Buffer.from(name).toString('hex') + '.json');
const readPane = (name) => fs.existsSync(paneFileFor(name))
  ? JSON.parse(fs.readFileSync(paneFileFor(name), 'utf8'))
  : { transcript: 'bypass permissions on\\n❯ hello, agent\\n  I am working on it.', composer: '' };
const writePane = (name, p) => fs.writeFileSync(paneFileFor(name), JSON.stringify(p));
/** herdr's view: the transcript, then the composer AFTER the caret. */
const render = (p) => p.transcript + '\\n❯ ' + p.composer;
const nameOfPane = (id) => (load().find((s) => s.pane_id === id) || {}).name;

const dropFile = path.join(state, 'drop-enters');
const takeDrop = () => {
  if (!fs.existsSync(dropFile)) return false;
  const left = Number(fs.readFileSync(dropFile, 'utf8')) || 0;
  if (left <= 0) return false;
  fs.writeFileSync(dropFile, String(left - 1));
  return true;
};

const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: 'p' + (100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1]
  });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'get') {
  const found = load().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id } } });
  fail('agent_not_found', "no agent '" + args[2] + "'");
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({
    name: s.name, pane_id: s.pane_id, agent: 'claude', cwd: s.cwd, agent_status: 'working'
  })) } });
}
if (a === 'agent' && b === 'read') {
  if (fs.existsSync(path.join(state, 'unreadable'))) {
    fail('herdr_unreachable', 'could not connect to the herdr server');
  }
  // A herdr that stops answering PART WAY THROUGH a send: the baseline read
  // succeeds, the send goes out, and then the pane cannot be observed. That is
  // a different shape from "unreadable before we typed anything" and it is the
  // one criterion 4 is really about — a message that IS on its way and whose
  // arrival is simply unknown.
  const afterFile = path.join(state, 'unreadable-after');
  if (fs.existsSync(afterFile)) {
    const left = Number(fs.readFileSync(afterFile, 'utf8')) || 0;
    if (left <= 0) fail('herdr_unreachable', 'could not connect to the herdr server');
    fs.writeFileSync(afterFile, String(left - 1));
  }
  const found = load().find((s) => s.name === args[2]);
  if (!found) fail('agent_not_found', "no agent '" + args[2] + "'");
  out({ result: { read: { text: render(readPane(args[2])), truncated: false } } });
}
if (a === 'pane' && b === 'send-text') {
  const name = nameOfPane(args[2]);
  if (name) { const p = readPane(name); p.composer = args[3] || ''; writePane(name, p); }
  out({ result: {} });
}
if (a === 'pane' && b === 'send-keys') {
  const name = nameOfPane(args[2]);
  if (name) {
    const p = readPane(name);
    if (args[3] === 'Enter') {
      // THE FAILURE, REPRODUCED: the keystroke is accepted and answered
      // successfully, and the composer keeps its text.
      if (!takeDrop() && p.composer) { p.transcript += '\\n❯ ' + p.composer; p.composer = ''; }
    } else if (args[3] === 'C-c') {
      p.composer = '';
    }
    writePane(name, p);
  }
  out({ result: {} });
}
if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else { out({ result: {} }); }
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${shimDir}:${realPath}`;

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
/** Keystrokes issued since a mark — the audit trail behind `interrupts`. */
const keysSince = (mark) =>
  invocations().slice(mark).filter((v) => v[0] === 'pane' && v[1] === 'send-keys').map((v) => v[3]);
const dropEnters = (n) => fs.writeFileSync(path.join(shimState, 'drop-enters'), String(n));
const setUnreadable = (on) => {
  const f = path.join(shimState, 'unreadable');
  if (on) fs.writeFileSync(f, '1');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
};
/** Let `n` more pane reads succeed, then stop answering. `null` clears it. */
const unreadableAfter = (n) => {
  const f = path.join(shimState, 'unreadable-after');
  if (n === null) { if (fs.existsSync(f)) fs.unlinkSync(f); return; }
  fs.writeFileSync(f, String(n));
};
const paneFileFor = (name) => path.join(shimState, `pane-${Buffer.from(name).toString('hex')}.json`);
const rawPane = (name) =>
  fs.existsSync(paneFileFor(name)) ? JSON.parse(fs.readFileSync(paneFileFor(name), 'utf8')) : null;

// ===========================================================================
// The fixture: one real agent, started through the real bridge.
// ===========================================================================

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

const dataDir = path.join(scratchRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scratchRoot, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const agentDir = fs.mkdtempSync(path.join(scratchRoot, 'agent-'));
const AGENT_PATH = fs.realpathSync(agentDir);
const AGENT_NAME = paneNameFor(AGENT_PATH);

// The pane exists because herdr was told to make it, not because a fixture
// declared one: `agent start` is what puts the name in the census every read
// below resolves through.
spawnSync('herdr', ['agent', 'start', AGENT_NAME, '--cwd', AGENT_PATH], { encoding: 'utf8' });

const bridge = new HerdrBridge(dataDir, configPath);
/** Short budgets: these are proofs, not production waits. */
const FAST = { confirmTimeoutMs: 1500, pollMs: 150 };
const send = (message, opts = FAST) => bridge.sendToAgent(AGENT_PATH, message, opts);

// ===========================================================================
rule('1. A CONFIRMED DELIVERY — the verdict comes from the pane, not from the absence of a throw');
// ===========================================================================

dropEnters(0);
setUnreadable(false);
{
  const message = 'section one: please review the PR';
  const mark = invocations().length;
  const r = await send(message);
  showVerdict('delivered:', r);
  showPane('the pane the verdict was read from:', r.evidence.tail);

  check(r.verdict === 'delivered' && r.delivered === true && r.success === true,
    'a send whose Enter took is reported DELIVERED', JSON.stringify(r.evidence));
  check(r.evidence.readable === true && r.evidence.landedAfter > r.evidence.landedBefore,
    'and the verdict is a MEASUREMENT — the submitted count went up on a pane that was read',
    `before=${r.evidence.landedBefore} after=${r.evidence.landedAfter} readable=${r.evidence.readable}`);
  check(typeof r.evidence.tail === 'string' && r.evidence.tail.includes(message),
    'the pane it was read from travels with the verdict, so a caller can audit it');
  check(keysSince(mark).filter((k) => k === 'C-c').length === 1,
    'exactly one Ctrl+C', JSON.stringify(keysSince(mark)));

  // The message is ABOVE the caret, which is the whole distinction. Asserted
  // against the shim's own pane record rather than against the daemon's read,
  // so this is the fixture agreeing rather than the code marking its own work.
  const pane = rawPane(AGENT_NAME);
  check(pane.transcript.includes(message) && !pane.composer.includes(message),
    'and on the pane itself the text is in the TRANSCRIPT with the composer empty',
    JSON.stringify(pane));
}

// ===========================================================================
rule('2. THE FAILURE THIS EXISTS FOR — the Enter does not take, and it is NOT reported as success');
// ===========================================================================
//
// Every Enter is swallowed, including the retry's. This is the state the epic
// agent's message was in when a human had to press Enter by hand: typed,
// dispatched, herdr answered success, nothing delivered.

let composerFailure;
{
  const message = 'section two: the enter did not take';
  dropEnters(99);
  const mark = invocations().length;
  const r = await send(message);
  composerFailure = r;
  showVerdict('not-delivered:', r);
  showPane('the pane the verdict was read from — the text is sitting in the composer:', r.evidence.tail);

  check(r.verdict === 'not-delivered' && r.delivered === false && r.success === false,
    'a send whose Enter never took is reported NOT DELIVERED, not success: true',
    JSON.stringify({ verdict: r.verdict, delivered: r.delivered, success: r.success }));
  check(r.evidence.inComposer === true,
    'and it NAMES the state: the message is sitting unsubmitted in the composer');
  check(r.evidence.readable === true && r.evidence.landedAfter === r.evidence.landedBefore,
    'this is evidence of absence rather than a failure to look — the pane answered and the count did not move',
    `readable=${r.evidence.readable} ${r.evidence.landedBefore}→${r.evidence.landedAfter}`);
  check(typeof r.error === 'string' && /composer/i.test(r.error),
    'the error tells a human where the message actually is', r.error);

  // The trap this check exists to avoid: the unsent text IS in the buffer, so
  // a substring test over the tail passes on exactly this frame.
  check(r.evidence.tail.includes(message),
    'the message IS in the pane buffer — which is why a substring check would have called this delivered');

  check(keysSince(mark).filter((k) => k === 'C-c').length === 1,
    'and still exactly one Ctrl+C, even though the send gave up',
    JSON.stringify(keysSince(mark)));
}

// ===========================================================================
rule('3. THE RETRY DELIVERS, AND IT PRESSES ENTER RATHER THAN INTERRUPTING AGAIN');
// ===========================================================================
//
// One Enter is lost — the transient shape actually observed, an Enter eaten by
// a tool call in flight — and the second takes. The constraint that governs
// this is that a second Ctrl+C is how Claude Code quits, so the retry must not
// be a second interrupt: the composer already HOLDS the message, and what it
// needs is a submit. That is literally what the human did.

{
  const message = 'section three: retry after a lost enter';
  dropEnters(1);
  const mark = invocations().length;
  const censusBefore = bridge.listHerdrAgentsChecked();
  const r = await send(message);
  showVerdict('delivered on retry:', r);
  showPane('the pane the verdict was read from:', r.evidence.tail);
  console.log(`   keystrokes this send issued: ${JSON.stringify(keysSince(mark))}`);

  check(r.verdict === 'delivered' && r.delivered === true,
    'the retry DELIVERS the message that was stuck in the composer', JSON.stringify(r.evidence));
  check(r.retried === true && r.submits === 2,
    'and it took two submits, which the caller is told rather than left to infer',
    JSON.stringify({ retried: r.retried, submits: r.submits }));

  const keys = keysSince(mark);
  check(keys.filter((k) => k === 'C-c').length === 1 && r.interrupts === 1,
    'NO SECOND Ctrl+C — one interrupt for the whole send including its retry',
    JSON.stringify({ keys, interrupts: r.interrupts }));
  check(keys[0] === 'C-c' && keys.slice(1).every((k) => k === 'Enter'),
    'the retry is an Enter and nothing else: the message was never typed a second time',
    JSON.stringify(keys));
  check(invocations().slice(mark).filter((v) => v[0] === 'pane' && v[1] === 'send-text').length === 1,
    'and exactly one send-text, so nothing was retyped over the agent\'s composer');

  // Still alive afterwards. The reason the single-interrupt rule exists is
  // that breaking it kills the recipient, so the recipient is counted.
  const censusAfter = bridge.listHerdrAgentsChecked();
  check(
    censusAfter.reachable && censusAfter.agents.some((x) => x.name === AGENT_NAME),
    'and the agent is STILL ALIVE afterwards — herdr still lists it',
    JSON.stringify({ before: censusBefore.agents.length, after: censusAfter.agents.length })
  );
}

// ===========================================================================
rule('4. UNVERIFIABLE IS ITS OWN ANSWER — an unreadable pane is not a failed delivery');
// ===========================================================================
//
// The send itself works; only the observation is impossible. Butchr's shipped
// primitive collapses this into `delivered: false` with an error string, so a
// caller cannot tell "it definitely did not arrive" from "I could not see".
// Those license opposite actions — resend, versus read the agent before doing
// anything — which is why this codebase gives it a word.

// TWO SHAPES OF UNVERIFIABLE, because they differ in what was done to the
// agent and a caller needs both told apart from `not-delivered`:
//   4a  the pane cannot be read BEFORE anything is typed — nothing was sent,
//       and nothing may be concluded about the agent either;
//   4b  the send went out and THEN the pane stopped answering — the message is
//       very possibly in front of the agent right now. This is the shape that
//       makes `unverifiable` load-bearing: reporting it as `not-delivered`
//       invites a resend that duplicates work already under way.
let unverifiableBefore;
let unverifiableAfter;
{
  const message = 'section four-a: herdr cannot be read at all';
  dropEnters(0);
  setUnreadable(true);
  const r = await send(message);
  unverifiableBefore = r;
  setUnreadable(false);
  showVerdict('4a unverifiable:', r);

  check(r.verdict === 'unverifiable',
    '4a: a send whose pane cannot be read at all is UNVERIFIABLE', JSON.stringify(r));
  check(r.interrupts === 0 && r.submits === 0,
    'and NOTHING was typed — an unobservable agent does not get an interrupt on spec',
    JSON.stringify({ interrupts: r.interrupts, submits: r.submits }));
  check(typeof r.error === 'string' && /NOTHING WAS TYPED/.test(r.error),
    'the error says so, so a caller knows the agent is untouched', r.error);
}

{
  const message = 'section four-b: typed, and then herdr went quiet';
  dropEnters(0);
  setUnreadable(false);
  // One read succeeds — the baseline — and every read after it fails. So the
  // send really goes out and only the confirmation is impossible.
  unreadableAfter(1);
  const mark = invocations().length;
  const r = await send(message);
  unreadableAfter(null);
  unverifiableAfter = r;
  showVerdict('4b unverifiable:', r);
  console.log(`   keystrokes this send issued: ${JSON.stringify(keysSince(mark))}`);

  check(r.verdict === 'unverifiable',
    '4b: a send that WAS typed and then could not be observed is UNVERIFIABLE', JSON.stringify(r));
  check(r.interrupts === 1 && r.submits === 1,
    'and it really was sent — one interrupt, one submit, so the agent may well have it',
    JSON.stringify({ interrupts: r.interrupts, submits: r.submits }));
  check(r.delivered === false && r.success === false,
    'it does not claim delivery — `delivered` and `success` are both false');
  check(r.verdict !== composerFailure.verdict,
    'and it is a DIFFERENT WORD from the confirmed non-delivery in section 2',
    `${r.verdict} vs ${composerFailure.verdict}`);
  check(r.evidence.readable === false && r.evidence.landedAfter === null,
    'the evidence says the pane could not be read, rather than reporting a count of zero',
    JSON.stringify(r.evidence));
  check(typeof r.error === 'string' && /NOT A FAILED SEND/i.test(r.error),
    'and the error tells the caller what NOT to conclude', r.error);
  check(r.submits === 1,
    'it did NOT retry into the dark — typing again at an agent nobody can observe is how a ' +
    'bounded retry becomes a loop of interrupts');
}

console.log('\n   EVERY VERDICT, SIDE BY SIDE:');
showVerdict('  delivered', (await (async () => {
  dropEnters(0); setUnreadable(false);
  return send('side by side: a delivered message');
})()));
showVerdict('  not-delivered', composerFailure);
showVerdict('  unverifiable (4a)', unverifiableBefore);
showVerdict('  unverifiable (4b)', unverifiableAfter);

// ===========================================================================
rule('5. THE BASELINE — a message the pane ALREADY held does not count as this send landing');
// ===========================================================================
//
// Without a reading taken BEFORE typing, a send whose text happens to match
// earlier output reports delivered while nothing landed: a check passing on a
// coincidence. Supervisors send near-identical notices about different agents
// all day, so this is the ordinary case rather than a contrived one.

{
  const message = 'section five: a repeated notice';
  dropEnters(0);
  setUnreadable(false);
  const first = await send(message);
  check(first.verdict === 'delivered', 'the first copy is delivered and is now in the transcript');

  // Now the pane genuinely holds this exact text as submitted output — and the
  // second send's Enter is swallowed.
  dropEnters(99);
  const r = await send(message);
  showVerdict('second copy:', r);
  showPane('the pane, which already holds one submitted copy:', r.evidence.tail);

  check(r.evidence.landedBefore >= 1,
    'the baseline read saw the copy that was already there', JSON.stringify(r.evidence));
  check(r.verdict === 'not-delivered',
    'and the second send is still NOT DELIVERED — a pre-existing match is not evidence of this one',
    JSON.stringify(r.evidence));
  check(r.evidence.landedAfter === r.evidence.landedBefore,
    'because what is measured is the count going UP, not the text being present');
}

// ===========================================================================
rule('6. THE VERDICT REACHES THE CALLER — through the router, a real daemon, and the real CLI');
// ===========================================================================

const { connectToDaemon, socketPathFor, onJsonLines, writeJsonLine } =
  await import(path.join(distDir, 'ipc.js'));

const daemonPids = new Set();
const cliJs = path.join(distDir, 'cli.js');
const cliEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_KAN114_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};
const crabcast = (args) =>
  spawnSync(process.execPath, [cliJs, '--config', configPath, ...args], {
    env: cliEnv, encoding: 'utf8', timeout: 120_000
  });

async function raw(action, payload = {}) {
  const socket = await connectToDaemon(dataDir, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `kan114-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply to ${action}`)); }, 60_000);
    onJsonLines(socket, (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.end();
      resolve(msg);
    });
    writeJsonLine(socket, { action, id, ...payload });
  });
}

{
  // The daemon is spawned by the CLI's own first connect, exactly as any
  // caller would get one. `configure` then `activate` puts a record behind the
  // pane the shim already has, so the router's address resolution has
  // something real to resolve.
  dropEnters(0);
  setUnreadable(false);
  const configured = crabcast(['configure', AGENT_PATH, '--priority', '5', '--launcher', 'claude']);
  check(configured.status === 0, 'the CLI configured an agent against a real daemon',
    `${configured.status}: ${configured.stderr?.slice(0, 300)}`);
  const st = await raw('daemon_status');
  daemonPids.add(st.pid);
  const activated = crabcast(['activate', AGENT_PATH, '--override']);
  check(activated.status === 0, 'and activated it', `${activated.status}: ${activated.stderr?.slice(0, 400)}`);

  // --- the socket: a delivered send ---------------------------------------
  const okRes = await raw('send_to_agent', { path: AGENT_PATH, message: 'wire: a delivered message' });
  console.log('   send_to_agent_response (delivered):');
  console.log(JSON.stringify({ ...okRes, evidence: { ...okRes.evidence, tail: '…' } }, null, 2)
    .replace(/^/gm, '     '));
  check(okRes.success === true && okRes.delivered === true && okRes.verdict === 'delivered',
    'the router answers a delivered send with success, delivered AND verdict');

  // --- the socket: a send whose Enter did not take -------------------------
  dropEnters(99);
  const badRes = await raw('send_to_agent', { path: AGENT_PATH, message: 'wire: the enter did not take' });
  console.log('   send_to_agent_response (not delivered):');
  console.log(JSON.stringify({ ...badRes, evidence: { ...badRes.evidence, tail: '…' } }, null, 2)
    .replace(/^/gm, '     '));
  check(badRes.success === false && badRes.delivered === false && badRes.verdict === 'not-delivered',
    'and a stuck-in-the-composer send with the verdict, not with success: true');
  check(badRes.evidence?.inComposer === true && badRes.evidence?.readable === true,
    'carrying the evidence the verdict was read from');

  // --- the socket: unverifiable -------------------------------------------
  dropEnters(0);
  setUnreadable(true);
  const unkRes = await raw('send_to_agent', { path: AGENT_PATH, message: 'wire: cannot be observed' });
  setUnreadable(false);
  console.log('   send_to_agent_response (unverifiable):');
  console.log(JSON.stringify(unkRes, null, 2).replace(/^/gm, '     '));
  check(unkRes.verdict === 'unverifiable' && unkRes.delivered === false,
    'and an unobservable send as `unverifiable`, distinct from both');

  // EVERY response carries both fields, in all three outcomes. A field that
  // appears only when true asks a caller to read meaning into an absence,
  // which is the shape this daemon refuses everywhere else (mcp.ts:297).
  check(
    [okRes, badRes, unkRes].every((r) =>
      typeof r.delivered === 'boolean' && typeof r.verdict === 'string'),
    '`delivered` and `verdict` are on EVERY response, so the outcome is read rather than inferred',
    JSON.stringify([okRes, badRes, unkRes].map((r) => ({ d: r.delivered, v: r.verdict })))
  );

  // --- the CLI -------------------------------------------------------------
  dropEnters(0);
  const cliOk = crabcast(['send', AGENT_PATH, 'cli: a delivered message']);
  console.log(`   $ crabcast send ${AGENT_PATH} 'cli: a delivered message'`);
  console.log(cliOk.stdout.replace(/^/gm, '     '));
  check(cliOk.status === 0 && /delivered to /.test(cliOk.stdout) &&
        /submitted output/.test(cliOk.stdout),
    'the CLI says DELIVERED and says what that was read from', cliOk.stdout.slice(0, 300));

  dropEnters(99);
  const cliBad = crabcast(['send', AGENT_PATH, 'cli: the enter did not take']);
  console.log(`   $ crabcast send ${AGENT_PATH} 'cli: the enter did not take'`);
  console.log(cliBad.stdout.replace(/^/gm, '     '));
  check(cliBad.status !== 0 && /NOT DELIVERED/.test(cliBad.stdout),
    'the CLI says NOT DELIVERED and exits non-zero — it no longer says "Enter pressed"',
    cliBad.stdout.slice(0, 300));
  check(!/the message was typed into its terminal and Enter pressed/.test(cliBad.stdout),
    'the old sentence — a description of our keystrokes rather than of the agent — is gone');

  dropEnters(0);
  setUnreadable(true);
  const cliUnk = crabcast(['send', AGENT_PATH, 'cli: cannot be observed']);
  setUnreadable(false);
  console.log(`   $ crabcast send ${AGENT_PATH} 'cli: cannot be observed'`);
  console.log(cliUnk.stdout.replace(/^/gm, '     '));
  check(/UNVERIFIABLE/.test(cliUnk.stdout) && !/FAILED/.test(cliUnk.stdout),
    'and UNVERIFIABLE gets its own line rather than being printed as a failure — ' +
    'a human reading FAILED reaches for the resend, which is the wrong move here',
    cliUnk.stdout.slice(0, 300));
}

// ===========================================================================
rule('7. THE CHECKS CAN FAIL — the compiled daemon is mutated, and they go red');
// ===========================================================================
//
// A check that cannot fail is not a check, and THIS ticket is where that
// matters most in the story: criterion 2 requires producing a state that is
// hard to manufacture, which makes it the criterion most likely to be quietly
// downgraded into something that passes without ever exercising the failure.
// This repo has already had a delivery check caught passing on a guess
// (KAN-88).
//
// TWO GUARDS, because the mutation section is itself a claim:
//
//   1. `mutantDist` REFUSES to produce a mutant whose find string is not
//      there exactly once. A mutation whose anchor has drifted applies
//      nothing, the section passes, and it looks exactly like coverage.
//   2. Each block re-establishes its OWN PRECONDITION against the pristine
//      build immediately before mutating — the same scenario, the same shim
//      state, measured now rather than inherited from a section that ran
//      earlier under different conditions. A mutation block that would have
//      passed against an unmutated daemon proves nothing, and the section
//      whose whole purpose is proving checks can fail must not be able to
//      pass vacuously.

try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'),
    path.join(scratchRoot, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

/** A copy of dist with one string replaced. Returns the mutated module dir. */
function mutantDist(name, file, from, to) {
  const dir = path.join(scratchRoot, `mutant-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(distDir, dir, { recursive: true });
  const target = path.join(dir, file);
  const before = fs.readFileSync(target, 'utf8');
  const occurrences = before.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${name}' expected exactly one occurrence of ${JSON.stringify(from)} in ` +
      `${file}, found ${occurrences}. THE BUILD WAS NOT MUTATED, so the section using it ` +
      `would have proved nothing. Fix the mutation, not this check.`
    );
  }
  const after = before.replace(from, to);
  fs.writeFileSync(target, after);
  if (after === before) {
    throw new Error(`mutation '${name}' replaced the text with itself — nothing was mutated.`);
  }
  return dir;
}

{
  // MUTATION A: the positional test stops being positional. `landedCount`
  // counts over the WHOLE tail instead of the part above the composer, which
  // is the naive `tail.includes(message)` this mechanism exists to replace.
  //
  // What it turns back on: the unsent text is in the buffer, so a send that
  // never left the composer reports DELIVERED.
  const scenario = async (b) => {
    dropEnters(99);
    setUnreadable(false);
    return b.sendToAgent(AGENT_PATH, `mutation A probe ${Math.random()}`, FAST);
  };

  // PRECONDITION, measured against the pristine build right now.
  const sane = await scenario(bridge);
  check(sane.verdict === 'not-delivered',
    'precondition: against the UNMUTATED daemon this scenario is not-delivered',
    JSON.stringify(sane.evidence));

  const dir = mutantDist(
    'no-composer-split', 'delivery.js',
    'return flatten(splitAtComposer(tail).submitted).split(needle).length - 1;',
    'return flatten(tail).split(needle).length - 1;'
  );
  const { HerdrBridge: Broken } = await import(path.join(dir, 'herdr.js'));
  const broken = await scenario(new Broken(dataDir, configPath));
  showVerdict('mutant A says:', broken);
  check(broken.verdict === 'delivered',
    'MUTATION A: dropping the composer split makes section 2 report DELIVERED for a message ' +
    'sitting unsent — so section 2 is testing the daemon rather than its own expectations',
    JSON.stringify(broken.evidence));
}

{
  // MUTATION B: an unreadable pane is coerced to a count of zero — the shape
  // the primitive we borrowed from actually ships, and the shape KAN-138
  // collects: an assertion of "nothing landed" that an unreadable pane
  // satisfies just as well as a genuine non-delivery.
  // Section 4b's shape — baseline readable, every confirmation read blind —
  // so this mutates the CONFIRMATION LOOP's honesty rather than only the
  // early return, which is where the coercion does its damage.
  const scenario = async (b) => {
    dropEnters(0);
    setUnreadable(false);
    unreadableAfter(1);
    try {
      return await b.sendToAgent(AGENT_PATH, `mutation B probe ${Math.random()}`, FAST);
    } finally {
      unreadableAfter(null);
    }
  };

  const sane = await scenario(bridge);
  check(sane.verdict === 'unverifiable',
    'precondition: against the UNMUTATED daemon a send nobody can observe is unverifiable',
    JSON.stringify(sane));

  const dir = mutantDist(
    'unreadable-is-zero', 'herdr.js',
    "return { readable: false, error: tail.error ?? `herdr returned no readable output for '${agentPath}'` };",
    'return { readable: true, count: 0, inComposer: false, tail: "" };'
  );
  const { HerdrBridge: Broken } = await import(path.join(dir, 'herdr.js'));
  const broken = await scenario(new Broken(dataDir, configPath));
  showVerdict('mutant B says:', broken);
  check(broken.verdict !== 'unverifiable',
    'MUTATION B: reading an unreadable pane as "zero landed" destroys the third verdict — ' +
    'section 4 goes red, so section 4 is testing the split rather than asserting it',
    JSON.stringify(broken));
}

{
  // MUTATION C: the retry becomes a second interrupt — the shape the borrowed
  // primitive uses, and the one KAN-114 forbids because a second Ctrl+C is how
  // Claude Code quits. Section 3's keystroke assertion is what stands between
  // this daemon and killing the agents it is trying to talk to.
  const scenario = async (b) => {
    dropEnters(1);
    setUnreadable(false);
    const mark = invocations().length;
    await b.sendToAgent(AGENT_PATH, `mutation C probe ${Math.random()}`, FAST);
    return keysSince(mark);
  };

  const sane = await scenario(bridge);
  check(sane.filter((k) => k === 'C-c').length === 1,
    'precondition: against the UNMUTATED daemon this retry issues exactly one Ctrl+C',
    JSON.stringify(sane));

  const dir = mutantDist(
    'retry-reinterrupts', 'herdr.js',
    "        this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);\n        submits++;\n        const second = await this.confirmDelivery",
    "        this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);\n        this.runHerdr(['pane', 'send-text', paneId, message]);\n        this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);\n        submits++;\n        const second = await this.confirmDelivery"
  );
  const { HerdrBridge: Broken } = await import(path.join(dir, 'herdr.js'));
  const brokenKeys = await scenario(new Broken(dataDir, configPath));
  console.log(`   mutant C's keystrokes: ${JSON.stringify(brokenKeys)}`);
  check(brokenKeys.filter((k) => k === 'C-c').length === 2,
    'MUTATION C: a retry that re-interrupts issues TWO Ctrl+C — section 3 goes red, so its ' +
    'keystroke assertion is measuring the daemon rather than restating a comment',
    JSON.stringify(brokenKeys));
}

// ===========================================================================

for (const pid of daemonPids) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
