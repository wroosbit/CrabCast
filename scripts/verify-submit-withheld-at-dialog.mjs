#!/usr/bin/env node
// KAN-383 — the Enter is EARNED. A send submits only what it can see it typed.
//
// WHAT FAILURE THIS WOULD CATCH: a `send_to_agent` that presses Enter at a pane
// which never took its text, so the keystroke confirms whatever that pane has
// highlighted instead of submitting a message. At a Claude Code dialog that is
// a consent answer nobody gave and which nothing distinguishes from one a human
// gave — measured against a real agent, a startup trust dialog whose highlight
// was moved to "No, exit" resolved to option 2 and `claude` exited with status
// 1, and a tool-permission dialog whose highlight was moved to "Yes, and always
// allow access to tmp/ from this project" RAN THE COMMAND and granted the
// standing permission. Before this change every send ended in an unconditional
// Enter, so both were reachable by any caller addressing an agent that happened
// to be at a prompt.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES AND WHAT THAT LEAVES UNCOVERED — read before
// trusting a green run. (The house rule from `verify-send-confirms-delivery`,
// and KAN-145's cautionary case: a proof that supplies its own input has not
// tested that the input arrives.)
// ---------------------------------------------------------------------------
//
// THE TRANSPORT IS A SHIM. `herdr` here is a fake, so nothing below is evidence
// that the real herdr behaves as modelled.
//
// THE PANE CONTENT IS NOT INVENTED. The four frames embedded below are the
// VERBATIM BYTES read off a real Claude Code through a real herdr on
// 2026-08-13, at `d4a851f`, in a scratch workspace created and closed for the
// purpose — a startup trust dialog with the highlight at option 1, the same
// dialog with the highlight moved to option 2, a tool-permission dialog, and an
// idle composer. That matters for exactly one reason: the load-bearing claim
// here is about what a REAL dialog looks like to `splitAtComposer`, and a frame
// this file drew could not have failed that way. It is why §1 can assert that a
// real dialog's highlight caret is mistaken for a composer.
//
// THE SHIM'S KEYSTROKE RESPONSES ARE CALIBRATED TO THE SAME MEASUREMENT rather
// than chosen: at a dialog `C-c` is inert (frame byte-identical at t+2s and
// t+8s, with `Down` moving the highlight immediately afterwards to prove the
// pane was listening), `send-text` is silently destroyed (echoed in NONE of
// herdr's three read sources), and `Enter` confirms the highlight.
//
//   COVERED HERE — that the submit is withheld when typed text does not appear;
//   that no `Enter` reaches the pane on that path; that `submits: 0` is what
//   says so on the wire; that an unreadable pane withholds too rather than
//   pressing blind; and — the false-positive half, which matters more than the
//   defect half — that an ordinary composer send and a bare-shell send both
//   still submit and still report `delivered`.
//
//   NOT COVERED HERE — that a real herdr destroys `send-text` at a real dialog
//   today, or that a future Claude Code still swallows it. Those are facts
//   about somebody else's software. **They are MODELLED FROM MEASUREMENT
//   RATHER THAN PROVED**, and nothing in this repository's CI tests somebody
//   else's software — so a green run here is consistent with herdr having
//   changed that behaviour this morning, and would stay green if it had.
//
//   WHO COVERS IT — the live measurement pasted on KAN-383 and in the PR body,
//   which is a real pane nobody here wrote. There is deliberately no
//   `-live.mjs` sibling: reproducing it means answering a consent dialog on a
//   real agent, which is the one thing this repository should not automate. A
//   green run of THIS file is not evidence about a real dialog.
//
// Everything under test is the real compiled code: the real `HerdrBridge`, the
// real `delivery.js` primitives, and the real verdict constructor.
//
// Usage:
//   npm run build
//   node scripts/verify-submit-withheld-at-dialog.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.resolve(scriptDir, '../dist');

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan383-'));
const fakeHome = path.join(scratchRoot, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// §5 imports a MUTATED COPY of the build out of this scratch directory, and
// `herdr.js` imports `node-pty`. Node resolves that by walking up from the
// importing file, which from /tmp finds nothing — so the mutant would fail to
// load for a reason that has nothing to do with the property under test, and a
// red drive that cannot load its mutant proves nothing at all. One symlink at
// the top of the scratch tree puts the real `node_modules` on that walk.
{
  const repoModules = path.resolve(distDir, '..', 'node_modules');
  if (fs.existsSync(repoModules)) {
    try {
      fs.symlinkSync(repoModules, path.join(scratchRoot, 'node_modules'), 'dir');
    } catch { /* a pre-existing link is fine */ }
  }
}

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

function showVerdict(label, r) {
  console.log(
    `   ${label.padEnd(24)} verdict=${String(r.verdict).padEnd(14)} ` +
    `delivered=${String(r.delivered).padEnd(6)} interrupts=${r.interrupts} submits=${r.submits} ` +
    `retried=${r.retried} readable=${r.evidence?.readable} ` +
    `landed=${r.evidence?.landedBefore}→${r.evidence?.landedAfter}`
  );
}

// ===========================================================================
// The four real frames. Captured 2026-08-13 at d4a851f; see the header.
// ===========================================================================

const TRUST_DIALOG = `Welcome to fish, the friendly interactive shell
Type help for instructions on how to use fish
…Pad-X1-Carbon-5th /t/c/-/0/s/kan383-probe  claude

────────────────────────────────────────────
 Accessing workspace:

 /tmp/claude-1001/-home-brooswit--local-sha
 re-butchr-workspaces-task-kan-383/03275d57
 -b988-4787-b249-f6e05f48ec46/scratchpad/ka
 n383-probe

 Quick safety check: Is this a project you
 created or one you trust? (Like your own
 code, a well-known open source project, or
 work from your team). If not, take a
 moment to review what's in this folder
 first.

 Claude Code'll be able to read, edit, and
 execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel`;

const TRUST_DIALOG_OPT2 = TRUST_DIALOG
  .replace(' ❯ 1. Yes, I trust this folder', '   1. Yes, I trust this folder')
  .replace('   2. No, exit', ' ❯ 2. No, exit');

const PERMISSION_DIALOG = `  else: touch
  /tmp/kan383-permission-probe.txt

● I'll run that command.

● Creating empty probe file
  ⎿  $ touch
     /tmp/kan383-permission-probe.txt

────────────────────────────────────────────
 Bash command

   touch /tmp/kan383-permission-probe.txt
   Create empty probe file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to tmp/
      from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to
 explain`;

const IDLE_COMPOSER_TRANSCRIPT = `╭─ Claude Code ────────────────────────────╮
│             Welcome back JW!             │
╰──────────────────────────────────────────╯

                           ● high · /effort
────────────────────────────────────────────`;

// ===========================================================================
// The herdr shim: a pane that has a KIND, because the whole question is what a
// pane does with keystrokes it was not expecting.
// ===========================================================================
//
//   composer   a claude pane at its input line. send-text lands in the
//              composer; Enter submits it into the transcript.
//   shell      a bare shell. send-text lands on the command line — VISIBLE,
//              with no composer marker anywhere — and Enter runs it. This is
//              the false-positive case that a composer-only test would break.
//   dialog     the measured behaviour: C-c inert, send-text DESTROYED, and
//              Enter confirms whatever is highlighted.

const shimState = path.join(scratchRoot, 'shim-state');
const shimDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.CRABCAST_KAN383_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_KAN383_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};

