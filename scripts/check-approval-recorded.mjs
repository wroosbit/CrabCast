#!/usr/bin/env node
// The `approval-recorded` gate's entry point. KAN-402.
//
// Not named `verify-*`, so the proof-registry job neither runs it nor demands a
// register entry — it is a module with a `main`, like `ci-workflow.mjs`. The
// DECISION it publishes lives in `scripts/approval-marker.mjs` and is proven by
// `scripts/verify-approval-marker.mjs`; this file is the I/O around it.
//
// THAT SPLIT IS THE DESIGN AND NOT AN ACCIDENT OF FILING. `evaluate` is a pure
// function of (head SHA, head ref, PR body, comments), so it can be driven over
// fixtures in CI by a proof that needs no network, no token and no pull
// request. Everything that CANNOT be driven that way — reading the event,
// fetching the comments, publishing the status — is here, and this file is
// covered by running it against a real pull request rather than by a proof.
// Both halves say so; see WHAT NOTHING COVERS at the bottom.
//
// TWO MODES:
//
//   (default)   the CI gate. Reads the GitHub event, fetches the pull request
//               and its comments, and POSTs the `approval-recorded` commit
//               status at the head. Exits on GATE HEALTH — see `exitCodeFor`.
//
//   --check <N> an approver's own verification, from a terminal, against the
//               live pull request. Publishes nothing and needs no `statuses`
//               scope. Exits on the APPROVAL answer, because with no status
//               posted the exit code is the only carrier there is.
//
// WHY `--check` EXISTS, and it is the half KAN-402 asks for by name. The
// incident that commissioned this file was not only a malformed marker; it was
// an approver VERIFYING a malformed marker with `test("BUTCHR-APPROVAL")` — a
// substring match that returns >= 1 for any comment containing that word
// anywhere, fenced or not, in any arrangement. A green number was in hand and
// the handoff was broken. `--check` runs THE SAME `evaluate` the gate runs, so
// "I checked it" and "the gate will accept it" cannot be different answers.
// Checking a fix against a looser instrument than the one that will consume it
// is the defect; sharing the instrument is the fix.
//
// SECRETS. `GITHUB_TOKEN` is read from the environment at the point of use and
// sent in an Authorization header. It is never echoed, never passed as a
// command-line argument (arguments are visible in process listings and in logs
// alike) and never printed. Nothing token-derived appears in any output here.

import { evaluate, exitCodeFor, EXIT_ON, canonicalMarker } from './approval-marker.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const CONTEXT = 'approval-recorded';

/** Everything that went wrong with the GATE, as opposed to with the approval. */
const gateFaults = [];
function gateFault(why) {
  gateFaults.push(why);
  console.log(`GATE FAULT  ${why}`);
}

async function api(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set in the environment.');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) {
    // The body can carry a rate-limit or permission message worth reading, and
    // it never carries the token — GitHub does not echo the Authorization
    // header back.
    const detail = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText}. ${detail.slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Every comment on the pull request, following `Link: rel="next"` to the end.
 *
 * THE VACUITY GUARD IS THE RETURN SHAPE, NOT A COMMENT IN THIS FUNCTION. It
 * returns `{ comments, pages }`, and the caller reconciles `comments.length`
 * against the count the pull request object itself reports. A read that
 * silently stopped at page one would otherwise present as "no approval marker
 * was found" — a REAL-LOOKING red about the pull request, produced by a defect
 * in the gate. That is the same species as the substring verification above:
 * an instrument answering a question nobody asked, in the format of the answer
 * that was wanted.
 */
async function allComments(owner, repo, number) {
  const comments = [];
  let page = 1;
  let pages = 0;
  for (;;) {
    const batch = await api(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    pages += 1;
    if (!Array.isArray(batch)) throw new Error(`comments page ${page} was not an array`);
    comments.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 50) throw new Error('refusing to page past 5000 comments; something is wrong');
  }
  return { comments, pages };
}

/** The pull request this run is about, from the event payload. */
async function resolvePullRequest() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set as owner/repo.');

  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set.');
  const { readFileSync } = await import('node:fs');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));

  let number = null;
  if (eventName === 'pull_request') number = event.pull_request?.number ?? null;
  else if (eventName === 'issue_comment') {
    // An `issue_comment` fires for ordinary issues too, and this gate has no
    // opinion about issues. The workflow-level `if` is an optimisation; this is
    // the guard.
    if (!event.issue?.pull_request) return { owner, repo, skip: 'the comment is on an issue, not a pull request' };
    number = event.issue?.number ?? null;
  } else if (eventName === 'push') {
    return { owner, repo, skip: `nothing to evaluate on a ${eventName} event` };
  } else {
    return { owner, repo, skip: `unhandled event \`${eventName}\`` };
  }

  if (!Number.isInteger(number)) throw new Error(`could not read a pull request number off a ${eventName} event.`);
  return { owner, repo, number };
}

