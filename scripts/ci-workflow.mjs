// A narrow reader for .github/workflows/ci.yml, shared by the two checks that
// assert something about CI's own wiring.
//
// WHY IT EXISTS. Round 1 of KAN-141 shipped both of those assertions as a
// regex over the raw file text — and text is not execution. Two one-line edits
// left the text intact, the step dead, and both checks passing:
//
//     # TODO restore: - run: node scripts/verify-proof-registry.mjs
//
//     proof-registry:
//       if: false
//
// The first was worse than useless: the check reported PASS and cited the
// comment's own line number as evidence that the step existed.
//
// Neither edit is sabotage-shaped. Commenting a job out to iterate faster and
// forgetting to restore it is an ordinary Tuesday, and `if: false` is what
// somebody reaches for to skip a job once. A guard that survives only
// well-intentioned edits is not a guard.
//
// Rounds 2, 3 and 4 of KAN-141 then closed `continue-on-error`, the shell's
// exit-code laundering (`|| true`, `set +e`, `; true`, a bare pipe, a trailing
// `exit 0`, backgrounding) and the six MENTION shapes (`echo "node …"`,
// `bash -c '…'`, a `timeout` wrapper) where the needle appeared inside a
// command rather than as one.
//
// FOUR TIMES IN THAT ONE CHANGE THE CODE FIXED A MEMBER AND THE PROSE
// ASSERTED THE CATEGORY — the fourth introduced as the correction to the
// third. The lesson, which is this file's reason for being this long: THE
// SENTENCE DESCRIBING WHAT A GUARD COVERS IS ITSELF A CLAIM, and it needs the
// same standard of proof as the guard. WHEN YOU WRITE "SO X CAN NO LONGER
// HAPPEN," GO AND MAKE X HAPPEN. If it still can, the sentence describes your
// intent rather than your code.
//
// And the reason it is worth prose that changes no behaviour: A GUARD THAT
// DOCUMENTS A PROTECTION IT DOES NOT HAVE IS WORSE THAN ONE THAT STAYS QUIET.
// Silence makes a reader check; a false assurance makes them not bother, and
// the construct they would then ship is the exact one the sentence exonerated.
//
// WHAT KAN-148 CHANGED: PER-BLOCK, NOT PER-LINE.
//
// Every round above reasoned about the invocation's OWN LINE, plus the run
// block's last line. So any shell construct whose gating context lived on
// another line of the block was invisible, and eight shapes ran nothing while
// both guards reported exit 0:
//
//     if [ "$SKIP_AUDIT" != 1 ]; then      (                       cat <<EOF
//       node scripts/…                       node scripts/…          node scripts/…
//     fi                                   ) || true               EOF
//
//     node scripts/… \        echo $(node scripts/…)      out=$(node scripts/…)
//       || true               audit() { node scripts/…; } # never called
//                             trap "exit 0" EXIT; node scripts/…
//
// The multi-line `if` is the worst of them, and not because it is clever: a
// `SKIP_AUDIT` guard added while iterating on CI and then forgotten is the
// same species of edit as `|| true`, which everything above calls the likeliest
// to happen by accident. Every shape KAN-141 closed was a deliberate evasion.
// That one is a Tuesday afternoon. The multi-line subshell is worse in a
// different way: the ONE-LINE `(node …) || true` was caught and the same
// construct across three lines was not, so re-formatting — what a linter does —
// was enough to open it.
//
// Patching those two shapes would have produced a ninth. So the run value is
// now LEXED AND PARSED AS SHELL, once, as a whole block: quotes, escapes, line
// continuations, comments, heredocs, command substitutions, pipelines,
// `&&`/`||` lists, `if`/`while`/`until`/`for`/`case`, brace groups, subshells
// and function definitions. A match counts as LIVE only when it is the command
// name of a simple command that sits at the TOP LEVEL of the block — inside no
// construct whose execution is conditional and no context whose exit status is
// discarded — in a step and job that carry no `if:` and no
// `continue-on-error: true`.
//
// Everything else is reported as WHICH kind of not-live it is, because those
// are each more misleading than an absent invocation and a reader who is told
// "not found" over a file that visibly contains the string goes looking in the
// wrong place:
//
//   position 'command'  — the command name of a top-level simple command.
//                         `disabled` then holds the reasons its exit status
//                         still does not reach the build, if any.
//   position 'nested'   — a real command, but buried: a conditional or loop
//                         body, an `if` condition, a `case` arm, a function
//                         body, a `$( … )` substitution. `note` names which.
//   position 'argument' — not a command at all: quoted, an argument to
//                         something else, or a heredoc body. `note` names
//                         which.
//
// A caller wanting proof that something runs must require position 'command'
// AND an empty `disabled`. A new not-live shape therefore fails closed by
// construction: it cannot become position 'command', so it cannot read as
// coverage.
//
// WHAT IT DELIBERATELY DOES NOT ANSWER — the boundaries, on the record. These
// are decisions, not oversights, and the point of writing them down is that a
// gap a reader is warned about is a boundary while an undisclosed one is a
// defect.
//
//   1. Whether the job is a REQUIRED context in branch protection. That lives
//      in repository settings rather than in the tree; nothing in here can see
//      it, so nothing in here pretends to. A live step proves the check runs
//      and can go red, not that a red one blocks a merge.
//
//   2. Whether the workflow is triggered at all. `on: workflow_dispatch` or
//      `paths-ignore: ['**']` would stop ci.yml running on a PR, and every
//      check in here would still pass. That hole is closed OUTSIDE the
//      repository and is closed better there: typecheck, build and verify are
//      required contexts, so a workflow that never runs leaves them pending
//      and GitHub blocks the merge. A check in the tree asserting its own
//      trigger would be the weaker of the two controls, and duplicating a
//      control that already works is how the weaker one comes to be trusted.
//
//   3. THINGS THAT READ AS NOT-LIVE THOUGH THEY GENUINELY RUN. Every one of
//      these fails CLOSED — it turns the guards red and makes somebody edit
//      the workflow or this file — and every one is a place where the answer
//      is "that should be a reviewed edit, not an inference":
//
//        `out=$(node x.mjs)`     Under `set -e` an assignment DOES take the
//                                substitution's exit status, so this really
//                                can gate. It is still refused: capturing a
//                                proof's output is a deliberate shape and the
//                                reader should have to say so.
//        a called function       A function body is not live where it is
//                                defined. Whether it is called is a question
//                                this does not ask, so `audit() { node …; }`
//                                followed by `audit` reads as not-live.
//        `timeout 60 node x`     A wrapper on the command line is not at
//        `xvfb-run node x`       command position, so it reads as ABSENT. A
//        `bash -c 'node x'`      wrapper changes what the exit status means.
//        `env -i node x`         `env` is admitted only when what follows it
//                                is assignments and then the command.
//        an unparsable block     A run value this lexer cannot parse yields no
//                                live commands at all, and says so by name.
//        `shell:` other than     Only `bash` and `sh` are read as shell.
//        bash/sh                 Anything else is reported, not guessed at —
//                                from the step's own `shell:`, and from a
//                                `defaults: { run: { shell: … } }` on the job
//                                or the workflow, which sets it for steps that
//                                do not say. Reading only the step's own key
//                                would have believed a `defaults:` shell to be
//                                bash.
//
//      ADMITTED, and new with KAN-148 because the old false alarm was noise
//      and a guard that cries wolf is a guard someone eventually weakens:
//      leading assignments (`FOO=1 node x`), and the transparent prefixes
//      `time`, `env`, `exec` and `command`, all of which pass the exit status
//      straight through.
//
//   4. THINGS FLAGGED THOUGH THEY MAY WELL GATE — conservative in the loud
//      direction, and inherited deliberately from KAN-141 rather than quietly
//      relaxed. GitHub's default shell is `bash -e {0}`, under which a failure
//      aborts the step immediately, so a later `; true` or a trailing `exit 0`
//      never runs and swallows nothing. They are still reported, because the
//      step reads like its result is being discarded and that is worth an
//      edit. Likewise `set +e` anywhere in the block flags every command in
//      it, even one before a later `set -e`; and a `trap … EXIT` that runs
//      `exit 0` flags commands that precede its registration.
//
//   5. EXIT-CODE LAUNDERING THIS STILL CANNOT SEE. A `trap` whose action does
//      not literally contain `exit 0` — `trap cleanup EXIT` where `cleanup`
//      exits 0 — is not flagged. Neither is a wrapper SCRIPT (`./audit.sh`)
//      whose own exit code is 0 whatever it ran, nor anything a composite
//      `uses:` action does inside itself. Nothing here claims the set is
//      exhaustive; what IS asserted is enumerated in this file and
//      demonstrated by mutation in scripts/verify-ci-wiring-guards.mjs, which
//      breaks each one deliberately and watches both guards go red.
//
// This is not a YAML parser and does not want to be. It reads the two levels
// of structure these checks depend on and is honest about a shape it does not
// recognise: an unreadable job contributes no live steps, which fails the
// checks that use it rather than silently satisfying them.

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');

