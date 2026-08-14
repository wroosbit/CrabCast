#!/usr/bin/env node
// KAN-193 RED DRIVE — the FALSE-POSITIVE CONTROL over the whole of
// `verify-owner-filter.mjs`, plus the two compile-time guards it cannot reach.
//
// WHAT FAILURE THIS WOULD CATCH: an assertion in that proof which passes
// whether or not `owner` exists. Criterion 5 of the ticket names the standard
// and it is stricter than the usual one — *"run the WHOLE proof against the
// PRE-FIX build; assertions that stay green there were never discriminating"* —
// because a per-mutation red drive only ever exercises the sections somebody
// thought to write a mutation for. §10 of the proof shows seven behaviours going
// red one at a time. This shows what is left: which sections survive a build
// with no `owner` in it AT ALL, and whether each survivor is a section that was
// never about `owner` or a section that is not measuring.
//
// THE DISTINCTION THAT MAKES THIS USEFUL, because "everything went red" would be
// a worse result than it sounds. Some checks in that file SHOULD stay green
// against the pre-fix build: §1's preconditions stand a fleet up through verbs
// that predate this ticket, §6's capacity equality is trivially true when there
// is no filter to apply, and §9 reads the WORKING TREE's source rather than the
// build. So each arm below declares which sections it expects to survive and
// WHY, and an unexpected survivor is reported as a failure of this drive — the
// same discipline `kan382-red-drive.mjs` applies to an arm that goes red by the
// wrong route.
//
// THREE ARMS:
//
//   pre-fix-build   the proof run against a build of the MERGE BASE, with the
//                   working tree's own source left alone. Every assertion about
//                   the daemon's behaviour must go red; §9's source reads must
//                   not, and the drive says so rather than counting them.
//   type-total      `owner` added to `AgentConfig` and to NOTHING else.
//                   Expected: `tsc` FAILS, and the diagnostics name the three
//                   total maps over the type — RECONFIGURATION_COST in
//                   src/router.ts, CONFIG_FIELDS in src/events.ts, and the
//                   OPTIONAL_CONFIG_KEYS `Exact<>` binding. This is the claim
//                   that a knob cannot be added without every surface deciding
//                   what to do with it, and it is measured rather than asserted.
//   category-total  a sixth member added to `FleetCategories` without a line in
//                   OWNER_FILTERED_CATEGORIES or OWNER_UNFILTERED_CATEGORIES.
//                   Expected: `tsc` FAILS at the `Exact<>` binding, which is
//                   what stops the NEXT category from being silently unfiltered
//                   — decision 7's failure mode, one category later.
//
// WHAT THIS DOES NOT COVER: it never starts a daemon of its own. Whether
// `crabcast list --owner` and `crabcast_list_agents { owner }` actually reach
// the handler is `verify-owner-filter.mjs` §11, which drives both published
// surfaces against a real daemon — so arm 1 below exercises that section too,
// and a CLI or MCP surface that dropped the argument would show up there as a
// section that stayed green against the pre-fix build.
//
// It copies the tree into a scratch directory and never touches the working
// tree or its `dist/`.
//
// Usage:
//   node scripts/kan193-red-drive.mjs
//   node scripts/kan193-red-drive.mjs --only pre-fix-build
//   node scripts/kan193-red-drive.mjs --list

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

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const ARMS = ['pre-fix-build', 'type-total', 'category-total'];
if (argv.includes('--list')) {
  console.log(ARMS.join('\n'));
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan193-drive-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();

// ================================================== §0 the premise, at HEAD ==

rule('§0 — WHERE THIS IS RUNNING, and the merge base the pre-fix arm uses');

const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain');
// The pre-fix build is the merge base with `origin/main` rather than
// `origin/main` itself. THE DIFFERENCE IS THE ONE `docs/moving-baselines.md`
// records: a baseline read as a moving branch silently becomes a different
// baseline every time somebody else merges, so an arm pinned to `origin/main`
// stops being an arm about THIS change the moment the branch moves under it.
const base = git('merge-base', 'HEAD', 'origin/main');
console.log(`  HEAD        ${head}`);
console.log(`  tree        ${dirty === '' ? 'CLEAN' : `DIRTY (${dirty.split('\n').length} path(s))`}`);
console.log(`  merge-base  ${base}  (with origin/main)`);

{
  // The premise the whole pre-fix arm rests on: that the base really has no
  // `owner`. A base that already carried it would make every "went red" below
  // meaningless, and this is one command rather than an assumption.
  // `spawnSync`, NOT `execFileSync`, and the reason is the result this check
  // exists to get: `git grep` exits 1 when it matches NOTHING, which is the
  // PASSING case here. Throwing on a non-zero exit would make the expected
  // answer an uncaught error, and the version of this that "handles" it by
  // catching would report a genuine git failure as a clean pre-fix base.
  const g = spawnSync('git',
    ['-C', repoRoot, 'grep', '-c', 'owner?: string', base, '--', 'src/types.ts'],
    { encoding: 'utf8' });
  const matches = g.status === 1 ? 0
    : g.status === 0 ? Number(String(g.stdout).trim().split(':').pop())
    : NaN;
  if (matches === 0) {
    pass('the merge base carries no `owner` knob, so it is a genuine pre-fix build');
  } else if (Number.isNaN(matches)) {
    fail('could not read the merge base at all — this drive cannot say what it is controlling ' +
      'against', `git exit ${g.status}: ${String(g.stderr).trim().slice(0, 160)}`);
  } else {
    fail('the merge base ALREADY carries `owner?: string`', `count ${matches}`);
  }
}
if (dirty !== '') {
  console.log('  NOTE: the tree is dirty. §9 of the proof reads the WORKING TREE\'s source, so the');
  console.log('        pre-fix arm below is a mixed run BY DESIGN — pre-fix build, current source.');
}

// ============================================ §1 the proof on a pre-fix build ==

if (!only || only === 'pre-fix-build') {
  rule('ARM 1 — the WHOLE proof against a build of the merge base');

  // The build has to come from a real checkout of the base, not from a patched
  // copy of the current tree: what is being controlled for is the ABSENCE of
  // every part of this change at once, and reconstructing that by hand is how
  // an arm ends up testing the reconstruction.
  const baseTree = path.join(tmp, 'base');
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', baseTree, base],
    { stdio: 'ignore' });
  // `node_modules` is linked rather than installed: the same tree, and it keeps
  // this drive from being a sixteen-second npm run.
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(baseTree, 'node_modules'), 'dir');

  const build = spawnSync('npm', ['run', 'build'], { cwd: baseTree, encoding: 'utf8' });
  // BUILD EXIT READ FROM THE PROCESS, NEVER THROUGH A PIPE. A proof run after a
  // failed build did not run on the code you think it did, and `… | tail` yields
  // tail's status rather than the compiler's — which is exactly how a red gets
  // credited to the wrong mechanism.
  if (build.status !== 0) {
    fail('the merge-base build did not compile, so this arm has nothing to run against',
      `exit ${build.status}: ${String(build.stderr).slice(0, 300)}`);
  } else {
    pass('the merge-base build compiled', `exit ${build.status}`);

    const run = spawnSync('node', [path.join(repoRoot, 'scripts', 'verify-owner-filter.mjs'),
      path.join(baseTree, 'dist')], { encoding: 'utf8', cwd: repoRoot, timeout: 900_000 });
    const out = String(run.stdout ?? '') + String(run.stderr ?? '');
    fs.writeFileSync(path.join(tmp, 'prefix-run.log'), out);

    const lines = out.split('\n');
    const verdictLines = lines.filter((l) => /^\s{2}(PASS|FAIL)\s{2}/.test(l));
    const survivors = verdictLines.filter((l) => l.trim().startsWith('PASS'))
      .map((l) => l.trim().replace(/^PASS\s+/, ''));
    const reds = verdictLines.filter((l) => l.trim().startsWith('FAIL')).length;

    console.log(`  the proof exited ${run.status}, with ${reds} FAIL and ${survivors.length} PASS`);

    if (run.status === 0) {
      fail('THE PROOF PASSED AGAINST A BUILD WITH NO `owner` IN IT. Every assertion in it is ' +
        'a false positive');
    } else {
      pass('the proof FAILS against the pre-fix build, so it is measuring something this ' +
        'change introduced', `exit ${run.status}, ${reds} red`);
    }

    // WHICH SURVIVORS ARE LEGITIMATE, declared rather than counted. A drive that
    // only asserted "some things went red" would be satisfied by one.
    // WHICH SURVIVORS ARE LEGITIMATE, ENUMERATED WITH REASONS. Written as
    // patterns rather than a count, because "12 survived" answers nothing: the
    // question is whether each one is a check that was never about `owner` or a
    // check that is not measuring, and only reading tells them apart.
    //
    // THIS LIST IS SHORTER THAN IT WAS ON THE FIRST RUN, and the difference is
    // the work this arm actually did. Four assertions survived that should not
    // have — three "nothing changed" comparisons (§3's untouched categories,
    // §6's capacity equality and its `priorities` twin) and §2's "a filter that
    // matches nothing succeeds", every one of them trivially true of a daemon
    // that does not filter at all. Each now carries a DISCRIMINATION GUARD
    // asserting that something else in the same read really did move, so each
    // goes red against the base. They were strengthened rather than listed here.
    const EXPECTED_SURVIVOR_PATTERNS = [
      [/PRECONDITION/, '§1 and §6 preconditions — they stand a fleet up through verbs that ' +
        'predate this ticket, and a precondition that went red on the base would mean the ' +
        'FIXTURE depends on the change rather than the property'],
      [/AgentConfig\.owner` in src\/types\.ts|distinction the whole ticket rests on|MCP tool|list tool warns/,
        '§9 — it reads the WORKING TREE\'s source, not the build under test, so it is ' +
        'correctly indifferent to which dist it was pointed at'],
      [/^CONTROL|\(a CONTROL,|deliberately an assertion about an ABSENCE/,
        'checks LABELLED as controls — each is true of any working daemon by design, and each ' +
        'exists to stop a neighbouring assertion being satisfied the wrong way (a filter that ' +
        'returns nothing, or a pager that truncated). A control that went red on the base ' +
        'would mean it was never a control'],
      [/an UNFILTERED read carries no `ownerFilter` block/,
        '§1\'s additivity check — a build with no filter at all also sends no block, which is ' +
        'the one assertion in this proof that is TRUE of the pre-fix daemon and is supposed ' +
        'to be: it is what "additive" means']
    ];

    const unexplained = survivors.filter(
      (s) => !EXPECTED_SURVIVOR_PATTERNS.some(([re]) => re.test(s))
    );

    console.log('\n  survivors, by whether this drive expected them:');
    for (const [re, why] of EXPECTED_SURVIVOR_PATTERNS) {
      const n = survivors.filter((s) => re.test(s)).length;
      console.log(`    ${String(n).padStart(2)}  ${why}`);
    }
    console.log(`    ${String(unexplained.length).padStart(2)}  UNEXPLAINED`);

    if (unexplained.length === 0) {
      pass('every assertion that survived the pre-fix build is one this drive predicted would, ' +
        'and each has a stated reason — so nothing green in that run is green by accident');
    } else {
      fail(`${unexplained.length} assertion(s) survived a build with no \`owner\` and are NOT ` +
        'explained. Each is either a check that is not measuring, or a survivor this drive ' +
        'should have predicted — and which it is has to be decided by reading, not assumed');
      for (const s of unexplained.slice(0, 10)) console.log(`        · ${s.slice(0, 140)}`);
    }

    // The mutation applications are the sharpest single signal: against the base
    // the anchors do not exist, so `mutation.mjs` must refuse every one of them.
    const appliedOnBase = survivors.filter((s) => /mutation ".*" applied/.test(s)).length;
    if (appliedOnBase === 0) {
      pass('and not one of §10\'s seven mutations APPLIED to the base — their anchors are text ' +
        'this change introduced, so the helper refused each by exact count rather than ' +
        'silently editing something else');
    } else {
      fail(`${appliedOnBase} mutation(s) applied to a build that predates them, which means ` +
        'the anchor is matching text that was already there');
    }
  }

  execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', baseTree],
    { stdio: 'ignore' });
}

