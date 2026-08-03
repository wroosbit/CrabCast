import * as fs from 'fs';
import * as path from 'path';

/**
 * The durable record of which agents are *supposed* to exist.
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
 * WHY APPEND-ONLY JSONL RATHER THAN A STATE BLOB
 *
 * A power cut gives no shutdown hook, so "save on exit" saves nothing. Every
 * write here therefore happens *at the moment the lifecycle event happens* and
 * is fsync'd before the caller is told the activation succeeded — the ordering
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
 * it is "what should be running now?". {@link AgentRegistry.intents} answers
 * that by keeping only the last event per agent: `activated` means restore it,
 * `deactivated` means leave it down. An agent that a human deliberately stood
 * down before the outage must not come back, and that is the whole of the rule
 * that keeps it down.
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
 * Records past which the log is compacted. High enough that ordinary use never
 * triggers it, low enough that a pathological activate/deactivate loop cannot
 * grow the file without bound.
 */
const COMPACT_AFTER_RECORDS = 500;

/**
 * How many stood-down agents a compaction carries across. See
 * {@link AgentRegistry.standbyToPreserve} for why they are carried at all.
 *
 * Far enough below {@link COMPACT_AFTER_RECORDS} that a compacted log is still
 * a small fraction of the trigger: preserving records is only worth doing if
 * the next compaction is still hundreds of appends away, or compaction would
 * run on every write.
 */
const COMPACT_STANDBY_LIMIT = 100;

export type AgentEvent = 'activated' | 'deactivated';

/**
 * Everything needed to bring an agent back without asking anyone. This is the
 * argument list of an activation, frozen: type, key, where it works, which
 * launcher it runs, and which MCP servers it was given.
 */
export interface AgentRecord {
  agentName: string;
  type: string;
  key: string;
  workDir: string;
  /** The caller-supplied page metadata, when the activation carried any. */
  url?: string;
  /** Which launcher started it — `claude`, `shell`, … . */
  defaultAgent?: string;
  mcpServers?: string[];
}

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
 * away: *why*. It is the difference between a human flipping a switch off and
 * work being taken away from an agent that was in the middle of it, and it is
 * what lets `list_agents` keep reporting interrupted work until somebody
 * decides about it.
 */
export type { PreemptionRecord } from './priority.js';
import type { PreemptionRecord } from './priority.js';

export interface AgentLogEntry extends AgentRecord {
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
}

/** The last thing said about one agent. */
export interface AgentIntent {
  event: AgentEvent;
  record: AgentRecord;
  at: string;
  preemption?: PreemptionRecord;
  /** See {@link AgentLogEntry.wasPreempted}. */
  wasPreempted?: boolean;
}

/** An agent that was stood down to make room, and has not come back. */
export interface PreemptedAgent {
  agentName: string;
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

function isUsableEntry(value: any): value is AgentLogEntry {
  return (
    value &&
    (value.event === 'activated' || value.event === 'deactivated') &&
    typeof value.agentName === 'string' &&
    value.agentName.length > 0 &&
    typeof value.type === 'string' &&
    typeof value.key === 'string'
  );
}

export class AgentRegistry {
  constructor(private readonly file: string) {}

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
   * not a reason to fail the activation the caller is in the middle of — but
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
      const error = `Could not record ${event} for ${record.agentName}: ${e?.message ?? String(e)}`;
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

  public recordActivated(record: AgentRecord): RecordOutcome {
    return this.record('activated', record);
  }

