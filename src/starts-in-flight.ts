// When each agent was started, so the capacity gate can charge for the ones
// its instruments have not finished measuring (KAN-263).
//
// THE DEFECT THIS EXISTS FOR, in one sentence: the gate is sound per
// activation and was blind in aggregate, because the instrument it divides
// refreshes ten times more slowly than the loop that starts agents.
//
// Three constants make that concrete, all still true on `main` at 7c6d97f:
// the daemon takes a CPU window every `CPU_SAMPLE_INTERVAL_MS` = 30s
// (daemon.ts), reconciliation restores every `RESTORE_STAGGER_MS` = 3s
// (reconcile.ts), and an observation is believed for `MAX_OBSERVATION_AGE_MS`
// = 75s (machine-cpu.ts). So roughly ten restores happen between two samples,
// and every one of them is measured against a reading taken BEFORE ANY OF THEM
// EXISTED. The eleventh sees the first ten; the first ten see none of each
// other.
//
// WHY THE STAGGER DOES NOT ALREADY FIX IT. A stagger spaces starts; it does
// not make the instrument notice them. For serial gating to compose, the gap
// between starts has to exceed the interval at which the measurement refreshes
// — 3s against 30s means the gate answers from a snapshot for nine decisions
// out of ten. Lengthening the stagger to 30s is the other correct fix and it
// costs five minutes to restore ten agents; this file is the cheap one.
//
// WHICH TERMS ARE BLIND AND WHICH ARE NOT, because charging a term that can
// already see is double-counting and that is its own defect:
//
//   * `headroomByCap` — NOT blind. `running` is re-surveyed off herdr's live
//     census before every gate decision, and `handleActivate` does not respond
//     until `confirmActivation` has seen the pane, so restore N+1 counts all N
//     before it. It composes correctly today and is charged nothing here.
//   * `headroomByCpu` — BLIND, and this is the ticket. See above.
//   * `headroomByLoad` — BLIND for the same reason and worse: `os.loadavg()[0]`
//     is an exponential mean over the last minute, so work that started three
//     seconds ago is a rounding error in it. It fills the CPU-side slot only
//     where nothing measured CPU, and it is charged here too — otherwise the
//     blindness returns intact on exactly the machines that have no /proc/stat.
//   * `headroomByMemory` — PARTLY blind, and deliberately NOT charged here.
//     `MemAvailable` is read live per call so it sees each agent's memory as
//     the kernel hands it over; what it cannot see is the ramp, the seconds
//     between a spawn and that agent holding its steady-state resident set.
//     Charging it would need a constant for how long that ramp takes, and this
//     model has no such measurement — every reference period below is derived
//     from what its own instrument IS, not from a number somebody picked. That
//     hole is named rather than closed, and KAN-285 is filed against it —
//     including the instruction that if the answer turns out to be "no charge
//     is worth it", that decision is recorded HERE rather than leaving this
//     paragraph pointing at a question nobody closed.
//
// WHAT THIS FILE IS NOT. It is not a second census and it is not authoritative
// about which agents exist — `surveyAgents` is, and it asks herdr. This is a
// list of instants, kept only so the arithmetic in capacity.ts can ask "how
// much of the fleet is younger than the reading I am dividing".

/** One start, as an instant. */
export interface AgentStart {
  /** The agent's directory, for the log line and for pruning by hand. */
  path: string;
  /** Wall-clock ms (Date.now()) at which the spawn was issued. */
  at: number;
}

/**
 * How long an entry is kept.
 *
 * THIS IS A MEMORY BOUND, NOT A CORRECTNESS PARAMETER, and the distinction is
 * the reason it is allowed to be a round number when nothing else here is.
 * What decides whether a start is charged is the per-start predicate in
 * capacity.ts, which compares it against the reference period of whichever
 * instrument answered. An entry older than every such period is charged zero
 * whether it is still in this list or not, so pruning it changes no answer —
 * it only stops an uptime-long daemon from accumulating one number per agent
 * it has ever started.
 *
 * Five minutes is comfortably beyond the longest reachable reference period: an
 * observation may be believed for `MAX_OBSERVATION_AGE_MS` (75s) and its window
 * opened `windowSeconds` before it was taken (30s in production, and the
 * daemon's first is 3s), so the oldest instant any term can charge is about
 * 105s old. `verify-restore-admission.mjs` §7 asserts that relationship rather
 * than trusting this paragraph, because a prune that started eating chargeable
 * entries would silently reopen the gate and every other assertion here would
 * stay green.
 */
export const START_LEDGER_HORIZON_MS = 300_000;

/**
 * The ledger, held at module scope for the same reason `liveMeasuredCost` and
 * the published CPU observation are: every `readCapacity()` in this process
 * must divide the same figures, and a per-connection router holding its own
 * copy is two routers that disagree about how much of the fleet is new.
 */
let starts: AgentStart[] = [];

/**
 * Record a spawn. Called from the one place in the daemon that starts an agent
 * — `handleActivate`, immediately around `spawnSession` — because a start
 * recorded anywhere else is a start some other path can forget.
 *
 * Recorded at the moment the spawn is ISSUED rather than confirmed. The two are
 * seconds apart, and those seconds are precisely the ones in which the agent is
 * spending the most CPU it will ever spend and no instrument has priced it.
 */
export function recordAgentStart(path: string, at: number = Date.now()): void {
  starts.push({ path, at });
  // Against the WALL CLOCK, never against `at`. In production the two are the
  // same, and they are not the same for a caller that backdates a record — a
  // proof, a replay — where pruning against an old instant would keep entries
  // the horizon should have dropped and drop none of the ones it should.
  pruneStarts();
}

/** Drop entries older than the horizon. Called on write; see the constant. */
export function pruneStarts(now: number = Date.now()): void {
  const floor = now - START_LEDGER_HORIZON_MS;
  if (starts.some((s) => s.at < floor)) starts = starts.filter((s) => s.at >= floor);
}

/** Every start still on the ledger, oldest first. */
export function startsInFlight(): readonly AgentStart[] {
  return starts;
}

/**
 * Forget a start.
 *
 * Used where an agent is known to have gone — a spawn herdr refused, an
 * activation that failed confirmation. An agent that stopped normally is NOT
 * forgotten here and that is deliberate: its cost really was in the window the
 * gate is dividing, so removing it would understate, and understating is the
 * direction that took a machine down. It ages out of the horizon on its own.
 */
export function forgetAgentStart(path: string): void {
  starts = starts.filter((s) => s.path !== path);
}

/** Empty the ledger. For the daemon's own tests and for the proofs; nothing in
 *  production calls it. */
export function clearStartsInFlight(): void {
  starts = [];
}
