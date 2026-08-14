#!/usr/bin/env node
// Proof for KAN-402: the approval decision in `scripts/approval-marker.mjs`
// accepts exactly the canonical marker at the current head from the declared
// approver, and refuses every other shape the epic has actually posted.
//
// WHAT FAILURE THIS WOULD CATCH — five of them, and every one is an OBSERVED
// event on this epic rather than a shape somebody imagined:
//
//   1. NO MARKER AT ALL reading as approved. `#107` carried
//      `APPROVED at <sha> — merge it.`, which is a complete and correct
//      approval that no machine could see. It sat ten minutes.
//
//   2. A MARKER CARRYING THE TOKEN IN THE WRONG ARRANGEMENT reading as
//      approved. `#108` carried `BUTCHR-APPROVAL: epic/KAN-59 — APPROVED at
//      <sha> — merge it.` — token present, SHA present and correct, approver
//      present and correct, `BY` absent and the order reversed. It sat thirteen
//      minutes. THIS IS THE CASE THE OBVIOUS CHECK GETS WRONG: a substring test
//      for the token greens on it.
//
//   3. A MARKER FOR A SUPERSEDED HEAD reading as approved. `#107`'s head moved
//      `a410196c` -> `04a13cb9` mid-review. Nothing went wrong only because the
//      marker happened to be posted after the move.
//
//   4. A QUOTED MARKER reading as approved. The natural way to REQUEST an
//      approval is to paste the line you are requesting, inside a fence. A
//      grammar that matches "a line of its own" matches that too, and the check
//      goes green describing an approval nobody gave. It needs no intent, and it
//      fires precisely when somebody is explaining the check — which is when it
//      is being relied on.
//
//   5. A MARKER FROM THE WRONG AGENT reading as approved.
//
// AND THE SIXTH, WHICH IS WHY THIS FILE EXISTS RATHER THAN A README SECTION.
// After failure 1 the reviewer added the token and VERIFIED the fix with
// `[.comments[] | select(.body | test("BUTCHR-APPROVAL"))] | length` -> 2. That
// query returns >= 1 for any comment containing that word anywhere, in any
// arrangement, fenced or not. The fix was checked against the loosest
// instrument that would pass it, the number came back green, and the handoff
// was still broken. A CHECK WHOSE SENTENCE OUTRUNS ITS MECHANISM IS THE DEFECT
// THIS EPIC EXISTS TO FIND, and it was committed here by the epic agent twice
// in twenty minutes. §7 is the answer to it: every acceptance case below is
// re-run against a build with the corresponding behaviour REMOVED, and required
// to flip. An assertion that has only ever been observed passing is evidence of
// nothing.
//
// ---------------------------------------------------------------------------
// HOW THE FIXTURES ARE BUILT, and why they are derived rather than written out
// ---------------------------------------------------------------------------
//
// THE HEADS ARE THIS REPOSITORY'S OWN COMMITS. `HEAD` and `HEAD~1`, read from
// git at run time. A hand-written 40-character string would be a constant
// maintained beside a self-deriving loop, and it would also be a SHA that never
// existed — so "a marker for a superseded head" would be tested against a
// commit no push could ever have produced. Two real, adjacent commits are the
// same relation the defect had.
//
// THE ACCEPTED MARKER COMES FROM `canonicalMarker`, which is also what the
// check PRINTS when it refuses. One constructor, so the line the check suggests
// and the line the check accepts cannot drift apart — which is failures 1 and 2
// in one sentence.
//
// THE REFUSED MARKERS ARE TRANSCRIBED FROM THE INCIDENTS, verbatim, and that is
// deliberately NOT derived. Generating the wrong shapes from the same
// constructor that generates the right one would test the constructor's inverse
// rather than the grammar, and would drift with it. The malformed line below is
// what was really posted on `#108`, with the real SHA substituted.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROOF DOES NOT COVER, named rather than left to be inferred
// ---------------------------------------------------------------------------
//
// IT SUPPLIES ITS OWN COMMENTS. Every fixture below is an array this file
// builds, so this establishes that the DECISION is correct about a conversation
// it is handed and NOT that any conversation arrives. Reading the GitHub event,
// paging the comments, reconciling the count and POSTing the status are all in
// `scripts/check-approval-recorded.mjs`, and NOTHING HERE EXECUTES ONE LINE OF
// THAT FILE. That is the KAN-145 seam — two proofs each honest about themselves
// with the gap between them owned by neither — so it is named here and named
// there, and what covers it is a run against a real pull request with the output
// pasted on it. There is no script that will notice for you.
//
// IT ALSO DOES NOT ESTABLISH THAT THE MARKER IS TRUE. Under one shared GitHub
// identity the author of a pull request can post a well-formed marker naming
// their own declared approver, and every assertion in this file passes on it,
// correctly. The check catches omission, staleness and malformation. It does not
// catch forgery and cannot; that needs per-agent identities (KAN-366).

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';
import {
  canonicalMarker,
  evaluate,
  exitCodeFor,
  EXIT_ON,
  MARKER_TEMPLATE,
  parseMalformedMentions,
  parseMarkers,
  parseQuotedMarkers,
  QUOTED,
  scanQuoted
} from './approval-marker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(repoRoot, 'scripts', 'approval-marker.mjs');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan402-'));
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
// The derived heads. A PRECONDITION rather than a convenience: if git hands
// back something that is not a 40-character SHA, every fixture below is built
// on sand and the run must say so rather than proceed.
// ---------------------------------------------------------------------------

