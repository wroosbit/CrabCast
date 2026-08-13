// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as fs from 'fs';
import * as os from 'os';
import { CpuObservation, freshObservedCpu } from './machine-cpu.js';
import {
  StallFacts,
  StallSource,
  STALL_REFUSE_PERCENT,
  describePressureReading,
  readStallFacts,
  stallInstrument,
  worstStall
} from './machine-pressure.js';
import { AgentStart, startsInFlight } from './starts-in-flight.js';

export type { CpuObservation, StallFacts, StallSource };
export { STALL_REFUSE_PERCENT };

/**
 * How many agents this machine can carry — measured, not declared.
 *
 * On 2026-07-31 the extraction source's board manager staffed seven agents on
 * a 4-core laptop: load average 11.3 against 4 cores, 9 claude processes
 * holding 3.0 GB, and 319 MB of 15 GB free. Nothing in the product knew any of
 * that. The only instrument that noticed was a human saying the desktop felt
 * slow (KAN-34, in the extraction source).
 *
 * Everything here is arithmetic over figures read from the machine, so the
 * answer travels: the same code on a 64-core box says 73, not 2. The
 * arithmetic is deliberately simple and deliberately explained — a cap nobody
 * can follow is a cap people route around.
 *
 * The costs below are calibrated against that incident and are meant to be
 * re-measured, which is why they are constants with names rather than magic
 * numbers, and why every one of them has an environment override.
 *
 * KAN-36 (in the extraction source) corrected two things about the first
 * version, both discovered the same way — a human found the product unusable
 * and no instrument had noticed:
 *
 *   - The cap counts *charged* agents. At the time there was one always-on
 *     supervisor, so KAN-36 reserved its share off the top like herdr's rather
 *     than spending it from the same budget as the work. Counting it had left
 *     a 4-core machine able to run exactly one worker agent, forever.
 *   - An agent is a process tree, not a process. The MCP servers every agent
 *     starts are most of the difference between 480 MB and the 650 MB one
 *     actually holds.
 *
 * KAN-36's one-slot supervisor reservation was deliberately unconditional.
 * That was right when it was written, and then the thing it assumed was
 * removed: there is no longer one always-on supervisor. Zero or more
 * supervising agents are staffed and stood down as work comes and goes, and a
 * fixed reservation for one of them had become arithmetic about an agent that
 * may not exist.
 *
 * The rule that replaced it (KAN-41, in the extraction source), now expressed
 * per agent rather than per workspace type: only *chargeable* agents are
 * counted. An agent a caller configured with `chargeable: false` is not counted
 * in `running` — that flag is asked for because the agent supervises rather
 * than does the work, typically low-resource and idle, not competing for the
 * machine the way a worker compiling a repo does. Such agents are reported in
 * `Capacity.exemptAgents`, so a reader of a capacity report can see they exist.
 *
 * KAN-275 CORRECTED THE SECOND HALF OF THAT, which used to read "neither
 * counted in `running` nor reserved for". Not counted is right. Not reserved
 * for was right about the LIVE terms and wrong about the STATIC one, and the
 * difference is which numerator each divides:
 *
 *   - `headroomByMemory` divides `availableBytes` (MemAvailable). The kernel
 *     has already subtracted every uncharged agent's resident memory from it,
 *     so that term feels them without being told, and a reserve there would
 *     charge for them twice.
 *   - `capByMemory` divides `totalBytes`, which nets out nothing. With no
 *     reserve, the static ceiling described a machine with no supervisors on
 *     it — roughly 0.9 GB of real memory per uncharged agent absent from the
 *     arithmetic entirely.
 *
 * So `cap` is now cores and memory minus the human reserve, herdr's overhead,
 * AND `exemptAgents × EXEMPT_AGENT_MEMORY_BYTES`. The rule that survives is
 * narrower and truer than the one it replaces: no term may net a population out
 * of its numerator and also count it in its denominator, and no term may leave
 * a population out of both.
 *
 * `chargeable` used to be one third of a `gateExempt` boolean declared on a
 * workspace type. Splitting it out is what lets a caller have an agent that
 * costs a slot but can never be taken, or one that is free but still refusable
 * — combinations the single flag could not express.
 *
 * KAN-44/KAN-56 (both in the extraction source) closed the loop this header
 * opened. `readCapacity()` always read cores, memory and load live; the one
 * static input left was the per-agent cost divisor, measured once on
 * 2026-07-31. Now the daemon re-measures its own fleet on a timer (daemon.ts,
 * with agent-cost.ts as the instrument), damps the estimate
 * (agent-cost-damping.ts — asymmetric on purpose, see that file), and this
 * arithmetic divides by the damped figure. The constants below remain as the
 * *seed*: what capacity answers from when there is nothing to measure — no
 * agent trees, no /proc, a sample that fails validation — because whatever
 * breaks, capacity still answers, conservatively.
 *
 * That accuracy is paid for in predictability. The original argument here was
 * for a static cap — "a cap nobody can follow is a cap people route around" —
 * and a divisor that moves with the fleet is exactly a cap nobody can follow
 * from the constants alone. So the deal is: the cost input may move, but every
 * report says where each figure came from (seed, measured, or override), when
 * the sample was taken, over what window, from how many trees — and the
 * arithmetic from those printed figures to `cap` stays reproducible by hand.
 * A reader who cannot predict tomorrow's cap can still check today's.
 *
 * Precedence is strict and short: an operator override
 * (CRABCAST_AGENT_CORES / CRABCAST_AGENT_MEMORY_MB) beats the measurement
 * outright — someone who typed a number into their environment has re-measured
 * or decided, and a fleet that argues with its operator gets turned off. The
 * measurement beats the seed. The seed is what remains. CRABCAST_MAX_AGENTS
 * still pins the cap and skips the derivation entirely.
 *
 * ---------------------------------------------------------------------------
 * KAN-208: WHAT LIVE HEADROOM BOUNDS AGAINST, AND WHY IT IS NO LONGER THE LOAD
 * AVERAGE
 * ---------------------------------------------------------------------------
 *
 * Until this change, live headroom had three bounds — count, load average,
 * memory — and NONE of them was observed CPU. So the quantity deciding whether
 * an agent could start was `os.loadavg()[0]`.
 *
 * THE DEFECT. On Linux the load average counts TASK_UNINTERRUPTIBLE as well as
 * TASK_RUNNING: a process blocked in a disk read is in it exactly as much as
 * one burning a core. A machine doing heavy I/O therefore reports a high load
 * with idle cores, and this gate refused activations it had the capacity to
 * serve — saying "load too high" in figures that were internally consistent and
 * described the wrong thing. That was not theoretical. It was measured on the
 * machine this was written on: an activation refused at `headroom 0, bound by
 * load, load1 5.70` while CPU actually in use was ~1.4 of 4 cores. Two tickets
 * (KAN-191, KAN-194) and an eight-hour intermittency hunt are downstream of it,
 * both of them treating the symptom.
 *
 * THE DECISION. The live CPU-side bound is now `cpuBusy` — cores actually in
 * use, read from /proc/stat over a real window (machine-cpu.ts). The load
 * average is still read, still reported on every line, and no longer gates.
 *
 * WHY NOT KEEP LOAD AS A SECOND BOUND ALONGSIDE IT. Because `headroom` is a
 * `Math.min`, and a min with the broken term still in it is still broken: at
 * load1 5.70 on four cores the load term answers 0 whatever the CPU
 * measurement says, and the exact refusal this ticket exists to stop happens
 * unchanged. "Both, and the smaller wins" is the right shape for terms that
 * disagree because they measure DIFFERENT resources — count, CPU and memory
 * do. It is the wrong shape for two terms measuring the SAME resource where
 * one is known to be wrong about it. Load and cpuBusy both answer "how much
 * CPU is left"; one answers by measuring CPU and the other by measuring queue
 * length. Keeping the worse instrument as a veto over the better one is not
 * caution, it is the defect with a second opinion attached.
 *
 * WHERE LOAD DOES STILL BIND: when nothing has measured CPU. No /proc/stat
 * (macOS, Windows), no sampler running yet, or a sampler gone stale — then
 * `headroomByCpu` is null and the load term is the bound, exactly as before.
 * That is the conservative direction and it is labelled: the report says
 * `bound by load` and calls the term a fallback, so a reader can tell "CPU says
 * there is room" from "nobody looked".
 *
 * WHAT THIS IS NOT. It is not a knob. KAN-194 rejected "let a caller pin the
 * load term out of the calculation" as a footgun aimed at the capacity gate,
 * and that reasoning stands untouched: nothing here lets a caller state a value
 * for load or for CPU. There is no CRABCAST_CPU_BUSY. The gate reads the
 * machine; the only thing that changed is which file it reads it from.
 *
 * WHAT THIS DOES NOT WEAKEN. A genuinely busy machine still refuses: cpuBusy at
 * or near the core count drives the term to 0 exactly as a high load did. The
 * count term is untouched, and it is what refuses a full fleet of idle agents —
 * most of an agent's life is spent waiting on an API, so a fleet at its cap can
 * be nearly invisible to any CPU instrument. That is why `cap` exists and why
 * it is not going anywhere. The memory term is untouched.
 *
 * AND WHAT IT GIVES UP, because a measurement narrower than the proxy it
 * replaces has to say so. The load average was, accidentally, a signal about
 * more than CPU: a machine thrashing on swap or blocked on a failing disk shows
 * a high load with idle cores, and this gate used to refuse it. It will now
 * start agents there. Two things reduce that and neither closes it — memory
 * pressure is the memory term's job and is unchanged, and `load1` is still
 * printed beside `cpuBusy` on every report, so a machine where the two diverge
 * wildly is visible to anyone reading a refusal or a capacity response. What is
 * left uncovered is I/O saturation on a machine with memory to spare, and
 * nothing in this file covers it. machine-cpu.ts names the same seam from the
 * instrument's side.
 *
 * ---------------------------------------------------------------------------
 * KAN-216: THE STALL VETO — WHAT NOW BOUNDS THE SEAM THE PARAGRAPH ABOVE NAMED
 * ---------------------------------------------------------------------------
 *
 * That last paragraph was a promise to whoever came next, and this is it. The
 * instrument is /proc/pressure (PSI), `full avg10`, on both `io` and `memory`;
 * why that and not /proc/stat's iowait, why `full` and not `some`, and why both
 * files, are all argued in machine-pressure.ts beside the reader.
 *
 * A VETO, NOT A FOURTH COUNT — which is why there is no `headroomByStall`.
 * Every other term is `(budget − in use − reserved) ÷ per-agent cost` and
 * answers in agents. This one cannot honestly take that shape: there is no
 * measured per-agent I/O cost to divide by, and inventing one so the arithmetic
 * looked symmetrical would be exactly the dimensional confusion KAN-208 exists
 * to have removed. A stalled machine does not have room for 0.4 of an agent; it
 * has no room. So the honest model is a veto that zeroes whatever the three
 * counting terms computed, `headroomBoundBy` gains `'stall'`, and
 * {@link Capacity.headroomBeforeStall} keeps the room the machine would
 * otherwise have had — because a veto whose effect is invisible looks exactly
 * like a machine that happened to be full.
 *
 * IT NAMES ITSELF ONLY WHEN IT IS THE REASON THERE IS NO ROOM. If the board was
 * already full, `cap` still binds, by the same tie rule as the other terms: the
 * reader can close an agent, and cannot hurry a disk.
 *
 * AND NO PREEMPTION IS OFFERED ON A STALL. That is enforced in router.ts, and
 * the reason belongs here with the model: preemption exists to free a SLOT, and
 * a stalled machine is not short of slots. Standing an agent down would destroy
 * its work and then start a replacement onto the same stalled disk — the one
 * outcome worse than refusing. A stall refusal offers no victim and says why.
 *
 * NO KNOB, AND THIS IS A DELIBERATE DIVERGENCE FROM THE TREE THE INSTRUMENT
 * CAME FROM. The extraction source gives its threshold an environment override.
 * This one has none. KAN-194 rejected letting a caller state a value into the
 * capacity gate as a footgun aimed at the gate, KAN-208 upheld it, and the
 * ticket that commissioned this term carried it forward as a standing condition
 * — a third term does not reopen it. There is no CRABCAST_STALL_PERCENT, in the
 * same way and for the same reason that there is no CRABCAST_CPU_BUSY. The
 * escape hatch already exists and is better: `override: true` on the activation
 * starts the agent anyway and is recorded WITH the arithmetic that refused it,
 * which is a decision on the record rather than a number in an environment
 * nobody can see afterwards.
 *
 * WHAT THIS MAKES NEWLY POSSIBLE, asked deliberately rather than discovered
 * later, because KAN-208's whole lesson is that a term can quietly carry a
 * second job. A stall gate refuses activations whenever the machine is not
 * making progress — and "not making progress" is not only a failing disk. A
 * heavy synchronous build, a large image write or a restore could in principle
 * reach the same figure, and on those the term would be doing something beyond
 * bounding I/O saturation: it would be deferring agent starts during heavy
 * legitimate work. That is why the threshold sits where it does. Measured on
 * this machine on 2026-08-10, a full TypeScript build moved `io full avg10` not
 * at all, and a deliberate four-way synchronous-write stress reached 30.48%
 * against a threshold of 50 — so the answer here is that it makes nothing newly
 * possible in ordinary operation, by construction and by measurement. If that
 * ever stops being true, the number is what should move.
 *
 * WHERE THERE IS NO PSI THE TERM IS INERT AND SAYS SO, IN WORDS. An absent or
 * unreadable pressure file is never read as 0.00%, which would be an all-clear
 * from an instrument that never looked, and the three-way distinction that
 * makes that unrepresentable is machine-pressure.ts's whole shape. On such a
 * machine I/O saturation is bounded by nothing at all, exactly as it was before
 * this change, and the derivation prints that sentence rather than a
 * reassuring number.
 */

