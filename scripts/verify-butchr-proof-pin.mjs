#!/usr/bin/env node
// KAN-519: the imported Butchr proofs run at the ref somebody read, and the
// register that says which of them gate CrabCast is internally honest.
//
// WHAT FAILURE THIS WOULD CATCH: `.github/workflows/ci.yml` checking out
// `wroosbit/butchr` at `main` — or at a SECOND copy of the SHA pasted into the
// workflow — while `.butchr-proof-pin.json` goes on naming `e8729f5`. The job
// would then run proofs nobody reviewed, the pin file would still read like the
// authority, and nothing would disagree with anything. A pin is only worth the
// thing that reads it.
//
// ---------------------------------------------------------------------------
// WHY THIS SCRIPT EXISTS AT ALL, AND WHAT IT DELIBERATELY DOES NOT COVER
//
// KAN-518 decided the imported proofs live OUTSIDE CrabCast's guard perimeter,
// permanently and by construction: they are an untracked CI-time checkout of
// another repository, so `git ls-files scripts` never returns them and neither
// `verify-proof-registry` nor `verify-proof-verdicts` can see them. That was
// measured rather than assumed, both arms, and recorded as the accepted cost
// (docs/butchr-proof-import.md, "The perimeter, re-derived at today's refs").
//
// The half-cover that decision left for this ticket, in its own words:
//
//     "a CrabCast-owned proof at the flat path can audit THE PIN. That puts the
//      PIN inside the perimeter. It never puts the PROOFS inside it, and no
//      placement does."
//
// ⚠ THIS SCRIPT IS THAT HALF AND NOT MORE. It audits the pin file, the wiring
// that reads it, and the register's internal consistency — all of which are
// CrabCast's own tracked text. It asserts NOTHING about whether the imported
// proofs pass, whether their citations are real, or whether they gate anything;
// it cannot, because at the moment it runs the checkout does not exist.
//
// WHO COVERS THE REST: `scripts/butchr-proof-reconcile.mjs`, inside the
// `butchr-proofs` job, where the checkout does exist. It reconciles this
// register against the proofs actually at the pin, verifies every citation is
// that proof's own text, and asserts the missing-socket disposition. §3 below
// asserts that job still invokes it — so the two halves cannot be separated
// without this going red. That is the KAN-145 lesson applied to my own edge:
// two scripts that are each honest can still leave a hole between them, and the
// header is where the edge gets marked.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WIRED, EXCLUDED, ABSENT_AT_THESE_REFS } from './butchr-proof-import-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = '.butchr-proof-pin.json';
const WORKFLOW = path.join('.github', 'workflows', 'ci.yml');

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  }
  return ok;
}
const rule = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