/**
 * Index just past a block owned by the header at `headerIdx`: the first later
 * line indented no deeper than the header. Blank and comment lines are skipped
 * rather than ending a block, so a comment between two steps does not truncate
 * the first one.
 */
function blockEnd(lines, headerIdx, headerIndent, limit = lines.length) {
  for (let j = headerIdx + 1; j < limit; j += 1) {
    const l = lines[j];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= headerIndent) return j;
  }
  return limit;
}

/** Mapping keys at exactly `indent`, as key -> { idx, value }. */
function keysAt(lines, from, to, indent) {
  const re = new RegExp(`^\\s{${indent}}([A-Za-z0-9_-]+):\\s*(.*)$`);
  const out = new Map();
  for (let i = from; i < to; i += 1) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) !== indent) continue;
    const m = re.exec(l);
    if (m) out.set(m[1], { idx: i, value: m[2].trim() });
  }
  return out;
}

/** The steps of one job: list items directly under its `steps:` key. */
function readSteps(lines, jobFrom, jobTo) {
  const steps = keysAt(lines, jobFrom, jobTo, 4).get('steps');
  if (!steps) return [];
  const stepsEnd = blockEnd(lines, steps.idx, 4, jobTo);
  const out = [];
  let stepIndent = -1;
  for (let i = steps.idx + 1; i < stepsEnd; i += 1) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (!l.trimStart().startsWith('- ')) continue;
    const ind = indentOf(l);
    if (stepIndent < 0) stepIndent = ind;
    // A deeper `- ` belongs to some nested sequence inside a step, not to the
    // steps list.
    if (ind !== stepIndent) continue;
    out.push({ headerIdx: i, end: blockEnd(lines, i, stepIndent, stepsEnd), indent: stepIndent });
  }
  return out;
}

/** One step's own keys, including the one written inline after the `- `. */
function stepKeys(lines, step) {
  const out = new Map();
  const head = lines[step.headerIdx].trimStart().slice(2);
  const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(head);
  if (m) out.set(m[1], { idx: step.headerIdx, value: m[2].trim() });
  for (const [k, v] of keysAt(lines, step.headerIdx + 1, step.end, step.indent + 2)) out.set(k, v);
  return out;
}

/** Jobs of a workflow, each with its own keys and its steps. */
export function readJobs(text) {
  const lines = text.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsIdx < 0) return { lines, jobs: [] };
  const jobsEnd = blockEnd(lines, jobsIdx, 0);
  const jobs = [];
  for (let i = jobsIdx + 1; i < jobsEnd; i += 1) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) !== 2) continue;
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(l);
    if (!m) continue;
    const end = blockEnd(lines, i, 2, jobsEnd);
    jobs.push({
      id: m[1],
      line: i + 1,
      from: i + 1,
      to: end,
      keys: keysAt(lines, i + 1, end, 4),
      steps: readSteps(lines, i + 1, end)
    });
    i = end - 1;
  }
  return { lines, jobs };
}

/**
 * `if:` expressions that do NOT disable the thing they guard.
 *
 * Any `if:` reads as a disabler, so a legitimate one — `if: always()`, say —
 * turns these checks red. That is the right direction to fail: a guard that
 * tried to evaluate GitHub's expression language would be guessing, and a
 * wrong guess here reads as coverage. So a benign `if:` is admitted by name,
 * reviewed like code, rather than inferred.
 *
 * Match is on the expression text exactly as written. Empty on purpose: no
 * job in this workflow needs one yet.
 */
export const BENIGN_IF = [];

/** How a reader is told to get out of a red `if:` check, quoted in the message. */
const IF_ESCAPE = 'if this `if:` is legitimate, add its exact text to BENIGN_IF in scripts/ci-workflow.mjs';

/** Shells whose text the lexer below is a reader for. Anything else is refused. */
const KNOWN_SHELLS = new Set(['bash', 'sh', "'bash'", '"bash"', "'sh'", '"sh"']);

/**
 * `defaults: { run: { shell: … } }`, which sets the shell for every step that
 * does not name one. Read at both the workflow and the job level, because a
 * check that looked only at the step's own `shell:` would read a `defaults:`
 * of `pwsh` as bash and then lex PowerShell as if it were a POSIX shell.
 *
 * `from`/`to` bound the mapping this belongs to and `indent` is that mapping's
 * key indent: 0 for the workflow, 4 for a job.
 */
