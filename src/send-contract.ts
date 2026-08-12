/**
 * THE SEND CONTRACT, as data (KAN-329).
 *
 * `docs/send-contract.md` is the document a consumer builds against; this file
 * is its executable half, the way `src/read-contract.ts` is the executable half
 * of `docs/read-path-contract.md` and `src/events.ts` of
 * `docs/event-contract.md`. `scripts/verify-send-contract.mjs` reconciles the
 * three artifacts — this file, that document, and a REAL daemon's
 * `send_to_agent_response` — pairwise and in both directions.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * `send_to_agent`'s verdict was a **closed vocabulary a consumer must switch
 * on, with no published member list**. It was typed in `src/delivery.ts`,
 * argued for at length in that file's prose, proven behaviourally by
 * `verify-send-confirms-delivery.mjs` and `-live.mjs` — and published nowhere:
 * no document, no value set, nothing reconciled. A fifth verdict could be added
 * and nothing anywhere would go red.
 *
 * That is a sharper gap than the one KAN-287 closed. `activate_response` was a
 * response nobody described; this is a vocabulary a consumer BRANCHES ON, which
 * is the exact hazard the read-path contract's must-ignore clause exists to
 * manage on the eight vocabularies that do publish their members. The contract
 * told a consumer *"a value you do not recognise must be handled as an
 * unknown"* for those eight and said nothing at all for the field Butchr reads
 * more than any other.
 *
 * ---------------------------------------------------------------------------
 * WHY A DOCUMENT OF ITS OWN, AND NOT §12 OF THE READ-PATH CONTRACT
 *
 * The read-path contract's own opening sentence scopes it: two questions about
 * agent STATE, plus one about an agent's arrival. A send verdict is not a fact
 * about an agent. It is the outcome of a write to somebody else's terminal, and
 * the pane it reads is read only to justify that outcome. Filing it there
 * because the value-set machinery and the digest happen to live there would be
 * putting a thing where the tooling is rather than where it belongs, which is
 * how documents stop meaning anything.
 *
 * So the machinery is reproduced here rather than borrowed — deliberately, and
 * with the cost stated: two canonical digests instead of one, two version
 * tables, and a second file that has to be kept honest. What is NOT reproduced
 * is the read path's four provenance buckets, which are imported from
 * {@link ProvenanceBucket} and applied here with the seam named at
 * {@link SEND_RESPONSE_FIELDS}. One taxonomy the reader already knows beats a
 * second one invented for one surface.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 *
 * It is not a projection, a filter or a validator, and nothing on the send path
 * consults it at runtime — the same boundary `src/read-contract.ts` states for
 * itself. A field added to a response still travels; what happens is that the
 * proof goes red in CI, before review.
 *
 * The compile-time half is real and it is in `src/delivery.ts`, not here:
 * `SendResponse`'s verdicts are asserted there to be exactly
 * `SendResponseVerdict`, and the bindings at the foot of this file make the
 * document's member lists and field lists unrepresentable-if-wrong. What
 * neither reaches is a `respond({…})` site that builds its object inline —
 * `Respond` is `(msg: any) => void`. `verify-send-contract.mjs` §4 scans for
 * exactly that, and the document says so under "How this is enforced".
 */

import type {
  SendEvidence,
  SendOutcome,
  SendRefusal,
  SendResponse,
  SendResponseVerdict,
  SendVerdict
} from './delivery.js';
import type { Exact } from './events.js';
import type { ProvenanceBucket } from './read-contract.js';

// ---------------------------------------------------------------- the version

/**
 * THE SEND CONTRACT VERSION — an integer naming the revision of
 * `docs/send-contract.md`, incrementing by one.
 *
 * **IT IS NOT ON THE WIRE, AND THAT IS THE ONE PLACE THIS CONTRACT IS HELD MORE
 * WEAKLY THAN THE READ PATH.** `daemon_status.contractVersion` tells a consumer
 * which revision of the read-path contract the answering process implements;
 * there is no such field for this one, so a consumer cannot ask a daemon which
 * revision of THIS document it implements. They get the notice promise and the
 * version history table, and nothing machine-readable.
 *
 * WHY NOT ADD ONE. It would be a new field on `daemon_status` — a change to the
 * wire, made to carry a description of the wire. KAN-329 was scoped to publish
 * what `send_to_agent` already returns rather than to change it, and adding a
 * second version integer is a decision for whoever needs it rather than a
 * side-effect of documenting. It is written down here and in the document's §1
 * so the gap is a boundary somebody can act on, not one they discover.
 *
 * WHAT THE VERSION IS STILL WORTH WITHOUT A WIRE FIELD: the digest in the
 * document's version table is computed from {@link sendContractCanonical}, so a
 * silent change to any declaration below stops the row matching and the proof
 * goes red. That is the same guarantee the read path's digest buys, and it is
 * independent of anything being on the wire.
 */
