import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { finishMeasurement, startMeasurement, MeasurementStart } from './agent-cost.js';
import { dampCost, sampleFromMeasurement, MIN_MEASURED_CORES } from './agent-cost-damping.js';
import { AgentCost, MEASURED_AGENT_COST, setMeasuredAgentCost } from './capacity.js';
import { CpuWindow, finishCpuWindow, setObservedCpu, startCpuWindow } from './machine-cpu.js';
import { ConfigError, CrabcastConfig, loadConfig, resolveConfigPath } from './config.js';
import { FleetObservation, FleetStatusMemory, MessageRouter, MissingAgent } from './router.js';
import { HerdrBridge } from './herdr.js';
import {
  HERDR_VERSION_NOTICE_FIELD,
  checkHerdrVersion,
  describeFdCeiling,
  isFdCeilingUnraised,
  readFdUsage
} from './herdr-health.js';
import { ensureDataDir, onJsonLines, socketPathFor, writeJsonLine } from './ipc.js';
import { describeContract, describeEvent, events } from './events.js';
import { resolveUserPath, which } from './env.js';
import { AgentRegistry, describeUnreadableLog, registryPathFor, scanLogVersions } from './agent-registry.js';
import { reconcileAgents } from './reconcile.js';
import { snapshotBuild } from './provenance.js';

// The single long-lived CrabCast daemon. Owns all sessions and the workspace
// registry. Clients (the CLI, the MCP server) connect over a Unix domain
// socket speaking newline-delimited JSON, so filesystem permissions are the
// auth boundary and there is no TCP port for anything to fight over.

// Config is loaded before the logger exists — the log file lives in the
// config's dataDir — so a refusal goes to stderr, where the operator who just
// mistyped the config is looking.
let config: CrabcastConfig;
try {
  // The daemon's own argv: `node dist/daemon.js [configPath]`. The position is
  // this file's business; the resolution rule after it is config.ts's.
  config = loadConfig(resolveConfigPath(process.argv[2]));
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`crabcast: refusing to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// THE DURABLE LOG PRE-FLIGHT, and its placement is the design.
//
// Before the socket, before the logger, before anything reads the registry:
// count the rows this daemon's format does not cover. Non-zero and it refuses
// to start, naming the file, the count and the two remedies.
//
// The check is OUTSIDE `readLog`, deliberately, and tightening `readLog`'s own
// filter instead would have been the obvious move and the wrong one.
// Pre-migration rows carry `type`/`key`/`workDir` and no `path`, so a tightened
// filter would drop every one of them SILENTLY — that filter is silent on
// purpose, for torn-tail tolerance — and the daemon would come up reporting an
// empty fleet, indistinguishable from a healthy one. A whole fleet vanishing
// with no line anywhere saying so is the exact failure this registry exists to
// remove, so the version question is asked in a different place, out loud, and
// answered by refusing rather than by half-loading.
//
// stderr, like a ConfigError: the operator who just upgraded is looking there,
// and daemon.log does not exist yet at this point.
const logScan = scanLogVersions(registryPathFor(config.dataDir));
if (logScan.preMigration + logScan.fromNewer + logScan.unusable > 0) {
  process.stderr.write(`crabcast: ${describeUnreadableLog(logScan)}\n`);
  process.exit(1);
}

const SOCKET_PATH = socketPathFor(config.dataDir);

ensureDataDir(config.dataDir);
// Synchronous writes, deliberately: several paths here log one line and call
// process.exit() — the losing daemon of a spawn race, a failed socket claim —
// and a buffered stream would drop exactly the line that explains the exit.
// The log is low-volume; ordering and durability are worth more than the
// syscall.
const logFd = fs.openSync(path.join(config.dataDir, 'daemon.log'), 'a');
const log = (...args: any[]) => {
  const line = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  try {
    fs.writeSync(logFd, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};
// The daemon normally runs detached; shared modules log via console.
console.log = log;
console.error = log;

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log('Unhandled rejection:', err as any);
});

// Normalize PATH before anything spawns: this daemon outlives the client that
// started it, and its environment is inherited by every herdr pane and agent.
process.env.PATH = resolveUserPath();
log(`PATH resolved to: ${process.env.PATH}`);

/**
 * The verdict on the installed herdr, computed once here at startup and then
 * carried to a person (KAN-102).
 *
 * It used to be logged and nothing else. This daemon is spawned detached by
 * whichever client needed it first (ipc.ts), so nothing is attached to its
 * stdout and `daemon.log` is a file a new user does not know exists — which
 * made a check that had already diagnosed the problem indistinguishable, from
 * the user's seat, from no check at all. It is still logged; it now also rides
 * out on the first response each client gets, where somebody is looking.
 *
 * Once, at startup, deliberately: `herdr --version` is a process spawn, and
 * the answer is a property of the machine rather than of any one request.
 */
let herdrVersionNotice: string | undefined;

const herdrPath = which('herdr');
if (herdrPath) {
  log(`herdr found at ${herdrPath}`);
  // Which herdr, not just whether there is one: 0.7 changed `agent start`
  // incompatibly, and without this the only symptom is `unknown option: --cwd`
  // on every activation.
  try {
    const version = execFileSync(herdrPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    log(`herdr version: ${version.trim()}`);
    herdrVersionNotice = checkHerdrVersion(version);
    if (herdrVersionNotice) log(`WARNING: ${herdrVersionNotice}`);
  } catch (e: any) {
    log(`Could not read herdr's version: ${e?.message ?? String(e)}`);
  }
} else {
  log('WARNING: herdr not found on PATH; agent sessions will fail to attach');
}

