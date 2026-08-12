#!/usr/bin/env node
// Proof for KAN-148: the two CI-wiring guards go red for every shape that
// stops the proof-list audit running, and stay green for every shape that
// genuinely runs it.
//
// WHAT FAILURE THIS WOULD CATCH: a `run:` block that mentions
// `node scripts/verify-proof-registry.mjs` while never actually running it —
// buried in a multi-line `if` guard, a heredoc, an uncalled function, a
// `$( … )` capture, a `while false` loop, or a subshell with a `|| true`
// after its closing paren — read by scripts/ci-workflow.mjs as a live,
// gating invocation, so both guards report exit 0 with the audit dead.
//
// WHY IT EXISTS. KAN-141 closed a long list of shapes over four rounds, and
// every one of them was closed by reasoning about the invocation's OWN LINE
// plus the block's last line. Eight more shapes therefore stayed green,
// because what gated them lived on a different line of the same block. Those
// eight are rows 1–8 of section 3. KAN-148 replaced the per-line scan with a
// shell lexer and parser that reads the whole block at once.
//
// KAN-141's shapes are re-run here alongside them, in the same matrix and by
// the same mechanism. A regression there would be worse than the bug being
// fixed, and a proof that only covered the new shapes would not have noticed
// one.
//
// THE ROW LIST BELOW IS THE COUNT — there is deliberately no number in this
// sentence. An earlier draft said "nineteen", taken from the acceptance
// criteria's prose; the table actually carries twenty-eight KAN-141-derived
// rows. A number in a header is a claim that drifts from the mechanism the
// moment a row is added, and this file exists because of claims that drifted
// from mechanisms. Read CASES.
//
// HOW IT PROVES IT — and what that leaves uncovered, which is the part worth
// reading. This script MUTATES `.github/workflows/ci.yml` in place, runs both
// guards against it as real child processes, records the exit code and the
// named FAIL line, and restores the file. So it proves that a mutated
// workflow reaches those two guards and that they act on it.
//
// IT SUPPLIES ITS OWN INPUT, so it does NOT prove that the workflow committed
// in this repository keeps the audit live. Two things cover that, and neither
// is this script: section 1's baseline row asserts it here, and — the one
// that matters, because it is not this script's word for it — the guards run
// on the real ci.yml in CI on every PR, from the `proof-registry` job and
// from the `verify` array. If the committed workflow ever stopped running the
// audit, those runs go red whether or not anybody runs this file.
//
// IT WRITES A TRACKED FILE, and the cleanup for that is four-layered because
// each layer covers an ending the one before it cannot — witnessed, not
// supposed.
//
//   1. A `finally` around every row, and an `exit`/signal handler, which cover
//      a normal death and a Ctrl-C. They do NOT cover SIGKILL or the machine
//      losing power: this script was interrupted by a reboot mid-row during
//      KAN-148's own development and left ci.yml with the proof-registry step
//      deleted, which is row E's mutation.
//
//   2. THE MUTATED FILE CARRIES A MARKER SAYING WHAT PUT IT THERE (KAN-172,
//      item 1). No handler can run after SIGKILL, so the thing that has to
//      speak is the residue itself. Every write of a mutated workflow puts
//      {@link MARKER_TAG} at the top of the file naming this script, the row
//      and the pid, and telling a reader that the run died and how to undo it.
//      This is not decoration: KAN-138's agent watched ci.yml change under it
//      during a review, could not attribute the change, and reported it on a
//      PR as an unattributed actor editing CI — an alarming claim that would
//      have sent the next reviewer somewhere useless. A tracked file under
//      review is read as somebody's work; residue that does not say otherwise
//      IS a false accusation waiting to be made.
//
//      AND THE MARKER NEEDS AN ATOMIC WRITE TO BE WORTH ANYTHING (KAN-341).
//      `fs.writeFileSync` truncates before it writes, so the marked content
//      does not become visible in one step: measured here with the rename
//      backed out, one run of this script leaves ci.yml EMPTY in about 100
//      separate episodes — median 0.07 ms, longest 7.9 ms, ~50 ms in total.
//      A run killed in one of them leaves the unattributed residue that layer 2
//      exists to prevent, with no bytes in the file to carry the marker. Every
//      write of this file therefore goes through `writeWorkflow` — stage, then
//      rename — see its comment below.
//
//   3. A RUN THAT FINDS ci.yml ALREADY DIRTY REFUSES (KAN-172, item 2), and
//      that is the one that was a live defect rather than a nicety. `ORIGINAL`
//      below is whatever is on disk at startup, so a run begun over a previous
//      run's residue snapshots the RESIDUE as its baseline, faithfully restores
//      the residue at the end, and its byte-identical self-check PASSES —
//      because the file does match what it found. Measured on `main` at
//      0edd2c1 before this change: seeded with a comment-only residue that run
//      printed `ALL CHECKS PASSED`, exited 0, and left the corrupted workflow
//      in the tree. The self-check could not see it by construction; the thing
//      it compares against was the corrupted baseline.
//
//   4. The setup guards below, which require exactly one `- run: node scripts/…`
//      line and one `proof-registry:` line. They are now the third net rather
//      than the backstop, and they were never enough alone: they catch a
//      residue that removed the step, and pass over one that only ADDED to it —
//      `if: ${{ false }}` on the job, `continue-on-error: true` on the step,
//      a workflow-level `defaults.run.shell`, or a bare comment.
//
// Layers 2 and 3 are proved by `scripts/verify-ci-proof-residue-is-legible.mjs`,
// which is a separate script for the reason its own header gives: a script
// cannot meaningfully SIGKILL itself, and it cannot show what a run started
// over residue does without being a second run.
//
// Section 2 is the other half of an honest proof: it reproduces the DEFECT.
// It loads the pre-fix `scripts/ci-workflow.mjs` out of git and shows the same
// eight shapes reading as LIVE there, so the green in section 3 is measuring
// a change rather than restating an intent. It needs the pre-fix source to be
// reachable — see the section for exactly what it reports when it is not, and
// why that case is announced rather than passed over.
//
// Needs no daemon, no herdr and no network. It reads and writes one tracked
// file and spawns two node processes per row.

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_REL = path.join('.github', 'workflows', 'ci.yml');
const workflowPath = path.join(repoRoot, WORKFLOW_REL);
const REGISTRY = path.join('scripts', 'verify-proof-registry.mjs');
const PARITY = path.join('scripts', 'verify-cli-parity.mjs');
const NEEDLE = /node\s+scripts\/verify-proof-registry\.mjs/;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// The marker the mutated file carries (KAN-172 item 1).
//
// WHAT IT IS FOR: no `exit` handler, no `finally` and no signal handler runs
// after SIGKILL or a power cut, so the only thing that can explain residue at
// that point is the residue. The marker is a YAML comment — the guards still
// fail on the construct underneath it, which is what row g1 and the baseline
// row check by staying green with the marker in place.
//
// IT IS ALSO THE INPUT TO THE REFUSAL BELOW: a marked residue lets the next run
// name the run that died, its row and its pid, instead of saying only "this
// file is dirty".
// ---------------------------------------------------------------------------

