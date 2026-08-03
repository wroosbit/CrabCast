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

// Newline-delimited JSON framing over a stream. Uses a StringDecoder so a
// multi-byte character split across chunks (pty output) doesn't corrupt.
export function onJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: any) => void,
  onError?: (err: Error) => void
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
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
  const { spawnIfMissing = true, retries = 20, delayMs = 250, configPath } = opts;
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