function defaultsRunShell(lines, from, to, indent) {
  const defaults = keysAt(lines, from, to, indent).get('defaults');
  if (!defaults) return undefined;
  const defaultsEnd = blockEnd(lines, defaults.idx, indent, to);
  const run = keysAt(lines, defaults.idx + 1, defaultsEnd, indent + 2).get('run');
  if (!run) return undefined;
  const runEnd = blockEnd(lines, run.idx, indent + 2, defaultsEnd);
  return keysAt(lines, run.idx + 1, runEnd, indent + 4).get('shell');
}

/**
 * The reasons a command that textually exists will not fail the build, taken
 * from the step's and the job's own YAML keys.
 *
 *   NEVER RUNS   — `if:` or `continue-on-error:` on the job or the step.
 *   NOT READ     — a `shell:` this file does not model. Reading a `python`
 *                  step as bash would be guessing, and a wrong guess here
 *                  reads as coverage.
 */
function keyDisablers(jobId, jobKeys, keys, inheritedShell) {
  const out = [];
  const truthy = (v) => v !== undefined && /^(true|'true'|"true")$/i.test(String(v.value));
  const benign = (v) => BENIGN_IF.includes(String(v.value).trim());
  if (jobKeys.has('if') && !benign(jobKeys.get('if'))) {
    out.push(`job \`${jobId}\` carries \`if: ${jobKeys.get('if').value}\` — ${IF_ESCAPE}`);
  }
  if (truthy(jobKeys.get('continue-on-error'))) out.push(`job \`${jobId}\` carries \`continue-on-error: true\``);
  if (keys.has('if') && !benign(keys.get('if'))) {
    out.push(`the step carries \`if: ${keys.get('if').value}\` — ${IF_ESCAPE}`);
  }
  if (truthy(keys.get('continue-on-error'))) out.push('the step carries `continue-on-error: true`');
  // The step's own `shell:` wins; otherwise the nearest `defaults.run.shell`.
  const own = keys.get('shell');
  const shell = own ?? inheritedShell;
  if (shell && !KNOWN_SHELLS.has(String(shell.value).trim())) {
    out.push(
      `the step ${own ? 'declares' : 'inherits'} \`shell: ${shell.value}\`, which this reader does not ` +
        'model — it reads `bash` and `sh` only, and will not guess at anything else'
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run value, as one block of shell text.
//
// Two YAML forms, and the difference between them is load-bearing for the line
// continuation in KAN-148's shape 3:
//
//   BLOCK SCALAR (`run: |`)   lines are joined with newlines, so a trailing
//                             `\` really is a shell line continuation.
//   PLAIN SCALAR (`run: x`)   a multi-line plain scalar is FOLDED by YAML —
//                             the newline becomes a space before bash ever
//                             sees it. `node x \` + `|| true` therefore
//                             reaches bash as `node x \ || true`, where `\ `
//                             is an escaped space that becomes a stray
//                             argument and the `|| true` is still a real
//                             operator. Either way the exit status is
//                             swallowed, and the lexer below reports it
//                             from the text it was actually given.
//
// Block scalars are dedented by their common indent rather than per-line
// trimmed, because a heredoc terminator has to sit at column 0 of the block
// and `<<-` strips tabs relative to it.
// ---------------------------------------------------------------------------

function readRunBody(lines, step, run) {
  const pieces = [];
  const isBlock = !run.value || /^[|>]/.test(run.value);
  // `|` keeps its newlines; `>` FOLDS them into spaces before bash sees them,
  // which is the same thing a multi-line plain scalar does. Reading a folded
  // block as if it were literal would put a newline where YAML puts a space
  // and turn `node x` / `|| true` into two commands, the second of which does
  // not parse — fail-closed, but for the wrong reason and with a message
  // about unparsable shell rather than about a swallowed exit.
  const folded = !isBlock || /^>/.test(run.value);

  const bodyLines = [];
  if (!isBlock) bodyLines.push({ idx: run.idx, raw: run.value });
  for (let i = run.idx + 1; i < step.end; i += 1) {
    if (isBlank(lines[i])) {
      if (bodyLines.length) bodyLines.push({ idx: i, raw: '' });
      continue;
    }
    if (indentOf(lines[i]) <= step.indent + 2) break;
    bodyLines.push({ idx: i, raw: lines[i] });
  }
  while (bodyLines.length && bodyLines[bodyLines.length - 1].raw.trim() === '') bodyLines.pop();

  let text = '';
  if (isBlock && !folded) {
    const indents = bodyLines.filter((l) => l.raw.trim() !== '').map((l) => indentOf(l.raw));
    const base = indents.length ? Math.min(...indents) : 0;
    for (const l of bodyLines) {
      const body = l.raw.trim() === '' ? '' : l.raw.slice(base);
      pieces.push({ line: l.idx + 1, start: text.length, end: text.length + body.length });
      text += `${body}\n`;
    }
  } else if (isBlock) {
    // `run: >` — folded. Each line contributes its trimmed text, joined by the
    // single space YAML folds the newline into.
    bodyLines.forEach((l, n) => {
      const body = l.raw.trim();
      if (n > 0) text += ' ';
      pieces.push({ line: l.idx + 1, start: text.length, end: text.length + body.length });
      text += body;
    });
  } else {
    // A plain scalar: its first line is the value after `run:`, and any
    // continuation lines are folded onto it with a single space.
    bodyLines.forEach((l, n) => {
      const body = n === 0 ? l.raw : l.raw.trim();
      if (n > 0) text += ' ';
      pieces.push({ line: l.idx + 1, start: text.length, end: text.length + body.length });
      text += body;
    });
  }

  const lineFor = (offset) => {
    let best = pieces.length ? pieces[0].line : run.idx + 1;
    for (const p of pieces) {
      if (offset >= p.start) best = p.line;
      else break;
    }
    return best;
  };
  return { text, lineFor };
}

// ---------------------------------------------------------------------------
// The shell lexer.
//
// It produces three things the classifier needs: a token stream for the
// parser, and the byte ranges of the regions that are not shell commands at
// all — comments, heredoc bodies, command substitutions and quoted text. A
// needle landing in one of those is reported as that kind of not-live rather
// than as "absent", because "not found" over a file that visibly contains the
// string sends a reader looking in the wrong place.
// ---------------------------------------------------------------------------

class ShellParseError extends Error {}

/** Index just past the `(…)` region opened by the `(` at `i`. */
function skipParens(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = text.indexOf("'", i + 1); i = e < 0 ? text.length : e + 1; continue; }
    if (c === '"') { i = skipDoubleQuote(text, i); continue; }
    if (c === '(') { depth += 1; i += 1; continue; }
    if (c === ')') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  return text.length;
}

/** Index just past the `"…"` opened at `i`. */
function skipDoubleQuote(text, i) {
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    if (text[i] === '$' && text[i + 1] === '(') { i = skipParens(text, i + 1); continue; }
    if (text[i] === '`') { i = skipBackticks(text, i); continue; }
    i += 1;
  }
  return text.length;
}

/** Index just past the backtick substitution opened at `i`. */
function skipBackticks(text, i) {
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return i + 1;
    i += 1;
  }
  return text.length;
}

