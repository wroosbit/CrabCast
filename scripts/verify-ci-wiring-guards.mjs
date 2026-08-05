#!/usr/bin/env node
// Proof for KAN-148: the two CI-wiring guards go red for every shape that
// stops the proof-list audit running, and stay green for every shape that
// genuinely runs it.
//
// WHAT FAILURE THIS WOULD CATCH: a `run:` block that mentions
// `node scripts/verify-proof-registry.mjs` while never actually running it —
// buried in a multi-line `if` guard, a heredoc, an uncalled function, a
// `$( … )` capture, a `while false` loop, or a subshell with a `|| true`
// after its closing paren — read by scripts/ci-workflow.mjs as a live,
// gating invocation, so both guards report exit 0 with the audit dead.
//
// WHY IT EXISTS. KAN-141 closed nineteen shapes over four rounds, and every
// one of them was closed by reasoning about the invocation's OWN LINE plus
// the block's last line. Eight more shapes therefore stayed green, because
// what gated them lived on a different line of the same block. Those eight
// are rows 1–8 of section 3. KAN-148 replaced the per-line scan with a shell
// lexer and parser that reads the whole block at once.
//
// The nineteen KAN-141 shapes are re-run here alongside them, in the same
// matrix and by the same mechanism. A regression there would be worse than
// the bug being fixed, and a proof that only covered the new shapes would not
// have noticed one.
//
// HOW IT PROVES IT — and what that leaves uncovered, which is the part worth
// reading. This script MUTATES `.github/workflows/ci.yml` in place, runs both
// guards against it as real child processes, records the exit code and the
// named FAIL line, and restores the file. So it proves that a mutated
// workflow reaches those two guards and that they act on it.
//
// IT SUPPLIES ITS OWN INPUT, so it does NOT prove that the workflow committed
// in this repository keeps the audit live. Two things cover that, and neither
// is this script: section 1's baseline row asserts it here, and — the one
// that matters, because it is not this script's word for it — the guards run
// on the real ci.yml in CI on every PR, from the `proof-registry` job and
// from the `verify` array. If the committed workflow ever stopped running the
// audit, those runs go red whether or not anybody runs this file.
//
// IT WRITES A TRACKED FILE, and the cleanup for that is two-layered because
// one layer is not enough — witnessed, not supposed. It restores ci.yml in a
// `finally` around every row and again from an `exit`/signal handler, which
// covers a normal death and a Ctrl-C. It does NOT cover SIGKILL or the
// machine losing power: this script was interrupted by a reboot mid-row
// during KAN-148's own development and left ci.yml with the proof-registry
// step deleted, which is row E's mutation. The backstop is the setup guard
// at the top: it requires exactly one `- run: node scripts/…` line and one
// `proof-registry:` line and REFUSES to run otherwise, so the next run reports
// a workflow nobody wrote instead of quietly measuring against it. If you see
// that refusal, `git diff .github/workflows/ci.yml` shows what was left
// behind.
//
// Section 2 is the other half of an honest proof: it reproduces the DEFECT.
// It loads the pre-fix `scripts/ci-workflow.mjs` out of git and shows the same
// eight shapes reading as LIVE there, so the green in section 3 is measuring
// a change rather than restating an intent. It needs the pre-fix source to be
// reachable — see the section for exactly what it reports when it is not, and
// why that case is announced rather than passed over.
//
// Needs no daemon, no herdr and no network. It reads and writes one tracked
// file and spawns two node processes per row.

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const REGISTRY = path.join('scripts', 'verify-proof-registry.mjs');
const PARITY = path.join('scripts', 'verify-cli-parity.mjs');
const NEEDLE = /node\s+scripts\/verify-proof-registry\.mjs/;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Setup guards. These are not verdicts: they are the preconditions without
// which every row below would be measuring the wrong thing.
// ---------------------------------------------------------------------------

