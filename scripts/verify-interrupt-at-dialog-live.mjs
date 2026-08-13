#!/usr/bin/env node
// KAN-375 — what the send sequence's THREE keystrokes actually do to a pane,
// measured against a real Claude Code selection dialog rather than reasoned
// about.
//
// WHAT FAILURE THIS WOULD CATCH: the decision recorded in
// docs/send-contract.md — "the interrupt stays unconditional, because at a
// dialog it is INERT and conditioning it would close nothing" — resting on a
// premise that is false or that has changed. Concretely: a Claude Code build
// whose dialog DOES act on Ctrl+C (which would make the interrupt the hazard
// after all, and reopen the question this ticket closed), or one whose dialog
// stops acting on Enter (which would retire the hazard the decision names
// instead). Both are upstream changes in a program this repository does not
// version, so nothing static can notice either; this script is the only thing
// that can tell the recorded reasoning from a reasoning whose world moved.
//
// ---------------------------------------------------------------------------
// WHY THIS SCRIPT EXISTS AT ALL, WHICH IS NOT "TO GUARD A CHANGE"
// ---------------------------------------------------------------------------
//
// KAN-375 changed no behaviour. That makes this proof unusual and worth being
// explicit about: it is not a regression guard on code we wrote, it is the
// EVIDENCE FOR A DECISION NOT TO WRITE ANY. A recorded "leave it as it is" is
// only as good as the measurement under it, and a measurement nobody can re-run
// decays into a claim. This is the re-run.
//
// It is therefore expected to be run when the decision is QUESTIONED, not on
// every change to herdr.ts — see the EXCLUSIONS entry for that boundary.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE, AND WHAT THIS SCRIPT DOES NOT COVER
// ---------------------------------------------------------------------------
//
//   REAL — the herdr server, real terminal panes, and a real `claude` process
//   sitting at its real startup dialog. Nothing here is shimmed. The three
//   keystrokes are issued by the same `herdr pane send-keys` / `send-text`
//   calls `sendToAgent` issues, in the same order, with the same settle.
//
//   THIS SCRIPT SUPPLIES ITS OWN KEYSTROKES — it drives herdr directly rather
//   than calling `HerdrBridge.sendToAgent`, so it proves what the KEYSTROKES do
//   to a dialog and NOT that sendToAgent emits exactly those three. Those are
//   different claims and this one does not cover the second. Who covers it:
//   the occurrence-count assertion in §0 below, which reads src/herdr.ts as
//   text and fails if the sequence there stops being one C-c, one send-text and
//   one Enter. That is a static check standing in for a composition nobody
//   drives end to end, and it is named here rather than left to be assumed.
//
//   NOT COVERED — any dialog other than the startup trust dialog. The
//   permission dialog, `AskUserQuestion`, and the `/effort` picker are all the
//   same widget family and are expected to behave identically, but "expected"
//   is the word doing the work and this script measures none of them. KAN-377
//   (Butchr's) is the ticket where a non-startup dialog was seen behaving this
//   way in production.
//
//   NOT COVERED — what a Ctrl+C does to a pane running a TOOL CALL rather than
//   sitting at a dialog. That is the case the interrupt is usually discussed
//   in, it is measured in the extraction source's KAN-219, and nothing here
//   touches it.
//
// COSTS one herdr workspace and TWO short `claude` sessions (a handful of
// tokens: one message is sent, in §5). Both panes are closed at the end and on
// signals — an interrupted run must not leak a pane or a live agent. It uses
// the REAL $HOME deliberately, unlike the CI proofs: `claude` needs the user's
// own credentials to start at all, and a scratch HOME would measure a login
// prompt rather than a trust dialog.
//
// Excluded from CI: no GitHub runner has a herdr server, a terminal pane, or a
// `claude` that can authenticate. Registered in verify-proof-registry.mjs's
// EXCLUSIONS; run by hand and the output goes on the PR.
//
// WHICH SECTIONS READ SOURCE AND WHICH DRIVE A PANE — stated because a mixed
// script's EXIT CODE is a blend, and reading the blend instead of the section is
// a known way to credit the wrong mechanism. §0 and §6 read `src/*.ts` as TEXT
// and touch nothing else: they need no herdr, no claude and no build, and their
// verdict is about the working tree in front of you. §1–§5 drive real panes.
// `--static-only` runs the first kind alone.
//
// Usage:
//   node scripts/verify-interrupt-at-dialog-live.mjs
//   node scripts/verify-interrupt-at-dialog-live.mjs --static-only   # §0 and §6

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function note(msg) { console.log(`      ${msg}`); }
function section(title) { console.log(`\n=== ${title} ===`); }

