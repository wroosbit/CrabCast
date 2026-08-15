#!/usr/bin/env node
// KAN-433: the detector. Which proofs do docs/*.md name, and which of those
// does CI actually run?
//
// NOT A PROOF, AND DELIBERATELY NOT NAMED LIKE ONE. It asserts nothing about
// the tree and gates nothing; it is a survey whose output is evidence on a pull
// request, in the same family as `kan385-herdr-handle-survey.mjs`. The gate
// this ticket ships is `verify-doc-proof-ci-class.mjs`, which is narrower on
// purpose — it holds ONE table rather than nine documents, because a table is
// where a uniform presentation can be mechanically compared against a
// non-uniform world. This file is how the ticket's population was measured; it
// is not how the population is kept honest.
//
// WHY IT EXISTS. KAN-391 found one document resting a claim on a proof CI does
// not run, without saying so. This re-derives that sweep at whatever head it is
// run on, because the numbers in KAN-433's description were taken at `96032ad`
// and the array has moved since.
//
// THE TWO SIDES OF THE JOIN, and neither is re-implemented here:
//
//   the NAMES   every `verify-<name>` token appearing in any docs/*.md, by
//               literal match.
//   the WORLD   whether `.github/workflows/ci.yml` runs `scripts/<name>.mjs`
//               on every run — read with `readVerifyArray` and
//               `findRunInvocations` from `scripts/ci-workflow.mjs`, which are
//               the same two functions `verify-proof-registry.mjs` uses to
//               make exactly this judgement. A second reader of that workflow,
//               free to drift from the first, is the defect ci-workflow.mjs
//               was extracted to prevent.
//
// FOUR OUTCOMES PER NAME, because "not in the array" means four different
// things and collapsing them is how a survey manufactures a finding:
//
//   RUN (array)    an entry in the `scripts=(` array.
//   RUN (own job)  a live top-level `node scripts/<name>.mjs` somewhere else in
//                  ci.yml — how `verify-proof-registry.mjs` itself runs.
//   NOT RUN        a tracked proof in this repository that CI does not run. THE
//                  ONLY CATEGORY THIS TICKET IS ABOUT.
//   FOREIGN        named in a document but not a tracked `scripts/verify-*.mjs`
//                  here at all — `verify-crabcast-runtime-live` is Butchr's
//                  script, in another repository, and reporting it as an
//                  uncovered CrabCast proof would be a false finding.
//
// ⚠ THREE LIMITS, carried forward verbatim from KAN-433's own statement of them
// rather than rediscovered:
//
//   1. A LITERAL MATCH CANNOT FIND A NAME ASSEMBLED AT RUNTIME. A document that
//      refers to a proof by interpolation is invisible here, and no control
//      catches that — the sweep reports the same clean answer either way.
//   2. IT MATCHES NAMES, NOT CLAIMS. A document that leans on a proof without
//      naming it is invisible to it.
//   3. WHETHER THE PROSE IS HONEST IS A HUMAN READING of each passage. This
//      prints the passages; it does not judge them.
//
// CONTROLS. Every null result below is stated with the instrument's own proof
// that it could have said otherwise, because KAN-433 shipped with a control
// (`grep -ci 'CI'`) that could not distinguish the token it was counting from
// the letters inside `decision`. A control that cannot fail is not a control.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRunInvocations, readVerifyArray } from './ci-workflow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const yaml = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

/** A name no proof has ever had. If this is ever FOUND, the matcher is broken. */
const FABRICATED = 'verify-kan433-no-such-proof-exists';

let broken = 0;
function control(ok, what, detail) {
  console.log(`  ${ok ? 'control ok  ' : 'CONTROL FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) broken += 1;
}

// ---------------------------------------------------------------------------
// The world: what ci.yml runs.
// ---------------------------------------------------------------------------

const array = readVerifyArray(yaml);
if (!array.closed || array.opens !== 1) {
  console.error(
    `ABORT: ci.yml gave ${array.opens} \`scripts=(\` array(s), closed=${array.closed}. ` +
      'The array was not read whole, so every verdict below would be about a prefix. ' +
      'verify-proof-registry.mjs is the check that owns this failure.'
  );
  process.exit(2);
}
const inArray = new Set(array.entries.map((e) => e.name));

