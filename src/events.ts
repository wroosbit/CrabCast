import { randomUUID } from 'crypto';
import type { AgentConfig } from './types.js';

/**
 * THE EVENT CONTRACT — the one place the published event surface is written
 * down, in the only form a forwarder can enforce.
 *
 * Until this file existed the surface was an internal convention: the daemon
 * broadcast whatever action name the emitting site happened to write, and the
 * MCP forwarder decided what to pass on by asking whether the name ended in
 * `_event`. Both halves were conventions rather than contracts, and both
 * failed in the way a convention fails — silently. The suffix test would have
 * dropped every event the moment the names changed, with no error on either
 * side; and the notification it produced carried a rendered sentence rather
 * than the event, so a subscriber could read our broadcast over our shoulder
 * and could not act on it.
 *
 * So the contract is data, imported by both processes that need it:
 *
 *   - `src/daemon.ts` stamps the envelope onto every broadcast and warns when
 *     a site emits an action this table does not carry.
 *   - `src/mcp.ts` forwards ONLY the actions in this table, projecting each
 *     one onto the payload declared here, and drops anything else with a
 *     warning on our own side rather than a malformed notification on the
 *     subscriber's.
 *
 * A POSITIVE ALLOWLIST, deliberately, and not a repaired suffix test. A suffix
 * test is a convention masquerading as a filter — the same objection that
 * retired the census prefix filter — and its failure mode is that a new event
 * either matches by accident or vanishes without trace. An allowlist's failure
 * mode is a warning naming the action nobody added, which is a bug report
 * rather than a silence.
 *
 * The prose contract, its delivery guarantees and the obligation it places on
 * a subscriber are in `docs/event-contract.md`. This file is that document's
 * executable half; they are meant to be read together.
 */

// ---------------------------------------------------------------- the names --

/**
 * The published events. NINE, and the arithmetic is worth writing down because
 * the ticket that commissioned this slice says ten and the design comment it
 * cites says ten in its prose and nine in its table.
 *
 * "Ten" counted BROADCAST SITES at 59ba420, before T1: preempted, capacity
 * override, registry degraded, activated, deactivated (three sites), reset,
 * detached, lost. Ten sites, eight distinct names. Against `main` today there
 * are nine names at eleven sites, and this slice takes one away (preempted
 * merges into deactivated) and adds one (status_changed), so the published
 * surface is nine names. The design's own §9 table has nine rows. Nothing has
 * been dropped; the figure in the prose was a site count wearing an event
 * count's label.
 */
export const EVENT_NAMES = [
  'agent.configured',
  'agent.activated',
  'agent.deactivated',
  'agent.forgotten',
  'agent.status_changed',
  'agent.lost',
  'agent.detached',
  'capacity.overridden',
  'registry.degraded'
] as const;

export type CrabcastEventName = (typeof EVENT_NAMES)[number];

// ------------------------------------------------- the declared interiors --

/**
 * `[A] extends [B] and [B] extends [A]` — the two-way test, as a type.
 *
 * Written as `true`/`false` rather than as a tuple of `never`s because `never`
 * is assignable to everything, so the obvious spelling of this check passes
 * whatever you feed it. The assertions below read `const _x: Exact<A, B> = true`
 * and go red on the assignment when the two sides disagree.
 */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * HOW DEEP THE PROJECTION GOES, AND WHERE IT STOPS.
 *
 * The forwarder used to project one level: `payload[field] = msg[field]` copied
 * a nested object by reference, entire, and `Object.keys(msg)` enumerated the
 * top level only. §4 of the document said "anything undeclared is dropped
 * before it leaves" without qualification, and that sentence was true at depth
 * 1 — the interior of `config`, `outcomes`, `preemption`, `capacity`,
 * `changed[]` and `removed[]` travelled unprojected and, worse, unreported: a
 * field added inside `config` reached an MCP subscriber AND did not appear in
 * `undeclared`, so the drift warning that exists to catch exactly that stayed
 * silent (KAN-164).
 *
 * The fix restores the sentence rather than shrinking it: the composites are
 * declared here, field by field, and {@link projectEvent} walks them. Adding a
 * knob inside `config` without declaring it is now the same event as adding a
 * field at the top level — dropped from the MCP payload, named in `undeclared`,
 * and warned about on our side.
 *
 * **A DECLARED FIELD WITH NO SHAPE IS A SCALAR, and that default is the loud
 * one.** If a declared field grows an interior nobody wrote down here, its keys
 * are reported as drift and the field does not go out — rather than the field
 * travelling whole and the interior going unexamined, which is the defect this
 * type exists to close. Forgetting is red, not quiet.
 */
