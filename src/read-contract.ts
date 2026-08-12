/**
 * THE READ-PATH CONTRACT, as data (KAN-277).
 *
 * `docs/read-path-contract.md` is the document a consumer builds against; this
 * file is its executable half, the way `src/events.ts` is the executable half
 * of `docs/event-contract.md`. The table there and the lists here are the same
 * table, and `scripts/verify-read-contract.mjs` reconciles them in both
 * directions against a REAL daemon's responses — so a field added to a response
 * and not to the document goes red, and a field in the document that no
 * response carries goes red too.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * Nine events are published field by field and enforced. The two responses a
 * reconciler actually reads — `list_agents` and `agent_status` — were exercised
 * inside proofs and published nowhere, so the guarantee a consumer needs most
 * was on the path the document did not describe. Butchr asserted our response
 * shape in THEIR repository, which means it was not our contract at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A THIRD SURFACE HERE (KAN-287)
 *
 * `activate_response` was consumed, branched on, and covered by none of the
 * three artifacts. The asymmetry was the defect rather than the absence: a
 * consumer that has read this contract, and seen the notice promise, reasonably
 * assumes a documented-and-enforced surface is the norm — and a guarantee that
 * holds for two responses and silently not for a third is worse than one that
 * holds for none, because the boundary is invisible. So the surface is
 * enumerated here, and §10 of the document now states where the contract STOPS
 * rather than leaving a reader to infer it from what happens to be listed.
 *
 * IT IS NOT A READ, AND THAT CHANGES WHAT THE BUCKETS MEAN — see
 * {@link ACTIVATE_RESPONSE_FIELDS}. `list_agents` and `agent_status` answer
 * "what is true now"; this one answers "what did this call just do". The four
 * buckets were defined for the first question, and applying them to the second
 * is done deliberately and with the seam named, not silently.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 *
 * It is NOT a projection, a filter or a validator, and nothing on the read path
 * consults it at runtime. The event path's declaration is load-bearing — the
 * MCP forwarder projects to it and drops what it does not name — and copying
 * that shape here would have changed the surface this ticket exists to
 * describe. So this is a declaration a PROOF reads, not one a response passes
 * through. Two consequences worth stating rather than discovering:
 *
 *   * A field added to a response still travels. Nothing here removes it; what
 *     happens is that the proof goes red in CI, before review.
 *   * The compile-time bindings below (`Exact<…>` in `src/router.ts`) are the
 *     half that fires at BUILD time, and they only reach the blocks that have a
 *     named type. The response objects are assembled inline in
 *     `handleListAgents` and `handleAgentStatus`, and TypeScript has no exact
 *     type for an object literal spread into `respond({…})` — so the top-level
 *     field sets are held by the proof and by nothing else. That split is
 *     written down in the document under "How this is enforced", because a
 *     reader who assumes the compiler covers all of it would be assuming
 *     coverage that does not exist.
 */

import type { CapBound, CostSource, HeadroomBound } from './capacity.js';
import { CAPACITY_FIELDS, type Exact } from './events.js';
import type { HerdrAgentStatus } from './herdr.js';
import type { StallSource } from './machine-pressure.js';
import type { ArtifactKind, ArtifactOrigin } from './provisioning.js';
import type { ResumeCause } from './resume.js';

// ---------------------------------------------------------------- the version

/**
 * THE CONTRACT VERSION, ON THE WIRE IN EXACTLY ONE PLACE — `daemon_status`.
 *
 * WHAT IT MEANS: the revision of `docs/read-path-contract.md` that the
 * ANSWERING PROCESS implements. It is an integer and it increments by one.
 *
 * WHEN IT MOVES: on any change to a field this contract documents — the same
 * set of changes the stability statement promises a notice for. That is
 * deliberate rather than a coincidence: the version and the notice promise are
 * one rule written twice, once for a machine and once for a person. A consumer
 * that pinned against version N and reads N+2 knows there are two notices it
 * has not read, without diffing anything.
 *
 * WHY `daemon_status` AND NOT A HELLO OR EVERY RESPONSE — the argument, kept
 * beside the number rather than only in the pull request:
 *
 *   * `daemon_status` is already the "which CrabCast am I talking to" response.
 *     It carries `pid`, `startedAt`, `build` and `freshness`, and KAN-227 made
 *     it the tenth MCP tool, so it is reachable from the socket, the CLI and
 *     MCP alike. A consumer asking which contract it is holding is asking the
 *     question that response exists to answer, and a third identity field there
 *     needs no new vocabulary.
 *   * NOT A HELLO, because this socket has none. It is request/response NDJSON
 *     with no handshake, and inventing one to carry an integer would be a
 *     protocol change made for a field — exactly the widening this ticket's
 *     scope discipline forbids.
 *   * NOT ON EVERY RESPONSE, and this is the half worth reading. The objection
 *     to one place is "a consumer polling `list_agents` would have to remember
 *     to ask" — and it does not, because the invalidation signal is already on
 *     every response it reads. The version is a property of the PROCESS, and a
 *     process's identity change is announced by `bootId`, which rides every
 *     `list_agents` response and every event. So the rule is: read it once, and
 *     re-read it when `bootId` changes. Putting it on every response would be N
 *     copies per poll of a fact that cannot change without `bootId` changing
 *     too, and the second copy is the one that goes stale.
 *
 * WHAT NOTHING ENFORCES, said here because a version that silently fails to
 * move is worse than none: NOTHING MAKES THIS NUMBER INCREMENT. The proof holds
 * the document, this constant and the wire to the same value, and holds the
 * document's version table to a row for it whose digest matches this
 * declaration — so changing a field without touching the table is red, and
 * rewriting an existing row's digest instead of adding one is a diff a reviewer
 * sees. Neither is the compiler. The bump is a human step, exactly as the
 * notice is.
 */
export const READ_CONTRACT_VERSION = 5;

// ------------------------------------------------------------ the four buckets

/**
 * Where a field came from — the same four the responses' own `provenance`
 * legend uses, and the thing that tells a consumer whether an absence means
 * "not known" or "not true".
 *
 * The definitions are `STATE_READ_PROVENANCE`'s in `src/router.ts`, not a
 * paraphrase of them:
 *
 *   durable     read from the append-only registry; survives a daemon restart
 *               unchanged, because it never lived in memory
 *   observed    read live, from the census or session that answered THIS call;
 *               true as of `provenance.observedAt` and not one moment longer
 *   derived     computed by this daemon from the two above, or from the identity
 *   remembered  this process's own accumulated memory: on no record, from no
 *               census, and gone on a restart
 *
 * ROW FIELDS ARE CLASSIFIED ON THE WIRE; RESPONSE-LEVEL FIELDS ARE NOT. The
 * `provenance` block a response carries names row fields only — that is what it
 * was built for, and widening it would change the surface this contract
 * describes. So the buckets below are the SAME four definitions applied to the
 * response-level fields as well, and `verify-read-contract.mjs` §4 asserts that
 * every ROW field's bucket here is byte-identical to the bucket the live legend
 * puts it in, in both directions. Where the two could disagree, they are
 * checked; where the legend is silent, the classification is this contract's
 * and the document says so.
 */
