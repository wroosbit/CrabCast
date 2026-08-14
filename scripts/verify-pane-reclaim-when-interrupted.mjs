#!/usr/bin/env node
// KAN-169: the signal handlers that put a herdr pane back actually FIRE.
//
// WHAT FAILURE THIS WOULD CATCH: a proof in the live half that reclaims the
// pane it opened on every path it can see, and leaves that pane on the
// operator's machine the moment somebody Ctrl-Cs it. The live half is hand-run,
// so an interrupted run is ordinary rather than exceptional, and the leak is
// silent in both directions — the interrupted run prints no verdict, and the
// next run's own census cannot tell a pane it leaked yesterday from one
// somebody else left. THREE SUCH PANES HAVE BEEN UP ON THIS MACHINE SINCE
// 2026-08-05 and were still up nine days later, from the COMPLETED-path leak
// KAN-137 fixed. Nothing was watching the interrupted path at all.
//
// ---------------------------------------------------------------------------
// THE GAP THIS CLOSES IS BETWEEN TWO HONEST SCRIPTS, AND NEITHER OWNED IT
// ---------------------------------------------------------------------------
//
// `verify-proof-cleans-up-when-interrupted` has exactly the right shape — drive
// a proof as a subprocess, SIGINT it, count what survived — and exactly one
// subject: DAEMONS, filtered off the process table by `dist/daemon.js`. The
// word "pane" did not appear in that file.
//
// `verify-no-attach-steal` §4 asserts the pane it opened is gone, by reading
// the census back rather than by trusting its own teardown. But it can only
// assert that on the path where the run REACHES ITS VERDICT. A script cannot
// meaningfully interrupt itself.
//
// So: the first would have caught this if its counter counted panes, and the
// second would have caught it if it could interrupt itself. Neither can. That
// is the KAN-145 shape restated — two scripts each honest about what they test,
// with a hole between them that no script owns — and this file is the hole.
//
// AND THE STATIC HALF NAMES IT TOO. `verify-panes-are-reclaimed` decides, per
// script, whether reclamation is PRESENT; its own header states the limit it
// could not close statically, as boundary 3:
//
//     IT CANNOT SEE WHETHER A RECLAMATION RUNS. `closeAgentByPath` in a
//     `finally` and `closeAgentByPath` after an early `process.exit` are the
//     same text.
//
// The register says WHICH scripts claim reclamation. This says WHETHER it
// fires. Static and dynamic halves of one question, and a reader who meets
// either should be sent to the other.
//
// ---------------------------------------------------------------------------
// WHAT THE COUNTER IS, AND WHY IT CANNOT ANSWER ZERO WHEN IT CANNOT LOOK
// ---------------------------------------------------------------------------
//
// The driving and the counting live in `interrupt-probe.mjs` with the counted
// thing as a parameter — that generalisation is what this ticket asked for, and
// `verify-proof-cleans-up-when-interrupted` is unchanged in behaviour by it.
// The counter here reads `herdr agent list` and returns
// `{ok: true, survivors}` or `{ok: false, reason}`, NEVER a number.
//
// THAT IS NOT DEFENSIVENESS, IT IS THE DEFECT THIS EPIC KEEPS FINDING. A pane
// census that cannot be read must not read as zero, because zero is the answer
// a reclamation check most wants to hear. KAN-173 recorded three separate
// routes to a confident wrong number, every one of them from a command that
// exited cleanly: `herdr … | wc -l` answers 1 because the output is a single
// line of JSON; a guess at the key (`panes`, `data`, a bare list) answers 0 off
// a 26 KB file; and keying on `label` where `herdr agent list` publishes `name`
// answers 0 on a machine carrying three. §0 holds this reader to all three.
//
// ---------------------------------------------------------------------------
// HOW THIS RUN'S PANE IS MADE PROVABLY ITS OWN — the safety argument
// ---------------------------------------------------------------------------
//
// This proof INTERRUPTS things on a live fleet machine and its mutant section
// DELIBERATELY LEAKS a pane, which it must then reap. Reaping the wrong pane
// here would kill a live supervisor. So "mine" is not a heuristic over names:
//
//   * each driven run gets its own TMPDIR, which `os.tmpdir()` honours;
//   * the target derives its probe directory from `os.tmpdir()` and its pane
//     name from that directory through `paneNameFor`;
//   * therefore the pane name is a function of a directory THIS PROCESS minted
//     seconds earlier, and no other run on this machine — past, concurrent or
//     future — can be holding it.
//
// The reap re-checks the pane's own `cwd` against that directory before closing
// anything, refuses any `butchr-*` name outright, and reads the `pane_id`
// immediately before the close because ids are POSITIONS that renumber whenever
// any pane anywhere closes. The three `crabcast-*` panes held open on this
// machine by an explicit decision on KAN-173 sit at `/home/brooswit` and match
// no name this script derives; they are never counted as this run's leak and
// never touched.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A CONTROL BETWEEN THE PRISTINE RUN AND THE MUTANT
// ---------------------------------------------------------------------------
//
// §1 drives the target where it lives. §3 drives a MUTATED COPY of it from a
// scratch tree. Those differ in two ways at once — the mutation, and being a
// copy in a different directory with a symlinked `dist` — so a red in §3 alone
// would not say which of the two produced it. §2 is the false-positive control:
// the SAME copy in the SAME scratch layout, unmutated, must still reclaim. With
// it, the only thing left between §2 and §3 is the handler.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT DECIDE — stated because "everything is caught" has been
// wrong in this repository more than five times
// ---------------------------------------------------------------------------
//
//   1. IT DRIVES ONE TARGET. `verify-no-attach-steal` is the script whose
//      handlers KAN-137 added and whose interrupted path was demonstrated only
//      by hand. Every other pane-opening proof in the live half is outside this
//      run. The target is a parameter (`--target`), so the others CAN be driven
//      through it; nothing here asserts that anybody has.
//   2. IT ASSERTS ABOUT SIGINT. The target registers SIGTERM and SIGHUP on the
//      same path and this drives neither. What is checked is that the handler
//      block fires, not that all three signals reach it.
//   3. IT CANNOT SEE A PANE OPENED BY A ROUTE IT DOES NOT NAME. The counter
//      looks for one exact name. A target that opened a SECOND pane under a
//      different name would leak it past this check entirely — §4's stray sweep
//      is what narrows that, and it is a whole-machine diff rather than an
//      attribution, so a sibling agent booting during the run shows up in it.
//   4. THIS SCRIPT WAS INVISIBLE TO THE STATIC SWEEP THAT COVERS THE REST, and
//      KAN-404 closed that. The history is kept because the shape recurs: this
//      file opens THREE REAL PANES per run and matched NONE of
//      `verify-panes-are-reclaimed`'s three original detectors, because it opens
//      no pane itself — it SPAWNS A PROOF THAT DOES. The sweep did not list it,
//      and no register entry was possible either, because an entry for a script
//      with no sites fails that check's reverse direction: the escape hatch was
//      unavailable precisely where it was needed.
//
//      IT IS NOW A REGISTERED SITE THERE, classified `drives-another-proof`. The
//      detector that found it is keyed on the TARGET LITERAL — the quoted
//      `verify-no-attach-steal.mjs` below — and NOT on the spawn, because the
//      spawn is in `interrupt-probe.mjs` and its argv is a parameter; a detector
//      reading spawn argv finds this case zero times. See that file's boundary 1.
//
//      IT DOES NOT IMMUNISE, and that is the finding rather than an oversight:
//      this file genuinely performs both halves of the discipline — §3 reaps the
//      mutant's leaked pane, §4 asserts the machine census either side — but it
//      performs them THROUGH `interrupt-probe.mjs`, so its own text contains
//      none of the six reclaim/census spellings and the whole-file predicate
//      scores it 0 reclaim / 0 census. The register carries the reading a
//      predicate cannot make.
//
// WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST. §3 writes the mutant it
// then catches, so it proves this instrument reports correctly about a script
// it was handed — not that the handlers committed in the repository are the
// ones a hand-run would exercise. §1 is what covers that: it drives the tracked
// file at its tracked path, unmodified.
//
// ---------------------------------------------------------------------------
// COST, AND WHEN NOT TO RUN THIS
// ---------------------------------------------------------------------------
//
// It needs a real herdr and it opens three real panes, one per driven run, of
// which two are reclaimed by the target and one is reaped here. It is in the
// live half — the exclusion register in `verify-proof-registry.mjs` — because
// no GitHub runner has a herdr or a terminal pane. IT IS NOT WORTH RUNNING
// WHILE THE MACHINE IS TIGHT ON CAPACITY: check `butchr_capacity` first. §0
// prints the load it measured under rather than refusing on it, because a check
// whose verdict depends on what happens to be running on the operator's machine
// is a check that goes red about the machine.
//
// Usage:
//   npm run build
//   node scripts/verify-pane-reclaim-when-interrupted.mjs [--target <script>]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';
import {
  driveAndInterrupt,
  liveAgentCensus,
  paneCounter,
  readAgentCensus,
  reapPaneByName
} from './interrupt-probe.mjs';

