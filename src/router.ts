import * as fs from 'fs';
import * as path from 'path';
import { CrabcastConfig } from './config.js';
import { MAX_LINE_CHARS } from './ipc.js';
import { AgentConfig, DaemonResponse } from './types.js';
import {
  HerdrBridge,
  HerdrCensus,
  HerdrSession,
  HerdrAgentRecord,
  HerdrAgentStatus,
  Occupancy,
  PaneOccupant,
  RUNTIME_CONFIRM_TIMEOUT_MS,
  ourPaneIn
} from './herdr.js';
import { PathError, canonicalPath, canonicalizeOrNull, paneNameFor } from './identity.js';
import { knownLaunchers, resolveLauncher } from './launchers.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import { ResumeCause } from './resume.js';
import {
  Capacity,
  capacityReason,
  capacityRefusal,
  describeCapacity,
  readCapacity,
  summarizeCapacity
} from './capacity.js';
import {
  PreemptionCandidate,
  PreemptionRecord,
  addressOf,
  describeCandidate,
  describeFleetPriorities,
  noVictimReason,
  preemptionOffer,
  selectVictim
} from './priority.js';
import { AgentIntent, AgentRecord, AgentRegistry, RecordOutcome } from './agent-registry.js';
import { nudgeResumedAgent } from './nudge.js';
import { BuildSnapshot, buildProvenanceReport } from './provenance.js';

type Respond = (msg: any) => void;

/**
 * One row of `list_agents`. Two kinds of entry share this shape, and the
 * difference between them is the point of the field that names it:
 *
 * - `sessionless: false` — this daemon holds the agent's terminal attach, so
 *   every field is populated from the session it owns.
 * - `sessionless: true` — the agent is alive in herdr but no session of ours
 *   describes it, which is every surviving agent after a daemon restart. The
 *   session-only fields are null because there is no session, not because the
 *   agent is impaired.
 *
 * Nulls are explicit rather than omitted: over JSON an absent field reads as
 * "not answered", and these are answered — with nothing.
 */
interface ListedAgent {
  sessionless: boolean;
  /** The canonical directory this agent is. The address; nothing else is. */
  path: string;
  /** The opaque herdr token for that path. Nothing parses it back out. */
  paneName: string;
  paneId: string | null;
  sessionId: string | null;
  createdAt: string | null;
  status: HerdrSession['status'] | null;
  herdrStatus: HerdrAgentStatus;
  /** herdr's own `agent` field: the CLI running in the pane, null for a shell. */
  agentRuntime: string | null;
  /** Display only. Never parsed, never an address. */
  label: string | null;
  /**
   * The gate triple from this agent's record, replacing the single
   * `gateExempt` boolean this row used to carry.
   *
   * Three decisions were wearing one flag, and they are genuinely different
   * questions: whether the capacity gate may refuse this agent, whether it
   * occupies a charged slot, and whether anything may stand it down to make
   * room. `gateExempt: true` meant all three at once, which is only ever right
   * by coincidence — a low-priority always-on watchdog wants to be uncharged
   * and unpreemptable but has no business being un-refusable.
   *
   * Sent because a client cannot derive them: they live on the agent's own
   * record, and a client re-deriving them from anything else would be a second
   * copy of a rule — the copy that is wrong after somebody reconfigures.
   */
  refusable: boolean;
  chargeable: boolean;
  preemptable: boolean;
}

/**
 * A pane sitting in one of our directories with nothing running in it.
 *
 * Reported separately rather than dropped: it is not an agent (nothing to
 * message, tail or supervise) and counting it would give a supervisor a number
 * it cannot act on, but silently dropping it would repeat the mistake the
 * census exists to fix.
 */
interface UnbackedPane {
  paneName: string;
  paneId: string | null;
  path: string;
  herdrStatus: HerdrAgentStatus;
  reason: string;
}

/**
 * A live pane that is not ours.
 *
 * NEW, AND THE DIRECT CONSEQUENCE OF DELETING THE CENSUS PREFIX FILTER. This
 * daemon used to decide what was "one of ours" by testing whether a pane name
 * started with `crabcast-` and parsed back into a type and key — a convention
 * masquerading as a filter. What is ours is now a question the durable
 * registry answers: a pane whose canonical `cwd` is a path we have a record
 * for AND whose name is the one that path derives. Everything else is
 * somebody's pane, and herdr hosts more than CrabCast.
 *
 * They are reported rather than dropped because one of them is the reason
 * `activate` refuses: `occupies` is non-null exactly when a stranger's agent
 * is sitting in a directory we have been configured for, which is the state
 * that would otherwise put two agents in one directory.
 */
interface ForeignPane {
  paneName: string;
  paneId: string | null;
  /** herdr's `cwd`, as herdr reported it. */
  workDir: string | null;
  /** Set when that cwd is a directory we hold a record for. */
  occupies: string | null;
  herdrStatus: HerdrAgentStatus;
  agentRuntime: string | null;
}

/**
 * The capacity numbers as they go over the wire.
 *
 * Flat and named rather than nested, because the caller most likely to read
 * this is a language model deciding whether to staff another agent, and the
 * fields it needs — `headroom`, `atCapacity`, `summary` — should not be at the
 * end of a path. `summary` is the same figures in a sentence: a caller that
 * ignores every number still cannot ignore that one.
 */
function capacityDto(c: Capacity) {
  return {
    cap: c.cap,
    running: c.running,
    exemptAgents: c.exemptAgents,
    headroom: c.headroom,
    atCapacity: c.atCapacity,
    capBoundBy: c.capBoundBy,
    headroomBoundBy: c.headroomBoundBy,
    // The one sentence a UI with a single line to spare can render. Sent on
    // every capacity payload rather than only on refusals, because a client
    // that has to explain a refused toggle should not have to parse the
    // reason out of a paragraph of derivation.
    reason: capacityReason(c),
    cores: c.machine.cores,
    load1: Math.round(c.machine.load1 * 100) / 100,
    totalMb: Math.round(c.machine.totalBytes / (1024 * 1024)),
    availableMb: Math.round(c.machine.availableBytes / (1024 * 1024)),
    agentMemoryMb: Math.round(c.cost.residentBytes / (1024 * 1024)),
    agentCores: c.cost.cores,
    // Where the two cost figures came from (KAN-56): 'override', 'measured'
    // or 'seed', plus the sample's metadata when a measurement was consulted.
    agentMemorySource: c.costSource.residentBytes,
    agentCoresSource: c.costSource.cores,
    measuredAt: c.measured ? new Date(c.measured.sampledAt).toISOString() : null,
    measuredWindowSeconds: c.measured ? Math.round(c.measured.windowSeconds) : null,
    measuredAgentTrees: c.measured ? c.measured.agentTrees : null,
    capByCpu: c.capByCpu,
    capByMemory: c.capByMemory,
    headroomByCap: c.headroomByCap,
    headroomByLoad: c.headroomByLoad,
    headroomByMemory: c.headroomByMemory,
    summary: summarizeCapacity(c)
  };
}

/**
 * A flag that decides whether an agent gets destroyed, checked as a flag.
 *
 * `override` and `preempt` arrive from the wire as `unknown` and were tested
 * for truthiness, so the string `"false"` — what a shell client or a hand-typed
 * JSON line produces when someone means no — is true. For `override` that
 * quietly starts an agent past a cap the caller declined; for `preempt` it
 * tears down somebody else's running work. A flag whose wrong reading destroys
 * work is worth one type check: absent means no, a boolean means what it says,
 * and anything else is refused by name rather than guessed at.
 */
function invalidFlag(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return null;
  return (
    `Invalid ${name}: expected true or false, got ${JSON.stringify(value)}. ` +
    `This flag is not read for truthiness — it changes whether an agent is ` +
    `started past capacity or another agent is stood down, so it must be said exactly.`
  );
}

/**
 * An agent the registry says should be running that herdr does not have.
 *
 * This is the whole of the detectability half of the extraction source's
 * KAN-21, as data. On the day that ticket was written two agents ceased to
 * exist and their board read healthy for twenty minutes; the loss was found
 * only because a human thought to ask. The registry is what makes the question
 * answerable without asking — it holds the *intended* fleet, and anything in
 * it that herdr cannot show is a loss, reported on every `list_agents` poll
 * rather than written to a log.
 */
interface MissingAgent {
  path: string;
  paneName: string;
  label: string | null;
  /** When the registry last recorded this agent as activated. */
  since: string;
  reason: string;
}

/**
 * An agent somebody deliberately switched off, that could be switched back on.
 *
 * A fleet client lists what is running, and a stopped agent is by definition
 * not in that list — so the *on* half of a fleet switch needs its candidates
 * from somewhere else. The answer is the registry, and this is the third of
 * the three ways it can answer "not running":
 *
 *   - {@link MissingAgent}    — recorded active, absent anyway. A loss.
 *   - preempted (see below)   — stood down so something else could run. A debt.
 *   - StandbyAgent            — stood down because a person said so.
 *
 * The three are disjoint on purpose, so no agent grows two switches.
 *
 * Only agents whose directory still exists are offered: a directory the caller
 * has since deleted is the evidence that "turn this back on" is not what
 * anyone means by it.
 */
interface StandbyAgent {
  path: string;
  paneName: string;
  label: string | null;
  /** Which launcher it last ran, so it comes back as what it was. */
  launcher: string;
  /** When the registry recorded the stand-down. */
  since: string;
  /**
   * Present when this row is an ex-preempted agent whose annotation compaction
   * dropped: its work was taken, not switched off. Absent means somebody chose
   * to stop it. A client rendering an On button treats both the same; a human
   * reading why it is off does not.
   */
  wasPreempted?: boolean;
  reason: string;
}

/**
 * How many agents each of `list_agents`' categories will carry. The registry
 * compacts at 500 records, so these are bounded already — the cap is about
 * clients that poll continuously, not about the log. Anything beyond it is
 * *counted* rather than dropped silently.
 */
const FLEET_CATEGORY_LIMIT = 25;

/**
 * Newest first, then clipped, with the unclipped count returned alongside.
 *
 * The order matters as much as the cap: clipping an unordered list hides an
 * arbitrary subset, while clipping a newest-first one hides the oldest — which
 * for all of these categories is the least urgent thing in it.
 */
function clipFleetCategory<T>(
  rows: T[],
  when: (row: T) => string
): { rows: T[]; total: number } {
  const sorted = [...rows].sort((a, b) => when(b).localeCompare(when(a)));
  return { rows: sorted.slice(0, FLEET_CATEGORY_LIMIT), total: sorted.length };
}

/**
 * What the caller is told about the agent it could stand down, when it is at
 * capacity and outranks something.
 *
 * Sent on the *refusal*, not after the fact. Preemption is opt-in per
 * activation for the same reason capacity refusals are visible: someone
 * switching an agent on must not silently destroy another agent's uncommitted
 * work. This is the sentence a client turns into a named button, and its
 * presence in the payload is what the consent criterion is satisfied by.
 */
interface PreemptionOfferDto {
  path: string;
  paneName: string;
  priority: number;
  herdrStatus: HerdrAgentStatus;
  /** The priority of the activation being refused, for the comparison. */
  incomingPriority: number;
  /** One sentence naming what would be stood down and what authorises it. */
  offer: string;
}

/** What {@link MessageRouter.capacityGate} decided, and why. */
interface CapacityGateResult {
  capacity: Capacity;
  /** The refusal to send back, or null when the activation may proceed. */
  refusal: string | null;
  /** Set when it may proceed only because the caller deliberately said so. */
  overrode: { at: string; derivation: string } | null;
  /**
   * Set on a refusal that preemption could lift. Null both when there is
   * nothing to preempt and when preemption already happened.
   */
  preemptable: PreemptionOfferDto | null;
  /** Set when an agent was actually stood down to make this room. */
  preempted: { at: string; victim: PreemptionOfferDto; derivation: string } | null;
}

/** Everything the capacity gate needs to know about the activation it is judging. */
interface GateRequest {
  path: string;
  paneName: string;
  /** What this activation outranks. See priority.ts. */
  priority: number;
  /** Whether the gate is permitted to refuse this activation at all. */
  refusable: boolean;
  /**
   * Start it past the cap without freeing anything. Booleans only — the
   * handler validates before it gets here (see invalidFlag), so the gate is
   * reading a decision rather than guessing at one.
   */
  override?: boolean;
  /** Free a slot by standing down something this activation outranks. */
  preempt?: boolean;
}