export type ProvenanceBucket = 'durable' | 'observed' | 'derived' | 'remembered';

/** What the contract says about one field of one response. */
export interface ReadFieldSpec {
  readonly bucket: ProvenanceBucket;
  /**
   * Present only on some responses, with the condition that decides it stated
   * in the document. An OPTIONAL FIELD IS NOT A NULLABLE ONE: every nullable
   * field on this surface is emitted as an explicit `null`, because over JSON
   * an absent key reads as "not answered" and these are answered.
   */
  readonly optional?: true;
  /**
   * This field is an array of rows of the named shape in {@link ROW_SHAPES}.
   *
   * `string` rather than `keyof typeof ROW_SHAPES`, and the reason is
   * mechanical rather than a preference: `ROW_SHAPES`'s own entries are typed
   * against this interface, so naming it here is a circular reference the
   * compiler declines. Referential integrity — every `rows` and `block` naming
   * a shape that exists — is asserted instead by `verify-read-contract.mjs` §1,
   * which is where an unresolvable name would otherwise become an empty field
   * set that every completeness check passes vacuously.
   */
  readonly rows?: string;
  /** This field is an object of the named shape in {@link BLOCK_SHAPES}. */
  readonly block?: string;
}

type FieldTable = Readonly<Record<string, ReadFieldSpec>>;

// ------------------------------------------------------------------ the rows

/**
 * Every row-carrying shape on the read path, field by field with its bucket.
 *
 * BOUND TO THE INTERFACES AT COMPILE TIME. `src/router.ts` asserts
 * `Exact<keyof ListedAgent, keyof typeof ROW_SHAPES.ListedAgent>` and one of
 * those for each shape below, so a row interface that grows a field without a
 * line here does not build. That is the "vice versa" half of this contract's
 * acceptance criterion, and it fires before the proof does.
 *
 * The `config` echo's five fields are on EVERY shape here, spelled out rather
 * than spread, because `ConfigEcho` is an interface a row extends and the
 * binding above is over the row's whole key set. `ConfigEcho` gets its own
 * entry too, for the one place it appears nested rather than spread
 * (`foreignPanes[].occupiedAgent`).
 */
export const ROW_SHAPES = {
  /** A live agent — `list_agents.agents[]`. The only shape carrying a `remembered` field. */
  ListedAgent: {
    sessionless: { bucket: 'observed' },
    state: { bucket: 'derived' },
    configured: { bucket: 'durable' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    paneId: { bucket: 'observed' },
    sessionId: { bucket: 'observed' },
    createdAt: { bucket: 'observed' },
    status: { bucket: 'observed' },
    herdrStatus: { bucket: 'observed' },
    statusSince: { bucket: 'remembered' },
    agentRuntime: { bucket: 'observed' },
    label: { bucket: 'durable' },
    refusable: { bucket: 'durable' },
    chargeable: { bucket: 'durable' },
    preemptable: { bucket: 'durable' }
  } satisfies FieldTable,

  /** One of ours with nothing behind it — `list_agents.unbackedPanes[]`. */
  UnbackedPane: {
    paneName: { bucket: 'derived' },
    paneId: { bucket: 'observed' },
    path: { bucket: 'durable' },
    herdrStatus: { bucket: 'observed' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    reason: { bucket: 'derived' }
  } satisfies FieldTable,

  /** Recorded active, absent anyway — `list_agents.missingAgents[]`. */
  MissingAgent: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    label: { bucket: 'durable' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    since: { bucket: 'durable' },
    reason: { bucket: 'derived' }
  } satisfies FieldTable,

  /** Stood down to make room — `list_agents.preemptedAgents[]`. */
  PreemptedAgent: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    label: { bucket: 'durable' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    at: { bucket: 'durable' },
    priority: { bucket: 'durable' },
    herdrStatusWhenPreempted: { bucket: 'durable' },
    by: { bucket: 'durable', block: 'PreemptedBy' },
    reason: { bucket: 'derived' },
    derivation: { bucket: 'durable' }
  } satisfies FieldTable,

  /** Switched off, and it has run — `list_agents.standbyAgents[]`. */
  StandbyAgent: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    label: { bucket: 'durable' },
    launcher: { bucket: 'durable' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    since: { bucket: 'durable' },
    /** Only on a row that reached standby through preemption-annotation compaction. */
    wasPreempted: { bucket: 'durable', optional: true },
    reason: { bucket: 'derived' }
  } satisfies FieldTable,

  /** Configured and never run — `list_agents.unstartedAgents[]`. */
  UnstartedAgent: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    label: { bucket: 'durable' },
    launcher: { bucket: 'durable' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' },
    since: { bucket: 'durable' },
    reason: { bucket: 'derived' }
  } satisfies FieldTable,

  /**
   * A registry row this daemon could not read — `list_agents.unreadableRecords[]`
   * and `daemon_status.unreadableRecords[]` (KAN-302).
   *
   * THE ONE ROW SHAPE THAT IS NOT AN AGENT, and the only one carrying no config
   * echo. Every other shape here describes something that WAS read; this one
   * describes a line that was not, which is why it has no `path` (a
   * pre-migration row may name none), no `state` and nothing to switch on.
   *
   * THE SPLIT BETWEEN `durable` AND `derived` HERE IS EXACT RATHER THAN
   * APPROXIMATE, and it is worth reading because three of these look durable
   * and are not. `identity`, `raw` and `claimsPath` are the row's own bytes,
   * read off the append-only registry and surviving a restart unchanged — the
   * bucket's definition. The other four are this daemon's account OF that row
   * rather than anything the row says about itself:
   *
   *   - `problem` and `reason` are a VERDICT, and it is this daemon's verdict.
   *     A newer CrabCast reading the same line may classify it differently —
   *     `from-newer` is the case that makes that concrete — so a consumer must
   *     not cache either across a `bootId` change.
   *   - `line` is a count of newlines, and compaction rewrites the file, so it
   *     moves without the row changing at all.
   *   - `rawTruncated` and `promptRedacted` describe what this response did to
   *     the bytes, which is a fact about the response.
   */
  UnreadableRecord: {
    line: { bucket: 'derived' },
    problem: { bucket: 'derived' },
    identity: { bucket: 'durable' },
    reason: { bucket: 'derived' },
    raw: { bucket: 'durable' },
    rawTruncated: { bucket: 'derived' },
    promptRedacted: { bucket: 'derived' },
    claimsPath: { bucket: 'durable' }
  } satisfies FieldTable,

  /** A live pane that is not ours — `list_agents.foreignPanes[]`. */
  ForeignPane: {
    paneName: { bucket: 'derived' },
    paneId: { bucket: 'observed' },
    workDir: { bucket: 'observed' },
    occupies: { bucket: 'derived' },
    herdrStatus: { bucket: 'observed' },
    agentRuntime: { bucket: 'observed' },
    occupiedAgent: { bucket: 'durable', block: 'OccupiedAgent' }
  } satisfies FieldTable,

  /** What an activation would have to outrank — `list_agents.priorities[]`. */
  PriorityRow: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'derived' },
    priority: { bucket: 'durable' },
    herdrStatus: { bucket: 'observed' }
  } satisfies FieldTable,

  /**
   * A live pane in a directory, as an `activate` refusal names it (KAN-287) —
   * `activate_response.occupiedBy[]`, on the `occupied` refusal and beside a
   * successful idempotent activation that found a co-occupant.
   *
   * ALL FOUR ARE `observed`, AND THE ROW IS THE CLEAREST CASE ON THIS SURFACE:
   * it is one census read, quoted. Nothing here is on a record — these panes are
   * very often not ours at all, which is the whole reason the refusal names them
   * — and nothing is re-checked after the response is sent. A caller that acts on
   * a pane listed here is acting on where it was at `activate` time.
   */
  PaneOccupant: {
    paneId: { bucket: 'observed' },
    name: { bucket: 'observed' },
    agentStatus: { bucket: 'observed' },
    workDir: { bucket: 'observed' }
  } satisfies FieldTable,

  /**
   * One artifact this activation wrote or relied on outside CrabCast's own data
   * directory — `activate_response.provisioned[]`.
   *
   * `derived` THROUGHOUT, AND NOT `durable`, WHICH IS THE ONE THAT LOOKS WRONG
   * UNTIL THE BUCKET IS READ AS WRITTEN. Every row describes a file on somebody's
   * disk, so `durable` is the tempting answer — but the bucket does not mean
   * "persists"; it means READ FROM THE APPEND-ONLY AGENT REGISTRY. None of this
   * is: it is this daemon's account, composed during the call, of writes it just
   * performed. It is also not re-read before being sent, so a row here says what
   * provisioning DID rather than what the file contains now. `provisioned.json`
   * is the durable record of the same facts, and `verify-agy-reads-what-we-write`
   * is what holds it — this is the response's copy, not that file.
   */
  ProvisionedArtifact: {
    artifact: { bucket: 'derived' },
    file: { bucket: 'derived' },
    detail: { bucket: 'derived' },
    origin: { bucket: 'derived' },
    reversal: { bucket: 'derived' }
  } satisfies FieldTable
} as const;

