import type { Exact } from './events.js';
import type { TailSource } from './herdr.js';

/**
 * Telling a message that LANDED from a message that was merely TYPED.
 *
 * `HerdrBridge.sendToAgent` used to answer whether three keystrokes were
 * dispatched — resolve a pane, Ctrl+C, type, Enter — and return `success: true`
 * on every path that did not throw. Nothing observed the pane afterwards, so
 * the claim it made was about this daemon's own actions rather than about the
 * world.
 *
 * That gap is not theoretical. It was witnessed three times in one fleet on
 * 2026-08-03 (KAN-114): a supervisor's message that sat unsent in its
 * recipient's composer and arrived only because a human pressed Enter; an
 * instruction to a design agent found sitting unsent while its terminal showed
 * a plausible-looking final frame; and an instruction to a story agent, never
 * acted on, whose sender presumably believes it was delivered. The asymmetry
 * that makes this nastier than plain loss is that THE TEXT IS ON SCREEN THE
 * WHOLE TIME, which is exactly why nobody spots it.
 *
 * WHY A SUBSTRING TEST IS THE WRONG CHECK, and it is worth being explicit
 * because it is the check anybody writes first: the unsent composer text IS in
 * the pane buffer. `tail.includes(message)` passes on precisely the frame that
 * proves the failure. What separates submitted from unsent is not whether the
 * text is there but WHERE it is — see {@link landedCount}.
 *
 * WHAT IS BORROWED AND WHAT IS NOT. The positional test, the whitespace
 * flattening and the count-not-boolean reading are taken from the delivery
 * primitive Butchr shipped for their KAN-77 task 3, read from their code at
 * `b808fda` rather than from their ticket. Their reasoning is sound and
 * reimplementing it differently would have cost the customer a gratuitously
 * different shape. Two things are deliberately NOT theirs, and both are stated
 * on the record in KAN-114's PR rather than done quietly:
 *
 *   1. **Three outcomes, not two.** Their `DeliveryResult` is
 *      `{delivered: boolean, error?: string}`, so "herdr did not answer, I
 *      could not see" collapses into `delivered: false` — a caller cannot tell
 *      "it definitely did not land" from "I could not look". This codebase has
 *      spent T1 and T4 establishing the opposite everywhere else
 *      (`AgentPresence`'s absent/unverifiable split, `activate`'s
 *      refuse-unverifiable), so {@link SendVerdict} has three members.
 *   2. **The retry presses Enter; it does not type again.** Theirs re-runs the
 *      whole interrupt-and-type sequence, which means a second Ctrl+C at
 *      somebody's working agent. KAN-114 forbids that outright, and the fix the
 *      human performed by hand in the witnessed incident is the right one: the
 *      text is already in the composer, so what it needs is a submit.
 *
 * ---------------------------------------------------------------------------
 * WHAT CONFIRMING BY PANE ECHO DOES NOT ESTABLISH. Three limits, written down
 * because a known gap named here is a boundary and an unnamed one is a defect.
 * ---------------------------------------------------------------------------
 *
 * **1. `delivered` means SUBMITTED, not ARRIVED INTACT.** The claim is that
 * this message's fingerprint appeared above the composer more times than
 * before. It is not that the agent received this message *alone*. Two sends in
 * quick succession can be submitted as ONE concatenated line — the second's
 * text is typed into a composer the first is still sitting in — and both sends
 * correctly report `delivered` while the agent acts only on the first.
 *
 * THIS BIT OUR OWN FIXTURE, about an hour after it was written down here, and
 * that is the fact worth carrying rather than the rule. The live proof's
 * contended section sent a setup instruction and then the message it was
 * setting up for; both arrived as `…nothing elselive 1b-ii: reply with…`, the
 * setup never took effect, and the section asserted against a state that had
 * never been established. Both sends reported `delivered`, correctly, under
 * the definition above. So this is not a theoretical caveat that a careful
 * caller avoids — it caught the person who had just documented it, in the same
 * pull request. The mitigation is the caller's and it is real work: leave the
 * recipient time to swallow one message before sending the next, and if
 * something downstream depends on the first having landed, WAIT FOR EVIDENCE OF
 * THAT rather than for this function's `delivered`.
 *
 * **2. A delivered message can arrive with somebody else's text in front of
 * it.** The interrupt makes Claude Code restore its own in-flight prompt into
 * the composer, and this send's text is appended after it, so what gets
 * submitted is `<their interrupted prompt><our message>`. The confirmation is
 * unaffected — the fingerprint is looked for anywhere in the submitted region,
 * not at a line start — but the recipient reads both. Observed live in
 * KAN-114's own proof.
 *
 * **3. Nothing here is evidence the agent UNDERSTOOD or ACTED on it.** The
 * strongest claim available from a pane is that the recipient's TUI cleared its
 * input buffer and committed the line. That is materially stronger than "bytes
 * were typed", and it is materially weaker than "the work is under way".
 */

