// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import {
  PROMPT_FILENAME,
  builtinMcpServer,
  launcherDeliversRuntime,
  promptInstruction,
  resolveLauncher
} from './launchers.js';
import type { AgentLauncher } from './launchers.js';
import { diagnoseSpawnFailure } from './herdr-health.js';
import { EVIDENCE_TAIL_CHARS, landedCount, messageInComposer } from './delivery.js';
import type { SendEvidence, SendOutcome, SendVerdict } from './delivery.js';
import { agentsDirFor, canonicalizeOrNull, paneNameFor, sidecarDirFor } from './identity.js';
import {
  ProvisioningError,
  noteAgyMcpConfig,
  noteTrustEntry,
  provisionMcpConfig
} from './provisioning.js';
import type { ArtifactDisclosure } from './provisioning.js';
import type { AgentConfig } from './types.js';
import {
  RESUME_ENV,
  ResumeCause,
  degradedResumePrompt,
  hasRestorableConversation
} from './resume.js';

export interface HerdrSession {
  sessionId: string;
  /** The canonical directory this agent is. The identity; nothing else is. */
  path: string;
  /** The opaque herdr token for that path. Nothing parses it back out. */
  paneName: string;
  createdAt: Date;
  status: 'initializing' | 'active' | 'terminated';
  ptyProcess?: pty.IPty;
  ptyBuffer: string;
  onDataListeners: Array<(data: string) => void>;
  /**
   * Set when `herdr agent start` failed, to herdr's own message plus whatever
   * we can say about the cause. Its presence is the difference between "this
   * agent is quiet" and "this agent was never created": callers report it
   * instead of claiming an activation that did not happen.
   */
  spawnError?: string;
  /**
   * Set when this session was started to bring an agent back after its machine
   * or daemon died under it, rather than to start fresh work.
   */
  resume?: ResumeCause;
  /**
   * On a resume, whether a conversation was there to restore — decided before
   * the spawn by {@link hasRestorableConversation}.
   *
   * `true` means the agent comes back remembering everything and therefore
   * needs to be *told* to carry on, because Claude Code resumes at an empty
   * prompt and waits indefinitely. `false` means the launcher's fallback ran
   * with the degraded-resume prompt and the agent is already working. The
   * caller uses this to decide whether to nudge; undefined outside a resume.
   */
  resumedConversation?: boolean;
  /**
   * Whether a live agent runtime is what this session's launcher delivers.
   * False only for `shell`, where a bare prompt with no runtime behind the
   * pane is the delivered product. Set by initPty once the launcher is
   * resolved, and read wherever "does an agent exist here?" is answered: for
   * every other launcher, a pane herdr reports no runtime for is not an agent,
   * however many name registrations point at it (KAN-58, in the extraction
   * source).
   */
  expectsRuntime?: boolean;
  /**
   * Whether this activation was allowed to resume a conversation at this path.
   *
   * THE RESUME RULE, carried on the session because the launcher's command line
   * is built from it: `false` means the command starts a NEW session and no
   * `--continue` is passed. See resume.ts for what it is protecting against —
   * transcripts at a caller-owned path are very often a human's own.
   */
  mayResume?: boolean;
  /**
   * Every artifact this activation wrote or relied on OUTSIDE CrabCast's own
   * data directory, for the activation response to name.
   *
   * Silence is what made file-dropping unacceptable, so this is not decoration:
   * it is the "named in the activation response" half of what makes writing
   * into somebody else's directory acceptable at all. Empty is the ordinary
   * case — an agent that opted into nothing has nothing written for it.
   */
  provisioned?: ArtifactDisclosure[];
  /**
   * The RESOLVED MCP server definitions this activation wrote — caller-supplied
   * ones verbatim, plus any builtin CrabCast filled in.
   *
   * Set only once every requested server produced a definition. A launcher's
   * `setup` reads it rather than the raw request, so nothing downstream can see
   * a partially-resolved set and act on it as though it were complete.
   */
  mcpDefinitions?: Record<string, unknown>;
}

/**
 * herdr's own view of what an agent is doing, which is finer-grained than a
 * session's active/terminated bookkeeping: 'blocked' means the agent is
 * waiting on a human, which is the state a user most needs to see.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

const HERDR_AGENT_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

/** Ceiling on any single herdr CLI call, so a wedged herdr can't hang a caller. */
export const HERDR_CLI_TIMEOUT_MS = 5000;

/**
 * How long {@link HerdrBridge.confirmAgentPresent} keeps asking before it
 * declares a just-spawned agent absent.
 *
 * `herdr agent start` is synchronous — it returns once the pane exists — so a
 * successful spawn is normally in the census on the first ask and this costs
 * one CLI call. The wait exists for the gap between herdr acknowledging the
 * start and the agent being listable, not as a retry budget; five seconds is
 * far longer than that gap has ever been observed to be, and short enough that
 * a caller blocked on an activation is not left wondering.
 */
export const AGENT_CONFIRM_TIMEOUT_MS = 5000;

/**
 * How long {@link HerdrBridge.confirmAgentPresent} waits for a *runtime* to
 * appear behind the pane, when the launcher is one that delivers a runtime.
 *
 * Longer than {@link AGENT_CONFIRM_TIMEOUT_MS} because it covers a different
 * gap: not herdr registering the name — near-instant — but the launcher's
 * process chain actually reaching claude (`bash -c "claude --continue ||
 * claude …"`, where the `--continue` probe can exit and fall back before the
 * process herdr reports as the pane's agent exists). On the healthy path the
 * poll returns at the first census that shows the runtime, so this ceiling is
 * only ever paid in full when no agent is coming — the case where a slow
 * honest answer beats a fast false one (KAN-58, in the extraction source).
 *
 * Exported because the census's stale-session release (router.ts) must grant
 * a freshly spawned session at least this long before reading "no runtime
 * behind the pane" as death — inside this window that emptiness is the
 * ordinary state of an agent still booting, and the two deadlines drifting
 * apart would reopen the race.
 */
export const RUNTIME_CONFIRM_TIMEOUT_MS = 20000;

/** Gap between census checks while waiting for a spawned agent to appear. */
const AGENT_CONFIRM_POLL_MS = 250;

/**
 * Whether an agent actually exists, asked after a spawn herdr did not complain
 * about. The two failures are kept apart because they license different
 * actions: `absent` is evidence there is nothing there, and the session may be
 * torn down on the strength of it; `unverifiable` is the absence of evidence —
 * herdr did not answer — and nothing may be concluded, least of all that the
 * agent is dead.
 */
export type AgentPresence =
  | {
      present: true;
      /**
       * The pane herdr found it in, from the same census that confirmed it.
       * This is what becomes the record's durable binding, so it comes out of
       * the read that proved the agent exists rather than a second call that
       * could answer about a different moment.
       */
      paneId: string | null;
      waitedMs: number;
      checks: number;
    }
  | {
      present: false;
      reason: 'absent' | 'unverifiable';
      error: string;
      waitedMs: number;
      checks: number;
    };

/** An Error from {@link HerdrBridge.runHerdr}, carrying herdr's own error code. */
interface HerdrCliError extends Error {
  herdrCode?: string;
}

/**
 * herdr's code for "an agent by that name already exists". Starting an agent
 * is meant to be idempotent here — initPty checks for the agent first — but
 * the check and the start are two calls, so a concurrent activation can win
 * the race between them. That is a no-op, not a failure: the agent the caller
 * asked for exists either way.
 */
const AGENT_NAME_TAKEN = 'agent_name_taken';

/**
 * herdr's codes for "there is no such agent" and "there is no such pane".
 *
 * For a teardown these are the request already being satisfied, not a failure:
 * what the caller asked for is that the agent stop existing, and herdr saying
 * it does not exist is that. Every other error means we do not know what
 * happened, which is a different answer and must not be reported as this one.
 */
const AGENT_NOT_FOUND = 'agent_not_found';
const PANE_NOT_FOUND = 'pane_not_found';

/** Time the agent's TUI gets to redraw after the interrupt, before we type. */
const INTERRUPT_SETTLE_MS = 100;

/**
 * How long a sent message gets to appear as SUBMITTED output before the send
 * gives up on seeing it.
 *
 * Paid in full only when a message did not land, which is the case where a slow
 * honest answer beats a fast false one — the same trade
 * {@link RUNTIME_CONFIRM_TIMEOUT_MS} makes one layer up. On the healthy path
 * Claude Code echoes a submitted message within a poll or two, so a delivered
 * send costs a couple of `agent read` calls rather than the whole budget.
 */
const DELIVERY_CONFIRM_TIMEOUT_MS = 10_000;

/** Gap between pane reads while waiting for a message to appear as submitted. */
const DELIVERY_CONFIRM_POLL_MS = 500;

/**
 * Enough tail to hold a long message's echo and the composer beneath it.
 * Larger than {@link TAIL_DEFAULT_LINES} because the composer has to be on
 * screen for the positional test to mean anything: a window that stops above it
 * would put unsent text on the submitted side and confirm the very failure this
 * is looking for.
 */
const DELIVERY_TAIL_LINES = 60;

/** The tail carried back as evidence, bounded so a response cannot be a scrollback. */
function capTail(tail: string | null): string | null {
  return tail === null ? null : tail.slice(-EVIDENCE_TAIL_CHARS);
}

/** What a confirmed-absent send tells its caller, including what to do next. */
function notDeliveredMessage(paneName: string, timeoutMs: number, inComposer: boolean): string {
  return inComposer
    ? `NOT DELIVERED to '${paneName}': the message is sitting UNSUBMITTED in the agent's ` +
      `composer ${timeoutMs}ms after Enter was pressed twice, so the agent has not seen a word ` +
      `of it. The text is on screen, which is why this looks delivered to anyone glancing at ` +
      `the pane. Nothing further was typed; send again if you still want it there.`
    : `NOT DELIVERED to '${paneName}': the pane was read and this message is not in it as ` +
      `submitted output ${timeoutMs}ms after it was typed, and it is not in the composer ` +
      `either. The agent did not receive it. This is evidence of absence, not a failure to ` +
      `look — the pane answered.`;
}

/** What an unconfirmable send tells its caller, and what it must not conclude. */
function unverifiableMessage(paneName: string, timeoutMs: number, readError?: string): string {
  return (
    `UNVERIFIABLE for '${paneName}': the message was typed and submitted, but the pane could ` +
    `not be read for ${timeoutMs}ms afterwards${readError ? ` (${readError})` : ''}, so whether ` +
    `it landed is unknown. THIS IS NOT A FAILED SEND — the agent may well have it. Do not ` +
    `record it as undelivered and do not assume it arrived; read the agent once herdr is ` +
    `answering again.`
  );
}