// ---------------------------------------------------------------- the blocks

/**
 * Every named object on the read path that is not a row.
 *
 * `Capacity` is derived from `CAPACITY_FIELDS` rather than restated — that list
 * is already the declaration `capacityDto` is compile-time bound to, and a
 * second copy of it here would be the drift this whole file exists to remove.
 * What is added is the bucket per field, which `CAPACITY_FIELDS` does not carry
 * and which is the question a consumer of a capacity number actually has.
 */
const CAPACITY_BUCKETS: { [K in keyof typeof CAPACITY_FIELDS]: ProvenanceBucket } = {
  // The arithmetic. Computed here, from the observations below and the record.
  cap: 'derived',
  running: 'derived',
  exemptAgents: 'derived',
  headroom: 'derived',
  atCapacity: 'derived',
  capBoundBy: 'derived',
  headroomBoundBy: 'derived',
  reason: 'derived',
  // The machine, read for THIS response.
  cores: 'observed',
  load1: 'observed',
  cpuBusyCores: 'observed',
  cpuWindowSeconds: 'observed',
  cpuObservedAt: 'observed',
  totalMb: 'observed',
  availableMb: 'observed',
  // What an agent costs. `*Source` says which of the three it is, and only
  // `override` is durable — a measured or seeded figure is not on any record.
  agentMemoryMb: 'observed',
  agentCores: 'observed',
  agentMemorySource: 'derived',
  agentCoresSource: 'derived',
  measuredAt: 'observed',
  measuredWindowSeconds: 'observed',
  measuredAgentTrees: 'observed',
  // The terms, each one arithmetic over the above.
  capByCpu: 'derived',
  capByMemory: 'derived',
  headroomByCap: 'derived',
  headroomByCpu: 'derived',
  headroomByLoad: 'derived',
  headroomByMemory: 'derived',
  // The stall veto (KAN-216). The percentage and its instrument are read from
  // the kernel now; `stalled` and the two figures beside it are arithmetic.
  stallPercent: 'observed',
  stallSource: 'observed',
  stallInstrument: 'observed',
  stalled: 'derived',
  stallRefusePercent: 'derived',
  headroomBeforeStall: 'derived',
  // The starts-in-flight charge (KAN-263): what the CPU-side reading cannot
  // have contained, because those agents did not exist for the window it
  // averaged. ALL FIVE ARE `derived` AND NONE IS `observed`, which is the whole
  // point of the term rather than a filing detail — these figures exist
  // precisely because no instrument observed the thing they describe. They are
  // arithmetic over a ledger of start instants this process kept, and the ledger
  // is not durable either: it is module state, and a daemon that restarts
  // correctly starts with none.
  startsCharged: 'derived',
  startsConsidered: 'derived',
  startsChargeCores: 'derived',
  startsChargeBasis: 'derived',
  startsChargeBecause: 'derived',
  summary: 'derived'
};

export const BLOCK_SHAPES = {
  /** `list_agents.capacity` and the `capacity` on a refused `activate`. */
  Capacity: Object.fromEntries(
    Object.keys(CAPACITY_FIELDS).map((f) => [
      f,
      { bucket: CAPACITY_BUCKETS[f as keyof typeof CAPACITY_FIELDS] } as ReadFieldSpec
    ])
  ) as FieldTable,

  /** One entry of `list_agents.pages`, one per paged category. */
  FleetPage: {
    returned: { bucket: 'derived' },
    total: { bucket: 'derived' },
    limit: { bucket: 'derived' },
    remaining: { bucket: 'derived' },
    nextCursor: { bucket: 'derived' }
  } satisfies FieldTable,

  /** The legend both read responses carry. */
  Provenance: {
    durable: { bucket: 'derived' },
    observed: { bucket: 'derived' },
    derived: { bucket: 'derived' },
    remembered: { bucket: 'derived' },
    observedAt: { bucket: 'observed' },
    censusReachable: { bucket: 'observed' },
    note: { bucket: 'derived' }
  } satisfies FieldTable,

  /** The declared-field report both read responses carry (KAN-166, KAN-168). */
  ConfigEchoContract: {
    declared: { bucket: 'derived' },
    verbatim: { bucket: 'derived' },
    drops: { bucket: 'derived' },
    undeclared: { bucket: 'derived' },
    note: { bucket: 'derived' }
  } satisfies FieldTable,

  /** `list_agents.herdrHealth` — present only when the descriptor count could be read. */
  HerdrHealth: {
    pid: { bucket: 'observed' },
    openFds: { bucket: 'observed' },
    softLimit: { bucket: 'observed' },
    headroomPanes: { bucket: 'derived' },
    fdPressure: { bucket: 'derived' },
    /** Only above the pressure threshold. */
    warning: { bucket: 'derived', optional: true }
  } satisfies FieldTable,

  /** `preemptedAgents[].by` — who took the slot. */
  PreemptedBy: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'durable' },
    priority: { bucket: 'durable' }
  } satisfies FieldTable,

  /**
   * `foreignPanes[].occupiedAgent` — OUR agent for the directory a stranger's
   * pane is sitting in, or null. Nested rather than spread precisely so a
   * `config` on a foreign row cannot be read as the stranger's.
   */
  OccupiedAgent: {
    path: { bucket: 'durable' },
    state: { bucket: 'derived' },
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' }
  } satisfies FieldTable,

  /**
   * `activate_response.preemption` — what a capacity refusal WOULD stand down
   * if the caller asked again with `preempt` (KAN-287). An offer, not an event:
   * nothing has been stood down when this block is on the wire.
   *
   * `incomingPriority` and `offer` are this daemon's arithmetic and its sentence;
   * the other four describe the agent that would lose its slot, and `path`,
   * `paneName` and `priority` are its record while `herdrStatus` is what herdr
   * said about it during the census this refusal read.
   */
  PreemptionOffer: {
    path: { bucket: 'durable' },
    paneName: { bucket: 'durable' },
    priority: { bucket: 'durable' },
    herdrStatus: { bucket: 'observed' },
    incomingPriority: { bucket: 'derived' },
    offer: { bucket: 'derived' }
  } satisfies FieldTable,

  /**
   * `activate_response.preempted` — what this activation ACTUALLY stood down.
   * The same offer shape one field in, plus when it happened and the arithmetic
   * that made it necessary.
   *
   * THE DIFFERENCE FROM {@link PreemptionOffer} IS TENSE AND IT IS THE WHOLE
   * POINT: `preemption` rides a REFUSAL and describes a thing that has not
   * happened; `preempted` rides a SUCCESS and describes a thing that has. A
   * caller that confuses them either interrupts work it did not mean to or
   * reports an interruption that never occurred, and no field name alone
   * separates them — the branch does.
   */
  Preempted: {
    at: { bucket: 'derived' },
    victim: { bucket: 'derived', block: 'PreemptionOffer' },
    derivation: { bucket: 'derived' }
  } satisfies FieldTable,

  /**
   * `activate_response.capacityOverride` — present only when the activation
   * proceeded ONLY because the caller passed `override`, with the derivation the
   * gate would have refused on. All three are this daemon's account of a decision
   * it made during this call.
   */
  CapacityOverride: {
    at: { bucket: 'derived' },
    derivation: { bucket: 'derived' },
    capacity: { bucket: 'derived', block: 'Capacity' }
  } satisfies FieldTable,

  /** The config echo, for the one place it is nested under its own key. */
  ConfigEcho: {
    config: { bucket: 'durable' },
    configVersion: { bucket: 'durable' },
    configuredAt: { bucket: 'durable' },
    everActivated: { bucket: 'durable' },
    activatedBy: { bucket: 'durable' }
  } satisfies FieldTable
} as const;