function rev(ref) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', ref], { encoding: 'utf8' }).trim();
}

let HEAD;
let OLD_HEAD;
try {
  HEAD = rev('HEAD');
  OLD_HEAD = rev('HEAD~1');
} catch (err) {
  check(false, '(setup) two real commits are readable from git for the head fixtures', String(err?.message ?? err));
  console.log('\n1 CHECK(S) FAILED');
  process.exit(1);
}

const shaLike = (s) => /^[0-9a-f]{40}$/.test(s);
check(
  shaLike(HEAD) && shaLike(OLD_HEAD) && HEAD !== OLD_HEAD,
  '(setup) HEAD and HEAD~1 are two DIFFERENT 40-character SHAs',
  `${HEAD.slice(0, 12)}… vs ${OLD_HEAD.slice(0, 12)}…`
);
if (!(shaLike(HEAD) && shaLike(OLD_HEAD) && HEAD !== OLD_HEAD)) {
  console.log('\n1 CHECK(S) FAILED — every fixture below would be built from nothing');
  process.exit(1);
}

const APPROVER = 'epic/KAN-59';
const HEAD_REF = 'butchr/KAN-402';
const BODY = `Implements KAN-402.\n\nBUTCHR-APPROVER: ${APPROVER}\n`;

/** The canonical line at the current head — the ONE shape that must be accepted. */
const GOOD = canonicalMarker({ sha: HEAD, approver: APPROVER });

/**
 * The malformed line, transcribed from what was really posted on `#108` with
 * this run's head substituted for the SHA it carried. Token present, SHA
 * present and correct, approver present and correct, `BY` absent, order
 * reversed.
 */
const MALFORMED = `BUTCHR-APPROVAL: ${APPROVER} — APPROVED at ${HEAD} — merge it.`;

/** The `#107` shape: a correct approval carrying no token at all. */
const NO_TOKEN = `APPROVED at ${HEAD} — merge it.`;

const pr = (comments, body = BODY, headSha = HEAD) =>
  evaluate({ headSha, headRef: HEAD_REF, prBody: body, comments });

const comment = (id, body) => ({ id, body, user: { login: 'wroosbit' } });

// ===========================================================================
console.log('\n§0  THE SPEC ANCHOR — we still speak the language the pollers speak');
// ===========================================================================
//
// WHY THIS SECTION EXISTS, and it is a defect this proof did not have on its
// first submission. `epic/KAN-59` found it in review of KAN-402: the format
// DESCRIPTION printed in a reason string was a hand-written literal sitting
// beside the self-deriving `canonicalMarker`, which is KAN-245's class. They
// measured it rather than asserting it — renaming `BY` to `SIGNED-BY` at all
// three sites at once (both regexes and the constructor) — and the suite
// reported ALL CHECKS PASSED while one reason string described one grammar and
// suggested a line in another.
//
// A CONSISTENT DRIFT IS NOT A LOOSENING, which is why nothing else in this file
// can see it. §7's mutations all widen what is accepted. §1d and §1e are
// transcribed from incidents and are refused under EITHER grammar, so neither
// constrains the token order at all. Every fixture below §0 is generated from
// the module under test, so a module that changed its mind about the grammar
// changes the fixtures with it and stays green.
//
// SO THE ANCHOR HAS TO COME FROM OUTSIDE THE MODULE, AS TEXT. `SPEC_LINE` below
// is a literal transcription — retyped, not imported, not derived — of the line
// mandated by `prompts/task.md` in `wroosbit/butchr`, read at `origin/main`
// commit `5299e30`:
//
//     "a required check called `approval-recorded` now goes green only when a PR
//      comment carries, on a line of its own, `BUTCHR-APPROVAL:
//      <full-40-char-head-sha> BY <type>/<KEY>` naming the approver your PR body
//      declares in a `BUTCHR-APPROVER:` line."
//
// THE PROPERTY THIS BUYS is not "the check is correct". It is narrower and it is
// the one that matters here: **the shape this repository accepts is the shape
// the fleet's agents are instructed to write and poll for.** Nothing else in
// this tree can say that, and until this section existed only a human re-reading
// two repositories could.
//
// THE FAILURE IT ADMITS is this ticket inverted: the check greens on a shape no
// agent polls for, a marker in the real spec shape goes red, the approver reads
// the red as the gate being broken, and the author merges anyway. That is the
// pull request body's own "a second incompatible spelling would reintroduce this
// exact defect, to every agent at once" — arriving through the GRAMMAR instead
// of through the token.
//
// ⚠ THIS IS A COUPLING, DELIBERATELY, AND IT IS THE ONE PLACE IT LIVES. If
// `prompts/task.md` ever changes the line, THIS SECTION IS WHAT GOES RED, and
// that is the intended behaviour rather than a maintenance cost to route around:
// the red is the notification. Change `SPEC_LINE` to the new transcription, in
// the same commit that changes the grammar, and say on the ticket that the
// fleet's agents need the same move. Do not delete it to make a red go away.

