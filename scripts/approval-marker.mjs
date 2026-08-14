//
// The approval marker — what a machine can read of "this pull request was
// approved, at this exact commit, by the agent the board names". KAN-402.
//
// Not named `verify-*`, so the proof-registry job neither runs it nor demands a
// register entry — it is a module, like `ci-workflow.mjs` and `mutation.mjs`.
// It is nonetheless held to a proof: `scripts/verify-approval-marker.mjs`
// drives every branch below over fixtures and mutates this file to show those
// assertions going red.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — three incidents on this epic, all in one afternoon
// ---------------------------------------------------------------------------
//
// Every agent working this repository authenticates as the same GitHub
// account, so GitHub refuses a formal review verdict on our own pull requests
// as self-review, and `required_approving_review_count` is pinned at 0. Every
// approval this epic has ever given has therefore been a pull request COMMENT,
// indistinguishable to any machine from any other comment. The task agent
// waiting for it polls for a token in the comment text, and nothing anywhere
// checked that the approver wrote what the poller reads.
//
// KAN-402 records what that cost, measured rather than argued:
//
//   1. On #107 the epic agent posted `APPROVED at <sha> — merge it.` The task
//      agent polls for `BUTCHR-APPROVAL`. A complete, correct approval sat on
//      the pull request for TEN MINUTES while the agent polled through its loop
//      doing exactly what it was told. It was found by tailing the agent.
//      Nothing on the pull request, the ticket or the board said anything was
//      wrong — A MISSING APPROVAL IS INDISTINGUISHABLE FROM AN APPROVAL NOT YET
//      GIVEN.
//
//   2. On #108 the same agent posted a marker carrying the token but not the
//      format — the approver first, the SHA after prose, no `BY`. THIRTEEN
//      MINUTES, with the task agent idle at a prompt and a watch armed.
//
//   3. Ninety-three seconds. Same reviewer, same verdict, same head, same green
//      checks — and a marker of the right SHAPE. `14:08:18Z` marker,
//      `14:09:51Z` merged.
//
// Thirteen minutes against ninety-three seconds, with the marker's shape as the
// only variable, is as close to a controlled comparison as this will get, and
// it was an accident.
//
// AND THE FOURTH THING, WHICH IS WHY THE FIX IS A CHECK AND NOT A CONVENTION.
// After the first failure the epic agent added the token and VERIFIED it:
//
//     [.comments[] | select(.body | test("BUTCHR-APPROVAL"))] | length   -> 2
//
// That returns >= 1 for any comment containing that word anywhere, in any
// arrangement, fenced or not. The handoff was still broken and there was a
// green number in hand saying otherwise. A convention plus discipline had
// already been tried three times by the most motivated reader in the fleet.
//
// ---------------------------------------------------------------------------
// WHAT IT ESTABLISHES AND WHAT IT DOES NOT — read this before trusting it
// ---------------------------------------------------------------------------
//
//   IT CATCHES OMISSION AND STALENESS. A merge with no approval at all, and a
//   merge on an approval given against a commit that is no longer the head,
//   both become a red `approval-recorded` status instead of a silence.
//
//   IT CATCHES THE WRONG SHAPE, WHICH IS THE DEFECT THAT COMMISSIONED IT. A
//   marker carrying the token in the wrong arrangement is refused WITH A REASON
//   THAT NAMES THE LINE TO POST. Incidents 1 and 2 above both present, under
//   this check, as a red status whose text is the exact line the approver
//   needed.
//
//   IT DOES NOT CATCH FORGERY, AND CANNOT. Under one shared GitHub identity the
//   author of a pull request can post their own approval marker naming their
//   own declared approver, and nothing here can tell that comment from the real
//   one. The author of the pull request and the author of the approval are the
//   same GitHub user BY CONSTRUCTION. This is a permanent limit of the design
//   rather than an oversight; closing it needs per-agent GitHub identities,
//   which is KAN-366 and is not attempted here.
//
//   SO THE MERGE BUTTON STAYS OPEN TO THE AUTHOR. What changes is that taking
//   it now leaves a signed, head-pinned record where it previously left
//   nothing at all.
//
//   AND IT IS ADVISORY UNTIL SOMEBODY WITH ADMIN MAKES IT REQUIRED. Marking a
//   status required is a branch-protection write, which is the `wroosbit`
//   account and is on this epic's awaiting-human list (KAN-307). A red,
//   visible `approval-recorded` is worth most of the value and is what this
//   builds. DO NOT DESCRIBE IT AS A GATE AGAINST A DETERMINED AUTHOR, and do
//   not describe it as blocking a merge, until that write has happened.
//
// The honest sentence is: this converts "I believe I was approved" into "a
// comment naming this exact commit exists, or the pull request says so in red".
// That is a smaller claim than "approval is enforced", and it is the one to
// make.
//
// WHY IT COMPARES COMMITS AND NEVER CLOCKS. The obvious way to check that an
// approval preceded a merge is to compare timestamps, and that is how the
// equivalent ticket elsewhere was filed with a false headline: Jira returns
// `-0700`, GitHub returns `Z`, neither surface says they are different clocks,
// and a seven-hour timezone error read as evidence of an unapproved merge. A
// 40-character commit SHA has no timezone, no offset and no clock. If a leg is
// ever added here that reads a timestamp, normalise both sides to UTC
// explicitly and say so on the line that does it.
//
// ---------------------------------------------------------------------------
// LINEAGE — this module is ported, and `docs/ported-lineage.md` is the record
// ---------------------------------------------------------------------------
//
// The grammar, the use/mention scanner and the verdict shape below came from
// `wroosbit/butchr`, `daemon/scripts/lib/approval-marker.mjs`, at the commit
// named in the second table of `docs/ported-lineage.md`. Read that document
// before changing this file — it says what CrabCast decided here and what it
// inherited.
//
// ANOTHER TREE IS EVIDENCE, NEVER A SPECIFICATION, and the reason to port
// rather than to write fresh is evidence rather than deference: the use/mention
// scanner below exists because a COOPERATIVE agent tripped the naive version by
// following the obvious path, and rewriting that subtlety from the sentence
// describing it is how it comes back. Where CrabCast has decided differently it
// is marked `CRABCAST DECIDED` on the line that decides it, and nothing here
// creates an obligation to justify a divergence.
//
// ONE DIVERGENCE IS LOAD-BEARING AND IS STATED UP FRONT. The token is
// `BUTCHR-APPROVAL` and not a CrabCast-specific spelling. CRABCAST DECIDED:
// the agents that write these markers and the agents that poll for them are
// Butchr-managed agents following `prompts/task.md`, which mandates that exact
// line. A second, incompatible spelling would reintroduce the precise defect
// this file exists to close — an approver writing one token while a poller
// reads another — and would do it to every agent at once rather than to one.
//

