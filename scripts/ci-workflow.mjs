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
// Round 3 then fixed one member of a category and described the category:
// "cuts a trailing shell comment before matching, SO THE INVOCATION HAS TO BE
// THE COMMAND rather than a comment beside one." Cutting the comment does not
// make it the command. The match still only had to appear SOMEWHERE in the
// surviving text, so six more shapes ran nothing and stayed green:
//
//     echo "node scripts/verify-proof-registry.mjs"
//     echo node scripts/verify-proof-registry.mjs
//     : node scripts/verify-proof-registry.mjs
//     bash -c 'node scripts/verify-proof-registry.mjs' || true
//
// commandStarts is what makes that sentence true, and it is asserted now.
//
// Round 4 then did it a FOURTH time, in the sentence correcting the third:
// it observed that the one-line `if node x.mjs; then …; fi` is caught (true,
// via the `;` operator) and generalised to "conditionals are caught" (false —
// the multi-line form every block scalar actually uses is green). The
// correction inherited the defect it was correcting.
//
// The lesson, and it is the same one this suite keeps relearning one level
// up: THE SENTENCE DESCRIBING WHAT A GUARD COVERS IS ITSELF A CLAIM, and it
// needs the same standard of proof as the guard. Four times in this one
// change the code fixed a member and the prose asserted the category. The
// habit that catches all four: WHEN YOU WRITE "SO X CAN NO LONGER HAPPEN,"
// GO AND MAKE X HAPPEN. If it still can, the sentence describes your intent
// rather than your code. Write the assertion first, then the sentence.
//
// And the reason it is worth a fifth pass over prose that changes no
// behaviour: A GUARD THAT DOCUMENTS A PROTECTION IT DOES NOT HAVE IS WORSE
// THAN ONE THAT STAYS QUIET. Silence makes a reader check; a false assurance
// makes them not bother, and the construct they would then ship is the exact
// one the sentence exonerated.
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
//   3. ANYTHING THAT GATES THE INVOCATION FROM ANOTHER LINE. This reads each
//      line of a `run:` block on its own, plus the block's last line. It has
//      no model of block structure, so every one of these is green while the
//      audit never runs (verified, not supposed — KAN-148):
//
//        - run: |                     - run: |
//            if [ "$SKIP" != 1 ]; then    cat <<EOF
//              node scripts/…             node scripts/…
//            fi                           EOF
//
//      A function body that is never called is green the same way. The
//      one-line `if node x.mjs; then …; fi` IS caught, via the `;` operator —
//      but that is the form nobody writes in a block, and round 4's
//      correction generalised from it to "conditionals are caught", which is
//      false. This entry is the third correction of that same mistake and was
//      introduced as the fix to the second; see the header note above.
//
//      Command substitution is in the same gap and inverts safely-wrong:
//      `echo $(node x.mjs)` is green, while `echo "$(node x.mjs)"` is caught —
//      the quotes suppress the `(` that would otherwise open a command
//      position. The sloppier form is the one that gets through.
//
//      Also here: shapes of exit-code laundering beyond shellDisablers — a
//      `trap` that exits 0, or a wrapper SCRIPT whose own exit code is 0
//      whatever it ran. A wrapper on the COMMAND LINE (`timeout 60 node
//      x.mjs`, `bash -c '…'`) is NOT in this gap: it is not at command
//      position, so it reads as absent and fails closed.
//
//      One known FALSE ALARM, in the safe direction: `FOO=1 node x.mjs` and
//      `env FOO=1 node x.mjs` read as not-live though they genuinely run, so
//      they fail closed. `time` is admitted as a leading keyword and `env` is
//      not — an inconsistency rather than a hole. This repo uses neither
//      shape. Folded into KAN-148.
//
//      What IS asserted is enumerated in shellDisablers and commandStarts and
//      demonstrated by mutation on the PR. Nothing here claims the set is
//      exhaustive, and per-block shell reasoning — the one fix that closes
//      this whole class — is deliberately NOT attempted here.
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

/**
 * Shell keywords that precede a command without consuming its position: after
 * `if`, the next word is still a command being run.
 */
const LEADING_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time', '!', 'exec', 'command']);