/** Retyped from `prompts/task.md`. NOT imported, NOT derived. */
const SPEC_LINE = 'BUTCHR-APPROVAL: <full-40-char-head-sha> BY <type>/<KEY>';

check(
  MARKER_TEMPLATE === SPEC_LINE,
  '§0  the module\'s own format description is the spec line, character for character',
  `module: ${JSON.stringify(MARKER_TEMPLATE)} · spec: ${JSON.stringify(SPEC_LINE)}`
);

{
  // The template with its placeholders filled must be exactly what the
  // constructor builds — so the description and the concrete line are one
  // grammar rather than two that happen to agree.
  const instantiated = SPEC_LINE.replace('<full-40-char-head-sha>', HEAD).replace('<type>/<KEY>', APPROVER);
  check(
    canonicalMarker({ sha: HEAD, approver: APPROVER }) === instantiated,
    '§0  the constructor builds the SPEC LINE instantiated, not merely something self-consistent',
    instantiated
  );
  // …and the grammar accepts that literal string. This is the assertion that
  // fails under a consistent rename: the fixture is built from the transcription
  // rather than from the module.
  const v = evaluate({ headSha: HEAD, headRef: HEAD_REF, prBody: BODY, comments: [{ id: 0, body: instantiated }] });
  check(v.ok, '§0  and the grammar ACCEPTS the spec line built from the transcription', v.ok ? '' : v.reasons[0]);
}

// ===========================================================================
console.log('\n§1  THE FIVE ACCEPTANCE CASES — driven, not described');
// ===========================================================================

const cases = [
  {
    id: 'a-absent',
    why: 'no marker at all (#107: a correct approval no machine could see)',
    comments: [comment(1, `Reviewed the diff and re-ran the proof.\n\n${NO_TOKEN}`)],
    approved: false,
    reasonMustSay: 'no approval marker was found'
  },
  {
    id: 'b-stale',
    why: 'a well-formed marker naming a SUPERSEDED head (#107: a410196c -> 04a13cb9)',
    comments: [comment(2, `Looks right.\n\n${canonicalMarker({ sha: OLD_HEAD, approver: APPROVER })}`)],
    approved: false,
    reasonMustSay: 'none names this head'
  },
  {
    id: 'c-current',
    why: 'the canonical marker at the CURRENT head from the DECLARED approver',
    comments: [comment(3, `Re-ran the acceptance proof against this head. Approving.\n\n${GOOD}`)],
    approved: true,
    reasonMustSay: null
  },
  {
    id: 'd-malformed',
    why: 'the token in the WRONG FORMAT (#108: order reversed, no BY) — the case a substring test greens',
    comments: [comment(4, MALFORMED)],
    approved: false,
    reasonMustSay: 'THE TOKEN IS NOT ENOUGH'
  },
  {
    id: 'e-quoted',
    why: 'a correctly-shaped marker SHOWN rather than asserted — inside a fence',
    comments: [comment(5, `Post this when you are happy:\n\n\`\`\`\n${GOOD}\n\`\`\`\n`)],
    approved: false,
    reasonMustSay: 'quoted rather than asserted'
  }
];

