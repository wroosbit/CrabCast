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
  CHANNEL_MCP_SERVER,
  builtinMcpServer,
  launcherDeliversRuntime,
  promptInstruction,
  resolveLauncher
} from './launchers.js';
import type { AgentLauncher } from './launchers.js';
import { diagnoseSpawnFailure } from './herdr-health.js';
import { EVIDENCE_TAIL_CHARS, landedCount, messageInComposer, visibleCount } from './delivery.js';
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
  /**
   * Which keys of {@link mcpDefinitions} CrabCast supplied itself, rather than
   * the caller supplying them (KAN-235).
   *
   * SET AT THE SAME MOMENT AS `mcpDefinitions` AND READ WITH IT, so the two
   * cannot drift into describing different activations. A launcher writing to a
   * SHARED file needs the distinction: CrabCast's builtin carries this agent's
   * identity, and identity written where every agent reads it is identity
   * fabricated for all of them. Resolution erases the difference, so it is
   * captured where the `'builtin'` sentinel still exists.
   */
  mcpBuiltinNames?: string[];
  /**
   * WHETHER THIS SPAWN GOT THE CHANNEL (KAN-281) — the launcher's own record of
   * what it decided, captured where it decided it.
   *
   * `undefined` HERE MEANS "THIS DAEMON DID NOT PERFORM THE SPAWN", and the
   * distinction is load-bearing rather than a nullable-field formality.
   * {@link HerdrBridge.attachSession} builds a session for an agent that was
   * ALREADY running — one that outlived a daemon restart, or that a converging
   * `activate` re-took the terminal of — and it resolves no MCP servers because
   * there is no spawn to resolve them for. So this field is absent on exactly
   * the sessions whose spawn happened somewhere this process cannot see.
   *
   * That is why the field on the wire is durable rather than read from here.
   * A response sourcing it from a session would answer `false` for every
   * re-attached agent — indistinguishable from an agent genuinely spawned
   * without a channel, and wrong. This is the WRITE side; the registry is what
   * the read side answers from. See `rememberActivated` in router.ts.
   */
  channelEnabled?: boolean;
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
 * How long freshly typed text gets to appear ANYWHERE on the pane before the
 * submit is withheld (KAN-383).
 *
 * Much shorter than {@link DELIVERY_CONFIRM_TIMEOUT_MS}, and the two budgets
 * are measuring different things. That one waits for an AGENT to swallow a
 * message and echo it into its transcript, which is work. This one waits only
 * for a TERMINAL to echo characters that were just written to it, which is a
 * redraw — if it has not happened in this long the pane did not take them.
 * Nothing is lost by being wrong in the impatient direction: a withheld submit
 * leaves the text in the composer and says so, which is recoverable, where a
 * blind Enter is not.
 */
const TYPED_CONFIRM_TIMEOUT_MS = 2_000;

/** Gap between pane reads while waiting for typed text to show up. */
const TYPED_CONFIRM_POLL_MS = 250;

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
/**
 * Why no Enter was pressed. Says what was NOT done as well as what was, because
 * a caller reading this needs to know the pane was left alone (KAN-383).
 */
function submitWithheldMessage(
  paneName: string,
  timeoutMs: number,
  readable: boolean,
  readError?: string
): string {
  return readable
    ? `NOT DELIVERED to '${paneName}': the message was typed and did not appear anywhere on ` +
      `the pane within ${timeoutMs}ms, so THE SUBMIT WAS WITHHELD — Enter was not pressed ` +
      `(submits: 0). A pane that swallowed the text will not submit it for an Enter either, ` +
      `and an Enter it cannot submit still confirms whatever that pane has highlighted, which ` +
      `at a Claude Code dialog is a consent answer nobody gave. Nothing was changed on the ` +
      `pane. Sending again is safe and does the same thing.`
    : `UNVERIFIABLE for '${paneName}': the message was typed, and the pane could not be read ` +
      `for ${timeoutMs}ms afterwards${readError ? ` (${readError})` : ''}, so whether the text ` +
      `arrived is unknown. THE SUBMIT WAS WITHHELD — Enter was not pressed (submits: 0), ` +
      `because an Enter at a pane nobody can observe may confirm a dialog rather than submit a ` +
      `message. The text may be sitting in the composer; read the agent once herdr answers.`;
}

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
 * The herdr read sources a tail may come from, in the order they are asked.
 *
 * WHY THERE ARE TWO, AND WHY THE FIRST IS STILL FIRST. Measured on herdr 0.6.4
 * (KAN-98), and the measurement is the whole reason this is a fallback rather
 * than a substitution:
 *
 *   `recent`/`recent-unwrapped --lines N` return THE LAST N ROWS OF THE GRID
 *   (scrollback + screen). Rows below the cursor are blank, so when a pane's
 *   content sits in the top C rows of an R-row grid, EVERY N <= R - C selects
 *   nothing but blank rows and herdr answers `""` — for a pane that is alive
 *   and plainly has text on it. Boundary predicted and hit exactly on two
 *   panes: R=23,C=4 went empty at N<=19 and answered at N=20; R=24,C=4 went
 *   empty at N<=20 and answered at N=40.
 *
 *   `visible` returns the screen's content and IS NOT AFFECTED BY N at all —
 *   it answered identically at every N from 1 to 200 on both panes.
 *
 * So `recent-unwrapped` is asked first because it reaches back through
 * SCROLLBACK, which `visible` cannot see, and that is genuinely more of the
 * agent's history when the pane has scrolled. `visible` is asked only when the
 * first came back empty, and its answer is trimmed to the caller's N so a
 * fallback cannot quietly return more than was asked for.
 *
 * WHAT THIS DOES **NOT** BUY, stated because the docblock it replaces claimed
 * it. The old comment justified `recent-unwrapped` as the source that shows
 * "the frozen last frame of an agent whose process died". IT DOES NOT, AND
 * NEITHER DOES `visible`: herdr destroys the pane with its process, so within
 * ~500ms of the process dying every source stops returning a `read` object at
 * all and the agent leaves `agent list`. There is no frozen frame to read on
 * this build — measured by killing a pane's process and reading all three
 * sources for 15s afterwards. That capability does not exist to be regressed,
 * which is why this change cannot cost it.
 */
