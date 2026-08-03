import { CrabcastConfig } from './config.js';
import { WorkspaceRegistry } from './registry.js';
import { PromptLoader } from './prompt.js';
import { DaemonResponse, WorkspaceTypeConfig } from './types.js';
import {
  HerdrBridge,
  HerdrSession,
  HerdrAgentRecord,
  HerdrAgentStatus,
  addressFromAgentName,
  agentNameFor,
  typeFromAgentName
} from './herdr.js';
import { readFdUsage, isFdPressureHigh, PTMX_FDS_PER_PANE } from './herdr-health.js';
import { ResumeCause } from './resume.js';

type Respond = (msg: any) => void;

/**
 * What a client is told about a session. Sessions are never sent over the wire
 * directly: they carry a ~100KB ptyBuffer and a live ptyProcess handle, and
 * fleet clients poll list_agents continuously.
 */
interface AgentDto {
  sessionId: string;
  type: string;
  key: string;
  /** Absent when the session was activated by key without a known page URL. */
  url?: string;
  createdAt: string;
  status: HerdrSession['status'];
  workDir: string;
  herdrStatus: HerdrAgentStatus;
}

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
 * Nulls are explicit rather than omitted, for the reason HerdrAgentDescription
 * gives: over JSON an absent field reads as "not answered", and these are
 * answered — with nothing.
 */
interface ListedAgent {
  sessionless: boolean;
  agentName: string;
  sessionId: string | null;
  type: string | null;
  key: string;
  url: string | null;
  createdAt: string | null;
  status: HerdrSession['status'] | null;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
  /** herdr's own `agent` field: the CLI running in the pane, null for a shell. */
  agentRuntime: string | null;
  /**
   * The type's `gateExempt` flag from config — the generalized form of the
   * extraction source's hardcoded supervisor set. Sent so a client does not
   * have to know which workspace types are never refused by the capacity
   * gate; a client deciding that from its own list of types would be a second
   * copy of a rule that already lives in the config, and the copy is the one
   * that gets forgotten when the config changes.
   */
  gateExempt: boolean;
}

/**
 * A `crabcast-*` pane that is not an agent by any test we can apply: herdr
 * reports no agent running in it and this daemon holds no session for it.
 * Reported separately rather than dropped — see handleListAgents.
 */
interface UnbackedPane {
  agentName: string;
  type: string;
  key: string;
  workDir: string | null;
  herdrStatus: HerdrAgentStatus;
  reason: string;
}

/**
 * The addressing convention shared by every agent-targeted action: a key is
 * required, a type is optional but must be meaningful when present. Returns
 * the complaint, or null when the address is usable.
 */
function invalidAddress(key: unknown, type: unknown): string | null {
  if (typeof key !== 'string' || !key.trim()) return 'Missing or invalid key';
  if (type !== undefined && (typeof type !== 'string' || !type.trim())) {
    return 'Invalid type: expected a non-empty string';
  }
  return null;
}

/** What {@link MessageRouter.admitActivation} decided, and why. */
interface GateResult {
  /** The refusal to send back, or null when the activation may proceed. */
  refusal: string | null;
}

/** Everything the activation gate needs to know about what it is judging. */
interface GateRequest {
  /** `shell/demo-1`, for refusal prose. */
  what: string;
  type: string;
  key: string;
  agentName: string;
}