for (const c of cases) {
  const v = pr(c.comments);
  check(v.ok === c.approved, `§1${c.id}  approved=${c.approved} — ${c.why}`, v.ok ? 'accepted' : v.reasons[0]?.slice(0, 110));
  if (c.reasonMustSay) {
    check(
      v.reasons.some((r) => r.includes(c.reasonMustSay)),
      `§1${c.id}  the refusal SAYS WHY, naming ${JSON.stringify(c.reasonMustSay)}`,
      'a red check whose reason an approver cannot act on is the silence this ticket is about'
    );
  }
}

// The other three display contexts, same canonical line. Each must refuse.
for (const [label, body] of [
  ['a blockquote', `Requesting:\n\n> ${GOOD}\n`],
  ['an indented block', `Requesting:\n\n    ${GOOD}\n`],
  ['an HTML comment', `Requesting:\n\n<!--\n${GOOD}\n-->\n`]
]) {
  const v = pr([comment(6, body)]);
  check(!v.ok, `§1e  a canonical marker inside ${label} is SHOWN, not asserted, and is refused`);
}

// ===========================================================================
console.log('\n§2  THE FALSE-POSITIVE CONTROLS, AND A CONTROL ON THE CONTROL');
// ===========================================================================
//
// A check that refuses everything passes §1 except case (c). These are the
// assertions that separate "reads the marker" from "says no a lot", and the
// last pair is the control on the control: two fixtures differing by ONE
// CHARACTER, with opposite required verdicts. A harness that ignored its input
// — or a grammar that matched on the token alone — fails exactly one of them.

{
  // The marker as DATA: this very pull request's body documents the format.
  // Documentation of a format necessarily contains the format.
  const v = pr([comment(7, `The gate reads \`${GOOD}\` only at top level.`)]);
  check(!v.ok, '§2  the canonical line INSIDE INLINE CODE in prose is not an approval');
}

{
  // …and the direction that matters more: a REAL approval must survive being on
  // a pull request that ALSO quotes the marker somewhere. This pull request does
  // exactly that, so a rule that refused on the presence of any quoted marker
  // would refuse its own change.
  const v = pr([
    comment(8, `For reference the shape is:\n\n\`\`\`\n${GOOD}\n\`\`\`\n`),
    comment(9, `Re-ran the proof at this head. Approving.\n\n${GOOD}`)
  ]);
  check(v.ok, '§2  an ASSERTED marker is still accepted when another comment QUOTES one', 'the quoted-marker reason must explain a refusal, never cause one');
  check(
    v.markers.length === 1 && v.quotedMarkers.length === 1,
    '§2  …and the two are counted separately',
    `asserted=${v.markers.length} quoted=${v.quotedMarkers.length}`
  );
}

{
  // THE CONTROL ON THE CONTROL. One character apart, opposite verdicts.
  const oneOff = `${HEAD.slice(0, 39)}${HEAD[39] === 'a' ? 'b' : 'a'}`;
  check(shaLike(oneOff) && oneOff !== HEAD, '§2  (setup) the one-character-off SHA is still SHA-shaped and is not the head');
  const good = pr([comment(10, GOOD)]);
  const off = pr([comment(10, canonicalMarker({ sha: oneOff, approver: APPROVER }))]);
  check(
    good.ok && !off.ok,
    '§2  CONTROL ON THE CONTROL: two fixtures one character apart get OPPOSITE verdicts',
    `head marker -> ${good.ok ? 'approved' : 'refused'}; one-character-off marker -> ${off.ok ? 'approved' : 'refused'}`
  );
}

{
  // An abbreviated SHA is refused rather than resolved: seven characters name a
  // commit only relative to a repository state, and the whole value here is that
  // an approval names one commit for all time.
  const v = pr([comment(11, `BUTCHR-APPROVAL: ${HEAD.slice(0, 7)} BY ${APPROVER}`)]);
  check(!v.ok, '§2  an ABBREVIATED SHA is refused rather than resolved');
}

// ===========================================================================
console.log('\n§3  THE APPROVER HALF — decided here, and this is the decision');
// ===========================================================================
//
// KAN-402 left question 2 open: whether the check also asserts that the marker's
// signer matches the pull request body's `BUTCHR-APPROVER:` line, or whether
// "some comment names THIS head as approved" is enough.
//
// DECIDED: IT ASSERTS THE SIGNER. The rejected option is the minimum — any
// well-formed marker at the head, whoever signed it. It is rejected because the
// board is shared: several agents watch a pull request, and an approval is a
// COMMENT, so a marker from an agent that merely happens to be reading would
// satisfy the minimum. Requiring the author to name their approver IN ADVANCE,
// before any approval exists, costs one line in the pull request body and is the
// only thing here that ties the marker to the agent the BOARD says owns the
// review. It is not authentication — see the forgery limit — but it does mean
// the author has to commit to an answer before they can be given one.
//
// THE COST OF THE DECISION, stated because it is real: a pull request that omits
// the declaration is refused even when a perfectly good approval is sitting on
// it. That is the fail-closed direction and the reason names the missing line.

