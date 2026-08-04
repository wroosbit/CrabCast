import { randomUUID } from 'crypto';

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
    subject: 'path'
  },
  'agent.forgotten': {
    formerly: 'agent_forgotten_event',
    fires: '`forget` was accepted: the record is gone, and so is the residue it names',
    required: ['path', 'removed'],
    optional: [],
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
  /** Declared fields the broadcast did not carry. */
  missing: string[];
  /** Fields the broadcast carried that the contract does not publish. */
  undeclared: string[];
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
  for (const field of spec.required) {
    if (msg[field] === undefined) missing.push(field);
    else payload[field] = msg[field];
  }
  for (const field of spec.optional) {
    if (msg[field] !== undefined) payload[field] = msg[field];
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

  return { payload, missing, undeclared };
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
