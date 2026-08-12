#!/usr/bin/env node
// KAN-331: the `verify` job reports what each of its scripts cost, and the
// reporter that does it cannot be quietly turned into a no-op.
//
// WHAT FAILURE THIS WOULD CATCH: a `verify` job that runs its 47 proofs and
// says nothing about what they cost — the reporter deleted, commented out,
// `|| true`-d, or left running but emitting a table of fabricated numbers that
// no longer come from a clock. Also the narrower one that is easier to ship by
// accident: the timing capture removed from the loop while the reporter stays,
// which produces a complete, sorted, plausible table of zeros.
//
// WHY IT IS A PROOF AND NOT A COMMENT. KAN-331's brief says outright: "I starve
// the guard the author did not defend — if this adds a helper, a fixture or a
// reporter, assume I will make it a no-op and see whether anything notices."
// This file is what notices. `scripts/ci-timing-report.mjs` is a reporter with
// no assertions in it, so nothing else in this suite would.
//
// HOW IT TESTS THE COMMITTED THING RATHER THAN A COPY OF IT. §1 lifts the
// `run:` body of the real verify step out of `.github/workflows/ci.yml` and
// executes it, verbatim, as bash. The only substitution is the `scripts=(...)`
// array, which is replaced by three fixtures — one that sleeps, one that is
// quick, one that fails. Everything else runs as committed: the same loop, the
// same `date +%s%3N` capture, the same pipe into the same reporter.
//
// WHAT THIS SCRIPT SUPPLIES ITS OWN INPUT FOR, AND WHAT THAT LEAVES UNCOVERED
// (the disclosure `prompts/task.md` asks for, and it is load-bearing here).
//
//   1. IT SUPPLIES THE ARRAY. So it proves the loop times and attributes
//      whatever scripts it is given; it does NOT prove the committed array is
//      the real one. `verify-proof-registry` owns that, by reconciling the
//      array against tracked files, and it is a required check.
//
//   2. IT SUPPLIES THE FIXTURES' DURATIONS. A fixture that sleeps 1.2s is not
//      a proof about `verify-status-since`. What §1 establishes is that the
//      numbers on the page are MEASUREMENTS — the slow fixture must land in a
//      band around its real sleep and the quick one below it — which is
//      exactly the property a table of fabricated or zeroed numbers fails.
//      That the 46 real scripts cost what the table says they cost is not
//      provable here and is not claimed anywhere; it is the reviewer reading
//      the run.
//
//   3. IT DOES NOT RUN ON GITHUB. `$GITHUB_STEP_SUMMARY` here is a file this
//      script created and pointed the step at, so it proves the reporter
//      writes well-formed markdown to the path GitHub sets — NOT that GitHub
//      renders it. That half is an observation pasted into the PR: the actual
//      summary page of this branch's own CI run.
//
// The seam between 2 and 3 is where this file's honesty ends. Neither is
// covered by a sibling script, and I would rather say so than imply a coverage
// that does not exist.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRunInvocations } from './ci-workflow.mjs';
import { makeMutator } from './mutation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const REPORTER = path.join(HERE, 'ci-timing-report.mjs');
const COST_DOC = path.join(ROOT, 'docs', 'verify-cost.md');

