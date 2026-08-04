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
// Round 2 fixed those and then made the same mistake in prose: it said
// `continue-on-error` was covered "because it is the same one-line green
// disable as the other two", while nothing looked at the shell text at all.
// Two more one-liners went green:
//
//     - run: node scripts/verify-proof-registry.mjs || true
//     - run: true  # node scripts/verify-proof-registry.mjs
//
// `|| true` is the likeliest of all of these to happen by accident. Nobody
// comments out a CI step to be clever; plenty of people add `|| true` to get
// past a red check while iterating and forget to take it off.
//
// The lesson, and it is the same one this suite keeps relearning one level
// up: THE SENTENCE DESCRIBING WHAT A GUARD COVERS IS ITSELF A CLAIM, and it
// needs the same standard of proof as the guard. Write the assertion first,
// then the sentence.
//
// So this answers the question the regex only appeared to: is that command run
// by a step that will actually execute, and will its failure fail the build? A
// match counts only when it is the `run` value of a real step — found by
// walking jobs and steps structurally, not by pattern — where the invocation
// is the command rather than a comment beside one, the job and step carry no
// `if:` and no `continue-on-error: true`, and the shell does not throw the
// exit code away.
//
// WHAT IT DELIBERATELY DOES NOT ANSWER — three boundaries, on the record:
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
//   3. Shapes of exit-code laundering beyond the list in shellDisablers:
//      `if node x.mjs; then …; fi`, a trap, a wrapper script that exits 0.
//      What IS asserted is enumerated there and demonstrated by mutation on
//      the PR. Nothing here claims the set is exhaustive.
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

/**
 * Cut a trailing shell comment, respecting quotes.
 *
 * `run: true  # node scripts/x.mjs` is a step that runs `true`. Round 2 tested
 * the needle against the whole run value, so the comment satisfied it while
 * the step did nothing.
 */
export function stripShellComment(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { out += c + (text[i + 1] ?? ''); i += 1; continue; }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i += 1; continue; }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
    out += c;
  }
  return out.trim();
}

/** The first unquoted shell control operator in `text`, if any. */
function firstOperator(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { i += 1; continue; }
    const two = text.slice(i, i + 2);
    if (two === '||' || two === '&&') return { op: two, rest: text.slice(i + 2).trim() };
    if (c === ';' || c === '|' || c === '&') return { op: c, rest: text.slice(i + 1).trim() };
  }
  return null;
}

/**
 * The reasons a command that textually exists will not fail the build.
 *
 * Two kinds, and the second is the one round 2 claimed without asserting:
 *
 *   NEVER RUNS      — `if:` or `continue-on-error:` on the job or the step.
 *   RUNS, IGNORED   — the shell throws the exit code away: `|| true`,
 *                     `set +e`, a trailing `; something`, a background `&`,
 *                     an unguarded pipe, or a block ending `exit 0`.
 *
 * `|| true` is the likeliest of any of these to happen by accident. Nobody
 * comments out a CI step to be clever; plenty of people add `|| true` to get
 * past a red check while iterating and forget to take it off.
 *
 * `&&` is deliberately NOT a disabler: it short-circuits, so a failure still
 * surfaces.
 */
function keyDisablers(jobId, jobKeys, keys) {
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
  return out;
}

/**
 * Ways the step's shell discards this command's exit status.
 *
 * `runLines` is the whole run value; `at` is the index within it of the line
 * holding the invocation, and `after` is what follows the invocation on that
 * line with any comment already cut.
 */
function shellDisablers(runLines, at, after) {
  const out = [];
  const body = runLines.map((l) => stripShellComment(l.text)).join('\n');

  if (/(^|\s|;)set\s+\+e\b/.test(body) || /(^|\s|;)set\s+\+o\s+errexit\b/.test(body)) {
    out.push('the step runs `set +e`, so a failure does not stop it');
  }

  const op = firstOperator(after);
  if (op) {
    if (op.op === '||') out.push(`the command is followed by \`|| ${op.rest || '…'}\`, which swallows a non-zero exit`);
    else if (op.op === ';' && op.rest) out.push(`the command is followed by \`; ${op.rest}\` — the step reports THAT command's exit status`);
    else if (op.op === '&') out.push('the command is backgrounded with `&`, so its exit status is never waited on');
    else if (op.op === '|' && !/set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail/.test(body)) {
      out.push(`the command is piped into \`${op.rest}\` without \`set -o pipefail\`, so the pipeline reports the last stage`);
    }
  }

  // A block scalar whose last command is a success: everything before it is
  // advisory. Only meaningful when something follows the invocation.
  const tail = runLines.slice(at + 1).map((l) => stripShellComment(l.text)).filter(Boolean).pop();
  if (tail !== undefined && /^(exit\s+0|true|:)$/.test(tail)) {
    out.push(`the step ends with \`${tail}\`, so it exits 0 whatever this command did`);
  }

  return out;
}

/**
 * Every place `needle` appears in the `run` value of a real step.
 *
 * Each result is `{ line, job, disabled }`, where `disabled` is empty for a
 * step that will genuinely execute and otherwise holds the reasons it will
 * not. Callers are expected to require at least one live result AND no
 * disabled ones — a disabled invocation is a distinct, and more misleading,
 * failure than an absent one.
 *
 * A commented-out line is never a result, and neither is a comment BESIDE a
 * command: the needle is matched against the run text with any trailing shell
 * comment already cut, so `run: true  # node scripts/x.mjs` finds nothing.
 */
export function findRunInvocations(text, needle) {
  const re = new RegExp(needle.source ?? needle, (needle.flags ?? '').replace('g', ''));
  const { lines, jobs } = readJobs(text);
  const found = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      const keys = stepKeys(lines, step);
      const run = keys.get('run');
      if (!run) continue;

      // Inline (`run: node x.mjs`) or a block scalar whose body is the script.
      const runLines = [];
      if (run.value && !/^[|>]/.test(run.value)) {
        runLines.push({ idx: run.idx, text: run.value });
      } else {
        for (let i = run.idx + 1; i < step.end; i += 1) {
          if (isBlank(lines[i])) continue;
          if (indentOf(lines[i]) <= step.indent + 2) break;
          runLines.push({ idx: i, text: lines[i].trim() });
        }
      }

      const keyReasons = keyDisablers(job.id, job.keys, keys);
      for (let at = 0; at < runLines.length; at += 1) {
        const command = stripShellComment(runLines[at].text);
        const m = re.exec(command);
        if (!m) continue;
        const after = command.slice(m.index + m[0].length);
        found.push({
          line: runLines[at].idx + 1,
          job: job.id,
          disabled: [...keyReasons, ...shellDisablers(runLines, at, after)]
        });
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
