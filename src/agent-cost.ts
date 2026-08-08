// What one agent actually costs this machine, measured rather than assumed.
//
// MEASURED_AGENT_COST in capacity.ts is the whole cap in two numbers, and
// KAN-34 (in the extraction source; see docs/ported-lineage.md) shipped them
// from a single afternoon's observation with a note saying "re-measure it
// before trusting it". This is that instrument (KAN-55, in the extraction
// source) — the daemon runs the same measurement a hand-held script would,
// with exactly one copy of the logic.
//
// An agent is not the runtime process. It is that process plus everything it
// starts — tsc, npm, git, ripgrep, subagents — and the cost that matters is
// the whole tree's. So the tree is what is measured: every process is grouped
// under the nearest agent-runtime ancestor that has no agent-runtime ancestor
// of its own, and CPU is summed per group. Which process names count as an
// agent runtime comes from the launcher table (AGENT_RUNTIME_COMMS in
// launchers.ts — `claude`, `agy`, …), so the sampler and the spawner cannot
// disagree about what an agent is. A `shell` launcher starts no runtime and
// is therefore invisible here, which is honest: its cost is a bash prompt.
//
// CPU is measured as cores, not as a load average: utime+stime deltas from
// /proc/<pid>/stat divided by wall-clock seconds. That is the quantity the
// machine actually spends. The load average, reported alongside it, is the
// queue that quantity produces — the number the human feels, and always the
// larger of the two once the machine is contended.

import * as fs from 'fs';
import { AGENT_RUNTIME_COMMS } from './launchers.js';

const CLK_TCK = 100; // Linux USER_HZ; constant on every platform CrabCast runs on.
const PAGE_SIZE = 4096;

/** One process as read from /proc/<pid>/stat. */
export interface ProcessSample {
  pid: number;
  comm: string;
  ppid: number;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  rssBytes: number;
}

/** The held "before" side of a measurement; produced by startMeasurement(). */
export interface MeasurementStart {
  procs: Map<number, ProcessSample>;
  loadStart: number;
  /** Wall-clock ms (Date.now()) when the sample was taken. */
  startedAt: number;
}

/** One agent tree's cost over the window. */
export interface AgentTreeCost {
  /** The root agent-runtime process of the tree. */
  pid: number;
  /** Processes in the tree at the end of the window. */
  processes: number;
  /** utime+stime deltas over wall-clock seconds — cores, not load average. */
  cores: number;
  residentMb: number;
}

/**
 * A finished measurement. Field names and order match what the extraction
 * source's measurement script has always printed: {elapsed, loadStart,
 * loadEnd, agents, totals} — evidence produced before and after the port must
 * stay comparable.
 */
export interface AgentCostMeasurement {
  /** Wall-clock seconds actually elapsed between the two samples. */
  elapsed: number;
  loadStart: number;
  loadEnd: number;
  /** Per-tree figures, sorted by cores descending. */
  agents: AgentTreeCost[];
  totals: {
    agents: number;
    cores: number;
    residentMb: number;
  };
}

/**
 * One sample of every process on the machine.
 *
 * Reads /proc directly rather than shelling out to ps, because the fields that
 * matter (utime, stime, rss in pages) are there without parsing a human-facing
 * table, and because a process that exits between readdir and read is an
 * ordinary event here, not an error.
 */
export function sampleProcesses(): Map<number, ProcessSample> {
  const procs = new Map<number, ProcessSample>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm is parenthesised and may itself contain spaces and parens, so
      // split on the LAST ')' rather than tokenising the whole line.
      const close = stat.lastIndexOf(')');
      const open = stat.indexOf('(');
      const comm = stat.slice(open + 1, close);
      const rest = stat.slice(close + 2).split(' ');
      // Fields are 1-indexed from `pid` in proc(5); after the split above,
      // rest[0] is field 3 (state), so field N is rest[N - 3].
      procs.set(pid, {
        pid,
        comm,
        ppid: Number(rest[1]),          // field 4
        cpuTicks: Number(rest[11]) + Number(rest[12]), // fields 14, 15
        rssBytes: Number(rest[21]) * PAGE_SIZE          // field 24
      });
    } catch {
      // Exited between readdir and read, or a kernel thread we may not stat.
    }
  }
  return procs;
}

/**
 * Which agent each process belongs to: the nearest agent-runtime ancestor
 * that is not itself descended from an agent runtime.
 *
 * The outer test is what keeps a subagent from being counted as an agent of
 * its own. A subagent is work the parent agent chose to do; charging it
 * separately would report two agents where the user started one.
 */
export function groupByAgent(procs: Map<number, ProcessSample>): Map<number, number[]> {
  const rootOf = new Map<number, number | null>();
  const isAgentRuntime = (p: ProcessSample) => AGENT_RUNTIME_COMMS.has(p.comm);

  const resolve = (pid: number, seen = new Set<number>()): number | null => {
    if (rootOf.has(pid)) return rootOf.get(pid)!;
    const p = procs.get(pid);
    if (!p || seen.has(pid)) return null;
    seen.add(pid);
    const parentRoot = p.ppid > 1 ? resolve(p.ppid, seen) : null;
    // A runtime under a runtime belongs to the outer one; a runtime under
    // anything else starts a group.
    const root = parentRoot ?? (isAgentRuntime(p) ? pid : null);
    rootOf.set(pid, root);
    return root;
  };

  const groups = new Map<number, number[]>();
  for (const pid of procs.keys()) {
    const root = resolve(pid);
    if (root === null) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(pid);
  }
  return groups;
}

const loadNow = (): number =>
  Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

/**
 * Take the "before" sample. The returned value is plain data: a long-lived
 * caller (the daemon's periodic loop) holds it for as long as it likes and
 * hands it to finishMeasurement() when the window closes.
 */
export function startMeasurement(): MeasurementStart {
  return { procs: sampleProcesses(), loadStart: loadNow(), startedAt: Date.now() };
}

/**
 * Take the "after" sample and compute per-tree figures over the window since
 * `start`.
 */
export function finishMeasurement(start: MeasurementStart): AgentCostMeasurement {
  const before = start.procs;
  const after = sampleProcesses();
  const elapsed = (Date.now() - start.startedAt) / 1000;
  const loadEnd = loadNow();

  // Group on the *later* sample so processes started mid-window are included;
  // their CPU counts from zero, which is what "cost over this window" means.
  const groups = groupByAgent(after);

  const agents: AgentTreeCost[] = [];
  for (const [root, pids] of groups) {
    let ticks = 0;
    let rss = 0;
    for (const pid of pids) {
      const now = after.get(pid);
      if (!now) continue;
      const then = before.get(pid);
      // A pid absent from `before` is new: all of its CPU falls in the window.
      ticks += now.cpuTicks - (then?.cpuTicks ?? 0);
      rss += now.rssBytes;
    }
    agents.push({
      pid: root,
      processes: pids.length,
      cores: ticks / CLK_TCK / elapsed,
      residentMb: rss / (1024 * 1024)
    });
  }
  agents.sort((a, b) => b.cores - a.cores);

  const totals = {
    agents: agents.length,
    cores: agents.reduce((s, a) => s + a.cores, 0),
    residentMb: agents.reduce((s, a) => s + a.residentMb, 0)
  };

  return { elapsed, loadStart: start.loadStart, loadEnd, agents, totals };
}

/**
 * Measure over a window of `seconds`. Convenience over start/finish for a
 * caller that just wants one figure and can afford to wait in place.
 */
export async function measureAgentCost(seconds: number): Promise<AgentCostMeasurement> {
  const start = startMeasurement();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return finishMeasurement(start);
}
