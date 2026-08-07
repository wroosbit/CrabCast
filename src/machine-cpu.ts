// What this machine's CPUs are actually doing, as opposed to how long the
// queue in front of them is (KAN-208).
//
// THE DISTINCTION THIS FILE EXISTS FOR. `os.loadavg()[0]` is a run-queue
// length, and on Linux — unlike every other Unix — the queue it measures
// includes TASK_UNINTERRUPTIBLE as well as TASK_RUNNING. A process blocked in
// a disk read counts toward the load average exactly as much as one burning a
// core. So a machine doing heavy I/O reports a high load with its cores idle,
// and anything that treats the load average as "how much CPU is left" gets
// that case backwards. It is also an exponential average over the last minute,
// so it lags: work that finished thirty seconds ago is still most of the
// figure.
//
// /proc/stat answers the other question. Its first line is cumulative jiffies
// since boot across all CPUs, one column per state, and the two facts that
// matter here are that `iowait` is its own column rather than part of `system`,
// and that `idle` and `iowait` are both time the CPU spent doing nothing. So
// the ratio below counts iowait as NOT busy — deliberately, and it is the
// whole point of the file: that column is precisely the work the load average
// double-counts as demand for a core.
//
// WHAT THIS DOES NOT MEASURE, said here because the whole hazard of replacing
// a proxy with a measurement is that the measurement is narrower than the
// proxy and nobody says so:
//
//   - I/O saturation. A machine whose cores are idle because every process is
//     blocked on a dying disk reads as *available* here and as *full* under the
//     load average. Under KAN-208's decision we start agents on it. That is a
//     deliberate trade, argued in src/capacity.ts beside the code that makes
//     it, not an oversight — and `load1` stays reported alongside so the
//     divergence is visible to anyone reading a capacity report.
//   - Memory pressure. Nothing here sees it; `availableBytes` does, and the
//     memory term is what bounds on it.
//   - Anything that has not happened yet. A window average cannot see a burst
//     that started after it closed, in exactly the way the load average cannot.
//     The count term (`headroomByCap`) is what covers that gap for both.
//
// WHY A WINDOW AND NOT AN INSTANT. The columns are counters, so a single read
// says only what the machine has done since boot, which is useless. Two reads
// and a subtraction give an average over the interval between them, and the
// interval is chosen by the caller — the daemon holds a window open on a timer
// (daemon.ts), the way it already does for agent cost.
//
// The shape here is deliberately the same as agent-cost.ts's: start/finish over
// a held window, a convenience wrapper for a caller that can afford to wait in
// place, and a validator that returns null rather than guessing. Two
// instruments that look alike are two instruments a reader only has to learn
// once.

import * as fs from 'fs';
import * as os from 'os';

/**
 * Observed CPU use over a real window, with the metadata a reader needs to
 * judge it — the same bargain {@link MeasuredAgentCost} strikes: a figure
 * nobody can date is a figure nobody can check.
 */
export interface CpuObservation {
  /** Cores' worth of CPU actually in use over the window. Never negative,
   *  never above the machine's core count. */
  busyCores: number;
  /** How long the window was, in seconds. */
  windowSeconds: number;
  /** Wall-clock ms (Date.now()) when the window closed. */
  sampledAt: number;
}

/** The two sums that matter, in jiffies, cumulative since boot. */
export interface CpuTicks {
  /** user + nice + system + irq + softirq + steal — cycles actually spent. */
  busy: number;
  /** idle + iowait. iowait is HERE, and that is the point of this file. */
  idle: number;
}

/** The held "before" side of a window; produced by {@link startCpuWindow}. */
export interface CpuWindow {
  ticks: CpuTicks;
  /** Wall-clock ms (Date.now()) when the window opened. */
  startedAt: number;
}

/**
 * A window shorter than this proves nothing: at 100 jiffies per core per
 * second, a 200 ms window is a couple of hundred samples and one scheduler
 * decision moves it by a whole core. Rejected rather than published, because a
 * noisy figure that looks like a measurement is worse than no figure — no
 * figure falls back to the load average and says so.
 */
export const MIN_WINDOW_SECONDS = 1;

/**
 * Parse the aggregate `cpu` line out of /proc/stat.
 *
 * Split out from the read so it can be exercised against fixtures — including
 * the fixture this whole ticket is about, where iowait is most of the
 * non-idle time. Returns null on anything unexpected rather than a plausible
 * wrong number.
 *
 * proc(5) gives the columns as: user nice system idle iowait irq softirq
 * steal guest guest_nice. `guest` and `guest_nice` are already counted inside
 * `user` and `nice` respectively, so adding them would double-count; they are
 * ignored here on purpose.
 */
