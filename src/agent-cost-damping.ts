// Believing a measurement, carefully: the damping between what agent-cost.ts
// samples and what capacity.ts divides by.
//
// The instantaneous reading must never reach the arithmetic, because the two
// mistakes it invites are not the same size. Believe too quickly that agents
// are cheap — one idle minute while the whole fleet waits on an API — and the
// cap opens to a fleet the machine cannot carry the moment they all wake,
// which is exactly the desktop-killing incident (KAN-34, in the extraction
// source; see docs/ported-lineage.md) this file descends from. Believe too
// slowly that agents are expensive and the only cost is a refused activation,
// which the operator can read, override, or wait out. So the filter is
// asymmetric on purpose: quick to believe an agent is expensive, slow to
// believe it is cheap.
//
// The shape is an EWMA with a per-direction alpha, chosen over a
// high-water-mark window because it needs no history buffer, degrades to
// nothing when the sampler stops feeding it, and its step response is easy to
// state (and is stated, and proved in verify-agent-capacity.mjs sections
// 10–13): at ALPHA_UP = 0.5 a step up is ~87% believed after three windows;
// at ALPHA_DOWN = 0.1 a step down needs ~22 windows to be 90% believed. With
// the daemon's 60-second window that is minutes to charge more and the better
// part of half an hour to charge less — the fast direction protects the
// human, the slow one merely delays an optimism.
//
// Everything here is pure. The state (the previous estimate) belongs to the
// caller — the daemon's sampler loop — so the arithmetic can be driven
// through step responses in a script without a daemon, a clock, or /proc.

import type { AgentCost } from './capacity.js';
import type { AgentCostMeasurement } from './agent-cost.js';

const MIB = 1024 ** 2;

/** Believed per window when the sample says agents got more expensive. */
export const ALPHA_UP = 0.5;
/** Believed per window when the sample says agents got cheaper. */
export const ALPHA_DOWN = 0.1;

/**
 * The floor under a measured per-tree core figure.
 *
 * The daemon publishes the damped estimate rounded to 3 decimals so the
 * printed figures are exactly what the arithmetic divides by; a genuinely
 * idle fleet can measure below 0.0005 and round to 0 — and a zero divisor
 * turns capByCpu and headroomByLoad into Infinity, silently disabling the
 * CPU dimension this model exists to enforce while the report prints
 * "÷ 0 core/agent". One thousandth of a core is the smallest figure the
 * rounding can represent; flooring here (and at the publish site) keeps the
 * divisor a number.
 */
export const MIN_MEASURED_CORES = 0.001;

/**
 * One damping step: move `previous` toward `sample`, fast upward and slowly
 * downward, per dimension. The first call seeds `previous` with
 * MEASURED_AGENT_COST (the caller does this), so a single flattering window
 * can never swing the estimate to whatever it happened to catch.
 */
export function dampCost(previous: AgentCost, sample: AgentCost): AgentCost {
  const step = (prev: number, next: number) =>
    prev + (next > prev ? ALPHA_UP : ALPHA_DOWN) * (next - prev);
  return {
    residentBytes: step(previous.residentBytes, sample.residentBytes),
    cores: step(previous.cores, sample.cores)
  };
}

/**
 * A finished measurement window reduced to the per-tree cost the damping
 * consumes, or null when the window proved nothing.
 *
 * Null is the degrade signal, and it is deliberately broad: an empty fleet
 * (nothing to measure — the seed is the only honest answer for the *next*
 * agent), a zero or negative core figure (a live agent tree spends *some*
 * CPU every minute; zero means the instrument misread), a resident figure at
 * or below zero or beyond the machine's own RAM (arithmetic gone wrong, not a
 * fleet). A sample rejected here must pull capacity back to the labelled
 * seed rather than leave a stale estimate posing as live — the caller clears
 * its state on null, and verify-agent-capacity.mjs proves each rejection.
 */
export function sampleFromMeasurement(
  m: AgentCostMeasurement,
  machineTotalBytes: number
): AgentCost | null {
  if (!Number.isFinite(m.elapsed) || m.elapsed <= 0) return null;
  if (!m.totals || !Number.isFinite(m.totals.agents) || m.totals.agents <= 0) return null;

  const cores = m.totals.cores / m.totals.agents;
  const residentBytes = (m.totals.residentMb * MIB) / m.totals.agents;

  if (!Number.isFinite(cores) || cores <= 0) return null;
  if (!Number.isFinite(residentBytes) || residentBytes <= 0) return null;
  if (residentBytes > machineTotalBytes) return null;

  // Floored, not rejected: a near-zero reading is a real measurement of an
  // idle fleet, and the seed would over-charge it — but it must never round
  // to a zero divisor downstream. See MIN_MEASURED_CORES.
  return { cores: Math.max(MIN_MEASURED_CORES, cores), residentBytes };
}
