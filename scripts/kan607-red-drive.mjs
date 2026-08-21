#!/usr/bin/env node
// KAN-607 RED DRIVE — does verify-install-doc-matches-cli.mjs go red, ONE
// ASSERTION AT A TIME, and does it go red FROM BOTH SIDES OF EVERY JOIN?
//
// WHAT FAILURE THIS WOULD CATCH: a document checker that reports every page
// honest whatever the tree says. Four of its five sections are text compared to
// a parse, which is the shape that passes forever if either half is subtly
// wrong — and its output is identical either way. AC2 of KAN-607 asks for
// exactly this and says why: a proof that has only ever passed is evidence of
// nothing, and A SINGLE RED FOR THE WHOLE SCRIPT DOES NOT SATISFY IT. So every
// arm below breaks ONE claim and requires ONE NAMED assertion to go red, with
// the assertions that should NOT have moved checked as still passing.
//
// ⚠ THE ARMS THAT DECIDE WHETHER THE CHECK IS WORTH HAVING ARE 5, 8 AND 12, and
// they are worth naming before the code. Every other arm edits a document and
// watches a document checker complain, which a hard-coded list of today's
// answers would also do. These three DO NOT TOUCH A DOCUMENT AT ALL:
//
//   arm 5   a command is added to `COMMANDS` — both published lists are now
//           short, and not one character of prose changed.
//   arm 8   `EXIT.CONFIG` is renumbered — every `4` on the page is now wrong,
//           and not one character of prose changed.
//   arm 12  a code is added to `EXIT` — THIS IS KAN-528 REPLAYED. It is the
//           drift that really happened and went unnoticed until somebody read
//           two documents while writing a third.
//
// If those three do not go red, the sections they drive are lists of today's
// answers wearing a join, and the header of the file they test is wrong.
//
// ⚠ ARM 0 IS THE CONTROL AND ARMS 14 AND 16 ARE THE FALSE-POSITIVE CONTROLS. Without
// the first, a broken staging layout would redden every arm and read as sixteen
// successes. Without the other two, a check that reddened on ANY edit would pass
// every arm here and be worthless — arm 14 reorders a published list and arm 16
// moves every line on the page, and both must stay GREEN.
//
// ⚠ THE WORKING TREE IS NEVER TOUCHED. Every arm runs against a COPY, in a temp
// directory laid out in the same shape so the proof's `..`-relative paths
// resolve. That is stronger than mutate-then-restore: an interrupted run cannot
// leave the repository holding a falsified document, because there is nothing
// to restore. The last section asserts byte-identity anyway, because "I did not
// intend to write to the tree" is a claim and not a measurement.
//
// EVERY MUTATION'S ANCHOR IS REQUIRED TO OCCUR EXACTLY ONCE. An anchor matching
// zero times applies nothing, and the arm then reads as a guard that failed to
// bite; an anchor matching twice mutates more than the arm describes, and the
// red that follows is not the red the arm claims. Both render as a well-formed
// answer to a question nobody asked, and the second is the comfortable
// direction.
//
// `node_modules` is SYMLINKED rather than copied: the proof imports the
// TypeScript parser, and copying a dependency tree per arm would make this
// drive cost more than the suite it defends.
//
// AND IT TEARS DOWN ON A SIGNAL — see `staged` below for what that means here
// and, just as much, what it does not: this drive starts no daemon, and the
// thing an interrupt really leaked was a staged copy of the tree.
//
// Exits non-zero if any arm behaves differently. No daemon, no herdr, no
// network, no build.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');

const PROOF = path.join('scripts', 'verify-install-doc-matches-cli.mjs');
const SETUP = path.join('docs', 'SETUP.md');
const README = 'README.md';
const CLI = path.join('src', 'cli.ts');

const STAGED_DIRS = ['docs', 'scripts', 'src'];
const STAGED_FILES = [README];

/** Files this drive mutates, and therefore must prove it did not mutate here. */
const WITNESSED = [PROOF, SETUP, README, CLI];

let failures = 0;

