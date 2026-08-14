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
//
// WHOSE TREES (KAN-338). Enumerating every agent tree on the machine answers
// "what does an agent cost" only if the trees are ours. They were not: this
// daemon divided a budget for CHARGED agents by a figure averaged over
// whatever agent-runtime trees existed, including another orchestrator's fleet
// entirely. KAN-275 bounded that with a floor and could not attribute it,
// because nothing joined a tree to an agent record. {@link paneHandleOf} is
// that join, and {@link finishMeasurement} now REQUIRES an attributor: a
// measurement over an unattributed population is no longer a value this module
// can produce.

import * as fs from 'fs';
import { AGENT_RUNTIME_COMMS } from './launchers.js';

const CLK_TCK = 100; // Linux USER_HZ; constant on every platform CrabCast runs on.
const PAGE_SIZE = 4096;

/**
 * The environment variable herdr sets in every pane it opens, holding a handle
 * for that pane. This is the join from a running process to the pane it is
 * sitting in, and it is what makes attribution possible without herdr
 * reporting a pid.
 *
 * MEASURED, NOT ASSUMED, at herdr 0.6.4 on 2026-08-13: all 7 agent trees on
 * this machine carried one, and `herdr pane get <handle>` resolved each to
 * exactly the pane whose label and cwd belong to that agent. `herdr pane list`
 * reports no pid, no tty and no process field of any kind — checked again
 * across `pane list`, `pane get` and `agent get`, which is why the join runs
 * from the process to the pane rather than the other way round.
 *
 * AND THE FORM IS UNDOCUMENTED FOR THE SUBCOMMAND WE PASS IT TO (KAN-385).
 * "Measured rather than assumed" is not the only caveat on this join, and a
 * reader had no way to learn the other one from this file. `herdr pane --help`
 * documents its parameter as `pane get <pane_id>` — and this handle is NOT a
 * `pane_id`: `pane list` publishes `w65702dcc803d94-10` for the same pane that
 * carries `p_252` here, and `pane get` happens to accept both. The phrase that
 * covers the `p_NNN` form, "legacy pane ids", appears only in the target list
 * of `herdr agent --help`. So this works on an observed behaviour rather than a
 * published one. docs/herdr-pane-handle-join.md is the whole of it: the
 * measurement with its controls, the request made of herdr's maintainer, and
 * what we decided to do if the answer is no.
 *
 * WHAT IT IS NOT. It is not an ownership test and must never become one: it
 * names a pane, and whether that pane is OURS is answered where it has always
 * been answered, by `ourPaneIn` in herdr.ts, from the pane's NAME (see the
 * one-test rule at herdr.ts:552). This module deliberately cannot reach that
 * function — it asks its caller a single boolean and holds no opinion.
 *
 * WHY THIS IS NOT THE KEY launchers.ts:88-94 REJECTED. That rejection is about
 * CrabCast BAKING ITS OWN identity into a pane's environment, where it becomes
 * "ambient authority lying around in a shell" — a fact this daemon issued,
 * inherited by every process the agent ever spawns, offered back to us as
 * proof of parentage. Nothing here is issued by us: herdr sets this, we read
 * it, and no new authority is created. It is still inherited, so it is still
 * forgeable by anything that can `export` — see the caller-side note in
 * daemon.ts for why the KAN-275 floor is what makes that tolerable, and why
 * the floor therefore stays.
 */
const PANE_HANDLE_VAR = 'HERDR_PANE_ID';

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

/**
 * Why a tree is not in the charged sample. Three reasons rather than one
 * because they fail differently and a reader needs to tell them apart: a
 * machine full of `foreign` is another orchestrator running beside us and is
 * ordinary, while a machine full of `handle-unreadable` is an instrument
 * problem — this daemon running as a user that cannot read those processes,
 * for instance — wearing the same clothes as an empty fleet.
 */
export type TreeExclusion = 'foreign' | 'no-handle' | 'handle-unreadable';