/**
 * Where the live input line begins.
 *
 * Claude Code marks a submitted message and the composer with the SAME caret —
 * the transcript echo reads `> your message` and so does the input box — so
 * what separates them is position, not glyph: the composer is the last one on
 * screen, because it is drawn at the bottom. Everything before the final marker
 * has scrolled past as output; everything after it is still being typed.
 *
 * Both forms are listed because Claude Code draws the box differently by
 * version and width: a bare caret, and a bordered input line whose caret sits
 * behind a box-drawing rule.
 */
export const COMPOSER_MARKERS = ['❯', '│ >'];

/** Whitespace flattened, so a wrap is not a difference. See {@link landedCount}. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * How many characters of a message are worth looking for in a pane.
 *
 * Short because every character of the needle is another chance to straddle
 * something the terminal drew between them — a wrap indent, a status line, a
 * redraw that landed mid-echo.
 */
const FINGERPRINT_CHARS = 60;

/**
 * The part of a message worth looking for in a pane.
 *
 * The first line WITH ANYTHING ON IT, flattened and capped short: a submitted
 * message is echoed into the transcript beginning with its first non-empty
 * line, and a long one is abbreviated after that, so nothing past it is
 * reliably on screen to match against.
 *
 * IT WAS `split('\n')[0]` UNTIL KAN-383, and the difference is only visible on
 * a message that OPENS with a blank line — `"\n\nhello"`. `message.trim()` is
 * truthy for that, so the router accepts it as a perfectly good message, and
 * the old form returned the empty needle for it. That was survivable while the
 * needle only decided a VERDICT: the message was still submitted and merely
 * reported `not-delivered`. It stopped being survivable when the same needle
 * became the precondition for pressing Enter at all — an empty fingerprint is
 * never visible, so such a message would have had its submit withheld forever.
 * A guard that refuses real sends is worse than the defect it fixes, and this
 * is that guard's one reachable false positive.
 *
 * Returns the empty string only for a message with no non-whitespace content
 * anywhere, which every caller here treats as "nothing to look for" rather than
 * as a match — an empty needle would otherwise be found everywhere and report a
 * delivery for a message that could not have been echoed.
 */
export function deliveryFingerprint(message: string): string {
  const firstWithContent = message.split('\n').find((line) => line.trim() !== '') ?? '';
  return flatten(firstWithContent).slice(0, FINGERPRINT_CHARS);
}

/**
 * The pane split at the composer: what has been submitted, and what is still
 * being typed.
 *
 * `composerAt` is -1 when no marker is on screen at all, which is a real state
 * and not an error — a bare shell, or a pane mid-scroll. See
 * {@link landedCount} for what is done with it and why.
 */
function splitAtComposer(tail: string): { submitted: string; composer: string; composerAt: number } {
  const composerAt = COMPOSER_MARKERS.reduce(
    (furthest, marker) => Math.max(furthest, tail.lastIndexOf(marker)),
    -1
  );
  return composerAt === -1
    ? { submitted: tail, composer: '', composerAt }
    : { submitted: tail.slice(0, composerAt), composer: tail.slice(composerAt), composerAt };
}

