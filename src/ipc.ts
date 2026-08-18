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
 * nobody has to think about.
 *
 * ⚠ THAT MARGIN WAS NOT THERE, AND THIS PARAGRAPH USED TO SAY IT WAS. It read:
 * "The biggest thing that crosses this socket is a `tail_agent` response — 200
 * lines of pane text — and a `list_agents` reply for a large fleet; both are
 * kilobytes. Anything past a megabyte on a line is not a message this daemon
 * has a handler for." Every clause was true when it was written and the second
 * one stopped being true: `list_agents` echoes each agent's frozen `config`,
 * an agent's `prompt` is finished text accepted up to `MAX_PROMPT_CHARS`
 * (128 KiB), and the reply carries one per row. **Ten agents with supervisor-
 * sized prompts exceed this bound on their own** — measured on a live fleet at
 * KAN-528, where `crabcast list` stopped answering entirely and the error
 * printed the sentence above while being the counter-example to it.
 *
 * WHAT KEEPS THE MARGIN NOW IS A MECHANISM AND NOT A SENTENCE. A fleet read
 * echoes {@link SummarisedAgentConfig} — the prompt's character count in place
 * of its text — so the term that grew with the fleet is gone from the response
 * rather than merely believed to be small. The prompt still travels whole on
 * `agent_status`, which is ONE record and bounded by `MAX_PROMPT_CHARS`.
 *
 * ⚠ THIS BOUND IS STILL REACHABLE AND NOTHING HERE PROMISES OTHERWISE. What
 * changed is which fleet reaches it: the remaining fleet row is ~1.9 KB
 * measured, so the cliff moved from ten agents to several hundred rather than
 * being removed. A message that crosses it is answered by
 * {@link LineOverflowError} and a distinct exit code, so the next agent to meet
 * it is told what happened instead of being told it cannot have happened.
 */
export const MAX_LINE_CHARS = 1024 * 1024;

/**
 * A peer sent more than {@link MAX_LINE_CHARS} on one line, so the connection
 * was closed.
 *
 * A TYPE RATHER THAN A RECOGNISABLE STRING (KAN-528), because the CLI has to
 * tell this apart from every other reason a socket closes in order to exit
 * with the right code — and the alternative on offer was matching the message
 * text, which is a coupling that breaks silently the first time somebody
 * improves the wording. The overflow is the one close whose cause is known
 * exactly at the moment it happens; carrying that in the type is what stops it
 * being re-derived, badly, downstream.
 *
 * WHAT IT MEANS, and it is the opposite of what the exit code used to say: the
 * daemon WAS reached, the request WAS asked, and an answer WAS produced. What
 * failed is that the answer would not fit the framing. A caller that retries
 * this as a transport fault retries a request that will fail identically.
 */
export class LineOverflowError extends Error {
  /** The bound that was exceeded, so a caller need not import the constant. */
  readonly limit: number;
  constructor(message: string, limit: number) {
    super(message);
    this.name = 'LineOverflowError';
    this.limit = limit;
  }
}

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
      // ⚠ THE SECOND SENTENCE HERE USED TO BE A REASSURANCE, AND IT WAS
      // EMITTED BY THE ONE EVENT THAT REFUTES IT (KAN-528). It read: "Messages
      // are newline-delimited JSON and no message this daemon serves
      // approaches that size." True when written; false by the time anything
      // could print it, because the only way to read that line is for a
      // message this daemon serves to have exceeded the size. It sent the
      // agent that met it looking for a dead daemon.
      //
      // What replaces it says what happened, what it is NOT, and what to do —
      // and it deliberately makes no claim about which messages can or cannot
      // reach this bound, because that is the class of claim that failed here.
      const error =
        `Line exceeded ${MAX_LINE_CHARS} characters with no newline; ` +
        `closing the connection. This is a SIZE failure, not a transport one: ` +
        `the peer was reached and a message was produced, and what failed is ` +
        `that it did not fit the framing. Retrying it unchanged will fail ` +
        `identically. If this was a fleet read, the fleet has outgrown what ` +
        `one message can carry — ask for less of it (a narrower \`owner\`, or ` +
        `a smaller \`pages.<category>.limit\`) and report it, because a read ` +
        `this size is a defect in what the response carries rather than in ` +
        `your call.`;
      buffer = '';
      if (onError) onError(new LineOverflowError(error, MAX_LINE_CHARS));
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
