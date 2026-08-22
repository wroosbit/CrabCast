// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  AgentCostMeasurement,
  MeasurementStart,
  finishMeasurement,
  startMeasurement
} from './agent-cost.js';
import { dampCost, sampleFromMeasurement, MIN_MEASURED_CORES } from './agent-cost-damping.js';
import { AgentCost, MEASURED_AGENT_COST, setMeasuredAgentCost } from './capacity.js';
import { CpuWindow, finishCpuWindow, setObservedCpu, startCpuWindow } from './machine-cpu.js';
import { ConfigError, CrabcastConfig, loadConfig, resolveConfigPath } from './config.js';
import { daemonConfigPathArg } from './daemon-invocation.js';
import { FleetObservation, FleetStatusMemory, MessageRouter, MissingAgent } from './router.js';
import { HerdrBridge, ourPaneIn } from './herdr.js';
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
import { RestoreOutcome, reconcileAgents } from './reconcile.js';
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
  // Two entrypoints reach this line, and they hand the path over differently:
  // `node dist/daemon.js [configPath]` puts it in argv[2], and `crabcast
  // daemon` (KAN-322) resolves it through the CLI's own `--config` rule and
  // declares it before importing this module. Which of the two happened is
  // daemon-invocation.ts's business; the resolution rule after it is
  // config.ts's. Reading argv[2] directly here would load the CLI's flags as
  // a config file on the second path.
  config = loadConfig(resolveConfigPath(daemonConfigPathArg()));
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`crabcast: refusing to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// THE DURABLE LOG PRE-FLIGHT — A NOTICE, AND NO LONGER A REFUSAL (KAN-302).
//
// Before the socket, before the logger, before anything reads the registry:
// count the rows this daemon's format does not cover, and SAY SO. This used to
// `process.exit(1)`, and the two sentences that justified exiting are the two
// this replacement had to answer rather than ignore:
//
//   "Loading the file part-way is not offered: the agents in those rows would
//    simply not exist, AND NOTHING WOULD SAY SO."
//
// The objection is to the silence, not to the starting — a daemon that comes up
// reporting a fleet with a hole in it, indistinguishable from a healthy one, is
// the exact failure this registry exists to remove. Something now says so, in
// two places: this notice, and `unreadableRecords` on `list_agents` and
// `daemon_status`, which is the half a caller can actually read. The rows stay
// in the file and survive compaction untouched (agent-registry.ts).
//
// What exiting cost was out of all proportion to what it bought. One row
// written by a CrabCast eight days older — describing an agent that had already
// been DEACTIVATED and was asking for nothing — took the whole daemon off the
// machine, and the first remedy it printed was "delete the registry", i.e.
// discard every other agent record to recover from that one row. The specimen
// is real: `epic/KAN-203` met it trying to bring up a daemon for Butchr, with
// every dashboard green and nothing anywhere saying CrabCast was unreachable.
//
// stderr AND the log, because the two reach different people: stderr is where
// the operator who just ran the daemon in the foreground is looking, and it is
// what lands in `daemon-spawn.err` for a detached spawn — which is where this
// defect was eventually found. The log line is written once the logger exists,
// a few lines below.
const logScan = scanLogVersions(registryPathFor(config.dataDir));
const unreadableAtBoot = logScan.preMigration + logScan.fromNewer + logScan.unusable;
if (unreadableAtBoot > 0) {
  process.stderr.write(`crabcast: ${describeUnreadableLog(logScan)}\n`);
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

// The same notice again, now that there is a log to put it in. Both copies are
// deliberate: the stderr one is gone the moment the terminal scrolls, and this
// one is what an operator finds when they come looking a week later.
if (unreadableAtBoot > 0) {
  log(`[AgentRegistry] ${describeUnreadableLog(logScan)}`);
}

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
    // ALSO on stderr, and this is the foreground case specifically (KAN-322).
    // `log` writes into the data dir's daemon.log — which the INCUMBENT owns,
    // so this line lands in the winner's log where somebody looking for the
    // loser's fate will not think to read. Detached spawns get it in
    // daemon-spawn.err and are otherwise unattended, but `crabcast daemon` is
    // run by a person or a supervisor watching this stream, and exiting 0
    // having printed nothing at all is indistinguishable from having started.
    //
    // A clean exit is still the right answer rather than an error: the
    // incumbent is serving, so there is nothing wrong here, and a supervisor
    // configured `Restart=on-failure` must NOT restart this. Saying so on
    // stderr is what keeps the silence from being the only evidence.
    process.stderr.write(
      `crabcast: a daemon is already running on ${SOCKET_PATH} and is serving; this one is ` +
        `exiting 0 without taking the socket. Nothing is wrong and nothing was changed — ` +
        `use \`crabcast daemon-status\` to see the one that is running.\n`
    );
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
 * How often the daemon re-measures what its own agents cost (KAN-56, in the
 * extraction source).
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
 * sample that fails validation — clears the live measurement so capacity falls
 * back to MEASURED_AGENT_COST with the report labelling the figures as seed. A
 * stale estimate left posing as live would be the exact mislabelling the
 * provenance labels (KAN-44, in the extraction source) exist to correct.
 */