// The pane ceiling, checked once at startup rather than left to be discovered
// as a total spawn outage. A herdr on the stock 1024 soft limit runs out of
// descriptors at ~205 panes, and a limit nobody verified is folklore.
const fdUsage = readFdUsage();
if (!fdUsage) {
  log('herdr fd limit: no running herdr server to inspect (or no /proc); skipping the check');
} else if (isFdCeilingUnraised(fdUsage)) {
  log(`WARNING: ${describeFdCeiling(fdUsage)}`);
} else {
  log(
    `herdr fd limit: soft ${fdUsage.softLimit}, ${fdUsage.openFds} open, ` +
    `headroom ≈ ${fdUsage.headroomPanes} panes (pid ${fdUsage.pid})`
  );
}

const herdrBridge = new HerdrBridge(config.dataDir, config.configPath);

// The one piece of state that outlives the machine. Everything else here —
// the session map, herdr's panes, a client's view — dies in a power cut,
// which is why a reboot used to destroy the fleet with nothing to say about
// it. See agent-registry.ts for why it is an fsync'd append-only log.
const agentRegistry = new AgentRegistry(registryPathFor(config.dataDir));

/**
 * WHAT THIS DAEMON HAS WATCHED ITS FLEET DOING — one per process, beside the
 * bridge and the registry because it belongs to the same tier: state that is
 * the DAEMON's rather than any one connection's.
 *
 * The sweep writes it and every `list_agents` reads it, and those happen on
 * different routers — this daemon makes one per connection. Constructed here
 * and handed to all of them, which is the only arrangement in which
 * `statusSince` can ever be anything but null (KAN-200).
 *
 * In memory on purpose: it is a fact about this process's watching, not about
 * the agents, so a restart forgetting it is correct rather than merely
 * tolerable. KAN-189 settled that question; router.ts carries the reasoning.
 */
const fleetStatusMemory = new FleetStatusMemory();

log(`Config loaded from ${config.configPath} (dataDir ${config.dataDir})`);
// What used to be a list of workspace types. There are none: an agent is a
// directory plus the knobs a caller froze onto it, and the registry is the
// only place those live. So the equivalent line is about the registry.
{
  const intents = agentRegistry.intents();
  const expected = Array.from(intents.values()).filter((i) => i.event === 'activated').length;
  log(
    `Agent registry: ${intents.size} configured agent(s), ${expected} expected to be running ` +
    `(${logScan.rows} record(s) in ${registryPathFor(config.dataDir)})`
  );
  for (const [agentPath, intent] of intents) {
    const c = intent.record.config;
    log(
      `  ${agentPath} — ${intent.event}, priority ${c.priority}, launcher ${c.launcher}, ` +
        `refusable ${c.refusable}, chargeable ${c.chargeable}, preemptable ${c.preemptable}` +
        (c.prompt ? `, prompt ${c.prompt}` : '') +
        // Names only. The definitions are the caller's own command lines and can
        // carry credentials in `env`; a boot-time log line is not where those
        // belong, and the names are what identifies the agent's tooling anyway.
        (Object.keys(c.mcpServers ?? {}).length
          ? `, mcp [${Object.keys(c.mcpServers ?? {}).join(', ')}]`
          : '') +
        (c.label ? `, label ${JSON.stringify(c.label)}` : '')
    );
  }
}