/** `<type>/<KEY>` — the fleet's own name for an agent, e.g. `epic/KAN-59`. */
const AGENT = /^(epic|story|task|confluence)\/([A-Z][A-Z0-9]*-\d+)$/;

// ---------------------------------------------------------------------------
// TWO VERDICTS, TWO CARRIERS
// ---------------------------------------------------------------------------
//
// The answer is published twice — as the `approval-recorded` commit status, and
// as the exit code of the job that posts it. That looks like belt and braces
// and is not, because the two carriers behave differently:
//
//   THE STATUS IS REPLACED. It is POSTed at the head SHA, so the newest POST
//   for that context wins. An approval arriving by comment overwrites the
//   failure the push wrote. This carrier tracks the CURRENT answer, which is
//   why it is the one a branch protection rule would read.
//
//   THE JOB CONCLUSION IS NOT. A workflow run's conclusion is fixed when the
//   run ends, and the re-evaluation triggered by the approving comment does not
//   even attach to the head — an `issue_comment` run attaches its check run to
//   the DEFAULT BRANCH, which is the entire reason the status exists. So a red
//   run written by the opening push is never superseded and never replaced.
//
// Every pull request begins unapproved. If the job conclusion carried the
// approval answer, every pull request would earn a permanent red run, so every
// APPROVED pull request would read `mergeStateStatus: UNSTABLE` rather than
// `CLEAN`. That is not cosmetic: the natural repair for UNSTABLE is
// `gh pr update-branch`, which moves the head and voids the approval marker.
// Red-looking pull request -> rebase to clear it -> approval dies ->
// `approval-recorded` goes red for real -> still UNSTABLE -> rebase again.
//
// So each carrier answers exactly one question:
//
//   `approval-recorded` (a commit status)   Is this head approved?
//   `approval-gate`     (the job)           Did the gate manage to say?
//
// A GREEN JOB OVER A RED STATUS IS THE DESIGNED READING, not a hole. It says
// "the gate is working, and its answer is no". The job log says so in those
// words, because the failure mode of this arrangement is a reader who takes the
// green job for an approval.