const ORIGINAL = fs.readFileSync(workflowPath, 'utf8');
const STEP_LINE = '      - run: node scripts/verify-proof-registry.mjs';
const JOB_LINE = '  proof-registry:';

if (ORIGINAL.split('\n').filter((l) => l === STEP_LINE).length !== 1) {
  console.error(`setup: expected exactly one line ${JSON.stringify(STEP_LINE)} in ci.yml — cannot mutate`);
  process.exit(1);
}
if (ORIGINAL.split('\n').filter((l) => l === JOB_LINE).length !== 1) {
  console.error(`setup: expected exactly one line ${JSON.stringify(JOB_LINE)} in ci.yml — cannot mutate`);
  process.exit(1);
}
if (!fs.existsSync(path.join(repoRoot, 'dist', 'cli.js'))) {
  console.error('setup: dist/cli.js not found — run `npm run build` first. verify-cli-parity needs the built');
  console.error('       command table, and a run that skipped it would report on rows it never measured.');
  process.exit(1);
}

// The file must go back exactly as it was found even if this run dies.
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  try { fs.writeFileSync(workflowPath, ORIGINAL); } catch { /* nothing better to do while dying */ }
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restore(); process.exit(130); });
}

// ---------------------------------------------------------------------------
// Running the two guards over whatever ci.yml currently says.
// ---------------------------------------------------------------------------

/** A FAIL line from either guard's CI-wiring assertion, by its own wording. */
const isWiringFail = (line) =>
  line.startsWith('FAIL') &&
  (line.includes('from a live step of its own') ||
    line.includes('runs it from a live step') ||
    line.includes('buries it in a construct that may not run'));

function runGuard(script) {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    code: r.status,
    wiringFails: out.split('\n').filter(isWiringFail)
  };
}

function runBoth(yaml) {
  fs.writeFileSync(workflowPath, yaml);
  try {
    return { reg: runGuard(REGISTRY), par: runGuard(PARITY) };
  } finally {
    fs.writeFileSync(workflowPath, ORIGINAL);
  }
}

// ---------------------------------------------------------------------------
// The mutations.
// ---------------------------------------------------------------------------

const replaceStep = (...lines) => (yaml) => yaml.replace(STEP_LINE, lines.join('\n'));
const deleteStep = () => (yaml) => yaml.replace(`${STEP_LINE}\n`, '');
const addJobKey = (line) => (yaml) => yaml.replace(JOB_LINE, `${JOB_LINE}\n${line}`);
const block = (...body) => replaceStep('      - run: |', ...body.map((l) => `          ${l}`));

/**
 * Rows 1–8 are KAN-148's eight shapes, in the ticket's own order. Rows A–P10
 * are KAN-141's, re-run so a regression there is a red row here rather than a
 * discovery in review. Rows g1–g9 and M/O/X are the shapes that must STAY
 * green: a guard that flagged `&&`, `set -euo pipefail` or a `time` prefix is
 * one people route around.
 *
 * `expect` is the phrase each guard's own FAIL line has to contain, and it is
 * there because of a mutation that got through without it. Every not-live
 * verdict fails CLOSED by construction — a finding that is not position
 * 'command' can never satisfy `live` — so a guard that stopped reading the
 * BURIED verdict entirely still exited 1, on the fallback message, and a
 * matrix that only checked the exit code stayed green over it. The exit code
 * says a reader is stopped; `expect` is what says they are TOLD WHY. AC 1
 * asks for both.
 *
 * Row E has no `expect`: the two guards word "there is nothing here at all"
 * differently, and inventing a shared phrase for it would be asserting a
 * string rather than a diagnosis.
 */