export type FieldShape =
  /**
   * A leaf. `null`, a string, a number, a boolean — anything with no interior
   * for the contract to have an opinion about. An OBJECT arriving here is
   * drift: see the note above.
   */
  | { readonly kind: 'scalar' }
  /**
   * Declared, and travels whole ON PURPOSE — a region whose interior is not
   * ours to declare.
   *
   * `why` is a REQUIRED field of the type so that a second hole cannot be
   * opened without its author writing down a reason a reviewer can argue with;
   * an unexplained one is indistinguishable from the depth-1 bug being
   * reintroduced a field at a time. It is prose for a reader of this file.
   * §4 of `docs/event-contract.md` states the same reason for a reader of the
   * document, and NOTHING CHECKS THAT THE TWO AGREE — adding a `verbatim`
   * shape means editing both.
   */
  | { readonly kind: 'verbatim'; readonly why: string }
  /** An object whose keys are known. Anything else it carries is drift. */
  | {
      readonly kind: 'object';
      readonly fields: Readonly<Record<string, FieldShape>>;
      /** Keys the emitting site legitimately omits. Everything else is `missing`. */
      readonly optional?: readonly string[];
    }
  /** Every element projected through one shape. */
  | { readonly kind: 'array'; readonly of: FieldShape };

const SCALAR: FieldShape = { kind: 'scalar' };
const SCALARS: FieldShape = { kind: 'array', of: SCALAR };

/**
 * `config` — {@link AgentConfig}, every knob.
 *
 * TOTAL OVER THE TYPE, which is the whole reason this is a mapped type rather
 * than an object literal: a knob added to `AgentConfig` without a line here
 * does not compile. That is the same guard `RECONFIGURATION_COST` puts on
 * reconfiguration behaviour, applied to publication — and it is the guard that
 * matters most, because `config`'s interior is what a consumer diffs to detect
 * configuration drift. None of `priority`, `refusable`, `chargeable`,
 * `preemptable`, `launcher`, `prompt`, `mcpServers` or `label` was a declared
 * field of anything before this; they travelled inside a declared field,
 * unexamined.
 *
 * EXPORTED, AND THAT IS THE WHOLE OF KAN-166's MECHANISM. The same
 * `AgentConfig` object also travels on the `list_agents` response, inside every
 * category's `ConfigEcho` — the half `docs/event-contract.md` §2 makes a
 * CORRECTNESS requirement — and for one day it travelled there unexamined while
 * the event path walked it. The poll path now sweeps its echoes against THIS
 * declaration, imported rather than restated: see {@link undeclaredFields} and
 * `MessageRouter.handleListAgents`. Two hand-maintained lists of what an
 * `AgentConfig` contains would be the same drift one surface over, so there is
 * one list and a knob added to it is picked up by both surfaces with no second
 * edit.
 */
export const CONFIG_FIELDS: { [K in keyof Required<AgentConfig>]: FieldShape } = {
  priority: SCALAR,
  refusable: SCALAR,
  chargeable: SCALAR,
  preemptable: SCALAR,
  launcher: SCALAR,
  prompt: SCALAR,
  /**
   * THE ONE DELIBERATE HOLE IN THE RECURSION, and §4 names it rather than
   * leaving a consumer to discover it.
   *
   * Both halves of this map are the caller's: the keys are server names out of
   * their vocabulary, and the values are definitions CrabCast writes into
   * `.mcp.json` VERBATIM and — by the promise on `McpServerSpec` in
   * `src/types.ts` — never
   * reads, validates, resolves or reorders. There is nothing here for this
   * contract to declare, and declaring it would be this daemon claiming to know
   * a shape it has promised not to look at.
   *
   * So it travels whole, which makes the exception observable: the depth proof
   * adds a key inside `config.mcpServers` and asserts it ARRIVES, beside the
   * field it adds inside `config` and asserts is dropped.
   */
  mcpServers: {
    kind: 'verbatim',
    why:
      "the caller's own server definitions, written into .mcp.json verbatim and never read " +
      'by this daemon — neither the names they chose nor the JSON under them is ours to declare'
  },
  label: SCALAR
};

/** Which knobs `configure` may leave out. Absent ones are not `missing`. */
const OPTIONAL_CONFIG_KEYS = ['prompt', 'mcpServers', 'label'] as const;

/** The optional keys of {@link AgentConfig}, derived rather than restated. */
type OptionalConfigKeys = {
  [K in keyof AgentConfig]-?: Record<string, never> extends Pick<AgentConfig, K> ? K : never;
}[keyof AgentConfig];

// A knob that becomes optional (or stops being) without this list moving would
// otherwise be reported `missing` on every event, or never reported at all.
const _optionalConfigKeysAreExact: Exact<
  OptionalConfigKeys,
  (typeof OPTIONAL_CONFIG_KEYS)[number]
> = true;

/**
 * {@link AgentConfig} as a declared interior. Exported for the poll path, which
 * sweeps the same object with the same declaration — see {@link CONFIG_FIELDS}.
 */