/** Index just past the `${…}` opened by the `{` at `i`. */
function skipBraces(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  return text.length;
}

const TWO_CHAR_OPS = ['&&', '||', ';;', '|&', '>>', '>&', '<&', '&>'];

function lexShell(text) {
  const tokens = [];
  const comments = [];
  const heredocs = [];
  const substitutions = [];
  const quotes = [];
  const pending = [];
  let i = 0;
  let word = null;

  const endWord = () => {
    if (!word) return;
    word.end = i;
    word.raw = text.slice(word.start, i);
    tokens.push(word);
    word = null;
  };
  const ensureWord = () => {
    if (!word) word = { type: 'word', start: i, text: '', quoted: false };
  };
  const pushOp = (op, len) => {
    endWord();
    tokens.push({ type: 'op', op, start: i, end: i + len });
    i += len;
  };

  while (i < text.length) {
    const c = text[i];

    if (c === '\\' && text[i + 1] === '\n') { i += 2; continue; }
    if (c === '\\') { ensureWord(); word.text += text[i + 1] ?? ''; i += 2; continue; }

    if (c === '\n') {
      pushOp('\n', 1);
      while (pending.length) {
        const h = pending.shift();
        const bodyStart = i;
        let bodyEnd = text.length;
        let j = i;
        for (;;) {
          if (j >= text.length) { bodyEnd = text.length; i = text.length; break; }
          const nl = text.indexOf('\n', j);
          const lineEnd = nl < 0 ? text.length : nl;
          let line = text.slice(j, lineEnd);
          if (h.strip) line = line.replace(/^\t+/, '');
          if (line.trimEnd() === h.delim) { bodyEnd = j; i = nl < 0 ? text.length : nl + 1; break; }
          if (nl < 0) { bodyEnd = text.length; i = text.length; break; }
          j = nl + 1;
        }
        heredocs.push([bodyStart, bodyEnd]);
      }
      continue;
    }

    if (/\s/.test(c)) { endWord(); i += 1; continue; }

    // A `#` begins a comment only where a word could begin.
    if (c === '#' && !word) {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      comments.push([i, end]);
      i = end;
      continue;
    }

    if (text.startsWith('<<<', i)) { pushOp('<<<', 3); continue; }
    if (text.startsWith('<<', i)) {
      const strip = text[i + 2] === '-';
      let k = i + (strip ? 3 : 2);
      while (text[k] === ' ' || text[k] === '\t') k += 1;
      let delim = '';
      while (k < text.length && !/[\s;&|<>()]/.test(text[k])) {
        const ch = text[k];
        if (ch === "'" || ch === '"') {
          const e = ch === '"' ? skipDoubleQuote(text, k) : (text.indexOf("'", k + 1) < 0 ? text.length : text.indexOf("'", k + 1) + 1);
          delim += text.slice(k + 1, e - 1);
          k = e;
          continue;
        }
        if (ch === '\\') { delim += text[k + 1] ?? ''; k += 2; continue; }
        delim += ch;
        k += 1;
      }
      endWord();
      tokens.push({ type: 'op', op: '<<', start: i, end: k });
      pending.push({ delim, strip });
      i = k;
      continue;
    }

    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) { pushOp(two, 2); continue; }
    if ('();&|<>'.includes(c)) { pushOp(c, 1); continue; }

    if (c === "'") {
      ensureWord();
      word.quoted = true;
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      quotes.push([i, close < 0 ? text.length : close + 1]);
      word.text += text.slice(i + 1, end);
      i = close < 0 ? text.length : close + 1;
      continue;
    }

    if (c === '"') {
      ensureWord();
      word.quoted = true;
      const qStart = i;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { word.text += text[i + 1] ?? ''; i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '(') {
          const e = skipParens(text, i + 1);
          substitutions.push([i, e]);
          word.text += text.slice(i, e);
          i = e;
          continue;
        }
        if (text[i] === '`') {
          const e = skipBackticks(text, i);
          substitutions.push([i, e]);
          word.text += text.slice(i, e);
          i = e;
          continue;
        }
        word.text += text[i];
        i += 1;
      }
      quotes.push([qStart, Math.min(i + 1, text.length)]);
      i += 1;
      continue;
    }

    if (c === '$' && text[i + 1] === '(') {
      ensureWord();
      if (text[i + 2] === '(') {                       // $(( … )) is arithmetic, not a command
        // KAN-354: skip from the OUTER paren, not the inner one. `skipParens`
        // counts balanced parens from wherever it is pointed, so starting it at
        // `i + 2` consumed `( t1 - t0 )` and returned with the outer `)` still
        // unread — which lexed as a stray `)` operator and derailed the
        // enclosing `for`/`done` or `if`/`fi` pairing. The whole block then
        // failed to parse, and every command in it reported as not-live with a
        // message about the block rather than about the construct. Measured at
        // 5b5a200 by KAN-331 and again at 6cbe5bd9: `ms=$(( t1 - t0 ))` inside
        // a `for` loop gave ``expected `done` ``.
        //
        // Balanced counting from the outer paren is right for both readings of
        // `$((`: arithmetic, and the `$( (subshell) )` that POSIX requires a
        // space to write. It is deliberately NOT recorded in `substitutions` —
        // arithmetic runs no commands, so nothing inside it is a command that
        // could be mistaken for a live one.
        //
        // THE NEAREST LIMIT, measured rather than reasoned — the first draft of
        // this comment said an unterminated `$((` makes the block fail to
        // parse, and that is WRONG. `skipParens` runs to end-of-text, so
        // `ms=$(( t1 - t0` swallows the whole rest of the block into one word:
        // the block PARSES, as a single assignment, and anything after the
        // unterminated `$((` reads as `argument` — "an argument to another
        // command, not the command itself". Still fail-closed, since a caller
        // needs position 'command' with an empty `disabled`, but closed by
        // swallowing rather than by the unparsable-block row of boundary 3.
        // scripts/verify-arithmetic-expansion-is-read.mjs §1b asserts it.
        const e = skipParens(text, i + 1);
        word.text += text.slice(i, e);
        i = e;
        continue;
      }
      const e = skipParens(text, i + 1);
      substitutions.push([i, e]);
      word.text += text.slice(i, e);
      i = e;
      continue;
    }
    if (c === '`') {
      ensureWord();
      const e = skipBackticks(text, i);
      substitutions.push([i, e]);
      word.text += text.slice(i, e);
      i = e;
      continue;
    }
    if (c === '$' && text[i + 1] === '{') {
      ensureWord();
      const e = skipBraces(text, i + 1);
      word.text += text.slice(i, e);
      i = e;
      continue;
    }

    ensureWord();
    word.text += c;
    i += 1;
  }
  endWord();
  return { tokens, comments, heredocs, substitutions, quotes };
}

