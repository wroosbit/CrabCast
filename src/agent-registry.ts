// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

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
 * EVERY RETIRED ROW SHAPE, ENUMERATED — the answer to "what ELSE could be
 * sitting in somebody's registry?" (KAN-302 AC5).
 *
 * It is a CLOSED set, and that is the useful half. `LOG_VERSION` has been `1`
 * in every commit that has ever declared it, so this format has broken exactly
 * once: KAN-124 (`5657bfb`, 2026-08-04) deleted the `{type, key}` addressing
 * model and re-keyed onto the path. Every change since is an OPTIONAL field
 * added to a v1 row, which is why rows written the day after that migration
 * still load unchanged today. So "what else is out there" is not a question
 * about the future; it is a question about one commit, and this is its diff.
 *
 * A PRE-MIGRATION ROW (no `v`) COULD CARRY EXACTLY THESE, and nothing else:
 *
 *   agentName       DELETED. A derived display name; there is no equivalent.
 *   type            DELETED with `workspaceTypes`.
 *   key             DELETED with `workspaceTypes`.
 *   workDir         RENAMED to `path`, and tightened: absolute and canonical.
 *                   The one field that converts cleanly.
 *   url             DELETED. Caller page metadata; nothing reads it.
 *   defaultAgent    RENAMED to `config.launcher`.
 *   mcpServers      SHAPE-CHANGED: was `string[]` (names to look up in the
 *                   deleted config), is now `config.mcpServers`, a record of
 *                   literal server DEFINITIONS. The values are not recoverable
 *                   from a list of names — this is the second field that looks
 *                   convertible and is not.
 *   event/at        UNCHANGED, and still read: it is how the notice dates a
 *                   row and names what happened to it.
 *   preemption      UNCHANGED shape.
 *   wasPreempted    UNCHANGED shape.
 *
 * WHAT HAS NO SOURCE AT ALL, which is why these rows are skipped rather than
 * migrated: `priority` and the three gate flags were looked up from
 * `workspaceTypes` at every use and were never written to the log, and
 * `prompt` came from a `promptFile` through an interpolator that is deleted.
 *
 * TWO EVENTS WERE ADDED (`configured`, `forgotten`) AND NONE WAS RETIRED, so no
 * registry can hold an event name this daemon does not know.
 *
 * **`reset` IS NOT ONE OF THESE, and the ticket that asked for this enumeration
 * assumed it might be.** `reset` was an API VERB, removed by the same commit;
 * it never named a log event and never wrote a row. Searched across every
 * revision of this file rather than recalled: the only occurrences of the word
 * are in prose. So it cannot be sitting in anybody's registry, and an operator
 * who goes looking for one will not find it.
 *
 * THE FIELDS ADDED SINCE, all optional and all readable when absent —
 * `configVersion`, `configuredAt` (KAN-126), `activatedBy` (KAN-113),
 * `everActivated` (KAN-125), `channelEnabled` (KAN-281). None is a retired
 * shape and none refuses a row that lacks it; {@link AgentIntent.configVersion}
 * spells out why reading an absent one is a reading rather than an invention.
 */

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
  /**
   * Which configuration this is: 1 for the first accepted `configure` on this
   * path, incremented by every accepted one after it.
   *
   * ONE FIELD, THREE JOBS, which is why it earns a place on the record rather
   * than being derived at read time: it is a cheap compare-and-set token for a
   * reconciler diffing desired state against ours, the precise subject a
   * reconfiguration refusal names, and the resync token a caller compares after
   * a missed event.
   *
   * IT MUST BE STORED RATHER THAN COUNTED. Counting `configured` rows in the
   * log would work until the first compaction, which rewrites the log as one
   * row per agent and would silently reset every version to 1 — a
   * compare-and-set token that goes backwards is worse than none.
   *
   * OPTIONAL ON THE TYPE, NEVER ABSENT IN PRACTICE. A row written before this
   * field existed carries no version, and {@link AgentRegistry.intents}
   * normalizes that to 1 — see {@link AgentIntent.configVersion} for why that
   * is a reading rather than a fabrication, and why it is deliberately NOT a
   * log-version bump.
   */
  configVersion?: number;
  /**
   * When the `configure` that produced {@link configVersion} was accepted.
   *
   * Distinct from an intent's `at`, which is the time of the LAST event —
   * activation, stand-down — and says nothing about when the knobs were frozen.
   * Absent only on a row written before this field existed, and reported as
   * `null` there rather than back-filled from a timestamp that means something
   * else.
   */
  configuredAt?: string;
  /**
   * The supervisor of record: the canonical path of the agent that activated
   * this one. `null` when nobody did.
   *
   * WHY A PATH AND NOT A PAIR. The customer's own field is
   * `{type, key} | null`, and it was read from their source rather than from
   * their ticket before this was written. There is nothing to adopt literally:
   * `{type, key}` IS the addressing model this daemon deleted, and re-importing
   * it as a parent reference would put the vocabulary back one field at a time.
   * An agent is a directory, so the agent that activated one is a directory
   * too, and a path is already a complete address. Mapping ours onto theirs is
   * a translation at their boundary, which is where they said it belongs.
   *
   * REQUIRED, AND `null` RATHER THAN ABSENT. Over JSON a missing key reads as
   * "not answered", which is a different claim from "this agent has no
   * parent" — and a human-initiated activation genuinely has no supervisor,
   * which is a fact worth stating rather than leaving to be inferred from a
   * gap. Both write and read normalize (see {@link AgentRegistry.record} and
   * {@link AgentRegistry.readLog}), so every row that leaves this file in
   * either direction carries the field explicitly. Required on the type rather
   * than optional so the compiler — not a test somebody remembers to write —
   * is what catches a construction site that does not decide.
   *
   * NOT A POLICY, JUST A RECORD. Nothing here notifies a parent, ranks by it,
   * cascades through it or refuses anything because of it. Acting on parentage
   * belongs to the consumer that asked for it.
   */
  activatedBy: string | null;
  /**
   * WHETHER THE SPAWN THIS AGENT IS RUNNING FROM WAS CHANNEL-ENABLED (KAN-281):
   * `true`, `false`, or `null` when this agent has never been spawned and there
   * is therefore no spawn for the field to be about.
   *
   * WHY IT IS ON THE RECORD AT ALL, rather than answered from the live session
   * or recomputed from `config`. Both alternatives were tried on paper and both
   * lie in a case that happens every day:
   *
   *  - FROM THE SESSION: `attachSession` resolves no MCP servers, so every agent
   *    that outlived a daemon restart would read `false` — the same value as an
   *    agent genuinely spawned without a channel. A field that cannot tell "no"
   *    from "I was not there" is worse than no field.
   *  - FROM `config.mcpServers` AT RESPONSE TIME: that is a second
   *    implementation of `builtinMcpServer`'s decision, sitting in a different
   *    file from the one that made it. It is right until one of them is edited.
   *    The requesting consumer's whole reason for wanting this published was to
   *    stop re-reading a switch after the fact; answering them with a re-read
   *    wearing a better name would be that defect reimplemented on our side.
   *
   * So it is written by the activation that made the decision and read back
   * from the log — `durable`, in the four-bucket sense the read-path contract
   * publishes, and it survives a restart unchanged because it never lived in
   * memory. That is the same shape and the same argument as {@link activatedBy}
   * one field above: a fact the daemon ISSUED at activation, not a knob the
   * caller froze on.
   *
   * OPTIONAL ON THE TYPE, AND `null` IS A REAL VALUE RATHER THAN A GAP. A row
   * written before this field existed carries nothing, and a `configured` agent
   * that has never run has no spawn to describe; both read back as `null` via
   * {@link toChannelEnabled}. The read path emits it as an explicit `null` for
   * the reason the contract gives for every nullable field on that surface —
   * over JSON an absent key reads as "not answered", and this one is answered.
   */
  channelEnabled?: boolean | null;
}