// ================================== §2/§3 the two compile-time totality guards ==

/**
 * Copy the working tree's source into a scratch package, apply edits, typecheck.
 *
 * `tsc` rather than a full build: the claim under test is about the TYPE
 * SYSTEM, and emit is not part of it.
 */
function typecheckWith(name, edits) {
  const tree = path.join(tmp, name);
  fs.mkdirSync(tree, { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(repoRoot, f), path.join(tree, f));
  }
  fs.cpSync(path.join(repoRoot, 'src'), path.join(tree, 'src'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'), 'dir');

  for (const { file, find, replace } of edits) {
    const p = path.join(tree, file);
    const before = fs.readFileSync(p, 'utf8');
    const count = before.split(find).length - 1;
    if (count !== 1) {
      fail(`${name}: expected exactly 1 occurrence of the anchor in ${file}, found ${count}`,
        'the edit was NOT applied, so this arm would have proved nothing. Fix the edit.');
      return null;
    }
    fs.writeFileSync(p, before.replace(find, replace));
  }

  const tsc = spawnSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['--noEmit'],
    { cwd: tree, encoding: 'utf8' });

  /**
   * Whether a diagnostic landed on the line holding `needle` in the MUTATED
   * tree.
   *
   * BY LINE AND NOT BY NAME, which is a correction this drive made to itself on
   * its first run. An `Exact<>` binding fails as `Type 'true' is not assignable
   * to type 'false'` — TypeScript reports the LOCATION and never the identifier
   * — so grepping the diagnostics for the binding's name finds nothing and
   * reports the guard as not firing when it fired perfectly. The line is
   * computed from the mutated source rather than written down, so it cannot go
   * stale when the file moves.
   */
  const diagnosticOn = (file, needle) => {
    const src = fs.readFileSync(path.join(tree, file), 'utf8').split('\n');
    const line = src.findIndex((l) => l.includes(needle)) + 1;
    if (line === 0) return { found: false, line: null };
    const out = String(tsc.stdout ?? '') + String(tsc.stderr ?? '');
    return { found: out.includes(`${file}(${line},`), line };
  };

  return {
    status: tsc.status,
    out: String(tsc.stdout ?? '') + String(tsc.stderr ?? ''),
    diagnosticOn
  };
}

if (!only || only === 'type-total') {
  rule('ARM 2 — a knob added to AgentConfig and to nothing else must not compile');

  // The claim: three total maps over `keyof Required<AgentConfig>` mean a knob
  // cannot be added without every surface deciding what to do with it. That is
  // the "prefer the type to the assertion" property this change rests on, and
  // it is worth measuring rather than believing, because it is exactly the kind
  // of sentence that stays in a comment after the mechanism has been softened.
  const r = typecheckWith('type-total', [{
    file: 'src/types.ts',
    find: '  owner?: string;\n}',
    replace: '  owner?: string;\n  /** added by kan193-red-drive.mjs */\n  telemetry?: string;\n}'
  }]);

  if (r) {
    if (r.status === 0) {
      fail('a knob added to `AgentConfig` alone TYPECHECKED. The three total maps are not ' +
        'holding, and a future knob can reach the wire undeclared and unclassified');
    } else {
      const named = {
        'RECONFIGURATION_COST (src/router.ts)': /router\.ts.*\n?.*RECONFIGURATION_COST|RECONFIGURATION_COST/.test(r.out) || /router\.ts/.test(r.out),
        'CONFIG_FIELDS (src/events.ts)': /events\.ts/.test(r.out)
      };
      pass('it does NOT compile', `tsc exit ${r.status}`);
      for (const [what, hit] of Object.entries(named)) {
        if (hit) pass(`  and the diagnostics name ${what}`);
        else fail(`  but the diagnostics do NOT name ${what} — the red came from somewhere else`);
      }
      console.log('  first diagnostics:');
      for (const l of r.out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 4)) {
        console.log(`      ${l.trim()}`);
      }
    }
  }
}