  public recordDeactivated(record: AgentRecord, preemption?: PreemptionRecord): RecordOutcome {
    return this.record('deactivated', record, preemption);
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
   * one intent per agent.
   */
  public intents(): Map<string, AgentIntent> {
    const intents = new Map<string, AgentIntent>();
    for (const entry of this.readLog()) {
      // `preemption` and `wasPreempted` are pulled out rather than left in the
      // rest: `record` is the argument list of an activation, and a later
      // activate must not carry the reason a previous stand-down happened —
      // nor a marker about it, which would then travel into the activation
      // record of an agent somebody simply switched back on.
      const { event, at, preemption, wasPreempted, ...record } = entry;
      intents.set(entry.agentName, {
        event,
        at,
        record,
        ...(preemption ? { preemption } : {}),
        ...(wasPreempted ? { wasPreempted: true } : {})
      });
    }
    return intents;
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
   * way — see {@link AgentRegistry.standbyToPreserve}. A preempted agent whose
   * annotation is dropped is therefore carried across as a standby agent when
   * its workspace still exists: the debt stops being reported, the way back to
   * the work does not disappear. It keeps a bare {@link
   * AgentLogEntry.wasPreempted} so the row can still say how the work stopped
   * without claiming a decision nobody made.)
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
    for (const [agentName, intent] of intents) {
      if (intent.event !== 'deactivated' || !intent.preemption) continue;
      out.push({ agentName, record: intent.record, at: intent.at, preemption: intent.preemption });
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
  public preemptionFor(agentName: string): PreemptionRecord | undefined {
    const intent = this.intents().get(agentName);
    return intent?.event === 'deactivated' ? intent.preemption : undefined;
  }

  /**
   * The agents that should be running: those whose last event was `activated`.
   * This is the input to boot-time reconciliation and to the missing-agent
   * sweep, and both must read the same list or they would disagree about what
   * "missing" means.
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
    for (const [agentName, intent] of this.intents()) {
      if (intent.event !== 'activated') continue;
      out.push({ ...intent.record, agentName, event: 'activated', at: intent.at });
    }
    return out;
  }

  /**
   * The stood-down agents compaction carries across, newest first.
   *
   * WHY THIS EXISTS AT ALL — the decision, stated rather than defaulted
   *
   * Compaction used to rewrite the log as one `activated` record per expected
   * agent and nothing else, which silently emptied the standby list: every
   * agent a person had switched off stopped being reported the moment the
   * 501st record landed. That was never decided, it was what dropping
   * `deactivated` records happened to do — and the two things it throws away
   * are not the same size. A dropped *preemption annotation* costs a note
   * about a debt nobody acted on for 500 records, which is the deliberate
   * trade {@link preempted} documents. A dropped *standby* record costs the
   * only route back: the workspace is still on disk with a conversation in it,
   * the fleet client's On button is built from exactly this list, and once the
   * record is gone the agent can be restarted only by someone reconstructing
   * its activation by hand. Losing the way back to work that still exists is a
   * different class of loss from forgetting why work stopped.
   *
   * So standby records travel and preemption annotations still do not.
   *
   * Two bounds keep this from re-growing the file compaction exists to shrink.
   * A record is carried only when its workspace directory still exists — the
   * same test the reporting path applies, which is why a `reset` (it deletes
   * the directory) drops out here exactly as it does there. And
   * at most {@link COMPACT_STANDBY_LIMIT} of them are kept, newest first,
   * because "switch it back on" is a thing said about recent work; an agent
   * switched off two hundred stand-downs ago is history, not a control.
   */
  private standbyToPreserve(): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const [agentName, intent] of this.intents()) {
      if (intent.event !== 'deactivated') continue;
      // A preempted agent is carried too, but as a plain stand-down: `record`
      // is the activation's argument list with the annotation already pulled
      // out by intents(), so the debt stops being reported (the deliberate
      // half — see preempted()) while the route back to the work survives.
      const workDir = intent.record.workDir;
      if (!workDir) continue;
      try {
        if (!fs.existsSync(workDir)) continue;
      } catch {
        continue;
      }
      out.push({
        ...intent.record,
        agentName,
        event: 'deactivated',
        at: intent.at,
        // The annotation is dropped (see above); the *fact* is not. Without
        // this the carried row lands in `standbyAgents` wearing that list's
        // "switched off deliberately" reason, which is the opposite of what
        // happened to it — nobody chose to stop this agent, its slot was
        // taken. Dropping a debt is a decision; asserting a falsehood about
        // how work ended is not, and this is the difference.
        ...(intent.preemption || intent.wasPreempted ? { wasPreempted: true } : {})
      });
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return out.slice(0, COMPACT_STANDBY_LIMIT);
  }

  /**
   * Rewrite the log as one record per agent worth remembering: `activated` for
   * every expected agent, `deactivated` for the recent standby agents whose
   * workspace still exists (see {@link standbyToPreserve}).
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
   * are real, and only the log knows them. (The standby half already did this;
   * the asymmetry is what made it easy to miss.)
   */
  public compact(): RecordOutcome {
    const kept: AgentLogEntry[] = [
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
