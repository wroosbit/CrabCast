#!/usr/bin/env node
// KAN-529: a teardown's CLAIM and its MECHANISM, checked against each other.
//
// WHAT FAILURE THIS WOULD CATCH: a proof that ends by asserting no process
// outlived it, where the assertion reads a population the script maintains BY
// HAND — so the processes it never added are invisible to the check that says
// they are gone. `verify-variadic-args-swallow-prompt` and
// `verify-launcher-args` both shipped that way and both went green on every
// run while leaving a scratch daemon and its `herdr agent attach` children up.
// Measured on a developer machine 2026-08-18: 59 orphaned processes across 14
// already-deleted scratch roots, holding the fleet at zero headroom.
//
// ⚠ NOTHING ABOUT THAT WAS VISIBLE FROM THE OUTPUT. The check printed
// `every process this proof started is gone — 3 ended` beside `53/53 checks
// passed`. It is the class this epic keeps re-finding: an artifact whose
// sentence claims more than its mechanism covers, degrading toward looking
// finished.
//
// ---------------------------------------------------------------------------
// WHY A STATIC SWEEP RATHER THAN A RUNNING ONE
// ---------------------------------------------------------------------------
//
// `kan529-suite-leak-survey.mjs` runs every proof and counts what each leaves
// alive. That is the measurement, it takes minutes, and its answer belongs in a
// ticket. THIS file is the gate: it reads text, runs in a second, and is what
// stops the shape coming back. The two are deliberately not the same script —
// a gate nobody can afford to run is not a gate.
//
// ⚠ AND IT IS HONEST ABOUT WHAT TEXT CAN SEE. A script importing the sweeper
// is not a script that swept; §2 checks that the claim is BACKED, never that it
// is TRUE. What establishes truth is the survey and `kan529-red-drive.mjs`,
// which watches the check go red. This file's whole job is to make the
// hand-maintained-pid-set shape unwritable without somebody noticing.
//
// Usage:
//   node scripts/verify-proof-teardown-sweeps.mjs

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}
const rule = (title) => console.log(`\n${title}\n${'='.repeat(title.length)}`);

// ---------------------------------------------------------------------------
// THE PREDICATES, as functions so §5 can run them over a FIXTURE and require
// the opposite verdict. A predicate only ever applied to files that satisfy it
// is a predicate nobody has shown to discriminate.
// ---------------------------------------------------------------------------

/**
 * The same source with COMMENTS blanked and string contents left alone.
 *
 * ⚠ BOTH HALVES OF THAT ARE LOAD-BEARING, and getting either wrong inverts a
 * section. §1 asks whether a script CALLS `crabcast(['daemon','stop'])`, which
 * is code — and the fix for KAN-529 replaced those calls with COMMENTS
 * explaining why the call is dead, so a raw text match reddens on the very
 * files that fixed it. §2 asks whether a script CLAIMS something, and the claim
 * is a string literal, so `verify-proof-verdicts`' `codeMask` — which blanks
 * strings as well — cannot be reused here. Hence a masker of its own.
 *
 * QUOTED strings keep their contents — a check LABEL is a quoted string and §2
 * has to read it. TEMPLATE literals are BLANKED, because that is where this
 * suite writes fixtures: `kan529-red-drive` reconstructs the pre-fix teardown
 * as a backtick template, and §1 must not read a quoted SPECIMEN of the dead
 * call as a CALL. Reddening the files that fixed the defect is the first thing
 * this section did when it was written.
 *
 * ⚠ `${...}` INTERPOLATION IS TRACKED, and it is not a nicety: this file's own
 * `check` helper nests a template inside one, which without the stack below
 * closes the outer template early and parses everything after it in the wrong
 * mode. That failed toward a FALSE POSITIVE here — but the same desync in the
 * other direction hides a real call, which is why it is a stack rather than a
 * flag.
 */
/**
 * A `/` here opens a regex rather than dividing — the usual conservative test.
 *
 * ⚠ THE KEYWORD HALF IS NOT OPTIONAL. `return /from\s+['"]…/` is the shape
 * every predicate in this file is written in, and without `return` in this set
 * that `/` reads as division, the `['"]` after it opens a STRING, and every
 * offset in the rest of the file is parsed in the wrong mode. Measured while
 * writing this file: the first comment to survive unblanked was 13 lines
 * further down, and the fixture 150 lines below that stopped being seen as a
 * template — so the file reported ITSELF as calling `daemon stop`.
 */
