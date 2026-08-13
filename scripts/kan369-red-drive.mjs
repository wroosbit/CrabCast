#!/usr/bin/env node
// KAN-369 RED DRIVE — the mutations behind section 4d, run one at a time.
//
// WHAT FAILURE THIS WOULD CATCH: section 4d of
// `verify-ci-proof-residue-is-legible` asserts that an ambient host-side git
// revision is refused, and a green section 4d proves nothing unless its arms can
// go red. This drives each mechanism that holds KAN-369's deletion — the guard's
// call site, the refusal ledger, the immutability test, and the absence of the
// read itself — and asserts each one produces the red it is supposed to.
//
// THIS IS NOT A PROOF AND IT IS NOT IN THE CI ARRAY, for the same reason
// `kan114-send-before-and-after.mjs` is not: it is a one-off demonstration whose
// output belongs in a pull request rather than in a gate. Recorded in
// `docs/moving-baselines.md` so the next sweep does not have to re-derive that.
//
// WHY A SCRIPT RATHER THAN PASTED COMMANDS. `prompts/task.md` asks that the
// recipe for a red be reproducible by the reviewer, and that each mutation be
// asserted applied with an exact occurrence count. Both are mechanical, so they
// are here rather than in prose.
//
// Usage:
//   npm run build
//   node scripts/kan369-red-drive.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const PROOF_REL = path.join('scripts', 'verify-ci-proof-residue-is-legible.mjs');
const proofPath = path.join(repoRoot, PROOF_REL);

/** The variant lives in `scripts/` because the proof derives `repoRoot` from its
 *  own location, and a copy anywhere else would sandbox the wrong tree. */
const VARIANT_REL = path.join('scripts', 'kan369-variant.mjs');
const variantPath = path.join(repoRoot, VARIANT_REL);

/** Section 4d's four arms, matched on the opening words of each label. */
const ARMS = {
  refused: 'THE READ KAN-369 REMOVED IS NOW REFUSED',
  pinned: 'AND THE PINNED READ IS STILL PERMITTED',
  scoped: 'AND THE GUARD DOES NOT REACH THE SANDBOX',
  ledger: 'AND NOTHING ELSE IN THIS RUN MADE AN AMBIENT HOST READ'
};

const source = fs.readFileSync(proofPath, 'utf8');

/**
 * Each mechanism, broken alone.
 *
 * `expectRed` names the section 4d arms that MUST go red, and `expectGreen` the
 * ones that must survive — a mutation that reddens everything demonstrates
 * nothing about which mechanism did the work, so both directions are asserted.
 */
const MUTATIONS = [
  {
    name: 'guard-not-armed',
    what: 'the guard is never called: `git()` performs the host read unchecked',
    find: '  if (cwd === repoRoot) assertHostRevisionsAreImmutable(args);',
    replace: '  if (false && cwd === repoRoot) assertHostRevisionsAreImmutable(args);',
    expectRed: ['refused', 'ledger'],
    expectGreen: ['pinned', 'scoped']
  },
  {
    name: 'ledger-silent',
    what: 'the refusal still throws but is never recorded — the state a swallowing caller restores',
    find: '  refusedHostReads.push({ args: [...args], ambient });',
    replace: '  /* KAN-369 red drive: ledger write removed */',
    expectRed: ['ledger'],
    expectGreen: ['refused', 'pinned', 'scoped']
  },
  {
    name: 'ambient-ref-allowlisted',
    what: '`origin/main` is treated as a subject revision, which is the blocklist mistake this guard avoids',
    find: "const SUBJECT_REVISIONS = new Set(['HEAD']);",
    replace: "const SUBJECT_REVISIONS = new Set(['HEAD', 'origin/main']);",
    expectRed: ['refused', 'ledger'],
    expectGreen: ['pinned', 'scoped']
  },
  {
    name: 'read-reintroduced',
    what: 'the deleted host read is put back, wrapped in the same `catch` `preFixTarget()` used',
    find: 'hostReadRefused: {',
    replace:
      'try { git([\'show\', `origin/main:${TARGET_REL}`]); } catch { /* KAN-369 red drive: swallowed, exactly as preFixTarget did */ }\n' +
      'hostReadRefused: {',
    expectRed: ['ledger'],
    expectGreen: ['refused', 'pinned', 'scoped']
  },
  {
    name: 'pinned-read-refused-too',
    what: 'the policy over-reaches and refuses an immutable revision — the negative control for arm 2',
    find: 'const IMMUTABLE_REV = /^[0-9a-f]{40}$/;',
    replace: 'const IMMUTABLE_REV = /^(?!0edd2c1)[0-9a-f]{40}$/;',
    expectRed: ['pinned'],
    expectGreen: ['refused', 'scoped']
  }
];

let failures = 0;
const verdict = (ok, line) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

