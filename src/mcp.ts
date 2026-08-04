import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import * as net from 'net';
import * as nodePath from 'path';
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
            // The subject, in whatever vocabulary the event actually uses.
            // This line used to be `${msg.type}/${msg.key}`, which rendered
            // `undefined/undefined` for the three events that never carried a
            // type or key — and would now do so for every one of them, since
            // agents are addressed by path. A forwarder that reliably prints
            // "undefined" is worse than one that says it has nothing to say.
            //
            // Still a format string rather than the structured payload: the
            // typed event contract, its allowlist and the payload-carrying
            // notification are the event-contract slice's, and building half
            // of them here would be the second copy that disagrees.
            const subject = msg.path ?? msg.what ?? '(no subject)';
            server.notification({
              method: "notifications/message",
              params: {
                level: "info",
                data: `[CrabCast Event] ${msg.action} - ${subject}`
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
      // Which agent is calling, when this server was spawned inside one. Dead
      // weight today — the router reads it nowhere — and carried because it is
      // the seam the supervisor-of-record slice plugs into. One field now,
      // because an agent has one address.
      agentPath: process.env.CRABCAST_AGENT_PATH || undefined
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

const PATH_PROPERTY = {
  type: "string",
  description:
    "The directory the agent runs in — its whole address. Absolute, or relative to THIS " +
    "MCP server's working directory, which is resolved here before the request is sent — " +
    "the daemon refuses a relative path, because it runs detached and its own working " +
    "directory belongs to whichever client first spawned it. The result is canonicalized " +
    "(symlinks resolved) daemon-side, so a symlink and its target are the same agent. It " +
    "must already exist: CrabCast never creates a directory.",
} as const;

/**
 * A path operand, resolved against this server's working directory.
 *
 * The description above used to promise this and nothing did it: the string
 * went to the daemon unchanged and `path.resolve` ran THERE, against a cwd
 * inherited from whichever client first spawned the daemon. Two projects could
 * send `./svc` and reach the same directory, and which one depended on where
 * the daemon was started.
 */
function agentPath(value: unknown): unknown {
  return typeof value === 'string' && value.trim() ? nodePath.resolve(value.trim()) : value;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "crabcast_capacity",
        description:
          "Reports how many concurrent agents this machine can carry and how many more can be started right now. The cap is derived from the machine's own cores and memory, so it differs between machines; headroom additionally accounts for the current load average, so a fleet that is compiling reports less room than the same fleet idle. Ask this before activating, not after the machine is on its knees. ALSO REPORTS priorities: each running agent's worth is the priority frozen onto its record by crabcast_configure_agent, which is what an activation at capacity would have to strictly outrank before it could stand any of them down.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "crabcast_configure_agent",
        description:
          "Makes an agent exist, AND is how you change one that already does. An agent IS a directory plus the knobs you freeze onto it here — there are no workspace types to inherit from, so priority and launcher arrive in this call or nowhere, and activation refuses a path that was never configured. The directory must already exist; this never creates one, so a mistyped path is refused rather than scattered through your tree. It does NOT refuse an occupied directory: it succeeds and returns `occupiedBy` naming any live pane already in there, so you learn about the occupant now rather than when activation refuses. The intended day-one sequence when adopting directories that already have agents in them is: configure the fleet, stand your own panes down, then activate. It answers `configVersion` — 1 for a new agent, one higher than before for each accepted reconfiguration — which is the token every read echoes back, so a caller can tell whether the configuration it is looking at is the one it wrote. RECONFIGURING A RUNNING AGENT IS ANSWERED PER ATTRIBUTE, and this daemon will NEVER stand an agent down to make a configuration match. `priority`, `refusable`, `chargeable`, `preemptable` and `label` change IN PLACE: they are read out of the record at the moment a capacity or preemption decision is made, so the new value is live immediately, no pane is touched and no conversation is lost. `launcher`, `prompt` and `mcpServers` were consumed when the agent was spawned — the launcher IS the running process, the prompt has already been read, and .mcp.json is read once at boot — so changing one of those under a running agent is REFUSED (`refused: 'restart-required'`), naming each attribute and its reason, with the agent left running and untouched. The remedy is in the response and it is yours to take, not ours: crabcast_deactivate_agent, then this call, then crabcast_activate_agent. There is deliberately no force flag — a reconciler that quietly discards an agent's conversation to satisfy a config diff is the failure this rule exists to prevent, and a force flag is that path with a label on it. IT IS ALSO ATOMIC: a refused call applies NOTHING, including knobs that could have changed in place, because applying half of one desired-state document leaves an agent half-new and half-old, which no retry converges out of. So the response reports PER KNOB rather than a bare success — `outcomes` maps every attribute to one of `unchanged`, `applied`, `applied-in-place`, `refused-restart-required` or `withheld` (in-place-capable, not applied because the call was refused whole), alongside `changed`, `applied`, `withheld` and `attributes`. It is also refused as `unverifiable` when a restart-only knob is asked to move, herdr cannot be reached and the record says the agent is active: an empty census from an unreachable herdr is silence, not evidence that nothing is running there. THAT REFUSAL IS A *RE*CONFIGURATION'S, AND A FIRST CONFIGURE IS ANSWERED EVEN OVER A LIVE PANE. A path with no record yet has no prior configuration to preserve and no conversation being spent, so there is nothing for the refusal to protect — and refusing would strand the path, since activation requires a configure first. That state is reachable (a registry lost while herdr's panes survived, or a forget over an agent that kept running), so it is REPORTED rather than adopted quietly: the response carries `unrecordedPane`, naming the pane and saying that NOTHING was applied to the process running in it. The knobs you just froze are what the NEXT activation will use; they do not describe what is running there now, so they read `applied` and never `applied-in-place`. Note what that means for your next call: crabcast_activate_agent ADOPTS that pane rather than starting one, and would answer `alreadyRunning: true` over a configuration no process has ever read. Stand it down and activate again if you want an agent really running what you configured.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            priority: {
              type: "number",
              description:
                "Required. What this agent outranks when the machine is full. There is no default: a silently-floored priority would be preemptable by everything and nobody would find out until its work was destroyed. Preemption is strictly-greater, so equal priorities never displace each other.",
            },
            launcher: {
              type: "string",
              description:
                "Required. The runtime to run in the pane (e.g. 'claude'). Must name a launcher the daemon knows; there is no fallback, because an omitted launcher used to mean 'shell' and staffed work with a bare prompt that answered success and executed messages as shell commands.",
            },
            prompt: {
              type: "string",
              description:
                "Optional. The agent's bootstrap prompt as FINISHED TEXT — not a path and not a template. CrabCast writes these bytes verbatim into its own sidecar directory (never into your directory), points the agent at that file by absolute path, and never inspects the content: there is no placeholder syntax and no variable set, so render whatever you want the agent to read before you send it, with whatever templating you like. Refused above 131072 characters, naming the limit and your actual size — the prompt travels inline over the socket and a truncated one would be an agent acting on half its instructions.",
            },
            mcpServers: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "object", description: "Your own server definition, written verbatim." },
                  { type: "string", enum: ["builtin"], description: "A server CrabCast constructs itself." },
                ],
              },
              description:
                "Optional. The MCP servers this agent gets, keyed by the name its runtime will see. DEFINITIONS, NOT NAMES: the value is the command/args/env that spawn the server, e.g. {\"atlassian\": {\"command\": \"npx\", \"args\": [\"-y\", \"mcp-remote\", \"https://…\"], \"env\": {\"TOKEN\": \"…\"}}}. CrabCast writes each value into .mcp.json VERBATIM — it resolves nothing, renames nothing, reorders nothing, and never inspects a definition's interior. It holds no table of server names, deliberately: which servers you want depends on which of your integrations hold a live credential, and that state never crosses this boundary. The one exception is the value \"builtin\", for servers whose definition depends on facts about this daemon rather than about you; there is exactly one, \"crabcast\", and asking for a builtin CrabCast does not have is REFUSED naming what it has. SUPPLYING THIS IS THE CONSENT to a .mcp.json appearing in your directory — there is no second opt-in flag to forget, because handing over the exact contents of the file and agreeing to it being written are not two decisions. The configure response names the file and keys it will write at activation. Every requested server must be writable or the activation is REFUSED with nothing written and nothing started: a .mcp.json holding only part of what you asked for is a file whose presence looks like success.",
            },
            label: {
              type: "string",
              description:
                "Optional. Display text. Never parsed, never an address, duplicates are fine — no read or address in this API takes a label, so there is no way to look an agent up by one.",
            },
            refusable: {
              type: "boolean",
              description:
                "Optional, default true. Whether the capacity gate may refuse this agent's activation. False means never refused — its cost is carried by whoever set the flag.",
            },
            chargeable: {
              type: "boolean",
              description:
                "Optional, default true. Whether this agent occupies a charged slot in the capacity count. False means it is reported as exempt and never charged.",
            },
            preemptable: {
              type: "boolean",
              description:
                "Optional, default true. Whether this agent may be stood down to make room for higher-priority work. chargeable: false with preemptable: true is refused as incoherent — standing down an uncharged agent frees no slot, so the preempt would admit a newcomer over the cap on a false premise.",
            },
            gateExempt: {
              type: "boolean",
              description:
                "Optional. Shorthand for refusable, chargeable and preemptable all false. Passing it alongside any of those three is refused rather than resolved: which one won would be a silent decision about whether this agent can be refused, charged or stood down.",
            },
          },
          required: ["path", "priority", "launcher"],
        },
      },
      {
        name: "crabcast_activate_agent",
        description:
          "Starts an agent that crabcast_configure_agent has already made exist. It takes NO attributes: everything the agent is comes from its record, so there is nothing here that could disagree with what it already is. Refused when the path was never configured, naming what is missing. Refused when the machine is at capacity — see crabcast_capacity — unless override or preempt is set; that refusal names what is running and what each one is worth, and carries a `preemption` block when this activation outranks one of them. REFUSED, ALWAYS, when a live pane that is not ours is already in that directory: the refusal names each one's pane_id, name and agent_status, and nothing is started. Refused as unverifiable when herdr does not answer at all, because an empty census from an unreachable herdr is silence rather than evidence that the directory is free. SAFE TO CALL AGAIN, as a contract rather than as a happy accident — a reconciler calls this on agents that are already exactly as asked for, constantly. Activating an agent that is already running is not an error: it answers `alreadyRunning: true` with `started: false` and the pane it is already in, starts no second pane, and does not touch the capacity gate, because an agent already running is already counted. Both fields are on EVERY successful response, true or false, so 'did this call start it' is read rather than inferred from a missing field. It also CONVERGES the durable record: if the record does not say this agent is running while its pane is live — which is what a failed registry write leaves behind — the repeat call writes the activation and says `recordReconciled: true`, so calling again is what repairs a `durable: false` rather than papering over it. What is NOT idempotent, deliberately: a live FOREIGN pane in the directory refuses every time. It is somebody else's agent, not this one already running.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            override: {
              type: "boolean",
              description:
                "Optional. Start the agent even when the machine is at capacity. The refusal it bypasses is recorded with the load and memory figures at the time. Use it deliberately, not reflexively: the cap exists because a human noticed the desktop had become unusable. It does NOT override the occupied-directory refusal, which is about somebody else's agent rather than about the machine.",
            },
            preempt: {
              type: "boolean",
              description:
                "Optional, and destructive. Make room by standing down the lowest-priority agent this activation STRICTLY outranks, rather than over-committing the machine as override does. Only strictly greater preempts — equal never does, so nothing can displace an agent of its own priority and nothing can displace the highest. The victim's uncommitted work is interrupted; it is recorded as preempted, reported by crabcast_list_agents until it is put back, and resumes its conversation when re-activated. Read the `preemption` block on the refusal first — it names exactly who would be stopped and what they are doing — and do not pass this without having decided that this work matters more than theirs.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "crabcast_deactivate_agent",
        description:
          "Stops the agent running in a directory. The record survives, so the agent still exists and can be activated again — use crabcast_forget_agent to remove it entirely. Never answers a bare success: `wasRunning` and `state` distinguish an agent this call stopped from one that was already down ('standby') and from one that was configured but never started ('unstarted'), because a caller polling for 'is it down' and a caller who mistyped a path deserve different answers. SAFE TO CALL AGAIN, as a contract: standing down something already down answers `success: true, wasRunning: false` rather than an error, writes no second stand-down row and broadcasts no second event, because a repeated row would say a decision was taken twice. Refuses a path that was never configured: reporting a stand-down for a path that never held an agent would be success about a world that does not exist.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
          },
          required: ["path"],
        },
      },
      {
        name: "crabcast_forget_agent",
        description:
          "Makes an agent stop existing: removes its record from the durable registry. REFUSES while an agent is running there, and there is deliberately no force flag — no call that is not named 'stop it' may terminate an agent as a side effect, and a force flag is that path with a label on it. Deactivate first, then forget: two calls leave two decisions in the append-only log instead of one flag nobody can audit. It also refuses when herdr cannot be reached and the record says the agent should be running, because silence is not evidence that nothing is there. On a path that was never configured it SUCCEEDS with existed: false — its postcondition is the absence of a record, and that already holds. It also UNDOES what CrabCast wrote outside its own data directory: the .mcp.json keys it added (deleting the file only if CrabCast created it and nothing else is left in it), the folder-trust entry in ~/.claude.json but ONLY if CrabCast added it rather than finding it already accepted, and CrabCast's own sidecar. It removes exactly what it recorded writing — a key edited since is left alone — and `removed` and `left` name both halves, the second with reasons. This deletes NO directory of yours: CrabCast does not create the directory an agent runs in and does not delete one, and nothing here removes anything recursively.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
          },
          required: ["path"],
        },
      },
      {
        name: "crabcast_send_to_agent",
        description:
          "Sends a message to a running agent's terminal as if a human typed it — interrupts any partially typed input, types the message, presses Enter — AND THEN READS THE PANE BACK TO SEE WHETHER THE AGENT ACTUALLY GOT IT. Use this to give a still-running agent new instructions (e.g. review feedback) without attaching to its terminal. READ `verdict`, NOT JUST `success`. It is on EVERY response, so what happened is read rather than inferred from a missing field. THREE OF ITS WORDS ARE DELIVERY VERDICTS, and each is a statement about a pane that was actually looked at: `delivered` — the message was seen in the agent's transcript as submitted output that was not there before, which is a claim about the agent rather than about our keystrokes; `not-delivered` — the pane was read and the message is not in it, so the agent does not have it (most often the Enter did not take and the text is sitting UNSUBMITTED in the composer, which is why a glance at the terminal shows the message and looks like success — `evidence.inComposer` says when that is what happened); `unverifiable` — the pane could not be read, so whether it landed is UNKNOWN. THE FOURTH WORD IS NOT A DELIVERY VERDICT: `refused` means the request never became a send at all — a path that does not resolve, or an empty message — so no pane was read and nothing was typed at anybody. `refused` names which, and it is a bug in the call rather than a fact about the agent. Treat the two middle ones differently, because they license opposite actions: resend on `not-delivered`; on `unverifiable` do NOT resend blindly and do NOT record the message as lost — read the agent with crabcast_tail_agent once herdr is answering and decide then. `evidence` carries what the verdict was read from — the pane tail, the before/after counts of this message as submitted output, and `interrupts`, which is never more than 1 because a second Ctrl+C is how Claude Code quits. THIS CALL INTERRUPTS THE RECIPIENT. Its first keystroke is a Ctrl+C, and if the agent is mid-tool-call that tool call is TERMINATED — a pane sent to while running a command is left reading `Interrupted · What should Claude do instead?`. That is the cost of typing at a running agent and there is no version of this that avoids it, so treat a send as disruptive and decide it is worth interrupting before you call. What is bounded is the retry, not the call: the retry only presses Enter again, so one call never interrupts twice — but a SECOND call is a second interrupt, which matters because the contract above tells you to resend on `not-delivered`. TWO LIMITS OF CONFIRMING BY PANE ECHO, disclosed rather than left to be discovered: (1) `delivered` means the text appeared as submitted output, which is NOT the same as arriving intact — two sends in quick succession can be submitted as a single concatenated line, and both correctly report `delivered` while the agent acts only on the first, so leave time between sends to the same agent rather than pipelining them; (2) the interrupt makes Claude Code restore its own in-flight prompt into the composer, and this call's text is appended after it, so a delivered message can arrive with the recipient's interrupted text in front of it.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            message: {
              type: "string",
              description: "The message to type into the agent's terminal",
            },
          },
          required: ["path", "message"],
        },
      },
      {
        name: "crabcast_tail_agent",
        description:
          "Reads the recent terminal output of an agent without attaching to it. Use this to find out what an agent is actually doing — or why it stopped — when its reported status alone is not enough.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
            lines: {
              type: "number",
              description: "Optional. How many trailing lines to return (default 40, max 200)",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "crabcast_agent_status",
        description:
          "Reports everything this daemon knows about ONE agent, by directory. Two halves, and the response says which is which in its `provenance` block. THE DURABLE HALF is the configuration frozen onto the agent's record and echoed back verbatim: `config` (priority, refusable, chargeable, preemptable, launcher, prompt, mcpServers, label), `configVersion` — a per-agent counter that increases on every accepted crabcast_configure_agent, so it is the token to compare when you want to know whether your view is current — and `configuredAt`. Read these rather than keeping your own copy of what you asked for: a second copy is the one that is wrong after somebody reconfigures. THE OBSERVED HALF was read from herdr for this call and is true only as of provenance.observedAt: paneId (never durable — herdr renumbers panes whenever any pane closes, so do not store one), herdrStatus, sessionId, createdAt, status, sessionless. `state` is the category: running, missing, standby, unstarted, preempted or unconfigured — the same word crabcast_list_agents puts the agent's row under. It SUCCEEDS for an agent that is configured and not running: `success: false` here means neither a record nor a pane exists, which is the only case that means you mistyped a path.",
        inputSchema: {
          type: "object",
          properties: {
            path: PATH_PROPERTY,
          },
          required: ["path"],
        },
      },
      {
        name: "crabcast_list_agents",
        description:
          "Lists every running agent, from herdr's view of what exists joined against the durable registry rather than the daemon's session map — so agents that outlived a daemon restart are still listed. Each entry carries sessionless: true when the daemon is not attached to it, in which case the session-only fields (sessionId, createdAt, status) are null. ALSO CHECK missingAgents: agents recorded as active that are not running at all — their work has silently stopped while still looking staffed, so treat a non-empty missingAgents as work that needs re-activating or deliberately standing down. ALSO CHECK preemptedAgents: agents stood down to free capacity for higher-priority work, listed until somebody puts them back. Their work was interrupted rather than finished, so whoever supervises each one owes it a decision: re-activate it (which resumes the conversation it was stopped in) or stand it down for good. standbyAgents is NOT a problem to fix: agents somebody switched off on purpose whose directory is still there, listed so they can be started again with crabcast_activate_agent. foreignPanes are live panes this daemon did not start; a row whose `occupies` is set is sitting in a directory you have configured, and activating that agent WILL be refused until it is gone. unstartedAgents are agents that exist and have NEVER run — configured, never activated. They are deliberately not standby, and the difference is behavioural rather than cosmetic: activating a standby agent resumes the conversation it was stopped in, while activating an unstarted one starts a fresh conversation from the prompt on its record. unbackedPanes are our own panes with nothing running behind them. EVERY ROW IN EVERY ONE OF THESE CATEGORIES carries the agent's frozen configuration read back from the durable record — `config`, `configVersion`, `configuredAt` and `everActivated` — so you never need to keep a shadow copy of what you asked for; compare `configVersion` to find out whether your view is current. (On a foreignPanes row that block is nested under `occupiedAgent`, because a foreign pane is not ours and has no configuration of its own — what is described there is the agent it is BLOCKING.) The response's `provenance` block names which fields are durable, which were observed from herdr just now, and which this daemon computed: paneId is observed and never durable, because herdr renumbers panes whenever any pane closes. All the clipped lists are newest-first and capped at 25 with an unclipped total alongside, so a total larger than its list means there are older entries this response did not carry.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
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

    if (name === "crabcast_configure_agent") {
      const { path, priority, launcher, prompt, mcpServers, label,
              refusable, chargeable, preemptable, gateExempt } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      // priority and launcher are NOT checked here, deliberately. The daemon
      // refuses a configure without them and its refusal names both fields and
      // says why each one has no default; a check here would be a second copy
      // of that rule with a worse message. The same holds for `provision`:
      // whether this consent is required, and for what, is the daemon's rule.
      const res = await callDaemonAPI('configure_agent', {
        path: agentPath(path), priority, launcher, prompt, mcpServers, label,
        refusable, chargeable, preemptable, gateExempt
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_activate_agent") {
      const { path, override, preempt } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      const res = await callDaemonAPI('activate_agent', {
        path: agentPath(path), override, preempt });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // Without it a failed activation arrives as ordinary text, which is
        // exactly how a caller ends up believing an agent exists that does not
        // — and, since the occupied-directory refusal lands here too, how one
        // ends up believing it started an agent that was refused.
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_deactivate_agent") {
      const { path } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      const res = await callDaemonAPI('deactivate_agent', { path: agentPath(path) });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // The extraction source left this one tool without the mapping. The
        // asymmetry is the same trap in mirror image: a failed deactivation
        // arriving as ordinary text is how a caller ends up believing an
        // agent is gone that is still running — and still holding its slot.
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_forget_agent") {
      const { path } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      const res = await callDaemonAPI('forget_agent', { path: agentPath(path) });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // A refused forget — the agent is still running, or herdr could not
        // say — must not read as a record that is gone.
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_send_to_agent") {
      const { path, message } = args as any;
      if (!path || !message) throw new Error("Missing required arguments: path, message");

      const res = await callDaemonAPI('send_to_agent', {
        path: agentPath(path), message });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_tail_agent") {
      const { path, lines } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      const res = await callDaemonAPI('tail_agent', {
        path: agentPath(path), lines });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        isError: res?.success === false,
      };
    }

    if (name === "crabcast_agent_status") {
      const { path } = args as any;
      if (!path) throw new Error("Missing required argument: path");

      const res = await callDaemonAPI('agent_status', { path: agentPath(path) });
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
        isError:
          res?.success === false ||
          (Array.isArray(res?.missingAgents) && res.missingAgents.length > 0) ||
          (Array.isArray(res?.preemptedAgents) && res.preemptedAgents.length > 0),
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
    // act on by re-listing the tools. `crabcast_reset_agent` is now exactly
    // that case: the verb is removed rather than redefined, so a caller still
    // using it gets a method-not-found by name instead of quietly getting
    // something else. The SDK serialises McpError into a JSON-RPC error with
    // its code, so rethrowing is all that is needed.
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