/**
 * The exit-code policy, as one pure function, because it is the thing that must
 * not be quietly re-conflated. `check-approval-recorded.mjs` computes nothing
 * about its own exit code except through here, so there is exactly one place in
 * this repository that decides which failures are the job's.
 *
 * `.mjs` cannot spell `exitOn` as a literal type, which is what an
 * unrepresentable state would buy over an assertion — an assertion can be
 * deleted by a later author and the build still passes. The nearest available
 * thing is a frozen closed set plus a throw, so a typo becomes a loud crash
 * rather than a silently-chosen branch. `EXIT_ON` is exported so a caller
 * enumerates the valid values rather than retyping a string literal.
 *
 * @param {{ gateHealthy: boolean, approved: boolean, exitOn: 'gate-health' | 'approval' }} q
 * @returns {0 | 1}
 */
export const EXIT_ON = Object.freeze({ GATE_HEALTH: 'gate-health', APPROVAL: 'approval' });

export function exitCodeFor({ gateHealthy, approved, exitOn }) {
  if (typeof gateHealthy !== 'boolean' || typeof approved !== 'boolean') {
    throw new TypeError(
      `exitCodeFor needs booleans for gateHealthy and approved (got ${typeof gateHealthy}, ${typeof approved}). ` +
        'Refusing to guess, because every wrong guess here is a gate that reports the wrong colour.'
    );
  }
  if (exitOn !== EXIT_ON.GATE_HEALTH && exitOn !== EXIT_ON.APPROVAL) {
    throw new TypeError(
      `exitCodeFor got exitOn=${JSON.stringify(exitOn)}, which is neither ` +
        `${JSON.stringify(EXIT_ON.GATE_HEALTH)} nor ${JSON.stringify(EXIT_ON.APPROVAL)}.`
    );
  }

  // A gate that could not publish its verdict is a job failure under BOTH
  // modes, and this line is the invariant rather than a shortcut. The mode
  // chooses who carries the APPROVAL answer; it never excuses a broken gate,
  // because a broken gate has not established anything at all. Fail closed.
  if (!gateHealthy) return 1;

  // `gate-health` is the CI default: the status carries the approval answer, so
  // the job does not repeat it. `approval` is for a caller that has NO status —
  // `--check`, run by an approver against a live pull request from a terminal.
  // With no other carrier the exit code has to be the answer or the answer is
  // nowhere.
  return exitOn === EXIT_ON.APPROVAL ? (approved ? 0 : 1) : 0;
}

/**
 * The canonical approval line, matched anywhere in a comment body but only on a
 * line of its own. Prose around it is welcome and expected — the marker is what
 * the machine reads, and the reasoning around it is what the next human reads.
 *
 * The SHA must be all 40 characters. An abbreviated SHA is refused rather than
 * resolved: `1abbf50` names a commit only relative to a repository state, and
 * the entire value of this check is that the approval names one commit for all
 * time.
 */
