#!/usr/bin/env node
// KAN-98 — the live half: REAL herdr really does answer "" for a pane that has
// text on it, and the shipped tail no longer reports that as an empty pane.
//
// WHAT FAILURE THIS WOULD CATCH: the premise of the whole fix being false or
// having been fixed upstream — i.e. `herdr agent read --source recent-unwrapped`
// never actually returning an empty string for a live pane with visible output.
// If that were so, `verify-tail-asks-every-source.mjs` would still pass every
// section (its herdr is a shim it writes itself) and the fallback in
// `tailAgent` would be guarding a defect that does not exist. This script is
// the only thing in the repository that can tell those apart, because the reads
// here come from a herdr nobody in this process wrote.
//
// It also settles a claim the code used to make. The docblock this change
// replaced justified `recent-unwrapped` as the source that shows "the frozen
// last frame of an agent whose process died". §4 kills the pane's process and
// reads all three sources for 15 seconds afterwards.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE, AND WHAT THIS SCRIPT DOES NOT COVER.
// ---------------------------------------------------------------------------
//
//   REAL — the herdr server, its `agent read` on three sources, the terminal
//   pane and its grid geometry (asked of the shell with `tput lines`, not
//   assumed). Nothing here writes a line of pane text; §1's boundary is
//   PREDICTED from the geometry and then measured, so the rule is falsifiable
//   rather than merely observed.
//
//   NOT COVERED — the composition with `sendToAgent`. This script proves the
//   READ is wrong in the way claimed; it does not drive a live send to the
//   point of a false `not-delivered`, because that needs the primary source's
//   blank window to be at least DELIVERY_TAIL_LINES (60) rows deep, i.e. a
//   terminal window taller than 60 rows with a nearly-empty agent pane. On the
//   24-row pane measured here it cannot happen, and the boundary rule in §1 is
//   what says when it can. Who covers the composition:
//   `verify-tail-asks-every-source.mjs` §7, deterministically, on a modelled
//   100-row grid. NEITHER OF US HAS OBSERVED A FALSE `not-delivered` IN
//   PRODUCTION — that remains a mechanism derived from two measured facts, and
//   is written down here as such rather than claimed.
//
// COSTS ONE SHELL PANE for the length of the run, closed at the end (and on
// signals — an interrupted run must not leak a pane). No Claude agent, no
// tokens. Excluded from CI: no GitHub runner has a herdr server or a terminal
// pane. Registered in verify-proof-registry.mjs's EXCLUSIONS; run by hand and
// the output goes on the PR.
//
// Usage:
//   npm run build
//   node scripts/verify-tail-source-boundary-live.mjs [distDir]

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
    if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