/**
 * Offsets in `text` at which a COMMAND begins — outside quotes, at the start
 * or just past a `;`, `&&`, `||`, `|`, `&`, newline, `(` or `{`.
 *
 * This is what round 3 was missing. `re.exec(command)` matched anywhere, so
 * every one of these read as a live invocation while running nothing:
 *
 *     echo "node scripts/verify-proof-registry.mjs"
 *     echo node scripts/verify-proof-registry.mjs
 *     : node scripts/verify-proof-registry.mjs
 *     bash -c 'node scripts/verify-proof-registry.mjs' || true
 *
 * The last compounded: the match landed mid-string, so the text after it began
 * with an unbalanced quote, `firstOperator` entered quote mode and never left,
 * and the trailing `|| true` went unseen too. One defect defeated both the
 * mention check and the swallowed-exit check.
 *
 * Requiring command position closes all of them at once, and closes the quote
 * bug by construction rather than by patch: a position inside quotes is never
 * a command start, so the text after a match never begins mid-quote.
 *
 * A wrapper — `timeout 60 node x.mjs`, `xvfb-run node x.mjs` — is NOT a
 * command position and reads as absent. That is a deliberate fail-closed: a
 * wrapper changes what the exit status means, and admitting one should be a
 * reviewed edit rather than an inference. The message says which case it is.
 */
export function commandStarts(text) {
  const starts = [];
  let quote = null;
  let atStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') { atStart = false; i += 1; continue; }
    if (c === "'" || c === '"') { quote = c; atStart = false; continue; }
    if (atStart && !/\s/.test(c)) { starts.push(i); atStart = false; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { atStart = true; i += 1; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === '{') { atStart = true; continue; }
  }

  // `if node x.mjs` runs `node`: step past a leading keyword and count the
  // word after it as a command start too.
  for (let n = 0; n < starts.length; n += 1) {
    const rest = text.slice(starts[n]);
    const word = /^(\S+)\s+/.exec(rest);
    if (!word || !LEADING_KEYWORDS.has(word[1])) continue;
    const next = starts[n] + word[0].length;
    if (next < text.length && !starts.includes(next)) starts.push(next);
  }
  return starts.sort((a, b) => a - b);
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
 * Each result is `{ line, job, position, disabled }`.
 *
 *   position 'command'  — the needle begins a command ON ITS OWN LINE. NOT
 *                         "a command the shell will run": this reasons per
 *                         line, so it cannot see that the line sits in a
 *                         conditional body, a heredoc, or an uncalled
 *                         function, none of which run. See boundary 3 and
 *                         KAN-148.
 *   position 'argument' — it appears only as an argument or inside quotes:
 *                         `echo "node x.mjs"`, `bash -c '…'`, `timeout 60
 *                         node x.mjs`. Mentioned, not executed.
 *
 * `disabled` is empty for a step that will genuinely execute and otherwise
 * holds the reasons it will not. A caller wanting proof that something runs
 * must require a result with position 'command' AND an empty `disabled` —
 * mentioned-only and switched-off are each a distinct, and more misleading,
 * failure than an absent one, so they are reported separately rather than
 * folded into "not found".
 *
 * What is NOT a result: a commented-out line (a YAML comment is not a step, a
 * `#` in a block scalar is not a command), and a comment beside a command —
 * the needle is matched against the run text with any trailing shell comment
 * already cut, so `run: true  # node scripts/x.mjs` finds nothing.
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
        const starts = new Set(commandStarts(command));

        // Every match on the line, not just the first: `echo node x.mjs && node
        // x.mjs` mentions it once and runs it once, and the run is what counts.
        const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        let m;
        let executed = false;
        const mentions = [];
        while ((m = scan.exec(command)) !== null) {
          if (m[0] === '') { scan.lastIndex += 1; continue; }
          if (!starts.has(m.index)) { mentions.push(m.index); continue; }
          executed = true;
          found.push({
            line: runLines[at].idx + 1,
            job: job.id,
            position: 'command',
            disabled: [...keyReasons, ...shellDisablers(runLines, at, command.slice(m.index + m[0].length))]
          });
        }

        // Mentioned but never run: `echo "node x.mjs"`, `bash -c '…'`, or a
        // wrapper like `timeout 60 node x.mjs`. Reported so the caller can say
        // WHICH of "absent" it is, instead of leaving a reader staring at a
        // line that plainly contains the string.
        if (!executed && mentions.length) {
          found.push({ line: runLines[at].idx + 1, job: job.id, position: 'argument', disabled: keyReasons });
        }
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