/**
 * A parent reference, or `null` — a coercer at the boundary rather than a cast.
 *
 * Runs on both edges of the log: every row written goes through it and every
 * row read comes back through it, so a value that is not a usable parent
 * becomes NO PARENT rather than a half-parent that later reads as one.
 *
 * WHAT IT REFUSES, AND WHY EACH IS `null` RATHER THAN A REFUSAL TO BOOT. A
 * malformed `configVersion` refuses the boot (see {@link hasValidProvenance})
 * because a mistyped version travels into a caller's compare-and-set as though
 * it were a version, and there is no value in its own domain that means "no
 * version". This field is the opposite on both counts:
 *
 *  - `null` is a legitimate, frequent value here — most agents have no
 *    supervisor — so coercing to it produces a record the API could have
 *    produced, which is exactly the test the boot refusal applies.
 *  - A WRONG parent is worse than no parent. It would name some other agent as
 *    answerable for this one, and the consumer's whole reason for asking is to
 *    notify a supervisor and draw an org chart from it.
 *
 * And it is per-row rather than fleet-wide: one hand-edited parent must not be
 * able to stop a daemon from starting, because every other agent in that log is
 * fine.
 *
 * WHAT THIS SILENTLY LOSES, said rather than left to be discovered: a
 * hand-edited row whose `activatedBy` is a relative path or a non-string comes
 * back as "no parent" with nothing said. That is a deliberate trade against the
 * two points above, and the case it protects is the one that matters — a
 * garbled parent never becomes a confident wrong answer.
 *
 * Absolute is required for the same reason {@link canonicalPath} requires it of
 * every address: a relative path resolved here would be resolved against a
 * daemon cwd that belongs to whichever client first spawned it.
 */
export function toActivatedBy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return trimmed;
}

/**
 * {@link AgentRecord.channelEnabled} through the same both-edges coercer
 * {@link toActivatedBy} is, and for the same reason: a row that is not a
 * boolean becomes NO ANSWER rather than a half-answer that later reads as one.
 *
 * The three-way domain is what makes this worth a function. `false` and `null`
 * are DIFFERENT CLAIMS on this field — "spawned without a channel" versus "no
 * spawn to be about" — so the JavaScript reflex of coercing everything through
 * `Boolean()` would silently turn every pre-field row, and every agent that has
 * only ever been configured, into a confident `false`. That is the one wrong
 * answer this field must not give, because `false` is precisely what a consumer
 * would branch on to decide the channel is unavailable.
 *
 * Anything that is not a boolean is therefore `null`, including a hand-edited
 * `"true"`. Same trade as `activatedBy`: garbled input never becomes a
 * confident wrong answer, and it is per-row rather than fleet-wide, so one bad
 * row cannot stop a daemon booting.
 */