/**
 * How many times this message appears in the pane AS SUBMITTED OUTPUT.
 *
 * A count rather than a yes/no because "is it there?" is the wrong question
 * when the same text may have been sent before: a notice about one agent shares
 * its opening with the notice about the next, and a supervisor's pane
 * legitimately holds both. What proves THIS send landed is that the count went
 * up — so a delivery takes a reading before it types and waits for a bigger
 * one. Without that baseline, a message that happens to match earlier output
 * reports delivered while nothing landed at all: a check passing on a
 * coincidence.
 *
 * WHITESPACE IS FLATTENED ON BOTH SIDES, and this is not tidiness. Claude Code
 * hard-wraps the echo to the pane's width and indents the continuation, so on
 * an 80-column pane a one-line message comes back as two lines with a leading
 * indent on the second. A raw substring check fails on that, reports a
 * delivered message as undelivered, and re-sends it.
 *
 * WHEN NO COMPOSER MARKER IS ON SCREEN the pane is not a prompt we recognise,
 * and presence anywhere is the only evidence available. That is a deliberate
 * degradation with a cost stated rather than hidden: on such a pane this cannot
 * distinguish submitted from unsent, so a `shell` agent's send is confirmed
 * more weakly than a `claude` agent's. The alternative — calling every
 * unrecognised pane undeliverable — would report the failure this exists to
 * catch on panes where it did not happen.
 */
export function landedCount(tail: string, message: string): number {
  const needle = deliveryFingerprint(message);
  if (!needle) return 0;
  return flatten(splitAtComposer(tail).submitted).split(needle).length - 1;
}

/**
 * How many times this message appears IN THE REGION OUR TYPING LANDS IN — the
 * composer when the pane has one, and the whole pane when it does not.
 *
 * WHY A SECOND COUNT EXISTS, when {@link landedCount} looks so similar. They
 * answer different questions and only one of them can be asked before a
 * submit:
 *
 *   landedCount   did the agent RECEIVE it?   (the SUBMITTED region)
 *   visibleCount  did our typing TAKE EFFECT? (the COMPOSER region)
 *
 * The second is the precondition for pressing Enter. Both use
 * {@link splitAtComposer}; they read opposite sides of it, which is the whole
 * distinction between "we typed it" and "they got it".
 *
 * MEASURED, KAN-383, against a real Claude Code at a real dialog: `send-text`
 * at a startup trust dialog and at a tool-permission dialog is **silently
 * destroyed** — the message is echoed in none of herdr's three read sources,
 * and the frame is otherwise byte-identical. So a pane that swallowed our
 * typing is distinguishable from one that took it, and it is distinguishable
 * WITHOUT recognising what is on screen: an observation about our own message
 * rather than a guess about somebody else's TUI.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE IS THE COMPOSER AND NOT THE WHOLE PANE. This counted the whole
 * flattened tail until review caught it, and the bug it had is the one this
 * function exists to prevent — **it failed OPEN.**
 *
 * `deliveryFingerprint` has no floor, so a one-character message yields a
 * one-character needle. Counted across the whole tail, that needle also matches
 * the dialog's own option labels AND anything the pane happens to redraw. The
 * count is then not a fact about our typing at all:
 *
 *     message "y", real tool-permission dialog, verbatim frames
 *       whole tail       4 -> 7   after one ordinary streaming redraw
 *                                 ("* Analysing your repository…", three
 *                                 incidental `y`s, nothing adversarial)
 *                                 -> the guard reads TRUE and presses Enter
 *                                 AT THE DIALOG. Our text landed nowhere.
 *       composer region  1 -> 1   -> holds
 *
 * The redraw is transcript output, so it lands ABOVE the last composer marker
 * and the composer region does not move. Scoping to that region is therefore
 * not a heuristic about dialogs — it is counting in the only place our
 * keystrokes could have gone.
 *
 * A MINIMUM MESSAGE LENGTH WOULD NOT HAVE FIXED IT, which is why there is not
 * one: `y`, `ok` and `go` are exactly what a supervisor sends to unstick an
 * agent, so refusing to send them is not an answer to being unable to see them.
 *
 * WHAT THIS STILL DOES NOT COVER, named rather than left to be discovered:
 * a redraw INSIDE the composer region can still inflate a short needle. The
 * region measured here is static across a transcript redraw on both dialog
 * kinds, but nothing makes that true by construction, and a pane that animates
 * its own selection area would be counted. The residual failure is the same
 * one — a submit that should have been withheld — and the shortest messages
 * carry the most of it.
 *
 * AND ON A PANE WITH NO COMPOSER MARKER the whole tail is the region, because a
 * bare shell echoes onto its command line and there is nothing to scope to.
 * That is weaker, and it is the same degradation {@link landedCount} already
 * documents — but it does not reinstate the hazard, because the hazard is a
 * CONSENT DIALOG, and a pane showing one always has a marker. It is the
 * highlight caret.
 * ---------------------------------------------------------------------------
 *
 * A COUNT AND NOT A BOOLEAN, for the reason {@link landedCount} gives: the same
 * message may legitimately be on the pane already, so what proves THIS typing
 * took effect is that the count went up.
 */
