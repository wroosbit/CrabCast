// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as fs from 'fs';
import * as os from 'os';
import { CpuObservation, freshObservedCpu } from './machine-cpu.js';

export type { CpuObservation };

/**
 * How many agents this machine can carry — measured, not declared.
 *
 * On 2026-07-31 the extraction source's board manager staffed seven agents on
 * a 4-core laptop: load average 11.3 against 4 cores, 9 claude processes
 * holding 3.0 GB, and 319 MB of 15 GB free. Nothing in the product knew any
 * of that. The only instrument that noticed was a human saying the desktop
 * felt slow (KAN-34).
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
 * KAN-36 corrected two things about the first version, both discovered the
 * same way — a human found the product unusable and no instrument had noticed:
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
 * The rule that replaced it (KAN-41), now expressed per agent rather than per
 * workspace type: only *chargeable* agents are accounted for at all. `cap` is
 * cores and memory minus the human reserve and herdr's overhead, and nothing
 * else. An agent a caller configured with `chargeable: false` is neither
 * counted in `running` nor reserved for — that flag is asked for because the
 * agent supervises rather than does the work, typically low-resource and idle,
 * not competing for the machine the way a worker compiling a repo does. Such
 * agents are still reported in `Capacity.exemptAgents`, so a reader of a
 * capacity report can see they exist; they are simply never charged.
 *
 * `chargeable` used to be one third of a `gateExempt` boolean declared on a
 * workspace type. Splitting it out is what lets a caller have an agent that
 * costs a slot but can never be taken, or one that is free but still refusable
 * — combinations the single flag could not express.
 *
 * KAN-44/KAN-56 closed the loop this header opened. `readCapacity()` always
 * read cores, memory and load live; the one static input left was the
 * per-agent cost divisor, measured once on 2026-07-31. Now the daemon
 * re-measures its own fleet on a timer (daemon.ts, with agent-cost.ts as the
 * instrument), damps the estimate (agent-cost-damping.ts — asymmetric on
 * purpose, see that file), and this arithmetic divides by the damped figure.
 * The constants below remain as the *seed*: what capacity answers from when
 * there is nothing to measure — no agent trees, no /proc, a sample that fails
 * validation — because whatever breaks, capacity still answers, conservatively.
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
 * sixteen, and the human who filed KAN-34 had already found out what seven
 * feels like. The load average is the other extreme: seven agents produced a
 * load of 11.3, ~1.6 each, but that is a queue length, and it inflates as the
 * machine gets worse — each of those seven was mostly waiting on the other
 * six. Calibrating on 1.6 says a 4-core box carries one.
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
 * Since KAN-56 the daemon does re-measure it, continuously, and these numbers
 * are the seed rather than the answer: they hold until the sampler has a
 * damped live figure, and they are what everything degrades to when it does
 * not. A capacity report built from them says `seed`, because a figure nobody
 * measured on this fleet must be labelled as such — that mislabelling is the
 * exact failure story KAN-44 exists to correct.
 */