export const SEND_CONTRACT_VERSION = 1;

// ------------------------------------------------------------ the vocabularies

/**
 * The closed vocabularies a caller of `send_to_agent` BRANCHES ON, published so
 * that meeting a new member is an expected event rather than a surprise.
 *
 * **THE MUST-IGNORE CLAUSE, and it is the same one the read-path contract's §9
 * and the event contract's §4 state: a value you do not recognise must be
 * handled as an unknown rather than errored on.** For this surface the safe
 * reading of an unrecognised verdict is *"this send did not certainly land, and
 * I cannot tell which way"* — which is the `unverifiable` posture, and is the
 * conservative one: it licenses waiting and asking, and it does not license the
 * resend that `not-delivered` licenses.
 *
 * **`sendVerdict` AND `sendResponseVerdict` ARE BOTH PUBLISHED, AND THE
 * DIFFERENCE BETWEEN THEM IS THE TRAP.** They are not two names for one set.
 * `sendVerdict` is what a SEND can conclude — three members, each a statement
 * about a pane that was looked at. `sendResponseVerdict` is what the WIRE can
 * carry, which is those three plus `refused` for a request that never became a
 * send and therefore read no pane. A consumer that switches exhaustively on the
 * three meets the fourth as a default case. The ticket that commissioned this
 * file was itself written expecting three.
 */
export const SEND_VALUE_SETS = {
  /**
   * `SendVerdict` — what a send that HAPPENED can conclude. Every member is a
   * statement about a pane that was read.
   */
  sendVerdict: ['delivered', 'not-delivered', 'unverifiable'],
  /**
   * `send_to_agent_response.verdict` — the three above, plus the one word for a
   * request that never became a send. **This is the set on the wire**, and the
   * one a consumer's switch has to cover.
   */
  sendResponseVerdict: ['delivered', 'not-delivered', 'unverifiable', 'refused'],
  /**
   * `send_to_agent_response.refused` — why a request never became a send. **On
   * the refusal branch only**, and a consumer must not read its absence as "not
   * refused"; `verdict` is what says that. One member today, published as a set
   * rather than described as a constant for the reason
   * `activate_response.refusedBy` gives for its own.
   */
  sendRefused: ['invalid-request']
} as const;

// The bindings that make a member addable only WITH a row. `Exact<A, B>` is
// `true` only when the two unions are mutually assignable, so a value added to
// the code without a line above does not compile, and a line above with no
// value behind it does not compile either. PREFER THE TYPE TO THE ASSERTION:
// the undocumented value cannot be introduced at all, which is stronger than
// any check that runs later.
//
// READ THE CONSEQUENCE FOR MUTATION TESTING, because it changes what a red
// looks like: adding a fifth verdict to the union alone is a BUILD failure, not
// a proof failure, so a proof importing from `dist/` never sees it. The
// mutation that exercises the DOCUMENT half has to compile — add the member to
// the union AND to the list here, and leave the document alone.
// `verify-send-contract.mjs` §6 runs both and says which is which.
const _sendVerdictValuesAreExact: Exact<
  (typeof SEND_VALUE_SETS.sendVerdict)[number],
  SendVerdict
> = true;
const _sendResponseVerdictValuesAreExact: Exact<
  (typeof SEND_VALUE_SETS.sendResponseVerdict)[number],
  SendResponseVerdict
> = true;
const _sendRefusedValuesAreExact: Exact<
  (typeof SEND_VALUE_SETS.sendRefused)[number],
  SendRefusal
> = true;

void _sendVerdictValuesAreExact;
void _sendResponseVerdictValuesAreExact;
void _sendRefusedValuesAreExact;