const REGEX_MAY_FOLLOW = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'instanceof'
]);
function startsRegex(lastSig, lastWord) {
  return lastSig === '' || '(,=:[!&|?{};+-*%~^<>'.includes(lastSig) ||
    REGEX_MAY_FOLLOW.has(lastWord);
}

export function withoutComments(src) {
  const out = [];
  /** Enclosing template literals, so `${...}` interpolation cannot desync us. */
  const templates = [];
  let mode = 'code';
  let braceDepth = 0;
  let i = 0;
  /** The last significant code character, so `/` can be told from division. */
  let lastSig = '';
  /** …and the last identifier, for the keyword forms of the same question. */
  let lastWord = '';
  const inTemplate = () => mode === '`' || templates.length > 0;
  const push = (c) => out.push(inTemplate() ? (c === '\n' ? '\n' : ' ') : c);

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        while (i < src.length && src[i] !== '\n') { out.push(' '); i += 1; }
        continue;
      }
      if (c === '/' && d === '*') {
        out.push(' ', ' '); i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          out.push(src[i] === '\n' ? '\n' : ' '); i += 1;
        }
        if (i < src.length) { out.push(' ', ' '); i += 2; }
        continue;
      }
      // Closing an interpolation returns us to the template that opened it.
      if (c === '}' && templates.length > 0 && braceDepth === 0) {
        mode = '`'; templates.pop(); push(c); i += 1; continue;
      }
      if (c === '{' && templates.length > 0) { braceDepth += 1; push(c); i += 1; continue; }
      if (c === '}' && templates.length > 0) { braceDepth -= 1; push(c); i += 1; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; push(c); i += 1; continue; }
      // ⚠ REGEX LITERALS, and this is not thoroughness for its own sake. A
      // character class like /['"]/ — which the predicates below are full of —
      // opens a string as far as a naive scanner is concerned, and every
      // offset after it is then parsed in the wrong mode. That is what made
      // this file report ITSELF as calling `daemon stop`: the fixture template
      // three hundred lines further down was no longer seen as a template.
      if (c === '/' && startsRegex(lastSig, lastWord)) {
        push(c); i += 1;
        let klass = false;
        while (i < src.length) {
          const r = src[i];
          if (r === '\\') { push(r); push(src[i + 1] ?? ''); i += 2; continue; }
          if (r === '[') klass = true;
          else if (r === ']') klass = false;
          else if (r === '/' && !klass) { push(r); i += 1; break; }
          else if (r === '\n') break;
          out.push(' '); i += 1;
        }
        lastSig = 'x';
        lastWord = '';
        continue;
      }
      if (/[A-Za-z_$0-9]/.test(c)) lastWord += c;
      else if (!/\s/.test(c)) { lastWord = ''; }
      if (!/\s/.test(c)) lastSig = c;
      push(c); i += 1;
      continue;
    }

    // Inside a string or a template.
    if (c === '\\') { push(c); push(src[i + 1] ?? ''); i += 2; continue; }
    if (mode === '`' && c === '$' && d === '{') {
      // Enter the interpolation as CODE, remembering the template to come back
      // to. Without this, a nested template — `${x ? `a` : ''}`, which this very
      // file's `check` helper contains — closes the outer one early and every
      // offset after it is parsed in the wrong mode.
      templates.push('`'); mode = 'code'; braceDepth = 0;
      push(c); push(d); i += 2; continue;
    }
    if (c === mode) { const wasTemplate = mode === '`'; mode = 'code'; if (wasTemplate) out.push(' '); else out.push(c); i += 1; continue; }
    push(c); i += 1;
  }
  return out.join('');
}