const TAIL_SOURCES = ['recent-unwrapped', 'visible'] as const;
export type TailSource = (typeof TAIL_SOURCES)[number];

/**
 * The last `lines` lines of `text`, used to hold the `visible` fallback to the
 * bound the caller asked for. `visible` ignores `--lines`, so without this a
 * `--lines 8` request could be answered with a whole screen.
 */
function lastLines(text: string, lines: number): string {
  const rows = text.split('\n');
  return rows.length <= lines ? text : rows.slice(-lines).join('\n');
}

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
/**
 * Quote one argv element for a shell command line.
 *
 * `pane run` takes a COMMAND LINE, not an argv array, so every element has to
 * survive the shell's own parsing. Single quotes with the `'"'"'` escape are
 * the only form that is literal for every byte including spaces, $, backticks
 * and newlines — which matters because one of these elements is an entire
 * `bash -c` script built by a launcher.
 */
/**
 * Did this herdr drop `--cwd` from `agent start`?
 *
 * 0.7 redesigned the call; 0.6.x still creates the pane itself. An UNREADABLE
 * version answers FALSE — the 0.6.x path, which is the line CrabCast is
 * verified against. Guessing the newer shape on no evidence would turn a
 * missing measurement into a broken activation.
 */
export function herdrDroppedCwdFromAgentStart(version: string): boolean {
  const m = /^([0-9]+)\.([0-9]+)\./.exec(String(version ?? ''));
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  if (major > 0) return true;
  return minor >= 7;
}

/**
 * The agent's name, however this herdr reports it.
 *
 * ⚠ 0.8.x REMOVED `name` FROM `agent list` ENTIRELY (KAN-552 incident,
 * 2026-08-20). Rows now carry `agent` — the KIND for a herdr-started agent
 * ("claude"), or whatever a supervisor declared via `pane report-agent`, which
 * is where CrabCast puts its own pane name. The old code FILTERED OUT every
 * row without a string `name`, so on 0.8.x the census came back EMPTY and each
 * activation "failed" verification while its agent was in fact running — the
 * daemon then retried, and every retry started ANOTHER agent. Duplicate agents
 * in one workspace were the symptom; an empty census was the cause.
 *
 * Preferring `name` keeps 0.6.x byte-identical. Falling back to `agent` is
 * what makes a 0.8.x row addressable at all. Neither present -> dropped, as
 * before: an unnameable agent is one no caller can ask for.
 */
function deriveAgentName(agent: any): string | null {
  if (!agent) return null;
  if (typeof agent.name === 'string' && agent.name) return agent.name;
  if (typeof agent.agent === 'string' && agent.agent) return agent.agent;
  return null;
}

function shellQuoteArg(arg: string): string {
  return `'${String(arg).replace(/'/g, `'"'"'`)}'`;
}

interface AgentTab {
  tabId: string;
  workspaceId: string;
  /** The shell `herdr tab create` opens the tab on, which the agent replaces. */
  placeholderTerminalId: string;
  /**
   * The pane `tab create` opened the tab on.
   *
   * ⚠ Under 0.6.4 this was a placeholder to dispose of. Under 0.7+ it IS the
   * agent's pane: `agent start` no longer creates one, it attaches to an
   * existing pane at a shell prompt, which is exactly what this is.
   */
  rootPaneId: string;
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
  /**
   * The 0.6.x call: `agent start` CREATES the pane and takes `--cwd`.
   *
   * Kept, not deleted, because the installed herdr decides which shape is
   * correct and 0.6.4 is still the only line CrabCast is verified against.
   */
  private startAgentInOwnTabLegacy(paneName: string, workDir: string, argv: string[]): void {
    const start = (placement: string[]) => this.runHerdr([
      'agent', 'start', paneName,
      '--cwd', workDir,
      ...placement,
      '--no-focus',
      '--',
      ...argv
    ]);

    const tab = this.createAgentTab(paneName, workDir);
    if (!tab) {
      start([]);
      return;
    }

    try {
      try {
        start(['--tab', tab.tabId]);
      } catch (e: any) {
        if ((e as HerdrCliError)?.herdrCode === AGENT_NAME_TAKEN) throw e;
        console.error(
          `[HerdrBridge] Could not place ${paneName} in tab ${tab.tabId} ` +
          `(${e?.message ?? String(e)}); starting it in herdr's default placement instead`
        );
        start([]);
      }
    } finally {
      this.closeTabPlaceholder(tab);
    }
  }

