#!/usr/bin/env node
// KAN-98 — a tail may not report a pane empty until it has asked every source.
//
// WHAT FAILURE THIS WOULD CATCH: `HerdrBridge.tailAgent` reporting
// `{success: true, text: ''}` for a pane that is alive and has text on it,
// because it asked ONE herdr read source and that source answers `""` for a
// short pane. That is not a cosmetic blank window: `readDeliveryEvidence` is
// built on `tailAgent`, an empty string is a string, so the spurious read
// arrives as `readable: true, count: 0` — a SUCCESSFUL read of NO OUTPUT — and
// `crabcast send` reports a message `not-delivered` that is sitting on the
// recipient's screen. It lands in `not-delivered` rather than `unverifiable`
// precisely BECAUSE the read looked successful, so the whole `unverifiable`
// apparatus is bypassed. §7 is that composition, end to end.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT SUPPLIES ITS OWN INPUT. READ WHAT THAT LEAVES UNCOVERED.
// ---------------------------------------------------------------------------
//
// The herdr here is a shim this file writes, so every read it asserts on is a
// read this file produced. THAT MEANS THIS SCRIPT CANNOT ESTABLISH THAT REAL
// HERDR EVER ANSWERS `""` FOR A PANE WITH TEXT ON IT. If that premise were
// false, every section below would still pass and the fix would be guarding
// nothing — which is the shape KAN-145 was caught by and this header exists to
// refuse to repeat.
//
// WHO COVERS IT: `scripts/verify-tail-source-boundary-live.mjs`, against a real
// herdr server and a real pane. It is excluded from CI (no runner has herdr)
// and its output goes on the PR. The two are a pair: that one shows the rule is
// REAL, this one shows the shipped code OBEYS it, and neither claims the
// other's half.
//
// WHAT THE SHIM MODELS, and it is the measured rule rather than a convenient
// flag — herdr 0.6.4, measured live by the sibling script:
//
//   * `recent` / `recent-unwrapped --lines N` return THE LAST N ROWS OF THE
//     GRID. Rows below the cursor are blank, so a pane whose content sits in
//     the top C rows of an R-row grid answers `""` for every N <= R - C.
//     Boundary predicted and hit exactly: R=23,C=4 empty at N<=19, text at
//     N=20; R=24,C=4 empty at N<=20, text at N=40.
//   * `visible` returns the screen's content and IGNORES N entirely —
//     identical at every N from 1 to 200 on both panes.
//
// So the shim is a grid, not a switch: the empty answers below are produced the
// way herdr produces them, by windowing blank rows.
//
// Needs no herdr, no daemon and no network. Exits non-zero on any failure.
//
// Usage:
//   npm run build
//   node scripts/verify-tail-asks-every-source.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) { console.log(`\n${title}\n${'-'.repeat(title.length)}`); }

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan98-'));
const shimState = path.join(scratchRoot, 'shim-state');
const shimDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.CRABCAST_KAN98_SHIM_STATE = shimState;

// ---------------------------------------------------------------------------
// The herdr shim: A GRID, read the way herdr reads one.
// ---------------------------------------------------------------------------
const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_KAN98_SHIM_STATE;
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
/** rows = the GRID's height; transcript/composer are the content at the top of it. */
const readPane = (name) => fs.existsSync(paneFileFor(name))
  ? JSON.parse(fs.readFileSync(paneFileFor(name), 'utf8'))
  : { rows: 24, transcript: 'bypass permissions on\\n❯ hello, agent\\n  I am working on it.', composer: '' };
const writePane = (name, p) => fs.writeFileSync(paneFileFor(name), JSON.stringify(p));
const nameOfPane = (id) => (load().find((s) => s.pane_id === id) || {}).name;

/** The content rows, exactly as \`visible\` reports them: no trailing blanks. */
const contentRows = (p) =>
  p.transcript === '' && p.composer === '' ? [] : (p.transcript + '\\n❯ ' + p.composer).split('\\n');

/**
 * THE MEASURED RULE. The grid is \`rows\` tall; content sits at the top and the
 * rest are blank. A \`recent\` read windows the LAST N ROWS OF THAT GRID and
 * joins them — so when the window lies entirely in the blank region the answer
 * is the empty string, which is exactly what herdr 0.6.4 does.
 */
const recentRead = (p, n) => {
  const content = contentRows(p);
  const grid = content.concat(Array(Math.max(0, p.rows - content.length)).fill(''));
  const window = grid.slice(Math.max(0, grid.length - n));
  return window.join('\\n').replace(/\\n+$/, '');
};