/**
 * Whether one tree is in the divisor's sample, and why not when it is not.
 *
 * A discriminated union rather than a boolean plus a nullable reason, so
 * "excluded for no stated reason" cannot be constructed.
 */
export type TreeOwnership =
  | { charged: true; paneHandle: string }
  | { charged: false; why: TreeExclusion };

/**
 * The one question this module asks about ownership: is the pane named by this
 * handle a CHARGED agent of ours?
 *
 * A boolean, deliberately. Everything this module knows is /proc; everything
 * the answer needs — the herdr census, the registry, and THE ownership test in
 * herdr.ts — lives in the daemon. Passing a callback keeps that separation
 * (and keeps this file testable without a herdr) while making the question
 * unavoidable: see {@link finishMeasurement}.
 */
export type AttributeTree = (paneHandle: string) => boolean;

/** One agent tree's cost over the window. */
export interface AgentTreeCost {
  /** The root agent-runtime process of the tree. */
  pid: number;
  /** Processes in the tree at the end of the window. */
  processes: number;
  /** utime+stime deltas over wall-clock seconds — cores, not load average. */
  cores: number;
  residentMb: number;
  /**
   * Whether this tree is in {@link AgentCostMeasurement.totals}. Every tree
   * seen is reported here, charged or not, so a report can say what it left
   * out — an exclusion nobody can see is indistinguishable from a machine
   * that was quiet.
   */
  ownership: TreeOwnership;
}

/**
 * A finished measurement. Field names and order match what the extraction
 * source's measurement script has always printed: {elapsed, loadStart,
 * loadEnd, agents, totals} — evidence produced before and after the port must
 * stay comparable.
 *
 * ONE OF THOSE FIELDS NO LONGER MEANS WHAT IT DID, AND SAYING SO IS THE POINT
 * OF THIS PARAGRAPH (KAN-338). `totals` counted every agent tree on the
 * machine; it now counts the CHARGED trees this daemon owns. A figure from
 * before that change and a figure from after it are the same shape and are not
 * the same quantity, so they are comparable only on a machine where the two
 * populations coincide. `seen` is what lets a reader tell which they are
 * holding.
 */