// ---------------------------------------------------------------------------
// The parser: a shell grammar deep enough to answer "does this command's exit
// status reach the step, on every run?".
//
//   list      := and_or ( (';' | '&' | newline | ';;') and_or )*
//   and_or    := pipeline ( ('&&' | '||') pipeline )*
//   pipeline  := ['!'] command ('|' command)*
//   command   := simple | if | while | until | for | select | case
//              | brace_group | subshell | function_def
// ---------------------------------------------------------------------------

const REDIRECT_OPS = new Set(['<', '>', '>>', '<<', '<<<', '>&', '<&', '&>']);
const SEPARATORS = new Set([';', '&', '\n', ';;']);

function parseShell(tokens) {
  let p = 0;

  const at = () => tokens[p];
  const done = () => p >= tokens.length;
  const isOp = (t, ...ops) => Boolean(t) && t.type === 'op' && ops.includes(t.op);
  const isWord = (t, w) => Boolean(t) && t.type === 'word' && !t.quoted && t.text === w;
  const span = (from, to) => ({
    start: tokens[from] ? tokens[from].start : 0,
    end: tokens[Math.max(from, to - 1)] ? tokens[Math.max(from, to - 1)].end : 0
  });

  const skipNewlines = () => { while (isOp(at(), '\n')) p += 1; };
  const expectWord = (w) => {
    skipNewlines();
    if (!isWord(at(), w)) throw new ShellParseError(`expected \`${w}\``);
    p += 1;
  };
  const eatRedirects = () => {
    while (!done() && at().type === 'op' && REDIRECT_OPS.has(at().op)) {
      p += 1;
      if (!done() && at().type === 'word') p += 1;
    }
  };

  function parseList(terms, stopAtDoubleSemi = false) {
    const from = p;
    const items = [];
    for (;;) {
      while (isOp(at(), '\n') || isOp(at(), ';')) p += 1;
      if (done()) break;
      const t = at();
      if (isOp(t, ')')) break;
      if (t.type === 'word' && !t.quoted && terms.has(t.text)) break;
      if (isOp(t, ';;')) break;

      const before = p;
      const node = parseAndOr(terms);
      if (p === before) throw new ShellParseError(`made no progress at \`${t.text ?? t.op}\``);

      let sep = null;
      if (!done() && at().type === 'op' && SEPARATORS.has(at().op)) {
        sep = at().op;
        p += 1;
      }
      items.push({ node, sep });
      if (sep === null) break;
      if (sep === ';;' && stopAtDoubleSemi) break;
    }
    return { type: 'list', items, ...span(from, p) };
  }

  function parseAndOr(terms) {
    const from = p;
    const parts = [{ op: null, node: parsePipeline(terms) }];
    while (isOp(at(), '&&') || isOp(at(), '||')) {
      const op = at().op;
      p += 1;
      skipNewlines();
      parts.push({ op, node: parsePipeline(terms) });
    }
    return { type: 'andor', parts, ...span(from, p) };
  }

  function parsePipeline(terms) {
    const from = p;
    let negated = false;
    while (isWord(at(), '!')) { negated = true; p += 1; skipNewlines(); }
    const stages = [parseCommand(terms)];
    while (isOp(at(), '|') || isOp(at(), '|&')) {
      p += 1;
      skipNewlines();
      stages.push(parseCommand(terms));
    }
    return { type: 'pipeline', negated, stages, ...span(from, p) };
  }

  function parseCommand(terms) {
    const from = p;
    const t = at();
    if (!t) throw new ShellParseError('unexpected end of block');

    if (isOp(t, '(')) {
      p += 1;
      const body = parseList(new Set());
      if (!isOp(at(), ')')) throw new ShellParseError('unterminated subshell');
      p += 1;
      eatRedirects();
      return { type: 'subshell', body, ...span(from, p) };
    }
    if (isWord(t, '{')) {
      p += 1;
      const body = parseList(new Set(['}']));
      expectWord('}');
      eatRedirects();
      return { type: 'group', body, ...span(from, p) };
    }
    if (isWord(t, 'if')) return parseIf(from);
    if (isWord(t, 'while') || isWord(t, 'until')) return parseLoop(from, t.text);
    if (isWord(t, 'for') || isWord(t, 'select')) return parseFor(from, t.text);
    if (isWord(t, 'case')) return parseCase(from);
    if (isWord(t, 'function')) {
      p += 1;
      if (at() && at().type === 'word') p += 1;
      if (isOp(at(), '(')) { p += 1; if (isOp(at(), ')')) p += 1; }
      skipNewlines();
      const body = parseCommand(terms);
      return { type: 'function', body, ...span(from, p) };
    }
    return parseSimple(from);
  }

  function parseIf(from) {
    p += 1;
    const branches = [];
    for (;;) {
      const cond = parseList(new Set(['then']));
      expectWord('then');
      const body = parseList(new Set(['elif', 'else', 'fi']));
      branches.push({ cond, body });
      skipNewlines();
      if (isWord(at(), 'elif')) { p += 1; continue; }
      break;
    }
    let otherwise = null;
    skipNewlines();
    if (isWord(at(), 'else')) { p += 1; otherwise = parseList(new Set(['fi'])); }
    expectWord('fi');
    eatRedirects();
    return { type: 'if', branches, otherwise, ...span(from, p) };
  }

  function parseLoop(from, keyword) {
    p += 1;
    const cond = parseList(new Set(['do']));
    expectWord('do');
    const body = parseList(new Set(['done']));
    expectWord('done');
    eatRedirects();
    return { type: 'loop', keyword, cond, body, ...span(from, p) };
  }

  function parseFor(from, keyword) {
    p += 1;
    while (!done() && !isWord(at(), 'do')) {
      if (isOp(at(), ';') || isOp(at(), '\n')) { p += 1; continue; }
      if (isOp(at(), '(')) { p += 1; continue; }
      if (isOp(at(), ')')) { p += 1; continue; }
      p += 1;
    }
    expectWord('do');
    const body = parseList(new Set(['done']));
    expectWord('done');
    eatRedirects();
    return { type: 'loop', keyword, cond: null, body, ...span(from, p) };
  }

  function parseCase(from) {
    p += 1;
    if (at() && at().type === 'word') p += 1;              // the word being matched
    skipNewlines();
    if (isWord(at(), 'in')) p += 1;
    const arms = [];
    for (;;) {
      while (isOp(at(), '\n') || isOp(at(), ';;')) p += 1;
      if (done()) throw new ShellParseError('unterminated `case`');
      if (isWord(at(), 'esac')) { p += 1; break; }
      if (isOp(at(), '(')) p += 1;
      while (!done() && !isOp(at(), ')')) p += 1;
      if (done()) throw new ShellParseError('unterminated `case` pattern');
      p += 1;
      arms.push(parseList(new Set(['esac']), true));
    }
    eatRedirects();
    return { type: 'case', arms, ...span(from, p) };
  }

  const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

  function parseSimple(from) {
    // `name ( )` followed by a body is a definition, and a definition runs
    // nothing where it stands. The name test is what keeps `failed=()` — an
    // empty array assignment, which ci.yml's own verify job uses — from being
    // read as a function whose body swallows everything after it.
    if (
      at() && at().type === 'word' && !at().quoted && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(at().text) &&
      isOp(tokens[p + 1], '(') && isOp(tokens[p + 2], ')')
    ) {
      p += 3;
      skipNewlines();
      const body = parseCommand(new Set());
      return { type: 'function', body, ...span(from, p) };
    }

    const words = [];
    while (!done()) {
      const t = at();
      if (t.type === 'op') {
        if (REDIRECT_OPS.has(t.op)) { eatRedirects(); continue; }
        // `name=( … )` is an array assignment, not a subshell.
        if (t.op === '(' && words.length && ASSIGNMENT.test(words[words.length - 1].raw) &&
            words[words.length - 1].raw.endsWith('=')) {
          let depth = 0;
          while (!done()) {
            if (isOp(at(), '(')) depth += 1;
            else if (isOp(at(), ')')) { depth -= 1; if (depth === 0) { p += 1; break; } }
            p += 1;
          }
          continue;
        }
        break;
      }
      words.push(t);
      p += 1;
    }
    if (!words.length) throw new ShellParseError(`unexpected \`${at() ? at().op : 'end of block'}\``);
    return { type: 'simple', words, ...span(from, p) };
  }

  const program = parseList(new Set());
  while (isOp(at(), '\n') || isOp(at(), ';')) p += 1;
  if (!done()) throw new ShellParseError(`unexpected \`${at().type === 'op' ? at().op : at().text}\``);
  return program;
}