// ------------------------------------------------------- list_agents_response

/**
 * `list_agents`, field by field.
 *
 * THE SUCCESS SHAPE. A refused `list_agents` is a different and much smaller
 * object — see {@link LIST_AGENTS_REFUSAL_FIELDS}, which is the one place on
 * this surface where a refusal carries LESS than `agent_status`'s does, and the
 * document says why rather than leaving a reader to find out.
 */
export const LIST_AGENTS_FIELDS = {
  action: { bucket: 'derived' },
  success: { bucket: 'derived' },

  // The seven row-carrying categories. `agents` and `unbackedPanes` are built
  // from the herdr census and are complete in every response; the other five
  // are paged.
  agents: { bucket: 'derived', rows: 'ListedAgent' },
  unbackedPanes: { bucket: 'derived', rows: 'UnbackedPane' },
  missingAgents: { bucket: 'derived', rows: 'MissingAgent' },
  preemptedAgents: { bucket: 'derived', rows: 'PreemptedAgent' },
  standbyAgents: { bucket: 'derived', rows: 'StandbyAgent' },
  unstartedAgents: { bucket: 'derived', rows: 'UnstartedAgent' },
  foreignPanes: { bucket: 'derived', rows: 'ForeignPane' },

  // How big each paged category is, whatever this page carried. These say how
  // many rows are missing and never which; `pages` is the handle to the rest.
  missingTotal: { bucket: 'derived' },
  preemptedTotal: { bucket: 'derived' },
  standbyTotal: { bucket: 'derived' },
  unstartedTotal: { bucket: 'derived' },
  foreignPanesTotal: { bucket: 'derived' },

  /**
   * Registry rows this daemon could not read (KAN-302). Present-and-empty on a
   * wholly readable registry; NOT paged, and `UNREADABLE_DISCLOSURE_LIMIT` in
   * `src/router.ts` says why a fault report is bounded rather than walkable.
   */
  unreadableRecords: { bucket: 'durable', rows: 'UnreadableRecord' },
  unreadableRecordsTotal: { bucket: 'derived' },

  /** One entry per paged category. `nextCursor: null` is the only "you have everything". */
  pages: { bucket: 'derived', block: 'FleetPage' },

  // The resync handle. All three are this process's own memory: a restart
  // changes `bootId`, resets `eventSeq` and moves `startedAt`, which is exactly
  // what makes them the signal that a watermark is meaningless.
  bootId: { bucket: 'remembered' },
  eventSeq: { bucket: 'remembered' },
  startedAt: { bucket: 'remembered' },

  provenance: { bucket: 'derived', block: 'Provenance' },
  capacity: { bucket: 'derived', block: 'Capacity' },
  priorities: { bucket: 'derived', rows: 'PriorityRow' },
  /** Absent when this daemon could not read its own descriptor usage. */
  herdrHealth: { bucket: 'observed', optional: true, block: 'HerdrHealth' },
  configEchoContract: { bucket: 'derived', block: 'ConfigEchoContract' }
} as const satisfies FieldTable;

/**
 * A REFUSED `list_agents` — a bad page cursor, an impossible limit, a category
 * nobody publishes.
 *
 * THREE FIELDS, AND NO `configEchoContract`, WHICH IS AN ASYMMETRY WITH
 * `agent_status` AND IS DOCUMENTED RATHER THAN REPAIRED HERE (KAN-279). §2 of
 * `docs/event-contract.md` says the echo contract rides EVERY `agent_status`
 * response including its refusals, so that "nothing was there" and "nobody
 * looked" stay distinguishable. `handleListAgents` refuses before it builds any
 * row, and its two refusal paths answer through `respond` rather than the sweep
 * — so a refused fleet read carries no block at all. It also carries no echo
 * for a block to be about, which is why it has never been a defect anybody met;
 * whether the two surfaces should nonetheless agree is a decision, and this
 * ticket documents the surface rather than changing it.
 */
export const LIST_AGENTS_REFUSAL_FIELDS = {
  action: { bucket: 'derived' },
  success: { bucket: 'derived' },
  error: { bucket: 'derived' }
} as const satisfies FieldTable;

// ------------------------------------------------------ agent_status_response

/**
 * `agent_status`, field by field, over the union of its four branches.
 *
 * `optional` here means "absent on at least one branch". WHICH branch carries
 * what is {@link AGENT_STATUS_BRANCHES}, and that is the part a consumer needs:
 * a field that is optional over the union is REQUIRED on the branch it belongs
 * to, and a reader holding one response knows which branch it has from
 * `success`, `configured` and `sessionless`.
 */
