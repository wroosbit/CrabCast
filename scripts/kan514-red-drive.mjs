#!/usr/bin/env node
// KAN-514 RED DRIVE — does `verify-variadic-args-swallow-prompt.mjs` actually
// notice, or has it only ever passed?
//
// WHAT FAILURE THIS WOULD CATCH: a proof that goes green while the `args`
// documentation has lost the warning it exists to hold in place, or while the
// argv layout that makes the warning true has moved underneath it. Both are
// silent by construction — a page and a command line do not complain about each
// other — and a gate nobody has watched fail has not been shown to be a gate.
//
// ---------------------------------------------------------------------------
// THE ARMS
// ---------------------------------------------------------------------------
//
//   0. CONTROL          the unmutated build and the real pages. Must be GREEN.
//                       Without it every arm below measures the harness rather
//                       than the proof: a staged layout that was simply broken
//                       would redden all of them and read as successes.
//
//   1. THE CLI          the warning removed from `--args-json`'s help. §4 must
//                       go RED naming the CLI, and §0-§3 must STAY GREEN.
//
//   2. THE MCP SCHEMA   the warning removed from `crabcast_configure_agent`'s
//                       `args` description — the surface Butchr's agents
//                       actually read, and the one KAN-504 was announced
//                       through. §4 red, the rest green.
//
//   3. THE README       the warning paragraph deleted from the page. §4 red on
//                       that row only.
//
//   4. THE PAGE         `docs/launcher-args.md` removed entirely — the
//                       reasoning KAN-514 asked to have written down where the
//                       next person will ask. §4 red, including its
//                       precondition, which is what stops an unreadable page
//                       being reported as a page that fails its claims.
//
//   5. ⚠ THE OTHER      the layout changed so the swallow CANNOT happen: the
//      DIRECTION        prompt given a flag of its own, so it stops being a
//                       bare operand. §0 and §1 must go RED **while §4 stays
//                       GREEN** — the pages still carry the warning and are
//                       now describing a hazard that no longer exists. This is
//                       the arm that makes the proof a claim with a checker
//                       rather than a phrase check: it fails in the direction
//                       where the DOCUMENTATION is the thing that has gone
//                       stale.
//
//   6. THE COMPILER     arm 5's edit applied to a copy of `src/` with `tsc`
//                       run over it, which must ACCEPT it. Without this, the
//                       red in arm 5 could be the compiler's catch credited to
//                       this proof.
//
// ⚠ EVERY ARM ASSERTS WHAT WENT RED **AND** WHAT STAYED GREEN. An arm that only
// required its own section to fail would pass against a mutant that broke the
// whole script — a proof that cannot tell one defect from another, reported as
// six successes.
//
// ---------------------------------------------------------------------------
// ⚠ ON "IF THE MUTATION DOES NOT COMPILE, THAT IS NOT A RED"
// ---------------------------------------------------------------------------
//
// Arms 1, 2 and 5 mutate the COMPILED BUILD, so `tsc` never runs on them and
// no mutation here can be killed by the compiler instead of by the proof. Arm
// 6 closes the other half for arm 5, which is the only arm whose edit is code
// rather than prose.
//
// THE WORKING TREE IS NEVER TOUCHED: every arm runs against a copy.
//
// Usage:
//   npm run build
//   node scripts/kan514-red-drive.mjs

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator, FIX_THE_MUTATION } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const proof = path.join(scriptDir, 'verify-variadic-args-swallow-prompt.mjs');

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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan514-red-'));

// EVERY MUTANT IS A SIBLING OF THIS SYMLINK, and without it none of them runs.
// A mutated build is a copy of `dist/` somewhere else, and node resolves its
// `@modelcontextprotocol/sdk` and `node-pty` imports by walking UP from the
// file — so a copy under /tmp finds no `node_modules`, every arm dies at import
// time, and that failure reads as "the proof caught the mutation" on every arm
// at once. Learned on `kan504-red-drive.mjs` by running it, not by reading it.
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
const { mutate, mutationsSkipped } = makeMutator({ distDir, scratch, report });

/**
 * Run the proof against a build and a pages directory, and report which
 * sections passed.
 *
 * Sections are read off the proof's own output rather than guessed at: a check
 * line is `PASS`/`FAIL` under the most recent `N. title` heading, so an arm can
 * assert "§4 red, §1 green" rather than only "the exit code moved".
 */