// ---------------------------------------------------------------------------
// From the tree to a verdict per command.
// ---------------------------------------------------------------------------

/**
 * Words that stand in front of a command without taking its place: the exit
 * status of what follows passes straight through them.
 *
 * `env` and leading `FOO=1` assignments are new with KAN-148. They used to
 * read as not-live — a false alarm in the safe direction, but a guard that
 * cries wolf is a guard someone eventually weakens. `env -i node x` is still
 * refused, because only assignments may sit between `env` and the command.
 */
const TRANSPARENT_PREFIXES = new Set(['time', 'env', 'exec', 'command']);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/** The word that names what a simple command runs, past assignments and prefixes. */
function commandNameWord(node) {
  for (const w of node.words) {
    if (ASSIGNMENT_WORD.test(w.raw)) continue;
    if (!w.quoted && TRANSPARENT_PREFIXES.has(w.text)) continue;
    return w;
  }
  return null;
}

/**
 * The one simple command a node runs, when it runs exactly one unconditionally:
 * a list item that is one `and_or` of one un-negated pipeline of one stage.
 * Anything with an operator in it answers null, because then whether that
 * command runs depends on something else.
 */
function soleCommand(node) {
  let n = node;
  if (n && n.type === 'andor') {
    if (n.parts.length !== 1) return null;
    n = n.parts[0].node;
  }
  if (n && n.type === 'pipeline') {
    if (n.negated || n.stages.length !== 1) return null;
    n = n.stages[0];
  }
  return n && n.type === 'simple' ? n : null;
}

/**
 * A command that cannot finish with status 0, so putting it after `||` leaves
 * the failure it was reacting to still fatal: `node x || exit 1` REALLY DOES
 * gate the build, and flagging it would be a false alarm of exactly the kind
 * KAN-148 was asked to remove from `env FOO=1 node …`.
 *
 * `exit` with no argument is admitted for the same reason: in `a || exit` it
 * exits with `a`'s status, which is non-zero or the branch would not have been
 * taken. `exit 0` is NOT admitted, and neither is anything whose status this
 * cannot read off the source — a wrapper, a variable, a function.
 */
function cannotSucceed(node) {
  const cmd = soleCommand(node);
  if (!cmd) return false;
  const name = commandNameWord(cmd);
  if (!name || name.quoted) return false;
  if (name.text === 'false') return cmd.words.length === 1;
  if (name.text !== 'exit') return false;
  const args = cmd.words.filter((w) => w !== name && !ASSIGNMENT_WORD.test(w.raw));
  if (args.length === 0) return true;                       // `exit` — inherits $?
  return args.length === 1 && /^[1-9][0-9]*$/.test(args[0].text);
}

const MAX_RENDER = 48;
function render(text, node) {
  const s = text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return s.length > MAX_RENDER ? `${s.slice(0, MAX_RENDER - 1)}…` : s;
}

/**
 * Every simple command in the tree, in source order, with the words it runs.
 * Used for the block-wide questions — `set +e`, `set -o pipefail`, a `trap`
 * that exits 0 — which are properties of the whole step rather than of one
 * command's position in it.
 */
function allSimpleCommands(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'simple') { out.push(node); return out; }
  for (const key of ['items', 'parts', 'stages', 'arms', 'branches']) {
    if (Array.isArray(node[key])) {
      for (const child of node[key]) {
        allSimpleCommands(child.node ?? child, out);
        if (child.cond) allSimpleCommands(child.cond, out);
        if (child.body) allSimpleCommands(child.body, out);
      }
    }
  }
  for (const key of ['body', 'cond', 'otherwise']) if (node[key]) allSimpleCommands(node[key], out);
  return out;
}

/**
 * Walk the tree recording, for the command name of every simple command:
 *
 *   gating    — it runs on every run of this step and its exit status is
 *               structurally able to reach the build.
 *   reasons   — why that exit status is nonetheless thrown away.
 *   construct — when not gating, the construct it is buried in.
 */