/**
 * herdr, spoken to exactly as HerdrBridge speaks to it.
 *
 * `send-text` and `send-keys` print NOTHING on success — zero bytes, exit 0 —
 * while `workspace create` and `pane read` answer JSON. Parsing unconditionally
 * turns a perfectly good keystroke into `Unexpected end of JSON input`, so an
 * empty body is returned as null rather than thrown over.
 */
function herdr(args) {
  const out = execFileSync('herdr', args, { encoding: 'utf8', timeout: 30_000 });
  return out.trim() ? JSON.parse(out) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The settle between the interrupt and the text, read out of the source rather
 * than copied, so this script cannot drift from the thing it is measuring.
 */
function interruptSettleMs() {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'herdr.ts'), 'utf8');
  const m = src.match(/const INTERRUPT_SETTLE_MS\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 100;
}

// ---------------------------------------------------------------------------
// Workspace lifecycle. Closed on exit AND on signals: a leaked pane here is a
// leaked `claude` process holding a model connection, which is worse than a
// leaked shell.
// ---------------------------------------------------------------------------
const openWorkspaces = new Set();
function closeAll() {
  for (const id of [...openWorkspaces]) {
    try { herdr(['workspace', 'close', id]); } catch { /* best effort on the way out */ }
    openWorkspaces.delete(id);
  }
}
process.on('exit', closeAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { closeAll(); process.removeAllListeners(signal); process.kill(process.pid, signal); });
}

function newPane(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan375-'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe fixture for KAN-375\n');
  const res = herdr(['workspace', 'create', '--cwd', dir, '--label', label, '--no-focus']).result;
  openWorkspaces.add(res.workspace.workspace_id);
  return { paneId: res.root_pane.pane_id, workspaceId: res.workspace.workspace_id, dir };
}

/**
 * `herdr pane read` answers RAW TEXT on stdout, not the JSON envelope the
 * `workspace`/`agent` subcommands use — so this deliberately does not go
 * through `herdr()` above. (HerdrBridge reads panes with `agent read`, which
 * does answer JSON; the two subcommands are not interchangeable, and assuming
 * they were is what made every section of the first run of this script fail.)
 *
 * Returns null only when the read itself failed, so "could not look" stays
 * distinguishable from "looked, and it was empty" — the same split
 * readDeliveryEvidence keeps.
 */
function readPane(paneId, lines = 40) {
  try {
    return execFileSync(
      'herdr',
      ['pane', 'read', paneId, '--source', 'visible', '--format', 'text', '--lines', String(lines)],
      { encoding: 'utf8', timeout: 30_000 }
    );
  } catch {
    return null;
  }
}

/** Wait until a freshly created pane has a shell on it and is accepting input. */
async function waitForShell(paneId) {
  return waitFor(paneId, (t) => t.trim().length > 0, 30_000, 'a shell prompt');
}

/** Poll until `pred` holds on the pane text, or give up. Returns the text or null. */
async function waitFor(paneId, pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let text = null;
  while (Date.now() < deadline) {
    text = readPane(paneId);
    if (text !== null && pred(text)) return text;
    await sleep(500);
  }
  note(`gave up waiting for ${what} after ${timeoutMs}ms`);
  return null;
}

const DIALOG_MARK = 'Quick safety check';
const hasDialog = (t) => t.includes(DIALOG_MARK);

/**
 * Which option the dialog cursor is on, by the `❯` that precedes it. Returns a
 * number, or null when no numbered option is marked.
 *
 * NOTE that `❯` is ALSO COMPOSER_MARKERS[0] in src/delivery.ts. That collision
 * is not incidental to this ticket — it is why "read the pane and skip the
 * interrupt if a dialog is up" is not the cheap change it looks like, and §6
 * asserts the collision still exists so the docs claim stays true.
 */
