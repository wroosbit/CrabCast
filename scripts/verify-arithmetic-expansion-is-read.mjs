#!/usr/bin/env node
// Proof for KAN-354: `scripts/ci-workflow.mjs` reads `$(( … ))` as arithmetic,
// and does not gain a live command by doing so.
//
// WHAT FAILURE THIS WOULD CATCH — two of them, in opposite directions, and the
// second is the one worth the file.
//
//   1. THE DEFECT. One `$(( … ))` anywhere in a `run:` block made the whole
//      block unreadable, so every CI-wiring guard reported every command in it
//      as not-live with a message about the BLOCK rather than about the
//      construct. `task/KAN-331` met it by writing `ms=$(( t1 - t0 ))` — the
//      obvious way to subtract two numbers in bash — and spent a bisect on it.
//      It failed closed, so it cost diagnosis rather than safety.
//
//   2. THE WIDENING. A parser taught to read arithmetic must not, in gaining
//      that, start reading a genuinely disabled command as LIVE. This is the
//      direction that turns a red into a green, and it is not hypothetical
//      here: closing (1) alone would have done exactly that — see §3's
//      `false &&` row and the note on it below.
//
// WHY (2) IS NOT A THEORETICAL WORRY, stated because a proof that only guarded
// the obvious direction would have shipped the regression. Before this change a
// block containing `$(( … ))` was unparseable, so `false && node scripts/…`
// inside it read as not-live — for the wrong reason, but red. Teaching the
// lexer arithmetic makes that block parse, and `false && node …` was ALREADY
// read as a live gating invocation by every parser this repo has shipped,
// including dff2422 from before KAN-148. So the arithmetic bug had been masking
// an older gap for that one block shape, and fixing it alone would have
// converted the mask into a green. KAN-354 therefore closes both: the lexer
// reads arithmetic, and `walk` learns that a part joined by `&&` to something
// that cannot succeed never runs. §3 is where the second is held.
//
// HOW THE FIXTURES ARE BUILT, and why they are derived rather than written out.
// Every §2 and §3 fixture is the REAL `.github/workflows/ci.yml`, with the real
// `node scripts/verify-proof-registry.mjs` invocation found in it and rewritten
// in place. Nothing here hand-writes a workflow: a literal fixture proves the
// parser handles the shape its author imagined, which is the shape they already
// had in mind when they wrote the parser. The one deliberate exception is §1,
// which runs the ticket's own reproduction verbatim, because that string IS
// acceptance criterion 1 and paraphrasing it would answer a different question.
//
// THE VACUITY GUARD, which is the assertion this file would be worthless
// without. Every §3 row asserts TWO things: that the block PARSES, and that the
// invocation in it is not live. Without the first, every row would pass on the
// pre-fix parser for the boring reason — an unreadable block yields no live
// commands at all, so "not live" would be true of a parser that had read
// nothing. The first assertion is what makes the second mean "the disabler was
// honoured" rather than "the reader gave up".
//
// RED-DRIVEN BOTH WAYS (§4, §5), because a proof that has only ever passed is
// evidence of nothing:
//
//   §4 STARVES THE WIDENING — puts `skipParens(text, i + 2)` back, and requires
//      §1, §2 and the PARSE-BORNE §3 vacuity guards to go RED.
//   §5 MAKES IT SWALLOW WHAT IT SHOULD REFUSE — three separate mutations, each
//      breaking a DIFFERENT disabler, and requires the matching §3 row to go
//      RED. Three rather than one because a negative case drawn from a single
//      predicate's vocabulary proves that predicate works on that shape and
//      nothing about coverage.
//
// WHAT §4 CANNOT REACH, named here because the count would otherwise read as
// coverage. Three of §3's eleven rows — `comment`, `heredoc` and `captured` —
// are classified from ranges the LEXER records, and `classify` consults those
// BEFORE it consults `parseError`. Starving the arithmetic branch therefore
// changes nothing about them: they never depended on the parse tree to be
// not-live. §4 asserts that explicitly — 8 of 11 go unreadable and those three
// are asserted UNAFFECTED — rather than expecting eleven and quietly passing on
// eight. Those three rows are held by §5 instead, which breaks their lexical
// mechanism directly.
//
// AND ONE MUTATION THAT CREDITED THE WRONG MECHANISM, kept in the file as a
// comment on the `comment` row of §5 because it is the more instructive half.
// The first attempt at red-driving that row disabled the lexer's `#` branch
// with `if (false && c === '#' …)`. The row did NOT go live — with `#` left as
// an ordinary word it becomes the command NAME, so the invocation after it
// reads as an ARGUMENT. Not-live, by a different mechanism, which would have
// been a green reported as a successful red drive. The mutation that actually
// removes the disabler and nothing else is emptying the recorded span.
//
// AND THE SECTION THAT EXISTS BECAUSE HAND-PICKED ROWS MISSED SOMETHING (§3c).
// Review of this PR found that `a || false && x` was reported dead when bash
// runs it: `&&` and `||` are left-associative with equal precedence, so that
// groups as `(a || false) && x`, and the rule was asking about the adjacent
// OPERAND rather than the CHAIN. Every §3b row happened to put the `&&` first,
// so none of them reached it. §3c does not answer that with three more chosen
// rows: it GENERATES every chain over `true`, `false` and `exit 1` to depth
// three, joined by every combination of `&&` and `||` — 258 of them — runs each
// through real bash, and asserts the one-directional invariant that matters:
// the parser may stay quiet about a command bash does not run, but it must
// never say "never runs" about one bash DOES run. §5b reinstates the defect and
// requires §3c to go red, so that section is not a green nobody has seen fail.
//
// WHAT THIS SUPPLIES ITS OWN INPUT FOR, AND WHO COVERS THE REST. It rewrites
// the invocation line in a COPY of ci.yml held in memory and never writes the
// tree. So it proves the parser classifies those shapes correctly; it does NOT
// prove the committed ci.yml keeps the audit live, and it does not run the two
// CI-wiring guards at all. `verify-ci-wiring-guards` owns both — it mutates the
// real file and runs both guards as processes — and `verify-proof-registry`
// owns the array-to-directory reconciliation. Nothing here should be read as
// covering those.
//
// Needs no daemon, no herdr, no network and no build: it imports one script and
// reads one tracked file.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';
import { analyzeRunBody, findRunInvocations } from './ci-workflow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSER = path.join(repoRoot, 'scripts', 'ci-workflow.mjs');
const WORKFLOW = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const NEEDLE = /node\s+scripts\/verify-proof-registry\.mjs/;

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan354-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const mutator = makeMutator({
  distDir: path.join(repoRoot, 'scripts'),
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

// ---------------------------------------------------------------------------
// The fixture builder. ONE workflow — the committed one — with the one real
// invocation line rewritten. `rewrite` receives the invocation's own text and
// its indentation and returns the lines that replace it.
// ---------------------------------------------------------------------------

const ORIGINAL = fs.readFileSync(WORKFLOW, 'utf8');

const invocationLine = ORIGINAL.split('\n').find((l) => NEEDLE.test(l) && !l.trimStart().startsWith('#'));
check(
  typeof invocationLine === 'string',
  '(setup) the committed ci.yml carries a `node scripts/verify-proof-registry.mjs` line to derive from',
  invocationLine ? invocationLine.trim() : 'no such line — every fixture below would be built from nothing'
);
if (!invocationLine) {
  console.log('\n1 CHECK(S) FAILED');
  process.exit(1);
}

const INDENT = invocationLine.match(/^\s*/)[0];          // the `- run:` step's own indent
const BODY_INDENT = `${INDENT}    `;                     // a block scalar's body sits four deeper
const COMMAND = invocationLine.trim().replace(/^-\s*run:\s*/, '');
const ARITHMETIC = 'ms=$(( t1 - t0 ))';

check(
  ORIGINAL.split(`${invocationLine}\n`).length - 1 === 1,
  '(setup) that line appears exactly once, so a fixture replaces the invocation and nothing else',
  `${ORIGINAL.split(`${invocationLine}\n`).length - 1} occurrence(s)`
);

/**
 * The committed workflow with the one-line `- run: <cmd>` step turned into a
 * `- run: |` block scalar carrying `lines`.
 *
 * The step keys and the job around it are the committed file's, untouched —
 * only the run body is ours. Same construction as verify-ci-wiring-guards'
 * `block()`, and for the same reason: a hand-written workflow would exercise
 * the shape its author already had in mind.
 */
function fixture(lines) {
  const replacement = [`${INDENT}- run: |`, ...lines.map((l) => `${BODY_INDENT}${l}`)].join('\n');
  const out = ORIGINAL.replace(invocationLine, replacement);
  if (out === ORIGINAL) return null;
  return out;
}

/** What the parser makes of the invocation in a fixture. */
function readFixture(text) {
  const found = findRunInvocations(text, NEEDLE);
  const live = found.filter((f) => f.position === 'command' && f.disabled.length === 0);
  return { found, live };
}

/** Whether every `run:` block in a fixture parsed. */
function blockParses(text, mod = { analyzeRunBody }) {
  // The invocation's own block is the one that matters, and it is the block the
  // rewritten lines went into. Reading it through the module under test keeps
  // §4 able to ask the same question of the starved parser.
  const found = mod.findRunInvocations ? mod.findRunInvocations(text, NEEDLE) : findRunInvocations(text, NEEDLE);
  return !found.some((f) => typeof f.note === 'string' && f.note.includes('could not be read as shell'));
}

// ---------------------------------------------------------------------------
// 1. The ticket's reproduction, verbatim.
//
// This is the one literal fixture in the file, and it is literal on purpose:
// it is acceptance criterion 1, character for character as KAN-331 measured it
// at 5b5a200 and as it still failed at 6cbe5bd9.
// ---------------------------------------------------------------------------

console.log('=== 1. The ticket\'s reproduction ===\n');

const REPRO = 'for s in a; do\n  ms=$(( t1 - t0 ))\n  node x\ndone\n';

{
  const a = analyzeRunBody(REPRO);
  check(
    a.parseError === null,
    'the reproduction parses — `for s in a; do  ms=$(( t1 - t0 ))  node x done`',
    a.parseError === null ? 'parseError: null' : `parseError: ${a.parseError} — this is the defect, unfixed`
  );

  // …and it parses as the RIGHT thing, not merely without complaint. `node x`
  // sits in a `for` body, so it must read as nested rather than live.
  const offset = REPRO.indexOf('node x');
  const cls = a.parseError === null ? a.classify(offset) : null;
  check(
    cls?.kind === 'nested' && /body of a `for` loop/.test(cls.note ?? ''),
    '…and `node x` in it reads as the body of a `for` loop, not as a live command',
    cls ? `${cls.kind}: ${cls.note ?? ''}` : 'not classified — the block did not parse'
  );
}

// The shapes around the fix, so the change is bounded rather than asserted at
// one point. Quoted arithmetic and the `(( … ))` command form already parsed
// before KAN-354; they are here so a later edit cannot break them silently.
const SHAPES = [
  { what: 'bare assignment', text: 'ms=$(( t1 - t0 ))\nnode x\n' },
  { what: 'inside a `for` body', text: 'for s in a; do\n  ms=$(( t1 - t0 ))\n  node x\ndone\n' },
  { what: 'inside an `if` body', text: 'if [ 1 = 1 ]; then\n  ms=$(( t1 - t0 ))\n  node x\nfi\n' },
  { what: 'nested parens inside the arithmetic', text: 'ms=$(( (t1 - t0) * 2 ))\nnode x\n' },
  { what: 'inside double quotes (parsed before KAN-354 too)', text: 'echo "took $(( t1 - t0 ))ms"\nnode x\n' },
  { what: 'the `(( … ))` command form (parsed before KAN-354 too)', text: '(( t1 > t0 )) && node x\n' },
  { what: 'a real command substitution (control)', text: 'ms=$(date +%s)\nnode x\n' }
];

for (const s of SHAPES) {
  const a = analyzeRunBody(s.text);
  check(a.parseError === null, `parses: ${s.what}`, a.parseError ?? 'parseError: null');
}

// ---------------------------------------------------------------------------
// 1b. The shapes the fixture set above does not reach, and the one that
//     corrected this change's own comment.
//
// The first draft of the note beside the fix in ci-workflow.mjs said an
// UNTERMINATED `$((` makes the block fail to parse. It does not: `skipParens`
// runs to end-of-text, so the rest of the block is swallowed into one word, the
// block parses as a single assignment, and what follows reads as an argument.
// Still fail-closed — a caller needs position 'command' with an empty
// `disabled` — but closed by a different mechanism than the sentence claimed.
// Asserted here because a comment nothing checks is how the next one drifts.
// ---------------------------------------------------------------------------

console.log('\n=== 1b. Arithmetic shapes the §2/§3 fixtures do not reach ===\n');

{
  const UNTERMINATED = 'ms=$(( t1 - t0\nnode x\n';
  const a = analyzeRunBody(UNTERMINATED);
  check(
    a.parseError === null,
    'an UNTERMINATED `$((` does NOT fail to parse — it swallows the rest of the block into one word',
    a.parseError === null ? 'parseError: null' : `parseError: ${a.parseError} — the comment beside the fix says otherwise`
  );
  const cls = a.parseError === null ? a.classify(UNTERMINATED.indexOf('node x')) : null;
  check(
    cls?.kind === 'argument',
    '…and the command after it reads as `argument`, so it is still fail-closed',
    cls ? `${cls.kind}: ${cls.note ?? ''}` : 'not classified'
  );
}

for (const s of [
  { what: 'arithmetic spanning several lines', text: 'ms=$((\n  t1 - t0\n))\nnode x\n' },
  { what: 'a C-style `for (( … ))` loop header', text: 'for ((i=0; i<3; i++)); do\n  node x\ndone\n' },
  { what: 'arithmetic containing `${#x}`', text: 'n=$(( ${#PATH} + 1 ))\nnode x\n' },
  { what: 'two arithmetic expansions on one line', text: 'a=$(( 1 + 1 )); b=$(( 2 + 2 ))\nnode x\n' },
  { what: 'arithmetic beside a real command substitution', text: 'a=$(( 1 + 1 ))\nb=$(date +%s)\nnode x\n' }
]) {
  const a = analyzeRunBody(s.text);
  check(a.parseError === null, `parses: ${s.what}`, a.parseError ?? 'parseError: null');
}

// ---------------------------------------------------------------------------
// 2. The real workflow, with real arithmetic added to the real step.
//
// §1 asks the parser about a string. This asks it about `.github/workflows/
// ci.yml` — the committed file, with `ms=$(( t1 - t0 ))` added beside the
// invocation, which is precisely the edit KAN-331 backed out and left a comment
// about at ci.yml's timing loop.
// ---------------------------------------------------------------------------

console.log('\n=== 2. The committed ci.yml, with arithmetic added beside the invocation ===\n');

const WITH_ARITHMETIC = fixture([`t0=$(date +%s%3N)`, ARITHMETIC, COMMAND]);

check(
  WITH_ARITHMETIC !== null && WITH_ARITHMETIC.split(ARITHMETIC).length - 1 === 1,
  '(vacuity) the fixture really carries exactly one `$(( … ))` that was not there before',
  `committed ci.yml contains ${ORIGINAL.split(ARITHMETIC).length - 1}, the fixture ${
    WITH_ARITHMETIC ? WITH_ARITHMETIC.split(ARITHMETIC).length - 1 : 0
  }`
);

{
  const { found, live } = readFixture(WITH_ARITHMETIC);
  check(
    live.length === 1,
    'the invocation is STILL read as a live gating invocation with `$(( … )) `in its block',
    live.length === 1
      ? `ci.yml:${live[0].line} in job ${live[0].job}`
      : `${live.length} live; ${found.map((f) => `${f.position}${f.note ? ` (${f.note})` : ''}`).join('; ')}`
  );
  check(
    blockParses(WITH_ARITHMETIC),
    '…and no `run:` block in the file reports itself unreadable',
    'the pre-fix parser fails this and takes every command in the block down with it'
  );
}

// ---------------------------------------------------------------------------
// 3. AC-3. Arithmetic in the block, and the command genuinely switched off.
//
// EVERY ROW ASSERTS TWO THINGS, and the first is the vacuity guard: the block
// must PARSE, and the invocation must not be live. A row that only asserted the
// second would pass against a parser that read nothing at all.
//
// The shapes are deliberately varied — a comment, a short-circuit, a swallow, a
// conditional, a loop, a definition, data, a capture, a step key — rather than
// several spellings of one predicate's vocabulary.
// ---------------------------------------------------------------------------

console.log('\n=== 3. Arithmetic in the block, command disabled: still not live ===\n');

const DISABLED = [
  {
    id: 'comment',
    what: 'commented out',
    lines: [`t0=$(date +%s%3N)`, ARITHMETIC, `# ${COMMAND}`],
    lexical: 'a `#` comment is recorded by the LEXER and `classify` checks it before it consults `parseError`'
  },
  {
    id: 'false-and',
    what: 'behind a `false &&`',
    lines: [`t0=$(date +%s%3N)`, ARITHMETIC, `false && ${COMMAND}`]
  },
  {
    id: 'or-true',
    what: 'followed by `|| true`',
    lines: [`t0=$(date +%s%3N)`, ARITHMETIC, `${COMMAND} || true`]
  },
  {
    id: 'if-false',
    what: 'inside `if false; then … fi`',
    lines: [ARITHMETIC, 'if false; then', `  ${COMMAND}`, 'fi']
  },
  {
    id: 'while-false',
    what: 'inside `while false; do … done`',
    lines: [ARITHMETIC, 'while false; do', `  ${COMMAND}`, 'done']
  },
  {
    id: 'function',
    what: 'inside a function that is never called',
    lines: [ARITHMETIC, 'audit() {', `  ${COMMAND}`, '}']
  },
  {
    id: 'heredoc',
    what: 'inside a heredoc body',
    lines: [ARITHMETIC, 'cat <<EOF', COMMAND, 'EOF'],
    lexical: 'heredoc bodies are recorded by the LEXER and `classify` checks them before `parseError`'
  },
  {
    id: 'captured',
    what: 'captured into a variable with `$( … )`',
    lines: [ARITHMETIC, `out=$(${COMMAND})`],
    lexical: '`$( … )` spans are recorded by the LEXER and `classify` checks them before `parseError`'
  },
  {
    id: 'set-plus-e',
    what: 'under `set +e`',
    lines: [ARITHMETIC, 'set +e', COMMAND]
  },
  {
    id: 'earlier-exit',
    what: 'after an unconditional `exit 0`',
    lines: [ARITHMETIC, 'exit 0', COMMAND]
  },
  {
    id: 'backgrounded',
    what: 'backgrounded with `&`',
    lines: [ARITHMETIC, `${COMMAND} &`]
  }
];

/** Built once here so §5 can re-read the same fixtures without rebuilding them. */
const builtDisabled = new Map();

for (const row of DISABLED) {
  const text = fixture(row.lines);
  builtDisabled.set(row.id, text);

  check(
    text !== null && text.split(ARITHMETIC).length - 1 === 1,
    `(vacuity) ${row.id}: the fixture carries exactly one \`$(( … ))\``,
    text ? `${text.split(ARITHMETIC).length - 1} occurrence(s)` : 'the invocation line was not replaced'
  );
  if (!text) continue;

  check(
    blockParses(text),
    `(vacuity) ${row.id}: the block PARSES, so "not live" below is the disabler and not a give-up`,
    'without this, every row here passes against the pre-fix parser, which read nothing'
  );

  const { found, live } = readFixture(text);
  check(
    live.length === 0,
    `${row.id}: ${row.what} — NOT read as a live gating invocation`,
    live.length === 0
      ? found.length
        ? found.map((f) => `${f.position}${f.disabled.length ? ` disabled: ${f.disabled[0]}` : ''}${f.note ? ` (${f.note})` : ''}`).join('; ')
        : 'no finding at all — a comment is not a step'
      : `LIVE at ci.yml:${live.map((f) => f.line).join(', ')} — the widening gained a command`
  );
}

// ---------------------------------------------------------------------------
// 3b. The other direction: the `&&` short-circuit must not OVER-block.
//
// §3 guards against the change gaining a live command. This guards against it
// LOSING one, which is the same defect wearing the other coat: a rule that
// blocked too much would report genuinely gating invocations as disabled, and
// the loudest version of that — `false && a || node …`, where bash really does
// run the invocation — is exactly the case the chain logic exists to get right.
//
// These rows fail in the safe direction if they break (a guard goes red rather
// than green), which is precisely why they need asserting: nothing else in this
// suite would notice a parser that had quietly become too strict, and a check
// people route around is a check that gets weakened.
// ---------------------------------------------------------------------------

console.log('\n=== 3b. …and the short-circuit does not over-block: these stay LIVE ===\n');

const STAY_LIVE = [
  { id: 'or-resumes', what: '`false && echo a || CMD` — `||` resumes, so it really runs', lines: [ARITHMETIC, `false && echo a || ${COMMAND}`] },
  { id: 'true-and', what: '`true && CMD`', lines: [ARITHMETIC, `true && ${COMMAND}`] },
  { id: 'cmd-and', what: '`echo hi && CMD`', lines: [ARITHMETIC, `echo hi && ${COMMAND}`] },
  { id: 'and-trailer', what: '`CMD && echo done`', lines: [ARITHMETIC, `${COMMAND} && echo done`] }
];

for (const row of STAY_LIVE) {
  const text = fixture(row.lines);
  if (!text) {
    check(false, `${row.id}: fixture built`, 'the invocation line was not replaced');
    continue;
  }
  const { found, live } = readFixture(text);
  check(
    live.length === 1,
    `${row.id}: ${row.what} — STILL live`,
    live.length === 1
      ? `ci.yml:${live[0].line}`
      : `${live.length} live — the \`&&\` rule is over-blocking: ${found
          .map((f) => `${f.position}${f.disabled.length ? ` (${f.disabled[0]})` : ''}`)
          .join('; ')}`
  );
}

// ---------------------------------------------------------------------------
// 3c. The `&&` rule against real bash, over a GENERATED chain space.
//
// WHY THIS SECTION EXISTS, and it is the review finding on this PR rather than
// foresight. §3b's four rows all put the `&&` first, so none of them reached
// `a || false && x`. That chain groups as `(a || false) && x` — `&&` and `||`
// are left-associative with equal precedence — so when `a` succeeds, `false`
// never runs and `x` DOES. The first version of this rule asked whether the
// adjacent operand could succeed rather than whether the CHAIN could, and
// reported `x` as dead by name. Fail-closed, so nothing could sneak past, but
// the reason string was false about a real operand — and a wrong explanation
// costs more than no explanation, which is the same defect §2's pin is about.
//
// HAND-PICKED ROWS ARE WHAT MISSED IT, so this does not add three more of them.
// It generates every chain over `true`, `false` and `exit 1` up to three
// operands deep, joined by every combination of `&&` and `||`, ending in a
// marker command — 258 chains — runs each through REAL BASH, and compares.
//
// THE INVARIANT IS ONE-DIRECTIONAL, deliberately. The parser may say a command
// runs when bash does not: it only ever blocks on what it can PROVE, and
// `cannotSucceed` knows about exactly `false` and a non-zero `exit`. What it
// must NEVER do is claim a command "never runs" when bash runs it. That is the
// direction the review finding was in, and it is what this asserts.
// ---------------------------------------------------------------------------

console.log('\n=== 3c. Every && / || chain to depth 3, against real bash ===\n');

const MARKER = 'KAN354_RAN';
const BLOCK_REASON = 'which cannot succeed, so it never runs';

bashDifferential: {
  const probe = spawnSync('bash', ['-c', `echo ${MARKER}`], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !probe.stdout.includes(MARKER)) {
    check(
      false,
      'NOT RUN — bash is unavailable, so this section asserted nothing',
      'this is not a pass. The chain space is unverified on this machine'
    );
    break bashDifferential;
  }

  const OPERANDS = ['true', 'false', 'exit 1'];
  const OPS = ['&&', '||'];
  const chains = [];
  for (let depth = 1; depth <= 3; depth += 1) {
    const build = (parts, ops) => {
      if (parts.length === depth) {
        for (const tail of OPS) {
          chains.push({ text: parts.map((p, i) => (i ? `${ops[i - 1]} ${p}` : p)).join(' ') + ` ${tail} echo ${MARKER}` });
        }
        return;
      }
      for (const p of OPERANDS) {
        if (!parts.length) build([p], []);
        else for (const op of OPS) build([...parts, p], [...ops, op]);
      }
    };
    build([], []);
  }

  let compared = 0;
  let blockedCount = 0;
  const wrong = [];

  for (const c of chains) {
    const ran = spawnSync('bash', ['-c', c.text], { encoding: 'utf8' }).stdout.includes(MARKER);

    const a = analyzeRunBody(`${c.text}\n`);
    if (a.parseError) {
      wrong.push(`${c.text} — parseError ${a.parseError}`);
      continue;
    }
    const cls = a.classify(c.text.indexOf(`echo ${MARKER}`));
    const saysNeverRuns =
      cls.kind === 'command' && (cls.reasons ?? []).some((r) => r.includes(BLOCK_REASON));

    compared += 1;
    if (saysNeverRuns) blockedCount += 1;
    // The one-directional invariant: never claim "never runs" about something
    // bash runs. The converse — bash not running it while the parser stays
    // quiet — is the conservative direction and is allowed.
    if (saysNeverRuns && ran) wrong.push(`${c.text} — parser says it never runs; bash RAN it`);
  }

  check(
    compared === chains.length,
    `(setup) every generated chain parsed and was compared`,
    `${compared}/${chains.length}`
  );
  check(
    blockedCount > 0,
    '(vacuity) the `&&` rule fired on some of them — a rule that blocked nothing would pass this section trivially',
    `${blockedCount} of ${compared} chains reported "never runs"`
  );
  check(
    wrong.length === 0,
    'NO chain is reported "never runs" while bash runs it',
    wrong.length === 0
      ? `${compared} chains agree with bash in the direction that matters`
      : `${wrong.length} disagreement(s): ${wrong.slice(0, 5).join(' | ')}`
  );
}

// ---------------------------------------------------------------------------
// 4. RED DRIVE A — starve the widening.
//
// Put `skipParens(text, i + 2)` back and require §1, §2 and §3's parse
// assertions to fail. This is the direction that proves the fix is what makes
// them green, rather than something that was always true.
// ---------------------------------------------------------------------------

console.log('\n=== 4. RED DRIVE A: the widening starved — arithmetic unreadable again ===\n');

starveA: {
  const mutant = mutator.mutateScript(
    'starve-arithmetic',
    PARSER,
    [
      {
        find: '§1b asserts it.\n        const e = skipParens(text, i + 1);',
        replace: '§1b asserts it.\n        const e = skipParens(text, i + 2);'
      }
    ]
  );
  if (!mutant) break starveA;

  const old = await import(`file://${mutant}`);

  const a = old.analyzeRunBody(REPRO);
  check(
    a.parseError !== null,
    'STARVED: the reproduction no longer parses — §1 goes red',
    a.parseError ? `parseError: ${a.parseError}` : 'it STILL parses, so §1 was not measuring the fix'
  );

  const starvedShapes = SHAPES.filter((s) => old.analyzeRunBody(s.text).parseError !== null);
  check(
    starvedShapes.length === 4,
    'STARVED: exactly the four unquoted-arithmetic shapes break, and the three that parsed before KAN-354 still parse',
    `${starvedShapes.length} broke: ${starvedShapes.map((s) => s.what).join('; ')}`
  );

  const { live } = (() => {
    const found = old.findRunInvocations(WITH_ARITHMETIC, NEEDLE);
    return { live: found.filter((f) => f.position === 'command' && f.disabled.length === 0) };
  })();
  check(
    live.length === 0,
    'STARVED: §2\'s live invocation is lost — the whole block reads as unreadable',
    live.length === 0 ? 'not live, exactly as KAN-331 met it' : 'still live, so §2 proves nothing'
  );

  // Which §3 rows the starvation actually reaches — and the three it does NOT,
  // which is a limit of the fixture set rather than a result, so it is asserted
  // by name rather than left to the count.
  //
  // `classify` answers comment, heredoc and `$( … )` from ranges the LEXER
  // recorded, BEFORE it looks at `parseError`. So for those three rows an
  // unreadable block changes nothing: they were never relying on the parse tree
  // to be not-live. Their §3 vacuity guard is therefore true for a reason that
  // has nothing to do with the fix, and cannot be starved this way. §5 is what
  // holds those rows, by breaking the lexical mechanism itself.
  const parseBorne = DISABLED.filter((r) => !r.lexical);
  const lexical = DISABLED.filter((r) => r.lexical);

  const starvedUnreadable = DISABLED.filter((row) => {
    const text = builtDisabled.get(row.id);
    return text && !blockParses(text, old);
  }).map((r) => r.id);

  check(
    starvedUnreadable.length === parseBorne.length &&
      parseBorne.every((r) => starvedUnreadable.includes(r.id)),
    'STARVED: every parse-borne §3 fixture reports its block unreadable — those vacuity guards go red',
    `${starvedUnreadable.length}/${parseBorne.length}: ${starvedUnreadable.join(', ')}`
  );

  check(
    lexical.every((r) => !starvedUnreadable.includes(r.id)),
    `STARVED: and the ${lexical.length} lexically-classified rows are UNAFFECTED, as they must be`,
    lexical.map((r) => `${r.id} — ${r.lexical}`).join('; ')
  );
}

// ---------------------------------------------------------------------------
// 5. RED DRIVE B — make it swallow what it should refuse.
//
// §4 cannot red-drive §3's real claim. Starving the lexer makes the block
// unreadable, and an unreadable block yields no live commands — so every "not
// live" row would stay green for the wrong reason. The only way to show those
// rows CAN be false is to break the disabler itself, one at a time.
//
// THREE DIFFERENT MECHANISMS, not three spellings of one: the lexer's comment
// detection, the `&&` short-circuit added by KAN-354, and the `|| …` swallow
// inherited from KAN-141.
// ---------------------------------------------------------------------------

console.log('\n=== 5. RED DRIVE B: each disabler broken in turn — §3 goes red ===\n');

const SWALLOW = [
  {
    id: 'comment',
    mechanism: 'the lexer records an EMPTY comment span and skips only the `#`',
    // Deliberately not `if (false && c === '#' …)`. That mutation was tried
    // first and does NOT make the row go live: with `#` left as an ordinary
    // word it becomes the command NAME, so the invocation after it reads as an
    // argument — not-live for a different reason, which would have been a red
    // that credited the wrong mechanism. Emptying the recorded span is the
    // mutation that removes the disabler and nothing else.
    find: '      comments.push([i, end]);\n      i = end;',
    replace: '      comments.push([i, i]);\n      i += 1;'
  },
  {
    id: 'false-and',
    mechanism: 'the `&&` short-circuit added by KAN-354 is removed',
    find: '          if (!canSucceed) blockedBy[k] = k - 1;',
    replace: '          if (false && !canSucceed) blockedBy[k] = k - 1;'
  },
  {
    id: 'or-true',
    mechanism: 'the `|| …` swallow inherited from KAN-141 is removed',
    find: '        if (next && next.op === \'||\' && !cannotSucceed(next.node)) {',
    replace: '        if (false && next && next.op === \'||\' && !cannotSucceed(next.node)) {'
  }
];

for (const s of SWALLOW) {
  swallow: {
    const mutant = mutator.mutateScript(`swallow-${s.id}`, PARSER, [{ find: s.find, replace: s.replace }]);
    if (!mutant) break swallow;

    const broken = await import(`file://${mutant}`);
    const text = builtDisabled.get(s.id);
    if (!text) {
      check(false, `MUTANT ${s.id}: its §3 fixture exists to be re-read`, 'the fixture was never built');
      break swallow;
    }

    // The mutant must still PARSE the block — otherwise the row would go red
    // because the reader gave up, which is §4's mechanism, not this one.
    check(
      blockParses(text, broken),
      `MUTANT ${s.id}: the block still parses, so the red below is the disabler and not a parse failure`,
      s.mechanism
    );

    const found = broken.findRunInvocations(text, NEEDLE);
    const live = found.filter((f) => f.position === 'command' && f.disabled.length === 0);
    check(
      live.length > 0,
      `MUTANT ${s.id}: with ${s.mechanism}, the disabled command reads as LIVE — §3's row goes red`,
      live.length > 0
        ? `LIVE at ci.yml:${live.map((f) => f.line).join(', ')}`
        : 'it did NOT go live — this row of §3 cannot be made false by breaking its own disabler, ' +
          'so it is not measuring what it claims'
    );
  }
}

// ---------------------------------------------------------------------------
// 5b. RED DRIVE for §3c — reinstate the bug the review found.
//
// §5's `false-and` mutation starves the blocking entirely, which makes §3 go
// red and leaves §3c green: a rule that blocks NOTHING never claims anything
// "never runs", so it cannot disagree with bash in the direction §3c watches.
// §3c therefore needs the opposite mutation — the ORIGINAL defect, which asked
// whether the adjacent operand could succeed instead of whether the chain
// could. Restoring it must make §3c report disagreements, or §3c is not the
// thing that would have caught the review finding.
// ---------------------------------------------------------------------------

console.log('\n=== 5b. RED DRIVE: the reviewed defect reinstated — §3c must go red ===\n');

chainBug: {
  const mutant = mutator.mutateScript(
    'chain-asks-about-the-part',
    PARSER,
    [
      {
        find: '          canSucceed = canSucceed || partCanSucceed;',
        replace: '          canSucceed = partCanSucceed;'
      }
    ]
  );
  if (!mutant) break chainBug;

  const buggy = await import(`file://${mutant}`);
  const probe = spawnSync('bash', ['-c', `echo ${MARKER}`], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    check(false, 'NOT RUN — bash is unavailable, so this red drive asserted nothing', 'not a pass');
    break chainBug;
  }

  // The chain the review found, plus the one that must keep blocking either way.
  const cases = [
    { text: `true || false && echo ${MARKER}`, mustRun: true },
    { text: `true || exit 1 && echo ${MARKER}`, mustRun: true },
    { text: `false || false && echo ${MARKER}`, mustRun: false }
  ];

  const falseDeaths = [];
  let stillBlocksTheRightOne = false;

  for (const c of cases) {
    const ran = spawnSync('bash', ['-c', c.text], { encoding: 'utf8' }).stdout.includes(MARKER);
    const cls = buggy.analyzeRunBody(`${c.text}\n`).classify(c.text.indexOf(`echo ${MARKER}`));
    const saysNeverRuns =
      cls.kind === 'command' && (cls.reasons ?? []).some((r) => r.includes(BLOCK_REASON));

    check(ran === c.mustRun, `(setup) bash ${c.mustRun ? 'RUNS' : 'does not run'} \`${c.text}\``, `ran=${ran}`);
    if (saysNeverRuns && ran) falseDeaths.push(c.text);
    if (saysNeverRuns && !ran) stillBlocksTheRightOne = true;
  }

  check(
    falseDeaths.length === 2,
    'REINSTATED: the buggy rule calls two chains dead that bash runs — §3c\'s invariant goes red',
    falseDeaths.length
      ? falseDeaths.map((t) => `\`${t}\``).join(' and ')
      : 'it did NOT — §3c would not have caught the defect this section reproduces'
  );
  check(
    stillBlocksTheRightOne,
    '…while `false || false && …` stays blocked under both rules, so the mutation is not just "block nothing"',
    'a mutation that merely disabled the rule would pass §3c trivially'
  );
}

// ---------------------------------------------------------------------------
const skipped = mutator.mutationsSkipped();
console.log('');
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY: ${skipped.join(', ')} — those sections did not run.`);
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