const MARKER = /^[ \t]*BUTCHR-APPROVAL:[ \t]+([0-9a-f]{40})[ \t]+BY[ \t]+(\S+)[ \t]*$/gim;

/** The same grammar against a single line, for reporting a marker we refused. */
const MARKER_LINE = /^[ \t]*BUTCHR-APPROVAL:[ \t]+([0-9a-f]{40})[ \t]+BY[ \t]+(\S+)[ \t]*$/i;

/**
 * The one place in this repository that WRITES the canonical line, as opposed
 * to reading it.
 *
 * CRABCAST DECIDED (KAN-245's class, applied here). Every reason string that
 * suggests a marker, the `--check` helper's output, and the proof's own
 * accepted-case fixtures all come from here. The alternative — each of them
 * spelling the line out — is a constant maintained beside a self-deriving
 * loop, and this epic has six instances of that class on the board. One edit
 * here moves every copy, and there is no second copy to disagree with it.
 *
 * THE SEAM, because a constructor used by the proof's green fixture could be
 * read as circular: this function does not share code with `MARKER`. It builds
 * a string; `MARKER` is a regular expression that reads one. A grammar that
 * silently stopped matching would still be caught, because the refusal
 * fixtures below are transcribed from the two INCIDENTS on KAN-402 rather than
 * generated here, and because the mutation section requires the accepted case
 * to go red when the grammar is loosened. What this function does buy is that
 * the suggestion the check PRINTS and the line the check ACCEPTS cannot drift
 * apart — which is incident 1 and incident 2 in one sentence.
 */
export function canonicalMarker({ sha, approver }) {
  return `BUTCHR-APPROVAL: ${String(sha ?? '').toLowerCase()} BY ${approver ?? '<approver>'}`;
}

/**
 * A comment that mentions the token but matches neither grammar above. This is
 * INCIDENT 2 — the token present and the arrangement wrong — and it exists so
 * that failure gets a reason rather than "no approval marker was found", which
 * is what an approver looking at a comment they can see contains the word would
 * read as the check being broken.
 */
const TOKEN_MENTION = /^.*BUTCHR-APPROVAL.*$/gim;

// ---------------------------------------------------------------------------
// USE VERSUS MENTION
// ---------------------------------------------------------------------------
//
// The obvious way to REQUEST an approval is to paste the exact line you are
// requesting, inside a code fence, so the approver can copy it. A grammar that
// matches "a line of its own" matches that too — a line inside a code fence is
// still a line of its own — so the request satisfies the check, and the status
// goes green describing an approval nobody has given. That is not the forgery
// limit above and it is worse in one specific way: IT NEEDS NO INTENT. It is
// what a COOPERATIVE agent does by following the obvious path, and it fires at
// the worst possible moment, because the marker gets quoted precisely when
// somebody is requesting or explaining the gate — which is exactly when the
// gate is being relied upon. A rule that is tripped by citing it correctly is
// tripped by its most careful users first.
//
// THE FIX IS TO READ ONLY WHAT THE COMMENT ASSERTS. Markdown has contexts that
// SHOW a line rather than say it, and one that HIDES it altogether.
// `scanQuoted` labels those lines and `assertedText` blanks them before the
// grammar above ever runs.
//
// WHY EVERY AMBIGUITY HERE RESOLVES TOWARD "QUOTED", which is what allows this
// scanner to be approximate rather than a conformant CommonMark parser.
// Deciding a line is quoted REFUSES a marker, and a refused marker is a red
// status. So an over-eager scanner costs an approver a re-post with a reason
// naming exactly what happened, while an under-eager one hands back the defect
// this section exists to close. Fail closed, loudly. Where you are unsure, mark
// it quoted.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not require the marker to LEAD
// the comment. An approval that explains itself first and states the marker
// last is the normal shape, and requiring position would refuse the good case
// to catch the bad one.
//
// WHAT IT STILL DOES NOT CATCH, stated rather than left to be inferred:
//
//   - FORGERY, exactly as above. An author who writes the marker as a plain
//     top-level line satisfies the check, whatever they meant by it.
//   - A MARKER POSTED AS A DELIBERATE DEMONSTRATION at top level, naming the
//     right head and the right approver. It is accepted, because nothing
//     distinguishes it.
//   - RENDERED-INLINE PROSE. A line indented under a list item is a paragraph
//     rather than code, and this scanner calls it quoted anyway — fail-closed,
//     and noted so nobody reads the labels as a rendering claim.