const daemonStartedAt = new Date();

/**
 * What THIS process was loaded from, frozen now (KAN-122).
 *
 * Taken here, at boot, and never retaken. That is the entire value of it: from
 * the next moment on, `dist/` can be rebuilt underneath this process and the
 * filesystem will look perfectly current while this daemon goes on executing
 * the code it read at startup. Nothing but the process itself can report that,
 * and it can only do so by having remembered.
 *
 * Before the socket opens, so the first client to ask gets an answer about the
 * build this daemon actually loaded rather than about whatever arrived since.
 */
const bootBuild = snapshotBuild();
{
  const p = bootBuild.provenance;
  log(
    `Build provenance: ${p.commit ?? 'UNKNOWN commit'} ` +
    `(${p.clean === true ? 'clean checkout' : p.clean === false ? 'DIRTY CHECKOUT' : 'cleanliness UNKNOWN'}), ` +
    `built ${p.builtAt ?? 'UNKNOWN'}, from ${p.distDir} ` +
    `(${bootBuild.dist.files} file(s), newest ${bootBuild.dist.newestAt ?? 'n/a'})`
  );
  for (const [field, reason] of Object.entries(p.unknown)) {
    log(`  build provenance UNKNOWN — ${field}: ${reason}`);
  }
}

// THE CONTRACT, ANNOUNCED ONCE. A breaking rename is news exactly here: in the
// log of the daemon that stopped emitting the old names, beside the `bootId`
// that tells every reconnecting subscriber to resync. Once rather than per
// event, for the same reason the herdr version notice rides on one response —
// a notice repeated is a notice skipped.
log(describeContract(events.bootId));

const connections = new Set<net.Socket>();

/**
 * The one choke point every published event passes through.
 *
 * Two jobs, and the second is the one that was missing. It stamps the envelope
 * — `at`, a per-boot monotonic `seq`, and this boot's `bootId` — so a
 * subscriber can detect a gap or a restart without being told. And it asks the
 * contract whether it recognises the action, so an event added to this daemon
 * without being added to `events.ts` is a warning naming it rather than a
 * frame nobody downstream will forward.
 *
 * An off-contract action is still written to the socket, deliberately.
 * `broadcast` filters nothing and matching is the subscriber's job — that is
 * the socket half of the contract, and the forward-compatibility clause
 * (ignore what you do not recognise, do not error) is what makes adding an
 * event later non-breaking. Dropping it here would trade a loud warning for a
 * silent disappearance, which is the trade this whole slice exists to undo.
 * The MCP path is the strict one: there the allowlist drops it, because an MCP
 * notification has a declared payload shape and there is none for an action
 * nobody wrote down.
 */
const broadcast = (msg: any) => {
  const { onContract, frame } = events.stamp(msg);
  if (!onContract) {
    log(
      `WARNING: broadcasting an action that is not on the event contract: ` +
      `${JSON.stringify(msg?.action)}. It goes out on the socket unsequenced — a subscriber ` +
      `must ignore an action it does not recognise — and the MCP forwarder will DROP it. ` +
      `Add it to EVENT_NAMES/EVENT_CONTRACT in src/events.ts and to docs/event-contract.md.`
    );
  }
  for (const conn of connections) {
    writeJsonLine(conn, frame);
  }
};

// A PTY that dies takes the terminal with it, and the client has no other way
// to find out: output simply stops. Announcing it is what lets a client show
// a disconnected state instead of a frozen last frame.
herdrBridge.setSessionEndedListener((event) => {
  log(
    `Session ended: ${event.sessionId} (${event.path}) ` +
    `reason=${event.reason} exitCode=${event.exitCode}`
  );
  broadcast({ action: 'agent.detached', ...event });
});