import { PANE_NAME_PREFIX, paneNameFor } from '../dist/identity.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const DIST = path.join(repoRoot, 'dist');

const targetArg = process.argv.indexOf('--target');
const TARGET = targetArg === -1
  ? path.join(scriptDir, 'verify-no-attach-steal.mjs')
  : path.resolve(process.argv[targetArg + 1]);

/**
 * The probe directory the target mints inside whatever TMPDIR it is given, and
 * the marker it prints on its happy-path teardown.
 *
 * BOTH ARE FACTS ABOUT THE TARGET, so they are named here where a reader can
 * see the coupling, rather than assumed at three call sites. If the target
 * renames either, this script's preconditions fail loudly — which is the right
 * outcome: they are what make the measurement mean anything.
 */
const PROBE_DIR_NAME = 'kan137-steal-probe';
const TEARDOWN_MARKER = "dropped this run's attach PTY";

let failures = 0;
let checks = 0;
function check(ok, label, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Never flatten a refusal into a number — see `interrupt-probe.mjs`. */
const describe = (r) =>
  r.ok ? `${r.survivors.length} ${JSON.stringify(r.survivors.map((s) => s.name))}` : `REFUSED: ${r.reason}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan169-pane-'));

/**
 * The pane name a driven run will mint, derived the way the target derives it.
 *
 * `realpathSync` on the run's TMPDIR rather than the raw path, because the
 * target canonicalises before hashing and `/tmp` is a symlink on some machines
 * — a mismatch here would not fail loudly, it would count zero survivors for a
 * pane that is sitting right there.
 */
const paneNameOf = ({ runTmp }) =>
  paneNameFor(path.join(fs.realpathSync(runTmp), PROBE_DIR_NAME));

const countPanes = paneCounter({ paneNameOf });

/** Drive one run of `script` and interrupt it as soon as its pane exists. */
const interruptMidRun = (script, label) =>
  driveAndInterrupt({
    target: script,
    root,
    label,
    count: countPanes,
    // The target writes a registry under its data dir. Scratch, NOT the
    // default: the default is the LIVE deploy's state directory on this
    // machine, and a proof that writes into it is a proof that edits the thing
    // it is measuring beside.
    env: { CRABCAST_DATA_DIR: path.join(root, `data-${label}`) },
    settleMs: 2500,
    pollMs: 300
  });

/**
 * Assert one driven run put its pane back, and say what the interrupt caught.
 *
 * THE PRECONDITIONS ARE THE POINT. An interrupt that landed after the target's
 * own happy-path teardown had already run would measure the happy path and
 * report the same clean absence the interrupted path reports when it works —
 * a pass that means the opposite of what it says. So the run must have had its
 * pane up when it was interrupted, must have died BY SIGNAL rather than
 * finishing, and must not yet have printed the teardown marker.
 */
function assertReclaimed(run, what) {
  console.log(`   ${what}: pane while running: ${describe(run.during)}`);
  console.log(`   ${what}: pane after SIGINT:  ${describe(run.after)}`);
  console.log(`   ${what}: exit=${run.exitCode} signal=${run.signalCode} waited=${run.waitedMs}ms`);

  check(run.during.ok && run.during.survivors.length > 0 && !run.diedEarly,
    `PRECONDITION (${what}): the run really had its pane up when it was interrupted — otherwise ` +
    `there would be nothing to leak and this would pass against a script with no cleanup at all`,
    `during=${describe(run.during)} diedEarly=${run.diedEarly}`);
  check(run.signalCode === 'SIGINT',
    `PRECONDITION (${what}): it died BY SIGNAL rather than reaching its own verdict — a run that ` +
    `finished normally would have reclaimed on the path that was never in doubt`,
    `exit=${run.exitCode} signal=${run.signalCode}`);
  check(!run.outputAtInterrupt.includes(TEARDOWN_MARKER),
    `PRECONDITION (${what}): the interrupt landed BEFORE the target's happy-path teardown — it ` +
    `had not printed "${TEARDOWN_MARKER}", so what is asserted below is the SIGNAL handler and ` +
    `not the ordinary exit`,
    `output at interrupt ended: ${JSON.stringify(run.outputAtInterrupt.trim().slice(-200))}`);
  check(run.after.ok && run.after.survivors.length === 0,
    `and THE PANE IS GONE (${what}): the signal handler closed the pane the run had opened`,
    `survivors=${describe(run.after)}`);
}

