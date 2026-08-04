import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './types.js';

/**
 * The durable record of which agents exist, and which of them should be
 * running.
 *
 * WHY THIS IS A FILE AND NOT A FIELD
 *
 * Everything else that knows about an agent dies with the machine. The session
 * map dies with the daemon; herdr's panes die with herdr; a fleet client's
 * view dies with the client. A power cut takes all three at once, and in the
 * extraction source's KAN-21 it did: two agents that had been working for
 * ninety seconds simply ceased to exist, and nothing anywhere had written down
 * that they ever had. Boot-time restoration needs an answer to "what was
 * running?" that predates the outage, and only the filesystem can hold one.
 *
 * IT NOW HOLDS MORE THAN THAT, AND HAS TO
 *
 * Under the type model, an agent's priority, prompt, launcher and gate flag
 * were looked up from config at every use, so the log only had to remember an
 * activation's arguments. Types are deleted; there is nothing left to look up.
 * So the log carries the whole {@link AgentConfig} on every row, and it is the
 * only place those values exist. That is what makes `configure` mandatory and
 * what makes the compaction rule below load-bearing rather than tidy.
 *
 * WHY APPEND-ONLY JSONL RATHER THAN A STATE BLOB
 *
 * A power cut gives no shutdown hook, so "save on exit" saves nothing. Every
 * write here therefore happens *at the moment the lifecycle event happens* and
 * is fsync'd before the caller is told the operation succeeded — the ordering
 * that makes "the daemon said yes" and "the disk knows" the same fact.
 *
 * Two crash-safe shapes were available: atomically replace a whole-state file
 * (temp + rename), or append single records. Appending wins here because the
 * unit of change *is* a single record — one activation, one deactivation — so
 * a rewrite of the whole state per event would be work proportional to the
 * fleet for a change of size one. The cost of appending is that the tail can be
 * torn: a machine that loses power mid-`write` leaves a partial final line.
 * That is handled by construction — {@link AgentRegistry.readLog} drops an
 * unparseable last line and keeps every complete record before it. A torn tail
 * can lose at most the one event that was in flight, and never corrupts an
 * earlier one.
 *
 * INTENT, NOT HISTORY
 *
 * The log is a history, but the question asked of it is not "what happened?",
 * it is "what exists, and what should be running now?". {@link
 * AgentRegistry.intents} answers that by keeping only the last event per path:
 * `configured` means it exists and is not running, `activated` means restore
 * it, `deactivated` means leave it down, and `forgotten` means it is gone. An
 * agent that a human deliberately stood down before the outage must not come
 * back, and that is the whole of the rule that keeps it down.
 */

/**
 * Where the registry lives: one file, next to the socket and the daemon log.
 * A function of the data directory rather than a constant, because the data
 * directory comes from `crabcast.config.json` rather than from an install
 * location.
 */
export function registryPathFor(dataDir: string): string {
  return path.join(dataDir, 'agents.jsonl');
}

/**
 * The on-disk format this daemon writes and is willing to read.
 *
 * PER ROW, NOT A FILE HEADER, and the reasoning is worth keeping because a
 * header is the cheaper-looking option (one write instead of one field per
 * line):
 *
 *  1. **Appends have nowhere to put a header.** Every write here is
 *     `openSync(file, 'a')` — O_APPEND, chosen so two daemons interleave whole
 *     lines rather than overwriting each other. There is no seek-to-front in
 *     that mode, so a header could only be written by whoever created the
 *     file, and a log whose first line was lost (a truncation, a hand-edit, a
 *     `tail -n +2` somebody ran while debugging) would then read as
 *     unversioned in its entirety.
 *  2. **Concatenation stays honest.** Two logs joined — a restored backup, a
 *     hand-merge of the two remedies below — carry each row's own version. A
 *     header would claim the first file's version over the second file's rows.
 *  3. **Compaction rewrites rows, not files.** {@link AgentRegistry.compact}
 *     emits one row per agent worth remembering; per-row marking survives that
 *     with no extra step, while a header would have to be re-emitted by a
 *     function whose whole job is dropping rows.
 *
 * The cost is about fifteen bytes per line on a file that compacts at 500
 * records. That is not a trade worth thinking about twice.
 */
export const LOG_VERSION = 1;

/**
 * Records past which the log is compacted. High enough that ordinary use never
 * triggers it, low enough that a pathological activate/deactivate loop cannot
 * grow the file without bound.
 */
const COMPACT_AFTER_RECORDS = 500;

export type AgentEvent = 'configured' | 'activated' | 'deactivated' | 'forgotten';

const AGENT_EVENTS: AgentEvent[] = ['configured', 'activated', 'deactivated', 'forgotten'];

/**
 * Everything needed to bring an agent back without asking anyone: the
 * directory it is, and the knobs a caller froze onto it.
 */
export interface AgentRecord {
  /** The canonical real path. This is the identity; nothing else is. */
  path: string;
  /** The whole of `configure`'s argument list, verbatim. */
  config: AgentConfig;
}