export const AGENT_STATUS_FIELDS = {
  action: { bucket: 'derived' },
  success: { bucket: 'derived' },
  /** Only on a refusal. */
  error: { bucket: 'derived', optional: true },
  /** Whether this daemon holds the agent's terminal attach. Absent on both refusals. */
  sessionless: { bucket: 'observed', optional: true },
  path: { bucket: 'durable', optional: true },
  paneName: { bucket: 'derived', optional: true },
  paneId: { bucket: 'observed', optional: true },
  sessionId: { bucket: 'observed', optional: true },
  createdAt: { bucket: 'observed', optional: true },
  status: { bucket: 'observed', optional: true },
  /** herdr's own cwd for the pane. Only on the sessionless branch. */
  workDir: { bucket: 'observed', optional: true },
  herdrStatus: { bucket: 'observed', optional: true },
  label: { bucket: 'durable', optional: true },
  configured: { bucket: 'durable', optional: true },
  state: { bucket: 'derived', optional: true },
  config: { bucket: 'durable', optional: true },
  configVersion: { bucket: 'durable', optional: true },
  configuredAt: { bucket: 'durable', optional: true },
  everActivated: { bucket: 'durable', optional: true },
  activatedBy: { bucket: 'durable', optional: true },
  /**
   * Whether the spawn this agent is running from was channel-enabled (KAN-281).
   * `durable` — written by the activation that made the decision, so it survives
   * a restart unchanged and this response answers the same value after one.
   * Absent only on `bad-address`, where no path was resolved to look anything up
   * for.
   */
  channelEnabled: { bucket: 'durable', optional: true },
  provenance: { bucket: 'derived', optional: true, block: 'Provenance' },
  /** On EVERY branch, refusals included — see §2 of docs/event-contract.md. */
  configEchoContract: { bucket: 'derived', block: 'ConfigEchoContract' }
} as const satisfies FieldTable;

/**
 * EXACTLY WHAT EACH BRANCH CARRIES.
 *
 * Four branches, and the difference between them is not cosmetic: a caller
 * diffing desired state against ours reads `state` off three of them and gets
 * an error off the fourth. `success` is about whether the QUESTION could be
 * answered, never about whether the agent is up — a record is an answer, so a
 * stopped agent succeeds.
 *
 * `no-record-no-pane` is the only branch that means the caller asked about
 * something that has never been an agent, and it still carries the echo (all
 * nulls) and the legend, because a refusal that answered nothing about WHERE it
 * looked would be indistinguishable from a daemon that did not look.
 */
export const AGENT_STATUS_BRANCHES = {
  /** `success: true`, this daemon holds the session. */
  'live-session': [
    'action', 'success', 'sessionless', 'path', 'paneName', 'paneId', 'sessionId',
    'createdAt', 'status', 'herdrStatus', 'label', 'configured', 'state',
    'config', 'configVersion', 'configuredAt', 'everActivated', 'activatedBy',
    'channelEnabled', 'provenance', 'configEchoContract'
  ],
  /**
   * `success: true`, no session of ours — every agent that outlived a daemon
   * restart, and every configured-and-stopped one. `workDir` appears here and
   * on no other branch; the three session-only fields are explicit nulls.
   */
  sessionless: [
    'action', 'success', 'sessionless', 'path', 'paneName', 'paneId', 'sessionId',
    'createdAt', 'status', 'workDir', 'herdrStatus', 'label', 'configured', 'state',
    'config', 'configVersion', 'configuredAt', 'everActivated', 'activatedBy',
    'channelEnabled', 'provenance', 'configEchoContract'
  ],
  /** `success: false` — neither a record nor a pane. `state` is `unconfigured`. */
  'no-record-no-pane': [
    'action', 'success', 'error', 'path', 'paneName', 'configured', 'state',
    'config', 'configVersion', 'configuredAt', 'everActivated', 'activatedBy',
    'channelEnabled', 'provenance', 'configEchoContract'
  ],
  /**
   * `success: false` — the address itself was rejected (relative, empty, not a
   * directory). Nothing was looked up, so nothing is reported about a path this
   * daemon never resolved.
   */
  'bad-address': ['action', 'success', 'error', 'configEchoContract']
} as const;

// ----------------------------------------------------- activate_response ----

/**
 * `activate_response`, field by field, over the union of its ELEVEN branches
 * (KAN-287).
 *
 * ---------------------------------------------------------------------------
 * THIS SURFACE ANSWERS A DIFFERENT QUESTION FROM THE OTHER TWO, AND THE BUCKETS
 * HAVE TO BE READ ACCORDINGLY.
 *
 * `list_agents` and `agent_status` answer *what is true now*. This response
 * answers *what this call just did* — and the four buckets were defined for the
 * first question. Rather than invent a fifth bucket for one surface, the four
 * are applied with the seam stated:
 *
 *   * `observed` keeps its exact meaning and is the honest home for the
 *     event-shaped fields that were read from something: `verified`,
 *     `alreadyRunning`, `paneId`, `occupiedBy`. The bucket already says "true as
 *     of the read and not one moment longer", which is PRECISELY the caveat
 *     `verified: true` needs — it means the agent was in herdr's census before
 *     this response was sent, and nothing re-checks it afterwards. The strong
 *     word is qualified by the bucket rather than by a footnote.
 *   * `derived` carries this daemon's account of its own actions — `started`,
 *     `reattached`, `recordReconciled`, `provisioned`, `durable`. These are not
 *     re-readable from anywhere: they are a report, and their truth is a claim
 *     about a moment that has passed.
 *   * `durable` means what it always means: on the registry, and answering the
 *     same after a restart. The config echo and `channelEnabled` are the only
 *     fields here that survive the process that sent them.
 *
 * WHAT NO BUCKET ON THIS SURFACE CAN TELL YOU, said here because the omission is
 * structural rather than an oversight: **`activate_response` carries no
 * `provenance` block.** Both read responses carry the legend that names
 * `observedAt` and `censusReachable`; this one does not, and adding it would
 * change the surface this contract exists to describe. So the buckets below are
 * the contract's own classification, held by the document and by
 * `verify-read-contract.mjs` §1, and NOT cross-checked against a live legend the
 * way §4 checks the row fields — because there is no legend here to check
 * against. That is the one place this surface is held more weakly than the other
 * two, and it is named rather than left to be discovered.
 *
 * ---------------------------------------------------------------------------
 * `optional` HERE MEANS "ABSENT ON AT LEAST ONE BRANCH", exactly as it does on
 * `agent_status`. Only `action`, `success` and `started` ride all eleven.
 * `started` doing so is not an accident of drafting — KAN-138 item 6 put it on
 * every refusal deliberately, because a caller must be able to read "nothing was
 * spawned" without first knowing which kind of refusal it is holding.
 */