function cleanUp() {
  try { fs.rmSync(variantPath, { force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

/** Read a section-4d arm's verdict out of a run's output. */
function armVerdict(out, label) {
  const line = out.split('\n').find((l) => l.includes(label));
  if (!line) return 'absent';
  return /^\s*PASS\s/.test(line) ? 'PASS' : 'FAIL';
}

console.log('KAN-369 RED DRIVE');
console.log(`  proof:   ${PROOF_REL}`);
console.log(`  at:      ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}`);
console.log(`  baseline: the unmutated proof is expected green; each mutation below is applied to it alone.\n`);

// The unmutated run first. Without it a mutation that reddens an arm proves
// nothing — the arm might have been red already.
{
  const r = spawnSync('node', [PROOF_REL], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const arms = Object.fromEntries(Object.entries(ARMS).map(([k, v]) => [k, armVerdict(out, v)]));
  const allGreen = Object.values(arms).every((v) => v === 'PASS');
  verdict(r.status === 0 && allGreen,
    `BASELINE: the unmutated proof exits 0 with all four section 4d arms green — ` +
    `exit ${r.status}, ${Object.entries(arms).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

for (const m of MUTATIONS) {
  console.log(`\n--- ${m.name} — ${m.what}`);

  // EXACT COUNT, not "at least one" — the discipline `scripts/mutation.mjs`
  // enforces for every mutation in this suite, for the reason its header gives:
  // a mutation that hit zero sites produces an UNMUTATED run that the drive then
  // reports a verdict about.
  const count = source.split(m.find).length - 1;
  if (count !== 1) {
    verdict(false,
      `MUTATION NOT APPLIED: expected exactly 1 occurrence of ${JSON.stringify(m.find.slice(0, 60))} ` +
      `in ${PROOF_REL}, found ${count}. Fix the mutation, not this drive.`);
    continue;
  }
  console.log(`  mutation applied: 1 occurrence of ${JSON.stringify(m.find.slice(0, 60))}`);

  fs.writeFileSync(variantPath, source.replace(m.find, m.replace));

  const r = spawnSync('node', [VARIANT_REL], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const arms = Object.fromEntries(Object.entries(ARMS).map(([k, v]) => [k, armVerdict(out, v)]));
  console.log(`  exit ${r.status}; arms: ${Object.entries(arms).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  for (const arm of m.expectRed) {
    verdict(arms[arm] === 'FAIL',
      `${m.name}: arm \`${arm}\` goes RED — ${arms[arm] === 'FAIL' ? 'it did' : `it read ${arms[arm]}`}`);
  }
  for (const arm of m.expectGreen) {
    verdict(arms[arm] === 'PASS',
      `${m.name}: arm \`${arm}\` is UNAFFECTED — ${arms[arm] === 'PASS' ? 'it stayed green' : `it read ${arms[arm]}`}`);
  }
  verdict(r.status !== 0, `${m.name}: and the run as a whole goes red — exit ${r.status}`);

  fs.rmSync(variantPath, { force: true });
}

// -----------------------------------------------------------------------------
// THE ONE MECHANISM WHOSE RED IS NOT A COUNTED FAIL, said rather than omitted.
//
// Arm 3 (`scoped`) asserts the guard does not reach the sandbox. Breaking that —
// applying the policy to every cwd — does not redden arm 3, because the sandbox
// is constructed long before section 4d runs and `git checkout -B` is not a
// declared host subcommand: the run dies during `buildSandbox` with the guard's
// own error and never prints a verdict line at all. That is a real red and a
// reproducible one, and it is NOT the shape `scripts/mutation.mjs` asks for. It
// is driven here as what it is rather than dressed up as what it is not.
console.log('\n--- guard-over-reaches — the scope condition removed (arm 3\'s mechanism)');
{
  const find = '  if (cwd === repoRoot) assertHostRevisionsAreImmutable(args);';
  const count = source.split(find).length - 1;
  if (count !== 1) {
    verdict(false, `MUTATION NOT APPLIED: expected exactly 1 occurrence, found ${count}`);
  } else {
    console.log(`  mutation applied: 1 occurrence of ${JSON.stringify(find.slice(0, 60))}`);
    fs.writeFileSync(variantPath, source.replace(find, '  assertHostRevisionsAreImmutable(args);'));
    const r = spawnSync('node', [VARIANT_REL], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const died = /AMBIENT HOST REVISION REFUSED/.test(out) && !/checks passed\.|checks? failed/.test(out);
    verdict(r.status !== 0 && died,
      'guard-over-reaches: the run dies during sandbox construction with the guard\'s own error and ' +
      `prints no verdict line — exit ${r.status}, guard error present: ${/AMBIENT HOST REVISION REFUSED/.test(out)}, ` +
      `verdict line printed: ${/checks passed\./.test(out) ? 'yes' : 'NONE'}`);
    fs.rmSync(variantPath, { force: true });
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0
  ? 'RED DRIVE COMPLETE — every mechanism was broken alone and produced the red it should.'
  : `RED DRIVE INCOMPLETE — ${failures} expectation(s) not met.`);
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