export const CONFIG_SHAPE: FieldShape = {
  kind: 'object',
  fields: CONFIG_FIELDS,
  optional: OPTIONAL_CONFIG_KEYS
};

/**
 * `outcomes` — every knob, with what the `configure` call did to it.
 *
 * The same key set as `config` and total over it for the same reason, but with
 * NOTHING optional: the emitting site loops over every attribute, so a knob
 * absent here is a knob the loop did not reach.
 */
const OUTCOMES_SHAPE: FieldShape = {
  kind: 'object',
  fields: Object.fromEntries(
    Object.keys(CONFIG_FIELDS).map((knob) => [knob, SCALAR])
  ) as { [K in keyof Required<AgentConfig>]: FieldShape }
};

/**
 * `capacity` — the capacity report, flat and all scalars.
 *
 * Exported because the object it describes is built by `capacityDto` in
 * `router.ts`, and `router.ts` asserts at COMPILE time that its keys and these
 * are the same set, in both directions. That assertion lives there rather than
 * here because this file must not import the router — the router imports this
 * one — and because the check belongs next to the thing that would drift.
 */
export const CAPACITY_FIELDS = {
  cap: SCALAR,
  running: SCALAR,
  exemptAgents: SCALAR,
  headroom: SCALAR,
  atCapacity: SCALAR,
  capBoundBy: SCALAR,
  headroomBoundBy: SCALAR,
  reason: SCALAR,
  cores: SCALAR,
  load1: SCALAR,
  totalMb: SCALAR,
  availableMb: SCALAR,
  agentMemoryMb: SCALAR,
  agentCores: SCALAR,
  agentMemorySource: SCALAR,
  agentCoresSource: SCALAR,
  measuredAt: SCALAR,
  measuredWindowSeconds: SCALAR,
  measuredAgentTrees: SCALAR,
  capByCpu: SCALAR,
  capByMemory: SCALAR,
  headroomByCap: SCALAR,
  headroomByLoad: SCALAR,
  headroomByMemory: SCALAR,
  summary: SCALAR
} satisfies Record<string, FieldShape>;

const CAPACITY_SHAPE: FieldShape = { kind: 'object', fields: CAPACITY_FIELDS };

/** `preemption.by` — who took the slot. Asserted against `router.ts` too. */
export const PREEMPTION_BY_FIELDS = {
  path: SCALAR,
  paneName: SCALAR,
  priority: SCALAR
} satisfies Record<string, FieldShape>;

/**
 * `preemption` — everything the retired `agent_preempted_event` carried.
 *
 * `capacity` is optional here and required nowhere else: the block is built by
 * `deactivationCause`, which spreads the capacity report in only when the gate
 * that made the decision handed one over.
 */
export const PREEMPTION_FIELDS = {
  at: SCALAR,
  by: { kind: 'object', fields: PREEMPTION_BY_FIELDS },
  priority: SCALAR,
  herdrStatus: SCALAR,
  derivation: SCALAR,
  capacity: CAPACITY_SHAPE
} satisfies Record<string, FieldShape>;

const PREEMPTION_SHAPE: FieldShape = {
  kind: 'object',
  fields: PREEMPTION_FIELDS,
  optional: ['capacity']
};

/** What the contract says about one event. */
export interface EventSpec {
  /** The pre-rename action name, or null for an event that is new here. */
  formerly: string | null;
  /** What causes it. */
  fires: string;
  /**
   * Payload fields this event ALWAYS carries, beyond the envelope.
   *
   * Enforced in both directions by the MCP forwarder: a declared field missing
   * from a broadcast is a warning, and so is an undeclared field present on
   * one. The first is the `undefined/undefined` defect — a renderer reading a
   * field the event never had. The second is drift the other way: a site that
   * grew a field nobody published.
   */
  required: readonly string[];
  /** Payload fields that may be absent, with the condition that decides it. */
  optional: readonly string[];
  /**
   * The interior of any declared field that HAS one. See {@link FieldShape}.
   *
   * A field named in `required` or `optional` and absent from here is a
   * SCALAR — so a composite that grows without a line here has its interior
   * reported as drift rather than passed through unexamined (KAN-164).
   */
  shapes?: Readonly<Record<string, FieldShape>>;
  /** The field naming this event's subject, for one-line human logs. */
  subject: string;
}