const [a, b] = args;
if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({ name: args[2], pane_id: 'p' + (100 + started.length), cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1] });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'get') {
  const found = load().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id } } });
  fail('agent_not_found', "no agent '" + args[2] + "'");
}
if (a === 'agent' && b === 'read') {
  const found = load().find((s) => s.name === args[2]);
  if (!found) fail('agent_not_found', "no agent '" + args[2] + "'");
  const srcIdx = args.indexOf('--source');
  const source = srcIdx === -1 ? 'recent-unwrapped' : args[srcIdx + 1];
  const lineIdx = args.indexOf('--lines');
  const n = lineIdx === -1 ? 40 : Number(args[lineIdx + 1]);

  // A source that REFUSES, so "could not look" can be told from "empty".
  if (fs.existsSync(path.join(state, 'fail-' + source))) {
    fail('herdr_unreachable', 'could not connect to the herdr server (' + source + ')');
  }
  const p = readPane(args[2]);
  const text = source === 'visible'
    // \`visible\` ignores N — measured, at every N from 1 to 200.
    ? contentRows(p).join('\\n')
    : recentRead(p, n);
  out({ result: { read: { text, truncated: false } } });
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
      // THE WITNESSED FAILURE: the keystroke is accepted and answered
      // successfully, and the composer keeps its text.
      const dropFile = path.join(state, 'drop-enters');
      let dropped = false;
      if (fs.existsSync(dropFile)) {
        const left = Number(fs.readFileSync(dropFile, 'utf8')) || 0;
        if (left > 0) { fs.writeFileSync(dropFile, String(left - 1)); dropped = true; }
      }
      if (!dropped && p.composer) { p.transcript += '\\n❯ ' + p.composer; p.composer = ''; }
    }
    else if (args[3] === 'C-c') { p.composer = ''; }
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
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const resetInvocations = () => fs.writeFileSync(path.join(shimState, 'invocations.jsonl'), '');
const reads = () => invocations().filter((a) => a[0] === 'agent' && a[1] === 'read');
const sourceOf = (argv) => argv[argv.indexOf('--source') + 1];

const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kan98-agent-')));
const AGENT_NAME = paneNameFor(agentDir);
const dataDir = path.join(scratchRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scratchRoot, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const paneFileFor = (name) => path.join(shimState, 'pane-' + Buffer.from(name).toString('hex') + '.json');
const setPane = (p) => fs.writeFileSync(paneFileFor(AGENT_NAME), JSON.stringify(p));
const dropEnters = (n) => fs.writeFileSync(path.join(shimState, 'drop-enters'), String(n));
const failSource = (source, on) => {
  const f = path.join(shimState, 'fail-' + source);
  if (on) fs.writeFileSync(f, '1'); else if (fs.existsSync(f)) fs.unlinkSync(f);
};

const bridge = new HerdrBridge(dataDir, configPath);
// Register the pane with the shim without going near a real spawn path.
const { spawnSync } = await import('child_process');
spawnSync('herdr', ['agent', 'start', AGENT_NAME, '--cwd', agentDir], { encoding: 'utf8' });

/** A 24-row grid with three rows of content — the ticket's own shape. */
const SHORT_PANE = { rows: 24, transcript: 'bypass permissions on\n❯ echo hello-from-kan-94\n  hello-from-kan-94', composer: '' };

console.log('KAN-98 — a tail may not report a pane empty until it has asked every source');
console.log(`dist: ${distDir}`);

// ===========================================================================
rule('1. THE TRIGGER IS REAL IN THE MODEL — one source answers "" for a pane with text');
// ===========================================================================
// Before asserting anything about the fix, show the state it exists for. This
// is the ticket's own reproduction: a live pane, plainly not empty, and a
// `recent-unwrapped` read of it that comes back with nothing in it.
setPane(SHORT_PANE);
resetInvocations();
{
  const raw = spawnSync('herdr',
    ['agent', 'read', AGENT_NAME, '--source', 'recent-unwrapped', '--format', 'text', '--lines', '8'],
    { encoding: 'utf8' });
  const recent = JSON.parse(raw.stdout).result.read.text;
  const rawVis = spawnSync('herdr',
    ['agent', 'read', AGENT_NAME, '--source', 'visible', '--format', 'text', '--lines', '8'],
    { encoding: 'utf8' });
  const visible = JSON.parse(rawVis.stdout).result.read.text;

  check(recent === '', 'recent-unwrapped --lines 8 answers the EMPTY STRING', JSON.stringify(recent));
  check(visible.includes('hello-from-kan-94'),
    'visible, at the same moment and the same --lines, has the text', JSON.stringify(visible));
  check(typeof recent === 'string',
    'and it is a STRING, so a `typeof text !== "string"` guard does not catch it — this is the whole defect');
}

// ===========================================================================
rule('2. THE FIX — tailAgent asks the second source and returns the text');
// ===========================================================================
setPane(SHORT_PANE);
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 8);
  check(t.success === true, 'success', JSON.stringify(t));
  check(typeof t.text === 'string' && t.text.includes('hello-from-kan-94'),
    'the pane text is returned rather than an empty string', JSON.stringify(t.text));
  check(t.source === 'visible', 'and it NAMES which source answered', `source=${t.source}`);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    'sourcesTried records that both were asked, in order', JSON.stringify(t.sourcesTried));
  const asked = reads().map(sourceOf);
  check(JSON.stringify(asked) === JSON.stringify(['recent-unwrapped', 'visible']),
    'and the herdr invocation log agrees — this is asserted on the CALLS, not on the return value',
    JSON.stringify(asked));
}