function rule(title) { console.log(`\n${title}\n${'-'.repeat(title.length)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const herdr = (args) => {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { unparsed: r.stdout, stderr: r.stderr }; }
};
/** A raw read of one source. `{text}` when herdr answered, `{error}` when not. */
function readSource(name, source, lines) {
  const j = herdr(['agent', 'read', name, '--source', source, '--format', 'text', '--lines', String(lines)]);
  if (j?.error) return { error: j.error.code ?? 'unknown' };
  const text = j?.result?.read?.text;
  return typeof text === 'string' ? { text } : { error: 'no-read-object' };
}

if (spawnSync('herdr', ['status', 'server'], { encoding: 'utf8' }).status !== 0) {
  console.error('No herdr server is answering. This proof is about a real one; it does not shim.');
  process.exit(1);
}
const version = spawnSync('herdr', ['--version'], { encoding: 'utf8' }).stdout.trim();

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan98-live-'));
const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kan98-live-agent-')));
const AGENT_NAME = paneNameFor(agentDir);
const dataDir = path.join(scratchRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scratchRoot, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

function closePane() {
  try {
    const id = herdr(['agent', 'get', AGENT_NAME])?.result?.agent?.pane_id;
    if (id) herdr(['pane', 'close', id]);
  } catch { /* best effort */ }
}
// On signals too: Ctrl-C is the ordinary way to stop a hand-run proof, and
// `exit` does not fire for it. A leaked pane sits on somebody's board.
process.on('exit', closePane);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { closePane(); process.removeAllListeners(signal); process.kill(process.pid, signal); });
}

console.log(`KAN-98 live — herdr read sources, against a real ${version}`);
console.log(`pane: ${AGENT_NAME}`);

const started = herdr(['agent', 'start', AGENT_NAME, '--cwd', agentDir, '--no-focus', '--', 'bash', '--norc', '-i']);
if (started?.error) {
  console.error(`could not start a pane: ${JSON.stringify(started.error)}`);
  process.exit(1);
}
const paneId = started?.result?.agent?.pane_id ?? herdr(['agent', 'get', AGENT_NAME])?.result?.agent?.pane_id;
await sleep(2500);

const run = async (cmd, settle = 1500) => {
  herdr(['pane', 'send-text', paneId, cmd]);
  herdr(['pane', 'send-keys', paneId, 'Enter']);
  await sleep(settle);
};

// ===========================================================================
rule('1. THE RULE, PREDICTED THEN MEASURED — `recent` windows the last N ROWS OF THE GRID');
// ===========================================================================
// The ticket said the trigger was "some state of herdr's scrollback buffer"
// and was not reproducible on demand. It is `--lines`, and it is exact: ask
// the shell how tall the grid is, count the rows of content on it, and the
// boundary follows. Predicting it BEFORE measuring is what makes this a test
// of the rule rather than a description of one run.
await run('clear', 1000);
await run('echo KAN98-LIVE-MARKER');
const visible = readSource(AGENT_NAME, 'visible', 200);
check(!visible.error && visible.text.includes('KAN98-LIVE-MARKER'),
  'the pane HAS text on it — `visible` can see the marker', JSON.stringify(visible));

await run('echo ROWS=$(tput lines)');
const afterRows = readSource(AGENT_NAME, 'visible', 200);
const rows = Number(/ROWS=(\d+)/.exec(afterRows.text ?? '')?.[1]);
const contentRows = (afterRows.text ?? '').replace(/\n+$/, '').split('\n').length;
const predicted = rows - contentRows;
check(Number.isFinite(rows) && rows > 0, 'the shell reported the grid height', `rows=${rows}`);
console.log(`        grid rows=${rows}, content rows=${contentRows}`);
console.log(`        PREDICTION: recent-unwrapped is empty for every --lines N <= ${predicted}, and has text above it`);

let boundary = null;
for (let n = 1; n <= rows + 4 && boundary === null; n++) {
  const r = readSource(AGENT_NAME, 'recent-unwrapped', n);
  if (!r.error && r.text.length > 0) boundary = n - 1;
}
check(boundary === predicted,
  `the measured boundary is the predicted one (${predicted})`, `measured=${boundary}`);

// ===========================================================================
rule('2. THE DEFECT ITSELF — a live pane, plainly not empty, read as ""');
// ===========================================================================
// This is the ticket's own reproduction, at its own `--lines 8`.
{
  const recent8 = readSource(AGENT_NAME, 'recent-unwrapped', 8);
  const visible8 = readSource(AGENT_NAME, 'visible', 8);
  check(!recent8.error && recent8.text === '',
    'herdr `recent-unwrapped --lines 8` returns THE EMPTY STRING', JSON.stringify(recent8));
  check(!visible8.error && visible8.text.includes('ROWS='),
    'herdr `visible --lines 8`, same pane same moment, returns the text', JSON.stringify(visible8.text?.slice(0, 60)));
  check(!recent8.error, 'and it is a SUCCESSFUL read of nothing, not an error — the defect in one line');

  // `visible` is unaffected by N at all. Asserted rather than assumed: it is
  // the property the fallback rests on.
  const sizes = [1, 2, 5, 8, 20, 40, 60, 200];
  const answers = sizes.map((n) => readSource(AGENT_NAME, 'visible', n).text ?? '<err>');
  check(new Set(answers).size === 1,
    `\`visible\` answers identically at every --lines in ${JSON.stringify(sizes)}`,
    `${new Set(answers).size} distinct answers`);
}