export interface RouterDeps {
  config: CrabcastConfig;
  herdrBridge: HerdrBridge;
  daemonStartedAt: Date;
  /**
   * The durable record of which agents exist and which should be running — the
   * one piece of state that outlives the daemon, herdr, and the machine.
   *
   * It is now the ONLY place an agent's priority, launcher, prompt and gate
   * flags exist: with workspace types deleted there is nothing left to look
   * them up in. That is what makes `configure` mandatory.
   */
  agentRegistry: AgentRegistry;
  /**
   * What this process was loaded from, frozen when it booted (KAN-122).
   *
   * Handed in rather than read here, and that is the whole design: taken at
   * boot it is a fact about the RUNNING PROCESS, and re-reading it on request
   * would silently answer a different question — what is on disk now — which
   * is the question the filesystem already answers and the one that goes on
   * looking healthy while a daemon serves a build that has been replaced.
   */
  bootBuild: BuildSnapshot;
  /** Replies to the requesting client. */
  send: (msg: DaemonResponse) => void;
  /** Events for every connected client (activations, teardowns, PTY deaths). */
  broadcast: (msg: DaemonResponse) => void;
}

/**
 * The longest bootstrap prompt `configure` accepts.
 *
 * A prompt is finished text now, so it travels INLINE over the socket, and
 * that puts it under the framing bound: `onJsonLines` gives up on a line past
 * {@link MAX_LINE_CHARS} and DESTROYS the connection (ipc.ts). That is the
 * right behaviour for its own job — at that point there is no message to
 * answer, only a peer streaming bytes at a daemon whose memory is the thing
 * being defended — but it is the wrong thing for a caller to meet, because it
 * names the framing bound rather than the prompt and hangs up either way.
 *
 * So `configure` refuses first, on a bound strictly below the framing one, and
 * answers with the limit and the actual size on a connection that survives.
 *
 * THE NUMBER IS DERIVED, not chosen. JSON escaping can expand a string by a
 * factor of six in the worst case — a control byte becomes `\u00XX` — so a
 * prompt this daemon accepts must satisfy `6 × MAX_PROMPT_CHARS` plus the rest
 * of the request comfortably under `MAX_LINE_CHARS`. At 128 KiB that is
 * 786,432 characters of escaped prompt against a 1,048,576 bound, leaving room
 * for the path, the flags and the id several times over. The consequence is
 * the property worth having: **every prompt `configure` accepts is guaranteed
 * to fit on the wire.** There is no size that passes validation here and then
 * dies in the framing, which would be the same silent-truncation failure this
 * bound exists to prevent, one layer down.
 */
export const MAX_PROMPT_CHARS = 128 * 1024;

/** A parsed `configure` payload, or the complaint that stopped it. */
type ConfigParse =
  | { ok: true; config: AgentConfig }
  | { ok: false; error: string; missing: string[] };

/**
 * `configure`'s argument list, validated.
 *
 * REFUSES RATHER THAN DEFAULTS, on exactly the fields the deleted config
 * loader refused on. A silently-defaulted `priority` sits at the floor, is
 * preemptable by everything, and nobody finds out until the work is destroyed
 * — that was true when priority came from a workspace type and it is true now
 * that it comes from here. `launcher` is required for the reason KAN-53
 * records: an omitted launcher used to fall back to `shell`, which staffed
 * work with a bare bash prompt that answered `success: true` and executed
 * messages as shell commands.
 *
 * The three gate flags DEFAULT to `true` rather than being required, and that
 * asymmetry is deliberate: `true` is the safe reading of each (refusable
 * means the cap applies to you, chargeable means you cost a slot, preemptable
 * means you can be asked to give it up), so a caller who says nothing gets an
 * agent that is fully subject to the machine's limits. Only the exemptions
 * have to be asked for.
 */
function parseAgentConfig(data: any): ConfigParse {
  const missing: string[] = [];
  const refuse = (error: string): ConfigParse => ({ ok: false, error, missing });

  if (!('priority' in data) || data.priority === undefined) missing.push('priority');
  if (!('launcher' in data) || data.launcher === undefined) missing.push('launcher');
  if (missing.length) {
    return refuse(
      `configure needs ${missing.join(' and ')}. There is no workspace type to inherit ` +
        `from — an agent is a directory plus the knobs you freeze onto it, so every ` +
        `required knob arrives here or nowhere. ` +
        `priority: what this agent outranks when the machine is full (a defaulted one ` +
        `would sit at the floor and be preemptable by everything). ` +
        `launcher: one of ${knownLaunchers().join(', ')}.`
    );
  }

  const priority = data.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    return refuse(`Invalid priority: expected a finite number, got ${JSON.stringify(priority)}`);
  }

  const launcher = data.launcher;
  if (typeof launcher !== 'string' || !launcher.trim()) {
    return refuse(`Invalid launcher: expected a non-empty string, got ${JSON.stringify(launcher)}`);
  }
  try {
    resolveLauncher(launcher.trim());
  } catch (e: any) {
    return refuse(e?.message ?? String(e));
  }

  // `gateExempt: true` is accepted as shorthand for all three flags false —
  // it is what the old per-type flag meant, and callers carrying it forward
  // should not have to translate. Supplying BOTH the shorthand and an explicit
  // flag is refused rather than resolved: whichever won would be a silent
  // choice about whether an agent can be refused, charged or preempted.
  const explicit = (['refusable', 'chargeable', 'preemptable'] as const).filter(
    (name) => data[name] !== undefined
  );
  let defaults = true;
  if (data.gateExempt !== undefined) {
    if (typeof data.gateExempt !== 'boolean') {
      return refuse(
        `Invalid gateExempt: expected true or false, got ${JSON.stringify(data.gateExempt)}`
      );
    }
    if (explicit.length) {
      return refuse(
        `gateExempt is shorthand for refusable/chargeable/preemptable all false, and you ` +
          `also passed ${explicit.join(', ')}. Which wins would be a silent decision about ` +
          `whether this agent can be refused, charged or stood down — pass the three flags ` +
          `you mean, or the shorthand, not both.`
      );
    }
    defaults = !data.gateExempt;
  }

  const flags: Record<string, boolean> = {};
  for (const name of ['refusable', 'chargeable', 'preemptable'] as const) {
    const value = data[name];
    if (value === undefined) {
      flags[name] = defaults;
      continue;
    }
    if (typeof value !== 'boolean') {
      return refuse(`Invalid ${name}: expected true or false, got ${JSON.stringify(value)}`);
    }
    flags[name] = value;
  }

  // The cross-field rule, and it gets a better addressee than it used to.
  // Standing down an uncharged agent frees no charged slot, so a preempt would
  // admit a newcomer over the cap on a false premise. As workspace-type config
  // this failed a daemon BOOT, where the person who wrote the mistake was long
  // gone; as a `configure` parameter it is refused synchronously, to the caller
  // who made it.
  if (!flags.chargeable && flags.preemptable) {
    return refuse(
      `chargeable: false with preemptable: true is incoherent. An uncharged agent does not ` +
        `occupy a slot, so standing it down frees nothing — the preempt path would admit a ` +
        `newcomer over the cap on the false premise that room had been made. Either charge ` +
        `it (chargeable: true) or take it out of preemption too (preemptable: false).`
    );
  }

  let prompt: string | undefined;
  if (data.prompt !== undefined) {
    // Text, and NOT trimmed, NOT parsed, NOT resolved as a path. These are the
    // bytes the agent will read; the only thing done to them is a length
    // check. A prompt that happens to contain doubled-brace placeholder syntax,
    // or to look like a filename, reaches the sidecar exactly as written.
    if (typeof data.prompt !== 'string' || !data.prompt.length) {
      return refuse(
        `Invalid prompt: expected the agent's bootstrap text as a non-empty string, got ` +
          `${JSON.stringify(data.prompt)}. It is finished text rather than a path or a ` +
          `template — CrabCast writes it verbatim and never inspects it, so render it before ` +
          `you send it.`
      );
    }
    if (data.prompt.length > MAX_PROMPT_CHARS) {
      return refuse(
        `Prompt is too large: ${data.prompt.length} characters, and the limit is ` +
          `${MAX_PROMPT_CHARS}. The prompt travels inline over the socket, whose framing ` +
          `gives up on a line past ${MAX_LINE_CHARS} characters and closes the connection — ` +
          `this limit sits below that with room for JSON escaping, so every prompt accepted ` +
          `here is one that arrives. NOTHING WAS TRUNCATED and nothing was configured: an ` +
          `agent silently given half its instructions is worse than one that was refused.`
      );
    }
    prompt = data.prompt;
  }

  let mcpServers: string[] | undefined;
  if (data.mcpServers !== undefined) {
    if (!Array.isArray(data.mcpServers) || data.mcpServers.some((s: any) => typeof s !== 'string')) {
      return refuse(`Invalid mcpServers: expected an array of strings`);
    }
    mcpServers = data.mcpServers as string[];
  }

  let label: string | undefined;
  if (data.label !== undefined) {
    if (typeof data.label !== 'string') {
      return refuse(`Invalid label: expected a string, got ${JSON.stringify(data.label)}`);
    }
    label = data.label;
  }

  return {
    ok: true,
    config: {
      priority,
      refusable: flags.refusable,
      chargeable: flags.chargeable,
      preemptable: flags.preemptable,
      launcher: launcher.trim(),
      ...(prompt ? { prompt } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(label !== undefined ? { label } : {})
    }
  };
}

export class MessageRouter {
  private activePtyListeners = new Map<string, () => void>();

  constructor(private deps: RouterDeps) {}

  public handle(data: any): void {
    // Responses echo the request's `id` so a transport can correlate them.
    const respond: Respond = (msg) =>
      this.deps.send(data.id !== undefined ? { ...msg, id: data.id } : msg);

    // Fire-and-forget actions only reply when a caller asked to be
    // correlated, so a streaming client doesn't get an ack per keystroke.
    const ack: Respond = (msg) => {
      if (data.id !== undefined) this.deps.send({ ...msg, id: data.id });
    };

    // The activate handler is async (it verifies the agent against herdr's
    // census before answering). A rejected handler promise would otherwise
    // escape the try/catch the daemon wraps this call in and surface as an
    // unhandled rejection, leaving the caller waiting on a response that
    // never comes.
    const guard = (p: Promise<void>, action: string) =>
      p.catch((err: any) => {
        console.error(`Handler error in ${action}:`, err?.message ?? String(err));
        respond({
          action: `${action}_response`,
          success: false,
          error: err?.message ?? String(err)
        });
      });

    switch (data.action) {
      case 'daemon_status': {
        const { config, daemonStartedAt, agentRegistry, bootBuild } = this.deps;
        const intents = agentRegistry.intents();
        // What this process was built from, and whether that is still what is
        // on disk (KAN-122). Computed per request rather than cached, because
        // half the answer is about the tree as it is RIGHT NOW — a daemon that
        // cached "current" at boot would report it forever, including for the
        // hour after somebody rebuilt underneath it.
        const { build, freshness } = buildProvenanceReport(bootBuild);
        respond({
          // Every other reply in this router carries one, and this was the
          // single exception. Butchr's client layer dispatches purely on
          // `action` (KAN-122), and an inconsistency that survives because it
          // was never worth fixing alone is a trap for whoever meets it next.
          // Clients still correlate by `id` — see cli.ts DaemonClient — and
          // adding this changes nothing about that.
          action: 'daemon_status_response',
          success: true,
          pid: process.pid,
          startedAt: daemonStartedAt.toISOString(),
          configPath: config.configPath,
          dataDir: config.dataDir,
          // What used to be `workspaceTypes` — the answer to "is the daemon up
          // with the config I just edited". There is no type table any more, so
          // the equivalent question is about the durable registry, which is now
          // the only place an agent's configuration exists.
          registryPath: agentRegistry.path,
          configuredAgents: intents.size,
          expectedAgents: Array.from(intents.values()).filter((i) => i.event === 'activated').length,
          build,
          freshness
        });
        return;
      }
      case 'configure_agent':
        this.handleConfigure(data, respond);
        return;
      case 'activate_agent':
        void guard(this.handleActivate(data, respond), 'activate');
        return;
      case 'deactivate':
        this.handleDeactivateSession(data, respond);
        return;
      case 'deactivate_agent':
        this.handleDeactivateAgent(data, respond);
        return;
      case 'forget_agent':
        this.handleForget(data, respond);
        return;
      case 'send_to_agent':
        this.handleSendToAgent(data, respond);
        return;
      case 'tail_agent':
        this.handleTailAgent(data, respond);
        return;
      case 'agent_status':
        this.handleAgentStatus(data, respond);
        return;
      case 'list_agents':
        this.handleListAgents(data, respond);
        return;
      case 'capacity':
        this.handleCapacity(data, respond);
        return;
      case 'pty_init':
        this.handlePtyInit(data, respond);
        return;
      case 'pty_input':
        this.handlePtyInput(data, ack);
        return;
      case 'pty_resize':
        this.handlePtyResize(data, ack);
        return;
      default:
        // `reset_by_key` lands here, by name, and that is the point of removing
        // the verb rather than redefining it: `reset` was a stand-down plus a
        // deletion that is now refused unconditionally (CrabCast allocates no
        // directories, so the set of directories it may delete is empty by
        // construction). A redefined `reset` would let every caller keep
        // calling it and quietly mean something else; an unknown action makes
        // them notice.
        respond({
          success: false,
          error:
            `Unknown action: ${typeof data?.action === 'string' ? data.action : JSON.stringify(data?.action)}` +
            (typeof data?.action === 'string' && /reset/.test(data.action)
              ? `. \`reset\` was removed: CrabCast no longer creates the directory an agent runs ` +
                `in, so it may not delete one either. Use \`deactivate_agent\` to stop an agent ` +
                `and \`forget_agent\` to remove its record.`
              : '')
        });
    }
  }