/**
 * The contexts in which a Markdown comment shows a line rather than says it.
 * A closed frozen set for the same reason `EXIT_ON` is one: `.mjs` cannot spell
 * it as a literal type, and a typo that silently picks a branch is, for a
 * check, a wrong colour.
 */
export const QUOTED = Object.freeze({
  FENCED_CODE: 'a fenced code block',
  INDENTED_CODE: 'an indented block',
  BLOCKQUOTE: 'a blockquote',
  HTML_COMMENT: 'an HTML comment'
});

/** An opening fence may carry an info string; a closing one may not. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {4,}|\t)/;
/** Strip one or more blockquote markers, so a quoted marker can be reported. */
const BLOCKQUOTE_PREFIX = /^(?: {0,3}> ?)+/;

/**
 * Label every line of `body` with the context that displays or hides it, or
 * `null` where the line is the comment speaking in its own voice.
 *
 * Exported so the proof can drive the scanner directly rather than only through
 * its effect on a verdict — a scanner tested only via `evaluate` is one whose
 * failures all look like approval failures.
 *
 * @param {string} body
 * @returns {(string|null)[]} one entry per line, a `QUOTED` value or `null`
 */
export function scanQuoted(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = new Array(lines.length).fill(null);
  let fence = null;
  let html = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside a fence, nothing else can start: a `>` or a `<!--` in there is
    // code being shown. An unclosed fence runs to the end of the comment, which
    // is CommonMark's own rule and is also the fail-closed direction.
    if (fence) {
      out[i] = QUOTED.FENCED_CODE;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }

    if (html) {
      out[i] = QUOTED.HTML_COMMENT;
      if (line.includes('-->')) html = false;
      continue;
    }

    // A fence closes only on the SAME character at the SAME length or longer,
    // which is what makes a ``` inside a ```` block content rather than a
    // terminator. That nesting is how a worked example of this very check gets
    // written, so it is the case most likely to occur here.
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      out[i] = QUOTED.FENCED_CODE;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      out[i] = QUOTED.BLOCKQUOTE;
      continue;
    }

    // Four spaces or a tab. Deliberately blunter than CommonMark, which would
    // call the same line a paragraph continuation in some positions — but a
    // continuation renders INLINE, so it is not "a line of its own" either, and
    // both readings refuse. Three spaces stay legal, so the indentation the
    // grammar has always tolerated is untouched.
    if (INDENTED.test(line)) {
      out[i] = QUOTED.INDENTED_CODE;
      continue;
    }

    // A complete `<!-- … -->` on one line opens nothing. Anything left after
    // removing those pairs is a comment that runs on to a later line — and a
    // marker nobody can see is the same defect as one that is merely shown.
    if (line.replace(/<!--[\s\S]*?-->/g, '').includes('<!--')) {
      out[i] = QUOTED.HTML_COMMENT;
      html = true;
    }
  }

  return out;
}

/**
 * `body` with every displayed or hidden line blanked, keeping the line count so
 * that the grammar above still sees "a line of its own" exactly where the
 * comment does.
 */
export function assertedText(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const quoted = scanQuoted(body);
  return lines.map((line, i) => (quoted[i] ? '' : line)).join('\n');
}

/** The body, id and GitHub author of a comment, which may be a bare string. */
function commentParts(c) {
  return {
    body: typeof c === 'string' ? c : (c?.body ?? ''),
    commentId: typeof c === 'string' ? null : (c?.id ?? null),
    author: typeof c === 'string' ? null : (c?.user?.login ?? null)
  };
}