/**
 * WHAT IS DELIBERATELY NOT ON THIS RECORD: `paneId`.
 *
 * An earlier revision persisted the herdr pane an agent was last confirmed in,
 * as the durable half of a three-fact ownership test. That was wrong in a way
 * worth leaving a note about, because the field is an obvious one to add back.
 *
 * herdr pane ids are POSITIONS IN A LIST THAT COMPACTS whenever any pane
 * anywhere closes — this repository documents that itself, in
 * `HerdrBridge.closeTabPlaceholder`, which re-resolves by terminal id for
 * exactly that reason. Persisting one and comparing it against a later census
 * therefore answers "is this pane ours" with NO about our own live agent as
 * soon as an unrelated agent two tabs over finishes. Under refuse-on-occupied
 * that is not a cosmetic wrong answer: `activate` reports our own agent as a
 * foreign occupant and refuses to start it, permanently.
 *
 * Measured rather than deduced: activating two agents and deactivating the
 * first renumbered the second's pane from `…-12` to `…-11` on herdr 0.6.4.
 *
 * A volatile value has no business in durable storage. Ownership is decided by
 * `ourPaneIn` (herdr.ts) from the pane NAME, which is forward-computed from
 * the path and fixed for the life of the pane; every pane id this daemon
 * reports is read live from the census that produced it.
 */

/**
 * Why a stand-down happened, when it happened *to* an agent rather than
 * because its work was done. The shape is declared in priority.ts — the
 * capacity gate is what builds one — and re-exported here because this file
 * is where it becomes durable.
 *
 * The extraction source's KAN-37 asked the sharpest question this registry has
 * faced: a preempted agent must be recorded either so the next boot resurrects
 * it, or so it does not. The answer is `deactivated` — reconciliation restores
 * the whole expected fleet at once and does so with `override: true`, so
 * recording a preempted agent as still-expected would bring back both it *and*
 * the agent that took its slot, past a gate that has been told not to argue,
 * on a machine that has just demonstrated it cannot hold both. A human's
 * deliberate choice about which work matters more must not be overturned by a
 * restart.
 *
 * So the event stays `deactivated` and {@link AgentRegistry.intents} needs no
 * new rule. What the annotation adds is the half that "deactivated" throws
 * away: *why*.
 */
export type { PreemptionRecord } from './priority.js';
import type { PreemptionRecord } from './priority.js';

export interface AgentLogEntry extends AgentRecord {
  /** {@link LOG_VERSION}. Its absence is what makes a row pre-migration. */
  v: number;
  event: AgentEvent;
  /** ISO 8601, so a human reading the raw file can date every line. */
  at: string;
  /** Present only on a `deactivated` that was not the agent's own idea. */
  preemption?: PreemptionRecord;
  /**
   * Written only by compaction, on a stand-down whose {@link preemption}
   * annotation it dropped. The annotation is a debt — who took the slot, at
   * what priority, with what derivation — and compaction is allowed to forget
   * it (see {@link AgentRegistry.preempted}). *How the agent stopped* is not a
   * debt, it is a fact about the work, and a carried row without this marker
   * gets reported as one somebody switched off on purpose. Nobody did.
   */
  wasPreempted?: boolean;
  /**
   * Whether CrabCast has ever actually RUN an agent at this path.
   *
   * Derived in {@link AgentRegistry.intents} by looking for any `activated`
   * event, and written onto rows by {@link AgentRegistry.compact} for the same
   * reason `wasPreempted` is: compaction keeps one row per agent, so the
   * earlier `activated` rows a `deactivated`-last or `configured`-last agent
   * was carrying disappear, and with them the fact that it ever ran.
   *
   * IT IS A SAFETY FACT, NOT A STATISTIC. It is what the resume rule (resume.ts)
   * is gated on: a path CrabCast has never run in may hold a HUMAN'S Claude Code
   * transcripts, and resuming those into an agent pane hands somebody's private
   * session to an agent. Losing this marker to compaction would fail in the safe
   * direction — an agent starting fresh instead of resuming — which is exactly
   * why it would go unnoticed until somebody wondered where their conversation
   * went.
   */
  everActivated?: boolean;
}

/** The last thing said about one agent. */
export interface AgentIntent {
  event: AgentEvent;
  record: AgentRecord;
  at: string;
  preemption?: PreemptionRecord;
  /** See {@link AgentLogEntry.wasPreempted}. */
  wasPreempted?: boolean;
  /** See {@link AgentLogEntry.everActivated}. The resume rule's input. */
  everActivated?: boolean;
}

/** An agent that was stood down to make room, and has not come back. */
export interface PreemptedAgent {
  path: string;
  record: AgentRecord;
  at: string;
  preemption: PreemptionRecord;
}

/**
 * Whether one append reached the disk. `ok: false` means the lifecycle event
 * happened and the registry does not know it — the caller must say so, not
 * swallow it.
 */
