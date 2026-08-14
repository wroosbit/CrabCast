#!/usr/bin/env node
// KAN-386 RED DRIVE — does §4b of `verify-herdr-release.mjs` actually go red,
// and does it go red for the reason it claims?
//
// WHAT FAILURE THIS WOULD CATCH: a §4b that cannot fail. The section it drives
// was added to close a gap the gate had already written down about itself — "a
// release that stopped accepting the `p_NNN` form would PASS EVERY SECTION
// BELOW, green" — and an assertion written to close a silent gap is the exact
// place a silent assertion goes unnoticed, because everything around it is
// green and always was. This drive breaks each of §4b's three legs in turn and
// requires the named check, and only that check, to go FAIL.
//
// ⚠ IT READS THE LOG, NOT THE EXIT CODE, and that is not belt-and-braces. A
// non-zero exit out of a script that never reached §4b — a bad `--dist`, a
// mutant that would not parse, a private server that never came up — is a
// plausible-looking red that is evidence about nothing. Every arm therefore
// asserts that §4b RAN, that the failure count is exactly one, and that the one
// failing claim is the one the arm was designed to break. An arm that goes red
// by the wrong route is reported as a failure of this drive.
//
// FOUR ARMS, AND THE FIRST IS THE CONTROL:
//
//   control      the gate unmutated. All four §4b lines PASS and the run exits
//                0. A red drive whose baseline is not demonstrated is measuring
//                the machine as much as the assertion.
//   no-handle    `handlesInOurPanes` looks for an environment variable herdr
//                never sets, standing in for a release that stopped putting a
//                handle in the pane. Expected red: "a process inside the pane
//                under test carries a handle in its environment". This is the
//                leg that proves the INPUT ARRIVES — the proof does not supply
//                the handle, so it can be taken away.
//   unresolvable one digit appended to the handle before it is resolved,
//                standing in for a release that stopped accepting the `p_NNN`
//                form — THE failure this whole ticket exists for, and the
//                mutation KAN-385 measured (`pane_not_found`, 7/7). Expected
//                red: "`herdr pane get <handle>` resolves it to the pane
//                CrabCast named".
//   blind-control the control call is handed the REAL handle instead of a
//                mutated one, standing in for a `pane get` that resolves any
//                target to the only pane it has. Expected red: "CONTROL: a
//                mutated handle does NOT resolve". Without this arm the control
//                itself is an untested assertion, and a control that cannot
//                fail is decoration.
//
// EACH MUTATION IS AN EXACT-COUNT REPLACEMENT. `found 0` and `found 2` are both
// refusals: a mutation that hit nothing produces an UNMUTATED run that this
// script would then report as a successful red drive, which is the inverted
// failure `scripts/mutation.mjs` was written about. Mutants are written to a
// temp directory and run with an explicit absolute `--dist`, because the gate
// resolves `dist/` from its own path and a copy elsewhere would otherwise
// resolve it wrong — a control was lost to exactly that on 2026-08-13.
//
// Usage:
//   npm run build
//   node scripts/kan386-red-drive.mjs /tmp/herdr-0.6.10
//
// It spawns four real panes on four private herdr servers, one arm at a time,
// and touches no installed herdr and no live pane. Budget a few minutes.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const gatePath = path.join(scriptDir, 'verify-herdr-release.mjs');
const distDir = path.join(repoRoot, 'dist');

const herdrArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!herdrArg) {
  console.error('usage: node scripts/kan386-red-drive.mjs <herdr-binary>');
  console.error('  e.g. curl -fsSL -o /tmp/herdr-0.6.10 \\');
  console.error('         https://github.com/herdrdev/herdr/releases/download/v0.6.10/herdr-linux-x86_64');
  process.exit(2);
}
const herdrBin = path.resolve(herdrArg);
for (const [p, what] of [[herdrBin, 'the herdr binary'], [path.join(distDir, 'daemon.js'), 'dist/daemon.js — run `npm run build`']]) {
  if (!fs.existsSync(p)) {
    console.error(`${what} is missing: ${p}`);
    process.exit(2);
  }
}