// ===========================================================================
rule('0. THE COUNTER IS LIVE — a zero from it means zero, not "could not look"');
// ===========================================================================
//
// KAN-173's criterion, applied to this reader: shown non-vacuous by a canary it
// could not satisfy by accident, and shown to REFUSE an unreadable census
// rather than round it down to an empty machine.

/**
 * The canary. 37 agents on ONE LINE of JSON, of which 19 carry a name and 5 of
 * those are `crabcast-*`.
 *
 * EVERY NUMBER IS ARBITRARY AND NONE IS ROUND, which is the point: `wc -l`
 * answers 1, a key-guesser answers 0, a reader counting rows instead of named
 * rows answers 37, and one counting named rows instead of the prefix answers
 * 19. Only a reader doing the actual job answers 5.
 */
const CANARY_TOTAL = 37;
const CANARY_NAMED = 19;
const CANARY_CRABCAST = 5;

function canaryCensusText() {
  const agents = [];
  for (let i = 0; i < CANARY_TOTAL; i += 1) {
    const a = { pane_id: `w1-${i}`, cwd: '/home/nobody', agent_status: 'unknown' };
    if (i < CANARY_CRABCAST) a.name = `crabcast-probe${i}-0123456789abcdef`;
    else if (i < CANARY_NAMED) a.name = `butchr-probe-${i}`;
    agents.push(a);
  }
  return JSON.stringify({ id: 'cli:agent:list', result: { agents } });
}

