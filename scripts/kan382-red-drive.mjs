#!/usr/bin/env node
// KAN-382 RED DRIVE — the STATIC half of publishing `pathProblem`: which
// mechanism actually stops a sixth path cause reaching the wire undocumented,
// and whether the premise this ticket was filed on still holds at this head.
//
// WHAT FAILURE THIS WOULD CATCH: a contract that CLAIMS the compiler holds a
// closed vocabulary when nothing does — an artifact whose sentence covers more
// than its mechanism. `src/identity.ts` and §9 of the document both now say a
// sixth `PathProblem` member "is a compile error until it is published". That is
// the same sentence KAN-376 measured FALSE about `ActivateRefusalKind` in one of
// its two halves, so it is measured here rather than asserted: arm `type-only`
// is what turns it from a claim into a result, and arm `type+values` is what
// finds its limit — the compiler cannot see the document, and the tree
// typechecks CLEAN with a sixth cause published and undocumented.
//
// THE POINT IS NOT THAT SOMETHING GOES RED. Two mechanisms hold two different
// halves and both work. So each arm asserts WHICH one fired, by name, and an arm
// that goes red for the right reason by the wrong route is reported as a failure
// of this drive rather than as a success of the guard.
//
// SECTION 0 IS THE PREMISE CHECK, and it is here rather than in a comment
// because a citation is a claim about a file at a commit, not a fact. Every
// counter runs TWICE — once against the real file, once against a doctored copy
// that MUST change the answer — and a counter that reads the same on both arms
// is reported DISCARDED rather than quoted. Counting off the property that
// defines the thing rather than off how it is spelled: `PathProblem`'s members
// come from the union declaration with its doc comments stripped, so a literal
// quoted in prose cannot inflate it.
//
// FIVE ARMS, AND THE FIRST IS THE CONTROL:
//
//   control          unmutated tree. `tsc` exits 0 AND §1 of the real proof
//                    reports nothing. A red drive whose baseline is not
//                    demonstrated is measuring the runner as much as the guard.
//   type-only        a sixth member added to `PathProblem` in src/identity.ts
//                    ALONE. Expected: `tsc` FAILS, and the diagnostic names
//                    src/read-contract.ts — the `Exact<>` binding, not a syntax
//                    error in the mutation. This is the half of the claim that
//                    is TRUE.
//   type+values      the same member added to `VALUE_SETS.pathProblem` too,
//                    document untouched. ⚠ Expected: `tsc` SUCCEEDS — the
//                    claim's limit — and §1 goes red naming `values pathProblem`.
//   branch-drop      `pathProblem` removed from the `bad-address` branch's
//                    `always` list, the field left declared. Expected: `tsc`
//                    SUCCEEDS and §1 goes red on the branch table, because
//                    "mandatory on that branch" is held by a declaration the
//                    compiler has no view of.
//   field-undeclared `pathProblem` removed from ACTIVATE_RESPONSE_FIELDS while
//                    the branch still names it. Expected: §1 red from the other
//                    direction — a branch naming a key no field table declares.
//
// WHY THE LAST TWO. Arm 2 exercises a guard the compiler owns and arm 3 one the
// proof owns; arms 4 and 5 exercise the pair of joins that make MANDATORY mean
// something, each from one direction. A join asserted in one direction only is
// half a join.
//
// WHAT THIS DOES NOT COVER: it never starts a daemon, so it says nothing about
// whether the field is on the WIRE or whether it DISCRIMINATES. That is
// `scripts/verify-path-problem.mjs`, which produces four causes against a real
// daemon and mutates the build to watch its own checks fail. Neither subsumes
// the other, and the gap between them would be a contract and a daemon that
// agree with each other about a field neither has seen a consumer read.
//
// It copies the tree into a scratch directory and never touches the working
// tree.
//
// Usage:
//   node scripts/kan382-red-drive.mjs
//   node scripts/kan382-red-drive.mjs --only type-only
//   node scripts/kan382-red-drive.mjs --list

import { execFileSync, spawnSync } from 'node:child_process';
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

const MEMBER = 'doctored-problem';

// ====================================================== §0 the premise check --

/**
 * A counter and the control that proves it can move. `real` and `doctored` are
 * the same function applied to the file and to a copy edited so the answer MUST
 * change; an equal pair means the counter is measuring nothing and is reported
 * as discarded rather than quoted.
 */
function counter(name, doctorDescription, realValue, doctoredValue) {
  const moved = JSON.stringify(realValue) !== JSON.stringify(doctoredValue);
  console.log(`\n  ${name}`);
  console.log(`    real     ${JSON.stringify(realValue)}`);
  console.log(`    control  ${JSON.stringify(doctoredValue)}   (${doctorDescription})`);
  if (moved) {
    pass('the control moves it, so the reading above is a measurement');
  } else {
    fail(`${name}: the control did NOT move it — this counter is discarded, not reported`);
  }
  return realValue;
}