const server = net.createServer((socket) => {
  connections.add(socket);
  log(`Client connected (${connections.size} total)`);

  // The version verdict rides on the FIRST answer this client gets and no
  // later one. Once is what makes it a notice: repeated on every response it
  // would be noise a client learns to skip, which is the failure mode the
  // 30-second missing-agent broadcast is latched against for the same reason.
  // On a response rather than on a banner of its own because there is no
  // banner — the socket carries answers, and a client that has just received
  // one is a client with a human reading it.
  //
  // Only per-request responses, never broadcasts: an event delivered to
  // whoever happens to be connected is not somebody's command coming back.
  let noticeSent = false;
  const send = (msg: any) => {
    if (herdrVersionNotice && !noticeSent) {
      noticeSent = true;
      msg = { ...msg, [HERDR_VERSION_NOTICE_FIELD]: herdrVersionNotice };
    }
    writeJsonLine(socket, msg);
  };

  // One router per connection: responses go back to the requesting client,
  // and PTY listeners registered by this client die with its connection.
  //
  // `fleetStatusMemory` is THE SAME INSTANCE every router in this process gets,
  // and that is load-bearing rather than tidy. It is written by the sweep — on
  // `daemonRouter` below — and read by whichever of these per-connection
  // routers answers a `list_agents`. Give each one its own and `statusSince`
  // comes back null on every row for ever, present and correctly typed and
  // never once populated. See FleetStatusMemory in router.ts.
  const router = new MessageRouter({
    config,
    herdrBridge,
    daemonStartedAt,
    agentRegistry,
    bootBuild,
    statusMemory: fleetStatusMemory,
    send,
    broadcast
  });

  onJsonLines(
    socket,
    (msg) => {
      try {
        router.handle(msg);
      } catch (err: any) {
        log('Handler error:', err);
        // Through `send`, not straight to the socket: this is still this
        // client's answer to this client's request, and a caller whose command
        // blew up is exactly the caller who should hear that their herdr is
        // one CrabCast has never been run against.
        send({
          success: false,
          error: err?.message ?? String(err),
          ...(msg?.id !== undefined ? { id: msg.id } : {})
        });
      }
    },
    (err) => log('Bad JSON line from client:', err.message)
  );

  socket.on('error', (err) => log('Client socket error:', err.message));
  socket.on('close', () => {
    router.cleanup();
    connections.delete(socket);
    log(`Client disconnected (${connections.size} total)`);
  });
});

let retriedStaleSocket = false;
server.on('error', (err: any) => {
  if (err.code !== 'EADDRINUSE') {
    log('Server error:', err);
    process.exit(1);
  }
  // Socket file exists: either a live daemon owns it, or it's stale from a crash.
  const probe = net.connect(SOCKET_PATH);
  probe.once('connect', () => {
    probe.end();
    log('Another daemon is already running; exiting.');
    process.exit(0);
  });
  probe.once('error', () => {
    if (retriedStaleSocket) {
      log('Could not claim socket after stale-file cleanup; exiting.');
      process.exit(1);
    }
    retriedStaleSocket = true;
    log('Removing stale socket file');
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    // No callback here: the failed first listen() left `onListen` attached as
    // a once-listener, so passing it again would run it twice on success.
    server.listen(SOCKET_PATH);
  });
});

/**
 * How often the daemon re-measures what its own agents cost (KAN-56).
 *
 * Sixty seconds, for two reasons. Long enough that the utime deltas average
 * over an agent's think/act duty cycle instead of catching one busy or one
 * idle instant, and that the sampling itself — two /proc sweeps a minute,
 * single-digit milliseconds each — stays far below anything worth charging
 * for. Short enough that, with the damping's fast-up alpha, a fleet that
 * turns busy is mostly believed within three windows, i.e. minutes.
 */
const COST_SAMPLE_INTERVAL_MS = 60_000;

/** The open "before" side of the current window; null until the first tick
 * and after any sampling failure. */
let costWindow: MeasurementStart | null = null;
/** The damped estimate, unrounded. Null whenever capacity should answer from
 * the seed. */
let costEstimate: AgentCost | null = null;
/** Transition memory so the log records changes of state, not every quiet
 * minute of a healthy sampler. */
let costSamplerState: 'no-measurement' | 'live' = 'no-measurement';

/**
 * Degrade, never guess: any failure — /proc unreadable, an empty fleet, a
 * sample that fails validation — clears the live measurement so capacity
 * falls back to MEASURED_AGENT_COST with the report labelling the figures as
 * seed. A stale estimate left posing as live would be the exact mislabelling
 * the provenance labels (KAN-44) exist to correct.
 */