function runProof(againstDist, againstPages = repoRoot) {
  const res = spawnSync(process.execPath, [proof, againstDist, againstPages], {
    cwd: repoRoot, encoding: 'utf8', timeout: 600_000
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
const tally = (r) => [...r.sections].map(([n, s]) => `§${n}: ${s.pass}P/${s.fail}F`).join('  ');

function rule(title) {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

function showReds(r) {
  console.log("\n   the red, in the proof's own words:");
  for (const line of r.out.split('\n').filter((l) => /^\s{2}FAIL/.test(l))) {
    console.log(`     ${line.trim()}`);
  }
  console.log();
}

/**
 * A copy of the repository's PAGES with edits applied — the half of §4 that is
 * not in the build and that `mutate` therefore cannot reach.
 *
 * Same discipline as the helper: each anchor must occur exactly once, and an
 * anchor that does not is a counted FAILURE rather than a silently unmutated
 * copy, because a section that never ran reads exactly like a clean pass.
 *
 * `edits` of `null` for a file means REMOVE the file; otherwise
 * `{ deleteLineStartingWith }` names the paragraph to delete.
 */
function mutatePages(name, edits) {
  const target = path.join(scratch, `pages-${name}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(target, 'README.md'));
  fs.copyFileSync(
    path.join(repoRoot, 'docs', 'launcher-args.md'),
    path.join(target, 'docs', 'launcher-args.md')
  );

  for (const [rel, edit] of Object.entries(edits)) {
    const file = path.join(target, rel);
    if (edit === null) {
      fs.rmSync(file, { force: true });
      report.pass(`pages mutation "${name}" removed ${rel}`);
      continue;
    }
    const before = fs.readFileSync(file, 'utf8');

    // A WHOLE PARAGRAPH RATHER THAN A PHRASE, and the reason is the one this
    // whole drive turns on: a markdown paragraph is one line, and replacing a
    // few words of it leaves every claim §4 asserts standing in the rest of
    // the sentence. Deleting the line is the edit a person tidying a page
    // actually makes.
    const lines = before.split('\n');
    const hits = lines.filter((l) => l.startsWith(edit.deleteLineStartingWith));
    if (hits.length !== 1) {
      report.fail(
        `pages mutation "${name}" DID NOT APPLY — the section that needed it did not run`,
        `expected exactly 1 line of ${rel} starting ` +
          `${JSON.stringify(edit.deleteLineStartingWith.slice(0, 60))}, found ${hits.length}. ` +
          FIX_THE_MUTATION
      );
      return null;
    }
    fs.writeFileSync(file, lines.filter((l) => !l.startsWith(edit.deleteLineStartingWith)).join('\n'));
    report.pass(`pages mutation "${name}" deleted a paragraph from a copy of ${rel}`,
      `${hits[0].length} chars removed`);
  }
  return target;
}

// The exact text the arms edit, in the compiled build. Each must occur once,
// which `mutate` enforces and counts into this script's own verdict — an anchor
// matching zero times applies nothing, and an unapplied mutation reads exactly
// like a clean pass.
//
// EACH ONE IS THE SUBSTANCE RATHER THAN A HEADLINE, AND THAT WAS MEASURED
// RATHER THAN REASONED. An earlier draft of arm 1 replaced only the words
// `WRITE A VALUE WITH \`=\`, AS ONE ELEMENT` in `dist/cli.js`; run against that
// mutant the proof came back 67/67, exit 0. Correctly — everything §4 asserts
// was still standing in the sentences underneath the headline. A mutation has
// to remove what the claims are ABOUT, not the phrase that introduces them,
// and an arm built on the headline would have reported a gate that was not
// being exercised.
const CLI_HELP_WARNING =
  'The prompt is the LAST argument and it is a bare operand, so a VARIADIC flag written the ' +
  'two-element way keeps reading and SWALLOWS THE PROMPT — and the error you get back blames ' +
  'the prompt';
const MCP_WARNING =
  'so a VARIADIC consumer flag written the two-element way does not stop at its own value: it ' +
  'keeps reading and SWALLOWS THE PROMPT. That wedges EVERY spawn for the agent, including the ' +
  '`--continue` one every already-existing agent takes, and the failure does not mention ' +
  'arguments — the runtime complains that your PROMPT TEXT is a malformed value for the flag, ' +
  'so the obvious fix is to edit the prompt, which cannot help.';
const CLAUDE_FRESH =
  "const fresh = `claude ${flags}` + (promptCommand ? ' ' + shellQuote(promptCommand) : '');";

// ===========================================================================
rule('0. CONTROL — the unmutated build and the real pages are green');
// ===========================================================================
const control = runProof(distDir);
check(control.exit === 0, 'the proof passes against the real build and the real pages',
  `exit ${control.exit}`);
check(
  green(control, '0') && green(control, '1') && green(control, '2') &&
    green(control, '3') && green(control, '4'),
  'and every section this drive reddens below is green to start with',
  tally(control)
);
if (control.exit !== 0) {
  console.log('\n  ⚠ the control is red, so every arm below would measure the harness rather ' +
    'than the proof. Stopping.\n');
  console.log(control.out.split('\n').slice(-40).join('\n'));
  process.exit(1);
}

// ===========================================================================
rule("1. THE CLI — the warning removed from --args-json's help");
// ===========================================================================
{
  const mutant = mutate('cli-help-loses-the-warning', 'cli.js', CLI_HELP_WARNING,
    'Arguments are passed through');
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '4'), '§4 (the surfaces) is what failed', failedIn(r, '4') || '(nothing failed in §4)');
    check(
      /crabcast configure --help/.test(failedIn(r, '4')),
      'and the failing checks NAME the CLI as the surface that lost it',
      failedIn(r, '4')
    );
    // ⚠ THE DISCRIMINATING HALF: the world is unchanged, so the sections that
    // measure the world must be untouched. An arm requiring only "something
    // went red" would pass against a mutant that broke the whole script.
    check(green(r, '1') && green(r, '2') && green(r, '3'),
      '⚠ while §1-§3 (the live behaviour) STAY GREEN — the layout did not move, only the page did',
      tally(r));
    showReds(r);
  }
}

// ===========================================================================
rule("2. THE MCP SCHEMA — the warning removed from configure_agent's `args`");
// ===========================================================================
//
// The surface Butchr's own agents read, and the one KAN-504 was announced
// through. Its loss is the exact shape of the original defect.
{
  const mutant = mutate('mcp-description-loses-the-warning', 'mcp.js', MCP_WARNING,
    'they are passed through unchanged.');
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '4'), '§4 is what failed', failedIn(r, '4') || '(nothing failed in §4)');
    check(
      /over MCP/.test(failedIn(r, '4')),
      'and the failing checks NAME the MCP description',
      failedIn(r, '4')
    );
    check(green(r, '1') && green(r, '2') && green(r, '3'),
      '⚠ while §1-§3 STAY GREEN', tally(r));
  }
}