/**
 * THE TABLE. Every published event, what renamed to it, and what it carries.
 *
 * Marked breaking wherever `formerly` is non-null: the old name is gone, not
 * accepted in parallel. There is NO DUAL EMISSION and no parallel acceptance
 * of the old names. Dual-emitting would make every subscriber see each event
 * twice and dedupe, which is worse than a clean break, and `bootId` already
 * forces a resync on reconnect. The rename lands at once and is logged once at
 * daemon boot.
 *
 * ---------------------------------------------------------------------------
 * `durable`, ON ALL THREE LIFECYCLE EVENTS (KAN-165)
 *
 * `agent.configured`, `agent.activated` and `agent.deactivated` are the three
 * events that sit on the durable write path, and all three used to fire whether
 * or not the write landed while their `fires` sentence said the record had been
 * written. The registry deliberately never throws — an unwritable log must not
 * fail the lifecycle operation in flight — so the failure was swallowed on the
 * event surface and answered only on the response. That is KAN-72's defect one
 * surface over: *the durable record and the response must agree*, ported to the
 * event path, where it had not been carried.
 *
 * SO EACH OF THE THREE CARRIES `durable`, and it is stated as a property of the
 * relationship between the event and the disk rather than of this transport, so
 * the sentence stays true if these events are ever carried somewhere else:
 *
 *   `durable: true`  — the daemon's durable record agrees with this event. A
 *                      restart will see what this event describes.
 *   `durable: false` — the operation happened and the registry write did not.
 *                      The event is true about the world; the disk does not know
 *                      it, and a restart will not. `durabilityError` says why,
 *                      and a `registry.degraded` also fires.
 *
 * REQUIRED RATHER THAN PRESENT-WHEN-FALSE, which is the whole point and not a
 * detail. A field that appears only on failure asks a subscriber to read
 * durability out of an ABSENCE — and an absence is exactly what this daemon
 * already produces for two other reasons: an older daemon that never published
 * the field (§2's `bootId` exists because a subscriber does meet daemons of
 * different vintages across a reconnect), and the MCP projection, which carries
 * EXACTLY the declared fields and would drop it. A fix for "the event asserts by
 * silence" that itself asserts by silence is the same defect with a shorter
 * name. So it is on every one of these events, both values.
 *
 * The RESPONSES keep `durable: false` present-only-on-failure, deliberately and
 * asymmetrically: a response answers a call the caller can simply make again,
 * so an absence there is recoverable by asking. An event is at-most-once with
 * no second copy and no way to re-request it, so an absence on the wire cannot
 * be allowed to mean anything.
 * ---------------------------------------------------------------------------
 */