const canaryText = canaryCensusText();
check(canaryText.split('\n').length === 1,
  'the canary is ONE line, so a line counter cannot accidentally be right',
  `${canaryText.length} bytes on ${canaryText.split('\n').length} line(s) — \`wc -l\` answers 1`);

const canary = readAgentCensus(canaryText);
check(canary.ok === true, 'the reader accepts a well-formed census',
  canary.ok ? '' : canary.reason);
check(canary.ok && canary.total === CANARY_TOTAL,
  `it counts ${CANARY_TOTAL} rows`, canary.ok ? `got ${canary.total}` : canary.reason);
check(canary.ok && canary.names.length === CANARY_NAMED,
  `it counts ${CANARY_NAMED} NAMED agents — not the ${CANARY_TOTAL} rows`,
  canary.ok ? `got ${canary.names.length}` : canary.reason);
check(canary.ok && canary.names.filter((n) => n.startsWith(PANE_NAME_PREFIX)).length === CANARY_CRABCAST,
  `it counts ${CANARY_CRABCAST} \`${PANE_NAME_PREFIX}*\` agents — not the ${CANARY_NAMED} named`,
  canary.ok ? `got ${canary.names.filter((n) => n.startsWith(PANE_NAME_PREFIX)).length}` : canary.reason);