export const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** What one agent costs the machine while it is working. */
export interface AgentCost {
  /** Resident memory the agent holds, working or idle. */
  residentBytes: number;
  /** Load-average units the agent contributes while active. */
  cores: number;
}

/**
 * Measured on 2026-07-31 in the extraction source, re-measured the same
 * evening, so the next argument with these numbers can be settled with
 * evidence.
 *
 * `residentBytes` went up, and the reason is the correction: 480 MB was the
 * `claude` process, and an agent is not a process. Every agent also carries
 * its MCP servers, which the morning's measurement never looked at. Measured
 * over the whole tree: 654, 658 and 679 MB across three live agents, of which
 * the claude process itself was 424–443 MB. 650 MB is the bottom of that
 * range, and memory is the dimension that kills rather than slows.
 *
 * `cores` is neither of the two numbers that can be measured directly, and
 * that is the whole difficulty. Measured CPU is 0.15 cores per agent tree over
 * 90 seconds (0.02–0.24 across three agents), because most of an agent's life
 * is spent waiting on an API; calibrating on that says a 4-core box carries
 * sixteen, and the human who filed KAN-34 (in the extraction source) had
 * already found out what seven feels like. The load average is the other
 * extreme: seven agents produced a load of 11.3, ~1.6 each, but that is a
 * queue length, and it inflates as the machine gets worse — each of those
 * seven was mostly waiting on the other six. Calibrating on 1.6 says a 4-core
 * box carries one.
 *
 * So it is calibrated on the configuration that was *observed to be fine*.
 * A supervisor plus two worker agents sat at a load of 2.6–2.9 on four cores,
 * with the desktop responsive. Three agents against a budget of 4 cores − 1
 * held back for the human − 0.5 for herdr = 2.5 gives 0.83 each; 0.75 is that
 * rounded to a figure that divides cleanly and leaves a little slack, and it
 * reproduces exactly the fleet this machine was seen to carry. It sits well
 * above the ~0.3 cores an agent actually spends and well below its
 * thrashing-inflated share, which is the range a divisor in a load-average
 * budget has to live in. Re-measure it before trusting it.
 *
 * Since KAN-56 (in the extraction source) the daemon does re-measure it,
 * continuously, and these numbers are the seed rather than the answer: they
 * hold until the sampler has a damped live figure, and they are what
 * everything degrades to when it does not. A capacity report built from them
 * says `seed`, because a figure nobody measured on this fleet must be labelled
 * as such — that mislabelling is the exact failure story KAN-44 (likewise in
 * the extraction source) exists to correct.
 *
 * KAN-275 RAISED `residentBytes` FROM 650 MB TO 800 MB, and the reason is that
 * a DIVISOR's seed must OVER-charge. 650 was the bottom of the 654/658/679
 * range above; every tree-wide figure measured since is above it. Measured on
 * this machine on 2026-08-12, three 60s windows: a worker tree held 719, 731
 * and 733 MB, and supervising trees 761-904 MB. A seed at the bottom of a
 * range that has since moved up is a seed that admits more agents than the
 * machine carries, and it is live exactly when nothing has been measured yet —
 * which is when a fleet is being staffed.
 *
 * WHAT 800 IS AND IS NOT. It is above every chargeable-agent reading taken here
 * (733 max, so ~9% of headroom over the worst observed) and below the largest
 * tree observed at all (904). It is NOT a measurement of a CrabCast agent:
 * this daemon managed no agents when it was taken, so the trees measured were
 * another orchestrator's. That is stated rather than smoothed over, because the
 * whole of KAN-275 is that a figure measured off one population and reported as
 * another's is how this gate went wrong in the first place.
 *
 * The provenance of the 650 it replaces: measured in the extraction source on
 * 2026-07-31, tree-wide, across three live agents. The header above records the
 * machine as a 4-core laptop, which matches this machine's core count — but
 * nothing in this file or in docs/ported-lineage.md certifies it was the same
 * box, so it is not claimed.
 */
export const MEASURED_AGENT_COST: AgentCost = {
  residentBytes: 800 * MIB,
  cores: 0.75
};

/** Where a cost figure came from. Tracked per dimension, because the operator
 * may override cores while memory stays measured. */
export type CostSource = 'override' | 'measured' | 'seed';

/**
 * A damped live measurement of what one agent tree costs, with the metadata a
 * reader needs to judge it: when the window closed, how long it was, and how
 * many trees the per-tree figure was averaged over. Produced by the daemon's
 * sampler (daemon.ts) from agent-cost.ts windows, damped by
 * agent-cost-damping.ts — by design never an instantaneous reading.
 */
export interface MeasuredAgentCost extends AgentCost {
  /** Wall-clock ms (Date.now()) when the sample window closed. */
  sampledAt: number;
  /** Length of the window that closed the measurement, in seconds. */
  windowSeconds: number;
  /**
   * Agent trees the per-tree figures were averaged over.
   *
   * SINCE KAN-338 THIS IS A SUBSET AND NOT A CENSUS: only trees attributed to
   * a chargeable agent of this daemon are in it. {@link treesSeen} is the
   * population it was drawn from.
   */
  agentTrees: number;
  /**
   * Agent-runtime trees the window saw on the machine, ours or not.
   *
   * REQUIRED, NOT OPTIONAL, and that is deliberate (KAN-338). Every reader of
   * this figure is judging how representative the divisor is, and a field that
   * can be omitted would be omitted exactly where the two numbers differ — by
   * a fixture written to prove some other point, which then quietly asserts
   * that the whole machine was ours. `treesSeen === agentTrees` is a claim,
   * and the type makes somebody make it.
   */
  treesSeen: number;
}

/**
 * The herdr server's own appetite. It sat at ~49% of a core with seven agents
 * attached, and it is not an agent, so it comes off the top of the budget
 * before agents are counted.
 *
 * This is subtracted only from the *static* cap. Live headroom is computed
 * against a live measurement — observed CPU where there is one, the load
 * average otherwise — and both of those already contain herdr's real usage, so
 * subtracting it there would charge for it twice.
 */
export const HERDR_OVERHEAD_CORES = 0.5;