{
  const v = pr([comment(12, GOOD)], 'Implements KAN-402.\n');
  check(!v.ok, '§3  a pull request that declares NO approver is refused even with a good marker');
  check(v.reasons.some((r) => r.includes('does not declare an approver')), '§3  …and the reason names the missing line');
}
{
  const v = pr([comment(13, canonicalMarker({ sha: HEAD, approver: 'epic/KAN-39' }))]);
  check(!v.ok, '§3  a marker at the head signed by an agent the body did NOT declare is refused');
  check(v.reasons.some((r) => r.includes('is signed by')), '§3  …and the reason names both agents');
}
{
  // An agent does not approve its own work, and the branch name is what says
  // whose work it is.
  const v = pr([comment(14, canonicalMarker({ sha: HEAD, approver: 'task/KAN-402' }))], `BUTCHR-APPROVER: task/KAN-402\n`);
  check(!v.ok, '§3  a pull request declaring ITS OWN ticket as approver is refused');
  check(v.reasons.some((r) => r.includes('does not approve its own work')), '§3  …and the reason says why');
}
{
  // The use/mention defect one field over: a body that SHOWS the declaration as
  // an example must not have the example win.
  const v = pr([comment(15, GOOD)], `Declare your approver like:\n\n\`\`\`\nBUTCHR-APPROVER: epic/KAN-59\n\`\`\`\n`);
  check(!v.ok, '§3  a DECLARATION shown inside a fence does not declare');
  check(v.reasons.some((r) => r.includes('shown rather than declared')), '§3  …and the reason distinguishes shown from declared');
}

// ===========================================================================
console.log('\n§4  FORCE-PUSH BEHAVIOUR — decided here, and stated rather than left to fall out');
// ===========================================================================
//
// KAN-402 left question 3 open and asked for it to be a DECISION rather than a
// consequence of pinning the SHA.
//
// DECIDED: A NEW HEAD INVALIDATES EVERY PRIOR APPROVAL, unconditionally, by any
// route that moves the head — a force-push, an ordinary push, and
// `gh pr update-branch` alike. The check has no notion of "the change was
// trivial" and will not be given one: the approval names a commit, and a
// different commit is a different thing, whatever the diff between them looks
// like. The rejected option is a check that compares TREES so that a rebase with
// no content change keeps its approval. It is rejected because it re-introduces
// exactly the reasoning this ticket is about — a mechanism whose sentence
// ("this head was reviewed") outruns what it establishes ("something with this
// content was reviewed"), and because the reviewer's own account of `#107` is
// that the head moved when the AUTHOR PUSHED A FIX FOR A FINDING, which is
// precisely the case a tree comparison would wave through.

{
  const before = pr([comment(16, GOOD)]);
  const after = pr([comment(16, GOOD)], BODY, OLD_HEAD); // same comment, different head
  check(
    before.ok && !after.ok,
    '§4  the SAME marker is accepted at its own head and refused once the head moves',
    'nothing about the comment changed; only which commit the check was asked about'
  );
  check(
    after.reasons.some((r) => r.includes('invalidates')),
    '§4  …and the reason tells the reader to take the new head back to the approver'
  );
}

// ===========================================================================
console.log('\n§5  THE SCANNER, DRIVEN DIRECTLY');
// ===========================================================================
//
// A scanner tested only through `evaluate` is one whose every failure looks like
// an approval failure. These drive `scanQuoted` itself, so a labelling bug is
// reported as a labelling bug.