/** How much of an agent's terminal a tail returns when the caller doesn't say. */
const TAIL_DEFAULT_LINES = 40;

/** Ceiling on a tail, so one call can't drag a whole scrollback over the wire. */
const TAIL_MAX_LINES = 200;

/**
 * What herdr prints to the attach it is evicting. We match on it to tell the
 * user *why* their terminal stopped, rather than showing a dead pane and
 * letting them guess.
 */
const TAKEOVER_NOTICE = 'terminal attach taken over';

/** How much of the tail of a dead PTY we search for herdr's parting message. */
const EXIT_REASON_SCAN_CHARS = 2000;

/** Why a session's PTY is no longer streaming. */
export type SessionEndReason = 'taken-over' | 'exited';

/**
 * A tab opened for one agent to live in. The terminal id is carried alongside
 * the tab id because it is the only handle here that stays valid: herdr's tab
 * and pane ids are positions in lists that compact whenever anything earlier
 * closes, while a terminal id belongs to the terminal for as long as it runs.
 */
interface AgentTab {
  tabId: string;
  workspaceId: string;
  /** The shell `herdr tab create` opens the tab on, which the agent replaces. */
  placeholderTerminalId: string;
}

/** Told to clients when a PTY dies, so a dead terminal never renders as a live one. */
export interface SessionEndedEvent {
  path: string;
  paneName: string;
  sessionId: string;
  reason: SessionEndReason;
  exitCode: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toAgentStatus(value: unknown): HerdrAgentStatus {
  return HERDR_AGENT_STATUSES.includes(value as HerdrAgentStatus)
    ? (value as HerdrAgentStatus)
    : 'unknown';
}

function parseJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clampTailLines(lines: unknown): number {
  const requested = typeof lines === 'number' && Number.isFinite(lines)
    ? Math.floor(lines)
    : TAIL_DEFAULT_LINES;
  return Math.min(Math.max(requested, 1), TAIL_MAX_LINES);
}

/**
 * One entry of `herdr agent list` — herdr's own record of a pane, independent
 * of anything this daemon remembers.
 *
 * `agentRuntime` is herdr's `agent` field: the CLI it launched in the pane
 * (`claude`), absent for a pane running a bare shell. It is the only evidence
 * available for whether a pane has an agent behind it at all, which is what
 * separates a live agent from one of the shell panes left over on the board.
 * Absent stays null; nothing is inferred from the name.
 *
 * `workDir` is herdr's `cwd`, kept as the arbitrary string herdr reported.
 * `canonicalWorkDir` is that string put through the same canonicalizer our own
 * path went through, and null when it would not resolve. Both are carried
 * because they answer different questions: the raw one is what a human sees in
 * a refusal, the canonical one is the only form that may be compared.
 */
export interface HerdrAgentRecord {
  name: string;
  /**
   * herdr's `pane_id`, when its census reports one. Null is a real answer and
   * not an error — it means this pane cannot be *bound* as ours (the durable
   * binding is a pane id), but it can still be an occupant, because occupancy
   * is a question about the directory rather than about identity.
   */
  paneId: string | null;
  agentRuntime: string | null;
  workDir: string | null;
  canonicalWorkDir: string | null;
  herdrStatus: HerdrAgentStatus;
}

/** One census read, and whether herdr actually answered it. */
export interface HerdrCensus {
  reachable: boolean;
  agents: HerdrAgentRecord[];
}

/** A live pane sitting in a directory, as a refusal names it. */
export interface PaneOccupant {
  paneId: string | null;
  name: string;
  agentStatus: HerdrAgentStatus;
  workDir: string | null;
}

/**
 * What one census read says about a directory.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one that would otherwise fail
 * silently. `listHerdrAgentsChecked` returns an EMPTY census when herdr does
 * not answer, so a check built the obvious way would read its own failure as
 * "nothing is there" and spawn into an occupied directory precisely when it
 * cannot see it. `reachable: false` is silence, not evidence.
 *
 * This mirrors {@link HerdrBridge.confirmAgentPresent}'s existing
 * absent/unverifiable split; the codebase already draws this distinction one
 * layer up, for liveness, and this is the same rule asked about occupancy.
 */
export type Occupancy =
  | { reachable: false }
  | {
      reachable: true;
      /**
       * Live panes whose canonical cwd is this directory, whosever they are.
       * This answers "is anything running HERE" and nothing else.
       */
      occupants: PaneOccupant[];
      /**
       * OUR pane, when the census has one — the single ownership test in this
       * daemon. Null means the census answered and this agent is not running.
       *
       * It is deliberately NOT drawn from `occupants`: see
       * {@link HerdrBridge.occupancyOf} for why "is this ours" and "is
       * anything here" are different questions with different evidence.
       */
      ours: HerdrAgentRecord | null;
    };

/**
 * THE ownership test. One function, one answer, and nothing else in this
 * daemon may decide whether a pane is ours.
 *
 * A pane is ours when the census holds one whose herdr NAME is the name this
 * path derives, and it has a live runtime. The name is forward-computed from
 * the path we already hold ({@link paneNameFor}), it is minted by nothing but
 * this daemon, and herdr keeps names unique — so at most one pane can answer,
 * and the answer does not depend on anything that can move.
 *
 * WHAT THIS REPLACED, AND WHY, because the replaced version looked more
 * careful and was not.
 *
 * The design specified three facts agreeing: the RECORDED `paneId` appears in
 * the census, that pane's canonical `cwd` equals our recorded path, and it has
 * a runtime. It was guarding against a stale id pointing at a stranger's pane
 * — a false positive, which three facts do catch.
 *
 * The failure it walked into is the opposite one. **herdr pane ids are
 * positions in a list that compacts whenever any pane anywhere closes** — this
 * file says so itself, in {@link HerdrBridge.closeTabPlaceholder}, which
 * re-resolves by terminal id for exactly that reason. So an unrelated agent
 * finishing two tabs over renumbers ours, the persisted id stops matching, and
 * "is this ours" answers NO about our own live agent. With refuse-on-occupied
 * built on top, that is not a cosmetic wrong answer: `activate` then reports
 * our own agent as a foreign occupant and refuses to start it, permanently,
 * while telling the caller that CrabCast never closes a pane it did not start.
 * `confirmAgentPresent` answering `paneId: null` — a legitimate answer —
 * reached the same dead end with no renumbering at all.
 *
 * It was measured, not deduced: activating two agents and deactivating the
 * first renumbered the second's pane from `…-12` to `…-11` on herdr 0.6.4.
 *
 * SO THE TWO QUESTIONS ARE SPLIT, and that is the substance of the fix rather
 * than a smaller version of the old test:
 *
 *   - **"Is this pane ours?"** is answered by the NAME. A name is fixed when
 *     the pane is created and cannot be changed by anything happening
 *     elsewhere — including by the agent itself.
 *   - **"Is anything live in this directory?"** is answered by the canonical
 *     `cwd`, and only ever by that. It is a property of a running process,
 *     which can `cd`; using it to decide ownership meant an agent could
 *     disown itself by changing directory.
 *
 * The design's rule survives and is strengthened: a pane is still never
 * claimed on `cwd` alone. It is now never claimed on `cwd` at all.
 *
 * `paneId` is consequently NOT stored on the durable record any more. A
 * volatile value in durable storage is the defect itself, not a detail of it;
 * every pane id this daemon reports is read live from the census that produced
 * it.
 *
 * ---
 *
 * WHAT THIS DOES NOT ANSWER, and the reason a regression got in behind it
 * (KAN-136). There are TWO questions here and they are not the same fact:
 *
 *   1. **"Is this pane ours?"** — an OWNERSHIP question, about the world.
 *      Answered here, by name, and there must be exactly one test for it.
 *   2. **"Do we hold its terminal?"** — an ATTACHMENT question, about THIS
 *      daemon process. Answered by {@link HerdrBridge.getSessionByPath}, and
 *      nowhere else.
 *
 * A daemon restart is precisely the state where they disagree: every pane is
 * still ours and not one of them is attached, because herdr owns the panes and
 * the session map died with the process. Answering (2) with this function
 * therefore reads "the fleet survived" as "the fleet needs nothing" — reconcile
 * left every agent alone and `activate` returned no session id, so a restart
 * left the whole fleet permanently unreachable. Two callers need BOTH answers
 * and must ask both:
 *
 *   - `reconcile` — restore unless recognised AND attached;
 *   - `handleActivate` — the `occupancy.ours` branch starts nothing, but it
 *     still attaches when we hold no session.
 *
 * `list_agents` and `forget` correctly need only (1): one reports what exists,
 * the other decides whether erasing a record would orphan something. Neither
 * is about whether we can currently type into it.
 */
export function ourPaneIn(
  census: HerdrCensus,
  agentPath: string,
  launcher?: string
): HerdrAgentRecord | null {
  if (!census.reachable) return null;
  const paneName = paneNameFor(agentPath);
  const pane = census.agents.find((a) => a.name === paneName);
  if (!pane) return null;
  // What "alive" means depends on the launcher, exactly as it does for
  // `confirmAgentPresent`: for everything but `shell`, a name registration
  // over a pane with no runtime is not an agent (KAN-58, in the extraction
  // source). For `shell` the name IS all there is to see, and requiring a
  // runtime unconditionally made every shell agent permanently unrecognisable
  // as its own — the same shape of always-false ownership answer as the
  // pane-id bug, found by running the live proof rather than by reading.
  if (launcherDeliversRuntime(launcher) && pane.agentRuntime === null) return null;
  return pane;
}

export class HerdrBridge {
  private sessions: Map<string, HerdrSession> = new Map();

  /** Set by the daemon so a dying PTY can be announced to connected clients. */
  private sessionEndedListener?: (event: SessionEndedEvent) => void;

  /**
   * `dataDir` from `crabcast.config.json` — where each agent's sidecar lives.
   * NOTHING under it is a workspace any more: an agent's working directory
   * comes from the caller and this daemon never allocates one.
   *
   * `configPath` is the file that config was loaded from, baked into each
   * agent's `crabcast` MCP definition so the server it spawns addresses this
   * daemon rather than whichever one the default data dir holds.
   */
  constructor(private dataDir: string, private configPath?: string) {}

  public setSessionEndedListener(listener: (event: SessionEndedEvent) => void): void {
    this.sessionEndedListener = listener;
  }