/** A live, top-level `node scripts/<name>.mjs` outside the array's own region. */
function hasOwnJob(name) {
  const needle = new RegExp(`node\\s+scripts/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mjs`);
  return findRunInvocations(yaml, needle)
    .filter((f) => !array.region || f.line < array.region.start || f.line > array.region.end)
    .some((f) => f.position === 'command' && f.disabled.length === 0);
}

const tracked = new Set(
  execFileSync('git', ['ls-files', 'scripts'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /^scripts\/verify-[^/]*\.mjs$/.test(f))
    .map((f) => path.basename(f, '.mjs'))
);

// ---------------------------------------------------------------------------
// The names: what docs/*.md say.
// ---------------------------------------------------------------------------

const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();

/** name -> Map<docBasename, occurrences> */
const named = new Map();
for (const f of docFiles) {
  const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  for (const m of text.matchAll(/verify-[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
    if (!named.has(m[0])) named.set(m[0], new Map());
    const per = named.get(m[0]);
    per.set(f, (per.get(f) ?? 0) + 1);
  }
}

console.log('=== 0. Controls on the instrument ===\n');
control(docFiles.length > 0, 'docs/*.md were found', `${docFiles.length} document(s) swept`);
control(named.size > 0, 'the name matcher matched something', `${named.size} distinct proof name(s)`);
control(!named.has(FABRICATED), `the matcher can say ABSENT — \`${FABRICATED}\` is not found`);
control(
  inArray.size > 0,
  'the CI array was read',
  `${inArray.size} entr${inArray.size === 1 ? 'y' : 'ies'}`
);
// The join's two answers, each demonstrated on a name whose classification is
// established elsewhere: the registry runs one and excludes the other.
control(
  inArray.has('verify-pty-consumer-named'),
  'the join can say RUN — `verify-pty-consumer-named` is in the array'
);
control(
  !inArray.has('verify-pty-payload-refusal'),
  'and can say NOT RUN — `verify-pty-payload-refusal` is not'
);
control(
  hasOwnJob('verify-proof-registry'),
  'the own-job reader can say RUN — `verify-proof-registry` runs from its own live step'
);
control(
  !hasOwnJob('verify-pty-payload-refusal'),
  'and can say NOT RUN — `verify-pty-payload-refusal` has no live step of its own'
);

if (broken) {
  console.error(
    `\nABORT: ${broken} control(s) failed. The instrument is broken, so nothing below is a ` +
      'measurement of the tree. Fix the instrument before reading any number here.'
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The join.
// ---------------------------------------------------------------------------

const rows = [...named.keys()].sort().map((name) => {
  let state;
  if (inArray.has(name)) state = 'RUN (array)';
  else if (!tracked.has(name)) state = 'FOREIGN';
  else if (hasOwnJob(name)) state = 'RUN (own job)';
  else state = 'NOT RUN';
  return { name, state, where: named.get(name) };
});

console.log('\n=== 1. Every proof named in docs/*.md, joined to what CI runs ===\n');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const where = [...r.where.entries()].map(([f, n]) => `${f}×${n}`).join(', ');
  console.log(`  ${r.name.padEnd(w)}  ${r.state.padEnd(13)}  ${where}`);
}

const notRun = rows.filter((r) => r.state === 'NOT RUN');
const foreign = rows.filter((r) => r.state === 'FOREIGN');

console.log('\n=== 2. The population ===\n');
console.log(`  documents swept                              ${docFiles.length}`);
console.log(`  distinct proof names in docs/*.md            ${rows.length}`);
console.log(`  entries in the ci.yml verify array           ${inArray.size}`);
console.log(`  tracked scripts/verify-*.mjs in the tree     ${tracked.size}`);
console.log(`  named in docs and RUN by CI                  ${rows.filter((r) => r.state.startsWith('RUN')).length}`);
console.log(`  named in docs and NOT RUN by CI              ${notRun.length}   <- this ticket's subject`);
console.log(`  named in docs, not a proof of this repo      ${foreign.length}`);

console.log('\n=== 3. The NOT RUN set, with the documents that name them ===\n');
for (const r of notRun) {
  console.log(`  ${r.name}`);
  for (const [f, n] of r.where) console.log(`      docs/${f}  ×${n}`);
}

if (foreign.length) {
  console.log('\n  FOREIGN (named in a document, not a tracked proof here — not a finding):');
  for (const r of foreign) console.log(`    ${r.name}  (${[...r.where.keys()].join(', ')})`);
}

console.log(
  '\nThis file asserts nothing and exits 0 by design. It is a survey, and its ' +
    'output is evidence rather than a verdict — see the header.'
);
