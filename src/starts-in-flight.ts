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
//   * `headroomByMemory` — PARTLY blind, MEASURED, and DELIBERATELY NOT
//     CHARGED. `MemAvailable` is read live per call so it sees each agent's
//     memory as the kernel hands it over; what it cannot see is the ramp, the
//     seconds between a spawn and that agent holding its steady-state resident
//     set. This paragraph used to say that charging it would need a constant
//     nobody had measured, and pointed at KAN-285. KAN-285 measured it, and
//     the answer is that no charge should land. See THE RAMP, MEASURED below —
//     the pointer is retired rather than left dangling.
//
// ---------------------------------------------------------------------------
// THE RAMP, MEASURED — and why `headroomByMemory` is still charged nothing
// (KAN-285)
// ---------------------------------------------------------------------------
//
// THE INSTRUMENT. `scripts/kan285-start-ramp.mjs`, which samples every
// agent-runtime tree on the machine through `agent-cost.ts`'s own walker — so a
// tree here is a tree by exactly the definition the capacity model divides by,
// rather than by a second walker that would answer about a different thing.
//
// THE POPULATION, STATED BECAUSE IT IS HALF THE READING. Five CrabCast agent
// trees, started by this daemon through `crabcast activate`, over four windows
// on 2026-08-14: three windows sampled at 1s (60s, 60s, 25s) and one at 250ms
// (25s). They were IDLE agents — launcher `claude`, given a prompt telling them
// to do nothing — which is a real CrabCast population and NOT a working one.
// The settled trees in the same windows were another orchestrator's, and are
// reported as the control rather than as data: 0.0–2.1% spread across six
// trees, against 64–91% for the five that were ramping, which is what makes a
// ramp separable from ordinary variation here at all.
//
// WHAT IT DOES. Resident set at first sighting is 72–246 MB, at one process.
// It reaches 95% of that tree's own settled plateau in 1.0–4.0s and 99% in
// 2.0–7.0s, and the plateau is 631–681 MB across the five.
//
// AND THE DEFICIT NEVER CLOSES, WHICH IS THE FINDING THAT DECIDES THIS. The
// quantity a charge would add back is the memory the model assumed and the
// kernel has not yet handed over — `(cost.residentBytes − resident) /
// cost.residentBytes`, in agent-equivalents. Measured against the then-current
// 800 MB divisor — KAN-390 has since raised it to 1050, which makes every
// figure in THIS paragraph, all of them idle trees, a larger over-charge still;
// what a WORKING tree does to the same arithmetic is the KAN-390 note below —
// it is 0.69–0.91 at first sighting, 0.13–0.46 at three seconds, and
// then it stops falling: it settles on a FLOOR of 0.15–0.21 and stays there for
// as long as the agent lives, because an idle tree plateaus BELOW the divisor.
// So there is no instant at which "the ramp completed" and the charge should
// stop. A reference period derived from this measurement would be the time to
// reach a plateau that the model already over-counts — the charge would be
// adding back memory that is not missing.
//
// THE COMPARISON THAT SETTLES THE SCALE, against the term that WAS charged.
// Reconciliation restores every `RESTORE_STAGGER_MS` = 3s. Net of that floor,
// a start is under-counted by between −0.05 and +0.30 of an agent across the
// five — negative for one of them, meaning the model was still OVER-charging it
// — at the moment the NEXT restore is gated. At most 238 MB against an 800 MB
// divisor feeding an integer floor, so it cannot move the term except exactly
// on a boundary. The CPU term's blindness was up to ten WHOLE starts against one
// reading, because its instrument refreshes every 30s while the loop starts an
// agent every 3s. That is the ratio the header above opens with, and it is the
// whole difference between the two terms. The condition stated above for serial
// gating to compose is that the gap between starts exceed the interval at which
// the measurement refreshes; for `MemAvailable` that interval is ZERO, since it
// is re-read on every call, so all that is left to clear is the LAG between a
// spawn and that memory becoming visible — 2–4s against a 3s stagger. Note what
// that is and is not: PARITY, not comfortable margin, and one of the five was
// still 0.30 of an agent short at three seconds. The CPU term had a 30s refresh
// against the same 3s stagger and failed the condition by a factor of ten. A
// term at parity leaves a residue that is a fraction of one agent; a term off by
// ten leaves ten whole ones, and that is the difference the two decisions turn
// on rather than one being blind and the other not.
//
// AND THE CONSTANT WOULD NOT BE DERIVED FROM ITS INSTRUMENT, which is the
// objection that would survive even if the numbers were larger. Every reference
// period in this file is what its instrument IS — a CPU observation's own
// `windowSeconds`, or `LOAD1_PERIOD_MS` as the definition of `os.loadavg()[0]`.
// `MemAvailable` is instantaneous and has no window, so a ramp period would be
// a property of this machine, this launcher and this day, with nothing to
// notice when it stopped being true. That is the uncheckable number
// `capacity.ts`'s header spends forty lines refusing, and measuring it once
// does not convert it into a derived one.
//
// WHAT STILL BOUNDS A BURST, so that this is a decision rather than a hole:
// `headroomByCap` is exact and instantaneous — `running` is re-surveyed before
// every gate decision — so a simultaneous burst is bounded by the count term
// whatever memory believes; and on a machine where memory genuinely binds,
// `MemAvailable` falling IS the signal, within the 2–4s above.
//
// AND ON THE MACHINE THIS WAS MEASURED ON, MEMORY DOES NOT BIND. `crabcast
// capacity` at measurement time: cap 3 bound by cpu (cpu allows 3, memory 16),
// headroom 2 bound by cpu (count allows 3, cpu 2, memory 6). That is CrabCast's
// own arithmetic and is worth reading off CrabCast rather than off whatever
// other orchestrator is on the box — a figure measured off one population and
// reported as another's is the mistake `MEASURED_AGENT_COST`'s own header
// records having made. It does not carry to a machine where memory binds, which
// is why the paragraphs above argue from the stagger and the count term rather
// than from this reading.
//
// WHAT WOULD REOPEN THIS, named so the next reader has a test rather than a
// verdict:
//   * `RESTORE_STAGGER_MS` dropping below the ramp, or any caller path that
//     issues activations SIMULTANEOUSLY rather than staggered. The argument
//     above is that the stagger exceeds the ramp; it does not survive the
//     stagger going away.
//   * A population whose plateau EXCEEDS the divisor. The floor above is
//     positive — an over-charge — only because these trees settle below the
//     divisor. For a population that settles above it the floor is negative and
//     the under-charge is permanent rather than transient, which is a question
//     about the seed and belongs to KAN-275, not here. Six settled trees in
//     these same windows held 721–919 MB, so that population demonstrably
//     exists on this machine; it is reported on KAN-285 and deliberately not
//     acted on here. KAN-390 answered this one — see directly below.
//
// THE IDLE GAP, CLOSED (KAN-390) — and the decision above is unchanged by it.
// The paragraph that stood here said that all five trees were idle by
// construction, so the plateau above is an idle plateau, and asked for the
// script to be re-run against a working fleet. That has been done, and the
// pointer is retired rather than left dangling: eight CrabCast trees given real
// work at spawn, over four windows on 2026-08-14, reported in full in
// `capacity.ts`'s KAN-390 note.
//
// WHAT IT FOUND, AND WHY IT LANDS ON THE SEED RATHER THAN HERE. A working tree
// has no single plateau: it sits at 699–791 MB while reading and thinking and
// rises to 1004–1044 MB for the 6–13s it runs a build. So the reopening
// condition named in the bullet above is NOT met — the level a working tree
// settles at is below the divisor, as the idle one was — while the peaks are
// above the OLD 800 MB divisor, and correlate across agents that start
// together. That is a statement about how much an agent costs, not about
// blindness in the memory instrument, so KAN-390 raised the seed to 1050 MB and
// changed nothing in this file's decision.
//
// AND THE FLOOR STAYS POSITIVE, WHICH IS WHAT THE DECISION ACTUALLY RESTS ON.
// Against the 1050 MB divisor the deficit is ~0.31 of an agent at a working
// tree's thinking level (p50 729 MB) and ~0.006 at its compile peak (1044 MB).
// That STRADDLES the 0.15–0.21 the idle trees gave against the old divisor
// rather than sitting under it — wider at rest, and very nearly closed at a
// peak — so the honest summary is not "the margin grew" but "it stayed positive
// at every instant measured, and its worst case is now thin". Positive is what
// the decision needs: a charge added here would still be adding back memory
// that is not missing. What is NOT covered, stated rather than implied: 0.006 is
// a margin thin enough that a workload heavier than build-and-read could close
// it, and nobody has measured one.
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
 * ONLY WHERE NO AGENT WAS EVER THERE — a spawn herdr refused, an activation
 * that failed confirmation. Those cost the machine nothing, and charging for
 * them would refuse the next activation on the strength of an agent that does
 * not exist.
 *
 * AN AGENT THAT STOPPED IS NOT FORGOTTEN, INCLUDING A PREEMPTED ONE, and that
 * is a decision rather than an omission — it is worth naming because the
 * obvious reading is that a dead agent should stop being charged. Both answers
 * are slightly wrong and in opposite directions: keeping it charges cores
 * nothing is now spending, and dropping it under-charges the work it really did
 * inside a window the observation has not yet been replaced. The error either
 * way is bounded by one agent and by the length of one window, and the
 * tie-break is that under-charging is the direction that took a machine down.
 * It ages out on its own, so nothing accumulates.
 *
 * Note this is not the lever that makes room after a stand-down: `running`
 * drops immediately in the count term, and the CPU-side charge clears itself at
 * the next observation.
 */
export function forgetAgentStart(path: string): void {
  starts = starts.filter((s) => s.path !== path);
}

/** Empty the ledger. For the daemon's own tests and for the proofs; nothing in
 *  production calls it. */
export function clearStartsInFlight(): void {
  starts = [];
}