// ===========================================================================
rule('3. THE README — the warning paragraph deleted');
// ===========================================================================
{
  const pages = mutatePages('readme-loses-the-warning', {
    'README.md': {
      deleteLineStartingWith: '⚠ **Write an argument that carries a value as one element joined with `=`**'
    }
  });
  if (pages) {
    const r = runProof(distDir, pages);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '4'), '§4 is what failed', failedIn(r, '4') || '(nothing failed in §4)');
    check(
      /README\.md/.test(failedIn(r, '4')),
      'and the failing checks NAME the README',
      failedIn(r, '4')
    );
    check(green(r, '1') && green(r, '2') && green(r, '3'),
      '⚠ while §1-§3 STAY GREEN', tally(r));
  }
}

// ===========================================================================
rule('4. THE PAGE — docs/launcher-args.md removed entirely');
// ===========================================================================
//
// KAN-514's AC3: the reasoning must be written down where the next person will
// ask, not only on the ticket. This is what notices when it stops being there.
{
  const pages = mutatePages('page-deleted', { 'docs/launcher-args.md': null });
  if (pages) {
    const r = runProof(distDir, pages);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '4'), '§4 is what failed', failedIn(r, '4') || '(nothing failed in §4)');
    check(
      /was read at all/.test(failedIn(r, '4')),
      '⚠ and the PRECONDITION is among the failures — an unreadable page is reported as ' +
        'unreadable rather than as a page that fails its claims, which are different findings',
      failedIn(r, '4')
    );
    check(green(r, '1') && green(r, '2') && green(r, '3'),
      '⚠ while §1-§3 STAY GREEN', tally(r));
  }
}

// ===========================================================================
rule('5. ⚠ THE OTHER DIRECTION — the swallow made impossible, the pages left alone');
// ===========================================================================
//
// The prompt given a flag of its own. It is then no longer a bare operand, so
// no variadic argument can reach it and the hazard is gone — and every page in
// this repository still says it is there. §4 CANNOT NOTICE THAT, deliberately:
// a phrase check never could. §0 and §1 are what notice, which is the whole
// reason this proof measures a live argv instead of only reading pages.
{
  const mutant = mutate('prompt-is-no-longer-a-bare-operand', 'launchers.js', CLAUDE_FRESH,
    "const fresh = `claude ${flags}` + (promptCommand ? ' --prompt ' + shellQuote(promptCommand) : '');");
  if (mutant) {
    const r = runProof(mutant);
    check(r.exit !== 0, 'the proof goes RED', `exit ${r.exit}`);
    check(red(r, '1'), '§1 (the live swallow) is what failed', failedIn(r, '1') || '(nothing failed in §1)');
    check(
      /THE PROMPT WAS TAKEN AS A VALUE OF THE FLAG/.test(failedIn(r, '1')),
      'and the failing check is the swallow itself, named',
      failedIn(r, '1')
    );
    check(red(r, '0'), '§0 (the layout) failed too — the prompt is no longer a bare operand',
      failedIn(r, '0') || '(nothing failed in §0)');
    check(
      green(r, '4'),
      '⚠ WHILE §4 STAYS GREEN — every page still carries a warning about a hazard that has ' +
        'just stopped existing, and no phrase check could ever have told you. This is the ' +
        'direction a documentation gate degrades in, and §0/§1 are why it does not go quiet here',
      tally(r)
    );
    showReds(r);
  }
}