  /** Installed herdr version, read once and cached for the process's life. */
  private cachedHerdrVersion: string | undefined;
  private herdrVersion(): string {
    if (this.cachedHerdrVersion === undefined) {
      try {
        const out = spawnSync('herdr', ['--version'], { encoding: 'utf8' })?.stdout ?? '';
        this.cachedHerdrVersion = (out.match(/[0-9]+\.[0-9]+\.[0-9]+/) ?? [''])[0];
      } catch {
        this.cachedHerdrVersion = '';
      }
    }
    return this.cachedHerdrVersion;
  }

  private startAgentInOwnTab(paneName: string, workDir: string, argv: string[]): void {
    // ── herdr 0.7+ inverted this call (KAN-552 incident, 2026-08-20) ─────
    // Until 0.7, `agent start` CREATED the pane and took `--cwd`, `--tab`,
    // `--no-focus` and a trailing `-- <argv>` run under `bash -c`. 0.7 removed
    // all four: `agent start <NAME> --kind <KIND> --pane <ID>` attaches a
    // *named agent kind* to a pane that already exists at a shell prompt.
    // Passing `--cwd` to 0.7+ dies with `unknown option: --cwd`, which is what
    // took the whole fleet down — every activation failed while every daemon
    // reported healthy.
    //
    // WHY THIS TAKES THE PANE-RUN ROUTE AND NOT `--kind`. `--kind` names an
    // executable from herdr's closed list and passes only its ARGUMENTS after
    // `--`. Our launchers do not expose that split: `launcher.command()`
    // returns a shell command STRING, and argv here is an `env … bash -c …`
    // invocation. Restructuring every launcher into (executable, args) is a
    // real refactor and not one to attempt while the fleet is down. The pane
    // `tab create` hands back is already a shell in the right cwd, so running
    // the exact command we always ran is a smaller, more faithful change: the
    // bytes on the command line are unchanged from 0.6.4.
    //
    // ⚠ WHAT THIS ROUTE DOES NOT BUY. `agent start` under 0.7 returns only
    // once the agent is DETECTED AND READY FOR INPUT — it turns a wedged
    // startup dialog into a spawn failure. `pane run` cannot: it asserts the
    // agent is up rather than observing it. That is a real loss and it is
    // recorded here rather than hidden. Closing it means giving launchers a
    // kind/args split so `--kind` becomes usable.
    //
    // ⚠ NO FALLBACK PLACEMENT. Under 0.6.4 a failed `tab create` fell back to
    // herdr's default placement — a cosmetic loss beat a broken activation.
    // That trade no longer exists: without a pane there is nothing to attach
    // to, so a fallback could only fail later and less clearly.
    // ── Which call shape does the INSTALLED herdr take? ────────────────
    // Not a preference and not a config: 0.6.x REQUIRES --cwd and 0.7+ REFUSES
    // it, so a build that only speaks one of them is broken on the other. The
    // version is read from the binary rather than assumed, because the binary
    // is what will parse the arguments.
    if (!herdrDroppedCwdFromAgentStart(this.herdrVersion())) {
      this.startAgentInOwnTabLegacy(paneName, workDir, argv);
      return;
    }

    const tab = this.createAgentTab(paneName, workDir);
    if (!tab) {
      throw new Error(
        `Could not create a tab for ${paneName}, and herdr 0.7+ has no way to ` +
        `start an agent without a pane to put it in`
      );
    }

    // `agent start` used to refuse a name already in use, and callers depend on
    // that refusal — retrying past it starts a SECOND agent under one name.
    // This route has no such check built in, so it is made explicitly.
    if (this.agentNameIsTaken(paneName)) {
      this.closeTabPlaceholder(tab);
      const err: any = new Error(`An agent named ${paneName} is already running`);
      err.herdrCode = AGENT_NAME_TAKEN;
      throw err;
    }

    try {
      // One command line, quoted exactly as a shell would need it. `pane run`
      // appends the Enter that `pane send-text` deliberately does not.
      this.runHerdr(['pane', 'run', tab.rootPaneId, argv.map(shellQuoteArg).join(' ')]);

      // Declare what we put in the pane. Without this the pane is a shell as
      // far as herdr is concerned, and `agent list`/`get`/`attach` cannot
      // resolve the name — which is how an agent becomes invisible to its own
      // supervisor.
      this.runHerdr([
        'pane', 'report-agent', tab.rootPaneId,
        '--source', 'crabcast',
        '--agent', paneName,
        '--state', 'working'
      ]);
    } catch (e: any) {
      // A half-started agent is worse than none: the pane would sit there
      // holding a shell that nobody can address by name.
      this.closeTabPlaceholder(tab);
      throw e;
    }
  }