export const MEASURED_AGENT_COST: AgentCost = {
  residentBytes: 650 * MIB,
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
  /** Agent trees the per-tree figures were averaged over. */
  agentTrees: number;
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
 */
export type HeadroomBound = 'cap' | 'cpu' | 'load' | 'memory';

export interface Capacity {
  machine: MachineFacts;
  cost: AgentCost;
  /** Where each dimension of `cost` came from: override, measured, or seed. */
  costSource: { residentBytes: CostSource; cores: CostSource };
  /**
   * The damped measurement that was consulted, if the sampler had one. Kept
   * even when an override beat it, so a report can say what was ignored.
   */
  measured: MeasuredAgentCost | null;
  reservedForHuman: { cores: number; bytes: number };

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
  const cost: AgentCost = { residentBytes: resident.value, cores: coreCost.value };
  const costSource = { residentBytes: resident.source, cores: coreCost.source };
  const configuredCap = options.configuredCap ?? null;

  const reservedCores = humanReserveCores(machine.cores);
  const reservedBytes = humanReserveBytes(machine.totalBytes);

  // Static cap: what the hardware supports with nothing else assumed. herdr's
  // share comes off here because the load average cannot be consulted for a
  // machine that is not this one. Nothing is held back for uncharged agents
  // — see the header: only charged agents are charged.
  const cpuBudget = machine.cores - reservedCores - HERDR_OVERHEAD_CORES;
  const capByCpu = Math.floor(Math.max(0, cpuBudget) / cost.cores);
  const capByMemory = Math.floor(
    Math.max(0, machine.totalBytes - reservedBytes) / cost.residentBytes
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
  const cpu = machine.cpu ?? null;
  const headroomByCpu =
    cpu === null
      ? null
      : Math.max(0, Math.floor((machine.cores - reservedCores - cpu.busyCores) / cost.cores));

  // Computed unconditionally so every report can print it beside the CPU term
  // — the divergence between the two IS the KAN-208 finding, and a figure you
  // have to recompute by hand to see it is a figure nobody sees. It binds only
  // where headroomByCpu is null.
  const loadBudget = machine.cores - reservedCores - machine.load1;
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

  const headroom = Math.min(headroomByCap, cpuSideTerm, headroomByMemory);
  // Ties resolve to the term the reader can most directly act on: closing an
  // agent is a decision, waiting for the machine to go quiet is not.
  const headroomBoundBy: HeadroomBound =
    headroomByCap <= cpuSideTerm && headroomByCap <= headroomByMemory
      ? 'cap'
      : cpuSideTerm <= headroomByMemory
        ? cpuSideName
        : 'memory';

  return {
    machine,
    cost,
    costSource,
    measured,
    reservedForHuman: { cores: reservedCores, bytes: reservedBytes },
    cap,
    capByCpu,
    capByMemory,
    capBoundBy,
    configuredCap,
    running,
    exemptAgents: options.exemptRunning ?? 0,
    headroom,
    headroomByCap,
    headroomByCpu,
    headroomByLoad,
    headroomByMemory,
    headroomBoundBy,
    cpu,
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
    cpu: freshObservedCpu()
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
    exemptRunning: exempt
  });
}

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * The derivation in words, with the numbers that produced it.
 *
 * This is the whole point: an agent refused for capacity has to say why, in
 * figures the reader can check, the way KAN-24 made a refused spawn name its
 * cause instead of failing obscurely.
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
  // Every cost figure carries its provenance, because the divisor can now be
  // a measurement: a reader must be able to tell a number this fleet produced
  // from the 2026-07-31 seed and from a number the operator typed in.
  lines.push(
    `agent cost: ${Math.round(c.cost.residentBytes / MIB)} MB resident (${c.costSource.residentBytes}), ` +
    `${c.cost.cores} core while active (${c.costSource.cores})`
  );
  if (c.measured) {
    const beaten: string[] = [];
    if (c.costSource.residentBytes === 'override') {
      beaten.push(`CRABCAST_AGENT_MEMORY_MB overrides its ${Math.round(c.measured.residentBytes / MIB)} MB`);
    }
    if (c.costSource.cores === 'override') {
      beaten.push(`CRABCAST_AGENT_CORES overrides its ${c.measured.cores} core`);
    }
    lines.push(
      `  measured (damped): ${Math.round(c.measured.residentBytes / MIB)} MB, ` +
      `${c.measured.cores} core per agent tree — ${c.measured.agentTrees} tree(s) ` +
      `over a ${Math.round(c.measured.windowSeconds)}s window ` +
      `ending ${new Date(c.measured.sampledAt).toISOString()}` +
      (beaten.length ? `; ignored: ${beaten.join(', ')}` : '')
    );
  } else if (c.costSource.residentBytes === 'seed' || c.costSource.cores === 'seed') {
    lines.push(
      '  no live measurement; seed figures are the 2026-07-31 constants, ' +
      'not a measurement of this fleet'
    );
  }
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
      `memory allows ${c.capByMemory} ((${gib(m.totalBytes)} − ${gib(c.reservedForHuman.bytes)}) ` +
      `÷ ${Math.round(c.cost.residentBytes / MIB)} MB/agent)` +
      (c.capBoundBy === 'floor'
        ? '; both said 0, floored to 1 because a machine that can run nothing is not a useful answer'
        : `; bound by ${c.capBoundBy}`)
    );
  }

  lines.push(
    `running: ${c.running} charged agent(s)` +
    (c.exemptAgents > 0
      ? `, plus ${c.exemptAgents} uncharged agent(s) (not counted against the cap)`
      : '')
  );
  // Every term prints its own arithmetic, including the one that did not bind
  // — a refusal a reader cannot check against the terms it beat is a refusal
  // they have to take on trust. The load term keeps its arithmetic for the
  // same reason it is still computed: seeing `load allows 0` next to `cpu
  // allows 3` is how KAN-208 was found in the first place.
  const loadTerm =
    `load ${c.cpu ? 'would allow' : 'allows'} ${c.headroomByLoad} ` +
    `((${m.cores} cores − ${c.reservedForHuman.cores} reserved − ${m.load1.toFixed(2)} load) ` +
    `÷ ${c.cost.cores}${c.cpu ? '; reported, does not bind' : '; fallback, nothing measured CPU'})`;
  const cpuTerm = c.cpu
    ? `cpu allows ${c.headroomByCpu} ((${m.cores} cores − ${c.reservedForHuman.cores} reserved ` +
      `− ${c.cpu.busyCores.toFixed(2)} in use) ÷ ${c.cost.cores}), `
    : '';
  lines.push(
    `headroom: ${c.headroom} more — ` +
    `count allows ${c.headroomByCap} (${c.cap} cap − ${c.running} running), ` +
    cpuTerm +
    `${loadTerm}, ` +
    `memory allows ${c.headroomByMemory} ((${gib(m.availableBytes)} available ` +
    `− ${gib(c.reservedForHuman.bytes)} reserved) ÷ ${Math.round(c.cost.residentBytes / MIB)} MB); ` +
    `bound by ${c.headroomBoundBy}`
  );

  return lines.join('\n');
}