let failures = 0;
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`);

// ---------------------------------------------------------------------------
// The four §4b claims, spelled exactly as `check()` prints them. Matching on
// the claim rather than on a line number, because a line number moves whenever
// anything above it is edited and a mismatch would then read as "the assertion
// stopped firing".
// ---------------------------------------------------------------------------

const CLAIMS = {
  handle: 'a process inside the pane under test carries a handle in its environment',
  agree: 'every process inside our panes agrees on ONE handle, and the census names one pane',
  resolves: '`herdr pane get <handle>` resolves it to the pane CrabCast named',
  control: 'CONTROL: a mutated handle does NOT resolve, so the pass above discriminates'
};

const SECTION_MARK = '4b. The pane-handle join';

const ARMS = [
  {
    name: 'control',
    expectRed: null
  },
  {
    name: 'no-handle',
    find: "    const entry = entries.find((e) => e.startsWith('HERDR_PANE_ID='));",
    replace: "    const entry = entries.find((e) => e.startsWith('HERDR_PANE_ID_NO_LONGER_SET='));",
    expectRed: 'handle',
    // What the failure detail should mention, so an arm that went red for some
    // other reason with the right claim is still caught.
    detailHas: 'none found',
    // A CASCADE, DECLARED RATHER THAN TOLERATED. With no handle there is
    // nothing to agree on and nothing to resolve, so neither of those two can
    // pass either — and that is the gate behaving correctly. The set is written
    // out so that a red appearing ANYWHERE ELSE is still caught; "one red"
    // would have been the wrong invariant and "some red" would be no invariant
    // at all. Both of these were found by this drive going red on a run where
    // the gate was right and the declaration was wrong.
    alsoRed: ['agree', 'resolves']
  },
  {
    name: 'unresolvable',
    find: '  const resolved = observed ? resolvePaneHandle(observed.handle) :',
    replace: "  const resolved = observed ? resolvePaneHandle(observed.handle + '1') :",
    expectRed: 'resolves',
    detailHas: 'pane_not_found',
    alsoRed: []
  },
  {
    name: 'blind-control',
    find: '  const control = resolvePaneHandle(mutated);',
    replace: '  const control = resolvePaneHandle(observed ? observed.handle : mutated);',
    expectRed: 'control',
    detailHas: 'resolved to',
    alsoRed: []
  }
];

const gateSource = fs.readFileSync(gatePath, 'utf8');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan386-red-'));
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

/**
 * The `check()` lines of one run, as {verdict, claim, detail}. The separator
 * between claim and detail is an em dash surrounded by spaces, which is also
 * what a detail may legitimately contain — so it is split ONCE, at the first
 * occurrence, which is the one `check()` wrote.
 */
function parseChecks(log) {
  const out = [];
  for (const line of log.split('\n')) {
    const m = /^ {2}(PASS|FAIL) {2}(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const sep = rest.indexOf(' — ');
    out.push({
      verdict: m[1],
      claim: sep === -1 ? rest : rest.slice(0, sep),
      detail: sep === -1 ? '' : rest.slice(sep + 3)
    });
  }
  return out;
}

function runArm(arm) {
  rule(`ARM: ${arm.name}${arm.expectRed ? `  — expected red: ${CLAIMS[arm.expectRed]}` : '  — expected GREEN (the baseline)'}`);

  let scriptPath = gatePath;
  if (arm.find) {
    const occurrences = gateSource.split(arm.find).length - 1;
    if (!check(occurrences === 1,
      `the mutation anchor appears EXACTLY once in verify-herdr-release.mjs`,
      `found ${occurrences} — ${JSON.stringify(arm.find.trim())}`)) {
      console.log('  ....  arm SKIPPED: an anchor that has drifted mutates nothing, and an unmutated');
      console.log('        run would be reported here as a successful red drive.');
      return;
    }
    scriptPath = path.join(workDir, `gate-${arm.name}.mjs`);
    fs.writeFileSync(scriptPath, gateSource.replace(arm.find, arm.replace));
    const parses = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
    if (!check(parses.status === 0, 'the mutant parses', parses.status === 0 ? '' : (parses.stderr ?? '').trim().split('\n')[0])) return;
  }

  const r = spawnSync(process.execPath, [scriptPath, herdrBin, '--expect', 'supported', '--dist', distDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000
  });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(path.join(workDir, `${arm.name}.log`), log);

  // ⚠ THE INSTRUMENT CHECK, BEFORE THE VERDICT. A run that never reached §4b
  // tells us nothing whatever, and its non-zero exit looks exactly like the red
  // we came for.
  if (!check(log.includes(SECTION_MARK), 'the run REACHED §4b', log.includes(SECTION_MARK) ? '' :
    `it did not — this exit is not evidence about the assertion. Last line: ${JSON.stringify((log.trim().split('\n').pop() ?? '').slice(0, 160))}`)) return;
  if (!check(!/ERR_MODULE_NOT_FOUND|^\s*at .*\(.*:\d+:\d+\)$/m.test(log),
    'and it did not die of a setup error wearing a failure’s clothes',
    'a stack trace or a module-resolution error is in the log')) return;

  // §4b of the child's own output, echoed verbatim. The arm's verdicts below
  // are this script's reading of it; this is the thing itself, so a reader can
  // see the red rather than take a claim that there was one.
  const body = log.split('\n');
  const from = body.findIndex((l) => l.includes(SECTION_MARK));
  const to = body.findIndex((l, i) => i > from && /^\s*\$ crabcast tail\b/.test(l));
  console.log(`\n  --- §4b as the ${arm.name} run printed it ---`);
  for (const l of body.slice(from, to === -1 ? from + 12 : to)) console.log(`  |${l}`);
  console.log('  --- end ---\n');

  const checks = parseChecks(log);
  const seen = new Map(checks.map((c) => [c.claim, c]));
  const missing = Object.entries(CLAIMS).filter(([, claim]) => !seen.has(claim)).map(([k]) => k);
  if (!check(missing.length === 0, 'all four §4b checks reported a verdict',
    missing.length ? `missing: ${missing.join(', ')}` : `${Object.keys(CLAIMS).length} present`)) return;

  const failed = checks.filter((c) => c.verdict === 'FAIL');

  if (arm.expectRed === null) {
    check(r.status === 0, 'the unmutated gate exits 0', `exit ${r.status}`);
    check(failed.length === 0, 'and nothing in it is red', failed.length ? failed.map((f) => f.claim).join(' | ') : '');
    for (const [key, claim] of Object.entries(CLAIMS)) {
      check(seen.get(claim).verdict === 'PASS', `§4b/${key} PASSES on a good release`, seen.get(claim).detail);
    }
    return;
  }

  const target = CLAIMS[arm.expectRed];
  check(r.status !== 0, 'the mutant exits NON-ZERO', `exit ${r.status}`);
  check(seen.get(target).verdict === 'FAIL',
    `and §4b/${arm.expectRed} is the check that went red`,
    seen.get(target).verdict === 'FAIL' ? seen.get(target).detail : 'it PASSED — the mutation did not reach the assertion it was aimed at');
  check(seen.get(target).detail.includes(arm.detailHas),
    'for the stated mechanism, not merely at the stated line',
    seen.get(target).detail.includes(arm.detailHas)
      ? `its detail names ${JSON.stringify(arm.detailHas)}`
      : `expected the detail to mention ${JSON.stringify(arm.detailHas)}; it said ${JSON.stringify(seen.get(target).detail)}`);
  // The red set, compared EXACTLY against what the arm declared. Not a count:
  // `no-handle` legitimately takes `resolves` down with it, and a count would
  // have to be loosened to "at least one", which no longer says the mutation
  // was localised at all.
  const expectedRed = new Set([target, ...arm.alsoRed.map((k) => CLAIMS[k])]);
  const actualRed = new Set(failed.map((f) => f.claim));
  const unexpected = [...actualRed].filter((c) => !expectedRed.has(c));
  const missed = [...expectedRed].filter((c) => !actualRed.has(c));
  check(unexpected.length === 0 && missed.length === 0,
    'and the reds are EXACTLY the ones this arm declared — the mutation is localised',
    unexpected.length || missed.length
      ? `${unexpected.length ? `unexpected: ${unexpected.join(' | ')}. ` : ''}` +
        `${missed.length ? `declared but green: ${missed.join(' | ')}.` : ''}`
      : [...expectedRed].join(' | '));
}

// ===========================================================================
rule('0. What is being driven');
// ===========================================================================

console.log(`  gate:    ${gatePath}`);
console.log(`  herdr:   ${herdrBin}`);
console.log(`  dist:    ${distDir}`);
console.log(`  mutants: ${workDir}`);
console.log(`\n  Four arms, each a full run of the gate against a private server. This is slow.`);

for (const arm of ARMS) runArm(arm);

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(78)}`);
console.log(
  failures
    ? `\n${failures} CHECK(S) FAILED. §4b has NOT been shown to be a gate: either an arm did not go\n` +
      `red, or it went red by a route other than the one it names.`
    : `\nALL ARMS BEHAVED. §4b passes on a good release and goes red — one check at a time,\n` +
      `for the named mechanism — when the handle is missing, when it stops resolving, and\n` +
      `when the resolver stops discriminating.`
);
process.exit(failures ? 1 : 0);