export function parseCpuTicks(procStat: string): CpuTicks | null {
  const line = procStat.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait are the five that must be there; irq,
  // softirq and steal are older-kernel-optional and default to zero.
  if (fields.length < 5 || fields.slice(0, 5).some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  const [user, nice, system, idle, iowait, irq = 0, softirq = 0, steal = 0] = fields;
  if ([irq, softirq, steal].some((n) => !Number.isFinite(n) || n < 0)) return null;
  return {
    busy: user + nice + system + irq + softirq + steal,
    idle: idle + iowait
  };
}

/** The counters right now, or null where /proc/stat is not readable — which is
 *  every non-Linux machine, and is handled rather than thrown. */
export function readCpuTicks(): CpuTicks | null {
  try {
    return parseCpuTicks(fs.readFileSync('/proc/stat', 'utf8'));
  } catch {
    return null;
  }
}

/** Open a window. Null where the counters cannot be read at all. */
export function startCpuWindow(): CpuWindow | null {
  const ticks = readCpuTicks();
  return ticks ? { ticks, startedAt: Date.now() } : null;
}

/**
 * Close a window and compute cores in use across it.
 *
 * The figure is a RATIO of the machine scaled by its core count —
 * `busy ÷ (busy + idle) × cores` — rather than `busy ÷ USER_HZ ÷ elapsed`.
 * Both are the same number when nothing goes wrong; the ratio stays right when
 * something does. It needs no USER_HZ constant, it is immune to the wall clock
 * being stepped mid-window (NTP, a suspended laptop), and a counter that
 * appears to run backwards falls out as a rejected window rather than as a
 * negative core count.
 *
 * Returns null — never a guess — on a window too short to mean anything, on
 * counters that moved backwards, and where /proc has stopped being readable
 * between the two ends.
 */
export function finishCpuWindow(start: CpuWindow, now = Date.now()): CpuObservation | null {
  const end = readCpuTicks();
  if (!end) return null;

  const busyDelta = end.busy - start.ticks.busy;
  const idleDelta = end.idle - start.ticks.idle;
  const totalDelta = busyDelta + idleDelta;
  if (busyDelta < 0 || idleDelta < 0 || totalDelta <= 0) return null;

  const windowSeconds = (now - start.startedAt) / 1000;
  if (!(windowSeconds >= MIN_WINDOW_SECONDS)) return null;

  const cores = os.cpus().length || 1;
  // Clamped because the ratio is bounded by construction and a clamp costs
  // nothing, but a report claiming 4.3 of 4 cores would be read as a bug in
  // the gate rather than as a rounding artefact.
  const busyCores = Math.min(cores, Math.max(0, (busyDelta / totalDelta) * cores));
  return { busyCores, windowSeconds, sampledAt: now };
}

/**
 * Measure over a window of `seconds`. Convenience over start/finish for a
 * caller that just wants one figure and can afford to wait in place — the
 * proofs, and anything hand-run.
 */
export async function measureMachineCpu(seconds: number): Promise<CpuObservation | null> {
  const start = startCpuWindow();
  if (!start) return null;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return finishCpuWindow(start);
}

/**
 * The observation every caller of `readCapacity()` in this process divides by,
 * held here so the daemon's router and the daemon's own bookkeeping cannot
 * disagree about how busy the machine is. Exactly the arrangement
 * `liveMeasuredCost` already has in capacity.ts, for exactly its reason.
 *
 * The daemon's sampler is the only writer in production. It publishes a fresh
 * value each window and clears to null the moment the instrument fails, so
 * "whatever breaks, capacity still answers" holds here too — it answers on the
 * load average, and the report says which.
 */
let observed: CpuObservation | null = null;

export function setObservedCpu(observation: CpuObservation | null): void {
  observed = observation;
}

/**
 * How old an observation may be before capacity stops believing it.
 *
 * Two and a half of the daemon's 30s windows. One missed tick is a busy
 * machine and is tolerated; two in a row is an instrument that has stopped,
 * and a stale "0.4 cores in use" from four minutes ago would be the most
 * dangerous kind of wrong — it opens the gate on a figure nobody is measuring.
 * Falling back to the load average is the conservative direction, which is why
 * the fallback is the load average and not "assume idle".
 */
export const MAX_OBSERVATION_AGE_MS = 75_000;

/**
 * The held observation if it is still current, else null.
 *
 * Freshness is enforced on READ rather than by the writer, so a sampler that
 * died without clearing itself — the failure mode nobody codes for — expires
 * on its own.
 */
export function freshObservedCpu(now = Date.now()): CpuObservation | null {
  if (!observed) return null;
  return now - observed.sampledAt <= MAX_OBSERVATION_AGE_MS ? observed : null;
}

/** The held observation regardless of age. For reporting on the instrument
 *  itself; the gate uses {@link freshObservedCpu}. */
export function lastObservedCpu(): CpuObservation | null {
  return observed;
}