/** The one string a reader, and the refusal below, match on. */
const MARKER_TAG = 'MUTATED BY scripts/verify-ci-wiring-guards.mjs';
const STARTED = new Date().toISOString();

const markerFor = (id, what) =>
  [
    `# ${MARKER_TAG} — row ${id} (${what}), pid ${process.pid}, started ${STARTED}`,
    '# THIS FILE IS A TEST FIXTURE AT THIS MOMENT. That proof breaks one construct',
    '# at a time to show the two CI-wiring guards go red, and puts the file back',
    '# within milliseconds.',
    '# IF YOU ARE READING THIS IN `git status`, `git diff` OR A REVIEW DIFF, THAT',
    '# RUN DIED BEFORE IT COULD RESTORE — SIGKILL, a reboot, a power cut. NOBODY',
    '# EDITED CI: what follows is that run\'s leftovers, not a person\'s work.',
    `# Take it back out with:  git checkout -- ${WORKFLOW_REL}`,
    ''
  ].join('\n');

// ---------------------------------------------------------------------------
// 0. REFUSE TO RUN OVER A DIRTY ci.yml (KAN-172 item 2).
//
// This has to come BEFORE `ORIGINAL` is read, because `ORIGINAL` is the whole
// defect: it is a snapshot of whatever is on disk, so a run begun over residue
// adopts the residue as its baseline, restores it, and reports byte-identical.
// Every assertion below is measured against `ORIGINAL`, so if `ORIGINAL` is not
// the committed workflow then section 1's sentence — "the committed workflow
// keeps both guards green" — is false while printing PASS.
//
// IT REFUSES RATHER THAN REPAIRING. Running `git checkout` on a file a human
// may have been editing is not this script's decision to make; the two states
// "a proof died here" and "somebody is editing CI" are indistinguishable from
// the porcelain alone, and only one of them is safe to discard.
//
// AND IT IS NOT A WAY TO SKIP THE GUARDING: it exits non-zero, so a dirty tree
// is a red check rather than a quiet pass. The one thing worse than absorbing
// residue would be a refusal that reported success.
//
// A FAILURE TO LOOK IS ALSO A REFUSAL. `git` missing, or a tree that is not a
// repository, means this cannot tell a clean file from a corrupted one — and
// "I could not look" reported as "nothing was there" is the shape this epic
// exists to catch.
// ---------------------------------------------------------------------------

