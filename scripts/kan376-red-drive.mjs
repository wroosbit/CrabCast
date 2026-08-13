#!/usr/bin/env node
// KAN-376 RED DRIVE — what actually stops a FOURTH activate-refusal kind, and
// which of the two claims about it was false.
//
// WHAT FAILURE THIS WOULD CATCH: a new member of `ActivateRefusalKind` reaching
// the wire with no row in the document and no branch carrying it — and, one
// level up, an ARTIFACT CLAIMING A MECHANISM IT DOES NOT HAVE. `src/router.ts`
// and §11 of `docs/read-path-contract.md` both said a new refusal kind "does not
// compile until it has a line in the declaration AND a row in the document".
// The compiler cannot see the document. This drive is what turned that from a
// sentence into a measurement, and arm 2 is the arm that found it: the tree
// typechecks CLEAN with a fourth kind published and undocumented.
//
// THE POINT IS NOT THAT SOMETHING GOES RED. Two mechanisms hold the two halves
// and both work; the defect was one sentence crediting the wrong one for half
// its job. So each arm asserts WHICH mechanism fired, by name, and an arm that
// goes red for the right reason by the wrong route is reported as a failure of
// this drive rather than as a success of the guard.
//
// FIVE ARMS, AND THE FIRST IS THE CONTROL:
//
//   control        unmutated tree. `tsc` exits 0 AND §1 of the proof reports no
//                  problems. A red drive whose baseline is not demonstrated is
//                  measuring the runner as much as the guard.
//   union-only     a fourth member added to `ActivateRefusalKind` ALONE.
//                  Expected: `tsc` FAILS, and the diagnostic names the
//                  `Exact<>` binding's line in src/router.ts. This is the half
//                  of the old claim that was TRUE.
//   union+values   the same member added to `VALUE_SETS.activateRefused` too,
//                  document untouched. ⚠ Expected: `tsc` SUCCEEDS — the old
//                  claim's second half is false — and §1 goes red naming
//                  `values activateRefused`.
//   fully-declared the member added to the union, to `VALUE_SETS` AND to §9's
//                  table, so the two checks above are both satisfied. Expected:
//                  §1 STILL goes red, on the rule join added by KAN-376, because
//                  no branch carries the new kind. Without that join this arm is
//                  green — which is why the join exists.
//   branch-only    `refused` added to `spawn-error`'s `always` list with no new
//                  member anywhere. Expected: §1 red on the same join, from the
//                  other direction.
//
// WHY THE LAST TWO ARE THE ONES WORTH HAVING. Arms 1 and 2 exercise guards that
// already existed. Arms 3 and 4 exercise the guard this ticket added, and each
// drives it from one direction — a member with no branch, a branch with no
// member. A join asserted in one direction only is half a join.
//
// EACH RED IS ASSERTED BY NAME, not by exit code. The proof's §1 has many other
// reasons to report a problem, and crediting one of those for a refusal-kind
// failure is exactly the misattribution this epic keeps paying for. So each arm
// greps the problem list for the sentence about the thing it mutated, and the
// arm is RED-FOR-THE-WRONG-REASON — a failure — if that sentence is absent even
// when other problems are present.
//
// MUTATIONS ARE SOURCE-LEVEL, NOT `dist`-LEVEL, which is why this does not use
// `scripts/mutation.mjs`: three of the five arms are about what the COMPILER
// does, and a mutated `dist` has already been compiled. Each mutation asserts an
// EXACT occurrence count on its anchor before editing and an exact count of the
// mutant afterwards, and a drifted anchor is a counted verdict rather than a
// throw — the property mutation.mjs exists to guarantee, applied here by hand
// because its subject is different.
//
// ⚠ A FAILING `tsc` IS THE EXPECTED RESULT ON ARM 1, so this drive must not
// confuse "the mutation does not compile because it is malformed" with "the
// mutation does not compile because the binding caught it". Arm 1 asserts the
// diagnostic names `src/router.ts` and the TS error code, not merely that the
// exit was non-zero.
//
// WHAT THIS DOES NOT COVER: it never starts a daemon, so it says nothing about
// §2d — whether a branch's key set on the WIRE matches its declaration. That is
// the proof's own live half and `scripts/kan328-red-drive.mjs` drives it. This
// drive is entirely static: document, declaration and compiler.
//
// NOT A PROOF AND NOT IN THE CI ARRAY, like `kan328-red-drive.mjs` and
// `kan349-red-drive.mjs`: a one-off demonstration whose output belongs in a pull
// request rather than in a gate. Recorded in `docs/moving-baselines.md`. It
// copies the tree into a scratch directory and never touches the working tree.
//
// Usage:
//   npm run build
//   node scripts/kan376-red-drive.mjs
//   node scripts/kan376-red-drive.mjs --only union+values
//   node scripts/kan376-red-drive.mjs --list

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