export interface RouterDeps {
  registry: WorkspaceRegistry;
  config: CrabcastConfig;
  promptLoader: PromptLoader;
  herdrBridge: HerdrBridge;
  daemonStartedAt: Date;
  /** Replies to the requesting client. */
  send: (msg: DaemonResponse) => void;
  /** Events for every connected client (activations, teardowns, PTY deaths). */
  broadcast: (msg: DaemonResponse) => void;
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
        const { registry, config, daemonStartedAt } = this.deps;
        respond({
          success: true,
          pid: process.pid,
          startedAt: daemonStartedAt.toISOString(),
          configPath: config.configPath,
          dataDir: config.dataDir,
          workspaceTypes: registry.all()
        });
        return;
      }
      case 'activate_by_key':
        void guard(this.handleActivateByKey(data, respond), 'activate');
        return;
      case 'deactivate':
        this.handleDeactivate(data, respond);
        return;
      case 'deactivate_by_key':
        this.handleDeactivateByKey(data, respond);
        return;
      case 'reset_by_key':
        this.handleResetByKey(data, respond);
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
        respond({
          success: false,
          error: `Unknown action: ${typeof data?.action === 'string' ? data.action : JSON.stringify(data?.action)}`
        });
    }
  }

  /**
   * Whether this activation may start a new agent.
   *
   * Today the answer is always yes: this daemon does not yet measure the
   * machine. The seam exists so the capacity slice (T3 of KAN-68) replaces
   * exactly one thing — this function — with the measured gate: hardware-
   * derived cap, per-type `gateExempt` honoured, refusals carrying a
   * human-checkable derivation. Callers already branch on `refusal`, so the
   * gate's arrival changes no handler shape.
   *
   * Only consulted when a *new* agent would be created: re-attaching to an
   * agent that is already running costs the machine nothing, and refusing
   * that would be refusing to look at work already in flight.
   */
  private admitActivation(_request: GateRequest): GateResult {
    return { refusal: null };
  }

  /**
   * The step that makes an activate response a statement about the world
   * rather than about our own intentions.
   *
   * Returns the complaint when success cannot honestly be claimed, and
   * `undefined` when the agent has been confirmed to exist. It runs after
   * herdr's own errors have been dealt with, before anything is broadcast or
   * answered — so there is exactly one point at which activate decides it
   * succeeded.
   *
   * A confirmed-absent agent takes its session down with it. That is not a
   * retry and not a cleanup: it is the difference between a failure a caller
   * can act on and one it is locked out of, because a session left active is
   * the one the next activate would reuse. An unverifiable answer changes
   * nothing — see abandonSession.
   */
  private async confirmActivation(
    session: HerdrSession,
    agentName: string
  ): Promise<string | undefined> {
    // Existence means a live runtime for every launcher but `shell` — a name
    // registration over a dead pane must not verify (KAN-58). Sessions that
    // reached this point were built by initPty, which sets the field; an
    // unset one gets the strict reading rather than the lenient one.
    const presence = await this.deps.herdrBridge.confirmAgentPresent(
      agentName,
      session.expectsRuntime ?? true
    );
    if (presence.present) return undefined;

    console.error(
      `[Router] Refusing to report ${agentName} activated: ${presence.error}`
    );
    if (presence.reason === 'absent') {
      this.deps.herdrBridge.abandonSession(session.sessionId, presence.error);
    }
    return presence.error;
  }

  public async handleActivateByKey(data: any, respond: Respond) {
    const { herdrBridge, registry, promptLoader } = this.deps;
    const key: unknown = data.key;
    const type: unknown = data.type;

    if (typeof key !== 'string' || !key.trim()) {
      respond({ action: 'activate_response', success: false, error: 'Missing or invalid key' });
      return;
    }
    if (typeof type !== 'string' || !type.trim()) {
      respond({ action: 'activate_response', success: false, error: 'Missing or invalid type' });
      return;
    }

    // The config file is the whole definition of what this daemon can run
    // (KAN-69), so a type it does not declare is refused by name — with the
    // declared types listed, because a caller that is only told "no" will
    // retry the same spelling forever.
    const config: WorkspaceTypeConfig | undefined = registry.get(type);
    if (!config) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        error:
          `Unknown workspace type '${type}'. Declared types: ` +
          `${registry.all().map((t) => t.name).join(', ') || '(none)'}. ` +
          `Add the type to ${this.deps.config.configPath} and restart the daemon.`
      });
      return;
    }

    // A key alone does not determine a URL, and this daemon never resolves
    // pages: `url` is opaque caller-supplied metadata, carried for prompt
    // interpolation and reporting. Never invent one — a fabricated link is
    // worse than no link.
    const url =
      typeof data.url === 'string' && data.url.trim() ? data.url.trim() : undefined;

    const defaultAgent =
      typeof data.defaultAgent === 'string' && data.defaultAgent.trim()
        ? data.defaultAgent.trim()
        : undefined;

    const agentName = agentNameFor(type, key);
    // By full address, not by key alone: a session for a different type is a
    // different agent. A key-only lookup here would reuse `{A, k}`'s session
    // for an activation of `{B, k}`, then confirm existence against the name
    // `crabcast-B-k` — which is absent — and abandonSession would tear down
    // A's live PTY. A mistyped type must never destroy an unrelated agent.
    let session = herdrBridge.getSessionByAddress(key, type);

    if (!session) {
      // Before the prompt is even rendered: the cheapest refusal is the one
      // that happens before any work is done for an agent that will not exist.
      const gate = this.admitActivation({ what: `${type}/${key}`, type, key, agentName });
      if (gate.refusal) {
        respond({
          action: 'activate_response',
          success: false,
          type,
          key,
          url,
          error: gate.refusal,
          refusedBy: 'capacity'
        });
        return;
      }

      const renderedPrompt = promptLoader.loadAndRender(config.promptFile, {
        KEY: key,
        URL: url ?? ''
      });

      // An explicit `resume` is set only by boot-time reconciliation, never by
      // an ordinary client: it changes what the agent is told when there is
      // nothing to continue, and an ordinary activation is not an interrupted
      // one. The field is accepted and threaded here so the registry slice
      // (T4 of KAN-68) — whose reconcile is what sends it, and whose records
      // are what recognise an unlabelled preemption resume — does not have to
      // re-plumb the payload.
      const explicit: ResumeCause | undefined =
        data.resume === 'reboot' || data.resume === 'daemon-restart' ? data.resume : undefined;

      session = herdrBridge.spawnSession(
        type,
        key,
        url,
        renderedPrompt,
        defaultAgent,
        config.mcpServers,
        explicit,
        config.defaultLauncher
      );
    }

    // A spawn herdr refused is the one case where activate can say for certain
    // that no agent exists, and an error herdr handed us must never be
    // answered with success: true. It is not the whole of the question, which
    // is why confirmActivation follows: herdr can also report success and
    // leave no agent behind, and that case is answered by looking rather than
    // by trusting.
    if (session.spawnError) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        url,
        error: session.spawnError
      });
      return;
    }

    const unconfirmed = await this.confirmActivation(session, agentName);
    if (unconfirmed) {
      respond({
        action: 'activate_response',
        success: false,
        type,
        key,
        url,
        error: unconfirmed,
        verified: false
      });
      return;
    }

    this.deps.broadcast({
      action: 'agent_activated_event',
      success: true,
      type,
      key,
      sessionId: session.sessionId,
      status: session.status
    });

    respond({
      action: 'activate_response',
      success: true,
      type,
      key,
      url: session.url,
      sessionId: session.sessionId,
      status: session.status,
      workDir: session.workDir,
      createdAt: session.createdAt.toISOString(),
      mcpServers: config.mcpServers,
      priority: config.priority,
      // Not decoration: it is the difference between this response and the
      // KAN-23 false success. `true` means the agent was found in herdr's
      // census before this was sent, and success is never reported without it.
      verified: true,
      // Only present on a restore. `false` means the agent came up with the
      // degraded-resume prompt and is already working; `true` means it was
      // handed its old conversation and is sitting at an empty prompt, which
      // is the case that needs a nudge — delivered by the registry slice's
      // reconcile (T4), which reads exactly these fields.
      ...(session.resume
        ? { resume: session.resume, resumedConversation: session.resumedConversation }
        : {})
    });
  }

  private handleDeactivate(data: any, respond: Respond) {
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

    if (success && session) {
      this.deps.broadcast({
        action: 'agent_deactivated_event',
        success: true,
        type: session.type,
        key: session.key,
        sessionId: session.sessionId
      });
    }

    respond({
      action: 'deactivate_response',
      success,
      sessionId: data.sessionId,
      ...(session ? { type: session.type, key: session.key } : {}),
      ...(error ? { error } : {})
    });
  }

  public handleDeactivateByKey(data: any, respond: Respond) {
    const { key } = data;
    // Set by a supervising caller (the capacity slice's preemption path in
    // T3), never invented here: it is the record of why this stand-down was
    // not the agent's own idea, and it is echoed so the caller can attribute
    // the outcome. Carried opaquely until the registry slice (T4) persists it.
    const preemption = data.preemption;
    const session = this.deps.herdrBridge.getSessionByKey(key);

    if (session) {
      const { success, error } = this.deps.herdrBridge.terminateSession(session.sessionId);

      // Not broadcast when the teardown could not be confirmed: the event is
      // what fleet clients act on, and announcing an agent deactivated while
      // it may still be running is the same false claim verified activation
      // exists to prevent, arriving as an event instead of as a response.
      if (success) {
        this.deps.broadcast({
          action: 'agent_deactivated_event',
          success: true,
          type: session.type,
          key: session.key,
          sessionId: session.sessionId,
          ...(preemption ? { preempted: true } : {})
        });
      }

      respond({
        action: 'deactivate_response',
        success,
        // The address, so a caller that asked about several agents can tell
        // which one this answers for — a fleet list showing every agent at
        // once cannot attribute a bare `success: false` to a row.
        type: session.type,
        key: session.key,
        sessionId: session.sessionId,
        ...(preemption ? { preempted: true } : {}),
        ...(error ? { error } : {})
      });
      return;
    }

    // No session, but the agent may well be alive: the session map dies with
    // the daemon and the herdr pane does not. Close it through the fallback
    // rather than telling the caller an obviously-running agent is gone.
    //
    // (In the extraction source this path also recorded the stand-down in the
    // durable registry, which is what let "already gone" count as success —
    // the registry write was the real request. That arrives with T4; until
    // then an agent that cannot be found is reported as exactly that.)
    const result = this.deps.herdrBridge.closeAgentByKey(key);

    const closedType =
      (typeof data.type === 'string' && data.type.trim() ? data.type.trim() : undefined) ??
      (result.agentName ? typeFromAgentName(result.agentName, key) : undefined);

    if (result.success) {
      this.deps.broadcast({
        action: 'agent_deactivated_event',
        success: true,
        ...(closedType ? { type: closedType } : {}),
        key,
        ...(preemption ? { preempted: true } : {})
      });
    }

    respond({
      action: 'deactivate_response',
      key,
      ...(closedType ? { type: closedType } : {}),
      success: result.success,
      ...(preemption ? { preempted: true } : {}),
      ...(result.error ? { error: result.error } : {})
    });
  }

  public handleResetByKey(data: any, respond: Respond) {
    const { type, key } = data;
    const badAddress = invalidAddress(key, type);
    if (badAddress || typeof type !== 'string' || !type.trim()) {
      respond({
        action: 'reset_response',
        success: false,
        error: badAddress ?? 'Missing or invalid type'
      });
      return;
    }
    const session = this.deps.herdrBridge.getSessionByKey(key);

    // Tear the agent down *before* resetWorkspace deletes the directory it is
    // running in. Without a session the agent is still reachable through the
    // herdr-list fallback, and skipping that would leave the agent alive in a
    // cwd that no longer exists.
    const { success: agentClosed, error: agentError } = session
      ? this.deps.herdrBridge.terminateSession(session.sessionId)
      : this.deps.herdrBridge.closeAgentByKey(key);

    // The workspace still goes away even if no agent was there to close —
    // reset's job is to leave nothing behind. Unless the target isn't ours to
    // delete, in which case `resetError` says which path was refused and why.
    const { success, error: resetError } = this.deps.herdrBridge.resetWorkspace(type, key);

    this.deps.broadcast({
      action: 'agent_reset_event',
      success,
      type,
      key,
      agentClosed
    });

    respond({
      action: 'reset_response',
      success,
      agentClosed,
      ...(agentError ? { agentError } : {}),
      // A refusal outranks the agent's complaint: it is the reason the reset
      // did not happen, and the caller needs to see the path that was rejected.
      ...(success ? {} : { error: resetError ?? agentError ?? `No workspace directory for ${type}/${key}` })
    });
  }

  /**
   * Type a message into a running agent's terminal. The delivery is
   * asynchronous (there is a settle delay between the interrupt and the
   * text), so every outcome — including a rejection we never expect — has to
   * be turned back into a response; the caller is blocked on one.
   */
  private handleSendToAgent(data: any, respond: Respond) {
    const { key, type, message } = data;
    const fail = (error: string) =>
      respond({ action: 'send_to_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (typeof message !== 'string' || !message.trim()) {
      fail('Missing or invalid message');
      return;
    }

    this.deps.herdrBridge.sendToAgent(key, message, type).then(
      (result) => respond({ action: 'send_to_agent_response', key, ...result }),
      (err) => fail(err?.message ?? String(err))
    );
  }

  /**
   * The tail of an agent's terminal — how a supervisor finds out *why* an
   * agent is in the state it reports, without attaching to its pane.
   */
  private handleTailAgent(data: any, respond: Respond) {
    const { key, type, lines } = data;
    const fail = (error: string) =>
      respond({ action: 'tail_agent_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }
    if (lines !== undefined && (typeof lines !== 'number' || !Number.isFinite(lines))) {
      fail('Invalid lines: expected a number');
      return;
    }

    try {
      respond({
        action: 'tail_agent_response',
        key,
        ...this.deps.herdrBridge.tailAgent(key, type, lines)
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  /**
   * Everything known about one agent, by address. A daemon restart empties
   * the session map while the herdr pane keeps running, so a missing session
   * degrades to herdr's own view (`sessionless: true`) rather than failing —
   * an agent that outlived its daemon is exactly the one a supervisor most
   * needs to inspect.
   */
  private handleAgentStatus(data: any, respond: Respond) {
    const { key, type } = data;
    const fail = (error: string) =>
      respond({ action: 'agent_status_response', success: false, error });

    const badAddress = invalidAddress(key, type);
    if (badAddress) {
      fail(badAddress);
      return;
    }

    try {
      const session = this.deps.herdrBridge.getSessionByAddress(key, type);
      if (session) {
        respond({
          action: 'agent_status_response',
          success: true,
          sessionless: false,
          agentName: agentNameFor(session.type, session.key),
          ...this.toAgentDto(session, this.deps.herdrBridge.listHerdrStatuses())
        });
        return;
      }

      const described = this.deps.herdrBridge.describeAgent(key, type);
      respond({
        action: 'agent_status_response',
        success: true,
        sessionless: true,
        agentName: described.agentName,
        sessionId: null,
        type: described.type,
        key,
        url: null,
        createdAt: null,
        status: null,
        workDir: described.workDir,
        herdrStatus: described.herdrStatus
      });
    } catch (err: any) {
      fail(err?.message ?? String(err));
    }
  }

  private toAgentDto(session: HerdrSession, statuses: Map<string, HerdrAgentStatus>): AgentDto {
    return {
      sessionId: session.sessionId,
      type: session.type,
      key: session.key,
      url: session.url,
      createdAt: session.createdAt.toISOString(),
      status: session.status,
      workDir: session.workDir,
      herdrStatus: statuses.get(agentNameFor(session.type, session.key)) ?? 'unknown'
    };
  }

  /**
   * Everything running, from herdr's view unioned with our own.
   *
   * The session map is emptied by a daemon restart while the herdr panes keep
   * running, so a list built from sessions alone answers "nothing is running"
   * for a machine full of working agents — and that is the reading a
   * supervisor acts on. herdr is therefore the source of existence here,
   * exactly as it already is for `agent_status`, `deactivate` and `reset`;
   * sessions only add what herdr cannot know (session id, bound url, creation
   * time).
   *
   * An entry counts as an agent when *either* test passes: this daemon holds a
   * live session for it, or herdr reports an agent runtime behind its pane.
   * What fails both is a `crabcast-*` name with a bare shell behind it and no
   * session of ours — nothing to message, tail or supervise. Those are kept
   * out of `agents`, because a supervisor counting the list must get a number
   * it can act on, and reported under `unbackedPanes`, because silently
   * dropping them would repeat the mistake this handler exists to fix.
   *
   * (The registry-derived categories — missingAgents, preemptedAgents,
   * standbyAgents — arrive with the durable registry, T4 of KAN-68.)
   */
  private handleListAgents(_data: any, respond: Respond) {
    const { agents, unbackedPanes } = this.surveyAgents();

    // Descriptor headroom, reported where someone looking at agents will see
    // it. In the extraction source the herdr server's fd usage was invisible
    // until spawning broke (KAN-24), and the only way to learn it was to read
    // /proc by hand. Expressed in panes because that is the unit the reader
    // can act on — "room for 12 more agents" is a decision, "62000
    // descriptors" is trivia.
    const usage = readFdUsage();

    respond({
      action: 'list_agents_response',
      success: true,
      agents,
      unbackedPanes,
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

  /**
   * The agent census behind `list_agents`, shared with anything that needs to
   * know what is running. Split out so every consumer counts exactly what the
   * list reports; two answers to "what is running" is one answer too many.
   */
  private surveyAgents(): {
    agents: ListedAgent[];
    unbackedPanes: UnbackedPane[];
    staleSessions: Set<string>;
  } {
    const { reachable, agents: herdrAgents } = this.deps.herdrBridge.listHerdrAgentsChecked();
    const byName = new Map<string, HerdrAgentRecord>(herdrAgents.map(a => [a.name, a]));
    const statuses = new Map(herdrAgents.map(a => [a.name, a.herdrStatus]));

    const agents: ListedAgent[] = [];
    const attached = new Set<string>();

    /**
     * Sessions this daemon still holds for agents herdr no longer has.
     *
     * A session is our record that we *started* something; it is not evidence
     * that the thing is still alive, and it outlives the agent whenever the
     * pane dies without us tearing it down — which is precisely what a crashed
     * or killed agent looks like. Listing one as running is how a dead agent
     * reads as work in progress with nothing behind it: the silent loss this
     * census exists to remove, reintroduced one layer up.
     */
    const staleSessions = new Set<string>();

    for (const session of this.deps.herdrBridge.listActiveSessions()) {
      const agentName = agentNameFor(session.type, session.key);
      attached.add(agentName);

      // herdr is the authority on whether an agent exists — but only when it
      // answered. An unreachable herdr returns an empty census, and treating
      // that silence as "they are all dead" would condemn a perfectly healthy
      // fleet, so in that case we keep trusting the session map.
      //
      // Two different deaths, and only one of them is unconditional. A name
      // herdr has never heard of is gone, full stop. A name it *has* with no
      // runtime behind it is a pane whose agent exited — dead too, except for
      // a `shell` workspace, where a bare prompt and no runtime is the entire
      // point. Calling one of those missing would be a false alarm about
      // something working exactly as asked. The session records which reading
      // applies — initPty set expectsRuntime when it resolved the launcher.
      if (reachable) {
        const record = byName.get(agentName);
        const dead = !record || (!record.agentRuntime && (session.expectsRuntime ?? true));
        if (dead) {
          staleSessions.add(agentName);
          continue;
        }
      }

      const dto = this.toAgentDto(session, statuses);
      agents.push({
        sessionless: false,
        agentName,
        sessionId: dto.sessionId,
        type: dto.type,
        key: dto.key,
        url: dto.url ?? null,
        createdAt: dto.createdAt,
        status: dto.status,
        workDir: dto.workDir,
        herdrStatus: dto.herdrStatus,
        agentRuntime: byName.get(agentName)?.agentRuntime ?? null,
        gateExempt: this.deps.registry.get(dto.type)?.gateExempt ?? false
      });
    }

    const unbackedPanes: UnbackedPane[] = [];

    for (const record of herdrAgents) {
      if (attached.has(record.name)) continue;
      const address = addressFromAgentName(record.name);
      if (!address) continue; // Not one of ours; herdr hosts more than CrabCast.

      if (!record.agentRuntime) {
        unbackedPanes.push({
          agentName: record.name,
          type: address.type,
          key: address.key,
          workDir: record.workDir,
          herdrStatus: record.herdrStatus,
          reason:
            'herdr reports no agent running in this pane and this daemon holds no session for it'
        });
        continue;
      }

      // Session-only fields are null, not invented. There is no session id to
      // report, no url the agent was bound to and no creation time we saw —
      // filling them in to match the attached shape would be a fabrication.
      agents.push({
        sessionless: true,
        agentName: record.name,
        sessionId: null,
        type: address.type,
        key: address.key,
        url: null,
        createdAt: null,
        status: null,
        workDir: record.workDir,
        herdrStatus: record.herdrStatus,
        agentRuntime: record.agentRuntime,
        gateExempt: this.deps.registry.get(address.type)?.gateExempt ?? false
      });
    }

    return { agents, unbackedPanes, staleSessions };
  }

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
      'and the client has not re-resolved since. Ask for the workspace again (activate ' +
      'by key) and use the session id that comes back; retrying this one cannot succeed.'
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