export function visibleCount(tail: string, message: string): number {
  const needle = deliveryFingerprint(message);
  if (!needle) return 0;
  const { composer, composerAt } = splitAtComposer(tail);
  const region = composerAt === -1 ? tail : composer;
  return flatten(region).split(needle).length - 1;
}

/**
 * Whether the message is sitting in the composer, typed and never submitted.
 *
 * THIS IS THE WITNESSED FAILURE, named as a state rather than inferred from the
 * absence of a delivery. It is what licenses the Enter-only retry: pressing
 * Enter at a composer that holds our text submits our text, and pressing it at
 * a composer that holds nothing costs nothing — but only the first is a reason
 * to press it, and only reading the pane can tell them apart.
 *
 * False when no composer marker is on screen: there is no composer to hold
 * anything, so nothing may be claimed about one.
 */
export function messageInComposer(tail: string, message: string): boolean {
  const needle = deliveryFingerprint(message);
  if (!needle) return false;
  const { composer, composerAt } = splitAtComposer(tail);
  if (composerAt === -1) return false;
  return flatten(composer).includes(needle);
}

/**
 * What a send is allowed to answer. THREE ANSWERS, NOT TWO, and the third is
 * the one that would otherwise be a lie in whichever direction the coder
 * happened to pick.
 *
 *  - `delivered` — the pane was read and this message appeared in it as
 *    submitted output that was not there before. A claim about the agent.
 *  - `not-delivered` — the pane was read, and the message is not in it as
 *    submitted output. Evidence of absence: the caller may act on it, resend,
 *    or route around it.
 *  - `unverifiable` — the pane could not be read, so nothing may be concluded.
 *    The message may well have arrived. This is the absence of evidence, and it
 *    is a different fact from evidence of absence in exactly the way
 *    {@link AgentPresence}'s `absent`/`unverifiable` split already says for
 *    liveness and `activate`'s refuse-unverifiable already says for occupancy.
 *
 * EVERY ONE OF THE THREE IS A STATEMENT ABOUT A PANE THAT WAS LOOKED AT, and
 * that is why a request which never became a send may not answer with any of
 * them — see {@link SendResponseVerdict}. A bad path read no pane; calling that
 * `not-delivered` would be true in outcome and false in its basis.
 */
export type SendVerdict = 'delivered' | 'not-delivered' | 'unverifiable';

/**
 * What the wire can answer, which is the three DELIVERY verdicts plus one word
 * for a request that never became a send at all.
 *
 * `refused` is not a fourth thing a send can do — it is the answer when there
 * was no send: an unresolvable path, a blank message. Those read no pane, so
 * they may not borrow `not-delivered`, whose whole content is "the pane was
 * read and it is not in it". Giving them their own word keeps each of the three
 * above meaning exactly what it says, and it uses the vocabulary `activate`
 * already has for a call rejected before anything happened.
 *
 * UNTIL KAN-329 THIS TYPE WAS USED BY NOTHING. It was declared here, argued for
 * here, and named in no signature anywhere — `Respond` is `(msg: any) => void`,
 * so both wire literals were unchecked strings and this alias documented a
 * vocabulary it did not bind. {@link SendResponse} is what binds it now: the
 * union of the three response shapes the router can emit, whose `verdict`s are
 * asserted below to be EXACTLY these four. `docs/send-contract.md` publishes
 * them.
 */