// ===========================================================================
rule('3. THE SHIPPED FIX, against that same real pane');
// ===========================================================================
const bridge = new HerdrBridge(dataDir, configPath);
{
  const t = bridge.tailAgent(agentDir, 8);
  check(t.success === true, 'tailAgent(8) succeeds', JSON.stringify(t));
  check(typeof t.text === 'string' && t.text.includes('ROWS='),
    'AND RETURNS THE PANE TEXT — acceptance 1', JSON.stringify(t.text));
  check(t.source === 'visible', 'naming the source that answered', `source=${t.source}`);
  check(JSON.stringify(t.sourcesTried) === JSON.stringify(['recent-unwrapped', 'visible']),
    'and recording that both were asked', JSON.stringify(t.sourcesTried));

  const wide = bridge.tailAgent(agentDir, 200);
  check(wide.source === 'recent-unwrapped',
    'while a read wide enough for the primary source still uses it — a fallback, not a substitution',
    `source=${wide.source}`);
}

// ===========================================================================
rule('4. THE DEAD-AGENT CLAIM — acceptance 2, and the docblock that justified the old source');
// ===========================================================================
// The replaced comment said `recent-unwrapped` shows "the frozen last frame of
// an agent whose process died". If that is true, this change must not cost it.
// Kill the pane's process and ask all three sources for 15 seconds.
await run('clear', 800);
await run('echo KAN98-FINAL-FRAME-MARKER');
const beforeDeath = readSource(AGENT_NAME, 'visible', 200);
check(!beforeDeath.error && beforeDeath.text.includes('KAN98-FINAL-FRAME-MARKER'),
  'the frame we are about to freeze is on the pane', JSON.stringify(beforeDeath.text?.slice(0, 60)));

herdr(['pane', 'send-text', paneId, 'kill -9 $$']);
herdr(['pane', 'send-keys', paneId, 'Enter']);

let anySourceEverShowedTheFrame = false;
let everSucceededEmpty = false;
for (const t of [500, 1500, 3000, 6000, 10000, 15000]) {
  await sleep(t === 500 ? 500 : 1500);
  const line = ['visible', 'recent', 'recent-unwrapped'].map((src) => {
    const r = readSource(AGENT_NAME, src, 200);
    if (r.error) return `${src}=ERR(${r.error})`;
    if (r.text.includes('KAN98-FINAL-FRAME-MARKER')) anySourceEverShowedTheFrame = true;
    if (r.text.length === 0) everSucceededEmpty = true;
    return `${src}=len=${r.text.length}`;
  }).join('  ');
  console.log(`        t≈${String(t).padStart(5)}ms after kill: ${line}`);
}

check(!anySourceEverShowedTheFrame,
  'NO source shows the dead agent\'s final frame — herdr destroys the pane with its process, ' +
  'so the capability the old docblock claimed for `recent-unwrapped` DOES NOT EXIST ON THIS BUILD ' +
  'and this change cannot have regressed it',
  anySourceEverShowedTheFrame
    ? 'a source DID show the frame — the old docblock was right and this fix must be re-examined'
    : undefined);

// Whatever a dead pane answers, the shipped tail must not turn it into a
// confident claim about an empty agent.
{
  const t = bridge.tailAgent(agentDir, 40);
  const honest = t.success === false || (t.success === true && t.source === null && t.text === '');
  check(honest,
    'and the shipped tail answers a dead pane honestly — a failed read, or an empty one that ' +
    'says every source was asked',
    JSON.stringify(t));
  console.log(`        (a dead pane also answered a SUCCESSFUL empty read at some point: ${everSucceededEmpty})`);
}

// ===========================================================================
console.log(`\n${failures ? 'FAILED' : 'OK'} — ${checks - failures}/${checks} checks passed`);
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failures ? 1 : 0);