let failures = 0;
const check = (ok, claim, detail = '') => {
  if (ok) console.log(`  PASS  ${claim}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${claim}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-timing-attribution-'));
const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

const { mutateScript, mutationsSkipped } = makeMutator({ distDir: ROOT, scratch, report });

// ---------------------------------------------------------------------------
// Lifting the committed run body.
// ---------------------------------------------------------------------------

const STEP_NAME = 'verify (isolatable scripts, serialized)';

/**
 * The `run:` block of the verify step, dedented, exactly as bash receives it.
 *
 * Fails closed in every direction: a step that moved, a `run:` that is no
 * longer a literal block, or a body missing either of the two things this
 * whole file is about. A reader that quietly returned a prefix would hand
 * every section below a script that cannot fail.
 */
function liftRunBody() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const stepIdx = lines.findIndex((l) => l.includes(`- name: ${STEP_NAME}`));
  if (stepIdx < 0) return { error: `no step named ${JSON.stringify(STEP_NAME)} in ci.yml` };

  const runIdx = lines.findIndex((l, i) => i > stepIdx && /^\s*run:\s*\|\s*$/.test(l));
  if (runIdx < 0 || runIdx > stepIdx + 6) {
    return { error: `the step's \`run: |\` was not found within 6 lines of ${STEP_NAME}` };
  }
  const runIndent = lines[runIdx].length - lines[runIdx].trimStart().length;

  const body = [];
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (lines[i].length - lines[i].trimStart().length <= runIndent) break;
    body.push(lines[i]);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const indents = body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  const text = body.map((l) => (l.trim() === '' ? '' : l.slice(base))).join('\n');

  if (!/^\s*scripts=\(\s*$/m.test(text)) return { error: 'the lifted body has no `scripts=(` array' };
  if (!text.includes('ci-timing-report.mjs')) {
    return { error: 'the lifted body never mentions ci-timing-report.mjs' };
  }
  return { text };
}

/** Swap the committed array for fixture names, with an exact-count guard. */
function withFixtures(body, names) {
  const open = body.match(/^[ \t]*scripts=\(\s*$/m);
  if (!open) return { error: 'no `scripts=(` to replace' };
  const start = open.index;
  const closeRe = /^[ \t]*\)\s*$/m;
  const rest = body.slice(start);
  const close = rest.match(closeRe);
  if (!close) return { error: 'the `scripts=(` array is not closed' };
  const replaced =
    body.slice(0, start) +
    `scripts=(\n${names.map((n) => `  ${n}`).join('\n')}\n)` +
    rest.slice(close.index + close[0].length);
  if (replaced === body) return { error: 'the array substitution changed nothing' };
  return { text: replaced };
}

const FIXTURES = {
  // Deliberately slow, and the number matters: §1 asserts the reported figure
  // lands in a band around it, which is what makes the table a measurement
  // rather than a well-formatted constant.
  'verify-fixture-slow': 'await new Promise((r) => setTimeout(r, 1200));\n',
  'verify-fixture-mid': 'await new Promise((r) => setTimeout(r, 400));\n',
  'verify-fixture-quick': 'process.exit(0);\n',
  'verify-fixture-failing': "console.log('fixture failing on purpose');\nprocess.exit(1);\n"
};

/**
 * Run a lifted body against fixtures in a throwaway tree.
 *
 * The tree carries a REAL copy of ci.yml, because the reporter reads the hang
 * bound out of the workflow — handing it a tree without one would test the
 * error path while looking like the happy one.
 */
function runBlock({ body, names, reporter = REPORTER, label }) {
  const tree = path.join(scratch, `tree-${label}`);
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tree, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'runner-temp'), { recursive: true });

  for (const n of names) {
    const src = FIXTURES[n];
    if (!src) throw new Error(`no fixture named ${n}`);
    fs.writeFileSync(path.join(tree, 'scripts', `${n}.mjs`), src);
  }
  fs.copyFileSync(reporter, path.join(tree, 'scripts', 'ci-timing-report.mjs'));
  fs.copyFileSync(WORKFLOW, path.join(tree, '.github', 'workflows', 'ci.yml'));

  const summaryPath = path.join(tree, 'summary.md');
  fs.writeFileSync(summaryPath, '');
  const runPath = path.join(tree, 'run.sh');
  fs.writeFileSync(runPath, body);

  const r = spawnSync('bash', [runPath], {
    cwd: tree,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: path.join(tree, 'runner-temp'),
      GITHUB_STEP_SUMMARY: summaryPath
    }
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    summary: fs.readFileSync(summaryPath, 'utf8')
  };
}

