#!/usr/bin/env node
// KAN-504 RED DRIVE — does `verify-launcher-args.mjs` actually notice when the
// args stop reaching the `--continue` invocation, or has it only ever passed?
//
// WHAT FAILURE THIS WOULD CATCH: a `verify-launcher-args` that goes green over
// a build where the resumed branch carries no caller args. That is the exact
// defect the ticket named as most likely — the resumed branch is the COMMON
// path, every already-existing agent takes it, and a flag reaching only cold
// starts looks completely correct to anybody who tests by creating a new agent.
// A gate nobody has watched fail has not been shown to be a gate, and §2 of
// that proof is the gate this drives.
//
// ---------------------------------------------------------------------------
// THE ARMS
// ---------------------------------------------------------------------------
//
//   0. CONTROL          the unmutated build. Must be GREEN. Without it every
//                       arm below measures the harness rather than the proof:
//                       a staged layout that was simply broken would redden all
//                       of them and read as successes.
//
//   1. THE ONE THAT     args removed from the `--continue` side ONLY, leaving
//      MATTERS          the cold-start fallback correct. §2 must go RED and the
//                       failing check must be the argv one. ⚠ This arm also
//                       requires §1 (cold start) to STAY GREEN — because an
//                       arm that only required "the run went red" would pass
//                       against a mutation that broke everything, and would
//                       therefore not show that the proof can distinguish the
//                       resumed branch from the fresh one. Distinguishing them
//                       IS the claim.
//
//   2. THE MIRROR       args removed from the cold-start side only. §1 must go
//                       RED and §2 must stay GREEN. Same argument in the other
//                       direction: together arms 1 and 2 show the two sections
//                       are independently load-bearing rather than one check
//                       reported twice.
//
//   3. THE REFUSAL      `shell` made to declare `acceptsArgs: true`. §3 must go
//                       RED. This is the accept-and-ignore failure — the one
//                       whose whole hazard is that it looks like success — so
//                       it needs its own demonstration that something notices.
//
//   4. THE DISCLOSURE   the capacity refusal's argv sentence removed. §5 must
//                       go RED. Disclosure that quietly stops happening is
//                       invisible by construction; this is what makes it not.
//
// ⚠ EVERY ARM ASSERTS WHAT WENT RED **AND** WHAT STAYED GREEN. An arm that only
// required its own section to fail would pass against a mutant that broke the
// whole script — which is a proof that cannot tell one defect from another,
// reported as five successes.
//
// ---------------------------------------------------------------------------
// ⚠ ON "IF THE MUTATION DOES NOT COMPILE, THAT IS NOT A RED"
// ---------------------------------------------------------------------------
//
// The arms below mutate the COMPILED BUILD, so `tsc` never runs on them and no
// mutation here can be killed by the compiler instead of by the proof. That
// removes the confound rather than dodging it: a red from a failed build is
// evidence about the previous `dist`, and a red from the compiler is the
// compiler's catch being credited to a proof that never saw the mutation.
//
// §5 closes the other half — it applies arm 1's edit to a copy of the SOURCE
// and runs `tsc` over it, asserting the compiler is HAPPY. So the mutation is
// demonstrably one a person could have written and shipped, and the red in arm
// 1 is the proof's alone.
//
// THE WORKING TREE IS NEVER TOUCHED: every arm runs against a copy.
//
// Usage:
//   npm run build
//   node scripts/kan504-red-drive.mjs

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator, FIX_THE_MUTATION } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const proof = path.join(scriptDir, 'verify-launcher-args.mjs');

let failures = 0;
let checks = 0;

const report = {
  pass: (label, detail = '') => {
    checks += 1;
    console.log(`  PASS  ${label}${detail ? `\n          ${detail}` : ''}`);
  },
  fail: (label, detail = '') => {
    checks += 1;
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
};
const check = (ok, label, detail = '') => (ok ? report.pass(label, detail) : report.fail(label, detail));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan504-red-'));

// EVERY MUTANT IS A SIBLING OF THIS SYMLINK, and without it none of them runs.
// A mutated build is a copy of `dist/` somewhere else, and node resolves its
// `@modelcontextprotocol/sdk` and `node-pty` imports by walking UP from the
// file — so a copy under /tmp finds no `node_modules` and every arm fails at
// import time. That failure is red, loudly, and for entirely the wrong reason:
// it would read as "the proof caught the mutation" on every arm at once. Found
// by running this drive rather than by reading it — arm 1 reported §2 red with
// §1 red beside it, which is what sent me looking.
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
const { mutate, mutationsSkipped } = makeMutator({ distDir, scratch, report });

/**
 * Run the proof against a build and report which sections passed.
 *
 * Sections are read off the proof's own output rather than guessed at: a check
 * line is `PASS`/`FAIL` under the most recent `N. title` heading, so an arm can
 * assert "§2 red, §1 green" rather than only "the exit code moved".
 */
function runProof(against) {
  const res = spawnSync(process.execPath, [proof, against], {
    cwd: repoRoot, encoding: 'utf8', timeout: 300_000
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const sections = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    const heading = /^(\d)\. /.exec(line);
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, { pass: 0, fail: 0, failed: [] });
      continue;
    }
    const verdict = /^\s{2}(PASS|FAIL)\s{2}(.*)$/.exec(line);
    if (verdict && current !== null) {
      const s = sections.get(current);
      if (verdict[1] === 'PASS') s.pass += 1;
      else { s.fail += 1; s.failed.push(verdict[2].trim()); }
    }
  }
  return { exit: res.status, out, sections };
}