  // ------------------------------------------------------------- addressing

  /**
   * The canonical path a request is about, or the refusal.
   *
   * `strict` is the difference between "run something here" and "say something
   * about a record". An activation needs a directory that exists — it is about
   * to spawn a process into it. `deactivate`, `forget` and `status` must keep
   * working after the caller has deleted the directory, because that is exactly
   * when "stop expecting this" is asked for; they fall back to the lexical
   * resolve so the record can still be addressed.
   *
   * THE FALLBACK IS SCOPED TO ONE PROBLEM, and it took a review to make that
   * true. `strict: false` used to mean "on any PathError, resolve it
   * lexically" — but PathError has five causes, and the fallback was reasoned
   * out for exactly one of them (the directory is gone). `not-absolute` landed
   * in the same branch, so a relative path reached `path.resolve` HERE, in a
   * detached daemon whose cwd belongs to whichever client first spawned it.
   * That is the precise failure identity.ts refuses by name, still live in
   * three verbs after being fixed everywhere else — and refusing it in one
   * place while silently resolving it in another is worse than either, because
   * the refusal is what teaches a caller to resolve their own paths.
   *
   * So the discriminator decides, not the flag alone. `does-not-exist` is
   * recoverable; every other problem is refused by every verb, always. A cause
   * added to {@link PathProblem} later is refused until somebody argues it into
   * this switch, which is the direction a default should fail in.
   */
  private addressOfRequest(input: unknown, strict: boolean): { path: string } | { error: string } {
    try {
      return { path: canonicalPath(input) };
    } catch (e: any) {
      const recoverable =
        !strict && e instanceof PathError && e.problem === 'does-not-exist' && typeof input === 'string';
      if (!recoverable) {
        return { error: e?.message ?? String(e) };
      }
      // Lexical only, and safe precisely because we got here: the path is
      // absolute (`not-absolute` is refused above), so this resolve cannot
      // consult the daemon's cwd — it only normalizes `..` and `.` segments.
      // It is what the record would have been keyed by if the directory were
      // still there, and looking it up is harmless: the record either exists
      // under that string or it does not.
      return { path: path.resolve(input.trim()) };
    }
  }

  // -------------------------------------------------------------- configure

  /**
   * `configure(path, knobs)` — the verb that makes an agent exist.
   *
   * IT DOES NOT REFUSE AN OCCUPIED DIRECTORY, and that is load-bearing rather
   * than lax. The adopting caller's day-one sequence is: configure the fleet,
   * stand down their own panes, activate. A `configure` that inherited
   * `activate`'s occupancy guard would fail every call on cutover day and make
   * the required ordering undiscoverable. So it succeeds and hands back
   * `occupiedBy` as advisory, hours before the occupant would otherwise bite.
   * That is the difference between the guard being safe and being usable.
   *
   * IT MAY NOT `mkdir`. Every path now comes from the caller, so the
   * filesystem is the only thing left that can tell a directory you meant from
   * one you mistyped — see identity.ts.
   */
  private handleConfigure(data: any, respond: Respond): void {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'configure_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    const parsed = parseAgentConfig(data);
    if (!parsed.ok) {
      fail(parsed.error, { path: agentPath, ...(parsed.missing.length ? { missing: parsed.missing } : {}) });
      return;
    }

    const intents = this.deps.agentRegistry.intents();
    const existing = intents.get(agentPath);

    // ONE census read, shared by the running check and the advisory below.
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, existing?.record.config.launcher ?? parsed.config.launcher
    );
    const session = this.deps.herdrBridge.getSessionByPath(agentPath);
    const running = Boolean(session) || (occupancy.reachable && occupancy.ours !== null);

    // RECONFIGURING A RUNNING AGENT IS REFUSED WHOLE, HERE.
    //
    // The per-attribute answer — priority, the gate flags and label change in
    // place while launcher, prompt and mcpServers refuse — is the next-but-two
    // slice's, and it is strictly more permissive than this. Shipping the
    // permissive half first would mean this PR could rewrite the launcher or
    // the prompt under a live agent, which is a different process and a file
    // it has already read: a destroy-and-recreate wearing a config diff's
    // clothes. So the conservative superset ships with the verb, and the
    // relaxation ships with the per-attribute rules that make it safe.
    if (running && existing) {
      fail(
        `Refusing to reconfigure ${agentPath} while an agent is running in it. Some of these ` +
          `values are read once, at spawn: the launcher IS the process, and the prompt has ` +
          `already been read. Applying them under a live agent would either do nothing or ` +
          `mean a different agent, and neither is what a configuration change asks for. ` +
          `Stand it down first: deactivate(path), configure(path, …), activate(path).`,
        {
          path: agentPath,
          refused: 'running',
          applied: [],
          ...(occupancy.reachable && occupancy.ours
            ? { paneId: occupancy.ours.paneId }
            : {})
        }
      );
      return;
    }

    const record: AgentRecord = { path: agentPath, config: parsed.config };