export type SendResponseVerdict = SendVerdict | 'refused';

/**
 * Why a request never became a send. **One member**, published as a set rather
 * than described as a constant, for the reason `activate_response.refusedBy`
 * gives for its own single member: *"the only value it takes"* is exactly the
 * kind of claim that stops being true without anybody noticing.
 *
 * It covers both refusals because they are the same fact about the caller —
 * a path that resolves to no configured agent, and a message that is missing,
 * not a string, or only whitespace. Neither reached a pane, and a consumer's
 * repair for both is the same: fix the request and call again.
 */
export type SendRefusal = 'invalid-request';

/** How much of the tail is carried back to the caller as the verdict's evidence. */
export const EVIDENCE_TAIL_CHARS = 4000;

/**
 * The pane state a verdict was read from, carried back so the verdict is
 * auditable rather than merely asserted.
 *
 * `landedBefore` is `null` when the baseline read failed, and a `null` baseline
 * is why a verdict can be `unverifiable` even after a send herdr accepted:
 * without knowing what the pane already held, a later match cannot be
 * attributed to this send.
 */
export interface SendEvidence {
  /** Whether the pane could be read at the moment the verdict was decided. */
  readable: boolean;
  /** Submitted copies of this message before anything was typed; null if unread. */
  landedBefore: number | null;
  /** Submitted copies at the verdict; null if the pane could not be read. */
  landedAfter: number | null;
  /** Whether the message was seen sitting UNSUBMITTED in the composer. */
  inComposer: boolean;
  /** How many times the pane was read while waiting. */
  checks: number;
  /** How long the confirmation waited, in milliseconds. */
  waitedMs: number;
  /** The tail the verdict was read from, capped at {@link EVIDENCE_TAIL_CHARS}. */
  tail: string | null;
  /**
   * Which herdr read source the tail came from — `null` when every source was
   * asked and every one of them was empty, which is what makes an empty pane a
   * finding rather than a failed look (KAN-98). Absent when the pane could not
   * be read at all. A `not-delivered` carrying `tailSource: null` is asserting
   * that more than one source agreed there was nothing there.
   */
  tailSource?: TailSource | null;
  /** Why the pane could not be read, when it could not. */
  readError?: string;
}

/**
 * What a send did, as a claim about the agent rather than about our keystrokes.
 *
 * `success` is `true` for `delivered` and nothing else, so an existing caller
 * that only reads `success` gets strictly more honesty than before and never
 * less. `delivered` and `verdict` are on EVERY response, both outcomes, so
 * "did this land" is READ rather than inferred from a missing field — the house
 * rule this daemon states at `mcp.ts` for `activate`'s `alreadyRunning`/
 * `started` pair, applied one field over.
 *
 * `interrupts` is the audit field for the constraint that governs all of this:
 * exactly one Ctrl+C per send, ever, because a second one is how Claude Code
 * quits. A caller — or a proof — can read it rather than trust a comment.
 */
export interface SendOutcome {
  success: boolean;
  delivered: boolean;
  verdict: SendVerdict;
  /** Ctrl+C keystrokes this send issued. Never more than 1, by construction. */
  interrupts: number;
  /**
   * Enter keystrokes this send issued: 2 means the confirm-and-retry fired.
   *
   * **`0` MEANS THE SUBMIT WAS WITHHELD, and it is the field to read for that**
   * (KAN-383). The message was typed and never appeared on the pane, so
   * pressing Enter could not have submitted it — and an Enter that cannot
   * submit our message can still answer somebody else's dialog. The daemon
   * declines rather than pressing it blind. No field was added for this: a
   * count that can be zero already said it.
   */
  submits: number;
  /** Whether the Enter-only retry ran. */
  retried: boolean;
  evidence: SendEvidence;
  error?: string;
}

