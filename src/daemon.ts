import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ConfigError, CrabcastConfig, loadConfig, resolveConfigPath } from './config.js';
import { WorkspaceRegistry } from './registry.js';
import { MessageRouter } from './router.js';
import { PromptLoader } from './prompt.js';
import { HerdrBridge } from './herdr.js';
import {
  checkHerdrVersion,
  describeFdCeiling,
  isFdCeilingUnraised,
  readFdUsage
} from './herdr-health.js';
import { ensureDataDir, onJsonLines, socketPathFor, writeJsonLine } from './ipc.js';
import { resolveUserPath, which } from './env.js';

// The single long-lived CrabCast daemon. Owns all sessions and the workspace
// registry. Clients (the CLI, the MCP server) connect over a Unix domain
// socket speaking newline-delimited JSON, so filesystem permissions are the
// auth boundary and there is no TCP port for anything to fight over.

// Config is loaded before the logger exists — the log file lives in the
// config's dataDir — so a refusal goes to stderr, where the operator who just
// mistyped the config is looking.
let config: CrabcastConfig;
try {
  config = loadConfig(resolveConfigPath());
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`crabcast: refusing to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
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
    const versionWarning = checkHerdrVersion(version);
    if (versionWarning) log(`WARNING: ${versionWarning}`);
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

const registry = new WorkspaceRegistry(config.workspaceTypes);
// Prompt paths belong to the config that names them, so they resolve from the
// config file's directory rather than from any install location.
const promptLoader = new PromptLoader(config.baseDir);
const herdrBridge = new HerdrBridge(config.dataDir);

log(`Config loaded from ${config.configPath} (dataDir ${config.dataDir})`);
log(`Loaded ${config.workspaceTypes.length} workspace type(s):`);
for (const type of config.workspaceTypes) {
  log(
    `  ${type.name} — priority ${type.priority}, launcher ${type.defaultLauncher}, ` +
      `prompt ${type.promptFile}, gateExempt ${type.gateExempt}, ` +
      `mcpServers [${type.mcpServers.join(', ')}]`
  );
}

const daemonStartedAt = new Date();

const connections = new Set<net.Socket>();

const broadcast = (msg: any) => {
  for (const conn of connections) {
    writeJsonLine(conn, msg);
  }
};

// A PTY that dies takes the terminal with it, and the client has no other way
// to find out: output simply stops. Announcing it is what lets a client show
// a disconnected state instead of a frozen last frame.
herdrBridge.setSessionEndedListener((event) => {
  log(
    `Session ended: ${event.sessionId} (${event.type}/${event.key}) ` +
    `reason=${event.reason} exitCode=${event.exitCode}`
  );
  broadcast({ action: 'agent_detached_event', success: true, ...event });
});

const server = net.createServer((socket) => {
  connections.add(socket);
  log(`Client connected (${connections.size} total)`);

  // One router per connection: responses go back to the requesting client,
  // and PTY listeners registered by this client die with its connection.
  const router = new MessageRouter({
    registry,
    config,
    promptLoader,
    herdrBridge,
    daemonStartedAt,
    send: (msg) => writeJsonLine(socket, msg),
    broadcast
  });

  onJsonLines(
    socket,
    (msg) => {
      try {
        router.handle(msg);
      } catch (err: any) {
        log('Handler error:', err);
        writeJsonLine(socket, {
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

function onListen() {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {}
  log(`CrabCast daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);
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