const before = Object.fromEntries(
  WITNESSED.map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')])
);

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * Staged copies that exist right now, so a signal can remove them.
 *
 * ⚠ WHAT THIS TEARS DOWN IS TEMP DIRECTORIES, AND SAYING SO IS THE POINT. This
 * drive starts NO DAEMON — the proof it runs reads three files and opens no
 * socket — so there is nothing daemon-shaped here for a handler to stop, and a
 * handler written as though there were would be an artifact whose sentence
 * claims more than its mechanism covers, which is the class this whole suite
 * exists against. What it DOES leak is real and was measured before this was
 * written: `arm()` cleans up in a `finally`, and a SIGINT does not run one, so
 * an interrupted run left a full staged copy of `docs/`, `scripts/` and `src/`
 * behind. Driven red at TMPDIR=<scratch>: 0 staged dirs before, 1 surviving
 * after a mid-run SIGINT.
 *
 * `verify-proof-teardown-sweeps` §4 flags this file because its predicate errs
 * toward including — `mkdtempSync` plus `spawnSync(process.execPath, …*.mjs)`
 * is how a drive usually causes daemons it never names. The predicate is right
 * about the shape; this handler is the honest answer to it rather than a
 * register line, and it fixes a leak that was genuinely there.
 */
const staged = new Set();

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan607-'));
  staged.add(dir);
  for (const d of STAGED_DIRS) {
    fs.cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  }
  for (const f of STAGED_FILES) {
    fs.cpSync(path.join(repoRoot, f), path.join(dir, f));
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

function discard(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  staged.delete(dir);
}

// The signal path. Removes what the happy path would have removed, reports how
// many rather than claiming silently, and leaves by the signal's own convention
// (128 + n) so a caller can still tell it was interrupted.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    const n = staged.size;
    for (const dir of [...staged]) {
      try {
        discard(dir);
      } catch {
        // Reported below as a survivor rather than swallowed: a teardown that
        // hides its own failure is the shape this suite is about.
      }
    }
    console.log(`\n${signal}: removed ${n - staged.size} of ${n} staged cop(ies); this drive starts no daemon.`);
    process.exit(code);
  });
}

function runProof(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, PROOF)], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Replace a LITERAL anchor that must occur EXACTLY ONCE in the staged file.
 * Loudly refuses at any other count — see the header.
 */
function editOnce(dir, rel, anchor, replacement) {
  const p = path.join(dir, rel);
  const text = fs.readFileSync(p, 'utf8');
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    console.log(`  FAIL  the mutation anchor occurs ${count}x in ${rel}, expected exactly 1`);
    console.log(`        anchor: ${JSON.stringify(anchor.slice(0, 76))}`);
    console.log('        The arm did NOT run as described. This is a broken arm, not a finding.');
    failures += 1;
    return false;
  }
  fs.writeFileSync(p, text.replace(anchor, replacement));
  return true;
}

/** `PASS  <label>` / `FAIL  <label>` for one assertion, as the proof prints it. */
const passed = (out, re) => new RegExp(`PASS {2}${re.source ?? re}`).test(out);
const failed = (out, re) => new RegExp(`FAIL {2}${re.source ?? re}`).test(out);