{
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '--', WORKFLOW_REL], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    console.error(`REFUSING TO RUN: could not ask git whether ${WORKFLOW_REL} is clean`);
    console.error(`  ${err?.message ?? err}`);
    console.error('  This script mutates that tracked file and restores it from a snapshot taken at');
    console.error('  startup. Without git it cannot tell a committed workflow from a previous run\'s');
    console.error('  leftovers, and a snapshot of leftovers is restored AS leftovers by a run that');
    console.error('  then reports the file byte-identical to how it found it. Not looking is not a pass.');
    process.exit(1);
  }

  if (porcelain.trim()) {
    const onDisk = fs.readFileSync(workflowPath, 'utf8');
    const marker = onDisk.split('\n').filter((l) => l.includes(MARKER_TAG));

    console.error(`REFUSING TO RUN: ${WORKFLOW_REL} is already modified in the working tree.`);
    console.error(`  git status --porcelain -- ${WORKFLOW_REL}`);
    for (const line of porcelain.trimEnd().split('\n')) console.error(`    ${line}`);
    console.error('');
    if (marker.length) {
      console.error('  IT CARRIES THIS SCRIPT\'S OWN MARKER, so this is residue from a run that died');
      console.error('  before it could restore the file:');
      for (const line of marker) console.error(`    ${line}`);
      console.error('');
      console.error(`  Nobody edited CI. Take it back out with:  git checkout -- ${WORKFLOW_REL}`);
    } else {
      console.error('  It carries no marker of this script\'s, so it is either an edit somebody is');
      console.error('  making to CI, or residue from a version of this script that predates the');
      console.error(`  marker. \`git diff -- ${WORKFLOW_REL}\` shows which. Commit or stash the edit,`);
      console.error(`  or discard it with \`git checkout -- ${WORKFLOW_REL}\`, then run this again.`);
    }
    console.error('');
    console.error('  WHY THIS IS A REFUSAL AND NOT A WARNING: the baseline this script measures every');
    console.error('  row against is read off disk at startup. Started here it would adopt the change');
    console.error('  above as that baseline, restore it at the end, and PASS its own "byte-identical');
    console.error('  to how this run found it" check — a corrupted workflow left in the tree by a run');
    console.error('  that reported an all-clear. Measured on main at 0edd2c1: that run printed ALL');
    console.error('  CHECKS PASSED and exited 0.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Setup guards. These are not verdicts: they are the preconditions without
// which every row below would be measuring the wrong thing.
// ---------------------------------------------------------------------------

const ORIGINAL = fs.readFileSync(workflowPath, 'utf8');
const STEP_LINE = '      - run: node scripts/verify-proof-registry.mjs';
const JOB_LINE = '  proof-registry:';

if (ORIGINAL.split('\n').filter((l) => l === STEP_LINE).length !== 1) {
  console.error(`setup: expected exactly one line ${JSON.stringify(STEP_LINE)} in ci.yml — cannot mutate`);
  process.exit(1);
}
if (ORIGINAL.split('\n').filter((l) => l === JOB_LINE).length !== 1) {
  console.error(`setup: expected exactly one line ${JSON.stringify(JOB_LINE)} in ci.yml — cannot mutate`);
  process.exit(1);
}
if (!fs.existsSync(path.join(repoRoot, 'dist', 'cli.js'))) {
  console.error('setup: dist/cli.js not found — run `npm run build` first. verify-cli-parity needs the built');
  console.error('       command table, and a run that skipped it would report on rows it never measured.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// EVERY WRITE OF ci.yml GOES THROUGH A RENAME (KAN-341).
//
// `fs.writeFileSync` is not one operation: it is open(O_TRUNC) followed by
// write(). Between those the file exists, is tracked, is EMPTY, and says
// nothing about why — the exact state the marker exists to make impossible.
// Measured on this repository at 60a6b8b: a tight observer watching ci.yml
// while this script ran caught it zero-length, and caught it at 4096, 8192 …
// 57344 bytes — the write() observed page by page. Timed rather than counted,
// because an empty file is cheaper to read and a sample count therefore
// over-reports it: ~100 empty episodes per run, median 0.07 ms, longest 7.9 ms.
//
// That window is what made `verify-ci-proof-residue-is-legible` flaky. Its
// SIGKILL is aimed at the first on-disk state that differs from the committed
// file, and a truncated file differs; landing there it left an EMPTY ci.yml
// and the residue's five marker assertions failed against a file with no bytes
// in it to carry a marker. Run 31590166769 on `main` is that, and it passed on
// re-run because landing in the window is a race — reproduced 1 time in 40 by
// running that SIGKILL rule against this script — rather than a bug in the
// change under it. The window's size is the timed figure above, not a
// percentage read off a sample count.
//
// rename() is atomic within a filesystem, so a reader of this path sees either
// the whole previous content or the whole next one, and never a state between.
// The header's claim that "the file is never mutated-and-silent on disk at any
// instant" is true of THIS, and was not true of one writeFileSync.
//
// THE STAGING FILE IS THE COST, and it is named rather than hidden: a run
// killed between the write and the rename leaves it behind. It is untracked, it
// is this script's alone, and it carries the marker as its first line, so it is
// self-describing where an empty ci.yml was not. `sweepStagingFiles` below
// removes any that a previous run left; that is safe in a way `git checkout --
// ci.yml` is not, because nothing but this script ever creates one.
//
// AND THE SWEEP IS GUARDED, in section 7 of
// `scripts/verify-ci-proof-residue-is-legible.mjs`, which plants a staging file
// and holds this run to removing it and saying so. It is guarded because it was
// not: KAN-341's reviewer starved this function to `return []` and the whole
// residue proof stayed green at 35/35, so the residue this change INTRODUCES
// was briefly the one residue nothing checked.
// ---------------------------------------------------------------------------

const STAGING_PREFIX = '.ci.yml.staging-';
const workflowDir = path.dirname(workflowPath);
const stagingPath = path.join(workflowDir, `${STAGING_PREFIX}${process.pid}`);

function writeWorkflow(content) {
  fs.writeFileSync(stagingPath, content);
  fs.renameSync(stagingPath, workflowPath);
}

function sweepStagingFiles() {
  let swept = [];
  try {
    swept = fs.readdirSync(workflowDir).filter((n) => n.startsWith(STAGING_PREFIX));
  } catch { return []; }
  for (const name of swept) {
    try { fs.unlinkSync(path.join(workflowDir, name)); } catch { /* best effort */ }
  }
  return swept;
}

{
  const swept = sweepStagingFiles();
  if (swept.length) {
    console.log(`(swept ${swept.length} staging file(s) a previous run left behind: ${swept.join(', ')})\n`);
  }
}

// The file must go back exactly as it was found even if this run dies.
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  try { writeWorkflow(ORIGINAL); } catch { /* nothing better to do while dying */ }
  try { sweepStagingFiles(); } catch { /* ditto */ }
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restore(); process.exit(130); });
}

// ---------------------------------------------------------------------------
// Running the two guards over whatever ci.yml currently says.
// ---------------------------------------------------------------------------

/** A FAIL line from either guard's CI-wiring assertion, by its own wording. */
const isWiringFail = (line) =>
  line.startsWith('FAIL') &&
  (line.includes('from a live step of its own') ||
    line.includes('runs it from a live step') ||
    line.includes('buries it in a construct that may not run'));

function runGuard(script) {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    code: r.status,
    wiringFails: out.split('\n').filter(isWiringFail)
  };
}