if (!only || only === 'category-total') {
  rule('ARM 3 — a sixth fleet category with no owner-filter decision must not compile');

  // DECISION 7'S FAILURE MODE, ONE CATEGORY LATER. The proof asserts that all
  // five current categories are filtered; nothing in it can say anything about
  // the sixth somebody adds next year. This binding is what does, and the whole
  // point of `Exact<>` here is that forgetting is a build error rather than a
  // category that is quietly complete under every filter.
  const r = typecheckWith('category-total', [{
    file: 'src/router.ts',
    find: '  unstartedAgents: UnstartedAgent[];\n}',
    replace: '  unstartedAgents: UnstartedAgent[];\n  /** added by kan193-red-drive.mjs */\n  quarantinedAgents: UnstartedAgent[];\n}'
  }]);

  if (r) {
    if (r.status === 0) {
      fail('a sixth `FleetCategories` member with no owner-filter decision TYPECHECKED. The ' +
        'next category added would be silently complete under every filter — decision 7 ' +
        'broken by omission, which is how it would actually happen');
    } else {
      pass('it does NOT compile', `tsc exit ${r.status}`);
      const binding = r.diagnosticOn('src/router.ts', '_everyCategoryHasAnOwnerFilterDecision:');
      if (binding.found) {
        pass('  and a diagnostic lands ON the owner-filter totality binding, so the red is THIS ' +
          `guard rather than an unrelated one`, `src/router.ts:${binding.line}`);
      } else {
        fail('  but no diagnostic lands on the owner-filter binding — the red came by another ' +
          'route, and an arm that goes red for the right reason by the wrong mechanism is a ' +
          'failure of this drive', `binding at src/router.ts:${binding.line}`);
      }
      // The SECOND guard, and the two are not redundant: `FleetCategories`
      // being unsatisfied at the construction site says a category was added
      // and not built, while the binding above says a category was added and
      // nobody decided whether a filter applies to it. Only the second is this
      // ticket's, and an arm that accepted the first as evidence for the second
      // would be crediting the wrong mechanism.
      const construction = r.diagnosticOn('src/router.ts', 'const categories: FleetCategories = {');
      if (construction.found) {
        pass('  and the pre-existing `FleetCategories` construction guard fires too — reported ' +
          'separately, because it is not evidence for the one above',
          `src/router.ts:${construction.line}`);
      } else {
        console.log('    (the FleetCategories construction guard did not fire; not required here)');
      }
      console.log('  first diagnostics:');
      for (const l of r.out.split('\n').filter((l) => /error TS/.test(l)).slice(0, 6)) {
        console.log(`      ${l.trim()}`);
      }
    }
  }
}

rule('VERDICT');
console.log(failures === 0
  ? '\nEvery arm behaved as declared.'
  : `\n${failures} arm assertion(s) did not.`);
process.exit(failures ? 1 : 0);