const CASES = [
  // ---- KAN-148: gated from another line of the block -----------------------
  { id: '1', what: 'multi-line if-guard', want: 'RED', expect: 'the body of an `if`', gap: true,
    mutate: block('if [ "$SKIP_AUDIT" != 1 ]; then', '  node scripts/verify-proof-registry.mjs', 'fi') },
  { id: '2', what: 'multi-line subshell, `) || true`', want: 'RED', expect: '|| true', gap: true,
    mutate: block('(', '  node scripts/verify-proof-registry.mjs', ') || true') },
  { id: '3', what: 'line continuation onto `|| true`', want: 'RED', expect: '|| true', gap: true,
    mutate: block('node scripts/verify-proof-registry.mjs \\', '  || true') },
  { id: '4', what: 'unquoted command substitution', want: 'RED', expect: 'command substitution', gap: true,
    mutate: replaceStep('      - run: echo $(node scripts/verify-proof-registry.mjs)') },
  { id: '5', what: 'captured into a variable', want: 'RED', expect: 'command substitution', gap: true,
    mutate: replaceStep('      - run: out=$(node scripts/verify-proof-registry.mjs)') },
  { id: '6', what: 'heredoc body', want: 'RED', expect: 'heredoc body', gap: true,
    mutate: block('cat <<EOF', 'node scripts/verify-proof-registry.mjs', 'EOF') },
  { id: '7', what: 'function body that is never called', want: 'RED', expect: 'a function body', gap: true,
    mutate: block('audit() {', '  node scripts/verify-proof-registry.mjs', '}', 'echo "not calling it"') },
  { id: '8', what: 'trap "exit 0" EXIT, then the invocation', want: 'RED', expect: 'trap', gap: true,
    mutate: block('trap "exit 0" EXIT', 'node scripts/verify-proof-registry.mjs') },
  { id: '8b', what: 'while false; do … done', want: 'RED', expect: '`while` loop', gap: true,
    mutate: block('while false; do', '  node scripts/verify-proof-registry.mjs', 'done') },
  { id: '8c', what: 'line continuation in a PLAIN scalar (YAML folds it)', want: 'RED', expect: '|| true', gap: true,
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs \\', '          || true') },

  // ---- KAN-141: never runs -------------------------------------------------
  { id: 'A', what: 'commented out', want: 'RED', expect: 'not as a step at all',
    mutate: replaceStep('      # TODO restore: - run: node scripts/verify-proof-registry.mjs') },
  { id: 'B', what: '`if: false` on the job', want: 'RED', expect: 'if: false', mutate: addJobKey('    if: false') },
  { id: 'B2', what: '`if: ${{ false }}` on the job', want: 'RED', expect: 'if: ${{ false }}', mutate: addJobKey('    if: ${{ false }}') },
  { id: 'C', what: '`continue-on-error: true` on the job', want: 'RED', expect: 'continue-on-error: true',
    mutate: addJobKey('    continue-on-error: true') },
  { id: 'D', what: '`if: false` on the step', want: 'RED', expect: 'if: false',
    mutate: replaceStep(STEP_LINE, '        if: false') },
  { id: 'D2', what: '`continue-on-error: true` on the step', want: 'RED', expect: 'continue-on-error: true',
    mutate: replaceStep(STEP_LINE, '        continue-on-error: true') },
  { id: 'E', what: 'step deleted outright', want: 'RED', mutate: deleteStep() },
  { id: 'S', what: '`shell: python` on the step', want: 'RED', expect: 'shell: python',
    mutate: replaceStep(STEP_LINE, '        shell: python') },

  // ---- KAN-141: runs, exit status thrown away ------------------------------
  { id: 'F', what: '`|| true`', want: 'RED', expect: '|| true',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs || true') },
  { id: 'G', what: 'inline comment beside a no-op', want: 'RED', expect: 'not as a step at all',
    mutate: replaceStep('      - run: true  # node scripts/verify-proof-registry.mjs') },
  { id: 'H', what: '`set +e`', want: 'RED', expect: 'set +e',
    mutate: block('set +e', 'node scripts/verify-proof-registry.mjs') },
  { id: 'I', what: 'block ends `exit 0`', want: 'RED', expect: 'exit 0',
    mutate: block('node scripts/verify-proof-registry.mjs', 'exit 0') },
  { id: 'J', what: '`; true`', want: 'RED', expect: '; true',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs ; true') },
  { id: 'K', what: 'pipe without pipefail', want: 'RED', expect: 'pipefail',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs | cat') },
  { id: 'L', what: 'backgrounded with `&`', want: 'RED', expect: 'backgrounded',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs &') },
  { id: 'L2', what: 'one-line subshell `|| true`', want: 'RED', expect: '|| true',
    mutate: replaceStep('      - run: (node scripts/verify-proof-registry.mjs) || true') },
  { id: 'L3', what: 'one-line `if …; then`', want: 'RED', expect: 'the condition of an `if`',
    mutate: replaceStep('      - run: if node scripts/verify-proof-registry.mjs; then echo ok; fi') },
  { id: 'N!', what: 'negated with `!`', want: 'RED', expect: 'negated with `!`',
    mutate: replaceStep('      - run: ! node scripts/verify-proof-registry.mjs') },

  // ---- KAN-141: mentioned, never run ---------------------------------------
  { id: 'P1', what: 'echo "…"', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: echo "node scripts/verify-proof-registry.mjs"') },
  { id: 'P2', what: "echo '…'", want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: echo 'node scripts/verify-proof-registry.mjs'") },
  { id: 'P3', what: 'echo bare', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: echo node scripts/verify-proof-registry.mjs') },
  { id: 'P4', what: '`:` no-op builtin', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: ':' node scripts/verify-proof-registry.mjs") },
  { id: 'P5', what: "bash -c '…' || true", want: 'RED', expect: 'never begins a command',
    mutate: replaceStep("      - run: bash -c 'node scripts/verify-proof-registry.mjs' || true") },
  { id: 'P6', what: 'bash -c "…" || true', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: bash -c "node scripts/verify-proof-registry.mjs" || true') },
  { id: 'P7', what: '`timeout 60` wrapper', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: timeout 60 node scripts/verify-proof-registry.mjs') },
  { id: 'P8', what: 'eval "…"', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: eval "node scripts/verify-proof-registry.mjs"') },
  { id: 'P9', what: 'a longer word ending in `node`', want: 'RED', expect: 'never begins a command',
    mutate: replaceStep('      - run: mynode scripts/verify-proof-registry.mjs') },
  { id: 'P10', what: 'echo "$(…)" — the quoted inversion', want: 'RED', expect: 'command substitution',
    mutate: replaceStep('      - run: echo "$(node scripts/verify-proof-registry.mjs)"') },

  // ---- must STAY green -----------------------------------------------------
  { id: 'g1', what: 'plain scalar (the shipped shape)', want: 'GREEN', mutate: (y) => y },
  { id: 'g2', what: 'indented block-scalar line', want: 'GREEN',
    mutate: block('node scripts/verify-proof-registry.mjs') },
  { id: 'g3', what: '`cd . &&` first', want: 'GREEN',
    mutate: replaceStep('      - run: cd . && node scripts/verify-proof-registry.mjs') },
  { id: 'g4', what: '`time` prefix', want: 'GREEN',
    mutate: replaceStep('      - run: time node scripts/verify-proof-registry.mjs') },
  { id: 'g5', what: '`npm ci &&` first', want: 'GREEN',
    mutate: replaceStep('      - run: npm ci && node scripts/verify-proof-registry.mjs') },
  { id: 'g6', what: '`set -euo pipefail` first line', want: 'GREEN',
    mutate: block('set -euo pipefail', 'node scripts/verify-proof-registry.mjs') },
  { id: 'g7', what: 'trailing real comment', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs  # really run') },
  { id: 'g8', what: '`env FOO=1 node …` (KAN-148 AC3: was a false alarm)', want: 'GREEN',
    mutate: replaceStep('      - run: env FOO=1 node scripts/verify-proof-registry.mjs') },
  { id: 'g9', what: '`FOO=1 node …` (KAN-148 AC3: was a false alarm)', want: 'GREEN',
    mutate: replaceStep('      - run: FOO=1 node scripts/verify-proof-registry.mjs') },
  { id: 'M', what: '`&& echo` after', want: 'GREEN',
    mutate: replaceStep('      - run: node scripts/verify-proof-registry.mjs && echo done') },
  { id: 'O', what: 'pipe WITH pipefail', want: 'GREEN',
    mutate: block('set -o pipefail', 'node scripts/verify-proof-registry.mjs | cat') },
  { id: 'X1', what: 'a mention AND a real run on one line', want: 'GREEN',
    mutate: replaceStep(
      '      - run: echo node scripts/verify-proof-registry.mjs && node scripts/verify-proof-registry.mjs'
    ) },
  { id: 'X2', what: 'a real run followed by a trailing echo', want: 'GREEN',
    mutate: block('node scripts/verify-proof-registry.mjs', 'echo done') },
  { id: 'X3', what: 'a brace group at top level', want: 'GREEN',
    mutate: block('{ node scripts/verify-proof-registry.mjs; }') }
];

// ---------------------------------------------------------------------------
// 1. The baseline. Every row below is read against this, so if the unmutated
//    tree is not green there is nothing to measure.
// ---------------------------------------------------------------------------

console.log('=== 1. Baseline: the committed workflow keeps both guards green ===\n');

const baseline = runBoth(ORIGINAL);
check(baseline.reg.code === 0, 'verify-proof-registry passes on the unmutated ci.yml', `exit ${baseline.reg.code}`);
check(baseline.par.code === 0, 'verify-cli-parity passes on the unmutated ci.yml', `exit ${baseline.par.code}`);

// ---------------------------------------------------------------------------
// 2. The defect, reproduced against the parser that shipped before this change.
//
// Without this, section 3 is a table of greens that could equally well be
// describing a guard that was always right. The eight shapes have to be shown
// GOING THROUGH the old parser for the new one's verdict to mean anything.
//
// WHAT IT NEEDS: the pre-fix scripts/ci-workflow.mjs, out of git. Three ways
// that is legitimately unavailable, each reported rather than passed over:
// a shallow clone with no `origin/main`; a run on `main` after this merged,
// where `origin/main` IS this code and there is no pre-fix version to load;
// and a working tree whose ci-workflow.mjs already matches it.
// ---------------------------------------------------------------------------

console.log('\n=== 2. The same eight shapes against the PRE-FIX parser ===\n');

function preFixSource() {
  const current = fs.readFileSync(path.join(repoRoot, 'scripts', 'ci-workflow.mjs'), 'utf8');
  for (const ref of ['origin/main', 'main']) {
    let text;
    try {
      text = execFileSync('git', ['show', `${ref}:scripts/ci-workflow.mjs`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      continue;
    }
    if (text === current) return { ref, text: null, why: `${ref} already carries this parser` };
    return { ref, text, why: null };
  }
  return { ref: null, text: null, why: 'neither `origin/main` nor `main` is present in this clone' };
}

const preFix = preFixSource();
const gaps = CASES.filter((c) => c.gap);

if (!preFix.text) {
  console.log(`  NOT RUN — ${preFix.why}.`);
  console.log('  NOTHING IS ASSERTED IN THIS SECTION. It is not a pass. The eight shapes below are');
  console.log('  still exercised against the CURRENT parser in section 3; what is missing here is the');
  console.log('  demonstration that they used to get through. That run is on the KAN-148 pull request.');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan148-prefix-'));
  const file = path.join(tmp, 'ci-workflow-prefix.mjs');
  fs.writeFileSync(file, preFix.text);
  const old = await import(`file://${file}`);
  console.log(`  pre-fix parser loaded from ${preFix.ref}:scripts/ci-workflow.mjs\n`);
  for (const c of gaps) {
    const found = old.findRunInvocations(c.mutate(ORIGINAL), NEEDLE);
    const live = found.filter((f) => f.position === 'command' && f.disabled.length === 0);
    check(
      live.length > 0,
      `pre-fix: shape ${c.id} (${c.what}) read as a LIVE gating invocation`,
      live.length ? `ci.yml:${live.map((f) => f.line).join(', ci.yml:')} — the audit never ran and both guards said exit 0` : 'it did NOT — this shape was already caught before the change, so the ticket overstated it'
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. The matrix. Each row is applied to the real ci.yml, both guards are run
//    as processes against it, and the file is put back.
//
//    A RED row must do more than exit 1: it must produce a FAIL line from the
//    CI-WIRING assertion in each guard. Exiting 1 for some unrelated reason
//    would satisfy a weaker check and prove nothing about this parser.
// ---------------------------------------------------------------------------

console.log('\n=== 3. Every shape, through both guards ===\n');

const rows = [];
for (const c of CASES) {
  const mutated = c.mutate(ORIGINAL);
  if (c.id !== 'g1' && mutated === ORIGINAL) {
    check(false, `row ${c.id} (${c.what}) actually changed ci.yml`, 'the mutation was a no-op — it measured the baseline');
    continue;
  }
  const { reg, par } = runBoth(mutated);
  const got = reg.code === 0 && par.code === 0 ? 'GREEN' : 'RED';
  rows.push({ ...c, reg, par, got });

  if (c.want === 'RED') {
    const stopped = reg.code === 1 && reg.wiringFails.length > 0 && par.code === 1 && par.wiringFails.length > 0;
    check(
      stopped,
      `${c.id}  ${c.what} — both guards fail by name`,
      `registry exit=${reg.code} (${reg.wiringFails.length} wiring FAIL), parity exit=${par.code} (${par.wiringFails.length} wiring FAIL)`
    );
    if (c.expect) {
      const says = (rows) => rows.join('\n').includes(c.expect);
      check(
        says(reg.wiringFails) && says(par.wiringFails),
        `${c.id}  …and each says WHY: the message names \`${c.expect}\``,
        says(reg.wiringFails) && says(par.wiringFails)
          ? ''
          : `registry ${says(reg.wiringFails) ? 'does' : 'does NOT'}, parity ${says(par.wiringFails) ? 'does' : 'does NOT'} — ` +
            'a red check that cannot say which construct stopped it sends the reader back to the diff to guess'
      );
    }
  } else {
    check(
      reg.code === 0 && par.code === 0,
      `${c.id}  ${c.what} — still reads as live, both guards green`,
      `registry exit=${reg.code}, parity exit=${par.code}`
    );
  }
}

console.log('\n  --- the matrix ---\n');
const w = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(4)} ${r.what.padEnd(w)}  reg=${r.reg.code} par=${r.par.code}  ` +
      `want ${r.want.padEnd(5)} got ${r.got}${r.want === r.got ? '' : '   <-- MISMATCH'}`
  );
}

console.log('\n  --- what a reader is told, for each of the eight ---\n');
for (const r of rows.filter((x) => x.gap)) {
  console.log(`  ${r.id}  ${r.what}`);
  for (const line of r.reg.wiringFails) console.log(`      registry  ${line}`);
  for (const line of r.par.wiringFails) console.log(`      parity    ${line}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 4. The tree is exactly as it was found. This script writes a tracked file;
//    a run that left it mutated would hand the next script in the CI array a
//    workflow nobody wrote.
// ---------------------------------------------------------------------------

console.log('=== 4. ci.yml is byte-identical to how this run found it ===\n');

restore();
check(
  fs.readFileSync(workflowPath, 'utf8') === ORIGINAL,
  '.github/workflows/ci.yml restored'
);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