export function toChannelEnabled(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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
   * TWO SLICES ARRIVED AT THIS FIELD INDEPENDENTLY, for two different jobs, and
   * both reasons are kept because either one alone would justify it and a
   * reader who knows only one would under-protect it:
   *
   *  - **The resume rule** (resume.ts, KAN-111). A path CrabCast has never run
   *    in may hold a HUMAN'S Claude Code transcripts, and resuming those into
   *    an agent pane hands somebody's private session to an agent. IT IS A
   *    SAFETY FACT, NOT A STATISTIC.
   *  - **The fleet category** (router.ts, KAN-125). It is what decides whether
   *    an agent is reported as `unstarted` — activating it starts fresh — or as
   *    standby, where every row promises that switching it on "resumes the
   *    conversation it was stopped in". Getting it backwards makes one of those
   *    two promises false.
   *
   * Derived in {@link AgentRegistry.intents} by looking for any `activated`
   * event, and written onto rows by {@link AgentRegistry.compact} for the same
   * reason `wasPreempted` is: compaction keeps one row per agent, so the
   * earlier `activated` rows a `deactivated`-last or `configured`-last agent
   * was carrying disappear, and with them the fact that it ever ran.
   *
   * Losing the marker to compaction would fail in the SAFE direction for the
   * first job — an agent starting fresh instead of resuming — which is exactly
   * why it would go unnoticed until somebody wondered where their conversation
   * went. It fails in the LOUD direction for the second, since the agent would
   * move between two visible categories. One field, two failure signatures.
   *
   * Absent on a row for an agent that genuinely never ran, and absent on an
   * `activated` row, where the event itself is the evidence.
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
  /**
   * {@link AgentRecord.configVersion}, normalized: NEVER absent.
   *
   * A row written before the field existed reads as **1**, and that is a
   * reading rather than an invention — the row is one accepted `configure`, so
   * "the first configuration" is the only version it can be. The next
   * `configure` on that path takes it to 2, so the token still moves when the
   * configuration moves, which is the whole of what a compare-and-set needs.
   *
   * WHY THIS IS NOT A LOG-VERSION BUMP, since the daemon refuses to boot
   * against rows it cannot fully understand. That refusal exists for rows whose
   * missing values would have to be FABRICATED — `priority`, the gate flags and
   * `prompt` lived in the deleted `workspaceTypes` and have nowhere to come
   * from, so a converted row would be a configured agent the API could not have
   * produced. This field has nowhere to go wrong: every value it could take is
   * derivable from the row's own existence. Refusing to boot over a field that
   * can be read correctly would apply that rule to a case it was not reasoned
   * out for, and would cost every existing fleet its agents for a purely
   * additive field.
   */
  configVersion: number;
  /**
   * {@link AgentRecord.configuredAt}, or `null` on a row written before the
   * field existed. NOT back-filled from the entry's `at`, which is the time of
   * the last event — a stand-down, an activation — and would assert a configure
   * time nobody recorded.
   */
  configuredAt: string | null;
  /**
   * Whether this path has EVER carried an `activated` event.
   *
   * Derived in one pass over the log this reduction is already making, and
   * carried across compaction by {@link AgentLogEntry.everActivated}. It is the
   * whole of the difference between an agent that has never run and one that
   * has stopped: activating the first starts a fresh conversation, activating
   * the second resumes the one it was stopped in — and it is the resume rule's
   * input. See {@link AgentLogEntry.everActivated} for both jobs.
   *
   * REQUIRED RATHER THAN OPTIONAL, which is the one place the two slices that
   * added this field disagreed. `boolean | undefined` would make every consumer
   * decide what an absent value means, and the two consumers would decide
   * differently: the resume rule wants absent to mean "do not resume" while a
   * fleet category wants it to mean "not yet known". `intents()` always knows
   * the answer — it has just read the whole log — so it always states it.
   */
  everActivated: boolean;
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
 *   into `durable: false` on the response and a `registry.degraded` event. A
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
/**
 * The two record fields that are optional on the wire and still have to be
 * RIGHT when present.
 *
 * Absent is a supported reading (see {@link AgentIntent.configVersion}).
 * `"3"`, `0`, `-1` or `1.5` are not: each would travel into a reconciler's
 * compare-and-set as though it were a version, and a token that can go
 * backwards or compare unequal to itself is worse than a missing one. Checked
 * here rather than at read time so the boot scan catches a hand-edit that got
 * it wrong, which is the same reason `isAgentConfig` is checked here.
 */
function hasValidProvenance(value: any): boolean {
  if (value.configVersion !== undefined) {
    if (
      typeof value.configVersion !== 'number' ||
      !Number.isSafeInteger(value.configVersion) ||
      value.configVersion < 1
    ) {
      return false;
    }
  }
  if (value.configuredAt !== undefined) {
    if (typeof value.configuredAt !== 'string' || !value.configuredAt.length) return false;
  }
  return true;
}

function isUsableEntry(value: any): value is AgentLogEntry {
  return (
    value &&
    AGENT_EVENTS.includes(value.event) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    // A `forgotten` row's only job is to erase; it needs no config to do it,
    // and requiring one would let a config-less tombstone resurrect an agent.
    (value.event === 'forgotten' || (isAgentConfig(value.config) && hasValidProvenance(value)))
  );
}

/**
 * WHY A ROW THIS DAEMON CANNOT READ IS NOT A ROW THIS DAEMON MAY FORGET
 * (KAN-302).
 *
 * This block and the four that follow it replace a refusal to boot. The
 * reasoning that produced that refusal was right about the danger and wrong
 * about one word, and the word is worth naming because the rest of the argument
 * survives intact.
 *
 * The refusal said: *"Loading the file part-way is not offered: the agents in
 * those rows would simply not exist, AND NOTHING WOULD SAY SO."* Every clause
 * of that is true, and the load-bearing one is the last. A half-loaded registry
 * is intolerable because it is SILENT — the daemon comes up reporting a fleet
 * with a hole in it, indistinguishable from a healthy one, which is the exact
 * failure this registry exists to remove. So the objection is not to starting.
 * It is to starting without saying what was dropped.
 *
 * What the refusal offered instead cost more than the disease. Its first
 * remedy was *"delete the registry and configure the fleet again"* — on a
 * machine with a real fleet, that is every agent record destroyed to recover
 * from one row, and the registry is the one artifact whose entire purpose is
 * surviving that. A recovery instruction that discards the thing being
 * recovered is not a remedy. And the refusal is total: one row written by a
 * CrabCast eight days older, describing an agent that had ALREADY been stood
 * down and was commanding nothing, took the whole daemon off the machine.
 *
 * SO: skip the ROW, not the BOOT — under three guarantees, and the design is
 * only honest if all three hold together.
 *
 *  1. **Nothing is deleted, moved or rewritten.** The unreadable rows stay in
 *     the file, byte for byte. {@link AgentRegistry.compact} carries them
 *     across verbatim — see the note there, because without it this fix
 *     reintroduces on a 500-record timer exactly the destruction it removes.
 *  2. **The fleet says so, on a surface a caller reads.** Every unreadable row
 *     is published as an {@link UnreadableRecord} on `list_agents` and
 *     `daemon_status`: line number, what could not be read about it, and the
 *     row's own bytes. That is what answers "and nothing would say so" on its
 *     own terms, and it is why the disclosure is a response field rather than
 *     a log line — the operator who met this had every dashboard green.
 *  3. **No remedy destroys the record.** {@link describeUnreadableLog} names
 *     the row and the repair; the word "delete" is gone from it, and
 *     `verify-registry-survives-retired-rows.mjs` §5 fails the build if it
 *     comes back.
 *
 * The one thing that has NOT changed is the refusal to invent. A pre-migration
 * row's `priority`, gate flags and `prompt` came from the deleted
 * `workspaceTypes` and have nowhere to come from; this daemon still will not
 * make them up. It declines to RESTORE such an agent and says which one, which
 * is a different act from pretending the row was never there.
 */

/**
 * How much of a row's own text the disclosure carries before it clips.
 *
 * A bound rather than the whole line, because this rides on `list_agents`,
 * which a fleet client polls continuously, and a hand-edited row can be any
 * size at all. Clipping is stated per record ({@link
 * UnreadableRecord.rawTruncated}) rather than left to be inferred from a
 * suspiciously round length.
 */
export const UNREADABLE_RAW_LIMIT = 2048;

/** Why a row could not be read. Three problems, three different repairs. */
export type UnreadableProblem = 'pre-migration' | 'from-newer' | 'unusable';

/**
 * What an unreadable row says about ITSELF — whether the list it is missing
 * from could be short of something that was meant to be there (KAN-344).
 *
 * WHY A SECOND CLASSIFICATION, when {@link UnreadableProblem} is right there.
 * They answer different questions and only one of them is the consumer's.
 * `problem` grades WHY WE COULD NOT READ THE ROW, which is the operator's
 * question and decides the repair. This grades WHETHER IT MATTERS, which is the
 * reconciling caller's, and nothing on the wire answered it: `pre-migration`
 * says an old daemon wrote the line and says nothing whatever about whether the
 * line was a running agent or a tombstone for one switched off in August.
 *
 * That gap is what this exists to close, and the defect it closes is not
 * cosmetic. `unreadableRecordsTotal` is a STANDING count — an unreadable row
 * survives compaction by design (KAN-302), nothing ages it out, and only a
 * human repairing that line removes it. So a consumer that meets a permanently
 * non-zero count learns its constant value and stops reading it, and the second
 * row — the one that does mean a lost agent — arrives as a `2` where the `1`
 * was background noise. A count cannot distinguish those. A per-row standing
 * can, because the new row is a DIFFERENT KIND of row rather than a larger
 * number.
 *
 *   retired           this row records the agent being switched off or removed.
 *                     Nothing was going to be restored from it, so the fleet
 *                     list is not short of anything that was ever going to run.
 *   claims-an-agent   this row records the agent being configured or started.
 *                     It could be hiding a row the fleet list should have
 *                     carried, and it is the one worth looking at.
 *   unknown           we will not say. The row names no event, names something
 *                     that is not one of ours — or is `from-newer`, where the
 *                     vocabulary is not this daemon's to read at all.
 *
 * IT DESCRIBES THE ROW AND NOT THE AGENT, and the obvious reading is the wrong
 * one. The registry is append-only and a row is ONE event, so a later readable
 * row may supersede this one entirely: `claims-an-agent` says this LINE asserts
 * an agent, never that anything is running now. The daemon cannot say the
 * second — the line it would have to read is the line it could not read.
 */
export type RowStanding = 'retired' | 'claims-an-agent' | 'unknown';

/**
 * What each event this daemon knows says about a row's standing.
 *
 * `satisfies Record<AgentEvent, …>` RATHER THAN A `switch` OR A PAIR OF LISTS,
 * and that is the point of the shape: a fifth {@link AgentEvent} is a COMPILE
 * ERROR here until somebody decides which side of the line it falls on. A
 * membership test against two arrays would give a newly added event `unknown`
 * by default and silently — which on this field means "we will not say" about a
 * word we had in fact just added, and nothing would have gone red.
 *
 * A `Map` ON THE OUTSIDE, AND THAT HALF IS A CORRECTNESS FIX RATHER THAN A
 * PREFERENCE. The word looked up here comes off a line somebody hand-edited, so
 * it can be any string at all — and a plain object inherits `Object.prototype`,
 * where `EVENT_STANDING['toString']` answers a FUNCTION. It is truthy, so it
 * would have been returned as this field's value, and `JSON.stringify` drops a
 * function silently: the response would have carried NO `standing` KEY, on
 * exactly the `unusable` rows most likely to hold a strange word. A `Map` has no
 * prototype chain to fall through, so an unrecognised word answers `undefined`
 * and the lookup falls to `unknown` as written. `verify-unreadable-row-standing`
 * §2 covers it with a `toString` row.
 */
const EVENT_STANDING: ReadonlyMap<string, RowStanding> = new Map(
  Object.entries({
    configured: 'claims-an-agent',
    activated: 'claims-an-agent',
    deactivated: 'retired',
    forgotten: 'retired'
  } satisfies Record<AgentEvent, RowStanding>)
);

/**
 * One row this daemon could not read, in the shape a CALLER receives it —
 * `list_agents.unreadableRecords[]` and `daemon_status.unreadableRecords[]`.
 *
 * THE FIELDS ARE CHOSEN SO THAT THE OPERATOR NEVER HAS TO OPEN THE FILE TO
 * KNOW WHAT IS IN IT, and never has to guess which of the three repairs
 * applies. The refusal this replaces printed a count and a sample line; a
 * count is not something a caller can act on.
 */
export interface UnreadableRecord {
  /**
   * 1-based line number in the registry file — the number `sed -n '<n>p'`
   * takes, so the disclosure names a thing the operator can address.
   *
   * The refusal this replaces named the FILE and offered to delete it. Naming
   * the line is the whole difference between "one row is wrong" and "your
   * registry is wrong", and it is what makes a targeted repair sayable.
   */
  line: number;
  problem: UnreadableProblem;
  /**
   * However the row identifies itself: its `agentName`, else its retired
   * `type`/`key` pair, else its `path`. Quoted back in the row's OWN
   * vocabulary, because that is what lets a human find it in the file — an old
   * row does not know the word `path`.
   */
  identity: string;
  /** What could not be read about it, in one sentence, naming fields. */
  reason: string;
  /**
   * The row's own bytes.
   *
   * Verbatim, except in the one case {@link promptRedacted} marks. Every row
   * that reaches this type is valid JSON — a line that is not parses as
   * nothing and is treated as a torn tail, never as an unreadable record — so
   * "verbatim" here is the trimmed source line itself and not a
   * re-serialization, in every case but that one.
   */
  raw: string;
  /** Whether {@link raw} was clipped at {@link UNREADABLE_RAW_LIMIT}. */
  rawTruncated: boolean;
  /**
   * Whether a `prompt` was removed from {@link raw} before publishing it.
   *
   * A REDACTION THAT IS STATED IS HONEST; A SURFACE THAT QUIETLY WIDENS IS
   * NOT. `config.prompt` is the one field a caller froze onto an agent that
   * this daemon does NOT echo on an ordinary `list_agents` row — the config
   * echo is five fields and `prompt` is not among them. Publishing an
   * unreadable row's bytes unfiltered would therefore hand back, on the same
   * response, a value the surface beside it withholds, and a registry row is
   * exactly where a caller's own bootstrap text sits. So a `prompt` is
   * replaced by a marker naming its length, `raw` is re-serialized for that
   * row only, and this flag says it happened.
   */
  promptRedacted: boolean;
  /**
   * A directory this row names — its `path`, else the retired `workDir` — or
   * `null` when it names none.
   *
   * PUBLISHED BECAUSE OF WHAT STARTING RATHER THAN REFUSING MAKES POSSIBLE,
   * and this is the honest edge of that trade. A skipped row's path is not
   * claimed by anything the daemon can see, so `configure` on that same
   * directory now succeeds and creates a second, readable record for it. That
   * is the right default — refusing would re-brick the machine on a row nobody
   * can repair — but it means a caller can silently end up with two records
   * for one directory, one of which nothing will ever load. This field is what
   * lets a caller see that coming instead of meeting it. `null` on the
   * specimen that commissioned this work, whose `workDir` was the empty
   * string.
   */
  claimsPath: string | null;
  /**
   * The timestamp this row gives for ITSELF — its `at` — or `null` when it
   * names none or names something that is not a string (KAN-344).
   *
   * WHAT IT DATES, said precisely because the useful-sounding reading is the
   * wrong one: **WHEN THE ROW WAS WRITTEN, NOT WHEN IT BECAME UNREADABLE.** A
   * `from-newer` row became unreadable the moment somebody downgraded this
   * daemon, which may be minutes ago on a row written last month; a
   * `pre-migration` row became unreadable when the format moved past it. So
   * this answers *"how old is this record"* and never *"how long has this been
   * broken"*.
   *
   * WHY THE ROW'S OWN CLAIM RATHER THAN A FIRST-SEEN OBSERVATION OF OURS, which
   * is the shape this was nearly built as. A first-seen timestamp is memory:
   * either module state a restart discards — which would re-date every row on
   * every reboot, exactly when an operator is most likely to be looking — or a
   * second durable file beside the registry, whose whole content is our opinion
   * about a file we already have. And it would date OUR NOTICING, which is not
   * the question anybody asked. The row carries the answer already; this quotes
   * it, and `claims` is the prefix that says whose claim it is.
   *
   * NOT PARSED, NOT NORMALISED, NOT VALIDATED. Whatever string the row holds,
   * handed back as it stands. A hand-edited row may carry nonsense here, and
   * turning that into `null` — or into a Date — would be this daemon deciding
   * what a row it cannot read meant.
   *
   * `null` HAS EXACTLY ONE MEANING, AND THAT IS A PROPERTY OF WHERE IT IS READ
   * FROM. It is taken off `parsed` — the object — and never off {@link raw},
   * which by this point may have been re-serialized to withhold a prompt and is
   * then clipped at {@link UNREADABLE_RAW_LIMIT}. A row that names its `at`
   * past byte 2048 would answer `null` if this were read off the disclosure,
   * and a consumer could not tell that null from *"the row named none"* — a
   * null meaning two things, which is this ticket's own defect one field over.
   * The precedent is {@link identity} and {@link claimsPath}, which read
   * `parsed` for the same reason.
   *
   * The other half of the same guarantee is upstream: a line that does not
   * `JSON.parse` never reaches this type at all — {@link classifyLog} catches
   * the failure, deliberately does not disclose it, and moves on. **Every row
   * that becomes an `UnreadableRecord` parsed.** So `null` here can only mean
   * *this row parsed and named no timestamp, or named a non-string*, and never
   * *we could not see it*. That is what makes it safe to branch on.
   */
  claimsAt: string | null;
  /**
   * The row's own `event`, verbatim, or `null` when it names none or names a
   * non-string (KAN-344).
   *
   * THE EVIDENCE UNDER {@link standing}, and it is published rather than folded
   * into it for one reason that is not symmetry: on a `from-newer` row
   * `standing` deliberately abstains, and this is then the ONLY thing that lets
   * a consumer make its own call. A reader that trusts a newer daemon's
   * vocabulary to be a superset of this one's is entitled to read
   * `claimsEvent: "deactivated"` and act on it. This daemon is not entitled to
   * do that FOR them, which is the whole of the difference between the two
   * fields.
   *
   * Quoted in the row's own vocabulary, like {@link identity}: a word this
   * daemon does not know comes back as the word it is, not as a null.
   */
  claimsEvent: string | null;
  /**
   * Whether this row could be hiding something the fleet list should have
   * carried — see {@link RowStanding}, which carries the argument (KAN-344).
   *
   * THIS DAEMON'S VERDICT ON {@link claimsEvent}, which is what puts it in
   * `derived` while the two `claims*` fields beside it are `durable`. The pair
   * is the same shape as {@link problem} and {@link reason} one field up: a
   * closed vocabulary to branch on, and the row's own bytes to check it
   * against. When they disagree — `claimsEvent: "deactivated"` beside
   * `standing: "unknown"` on a `from-newer` row — the disagreement is legible
   * rather than resolved, and that is the intended outcome.
   */
  standing: RowStanding;
}

/** What {@link scanLogVersions} found, in the shape the boot notice prints. */
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
   * These are the hand-edit casualties. The notice prints "hand-edit the
   * file" as a supported repair, and an operator following it who omits one of
   * the required `config` fields produces a row that passes a version check
   * and fails `isUsableEntry` — which drops it SILENTLY, on purpose, for
   * torn-tail tolerance. Without this count the daemon would report a fleet
   * with a hole in it, through the recovery procedure it recommended itself.
   */
  unusable: number;
  /** Every offending row, in file order. The disclosure and the notice share it. */
  unreadable: UnreadableRecord[];
  /** A few offending rows as one-liners, for the boot notice's text. */
  samples: string[];
}