export interface RecordOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Write every byte, or say which ones did not go.
 *
 * `fs.writeSync` returns how much it wrote, and it is under no obligation for
 * that to be everything — a full disk, a quota boundary or a signal can stop
 * it part way. Both write paths here discarded that number, which made a short
 * write indistinguishable from a complete one: the append path would fsync and
 * report success over half a record (recoverable, since {@link
 * AgentRegistry.readLog} skips a line it cannot parse — but recoverable by
 * losing the event, silently), and the compaction path would rename a
 * truncated file over the whole log, which is the append-only design's one
 * unrecoverable move.
 *
 * So: loop on the count, and throw when no progress is possible. The throw
 * lands in each caller's existing catch — and the two callers answer for it
 * differently, because the two failures are not the same failure:
 *
 * - {@link AgentRegistry.record} returns `ok: false`, which the router turns
 *   into `durable: false` on the response and a `registry_degraded_event`. A
 *   lifecycle event happened and the disk does not know it: somebody has to
 *   act on that, so somebody is told.
 * - {@link AgentRegistry.compact} returns `ok: false` and is logged. Nothing
 *   is lost — the rename is the only destructive step and it is the last one,
 *   so the previous log survives whole — and the record whose append triggered
 *   the compaction is already fsync'd and durable. Reporting `durable: false`
 *   there would be a *different* untruth: it would tell the caller its
 *   activation might not survive a restart when it certainly will. What is
 *   degraded is housekeeping, and the log says so with its consequence.
 */
function writeFully(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      throw new Error(
        `short write: ${offset} of ${buf.length} bytes reached the file before it stopped accepting them`
      );
    }
    offset += written;
  }
}

function isAgentConfig(value: any): value is AgentConfig {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.priority === 'number' &&
    Number.isFinite(value.priority) &&
    typeof value.launcher === 'string' &&
    value.launcher.length > 0 &&
    typeof value.refusable === 'boolean' &&
    typeof value.chargeable === 'boolean' &&
    typeof value.preemptable === 'boolean'
  );
}

/**
 * Whether a parsed line is a row this daemon can act on.
 *
 * DELIBERATELY SILENT about what it rejects, and that silence is why the
 * version check lives somewhere else (see {@link scanLogVersions}). This
 * predicate exists for torn-tail tolerance: a half-written line is a line that
 * says nothing, and dropping it without comment is correct for its own job.
 * Making it loud would fight the tolerance it exists for — and a pre-migration
 * row is not a torn line, it is a whole file this daemon must not half-read.
 */
function isUsableEntry(value: any): value is AgentLogEntry {
  return (
    value &&
    AGENT_EVENTS.includes(value.event) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    // A `forgotten` row's only job is to erase; it needs no config to do it,
    // and requiring one would let a config-less tombstone resurrect an agent.
    (value.event === 'forgotten' || isAgentConfig(value.config))
  );
}

/** What {@link scanLogVersions} found, in the shape the boot refusal prints. */
export interface LogVersionScan {
  file: string;
  /** Lines that parsed as JSON objects. Torn and blank lines are not counted. */
  rows: number;
  /** Rows carrying no `v`, or an OLDER `v` — written before agents had paths. */
  preMigration: number;
  /** Rows carrying a `v` from a NEWER daemon than this one. */
  fromNewer: number;
  /**
   * Rows this daemon's own format claims, and that {@link AgentRegistry.readLog}
   * would nonetheless drop.
   *
   * These are the hand-edit casualties. The refusal prints "hand-edit the
   * file" as a supported remedy, and an operator following it who omits one of
   * the required `config` fields produces a row that passes a version check
   * and fails `isUsableEntry` — which drops it SILENTLY, on purpose, for
   * torn-tail tolerance. The daemon would then start clean and report a fleet
   * with a hole in it, through the recovery procedure it recommended itself.
   */
  unusable: number;
  /** A few offending rows, identified however they identify themselves. */
  samples: string[];
}

/** How many pre-migration rows the refusal names before it says "and N more". */
const VERSION_SCAN_SAMPLES = 3;

/**
 * Count rows this daemon's format does not cover, WITHOUT loading any of them.
 *
 * THE PLACEMENT IS THE DESIGN. This runs at boot, outside {@link
 * AgentRegistry.readLog}, and never inside `isUsableEntry`'s filter.
 *
 * Tightening that filter instead would have been the obvious move and would
 * have produced the exact failure this daemon exists to remove. Pre-migration
 * rows carry `type`/`key`/`workDir` and no `path`, so the filter would drop
 * every one of them silently — `readLog` → `[]`, `intents()` → empty,
 * `expected()` → empty, and reconcile printing "the agent registry records no
 * agents that should be running", which is indistinguishable from a healthy
 * empty fleet. That is a silent fleet loss reached through an existing code
 * path rather than a hypothetical one.
 *
 * WHY REFUSE RATHER THAN MIGRATE. `path` derives cleanly from the old
 * `workDir`. `priority`, the three gate flags and `prompt` lived in the
 * deleted `workspaceTypes` and have nowhere to come from — so a derived row
 * would be a *configured* agent missing three of `configure`'s required
 * parameters, which the API could not have produced. Restoring it means
 * fabricating those values or skipping the row, and this codebase already
 * ruled against defaulting exactly these: the config loader refused a missing
 * priority rather than flooring it, precisely because a silently-floored
 * priority is preemptable by everything and nobody finds out until the work is
 * destroyed. A `migrate-log` tool would recover `path`, sometimes `launcher`,
 * and would have to ask a human for the other three anyway — a tool that
 * cannot finish its own job.
 */