// ---------------------------------------------------------------------------
// KAN-263: CHARGING FOR STARTS THE CPU-SIDE INSTRUMENT CANNOT HAVE SEEN
// ---------------------------------------------------------------------------
//
// Every activation is gated correctly and the gate was blind in aggregate. The
// mechanism, the terms that are and are not affected, and the decision not to
// charge memory are all in `starts-in-flight.ts`; what is here is the
// arithmetic and the words it produces.
//
// THE ONE SENTENCE: a window average cannot contain an agent that did not exist
// for the window. So a restore sequence of ten agents three seconds apart is
// ten decisions taken against one reading of a machine that held none of them.
//
// WHAT THIS IS NOT. It is not a staleness fix and `MAX_OBSERVATION_AGE_MS` is
// not the cause: a perfectly fresh observation, taken one millisecond ago, is
// equally incapable of containing an agent that started after its window
// closed. The cause is the SAMPLE CADENCE relative to the START CADENCE, and
// the correction below is expressed against the window's own edges rather than
// against any age threshold, which is why it needs no new constant on the CPU
// branch.
//
// HOW IT WEIGHS A START, and this is where we diverge from wroosbit/butchr's
// KAN-258 (`a888fdd`), which fixed the same defect from a different diagnosis
// and is evidence rather than specification. Their `unobservedStartsAmong`
// charges a FULL agent for every start after the window's opening edge — a step
// function — and their reasoning for the edge is exactly ours: a window from t0
// to t1 contains the full cost only of an agent that existed for all of it.
//
// We keep their edge and drop their step, because their sampler closes a window
// every 5 seconds and ours closes one every 30. A step over-charges an agent
// that was present for 29 of a 30-second window by a whole agent, and it does
// so for up to a minute — on a 4-core box whose derived cap is 3, that is a
// third of the machine refused on arithmetic we know to be wrong. It also puts
// a cliff at the sample boundary: the same fleet is charged 3 agents at t=59
// and 0 at t=61, so the gate's answer jumps by a third of the machine for no
// change in the machine. At their cadence the same step costs ten seconds and
// the cliff is invisible; at ours neither is.
//
// So a start inside the window is charged the fraction of the window it was
// ABSENT for, which is one minus the fraction the average already contains. It
// is continuous at both edges — a start at the opening edge weighs 0, one at
// the closing edge weighs 1, one after the close weighs 1 — and it introduces
// no assumption the model was not already making, because "an agent costs
// `cost.cores` while it is alive" is what every other line of this file divides
// by.
//
// THE ONE THING IT UNDER-CHARGES, named because it is the dangerous direction:
// an agent's first seconds are its most expensive — a node process, an MCP
// server or two and a model connection — so a linear weight understates a start
// that is mostly inside the window. The understatement is bounded by one agent
// and it shrinks as the start ages. Against it: a start AFTER the window is
// charged in full, and that is the case the incident was made of.

/** Which instrument's blind spot a charge was measured against. */
export type ChargeBasis = 'cpu-window' | 'load1-period';

/**
 * What the starts in flight cost the CPU-side budget, with the arithmetic that
 * produced it — the same bargain every other figure here strikes.
 */
export interface StartsCharge {
  /** Starts the ledger offered for consideration. */
  considered: number;
  /** Of those, how many carried a non-zero weight. */
  charged: number;
  /** The weights summed — a fleet-equivalent, so 2.4 means "two and a bit
   *  agents' worth of work no instrument has priced". */
  agentEquivalents: number;
  /** `agentEquivalents × rateCores`, subtracted from the budget. */
  cores: number;
  /**
   * What one start was charged at — see {@link startingAgentCores}. NOT
   * necessarily `cost.cores`, and reported separately for exactly that reason:
   * a reader reproducing this figure from the `agent cost:` line on the same
   * report would otherwise get a different answer and have no way to see why.
   */
  rateCores: number;
  /** Which instrument this was measured against. */
  basis: ChargeBasis;
  /** The derivation in one sentence, for a refusal to quote. */
  because: string;
}

/**
 * The period `os.loadavg()[0]` averages over.
 *
 * A constant, and it is the one number here nobody measured — but it is not a
 * tuning knob either: it is the DEFINITION of the instrument. `load1` is the
 * one-minute load average, so one minute is how far back a start can be and
 * still be under-represented in it. Changing it would not tune the gate, it
 * would make this arithmetic describe a different quantity from the one it
 * divides.
 */
export const LOAD1_PERIOD_MS = 60_000;

/**
 * What one STARTING agent is charged, which is not what one running agent
 * costs.
 *
 * THIS IS THE HOLE THE OTHER PROJECT FOUND AND WE HAD NOT (KAN-258, and it is
 * the single most valuable thing reading their work produced). Their live
 * capacity report on this machine at the time of writing reads
 * `agentCores: 0.117 (measured)` beside `unobservedStarts.chargedCores: 0.75`
 * — they charge the seed and not the divisor, deliberately.
 *
 * The argument is short and it is right. Both cost figures in this file are
 * STEADY-STATE BY CONSTRUCTION: {@link MEASURED_AGENT_COST} is calibrated on
 * "the configuration that was observed to be fine" and the live figure is
 * damped over a 60-second window, and its own header says most of an agent's
 * life is spent waiting on an API. Neither describes the first few seconds of
 * one — a node process, an MCP server or two and a model connection, all being
 * built at once. Charging a start at the settled rate is charging the burst at
 * the price of the idle: with the measured 0.117 in force, ten simultaneous
 * starts would be charged 1.17 cores, and ten simultaneously-booting agent
 * trees are not 1.17 cores. That charge would have refused nothing, and this
 * whole term would have shipped inert.
 *
 * So the rate is the LARGER of the divisor in force and the seed — the seed
 * being the one figure here calibrated on a whole agent's share of a machine
 * rather than on its CPU samples.
 *
 * WHERE WE DIVERGE FROM THEM, and it is a small deliberate one: an explicit
 * operator override is honoured outright rather than being raised to the seed.
 * This file's precedence rule is stated as an argument and not a convenience —
 * "someone who typed a number into their environment has re-measured or
 * decided, and a fleet that argues with its operator gets turned off" — and a
 * `max` that silently overrides `CRABCAST_AGENT_CORES` is exactly that
 * argument. The measurement is what gets raised, because nobody decided it.
 */
export function startingAgentCores(cost: AgentCost, costSource: CostSource): number {
  if (costSource === 'override') return cost.cores;
  return Math.max(cost.cores, MEASURED_AGENT_COST.cores);
}

/**
 * The divisor floor (KAN-275): a MEASURED per-agent cost is raised to the seed,
 * an OVERRIDE is honoured outright.
 *
 * THIS IS NOT A NEW PHILOSOPHY, and that is the argument for it. It is
 * {@link startingAgentCores} — `max(measurement, seed)`, override exempt —
 * applied to the divisor itself rather than to what one starting agent is
 * charged. The two now say the same thing in the same direction, which is what
 * the alternative could not offer: a second rule for the same question is how
 * two figures on one report drift into disagreeing.
 *
 * WHY A FLOOR AT ALL, since a measurement is supposed to beat a seed. Because
 * this daemon could not tell whose process trees it was measuring. `agent-cost.ts`
 * enumerates every agent-runtime tree on the machine and groups by process
 * ancestry; nothing joined a tree to an agent record, so a machine running
 * another orchestrator's fleet — or this one's own supervising agents, which
 * are deliberately never charged — contributed samples to a figure that is then
 * divided into a budget for CHARGED agents. Measured here on 2026-08-12: 0.135
 * core/agent averaged over four trees, none of which this daemon managed, which
 * derived `capByCpu 18` on a four-core box. Cheap foreign trees drag the
 * divisor down, and a smaller divisor is a LARGER cap — the discount arrives as
 * a permission rather than a saving.
 *
 * ATTRIBUTION HAS LANDED (KAN-338) AND THE FLOOR STAYS. The sample is now the
 * trees this daemon owns and charges for, joined process → herdr pane → the one
 * ownership test. That removes the population the floor was bounding, and it
 * does NOT make the floor redundant, per term:
 *
 *   - `cores`. A one-tree sample is an average over one number. Attribution
 *     makes the sample correct and SMALLER, so it is more correct and less
 *     stable at the same time — one agent idling through a window is now the
 *     whole divisor rather than a quarter of it. The floor is what stands under
 *     that, and it binds precisely in the small-sample case attribution creates.
 *   - `residentBytes`. Same argument, and one more: the join is an environment
 *     variable, which anything that can `export` can forge. Forgery buys a
 *     foreign tree a place in the sample, and the floor bounds what that is
 *     worth — a forger can no longer drive the divisor below the seed however
 *     cheap their trees are.
 *
 * The empty sample is not on that list because it never reaches here: a window
 * with no attributed tree is rejected by `sampleFromMeasurement` and the report
 * says `seed`. A divisor over an empty sample would be a gate that agrees with
 * anything, and it is guarded at the sampler rather than floored here.
 *
 * WHAT ATTRIBUTION BUYS, GIVEN THAT THE FLOOR STILL FLOORS EVERY DIMENSION.
 * Only readings ABOVE the seed can move the arithmetic — so what changes is
 * that a cheap FOREIGN fleet can no longer hide an expensive fleet of OUR OWN.
 * Four idle strangers averaged in with two agents costing 1.2 cores each gave
 * 0.43, floored to 0.75; attributed, the divisor is 1.2 and the cap is smaller
 * and true. The floor could never have reached that number: it raises to the
 * seed, never to the measurement.
 *
 * WHAT IT COSTS, named because it is a real loss and not a rounding one: a
 * fleet of genuinely cheap agents can no longer earn a cap above the seed's.
 * The measurement can still make this gate MORE conservative and can no longer
 * make it less. Given that the incident this whole file exists to prevent was a
 * machine admitting more than it could carry, that is the direction to fail in
 * — but a reader should know the trade was made, so the derivation says when
 * the floor is what bound.
 */
export function flooredCost(cost: AgentCost, costSource: { residentBytes: CostSource; cores: CostSource }): AgentCost {
  return {
    residentBytes:
      costSource.residentBytes === 'override'
        ? cost.residentBytes
        : Math.max(cost.residentBytes, MEASURED_AGENT_COST.residentBytes),
    cores:
      costSource.cores === 'override'
        ? cost.cores
        : Math.max(cost.cores, MEASURED_AGENT_COST.cores)
  };
}