/** Every marker a comment ASSERTS. What the check reads, and the only thing it does. */
export function parseMarkers(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const { body, commentId, author } = commentParts(c);
    const text = assertedText(body);
    MARKER.lastIndex = 0;
    let m;
    while ((m = MARKER.exec(text)) !== null) {
      found.push({ sha: m[1].toLowerCase(), approver: m[2], commentId, author });
    }
  }
  return found;
}

/**
 * Every marker a comment MENTIONS — refused, and reported so the refusal has a
 * reason an approver can act on.
 *
 * This exists because the fix without it is the worse bug. An approver who
 * fences their marker would otherwise get silence: a red check reading "no
 * approval marker was found", about a comment they can see contains one.
 */
export function parseQuotedMarkers(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const { body, commentId, author } = commentParts(c);
    const lines = String(body ?? '').split(/\r?\n/);
    const quoted = scanQuoted(body);
    lines.forEach((line, i) => {
      if (!quoted[i]) return;
      // A blockquoted marker never matched the grammar in the first place — `>`
      // is not `[ \t]` — so it has always been refused, silently and by
      // accident rather than by design. Stripping the prefix here is what turns
      // that accident into a reported refusal.
      const bare = quoted[i] === QUOTED.BLOCKQUOTE ? line.replace(BLOCKQUOTE_PREFIX, '') : line;
      const m = MARKER_LINE.exec(bare);
      if (m) {
        found.push({
          sha: m[1].toLowerCase(),
          approver: m[2],
          commentId,
          author,
          quotedAs: quoted[i]
        });
      }
    });
  }
  return found;
}

/**
 * CRABCAST DECIDED, and this function is the one KAN-402 commissioned that the
 * ported source does not have.
 *
 * Every line that MENTIONS the token and is neither an asserted marker nor a
 * quoted one. That is exactly incident 2: `BUTCHR-APPROVAL: epic/KAN-59 —
 * APPROVED at <sha> — merge it.` — the token, at top level, on a line of its
 * own, in the wrong arrangement. Without this, that comment produces the reason
 * "no approval marker was found", which is true, unhelpful, and was read for
 * thirteen minutes as the check having nothing to say.
 *
 * It reports the LINE, so the reason can show the approver what they wrote next
 * to what the grammar needs.
 */
export function parseMalformedMentions(comments) {
  const found = [];
  for (const c of comments ?? []) {
    const { body, commentId, author } = commentParts(c);
    const lines = String(body ?? '').split(/\r?\n/);
    const quoted = scanQuoted(body);
    lines.forEach((line, i) => {
      if (quoted[i]) return; // a quoted line is somebody else's report
      TOKEN_MENTION.lastIndex = 0;
      if (!TOKEN_MENTION.test(line)) return;
      if (MARKER_LINE.test(line)) return; // a well-formed marker is not a mention
      found.push({ line: line.trim(), commentId, author });
    });
  }
  return found;
}

/**
 * The approver the pull request itself declares, in its body:
 *
 *     BUTCHR-APPROVER: epic/KAN-59
 *
 * Written by the author, before any approval exists, and what the marker is
 * checked against. It is not authentication — see the forgery note above — but
 * it does force the author to commit to who the approver is IN ADVANCE, so a
 * marker from some other agent that happens to be watching does not count.
 */
const DECLARED = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/im;

/** The branch convention: `butchr/KAN-402` is the agent working KAN-402. */
const BRANCH = /^butchr\/([A-Z][A-Z0-9]*-\d+)$/;

/**
 * The approver a pull request body only MENTIONS. The same use/mention defect
 * one field over, and it bites in a way the marker's version does not: a body
 * that SHOWS `BUTCHR-APPROVER: epic/KAN-59` as an example of the convention,
 * above a real declaration of somebody else, used to have the example win —
 * `DECLARED` is not global and takes the first match in the file.
 */