{
  const body = ['plain', '```', 'fenced', '```', '> quoted', '    indented', '<!--', 'hidden', '-->', 'plain again'];
  const labels = scanQuoted(body.join('\n'));
  const expect = [
    null,
    QUOTED.FENCED_CODE,
    QUOTED.FENCED_CODE,
    QUOTED.FENCED_CODE,
    QUOTED.BLOCKQUOTE,
    QUOTED.INDENTED_CODE,
    QUOTED.HTML_COMMENT,
    QUOTED.HTML_COMMENT,
    QUOTED.HTML_COMMENT,
    null
  ];
  check(
    JSON.stringify(labels) === JSON.stringify(expect),
    '§5  every display context is labelled, and the lines around them are not',
    JSON.stringify(labels)
  );
}
{
  // A ``` inside a ```` block is CONTENT, not a terminator — which is how a
  // worked example of this very check gets written, so it is the case most
  // likely to occur here.
  const labels = scanQuoted(['````', '```', GOOD, '```', '````', 'out'].join('\n'));
  check(
    labels.slice(0, 5).every((l) => l === QUOTED.FENCED_CODE) && labels[5] === null,
    '§5  a shorter fence inside a longer one does not close it'
  );
}
{
  // An unclosed fence runs to the end — CommonMark's own rule, and the
  // fail-closed direction.
  const labels = scanQuoted(['```', GOOD, 'still fenced'].join('\n'));
  check(labels.every((l) => l === QUOTED.FENCED_CODE), '§5  an UNCLOSED fence runs to the end of the comment');
}
{
  // Three spaces is not an indented block; the grammar has always tolerated it.
  const v = pr([comment(17, `   ${GOOD}`)]);
  check(v.ok, '§5  three spaces of indentation is not a code block, and the marker still counts');
}
{
  const found = parseMalformedMentions([comment(18, MALFORMED)]);
  check(found.length === 1 && found[0].line === MALFORMED, '§5  the malformed line is reported VERBATIM so the approver sees what they wrote');
  const none = parseMalformedMentions([comment(19, GOOD)]);
  check(none.length === 0, '§5  …and a WELL-FORMED marker is never reported as malformed');
  const fenced = parseMalformedMentions([comment(20, `\`\`\`\n${MALFORMED}\n\`\`\``)]);
  check(fenced.length === 0, '§5  …and a malformed line inside a fence is somebody quoting, not somebody trying');
}

// ===========================================================================
console.log('\n§6  THE EXIT-CODE POLICY');
// ===========================================================================
//
// One pure function decides which failures are the JOB'S, so the two carriers
// cannot be quietly re-conflated. A gate that could not publish is a job failure
// under BOTH modes; the mode chooses only who carries the APPROVAL answer.

check(exitCodeFor({ gateHealthy: true, approved: false, exitOn: EXIT_ON.GATE_HEALTH }) === 0,
  '§6  gate-health: an UNAPPROVED pull request is a GREEN job (the status carries the no)');
check(exitCodeFor({ gateHealthy: true, approved: true, exitOn: EXIT_ON.GATE_HEALTH }) === 0,
  '§6  gate-health: an approved pull request is a green job');
check(exitCodeFor({ gateHealthy: false, approved: true, exitOn: EXIT_ON.GATE_HEALTH }) === 1,
  '§6  gate-health: a BROKEN GATE is red even when the pull request is approved');
check(exitCodeFor({ gateHealthy: false, approved: false, exitOn: EXIT_ON.APPROVAL }) === 1,
  '§6  approval: a broken gate is red under this mode too — fail closed');
check(exitCodeFor({ gateHealthy: true, approved: false, exitOn: EXIT_ON.APPROVAL }) === 1,
  '§6  approval (`--check`): with no status posted, the exit code IS the answer');
check(exitCodeFor({ gateHealthy: true, approved: true, exitOn: EXIT_ON.APPROVAL }) === 0,
  '§6  approval (`--check`): approved is 0');

for (const bad of [
  { gateHealthy: 'yes', approved: true, exitOn: EXIT_ON.GATE_HEALTH },
  { gateHealthy: true, approved: true, exitOn: 'whatever' }
]) {
  let threw = false;
  try {
    exitCodeFor(bad);
  } catch {
    threw = true;
  }
  check(threw, `§6  a typo is a LOUD CRASH rather than a silently-chosen branch (${JSON.stringify(bad.exitOn)}, ${typeof bad.gateHealthy})`);
}

// ===========================================================================
console.log('\n§7  THE MUTATIONS — every §1 case re-run against a build with the behaviour removed');
// ===========================================================================
//
// This is the section that answers the sixth failure in the header. Each
// mutation removes ONE behaviour from a copy of `approval-marker.mjs` and
// requires the corresponding §1 case to FLIP. A case that stays refused under a
// mutation that should have let it through was never measuring that behaviour.
//
// EACH MUTATION RE-MEASURES ITS OWN PRECONDITION FIRST: the accepted case (c)
// must still be accepted by the mutant. A mutant that broke everything would
// satisfy "the refusal flipped" for the wrong reason — it would not be a looser
// check, it would be a different one.

async function withMutant(name, edits, fn) {
  const mutantPath = mutator.mutateScript(name, MODULE, edits);
  if (!mutantPath) return; // already counted as a failure by the helper
  const mod = await import(`file://${mutantPath}`);
  const at = (comments, body = BODY, headSha = HEAD) =>
    mod.evaluate({ headSha, headRef: HEAD_REF, prBody: body, comments });

  // The precondition: this mutant is a LOOSER check, not a broken one.
  const control = at([comment(90, GOOD)]);
  check(control.ok, `§7 ${name}  (precondition) the mutant still ACCEPTS the canonical marker`,
    control.ok ? '' : 'the mutant is broken rather than loosened, so the flip below would prove nothing');
  if (!control.ok) return;

  await fn(at);
}

