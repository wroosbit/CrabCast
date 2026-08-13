#!/usr/bin/env node
// KAN-349 RED DRIVE — what §7's four claim checks actually read.
//
// WHAT FAILURE THIS WOULD CATCH: a §7 whose claim checks are all satisfied by
// the status label, on a page whose observation has no evidence behind it. §7
// holds `docs/supervision.md`'s reboot claim to the shape of its evidence, and
// its coverage note reads as four independent constraints on the observation.
// This drive starves the EVIDENCE while leaving the LABEL intact and reports,
// per check, which ones notice — so the coverage note can be written from a
// measurement rather than from the code's intent.
//
// THIS IS NOT A PROOF AND IT IS NOT IN THE CI ARRAY, for the same reason
// `kan369-red-drive.mjs` is not: it is a one-off demonstration whose output
// belongs in a pull request rather than in a gate. Recorded in
// `docs/moving-baselines.md` so the next sweep does not have to re-derive that.
//
// IT MUTATES A DOCUMENT, NOT A BUILD, which is why it does not use
// `scripts/mutation.mjs`. That helper copies `dist` (or one script) into a
// scratch directory and hands the copy back; §7 reads `docs/supervision.md`
// from `repoRoot`, which it derives from its own location, so there is no path
// that points it at a copy. The mutation is therefore applied to the tree and
// restored — with the exact-occurrence discipline that helper's header argues
// for, because that discipline is the part that matters and it is independent
// of where the file lives.
//
// RESTORATION IS ON `exit` AND ON SIGINT/SIGTERM/SIGHUP, and it cannot cover
// SIGKILL. A run killed there leaves `docs/supervision.md` mutated in the
// working tree; `git checkout -- docs/supervision.md` is the recovery, and the
// drive prints `git status --short` at the end so a reader can see the tree
// came back clean rather than take it on trust.
//
// Usage:
//   npm run build                                  # §7's script needs dist/cli.js to exist
//   node scripts/kan349-red-drive.mjs              # baseline + every mutation
//   node scripts/kan349-red-drive.mjs --only evidence-deleted
//   node scripts/kan349-red-drive.mjs --list
//
// Each arm costs one full run of the proof (~35s), so `--only` exists for a
// reviewer re-running a single arm.

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const PROOF_REL = path.join('scripts', 'verify-daemon-foreground.mjs');
const DOC_REL = path.join('docs', 'supervision.md');
const docPath = path.join(repoRoot, DOC_REL);

/**
 * §7's claim checks, matched on the opening words of each label.
 *
 * The four the ticket calls "the claim checks" are `label`, `guarantee`,
 * `narrow` and `commands`. `vacuity`, `sliceOnly`, `claimPresent` and
 * `overclaim` are §7's other assertions on the same section and are reported
 * alongside them, because a mutation that reddened only those would be a
 * different finding from one that reddened a claim check.
 */
const CHECKS = {
  vacuity: 'section is present and substantial',
  sliceOnly: 'and the slice is that section only',
  claimPresent: 'it still makes the reboot-survival claim explicitly',
  label: 'and the claim opens with a status label saying which it is',
  guarantee: 'an observation is stated as evidence rather than a guarantee',
  narrow: 'and says how narrow it is',
  commands: 'and names the commands it was taken with',
  overclaim: 'and no sentence asserts reboot survival is handled'
};

/** The four the coverage note is a claim about. */
const CLAIM_CHECKS = ['label', 'guarantee', 'narrow', 'commands'];

const original = fs.readFileSync(docPath, 'utf8');

/**
 * Each mutation is a SLICE of the document named by its first and last anchor,
 * deleted whole. Anchors rather than line numbers because a line number is
 * silently wrong after any edit above it, and anchors rather than a pasted
 * paragraph because a pasted paragraph goes stale the moment the page is
 * reworded — the drive would then report `found 0` and stop, which is the
 * correct outcome and a loud one.
 *
 * `expectRed` names the claim checks that MUST go red under the mutation, and
 * `expectGreen` the ones that must survive. Naming both is what makes an arm a
 * measurement: a mutation that reddens everything says nothing about which
 * check was doing the work.
 */