// ------------------------------------------------------------------ the fields

/** What the contract says about one field of `send_to_agent_response`. */
export interface SendFieldSpec {
  readonly bucket: ProvenanceBucket;
  /**
   * Absent on at least one branch, with the condition stated in the document
   * and the exact branch key sets in {@link SEND_RESPONSE_BRANCHES}.
   *
   * AN OPTIONAL FIELD IS NOT A NULLABLE ONE, and on this surface the
   * distinction has teeth: `evidence.landedBefore` is always PRESENT and is
   * `null` when the baseline read failed, whereas `evidence` itself is genuinely
   * ABSENT on two branches. The first is an answer; the second is a different
   * shape of response.
   */
  readonly optional?: true;
  /** This field is an object of the named shape in {@link SEND_BLOCK_SHAPES}. */
  readonly block?: string;
}

type SendFieldTable = Readonly<Record<string, SendFieldSpec>>;

/**
 * `send_to_agent_response`, field by field.
 *
 * WHAT THE FOUR PROVENANCE BUCKETS MEAN ON A RESPONSE THAT IS NOT A READ. They
 * were defined in the read-path contract's §3 for state reads, and they are
 * applied here deliberately rather than by habit — the same argument
 * `activate_response` makes for itself, one surface over:
 *
 *   * **`observed`** keeps its exact meaning and is the honest home for
 *     everything in the {@link SEND_EVIDENCE_FIELDS} block that came off the
 *     pane. True when the reading was taken and not one moment longer. The
 *     verdict itself is NOT observed — see below.
 *   * **`derived`** carries this daemon's account of its own actions and its
 *     conclusion from them: `verdict`, `success`, `delivered`, `interrupts`,
 *     `submits`, `retried`, `refused`, `error`. `verdict` is derived and not
 *     observed on purpose: it is a JUDGEMENT made from the counts in
 *     `evidence`, and putting it in the bucket that means "read off the world"
 *     would be the small dishonesty this whole surface exists to avoid.
 *   * **`durable`** means what it always means — on the registry, and answering
 *     the same after a restart. Exactly one field: `path`, the registry's own
 *     key, canonicalised.
 *   * **`remembered`** has no field here. Named rather than omitted, so its
 *     absence is a fact rather than a gap.
 *
 * **AND NO LEGEND CHECKS ANY OF IT.** This response carries no `provenance`
 * block — neither does `activate_response`, and the read-path contract says so
 * about itself in the same words. The buckets below are held by the document
 * against this file and by nothing on the wire. Adding a legend would change
 * the response, which is a decision rather than a description, and this version
 * does not make it.
 */
export const SEND_RESPONSE_FIELDS = {
  /** The response frame. Always `'send_to_agent_response'`. */
  action: { bucket: 'derived' },
  /**
   * The agent this was addressed to, canonicalised. **Absent on the refusal
   * branch — including when the path resolved perfectly well and it was the
   * MESSAGE that was rejected.** See {@link SEND_RESPONSE_BRANCHES}.
   */
  path: { bucket: 'durable', optional: true },
  /** `true` for `delivered` and nothing else. */
  success: { bucket: 'derived' },
  /** The same fact as `success`, carried so neither has to be inferred. */
  delivered: { bucket: 'derived' },
  /** The four-member vocabulary. On every branch, both outcomes. */
  verdict: { bucket: 'derived' },
  /** Why the request never became a send. Refusal branch only. */
  refused: { bucket: 'derived', optional: true },
  /** Ctrl+C keystrokes issued. Never more than 1. Absent where nothing was typed. */
  interrupts: { bucket: 'derived', optional: true },
  /** Enter keystrokes issued: 2 means the confirm-and-retry fired. */
  submits: { bucket: 'derived', optional: true },
  /** Whether the Enter-only retry ran. */
  retried: { bucket: 'derived', optional: true },
  /** The pane state the verdict was read from. Absent on two branches. */
  evidence: { bucket: 'observed', optional: true, block: 'SendEvidence' },
  /** Absent if and only if the verdict is `delivered`. */
  error: { bucket: 'derived', optional: true }
} as const satisfies SendFieldTable;