function highlighted(text) {
  const m = text.match(/❯\s*(\d+)\./);
  return m ? Number(m[1]) : null;
}

/** Launch claude in a pane and wait for its startup dialog. */
async function launchClaudeToDialog(paneId) {
  await waitForShell(paneId);
  herdr(['pane', 'send-text', paneId, 'claude']);
  herdr(['pane', 'send-keys', paneId, 'Enter']);
  return waitFor(paneId, hasDialog, 60_000, 'the startup dialog');
}

const SETTLE = interruptSettleMs();
const STATIC_ONLY = process.argv.includes('--static-only');

// ===========================================================================
async function main() {
  console.log(`INTERRUPT_SETTLE_MS read from src/herdr.ts = ${SETTLE}`);
  if (STATIC_ONLY) console.log('MODE: --static-only — §0 and §6 only; no pane is driven.');

  // -------------------------------------------------------------------------
  section('§0  the sequence this script measures is still the sequence the code sends');
  // -------------------------------------------------------------------------
  // This script drives herdr itself, so without this section it would keep
  // passing after sendToAgent stopped sending what it measures. Exact counts,
  // because "contains" would survive a second interrupt being added.
  //
  // ⚠ THIS SECTION IS EXPECTED TO GO RED WHEN KAN-383 LANDS, AND THAT IS THE
  // PIN WORKING RATHER THAN A DEFECT. KAN-383 makes the submit conditional —
  // the pane is read between `send-text` and `Enter`, and the Enter is issued
  // only when our own text is visible — so the flat four-call sequence asserted
  // below stops being what `sendToAgent` emits. Whichever of the two lands
  // second updates this assertion to the new sequence; it must not be loosened
  // into a "contains" check, because the whole value of §0 is that it cannot be
  // satisfied by a sequence nobody chose. This script is excluded from CI, so
  // the red arrives on a hand-run rather than on anybody's required check.
  {
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'herdr.ts'), 'utf8');
    const cCount = (src.match(/'C-c'/g) ?? []).length;
    check(cCount === 1, `exactly one 'C-c' in src/herdr.ts`, `found ${cCount}`);

    const send = src.slice(src.indexOf('public async sendToAgent'));
    const body = send.slice(0, send.indexOf('\n  private async confirmDelivery'));
    const seq = [...body.matchAll(/send-(keys|text)', paneId(?:, '([^']+)')?/g)]
      .map((m) => (m[1] === 'text' ? 'TEXT' : m[2]));
    // C-c, message, Enter — then the Enter-only retry, which is the 4th.
    check(
      seq.length === 4 && seq[0] === 'C-c' && seq[1] === 'TEXT' && seq[2] === 'Enter' && seq[3] === 'Enter',
      'sendToAgent still issues C-c, text, Enter (+ the Enter-only retry)',
      seq.join(' → ')
    );
  }

  if (STATIC_ONLY) { sectionSix(); return; }

  // -------------------------------------------------------------------------
  section('§1  the interrupt EARNS ITS PLACE: it clears a half-typed line');
  // -------------------------------------------------------------------------
  // The justification the code comment gives, tested rather than trusted. If
  // this section ever fails, the decision to keep the interrupt loses its
  // positive argument and the ticket should be reopened.
  {
    const { paneId } = newPane('kan375-shell');
    check((await waitForShell(paneId)) !== null, 'the scratch pane has a shell on it');
    const poison = 'echo KAN375_SHOULD_NEVER_RUN';
    herdr(['pane', 'send-text', paneId, poison]);
    await sleep(1500);

    const before = readPane(paneId) ?? '';
    // The control that makes the next assertion able to fail: if the text were
    // never on the pane, "it is gone afterwards" would pass for free.
    check(before.includes('KAN375_SHOULD_NEVER_RUN'), 'CONTROL: the half-typed line is on the pane before the interrupt');

    herdr(['pane', 'send-keys', paneId, 'C-c']);
    await sleep(1500);
    const after = readPane(paneId) ?? '';

    check(/\^C/.test(after), 'one Ctrl+C is acted on by the shell (^C echoed)');
    // The ECHOED COMMAND stays on screen as `echo KAN375_…^C`; what must be
    // absent is its OUTPUT, which would be the bare word on a line of its own.
    check(!/^\s*KAN375_SHOULD_NEVER_RUN\s*$/m.test(after), 'the half-typed command did not run');
    note('so the interrupt has a real, measured benefit on a shell pane.');
  }

  // -------------------------------------------------------------------------
  section('§2  the interrupt at a startup dialog: INERT — with a control that can fail');
  // -------------------------------------------------------------------------
  let dialogPane = null;
  {
    const { paneId } = newPane('kan375-dialog-a');
    dialogPane = paneId;
    const at = await launchClaudeToDialog(paneId);
    check(at !== null, 'a real Claude Code startup dialog is up');
    if (at === null) return;

    const selBefore = highlighted(at);
    check(selBefore === 1, 'the dialog opens with option 1 highlighted', `option ${selBefore}`);

    herdr(['pane', 'send-keys', paneId, 'C-c']);
    await sleep(2000);
    const afterC = readPane(paneId) ?? '';
    check(hasDialog(afterC), 'ONE Ctrl+C does NOT dismiss the dialog');
    check(highlighted(afterC) === selBefore, 'ONE Ctrl+C does NOT move the highlight', `option ${highlighted(afterC)}`);

    // THE CONTROL. Without it, "the dialog ignored Ctrl+C" is indistinguishable
    // from "no keystroke reached this pane at all", and the whole decision
    // would rest on a counter that reads clean off a dead channel.
    herdr(['pane', 'send-keys', paneId, 'Down']);
    await sleep(2000);
    const afterDown = readPane(paneId) ?? '';
    check(
      highlighted(afterDown) === 2,
      'CONTROL: `Down` DOES move the highlight, so keystrokes were arriving',
      `option ${highlighted(afterDown)}`
    );
    note('the dialog is therefore genuinely indifferent to Ctrl+C, not unreachable.');
  }

  // -------------------------------------------------------------------------
  section('§3  the message text at a dialog: SILENTLY DESTROYED');
  // -------------------------------------------------------------------------
  {
    const msg = 'KAN375_PROBE_PAYLOAD_should_be_nowhere';
    herdr(['pane', 'send-text', dialogPane, msg]);
    await sleep(2000);
    const after = readPane(dialogPane) ?? '';
    check(hasDialog(after), 'the dialog is still up after send-text');
    check(!after.includes('KAN375_PROBE_PAYLOAD'), 'the message is echoed NOWHERE on the pane');
    check(highlighted(after) === 2, 'the message did not move the highlight', `option ${highlighted(after)}`);
    note('a caller sending here loses its message with no verdict able to say so.');
  }

  // -------------------------------------------------------------------------
  section('§4a  Enter RESOLVES the dialog — to the HIGHLIGHTED option, not to option 1');
  // -------------------------------------------------------------------------
  // The discriminator. The highlight was deliberately moved to 2 in §2, and
  // option 2 is "No, exit" — neither the default position nor the conservative
  // answer. If Enter resolves to 2 here, the mechanism is "confirm whatever is
  // highlighted", which is what KAN-203's specimen could not establish.
  {
    // NOT gated on the dialog text disappearing, and that is a measured
    // correction rather than a style choice. `claude` does not take an
    // alternate screen buffer here, so when it EXITS its dialog stays painted
    // on the visible pane with the shell prompt drawn underneath it. Waiting
    // for "Quick safety check" to vanish therefore times out on precisely the
    // outcome this section exists to detect — the exit — while passing on the
    // outcome it is trying to rule out. §4b can use the redraw; this cannot.
    herdr(['pane', 'send-keys', dialogPane, 'Enter']);
    await sleep(4000);
    const after = readPane(dialogPane) ?? '';
    check(!after.includes('? for shortcuts'), 'claude did NOT proceed into its UI — so option 1 was not taken');

    // Running a command proves a SHELL is there, which is only true if `claude`
    // really exited — i.e. if option 2 really was confirmed.
    herdr(['pane', 'send-text', dialogPane, 'echo KAN375_BACK_AT_SHELL']);
    herdr(['pane', 'send-keys', dialogPane, 'Enter']);
    const shell = await waitFor(
      dialogPane,
      (t) => /^\s*KAN375_BACK_AT_SHELL\s*$/m.test(t),
      20_000,
      'a shell to answer'
    );
    check(shell !== null, 'Enter resolved it to option 2 ("No, exit") — claude exited, a shell answers');
    note('MECHANISM: Enter confirms the HIGHLIGHTED option. Not "option 1", and not the interrupt.');
  }

  // -------------------------------------------------------------------------
  section('§4b  the same, with the highlight left at its default: resolves to option 1');
  // -------------------------------------------------------------------------
  // A fresh directory, because Claude Code remembers a folder it has been told
  // to trust and would not show the dialog twice in the same one.
  let livePane = null;
  {
    const { paneId } = newPane('kan375-dialog-b');
    livePane = paneId;
    const at = await launchClaudeToDialog(paneId);
    check(at !== null, 'a second startup dialog is up, in a fresh directory');
    if (at === null) return;
    check(highlighted(at) === 1, 'highlight is at its default, option 1', `option ${highlighted(at)}`);

    // The full sequence this time, in sendToAgent's order and with its settle.
    herdr(['pane', 'send-keys', paneId, 'C-c']);
    await sleep(SETTLE);
    herdr(['pane', 'send-text', paneId, 'KAN375 ordinary message into a dialog']);
    herdr(['pane', 'send-keys', paneId, 'Enter']);

    const settled = await waitFor(paneId, (t) => !hasDialog(t), 30_000, 'the dialog to resolve');
    check(settled !== null, 'the complete send sequence resolves the dialog');
    if (settled !== null) {
      // Claude Code's own chrome, which only exists past the trust gate. The
      // shell has no such line, so this separates "option 1 was confirmed" from
      // "claude exited" rather than merely from "the dialog redrew".
      const ui = await waitFor(paneId, (t) => t.includes('? for shortcuts'), 20_000, "claude's UI");
      check(ui !== null, 'it resolved to option 1 ("Yes, I trust this folder") — claude proceeded into its UI');
      note('two runs, two different options, one mechanism: the highlight decides. KAN-377 reproduced.');
    }
  }

  // -------------------------------------------------------------------------
  section('§5  FALSE-POSITIVE CONTROL: the ordinary send path still delivers');
  // -------------------------------------------------------------------------
  // A decision to leave the interrupt in place is worthless if the ordinary
  // path was broken all along. This is the demonstration the ticket asks for.
  {
    await sleep(3000);
    const marker = 'KAN375ORDINARY delivery check';
    herdr(['pane', 'send-keys', livePane, 'C-c']);
    await sleep(SETTLE);
    herdr(['pane', 'send-text', livePane, marker]);
    herdr(['pane', 'send-keys', livePane, 'Enter']);

    const landed = await waitFor(livePane, (t) => t.includes('KAN375ORDINARY'), 30_000, 'the message to land');
    check(landed !== null, 'the ordinary send sequence delivers at a normal prompt');
    if (landed !== null) note('so nothing measured here is an argument against the interrupt itself.');
  }

  sectionSix();
}

// ---------------------------------------------------------------------------
function sectionSix() {
  // -------------------------------------------------------------------------
  section('§6  the `❯` collision that makes "just read the pane" expensive');
  // -------------------------------------------------------------------------
  // docs/send-contract.md states that a dialog cannot be told from a composer
  // by the composer marker. That is a claim about our own source, so it is
  // asserted rather than described.
  {
    const delivery = fs.readFileSync(path.join(repoRoot, 'src', 'delivery.ts'), 'utf8');
    const m = delivery.match(/COMPOSER_MARKERS\s*=\s*\[([^\]]*)\]/);
    check(m !== null, 'COMPOSER_MARKERS is still where the docs say it is');
    if (m) {
      check(
        m[1].includes('❯'),
        '`❯` is still a composer marker — the same glyph the dialog uses for its cursor',
        m[1].trim()
      );
      note('so splitAtComposer reads a dialog cursor as a composer. See docs/send-contract.md.');
    }
  }
}


main()
  .catch((e) => { console.error('\nprobe threw:', e?.stack ?? e); failures += 1; })
  .finally(() => {
    closeAll();
    console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'ALL PASS'}`);
    process.exit(failures ? 1 : 0);
  });