// M1 — the substring check. This is not an invented mutation: it is the
// instrument the epic agent actually verified their fix with, reproduced. It
// must let the MALFORMED marker (#108) through.
//
// IT MUTATES THE READER RATHER THAN THE REGEX, and the first attempt at this
// section is why. Loosening `MARKER` alone produced a mutant that matched the
// malformed line and could not read an approver out of it, so every marker was
// refused — and the precondition below said so: `the mutant is broken rather
// than loosened`. A mutant that refuses everything satisfies "the accepted case
// flipped" for the wrong reason. What is reproduced here is the INSTRUMENT the
// reviewer used — find the token on a line, take any 40-character SHA and any
// agent name off it, in either order — which is a genuinely LOOSER check.
await withMutant(
  'substring-token-match',
  [
    {
      find: `    MARKER.lastIndex = 0;
    let m;
    while ((m = MARKER.exec(text)) !== null) {
      found.push({ sha: m[1].toLowerCase(), approver: m[2], commentId, author });
    }`,
      replace: `    for (const line of text.split('\\n')) {
      if (!/BUTCHR-APPROVAL/i.test(line)) continue;
      const sha = /([0-9a-f]{40})/i.exec(line);
      const who = /((?:epic|story|task|confluence)\\/[A-Z][A-Z0-9]*-\\d+)/.exec(line);
      if (sha && who) found.push({ sha: sha[1].toLowerCase(), approver: who[1], commentId, author });
    }`
    }
  ],
  (at) => {
    const v = at([comment(91, MALFORMED)]);
    check(v.ok, '§7 substring-token-match  the MALFORMED #108 marker is now ACCEPTED — so §1d was measuring the grammar',
      'this is the exact defect the reviewer verified their own fix with');
  }
);

// M2 — the head comparison removed. The stale marker must go through.
await withMutant(
  'ignore-the-head',
  [{ find: 'const atHead = markers.filter((m) => m.sha === head);', replace: 'const atHead = markers.slice();' }],
  (at) => {
    const v = at([comment(92, canonicalMarker({ sha: OLD_HEAD, approver: APPROVER }))]);
    check(v.ok, '§7 ignore-the-head  a marker for a SUPERSEDED head is now accepted — so §1b and §4 were measuring the pinning');
  }
);

// M3 — the use/mention scan removed from the marker reader. The fenced marker
// must go through.
await withMutant(
  'read-quoted-as-asserted',
  [{ find: '    const text = assertedText(body);', replace: '    const text = body;' }],
  (at) => {
    const v = at([comment(93, `Post this when you are happy:\n\n\`\`\`\n${GOOD}\n\`\`\`\n`)]);
    check(v.ok, '§7 read-quoted-as-asserted  a FENCED marker is now accepted — so §1e was measuring the scanner',
      'this is the failure that greened a check 47 seconds before the real approval arrived');
  }
);

// M4 — the signer comparison removed. A marker from an undeclared agent must go
// through. This is the mutation that measures §3's decision rather than its
// prose.
await withMutant(
  'ignore-the-signer',
  [
    {
      find: '  const accepted = declared ? (atHead.find((m) => m.approver === declared) ?? null) : null;',
      replace: '  const accepted = declared ? (atHead[0] ?? null) : null;'
    }
  ],
  (at) => {
    const v = at([comment(94, canonicalMarker({ sha: HEAD, approver: 'epic/KAN-39' }))]);
    check(v.ok, '§7 ignore-the-signer  a marker from an UNDECLARED agent is now accepted — so §3 was measuring the signer');
  }
);