function walk(text, node, ctx, out) {
  const nested = (label) => ({ ...ctx, gating: false, construct: ctx.construct ?? label });

  switch (node.type) {
    case 'list':
      node.items.forEach((item, k) => {
        let c = ctx;
        if (item.sep === '&') {
          c = { ...c, reasons: [...c.reasons, 'the command is backgrounded with `&`, so its exit status is never waited on'] };
        } else if (item.sep === ';' && k < node.items.length - 1) {
          c = {
            ...c,
            reasons: [
              ...c.reasons,
              `the command is followed by \`; ${render(text, node.items[k + 1].node)}\` — ` +
                "the step reports THAT command's exit status"
            ]
          };
        }
        walk(text, item.node, c, out);
      });
      return;

    case 'andor': {
      // KAN-354: a part joined by `&&` to something that CANNOT SUCCEED never
      // runs at all. `false && node x` reads as a live gating invocation
      // otherwise — measured on every parser this repo has shipped, including
      // dff2422 from before KAN-148, so it is an old gap rather than a new one.
      //
      // It surfaced here because the arithmetic fix above was masking it: a
      // block carrying `$(( … ))` failed to parse, so the invocation inside it
      // read as not-live for the wrong reason. Teaching the lexer arithmetic
      // without this would have turned that red into a green for exactly the
      // shape AC-3 names — the widening quietly gaining a live command.
      //
      // THE QUESTION IS ABOUT THE CHAIN SO FAR, NOT ABOUT THE PART TO THE LEFT,
      // and getting that wrong is what the first version of this did. `&&` and
      // `||` are left-associative with EQUAL precedence, so `a || false && x`
      // groups as `(a || false) && x`: when `a` succeeds, `false` never runs,
      // the group succeeds, and `x` RUNS. Asking only whether the immediately
      // preceding part can succeed reported `x` as dead — a false reason naming
      // a real operand, which is worse than saying nothing. Measured against
      // bash rather than argued from precedence:
      //
      //   true  || false && echo X   → X RAN
      //   true  || exit 1 && echo X  → X RAN
      //   false || false && echo X   → (nothing)
      //   true  || echo b && false && echo C → (nothing)
      //
      // So `canSucceed` tracks the accumulated chain. A part joined by `&&`
      // cannot run when the chain to its left cannot succeed; a part joined by
      // `||` runs only when that chain FAILS, and nothing here can prove a
      // chain always succeeds, so `||` is never blocked. Deliberately
      // conservative in the direction that keeps a live command live.
      //
      // Only `false` and a non-zero `exit` count as unable to succeed — that is
      // `cannotSucceed`'s existing, deliberately narrow reading, not widened.
      const blockedBy = new Array(node.parts.length).fill(null);
      let canSucceed = !cannotSucceed(node.parts[0].node);
      for (let k = 1; k < node.parts.length; k += 1) {
        const part = node.parts[k];
        const partCanSucceed = !cannotSucceed(part.node);
        if (part.op === '&&') {
          if (!canSucceed) blockedBy[k] = k - 1;
          canSucceed = canSucceed && partCanSucceed;
        } else {
          canSucceed = canSucceed || partCanSucceed;
        }
      }

      node.parts.forEach((part, k) => {
        const next = node.parts[k + 1];
        let c = ctx;
        if (blockedBy[k] !== null) {
          // Name the whole left-hand chain, because that is what cannot
          // succeed. Naming only the adjacent operand is how the first version
          // of this came to say something false about `a || false && x`.
          const prefix = { start: node.parts[0].node.start, end: node.parts[blockedBy[k]].node.end };
          c = {
            ...c,
            reasons: [
              ...c.reasons,
              `the command is joined by \`&&\` to \`${render(text, prefix)}\`, ` +
                'which cannot succeed, so it never runs'
            ]
          };
        }
        // `|| exit 1` and `|| false` re-raise the failure instead of eating it.
        if (next && next.op === '||' && !cannotSucceed(next.node)) {
          c = {
            ...c,
            reasons: [
              ...c.reasons,
              `the command is followed by \`|| ${render(text, next.node)}\`, which swallows a non-zero exit`
            ]
          };
        }
        walk(text, part.node, c, out);
      });
      return;
    }

    case 'pipeline': {
      let c = ctx;
      if (node.negated) {
        c = { ...c, reasons: [...c.reasons, 'the pipeline is negated with `!`, so a non-zero exit is reported as success'] };
      }
      node.stages.forEach((stage, k) => {
        let sc = c;
        if (k < node.stages.length - 1 && !ctx.pipefail) {
          sc = {
            ...c,
            reasons: [
              ...c.reasons,
              `the command is piped into \`${render(text, node.stages[k + 1])}\` without ` +
                '`set -o pipefail`, so the pipeline reports the last stage'
            ]
          };
        }
        walk(text, stage, sc, out);
      });
      return;
    }

    case 'subshell':
    case 'group':
      // Transparent: `( … )` and `{ …; }` hand their exit status up. What is
      // written AROUND them — a trailing `|| true` — is already in ctx.
      walk(text, node.body, ctx, out);
      return;

    case 'if':
      for (const b of node.branches) {
        walk(text, b.cond, nested('the condition of an `if`, where a non-zero exit only chooses a branch'), out);
        walk(text, b.body, nested('the body of an `if`, which runs only when that condition holds'), out);
      }
      if (node.otherwise) walk(text, node.otherwise, nested('the `else` body of an `if`, which runs only when that condition fails'), out);
      return;

    case 'loop':
      if (node.cond) walk(text, node.cond, nested(`the condition of a \`${node.keyword}\` loop, where a non-zero exit only ends the loop`), out);
      walk(text, node.body, nested(`the body of a \`${node.keyword}\` loop, which may run no times at all`), out);
      return;

    case 'case':
      for (const arm of node.arms) walk(text, arm, nested('a `case` arm, which runs only when its pattern matches'), out);
      return;

    case 'function':
      walk(text, node.body, nested('a function body, which runs nothing where it is defined'), out);
      return;

    case 'simple': {
      const name = commandNameWord(node);
      if (!name) return;
      out.set(name.start, {
        gating: ctx.gating,
        reasons: [...ctx.reasons],
        construct: ctx.construct,
        node
      });
      return;
    }

    default:
      return;
  }
}

const within = (ranges, offset) => ranges.some(([s, e]) => offset >= s && offset < e);

/**
 * Read one `run:` block and answer, for any offset in it, what that offset is:
 * the command name of a live command, a command buried in something, or not a
 * command at all.
 */