export const EVENT_CONTRACT: Record<CrabcastEventName, EventSpec> = {
  'agent.configured': {
    formerly: 'agent_configured_event',
    // WAS "`configure` was accepted and the record was written", which fired
    // whether or not the second half had happened. It now says what it does:
    // the acceptance is asserted, and the write is REPORTED rather than
    // claimed. See the `durable` block above the table.
    fires:
      '`configure` was accepted. The durable write is attempted before this event is sent ' +
      'and `durable` reports its outcome — `false` means the configuration is live in this ' +
      'daemon and a restart will not know about it',
    // `changed` and `outcomes` ARRIVED WITH T4 AND THE DRIFT CHECK FOUND THEM.
    // T4 (reconfiguration) added both to this broadcast — correctly, and the
    // design's own table specifies `changed[]` for this event — but a payload
    // field that is not declared here is dropped by the MCP forwarder. So an
    // MCP subscriber was silently losing which attributes moved, which is the
    // whole point of the event for a reconciler. Caught on the merge, by the
    // undeclared-field half of the warning, on real traffic rather than a
    // mutation. Both are unconditional at the emitting site, so both are
    // required rather than optional.
    required: [
      'path', 'config', 'configVersion', 'configuredAt', 'changed', 'outcomes',
      'durable'
    ],
    optional: ['durabilityError'],
    // THREE of this event's six fields are composite, which is why the depth
    // proof is written against this one: `config`'s interior is what a
    // consumer diffs to detect configuration drift. `durable` and
    // `durabilityError` need no entry here: a declared field with no shape is
    // a SCALAR, which is what both of them are.
    shapes: { config: CONFIG_SHAPE, changed: SCALARS, outcomes: OUTCOMES_SHAPE },
    subject: 'path'
  },
  'agent.activated': {
    formerly: 'agent_activated_event',
    fires:
      'an activation was confirmed against herdr\'s census — either a fresh spawn or ' +
      'this daemon re-taking the terminal of an agent that outlived it. A repeat call ' +
      'on an agent that was already running and already attached broadcasts nothing, ' +
      'because nothing changed. `durable` reports whether the activation reached the ' +
      'registry — `false` means the agent is running, verified, and outside the set a ' +
      'restart restores',
    required: [
      'path', 'paneName', 'paneId', 'sessionId', 'status', 'configVersion',
      'durable'
    ],
    optional: ['durabilityError'],
    subject: 'path'
  },
  'agent.deactivated': {
    formerly: 'agent_deactivated_event',
    fires:
      'a stand-down was confirmed. Never on an unconfirmed teardown: announcing an ' +
      'agent deactivated while it may still be running is the false claim verified ' +
      'activation exists to prevent, arriving as an event instead of as a response. ' +
      '`durable` reports whether the stand-down reached the registry — `false` means the ' +
      'agent is down and a restart will try to bring it back',
    required: ['path', 'reason', 'durable'],
    // `agent_preempted_event` MERGED IN HERE as `reason: 'preempted'`. It used
    // to be a second broadcast on the same stand-down, which made a preemption
    // two events describing one thing and left a subscriber to correlate them.
    // Everything it carried is on `preemption` below.
    optional: ['paneName', 'sessionId', 'preemption', 'durabilityError'],
    shapes: { preemption: PREEMPTION_SHAPE },
    subject: 'path'
  },
  'agent.forgotten': {
    formerly: 'agent_forgotten_event',
    fires: '`forget` was accepted: the record is gone, and so is the residue it names',
    required: ['path', 'removed'],
    optional: [],
    shapes: { removed: SCALARS },
    subject: 'path'
  },
  'agent.status_changed': {
    formerly: null,
    fires:
      'the fleet sweep observed a different herdr status for an agent than the one it ' +
      'last observed. Poll-derived, on the existing 30-second sweep — see the latency ' +
      'clause in docs/event-contract.md, which is part of the contract rather than an ' +
      'implementation note',
    required: ['path', 'paneName', 'paneId', 'from', 'to'],
    optional: [],
    subject: 'path'
  },
  'agent.lost': {
    formerly: 'agent_lost_event',
    fires:
      'the sweep found an agent the registry records as active with no live agent in ' +
      'its directory. Latched per path: announced when it becomes missing and not ' +
      'again while it stays missing',
    required: [
      'path',
      'paneName',
      'label',
      'config',
      'configVersion',
      'configuredAt',
      'everActivated',
      // The supervisor of record (KAN-113). DECLARED rather than stripped,
      // because this event already publishes the whole durable echo and the
      // payload is the `MissingAgent` row spread whole — so a field added to
      // `ConfigEcho` arrives here by construction, and the contract's job is to
      // describe the wire truthfully rather than to lag it.
      //
      // It is also the field this event's reader most needs: "an agent you are
      // responsible for has been lost" is the sentence a supervisor wants, and
      // without this they are told an agent is gone and not whose it was.
      // Stripping it to keep the contract unchanged would make `agent.lost` the
      // one place the echo is deliberately partial, which is precisely the
      // silent-omission failure KAN-113 exists to prevent.
      'activatedBy',
      'since',
      'reason'
    ],
    optional: [],
    // The same `config` interior as `agent.configured`, and reached the same
    // way — this payload is the `MissingAgent` row spread whole, so the echo's
    // shape is this event's shape by construction.
    shapes: { config: CONFIG_SHAPE },
    subject: 'path'
  },
  'agent.detached': {
    formerly: 'agent_detached_event',
    fires: 'a PTY this daemon held died, taking its terminal with it',
    required: ['path', 'paneName', 'sessionId', 'reason', 'exitCode'],
    optional: [],
    subject: 'path'
  },
  'capacity.overridden': {
    formerly: 'capacity_override_event',
    fires: 'an activation was started past the capacity gate on an explicit override',
    // No `path`, and a renderer must not assume one: the subject of this event
    // is the machine, and `what` names the activation that overrode it.
    required: ['what', 'capacity'],
    optional: [],
    shapes: { capacity: CAPACITY_SHAPE },
    subject: 'what'
  },
  'registry.degraded': {
    formerly: 'registry_degraded_event',
    fires:
      'a durable registry write failed. The lifecycle operation still happened; the ' +
      'disk does not know about it',
    required: ['what', 'error', 'consequence'],
    optional: [],
    subject: 'what'
  }
};

/** The envelope every published event carries, stamped once at the broadcast. */
export const ENVELOPE_FIELDS = ['action', 'at', 'seq', 'bootId'] as const;

/**
 * A published event, as an emitting site writes it — before the envelope.
 *
 * This is the type `MessageRouter`'s `broadcast` dependency takes, and it used
 * to be `DaemonResponse`, which required a `success` field. That was the
 * conflation in the type system: an event is a statement that something
 * happened, not an answer to somebody's request, and there was nothing for
 * `success` to be about. Every broadcast carried it anyway (`true` on eight of
 * them, `false` on the one whose entire meaning is a failure) and the MCP
 * forwarder never published it. It is gone from the wire and from the type.
 */
export interface EventFrame {
  action: CrabcastEventName;
  [field: string]: unknown;
}

const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(EVENT_NAMES);

/**
 * Is this action a published event?
 *
 * The whole filter, on both paths. It asks the allowlist rather than the shape
 * of the string, so an action added to the daemon without being added here is
 * answered `false` — and every caller of this function turns that `false` into
 * a warning naming the action, which is the difference between finding out and
 * not.
 */