const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));

const paneFileFor = (name) => path.join(state, 'pane-' + Buffer.from(name).toString('hex') + '.json');
const readPane = (name) => JSON.parse(fs.readFileSync(paneFileFor(name), 'utf8'));
const writePane = (name, p) => fs.writeFileSync(paneFileFor(name), JSON.stringify(p));
const nameOfPane = (id) => (load().find((s) => s.pane_id === id) || {}).name;

/**
 * What herdr would return for this pane right now.
 *   dialog   -> the captured frame, verbatim. Typed text is NOT in it, ever.
 *   composer -> transcript, then the caret, then whatever is in the composer.
 *   shell    -> transcript, then a shell prompt line carrying the pending text.
 */
const render = (p) => {
  if (p.kind === 'dialog') return p.resolved === undefined ? p.frame : p.resolvedFrame;
  if (p.kind === 'shell') return p.transcript + '\\n$ ' + p.pending;
  return p.transcript + '\\n❯ ' + p.pending;
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
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({
    name: s.name, pane_id: s.pane_id, agent: 'claude', cwd: s.cwd, agent_status: 'working'
  })) } });
}
if (a === 'agent' && b === 'read') {
  // A herdr that stops answering PART WAY THROUGH a send: N more reads
  // succeed, then it cannot be reached. That is the state the withheld-submit
  // path has to treat as "do not press it anyway".
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
  if (name) {
    const p = readPane(name);
    // MEASURED: at a dialog the text is echoed NOWHERE AT ALL. The pane is
    // unchanged and the message is gone.
    if (p.kind !== 'dialog') { p.pending = args[3] || ''; writePane(name, p); }
  }
  out({ result: {} });
}
if (a === 'pane' && b === 'send-keys') {
  const name = nameOfPane(args[2]);
  if (name) {
    const p = readPane(name);
    if (args[3] === 'Enter') {
      if (p.kind === 'dialog') {
        // THE DEFECT, REPRODUCED: Enter confirms whatever is highlighted.
        p.resolved = p.highlighted;
        p.resolvedFrame = 'DIALOG ANSWERED: ' + p.highlighted;
      } else if (p.pending) {
        p.transcript += (p.kind === 'shell' ? '\\n$ ' : '\\n❯ ') + p.pending;
        p.pending = '';
      }
    } else if (args[3] === 'C-c') {
      // MEASURED: inert at a dialog. Elsewhere it clears a half-typed line.
      if (p.kind !== 'dialog') p.pending = '';
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
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const keysSince = (mark) =>
  invocations().slice(mark).filter((v) => v[0] === 'pane' && v[1] === 'send-keys').map((v) => v[3]);
const unreadableAfter = (n) => {
  const f = path.join(shimState, 'unreadable-after');
  if (n === null) { if (fs.existsSync(f)) fs.unlinkSync(f); return; }
  fs.writeFileSync(f, String(n));
};

// ===========================================================================
// The fixture.
// ===========================================================================

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { COMPOSER_MARKERS, visibleCount, deliveryFingerprint } =
  await import(path.join(distDir, 'delivery.js'));

const dataDir = path.join(scratchRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scratchRoot, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const agentDir = fs.mkdtempSync(path.join(scratchRoot, 'agent-'));
const AGENT_PATH = fs.realpathSync(agentDir);
const AGENT_NAME = paneNameFor(AGENT_PATH);
const paneFileFor = (name) => path.join(shimState, `pane-${Buffer.from(name).toString('hex')}.json`);
const rawPane = () => JSON.parse(fs.readFileSync(paneFileFor(AGENT_NAME), 'utf8'));

spawnSync('herdr', ['agent', 'start', AGENT_NAME, '--cwd', AGENT_PATH], { encoding: 'utf8' });

/** Put the pane into one of the three kinds before a send. */
function setPane(p) {
  fs.writeFileSync(paneFileFor(AGENT_NAME), JSON.stringify({ pending: '', ...p }));
}
const dialogPane = (frame, highlighted) => setPane({ kind: 'dialog', frame, highlighted });
const composerPane = () => setPane({ kind: 'composer', transcript: IDLE_COMPOSER_TRANSCRIPT });
const shellPane = () => setPane({ kind: 'shell', transcript: 'Welcome to fish, the friendly interactive shell' });

/** Short budgets: this is a proof, not a production wait. */
const FAST = { confirmTimeoutMs: 1200, pollMs: 150, typedTimeoutMs: 600, typedPollMs: 100 };
const send = (message, dist) => {
  const bridge = new HerdrBridge(dataDir, configPath);
  return bridge.sendToAgent(AGENT_PATH, message, FAST);
};

// ===========================================================================
rule('1. THE PREMISE — a real dialog\'s highlight caret IS a composer marker, so nothing in the existing model separates them');
// ===========================================================================
//
// This is why the fix could not be "notice you are at a dialog and stop". The
// daemon does not merely fail to recognise a dialog; it POSITIVELY IDENTIFIES
// the dialog's selected option as the input line it is about to type into.
{
  const lastMarker = (t) => COMPOSER_MARKERS.reduce((f, m) => Math.max(f, t.lastIndexOf(m)), -1);
  const lineAt = (t, i) => (i === -1 ? null : t.slice(i).split('\n')[0]);

  for (const [label, frame, expect] of [
    ['trust dialog',      TRUST_DIALOG,      '❯ 1. Yes, I trust this folder'],
    ['trust dialog opt2', TRUST_DIALOG_OPT2, '❯ 2. No, exit'],
    ['permission dialog', PERMISSION_DIALOG, '❯ 1. Yes']
  ]) {
    const at = lastMarker(frame);
    console.log(`   ${label.padEnd(20)} marker at ${String(at).padStart(4)}  -> ${JSON.stringify(lineAt(frame, at))}`);
    check(at !== -1 && lineAt(frame, at) === expect,
      `${label}: the "composer" the daemon finds is the dialog's HIGHLIGHTED OPTION`,
      `found ${JSON.stringify(lineAt(frame, at))}`);
  }

  // And the discriminator that IS available, which is about our own message
  // rather than about their UI.
  const msg = 'a message from a supervisor';
  check(visibleCount(TRUST_DIALOG, msg) === 0 && visibleCount(PERMISSION_DIALOG, msg) === 0,
    'while the message we are about to type is in NEITHER frame — which is what the guard reads');
}

// ===========================================================================
rule('2. THE DEFECT, CLOSED — at a dialog the submit is WITHHELD and no Enter reaches the pane');
// ===========================================================================

for (const [label, frame, highlighted] of [
  ['startup trust dialog',  TRUST_DIALOG,      '1. Yes, I trust this folder'],
  ['trust dialog, opt 2',   TRUST_DIALOG_OPT2, '2. No, exit'],
  ['tool-permission dialog', PERMISSION_DIALOG, '1. Yes']
]) {
  console.log(`\n   --- ${label}`);
  dialogPane(frame, highlighted);
  const mark = invocations().length;
  const r = await send('please review PR #94 when you get a moment');
  showVerdict('at a dialog:', r);

  check(r.submits === 0,
    'submits === 0 — the field a caller reads to learn the submit was withheld',
    `submits=${r.submits}`);
  check(!keysSince(mark).includes('Enter'),
    'NO Enter keystroke reached the pane at all',
    `keys=${JSON.stringify(keysSince(mark))}`);
  check(rawPane().resolved === undefined,
    'and the dialog is UNANSWERED — the pane was left exactly as it was found',
    JSON.stringify(rawPane().resolved));
  check(r.delivered === false && r.success === false,
    'the send reports itself undelivered rather than claiming a message landed');
  check(r.interrupts === 1,
    'exactly one Ctrl+C, unchanged — it is measured inert here and its shell justification stands',
    `interrupts=${r.interrupts}`);
  check(typeof r.error === 'string' && /withheld/i.test(r.error),
    'and the error SAYS the submit was withheld rather than leaving it to be inferred',
    r.error);
}

// ===========================================================================
rule('3. THE FALSE-POSITIVE CONTROL — the ordinary send path still works, on BOTH pane shapes');
// ===========================================================================
//
// A guard that refuses real sends is worse than the defect it fixes. The shell
// case is the one a composer-only test would have shipped broken: its typed
// text is visible with NO composer marker anywhere on the pane.
{
  console.log('\n   --- a claude pane at its composer');
  composerPane();
  let mark = invocations().length;
  let r = await send('section three: the ordinary path');
  showVerdict('composer:', r);
  check(r.verdict === 'delivered' && r.delivered === true, 'an ordinary composer send is DELIVERED');
  check(r.submits === 1, 'and it pressed Enter exactly once', `submits=${r.submits}`);
  check(keysSince(mark).filter((k) => k === 'Enter').length === 1,
    'one Enter reached the pane', JSON.stringify(keysSince(mark)));
  check(rawPane().transcript.includes('section three') && rawPane().pending === '',
    'and on the pane the text is in the TRANSCRIPT with nothing left pending');

  console.log('\n   --- a bare shell (no composer marker anywhere)');
  shellPane();
  mark = invocations().length;
  r = await send('section three: the shell path');
  showVerdict('shell:', r);
  check(r.verdict === 'delivered' && r.delivered === true,
    'a SHELL send is still delivered — the guard reads visibility, not the composer',
    JSON.stringify(r.evidence));
  check(r.submits === 1, 'and it pressed Enter exactly once', `submits=${r.submits}`);
  check(COMPOSER_MARKERS.every((m) => !rawPane().transcript.includes(m)),
    'with the control that makes that mean something: the shell pane has NO composer marker on it');

  // THE GUARD'S ONE REACHABLE FALSE POSITIVE, and it was introduced by the
  // guard itself. `message.trim()` is truthy for a message that OPENS with a
  // blank line, so the router accepts it — and `deliveryFingerprint` used to
  // take `split('\n')[0]`, which is the empty string for exactly that message.
  // An empty needle is never visible, so this send would have had its submit
  // withheld FOREVER: a guard refusing a real send, which is worse than the
  // defect it fixes. Kept as a section rather than a comment because it is the
  // failure mode most likely to be reintroduced by someone tidying the
  // fingerprint.
  console.log('\n   --- a message whose FIRST LINE IS BLANK (the guard\'s own false positive)');
  composerPane();
  mark = invocations().length;
  const awkward = '\n\nsection three: a message that opens with a blank line';
  check(deliveryFingerprint(awkward) !== '',
    'its fingerprint is not empty — the first line WITH CONTENT is what is looked for',
    JSON.stringify(deliveryFingerprint(awkward)));
  r = await send(awkward);
  showVerdict('blank first line:', r);
  check(r.verdict === 'delivered' && r.submits === 1,
    'and it is DELIVERED like any other message — the guard does not eat it',
    `verdict=${r.verdict} submits=${r.submits}`);
}

// ===========================================================================
rule('4. "WE COULD NOT TELL" RESOLVES TO WITHHOLDING, never to pressing it anyway');
// ===========================================================================
{
  composerPane();
  unreadableAfter(1);           // the baseline read answers; every read after it fails
  const mark = invocations().length;
  const r = await send('section four: the pane goes dark after we type');
  unreadableAfter(null);
  showVerdict('unreadable:', r);

  check(r.submits === 0, 'submits === 0 — nothing was pressed at a pane nobody could observe', `submits=${r.submits}`);
  check(!keysSince(mark).includes('Enter'), 'no Enter reached the pane', JSON.stringify(keysSince(mark)));
  check(r.verdict === 'unverifiable',
    'and it answers UNVERIFIABLE rather than not-delivered — absence of evidence, not evidence of absence',
    r.verdict);
  check(typeof r.error === 'string' && /withheld/i.test(r.error) && /composer/i.test(r.error),
    'the error names the cost too: the text may be sitting in the composer unsubmitted',
    r.error);
}

// ===========================================================================
rule('4.1 THE RECOVERY PATH — the SAME message can be sent again after a withheld submit');
// ===========================================================================
//
// The guard needs a baseline, and the obvious place to take it is the reading
// the send already does before it types. That is a DEADLOCK, and this section
// is what catches it: a withheld submit leaves our text in the composer, so
// the pre-send reading of the next attempt already contains it, the freshly
// typed copy does not raise the count, and the same message can never be sent
// to that agent again — the recovery path closed by the guard that needed it.
// The baseline is therefore taken AFTER the interrupt, which is the moment the
// composer has been cleared and before anything is typed.
{
  const message = 'section four-one: the message that gets stuck and then unstuck';

  // 1. A send that goes unreadable after typing: withheld, text left behind.
  composerPane();
  unreadableAfter(2);
  const stuck = await send(message);
  unreadableAfter(null);
  showVerdict('first attempt:', stuck);
  check(stuck.submits === 0, 'the first attempt withholds its submit', `submits=${stuck.submits}`);
  check(rawPane().pending.includes('section four-one'),
    'and leaves the text sitting in the composer — the cost, reproduced rather than asserted',
    JSON.stringify(rawPane().pending));

  // 2. The SAME message again, at a readable pane. This is what deadlocks if
  //    the baseline is taken before the interrupt.
  const mark = invocations().length;
  const retried = await send(message);
  showVerdict('same message again:', retried);
  check(retried.verdict === 'delivered' && retried.submits === 1,
    'the SAME message sent again is DELIVERED — the stuck copy did not poison the baseline',
    `verdict=${retried.verdict} submits=${retried.submits}`);
  check(keysSince(mark).filter((k) => k === 'C-c').length === 1,
    'and it took exactly one Ctrl+C to do it', JSON.stringify(keysSince(mark)));
}

// ===========================================================================
rule('5. THE RED DRIVE — remove the guard from the compiled build and watch the dialog get answered');
// ===========================================================================
//
// Everything above is a green run, and a green run proves only that the happy
// path happened. This section breaks the thing the guard guards and asserts the
// defect comes back — which is the only way to know sections 1-4 are load
// bearing rather than decorative.

const mutator = makeMutator({
  distDir,
  scratch: scratchRoot,
  report: {
    pass: (n) => check(true, n),
    fail: (n, d) => check(false, n, d)
  }
});
const mutate = mutator.mutate ?? mutator;

redDrive: {
  // Neuter the precondition: make the "did our text appear" test always say yes.
  const mutantDir = mutate(
    'guard-removed',
    'herdr.js',
    'if (reading.visible > visibleBefore)',
    'if (true)'
  );
  if (!mutantDir) break redDrive;

  // The epic's rule: a mutation is not trusted until it is asserted applied AND
  // the mutated file still parses. A mutant that does not parse fails for a
  // reason that has nothing to do with the property under test.
  const mutatedFile = path.join(mutantDir, 'herdr.js');
  let parses = true;
  let parseError = '';
  try {
    execFileSync(process.execPath, ['--check', mutatedFile], { stdio: 'pipe' });
  } catch (e) {
    parses = false;
    parseError = String(e.stderr ?? e);
  }
  check(parses, 'the mutant parses — `node --check` on the mutated build', parseError);
  check(fs.readFileSync(mutatedFile, 'utf8').includes('if (true)'),
    'and the mutation is present in the file that will be loaded');
  if (!parses) break redDrive;

  const { HerdrBridge: MutantBridge } = await import(path.join(mutantDir, 'herdr.js'));
  const mutantSend = (m) => new MutantBridge(dataDir, configPath).sendToAgent(AGENT_PATH, m, FAST);

  console.log('\n   --- the SAME trust dialog, against a build with the guard removed');
  dialogPane(TRUST_DIALOG_OPT2, '2. No, exit');
  const mark = invocations().length;
  const r = await mutantSend('please review PR #94 when you get a moment');
  showVerdict('guard removed:', r);

  const pressed = keysSince(mark).includes('Enter');
  check(pressed,
    'RED: with the guard gone the Enter goes out again',
    `keys=${JSON.stringify(keysSince(mark))}`);
  check(rawPane().resolved === '2. No, exit',
    'RED: and the dialog is ANSWERED — "No, exit", which is the keystroke that exits a real agent',
    JSON.stringify(rawPane().resolved));
  check(r.submits === 1,
    'RED: the mutant reports submits: 1, so the field genuinely tracks the keystroke',
    `submits=${r.submits}`);

  // The same assertions §2 makes, now failing — stated as a check so the
  // inversion is in the output rather than in a reader's head.
  check(pressed && rawPane().resolved !== undefined,
    'so §2 is load-bearing: its two assertions are exactly what breaks when the guard is removed');
}

// ---------------------------------------------------------------------------
// A SECOND MUTATION, because the first one does not reach §4.
//
// Removing the `visible > visibleBefore` comparison leaves §4 green, and the
// reason is worth stating rather than leaving as a happy accident: on an
// UNREADABLE pane that comparison is never evaluated at all — the reading has
// no counts to compare — so §4's property is held by a different line. A
// section whose claim survives every mutation the file makes is a section with
// no demonstrated failure mode, which is the thing this suite keeps finding in
// new costumes. So §4 gets its own red.
// ---------------------------------------------------------------------------
redDriveUnreadable: {
  const mutantDir = mutate(
    'withholding-on-unreadable-removed',
    'herdr.js',
    'return { visible: false, checks, last, error: lastError };',
    'return { visible: true, checks, last, error: lastError };'
  );
  if (!mutantDir) break redDriveUnreadable;

  const mutatedFile = path.join(mutantDir, 'herdr.js');
  let parses = true;
  let parseError = '';
  try {
    execFileSync(process.execPath, ['--check', mutatedFile], { stdio: 'pipe' });
  } catch (e) {
    parses = false;
    parseError = String(e.stderr ?? e);
  }
  check(parses, 'the second mutant parses — `node --check`', parseError);
  if (!parses) break redDriveUnreadable;

  const { HerdrBridge: MutantBridge } = await import(path.join(mutantDir, 'herdr.js'));

  composerPane();
  unreadableAfter(1);
  const mark = invocations().length;
  const r = await new MutantBridge(dataDir, configPath)
    .sendToAgent(AGENT_PATH, 'section five: unreadable, with the withholding removed', FAST);
  unreadableAfter(null);
  showVerdict('unreadable, guard off:', r);

  check(keysSince(mark).includes('Enter'),
    'RED: with the withholding removed, an unobservable pane gets the Enter anyway',
    `keys=${JSON.stringify(keysSince(mark))}`);
  check(r.submits === 1,
    'RED: and submits goes to 1 — so §4 is load-bearing too',
    `submits=${r.submits}`);
}

// ---------------------------------------------------------------------------
// A THIRD MUTATION, for §4.1. Put the baseline back where the obvious
// implementation puts it — the reading taken BEFORE the interrupt — and the
// deadlock returns: a message left in the composer by a withheld send can never
// be sent again. This is the one defect in this change that was introduced by
// the fix rather than found by it, so it gets a red of its own.
// ---------------------------------------------------------------------------
redDriveDeadlock: {
  const mutantDir = mutate(
    'baseline-taken-before-the-interrupt',
    'herdr.js',
    'const visibleBefore = afterInterrupt.readable ? afterInterrupt.visible : visibleBeforeInterrupt;',
    'const visibleBefore = visibleBeforeInterrupt;'
  );
  if (!mutantDir) break redDriveDeadlock;

  const mutatedFile = path.join(mutantDir, 'herdr.js');
  let parses = true;
  let parseError = '';
  try {
    execFileSync(process.execPath, ['--check', mutatedFile], { stdio: 'pipe' });
  } catch (e) {
    parses = false;
    parseError = String(e.stderr ?? e);
  }
  check(parses, 'the third mutant parses — `node --check`', parseError);
  if (!parses) break redDriveDeadlock;

  const { HerdrBridge: MutantBridge } = await import(path.join(mutantDir, 'herdr.js'));
  const mutantSend = (m) => new MutantBridge(dataDir, configPath).sendToAgent(AGENT_PATH, m, FAST);
  const message = 'red drive: the message that would get permanently stuck';

  composerPane();
  unreadableAfter(2);
  const stuck = await mutantSend(message);
  unreadableAfter(null);
  check(stuck.submits === 0 && rawPane().pending.includes('permanently stuck'),
    'precondition: the mutant also withholds and leaves the text in the composer',
    `submits=${stuck.submits}`);

  const retried = await mutantSend(message);
  showVerdict('deadlocked:', retried);
  check(retried.submits === 0,
    'RED: with the baseline taken before the interrupt, the SAME message can never be sent again',
    `verdict=${retried.verdict} submits=${retried.submits}`);
  check(retried.verdict !== 'delivered',
    'RED: so §4.1 is load-bearing — it is the only section that fails on this mutation',
    retried.verdict);
}

// ===========================================================================
rule('VERDICT');
// ===========================================================================

const skipped = typeof mutator.skippedMutations === 'function' ? mutator.skippedMutations() : [];
if (skipped.length) console.log(`  ${skipped.length} mutation(s) did not apply: ${skipped.join(', ')}`);
console.log(`\n  ${checks - failures}/${checks} checks passed`);
try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
if (failures) {
  console.log(`  ${failures} FAILED`);
  process.exit(1);
}
console.log('  all green');
process.exit(0);
