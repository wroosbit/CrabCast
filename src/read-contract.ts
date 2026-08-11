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
export const READ_CONTRACT_VERSION = 1;

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
    'provenance', 'configEchoContract'
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
    'provenance', 'configEchoContract'
  ],
  /** `success: false` — neither a record nor a pane. `state` is `unconfigured`. */
  'no-record-no-pane': [
    'action', 'success', 'error', 'path', 'paneName', 'configured', 'state',
    'config', 'configVersion', 'configuredAt', 'everActivated', 'activatedBy',
    'provenance', 'configEchoContract'
  ],
  /**
   * `success: false` — the address itself was rejected (relative, empty, not a
   * directory). Nothing was looked up, so nothing is reported about a path this
   * daemon never resolved.
   */
  'bad-address': ['action', 'success', 'error', 'configEchoContract']
} as const;

// ------------------------------------------------------- daemon_status's half

/**
 * The one field this ticket adds to `daemon_status`, declared here so the
 * version's home is stated by the contract rather than only by the code.
 *
 * The rest of that response is out of this contract's scope on purpose: it is
 * about the DAEMON rather than about an agent's state, it has its own proof
 * (`verify-daemon-provenance.mjs`, `verify-daemon-status-over-mcp.mjs`), and
 * widening this document to cover it would be the compatibility-surface creep
 * this ticket was scoped against.
 */
export const DAEMON_STATUS_CONTRACT_FIELDS = {
  contractVersion: { bucket: 'derived' }
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
  stallInstrument: ['measured', 'absent', 'unreadable']
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

void _herdrStatusValuesAreExact;
void _capBoundValuesAreExact;
void _headroomBoundValuesAreExact;
void _costSourceValuesAreExact;
void _stallSourceValuesAreExact;

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