// -------------------------------------------------------- what the wire says

/*
 * KAN-329. Everything above this line describes what a SEND did. What follows
 * describes what the ROUTER ANSWERS, and the two are not the same set of
 * shapes: `handleSendToAgent` has three respond sites and only one of them
 * carries a {@link SendOutcome}. The other two were object literals with bare
 * string verdicts in them, which is precisely the shape `activateRefused` was
 * in before KAN-287 gave it a union — a vocabulary that grows a member at a
 * `respond({…})` call site, where nothing is looking.
 *
 * PREFER THE TYPE TO THE ASSERTION. These declarations do not change a byte of
 * any response; they make the two off-outcome branches nameable, so that the
 * four-member vocabulary is checked by the compiler rather than only by a
 * document. `docs/send-contract.md` is the document, and
 * `scripts/verify-send-contract.mjs` reconciles it against these.
 */

/**
 * The request never became a send, so NO PANE WAS READ.
 *
 * WHAT IT DOES NOT CARRY IS THE POINT, and it is stated as a type rather than
 * left to be noticed: no `evidence`, because nothing was observed; no
 * `interrupts`, `submits` or `retried`, because no keystroke was issued; and no
 * `path`, because on this branch the address is what could not be resolved.
 * A consumer reading `evidence` off every response meets `undefined` here.
 */
export interface SendRefusedResponse {
  success: false;
  delivered: false;
  verdict: 'refused';
  /** The field to read. Never inferred from the absence of `evidence`. */
  refused: SendRefusal;
  error: string;
}

/**
 * The bridge itself rejected — our own confirmation threw, which is a bug on
 * this side rather than a fact about the agent.
 *
 * IT ANSWERS `unverifiable` WITH NO EVIDENCE BLOCK, and that is the one
 * asymmetry a consumer is most likely to be caught by: the verdict does not
 * tell you whether `evidence` is there. Every `unverifiable` from
 * {@link SendOutcome} carries a full one; this one carries none, because the
 * code that would have assembled it is the code that threw. Documented rather
 * than repaired — synthesising an evidence block here would mean reporting a
 * reading nobody took.
 */
export interface SendUnconfirmableResponse {
  success: false;
  delivered: false;
  verdict: 'unverifiable';
  error: string;
}

/**
 * Every shape `send_to_agent_response` can carry, minus the two envelope fields
 * the router adds (`action` always, `path` on all but the refusal).
 */
export type SendResponse = SendOutcome | SendRefusedResponse | SendUnconfirmableResponse;

/**
 * THE ROUND TRIP, CLOSED AT COMPILE TIME: the verdicts the wire can actually
 * carry are exactly {@link SendResponseVerdict}, no more and no fewer.
 *
 * This is the binding that was missing. A fifth word answered by a new branch
 * fails to compile until it is in the union; a word removed from the union
 * while a branch still answers it fails to compile too. Both directions, and
 * neither is a check that runs later — the state is not introducible.
 *
 * What it does NOT reach: a respond site that builds its object inline instead
 * of through one of these types is invisible to it, because `Respond` is
 * `(msg: any) => void`. `verify-send-contract.mjs` §4 scans the handler for
 * exactly that and is the reason this comment can stop here rather than
 * overclaiming.
 */
const _wireVerdictsAreExactlyTheVocabulary: Exact<
  SendResponse['verdict'],
  SendResponseVerdict
> = true;
void _wireVerdictsAreExactlyTheVocabulary;

/**
 * The refusal, built where its vocabulary is declared rather than at the
 * `respond({…})` call.
 */
export function refusedSend(refused: SendRefusal, error: string): SendRefusedResponse {
  return { success: false, delivered: false, verdict: 'refused', refused, error };
}

/** The bridge-rejection branch. See {@link SendUnconfirmableResponse}. */
export function unconfirmableSend(error: string): SendUnconfirmableResponse {
  return { success: false, delivered: false, verdict: 'unverifiable', error };
}