export function scanLogVersions(file: string): LogVersionScan {
  const scan: LogVersionScan = {
    file, rows: 0, preMigration: 0, fromNewer: 0, unusable: 0, samples: []
  };

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No file is the ordinary state on a fresh install, and an unreadable one
    // is readLog's problem to report — this scan must not turn either into a
    // refusal to boot.
    return scan;
  }

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A torn tail, or a line nothing here wrote. Not evidence of a version.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    scan.rows++;

    let problem: 'pre-migration' | 'newer' | 'unusable' | null = null;
    if (typeof parsed.v === 'number' && parsed.v > LOG_VERSION) {
      problem = 'newer';
      scan.fromNewer++;
    } else if (parsed.v !== LOG_VERSION) {
      problem = 'pre-migration';
      scan.preMigration++;
    } else if (!isUsableEntry(parsed)) {
      // Versioned as ours and still unreadable: the hand-edit case. Checked
      // against the SAME predicate readLog applies, because a boot gate that
      // validated less than the loader would let exactly the rows the loader
      // silently drops through the gate that exists to catch them.
      problem = 'unusable';
      scan.unusable++;
    }
    if (problem === null) continue;

    if (scan.samples.length < VERSION_SCAN_SAMPLES) {
      // Identified in whatever vocabulary the row itself uses: an old row says
      // `type`/`key`, and quoting it back is what lets a human find the line.
      const who =
        typeof parsed.agentName === 'string'
          ? parsed.agentName
          : typeof parsed.type === 'string' && typeof parsed.key === 'string'
            ? `${parsed.type}/${parsed.key}`
            : typeof parsed.path === 'string'
              ? parsed.path
              : '(unidentifiable row)';
      scan.samples.push(
        `${who} — ${parsed.event ?? 'no event'} at ${parsed.at ?? 'no timestamp'} (${problem})`
      );
    }
  }

  return scan;
}

/**
 * What the daemon prints instead of starting, when the log holds rows it
 * cannot fully understand.
 *
 * Names the file, the count and the two supported remedies. No partial load is
 * offered, because a partial load is the ghost-row outcome: some agents
 * restored, some silently absent, and no line anywhere saying which.
 */
export function describeUnreadableLog(scan: LogVersionScan): string {
  const bad = scan.preMigration + scan.fromNewer + scan.unusable;
  const parts: string[] = [
    `refusing to start: ${bad} of ${scan.rows} record(s) in the agent registry cannot be ` +
      `read by this daemon.`,
    `  registry: ${scan.file}`,
    ...scan.samples.map((line) => `    ${line}`),
    ...(bad > scan.samples.length ? [`    …and ${bad - scan.samples.length} more`] : []),
    ``
  ];

  // Three different problems with three different remedies. Saying
  // "unreadable" over all of them would send an operator to the wrong fix.
  if (scan.preMigration > 0) {
    parts.push(
      `${scan.preMigration} row(s) were written by a CrabCast that addressed agents by`,
      `<type>/<key>. Their \`workDir\` gives the path, but \`priority\`, the gate flags and`,
      `\`prompt\` came from the \`workspaceTypes\` config that no longer exists — so a converted`,
      `row would be a configured agent missing three required \`configure\` parameters, which`,
      `this API could not have produced. Inventing them is the one thing this daemon refuses`,
      `to do about a value nobody decided.`,
      ``
    );
  }
  if (scan.fromNewer > 0) {
    parts.push(
      `${scan.fromNewer} row(s) carry a format version NEWER than this daemon writes (this`,
      `daemon is at v${LOG_VERSION}). They were not written by an older CrabCast — they were`,
      `written by a newer one, and downgrading is what put you here. Run the newer daemon`,
      `against this data directory, or start from an empty log.`,
      ``
    );
  }
  if (scan.unusable > 0) {
    parts.push(
      `${scan.unusable} row(s) are version v${LOG_VERSION} and still unreadable: a row needs a`,
      `non-empty "path" and a "config" carrying a finite "priority", a non-empty "launcher"`,
      `and all three of "refusable", "chargeable" and "preemptable" as booleans. This is`,
      `almost always a hand-edit that dropped a field. It is caught HERE rather than at load`,
      `because the loader drops such rows silently and on purpose — that silence is what`,
      `makes a torn tail survivable — so an unnoticed hand-edit would otherwise come back as`,
      `a fleet with a hole in it and nothing anywhere saying so.`,
      ``
    );
  }

  parts.push(
    `Loading the file part-way is not offered: the agents in those rows would simply not`,
    `exist, and nothing would say so.`,
    ``,
    `Two remedies, both supported:`,
    `  1. Delete ${scan.file} and \`configure\` the fleet again. This is the right answer`,
    `     for every real deployment — the caller holds the desired state, and one`,
    `     reconciler pass re-creates every record.`,
    `  2. Hand-edit the file: each row needs "v": ${LOG_VERSION}, a "path" (the old`,
    `     "workDir"), and a "config" object carrying priority, launcher, refusable,`,
    `     chargeable and preemptable — the values you would pass to \`configure\`. Re-run the`,
    `     daemon afterwards: it validates every row against the same predicate the loader`,
    `     uses, so a field you miss is refused here rather than dropped later.`,
    ``,
    `There is deliberately no \`migrate-log\` command: it could recover the path and`,
    `sometimes the launcher, and would have to ask you for the rest regardless.`
  );

  return parts.join('\n');
}