/** How many rows the boot notice names before it says "and N more". */
const VERSION_SCAN_SAMPLES = 3;

/**
 * Count rows this daemon's format does not cover, WITHOUT loading any of them.
 *
 * THE BOOT-TIME CALLER. {@link AgentRegistry.read} asks the same question of
 * the same classifier on every read; this is the one that runs before anything
 * else exists, so the operator meets the notice at the top of `daemon.log`
 * rather than only on a response they have to know to ask for.
 *
 * WHAT THIS PARAGRAPH USED TO SAY, and why the correction matters (KAN-302).
 * It said the check runs "outside `readLog`, and never inside `isUsableEntry`'s
 * filter", because tightening that filter would drop pre-migration rows
 * SILENTLY — `readLog` → `[]`, `intents()` → empty, `expected()` → empty, and
 * reconcile printing "the agent registry records no agents that should be
 * running", indistinguishable from a healthy empty fleet.
 *
 * That danger is exactly right and the conclusion drawn from it was too narrow.
 * Keeping the two questions in two places did not prevent the silence; it only
 * moved it, and it cost a hand-maintained agreement between a boot gate and a
 * loader that the code itself warned about. The rows ARE dropped from the load
 * now — they always were, once the boot stopped exiting — and what stops that
 * being silent is {@link UnreadableRecord}, published on two response surfaces
 * and printed by the CLI. So the two questions are now ONE classifier
 * ({@link classifyRow}), which is what makes "the rows disclosed" and "the rows
 * dropped" the same set by construction rather than by vigilance.
 *
 * WHY SKIP RATHER THAN MIGRATE. `path` derives cleanly from the old
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
  const scan = emptyScan(file);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No file is the ordinary state on a fresh install, and an unreadable one
    // is readLog's problem to report — this scan must not turn either into a
    // fleet-wide claim about rows it never saw.
    return scan;
  }
  classifyLog(text, scan);
  return scan;
}

function emptyScan(file: string): LogVersionScan {
  return { file, rows: 0, preMigration: 0, fromNewer: 0, unusable: 0, unreadable: [], samples: [] };
}

/**
 * Exactly which of the five required `config` fields — plus the two optional
 * ones that must still be well-formed — this row got wrong.
 *
 * NAMING THEM IS THE POINT. The refusal this replaces said a row was
 * "unreadable" and then printed the whole list of what a row needs, leaving
 * the operator to diff their line against a paragraph. This case is reached BY
 * hand-editing, so the repair instruction has to be about THIS row: the
 * operator already believes they supplied every field, and the useful sentence
 * is which one they did not.
 */