    const durable = this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordConfigured(record),
      `configured ${agentPath}`
    );

    const occupiedBy = occupancy.reachable ? occupancy.occupants : [];

    this.deps.broadcast({
      action: 'agent_configured_event',
      success: true,
      path: agentPath,
      config: parsed.config
    });

    respond({
      action: 'configure_response',
      success: true,
      path: agentPath,
      paneName: paneNameFor(agentPath),
      config: parsed.config,
      reconfigured: Boolean(existing),
      // Advisory, never a refusal. Empty means the census answered and found
      // nothing live here.
      occupiedBy,
      // And when the census could NOT answer, that is said rather than
      // rendered as an all-clear: an empty `occupiedBy` from an unreachable
      // herdr would be a check reporting its own failure as good news.
      ...(occupancy.reachable
        ? {}
        : {
            occupancyUnknown: true,
            note:
              'herdr did not answer, so this configure could not check whether anything is ' +
              'already running in that directory. The record is written either way; ' +
              'activate will refuse rather than guess.'
          }),
      ...(occupiedBy.length
        ? {
            note:
              `Something is already running in ${agentPath}. The record is written, but ` +
              `activate will REFUSE until that pane is gone — stand it down, then activate.`
          }
        : {}),
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error })
    });
  }

  // ----------------------------------------------------------------- forget

  /**
   * `forget(path)` — the verb that makes an agent stop existing.
   *
   * IT REFUSES A RUNNING AGENT, and there is deliberately no `force`. No verb
   * here may terminate an agent as a side effect of a call that is not named
   * "stop it": only `deactivate` does that, and preemption, which is explicit,
   * opt-in, strictly-greater and reported. A `forget` that implicitly stopped a
   * live agent would be destroy-and-recreate wearing a different name, and a
   * force flag is that same path with a label on it. `deactivate` then `forget`
   * is the same two calls and leaves TWO decisions in the append-only log
   * instead of one flag nobody can audit.
   *
   * IT SUCCEEDS ON A PATH THAT WAS NEVER CONFIGURED, where `deactivate`
   * refuses, and the asymmetry has a rule behind it: `forget`'s postcondition
   * is the absence of a record, and absence is verifiable — it already holds.
   * `deactivate`'s postcondition is a claim about an agent, and there is no
   * agent to make a claim about; answering "stopped" for a path that never
   * held one is `success: true` about a world that does not exist.
   */
  private handleForget(data: any, respond: Respond): void {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'forget_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    const existing = this.deps.agentRegistry.intents().get(agentPath);
    if (!existing) {
      respond({
        action: 'forget_response',
        success: true,
        path: agentPath,
        existed: false,
        removed: [],
        note: 'No agent was configured there. The postcondition — no record for this path — already held.'
      });
      return;
    }

    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, existing.record.config.launcher
    );
    const session = this.deps.herdrBridge.getSessionByPath(agentPath);

    if (session || (occupancy.reachable && occupancy.ours)) {
      fail(
        `Refusing to forget ${agentPath}: an agent is running in it. Forgetting the record ` +
          `would leave a live pane nothing here can address — no stand-down, no status, no ` +
          `tail. Stop it first: deactivate(path), then forget(path). There is no force flag, ` +
          `deliberately: two calls leave two decisions in the log, and a flag leaves one ` +
          `nobody can audit.`,
        {
          path: agentPath,
          refused: 'running',
          paneId: occupancy.reachable ? (occupancy.ours?.paneId ?? null) : null
        }
      );
      return;
    }

    // A live pane that this daemon cannot POSITIVELY establish is not ours.
    //
    // The check above asks "is the live thing mine". This one asks the other
    // question — "is anything live here at all" — and the two are not
    // complements: that is the rule this daemon states for `activate`, and it
    // has to hold one verb over. Reading `ours: null` as "nothing is there"
    // and deleting the record on the strength of it is how a live agent with
    // bypassPermissions ends up in a caller's repository with nothing left
    // that can address it — which is the outcome the refusal above names as
    // the reason it exists.
    //
    // The ownership test is a positive one now (a pane bearing the name this
    // path derives), so an occupant that is not ours is PROVABLY not ours and
    // this could in principle let it through. It does not, because the cost of
    // the two mistakes is not symmetric: refusing wrongly costs one call after
    // stopping a pane the caller can see named below, and forgetting wrongly
    // costs an unaddressable agent nobody can find again.
    if (occupancy.reachable && occupancy.occupants.length > 0) {
      fail(
        `Refusing to forget ${agentPath}: ${occupancy.occupants.length} live pane(s) are in ` +
          `that directory, and none of them is this agent's.\n` +
          occupancy.occupants.map((o) => `  ${this.describeOccupant(o)}`).join('\n') +
          `\nThe record is KEPT. "Not ours" and "nothing is there" are different facts, and ` +
          `dropping the only record of an agent while something is live where it runs is the ` +
          `one way to produce a live agent nothing can address. Stop the pane above, or ` +
          `deactivate this agent first if it is the one you meant.`,
        { path: agentPath, refused: 'occupied', occupiedBy: occupancy.occupants }
      );
      return;
    }

    // The census could not answer AND the record says this agent is supposed
    // to be running. Silence is not evidence: forgetting on the strength of it
    // is the same mistake as spawning on the strength of it, one verb over.
    if (!occupancy.reachable && existing.event === 'activated') {
      fail(
        `Refusing to forget ${agentPath}: herdr did not answer, so whether an agent is ` +
          `running there could not be checked — and the registry records this agent as ` +
          `active. An unreachable herdr is silence, not evidence that nothing is there. ` +
          `Bring herdr up, or deactivate first.`,
        { path: agentPath, refused: 'unverifiable' }
      );
      return;
    }

    const durable = this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordForgotten(existing.record),
      `forgot ${agentPath}`
    );

    // What was removed and what was deliberately left. The sidecar holds this
    // agent's rendered prompt and is entirely inside CrabCast's own data
    // directory, so it is safe to delete — but residue cleanup (the sidecar,
    // the `.mcp.json` key, the trust entry) is the next slice's, and naming
    // what is left is how that stays visible rather than becoming a surprise.
    const sidecar = this.deps.herdrBridge.sidecarDirFor(agentPath);

    this.deps.broadcast({
      action: 'agent_forgotten_event',
      success: true,
      path: agentPath,
      removed: ['record']
    });

    respond({
      action: 'forget_response',
      success: true,
      path: agentPath,
      existed: true,
      removed: ['record'],
      left: fs.existsSync(sidecar) ? [sidecar] : [],
      ...(fs.existsSync(sidecar)
        ? {
            note:
              `The record is gone. ${sidecar} still holds this agent's rendered prompt — ` +
              `removing it is not yet implemented, and it is named here rather than left ` +
              `for somebody to find.`
          }
        : {}),
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error })
    });
  }

  // ------------------------------------------------------------- the gate

  /**
   * Whether the machine can carry another agent, checked before spawning one.
   *
   * Only consulted when a *new* agent would be created: re-attaching to an
   * agent that is already running costs the machine nothing, and refusing that
   * would be refusing to look at work already in flight.
   *
   * An override is honoured — a cap that cannot be exceeded on purpose is a
   * cap people work around — but it is recorded rather than waved through.
   *
   * `refusable: false` passes unconditionally. This is the first of the three
   * decisions the old `gateExempt` boolean was carrying (the other two are in
   * {@link preemptionCandidates} and {@link capacityOf}), and the argument for
   * it is unchanged: the capacity model has already declined to charge an
   * unchargeable agent, so refusing one here would be the gate arguing with
   * its own arithmetic. It was also a lockout in practice — desktop baseline
   * load alone can pin headroom at 0 indefinitely, so an always-on agent could
   * never start without a manual override.
   */
  private capacityGate(request: GateRequest): CapacityGateResult {
    const { path: agentPath, paneName, priority, refusable, override, preempt } = request;
    const pass = (capacity: Capacity): CapacityGateResult => ({
      capacity,
      refusal: null,
      overrode: null,
      preemptable: null,
      preempted: null
    });

    const { agents } = this.surveyAgents();

    if (agents.some((a) => a.path === agentPath)) {
      // Already alive and already counted. Starting nothing costs nothing.
      return pass(this.capacityOf(agents));
    }

    const capacity = this.capacityOf(agents);

    if (!refusable) return pass(capacity);

    if (!capacity.atCapacity) return pass(capacity);

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — an agent
    // on a machine full of agents of its own priority outranks nothing.
    const candidates = this.preemptionCandidates(agents, agentPath);
    const victim = selectVictim(candidates, priority);
    const derivation = describeCapacity(capacity);
    const offer = (v: PreemptionCandidate): PreemptionOfferDto => ({
      path: v.path,
      paneName: v.paneName,
      priority: v.priority,
      herdrStatus: v.herdrStatus,
      incomingPriority: priority,
      offer: preemptionOffer(v, priority)
    });

    if (preempt && victim) {
      const at = new Date().toISOString();
      const preemption: PreemptionRecord = {
        byPath: agentPath,
        byPaneName: paneName,
        byPriority: priority,
        priority: victim.priority,
        herdrStatus: victim.herdrStatus,
        derivation
      };

      // Through the ordinary stand-down path rather than a teardown of its
      // own. `deactivate_agent` already handles every case this needs — a live
      // session and an agent that outlived its daemon — and answers honestly
      // about which it found. Preemption reusing it means there is one way an
      // agent stops, not two.
      let standDown: any = null;
      this.handleDeactivateAgent(
        { path: victim.path, preemption },
        (msg: any) => {
          standDown = msg;
        }
      );

      if (!standDown?.success) {
        // Nothing was freed, so nothing may start. Refusing here is the
        // important half: proceeding would leave the machine over capacity
        // *and* have announced a preemption that did not happen.
        const error =
          `Refusing to activate ${agentPath}: standing down ${addressOf(victim)} to make room ` +
          `failed (${standDown?.error ?? 'no reason given'}), so no capacity was freed.\n` +
          derivation;
        console.error(`[capacity] preemption aborted: ${error}`);
        return { capacity, refusal: error, overrode: null, preemptable: offer(victim), preempted: null };
      }

      console.warn(
        `[capacity] preemption: ${agentPath} (priority ${priority}) stood down ` +
        `${describeCandidate(victim)} at ${at}\n${derivation}`
      );
      // The event carries the full PreemptionRecord. The durable copy was
      // written by the stand-down above, which is what keeps `preemptedAgents`
      // reporting this debt until somebody re-activates the victim. The
      // broadcast is the live announcement, not the record, but nothing here
      // may drop a field of it: it is also what a client renders.
      this.deps.broadcast({
        action: 'agent_preempted_event',
        success: true,
        at,
        victim: offer(victim),
        by: { path: agentPath, paneName, priority },
        record: preemption,
        capacity: capacityDto(capacity)
      });

      // Re-surveyed rather than reused: the caller is about to be told what the
      // machine looks like, and it is not the machine that refused a moment ago.
      //
      // The activation now proceeds unconditionally, and that is deliberate.
      // Only the count term responds to a stand-down immediately — the load
      // average is a one-minute mean and the kernel has not yet reclaimed the
      // memory — so re-running the whole gate here would sometimes refuse
      // *after* destroying an agent's work, which is the worst of both
      // outcomes.
      const after = this.capacityOf(this.surveyAgents().agents);
      return {
        capacity: after,
        refusal: null,
        overrode: null,
        preemptable: null,
        preempted: { at, victim: offer(victim), derivation }
      };
    }

    if (!override) {
      // Both branches name what is running and what it is worth. Losing a slot
      // is survivable; not being able to see who you lost it to is not.
      const refusal =
        `${capacityRefusal(capacity, agentPath)}\n` +
        (victim ? preemptionOffer(victim, priority) : noVictimReason(candidates, priority));
      return {
        capacity,
        refusal,
        overrode: null,
        preemptable: victim ? offer(victim) : null,
        preempted: null
      };
    }

    const at = new Date().toISOString();
    console.warn(
      `[capacity] override: starting ${agentPath} past capacity at ${at}\n${derivation}`
    );
    this.deps.broadcast({
      action: 'capacity_override_event',
      success: true,
      what: agentPath,
      at,
      capacity: capacityDto(capacity)
    });
    return {
      capacity,
      refusal: null,
      overrode: { at, derivation },
      preemptable: victim ? offer(victim) : null,
      preempted: null
    };
  }

  /**
   * Everything running that could be considered for a stand-down.
   *
   * `preemptable: false` agents are *excluded*, and the reason is arithmetic
   * as much as protection: an agent that is also unchargeable was never
   * counted in `running`, so standing one down frees no charged slot — the
   * machine would be exactly as full a moment later, and the preempt path
   * would admit the newcomer over the cap on the false premise that room was
   * made. This is the second of the three decisions the old `gateExempt`
   * boolean was carrying, and splitting them is what lets a caller have a
   * low-priority always-on agent that is charged but never taken.
   */
  private preemptionCandidates(
    agents: ListedAgent[],
    excludePath?: string,
    sharedIntents?: Map<string, AgentIntent>
  ): PreemptionCandidate[] {
    const candidates: PreemptionCandidate[] = [];

    // The caller's map when it has one — `list_agents` reads the registry once
    // for the whole response — and our own read otherwise, for the gate, which
    // is the only other caller and asks exactly once.
    const intents = sharedIntents ?? this.deps.agentRegistry.intents();

    for (const entry of agents) {
      if (excludePath && entry.path === excludePath) continue;
      if (!entry.preemptable) continue;

      const intent = intents.get(entry.path);
      // No record means no priority, and priority is not derivable from
      // anything else now that types are gone. An agent we cannot price is one
      // we must not offer as a victim — the comparison that authorises the kill
      // would have nothing on one side of it.
      if (!intent) continue;

      candidates.push({
        path: entry.path,
        paneName: entry.paneName,
        priority: intent.record.config.priority,
        herdrStatus: entry.herdrStatus,
        // The recorded activation time, which survives a daemon restart; the
        // session's creation time is the fallback. Null when neither knows —
        // absent data stays absent rather than being invented for the victim
        // ordering.
        activatedAt: (intent.event === 'activated' ? intent.at : null) ?? entry.createdAt
      });
    }

    return candidates;
  }

  /**
   * Write an activation down before it is acknowledged.
   *
   * Called on every successful activate, but only appends when it would change
   * something: re-activating an agent already recorded as activated with the
   * same pane is a no-op, and fleet clients activate often enough that
   * recording each one would fill the log with restatements of the same intent.
   *
   * The comparison is on the configuration, and that is the whole of it:
   * `activate` takes no attributes, so there is nothing a caller could pass
   * that might disagree with the record, and the pane an agent happens to be
   * in is no longer written down (see AgentRecord). So an activation of an
   * already-activated agent whose config has not changed genuinely changes
   * nothing, and appending would be a restatement.
   */
  private rememberActivated(record: AgentRecord): RecordOutcome {
    const current = this.deps.agentRegistry.intents().get(record.path);
    if (
      current?.event === 'activated' &&
      JSON.stringify(current.record.config) === JSON.stringify(record.config)
    ) {
      // The disk already knows exactly this — a skipped restatement is durable.
      return { ok: true };
    }
    return this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordActivated(record),
      `activated ${record.path}`
    );
  }

  /**
   * Make a registry write failure observable outside the daemon log.
   *
   * The registry itself never throws — an unwritable log must not fail the
   * lifecycle operation the caller is in the middle of — but a swallowed
   * failure is the KAN-21 silent loss re-entering through the error path: the
   * agent exists, the disk does not know, and the next boot forgets it. So
   * the failure is broadcast to every connected client, and the caller puts
   * `durable: false` on its response, which is the difference between "the
   * daemon said yes and the disk knows" and "the daemon said yes".
   */
  private surfaceRegistryOutcome(outcome: RecordOutcome, what: string): RecordOutcome {
    if (!outcome.ok) {
      this.deps.broadcast({
        action: 'registry_degraded_event',
        success: false,
        what,
        error: outcome.error ?? 'registry write failed',
        consequence:
          'This lifecycle event is not durably recorded: a daemon restart will not know about it. ' +
          'Fix the data directory (space, permissions) and re-issue the operation.'
      });
    }
    return outcome;
  }

  /**
   * Write a stand-down down, so reconciliation leaves this agent alone.
   *
   * This is the half of the registry that makes it *intent* rather than
   * history: without it, boot-time restoration would resurrect every agent
   * anyone had ever run. Recorded even when the teardown failed — the caller
   * asked for the agent to be gone, and that is the intent to honour.
   *
   * The whole configuration travels onto the stand-down, and that is not
   * tidiness: it is the only copy. An agent recorded without it and then
   * switched back on would have no priority, no launcher and no gate flags,
   * which is not a degraded activation — it is an agent that cannot be
   * activated at all.
   */
  private rememberDeactivated(
    record: AgentRecord,
    preemption?: PreemptionRecord
  ): RecordOutcome {
    return this.surfaceRegistryOutcome(
      this.deps.agentRegistry.recordDeactivated(record, preemption),
      `deactivated ${record.path}${preemption ? ' (preempted)' : ''}`
    );
  }

  /**
   * The resume cause for an activation nobody labelled one.
   *
   * An agent whose last stand-down was a preemption is being *resumed* when it
   * is switched back on, whatever the caller thinks it is doing — and it must
   * be told so, or it comes back with its whole conversation restored and no
   * turn to take. That is the idle-forever failure, reached by a route that
   * has nothing to do with booting: nobody rebooted anything, a person just
   * turned a switch back on.
   *
   * An explicit cause always wins; only boot-time reconciliation sets one.
   */
  private resumeCauseFor(agentPath: string, explicit?: ResumeCause): ResumeCause | undefined {
    if (explicit) return explicit;
    // `stoppedByPreemption`, not `preemptionFor`: compaction drops the
    // annotation naming who took the slot and keeps `wasPreempted`, and an
    // agent whose debt has been compacted away was still interrupted. Reading
    // only the annotation meant a compacted victim came back with its whole
    // conversation restored, no resume framing, and no nudge — sitting at an
    // empty prompt forever.
    return this.deps.agentRegistry.stoppedByPreemption(agentPath) ? 'preempted' : undefined;
  }

  /**
   * Tell a just-resumed agent to carry on, without making the caller wait.
   *
   * Fire-and-forget on purpose: the nudge waits up to two minutes for the
   * agent's prompt to appear, and an activate that blocked on that would time
   * out in every client. Scheduled onto a later turn rather than merely
   * un-awaited, which is not fussiness — the first thing the nudge does is
   * read the agent's pane through an `execSync` with a five-second ceiling, and
   * starting that inside this call would run it BEFORE the handler reaches
   * `respond`.
   */
  private nudgeIfResumed(session: HerdrSession, config: AgentConfig): void {
    if (!session.resume || session.resumedConversation !== true) return;
    const cause = session.resume;
    setTimeout(() => {
      void nudgeResumedAgent({
        herdrBridge: this.deps.herdrBridge,
        path: session.path,
        cause,
        launcher: config.launcher,
        log: (...args: any[]) => console.log(...args)
      });
    }, 0);
  }

  /**
   * The step that makes an activate response a statement about the world
   * rather than about our own intentions.
   *
   * Returns the complaint when success cannot honestly be claimed, and the
   * pane id when the agent has been confirmed to exist. It runs after herdr's
   * own errors have been dealt with, before anything is broadcast or answered
   * — so there is exactly one point at which activate decides it succeeded.
   *
   * A confirmed-absent agent takes its session down with it. That is not a
   * retry and not a cleanup: it is the difference between a failure a caller
   * can act on and one it is locked out of, because a session left active is
   * the one the next activate would reuse. An unverifiable answer changes
   * nothing — see abandonSession.
   */
  private async confirmActivation(
    session: HerdrSession
  ): Promise<{ error: string } | { paneId: string | null }> {
    // Existence means a live runtime for every launcher but `shell` — a name
    // registration over a dead pane must not verify (KAN-58). Sessions that
    // reached this point were built by initPty, which sets the field; an
    // unset one gets the strict reading rather than the lenient one.
    const presence = await this.deps.herdrBridge.confirmAgentPresent(
      session.paneName,
      session.expectsRuntime ?? true
    );
    if (presence.present) return { paneId: presence.paneId };

    console.error(
      `[Router] Refusing to report ${session.paneName} activated: ${presence.error}`
    );
    if (presence.reason === 'absent') {
      this.deps.herdrBridge.abandonSession(session.sessionId, presence.error);
    }
    return { error: presence.error };
  }

  /** How a refusal names a pane that is not ours. */
  private describeOccupant(o: PaneOccupant): string {
    return (
      `pane_id ${o.paneId ?? '(not reported)'}, name '${o.name}', ` +
      `agent_status ${o.agentStatus}${o.workDir ? `, cwd ${o.workDir}` : ''}`
    );
  }

  // --------------------------------------------------------------- activate

  /**
   * `activate(path)` — the verb that makes a configured agent run.
   *
   * NO INLINE OPTIONS. Everything an agent is comes from its record, so there
   * is nothing here a caller could pass that might disagree with what the
   * agent already is. `override` and `preempt` are not attributes of the
   * agent; they are decisions about the machine, taken by whoever pressed the
   * button.
   *
   * THREE OUTCOMES BEFORE ANYTHING SPAWNS, and the third is the whole point:
   *
   *   - nothing live in the directory        → spawn
   *   - something live and it is ours        → alreadyRunning
   *   - something live and it is NOT ours    → REFUSE, naming every pane
   *   - the census could not answer at all   → REFUSE as unverifiable
   *
   * The last one is the case that would otherwise fail silently.
   * `listHerdrAgentsChecked` returns an EMPTY census when herdr does not
   * answer, so a guard built the obvious way reads its own failure as an
   * all-clear and spawns into an occupied directory precisely when it cannot
   * see it. `reachable: false` is silence, not evidence.
   *
   * SAFE TO CALL AGAIN — A CONTRACT, NOT AN OBSERVATION. A supervisor
   * reconciles by diffing desired state against actual and calling the verbs
   * to close the gap, so it calls this on agents that are already exactly as
   * asked for, constantly. That call:
   *
   *   - answers `success: true` with `alreadyRunning: true`, never an error;
   *   - starts no second pane, and says `started: false`;
   *   - never touches the capacity gate, because nothing new is being
   *     charged for — an agent already running is already counted;
   *   - ATTACHES IF WE HOLD NO TERMINAL FOR IT, and always answers with a
   *     `sessionId`. Ownership and attachment are different facts (see
   *     `ourPaneIn`), and a daemon restart is where they part company: the
   *     panes survive, the session map does not. Attaching is not starting —
   *     it is `herdr agent attach` and nothing else — which is why this stays
   *     on the no-op side of the contract above;
   *   - and CONVERGES THE RECORD: if the disk says this agent was never
   *     started while our pane is live, this call writes the activation, so
   *     calling again is what repairs a durability failure rather than
   *     papering over it.
   *
   * `alreadyRunning` and `started` are on EVERY successful response, `true`
   * or `false`. A field that appears only when true asks the caller to read
   * meaning into an absence, which is the same shape of guess this daemon
   * refuses everywhere else.
   *
   * WHAT IDEMPOTENCE DOES NOT COVER, stated here because the two paths meet
   * in this function and confusing them turns a safety refusal into a silent
   * success: a LIVE FOREIGN PANE in the target directory refuses, always. It
   * is not "already as specified" — it is somebody else's agent, and the
   * ownership test is what separates the two. Making that refusal idempotent
   * would mean answering "already running" about a pane we did not start.
   *
   * ACCEPTED RESIDUAL RISK, WRITTEN DOWN RATHER THAN CLOSED: the occupancy
   * check and the spawn are not atomic. A pane appearing in the target
   * directory between them defeats the guard. CrabCast-against-CrabCast is
   * still caught by the path-derived pane name (herdr refuses the taken name);
   * CrabCast-against-a-stranger inside that window is not. The window is small
   * and closing it properly needs a lock that does not exist here, so it is
   * stated rather than papered over.
   */
  public async handleActivate(data: any, respond: Respond): Promise<void> {
    const { herdrBridge } = this.deps;
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'activate_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;
    const paneName = paneNameFor(agentPath);

    // Before anything is looked up, because both of these decide what happens
    // to agents other than this one. See invalidFlag.
    const badFlag = invalidFlag('override', data.override) ?? invalidFlag('preempt', data.preempt);
    if (badFlag) {
      fail(badFlag, { path: agentPath });
      return;
    }

    // `configure` is mandatory and this is where that is enforced. The refusal
    // names what is missing rather than merely saying no, because a caller
    // that is only told "no" retries the same call forever.
    const intent = this.deps.agentRegistry.intents().get(agentPath);
    if (!intent) {
      fail(
        `No agent is configured at ${agentPath}. \`activate\` takes no attributes — an agent ` +
          `is its directory plus the knobs \`configure\` froze onto it, and nothing here can ` +
          `invent them. Missing: priority, launcher (and optionally prompt, mcpServers, label, ` +
          `refusable, chargeable, preemptable). Call configure(path, …) first.`,
        { path: agentPath, refused: 'not-configured', missing: ['priority', 'launcher'] }
      );
      return;
    }
    const config = intent.record.config;

    // ONE census read, answering both "is anything live here" and "is it ours".
    const census = herdrBridge.listHerdrAgentsChecked();
    const occupancy = herdrBridge.occupancyOf(census, agentPath, config.launcher);

    if (!occupancy.reachable) {
      fail(
        `Refusing to activate ${agentPath}: herdr did not answer \`agent list\`, so whether ` +
          `anything is already running in that directory could not be checked. An empty ` +
          `census from an unreachable herdr is silence, not evidence — spawning on the ` +
          `strength of it would put a second agent into an occupied directory precisely ` +
          `when we cannot see it. NOTHING WAS STARTED. Bring the herdr server up and retry.`,
        { path: agentPath, refused: 'unverifiable', verified: false, started: false }
      );
      return;
    }

    // OURS FIRST, and the order matters. Asking "is anything here" before "is
    // this mine" is what let a co-occupant decide the answer: our own agent
    // plus a stranger in the same directory would take the refusal branch and
    // report our live agent as unstartable.
    if (occupancy.ours) {
      // Not an error, and no second pane. `activate` on a running agent is
      // the ordinary state of a caller reconciling towards desired state.
      //
      // A stranger sharing the directory does NOT turn this into a refusal —
      // our agent is already there and refusing would not un-share it — but it
      // is reported rather than swallowed, because two agents in one directory
      // is the thing this whole guard exists to make visible.
      const coOccupants = occupancy.occupants.filter((o) => o.name !== paneName);

      // THE RECORD IS PART OF THE POSTCONDITION, not a side effect of
      // spawning — and this is what makes the no-op a reconciling answer
      // rather than merely a quiet one.
      //
      // The state it repairs is reachable and this daemon already says so
      // elsewhere: handleDeactivateAgent notes that "a durable write that
      // failed after an activation leaves exactly that state over a live
      // pane". Get there — an EIO on the registry write, a stand-down whose
      // pane outlived the daemon that recorded it — and the record says
      // `configured` or `deactivated` while our pane is live. Without this
      // write, the retry a supervisor makes precisely to repair that answers
      // `success: true, alreadyRunning: true`, repairs nothing, and reports no
      // durability problem: the agent stays out of `expected()`, so the next
      // boot does not restore it and the fleet reads it as never started while
      // it works. A verb whose whole job is being safe to call again must not
      // have a call that cannot converge.
      //
      // `rememberActivated` short-circuits when the disk already says exactly
      // this, so the steady-state no-op writes nothing at all — the repair
      // costs a row only on the call that actually needed it.
      const recordWasBehind = intent.event !== 'activated';
      const durable = this.rememberActivated({ path: agentPath, config });

      // THE SECOND QUESTION, ASKED SEPARATELY (KAN-136). `occupancy.ours`
      // answers "is this pane ours"; it says nothing about whether THIS daemon
      // holds its terminal, and a daemon restart is exactly the state where
      // the two disagree — herdr owns the panes, the session map died with the
      // process. Returning from here on ownership alone left every restored
      // agent recognised and unreachable: `list_agents` reported it
      // `sessionless`, the response carried no `sessionId`, and this daemon's
      // own advice to a client whose session died — "ask for the agent again
      // by path and use the session id that comes back" — had no session id to
      // come back. The only route to a live attach was `deactivate` →
      // `activate`: killing the agent you were trying to reach.
      //
      // ATTACHING IS NOT STARTING, and the distinction is the whole reason
      // this is safe. `attachSession` runs `herdr agent attach` and nothing
      // else: no `agent start`, no provisioning, no second pane. `started`
      // below is still `false`, the capacity gate is still untouched — an
      // agent already running is already counted — and the foreign-occupant
      // refusal below is still the branch a pane that is not ours takes.
      let session = herdrBridge.getSessionByPath(agentPath);
      const reattached = session === undefined;
      if (!session) {
        session = herdrBridge.attachSession(agentPath, config.launcher);

        // An attach that threw leaves the agent running and this daemon
        // without a terminal for it, which is not a success however healthy
        // the pane is. Reported on the same channel a refused spawn uses — a
        // response carrying `success: true` and no usable session is the
        // KAN-23 false success in its other direction.
        if (session.spawnError) {
          fail(session.spawnError, {
            path: agentPath,
            paneName,
            paneId: occupancy.ours.paneId,
            alreadyRunning: true,
            started: false,
            // The record was converged above and stays converged: the agent
            // IS running, so `expected()` must contain it whether or not we
            // managed to take its terminal.
            ...(recordWasBehind ? { recordReconciled: true } : {})
          });
          return;
        }
      }

      // Only when this call produced the session. A client rendering a fleet
      // learns that an agent it could not reach is reachable again from the
      // same event a fresh activation sends; the steady-state no-op still
      // broadcasts nothing, because nothing changed.
      if (reattached) {
        this.deps.broadcast({
          action: 'agent_activated_event',
          success: true,
          path: agentPath,
          paneName,
          paneId: occupancy.ours.paneId,
          sessionId: session.sessionId,
          status: session.status
        });
      }

      respond({
        action: 'activate_response',
        success: true,
        path: agentPath,
        paneName,
        // Stated on every activate response, never inferred from absence: a
        // reconciler has to be able to tell "I started this" from "it was
        // already up" without parsing prose, and a field that only appears
        // when true is indistinguishable from a field a daemon forgot.
        alreadyRunning: true,
        started: false,
        paneId: occupancy.ours.paneId,
        // ON EVERY SUCCESSFUL ACTIVATE RESPONSE, both branches, for the same
        // reason `alreadyRunning` is: a caller must be able to reach the
        // agent it just asked about without a second call, and a field that
        // appears on one branch only asks it to guess which branch ran.
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        verified: true,
        // Present only when THIS call took the terminal back — the agent was
        // running and unreachable, and now is not. Silent on the steady-state
        // no-op, where the session was already ours.
        ...(reattached ? { reattached: true } : {}),
        // Present only when the disk disagreed with the world and this call
        // settled it. Silent when there was nothing to repair.
        ...(recordWasBehind ? { recordReconciled: true } : {}),
        // Same meaning as on the spawn path: the agent is running and
        // verified, but the disk does not know, so a restart will not restore
        // it. Reported here too, or the repair could fail as silently as the
        // damage it exists to undo.
        ...(durable.ok ? {} : { durable: false, durabilityError: durable.error }),
        ...(coOccupants.length
          ? {
              occupiedBy: coOccupants,
              note:
                `This agent is running, and ${coOccupants.length} pane(s) that are not ours ` +
                `are live in the same directory. Nothing was started and nothing was ` +
                `closed, but two agents in one directory is how work gets overwritten — ` +
                `the panes are named here so somebody can decide about them.`
            }
          : {})
      });
      return;
    }

    if (occupancy.occupants.length > 0) {
      fail(
        `Refusing to activate ${agentPath}: ${occupancy.occupants.length} live pane(s) are ` +
          `already running in that directory and none of them is ours.\n` +
          occupancy.occupants.map((o) => `  ${this.describeOccupant(o)}`).join('\n') +
          `\nNOTHING WAS STARTED. Two agents in one directory is how work gets overwritten ` +
          `and neither of them finds out. Stop the pane above, or point CrabCast at a ` +
          `different directory. This is not a claim on that pane: CrabCast never closes a ` +
          `pane it did not start.`,
        {
          path: agentPath,
          refused: 'occupied',
          verified: false,
          started: false,
          occupiedBy: occupancy.occupants
        }
      );
      return;
    }

    let session = herdrBridge.getSessionByPath(agentPath);

    // The census says nothing is live here, so a session we still hold is a
    // corpse. Releasing it up front is what lets THIS activate spawn, rather
    // than reusing a dead session and failing confirmation a full poll later.
    // Only past the runtime-confirm window: inside it, an empty pane is the
    // ordinary state of an agent still booting, and abandoning the session
    // would kill an activation another caller is still confirming.
    if (session && Date.now() - session.createdAt.getTime() >= RUNTIME_CONFIRM_TIMEOUT_MS) {
      herdrBridge.abandonSession(
        session.sessionId,
        `herdr has no live agent in ${agentPath}; the session was released before re-activating`
      );
      session = undefined;
    }

    let gate: CapacityGateResult | null = null;

    if (!session) {
      // Before the prompt is even rendered: the cheapest refusal is the one
      // that happens before any work is done for an agent that will not exist.
      gate = this.capacityGate({
        path: agentPath,
        paneName,
        priority: config.priority,
        refusable: config.refusable,
        override: data.override === true,
        preempt: data.preempt === true
      });
      if (gate.refusal) {
        fail(gate.refusal, {
          path: agentPath,
          // `error` is the whole refusal, for the log and for MCP callers.
          // `refusedBy`, `reason` and `derivation` are the same thing split
          // into the pieces a UI can lay out — a client that shows none of
          // this leaves the user at a dead switch.
          refusedBy: 'capacity',
          reason: capacityReason(gate.capacity),
          derivation: describeCapacity(gate.capacity),
          capacity: capacityDto(gate.capacity),
          priority: config.priority,
          started: false,
          // Named, so a client can offer a button that says whose work it
          // ends. Absent when there is nothing this activation outranks.
          ...(gate.preemptable ? { preemption: gate.preemptable } : {})
        });
        return;
      }

      // An explicit `resume` is set only by boot-time reconciliation, never by
      // an ordinary client: it changes what the agent is told when there is
      // nothing to continue, and an ordinary activation is not an interrupted
      // one. What a client *can* produce without saying so is the
      // re-activation of an agent it previously preempted, which IS an
      // interrupted one — resumeCauseFor is where that is recognised rather
      // than trusted to the caller.
      const explicit: ResumeCause | undefined =
        data.resume === 'reboot' || data.resume === 'daemon-restart' ? data.resume : undefined;
      const resume = this.resumeCauseFor(agentPath, explicit);

      // `config.prompt` verbatim. There is nothing between the caller's bytes
      // and the file the agent reads.
      session = herdrBridge.spawnSession(agentPath, config, config.prompt, resume);

      // Reconciliation nudges its own restores, in sequence and with the
      // stagger it needs; it passes an explicit cause, which is how the two
      // are told apart. A preemption resume has nobody else to do it.
      if (!explicit && !session.spawnError) this.nudgeIfResumed(session, config);
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists, and an error herdr handed us must never be
    // answered with success: true. It is not the whole of the question, which
    // is why confirmActivation follows: herdr can also report success and
    // leave no agent behind, and that case is answered by looking rather than
    // by trusting.
    if (session.spawnError) {
      fail(session.spawnError, { path: agentPath });
      return;
    }

    const confirmed = await this.confirmActivation(session);
    if ('error' in confirmed) {
      fail(confirmed.error, { path: agentPath, verified: false });
      return;
    }

    // After confirmation, deliberately: the registry records agents that
    // provably exist, and an fsync'd record of an agent that was never there
    // would have reconciliation resurrecting a ghost on every boot.
    //
    // The pane id comes from the census that PROVED the agent is there, which
    // is what makes it a binding rather than a guess.
    const durable = this.rememberActivated({ path: agentPath, config });

    this.deps.broadcast({
      action: 'agent_activated_event',
      success: true,
      path: agentPath,
      paneName,
      paneId: confirmed.paneId,
      sessionId: session.sessionId,
      status: session.status
    });

    respond({
      action: 'activate_response',
      success: true,
      path: agentPath,
      paneName,
      // The other half of the contract stated above: every successful
      // activation says which of the two things happened. `false` here means
      // this call is the one that started the agent.
      alreadyRunning: false,
      started: true,
      paneId: confirmed.paneId,
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      priority: config.priority,
      launcher: config.launcher,
      // Not decoration: it is the difference between this response and the
      // KAN-23 false success. `true` means the agent was found in herdr's
      // census before this was sent, and success is never reported without it.
      verified: true,
      // Present only when the registry write FAILED: the agent is running and
      // verified, but a daemon restart will not know to restore it. `verified`
      // answers "does it exist"; this answers "will it survive".
      ...(durable.ok ? {} : { durable: false, durabilityError: durable.error }),
      // Only present on a restore. `false` means the agent came up with the
      // degraded-resume prompt and is already working; `true` means it was
      // handed its old conversation and is sitting at an empty prompt, which
      // is the case that needs a nudge.
      ...(session.resume
        ? { resume: session.resume, resumedConversation: session.resumedConversation }
        : {}),
      // What this activation cost somebody else. Reported to the caller as
      // well as broadcast, so a client that started an agent by preemption
      // learns whose work it interrupted from the same response.
      ...(gate?.preempted ? { preempted: gate.preempted } : {}),
      ...(gate?.overrode
        ? { capacityOverride: { ...gate.overrode, capacity: capacityDto(gate.capacity) } }
        : {})
    });
  }

  // ------------------------------------------------------------- deactivate

  /**
   * The session-addressed stand-down. Kept for the one caller that holds a
   * session id and nothing else; every human-facing path uses the
   * path-addressed form below, which is a strict superset.
   *
   * It answers on the same `deactivate_response` shape, so it carries
   * `wasRunning` too. A caller cannot be expected to know which of two
   * addressing forms produced the message in front of it, and a contract that
   * holds for one of them is not a contract. `state` is only claimed when
   * there is a record for the agent to be in a state ON: a session with no
   * record behind it is stood down, but calling that "standby" would name a
   * durable resting place that does not exist.
   */
  private handleDeactivateSession(data: any, respond: Respond) {
    if (!data.sessionId) {
      respond({
        action: 'deactivate_response',
        success: false,
        error: 'Missing sessionId'
      });
      return;
    }

    // Read before the teardown: terminateSession marks the session terminated,
    // after which getSession still answers but the address is what we need and
    // it does not change.
    const session = this.deps.herdrBridge.getSession(data.sessionId);
    const { success, error } = this.deps.herdrBridge.terminateSession(data.sessionId);

    // Recorded only after a confirmed teardown, and only for an agent we hold
    // a record for. A stand-down that did not take, written down as if it had,
    // is a durable lie with three faces: the agent leaves `expected()` (a
    // reboot will not restore it), it can be reported stood-down while
    // running, and — on the preempt path — it reads as owed work that was
    // never actually interrupted.
    const intent = session ? this.deps.agentRegistry.intents().get(session.path) : undefined;
    const durable =
      success && intent ? this.rememberDeactivated(intent.record) : undefined;

    if (success && session) {
      this.deps.broadcast({
        action: 'agent_deactivated_event',
        success: true,
        path: session.path,
        paneName: session.paneName,
        sessionId: session.sessionId
      });
    }

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId,
      ...(session ? { path: session.path, paneName: session.paneName } : {}),
      // A session we held and tore down was, by definition, running. The
      // failure case claims neither: an unconfirmed teardown is exactly the
      // case where we do not know.
      ...(success ? { wasRunning: true, ...(intent ? { state: 'standby' } : {}) } : {}),
      ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
      ...(error ? { error } : {})
    });
  }

  /**
   * `deactivate(path)` — stop the agent, keep the record.
   *
   * NEVER A BARE SUCCESS. A caller polling for "is it down" and a caller who
   * mistyped a path deserve different answers, so every success carries
   * `wasRunning` and a `state`:
   *
   *   - `unstarted` — configured, never activated. Nothing to stop, and
   *     nothing is recorded: writing a stand-down here would move the agent
   *     into the standby list, which promises that switching it back on
   *     resumes the conversation it was stopped in. It has no conversation.
   *   - `standby`   — it ran and it is down now.
   *
   * A path with NO record refuses, where `forget` on the same path succeeds.
   * See {@link handleForget} for the rule that decides the asymmetry.
   *
   * SAFE TO CALL AGAIN — A CONTRACT, the mirror of {@link handleActivate}'s.
   * Standing down something already down is not an error and not a failure;
   * it is a supervisor finding the world already as it asked. The second call
   * answers `success: true, wasRunning: false`, writes no second stand-down
   * row (a repeated row would say a decision was taken twice) and broadcasts
   * no second event.
   *
   * `wasRunning` is on EVERY successful response, and `state` distinguishes
   * the two ways of not running rather than flattening them. That distinction
   * is the whole reason this is not a bare success: `unstarted` is an agent
   * with no conversation to come back to, `standby` is one with a conversation
   * waiting, and switching them back on means different things.
   */
  public handleDeactivateAgent(data: any, respond: Respond) {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'deactivate_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;

    // Set by the capacity gate's preempt path, never invented here: it is the
    // record of why this stand-down was not the agent's own idea.
    const preemption: PreemptionRecord | undefined = data.preemption;

    const intent = this.deps.agentRegistry.intents().get(agentPath);
    if (!intent) {
      fail(
        `No agent is configured at ${agentPath}, so there is nothing to stand down. ` +
          `Reporting a stand-down for a path that never held an agent would be success ` +
          `about a world that does not exist. (\`forget\` on this path succeeds — its ` +
          `postcondition is the absence of a record, and that already holds.)`,
        { path: agentPath, refused: 'not-configured' }
      );
      return;
    }

    const session = this.deps.herdrBridge.getSessionByPath(agentPath);

    // ONE census read for this whole handler. The `unstarted` answer below
    // depends on it: a record whose last event is `configured` is not evidence
    // that nothing is running — a durable write that failed after an
    // activation leaves exactly that state over a live pane, and answering
    // "nothing was running" without looking is the claim-without-looking this
    // daemon refuses everywhere else.
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const occupancy = this.deps.herdrBridge.occupancyOf(
      census, agentPath, intent.record.config.launcher
    );
    const oursIsLive = occupancy.reachable && occupancy.ours !== null;

    if (session) {
      const { success, error } = this.deps.herdrBridge.terminateSession(session.sessionId);

      // Recorded only after a confirmed teardown — the same rule as the
      // broadcast below, for a sharper reason: the preempt path ABORTS THE
      // WHOLE PREEMPTION when this teardown fails, and a durable record
      // written first would say the victim was preempted while it is alive and
      // working.
      const durable = success ? this.rememberDeactivated(intent.record, preemption) : undefined;

      // Not broadcast when the teardown could not be confirmed: the event is
      // what fleet clients act on, and announcing an agent deactivated while
      // it may still be running is the same false claim verified activation
      // exists to prevent, arriving as an event instead of as a response.
      if (success) {
        this.deps.broadcast({
          action: 'agent_deactivated_event',
          success: true,
          path: agentPath,
          paneName: session.paneName,
          sessionId: session.sessionId,
          ...(preemption ? { preempted: true } : {})
        });
      }

      respond({
        action: 'deactivate_response',
        success,
        path: agentPath,
        paneName: session.paneName,
        sessionId: session.sessionId,
        wasRunning: true,
        state: 'standby',
        ...(preemption ? { preempted: true } : {}),
        ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
        ...(error ? { error } : {})
      });
      return;
    }

    // Configured and never started — but only if the census agrees. When it
    // does not, the record is stale and the pane is what is real, so this
    // falls through to the close path below rather than reporting a state it
    // has not checked.
    if (intent.event === 'configured' && !oursIsLive) {
      respond({
        action: 'deactivate_response',
        success: true,
        path: agentPath,
        paneName: paneNameFor(agentPath),
        wasRunning: false,
        state: 'unstarted',
        ...(occupancy.reachable
          ? {}
          : {
              occupancyUnknown: true
            }),
        note:
          'This agent is configured but has never been activated. Nothing was running and ' +
          'nothing was recorded — a stand-down row would put it on the standby list, which ' +
          'promises that switching it back on resumes the conversation it was stopped in.' +
          (occupancy.reachable
            ? ' The census agrees: no pane of ours is live there.'
            : ' herdr did not answer, so this rests on the record alone — but the record has ' +
              'never carried an activation, so there is no activation for it to be stale about.')
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not.
    const result = this.deps.herdrBridge.closeAgentByPath(agentPath);

    // Standing down an agent that has already died is not a failure — it is
    // the request working. There was no pane to close, and the thing actually
    // being asked for ("stop expecting this agent back") is the registry write
    // below. Reporting `success: false` there tells a supervisor its
    // stand-down did not take, inviting it either to retry forever or to
    // conclude the agent is still owed a slot.
    //
    // Only when herdr *answered* though. An unreachable herdr also fails to
    // close the pane, and calling that "already gone" would report an agent
    // stood down while it is still running.
    // From the census this handler already took, rather than a second read:
    // two reads could disagree, and this one decides whether a stand-down is
    // recorded for an agent that might still be running.
    const goneAlready = !result.success && occupancy.reachable;

    // Already recorded as stood down AND provably not running: nothing
    // changed, so nothing is written. A second identical row would say a
    // decision was taken twice.
    const alreadyStandby = intent.event === 'deactivated' && goneAlready;

    const durable =
      (result.success || goneAlready) && !alreadyStandby
        ? this.rememberDeactivated(intent.record, preemption)
        : undefined;

    if ((result.success || goneAlready) && !alreadyStandby) {
      this.deps.broadcast({
        action: 'agent_deactivated_event',
        success: true,
        path: agentPath,
        paneName: result.paneName,
        ...(preemption ? { preempted: true } : {})
      });
    }

    respond({
      action: 'deactivate_response',
      path: agentPath,
      paneName: result.paneName,
      success: result.success || goneAlready,
      wasRunning: result.success,
      ...(result.success || goneAlready ? { state: 'standby' } : {}),
      ...(preemption ? { preempted: true } : {}),
      ...(goneAlready
        ? {
            alreadyGone: true,
            note: alreadyStandby
              ? 'No agent was running and its stand-down was already recorded. Nothing changed.'
              : 'No agent was running. Its stand-down is recorded, so it will not be restored.'
          }
        : {}),
      ...(durable && !durable.ok ? { durable: false, durabilityError: durable.error } : {}),
      ...(result.error && !goneAlready ? { error: result.error } : {})
    });
  }

  // ------------------------------------------------------------------ reads

  /**
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', success: false, error });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const { message } = data;
    if (typeof message !== 'string' || !message.trim()) {
      fail('Missing or invalid message');
      return;
    }

    this.deps.herdrBridge.sendToAgent(address.path, message).then(
      (result) => respond({ action: 'send_to_agent_response', path: address.path, ...result }),
      (err) => fail(err?.message ?? String(err))
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private handleTailAgent(data: any, respond: Respond) {
    const fail = (error: string) =>
      respond({ action: 'tail_agent_response', success: false, error });

    const address = this.addressOfRequest(data.path, true);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const { lines } = data;
    if (lines !== undefined && (typeof lines !== 'number' || !Number.isFinite(lines))) {
      fail('Invalid lines: expected a number');
      return;
    }

    try {
      respond({
        action: 'tail_agent_response',
        path: address.path,
        ...this.deps.herdrBridge.tailAgent(address.path, lines)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  /**
   * Everything known about one agent, by path. A daemon restart empties the
   * session map while the herdr pane keeps running, so a missing session
   * degrades to herdr's own view (`sessionless: true`) rather than failing —
   * an agent that outlived its daemon is exactly the one a supervisor most
   * needs to inspect.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      respond({ action: 'agent_status_response', success: false, error, ...extra });

    const address = this.addressOfRequest(data.path, false);
    if ('error' in address) {
      fail(address.error);
      return;
    }
    const agentPath = address.path;
    const intent = this.deps.agentRegistry.intents().get(agentPath);

    try {
      const session = this.deps.herdrBridge.getSessionByPath(agentPath);
      if (session) {
        const statuses = this.deps.herdrBridge.listHerdrStatuses();
        respond({
          action: 'agent_status_response',
          success: true,
          sessionless: false,
          path: agentPath,
          paneName: session.paneName,
          paneId: this.deps.herdrBridge.paneIdFor(session.paneName),
          sessionId: session.sessionId,
          createdAt: session.createdAt.toISOString(),
          status: session.status,
          herdrStatus: statuses.get(session.paneName) ?? 'unknown',
          label: intent?.record.config.label ?? null,
          configured: Boolean(intent)
        });
        return;
      }

      const described = this.deps.herdrBridge.describeAgent(agentPath);
      respond({
        action: 'agent_status_response',
        success: true,
        sessionless: true,
        path: agentPath,
        paneName: described.paneName,
        paneId: described.paneId,
        sessionId: null,
        createdAt: null,
        status: null,
        workDir: described.workDir,
        herdrStatus: described.herdrStatus,
        label: intent?.record.config.label ?? null,
        configured: Boolean(intent)
      });
    } catch (err: any) {
      // The record is reported even when herdr has nothing, because "this
      // agent is configured and not running" and "there is no such agent" are
      // different answers and only one of them means the caller mistyped.
      fail(err?.message ?? String(err), {
        path: agentPath,
        configured: Boolean(intent),
        ...(intent ? { state: intent.event === 'configured' ? 'unstarted' : intent.event } : {})
      });
    }
  }

  /**
   * Everything running, from herdr's view joined against the durable registry.
   *
   * The session map is emptied by a daemon restart while the herdr panes keep
   * running, so a list built from sessions alone answers "nothing is running"
   * for a machine full of working agents — and that is the reading a
   * supervisor acts on. herdr is therefore the source of existence here;
   * sessions only add what herdr cannot know (session id, creation time).
   *
   * WHAT COUNTS AS OURS is the part that changed. It used to be a pane name
   * starting with `crabcast-` that parsed back into a type and key — a
   * convention masquerading as a filter. It is now: a pane whose canonical
   * `cwd` is a path this registry holds a record for, AND whose name is the
   * one that path derives. Both halves are needed. The cwd join is what makes
   * the registry authoritative; the name check is what keeps a stranger's pane
   * sitting in one of our directories from being reported as our agent — it is
   * reported as a foreign pane occupying that path, which is exactly what a
   * reader needs to see.
   */
  private handleListAgents(_data: any, respond: Respond) {
    // One read of the registry for the whole response. Several of the fields
    // below are derived from it, and asking it repeatedly was both several
    // whole-file parses per poll and several chances for an append landing
    // mid-response to make the categories contradict each other.
    const intents = this.deps.agentRegistry.intents();

    const { agents, unbackedPanes, foreignPanes, staleSessions } = this.surveyAgents(intents);

    // Agents that should be here and are not. Computed from the same census the
    // list is built from, so the two can never disagree about what is running.
    const missing = clipFleetCategory(
      this.missingAgents(agents, staleSessions, intents),
      (row) => row.since
    );

    // Work taken off the machine to make room, still owed a decision.
    const preempted = clipFleetCategory(
      this.preemptedAgents(agents, intents),
      (row) => row.at
    );

    // Agents a person switched off. From the same census for the same reason:
    // an agent that is running must never be offered an On button.
    const { standby, total: standbyTotal } = this.standbyAgents(agents, intents);

    const foreign = clipFleetCategory(foreignPanes, (row) => row.paneName);

    // Descriptor headroom, reported where someone looking at agents will see
    // it. Expressed in panes because that is the unit the reader can act on.
    const usage = readFdUsage();

    // CPU and memory headroom, for the same reason and in the same place.
    const capacity = this.capacityOf(agents);

    respond({
      action: 'list_agents_response',
      success: true,
      agents,
      unbackedPanes,
      // Live panes that are not ours. The rows whose `occupies` is non-null
      // are the ones that will refuse an activation, so a reader can see the
      // refusal coming rather than meeting it.
      foreignPanes: foreign.rows,
      foreignPanesTotal: foreign.total,
      // Always present, even when empty: a caller that has to distinguish "no
      // agents are missing" from "this daemon does not track that" cannot do it
      // from an absent field. Empty array means the fleet is whole.
      missingAgents: missing.rows,
      missingTotal: missing.total,
      // Work that was taken off the machine to make room for something more
      // important, and has not been put back. It is a queue of decisions still
      // owed rather than a log of events: the moment one of these is
      // re-activated it leaves the list. Nothing here restarts them,
      // deliberately — a preemption queue that restarts its own entries is a
      // scheduler, and preemption must never be automatic.
      preemptedAgents: preempted.rows,
      preemptedTotal: preempted.total,
      // Where a fleet client's On button gets its candidates.
      standbyAgents: standby,
      standbyTotal,
      capacity: capacityDto(capacity),
      // What each running agent is worth, and therefore what a would-be
      // activation would have to outrank. "There is no room" and "there is no
      // room *for you*" are different answers, and a supervisor deciding
      // whether to staff something needs both.
      priorities: this.preemptionCandidates(agents, undefined, intents).map((c) => ({
        path: c.path,
        paneName: c.paneName,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      ...(usage ? {
        herdrHealth: {
          pid: usage.pid,
          openFds: usage.openFds,
          softLimit: usage.softLimit,
          headroomPanes: usage.headroomPanes,
          fdPressure: Math.round(usage.ratio * 100) / 100,
          ...(isFdPressureHigh(usage) ? {
            warning:
              `herdr server is using ${Math.round(usage.ratio * 100)}% of its open-file soft limit ` +
              `(${usage.openFds}/${usage.softLimit}); room for about ${usage.headroomPanes} more panes ` +
              `at ${PTMX_FDS_PER_PANE} descriptors each. Close idle agents.`
          } : {})
        }
      } : {})
    });
  }

  /** `capacity`: how many more agents this machine can carry, and why. */
  private handleCapacity(_data: any, respond: Respond) {
    const { agents } = this.surveyAgents();
    const capacity = this.capacityOf(agents);
    const candidates = this.preemptionCandidates(agents);
    respond({
      action: 'capacity_response',
      success: true,
      ...capacityDto(capacity),
      derivation: describeCapacity(capacity),
      // At capacity the next question is always "then what would I have to
      // stand down?", and answering it here saves a caller from working the
      // ordering out for itself — or, worse, guessing at it.
      priorities: candidates.map((c) => ({
        path: c.path,
        paneName: c.paneName,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      fleetPriorities: describeFleetPriorities(candidates)
    });
  }

  /**
   * The capacity model applied to a census: chargeable agents in `running`,
   * unchargeable ones counted separately as `exemptAgents` (reported, never
   * charged — see capacity.ts).
   *
   * This is the third of the three decisions the old `gateExempt` boolean was
   * carrying. Every capacity answer in this daemon goes through here, so
   * `running` means the same thing in the refusal, in `list_agents` and in the
   * `capacity` action.
   */
  private capacityOf(agents: ListedAgent[]): Capacity {
    let fleet = 0;
    let exempt = 0;

    for (const entry of agents) {
      if (entry.chargeable) fleet++;
      else exempt++;
    }

    return readCapacity(fleet, exempt);
  }

  /**
   * Agents stood down to make room, in the shape a client renders.
   *
   * Cross-checked against the same census as the other categories: an agent
   * the registry believes preempted that herdr can show running is not owed
   * anything — the record and reality disagree, and reality is the one a
   * supervisor acts on.
   */
  private preemptedAgents(agents: ListedAgent[], sharedIntents?: Map<string, AgentIntent>) {
    const alive = new Set(agents.map((a) => a.path));
    const preempted = sharedIntents
      ? AgentRegistry.preemptedFrom(sharedIntents)
      : this.deps.agentRegistry.preempted();
    return preempted
      .filter((entry) => !alive.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        paneName: paneNameFor(entry.path),
        label: entry.record.config.label ?? null,
        at: entry.at,
        priority: entry.preemption.priority,
        herdrStatusWhenPreempted: entry.preemption.herdrStatus,
        by: {
          path: entry.preemption.byPath,
          paneName: entry.preemption.byPaneName,
          priority: entry.preemption.byPriority
        },
        reason:
          `Stood down at ${entry.at} to free capacity for ` +
          `${entry.preemption.byPath} ` +
          `(priority ${entry.preemption.byPriority} against this agent's ` +
          `${entry.preemption.priority}). Its work was interrupted, not finished. ` +
          `Re-activating it resumes the conversation it was stopped in; until then ` +
          `its work should not be read as in progress.`,
        derivation: entry.preemption.derivation
      }));
  }

  /**
   * The gap between what the registry says should be running and what herdr
   * actually has.
   *
   * The comparison is against the *census*, not against the session map: an
   * agent that survived a daemon restart has no session of ours and is
   * nonetheless perfectly alive, and calling it missing would be a false
   * alarm about something working exactly as designed.
   */
  private missingAgents(
    agents: ListedAgent[],
    staleSessions?: Set<string>,
    sharedIntents?: Map<string, AgentIntent>
  ): MissingAgent[] {
    const alive = new Set(agents.map((a) => a.path));
    const missing: MissingAgent[] = [];

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      if (intent.event !== 'activated') continue;
      if (alive.has(agentPath)) continue;

      missing.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        since: intent.at,
        // Both cases are "not running", but they are not the same event and a
        // reader acting on this deserves the difference: an agent that never
        // came back, versus one that was running under this daemon and died
        // while we held its session. The second is a crash we witnessed.
        reason: staleSessions?.has(agentPath)
          ? 'The registry records this agent as active and this daemon held a session ' +
            'for it, but herdr has no live agent in its directory: it started and then died. ' +
            'It is not running.'
          : 'The registry records this agent as active, but herdr has no live agent in its ' +
            'directory and this daemon holds no session for it. It is not running.'
      });
    }

    return missing;
  }

  /**
   * Agents a person switched off, that could be switched back on.
   *
   * Three filters, each removing a different kind of thing nobody means by
   * "turn it back on":
   *
   *   - still running — the stand-down failed, or it was started again since.
   *     Offering On for something already on is how a control starts lying.
   *   - preempted — reported separately, with the name of what took its slot.
   *     One agent, one switch. (Once compaction has dropped that annotation
   *     the agent does land here — there is no longer a debt to report it as —
   *     but it arrives carrying `wasPreempted` and a reason that says what
   *     actually happened to it. It is still in exactly one list.)
   *   - directory gone — the caller deleted it, and that is the difference
   *     between "stopped" and "finished with".
   *
   * Newest first, because the thing you just switched off is the thing you are
   * most likely to want back.
   */
  private standbyAgents(
    agents: ListedAgent[],
    sharedIntents?: Map<string, AgentIntent>
  ): { standby: StandbyAgent[]; total: number } {
    const alive = new Set(agents.map((a) => a.path));
    const standby: StandbyAgent[] = [];

    for (const [agentPath, intent] of sharedIntents ?? this.deps.agentRegistry.intents()) {
      if (intent.event !== 'deactivated') continue;
      if (intent.preemption) continue;
      if (alive.has(agentPath)) continue;
      if (!fs.existsSync(agentPath)) continue;

      standby.push({
        path: agentPath,
        paneName: paneNameFor(agentPath),
        label: intent.record.config.label ?? null,
        launcher: intent.record.config.launcher,
        since: intent.at,
        // Set on a row that reached this list through compaction dropping a
        // preemption annotation, so a client can tell the two apart and the
        // sentence below can stop short of claiming a decision nobody made.
        ...(intent.wasPreempted ? { wasPreempted: true } : {}),
        reason: intent.wasPreempted
          ? 'Stopped to free capacity for higher-priority work, long enough ago that the ' +
            'record of what took its slot has been compacted away. Its directory is still ' +
            'there, so switching it back on resumes the conversation it was stopped in ' +
            'rather than starting a new one.'
          : 'Switched off deliberately. Its directory is still there, so switching it back ' +
            'on resumes the conversation it was stopped in rather than starting a new one.'
      });
    }

    const clipped = clipFleetCategory(standby, (row) => row.since);
    return { standby: clipped.rows, total: clipped.total };
  }

  /**
   * `missingAgents`, for callers outside a request — the daemon's periodic
   * sweep. Public because the sweep runs on a timer rather than in response to
   * a client, and must ask the same question the list answers.
   */
  public findMissingAgents(): MissingAgent[] {
    const intents = this.deps.agentRegistry.intents();
    const { agents, staleSessions } = this.surveyAgents(intents);
    return this.missingAgents(agents, staleSessions, intents);
  }

  private rowFrom(
    agentPath: string,
    paneName: string,
    census: HerdrAgentRecord | undefined,
    session: HerdrSession | undefined,
    intent: AgentIntent | undefined
  ): ListedAgent {
    const config = intent?.record.config;
    return {
      sessionless: !session,
      path: agentPath,
      paneName,
      paneId: census?.paneId ?? null,
      // Session-only fields are null, not invented: there is no session id to
      // report and no creation time we saw. Filling them in to match the
      // attached shape would be a fabrication.
      sessionId: session?.sessionId ?? null,
      createdAt: session ? session.createdAt.toISOString() : null,
      status: session?.status ?? null,
      herdrStatus: census?.herdrStatus ?? 'unknown',
      agentRuntime: census?.agentRuntime ?? null,
      label: config?.label ?? null,
      // An agent with no record cannot be priced, refused or preempted — so it
      // is treated as fully subject to the machine (charged, refusable) and
      // never offered as a victim. That combination is the safe reading of
      // every unknown: it costs a slot, which is true, and nothing may kill it
      // on the strength of a priority nobody wrote down.
      refusable: config?.refusable ?? true,
      chargeable: config?.chargeable ?? true,
      preemptable: config ? config.preemptable : false
    };
  }

  /**
   * The agent census behind `list_agents`, shared with anything that needs to
   * know what is running. Split out so every consumer counts exactly what the
   * list reports; two answers to "what is running" is one answer too many.
   */
  private surveyAgents(sharedIntents?: Map<string, AgentIntent>): {
    agents: ListedAgent[];
    unbackedPanes: UnbackedPane[];
    foreignPanes: ForeignPane[];
    staleSessions: Set<string>;
    census: HerdrCensus;
  } {
    const census = this.deps.herdrBridge.listHerdrAgentsChecked();
    const intents = sharedIntents ?? this.deps.agentRegistry.intents();
    const byPaneName = new Map<string, HerdrAgentRecord>(census.agents.map((a) => [a.name, a]));

    const agents: ListedAgent[] = [];
    const covered = new Set<string>();

    /**
     * Sessions this daemon still holds for agents herdr no longer has.
     *
     * A session is our record that we *started* something; it is not evidence
     * that the thing is still alive, and it outlives the agent whenever the
     * pane dies without us tearing it down — which is precisely what a crashed
     * or killed agent looks like. Listing one as running is how a dead agent
     * reads as work in progress with nothing behind it.
     */
    const staleSessions = new Set<string>();

    for (const session of this.deps.herdrBridge.listActiveSessions()) {
      // herdr is the authority on whether an agent exists — but only when it
      // answered. An unreachable herdr returns an empty census, and treating
      // that silence as "they are all dead" would condemn a perfectly healthy
      // fleet, so in that case we keep trusting the session map.
      //
      // Two different deaths, and only one of them is unconditional. A pane
      // herdr has never heard of is gone, full stop. A pane it *has* with no
      // runtime behind it is one whose agent exited — dead too, except for a
      // `shell` agent, where a bare prompt and no runtime is the entire point.
      if (census.reachable) {
        const record = byPaneName.get(session.paneName);
        const dead = !record || (!record.agentRuntime && (session.expectsRuntime ?? true));
        // An empty pane is only evidence of death once the launcher has had
        // its runtime-confirm window: a freshly spawned agent legitimately
        // shows no runtime for up to RUNTIME_CONFIRM_TIMEOUT_MS, and any
        // concurrent list_agents/capacity call landing inside it would
        // otherwise abandon the session the in-flight activate is still
        // confirming, which then answers `success: true` over a killed PTY.
        const settled =
          Date.now() - session.createdAt.getTime() >= RUNTIME_CONFIRM_TIMEOUT_MS;
        if (dead && settled) {
          staleSessions.add(session.path);
          // Release the corpse, not just skip it. A session left `active` for
          // a dead pane is the one the next activate for this path would
          // reuse — it would then fail confirmation only after a full
          // confirm-timeout poll, tearing the session down at the moment the
          // caller is waiting on it.
          this.deps.herdrBridge.abandonSession(
            session.sessionId,
            `herdr has no live agent behind ${session.paneName}; the session was released by the census`
          );
          continue;
        }
      }

      covered.add(session.path);
      agents.push(
        this.rowFrom(
          session.path,
          session.paneName,
          byPaneName.get(session.paneName),
          session,
          intents.get(session.path)
        )
      );
    }

    const unbackedPanes: UnbackedPane[] = [];
    const foreignPanes: ForeignPane[] = [];

    // OUR agents, asked the one way this daemon asks it: for each registered
    // path, is there a live pane bearing the name that path derives? Driven
    // from the REGISTRY rather than from the census, because that is the
    // direction the question runs — the census cannot say which directories we
    // hold records for.
    //
    // This used to be a second, differently-shaped ownership test living here
    // while `occupancyOf` used a third. Two tests that can disagree about the
    // same pane is one test too many, and the one that guarded the gate was
    // the one that could go wrong.
    for (const [agentPath, intent] of intents) {
      if (covered.has(agentPath)) continue;
      const pane = ourPaneIn(census, agentPath, intent.record.config.launcher);
      if (!pane) continue;
      covered.add(agentPath);
      agents.push(this.rowFrom(agentPath, pane.name, pane, undefined, intent));
    }

    for (const record of census.agents) {
      const cwd = record.canonicalWorkDir;
      // Ours by the same single test, asked of this pane's own directory.
      const ours =
        cwd !== null &&
        intents.has(cwd) &&
        ourPaneIn(census, cwd, intents.get(cwd)!.record.config.launcher)?.name === record.name;

      if (!ours) {
        // Only live ones. A bare shell somebody left open elsewhere on the
        // machine is not news; a running agent in a directory we hold a record
        // for is exactly the thing that will refuse our next activation.
        if (record.agentRuntime) {
          foreignPanes.push({
            paneName: record.name,
            paneId: record.paneId,
            workDir: record.workDir,
            occupies: cwd !== null && intents.has(cwd) ? cwd : null,
            herdrStatus: record.herdrStatus,
            agentRuntime: record.agentRuntime
          });
        }
        continue;
      }

      // Already listed by the registry-driven pass above.
      if (covered.has(cwd!)) continue;
    }

    // Our panes with nothing behind them: a registered path whose derived pane
    // name is in the census without a runtime. `ourPaneIn` requires a runtime,
    // so these are exactly the ones it declines to call ours.
    for (const [agentPath] of intents) {
      if (covered.has(agentPath)) continue;
      const paneName = paneNameFor(agentPath);
      const record = census.agents.find((a) => a.name === paneName);
      // Only a runtime-bearing launcher can have an UNBACKED pane; for `shell`
      // an empty pane is the product, and `ourPaneIn` has already claimed it
      // above.
      if (!record || record.agentRuntime) continue;
      unbackedPanes.push({
        paneName: record.name,
        paneId: record.paneId,
        path: agentPath,
        herdrStatus: record.herdrStatus,
        reason:
          'herdr reports no agent running in this pane and this daemon holds no session for it'
      });
    }

    return { agents, unbackedPanes, foreignPanes, staleSessions, census };
  }

  // -------------------------------------------------------------------- pty

  /**
   * The session id a PTY request names, when it named one at all.
   *
   * `null` covers both a missing id and a non-string one, so the refusal below
   * can tell "you sent no session" from "you sent a session I do not have"
   * without any caller having to trust the shape of the wire.
   */
  private ptySessionId(data: any): string | null {
    return typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  }

  /**
   * The refusal a PTY request gets when it names a session this daemon does not
   * hold.
   *
   * It says which id, what that means, and what to do instead — because the
   * caller is a program, and a program that is only told "no" will retry the
   * same id forever. The alternative this replaces was worse than a bad error
   * message: the extraction source's daemon used to substitute an arbitrary
   * session, or spawn a default shell, and answer as though the request had
   * been honoured (KAN-25).
   */
  private unknownPtySession(action: string, sessionId: string | null): string {
    const named =
      sessionId === null
        ? `${action} arrived without a sessionId`
        : `${action} names session '${sessionId}', which this daemon does not have`;
    return (
      `${named}. A PTY session id is only valid for the daemon process that issued it, ` +
      'and this one is not among them — most likely it was issued by a previous daemon ' +
      'and the client has not re-resolved since. Ask for the agent again (activate by ' +
      'path) and use the session id that comes back; retrying this one cannot succeed.'
    );
  }

  private handlePtyInit(data: any, respond: Respond) {
    const sessionId = this.ptySessionId(data);
    const session = sessionId === null ? undefined : this.deps.herdrBridge.getSession(sessionId);
    if (sessionId === null || session === undefined) {
      respond({
        action: 'pty_init_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_init', sessionId)
      });
      return;
    }

    respond({
      action: 'pty_init_response',
      success: true,
      sessionId,
      buffer: session.ptyBuffer
    });

    const oldCleanup = this.activePtyListeners.get(sessionId);
    if (oldCleanup) oldCleanup();

    // Streamed output is unsolicited: it must not carry the pty_init id, or
    // a correlating transport would try to answer a request already closed.
    const cleanup = this.deps.herdrBridge.registerDataListener(sessionId, (ptyData) => {
      this.deps.send({
        action: 'pty_output',
        success: true,
        sessionId,
        data: ptyData
      });
    });

    // Only absent if the session went away between the lookup above and here,
    // which cannot happen synchronously — but nothing is registered on a guess.
    if (cleanup) this.activePtyListeners.set(sessionId, cleanup);
  }

  private handlePtyInput(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    // The most dangerous of the three to answer approximately: keystrokes sent
    // to a session picked on the client's behalf land in some other agent's
    // terminal, and get executed there.
    if (!this.deps.herdrBridge.writePty(sessionId ?? undefined, data.data)) {
      ack({
        action: 'pty_input_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_input', sessionId)
      });
      return;
    }
    ack({ action: 'pty_input_response', success: true, sessionId });
  }

  private handlePtyResize(data: any, ack: Respond) {
    const sessionId = this.ptySessionId(data);
    if (!this.deps.herdrBridge.resizePty(sessionId ?? undefined, data.cols, data.rows)) {
      ack({
        action: 'pty_resize_response',
        success: false,
        sessionId,
        error: this.unknownPtySession('pty_resize', sessionId)
      });
      return;
    }
    ack({ action: 'pty_resize_response', success: true, sessionId });
  }

  /** Called when this router's client disconnects, so its PTY listeners die with it. */
  public cleanup() {
    this.activePtyListeners.forEach(unsub => unsub());
    this.activePtyListeners.clear();
  }
}