// ===========================================================================
rule('3. THE PRIMARY SOURCE STILL WINS, and the second is not asked when it answers');
// ===========================================================================
// The fallback must not become a substitution: `recent-unwrapped` reaches back
// through SCROLLBACK, which `visible` cannot see, so it keeps its place.
setPane(SHORT_PANE);
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 200);
  check(t.success === true && t.text.includes('hello-from-kan-94'), 'text returned', JSON.stringify(t.text));
  check(t.source === 'recent-unwrapped', 'answered by the primary source', `source=${t.source}`);
  const asked = reads().map(sourceOf);
  check(JSON.stringify(asked) === JSON.stringify(['recent-unwrapped']),
    'visible was NOT asked — one read, not two, when the first one answers', JSON.stringify(asked));
}

// ===========================================================================
rule('4. A GENUINELY EMPTY PANE IS STILL EMPTY, and says so as a finding');
// ===========================================================================
// Acceptance 3. An empty pane is a real answer and must stay distinguishable
// from a read that failed — so it is `success: true` with `source: null`.
setPane({ rows: 24, transcript: '', composer: '' });
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 8);
  check(t.success === true, 'an empty pane is a SUCCESSFUL read', JSON.stringify(t));
  check(t.text === '', 'with empty text', JSON.stringify(t.text));
  check(t.source === null, 'and source null — "every source was asked and every one was empty"', `source=${t.source}`);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    'both sources are named as having been asked', JSON.stringify(t.sourcesTried));
  const asked = reads().map(sourceOf);
  check(asked.length === 2, 'and BOTH were really called before "empty" was claimed', JSON.stringify(asked));
}

// ===========================================================================
rule('5. "COULD NOT LOOK" IS NOT "EMPTY" — one source empty, the other refusing');
// ===========================================================================
// The trap this fix could have walked into: asking twice, having one source
// answer "" and the other fail, and reporting an empty pane anyway. That is
// the original defect wearing the fallback's clothes.
setPane(SHORT_PANE);
failSource('visible', true);
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 8);
  check(t.success === false, 'a refusing source makes this a FAILED read, not an empty pane', JSON.stringify(t));
  check(t.text === undefined, 'no text is claimed', JSON.stringify(t.text));
  check(typeof t.error === 'string' && /UNKNOWN rather than confirmed/.test(t.error),
    'and the error says the emptiness is unknown rather than confirmed', t.error);
}
failSource('visible', false);

// A refusing PRIMARY must not stop the fallback: the pane is readable if
// either source answers.
setPane(SHORT_PANE);
failSource('recent-unwrapped', true);
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 8);
  check(t.success === true && t.text.includes('hello-from-kan-94'),
    'a refusing PRIMARY still falls through to visible', JSON.stringify(t));
  check(t.source === 'visible', 'named as visible', `source=${t.source}`);
}
failSource('recent-unwrapped', false);