/**
 * `send_to_agent_response.evidence` — the pane state the verdict was read from,
 * carried so the verdict is auditable rather than merely asserted.
 *
 * SEVEN FIELDS ARE ALWAYS PRESENT AND TWO ARE CONDITIONAL, and that is a
 * property of one constructor rather than of eight call sites: `sendToAgent`
 * builds every outcome through a single `outcome()` helper that spreads
 * defaults under whatever the branch supplies. It is why the block cannot lose
 * a field on a branch somebody adds later.
 */
export const SEND_EVIDENCE_FIELDS = {
  /** Whether the pane could be read at the moment the verdict was decided. */
  readable: { bucket: 'observed' },
  /**
   * Submitted copies of this message before anything was typed. **`null` means
   * the baseline read failed**, which is why a send herdr accepted can still be
   * `unverifiable`: without a baseline, a later match cannot be attributed to
   * this send.
   */
  landedBefore: { bucket: 'observed' },
  /** Submitted copies at the verdict; `null` if the pane could not be read. */
  landedAfter: { bucket: 'observed' },
  /** Whether the message was seen sitting UNSUBMITTED in the composer. */
  inComposer: { bucket: 'observed' },
  /** How many times the pane was read while waiting. */
  checks: { bucket: 'derived' },
  /** How long the confirmation waited, in milliseconds. */
  waitedMs: { bucket: 'derived' },
  /** The tail the verdict was read from, capped at `EVIDENCE_TAIL_CHARS`. */
  tail: { bucket: 'observed' },
  /**
   * Which herdr read source answered. **Present only where a read succeeded**,
   * and `null` there means every source was asked and every one was empty —
   * which makes an empty pane a finding rather than a failed look (KAN-98).
   */
  tailSource: { bucket: 'observed', optional: true },
  /** Why the pane could not be read. Present only where one could not be. */
  readError: { bucket: 'derived', optional: true }
} as const satisfies SendFieldTable;

/** Every block-shaped field on this surface. One today. */
export const SEND_BLOCK_SHAPES = {
  SendEvidence: SEND_EVIDENCE_FIELDS
} as const;

// THE FIELD LISTS, BOUND TO THE TYPES THEY DESCRIBE.
//
// `AllKeys` distributes over the union, because `keyof SendResponse` on a union
// yields only the keys COMMON to all three shapes — which is four of the eleven,
// and would have made this binding quietly vacuous about everything that
// matters. The two envelope fields the router adds outside those types
// (`action` on every branch, `path` on all but the refusal) are named here
// rather than folded into the types, because they belong to the frame and not
// to the outcome.
type AllKeys<T> = T extends unknown ? keyof T : never;

const _responseFieldsAreExact: Exact<
  keyof typeof SEND_RESPONSE_FIELDS,
  AllKeys<SendResponse> | 'action' | 'path'
> = true;
const _evidenceFieldsAreExact: Exact<
  keyof typeof SEND_EVIDENCE_FIELDS,
  keyof SendEvidence
> = true;
const _outcomeFieldsAreCovered: Exact<
  Exclude<keyof SendOutcome, keyof typeof SEND_RESPONSE_FIELDS>,
  never
> = true;

void _responseFieldsAreExact;
void _evidenceFieldsAreExact;
void _outcomeFieldsAreCovered;

// ---------------------------------------------------------------- the branches

/**
 * EXACTLY WHAT EACH BRANCH CARRIES — five branches, read off
 * `MessageRouter.handleSendToAgent` and `HerdrBridge.sendToAgent` rather than
 * sampled from responses.
 *
 * **EXACT KEY SETS, NOT `always`/`sometimes`.** `activate_response` needed two
 * lists per branch because nine of its fields are spread conditionally, so one
 * branch legitimately answers with different key sets on different calls. That
 * is not true here: every field on this surface is decided by the branch, so
 * knowing the branch tells you the keys, and the proof asserts EQUALITY rather
 * than a bound. Saying that as one list is the stronger statement, and it is
 * available here only because the surface happens to be that tidy.
 *
 * **FIVE BRANCHES AND FOUR VERDICTS, WHICH IS THE ASYMMETRY TO READ TWICE.**
 * `unverifiable` is answered by two branches with DIFFERENT SHAPES:
 * `unverifiable` carries a full evidence block, and `unconfirmable` carries
 * none at all. So `verdict` does not tell a consumer whether `evidence` is
 * there. That is documented rather than repaired — the branch with no evidence
 * is the one where the code that assembles evidence is the code that threw, and
 * synthesising a block there would mean reporting a reading nobody took.
 */
