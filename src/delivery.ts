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
 * correctly report `delivered` while the agent acts only on the first. Observed
 * in KAN-114's review. The mitigation is the caller's: leave the recipient time
 * to swallow one message before sending the next, rather than pipelining.
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
 * The first line, flattened and capped short: a submitted message is echoed
 * into the transcript beginning with its first line, and a long one is
 * abbreviated after that, so nothing past the first line is reliably on screen
 * to match against.
 *
 * Returns the empty string for a message with no non-whitespace first line,
 * which every caller here treats as "nothing to look for" rather than as a
 * match — an empty needle would otherwise be found everywhere and report a
 * delivery for a message that could not have been echoed.
 */
export function deliveryFingerprint(message: string): string {
  return flatten(message.split('\n')[0]).slice(0, FINGERPRINT_CHARS);
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
 */
export type SendResponseVerdict = SendVerdict | 'refused';

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
  /** Enter keystrokes this send issued: 2 means the confirm-and-retry fired. */
  submits: number;
  /** Whether the Enter-only retry ran. */
  retried: boolean;
  evidence: SendEvidence;
  error?: string;
}