// ===========================================================================
rule('6. THE FALLBACK HONOURS THE CALLER\'S --lines');
// ===========================================================================
// `visible` ignores N, so an unbounded fallback would answer a `--lines 2`
// request with a whole screen.
setPane({ rows: 60, transcript: Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n'), composer: '' });
resetInvocations();
{
  const t = bridge.tailAgent(agentDir, 2);
  const got = (t.text ?? '').split('\n');
  check(t.source === 'visible', 'answered by the fallback', `source=${t.source}`);
  check(got.length === 2, 'and trimmed to the 2 lines that were asked for', `${got.length} lines: ${JSON.stringify(t.text)}`);
  check((t.text ?? '').includes('❯'), 'keeping the LAST lines rather than the first', JSON.stringify(t.text));
}

// ===========================================================================
rule('7. THE COMPOSITION — a spurious empty read must never become `not-delivered`');
// ===========================================================================
// Acceptance 5, and the reason this ticket is bigger than a blank window.
// DELIVERY_TAIL_LINES is 60, so a grid taller than that with content at the top
// puts the delivery read squarely inside the blank region: pre-fix, the
// baseline and confirm reads both come back "" from a pane that has the
// message on it, `readable` is true because a string arrived, `count` is 0, and
// `0 > 0` is false — so a message that LANDED is reported not-delivered, and it
// bypasses `unverifiable` entirely because the read looked successful.
setPane({ rows: 100, transcript: 'bypass permissions on\n❯ earlier work\n  still going', composer: '' });
resetInvocations();
{
  // Confirm the premise of this section rather than assuming it: at N=60 on
  // this grid, the primary source really is inside the blank region.
  const raw = spawnSync('herdr',
    ['agent', 'read', AGENT_NAME, '--source', 'recent-unwrapped', '--format', 'text', '--lines', '60'],
    { encoding: 'utf8' });
  check(JSON.parse(raw.stdout).result.read.text === '',
    'premise: at DELIVERY_TAIL_LINES=60 the primary source answers "" for this pane');

  const outcome = await bridge.sendToAgent(agentDir, 'KAN-98 does this land', {
    confirmTimeoutMs: 3000, pollMs: 250
  });
  check(outcome.verdict === 'delivered',
    'the send is DELIVERED — not `not-delivered` off a pane nobody really read',
    `verdict=${outcome.verdict} error=${outcome.error ?? ''}`);
  check(outcome.evidence.readable === true, 'readable', JSON.stringify(outcome.evidence.readable));
  check(outcome.evidence.tailSource === 'visible',
    'and the evidence NAMES the source the verdict was read from',
    `tailSource=${outcome.evidence.tailSource}`);
  check((outcome.evidence.tail ?? '').includes('KAN-98 does this land'),
    'the tail carried back actually contains the message', JSON.stringify(outcome.evidence.tail));
}

// A MESSAGE THAT REALLY DID NOT ARRIVE MUST STILL BE `not-delivered`. Without
// this, §7 could have been bought by making every send look delivered — which
// would be the same defect pointing the other way. Both Enters are swallowed,
// so the text sits UNSUBMITTED in the composer: the witnessed KAN-114 failure,
// on the same tall grid where the primary source reads blank.
setPane({ rows: 100, transcript: 'bypass permissions on\n❯ earlier work', composer: '' });
dropEnters(2);
resetInvocations();
{
  const outcome = await bridge.sendToAgent(agentDir, 'KAN-98 absent message', {
    confirmTimeoutMs: 1500, pollMs: 250
  });
  check(outcome.verdict === 'not-delivered',
    'a message that never got submitted is still NOT-DELIVERED', `verdict=${outcome.verdict}`);
  check(outcome.evidence.inComposer === true,
    'and the evidence names why — it is sitting in the composer', JSON.stringify(outcome.evidence.inComposer));
  check(outcome.evidence.tailSource === 'visible',
    'read through the fallback, which is what made it visible at all',
    `tailSource=${outcome.evidence.tailSource}`);
  check(outcome.interrupts === 1, 'exactly one Ctrl+C', `interrupts=${outcome.interrupts}`);
}
dropEnters(0);

// And the honest failure is still reachable end to end: no source readable at
// all is `unverifiable`, which is the one state in which nothing is concluded.
setPane({ rows: 100, transcript: 'bypass permissions on\n❯ earlier work', composer: '' });
failSource('recent-unwrapped', true);
failSource('visible', true);
resetInvocations();
{
  const outcome = await bridge.sendToAgent(agentDir, 'KAN-98 unreadable', {
    confirmTimeoutMs: 1200, pollMs: 250
  });
  check(outcome.verdict === 'unverifiable',
    'an unreadable pane is UNVERIFIABLE, not not-delivered', `verdict=${outcome.verdict}`);
  check(outcome.evidence.readable === false, 'and readable is false', JSON.stringify(outcome.evidence.readable));
  check(outcome.interrupts === 0,
    'and nothing was typed at an agent we could not see', `interrupts=${outcome.interrupts}`);
}
failSource('recent-unwrapped', false);
failSource('visible', false);

// ===========================================================================
console.log(`\n${failures ? 'FAILED' : 'OK'} — ${checks - failures}/${checks} checks passed`);
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failures ? 1 : 0);
