#!/usr/bin/env node
// KAN-375 RED DRIVE — the mutations behind verify-interrupt-at-dialog-live.mjs,
// run one at a time.
//
// WHAT FAILURE THIS WOULD CATCH: the probe passing because its assertions
// cannot fail. KAN-375 changed no behaviour, so its probe has never been run
// against a broken tree in the ordinary course of things — which makes "ALL
// PASS" exactly the reading that proves least. Each arm below breaks one thing
// the probe claims to watch and requires the named section to go red.
//
// THE THIRD ARM IS THE POINT. §2's whole result is a NEGATIVE — "one Ctrl+C
// does nothing to the dialog" — and a negative is worthless unless the
// instrument could have said otherwise. `control-is-inert` replaces the `Down`
// keystroke that proves the pane was listening with another `C-c`, and requires
// the CONTROL line to fail. That is the difference between "the dialog ignored
// the interrupt" and "nothing was reaching this pane and every check read clean
// off a dead channel", which is the failure mode this epic has hit repeatedly.
//
// THIS IS NOT A PROOF AND IT IS NOT IN THE CI ARRAY, for the reason
// kan369-red-drive.mjs gives: it is a one-off demonstration whose output belongs
// in a pull request rather than in a gate.
//
// Every arm restores the tree on the way out, including on SIGINT/SIGTERM/SIGHUP
// (not on SIGKILL — a run killed there leaves the mutation in place, which
// `git status` will show and `git checkout --` will undo).
//
// Usage:
//   node scripts/kan375-red-drive.mjs              # every arm
//   node scripts/kan375-red-drive.mjs --list
//   node scripts/kan375-red-drive.mjs --only second-interrupt

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const PROBE = path.join(scriptDir, 'verify-interrupt-at-dialog-live.mjs');
const VARIANT = path.join(scriptDir, 'kan375-variant.mjs');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Restore-on-exit. `saved` maps an absolute path to its original bytes.
// ---------------------------------------------------------------------------
const saved = new Map();
function stash(file) {
  if (!saved.has(file)) saved.set(file, fs.readFileSync(file));
}
function restoreAll() {
  for (const [file, bytes] of saved) {
    try { fs.writeFileSync(file, bytes); } catch { /* best effort */ }
  }
  saved.clear();
  try { fs.rmSync(VARIANT, { force: true }); } catch { /* best effort */ }
}
process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { restoreAll(); process.removeAllListeners(signal); process.kill(process.pid, signal); });
}
// A previous run killed mid-mutation may have left the variant behind.
fs.rmSync(VARIANT, { force: true });

/** Apply `edit` to `file`, asserting the occurrence count it was supposed to change. */
function mutate({ file, find, replace, expectBefore, expectAfter }) {
  stash(file);
  const before = fs.readFileSync(file, 'utf8');
  const countBefore = before.split(find).length - 1;
  check(countBefore === expectBefore, `mutation target found exactly ${expectBefore}×`, `found ${countBefore}`);
  if (countBefore !== expectBefore) return false;

  const after = before.replace(find, replace);
  fs.writeFileSync(file, after);
  const countAfter = fs.readFileSync(file, 'utf8').split(replace).length - 1;
  check(countAfter === expectAfter, `mutation applied, ${expectAfter}× present`, `found ${countAfter}`);
  return countAfter === expectAfter;
}

/** `node --check` for .mjs, `tsc --noEmit` for .ts — a mutation must be valid code. */
function validates(file) {
  if (file.endsWith('.mjs')) {
    const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
    check(r.status === 0, `mutated ${path.basename(file)} still parses`, r.stderr?.trim().slice(0, 200));
    return r.status === 0;
  }
  const r = spawnSync('npm', ['run', '--silent', 'typecheck'], { cwd: repoRoot, encoding: 'utf8' });
  check(r.status === 0, `mutated ${path.basename(file)} still typechecks`, r.status === 0 ? '' : 'tsc rejected it');
  return r.status === 0;
}

/** Run the probe and return {status, out}. Never throws. */
function runProbe(script, args) {
  const r = spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The line we require to have gone red, matched on its label. */
function lineFailed(out, label) {
  return out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(label));
}