/**
 * Publish the verdict at the head.
 *
 * WHY A COMMIT STATUS AND NOT THIS JOB'S CONCLUSION. A workflow triggered by
 * `issue_comment` attaches its check run to the DEFAULT BRANCH, not to the pull
 * request head — so a job whose name was the required context would report to
 * the right place on one trigger and the wrong place on the other. A POSTed
 * status lands at the head every time, and the newest POST for a context wins,
 * which is what lets an approval RETRACT the failure the opening push wrote.
 * The full argument is on `exitCodeFor` in `approval-marker.mjs`.
 */
async function publish(owner, repo, sha, { ok, reasons }) {
  // The description is what a reader meets on the pull request's own checks
  // list, so it carries the limit rather than only the verdict. 140 characters
  // is GitHub's cap and it truncates silently.
  const description = ok
    ? 'A comment names this head as approved. Not a gate: the author can write this marker.'
    : (reasons[0] ?? 'not approved').replace(/\s+/g, ' ').slice(0, 140);

  await api(`/repos/${owner}/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state: ok ? 'success' : 'failure',
      context: CONTEXT,
      description,
      target_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined
    })
  });
}

/**
 * The paragraph a reader meets when this check is red or green, in the check's
 * own voice. KAN-402 acceptance criterion 4 asks for exactly this, and asks
 * that it say what the check ESTABLISHES rather than that it gates anything.
 */
function printWhatThisIs() {
  console.log('');
  console.log('WHAT `approval-recorded` ESTABLISHES, AND WHAT IT DOES NOT');
  console.log('  IT ESTABLISHES  that a comment on this pull request names THIS EXACT HEAD as');
  console.log('                  approved, by the agent the pull request body declares. A missing');
  console.log('                  approval, a malformed one, and one given against a superseded');
  console.log('                  head are each a RED CHECK naming the reason, where each of them');
  console.log('                  was previously a SILENCE indistinguishable from "not yet given".');
  console.log('  IT DOES NOT     stop a determined author. Every agent here authenticates as the');
  console.log('                  same GitHub account, so the author of this pull request can post');
  console.log('                  this marker themselves and nothing can tell that comment from the');
  console.log('                  real one. THE MERGE BUTTON IS OPEN TO THE AUTHOR. What changed is');
  console.log('                  that taking it now leaves a head-pinned record where it left');
  console.log('                  nothing at all.');
  console.log('  IT IS ADVISORY  until somebody with branch-protection admin makes this context');
  console.log('                  required. Until then it blocks no merge. Do not read a red check');
  console.log('                  here as a blocked pull request, and do not describe it as one.');
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const checkAt = argv.indexOf('--check');
  const mode = checkAt >= 0 ? EXIT_ON.APPROVAL : EXIT_ON.GATE_HEALTH;

  let owner;
  let repo;
  let number;

  if (checkAt >= 0) {
    const arg = argv[checkAt + 1];
    const slug = process.env.GITHUB_REPOSITORY ?? 'wroosbit/CrabCast';
    [owner, repo] = slug.split('/');
    number = Number.parseInt(arg ?? '', 10);
    if (!Number.isInteger(number)) {
      console.error('usage: node scripts/check-approval-recorded.mjs --check <pr-number>');
      console.error('       (GITHUB_TOKEN in the environment; GITHUB_REPOSITORY to override the repo)');
      process.exit(2);
    }
  } else {
    const resolved = await resolvePullRequest();
    if (resolved.skip) {
      console.log(`SKIP  ${resolved.skip}. Nothing published, nothing asserted.`);
      process.exit(0);
    }
    ({ owner, repo, number } = resolved);
  }

  const pr = await api(`/repos/${owner}/${repo}/pulls/${number}`);

  // THE HEAD IS READ FROM THE PULL REQUEST, NOT FROM THE EVENT. An
  // `issue_comment` event carries no head at all, and a `pull_request` event's
  // payload is a snapshot from when the event fired — which on a busy branch is
  // not necessarily the head now. The whole value of this check is that it
  // names one commit, so it asks the API which commit that is at the moment it
  // decides.
  const headSha = pr?.head?.sha;
  const headRef = pr?.head?.ref;

  const { comments, pages } = await allComments(owner, repo, number);

  // THE VACUITY GUARD, WITH ITS OWN EXIT CODE. `pr.comments` is GitHub's own
  // count of issue comments on this pull request. If what we read disagrees
  // with it, we did not read the conversation — and a verdict computed over a
  // conversation we did not read must not be published in the same words as one
  // computed over the whole of it. This is a GATE fault, so it exits non-zero
  // under BOTH modes and no status is posted.
  const declaredCount = typeof pr?.comments === 'number' ? pr.comments : null;
  if (declaredCount === null) {
    gateFault('the pull request object carried no `comments` count, so there is nothing to reconcile the read against.');
  } else if (comments.length !== declaredCount) {
    gateFault(
      `read ${comments.length} comment(s) over ${pages} page(s), but the pull request reports ` +
        `${declaredCount}. The conversation was not read completely, so any verdict computed ` +
        'from it would be a claim about a subset wearing the words of a claim about the whole.'
    );
  } else {
    console.log(`read ${comments.length} comment(s) over ${pages} page(s), matching the count the pull request reports.`);
  }

  const verdict = evaluate({ headSha, headRef, prBody: pr?.body ?? '', comments });

  console.log('');
  console.log(`pull request : ${owner}/${repo}#${number}`);
  console.log(`head         : ${headSha} (${headRef})`);
  console.log(`declared     : ${verdict.declared ?? '(none)'}`);
  console.log(`markers      : ${verdict.markers.length} asserted, ${verdict.quotedMarkers.length} quoted, ${verdict.malformed.length} malformed`);
  console.log('');
  console.log(`approval-recorded : ${verdict.ok ? 'SUCCESS — this head is approved' : 'FAILURE — this head is not approved'}`);
  if (verdict.accepted) {
    console.log(`accepted marker   : comment ${verdict.accepted.commentId ?? '?'} by \`${verdict.accepted.approver}\``);
  }
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  if (!verdict.ok && verdict.declared && /^[0-9a-f]{40}$/.test(verdict.head)) {
    console.log('');
    console.log('The line that would satisfy it, to be posted UNINDENTED and OUTSIDE any code fence:');
    console.log(canonicalMarker({ sha: verdict.head, approver: verdict.declared }));
  }

  if (mode === EXIT_ON.GATE_HEALTH) {
    if (gateFaults.length === 0) {
      try {
        await publish(owner, repo, headSha, verdict);
        console.log('');
        console.log(`published \`${CONTEXT}\` = ${verdict.ok ? 'success' : 'failure'} at ${headSha}`);
      } catch (err) {
        gateFault(`could not publish the status (${err?.message ?? err}).`);
      }
    } else {
      console.log('');
      console.log('NOT PUBLISHING: the gate is faulted, and a gate that cannot see the whole');
      console.log('conversation must not overwrite a status with a verdict it cannot stand behind.');
    }
  }

  printWhatThisIs();

  // THE JOB'S GREEN IS ABOUT THE GATE, NOT ABOUT THE APPROVAL — say so in the
  // log, because the failure mode of this whole arrangement is a reader who
  // takes a green job for an approval.
  if (mode === EXIT_ON.GATE_HEALTH) {
    console.log(
      gateFaults.length === 0
        ? `THIS JOB IS GREEN because the gate ran and published its answer. The ANSWER is the \`${CONTEXT}\` status above, and it is ${verdict.ok ? 'SUCCESS' : 'FAILURE'}. A green job is not an approval.`
        : `THIS JOB IS RED because the GATE is broken — ${gateFaults.length} fault(s) above. That is not a statement about whether this pull request is approved; nothing was published.`
    );
  }

  process.exit(exitCodeFor({ gateHealthy: gateFaults.length === 0, approved: verdict.ok, exitOn: mode }));
}

// ---------------------------------------------------------------------------
// WHAT NOTHING COVERS, named rather than left to be inferred (KAN-402).
//
// `verify-approval-marker.mjs` proves the DECISION over fixtures it supplies.
// It does not exercise a single line of this file: not `resolvePullRequest`,
// not `allComments`' pagination, not `publish`, and not the vacuity
// reconciliation above. A proof that supplies its own input has not tested that
// the input arrives, and the input arriving is exactly what this file does.
//
// WHAT COVERS IT INSTEAD: running it against a real pull request, with the
// output pasted on that pull request. The KAN-402 pull request carries a run
// against itself in three states — no marker, a stale marker, and a current one
// — which is the only evidence that the event, the head read and the status
// POST work at all. If you change this file, produce that evidence again; there
// is no script that will notice for you.
// ---------------------------------------------------------------------------

main().catch((err) => {
  // A crash is a GATE fault, and the fail-closed direction is to say so loudly
  // and publish nothing. An unhandled rejection that exited 0 would be a gate
  // reporting health it never established.
  console.error(`GATE FAULT  ${err?.stack ?? err}`);
  process.exit(1);
});