// The reader must MOVE when the census does. Three right answers on one fixture
// is still three readings of one input, and a frozen counter would produce them
// for ever.
{
  const doctored = JSON.parse(canaryText);
  const at = doctored.result.agents.findIndex((a) => String(a.name ?? '').startsWith(PANE_NAME_PREFIX));
  doctored.result.agents.splice(at, 1);
  const after = readAgentCensus(JSON.stringify(doctored));
  check(after.ok && after.total === CANARY_TOTAL - 1 &&
      after.names.filter((n) => n.startsWith(PANE_NAME_PREFIX)).length === CANARY_CRABCAST - 1,
    'DOCTORED: remove one crabcast agent and the reader reports one fewer, on both axes',
    after.ok
      ? `${after.total} rows, ${after.names.filter((n) => n.startsWith(PANE_NAME_PREFIX)).length} crabcast ` +
        `(was ${CANARY_TOTAL}/${CANARY_CRABCAST})`
      : after.reason);
}

// "I could not read this" is not "there is nothing here".
const REFUSALS = [
  ['the shape a first pass guessed — a bare `agents` key at top level',
    JSON.stringify({ agents: [{ name: 'crabcast-x-1' }] })],
  ['a bare array, the other guess', JSON.stringify([{ name: 'crabcast-x-1' }])],
  ['a `data` key, the third guess', JSON.stringify({ data: { agents: [] } })],
  ['the PANE-list shape, whose rows publish `label` where this one publishes `name`',
    JSON.stringify({ id: 'cli:pane:list', result: { panes: [{ label: 'crabcast-x-1' }] } })],
  ['herdr answering nothing at all', ''],
  ['herdr answering an error string', 'herdr: connection refused'],
  ['a result with no agents array', JSON.stringify({ id: 'x', result: {} })]
];
for (const [label, text] of REFUSALS) {
  const r = readAgentCensus(text);
  check(r.ok === false && typeof r.reason === 'string' && r.reason.length > 0,
    `REFUSES: ${label}`,
    r.ok ? `it answered ok with ${r.total} row(s) — that is the 0-from-a-26KB-file defect` : r.reason);
}

// And the case that must NOT be a refusal, or the refusals above prove nothing.
{
  const empty = readAgentCensus(JSON.stringify({ id: 'x', result: { agents: [] } }));
  check(empty.ok === true && empty.total === 0 && empty.names.length === 0,
    'and an EMPTY census is read as zero rather than refused',
    empty.ok ? 'zero agents and unreadable are different answers, and both are reachable' : empty.reason);
}

// --- the live machine ------------------------------------------------------
const entry = liveAgentCensus();
check(entry.ok,
  'a real `herdr agent list` answers here, so the counts below are measurements of this machine',
  entry.ok ? `${entry.names.length} agent(s)` : entry.reason);
if (!entry.ok) {
  console.error(
    `\nrefusing to run: every count in this script is a measurement of the machine, and a run ` +
    `that cannot read the machine has nothing to measure. Nothing was spawned.`
  );
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures ? 1 : 0);
}

const entryNames = entry.names;
const entryButchr = entryNames.filter((n) => n.startsWith('butchr-'));
const entryCrabcast = entryNames.filter((n) => n.startsWith(PANE_NAME_PREFIX));
console.log(`\n   at entry: ${entryNames.length} agent(s) — ` +
  `${entryButchr.length} butchr-*, ${entryCrabcast.length} ${PANE_NAME_PREFIX}*`);
for (const n of entryCrabcast) console.log(`     ${n}`);

// THE LOAD CONDITIONS, printed and never gated on. This proof is not worth
// running on a machine that is tight, and that is the operator's call.
{
  const [load1] = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
  console.log(`   load1 at entry: ${load1} on ${os.cpus().length} core(s), ` +
    `${(os.freemem() / 1024 ** 3).toFixed(1)} GiB free`);
}

// ===========================================================================
rule('1. INTERRUPTED MID-RUN, the pane does not survive');
// ===========================================================================
//
// The TRACKED file at its TRACKED path, unmodified — so this section is about
// the handlers that are actually committed, and not about a copy.