function describeUnusable(value: any): string {
  const missing: string[] = [];
  if (!AGENT_EVENTS.includes(value.event)) {
    missing.push(`"event" must be one of ${AGENT_EVENTS.join(', ')}`);
  }
  if (typeof value.path !== 'string' || !value.path.length) {
    missing.push('"path" must be a non-empty string');
  }
  if (value.event !== 'forgotten') {
    const config = value.config;
    if (!config || typeof config !== 'object') {
      missing.push('"config" must be an object');
    } else {
      if (typeof config.priority !== 'number' || !Number.isFinite(config.priority)) {
        missing.push('"config.priority" must be a finite number');
      }
      if (typeof config.launcher !== 'string' || !config.launcher.length) {
        missing.push('"config.launcher" must be a non-empty string');
      }
      for (const flag of ['refusable', 'chargeable', 'preemptable'] as const) {
        if (typeof config[flag] !== 'boolean') missing.push(`"config.${flag}" must be a boolean`);
      }
    }
    if (!hasValidProvenance(value)) {
      missing.push(
        '"configVersion" must be a whole number of at least 1 and "configuredAt" a non-empty ' +
          'string — both may be omitted entirely, and omitting is safer than guessing'
      );
    }
  }
  return missing.length
    ? `version v${LOG_VERSION} and still unreadable: ${missing.join('; ')}`
    : `version v${LOG_VERSION} and rejected by the loader's own predicate`;
}

/**
 * Whether one parsed row is one this daemon can act on, and if not, why.
 *
 * THE SINGLE CLASSIFIER, and its being single is the design rather than
 * tidiness. The boot notice and {@link AgentRegistry.read} both ask this
 * question, and the previous arrangement asked it twice — a version check at
 * boot and `isUsableEntry` at load — with a comment explaining that they had to
 * be kept in agreement by hand. They are now the same call, so a row disclosed
 * as unreadable is exactly a row the loader dropped, and neither can drift into
 * covering a case the other does not.
 */
function classifyRow(parsed: any, line: number, source: string): UnreadableRecord | null {
  let problem: UnreadableProblem;
  let reason: string;
  if (typeof parsed.v === 'number' && parsed.v > LOG_VERSION) {
    problem = 'from-newer';
    reason =
      `carries format version v${parsed.v}; this daemon writes v${LOG_VERSION} and cannot know ` +
      `what a newer row means. It was not written by an older CrabCast — it was written by a ` +
      `newer one, and downgrading is what put you here.`;
  } else if (parsed.v !== LOG_VERSION) {
    problem = 'pre-migration';
    reason =
      'was written by a CrabCast that addressed agents by <type>/<key>. Its `workDir` gives the ' +
      'path, but `priority`, the gate flags and `prompt` came from the `workspaceTypes` config ' +
      'that no longer exists, so they cannot be recovered from the row. Inventing them is the ' +
      'one thing this daemon refuses to do about a value nobody decided.';
  } else if (!isUsableEntry(parsed)) {
    problem = 'unusable';
    reason = describeUnusable(parsed);
  } else {
    return null;
  }

  // Identified in whatever vocabulary the row itself uses: an old row says
  // `type`/`key`, and quoting it back is what lets a human find the line.
  const identity =
    typeof parsed.agentName === 'string'
      ? parsed.agentName
      : typeof parsed.type === 'string' && typeof parsed.key === 'string'
        ? `${parsed.type}/${parsed.key}`
        : typeof parsed.path === 'string' && parsed.path.length
          ? parsed.path
          : '(unidentifiable row)';

  // See UnreadableRecord.promptRedacted. Re-serialized ONLY when there is a
  // prompt to remove, so `raw` is the operator's own line in every other case.
  const prompt = parsed?.config?.prompt ?? parsed?.prompt;
  const promptRedacted = typeof prompt === 'string';
  let raw = source;
  if (promptRedacted) {
    const marker = `[prompt withheld — ${prompt.length} characters]`;
    const copy = { ...parsed };
    if (typeof copy.prompt === 'string') copy.prompt = marker;
    if (copy.config && typeof copy.config === 'object' && typeof copy.config.prompt === 'string') {
      copy.config = { ...copy.config, prompt: marker };
    }
    raw = JSON.stringify(copy);
  }
  const rawTruncated = raw.length > UNREADABLE_RAW_LIMIT;
  if (rawTruncated) raw = raw.slice(0, UNREADABLE_RAW_LIMIT);

  const claimsPath =
    typeof parsed.path === 'string' && parsed.path.length
      ? parsed.path
      : typeof parsed.workDir === 'string' && parsed.workDir.length
        ? parsed.workDir
        : null;

  // Quoted, both of them: whatever the row holds, or null when it holds no
  // string at all. Neither is parsed, ranged or normalised — see the field
  // documentation, and note that `''` is null here for the same reason
  // `claimsPath` treats an empty `workDir` as naming nothing.
  const claimsAt =
    typeof parsed.at === 'string' && parsed.at.length ? parsed.at : null;
  const claimsEvent =
    typeof parsed.event === 'string' && parsed.event.length ? parsed.event : null;

  // `from-newer` ABSTAINS EVEN WHEN THE WORD IS ONE WE KNOW, and this line is
  // the whole of that decision. `problem`'s own reason text on that branch says
  // this daemon "cannot know what a newer row means"; reading its event
  // vocabulary anyway would contradict that sentence in the same response, over
  // the one field a consumer is meant to branch on. The word still travels, in
  // `claimsEvent`, for a consumer willing to make the assumption we are not.
  const standing: RowStanding =
    problem === 'from-newer'
      ? 'unknown'
      : (claimsEvent !== null ? EVENT_STANDING.get(claimsEvent) : undefined) ?? 'unknown';

  return {
    line,
    problem,
    identity,
    reason,
    raw,
    rawTruncated,
    promptRedacted,
    claimsPath,
    claimsAt,
    claimsEvent,
    standing
  };
}