export function isEventAction(action: unknown): action is CrabcastEventName {
  return typeof action === 'string' && EVENT_NAME_SET.has(action);
}

// ------------------------------------------------------------- the envelope --

/**
 * `seq` and `bootId` for THIS process.
 *
 * Module-level because a process has one boot. The daemon stamps its
 * broadcasts from it and answers `list_agents` and `daemon_status` with the
 * same two values, which is what makes the resync path closeable: a subscriber
 * that reconnects calls `list`, compares `bootId`, and knows in one round trip
 * whether the daemon it is talking to is the one it was talking to.
 *
 * `seq` is per-boot and monotonic across ALL events, which is stronger than
 * the contract promises (total order per path, none across paths) and costs
 * nothing — one counter at one choke point. The contract still promises only
 * the weaker property, because a subscriber that relies on cross-path ordering
 * would be relying on an implementation detail of having a single broadcaster.
 */
export class EventStream {
  readonly bootId: string;
  private counter = 0;

  constructor(bootId: string = randomUUID()) {
    this.bootId = bootId;
  }

  /** The highest `seq` stamped so far; 0 before the first event. */
  get seq(): number {
    return this.counter;
  }

  /**
   * Stamp a broadcast with the envelope.
   *
   * Only published events are stamped and sequenced. An off-contract action is
   * returned untouched with `onContract: false` so the caller can say so out
   * loud: burning a sequence number on something no subscriber recognises
   * would put a gap in the sequence that means nothing.
   */
  stamp(msg: any): { onContract: boolean; frame: any } {
    if (!isEventAction(msg?.action)) return { onContract: false, frame: msg };
    return {
      onContract: true,
      frame: {
        ...msg,
        // The emitting site's own timestamp wins where it has one — the
        // capacity override records the moment it decided, not the moment the
        // frame was built.
        at: typeof msg.at === 'string' ? msg.at : new Date().toISOString(),
        seq: ++this.counter,
        bootId: this.bootId
      }
    };
  }
}

/** This process's stream. The MCP server imports the table above and not this. */
export const events = new EventStream();

// ------------------------------------------------------------- the forwarder --

export interface ProjectedEvent {
  /** The published payload: envelope plus exactly the declared fields. */
  payload: Record<string, unknown>;
  /**
   * Declared fields the broadcast did not carry.
   *
   * Dotted where the field is inside a composite — `config.launcher` — for the
   * same reason `undeclared` is: at depth, the field name alone does not say
   * which of the two `priority`s (the knob, or the preempted agent's) is meant.
   */
  missing: string[];
  /**
   * Fields the broadcast carried that the contract does not publish, at ANY
   * depth: `activatedBy` at the top level, `config.telemetry` one down,
   * `preemption.by.host` two, `changed[0].name` through an array.
   */
  undeclared: string[];
}

/** Where the walk currently is, for a legible drift report. See {@link projectValue}. */
type Drift = { missing: string[]; undeclared: string[] };

/**
 * Project ONE value through ONE declared shape, recursively.
 *
 * Returns what may be published and appends anything it had to leave behind to
 * `drift`, named by its full path. The two go together on purpose: a field that
 * is dropped and NOT reported is the defect this function exists to close — an
 * MCP subscriber quietly losing something is what the contract's whole drift
 * apparatus is for, and it was blind below the top level until KAN-164.
 *
 * `null` passes every shape untouched. `config: null` on `agent.lost` is an
 * ANSWER — "there is no record here" — rather than a composite with an interior
 * to examine, and inventing drift under it would report a shape that is not
 * there.
 *
 * A projected composite is a NEW object rather than the one the daemon built,
 * so its keys come out in declaration order rather than the emitting site's.
 * Said because it is a real difference and not because it is a promise: JSON
 * object key order is not observable to anything that reads the payload back,
 * and this contract does not offer one. The declarations are nevertheless
 * written in the producing code's order, so the wire looks the way it did.
 */
function projectValue(value: unknown, shape: FieldShape, at: string, drift: Drift): unknown {
  if (value === null) return null;

  switch (shape.kind) {
    case 'verbatim':
      return value;

    case 'array': {
      if (!Array.isArray(value)) {
        // Declared an array, arrived as something else. Report whatever
        // interior it has rather than passing an unexamined object through
        // under an array's name.
        reportInterior(value, at, drift);
        return undefined;
      }
      return value.map((element, i) => projectValue(element, shape.of, `${at}[${i}]`, drift));
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        reportInterior(value, at, drift);
        return undefined;
      }
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const optional = new Set(shape.optional ?? []);
      for (const [key, sub] of Object.entries(shape.fields)) {
        const where = `${at}.${key}`;
        if (source[key] === undefined) {
          if (!optional.has(key)) drift.missing.push(where);
          continue;
        }
        const projected = projectValue(source[key], sub, where, drift);
        if (projected !== undefined) out[key] = projected;
      }
      for (const key of Object.keys(source)) {
        if (!(key in shape.fields)) drift.undeclared.push(`${at}.${key}`);
      }
      return out;
    }

    case 'scalar':
      // A LEAF THAT ARRIVED WITH AN INTERIOR. The contract says this field has
      // no shape, so there is no declaration under which any of its keys could
      // be published — and the safe reading of "undeclared" is the one that
      // reports and drops rather than the one that passes it through, which is
      // exactly the depth-1 behaviour being retired here.
      if (typeof value === 'object') {
        reportInterior(value, at, drift);
        return undefined;
      }
      return value;
  }
}