  /** Where CrabCast's own state for this agent lives. See identity.ts. */
  public sidecarDirFor(agentPath: string): string {
    return sidecarDirFor(this.dataDir, agentPath);
  }

  /**
   * Where EVERY agent's sidecar lives, which `forget` needs in order to
   * reference-count the shared agy MCP key (KAN-140).
   *
   * Exposed next to `sidecarDirFor` rather than by having the router reach for
   * `dataDir` itself: the two answers have to come from the same layout, and a
   * census pointed at the wrong directory finds no claimants and removes a key
   * a live agent needs.
   */
  public agentsDir(): string {
    return agentsDirFor(this.dataDir);
  }

  /**
   * A session of ours that is currently attached to this agent's terminal.
   *
   * herdr allows exactly one terminal attach per terminal, so this is the
   * question that decides whether a new attach may use `--takeover`: an attach
   * we already own is a live client, and stealing it is the KAN-16 (in the
   * extraction source) freeze. A session with no `ptyProcess` never got one
   * (pty.spawn threw) and holds nothing.
   */
  private liveAttachFor(paneName: string): HerdrSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.status !== 'active' || !session.ptyProcess) continue;
      if (session.paneName === paneName) return session;
    }
    return undefined;
  }

  /**
   * Whether the launcher this activation will use restores a prior
   * conversation. Resolved the same way {@link initPty} resolves it, so the
   * question is answered about the launcher that actually runs.
   *
   * An unresolvable launcher answers `false` rather than throwing: initPty is
   * where an unknown name refuses the activation, through `spawnError`, and
   * this call happens first. Throwing here would move that refusal to a
   * different channel for no gain — and the answer is about to be irrelevant
   * anyway, because no agent is going to start.
   */
  private launcherRestoresConversation(launcher?: string): boolean {
    try {
      return resolveLauncher(launcher).launcher.restoresConversation === true;
    } catch {
      return false;
    }
  }

  /**
   * Start an agent in the directory it is.
   *
   * `promptContent` is the rendered bootstrap prompt, or undefined when the
   * agent was configured without one. It is written into the agent's SIDECAR,
   * never into the caller's directory: this is the first PR that spawns into a
   * directory somebody else owns, and a file we drop into it is a file we
   * would then have to be trusted to clean up.
   *
   * `ranBefore` is the resume rule's input and the caller must supply it — it
   * is a fact about the DURABLE RECORD, which the bridge cannot read. `false`
   * means CrabCast has never run an agent at this path, so any conversation on
   * disk there belongs to somebody else and nothing may continue it. See
   * resume.ts.
   */
  public spawnSession(
    agentPath: string,
    config: AgentConfig,
    promptContent?: string,
    resume?: ResumeCause,
    ranBefore: boolean = false
  ): HerdrSession {
    // One attach per agent, enforced here rather than in each caller. Two
    // clients can ask to activate the same agent at once, and a second attach
    // would evict the first, so the only safe answer is the session we have.
    const paneName = paneNameFor(agentPath);
    const existing = this.liveAttachFor(paneName);
    if (existing) {
      console.log(
        `[HerdrBridge] Reusing live session ${existing.sessionId} for ${paneName}; ` +
        `refusing to open a second attach that would evict it`
      );
      return existing;
    }

    const sessionId = `${paneName}-${Date.now()}`;

    console.log(`[HerdrBridge] Spawning PTY session: ${sessionId} in ${agentPath}`);

    // Asked *before* the spawn, because the directory is checked as it is now
    // and the launcher is about to write into it. It decides which resume
    // framing the agent gets, and — for the caller — whether the restored agent
    // will need to be told to carry on.
    //
    // Through the launcher, because hasRestorableConversation reads *Claude
    // Code's* transcript directory (see resume.ts) and knows nothing about any
    // other runtime's. `restoresConversation` is the launcher's own declaration
    // that its command restores a conversation *and* that this predictor is
    // evidence about it; a launcher that does not claim it gets `false`.
    // THE RESUME RULE, and it is asked before the predictor rather than after
    // it. `ranBefore` is whether OUR OWN record shows CrabCast running an agent
    // here before; a conversation at a path we have never run in is not ours to
    // continue, and at a caller-owned directory it is very often the human's.
    // See resume.ts for the whole of the reasoning.
    const mayResume = ranBefore;
    const restores = this.launcherRestoresConversation(config.launcher);
    // Gated on mayResume, so the predictor is never even consulted about
    // somebody else's transcripts. `hasRestorableConversation` reads a
    // directory keyed only on the path and cannot tell whose history it found.
    const resumedConversation = resume
      ? mayResume && restores && hasRestorableConversation(agentPath)
      : undefined;

    if (!mayResume) {
      console.log(
        `[HerdrBridge] ${paneName} starts a NEW session: CrabCast has no record of ever ` +
        `running an agent in ${agentPath}, so any conversation on disk there is not ours ` +
        `to continue`
      );
    }
    if (resume) {
      console.log(
        `[HerdrBridge] Resuming ${paneName} after ${resume}: ` +
        (resumedConversation
          ? 'a conversation is on disk, so --continue will restore it'
          : !mayResume
            ? 'this path has no prior CrabCast activation, so it will start with the degraded-resume prompt'
            : restores
              ? 'no conversation on disk, so it will start with the degraded-resume prompt'
              : "this launcher does not restore conversations, so it will start with the degraded-resume prompt")
      );
    }

    const session: HerdrSession = {
      sessionId,
      path: agentPath,
      paneName,
      createdAt: new Date(),
      status: 'active',
      ptyBuffer: '',
      onDataListeners: [],
      mayResume,
      ...(resume ? { resume, resumedConversation } : {})
    };

    this.sessions.set(sessionId, session);
    this.initPty(session, config, promptContent);

    return session;
  }

  /**
   * Start `paneName` in a herdr tab of its own, running `argv`.
   *
   * `herdr agent start` with no placement flags splits whatever pane is
   * current, so every agent landed in the one tab the human happened to be on.
   * Panes in a rendered tab are sized by the app's split layout, which divides
   * the terminal between them — at seven agents each pane was about four
   * columns wide and `agent read` came back one word per line, unreadable
   * exactly when a large fleet is what you need to supervise.
   *
   * A tab is the unit that fixes this because the app only lays out the tab it
   * is *rendering*. An agent sitting in a background tab keeps whatever size
   * its last attach asked for — the 80x24 the `pty.spawn` in {@link initPty}
   * requests — no matter how many other agents exist.
   *
   * herdr has no "start in a new tab" flag, so the tab is made first and the
   * agent placed into it. `tab create` opens the tab on a placeholder shell and
   * `agent start --tab` splits that, so the agent would get half a tab and
   * twice the file descriptors; {@link closeTabPlaceholder} takes the
   * placeholder back out again.
   */
  private startAgentInOwnTab(paneName: string, workDir: string, argv: string[]): void {
    const start = (placement: string[]) => this.runHerdr([
      'agent', 'start', paneName,
      '--cwd', workDir,
      ...placement,
      // Spawning is a background event; the human is usually reading something
      // else. herdr already defaults this way, but a default that flipped
      // would yank the screen away on every activation, so it is stated.
      '--no-focus',
      '--',
      ...argv
    ]);

    const tab = this.createAgentTab(paneName, workDir);
    if (!tab) {
      // No tab is a cosmetic loss; no agent is a broken activation. Spawn the
      // agent the old way rather than fail over where it gets drawn.
      start([]);
      return;
    }

    try {
      try {
        start(['--tab', tab.tabId]);
      } catch (e: any) {
        // The name being taken means the agent exists already — the caller
        // handles that, and retrying would start a second one.
        if ((e as HerdrCliError)?.herdrCode === AGENT_NAME_TAKEN) throw e;

        // Tab ids are positional and renumber whenever an earlier tab closes,
        // so the id we were just handed can go stale between the two calls.
        // Ours is always the newest and therefore the highest-numbered, so a
        // renumber can only leave it dangling — herdr answers
        // `agent_placement_not_found` and never resolves it to somebody else's
        // tab. Falling back keeps the spawn working through that race.
        console.error(
          `[HerdrBridge] Could not place ${paneName} in tab ${tab.tabId} ` +
          `(${e?.message ?? String(e)}); starting it in herdr's default placement instead`
        );
        start([]);
      }
    } finally {
      // Also on the failure paths: an abandoned tab would otherwise sit there
      // holding a shell nobody asked for.
      this.closeTabPlaceholder(tab);
    }
  }

  /**
   * Open a tab for an agent, labelled with the agent's pane name so the human
   * can tell the fleet apart at a glance. Returns undefined rather than
   * throwing — every caller can still spawn without one.
   */
  private createAgentTab(paneName: string, cwd: string): AgentTab | undefined {
    try {
      const result = this.runHerdr([
        'tab', 'create', '--cwd', cwd, '--label', paneName, '--no-focus'
      ])?.result;

      const tabId = result?.tab?.tab_id;
      const workspaceId = result?.root_pane?.workspace_id;
      const placeholderTerminalId = result?.root_pane?.terminal_id;
      if (typeof tabId !== 'string' || typeof workspaceId !== 'string' || typeof placeholderTerminalId !== 'string') {
        throw new Error('herdr tab create returned no usable tab');
      }

      return { tabId, workspaceId, placeholderTerminalId };
    } catch (e: any) {
      console.error(
        `[HerdrBridge] Could not create a tab for ${paneName} (${e?.message ?? String(e)}); ` +
        `it will share whichever tab herdr picks`
      );
      return undefined;
    }
  }

  /**
   * Close the shell `tab create` opened the tab on, leaving the agent alone in
   * it (or, when the agent went elsewhere, leaving an empty tab that herdr
   * then closes itself).
   *
   * The placeholder is found by terminal id, not by the pane id `tab create`
   * reported. Pane ids are positions in a list that compacts every time any
   * pane anywhere in the workspace closes — an agent finishing two tabs over
   * silently renumbers everything after it — while terminal ids are stable for
   * the life of the terminal. Re-resolving immediately before the close is
   * what keeps this from closing some other agent's pane.
   */
  private closeTabPlaceholder(tab: AgentTab): void {
    try {
      const panes = this.runHerdr(['pane', 'list', '--workspace', tab.workspaceId])?.result?.panes;
      const placeholder = Array.isArray(panes)
        ? panes.find((pane: any) => pane?.terminal_id === tab.placeholderTerminalId)
        : undefined;

      // Already gone: the human closed it, or the tab never survived.
      if (typeof placeholder?.pane_id !== 'string') return;

      this.runHerdr(['pane', 'close', placeholder.pane_id]);
    } catch (e: any) {
      // A stranded placeholder costs one idle shell, which is not worth
      // failing an otherwise good activation over.
      console.error(
        `[HerdrBridge] Could not close the placeholder pane in tab ${tab.tabId}: ` +
        `${e?.message ?? String(e)}`
      );
    }
  }

  /**
   * Render the agent's bootstrap prompt into its sidecar, and answer with the
   * absolute path the launcher should point at.
   *
   * INTO THE SIDECAR, NOT THE AGENT'S DIRECTORY. Under the old model the
   * working directory was allocated by CrabCast and dropping a
   * `.crabcast-prompt.md` into it cost nobody anything. The directory now
   * belongs to the caller — it is their repository checkout, their scratch
   * space — and a file written there is a file somebody has to remember to
   * remove. `<dataDir>/agents/<hash>/` is ours outright, so the prompt lives
   * there and the launcher is handed its absolute path.
   */
  private writeSidecarPrompt(session: HerdrSession, promptContent: string): string {
    const dir = this.sidecarDirFor(session.path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, PROMPT_FILENAME);
    fs.writeFileSync(file, promptContent);
    return file;
  }

  private initPty(session: HerdrSession, config: AgentConfig, initialPrompt?: string): void {
    const { paneName } = session;

    // Resolved before anything else happens. An unknown launcher refuses the
    // whole activation (KAN-53, in the extraction source), and it must do so
    // before anything is provisioned for an agent that will never exist. The
    // refusal travels as spawnError — the same channel a spawn herdr refused
    // uses — so activate answers `success: false` with the message naming the
    // valid launchers.
    let launcher: AgentLauncher;
    let launcherName: string;
    try {
      ({ name: launcherName, launcher } = resolveLauncher(config.launcher));
    } catch (e: any) {
      session.spawnError = e?.message ?? String(e);
      session.status = 'terminated';
      console.error(`[HerdrBridge] Refusing to start ${paneName}: ${session.spawnError}`);
      return;
    }

    // Recorded on the session because the question outlives this call: the
    // activation-confirmation path needs to know whether "no runtime behind
    // the pane" means "not an agent" (every real launcher) or "working as
    // asked" (`shell`).
    session.expectsRuntime = launcherDeliversRuntime(launcherName);

    // EVERYTHING WRITTEN OUTSIDE CRABCAST'S OWN DATA DIRECTORY IS COLLECTED
    // HERE, so the activation response can name all of it. See provisioning.ts
    // for the principle; this is where it is applied.
    const sidecarDir = this.sidecarDirFor(session.path);
    const disclosures: ArtifactDisclosure[] = [];
    session.provisioned = disclosures;

    // Workspace-scoped MCP config: consented to by being supplied, merged,
    // disclosed, reversible.
    //
    // RESOLUTION IS COUNTED, NOT FILTERED, and that sentence is the whole of
    // KAN-121. The chain this replaces filtered: `mcpServerDefinitions` kept
    // the names it recognised and dropped the rest without a word, and the
    // write early-returned on the resulting empty map — so asking for a server
    // this daemon could not supply produced a running agent with no tools, no
    // `.mcp.json` at all, and `success: true`. Three defensible steps composing
    // into a guard that read as a check and was not one.
    //
    // So: every requested key must produce exactly one definition, the count is
    // compared, and a shortfall REFUSES naming the servers that fell out.
    //
    // PARTIAL IS WORSE THAN EMPTY. A `.mcp.json` holding only the servers we
    // managed to write is a file whose PRESENCE LOOKS LIKE SUCCESS — the agent
    // starts, its runtime finds a config, and the missing tool is discovered
    // only by the work it silently cannot do. Nothing is written unless
    // everything can be.
    const requested = config.mcpServers ?? {};
    const requestedNames = Object.keys(requested);
    if (requestedNames.length > 0) {
      // `Object.create(null)` — see the note in router.ts's `parseAgentConfig`.
      // A server named `__proto__` assigned into a plain literal vanishes
      // silently, and the count comparison below is what would otherwise be
      // asked to notice a key that never arrived.
      const definitions: Record<string, unknown> = Object.create(null);
      const unsupplied: string[] = [];
      // Insertion order preserved: the caller's map is iterated in the order it
      // arrived and each value is carried across untouched, so "nothing is
      // resolved, renamed or reordered" holds by construction rather than by
      // care.
      for (const name of requestedNames) {
        const spec = requested[name];
        if (spec === 'builtin') {
          // `session.path` is what makes the identity per-agent: this file is
          // being written into that agent's own directory, so the daemon knows
          // exactly whose it is at the moment it writes it. See
          // `builtinMcpServer` — this argument is the whole supply of caller
          // identity in this system, and it is issued here.
          const builtin = builtinMcpServer(name, this.configPath, session.path);
          if (builtin === null) unsupplied.push(name);
          else definitions[name] = builtin;
          continue;
        }
        definitions[name] = spec;
      }

      if (unsupplied.length || Object.keys(definitions).length !== requestedNames.length) {
        session.spawnError =
          `Refusing to activate: ${unsupplied.length || 'some'} of the ${requestedNames.length} ` +
          `MCP server(s) this agent was configured with cannot be supplied` +
          (unsupplied.length ? ` — ${unsupplied.map((n) => `'${n}'`).join(', ')}` : '') +
          `. Starting anyway would write a .mcp.json holding only what could be produced, and a ` +
          `file that EXISTS looks like success: the agent would come up, its runtime would find a ` +
          `config, and the missing server would surface as work it quietly cannot do. NOTHING WAS ` +
          `WRITTEN and nothing was started. Send a definition for it — ` +
          `{"command": "…", "args": [], "env": {}} — rather than asking CrabCast to supply it.`;
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${paneName}: ${session.spawnError}`);
        return;
      }

      try {
        disclosures.push(
          ...provisionMcpConfig({ agentPath: session.path, sidecarDir, definitions })
        );
      } catch (e: any) {
        // KAN-84's lesson (in the extraction source), and the reason this is a
        // refusal rather than a logged warning: a swallowed provisioning
        // failure once let an uninstructed agent start behind `verified:
        // true`.
        session.spawnError =
          e instanceof ProvisioningError
            ? e.message
            : `Could not provision ${session.path}: ${e?.message ?? String(e)}. NOTHING WAS STARTED.`;
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${paneName}: ${session.spawnError}`);
        return;
      }
      session.mcpDefinitions = definitions;
    }

    // Agent-specific provisioning, on every activation: it is idempotent, and
    // a setup that throws refuses the activation (KAN-54, in the extraction
    // source) — provisioning that demonstrably did not stick, the folder trust
    // entry above all, would otherwise spawn an agent wedged on a startup
    // dialog behind a `success: true, verified: true` answer.
    if (launcher.setup) {
      try {
        launcher.setup({
          workDir: session.path,
          mcpServers: session.mcpDefinitions ?? {},
          // Both directories, for the agy launcher's foreign-key refusal
          // (KAN-178). It is deciding whether a key already in the SHARED
          // global config is CrabCast's or the user's, and that question is
          // answered from the provenance records: ours, plus every sibling's.
          // Omitting either would make the answer "cannot tell", which refuses
          // — so these are what keep an ordinary activation ordinary.
          sidecarDir,
          agentsDir: this.agentsDir(),
          // What the launcher wrote outside our data dir. The trust entry is
          // the whole reason this channel exists: it is written by the claude
          // launcher, into the user's GLOBAL config, and neither this bridge
          // nor the router would otherwise know it had happened.
          note: (artifact) => {
            if (artifact.kind === 'agy-mcp') {
              // NULL WHEN NOTHING WAS WRITTEN, and that is the whole of the fix
              // this branch received. The disclosure used to be pushed after
              // this call unconditionally, from the bridge's own knowledge that
              // an agy agent had definitions — so an unparseable or unwritable
              // global config produced an activation response naming a merge
              // into a file CrabCast had not touched. `configureAgyMcp` reports
              // the outcome now, and a non-write discloses nothing and records
              // nothing. The reason is on the daemon's log where the failure is.
              const agy = noteAgyMcpConfig({
                agentPath: session.path,
                sidecarDir,
                file: artifact.file,
                keys: artifact.keys
              });
              if (agy) disclosures.push(agy);
              return;
            }
            disclosures.push(
              noteTrustEntry({
                agentPath: session.path,
                sidecarDir,
                file: artifact.file,
                trustKey: artifact.trustKey,
                wroteIt: artifact.wroteIt
              })
            );
          }
        });
      } catch (e: any) {
        session.spawnError = e?.message ?? String(e);
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${paneName}: ${session.spawnError}`);
        return;
      }
    }

    // WHAT USED TO BE HERE: the anti-gravity global-config disclosure, built
    // by this bridge from `session.mcpDefinitions` — the servers the agent was
    // CONFIGURED with — rather than from anything the launcher reported having
    // written. It was pushed whenever an agy agent had definitions, so it
    // claimed a merge into the user's global config on every activation where
    // `configureAgyMcp` had silently declined to write one: an unparseable
    // config, or a write that failed. The response named a file, keys and a
    // manual removal for an edit nobody had made.
    //
    // Nothing was wrong with `configureAgyMcp` — it was refusing correctly and
    // logging why. The gap was between it and this block, and no code owned it:
    // one function knew what happened and the other did the announcing.
    //
    // So the announcement moved to where the knowledge is. The launcher's
    // `setup` reports through `note` above, exactly as the claude launcher's
    // trust entry does, and `noteAgyMcpConfig` (provisioning.ts) records the
    // provenance that makes `forget` able to take it back out. See KAN-140.

    // A write that fails refuses the activation, on the same spawnError
    // channel as every other provisioning failure here. The agent's first
    // instruction is to read this file, so spawning without it would start an
    // agent with no instructions behind a `success: true, verified: true`
    // answer — a check that renders its own failure as an all-clear.
    let promptFile: string | undefined;
    if (initialPrompt) {
      try {
        promptFile = this.writeSidecarPrompt(session, initialPrompt);
      } catch (e: any) {
        session.spawnError =
          `Could not write the bootstrap prompt into ${this.sidecarDirFor(session.path)}: ` +
          `${e?.message ?? String(e)}. The agent's first instruction is to read that file, so an ` +
          `agent spawned without it would sit with no instructions behind a success answer. ` +
          `Nothing was started.`;
        session.status = 'terminated';
        console.error(`[HerdrBridge] Refusing to start ${paneName}: ${session.spawnError}`);
        return;
      }
    }

    // Whether to spawn is decided by what is *behind* the name, not by whether
    // the name is taken. herdr keeps a name registration for any pane it ever
    // started an agent into — including panes restored after a reboot as bare
    // shells with nothing running in them — so `herdr agent get` answering is
    // not evidence of an agent. The record's inner `agent` field is: it is
    // herdr's report of a live runtime in the pane. Reading mere registration
    // as existence skipped the launcher, attached this session to a dead
    // prompt, and still answered `verified: true` (KAN-58, in the extraction
    // source).
    let agentExists = false;
    let staleRecord: any;
    try {
      const record = this.runHerdr(['agent', 'get', paneName])?.result?.agent;
      if (record) {
        const backed = typeof record.agent === 'string' && record.agent !== '';
        if (backed || !session.expectsRuntime) agentExists = true;
        else staleRecord = record;
      }
    } catch (e) {
      // `agent_not_found` — the ordinary fresh start — and "herdr did not
      // answer" both land here, and both take the spawn path: for the second,
      // the spawn itself will surface herdr's error through spawnError rather
      // than this probe guessing at it.
    }

    // A stale registration blocks both roads: `agent start` would refuse the
    // taken name, and attaching would type at a dead shell. Release it the way
    // deactivate does — closing the pane drops the registration — so the
    // launcher actually runs. This is also the path our OWN dead pane takes:
    // the pane name is derived from the path, so a pane left over from a
    // previous run of this same agent is caught here by name, closed, and
    // respawned. (It is not an *occupant* either — occupancy requires a live
    // runtime — so the guard in activate lets it through to exactly this.)
    if (staleRecord) {
      console.log(
        `[HerdrBridge] ${paneName} is a herdr name registration with no agent behind it ` +
        `(pane ${staleRecord.pane_id ?? 'unknown'}, status ${staleRecord.agent_status ?? 'unknown'}); ` +
        `closing the stale pane and taking the spawn path`
      );
      try {
        if (typeof staleRecord.pane_id === 'string' && staleRecord.pane_id) {
          this.runHerdr(['pane', 'close', staleRecord.pane_id]);
        }
      } catch (e: any) {
        const code = (e as HerdrCliError)?.herdrCode;
        // Already gone is the outcome we wanted, not a failure.
        if (code !== PANE_NOT_FOUND && code !== AGENT_NOT_FOUND) {
          session.spawnError =
            `Pane name '${paneName}' is held by a stale herdr registration with no agent ` +
            `running behind it, and the stale pane could not be closed: ${e?.message ?? String(e)}. ` +
            `Nothing was started.`;
          session.status = 'terminated';
          console.error(`[HerdrBridge] Refusing to activate ${paneName}: ${session.spawnError}`);
          return;
        }
      }
    }

    if (!agentExists) {
      // What the agent is told when there is no conversation to continue. On a
      // resume with nothing on disk that must not be the cold-start prompt: an
      // agent greeted as if it were starting fresh would claim its work and
      // begin again, silently redoing — or conflicting with — work it had
      // already committed. See resume.ts.
      const coldStart = promptFile ? promptInstruction(promptFile) : undefined;
      const promptCommand =
        session.resume && session.resumedConversation === false
          ? degradedResumePrompt(session.path, session.resume, promptFile)
          : coldStart;

      // The last daemon-side moment to look (KAN-54, in the extraction
      // source). Between setup and here sit the prompt-file write and a
      // subprocess round-trip to `herdr agent get` — real time, in which a
      // sibling claude's boot write-back can erase the trust entry setup just
      // verified.
      if (launcher.preSpawnCheck) {
        try {
          launcher.preSpawnCheck(session.path);
        } catch (e: any) {
          session.spawnError = e?.message ?? String(e);
          session.status = 'terminated';
          console.error(`[HerdrBridge] Refusing to spawn ${paneName}: ${session.spawnError}`);
          return;
        }
      }

      try {
        // The pane inherits the herdr *server's* environment, not ours — and
        // that server is typically started at login with a thin PATH (no
        // nvm). Inject the daemon's normalized PATH so the agent and every
        // MCP server it spawns resolve the same tools we do. argv-level
        // `env` avoids shell quoting entirely.
        //
        // Routed through runHerdr so a refusal is raised rather than dropped.
        // A bare spawnSync whose result was discarded is the silent false
        // success in KAN-24 (in the extraction source).
        //
        // RESUME_ENV rides in on the same `env` invocation. It raises the two
        // thresholds behind Claude Code's "Resume from summary / Resume full
        // session" prompt, which otherwise appears whenever a resumed
        // conversation is both over 70 minutes old and over 100k tokens — the
        // exact shape of an agent that has been working all afternoon, and a
        // hard stop for one with nobody at the keyboard.
        this.startAgentInOwnTab(paneName, session.path, [
          'env',
          `PATH=${process.env.PATH}`,
          ...Object.entries(RESUME_ENV).map(([name, value]) => `${name}=${value}`),
          // `mayResume` is the resume rule reaching the only place it can be
          // enforced: with it false, the command carries no `--continue` and
          // the pane starts a new session rather than restoring whatever
          // transcript this directory happens to hold. See resume.ts.
          'bash', '-c', launcher.command({ promptCommand, mayResume: session.mayResume === true })
        ]);
      } catch (e: any) {
        if ((e as HerdrCliError)?.herdrCode === AGENT_NAME_TAKEN) {
          // Someone created it between our check and our start. Attach to it.
          console.log(`[HerdrBridge] Agent ${paneName} already existed; attaching to it`);
        } else {
          session.spawnError = diagnoseSpawnFailure(e?.message ?? String(e));
          // 'terminated' rather than 'active': there is no agent to attach to,
          // and a session left active would advertise a terminal that can never
          // produce output.
          session.status = 'terminated';
          console.error(
            `[HerdrBridge] Could not start herdr agent ${paneName}: ${session.spawnError}`
          );
          return;
        }
      }
    }

    this.attachPty(session);
  }

  /**
   * Take this session's terminal. The last step of {@link initPty}, and the
   * WHOLE of {@link attachSession} — which is the point of it being its own
   * function: attaching to an agent that is already running must not be a
   * spawn path with the spawn skipped, because every step before this one
   * (provisioning, the prompt file, `agent start`) is about creating an agent
   * that does not exist yet.
   */
  private attachPty(session: HerdrSession): void {
    const { paneName } = session;

    // `--takeover` evicts whoever already holds this agent's terminal attach,
    // and the evicted client is killed outright — which is exactly how a live
    // client froze (KAN-16, in the extraction source). The guard in
    // spawnSession is what actually prevents that, so by the time we get here
    // nothing of ours is attached and this resolves to true; it is kept as a
    // second line of defence for any future caller that reaches initPty
    // another way.
    //
    // ON THE RESTART PATH IT IS LOAD-BEARING RATHER THAN DEFENSIVE. The
    // daemon that died still had a PTY attached to this pane when it was
    // SIGKILLed, and herdr allows one attach per terminal; without
    // `--takeover` the fresh daemon's attach would be refused by a client
    // that no longer exists. `liveAttachFor` asks about OUR sessions, and a
    // daemon that just booted holds none, so this is true exactly when it
    // needs to be.
    const takeover = !this.liveAttachFor(paneName);
    const attachArgs = ['agent', 'attach', paneName, ...(takeover ? ['--takeover'] : [])];
    console.log(
      `[HerdrBridge] Attaching session ${session.sessionId} to ${paneName} ` +
      `(takeover=${takeover}): herdr ${attachArgs.join(' ')}`
    );

    try {
      const ptyProcess = pty.spawn('herdr', attachArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: session.path,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          // The agent's own address, for an MCP server spawned inside it. One
          // variable now, because there is one thing to say.
          //
          // THIS IS THE ATTACH PTY, AND IT IS NOT WHERE `activatedBy` COMES
          // FROM. Worth saying explicitly, because a variable of this name in
          // this position is precisely the shape of the bug Butchr filed
          // against their own build (KAN-145): identity read off the attaching
          // side answers "who is looking at this agent" rather than "who stood
          // it up".
          //
          // It is not that bug here, for two reasons, and both are load-bearing:
          //
          //  - The value is `session.path` — the agent this terminal is FOR,
          //    never the party doing the attaching. It cannot name an attacher,
          //    so it cannot answer the wrong question.
          //  - Nothing downstream reads it. The supervisor-of-record channel is
          //    the `crabcast` server definition written into the agent's own
          //    `.mcp.json` (see `builtinMcpServer`), which the agent's runtime
          //    spawns inside the agent's OWN pane. This pty runs `herdr agent
          //    attach`; what a human types into it executes over there, not here.
          //
          // The behavioural guarantee is enforced one layer up rather than by
          // this line: only a `configure` that creates an agent and an
          // `activate` that actually starts one pass a caller identity at all.
          // `verify-activated-by.mjs` §5 activates as A, converges and attaches
          // as B, and asserts the record still says A.
          CRABCAST_AGENT_PATH: session.path
        } as Record<string, string>
      });

      session.ptyProcess = ptyProcess;

      ptyProcess.onData((data: string) => {
        session.ptyBuffer = (session.ptyBuffer + data).slice(-100000);
        session.onDataListeners.forEach(fn => fn(data));
      });

      ptyProcess.onExit(({ exitCode }) => {
        // herdr's parting line is the only place the cause is recorded, so
        // read it off the buffer before anything else claims the exit.
        const tail = session.ptyBuffer.slice(-EXIT_REASON_SCAN_CHARS);
        const reason: SessionEndReason = tail.includes(TAKEOVER_NOTICE) ? 'taken-over' : 'exited';

        console.log(
          `[HerdrBridge] PTY for session ${session.sessionId} (${paneName}) ` +
          `exited with code ${exitCode}; reason=${reason}`
        );
        session.status = 'terminated';

        // Tell the clients. Without this a client keeps rendering the last
        // frame it received and looks like an agent that is merely quiet.
        this.sessionEndedListener?.({
          path: session.path,
          paneName,
          sessionId: session.sessionId,
          reason,
          exitCode
        });
      });
    } catch (e: any) {
      // No PTY means no attach: leaving the session 'active' would make
      // liveAttachFor claim an attach that does not exist, and every later
      // activate would be refused in favour of this dead session.
      session.status = 'terminated';
      // And recorded as a spawn failure, because that is what the caller has
      // to be told. Marking the session terminated without it produced the
      // second false success in KAN-23 (in the extraction source): activate
      // checks `spawnError` alone, so an attach that threw was answered with
      // `success: true` and, in the same object, `status: "terminated"`.
      session.spawnError =
        `Agent '${paneName}' could not be attached to: ${e?.message ?? String(e)}. ` +
        `The agent may be running in herdr, but this activation produced no usable terminal.`;
      console.error('[HerdrBridge] Failed to spawn PTY', e);
    }
  }

  /**
   * Take the terminal of an agent that is ALREADY RUNNING. Nothing is spawned,
   * nothing is provisioned, and the caller must have established from the
   * census that the pane is there and is ours before calling — this attaches
   * to a name and would otherwise be attaching to a hope.
   *
   * WHY THIS IS A SEPARATE VERB FROM {@link spawnSession} (KAN-136). A daemon
   * restart leaves every pane running and every session gone: herdr owns the
   * panes, the session map lives in the process that died. Bringing the fleet
   * back is therefore an ATTACH, not a start, and routing it through
   * `spawnSession` would take an activation path whose every earlier step —
   * `launcher.setup`, the workspace `.mcp.json`, the sidecar prompt file,
   * `herdr agent start` — is provisioning for an agent that does not exist.
   * Those steps are idempotent, so doing them would mostly be harmless; but
   * "mostly harmless" is not a reason to write into a caller's directory on
   * behalf of an agent that has been working in it for an hour, and a prompt
   * file whose write fails would refuse an activation that needed no prompt.
   *
   * WITHOUT THE ATTACH THERE IS NO WAY BACK. The session is what gives this
   * daemon a terminal to read, a terminal to type into, and — through
   * `ptyProcess.onExit` — the immediate `agent.detached` event that tells
   * clients the agent died. An agent recognised but not attached is one the
   * daemon can see and cannot reach: `list_agents` reports it `sessionless`,
   * every client is told to re-activate by path to obtain a session id, and
   * re-activating hands back no session id either. The only route to a live
   * attach becomes `deactivate` → `activate`, i.e. killing the agent you were
   * trying to reach.
   *
   * `launcher` decides {@link HerdrSession.expectsRuntime}, exactly as
   * {@link initPty} does, so a `shell` agent's runtime-free pane is not later
   * read as a dead session by the fleet census.
   */
  public attachSession(agentPath: string, launcher?: string): HerdrSession {
    const paneName = paneNameFor(agentPath);

    // The same guard spawnSession opens with, for the same reason: two callers
    // can ask for this agent at once, and a second attach evicts the first.
    const existing = this.liveAttachFor(paneName);
    if (existing) {
      console.log(
        `[HerdrBridge] Reusing live session ${existing.sessionId} for ${paneName}; ` +
        `refusing to open a second attach that would evict it`
      );
      return existing;
    }

    const session: HerdrSession = {
      sessionId: `${paneName}-${Date.now()}`,
      path: agentPath,
      paneName,
      createdAt: new Date(),
      status: 'active',
      ptyBuffer: '',
      onDataListeners: [],
      expectsRuntime: launcherDeliversRuntime(launcher)
    };

    console.log(
      `[HerdrBridge] Re-attaching to the surviving agent in ${agentPath}: ` +
      `session ${session.sessionId}, pane ${paneName}. Nothing is being started.`
    );

    this.sessions.set(session.sessionId, session);
    this.attachPty(session);

    return session;
  }

  public getSession(sessionId: string): HerdrSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** The live session for a canonical path, if this daemon holds one. */
  public getSessionByPath(agentPath: string): HerdrSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.status === 'active' && session.path === agentPath) return session;
    }
    return undefined;
  }

  public listActiveSessions(): HerdrSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }

  /**
   * Every agent herdr knows about. herdr is an optional external binary, so an
   * unavailable, slow, or unparseable herdr yields an empty list: callers
   * degrade rather than fail.
   *
   * An empty list therefore means "herdr told us nothing", which is not the
   * same claim as "there are no agents" — callers that report to a human must
   * not turn one into the other.
   */
  public listHerdrAgents(): HerdrAgentRecord[] {
    return this.listHerdrAgentsChecked().agents;
  }

  /**
   * The same census as {@link listHerdrAgents}, but saying whether herdr
   * actually answered.
   *
   * Both facts come out of one `herdr agent list`, on purpose. A caller that
   * needs to know "is this agent still there?" has to distinguish an absent
   * name from an absent herdr, and asking that as a second call would let herdr
   * die between the two — producing exactly the false verdict the distinction
   * exists to prevent. `reachable: false` means the list below is silence, not
   * evidence, and nothing may be declared dead on the strength of it.
   *
   * IT IS ALSO WHERE OCCUPANCY IS ANSWERED FROM. Every pane is canonicalized
   * here, once, so that {@link occupancyOf} and the fleet census both compare
   * the same resolved strings. herdr reports `cwd` as an arbitrary string; a
   * symlinked pane cwd compared raw would look like a different directory from
   * the one it is actually sitting in.
   */
  public listHerdrAgentsChecked(): HerdrCensus {
    let output: string;
    try {
      output = execSync('herdr agent list', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      return { reachable: false, agents: [] };
    }

    try {
      const agents = JSON.parse(output)?.result?.agents;
      if (!Array.isArray(agents)) return { reachable: false, agents: [] };

      return {
        reachable: true,
        agents: agents
          .filter((agent: any) => agent && typeof agent.name === 'string')
          .map((agent: any) => {
            const workDir = typeof agent.cwd === 'string' ? agent.cwd : null;
            return {
              name: agent.name as string,
              paneId: typeof agent.pane_id === 'string' && agent.pane_id ? agent.pane_id : null,
              agentRuntime: typeof agent.agent === 'string' && agent.agent ? agent.agent : null,
              workDir,
              canonicalWorkDir: canonicalizeOrNull(workDir),
              herdrStatus: toAgentStatus(agent.agent_status)
            };
          })
      };
    } catch (e) {
      console.error('[HerdrBridge] Could not parse `herdr agent list` output', e);
      return { reachable: false, agents: [] };
    }
  }

  /**
   * What is live in a directory, from ONE census read.
   *
   * "NOT OURS" AND "NOTHING IS THERE" ARE DIFFERENT FACTS. ONLY THE CENSUS
   * ANSWERS THE SECOND, AND IT MUST BE ASKED SEPARATELY.
   *
   * That sentence is the whole reason this function exists next to the
   * three-fact binding rather than being derived from it. The two questions
   * read the same census and are *not* complements: the binding answers "is
   * this pane ours?", occupancy answers "is anything live in this directory?".
   * A freshly-`configure`d record has no recorded `paneId`, so the binding
   * says not-ours — and reading that as "nothing is there" would send
   * `activate` down the spawn branch straight into an occupied directory. The
   * path-derived pane name protects CrabCast against CrabCast; a foreign pane
   * has a foreign name and is invisible to it. Cutover is exactly the foreign
   * case for an entire fleet at once.
   *
   * OCCUPANTS are panes whose canonicalized `cwd` equals this path AND which
   * have a live runtime. A pane whose cwd cannot be canonicalized is not an
   * occupant: our path provably exists, so an unresolvable path is not it. Our
   * own DEAD pane is not an occupant either — it has no runtime, so it fails
   * both tests, and `activate` spawns (through initPty's stale-registration
   * release, which clears the name first).
   */
  public occupancyOf(census: HerdrCensus, agentPath: string, launcher?: string): Occupancy {
    if (!census.reachable) return { reachable: false };

    const occupants: PaneOccupant[] = [];
    for (const record of census.agents) {
      if (record.canonicalWorkDir !== agentPath) continue;
      if (record.agentRuntime === null) continue;
      occupants.push({
        paneId: record.paneId,
        name: record.name,
        agentStatus: record.herdrStatus,
        workDir: record.workDir
      });
    }

    return { reachable: true, occupants, ours: ourPaneIn(census, agentPath, launcher) };
  }

  /**
   * Does this agent exist? Asked after a spawn, before anyone is told the
   * activation succeeded.
   *
   * A spawn herdr refuses is reported through `spawnError`, and that covers
   * only the failures herdr *tells* us about. The failure this exists for is
   * the other one: herdr acknowledges the start and no agent is there
   * afterwards — the KAN-23 (in the extraction source) false success, where
   * `success: true` and a plausible session id were returned for an agent that
   * never existed.
   *
   * The world here is {@link listHerdrAgentsChecked} — the same census
   * `list_agents` reports from, deliberately, so that activate and the fleet
   * list can never disagree about whether an agent exists.
   *
   * `requireRuntime` is what "exists" means. herdr's census lists every name
   * registration, including panes that are bare shells with no agent process
   * behind them, so for any launcher that delivers a runtime, presence-by-name
   * is not presence (KAN-58, likewise in the extraction source). `false` is
   * for `shell` agents, where the name is all there is to see.
   *
   * It also returns the pane id from that same census read, because that id is
   * what becomes the record's durable binding — taking it from a second call
   * would bind to a different moment than the one that proved the agent there.
   */
  public async confirmAgentPresent(
    paneName: string,
    requireRuntime: boolean,
    timeoutMs: number = requireRuntime ? RUNTIME_CONFIRM_TIMEOUT_MS : AGENT_CONFIRM_TIMEOUT_MS
  ): Promise<AgentPresence> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let checks = 0;
    let reachable = false;
    let registered = false;

    for (;;) {
      const census = this.listHerdrAgentsChecked();
      checks++;
      reachable = census.reachable;

      if (reachable) {
        const record = census.agents.find(agent => agent.name === paneName);
        registered = record !== undefined;
        if (record && (!requireRuntime || record.agentRuntime !== null)) {
          return {
            present: true,
            paneId: record.paneId,
            waitedMs: Date.now() - startedAt,
            checks
          };
        }
      }

      if (Date.now() + AGENT_CONFIRM_POLL_MS >= deadline) break;
      await delay(AGENT_CONFIRM_POLL_MS);
    }

    const waitedMs = Date.now() - startedAt;
    // Which of the two failures this is turns on whether herdr answered at
    // all. An unreachable herdr produces an empty census, and reading that as
    // "the agent is not there" would be the same mistake in the other
    // direction: a confident claim with nothing behind it.
    return reachable
      ? {
          present: false,
          reason: 'absent',
          waitedMs,
          checks,
          error: registered
            ? `herdr has a pane registered under '${paneName}' but reported no agent runtime ` +
              `behind it for ${waitedMs}ms (${checks} checks): the pane is a shell, not a ` +
              `running agent. The launcher's command never became a live agent process. ` +
              `Check ~/.config/herdr/herdr-server.log and the pane itself for what it printed.`
            : `herdr reported no error starting agent '${paneName}', but the agent was not in ` +
              `\`herdr agent list\` ${waitedMs}ms and ${checks} checks later. No agent is running ` +
              `for this activation. Check ~/.config/herdr/herdr-server.log for the pane.spawn line ` +
              `covering this attempt.`
        }
      : {
          present: false,
          reason: 'unverifiable',
          waitedMs,
          checks,
          error:
            `Could not confirm agent '${paneName}' exists: herdr did not answer ` +
            `\`agent list\` within ${waitedMs}ms (${checks} attempts). The agent may or may not ` +
            `be running — this is an unverified activation, not a failed one, and nothing has ` +
            `been torn down. Check that the herdr server is up before retrying.`
        };
  }

  /**
   * Give up on a session whose agent is known not to exist.
   *
   * Without this the failure is sticky rather than merely reported: a session
   * left `active` is what {@link getSessionByPath} and {@link liveAttachFor}
   * answer with, so the next activate would be handed this dead session and
   * refuse to spawn a real one — the caller could never retry its way out.
   *
   * The pane is deliberately *not* closed. This is only ever called when herdr
   * has told us there is no such agent, so there is nothing to close; and
   * calling it on weaker evidence must not destroy somebody's working agent.
   * Our own terminal attach is killed because it is ours and it leads nowhere.
   */
  public abandonSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.spawnError = error;
    session.status = 'terminated';
    try {
      session.ptyProcess?.kill();
    } catch (e) {
      console.error(`[HerdrBridge] Could not kill the PTY for abandoned session ${sessionId}`, e);
    }
  }

  /**
   * Whether herdr's server is up and answering.
   *
   * {@link listHerdrAgents} deliberately flattens "herdr said nothing" and
   * "herdr has no agents" into an empty list, which is right for a status
   * display and wrong for boot-time reconciliation: there, the two answers lead
   * to opposite actions — wait, or start the whole fleet.
   */
  public herdrReachable(): boolean {
    try {
      this.runHerdr(['agent', 'list']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The pane id herdr currently reports for a pane name, or null.
   *
   * READ LIVE, never remembered: a pane id is a position in a list that
   * compacts whenever any pane anywhere closes, so a stored one goes stale
   * without anything happening to the agent it named. Callers that report a
   * pane id take it from the census that answered the question they were
   * actually asking.
   */
  public paneIdFor(paneName: string): string | null {
    return this.listHerdrAgents().find((a) => a.name === paneName)?.paneId ?? null;
  }

  /**
   * The same view as {@link listHerdrAgents}, keyed by pane name, for callers
   * that only want to decorate something they already have with a status.
   */
  public listHerdrStatuses(): Map<string, HerdrAgentStatus> {
    return new Map(this.listHerdrAgents().map(agent => [agent.name, agent.herdrStatus]));
  }

  /**
   * One herdr CLI call, argv-level so nothing we pass through (pane names,
   * arbitrary message text) is ever handed to a shell. Returns herdr's parsed
   * JSON and throws with herdr's own message on failure — herdr reports errors
   * as a nonzero exit plus an `error` object, on stdout for some commands and
   * on stderr for others, so both streams are worth reading before we fall
   * back to quoting a raw payload at the caller.
   */
  private runHerdr(args: string[]): any {
    const result = spawnSync('herdr', args, {
      encoding: 'utf8',
      timeout: HERDR_CLI_TIMEOUT_MS
    });

    if (result.error) {
      throw new Error(`herdr ${args.join(' ')} failed: ${result.error.message}`);
    }

    const stdout = (result.stdout ?? '').trim();
    const stderr = (result.stderr ?? '').trim();
    const json = parseJson(stdout);

    const reported = json?.error ?? parseJson(stderr)?.error;
    if (reported) {
      const error: HerdrCliError =
        new Error(reported.message ?? `herdr reported ${reported.code ?? 'an error'}`);
      // herdr's machine-readable code, kept alongside the message so callers
      // can distinguish kinds of failure without matching on prose.
      if (typeof reported.code === 'string') error.herdrCode = reported.code;
      throw error;
    }
    if (result.status !== 0) {
      throw new Error(stderr || `herdr ${args.join(' ')} exited with code ${result.status}`);
    }

    return json;
  }

  /**
   * `describeAgent` USED TO BE HERE, and is deleted rather than kept for a
   * caller that might want it (KAN-125).
   *
   * It asked herdr about ONE agent with `agent get`, and its only caller was
   * `agent_status`'s sessionless branch. That handler now answers from the same
   * census `list_agents` uses, because two herdr reads in one handler can
   * disagree and a status and a list taken together should describe one moment.
   * The census carries everything `agent get` returned — pane id, cwd, status —
   * so the second call bought nothing and cost a subprocess per status.
   *
   * Left as a note rather than as code: a public method with no callers is a
   * second way to ask a question this daemon has deliberately narrowed to one.
   */

  /**
   * The tail of an agent's terminal, as plain text. `recent-unwrapped` is the
   * source that shows what actually scrolled past — including the frozen last
   * frame of an agent whose process died, which is the state this exists to
   * make visible. Never throws; the caller owes its client a response.
   */
  public tailAgent(
    agentPath: string,
    lines?: number
  ): { success: boolean; text?: string; truncated?: boolean; error?: string } {
    const paneName = paneNameFor(agentPath);
    try {
      const read = this.runHerdr([
        'agent', 'read', paneName,
        '--source', 'recent-unwrapped',
        '--format', 'text',
        '--lines', String(clampTailLines(lines))
      ])?.result?.read;

      if (!read || typeof read.text !== 'string') {
        throw new Error(`herdr returned no readable output for agent '${paneName}'`);
      }

      return { success: true, text: read.text, truncated: read.truncated === true };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to tail agent at '${agentPath}':`, error);
      return { success: false, error };
    }
  }

  /**
   * Close the herdr pane an agent runs in. Returns false when herdr knows the
   * agent but it has no pane (already closed); throws with herdr's own message
   * when herdr is unreachable or does not know the agent at all.
   */
  private closePaneForAgent(paneName: string): boolean {
    const paneId = this.runHerdr(['agent', 'get', paneName])?.result?.agent?.pane_id;
    if (typeof paneId !== 'string' || !paneId) return false;

    this.runHerdr(['pane', 'close', paneId]);
    return true;
  }

  /**
   * Tear down the agent in a directory without needing a session. The session
   * map dies with the daemon while the herdr pane outlives it, so deactivate
   * resolves the pane from the path the same way every other read does. Never
   * throws — the caller is a request handler that owes its client a response.
   */
  public closeAgentByPath(
    agentPath: string
  ): { success: boolean; paneName: string; error?: string } {
    const paneName = paneNameFor(agentPath);
    try {
      if (!this.closePaneForAgent(paneName)) {
        return { success: false, paneName, error: `Agent '${paneName}' has no pane to close` };
      }
      return { success: true, paneName };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to close pane for agent '${paneName}':`, error);
      return { success: false, paneName, error };
    }
  }

  /**
   * One reading of a pane, as delivery evidence: how many submitted copies of
   * this message it holds, whether a copy is sitting unsent in the composer,
   * and — the field that keeps the other two honest — WHETHER IT COULD BE READ
   * AT ALL.
   *
   * A count of 0 from an unreadable pane is the defect this shape exists to
   * make unrepresentable. The primitive we borrowed this mechanism from returns
   * a bare number and answers 0 when the tail fails, so "nothing landed" and "I
   * could not look" are the same value to every caller downstream; an assertion
   * that a message did NOT land is then satisfied just as well by a pane nobody
   * could read. Readability is asserted at the point absence is asserted.
   */
  private readDeliveryEvidence(
    agentPath: string,
    message: string
  ): { readable: true; count: number; inComposer: boolean; tail: string }
    | { readable: false; error: string } {
    const tail = this.tailAgent(agentPath, DELIVERY_TAIL_LINES);
    if (!tail.success || typeof tail.text !== 'string') {
      return { readable: false, error: tail.error ?? `herdr returned no readable output for '${agentPath}'` };
    }
    return {
      readable: true,
      count: landedCount(tail.text, message),
      inComposer: messageInComposer(tail.text, message),
      tail: tail.text
    };
  }

  /**
   * Deliver a message to an agent's terminal the way a human would — clear
   * whatever is half-typed, type the message, submit it — AND THEN LOOK,
   * because the first three of those are things we did and only the fourth is a
   * fact about the agent.
   *
   * WHAT THIS RETURNS IS A CLAIM ABOUT THE RECIPIENT. The old version returned
   * `{success: true}` from any path that did not throw, having observed nothing
   * after the submit: it reported that keystrokes were dispatched and was read
   * as reporting that a message arrived. Those came apart three times in one
   * fleet in one day (KAN-114) — each time leaving the text visible in the
   * recipient's composer, which is why nobody noticed.
   *
   * THE RETRY PRESSES ENTER. IT DOES NOT TYPE AGAIN, and that is the whole
   * difference between a retry and a second interrupt. Exactly one Ctrl+C is
   * safe here; a second is how Claude Code quits, which would kill the very
   * agent we are trying to talk to. When the confirmation finds our text
   * sitting in the composer, the composer already holds everything that needs
   * to arrive — what is missing is the submit, and pressing Enter is precisely
   * what the human did by hand in the witnessed incident. `interrupts` is
   * reported so that constraint is auditable rather than promised.
   *
   * IT ALSO DOES NOT RETRY WHAT IT CANNOT SEE. An unreadable pane answers
   * `unverifiable` and stops: typing again at an agent we cannot observe is how
   * a bounded retry becomes a loop of interrupts at somebody's working agent.
   * A caller that wants another attempt calls again, which is a fresh send with
   * its own single Ctrl+C — that decision is the caller's, which is what
   * "expose confirm-or-retry to the caller" means.
   *
   * Never throws — the caller is a request handler that owes its client a
   * response either way.
   */
  public async sendToAgent(
    agentPath: string,
    message: string,
    opts: { confirmTimeoutMs?: number; pollMs?: number } = {}
  ): Promise<SendOutcome> {
    const confirmTimeoutMs = opts.confirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? DELIVERY_CONFIRM_POLL_MS;
    const paneName = paneNameFor(agentPath);
    const startedAt = Date.now();

    let interrupts = 0;
    let submits = 0;
    let checks = 0;

    /** The one place a verdict is built, so no branch can forget a field. */
    const outcome = (
      verdict: SendVerdict,
      evidence: Partial<SendEvidence> & Pick<SendEvidence, 'readable'>,
      error?: string
    ): SendOutcome => ({
      success: verdict === 'delivered',
      delivered: verdict === 'delivered',
      verdict,
      interrupts,
      submits,
      retried: submits > 1,
      evidence: {
        landedBefore: null,
        landedAfter: null,
        inComposer: false,
        checks,
        waitedMs: Date.now() - startedAt,
        tail: null,
        ...evidence
      },
      ...(error ? { error } : {})
    });

    // The baseline, taken BEFORE anything is typed. Without it a pane that
    // already held this text would report delivered while nothing landed — a
    // check passing on a coincidence. A baseline we could not read is not a
    // baseline of zero: it is no baseline, and it makes every later reading
    // unattributable, which is `unverifiable` rather than a guess in either
    // direction.
    const baseline = this.readDeliveryEvidence(agentPath, message);
    checks++;
    if (!baseline.readable) {
      const error =
        `Could not read agent '${paneName}' before sending, so whether this message arrived ` +
        `could not be established: ${baseline.error}. NOTHING WAS TYPED — a send whose delivery ` +
        `cannot be observed is not attempted, because the interrupt it begins with lands on a ` +
        `working agent whether or not we can see the result.`;
      console.error(`[HerdrBridge] ${error}`);
      return outcome('unverifiable', { readable: false, readError: baseline.error }, error);
    }
    const landedBefore = baseline.count;

    let paneId: string;
    try {
      const resolved = this.runHerdr(['agent', 'get', paneName])?.result?.agent?.pane_id;
      if (typeof resolved !== 'string' || !resolved) {
        throw new Error(`Agent '${paneName}' has no pane to send to`);
      }
      paneId = resolved;
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to resolve a pane for agent at '${agentPath}':`, error);
      // herdr NAMING the absence is evidence; herdr failing to answer is not.
      // The same two codes `terminateSession` treats as "already satisfied"
      // are the ones that mean there is genuinely nothing there to type into.
      const code = (e as HerdrCliError)?.herdrCode;
      const named = code === AGENT_NOT_FOUND || code === PANE_NOT_FOUND || /has no pane to send to/.test(error);
      return outcome(
        named ? 'not-delivered' : 'unverifiable',
        { readable: true, landedBefore, landedAfter: landedBefore, tail: capTail(baseline.tail) },
        named
          ? `Nothing was delivered to '${paneName}': ${error}. herdr says there is no pane there, ` +
            `so no keystroke was issued.`
          : `Could not tell whether '${paneName}' has a pane to send to: ${error}. Nothing was ` +
            `typed, and this is an unverified send rather than a failed one.`
      );
    }

    try {
      // Exactly one Ctrl+C, for the whole of this call including its retry. It
      // clears a partially typed line, but a second one is how Claude Code
      // quits — which would kill the very agent we are trying to talk to.
      this.runHerdr(['pane', 'send-keys', paneId, 'C-c']);
      interrupts++;
      await delay(INTERRUPT_SETTLE_MS);
      this.runHerdr(['pane', 'send-text', paneId, message]);
      this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);
      submits++;
    } catch (e: any) {
      const error = e?.message ?? String(e);
      console.error(`[HerdrBridge] Failed to send message to agent at '${agentPath}':`, error);
      // herdr refused a keystroke mid-sequence. What reached the pane is
      // genuinely unknown — the interrupt may have landed and the text may
      // not — so the pane is read once more and allowed to answer.
      const after = this.readDeliveryEvidence(agentPath, message);
      checks++;
      if (!after.readable) {
        return outcome('unverifiable', { readable: false, landedBefore, readError: after.error }, error);
      }
      return outcome(
        after.count > landedBefore ? 'delivered' : 'not-delivered',
        {
          readable: true,
          landedBefore,
          landedAfter: after.count,
          inComposer: after.inComposer,
          tail: capTail(after.tail)
        },
        after.count > landedBefore ? undefined : error
      );
    }

    const first = await this.confirmDelivery(agentPath, message, landedBefore, confirmTimeoutMs, pollMs);
    checks += first.checks;
    if (first.verdict === 'delivered' || first.verdict === 'unverifiable') {
      return outcome(first.verdict, {
        readable: first.verdict !== 'unverifiable',
        landedBefore,
        landedAfter: first.count,
        inComposer: first.inComposer,
        tail: capTail(first.tail),
        ...(first.error ? { readError: first.error } : {})
      }, first.verdict === 'delivered' ? undefined : unverifiableMessage(paneName, confirmTimeoutMs, first.error));
    }

    // Read, and not there. If our text is sitting in the composer this is the
    // exact witnessed failure and the fix is a submit, not another attempt.
    if (!first.inComposer) {
      return outcome('not-delivered', {
        readable: true,
        landedBefore,
        landedAfter: first.count,
        inComposer: false,
        tail: capTail(first.tail)
      }, notDeliveredMessage(paneName, confirmTimeoutMs, false));
    }

    this.runHerdr(['pane', 'send-keys', paneId, 'Enter']);
    submits++;
    const second = await this.confirmDelivery(agentPath, message, landedBefore, confirmTimeoutMs, pollMs);
    checks += second.checks;
    return outcome(second.verdict, {
      readable: second.verdict !== 'unverifiable',
      landedBefore,
      landedAfter: second.count,
      inComposer: second.inComposer,
      tail: capTail(second.tail),
      ...(second.error ? { readError: second.error } : {})
    }, second.verdict === 'delivered'
      ? undefined
      : second.verdict === 'unverifiable'
        ? unverifiableMessage(paneName, confirmTimeoutMs, second.error)
        : notDeliveredMessage(paneName, confirmTimeoutMs, second.inComposer));
  }

  /**
   * Watch the pane until one more submitted copy of the message exists than
   * there was, or until the budget runs out.
   *
   * The three answers are the three verdicts, decided by what the LAST reading
   * could see rather than by a running tally: a pane that was unreadable
   * halfway through and readable at the deadline has been read, and a pane that
   * never once answered has not. `unverifiable` therefore means every read in
   * the window failed, which is the only state in which nothing may be
   * concluded.
   */
  private async confirmDelivery(
    agentPath: string,
    message: string,
    landedBefore: number,
    timeoutMs: number,
    pollMs: number
  ): Promise<{
    verdict: SendVerdict;
    count: number | null;
    inComposer: boolean;
    tail: string | null;
    checks: number;
    error?: string;
  }> {
    const deadline = Date.now() + timeoutMs;
    let checks = 0;
    let last: { readable: true; count: number; inComposer: boolean; tail: string } | undefined;
    let lastError: string | undefined;

    for (;;) {
      const reading = this.readDeliveryEvidence(agentPath, message);
      checks++;
      if (reading.readable) {
        last = reading;
        lastError = undefined;
        if (reading.count > landedBefore) {
          return {
            verdict: 'delivered',
            count: reading.count,
            inComposer: reading.inComposer,
            tail: reading.tail,
            checks
          };
        }
      } else {
        last = undefined;
        lastError = reading.error;
      }

      if (Date.now() + pollMs >= deadline) break;
      await delay(pollMs);
    }

    return last
      ? { verdict: 'not-delivered', count: last.count, inComposer: last.inComposer, tail: last.tail, checks }
      : { verdict: 'unverifiable', count: null, inComposer: false, tail: null, checks, error: lastError };
  }

  /**
   * The PTY entry points, and the one rule they share: a session id this daemon
   * does not hold gets nothing.
   *
   * Every caller here is a client that was handed a session id earlier, so an
   * id we cannot find is a caller bug — most often a client re-initialising
   * against a daemon that has restarted since the id was issued. In the
   * extraction source all of these once fell through to a helper that returned
   * an arbitrary active session, or spawned a default shell when there were
   * none. A stale re-init was answered with somebody else's terminal, or with
   * a phantom agent that then sat in the pane list — and both look like
   * success from the outside, which is how the bug survived unnoticed (KAN-25,
   * in the extraction source).
   *
   * So: `false`/`undefined` means "no such session", and the caller owes its
   * client an error. Nothing in here creates a session as a side effect, and
   * nothing substitutes a different one for the one that was asked for.
   */
  public writePty(sessionId: string | undefined, data: string): boolean {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return false;
    if (session.ptyProcess) {
      session.ptyProcess.write(data);
    }
    return true;
  }

  public resizePty(sessionId: string | undefined, cols: number, rows: number): boolean {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return false;
    if (session.ptyProcess && cols > 0 && rows > 0) {
      try {
        session.ptyProcess.resize(cols, rows);
      } catch (err) {
        // ignore resize errors if process ended
      }
    }
    return true;
  }

  /** The session's replay buffer, or `undefined` when there is no such session. */
  public getPtyBuffer(sessionId: string | undefined): string | undefined {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    return session ? session.ptyBuffer : undefined;
  }

  /** The unsubscribe, or `undefined` when there is no such session to listen to. */
  public registerDataListener(
    sessionId: string | undefined,
    listener: (data: string) => void
  ): (() => void) | undefined {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) return undefined;
    session.onDataListeners.push(listener);
    return () => {
      session.onDataListeners = session.onDataListeners.filter(l => l !== listener);
    };
  }

  /**
   * Tear down a session and the agent behind it.
   *
   * The result is the outcome, not the attempt. In the extraction source this
   * once returned a bare `true` for any session it had heard of: the pane
   * close was wrapped in a try/catch that logged the failure and swallowed it,
   * so a stand-down herdr had refused — or never received, because the server
   * was down — was answered `success: true` while the agent carried on
   * working. That is the KAN-23 (in the extraction source) defect on the other
   * side of the switch.
   *
   * An agent or pane herdr does not have is still a success: the caller asked
   * for the agent to be gone and it is. Anything else is reported.
   */
  public terminateSession(sessionId: string): { success: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `No session '${sessionId}' to terminate` };

    if (session.ptyProcess) {
      session.ptyProcess.kill();
    }

    const { paneName } = session;
    let error: string | undefined;
    try {
      this.closePaneForAgent(paneName);
    } catch (e: any) {
      const code = (e as HerdrCliError)?.herdrCode;
      if (code !== AGENT_NOT_FOUND && code !== PANE_NOT_FOUND) {
        error =
          `Could not close the pane for agent '${paneName}': ${e?.message ?? String(e)}. ` +
          `This daemon's terminal attach is gone, but the agent may still be running.`;
        console.error(`[HerdrBridge] ${error}`);
      }
    }

    // Terminated either way: our PTY is dead, so the session cannot be used
    // again whatever herdr did with the pane. What the caller is told about
    // the *agent* is the returned error, which is a different question.
    session.status = 'terminated';
    return error ? { success: false, error } : { success: true };
  }
}