function degradeCostMeasurement(reason: string) {
  costEstimate = null;
  setMeasuredAgentCost(null);
  if (costSamplerState !== 'no-measurement') {
    costSamplerState = 'no-measurement';
    log(`Agent-cost sampler: ${reason}; capacity answers from the seed constants until sampling recovers`);
  }
}

function sampleFleetCost() {
  let measurement;
  try {
    measurement = costWindow ? finishMeasurement(costWindow) : null;
    costWindow = startMeasurement();
  } catch (e: any) {
    costWindow = null;
    degradeCostMeasurement(`/proc sampling failed (${e?.message ?? String(e)})`);
    return;
  }
  if (!measurement) return; // first tick only opens the window

  const sample = sampleFromMeasurement(measurement, os.totalmem());
  if (!sample) {
    degradeCostMeasurement(
      measurement.totals.agents <= 0
        ? 'no agent trees running, nothing to measure'
        : 'sample failed validation'
    );
    return;
  }

  // Damped from the previous estimate, seeded from the constants, so the
  // first window after a gap starts from the conservative figure rather than
  // from whatever the window happened to catch. See agent-cost-damping.ts.
  costEstimate = dampCost(costEstimate ?? MEASURED_AGENT_COST, sample);
  // Published rounded (whole MB, 3-decimal cores) so the figures a capacity
  // report prints are exactly the figures the arithmetic divides by — the
  // hand-reproducibility describeCapacity promises. Cores floored so the
  // rounding can never publish a zero divisor (see MIN_MEASURED_CORES).
  const published = {
    residentBytes: Math.round(costEstimate.residentBytes / (1024 * 1024)) * 1024 * 1024,
    cores: Math.max(MIN_MEASURED_CORES, Math.round(costEstimate.cores * 1000) / 1000),
    sampledAt: Date.now(),
    windowSeconds: measurement.elapsed,
    agentTrees: measurement.totals.agents
  };
  setMeasuredAgentCost(published);
  if (costSamplerState !== 'live') {
    costSamplerState = 'live';
    log(
      `Agent-cost sampler: live measurement established — damped cost ` +
      `${Math.round(published.residentBytes / (1024 * 1024))} MB / ${published.cores} core per tree ` +
      `(${published.agentTrees} tree(s), ${Math.round(published.windowSeconds)}s window)`
    );
  }
}

/**
 * How often the daemon re-reads what the machine's CPUs are doing (KAN-208).
 *
 * Thirty seconds, and the two ends of that range are set by different things.
 * The floor is noise: at 100 jiffies per core per second a window of a second
 * or two is moved by one scheduler decision, and a twitchy CPU term would
 * refuse activations for reasons nobody could reproduce. The ceiling is the
 * quantity it is replacing — the 1-minute load average, whose lag is half of
 * what made it the wrong instrument. A term that lagged as badly as the thing
 * it replaced would have fixed only half the defect.
 *
 * It is deliberately NOT the agent-cost sampler's 60s tick, and not folded
 * into that function. That sampler degrades to null whenever there are no
 * agent trees to measure — which is exactly the state a machine is in when the
 * first activation arrives, and the state in which this figure matters most.
 * Two instruments that fail for different reasons should not share a failure
 * path.
 */
const CPU_SAMPLE_INTERVAL_MS = 30_000;

/**
 * How long the FIRST window is, which is a different question from how long
 * the steady-state ones are.
 *
 * Between the daemon opening its first window and closing it, nothing has
 * measured CPU and the gate falls back to the load average — the instrument
 * KAN-208 exists to stop trusting. Thirty seconds of that at every boot is
 * thirty seconds in which reconciliation's restores, and any activation from a
 * client that started the daemon a moment ago, are decided by the old
 * behaviour.
 *
 * Three seconds is the compromise, and it is bought rather than free: a 3s
 * window is noisier than a 30s one, and for the first half-minute of a daemon's
 * life the gate divides that noisier figure. It is above MIN_WINDOW_SECONDS, so
 * it is a real measurement rather than a rounding artefact, and every report
 * prints the window it came from — `measured over 3s` is a figure a reader
 * knows how much to trust. It also errs conservatively in practice: a daemon
 * has just been spawned, so the machine it measures is one that has just done
 * work.
 *
 * It cannot be zero, and no choice here can make it zero: a window is two reads
 * separated in time. `verify-readme-is-current` waits for the first one rather
 * than racing it, for the reason that file's `waitForCpuObservation` gives.
 */