/** Seconds the report attributes to `name`, or null if it is not in the table. */
function reportedSeconds(text, name) {
  const re = new RegExp(`^\\s*\\d+\\s+(\\d+\\.\\d)\\s+.*\\b${name}\\b`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

/** The rank-1 script name in the stdout table. */
function slowestInTable(text) {
  const m = text.match(/^\s*1\s+\d+\.\d\s+\S+\s+\S+\s+(\S+)/m);
  return m ? m[1] : null;
}

const CAVEAT_FRAGMENT = 'cannot tell a slow script from an unlucky one';
const BUDGET_FRAGMENT = 'No budget: nothing here fails on a number';
const BOUND_FRAGMENT = 'hang bound on this job';

// ---------------------------------------------------------------------------
console.log('=== 1. The committed verify block times its scripts and attributes them ===\n');
// ---------------------------------------------------------------------------

const lifted = liftRunBody();
check(!lifted.error, 'the verify step\'s `run:` body can be lifted from ci.yml', lifted.error ?? 'lifted');

let baseline = null;
if (!lifted.error) {
  const names = ['verify-fixture-quick', 'verify-fixture-slow', 'verify-fixture-mid'];
  const swapped = withFixtures(lifted.text, names);
  check(!swapped.error, 'the `scripts=(` array can be swapped for fixtures', swapped.error ?? 'swapped');

  if (!swapped.error) {
    baseline = runBlock({ body: swapped.text, names, label: 'baseline' });

    check(baseline.code === 0, 'the block exits 0 when every fixture passes', `exit ${baseline.code}`);
    check(
      baseline.stdout.includes('=== verify cost:'),
      'the block prints a cost report',
      baseline.stdout.includes('=== verify cost:') ? '' : `stdout was: ${baseline.stdout.slice(-400)}`
    );

    for (const n of names) {
      check(baseline.stdout.includes(n), `the report names ${n}`);
    }

    check(
      slowestInTable(baseline.stdout) === 'verify-fixture-slow',
      'the table ranks the deliberately slow fixture first',
      `rank 1 was ${slowestInTable(baseline.stdout)}`
    );

    // THE ASSERTION THAT MAKES THIS A MEASUREMENT. A reporter printing zeros,
    // or constants, or the numbers it was handed last time, fails here and
    // passes everything above.
    const slow = reportedSeconds(baseline.stdout, 'verify-fixture-slow');
    const quick = reportedSeconds(baseline.stdout, 'verify-fixture-quick');
    check(
      slow !== null && slow >= 1.0 && slow <= 8.0,
      'the slow fixture is reported in a band around the 1.2s it really sleeps',
      `reported ${slow}s`
    );
    check(
      quick !== null && quick < 1.0,
      'the quick fixture is reported below the slow one, so the figures track real elapsed time',
      `reported ${quick}s`
    );

    check(baseline.stdout.includes(CAVEAT_FRAGMENT), 'the report states it is one run and cannot detect a flake');
    check(baseline.stdout.includes(BUDGET_FRAGMENT), 'the report states that nothing here fails on a number');
    check(baseline.stdout.includes(BOUND_FRAGMENT), 'the report prints the loop as a share of the hang bound');

    // The step-summary rendering, which is the whole point of the change: a
    // log nobody opens was already carrying these numbers.
    check(baseline.summary.trim() !== '', 'a step summary was written to $GITHUB_STEP_SUMMARY');
    check(baseline.summary.includes('### verify cost'), 'the summary carries the cost heading');
    check(
      baseline.summary.includes('| # | script | seconds | share | cumulative |'),
      'the summary carries a markdown table GitHub can render'
    );
    for (const n of names) {
      check(baseline.summary.includes(n), `the summary names ${n}`);
    }
    check(baseline.summary.includes(CAVEAT_FRAGMENT), 'the summary carries the one-run caveat too');
    check(baseline.summary.includes(BOUND_FRAGMENT), 'the summary carries the hang-bound ratio too');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1b. A row the reporter cannot parse is NAMED, not dropped ===\n');
// ---------------------------------------------------------------------------
//
// ADDED IN REVIEW, and the review is the point of the section. The reporter
// carried this branch with a comment explaining why it matters — "a silently
// skipped script is a script the table implies does not exist" — and nothing
// exercised it. `epic/KAN-59` deleted the branch on #82, got a green run, and
// asked for a guard or a disclosure. This is the guard.
//
// WHY IT IS WORTH ONE: a dropped row does not render as an error. It renders
// as A SCRIPT THAT APPEARS NOT TO HAVE RUN, in the one artifact this whole
// change exists to produce, read by somebody asking "which of 47 moved?" —
// so the failure mode is a confident answer with the broken script missing
// from it. That is this ticket's own defect one level down, inside its fix.
//
// DRIVEN DIRECTLY RATHER THAN THROUGH THE LOOP, deliberately: the workflow's
// bash cannot emit a malformed row, so a row like this only ever arrives from
// a bug. Driving the reporter is what tests the branch; routing fabricated
// text through the loop would test the fixture.

{
  const runReporter = (bin, input, label) => {
    const summaryPath = path.join(scratch, `summary-${label}.md`);
    fs.writeFileSync(summaryPath, '');
    const r = spawnSync('node', [bin], {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath }
    });
    return { ...r, summary: fs.readFileSync(summaryPath, 'utf8') };
  };

  // Two readable rows and three that are not, one per way a row can be wrong.
  const MALFORMED = [
    ['verify-nonnumeric', 'verify-nonnumeric\t1000\tnot-a-number\tPASSED'],
    ['verify-backwards', 'verify-backwards\t5000\t2000\tPASSED'],
    ['verify-missing-end', 'verify-missing-end\t1000\t\tPASSED']
  ];
  const input =
    'verify-readable-slow\t1000\t4000\tPASSED\n' +
    MALFORMED.map(([, line]) => line).join('\n') +
    '\nverify-readable-fast\t1000\t1100\tPASSED\n';

  const good = runReporter(REPORTER, input, 'malformed-good');
  check(good.status === 0, 'PRECONDITION the reporter still exits 0 over a mix of readable and unreadable rows', `exit ${good.status}`);
  check(
    reportedSeconds(good.stdout, 'verify-readable-slow') === 3.0,
    'the readable rows are still timed and ranked',
    `verify-readable-slow reported ${reportedSeconds(good.stdout, 'verify-readable-slow')}s`
  );
  for (const [name] of MALFORMED) {
    check(good.stdout.includes(name), `the unreadable row ${name} is NAMED in the log rendering`);
    check(good.summary.includes(name), `the unreadable row ${name} is NAMED in the step summary`);
  }
  check(
    /3 row\(s\) could not be read/.test(good.stdout),
    'the count of unreadable rows is stated rather than left to be noticed',
    good.stdout.match(/\d+ row\(s\) could not be read/)?.[0] ?? 'no count line'
  );

  // And the mutation `epic/KAN-59` ran by hand on #82, now owned by a check.
  const mutant = mutateScript('malformed-rows-dropped', REPORTER, [
    {
      find:
        "      rows.push({ name: name || '(unnamed)', s: NaN, verdict: verdict ?? '?', malformed: true });\n" +
        '      continue;',
      replace: '      continue;'
    }
  ]);
  if (mutant) {
    const starved = runReporter(mutant, input, 'malformed-starved');
    // The precondition that makes the absence below mean something: a mutant
    // that crashed would also fail to name them, for the wrong reason.
    check(
      starved.status === 0 && starved.stdout.includes('=== verify cost:'),
      'PRECONDITION the starved reporter still runs and still prints a table',
      `exit ${starved.status}`
    );
    check(
      reportedSeconds(starved.stdout, 'verify-readable-slow') === 3.0,
      'PRECONDITION the starved reporter still times the readable rows — the loss is silent, not total'
    );
    const named = MALFORMED.filter(([name]) => starved.stdout.includes(name) || starved.summary.includes(name));
    check(
      named.length === 0,
      'MUTANT dropping the branch loses all three unreadable rows without a word — §1b goes red',
      named.length ? `still named: ${named.map(([n]) => n).join(', ')}` : 'none named anywhere'
    );
    check(
      !/row\(s\) could not be read/.test(starved.stdout),
      'MUTANT the count line goes too, so nothing in the output says anything is missing'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. A failing script still fails the job, and is still attributed ===\n');
// ---------------------------------------------------------------------------
//
// The risk a reporter introduces is not that it under-reports. It is that it
// sits between the loop and the step's exit status and swallows a verdict —
// the job's own version of a lying green. `set -o pipefail` and the ordering
// in the block are what prevent that, and neither is visible by reading.

if (!lifted.error) {
  const names = ['verify-fixture-quick', 'verify-fixture-failing', 'verify-fixture-slow'];
  const swapped = withFixtures(lifted.text, names);
  if (!swapped.error) {
    const red = runBlock({ body: swapped.text, names, label: 'failing' });
    check(red.code !== 0, 'the block still exits non-zero when a script fails', `exit ${red.code}`);
    check(
      red.stdout.includes('FAILED: verify-fixture-failing'),
      'the failing script is still named in the verdict'
    );
    check(
      red.stdout.includes('=== verify cost:'),
      'the cost report is still produced on a failing run — attribution is most wanted when something broke'
    );
    check(
      red.stdout.includes('verify-fixture-failing') && /verify-fixture-failing.*\[FAILED\]/.test(red.stdout),
      'the failing script is marked FAILED in the table rather than silently timed'
    );
    check(
      red.summary.includes('**FAILED**') || red.summary.includes('FAILED'),
      'the summary marks the failure too'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. The checks above can go red — four mutations, each watched ===\n');
// ---------------------------------------------------------------------------

// (a) THE ATTACK KAN-331 NAMES BY NAME: the reporter made a no-op.
{
  const mutant = mutateScript('reporter-noop', REPORTER, [
    {
      find: "const input = fs.readFileSync(0, 'utf8');",
      replace: "process.exit(0);\nconst input = fs.readFileSync(0, 'utf8');"
    }
  ]);
  if (mutant && !lifted.error) {
    const names = ['verify-fixture-quick', 'verify-fixture-slow'];
    const swapped = withFixtures(lifted.text, names);
    const out = runBlock({ body: swapped.text, names, reporter: mutant, label: 'reporter-noop' });
    // The precondition: the mutant really is the thing that ran. A mutant that
    // died on startup produces the same empty stdout as one that no-opped.
    check(
      out.stderr.trim() === '',
      'PRECONDITION the no-op reporter ran rather than crashing',
      out.stderr.trim() ? `stderr: ${out.stderr.slice(0, 200)}` : 'clean'
    );
    check(
      !out.stdout.includes('=== verify cost:'),
      'MUTANT a no-opped reporter produces no cost report — §1 would go red'
    );
    check(
      out.summary.trim() === '',
      'MUTANT a no-opped reporter writes no step summary — §1 would go red'
    );
  }
}

// (b) The subtler one: the reporter survives, the CLOCK does not. This is the
//     shape that ships by accident, because the output still looks complete.
if (!lifted.error) {
  const bodyPath = path.join(scratch, 'lifted-run.sh');
  fs.writeFileSync(bodyPath, lifted.text);
  const mutantBody = mutateScript('timing-capture-removed', bodyPath, [
    { find: 't1=$(date +%s%3N)', replace: 't1=$t0' }
  ]);
  if (mutantBody) {
    const names = ['verify-fixture-quick', 'verify-fixture-slow'];
    const swapped = withFixtures(fs.readFileSync(mutantBody, 'utf8'), names);
    const out = runBlock({ body: swapped.text, names, label: 'no-clock' });
    check(
      out.stdout.includes('=== verify cost:'),
      'PRECONDITION the table is still produced with the clock removed — this mutation is invisible in shape'
    );
    const slow = reportedSeconds(out.stdout, 'verify-fixture-slow');
    check(
      slow === 0,
      'MUTANT with the clock removed the slow fixture reports 0.0s — §1\'s band assertion goes red',
      `reported ${slow}s`
    );
  }
}

// (c) The caveat deleted. Cheap to run directly: this one is the reporter's
//     own text, and driving the whole loop to check a sentence is waste.
{
  const mutant = mutateScript('caveat-deleted', REPORTER, [
    { find: CAVEAT_FRAGMENT, replace: 'is completely reliable' }
  ]);
  if (mutant) {
    const r = spawnSync('node', [mutant], {
      cwd: ROOT,
      input: 'verify-a\t1000\t2000\tPASSED\nverify-b\t1000\t1050\tPASSED\n',
      encoding: 'utf8'
    });
    check(r.status === 0, 'PRECONDITION the caveat mutant still runs', `exit ${r.status}`);
    check(
      !r.stdout.includes(CAVEAT_FRAGMENT),
      'MUTANT deleting the one-run caveat is caught — §1 goes red'
    );
  }
}

// (d) The hang-bound ratio hardcoded rather than read. This is the mutation
//     that matters most for KAN-331's push: the whole reason the number is
//     READ is so that editing ci.yml moves the printed percentage. A constant
//     satisfies every other assertion in this file.
{
  const mutant = mutateScript('bound-hardcoded', REPORTER, [
    { find: "function hangBound(workflowPath = '.github/workflows/ci.yml') {", replace: "function hangBound(workflowPath = '.github/workflows/ci.yml') {\n  return { minutes: 20 };" }
  ]);
  if (mutant) {
    // A tree whose ci.yml says 40 rather than 20. A reporter that READS gets
    // 40; a reporter carrying a constant still says 20.
    const tree = path.join(scratch, 'bound-tree');
    fs.mkdirSync(path.join(tree, '.github', 'workflows'), { recursive: true });
    const edited = fs
      .readFileSync(WORKFLOW, 'utf8')
      .replace(/^(\s*)timeout-minutes: 20$/m, '$1timeout-minutes: 40');
    fs.writeFileSync(path.join(tree, '.github', 'workflows', 'ci.yml'), edited);
    check(
      edited.includes('timeout-minutes: 40'),
      'PRECONDITION the probe tree really declares a different bound'
    );

    const input = 'verify-a\t0\t60000\tPASSED\n';
    const honest = spawnSync('node', [REPORTER], { cwd: tree, input, encoding: 'utf8' });
    const fake = spawnSync('node', [mutant], { cwd: tree, input, encoding: 'utf8' });
    check(
      honest.stdout.includes('40-minute hang bound'),
      'the committed reporter READS the bound out of the workflow it is run against',
      honest.stdout.match(/\d+-minute hang bound/)?.[0] ?? 'no bound line'
    );
    check(
      fake.stdout.includes('20-minute hang bound'),
      'MUTANT a hardcoded bound ignores the workflow — the ratio would silently stop tracking',
      fake.stdout.match(/\d+-minute hang bound/)?.[0] ?? 'no bound line'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. The reporter is WIRED — a live command in the committed workflow ===\n');
// ---------------------------------------------------------------------------
//
// §1 proves the block works when it is run. This asks the different question
// KAN-148 exists for: does the block committed here still RUN it? A reporter
// behind `|| true`, or commented out, passes every section above.

{
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const hits = findRunInvocations(yaml, /node scripts\/ci-timing-report\.mjs/);
  check(hits.length === 1, 'ci-timing-report.mjs is invoked exactly once in the workflow', `found ${hits.length}`);
  const hit = hits[0];
  if (hit) {
    check(hit.job === 'verify', 'it is invoked from the verify job', `job: ${hit.job}`);
    // It sits at the end of a pipeline (`printf … | node …`), which the reader
    // classifies as a command whose status reaches the step under pipefail.
    check(
      hit.position === 'command',
      'it begins a command rather than being mentioned, quoted or buried',
      `position: ${hit.position}${hit.note ? ` (${hit.note})` : ''}`
    );
    check(
      hit.disabled.length === 0,
      'nothing in the step disables it or swallows its exit status',
      hit.disabled.join('; ')
    );
  }

  // And the same reader, shown a workflow where it HAS been switched off.
  const off = yaml.replace(
    'printf \'%s\\n\' "${timings[@]}" | node scripts/ci-timing-report.mjs',
    'printf \'%s\\n\' "${timings[@]}" | node scripts/ci-timing-report.mjs || true'
  );
  check(off !== yaml, 'PRECONDITION the `|| true` probe really edited the workflow text');
  const offHits = findRunInvocations(off, /node scripts\/ci-timing-report\.mjs/);
  check(
    offHits.length === 1 && offHits[0].disabled.length > 0,
    'MUTANT a `|| true` on the reporter is reported as disabled — this section goes red',
    offHits[0] ? `disabled: ${offHits[0].disabled.join('; ') || '(none — NOT CAUGHT)'}` : 'not found'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. The document and the workflow agree about the number ===\n');
// ---------------------------------------------------------------------------
//
// docs/verify-cost.md states the hang bound in prose. That is the last
// remaining copy of a number that lives in ci.yml, and a document quoting a
// figure the workflow no longer carries is this epic's named failure — a claim
// outliving the evidence that made it true.

{
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const doc = fs.readFileSync(COST_DOC, 'utf8');

  const inYaml = [...yaml.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) => m[1]);
  check(inYaml.length === 1, 'ci.yml declares exactly one `timeout-minutes:`', `found ${inYaml.length}`);

  const inDoc = [...doc.matchAll(/`timeout-minutes:\s*(\d+)`/g)].map((m) => m[1]);
  check(inDoc.length >= 1, 'docs/verify-cost.md states the bound', `found ${inDoc.length} mention(s)`);
  check(
    inDoc.every((v) => v === inYaml[0]),
    'every number the document quotes matches the workflow',
    `doc says ${[...new Set(inDoc)].join('/')}, workflow says ${inYaml[0]}`
  );

  // Watched going red, because "they match" is the assertion that is true by
  // accident on the day it is written and never checked again.
  const drifted = doc.replace(/`timeout-minutes:\s*\d+`/, '`timeout-minutes: 999`');
  check(drifted !== doc, 'PRECONDITION the drift probe really edited the document text');
  const driftedNums = [...drifted.matchAll(/`timeout-minutes:\s*(\d+)`/g)].map((m) => m[1]);
  check(
    !driftedNums.every((v) => v === inYaml[0]),
    'MUTANT a document quoting a stale bound is caught — this section goes red'
  );

  check(
    doc.includes('There is no budget'),
    'the document records the decision rather than describing an absence'
  );
}

// ---------------------------------------------------------------------------
const skipped = mutationsSkipped();
console.log('');
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY: ${skipped.join(', ')} — those sections did not run.`);
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