export function analyzeRunBody(text) {
  const { tokens, comments, heredocs, substitutions, quotes } = lexShell(text);

  let tree = null;
  let parseError = null;
  try {
    tree = parseShell(tokens);
  } catch (err) {
    parseError = err instanceof ShellParseError ? err.message : String(err && err.message);
  }

  const commands = new Map();
  const blockReasons = [];

  if (tree) {
    const simples = allSimpleCommands(tree);
    const argsOf = (n) => n.words.filter((w) => !ASSIGNMENT_WORD.test(w.raw));
    const named = (n, name) => {
      const w = commandNameWord(n);
      return Boolean(w) && !w.quoted && w.text === name;
    };

    const pipefail = simples.some(
      (n) => named(n, 'set') && argsOf(n).slice(1).some((w) => w.text === 'pipefail')
    );
    if (simples.some((n) => named(n, 'set') && argsOf(n).slice(1).some((w) => /^\+[a-z]*e[a-z]*$/.test(w.text)))) {
      blockReasons.push('the step runs `set +e`, so a failure does not stop it');
    }
    for (const n of simples) {
      if (!named(n, 'trap')) continue;
      const args = argsOf(n).slice(1);
      const action = args[0];
      const targets = args.slice(1).map((w) => w.text.toUpperCase());
      if (action && /(^|[;&|\s])exit\s+0\b/.test(` ${action.text}`) && targets.some((t) => t === 'EXIT' || t === 'ERR')) {
        blockReasons.push(
          `the step registers \`trap ${render(text, { start: action.start, end: action.end })} ${targets.join(' ')}\`, ` +
            'so it exits 0 whatever this command did'
        );
      }
    }

    walk(text, tree, { gating: true, reasons: [], construct: null, pipefail }, commands);

    // An unconditional top-level `exit` ENDS THE STEP, so anything written
    // after it never runs at all. Same family as the eight shapes KAN-148 was
    // filed for — the thing that stops the invocation lives on another line —
    // and just as accident-plausible: a debug `exit 0` left at the top of a
    // block while iterating on CI reads, to every other check here, exactly
    // like a step that runs the audit.
    //
    // Only a SOLE top-level statement counts. `false && exit 0` and
    // `node x || exit 1` are conditional, and treating them as terminators
    // would turn the fix above back into a false alarm.
    for (const item of tree.items) {
      const cmd = soleCommand(item.node);
      if (!cmd) continue;
      const name = commandNameWord(cmd);
      if (!name || name.quoted || name.text !== 'exit') continue;
      for (const [offset, v] of commands) {
        if (offset > cmd.start) {
          v.reasons.push(
            `the step runs \`${render(text, cmd)}\` unconditionally earlier in the block, ` +
              'so this command is never reached'
          );
        }
      }
    }

    // A block whose LAST top-level command is a success makes everything
    // before it advisory. Conservative under `bash -e`, where the failure
    // would have aborted the step before reaching it — see boundary 4.
    const top = tree.items.filter((it) => it.node.type === 'andor' && it.node.parts.length === 1);
    const last = top.length ? top[top.length - 1].node.parts[0].node : null;
    const lastSimple =
      last && last.type === 'pipeline' && last.stages.length === 1 && last.stages[0].type === 'simple'
        ? last.stages[0]
        : null;
    if (lastSimple) {
      const rendered = render(text, lastSimple);
      if (/^(exit\s+0|true|:)$/.test(rendered)) {
        for (const [offset, v] of commands) {
          if (offset < lastSimple.start) {
            v.reasons.push(`the step ends with \`${rendered}\`, so it exits 0 whatever this command did`);
          }
        }
      }
    }
  }

  return {
    parseError,
    classify(offset) {
      if (within(comments, offset)) return { kind: 'comment' };
      if (within(heredocs, offset)) {
        return { kind: 'argument', note: 'inside a heredoc body — that is data handed to a command, not a command' };
      }
      if (within(substitutions, offset)) {
        return {
          kind: 'nested',
          note: 'inside a `$( … )` command substitution, whose exit status does not reach the step'
        };
      }
      if (parseError) {
        return {
          kind: 'nested',
          note: `this \`run:\` block could not be read as shell (${parseError}), so nothing in it counts as a live command`
        };
      }
      const cmd = commands.get(offset);
      if (cmd) {
        if (!cmd.gating) return { kind: 'nested', note: cmd.construct ?? 'a construct whose exit status does not reach the step' };
        return { kind: 'command', reasons: [...cmd.reasons, ...blockReasons] };
      }
      if (within(quotes, offset)) return { kind: 'argument', note: 'inside quotes' };
      return { kind: 'argument', note: 'an argument to another command, not the command itself' };
    }
  };
}

/**
 * Every place `needle` appears in the `run` value of a real step.
 *
 * Each result is `{ line, job, position, disabled, note }`.
 *
 *   position 'command'  — the command name of a simple command at the TOP
 *                         LEVEL of the block: it runs on every run of the
 *                         step. `disabled` then holds the reasons its exit
 *                         status still does not reach the build.
 *   position 'nested'   — a real command inside something that decides
 *                         whether or with what status it runs: a conditional
 *                         or loop body, an `if` condition, a `case` arm, a
 *                         function body, a `$( … )` substitution, or a block
 *                         this reader could not parse. `note` says which.
 *   position 'argument' — not a command: quoted, an argument to something
 *                         else, or a heredoc body. `note` says which.
 *
 * A caller wanting proof that something runs must require position 'command'
 * AND an empty `disabled`. Buried, mentioned and switched-off are each a
 * distinct, and more misleading, failure than an absent one, so they are
 * reported separately rather than folded into "not found".
 *
 * What is NOT a result at all: a commented-out line — a YAML comment is not a
 * step, and a `#` comment in a block scalar is not a command — so a caller can
 * still tell "the text is here but it is a comment" from "the text is here as
 * an argument".
 */
export function findRunInvocations(text, needle) {
  const re = new RegExp(needle.source ?? needle, (needle.flags ?? '').replace('g', ''));
  const { lines, jobs } = readJobs(text);
  const found = [];
  const seen = new Set();
  const workflowShell = defaultsRunShell(lines, 0, lines.length, 0);

  for (const job of jobs) {
    const inheritedShell = defaultsRunShell(lines, job.from, job.to, 4) ?? workflowShell;
    for (const step of job.steps) {
      const keys = stepKeys(lines, step);
      const run = keys.get('run');
      if (!run) continue;

      const body = readRunBody(lines, step, run);
      const analysis = analyzeRunBody(body.text);
      const keyReasons = keyDisablers(job.id, job.keys, keys, inheritedShell);

      const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m;
      while ((m = scan.exec(body.text)) !== null) {
        if (m[0] === '') { scan.lastIndex += 1; continue; }
        const cls = analysis.classify(m.index);
        if (cls.kind === 'comment') continue;

        const finding = {
          line: body.lineFor(m.index),
          job: job.id,
          position: cls.kind,
          disabled: cls.kind === 'command' ? [...keyReasons, ...cls.reasons] : [...keyReasons],
          note: cls.note ?? null
        };
        // Two mentions on one line are one diagnostic, not two.
        const key = `${finding.line}|${finding.position}|${finding.note}|${finding.disabled.join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(finding);
      }
    }
  }
  return found;
}

/** Lines where `needle` appears anywhere at all, live or not — for diagnostics. */
export function findAnywhere(text, needle) {
  const re = new RegExp(needle.source ?? needle, (needle.flags ?? '').replace('g', ''));
  return text
    .split('\n')
    .map((l, i) => (re.test(l) ? i + 1 : 0))
    .filter(Boolean);
}