function premiseCheck() {
  rule('§0 — THE PREMISE, re-derived at this head, every counter with a control');

  const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  console.log(`  HEAD  ${head}`);
  console.log(`  tree  ${dirty === '' ? 'CLEAN' : `DIRTY (${dirty.split('\n').length} path(s))`}`);

  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // Members off the TYPE, with doc comments stripped so a literal quoted in
  // prose cannot count as a member.
  const membersOf = (src) => {
    const m = /export type PathProblem\s*=([\s\S]*?);/.exec(src);
    if (!m) return null;
    return [...m[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  };
  const identity = read('src/identity.ts');
  const members = counter(
    'PathProblem members, off the union declaration',
    `a sixth member '${MEMBER}' appended to the union`,
    membersOf(identity),
    membersOf(identity.replace("| 'not-a-directory';", `| 'not-a-directory'\n  | '${MEMBER}';`))
  );

  // Does the boundary still CARRY the cause? Counted on the property that
  // defines it — the refusal arm's shape — not on the spelling of a return.
  const boundary = (src) => {
    const m = /private addressOfRequest\([\s\S]*?\n  \}/.exec(src);
    if (!m) return null;
    const refusals = [...m[0].matchAll(/return \{ error:[^}]*\}/g)].map((x) => x[0]);
    return {
      refusalReturns: refusals.length,
      carryingProblem: refusals.filter((r) => /problem/.test(r)).length
    };
  };
  const router = read('src/router.ts');
  counter(
    'addressOfRequest refusal returns, and how many carry the cause',
    'the refusal return doctored back to prose alone (the pre-KAN-382 shape)',
    boundary(router),
    boundary(router.replace('return { error: e.message, problem: e.problem };', 'return { error: e.message };'))
  );

  // `contractVersion`'s home. The ticket's third question rests on it living on
  // `daemon_status` and nowhere else, which is still true after this change.
  const rc = read('src/read-contract.ts');
  counter(
    '`contractVersion` occurrences in src/read-contract.ts',
    'one extra occurrence spliced into the daemon_status table',
    (rc.match(/\bcontractVersion\b/g) ?? []).length,
    (rc.replace('  contractVersion: { bucket: \'derived\' },', '  contractVersion: { bucket: \'derived\' },\n  contractVersion2: { bucket: \'derived\' }, // contractVersion')
      .match(/\bcontractVersion\b/g) ?? []).length
  );

  counter(
    'declared READ_CONTRACT_VERSION',
    'the declaration doctored to 99',
    Number(/export const READ_CONTRACT_VERSION = (\d+);/.exec(rc)?.[1] ?? NaN),
    Number(/export const READ_CONTRACT_VERSION = (\d+);/.exec(
      rc.replace(/READ_CONTRACT_VERSION = \d+;/, 'READ_CONTRACT_VERSION = 99;')
    )?.[1] ?? NaN)
  );

  // Which call sites are `bad-address` branches of a CONTRACTED surface. This is
  // the scope answer: seven verbs address a path, and exactly two of them have a
  // branch this contract names.
  const callSites = (src) => {
    const out = [];
    const re = /this\.addressOfRequest\(([^,]+), (true|false)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(0, m.index);
      const acts = [...before.matchAll(/action: '([a-z_]+_response)'/g)];
      out.push(`${acts.length ? acts[acts.length - 1][1] : '(none)'}${m[2] === 'true' ? ' strict' : ''}`);
    }
    return out;
  };
  counter(
    'addressOfRequest call sites, by surface and strictness',
    'one call site removed',
    callSites(router),
    callSites(router.replace('const address = this.addressOfRequest(data.path, false);', 'const address = { path: String(data.path) };'))
  );

  console.log('');
  const five = Array.isArray(members) && members.length === 5;
  (five ? pass : fail)(
    'PathProblem still has exactly five members, and they are the five the ticket names',
    JSON.stringify(members)
  );
}

// --------------------------------------------------------------- the arms --

const ARMS = {
  control: {
    what: 'unmutated tree — tsc exits 0 and §1 reports nothing',
    mutate: () => [],
    expectTsc: 'pass',
    expectProblem: null
  },
  'type-only': {
    what: 'a sixth PathProblem member in src/identity.ts alone — the compiler must refuse it',
    mutate: (root) => [mutateType(root)],
    expectTsc: 'fail',
    expectProblem: null
  },
  'type+values': {
    what: 'type + VALUE_SETS, document untouched — tsc PASSES, §1 must catch it',
    mutate: (root) => [mutateType(root), mutateValueSets(root)],
    expectTsc: 'pass',
    expectProblem: /values pathProblem: declared \[[^\]]*\], documented \[[^\]]*\]/
  },
  'branch-drop': {
    what: '`pathProblem` dropped from the bad-address branch — MANDATORY is a declaration, not a type',
    mutate: (root) => [mutateBranchDrop(root)],
    expectTsc: 'pass',
    expectProblem: /activate branch bad-address\.always: key sets differ/
  },
  'field-undeclared': {
    what: 'the field removed from ACTIVATE_RESPONSE_FIELDS while the branch still names it',
    mutate: (root) => [mutateFieldDrop(root)],
    expectTsc: 'pass',
    expectProblem: /activate branch bad-address: key 'pathProblem' is on no activate_response field table/
  }
};