// ===========================================================================
rule("6. THE COMPILER — arm 5's edit is one a person could have shipped");
// ===========================================================================
//
// The arms above mutate the build, so nothing there was killed by `tsc`. Arm 5
// is the only one whose edit is code, so it is the only one where "the red was
// really the compiler" is available as an explanation. This removes it.
{
  // UNDER `scratch`, whose sibling `node_modules` symlink is what lets `tsc`
  // resolve `@types/node`. Compiled anywhere else it reports "Cannot find
  // module 'fs'" for the whole tree — a red that says nothing about the
  // mutation, and that this section would report as the compiler catching it.
  const srcCopy = path.join(scratch, 'src-check');
  fs.mkdirSync(srcCopy, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'src'), path.join(srcCopy, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'tsconfig.json'), path.join(srcCopy, 'tsconfig.json'));
  // ⚠ `package.json` TOO, AND IT IS NOT OPTIONAL. `module: NodeNext` decides
  // ESM-versus-CommonJS from the nearest package.json's `type`, so a copy
  // without one compiles as CommonJS and every `import.meta` in the tree is an
  // error — four of them, in files this mutation never touched. `kan504-red-
  // drive.mjs` records the same trap; this arm hit it anyway on its first run,
  // which is the argument for the precondition directly below rather than for
  // a comment.
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(srcCopy, 'package.json'));
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(srcCopy, 'node_modules'), 'dir');

  const tscOn = (label) => {
    const tsc = spawnSync(process.execPath,
      [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', srcCopy],
      { cwd: srcCopy, encoding: 'utf8', timeout: 300_000 });
    const out = ((tsc.stdout || '') + (tsc.stderr || '')).trim();
    return { status: tsc.status, out, label };
  };

  // ⚠ THE PRECONDITION, AND IT IS THE WHOLE REASON THIS ARM CAN BE BELIEVED.
  // The claim below is "tsc accepts the mutation". A copy that does not compile
  // BEFORE it is mutated cannot support that claim in either direction — a
  // non-zero exit afterwards would be read as the compiler catching a defect it
  // never saw. So the unmutated copy is compiled first and must be clean.
  const baseline = tscOn('unmutated');
  check(baseline.status === 0,
    '(precondition) the UNMUTATED copy compiles clean — otherwise the verdict below is about ' +
      'the copy rather than about the mutation',
    baseline.out ? baseline.out.split('\n').slice(0, 5).join('\n          ') : 'tsc exit 0');

  const launchersSrc = path.join(srcCopy, 'src', 'launchers.ts');
  const before = fs.readFileSync(launchersSrc, 'utf8');
  const FIND = CLAUDE_FRESH;
  const REPLACE =
    "const fresh = `claude ${flags}` + (promptCommand ? ' --prompt ' + shellQuote(promptCommand) : '');";
  const occurrences = before.split(FIND).length - 1;
  check(occurrences === 1,
    `the source anchor occurs exactly once (${FIX_THE_MUTATION})`,
    `found ${occurrences}`);
  if (occurrences === 1 && baseline.status === 0) {
    fs.writeFileSync(launchersSrc, before.replace(FIND, REPLACE));
    const mutated = tscOn('mutated');
    check(mutated.status === 0,
      "⚠ tsc ACCEPTS arm 5's mutation — it is a change a person could ship, and the red in " +
        'arm 5 was this proof catching it rather than the compiler',
      mutated.out ? mutated.out.split('\n').slice(0, 5).join('\n          ') : `tsc exit ${mutated.status}, no output`);
  }
}

// ---------------------------------------------------------------------------
// A mutation that did not apply is a section that never ran, and it reads
// exactly like a clean pass — so it is named rather than left to the count.
{
  const skipped = mutationsSkipped();
  check(skipped.length === 0,
    'every build mutation applied — none was silently skipped',
    skipped.length ? `${FIX_THE_MUTATION} skipped: ${skipped.join(', ')}` : 'none skipped');
}

console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}

process.exit(failures ? 1 : 0);
