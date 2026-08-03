import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The socket lives in the data directory, which comes from the config file
// (default `~/.local/share/crabcast`). One fixed rendezvous per data dir
// rather than XDG_RUNTIME_DIR: CLI runs, MCP servers, and daemon-spawned
// agents must all find the same daemon even when their environments differ.
export const SOCKET_FILENAME = 'crabcast.sock';
export const SPAWN_ERR_FILENAME = 'daemon-spawn.err';

export function socketPathFor(dataDir: string): string {
  return path.join(dataDir, SOCKET_FILENAME);
}

export function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

/**
 * The longest single NDJSON line this framing will assemble before giving up
 * on the peer.
 *
 * The buffer below is the only unbounded thing on the socket path: a peer that
 * streams bytes and never sends a newline is never *wrong* by the framing's
 * rules, so without a bound the daemon grows a string as large as the peer
 * cares to make it — one connection, no authentication beyond file
 * permissions, and the daemon is out of memory. A bound turns that from a
 * memory exhaustion into a refused connection.
 *
 * 1 MiB because it has to be larger than any legitimate message by a margin
 * nobody has to think about. The biggest thing that crosses this socket is a
 * `tail_agent` response — 200 lines of pane text — and a `list_agents` reply
 * for a large fleet; both are kilobytes. Anything past a megabyte on a line is
 * not a message this daemon has a handler for.
 */
export const MAX_LINE_CHARS = 1024 * 1024;

// Newline-delimited JSON framing over a stream. Uses a StringDecoder so a
// multi-byte character split across chunks (pty output) doesn't corrupt.
//
// Bounded (see MAX_LINE_CHARS): a line that grows past the bound ends the
// connection rather than the daemon. The peer is told why on the way out —
// a connection that simply vanishes is indistinguishable from a crash, and
// this one is a deliberate refusal with a reason worth reading.
export function onJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: any) => void,
  onError?: (err: Error) => void
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let overflowed = false;
  stream.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    buffer += decoder.write(chunk);
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err: any) {
        if (onError) onError(err);
      }
    }

    // Only what is left *after* every complete line has been consumed counts
    // against the bound: the bound is on one message, not on throughput.
    if (buffer.length > MAX_LINE_CHARS) {
      overflowed = true;
      const error =
        `Line exceeded ${MAX_LINE_CHARS} characters with no newline; ` +
        `closing the connection. Messages are newline-delimited JSON and no ` +
        `message this daemon serves approaches that size.`;
      buffer = '';
      if (onError) onError(new Error(error));
      const duplex = stream as unknown as net.Socket;
      // Say so on the wire before hanging up, when there is a wire to say it
      // on. Best-effort by construction: the peer may already be gone, and a
      // failure to deliver the explanation must not stop the close.
      try {
        if (typeof duplex.write === 'function' && !duplex.destroyed) {
          duplex.write(JSON.stringify({ success: false, error }) + '\n');
        }
      } catch {}
      try {
        if (typeof duplex.destroy === 'function') duplex.destroy();
      } catch {}
    }
  });
}

export function writeJsonLine(socket: net.Socket, msg: any): boolean {
  if (socket.destroyed) return false;
  socket.write(JSON.stringify(msg) + '\n');
  return true;
}

export function spawnDaemon(dataDir: string, configPath?: string): void {
  ensureDataDir(dataDir);
  const daemonPath = path.join(__dirname, 'daemon.js');
  // Capture the child's stderr: a daemon that dies during module load (bad
  // node version, missing dep) crashes before its own logger opens, and with
  // stdio 'ignore' that failure would be completely invisible. Config
  // refusals land here too — the daemon refuses before its log exists.
  const errFd = fs.openSync(path.join(dataDir, SPAWN_ERR_FILENAME), 'a');
  try {
    const child = spawn(process.execPath, [daemonPath, ...(configPath ? [configPath] : [])], {
      detached: true,
      stdio: ['ignore', 'ignore', errFd]
    });
    child.unref();
  } finally {
    fs.closeSync(errFd);
  }
}

// Connect to the daemon socket, optionally spawning the daemon on first
// failure. If two clients race to spawn, the loser daemon detects the
// winner's socket and exits; both clients land on the survivor.
// Callers must attach their own 'error' handler to the resolved socket.
export function connectToDaemon(
  dataDir: string,
  opts: {
    spawnIfMissing?: boolean;
    retries?: number;
    delayMs?: number;
    /** Forwarded to a spawned daemon so it loads the caller's config. */
    configPath?: string;
  } = {}
): Promise<net.Socket> {
  const { spawnIfMissing = true, delayMs = 250, configPath } = opts;
  // The retry budget exists for exactly one thing: waiting out the daemon this
  // call just spawned, which needs a second or so to load its config, claim
  // the socket and listen. A caller that has said `spawnIfMissing: false` has
  // ruled that out — nobody is starting a daemon, so nothing is going to
  // appear at that path — and every retry after the first refused connect is
  // 250ms spent re-asking a question already answered. Five seconds of it is
  // what an MCP tool call used to pay to learn there was no daemon.
  //
  // An explicit `retries` still wins: a caller that knows a daemon is
  // restarting under it can ask to wait, and this only changes what happens
  // when nobody said.
  const retries = opts.retries ?? (spawnIfMissing ? 20 : 0);
  const socketPath = socketPathFor(dataDir);
  return new Promise((resolve, reject) => {
    let spawned = false;
    const attempt = (remaining: number) => {
      const socket = net.connect(socketPath);
      const onConnect = () => {
        socket.removeListener('error', onFail);
        resolve(socket);
      };
      const onFail = (err: Error) => {
        socket.removeListener('connect', onConnect);
        socket.destroy();
        if (remaining <= 0) {
          reject(err);
          return;
        }
        if (spawnIfMissing && !spawned) {
          spawned = true;
          try {
            spawnDaemon(dataDir, configPath);
          } catch {
            // fall through to retries; final failure surfaces the error
          }
        }
        setTimeout(() => attempt(remaining - 1), delayMs);
      };
      socket.once('connect', onConnect);
      socket.once('error', onFail);
    };
    attempt(retries);
  });
}
