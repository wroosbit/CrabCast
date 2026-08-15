#!/usr/bin/env node
// KAN-389 RED DRIVE — point a citation at something the file does not say, and
// watch the gate go red where it used to go green.
//
// WHAT FAILURE THIS WOULD CATCH: `verify-proof-registry.mjs` §2 accepting an
// exclusion's `evidence` citation that resolves to nothing. Before KAN-389 the
// citation was `scripts/<name>.mjs:<line>` and §2 checked only that the number
// was between 1 and the file's length — it never read the line. So a citation
// stayed green for as long as the file was long enough, which a citation of a
// real file always is. Measured at the time of the fix: FIVE of the sixteen
// entries pointed at a line supporting no part of their claim (a shebang, a
// blank comment line, and one 719 lines from its claim), and §2 was green for
// all five. Arm 1 reproduces that green on the pre-fix gate. Arms 2-4 require
// the replacement to go red, each on a different way of citing nothing.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS DRIVE SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
// ---------------------------------------------------------------------------
//
// Every arm WRITES the citation it then asserts on. That is what a red drive
// is, and it is also the KAN-145 shape: a script that constructs its own input
// has not shown that the input arrives. Named precisely, this drive does NOT
// establish:
//
//   * that the sixteen citations committed on `main` are accurate. It shows the
//     gate can reject a bad one, never that the ones in the tree are good. The
//     per-entry judgement behind them is a human reading recorded on KAN-389,
//     and no script owns it.
//   * that a quote which resolves actually SUPPORTS its entry's reason. Nothing
//     mechanical here judges apposite-ness; §2's own docblock says so under
//     WHAT THIS STILL DOES NOT CATCH.
//
// What it does establish is narrow and worth having: the gate's verdict changes
// when, and only when, the citation stops resolving.
//
// ---------------------------------------------------------------------------
// MUTATIONS ARE IN PLACE, BY EXACT COUNT, AND RESTORED
// ---------------------------------------------------------------------------
//
// The subject is `scripts/verify-proof-registry.mjs` itself, and it must run
// under its own name: §5 and §6 of that script assert that `ci.yml` invokes
// `node scripts/<its own basename>.mjs`, so a renamed scratch copy goes red for
// a reason that has nothing to do with citations. A red that credits the wrong
// mechanism is worse than no red, so arm 1 swaps the real file's CONTENT for
// the pre-fix version rather than running a copy under a different name.
//
// Every patch asserts EXACTLY ONE occurrence of its anchor before applying (a
// mutation that hit nothing reads exactly like a clean pass), every patch is
// undone in a `finally`, a signal handler restores on interrupt, a backup
// survives SIGKILL, and §5 requires `git status --porcelain` to be byte-
// identical to what it was before this script started.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

/** The gate under test. */
const REGISTRY = path.join('scripts', 'verify-proof-registry.mjs');

/** The exclusion whose citation every arm mutates. */
const SUBJECT = 'verify-fleet-switch-live';

/**
 * The commit the pre-fix gate is read from — the merge base this branch was cut
 * at. Pinned as a literal rather than resolved from `origin/main`, so that this
 * drive reproduces the same green after KAN-389 has landed and `main` has moved
 * past it. Arm 1 refuses to run if what comes back is not the pre-fix gate.
 */
const BASE = '5ab6881152df090bcba4571a4134e019040e7909';

/** The expression that IS the defect, used to confirm arm 1 got the right file. */
const PREFIX_MARKER = "Number(m[2]) <= fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\\n').length";

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * A child killed by a signal did not answer the question the arm asked, and
 * `status: null` read as an exit code is a non-answer wearing a verdict's
 * clothes — it looks like a failing arm, and on a green-expecting arm it looks
 * like a mechanism that broke. Report it by name and skip the arm.
 */
const signalOf = (r) => (r.status === null ? (r.signal ?? 'an unknown signal') : null);

// ---------------------------------------------------------------------------
// In-place patching with an exact-count anchor and a guaranteed restore.
// ---------------------------------------------------------------------------

/** Files this run has modified, so a crash or a Ctrl+C still puts them back. */
const open = new Map();

/** A backup that survives SIGKILL, which no handler can catch. */
const restoreDir = path.join(os.tmpdir(), `kan389-drive-restore-${process.pid}`);

