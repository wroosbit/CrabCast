// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as fs from 'fs';
import * as path from 'path';
import { CrabcastConfig } from './config.js';
import { refusedSend, unconfirmableSend } from './delivery.js';
import { MAX_LINE_CHARS } from './ipc.js';
import {
  CAPACITY_FIELDS,
  CONFIG_FIELDS,
  CONFIG_SHAPE,
  EventFrame,
  Exact,
  PREEMPTION_BY_FIELDS,
  PREEMPTION_FIELDS,
  events,
  undeclaredFields
} from './events.js';
import {
  BLOCK_SHAPES,
  READ_CONTRACT_VERSION,
  ROW_SHAPES,
  VALUE_SETS
} from './read-contract.js';
import { AgentConfig, DaemonResponse, McpServerSpec, SummarisedAgentConfig } from './types.js';
import { type ArtifactDisclosure, removeProvisionedArtifacts } from './provisioning.js';
import {
  HerdrBridge,
  HerdrCensus,
  HerdrSession,
  HerdrAgentRecord,
  HerdrAgentStatus,
  Occupancy,
  PaneOccupant,
  RUNTIME_CONFIRM_TIMEOUT_MS,
  ourPaneIn
} from './herdr.js';
import type { PathProblem } from './identity.js';
import { PathError, canonicalPath, canonicalizeOrNull, paneNameFor } from './identity.js';
import {
  BUILTIN_MCP_SERVERS,
  agyMcpConfigPath,
  builtinMcpServer,
  knownLaunchers,
  launcherAcceptsArgs,
  launchersAcceptingArgs,
  resolveLauncher
} from './launchers.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import { ResumeCause } from './resume.js';
import {
  Capacity,
  capacityReason,
  capacityRefusal,
  preemptionCanHelp,
  describeCapacity,
  readCapacity,
  summarizeCapacity
} from './capacity.js';
import { forgetAgentStart, recordAgentStart } from './starts-in-flight.js';
import {
  PreemptionCandidate,
  PreemptionRecord,
  addressOf,
  describeCandidate,
  describeFleetPriorities,
  noVictimReason,
  preemptionOffer,
  selectVictim
} from './priority.js';
import {
  AgentIntent,
  AgentRecord,
  AgentRegistry,
  RecordOutcome,
  UnreadableRecord,
  toChannelEnabled
} from './agent-registry.js';
import { nudgeResumedAgent } from './nudge.js';
import { BuildSnapshot, buildProvenanceReport } from './provenance.js';

type Respond = (msg: any) => void;

/**
 * THE TWO HALVES OF A STREAMING PTY REPLY, split by TYPE and not by discipline
 * (KAN-299). `handlePtyInput` and `handlePtyResize` are handed both, and which
 * one a message may travel on is a thing the compiler decides rather than a
 * thing a future author has to remember.
 *
 * The rule this encodes is stated in full where `ack` is defined, in
 * {@link MessageRouter.handle}. In one line: **a refusal is not an ack.** A
 * success is an ack and stays gated on the caller's `id`; a refusal is not and
 * is delivered unconditionally.
 *
 * `success: true` and `success: false` as LITERALS is the whole mechanism, and
 * it is a claim the compiler holds rather than one a comment makes:
 *
 *   ack({ …, success: false, … })     — REFUSED BY THE COMPILER. This is the
 *                                       regression the ticket exists over: a
 *                                       refusal routed down the correlated-only
 *                                       path, silent to the caller that most
 *                                       needs it.
 *   refuse({ …, success: true, … })   — REFUSED BY THE COMPILER. The mirror,
 *                                       and the one that turns this fix into
 *                                       the ack-per-keystroke regression the
 *                                       `id` gate exists to prevent.
 *
 * Neither direction is expressible, so neither needs an assertion to notice it
 * afterwards — which is the point, because the failure both produce is silent
 * on the wire and this file has twice shipped a rule outliving the reason
 * written beside it.
 *
 * `sessionId` carries the second, smaller claim: a SUCCESS always names the
 * session it happened to, a refusal may not have one to name (`ptySessionId`
 * returns `null` for a request that arrived without a usable id, and that is
 * itself a refusable condition).
 *
 * WHAT THIS DOES NOT REACH, marked because the types look more complete than
 * they are: `Respond` is `(msg: any) => void`, so the two helpers `handle`
 * builds are assignable to BOTH of these. The compiler stops a refusal being
 * written to the ack parameter INSIDE a handler; it cannot stop a dispatch site
 * passing `ack` in the refusal position. That second half is what
 * `scripts/verify-pty-payload-refusal.mjs` §7 holds, and it is exactly the
 * mutation that drove it red.
 */
type PtyAck = (msg: { action: string; success: true; sessionId: string }) => void;
type PtyRefusal = (msg: {
  action: string;
  success: false;
  sessionId: string | null;
  refusal: string;
  error: string;
}) => void;

/**
 * The extra fields an `activate` REFUSAL may carry — a type, because these two
 * claims are expressible as one and a claim the compiler holds cannot rot
 * (KAN-138 item 6).
 *
 * `alreadyRunning?: true` — so `false` DOES NOT COMPILE. Intersected with the
 * index signature the property resolves to `true`, and that is the exact
 * property, stated more carefully than the ticket that asked for it.
 *
 * The ticket asked for "absent on every refusal", and that was true when it was
 * written and is not true now: KAN-136 added a refusal — an attach that threw
 * over a pane that IS ours — which reaches the question, answers it, and is
 * entitled to say `alreadyRunning: true`. Forbidding that outright would have
 * made the type a lie about the code, so what is forbidden is the value neither
 * branch can honestly produce:
 *
 *   absent  — the refusal never reached the question (bad flag, no record, a
 *             census that did not answer, a stranger in the directory)
 *   `true`  — it reached it and the agent is running (the attach failure)
 *   `false` — REFUSED BY THE COMPILER. It reads as "we looked, and it is not
 *             running", which no refusal here has established: the occupied
 *             branch in particular knows only that the pane it found is not
 *             ours.
 *
 * The swallow item 6 is really about — an `occupied` refusal quietly reporting
 * `alreadyRunning: true` and turning a safety guard into a silent success —
 * is not expressible as a type, because the same value is correct one branch
 * over. `verify-idempotent-lifecycle.mjs` §4 asserts its ABSENCE there, and §4a
 * asserts the `true` at the site that earns it, so the two halves are pinned by
 * whichever instrument can actually hold them.
 *
 * `started?: false` narrows the same way: a refusal may restate that nothing
 * was started and may not claim that something was.
 *
 * See {@link MessageRouter.handleActivate}'s `fail` for the rest of it.
 */
/**
 * THE MACHINE-READABLE KIND OF AN ACTIVATE REFUSAL, as a union rather than as a
 * string literal typed out at the site (KAN-287).
 *
 * These were bare literals at the `fail` calls, which is the shape that grows a
 * fourth member silently — and this one is published: `VALUE_SETS.activateRefused`
 * carries it, so a consumer branches on it.
 *
 * WHICH REFUSALS CARRY IT IS A RULE, NOT A COUNT (KAN-376). This comment used to
 * say "three of the nine carry this and six do not" and point at KAN-328 for the
 * decision. A count rots — it is wrong the day a tenth branch lands, and it tells
 * the next author nothing about where their new refusal belongs. The rule:
 *
 *   `refused` NAMES A CONDITION CRABCAST CHECKED AND FOUND BEFORE IT ATTEMPTED
 *   ANYTHING. IT IS NOT A STAGE LABEL FOR AN ATTEMPT THAT LOST.
 *
 * So the four discriminated refusals are the PRE-FLIGHT ones — `not-configured`,
 * `unverifiable`, `occupied` here, and `capacity` under `refusedBy` because it
 * names a subsystem rather than a condition. Nothing was spawned, nothing was
 * charged, nothing needed unwinding, and each has a remedy a caller can CHOOSE
 * BETWEEN without reading prose.
 *
 * `spawn-error`, `attach-error` and `confirm-failed` are POST-ATTEMPT and carry
 * no kind, for two reasons rather than by omission. Their remedy is IDENTICAL —
 * retry or escalate — so a discriminator would let a consumer branch on a
 * distinction that changes nothing it can do. And `spawn-error`'s prose is
 * HERDR'S OWN STRING: publishing it as a kind would make one field mean both
 * "the daemon declined for reason X" and "an attempt failed at stage Y".
 *
 * `bad-flag` is in neither category, and that is a conclusion rather than an
 * omission: the request never became a request about an agent.
 *
 * Widening this union is a change to the wire and therefore a decision, not a
 * description — the reasoning is §8 note 2 of `docs/read-path-contract.md`, and
 * the lossy edges this rule leaves are disclosed there rather than here.
 *
 * WHAT ACTUALLY STOPS A FOURTH MEMBER, MEASURED RATHER THAN ASSERTED (KAN-376).
 * This comment used to claim a new kind "is a COMPILE ERROR until it has a line
 * in the contract and a row in the document". THE SECOND HALF WAS FALSE, and the
 * compiler cannot hold it: adding a member to this union AND to
 * `VALUE_SETS.activateRefused` while leaving the document alone typechecks
 * CLEAN. Driven at d4a851f — union only: `tsc` exit 2 at the `Exact<>` binding
 * below; union plus contract, no document row: `tsc` exit 0.
 *
 *   the compiler  holds the union against `VALUE_SETS.activateRefused`
 *   the proof     holds `VALUE_SETS` against the document's §9 table, and holds
 *                 THIS RULE — that the branches carrying `refused` are exactly
 *                 these members — in `verify-read-contract.mjs` §1
 *
 * Both are real; they are different mechanisms, and saying "compile error" for
 * both is the overclaim this epic keeps finding. See `scripts/kan376-red-drive.mjs`.
 */
export type ActivateRefusalKind = 'not-configured' | 'unverifiable' | 'occupied';

/**
 * Which subsystem refused. One member today, and published as a set for the same
 * reason.
 *
 * THE CONSEQUENCE OF SPLITTING THE TWO FIELDS, stated because it is invisible
 * from either declaration (KAN-376). `capacity` is the most actionable refusal
 * on this surface — it is the ordinary one in a busy fleet, and the caller has
 * three distinct answers to it (wait, `override`, `preempt`, with `preemption`
 * naming whose work would end). A consumer that branches on `refused` ALONE
 * reads `undefined` there. The split is right — `refused` answers WHAT
 * CONDITION and this answers WHICH SUBSYSTEM — but a reader who meets only one
 * of the two fields will not discover the other from the wire.
 */
export type ActivateRefusedBy = 'capacity';

type ActivateRefusalFields = Record<string, unknown> & {
  alreadyRunning?: true;
  started?: false;
  refused?: ActivateRefusalKind;
  refusedBy?: ActivateRefusedBy;
  /**
   * KAN-382. Typed rather than left to `Record<string, unknown>`, for the reason
   * the two fields above are: this is the one refusal field whose value is a
   * closed vocabulary the compiler already owns, so a site inventing a sixth
   * cause — the thing the contract says will never happen without a version
   * bump — does not build. `?` here is "absent on the other ten branches", NOT
   * "optional on `bad-address`": that branch's `always` list makes it
   * mandatory, and the proof asserts the key set as an equality.
   */
  pathProblem?: PathProblem;
};

/**
 * WHAT AN AGENT IS, ECHOED BACK — the durable half of every state read.
 *
 * THE PROBLEM THIS FIELD IS THE ANSWER TO. A consumer reconciling desired
 * state against ours has to diff against what CrabCast believes each agent's
 * configuration is — priority, the gate flags, launcher, prompt, MCP servers —
 * not merely whether it is alive. Without that it has to keep a shadow copy of
 * what it asked for, and then the two can disagree with no way to tell which is
 * right: the drift detector becomes the drift. The values were already written
 * on every record and read back by nothing.
 *
 * VERBATIM FROM THE RECORD, and that word is load-bearing. Nothing here is
 * re-derived from live config, from the launcher table, or from the census —
 * every one of those would be a second copy of a rule, and the second copy is
 * the one that is wrong after somebody reconfigures. `config` is the object
 * `configure` accepted, echoed as it was frozen.
 *
 * WHY THE ECHO IS HONEST ABOUT A RUNNING AGENT, which is the part worth
 * reviewing: the echoed block claims to describe what the agent is ACTUALLY
 * running with, and that can only diverge from what was last requested if a
 * spawn-time attribute changed under a live agent. `configure` refuses exactly
 * that. So for a running agent the echoed config IS the running config, and for
 * a stopped one it is what the next `activate` will use. Both honest, and
 * distinguishable by the liveness the read already carries.
 */
interface ConfigEcho {
  /**
   * `configure`'s argument list, exactly as it was frozen onto the record.
   *
   * `null` — explicitly, never omitted — when no record backs this row at all.
   * Over JSON an absent field reads as "not answered", and this is answered:
   * there is nothing to echo. It is the one honest way to say "not configured"
   * without inventing a configuration, and it is why every consumer of this
   * block has to handle null rather than assuming a shape.
   *
   * TWO SHAPES SINCE KAN-528, and which one you are holding is decided by the
   * RESPONSE rather than by the row. A single read (`agent_status`) echoes
   * {@link AgentConfig} whole. A FLEET read (`list_agents`) echoes
   * {@link SummarisedAgentConfig}, which has no `prompt` at all and carries
   * {@link ConfigEcho.promptChars} in its place — because one prompt per row,
   * across a fleet, is what pushed this response past the framing bound and
   * stopped `crabcast list` answering. `configEchoContract.summarised` on the
   * response says which of the two you got, in the response's own words rather
   * than by inference from a missing key.
   */
  config: AgentConfig | SummarisedAgentConfig | null;
  /**
   * How many characters the prompt on the durable record has — `null` when the
   * record carries none, and `null` when no record backs this row at all.
   *
   * ON EVERY ROW OF EVERY RESPONSE, INCLUDING THE ONES THAT CARRY THE PROMPT
   * WHOLE. It would have been shorter to put it only where the text is missing,
   * and that is the version that rots: a consumer would then have to know which
   * surface it was reading before it knew whether the field it wanted existed,
   * which is the inference this field exists to remove. Here it is one key with
   * one meaning on both, and on the single read it is simply the length of the
   * `prompt` sitting beside it — redundant, checkable, and the thing that makes
   * the fleet read's number verifiable against a surface that still has the
   * text.
   *
   * THE TWO NULLS ARE DISTINGUISHABLE AND NOT BY THIS FIELD: `config: null`
   * says no record backs the row, and a `config` present beside
   * `promptChars: null` says the record is there and has no prompt. Read them
   * together, exactly as the rest of this block is read.
   */
  promptChars: number | null;
  /** {@link AgentIntent.configVersion} — the compare-and-set token. Null with `config`. */
  configVersion: number | null;
  /** When that version was frozen. Null on a pre-field row, and with `config`. */
  configuredAt: string | null;
  /**
   * Whether activating this agent RESUMES a conversation or starts a fresh
   * one. See {@link AgentIntent.everActivated}: it is the behavioural
   * difference between `unstartedAgents` and `standbyAgents`, and it is on
   * every row rather than only on those two because it is a fact about the
   * agent rather than about the list it happens to be in.
   */
  everActivated: boolean;
  /**
   * The supervisor of record — the canonical path of the agent that activated
   * this one — or `null` when nobody did.
   *
   * ON THIS BLOCK RATHER THAN ON ANY ONE CATEGORY, and that placement is most
   * of the defence. The failure this field exists to prevent is a category that
   * silently omits it: a consumer reading `agents` would see parentage, build
   * an org chart, and find `preemptedAgents` answering nothing about the agent
   * whose supervisor it most needs to tell. Every category spreads
   * {@link configEcho} rather than assembling its own block, so a category that
   * forgot has a field MISSING rather than a plausible-looking row.
   *
   * THIS COMMENT USED TO CLAIM MORE THAN THE CODE DID, and the correction is
   * worth keeping because the overclaim is the easier thing to write. It said
   * the property "holds for categories nobody has written yet". It did not: a
   * new row interface that simply does not extend `ConfigEcho` compiled clean
   * and shipped in the response, which was demonstrated rather than argued.
   * What existed was a convention every author had happened to keep.
   *
   * What holds now, exactly: {@link FleetCategories} names every row-carrying
   * category and {@link FleetCategoriesCarryTheEcho} makes each one
   * `ConfigEcho[]` at COMPILE time, so a declared category that drops the echo
   * fails the build. A category added straight into the response object,
   * bypassing that interface, is NOT a build error — TypeScript has no exact
   * type for the payload — and is caught by proof instead:
   * `verify-activated-by.mjs` §3 sweeps every array in a real response. See
   * {@link FleetCategories} for why both, and for what neither covers.
   *
   * `null` is emitted, never omitted, for the reason `config` is: over JSON an
   * absent key reads as "not answered", and this is answered. A human-initiated
   * activation has no supervisor, and that is a fact, not a gap.
   *
   * DURABLE, not observed — see {@link STATE_READ_PROVENANCE}. It comes off the
   * append-only record and nothing about the live census can change it, which
   * is what makes it survive a daemon restart.
   */
  activatedBy: string | null;
}

/**
 * ONE UNDECLARED FIELD FOUND INSIDE ONE `config` ECHO, with where it was.
 *
 * `path` is the whole address on the response (`agents[3].config.telemetry`) so
 * a reader can go and look at the row. `field` is the same finding relative to
 * the declaration (`config.telemetry`), which is what identifies the DEFECT
 * rather than the sighting: the same undeclared knob shows up on every row of
 * every category and would otherwise be N different-looking warnings, and its
 * row index moves whenever the fleet does.
 */
interface ConfigEchoFinding {
  path: string;
  field: string;
}

/**
 * Every `config` echo on a response, swept against the declaration the MCP
 * event projection enforces.
 *
 * WHY THIS WALKS THE RESPONSE RATHER THAN THE CATEGORIES (KAN-166). The
 * categories are the ones {@link FleetCategories} knows about, and that
 * interface is exactly what a new category added straight into `respond({…})`
 * bypasses — the residue `FleetCategories`'s own comment declares and
 * `verify-activated-by.mjs` §3 covers by sweeping the real payload. This sweep
 * is written the same way and for the same reason: it applies a rule to the
 * object that actually goes out, so a category nobody declared is swept the day
 * it ships rather than the day somebody remembers to add it here.
 *
 * IT STOPS AT `config` AND DOES NOT RECURSE PAST IT. Below that key the
 * declaration is in charge — including the one region it declares VERBATIM,
 * `config.mcpServers`, whose keys are the caller's own server names. Walking on
 * generically would report those as drift, which would be this daemon
 * complaining about bytes it has promised never to read.
 *
 * `config: null` is skipped because it is an ANSWER — "no record backs this
 * row" — rather than a composite with an interior. Anything else non-null is
 * handed to the declaration even when it is not an object at all: a `config`
 * that arrived as a string is drift of the loudest kind, and the walker reports
 * it at its own path.
 */
function sweepConfigEchoes(node: unknown, at: string, found: ConfigEchoFinding[]): void {
  if (Array.isArray(node)) {
    node.forEach((element, i) => sweepConfigEchoes(element, `${at}[${i}]`, found));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const where = at ? `${at}.${key}` : key;
    if (key === 'config') {
      if (value === null) continue;
      for (const field of undeclaredFields(value, CONFIG_SHAPE, 'config')) {
        found.push({ path: at ? `${at}.${field}` : field, field });
      }
      continue;
    }
    sweepConfigEchoes(value, where, found);
  }
}

/**
 * The knobs whose interior this contract deliberately does not declare, derived
 * from the declaration rather than restated beside it.
 *
 * Exactly one today (`mcpServers`), and it is published so a consumer reading
 * `undeclared: []` knows what that sentence does not cover. A hole nobody names
 * is how "swept" comes to be read as "swept everywhere".
 */
const VERBATIM_CONFIG_KNOBS = Object.entries(CONFIG_FIELDS)
  .filter(([, shape]) => shape.kind === 'verbatim')
  .map(([knob]) => knob);

/**
 * THE POLL PATH'S DECLARED-FIELD CONTRACT, on the response that carries the
 * object it is about (KAN-166).
 *
 * WHY IT EXISTS. KAN-164 made the MCP event projection walk composite fields,
 * so a knob appearing inside `config` on an event is reported and dropped
 * rather than passed through unexamined. The same `AgentConfig` object rides
 * every row of `list_agents` inside {@link ConfigEcho}, where nothing looked at
 * it — so for one day the object was guarded on the surface a consumer is told
 * is a latency optimisation and unguarded on the surface
 * `docs/event-contract.md` §2 makes a CORRECTNESS requirement.
 *
 * WHAT IT REPORTS AND WHAT IT DOES NOT DO, and the second half is the part to
 * read: **this path REPORTS and never DROPS.** The undeclared field is named
 * here and still travels in the echo. Three reasons, all of them stated in §2
 * of the document as well, because a surface behaving one way while a sentence
 * implies another is the failure this repository keeps filing:
 *
 *  1. {@link ConfigEcho} promises the durable record VERBATIM, and a consumer
 *     reads it precisely so it does not have to keep a shadow copy. A response
 *     that quietly dropped part of the record would make the echo a projection
 *     of the record while still calling itself the record — the drift detector
 *     becoming the drift, which is the exact failure the echo was built for.
 *  2. An event is at-most-once with no second copy and no way to re-request it,
 *     so what is not on the wire is gone. A response answers a call the caller
 *     can make again, holding a `configVersion` to compare — the same asymmetry
 *     §1 of the document already draws for `durable`.
 *  3. `list` is the authoritative read. Dropping fields here would leave the
 *     authoritative read carrying LESS than the latency optimisation over it,
 *     which inverts the relationship the whole contract is built on.
 *
 * So the answer to "is anything travelling unexamined" is a field on the
 * response rather than a silence, and acting on it is the reader's.
 *
 * BOTH READ SURFACES CARRY IT (KAN-168). `agent_status` echoes the SAME object
 * for one agent through the same {@link configEcho}, and it is swept by this
 * same pair of functions at its own call site — same block, same `drops: false`,
 * same reasons, because the three above are about the ECHO rather than about
 * which verb asked for it.
 *
 * THIS PARAGRAPH USED TO SAY THE OPPOSITE, and it was accurate for the four
 * days it stood: KAN-166 guarded the fleet read and stopped there deliberately,
 * and the hole was written down here, in §2 of the document, and in the proof's
 * own header. All three were honest and none of them closed it — which is the
 * thing worth remembering from it. A named gap is documentation, not coverage.
 *
 * WHERE THIS STOPS, so the sentence above is not read wider than it is. On
 * either response the sweep is the ECHO's, not the payload's: `capacity`,
 * `provenance`, `pages` and the `*Total`s are contract by
 * `docs/event-contract.md` and by their own proofs, and nothing here examines
 * them.
 */
interface ConfigEchoContract {
  /** Every knob {@link CONFIG_FIELDS} declares. The list, not a copy of it. */
  declared: string[];
  /**
   * Knobs declared to travel WHOLE, whose interiors this sweep does not
   * examine. See {@link VERBATIM_CONFIG_KNOBS} and §4 of the document.
   */
  verbatim: string[];
  /**
   * Whether an undeclared field is removed from this response. **Always
   * `false`**, and present as a field rather than as documentation because
   * "which surface drops and which reports" is the question a consumer holding
   * one response actually has. The MCP event path's answer is the other one.
   */
  drops: boolean;
  /**
   * Undeclared fields found on THIS response, by their full path
   * (`standbyAgents[2].config.telemetry`). Empty means the sweep ran and found
   * nothing — never that it did not run, which is why the whole block is on
   * every response rather than only on a response with something to report.
   */
  undeclared: string[];
  /**
   * DECLARED KNOBS THIS RESPONSE CARRIES AS A MEASUREMENT RATHER THAN WHOLE,
   * each naming what stands in for it (KAN-528).
   *
   * A SEPARATE AXIS FROM {@link ConfigEchoContract.drops}, and collapsing them
   * would lose the distinction that matters. `drops` is about an UNDECLARED
   * field — something nobody designed for, which this surface reports and still
   * delivers. This is about a DECLARED one that was designed for, is known to
   * be here, and is deliberately not carried on this surface because carrying
   * it broke the response. `drops: false` stays literally true: nothing is
   * removed for being undeclared.
   *
   * EMPTY IS THE ANSWER FOR A RESPONSE THAT SUMMARISED NOTHING — `agent_status`
   * carries every knob whole and says so with `[]`, which is a different
   * sentence from a missing block. Present on every response for the same
   * reason `undeclared` is: a consumer must be able to tell "the sweep ran and
   * there was nothing to report" from "this daemon predates the field".
   */
  summarised: SummarisedKnob[];
  note: string;
}

/**
 * One declared knob a response measured instead of carrying.
 *
 * THE `why` IS PART OF THE CONTRACT AND NOT DECORATION. A consumer meeting a
 * field it expected and did not get has exactly one question, and a block that
 * names the substitute without saying why sends them to the source to find out.
 */
interface SummarisedKnob {
  /** The knob's path in the echo, e.g. `config.prompt`. */
  knob: string;
  /** The key carrying the measurement instead, e.g. `promptChars`. */
  replacedBy: string;
  /** Where the whole value can still be read. */
  wholeAt: string;
  /** Why this surface does not carry it. */
  why: string;
}

/**
 * Describe the contract, given what {@link sweepConfigEchoes} found on the
 * payload that is about to go out.
 */
/**
 * What a FLEET read summarises. The one entry, named once.
 *
 * A CONSTANT RATHER THAN A LITERAL AT THE CALL SITE, because this block is the
 * only thing on the wire that says the prompt is not there, and a second copy
 * of it is the thing that would be edited out of step with the code that does
 * the summarising.
 */
const FLEET_SUMMARISED_KNOBS: readonly SummarisedKnob[] = [
  {
    knob: 'config.prompt',
    replacedBy: 'promptChars',
    wholeAt: 'agent_status (one agent, by path) carries config.prompt whole',
    why:
      'A prompt is finished text of arbitrary length and this response echoes one per row. ' +
      'Measured on a real fleet, prompts were 97% of the registry\'s bytes, and ten ' +
      'supervisor-sized prompts exceed the socket\'s 1 MiB framing bound on their own — at ' +
      'which point this response is not truncated, it is not delivered at all and the ' +
      'connection is closed. promptChars is the exact character count of the prompt on the ' +
      'record: 0 means an empty prompt was frozen, null means the record carries none. No row ' +
      'is dropped, no count is approximate, and no text is shortened and passed off as whole.'
  }
];

function configEchoContract(
  found: readonly ConfigEchoFinding[],
  summarised: readonly SummarisedKnob[]
): ConfigEchoContract {
  return {
    declared: Object.keys(CONFIG_FIELDS),
    verbatim: VERBATIM_CONFIG_KNOBS,
    summarised: [...summarised],
    // A LITERAL rather than a computed value, and it has to stay one: this
    // field is a claim about the code above it, and a `drops` derived from
    // anything would be able to say `false` while a projection had been added.
    // If this path ever does drop, this line changes in the same edit.
    drops: false,
    undeclared: found.map((f) => f.path),
    // DERIVED FROM `summarised` RATHER THAN WRITTEN OUT, and that is the point
    // of it (KAN-528). This sentence used to open "config on every row is the
    // durable record VERBATIM" unconditionally — true when it was written, and
    // refuted by the first response that summarised anything. A note that
    // states a property the code beside it no longer has is the defect this
    // ticket was filed about, so the note is now computed from the same value
    // the response carries: a surface that summarises nothing still says
    // VERBATIM, and one that summarises something cannot.
    note:
      (summarised.length
        ? `config on every row is the durable record with ${summarised.length} declared knob(s) ` +
          `carried as a measurement rather than whole — see \`summarised\`, which names each one, ` +
          `what stands in for it and where the whole value is still readable. Every OTHER knob is ` +
          `verbatim. NO ROW IS OMITTED and no count on this response is reduced: the summary is ` +
          `per-field, never per-row. `
        : 'config on every row is the durable record VERBATIM. ') +
      'Swept against the same declaration ' +
      '(CONFIG_FIELDS in src/events.ts) the MCP event projection enforces. Undeclared fields are ' +
      'REPORTED here and still delivered — this response drops nothing; the MCP event path drops ' +
      'what it names. Do not key behaviour off an undeclared field: it has not been designed for ' +
      'you and can change or vanish. See docs/event-contract.md §2 and §4.'
  };
}

/**
 * The fleet category an agent is in, derived in ONE place.
 *
 * `agent_status` and `list_agents` answer the same question about the same
 * agent, and two derivations of that could disagree — which is precisely the
 * failure a reconciler cannot survive, since it would see a row in one category
 * and a different verdict from the other read. So both call
 * {@link MessageRouter.stateOf}, and the verify script asserts the two agree
 * for every state.
 */
type AgentState =
  /** Live, by the single ownership test. */
  | 'running'
  /** The record says activated; the census has no such agent. A loss. */
  | 'missing'
  /** Stood down to make room for something else. A debt. */
  | 'preempted'
  /** Stood down, and it has run before: activating it resumes. */
  | 'standby'
  /** Configured and NEVER activated: activating it starts fresh. */
  | 'unstarted'
  /** No record at all. Not an agent; nothing to echo. */
  | 'unconfigured'
  /**
   * A record that has run, and a census that did not answer.
   *
   * Every other state below `running` is a claim that the agent is NOT
   * running, and only a census that answered can support one. Saying `missing`
   * because herdr was down would hand a reconciler "your agent died" as the
   * report of our own outage. `unstarted` is the one that stands without a
   * census, because a record that never carried an activation has no
   * activation for the census to be stale about.
   */
  | 'unknown';

/**
 * Which fields of a state read came from the durable record, which were
 * observed live, and which are computed from the identity.
 *
 * SAID IN THE RESPONSE RATHER THAN ONLY IN THE DOCS, because conflating the
 * two is exactly the ambiguity the config echo exists to remove. `paneId` is
 * the sharpest case: it is not on the durable record at all — herdr pane ids
 * are positions in a list that compacts, so every one reported here is read
 * live from the census that answered this call, and a consumer that stored one
 * as though it were configuration would be holding a value that goes stale when
 * an unrelated pane closes.
 *
 * The three buckets are exhaustive over every key any row carries, and the
 * verify script asserts that — a field added later without being classified
 * fails the check rather than quietly joining whichever bucket a reader
 * assumes. That is the whole reason this is data rather than prose.
 */
const STATE_READ_PROVENANCE = {
  /**
   * Read from the append-only registry. Survives a daemon restart unchanged,
   * because it never lived in memory in the first place.
   *
   * One caveat stated rather than left to be discovered: on a row whose
   * `configured` is `false` there is no record, so `config` is null and the
   * loose gate flags are the SAFE READING of an unknown rather than anybody's
   * configuration. A row with `config: null` is the one row here that is not
   * echoing anything.
   */
  durable: [
    'path', 'config', 'configVersion', 'configuredAt', 'everActivated', 'activatedBy', 'configured',
    // DURABLE RATHER THAN DERIVED, though it is a length this daemon computed
    // (KAN-528). The bucket is about WHERE THE VALUE CAME FROM, and this one
    // came from the registry and nothing else: it survives a restart unchanged
    // and no census was consulted for it. `derived` is for fields computed from
    // durable AND observed state — `state` is the example — and calling a pure
    // function of one record `derived` would tell a reader that a census could
    // move it, which is the one thing this legend exists to answer.
    'promptChars',
    'label', 'refusable', 'chargeable', 'preemptable', 'launcher', 'priority',
    'since', 'at', 'wasPreempted', 'by', 'derivation', 'herdrStatusWhenPreempted',
    'occupiedAgent',
    // `unreadableRecords[]` (KAN-302, extended by KAN-344). These five are the
    // row's OWN bytes, read off the log and unchanged by a restart, which is
    // this bucket's definition applied to a row that is not an agent. The other
    // six fields of that shape are this daemon's account of the row rather
    // than the row, and are in `derived` below — see ROW_SHAPES.UnreadableRecord
    // for why the split falls where it does. `claimsAt` and `claimsEvent` are on
    // this side rather than the other precisely because they are quotes: this
    // daemon does not parse, range-check or interpret either one.
    'identity', 'raw', 'claimsPath', 'claimsAt', 'claimsEvent'
  ],
  /**
   * Read live, from the census or the session that answered THIS call. True
   * when it was read and not one moment longer.
   *
   * `paneId` is the one to look at: it is deliberately NOT on the durable
   * record, because herdr pane ids are positions in a list that compacts
   * whenever any pane anywhere closes. A consumer that stored one as though it
   * were configuration would hold a value that goes stale when an unrelated
   * agent finishes.
   */
  observed: [
    'paneId', 'herdrStatus', 'agentRuntime', 'status', 'sessionId', 'createdAt',
    'sessionless', 'workDir',
    // `missingAgents[].occupiedBy` (KAN-572). OBSERVED rather than derived, and
    // the neighbouring `occupies` two buckets down is why the distinction is
    // worth stating: that field is a JOIN — a census cwd tested against the
    // registry — so it is this daemon's conclusion. This one is a census record
    // QUOTED. The pane is not ours, there is nothing durable to be had about it,
    // and every field under the block was read from herdr for this response and
    // is true as of `observedAt` and no longer.
    'occupiedBy'
  ],
  /**
   * Computed by this daemon from the two above. Never stored and never read off
   * a pane: `paneName` is a pure function of the path, `state` and `occupies`
   * join the record against the census, and `reason` is the sentence that
   * explains the result.
   */
  // `line`, `problem`, `rawTruncated` and `promptRedacted` are
  // `unreadableRecords[]`'s (KAN-302) — a verdict, a newline count and two facts
  // about what this response did to the bytes. `reason` was already here and
  // covers that shape's sentence too, which is the same word doing the same job.
  // `standing` is KAN-344's, and it is the second verdict on that shape: what
  // this daemon makes of the row's own `claimsEvent`, which sits in `durable`
  // two lines up. A newer CrabCast may read the same word differently, and this
  // daemon abstains outright on a `from-newer` row — both of which are exactly
  // what `derived` is for and neither of which is true of a quote.
  derived: [
    'paneName', 'state', 'occupies', 'reason',
    'line', 'problem', 'rawTruncated', 'promptRedacted', 'standing'
  ],
  /**
   * REMEMBERED BY THIS PROCESS: neither on the record nor in the census that
   * answered this call, but accumulated by this daemon's own fleet sweep and
   * held in memory. Gone on a restart, and null until this daemon has watched
   * the thing it describes happen — which is the WHOLE FLEET of a daemon that
   * has just started, in the window where a state nobody watched an agent enter
   * is most likely. See {@link MessageRouter.recordSweepObservation} for when
   * the null actually falls and why that coincidence is not a defect.
   *
   * A FOURTH BUCKET RATHER THAN A FIELD SQUEEZED INTO ONE OF THE THREE, and
   * that is the whole reason it exists. `statusSince` is not durable — it is
   * not written anywhere. It is not `observed` either, and that is the one a
   * reader would otherwise assume: `observed` promises "read from herdr for
   * THIS response and true as of `observedAt`", and `statusSince` was read
   * from no census at all — it is this process's memory of an EARLIER sweep.
   * Filing it under `observed` would have made the legend's own sentence
   * false for exactly one field, which is worse than having no legend: a
   * consumer trusts what the legend says about a field it has never seen
   * before.
   *
   * It is not `derived` either. `derived` says "computed from the two above",
   * and nothing in the record or in this call's census can produce it — the
   * only input is what this process saw last time.
   *
   * ONLY `list_agents` ROWS IN `agents` CARRY A FIELD FROM THIS BUCKET.
   * `agent_status` does not, and neither do the four not-running categories:
   * the memory is keyed on the sweep's census of our LIVE agents and is
   * dropped the moment an agent stops appearing in one, so those rows would
   * carry a field that is structurally incapable of being anything but null.
   * The legend is shared by both responses, so this bucket is announced on a
   * surface that has no field in it — the same way `workDir` and
   * `occupiedAgent` are announced on responses that do not carry them.
   */
  remembered: ['statusSince']
} as const;

/**
 * The legend that says which fields of a read response are durable, which were
 * observed just now, which this daemon computed, and which it merely remembers.
 *
 * On the response rather than only in the docs, because conflating durable
 * state with a live observation is precisely the ambiguity the config echo
 * exists to remove — and `paneId` is a value that a consumer would otherwise
 * quite reasonably store.
 *
 * NOT THE SAME PROVENANCE AS `provenance.ts`, and the two are worth telling
 * apart because they arrived within an hour of each other. That module answers
 * "which BUILD is this daemon running", on `daemon_status` as `build` and
 * `freshness`. This answers "where did each FIELD of this agent's state come
 * from", on `agent_status` and `list_agents`. Different question, different
 * response, no shared field name on the wire.
 *
 * A FUNCTION RATHER THAN A METHOD SINCE KAN-277, and the move is mechanical
 * rather than cosmetic: it reads no instance state, and a private method cannot
 * be reached by an indexed-access type, so the binding below could not be
 * written while it was one. Nothing about the block on the wire changed.
 */
function stateReadProvenance(census: HerdrCensus) {
  return {
    ...STATE_READ_PROVENANCE,
    /** When the census behind every `observed` field answered. */
    observedAt: new Date().toISOString(),
    /**
     * Whether herdr answered at all. `false` means every `observed` field is
     * this daemon's last resort rather than a reading — an empty census from an
     * unreachable herdr is silence, not evidence, and a reader must not take an
     * absent pane as proof the agent is down.
     */
    censusReachable: census.reachable,
    note:
      'durable fields come from the append-only agent registry and survive a daemon ' +
      'restart unchanged; observed fields were read from herdr for THIS response and ' +
      'are true as of observedAt; derived fields are computed from the two. paneId is ' +
      'observed, never durable — herdr pane ids are positions in a list that compacts. ' +
      'remembered fields are this daemon\'s own accumulated observation, held in memory ' +
      'and NOT surviving a restart: statusSince is when this process first saw the agent ' +
      'in the status beside it, and is null when it has not watched it change (which is ' +
      'every agent on a freshly started daemon). Null there is an answer, not a gap — ' +
      'a consumer wanting a window longer than one daemon\'s life keeps its own.'
  };
}

/**
 * One row of `list_agents`. Two kinds of entry share this shape, and the
 * difference between them is the point of the field that names it:
 *
 * - `sessionless: false` — this daemon holds the agent's terminal attach, so
 *   every field is populated from the session it owns.
 * - `sessionless: true` — the agent is alive in herdr but no session of ours
 *   describes it, which is every surviving agent after a daemon restart. The
 *   session-only fields are null because there is no session, not because the
 *   agent is impaired.
 *
 * Nulls are explicit rather than omitted: over JSON an absent field reads as
 * "not answered", and these are answered — with nothing.
 */
interface ListedAgent extends ConfigEcho {
  sessionless: boolean;
  /** Which category this row would appear in. See {@link AgentState}. */
  state: AgentState;
  /**
   * Whether a durable record backs this row. `false` means `config` is null
   * and the gate flags below are the safe reading of an unknown rather than
   * anybody's configuration.
   */
  configured: boolean;
  /** The canonical directory this agent is. The address; nothing else is. */
  path: string;
  /** The opaque herdr token for that path. Nothing parses it back out. */
  paneName: string;
  paneId: string | null;
  sessionId: string | null;
  createdAt: string | null;
  status: HerdrSession['status'] | null;
  herdrStatus: HerdrAgentStatus;
  /**
   * When THIS DAEMON first observed the agent in the `herdrStatus` above, or
   * null when it has not observed it change into anything.
   *
   * WHAT IT IS FOR (KAN-200). Two agents stopped at their runtime's
   * usage-limit dialog and sat there for hours. The process was alive, the
   * pane was present, `list_agents` reported them under `agents` with
   * `herdrStatus: 'idle'`, and they were in none of the not-running
   * categories — indistinguishable, in everything this daemon published, from
   * an agent that had finished and was waiting for its next instruction. The
   * one fact that would have separated them is how LONG they had been like
   * that, and the sweep already knew and threw it away.
   *
   * IT IS NOT A DIAGNOSIS AND MUST NOT BECOME ONE. This daemon does not know
   * what a "usage limit" is; that is the agent runtime's vocabulary, and
   * learning to recognise one runtime's modal would rot the first time that
   * tool changed a word (the parseable-name antipattern, KAN-103/KAN-123).
   * What is published is one fact — the status, and when this daemon first
   * saw it — and "idle since four hours ago while its ticket says In
   * Progress" is then a judgement the CALLER makes, out of this field and its
   * own knowledge, which is the half this daemon does not have.
   *
   * SO IT IS ALSO NOT A HEARTBEAT AND NOT A LIVENESS PROBE. It says nothing
   * about whether the agent is healthy, and an agent quietly waiting on a
   * human looks exactly like one wedged at a screen nobody will answer. That
   * ambiguity is deliberate: distinguishing them requires interpreting a
   * screen, which is how a confident wrong answer gets produced.
   *
   * IN MEMORY, PER DAEMON, AND NULL IS A REAL VALUE. See
   * {@link MessageRouter.recordSweepObservation} for the whole of the
   * mechanism and for the durability decision, which was settled by KAN-189
   * and is not reopened here.
   *
   * AND NULL FALLS WHERE IT IS LEAST WELCOME, which is a different sentence
   * from "it does not survive a restart" and the one a caller does not reach
   * on their own. A daemon restarts when its fleet does — a crash, a reboot, a
   * power cut — so the fleet this field goes dark for is the same fleet that
   * has just come back in states nobody watched it enter, which is the exact
   * condition KAN-200 built the field to expose. The loss is correlated with
   * the thing being detected rather than independent of it. Same pointer as
   * above for why that is inherent rather than fixable.
   */
  statusSince: string | null;
  /** herdr's own `agent` field: the CLI running in the pane, null for a shell. */
  agentRuntime: string | null;
  /** Display only. Never parsed, never an address. */
  label: string | null;
  /**
   * The gate triple from this agent's record, replacing the single
   * `gateExempt` boolean this row used to carry.
   *
   * Three decisions were wearing one flag, and they are genuinely different
   * questions: whether the capacity gate may refuse this agent, whether it
   * occupies a charged slot, and whether anything may stand it down to make
   * room. `gateExempt: true` meant all three at once, which is only ever right
   * by coincidence — a low-priority always-on watchdog wants to be uncharged
   * and unpreemptable but has no business being un-refusable.
   *
   * Sent because a client cannot derive them: they live on the agent's own
   * record, and a client re-deriving them from anything else would be a second
   * copy of a rule — the copy that is wrong after somebody reconfigures.
   */
  refusable: boolean;
  chargeable: boolean;
  preemptable: boolean;
}

/**
 * A pane sitting in one of our directories with nothing running in it.
 *
 * Reported separately rather than dropped: it is not an agent (nothing to
 * message, tail or supervise) and counting it would give a supervisor a number
 * it cannot act on, but silently dropping it would repeat the mistake the
 * census exists to fix.
 */
interface UnbackedPane extends ConfigEcho {
  paneName: string;
  paneId: string | null;
  path: string;
  herdrStatus: HerdrAgentStatus;
  reason: string;
}

/**
 * A live pane that is not ours.
 *
 * NEW, AND THE DIRECT CONSEQUENCE OF DELETING THE CENSUS PREFIX FILTER. This
 * daemon used to decide what was "one of ours" by testing whether a pane name
 * started with `crabcast-` and parsed back into a type and key — a convention
 * masquerading as a filter. What is ours is now a question the durable
 * registry answers: a pane whose canonical `cwd` is a path we have a record
 * for AND whose name is the one that path derives. Everything else is
 * somebody's pane, and herdr hosts more than CrabCast.
 *
 * They are reported rather than dropped because one of them is the reason
 * `activate` refuses: `occupies` is non-null exactly when a stranger's agent
 * is sitting in a directory we have been configured for, which is the state
 * that would otherwise put two agents in one directory.
 */
interface ForeignPane {
  paneName: string;
  paneId: string | null;
  /** herdr's `cwd`, as herdr reported it. */
  workDir: string | null;
  /** Set when that cwd is a directory we hold a record for. */
  occupies: string | null;
  herdrStatus: HerdrAgentStatus;
  agentRuntime: string | null;
  /**
   * OUR agent for the directory this pane is sitting in — its configuration,
   * version and state — or null when it occupies nothing we hold a record for.
   *
   * NAMED THIS WAY ON PURPOSE, and it is the one place on this response where
   * the config echo could be misread. A foreign pane is not ours: it has no
   * CrabCast configuration, and putting a bare `config` on this row would say
   * it did. What the block describes is the agent this pane is BLOCKING — the
   * one whose `activate` will be refused until the pane is gone — which is the
   * thing a reader of this row actually needs, and the nesting is what keeps
   * the two from being confused.
   */
  occupiedAgent: (ConfigEcho & { path: string; state: AgentState }) | null;
}

/**
 * The capacity numbers as they go over the wire.
 *
 * Flat and named rather than nested, because the caller most likely to read
 * this is a language model deciding whether to staff another agent, and the
 * fields it needs — `headroom`, `atCapacity`, `summary` — should not be at the
 * end of a path. `summary` is the same figures in a sentence: a caller that
 * ignores every number still cannot ignore that one.
 */
function capacityDto(c: Capacity) {
  return {
    cap: c.cap,
    running: c.running,
    exemptAgents: c.exemptAgents,
    headroom: c.headroom,
    atCapacity: c.atCapacity,
    capBoundBy: c.capBoundBy,
    headroomBoundBy: c.headroomBoundBy,
    // The one sentence a UI with a single line to spare can render. Sent on
    // every capacity payload rather than only on refusals, because a client
    // that has to explain a refused toggle should not have to parse the
    // reason out of a paragraph of derivation.
    reason: capacityReason(c),
    cores: c.machine.cores,
    // Reported on every payload since KAN-208 and no longer what gates
    // anything wherever `cpuBusyCores` is non-null. Kept on the wire because a
    // caller comparing the two is reading the finding that ticket recorded —
    // and because a machine where they diverge is a machine worth looking at.
    load1: Math.round(c.machine.load1 * 100) / 100,
    // Cores observed in use, or null where nothing measured — in which case
    // `headroomBoundBy: 'load'` says the load average stood in. Three fields
    // rather than one so a caller can date the figure without asking again.
    cpuBusyCores: c.cpu ? Math.round(c.cpu.busyCores * 100) / 100 : null,
    cpuWindowSeconds: c.cpu ? Math.round(c.cpu.windowSeconds) : null,
    cpuObservedAt: c.cpu ? new Date(c.cpu.sampledAt).toISOString() : null,
    // KAN-263: what the CPU-side reading could not have contained, and what it
    // cost. On the wire rather than only in the derivation because a client
    // showing `cpuBusyCores` beside `headroomByCpu` and nothing else is showing
    // a subtraction that does not come out — the charge is the missing term,
    // and `startsChargeBecause` is the sentence that makes it checkable.
    // `startsCharged: 0` is a settled fleet; `startsConsidered` is how many the
    // ledger held, so a caller can tell that state from an instrument that
    // stopped writing.
    startsCharged: c.startsCharge.charged,
    startsConsidered: c.startsCharge.considered,
    startsChargeCores: c.startsCharge.cores,
    startsChargeBasis: c.startsCharge.basis,
    startsChargeBecause: c.startsCharge.because,
    totalMb: Math.round(c.machine.totalBytes / (1024 * 1024)),
    availableMb: Math.round(c.machine.availableBytes / (1024 * 1024)),
    agentMemoryMb: Math.round(c.cost.residentBytes / (1024 * 1024)),
    agentCores: c.cost.cores,
    // Where the two cost figures came from (KAN-56, in the extraction source):
    // 'override', 'measured' or 'seed', plus the sample's metadata when a
    // measurement was consulted.
    agentMemorySource: c.costSource.residentBytes,
    agentCoresSource: c.costSource.cores,
    measuredAt: c.measured ? new Date(c.measured.sampledAt).toISOString() : null,
    measuredWindowSeconds: c.measured ? Math.round(c.measured.windowSeconds) : null,
    measuredAgentTrees: c.measured ? c.measured.agentTrees : null,
    // KAN-338: the population the sample was drawn from. `measuredAgentTrees`
    // is the trees this daemon owns and charges for; this is every
    // agent-runtime tree the window saw. A consumer comparing the two is
    // asking how representative the divisor is, which is a question the
    // attributed count cannot answer alone.
    measuredTreesSeen: c.measured ? c.measured.treesSeen : null,
    capByCpu: c.capByCpu,
    capByMemory: c.capByMemory,
    headroomByCap: c.headroomByCap,
    headroomByCpu: c.headroomByCpu,
    headroomByLoad: c.headroomByLoad,
    headroomByMemory: c.headroomByMemory,
    // The stall veto (KAN-216). `stallPercent` is null when nothing measured —
    // NOT 0 — and `stallInstrument` says which kind of nothing: `absent` is a
    // kernel without PSI, `unreadable` is a machine whose PSI would not answer.
    // A caller that reads a percentage without reading that field can be
    // misled, which is why the field is on the wire rather than only in prose.
    stallPercent: c.stallPercent === null ? null : Math.round(c.stallPercent * 100) / 100,
    stallSource: c.stallSource,
    stallInstrument: c.stallInstrument,
    stalled: c.stalled,
    stallRefusePercent: c.stallRefusePercent,
    // What the counting terms allowed before the veto zeroed them. Equal to
    // `headroom` unless `stalled`.
    headroomBeforeStall: c.headroomBeforeStall,
    summary: summarizeCapacity(c)
  };
}

/**
 * THIS DTO IS PUBLISHED ON AN EVENT, so the event contract has to know its
 * shape — and finding out one field at a time on the wire is what KAN-164 was.
 *
 * `capacity.overridden` carries this object whole, and so does
 * `agent.deactivated`'s `preemption` block. The MCP forwarder projects
 * recursively now, which means a field added above without a line in
 * {@link CAPACITY_FIELDS} would be DROPPED from the notification and reported
 * as drift at runtime — correct, and a slow way to find out. Asserted in BOTH
 * directions, so a declaration whose field was deleted is equally red.
 *
 * It lives here rather than in `events.ts` because `events.ts` must not import
 * the router — the router imports it — and because a check reads best beside
 * the thing that would drift.
 */
const _capacityDtoMatchesTheContract: Exact<
  keyof ReturnType<typeof capacityDto>,
  keyof typeof CAPACITY_FIELDS
> = true;

/**
 * A flag that decides whether an agent gets destroyed, checked as a flag.
 *
 * `override` and `preempt` arrive from the wire as `unknown` and were tested
 * for truthiness, so the string `"false"` — what a shell client or a hand-typed
 * JSON line produces when someone means no — is true. For `override` that
 * quietly starts an agent past a cap the caller declined; for `preempt` it
 * tears down somebody else's running work. A flag whose wrong reading destroys
 * work is worth one type check: absent means no, a boolean means what it says,
 * and anything else is refused by name rather than guessed at.
 */
function invalidFlag(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return null;
  return (
    `Invalid ${name}: expected true or false, got ${JSON.stringify(value)}. ` +
    `This flag is not read for truthiness — it changes whether an agent is ` +
    `started past capacity or another agent is stood down, so it must be said exactly.`
  );
}

/**
 * An agent the registry says should be running that herdr does not have.
 *
 * This is the whole of the detectability half of the extraction source's
 * KAN-21, as data. On the day that ticket was written two agents ceased to
 * exist and their board read healthy for twenty minutes; the loss was found
 * only because a human thought to ask. The registry is what makes the question
 * answerable without asking — it holds the *intended* fleet, and anything in
 * it that herdr cannot show is a loss, reported on every `list_agents` poll
 * rather than written to a log.
 */
/**
 * A live pane THIS DAEMON DID NOT START sitting in a missing agent's directory
 * — the same pane `foreignPanes` reports, named on the row that would otherwise
 * be read as an empty workspace (KAN-572).
 *
 * WHY THE ROW CARRIES IT RATHER THAN LEAVING IT TO BE JOINED. `missingAgents`
 * and `foreignPanes` are computed from ONE census in one pass, and until this
 * field existed they were published side by side with nothing reconciling them:
 * a `crabcast list` naming a live pane by pane id sixty lines above the sentence
 * *"herdr has no live agent in its directory and this daemon holds no session
 * for it. It is not running."* — about the same directory, in the same run. The
 * classification was right and the EXPLANATION was false, which is the half
 * nobody re-checks.
 *
 * The mechanism is that our ownership question is NAME-scoped and that sentence
 * was DIRECTORY-scoped. `ourPaneIn` asks the census for a pane called
 * `paneNameFor(path)`; a stranger's pane in that directory carries a name we did
 * not derive, so it answers "no pane of ours" — correctly — and the row then
 * said herdr had nothing there at all. Both readings are explained at once by
 * that one difference.
 *
 * ALL FOUR FIELDS ARE `observed`: this is one census read, quoted, about a pane
 * that is on no record of ours. Nothing here is durable and nothing is
 * re-checked after the response is sent.
 */
export interface MissingAgentOccupant {
  paneName: string;
  paneId: string | null;
  herdrStatus: HerdrAgentStatus;
  agentRuntime: string | null;
}

export interface MissingAgent extends ConfigEcho {
  path: string;
  paneName: string;
  label: string | null;
  /**
   * When the registry last recorded this agent as activated.
   *
   * ACTIVE SINCE, NOT MISSING SINCE, and the difference is the whole of the
   * ordering decision recorded in {@link MessageRouter.handleListAgents}. This
   * daemon learns an agent is absent by comparing the registry against a
   * census taken just now; nothing anywhere records the moment it went. An
   * agent activated last Tuesday that died a minute ago carries a `since` of
   * last Tuesday, exactly like one that died last Tuesday. Reading this field
   * as "how long it has been down" is wrong for every row it is not accidental
   * on.
   *
   * AND THERE IS NOT GOING TO BE A SECOND TIMESTAMP HERE. KAN-189 asked
   * whether to record a durable first-observed-missing time so this category
   * could be ranked by neglect. **The answer is no, and the question is CLOSED
   * rather than deferred.** Four grounds, in the order they would change the
   * answer back:
   *
   * 1. IT WOULD BE THIS DAEMON'S ONLY DURABLE MEMORY OF AN OBSERVATION, and
   *    the sweep's other memory was decided the opposite way twenty lines from
   *    where this one would live. `lastObservedStatus` in `daemon.ts` — the
   *    status half of the same sweep, off the same census — is in memory on
   *    purpose, because "inventing a `from` out of a durable copy would be
   *    claiming to have witnessed a change nobody watched". A `missingSince`
   *    read back after a restart makes exactly that claim: the number's whole
   *    value is the DURATION between two observations, and this daemon was
   *    not watching between them. One sweep would then hold two opposite
   *    policies about its own memory, and the field whose reading is a
   *    duration would be the one that kept it.
   * 2. THE REGISTRY IS A LOG OF WHAT A CALLER COMMANDED, AND THIS IS NOT
   *    THAT. `configured` / `activated` / `deactivated` / `forgotten` are
   *    intents somebody expressed, and anyone reading the log can check them.
   *    "I noticed this was gone at 14:02" is a fact about a watcher. (The
   *    reason KAN-189 expected to be the hard one — two daemons over one
   *    dataDir holding different true values — does not arise: the socket
   *    lives in the dataDir, so the second daemon meets `EADDRINUSE`, probes
   *    the socket, finds a live owner and exits. What survives is not
   *    concurrency, it is KIND.)
   * 3. THE FIELD WOULD BE PERMANENT AND THE BENEFIT IS BOUNDED. This row is
   *    spread whole onto `agent.lost` (`docs/event-contract.md` §1), so a
   *    field here is a field on the event contract, the MCP projection and
   *    every consumer's reader — and everything published is treated as API.
   *    What it buys is the ORDER OF THE FIRST PAGE of a category, which only
   *    matters once more than {@link FLEET_CATEGORY_LIMIT} agents are missing
   *    at once, and every row is already reachable by cursor at any position
   *    (KAN-163).
   * 4. WHAT A READER WANTS IS ALREADY PUBLISHED, ONCE PER LOSS, WITH A TIME ON
   *    IT. `agent.lost` is latched per path and carries the envelope's `at`,
   *    and a consumer of these events is already REQUIRED to poll `list` on a
   *    timer (`docs/event-contract.md` §2) — so it holds both halves, and its
   *    own observation window is the only window in which a down-time figure
   *    is true anyway. Keeping that history here instead would be the "replay
   *    log beside the registry" §2 declines, narrowed to one field.
   *
   * WHAT THIS COSTS, recorded rather than left to be discovered: a consumer
   * that connects to a long-running daemon cannot learn how old an EXISTING
   * loss is. This daemon observed it and does not say. That is a real loss of
   * information and it is accepted, not denied — it is the same cost §2
   * already takes for every other event, and if it ever bites, the remedy is a
   * decision made with the consumer rather than a field added quietly.
   */
  since: string;
  /**
   * The foreign pane occupying this directory, or null when there is none.
   *
   * ⚠ **`null` IS THE ANSWER "NOTHING IS RUNNING THERE", NOT "WE DID NOT LOOK".**
   * It is computed from the same census and the same pass as `foreignPanes` on
   * this response, so the two cannot disagree about the same directory. A
   * non-null value means the classification is still correct — no agent OF OURS
   * is running — and the words *"their work has stopped"* are NOT: something is
   * running there, it is somebody else's, and activating this agent will be
   * refused until it is gone.
   *
   * Read it before you act on this row. The remedy this category invites is
   * re-activation, which RESUMES a conversation; offering that for a directory
   * whose agent never stopped is a false red whose remedy is the damage.
   */
  occupiedBy: MissingAgentOccupant | null;
  reason: string;
}

/**
 * One agent's herdr status as of a particular census, for the sweep that
 * publishes `agent.status_changed`.
 */
export interface FleetStatusReading {
  path: string;
  paneName: string;
  /** Observed, never durable: herdr renumbers panes whenever any pane closes. */
  paneId: string | null;
  herdrStatus: HerdrAgentStatus;
}

/** One sweep's worth of observation. See {@link MessageRouter.observeFleet}. */
export interface FleetObservation {
  /** Whether herdr answered at all. False means every field below is silence. */
  reachable: boolean;
  missing: MissingAgent[];
  statuses: FleetStatusReading[];
}

/**
 * A status change this daemon actually watched happen, for the sweep to
 * announce as `agent.status_changed`.
 *
 * `from` is never optional here, and that is the type carrying a rule rather
 * than describing one: a FIRST SIGHTING IS NOT A TRANSITION, so an agent with
 * no previous observation produces no entry at all rather than one with an
 * invented `from`. See {@link MessageRouter.recordSweepObservation}.
 */
export interface StatusTransition {
  path: string;
  paneName: string;
  paneId: string | null;
  from: HerdrAgentStatus;
  to: HerdrAgentStatus;
}

/**
 * What this daemon last saw one agent doing, and when it first saw that.
 *
 * `since` is nullable for the same reason `from` above is required: the only
 * moment this daemon can honestly stamp is one it watched. A first sighting
 * seeds `status` with `since: null` — the daemon knows WHAT the agent is doing
 * and has no idea since when, and saying so is the whole point.
 */
interface StatusObservation {
  status: HerdrAgentStatus;
  since: string | null;
}

/**
 * WHAT THIS DAEMON HAS WATCHED ITS FLEET DOING — one per PROCESS, and the
 * "per process" is the whole reason this is a class rather than a field.
 *
 * THE DEFECT IT EXISTS TO PREVENT, because it was written the other way first
 * and the proof caught it. This daemon builds ONE MessageRouter PER CONNECTION
 * (daemon.ts: responses go back to the requesting client, and PTY listeners
 * die with the socket), plus one more for the sweep. A memory held as a field
 * on the router is therefore private to a connection: the sweep records into
 * the daemon's router, `list_agents` is answered by a different one that has
 * watched nothing, and `statusSince` comes back null on every row for ever.
 * The field would be PRESENT, CORRECTLY TYPED and ALWAYS NULL — which is
 * exactly the shape KAN-145 (in the extraction source) shipped to production
 * behind two green proofs, because every assertion anybody thinks to write
 * about such a field still passes.
 *
 * So the observation is a dependency, injected like the bridge and the
 * registry, and the daemon hands the same instance to every router it makes.
 *
 * A router constructed WITHOUT one gets its own, which is right for a caller
 * that is the only router in its process (the verify scripts) and would be
 * wrong for a daemon. `scripts/verify-status-since.mjs` §2 is what holds the
 * daemon to sharing it: it changes an agent's status under a REAL daemon and
 * requires the timestamp to appear on a row read back over the socket, which
 * is the one assertion a private memory cannot satisfy.
 *
 * IN MEMORY, AND THAT IS SETTLED. See {@link MessageRouter.recordSweepObservation}
 * for the durability decision and for KAN-189, which made it.
 */
export class FleetStatusMemory {
  private readonly observations = new Map<string, StatusObservation>();

  /** See {@link MessageRouter.recordSweepObservation}, which is this method's contract. */
  record(observation: FleetObservation): StatusTransition[] {
    if (!observation.reachable) return [];

    const at = new Date().toISOString();
    const transitions: StatusTransition[] = [];
    const seen = new Set<string>();

    for (const reading of observation.statuses) {
      seen.add(reading.path);
      const previous = this.observations.get(reading.path);
      if (previous && previous.status === reading.herdrStatus) continue;
      this.observations.set(reading.path, {
        status: reading.herdrStatus,
        // The one moment this daemon may stamp: it has just watched this
        // agent's status become something other than what it last held. A
        // first sighting (`previous === undefined`) has no such moment.
        since: previous ? at : null
      });
      if (!previous) continue;
      transitions.push({
        path: reading.path,
        paneName: reading.paneName,
        paneId: reading.paneId,
        from: previous.status,
        to: reading.herdrStatus
      });
    }

    // An agent that is no longer live forgets both halves, so that coming back
    // is a first sighting rather than a transition from whatever it was doing
    // when it disappeared.
    for (const path of this.observations.keys()) {
      if (!seen.has(path)) this.observations.delete(path);
    }

    return transitions;
  }

  /**
   * When this daemon first saw `path` in `status`, or null.
   *
   * ASKED WITH THE STATUS, NOT JUST THE PATH, so the answer's sentence is true
   * rather than nearly true. `statusSince` means "observed in THIS status since
   * T". The status a row reports came from the census that answered THAT call;
   * this memory came from the last sweep, up to one sweep interval earlier.
   * When they disagree — the agent changed in the window between — the
   * remembered moment belongs to the status the agent has just LEFT, and
   * returning it would date the wrong one. Null is the honest answer there, and
   * it is the value that already means "this daemon has not observed a change
   * into what you are looking at".
   */
  since(path: string, status: HerdrAgentStatus): string | null {
    const observation = this.observations.get(path);
    return observation?.status === status ? observation.since : null;
  }
}

/**
 * An agent somebody deliberately switched off, that could be switched back on.
 *
 * A fleet client lists what is running, and a stopped agent is by definition
 * not in that list — so the *on* half of a fleet switch needs its candidates
 * from somewhere else. The answer is the registry, and this is the third of
 * the three ways it can answer "not running":
 *
 *   - {@link MissingAgent}    — recorded active, absent anyway. A loss.
 *   - preempted (see below)   — stood down so something else could run. A debt.
 *   - StandbyAgent            — stood down, and it HAS run.
 *   - {@link UnstartedAgent}  — configured, and it has never run.
 *
 * The four are disjoint on purpose, so no agent grows two switches.
 *
 * Only agents whose directory still exists are offered: a directory the caller
 * has since deleted is the evidence that "turn this back on" is not what
 * anyone means by it.
 *
 * THE MEMBERSHIP TEST IS NOT "last event is `deactivated`", and the difference
 * is what keeps this list's own promise true. Reconfiguring a stopped agent
 * writes a `configured` row, so an agent that ran, was switched off and was
 * then reconfigured has `configured` as its last event while its conversation
 * is still on disk. Testing the event alone would drop it out of every category
 * — a silent hole — or, if `unstartedAgents` claimed it on the event, would put
 * it in the list that promises a FRESH start. So membership is: not running,
 * not preempted, directory present, and {@link AgentIntent.everActivated}.
 */
interface StandbyAgent extends ConfigEcho {
  path: string;
  paneName: string;
  label: string | null;
  /** Which launcher it last ran, so it comes back as what it was. */
  launcher: string;
  /** When the registry recorded the stand-down. */
  since: string;
  /**
   * Present when this row is an ex-preempted agent whose annotation compaction
   * dropped: its work was taken, not switched off. Absent means somebody chose
   * to stop it. A client rendering an On button treats both the same; a human
   * reading why it is off does not.
   */
  wasPreempted?: boolean;
  reason: string;
}

/**
 * An agent that exists and has never run: `configure` accepted, `activate`
 * never called.
 *
 * WHY THIS IS ITS OWN CATEGORY AND NOT PART OF STANDBY, which is the whole of
 * the question this shape answers. The distinction is BEHAVIOURAL rather than
 * taxonomic: switching a standby agent back on **resumes the conversation it
 * was stopped in**, and every standby row says so in as many words. An agent
 * that has never run has no conversation, so activating it starts a fresh one —
 * `claude --continue` finds nothing and falls through to the cold command.
 * Folding the two together does not merely blur a label; it makes the standby
 * list's own promise false for half its members.
 *
 * Before this category existed those rows belonged to NO list. `standbyAgents`
 * filtered on a `deactivated` event, so a `configured`-last row fell through
 * every category — configured, real, activatable, and invisible to any client
 * building its controls from this response.
 *
 * THE NAME. The design left the distinction settled and the word open. This is
 * `unstartedAgents` because `unstarted` is already the word this daemon uses
 * for the state — `deactivate` on a never-run agent has answered
 * `state: 'unstarted'` since the verb existed, and `agent_status` reports the
 * same string. A second word for a state the API already names would mean two
 * vocabularies for one fact, and the one already on the wire wins.
 */
interface UnstartedAgent extends ConfigEcho {
  path: string;
  paneName: string;
  label: string | null;
  /** Which launcher it will run when it is first activated. */
  launcher: string;
  /** When it was configured. This category has no later event to report. */
  since: string;
  reason: string;
}

/**
 * A preempted agent as `list_agents` reports it. Named rather than inferred so
 * it can be a member of {@link FleetCategories} — the totality claim below has
 * to be able to say its name.
 */
interface PreemptedAgentDto extends ConfigEcho {
  path: string;
  paneName: string;
  label: string | null;
  at: string;
  priority: number;
  /**
   * `string`, not {@link HerdrAgentStatus}, and that is the record's own type
   * rather than a widening: a preemption annotation stores whatever herdr said
   * at the moment the slot was taken (`PreemptionRecord.herdrStatus`), and a
   * status this daemon's union does not know about is still what happened.
   */
  herdrStatusWhenPreempted: string;
  by: { path: string; paneName: string; priority: number };
  reason: string;
  derivation: string;
}

/**
 * Every row-carrying category of `list_agents_response`, in one place, so the
 * claim "each of them echoes the durable record" can be CHECKED rather than
 * asserted.
 *
 * WHY THIS EXISTS, WHICH IS A CORRECTION. The comment on {@link ConfigEcho}
 * used to say that a category "cannot" silently omit the echo, "including
 * categories nobody has written yet". That was FALSE, and it was demonstrated
 * false rather than argued: a new row interface that simply does not extend
 * `ConfigEcho`, published under a new key in the response, compiles clean.
 * Every category extending `ConfigEcho` was a convention its authors had each
 * kept, not a rule the compiler held — which is the difference between a
 * mechanism and a habit, and the sentence claimed the first while the code did
 * the second.
 *
 * WHAT IS ENFORCED HERE. {@link FleetCategoriesCarryTheEcho} makes every member
 * of this interface `ConfigEcho[]` at compile time, and `handleListAgents`
 * builds a value of this type and spreads it. So a member whose row type stops
 * extending `ConfigEcho` fails the BUILD, exactly the way adding a knob to
 * `AgentConfig` fails T4's `RECONFIGURATION_COST`.
 *
 * WHAT IS STILL NOT ENFORCED, said here rather than left to be found again:
 * TypeScript has no exact-object type for the response, so a future category
 * added straight into the `respond({…})` call — bypassing this interface — is
 * not a build error. That residue is covered by a PROOF instead:
 * `verify-activated-by.mjs` §3 sweeps every array of objects in a real
 * `list_agents_response` and fails on any row that carries a `config` echo
 * without an `activatedBy`. Between the two, a new category is caught by the
 * compiler if it opts in and by the proof if it does not — and neither claims
 * to be the other.
 */
interface FleetCategories {
  agents: ListedAgent[];
  unbackedPanes: UnbackedPane[];
  missingAgents: MissingAgent[];
  preemptedAgents: PreemptedAgentDto[];
  standbyAgents: StandbyAgent[];
  unstartedAgents: UnstartedAgent[];
}

/**
 * The totality claim itself: every member of {@link FleetCategories} is an
 * array of rows carrying the durable echo.
 *
 * A type alias rather than a runtime check, and its only job is to fail the
 * build. `FleetCategories` is constrained here rather than at each interface,
 * so the requirement lives in ONE place a reader can find instead of six an
 * author has to remember.
 */
type CarriesEcho<T extends Record<keyof T, ConfigEcho[]>> = T;
type FleetCategoriesCarryTheEcho = CarriesEcho<FleetCategories>;

/**
 * How many unreadable registry rows `list_agents` and `daemon_status` carry
 * before they stop listing and let `unreadableRecordsTotal` speak (KAN-302).
 *
 * A BOUND RATHER THAN A PAGE, and the difference is the point. The five paged
 * categories are inventories that grow with the fleet, so a consumer has to be
 * able to walk them to the end — KAN-163 is what happens when it cannot. This
 * list is a FAULT REPORT: it is bounded by how badly one file has been
 * hand-edited, every entry carries the row's own bytes, and a registry with
 * three hundred unreadable rows does not need three hundred delivered on every
 * poll to be understood. The count is never clipped, so a consumer always knows
 * the true size, and `daemon.log` carries the full detail for the operator
 * repairing them.
 *
 * If a real deployment ever exceeds this, the answer is a paged category rather
 * than a bigger number — but that is a change worth making on evidence, and
 * there is none yet.
 */
const UNREADABLE_DISCLOSURE_LIMIT = 25;

/**
 * How many rows a paged `list_agents` category carries when the caller does
 * not ask for a size. The default is what a fleet UI polling continuously
 * gets, and it stays cheap on purpose.
 *
 * WHAT THIS NUMBER USED TO BE, AND WHY IT MOVED (KAN-163). It was a hard clip
 * with no way past it, and the sentence beside it said the cap "is about
 * clients that poll continuously, not about the log". That was true and it was
 * false in composition with `docs/event-contract.md` §2, which makes an
 * authoritative `list` poll a CORRECTNESS requirement for every consumer of
 * our events. A reconciler is a client that polls continuously AND needs
 * completeness — the old comment named the exact case it got wrong.
 *
 * The consequence was not latency. Rows are ordered newest-first, so the row
 * that fell off had been waiting longest: an agent switched off long enough
 * became permanently invisible to the thing responsible for restoring it,
 * while every poll looked healthy. Butchr measured it on their real fleet —
 * 89 standby agents, 25 returned, 72% invisible, and no way to ask for the
 * rest.
 *
 * So the number is now a PAGE SIZE rather than a ceiling: see
 * {@link pageFleetCategory}, and §2 of the event contract, which states this
 * limit and the remedy in the same section as the obligation it qualifies.
 */
const FLEET_CATEGORY_LIMIT = 25;

/**
 * The largest page a caller may ask for.
 *
 * A ceiling on the PAGE is not a ceiling on the ENUMERATION, which is the
 * whole difference between this and what it replaced: a caller who wants
 * everything follows `nextCursor` until it is null, and no page size makes any
 * row unreachable. Raising this number would only save round trips — it is
 * deliberately not the mechanism completeness rests on, because "raise the
 * limit" moves a cliff rather than removing one.
 */
const FLEET_CATEGORY_MAX_LIMIT = 200;

/**
 * The `list_agents` categories that are paged, by their name on the wire.
 *
 * `agents` and `unbackedPanes` are NOT here and are never clipped: both are
 * built from the herdr census, which is bounded by what is actually running on
 * the machine. They are complete in every response.
 */
const PAGED_FLEET_CATEGORIES = [
  'missingAgents',
  'preemptedAgents',
  'standbyAgents',
  'unstartedAgents',
  'foreignPanes'
] as const;

type PagedFleetCategory = (typeof PAGED_FLEET_CATEGORIES)[number];

/** What a caller asks for, per category, on a `list_agents` request. */
interface FleetPageRequest {
  /** An opaque `nextCursor` from a previous response, or null/absent for the first page. */
  after?: string | null;
  /** Rows to carry, 1..{@link FLEET_CATEGORY_MAX_LIMIT}. Defaults to {@link FLEET_CATEGORY_LIMIT}. */
  limit?: number;
}

/** What a caller is told about one paged category, on the response. */
interface FleetPageDto {
  /** Rows in THIS page. */
  returned: number;
  /** Rows in the whole category, cursor or no cursor. */
  total: number;
  /** The page size this response used, whether asked for or defaulted. */
  limit: number;
  /** Rows after this page. Zero exactly when {@link nextCursor} is null. */
  remaining: number;
  /**
   * Pass as `after` to get the next page, or null when this page is the last.
   *
   * NULL IS THE ONLY "you have everything" SIGNAL, and it is deliberately not
   * inferable from arithmetic: comparing `returned` against `total` is wrong
   * the moment the fleet changes between pages, and a consumer that stops on
   * `returned < limit` stops early on a page that happened to land short.
   */
  nextCursor: string | null;
}

/**
 * The position of one row in a category's total order, encoded for the wire.
 *
 * Opaque to the consumer BY CONTRACT — it is a position, not a row id, and its
 * encoding may change. It carries the sort key rather than an index so that a
 * row disappearing between pages (an agent switched back on, say) shifts
 * nothing: the next page resumes from the KEY, which still orders correctly
 * whether or not the row it names is still there.
 */
interface FleetCursor {
  /** The row's `when` value — its timestamp. */
  w: string;
  /** The row's tiebreaker — its unique key within the category. */
  k: string;
}

function encodeFleetCursor(cursor: FleetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeFleetCursor(raw: string): FleetCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.w !== 'string' || typeof parsed.k !== 'string') return null;
    return { w: parsed.w, k: parsed.k };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE READ-PATH CONTRACT, BOUND TO THE SHAPES IT DESCRIBES (KAN-277)
//
// `docs/read-path-contract.md` publishes `list_agents` and `agent_status` field
// by field, and `src/read-contract.ts` is its executable half. These assertions
// are the half that fires at BUILD time: a row interface above that grows a
// field without a line in `ROW_SHAPES` does not compile, and neither does a
// contract entry naming a field the interface no longer has. Both directions,
// which is what `Exact` is for.
//
// THEY LIVE HERE RATHER THAN IN `read-contract.ts` for the reason
// `CAPACITY_FIELDS`'s binding already lives here: that file must not import the
// router — the router imports it — and a check reads best beside the thing that
// would drift.
//
// WHAT THIS DOES NOT REACH, stated so the coverage is not read wider than it
// is. The RESPONSE OBJECTS are assembled inline in `handleListAgents` and
// `handleAgentStatus` and spread into `respond({…})`, and TypeScript has no
// exact type for an object literal, so no assertion here can hold the top-level
// field sets, the four `agent_status` branches, the `herdrHealth` block or the
// `priorities` rows. Those are held by `scripts/verify-read-contract.mjs`,
// against the keys of a REAL response off a real daemon — which is the stronger
// evidence of the two and the only one available for them. `FleetCategories`
// says the same thing about a category added straight into `respond`; this is
// that residue, one surface wider.
// ---------------------------------------------------------------------------

const _listedAgentMatchesTheContract: Exact<
  keyof ListedAgent,
  keyof typeof ROW_SHAPES.ListedAgent
> = true;
const _unbackedPaneMatchesTheContract: Exact<
  keyof UnbackedPane,
  keyof typeof ROW_SHAPES.UnbackedPane
> = true;
const _missingAgentMatchesTheContract: Exact<
  keyof MissingAgent,
  keyof typeof ROW_SHAPES.MissingAgent
> = true;
const _preemptedAgentMatchesTheContract: Exact<
  keyof PreemptedAgentDto,
  keyof typeof ROW_SHAPES.PreemptedAgent
> = true;
const _standbyAgentMatchesTheContract: Exact<
  keyof StandbyAgent,
  keyof typeof ROW_SHAPES.StandbyAgent
> = true;
const _unstartedAgentMatchesTheContract: Exact<
  keyof UnstartedAgent,
  keyof typeof ROW_SHAPES.UnstartedAgent
> = true;
const _foreignPaneMatchesTheContract: Exact<
  keyof ForeignPane,
  keyof typeof ROW_SHAPES.ForeignPane
> = true;
// KAN-302. The row shape whose interface lives in `agent-registry.ts` rather
// than in this file — it is a fact about the durable log, and the registry is
// what produces it — but bound here with the rest, because this is where the
// binding belongs and a shape held somewhere else is a shape nobody re-checks.
const _unreadableRecordMatchesTheContract: Exact<
  keyof UnreadableRecord,
  keyof typeof ROW_SHAPES.UnreadableRecord
> = true;

const _configEchoMatchesTheContract: Exact<
  keyof ConfigEcho,
  keyof typeof BLOCK_SHAPES.ConfigEcho
> = true;
const _fleetPageMatchesTheContract: Exact<
  keyof FleetPageDto,
  keyof typeof BLOCK_SHAPES.FleetPage
> = true;
const _configEchoContractMatchesTheContract: Exact<
  keyof ConfigEchoContract,
  keyof typeof BLOCK_SHAPES.ConfigEchoContract
> = true;
const _ownerFilterMatchesTheContract: Exact<
  keyof OwnerFilterDto,
  keyof typeof BLOCK_SHAPES.OwnerFilter
> = true;
const _provenanceMatchesTheContract: Exact<
  keyof ReturnType<typeof stateReadProvenance>,
  keyof typeof BLOCK_SHAPES.Provenance
> = true;
const _preemptedByMatchesTheContract: Exact<
  keyof PreemptedAgentDto['by'],
  keyof typeof BLOCK_SHAPES.PreemptedBy
> = true;
const _occupiedAgentMatchesTheContract: Exact<
  keyof NonNullable<ForeignPane['occupiedAgent']>,
  keyof typeof BLOCK_SHAPES.OccupiedAgent
> = true;
// KAN-572. The pane occupying a MISSING agent's directory — the other half of
// the block above, and bound for the same reason: it is a nested object on a
// row, so the row's own key binding cannot see inside it.
const _missingAgentOccupantMatchesTheContract: Exact<
  keyof MissingAgentOccupant,
  keyof typeof BLOCK_SHAPES.MissingAgentOccupant
> = true;

// KAN-287. `activate_response`'s composites. The response's OWN top-level field
// set has no type — it is an object literal spread into `respond({…})`, exactly
// as both read responses are, and §10 of the document says so — but every named
// shape it carries can be bound, and is. These five are the difference between
// "the proof would notice" and "it does not compile".
const _paneOccupantMatchesTheContract: Exact<
  keyof PaneOccupant,
  keyof typeof ROW_SHAPES.PaneOccupant
> = true;
const _provisionedArtifactMatchesTheContract: Exact<
  keyof ArtifactDisclosure,
  keyof typeof ROW_SHAPES.ProvisionedArtifact
> = true;
const _preemptionOfferMatchesTheContract: Exact<
  keyof PreemptionOfferDto,
  keyof typeof BLOCK_SHAPES.PreemptionOffer
> = true;
const _preemptedMatchesTheContract: Exact<
  keyof NonNullable<CapacityGateResult['preempted']>,
  keyof typeof BLOCK_SHAPES.Preempted
> = true;
// `capacityOverride` is the one composite assembled at the RESPONSE rather than
// returned whole by the gate — `{ ...gate.overrode, capacity: capacityDto(…) }`
// — so the binding names that spread rather than a single interface. Written
// this way it still fails to compile if `overrode` grows a field.
const _capacityOverrideMatchesTheContract: Exact<
  keyof NonNullable<CapacityGateResult['overrode']> | 'capacity',
  keyof typeof BLOCK_SHAPES.CapacityOverride
> = true;

// The two vocabularies this ticket turned from literals into unions, bound here
// beside them for the reason the block below states: this file must not be
// imported by `read-contract.ts`, so a union declared here is bound here.
const _activateRefusedValuesMatchTheContract: Exact<
  ActivateRefusalKind,
  (typeof VALUE_SETS.activateRefused)[number]
> = true;
const _activateRefusedByValuesMatchTheContract: Exact<
  ActivateRefusedBy,
  (typeof VALUE_SETS.activateRefusedBy)[number]
> = true;

// The two closed vocabularies whose unions are declared in this file and in
// `herdr.ts`. The other six are bound in `read-contract.ts`, beside the list.
const _stateValuesMatchTheContract: Exact<AgentState, (typeof VALUE_SETS.state)[number]> = true;
const _sessionStatusValuesMatchTheContract: Exact<
  NonNullable<HerdrSession['status']>,
  (typeof VALUE_SETS.sessionStatus)[number]
> = true;

void _listedAgentMatchesTheContract;
void _unbackedPaneMatchesTheContract;
void _missingAgentMatchesTheContract;
void _preemptedAgentMatchesTheContract;
void _standbyAgentMatchesTheContract;
void _unstartedAgentMatchesTheContract;
void _foreignPaneMatchesTheContract;
void _configEchoMatchesTheContract;
void _fleetPageMatchesTheContract;
void _configEchoContractMatchesTheContract;
void _provenanceMatchesTheContract;
void _preemptedByMatchesTheContract;
void _occupiedAgentMatchesTheContract;
void _missingAgentOccupantMatchesTheContract;
void _paneOccupantMatchesTheContract;
void _provisionedArtifactMatchesTheContract;
void _preemptionOfferMatchesTheContract;
void _preemptedMatchesTheContract;
void _capacityOverrideMatchesTheContract;
void _activateRefusedValuesMatchTheContract;
void _activateRefusedByValuesMatchTheContract;
void _stateValuesMatchTheContract;
void _sessionStatusValuesMatchTheContract;

/**
 * Newest first, then the row's key, so the order is TOTAL rather than merely
 * sorted.
 *
 * The tiebreaker is not decoration. Forty agents stood down in one loop share
 * a millisecond, and a paged read over an order with ties can hand a caller
 * the same row twice and never hand them another one at all — which is the
 * defect this whole mechanism exists to remove, reintroduced one level down.
 */
function compareFleetRows(a: FleetCursor, b: FleetCursor): number {
  const byTime = b.w.localeCompare(a.w);
  return byTime !== 0 ? byTime : a.k.localeCompare(b.k);
}

/**
 * One page of a fleet category, plus the handle for the next one.
 *
 * REPLACES A SILENT CLIP (KAN-163). What was `sorted.slice(0, 25)` with a
 * count alongside is now a cursor walk: the default response is the same 25
 * rows it always was, and a consumer that needs the category — a
 * level-triggered reconciler, which §2 of the event contract REQUIRES to poll
 * — follows `nextCursor` to the end and can reach every row, including the
 * oldest, which is precisely the one the old clip dropped.
 *
 * `total` made the truncation honest and not usable: it says how many rows are
 * missing, never which.
 */
function pageFleetCategory<T>(
  rows: T[],
  when: (row: T) => string,
  key: (row: T) => string,
  request: FleetPageRequest | undefined,
  category: string
): { rows: T[]; page: FleetPageDto } | { error: string } {
  const limit = request?.limit ?? FLEET_CATEGORY_LIMIT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > FLEET_CATEGORY_MAX_LIMIT
  ) {
    return {
      error:
        `Invalid pages.${category}.limit: expected an integer between 1 and ` +
        `${FLEET_CATEGORY_MAX_LIMIT}, got ${JSON.stringify(request?.limit)}. A larger page is ` +
        `not how you get the whole category — follow \`pages.${category}.nextCursor\` until it ` +
        `is null.`
    };
  }

  const after = request?.after;
  let from: FleetCursor | null = null;
  if (after !== undefined && after !== null) {
    if (typeof after !== 'string' || (from = decodeFleetCursor(after)) === null) {
      return {
        error:
          `Invalid pages.${category}.after: ${JSON.stringify(after)} is not a cursor this daemon ` +
          `issued. Pass a \`nextCursor\` from a previous list_agents response, or omit it for the ` +
          `first page. This is refused rather than answered from the beginning, because a cursor ` +
          `that silently resets turns an enumeration into a loop over its first page.`
      };
    }
  }

  const ordered = [...rows]
    .map((row) => ({ row, at: { w: when(row), k: key(row) } }))
    .sort((a, b) => compareFleetRows(a.at, b.at));

  const start = from === null ? 0 : ordered.findIndex((r) => compareFleetRows(r.at, from!) > 0);
  // No row sorts after the cursor: the caller has already seen everything.
  const page = start < 0 ? [] : ordered.slice(start, start + limit);
  const consumed = (start < 0 ? ordered.length : start) + page.length;
  const remaining = ordered.length - consumed;

  return {
    rows: page.map((r) => r.row),
    page: {
      returned: page.length,
      total: ordered.length,
      limit,
      remaining,
      nextCursor: remaining > 0 && page.length > 0 ? encodeFleetCursor(page[page.length - 1].at) : null
    }
  };
}

/**
 * The `pages` block of a request, validated, or the refusal naming what is
 * wrong with it.
 *
 * A misspelled category is REFUSED rather than ignored. Ignoring it answers a
 * caller's enumeration request with the default page and no indication that
 * their paging did nothing — the same shape of silence this ticket is about.
 */
function readFleetPageRequests(
  raw: unknown
): { pages: Partial<Record<PagedFleetCategory, FleetPageRequest>> } | { error: string } {
  if (raw === undefined || raw === null) return { pages: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Invalid pages: expected an object keyed by category name' };
  }
  const known = new Set<string>(PAGED_FLEET_CATEGORIES);
  const pages: Partial<Record<PagedFleetCategory, FleetPageRequest>> = {};
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(category)) {
      return {
        error:
          `Invalid pages.${category}: not a paged category. The paged categories are ` +
          `${PAGED_FLEET_CATEGORIES.join(', ')}. \`agents\` and \`unbackedPanes\` are never ` +
          `clipped and take no page.`
      };
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { error: `Invalid pages.${category}: expected an object with \`after\` and/or \`limit\`` };
    }
    pages[category as PagedFleetCategory] = value as FleetPageRequest;
  }
  return { pages };
}

// ------------------------------------------------------- the owner filter

/**
 * The row-carrying categories an owner filter applies to: every category whose
 * rows are AGENTS OF OURS and therefore have an owner to be asked about.
 *
 * DERIVED FROM NOTHING AND WRITTEN DOWN, because the alternative is worse than
 * the repetition. `FleetCategories` has six members and two of them are not
 * agents: `unbackedPanes` are our panes with nothing behind them and
 * `foreignPanes` are somebody else's panes entirely. Neither has a record, so
 * neither has an owner, and filtering them would mean this daemon deciding that
 * an unowned thing belongs to the owner who asked — which is the wildcard
 * reading of absence that {@link AgentConfig.owner} exists to refuse.
 *
 * So they are left COMPLETE, and the response says so rather than leaving a
 * reader to notice: see {@link OwnerFilterDto.unfiltered}. *"Find all of X's
 * agents"* that silently dropped X's MISSING ones would be worse than no
 * filter, because it reads as a complete answer — and a filtered response that
 * silently carried rows belonging to nobody would be the same defect pointing
 * the other way.
 */
const OWNER_FILTERED_CATEGORIES = [
  'agents',
  'missingAgents',
  'preemptedAgents',
  'standbyAgents',
  'unstartedAgents'
] as const;

/** Row-carrying categories an owner filter deliberately leaves whole. */
const OWNER_UNFILTERED_CATEGORIES = ['unbackedPanes', 'foreignPanes'] as const;

/**
 * Every row-carrying category is either filtered or deliberately not, and the
 * compiler holds that rather than a reader checking it.
 *
 * `foreignPanes` is a paged category that is not a member of
 * {@link FleetCategories} — it is spread into the response separately — so the
 * union is taken over both, and a SIXTH category added to `FleetCategories`
 * without a decision about owner filtering is a build error here.
 */
type OwnerFilterableCategory = keyof FleetCategories | 'foreignPanes';
type _EveryCategoryHasAnOwnerFilterDecision = Exact<
  OwnerFilterableCategory,
  (typeof OWNER_FILTERED_CATEGORIES)[number] | (typeof OWNER_UNFILTERED_CATEGORIES)[number]
>;
const _everyCategoryHasAnOwnerFilterDecision: _EveryCategoryHasAnOwnerFilterDecision = true;

/**
 * Every row-carrying array on a `list_agents` response that a filter leaves
 * COMPLETE — the two categories above, and two more that are not categories at
 * all and would otherwise go unmentioned.
 *
 * `priorities` is here because decision 6 of KAN-193 puts it here: owner must
 * not touch capacity, priority or preemption. That list answers *"what would a
 * would-be activation have to outrank"*, which is a question about the MACHINE.
 * Narrowing it to one owner would produce a number that is wrong rather than
 * partial — an activation is outranked by whatever is running, not by whatever
 * is running and shares your name — so it is left whole and said so.
 *
 * `unreadableRecords` is here because it CANNOT be filtered and that fact is
 * worth more than the row. A registry row this daemon could not parse may be
 * the asking caller's own agent; there is no `config` to read an owner from, so
 * any filtering of it would be a guess. Dropping those rows under a filter
 * would hide precisely the agents a caller most needs to hear about — absent
 * from every category, and now absent from the fault report too.
 */
const OWNER_UNFILTERED_ROWS = [
  ...OWNER_UNFILTERED_CATEGORIES,
  'priorities',
  'unreadableRecords'
] as const;

/**
 * What a caller is told about the filter it asked for. Present on a filtered
 * response and ABSENT on an ordinary one, so "no filter was applied" is read
 * from the shape rather than from a sentinel value nobody agreed on.
 */
interface OwnerFilterDto {
  /** The owner asked for, echoed exactly as sent. Never normalised. */
  owner: string;
  /** Categories this filter applied to. Their `*Total`s count the FILTERED set. */
  filtered: string[];
  /**
   * Row-carrying arrays the filter did NOT apply to, which are therefore
   * complete and may carry rows belonging to nobody or to somebody else. Each
   * is here for a stated reason: see {@link OWNER_UNFILTERED_ROWS}.
   */
  unfiltered: string[];
  /**
   * The one sentence somebody who reads a field called `owner` as access
   * control most needs, on the wire rather than only in the docs.
   */
  note: string;
}

/**
 * THE NON-BOUNDARY STATEMENT, in the place a consumer actually stands.
 *
 * Decision 5 of KAN-193 names two homes for it — `AgentConfig.owner` in
 * `src/types.ts`, for whoever reads the type, and the MCP tool descriptions,
 * for whoever reads the tool. This is a third, and it is the cheapest of the
 * three to meet: it arrives attached to the answer the mistaken reading would
 * be drawn from.
 */
const OWNER_FILTER_NOTE =
  'An owner filter is a narrower QUESTION, not a smaller ANSWER. It is not a permission ' +
  'boundary and hides nothing: any caller that can reach this socket can list every agent ' +
  'on this machine by omitting the filter, deliberately and by design. The only auth ' +
  'boundary is the socket\'s own file permission (0600 in a 0700 directory). Agents with no ' +
  'owner are matched by NO filter and are reachable only by an unfiltered read.';

/**
 * The `owner` field of a request, validated, or the refusal naming what is
 * wrong with it. `null` for the ordinary unfiltered read.
 *
 * BOTH REFUSALS BELOW EXIST BECAUSE ABSENCE IS A REAL STATE, and they are the
 * same defect approached from two sides.
 *
 * `owner: null` is REFUSED rather than read as "no filter". A caller that meant
 * to filter and whose own owner variable was unset sends exactly that, and
 * answering it with the whole fleet hands a reconciler every agent on the
 * machine as though they were candidates — whereupon its last step, *"anything
 * running that is not in my desired list → off"*, stands down other people's
 * work. A false NON-match omits a row from a listing; this is the direction
 * that stops agents, so the ambiguity is refused rather than resolved. Omitting
 * the field entirely is how you ask for everything, and it cannot be produced
 * by an unset variable serialising itself.
 *
 * The empty string is refused for the same reason `configure` refuses to store
 * one: no agent can ever carry it, so a filter for it can only ever mean a
 * caller's mistake.
 */
function readOwnerFilter(raw: unknown): { owner: string | null } | { error: string } {
  if (raw === undefined) return { owner: null };
  if (raw === null) {
    return {
      error:
        'Invalid owner: null. Omit `owner` entirely to read the whole fleet — an explicit null ' +
        'is what an unset variable serialises to, and reading it as "no filter" would answer a ' +
        'caller that meant to filter with every agent on this machine. A reconciler acting on ' +
        'that answer stands down work that was never its own, which is why this is refused ' +
        'rather than resolved.'
    };
  }
  if (typeof raw !== 'string') {
    return {
      error:
        `Invalid owner: expected a string, got ${JSON.stringify(raw)}. It is matched EXACTLY ` +
        `against the opaque name frozen onto each agent's record — no prefix, no glob, no ` +
        `hierarchy and no case-folding — so there is no structure here for a non-string to carry.`
    };
  }
  if (!raw.trim()) {
    return {
      error:
        `Invalid owner: ${JSON.stringify(raw)} is empty. \`configure\` refuses to store an empty ` +
        `owner, so no agent can carry one and this filter could only ever return nothing. Agents ` +
        `with NO owner are not matched by this or any other filter — read them with no \`owner\` ` +
        `at all.`
    };
  }
  return { owner: raw };
}

/**
 * Whether one row belongs to the owner asked for.
 *
 * WRITTEN AS TWO EXPLICIT BRANCHES OVER A TRUTHY TEST, and that is the whole
 * substance of this function rather than its style. `rows.filter((r) =>
 * r.config?.owner === wanted)` is correct today and says nothing about WHY; the
 * failure this is shaped against is a later author who reaches for
 * `r.config?.owner ?? wanted` or `!r.config?.owner || …` to "handle the
 * unconfigured row", and either one silently makes absence a wildcard. Both
 * would read as tidying. So the unowned case is a branch a reader meets, with
 * the reason on it, and `verify-owner-filter.mjs` mutates exactly here.
 *
 * A row with `config: null` — no record backs it at all — is unowned by the
 * same rule and for a stronger reason: there is nothing to be owned.
 */
function ownedBy(row: ConfigEcho, wanted: string): boolean {
  const owner = row.config?.owner;
  // ABSENCE IS NOT A WILDCARD. An agent configured before `owner` existed, and
  // one configured since without it, are UNOWNED — which is a real state and
  // not a match for anybody. Returning true here would hand every legacy agent
  // on the machine to the first caller that asked for its own.
  if (owner === undefined) return false;
  return owner === wanted;
}

/**
 * What the caller is told about the agent it could stand down, when it is at
 * capacity and outranks something.
 *
 * Sent on the *refusal*, not after the fact. Preemption is opt-in per
 * activation for the same reason capacity refusals are visible: someone
 * switching an agent on must not silently destroy another agent's uncommitted
 * work. This is the sentence a client turns into a named button, and its
 * presence in the payload is what the consent criterion is satisfied by.
 */
interface PreemptionOfferDto {
  path: string;
  paneName: string;
  priority: number;
  herdrStatus: HerdrAgentStatus;
  /** The priority of the activation being refused, for the comparison. */
  incomingPriority: number;
  /** One sentence naming what would be stood down and what authorises it. */
  offer: string;
}

/** What {@link MessageRouter.capacityGate} decided, and why. */
interface CapacityGateResult {
  capacity: Capacity;
  /** The refusal to send back, or null when the activation may proceed. */
  refusal: string | null;
  /** Set when it may proceed only because the caller deliberately said so. */
  overrode: { at: string; derivation: string } | null;
  /**
   * Set on a refusal that preemption could lift. Null both when there is
   * nothing to preempt and when preemption already happened.
   */
  preemptable: PreemptionOfferDto | null;
  /** Set when an agent was actually stood down to make this room. */
  preempted: { at: string; victim: PreemptionOfferDto; derivation: string } | null;
}

/** Everything the capacity gate needs to know about the activation it is judging. */
interface GateRequest {
  path: string;
  paneName: string;
  /** What this activation outranks. See priority.ts. */
  priority: number;
  /** Whether the gate is permitted to refuse this activation at all. */
  refusable: boolean;
  /**
   * The extra command-line arguments this activation would have spawned with,
   * so a refusal can say what did not start. Empty for an agent configured
   * without any.
   *
   * ON THE REFUSAL DELIBERATELY, and it is the disclosure surface that is easy
   * to leave out — `list` and `status` both describe agents that EXIST, and an
   * activation the gate refused never becomes one. So without this, the one
   * configuration a caller most wants to check is the only one no read can show
   * them: they were denied capacity, and cannot see what they were denied.
   */
  args: readonly string[];
  /**
   * Start it past the cap without freeing anything. Booleans only — the
   * handler validates before it gets here (see invalidFlag), so the gate is
   * reading a decision rather than guessing at one.
   */
  override?: boolean;
  /** Free a slot by standing down something this activation outranks. */
  preempt?: boolean;
}

export interface RouterDeps {
  config: CrabcastConfig;
  herdrBridge: HerdrBridge;
  daemonStartedAt: Date;
  /**
   * The durable record of which agents exist and which should be running — the
   * one piece of state that outlives the daemon, herdr, and the machine.
   *
   * It is now the ONLY place an agent's priority, launcher, prompt and gate
   * flags exist: with workspace types deleted there is nothing left to look
   * them up in. That is what makes `configure` mandatory.
   */
  agentRegistry: AgentRegistry;
  /**
   * What this process was loaded from, frozen when it booted (KAN-122).
   *
   * Handed in rather than read here, and that is the whole design: taken at
   * boot it is a fact about the RUNNING PROCESS, and re-reading it on request
   * would silently answer a different question — what is on disk now — which
   * is the question the filesystem already answers and the one that goes on
   * looking healthy while a daemon serves a build that has been replaced.
   */
  bootBuild: BuildSnapshot;
  /**
   * What this daemon has watched its fleet doing, for `statusSince` (KAN-200).
   *
   * SHARED, AND THE DAEMON MUST SHARE IT. This process builds one router per
   * connection; the sweep records into one of them and `list_agents` is
   * answered by another, so a memory that is not handed in here is a memory the
   * list can never read — and `statusSince` is then present, correctly typed
   * and null for ever. See {@link FleetStatusMemory}, which carries the whole
   * of that argument, and `scripts/verify-status-since.mjs` §2, which is what
   * fails when it stops being true.
   *
   * Optional because a caller that is the only router in its process is
   * correctly served by one of its own.
   */
  statusMemory?: FleetStatusMemory;
  /** Replies to the requesting client. */
  send: (msg: DaemonResponse) => void;
  /** Events for every connected client (activations, teardowns, PTY deaths). */
  broadcast: (msg: EventFrame) => void;
}

/**
 * The longest bootstrap prompt `configure` accepts.
 *
 * A prompt is finished text now, so it travels INLINE over the socket, and
 * that puts it under the framing bound: `onJsonLines` gives up on a line past
 * {@link MAX_LINE_CHARS} and DESTROYS the connection (ipc.ts). That is the
 * right behaviour for its own job — at that point there is no message to
 * answer, only a peer streaming bytes at a daemon whose memory is the thing
 * being defended — but it is the wrong thing for a caller to meet, because it
 * names the framing bound rather than the prompt and hangs up either way.
 *
 * So `configure` refuses first, on a bound strictly below the framing one, and
 * answers with the limit and the actual size on a connection that survives.
 *
 * THE NUMBER IS DERIVED, not chosen. JSON escaping can expand a string by a
 * factor of six in the worst case — a control byte becomes `\u00XX` — so a
 * prompt this daemon accepts must satisfy `6 × MAX_PROMPT_CHARS` plus the rest
 * of the request comfortably under `MAX_LINE_CHARS`. At 128 KiB that is
 * 786,432 characters of escaped prompt against a 1,048,576 bound, leaving room
 * for the path, the flags and the id several times over. The consequence is
 * the property worth having: **every prompt `configure` accepts is guaranteed
 * to fit on the wire.** There is no size that passes validation here and then
 * dies in the framing, which would be the same silent-truncation failure this
 * bound exists to prevent, one layer down.
 */
export const MAX_PROMPT_CHARS = 128 * 1024;

/** A parsed `configure` payload, or the complaint that stopped it. */
type ConfigParse =
  | { ok: true; config: AgentConfig }
  | { ok: false; error: string; missing: string[] };

/**
 * `configure`'s argument list, validated.
 *
 * REFUSES RATHER THAN DEFAULTS, on exactly the fields the deleted config
 * loader refused on. A silently-defaulted `priority` sits at the floor, is
 * preemptable by everything, and nobody finds out until the work is destroyed
 * — that was true when priority came from a workspace type and it is true now
 * that it comes from here. `launcher` is required for the reason KAN-53 (in
 * the extraction source) records: an omitted launcher used to fall back to
 * `shell`, which staffed work with a bare bash prompt that answered `success:
 * true` and executed messages as shell commands.
 *
 * The three gate flags DEFAULT to `true` rather than being required, and that
 * asymmetry is deliberate: `true` is the safe reading of each (refusable
 * means the cap applies to you, chargeable means you cost a slot, preemptable
 * means you can be asked to give it up), so a caller who says nothing gets an
 * agent that is fully subject to the machine's limits. Only the exemptions
 * have to be asked for.
 */
function parseAgentConfig(data: any): ConfigParse {
  const missing: string[] = [];
  const refuse = (error: string): ConfigParse => ({ ok: false, error, missing });

  if (!('priority' in data) || data.priority === undefined) missing.push('priority');
  if (!('launcher' in data) || data.launcher === undefined) missing.push('launcher');
  if (missing.length) {
    return refuse(
      `configure needs ${missing.join(' and ')}. There is no workspace type to inherit ` +
        `from — an agent is a directory plus the knobs you freeze onto it, so every ` +
        `required knob arrives here or nowhere. ` +
        `priority: what this agent outranks when the machine is full (a defaulted one ` +
        `would sit at the floor and be preemptable by everything). ` +
        `launcher: one of ${knownLaunchers().join(', ')}.`
    );
  }

  const priority = data.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    return refuse(`Invalid priority: expected a finite number, got ${JSON.stringify(priority)}`);
  }

  const launcher = data.launcher;
  if (typeof launcher !== 'string' || !launcher.trim()) {
    return refuse(`Invalid launcher: expected a non-empty string, got ${JSON.stringify(launcher)}`);
  }
  try {
    resolveLauncher(launcher.trim());
  } catch (e: any) {
    return refuse(e?.message ?? String(e));
  }

  // `gateExempt: true` is accepted as shorthand for all three flags false —
  // it is what the old per-type flag meant, and callers carrying it forward
  // should not have to translate. Supplying BOTH the shorthand and an explicit
  // flag is refused rather than resolved: whichever won would be a silent
  // choice about whether an agent can be refused, charged or preempted.
  const explicit = (['refusable', 'chargeable', 'preemptable'] as const).filter(
    (name) => data[name] !== undefined
  );
  let defaults = true;
  if (data.gateExempt !== undefined) {
    if (typeof data.gateExempt !== 'boolean') {
      return refuse(
        `Invalid gateExempt: expected true or false, got ${JSON.stringify(data.gateExempt)}`
      );
    }
    if (explicit.length) {
      return refuse(
        `gateExempt is shorthand for refusable/chargeable/preemptable all false, and you ` +
          `also passed ${explicit.join(', ')}. Which wins would be a silent decision about ` +
          `whether this agent can be refused, charged or stood down — pass the three flags ` +
          `you mean, or the shorthand, not both.`
      );
    }
    defaults = !data.gateExempt;
  }

  const flags: Record<string, boolean> = {};
  for (const name of ['refusable', 'chargeable', 'preemptable'] as const) {
    const value = data[name];
    if (value === undefined) {
      flags[name] = defaults;
      continue;
    }
    if (typeof value !== 'boolean') {
      return refuse(`Invalid ${name}: expected true or false, got ${JSON.stringify(value)}`);
    }
    flags[name] = value;
  }

  // The cross-field rule, and it gets a better addressee than it used to.
  // Standing down an uncharged agent frees no charged slot, so a preempt would
  // admit a newcomer over the cap on a false premise. As workspace-type config
  // this failed a daemon BOOT, where the person who wrote the mistake was long
  // gone; as a `configure` parameter it is refused synchronously, to the caller
  // who made it.
  if (!flags.chargeable && flags.preemptable) {
    return refuse(
      `chargeable: false with preemptable: true is incoherent. An uncharged agent does not ` +
        `occupy a slot, so standing it down frees nothing — the preempt path would admit a ` +
        `newcomer over the cap on the false premise that room had been made. Either charge ` +
        `it (chargeable: true) or take it out of preemption too (preemptable: false).`
    );
  }

  // EXTRA ARGV FOR THE LAUNCHER, and the refusal below is the substance of it.
  //
  // Validated AFTER `launcher`, deliberately: the capability question is asked
  // of a launcher that resolves, so a misspelled launcher is answered by
  // `resolveLauncher`'s message above rather than by a complaint about `args`.
  //
  // ⚠ WHAT IS DELIBERATELY NOT VALIDATED HERE, because its absence reads as an
  // oversight (KAN-514): the SHAPE of an element carrying a value. Write
  // `["--flag","value"]` for a VARIADIC consumer flag and the flag keeps
  // reading past its own value and takes the prompt — which is the final
  // argument and a bare operand — so every spawn for that agent wedges, and the
  // runtime's complaint is about the prompt's content rather than about the
  // argument order. `["--flag=value"]` binds the value and makes it
  // unwritable, which is why every example on this path now uses that form.
  // CrabCast does not REFUSE the two-element shape: whether a flag is variadic
  // is a fact about the consumer's program, this field is generic argv
  // precisely so no table of anyone's flags lives here, and the only detector
  // available without arity — a `--`-looking element followed by a plain one —
  // is a false positive on every fixed-arity flag anybody writes. See
  // docs/launcher-args.md, which is where that decision is argued rather than
  // asserted.
  let args: string[] | undefined;
  if (data.args !== undefined) {
    if (!Array.isArray(data.args)) {
      return refuse(
        `Invalid args: expected an array of strings — one element per command-line argument, ` +
          `e.g. ["--flag=value"]. Got ${JSON.stringify(data.args)}. IT IS AN ARRAY RATHER ` +
          `THAN A STRING because a string would have to be split by something, and whatever did ` +
          `the splitting would be a quoting rule CrabCast invented and you had to guess at. Each ` +
          `element is shell-quoted and arrives as exactly one argument, whatever it contains.`
      );
    }
    const badIndex = data.args.findIndex((a: unknown) => typeof a !== 'string');
    if (badIndex !== -1) {
      return refuse(
        `Invalid args[${badIndex}]: expected a string, got ` +
          `${JSON.stringify(data.args[badIndex])}. Every element becomes one command-line ` +
          `argument verbatim, and there is no rendering step here that could turn a number, an ` +
          `object or a null into the text you meant — send the text.`
      );
    }
    // THE REFUSAL, AND IT IS A REFUSAL RATHER THAN A NO-OP ON PURPOSE.
    //
    // A launcher that cannot put these on a command line has exactly one other
    // option, which is to drop them — and a caller whose arguments never arrive
    // and are never mentioned is left with an agent that looks configured and
    // is not. That is the same shape as the `mcpServers` chain KAN-121 closed
    // (names dropped silently, agent up with no tools, `success: true`) and as
    // the agy config write that landed in a file nothing read: every step
    // defensible, the composition a guard that reads as a check and is not one.
    //
    // ASKED OF THE LAUNCHER'S OWN DECLARATION, never of its name. See
    // `AgentLauncher.acceptsArgs`.
    //
    // An EMPTY array is not refused: it asks for nothing, so there is nothing
    // that could fail to arrive, and refusing it would break a reconciler that
    // sends `args: []` uniformly for agents whose launcher happens to be
    // `shell`. Absent and empty mean the same thing here and at `knobValue`.
    if (data.args.length && !launcherAcceptsArgs(launcher.trim())) {
      return refuse(
        `Launcher '${launcher.trim()}' does not take command-line arguments, and ` +
          `${data.args.length === 1 ? 'the one you sent' : `the ${data.args.length} you sent`} ` +
          `would have gone nowhere. ` +
          `${launchersAcceptingArgs().length
            ? `Launchers that do: ${launchersAcceptingArgs().join(', ')}.`
            : `No launcher currently does.`} ` +
          `NOTHING WAS CONFIGURED. This is refused rather than ignored because the alternative ` +
          `is an agent that starts, reports success, and is missing what you asked for — you ` +
          `would find out from the work it silently could not do. Configure it without \`args\`, ` +
          `or with a launcher that carries them.`
      );
    }
    args = data.args as string[];
  }

  let prompt: string | undefined;
  if (data.prompt !== undefined) {
    // Text, and NOT trimmed, NOT parsed, NOT resolved as a path. These are the
    // bytes the agent will read; the only thing done to them is a length
    // check. A prompt that happens to contain doubled-brace placeholder syntax,
    // or to look like a filename, reaches the sidecar exactly as written.
    if (typeof data.prompt !== 'string' || !data.prompt.length) {
      return refuse(
        `Invalid prompt: expected the agent's bootstrap text as a non-empty string, got ` +
          `${JSON.stringify(data.prompt)}. It is finished text rather than a path or a ` +
          `template — CrabCast writes it verbatim and never inspects it, so render it before ` +
          `you send it.`
      );
    }
    if (data.prompt.length > MAX_PROMPT_CHARS) {
      return refuse(
        `Prompt is too large: ${data.prompt.length} characters, and the limit is ` +
          `${MAX_PROMPT_CHARS}. The prompt travels inline over the socket, whose framing ` +
          `gives up on a line past ${MAX_LINE_CHARS} characters and closes the connection — ` +
          `this limit sits below that with room for JSON escaping, so every prompt accepted ` +
          `here is one that arrives. NOTHING WAS TRUNCATED and nothing was configured: an ` +
          `agent silently given half its instructions is worse than one that was refused.`
      );
    }
    prompt = data.prompt;
  }

  // MCP SERVERS: DEFINITIONS, NOT NAMES — and validated to the point where a
  // server the caller asked for cannot silently fail to arrive.
  //
  // The chain this replaces answered `success: true` for an agent with no
  // tools: `mcpServers` was validated as "an array of strings" and nothing
  // more, exactly one name resolved and the rest were dropped without a word,
  // and the write early-returned on the resulting empty map so no file appeared
  // at all. Every step was individually defensible and the composition was a
  // guard that read as a check and was not one.
  //
  // So each name is now accounted for individually, here, before anything is
  // recorded — and a name this daemon cannot supply is refused by name.
  let mcpServers: Record<string, McpServerSpec> | undefined;
  if (data.mcpServers !== undefined) {
    if (
      typeof data.mcpServers !== 'object' ||
      data.mcpServers === null ||
      Array.isArray(data.mcpServers)
    ) {
      return refuse(
        `Invalid mcpServers: expected an object keyed by server name, e.g. ` +
          `{"atlassian": {"command": "npx", "args": ["-y", "mcp-remote", "…"]}, "crabcast": "builtin"}. ` +
          `Got ${Array.isArray(data.mcpServers) ? 'an array' : JSON.stringify(data.mcpServers)}. ` +
          `IT IS DEFINITIONS RATHER THAN NAMES: the command, args and env that spawn each server, ` +
          `written into .mcp.json verbatim. CrabCast holds no table of server names — which servers ` +
          `you want depends on which of your integrations hold a live credential, and that never ` +
          `crosses this boundary.`
      );
    }

    // `Object.create(null)`, NOT `{}`, AND THIS IS LOAD-BEARING.
    //
    // A server named `__proto__` assigned into an ordinary object literal hits
    // Object.prototype's setter instead of creating an own property. The
    // assignment succeeds, throws nothing, and the key is simply NOT THERE
    // afterwards. Reproduced end to end: `configure` answered `success: true`
    // with `willWrite: []`, the record stored `mcpServers: {}`, `activate`
    // answered `success: true`, no `.mcp.json` was written, and `agent start`
    // WAS issued — a caller supplied a definition, the agent came up with no
    // tools, and nothing anywhere said why.
    //
    // That is precisely the defect this slice exists to close, living inside
    // the slice that closes it. And the count guard downstream (herdr.ts)
    // cannot catch it: the key is lost HERE, one frame upstream, so by the time
    // the bridge compares counts the record honestly reads "nothing was asked
    // for". The guard is not wrong; it is being lied to. Which is the argument
    // for fixing it at every point the map is built rather than adding a
    // special case for one name.
    //
    // `constructor`, `toString` and `hasOwnProperty` all round-trip through a
    // plain literal correctly — only `__proto__` has the setter — so this is
    // not a class of key that a reader would spot by trying the obvious ones.
    const specs: Record<string, McpServerSpec> = Object.create(null);
    const unknownBuiltins: string[] = [];
    for (const [name, spec] of Object.entries(data.mcpServers as Record<string, unknown>)) {
      if (!name.trim()) {
        return refuse(
          `Invalid mcpServers: a server name is empty. Each key is the name the agent's runtime ` +
            `will see the server under.`
        );
      }
      if (spec === 'builtin') {
        // The one class of name CrabCast still resolves, so it is the one class
        // that can fail to resolve — and it fails LOUDLY, naming what it knows.
        if (builtinMcpServer(name) === null) {
          unknownBuiltins.push(name);
        } else {
          specs[name] = 'builtin';
        }
        continue;
      }
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        return refuse(
          `Invalid mcpServers['${name}']: expected either a definition object — the command, args ` +
            `and env that spawn the server — or the string "builtin" for one CrabCast constructs ` +
            `itself (${BUILTIN_MCP_SERVERS.join(', ')}). Got ` +
            `${Array.isArray(spec) ? 'an array' : JSON.stringify(spec)}. The definition is written ` +
            `into .mcp.json verbatim: CrabCast does not inspect its interior, so what you send is ` +
            `what the agent's runtime reads.`
        );
      }
      specs[name] = spec as Record<string, unknown>;
    }

    if (unknownBuiltins.length) {
      return refuse(
        `mcpServers asks CrabCast to supply ${unknownBuiltins.map((n) => `'${n}'`).join(', ')} ` +
          `itself ("builtin"), and it has no such server. CrabCast builds exactly ` +
          `${BUILTIN_MCP_SERVERS.length === 1 ? 'one' : String(BUILTIN_MCP_SERVERS.length)}: ` +
          `${BUILTIN_MCP_SERVERS.join(', ')} — the only definition that depends on facts about this ` +
          `daemon rather than about your integrations. For anything else, send the definition: ` +
          `{"${unknownBuiltins[0]}": {"command": "…", "args": [], "env": {}}}. NOTHING WAS ` +
          `CONFIGURED — an agent started with fewer servers than you asked for is the failure this ` +
          `refusal exists to prevent.`
      );
    }
    mcpServers = specs;
  }

  // THERE IS NO SEPARATE PROVISIONING CONSENT FLAG, and its absence is a
  // decision rather than an omission.
  //
  // An earlier revision of the design required `provision: { mcpConfig: true }`
  // beside `mcpServers`, because asking for a CAPABILITY ("the atlassian
  // server") is a different act from agreeing to a FILE appearing in your
  // repository. That was right about names. Definitions dissolve it: a caller
  // supplying definitions is handing over the literal bytes of the `mcpServers`
  // block, and there is no gap left between "here are the exact contents" and
  // "please write them". A flag beside them would not be a second decision,
  // only a second chance to forget one.
  //
  // And forgetting it would not have been loud where it mattered. A consumer
  // cutting a whole fleet over at once, whose agents reach their issue tracker
  // THROUGH MCP, would have needed the flag on every activation to get any
  // tools at all — and would have discovered it agent by agent. One field
  // cannot be half-supplied, so that failure has no path here.
  //
  // What the flag was buying — a caller LEARNING that CrabCast writes into
  // their directory — is bought better below: `configure`'s response names the
  // file and the keys it will write, before anything is written. Being told the
  // consequence beats being asked to assert it.

  let label: string | undefined;
  if (data.label !== undefined) {
    if (typeof data.label !== 'string') {
      return refuse(`Invalid label: expected a string, got ${JSON.stringify(data.label)}`);
    }
    label = data.label;
  }

  // WHOSE AGENT THIS IS. Frozen onto the record verbatim and never examined
  // again beyond an equality test — see `AgentConfig.owner` in `src/types.ts`
  // for why that limit is the whole of what makes this field safe to have.
  //
  // THE EMPTY STRING IS REFUSED RATHER THAN STORED, and the reason is the same
  // one that makes absence a real state. `owner: ''` is what a caller sends
  // when their own owner variable was never set, and it is indistinguishable
  // on the wire from a deliberate choice to be owned by the empty name. Stored,
  // it would produce an agent that no filter for a real owner matches and that
  // a filter for `''` does — a third category nobody designed, reachable only
  // by accident. Refused, the caller learns at `configure` time rather than
  // discovering it at the first reconcile.
  //
  // Whitespace is trimmed for the emptiness TEST and not for the VALUE: an
  // owner of `' '` is refused, and an owner of `' butchr '` is stored exactly
  // as sent, because trimming it would be this daemon deriving a value from
  // the caller's bytes rather than matching them.
  let owner: string | undefined;
  if (data.owner !== undefined) {
    if (typeof data.owner !== 'string') {
      return refuse(
        `Invalid owner: expected a string, got ${JSON.stringify(data.owner)}. It is an OPAQUE ` +
          `name for whoever runs this agent — CrabCast matches it exactly and never parses it — ` +
          `so it has no structure for a non-string to carry.`
      );
    }
    if (!data.owner.trim()) {
      return refuse(
        `Invalid owner: ${JSON.stringify(data.owner)} is empty. An owner nobody can name is ` +
          `what an unset variable looks like on the wire, and storing it would make an agent ` +
          `that no filter for a real owner finds. Omit \`owner\` to leave this agent UNOWNED — ` +
          `which is a real state, reachable by an unfiltered read and matched by no filter — ` +
          `or send the name you will filter by.`
      );
    }
    owner = data.owner;
  }

  return {
    ok: true,
    config: {
      priority,
      refusable: flags.refusable,
      chargeable: flags.chargeable,
      preemptable: flags.preemptable,
      launcher: launcher.trim(),
      ...(args ? { args } : {}),
      ...(prompt ? { prompt } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(owner !== undefined ? { owner } : {})
    }
  };
}

// -------------------------------------------- per-attribute reconfiguration

/**
 * What changing ONE knob costs on a RUNNING agent.
 *
 *  - `in-place` — the daemon reads it at decision time, out of the record, on
 *    every call that needs it. Changing it changes the next decision. Nothing
 *    inside the pane has a copy.
 *  - `restart-required` — it was consumed at spawn. The pane is already running
 *    the process it named, or the agent has already read the file it produced.
 *    Rewriting the record now would change the configuration without changing
 *    the agent, and the only thing that could close that gap is a respawn.
 */
export type ReconfigurationCost = 'in-place' | 'restart-required';

/**
 * EVERY knob, classified. This table is the specification for customer
 * requirement 2, and it is a TOTAL MAP OVER {@link AgentConfig} on purpose.
 *
 * `keyof Required<AgentConfig>` means a field added to the configuration
 * without a line here does not compile. That matters more than it looks: the
 * failure this task exists to prevent is a knob whose reconfiguration
 * behaviour nobody decided, and the shape of that failure is silence — a new
 * spawn-time attribute would fall through to whatever the default branch did,
 * and the default branch is the one that quietly writes it under a live agent.
 * A missing line is a red typecheck instead.
 */
export const RECONFIGURATION_COST: { [K in keyof Required<AgentConfig>]: ReconfigurationCost } = {
  // Read out of the record when the capacity gate runs (see capacityGate and
  // preemptionCandidates), never handed to the pane.
  priority: 'in-place',
  refusable: 'in-place',
  chargeable: 'in-place',
  preemptable: 'in-place',
  // Nothing parses it; it is display text on a row.
  label: 'in-place',
  // Metadata about WHOSE agent this is, read out of the record when a
  // `list_agents` filter matches it and handed to the pane never. Nothing
  // inside the pane has a copy, so changing it changes the next answer.
  //
  // AND THE CONSEQUENCE IS ON THE WIRE RATHER THAN ONLY HERE: because this is
  // in-place, a filtered list is a SNAPSHOT — an agent can move between owners
  // between two polls, so a consumer that diffs two filtered reads is looking
  // at a set whose membership it does not control.
  owner: 'in-place',
  // IT IS THE COMMAND THE PANE RUNS, resolved once when the agent was spawned.
  launcher: 'restart-required',
  // Written into the agent's sidecar and passed at spawn. The agent running
  // there has already read it.
  prompt: 'restart-required',
  // Written into `.mcp.json`, which the runtime reads once, at boot.
  mcpServers: 'restart-required',
  // ARGV IS FIXED AT PROCESS START. This is the one entry in the table whose
  // classification is a fact about operating systems rather than a decision
  // about this daemon: the process in the pane was executed with an argument
  // vector, and nothing can hand it another one. Accepting a change here would
  // not be a policy choice with a trade-off — it would be a record that says
  // something untrue about a running process.
  args: 'restart-required'
};

/** Every knob's name, in a stable order, derived from the table above. */
const CONFIG_ATTRIBUTES = Object.keys(RECONFIGURATION_COST) as (keyof AgentConfig)[];

/**
 * Why one restart-required knob is one, in the caller's own words.
 *
 * The refusal has to NAME THE ATTRIBUTE AND THE REASON — a bare "cannot change
 * that" leaves the caller to guess whether they hit a policy, a bug, or a
 * transient. These sentences are what makes the refusal actionable, and they
 * are per attribute because the three are restart-required for three different
 * mechanical reasons.
 */
const RESTART_REASON: Record<string, string> = {
  launcher:
    'the launcher IS the process running in the pane, resolved once when the agent was ' +
    'spawned. Changing it means a different program, which is a different agent',
  prompt:
    "the prompt is written into the agent's sidecar and handed to it at spawn. The agent " +
    'running there has already read it, so rewriting it now would change the record ' +
    'without changing the agent',
  mcpServers:
    'the servers are written into .mcp.json, which the runtime reads once when it boots. ' +
    'Rewriting it under a live agent changes a file it will not read again',
  args:
    'they are the command line the process in the pane was EXECUTED with. An argument vector ' +
    'is fixed at process start — there is no mechanism, here or in the operating system, that ' +
    'hands a running process a different one — so accepting this would record arguments that ' +
    'process was never given'
};

/**
 * One knob's value, canonicalized for comparison.
 *
 * SORTED KEYS, ORDERED ARRAYS. An `args` array's order is the command line and
 * absolutely matters; a JSON object's key order is not observable to anything
 * that reads it back, so treating a reordered `mcpServers` map as a change
 * would refuse a call that asks for nothing — and a spurious refusal is a false
 * claim about the world in the same way a spurious success is.
 */
function canonicalKnob(value: unknown): string {
  if (value === undefined) return '\u0000absent';
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as object).sort()) {
        out[key] = walk((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value)) ?? '\u0000absent';
}

/**
 * One knob's value as the diff should see it.
 *
 * ABSENT AND EMPTY `mcpServers` ARE THE SAME THING, and normalizing them here
 * is what keeps a reconciler from deadlocking. Neither writes anything into the
 * caller's directory, so there is no change for a respawn to make take effect —
 * but a reconciler that always sends `mcpServers: {}` against a record written
 * without the field would otherwise be told "restart required" forever, on a
 * difference with no consequence, and no number of deactivate/activate cycles
 * would clear it.
 *
 * `args` IS THE SAME CASE AND IS NORMALIZED FOR THE SAME REASON. An empty array
 * puts nothing on the command line — `quotedArgs` returns the empty string, so
 * the spawn is byte-for-byte the one an agent with no `args` at all gets — and
 * the deadlock is worse here than at `mcpServers`, because this knob is
 * restart-required: a reconciler sending `args: []` uniformly would be told to
 * respawn a live agent, forever, to apply a difference that changes nothing.
 * That is a rule offering to spend an agent's conversation on nothing.
 */
function knobValue(config: AgentConfig, name: keyof AgentConfig): unknown {
  const value = config[name];
  if (name === 'mcpServers' && value && Object.keys(value as object).length === 0) {
    return undefined;
  }
  if (name === 'args' && Array.isArray(value) && value.length === 0) {
    return undefined;
  }
  return value;
}

/** Which knobs the incoming document asks to move. */
function changedAttributes(before: AgentConfig, after: AgentConfig): (keyof AgentConfig)[] {
  return CONFIG_ATTRIBUTES.filter(
    (name) => canonicalKnob(knobValue(before, name)) !== canonicalKnob(knobValue(after, name))
  );
}

/**
 * What happened to one knob. Reported for every knob on every reconfiguration
 * of an existing record, because the epic's first invariant is that `success`
 * is a claim about the world and a bare one cannot carry this.
 */
export type AttributeOutcome =
  /** The value sent is the value already on the record. Nothing to do. */
  | 'unchanged'
  /** Changed, and the running agent's next decision reads the new value. */
  | 'applied-in-place'
  /** Changed on a stopped agent, and takes effect at the next `activate`. */
  | 'applied'
  /** Changed, needs a respawn, and was NOT applied. This is the refusal. */
  | 'refused-restart-required'
  /**
   * Changed, could have applied in place, and was NOT applied — because
   * something else in the same call was refused and `configure` is atomic.
   * The distinct name is the point: a caller must be able to tell a knob that
   * landed from one that would have.
   */
  | 'withheld';

/**
 * Which agent made this request, when an agent made it at all.
 *
 * THE CHANNEL IS THE ONE ARTIFACT THIS DAEMON OWNS. An agent reaches CrabCast
 * through the `crabcast` MCP server, whose definition is the single entry a
 * caller may NOT write for themselves (see `builtinMcpServer`): it is built
 * per-agent, at activation, by the daemon, and written into that agent's own
 * `.mcp.json`. So the daemon bakes the agent's canonical path into that
 * definition's environment, the server it spawns puts it on every request, and
 * an agent's identity is therefore something this daemon ISSUED rather than
 * something a caller asserted. Nothing has to be trusted that was not already
 * trusted — the same file already decides which daemon that agent can talk to.
 *
 * THE FAILURE THIS IS SHAPED AROUND IS THE CUSTOMER'S OWN, and it is worth
 * naming because it is invisible: they shipped this field correctly typed,
 * correctly stored, correctly reported — and the caller's identity never
 * reached the daemon, so every agent came back with `activatedBy: null`. A
 * present, well-typed, always-empty field, which took a follow-up release to
 * make real. That is why the seam is only half the work and why the proof for
 * this slice starts from a real multi-level chain rather than from the empty
 * case: an implementation that records a parent for NOBODY passes every
 * negative assertion in this file.
 *
 * `null` for anything that is not a resolvable absolute directory, including
 * the ordinary case of a human at a shell. {@link canonicalizeOrNull} is the
 * same canonicalization every address goes through, so a supervisor identified
 * through a symlink is the same agent as one identified through its target.
 */
function callerIdentity(data: any): string | null {
  return canonicalizeOrNull(data?.agentPath);
}

/**
 * The parent to write onto a record, from two sources IN A STATED ORDER.
 *
 * The two are not interchangeable and collapsing them into one expression is
 * how this field starts inventing things:
 *
 *  1. **Derivation** — an identified caller. The ONLY source that may produce a
 *     parent that was not there before, and it may do so only from an identity
 *     this daemon issued (see {@link callerIdentity}). A caller with no
 *     identity derives NOTHING; it does not derive a plausible default, and it
 *     does not derive "the last one we saw".
 *
 *     **AND ONLY TWO CALLS EVER PASS A CALLER AT ALL**, which is the rule that
 *     makes this field mean what its name says. `activatedBy` is *who stood
 *     this agent up* — so a caller is offered only by the `configure` that
 *     brings the agent into existence and by the `activate` that actually
 *     STARTS it. Every other path passes `null` and lands on carry-forward: a
 *     converging `activate` on an already-running agent, a reconfigure of a
 *     live one, a stand-down, a boot-time restoration.
 *
 *     That distinction is not a refinement, it is the defect Butchr filed
 *     against their own version (KAN-145): identity taken from whoever is
 *     converging or attaching answers "who is looking at this agent", which
 *     coincides with "who started it" exactly often enough to pass a casual
 *     test and diverges the moment anyone touches a pane they did not create.
 *     A reconciler that polls `activate` to hold desired state would otherwise
 *     become the supervisor of record for the entire fleet.
 *  2. **Carry-forward** — what the record already says. Every verb after
 *     `configure` re-records the whole agent, so without this a stand-down, a
 *     converging `activate` or a reconfigure by a human would write a fresh row
 *     with no parent on it and silently orphan a live agent. That is the same
 *     trap re-recording sprang on an earlier slice of this story, one field
 *     over.
 *
 * It is deliberately NOT `caller ?? current` written inline, because the
 * self-parentage rule sits between the two and the two branches have to be
 * separable to be read.
 *
 * SELF-PARENTAGE IS REFUSED. An agent that activates itself is nobody's child:
 * recording it would have a supervisor sending itself bulletins about itself,
 * and any consumer walking the chain to find a root would walk in a circle.
 * Refusing it falls through to carry-forward rather than to `null`, which is
 * the difference between "that claim is not one I will record" and "you are now
 * an orphan" — a converging `activate` that an agent issues against ITSELF is
 * an ordinary reconciling call, and it must not cost the agent its parent.
 *
 * WHAT THERE IS NO SOURCE FOR, on purpose: the wire. No caller may pass an
 * `activatedBy` of its own choosing on `configure` or `activate`. Parentage is
 * observed by this daemon or it is absent, so there is no path by which a
 * supervisor can be named for an agent that nothing actually activated.
 */
function parentFor(options: {
  /** The agent being recorded. */
  target: string;
  /** Who is asking, if this daemon issued them an identity. */
  caller: string | null;
  /** What the record already says, if there is a record. */
  current: string | null | undefined;
}): string | null {
  const { target, caller, current } = options;
  if (caller !== null && caller !== target) return caller;
  if (caller !== null && caller === target) {
    console.error(
      `[MessageRouter] Ignoring a self-parentage claim from ${caller}: an agent that ` +
        `activates itself is nobody's child, so its supervisor of record is left as it was ` +
        `(${current ?? 'none'}) rather than becoming itself.`
    );
  }
  return current ?? null;
}

/**
 * The durable half of a state read, from the intent that holds it.
 *
 * ONE FUNCTION, EVERY CATEGORY. The failure this task exists to prevent is a
 * category that silently omits the attributes, and the structural defence
 * against it is that no category builds this block itself — a new list gets the
 * echo by calling this, and a list that forgot to call it has a `config` field
 * missing rather than a plausible-looking row.
 *
 * `undefined` in, "there is no record" out, as explicit nulls: see
 * {@link ConfigEcho.config}.
 */
/**
 * Whether this response carries the prompt TEXT or only its size.
 *
 * A REQUIRED PARAMETER OF {@link configEcho} AND DELIBERATELY NOT A DEFAULT
 * (KAN-528). Either default is a trap in one direction: defaulting to `'whole'`
 * puts the fleet read back over the framing bound the moment somebody adds a
 * category and forgets, and defaulting to `'summarised'` silently takes the
 * prompt off the single read that is the only place left to read it. With no
 * default, a new echo site does not COMPILE until its author has answered the
 * question — which is the whole of what this type is for.
 */
type PromptEchoPolicy =
  /** The prompt travels as text. For a read of ONE agent, asked for by path. */
  | 'whole'
  /** The prompt travels as a character count. For any read of MANY agents. */
  | 'summarised';

/**
 * The prompt on a record, measured. `null` for a record carrying none.
 *
 * A FUNCTION RATHER THAN AN INLINE `?.length ?? null` AT EACH SITE, because the
 * distinction it draws is the one this ticket turns on: `''` is a prompt of
 * length 0 that somebody froze, and no prompt at all is `null`. `||` collapses
 * those two and `?.length ?? null` does not; putting the correct spelling in
 * one named place is what stops the wrong one being re-derived at the next site.
 */
function promptSize(config: AgentConfig): number | null {
  return typeof config.prompt === 'string' ? config.prompt.length : null;
}

/**
 * {@link AgentConfig} with the prompt taken off, for a fleet row.
 *
 * DESTRUCTURED RATHER THAN DELETED FROM A COPY, so the omission is one
 * expression a reader can check at a glance, and the compiler — not a comment —
 * is what guarantees the result has no `prompt` on it.
 */
function summariseConfig(config: AgentConfig): SummarisedAgentConfig {
  // `prompt` is bound only to be excluded from `rest`; the count it is replaced
  // by lives on the row (see ConfigEcho.promptChars), not in here.
  const { prompt: _prompt, ...rest } = config;
  return rest;
}

function configEcho(intent: AgentIntent | undefined, promptPolicy: PromptEchoPolicy): ConfigEcho {
  // EVERY FIELD HERE COMES FROM THE RECORD AND NOTHING ELSE. That is what the
  // provenance legend promises about this block, and it has to be true field by
  // field rather than mostly.
  //
  // THIS USED TO BE `Boolean(intent?.everActivated) || live`, and that was a
  // real defect rather than a shortcut. The argument for it was that a row
  // reading `state: 'running'` beside `everActivated: false` looks
  // contradictory — but the two are answers to different questions, and mixing
  // them broke the one this block exists to keep clean. A `configured`-last
  // record over a live pane (reachable: a durable write that failed after an
  // activation leaves exactly that, and this daemon says so at
  // `handleDeactivateAgent`) then read back `everActivated: true` from a record
  // that says otherwise — a field the legend calls DURABLE, changing with
  // liveness, and reverting the moment the pane went away. A supervisor would
  // see the agent move into `unstartedAgents`, whose CLI line says it has never
  // run, while it holds a conversation.
  //
  // The honest reading is the record's: `everActivated` means CRABCAST'S OWN
  // LOG SHOWS AN ACTIVATION AT THIS PATH. `false` beside `state: 'running'` is
  // not a contradiction, it is the record being behind — which is a real state
  // with a real name (`recordReconciled`, T5) and a real repair, and hiding it
  // behind an `||` removed the only signal that it had happened.
  //
  // The case the `||` was reaching for is answered properly instead: the
  // activate paths build this block AFTER the record is written, so what they
  // echo is a record that genuinely carries the activation. See handleActivate.
  if (!intent) {
    // `activatedBy: null` here says "no record, so no parent" — the same
    // sentence `config: null` says about the configuration. It is NOT an
    // assertion that some agent out there has no supervisor; a row with no
    // record is not an agent at all.
    return {
      config: null, configVersion: null, configuredAt: null, everActivated: false,
      activatedBy: null,
      // No record, so no prompt to measure — the same sentence `config: null`
      // says, and NOT the "this agent has no prompt" that the same null means
      // beside a config that is present. See ConfigEcho.promptChars.
      promptChars: null
    };
  }
  return {
    // The frozen object itself where the policy is `whole`, not a rebuild of
    // it. A field-by-field copy here would be a second place that has to learn
    // about every attribute `configure` grows, and the day it did not is the
    // day the echo starts lying by omission. `summariseConfig` keeps that
    // property under the summary: it SPREADS the frozen object and removes one
    // named key, so an attribute added to `configure` tomorrow travels on both
    // paths without this function being touched.
    config: promptPolicy === 'whole'
      ? intent.record.config
      : summariseConfig(intent.record.config),
    // Measured off the record on BOTH paths, from the same expression, so the
    // count beside a whole prompt and the count standing in for a summarised
    // one cannot disagree about the same agent.
    promptChars: promptSize(intent.record.config),
    configVersion: intent.configVersion,
    configuredAt: intent.configuredAt,
    everActivated: intent.everActivated,
    // Straight off the record, with no `??` behind it. The registry normalizes
    // both edges of the log (see `toActivatedBy`), so this is already `string |
    // null` — and a defensive `?? null` here would be a SECOND normalization,
    // in the one place that would then hide a first one that had stopped
    // working. An always-null parent is precisely this task's named failure
    // mode; it must be visible here rather than smoothed over.
    activatedBy: intent.record.activatedBy
  };
}

/**
 * The spawn's channel verdict for a read response (KAN-281): `true`, `false`,
 * or `null` when nothing was ever spawned here to have one.
 *
 * DELIBERATELY NOT PART OF `configEcho` ABOVE, though it is durable and sits
 * beside `activatedBy` on the same record. That block is spread into every row
 * of `list_agents` — eight shapes — and is bound field-for-field to
 * `ROW_SHAPES` in the read contract. Adding a field to it would publish this
 * boolean on eight surfaces to satisfy a request for two, which is the
 * compatibility-surface creep this ticket was scoped against: every one of
 * those fields is then a promise, and the ones nobody asked for are the ones
 * nobody maintains. It is spelled out at the two response sites instead.
 *
 * `null` FOR NO RECORD IS THE SAME SENTENCE `configEcho` SAYS WITH `config:
 * null` — no record, so nothing is claimed. It is not "this agent has no
 * channel", and the document says so in as many words, because `false` is what
 * a consumer branches on to conclude the channel is unavailable and a wrong
 * `false` is the only genuinely damaging value this field can take.
 */
function channelEnabledOf(intent: AgentIntent | undefined): boolean | null {
  // THE `??` IS A TYPE NARROWING, NOT A SECOND NORMALIZATION, and the
  // difference is worth stating because `activatedBy` directly above makes a
  // point of NOT having one — a defensive re-normalization there would hide the
  // registry's own coercer having stopped working.
  //
  // The same argument applies here and is not violated: `toChannelEnabled` runs
  // on both edges of the log, so a value that reached a record is already
  // `boolean | null` and this expression cannot change it. What it handles is
  // the `undefined` the OPTIONAL FIELD lets the compiler see — `activatedBy` is
  // required on `AgentRecord` and this is not, because a row written before the
  // field existed genuinely has no key. So a `null` arriving here still comes
  // from the coercer; only an `undefined` that never reached the log is
  // narrowed, and there is no reading of `undefined` other than "no value" for
  // it to paper over.
  return intent ? intent.record.channelEnabled ?? null : null;
}

/**
 * The three facts about the ANSWERING PROCESS that a caller needs before it can
 * read the rest of a response: `bootId`, the current `seq`, and when this
 * daemon started.
 *
 * `bootId` and `eventSeq` are read from the process-wide event stream rather
 * than threaded through the router's deps, because there is one boot per
 * process and the daemon's broadcast stamps from the same object — two copies
 * could disagree, and the one a subscriber compares against would be the one
 * that was wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY `startedAt` IS HERE AND NOT IN THE `provenance` BLOCK (KAN-214)
 *
 * The ticket proposed `provenance`, and this is the decision against it,
 * recorded here because the ticket asked for the reasoning rather than the
 * choice.
 *
 * `statusSince` is null for the whole fleet on a daemon that has not yet
 * watched anything change — which is every daemon in the minutes after a
 * restart, and a restart is correlated with the fleet's own (a power cut takes
 * both). A caller reading a page of nulls could not tell "my observer is new,
 * ignore this column" from "this column is meaningful and nothing is moving".
 * The two call for opposite responses. `startedAt` is the one more fact that
 * separates them: a daemon younger than the window you care about has not had
 * time to witness anything, and that is computable rather than guessable.
 *
 * NOT in {@link MessageRouter.provenance}, whose four buckets are a
 * classification of where each ROW FIELD came from. `observedAt` and
 * `censusReachable` belong there because they qualify how to read those
 * buckets. A process start time qualifies nothing in the legend — it is a fact
 * about the answering daemon, of the same kind as `pid`, and filing it under a
 * legend would blur the very line the comment on that method exists to hold.
 *
 * HERE, THOUGH, IT COSTS NOTHING TO KEEP HONEST. This function feeds BOTH
 * `daemon_status` and `list_agents`, so the two surfaces cannot disagree about
 * when the daemon started — not because somebody remembered to update both,
 * but because there is one expression and they share it. A constraint that
 * cannot be violated beats one that must be remembered.
 *
 * AND IT IS THE NAME `daemon_status` ALREADY PUBLISHES. `startedAt` has been on
 * that response since before KAN-122 (see provenance.ts's header, which dates
 * the PROCESS by it). This adds no new spelling for a fact that had one; it
 * makes the existing fact reachable on `list_agents`, which is the response the
 * nulls are on — and, as it happens, the only one of the two an MCP caller can
 * call at all.
 *
 * `daemonStartedAt` IS threaded through the deps, and that does not reintroduce
 * the disagreement the paragraph above warns about. There is one
 * `const daemonStartedAt` in daemon.ts, handed to every router this process
 * builds; unlike `bootId` it is stamped on no event, so no second copy exists
 * anywhere for a subscriber to compare against and find wrong.
 *
 * WHAT IT DOES NOT ESTABLISH, stated because a timestamp invites more than it
 * says: it is when this PROCESS started. It is not a claim that the daemon is
 * healthy, and it says nothing whatever about whether any agent's status is
 * meaningful. It bounds how long this daemon COULD have been watching; what it
 * actually watched is `statusSince`, one field per row, and still null when it
 * has not watched.
 */
function eventWatermark(daemonStartedAt: Date) {
  return {
    bootId: events.bootId,
    eventSeq: events.seq,
    startedAt: daemonStartedAt.toISOString()
  };
}

/**
 * `agent.deactivated`'s reason, and the preemption block when there is one.
 *
 * WHY THIS EXISTS AS A DISCRIMINATOR RATHER THAN A FLAG. The event used to
 * carry `preempted: true` and only when true, so "was this the agent's own
 * idea" was read from a field's ABSENCE — indistinguishable from a daemon that
 * forgot to set it, which is the same defect `alreadyRunning`/`started` were
 * put on every activate response to remove. `reason` is on every stand-down,
 * always, and takes one of two words.
 *
 * The block is everything the retired `agent_preempted_event` carried: who
 * took the slot and what they were worth, what the victim was worth and was
 * doing, the capacity arithmetic that made the slot necessary, and when. The
 * victim itself is the event's own `path`, which is why the old event's
 * separate `victim` object is gone rather than lost — it was the same agent
 * named twice.
 */
function deactivationCause(data: any, preemption?: PreemptionRecord) {
  if (!preemption) return { reason: 'requested' as const };
  return {
    reason: 'preempted' as const,
    preemption: {
      // The gate's own timestamp, which is the moment it DECIDED. Falling back
      // to now would silently re-date a preemption to whenever the teardown
      // finished, and the two differ by however long herdr took.
      at: typeof data?.preemptedAt === 'string' ? data.preemptedAt : new Date().toISOString(),
      by: {
        path: preemption.byPath,
        paneName: preemption.byPaneName,
        priority: preemption.byPriority
      },
      priority: preemption.priority,
      herdrStatus: preemption.herdrStatus,
      derivation: preemption.derivation,
      ...(data?.preemptionCapacity ? { capacity: data.preemptionCapacity } : {})
    }
  };
}

/**
 * The same compile-time binding {@link CAPACITY_FIELDS} gets, for the block
 * this helper builds — both levels of it.
 *
 * `preemption` is the deepest composite on the published surface: an object,
 * carrying an object (`by`), carrying the capacity report. Every level is
 * projected now, so every level needs a declaration that cannot drift away
 * from the site that fills it.
 */
type PreemptionBlock = Extract<
  ReturnType<typeof deactivationCause>,
  { preemption: unknown }
>['preemption'];

const _preemptionBlockMatchesTheContract: Exact<
  keyof PreemptionBlock,
  keyof typeof PREEMPTION_FIELDS
> = true;

const _preemptionByMatchesTheContract: Exact<
  keyof PreemptionBlock['by'],
  keyof typeof PREEMPTION_BY_FIELDS
> = true;

/**
 * THE DURABILITY ANSWER A LIFECYCLE EVENT CARRIES (KAN-165).
 *
 * `agent.configured`, `agent.activated` and `agent.deactivated` all fire after
 * a durable write that the registry is not allowed to throw on — an unwritable
 * log must not fail the operation in flight — and all three used to fire
 * IDENTICALLY whether or not that write landed, while the contract's sentence
 * for each said the record had been written. The daemon knew; it carried the
 * answer to the response and withheld it from the event.
 *
 * This is the answer, in one place, spread by all six emission sites. One
 * function rather than six ternaries for the same reason `rememberActivated`
 * states the parentage rule once: the sixth copy is where the wording quietly
 * stops matching the first, and this one is a published field.
 *
 * WHAT `undefined` MEANS, because it is a real case and not a defensive
 * default. Exactly one site reaches this without an outcome: the
 * session-addressed stand-down of an agent this daemon holds NO RECORD for.
 * Nothing was written because there was nothing to write against — and the
 * postcondition every one of these events is about ("a restart will see what
 * this event describes") already holds, since a registry with no row for the
 * path will not restore it. So that is `durable: true`, and it is true in the
 * same sense as a write that landed rather than in a weaker one.
 *
 * The other true-without-a-write case is inside `rememberActivated`, which
 * returns `ok: true` when the disk already says exactly this and it skips the
 * restatement. Same reading: the record agrees.
 *
 * `durabilityError` is defaulted rather than left possibly-undefined, so
 * `durable: false` never arrives on the wire without a reason attached — the
 * contract says it is present exactly when `durable` is false, and an optional
 * field set to `undefined` is dropped by the projection.
 *
 * THAT LAST CLAUSE IS A DEPENDENCY ON ANOTHER FILE, so it is named here rather
 * than left as background (KAN-164/KAN-165). The default above is load-bearing
 * *because* `projectEvent` in `src/events.ts` drops an optional field whose
 * value is `undefined`: remove the `??` and a failed write publishes
 * `durable: false` with no reason at all, on the one path that cannot be
 * re-requested. Two independently correct designs, correct together — which is
 * the composition this epic has already shipped wrong once, so it is written on
 * both sides and asserted on real traffic by `verify-event-contract.mjs` §2 —
 * which produces a real `durable: false` against a sealed registry and fails if
 * any published event carries one without a reason, AND separately fails if the
 * projection ever publishes an optional the daemon did not send. Both halves,
 * because the first alone stayed green when review changed the projection.
 */
function durability(outcome: RecordOutcome | undefined): {
  durable: boolean;
  durabilityError?: string;
} {
  if (outcome === undefined || outcome.ok) return { durable: true };
  return { durable: false, durabilityError: outcome.error ?? 'registry write failed' };
}

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  /**
   * Undeclared config knobs this boot has already complained about. See
   * {@link MessageRouter.warnOnEchoDrift} — in memory, and per boot, like the
   * missing-agent latch and for the same reason: it damps a log, and nothing
   * about the ANSWER depends on it. The response reports the drift on every
   * poll whether or not this set has seen it.
   */
  private warnedEchoDrift = new Set<string>();

  constructor(private deps: RouterDeps) {
    this.statusMemory = deps.statusMemory ?? new FleetStatusMemory();
  }

  public handle(data: any): void {
    // Responses echo the request's `id` so a transport can correlate them.
    const respond: Respond = (msg) =>
      this.deps.send(data.id !== undefined ? { ...msg, id: data.id } : msg);

    // Fire-and-forget actions only reply when a caller asked to be
    // correlated, so a streaming client doesn't get an ack per keystroke.
    //
    // A REFUSAL IS NOT AN ACK, AND DOES NOT COME THROUGH HERE (KAN-299). The
    // sentence above justifies itself narrowly and correctly, and the rule it
    // was written to justify used to be broader than it: a `pty_input` or
    // `pty_resize` that was REFUSED went down this same path, so a caller that
    // sent no `id` was never told. It typed into a session this daemon does not
    // hold and received nothing, forever — a terminal that looks alive and is
    // not, which is indistinguishable from success from the outside.
    //
    // So the split is per-OUTCOME on these two actions:
    //
    //   success  — an ack. It is what would arrive once per keystroke, it is
    //              the entire subject of the sentence above, and it stays
    //              gated on `id`.
    //   refusal  — not an ack. Rare by construction, so it cannot spam
    //              anything, and it is the one thing a caller must hear. Sent
    //              unconditionally, through `respond`.
    //
    // WHAT MAKES THAT SAFE NOW AND DID NOT BEFORE: the refusal is routable
    // without an `id`. It carries `action: '<action>_response'` and
    // `refusal: 'unknown_session' | 'invalid_payload'` (KAN-280), so a client
    // dispatching on `action` can place an uncorrelated one. The pre-KAN-280
    // loudness on this path was worthless for the opposite reason — it escaped
    // to the daemon's catch-all carrying neither field, and nothing could route
    // it. That was an argument against THAT message, never against telling a
    // caller it was refused.
    //
    // `pty_init` IS UNCONDITIONAL THROUGHOUT and is not an exception to any of
    // this. It is request/response by nature — you ask for a session id and you
    // need one back — so correlation is inherent, it takes `respond` for both
    // outcomes, and it always has. It is the precedent this rule was read off
    // rather than a case this rule bends around.
    //
    // The compiler holds the split; see {@link PtyAck} and {@link PtyRefusal}.
    const ack: Respond = (msg) => {
      if (data.id !== undefined) this.deps.send({ ...msg, id: data.id });
    };

    // The activate handler is async (it verifies the agent against herdr's
    // census before answering). A rejected handler promise would otherwise
    // escape the try/catch the daemon wraps this call in and surface as an
    // unhandled rejection, leaving the caller waiting on a response that
    // never comes.
    const guard = (p: Promise<void>, action: string) =>
      p.catch((err: any) => {
        console.error(`Handler error in ${action}:`, err?.message ?? String(err));
        respond({
          action: `${action}_response`,
          success: false,
          error: err?.message ?? String(err)
        });
      });

    switch (data.action) {
      case 'daemon_status': {
        const { config, daemonStartedAt, agentRegistry, bootBuild } = this.deps;
        // One read, both answers — see the same call in `handleListAgents`.
        const { entries, unreadable } = agentRegistry.read();
        const intents = AgentRegistry.intentsFrom(entries);
        // What this process was built from, and whether that is still what is
        // on disk (KAN-122). Computed per request rather than cached, because
        // half the answer is about the tree as it is RIGHT NOW — a daemon that
        // cached "current" at boot would report it forever, including for the
        // hour after somebody rebuilt underneath it.
        const { build, freshness } = buildProvenanceReport(bootBuild);
        respond({
          // Every other reply in this router carries one, and this was the
          // single exception. Butchr's client layer dispatches purely on
          // `action` (KAN-122), and an inconsistency that survives because it
          // was never worth fixing alone is a trap for whoever meets it next.
          // Clients still correlate by `id` — see cli.ts DaemonClient — and
          // adding this changes nothing about that.
          action: 'daemon_status_response',
          success: true,
          pid: process.pid,
          // `startedAt` USED TO BE SPELLED OUT HERE and now arrives with the
          // watermark below, which is the whole point of KAN-214: the same
          // expression puts it on `list_agents` too, so the two responses
          // cannot disagree about when this daemon started. Removing the
          // duplicate is not tidying — a second copy is the one that would
          // have gone stale.
          configPath: config.configPath,
          dataDir: config.dataDir,
          // What used to be `workspaceTypes` — the answer to "is the daemon up
          // with the config I just edited". There is no type table any more, so
          // the equivalent question is about the durable registry, which is now
          // the only place an agent's configuration exists.
          registryPath: agentRegistry.path,
          configuredAgents: intents.size,
          expectedAgents: Array.from(intents.values()).filter((i) => i.event === 'activated').length,
          // THE REGISTRY ROWS THIS DAEMON COULD NOT READ (KAN-302), on the
          // cheapest call on the socket as well as on the fleet read.
          //
          // Here BECAUSE of what the two counts above are. `configuredAgents`
          // and `expectedAgents` are answers to "what is in my registry", and
          // both are computed only from rows that parsed — so on the machine
          // that commissioned this work they would have read `0` and `0`, which
          // is indistinguishable from an empty registry and was in fact a
          // registry with a row in it. A count that silently excludes what it
          // could not read is the whole defect, one field to the left. These
          // two say what was excluded from those two.
          unreadableRecords: unreadable.slice(0, UNREADABLE_DISCLOSURE_LIMIT),
          unreadableRecordsTotal: unreadable.length,
          // The same two fields `list_agents` carries. Here too because this is
          // the cheapest call on the socket, and a subscriber whose only
          // question is "did the daemon restart" should not have to survey the
          // whole fleet to find out.
          ...eventWatermark(daemonStartedAt),
          // WHICH READ-PATH CONTRACT THIS PROCESS IMPLEMENTS (KAN-277), and
          // this response is its ONE home on the wire.
          //
          // It sits beside `build` and `freshness` because the three answer one
          // question — "which CrabCast am I talking to" — and this is the
          // response that exists to answer it. `build` names the commit;
          // `contractVersion` names the revision of
          // `docs/read-path-contract.md` the responses below obey, which is the
          // half a consumer can act on without a checkout to diff against.
          //
          // NOT ON `list_agents`, and the objection to that is answered rather
          // than ignored: a consumer polling the fleet does not have to
          // remember to ask, because the thing that invalidates this number is
          // already on every response it reads. The version is a property of
          // the PROCESS, and a process change is announced by `bootId`. Read it
          // once; re-read it when `bootId` moves. The whole argument, including
          // why there is no hello to put it on, is on READ_CONTRACT_VERSION.
          contractVersion: READ_CONTRACT_VERSION,
          build,
          freshness
        });
        return;
      }
      case 'configure_agent':
        this.handleConfigure(data, respond);
        return;
      case 'activate_agent':
        void guard(this.handleActivate(data, respond), 'activate');
        return;
      case 'deactivate':
        this.handleDeactivateSession(data, respond);
        return;
      case 'deactivate_agent':
        this.handleDeactivateAgent(data, respond);
        return;
      case 'forget_agent':
        this.handleForget(data, respond);
        return;
      case 'send_to_agent':
        this.handleSendToAgent(data, respond);
        return;
      case 'tail_agent':
        this.handleTailAgent(data, respond);
        return;
      case 'agent_status':
        this.handleAgentStatus(data, respond);
        return;
      case 'list_agents':
        this.handleListAgents(data, respond);
        return;
      case 'capacity':
        this.handleCapacity(data, respond);
        return;
      case 'pty_init':
        this.handlePtyInit(data, respond);
        return;
      case 'pty_input':
        this.handlePtyInput(data, ack, respond);
        return;
      case 'pty_resize':
        this.handlePtyResize(data, ack, respond);
        return;
      default:
        // `reset_by_key` lands here, by name, and that is the point of removing
        // the verb rather than redefining it: `reset` was a stand-down plus a
        // deletion that is now refused unconditionally (CrabCast allocates no
        // directories, so the set of directories it may delete is empty by
        // construction). A redefined `reset` would let every caller keep
        // calling it and quietly mean something else; an unknown action makes
        // them notice.
        respond({
          success: false,
          error:
            `Unknown action: ${typeof data?.action === 'string' ? data.action : JSON.stringify(data?.action)}` +
            (typeof data?.action === 'string' && /reset/.test(data.action)
              ? `. \`reset\` was removed: CrabCast no longer creates the directory an agent runs ` +
                `in, so it may not delete one either. Use \`deactivate_agent\` to stop an agent ` +
                `and \`forget_agent\` to remove its record.`
              : '')
        });
    }
  }

  // ------------------------------------------------------------- addressing

  /**
   * The canonical path a request is about, or the refusal.
   *
   * `strict` is the difference between "run something here" and "say something
   * about a record". An activation needs a directory that exists — it is about
   * to spawn a process into it. `deactivate`, `forget` and `status` must keep
   * working after the caller has deleted the directory, because that is exactly
   * when "stop expecting this" is asked for; they fall back to the lexical
   * resolve so the record can still be addressed.
   *
   * THE FALLBACK IS SCOPED TO ONE PROBLEM, and it took a review to make that
   * true. `strict: false` used to mean "on any PathError, resolve it
   * lexically" — but PathError has five causes, and the fallback was reasoned
   * out for exactly one of them (the directory is gone). `not-absolute` landed
   * in the same branch, so a relative path reached `path.resolve` HERE, in a
   * detached daemon whose cwd belongs to whichever client first spawned it.
   * That is the precise failure identity.ts refuses by name, still live in
   * three verbs after being fixed everywhere else — and refusing it in one
   * place while silently resolving it in another is worse than either, because
   * the refusal is what teaches a caller to resolve their own paths.
   *
   * So the discriminator decides, not the flag alone. `does-not-exist` is
   * recoverable; every other problem is refused by every verb, always. A cause
   * added to {@link PathProblem} later is refused until somebody argues it into
   * this switch, which is the direction a default should fail in.
   *
   * AND THE REFUSAL NOW CARRIES THE DISCRIMINATOR RATHER THAN FLATTENING IT
   * (KAN-382, read contract v10). This used to return `{ error }` alone, so five
   * causes with three different remedies reached the wire as one prose string —
   * `does-not-exist`, which the paragraph above calls the normal way an agent
   * ends, reported identically to a caller who passed a relative path. The
   * daemon had already computed the difference and dropped it here.
   *
   * `problem` IS NOT OPTIONAL ON THE REFUSAL ARM, and that is the whole design
   * rather than a detail: an optional discriminator would mean both "not a path
   * problem" and "an older daemon", which is the `undefined`-on-`refused`
   * ambiguity KAN-376 identified, freshly minted on a second field. It is total
   * because the catch is NARROWED to `PathError` — the only thing
   * `canonicalPath` throws — so there is no arm left needing an invented sixth
   * value to fill.
   *
   * A NON-`PathError` THEREFORE PROPAGATES rather than being reported as a bad
   * address, which it would not be. It is unreachable at this commit
   * (`canonicalPath` converts every `fs` throw into a `PathError` of its own),
   * and if it ever becomes reachable, `daemon.ts`'s dispatch catch answers the
   * caller `{ success: false, error }` — an honest "something blew up" instead
   * of a `bad-address` refusal naming a cause nobody established.
   */
  private addressOfRequest(
    input: unknown,
    strict: boolean
  ): { path: string } | { error: string; problem: PathProblem } {
    try {
      return { path: canonicalPath(input) };
    } catch (e: unknown) {
      if (!(e instanceof PathError)) throw e;
      const recoverable = !strict && e.problem === 'does-not-exist' && typeof input === 'string';
      if (!recoverable) {
        return { error: e.message, problem: e.problem };
      }
      // Lexical only, and safe precisely because we got here: the path is
      // absolute (`not-absolute` is refused above), so this resolve cannot
      // consult the daemon's cwd — it only normalizes `..` and `.` segments.
      // It is what the record would have been keyed by if the directory were
      // still there, and looking it up is harmless: the record either exists
      // under that string or it does not.
      return { path: path.resolve(input.trim()) };
    }
  }

  // -------------------------------------------------------------- configure

  /**
   * `configure(path, knobs)` — the verb that makes an agent exist.
   *
   * IT DOES NOT REFUSE AN OCCUPIED DIRECTORY, and that is load-bearing rather
   * than lax. The adopting caller's day-one sequence is: configure the fleet,
   * stand down their own panes, activate. A `configure` that inherited
   * `activate`'s occupancy guard would fail every call on cutover day and make
   * the required ordering undiscoverable. So it succeeds and hands back
   * `occupiedBy` as advisory, hours before the occupant would otherwise bite.
   * That is the difference between the guard being safe and being usable.
   *
   * IT MAY NOT `mkdir`. Every path now comes from the caller, so the
   * filesystem is the only thing left that can tell a directory you meant from
   * one you mistyped — see identity.ts.
   *
   * ON AN EXISTING RECORD IT RECONFIGURES PER ATTRIBUTE, and never by killing
   * the agent. {@link RECONFIGURATION_COST} is the table; the customer's
   * sentence is the reason: *"a reconciler that quietly discards conversation
   * history to satisfy a config diff is the worst bug this design could have. I
   * would rather have an honest 'cannot change X in place' than a convenient one
   * that costs me an agent's memory."* So where a respawn would be required this
   * REFUSES, names the attribute and why, leaves the running agent untouched,
   * and puts the remedy in the message. There is no force flag — see `forget`
   * for the same decision and the same reason.
   *
   * A SILENT DEFER IS NOT THE MIDDLE GROUND IT LOOKS LIKE. Accepting the change
   * and applying it "at next start" leaves the configuration and the world
   * disagreeing behind a `success: true`, which is the same failure in a
   * quieter costume — and it would break requirement 1's echo, whose whole
   * claim is that what a read reports is what the agent is RUNNING with.
   *
   * AND IT IS ATOMIC. A refused call applies NOTHING, including the knobs that
   * could have moved in place. `configure` takes ONE desired-state document;
   * applying half of it leaves the agent in a state nobody asked for — half
   * new, half old — which a retrying reconciler would never converge out of and
   * which would make the echo match neither the caller's intent nor any prior
   * state. The response says per knob which is which, so "half applied" is
   * never something a caller has to infer.
   */
  private handleConfigure(data: any, respond: Respond): void {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'configure_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    const parsed = parseAgentConfig(data);
    if (!parsed.ok) {
      fail(parsed.error, { path: agentPath, ...(parsed.missing.length ? { missing: parsed.missing } : {}) });
      return;
    }

    const intents = this.deps.agentRegistry.intents();
    const existing = intents.get(agentPath);

    // ONE census read, shared by the running check and the advisory below.
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, existing?.record.config.launcher ?? parsed.config.launcher
    );
    const session = this.deps.herdrBridge.getSessionByPath(agentPath);
    const running = Boolean(session) || (occupancy.reachable && occupancy.ours !== null);
    const ourPaneId = occupancy.reachable ? (occupancy.ours?.paneId ?? null) : null;

    // A LIVE PANE OF OURS IS NOT THE SAME FACT AS A LIVE AGENT OF OURS, and
    // treating them as one fact is what KAN-153 was.
    //
    // `running` answers "is something live at this path bearing our name". It
    // does NOT answer whether this daemon knows what is live there — that is
    // the record, and the record can be absent while the pane is not:
    //
    //   * a registry lost while herdr's panes survived — the state
    //     `verify-restart-survival` exists for, from the other side;
    //   * a `forget` that landed over a still-running agent, which `forget`
    //     refuses when it can see the pane and cannot refuse when it cannot.
    //
    // Every claim below about "the agent this call is changing" needs BOTH
    // halves, so the two are named apart here rather than being spelled
    // `running` at one call site and `running && existing` at another — which
    // is precisely the drift that put a non-null assertion on a branch
    // reachable without one.
    const liveAgentOfOurs = running && existing !== undefined;
    const unrecordedPane = running && existing === undefined;

    // ------------------------------------------- what this call asks to move
    //
    // ON A FIRST `configure`, EVERY KNOB MOVED. There was no record, so every
    // one of them went from "nothing is written here" to the value this
    // document gives it — and that is true of the OPTIONAL knobs a caller left
    // out as well: `configure` takes one desired-state document, the document
    // says "no prompt", and the record now carries that. Reporting the whole
    // set is the reading that makes `applied` mean the same thing on both
    // paths — what this call wrote — rather than a field whose meaning depends
    // on which branch produced it.
    const changed = existing
      ? changedAttributes(existing.record.config, parsed.config)
      : [...CONFIG_ATTRIBUTES];
    const restartRequired = changed.filter((n) => RECONFIGURATION_COST[n] === 'restart-required');
    const inPlace = changed.filter((n) => RECONFIGURATION_COST[n] === 'in-place');

    /** Every knob, with what this call did to it. See {@link AttributeOutcome}. */
    const outcomesWith = (applied: boolean): Record<string, AttributeOutcome> => {
      const out: Record<string, AttributeOutcome> = {};
      for (const name of CONFIG_ATTRIBUTES) {
        out[name] = !changed.includes(name)
          ? 'unchanged'
          : !applied
            ? RECONFIGURATION_COST[name] === 'restart-required'
              ? 'refused-restart-required'
              : 'withheld'
            // `liveAgentOfOurs`, NOT `running`. "In place" is a claim that the
            // value took effect on an agent this daemon is maintaining, and
            // over an UNRECORDED pane there is no such agent to make it about:
            // nothing here knows what that process was started with, so what
            // this call wrote is what the next `activate` will use. Saying
            // `applied-in-place` there would be the echo describing a process
            // no record accounts for.
            : liveAgentOfOurs
              ? 'applied-in-place'
              : 'applied';
      }
      return out;
    };

    /**
     * The compare-and-set token and the configuration STILL IN FORCE, on every
     * refusal path.
     *
     * ONE OBJECT, SHARED BY BOTH REFUSALS, and that is not tidiness. A refusal
     * applies nothing, so the token the caller already holds is still current —
     * and a refusal that moved it would tell a compare-and-set caller its write
     * landed when nothing was applied, so the caller stops retrying and the
     * agent keeps running the configuration nobody wanted. Building it once
     * means the property cannot hold on one refusal branch and quietly not on
     * the other, and it means the mutation that proves the property is asserted
     * (verify-state-read-echoes-config, mutation 1c) has a single target that
     * breaks every path at once.
     */
    const tokenUnchanged = existing
      ? {
          configVersion: existing.configVersion,
          config: existing.record.config,
          // CARRIED BECAUSE THE BLOCK IS READ AS A UNIT. `configuredAt` is what
          // a renderer pairs with `configVersion` to say when the configuration
          // still in force was frozen; without it the CLI printed a refusal
          // reading "configured before versions were recorded" over a record
          // that has carried the field since it was written. Found by running
          // the live proof rather than by reading this file, which is the point
          // of running it.
          configuredAt: existing.configuredAt
        }
      : {};

    // BOTH REFUSALS BELOW ARE ABOUT A *RE*CONFIGURATION, and the `existing` in
    // this condition is the whole of it (KAN-153).
    //
    // WHY IT IS NOT JUST A NULL GUARD. On a FIRST `configure` there is no
    // record, so `changed` is every attribute and `restartRequired` is
    // non-empty by construction — which used to walk a first configure over a
    // live pane straight into a refusal written for a reconfiguration, where
    // it read `existing!.configVersion` and threw. Guarding only the read
    // would have stopped the throw and left the refusal: a first `configure`
    // refused because a pane happens to be live, with no way out, since
    // `activate` requires `configure` first.
    //
    // So the refusal is scoped to what it was written to protect. Its whole
    // purpose is that a caller does not silently spend a running agent's
    // conversation on a knob change; a first configure has no prior
    // configuration to preserve and no conversation being spent, so there is
    // nothing here for it to protect. Occupancy is `activate`'s question and
    // `activate` already asks it — CrabCast maintains agents, it does not own
    // the directory or the pane, and a `configure` that refused because a pane
    // exists would be answering a question it was not asked.
    //
    // AND THE COMPILER NOW KNOWS. Narrowing here is what lets the message
    // below read `existing.configVersion` with no `!`: the claim "this branch
    // is only reachable with a record" is enforced rather than asserted, which
    // is the difference the assertion papered over. A `!` is a claim about the
    // world with no proof attached.
    if (existing && restartRequired.length) {
      // THE CENSUS COULD NOT ANSWER, AND THE RECORD SAYS THIS AGENT IS UP.
      //
      // Checked BEFORE the running test rather than after, because the running
      // test's negative is exactly what an unreachable herdr produces:
      // `listHerdrAgentsChecked` returns an EMPTY census when herdr does not
      // answer, so `ours` is null and `running` reads false — a check
      // rendering its own failure as an all-clear, and rendering it as
      // permission to rewrite the prompt of an agent that is very much alive.
      // That is the same mistake `activate` refuses as unverifiable and
      // `forget` refuses one verb over, and silence is not evidence here
      // either.
      //
      // It gates ONLY the restart-required knobs, which is the whole reason
      // this is not simply `forget`'s rule copied: `priority` and the gate
      // flags are daemon-side metadata whose new value is correct whether the
      // agent is up or down, so refusing them for want of a census would cost
      // a caller a capacity decision to buy nothing.
      //
      // RESIDUAL, stated rather than hidden: an agent whose record has fallen
      // behind (last event `configured`) over a live pane, with herdr
      // unreachable AND no session in this daemon, is not caught. `forget`
      // accepts the same window for the same reason — there is no third source
      // of evidence to consult — and a daemon restart re-attaches the fleet,
      // so the session map is empty only briefly.
      if (!running && !occupancy.reachable && existing?.event === 'activated') {
        fail(
          `Refusing to reconfigure ${restartRequired.join(', ')} on ${agentPath}: herdr did ` +
            `not answer, so whether an agent is running there could not be checked — and the ` +
            `registry records this agent as active. ` +
            `${restartRequired.length === 1 ? 'That knob is' : 'Those knobs are'} read once, ` +
            `at spawn, so writing ${restartRequired.length === 1 ? 'it' : 'them'} under a live ` +
            `agent would change the record without changing the agent. An unreachable herdr ` +
            `is silence, not evidence that nothing is there. NOTHING WAS APPLIED. Bring herdr ` +
            `up and try again; the in-place knobs (` +
            `${CONFIG_ATTRIBUTES.filter((n) => RECONFIGURATION_COST[n] === 'in-place').join(', ')}` +
            `) can be changed without it.`,
          {
            path: agentPath,
            refused: 'unverifiable',
            attributes: restartRequired,
            applied: [],
            withheld: inPlace,
            changed,
            outcomes: outcomesWith(false),
            ...tokenUnchanged,
            remedy:
              `Bring herdr up, then configure(${agentPath}, …) again — or ` +
              `deactivate(${agentPath}); configure(${agentPath}, …); activate(${agentPath}).`
          }
        );
        return;
      }

      // THE REFUSAL THIS TASK EXISTS FOR.
      //
      // The agent stays exactly as it is: no pane is closed, no conversation is
      // touched, no half of the document is written. What the caller gets
      // instead is the name of each attribute that forced this, the mechanical
      // reason for each one, and the three calls that would actually do what
      // they asked. The caller decides whether an agent's memory is worth the
      // change; this daemon does not decide it for them by default.
      if (running) {
        fail(
          `Refusing to reconfigure ${agentPath}: ` +
            `${restartRequired.length === 1 ? 'one attribute' : `${restartRequired.length} attributes`} ` +
            `cannot change under a running agent, and standing it down to make ` +
            `${restartRequired.length === 1 ? 'it' : 'them'} take effect would cost this agent ` +
            `its conversation.\n` +
            restartRequired
              .map((name) => `  ${name} — ${RESTART_REASON[name] ?? 'consumed at spawn'}.`)
              .join('\n') +
            `\nNOTHING WAS APPLIED` +
            (inPlace.length
              ? `, including ${inPlace.join(', ')}, which would have changed in place. ` +
                `\`configure\` takes one desired-state document: applying half of it would ` +
                `leave this agent half new and half old, which is a state nobody asked for ` +
                `and no retry converges out of. Send the in-place knobs on their own if you ` +
                `want them now.`
              : `.`) +
            ` The agent is untouched and still running` +
            (ourPaneId ? ` in pane ${ourPaneId}` : '') +
            `, and its configuration is still version ${existing.configVersion}.\n` +
            `Remedy: deactivate(${agentPath}); configure(${agentPath}, …); activate(${agentPath}). ` +
            `There is no force flag, deliberately — one would be this destroy-and-recreate ` +
            `with a label on it, and the decision to spend a conversation is the caller's.`,
          {
            path: agentPath,
            refused: 'restart-required',
            /** Exactly which ones forced it. */
            attributes: restartRequired,
            /** ALWAYS EMPTY — `configure` is atomic. */
            applied: [],
            /** In-place-capable, and not applied anyway. See the outcomes map. */
            withheld: inPlace,
            changed,
            outcomes: outcomesWith(false),
            reasons: Object.fromEntries(
              restartRequired.map((name) => [name, RESTART_REASON[name] ?? 'consumed at spawn'])
            ),
            // UNCHANGED, and said so: a refusal applies nothing, so the token a
            // caller holds is still current. Reporting it here is what lets a
            // reconciler tell "my write was rejected" from "my view is stale".
            ...tokenUnchanged,
            remedy:
              `deactivate(${agentPath}); configure(${agentPath}, …); activate(${agentPath})`,
            ...(ourPaneId ? { paneId: ourPaneId } : {})
          }
        );
        return;
      }
    }

    // MONOTONIC PER PATH, minted here because this is the only verb that
    // accepts a configuration. `activate` and `deactivate` carry the record
    // forward unchanged, so the version moves when — and only when — the
    // configuration does, which is what makes it usable as a compare-and-set
    // token by a caller reconciling desired state against ours.
    //
    // It counts ACCEPTED configures, not distinct ones: re-freezing identical
    // knobs still bumps it, because "was this call accepted" is the question
    // this verb answers today. Whether an identical restatement should be a
    // no-op is the idempotence slice's question, and answering it here would
    // decide it in the wrong PR.
    const configuredAt = new Date().toISOString();
    const record: AgentRecord = {
      path: agentPath,
      config: parsed.config,
      configVersion: (existing?.configVersion ?? 0) + 1,
      configuredAt,
      // WRITTEN HERE, AT THE MOMENT THE AGENT COMES INTO EXISTENCE, and not
      // inferred later from anything. `configure` is where a supervisor first
      // says an agent should exist, so it is where "whose agent is this"
      // genuinely has an answer — reconstructing it afterwards would mean
      // guessing from timing or from who happened to call next.
      //
      // A reconfigure by a HUMAN must not orphan an agent its supervisor
      // created, which is what `parentFor`'s carry-forward branch is for: this
      // call re-records the whole agent, and the parent travels with it.
      // AND ONLY ON THE CALL THAT CREATES THE AGENT, which is why the caller is
      // `null` when a record already exists. T4 made `configure` something you
      // may call on a RUNNING agent to move a knob, so without this a
      // reconfigure by anyone would re-parent it — the same theft the converging
      // `activate` branch refuses, through a different verb. Changing an
      // agent's priority is not standing it up.
      activatedBy: parentFor({
        target: agentPath,
        caller: existing ? null : callerIdentity(data),
        current: existing?.record.activatedBy
      }),
      // CARRIED FORWARD, NEVER MINTED HERE (KAN-281). `configure` freezes knobs;
      // it does not spawn, so it has no channel verdict of its own and must not
      // invent one. T4 made this something you may call on a RUNNING agent to
      // move a priority — so recomputing the field from the new
      // `config.mcpServers` would let a knob move rewrite a fact about a spawn
      // that already happened, and it would rewrite it from a config re-read,
      // which is the exact substitution AC1 forbids.
      //
      // `null` for a brand-new agent is the honest value and not a placeholder:
      // it has never been spawned, so there is no spawn to be channel-enabled.
      // The first `activate` is what fills it in.
      channelEnabled: toChannelEnabled(existing?.record.channelEnabled)
    };

    // A RECONFIGURATION DOES NOT CHANGE WHICH LIFECYCLE EVENT IS LAST, and
    // getting that wrong loses a fleet quietly.
    //
    // `expected()` — the set a daemon restart restores — filters on `event ===
    // 'activated'`. Writing a `configured` row over a RUNNING agent would take
    // it out of that set: the agent keeps working, the next daemon boot does
    // not know it should be there, and `reconcile` prints a healthy-looking
    // fleet with one agent missing from it. Nothing about a knob moving says
    // the agent stopped being activated, so the row that carries the new
    // configuration carries the event the record already had, with the
    // ORIGINAL activation's timestamp (see recordActivated).
    //
    // The stopped cases are unchanged and stay `configured`: that is what T3's
    // standby membership test was built against, and it is why that test asks
    // `everActivated` rather than reading the event.
    const durable = this.surfaceRegistryOutcome(
      existing?.event === 'activated'
        ? this.deps.agentRegistry.recordActivated(record, existing.at)
        : this.deps.agentRegistry.recordConfigured(record),
      `configured ${agentPath}`
    );

    // OUR OWN PANE IS NOT AN OCCUPANT OF OUR OWN DIRECTORY.
    //
    // `occupancyOf` answers "what is live here", which includes this agent when
    // it is running — the right answer to its own question, and the wrong one
    // to put behind a field whose note says `activate` will refuse until that
    // pane is gone. Now that a running agent can reach this response at all,
    // reporting it to itself would tell a caller that reconfiguring their own
    // agent's priority has blocked its activation.
    const occupiedBy = occupancy.reachable
      ? occupancy.occupants.filter((o) => o.name !== occupancy.ours?.name)
      : [];

    this.deps.broadcast({
      action: 'agent.configured',
      path: agentPath,
      config: parsed.config,
      configVersion: record.configVersion,
      configuredAt,
      // WHICH KNOBS MOVED, on the event as well as the response — a subscriber
      // diffing per path should not have to re-read to find out whether an
      // event it just saw touched anything it cares about. (The event's NAME
      // and the structured MCP payload are the event-contract slice's; this is
      // the field that slice's table already specifies for this event, carried
      // by the call that computes it.)
      changed,
      outcomes: outcomesWith(true),
      // WHETHER THE WRITE ABOVE LANDED, said on the event and not only on the
      // response (KAN-165). This broadcast fires either way — the registry does
      // not throw, by design — so without this the event's own contract sentence
      // ("and the record was written") was asserting a thing it had not checked.
      // The response carries the same answer at the bottom of this handler; the
      // two now agree, which is KAN-72's rule ported to the event path.
      ...durability(durable)
    });

    // WHAT ACTIVATION WILL WRITE INTO THE CALLER'S DIRECTORY, said now.
    //
    // This is what replaces the separate `provision` consent flag an earlier
    // design revision called for. A flag asks the caller to assert that they
    // understand a consequence; this TELLS them the consequence, at the moment
    // they configure and before anything is written, naming the file and the
    // exact keys. Being told beats being asked to assert — and unlike a flag it
    // cannot be supplied and then forgotten about, because it is not something
    // the caller supplies at all.
    const willWrite = Object.keys(parsed.config.mcpServers ?? {});

    respond({
      action: 'configure_response',
      success: true,
      path: agentPath,
      paneName: paneNameFor(agentPath),
      config: parsed.config,
      // Answered by the call that minted it, so a caller learns the token
      // without a follow-up read — which is the difference between a
      // compare-and-set it can perform and one it has to poll for.
      configVersion: record.configVersion,
      configuredAt,
      // THE SUPERVISOR OF RECORD, ANSWERED BY THE OTHER VERB THAT MINTS IT.
      //
      // `configure` on a new path is one of exactly two calls that may
      // establish parentage, so a caller that has just created an agent would
      // otherwise have to read it back to learn what was recorded about its own
      // call — and "read rather than infer" is this codebase's house rule for
      // precisely that shape (`mcp.ts`: both fields on EVERY successful
      // response, so it is read rather than inferred from a missing field).
      //
      // From `record`, so it is what was WRITTEN rather than what was asked
      // for: a reconfigure carries the existing supervisor forward, and this
      // says so rather than echoing the caller back at itself.
      activatedBy: record.activatedBy,
      reconfigured: Boolean(existing),
      // Carried on the reconfigure path so a caller can see the token move,
      // and so a refusal has a value to report unchanged.
      ...(existing ? { previousConfigVersion: existing.configVersion } : {}),
      // PER KNOB, ON EVERY SUCCESS — INCLUDING THE FIRST `configure`.
      //
      // These three are UNCONDITIONAL, and that is the same call this daemon
      // already made one verb over: `activate` puts `alreadyRunning` and
      // `started` on every successful response, true or false, "so 'did this
      // call start it' is read rather than inferred from a missing field".
      // Gating them on `existing` would make a first configure and a
      // reconfigure that changed nothing look identical from outside — both
      // silent — and our consumer has no second source to fall back on.
      // Absence is exactly the thing this slice is trying to stop them
      // inferring from, so nothing here is signalled by it.
      //
      // On a first configure that means `applied` is every knob and `withheld`
      // is empty: there was no record, so this call wrote all of it. See the
      // note on `changed` above for why the knobs a caller left out are in that
      // set — the record now carries "no prompt", and this call is what put it
      // there.
      changed,
      applied: changed,
      withheld: [],
      outcomes: outcomesWith(true),
      /**
       * Whether the values that moved took effect on a LIVE agent (as opposed
       * to being what the next `activate` will use). It is a fact about the
       * world rather than about the call, so it is stated rather than left to
       * be inferred from a status read.
       */
      appliedInPlace: liveAgentOfOurs && changed.length > 0,
      // `running` is still reported as the fact it is — something of ours is
      // live at this path — even where `appliedInPlace` is false because
      // nothing here knows what it is. The two fields answer different
      // questions and a caller needs both; see `unrecordedPane` below, which
      // is what makes the combination legible instead of contradictory.
      ...(running ? { running: true, ...(ourPaneId ? { paneId: ourPaneId } : {}) } : {}),
      ...(running && existing && changed.length
        ? {
            note:
              `${changed.join(', ')} changed IN PLACE on the running agent: ` +
              `${changed.length === 1 ? 'it is' : 'they are'} read out of the record when ` +
              `the decision that needs ${changed.length === 1 ? 'it' : 'them'} is made, so ` +
              `nothing was respawned and the conversation is untouched. The pane is the ` +
              `same one${ourPaneId ? ` (${ourPaneId})` : ''}.`
          }
        : {}),
      // A LIVE PANE OF OURS, AND NO RECORD UNTIL THIS CALL WROTE ONE.
      //
      // IT IS NOT REFUSED — see the block on the refusal above for why the
      // refusal is a reconfiguration's and not this call's. BUT IT IS NOT
      // ADOPTED SILENTLY EITHER, and that is what this field is: recording the
      // knobs and saying nothing about the pane would be a quieter version of
      // the same failure, leaving the caller to discover the state at
      // `activate` and to misread `alreadyRunning: true` as "it is running
      // what I configured".
      //
      // A SEPARATE KEY RATHER THAN A `note`, deliberately: the notes on this
      // response are mutually exclusive spreads that overwrite each other, and
      // this one has to survive alongside whichever of them also applies.
      ...(unrecordedPane
        ? {
            unrecordedPane: {
              paneName: paneNameFor(agentPath),
              ...(ourPaneId ? { paneId: ourPaneId } : {}),
              meaning:
                `A pane named ${paneNameFor(agentPath)} is already live in ${agentPath}. It is ` +
                `OURS by name, but nothing was configured at this path until this call, so ` +
                `this daemon has no record of what that agent was started with — a registry ` +
                `lost while herdr's panes survived, or a \`forget\` over an agent that kept ` +
                `running. NOTHING WAS APPLIED TO IT: the configuration above was written and ` +
                `is what the NEXT activation will use, and it does not describe the process ` +
                `running there now. \`activate\` on this path ADOPTS that pane rather than ` +
                `starting one, so it would answer \`alreadyRunning: true\` over a ` +
                `configuration no process has ever read. Stand the pane down first if you ` +
                `want an agent that is really running what you just configured.`,
              remedy: `deactivate(${agentPath}); activate(${agentPath})`
            }
          }
        : {}),
      // BOTH FILES FOR AN AGY AGENT, and the second one is the point of the
      // pair. `willWrite` is the disclosure that arrives BEFORE anything is
      // written, and for the `anti-gravity` launcher one of the things that
      // will be written is the user's GLOBAL antigravity config — a file
      // outside the agent's directory entirely. Naming only `.mcp.json` made
      // this the one disclosure in the chain that was still silent about it:
      // the activation response says it, `forget` says it, and the call that
      // could have warned somebody before the fact did not.
      willWrite: willWrite.length
        ? [
            {
              file: path.join(agentPath, '.mcp.json'),
              keys: willWrite,
              when: 'at activation',
              note:
                `Merged into your file if you have one; never replacing it. Named again in the ` +
                `activation response, and removed by \`forget\`.`
            },
            ...(parsed.config.launcher === 'anti-gravity'
              ? [
                  {
                    file: agyMcpConfigPath(),
                    keys: willWrite,
                    when: 'at activation',
                    note:
                      `Your GLOBAL antigravity CLI config, OUTSIDE this directory — the ` +
                      `antigravity CLI has no project-scoped equivalent, so it is also SHARED ` +
                      `with every other agy agent. Merged into; never replaced. \`forget\` ` +
                      `removes these keys only when no other agy agent's record still claims ` +
                      `them, and says which agent it is waiting on when one does.`
                  }
                ]
              : [])
          ]
        : [],
      // Advisory, never a refusal. Empty means the census answered and found
      // nothing live here.
      occupiedBy,
      // And when the census could NOT answer, that is said rather than
      // rendered as an all-clear: an empty `occupiedBy` from an unreachable
      // herdr would be a check reporting its own failure as good news.
      ...(occupancy.reachable
        ? {}
        : {
            occupancyUnknown: true,
            note:
              'herdr did not answer, so this configure could not check whether anything is ' +
              'already running in that directory. The record is written either way; ' +
              'activate will refuse rather than guess.'
          }),
      ...(occupiedBy.length
        ? {
            note:
              `Something is already running in ${agentPath}. The record is written, but ` +
              `activate will REFUSE until that pane is gone — stand it down, then activate.`
          }
        : {}),
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error })
    });
  }

  // ----------------------------------------------------------------- forget

  /**
   * `forget(path)` — the verb that makes an agent stop existing.
   *
   * IT REFUSES A RUNNING AGENT, and there is deliberately no `force`. No verb
   * here may terminate an agent as a side effect of a call that is not named
   * "stop it": only `deactivate` does that, and preemption, which is explicit,
   * opt-in, strictly-greater and reported. A `forget` that implicitly stopped a
   * live agent would be destroy-and-recreate wearing a different name, and a
   * force flag is that same path with a label on it. `deactivate` then `forget`
   * is the same two calls and leaves TWO decisions in the append-only log
   * instead of one flag nobody can audit.
   *
   * IT SUCCEEDS ON A PATH THAT WAS NEVER CONFIGURED, where `deactivate`
   * refuses, and the asymmetry has a rule behind it: `forget`'s postcondition
   * is the absence of a record, and absence is verifiable — it already holds.
   * `deactivate`'s postcondition is a claim about an agent, and there is no
   * agent to make a claim about; answering "stopped" for a path that never
   * held one is `success: true` about a world that does not exist.
   */
  private handleForget(data: any, respond: Respond): void {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'forget_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    const existing = this.deps.agentRegistry.intents().get(agentPath);
    if (!existing) {
      respond({
        action: 'forget_response',
        success: true,
        path: agentPath,
        existed: false,
        removed: [],
        note: 'No agent was configured there. The postcondition — no record for this path — already held.'
      });
      return;
    }

    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, existing.record.config.launcher
    );
    const session = this.deps.herdrBridge.getSessionByPath(agentPath);

    if (session || (occupancy.reachable && occupancy.ours)) {
      fail(
        `Refusing to forget ${agentPath}: an agent is running in it. Forgetting the record ` +
          `would leave a live pane nothing here can address — no stand-down, no status, no ` +
          `tail. Stop it first: deactivate(path), then forget(path). There is no force flag, ` +
          `deliberately: two calls leave two decisions in the log, and a flag leaves one ` +
          `nobody can audit.`,
        {
          path: agentPath,
          refused: 'running',
          paneId: occupancy.reachable ? (occupancy.ours?.paneId ?? null) : null
        }
      );
      return;
    }

    // A live pane that this daemon cannot POSITIVELY establish is not ours.
    //
    // The check above asks "is the live thing mine". This one asks the other
    // question — "is anything live here at all" — and the two are not
    // complements: that is the rule this daemon states for `activate`, and it
    // has to hold one verb over. Reading `ours: null` as "nothing is there"
    // and deleting the record on the strength of it is how a live agent with
    // bypassPermissions ends up in a caller's repository with nothing left
    // that can address it — which is the outcome the refusal above names as
    // the reason it exists.
    //
    // The ownership test is a positive one now (a pane bearing the name this
    // path derives), so an occupant that is not ours is PROVABLY not ours and
    // this could in principle let it through. It does not, because the cost of
    // the two mistakes is not symmetric: refusing wrongly costs one call after
    // stopping a pane the caller can see named below, and forgetting wrongly
    // costs an unaddressable agent nobody can find again.
    if (occupancy.reachable && occupancy.occupants.length > 0) {
      fail(
        `Refusing to forget ${agentPath}: ${occupancy.occupants.length} live pane(s) are in ` +
          `that directory, and none of them is this agent's.\n` +
          occupancy.occupants.map((o) => `  ${this.describeOccupant(o)}`).join('\n') +
          `\nThe record is KEPT. "Not ours" and "nothing is there" are different facts, and ` +
          `dropping the only record of an agent while something is live where it runs is the ` +
          `one way to produce a live agent nothing can address. Stop the pane above, or ` +
          `deactivate this agent first if it is the one you meant.`,
        { path: agentPath, refused: 'occupied', occupiedBy: occupancy.occupants }
      );
      return;
    }

    // The census could not answer AND the record says this agent is supposed
    // to be running. Silence is not evidence: forgetting on the strength of it
    // is the same mistake as spawning on the strength of it, one verb over.
    if (!occupancy.reachable && existing.event === 'activated') {
      fail(
        `Refusing to forget ${agentPath}: herdr did not answer, so whether an agent is ` +
          `running there could not be checked — and the registry records this agent as ` +
          `active. An unreachable herdr is silence, not evidence that nothing is there. ` +
          `Bring herdr up, or deactivate first.`,
        { path: agentPath, refused: 'unverifiable' }
      );
      return;
    }

    // RESIDUE CLEANUP, BEFORE THE RECORD IS DROPPED.
    //
    // Never-delete-a-DIRECTORY says nothing about the FILES we wrote into one,
    // and this is where they are taken back: exactly what CrabCast's provenance
    // record accounts for, never a recursive delete, and never the caller's
    // directory itself — which CrabCast cannot have created, since `configure`
    // may not `mkdir`. See provisioning.ts for the rules; each one is a refusal
    // rather than a behaviour.
    //
    // It runs BEFORE the `forgotten` row rather than after, because the
    // provenance that says what may be removed lives in the sidecar this
    // cleanup deletes. Doing it in the other order would be recording that the
    // agent is gone and then discovering we can no longer say what it left.
    //
    // `agentsDir` is what lets the cleanup reference-count the ONE artifact
    // that is shared between agents — CrabCast's key in the antigravity CLI's
    // global MCP config (KAN-140). It is read to answer one question about each
    // sibling record ("does it still claim this key") and nothing wider; when it
    // cannot be read, the key is LEFT and the response says so, because an
    // unremoved key is disclosed residue and a wrongly removed one silently
    // breaks a running agent.
    const sidecar = this.deps.herdrBridge.sidecarDirFor(agentPath);
    const residue = removeProvisionedArtifacts({
      agentPath,
      sidecarDir: sidecar,
      agentsDir: this.deps.herdrBridge.agentsDir()
    });

    const durable = this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordForgotten(existing.record),
      `forgot ${agentPath}`
    );

    // 'record' first: it is the removal the caller asked for, and the artifacts
    // are what came with it.
    const removed = ['record', ...residue.removed];

    this.deps.broadcast({
      action: 'agent.forgotten',
      path: agentPath,
      removed
    });

    respond({
      action: 'forget_response',
      success: true,
      path: agentPath,
      existed: true,
      removed,
      // What was deliberately NOT removed, each with its reason. An empty list
      // is the ordinary outcome and says so; a non-empty one is the honest
      // alternative to a cleanup that quietly gave up.
      left: residue.left,
      note:
        `The record is gone and so is everything CrabCast wrote outside its own data ` +
        `directory that it could account for. ${agentPath} itself was NOT touched: CrabCast ` +
        `never created it — \`configure\` may not \`mkdir\` — so it never deletes it, and ` +
        `nothing here removes anything recursively.` +
        (residue.left.length
          ? ` ${residue.left.length} item(s) were left in place, named above with the reason.`
          : ''),
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error })
    });
  }

  // ------------------------------------------------------------- the gate

  /**
   * Whether the machine can carry another agent, checked before spawning one.
   *
   * Only consulted when a *new* agent would be created: re-attaching to an
   * agent that is already running costs the machine nothing, and refusing that
   * would be refusing to look at work already in flight.
   *
   * An override is honoured — a cap that cannot be exceeded on purpose is a
   * cap people work around — but it is recorded rather than waved through.
   *
   * `refusable: false` passes unconditionally. This is the first of the three
   * decisions the old `gateExempt` boolean was carrying (the other two are in
   * {@link preemptionCandidates} and {@link capacityOf}), and the argument for
   * it is unchanged: the capacity model has already declined to charge an
   * unchargeable agent, so refusing one here would be the gate arguing with
   * its own arithmetic. It was also a lockout in practice — desktop baseline
   * load alone can pin headroom at 0 indefinitely, so an always-on agent could
   * never start without a manual override.
   */
  private capacityGate(request: GateRequest): CapacityGateResult {
    const { path: agentPath, paneName, priority, refusable, override, preempt, args } = request;

    /**
     * What this activation would have been spawned with, for the refusals
     * below. Empty string when there is nothing to say, so an agent with no
     * `args` reads exactly as it did before this field existed.
     *
     * Quoted the way the command line quotes it, so a reader can compare this
     * against `ps` output for the agent once it does start.
     */
    const argvNote = args.length
      ? `\nIt would have been started with ${args.map((a) => `'${a}'`).join(' ')} on its ` +
        `command line; nothing was started, so nothing was given them.`
      : '';
    const pass = (capacity: Capacity): CapacityGateResult => ({
      capacity,
      refusal: null,
      overrode: null,
      preemptable: null,
      preempted: null
    });

    const { agents } = this.surveyAgents();

    if (agents.some((a) => a.path === agentPath)) {
      // Already alive and already counted. Starting nothing costs nothing.
      return pass(this.capacityOf(agents));
    }

    const capacity = this.capacityOf(agents);

    if (!refusable) return pass(capacity);

    if (!capacity.atCapacity) return pass(capacity);

    // NO PREEMPTION ON A STALL (KAN-216). Preemption exists to free a SLOT, and
    // a stalled machine is not short of slots — three counting terms had room
    // and a veto zeroed them. Standing an agent down here would destroy its
    // work and then start a replacement onto the same stalled disk, which is
    // the one outcome worse than refusing. So the whole preemption path is
    // skipped rather than being asked for a victim it must not take: no offer,
    // no `preempt` honoured, and a refusal that says what to do instead.
    //
    // Only when the veto is what bound. A stalled machine whose board is ALSO
    // full binds on `cap`, and preemption there is the ordinary case that has
    // nothing to do with this term.
    // Only when the veto is what bound. A stalled machine whose board is ALSO
    // full binds on `cap`, and preemption there is the ordinary case that has
    // nothing to do with this term.
    //
    // It suppresses the VICTIM and not the rest of the gate, deliberately: an
    // early return here would also have skipped the `override` branch below and
    // made a stall the one refusal an operator could not override, which is a
    // veto with no way out. `override: true` still starts the agent, and is
    // still recorded with the arithmetic that refused it.
    const stallBound = !preemptionCanHelp(capacity);

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — an agent
    // on a machine full of agents of its own priority outranks nothing.
    const candidates = stallBound ? [] : this.preemptionCandidates(agents, agentPath);
    const victim = stallBound ? null : selectVictim(candidates, priority);
    const derivation = describeCapacity(capacity);
    const offer = (v: PreemptionCandidate): PreemptionOfferDto => ({
      path: v.path,
      paneName: v.paneName,
      priority: v.priority,
      herdrStatus: v.herdrStatus,
      incomingPriority: priority,
      offer: preemptionOffer(v, priority)
    });

    if (preempt && victim) {
      const at = new Date().toISOString();
      const preemption: PreemptionRecord = {
        byPath: agentPath,
        byPaneName: paneName,
        byPriority: priority,
        priority: victim.priority,
        herdrStatus: victim.herdrStatus,
        derivation
      };

      // Through the ordinary stand-down path rather than a teardown of its
      // own. `deactivate_agent` already handles every case this needs — a live
      // session and an agent that outlived its daemon — and answers honestly
      // about which it found. Preemption reusing it means there is one way an
      // agent stops, not two.
      let standDown: any = null;
      this.handleDeactivateAgent(
        // `preemptedAt` and `preemptionCapacity` ride along with the record for
        // the same reason the record does: the stand-down is where the
        // `agent.deactivated` event is built, and since the merge these three
        // are what that event's `preemption` block is made of. They used to be
        // fields of a SECOND broadcast this path sent afterwards.
        { path: victim.path, preemption, preemptedAt: at, preemptionCapacity: capacityDto(capacity) },
        (msg: any) => {
          standDown = msg;
        }
      );

      if (!standDown?.success) {
        // Nothing was freed, so nothing may start. Refusing here is the
        // important half: proceeding would leave the machine over capacity
        // *and* have announced a preemption that did not happen.
        const error =
          `Refusing to activate ${agentPath}: standing down ${addressOf(victim)} to make room ` +
          `failed (${standDown?.error ?? 'no reason given'}), so no capacity was freed.\n` +
          derivation + argvNote;
        console.error(`[capacity] preemption aborted: ${error}`);
        return { capacity, refusal: error, overrode: null, preemptable: offer(victim), preempted: null };
      }

      console.warn(
        `[capacity] preemption: ${agentPath} (priority ${priority}) stood down ` +
        `${describeCandidate(victim)} at ${at}\n${derivation}`
      );
      // NO SECOND BROADCAST HERE. `agent_preempted_event` used to be sent from
      // this line, immediately after the stand-down above had already sent
      // `agent_deactivated_event` for the same agent — two events describing
      // one thing, arriving in an order a subscriber had to correlate, with
      // the victim named `path` on one and `victim.path` on the other. The
      // contract merges them: the stand-down emits ONE `agent.deactivated`
      // carrying `reason: 'preempted'` and a `preemption` block built from the
      // record, the timestamp and the capacity arithmetic handed to it above.
      // Nothing that event carried has been dropped; it is carried once.

      // Re-surveyed rather than reused: the caller is about to be told what the
      // machine looks like, and it is not the machine that refused a moment ago.
      //
      // The activation now proceeds unconditionally, and that is deliberate.
      // Only the count term responds to a stand-down immediately — the load
      // average is a one-minute mean and the kernel has not yet reclaimed the
      // memory — so re-running the whole gate here would sometimes refuse
      // *after* destroying an agent's work, which is the worst of both
      // outcomes.
      const after = this.capacityOf(this.surveyAgents().agents);
      return {
        capacity: after,
        refusal: null,
        overrode: null,
        preemptable: null,
        preempted: { at, victim: offer(victim), derivation }
      };
    }

    if (!override) {
      // Both branches name what is running and what it is worth. Losing a slot
      // is survivable; not being able to see who you lost it to is not.
      const refusal =
        `${capacityRefusal(capacity, agentPath)}\n` +
        (stallBound
          // Not `noVictimReason`: that explains which running agents outranked
          // this one, which is true here and beside the point. On a stall there
          // is nothing to take, and saying why is what stops the reader going
          // looking for a victim to free by hand.
          ? `No agent is offered for preemption: standing one down frees a slot, and slots ` +
            `are not what this machine is short of — the counting terms had room for ` +
            `${capacity.headroomBeforeStall} and a stalled disk is what refused. Wait for ` +
            `the stall to clear, or start it anyway with override.`
          : victim
            ? preemptionOffer(victim, priority)
            : noVictimReason(candidates, priority)) +
        argvNote;
      return {
        capacity,
        refusal,
        overrode: null,
        preemptable: victim ? offer(victim) : null,
        preempted: null
      };
    }

    const at = new Date().toISOString();
    console.warn(
      `[capacity] override: starting ${agentPath} past capacity at ${at}\n${derivation}`
    );
    this.deps.broadcast({
      action: 'capacity.overridden',
      // `what` rather than `path`, and the contract says so: the subject of
      // this event is the machine that was overcommitted, and `what` names the
      // activation that overcommitted it.
      what: agentPath,
      at,
      capacity: capacityDto(capacity)
    });
    return {
      capacity,
      refusal: null,
      overrode: { at, derivation },
      preemptable: victim ? offer(victim) : null,
      preempted: null
    };
  }

  /**
   * Everything running that could be considered for a stand-down.
   *
   * `preemptable: false` agents are *excluded*, and the reason is arithmetic
   * as much as protection: an agent that is also unchargeable was never
   * counted in `running`, so standing one down frees no charged slot — the
   * machine would be exactly as full a moment later, and the preempt path
   * would admit the newcomer over the cap on the false premise that room was
   * made. This is the second of the three decisions the old `gateExempt`
   * boolean was carrying, and splitting them is what lets a caller have a
   * low-priority always-on agent that is charged but never taken.
   */
  private preemptionCandidates(
    agents: ListedAgent[],
    excludePath?: string,
    sharedIntents?: Map<string, AgentIntent>
  ): PreemptionCandidate[] {
    const candidates: PreemptionCandidate[] = [];

    // The caller's map when it has one — `list_agents` reads the registry once
    // for the whole response — and our own read otherwise, for the gate, which
    // is the only other caller and asks exactly once.
    const intents = sharedIntents ?? this.deps.agentRegistry.intents();

    for (const entry of agents) {
      if (excludePath && entry.path === excludePath) continue;
      if (!entry.preemptable) continue;

      const intent = intents.get(entry.path);
      // No record means no priority, and priority is not derivable from
      // anything else now that types are gone. An agent we cannot price is one
      // we must not offer as a victim — the comparison that authorises the kill
      // would have nothing on one side of it.
      if (!intent) continue;

      candidates.push({
        path: entry.path,
        paneName: entry.paneName,
        priority: intent.record.config.priority,
        herdrStatus: entry.herdrStatus,
        // The recorded activation time, which survives a daemon restart; the
        // session's creation time is the fallback. Null when neither knows —
        // absent data stays absent rather than being invented for the victim
        // ordering.
        activatedAt: (intent.event === 'activated' ? intent.at : null) ?? entry.createdAt
      });
    }

    return candidates;
  }

  /**
   * Write an activation down before it is acknowledged.
   *
   * Called on every successful activate, but only appends when it would change
   * something: re-activating an agent already recorded as activated with the
   * same pane is a no-op, and fleet clients activate often enough that
   * recording each one would fill the log with restatements of the same intent.
   *
   * The comparison is on the configuration, and that is the whole of it:
   * `activate` takes no attributes, so there is nothing a caller could pass
   * that might disagree with the record, and the pane an agent happens to be
   * in is no longer written down (see AgentRecord). So an activation of an
   * already-activated agent whose config has not changed genuinely changes
   * nothing, and appending would be a restatement.
   *
   * `spawnChannelEnabled` IS THE SPAWN'S CHANNEL DECISION, or `undefined` for
   * "this call did not spawn anything, so I have nothing to say about it"
   * (KAN-281). The two activate paths differ here, and that difference is the
   * whole reason it is a parameter rather than something read inside. The path
   * that SPAWNS has just watched the launcher decide, so it passes the verdict.
   * The CONVERGING path found the agent already running — its session may have
   * come from `attachSession`, which resolves nothing — so it passes nothing,
   * and the value already on the record stands.
   *
   * Overwriting on the converging path is the bug this shape exists to make
   * unavailable: a reconciler calls `activate` on running agents constantly, and
   * each of those calls would otherwise stamp a fresh `false` over a `true` that
   * was correctly recorded at the real spawn. The field would decay across the
   * fleet within minutes of the first reconcile — a durable field changing
   * without the thing it describes changing, which is worse than not publishing
   * it at all. `verify-channel-enabled.mjs` §6b is that regression, mutated in
   * and watched happening.
   */
  private rememberActivated(
    record: AgentRecord,
    caller: string | null,
    spawnChannelEnabled?: boolean
  ): RecordOutcome {
    const current = this.deps.agentRegistry.intents().get(record.path);
    // THE ONE PLACE AN ACTIVATION DECIDES PARENTAGE. Both activate paths — the
    // one that spawns and the converging one that finds the agent already
    // running — reach the log through here, so the rule is stated once instead
    // of at each call site, where the second one would eventually be written
    // differently from the first.
    const activatedBy = parentFor({
      target: record.path,
      caller,
      current: record.activatedBy
    });
    // `undefined` carries the record's own value forward; a boolean replaces it.
    // `??` rather than `||` is load-bearing: `false` is a real verdict here and
    // `||` would discard it in favour of whatever the record already held.
    const channelEnabled =
      spawnChannelEnabled ?? toChannelEnabled(record.channelEnabled);
    const toWrite: AgentRecord =
      activatedBy === record.activatedBy && channelEnabled === record.channelEnabled
        ? record
        : { ...record, activatedBy, channelEnabled };

    if (
      current?.event === 'activated' &&
      JSON.stringify(current.record.config) === JSON.stringify(toWrite.config) &&
      // PART OF "EXACTLY THIS" for the same reason `activatedBy` is (KAN-281).
      // The first activation to record a channel decision against an agent whose
      // row predates the field changes something real, and a short-circuit that
      // did not compare it would swallow precisely that write — leaving the
      // durable answer `null` forever while every response claimed to be
      // reading it from the record.
      current.record.channelEnabled === toWrite.channelEnabled &&
      // PART OF "EXACTLY THIS", and leaving it out would have been a quiet
      // defect: a supervisor activating an agent that is already up would be
      // told yes, write nothing, and the agent would keep the parent it had —
      // so the ONE call that establishes a new supervisor of record is exactly
      // the call this short-circuit would swallow. A no-op is only a no-op when
      // nothing about the record has changed.
      current.record.activatedBy === toWrite.activatedBy
    ) {
      // The disk already knows exactly this — a skipped restatement is durable.
      return { ok: true };
    }
    return this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordActivated(toWrite),
      `activated ${toWrite.path}`
    );
  }

  /**
   * Make a registry write failure observable outside the daemon log.
   *
   * The registry itself never throws — an unwritable log must not fail the
   * lifecycle operation the caller is in the middle of — but a swallowed
   * failure is the KAN-21 (in the extraction source) silent loss re-entering
   * through the error path: the agent exists, the disk does not know, and the
   * next boot forgets it. So the failure is broadcast to every connected
   * client, and the caller puts `durable: false` on its response, which is the
   * difference between "the daemon said yes and the disk knows" and "the
   * daemon said yes".
   */
  private surfaceRegistryOutcome(outcome: RecordOutcome, what: string): RecordOutcome {
    if (!outcome.ok) {
      this.deps.broadcast({
        action: 'registry.degraded',
        what,
        error: outcome.error ?? 'registry write failed',
        consequence:
          'This lifecycle event is not durably recorded: a daemon restart will not know about it. ' +
          'Fix the data directory (space, permissions) and re-issue the operation.'
      });
    }
    return outcome;
  }

  /**
   * Write a stand-down down, so reconciliation leaves this agent alone.
   *
   * This is the half of the registry that makes it *intent* rather than
   * history: without it, boot-time restoration would resurrect every agent
   * anyone had ever run. Recorded even when the teardown failed — the caller
   * asked for the agent to be gone, and that is the intent to honour.
   *
   * The whole configuration travels onto the stand-down, and that is not
   * tidiness: it is the only copy. An agent recorded without it and then
   * switched back on would have no priority, no launcher and no gate flags,
   * which is not a degraded activation — it is an agent that cannot be
   * activated at all.
   *
   * The supervisor of record travels with it, and takes no `caller` argument
   * for the same reason: stopping an agent is not activating it, so a stand-down
   * has no business MINTING parentage. It carries what the record already says,
   * which is what keeps a preempted or switched-off agent findable by the
   * supervisor that will be asked to decide whether to re-staff it.
   */
  private rememberDeactivated(
    record: AgentRecord,
    preemption?: PreemptionRecord
  ): RecordOutcome {
    return this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordDeactivated(record, preemption),
      `deactivated ${record.path}${preemption ? ' (preempted)' : ''}`
    );
  }

  /**
   * The resume cause for an activation nobody labelled one.
   *
   * An agent whose last stand-down was a preemption is being *resumed* when it
   * is switched back on, whatever the caller thinks it is doing — and it must
   * be told so, or it comes back with its whole conversation restored and no
   * turn to take. That is the idle-forever failure, reached by a route that
   * has nothing to do with booting: nobody rebooted anything, a person just
   * turned a switch back on.
   *
   * An explicit cause always wins; only boot-time reconciliation sets one.
   */
  private resumeCauseFor(agentPath: string, explicit?: ResumeCause): ResumeCause | undefined {
    if (explicit) return explicit;
    // `stoppedByPreemption`, not `preemptionFor`: compaction drops the
    // annotation naming who took the slot and keeps `wasPreempted`, and an
    // agent whose debt has been compacted away was still interrupted. Reading
    // only the annotation meant a compacted victim came back with its whole
    // conversation restored, no resume framing, and no nudge — sitting at an
    // empty prompt forever.
    return this.deps.agentRegistry.stoppedByPreemption(agentPath) ? 'preempted' : undefined;
  }

  /**
   * Tell a just-resumed agent to carry on, without making the caller wait.
   *
   * Fire-and-forget on purpose: the nudge waits up to two minutes for the
   * agent's prompt to appear, and an activate that blocked on that would time
   * out in every client. Scheduled onto a later turn rather than merely
   * un-awaited, which is not fussiness — the first thing the nudge does is
   * read the agent's pane through an `execSync` with a five-second ceiling, and
   * starting that inside this call would run it BEFORE the handler reaches
   * `respond`.
   */
  private nudgeIfResumed(session: HerdrSession, config: AgentConfig): void {
    if (!session.resume || session.resumedConversation !== true) return;
    const cause = session.resume;
    setTimeout(() => {
      void nudgeResumedAgent({
        herdrBridge: this.deps.herdrBridge,
        path: session.path,
        cause,
        launcher: config.launcher,
        log: (...args: any[]) => console.log(...args)
      });
    }, 0);
  }

  /**
   * The step that makes an activate response a statement about the world
   * rather than about our own intentions.
   *
   * Returns the complaint when success cannot honestly be claimed, and the
   * pane id when the agent has been confirmed to exist. It runs after herdr's
   * own errors have been dealt with, before anything is broadcast or answered
   * — so there is exactly one point at which activate decides it succeeded.
   *
   * A confirmed-absent agent takes its session down with it. That is not a
   * retry and not a cleanup: it is the difference between a failure a caller
   * can act on and one it is locked out of, because a session left active is
   * the one the next activate would reuse. An unverifiable answer changes
   * nothing — see abandonSession.
   */
  private async confirmActivation(
    session: HerdrSession
  ): Promise<{ error: string } | { paneId: string | null }> {
    // Existence means a live runtime for every launcher but `shell` — a name
    // registration over a dead pane must not verify (KAN-58, in the extraction
    // source). Sessions that reached this point were built by initPty, which
    // sets the field; an unset one gets the strict reading rather than the
    // lenient one.
    const presence = await this.deps.herdrBridge.confirmAgentPresent(
      session.paneName,
      session.expectsRuntime ?? true
    );
    if (presence.present) return { paneId: presence.paneId };

    console.error(
      `[Router] Refusing to report ${session.paneName} activated: ${presence.error}`
    );
    if (presence.reason === 'absent') {
      this.deps.herdrBridge.abandonSession(session.sessionId, presence.error);
    }
    return { error: presence.error };
  }

  /** How a refusal names a pane that is not ours. */
  private describeOccupant(o: PaneOccupant): string {
    return (
      `pane_id ${o.paneId ?? '(not reported)'}, name '${o.name}', ` +
      `agent_status ${o.agentStatus}${o.workDir ? `, cwd ${o.workDir}` : ''}`
    );
  }

  // --------------------------------------------------------------- activate

  /**
   * `activate(path)` — the verb that makes a configured agent run.
   *
   * NO INLINE OPTIONS. Everything an agent is comes from its record, so there
   * is nothing here a caller could pass that might disagree with what the
   * agent already is. `override` and `preempt` are not attributes of the
   * agent; they are decisions about the machine, taken by whoever pressed the
   * button.
   *
   * THREE OUTCOMES BEFORE ANYTHING SPAWNS, and the third is the whole point:
   *
   *   - nothing live in the directory        → spawn
   *   - something live and it is ours        → alreadyRunning
   *   - something live and it is NOT ours    → REFUSE, naming every pane
   *   - the census could not answer at all   → REFUSE as unverifiable
   *
   * The last one is the case that would otherwise fail silently.
   * `listHerdrAgentsChecked` returns an EMPTY census when herdr does not
   * answer, so a guard built the obvious way reads its own failure as an
   * all-clear and spawns into an occupied directory precisely when it cannot
   * see it. `reachable: false` is silence, not evidence.
   *
   * SAFE TO CALL AGAIN — A CONTRACT, NOT AN OBSERVATION. A supervisor
   * reconciles by diffing desired state against actual and calling the verbs
   * to close the gap, so it calls this on agents that are already exactly as
   * asked for, constantly. That call:
   *
   *   - answers `success: true` with `alreadyRunning: true`, never an error;
   *   - starts no second pane, and says `started: false`;
   *   - never touches the capacity gate, because nothing new is being
   *     charged for — an agent already running is already counted;
   *   - ATTACHES IF WE HOLD NO TERMINAL FOR IT, and always answers with a
   *     `sessionId`. Ownership and attachment are different facts (see
   *     `ourPaneIn`), and a daemon restart is where they part company: the
   *     panes survive, the session map does not. Attaching is not starting —
   *     it is `herdr agent attach` and nothing else — which is why this stays
   *     on the no-op side of the contract above;
   *   - and CONVERGES THE RECORD: if the disk says this agent was never
   *     started while our pane is live, this call writes the activation, so
   *     calling again is what repairs a durability failure rather than
   *     papering over it.
   *
   * `alreadyRunning` and `started` are on EVERY successful response, `true`
   * or `false`. A field that appears only when true asks the caller to read
   * meaning into an absence, which is the same shape of guess this daemon
   * refuses everywhere else.
   *
   * WHAT IDEMPOTENCE DOES NOT COVER, stated here because the two paths meet
   * in this function and confusing them turns a safety refusal into a silent
   * success: a LIVE FOREIGN PANE in the target directory refuses, always. It
   * is not "already as specified" — it is somebody else's agent, and the
   * ownership test is what separates the two. Making that refusal idempotent
   * would mean answering "already running" about a pane we did not start.
   *
   * ACCEPTED RESIDUAL RISK, WRITTEN DOWN RATHER THAN CLOSED: the occupancy
   * check and the spawn are not atomic. A pane appearing in the target
   * directory between them defeats the guard. CrabCast-against-CrabCast is
   * still caught by the path-derived pane name (herdr refuses the taken name);
   * CrabCast-against-a-stranger inside that window is not. The window is small
   * and closing it properly needs a lock that does not exist here, so it is
   * stated rather than papered over.
   */
  public async handleActivate(data: any, respond: Respond): Promise<void> {
    const { herdrBridge } = this.deps;
    /**
     * EVERY REFUSAL, and the two things it is required to say about `started`
     * and `alreadyRunning` — stated ONCE, here, rather than remembered at nine
     * call sites (KAN-138 item 6).
     *
     * It was remembered at four of them and forgotten at five. `started: false`
     * rode the unverifiable, occupied, attach-spawn-error and capacity refusals
     * and was absent from the address-error, bad-flag, not-configured,
     * spawn-error and confirm-failure ones — so a caller could not read it
     * without first knowing which KIND of refusal it had received, which is the
     * branch-on-absence this daemon refuses everywhere else. Both fields are
     * decided here now:
     *
     *   `started: false` is PRESENT ON EVERY REFUSAL, because it is a fact and
     *   it is the one the caller most needs: nothing was spawned. Defaulted
     *   before `extra` spreads, so a site may restate it and none may forget
     *   it — and a refusal added tomorrow gets it without anyone noticing it
     *   had to.
     *
     *   `alreadyRunning` is NEVER `false` — the compiler holds that one, see
     *   {@link ActivateRefusalFields}. It is absent where the refusal never
     *   reached the question and `true` on the one refusal that reached it and
     *   found the agent running. It is absent in particular on the `occupied`
     *   refusal, and that absence is asserted rather than typed, because the
     *   same value is legitimate one branch over. An assertion of `!== true`
     *   passes on a literal `false`, which is why the proof checks for the key
     *   rather than for its value.
     */
    const fail = (error: string, extra: ActivateRefusalFields = {}) =>
      respond({ action: 'activate_response', success: false, started: false, error, ...extra });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      // KAN-382: the cause, beside the prose rather than instead of it. `strict`
      // here, so all five of `PathProblem` are reachable on this branch —
      // `does-not-exist` included, which is precisely the one a correct caller
      // meets when the directory it configured has since been deleted.
      fail(address.error, { pathProblem: address.problem });
      return;
    }
    const agentPath = address.path;
    const paneName = paneNameFor(agentPath);

    // Before anything is looked up, because both of these decide what happens
    // to agents other than this one. See invalidFlag.
    const badFlag = invalidFlag('override', data.override) ?? invalidFlag('preempt', data.preempt);
    if (badFlag) {
      fail(badFlag, { path: agentPath });
      return;
    }

    // `configure` is mandatory and this is where that is enforced. The refusal
    // names what is missing rather than merely saying no, because a caller
    // that is only told "no" retries the same call forever.
    const intent = this.deps.agentRegistry.intents().get(agentPath);
    if (!intent) {
      fail(
        `No agent is configured at ${agentPath}. \`activate\` takes no attributes — an agent ` +
          `is its directory plus the knobs \`configure\` froze onto it, and nothing here can ` +
          `invent them. Missing: priority, launcher (and optionally prompt, mcpServers, label, ` +
          `refusable, chargeable, preemptable). Call configure(path, …) first.`,
        { path: agentPath, refused: 'not-configured', missing: ['priority', 'launcher'] }
      );
      return;
    }
    const config = intent.record.config;

    // ONE census read, answering both "is anything live here" and "is it ours".
    const census = herdrBridge.listHerdrAgentsChecked();
    const occupancy = herdrBridge.occupancyOf(census, agentPath, config.launcher);

    if (!occupancy.reachable) {
      fail(
        `Refusing to activate ${agentPath}: herdr did not answer \`agent list\`, so whether ` +
          `anything is already running in that directory could not be checked. An empty ` +
          `census from an unreachable herdr is silence, not evidence — spawning on the ` +
          `strength of it would put a second agent into an occupied directory precisely ` +
          `when we cannot see it. NOTHING WAS STARTED. Bring the herdr server up and retry.`,
        // `started: false` comes from `fail` itself now, on this refusal and on
        // the eight others — see its header for why it stopped being something
        // each site had to remember.
        { path: agentPath, refused: 'unverifiable', verified: false }
      );
      return;
    }

    // OURS FIRST, and the order matters. Asking "is anything here" before "is
    // this mine" is what let a co-occupant decide the answer: our own agent
    // plus a stranger in the same directory would take the refusal branch and
    // report our live agent as unstartable.
    if (occupancy.ours) {
      // Not an error, and no second pane. `activate` on a running agent is
      // the ordinary state of a caller reconciling towards desired state.
      //
      // A stranger sharing the directory does NOT turn this into a refusal —
      // our agent is already there and refusing would not un-share it — but it
      // is reported rather than swallowed, because two agents in one directory
      // is the thing this whole guard exists to make visible.
      const coOccupants = occupancy.occupants.filter((o) => o.name !== paneName);

      // THE RECORD IS PART OF THE POSTCONDITION, not a side effect of
      // spawning — and this is what makes the no-op a reconciling answer
      // rather than merely a quiet one.
      //
      // The state it repairs is reachable and this daemon already says so
      // elsewhere: handleDeactivateAgent notes that "a durable write that
      // failed after an activation leaves exactly that state over a live
      // pane". Get there — an EIO on the registry write, a stand-down whose
      // pane outlived the daemon that recorded it — and the record says
      // `configured` or `deactivated` while our pane is live. Without this
      // write, the retry a supervisor makes precisely to repair that answers
      // `success: true, alreadyRunning: true`, repairs nothing, and reports no
      // durability problem: the agent stays out of `expected()`, so the next
      // boot does not restore it and the fleet reads it as never started while
      // it works. A verb whose whole job is being safe to call again must not
      // have a call that cannot converge.
      //
      // `rememberActivated` short-circuits when the disk already says exactly
      // this, so the steady-state no-op writes nothing at all — the repair
      // costs a row only on the call that actually needed it.
      const recordWasBehind = intent.event !== 'activated';
      // `intent.record`, NOT a rebuilt `{path, config}`, and the difference is
      // only visible once both slices are in the tree. The record also carries
      // `configVersion` and `configuredAt`; rebuilding it from the two fields
      // this branch happens to have named drops them, and `intents()`
      // normalizes an absent version to 1 — so the call whose whole job is
      // REPAIRING the record would silently reset the compare-and-set token a
      // reconciler diffs on, on an agent that had been configured seven times.
      // A converging write that loses a field is not a repair.
      //
      // AND `null` FOR THE CALLER, WHICH IS THE WHOLE OF THE LESSON OF
      // KAN-145 (IN THE EXTRACTION SOURCE) IN ONE ARGUMENT. This is the
      // branch that runs when the agent is ALREADY
      // RUNNING — it re-attaches a terminal and repairs a record; it does not
      // stand anything up. So the caller here is whoever is *looking at* this
      // agent, not whoever *started* it, and those are different questions that
      // coincide often enough to look identical in testing.
      //
      // Butchr filed exactly this against their own implementation: identity
      // taken from the attaching side answers "who is attached" and silently
      // re-parents an agent to whoever last converged on it. Under path
      // identity that would be worse than cosmetic — a reconciler polling
      // `activate` to hold desired state would quietly become the supervisor of
      // record for every agent in the fleet, and the org chart the customer
      // wants would redraw itself to say so.
      //
      // Passing `null` sends `parentFor` down its carry-forward branch: the
      // record keeps the supervisor that actually started the agent. Only the
      // spawn path below may mint one. See `parentFor`, and
      // `verify-activated-by.mjs` §5, which activates as A, converges as B, and
      // asserts it still says A.
      //
      // NO CHANNEL VERDICT EITHER, AND IT IS THE SAME ARGUMENT ONE FIELD OVER
      // (KAN-281). This branch did not spawn the agent, so it did not watch the
      // launcher decide; the session it is holding may have come from
      // `attachSession`, which resolves no MCP servers at all. Passing a verdict
      // from here would be reporting a decision this call never made — and,
      // because a reconciler runs this path constantly, it would overwrite the
      // real spawn's `true` with a manufactured `false` on every poll. Omitted,
      // so the record's own value carries forward.
      const durable = this.rememberActivated(intent.record, null);

      // THE SECOND QUESTION, ASKED SEPARATELY (KAN-136). `occupancy.ours`
      // answers "is this pane ours"; it says nothing about whether THIS daemon
      // holds its terminal, and a daemon restart is exactly the state where
      // the two disagree — herdr owns the panes, the session map died with the
      // process. Returning from here on ownership alone left every restored
      // agent recognised and unreachable: `list_agents` reported it
      // `sessionless`, the response carried no `sessionId`, and this daemon's
      // own advice to a client whose session died — "ask for the agent again
      // by path and use the session id that comes back" — had no session id to
      // come back. The only route to a live attach was `deactivate` →
      // `activate`: killing the agent you were trying to reach.
      //
      // ATTACHING IS NOT STARTING, and the distinction is the whole reason
      // this is safe. `attachSession` runs `herdr agent attach` and nothing
      // else: no `agent start`, no provisioning, no second pane. `started`
      // below is still `false`, the capacity gate is still untouched — an
      // agent already running is already counted — and the foreign-occupant
      // refusal below is still the branch a pane that is not ours takes.
      let session = herdrBridge.getSessionByPath(agentPath);
      const reattached = session === undefined;
      if (!session) {
        session = herdrBridge.attachSession(agentPath, config.launcher);

        // An attach that threw leaves the agent running and this daemon
        // without a terminal for it, which is not a success however healthy
        // the pane is. Reported on the same channel a refused spawn uses — a
        // response carrying `success: true` and no usable session is the
        // KAN-23 (in the extraction source) false success in its other
        // direction.
        if (session.spawnError) {
          fail(session.spawnError, {
            path: agentPath,
            paneName,
            paneId: occupancy.ours.paneId,
            // THE ONE REFUSAL ENTITLED TO THIS FIELD, and the reason
            // `ActivateRefusalFields` types it `true` rather than forbidding
            // it: the pane is ours and live, so the question was reached and
            // answered. `started: false` comes from `fail`.
            alreadyRunning: true,
            // The record was converged above and stays converged: the agent
            // IS running, so `expected()` must contain it whether or not we
            // managed to take its terminal.
            ...(recordWasBehind ? { recordReconciled: true } : {})
          });
          return;
        }
      }

      // Only when this call produced the session. A client rendering a fleet
      // learns that an agent it could not reach is reachable again from the
      // same event a fresh activation sends; the steady-state no-op still
      // broadcasts nothing, because nothing changed.
      if (reattached) {
        this.deps.broadcast({
          action: 'agent.activated',
          path: agentPath,
          paneName,
          paneId: occupancy.ours.paneId,
          sessionId: session.sessionId,
          status: session.status,
          // The version of the configuration this agent is running under, so a
          // subscriber can tell from the event alone whether the agent that
          // just came up is the one it configured — without a second call, and
          // without keeping a shadow copy that is wrong after a reconfigure.
          configVersion: intent.configVersion,
          // From the CONVERGING write above, which is the one this branch exists
          // to make. `durable: false` here is the sharpest form this field takes
          // anywhere: the agent is running, this call re-took its terminal, and
          // the repair the caller made precisely to get it back into `expected()`
          // did not reach the disk. Announcing the re-attach without that would
          // tell a fleet client the agent is restored when the next boot will
          // still not know about it.
          ...durability(durable)
        });
      }

      respond({
        action: 'activate_response',
        success: true,
        path: agentPath,
        paneName,
        // Stated on every activate response, never inferred from absence: a
        // reconciler has to be able to tell "I started this" from "it was
        // already up" without parsing prose, and a field that only appears
        // when true is indistinguishable from a field a daemon forgot.
        alreadyRunning: true,
        started: false,
        paneId: occupancy.ours.paneId,
        // ON EVERY SUCCESSFUL ACTIVATE RESPONSE, both branches, for the same
        // reason `alreadyRunning` is: a caller must be able to reach the
        // agent it just asked about without a second call, and a field that
        // appears on one branch only asks it to guess which branch ran.
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        verified: true,
        // An idempotent activation is the ordinary state of a reconciling
        // caller, and it is the read it makes most often — so it carries the
        // same echo the spawning branch does rather than being the one answer
        // that says less.
        //
        // FROM A RECORD RE-READ AFTER THE CONVERGING WRITE ABOVE, not from the
        // intent this handler opened with. A response describes the world it
        // leaves behind, and `rememberActivated` has just run — so re-reading
        // is how `everActivated` can be `true` here while remaining a purely
        // durable fact. Inferring it from liveness instead was the defect this
        // replaces: it made a field the legend calls durable change with the
        // census and revert on restart.
        ...configEcho(this.deps.agentRegistry.intents().get(agentPath), 'whole'),
        // ON THIS BRANCH TOO (KAN-281), and it is the branch that decides
        // whether the field is worth having. An idempotent `activate` is the
        // read a reconciling caller makes most often, and it is what a consumer
        // gets for an agent that was already up — so a field present only on the
        // spawning branch would be absent exactly when it is asked for most.
        // The value is the one the REAL spawn recorded: this branch passed no
        // verdict to `rememberActivated`, so nothing here overwrote it.
        channelEnabled: channelEnabledOf(this.deps.agentRegistry.intents().get(agentPath)),
        // Present only when THIS call took the terminal back — the agent was
        // running and unreachable, and now is not. Silent on the steady-state
        // no-op, where the session was already ours.
        ...(reattached ? { reattached: true } : {}),
        // Present only when the disk disagreed with the world and this call
        // settled it. Silent when there was nothing to repair.
        ...(recordWasBehind ? { recordReconciled: true } : {}),
        // Same meaning as on the spawn path: the agent is running and
        // verified, but the disk does not know, so a restart will not restore
        // it. Reported here too, or the repair could fail as silently as the
        // damage it exists to undo.
        ...(durable.ok ? {} : { durable: false, durabilityError: durable.error }),
        ...(coOccupants.length
          ? {
              occupiedBy: coOccupants,
              note:
                `This agent is running, and ${coOccupants.length} pane(s) that are not ours ` +
                `are live in the same directory. Nothing was started and nothing was ` +
                `closed, but two agents in one directory is how work gets overwritten — ` +
                `the panes are named here so somebody can decide about them.`
            }
          : {})
      });
      return;
    }

    if (occupancy.occupants.length > 0) {
      fail(
        `Refusing to activate ${agentPath}: ${occupancy.occupants.length} live pane(s) are ` +
          `already running in that directory and none of them is ours.\n` +
          occupancy.occupants.map((o) => `  ${this.describeOccupant(o)}`).join('\n') +
          `\nNOTHING WAS STARTED. Two agents in one directory is how work gets overwritten ` +
          `and neither of them finds out. Stop the pane above, or point CrabCast at a ` +
          `different directory. This is not a claim on that pane: CrabCast never closes a ` +
          `pane it did not start.`,
        {
          path: agentPath,
          refused: 'occupied',
          verified: false,
          // NO `alreadyRunning` HERE, and its absence is the point rather than
          // an omission: this branch found a pane that is NOT ours, so it has
          // established nothing about whether our agent is running. Reporting
          // `true` is the swallow that turns this safety refusal into a silent
          // success; reporting `false` claims a look that never happened. The
          // absence is asserted in verify-idempotent-lifecycle.mjs §4, because
          // one branch over the same value is correct and no type can tell
          // them apart. `started: false` comes from `fail`.
          occupiedBy: occupancy.occupants
        }
      );
      return;
    }

    let session = herdrBridge.getSessionByPath(agentPath);

    // The census says nothing is live here, so a session we still hold is a
    // corpse. Releasing it up front is what lets THIS activate spawn, rather
    // than reusing a dead session and failing confirmation a full poll later.
    // Only past the runtime-confirm window: inside it, an empty pane is the
    // ordinary state of an agent still booting, and abandoning the session
    // would kill an activation another caller is still confirming.
    if (session && Date.now() - session.createdAt.getTime() >= RUNTIME_CONFIRM_TIMEOUT_MS) {
      herdrBridge.abandonSession(
        session.sessionId,
        `herdr has no live agent in ${agentPath}; the session was released before re-activating`
      );
      session = undefined;
    }

    let gate: CapacityGateResult | null = null;

    if (!session) {
      // Before the prompt is even rendered: the cheapest refusal is the one
      // that happens before any work is done for an agent that will not exist.
      gate = this.capacityGate({
        path: agentPath,
        paneName,
        priority: config.priority,
        refusable: config.refusable,
        // Read off the record, like every other knob the gate judges — this is
        // what the spawn below would have used, so the refusal describes the
        // activation that did not happen rather than a guess at one.
        args: config.args ?? [],
        override: data.override === true,
        preempt: data.preempt === true
      });
      if (gate.refusal) {
        fail(gate.refusal, {
          path: agentPath,
          // `error` is the whole refusal, for the log and for MCP callers.
          // `refusedBy`, `reason` and `derivation` are the same thing split
          // into the pieces a UI can lay out — a client that shows none of
          // this leaves the user at a dead switch.
          refusedBy: 'capacity',
          reason: capacityReason(gate.capacity),
          derivation: describeCapacity(gate.capacity),
          capacity: capacityDto(gate.capacity),
          priority: config.priority,
          // `started: false` comes from `fail`.
          // Named, so a client can offer a button that says whose work it
          // ends. Absent when there is nothing this activation outranks.
          ...(gate.preemptable ? { preemption: gate.preemptable } : {})
        });
        return;
      }

      // An explicit `resume` is set only by boot-time reconciliation, never by
      // an ordinary client: it changes what the agent is told when there is
      // nothing to continue, and an ordinary activation is not an interrupted
      // one. What a client *can* produce without saying so is the
      // re-activation of an agent it previously preempted, which IS an
      // interrupted one — resumeCauseFor is where that is recognised rather
      // than trusted to the caller.
      const explicit: ResumeCause | undefined =
        data.resume === 'reboot' || data.resume === 'daemon-restart' ? data.resume : undefined;
      const resume = this.resumeCauseFor(agentPath, explicit);

      // `config.prompt` verbatim. There is nothing between the caller's bytes
      // and the file the agent reads.
      //
      // THE RESUME RULE'S INPUT is read from the durable record here, because
      // the bridge cannot read it and must not guess: `everActivated` is
      // whether CrabCast has ever run an agent at this path. False means any
      // conversation on disk there is not ours — at a caller-owned directory,
      // very often the human's own — and the launcher starts a new session
      // instead of continuing it. See resume.ts.
      // THE START IS RECORDED BEFORE IT IS ISSUED (KAN-263), and the order is
      // the point rather than an accident. This is the only place in the daemon
      // that brings a new agent into being, so it is the only place the ledger
      // the capacity gate divides can be written from; recording it after the
      // spawn would leave a window — short, and exactly the window a 3-second
      // restore stagger lands in — where an agent exists and no term charges
      // for it. A spawn that then fails is removed below, which is the
      // direction that costs a spurious refusal rather than a missed one.
      recordAgentStart(agentPath);

      session = herdrBridge.spawnSession(
        agentPath,
        config,
        config.prompt,
        resume,
        intent.everActivated === true
      );

      // Reconciliation nudges its own restores, in sequence and with the
      // stagger it needs; it passes an explicit cause, which is how the two
      // are told apart. A preemption resume has nobody else to do it.
      if (!explicit && !session.spawnError) this.nudgeIfResumed(session, config);
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists, and an error herdr handed us must never be
    // answered with success: true. It is not the whole of the question, which
    // is why confirmActivation follows: herdr can also report success and
    // leave no agent behind, and that case is answered by looking rather than
    // by trusting.
    if (session.spawnError) {
      // KAN-263: herdr said no, so nothing was started and nothing is spending
      // this machine's cores. Charging for it would refuse the NEXT activation
      // on the strength of an agent that does not exist — the one direction in
      // which this ledger can do harm, and the only one it is unwound for.
      forgetAgentStart(agentPath);
      fail(session.spawnError, { path: agentPath });
      return;
    }

    const confirmed = await this.confirmActivation(session);
    if ('error' in confirmed) {
      // Same reasoning, one step later: confirmation is the check that herdr
      // reported success and left no agent behind, and an agent that was never
      // there costs nothing to run.
      forgetAgentStart(agentPath);
      fail(confirmed.error, { path: agentPath, verified: false });
      return;
    }

    // After confirmation, deliberately: the registry records agents that
    // provably exist, and an fsync'd record of an agent that was never there
    // would have reconciliation resurrecting a ghost on every boot.
    //
    // The pane id comes from the census that PROVED the agent is there, which
    // is what makes it a binding rather than a guess.
    //
    // `intent.record` rather than a rebuilt `{path, config}`: the record also
    // carries `configVersion` and `configuredAt`, and rebuilding it from the
    // two fields this handler happens to have named would drop them — the
    // activation would then write a row whose version had silently reset,
    // which is exactly the compare-and-set-goes-backwards failure the field
    // exists to avoid.
    // THE SPAWNING PATH, and the one call that has a channel verdict to record:
    // `spawnSession` has just run the resolution, so `session.channelEnabled` is
    // the launcher's own output for the spawn this response is about (KAN-281).
    const durable = this.rememberActivated(
      intent.record,
      callerIdentity(data),
      session.channelEnabled
    );

    this.deps.broadcast({
      action: 'agent.activated',
      path: agentPath,
      paneName,
      paneId: confirmed.paneId,
      sessionId: session.sessionId,
      status: session.status,
      configVersion: intent.configVersion,
      // The spawn path's durability answer. `verified: true` on the response
      // below answers "does this agent exist"; this answers "will a restart know
      // it does", and they are different questions that a single event asserting
      // both by implication used to conflate.
      ...durability(durable)
    });

    respond({
      action: 'activate_response',
      success: true,
      path: agentPath,
      paneName,
      // The other half of the contract stated above: every successful
      // activation says which of the two things happened. `false` here means
      // this call is the one that started the agent.
      alreadyRunning: false,
      started: true,
      paneId: confirmed.paneId,
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      priority: config.priority,
      launcher: config.launcher,
      // The whole record, on the response that started it. A caller that
      // activates and then reads back should find the same values, and saying
      // them here is what lets it check that without a second call.
      //
      // RE-READ AFTER `rememberActivated`, for the reason spelled out on the
      // already-running branch: this is a durable field, so it is answered from
      // the durable record as it stands once this call's write has landed. If
      // that write failed, this correctly still reads `false` — and `durable:
      // false` below says why, which is better than a `true` nothing backs.
      ...configEcho(this.deps.agentRegistry.intents().get(agentPath), 'whole'),
      // THE CONSTRAINT THE REQUESTING CONSUMER CALLED LOAD-BEARING (KAN-281):
      // the channel verdict at the MOMENT OF THE SPAWN, not only on a later
      // poll — "by the time we polled we could be looking at a different spawn."
      // This is that moment.
      //
      // RE-READ FROM THE RECORD, exactly like the echo above it and for the same
      // reason, rather than echoed back from `session.channelEnabled`. The
      // session is where the value came from; the record is what a later
      // `agent_status` will answer from, so reading it here is what makes the
      // two surfaces agree BY CONSTRUCTION rather than by both being handed the
      // same variable. If the durable write failed, this reads what the disk
      // actually holds — and `durable: false` below says why — instead of
      // reporting a decision no later call will be able to confirm.
      channelEnabled: channelEnabledOf(this.deps.agentRegistry.intents().get(agentPath)),
      // Not decoration: it is the difference between this response and the
      // KAN-23 (in the extraction source) false success. `true` means the
      // agent was found in herdr's census before this was sent, and success is
      // never reported without it.
      verified: true,
      // Present only when the registry write FAILED: the agent is running and
      // verified, but a daemon restart will not know to restore it. `verified`
      // answers "does it exist"; this answers "will it survive".
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error }),
      // Only present on a restore. `false` means the agent came up with the
      // degraded-resume prompt and is already working; `true` means it was
      // handed its old conversation and is sitting at an empty prompt, which
      // is the case that needs a nudge.
      ...(session.resume
        ? { resume: session.resume, resumedConversation: session.resumedConversation }
        : {}),
      // THE RESUME RULE, reported rather than merely obeyed. `false` says in
      // the response that this agent started a NEW session and did not
      // continue whatever conversation the directory holds — which at a
      // caller-owned path is the difference between an agent starting work and
      // an agent reading a human's private session.
      resumedExistingConversation: session.mayResume === true,
      // EVERY ARTIFACT THIS ACTIVATION WROTE OR RELIED ON outside CrabCast's
      // own data directory: what, where, whether it was ours, and how to undo
      // it. Silence is what made writing into somebody's repository
      // unacceptable; the fix is not to stop writing, it is to stop being
      // silent. Empty for an agent that opted into nothing.
      provisioned: session.provisioned ?? [],
      // What this activation cost somebody else. Reported to the caller as
      // well as broadcast, so a client that started an agent by preemption
      // learns whose work it interrupted from the same response.
      ...(gate?.preempted ? { preempted: gate.preempted } : {}),
      ...(gate?.overrode
        ? { capacityOverride: { ...gate.overrode, capacity: capacityDto(gate.capacity) } }
        : {})
    });
  }

  // ------------------------------------------------------------- deactivate

  /**
   * The session-addressed stand-down. Kept for the one caller that holds a
   * session id and nothing else; every human-facing path uses the
   * path-addressed form below, which is a strict superset.
   *
   * It answers on the same `deactivate_response` shape, so it carries
   * `wasRunning` too. A caller cannot be expected to know which of two
   * addressing forms produced the message in front of it, and a contract that
   * holds for one of them is not a contract. `state` is only claimed when
   * there is a record for the agent to be in a state ON: a session with no
   * record behind it is stood down, but calling that "standby" would name a
   * durable resting place that does not exist.
   */
  private handleDeactivateSession(data: any, respond: Respond) {
    if (!data.sessionId) {
      respond({
        action: 'deactivate_response',
        success: false,
        error: 'Missing sessionId'
      });
      return;
    }

    // Read before the teardown: terminateSession marks the session terminated,
    // after which getSession still answers but the address is what we need and
    // it does not change.
    const session = this.deps.herdrBridge.getSession(data.sessionId);
    const { success, error } = this.deps.herdrBridge.terminateSession(data.sessionId);

    // Recorded only after a confirmed teardown, and only for an agent we hold
    // a record for. A stand-down that did not take, written down as if it had,
    // is a durable lie with three faces: the agent leaves `expected()` (a
    // reboot will not restore it), it can be reported stood-down while
    // running, and — on the preempt path — it reads as owed work that was
    // never actually interrupted.
    const intent = session ? this.deps.agentRegistry.intents().get(session.path) : undefined;
    const durable =
      success && intent ? this.rememberDeactivated(intent.record) : undefined;

    if (success && session) {
      this.deps.broadcast({
        action: 'agent.deactivated',
        path: session.path,
        paneName: session.paneName,
        sessionId: session.sessionId,
        // Session-addressed stand-downs are never the preempt path — that one
        // goes through `handleDeactivateAgent` by path, because a preemption
        // has to work on an agent that outlived the daemon holding its session.
        reason: 'requested',
        // THE ONE SITE THAT CAN REACH `durability` WITHOUT AN OUTCOME, and the
        // case is real rather than defensive: a session we hold whose path has
        // no registry record. Nothing was written because there is nothing to
        // write against, and a registry with no row for this path will not
        // restore it — so the record agrees with the event, which is what
        // `durable` says. See `durability` for the rule stated once.
        ...durability(durable)
      });
    }

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId,
      ...(session ? { path: session.path, paneName: session.paneName } : {}),
      // A session we held and tore down was, by definition, running. The
      // failure case claims neither: an unconfirmed teardown is exactly the
      // case where we do not know.
      ...(success ? { wasRunning: true, ...(intent ? { state: 'standby' } : {}) } : {}),
      ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
      ...(error ? { error } : {})
    });
  }

  /**
   * `deactivate(path)` — stop the agent, keep the record.
   *
   * NEVER A BARE SUCCESS. A caller polling for "is it down" and a caller who
   * mistyped a path deserve different answers, so every success carries
   * `wasRunning` and a `state`:
   *
   *   - `unstarted` — configured, never activated. Nothing to stop, and
   *     nothing is recorded: writing a stand-down here would move the agent
   *     into the standby list, which promises that switching it back on
   *     resumes the conversation it was stopped in. It has no conversation.
   *   - `standby`   — it ran and it is down now.
   *
   * A path with NO record refuses, where `forget` on the same path succeeds.
   * See {@link handleForget} for the rule that decides the asymmetry.
   *
   * SAFE TO CALL AGAIN — A CONTRACT, the mirror of {@link handleActivate}'s.
   * Standing down something already down is not an error and not a failure;
   * it is a supervisor finding the world already as it asked. The second call
   * answers `success: true, wasRunning: false`, writes no second stand-down
   * row (a repeated row would say a decision was taken twice) and broadcasts
   * no second event.
   *
   * `wasRunning` is on EVERY successful response, and `state` distinguishes
   * the two ways of not running rather than flattening them. That distinction
   * is the whole reason this is not a bare success: `unstarted` is an agent
   * with no conversation to come back to, `standby` is one with a conversation
   * waiting, and switching them back on means different things.
   */
  public handleDeactivateAgent(data: any, respond: Respond) {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'deactivate_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    // Set by the capacity gate's preempt path, never invented here: it is the
    // record of why this stand-down was not the agent's own idea.
    const preemption: PreemptionRecord | undefined = data.preemption;

    const intent = this.deps.agentRegistry.intents().get(agentPath);
    if (!intent) {
      fail(
        `No agent is configured at ${agentPath}, so there is nothing to stand down. ` +
          `Reporting a stand-down for a path that never held an agent would be success ` +
          `about a world that does not exist. (\`forget\` on this path succeeds — its ` +
          `postcondition is the absence of a record, and that already holds.)`,
        { path: agentPath, refused: 'not-configured' }
      );
      return;
    }

    const session = this.deps.herdrBridge.getSessionByPath(agentPath);

    // ONE census read for this whole handler. The `unstarted` answer below
    // depends on it: a record whose last event is `configured` is not evidence
    // that nothing is running — a durable write that failed after an
    // activation leaves exactly that state over a live pane, and answering
    // "nothing was running" without looking is the claim-without-looking this
    // daemon refuses everywhere else.
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, intent.record.config.launcher
    );
    const oursIsLive = occupancy.reachable && occupancy.ours !== null;

    if (session) {
      const { success, error } = this.deps.herdrBridge.terminateSession(session.sessionId);

      // Recorded only after a confirmed teardown — the same rule as the
      // broadcast below, for a sharper reason: the preempt path ABORTS THE
      // WHOLE PREEMPTION when this teardown fails, and a durable record
      // written first would say the victim was preempted while it is alive and
      // working.
      const durable = success ? this.rememberDeactivated(intent.record, preemption) : undefined;

      // Not broadcast when the teardown could not be confirmed: the event is
      // what fleet clients act on, and announcing an agent deactivated while
      // it may still be running is the same false claim verified activation
      // exists to prevent, arriving as an event instead of as a response.
      if (success) {
        this.deps.broadcast({
          action: 'agent.deactivated',
          path: agentPath,
          paneName: session.paneName,
          sessionId: session.sessionId,
          ...deactivationCause(data, preemption),
          // ON THE PREEMPT PATH THIS IS THE FIELD THAT MATTERS MOST. A
          // preemption is a debt the machine owes the victim, and the record of
          // it is what a supervisor reads to decide whether to re-staff. A
          // stand-down written down nowhere is a debt nobody can find, and the
          // event that announced it used to look identical to one that was.
          ...durability(durable)
        });
      }

      respond({
        action: 'deactivate_response',
        success,
        path: agentPath,
        paneName: session.paneName,
        sessionId: session.sessionId,
        wasRunning: true,
        state: 'standby',
        ...(preemption ? { preempted: true } : {}),
        ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
        ...(error ? { error } : {})
      });
      return;
    }

    // Configured and never started — but only if the census agrees. When it
    // does not, the record is stale and the pane is what is real, so this
    // falls through to the close path below rather than reporting a state it
    // has not checked.
    //
    // `everActivated`, not the event alone. A `configured`-last row is not
    // proof of a never-run agent: reconfiguring a STOPPED agent writes one, and
    // that agent has a conversation on disk. Answering `unstarted` for it would
    // put the same word on two agents that behave differently on their next
    // activation — one starts fresh, one resumes — which is the distinction
    // this word exists to draw. Such a row falls through and is answered
    // `standby`, which is what it is.
    if (intent.event === 'configured' && !intent.everActivated && !oursIsLive) {
      respond({
        action: 'deactivate_response',
        success: true,
        path: agentPath,
        paneName: paneNameFor(agentPath),
        wasRunning: false,
        state: 'unstarted',
        ...(occupancy.reachable
          ? {}
          : {
              occupancyUnknown: true
            }),
        note:
          'This agent is configured but has never been activated. Nothing was running and ' +
          'nothing was recorded — a stand-down row would put it on the standby list, which ' +
          'promises that switching it back on resumes the conversation it was stopped in.' +
          (occupancy.reachable
            ? ' The census agrees: no pane of ours is live there.'
            : ' herdr did not answer, so this rests on the record alone — but the record has ' +
              'never carried an activation, so there is no activation for it to be stale about.')
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not.
    const result = this.deps.herdrBridge.closeAgentByPath(agentPath);

    // Standing down an agent that has already died is not a failure — it is
    // the request working. There was no pane to close, and the thing actually
    // being asked for ("stop expecting this agent back") is the registry write
    // below. Reporting `success: false` there tells a supervisor its
    // stand-down did not take, inviting it either to retry forever or to
    // conclude the agent is still owed a slot.
    //
    // Only when herdr *answered* though. An unreachable herdr also fails to
    // close the pane, and calling that "already gone" would report an agent
    // stood down while it is still running.
    // From the census this handler already took, rather than a second read:
    // two reads could disagree, and this one decides whether a stand-down is
    // recorded for an agent that might still be running.
    const goneAlready = !result.success && occupancy.reachable;

    // Already recorded as stood down AND provably not running: nothing
    // changed, so nothing is written. A second identical row would say a
    // decision was taken twice.
    const alreadyStandby = intent.event === 'deactivated' && goneAlready;

    const durable =
      (result.success || goneAlready) && !alreadyStandby
        ? this.rememberDeactivated(intent.record, preemption)
        : undefined;

    if ((result.success || goneAlready) && !alreadyStandby) {
      this.deps.broadcast({
        action: 'agent.deactivated',
        path: agentPath,
        paneName: result.paneName,
        ...deactivationCause(data, preemption),
        // The close path — no session of ours, the pane closed by name or
        // already gone. `durable` is computed under the same guard as the
        // broadcast (`(result.success || goneAlready) && !alreadyStandby`), so
        // it is never `undefined` here; the already-standby case writes nothing
        // AND broadcasts nothing, because nothing changed.
        ...durability(durable)
      });
    }

    respond({
      action: 'deactivate_response',
      path: agentPath,
      paneName: result.paneName,
      success: result.success || goneAlready,
      wasRunning: result.success,
      ...(result.success || goneAlready ? { state: 'standby' } : {}),
      ...(preemption ? { preempted: true } : {}),
      ...(goneAlready
        ? {
            alreadyGone: true,
            note: alreadyStandby
              ? 'No agent was running and its stand-down was already recorded. Nothing changed.'
              : 'No agent was running. Its stand-down is recorded, so it will not be restored.'
          }
        : {}),
      ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
      ...(result.error && !goneAlready ? { error: result.error } : {})
    });
  }

  // ------------------------------------------------------------------ reads

  /**
   * Type a message into a running agent's terminal AND REPORT WHETHER IT
   * LANDED. The delivery is asynchronous — an interrupt, a settle delay, the
   * text, a submit, and then a confirmation that watches the pane — so every
   * outcome, including a rejection we never expect, has to be turned back into
   * a response; the caller is blocked on one.
   *
   * THREE VERDICTS REACH THE CALLER, NOT TWO. `verdict` and `delivered` are on
   * EVERY response, both outcomes, so "did this land" is read rather than
   * inferred from a missing field — and `unverifiable` is a distinct answer
   * from `not-delivered` for the same reason `activate` refuses as
   * unverifiable rather than as occupied: a caller that cannot tell "it did not
   * arrive" from "I could not see" will eventually treat one as the other, and
   * the two license opposite actions. Resending on `not-delivered` is right;
   * resending on `unverifiable` types a duplicate at an agent that may already
   * be working on the first copy.
   *
   * `success` stays aligned with `delivered`, so the MCP `isError` mapping and
   * every existing `success`-only caller become strictly more honest without
   * being taught anything: a send that was merely typed no longer answers true.
   *
   * The bridge's evidence — the pane state the verdict was read from, the
   * before/after counts, whether the text was seen sitting in the composer, and
   * the Ctrl+C count — travels with it rather than being summarised away. A
   * verdict a caller cannot audit is a verdict they have to trust, which is
   * what the old `success: true` asked of them.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    /**
     * The request never became a send, so NO PANE WAS READ — and this must not
     * borrow the vocabulary of a verdict that was.
     *
     * `not-delivered` is defined as evidence: the pane was read and the message
     * is not in it. An unresolvable path and a blank message are neither that
     * nor `unverifiable` — nothing was attempted, so there is nothing to have
     * been uncertain about. Answering `not-delivered` here was true in outcome
     * and false in its stated basis, which is this epic's recurring defect in
     * miniature: a claim whose wording covers more than its mechanism.
     *
     * So it says `refused`, in the vocabulary `activate` already uses for a
     * call rejected before anything happened (`refused: 'not-configured'`,
     * `refused: 'unverifiable'`). `delivered: false` and `verdict` are still on
     * the response, both outcomes, because a caller must never have to infer
     * the outcome from a missing field — and the ABSENCE of an `evidence`
     * block is deliberately not the signal, since inference-from-absence is the
     * thing being refused. `refused` is the field to read.
     *
     * BOTH WORDS ARE TYPED RATHER THAN TYPED OUT (KAN-329). `refusedSend`
     * builds this beside the unions it draws on, so `verdict` and `refused` are
     * members of a published vocabulary at compile time instead of two string
     * literals at a `respond({…})` call — which is where `activateRefused` grew
     * to nine unchecked literals before KAN-287. Not a byte of the response
     * changed.
     */
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', ...refusedSend('invalid-request', error) });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const { message } = data;
    if (typeof message !== 'string' || !message.trim()) {
      fail('Missing or invalid message');
      return;
    }

    this.deps.herdrBridge.sendToAgent(address.path, message).then(
      (result) => respond({ action: 'send_to_agent_response', path: address.path, ...result }),
      // A rejection here is a bug in the bridge rather than a fact about the
      // agent, and the honest reading of "our own confirmation threw" is that
      // nothing was established either way.
      //
      // THIS BRANCH ANSWERS `unverifiable` WITH NO `evidence` BLOCK, unlike
      // every other `unverifiable` on this surface — the code that assembles
      // evidence is the code that just threw. `docs/send-contract.md` publishes
      // that asymmetry rather than this response acquiring a synthesised
      // evidence block nobody read a pane for.
      (err) =>
        respond({
          action: 'send_to_agent_response',
          path: address.path,
          ...unconfirmableSend(
            `The send could not be completed or confirmed: ${err?.message ?? String(err)}`
          )
        })
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private handleTailAgent(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'tail_agent_response', success: false, error });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const { lines } = data;
    if (lines !== undefined && (typeof lines !== 'number' || !Number.isFinite(lines))) {
      fail('Invalid lines: expected a number');
      return;
    }

    try {
      respond({
        action: 'tail_agent_response',
        path: address.path,
        ...this.deps.herdrBridge.tailAgent(address.path, lines)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  /**
   * Everything known about one agent, by path. A daemon restart empties the
   * session map while the herdr pane keeps running, so a missing session
   * degrades to herdr's own view (`sessionless: true`) rather than failing —
   * an agent that outlived its daemon is exactly the one a supervisor most
   * needs to inspect.
   *
   * IT SUCCEEDS FOR AN AGENT THAT IS NOT RUNNING, and that is a change worth
   * naming. It used to answer `success: false` whenever herdr had no pane —
   * true of every configured-and-stopped agent — with the record squeezed onto
   * the failure branch as two fields. For a caller diffing desired state
   * against ours that is the partial read this whole surface exists to remove:
   * `success: false` means "the read failed", so a stopped agent's
   * configuration was unreadable through the one verb that addresses ONE agent.
   *
   * The rule now: **a record is an answer.** `success` is about whether the
   * question could be answered, not about whether the agent is up — liveness is
   * what `state`, `sessionless` and `herdrStatus` are for. Only a path with
   * neither a record nor a pane is a failure, and only that one means the
   * caller mistyped.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    // THE SWEEP, over whatever this handler is about to answer with (KAN-168).
    //
    // WRAPPED RATHER THAN REPEATED AT EACH `respond`. This handler answers on
    // four branches — a bad address, no-record-and-no-pane, sessionless, and a
    // live session — and three of them carry the echo. Three copies of the
    // sweep would be three places for a fifth branch to be added without one,
    // which is the same shape of defect as the missing surface this call site
    // exists to close: `list_agents` was guarded, `agent_status` was not, and
    // nothing structural said so. Every answer leaves through here instead, so
    // a branch added later is swept the day it ships rather than the day
    // somebody remembers.
    //
    // ON THE FAILURE BRANCHES TOO, and that is deliberate. §2's rule is that
    // the block rides EVERY response so `undeclared: []` and "nobody looked"
    // stay distinguishable — a rule an absent block on a refusal would break
    // for exactly the response whose `extra` carries an echo (the
    // no-record-and-no-pane branch does).
    const respondSwept: Respond = (payload) => {
      const drift: ConfigEchoFinding[] = [];
      sweepConfigEchoes(payload, '', drift);
      this.warnOnEchoDrift(drift, 'agent_status');
      // `[]` BECAUSE THIS RESPONSE SUMMARISES NOTHING, and it says so rather
      // than staying silent: a single agent's config travels whole here,
      // prompt included, and this is the surface a consumer is sent to when
      // the fleet read tells them the text is elsewhere.
      respond({ ...payload, configEchoContract: configEchoContract(drift, []) });
    };

    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respondSwept({ action: 'agent_status_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      // KAN-382. `strict: false`, so `does-not-exist` never reaches here — the
      // lexical fallback takes it and this handler answers about the record. So
      // this branch publishes exactly the four causes that ARE refusals of a
      // read: `not-a-string`, `not-absolute`, `uninspectable`, `not-a-directory`.
      // The vocabulary is the same five on both surfaces; which of them a
      // surface can actually emit is a property of its `strict` flag, and §9
      // says so rather than publishing two lists that would drift.
      fail(address.error, { pathProblem: address.problem });
      return;
    }
    const agentPath = address.path;
    const intent = this.deps.agentRegistry.intents().get(agentPath);

    // ONE census read for this whole answer, and the same one the fleet list
    // uses — `state` here and the category there must be derived from the same
    // evidence or the two reads can disagree about the same agent.
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    // THE single ownership test, asked here exactly as the fleet list asks it.
    // With no record there is no launcher to judge by, and `ourPaneIn` then
    // takes the strict reading (a runtime is required), which is the safe one:
    // a bare pane nobody configured is not an agent.
    const ours = ourPaneIn(census, agentPath, intent?.record.config.launcher);
    const state = this.stateOf(intent, ours !== null, census.reachable);

    const session = this.deps.herdrBridge.getSessionByPath(agentPath);
    // The record, and only the record. `ours` decides `state` — an observed
    // field — and must not reach the echo: that mixing is what made a durable
    // field change with the census.
    const echo = configEcho(intent, 'whole');

    if (session) {
      // From the census this handler already took, rather than a second read.
      // Two reads of herdr can disagree, and `state` above and `herdrStatus`
      // here would then be two answers about the same pane at two moments —
      // which is exactly the ambiguity a caller diffing against us cannot
      // resolve. It also drops a subprocess from every status call.
      const pane = census.agents.find((a) => a.name === session.paneName);
      respondSwept({
        action: 'agent_status_response',
        success: true,
        sessionless: false,
        path: agentPath,
        paneName: session.paneName,
        paneId: pane?.paneId ?? null,
        sessionId: session.sessionId,
        createdAt: session.createdAt.toISOString(),
        status: session.status,
        herdrStatus: pane?.herdrStatus ?? 'unknown',
        label: intent?.record.config.label ?? null,
        configured: Boolean(intent),
        state,
        ...echo,
        // KAN-281. From the RECORD, not from `session` — this handler is holding
        // a live session and could read `session.channelEnabled` off it, and
        // that is the trap. A session obtained by `attachSession` carries no
        // verdict, so the live branch is exactly where a session-sourced answer
        // would look most authoritative and be least reliable.
        channelEnabled: channelEnabledOf(intent),
        provenance: stateReadProvenance(census)
      });
      return;
    }

    // No session of ours. herdr may still have the pane — every agent that
    // outlived a daemon restart is in exactly this state — so the census is
    // consulted for it, and answers with nothing when there is nothing.
    //
    // FROM THE CENSUS RATHER THAN A SECOND `agent get`, which is what this used
    // to do. The census is the read the fleet list uses, so a status and a list
    // taken together now describe one moment rather than two, and this handler
    // makes exactly one herdr call whatever branch it takes.
    const paneName = paneNameFor(agentPath);
    const pane = census.agents.find((a) => a.name === paneName) ?? null;

    if (!intent && !pane) {
      // Neither a record nor a pane. This is the one answer that means the
      // caller is asking about something that does not exist — and it is said
      // differently when herdr could not be asked, because "there is no such
      // agent" and "I could not look" are not the same answer.
      fail(
        census.reachable
          ? `No agent is configured at '${agentPath}' and herdr has no pane named ` +
            `'${paneName}'. Nothing here has ever been an agent.`
          : `No agent is configured at '${agentPath}', and herdr did not answer, so whether ` +
            `a pane is running there could not be checked. An empty census from an ` +
            `unreachable herdr is silence, not evidence.`,
        {
          path: agentPath,
          paneName,
          configured: false,
          state: 'unconfigured' as AgentState,
          ...echo,
          // Always `null` on this branch — it is reached only when there is no
          // record — and stated rather than omitted for the reason the branch
          // itself exists: a refusal that answered nothing about where it looked
          // would be indistinguishable from a daemon that did not look.
          channelEnabled: channelEnabledOf(intent),
          provenance: stateReadProvenance(census)
        }
      );
      return;
    }

    respondSwept({
      action: 'agent_status_response',
      success: true,
      sessionless: true,
      path: agentPath,
      paneName,
      paneId: pane?.paneId ?? null,
      sessionId: null,
      createdAt: null,
      status: null,
      workDir: pane?.workDir ?? null,
      herdrStatus: pane?.herdrStatus ?? 'unknown',
      label: intent?.record.config.label ?? null,
      configured: Boolean(intent),
      state,
      ...echo,
      // THE BRANCH THIS FIELD'S DURABILITY WAS CHOSEN FOR (KAN-281). Every agent
      // that outlived a daemon restart answers here, with no session of ours to
      // ask — so a `remembered` field would be `null` for the whole surviving
      // fleet, and a session-sourced one would be absent. Read from the log, it
      // is the same value the spawn recorded, which is what makes `agent_status`
      // and `activate_response` agree for the same agent across a restart.
      channelEnabled: channelEnabledOf(intent),
      provenance: stateReadProvenance(census)
    });
  }

  /**
   * Which category an agent is in — the ONE derivation, shared by the
   * single-agent read and the fleet list.
   *
   * Two derivations of the same question could disagree, and a caller that saw
   * a row in `standbyAgents` and a `state` of `unstarted` for the same path
   * would have no way to decide which to believe. So there is one, and the
   * verify script asserts the two surfaces agree for every state.
   */
  private stateOf(
    intent: AgentIntent | undefined,
    live: boolean,
    /**
     * Whether the census that decided `live` actually answered. Defaults to
     * true for the callers that only ever ask about a pane they can already
     * see — a row in `agents` is live by having been found.
     */
    censusReachable = true
  ): AgentState {
    if (live) return 'running';
    if (!intent) return 'unconfigured';

    // AN UNREACHABLE herdr DOES NOT MAKE AN AGENT MISSING. Every category
    // below except one is a claim that the agent is NOT running, and the only
    // thing that can support that claim is a census that answered. Reporting
    // `missing` off an empty census from a herdr that never replied is the
    // check rendering its own failure as a finding — and this one would reach a
    // reconciler as "the agent you are supervising has died".
    //
    // The exception is the same one `deactivate` already draws: a record that
    // has NEVER carried an activation has no activation for the census to be
    // stale about, so `unstarted` stands without one.
    if (!censusReachable && intent.everActivated) return 'unknown';

    if (intent.event === 'activated') return 'missing';
    if (intent.event === 'deactivated' && (intent.preemption || intent.wasPreempted)) {
      return 'preempted';
    }
    // Not the event: an agent that ran, stopped and was then reconfigured has
    // `configured` as its last event and a conversation on disk. See
    // {@link UnstartedAgent}.
    return intent.everActivated ? 'standby' : 'unstarted';
  }


  /**
   * Everything running, from herdr's view joined against the durable registry.
   *
   * The session map is emptied by a daemon restart while the herdr panes keep
   * running, so a list built from sessions alone answers "nothing is running"
   * for a machine full of working agents — and that is the reading a
   * supervisor acts on. herdr is therefore the source of existence here;
   * sessions only add what herdr cannot know (session id, creation time).
   *
   * WHAT COUNTS AS OURS is the part that changed. It used to be a pane name
   * starting with `crabcast-` that parsed back into a type and key — a
   * convention masquerading as a filter. It is now: a pane whose canonical
   * `cwd` is a path this registry holds a record for, AND whose name is the
   * one that path derives. Both halves are needed. The cwd join is what makes
   * the registry authoritative; the name check is what keeps a stranger's pane
   * sitting in one of our directories from being reported as our agent — it is
   * reported as a foreign pane occupying that path, which is exactly what a
   * reader needs to see.
   */
  private handleListAgents(data: any, respond: Respond) {
    // THE SWEEP, WRAPPED RATHER THAN REPEATED, exactly as `handleAgentStatus`
    // wraps its own (KAN-279). Every answer this method gives leaves through
    // here, so a refusal path added later is swept the day it ships rather than
    // the day somebody remembers.
    //
    // ON THE REFUSALS TOO, AND THAT IS THE POINT OF THIS TICKET. Until KAN-279
    // the two refusals below answered `respond` directly and returned before
    // the sweep, so a refused fleet read carried three fields and no block
    // where a refused single-agent read carried one. The justification on
    // record for that — a refusal carries no echo, so there is nothing for the
    // block to be about — is true of `agent_status`'s `no-record-no-pane`
    // branch and FALSE of its `bad-address` branch, which resolves nothing,
    // carries no echo, and carries the block anyway. The two surfaces were
    // answering the identical situation two different ways, and the thing that
    // differed was a wrapped responder against a bare `respond` rather than any
    // decision anybody took. §2 of `docs/event-contract.md` states the rule the
    // broad way — the block rides EVERY response, so `undeclared: []` and
    // "nobody looked" stay distinguishable — and this is what makes that
    // sentence true of both surfaces instead of one and a half.
    // `echoDrift` RATHER THAN `drift`, AND THE NAME IS LOAD-BEARING.
    // `verify-config-echo-contract.mjs`'s `no-sweep` and `quiet` mutations
    // address this handler's sweep and its warning by exact source text, and
    // `handleAgentStatus` deliberately names its own accumulator differently so
    // that each handler's sweep is addressable on its own. Rename either to
    // match the other and both mutations become ambiguous — they then find two
    // occurrences or none, and that proof reports MUTATION DID NOT APPLY rather
    // than a pass.
    //
    // FOR THE SAME REASON THIS COMMENT DESCRIBES THOSE ANCHORS AND DOES NOT
    // QUOTE THEM. Comments survive into `dist/router.js`, so a comment
    // reproducing an anchor verbatim is itself a second occurrence of it — which
    // is exactly how this paragraph earned its place: the first draft quoted
    // both strings and took the mutation count from 1 to 2.
    const respondSwept: Respond = (payload) => {
      const echoDrift: ConfigEchoFinding[] = [];
      sweepConfigEchoes(payload, '', echoDrift);
      this.warnOnEchoDrift(echoDrift, 'list_agents');
      // THE FLEET READ DECLARES WHAT IT SUMMARISED. Every row above carries a
      // `promptChars` instead of a `config.prompt`, and this is the only field
      // on the wire that says so — without it a consumer would have to infer
      // the omission from a missing key that already meant something else.
      respond({
        ...payload,
        configEchoContract: configEchoContract(echoDrift, FLEET_SUMMARISED_KNOBS)
      });
    };

    // What the caller asked to page, before anything expensive happens. A
    // misspelled category or an impossible limit is answered as a refusal
    // rather than as a default page — see readFleetPageRequests.
    const requested = readFleetPageRequests(data?.pages);
    if ('error' in requested) {
      respondSwept({ action: 'list_agents_response', success: false, error: requested.error });
      return;
    }

    // WHOSE AGENTS THIS CALLER IS ASKING ABOUT, before anything expensive
    // happens and before any row is built — for the same reason the page
    // request is read here. An `owner` that cannot be honoured is answered as a
    // refusal rather than as an unfiltered read: see `readOwnerFilter`, where
    // the null case is the one that matters.
    const ownerRequest = readOwnerFilter(data?.owner);
    if ('error' in ownerRequest) {
      respondSwept({ action: 'list_agents_response', success: false, error: ownerRequest.error });
      return;
    }
    const ownerFilter = ownerRequest.owner;

    /**
     * One category's rows, narrowed to the owner asked for.
     *
     * APPLIED BEFORE `pageFleetCategory` AND NOT AFTER, which is the whole of
     * how paging stays correct under a filter. The pager computes `total`,
     * `remaining` and `nextCursor` from the array it is handed, so handing it
     * the filtered set makes every one of those numbers describe the filtered
     * category by construction. Filtering a PAGE instead would leave `total`
     * counting rows the caller cannot see and `nextCursor` walking a sequence
     * that thins unpredictably — 25 rows in, 3 rows out, and a consumer told to
     * follow the cursor until null with no way to know how far it has got.
     */
    const narrow = <T extends ConfigEcho>(rows: T[]): T[] =>
      ownerFilter === null ? rows : rows.filter((row) => ownedBy(row, ownerFilter));

    // One read of the registry for the whole response. Several of the fields
    // below are derived from it, and asking it repeatedly was both several
    // whole-file parses per poll and several chances for an append landing
    // mid-response to make the categories contradict each other.
    // ONE read, TWO answers (KAN-302): the rows this daemon could load, and the
    // rows it could not. Taken from the same parse rather than two, so the
    // disclosure below cannot describe a different revision of the file from
    // the agent rows beside it.
    const { entries, unreadable } = this.deps.agentRegistry.read();
    const intents = AgentRegistry.intentsFrom(entries);

    const { agents, unbackedPanes, foreignPanes, staleSessions, census } =
      this.surveyAgents(intents);

    // THE FIVE PAGED CATEGORIES, each with the field it is ordered by and the
    // field that makes that order total. Every one of these used to be a
    // silent `slice(0, 25)`; the cursor is what a consumer follows to reach
    // the rest, and `path` (or `paneName`, for a pane that is not ours and has
    // no path of ours) is what keeps two rows sharing a millisecond from
    // hiding each other across a page boundary.
    const paged: Record<PagedFleetCategory, { rows: any[]; page: FleetPageDto }> = {} as any;
    for (const [category, rows, when, key] of [
      // Agents that should be here and are not. Computed from the same census
      // the list is built from, so the two can never disagree about what is
      // running.
      //
      // NEWEST-FIRST HERE IS A DECISION, NOT AN INHERITANCE (KAN-96), AND THE
      // QUESTION UNDER IT IS SETTLED (KAN-189). The argument against it was:
      // newest-first says "the oldest rows are the least urgent", which is
      // right for standby — the thing you just switched off is the thing you
      // want back — and backwards for a loss, because an agent nobody has
      // restored in three days is the MOST neglected, not the least.
      //
      // It is a good argument about a field this row does not have. `since` is
      // when the agent was last recorded ACTIVATED, not when it went missing
      // (see {@link MissingAgent.since}); nothing durable records the second,
      // and the daemon's latch is a Set of paths with no time on it that a
      // restart forgets. So sorting this category the other way would not rank
      // by neglect. It would rank by "activated longest ago" — which puts the
      // fleet's longest-lived agents first and reads as a claim about
      // down-time that the data cannot support. Trading a default that is
      // merely arbitrary about urgency for one that is WRONG about it is not
      // an improvement.
      //
      // What made the old ordering harmful was reachability, and that is gone:
      // the cap is a page size now, so the rows past it are reachable by
      // walking `nextCursor` rather than lost (KAN-163). Meanwhile one order
      // across all five categories is one cursor contract, and a per-category
      // direction is a second thing every consumer of `pages.*` would have to
      // know.
      //
      // AND THE FIELD THAT WOULD HAVE REOPENED THIS IS NOT COMING. Ranking by
      // neglect needs a durable first-observed-missing timestamp; KAN-189
      // asked whether to record one and answered NO, for reasons written out
      // on {@link MissingAgent.since} — beside the field they are about rather
      // than here, because that is where a reader meets the problem. So this
      // is a closed question and not a placeholder: reopening it means
      // answering those four grounds, and `verify-agent-power-controls.mjs`
      // §15 goes red on a build that quietly flips the order or grows the row
      // a second timestamp.
      ['missingAgents', narrow(this.missingAgents(agents, foreignPanes, staleSessions, intents)),
        (r: any) => r.since, (r: any) => r.path],
      // Work taken off the machine to make room, still owed a decision.
      ['preemptedAgents', narrow(this.preemptedAgents(agents, intents)),
        (r: any) => r.at, (r: any) => r.path],
      // Agents a person switched off. From the same census for the same
      // reason: an agent that is running must never be offered an On button.
      ['standbyAgents', narrow(this.standbyAgents(agents, intents)),
        (r: any) => r.since, (r: any) => r.path],
      // Agents that exist and have never run. Same census, same reason: an
      // agent that is running must never be offered as one that has yet to
      // start.
      ['unstartedAgents', narrow(this.unstartedAgents(agents, intents)),
        (r: any) => r.since, (r: any) => r.path],
      // NOT NARROWED, and deliberately: a foreign pane is not our agent and has
      // no owner to be asked about. See OWNER_FILTERED_CATEGORIES, and
      // `ownerFilter.unfiltered` on the response, which says so to the caller.
      ['foreignPanes', foreignPanes,
        (r: any) => r.paneName, (r: any) => r.paneName]
    ] as Array<[PagedFleetCategory, any[], (r: any) => string, (r: any) => string]>) {
      const result = pageFleetCategory(rows, when, key, requested.pages[category], category);
      if ('error' in result) {
        respondSwept({ action: 'list_agents_response', success: false, error: result.error });
        return;
      }
      paged[category] = result;
    }

    const missing = paged.missingAgents;
    const preempted = paged.preemptedAgents;
    const standby = paged.standbyAgents.rows;
    const unstarted = paged.unstartedAgents.rows;
    const foreign = paged.foreignPanes;

    // Descriptor headroom, reported where someone looking at agents will see
    // it. Expressed in panes because that is the unit the reader can act on.
    const usage = readFdUsage();

    // CPU and memory headroom, for the same reason and in the same place.
    //
    // `agents` AND NEVER `narrow(agents)`, which is worth a line because the
    // narrowed list is in scope right here and reads like the tidier argument.
    // The gate counts AGENTS ON THIS MACHINE; an owner is a fact about who
    // asked, not about the machine, and a cap that moved with the caller's
    // filter would mean two callers reading two different headrooms off the
    // same fleet. The moment `owner` reaches this line it has stopped being
    // metadata and become policy — a different ticket (KAN-193 decision 6).
    const capacity = this.capacityOf(agents);

    // THE CATEGORIES, AS ONE TYPED VALUE. Spread into the response rather than
    // listed inline, so `FleetCategories` is what the payload's row-carrying
    // keys are built from — and `FleetCategoriesCarryTheEcho` then holds every
    // one of them to `ConfigEcho[]` at compile time. Adding a category to this
    // object without adding it to the interface is a build error; adding one
    // straight to `respond` below is not, and §3 of verify-activated-by.mjs is
    // what covers that. Both are stated on `FleetCategories`.
    const categories: FleetCategories = {
      // NARROWED HERE RATHER THAN AT THE PAGER, because `agents` is never
      // paged: it is built from the herdr census, bounded by what is running,
      // and complete in every response. The filter still applies — a fleet read
      // that narrowed the four not-running categories and returned everybody's
      // RUNNING agents would be the worst of the available answers, since the
      // running ones are what a reconciler acts on.
      agents: narrow(agents),
      // NOT NARROWED: our panes with nothing behind them. No record, so no
      // owner. See OWNER_FILTERED_CATEGORIES.
      unbackedPanes,
      missingAgents: missing.rows,
      preemptedAgents: preempted.rows,
      standbyAgents: standby,
      unstartedAgents: unstarted
    };

    const payload = {
      action: 'list_agents_response',
      success: true,
      ...categories,
      // Live panes that are not ours. The rows whose `occupies` is non-null
      // are the ones that will refuse an activation, so a reader can see the
      // refusal coming rather than meeting it.
      foreignPanes: foreign.rows,
      foreignPanesTotal: foreign.page.total,
      // `missingAgents` is in `categories` above. Always present, even when
      // empty: a caller that has to distinguish "no agents are missing" from
      // "this daemon does not track that" cannot do it from an absent field.
      // Empty array means the fleet is whole.
      missingTotal: missing.page.total,
      // Work that was taken off the machine to make room for something more
      // important, and has not been put back. It is a queue of decisions still
      // owed rather than a log of events: the moment one of these is
      // re-activated it leaves the list. Nothing here restarts them,
      // deliberately — a preemption queue that restarts its own entries is a
      // scheduler, and preemption must never be automatic.
      preemptedTotal: preempted.page.total,
      // `standbyAgents` is in `categories` above — where a fleet client's On
      // button gets its candidates.
      standbyTotal: paged.standbyAgents.page.total,
      // ROWS IN THE DURABLE REGISTRY THAT THIS DAEMON COULD NOT READ (KAN-302),
      // and the reason this is on the fleet read rather than only in a log.
      //
      // These rows are not agents and are deliberately not a sixth category:
      // nothing here has a `config` to echo, a pane, a status or a path that
      // can be acted on, and putting them among the agent categories would
      // make `FleetCategories`' echo contract a lie. What they are is a fact
      // ABOUT the fleet — "the registry claims something here and I cannot
      // read it" — which is precisely the claim `agents`, `standbyAgents` and
      // the rest cannot carry, because each of them is a list of things that
      // WERE read.
      //
      // WHY A RESPONSE FIELD IS THE REQUIREMENT AND A LOG LINE IS NOT. The
      // specimen that commissioned this was found by hand, by an operator who
      // went looking in `~/.local/share/crabcast/` while writing something
      // else. Every fleet surface was green, because a surface built only from
      // rows that parsed cannot report a row that did not. An unreadable
      // record has to be reachable by the same poll that reads everything else
      // or it is reachable by nobody.
      //
      // Present-and-empty rather than absent, for the reason `missingAgents`
      // is: a caller distinguishing "this registry is wholly readable" from
      // "this daemon does not track that" cannot do it from a missing key.
      unreadableRecords: unreadable.slice(0, UNREADABLE_DISCLOSURE_LIMIT),
      // How many there are, whatever this response carried. NOT paged, and the
      // asymmetry with the five paged categories is deliberate: paging exists
      // because an agent list grows with the fleet and a consumer needs to walk
      // it, whereas this list is bounded by how badly one file has been
      // hand-edited and is a fault report rather than an inventory. A registry
      // with more unreadable rows than fit here has one problem, not twenty-six
      // — the count says so, and the full set is spelled out in `daemon.log`.
      unreadableRecordsTotalRENAMED: unreadable.length,
      // Agents that exist and have NEVER run — the fifth answer to "not
      // running", and the one that used to belong to no list at all. Kept
      // separate from standby because the difference is behavioural: switching
      // a standby agent on resumes the conversation it was stopped in, and
      // these have no conversation to resume. Always present, even when empty,
      // for the same reason `missingAgents` is.
      unstartedTotal: paged.unstartedAgents.page.total,
      // THE HANDLE PAST THE CLIP, one entry per paged category (KAN-163).
      //
      // Every `*Total` above says how many rows a category has; none of them
      // ever said how to reach the ones this response did not carry, and
      // `docs/event-contract.md` §2 tells a consumer that polling `list` is
      // what makes them CORRECT. `nextCursor` is what closes that: pass it
      // back as `pages.<category>.after` and keep going until it is null.
      //
      // It sits on every response rather than only on a truncated one, so a
      // consumer that checks it is doing the ordinary thing rather than
      // handling an exception — the categories that fit in one page answer
      // null, which is the same "you have everything" they would answer at
      // the end of a walk.
      pages: Object.fromEntries(
        PAGED_FLEET_CATEGORIES.map((category) => [category, paged[category].page])
      ),
      // THE RESYNC HANDLE, on the authoritative read rather than only on the
      // events. This is what closes the event contract's resync path: a
      // subscriber that reconnects has no event to compare `bootId` against —
      // it has whatever arrives next, which may be nothing for an hour — so
      // the poll it is REQUIRED to make anyway is where "am I talking to the
      // same daemon" gets answered, in the same round trip that gives it the
      // whole fleet. `eventSeq` is the highest sequence number stamped so far,
      // so a subscriber can also tell whether it has missed anything since its
      // last event without waiting for the next one.
      //
      // `startedAt` rides along, and this is the response it was added for
      // (KAN-214): the `statusSince` nulls below are on THESE rows, and this is
      // the field that says whether this daemon has been running long enough
      // for a null to mean anything.
      ...eventWatermark(this.deps.daemonStartedAt),
      // WHAT THE FILTER DID, AND WHAT IT DID NOT TOUCH (KAN-193). Present only
      // when a filter was asked for, so an ordinary read is byte-identical to
      // what it was before this field existed and "unfiltered" is read off the
      // shape rather than off a sentinel.
      //
      // IT IS ON THE RESPONSE BECAUSE A FILTERED ANSWER LOOKS COMPLETE. Every
      // `*Total` beside it now counts the filtered set, which is what makes
      // paging correct — and it means a caller cannot tell from the numbers
      // alone that four of the six row-carrying arrays were narrowed and two
      // were not. This block is the only thing on the wire that says which.
      ...(ownerFilter !== null ? {
        ownerFilter: {
          owner: ownerFilter,
          filtered: [...OWNER_FILTERED_CATEGORIES],
          unfiltered: [...OWNER_UNFILTERED_ROWS],
          note: OWNER_FILTER_NOTE
        } satisfies OwnerFilterDto
      } : {}),
      // Which fields above are durable, which were observed just now, and
      // which this daemon computed. See MessageRouter.provenance.
      provenance: stateReadProvenance(census),
      capacity: capacityDto(capacity),
      // What each running agent is worth, and therefore what a would-be
      // activation would have to outrank. "There is no room" and "there is no
      // room *for you*" are different answers, and a supervisor deciding
      // whether to staff something needs both.
      priorities: this.preemptionCandidates(agents, undefined, intents).map((c) => ({
        path: c.path,
        paneName: c.paneName,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      ...(usage ? {
        herdrHealth: {
          pid: usage.pid,
          openFds: usage.openFds,
          softLimit: usage.softLimit,
          headroomPanes: usage.headroomPanes,
          fdPressure: Math.round(usage.ratio * 100) / 100,
          ...(isFdPressureHigh(usage) ? {
            warning:
              `herdr server is using ${Math.round(usage.ratio * 100)}% of its open-file soft limit ` +
              `(${usage.openFds}/${usage.softLimit}); room for about ${usage.headroomPanes} more panes ` +
              `at ${PTMX_FDS_PER_PANE} descriptors each. Close idle agents.`
          } : {})
        }
      } : {})
    };

    // THROUGH THE SAME WRAPPER THE REFUSALS USE, over the payload that is about
    // to go out rather than over the categories this method knows it built. See
    // `configEchoContract` for why the poll path reports and does not drop, and
    // `sweepConfigEchoes` for why it walks the response. This used to be a
    // second, inline copy of the sweep; one copy is what makes "every answer is
    // swept" a property of the method rather than of three call sites that
    // happen to agree today.
    respondSwept(payload);
  }

  /**
   * Say out loud, on OUR side, that an echo is carrying something nobody
   * declared — the same complaint the MCP forwarder makes about an event.
   *
   * ONCE PER DISTINCT FIELD PER BOOT, and the dedupe is on the field rather
   * than on the path for a reason worth stating: `list_agents` is polled
   * continuously by design (§2 of the contract makes it a correctness
   * requirement), so a per-response warning about a defect that persists until
   * somebody fixes it would be a log flood, and a per-path one would repeat
   * every time the same knob appeared on another row or the fleet reordered.
   * One line per undeclared knob per daemon boot is a bug report; the response
   * itself is what reports it on every poll.
   *
   * AND THE DEDUPE IS SHARED ACROSS SURFACES, which is why `surface` names
   * where the field was FIRST seen rather than keying the set (KAN-168). The
   * defect is a knob on the record that nobody declared, and the record is one
   * object: `list_agents` and `agent_status` echo it from the same
   * {@link configEcho}, so a per-surface key would report one defect twice and
   * a reader would go looking for two. What the fix is — declare it or stop
   * writing it — is identical whichever verb happened to observe it, and the
   * RESPONSE is what tells a caller about the surface in front of it.
   */
  private warnOnEchoDrift(found: readonly ConfigEchoFinding[], surface: string): void {
    const fresh = [...new Set(found.map((f) => f.field))]
      .filter((field) => !this.warnedEchoDrift.has(field));
    if (!fresh.length) return;
    for (const field of fresh) this.warnedEchoDrift.add(field);
    console.error(
      `[MessageRouter] ${surface} echoed undeclared config field(s) ${fresh.join(', ')}; ` +
      `REPORTED on the response as configEchoContract.undeclared and still delivered — the read ` +
      `paths do not drop (docs/event-contract.md §2). The MCP event path DROPS the same field. ` +
      `Declare it in CONFIG_FIELDS in src/events.ts or stop putting it on the record. ` +
      `Said once per field per boot ACROSS BOTH read surfaces — the same record is echoed by ` +
      `list_agents and agent_status, so this is one defect and not two; the response says it ` +
      `every time.`
    );
  }

  /** `capacity`: how many more agents this machine can carry, and why. */
  private handleCapacity(_data: any, respond: Respond) {
    const { agents } = this.surveyAgents();
    const capacity = this.capacityOf(agents);
    const candidates = this.preemptionCandidates(agents);
    respond({
      action: 'capacity_response',
      success: true,
      ...capacityDto(capacity),
      derivation: describeCapacity(capacity),
      // At capacity the next question is always "then what would I have to
      // stand down?", and answering it here saves a caller from working the
      // ordering out for itself — or, worse, guessing at it.
      priorities: candidates.map((c) => ({
        path: c.path,
        paneName: c.paneName,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      fleetPriorities: describeFleetPriorities(candidates)
    });
  }

  /**
   * The capacity model applied to a census: chargeable agents in `running`,
   * unchargeable ones counted separately as `exemptAgents` (reported, never
   * charged — see capacity.ts).
   *
   * This is the third of the three decisions the old `gateExempt` boolean was
   * carrying. Every capacity answer in this daemon goes through here, so
   * `running` means the same thing in the refusal, in `list_agents` and in the
   * `capacity` action.
   */
  private capacityOf(agents: ListedAgent[]): Capacity {
    let fleet = 0;
    let exempt = 0;

    for (const entry of agents) {
      if (entry.chargeable) fleet++;
      else exempt++;
    }

    return readCapacity(fleet, exempt);
  }

  /**
   * Agents stood down to make room, in the shape a client renders.
   *
   * Cross-checked against the same census as the other categories: an agent
   * the registry believes preempted that herdr can show running is not owed
   * anything — the record and reality disagree, and reality is the one a
   * supervisor acts on.
   */
  private preemptedAgents(
    agents: ListedAgent[],
    sharedIntents?: Map<string, AgentIntent>
  ): PreemptedAgentDto[] {
    const alive = new Set(agents.map((a) => a.path));
    // The intent map rather than the derived list alone, so the echo below
    // comes from `configEcho` like every other category's. A second place that
    // assembles the block by hand is a second place that can be left behind
    // when `configure` grows a knob.
    const intents = sharedIntents ?? this.deps.agentRegistry.intents();
    const preempted = AgentRegistry.preemptedFrom(intents);
    return preempted
      .filter((entry) => !alive.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        paneName: paneNameFor(entry.path),
        label: entry.record.config.label ?? null,
        // The frozen configuration, on the category a caller is most likely to
        // act on: deciding whether to re-staff preempted work means knowing
        // what it would come back as, and what it would have to outrank.
        ...configEcho(intents.get(entry.path), 'summarised'),
        at: entry.at,
        priority: entry.preemption.priority,
        herdrStatusWhenPreempted: entry.preemption.herdrStatus,
        by: {
          path: entry.preemption.byPath,
          paneName: entry.preemption.byPaneName,
          priority: entry.preemption.byPriority
        },
        reason:
          `Stood down at ${entry.at} to free capacity for ` +
          `${entry.preemption.byPath} ` +
          `(priority ${entry.preemption.byPriority} against this agent's ` +
          `${entry.preemption.priority}). Its work was interrupted, not finished. ` +
          `Re-activating it resumes the conversation it was stopped in; until then ` +
          `its work should not be read as in progress.`,
        derivation: entry.preemption.derivation
      }));
  }

  /**
   * The gap between what the registry says should be running and what herdr
   * actually has.
   *
   * The comparison is against the *census*, not against the session map: an
   * agent that survived a daemon restart has no session of ours and is
   * nonetheless perfectly alive, and calling it missing would be a false
   * alarm about something working exactly as designed.
   */
  private missingAgents(
    agents: ListedAgent[],
    foreignPanes: ForeignPane[],
    staleSessions?: Set<string>,
    sharedIntents?: Map<string, AgentIntent>
  ): MissingAgent[] {
    const alive = new Set(agents.map((a) => a.path));
    const missing: MissingAgent[] = [];

    // THE RECONCILIATION, AND IT TAKES THE FOREIGN PANES OF THIS SAME SWEEP
    // (KAN-572). `foreignPanes` is a parameter rather than a second census read
    // for the reason every other category here is: two answers to "what is
    // running" is one answer too many, and the defect this closes was precisely
    // two sections of ONE response disagreeing about one directory.
    //
    // Only a pane whose `occupies` is set can be here: that field is non-null
    // exactly when the pane's cwd is a directory we hold a record for, which is
    // the join. A stranger's pane somewhere else on the machine is not news.
    const occupants = new Map<string, ForeignPane>();
    for (const pane of foreignPanes) {
      if (pane.occupies) occupants.set(pane.occupies, pane);
    }

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      if (intent.event !== 'activated') continue;
      if (alive.has(agentPath)) continue;

      const occupant = occupants.get(agentPath) ?? null;
      const heldASession = staleSessions?.has(agentPath) ?? false;

      missing.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        // A loss is the row a supervisor most needs the configuration on: the
        // decision it prompts is "re-activate this or stand it down", and both
        // halves of that need to know what would come back.
        ...configEcho(intent, 'summarised'),
        since: intent.at,
        occupiedBy: occupant
          ? {
              paneName: occupant.paneName,
              paneId: occupant.paneId,
              herdrStatus: occupant.herdrStatus,
              agentRuntime: occupant.agentRuntime
            }
          : null,
        // THREE CASES, and the third is the one this sentence used to get wrong.
        //
        // Both of the original two are "not running", and they are not the same
        // event: an agent that never came back, versus one that was running
        // under this daemon and died while we held its session. The second is a
        // crash we witnessed.
        //
        // THE THIRD IS NOT "NOT RUNNING" AT ALL, and saying that it was is the
        // defect (KAN-572). Our ownership question is NAME-scoped — is there a
        // pane called `paneNameFor(path)` — and this sentence was
        // DIRECTORY-scoped, so a stranger's live pane in that very directory
        // answered "no pane of ours" and was then reported as an empty
        // workspace. It is not empty, this response says so sixty lines away
        // under `foreignPanes`, and a reader who takes the section header at its
        // word resumes a conversation nobody stopped.
        reason: occupant
          ? 'The registry records this agent as active' +
            (heldASession ? ' and this daemon held a session for it' : '') +
            ', and herdr has no live agent of OURS in its directory. THE DIRECTORY IS NOT ' +
            `EMPTY: ${occupant.paneName}` +
            (occupant.paneId ? ` (pane ${occupant.paneId})` : '') +
            ' is a live pane this daemon did not start' +
            (occupant.agentRuntime ? `, running ${occupant.agentRuntime}` : '') +
            `, herdr status ${occupant.herdrStatus}, and it is sitting in this exact ` +
            'directory — it is listed under foreignPanes on this same response. So work IS ' +
            'happening there and it is not ours: do NOT read this row as work that has ' +
            'stopped. Activating this agent will be REFUSED until that pane is gone, and ' +
            'nothing here should be resumed on the strength of this row.'
          : heldASession
            ? 'The registry records this agent as active and this daemon held a session ' +
              'for it, but herdr has no live agent in its directory: it started and then died. ' +
              'It is not running.'
            : 'The registry records this agent as active, but herdr has no live agent in its ' +
              'directory and this daemon holds no session for it. It is not running.'
      });
    }

    return missing;
  }

  /**
   * Agents a person switched off, that could be switched back on.
   *
   * Three filters, each removing a different kind of thing nobody means by
   * "turn it back on":
   *
   *   - still running — the stand-down failed, or it was started again since.
   *     Offering On for something already on is how a control starts lying.
   *   - preempted — reported separately, with the name of what took its slot.
   *     One agent, one switch. (Once compaction has dropped that annotation
   *     the agent does land here — there is no longer a debt to report it as —
   *     but it arrives carrying `wasPreempted` and a reason that says what
   *     actually happened to it. It is still in exactly one list.)
   *   - directory gone — the caller deleted it, and that is the difference
   *     between "stopped" and "finished with".
   *
   * Newest first, because the thing you just switched off is the thing you are
   * most likely to want back.
   */
  private standbyAgents(
    agents: ListedAgent[],
    sharedIntents?: Map<string, AgentIntent>
  ): StandbyAgent[] {
    const alive = new Set(agents.map((a) => a.path));
    const standby: StandbyAgent[] = [];

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      // NOT `event === 'deactivated'`. A stopped agent that was then
      // reconfigured has `configured` as its last event and a conversation on
      // disk, and testing the event alone dropped it out of every category.
      // What decides this list is whether the agent has ever run — see
      // {@link StandbyAgent}.
      if (intent.event === 'activated') continue;
      if (!intent.everActivated) continue;
      if (intent.preemption) continue;
      if (alive.has(agentPath)) continue;
      if (!fs.existsSync(agentPath)) continue;

      standby.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        launcher: intent.record.config.launcher,
        ...configEcho(intent, 'summarised'),
        since: intent.at,
        // Set on a row that reached this list through compaction dropping a
        // preemption annotation, so a client can tell the two apart and the
        // sentence below can stop short of claiming a decision nobody made.
        ...(intent.wasPreempted ? { wasPreempted: true } : {}),
        reason: intent.wasPreempted
          ? 'Stopped to free capacity for higher-priority work, long enough ago that the ' +
            'record of what took its slot has been compacted away. Its directory is still ' +
            'there, so switching it back on resumes the conversation it was stopped in ' +
            'rather than starting a new one.'
          : 'Switched off deliberately. Its directory is still there, so switching it back ' +
            'on resumes the conversation it was stopped in rather than starting a new one.'
      });
    }

    // Unpaged and unsorted: ordering and paging are one decision, made once,
    // in handleListAgents. A category that clipped itself here was a second
    // place the cap lived, and the reason the response could not say how to
    // reach past it.
    return standby;
  }

  /**
   * Agents that exist and have never run.
   *
   * THE CATEGORY THAT USED TO BE NO CATEGORY. `standbyAgents` filters on a
   * `deactivated` event, so a `configured`-last row matched nothing and fell
   * out of the response entirely — configured, activatable, and invisible to
   * any client building its controls from this list. That is the same class of
   * failure as a silently-clipped list, one level up: not "we showed you 25 of
   * 40" but "we showed you none of these and said nothing".
   *
   * IT IS NOT STANDBY, and the reason is behavioural rather than taxonomic.
   * Every standby row promises that switching it back on "resumes the
   * conversation it was stopped in", and `claude --continue` makes that true.
   * An agent that has never run has nothing to continue, so the same command
   * falls through to the cold branch and it starts fresh. One list, two
   * behaviours, and a promise that is false for half its members.
   *
   * The same two filters standby applies, for the same reasons: an agent that
   * is running is never offered as one that has yet to start, and a directory
   * the caller has deleted is not a thing anyone means to start.
   */
  private unstartedAgents(
    agents: ListedAgent[],
    sharedIntents?: Map<string, AgentIntent>
  ): UnstartedAgent[] {
    const alive = new Set(agents.map((a) => a.path));
    const unstarted: UnstartedAgent[] = [];

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      // `everActivated` is the whole test, and it is deliberately not
      // `event === 'configured'`: an agent that ran, stopped and was
      // reconfigured has that event and a conversation on disk, and claiming it
      // starts fresh would be exactly the false promise this category exists to
      // stop standby from making.
      if (intent.everActivated) continue;
      if (alive.has(agentPath)) continue;
      if (!fs.existsSync(agentPath)) continue;

      unstarted.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        launcher: intent.record.config.launcher,
        ...configEcho(intent, 'summarised'),
        since: intent.at,
        reason:
          'Configured and never activated. It has no conversation, so activating it starts ' +
          'a fresh one with the prompt on its record — unlike a standby agent, where the ' +
          'same call resumes the conversation it was stopped in.'
      });
    }

    // Unpaged, for the reason standbyAgents gives.
    return unstarted;
  }

  /**
   * Everything the daemon's periodic sweep needs, from ONE census read.
   *
   * Two questions are asked on that timer — which recorded agents are absent,
   * and which live agents changed what herdr says they are doing — and they
   * are answered together rather than by two passes, for the reason this file
   * gives everywhere else: two reads of herdr can disagree, and a sweep that
   * announced a loss from one census and a status transition from another
   * would be publishing two incompatible pictures of the same instant. It is
   * also what makes `agent.status_changed` free: the census was being taken
   * anyway.
   *
   * `reachable` is carried out because the caller must be able to tell an
   * observation from a silence. An unreachable herdr answers with an empty
   * census, and every status in `statuses` then reads `unknown` — which is
   * this daemon's blindness rather than the agents' behaviour, and must not be
   * published as a transition.
   */
  public observeFleet(): FleetObservation {
    const intents = this.deps.agentRegistry.intents();
    const { agents, foreignPanes, staleSessions, census } = this.surveyAgents(intents);
    return {
      reachable: census.reachable,
      // THE SAME RECONCILIATION THE LIST GETS, and it is here rather than only
      // at the request because `agent.lost` is published from this sweep
      // (KAN-572). A `missingAgents` row and an `agent.lost` payload are the
      // same object, so a fix applied at the printing surface would have left
      // the event — and every consumer polling it — carrying the sentence the
      // list had stopped saying.
      missing: this.missingAgents(agents, foreignPanes, staleSessions, intents),
      // Ours only. A foreign pane's status is not ours to publish — it belongs
      // to whoever started it, and this daemon holds no record it could name
      // the agent by.
      statuses: agents
        .filter((agent) => agent.configured)
        .map((agent) => ({
          path: agent.path,
          paneName: agent.paneName,
          paneId: agent.paneId,
          herdrStatus: agent.herdrStatus
        }))
    };
  }

  /**
   * `missingAgents`, for callers outside a request — the daemon's periodic
   * sweep. Public because the sweep runs on a timer rather than in response to
   * a client, and must ask the same question the list answers.
   */
  public findMissingAgents(): MissingAgent[] {
    return this.observeFleet().missing;
  }

  /**
   * TAKE ONE SWEEP'S CENSUS INTO MEMORY, AND HAND BACK THE TRANSITIONS IT
   * CONTAINS.
   *
   * This is the whole of `agent.status_changed`'s detection and the whole of
   * `statusSince`'s population, and they are one function on purpose: they are
   * the same observation read twice. It used to be `lastObservedStatus`, a map
   * in `daemon.ts`, which compared the census against what it held and threw
   * the moment away — the daemon knew the transition had happened and kept no
   * record of WHEN. That is the defect KAN-200 was filed for, and the fix is
   * one field on the value rather than a second memory beside it. A second map
   * could disagree with this one about the same agent, and the disagreement
   * would show up as an event and a row telling a caller two different stories.
   *
   * SILENCE IS NOT A STATUS, and this is the guard's only home. An unreachable
   * herdr answers with an EMPTY census, and every row this daemon still
   * reports from its own session map then carries `herdrStatus: 'unknown'`.
   * Recording that would do two things, both wrong: it would broadcast
   * `working → unknown` for the whole fleet on any herdr blip and
   * `unknown → working` when it came back — events describing our own
   * blindness as the agents' behaviour — and it would stamp a fresh
   * `statusSince` on every agent on the machine, which is this daemon claiming
   * to have watched a change that never happened. So when the census did not
   * answer, nothing is compared, nothing is recorded, nothing is returned.
   *
   * A FIRST SIGHTING IS NOT A TRANSITION. An agent this daemon has never
   * observed — a fresh activation, an agent that came back, every agent alive
   * at the moment this process started — seeds the map with `since: null` and
   * announces nothing. There is no `from` anybody watched, and there is no
   * moment anybody watched either. `null` is therefore a REAL VALUE with a
   * documented meaning ("this daemon has not observed a change for this
   * agent"), and it is what a freshly started daemon reports for its entire
   * fleet.
   *
   * IN MEMORY, AND THAT IS SETTLED RATHER THAN PENDING. KAN-189 asked the
   * durability question for `missingSince` — see the four grounds on
   * {@link MissingAgent.since}, which this is the other half of — and answered
   * no: "inventing a `from` out of a durable copy would be claiming to have
   * witnessed a change nobody watched". `statusSince` is a fact about THIS
   * DAEMON'S WATCHING rather than about the agent, and a value read back off
   * disk after a restart would make exactly that claim, over a gap in which
   * nothing was watching. A consumer that wants a window longer than one
   * daemon's life keeps its own, which is the same answer KAN-189 gave for
   * down-time. Do not re-derive this; it is not an oversight.
   *
   * An agent that is no longer live forgets both halves, so that coming back
   * is a first sighting rather than a transition from whatever it was doing
   * when it disappeared — and its `statusSince` starts null again, because
   * this daemon did not watch whatever happened in between.
   */
  public recordSweepObservation(observation: FleetObservation): StatusTransition[] {
    return this.statusMemory.record(observation);
  }

  /**
   * What this daemon's sweep last saw each live agent of ours doing, and when.
   * Written only by {@link recordSweepObservation} and read only by
   * {@link rowFrom}.
   *
   * SHARED ACROSS EVERY ROUTER IN THE PROCESS when the daemon injects one —
   * which it must, because it builds one router per connection and this memory
   * is written by the sweep's router and read by whichever router answers a
   * `list_agents`. {@link FleetStatusMemory} carries what goes wrong when it is
   * not shared.
   *
   * DELIBERATELY NOT WRITTEN BY `list_agents`. The list takes its own census on
   * every request, and letting it record would make `statusSince` track
   * whatever cadence callers happen to poll at — so two consumers polling at
   * different rates would move a number that is supposed to describe the agent.
   * The sweep is one clock, it runs whether anybody is asking or not, and it is
   * the clock the field's documented meaning is written against.
   */
  private readonly statusMemory: FleetStatusMemory;

  private rowFrom(
    agentPath: string,
    paneName: string,
    census: HerdrAgentRecord | undefined,
    session: HerdrSession | undefined,
    intent: AgentIntent | undefined
  ): ListedAgent {
    const config = intent?.record.config;
    return {
      sessionless: !session,
      // Every row this function builds is a LIVE agent — that is what puts it
      // in `agents` — so its state is `running` unless there is no record at
      // all to call it ours. Derived through the same function the single-agent
      // read uses, so the two can never disagree.
      state: this.stateOf(intent, true),
      configured: Boolean(intent),
      // `state: 'running'` beside `everActivated: false` is NOT a contradiction
      // here: the first is observed, the second is what our log records, and a
      // row showing both is a record that has fallen behind a live agent. T5's
      // converging `activate` is the repair, and hiding the disagreement behind
      // a liveness fallback removed the only signal that it existed.
      ...configEcho(intent, 'summarised'),
      path: agentPath,
      paneName,
      paneId: census?.paneId ?? null,
      // Session-only fields are null, not invented: there is no session id to
      // report and no creation time we saw. Filling them in to match the
      // attached shape would be a fabrication.
      sessionId: session?.sessionId ?? null,
      createdAt: session ? session.createdAt.toISOString() : null,
      status: session?.status ?? null,
      herdrStatus: census?.herdrStatus ?? 'unknown',
      // GATED ON THE STATUS MATCHING, so the field's sentence is true rather
      // than nearly true. `statusSince` says "this daemon has observed this
      // agent in THIS status since T". The status on this row came from the
      // census that answered THIS call; the memory came from the last sweep,
      // up to one sweep interval ago. When they disagree — the agent changed
      // in the window between — the remembered moment belongs to the status
      // the agent has just left, and reporting it here would date the wrong
      // one. So the answer is null, which is the value that already means
      // "this daemon has not observed a change into what you are looking at".
      statusSince: this.statusMemory.since(agentPath, census?.herdrStatus ?? 'unknown'),
      agentRuntime: census?.agentRuntime ?? null,
      label: config?.label ?? null,
      // An agent with no record cannot be priced, refused or preempted — so it
      // is treated as fully subject to the machine (charged, refusable) and
      // never offered as a victim. That combination is the safe reading of
      // every unknown: it costs a slot, which is true, and nothing may kill it
      // on the strength of a priority nobody wrote down.
      refusable: config?.refusable ?? true,
      chargeable: config?.chargeable ?? true,
      preemptable: config ? config.preemptable : false
    };
  }

  /**
   * The agent census behind `list_agents`, shared with anything that needs to
   * know what is running. Split out so every consumer counts exactly what the
   * list reports; two answers to "what is running" is one answer too many.
   */
  private surveyAgents(sharedIntents?: Map<string, AgentIntent>): {
    agents: ListedAgent[];
    unbackedPanes: UnbackedPane[];
    foreignPanes: ForeignPane[];
    staleSessions: Set<string>;
    census: HerdrCensus;
  } {
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const intents = sharedIntents ?? this.deps.agentRegistry.intents();
    const byPaneName = new Map<string, HerdrAgentRecord>(census.agents.map((a) => [a.name, a]));

    const agents: ListedAgent[] = [];
    const covered = new Set<string>();

    /**
     * Sessions this daemon still holds for agents herdr no longer has.
     *
     * A session is our record that we *started* something; it is not evidence
     * that the thing is still alive, and it outlives the agent whenever the
     * pane dies without us tearing it down — which is precisely what a crashed
     * or killed agent looks like. Listing one as running is how a dead agent
     * reads as work in progress with nothing behind it.
     */
    const staleSessions = new Set<string>();

    for (const session of this.deps.herdrBridge.listActiveSessions()) {
      // herdr is the authority on whether an agent exists — but only when it
      // answered. An unreachable herdr returns an empty census, and treating
      // that silence as "they are all dead" would condemn a perfectly healthy
      // fleet, so in that case we keep trusting the session map.
      //
      // Two different deaths, and only one of them is unconditional. A pane
      // herdr has never heard of is gone, full stop. A pane it *has* with no
      // runtime behind it is one whose agent exited — dead too, except for a
      // `shell` agent, where a bare prompt and no runtime is the entire point.
      if (census.reachable) {
        const record = byPaneName.get(session.paneName);
        const dead = !record || (!record.agentRuntime && (session.expectsRuntime ?? true));
        // An empty pane is only evidence of death once the launcher has had
        // its runtime-confirm window: a freshly spawned agent legitimately
        // shows no runtime for up to RUNTIME_CONFIRM_TIMEOUT_MS, and any
        // concurrent list_agents/capacity call landing inside it would
        // otherwise abandon the session the in-flight activate is still
        // confirming, which then answers `success: true` over a killed PTY.
        const settled =
          Date.now() - session.createdAt.getTime() >= RUNTIME_CONFIRM_TIMEOUT_MS;
        if (dead && settled) {
          staleSessions.add(session.path);
          // Release the corpse, not just skip it. A session left `active` for
          // a dead pane is the one the next activate for this path would
          // reuse — it would then fail confirmation only after a full
          // confirm-timeout poll, tearing the session down at the moment the
          // caller is waiting on it.
          this.deps.herdrBridge.abandonSession(
            session.sessionId,
            `herdr has no live agent behind ${session.paneName}; the session was released by the census`
          );
          continue;
        }
      }

      covered.add(session.path);
      agents.push(
        this.rowFrom(
          session.path,
          session.paneName,
          byPaneName.get(session.paneName),
          session,
          intents.get(session.path)
        )
      );
    }

    const unbackedPanes: UnbackedPane[] = [];
    const foreignPanes: ForeignPane[] = [];

    // OUR agents, asked the one way this daemon asks it: for each registered
    // path, is there a live pane bearing the name that path derives? Driven
    // from the REGISTRY rather than from the census, because that is the
    // direction the question runs — the census cannot say which directories we
    // hold records for.
    //
    // This used to be a second, differently-shaped ownership test living here
    // while `occupancyOf` used a third. Two tests that can disagree about the
    // same pane is one test too many, and the one that guarded the gate was
    // the one that could go wrong.
    for (const [agentPath, intent] of intents) {
      if (covered.has(agentPath)) continue;
      const pane = ourPaneIn(census, agentPath, intent.record.config.launcher);
      if (!pane) continue;
      covered.add(agentPath);
      agents.push(this.rowFrom(agentPath, pane.name, pane, undefined, intent));
    }

    for (const record of census.agents) {
      const cwd = record.canonicalWorkDir;
      // Ours by the same single test, asked of this pane's own directory.
      const ours =
        cwd !== null &&
        intents.has(cwd) &&
        ourPaneIn(census, cwd, intents.get(cwd)!.record.config.launcher)?.name === record.name;

      if (!ours) {
        // Only live ones. A bare shell somebody left open elsewhere on the
        // machine is not news; a running agent in a directory we hold a record
        // for is exactly the thing that will refuse our next activation.
        if (record.agentRuntime) {
          const occupies = cwd !== null && intents.has(cwd) ? cwd : null;
          const occupied = occupies ? intents.get(occupies) : undefined;
          foreignPanes.push({
            paneName: record.name,
            paneId: record.paneId,
            workDir: record.workDir,
            occupies,
            herdrStatus: record.herdrStatus,
            agentRuntime: record.agentRuntime,
            // OUR agent for this directory — the one whose activation this
            // pane will refuse — rather than a configuration for the pane
            // itself, which has none. Nested under its own key precisely so
            // the two cannot be confused: a bare `config` on a foreign row
            // would read as the stranger's configuration, which we do not
            // have and could not honestly report.
            occupiedAgent: occupied
              ? {
                  path: occupies!,
                  // Asked properly rather than assumed `false`: ours and a
                  // stranger can be live in the SAME directory, which is the
                  // case this row exists to make visible, and reporting our
                  // running agent as stopped on the row that reports the
                  // stranger would be the more misleading of the two answers.
                  state: this.stateOf(
                    occupied,
                    ourPaneIn(census, occupies!, occupied.record.config.launcher) !== null,
                    census.reachable
                  ),
                  ...configEcho(occupied, 'summarised')
                }
              : null
          });
        }
        continue;
      }

      // Already listed by the registry-driven pass above.
      if (covered.has(cwd!)) continue;
    }

    // Our panes with nothing behind them: a registered path whose derived pane
    // name is in the census without a runtime. `ourPaneIn` requires a runtime,
    // so these are exactly the ones it declines to call ours.
    for (const [agentPath] of intents) {
      if (covered.has(agentPath)) continue;
      const paneName = paneNameFor(agentPath);
      const record = census.agents.find((a) => a.name === paneName);
      // Only a runtime-bearing launcher can have an UNBACKED pane; for `shell`
      // an empty pane is the product, and `ourPaneIn` has already claimed it
      // above.
      if (!record || record.agentRuntime) continue;
      unbackedPanes.push({
        paneName: record.name,
        paneId: record.paneId,
        path: agentPath,
        herdrStatus: record.herdrStatus,
        // This IS one of ours — a registered path whose pane has nothing behind
        // it — so it carries the echo like every other category. A reader
        // deciding what to do about an empty pane needs to know what was
        // supposed to be in it.
        ...configEcho(intents.get(agentPath), 'summarised'),
        reason:
          'herdr reports no agent running in this pane and this daemon holds no session for it'
      });
    }

    return { agents, unbackedPanes, foreignPanes, staleSessions, census };
  }

  // -------------------------------------------------------------------- pty

  /**
   * The session id a PTY request names, when it named one at all.
   *
   * `null` covers both a missing id and a non-string one, so the refusal below
   * can tell "you sent no session" from "you sent a session I do not have"
   * without any caller having to trust the shape of the wire.
   */
  private ptySessionId(data: any): string | null {
    return typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  }

  /**
   * Which condition a PTY refusal reports, as a value rather than as prose.
   *
   * Both refusals answer `success: false` and both carry an `error` written for
   * a human, so without this field the only way to tell them apart is to match
   * on the message text — which makes every word of those sentences a
   * load-bearing API surface, and breaks the caller the first time one is
   * reworded. The two conditions have different remedies and a caller acts on
   * that difference:
   *
   * - `unknown_session` — the session id is not one this daemon holds. Re-resolve
   *   the agent and use the id that comes back; retrying this one cannot work.
   * - `invalid_payload` — the session is fine and the request is not. Fix the
   *   request and retry it against the same session.
   *
   * Additive: every refusal that carried an `error` before carries the same
   * `error` now, and this alongside it (KAN-280).
   */
  private readonly PTY_UNKNOWN_SESSION = 'unknown_session';
  private readonly PTY_INVALID_PAYLOAD = 'invalid_payload';

  /**
   * How a malformed field is described back to its sender.
   *
   * NOTHING FROM A `pty_input` PAYLOAD IS QUOTED BACK, and that is a rule about
   * secrets rather than about brevity: `data` is keystrokes — it carries
   * whatever the caller's user typed, which includes passwords — and a refusal
   * is written to a log and pasted into bug reports. So a caller is told the
   * TYPE it sent and never the value. `cols` and `rows` are terminal
   * dimensions, carry nothing private, and are echoed in full because knowing
   * that it sent `"80"` rather than `80` is the whole of what the caller needs.
   */
  private describeType(value: unknown): string {
    if (value === undefined) return 'no such field';
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    return `a value of type ${typeof value}`;
  }

  /**
   * The refusal a `pty_input` gets when it carries no keystrokes to write, or
   * `null` when its payload is one this daemon can act on.
   *
   * WHY THIS EXISTS AT ALL (KAN-280). `data.data` used to be handed to
   * `writePty` unexamined, so a request without it reached node-pty's `write`
   * and threw — and the caller was answered with the dependency's own sentence,
   * *"The first argument must be of type string or an instance of Buffer …
   * Received undefined"*, carrying no `action` field because it came from the
   * daemon's catch-all rather than from this handler. Two things were wrong
   * with that and only one of them was cosmetic: a Node type error reads like
   * an internal fault, so the caller's correct response — fix my payload — is
   * the one the message does not suggest. It was reported by the first real
   * consumer to build against this socket, and it is the failure a new
   * integrator meets first, because sending a partial payload is what you do
   * while still learning a shape.
   *
   * A STRING, BECAUSE THAT IS WHAT THE WIRE CAN CARRY. `writePty` accepts what
   * node-pty accepts, which includes a Buffer — but this is the NDJSON
   * boundary, and JSON has no Buffer. Anything that arrives here is a string, a
   * number, a boolean, null, an array or an object, and only the first is
   * keystrokes.
   *
   * The empty string is allowed through deliberately. Writing nothing to a PTY
   * is a no-op rather than an error, and refusing it would be this handler
   * inventing a constraint the terminal does not have.
   */
  private ptyInputRefusal(data: any): string | null {
    if (typeof data.data === 'string') return null;
    return (
      `pty_input requires a \`data\` field carrying the keystrokes to write, as a string; ` +
      `this request carried ${this.describeType(data.data)}. The session named is valid — ` +
      'nothing was written to it, and nothing about it needs re-resolving. Send the same ' +
      'request again with `data` set to the text to type.'
    );
  }

  /**
   * The refusal a `pty_resize` gets when it names dimensions that are not
   * dimensions, or `null` when both are usable.
   *
   * SIBLING OF THE ABOVE, AND IT FAILED IN THE OPPOSITE DIRECTION (KAN-280).
   * `resizePty` guards its call with `cols > 0 && rows > 0`, and that comparison
   * is false for `undefined` and false for `"wide"` — so a resize carrying
   * neither field skipped the resize, returned `true`, and was answered
   * `success: true`. Nothing threw and nothing leaked; the caller was simply
   * told its window had been resized when no resize had been attempted. That is
   * the worse of the two failures — a legible error at least tells you to look
   * — and it is why this handler validates rather than only the one that was
   * reported.
   *
   * INTEGERS, NOT MERELY POSITIVE NUMBERS. A terminal is a whole number of
   * cells. `80.5` would have passed the old guard and been rounded by somebody
   * further down; a caller computing a fractional column count has a bug this
   * is the cheapest place to tell it about. JSON parses `80.0` to `80`, so the
   * only values this newly refuses are ones no caller means to send.
   */
  private ptyResizeRefusal(data: any): string | null {
    const bad = (['cols', 'rows'] as const).filter(
      field => !Number.isInteger(data[field]) || data[field] <= 0
    );
    if (bad.length === 0) return null;
    const named = bad
      .map(field =>
        data[field] === undefined
          ? `no \`${field}\` field`
          : `\`${field}\` = ${typeof data[field] === 'number' ? data[field] : this.describeType(data[field])}`
      )
      .join(' and ');
    return (
      `pty_resize requires \`cols\` and \`rows\` to be positive whole numbers of character ` +
      `cells; this request carried ${named}. The session named is valid and was NOT resized. ` +
      'Send the same request again with both dimensions set.'
    );
  }

  /**
   * The refusal a PTY request gets when it names a session this daemon does not
   * hold.
   *
   * It says which id, what that means, and what to do instead — because the
   * caller is a program, and a program that is only told "no" will retry the
   * same id forever. The alternative this replaces was worse than a bad error
   * message: the extraction source's daemon used to substitute an arbitrary
   * session, or spawn a default shell, and answer as though the request had
   * been honoured (KAN-25).
   */
  private unknownPtySession(action: string, sessionId: string | null): string {
    const named =
      sessionId === null
        ? `${action} arrived without a sessionId`
        : `${action} names session '${sessionId}', which this daemon does not have`;
    return (
      `${named}. A PTY session id is only valid for the daemon process that issued it, ` +
      'and this one is not among them — most likely it was issued by a previous daemon ' +
      'and the client has not re-resolved since. Ask for the agent again (activate by ' +
      'path) and use the session id that comes back; retrying this one cannot succeed.'
    );
  }

  private handlePtyInit(data: any, respond: Respond) {
    const sessionId = this.ptySessionId(data);
    const session = sessionId === null ? undefined : this.deps.herdrBridge.getSession(sessionId);
    if (sessionId === null || session === undefined) {
      respond({
        action: 'pty_init_response',
        success: false,
        sessionId,
        refusal: this.PTY_UNKNOWN_SESSION,
        error: this.unknownPtySession('pty_init', sessionId)
      });
      return;
    }

    respond({
      action: 'pty_init_response',
      success: true,
      sessionId,
      buffer: session.ptyBuffer
    });

    const oldCleanup = this.activePtyListeners.get(sessionId);
    if (oldCleanup) oldCleanup();

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    const cleanup = this.deps.herdrBridge.registerDataListener(sessionId, (ptyData) => {
      this.deps.send({
        action: 'pty_output',
        success: true,
        sessionId,
        data: ptyData
      });
    });

    // Only absent if the session went away between the lookup above and here,
    // which cannot happen synchronously — but nothing is registered on a guess.
    if (cleanup) this.activePtyListeners.set(sessionId, cleanup);
  }

  /**
   * `ack` carries the success; `refuse` carries every refusal, whether or not
   * the caller asked to be correlated (KAN-299). The rule and its reasons are
   * where `ack` is built, in `handle`; the types that hold it are {@link PtyAck}
   * and {@link PtyRefusal}.
   */
  private handlePtyInput(data: any, ack: PtyAck, refuse: PtyRefusal) {
    const sessionId = this.ptySessionId(data);
    // The most dangerous of the three to answer approximately: keystrokes sent
    // to a session picked on the client's behalf land in some other agent's
    // terminal, and get executed there.
    //
    // THE SESSION IS CHECKED FIRST, AND THAT ORDER IS DELIBERATE. `writePty`
    // returns false on an unknown session before it touches `data`, so a
    // request that is wrong in both ways has always been answered with the
    // session refusal. Validating the payload first would have quietly swapped
    // which of the two a caller is told about; this keeps the precedence the
    // session check has always had, and adds the payload check underneath it
    // rather than in front of it (KAN-280).
    if (sessionId === null || this.deps.herdrBridge.getSession(sessionId) === undefined) {
      refuse({
        action: 'pty_input_response',
        success: false,
        sessionId,
        refusal: this.PTY_UNKNOWN_SESSION,
        error: this.unknownPtySession('pty_input', sessionId)
      });
      return;
    }

    const payloadRefusal = this.ptyInputRefusal(data);
    if (payloadRefusal !== null) {
      refuse({
        action: 'pty_input_response',
        success: false,
        sessionId,
        refusal: this.PTY_INVALID_PAYLOAD,
        error: payloadRefusal
      });
      return;
    }

    // Still checked, and it is not redundant with the lookup above: the session
    // can end between the two, and a write to one that has is a "no such
    // session" as truly as a fabricated id is. Answering it the same way is
    // what keeps a race from being reported as a payload problem.
    if (!this.deps.herdrBridge.writePty(sessionId, data.data)) {
      refuse({
        action: 'pty_input_response',
        success: false,
        sessionId,
        refusal: this.PTY_UNKNOWN_SESSION,
        error: this.unknownPtySession('pty_input', sessionId)
      });
      return;
    }
    ack({ action: 'pty_input_response', success: true, sessionId });
  }

  /** Refusals unconditional, success gated — the same split as `handlePtyInput`. */
  private handlePtyResize(data: any, ack: PtyAck, refuse: PtyRefusal) {
    const sessionId = this.ptySessionId(data);
    // Session first, for the reason given in `handlePtyInput` above.
    if (sessionId === null || this.deps.herdrBridge.getSession(sessionId) === undefined) {
      refuse({
        action: 'pty_resize_response',
        success: false,
        sessionId,
        refusal: this.PTY_UNKNOWN_SESSION,
        error: this.unknownPtySession('pty_resize', sessionId)
      });
      return;
    }

    const payloadRefusal = this.ptyResizeRefusal(data);
    if (payloadRefusal !== null) {
      refuse({
        action: 'pty_resize_response',
        success: false,
        sessionId,
        refusal: this.PTY_INVALID_PAYLOAD,
        error: payloadRefusal
      });
      return;
    }

    if (!this.deps.herdrBridge.resizePty(sessionId, data.cols, data.rows)) {
      refuse({
        action: 'pty_resize_response',
        success: false,
        sessionId,
        refusal: this.PTY_UNKNOWN_SESSION,
        error: this.unknownPtySession('pty_resize', sessionId)
      });
      return;
    }
    ack({ action: 'pty_resize_response', success: true, sessionId });
  }

  /** Called when this router's client disconnects, so its PTY listeners die with it. */
  public cleanup() {
    this.activePtyListeners.forEach(unsub => unsub());
    this.activePtyListeners.clear();
  }
}