/**
 * Every path inside `value` that `shape` does not declare, and nothing else.
 *
 * THE SAME WALK {@link projectEvent} USES, called for one of its two answers.
 * That reuse is the point rather than a convenience: `list_agents` echoes the
 * same {@link AgentConfig} object the event path projects, and the failure this
 * function exists to prevent is the two surfaces disagreeing about what an
 * `AgentConfig` contains. They cannot, because there is one declaration
 * ({@link CONFIG_FIELDS}) and one walker ({@link projectValue}), and a knob
 * added to the first is honoured by both callers with no second edit.
 *
 * WHAT THE CALLER DOES WITH THE ANSWER IS THE CALLER'S, AND THE TWO DIFFER ON
 * PURPOSE. `projectEvent` drops what it names, because an MCP notification has
 * a declared payload shape. `handleListAgents` REPORTS what it names and
 * publishes the echo whole, because the echo's promise is that it is the
 * durable record verbatim. §2 and §4 of `docs/event-contract.md` state both,
 * beside each other, so a consumer is not left to infer which surface it is
 * reading.
 *
 * The discarded half is `missing` — a DECLARED field the value did not carry.
 * Nothing here reports it, deliberately: on a response that is a question about
 * `configure`'s own validation rather than about drift, and it is already
 * asserted on the event path for the same object (`agent.configured` and
 * `agent.lost` both declare `config`). A caller that wants it should ask for it
 * by adding a return value, not by reading a silence.
 */
export function undeclaredFields(value: unknown, shape: FieldShape, at: string): string[] {
  const drift: Drift = { missing: [], undeclared: [] };
  projectValue(value, shape, at, drift);
  return drift.undeclared;
}

/** Name every key under an undeclared interior, so the warning says what was dropped. */
function reportInterior(value: unknown, at: string, drift: Drift): void {
  if (Array.isArray(value)) {
    // An EMPTY array reports itself, because reporting nothing for it would
    // drop a field silently — the one outcome this whole apparatus exists to
    // make impossible.
    if (value.length === 0) drift.undeclared.push(`${at}[]`);
    value.forEach((element, i) => reportInterior(element, `${at}[${i}]`, drift));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object);
    // An empty object is still an interior where the contract declared none.
    if (keys.length === 0) drift.undeclared.push(`${at}{}`);
    for (const key of keys) drift.undeclared.push(`${at}.${key}`);
    return;
  }
  drift.undeclared.push(at);
}

/**
 * Project a broadcast onto the payload the contract publishes for it.
 *
 * This is what replaces `mcp.ts`'s format string, and the projection rather
 * than a pass-through is the point: what a subscriber receives is what the
 * table says it receives, field for field, so the document and the wire cannot
 * drift apart without one of the two lists below being non-empty.
 *
 * Both lists are drift, in opposite directions, and both are warned about
 * where a developer sees them:
 *
 *   `missing`    — the contract publishes a field this event did not carry.
 *                  This is the `undefined/undefined` defect in its general
 *                  form: a subscriber told to expect a field, reading absence.
 *   `undeclared` — a site grew a field the contract does not publish. Dropped
 *                  rather than leaked, because a field that appears on the
 *                  wire without being written down is exactly the internal
 *                  convention this slice exists to stop shipping.
 *
 * BOTH LISTS RUN TO THE BOTTOM OF EVERY COMPOSITE (KAN-164). They used to run
 * one level: a declared field's value was copied by reference, entire, so a
 * field added inside `config` was published AND absent from `undeclared` —
 * delivered to a subscriber, unexamined, by the mechanism whose whole job was
 * to catch it. `spec.shapes` declares the interiors and {@link projectValue}
 * walks them, so the two lists name paths (`config.telemetry`) where the field
 * is not at the top level.
 */