function remember(rel) {
  const file = path.join(repoRoot, rel);
  if (open.has(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  open.set(file, before);
  fs.mkdirSync(restoreDir, { recursive: true });
  const backup = path.join(restoreDir, rel.replace(/[/\\]/g, '__'));
  fs.writeFileSync(backup, before);
  console.log(`  (patching ${rel}; if this run is killed: cp ${backup} ${file})`);
}

function restoreAll() {
  for (const [file, original] of open) fs.writeFileSync(file, original);
  open.clear();
  fs.rmSync(restoreDir, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restoreAll();
  console.error(e);
  process.exit(1);
});

/**
 * Replace `find` with `replace` in a tracked file, exactly once.
 *
 * @returns true when it applied. A false is already counted as a failure and
 *          the caller must skip its arm — an arm that runs against an unmutated
 *          file reports the strongest available result at the moment it tested
 *          nothing.
 */
function patch(rel, find, replace) {
  const file = path.join(repoRoot, rel);
  const before = fs.readFileSync(file, 'utf8');
  const count = before.split(find).length - 1;
  if (count !== 1) {
    check(
      false,
      `mutation anchor in ${rel} is unique`,
      `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 60))}, found ${count}. Fix the mutation, not this check.`
    );
    return false;
  }
  if (find === replace) {
    check(false, `mutation in ${rel} changes something`, 'find === replace');
    return false;
  }
  remember(rel);
  fs.writeFileSync(file, before.replace(find, replace));
  return true;
}

/** Swap a file's whole content, backed up the same way. */
function replaceContent(rel, content) {
  remember(rel);
  fs.writeFileSync(path.join(repoRoot, rel), content);
}

function unpatchAll() {
  restoreAll();
}

const gitStatus = () =>
  spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '';

const statusBefore = gitStatus();

/** Run the gate as its own filename and report exit code + output. */
function runGate() {
  const r = spawnSync(process.execPath, [REGISTRY], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env }
  });
  return { status: r.status, signal: signalOf(r), out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('=== KAN-389 RED DRIVE ===\n');

// ---------------------------------------------------------------------------
// 0. Controls: the tree is what we think it is before anything is mutated.
// ---------------------------------------------------------------------------

console.log('--- 0. Controls ---\n');

{
  const baseline = runGate();
  if (baseline.signal) {
    check(false, 'INCONCLUSIVE: the unmutated gate was killed', `by ${baseline.signal}`);
  } else {
    check(baseline.status === 0, 'the unmutated gate on this tree exits 0', `exit ${baseline.status}`);
  }
}

const subjectFile = path.join('scripts', `${SUBJECT}.mjs`);
const subjectLines = fs.readFileSync(path.join(repoRoot, subjectFile), 'utf8').split('\n');
check(
  subjectLines.length >= 500,
  `${subjectFile} is long enough for line 500 to exist`,
  `${subjectLines.length} lines`
);
console.log(`       line 500 of ${SUBJECT}.mjs reads: ${JSON.stringify(subjectLines[499])}`);
console.log('       — a real line, in range, and about nothing the exclusion claims.\n');

// ---------------------------------------------------------------------------
// 1. THE DEFECT: on the pre-fix gate, that citation is GREEN.
// ---------------------------------------------------------------------------

console.log('--- 1. The pre-fix gate accepts a citation pointing at unrelated code ---\n');

const shown = spawnSync('git', ['-C', repoRoot, 'show', `${BASE}:${REGISTRY}`], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
});
const preFix = shown.status === 0 ? (shown.stdout ?? '') : '';

if (!preFix.includes(PREFIX_MARKER)) {
  check(
    false,
    `INCONCLUSIVE: ${BASE.slice(0, 8)}:${REGISTRY} is not the pre-fix gate`,
    'the range-check expression is not in it — arm 1 skipped rather than reported'
  );
} else {
  check(true, `read the pre-fix gate from ${BASE.slice(0, 8)} — it carries the range-only check`);
  try {
    replaceContent(REGISTRY, preFix);

    const clean = runGate();
    if (clean.signal) {
      check(false, 'INCONCLUSIVE: the pre-fix gate was killed', `by ${clean.signal}`);
    } else {
      check(
        clean.status === 0,
        'control: the pre-fix gate is green on this tree BEFORE the mutation',
        `exit ${clean.status}`
      );
    }

    const applied = patch(
      REGISTRY,
      `${SUBJECT}.mjs:2 takes`,
      `${SUBJECT}.mjs:500 takes`
    );
    if (applied) {
      const mutated = runGate();
      if (mutated.signal) {
        check(false, 'INCONCLUSIVE: the mutated pre-fix gate was killed', `by ${mutated.signal}`);
      } else {
        check(
          mutated.status === 0,
          '⚠ THE DEFECT: the pre-fix gate still exits 0 with the citation pointing at line 500',
          `exit ${mutated.status} — a green is the expected, defective outcome here`
        );
        check(
          mutated.out.includes(`PASS  excluded '${SUBJECT}' cites a line of its own source`),
          '⚠ THE DEFECT: it reports the bad citation as a PASS, by name',
          'the message is true about the number and says nothing about the line'
        );
      }
    }
  } finally {
    unpatchAll();
  }
}

console.log('');

// ---------------------------------------------------------------------------
// 2-4. The replacement goes red, on three different ways of citing nothing.
// ---------------------------------------------------------------------------

console.log('--- 2. The fixed gate: a quote that is not in the file ---\n');

{
  const applied = patch(
    REGISTRY,
    "quote: '`herdr agent list` as the ground truth'",
    "quote: '`herdr pane list` as the ground truth'"
  );
  if (applied) {
    try {
      const r = runGate();
      if (r.signal) {
        check(false, 'INCONCLUSIVE: the gate was killed', `by ${r.signal}`);
      } else {
        check(r.status === 1, 'the fixed gate exits 1 on a quote the file does not carry', `exit ${r.status}`);
        check(
          r.out.includes(`FAIL  excluded '${SUBJECT}' quotes text found exactly once in its own source`),
          'it fails BY NAME, naming the entry',
          'a non-zero exit alone would not say which entry, or why'
        );
        check(r.out.includes(`not in ${subjectFile}`), 'and it says the quote is not in that file');
      }
    } finally {
      unpatchAll();
    }
  }
}

console.log('\n--- 3. The fixed gate: a quote so generic it names no single place ---\n');

{
  const applied = patch(
    REGISTRY,
    "quote: '`herdr agent list` as the ground truth'",
    "quote: 'const '"
  );
  if (applied) {
    try {
      const r = runGate();
      if (r.signal) {
        check(false, 'INCONCLUSIVE: the gate was killed', `by ${r.signal}`);
      } else {
        check(r.status === 1, 'the fixed gate exits 1 on a quote with many matches', `exit ${r.status}`);
        check(
          /FAIL {2}excluded 'verify-fleet-switch-live' quotes text found exactly once/.test(r.out),
          'it fails by name on the uniqueness half'
        );
        check(
          / matches in scripts\/verify-fleet-switch-live\.mjs — lengthen it/.test(r.out),
          'and it says how many matches there were, and what to do',
          'this is the half a bare includes() check would have passed'
        );
      }
    } finally {
      unpatchAll();
    }
  }
}

console.log('\n--- 4. The fixed gate: an entry still written in the retired flat-string form ---\n');

{
  const applied = patch(
    REGISTRY,
    `    evidence: {
      quote: '\`herdr agent list\` as the ground truth',`,
    `    evidence: 'scripts/${SUBJECT}.mjs:2 takes \`herdr agent list\` as ground truth', xxxEvidence: {
      quote: '\`herdr agent list\` as the ground truth',`
  );
  if (applied) {
    try {
      const r = runGate();
      if (r.signal) {
        check(false, 'INCONCLUSIVE: the gate was killed', `by ${r.signal}`);
      } else {
        check(r.status === 1, 'the fixed gate exits 1 on a flat-string evidence field', `exit ${r.status}`);
        check(
          r.out.includes(`FAIL  excluded '${SUBJECT}' carries a quoted citation`),
          'it fails by name on the shape check',
          'so an entry pasted from before KAN-389 stops the gate rather than passing quietly'
        );
      }
    } finally {
      unpatchAll();
    }
  }
}

// ---------------------------------------------------------------------------
// 5. The tree is exactly as it was found.
// ---------------------------------------------------------------------------

console.log('\n--- 5. The drive left nothing behind ---\n');

const statusAfter = gitStatus();
check(
  statusAfter === statusBefore,
  'git status --porcelain is byte-identical to what it was before this drive',
  statusAfter === statusBefore ? '' : `before:\n${statusBefore}\nafter:\n${statusAfter}`
);
check(
  !fs.existsSync(restoreDir),
  'the SIGKILL backup directory was removed, so no run died mid-patch',
  restoreDir
);

{
  const final = runGate();
  check(
    final.signal ? false : final.status === 0,
    'and the gate is green again on the restored tree',
    final.signal ? `killed by ${final.signal}` : `exit ${final.status}`
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
