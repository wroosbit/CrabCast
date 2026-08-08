#!/usr/bin/env node
// KAN-138: the thing that proves the other proofs can fail, proven.
//
// WHAT FAILURE THIS WOULD CATCH: a mutation-based section that reports success
// about an UNMUTATED build. Every "the checks can fail" section in this suite
// rests on an edit to a copy of the compiled daemon actually landing. When an
// unrelated slice moves the anchor that edit is keyed to, the edit silently
// matches nothing — and a section that then runs its assertions against a
// pristine build passes, and reports the strongest result available at the
// exact moment it tested nothing. This script fails if `scripts/mutation.mjs`
// stops refusing that, if it stops SAYING WHY, or if any proof in the suite
// goes back to mutating a build without it.
//
// THE SECOND HALF IS THE ONE THAT CANNOT GO STALE. Section 4 holds no list of
// the scripts that mutate builds — it WALKS `scripts/verify-*.mjs`, finds every
// one that copies a build for itself, and fails on it. A list would have to be
// updated by whoever adds the ninth such script, which is exactly the update
// nobody remembers; a sweep has nothing to forget. That is this epic's own rule
// (KAN-166, KAN-148) applied to its own instruments.
//
// It holds one small register in the other direction — scripts that copy a
// build for a reason that is NOT mutation — and that register is a list, with
// everything a list costs. Section 4b is what keeps it from rotting: each entry
// must still name a real file that really does copy a build. What no check here
// can hold is whether an entry's REASON is true; that is reviewed like code,
// exactly as in `verify-proof-registry.mjs`, and this sentence is here so
// nobody reads section 4 as covering it.
//
// WHY THE HELPER EXISTS AT ALL, in one paragraph, because it corrects the
// instruction that commissioned it. KAN-138 was staffed to "adopt
// `mutatedBuild()`'s exact-count self-assertion across every mutation-based
// proof". The survey found all eight copies ALREADY had it. What none of them
// had was a survivable failure: every one THREW, so a drifted anchor killed
// the process and the sections after it never reported — which is the same
// "stops measuring under exactly the conditions it exists for" shape as the
// items that commissioned the work. The helper keeps the count and changes the
// disposal. See `scripts/mutation.mjs`.
//
// WHAT THIS SCRIPT DOES NOT COVER, and it is the sharpest limit on it: this
// proof SUPPLIES ITS OWN INPUTS. Sections 1 to 3 hand the helper mutations
// chosen to exercise each branch, so they prove the helper answers correctly
// about a mutation it is given — NOT that any real section's mutation still
// applies to today's build. That second thing has no owner here and cannot
// have one: it is proven only by the real scripts running in CI, where a
// drifted anchor now produces a named FAIL from this helper instead of a stack
// trace. Section 4 is the part that reaches outside this file, and it checks
// WIRING rather than behaviour — that each mutating proof still goes through
// the helper, not that its particular anchors are good.
//
// AND ONE MUTATION-BASED PROOF THIS SWEEP DOES NOT REACH, named here because a
// boundary nobody writes down is read as coverage. `verify-proof-cleans-up-
// when-interrupted.mjs:191-206` mutates a SCRIPT rather than a build — it
// removes the signal-handler block from `verify-send-confirms-delivery.mjs` by
// exact text and runs the result. It has the exact-count guard and the "Fix the
// mutation, not this check." sentence already; what it still has is the throw,
// so a drifted anchor there ends the run at §2 the old way. Section 4 below
// looks for scripts that copy a BUILD and does not see it.
//
// That gap is not hypothetical, and it is how it was found: converting
// `verify-send-confirms-delivery` for this PR inserted a line INSIDE that
// handler block, the anchor stopped matching, and CI went red with
// `expected exactly one cleanup-handler block … found 0`. The guard did its job
// — it named the file, the count and what to fix — and the failure was mine.
// Generalising the helper to cover single-file script mutation is real work and
// is filed rather than done here (KAN-170).
//
// AND THE SWEEPS SHARE ONE ARM, WHICH WAS WRONG FROM THE DAY IT WAS WRITTEN
// (KAN-199). Both are `detector && !USES_HELPER`, so `USES_HELPER` decides who
// is excused — and the two sides of the miss landed on the same day, 2026-08-05:
// this detector in KAN-138 (#32), the dynamic import in KAN-96 (#43). It read
// only the STATIC import, and `verify-agent-power-controls` takes the helper by
// dynamic import — a proof that goes through the helper exactly as intended,
// reading to this file as one that had not. It cost nothing at the time only
// because that script matches neither detector, which is a fact about today's
// code rather than about the check. Section 4d is the part that keeps the
// fourth import syntax from doing the same thing: it walks the real suite and
// names any proof that mentions the helper in a form `USES_HELPER` cannot see.
// The fixtures in 4a and 4b cannot do that job — they hand the detector strings
// THIS FILE WROTE, and the defect was a form nobody thought to write.
//
// It needs no daemon, no herdr and no network. It needs `dist/` to exist,
// because it copies it.
//
// Usage:
//   npm run build
//   node scripts/verify-mutation-harness.mjs [distDir]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator, FIX_THE_MUTATION } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = process.argv[2] ?? path.join(repoRoot, 'dist');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