export const ACTIVATE_RESPONSE_FIELDS = {
  action: { bucket: 'derived' },
  success: { bucket: 'derived' },
  /**
   * ON ALL ELEVEN BRANCHES, refusals included. The one field this surface
   * guarantees beyond `action`/`success`.
   */
  started: { bucket: 'derived' },
  /** Only on the nine refusals. */
  error: { bucket: 'derived', optional: true },
  /**
   * The agent's identity — its directory, resolved. `durable` for the same
   * reason `agent_status.path` is: it is the registry's own key, not a value
   * computed for this response. Absent only on `bad-address`, where the address
   * was refused before anything was resolved.
   */
  path: { bucket: 'durable', optional: true },
  paneName: { bucket: 'derived', optional: true },
  /**
   * `observed` — from the census this call read. Three states, and the third is
   * the one that carries information:
   *
   *   `true`    the agent was already up. Both the idempotent success and the
   *             one refusal that reached the question (`attach-error`).
   *   `false`   THIS CALL STARTED IT — the `spawned` branch, and only that one.
   *   absent    a refusal that never reached the question.
   *
   * NEVER `false` ON A REFUSAL, and that half is held by the compiler:
   * `ActivateRefusalFields` in `src/router.ts` types it `?: true`, so a refusal
   * claiming "we looked and it is not running" does not build. No refusal here
   * has established that — the `occupied` branch in particular knows only that
   * the pane it found is not ours.
   */
  alreadyRunning: { bucket: 'observed', optional: true },
  paneId: { bucket: 'observed', optional: true },
  sessionId: { bucket: 'observed', optional: true },
  status: { bucket: 'observed', optional: true },
  createdAt: { bucket: 'observed', optional: true },
  /**
   * `observed`, and this is the field the bucket most earns its keep on. `true`
   * means the agent was found in herdr's census BEFORE this response was sent —
   * a read, not a promise — and `observed` is the bucket that says a read is
   * true when it was taken and not one moment longer. Nothing re-checks it.
   */
  verified: { bucket: 'observed', optional: true },
  /** From the frozen record. On the spawning branch and the capacity refusal. */
  priority: { bucket: 'durable', optional: true },
  /** From the frozen record. On the spawning branch only. */
  launcher: { bucket: 'durable', optional: true },
  config: { bucket: 'durable', optional: true },
  configVersion: { bucket: 'durable', optional: true },
  configuredAt: { bucket: 'durable', optional: true },
  everActivated: { bucket: 'durable', optional: true },
  activatedBy: { bucket: 'durable', optional: true },
  /**
   * KAN-281. `durable`, and answered from the record rather than from the
   * session that produced it, which is what makes this surface and
   * `agent_status` agree BY CONSTRUCTION rather than by both being handed the
   * same variable.
   */
  channelEnabled: { bucket: 'durable', optional: true },
  /** Only on a restore: which cause the resume prompt was written for. */
  resume: { bucket: 'derived', optional: true },
  /** Only on a restore: whether a conversation was there to hand back. */
  resumedConversation: { bucket: 'observed', optional: true },
  /**
   * THE RESUME RULE, REPORTED RATHER THAN MERELY OBEYED. `false` says this agent
   * started a NEW session and did not continue whatever conversation the
   * directory holds — which at a caller-owned path is the difference between an
   * agent starting work and an agent reading a human's private session.
   */
  resumedExistingConversation: { bucket: 'derived', optional: true },
  /** Empty for an agent that opted into nothing — never absent on its branch. */
  provisioned: { bucket: 'derived', optional: true, rows: 'ProvisionedArtifact' },
  /**
   * Present ONLY when the registry write failed. `verified` answers "does this
   * agent exist"; this answers "will a restart know it does".
   */
  durable: { bucket: 'derived', optional: true },
  durabilityError: { bucket: 'derived', optional: true },
  /** Present only when THIS call took the terminal back. */
  reattached: { bucket: 'derived', optional: true },
  /** Present only when the disk disagreed with the world and this call settled it. */
  recordReconciled: { bucket: 'derived', optional: true },
  /** Live panes in the directory that are not ours. */
  occupiedBy: { bucket: 'observed', optional: true, rows: 'PaneOccupant' },
  /** Prose for a human, beside a co-occupancy that was reported and not refused. */
  note: { bucket: 'derived', optional: true },
  /** See {@link VALUE_SETS.activateRefused}. On three of the nine refusals. */
  refused: { bucket: 'derived', optional: true },
  /** See {@link VALUE_SETS.activateRefusedBy}. On the capacity refusal only. */
  refusedBy: { bucket: 'derived', optional: true },
  /** What `configure` would have to supply. On the `not-configured` refusal. */
  missing: { bucket: 'derived', optional: true },
  /** The capacity refusal, split into the pieces a UI can lay out. */
  reason: { bucket: 'derived', optional: true },
  derivation: { bucket: 'derived', optional: true },
  capacity: { bucket: 'derived', optional: true, block: 'Capacity' },
  /** An OFFER, on a refusal: what preempting WOULD stand down. Nothing has happened. */
  preemption: { bucket: 'derived', optional: true, block: 'PreemptionOffer' },
  /** An EVENT, on a success: what this activation DID stand down. */
  preempted: { bucket: 'derived', optional: true, block: 'Preempted' },
  /** Present only when the activation proceeded because the caller said so. */
  capacityOverride: { bucket: 'derived', optional: true, block: 'CapacityOverride' }
} as const satisfies FieldTable;

/**
 * A branch of `activate_response`: the keys it ALWAYS carries, and the keys it
 * carries only under a condition the document states.
 *
 * WHY THIS IS SHAPED DIFFERENTLY FROM {@link AGENT_STATUS_BRANCHES}, which is a
 * flat key list per branch. On `agent_status` a branch has an EXACT key set —
 * every nullable field is emitted as an explicit `null`, so knowing the branch
 * tells you the keys. On `activate_response` that is not true and cannot be made
 * true without changing the surface: nine fields are conditionally spread
 * (`...(durable.ok ? {} : {…})`), so the same branch legitimately answers with
 * different key sets on different calls.
 *
 * Collapsing that into one list would have forced a choice between two lies —
 * listing the conditionals as always-present, or omitting them so a real
 * response carries keys the branch does not declare. Two lists says what is
 * actually true, and it is what lets the proof assert `always` as an EQUALITY
 * and `sometimes` as a BOUND rather than asserting nothing about either.
 */
export interface ActivateBranchSpec {
  /** Every call on this branch carries exactly these. */
  readonly always: readonly string[];
  /** These may also appear, each under the condition the document names. */
  readonly sometimes: readonly string[];
}

/**
 * EXACTLY WHAT EACH BRANCH CARRIES — two successes and nine refusals, read off
 * `MessageRouter.handleActivate` rather than sampled from responses.
 *
 * THE TWO SUCCESSFUL BRANCHES ARE NOT SYMMETRIC, and that is the fact a consumer
 * is most likely to be caught by. `priority`, `launcher`, `provisioned` and
 * `resumedExistingConversation` ride the SPAWNING branch and not the idempotent
 * one — so the reconciling caller's most common read is the one that says less.
 * This is documented rather than repaired: repairing it changes the wire, which
 * is a decision and not a description.
 *
 * FOUR OF THE NINE REFUSALS CARRY NO MACHINE-READABLE DISCRIMINATOR.
 * `bad-address`, `bad-flag`, `spawn-error` and `confirm-failed` are separated
 * from each other only by the prose in `error` — and `bad-flag` and
 * `spawn-error` have IDENTICAL key sets, so no amount of shape inspection tells
 * them apart. `refused` and `refusedBy` exist and cover three and one of the
 * nine respectively. Named here because a reader who sees `refused` on some
 * refusals will otherwise assume it is on all of them.
 */