/**
 * One arm: stage, mutate, run, judge.
 *
 * ⚠ ASYNC FOR ONE REASON, AND IT IS NOT STYLE: it is what makes the signal
 * handler above able to run at all. Node services a signal on the event loop,
 * and this drive was a single synchronous block — every `cpSync`, `spawnSync`
 * and `rmSync` in one top-level run — so a handler installed on it could not be
 * reached until the script had finished, by which point there was nothing left
 * to tear down.
 *
 * MEASURED, because "the handler cannot run" is exactly the kind of claim that
 * should not be taken on reasoning. SIGINT at 5s of a 16s run, one variable
 * changed:
 *
 *   handler installed, arms synchronous  -> 115 lines (RAN TO COMPLETION),
 *                                           handler line never printed, 0 staged
 *                                           dirs left — the interrupt was
 *                                           SWALLOWED, not handled.
 *   handler absent,    arms synchronous  ->  37 lines (stopped mid-run),
 *                                           1 staged dir left — the leak.
 *
 * So the synchronous version had a handler that satisfied the text check in
 * `verify-proof-teardown-sweeps` while being unable to fire: an artifact whose
 * sentence claims more than its mechanism covers, which is the one thing this
 * suite exists to prevent. The `await` below is what closes that gap.
 *
 * WHAT IT STILL DOES NOT PROMISE: an arm is itself synchronous, so an interrupt
 * arriving inside one is serviced at the NEXT ARM BOUNDARY rather than at once.
 * That wait is bounded by one arm — under a second — and it is a delay, not a
 * leak.
 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function arm(title, mutate, judge) {
  await tick();
  console.log(`\n${title}`);
  const dir = stage();
  try {
    // ⚠ THE SECOND YIELD IS WHAT MAKES THE HANDLER'S CLEANUP REAL RATHER THAN
    // DECORATIVE, and it was added after measuring that the first one alone was
    // not enough. With only the yield above, a signal is serviced at the START
    // of the next arm — by which point the in-flight arm's `finally` has
    // already run, so the handler always found an EMPTY set and reported
    // `removed 0 of 0` at every one of five interrupt timings. It stopped the
    // run, which is worth having, but its cleanup loop could never execute:
    // a mechanism whose sentence claims more than it covers, one level down
    // from the one this drive was written to catch.
    //
    // This yield adds a service point where a staged directory IS live and the
    // ordinary path has not yet reclaimed it. MEASURED over 16 interrupt
    // offsets at 0.1s steps: 15 reported `removed 0 of 0` and one reported
    // `removed 1 of 1` — the loop is reachable and does the work, and it is
    // reached about as often as staging's share of an arm, the rest of which is
    // the `spawnSync` running the proof. Every one of the 16 left ZERO staged
    // copies behind, which is the guarantee that actually matters; the removal
    // path is the backstop for the staging window, not the common case.
    await tick();
    if (mutate(dir) !== false) judge(runProof(dir));
  } finally {
    discard(dir);
  }
}

// ---------------------------------------------------------------- anchors
const SETUP_LIST_BLOCK = '```bash\ncrabcast list\n```';
const SETUP_NO_SPAWN = '`list`, `status`, `tail`, `capacity` and `daemon-status` all exit `3` rather than';
const SETUP_PASTED_SPAWNERS = '\n  configure, activate, deactivate, forget, send\n';
const SETUP_RETIRED_EXIT = 'it to in this file.\nEXIT=4';
// ⚠ RE-ANCHORED AFTER KAN-618 (#140) REWROTE §5.4. The old anchor — §5.4's
// driven note, `> \`EXIT=0\` against a scratch daemon.` — no longer exists, and
// `editOnce` said so by name rather than mutating nothing and letting the arm
// read as a guard that failed to bite. This is §10's bullet, which carries the
// claim the register entry `against a scratch daemon` now binds to.
const SETUP_ROUNDTRIP_EXIT = 'all `EXIT=0` against a scratch daemon.';
const README_OVERSIZE = " · `5` the answer would not fit the socket's framing";
const README_SPAWNERS_2 = '**Which commands start a daemon:** `configure`, `activate`,';

const CLI_TAIL_NAME = "    name: 'tail',\n";
const CLI_TAIL_SPAWN = "max 200)' }\n    ],\n    spawnsDaemon: false,";
const CLI_CONFIG_CODE = '  CONFIG: 4,';
const CLI_OVERSIZE_CODE = '  OVERSIZE: 5\n} as const;';
const CLI_COMMANDS_END = '\n];\n\nexport function commandNamed';

const NEW_COMMAND = `,
  {
    name: 'quiesce',
    action: 'quiesce_fleet',
    responseAction: null,
    summary: 'a command KAN-607\\'s red drive invented',
    positionals: [],
    flags: [],
    spawnsDaemon: false,
    build: () => ({}),
    render: () => ''
  }
];

export function commandNamed`;

// ================================================================== arm 0
await arm(
  'arm 0   CONTROL — unmutated staged copy',
  () => true,
  ({ code, out }) => {
    check(code === 0, 'the proof exits 0 on an unmutated tree', `exit ${code}`);
    check(/ALL CHECKS PASSED/.test(out), 'and says so in its verdict line');
    check(!/^FAIL/m.test(out), 'and prints no FAIL of any kind');
    check(
      /EXIT {13}OK=0 REFUSED=1 USAGE=2 TRANSPORT=3 CONFIG=4 OVERSIZE=5/.test(out),
      'and read the CLI\'s six exit codes off src/cli.ts'
    );
  }
);

// ================================================================== arm 1
// §1, document side. The page types a verb the table has never had.
await arm(
  'arm 1   §1  THE PAGE TYPES A VERB THAT DOES NOT EXIST — `crabcast list` -> `crabcast lists`',
  (dir) => editOnce(dir, SETUP, SETUP_LIST_BLOCK, '```bash\ncrabcast lists\n```'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /every verb docs\/SETUP\.md types is in COMMANDS/),
      'and names §1 on SETUP.md as the assertion that failed'
    );
    check(/`crabcast lists`/.test(out), 'and quotes the verb it could not find');
    check(
      passed(out, /every verb README\.md types is in COMMANDS/),
      'and README.md\'s §1 is untouched — the failure is scoped to the page that moved'
    );
    check(
      passed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that do not/),
      'and §2 does not move: a fenced invocation is not the published split'
    );
  }
);

// ================================================================== arm 2
// §1, CLI side. The table renames a verb the README still types.
await arm(
  'arm 2   §1  THE CLI RENAMES A VERB, DOCUMENTS UNTOUCHED — `tail` -> `tailx`',
  (dir) => editOnce(dir, CLI, CLI_TAIL_NAME, "    name: 'tailx',\n"),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /every verb README\.md types is in COMMANDS/),
      'and names §1 on README.md — the page still types `crabcast tail`'
    );
    check(
      passed(out, /every verb docs\/SETUP\.md types is in COMMANDS/),
      'and SETUP.md\'s §1 stays green, because that page never types `tail`'
    );
    check(
      failed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that do not/),
      'and §2 goes red independently: the published no-spawn list still names `tail`'
    );
  }
);

// ================================================================== arm 3
// §2, CLI side. One verb moves across the split; every page is now wrong.
await arm(
  'arm 3   §2  ONE VERB MOVES ACROSS THE SPAWN SPLIT, DOCUMENTS UNTOUCHED — tail spawnsDaemon false -> true',
  (dir) => editOnce(dir, CLI, CLI_TAIL_SPAWN, "max 200)' }\n    ],\n    spawnsDaemon: true,"),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    for (const site of [
      { name: 'docs/SETUP.md §4.2', re: /docs\/SETUP\.md:\d+ \(§4\.2\)/ },
      { name: 'README.md "No client starts a daemon by hand"', re: /README\.md:\d+ \(No client starts a daemon by hand\)/ },
      { name: 'README.md "Which commands start a daemon"', re: /README\.md:\d+ \(Which commands start a daemon\)/ }
    ]) {
      check(
        failed(out, new RegExp(`${site.re.source} lists exactly the commands that spawn a daemon`)),
        `and names the spawn list in ${site.name}`
      );
    }
    check(
      /src\/cli\.ts says \[activate, configure, deactivate, forget, send, tail\]/.test(out),
      'and prints both sides of the difference, so the repair is readable off the output'
    );
    check(
      failed(out, /docs\/SETUP\.md:\d+ pastes the verbs that spawn one/),
      'and §3 catches the same move independently, off the pasted block'
    );
    check(
      passed(out, /every verb docs\/SETUP\.md types is in COMMANDS/),
      'and §1 stays green — the verb still exists, it just does something else'
    );
  }
);

// ================================================================== arm 4
// §2, document side, ONE SITE ONLY. The discrimination arm: a page that drops a
// verb must redden its own claim and nobody else's.
await arm(
  'arm 4   §2  ONE PAGE DROPS A VERB FROM ITS PUBLISHED LIST — SETUP §4.2 loses `tail`',
  (dir) =>
    editOnce(
      dir,
      SETUP,
      SETUP_NO_SPAWN,
      '`list`, `status`, `capacity` and `daemon-status` all exit `3` rather than'
    ),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that do not/),
      'and names SETUP §4.2\'s no-spawn list'
    );
    check(
      /page says \[capacity, daemon-status, list, status\], src\/cli\.ts says \[capacity, daemon-status, list, status, tail\]/.test(out),
      'and says which verb the page is missing'
    );
    check(
      passed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that spawn a daemon/),
      'and the OTHER list in the same sentence stays green'
    );
    check(
      passed(out, /README\.md:\d+ \(Which commands start a daemon\) lists exactly the commands that do not/) &&
        passed(out, /README\.md:\d+ \(No client starts a daemon by hand\) lists exactly the commands that do not/),
      'and both README claims stay green — one page moved, one page is named'
    );
  }
);

// ================================================================== arm 5
// ⚠ THE ARM §2 EXISTS FOR. Not one character of any document changes.
await arm(
  'arm 5   §2  A COMMAND IS ADDED TO THE CLI, DOCUMENTS UNTOUCHED  <-- the drift this section exists for',
  (dir) => editOnce(dir, CLI, CLI_COMMANDS_END, NEW_COMMAND),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red with every document byte-identical', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that do not/) &&
        failed(out, /README\.md:\d+ \(No client starts a daemon by hand\) lists exactly the commands that do not/) &&
        failed(out, /README\.md:\d+ \(Which commands start a daemon\) lists exactly the commands that do not/),
      'and all three published no-spawn lists are named as short'
    );
    check(/quiesce/.test(out), 'and the new command is named, so the repair is one edit per page');
    check(
      passed(out, /docs\/SETUP\.md:\d+ pastes the verbs that spawn one/),
      'and §3 stays green: the new verb does not spawn, so the pasted spawner list is still right'
    );
    check(
      passed(out, /every verb docs\/SETUP\.md types is in COMMANDS/),
      'and §1 stays green: a command nobody documents is not a command nobody has'
    );
  }
);

// ================================================================== arm 6
// §3. The pasted block stops being what the CLI would emit.
await arm(
  'arm 6   §3  THE PASTED CLI OUTPUT DRIFTS — SETUP §4.2\'s block loses `send`',
  (dir) => editOnce(dir, SETUP, SETUP_PASTED_SPAWNERS, '\n  configure, activate, deactivate, forget\n'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ pastes the verbs that spawn one as the CLI would emit it/),
      'and names the pasted line by number'
    );
    check(
      /pasted "configure, activate, deactivate, forget", cli\.ts emits "configure, activate, deactivate, forget, send"/.test(out),
      'and prints the paste beside what the CLI builds, character for character'
    );
    check(
      passed(out, /docs\/SETUP\.md:\d+ \(§4\.2\) lists exactly the commands that spawn a daemon/),
      'and §2 stays green — the PROSE list below the block was not the thing that drifted'
    );
  }
);

// ================================================================== arm 7
// §4, document side. A quoted code is changed to one the CLI does not use here.
await arm(
  'arm 7   §4  A QUOTED EXIT CODE IS CHANGED ON THE PAGE — §3.2\'s retired-key refusal says 6',
  (dir) => editOnce(dir, SETUP, SETUP_RETIRED_EXIT, 'it to in this file.\nEXIT=6'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ quotes EXIT\.CONFIG — [^\n]*the retired-key refusal/),
      'and names the claim and the member it should have agreed with'
    );
    check(
      /page says 6, src\/cli\.ts says EXIT\.CONFIG = 4/.test(out),
      'and prints both numbers'
    );
    check(
      passed(out, /docs\/SETUP\.md:\d+ quotes EXIT\.CONFIG — [^\n]*the over-long dataDir refusal/),
      'and the OTHER §3.2 refusal, which was not edited, stays green'
    );
  }
);

// ================================================================== arm 8
// ⚠ THE ARM THAT DECIDES WHETHER §4 IS A RECONCILIATION OR A LIST OF TODAY'S
// ANSWERS. The page is not touched. The CLI renumbers a code.
await arm(
  'arm 8   §4  THE CODE IS RENUMBERED IN THE CLI, PAGE UNTOUCHED — EXIT.CONFIG 4 -> 6  <-- reconciliation or list?',
  (dir) => editOnce(dir, CLI, CLI_CONFIG_CODE, '  CONFIG: 6,'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red with docs/SETUP.md byte-identical', `exit ${code}`);
    for (const claim of [
      'a config that was named and will not load',
      'the retired-key refusal',
      'the over-long dataDir refusal',
      '§10 observed: a named config that will not load'
    ]) {
      check(
        failed(out, new RegExp(`docs/SETUP\\.md:\\d+ quotes EXIT\\.CONFIG — [^\\n]*${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
        `and names the claim "${claim}", which still says 4`
      );
    }
    check(
      /page says 4, src\/cli\.ts says EXIT\.CONFIG = 6/.test(out),
      'and reports the direction of the drift'
    );
    check(
      passed(out, /docs\/SETUP\.md:\d+ quotes EXIT\.TRANSPORT — [^\n]*a read verb against a machine with no daemon/),
      'and every TRANSPORT claim stays green — only the renumbered member moved'
    );
  }
);

// ================================================================== arm 9
// §4, the register's forward direction. A new claim nothing accounts for.
await arm(
  'arm 9   §4  AN UNREGISTERED EXIT-CODE CLAIM IS ADDED TO THE PAGE',
  (dir) =>
    editOnce(
      dir,
      SETUP,
      '### 4.3 Give it a supervisor',
      'A refused send exits `1`.\n\n### 4.3 Give it a supervisor'
    ),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ quotes exit `1` and the register accounts for it/),
      'and names the new claim by line number'
    );
    check(
      /add a `member` reconciling it, or a `why` saying it is not a CrabCast client exit code/.test(out),
      'and says which of the two repairs is wanted, rather than only that something is wrong'
    );
  }
);

// ================================================================= arm 10
// §4, the register's other direction. An entry guarding a claim that has gone.
await arm(
  'arm 10  §4  A REGISTERED CLAIM IS EDITED OFF THE PAGE — the register entry now guards nothing',
  (dir) => editOnce(dir, SETUP, SETUP_ROUNDTRIP_EXIT, 'all `RESULT=0` against a scratch daemon.'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /every register entry still matches a claim on the page/),
      'and names the stale-register assertion'
    );
    check(
      /no claim found for "against a scratch daemon"/.test(out),
      'and says which entry went stale, by the anchor that stopped matching'
    );
    check(
      !/FAIL {2}docs\/SETUP\.md:\d+ quotes EXIT\.OK — §5\.4/.test(out),
      'and does NOT also report it as a mismatched claim — a claim that is gone is not a claim that is wrong'
    );
  }
);

// ================================================================= arm 11
// §5, document side. THE DEFECT ITSELF, reproduced on the corrected bullet.
await arm(
  'arm 11  §5  THE README DROPS A CODE FROM ITS CONTRACT SET — KAN-528\'s defect, replayed',
  (dir) => editOnce(dir, README, README_OVERSIZE, ' · `5` the answer was large'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /README\.md:\d+ spells EXIT\.OVERSIZE/),
      'and names the code whose meaning the page stopped carrying'
    );
    check(
      passed(out, /README\.md:\d+ publishes exactly the set src\/cli\.ts defines/),
      'and the SET is still right, which is the point: 5 is present but no longer described'
    );
  }
);

// ================================================================= arm 12
// ⚠ KAN-528 REPLAYED FROM THE SIDE IT ACTUALLY ARRIVED FROM. The README is not
// touched. A code is added to the CLI, exactly as `OVERSIZE` was.
await arm(
  'arm 12  §5  A CODE IS ADDED TO THE CLI, README UNTOUCHED  <-- the drift that really happened',
  (dir) => editOnce(dir, CLI, CLI_OVERSIZE_CODE, '  OVERSIZE: 5,\n  DEADLINE: 6\n} as const;'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red with README.md byte-identical', `exit ${code}`);
    check(
      failed(out, /README\.md:\d+ publishes exactly the set src\/cli\.ts defines/),
      'and names the contract bullet as no longer publishing the whole set'
    );
    check(
      /missing from the page: \[6\]/.test(out),
      'and says which code the page is short by — which is the whole of the repair'
    );
    check(
      passed(out, /README\.md:\d+ spells EXIT\.OVERSIZE/),
      'and the five codes the page does describe are still described correctly'
    );
  }
);

// ================================================================= arm 13
// §0 must fail CLOSED. A table it can no longer read is red, never empty.
await arm(
  'arm 13  §0  THE CLI\'S TABLE STOPS BEING READABLE — EXIT gains a non-literal member',
  (dir) => editOnce(dir, CLI, '  OK: 0,', '  OK: BASE_CODE,'),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red rather than sweeping an empty table', `exit ${code}`);
    check(failed(out, /read `EXIT` as an object of numeric members/), 'and names §0 as what failed');
    check(
      /an unread table agrees\s*\n?\s*with every document/.test(out),
      'and says why it stopped instead of running the sections'
    );
    check(!/ALL CHECKS PASSED/.test(out), 'and does NOT print its all-clear line');
    check(
      !/=== 5\./.test(out),
      'and does not run the later sections at all — a section comparing against an unread table is worse than no section'
    );
  }
);

// ================================================================= arm 14
// ⚠ FALSE-POSITIVE CONTROL. An edit of exactly the shape the arms above make,
// which must stay GREEN. Without this, a check that reddened on any edit would
// have passed all fourteen arms above.
await arm(
  'arm 14  FALSE-POSITIVE CONTROL — a published list is REORDERED, which is not a change to the set',
  (dir) =>
    editOnce(
      dir,
      README,
      README_SPAWNERS_2,
      '**Which commands start a daemon:** `activate`, `configure`,'
    ),
  ({ code, out }) => {
    check(code === 0, 'the proof stays GREEN — these are sets, and a set has no order', `exit ${code}`);
    check(/ALL CHECKS PASSED/.test(out), 'and says so');
    check(!/^FAIL/m.test(out), 'and prints no FAIL of any kind');
  }
);

// ================================================================= arm 15
// ⚠ THE SECOND FALSE-POSITIVE CONTROL, and the one that justifies §4's register
// being keyed by anchor rather than by line number. KAN-618 is editing §4.3 and
// §10 of this same page while this is being written, and other tickets will
// edit it again. A register keyed by line would go red here — reporting every
// claim below the insertion as unaccounted for AND every entry as stale, at
// once, for a page where nothing about an exit code moved. That red is worse
// than no check: it teaches a reader to re-point numbers without reading
// claims. This arm requires the page to be allowed to move.
// ================================================================= arm 15
// The sweep's THIRD SHAPE, driven on its own. It exists because the first two
// missed §4.1's *"Its exit status is the daemon's own — `0` for a clean
// shutdown"* — a real exit-code claim in a wording neither matched, sitting
// inside a register that reported every claim accounted for. A shape added to
// close a blind spot has to be shown biting, or the fix is a comment.
await arm(
  'arm 15  §4  A CLAIM IN THE WORDING THE SWEEP USED TO MISS — a quoted code with no `EXIT=` and no "exits"',
  (dir) =>
    editOnce(
      dir,
      SETUP,
      '### 5.2 The build block',
      'On a clean exit the status is `2`.\n\n### 5.2 The build block'
    ),
  ({ code, out }) => {
    check(code !== 0, 'the proof goes red', `exit ${code}`);
    check(
      failed(out, /docs\/SETUP\.md:\d+ quotes exit `2` and the register accounts for it/),
      'and names the claim the first two shapes could not see'
    );
  }
);

// ================================================================= arm 16
const INSERTED_LINES = 3;
/** Where the proof said the retired-key refusal was, so the shift can be measured. */
const retiredKeyLine = (out) => {
  const m = /docs\/SETUP\.md:(\d+) quotes EXIT\.CONFIG — §3\.2 driven: the retired-key refusal/.exec(out);
  return m ? Number(m[1]) : null;
};
let lineBeforeShift = null;

