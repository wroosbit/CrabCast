// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import { HerdrAgentStatus } from './herdr.js';

/**
 * Which work gets the machine when there is not enough machine.
 *
 * The capacity model (KAN-36, in the extraction source) gave the cap a number
 * and a legible refusal. What it could not do is choose: at capacity every
 * activation was refused identically, so an agent that needed to start could
 * not, and the person asking was left to work out for themselves what to stand
 * down. This file is the missing comparison.
 *
 * WHERE PRIORITY COMES FROM
 *
 * The agent's own record, frozen onto it by `configure`. It used to come from
 * the agent's workspace *type*; types are deleted, so there is nothing left to
 * look it up in and the value lives where every other per-agent knob now
 * lives. What a priority number means is still decided by whoever calls
 * `configure`, by ordering their agents against each other.
 *
 * The alternative — reading urgency off the tracker item an agent is working —
 * was proposed in the extraction source and rejected, and the reasons survive
 * the re-key unchanged because the alternative will be suggested again:
 *
 *   - No lookup. Priority is on the record the activation already read, so it
 *     is in hand at the moment it is needed. Asking an external tracker would
 *     put a network call on the activation path for a question already
 *     answered.
 *   - Every caller works. A CLI toggle cannot supply a tracker priority and an
 *     agent activating over MCP can; a value on the record is available to
 *     both, identically, so there is no path that degrades.
 *   - Top-of-scale safety is not a rule. Whatever sits at the top of a
 *     caller's scale, nothing outranks it by construction rather than by an
 *     exception anyone has to remember to code. See {@link outranks}.
 *
 * There are no named priority constants here, deliberately: the extraction
 * source's PRIORITY_EPIC/STORY/TASK were its config, expressed as code.
 *
 * AND THERE IS NO FLOOR ANY MORE. `WorkspaceRegistry.priorityFor` used to give
 * an unregistered type the lowest declared priority, so that a resolution
 * failure landed somewhere it could not kill another agent's work. Nothing
 * resolves now: `priority` is a required `configure` parameter carried on the
 * record, and an agent with no record cannot be activated at all — so the
 * failure that fallback existed to contain has no way to occur.
 */

/**
 * Strictly greater, not greater-or-equal.
 *
 * Equal-priority preemption is churn in the general case — two agents at the
 * same level displacing each other indefinitely — and the argument is sharper
 * on a short scale than a long one. With a handful of levels, *equal* is the
 * normal case at every level: several supervising agents and a machine full
 * of worker agents at the same priority can all be staffed at once.
 * Greater-or-equal would therefore mean any agent may kill any peer of its
 * own level, making the choice of victim arbitrary and every activation a
 * coin toss over somebody's uncommitted work.
 *
 * Strictly-greater makes peer-versus-peer always a refusal, which is the
 * honest answer: the machine is full of work exactly as important as yours.
 * And it protects the top of the scale absolutely — nothing can displace an
 * agent of the highest declared priority, including another one.
 */
export function outranks(incoming: number, running: number): boolean {
  return incoming > running;
}

/**
 * How much an agent stands to lose by being stood down right now, lowest
 * first.
 *
 * The obvious proxy is "least recently active": an agent mid-compile has more
 * to lose than one idling. There is no last-active timestamp anywhere in this
 * daemon — but herdr already reports what each agent is *doing*, which is the
 * thing that proxy was reaching for, measured rather than inferred.
 *
 *   done    — finished. There is nothing in flight to destroy.
 *   idle    — at a prompt with no turn to take.
 *   blocked — waiting on a human, so not computing, but mid-task.
 *   unknown — herdr has nothing to say; assume it is working.
 *   working — actively producing. Taken last.
 */
const STATUS_COST: Record<HerdrAgentStatus, number> = {
  done: 0,
  idle: 1,
  blocked: 2,
  unknown: 3,
  working: 4
};

/** One agent considered as something that could be stood down. */
export interface PreemptionCandidate {
  /** The canonical directory this agent is. */
  path: string;
  /** The opaque herdr token for that path, for log lines and events. */
  paneName: string;
  priority: number;
  /** herdr's own view of what it is doing, right now. */
  herdrStatus: HerdrAgentStatus;
  /**
   * When the registry recorded it activated, falling back to the session's
   * creation time. Null when neither knows — absent data stays absent rather
   * than being invented for the victim ordering.
   */
  activatedAt: string | null;
}

