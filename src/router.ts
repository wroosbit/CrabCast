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
    // A caller deciding whether to trust the cap can see whether anyone
    // measured it.
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
  agentName: string;
  type: string | null;
  key: string;
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
  /** `shell/demo-1`, for refusal prose. */
  what: string;
  type: string;
  key: string;
  agentName: string;
  /** What this activation outranks. See priority.ts. */
  priority: number;
  /** Start it past the cap without freeing anything. */
  override: unknown;
  /** Free a slot by standing down something this activation outranks. */
  preempt: unknown;
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
        respond({
          success: false,
          error: `Unknown action: ${typeof data?.action === 'string' ? data.action : JSON.stringify(data?.action)}`
        });
    }
  }

  /**
   * Whether the machine can carry another agent, checked before spawning one.
   *
   * Only consulted when a *new* agent would be created: re-attaching to an
   * agent that is already running costs the machine nothing, and refusing that
   * would be refusing to look at work already in flight. The caller's own
   * session miss is not enough to establish that, because the session map dies
   * with the daemon while the herdr pane does not — so the census check below
   * asks herdr, and every re-attach after a daemon restart skips the gate.
   * Without it a client could not get back to agents it was already
   * supervising, and precisely when the machine was busiest.
   *
   * An override is honoured — a cap that cannot be exceeded on purpose is a
   * cap people work around — but it is recorded rather than waved through.
   * Someone reading the log later should be able to see that the machine was
   * over-staffed deliberately, and what the numbers were at the time.
   *
   * Activations of `gateExempt` types are never refused at all — see the
   * exemption below, which is where the capacity model's "exempt types are
   * not part of the limit" decision is actually honoured.
   */
  private capacityGate(request: GateRequest): CapacityGateResult {
    const { what, type, key, agentName, priority, override, preempt } = request;
    const pass = (capacity: Capacity): CapacityGateResult => ({
      capacity,
      refusal: null,
      overrode: null,
      preemptable: null,
      preempted: null
    });

    const { agents } = this.surveyAgents();

    if (agents.some((a) => a.agentName === agentName)) {
      // Already alive and already counted. Starting nothing costs nothing.
      return pass(this.capacityOf(agents));
    }

    const capacity = this.capacityOf(agents);

    // gateExempt types pass unconditionally (KAN-57, generalized from the
    // extraction source's hardcoded supervisor set to the flag in
    // crabcast.config.json). The capacity model already decided they are not
    // part of the limit: they are neither counted in `running` nor charged a
    // slot (see capacity.ts's header for the argument), so a load- or
    // headroom-bound refusal here was refusing an agent whose cost the model
    // had already declined to charge — the gate arguing with its own
    // arithmetic. It was also a lockout in practice: desktop baseline load
    // alone can pin headroomByLoad at 0 indefinitely, which meant always-on
    // supervising agents could never start or auto-restore without a manual
    // override. They are higher priority by convention and always-on by
    // intent, so the gate has nothing to ration for them: no refusal, and
    // therefore no override to record and no preemption to offer. Charged
    // activations below are untouched, and exempt agents still appear in
    // every capacity report as `exemptAgents`.
    if (this.deps.registry.get(type)?.gateExempt === true) return pass(capacity);

    if (!capacity.atCapacity) return pass(capacity);

    // Everything running that this activation could conceivably displace, and
    // the one it would take. `victim` is null in the ordinary case — a worker
    // agent on a machine full of workers of its own priority outranks
    // nothing, and neither does anything at all when only top-of-scale agents
    // are running.
    const candidates = this.preemptionCandidates(agents, agentName);
    const victim = selectVictim(candidates, priority);
    const derivation = describeCapacity(capacity);
    const offer = (v: PreemptionCandidate): PreemptionOfferDto => ({
      agentName: v.agentName,
      type: v.type,
      key: v.key,
      priority: v.priority,
      herdrStatus: v.herdrStatus,
      incomingPriority: priority,
      offer: preemptionOffer(v, priority)
    });

    if (preempt && victim) {
      const at = new Date().toISOString();
      const preemption: PreemptionRecord = {
        byAgentName: agentName,
        byType: type,
        byKey: key,
        byPriority: priority,
        priority: victim.priority,
        herdrStatus: victim.herdrStatus,
        derivation
      };

      // Through the ordinary stand-down path rather than a teardown of its
      // own. `deactivate_by_key` already handles every case this needs — a
      // live session and an agent that outlived its daemon — and answers
      // honestly about which it found. Preemption reusing it means there is
      // one way an agent stops, not two.
      let standDown: any = null;
      this.handleDeactivateByKey(
        { key: victim.key, type: victim.type ?? undefined, preemption },
        (msg: any) => {
          standDown = msg;
        }
      );

      if (!standDown?.success) {
        // Nothing was freed, so nothing may start. Refusing here is the
        // important half: proceeding would leave the machine over capacity
        // *and* have announced a preemption that did not happen.
        const error =
          `Refusing to activate ${what}: standing down ${addressOf(victim)} to make room ` +
          `failed (${standDown?.error ?? 'no reason given'}), so no capacity was freed.\n` +
          derivation;
        console.error(`[capacity] preemption aborted: ${error}`);
        return { capacity, refusal: error, overrode: null, preemptable: offer(victim), preempted: null };
      }

      console.warn(
        `[capacity] preemption: ${what} (priority ${priority}) stood down ` +
        `${describeCandidate(victim)} at ${at}\n${derivation}`
      );
      // The event carries the full PreemptionRecord. Durable persistence of
      // that record — and the preemptedAgents reporting built on it — is the
      // registry slice's (T4 of KAN-68, `recordDeactivated(record,
      // preemption)`); until it lands, this broadcast is the record's only
      // carrier, so nothing here may drop a field of it.
      this.deps.broadcast({
        action: 'agent_preempted_event',
        success: true,
        at,
        victim: offer(victim),
        by: { agentName, type, key, priority },
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
      // outcomes. A slot was freed on purpose; the machine is strictly better
      // off than it was a moment ago, and it is about to look it.
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
        `${capacityRefusal(capacity, what)}\n` +
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
      `[capacity] override: starting ${what} past capacity at ${at}\n${derivation}`
    );
    this.deps.broadcast({
      action: 'capacity_override_event',
      success: true,
      what,
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
   * The same filter the capacity model uses, for the same reason it exists
   * there: a list that counted panes with nothing behind them would offer to
   * kill one, and a list that disagreed with `running` would offer to free a
   * slot that was never occupied.
   *
   * gateExempt-type agents are deliberately *included*. An agent of the
   * highest declared priority can never be selected: nothing outranks the top
   * of the scale and the comparison is strictly-greater, and leaving exempt
   * agents in is what makes that a fact about the ordering rather than a
   * special case somebody has to remember. (Standing one down would not free
   * a fleet slot anyway — they are never counted against the cap — but the
   * ordering, not that, is what protects them.)
   */
  private preemptionCandidates(agents: ListedAgent[], exclude?: string): PreemptionCandidate[] {
    const candidates: PreemptionCandidate[] = [];

    for (const entry of agents) {
      if (!this.countsAsAgent(entry)) continue;
      if (exclude && entry.agentName === exclude) continue;

      candidates.push({
        agentName: entry.agentName,
        type: entry.type,
        key: entry.key,
        priority: this.deps.registry.priorityFor(entry.type),
        herdrStatus: entry.herdrStatus,
        // The session's creation time; null for every agent that outlived a
        // daemon restart. The durable registry (T4 of KAN-68) upgrades this
        // to the recorded activation time, which also survives restarts.
        activatedAt: entry.createdAt
      });
    }

    return candidates;
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
    let gate: CapacityGateResult | null = null;

    if (!session) {
      // Before the prompt is even rendered: the cheapest refusal is the one
      // that happens before any work is done for an agent that will not exist.
      gate = this.capacityGate({
        what: `${type}/${key}`,
        type,
        key,
        agentName,
        priority: config.priority,
        override: data.override,
        preempt: data.preempt
      });
      if (gate.refusal) {
        respond({
          action: 'activate_response',
          success: false,
          type,
          key,
          url,
          // `error` is the whole refusal, for the log and for MCP callers.
          // `refusedBy`, `reason` and `derivation` are the same thing split
          // into the pieces a UI can lay out — a client that shows none of
          // this leaves the user at a dead switch.
          error: gate.refusal,
          refusedBy: 'capacity',
          reason: capacityReason(gate.capacity),
          derivation: describeCapacity(gate.capacity),
          capacity: capacityDto(gate.capacity),
          priority: config.priority,
          // Named, so a client can offer a button that says whose work it
          // ends. Absent when there is nothing this activation outranks.
          ...(gate.preemptable ? { preemption: gate.preemptable } : {})
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
        : {}),
      // What this activation cost somebody else. Reported to the caller as
      // well as broadcast, so an MCP client that started an agent by
      // preemption learns whose work it interrupted from the same response.
      ...(gate?.preempted ? { preempted: gate.preempted } : {}),
      ...(gate?.overrode
        ? { capacityOverride: { ...gate.overrode, capacity: capacityDto(gate.capacity) } }
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

    // CPU and memory headroom, for the same reason and in the same place. A
    // supervisor reading this list is about to decide whether to staff
    // another agent; this is the number that decision needs.
    const capacity = this.capacityOf(agents);

    respond({
      action: 'list_agents_response',
      success: true,
      agents,
      unbackedPanes,
      capacity: capacityDto(capacity),
      // What each running agent is worth, and therefore what a would-be
      // activation would have to outrank. Sent alongside the capacity figures
      // because "there is no room" and "there is no room *for you*" are
      // different answers, and a supervisor deciding whether to staff
      // something needs both.
      priorities: this.preemptionCandidates(agents).map((c) => ({
        agentName: c.agentName,
        type: c.type,
        key: c.key,
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
        agentName: c.agentName,
        type: c.type,
        key: c.key,
        priority: c.priority,
        herdrStatus: c.herdrStatus
      })),
      fleetPriorities: describeFleetPriorities(candidates)
    });
  }

  /**
   * Whether a `list_agents` entry costs an agent's worth of machine.
   *
   * Not everything the list reports does. The extraction source's daemon once
   * opened a bare shell for itself, and it appeared in this list because a
   * session was held for it — the right answer to "what can I attach to" and
   * the wrong one to "what is this machine carrying"; on a 4-core box it was
   * silently occupying one of two slots (KAN-25). This daemon starts nothing
   * for itself, but herdr hosts more than CrabCast and the distinction still
   * has to be drawn.
   *
   * The test is whether the entry is a workspace type this daemon starts
   * agents into, or whether herdr can see an agent runtime behind the pane.
   * Either is enough; a registered type does not wait for herdr to notice a
   * freshly spawned agent, and a runtime catches anything the config has not
   * heard of.
   *
   * Shared by the capacity count and the preemption candidate list, so an
   * agent that occupies a slot is exactly an agent that can be asked to give
   * it up.
   */
  private countsAsAgent(entry: ListedAgent): boolean {
    const registered = entry.type !== null && this.deps.registry.get(entry.type) !== undefined;
    return registered || entry.agentRuntime !== null;
  }

  /**
   * The capacity model applied to a census: charged agents in `running`,
   * gateExempt-type agents counted separately as `exemptAgents` (reported,
   * never charged — see capacity.ts).
   *
   * Every capacity answer in this daemon goes through here, so `running`
   * means the same thing in the refusal, in `list_agents` and in the
   * `capacity` action. The extraction source once passed `agents.length` at
   * each call site and its then-single supervisor was silently one of them —
   * on a 4-core machine that was half the budget spent on the supervisor
   * (KAN-34).
   */
  private capacityOf(agents: ListedAgent[]): Capacity {
    let fleet = 0;
    let exempt = 0;

    for (const entry of agents) {
      if (!this.countsAsAgent(entry)) continue;

      if (entry.gateExempt) exempt++;
      else fleet++;
    }

    return readCapacity(fleet, exempt);
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