const CPU_FIRST_WINDOW_MS = 3_000;

/** The open "before" side of the current CPU window; null until the daemon
 *  opens the first one and after any read failure. */
let cpuWindow: CpuWindow | null = null;
/** Transition memory, so the log records the instrument changing state rather
 *  than every healthy half-minute. */
let cpuSamplerState: 'no-measurement' | 'live' = 'no-measurement';

/**
 * Read the CPU counters, publish the window that just closed, open the next.
 *
 * Degrade, never guess, exactly as the cost sampler does: any failure — no
 * /proc/stat, counters that moved backwards, a window too short to mean
 * anything — clears the published observation, and capacity falls back to the
 * load average with the report saying so. A stale figure left posing as live
 * is the one outcome worth going out of the way to prevent here, because it
 * fails in the dangerous direction: an old "0.3 cores in use" would hold the
 * gate open on a machine nobody is measuring.
 */
function sampleMachineCpu() {
  const closing = cpuWindow;
  cpuWindow = startCpuWindow();
  if (!cpuWindow) {
    degradeCpuMeasurement('/proc/stat is not readable');
    return;
  }
  if (!closing) return; // first tick only opens the window

  const observation = finishCpuWindow(closing);
  if (!observation) {
    degradeCpuMeasurement('the window closed without a usable reading');
    return;
  }
  setObservedCpu(observation);
  if (cpuSamplerState !== 'live') {
    cpuSamplerState = 'live';
    log(
      `CPU sampler: live measurement established — ${observation.busyCores.toFixed(2)} of ` +
      `${os.cpus().length || 1} cores in use over a ${Math.round(observation.windowSeconds)}s ` +
      `window; capacity's CPU term now divides this rather than the load average`
    );
  }
}

function degradeCpuMeasurement(reason: string) {
  setObservedCpu(null);
  if (cpuSamplerState !== 'no-measurement') {
    cpuSamplerState = 'no-measurement';
    log(
      `CPU sampler: ${reason}; capacity falls back to the load average until it recovers ` +
      `(the load average counts uninterruptible sleep, so it can refuse a machine with ` +
      `idle cores — that fallback is the pre-KAN-208 behaviour and the report says when ` +
      `it is in force)`
    );
  }
}

/**
 * A router with nowhere to answer, for the daemon's own use.
 *
 * Reconciliation and the loss sweep are not requests — nobody is connected at
 * boot, which is the whole difficulty restoration is about — but they need to
 * do exactly what a request would. Rather than duplicating activation, they get
 * a router whose per-request `send` goes nowhere while broadcasts still reach
 * whatever clients turn up later.
 */
const daemonRouter = new MessageRouter({
  config,
  herdrBridge,
  daemonStartedAt,
  agentRegistry,
  bootBuild,
  statusMemory: fleetStatusMemory,
  send: () => {},
  broadcast
});

/**
 * How long between checks that the fleet still matches the registry.
 *
 * Not a restart loop: this only *reports*. An agent that dies mid-afternoon is
 * a different decision from one that was killed by a power cut, with different
 * failure modes, and the loss is surfaced rather than guessed at. Restoring is
 * startup's job.
 *
 * It is also `agent.status_changed`'s latency bound, and that is a deliberate
 * reuse rather than a coincidence: both questions are answered from ONE census
 * read per tick, so publishing status transitions costs no extra herdr calls.
 * The bound is published in docs/event-contract.md as part of the contract.
 */
const FLEET_SWEEP_INTERVAL_MS = 30_000;

/**
 * The detectability half. Silent loss is what made the extraction source's
 * KAN-21 outage expensive — the board read healthy for twenty minutes while
 * nothing was running — so a missing agent is announced to every connected
 * client, on top of being reported in `list_agents` on every poll. It is
 * deliberately not just a log line.
 *
 * Only *newly* missing agents are announced. An agent that has been gone for an
 * hour is still reported in `list_agents` on every request, but re-broadcasting
 * it twice a minute forever would train everyone to ignore the event.
 */
const announcedMissing = new Set<string>();