let failures = 0;
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const pass = (label, detail) => console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail) => {
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const MEMBER = 'doctored-kind';

// --------------------------------------------------------------- the arms --

const ARMS = {
  control: {
    what: 'unmutated tree — tsc exits 0 and §1 reports nothing',
    mutate: () => [],
    expectTsc: 'pass',
    expectProblem: null
  },
  'union-only': {
    what: 'a fourth member in ActivateRefusalKind alone — the compiler must refuse it',
    mutate: (root) => [mutateUnion(root)],
    expectTsc: 'fail',
    expectProblem: null
  },
  'union+values': {
    what: 'union + VALUE_SETS, document untouched — tsc PASSES, §1 must catch it',
    mutate: (root) => [mutateUnion(root), mutateValueSets(root)],
    expectTsc: 'pass',
    expectProblem: /values activateRefused: declared \[[^\]]*\], documented \[[^\]]*\]/
  },
  'fully-declared': {
    what: 'union + VALUE_SETS + §9 row — only the KAN-376 rule join is left to catch it',
    mutate: (root) => [mutateUnion(root), mutateValueSets(root), mutateDocTable(root)],
    expectTsc: 'pass',
    expectProblem: /the refusal-kind rule \(§8 note 2\): branches carrying `refused` are/
  },
  'branch-only': {
    what: '`refused` added to spawn-error’s always list — the same join, other direction',
    mutate: (root) => [mutateBranch(root)],
    expectTsc: 'pass',
    expectProblem: /the refusal-kind rule \(§8 note 2\): branches carrying `refused` are/
  }
};

// ------------------------------------------------------ mutation primitives --

/**
 * One edit, with the two assertions `mutation.mjs` makes about every mutation:
 * the anchor occurs EXACTLY once before, and the replacement occurs EXACTLY the
 * expected number of times after. A drifted anchor returns a description of the
 * failure rather than throwing, so the caller can skip its arm and let the rest
 * of the drive run.
 */
function edit(file, find, replace, label) {
  const text = fs.readFileSync(file, 'utf8');
  const before = text.split(find).length - 1;
  if (before !== 1) {
    return { error: `${label}: anchor found ${before}x, expected exactly 1. Fix the mutation, not this check.` };
  }
  if (find === replace) {
    return { error: `${label}: replacement equals the anchor — a mutation that changes nothing proves nothing.` };
  }
  const next = text.replace(find, replace);
  fs.writeFileSync(file, next);
  const after = next.split(replace).length - 1;
  if (after !== 1) {
    return { error: `${label}: mutant present ${after}x after the edit, expected exactly 1.` };
  }
  return { applied: `${label}: 1 occurrence replaced` };
}

const mutateUnion = (root) =>
  edit(
    path.join(root, 'src', 'router.ts'),
    `export type ActivateRefusalKind = 'not-configured' | 'unverifiable' | 'occupied';`,
    `export type ActivateRefusalKind = 'not-configured' | 'unverifiable' | 'occupied' | '${MEMBER}';`,
    'union'
  );

const mutateValueSets = (root) =>
  edit(
    path.join(root, 'src', 'read-contract.ts'),
    `  activateRefused: ['not-configured', 'unverifiable', 'occupied'],`,
    `  activateRefused: ['not-configured', 'unverifiable', 'occupied', '${MEMBER}'],`,
    'VALUE_SETS'
  );

const mutateDocTable = (root) =>
  edit(
    path.join(root, 'docs', 'read-path-contract.md'),
    `| \`occupied\` | live panes are in that directory and none of them is ours |`,
    `| \`occupied\` | live panes are in that directory and none of them is ours |\n| \`${MEMBER}\` | a row added by the KAN-376 red drive |`,
    'document §9 row'
  );

const mutateBranch = (root) =>
  edit(
    path.join(root, 'src', 'read-contract.ts'),
    `  'spawn-error': {
    always: ['action', 'success', 'started', 'error', 'path'],`,
    `  'spawn-error': {
    always: ['action', 'success', 'started', 'error', 'path', 'refused'],`,
    'spawn-error branch'
  );

// ------------------------------------------------------------- the harness --