/** The dead call: `crabcast daemon stop` is a usage error, not a command. */
export function callsDaemonStop(text) {
  return /\[\s*['"]daemon['"]\s*,\s*['"]stop['"]\s*\]/.test(withoutComments(text));
}

/**
 * Does this script CLAIM that nothing it started outlived it?
 *
 * Deliberately loose about what sits between the two words — the two labels in
 * the suite read "every process this proof started is gone" and "every process
 * carrying this run's scratch root is gone", and a claim worded a third way is
 * still the claim. Bounded so it cannot span a whole file, and read off
 * comment-free source so that a header DESCRIBING the old label is not counted
 * as making it.
 */
export function claimsNoSurvivingProcesses(text) {
  return /every process[\s\S]{0,240}?\bgone\b/.test(withoutComments(text));
}

/** Does it derive that answer from the machine, keyed on its scratch root? */
export function importsTheSweeper(text) {
  return /from\s+['"]\.\/scratch-processes\.mjs['"]/.test(text);
}

/**
 * Does this script CAUSE a scratch daemon to exist?
 *
 * ⚠ THE FIRST VERSION OF THIS ASKED A NARROWER QUESTION AND MISSED TWO THIRDS
 * OF THE POPULATION. It was `mkdtempSync && /\bcli\.js\b/`, which assumes a
 * script starts its daemon by driving the CLI itself. `task/KAN-524` found the
 * hole from the outside, by being caught by this section and then not caught by
 * it: a RED DRIVE spawns its daemons THROUGH ANOTHER SCRIPT and never names
 * `cli.js`, so `kan524-red-drive.mjs` — measured exiting 0 with `43/43 checks
 * passed` while 24 processes were alive across 6 scratch roots — was skipped
 * entirely, register open or closed.
 *
 * ⚠ AND THE TWO DRIVES THAT WERE ON THE LIST MATCHED FOR THE WRONG REASON,
 * which is the part that would have rotted quietly. Checked when the report
 * came in: `kan514-red-drive.mjs`'s only two occurrences of `cli.js` are a
 * COMMENT and a mutation TARGET FILENAME (`mutate(…, 'cli.js', …)`) — neither
 * is driving anything — and `kan504-red-drive.mjs` does not contain the string
 * at all. A predicate that reaches the right files by accident is one bad
 * refactor from reaching none of them.
 *
 * So the question is asked three ways, and a script matching ANY of them counts:
 * it drives the CLI, it starts a daemon directly, or it runs another `.mjs`
 * script as a child node process — which is how a drive causes daemons it never
 * mentions.
 *
 * ⚠ THIS ERRS TOWARD INCLUDING, and that is the safe direction for a list whose
 * purpose is "somebody should look at this". A script that spawns node for a
 * fixture rather than for a proof lands here and costs a register line; a script
 * that leaks daemons and is not here costs what KAN-529 measured.
 */
export function causesAScratchDaemon(text) {
  if (!/mkdtempSync/.test(text)) return false;
  const drivesCli = /\bcli\.js\b/.test(text);
  const startsDaemon = /\bdaemon\.js\b/.test(text);
  const drivesAScript =
    /(?:spawnSync|spawn|execFileSync)\(\s*process\.execPath/.test(text) &&
    /['"`][\w./\\${}-]*\.mjs/.test(text);
  return drivesCli || startsDaemon || drivesAScript;
}

/**
 * Does it clean up on a signal, rather than only on the happy path?
 *
 * ⚠ WHAT THIS CANNOT VOUCH FOR, stated because the name promises more than the
 * mechanism delivers and this file is about exactly that gap. It sees that a
 * handler EXISTS. It cannot see whether the handler does the job: `task/KAN-524`
 * reports that `kan524-red-drive.mjs` carried SIGINT and SIGTERM handlers
 * throughout the period it was leaking 24 processes, because those handlers ran
 * `fs.rmSync` and killed nothing — so the scratch tree went away and the daemons
 * carried on executing out of a root that no longer existed, which is the state
 * this file's own header describes.
 *
 * That is not fixable by tightening this regex and no attempt is made to: a
 * handler's behaviour is not a property of its presence. What closes it is the
 * SURVEY, which interrupts nothing and simply counts what is left, and
 * `verify-proof-cleans-up-when-interrupted`, which kills a proof and counts.
 * ⚠ SO A GREEN §4 MEANS "EVERY SUCH SCRIPT HAS A HANDLER", NEVER "NO SCRIPT
 * LEAKS ON A SIGNAL". Read it as the first and nothing more.
 */
export function cleansUpOnSignal(text) {
  return /process\.on\(\s*signal\s*,|process\.on\(\s*['"]SIG/.test(text);
}

// ---------------------------------------------------------------------------
// THE REGISTER — scripts that spawn a scratch daemon and do NOT clean up on a
// signal path. Every one is named, so the count cannot grow silently.
//
// ⚠ THESE ARE NOT BLESSED. They are RECORDED. The distinction matters because
// an unexplained exemption list is how a gate becomes decorative: each entry
// below says what was measured about that file, and "not measured" is written
// as "not measured" rather than left to read as "fine". A new script joining
// this list is a FAILURE — the list is closed, and §4 is what closes it.
//
// Measured by `kan529-suite-leak-survey.mjs` on 2026-08-18. A script that runs
// to completion and leaks nothing still leaks when INTERRUPTED, which is what a
// signal handler is for and what none of these has.
// ---------------------------------------------------------------------------
const NOT_MEASURED =
  'Causes a scratch daemon and has no signal-path teardown, so an INTERRUPTED run leaves it ' +
  'up. Whether a run that COMPLETES leaks is a separate question, answered by ' +
  '`kan529-suite-leak-survey.mjs` and reported on KAN-529 rather than restated here — a note ' +
  'copied by hand is the first thing to go stale.';

/**
 * ⚠ THIS LIST TRIPLED WHEN THE PREDICATE ABOVE WAS CORRECTED, from 13 to 45,
 * and the growth is the finding rather than a regression. Nothing changed in
 * these scripts: `causesAScratchDaemon` simply stopped assuming that a script
 * starts its daemon by driving the CLI itself, and two thirds of the population
 * became visible. A register of 13 that felt manageable was a register missing
 * 28 files.
 *
 * ⚠ THESE ARE NOT BLESSED. They are RECORDED, so the count cannot grow
 * silently. A new script joining this list is a FAILURE — the list is closed,
 * and §4 is what closes it.
 */
const NO_SIGNAL_TEARDOWN = new Map([
  ['kan117-red-drive', NOT_MEASURED],
  ['kan173-red-drive', NOT_MEASURED],
  ['kan328-red-drive', NOT_MEASURED],
  ['kan386-red-drive', NOT_MEASURED],
  ['kan392-red-drive', NOT_MEASURED],
  ['kan394-red-drive', NOT_MEASURED],
  ['kan426-red-drive', NOT_MEASURED],
  ['kan428-red-drive', NOT_MEASURED],
  ['kan433-red-drive', NOT_MEASURED],
  ['kan448-red-drive', NOT_MEASURED],
  ['run-verify', NOT_MEASURED],
  ['verify-activated-by', NOT_MEASURED],
  ['verify-agent-power-controls', NOT_MEASURED],
  ['verify-channel-enabled', NOT_MEASURED],
  ['verify-ci-wiring-guards', NOT_MEASURED],
  ['verify-cli-refusal', NOT_MEASURED],
  ['verify-config-and-socket', NOT_MEASURED],
  ['verify-config-echo-contract', NOT_MEASURED],
  ['verify-cpu-headroom', NOT_MEASURED],
  ['verify-daemon-foreground', NOT_MEASURED],
  ['verify-daemon-provenance', NOT_MEASURED],
  ['verify-daemon-started-at', NOT_MEASURED],
  ['verify-daemon-status-over-mcp', NOT_MEASURED],
  ['verify-event-contract', NOT_MEASURED],
  ['verify-herdr-release', NOT_MEASURED],
  ['verify-herdr-version-notice', NOT_MEASURED],
  ['verify-mcp-tools', NOT_MEASURED],
  ['verify-panes-are-reclaimed', NOT_MEASURED],
  ['verify-path-problem', NOT_MEASURED],
  ['verify-pretrust-survives-concurrency', NOT_MEASURED],
  ['verify-prompt-is-not-a-template', NOT_MEASURED],
  ['verify-proof-defences', NOT_MEASURED],
  ['verify-proof-verdicts', NOT_MEASURED],
  ['verify-pty-init-rejects-unknown-session', NOT_MEASURED],
  ['verify-pty-payload-refusal', NOT_MEASURED],
  ['verify-read-contract', NOT_MEASURED],
  ['verify-readme-is-current', NOT_MEASURED],
  ['verify-reattach-leaves-global-config-alone', NOT_MEASURED],
  ['verify-reconfiguration-refuses', NOT_MEASURED],
  ['verify-registry-survives-retired-rows', NOT_MEASURED],
  ['verify-restore-admission', NOT_MEASURED],
  ['verify-scaffolding-past-the-gate', NOT_MEASURED],
  ['verify-state-read-echoes-config', NOT_MEASURED],
  ['verify-submit-withheld-at-dialog', NOT_MEASURED],
  ['verify-unreadable-row-standing', NOT_MEASURED]
]);

// ---------------------------------------------------------------------------
const tracked = execFileSync('git', ['ls-files', 'scripts/*.mjs'], {
  cwd: repoRoot, encoding: 'utf8'
})
  .split('\n')
  .filter((s) => s.length)
  .map((rel) => ({
    rel,
    name: path.basename(rel, '.mjs'),
    text: fs.readFileSync(path.join(repoRoot, rel), 'utf8')
  }));

console.log(`${tracked.length} tracked scripts under scripts/\n`);

// A CANARY ON THE INPUT ITSELF. Every section below reports "none found" as a
// pass, and an empty file list would produce a clean sweep that measured
// nothing at all.
check(
  tracked.length > 50,
  '(precondition) git listed a plausible number of scripts — an empty list would make ' +
    'every section below pass vacuously',
  `${tracked.length} files`
);

// ===========================================================================
rule('1. `crabcast daemon stop` is called nowhere — it is not a command');
// ===========================================================================
//
// It exits 2 with `crabcast: \`crabcast daemon\` takes no arguments, and got
// "stop"`. Both proofs called it immediately before asserting that everything
// had stopped, and neither read its status. There is no legitimate use, so
// there is no register here.
{
  const offenders = tracked.filter((f) => callsDaemonStop(f.text));
  check(
    offenders.length === 0,
    'no script calls `crabcast([\'daemon\', \'stop\'])`',
    offenders.length ? offenders.map((f) => f.rel).join('\n          ')
      : 'none — `cli.ts` has no such action, so a teardown resting on it does nothing'
  );
}

// ===========================================================================
rule('2. A claim that no process survived is backed by a sweep of the machine');
// ===========================================================================
{
  const claimants = tracked.filter((f) => claimsNoSurvivingProcesses(f.text));
  check(
    claimants.length > 0,
    '(precondition) at least one script makes the claim — otherwise this section is vacuous',
    `${claimants.length}: ${claimants.map((f) => f.name).join(', ')}`
  );

  const unbacked = claimants.filter((f) => !importsTheSweeper(f.text));
  check(
    unbacked.length === 0,
    'every script claiming no process outlived it reads the answer off the machine, ' +
      'keyed on its own scratch root',
    unbacked.length
      ? unbacked.map((f) => `${f.rel} — claims it, does not import scratch-processes.mjs`).join('\n          ')
      : claimants.map((f) => f.name).join(', ')
  );
}

// ===========================================================================
rule('3. The sweeper itself is not exempt from being a real module');
// ===========================================================================
{
  const sweeper = tracked.find((f) => f.name === 'scratch-processes');
  check(!!sweeper, 'scripts/scratch-processes.mjs is tracked', sweeper?.rel ?? 'MISSING');
  if (sweeper) {
    check(
      /export function assertSweepableRoot/.test(sweeper.text),
      'and it refuses a root that would make the sweep dangerous',
      'assertSweepableRoot is exported and called from every entry point'
    );
    // A sweep keyed on a string that matches too much would SIGKILL the live
    // fleet. This is the one property of that module worth pinning from
    // outside it.
    check(
      /startsWith\(`\$\{tmp\}\$\{path\.sep\}`\)/.test(sweeper.text),
      'and it requires the root to be strictly under the system temp directory',
      'the check is present in assertSweepableRoot'
    );
  }
}

// ===========================================================================
rule('4. The no-signal-teardown register is exact — closed, and not stale');
// ===========================================================================
//
// Two directions, because a register is wrong in two ways and only one of them
// is loud. A script that JOINS the list without being added is the regression
// this gate exists for; an entry that has been FIXED and left in the list is
// how a register becomes a lie nobody rechecks.
{
  const offenders = tracked
    .filter((f) => causesAScratchDaemon(f.text) && !cleansUpOnSignal(f.text))
    .map((f) => f.name);

  const unregistered = offenders.filter((n) => !NO_SIGNAL_TEARDOWN.has(n));
  check(
    unregistered.length === 0,
    'no NEW script spawns a scratch daemon without a signal-path teardown',
    unregistered.length
      ? `${unregistered.join(', ')} — add the teardown, or add it here with what was measured`
      : `${offenders.length} known, all registered`
  );

  const stale = [...NO_SIGNAL_TEARDOWN.keys()].filter((n) => !offenders.includes(n));
  check(
    stale.length === 0,
    'and no entry in the register has been fixed and left in it',
    stale.length ? `${stale.join(', ')} — now clean; delete the entry` : `${NO_SIGNAL_TEARDOWN.size} entries, all still true`
  );

  const missing = [...NO_SIGNAL_TEARDOWN.keys()].filter(
    (n) => !tracked.some((f) => f.name === n)
  );
  check(
    missing.length === 0,
    'and no entry names a script that no longer exists',
    missing.length ? missing.join(', ') : 'every entry resolves to a tracked file'
  );
}

// ===========================================================================
rule('5. THE PREDICATES DISCRIMINATE — the same checks over a broken fixture');
// ===========================================================================
//
// ⚠ WITHOUT THIS SECTION EVERY PASS ABOVE IS A CLAIM ABOUT THE SEARCH RATHER
// THAN ABOUT THE SUITE. A regex that matched nothing would report the whole
// repository clean, in exactly the words a clean repository produces. So each
// predicate is run over text built to violate it, and must say so.
{
  const BAD_TEARDOWN = `
    const spawnedPids = new Set();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    const cli = path.join(distDir, 'cli.js');
    crabcast(['daemon', 'stop']);
    check(survivors.length === 0, 'every process this proof started is gone', '');
  `;
  check(callsDaemonStop(BAD_TEARDOWN), '§1\'s predicate FLAGS a fixture that calls `daemon stop`');
  check(
    claimsNoSurvivingProcesses(BAD_TEARDOWN),
    '§2\'s predicate FINDS the claim in a fixture that makes it'
  );
  check(
    !importsTheSweeper(BAD_TEARDOWN),
    '§2\'s predicate reports the fixture as UNBACKED — claim present, sweeper absent'
  );
  check(
    causesAScratchDaemon(BAD_TEARDOWN) && !cleansUpOnSignal(BAD_TEARDOWN),
    '§4\'s predicates flag a fixture that spawns a scratch daemon with no signal handler'
  );

  // ⚠ THE DRIVE SHAPE, and this case exists because the predicate MISSED it in
  // the version that shipped. A drive names no `cli.js` and no `daemon.js` — it
  // runs another script, which starts the daemon on its behalf. `task/KAN-524`
  // measured `kan524-red-drive.mjs` exiting 0 with `43/43 checks passed` while
  // 24 processes were alive across 6 scratch roots, invisible to this section.
  const DRIVE = `
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x-red-'));
    const proof = path.join(scriptDir, 'verify-launcher-args.mjs');
    const res = spawnSync(process.execPath, [proof, against], { encoding: 'utf8' });
  `;
  check(
    causesAScratchDaemon(DRIVE),
    '⚠ §4\'s predicate FLAGS a drive, which names neither cli.js nor daemon.js and starts ' +
      'its daemons through the script it runs',
    'the shipped version returned false here and skipped every drive in the suite'
  );
  check(
    !cleansUpOnSignal(DRIVE),
    'and reports that same drive as having no signal-path teardown'
  );

  // AND THE DIRECT-DAEMON SHAPE, the other thing `cli.js` alone could not see.
  const DIRECT = `
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    const d = spawn(process.execPath, [path.join(distDir, 'daemon.js'), configPath]);
  `;
  check(
    causesAScratchDaemon(DIRECT),
    '§4\'s predicate FLAGS a script that starts daemon.js directly'
  );

  // AND THE OPPOSITE DIRECTION, because a predicate that flags everything is
  // as useless as one that flags nothing, and would have gone unnoticed above:
  // every section reports its offenders, and a universal offender list is not
  // a shape anybody double-takes at.
  const GOOD_TEARDOWN = `
    import { sweepScratchRoot } from './scratch-processes.mjs';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    const cli = path.join(distDir, 'cli.js');
    for (const signal of ['SIGINT']) { process.on(signal, () => {}); }
    const { survivors } = await sweepScratchRoot(tmp);
    check(survivors.length === 0, 'every process carrying this run\\'s scratch root is gone', '');
  `;
  check(!callsDaemonStop(GOOD_TEARDOWN), '§1\'s predicate CLEARS a fixture that does not call it');
  check(
    claimsNoSurvivingProcesses(GOOD_TEARDOWN) && importsTheSweeper(GOOD_TEARDOWN),
    '§2\'s predicate reports a swept fixture as BACKED'
  );
  check(
    cleansUpOnSignal(GOOD_TEARDOWN),
    '§4\'s predicate CLEARS a fixture that installs a signal handler'
  );

  // ⚠ AND THE PREDICATE MUST STILL SAY NO TO SOMETHING. It was widened three
  // ways at once; one that returns true for every file would close the register
  // question by making every script an offender, and §4 would read as a large
  // tidy list rather than as a gate.
  const NO_DAEMON = `
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    const text = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    check(/warning/.test(text), 'the page carries the warning', '');
  `;
  check(
    !causesAScratchDaemon(NO_DAEMON),
    '⚠ but a scratch root with NO daemon and NO child script is NOT flagged — the widened ' +
      'predicate still discriminates',
    'a predicate that flagged everything would make the register meaningless rather than wrong'
  );
}

// ===========================================================================
rule('6. THE MASKER — the two desyncs that made §1 accuse the wrong files');
// ===========================================================================
//
// ⚠ THIS SECTION EXISTS BECAUSE BOTH BUGS WERE REAL AND BOTH FAILED THE SAME
// WAY: they made §1 report a file as CALLING `daemon stop` when what it held
// was a quoted specimen of the call. Each was found by running this file
// against itself, not by reading it. The direction matters — a desync can just
// as easily hide a real call, and nothing downstream would say so.
{
  // ⚠ A TEMPLATE LITERAL, and it has to be one. `withoutComments` preserves
  // quoted strings — §2 reads check labels out of them — so writing this
  // specimen in quotes would make THIS file trip §1, which is the very
  // confusion between a specimen and an instance this section is about. A
  // backtick is blanked by the scan and evaluates normally at run time.
  const DEAD = `crabcast(['daemon', 'stop']);`;

  // (a) A REGEX AFTER A KEYWORD. `return /…['"]…/` is how every predicate above
  // is written. Read as division, the `['"]` opens a string and everything
  // after it parses in the wrong mode.
  const afterKeywordRegex =
    'function f(t) {\n  return /from\\s+[\'"]x[\'"]/.test(t);\n}\n' +
    'const FIXTURE = `\n  ' + DEAD + '\n`;\n';
  check(
    !callsDaemonStop(afterKeywordRegex),
    '(a) a regex after `return` does not desync the scan — the template after it is still ' +
      'seen as a template',
    'without `return` in REGEX_MAY_FOLLOW this reported a call that is not there'
  );

  // (b) A NESTED TEMPLATE INSIDE `${…}`. This file's own `check` helper is
  // exactly this shape, and it closed the outer template early.
  const nestedTemplate =
    'console.log(`a ${x ? `b` : \'\'} c`);\n' +
    'const FIXTURE = `\n  ' + DEAD + '\n`;\n';
  check(
    !callsDaemonStop(nestedTemplate),
    '(b) a template nested in an interpolation does not desync it either',
    'without the interpolation stack this reported a call that is not there'
  );

  // (c) ⚠ AND THE OTHER DIRECTION, which is the one that would be silent. Both
  // fixes blank MORE text, and a masker that blanked too much would clear every
  // file — including one with a genuine call — while §1 printed the same
  // reassuring "none".
  const realCallAfterRegex =
    'function f(t) {\n  return /from\\s+[\'"]x[\'"]/.test(t);\n}\n' +
    '  ' + DEAD + '\n';
  check(
    callsDaemonStop(realCallAfterRegex),
    '(c) ⚠ but a REAL call sitting after that same regex is still FOUND — the fixes blank ' +
      'templates and regexes, not everything',
    'this is the check that would go red if the masker started swallowing code'
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