function degradeCostMeasurement(reason: string) {
  costEstimate = null;
  setMeasuredAgentCost(null);
  if (costSamplerState !== 'no-measurement') {
    costSamplerState = 'no-measurement';
    log(`Agent-cost sampler: ${reason}; capacity answers from the seed constants until sampling recovers`);
  }
}

/**
 * Why a window's charged sample was empty — the VACUITY CASE, which
 * attribution creates and which therefore has to be named rather than counted
 * (KAN-338).
 *
 * A divisor over an empty sample is a gate that agrees with any register at
 * all, so the sample being empty must reach `degradeCostMeasurement` and pull
 * the arithmetic back to the labelled seed. That guard is NOT new — the
 * `totals.agents <= 0` rejection in `sampleFromMeasurement` has always been
 * there for an empty fleet — and attribution's contribution is to make it
 * reachable in a state that LOOKS busy: seven agent trees on the machine,
 * none of them ours, which used to produce a confident measurement of
 * somebody else's fleet. This is the exact state of the machine this was
 * written on (2026-08-13).
 *
 * Three causes, said apart, because the operator's next move differs: `foreign`
 * is another orchestrator and needs nothing; `no-handle` is an agent runtime
 * started outside a herdr pane; `handle-unreadable` is this daemon unable to
 * read those processes at all, which is a configuration fault that would
 * otherwise be indistinguishable from an idle machine.
 */
function describeEmptySample(seen: AgentCostMeasurement['seen']): string {
  if (seen.trees === 0) return 'no agent trees running, nothing to measure';
  const why: string[] = [];
  if (seen.foreign > 0) why.push(`${seen.foreign} belonging to no chargeable record of ours`);
  if (seen.noHandle > 0) why.push(`${seen.noHandle} carrying no herdr pane handle`);
  if (seen.handleUnreadable > 0) {
    why.push(`${seen.handleUnreadable} whose environment this daemon cannot read`);
  }
  return (
    `${seen.trees} agent tree(s) are running and none is a chargeable agent of this daemon ` +
    `(${why.join('; ')})`
  );
}

/**
 * The pane names of the agents this daemon may charge for, or null when herdr
 * did not answer (KAN-338).
 *
 * THE ONE OWNERSHIP TEST DECIDES, AND IT IS `ourPaneIn`. This function asks it
 * once per chargeable record and collects the answers; it does not re-derive a
 * pane name from a path, compare a `cwd`, or hold any second opinion about
 * what "ours" means. That is what keeps herdr.ts:552's rule intact while the
 * sampler gains attribution: the join added by KAN-338 supplies a CANDIDATE
 * pane, and this set — built out of the existing test's own answers — is what
 * says whether the candidate is ours.
 *
 * `chargeable: false` agents are left out here rather than downstream, because
 * that is the whole numerator/denominator point: the budget being divided is
 * the budget for charged agents, so the divisor must be measured from charged
 * agents. An exempt supervisor of our own is as wrong in this sample as a
 * stranger's agent is.
 *
 * NULL IS NOT AN EMPTY SET, and the distinction is load-bearing exactly as it
 * is for `Occupancy` (herdr.ts:464): an unreachable herdr returns an empty
 * census, so treating silence as "none of them are ours" would attribute the
 * whole machine away and read as a fleet that is not running. The caller
 * degrades to the seed instead, and says which of the two happened.
 */
function chargedPaneNames(): Set<string> | null {
  const census = herdrBridge.listHerdrAgentsChecked();
  if (!census.reachable) return null;

  const names = new Set<string>();
  for (const intent of agentRegistry.intents().values()) {
    const record = intent.record;
    if (!record.config.chargeable) continue;
    const ours = ourPaneIn(census, record.path, record.config.launcher);
    if (ours) names.add(ours.name);
  }
  return names;
}