/** A scratch copy of the tree, with node_modules symlinked rather than copied. */
function scratchTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan376-drive-'));
  for (const entry of ['src', 'scripts', 'docs', 'package.json', 'tsconfig.json', 'crabcast.config.json']) {
    fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

/** `tsc --noEmit`, exit code read directly rather than through a pipe. */
function typecheck(root) {
  const r = spawnSync('npx', ['tsc', '--noEmit'], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * §1 of the REAL proof — document ↔ declaration — run against the mutated tree's
 * own build via `--static-only`.
 *
 * IT RUNS `verify-read-contract.mjs` ITSELF rather than a reimplementation of
 * its §1, and that is not a convenience. A drive that copies the check it is
 * driving proves its own copy can go red and says nothing about the guard in
 * CI — the exact shape of defect this suite exists to find. The cost of running
 * the real thing is one flag.
 *
 * THE BUILD IS CHECKED BEFORE THE VERDICT IS READ. §1 imports from `dist`, so a
 * failed build would have it reconciling the document against the PREVIOUS
 * compile — and both outcomes would mislead, a pass reading as "the mutation
 * was not caught" and a red crediting this guard for something else.
 */
function sectionOneProblems(root) {
  const build = spawnSync('npx', ['tsc'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    return { error: `build exited ${build.status}, so §1 would read a stale dist:\n${build.stdout}` };
  }
  const r = spawnSync('node', [path.join(root, 'scripts', 'verify-read-contract.mjs'), '--static-only'], {
    cwd: root,
    encoding: 'utf8'
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!/SECTION 1 (PASSED|.*FAILED)|CHECK\(S\) FAILED in section 1/.test(out)) {
    return { error: `§1 did not reach its own verdict line — the run died early:\n${out}` };
  }
  // The problem lines §1 prints, each as `     ! <text>`.
  const problems = out
    .split('\n')
    .filter((l) => /^\s+!\s/.test(l))
    .map((l) => l.replace(/^\s+!\s/, '').trim());
  return { problems, exit: r.status, out };
}

// ------------------------------------------------------------------- drive --

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [name, arm] of Object.entries(ARMS)) console.log(`${name.padEnd(16)} ${arm.what}`);
  process.exit(0);
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const selected = only ? { [only]: ARMS[only] } : ARMS;
if (only && !ARMS[only]) {
  console.log(`No such arm: ${only}. Try --list.`);
  process.exit(2); // setup guard, not a verdict
}

if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
  console.log('SETUP: node_modules is missing — run `npm ci` first.');
  process.exit(2); // setup guard, not a verdict
}

for (const [name, arm] of Object.entries(selected)) {
  rule(`ARM ${name} — ${arm.what}`);
  const root = scratchTree();
  try {
    let drifted = false;
    for (const result of arm.mutate(root)) {
      if (result.error) {
        fail(`${name}: mutation`, result.error);
        drifted = true;
      } else {
        pass(`${name}: mutation`, result.applied);
      }
    }
    if (drifted) {
      console.log('   (arm skipped — its mutation did not apply as designed)');
      continue;
    }

    const tsc = typecheck(root);
    const tscOk = arm.expectTsc === 'pass' ? tsc.code === 0 : tsc.code !== 0;
    if (tscOk) {
      pass(`${name}: tsc`, `exit ${tsc.code}, expected to ${arm.expectTsc}`);
    } else {
      fail(`${name}: tsc`, `exit ${tsc.code}, expected to ${arm.expectTsc}\n${tsc.out}`);
    }

    if (arm.expectTsc === 'fail') {
      // The compiler must have refused it for the RIGHT reason: the Exact<>
      // binding in router.ts, not a syntax error in the mutation.
      const named = /src\/router\.ts\(\d+,\d+\): error TS\d+/.test(tsc.out);
      (named ? pass : fail)(
        `${name}: the diagnostic names the binding`,
        named ? tsc.out.trim().split('\n')[0] : `no src/router.ts diagnostic in:\n${tsc.out}`
      );
      continue; // nothing to build, so §1 cannot be run on this arm
    }

    const s1 = sectionOneProblems(root);
    if (s1.error) {
      fail(`${name}: §1`, s1.error);
      continue;
    }
    if (arm.expectProblem === null) {
      (s1.problems.length === 0 ? pass : fail)(
        `${name}: §1 reports nothing`,
        s1.problems.length ? `${s1.problems.length} problem(s): ${s1.problems.join(' | ')}` : 'clean'
      );
    } else {
      const hit = s1.problems.find((p) => arm.expectProblem.test(p));
      if (hit) {
        pass(`${name}: §1 red BY NAME`, hit);
      } else {
        fail(
          `${name}: §1 did not report the expected problem`,
          s1.problems.length
            ? `RED FOR THE WRONG REASON — ${s1.problems.length} other problem(s): ${s1.problems.join(' | ')}`
            : 'no problems at all — the guard did not fire'
        );
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

rule(`VERDICT: ${failures === 0 ? 'every arm behaved as designed' : `${failures} arm assertion(s) failed`}`);
process.exit(failures ? 1 : 0);