if (!fs.existsSync(path.join(distDir, 'router.js'))) {
  // A setup guard, and it says so: this is not a verdict about the helper.
  console.error(`${distDir}/router.js is missing — run \`npm run build\` first.`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan138-mutation-'));

/**
 * A capture of what the helper reported, so the assertions below can be about
 * the DIAGNOSIS and not only about the verdict.
 *
 * Exit codes alone cannot tell a guard that diagnosed correctly from one that
 * has lost its diagnosis: every not-applied verdict fails closed, so a helper
 * that reported `false` with an empty detail would satisfy "it went red" while
 * being useless to the person reading the output. The text is asserted
 * separately for that reason.
 */
function recordingMutator() {
  const seen = [];
  const { mutate, mutateScript, mutationsSkipped } = makeMutator({
    distDir,
    scratch: tmp,
    report: {
      pass: (name, detail) => seen.push({ name, ok: true, detail: detail ?? '' }),
      fail: (name, detail) => seen.push({ name, ok: false, detail: detail ?? '' })
    }
  });
  return { mutate, mutateScript, mutationsSkipped, seen };
}

const ROUTER = 'router.js';

/**
 * Two anchors that appear in the compiled router EXACTLY ONCE.
 *
 * Their uniqueness is asserted as a setup check below rather than assumed:
 * this file's whole subject is a helper that refuses anything but one
 * occurrence, so an anchor that quietly became two would make section 1 report
 * a failure of the helper when what actually moved was this script's fixture.
 * A proof about exact counts has no business guessing at its own.
 *
 * Deliberately NOT type names — `tsc` erases those, and the first draft of this
 * script anchored on one and spent a run reporting that a working helper was
 * broken.
 */
const APPLIES_ANCHOR = "action: 'activate_response', success: false, started: false";
const SECOND_ANCHOR = "alreadyGone: true";

// ---------------------------------------------------------------------------
console.log('\n== 1. A mutation that applies really does edit the build ==');
// ---------------------------------------------------------------------------
{
  const h = recordingMutator();
  const before = fs.readFileSync(path.join(distDir, ROUTER), 'utf8');
  for (const [label, anchor] of [['APPLIES_ANCHOR', APPLIES_ANCHOR], ['SECOND_ANCHOR', SECOND_ANCHOR]]) {
    const n = before.split(anchor).length - 1;
    check(
      `(setup) ${label} appears in the compiled build exactly once`,
      n === 1,
      `${JSON.stringify(anchor)} appears ${n} time(s) in ${ROUTER} — if this is 0 or 2 the ` +
        `fixture moved, not the helper`
    );
  }

  const dir = h.mutate('applies', ROUTER, APPLIES_ANCHOR, 'MUTATED_MARKER');
  check('it returns a directory rather than null', typeof dir === 'string', String(dir));

  if (typeof dir === 'string') {
    const after = fs.readFileSync(path.join(dir, ROUTER), 'utf8');
    check(
      'the copy really differs from the original — the edit is measured, not assumed',
      after !== before,
      `${before.length} chars → ${after.length} chars`
    );
    check(
      'and it differs in exactly the way asked: the anchor is gone and the replacement is there, once',
      after.split('MUTATED_MARKER').length - 1 === 1 &&
        after.split(APPLIES_ANCHOR).length - 1 === 0,
      `MUTATED_MARKER x${after.split('MUTATED_MARKER').length - 1}, ` +
        `anchor x${after.split(APPLIES_ANCHOR).length - 1}`
    );
    check(
      'the ORIGINAL build is untouched — a helper that edited dist/ in place would corrupt ' +
        'every script that ran after it',
      fs.readFileSync(path.join(distDir, ROUTER), 'utf8') === before
    );
  }
  check(
    'and nothing is reported skipped',
    h.mutationsSkipped().length === 0,
    JSON.stringify(h.mutationsSkipped())
  );
}

// ---------------------------------------------------------------------------
console.log('\n== 2. A mutation that does NOT apply is a COUNTED VERDICT, not a throw ==');
// ---------------------------------------------------------------------------
//
// The property this whole file exists for. Three ways an edit fails to land,
// and after each one the process is still alive and still reporting.
{
  for (const [label, args, expect] of [
    [
      'matches nothing',
      ['no-match', ROUTER, 'forwardEventTHATDOESNOTEXIST(msg);', 'x'],
      /found 0/
    ],
    [
      'matches more than once',
      ['too-many', ROUTER, 'const', 'let'],
      /found (?!0\b|1\b)\d+/
    ],
    [
      'replaces the text with itself',
      ['no-op', ROUTER, SECOND_ANCHOR, SECOND_ANCHOR],
      /identical/
    ],
    [
      'names a file that is not in the build',
      ['no-file', 'no-such-module.js', 'a', 'b'],
      /could not read/
    ]
  ]) {
    const h = recordingMutator();
    let threw = null;
    let result = 'not called';
    try {
      result = h.mutate(...args);
    } catch (err) {
      threw = err;
    }

    check(
      `[${label}] IT DOES NOT THROW — the run survives, so the sections after it still report`,
      threw === null,
      threw ? `threw: ${threw.message}` : 'returned normally'
    );
    check(`[${label}] it returns null, so the caller can skip its section`, result === null, String(result));

    const failed = h.seen.filter((s) => !s.ok);
    check(
      `[${label}] and the failure is COUNTED through the script's own check — the verdict goes ` +
        `red rather than the process going quiet`,
      failed.length === 1,
      `${h.seen.length} report(s), ${failed.length} failing`
    );

    const detail = failed[0]?.detail ?? '';
    const name = failed[0]?.name ?? '';
    // THE DIAGNOSIS, ASSERTED SEPARATELY FROM THE VERDICT. Every not-applied
    // outcome fails closed, so "it went red" is satisfied by a guard that has
    // lost its diagnosis entirely.
    check(
      `[${label}] the failure NAMES the mutation and says the section did not run`,
      name.includes(args[0]) && /did not run/i.test(name),
      JSON.stringify(name)
    );
    check(
      `[${label}] the detail says what was actually wrong`,
      expect.test(detail),
      JSON.stringify(detail.slice(0, 160))
    );
    check(
      `[${label}] and it tells the reader WHICH THING TO FIX — without this sentence the next ` +
        `person to hit it deletes the guard`,
      detail.includes(FIX_THE_MUTATION),
      JSON.stringify(FIX_THE_MUTATION)
    );
    check(
      `[${label}] the mutation is listed as skipped, so "N FAILED" is not misread as N ordinary ` +
        `assertion failures`,
      h.mutationsSkipped().includes(args[0]),
      JSON.stringify(h.mutationsSkipped())
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 3. A failed mutation does not poison the next one ==');
// ---------------------------------------------------------------------------
//
// The point of property 4 is that the file KEEPS GOING, so the mutation after
// a failed one has to work. Asserted rather than assumed, because "the run
// survives" and "the run still measures" are different claims.
{
  const h = recordingMutator();
  const dead = h.mutate('dead', ROUTER, 'ANCHOR_THAT_IS_NOT_THERE', 'x');
  const alive = h.mutate('alive', ROUTER, SECOND_ANCHOR, 'alreadyGone: MUTATED');

  check('the first mutation failed', dead === null);
  check(
    'and the SECOND one still produced a real mutant — the helper is not left in a broken state',
    typeof alive === 'string' &&
      fs.readFileSync(path.join(alive, ROUTER), 'utf8').includes('alreadyGone: MUTATED'),
    String(alive)
  );
  check(
    'with exactly one skip recorded, named',
    JSON.stringify(h.mutationsSkipped()) === JSON.stringify(['dead']),
    JSON.stringify(h.mutationsSkipped())
  );
  check(
    'and the two mutants are different directories, so one call cannot hand back another\'s build',
    dead === null && typeof alive === 'string' && alive.endsWith('mutant-alive')
  );
}

// ---------------------------------------------------------------------------
console.log('\n== 3b. mutateScript — the same four properties, for ONE SOURCE FILE ==');
// ---------------------------------------------------------------------------
//
// The second entry point, added by KAN-170 because
// `verify-proof-cleans-up-when-interrupted` mutates a SCRIPT rather than a
// build and therefore reached neither `mutate` nor section 4's sweep. It threw
// on anchor drift for exactly as long as nothing owned that space.
//
// Every branch below is the same branch section 2 walks for `mutate`, because
// the failure modes are the same and a second entry point with only the happy
// path tested would be the shape this whole file exists to catch. Plus the one
// branch `mutate` does not have: a dependency that could not be carried.
{
  const fixture = path.join(tmp, 'fixture-script.mjs');
  const sidecar = path.join(tmp, 'fixture-dep.mjs');
  fs.writeFileSync(fixture, "import './fixture-dep.mjs';\nconst KEEP_ME = 1;\nexport default KEEP_ME;\n");
  fs.writeFileSync(sidecar, 'export const dep = 1;\n');

  {
    const h = recordingMutator();
    const out = h.mutateScript('script-applies', fixture, [
      { find: 'const KEEP_ME = 1;', replace: 'const KEEP_ME = 2;' }
    ]);
    check('it returns a file path rather than null', typeof out === 'string', String(out));
    check(
      'the copy carries the edit and the ORIGINAL script is untouched — a helper that edited ' +
        'scripts/ in place would corrupt the checkout it was run in',
      typeof out === 'string' &&
        fs.readFileSync(out, 'utf8').includes('const KEEP_ME = 2;') &&
        fs.readFileSync(fixture, 'utf8').includes('const KEEP_ME = 1;'),
      typeof out === 'string' ? fs.readFileSync(out, 'utf8').split('\n')[1] : String(out)
    );
  }

  {
    const h = recordingMutator();
    const out = h.mutateScript(
      'script-deps',
      fixture,
      [{ find: 'const KEEP_ME = 1;', replace: 'const KEEP_ME = 3;' }],
      { deps: ['fixture-dep.mjs'] }
    );
    check(
      'a named dependency is carried next to the mutant — a mutant that cannot resolve its ' +
        'imports dies on startup, and a mutant that died on startup produces the same ' +
        'observation as one that behaved well',
      typeof out === 'string' && fs.existsSync(path.join(path.dirname(out), 'fixture-dep.mjs')),
      String(out)
    );
  }

  for (const [label, args, expect] of [
    ['matches nothing', ['s-none', fixture, [{ find: 'NOT_IN_THE_FILE', replace: 'x' }]], /found 0/],
    ['matches more than once', ['s-many', fixture, [{ find: 'KEEP_ME', replace: 'x' }]], /found (?!0\b|1\b)\d+/],
    ['replaces the text with itself', ['s-noop', fixture, [{ find: 'KEEP_ME', replace: 'KEEP_ME' }]], /identical/],
    ['names a file that is not there', ['s-gone', path.join(tmp, 'no-such-script.mjs'), [{ find: 'a', replace: 'b' }]], /could not read/],
    [
      'names a dependency that is not there',
      ['s-dep', fixture, [{ find: 'const KEEP_ME = 1;', replace: 'const KEEP_ME = 4;' }], { deps: ['no-such-dep.mjs'] }],
      /could not be copied/
    ]
  ]) {
    const h = recordingMutator();
    let threw = null;
    let result = 'not called';
    try {
      result = h.mutateScript(...args);
    } catch (err) {
      threw = err;
    }
    check(
      `[script: ${label}] IT DOES NOT THROW — the run survives, so the sections after it still report`,
      threw === null,
      threw ? `threw: ${threw.message}` : 'returned normally'
    );
    check(`[script: ${label}] it returns null, so the caller can skip its section`, result === null, String(result));
    const failed = h.seen.filter((s) => !s.ok);
    check(
      `[script: ${label}] the failure is COUNTED through the script's own check`,
      failed.length === 1,
      `${h.seen.length} report(s), ${failed.length} failing`
    );
    const detail = failed[0]?.detail ?? '';
    check(
      `[script: ${label}] the detail says what was actually wrong`,
      expect.test(detail),
      JSON.stringify(detail.slice(0, 160))
    );
    check(
      `[script: ${label}] and it carries the sentence that stops the next person deleting the guard`,
      detail.includes(FIX_THE_MUTATION),
      JSON.stringify(detail.slice(0, 60))
    );
    check(
      `[script: ${label}] the mutation is listed as skipped`,
      h.mutationsSkipped().includes(args[0]),
      JSON.stringify(h.mutationsSkipped())
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 4. THE SWEEP — every proof that mutates a build goes through the helper ==');
// ---------------------------------------------------------------------------
//
// THE RULE: no tracked `scripts/verify-*.mjs` may copy the compiled build
// itself. Copying `dist` is what every one of the eight private helpers had in
// common, and it is the operation that puts a script in the business of
// mutating a build — so once the copy happens inside `mutation.mjs`, a script
// that still does it for itself is a script that went around the helper.
//
// A SWEEP, WITH A REGISTER FOR THE ONE HONEST EXCEPTION — and the split
// matters, so it is stated rather than implied. The SWEEP is what has nothing
// to forget: whoever adds the ninth mutating proof is caught by it without
// anyone having remembered to add them anywhere. The REGISTER is the escape
// hatch for a script that copies a build for a reason that is not mutation, and
// it is deliberately expensive: a reason, a citation, and section 4b holds each
// entry to still existing and to still copying a build, so an entry that has
// gone stale FAILS rather than sitting here rotting. That is the same shape as
// the EXCLUSIONS register in `verify-proof-registry.mjs`, for the same reason.
//
// WHAT THE REGISTER CANNOT CHECK: whether a reason is TRUE. `verify-daemon-
// provenance` says it copies builds into fixture trees rather than to edit
// them, and nothing here proves that sentence — it is reviewed like code, the
// way that other register's reasons are. What is mechanical is that the entry
// names a real file that really does copy a build.

const tracked = execFileSync('git', ['ls-files', 'scripts/verify-*.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean);

check(
  '(setup) git lists the proof scripts — a sweep over an empty set would pass vacuously and ' +
    'this whole section would report an all-clear about nothing',
  tracked.length > 10,
  `${tracked.length} tracked verify script(s)`
);

/**
 * Scripts allowed to copy a build without going through the helper, because
 * what they are doing is not mutation.
 */
const COPIES_BUT_DOES_NOT_MUTATE = [
  {
    script: 'scripts/verify-daemon-provenance.mjs',
    reason:
      'It copies dist/ and src/ into FIXTURE TREES — one a real little git repo, one with no git ' +
      'metadata at all — and treats each copy as a whole package to run a daemon out of. It never ' +
      'edits a file inside a copy to change the daemon\'s behaviour, which is the practice this ' +
      'sweep is about; it builds worlds for an unmutated daemon to report on.',
    evidence: 'scripts/verify-daemon-provenance.mjs:121 cpSync of dist and src into a fixture tree, not a mutant'
  },
  {
    script: 'scripts/verify-daemon-status-over-mcp.mjs',
    reason:
      'Same shape as verify-daemon-provenance above, and for the same reason: it copies dist/ and ' +
      'src/ into ONE fixture tree — a real little git repo — and runs an unmutated MCP server and ' +
      'daemon out of it, because `build`/`freshness` describe the tree a process was loaded from ' +
      'and the real repository is not a tree this proof may arrange. WHAT IT DOES TO THAT COPY, ' +
      'said explicitly because the file contains a `touch` and a re-`stamp` that a reader of this ' +
      'entry would otherwise have to go and check: §4 changes FILE TIMES and rewrites ' +
      'build-stamp.json to simulate a rebuild under the running daemon. Not one byte of compiled ' +
      'code is edited, and the daemon\'s behaviour is identical before and after — what changes is ' +
      'what the tree LOOKS like, which is the thing under report. That is building a world for an ' +
      'unmutated daemon to describe, not a mutant.',
    evidence: 'scripts/verify-daemon-status-over-mcp.mjs:188 cpSync of dist into a fixture tree; ' +
      'the §4 touch/re-stamp alters mtimes and the stamp, never compiled code'
  }
];

/**
 * Does this script copy a compiled build?
 *
 * Textual and deliberately broad. A false positive costs whoever wrote it a
 * register entry with a reason; a false negative is a proof that silently stops
 * being guarded. The bias is set that way on purpose.
 */
const COPIES_BUILD = /cpSync\(/;

/**
 * Does this script reach the helper?
 *
 * BOTH IMPORT FORMS, because the suite uses both (KAN-199). This read
 * `/from\s+['"]\.\/mutation\.mjs['"]/` until it was noticed that
 * `verify-agent-power-controls.mjs` takes the helper by DYNAMIC import — it has
 * to, because the mutator is built after the config it is keyed to has been
 * loaded — and so read to this detector as a script that had gone around it.
 * Nothing went red, because that script matches neither `COPIES_BUILD` nor
 * `READS_A_SIBLING_SOURCE` and both sweeps are `detector && !USES_HELPER`. That
 * is worth nothing: the miss was one `cpSync(` away from naming a proof as
 * having evaded a helper it was using, and whoever got that failure would have
 * loosened the detector or written a register entry that was not true.
 *
 * THE BIAS HERE RUNS THE OTHER WAY FROM `COPIES_BUILD`'s, and it is worth
 * saying because the two look alike. This one appears NEGATED in every sweep,
 * so its false positives EXCUSE an offender rather than costing someone a
 * register entry: prose that happens to contain `from './mutation.mjs'` reads
 * as an import. That was true of the narrow form too and is not fixed here —
 * fixing it needs a parser, not a regex. What is new is §4d, which sweeps in
 * the opposite direction: any real proof that names the helper and does not
 * match this is named, so a THIRD import form cannot go quiet the way the
 * second one did.
 */
const USES_HELPER = /(?:from|import\s*\()\s*['"]\.\/mutation\.mjs['"]/;

const registered = new Set(COPIES_BUT_DOES_NOT_MUTATE.map((e) => e.script));
const copiers = [];
const offenders = [];
for (const rel of tracked) {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  if (!COPIES_BUILD.test(text)) continue;
  copiers.push(rel);
  if (USES_HELPER.test(text) || registered.has(rel)) continue;
  offenders.push(rel);
}

console.log(`\n   ${copiers.length} proof(s) copy a build directly:`);
for (const m of copiers) {
  // The arrow is for OFFENDERS, not for everything unregistered — a copier that
  // goes through the helper is neither. This printed `<-- went around
  // mutation.mjs` beside two compliant proofs while the verdict below said none
  // had, which is the listing contradicting the check it exists to explain
  // (KAN-199). §4a's listing already reads its offender set; this one now does.
  const why = registered.has(m)
    ? '   (registered: not a mutation)'
    : offenders.includes(m)
      ? '   <-- went around mutation.mjs'
      : '   (through the helper)';
  console.log(`     ${m}${why}`);
}

check(
  'no proof copies the compiled build for itself — every mutation goes through ' +
    'scripts/mutation.mjs, so a drifted anchor is a named failure in that script rather than a ' +
    'stack trace that takes its later sections with it',
  offenders.length === 0,
  offenders.length
    ? `${offenders.join(', ')} — import { makeMutator } from './mutation.mjs' and drop the private copy`
    : 'none went around it'
);

// ---------------------------------------------------------------------------
console.log('\n-- 4a. and every proof that mutates a SCRIPT goes through it too');
// ---------------------------------------------------------------------------
//
// THE GAP THIS CLOSES, which is the reason it exists rather than a completeness
// gesture (KAN-170). The sweep above looks for `cpSync(` — copying a BUILD —
// because that is the operation that puts a script in the business of mutating
// one. `verify-proof-cleans-up-when-interrupted` copies a single SOURCE FILE:
// it reads a sibling proof, removes its signal-handler block by exact text and
// runs the result. `cpSync` never appears, so the sweep passed it by; the
// helper only mutated builds, so it had nothing to offer it. Two mechanisms,
// each honest about itself, with a script sitting in the space between them
// throwing on anchor drift for its entire life.
//
// THE DETECTOR IS THE SAME KIND OF THING AS `COPIES_BUILD`: the operation that
// puts a proof in the business of mutating a script is READING A SIBLING
// SCRIPT'S SOURCE OFF DISK. It is textual and deliberately broad, and the bias
// is set the same way — a false positive costs whoever wrote it a helper call
// or a register entry; a false negative is a proof that silently stops being
// guarded.
const READS_A_SIBLING_SOURCE =
  /readFileSync\(\s*(TARGET\b|[^)]*scriptDir|[^)]*verify-[a-z0-9-]+\.mjs)/;

/**
 * Scripts allowed to read a sibling's source without going through the helper,
 * because what they are doing is not mutation.
 *
 * The same shape as `COPIES_BUT_DOES_NOT_MUTATE` above, for the same reason,
 * and the first entry arrived the same way that one's did: KAN-170's group A
 * gave `verify-daemon-provenance` a structural assertion over the stamper's
 * source, main moved, and this sweep named it the first time the two slices met.
 * That is the sweep working — it is supposed to ask about anything that reaches
 * for a sibling's text — and the answer is an entry with a reason, not a
 * loosened detector.
 */
const READS_BUT_DOES_NOT_MUTATE = [
  {
    script: 'scripts/verify-daemon-provenance.mjs',
    reason:
      'It reads scripts/stamp-build.mjs to ASSERT ON ITS TEXT — that the one `stampVersion` the ' +
      'writer emits is the shared constant imported from the build it has just stamped, rather ' +
      'than a literal of its own. It never writes a copy and never runs one: the read is the ' +
      'assertion, which is the opposite of the practice this sweep is about.',
    evidence: 'scripts/verify-daemon-provenance.mjs — `fs.readFileSync(stamperJs, ...)` inside the §5b writer/reader agreement check'
  }
];

const readRegistered = new Set(READS_BUT_DOES_NOT_MUTATE.map((e) => e.script));
const scriptMutators = [];
const scriptOffenders = [];
for (const rel of tracked) {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  if (!READS_A_SIBLING_SOURCE.test(text)) continue;
  scriptMutators.push(rel);
  if (USES_HELPER.test(text) || readRegistered.has(rel)) continue;
  scriptOffenders.push(rel);
}

console.log(`\n   ${scriptMutators.length} proof(s) read a sibling script's source:`);
for (const m of scriptMutators) {
  const self = m.endsWith('verify-mutation-harness.mjs') ? '   (this file, matching on its own fixture text below)' : '';
  const why = readRegistered.has(m)
    ? '   (registered: reads to assert, not to mutate)'
    : scriptOffenders.includes(m)
      ? '   <-- went around mutation.mjs'
      : '';
  console.log(`     ${m}${self}${why}`);
}

// A NOTE THE READER NEEDS, because the obvious question about this sweep has an
// unobvious answer. The script that MOTIVATED it —
// `verify-proof-cleans-up-when-interrupted` — no longer matches the detector at
// all, because the read it used to do itself now happens inside `mutateScript`.
// That is the sweep working rather than missing: it is a detector for proofs
// that reach for a sibling's source ON THEIR OWN, and that one no longer does.
// What holds the line for it specifically is the direct assertion below, and
// what holds the line for the detector is the fixture at the end of this
// section — the sweep's own subject is that a check matching nothing reports
// the same all-clear as a check matching everything.
check(
  '(setup) the script-mutation sweep found something to sweep',
  scriptMutators.length > 0,
  `${scriptMutators.length} match(es) for ${READS_A_SIBLING_SOURCE}`
);
check(
  'no proof mutates a sibling script for itself — so a drifted anchor in a SCRIPT mutation is ' +
    'a counted verdict in that script rather than a throw that takes its later sections with it',
  scriptOffenders.length === 0,
  scriptOffenders.length
    ? `${scriptOffenders.join(', ')} — use mutateScript() from './mutation.mjs'`
    : 'none went around it'
);
// THE PROPERTY THE SWEEP CANNOT SEE, asserted directly on the one script that
// motivated it: that the throw is actually gone. A script could import the
// helper and still keep a `throw` beside it, and the sweep would pass.
{
  const rel = 'scripts/verify-proof-cleans-up-when-interrupted.mjs';
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  check(
    `${rel} mutates through the helper and no longer throws on a drifted anchor`,
    /mutateScript\(/.test(text) && !/throw new Error\(\s*\n?\s*`expected exactly one/.test(text),
    `mutateScript: ${/mutateScript\(/.test(text)}, ` +
      `anchor throw still present: ${/throw new Error\(\s*\n?\s*`expected exactly one/.test(text)}`
  );
}

// AND THIS SWEEP CAN FAIL TOO, held to the same standard as the one above: a
// detector that matched nothing would report the same all-clear, in the same
// words, as one that matched everything. So it is run against a file written to
// be caught — the shape `verify-proof-cleans-up-when-interrupted` had before
// KAN-170 — and then against the same file with the helper imported.
{
  const privateScriptMutator =
    "import * as fs from 'node:fs';\n" +
    "const TARGET = path.join(scriptDir, 'verify-send-confirms-delivery.mjs');\n" +
    "const source = fs.readFileSync(TARGET, 'utf8');\n" +
    "if (source.split(HANDLER).length - 1 !== 1) throw new Error('anchor drifted');\n";
  check(
    'the detector CATCHES a proof that mutates a sibling script privately — asserted against a ' +
      'file written to be caught, because a detector that found nothing would pass the check ' +
      'above with the same words it uses when everything is right',
    READS_A_SIBLING_SOURCE.test(privateScriptMutator) && !USES_HELPER.test(privateScriptMutator)
  );
  check(
    'and it CLEARS the same file once the helper is imported',
    USES_HELPER.test(`import { makeMutator } from './mutation.mjs';\n${privateScriptMutator}`)
  );
  check(
    'and it CLEARS it when the helper arrives by DYNAMIC import too — the form that read as an ' +
      'evasion for as long as this detector only knew the static one (KAN-199)',
    USES_HELPER.test(
      `const { makeMutator } = await import('./mutation.mjs');\n${privateScriptMutator}`
    )
  );
  check(
    'while a proof that reads no sibling source is not swept up at all',
    !READS_A_SIBLING_SOURCE.test("const cfg = fs.readFileSync(configPath, 'utf8');\n")
  );
}

// And 4a's register is held to 4b's standard, for 4b's reason: an entry that
// has gone stale is a hole nobody is watching.
for (const entry of READS_BUT_DOES_NOT_MUTATE) {
  const abs = path.join(repoRoot, entry.script);
  const exists = fs.existsSync(abs);
  check(
    `read-register: ${entry.script} still exists`,
    exists,
    exists ? '' : 'an entry naming a script that is gone is a hole nobody is watching'
  );
  check(
    `read-register: ${entry.script} still reads a sibling source — otherwise this entry is ` +
      `stale and should go`,
    exists && READS_A_SIBLING_SOURCE.test(fs.readFileSync(abs, 'utf8'))
  );
  check(
    `read-register: ${entry.script} carries a reason and a citation a reader can act on`,
    entry.reason.length > 120 && entry.evidence.includes(entry.script),
    entry.evidence
  );
}

// ---------------------------------------------------------------------------
console.log('\n-- 4c. a SPAWNED mutant has to be shown to have started');
// ---------------------------------------------------------------------------
//
// THE LESSON THIS CARRIES, and it was paid for. A KAN-138 mutant died on
// startup — an unresolved import, milliseconds after spawning — and did NOT
// fail loudly. It failed as "the mutant leaked nothing", which is a section
// passing its subject while proving the opposite of what it claims. A mutant
// that died produces exactly the observation a well-behaved mutant produces.
// Only that script's own precondition caught it.
//
// SO THE SUITE WAS AUDITED FOR IT, and the finding is that the property holds
// today by two different mechanisms, neither of which anything asserted:
//
//   IMPORTED (7 proofs — activated-by, fleet-enumeration, reconfiguration-
//   refuses, send-confirms-delivery, state-read-echoes-config and this file)
//   `await import()` on a mutant that will not load THROWS. A dead mutant
//   cannot be quiet on this path.
//
//   SPAWNED AS A DAEMON (the three below) — the daemon is started and then
//   WAITED FOR: the socket must appear or the helper throws by name. That wait
//   is the precondition, written for another reason and doing this job.
//
//   SPAWNED AS A SCRIPT (verify-proof-cleans-up-when-interrupted) — the one
//   that learned it, and the one that says PRECONDITION out loud.
//
// WHAT IS CHECKED HERE AND WHAT IS NOT. The three below are a REGISTER, not a
// sweep, and that is a real weakness stated rather than hidden: a fourth proof
// that spawns a mutant daemon is not caught by anything here. A sweep was
// attempted and abandoned — "spawns a MUTANT" is not distinguishable from
// "spawns anything" in source text, and the detector that came closest went red
// on two proofs whose spawns are herdr stubs. A check that fails on correct
// code is worse than a register that admits what it is.
const SPAWNS_A_MUTANT_DAEMON = [
  'scripts/verify-config-echo-contract.mjs',
  'scripts/verify-event-contract.mjs',
  'scripts/verify-event-durability.mjs'
];
for (const rel of SPAWNS_A_MUTANT_DAEMON) {
  const abs = path.join(repoRoot, rel);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  check(
    `${rel} confirms a spawned daemon came up before measuring it`,
    /never opened its socket/.test(text) && USES_HELPER.test(text),
    text ? 'socket-readiness wait present' : 'file is gone — this register entry is stale'
  );
}

console.log('\n-- 4b. the register is held to the same standard as the sweep');
for (const entry of COPIES_BUT_DOES_NOT_MUTATE) {
  const abs = path.join(repoRoot, entry.script);
  const exists = fs.existsSync(abs);
  check(
    `register: ${entry.script} still exists`,
    exists,
    exists ? '' : 'an entry naming a script that is gone is a hole nobody is watching'
  );
  check(
    `register: ${entry.script} still copies a build — otherwise this entry is stale and should go`,
    exists && COPIES_BUILD.test(fs.readFileSync(abs, 'utf8'))
  );
  check(
    `register: ${entry.script} carries a reason and a citation a reader can act on`,
    entry.reason.length > 120 && /:\d+/.test(entry.evidence),
    entry.evidence
  );
}

// AND THE SWEEP CAN FAIL. A detector that matched nothing would report the same
// all-clear, in the same words, as one that matched everything — so it is run
// against a file written to be caught, and then against the same file fixed.
{
  const privateMutator =
    "import * as fs from 'node:fs';\n" +
    'fs.cpSync(distDir, target, { recursive: true });\n' +
    'fs.writeFileSync(p, before.replace(find, replace));\n';
  check(
    'the detector CATCHES a private mutator — asserted against a file written to be caught, ' +
      'because a detector that found nothing would pass the check above with the same words it ' +
      'uses when everything is right',
    COPIES_BUILD.test(privateMutator) && !USES_HELPER.test(privateMutator)
  );
  check(
    'and it CLEARS the same file once the import is there — so the rule is "go through the ' +
      'helper", not "never copy anything"',
    USES_HELPER.test(`import { makeMutator } from './mutation.mjs';\n${privateMutator}`)
  );
  check(
    'and it CLEARS it by DYNAMIC import as well — a proof that cannot take the helper at module ' +
      'top level is still going through it, and this fixture is the one that fails if the ' +
      'detector narrows back to the static form (KAN-199)',
    USES_HELPER.test(`const { makeMutator } = await import('./mutation.mjs');\n${privateMutator}`)
  );
  check(
    'a script that copies nothing is not swept up at all',
    !COPIES_BUILD.test("import * as fs from 'node:fs';\nfs.readFileSync(x);\n")
  );
}

// ---------------------------------------------------------------------------
console.log('\n-- 4d. and the shared arm can see every form the suite really imports the helper in');
// ---------------------------------------------------------------------------
//
// WHY THE FIXTURES ABOVE DO NOT COVER THIS, which is the whole reason this
// section exists (KAN-199). Every check in 4a and 4b hands `USES_HELPER` a
// string this file wrote. They prove it answers correctly about the forms
// SOMEONE THOUGHT OF — and the defect was precisely a form nobody thought of.
// A fixture set cannot notice its own omission: the narrow detector passed
// every fixture it had, every run it ever had, while a real proof in the suite
// sat outside it. So this sweep asks the opposite question, of files it did not
// write: does any real proof NAME the helper in a form the detector cannot see?
//
// It is the same walk-don't-list rule as §4 (KAN-166, KAN-148) turned on the
// detector rather than on the proofs. The fourth import syntax gets named the
// first time it appears, by a check nobody has to remember to update.
//
// WHAT IT COSTS AND WHERE THE BIAS POINTS. `MENTIONS_THE_HELPER` is textual and
// broad in the same way its siblings are, and it can fire on prose: a comment
// that quotes `'./mutation.mjs'` while importing nothing is a false positive.
// That costs whoever wrote it one reworded comment. The failure it exists to
// stop costs a proof its guard, silently, and this file is the third place in
// this epic where a detector was narrower than the sentence describing it.
//
// WHAT IT STILL DOES NOT COVER, said plainly: it checks that a mention and an
// import agree, not that the import is USED. A proof could match both and never
// call `mutate()`. §4/§4a own the direction that matters there — a proof that
// mutates without the helper — and nothing owns "imports the helper and mutates
// by hand anyway"; that shape has never been observed and is not filed.
const MENTIONS_THE_HELPER = /['"]\.\/mutation\.mjs['"]/;

const mentioners = [];
const invisible = [];
for (const rel of tracked) {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  if (!MENTIONS_THE_HELPER.test(text)) continue;
  mentioners.push(rel);
  if (!USES_HELPER.test(text)) invisible.push(rel);
}

const dynamicUsers = mentioners.filter((rel) =>
  /import\s*\(\s*['"]\.\/mutation\.mjs['"]/.test(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))
);

console.log(
  `\n   ${mentioners.length} proof(s) name scripts/mutation.mjs; ` +
    `${dynamicUsers.length} of them by dynamic import:`
);
for (const m of mentioners) {
  // This file counts as a dynamic user only because its own fixture strings
  // above spell one out; §4a's listing labels itself for the same reason.
  const how = dynamicUsers.includes(m)
    ? m.endsWith('verify-mutation-harness.mjs')
      ? '   (dynamic import — this file, in its own fixture text above)'
      : '   (dynamic import)'
    : '';
  const seen = invisible.includes(m) ? '   <-- USES_HELPER cannot see this' : '';
  console.log(`     ${m}${how}${seen}`);
}

check(
  '(setup) the suite really does import the helper — a sweep over an empty set would report this ' +
    "section's all-clear having looked at nothing",
  mentioners.length > 5,
  `${mentioners.length} proof(s) name the helper`
);
check(
  'every proof that names scripts/mutation.mjs is SEEN to use it — a form the detector cannot ' +
    'read makes that proof look like an evasion to both sweeps above, and the day it also copies ' +
    'a build it is named as having gone around a helper it is using',
  invisible.length === 0,
  invisible.length
    ? `${invisible.join(', ')} — USES_HELPER (${USES_HELPER}) does not match the import form used here; widen it`
    : `all ${mentioners.length} visible to ${USES_HELPER}`
);

// ---------------------------------------------------------------------------
console.log('\n-- 4e. WHICH SPELLINGS, exactly — including the ones nothing here can see');
// ---------------------------------------------------------------------------
//
// A REGEX PRESENTED AS COMPLETE IS THIS EPIC'S COMMONEST COSTUME, so the claim
// is not made in prose where it cannot be wrong. Every spelling below is
// asserted, in both directions, and the ones this file cannot see are asserted
// to be unseen rather than omitted from the list. The three-way split is the
// point:
//
//   USES_HELPER      — the detector reads it as going through the helper.
//   §4d NAMES IT     — the detector cannot read it, but the sweep above sees a
//                      quoted './mutation.mjs' and fails LOUDLY. Not covered,
//                      but it cannot go quiet, which is the property that
//                      failed here in the first place.
//   INVISIBLE        — neither. A proof written this way would sit outside all
//                      of §4, §4a and §4d exactly as the dynamic import did.
//                      Nothing in this repository is written this way today,
//                      and nothing checks that it stays so.
//
// The invisible column is the honest limit of a textual detector: the path has
// to be a straight-quoted literal spelled `./mutation.mjs`. Computing it —
// `path.join(scriptDir, 'mutation.mjs')` — or moving the helper into a
// subdirectory defeats it, and defeats §4d with it. Making that impossible
// needs a module graph rather than a regex, and is not attempted here.
{
  const SPELLINGS = [
    // [name, source, expect USES_HELPER, expect MENTIONS_THE_HELPER]
    ['static, single quotes', "import { makeMutator } from './mutation.mjs';", true, true],
    ['static, double quotes', 'import { makeMutator } from "./mutation.mjs";', true, true],
    ['static, namespace', "import * as m from './mutation.mjs';", true, true],
    ['static, newline before the specifier', "import { makeMutator } from\n  './mutation.mjs';", true, true],
    ['dynamic, awaited — the form KAN-199 was about', "const { makeMutator } = await import('./mutation.mjs');", true, true],
    ['dynamic, space before the paren', "await import ('./mutation.mjs')", true, true],
    ['dynamic, newline inside the paren', "await import(\n  './mutation.mjs'\n)", true, true],
    ['dynamic, double quotes', 'await import("./mutation.mjs")', true, true],
    ['side-effect import, no `from`', "import './mutation.mjs';", false, true],
    ['require — not ESM, so not used here, but spelled out', "const m = require('./mutation.mjs');", false, true],
    ['new URL(..., import.meta.url)', "await import(new URL('./mutation.mjs', import.meta.url))", false, true],
    ['dynamic, TEMPLATE LITERAL', 'await import(`./mutation.mjs`)', false, false],
    ['computed path — path.join(scriptDir, ...)', "await import(path.join(scriptDir, 'mutation.mjs'))", false, false],
    ['parent-relative path', "import { makeMutator } from '../mutation.mjs';", false, false],
    ['helper moved to a subdirectory', "import { makeMutator } from './scripts/mutation.mjs';", false, false]
  ];

  for (const [name, src, wantUses, wantMentions] of SPELLINGS) {
    const uses = USES_HELPER.test(src);
    const mentions = MENTIONS_THE_HELPER.test(src);
    const where = wantUses ? 'USES_HELPER' : wantMentions ? '§4d names it' : 'INVISIBLE to both';
    check(
      `spelling — ${name}: ${where}`,
      uses === wantUses && mentions === wantMentions,
      `USES_HELPER ${uses} (want ${wantUses}), MENTIONS_THE_HELPER ${mentions} (want ${wantMentions})`
    );
  }

  // AND THE TABLE IS NOT ALLOWED TO BECOME ALL-COVERED BY ACCIDENT. A future
  // widening that swallowed every row would leave this section asserting
  // nothing, in the same words it uses now.
  check(
    'the table still records forms this file cannot see — a table where everything passes is a ' +
      'table that has stopped saying anything',
    SPELLINGS.some(([, , wantUses]) => !wantUses) &&
      SPELLINGS.some(([, , , wantMentions]) => !wantMentions),
    `${SPELLINGS.filter(([, , u]) => !u).length} not matched by USES_HELPER, ` +
      `${SPELLINGS.filter(([, , , m]) => !m).length} invisible to both`
  );
}

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