const pristine = await interruptMidRun(TARGET, 'pristine');
assertReclaimed(pristine, 'pristine');

// ===========================================================================
rule('2. THE CONTROL — the same copy, in the same scratch layout, unmutated');
// ===========================================================================
//
// §3 differs from §1 in TWO ways: the mutation, and being a copy in a scratch
// tree with a symlinked `dist`. A red there alone could not say which. This
// removes the second, so that what is left between here and §3 is the handler.

const mutantTree = path.join(root, 'tree');
const mutantScripts = path.join(mutantTree, 'scripts');
fs.mkdirSync(mutantScripts, { recursive: true });
// SYMLINKED, not copied. The target's imports are `../dist/*.js` resolved
// relative to its own file, so the mutant needs a `dist` one level up — and a
// symlink keeps it byte-identical to the build §1 ran against, which is the
// whole basis of the comparison.
fs.symlinkSync(DIST, path.join(mutantTree, 'dist'), 'dir');

const controlPath = path.join(mutantScripts, path.basename(TARGET));
fs.copyFileSync(TARGET, controlPath);
const control = await interruptMidRun(controlPath, 'control');
assertReclaimed(control, 'control');

// ===========================================================================
rule('3. THE CHECK CAN FAIL — strip the signal handler and the pane leaks');
// ===========================================================================
//
// §1 and §2 assert an ABSENCE, and an absence is exactly what a check reports
// when it has quietly stopped testing anything. So the handler is removed from
// a copy of the target and the same measurement re-run: if the survivor count
// does not go UP, the sections above were not measuring the handler.

