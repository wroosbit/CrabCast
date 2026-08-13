#!/usr/bin/env node
// KAN-328 RED DRIVE — does `verify-read-contract.mjs` really go red when
// `activate_response`'s two SUCCESSFUL branches change without the contract?
//
// WHAT FAILURE THIS WOULD CATCH: a wire change to `activate_response`'s branch
// shapes landing green. KAN-328's AC3 asserts that no new mechanism is needed
// because §2d already asserts each branch's `always` set as an EQUALITY — and
// then says, in as many words, "check that it does rather than assuming it".
// This is that check. A branch-shape guard that has only ever passed is
// evidence of nothing, and the two mutations below are the exact wire changes
// KAN-328 was staffed to decide between, so what is watched going red is the
// change under consideration rather than a stand-in for it.
//
// THREE ARMS, AND THE FIRST IS THE CONTROL:
//
//   control            unmutated dist. The proof must be GREEN. A red-drive
//                      whose baseline is not demonstrated is measuring the
//                      runner as much as the guard.
//   add-to-idempotent  `priority` and `launcher` added to the `already-running`
//                      response and the contract left alone — the ADDITIVE
//                      resolution. Expected red: `already-running` carries keys
//                      on neither of its two lists.
//   drop-from-spawned  the same two removed from the `spawned` response — the
//                      SHRINK resolution. Expected red: `spawned` declares two
//                      keys `always` that the wire does not carry.
//
// EACH RED IS ASSERTED BY NAME, not by exit code. A non-zero exit says only
// that something went red, and this proof has six mutation sections of its own
// that are *supposed* to; crediting one of those for a branch-table failure
// would be exactly the misattribution the task brief records against #134. So
// each arm greps for the sentence §2d prints about the branch it mutated, and
// the run is red if that sentence is absent even when the exit code is 1.
//
// AND EACH ARM ASSERTS ITS MUTANT ACTUALLY REACHED THE WIRE. `mutation.mjs`
// guarantees the file was edited exactly once; it cannot know the edit changed
// any behaviour, and its own header says so. So the two mutating arms also read
// the `already-running` / `spawned` response the proof DUMPS and assert the
// field is present (or gone) there — a fact about the response the daemon
// actually sent, not about the file the mutator wrote.
//
// WHAT THIS DOES NOT COVER: whether the `sometimes` list is a real bound, and
// whether the DOCUMENT would have caught the same change — §1's document ↔
// declaration round trip is exercised by the proof's own §6b/§6e and is not
// re-driven here. Both mutations leave `src/read-contract.ts` and
// `docs/read-path-contract.md` untouched, which is the point: the question is
// what happens when the WIRE moves and the contract does not.
//
// NOT A PROOF AND NOT IN THE CI ARRAY, like `kan369-red-drive.mjs` and
// `kan349-red-drive.mjs`: it is a one-off demonstration whose output belongs in
// a pull request rather than in a gate. Recorded in `docs/moving-baselines.md`
// so the next sweep does not have to re-derive that. It mutates a COPY of
// `dist` under a scratch directory and never touches the working tree.
//
// Usage:
//   npm run build
//   node scripts/kan328-red-drive.mjs                       # all three arms
//   node scripts/kan328-red-drive.mjs --only add-to-idempotent
//   node scripts/kan328-red-drive.mjs --list
//
// Each arm costs one full run of the proof (~3 min), so `--only` exists for a
// reviewer re-running a single arm.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const PROOF = path.join(scriptDir, 'verify-read-contract.mjs');