  /**
   * Is an agent already running under this name?
   *
   * Answers FALSE only when herdr answered and did not know the name. A failed
   * query is not a free name — treating "I could not ask" as "nobody is there"
   * is how a second agent gets started under one name, so an unreadable answer
   * is reported as taken and the activation refuses instead.
   */
  private agentNameIsTaken(paneName: string): boolean {
    try {
      const agents = this.runHerdr(['agent', 'list'])?.result?.agents;
      if (!Array.isArray(agents)) return true;
      return agents.some((a: any) => a?.name === paneName);
    } catch {
      return true;
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
      const rootPaneId = result?.root_pane?.pane_id;
      if (
        typeof tabId !== 'string' || typeof workspaceId !== 'string' ||
        typeof placeholderTerminalId !== 'string' || typeof rootPaneId !== 'string'
      ) {
        throw new Error('herdr tab create returned no usable tab');
      }

      return { tabId, workspaceId, placeholderTerminalId, rootPaneId };
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
    // THE SPAWN'S CHANNEL DECISION, and this line is where it is made rather
    // than where it is later noticed (KAN-281). An agent that asked for no MCP
    // servers at all asked for no channel, so the default is the answer for it
    // — stated here rather than left to `undefined`, which on this session means
    // the different thing described at the field: that no spawn happened.
    session.channelEnabled = false;
    if (requestedNames.length > 0) {
      // `Object.create(null)` — see the note in router.ts's `parseAgentConfig`.
      // A server named `__proto__` assigned into a plain literal vanishes
      // silently, and the count comparison below is what would otherwise be
      // asked to notice a key that never arrived.
      const definitions: Record<string, unknown> = Object.create(null);
      const unsupplied: string[] = [];
      // Which names CrabCast filled in itself, recorded AS WE RESOLVE THEM.
      // Once a builtin has been resolved it is an ordinary `{command, args,
      // env}` and nothing downstream can tell it from a caller's server that
      // looks similar — so the only place this is knowable is here, where the
      // `'builtin'` sentinel is still in hand. The agy launcher needs it to
      // avoid writing per-agent identity into a shared file (KAN-235).
      const builtinNames: string[] = [];
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
          else {
            definitions[name] = builtin;
            builtinNames.push(name);
          }
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
      session.mcpBuiltinNames = builtinNames;
      // READ OFF THE RESOLUTION, NOT OFF THE REQUEST. `builtinNames` holds what
      // `builtinMcpServer` actually SUPPLIED; `requested` holds what the caller
      // asked for. They differ precisely when a name could not be filled in —
      // and that case refuses above, so this is the resolution's own verdict on
      // a spawn that is going to happen. Asking `requested` instead would be the
      // config re-read this field exists to replace.
      session.channelEnabled = builtinNames.includes(CHANNEL_MCP_SERVER);
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
          // Read together with `mcpDefinitions` above, for the reason given at
          // the field: a launcher writing to a shared file must be able to tell
          // CrabCast's own definitions from the caller's, and after resolution
          // nothing else can.
          builtinMcpNames: session.mcpBuiltinNames ?? [],
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
                keys: artifact.keys,
                // Disclosed even when `keys` is null: an omission is not a
                // non-event, it is a capability this agent does not have.
                omittedBuiltins: artifact.omittedBuiltins
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
          // `config.args` verbatim, and `?? []` is the agent that was
          // configured without any — not a default, because there is no such
          // thing as a default argument here. The launcher shell-quotes each
          // element, so what the caller froze onto the record is what appears
          // on the command line, one element to one argument.
          'bash', '-c', launcher.command({
            promptCommand,
            mayResume: session.mayResume === true,
            args: config.args ?? []
          })
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
          .filter((agent: any) => agent && typeof deriveAgentName(agent) === 'string')
          .map((agent: any) => {
            const workDir = typeof agent.cwd === 'string' ? agent.cwd : null;
            return {
              name: deriveAgentName(agent) as string,
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
   * The NAME of the pane a herdr pane handle refers to, or null if herdr will
   * not resolve it (KAN-338).
   *
   * WHAT THIS IS FOR. A pane handle is what a running process carries — herdr
   * puts one in every pane's environment, and `agent-cost.ts` reads it off a
   * process tree's root. A pane NAME is what this daemon decides ownership on.
   * This is the one step between them, and it is a lookup rather than a
   * judgement: it answers "which pane is that", never "is it ours".
   *
   * IT IS NOT PART OF THE CENSUS, AND IT CANNOT BE. `herdr agent list` and
   * `herdr pane list` report no handle in this form, so there is no single
   * read that maps every handle to a name — checked at herdr 0.6.4 on
   * 2026-08-13 across `pane list`, `pane get` and `agent get`. The cost is one
   * `herdr pane get` per agent TREE per sampling window (seven on this machine,
   * once a minute), and the remedy is on herdr's side of a boundary this
   * daemon does not edit: see the note on `PANE_HANDLE_VAR` in agent-cost.ts.
   *
   * THE ARGUMENT IS A TARGET FORM `herdr pane --help` DOES NOT LIST (KAN-385).
   * That help documents `pane get <pane_id>`, and a handle is not a `pane_id` —
   * the two forms are different and both accepted, measured at 0.6.4. The one
   * that would go wrong is quiet rather than loud: a herdr that stopped
   * resolving `p_NNN` returns null here for every tree, every tree is then
   * classified `foreign`, and the charged sample goes to zero — which reads
   * exactly like a fleet with nothing of ours running. Nothing in CI says so —
   * deliberately, and `scripts/verify-herdr-release.mjs` §4b is where it IS
   * pinned instead (KAN-386): on a `--expect supported` run that gate reads a
   * handle out of a real process in the pane the release under test created
   * and requires `pane get` to resolve it, with a mutated-handle control. It is
   * hand-run at the moment somebody proposes a new release, which is the only
   * moment the behaviour can change. docs/herdr-pane-handle-join.md carries the
   * measurement, the decision and what that gate does not cover.
   *
   * Null on every failure — an unknown handle, a herdr that will not answer, a
   * reply in a shape we do not recognise — because a caller can only degrade,
   * and a caller that cannot tell those apart must not guess a name. The
   * distinction that DOES matter to the sampler, "herdr answered nothing at
   * all", is taken from {@link listHerdrAgentsChecked} rather than from here,
   * so an unreachable herdr is one fact read once rather than N nulls that
   * could each mean either thing.
   */
  public paneNameForHandle(handle: string): string | null {
    let pane: any;
    try {
      pane = this.runHerdr(['pane', 'get', handle])?.result?.pane;
    } catch {
      return null;
    }
    return typeof pane?.label === 'string' && pane.label ? pane.label : null;
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
   * The tail of an agent's terminal, as plain text.
   *
   * NEVER REPORTS ABSENCE OFF A SINGLE READ. Both sources in {@link
   * TAIL_SOURCES} are asked before this returns an empty string, because one of
   * them answers `""` for a live pane that plainly has text on it — see that
   * constant for the measurement and the exact boundary. An empty answer from
   * ONE source is not evidence that the pane is empty; it is evidence about the
   * source.
   *
   * The three outcomes are kept apart in the shape rather than in prose, since
   * the defect this replaces was precisely that two of them were the same
   * value:
   *
   *   * TEXT — `success: true`, `text` non-empty, `source` naming who answered.
   *   * GENUINELY EMPTY — `success: true`, `text: ''`, `source: null`, with
   *     `sourcesTried` listing both. The pane was read and there is nothing on
   *     it. This is a real answer about the agent.
   *   * COULD NOT LOOK — `success: false` with `error`. No claim about the pane
   *     is made or may be inferred.
   *
   * `source: null` with `success: true` is therefore the assertion "both of
   * these were asked and both said nothing", and a caller that treats an empty
   * pane as meaningful — {@link readDeliveryEvidence} does — is entitled to it
   * only because of that.
   *
   * Never throws; the caller owes its client a response.
   */
  public tailAgent(
    agentPath: string,
    lines?: number
  ): {
    success: boolean;
    text?: string;
    truncated?: boolean;
    /** Which source the text came from; null when both were asked and both were empty. */
    source?: TailSource | null;
    /** Every source asked, in order, so "we looked twice" is auditable. */
    sourcesTried?: TailSource[];
    error?: string;
  } {
    const paneName = paneNameFor(agentPath);
    const wanted = clampTailLines(lines);
    const tried: TailSource[] = [];
    const answeredEmpty: TailSource[] = [];
    let firstError: string | undefined;

    for (const source of TAIL_SOURCES) {
      tried.push(source);
      try {
        const read = this.runHerdr([
          'agent', 'read', paneName,
          '--source', source,
          '--format', 'text',
          '--lines', String(wanted)
        ])?.result?.read;

        if (!read || typeof read.text !== 'string') {
          throw new Error(`herdr returned no readable output for agent '${paneName}'`);
        }

        // An empty string is a string, which is exactly how the single-source
        // version reported a pane it had not really seen. Keep asking.
        if (read.text.length === 0) {
          answeredEmpty.push(source);
          continue;
        }

        return {
          success: true,
          // `visible` ignores --lines, so it is held to what was asked for.
          text: source === 'visible' ? lastLines(read.text, wanted) : read.text,
          truncated: read.truncated === true,
          source,
          sourcesTried: [...tried]
        };
      } catch (e: any) {
        // A source that FAILS is not a source that said "empty". Remember the
        // first failure and let the next source try: herdr answering one read
        // and refusing another is a state we have seen, and the pane is
        // readable if either of them answers.
        const error = e?.message ?? String(e);
        if (firstError === undefined) firstError = error;
      }
    }

    // "Empty" is only ever asserted when EVERY source was asked AND ANSWERED.
    // A source that failed is not a source that said "empty", so one refusal
    // is enough to make this a read we could not trust — reporting it as an
    // empty pane would be the original defect wearing the fallback's clothes.
    if (answeredEmpty.length !== TAIL_SOURCES.length) {
      const error =
        `Could not establish what is on agent '${paneName}': ` +
        `${firstError ?? 'a source failed to answer'}. ` +
        (answeredEmpty.length
          ? `${answeredEmpty.join(', ')} answered empty, but ` +
            `${tried.filter(s => !answeredEmpty.includes(s)).join(', ')} could not be read, so ` +
            `whether the pane is empty is UNKNOWN rather than confirmed.`
          : `no source could be read.`);
      console.error(`[HerdrBridge] Failed to tail agent at '${agentPath}':`, error);
      return { success: false, error, sourcesTried: tried };
    }

    // Both sources answered, and both were empty. That is a fact about the
    // agent rather than about the read, and it is said as one.
    return { success: true, text: '', truncated: false, source: null, sourcesTried: tried };
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
   *
   * THAT INVARIANT USED TO BE DEFEATED FROM UNDERNEATH, and this comment is
   * where it was defeated (KAN-98). `readable` means "herdr handed us a
   * string", and one of herdr's read sources hands back `""` for a live pane
   * with text on it — so a spurious empty read arrived here as `readable: true,
   * count: 0`, which is a SUCCESSFUL read of NO OUTPUT. It then took the
   * `not-delivered` branch at the caller rather than the `unverifiable` one,
   * which is the single place this was supposed to end up: `crabcast send`
   * could report a message as not delivered while it was sitting on the
   * recipient's screen. The claim outran the mechanism inside the mechanism
   * built to stop claims outrunning mechanisms.
   *
   * The repair is in {@link tailAgent} rather than here — it now asks every
   * source before it will say "empty", so `readable: true` once again means the
   * pane was seen. `source` is carried through so the verdict names what it was
   * read from instead of asking anyone to trust that it looked twice.
   */
  private readDeliveryEvidence(
    agentPath: string,
    message: string
  ): {
      readable: true;
      count: number;
      /** Copies anywhere on the pane — the submit precondition. See {@link visibleCount}. */
      visible: number;
      inComposer: boolean;
      tail: string;
      source: TailSource | null;
    }
    | { readable: false; error: string } {
    const tail = this.tailAgent(agentPath, DELIVERY_TAIL_LINES);
    if (!tail.success || typeof tail.text !== 'string') {
      return { readable: false, error: tail.error ?? `herdr returned no readable output for '${agentPath}'` };
    }
    return {
      readable: true,
      count: landedCount(tail.text, message),
      visible: visibleCount(tail.text, message),
      inComposer: messageInComposer(tail.text, message),
      tail: tail.text,
      source: tail.source ?? null
    };
  }

  /**
   * Wait until the text we just typed is ON THE PANE — the precondition for
   * pressing Enter.
   *
   * WHY THE SUBMIT IS CONDITIONAL AT ALL (KAN-383). An Enter is not a neutral
   * keystroke. It confirms whatever the pane currently has selected, and at a
   * Claude Code dialog that is a consent answer nobody gave: measured against a
   * real agent, a startup trust dialog whose highlight was deliberately moved to
   * *"No, exit"* resolved to **option 2** and `claude` exited with status 1,
   * while a tool-permission dialog whose highlight was moved to *"Yes, and
   * always allow…"* **ran the command and granted the standing permission.**
   * Neither option was the default position or the conservative answer; the only
   * property either had was being highlighted.
   *
   * WHAT THIS IS NOT, because the obvious design is the wrong one. It is **not a
   * dialog detector.** Nothing here recognises a dialog, matches its wording, or
   * reads its footer — and that is deliberate, because two dialog kinds measured
   * on the same afternoon render their footers differently (*"Enter to confirm ·
   * Esc to cancel"* against *"Esc to cancel · Tab to amend · ctrl+e to
   * explain"*), so a detector tuned to either one misses the other, and both are
   * somebody else's TUI that may be redrawn in the next release. This asks a
   * question about OUR OWN MESSAGE instead: is the thing we just typed on the
   * pane? That is an observation, and it stays true however Claude Code chooses
   * to draw itself.
   *
   * AND A DETECTOR COULD NOT HAVE USED THE MARKER EITHER, which is the sharper
   * half. A dialog's highlight caret is `❯`, already in `COMPOSER_MARKERS`, and
   * `splitAtComposer` takes `lastIndexOf` reduced to the FURTHEST match — so on
   * a dialog frame it does not merely find *a* caret, it locks onto the LAST
   * one, which is the selected option. **The daemon identifies the highlighted
   * choice as the input line it is about to type into.** Measured on real
   * frames: `❯ 1. Yes, I trust this folder`, `❯ 2. No, exit`, `❯ 1. Yes`.
   *
   * THE THREE PANES IT HAS TO SEPARATE, and it separates them without knowing
   * which it is looking at:
   *
   *   a claude composer  our text is in the composer          -> visible, submit
   *   a bare shell       our text is on the command line      -> visible, submit
   *   a dialog           our text is destroyed, echoed NOWHERE -> unseen, withhold
   *
   * The third is measured rather than assumed: `send-text` at both dialog kinds
   * was echoed in none of herdr's three read sources and left the frame
   * otherwise byte-identical.
   *
   * WHAT THIS DOES NOT COVER, AND IT IS NOT HYPOTHETICAL — it was found in
   * review of the change that introduced it. The question *"is our message on
   * the pane"* is only as sharp as the fingerprint asking it, and
   * `deliveryFingerprint` has no floor: a one-character message asks a
   * one-character question. {@link visibleCount} now counts only the composer
   * region, which is what our keystrokes can reach, and that closes the case
   * review found — an ordinary transcript redraw inflating the count for `y`
   * until the Enter went out at a live dialog. **It does not close the class.**
   * A redraw INSIDE the composer region would still inflate a short needle, and
   * the failure that remains is the one this whole function exists to prevent:
   * a submit that should have been withheld. The shortest messages carry the
   * most of that risk, and `y`, `ok` and `go` are exactly what a supervisor
   * sends to unstick an agent. A minimum length is NOT the fix — a short
   * message still has to be sendable — so this is a named gap rather than a
   * closed one, and §4.2 of `verify-submit-withheld-at-dialog.mjs` holds the
   * half that is closed.
   *
   * AND AN UNREADABLE PANE WITHHOLDS THE ENTER TOO. *"We could not tell"* must
   * not resolve to *"press it anyway"* — that is the whole failure this exists
   * to prevent, and it is the same rule {@link Occupancy} states for spawning
   * and `confirmAgentPresent` states for liveness. The cost of withholding is
   * real and is stated rather than hidden: the message sits typed-and-unsubmitted
   * in the composer, which is exactly the KAN-114 failure this file was built to
   * catch. That is the deliberate trade — an unsubmitted message is visible,
   * recoverable and reported (`submits: 0`), while an answered consent dialog is
   * none of the three.
   *
   * THIS IS THE RULE THE RETRY ALREADY FOLLOWED. The Enter-only retry has always
   * pressed Enter only when the pane showed our text sitting in the composer.
   * The FIRST Enter did not. Both are the same keystroke with the same
   * consequence; this makes the discipline uniform rather than inventing one.
   *
   * ---------------------------------------------------------------------------
   * THE THREE SHAPES NOT TAKEN, recorded because a decision without its
   * alternatives is an assertion (KAN-383 AC1).
   * ---------------------------------------------------------------------------
   *
   * 1. **Detect the dialog and refuse before typing.** The shape the ticket
   *    floated, and the one this replaces. Rejected on a measurement rather
   *    than on taste: the two dialog kinds measured render their footers
   *    differently (*"Enter to confirm · Esc to cancel"* against *"Esc to
   *    cancel · Tab to amend · ctrl+e to explain"*), so a detector tuned to
   *    either misses the other — and a missed dialog is the whole defect back
   *    again. Worse, the signal it would have to key on is `❯`, which is
   *    ALREADY in `COMPOSER_MARKERS`: a real dialog's highlight caret is the
   *    same glyph as the composer's, so `splitAtComposer` reports `❯ 1. Yes` as
   *    the input line. A guess in the other direction is just as costly — a
   *    heuristic that misfires refuses sends to a healthy agent, and a fleet
   *    that stops working is worse than the bluntness it replaced.
   *
   * 2. **Answer `refused`.** The vocabulary exists ({@link SendRefusal}) and it
   *    looks like a fit until the contract's own definition is read: `refused`
   *    means the request never became a send, so **no pane was read and no
   *    keystroke was issued**, and its branch carries neither `interrupts` nor
   *    `submits`. By the time this is decided a pane HAS been read and a Ctrl+C
   *    HAS been issued. Answering `refused` would be the exact defect this epic
   *    keeps re-finding — a word whose stated basis is broader than what
   *    happened. `not-delivered` is true in both outcome and basis: the pane was
   *    read, and the message is not in it. It also needs no new member, so no
   *    consumer's exhaustive switch grows a default case.
   *
   * 3. **Make it a caller's flag.** The default would be the real decision, and
   *    neither default survives being written down: `submit: false` by default
   *    breaks every existing caller, and `submit: true` by default leaves the
   *    hazard exactly where it was for everyone who does not know to ask. A
   *    caller cannot know which they want either — they would have to know what
   *    is on a pane they cannot see, which is the daemon's job and the reason
   *    this reads the pane at all.
   */
  private async confirmTyped(
    agentPath: string,
    message: string,
    visibleBefore: number,
    timeoutMs: number,
    pollMs: number
  ): Promise<{ visible: boolean; checks: number; last?: {
    count: number; visible: number; inComposer: boolean; tail: string; source: TailSource | null;
  }; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let checks = 0;
    let last: { count: number; visible: number; inComposer: boolean; tail: string; source: TailSource | null } | undefined;
    let lastError: string | undefined;

    for (;;) {
      const reading = this.readDeliveryEvidence(agentPath, message);
      checks++;
      if (reading.readable) {
        last = reading;
        lastError = undefined;
        // Strictly greater than the baseline, for the reason every count on
        // this path is compared rather than tested: the pane may legitimately
        // have held this text already.
        if (reading.visible > visibleBefore) return { visible: true, checks, last };
      } else {
        last = undefined;
        lastError = reading.error;
      }

      if (Date.now() + pollMs >= deadline) break;
      await delay(pollMs);
    }

    return { visible: false, checks, last, error: lastError };
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
    opts: {
      confirmTimeoutMs?: number;
      pollMs?: number;
      typedTimeoutMs?: number;
      typedPollMs?: number;
    } = {}
  ): Promise<SendOutcome> {
    const confirmTimeoutMs = opts.confirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? DELIVERY_CONFIRM_POLL_MS;
    const typedTimeoutMs = opts.typedTimeoutMs ?? TYPED_CONFIRM_TIMEOUT_MS;
    const typedPollMs = opts.typedPollMs ?? TYPED_CONFIRM_POLL_MS;
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
    // Copies of this message ANYWHERE on the pane, from the same reading. This
    // is only the FALLBACK baseline for the submit precondition — the one
    // actually used is re-read after the interrupt, for the reason given there.
    const visibleBeforeInterrupt = baseline.visible;

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
        {
          readable: true,
          landedBefore,
          landedAfter: landedBefore,
          tail: capTail(baseline.tail),
          tailSource: baseline.source
        },
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

      // THE VISIBLE BASELINE IS TAKEN HERE, AFTER THE INTERRUPT, and taking it
      // before instead is a deadlock rather than an inaccuracy. The interrupt
      // clears a composer, so a copy of this message left sitting there by an
      // earlier withheld send is present in the pre-send reading and gone by
      // the time we type. Compared against the pre-send count, the fresh copy
      // we are about to type does not raise the total, the precondition never
      // holds, and THE SAME MESSAGE CAN NEVER BE SENT TO THAT AGENT AGAIN —
      // the recovery path for a withheld submit, closed by the guard that
      // needed it.
      //
      // A read that fails here falls back to the pre-interrupt count, which is
      // the conservative direction rather than a guess: the interrupt only ever
      // REMOVES text, so the earlier count is greater than or equal to the true
      // one, and a baseline that is too high can only withhold a submit. It
      // cannot cause one.
      //
      // THE COST OF THAT FALLBACK, stated because it is the deadlock the line
      // above exists to prevent, reappearing for exactly one send: if this read
      // fails AND a copy of this message is already sitting in the composer,
      // the too-high baseline withholds again. It fails closed — a withheld
      // submit is reported and recoverable, and the next send whose
      // post-interrupt read succeeds clears it — so this is a cost rather than
      // a hazard. Raised in review of KAN-383 and left as it is deliberately:
      // the alternative is trusting a count nobody could read.
      const afterInterrupt = this.readDeliveryEvidence(agentPath, message);
      checks++;
      const visibleBefore = afterInterrupt.readable ? afterInterrupt.visible : visibleBeforeInterrupt;

      this.runHerdr(['pane', 'send-text', paneId, message]);

      // THE SUBMIT IS EARNED RATHER THAN AUTOMATIC (KAN-383). An Enter pressed
      // at a pane that did not take our text cannot submit our message, and it
      // is not therefore harmless: it confirms whatever that pane has
      // highlighted. See `confirmTyped` for the measurement and for why this
      // asks about our own message instead of trying to recognise a dialog.
      const typed = await this.confirmTyped(agentPath, message, visibleBefore, typedTimeoutMs, typedPollMs);
      checks += typed.checks;
      if (!typed.visible) {
        const readable = typed.last !== undefined;
        console.error(
          `[HerdrBridge] Withheld the submit to '${paneName}': the text was typed and never ` +
          `appeared on the pane, so Enter was not pressed.`
        );
        return outcome(
          readable ? 'not-delivered' : 'unverifiable',
          {
            readable,
            landedBefore,
            landedAfter: typed.last?.count ?? null,
            inComposer: typed.last?.inComposer ?? false,
            tail: capTail(typed.last?.tail ?? null),
            ...(typed.last ? { tailSource: typed.last.source } : {}),
            ...(typed.error ? { readError: typed.error } : {})
          },
          submitWithheldMessage(paneName, typedTimeoutMs, readable, typed.error)
        );
      }

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
          tail: capTail(after.tail),
          tailSource: after.source
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
        tailSource: first.source,
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
        tail: capTail(first.tail),
        tailSource: first.source
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
      tailSource: second.source,
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
    /** Which source the deciding reading came from; null when all were empty. */
    source: TailSource | null;
    checks: number;
    error?: string;
  }> {
    const deadline = Date.now() + timeoutMs;
    let checks = 0;
    let last: { readable: true; count: number; inComposer: boolean; tail: string; source: TailSource | null } | undefined;
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
            source: reading.source,
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
      ? {
          verdict: 'not-delivered',
          count: last.count,
          inComposer: last.inComposer,
          tail: last.tail,
          source: last.source,
          checks
        }
      : { verdict: 'unverifiable', count: null, inComposer: false, tail: null, source: null, checks, error: lastError };
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