export function projectEvent(msg: any): ProjectedEvent | null {
  const action = msg?.action;
  if (!isEventAction(action)) return null;
  const spec = EVENT_CONTRACT[action];

  const payload: Record<string, unknown> = {
    action,
    at: msg.at,
    seq: msg.seq,
    bootId: msg.bootId
  };

  const missing: string[] = [];
  // Kept apart from `missing`/`undeclared` until the top-level pass is done, so
  // the shallow findings still come first in both lists: the top-level drift
  // report is the one that has caught real defects (`activatedBy` arriving on
  // `agent.lost`), and burying it under a nested path would be trading the
  // depth that works for the one that did not.
  const nested: Drift = { missing: [], undeclared: [] };
  /** A declared field with no interior written down is a scalar. See {@link FieldShape}. */
  const shapeOf = (field: string): FieldShape => spec.shapes?.[field] ?? SCALAR;

  for (const field of spec.required) {
    if (msg[field] === undefined) {
      missing.push(field);
      continue;
    }
    const projected = projectValue(msg[field], shapeOf(field), field, nested);
    if (projected !== undefined) payload[field] = projected;
  }
  // AN OPTIONAL FIELD SET TO `undefined` IS DROPPED, AND SOMETHING DEPENDS ON
  // THAT (KAN-164/KAN-165). It is the obvious reading of "optional" and it is
  // also a load-bearing behaviour of another file: `durability()` in
  // `src/router.ts` defaults `durabilityError` to a string precisely because
  // this line would otherwise let `durable: false` go out with no reason
  // attached, on the one path a subscriber cannot re-request. Change the
  // handling here — publish `null`, keep the key, anything — and read that
  // helper before you do.
  //
  // WHAT ACTUALLY STOPS YOU, named exactly, because an earlier version of this
  // comment named a guard that did not cover this case. `verify-event-contract.mjs`
  // §2 asserts BOTH halves of the pair on real traffic: that no published
  // `durable: false` arrives without a reason, and — the half that guards this
  // line — that every optional the daemon did not send is ABSENT from the
  // projected payload, correlated to the frame that produced it by `seq`, with
  // the converse asserted too so dropping every optional does not pass instead.
  // Review made the exact edit this comment invites, and the earlier assertion
  // stayed green; the sentence claiming coverage was wrong before the coverage
  // was added, which is the failure this file exists to make loud.
  for (const field of spec.optional) {
    if (msg[field] === undefined) continue;
    const projected = projectValue(msg[field], shapeOf(field), field, nested);
    if (projected !== undefined) payload[field] = projected;
  }

  const declared = new Set<string>([
    ...ENVELOPE_FIELDS,
    ...spec.required,
    ...spec.optional,
    // Carried by every broadcast frame this daemon has ever sent and
    // deliberately not published: an event is a statement that something
    // happened, not an answer to somebody's request, so there is nothing for
    // `success` to be about. `registry.degraded` was the only one where it
    // said anything, and the degradation IS that event's whole meaning.
    'success'
  ]);
  const undeclared = Object.keys(msg).filter((k) => !declared.has(k));

  return {
    payload,
    missing: [...missing, ...nested.missing],
    undeclared: [...undeclared, ...nested.undeclared]
  };
}

/** A one-line human summary, for a log where the whole payload would not fit. */
export function describeEvent(msg: any): string {
  const action = msg?.action;
  if (!isEventAction(action)) return String(action);
  const subject = msg[EVENT_CONTRACT[action].subject];
  return `${action} ${typeof subject === 'string' ? subject : '(no subject)'} (seq ${msg.seq ?? '?'})`;
}

/**
 * The contract, announced once at daemon boot.
 *
 * Once, and at boot, because that is when a breaking rename is news: an
 * operator upgrading past this release gets the mapping in the log of the
 * daemon that stopped emitting the old names, next to the `bootId` that tells
 * every reconnecting subscriber to resync.
 */
export function describeContract(bootId: string): string {
  const renamed = EVENT_NAMES.filter((n) => EVENT_CONTRACT[n].formerly).map(
    (n) => `${EVENT_CONTRACT[n].formerly} → ${n}`
  );
  const added = EVENT_NAMES.filter((n) => !EVENT_CONTRACT[n].formerly);
  return (
    `Event contract: ${EVENT_NAMES.length} published events — ${EVENT_NAMES.join(', ')}. ` +
    `bootId ${bootId}. ` +
    `BREAKING, this release: every event was renamed (${renamed.join('; ')}), ` +
    `agent_preempted_event was merged into agent.deactivated as reason: 'preempted', ` +
    `and \`success\` no longer appears on any event. ` +
    `The old names are GONE — not dual-emitted and not accepted in parallel. ` +
    `New: ${added.join(', ') || 'none'}. ` +
    `A subscriber receiving an action not in that list must ignore it and must not error. ` +
    `Events are a latency optimisation over an authoritative \`list\` poll and are ` +
    `at-most-once: a subscriber that does not independently poll \`list\` on a timer is ` +
    `not entitled to convergence. See docs/event-contract.md.`
  );
}