/**
 * Walk a registry's text once, filling in the counts and — when `entries` is
 * supplied — the rows the loader accepts.
 *
 * ONE PASS ANSWERS BOTH QUESTIONS, which is what lets `list_agents` disclose
 * unreadable rows without paying a second whole-file parse per poll. The same
 * argument {@link AgentRegistry.intentsFrom} and {@link
 * AgentRegistry.preemptedFrom} make one file over, applied to the read itself:
 * two reads are also two DIFFERENT reads, and a response whose disclosure came
 * from a later parse than its agent rows could contradict itself about the
 * same line.
 */
function classifyLog(text: string, scan: LogVersionScan, entries?: AgentLogEntry[]): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A torn tail, or a line nothing here wrote. Not evidence of a version,
      // and deliberately NOT disclosed as an unreadable record: the final line
      // is the one a power cut tears, and reporting that as a fleet fact would
      // make an ordinary crash look like data loss. Anything earlier is
      // unexpected and worth saying out loud.
      if (entries && i < lines.length - 1) {
        console.error(`[AgentRegistry] Skipping unparseable record at line ${i + 1}`);
      }
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    scan.rows++;

    const bad = classifyRow(parsed, i + 1, trimmed);
    if (!bad) {
      // NORMALIZED ON THE WAY OUT, so no consumer downstream has to know that a
      // row written before a field existed carries no value for it, or that a
      // hand-edited one might carry nonsense. See toActivatedBy.
      entries?.push({
        ...(parsed as AgentLogEntry),
        activatedBy: toActivatedBy(parsed.activatedBy),
        channelEnabled: toChannelEnabled(parsed.channelEnabled)
      });
      continue;
    }

    if (bad.problem === 'pre-migration') scan.preMigration++;
    else if (bad.problem === 'from-newer') scan.fromNewer++;
    else scan.unusable++;
    scan.unreadable.push(bad);
    if (scan.samples.length < VERSION_SCAN_SAMPLES) {
      // BUILT FROM THE RECORD, NOT RE-DERIVED FROM `parsed` (KAN-344). This
      // line used to read `parsed.event` and `parsed.at` for itself, which was
      // the only place in this file that answered a question about a row twice
      // — and {@link classifyRow}'s own header makes the argument against
      // exactly that, one function up: "they are now the same call, so neither
      // can drift into covering a case the other does not". The boot notice and
      // the wire now cannot disagree about what a row said, because there is
      // one expression and two readers of it.
      //
      // It is also where the two values were already being extracted and then
      // written to stderr once, at boot, where no caller could reach them. That
      // is what makes publishing them a routing decision rather than a new
      // interpretation of the bytes.
      scan.samples.push(
        `line ${bad.line}: ${bad.identity} — ${bad.claimsEvent ?? 'no event'} at ` +
          `${bad.claimsAt ?? 'no timestamp'} (${bad.problem}, ${bad.standing})`
      );
    }
  }
}

/** How many rows the boot notice spells out in full before pointing at the wire. */
const NOTICE_DETAIL_LIMIT = 20;

/**
 * What the daemon prints — while starting — when the log holds rows it cannot
 * read.
 *
 * IT IS A NOTICE, NOT A REFUSAL, and every sentence in it changed with that
 * (KAN-302). The reasoning is on {@link UnreadableRecord} above; what matters
 * here is the two properties this text is held to by
 * `verify-registry-survives-retired-rows.mjs`, because both were violated by
 * what it replaced:
 *
 *  - **It names the ROW, not the file.** Line number, identity, and which
 *    field could not be read. The old text named the file and a count.
 *  - **No repair it offers destroys a record.** "Delete the registry and
 *    configure the fleet again" is gone. It was the FIRST remedy and was
 *    recommended as "the right answer for every real deployment", which on a
 *    machine with a real fleet is every agent record discarded to recover from
 *    one row. §5 of the proof greps this function's output for the word and
 *    fails the build if it returns.
 *
 * The daemon log is still not a surface a caller can read, and that is why
 * this is the SECOND half of the disclosure rather than the whole of it: the
 * same rows go out on `list_agents` and `daemon_status`. This text is for the
 * operator who is already looking at the log; that field is for the operator
 * whose dashboards are all green, which is the one this defect was found by.
 */