const MUTATIONS = [
  {
    name: 'evidence-deleted',
    what:
      "the ticket's own mutation — every paragraph after the claim deleted, label kept. " +
      'This is the one `epic/KAN-59` ran while reviewing PR #81.',
    from: 'The machine went down cleanly at 03:52 PDT',
    to: 'EOF',
    expectRed: ['commands'],
    expectGreen: ['label', 'guarantee', 'narrow']
  },
  {
    name: 'evidence-deleted-advice-kept',
    what:
      'the same starve, one paragraph narrower: the two EVIDENCE paragraphs deleted and the ' +
      'closing "if you reboot, run these" paragraph kept. That paragraph is a standing ' +
      'recommendation about a FUTURE reboot, not evidence of the observed one — and it names ' +
      'the same commands.',
    from: 'The machine went down cleanly at 03:52 PDT',
    to: 'If you install this and then reboot for your own reasons,',
    expectRed: [],
    expectGreen: ['label', 'guarantee', 'narrow', 'commands']
  }
];

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.name} — ${m.what}`);
  process.exit(0);
}
const onlyFlag = argv.indexOf('--only');
const only = onlyFlag === -1 ? null : argv[onlyFlag + 1];
const selected = only === null ? MUTATIONS : MUTATIONS.filter((m) => m.name === only);
if (!selected.length) {
  console.error(`no mutation named ${only}. --list shows the names.`);
  process.exit(2);
}

let failures = 0;
const verdict = (ok, line) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

function restore() {
  try {
    fs.writeFileSync(docPath, original);
  } catch {
    /* best effort — the git checkout in the header is the backstop */
  }
}
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

/** Read one §7 check's verdict out of a run's output. */
function checkVerdict(out, label) {
  const line = out.split('\n').find((l) => l.includes(label));
  if (!line) return 'absent';
  return /^PASS\s/.test(line) ? 'PASS' : 'FAIL';
}

/** Run the proof against whatever is on disk now. */
function runProof() {
  const r = spawnSync('node', [PROOF_REL], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    status: r.status,
    out,
    checks: Object.fromEntries(
      Object.entries(CHECKS).map(([k, v]) => [k, checkVerdict(out, v)])
    ),
    sectionChars: Number((out.match(/section is present and substantial — (\d+) chars/) ?? [])[1] ?? -1)
  };
}

const fmt = (checks, keys) => keys.map((k) => `${k}=${checks[k]}`).join(' ');

console.log('KAN-349 RED DRIVE — what §7\'s four claim checks actually read');
console.log(`  proof:  ${PROOF_REL}`);
console.log(`  target: ${DOC_REL}`);
console.log(
  `  at:     ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}`
);
console.log(`  scope:  ${only === null ? 'every mutation' : only}`);
console.log(
  '  baseline: the unmutated page is expected green; each mutation below is applied to it alone.\n'
);

// THE FALSE-POSITIVE CONTROL, first. A guard that fires on an honest page is a
// red at a maintainer who did nothing wrong, which `docs/supervision.md` ranks
// as the worse failure. Without this line a mutation that reddens a check
// proves nothing — the check might have been red already.
{
  const r = runProof();
  const allGreen = Object.values(r.checks).every((v) => v === 'PASS');
  verdict(
    r.status === 0 && allGreen,
    `CONTROL: the PRISTINE page passes every §7 section check and the proof exits 0 — ` +
      `exit ${r.status}, section ${r.sectionChars} chars, ${fmt(r.checks, Object.keys(CHECKS))}`
  );
}

for (const m of selected) {
  console.log(`\n--- ${m.name} — ${m.what}`);

  // EXACT COUNT, not "at least one" — the discipline `scripts/mutation.mjs`
  // enforces, for the reason its header gives: a mutation that hit zero sites
  // produces an UNMUTATED run that the drive then reports a verdict about, and
  // one that hit three is not the mutation that was designed.
  const fromCount = original.split(m.from).length - 1;
  const toCount = m.to === 'EOF' ? 1 : original.split(m.to).length - 1;
  if (fromCount !== 1 || toCount !== 1) {
    verdict(
      false,
      `MUTATION NOT APPLIED: anchors must occur exactly once in ${DOC_REL} — ` +
        `from=${fromCount}, to=${toCount}. Fix the mutation, not this drive.`
    );
    continue;
  }

  const start = original.indexOf(m.from);
  const end = m.to === 'EOF' ? original.length : original.indexOf(m.to);
  if (end <= start) {
    verdict(false, `MUTATION NOT APPLIED: the \`to\` anchor precedes the \`from\` anchor in ${DOC_REL}.`);
    continue;
  }
  const mutated = original.slice(0, start) + original.slice(end);
  if (mutated === original) {
    verdict(false, 'MUTATION NOT APPLIED: it changes nothing, so the run below would be the control again.');
    continue;
  }

  fs.writeFileSync(docPath, mutated);
  const deleted = original.length - mutated.length;
  const r = runProof();
  restore();

  console.log(
    `  MUTATION APPLIED: ${deleted} chars deleted from ${DOC_REL}; ` +
      `§7 reads the section at ${r.sectionChars} chars (pristine 2506).`
  );
  console.log(`  proof exit ${r.status}; ${fmt(r.checks, Object.keys(CHECKS))}`);

  const reds = m.expectRed.filter((k) => r.checks[k] !== 'FAIL');
  verdict(
    reds.length === 0,
    m.expectRed.length
      ? `the checks that must notice this starve are red — expected red: ${m.expectRed.join(', ')}` +
          (reds.length ? `; but ${fmt(r.checks, reds)}` : '')
      : 'no claim check is expected to notice this starve, and none is required to'
  );

  const greens = m.expectGreen.filter((k) => r.checks[k] !== 'PASS');
  verdict(
    greens.length === 0,
    `and the checks that CANNOT notice it are green, which is the finding rather than a pass — ` +
      `expected green: ${m.expectGreen.join(', ')}` + (greens.length ? `; but ${fmt(r.checks, greens)}` : '')
  );

  const claimReds = CLAIM_CHECKS.filter((k) => r.checks[k] === 'FAIL');
  console.log(
    `  => of the four claim checks, ${claimReds.length} went red under this starve` +
      `${claimReds.length ? ` (${claimReds.join(', ')})` : ''}; ` +
      `the proof as a whole exited ${r.status}.`
  );
}

// The tree came back. Printed rather than asserted silently, because a drive
// that mutates the working tree owes the reader the evidence it put it back.
const status = execFileSync('git', ['status', '--short', '--', DOC_REL], {
  cwd: repoRoot,
  encoding: 'utf8'
});
verdict(
  status.trim() === '',
  `the working tree is restored — \`git status --short -- ${DOC_REL}\` is ` +
    (status.trim() === '' ? 'empty' : JSON.stringify(status))
);

console.log(`\n${failures ? `RED: ${failures} verdict(s) failed` : 'GREEN: every verdict held'}`);
process.exit(failures ? 1 : 0);