/**
 * Why an agent was stood down when it was not the agent's own idea: who took
 * the slot, what both were worth, and the capacity arithmetic that made the
 * slot necessary.
 *
 * Built by the capacity gate's preempt path, carried on the
 * `agent.deactivated` broadcast's `preemption` block and the deactivate payload,
 * and persisted
 * by `AgentRegistry.recordDeactivated(record, preemption)`.
 */
export interface PreemptionRecord {
  /** The agent that took this one's slot, by the directory it is. */
  byPath: string;
  byPaneName: string;
  byPriority: number;
  /** What the preempted agent was worth, so the comparison is legible later. */
  priority: number;
  /** What herdr said it was doing at the moment it was stood down. */
  herdrStatus: string;
  /** The capacity arithmetic that made the slot necessary. */
  derivation: string;
}

/**
 * Victim ordering: the better victim sorts first.
 *
 * Lowest priority, then least to lose, then oldest, then name. The last two
 * terms exist for determinism rather than judgement — the same fleet must
 * always yield the same victim, or a refusal that names one agent and a
 * preemption that kills another would be the same request.
 *
 * An agent with no activation record sorts *last* among its equals. Knowing
 * least about something is a reason to be more careful with it, not less.
 */
export function compareVictims(a: PreemptionCandidate, b: PreemptionCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const cost = STATUS_COST[a.herdrStatus] - STATUS_COST[b.herdrStatus];
  if (cost !== 0) return cost;

  if (a.activatedAt !== b.activatedAt) {
    if (a.activatedAt === null) return 1;
    if (b.activatedAt === null) return -1;
    return a.activatedAt < b.activatedAt ? -1 : 1;
  }

  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The agent that would be stood down to make room for `incoming`, or null when
 * there is nothing this activation outranks.
 *
 * Null is the ordinary answer, not an error: it is what a worker agent gets on
 * a machine full of workers of its own priority, and what anything gets on a
 * machine holding only top-of-scale agents.
 */
export function selectVictim(
  candidates: PreemptionCandidate[],
  incoming: number
): PreemptionCandidate | null {
  const eligible = candidates.filter((c) => outranks(incoming, c.priority));
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareVictims)[0];
}

/** The whole address, which is now just the path. */
export function addressOf(candidate: PreemptionCandidate): string {
  return candidate.path;
}

/** `/home/me/work (priority 1, idle)` — one candidate, for prose. */
export function describeCandidate(candidate: PreemptionCandidate): string {
  return `${addressOf(candidate)} (priority ${candidate.priority}, ${candidate.herdrStatus})`;
}

/**
 * What is running and what each one is worth.
 *
 * This is the refusal proof's requirement in one function: someone who has just
 * lost a slot must be able to see *why* they lost it, which means seeing what
 * beat them and by how much. Ordered as victims are, so the first name is the
 * one that would have gone had the caller outranked it.
 */
export function describeFleetPriorities(candidates: PreemptionCandidate[]): string {
  if (candidates.length === 0) return 'nothing is running that could be stood down';
  return [...candidates].sort(compareVictims).map(describeCandidate).join(', ');
}

/**
 * Why an activation that could have preempted was refused anyway.
 *
 * Preemption is opt-in per activation, which is the same principle as the
 * visible capacity refusal: someone switching an agent on must not silently
 * destroy another's work. So this is what the caller gets *instead* of a kill
 * — the name of what would die, what it is doing, and the flag that
 * authorises it.
 */
export function preemptionOffer(victim: PreemptionCandidate, incoming: number): string {
  return (
    `Standing down ${describeCandidate(victim)} would make room: this activation is ` +
    `priority ${incoming}, which outranks it. That is not done automatically — ` +
    `pass preempt: true to authorise it, and its uncommitted work is interrupted. ` +
    `It can be re-activated later and will resume the conversation it was stopped in.`
  );
}

/** Why nothing could be stood down for this activation. */
export function noVictimReason(candidates: PreemptionCandidate[], incoming: number): string {
  return (
    `Nothing running is below priority ${incoming}, so there is nothing this ` +
    `activation may stand down. Running: ${describeFleetPriorities(candidates)}. ` +
    `Preemption is strictly-greater: an agent may not displace one of its own ` +
    `priority.`
  );
}