export interface AgentCostMeasurement {
  /** Wall-clock seconds actually elapsed between the two samples. */
  elapsed: number;
  loadStart: number;
  loadEnd: number;
  /** Per-tree figures, sorted by cores descending. EVERY tree, charged or not. */
  agents: AgentTreeCost[];
  /**
   * The charged sample — trees attributed to this daemon's chargeable agents,
   * and nothing else. This is what the divisor is computed from.
   */
  totals: {
    agents: number;
    cores: number;
    residentMb: number;
  };
  /**
   * The whole population the window saw, and what left it. `trees` is every
   * agent-runtime tree on the machine; the three counts are why the rest are
   * not in `totals`, and `trees === totals.agents + foreign + noHandle +
   * handleUnreadable` always.
   *
   * Reported rather than merely counted because the interesting states are the
   * ones where the sample is small for a reason: `totals.agents: 0` beside
   * `foreign: 7` is a healthy daemon on somebody else's busy machine, and
   * beside `handleUnreadable: 7` it is an instrument that cannot see.
   */
  seen: {
    trees: number;
    foreign: number;
    noHandle: number;
    handleUnreadable: number;
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

/**
 * The pane handle a process is carrying, or why there is none.
 *
 * ONLY ONE VARIABLE IS EVER TAKEN OUT OF THAT FILE, and that is a rule rather
 * than an implementation detail: `/proc/<pid>/environ` is the single richest
 * source of credentials on the machine, and a daemon that lifts the whole
 * block into memory to search it is one bad log line from writing somebody's
 * API token to disk. The handle is extracted and everything else is dropped on
 * the floor unparsed; nothing here returns, stores or logs any other entry.
 *
 * `unreadable` is a THIRD outcome and not a variant of "no handle", for the
 * same reason `Occupancy` (herdr.ts) splits absent from unverifiable: an
 * `EACCES` — a process belonging to another user — and a process that genuinely
 * has no handle are different facts, and only one of them says something about
 * the machine's configuration. An exited process lands here too: between the
 * sample and this read is a real window, and it is ordinary rather than an
 * error.
 */
export function paneHandleOf(pid: number): { handle: string | null; unreadable: boolean } {
  let raw: string;
  try {
    // latin1: environ is bytes, not necessarily UTF-8, and a lone invalid byte
    // must not corrupt the entry we are looking for.
    raw = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return { handle: null, unreadable: true };
  }
  const prefix = `${PANE_HANDLE_VAR}=`;
  for (const entry of raw.split('\0')) {
    if (!entry.startsWith(prefix)) continue;
    const value = entry.slice(prefix.length);
    // An empty assignment is not a handle. It would resolve to nothing at the
    // far end anyway; refusing it here keeps the empty string out of a herdr
    // argv.
    return { handle: value.length > 0 ? value : null, unreadable: false };
  }
  return { handle: null, unreadable: false };
}

/**
 * Which sample one tree belongs in.
 *
 * Split out so the decision is one readable table rather than three branches
 * threaded through the accounting loop, and so a proof can drive every arm of
 * it without a /proc at all.
 */
function ownershipOf(
  handle: { handle: string | null; unreadable: boolean },
  attribute: AttributeTree
): TreeOwnership {
  if (handle.unreadable) return { charged: false, why: 'handle-unreadable' };
  if (handle.handle === null) return { charged: false, why: 'no-handle' };
  return attribute(handle.handle)
    ? { charged: true, paneHandle: handle.handle }
    : { charged: false, why: 'foreign' };
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
 *
 * `attribute` IS REQUIRED, AND THAT IS THE FIX RATHER THAN A PARAMETER
 * (KAN-338). The defect this closes was not a wrong number — it was that the
 * right number could not be asked for: `totals` summed every agent tree on the
 * machine, and no caller had any way to say which of them were its own. A
 * later author can delete an assertion; they cannot call this function without
 * answering the ownership question, because there is no overload that omits
 * it. The unattributed divisor is now unrepresentable rather than merely
 * discouraged.
 *
 * Every tree still appears in `agents` — excluding a tree from the SAMPLE and
 * hiding it from the REPORT are different things, and only the first is
 * wanted.
 */
export function finishMeasurement(
  start: MeasurementStart,
  attribute: AttributeTree
): AgentCostMeasurement {
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
      residentMb: rss / (1024 * 1024),
      // The ROOT's handle, not any descendant's. The variable is inherited, so
      // every process in the pane carries it and any of them would answer —
      // but the root is the process the group is keyed on and the only one
      // guaranteed to still be there, so it is the one asked. One environ read
      // per tree, not per process.
      ownership: ownershipOf(paneHandleOf(root), attribute)
    });
  }
  agents.sort((a, b) => b.cores - a.cores);

  const charged = agents.filter((a) => a.ownership.charged);
  const totals = {
    agents: charged.length,
    cores: charged.reduce((s, a) => s + a.cores, 0),
    residentMb: charged.reduce((s, a) => s + a.residentMb, 0)
  };
  const excluded = (why: TreeExclusion) =>
    agents.filter((a) => !a.ownership.charged && a.ownership.why === why).length;

  return {
    elapsed,
    loadStart: start.loadStart,
    loadEnd,
    agents,
    totals,
    seen: {
      trees: agents.length,
      foreign: excluded('foreign'),
      noHandle: excluded('no-handle'),
      handleUnreadable: excluded('handle-unreadable')
    }
  };
}

/**
 * Measure over a window of `seconds`. Convenience over start/finish for a
 * caller that just wants one figure and can afford to wait in place.
 */
export async function measureAgentCost(
  seconds: number,
  attribute: AttributeTree
): Promise<AgentCostMeasurement> {
  const start = startMeasurement();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return finishMeasurement(start, attribute);
}
