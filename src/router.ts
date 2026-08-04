import * as fs from 'fs';
import * as path from 'path';
import { CrabcastConfig } from './config.js';
import { MAX_LINE_CHARS } from './ipc.js';
import { AgentConfig, DaemonResponse, McpServerSpec } from './types.js';
import { removeProvisionedArtifacts } from './provisioning.js';
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
import { PathError, canonicalPath, canonicalizeOrNull, paneNameFor } from './identity.js';
import { BUILTIN_MCP_SERVERS, builtinMcpServer, knownLaunchers, resolveLauncher } from './launchers.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import { ResumeCause } from './resume.js';
import {
  Capacity,
  capacityReason,
  capacityRefusal,
  describeCapacity,
  readCapacity,
  summarizeCapacity
} from './capacity.js';
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
import { AgentIntent, AgentRecord, AgentRegistry, RecordOutcome } from './agent-registry.js';
import { nudgeResumedAgent } from './nudge.js';
import { BuildSnapshot, buildProvenanceReport } from './provenance.js';

type Respond = (msg: any) => void;

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
   */
  config: AgentConfig | null;
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
    'label', 'refusable', 'chargeable', 'preemptable', 'launcher', 'priority',
    'since', 'at', 'wasPreempted', 'by', 'derivation', 'herdrStatusWhenPreempted',
    'occupiedAgent'
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
    'sessionless', 'workDir'
  ],
  /**
   * Computed by this daemon from the two above. Never stored and never read off
   * a pane: `paneName` is a pure function of the path, `state` and `occupies`
   * join the record against the census, and `reason` is the sentence that
   * explains the result.
   */
  derived: ['paneName', 'state', 'occupies', 'reason']
} as const;

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
    load1: Math.round(c.machine.load1 * 100) / 100,
    totalMb: Math.round(c.machine.totalBytes / (1024 * 1024)),
    availableMb: Math.round(c.machine.availableBytes / (1024 * 1024)),
    agentMemoryMb: Math.round(c.cost.residentBytes / (1024 * 1024)),
    agentCores: c.cost.cores,
    // Where the two cost figures came from (KAN-56): 'override', 'measured'
    // or 'seed', plus the sample's metadata when a measurement was consulted.
    agentMemorySource: c.costSource.residentBytes,
    agentCoresSource: c.costSource.cores,
    measuredAt: c.measured ? new Date(c.measured.sampledAt).toISOString() : null,
    measuredWindowSeconds: c.measured ? Math.round(c.measured.windowSeconds) : null,
    measuredAgentTrees: c.measured ? c.measured.agentTrees : null,
    capByCpu: c.capByCpu,
    capByMemory: c.capByMemory,
    headroomByCap: c.headroomByCap,
    headroomByLoad: c.headroomByLoad,
    headroomByMemory: c.headroomByMemory,
    summary: summarizeCapacity(c)
  };
}

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
interface MissingAgent extends ConfigEcho {
  path: string;
  paneName: string;
  label: string | null;
  /** When the registry last recorded this agent as activated. */
  since: string;
  reason: string;
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
 * How many agents each of `list_agents`' categories will carry. The registry
 * compacts at 500 records, so these are bounded already — the cap is about
 * clients that poll continuously, not about the log. Anything beyond it is
 * *counted* rather than dropped silently.
 */
const FLEET_CATEGORY_LIMIT = 25;

/**
 * Newest first, then clipped, with the unclipped count returned alongside.
 *
 * The order matters as much as the cap: clipping an unordered list hides an
 * arbitrary subset, while clipping a newest-first one hides the oldest — which
 * for all of these categories is the least urgent thing in it.
 */
function clipFleetCategory<T>(
  rows: T[],
  when: (row: T) => string
): { rows: T[]; total: number } {
  const sorted = [...rows].sort((a, b) => when(b).localeCompare(when(a)));
  return { rows: sorted.slice(0, FLEET_CATEGORY_LIMIT), total: sorted.length };
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
  /** Replies to the requesting client. */
  send: (msg: DaemonResponse) => void;
  /** Events for every connected client (activations, teardowns, PTY deaths). */
  broadcast: (msg: DaemonResponse) => void;
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
 * that it comes from here. `launcher` is required for the reason KAN-53
 * records: an omitted launcher used to fall back to `shell`, which staffed
 * work with a bare bash prompt that answered `success: true` and executed
 * messages as shell commands.
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

  return {
    ok: true,
    config: {
      priority,
      refusable: flags.refusable,
      chargeable: flags.chargeable,
      preemptable: flags.preemptable,
      launcher: launcher.trim(),
      ...(prompt ? { prompt } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(label !== undefined ? { label } : {})
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
  // IT IS THE COMMAND THE PANE RUNS, resolved once when the agent was spawned.
  launcher: 'restart-required',
  // Written into the agent's sidecar and passed at spawn. The agent running
  // there has already read it.
  prompt: 'restart-required',
  // Written into `.mcp.json`, which the runtime reads once, at boot.
  mcpServers: 'restart-required'
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
    'Rewriting it under a live agent changes a file it will not read again'
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
 */
function knobValue(config: AgentConfig, name: keyof AgentConfig): unknown {
  const value = config[name];
  if (name === 'mcpServers' && value && Object.keys(value as object).length === 0) {
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
function configEcho(intent: AgentIntent | undefined): ConfigEcho {
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
      activatedBy: null
    };
  }
  return {
    // The frozen object itself, not a rebuild of it. A field-by-field copy here
    // would be a second place that has to learn about every attribute
    // `configure` grows, and the day it did not is the day the echo starts
    // lying by omission.
    config: intent.record.config,
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

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  constructor(private deps: RouterDeps) {}

  public handle(data: any): void {
    // Responses echo the request's `id` so a transport can correlate them.
    const respond: Respond = (msg) =>
      this.deps.send(data.id !== undefined ? { ...msg, id: data.id } : msg);

    // Fire-and-forget actions only reply when a caller asked to be
    // correlated, so a streaming client doesn't get an ack per keystroke.
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
        const intents = agentRegistry.intents();
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
          startedAt: daemonStartedAt.toISOString(),
          configPath: config.configPath,
          dataDir: config.dataDir,
          // What used to be `workspaceTypes` — the answer to "is the daemon up
          // with the config I just edited". There is no type table any more, so
          // the equivalent question is about the durable registry, which is now
          // the only place an agent's configuration exists.
          registryPath: agentRegistry.path,
          configuredAgents: intents.size,
          expectedAgents: Array.from(intents.values()).filter((i) => i.event === 'activated').length,
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
        this.handlePtyInput(data, ack);
        return;
      case 'pty_resize':
        this.handlePtyResize(data, ack);
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
   */
  private addressOfRequest(input: unknown, strict: boolean): { path: string } | { error: string } {
    try {
      return { path: canonicalPath(input) };
    } catch (e: any) {
      const recoverable =
        !strict && e instanceof PathError && e.problem === 'does-not-exist' && typeof input === 'string';
      if (!recoverable) {
        return { error: e?.message ?? String(e) };
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
            : running
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

    if (restartRequired.length) {
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
            `, and its configuration is still version ${existing!.configVersion}.\n` +
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
      })
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
      action: 'agent_configured_event',
      success: true,
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
      outcomes: outcomesWith(true)
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
      appliedInPlace: running && changed.length > 0,
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
      willWrite: willWrite.length
        ? [
            {
              file: path.join(agentPath, '.mcp.json'),
              keys: willWrite,
              when: 'at activation',
              note:
                `Merged into your file if you have one; never replacing it. Named again in the ` +
                `activation response, and removed by \`forget\`.`
            }
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
    const sidecar = this.deps.herdrBridge.sidecarDirFor(agentPath);
    const residue = removeProvisionedArtifacts({ agentPath, sidecarDir: sidecar });

    const durable = this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordForgotten(existing.record),
      `forgot ${agentPath}`
    );

    // 'record' first: it is the removal the caller asked for, and the artifacts
    // are what came with it.
    const removed = ['record', ...residue.removed];

    this.deps.broadcast({
      action: 'agent_forgotten_event',
      success: true,
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
    const { path: agentPath, paneName, priority, refusable, override, preempt } = request;
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

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — an agent
    // on a machine full of agents of its own priority outranks nothing.
    const candidates = this.preemptionCandidates(agents, agentPath);
    const victim = selectVictim(candidates, priority);
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
        { path: victim.path, preemption },
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
          derivation;
        console.error(`[capacity] preemption aborted: ${error}`);
        return { capacity, refusal: error, overrode: null, preemptable: offer(victim), preempted: null };
      }

      console.warn(
        `[capacity] preemption: ${agentPath} (priority ${priority}) stood down ` +
        `${describeCandidate(victim)} at ${at}\n${derivation}`
      );
      // The event carries the full PreemptionRecord. The durable copy was
      // written by the stand-down above, which is what keeps `preemptedAgents`
      // reporting this debt until somebody re-activates the victim. The
      // broadcast is the live announcement, not the record, but nothing here
      // may drop a field of it: it is also what a client renders.
      this.deps.broadcast({
        action: 'agent_preempted_event',
        success: true,
        at,
        victim: offer(victim),
        by: { path: agentPath, paneName, priority },
        record: preemption,
        capacity: capacityDto(capacity)
      });

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
        (victim ? preemptionOffer(victim, priority) : noVictimReason(candidates, priority));
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
      action: 'capacity_override_event',
      success: true,
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
   */
  private rememberActivated(record: AgentRecord, caller: string | null): RecordOutcome {
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
    const toWrite: AgentRecord =
      activatedBy === record.activatedBy ? record : { ...record, activatedBy };

    if (
      current?.event === 'activated' &&
      JSON.stringify(current.record.config) === JSON.stringify(toWrite.config) &&
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
   * failure is the KAN-21 silent loss re-entering through the error path: the
   * agent exists, the disk does not know, and the next boot forgets it. So
   * the failure is broadcast to every connected client, and the caller puts
   * `durable: false` on its response, which is the difference between "the
   * daemon said yes and the disk knows" and "the daemon said yes".
   */
  private surfaceRegistryOutcome(outcome: RecordOutcome, what: string): RecordOutcome {
    if (!outcome.ok) {
      this.deps.broadcast({
        action: 'registry_degraded_event',
        success: false,
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
    // registration over a dead pane must not verify (KAN-58). Sessions that
    // reached this point were built by initPty, which sets the field; an
    // unset one gets the strict reading rather than the lenient one.
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
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'activate_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
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
        { path: agentPath, refused: 'unverifiable', verified: false, started: false }
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
      // AND `null` FOR THE CALLER, WHICH IS THE WHOLE OF KAN-145'S LESSON IN
      // ONE ARGUMENT. This is the branch that runs when the agent is ALREADY
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
        // KAN-23 false success in its other direction.
        if (session.spawnError) {
          fail(session.spawnError, {
            path: agentPath,
            paneName,
            paneId: occupancy.ours.paneId,
            alreadyRunning: true,
            started: false,
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
          action: 'agent_activated_event',
          success: true,
          path: agentPath,
          paneName,
          paneId: occupancy.ours.paneId,
          sessionId: session.sessionId,
          status: session.status
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
        ...configEcho(this.deps.agentRegistry.intents().get(agentPath)),
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
          started: false,
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
          started: false,
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
      fail(session.spawnError, { path: agentPath });
      return;
    }

    const confirmed = await this.confirmActivation(session);
    if ('error' in confirmed) {
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
    const durable = this.rememberActivated(intent.record, callerIdentity(data));

    this.deps.broadcast({
      action: 'agent_activated_event',
      success: true,
      path: agentPath,
      paneName,
      paneId: confirmed.paneId,
      sessionId: session.sessionId,
      status: session.status
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
      ...configEcho(this.deps.agentRegistry.intents().get(agentPath)),
      // Not decoration: it is the difference between this response and the
      // KAN-23 false success. `true` means the agent was found in herdr's
      // census before this was sent, and success is never reported without it.
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
        action: 'agent_deactivated_event',
        success: true,
        path: session.path,
        paneName: session.paneName,
        sessionId: session.sessionId
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
          action: 'agent_deactivated_event',
          success: true,
          path: agentPath,
          paneName: session.paneName,
          sessionId: session.sessionId,
          ...(preemption ? { preempted: true } : {})
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
        action: 'agent_deactivated_event',
        success: true,
        path: agentPath,
        paneName: result.paneName,
        ...(preemption ? { preempted: true } : {})
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
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', success: false, error });

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
      (err) => fail(err?.message ?? String(err))
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
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'agent_status_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
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
    const echo = configEcho(intent);

    if (session) {
      // From the census this handler already took, rather than a second read.
      // Two reads of herdr can disagree, and `state` above and `herdrStatus`
      // here would then be two answers about the same pane at two moments —
      // which is exactly the ambiguity a caller diffing against us cannot
      // resolve. It also drops a subprocess from every status call.
      const pane = census.agents.find((a) => a.name === session.paneName);
      respond({
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
        provenance: this.provenance(census)
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
          provenance: this.provenance(census)
        }
      );
      return;
    }

    respond({
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
      provenance: this.provenance(census)
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
   * The legend that says which fields of this response are durable, which were
   * observed just now, and which this daemon computed.
   *
   * On the response rather than only in the docs, because conflating durable
   * state with a live observation is precisely the ambiguity the config echo
   * exists to remove — and `paneId` is a value that a consumer would otherwise
   * quite reasonably store.
   *
   * NOT THE SAME PROVENANCE AS `provenance.ts`, and the two are worth telling
   * apart because they arrived within an hour of each other. That module
   * answers "which BUILD is this daemon running", on `daemon_status` as
   * `build` and `freshness`. This answers "where did each FIELD of this agent's
   * state come from", on `agent_status` and `list_agents`. Different question,
   * different response, no shared field name on the wire.
   */
  private provenance(census: HerdrCensus) {
    return {
      ...STATE_READ_PROVENANCE,
      /** When the census behind every `observed` field answered. */
      observedAt: new Date().toISOString(),
      /**
       * Whether herdr answered at all. `false` means every `observed` field is
       * this daemon's last resort rather than a reading — an empty census from
       * an unreachable herdr is silence, not evidence, and a reader must not
       * take an absent pane as proof the agent is down.
       */
      censusReachable: census.reachable,
      note:
        'durable fields come from the append-only agent registry and survive a daemon ' +
        'restart unchanged; observed fields were read from herdr for THIS response and ' +
        'are true as of observedAt; derived fields are computed from the two. paneId is ' +
        'observed, never durable — herdr pane ids are positions in a list that compacts.'
    };
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
  private handleListAgents(_data: any, respond: Respond) {
    // One read of the registry for the whole response. Several of the fields
    // below are derived from it, and asking it repeatedly was both several
    // whole-file parses per poll and several chances for an append landing
    // mid-response to make the categories contradict each other.
    const intents = this.deps.agentRegistry.intents();

    const { agents, unbackedPanes, foreignPanes, staleSessions, census } =
      this.surveyAgents(intents);

    // Agents that should be here and are not. Computed from the same census the
    // list is built from, so the two can never disagree about what is running.
    const missing = clipFleetCategory(
      this.missingAgents(agents, staleSessions, intents),
      (row) => row.since
    );

    // Work taken off the machine to make room, still owed a decision.
    const preempted = clipFleetCategory(
      this.preemptedAgents(agents, intents),
      (row) => row.at
    );

    // Agents a person switched off. From the same census for the same reason:
    // an agent that is running must never be offered an On button.
    const { standby, total: standbyTotal } = this.standbyAgents(agents, intents);

    // Agents that exist and have never run. Same census, same reason: an agent
    // that is running must never be offered as one that has yet to start.
    const { unstarted, total: unstartedTotal } = this.unstartedAgents(agents, intents);

    const foreign = clipFleetCategory(foreignPanes, (row) => row.paneName);

    // Descriptor headroom, reported where someone looking at agents will see
    // it. Expressed in panes because that is the unit the reader can act on.
    const usage = readFdUsage();

    // CPU and memory headroom, for the same reason and in the same place.
    const capacity = this.capacityOf(agents);

    // THE CATEGORIES, AS ONE TYPED VALUE. Spread into the response rather than
    // listed inline, so `FleetCategories` is what the payload's row-carrying
    // keys are built from — and `FleetCategoriesCarryTheEcho` then holds every
    // one of them to `ConfigEcho[]` at compile time. Adding a category to this
    // object without adding it to the interface is a build error; adding one
    // straight to `respond` below is not, and §3 of verify-activated-by.mjs is
    // what covers that. Both are stated on `FleetCategories`.
    const categories: FleetCategories = {
      agents,
      unbackedPanes,
      missingAgents: missing.rows,
      preemptedAgents: preempted.rows,
      standbyAgents: standby,
      unstartedAgents: unstarted
    };

    respond({
      action: 'list_agents_response',
      success: true,
      ...categories,
      // Live panes that are not ours. The rows whose `occupies` is non-null
      // are the ones that will refuse an activation, so a reader can see the
      // refusal coming rather than meeting it.
      foreignPanes: foreign.rows,
      foreignPanesTotal: foreign.total,
      // `missingAgents` is in `categories` above. Always present, even when
      // empty: a caller that has to distinguish "no agents are missing" from
      // "this daemon does not track that" cannot do it from an absent field.
      // Empty array means the fleet is whole.
      missingTotal: missing.total,
      // Work that was taken off the machine to make room for something more
      // important, and has not been put back. It is a queue of decisions still
      // owed rather than a log of events: the moment one of these is
      // re-activated it leaves the list. Nothing here restarts them,
      // deliberately — a preemption queue that restarts its own entries is a
      // scheduler, and preemption must never be automatic.
      preemptedTotal: preempted.total,
      // `standbyAgents` is in `categories` above — where a fleet client's On
      // button gets its candidates.
      standbyTotal,
      // Agents that exist and have NEVER run — the fifth answer to "not
      // running", and the one that used to belong to no list at all. Kept
      // separate from standby because the difference is behavioural: switching
      // a standby agent on resumes the conversation it was stopped in, and
      // these have no conversation to resume. Always present, even when empty,
      // for the same reason `missingAgents` is.
      unstartedTotal,
      // Which fields above are durable, which were observed just now, and
      // which this daemon computed. See MessageRouter.provenance.
      provenance: this.provenance(census),
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
    });
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
        ...configEcho(intents.get(entry.path)),
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
    staleSessions?: Set<string>,
    sharedIntents?: Map<string, AgentIntent>
  ): MissingAgent[] {
    const alive = new Set(agents.map((a) => a.path));
    const missing: MissingAgent[] = [];

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      if (intent.event !== 'activated') continue;
      if (alive.has(agentPath)) continue;

      missing.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        // A loss is the row a supervisor most needs the configuration on: the
        // decision it prompts is "re-activate this or stand it down", and both
        // halves of that need to know what would come back.
        ...configEcho(intent),
        since: intent.at,
        // Both cases are "not running", but they are not the same event and a
        // reader acting on this deserves the difference: an agent that never
        // came back, versus one that was running under this daemon and died
        // while we held its session. The second is a crash we witnessed.
        reason: staleSessions?.has(agentPath)
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
  ): { standby: StandbyAgent[]; total: number } {
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
        ...configEcho(intent),
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

    const clipped = clipFleetCategory(standby, (row) => row.since);
    return { standby: clipped.rows, total: clipped.total };
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
  ): { unstarted: UnstartedAgent[]; total: number } {
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
        ...configEcho(intent),
        since: intent.at,
        reason:
          'Configured and never activated. It has no conversation, so activating it starts ' +
          'a fresh one with the prompt on its record — unlike a standby agent, where the ' +
          'same call resumes the conversation it was stopped in.'
      });
    }

    const clipped = clipFleetCategory(unstarted, (row) => row.since);
    return { unstarted: clipped.rows, total: clipped.total };
  }

  /**
   * `missingAgents`, for callers outside a request — the daemon's periodic
   * sweep. Public because the sweep runs on a timer rather than in response to
   * a client, and must ask the same question the list answers.
   */
  public findMissingAgents(): MissingAgent[] {
    const intents = this.deps.agentRegistry.intents();
    const { agents, staleSessions } = this.surveyAgents(intents);
    return this.missingAgents(agents, staleSessions, intents);
  }

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
      ...configEcho(intent),
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
                  ...configEcho(occupied)
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
        ...configEcho(intents.get(agentPath)),
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

  private handlePtyInput(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    // The most dangerous of the three to answer approximately: keystrokes sent
    // to a session picked on the client's behalf land in some other agent's
    // terminal, and get executed there.
    if (!this.deps.herdrBridge.writePty(sessionId ?? undefined, data.data)) {
      ack({
        action: 'pty_input_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_input', sessionId)
      });
      return;
    }
    ack({ action: 'pty_input_response', success: true, sessionId });
  }

  private handlePtyResize(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    if (!this.deps.herdrBridge.resizePty(sessionId ?? undefined, data.cols, data.rows)) {
      ack({
        action: 'pty_resize_response',
        success: false,
        sessionId,
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