/**
 * What this daemon holds back for the agents it does not charge (KAN-275).
 *
 * THE DEFECT THIS CLOSES IS A NUMERATOR/DENOMINATOR MISMATCH, and it is worth
 * stating as one because the two memory terms have it in opposite directions:
 *
 *   - `headroomByMemory` divides `availableBytes` — MemAvailable, from which
 *     the kernel has ALREADY subtracted every unchargeable agent's resident
 *     memory. Its numerator nets them out. Nothing more is owed there, and
 *     subtracting a reserve as well would charge for them twice.
 *   - `capByMemory` divides `totalBytes`, a static figure that nets out
 *     nothing. The unchargeable agents are absent from its numerator and so the
 *     static ceiling describes a machine with no supervisors on it.
 *
 * So the reserve belongs to the STATIC cap and only there. It is `exempt ×
 * this figure`, and `exempt` is the count `readCapacity` already carries from
 * the registry — no new plumbing, and in particular no join from a process to
 * an agent, which is the thing this daemon cannot currently do.
 *
 * SEEDED HIGH, DELIBERATELY, and the direction is the opposite of a divisor's.
 * A reserve is SUBTRACTED from a budget, so under-reserving leaves a larger
 * budget and admits MORE agents — "conservative" means the larger number here
 * and the larger number there, which is why this constant and
 * {@link MEASURED_AGENT_COST} are both stated rather than derived from one
 * another. 950 MB is above every supervising tree measured on this machine on
 * 2026-08-12 — 761, 762, 872 and 904 MB across three 60s windows — rather than
 * at the middle of them: an over-reserve costs one agent slot, an under-reserve
 * costs a machine.
 *
 * IT WAS 900 MB WHEN THIS PARAGRAPH WAS FIRST WRITTEN, AND THE PARAGRAPH SAID
 * "above every supervising tree" WITH 904 IN ITS OWN LIST. Recorded rather than
 * quietly corrected, because it is this epic's signature defect committed
 * inside the change that is about it: a field that explains itself, making a
 * claim its own data refutes. Note which way it failed — a reserve seeded
 * beneath an observed reading under-reserves, which is the direction the rest
 * of this file exists to prevent. The fix was to raise the constant, not to
 * soften the sentence: 900 could have been defended as clearing every tree's
 * MEAN (883, 761, 762), and a claim that has to be narrowed to survive its own
 * evidence is the wrong half to keep.
 *
 * It is a seed and it is labelled one. This daemon has never had an
 * unchargeable agent of its own to measure, so the trees behind that range were
 * another orchestrator's. When a CrabCast fleet with exempt agents exists, this
 * is the constant to re-measure.
 */
export const EXEMPT_AGENT_MEMORY_BYTES = 950 * MIB;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How much of a start the CPU window can already see, as a weight in [0, 1]
 * where 1 is "this observation contains none of it".
 *
 * Continuous at both edges; see the header above for why it is a ramp rather
 * than a step, and why the edge is the window's OPENING and not its close.
 */
function unobservedWeight(startedAt: number, cpu: CpuObservation): number {
  const windowMs = cpu.windowSeconds * 1000;
  if (startedAt >= cpu.sampledAt) return 1;
  // A window with no duration cannot contain anything; it is rejected upstream
  // by MIN_WINDOW_SECONDS, and this is what keeps the division safe rather than
  // relying on that.
  if (!(windowMs > 0)) return 1;
  const openedAt = cpu.sampledAt - windowMs;
  if (startedAt <= openedAt) return 0;
  return (startedAt - openedAt) / windowMs;
}

/**
 * The charge against the observed-CPU term.
 *
 * Every figure in the sentence it returns is reproducible by hand from the
 * observation the report already prints, which is the property AC3 asks for:
 * the reader can check the charge without being handed the ledger.
 */
export function chargeAgainstCpuWindow(
  starts: readonly AgentStart[],
  cpu: CpuObservation,
  cost: AgentCost,
  costSource: CostSource
): StartsCharge {
  const rate = startingAgentCores(cost, costSource);
  const weights = starts.map((s) => unobservedWeight(s.at, cpu));
  const agentEquivalents = weights.reduce((a, b) => a + b, 0);
  const charged = weights.filter((w) => w > 0).length;
  const openedAt = new Date(cpu.sampledAt - cpu.windowSeconds * 1000).toISOString();
  const closedAt = new Date(cpu.sampledAt).toISOString();
  return {
    considered: starts.length,
    charged,
    agentEquivalents: round2(agentEquivalents),
    cores: round2(agentEquivalents * rate),
    rateCores: rate,
    basis: 'cpu-window',
    because:
      charged === 0
        ? `no agent started after the CPU window opened at ${openedAt}, so this observation ` +
          `has already priced every agent it is being asked about` +
          (starts.length ? ` (${starts.length} start(s) considered)` : '')
        : `${charged} of ${starts.length} start(s) began after the CPU window opened at ` +
          `${openedAt} (${cpu.windowSeconds.toFixed(0)}s, closed ${closedAt}), so the ` +
          `${cpu.busyCores.toFixed(2)} cores it observed cannot contain ` +
          `${round2(agentEquivalents)} agent(s) of work — weighted by the share of the window ` +
          `each was absent for, and charged ${round2(agentEquivalents)} × ${rate} ` +
          `core/agent = ${round2(agentEquivalents * rate)} cores` +
          startingRateNote(cost, costSource, rate)
  };
}

/**
 * Why the charge divides by a different figure from the one on the `agent
 * cost:` line, said only when it does.
 *
 * Without this clause the report contains two numbers that do not reconcile and
 * nothing connecting them, which is the shape of every capacity figure this
 * project has had to go back and explain.
 */
function startingRateNote(cost: AgentCost, costSource: CostSource, rate: number): string {
  if (rate === cost.cores) return '';
  return (
    ` — charged at the ${MEASURED_AGENT_COST.cores} core seed rather than the ` +
    `${cost.cores} core ${costSource} divisor, because both cost figures here describe a ` +
    `SETTLED agent and a starting one is spending the most CPU it ever will`
  );
}

/**
 * The charge against the load-average term, which fills the CPU-side slot only
 * where nothing measured this machine's CPU.
 *
 * A STEP RATHER THAN A RAMP, and the reason is the instrument: `load1` is an
 * EXPONENTIAL mean, so it weights the last few seconds far more heavily than
 * the first few of its minute. A linear ramp over that would understate a
 * recent start — the direction that took a machine down — so anything inside
 * the period is charged in full. The load average is already the conservative
 * fallback (it counts uninterruptible sleep as demand); this keeps it so.
 */
export function chargeAgainstLoad1(
  starts: readonly AgentStart[],
  cost: AgentCost,
  costSource: CostSource,
  now: number
): StartsCharge {
  const rate = startingAgentCores(cost, costSource);
  const since = now - LOAD1_PERIOD_MS;
  const charged = starts.filter((s) => s.at > since).length;
  return {
    considered: starts.length,
    charged,
    agentEquivalents: charged,
    cores: round2(charged * rate),
    rateCores: rate,
    basis: 'load1-period',
    because:
      charged === 0
        ? `no agent started in the last ${LOAD1_PERIOD_MS / 1000}s, so the 1-minute load ` +
          `average has had time to reflect the whole fleet` +
          (starts.length ? ` (${starts.length} start(s) considered)` : '')
        : `${charged} of ${starts.length} start(s) began inside the ${LOAD1_PERIOD_MS / 1000}s ` +
          `the load average means over, and it is an exponential mean that weights the newest ` +
          `work least — each is charged in full at ${rate} core/agent = ` +
          `${round2(charged * rate)} cores` +
          startingRateNote(cost, costSource, rate)
  };
}

/** What the machine looks like right now, or what we pretend it looks like. */
export interface MachineFacts {
  cores: number;
  totalBytes: number;
  /** Memory that could be handed out now: MemAvailable, not MemFree. */
  availableBytes: number;
  /**
   * 1-minute load average. Reported on every line and no longer the CPU-side
   * bound wherever `cpu` below is present — see the KAN-208 section of the
   * header for why.
   */
  load1: number;
  /**
   * Cores actually in use, over a real window, or null where nobody measured.
   *
   * Optional rather than required so a caller reasoning about hardware it does
   * not have — the portability sections of the proofs, a machine described by
   * hand — can leave it out, and absent means exactly what it says: nothing
   * observed this machine's CPU, so the load average is what bounds.
   */
  cpu?: CpuObservation | null;
  /**
   * How much of the last ten seconds this machine spent stalled on I/O or on
   * memory reclaim, from /proc/pressure (KAN-216).
   *
   * Optional for the same reason `cpu` is: a caller reasoning about hardware it
   * does not have leaves it out. Absent or unreadable is NOT 0% — each reading
   * carries its own three-way state, and the veto fires only on a figure that
   * was actually measured. See machine-pressure.ts.
   */
  stall?: StallFacts | null;
}

/**
 * Cores held back for the person using the machine.
 *
 * A whole core on a small box, because that is the complaint this exists to
 * answer: the human is *using* this desktop, and a fleet that eats it to the
 * last cycle is a fleet that gets turned off. It grows with core count so a
 * big machine is not left with a token reservation, but slowly — a 64-core
 * box does not need 16 cores held back to stay responsive.
 */
export function humanReserveCores(cores: number): number {
  return Math.max(1, Math.floor(cores / 8));
}

/**
 * Memory held back for everything that is not an agent: the browser, the
 * editor, the page cache that keeps the machine from feeling like treacle.
 * 15% of RAM, floored at 2 GB so a small machine is not left with scraps.
 */
export function humanReserveBytes(totalBytes: number): number {
  return Math.max(2 * GIB, Math.floor(totalBytes * 0.15));
}

/** Which measurement set the static cap. */
export type CapBound = 'cpu' | 'memory' | 'floor' | 'configured';

/**
 * Which measurement set the live headroom.
 *
 * `cpu` and `load` are the same slot filled two ways and never both at once:
 * `cpu` when this machine's CPU was observed, `load` when it was not and the
 * load average is standing in. Keeping them as separate names rather than one
 * `cpu-ish` verdict is what lets a refusal say which instrument refused it.
 *
 * Note that `CapBound`'s `cpu` is a different claim from this one. There it
 * means the STATIC core budget divided by the per-agent cost — arithmetic
 * about hardware, portable to a machine nobody here owns. Here it means cores
 * observed in use on this machine in the last few seconds.
 *
 * `stall` (KAN-216) is the odd one out and is meant to be: the other four are
 * counts of agents and the smallest wins, while `stall` is a veto that zeroes
 * them. It is in this union rather than off in a boolean nobody reads because
 * the question the type answers — "which thing said no" — is the same question,
 * and a caller switching on four cases and silently mishandling a fifth is the
 * failure that shape prevents.
 */
export type HeadroomBound = 'cap' | 'cpu' | 'load' | 'memory' | 'stall';