/**
 * WHERE THE LAST OBSERVED STATUS LIVES, since it is no longer here.
 *
 * This was `lastObservedStatus`, a `Map<string, HerdrAgentStatus>` in this
 * file, compared against each sweep's census to produce `agent.status_changed`.
 * It is now {@link MessageRouter.recordSweepObservation} in `router.ts`, and
 * the move is KAN-200: the map knew a transition had happened and discarded
 * WHEN, so an agent that had been idle for four hours was indistinguishable in
 * everything this daemon published from one that had just finished. The moment
 * is now kept beside the status and published as `statusSince` on the agent
 * row — which the router builds, which is why the memory had to move to where
 * the row is made rather than being copied into a second map that could
 * disagree with this one.
 *
 * Everything that was true of it is still true and is documented there: it is
 * a poll on the sweep that already runs, so the event still costs zero extra
 * herdr invocations (`observeFleet` takes ONE census and answers both
 * questions from it); the cadence is the sweep's rather than a second timer's,
 * because nothing in Butchr's supervision model needs sub-poll latency to be
 * CORRECT (KAN-59 comment 10548); and it is in memory, so a daemon restart
 * forgets it. A subscriber crossing that restart is told to resync by the new
 * `bootId`.
 */

function sweepFleet() {
  let observation;
  try {
    observation = daemonRouter.observeFleet();
  } catch (e: any) {
    log('Fleet sweep failed:', e?.message ?? String(e));
    return;
  }

  announceStatusChanges(observation);
  announceLosses(observation.missing);
}

/**
 * ANNOUNCE WHAT THE SWEEP RECORDED — and announce only that.
 *
 * The comparison, the memory and the rules that make a transition a transition
 * are {@link MessageRouter.recordSweepObservation}'s, for the reason above:
 * `statusSince` on the agent row and `agent.status_changed` on the socket are
 * the SAME observation read twice, and the surest way to make them disagree
 * would be to derive them from two maps in two files. So this function does
 * exactly one thing the router cannot — it broadcasts — and takes the
 * transitions as given.
 *
 * The rules those transitions obey, restated here because this is where a
 * reader arrives looking for them, and enforced there:
 *
 *   - SILENCE IS NOT A STATUS. An unreachable herdr answers with an empty
 *     census and every row then reads `herdrStatus: 'unknown'`; treating that
 *     as a transition would broadcast `working → unknown` for the whole fleet
 *     on any herdr blip. Nothing is compared, recorded or announced. It is the
 *     rule the bridge applies to liveness (`reachable: false` is silence, not
 *     evidence) applied to status. A status of `unknown` from a herdr that DID
 *     answer is a real observation and is reported as one: herdr saw the pane
 *     and had nothing to say about it.
 *   - A FIRST SIGHTING IS NOT A TRANSITION. It seeds the memory silently,
 *     because the alternative is a `from` this daemon never saw.
 */
function announceStatusChanges(observation: FleetObservation) {
  for (const transition of daemonRouter.recordSweepObservation(observation)) {
    log(`AGENT STATUS: ${transition.path} ${transition.from} → ${transition.to}`);
    broadcast({ action: 'agent.status_changed', ...transition });
  }
}

function announceLosses(missing: MissingAgent[]) {
  const names = new Set(missing.map((agent) => agent.path));
  for (const name of announcedMissing) {
    if (!names.has(name)) announcedMissing.delete(name);
  }

  for (const agent of missing) {
    if (announcedMissing.has(agent.path)) continue;
    announcedMissing.add(agent.path);
    log(
      `AGENT LOST: ${agent.path} is recorded as active since ${agent.since} but herdr has no ` +
      `live agent in that directory.`
    );
    broadcast({ action: 'agent.lost', ...agent });
  }
}