export const ACTIVATE_RESPONSE_BRANCHES = {
  /** `success: true` — this call started the agent. */
  spawned: {
    always: [
      'action', 'success', 'path', 'paneName', 'alreadyRunning', 'started', 'paneId',
      'sessionId', 'status', 'createdAt', 'priority', 'launcher', 'config', 'configVersion',
      'configuredAt', 'everActivated', 'activatedBy', 'channelEnabled', 'verified',
      'resumedExistingConversation', 'provisioned'
    ],
    sometimes: [
      'durable', 'durabilityError', 'resume', 'resumedConversation', 'preempted',
      'capacityOverride'
    ]
  },
  /**
   * `success: true` — the agent was already running and this call did not start
   * it. The ordinary state of a caller reconciling towards desired state, and
   * therefore the read this surface serves most often.
   */
  'already-running': {
    always: [
      'action', 'success', 'path', 'paneName', 'alreadyRunning', 'started', 'paneId',
      'sessionId', 'status', 'createdAt', 'verified', 'config', 'configVersion',
      'configuredAt', 'everActivated', 'activatedBy', 'channelEnabled'
    ],
    sometimes: [
      'reattached', 'recordReconciled', 'durable', 'durabilityError', 'occupiedBy', 'note'
    ]
  },
  /** The address itself was rejected — relative, empty, not a directory. */
  'bad-address': {
    always: ['action', 'success', 'started', 'error'],
    sometimes: []
  },
  /** `override` or `preempt` was not a boolean. Checked before anything is looked up. */
  'bad-flag': {
    always: ['action', 'success', 'started', 'error', 'path'],
    sometimes: []
  },
  /** No `configure` has ever run for this path. */
  'not-configured': {
    always: ['action', 'success', 'started', 'error', 'path', 'refused', 'missing'],
    sometimes: []
  },
  /**
   * herdr did not answer `agent list`, so whether anything is already running
   * there could not be checked. An empty census from an unreachable herdr is
   * silence, not evidence — `verified: false` says the look did not happen.
   */
  unverifiable: {
    always: ['action', 'success', 'started', 'error', 'path', 'refused', 'verified'],
    sometimes: []
  },
  /**
   * Live panes in the directory and none of them ours. NOTE THE ABSENCE OF
   * `alreadyRunning`: this branch established nothing about whether OUR agent is
   * running, and reporting either value would be a claim it did not earn.
   */
  occupied: {
    always: [
      'action', 'success', 'started', 'error', 'path', 'refused', 'verified', 'occupiedBy'
    ],
    sometimes: []
  },
  /** The capacity gate refused. The only branch carrying the arithmetic. */
  capacity: {
    always: [
      'action', 'success', 'started', 'error', 'path', 'refusedBy', 'reason', 'derivation',
      'capacity', 'priority'
    ],
    sometimes: ['preemption']
  },
  /** herdr refused the spawn. Nothing was started and the start charge is unwound. */
  'spawn-error': {
    always: ['action', 'success', 'started', 'error', 'path'],
    sometimes: []
  },
  /**
   * The pane is ours and live, and taking its terminal back failed. THE ONE
   * REFUSAL ENTITLED TO `alreadyRunning: true` — the question was reached and
   * answered, which is why the type permits `true` here and forbids `false`
   * everywhere.
   */
  'attach-error': {
    always: [
      'action', 'success', 'started', 'error', 'path', 'paneName', 'paneId', 'alreadyRunning'
    ],
    sometimes: ['recordReconciled']
  },
  /**
   * herdr reported the spawn succeeded and left no agent behind. `verified:
   * false` is the whole content of this branch: the difference between this
   * response and a false success.
   */
  'confirm-failed': {
    always: ['action', 'success', 'started', 'error', 'path', 'verified'],
    sometimes: []
  }
} as const satisfies Readonly<Record<string, ActivateBranchSpec>>;

// ------------------------------------------------------- daemon_status's half

/**
 * The `daemon_status` fields this contract covers, declared here so their home
 * is stated by the contract rather than only by the code.
 *
 * The rest of that response is out of this contract's scope on purpose: it is
 * about the DAEMON rather than about an agent's state, it has its own proof
 * (`verify-daemon-provenance.mjs`, `verify-daemon-status-over-mcp.mjs`), and
 * widening this document to cover it would be the compatibility-surface creep
 * KAN-277 scoped against.
 *
 * THE SECOND AND THIRD ENTRIES ARE AN EXCEPTION TO THAT AND ARE ARGUED FOR
 * RATHER THAN SLIPPED IN (KAN-302). `unreadableRecords` is not a fact about the
 * daemon; it is a fact about the durable registry that qualifies
 * `configuredAgents` and `expectedAgents` sitting beside it — both of which
 * count only rows that parsed, and would therefore both read `0` on a registry
 * that has rows in it. It is the same field, with the same shape, that
 * `list_agents` carries, and a consumer that branches on one must be able to
 * branch on the other; publishing it on one surface and not the other is how
 * the two come to disagree.
 */
export const DAEMON_STATUS_CONTRACT_FIELDS = {
  contractVersion: { bucket: 'derived' },
  unreadableRecords: { bucket: 'durable', rows: 'UnreadableRecord' },
  unreadableRecordsTotal: { bucket: 'derived' }
} as const satisfies FieldTable;

// ------------------------------------------------------------- the value sets

/**
 * The small closed vocabularies a reconciler BRANCHES ON, published so that
 * meeting a new member is an expected event rather than a surprise.
 *
 * Each is bound to its TypeScript union below, so a value added to the code
 * without a line here does not build — which is what makes the list a contract
 * rather than a snapshot. `headroomBoundBy` is the worked example: KAN-216
 * added `'stall'` to it, and a consumer holding a four-way switch met a fifth
 * value with no warning.
 *
 * **THE MUST-IGNORE CLAUSE, and it is the same one §4 of the event contract
 * states for actions and fields: a value you do not recognise must be handled
 * as an unknown rather than errored on.** These sets grow. The safe reading of
 * an unrecognised `headroomBoundBy` is "something bound headroom and it is not
 * one of the terms I know" — which is true, and enough to render.
 */