export class AgentRegistry {
  constructor(private readonly file: string) {}

  /** The log file this registry reads and writes. */
  public get path(): string {
    return this.file;
  }

  /** The directory the log lives in, created on demand before any write. */
  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  /**
   * Append one event and make it durable before returning.
   *
   * `fsync` is the point of this function. Without it the record sits in the
   * page cache, where a `write()` that has already returned is still lost to a
   * power cut — which is precisely the failure being defended against, so the
   * cost of the syscall is the feature. `openSync('a')` gives O_APPEND, so
   * concurrent writers (a second daemon losing the socket race, say) interleave
   * whole lines rather than overwriting each other.
   *
   * Never throws — a registry that cannot be written is a degraded restore,
   * not a reason to fail the operation the caller is in the middle of — but
   * it *answers*. A swallowed failure here is KAN-21 re-entering through the
   * error path: the agent exists, the disk does not know, and nothing outside
   * the daemon log can observe it. The caller surfaces `ok: false` (a
   * `durable: false` on its response, a degraded-registry broadcast) so the
   * gap is somebody's to act on rather than nobody's.
   */
  public record(
    event: AgentEvent,
    record: AgentRecord,
    preemption?: PreemptionRecord
  ): RecordOutcome {
    const entry: AgentLogEntry = {
      v: LOG_VERSION,
      ...record,
      event,
      at: new Date().toISOString(),
      ...(preemption ? { preemption } : {})
    };

    let fd: number | undefined;
    try {
      this.ensureDir();
      fd = fs.openSync(this.file, 'a', 0o600);
      writeFully(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } catch (e: any) {
      const error = `Could not record ${event} for ${record.path}: ${e?.message ?? String(e)}`;
      console.error(`[AgentRegistry] ${error}`);
      return { ok: false, error };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    this.compactIfLarge();
    return { ok: true };
  }

  public recordConfigured(record: AgentRecord): RecordOutcome {
    return this.record('configured', record);
  }

  public recordActivated(record: AgentRecord): RecordOutcome {
    return this.record('activated', record);
  }

  public recordDeactivated(record: AgentRecord, preemption?: PreemptionRecord): RecordOutcome {
    return this.record('deactivated', record, preemption);
  }

  public recordForgotten(record: AgentRecord): RecordOutcome {
    return this.record('forgotten', record);
  }

  /**
   * Every complete record in the log, oldest first.
   *
   * The torn-tail rule lives here and applies to *any* unparseable line, not
   * only the last one: a line that cannot be read is a line that says nothing,
   * and skipping it is strictly better than refusing to read the file. Only a
   * bad final line is expected (that is what a power cut produces), so anything
   * earlier is logged — it would mean something worse than a crash.
   */
  public readLog(): AgentLogEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      // No file yet is the ordinary state on a fresh install.
      if (e?.code !== 'ENOENT') {
        console.error(`[AgentRegistry] Could not read ${this.file}: ${e?.message ?? String(e)}`);
      }
      return [];
    }

    const lines = text.split('\n');
    const entries: AgentLogEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        // The final line is the one a power cut can tear. Anything earlier is
        // unexpected and worth saying out loud, but is still skipped rather
        // than allowed to discard the records around it.
        if (i < lines.length - 1) {
          console.error(`[AgentRegistry] Skipping unparseable record at line ${i + 1}`);
        }
        continue;
      }