// M5 — THE CONSISTENT DRIFT, which is not a loosening and which every other
// mutation here is blind to. `epic/KAN-59`'s own reproduction: rename `BY` to
// `SIGNED-BY` at all three sites at once — both regexes and the constructor —
// which is the shape a refactor takes. The module stays perfectly
// self-consistent; what breaks is that it no longer speaks the language
// `prompts/task.md` tells every agent in this fleet to write.
//
// THIS MUTANT MUST BE MEASURED DIFFERENTLY FROM THE OTHERS, and that is the
// point of the section rather than a wrinkle. The precondition used above —
// "the mutant still accepts the canonical marker" — is exactly what a
// consistently-drifted module DOES do, because `canonicalMarker` drifted with
// it. So the assertion is against `SPEC_LINE`, retyped from outside the module,
// and the flip required is that §0 goes RED.
{
  const drifted = mutator.mutateScript('consistent-drift-BY-to-SIGNED-BY', MODULE, [
    { find: '[ \\t]+BY[ \\t]+(\\S+)[ \\t]*$/gim;', replace: '[ \\t]+SIGNED-BY[ \\t]+(\\S+)[ \\t]*$/gim;' },
    { find: '[ \\t]+BY[ \\t]+(\\S+)[ \\t]*$/i;', replace: '[ \\t]+SIGNED-BY[ \\t]+(\\S+)[ \\t]*$/i;' },
    { find: '.toLowerCase()} BY ${approver', replace: '.toLowerCase()} SIGNED-BY ${approver' }
  ]);
  if (drifted) {
    const mod = await import(`file://${drifted}`);

    // The precondition, INVERTED on purpose: this mutant is self-consistent, so
    // it still accepts its OWN constructor's output. If it did not, the section
    // below would be measuring a broken module rather than a drifted one.
    const selfConsistent = mod.evaluate({
      headSha: HEAD,
      headRef: HEAD_REF,
      prBody: BODY,
      comments: [{ id: 0, body: mod.canonicalMarker({ sha: HEAD, approver: APPROVER }) }]
    });
    check(
      selfConsistent.ok,
      '§7 consistent-drift  (precondition) the drifted module is SELF-CONSISTENT — it accepts its own line',
      'which is exactly why every fixture generated from the module stays green, and why §0 has to come from outside it'
    );

    // The three §0 assertions, re-run against the mutant. Each must now fail.
    check(
      mod.MARKER_TEMPLATE !== SPEC_LINE,
      '§7 consistent-drift  §0 goes RED: the format description no longer matches the transcribed spec line',
      `mutant: ${JSON.stringify(mod.MARKER_TEMPLATE)}`
    );
    const instantiated = SPEC_LINE.replace('<full-40-char-head-sha>', HEAD).replace('<type>/<KEY>', APPROVER);
    check(
      mod.canonicalMarker({ sha: HEAD, approver: APPROVER }) !== instantiated,
      '§7 consistent-drift  §0 goes RED: the constructor no longer builds the spec line'
    );
    const v = mod.evaluate({ headSha: HEAD, headRef: HEAD_REF, prBody: BODY, comments: [{ id: 0, body: instantiated }] });
    check(
      !v.ok,
      '§7 consistent-drift  §0 goes RED: a marker in the REAL SPEC SHAPE is now REFUSED',
      'this is the ticket inverted — the fleet writes one shape and the gate demands another'
    );

    // And the control that makes the three above mean something: NONE of the
    // other sections would have noticed. The incident transcriptions are refused
    // under either grammar, so they cannot constrain the token order.
    const stillRefusesMalformed = mod.evaluate({
      headSha: HEAD, headRef: HEAD_REF, prBody: BODY, comments: [{ id: 0, body: MALFORMED }]
    });
    const stillRefusesFenced = mod.evaluate({
      headSha: HEAD, headRef: HEAD_REF, prBody: BODY,
      comments: [{ id: 0, body: `\`\`\`\n${mod.canonicalMarker({ sha: HEAD, approver: APPROVER })}\n\`\`\`` }]
    });
    check(
      !stillRefusesMalformed.ok && !stillRefusesFenced.ok,
      '§7 consistent-drift  CONTROL: §1d and §1e stay GREEN under this drift — they are blind to it by construction',
      'refusal fixtures transcribed from incidents are refused under either grammar, which is why §0 is not redundant with them'
    );
  }
}

// ---------------------------------------------------------------------------
// A last direct assertion on the parsers, so that a future edit which made
// `parseMarkers` and `parseQuotedMarkers` return the same set would be caught
// here rather than only through a verdict.
{
  const both = [comment(95, `\`\`\`\n${GOOD}\n\`\`\`\n\n${GOOD}`)];
  check(parseMarkers(both).length === 1, '§7  parseMarkers reads only the ASSERTED occurrence of a line present twice');
  check(parseQuotedMarkers(both).length === 1, '§7  parseQuotedMarkers reads only the QUOTED one');
  check(parseQuotedMarkers(both)[0].quotedAs === QUOTED.FENCED_CODE, '§7  …and names the context it was quoted in');
}

// ---------------------------------------------------------------------------
const skipped = mutator.mutationsSkipped();
console.log('');
if (skipped.length) {
  console.log(`${skipped.length} mutation(s) DID NOT APPLY: ${skipped.join(', ')} — those sections did not run.`);
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
