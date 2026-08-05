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
  const { mutate, mutationsSkipped } = makeMutator({
    distDir,
    scratch: tmp,
    report: {
      pass: (name, detail) => seen.push({ name, ok: true, detail: detail ?? '' }),
      fail: (name, detail) => seen.push({ name, ok: false, detail: detail ?? '' })
    }
  });
  return { mutate, mutationsSkipped, seen };
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
const USES_HELPER = /from\s+['"]\.\/mutation\.mjs['"]/;

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
  const why = registered.has(m) ? '   (registered: not a mutation)' : '   <-- went around mutation.mjs';
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
    'a script that copies nothing is not swept up at all',
    !COPIES_BUILD.test("import * as fs from 'node:fs';\nfs.readFileSync(x);\n")
  );
}

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