      if (isUsableEntry(parsed)) entries.push(parsed);
    }

    return entries;
  }

  /**
   * The last word on each agent — what the fleet is *meant* to look like.
   * Later records overwrite earlier ones, so this is a reduction of the log to
   * one intent per path.
   *
   * `forgotten` is the one event that removes rather than replaces. Its whole
   * job is that the agent stops existing, and leaving a `forgotten` intent in
   * the map would make every consumer here write the same `event !== 'forgotten'`
   * guard — one of which would eventually be missed.
   */
  public intents(): Map<string, AgentIntent> {
    const intents = new Map<string, AgentIntent>();
    for (const entry of this.readLog()) {
      if (entry.event === 'forgotten') {
        intents.delete(entry.path);
        continue;
      }
      // `v`, `preemption`, `wasPreempted` and `everActivated` are pulled out
      // rather than left in the rest: `record` is what a later activation is
      // rebuilt from, and it must not carry the reason a previous stand-down
      // happened — nor a marker about it, which would then travel into the
      // record of an agent somebody simply switched back on. `v` is the file's
      // business, not the record's.
      const { v, event, at, preemption, wasPreempted, everActivated, ...record } = entry;
      // ONE PASS, NO EXTRA READ. An `activated` row is self-evident; anything
      // later carries the fact forward from the intent it is replacing, and a
      // row written by compaction carries it explicitly. `forgotten` clears it
      // with the rest of the agent, which is right: forgetting is the caller
      // saying this agent no longer exists, and a path re-configured afterwards
      // starts from no history — deliberately the safe direction, since the
      // alternative is inheriting a claim on a conversation from an agent
      // somebody deleted.
      const ran =
        event === 'activated' ||
        everActivated === true ||
        intents.get(entry.path)?.everActivated === true;
      intents.set(entry.path, {
        event,
        at,
        record,
        ...(preemption ? { preemption } : {}),
        ...(wasPreempted ? { wasPreempted: true } : {}),
        ...(ran ? { everActivated: true } : {})
      });
    }
    return intents;
  }

  /**
   * Whether CrabCast has ever run an agent at this path — THE RESUME RULE'S
   * input, and the only question that decides whether a conversation on disk
   * there may be continued. See resume.ts, and {@link AgentLogEntry.everActivated}.
   */
  public ranBefore(agentPath: string): boolean {
    return this.intents().get(agentPath)?.everActivated === true;
  }

  /** The record for one path, or undefined when no agent is configured there. */
  public recordFor(agentPath: string): AgentIntent | undefined {
    return this.intents().get(agentPath);
  }

  /**
   * Agents that were stood down to make room and have not been brought back.
   *
   * Derived from {@link intents}, so it empties itself: the moment a preempted
   * agent is re-activated its last event is `activated` again and it leaves this
   * list. That is what makes it safe to report on every `list_agents` poll — it
   * is a queue of decisions still owed, not a log of things that happened.
   *
   * It does not survive compaction, which drops the preemption annotation from
   * every record it carries. That is deliberate rather than overlooked: this is
   * a live signal about work waiting to be re-staffed, and compaction only
   * happens after 500 records, by which time a preemption nobody acted on is
   * not news. (The stand-down itself is a different question, decided the other
   * way — see {@link AgentRegistry.standbyToPreserve}.)
   */
  public preempted(): PreemptedAgent[] {
    return AgentRegistry.preemptedFrom(this.intents());
  }

  /**
   * {@link preempted}, from an intent map the caller already has.
   *
   * Reading the log is a whole-file read and parse, and one `list_agents` poll
   * asks four different questions of the same answer (missing, preempted,
   * standby, and the priority list). Doing that as four reads meant four passes
   * over the file per poll on a client that polls continuously — and, worse,
   * four *different* reads: an append landing between them produced one
   * response whose categories disagreed with each other about the same agent.
   * One read per poll fixes both.
   */
  public static preemptedFrom(intents: Map<string, AgentIntent>): PreemptedAgent[] {
    const out: PreemptedAgent[] = [];
    for (const [agentPath, intent] of intents) {
      if (intent.event !== 'deactivated' || !intent.preemption) continue;
      out.push({ path: agentPath, record: intent.record, at: intent.at, preemption: intent.preemption });
    }
    return out;
  }

  /**
   * Whether this agent's last stand-down was a preemption — i.e. whether
   * re-activating it is resuming interrupted work rather than starting it.
   *
   * This is what turns a re-activation into a resume, so a preempted agent
   * comes back with the interrupted-work framing instead of sitting at a
   * restored-but-silent prompt.
   */
  public preemptionFor(agentPath: string): PreemptionRecord | undefined {
    const intent = this.intents().get(agentPath);
    return intent?.event === 'deactivated' ? intent.preemption : undefined;
  }

  /**
   * Whether this agent's last stand-down was a preemption AT ALL — including
   * after compaction has dropped the annotation naming who took the slot.
   *
   * This is the question the resume path must ask, and asking
   * {@link preemptionFor} instead was a live idle-forever bug. Compaction
   * deliberately forgets the *debt* and deliberately keeps the *fact* as
   * `wasPreempted` — the comment on {@link AgentLogEntry.wasPreempted} says
   * exactly that: "How the agent stopped is not a debt, it is a fact about the
   * work."
   *
   * But `resumeCauseFor` read only the annotation. So a preempted agent that
   * had been through a compaction came back with NO resume cause: Claude Code
   * restored its whole conversation, the nudge never fired because nothing
   * thought this was a resume, and it sat at an empty prompt with all of its
   * memory and no turn to take. That is the KAN-21 idle-forever failure,
   * reached through the one path that was supposed to have been made safe —
   * and `standbyAgents` was meanwhile telling the reader that switching it on
   * "resumes the conversation it was stopped in."
   *
   * The debt may be forgotten. That the work was interrupted may not.
   */
  public stoppedByPreemption(agentPath: string): boolean {
    const intent = this.intents().get(agentPath);
    if (intent?.event !== 'deactivated') return false;
    return intent.preemption !== undefined || intent.wasPreempted === true;
  }

  /**
   * The agents that should be running: those whose last event was `activated`.
   * This is the input to boot-time reconciliation and to the missing-agent
   * sweep, and both must read the same list or they would disagree about what
   * "missing" means.
   *
   * A `configured`-but-never-activated agent is correctly absent: it exists,
   * and nobody has asked for it to run.
   */
  public expected(): AgentRecord[] {
    return Array.from(this.intents().values())
      .filter((intent) => intent.event === 'activated')
      .map((intent) => intent.record);
  }

  /**
   * The expected agents compaction carries across, each with the `at` of the
   * activation that put it there rather than the time of the compaction. See
   * {@link compact} for why that timestamp is load-bearing.
   */
  private activatedToPreserve(): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of this.intents().values()) {
      if (intent.event !== 'activated') continue;
      // `everActivated` is redundant on an `activated` row — the event itself
      // says it — and is written anyway so every carried row states the fact
      // the same way. A reader that had to know which events imply it is a
      // reader that will eventually get one of them wrong.
      out.push({
        v: LOG_VERSION,
        ...intent.record,
        event: 'activated',
        at: intent.at,
        everActivated: true
      });
    }
    return out;
  }

  /**
   * The configured-but-never-run agents compaction carries across.
   *
   * WHY THIS EXISTS, and the general rule it is the first instance of.
   *
   * `compact()` preserves an allowlist: whatever a preserve set does not name
   * is dropped when the log is rewritten. Before `configure` existed the
   * allowlist was `activated` plus `deactivated`, which happened to be every
   * terminal state there was. The `configured` event broke that silently — a
   * `configured`-last row matched neither set, and since `configure` is
   * MANDATORY (there is no other way for an agent's priority, launcher and
   * gate flags to exist), compaction at 500 records would have made a
   * perfectly good agent STOP EXISTING. Not stop running: stop existing, with
   * no row anywhere saying it ever had.
   *
   * So, stated once for whoever adds the next event:
   *
   *   **Compaction's preserve set is an allowlist. Every new terminal event
   *   state must be added to it explicitly, or it is silently dropped.**
   *
   * Unbounded on purpose, unlike {@link standbyToPreserve}: a standby row is a
   * control offering a way back to work that still exists, and an old one is
   * history rather than a control. A `configured` row is the agent. Clipping it
   * would delete agents.
   */
  private configuredToPreserve(): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of this.intents().values()) {
      if (intent.event !== 'configured') continue;
      // A `configured`-last agent that HAS run before — activated, stood down,
      // then reconfigured — must not be turned into a never-run one by
      // compaction. That would silently re-arm the resume rule's protection
      // against an agent whose conversation genuinely is its own, and the agent
      // would come back with no memory and nobody would know why.
      out.push({
        v: LOG_VERSION,
        ...intent.record,
        event: 'configured',
        at: intent.at,
        ...(intent.everActivated ? { everActivated: true } : {})
      });
    }
    return out;
  }

  /**
   * The stood-down agents compaction carries across. ALL of them.
   *
   * WHY THIS CARRIES EVERYTHING NOW, which is a correction rather than a
   * preference.
   *
   * Compaction originally rewrote the log as one `activated` record per
   * expected agent and nothing else, which silently emptied the standby list.
   * That was fixed by carrying stood-down rows — bounded two ways: only when
   * the directory still existed, and only the newest 100.
   *
   * BOTH BOUNDS WERE SAFE UNDER THE TYPE MODEL AND ARE NOT SAFE NOW. Then, a
   * dropped standby row cost the *route back*: the agent's priority, prompt
   * and launcher lived in `workspaceTypes`, so anyone could reconstruct the
   * activation from config. There is no config any more. A `deactivated`-last
   * row is matched by neither {@link configuredToPreserve} nor
   * {@link activatedToPreserve}, so it is that agent's ONLY record — and
   * dropping it does not cost the route back, it DELETES THE AGENT. A later
   * `activate(path)` then answers "no agent is configured" for a directory
   * whose work and conversation are still sitting on disk.
   *
   * That is the same defect as the `configured`-row one, in the branch next
   * door, and it was reachable at 101 stood-down agents rather than needing a
   * new event to introduce it.
   *
   * So: **compaction never drops an agent.** It drops HISTORY — superseded
   * rows — which is the whole of its job. The output is one row per agent that
   * exists, a bound proportional to the fleet rather than to how long the
   * daemon has been running, and the same bound the other two preserve sets
   * already had.
   *
   * The filesystem check went with the clip, deliberately: a directory can be
   * temporarily unmounted, and "your agent stopped existing because a mount
   * was slow" is not a trade anyone offered. Whether a stood-down agent is
   * OFFERED as a way back is a reporting question, and `standbyAgents`
   * (router.ts) still answers it with exactly that `existsSync` — which is
   * where a question about what to show a person belongs.
   */
  private standbyToPreserve(): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of this.intents().values()) {
      if (intent.event !== 'deactivated') continue;
      // A preempted agent is carried too, but as a plain stand-down: `record`
      // is the configuration with the annotation already pulled out by
      // intents(), so the debt stops being reported (the deliberate half — see
      // preempted()) while the route back to the work survives.
      out.push({
        v: LOG_VERSION,
        ...intent.record,
        event: 'deactivated',
        at: intent.at,
        // The annotation is dropped (see above); the *fact* is not. Without
        // this the carried row lands in `standbyAgents` wearing that list's
        // "switched off deliberately" reason, which is the opposite of what
        // happened to it — nobody chose to stop this agent, its slot was
        // taken. Dropping a debt is a decision; asserting a falsehood about
        // how work ended is not, and this is the difference.
        ...(intent.preemption || intent.wasPreempted ? { wasPreempted: true } : {}),
        // A stood-down agent has by definition run, so this is all but
        // guaranteed true — written from the intent rather than hardcoded so
        // there is exactly one derivation of it, in `intents()`.
        ...(intent.everActivated ? { everActivated: true } : {})
      });
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return out;
  }

  /**
   * Rewrite the log as one record per agent worth remembering: `configured`
   * for every agent that exists but has never run, `activated` for every
   * expected agent, and `deactivated` for the recent standby agents whose
   * directory still exists.
   *
   * Atomic, unlike the appends: a whole-file replacement has no torn-tail story
   * available to it, so it gets `write to temp → fsync temp → rename → fsync
   * the directory` instead. The rename is what makes it atomic; the directory
   * fsync is what makes the rename itself durable. Crashing anywhere in here
   * leaves the *old* log intact, which is a correct answer.
   *
   * EVERY CARRIED RECORD KEEPS ITS OWN `at`, and that is load-bearing rather
   * than tidy. Compaction used to stamp the carried `activated` records with
   * the time of the compaction, which quietly did three things: it told
   * `missingAgents` that an agent had been active "since" a housekeeping event
   * it had nothing to do with; it collapsed every expected agent onto one
   * identical timestamp; and — because the reporting path sorts newest-first
   * before it clips at 25 — it turned that sort into an all-ties comparison,
   * so the clip hid an *arbitrary* twenty-five rather than the oldest ones.
   * The ordering guarantee the clip is built on only exists if the timestamps
   * are real, and only the log knows them.
   */
  public compact(): RecordOutcome {
    const kept: AgentLogEntry[] = [
      ...this.configuredToPreserve(),
      ...this.activatedToPreserve(),
      ...this.standbyToPreserve()
    ];
    const body = kept.map((entry) => JSON.stringify(entry)).join('\n');

    const temp = `${this.file}.compact-${process.pid}`;
    let fd: number | undefined;
    let dir: number | undefined;
    try {
      this.ensureDir();
      fd = fs.openSync(temp, 'w', 0o600);
      writeFully(fd, kept.length ? body + '\n' : '');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(temp, this.file);

      dir = fs.openSync(path.dirname(this.file), 'r');
      fs.fsyncSync(dir);
    } catch (e: any) {
      const error = `Compaction failed: ${e?.message ?? String(e)}`;
      // Said with its consequence, because the consequence is the unusual
      // part: nothing was lost. The rename is the only destructive step and it
      // is the last one, so a failure anywhere leaves the previous log whole
      // and every record in it readable. What is degraded is housekeeping —
      // the file goes on growing — and that is worth a line in the log rather
      // than an alarm on somebody's activation.
      console.error(
        `[AgentRegistry] ${error}. The previous log is intact and no record was lost; ` +
        `the file will keep growing until this is fixed (usually disk space or permissions ` +
        `on ${path.dirname(this.file)}).`
      );
      try {
        fs.unlinkSync(temp);
      } catch {}
      return { ok: false, error };
    } finally {
      for (const handle of [fd, dir]) {
        if (handle !== undefined) {
          try {
            fs.closeSync(handle);
          } catch {}
        }
      }
    }
    return { ok: true };
  }

  /**
   * How many further records must accumulate before a compaction that failed
   * is attempted again.
   *
   * Without it, a data dir that cannot be written retries a doomed whole-file
   * rewrite on *every* activation from the 501st record onwards — the failure
   * mode is a full disk, and the response to a full disk should not be writing
   * more to it. Retried rather than abandoned because the condition is usually
   * temporary and nothing else would ever try again.
   */
  private retryCompactionAt: number | null = null;

  private compactIfLarge(): void {
    try {
      const size = this.readLog().length;
      if (size <= COMPACT_AFTER_RECORDS) return;
      if (this.retryCompactionAt !== null && size < this.retryCompactionAt) return;
      const outcome = this.compact();
      this.retryCompactionAt = outcome.ok ? null : size + COMPACT_AFTER_RECORDS;
    } catch {
      // Compaction is housekeeping; failing it must not fail an activation.
    }
  }
}