export function describeUnreadableLog(scan: LogVersionScan): string {
  const bad = scan.preMigration + scan.fromNewer + scan.unusable;
  const shown = scan.unreadable.slice(0, NOTICE_DETAIL_LIMIT);
  const parts: string[] = [
    `${bad} of ${scan.rows} record(s) in the agent registry cannot be read by this daemon. ` +
      `Starting without them.`,
    `  registry: ${scan.file}`,
    ``,
    `THE AGENTS IN THOSE ROWS HAVE NOT BEEN RESTORED AND ARE NOT RUNNING. Nothing has been`,
    `deleted: the rows are still in the file, they are carried across compaction unchanged,`,
    `and every one of them is published on \`list_agents\` and \`daemon_status\` as`,
    `\`unreadableRecords\` — with its line number and its own bytes — so this is a fact about`,
    `the fleet that a caller can read rather than a line in a log nobody opens.`,
    ``
  ];

  for (const row of shown) {
    // The STANDING is on the operator's line as well as on the wire (KAN-344),
    // and it is second only to the line number in what it decides: `retired`
    // from last August is a tombstone to leave alone, `claims-an-agent` is a
    // row that may be the only thing mentioning an agent nothing restored. Read
    // off the record rather than recomputed here — this text and the response
    // are two renderings of one classification, and a second derivation is how
    // they would come to disagree about the same line.
    parts.push(
      `  line ${row.line}: ${row.identity} (${row.problem}, ${row.standing})` +
        (row.claimsAt ? ` — the row dates itself ${row.claimsAt}` : ''),
      `      ${row.reason}`
    );
  }
  if (bad > shown.length) {
    parts.push(
      `  …and ${bad - shown.length} more, all of them on \`list_agents.unreadableRecords\`.`
    );
  }
  parts.push(``);

  // Three different problems with three different repairs. Saying "unreadable"
  // over all of them would send an operator to the wrong one.
  if (scan.preMigration > 0) {
    parts.push(
      `${scan.preMigration} row(s) were written by a CrabCast that addressed agents by`,
      `<type>/<key>. Their \`workDir\` gives the path, but \`priority\`, the gate flags and`,
      `\`prompt\` came from the \`workspaceTypes\` config that no longer exists — so a converted`,
      `row would be a configured agent missing three required \`configure\` parameters, which`,
      `this API could not have produced. Inventing them is the one thing this daemon refuses`,
      `to do about a value nobody decided, and it is why these rows are skipped rather than`,
      `migrated. To bring such an agent back, \`configure\` its directory with the knobs you`,
      `want — the values are yours to decide, and nothing here can decide them for you.`,
      ``
    );
  }
  if (scan.fromNewer > 0) {
    parts.push(
      `${scan.fromNewer} row(s) carry a format version NEWER than this daemon writes (this`,
      `daemon is at v${LOG_VERSION}). They were not written by an older CrabCast — they were`,
      `written by a newer one, and downgrading is what put you here. Run the newer daemon`,
      `against this data directory and they become readable again; this one leaves them`,
      `untouched, so nothing is lost by having started it.`,
      ``
    );
  }
  if (scan.unusable > 0) {
    parts.push(
      `${scan.unusable} row(s) are version v${LOG_VERSION} and still unreadable — almost always a`,
      `hand-edit that dropped or mistyped a field. The exact field is named against each row`,
      `above. A row needs a non-empty "path" and a "config" carrying a finite "priority", a`,
      `non-empty "launcher" and all three of "refusable", "chargeable" and "preemptable" as`,
      `booleans. "configVersion" and "configuredAt" are OPTIONAL and must still be well-formed`,
      `when present — an absent version reads as 1, so if you are unsure, leave them out`,
      `rather than guess.`,
      ``
    );
  }

  parts.push(
    `To repair a row, edit THAT LINE — every other record in this file is fine and is`,
    `already loaded. Re-run the daemon afterwards: it validates each row against the same`,
    `predicate the loader uses, so a field you miss is named here rather than dropped`,
    `silently later.`,
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
   * not a reason to fail the operation the caller is in the middle of — but it
   * *answers*. A swallowed failure here is KAN-21 (in the extraction source)
   * re-entering through the error path: the agent exists, the disk does not
   * know, and nothing outside the daemon log can observe it. The caller
   * surfaces `ok: false` (a `durable: false` on its response, a
   * degraded-registry broadcast) so the gap is somebody's to act on rather
   * than nobody's.
   */
  public record(
    event: AgentEvent,
    record: AgentRecord,
    preemption?: PreemptionRecord,
    at?: string
  ): RecordOutcome {
    const entry: AgentLogEntry = {
      v: LOG_VERSION,
      ...record,
      // AFTER the spread, so this wins: every row leaves this function with an
      // explicit `activatedBy`, `null` when there is none. The type already
      // requires it of a TypeScript caller; this is what makes the property
      // hold for the JSON that reaches the disk regardless of who built the
      // record, and it is the write-side half of the coercer. See
      // {@link toActivatedBy}.
      activatedBy: toActivatedBy(record.activatedBy),
      // Same treatment, same position, same reason (KAN-281): after the spread
      // so it wins, so that every row on disk carries an explicit three-way
      // answer rather than an absent key that a later reader has to guess at.
      channelEnabled: toChannelEnabled(record.channelEnabled),
      event,
      at: at ?? new Date().toISOString(),
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

  /**
   * `at` OVERRIDES THE TIMESTAMP, and it exists for exactly one caller.
   *
   * Reconfiguring a RUNNING agent in place rewrites its record, and the row
   * that carries the new configuration has to stay `activated` — `expected()`
   * filters on that event, so a `configured` row over a live agent would drop
   * it out of the restore set and a daemon restart would silently not bring it
   * back. But the agent was not activated again; only its knobs moved. Stamping
   * the row with `now` would assert an activation that did not happen, and that
   * assertion is read: `preemptionCandidates` uses this timestamp as the
   * victim-ordering tiebreaker, so a reconfigured agent would quietly become
   * the youngest thing on the machine and the last one preemption would take.
   *
   * So the reconfiguration carries the ORIGINAL activation's `at` forward. The
   * default remains `now`, and every other caller takes it.
   */
  public recordActivated(record: AgentRecord, at?: string): RecordOutcome {
    return this.record('activated', record, undefined, at);
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
    return this.read().entries;
  }

  /**
   * The log, in ONE pass: the records this daemon can act on, and the rows it
   * cannot read.
   *
   * BOTH ANSWERS FROM ONE READ, and that is a correctness property before it is
   * a cost one (KAN-302). `list_agents` publishes the unreadable rows beside
   * the agents, and taking those from two separate parses of the same file
   * would let an append landing between them produce one response whose
   * disclosure and whose agent rows disagreed about the same line — the same
   * argument {@link preemptedFrom} makes about the four questions one poll asks.
   *
   * The torn-tail rule lives here and applies to *any* unparseable line, not
   * only the last one: a line that cannot be read is a line that says nothing,
   * and skipping it is strictly better than refusing to read the file. Only a
   * bad final line is expected (that is what a power cut produces), so anything
   * earlier is logged — it would mean something worse than a crash. A torn line
   * is deliberately NOT reported as an unreadable RECORD: see {@link
   * classifyLog}.
   */
  public read(): { entries: AgentLogEntry[]; unreadable: UnreadableRecord[] } {
    const scan = emptyScan(this.file);
    const entries: AgentLogEntry[] = [];
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      // No file yet is the ordinary state on a fresh install.
      if (e?.code !== 'ENOENT') {
        console.error(`[AgentRegistry] Could not read ${this.file}: ${e?.message ?? String(e)}`);
      }
      return { entries, unreadable: scan.unreadable };
    }
    classifyLog(text, scan, entries);
    return { entries, unreadable: scan.unreadable };
  }

  /**
   * The rows in this registry that this daemon cannot read — the disclosure
   * `list_agents` and `daemon_status` publish.
   *
   * Re-read per call rather than cached from boot, deliberately: an operator
   * who repairs a line must see the disclosure clear WITHOUT restarting the
   * daemon, and a cached answer would go on reporting a row that is no longer
   * there. Callers that are already reading the log for something else should
   * take both from {@link read} instead of calling this.
   */
  public unreadable(): UnreadableRecord[] {
    return this.read().unreadable;
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
    return AgentRegistry.intentsFrom(this.readLog());
  }

  /**
   * {@link intents}, from a log the caller has already read.
   *
   * The same split as {@link preemptedFrom} and for the same reason: reading
   * the log is a whole-file read and parse, and the paths that ask it several
   * questions at once should pay for one. `intents()` above is the one-caller
   * convenience; every path that already holds the rows calls this and passes
   * them.
   *
   * `static` is load-bearing rather than stylistic. A method with no `this`
   * cannot quietly re-read the file, which is exactly how the four passes this
   * function exists to remove got there: three helpers that each took no
   * argument and each called `intents()`.
   */
  public static intentsFrom(entries: AgentLogEntry[]): Map<string, AgentIntent> {
    const intents = new Map<string, AgentIntent>();
    for (const entry of entries) {
      if (entry.event === 'forgotten') {
        intents.delete(entry.path);
        continue;
      }
      // `v`, `preemption`, `wasPreempted` and `everActivated` are pulled out
      // rather than left in the rest: `record` is what a later activation is
      // rebuilt from, and it must not carry the reason a previous stand-down
      // happened — nor a marker about it, which would then travel into the
      // record of an agent somebody simply switched back on. `v` is the file's
      // business, not the record's, and `everActivated` is a fact about the
      // path rather than about the configuration frozen onto it.
      //
      // `activatedBy` is deliberately NOT in that list and stays in `record`:
      // it is part of who the agent IS, not of the event that happened to it.
      // Pulling it out here is the single edit that would silently orphan a
      // whole fleet — the record a later activation is rebuilt from would stop
      // carrying a parent, every carried row would drop it at the next
      // compaction, and the field would go on being emitted as `null`
      // everywhere, looking exactly like a fleet nobody supervises.
      // `verify-activated-by.mjs` §8 is what turns that edit red.
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
        // Normalized here and NOWHERE ELSE, so no consumer has to know that an
        // older row can be missing them. See AgentIntent.configVersion.
        configVersion: record.configVersion ?? 1,
        configuredAt: record.configuredAt ?? null,
        // Always stated, never conditional: see AgentIntent.everActivated for
        // why an absent value would mean two different things to its two
        // consumers.
        everActivated: ran,
        ...(preemption ? { preemption } : {}),
        ...(wasPreempted ? { wasPreempted: true } : {})
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
   * memory and no turn to take. That is the KAN-21 (in the extraction source)
   * idle-forever failure, reached through the one path that was supposed to
   * have been made safe — and `standbyAgents` was meanwhile telling the reader
   * that switching it on "resumes the conversation it was stopped in."
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
   *
   * Takes the intent map rather than reading one, and is `static` so it cannot
   * go back to reading one. See {@link AgentRegistry.intentsFrom}.
   */
  private static activatedToPreserve(intents: Map<string, AgentIntent>): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of intents.values()) {
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
   * THE RULE IS ABOUT ROWS; THERE IS A SECOND ONE ABOUT FIELDS. All three
   * preserve sets carry the record with `...intent.record`, so a field ADDED to
   * {@link AgentRecord} survives compaction with no edit here — which is how
   * `config` survives, and how `activatedBy` does. What that spread cannot
   * defend against is a field being pulled OUT of the record upstream, in
   * {@link AgentRegistry.intents}; there is a note there saying so. Neither is
   * a claim to take on trust: `verify-activated-by.mjs` §6 drives a real log
   * past the 500-record threshold and reads the parent back out of the
   * rewritten file, because "it rides on the spread" is a sentence and the log
   * on disk is the fact.
   *
   * Takes the intent map rather than reading one; see
   * {@link AgentRegistry.activatedToPreserve}.
   *
   * Unbounded on purpose, unlike {@link standbyToPreserve}: a standby row is a
   * control offering a way back to work that still exists, and an old one is
   * history rather than a control. A `configured` row is the agent. Clipping it
   * would delete agents.
   */
  private static configuredToPreserve(intents: Map<string, AgentIntent>): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of intents.values()) {
      if (intent.event !== 'configured') continue;
      // A `configured`-last row is NOT always a never-run agent: reconfiguring
      // a stopped agent writes one, and that agent has a conversation on disk.
      // The compacted log is the only history left, so the fact travels with
      // the row or it is lost — and it is lost in two directions at once. The
      // resume rule would silently re-arm its protection against an agent whose
      // conversation genuinely is its own, so it would come back with no memory
      // and nobody would know why; and the fleet read would move it from
      // standby into `unstartedAgents`, promising a fresh start for an agent
      // that is about to resume. See AgentLogEntry.everActivated.
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
   *
   * Takes the intent map rather than reading one; see
   * {@link AgentRegistry.activatedToPreserve}.
   */
  private static standbyToPreserve(intents: Map<string, AgentIntent>): AgentLogEntry[] {
    const out: AgentLogEntry[] = [];
    for (const intent of intents.values()) {
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
        // The same argument once more, about a different fact. Written from
        // the intent rather than hardcoded to `true` so there is exactly one
        // derivation of it, in `intents()` — and "all but guaranteed" is the
        // right reading rather than "guaranteed", because a stand-down does
        // NOT strictly imply a prior activation: a durable write that failed
        // after an activation leaves a `configured`-last row over a live pane,
        // and standing THAT down records a deactivation for an agent whose log
        // never carried one. Carrying the derived answer is what keeps the
        // standby row's "resumes the conversation it was stopped in" promise
        // checkable in that case too.
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
   * before it pages — it turned that sort into an all-ties comparison, so the
   * first page held an *arbitrary* twenty-five rather than the newest ones.
   *
   * That third consequence is smaller than it was and has not gone away.
   * `list_agents` now breaks ties on the row's path, so an all-ties timestamp
   * gives a page that is stable and complete-if-walked (KAN-163) rather than
   * an arbitrary subset with no way past it — but "newest first" is still a
   * claim about these timestamps, and a page ordered by path is not the
   * ordering this daemon publishes. The guarantee only exists if the times are
   * real, and only the log knows them.
   *
   * ONE WHOLE-LOG READ, AND WHERE THAT MATTERS (KAN-96). This used to be four:
   * {@link compactIfLarge} read the log to decide whether to compact, and then
   * each of the three preserve sets called `intents()`, which reads and parses
   * the whole file again. Four passes, and — because compaction happens inside
   * {@link record} — four passes on the path an activation is blocked on. The
   * caller now passes the map it already built, and the preserve sets are
   * `static` so they have no `this` to re-read it through. Compaction from
   * `record()` therefore costs the one read `compactIfLarge` was taking
   * anyway; a direct `compact()` with no argument costs exactly one.
   *
   * The optional argument is not a micro-optimisation knob — it is the same
   * consistency argument {@link preemptedFrom} makes one file over: four reads
   * are also four *different* reads, and a compaction that decided what to
   * keep from a later parse than the one it sized the file with would be
   * rewriting the log against two disagreeing pictures of it.
   *
   * @param intents the reduction of the log this compaction should preserve.
   *        Defaults to reading the log once, for callers that do not have one.
   */
  /**
   * The verbatim source lines of every row {@link read} could not read.
   *
   * Separate from {@link UnreadableRecord.raw} on purpose, and the two must not
   * be confused: `raw` is a DISCLOSURE — capped at {@link UNREADABLE_RAW_LIMIT}
   * and re-serialized when a prompt had to be withheld — while this is what
   * goes back on disk, where a cap or a redaction would be data loss dressed as
   * caution. One of these values is for a reader and the other is the record.
   */
  private unreadableSourceLines(): string[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: string[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A torn line. Not carried: it is the one thing compaction has always
        // been allowed to drop, it holds no record anybody can name, and the
        // append-only design's whole torn-tail story is that it says nothing.
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (classifyRow(parsed, i + 1, trimmed)) out.push(trimmed);
    }
    return out;
  }

  public compact(intents: Map<string, AgentIntent> = this.intents()): RecordOutcome {
    const kept: AgentLogEntry[] = [
      ...AgentRegistry.configuredToPreserve(intents),
      ...AgentRegistry.activatedToPreserve(intents),
      ...AgentRegistry.standbyToPreserve(intents)
    ];
    // THE ROWS THIS DAEMON CANNOT READ GO BACK INTO THE FILE UNCHANGED, and
    // this line is the half of KAN-302 that is easiest to leave out and worst
    // to leave out.
    //
    // Compaction rewrites the log from the rows it could LOAD. Skipping an
    // unreadable row at read time therefore does not merely hide it — it
    // schedules its destruction, silently, at the 500th record. The daemon
    // would start (good), disclose the row (good), and then permanently delete
    // the durable record it was disclosing (the exact thing this ticket
    // objected to, arriving later and with nobody watching). "We do not delete
    // your registry" would have been true of the boot and false of the daemon.
    //
    // So they are carried across verbatim, ahead of the compacted rows: they
    // are the oldest lines in the file and they are not this daemon's to
    // reformat. Verbatim from the FILE rather than from the disclosure's
    // `raw`, which is capped and may have had a prompt removed — writing that
    // back would corrupt the very record this exists to protect.
    //
    // The extra read is paid only here, at most once per 500 records, on a
    // path that is already rewriting the whole file. The hot path is untouched.
    const preserved = this.unreadableSourceLines();
    const body = [...preserved, ...kept.map((entry) => JSON.stringify(entry))].join('\n');

    const temp = `${this.file}.compact-${process.pid}`;
    let fd: number | undefined;
    let dir: number | undefined;
    try {
      this.ensureDir();
      fd = fs.openSync(temp, 'w', 0o600);
      writeFully(fd, body.length ? body + '\n' : '');
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

  /**
   * THE ONE READ. Every record written pays this, and the 501st also pays a
   * compaction — so the rows are read here and handed on rather than re-read
   * by whatever decides what to keep. See {@link compact}.
   */
  private compactIfLarge(): void {
    try {
      const entries = this.readLog();
      const size = entries.length;
      if (size <= COMPACT_AFTER_RECORDS) return;
      if (this.retryCompactionAt !== null && size < this.retryCompactionAt) return;
      const outcome = this.compact(AgentRegistry.intentsFrom(entries));
      this.retryCompactionAt = outcome.ok ? null : size + COMPACT_AFTER_RECORDS;
    } catch {
      // Compaction is housekeeping; failing it must not fail an activation.
    }
  }
}