export function parseQuotedApprover(prBody) {
  const lines = String(prBody ?? '').split(/\r?\n/);
  const quoted = scanQuoted(prBody);
  for (let i = 0; i < lines.length; i++) {
    if (!quoted[i]) continue;
    const bare = quoted[i] === QUOTED.BLOCKQUOTE ? lines[i].replace(BLOCKQUOTE_PREFIX, '') : lines[i];
    const m = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/i.exec(bare);
    if (m) return { approver: m[1], quotedAs: quoted[i] };
  }
  return null;
}

export function parseDeclaredApprover(prBody) {
  const m = DECLARED.exec(assertedText(prBody));
  return m ? m[1] : null;
}

/** The ticket this pull request belongs to, read off its own branch name. */
export function ownTicketFromRef(headRef) {
  const m = BRANCH.exec(headRef ?? '');
  return m ? m[1] : null;
}

/**
 * The whole verdict, as data. No I/O, no process exit, no printing — so the
 * proof can drive it over fixtures and the CI entry point can drive it over a
 * live pull request, and both are exercising THE SAME DECISION. That identity
 * is the point rather than a convenience: incident 2's verification failed
 * because it checked the fix against a different, looser instrument than the
 * one that would consume it.
 *
 * Returns `{ ok, reasons, accepted, markers, … }`. `reasons` is non-empty
 * exactly when `ok` is false, and each entry is written to be read on a red
 * check by somebody who has not seen this file.
 */