export const VALUE_SETS = {
  /** `agents[].state`, `agent_status.state`, `foreignPanes[].occupiedAgent.state`. */
  state: [
    'running', 'missing', 'preempted', 'standby', 'unstarted', 'unconfigured', 'unknown'
  ],
  /** `herdrStatus` everywhere it appears. herdr's word for what a pane is doing. */
  herdrStatus: ['idle', 'working', 'blocked', 'done', 'unknown'],
  /** `agents[].status` — OUR session's lifecycle, null on a sessionless row. */
  sessionStatus: ['initializing', 'active', 'terminated'],
  /** `capacity.capBoundBy` — which term set the cap. */
  capBoundBy: ['cpu', 'memory', 'floor', 'configured'],
  /** `capacity.headroomBoundBy` — which term set headroom. `stall` is KAN-216's. */
  headroomBoundBy: ['cap', 'cpu', 'load', 'memory', 'stall'],
  /** `capacity.agentMemorySource` and `agentCoresSource`. */
  costSource: ['override', 'measured', 'seed'],
  /** `capacity.stallSource` — which pressure was worst. Null when nothing measured. */
  stallSource: ['io', 'memory'],
  /** `capacity.stallInstrument` — and the two kinds of "nobody looked". */
  stallInstrument: ['measured', 'absent', 'unreadable'],
  /**
   * `capacity.startsChargeBasis` (KAN-263) — which instrument's blind spot the
   * starts charge was measured against. It is NOT a second way of saying which
   * term bound: it tracks whichever instrument filled the CPU-side slot, so it
   * reads `load1-period` on a machine where nothing measured CPU even when the
   * count or memory term is what refused.
   */
  startsChargeBasis: ['cpu-window', 'load1-period'],
  /**
   * `activate_response.refused` (KAN-287) — the machine-readable kind, on the
   * three refusals that carry one. **It is on three of the nine**, and the
   * document says which; a consumer must not read its absence as "not refused".
   */
  activateRefused: ['not-configured', 'unverifiable', 'occupied'],
  /**
   * `activate_response.refusedBy` — which SUBSYSTEM refused. One member today,
   * and the set is published rather than the field being described as a
   * constant, because "the only value it takes" is the sort of claim that stops
   * being true without anybody noticing.
   */
  activateRefusedBy: ['capacity'],
  /** `activate_response.resume` — why a restore was a restore. Only on a restore. */
  resumeCause: ['reboot', 'daemon-restart', 'preempted'],
  /** `provisioned[].artifact` — what kind of thing was written. */
  artifactKind: ['mcp-config', 'git-exclude', 'folder-trust', 'agy-mcp-config'],
  /**
   * `provisioned[].origin` — whether CrabCast created the artifact or found it
   * already there. `preexisting` is what makes the reversal column honest: there
   * is nothing to undo.
   */
  artifactOrigin: ['crabcast', 'preexisting']
} as const;

// `state` and `sessionStatus` are bound in `src/router.ts` instead, beside the
// unions they are about (`AgentState` is declared there, and `HerdrSession` is
// the herdr module's). This file must not import the router — the router
// imports it — which is the same constraint `events.ts` states for
// `CAPACITY_FIELDS`.
const _herdrStatusValuesAreExact: Exact<
  (typeof VALUE_SETS.herdrStatus)[number],
  HerdrAgentStatus
> = true;
const _capBoundValuesAreExact: Exact<(typeof VALUE_SETS.capBoundBy)[number], CapBound> = true;
const _headroomBoundValuesAreExact: Exact<
  (typeof VALUE_SETS.headroomBoundBy)[number],
  HeadroomBound
> = true;
const _costSourceValuesAreExact: Exact<(typeof VALUE_SETS.costSource)[number], CostSource> = true;
const _stallSourceValuesAreExact: Exact<(typeof VALUE_SETS.stallSource)[number], StallSource> = true;

// KAN-287. Three of the five new vocabularies have a TypeScript union behind
// them already, so they are bound here rather than left to the proof: PREFER THE
// TYPE TO THE ASSERTION WHERE THE CHOICE EXISTS. A fourth resume cause, or a
// fifth artifact kind, is a COMPILE ERROR until it has a line above and a row in
// the document — which is a stronger guarantee than any check that runs later,
// because the undocumented value cannot be introduced at all.
//
// `activateRefused` and `activateRefusedBy` get the same treatment, and their
// unions were introduced in `src/router.ts` by this ticket precisely so they
// could: they were bare string literals at nine `fail` sites, which is exactly
// the shape that grows a tenth member silently.
const _resumeCauseValuesAreExact: Exact<(typeof VALUE_SETS.resumeCause)[number], ResumeCause> = true;
const _artifactKindValuesAreExact: Exact<
  (typeof VALUE_SETS.artifactKind)[number],
  ArtifactKind
> = true;
const _artifactOriginValuesAreExact: Exact<
  (typeof VALUE_SETS.artifactOrigin)[number],
  ArtifactOrigin
> = true;

void _herdrStatusValuesAreExact;
void _capBoundValuesAreExact;
void _headroomBoundValuesAreExact;
void _costSourceValuesAreExact;
void _stallSourceValuesAreExact;
void _resumeCauseValuesAreExact;
void _artifactKindValuesAreExact;
void _artifactOriginValuesAreExact;

// ------------------------------------------------------------------ the digest

/**
 * A stable, order-independent rendering of everything above, for the version
 * table in `docs/read-path-contract.md` to record a digest of.
 *
 * WHAT IT BUYS: changing a documented field changes this string, so the digest
 * in the table stops matching and `verify-read-contract.mjs` §3 goes red. The
 * only two ways out are adding a version row or rewriting an existing one — and
 * the second is a diff a reviewer sees rather than an omission they do not.
 *
 * WHAT IT DOES NOT BUY, so nobody reads it as more: it does not force the
 * version to increment, and it is not a compatibility check. It makes a
 * SILENT change loud. That is all.
 */
export function readContractCanonical(): string {
  const table = (t: FieldTable) =>
    Object.keys(t)
      .sort()
      .map((k) => {
        const s = t[k];
        return `${k}:${s.bucket}${s.optional ? '?' : ''}${s.rows ? `→rows:${s.rows}` : ''}${
          s.block ? `→block:${s.block}` : ''
        }`;
      })
      .join(',');

  const named = (m: Readonly<Record<string, FieldTable>>) =>
    Object.keys(m)
      .sort()
      .map((k) => `${k}{${table(m[k])}}`)
      .join(';');

  return [
    `list_agents{${table(LIST_AGENTS_FIELDS)}}`,
    `list_agents_refusal{${table(LIST_AGENTS_REFUSAL_FIELDS)}}`,
    `agent_status{${table(AGENT_STATUS_FIELDS)}}`,
    `activate{${table(ACTIVATE_RESPONSE_FIELDS)}}`,
    `daemon_status{${table(DAEMON_STATUS_CONTRACT_FIELDS)}}`,
    `branches{${Object.keys(AGENT_STATUS_BRANCHES)
      .sort()
      .map(
        (b) =>
          `${b}:${[...AGENT_STATUS_BRANCHES[b as keyof typeof AGENT_STATUS_BRANCHES]]
            .sort()
            .join('|')}`
      )
      .join(';')}}`,
    // BOTH LISTS, and `sometimes` is not decoration in the digest: moving a field
    // from `sometimes` to `always` changes what the contract PROMISES without
    // changing which fields exist, and a digest that hashed only `always` would
    // let the reverse — a guaranteed field quietly downgraded to a conditional
    // one — land without a version row.
    `activate_branches{${Object.keys(ACTIVATE_RESPONSE_BRANCHES)
      .sort()
      .map((b) => {
        const spec =
          ACTIVATE_RESPONSE_BRANCHES[b as keyof typeof ACTIVATE_RESPONSE_BRANCHES];
        return `${b}:${[...spec.always].sort().join('|')}?${[...spec.sometimes]
          .sort()
          .join('|')}`;
      })
      .join(';')}}`,
    `rows{${named(ROW_SHAPES)}}`,
    `blocks{${named(BLOCK_SHAPES)}}`,
    `values{${Object.keys(VALUE_SETS)
      .sort()
      .map(
        (v) =>
          `${v}:${[...VALUE_SETS[v as keyof typeof VALUE_SETS]].sort().join('|')}`
      )
      .join(';')}}`
  ].join('\n');
}
