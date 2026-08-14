#!/usr/bin/env node
// KAN-173 RED DRIVE — do the assertions in `verify-panes-are-reclaimed.mjs`
// that its OWN §7 does not drive actually go red, and for the reason claimed?
//
// WHAT FAILURE THIS WOULD CATCH: a section of that sweep that cannot fail. §7
// drives ONE property — an unclassified pane-opening site is a red — and it
// drives it well. It says nothing about the three mechanisms the rest of the
// file rests on: the census reader (§4), the comment lexer (§1) and the
// immunisation predicate (§1, §3). Each of those is green today and would be
// green tomorrow if it stopped measuring, because a detector that recognises
// nothing prints exactly what a working one prints. This drive breaks each in
// turn and requires the NAMED check, and only that check, to go FAIL.
//
// ⚠ IT READS THE LOG, NOT THE EXIT CODE. A non-zero exit out of a run that
// never reached the section — a syntax error in the mutant, a missing scratch
// tree, a `git ls-files` that found nothing — is a plausible-looking red that
// is evidence about nothing. Every arm therefore asserts that the mutant RAN
// (its §0 banner is present and it reached the verdict line), that the failing
// claims are the ones the arm was designed to break, and that the arms' own
// control PASSED. An arm that goes red by the wrong route is reported as a
// failure of this drive.
//
// EACH MUTATION IS AN EXACT-COUNT REPLACEMENT through `scripts/mutation.mjs`,
// so a mutation that hit nothing is a refusal rather than an unmutated run
// silently reported as a successful red drive.
//
// SEVEN ARMS, AND THE FIRST IS THE CONTROL:
//
//   control        the sweep unmutated, in a scratch copy of `scripts/`. Every
//                  line PASSES and the run exits 0. A red drive whose baseline
//                  is not demonstrated measures the runner as much as the
//                  assertion.
//   census-name    the census reader keys on `p.name` instead of `p.label`.
//                  THE MEASURED DEFECT: `herdr pane list` publishes a pane's
//                  herdr name under `label` and `herdr agent list` publishes
//                  the same string under `name`, so this mutation reports 0
//                  crabcast panes on a machine carrying three — read against
//                  the live herdr on 2026-08-14.
//   census-zero    an unreadable census is reported as zero panes instead of
//                  being refused. This is the ticket's own second accident:
//                  0 panes from a 26 KB file, from a command that exited
//                  cleanly.
//   census-frozen  the reader ignores its input and always answers the canary's
//                  numbers. Every count in §4 is then right for the canary and
//                  the DOCTORED fixture is what says so — the arm that proves
//                  the canary is a measurement and not three constants.
//   immunise-or    `immunised` requires EITHER half instead of both. The two
//                  half-discipline fixtures must go red; this is the predicate
//                  that decides who owes a register entry at all.
//   lexer-blind    the comment lexer flags nothing, so a commented-out spawn
//                  counts as a pane-opening site. The false-RED direction, and
//                  the one a reader would most likely "fix" by deleting the
//                  fixture.
//   stale-count    one register entry claims one site fewer than the file has.
//                  The property KAN-179 asked for by name: a new site inside an
//                  already-registered script is a red, not a silent adoption of
//                  somebody else's reason.
//   anchor-drift   one register entry's `evidence` no longer appears in the
//                  file it names. The rot a line number would have hidden.
//
// The mutants run as CHILDREN (`CRABCAST_PANE_SWEEP_CHILD=1`), so none of them
// re-enters §7 and spawns children of its own — this drive is about §1-§5, and
// §7 already drives itself. Nothing here touches a herdr, opens a pane or
// writes outside a scratch directory.
//
// Usage:
//   node scripts/kan173-red-drive.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const SUBJECT = 'verify-panes-are-reclaimed';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan173-drive-'));
const mutator = makeMutator({
  // `mutateScript` only: this drive mutates a SOURCE file, never a build.
  distDir: path.join(repoRoot, 'scripts'),
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

/**
 * A fresh scratch git tree holding a copy of `scripts/`.
 *
 * One per arm, because the mutation is written INTO the tree the child then
 * sweeps: a shared tree would leave arm N's mutation in place for arm N+1 and
 * every later red would be evidence about the wrong thing.
 */
function freshTree(name) {
  const tree = path.join(scratch, name);
  fs.mkdirSync(tree, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(tree, 'scripts'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: tree });
  execFileSync('git', ['add', '-A'], { cwd: tree });
  return tree;
}

function runIn(tree) {
  const r = spawnSync(process.execPath, [path.join(tree, 'scripts', `${SUBJECT}.mjs`)], {
    env: { ...process.env, CRABCAST_PANE_SWEEP_CHILD: '1', CRABCAST_PANE_SWEEP_REPO: tree },
    encoding: 'utf8'
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lines = out.split('\n');
  return {
    status: r.status,
    out,
    fails: lines.filter((l) => l.startsWith('FAIL')).map((l) => l.slice(6).trim()),
    /** The mutant reached its own verdict rather than dying on the way. */
    ran: out.includes('=== 0. What is being audited ===') &&
      (out.includes('ALL CHECKS PASSED') || /CHECK\(S\) FAILED/.test(out))
  };
}

/**
 * One arm. `expect` is a list of substrings; EVERY one must appear in some FAIL
 * line, and the number of FAIL lines must be exactly `expectedFails` — so an
 * arm that reddened half the file is reported as a failure of this drive rather
 * than banked as a success.
 */
function arm({ name, edits, expect, expectedFails }) {
  console.log(`\n--- ${name} ---`);
  const tree = freshTree(name);
  const target = path.join(tree, 'scripts', `${SUBJECT}.mjs`);
  const mutant = mutator.mutateScript(name, target, edits);
  if (!mutant) return;
  fs.copyFileSync(mutant, target);

  const r = runIn(tree);
  if (!check(r.ran, `${name}: the mutant RAN and reached a verdict`,
    r.ran ? '' : `exit ${r.status}; last lines: ${r.out.trim().split('\n').slice(-5).join(' / ')}`)) {
    return;
  }
  check(r.status !== 0, `${name}: it goes RED`, `exit ${r.status}, ${r.fails.length} FAIL line(s)`);
  check(
    r.fails.length === expectedFails,
    `${name}: exactly ${expectedFails} check(s) failed, so the red is the mutation and not a cascade`,
    `${r.fails.length}: ${r.fails.map((f) => f.split(' — ')[0]).join(' | ').slice(0, 300)}`
  );
  for (const want of expect) {
    const hit = r.fails.find((f) => f.includes(want));
    check(Boolean(hit), `${name}: the named check went red — ${JSON.stringify(want)}`,
      hit ? hit.slice(0, 160) : `no FAIL line contained it`);
  }
}

console.log(`KAN-173 red drive — subject: scripts/${SUBJECT}.mjs`);
console.log(`scratch: ${scratch}\n`);

// ---------------------------------------------------------------------------
// CONTROL
// ---------------------------------------------------------------------------
console.log('--- control ---');
{
  const tree = freshTree('control');
  const r = runIn(tree);
  check(r.ran, 'control: the unmutated sweep RAN');
  check(
    r.status === 0 && r.fails.length === 0,
    'control: the unmutated sweep PASSES, so every red below is a mutation',
    `exit ${r.status}, ${r.fails.length} FAIL line(s): ${r.fails.join(' | ').slice(0, 200)}`
  );
}

// ---------------------------------------------------------------------------
// THE CENSUS READER — three ways it can stop measuring
// ---------------------------------------------------------------------------

arm({
  name: 'census-name',
  edits: [{
    find: "const labelled = panes.filter((p) => typeof p?.label === 'string' && p.label !== '');",
    replace: "const labelled = panes.filter((p) => typeof p?.name === 'string' && p.name !== '');"
  }, {
    find: '    labelled: labelled.map((p) => p.label),',
    replace: '    labelled: labelled.map((p) => p.name),'
  }],
  // Total is still right (it counts panes); labelled and crabcast collapse to
  // zero, and the doctored fixture's crabcast leg goes with them.
  expect: ['labelled panes', 'crabcast-* panes', 'DOCTORED'],
  expectedFails: 3
});

arm({
  name: 'census-zero',
  edits: [{
    find: '    return {\n      ok: false,\n      reason:\n        `no array at result.panes',
    replace:
      '    return {\n      ok: true, panes: [], total: 0, labelled: [], crabcast: [],\n' +
      '      reason:\n        `no array at result.panes'
  }],
  // The four refusals that go through the shape branch. The empty-output and
  // not-JSON refusals return earlier and are untouched, which is what makes
  // this arm's count evidence about WHICH branch was broken.
  expect: ['a bare `panes` key', 'a bare array', 'a `data` key', 'a result with no panes array'],
  expectedFails: 4
});

arm({
  name: 'census-frozen',
  edits: [{
    find: '  const labelled = panes.filter',
    replace:
      '  if (true) return { ok: true, panes: [], total: 41, labelled: new Array(23).fill(\'x\'), ' +
      'crabcast: new Array(7).fill(\'crabcast-frozen\') };\n' +
      '  const labelled = panes.filter'
  }],
  // Every canary count is now right for the wrong reason. Only the DOCTORED
  // fixture and the genuinely-empty case can tell, which is exactly why they
  // are there.
  expect: ['DOCTORED', 'EMPTY census is read as zero'],
  expectedFails: 2
});

// ---------------------------------------------------------------------------
// THE PREDICATES — the two pure functions §3 stands on
// ---------------------------------------------------------------------------

arm({
  name: 'immunise-or',
  edits: [{
    find: '  return reclaimSites(src).length > 0 && censusSites(src).length > 0;',
    replace: '  return reclaimSites(src).length > 0 || censusSites(src).length > 0;'
  }],
  // Three fixtures (the two half-discipline ones and the comment one, whose
  // census read alone now immunises it), plus the three real scripts that now
  // claim immunity while carrying a register entry — §3's "immunised, so it
  // carries no register entry" line. Six, counted from the run rather than
  // predicted: the first version of this arm guessed eight.
  expect: ['reclamation WITHOUT a census read', 'a census read WITHOUT reclamation',
    'verify-send-confirms-delivery.mjs', 'verify-spawn-failure-legibility.mjs',
    'immunised by construction, so it carries no register entry'],
  expectedFails: 6
});

arm({
  name: 'lexer-blind',
  edits: [{
    find: 'function lexComments(src) {\n  const comment = new Uint8Array(src.length);',
    replace: 'function lexComments(src) {\n  return new Uint8Array(src.length);\n  // eslint-disable-next-line\n  const comment = new Uint8Array(src.length);'
  }],
  // Comments now count as code, and exactly the three fixtures that say so go
  // red. NOTHING IN THE TREE ITSELF MOVES, which is worth recording rather than
  // hiding: no tracked proof happens to mention a pane-opening call in a
  // comment today, so §3 would not have noticed this at all. The fixtures are
  // the only thing standing between this file and a blind lexer — which is the
  // argument for having them, made by measurement instead of by assertion.
  expect: ['a commented-out spawn is not a site', 'a block comment does not swallow',
    'a COMMENT promising reclamation'],
  expectedFails: 3
});

// ---------------------------------------------------------------------------
// THE REGISTER — the two ways an entry rots
// ---------------------------------------------------------------------------

arm({
  name: 'stale-count',
  edits: [{
    find: "    script: 'verify-spawn-failure-legibility',\n    classification: 'private-herdr-server',\n    sites: 5,",
    replace: "    script: 'verify-spawn-failure-legibility',\n    classification: 'private-herdr-server',\n    sites: 4,"
  }],
  expect: ['verify-spawn-failure-legibility.mjs — 5 pane-opening site(s), 4 registered', 'UNCLASSIFIED'],
  expectedFails: 1
});

arm({
  name: 'anchor-drift',
  edits: [{
    find: "    evidence: \"herdr(['pane', 'close', id])\"",
    replace: "    evidence: \"herdr(['pane', 'shut', id])\""
  }],
  expect: ['cites text that is still in that file'],
  expectedFails: 1
});

// ---------------------------------------------------------------------------

fs.rmSync(scratch, { recursive: true, force: true });
console.log('');
console.log(failures === 0
  ? 'RED DRIVE COMPLETE — every arm went red by its own route, and the control did not.'
  : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
