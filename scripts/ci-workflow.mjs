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
// So this answers the question the regex only appeared to: is that command run
// by a step that will actually execute? A match counts only when it is the
// `run` value of a real step — found by walking jobs and steps structurally,
// not by pattern — on a line that is not commented out, in a job and a step
// carrying no `if:` and no `continue-on-error: true`.
//
// WHAT IT DELIBERATELY DOES NOT ANSWER: whether the job is a REQUIRED context
// in branch protection. That lives in repository settings rather than in the
// tree; nothing in here can see it, so nothing in here pretends to. A live
// step proves the check runs and can go red, not that a red one blocks a
// merge.
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

/** The reasons a step that textually exists will not actually run. */
function disablers(jobId, jobKeys, keys) {
  const out = [];
  const truthy = (v) => v !== undefined && /^(true|'true'|"true")$/i.test(String(v.value));
  if (jobKeys.has('if')) out.push(`job \`${jobId}\` carries \`if: ${jobKeys.get('if').value}\``);
  if (truthy(jobKeys.get('continue-on-error'))) out.push(`job \`${jobId}\` carries \`continue-on-error: true\``);
  if (keys.has('if')) out.push(`the step carries \`if: ${keys.get('if').value}\``);
  if (truthy(keys.get('continue-on-error'))) out.push('the step carries `continue-on-error: true`');
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
 * A commented-out line is never a result: a YAML comment is not a step, and a
 * `#` inside a block scalar is not a command.
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

      for (const rl of runLines) {
        if (rl.text.startsWith('#')) continue;
        if (!re.test(rl.text)) continue;
        found.push({ line: rl.idx + 1, job: job.id, disabled: disablers(job.id, job.keys, keys) });
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