/**
 * Put a mutated workflow on disk, marked.
 *
 * THE MARKER GOES ON IN THE SAME WRITE as the mutation, deliberately. Written
 * separately there would be a window — however short — in which the file is
 * broken and says nothing about why, and the endings this marker exists for are
 * exactly the ones that arrive without warning.
 *
 * ONE WRITE IS NOT ENOUGH TO GET THAT, which is KAN-341 and is why this goes
 * through `writeWorkflow` rather than `fs.writeFileSync`. One writeFileSync
 * still truncates before it writes, so the file passes through empty — mutated
 * and silent, on every single write, for the durations timed at `writeWorkflow`
 * above. It is the rename that makes the sentence above true.
 *
 * The baseline row goes through here too, with `id` 'baseline'. It is the only
 * row whose yaml equals ORIGINAL, so it is also the only row whose residue would
 * be the marker ALONE — a comment-only dirty file, which is the residue the
 * refusal above catches and nothing else would.
 */
function writeMutated(yaml, id, what) {
  writeWorkflow(markerFor(id, what) + yaml);
}

function runBoth(yaml, id, what) {
  writeMutated(yaml, id, what);
  try {
    return { reg: runGuard(REGISTRY), par: runGuard(PARITY) };
  } finally {
    writeWorkflow(ORIGINAL);
  }
}

// ---------------------------------------------------------------------------
// The mutations.
// ---------------------------------------------------------------------------

const replaceStep = (...lines) => (yaml) => yaml.replace(STEP_LINE, lines.join('\n'));
const deleteStep = () => (yaml) => yaml.replace(`${STEP_LINE}\n`, '');
const addJobKey = (line) => (yaml) => yaml.replace(JOB_LINE, `${JOB_LINE}\n${line}`);
const block = (...body) => replaceStep('      - run: |', ...body.map((l) => `          ${l}`));

/**
 * Rows 1–8 are KAN-148's eight shapes, in the ticket's own order. Rows A–P10
 * are KAN-141's, re-run so a regression there is a red row here rather than a
 * discovery in review. Rows g1–g9 and M/O/X are the shapes that must STAY
 * green: a guard that flagged `&&`, `set -euo pipefail` or a `time` prefix is
 * one people route around.
 *
 * `expect` is the phrase each guard's own FAIL line has to contain, and it is
 * there because of a mutation that got through without it. Every not-live
 * verdict fails CLOSED by construction — a finding that is not position
 * 'command' can never satisfy `live` — so a guard that stopped reading the
 * BURIED verdict entirely still exited 1, on the fallback message, and a
 * matrix that only checked the exit code stayed green over it. The exit code
 * says a reader is stopped; `expect` is what says they are TOLD WHY. AC 1
 * asks for both.
 *
 * Row E has no `expect`: the two guards word "there is nothing here at all"
 * differently, and inventing a shared phrase for it would be asserting a
 * string rather than a diagnosis.
 */