export function evaluate({ headSha, headRef, prBody, comments }) {
  const reasons = [];
  const markers = parseMarkers(comments);
  const quotedMarkers = parseQuotedMarkers(comments);
  const malformed = parseMalformedMentions(comments);
  const declared = parseDeclaredApprover(prBody);
  const quotedDeclared = parseQuotedApprover(prBody);
  const ownTicket = ownTicketFromRef(headRef);
  const head = (headSha ?? '').toLowerCase();

  if (!/^[0-9a-f]{40}$/.test(head)) {
    return {
      ok: false,
      markers,
      quotedMarkers,
      malformed,
      accepted: null,
      declared,
      ownTicket,
      head,
      reasons: [
        `the head commit was not readable as a 40-character SHA (got ${JSON.stringify(headSha)}). ` +
          'This is a defect in the check itself, not in the pull request — it cannot be ' +
          'satisfied until it is fixed, and it must not pass while it cannot see the head.'
      ]
    };
  }

  if (!declared) {
    reasons.push(
      'the pull request body does not declare an approver. Add a line of its own reading ' +
        '`BUTCHR-APPROVER: <type>/<KEY>`, naming the agent your ticket says approves you — ' +
        'the Story your task is linked to by an issue link, else the parent epic. Declaring ' +
        'it in advance is what stops a marker from an uninvolved agent counting.'
    );
    if (quotedDeclared) {
      reasons.push(
        `the body does name \`${quotedDeclared.approver}\` as approver, but inside ` +
          `${quotedDeclared.quotedAs}, where it is shown rather than declared. Move the ` +
          'declaration out to the top level of the body.'
      );
    }
  } else if (!AGENT.test(declared)) {
    reasons.push(
      `the declared approver \`${declared}\` is not a \`<type>/<KEY>\` agent name ` +
        '(e.g. `epic/KAN-59`).'
    );
  } else if (ownTicket && declared.endsWith(`/${ownTicket}`)) {
    reasons.push(
      `the pull request declares \`${declared}\` as its own approver, which is the ticket ` +
        `this branch is working (${ownTicket}). An agent does not approve its own work. ` +
        'If your ticket genuinely names no approver, that is a filing defect — say so on the ' +
        'ticket and do not merge.'
    );
  }

  if (markers.length === 0) {
    reasons.push(
      'no approval marker was found in any comment on this pull request. An approval is a ' +
        'comment containing, on a line of its own and at the top level of the comment: ' +
        '`BUTCHR-APPROVAL: <40-char-head-sha> BY <type>/<KEY>`. For this head that line is ' +
        'the following, which must be pasted UNINDENTED and NOT inside a code fence:\n' +
        // Deliberately not indented to line up with the reason above it. A
        // check printing its own suggestion indented by six spaces, in a design
        // where an indented marker is refused, would be this defect handing the
        // next agent a line that cannot work.
        canonicalMarker({ sha: head, approver: declared })
    );
  }

  const atHead = markers.filter((m) => m.sha === head);
  if (markers.length > 0 && atHead.length === 0) {
    const stale = [...new Set(markers.map((m) => m.sha))];
    reasons.push(
      `${markers.length} approval marker(s) were found, and none names this head. ` +
        `Head is ${head}; the markers name ${stale.map((s) => `${s.slice(0, 12)}…`).join(', ')}. ` +
        'A push — including `gh pr update-branch` — changes the head and therefore invalidates ' +
        'every approval given against the old one. Take the new head back to your approver.'
    );
  }

  const accepted = declared ? (atHead.find((m) => m.approver === declared) ?? null) : null;
  if (atHead.length > 0 && declared && !accepted) {
    reasons.push(
      'an approval marker names this head, but is signed by ' +
        `${[...new Set(atHead.map((m) => m.approver))].map((a) => `\`${a}\``).join(', ')} ` +
        `where this pull request declares \`${declared}\` as its approver. The agent that ` +
        'approves is the one the board names, and a marker from anybody else does not satisfy ' +
        'the check. If the declared approver is wrong, fix the pull request body.'
    );
  }

  // Explain a refusal caused by a quoted or malformed marker — and ONLY explain
  // it.
  //
  // THE GUARD IS THE POINT, NOT A TIDINESS. This block must never be what makes
  // a verdict fail, because `ok` is `reasons.length === 0`: pushing here
  // unconditionally would refuse a pull request that carries a real asserted
  // approval merely because some other comment on it also quotes a marker — and
  // a pull request that DISCUSSES this check is exactly the kind that would.
  // This one does. So it appends to an existing failure and is unreachable when
  // the check is satisfied.
  if (reasons.length > 0 && quotedMarkers.length > 0) {
    const atHeadQuoted = quotedMarkers.filter((m) => m.sha === head);
    const relevant = atHeadQuoted.length > 0 ? atHeadQuoted : quotedMarkers;
    reasons.push(
      `${quotedMarkers.length} well-formed marker(s) WERE found and every one of them was ` +
        'quoted rather than asserted, so none counted — the check reads what a comment ' +
        'ASSERTS, because a request for an approval is normally written by quoting the line ' +
        'being requested. ' +
        relevant
          .map(
            (m) =>
              `Comment ${m.commentId ?? '?'} names ${m.sha.slice(0, 12)}… by \`${m.approver}\` ` +
              `inside ${m.quotedAs}.`
          )
          .join(' ') +
        ' If you meant to approve, post the marker as a plain unindented line at the top level ' +
        'of a comment. If you were quoting it to ask for an approval, this refusal is correct ' +
        'and nothing is wrong.'
    );
  }

  // CRABCAST DECIDED: incident 2 gets its own reason. Same guard, same argument
  // — this never CAUSES a failure, it explains one.
  if (reasons.length > 0 && malformed.length > 0) {
    reasons.push(
      `${malformed.length} line(s) mention BUTCHR-APPROVAL at the top level of a comment and ` +
        'match none of the grammar. THE TOKEN IS NOT ENOUGH: the SHA must be all 40 ' +
        'characters, it must come BEFORE the approver, and the word `BY` must separate them. ' +
        malformed.map((m) => `Comment ${m.commentId ?? '?'} reads: ${JSON.stringify(m.line)}.`).join(' ') +
        ' The line this head needs is exactly: ' +
        canonicalMarker({ sha: head, approver: declared })
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    accepted,
    markers,
    quotedMarkers,
    malformed,
    declared,
    ownTicket,
    head
  };
}