export interface Capacity {
  machine: MachineFacts;
  /**
   * The per-agent divisor actually used, AFTER the KAN-275 floor. Never below
   * {@link MEASURED_AGENT_COST} on a dimension the operator did not override.
   */
  cost: AgentCost;
  /**
   * What the override/measured/seed precedence chose BEFORE the floor was
   * applied. Equal to `cost` in the ordinary case; lower on any dimension the
   * floor raised. Reported so the arithmetic stays reproducible by hand when a
   * measurement was overruled — see {@link flooredDimensions}.
   */
  costBeforeFloor: AgentCost;
  /**
   * Which dimensions the floor raised, so a report can say the measurement was
   * not what divided. Empty in the ordinary case.
   */
  flooredDimensions: Array<keyof AgentCost>;
  /** Where each dimension of `cost` came from: override, measured, or seed. */
  costSource: { residentBytes: CostSource; cores: CostSource };
  /**
   * The damped measurement that was consulted, if the sampler had one. Kept
   * even when an override beat it, so a report can say what was ignored.
   */
  measured: MeasuredAgentCost | null;
  reservedForHuman: { cores: number; bytes: number };
  /**
   * Memory held back on the STATIC cap for agents this daemon does not charge
   * (KAN-275): `exemptAgents × EXEMPT_AGENT_MEMORY_BYTES`, zero when there are
   * none.
   *
   * It is subtracted from `capByMemory`'s budget and deliberately NOT from
   * `headroomByMemory`'s, because that term divides `availableBytes` and the
   * kernel has already taken this memory out of it. Two terms, two bases, one
   * reserve — see EXEMPT_AGENT_MEMORY_BYTES for why applying it to both would
   * be a double charge.
   */
  exemptReserveBytes: number;

  /** Concurrent *charged* agents this hardware supports, load aside. */
  cap: number;
  capByCpu: number;
  capByMemory: number;
  capBoundBy: CapBound;
  /** Set when CRABCAST_MAX_AGENTS overrode the derivation. */
  configuredCap: number | null;

  /** Chargeable agents alive right now. Unchargeable ones are not among them. */
  running: number;
  /**
   * Agents configured `chargeable: false`, alive right now. Reported, never
   * charged: a caller asks for that flag because the agent supervises rather
   * than does the work, and spends most of its life idle. See the header.
   */
  exemptAgents: number;

  /** How many more can be started right now. Never negative. */
  headroom: number;
  headroomByCap: number;
  /**
   * The CPU term, from cores observed in use. Null — and only then does
   * `headroomByLoad` bind — when nothing measured this machine's CPU.
   */
  headroomByCpu: number | null;
  /**
   * The load-average term. Always computed, because it costs nothing and a
   * reader comparing it against `headroomByCpu` is reading the whole point of
   * KAN-208. It BINDS only when `headroomByCpu` is null.
   */
  headroomByLoad: number;
  headroomByMemory: number;
  headroomBoundBy: HeadroomBound;
  /** The observation the CPU term came from, or null. Kept so a report can
   *  date the figure it divided by. */
  cpu: CpuObservation | null;

  /**
   * What agents started too recently to be in the CPU-side reading cost that
   * reading's budget (KAN-263).
   *
   * ALWAYS THE CHARGE THAT BOUND — against the CPU window where one was
   * observed, against the load average's minute where the load term stood in —
   * so a reader never has to work out which instrument this belongs to. Both
   * are computed; `startsChargeByLoad` carries the other one for the same
   * reason `headroomByLoad` is computed when it does not bind.
   *
   * `charged: 0` is the ordinary state of a settled fleet and is NOT the same
   * as "nobody looked": `considered` says how many starts were on the ledger,
   * and `because` says in words why they cost nothing.
   */
  startsCharge: StartsCharge;
  /** The load-average charge, computed always so it can be printed beside the
   *  CPU one. It BINDS only when `headroomByCpu` is null. */
  startsChargeByLoad: StartsCharge;

  /**
   * What the three counting terms agreed on BEFORE the stall veto (KAN-216).
   * Equal to `headroom` in the ordinary case; when `stalled` is true it is the
   * room the machine would otherwise have had. Printing it is what makes the
   * veto's effect visible instead of looking like a machine that was full.
   */
  headroomBeforeStall: number;
  /**
   * The worse of the two `/proc/pressure` `full avg10` figures — the share of
   * the last ten seconds in which every non-idle task was stalled. Null when
   * NEITHER file yielded a figure, which is the one case where nothing bounds
   * I/O saturation at all. Null is "nobody looked", never "the machine is
   * quiet"; `stallInstrument` says which kind of nobody-looked it was.
   */
  stallPercent: number | null;
  /** Which pressure file `stallPercent` came from. Null when it is null. */
  stallSource: StallSource | null;
  /** Both readings as taken, each with its own state, so a report can show the
   *  one that did not bind and name a file it could not read. */
  stall: StallFacts | null;
  /** Whether this machine can answer the stall question at all: `measured`,
   *  `absent` (no PSI here), or `unreadable` (PSI present, would not answer). */
  stallInstrument: 'measured' | 'absent' | 'unreadable';
  /** The threshold `stallPercent` was compared against. A constant — there is
   *  deliberately no override; see the KAN-216 header section. */
  stallRefusePercent: number;
  /**
   * True when the veto fired: the machine is stalled and no agent is admitted
   * however much CPU and memory are free. ALWAYS FALSE where PSI gave no
   * figure — an instrument that did not look refuses nothing.
   */
  stalled: boolean;

  /** True when starting another agent would exceed what the machine can carry. */
  atCapacity: boolean;
}

export interface CapacityOptions {
  /**
   * Operator-set costs (CRABCAST_AGENT_CORES / CRABCAST_AGENT_MEMORY_MB). A
   * dimension set here beats the measurement outright — see the header for
   * the precedence argument.
   */
  overrides?: Partial<AgentCost>;
  /** The damped live measurement, if there is one. Beats the seed, loses to
   * overrides. */
  measured?: MeasuredAgentCost | null;
  /** A cap the operator set by hand, bypassing the derivation entirely. */
  configuredCap?: number | null;
  /** Gate-exempt agents observed running. Reported only; it changes no
   * arithmetic. */
  exemptRunning?: number;
  /**
   * When each live agent was started (KAN-263), so the CPU-side term can charge
   * for the ones its reading cannot contain. `readCapacity` fills this from the
   * process-wide ledger; a caller reasoning about hardware it does not own —
   * the portability sections of the proofs — leaves it out, and absent means
   * exactly what an empty ledger means: nothing is mid-start.
   */
  startedAt?: readonly AgentStart[];
  /**
   * The instant to reckon the load-average charge against. Defaults to now;
   * pinned by proofs so a charge can be asserted without racing the clock.
   */
  now?: number;
}

/**
 * The whole model, as a pure function of measured figures.
 *
 * Pure so the same arithmetic can be run against hardware nobody here owns —
 * which is the property being bought, and which
 * `scripts/verify-agent-capacity.mjs` exercises.
 */