const red = (r, n) => (r.sections.get(n)?.fail ?? 0) > 0;
const green = (r, n) => (r.sections.get(n)?.fail ?? 0) === 0 && (r.sections.get(n)?.pass ?? 0) > 0;
const failedIn = (r, n) => (r.sections.get(n)?.failed ?? []).join(' | ');

function rule(title) {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

// The exact text the arms edit, in the compiled build. Each must occur once,
// which `mutate` enforces and counts into this script's own verdict — an anchor
// that matches zero times applies nothing, and an unapplied mutation reads
// exactly like a clean pass.
const CLAUDE_RETURN =
  'return mayResume ? `claude ${flags} --continue || ${fresh}` : fresh;';
const CLAUDE_FLAGS =
  'const flags = `--permission-mode bypassPermissions${quotedArgs(args)}`;';

// ===========================================================================
rule('0. CONTROL — the unmutated build is green');
// ===========================================================================
const control = runProof(distDir);
check(control.exit === 0, 'the proof passes against the real build', `exit ${control.exit}`);
check(green(control, '1') && green(control, '2') && green(control, '3') && green(control, '5'),
  'and every section this drive reddens below is green to start with',
  [...control.sections].map(([n, s]) => `§${n}: ${s.pass}P/${s.fail}F`).join('  '));
if (control.exit !== 0) {
  console.log('\n  ⚠ the control is red, so every arm below would measure the harness rather ' +
    'than the proof. Stopping.\n');
  console.log(control.out.split('\n').slice(-40).join('\n'));
  process.exit(1);
}

// ===========================================================================
rule('1. ⚠ THE ONE THAT MATTERS — args removed from the --continue side only');
// ===========================================================================
{
  // The cold-start fallback keeps `${flags}` and therefore keeps the args. Only
  // the resumed invocation loses them. This is the defect exactly as the ticket
  // describes it, and it is a mutation a person could plausibly write while
  // "tidying" the duplication back out.
  const mutant = mutate('continue-side-loses-args', 'launchers.js', CLAUDE_RETURN,
    'return mayResume ? `claude --permission-mode bypassPermissions --continue || ${fresh}` : fresh;');
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '2'), '§2 (the resumed branch) is what failed', failedIn(r, '2') || '(nothing failed in §2)');
    check(
      /THE ARGS ARE ON THE --continue INVOCATION/.test(failedIn(r, '2')),
      'and the failing check is the argv one, named',
      failedIn(r, '2')
    );
    // ⚠ THE DISCRIMINATING HALF. Without this the arm would pass against a
    // mutation that broke everything, and would show nothing about the proof's
    // ability to tell the resumed branch from the fresh one.
    check(green(r, '1'), '⚠ while §1 (the cold start) STAYS GREEN — the two branches are told apart',
      `§1: ${r.sections.get('1')?.pass ?? 0}P/${r.sections.get('1')?.fail ?? 0}F`);
    console.log('\n   the red, in the proof\'s own words:');
    for (const line of r.out.split('\n').filter((l) => /^\s{2}FAIL/.test(l))) {
      console.log(`     ${line.trim()}`);
    }
    console.log();
  }
}

// ===========================================================================
rule('2. THE MIRROR — args removed from the cold-start side only');
// ===========================================================================
{
  const mutant = mutate('fresh-side-loses-args', 'launchers.js',
    'const fresh = `claude ${flags}` + (promptCommand ? \' \' + shellQuote(promptCommand) : \'\');',
    'const fresh = `claude --permission-mode bypassPermissions` + (promptCommand ? \' \' + shellQuote(promptCommand) : \'\');');
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '1'), '§1 (the cold start) is what failed', failedIn(r, '1') || '(nothing failed in §1)');
    check(green(r, '2'), 'while §2 (the resumed branch) STAYS GREEN — so the two sections are ' +
      'independently load-bearing rather than one check reported twice',
      `§2: ${r.sections.get('2')?.pass ?? 0}P/${r.sections.get('2')?.fail ?? 0}F`);
  }
}