const { mutateScript, mutationsSkipped } = makeMutator({
  // `mutateScript` copies a SOURCE FILE, not a build, so `distDir` is required
  // by the helper's signature and never read. Pointed at the scratch tree so a
  // future caller reaching for `mutate` here has to change it deliberately.
  distDir: path.join(mutantTree, 'dist'),
  scratch: mutantScripts,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

let mutantPaneName = null;

mutation: {
  const HANDLER = `process.on('exit', reclaimProbePane);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    reclaimProbePane();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal); // re-raise, so an interrupted run still exits interrupted
  });
}`;

  // THROUGH THE SHARED HELPER, for its exact-occurrence guarantee and for the
  // counted-verdict-rather-than-throw one: a drifted anchor here must be a FAIL
  // line among the others, not a stack trace that takes §4 and the verdict with
  // it. `deps` is empty because the target's only imports are `../dist/*`,
  // which the symlink above satisfies.
  const mutantPath = mutateScript(
    'strip-pane-reclaim-handler',
    TARGET,
    [{ find: HANDLER, replace: '/* handler removed by the mutation */' }]
  );
  if (!mutantPath) break mutation;

  const mutant = await interruptMidRun(mutantPath, 'mutant');
  mutantPaneName = paneNameOf(mutant.ctx);
  console.log(`   mutant: pane while running: ${describe(mutant.during)}`);
  console.log(`   mutant: pane after SIGINT:  ${describe(mutant.after)}`);
  console.log(`   mutant: exit=${mutant.exitCode} signal=${mutant.signalCode}`);

  check(mutant.during.ok && mutant.during.survivors.length > 0 && !mutant.diedEarly,
    'PRECONDITION: the mutant also really had its pane up when it was interrupted — a mutant that ' +
    'died on startup would leak nothing and make this section prove the opposite of what it says',
    `during=${describe(mutant.during)} diedEarly=${mutant.diedEarly}`);
  check(!mutant.outputAtInterrupt.includes(TEARDOWN_MARKER),
    'PRECONDITION: the mutant was interrupted before its happy-path teardown too, so the two ' +
    'sections are comparing the same moment in the run',
    `output at interrupt ended: ${JSON.stringify(mutant.outputAtInterrupt.trim().slice(-200))}`);
  check(mutant.after.ok && mutant.after.survivors.length > 0,
    'WITHOUT THE HANDLER THE PANE SURVIVES — so §1 and §2 are measuring the handler rather than ' +
    'restating a hope. This is the leak, reproduced on demand.',
    `survivors=${describe(mutant.after)}`);

  // NEVER LEAVE THE MUTANT'S LEAK BEHIND. This is the most important line in
  // the ticket that commissioned this file: a proof that demonstrates a pane
  // leak by leaking a pane, on a live fleet machine, once per run, has become
  // the thing it exists to catch.
  if (mutant.after.ok && mutant.after.survivors.length > 0) {
    reapPaneByName({
      name: mutantPaneName,
      prefix: PANE_NAME_PREFIX,
      expectCwd: path.join(fs.realpathSync(mutant.runTmp), PROBE_DIR_NAME),
      log: (m) => console.log(m)
    });
    await sleep(1500);
  }

  const reaped = countPanes(mutant.ctx);
  check(reaped.ok && reaped.survivors.length === 0,
    'AND THE MUTANT\'S LEAKED PANE WAS REAPED, so this proof leaves nothing on the machine either',
    describe(reaped));
}

// ===========================================================================
rule('4. THE MACHINE IS WHERE IT WAS FOUND');
// ===========================================================================
//
// Asserted from the CENSUS rather than from this script's own intent. "We only
// ever pass our own derived name to a close" is a claim about the code; "the
// butchr-* set is identical" is a claim about the machine, and those are
// different facts.

const exitCensus = liveAgentCensus();
check(exitCensus.ok,
  'the census is readable at exit too, so "the panes are gone" is a reading and not a silence',
  exitCensus.ok ? '' : exitCensus.reason);

if (exitCensus.ok) {
  const exitNames = exitCensus.names;
  const vanished = entryNames.filter((n) => !exitNames.includes(n));
  const appeared = exitNames.filter((n) => !entryNames.includes(n));

  check(exitCensus.names.filter((n) => n.startsWith('butchr-')).join() === entryButchr.join(),
    `no butchr-* agent was touched — ${entryButchr.length} at entry, ` +
    `${exitNames.filter((n) => n.startsWith('butchr-')).length} at exit, identical`,
    `entry: ${JSON.stringify(entryButchr)}\nexit:  ${JSON.stringify(exitNames.filter((n) => n.startsWith('butchr-')))}`);

  check(vanished.filter((n) => n.startsWith(PANE_NAME_PREFIX)).length === 0,
    `every ${PANE_NAME_PREFIX}* pane that was here at entry is still here — this run closed ` +
    `nothing it did not create, including the three KAN-173 holds open deliberately`,
    `gone: ${JSON.stringify(vanished.filter((n) => n.startsWith(PANE_NAME_PREFIX)))}`);

  const strays = appeared.filter((n) => n.startsWith(PANE_NAME_PREFIX));
  check(strays.length === 0,
    `and no ${PANE_NAME_PREFIX}* pane was left behind by any of the ${
      mutantPaneName ? 'three' : 'two'} runs this drove`,
    `left: ${JSON.stringify(strays)} — these are THIS run's leak; close them by hand`);

  const otherNew = appeared.filter((n) => !n.startsWith(PANE_NAME_PREFIX));
  if (otherNew.length || vanished.some((n) => !n.startsWith(PANE_NAME_PREFIX))) {
    console.log(
      `\n  NOTE (not a failure): the non-crabcast census moved while this ran — ` +
      `appeared ${JSON.stringify(otherNew)}, gone ${JSON.stringify(vanished.filter((n) => !n.startsWith(PANE_NAME_PREFIX)))}. ` +
      `This script starts nothing but its own probes; that is the fleet moving underneath the ` +
      `measurement, and a proof that went red because a sibling agent booted is a proof that ` +
      `gets ignored.`
    );
  }
}

// ===========================================================================

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed.`);
// Named next to the verdict so "1 FAILED" is not read as an ordinary assertion
// failure when what actually happened is that a section never executed.
const skipped = mutationsSkipped();
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY, so their section did not run: ${skipped.join(', ')}`);
}
console.log(failures === 0
  ? 'PASS: an interrupted run put its pane back, and stripping the handler brought the leak back.'
  : 'FAIL — see the FAIL lines above.');
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
