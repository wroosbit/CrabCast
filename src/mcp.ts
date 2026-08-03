import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import * as net from 'net';
import { DEFAULT_DATA_DIR, loadConfig, resolveConfigSource } from './config.js';
import { connectToDaemon, onJsonLines, writeJsonLine } from './ipc.js';

// The daemon's MCP server: stdio to its client, and an ordinary NDJSON client
// of the daemon's unix socket on the other side. One protocol on the socket,
// multiplexed by convention — a message carrying an `id` answers a pending
// request, an `action` ending `_event` is a broadcast forwarded as an MCP
// notification, anything else is dropped.

const server = new Server(
  {
    name: "crabcast-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    },
  }
);

// The socket lives under the config's dataDir, so finding the daemon means
// finding the config. Resolution mirrors the daemon's own (argv path, else
// CRABCAST_CONFIG, else ./crabcast.config.json); workspace .mcp.json
// definitions bake the daemon's config path into CRABCAST_CONFIG, so a server
// spawned inside an agent workspace addresses the daemon that provisioned it.
//
// A config that was named explicitly but does not load is a refusal, not a
// fallback — connecting to some other daemon than the one asked for is how a
// tool call steers the wrong fleet. Only when nothing was named at all does
// the server fall back to the default data dir, and then it never spawns a
// daemon there: a daemon spawned without a config would refuse to boot, so
// the spawn could only manufacture a confusing half-failure.
//
// That never-spawn path also answers fast: connectToDaemon's retry budget is
// there to wait out a daemon it started, and with nothing being started the
// first refused connect is already the final answer (see ipc.ts). It used to
// take the full 20 × 250ms before saying so, on a path that had nothing to
// wait for.
// `argv[2]` is this server's own config argument (workspace .mcp.json
// definitions pass it, or set CRABCAST_CONFIG); the resolution rule and the
// was-it-named question both live in config.ts, shared with the daemon and
// the CLI.
const { path: configPath, named: explicitConfig } = resolveConfigSource(process.argv[2]);
let dataDir: string;
let spawnIfMissing: boolean;
try {
  dataDir = loadConfig(configPath).dataDir;
  spawnIfMissing = true;
} catch (err: any) {
  if (explicitConfig) {
    console.error(`crabcast-mcp: refusing to start: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  console.error(
    `crabcast-mcp: no loadable config at ${configPath}; ` +
    `using the default data dir ${DEFAULT_DATA_DIR} and connecting only to an ` +
    `already-running daemon. Pass a config path as the first argument or set ` +
    `CRABCAST_CONFIG to address a specific daemon.`
  );
  dataDir = DEFAULT_DATA_DIR;
  spawnIfMissing = false;
}

// Persistent connection to the CrabCast daemon's Unix socket. Requests carry
// an id the daemon echoes back; broadcast events arrive without one and are
// forwarded as MCP logging notifications.
let daemonSocket: net.Socket | null = null;
let connectingDaemon: Promise<net.Socket> | null = null;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextRequestId = 0;

function daemonLink(): Promise<net.Socket> {
  if (daemonSocket) return Promise.resolve(daemonSocket);
  if (!connectingDaemon) {
    connectingDaemon = connectToDaemon(dataDir, { spawnIfMissing, configPath: spawnIfMissing ? configPath : undefined })
      .then((socket) => {
        connectingDaemon = null;
        daemonSocket = socket;

        onJsonLines(socket, (msg) => {
          const entry = msg?.id !== undefined ? pending.get(msg.id) : undefined;
          if (entry) {
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            const { id, ...body } = msg;
            entry.resolve(body);
          } else if (typeof msg?.action === 'string' && msg.action.endsWith('_event')) {
            server.notification({
              method: "notifications/message",
              params: {
                level: "info",
                data: `[CrabCast Event] ${msg.action} - ${msg.type}/${msg.key}`
              }
            }).catch(() => {});
          }
        });

        // The cause, kept until the close that follows it can use it.
        //
        // A socket 'error' is always followed by 'close', and it is the only
        // place the *reason* for that close exists: ECONNRESET (the daemon
        // died), EPIPE (it hung up mid-write), the framing refusal above.
        // Swallowing it left every pending request rejected with a generic
        // "connection closed" and left the reason nowhere at all — a caller
        // debugging a tool that suddenly stops working got the shape of the
        // failure and none of its content. A handler is still required (an
        // unhandled 'error' on a socket is a thrown exception that would take
        // the MCP server down with it); what changed is that it keeps what it
        // was handed.
        let socketError: Error | null = null;
        socket.on('error', (err: Error) => {
          socketError = err;
          console.error(`crabcast-mcp: daemon socket error: ${err?.message ?? String(err)}`);
        });
        socket.on('close', () => {
          daemonSocket = null;
          const reason = socketError
            ? `Daemon connection closed: ${(socketError as Error).message}`
            : 'Daemon connection closed';
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
          }
          pending.clear();
        });

        return socket;
      })
      .catch((err) => {
        connectingDaemon = null;
        throw err;
      });
  }
  return connectingDaemon;
}

// Helper to send requests to the main daemon
async function callDaemonAPI(action: string, data: any = {}): Promise<any> {
  const socket = await daemonLink();
  const id = `mcp-${process.pid}-${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Daemon request timed out: ${action}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    const wrote = writeJsonLine(socket, {
      action,
      ...data,
      id,
      // Workspace identity, when this server was spawned inside an agent
      // workspace. Dead weight today — the router reads neither field — and
      // kept as the extraction source had it rather than grown into a
      // feature here. Follow-up candidate: either the router starts using
      // them (e.g. attributing requests to the calling agent) or they go.
      workspaceType: process.env.CRABCAST_WORKSPACE_TYPE || undefined,
      workspaceKey: process.env.CRABCAST_WORKSPACE_KEY || undefined
    });
    // writeJsonLine refuses (returns false) on a destroyed socket. That is
    // the close-then-write race: the memoised socket died after daemonLink
    // resolved it, the request was never sent, and nothing is coming back —
    // waiting out the 30s timeout would charge the caller half a minute for
    // a failure detected in this very call. The next call reconnects lazily.
    if (!wrote) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Daemon connection closed before the request could be sent: ${action}`));
    }
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "crabcast_capacity",
        description:
          "Reports how many concurrent agents this machine can carry and how many more can be started right now. The cap is derived from the machine's own cores and memory, so it differs between machines; headroom additionally accounts for the current load average, so a fleet that is compiling reports less room than the same fleet idle. Ask this before activating, not after the machine is on its knees. ALSO REPORTS priorities: each running agent's worth is its workspace type's priority number from the daemon's config, which is what an activation at capacity would have to strictly outrank before it could stand any of them down.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "crabcast_activate_agent",
        description:
          "Activates an agent for a specific workspace type and key. The type must be one the daemon's config declares; the key names which workspace of that type. Refused when the machine is already at capacity — see crabcast_capacity — unless override or preempt is set. A refusal names what is running and what each one is worth; when this activation outranks one of them, the refusal also carries a `preemption` block naming the agent that could be stood down to make room.",
        inputSchema: {
          type: "object",
          properties: {
            override: {
              type: "boolean",
              description:
                "Optional. Start the agent even when the machine is at capacity. The refusal it bypasses is recorded with the load and memory figures at the time. Use it deliberately, not reflexively: the cap exists because a human noticed the desktop had become unusable.",
            },
            preempt: {
              type: "boolean",
              description:
                "Optional, and destructive. Make room by standing down the lowest-priority agent this activation STRICTLY outranks, rather than over-committing the machine as override does. Priority is a per-type number from the daemon's config; only strictly greater preempts — equal never does, so an agent can never displace another of its own type, and nothing can displace the highest-priority type. The victim's uncommitted work is interrupted; it is recorded as preempted, reported by crabcast_list_agents until it is put back, and resumes its conversation when re-activated. Read the `preemption` block on the refusal first — it names exactly who would be stopped and what they are doing — and do not pass this without having decided that this work matters more than theirs.",
            },
            type: {
              type: "string",
              description: "The workspace type — one of the types declared in the daemon's config (e.g. 'shell')",
            },
            key: {
              type: "string",
              description: "The workspace key naming which workspace of that type (e.g. 'demo-1')",
            },
            url: {
              type: "string",
              description: "Optional. A page URL this agent is bound to, shown wherever the agent is listed. Omit it if unknown — the agent is then shown without a link rather than with a fabricated one.",
            },
            defaultAgent: {
              type: "string",
              description: "Optional. The agent runtime to launch (e.g. 'claude'). Must name a launcher the daemon knows; omitted, the workspace type's configured default is used.",
            },
          },
          required: ["type", "key"],
        },
      },
      {
        name: "crabcast_deactivate_agent",
        description: "Deactivates an active agent by its workspace key",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key (e.g., 'demo-1')",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "crabcast_send_to_agent",
        description:
          "Sends a message to a running agent's terminal as if a human typed it: interrupts any partially typed input, types the message, and presses Enter. Use this to give a still-running agent new instructions (e.g. review feedback) without attaching to its terminal.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to message (e.g., 'demo-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'shell'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
            message: {
              type: "string",
              description: "The message to type into the agent's terminal",
            },
          },
          required: ["key", "message"],
        },
      },
      {
        name: "crabcast_tail_agent",
        description:
          "Reads the recent terminal output of an agent without attaching to it. Use this to find out what an agent is actually doing — or why it stopped — when its reported status alone is not enough.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to read (e.g., 'demo-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'shell'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
            lines: {
              type: "number",
              description: "Optional. How many trailing lines to return (default 40, max 200)",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "crabcast_agent_status",
        description:
          "Reports an agent's full state: session id, workspace type and key, url, creation time, session status, working directory, and herdr's own view of what the agent is doing. If the daemon has restarted and lost its session, the herdr-only fields are still returned with sessionless: true.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The workspace key of the agent to inspect (e.g., 'demo-1')",
            },
            type: {
              type: "string",
              description:
                "Optional. The workspace type (e.g., 'shell'). Addresses the agent exactly; omit to resolve the key against herdr's agent list.",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "crabcast_list_agents",
        description:
          "Lists every running agent, from herdr's view of what exists rather than the daemon's session map — so agents that outlived a daemon restart are still listed. Each entry carries sessionless: true when the daemon is not attached to it, in which case the session-only fields (sessionId, url, createdAt, status) are null. Panes named like agents but with no agent behind them are reported separately under unbackedPanes and are not counted as agents. ALSO CHECK missingAgents: agents recorded as active that are not running at all — their work has silently stopped while still looking staffed, so treat a non-empty missingAgents as work that needs re-activating or deliberately standing down. ALSO CHECK preemptedAgents: agents stood down to free capacity for higher-priority work, listed until somebody puts them back. Their work was interrupted rather than finished, so whoever supervises each one owes it a decision: re-activate it (which resumes the conversation it was stopped in) or stand it down for good. standbyAgents is NOT a problem to fix: agents somebody switched off on purpose whose workspace is still on disk, listed so they can be started again (crabcast_activate_agent with their type and key, and their recorded defaultAgent so they come back as what they were). All three of those lists are newest-first and clipped at 25; missingTotal, preemptedTotal and standbyTotal are the unclipped counts, so a total larger than its list means there are older entries this response did not carry.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "crabcast_reset_agent",
        description: "Deactivates an agent and securely deletes its workspace directory",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "The workspace type (e.g., 'shell')",
            },
            key: {
              type: "string",
              description: "The workspace key (e.g., 'demo-1')",
            },
          },
          required: ["type", "key"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "crabcast_capacity") {
      const res = await callDaemonAPI('capacity');
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_activate_agent") {
      const { type, key, url, defaultAgent, override, preempt } = args as any;
      if (!type || !key) throw new Error("Missing required arguments");

      const res = await callDaemonAPI('activate_by_key', { type, key, url, defaultAgent, override, preempt });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // The sibling tools already flag their failures this way. Without it a
        // failed activation arrives as ordinary text, which is exactly how a
        // caller ends up believing an agent exists that does not.
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_deactivate_agent") {
      const { key } = args as any;
      if (!key) throw new Error("Missing key argument");

      const res = await callDaemonAPI('deactivate_by_key', { key });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // The extraction source left this one tool without the mapping. The
        // asymmetry is the same trap in mirror image: a failed deactivation
        // arriving as ordinary text is how a caller ends up believing an
        // agent is gone that is still running — and still holding its slot.
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_send_to_agent") {
      const { key, type, message } = args as any;
      if (!key || !message) throw new Error("Missing required arguments: key, message");

      const res = await callDaemonAPI('send_to_agent', { key, type, message });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_tail_agent") {
      const { key, type, lines } = args as any;
      if (!key) throw new Error("Missing required argument: key");

      const res = await callDaemonAPI('tail_agent', { key, type, lines });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_agent_status") {
      const { key, type } = args as any;
      if (!key) throw new Error("Missing required argument: key");

      const res = await callDaemonAPI('agent_status', { key, type });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_list_agents") {
      const res = await callDaemonAPI('list_agents');
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // isError when an agent is missing, not only when the call failed: a
        // supervisor skimming tool output for problems must not skim past
        // work that has silently stopped while still looking staffed.
        //
        // A preempted agent is the same failure by a different route — its
        // work also looks staffed with nothing behind it — so it flags the
        // same way. The difference is that somebody chose this one, which
        // makes it a decision owed rather than a loss to investigate.
        //
        // (Both fields arrive with the durable-registry slice; until then
        // they are simply absent and this mapping is inert.)
        isError:
          res?.success === false ||
          (Array.isArray(res?.missingAgents) && res.missingAgents.length > 0) ||
          (Array.isArray(res?.preemptedAgents) && res.preemptedAgents.length > 0),
      };
    }

    if (name === "crabcast_reset_agent") {
      const { type, key } = args as any;
      if (!type || !key) throw new Error("Missing required arguments: type, key");

      const res = await callDaemonAPI('reset_by_key', { type, key });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // See crabcast_deactivate_agent: a reset that failed — the workspace
        // refused deletion, the agent would not close — must not read as a
        // clean slate.
        isError: res?.success === false,
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (error: any) {
    // A typed protocol error travels as one. The catch-all below exists for
    // the *tool's* failures — a daemon that would not answer, a missing
    // argument — which are results the caller asked for and did not get, and
    // which belong in the tool result where a model reads them. An unknown
    // tool name is a different kind of wrong: it is the MCP layer's own error
    // code, and downgrading it to `isError: true` with the text "Error:
    // Unknown tool: x" told the client "your call ran and failed" when the
    // truth was "there is no such method here" — the one answer a client can
    // act on by re-listing the tools. The SDK serialises McpError into a
    // JSON-RPC error with its code, so rethrowing is all that is needed.
    if (error instanceof McpError) throw error;
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CrabCast MCP Server running on stdio");
  // Connect eagerly (spawning the daemon if needed) so broadcast events
  // stream as notifications; tool calls reconnect lazily on failure.
  daemonLink().catch(() => {});
}

run().catch(console.error);