// ------------------------------------------------------ mutation primitives --

/**
 * One edit, with the two assertions `mutation.mjs` makes about every mutation:
 * the anchor occurs EXACTLY once before, and the mutant EXACTLY once after. A
 * drifted anchor is returned as a described failure rather than thrown, so the
 * caller can skip its arm and let the rest of the drive run.
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

const mutateType = (root) =>
  edit(
    path.join(root, 'src', 'identity.ts'),
    `  | 'not-a-directory';`,
    `  | 'not-a-directory'\n  | '${MEMBER}';`,
    'PathProblem union'
  );

const mutateValueSets = (root) =>
  edit(
    path.join(root, 'src', 'read-contract.ts'),
    `    'not-a-string', 'not-absolute', 'does-not-exist', 'uninspectable', 'not-a-directory'`,
    `    'not-a-string', 'not-absolute', 'does-not-exist', 'uninspectable', 'not-a-directory', '${MEMBER}'`,
    'VALUE_SETS.pathProblem'
  );

const mutateBranchDrop = (root) =>
  edit(
    path.join(root, 'src', 'read-contract.ts'),
    `    always: ['action', 'success', 'started', 'error', 'pathProblem'],`,
    `    always: ['action', 'success', 'started', 'error'],`,
    'bad-address branch always list'
  );

const mutateFieldDrop = (root) =>
  edit(
    path.join(root, 'src', 'read-contract.ts'),
    `  pathProblem: { bucket: 'derived', optional: true },\n  /**\n   * The agent's identity — its directory, resolved.`,
    `  /**\n   * The agent's identity — its directory, resolved.`,
    'ACTIVATE_RESPONSE_FIELDS.pathProblem'
  );

// ------------------------------------------------------------- the harness --

/** A scratch copy of the tree, with node_modules symlinked rather than copied. */
function scratchTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan382-drive-'));
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
 * §1 of the REAL proof — document ↔ declaration — run against the mutated
 * tree's own build via `--static-only`.
 *
 * IT RUNS `verify-read-contract.mjs` ITSELF rather than a reimplementation of
 * its §1. A drive that copies the check it is driving proves its own copy can
 * go red and says nothing about the guard in CI.
 *
 * THE BUILD IS CHECKED BEFORE THE VERDICT IS READ. §1 imports from `dist`, so a
 * failed build would have it reconciling the document against the PREVIOUS
 * compile — and both outcomes mislead, a pass reading as "the mutation was not
 * caught" and a red crediting this guard for something else.
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
  const problems = out
    .split('\n')
    .filter((l) => /^\s+!\s/.test(l))
    .map((l) => l.replace(/^\s+!\s/, '').trim());
  return { problems, exit: r.status, out };
}

// ------------------------------------------------------------------- drive --

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [name, arm] of Object.entries(ARMS)) console.log(`${name.padEnd(18)} ${arm.what}`);
  process.exit(0);
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (only && !ARMS[only]) {
  console.log(`No such arm: ${only}. Try --list.`);
  process.exit(2); // setup guard, not a verdict
}
const selected = only ? { [only]: ARMS[only] } : ARMS;

if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
  console.log('SETUP: node_modules is missing — run `npm ci` first.');
  process.exit(2); // setup guard, not a verdict
}

if (!only) premiseCheck();

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
    (tscOk ? pass : fail)(
      `${name}: tsc`,
      `exit ${tsc.code}, expected to ${arm.expectTsc}${tscOk ? '' : `\n${tsc.out}`}`
    );

    if (arm.expectTsc === 'fail') {
      // It must have been refused for the RIGHT reason: the `Exact<>` binding in
      // read-contract.ts, not a syntax error in the mutation. An arm that goes
      // red by the wrong route is a failure of this drive, not a success of the
      // guard — that misattribution is the defect this file is shaped against.
      const named = /src\/read-contract\.ts\(\d+,\d+\): error TS\d+/.test(tsc.out);
      (named ? pass : fail)(
        `${name}: the diagnostic names the Exact<> binding in src/read-contract.ts`,
        named
          ? tsc.out.trim().split('\n').find((l) => /read-contract\.ts/.test(l))
          : `no src/read-contract.ts diagnostic in:\n${tsc.out}`
      );
      continue; // nothing was emitted, so §1 cannot be run on this arm
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
      (hit ? pass : fail)(
        hit ? `${name}: §1 red BY NAME` : `${name}: §1 did not report the expected problem`,
        hit ??
          (s1.problems.length
            ? `RED FOR THE WRONG REASON — ${s1.problems.length} other problem(s): ${s1.problems.join(' | ')}`
            : 'no problems at all — the guard did not fire')
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

rule(`VERDICT: ${failures === 0 ? 'every arm behaved as designed' : `${failures} arm assertion(s) failed`}`);
process.exit(failures ? 1 : 0);