let failures = 0;
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const pass = (label, detail) => console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail) => {
  failures++;
  console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
/**
 * `detail` is printed on a FAILURE only, and on a pass only when it is the
 * measurement rather than the expectation. A first draft printed it either way
 * and produced lines reading `ok … unexpectedly found "…"`, which says the
 * opposite of what happened — a pass wearing a failure's words is the one
 * output a reader cannot correct for.
 */
const check = (ok, label, detail) => (ok ? pass(label) : fail(label, detail));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan328-red-'));

/**
 * A mutant under `/tmp` cannot resolve `node-pty`, and the way it fails is the
 * reason this line has a comment. The daemon dies at import time, the proof's
 * §2 throws `daemon main never opened its socket`, the run exits 1 — and an arm
 * asserting only on the exit code would have recorded a red that the mutation
 * had nothing to do with. `verify-read-contract.mjs:957` does exactly this for
 * its own mutants; the symlink lets Node's resolver walk up out of
 * `scratch/mutant-*` and find the repo's real tree.
 */
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const { mutate } = makeMutator({ distDir, scratch, report: { pass, fail } });

/**
 * The `already-running` response's tail, in the compiled build. The insert goes
 * after `verified` so the two fields land in the same place on the wire that
 * they occupy on the spawning branch — before the config echo.
 */
const IDEMPOTENT_ANCHOR =
  '                createdAt: session.createdAt.toISOString(),\n' +
  '                verified: true,\n';

/** The two fields as the spawning branch already emits them. */
const SPAWNED_PAIR =
  '            priority: config.priority,\n' +
  '            launcher: config.launcher,\n';

const ARMS = {
  control: {
    what: 'unmutated dist — the proof must be green',
    mutant: () => distDir,
    expectExit: 0,
    expectGreen: true,
    /** No sentence is required; the absence of every branch problem is the claim. */
    mustSay: [],
    mustNotSay: [
      'already-running: on the wire and on neither list for this branch',
      'spawned: declared always and absent from the wire'
    ],
    reached: () => ({ ok: true, detail: 'no mutation to reach the wire' })
  },

  'add-to-idempotent': {
    what: '`priority` + `launcher` added to `already-running`, contract untouched',
    mutant: () =>
      mutate('add-to-idempotent', 'router.js', IDEMPOTENT_ANCHOR,
        IDEMPOTENT_ANCHOR +
        '                priority: config.priority,\n' +
        '                launcher: config.launcher,\n'),
    expectExit: 1,
    expectGreen: false,
    mustSay: [
      'already-running: on the wire and on neither list for this branch — priority launcher'
    ],
    mustNotSay: [],
    /**
     * THE MUTANT REALLY RAN. Read off the `already-running` response the proof
     * dumps, not off the file the mutator wrote.
     */
    reached: (out) => {
      const res = branchResponse(out, 'already-running');
      if (!res) return { ok: false, detail: 'the proof printed no readable `already-running` response' };
      const has = (k) => Object.prototype.hasOwnProperty.call(res, k);
      return {
        ok: has('priority') && has('launcher'),
        detail:
          `already-running TOP-LEVEL priority=${has('priority')} launcher=${has('launcher')}; ` +
          `config echo carries them either way (config.priority=${res.config?.priority}, ` +
          `config.launcher=${JSON.stringify(res.config?.launcher)})`
      };
    }
  },

  'drop-from-spawned': {
    what: '`priority` + `launcher` removed from `spawned`, contract untouched',
    mutant: () => mutate('drop-from-spawned', 'router.js', SPAWNED_PAIR, ''),
    expectExit: 1,
    expectGreen: false,
    mustSay: ['spawned: declared always and absent from the wire — priority launcher'],
    mustNotSay: [],
    reached: (out) => {
      const res = branchResponse(out, 'spawned');
      if (!res) return { ok: false, detail: 'the proof printed no readable `spawned` response' };
      const has = (k) => Object.prototype.hasOwnProperty.call(res, k);
      return {
        ok: !has('priority') && !has('launcher'),
        detail:
          `spawned TOP-LEVEL priority=${has('priority')} launcher=${has('launcher')}; ` +
          `config echo is UNTOUCHED by this mutation (config.priority=${res.config?.priority}, ` +
          `config.launcher=${JSON.stringify(res.config?.launcher)}) — which is the finding, ` +
          `not a leak: removing the top-level pair removes no information from the response`
      };
    }
  }
};

/**
 * The response the proof DUMPS for one branch, parsed back into an object.
 *
 * PARSED RATHER THAN GREPPED, and the first draft of this function is why. It
 * matched `/^\s+"priority":/` against the dump as text and reported that
 * `drop-from-spawned` had not reached the wire — on a build where it demonstrably
 * had. What it was matching was `config.priority` INSIDE THE CONFIG ECHO, four
 * lines further down at a deeper indent. That is the very redundancy this ticket
 * is about, and it is worth recording that it defeated a text assertion written
 * by somebody who had just spent an hour reading about it: at the top level the
 * field is a duplicate of one the echo carries on both branches, so no assertion
 * that cannot tell nesting apart can tell the two branches apart either.
 *
 * `show()` prints the label, then the JSON indented by five spaces, so the block
 * runs to the first line that is exactly five spaces and a closing brace.
 */
function branchResponse(out, branch) {
  const header = `activate_response · ${branch}:`;
  const start = out.indexOf(header);
  if (start === -1) return null;
  const lines = out.slice(start + header.length).split('\n').slice(1);
  const body = [];
  for (const line of lines) {
    body.push(line);
    if (line === '     }') break;
  }
  try {
    return JSON.parse(body.join('\n'));
  } catch {
    return null;
  }
}

/** Does the proof's own PASS BANNER appear — the whole line, not a mention of it. */
const printedPassBanner = (out) => /^ALL CHECKS PASSED$/m.test(out);

function runProof(dir) {
  const r = spawnSync(process.execPath, [PROOF, dir], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60 * 1000
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const [name, arm] of Object.entries(ARMS)) console.log(`${name.padEnd(20)} ${arm.what}`);
  process.exit(0);
}
const only = argv.indexOf('--only') === -1 ? null : argv[argv.indexOf('--only') + 1];
const selected = Object.entries(ARMS).filter(([n]) => !only || n === only);
if (!selected.length) {
  console.log(`no arm named '${only}'. --list shows them.`);
  process.exit(2);
}

console.log(`repo   : ${repoRoot}`);
console.log(`dist   : ${distDir}`);
console.log(`scratch: ${scratch}`);

for (const [name, arm] of selected) {
  rule(`ARM ${name} — ${arm.what}`);
  const dir = arm.mutant();
  if (!dir) {
    // `mutate` has already counted the failure through `report.fail`.
    console.log('   mutation did not apply; arm skipped (already counted)');
    continue;
  }
  console.log(`   build under test: ${dir}`);
  const { code, out } = runProof(dir);
  // ANCHORED TO THE WHOLE LINE. A substring test reads `true` on every red run
  // of this proof, because its own §6f narration contains the sentence "printed
  // ALL CHECKS PASSED before the boundary was data on both sides". The first
  // draft of this drive used `includes` and reported the proof's counters
  // broken — the counters were fine and the DETECTOR was the miscalibrated one.
  const green = printedPassBanner(out);
  console.log(`   proof exit code : ${code}`);
  console.log(`   printed ALL CHECKS PASSED: ${green}`);

  check(code === arm.expectExit, `${name}: exit ${arm.expectExit}`, `got ${code}`);
  check(green === arm.expectGreen, `${name}: ALL CHECKS PASSED === ${arm.expectGreen}`,
    `got ${green} — this is the counter-calibration check: a run that reports failures must not also print the pass banner`);

  for (const sentence of arm.mustSay) {
    check(out.includes(sentence), `${name}: red BY NAME`, `expected to find "${sentence}"`);
  }
  for (const sentence of arm.mustNotSay) {
    check(!out.includes(sentence), `${name}: no branch problem`, `unexpectedly found "${sentence}"`);
  }

  const reached = arm.reached(out);
  // Printed either way: this one is a MEASUREMENT off the response the daemon
  // sent, and it is worth reading on a pass as well as on a failure.
  console.log(`   reached the wire: ${reached.detail}`);
  check(reached.ok, `${name}: the mutation reached the wire`, reached.detail);

  const logPath = path.join(scratch, `${name}.log`);
  fs.writeFileSync(logPath, out);
  console.log(`   full output: ${logPath}`);
}

rule('VERDICT');
console.log(`   arms run : ${selected.length}`);
console.log(`   failures : ${failures}`);
console.log(failures
  ? '\n   RED — an arm did not behave as the drive claims. Read the arm above.'
  : '\n   GREEN — every arm behaved as claimed: the control passes, and both wire\n' +
    '   changes are caught BY NAME by the branch table with the contract untouched.');
process.exit(failures ? 1 : 0);