export const SEND_RESPONSE_BRANCHES = {
  /** The pane was read and this message appeared in it as new submitted output. */
  delivered: [
    'action', 'path', 'success', 'delivered', 'verdict',
    'interrupts', 'submits', 'retried', 'evidence'
  ],
  /** The pane was read, and the message is not in it as submitted output. */
  'not-delivered': [
    'action', 'path', 'success', 'delivered', 'verdict',
    'interrupts', 'submits', 'retried', 'evidence', 'error'
  ],
  /** The pane could not be read, so nothing may be concluded. Full evidence. */
  unverifiable: [
    'action', 'path', 'success', 'delivered', 'verdict',
    'interrupts', 'submits', 'retried', 'evidence', 'error'
  ],
  /**
   * The bridge itself rejected. **Answers `unverifiable` with NO evidence
   * block**, and no keystroke counts either — nothing here is a claim about a
   * pane, because nothing read one.
   */
  unconfirmable: ['action', 'path', 'success', 'delivered', 'verdict', 'error'],
  /**
   * The request never became a send. **No `path`**, even when the path was fine
   * and the message was what was rejected.
   */
  refused: ['action', 'success', 'delivered', 'verdict', 'refused', 'error']
} as const;

/**
 * Which verdict each branch answers with — the join that makes the two-branches
 * one-verdict collision above readable as data instead of as a warning in a
 * comment. `verify-send-contract.mjs` §2 asserts the LIVE verdict of each
 * branch against this.
 */
export const SEND_BRANCH_VERDICTS = {
  delivered: 'delivered',
  'not-delivered': 'not-delivered',
  unverifiable: 'unverifiable',
  unconfirmable: 'unverifiable',
  refused: 'refused'
} as const satisfies Readonly<Record<keyof typeof SEND_RESPONSE_BRANCHES, SendResponseVerdict>>;

// ------------------------------------------------------------------ the digest

/**
 * A stable, order-independent rendering of everything above, for the version
 * table in `docs/send-contract.md` to record a digest of.
 *
 * WHAT IT BUYS: changing a documented field, member or branch changes this
 * string, so the digest in the table stops matching and
 * `verify-send-contract.mjs` §3 goes red — a silent change becomes a loud one.
 *
 * WHAT IT DOES NOT BUY, so nobody reads it as more: it does not force the
 * version to increment, and it is not a compatibility check. A change can be
 * landed by rewriting the row's digest instead of adding one, and that is a
 * diff a reviewer sees rather than an omission they do not.
 */
export function sendContractCanonical(): string {
  const table = (t: SendFieldTable) =>
    Object.keys(t)
      .sort()
      .map((k) => {
        const s = t[k];
        return `${k}:${s.bucket}${s.optional ? '?' : ''}${s.block ? `→block:${s.block}` : ''}`;
      })
      .join(',');

  const branches = (b: Readonly<Record<string, readonly string[]>>) =>
    Object.keys(b)
      .sort()
      .map((k) => `${k}:${[...b[k]].sort().join('|')}`)
      .join(';');

  return [
    `version{${SEND_CONTRACT_VERSION}}`,
    `values{${Object.keys(SEND_VALUE_SETS)
      .sort()
      .map(
        (k) =>
          `${k}:${[...SEND_VALUE_SETS[k as keyof typeof SEND_VALUE_SETS]].sort().join('|')}`
      )
      .join(';')}}`,
    `response{${table(SEND_RESPONSE_FIELDS)}}`,
    `evidence{${table(SEND_EVIDENCE_FIELDS)}}`,
    `branches{${branches(SEND_RESPONSE_BRANCHES)}}`,
    `branchVerdicts{${Object.keys(SEND_BRANCH_VERDICTS)
      .sort()
      .map((k) => `${k}:${SEND_BRANCH_VERDICTS[k as keyof typeof SEND_BRANCH_VERDICTS]}`)
      .join(';')}}`
  ].join('|');
}