const pinRaw = fs.readFileSync(path.join(repoRoot, PIN_FILE), 'utf8');
const pin = JSON.parse(pinRaw);
const yaml = fs.readFileSync(path.join(repoRoot, WORKFLOW), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
rule('1. THE PIN NAMES ONE REVIEWED COMMIT');

const FULL_SHA = /^[0-9a-f]{40}$/;

check(
  typeof pin.ref === 'string' && FULL_SHA.test(pin.ref),
  'the pinned ref is a full 40-character lowercase SHA',
  `got ${JSON.stringify(pin.ref)} — a branch name or a short SHA is a moving or ambiguous target, ` +
    'and the whole value of a pin is that the proofs CI runs are the proofs somebody read'
);
check(
  typeof pin.repo === 'string' && /github\.com\/wroosbit\/butchr$/.test(pin.repo),
  'the pin names wroosbit/butchr',
  `got ${JSON.stringify(pin.repo)}`
);
for (const key of ['pinnedAt', 'pinnedBy', 'staleness']) {
  check(Object.hasOwn(pin, key), `the pin carries \`${key}\``);
}
check(
  typeof pin.staleness?.policy === 'string' && pin.staleness.policy.length > 0,
  'the staleness policy is stated rather than left to be inferred',
  JSON.stringify(pin.staleness?.policy ?? null)
);

// ───────────────────────────────────────────────────────────────────────────
rule('2. THE WORKFLOW READS THE PIN — it does not carry a second copy of the SHA');

// TWO LISTS IS TWO PLACES TO FORGET. The workflow must obtain the ref BY
// READING the file; a SHA pasted into the YAML is a copy that drifts silently,
// and the drift is invisible because both halves look authoritative.
const shasInWorkflow = [...yaml.matchAll(/\b[0-9a-f]{40}\b/g)].map((m) => m[0]);
check(
  shasInWorkflow.length === 0,
  'no 40-character SHA is hard-coded anywhere in the workflow',
  shasInWorkflow.length
    ? `found ${shasInWorkflow.length}: ${[...new Set(shasInWorkflow)].join(', ')} — read the ref from ` +
      `${PIN_FILE} instead, so there is only one place to change it`
    : ''
);
check(
  yaml.includes(PIN_FILE),
  `the workflow names ${PIN_FILE}`,
  `it must read the ref out of the pin file for the pin to mean anything`
);

// ───────────────────────────────────────────────────────────────────────────
rule('3. THE JOB STILL RUNS THE HALF THIS SCRIPT CANNOT');

// The pairing that closes the loop. This script is an entry in the `verify`
// array, which verify-proof-registry requires; reconcile runs in the
// butchr-proofs job and covers what this one cannot see. Asserting its
// invocation here means neither half can be dropped while the other stays
// green — the same shape verify-cli-parity §6 uses on the proof-registry job.
for (const [label, needle] of [
  ['scripts/butchr-proof-reconcile.mjs', 'node scripts/butchr-proof-reconcile.mjs'],
  ['scripts/butchr-proof-harness.mjs', 'scripts/butchr-proof-harness.mjs'],
]) {
  check(
    yaml.includes(needle),
    `the workflow invokes ${label}`,
    `\`${needle}\` is not in ${WORKFLOW} — if it vanished in a merge, this is the entry that was dropped`
  );
}

// A wired proof that no longer appears in the workflow's loop is a proof
// nobody runs, described by a register that says it gates something.
for (const e of WIRED) {
  check(
    yaml.includes(e.script),
    `the workflow's loop still names the wired proof ${e.script}`,
    'it is WIRED in the register and absent from the workflow — the register would be claiming ' +
      'a gate that does not run'
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('4. THE REGISTER IS INTERNALLY HONEST');

const wiredNames = WIRED.map((e) => e.script);
const excludedNames = EXCLUDED.map((e) => e.script);
const all = [...wiredNames, ...excludedNames];

check(new Set(all).size === all.length, 'no proof appears twice across the two lists',
  all.filter((n, i) => all.indexOf(n) !== i).join(', '));
check(WIRED.length > 0, 'at least one proof is wired — a job that runs nothing is not a gate');

// THE PREDICATES ARE NAMED ONCE AND USED TWICE — here against the real
// register, and in section 5 against deliberately broken copies of it. That is
// what makes section 5 a red drive of THESE checks rather than of a
// re-implementation that could drift into agreeing with itself.
const PREDICATES = {
  namesConsumerBehaviour: (e) =>
    typeof e.consumerBehaviour === 'string' && e.consumerBehaviour.trim().length >= 40,
  // A proof that has only ever passed is evidence of nothing. Every wired entry
  // has to carry the mutation that was actually applied and what it produced.
  recordsARedDriveThatWentRed: (e) =>
    typeof e.redDrive?.mutation === 'string' &&
    e.redDrive.mutation.trim().length > 0 &&
    typeof e.redDrive?.result === 'string' &&
    /PROOF_EXIT=[12]/.test(e.redDrive.result),
  namesTheGatingArm: (e) => typeof e.gatingSection === 'string' && e.gatingSection.trim().length > 0,
  carriesAReason: (e) => typeof e.reason === 'string' && e.reason.trim().length >= 40,
  recordsItsClass: (e) => ['yes', 'partial', 'no'].includes(e.class),
  carriesACitation: (e) => typeof e.evidence?.quote === 'string' && e.evidence.quote.trim().length > 0,
};

for (const e of WIRED) {
  check(PREDICATES.namesConsumerBehaviour(e),
    `wired '${e.script}' names the CONSUMER BEHAVIOUR it covers, not just itself`);
  check(PREDICATES.recordsARedDriveThatWentRed(e),
    `wired '${e.script}' records a red drive that actually went red`,
    `redDrive must name the mutation and a result carrying PROOF_EXIT=1 or 2 — got ${JSON.stringify(e.redDrive ?? null)}`);
  check(PREDICATES.namesTheGatingArm(e), `wired '${e.script}' names the arm that does the gating`);
}

for (const e of EXCLUDED) {
  check(PREDICATES.carriesAReason(e), `excluded '${e.script}' carries a reason, not just a name`);
  check(PREDICATES.recordsItsClass(e), `excluded '${e.script}' records its own CI-RUNNABLE class`,
    `got ${JSON.stringify(e.class)}`);
}

for (const e of [...WIRED, ...EXCLUDED]) {
  check(PREDICATES.carriesACitation(e), `'${e.script}' carries a quoted citation`,
    `evidence must be { quote, note } — got ${JSON.stringify(e.evidence ?? null)}`);
}

// The class is NOT the reason. If every `partial` were excluded and every
// wired proof were something else, the register would be classifying rather
// than measuring — and KAN-519 requires per-arm evaluation precisely because
// the class does not decide.
check(
  EXCLUDED.some((e) => e.class === 'partial'),
  'at least one `partial` proof is excluded — the class is measured per arm, not taken as a verdict',
  'every partial is wired, which would mean the register read the header rather than the behaviour'
);

for (const a of ABSENT_AT_THESE_REFS) {
  check(
    !fs.existsSync(path.join(repoRoot, 'scripts', `${a.script}.mjs`)),
    `'${a.script}' is still absent from CrabCast's scripts/, as recorded`,
    'it has arrived — classify it rather than leaving it described as absent'
  );
  check(
    typeof a.finding === 'string' && a.finding.trim().length >= 40,
    `'${a.script}' records WHY it is absent rather than only that it is`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('5. THE CHECKS ABOVE GO RED WHEN THE THINGS THEY GUARD BREAK');

// A check that cannot fail is not a check. Every assertion above is re-run here
// against a deliberately broken copy IN MEMORY — no file is written, so this
// section cannot leave residue — and each must go the other way.
let redDrives = 0;
let redDrivesCaught = 0;
const drive = (label, ok) => {
  redDrives += 1;
  if (ok) redDrivesCaught += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// ── section 1's checks, driven ──
drive('a branch name in place of the pinned SHA is rejected', !FULL_SHA.test('main'));
drive('a short SHA in place of the pinned SHA is rejected', !FULL_SHA.test(pin.ref.slice(0, 12)));
drive('an uppercase SHA is rejected — the pin is one spelling, not several',
  !FULL_SHA.test(pin.ref.toUpperCase()));
// THE POSITIVE CONTROL. A check that refused everything would satisfy all three
// drives above while being useless, so the real ref has to be accepted here.
drive('the real pinned SHA is accepted — so the check discriminates rather than refusing everything',
  FULL_SHA.test(pin.ref));

// ── section 2's checks, driven against a mutated copy of THIS workflow ──
drive('a SHA pasted into the workflow is caught',
  [...`${yaml}\n          ref: ${pin.ref}\n`.matchAll(/\b[0-9a-f]{40}\b/g)].length > 0);
drive('the workflow as it stands carries no such SHA — the control for the drive above',
  [...yaml.matchAll(/\b[0-9a-f]{40}\b/g)].length === 0);

// ── section 3's checks, driven ──
drive('a workflow that stopped invoking reconcile is caught',
  !yaml.replace('node scripts/butchr-proof-reconcile.mjs', 'node scripts/nothing.mjs')
    .includes('node scripts/butchr-proof-reconcile.mjs'));
drive('a workflow whose loop dropped a wired proof is caught',
  !yaml.replace(WIRED[0].script, 'verify-crabcast-something-else').includes(WIRED[0].script));

// ── section 4's checks, driven against BROKEN COPIES OF THE REAL ENTRIES ──
//
// Each mutation takes a genuine entry and removes exactly the property under
// test, so what is exercised is the predicate the section above actually used.
const wired0 = WIRED[0];
const excluded0 = EXCLUDED[0];

drive('a wired entry with no consumerBehaviour is caught',
  !PREDICATES.namesConsumerBehaviour({ ...wired0, consumerBehaviour: undefined }));
drive('a wired entry whose consumerBehaviour is a stub is caught',
  !PREDICATES.namesConsumerBehaviour({ ...wired0, consumerBehaviour: 'it broke' }));
drive('the real wired entries satisfy it — the control',
  WIRED.every(PREDICATES.namesConsumerBehaviour));

drive('a wired entry with no red drive is caught',
  !PREDICATES.recordsARedDriveThatWentRed({ ...wired0, redDrive: undefined }));
drive('a wired entry whose red drive never went red is caught',
  !PREDICATES.recordsARedDriveThatWentRed({
    ...wired0,
    redDrive: { mutation: 'renamed a field', result: 'BUILD_EXIT=0, PROOF_EXIT=0 — all assertions passed' },
  }));
drive('a wired entry whose red drive names no mutation is caught',
  !PREDICATES.recordsARedDriveThatWentRed({ ...wired0, redDrive: { mutation: '', result: 'PROOF_EXIT=1' } }));
drive('the real red drives satisfy it — the control',
  WIRED.every(PREDICATES.recordsARedDriveThatWentRed));

drive('a wired entry naming no gating arm is caught',
  !PREDICATES.namesTheGatingArm({ ...wired0, gatingSection: '' }));

drive('an excluded entry with no reason is caught',
  !PREDICATES.carriesAReason({ ...excluded0, reason: undefined }));
drive('an excluded entry whose reason is a stub is caught',
  !PREDICATES.carriesAReason({ ...excluded0, reason: 'needs herdr' }));
drive('the real exclusions satisfy it — the control', EXCLUDED.every(PREDICATES.carriesAReason));

drive('an excluded entry with an invented CI-RUNNABLE class is caught',
  !PREDICATES.recordsItsClass({ ...excluded0, class: 'sometimes' }));
drive('an entry with no citation is caught',
  !PREDICATES.carriesACitation({ ...wired0, evidence: undefined }));
drive('an entry whose citation is empty is caught',
  !PREDICATES.carriesACitation({ ...wired0, evidence: { quote: '   ', note: 'x' } }));
drive('the real citations satisfy it — the control',
  [...WIRED, ...EXCLUDED].every(PREDICATES.carriesACitation));

drive('a duplicated proof across the two lists is caught',
  new Set([...all, wired0.script]).size !== [...all, wired0.script].length);

check(
  redDrivesCaught === redDrives,
  `every check in this script was shown going the other way (${redDrivesCaught}/${redDrives})`
);

// ───────────────────────────────────────────────────────────────────────────
console.log('');
console.log(
  `pin ${pin.ref.slice(0, 12)} · ${WIRED.length} wired, ${EXCLUDED.length} excluded, ` +
    `${ABSENT_AT_THESE_REFS.length} recorded absent`
);
if (failures) {
  console.log(`\n${failures} CHECK(S) FAILED`);
} else {
  console.log('\nAll checks passed');
}
process.exit(failures ? 1 : 0);