// ---------------------------------------------------------------------------
const ARMS = [
  {
    name: 'second-interrupt',
    what: 'a SECOND Ctrl+C added to sendToAgent — the one thing the code comment says is fatal',
    section: '§0',
    label: `exactly one 'C-c' in src/herdr.ts`,
    run() {
      const file = path.join(repoRoot, 'src', 'herdr.ts');
      const ok = mutate({
        file,
        find: `      this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);\n`,
        replace: `      this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);\n      this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);\n`,
        expectBefore: 1,
        expectAfter: 1
      });
      if (!ok || !validates(file)) return null;
      return runProbe(PROBE, ['--static-only']);
    }
  },
  {
    // RETARGETED AFTER KAN-383 MERGED, and the retarget is itself worth reading.
    // This arm used to swap the `send-text` and its following `Enter`, which
    // were adjacent lines. KAN-383 put `confirmTyped` between them, so that
    // find matched 0 times and the arm reported "mutation could not be applied"
    // — a red that said nothing about §0. Note what that means: the drive
    // FAILED SAFE. It did not silently stop testing; it said the mutation never
    // landed, which is the whole reason `mutate()` asserts its occurrence count
    // before reading any verdict.
    //
    // The replacement isolates the ORDER assertion without touching the 'C-c'
    // COUNT that `second-interrupt` owns: the message send becomes an Enter, so
    // §0 extracts `C-c → Enter → Enter → Enter` and fails on composition while
    // the count check beside it still passes. One arm, one subject.
    name: 'message-send-lost',
    what: 'the message send replaced by an Enter — the payload never goes out and the pinned order breaks',
    section: '§0',
    label: "sendToAgent's send CALL SITES, in order",
    run() {
      const file = path.join(repoRoot, 'src', 'herdr.ts');
      const ok = mutate({
        file,
        find: `      this.runHerdr(['pane', 'send-text', paneId, message]);\n`,
        replace: `      this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);\n`,
        expectBefore: 1,
        // TWO, not three: the Enter-only retry at the end of `sendToAgent` sits
        // one nesting level out (4 spaces, not 6), so it does not match this
        // 6-space replacement string. Asserting 3 here failed loudly rather
        // than quietly, which is the point of counting at all.
        expectAfter: 2
      });
      if (!ok || !validates(file)) return null;
      return runProbe(PROBE, ['--static-only']);
    }
  },
  {
    name: 'composer-marker-gone',
    what: '`❯` removed from COMPOSER_MARKERS, retiring the collision §6 documents',
    section: '§6',
    label: '`❯` is still a composer marker',
    run() {
      const file = path.join(repoRoot, 'src', 'delivery.ts');
      const ok = mutate({
        file,
        find: `export const COMPOSER_MARKERS = ['❯', '│ >'];`,
        replace: `export const COMPOSER_MARKERS = ['│ >'];`,
        expectBefore: 1,
        expectAfter: 1
      });
      if (!ok || !validates(file)) return null;
      return runProbe(PROBE, ['--static-only']);
    }
  },
  {
    name: 'control-is-inert',
    what: "§2's `Down` control replaced by another C-c, so nothing proves the pane was listening",
    section: '§2',
    label: 'CONTROL: `Down` DOES move the highlight',
    live: true,
    run() {
      // Mutate a COPY: the probe under test must stay pristine in the tree.
      const src = fs.readFileSync(PROBE, 'utf8');
      const find = `herdr(['pane', 'send-keys', paneId, 'Down']);`;
      const countBefore = src.split(find).length - 1;
      check(countBefore === 1, 'the `Down` control appears exactly 1×', `found ${countBefore}`);
      if (countBefore !== 1) return null;
      const mutated = src.replace(find, `herdr(['pane', 'send-keys', paneId, 'C-c']);`);
      fs.writeFileSync(VARIANT, mutated);
      check(
        (fs.readFileSync(VARIANT, 'utf8').split(find).length - 1) === 0,
        'the variant no longer sends `Down`'
      );
      if (!validates(VARIANT)) return null;
      return runProbe(VARIANT, []);
    }
  }
];

// ---------------------------------------------------------------------------
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;

if (process.argv.includes('--list')) {
  for (const a of ARMS) console.log(`${a.name.padEnd(22)} ${a.section}  ${a.live ? '[live] ' : ''}${a.what}`);
  process.exit(0);
}

const selected = only ? ARMS.filter((a) => a.name === only) : ARMS;
if (only && selected.length === 0) {
  console.error(`no such arm: ${only}. --list to see them.`);
  process.exit(2);
}

for (const arm of selected) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ARM  ${arm.name}  (${arm.section}${arm.live ? ', live' : ''})`);
  console.log(`     ${arm.what}`);
  console.log('='.repeat(70));

  const result = arm.run();
  if (result === null) {
    check(false, `${arm.name}: mutation could not be applied, so nothing was driven`);
  } else {
    check(
      result.status !== 0,
      `${arm.name}: the probe exits NON-ZERO under the mutation`,
      `exit ${result.status}`
    );
    check(
      lineFailed(result.out, arm.label),
      `${arm.name}: ${arm.section} goes red BY NAME`,
      `"${arm.label}"`
    );
    // The red must come from the section we broke, not from the script falling
    // over — a stack trace would also exit non-zero and prove nothing.
    check(!/probe threw:/.test(result.out), `${arm.name}: the red is an assertion, not a crash`);
    const redLines = result.out.split('\n').filter((l) => l.startsWith('FAIL'));
    for (const l of redLines) console.log(`     | ${l}`);
  }
  restoreAll();
}

// The tree must be exactly as we found it.
const status = execFileSync('git', ['status', '--porcelain', 'src', 'scripts'], { cwd: repoRoot, encoding: 'utf8' });
const dirty = status.split('\n').filter((l) => l.trim() && !/kan375-red-drive|verify-interrupt-at-dialog-live/.test(l));
check(dirty.length === 0, 'the tree is restored — no mutation left behind', dirty.join(' ') || 'clean');

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'ALL PASS — every arm produced its red'}`);
process.exit(failures ? 1 : 0);