/**
 * One line for callers that only have room for one.
 *
 * When there is no room, it leads with the binding constraint rather than
 * with the count (KAN-60): opening "2/10 agents" on a load-bound refusal
 * read as "at capacity" by count, which the line's own figures contradicted.
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
  if (c.headroomBoundBy === 'cpu' && c.cpu) {
    return (
      `${c.cpu.busyCores.toFixed(2)} cores are in use, against the ` +
      `${forAgents} cores this machine leaves to agents ` +
      `(measured over ${c.cpu.windowSeconds.toFixed(0)}s)`
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
      `leaves to agents`
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
 * KAN-60: a load-bound refusal used to be headlined "at capacity" with the
 * cap count leading — read by a human as "2 of 10, at capacity", which was
 * false by its own numbers (2 running against a cap of 10) and pointed at the
 * wrong constraint entirely. `headroomBoundBy` already knows which term
 * bound; the headline renders from it, so "at capacity" is said only when
 * the count is what bound.
 */
export function capacityHeadline(c: Capacity): string {
  // KAN-208 added `cpu too busy` and left `load too high` in place rather than
  // renaming it. They are not synonyms: the first is a machine whose cores are
  // full, the second is a machine nobody measured, and a reader who cannot
  // tell them apart cannot act on either. `verify-readme-is-current` matches on
  // both headlines for exactly that reason.
  const constraint =
    c.headroomBoundBy === 'cpu'
      ? 'cpu too busy'
      : c.headroomBoundBy === 'load'
        ? 'load too high'
        : c.headroomBoundBy === 'memory'
          ? 'not enough memory'
          : 'at capacity';
  return `${constraint} — ${capacityReason(c)}`;
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