await arm(
  'arm 16  FALSE-POSITIVE CONTROL — an unrelated paragraph shifts every line below it',
  (dir) => {
    lineBeforeShift = retiredKeyLine(runProof(dir).out);
    return editOnce(
      dir,
      SETUP,
      '### 1.1 Node.js 20 or newer',
      'A paragraph KAN-607\'s red drive inserted. It says nothing about a command or a\nstatus, and it moves every line after it.\n\n### 1.1 Node.js 20 or newer'
    );
  },
  ({ code, out }) => {
    check(code === 0, 'the proof stays GREEN — an edit elsewhere on the page is not drift', `exit ${code}`);
    check(/ALL CHECKS PASSED/.test(out), 'and says so');
    check(
      !failed(out, /every register entry still matches a claim on the page/),
      'and no register entry went stale, because entries anchor on their claim and not on its line'
    );
    // The measurement that makes this arm evidence rather than a green tick: if
    // nothing moved, a line-keyed register would have survived too, and this
    // arm would prove nothing about the anchoring.
    const after = retiredKeyLine(out);
    check(
      lineBeforeShift !== null && after === lineBeforeShift + INSERTED_LINES,
      'and the claim IS reported at a new line — the page really did move under it',
      `${lineBeforeShift} -> ${after}, expected +${INSERTED_LINES}`
    );
  }
);

// =========================================================================
console.log('\nthe working tree');
for (const rel of WITNESSED) {
  const now = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  check(now === before[rel], `${rel} is byte-identical to how this drive found it`);
}

console.log(`\n${failures === 0 ? 'ALL ARMS BEHAVED AS DESCRIBED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