function onListen() {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {}
  log(`CrabCast daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);

  log(`Agent registry: ${registryPathFor(config.dataDir)}`);

  // Restoration runs after the socket is listening, not before: an activation
  // takes minutes for a fleet, and a daemon that answered nothing until it
  // finished would look exactly like a daemon that never came up.
  //
  // `reboot` rather than `daemon-restart` because that is what this daemon
  // starting means in the case restoration exists for, and because it is the
  // framing an agent needs to read: the machine went away, not just its
  // supervisor. A restored agent is told to check the repository and the
  // workspace for what it already did either way.
  void reconcileAgents({
    registry: agentRegistry,
    herdrBridge,
    router: daemonRouter,
    cause: 'reboot',
    log
  })
    .then((result) => {
      const restored = result.outcomes.filter((o) => o.result === 'restored');
      const failed = result.outcomes.filter((o) => o.result === 'failed');
      const deferred = result.outcomes.filter((o) => o.result === 'deferred');
      const idle = restored.filter((o) => o.resumedConversation && o.nudged === false);
      log(
        `[reconcile] Done: ${result.expected} expected, ` +
        `${restored.length} restored, ` +
        // Counted apart from `restored` because they are different events and
        // the difference is what a human reading a boot log needs: a restored
        // agent was started by this pass and may have lost its conversation; a
        // reattached one never stopped and this daemon simply took its
        // terminal back. Folding them together would claim credit for starting
        // agents that were working the whole time.
        `${result.outcomes.filter((o) => o.result === 'reattached').length} reattached ` +
        `(their panes survived), ` +
        `${result.outcomes.filter((o) => o.result === 'already-running').length} already running, ` +
        `${failed.length} failed, ` +
        // Named separately from `failed` on purpose: a deferred agent was not
        // refused on its own merits and nothing about it was recorded, so it
        // is still expected and still restorable. Folding it into "failed"
        // would read as a verdict this pass never reached.
        `${deferred.length} deferred (herdr could not confirm their directories were free).` +
        (deferred.length
          ? ` Still expected and unrestored: ${deferred.map((o) => o.path).join(', ')} — ` +
            `reported by the missing-agent sweep until they come back.`
          : '') +
        (idle.length
          ? ` ${idle.length} restored agent(s) could not be told to carry on and may be idle: ` +
            idle.map((o) => o.path).join(', ')
          : '')
      );
      // Whatever restoration could not bring back is a loss, and is announced
      // by the same sweep that watches for losses later. This first pass also
      // SEEDS the status map — it reports no transitions, because there is no
      // previous observation to have transitioned from.
      sweepFleet();
    })
    .catch((err) => log('[reconcile] Reconciliation failed:', err))
    .finally(() => {
      // The periodic sweep starts only after reconciliation settles. Started
      // alongside it, the first tick could land mid-restore — reconcile
      // staggers 3s between starts, so a fleet of a dozen agents is still
      // being brought back at t+30s — and every agent whose turn had not yet
      // come would be broadcast as an agent.lost and latched in
      // announcedMissing, a loss announcement with no recovery signal to
      // follow it. `.finally` so a reconcile that failed outright still
      // leaves the watch running: whatever it could not restore genuinely is
      // missing, and the sweep is what says so.
      const sweep = setInterval(sweepFleet, FLEET_SWEEP_INTERVAL_MS);
      sweep.unref();
    });

  // Open the first cost window now rather than a minute from now; the first
  // damped figure lands one interval later. Until then — and whenever the
  // sampler degrades — capacity answers from the labelled seed.
  sampleFleetCost();
  const costSampler = setInterval(sampleFleetCost, COST_SAMPLE_INTERVAL_MS);
  costSampler.unref();

  // Same reason, same shape as the cost sampler above: open the window at boot
  // rather than on the first tick. The first close comes early
  // (CPU_FIRST_WINDOW_MS) and the steady cadence follows it, so the gap in
  // which nothing has measured CPU is ~3 seconds rather than ~30.
  //
  // The gap is never zero and cannot be — a window is two reads separated in
  // time — so for those seconds capacity's CPU-side bound is the load average,
  // and reconciliation's restores can be refused there on a machine whose load
  // is high exactly as they could before KAN-208. That is stated rather than
  // hidden: `describeCapacity` says "not measured here" in words for the whole
  // of it, so a refusal in that window names the instrument that refused.
  sampleMachineCpu();
  const firstCpuWindow = setTimeout(() => {
    sampleMachineCpu();
    const cpuSampler = setInterval(sampleMachineCpu, CPU_SAMPLE_INTERVAL_MS);
    cpuSampler.unref();
  }, CPU_FIRST_WINDOW_MS);
  firstCpuWindow.unref();
  // A published observation cannot outlive the sampler that published it: the
  // age bound is enforced on READ (freshObservedCpu / MAX_OBSERVATION_AGE_MS
  // in machine-cpu.ts), so an interval that stops ticking expires its own
  // figure without needing anything here to notice.
}

const shutdown = () => {
  log('Shutting down');
  server.close();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(SOCKET_PATH, onListen);