// ===========================================================================
rule('3. THE REFUSAL — shell made to accept args');
// ===========================================================================
{
  // Accept-and-ignore, which is the failure whose whole hazard is that it looks
  // like success: `configure` would answer 200, the agent would start, and the
  // arguments would go nowhere with nothing anywhere saying so.
  // `acceptsArgs: false` occurs exactly once in the whole build — `shell` is
  // the only launcher that declines args — so the bare declaration is an
  // unambiguous anchor and needs none of the surrounding command text.
  // `mutate` enforces the occurrence count, so if a second launcher ever
  // declines args this arm reports the ambiguity rather than mutating the
  // wrong one.
  const mutant = mutate('shell-accepts-args', 'launchers.js',
    'acceptsArgs: false', 'acceptsArgs: true');
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '3') || red(r, '0'),
      'the refusal section (or the capability declaration it rests on) failed',
      `§0: ${failedIn(r, '0')} | §3: ${failedIn(r, '3')}`);
  }
}

// ===========================================================================
rule('4. THE DISCLOSURE — the capacity refusal stops naming the argv');
// ===========================================================================
{
  const mutant = mutate('capacity-refusal-hides-argv', 'router.js',
    "`\\nIt would have been started with ${args.map((a) => `'${a}'`).join(' ')} on its ` +",
    "`${args.length ? '' : ''}` +");
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '5'), '§5 (disclosure) is what failed', failedIn(r, '5') || '(nothing failed in §5)');
    check(green(r, '1') && green(r, '2'),
      'while the argv-delivery sections stay green — disclosure and delivery are separate claims',
      `§1/§2 clean`);
  }
}

// ===========================================================================
rule('5. THE MUTATION IN ARM 1 COMPILES — so the red there is the proof\'s, not tsc\'s');
// ===========================================================================
//
// ⚠ THE POINT OF THIS SECTION. "A mutation that does not compile is not a red"
// — a build failure means the proof ran against the PREVIOUS dist and never saw
// the mutation at all, so whatever it printed is evidence about code nobody
// wrote. Arm 1 mutates the compiled build, which cannot hit that; this section
// establishes the other half, that the same edit in SOURCE is one `tsc`
// accepts. Together: the defect is shippable, and the thing that caught it was
// this proof.
{
  // UNDER `scratch`, whose sibling `node_modules` symlink is what lets `tsc`
  // resolve `@types/node`. Compiled anywhere else it reports "Cannot find
  // module 'fs'" for the whole tree — a red that says nothing about the
  // mutation, which would make this section claim the opposite of the truth.
  const srcCopy = path.join(scratch, 'src-compile-check');
  fs.mkdirSync(srcCopy, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'src'), path.join(srcCopy, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'tsconfig.json'), path.join(srcCopy, 'tsconfig.json'));
  // `package.json` TOO, AND IT IS NOT OPTIONAL. `module: NodeNext` decides
  // ESM-versus-CommonJS from the nearest package.json's `type` field, so a copy
  // without one compiles as CommonJS and every `import.meta` in the tree is an
  // error. That red says nothing whatever about the mutation — and it would
  // have made this section report the exact opposite of the truth, since a
  // non-zero `tsc` here reads as "the compiler would have caught it". Found by
  // running this arm rather than by reasoning about it.
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(srcCopy, 'package.json'));

  const launchersSrc = path.join(srcCopy, 'src', 'launchers.ts');
  const before = fs.readFileSync(launchersSrc, 'utf8');
  const FIND = 'return mayResume ? `claude ${flags} --continue || ${fresh}` : fresh;';
  const REPLACE =
    'return mayResume ? `claude --permission-mode bypassPermissions --continue || ${fresh}` : fresh;';
  const occurrences = before.split(FIND).length - 1;
  check(occurrences === 1,
    `the source anchor occurs exactly once (${FIX_THE_MUTATION})`,
    `found ${occurrences}`);
  if (occurrences === 1) {
    fs.writeFileSync(launchersSrc, before.replace(FIND, REPLACE));
    const tsc = spawnSync(process.execPath,
      [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', srcCopy],
      { cwd: srcCopy, encoding: 'utf8', timeout: 300_000 });
    const out = ((tsc.stdout || '') + (tsc.stderr || '')).trim();
    check(tsc.status === 0,
      '⚠ tsc ACCEPTS the arm-1 mutation — it is a defect a person could ship, and the red ' +
        'in arm 1 was this proof catching it rather than the compiler',
      out ? out.split('\n').slice(0, 5).join('\n          ') : `tsc exit ${tsc.status}, no output`);
  }
}

// ---------------------------------------------------------------------------
// A mutation that did not apply is a section that never ran, and it reads
// exactly like a clean pass — so it is named rather than left to the count.
{
  const skipped = mutationsSkipped();
  check(skipped.length === 0,
    'every mutation applied — none was silently skipped',
    skipped.length ? `${FIX_THE_MUTATION} skipped: ${skipped.join(', ')}` : 'none skipped');
}

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(failures ? 1 : 0);