export function computeCapacity(
  machine: MachineFacts,
  running: number,
  options: CapacityOptions = {}
): Capacity {
  // The divisor, one dimension at a time: override, else measured, else seed.
  // Per dimension rather than all-or-nothing so an operator who has re-measured
  // cores does not silently discard the memory measurement too.
  const overrides = options.overrides ?? {};
  const measured = options.measured ?? null;
  const pick = (dim: keyof AgentCost): { value: number; source: CostSource } => {
    const override = overrides[dim];
    if (override !== undefined) return { value: override, source: 'override' };
    if (measured) return { value: measured[dim], source: 'measured' };
    return { value: MEASURED_AGENT_COST[dim], source: 'seed' };
  };
  const resident = pick('residentBytes');
  const coreCost = pick('cores');
  const costSource = { residentBytes: resident.source, cores: coreCost.source };
  // What the precedence rule alone chose, kept so the report can say what the
  // floor below changed and by how much. A correction whose effect is invisible
  // is one a reader assumes is not happening — the same argument `startsLine`
  // and `stallLine` are printed-when-inert for.
  const costBeforeFloor: AgentCost = { residentBytes: resident.value, cores: coreCost.value };
  // KAN-275: a measured divisor is raised to the seed; an override is honoured
  // outright. See flooredCost for why the population behind the measurement is
  // not known to be this daemon's, and what that costs.
  const cost = flooredCost(costBeforeFloor, costSource);
  const flooredDimensions: Array<keyof AgentCost> = [];
  if (cost.residentBytes > costBeforeFloor.residentBytes) flooredDimensions.push('residentBytes');
  if (cost.cores > costBeforeFloor.cores) flooredDimensions.push('cores');
  const configuredCap = options.configuredCap ?? null;

  const reservedCores = humanReserveCores(machine.cores);
  const reservedBytes = humanReserveBytes(machine.totalBytes);

  // Static cap: what the hardware supports with nothing else assumed. herdr's
  // share comes off here because the load average cannot be consulted for a
  // machine that is not this one. Nothing is held back for uncharged agents
  // — see the header: only charged agents are charged.
  const cpuBudget = machine.cores - reservedCores - HERDR_OVERHEAD_CORES;
  const capByCpu = Math.floor(Math.max(0, cpuBudget) / cost.cores);
  // KAN-275: the STATIC ceiling nets out the agents it does not charge, because
  // its numerator is `totalBytes` and nets out nothing by itself. This is the
  // one term the reserve belongs to — `headroomByMemory` below divides
  // `availableBytes`, from which the kernel has already taken these agents, and
  // subtracting there as well would charge for them twice. See
  // EXEMPT_AGENT_MEMORY_BYTES.
  const exemptRunning = options.exemptRunning ?? 0;
  const exemptReserveBytes = exemptRunning * EXEMPT_AGENT_MEMORY_BYTES;
  const capByMemory = Math.floor(
    Math.max(0, machine.totalBytes - reservedBytes - exemptReserveBytes) / cost.residentBytes
  );

  let cap: number;
  let capBoundBy: CapBound;
  if (configuredCap !== null) {
    cap = configuredCap;
    capBoundBy = 'configured';
  } else {
    cap = Math.min(capByCpu, capByMemory);
    capBoundBy = capByCpu <= capByMemory ? 'cpu' : 'memory';
    if (cap < 1) {
      // A machine too small to carry one agent by this arithmetic can still
      // run one, badly, and refusing everything would make CrabCast useless
      // rather than careful. This floor is a decision, not a measurement, and
      // it says so in capBoundBy.
      cap = 1;
      capBoundBy = 'floor';
    }
  }

  // Live headroom: three independent answers to "how many more right now",
  // and the smallest wins. They disagree on purpose — count knows nothing
  // about effort, CPU knows nothing about memory, and memory knows nothing
  // about either.
  const headroomByCap = Math.max(0, cap - running);

  // The CPU-side term. Whichever of the two fills it already includes every
  // agent, charged or exempt, herdr, and whatever the human is running, so
  // this is the one term that distinguishes three idle agents from three that
  // are compiling. It is also where running uncharged agents are felt at all:
  // never charged in the model, their real (usually small) usage is in the
  // measurement, and in availableBytes below — a running exempt agent's memory
  // is memory the kernel has already stopped offering.
  //
  // Both forms lag, and neither is asked not to: an average over a window
  // cannot see two agents started seconds apart. That is exactly the gap the
  // count term covers, which is why both are computed and the smaller wins
  // rather than one replacing the other.
  //
  // AND BOTH FORMS ARE NOW CHARGED FOR WHAT THEY CANNOT HAVE SEEN (KAN-263).
  // The paragraph above was right that neither is asked not to lag, and wrong
  // that the count term covers it: the count term covers the case where the
  // machine is bound by how many agents there are, and says nothing at all
  // about a machine bound by how busy they make it. On a CPU-bound machine —
  // which the one this was written on is, repeatedly — the term that binds is
  // the blind one, and ten restores three seconds apart were ten decisions
  // taken against one reading of a machine that contained none of them.
  const starts = options.startedAt ?? [];
  const now = options.now ?? Date.now();
  const cpu = machine.cpu ?? null;
  const startsChargeByLoad = chargeAgainstLoad1(starts, cost, costSource.cores, now);
  const startsChargeByCpu =
    cpu === null ? null : chargeAgainstCpuWindow(starts, cpu, cost, costSource.cores);
  const headroomByCpu =
    cpu === null || startsChargeByCpu === null
      ? null
      : Math.max(
          0,
          Math.floor(
            (machine.cores - reservedCores - cpu.busyCores - startsChargeByCpu.cores) / cost.cores
          )
        );

  // Computed unconditionally so every report can print it beside the CPU term
  // — the divergence between the two IS the KAN-208 finding, and a figure you
  // have to recompute by hand to see it is a figure nobody sees. It binds only
  // where headroomByCpu is null.
  //
  // It carries its OWN charge rather than the CPU one, because the two are
  // measured against different periods and printing a term beside an
  // adjustment that was not applied to it is how a reader checks the
  // arithmetic and finds it does not add up.
  const loadBudget = machine.cores - reservedCores - machine.load1 - startsChargeByLoad.cores;
  const headroomByLoad = Math.max(0, Math.floor(loadBudget / cost.cores));

  const headroomByMemory = Math.max(
    0,
    Math.floor(Math.max(0, machine.availableBytes - reservedBytes) / cost.residentBytes)
  );

  // The one slot, filled by the measurement where there is one and by the
  // proxy where there is not. See the KAN-208 section of the header for why
  // this is not `Math.min(headroomByCpu, headroomByLoad)`.
  const cpuSideTerm = headroomByCpu ?? headroomByLoad;
  const cpuSideName: HeadroomBound = headroomByCpu === null ? 'load' : 'cpu';

  const headroomBeforeStall = Math.min(headroomByCap, cpuSideTerm, headroomByMemory);
  // Ties resolve to the term the reader can most directly act on: closing an
  // agent is a decision, waiting for the machine to go quiet is not.
  const countingBoundBy: HeadroomBound =
    headroomByCap <= cpuSideTerm && headroomByCap <= headroomByMemory
      ? 'cap'
      : cpuSideTerm <= headroomByMemory
        ? cpuSideName
        : 'memory';

  // The stall veto (KAN-216). Not a fourth count — a stalled machine has no
  // room at all, whatever the terms above computed, and there is no per-agent
  // I/O cost to divide by that would make it one. See the header.
  //
  // `worst` is null exactly when NEITHER pressure file yielded a figure, and a
  // missing instrument must refuse nothing: `stalled` is false, the derivation
  // says the term is inert and which kind of absence it was, and I/O saturation
  // is bounded by nothing on that machine. That is a named hole, not a silent
  // one — and note that it is `worst === null` that is checked here, never a
  // percentage, because there is no percentage to read on that branch.
  const stall = machine.stall ?? null;
  const worst = worstStall(stall);
  const stalled = worst !== null && worst.percent >= STALL_REFUSE_PERCENT;
  const headroom = stalled ? 0 : headroomBeforeStall;
  // `stall` names itself only when it is the reason there is no room. If the
  // board was already full the count still binds, by the same tie rule as
  // above: the reader can close an agent, and cannot hurry a disk.
  const headroomBoundBy: HeadroomBound =
    stalled && headroomBeforeStall > 0 ? 'stall' : countingBoundBy;

  return {
    machine,
    cost,
    costBeforeFloor,
    flooredDimensions,
    costSource,
    measured,
    reservedForHuman: { cores: reservedCores, bytes: reservedBytes },
    exemptReserveBytes,
    cap,
    capByCpu,
    capByMemory,
    capBoundBy,
    configuredCap,
    running,
    exemptAgents: exemptRunning,
    headroom,
    headroomByCap,
    headroomByCpu,
    headroomByLoad,
    headroomByMemory,
    headroomBoundBy,
    cpu,
    startsCharge: startsChargeByCpu ?? startsChargeByLoad,
    startsChargeByLoad,
    headroomBeforeStall,
    stallPercent: worst ? worst.percent : null,
    stallSource: worst ? worst.source : null,
    stall,
    stallInstrument: stallInstrument(stall),
    stallRefusePercent: STALL_REFUSE_PERCENT,
    stalled,
    atCapacity: headroom <= 0
  };
}

/**
 * Memory the kernel believes it could hand out, which is not MemFree: most of
 * a healthy machine's "free" memory is page cache it will surrender on
 * demand. On a 15 GB machine the two can differ by 8 GB, which is the
 * difference between "no room for an agent" and "room for sixteen".
 *
 * Falls back to os.freemem() where /proc/meminfo is not readable, which
 * understates availability — the conservative direction.
 */
export function readAvailableBytes(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const line = meminfo.split('\n').find((l) => l.startsWith('MemAvailable:'));
    const kb = Number(line?.trim().split(/\s+/)[1]);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  } catch {
    // not Linux, or /proc is not mounted
  }
  return os.freemem();
}

/** What this machine actually is. Never throws. */
export function readMachineFacts(): MachineFacts {
  // os.cpus() returns [] in some containers; a machine with no CPUs is not a
  // thing, so a wrong-but-usable 1 beats a division by zero.
  const cores = os.cpus().length || 1;
  return {
    cores,
    totalBytes: os.totalmem(),
    availableBytes: readAvailableBytes(),
    // os.loadavg() is [0,0,0] on Windows. That reads as a perfectly idle
    // machine, which makes the load term inert rather than wrong — the count
    // and memory terms still bind. Since KAN-208 it is also only the FALLBACK
    // CPU-side term, so on Windows it is inert standing in for an instrument
    // that is also absent, and the count and memory terms are the whole gate.
    load1: os.loadavg()[0],
    // Whatever the sampler last published, if it is still current. Freshness
    // is checked here rather than trusted, so a sampler that stopped without
    // saying so degrades to the load average instead of pinning the gate open
    // on a stale reading. Null on every non-Linux machine and for the first
    // window after the daemon starts.
    cpu: freshObservedCpu(),
    // Unlike the CPU window this needs no sampler, no baseline and no staleness
    // check: PSI is already an average the kernel maintains over the last ten
    // seconds, so the first call answers as well as the thousandth. Each field
    // carries its own three-way state, so nothing here can produce a 0.00% that
    // nobody measured.
    stall: readStallFacts()
  };
}

function envNumber(name: string, allowZero = false): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    console.warn(
      `${name}=${raw} is not a ${allowZero ? 'non-negative' : 'positive'} number; ignoring it`
    );
    return undefined;
  }
  return value;
}

/**
 * Operator overrides, because someone who has re-measured their own hardware
 * should not have to argue with figures taken on a laptop in July 2026.
 *
 *   CRABCAST_MAX_AGENTS        — set the cap outright, skipping the derivation
 *   CRABCAST_AGENT_MEMORY_MB   — resident cost of one agent
 *   CRABCAST_AGENT_CORES       — load-average cost of one active agent
 *
 * CRABCAST_MAX_AGENTS accepts zero: "run no charged agents" is a legitimate
 * operator decision (and the synthetic-capacity lever the acceptance proofs
 * use), where a zero agent *cost* could only be a typo.
 */
export function optionsFromEnv(): CapacityOptions {
  const memoryMb = envNumber('CRABCAST_AGENT_MEMORY_MB');
  const cores = envNumber('CRABCAST_AGENT_CORES');
  // Only the dimensions actually set become overrides: an unset variable must
  // leave room for the measurement, not silently pin the seed.
  const overrides: Partial<AgentCost> = {};
  if (memoryMb !== undefined) overrides.residentBytes = memoryMb * MIB;
  if (cores !== undefined) overrides.cores = cores;
  return {
    overrides,
    configuredCap: envNumber('CRABCAST_MAX_AGENTS', true) ?? null
  };
}

/**
 * The damped live measurement, held here so every caller of readCapacity —
 * each per-connection router and the daemon's own — divides by the same
 * figure. The daemon's sampler (daemon.ts) is the only writer: it sets a
 * fresh value after each valid window and clears back to null the moment the
 * instrument fails, which is what makes "whatever breaks, capacity still
 * answers from the seed" true without any caller having to know.
 */
let liveMeasuredCost: MeasuredAgentCost | null = null;

export function setMeasuredAgentCost(measured: MeasuredAgentCost | null): void {
  liveMeasuredCost = measured;
}

export function getMeasuredAgentCost(): MeasuredAgentCost | null {
  return liveMeasuredCost;
}