const CASES = [
  // ---- KAN-148: gated from another line of the block -----------------------
  { id: '1', what: 'multi-line if-guard', want: 'RED', expect: 'the body of an `if`', gap: true,
    mutate: block('if [ "$SKIP_AUDIT" != 1 ]; then', '  node scripts/verify-proof-registry.mjs', 'fi') },
  { id: '2', what: 'multi-line subshell, `) || true`', want: 'RED', expect: '|| true', gap: true,
    mutate: block('(', '  node scripts/verify-proof-registry.mjs', ') || true') },
  { id: '3', what: 'line continuation onto `|| true`', want: 'RED', expect: '|| true', gap: true,
    mutate: block('node scripts/verify-proof-registry.mjs \\', '  || true') },
  { id: '4', what: 'unquoted command substitution', want: 'RED', expect: 'command substitution', gap: true,
    mutate: replaceStep('      - run: echo $(node scripts/verify-proof-registry.mjs)') },
  { id: '5', what: 'captured into a variable', want: 'RED', expect: 'command substitution', gap: true,
    mutate: replaceStep('      - run: out=$(node scripts/verify-proof-registry.mjs)') },
  { id: '6', what: 'heredoc body', want: 'RED', expect: 'heredoc body', gap: true,
    mutate: block('cat <<EOF', 'node scripts/verify-proof-registry.mjs', 'EOF') },
  { id: '7', what: 'function body that is never called', want: 'RED', expect: 'a function body', gap: true,
    mutate: block('audit() {', '  node scripts/verify-proof-registry.mjs', '}', 'echo "not calling it"') },
  { id: '8', what: 'trap "exit 0" EXIT, then the invocation', want: 'RED', expect: 'trap', gap: true,
    mutate: block('trap "exit 0" EXIT', 'node scripts/verify-proof-registry.mjs') },
  { id: '8b', what: 'while false; do … done', want: 'RED', expect: '`while` loop', gap: true,
    mutate: block('while false; do', '  node scripts/verify-proof-registry.mjs', 'done') },
  { id: '8c', what: 'line continuation in a PLAIN scalar (YAML folds it)', want: 'RED', expect: '|| true', gap: true,
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs \\', '          || true') },

  // ---- KAN-141: never runs -------------------------------------------------
  { id: 'A', what: 'commented out', want: 'RED', expect: 'not as a step at all',
    mutate: replaceStep('      # TODO restore: - run: node scripts/verify-proof-registry.mjs') },
  { id: 'B', what: '`if: false` on the job', want: 'RED', expect: 'if: false', mutate: addJobKey('    if: false') },
  { id: 'B2', what: '`if: ${{ false }}` on the job', want: 'RED', expect: 'if: ${{ false }}', mutate: addJobKey('    if: ${{ false }}') },
  { id: 'C', what: '`continue-on-error: true` on the job', want: 'RED', expect: 'continue-on-error: true',
    mutate: addJobKey('    continue-on-error: true') },
  { id: 'D', what: '`if: false` on the step', want: 'RED', expect: 'if: false',
    mutate: replaceStep(STEP_LINE, '        if: false') },
  { id: 'D2', what: '`continue-on-error: true` on the step', want: 'RED', expect: 'continue-on-error: true',
    mutate: replaceStep(STEP_LINE, '        continue-on-error: true') },
  { id: 'E', what: 'step deleted outright', want: 'RED', mutate: deleteStep() },
  { id: 'S', what: '`shell: python` on the step', want: 'RED', expect: 'shell: python',
    mutate: replaceStep(STEP_LINE, '        shell: python') },
  { id: 'S2', what: '`defaults.run.shell: pwsh` on the JOB, step says nothing', want: 'RED',
    expect: 'inherits `shell: pwsh`',
    mutate: addJobKey('    defaults:\n      run:\n        shell: pwsh') },
  { id: 'S3', what: '`defaults.run.shell: pwsh` on the WORKFLOW', want: 'RED',
    expect: 'inherits `shell: pwsh`',
    mutate: (yaml) => yaml.replace('\njobs:\n', '\ndefaults:\n  run:\n    shell: pwsh\n\njobs:\n') },
  { id: 'S4', what: 'workflow `defaults` shell overridden by a `bash` step', want: 'GREEN',
    mutate: (yaml) =>
      yaml
        .replace('\njobs:\n', '\ndefaults:\n  run:\n    shell: pwsh\n\njobs:\n')
        .replace(STEP_LINE, `${STEP_LINE}\n        shell: bash`) },

  // ---- KAN-141: runs, exit status thrown away ------------------------------
  { id: 'F', what: '`|| true`', want: 'RED', expect: '|| true',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs || true') },
  { id: 'G', what: 'inline comment beside a no-op', want: 'RED', expect: 'not as a step at all',
    mutate: replaceStep('      - run: true  # node scripts/verify-proof-registry.mjs') },
  { id: 'H', what: '`set +e`', want: 'RED', expect: 'set +e',
    mutate: block('set +e', 'node scripts/verify-proof-registry.mjs') },
  { id: 'I', what: 'block ends `exit 0`', want: 'RED', expect: 'exit 0',
    mutate: block('node scripts/verify-proof-registry.mjs', 'exit 0') },
  { id: 'J', what: '`; true`', want: 'RED', expect: '; true',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs ; true') },
  { id: 'K', what: 'pipe without pipefail', want: 'RED', expect: 'pipefail',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs | cat') },
  { id: 'L', what: 'backgrounded with `&`', want: 'RED', expect: 'backgrounded',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs &') },
  { id: 'L2', what: 'one-line subshell `|| true`', want: 'RED', expect: '|| true',
    mutate: replaceStep('      - run: (node scripts/verify-proof-registry.mjs) || true') },
  { id: 'L3', what: 'one-line `if …; then`', want: 'RED', expect: 'the condition of an `if`',
    mutate: replaceStep('      - run: if node scripts/verify-proof-registry.mjs; then echo ok; fi') },
  { id: 'N!', what: 'negated with `!`', want: 'RED', expect: 'negated with `!`',
    mutate: replaceStep('      - run: ! node scripts/verify-proof-registry.mjs') },

  // ---- KAN-141: mentioned, never run ---------------------------------------
  { id: 'P1', what: 'echo "…"', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: echo "node scripts/verify-proof-registry.mjs"') },
  { id: 'P2', what: "echo '…'", want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: echo 'node scripts/verify-proof-registry.mjs'") },
  { id: 'P3', what: 'echo bare', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: echo node scripts/verify-proof-registry.mjs') },
  { id: 'P4', what: '`:` no-op builtin', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: ':' node scripts/verify-proof-registry.mjs") },
  { id: 'P5', what: "bash -c '…' || true", want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: bash -c 'node scripts/verify-proof-registry.mjs' || true") },
  { id: 'P6', what: 'bash -c "…" || true', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: bash -c "node scripts/verify-proof-registry.mjs" || true') },
  { id: 'P7', what: '`timeout 60` wrapper', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: timeout 60 node scripts/verify-proof-registry.mjs') },
  { id: 'P8', what: 'eval "…"', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: eval "node scripts/verify-proof-registry.mjs"') },
  { id: 'P9', what: 'a longer word ending in `node`', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: mynode scripts/verify-proof-registry.mjs') },
  { id: 'P10', what: 'echo "$(…)" — the quoted inversion', want: 'RED', expect: 'command substitution',
    mutate: replaceStep('      - run: echo "$(node scripts/verify-proof-registry.mjs)"') },

  // ---- must STAY green -----------------------------------------------------
  { id: 'g1', what: 'plain scalar (the shipped shape)', want: 'GREEN', mutate: (y) => y },
  { id: 'g2', what: 'indented block-scalar line', want: 'GREEN',
    mutate: block('node scripts/verify-proof-registry.mjs') },
  { id: 'g3', what: '`cd . &&` first', want: 'GREEN',
    mutate: replaceStep('      - run: cd . && node scripts/verify-proof-registry.mjs') },
  { id: 'g4', what: '`time` prefix', want: 'GREEN',
    mutate: replaceStep('      - run: time node scripts/verify-proof-registry.mjs') },
  { id: 'g5', what: '`npm ci &&` first', want: 'GREEN',
    mutate: replaceStep('      - run: npm ci && node scripts/verify-proof-registry.mjs') },
  { id: 'g6', what: '`set -euo pipefail` first line', want: 'GREEN',
    mutate: block('set -euo pipefail', 'node scripts/verify-proof-registry.mjs') },
  { id: 'g7', what: 'trailing real comment', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs  # really run') },
  { id: 'g8', what: '`env FOO=1 node …` (KAN-148 AC3: was a false alarm)', want: 'GREEN',
    mutate: replaceStep('      - run: env FOO=1 node scripts/verify-proof-registry.mjs') },
  { id: 'g9', what: '`FOO=1 node …` (KAN-148 AC3: was a false alarm)', want: 'GREEN',
    mutate: replaceStep('      - run: FOO=1 node scripts/verify-proof-registry.mjs') },
  { id: 'M', what: '`&& echo` after', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs && echo done') },
  { id: 'O', what: 'pipe WITH pipefail', want: 'GREEN',
    mutate: block('set -o pipefail', 'node scripts/verify-proof-registry.mjs | cat') },
  { id: 'X1', what: 'a mention AND a real run on one line', want: 'GREEN',
    mutate: replaceStep(
      '      - run: echo node scripts/verify-proof-registry.mjs && node scripts/verify-proof-registry.mjs'
    ) },
  { id: 'X2', what: 'a real run followed by a trailing echo', want: 'GREEN',
    mutate: block('node scripts/verify-proof-registry.mjs', 'echo done') },
  { id: 'X3', what: 'a brace group at top level', want: 'GREEN',
    mutate: block('{ node scripts/verify-proof-registry.mjs; }') },
  // `run: >` FOLDS its newlines into spaces. Read as literal, X4 would still
  // be green by luck and X5 would go red for the wrong reason — "could not be
  // read as shell" instead of "the exit status is swallowed".
  { id: 'X4', what: '`run: >` folded scalar, one command', want: 'GREEN',
    mutate: replaceStep('      - run: >', '          node scripts/verify-proof-registry.mjs') },
  { id: 'X5', what: '`run: >` folded onto `|| true`', want: 'RED', expect: '|| true',
    mutate: replaceStep('      - run: >', '          node scripts/verify-proof-registry.mjs', '          || true') },

  // Found by attacking this parser with shapes the matrix did not yet have,
  // before review did. Y1 is a HOLE in the dangerous direction — the step
  // exits before ever reaching the audit, and everything else here read it as
  // live. Y2/Y3 are the opposite, false alarms of the same kind KAN-148 was
  // filed to remove from `env FOO=1 node …`: `|| exit 1` re-raises the failure
  // rather than eating it. Y4 is the boundary between them.
  { id: 'Y1', what: 'unconditional `exit 0` BEFORE the invocation', want: 'RED', gap: true,
    expect: 'never reached',
    mutate: block('exit 0', 'node scripts/verify-proof-registry.mjs') },
  { id: 'Y2', what: '`|| exit 1` — re-raises, so it still gates', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs || exit 1') },
  { id: 'Y3', what: '`|| false` — re-raises, so it still gates', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs || false') },
  { id: 'Y4', what: '`|| exit 0` — really does swallow', want: 'RED', expect: '|| exit 0',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs || exit 0') },
  { id: 'Y5', what: '`|| exit 1` inside a conditional is still buried', want: 'RED',
    expect: 'the body of an `if`',
    mutate: block('if [ "$X" != 1 ]; then', '  node scripts/verify-proof-registry.mjs || exit 1', 'fi') }
];

// ---------------------------------------------------------------------------
// 1. The baseline. Every row below is read against this, so if the unmutated
//    tree is not green there is nothing to measure.
// ---------------------------------------------------------------------------

console.log('=== 1. Baseline: the committed workflow keeps both guards green ===\n');

const baseline = runBoth(ORIGINAL, 'baseline', 'the committed workflow, unmutated');
check(baseline.reg.code === 0, 'verify-proof-registry passes on the unmutated ci.yml', `exit ${baseline.reg.code}`);
check(baseline.par.code === 0, 'verify-cli-parity passes on the unmutated ci.yml', `exit ${baseline.par.code}`);

// ---------------------------------------------------------------------------
// 2. The defect, reproduced against the parser that shipped before this change.
//
// Without this, section 3 is a table of greens that could equally well be
// describing a guard that was always right. The eight shapes have to be shown
// GOING THROUGH the old parser for the new one's verdict to mean anything.
//
// WHAT IT NEEDS: the pre-fix scripts/ci-workflow.mjs, out of git. Three ways
// that is legitimately unavailable, each reported rather than passed over:
// a shallow clone with no `origin/main`; a run on `main` after this merged,
// where `origin/main` IS this code and there is no pre-fix version to load;
// and a working tree whose ci-workflow.mjs already matches it.
// ---------------------------------------------------------------------------

console.log('\n=== 2. The same eight shapes against the PRE-FIX parser ===\n');

function preFixSource() {
  const current = fs.readFileSync(path.join(repoRoot, 'scripts', 'ci-workflow.mjs'), 'utf8');
  for (const ref of ['origin/main', 'main']) {
    let text;
    try {
      text = execFileSync('git', ['show', `${ref}:scripts/ci-workflow.mjs`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      continue;
    }
    if (text === current) return { ref, text: null, why: `${ref} already carries this parser` };
    return { ref, text, why: null };
  }
  return { ref: null, text: null, why: 'neither `origin/main` nor `main` is present in this clone' };
}

const preFix = preFixSource();
const gaps = CASES.filter((c) => c.gap);

if (!preFix.text) {
  console.log(`  NOT RUN — ${preFix.why}.`);
  console.log('  NOTHING IS ASSERTED IN THIS SECTION. It is not a pass. The eight shapes below are');
  console.log('  still exercised against the CURRENT parser in section 3; what is missing here is the');
  console.log('  demonstration that they used to get through. That run is on the KAN-148 pull request.');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan148-prefix-'));
  const file = path.join(tmp, 'ci-workflow-prefix.mjs');
  fs.writeFileSync(file, preFix.text);
  const old = await import(`file://${file}`);
  console.log(`  pre-fix parser loaded from ${preFix.ref}:scripts/ci-workflow.mjs\n`);
  for (const c of gaps) {
    const found = old.findRunInvocations(c.mutate(ORIGINAL), NEEDLE);
    const live = found.filter((f) => f.position === 'command' && f.disabled.length === 0);
    check(
      live.length > 0,
      `pre-fix: shape ${c.id} (${c.what}) read as a LIVE gating invocation`,
      live.length ? `ci.yml:${live.map((f) => f.line).join(', ci.yml:')} — the audit never ran and both guards said exit 0` : 'it did NOT — this shape was already caught before the change, so the ticket overstated it'
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. The matrix. Each row is applied to the real ci.yml, both guards are run
//    as processes against it, and the file is put back.
//
//    A RED row must do more than exit 1: it must produce a FAIL line from the
//    CI-WIRING assertion in each guard. Exiting 1 for some unrelated reason
//    would satisfy a weaker check and prove nothing about this parser.
// ---------------------------------------------------------------------------

console.log('\n=== 3. Every shape, through both guards ===\n');

const rows = [];
for (const c of CASES) {
  const mutated = c.mutate(ORIGINAL);
  if (c.id !== 'g1' && mutated === ORIGINAL) {
    check(false, `row ${c.id} (${c.what}) actually changed ci.yml`, 'the mutation was a no-op — it measured the baseline');
    continue;
  }
  const { reg, par } = runBoth(mutated, c.id, c.what);
  const got = reg.code === 0 && par.code === 0 ? 'GREEN' : 'RED';
  rows.push({ ...c, reg, par, got });

  if (c.want === 'RED') {
    const stopped = reg.code === 1 && reg.wiringFails.length > 0 && par.code === 1 && par.wiringFails.length > 0;
    check(
      stopped,
      `${c.id}  ${c.what} — both guards fail by name`,
      `registry exit=${reg.code} (${reg.wiringFails.length} wiring FAIL), parity exit=${par.code} (${par.wiringFails.length} wiring FAIL)`
    );
    if (c.expect) {
      const says = (rows) => rows.join('\n').includes(c.expect);
      check(
        says(reg.wiringFails) && says(par.wiringFails),
        `${c.id}  …and each says WHY: the message names \`${c.expect}\``,
        says(reg.wiringFails) && says(par.wiringFails)
          ? ''
          : `registry ${says(reg.wiringFails) ? 'does' : 'does NOT'}, parity ${says(par.wiringFails) ? 'does' : 'does NOT'} — ` +
            'a red check that cannot say which construct stopped it sends the reader back to the diff to guess'
      );
    }
  } else {
    check(
      reg.code === 0 && par.code === 0,
      `${c.id}  ${c.what} — still reads as live, both guards green`,
      `registry exit=${reg.code}, parity exit=${par.code}`
    );
  }
}

console.log('\n  --- the matrix ---\n');
const w = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(4)} ${r.what.padEnd(w)}  reg=${r.reg.code} par=${r.par.code}  ` +
      `want ${r.want.padEnd(5)} got ${r.got}${r.want === r.got ? '' : '   <-- MISMATCH'}`
  );
}

console.log('\n  --- what a reader is told, for each of the eight ---\n');
for (const r of rows.filter((x) => x.gap)) {
  console.log(`  ${r.id}  ${r.what}`);
  for (const line of r.reg.wiringFails) console.log(`      registry  ${line}`);
  for (const line of r.par.wiringFails) console.log(`      parity    ${line}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 4. The tree is exactly as it was found. This script writes a tracked file;
//    a run that left it mutated would hand the next script in the CI array a
//    workflow nobody wrote.
//
//    TWO ASSERTIONS AND NOT ONE, because the first one alone was the defect
//    KAN-172 was filed for. "Byte-identical to how this run found it" is only
//    worth anything once "how this run found it" is known to be the committed
//    file, and before the refusal at the top of this script that was not known:
//    a run started over residue restored the residue and passed this check.
//    The second assertion says what the section's title has always implied —
//    the file is CLEAN, not merely unchanged since a snapshot of unknown
//    provenance. The refusal makes the two equivalent; asserting both is what
//    makes that equivalence a measurement instead of a claim.
// ---------------------------------------------------------------------------

console.log('=== 4. ci.yml is byte-identical to how this run found it ===\n');

restore();
check(
  fs.readFileSync(workflowPath, 'utf8') === ORIGINAL,
  '.github/workflows/ci.yml restored'
);

let finalPorcelain = null;
try {
  finalPorcelain = execFileSync('git', ['status', '--porcelain', '--', WORKFLOW_REL], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
} catch { /* reported as the failure below, not swallowed */ }
check(
  finalPorcelain === '',
  '…and git agrees it is clean, so the baseline it was compared against was the committed file',
  finalPorcelain === null
    ? 'git could not be asked — this run cannot say whether it left the tree as it found it'
    : finalPorcelain || ''
);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