function sampleFleetCost() {
  // Asked BEFORE the window is closed rather than lazily inside the
  // attributor, so that "herdr is unreachable" is one fact read once. Asked
  // per tree it would be N nulls that cannot be told apart from N panes that
  // are genuinely not ours — the same conflation `listHerdrAgentsChecked`
  // exists to prevent.
  const charged = costWindow ? chargedPaneNames() : null;
  if (costWindow && charged === null) {
    // Reopen the window regardless: the next tick should measure a fresh
    // minute, not one stretched across a herdr outage.
    costWindow = startMeasurement();
    degradeCostMeasurement(
      'herdr did not answer, so no process tree can be attributed to an agent record'
    );
    return;
  }

  let measurement;
  try {
    measurement =
      costWindow && charged
        ? finishMeasurement(costWindow, (paneHandle) => {
            const paneName = herdrBridge.paneNameForHandle(paneHandle);
            return paneName !== null && charged.has(paneName);
          })
        : null;
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
        ? describeEmptySample(measurement.seen)
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
    agentTrees: measurement.totals.agents,
    // What the window SAW, beside what it charged. A divisor averaged over 2
    // of 9 trees and one averaged over 2 of 2 are different claims about how
    // representative the figure is, and the report cannot say so from
    // `agentTrees` alone (KAN-338).
    treesSeen: measurement.seen.trees
  };
  setMeasuredAgentCost(published);
  if (costSamplerState !== 'live') {
    costSamplerState = 'live';
    log(
      `Agent-cost sampler: live measurement established — damped cost ` +
      `${Math.round(published.residentBytes / (1024 * 1024))} MB / ${published.cores} core per tree ` +
      `(${published.agentTrees} of ${published.treesSeen} tree(s) attributed to this daemon, ` +
      `${Math.round(published.windowSeconds)}s window)`
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
    // THE LOG LINE CARRIES THE QUALIFICATION TOO (KAN-572). It is a third
    // surface saying the same thing, and it said the flat version — "herdr has
    // no live agent in that directory" — which is FALSE of an occupied row and
    // is exactly the sentence the row itself stopped saying. A fix applied to
    // the response and the event, with the operator's log left asserting the
    // old claim, would have left the contradiction where an operator debugging
    // a false alarm is most likely to meet it.
    log(
      `AGENT LOST: ${agent.path} is recorded as active since ${agent.since} but herdr has no ` +
      `live agent of ours in that directory.` +
      (agent.occupiedBy
        ? ` A pane this daemon did not start is in it — ${agent.occupiedBy.paneName}` +
          `${agent.occupiedBy.paneId ? ` (pane ${agent.occupiedBy.paneId})` : ''}, ` +
          `${agent.occupiedBy.herdrStatus} — so work has NOT stopped there and activating ` +
          `this agent would be refused.`
        : '')
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

  // Why a deferral happened, in the boot summary's own parenthesis (KAN-263).
  //
  // Built from what the outcomes actually say rather than from a sentence about
  // what deferrals used to mean, which is the drift this replaced: a mixed pass
  // names both reasons with their counts, so a reader is never told about herdr
  // when it was the machine, or the other way round.
  const describeDeferrals = (deferred: RestoreOutcome[]): string => {
    if (!deferred.length) return '';
    const capacity = deferred.filter((o) => o.deferredBy === 'capacity').length;
    const herdr = deferred.length - capacity;
    const parts = [
      herdr ? `${herdr} because herdr could not confirm their directories were free` : '',
      capacity ? `${capacity} because this machine had no room for them` : ''
    ].filter(Boolean);
    return ` (${parts.join('; ')})`;
  };

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
      const stranded = result.outcomes.filter((o) => o.result === 'stranded');
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
        // COUNTED APART FROM `failed`, AND THAT IS THE WHOLE OF WHAT KAN-619
        // CHANGED HERE. A record whose directory is gone used to be counted as
        // a failure, so the ordinary residue of workspaces somebody finished
        // with and deleted read as a fleet that came back short — and the error
        // beside it advised recreating the directory, which is the remedy for a
        // typo at `configure` time and the opposite of what this record wants.
        // It is not deferred either: nothing about it will have changed by the
        // deferred pass. See `RECONCILE_STRANDED` in reconcile.ts for why it is
        // still attempted at all.
        `${stranded.length} stranded, ` +
        // Named separately from `failed` on purpose: a deferred agent was not
        // refused on its own merits and nothing about it was recorded, so it
        // is still expected and still restorable. Folding it into "failed"
        // would read as a verdict this pass never reached.
        //
        // AND SPLIT BY REASON (KAN-263). This clause used to read "(herdr could
        // not confirm their directories were free)" unconditionally, which was
        // the only reason a deferral existed when it was written. Since boot
        // restoration stopped overriding the capacity gate there is a second,
        // and the two have different remedies — a herdr blip clears on its own,
        // a full machine wants an agent stood down or time. A summary that
        // names the wrong one sends the reader to look at herdr while the
        // machine is what refused.
        `${deferred.length} deferred${describeDeferrals(deferred)}.` +
        (deferred.length
          ? ` Still expected and unrestored: ${deferred.map((o) => o.path).join(', ')} — ` +
            `reported by the missing-agent sweep until they come back.`
          : '') +
        (stranded.length
          ? ` Stranded (their directories are gone; nothing was recorded and nothing was ` +
            `retired, so they are attempted again at the next boot — \`crabcast forget\` is ` +
            `what retires one): ${stranded.map((o) => o.path).join(', ')}.`
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