/**
 * Capacity of this machine, with `running` charged agents already on it.
 *
 * `exempt` is how many uncharged agents were found running. It is passed so
 * the report can say so, not so the arithmetic can charge for them — they are
 * never charged at all.
 */
export function readCapacity(running: number, exempt = 0): Capacity {
  return computeCapacity(readMachineFacts(), running, {
    ...optionsFromEnv(),
    measured: liveMeasuredCost,
    exemptRunning: exempt,
    // The process-wide ledger, read here for the same reason `liveMeasuredCost`
    // and `freshObservedCpu()` are read here: every capacity answer in this
    // daemon must charge the same starts, and a caller that assembled its own
    // list would be a second opinion about how much of the fleet is new.
    startedAt: startsInFlight()
  });
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * The stall term in one line, in every state it has.
 *
 * Three sentences rather than a number and a blank, because the states are
 * genuinely different and the reader's next action differs by which one it is:
 * a figure is something to check, `absent` is a property of the kernel to
 * accept, and `unreadable` is something on this machine to go and look at. None
 * of them is 0.00% — see machine-pressure.ts for why that is the whole point.
 */
export function stallLine(c: Capacity): string {
  const window = '/proc/pressure `full avg10`, the share of the last 10s in ' +
    'which every non-idle task was stalled';
  if (c.stallInstrument === 'absent') {
    return (
      'io/memory stall: no /proc/pressure on this machine (needs Linux 4.20+ with ' +
      'CONFIG_PSI), so this term is INERT and nothing here bounds a machine thrashing ' +
      'on swap or stalled on a failing disk. The cpu term counts iowait as idle by ' +
      'design, and there is deliberately no fallback instrument — see machine-pressure.ts'
    );
  }
  if (c.stallInstrument === 'unreadable') {
    return (
      'io/memory stall: /proc/pressure EXISTS AND COULD NOT BE READ, so this term is ' +
      'INERT and I/O saturation is bounded by nothing right now. This is not an ' +
      'all-clear and it is not the same as having no PSI — something is wrong with ' +
      `this machine's instrument. ` +
      `${describePressureReading('io', c.stall!.io)}; ` +
      `${describePressureReading('memory', c.stall!.memory)}`
    );
  }
  const both =
    `${describePressureReading('io', c.stall!.io)}, ` +
    `${describePressureReading('memory', c.stall!.memory)}`;
  const worst =
    `worst is ${c.stallPercent!.toFixed(2)}% on ${c.stallSource}, ` +
    `against a ${c.stallRefusePercent}% threshold`;
  return (
    `io/memory stall: ${both} (${window}); ${worst} — ` +
    (c.stalled
      ? 'AT OR OVER, so no agent is admitted whatever the terms below say'
      : 'under, so this term does not bind')
  );
}

/**
 * The starts-in-flight charge in one line, printed whether or not it bound
 * (KAN-263).
 *
 * PRINTED WHEN INERT, for the reason `stallLine` is: a correction that is
 * silent while it is doing nothing is a correction a reader assumes is
 * protecting them, and this one is exactly the sort that can quietly stop —
 * the ledger stops being written to, every charge goes to zero, every
 * assertion about the arithmetic stays green, and the gate is back to
 * admitting ten agents on one reading. `considered: 0` on a machine that has
 * just started five agents is a visible contradiction; a blank line is not.
 */
export function startsLine(c: Capacity): string {
  const which =
    c.startsCharge.basis === 'cpu-window'
      ? 'against the CPU window'
      : 'against the load average\'s minute (nothing measured CPU here)';
  return `starts in flight: ${c.startsCharge.cores} core(s) charged ${which} — ${c.startsCharge.because}`;
}

/**
 * The derivation in words, with the numbers that produced it.
 *
 * This is the whole point: an agent refused for capacity has to say why, in
 * figures the reader can check, the way KAN-24 (in the extraction source) made
 * a refused spawn name its cause instead of failing obscurely.
 */
export function describeCapacity(c: Capacity): string {
  const m = c.machine;
  const lines: string[] = [];

  lines.push(
    `machine: ${m.cores} cores, ${gib(m.totalBytes)} RAM ` +
    `(${gib(m.availableBytes)} available), load average ${m.load1.toFixed(2)}`
  );
  // The KAN-208 line. It says which of the two CPU-side instruments answered,
  // and it says it in both directions — because "CPU is quiet" and "nobody
  // measured CPU" are different facts and the old report could express
  // neither.
  lines.push(
    c.cpu
      ? `cpu in use: ${c.cpu.busyCores.toFixed(2)} of ${m.cores} cores, ` +
        `measured over ${c.cpu.windowSeconds.toFixed(0)}s ending ` +
        `${new Date(c.cpu.sampledAt).toISOString()} — this is the CPU-side bound; ` +
        `the load average above is reported and does not gate`
      : 'cpu in use: not measured here, so the load average above is the ' +
        'CPU-side bound (fallback) — it counts uninterruptible sleep as well ' +
        'as running work, so it can refuse a machine with idle cores'
  );
  lines.push(startsLine(c));
  // Every cost figure carries its provenance, because the divisor can now be
  // a measurement: a reader must be able to tell a number this fleet produced
  // from the 2026-07-31 seed and from a number the operator typed in.
  // A dimension the floor raised still has `costSource` 'measured' — the
  // measurement is what the precedence rule picked — but the number dividing is
  // the seed's. Saying only "measured" there would be the KAN-44 mislabelling
  // exactly: a figure nobody measured on this fleet, presented as one that was.
  const flooredNote = (dim: keyof AgentCost) =>
    c.flooredDimensions.includes(dim) ? `${c.costSource[dim]}, raised to the seed floor` : c.costSource[dim];
  lines.push(
    `agent cost: ${Math.round(c.cost.residentBytes / MIB)} MB resident (${flooredNote('residentBytes')}), ` +
    `${c.cost.cores} core while active (${flooredNote('cores')})`
  );
  if (c.flooredDimensions.length) {
    lines.push(
      `  floored (KAN-275): ` +
      c.flooredDimensions
        .map((dim) =>
          dim === 'cores'
            ? `${c.costBeforeFloor.cores} core would have divided, seed floor ${MEASURED_AGENT_COST.cores}`
            : `${Math.round(c.costBeforeFloor.residentBytes / MIB)} MB would have divided, ` +
              `seed floor ${Math.round(MEASURED_AGENT_COST.residentBytes / MIB)} MB`
        )
        .join('; ') +
      ` — a measured divisor is raised to the seed. The sample IS this daemon's now ` +
      `(KAN-338), and the floor survives that: it is what stands under a one-tree ` +
      `average and under a join a process could lie about. The measurement can still ` +
      `charge MORE than the seed; it can no longer charge less`
    );
  }
  if (c.measured) {
    const beaten: string[] = [];
    if (c.costSource.residentBytes === 'override') {
      beaten.push(`CRABCAST_AGENT_MEMORY_MB overrides its ${Math.round(c.measured.residentBytes / MIB)} MB`);
    }
    if (c.costSource.cores === 'override') {
      beaten.push(`CRABCAST_AGENT_CORES overrides its ${c.measured.cores} core`);
    }
    // KAN-275 put a warning here: the tree count was NOT a count of this
    // daemon's agents, and sat one line above `running: N charged agent(s)` as
    // though it were — `4 tree(s)` and `running: 0` printed together for a day
    // without the contradiction being read as one.
    //
    // KAN-338 makes the two counts comparable rather than the warning louder,
    // and BOTH are printed for that reason. `N of M` is the whole claim: N is
    // what divided, M is what was on the machine, and a reader who wants to
    // know how representative the divisor is needs the pair. N should now
    // track `running` — where it does not, one of the two is wrong, which is a
    // thing this line can finally be used to notice.
    lines.push(
      `  measured (damped): ${Math.round(c.measured.residentBytes / MIB)} MB, ` +
      `${c.measured.cores} core per agent tree — averaged over ${c.measured.agentTrees} of ` +
      `${c.measured.treesSeen} agent-runtime tree(s) on this machine, the ones joined by ` +
      `herdr pane to a chargeable agent of this daemon (KAN-338), against its ` +
      `${c.running} charged / ${c.exemptAgents} exempt agent(s); ` +
      `over a ${Math.round(c.measured.windowSeconds)}s window ` +
      `ending ${new Date(c.measured.sampledAt).toISOString()}` +
      (beaten.length ? `; ignored: ${beaten.join(', ')}` : '')
    );
  } else if (c.costSource.residentBytes === 'seed' || c.costSource.cores === 'seed') {
    lines.push(
      '  no live measurement; seed figures are constants re-derived on 2026-08-12, ' +
      'not a measurement of this fleet'
    );
  }
  // The stall term gets its own line whether or not it fired, and says so when
  // it CANNOT fire at all. A gate that is silent while inert is a gate a reader
  // assumes is protecting them — which is precisely how the protection KAN-216
  // exists to restore went missing without a line anywhere saying it had.
  lines.push(stallLine(c));
  lines.push(
    `reserved for you: ${c.reservedForHuman.cores} core(s), ${gib(c.reservedForHuman.bytes)}`
  );

  if (c.capBoundBy === 'configured') {
    lines.push(`cap: ${c.cap} charged agents (set by CRABCAST_MAX_AGENTS, derivation skipped)`);
  } else {
    lines.push(
      `cap: ${c.cap} charged agents — ` +
      `CPU allows ${c.capByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${HERDR_OVERHEAD_CORES} for herdr) ÷ ${c.cost.cores} core/agent), ` +
      `memory allows ${c.capByMemory} ((${gib(m.totalBytes)} − ${gib(c.reservedForHuman.bytes)}` +
      // Printed only when it is non-zero: an unconditional "− 0.0 GiB for 0
      // exempt agent(s)" is noise on the ordinary report, and unlike the stall
      // and starts terms this one cannot silently stop doing its job — it is
      // arithmetic on a count the same report prints two lines down.
      (c.exemptReserveBytes > 0
        ? ` − ${gib(c.exemptReserveBytes)} for ${c.exemptAgents} uncharged agent(s)`
        : '') +
      `) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB/agent)` +
      (c.capBoundBy === 'floor'
        ? '; both said 0, floored to 1 because a machine that can run nothing is not a useful answer'
        : `; bound by ${c.capBoundBy}`)
    );
  }

  lines.push(
    `running: ${c.running} charged agent(s)` +
    (c.exemptAgents > 0
      ? `, plus ${c.exemptAgents} uncharged agent(s) — not counted against the cap, but ` +
        `${gib(c.exemptReserveBytes)} is now held off the static memory ceiling for them ` +
        `(KAN-275); the live memory term needs no such reserve because MemAvailable has ` +
        `already had their memory taken out of it`
      : '')
  );
  // Every term prints its own arithmetic, including the one that did not bind
  // — a refusal a reader cannot check against the terms it beat is a refusal
  // they have to take on trust. The load term keeps its arithmetic for the
  // same reason it is still computed: seeing `load allows 0` next to `cpu
  // allows 3` is how KAN-208 was found in the first place.
  //
  // EACH CPU-SIDE TERM PRINTS ITS OWN STARTS CHARGE (KAN-263), inside its own
  // parentheses rather than as a footnote. A term whose adjustment is described
  // somewhere else on the page is a term the reader cannot check by adding up
  // the numbers in front of them — and checking it by hand is the entire
  // contract this function exists to keep.
  const loadCharge = c.startsChargeByLoad.cores;
  const loadTerm =
    `load ${c.cpu ? 'would allow' : 'allows'} ${c.headroomByLoad} ` +
    `((${m.cores} cores − ${c.reservedForHuman.cores} reserved − ${m.load1.toFixed(2)} load` +
    (loadCharge > 0 ? ` − ${loadCharge} starting` : '') +
    `) ÷ ${c.cost.cores}${c.cpu ? '; reported, does not bind' : '; fallback, nothing measured CPU'})`;
  const cpuCharge = c.cpu ? c.startsCharge.cores : 0;
  const cpuTerm = c.cpu
    ? `cpu allows ${c.headroomByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${c.cpu.busyCores.toFixed(2)} in use` +
      (cpuCharge > 0 ? ` − ${cpuCharge} starting` : '') +
      `) ÷ ${c.cost.cores}), `
    : '';
  lines.push(
    `headroom: ${c.headroom} more — ` +
    `count allows ${c.headroomByCap} (${c.cap} cap − ${c.running} running), ` +
    cpuTerm +
    `${loadTerm}, ` +
    `memory allows ${c.headroomByMemory} ((${gib(m.availableBytes)} available ` +
    `− ${gib(c.reservedForHuman.bytes)} reserved) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB); ` +
    // The veto's effect, spelled out. Without this clause a vetoed report reads
    // as a machine that was simply full, and the reader cannot tell that three
    // terms said yes and a fourth thing overrode them.
    (c.stalled
      ? `those three terms allowed ${c.headroomBeforeStall}, ` +
        `zeroed by the stall veto (${c.stallPercent!.toFixed(2)}% ` +
        `${c.stallSource} ≥ ${c.stallRefusePercent}%); `
      : '') +
    `bound by ${c.headroomBoundBy}`
  );

  return lines.join('\n');
}

/**
 * One line for callers that only have room for one.
 *
 * When there is no room, it leads with the binding constraint rather than with
 * the count (KAN-60, in the extraction source): opening "2/10 agents" on a
 * load-bound refusal read as "at capacity" by count, which the line's own
 * figures contradicted.
 */
export function summarizeCapacity(c: Capacity): string {
  // The CPU figure leads where there is one and the load average follows it,
  // because on the machine that commissioned KAN-208 those two read 1.40 and
  // 5.70 at the same instant and only one of them was about capacity. Where
  // there is no measurement the load average is what bound, and it is the only
  // one shown — printing a figure that is not there would be worse than terse.
  const cpuFigures = c.cpu
    ? `${c.cpu.busyCores.toFixed(2)} of ${c.machine.cores} cores in use, ` +
      `load ${c.machine.load1.toFixed(2)}`
    : `${c.machine.cores} cores, load ${c.machine.load1.toFixed(2)}`;
  const figures =
    `${c.running}/${c.cap} charged agents, room for ${c.headroom} more ` +
    `(${cpuFigures}, ` +
    `${gib(c.machine.availableBytes)} available; bound by ${c.headroomBoundBy})`;
  if (!c.atCapacity) return figures;
  // Count-bound, the figures already open with N-of-cap; repeating the whole
  // reason would bury a one-line summary under its own headline.
  return c.headroomBoundBy === 'cap'
    ? `at capacity: ${figures}`
    : `${capacityHeadline(c)}; ${figures}`;
}

/**
 * The one sentence that says why there is no room, without the arithmetic
 * behind it.
 *
 * Separate from {@link capacityRefusal} because a fleet UI has a line, not a
 * page: it shows this and puts the full derivation behind a disclosure, while
 * an MCP caller and the log get the whole thing. Both are built from the same
 * numbers, so they cannot drift into disagreeing.
 */
export function capacityReason(c: Capacity): string {
  const forAgents = (c.machine.cores - c.reservedForHuman.cores).toFixed(1);
  // First, because it is a veto rather than a term: when it fired it is the
  // reason, and the figures it quotes are the ones a reader can reproduce by
  // hand out of /proc/pressure.
  if (c.headroomBoundBy === 'stall' && c.stallPercent !== null) {
    return (
      `this machine spent ${c.stallPercent.toFixed(2)}% of the last 10 seconds with every ` +
      `non-idle task stalled on ${c.stallSource === 'io' ? 'I/O' : 'memory reclaim'} ` +
      `(/proc/pressure/${c.stallSource}, \`full avg10\`), at or above the ` +
      `${c.stallRefusePercent}% at which no agent is admitted — the other terms had room ` +
      `for ${c.headroomBeforeStall}`
    );
  }
  if (c.headroomBoundBy === 'cpu' && c.cpu) {
    return (
      `${c.cpu.busyCores.toFixed(2)} cores are in use, against the ` +
      `${forAgents} cores this machine leaves to agents ` +
      `(measured over ${c.cpu.windowSeconds.toFixed(0)}s)` +
      // AC3 (KAN-263): where starts in flight were part of what refused, the
      // refusal says so and says how much. Silence here would leave the reader
      // subtracting the printed `busyCores` from the printed budget, getting a
      // different answer from the one they were given, and concluding the gate
      // is broken — the charge is not a detail, it is a term of the sum.
      (c.startsCharge.cores > 0
        ? `, plus ${c.startsCharge.cores} cores charged for ${c.startsCharge.charged} agent(s) ` +
          `that started too recently for that measurement to contain them`
        : '')
    );
  }
  if (c.headroomBoundBy === 'load') {
    // Reached only where nothing measured CPU. Saying so is the difference
    // between "the machine is busy" and "the only instrument left is one that
    // cannot tell busy from blocked" — and after KAN-208 a reader who sees
    // this sentence should know which they are being told.
    return (
      `nothing here measured CPU, so the load average stands in: it is ` +
      `${c.machine.load1.toFixed(2)}, against the ${forAgents} cores this machine ` +
      `leaves to agents` +
      (c.startsCharge.cores > 0
        ? `, plus ${c.startsCharge.cores} cores charged for ${c.startsCharge.charged} agent(s) ` +
          `that started inside the minute it averages over`
        : '')
    );
  }
  if (c.headroomBoundBy === 'memory') {
    return (
      `only ${gib(c.machine.availableBytes)} of memory is available, and ` +
      `${gib(c.reservedForHuman.bytes)} of that is held back for you`
    );
  }
  return (
    `${c.running} charged agent${c.running === 1 ? ' is' : 's are'} already running ` +
    `against a cap of ${c.cap}`
  );
}

/**
 * The headline of a refusal: the binding constraint, named, then the figures
 * that make it checkable.
 *
 * KAN-60 (in the extraction source): a load-bound refusal used to be headlined
 * "at capacity" with the cap count leading — read by a human as "2 of 10, at
 * capacity", which was false by its own numbers (2 running against a cap of
 * 10) and pointed at the wrong constraint entirely. `headroomBoundBy` already
 * knows which term bound; the headline renders from it, so "at capacity" is
 * said only when the count is what bound.
 */
export function capacityHeadline(c: Capacity): string {
  // KAN-208 added `cpu too busy` and left `load too high` in place rather than
  // renaming it. They are not synonyms: the first is a machine whose cores are
  // full, the second is a machine nobody measured, and a reader who cannot
  // tell them apart cannot act on either. `verify-readme-is-current` matches on
  // both headlines for exactly that reason.
  //
  // KAN-216 adds `machine stalled`, a fifth headline and not a rewording of any
  // of these four. `cpu too busy` is a machine whose cores are full; this is a
  // machine whose cores may be idle and which is getting nothing done anyway,
  // which is a different fact with a different remedy — and it is the one the
  // gate was blind to between KAN-208 and this change.
  const constraint =
    c.headroomBoundBy === 'stall'
      ? `machine stalled on ${c.stallSource}`
      : c.headroomBoundBy === 'cpu'
        ? 'cpu too busy'
        : c.headroomBoundBy === 'load'
          ? 'load too high'
          : c.headroomBoundBy === 'memory'
            ? 'not enough memory'
            : 'at capacity';
  return `${constraint} — ${capacityReason(c)}`;
}

/**
 * Whether standing an agent down could make room for the one being refused.
 *
 * True for every refusal the counting terms produced — a slot, a core or a
 * gigabyte all come back when an agent stops. FALSE ON A STALL, and that is the
 * whole reason this is a function rather than an `if` in the router: preemption
 * exists to free a SLOT, and a stalled machine is not short of slots. Standing
 * an agent down would destroy its work and then start a replacement onto the
 * same stalled disk.
 *
 * It lives here, next to the model, rather than inline at its one call site,
 * because a decision that can only be exercised by constructing a whole daemon
 * is a decision nothing will exercise. As a pure function of a `Capacity` it is
 * asserted directly by scripts/verify-io-stall-gate.mjs §6, on capacities that
 * include a stalled machine no proof can produce on demand.
 */
export function preemptionCanHelp(c: Capacity): boolean {
  return c.headroomBoundBy !== 'stall';
}

/** Why an activation was refused, with the arithmetic that refused it. */
export function capacityRefusal(c: Capacity, what: string): string {
  return (
    `Refusing to activate ${what}: ${capacityHeadline(c)}.\n` +
    `${describeCapacity(c)}\n` +
    `Deactivate an agent to make room, or pass override: true to start it anyway ` +
    `(the override is recorded with these numbers).`
  );
}
