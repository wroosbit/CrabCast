// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

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
import { EVENT_NAMES, projectEvent } from './events.js';

// The daemon's MCP server: stdio to its client, and an ordinary NDJSON client
// of the daemon's unix socket on the other side. One protocol on the socket,
// multiplexed by an explicit rule rather than by convention:
//
//   an `id` we are waiting on   → somebody's answer; resolve the request
//   an `id` we are NOT          → a late answer to a request that already timed
//                                 out; discarded, and said so as such
//   no `id`, an `action`        → a broadcast; forwarded as a structured MCP
//                                 notification when the event contract
//                                 (src/events.ts) names it, dropped with a
//                                 warning when it does not
//
// The middle rule is not a nicety. Correlation is by `id`, so "has no id" is
// what makes something a broadcast — and a late response routed into the
// forwarder gets reported as a broadcast that is not on the event contract,
// which is the wrong complaint about the wrong kind of message.

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

/**
 * THE FORWARDER. A positive allowlist and a structured payload, replacing a
 * suffix test and a rendered sentence.
 *
 * What was here before failed in both halves, and only one of them was
 * visible. The filter asked whether the action ended in `_event` — a
 * convention masquerading as a filter, which would have dropped every event
 * the moment the names changed, silently, on both sides. And the notification
 * carried `[CrabCast Event] <action> - <subject>`: prose. A subscriber could
 * read our broadcast over our shoulder and could not act on it, because there
 * was no structured payload on this path at all.
 *
 * Now:
 *
 *   - The allowlist is `EVENT_CONTRACT`, imported rather than restated. An
 *     action not on it is DROPPED and logged HERE, on our side of the
 *     boundary, so an event added to the daemon without being added to the
 *     contract is a warning naming it rather than a subscriber that quietly
 *     stops hearing about something.
 *   - The payload is the event, projected onto exactly the fields the contract
 *     publishes for it. That closes the `undefined/undefined` defect as a side
 *     effect rather than by special-casing: the contract knows which events
 *     carry `path` and which carry `what`, so nothing renders a field an event
 *     never had.
 *   - Drift is warned about in BOTH directions — a declared field the daemon
 *     did not send, and a field the daemon sent that nobody published. Either
 *     one means the document and the wire have come apart, and the whole point
 *     of this file is that they cannot do that quietly.
 *
 * The notification stays `notifications/message` because that is the transport
 * an MCP client already subscribes to; what changed is that `data` is the
 * event object rather than a sentence about it. `logger` names the stream so a
 * client can route these apart from anything else this server logs.
 */
function forwardEvent(msg: any) {
  const projected = projectEvent(msg);

  if (!projected) {
    // Dropped, and said out loud. This is the branch a future event lands in
    // when somebody adds a broadcast and forgets the contract — the daemon
    // warns on its side too, and this is the same fact from the subscriber's
    // side of the boundary.
    console.error(
      `crabcast-mcp: dropping a broadcast whose action is not on the event contract: ` +
      `${JSON.stringify(msg?.action)}. Nothing was forwarded to the MCP client. ` +
      `Published events: ${EVENT_NAMES.join(', ')}.`
    );
    return;
  }

  if (projected.missing.length) {
    console.error(
      `crabcast-mcp: ${msg.action} arrived without contract field(s) ` +
      `${projected.missing.join(', ')}; forwarded without them. This is the defect that ` +
      `used to render "undefined" at a subscriber — fix the emitting site or the contract.`
    );
  }
  if (projected.undeclared.length) {
    console.error(
      `crabcast-mcp: ${msg.action} carried undeclared field(s) ` +
      `${projected.undeclared.join(', ')}; NOT forwarded. A field on the wire that is not ` +
      `in docs/event-contract.md is an internal convention, which is what this contract ` +
      `replaced — declare it in src/events.ts or stop sending it.`
    );
  }

  server.notification({
    method: "notifications/message",
    params: {
      level: "info",
      logger: "crabcast.events",
      // The event itself. A rendered string here is the defect, not the format.
      data: projected.payload
    }
  }).catch(() => {});
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
          } else if (msg?.id !== undefined) {
            // AN ANSWER NOBODY IS WAITING FOR — carrying an `id` whose request
            // already timed out and was rejected. It is not a broadcast, and
            // the branch below must not be allowed to treat it as one: this
            // used to fall through to the forwarder, which dutifully reported
            // `dropping a broadcast whose action is not on the event contract:
            // "activate_response"`. That line names the wrong thing about the
            // wrong kind of message, and an operator reading it would go
            // looking for a missing event rather than for a slow daemon.
            console.error(
              `crabcast-mcp: late answer to a request that already timed out ` +
              `(${JSON.stringify(msg.action)}, id ${JSON.stringify(msg.id)}); discarded. ` +
              `The daemon answered after the 30s deadline.`
            );
          } else if (msg?.action !== undefined) {
            forwardEvent(msg);
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
      // WHICH AGENT IS CALLING, and it is live now: the router derives
      // `activatedBy` from it, so an agent that configures or activates another
      // agent is recorded as its supervisor of record.
      //
      // This was carried as dead weight when the seam was cut, on the reasoning
      // that the field would be needed later. Being carried is not the same as
      // being CONNECTED, and the gap between the two is where the customer's
      // own version of this feature spent a release: the field was on the wire,
      // correctly typed, and nothing ever set it, so every agent came back with
      // no parent and the whole feature was invisible while looking finished.
      // What closes it is the other end — `builtinMcpServer` bakes
      // CRABCAST_AGENT_PATH into the definition of the server this process IS,
      // per agent, at activation. Neither half proves the other: a check that
      // this line sends the variable says nothing about whether anything sets
      // it, which is why `verify-activated-by.mjs` §1 builds a real chain
      // end-to-end rather than asserting on either end alone.
      //
      // Absent when this server was not spawned inside an agent — a human's own
      // MCP client, a hand-run server — and absent is the honest answer there:
      // the daemon records no parent rather than inventing a plausible one.
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
          "Makes an agent exist, AND is how you change one that already does. An agent IS a directory plus the knobs you freeze onto it here — there are no workspace types to inherit from, so priority and launcher arrive in this call or nowhere, and activation refuses a path that was never configured. The directory must already exist; this never creates one, so a mistyped path is refused rather than scattered through your tree. It does NOT refuse an occupied directory: it succeeds and returns `occupiedBy` naming any live pane already in there, so you learn about the occupant now rather than when activation refuses. The intended day-one sequence when adopting directories that already have agents in them is: configure the fleet, stand your own panes down, then activate. It answers `configVersion` — 1 for a new agent, one higher than before for each accepted reconfiguration — which is the token every read echoes back, so a caller can tell whether the configuration it is looking at is the one it wrote. RECONFIGURING A RUNNING AGENT IS ANSWERED PER ATTRIBUTE, and this daemon will NEVER stand an agent down to make a configuration match. `priority`, `refusable`, `chargeable`, `preemptable`, `label` and `owner` change IN PLACE: they are read out of the record at the moment a capacity or preemption decision is made — or, for `owner`, at the moment a filtered list is answered — so the new value is live immediately, no pane is touched and no conversation is lost. (That `owner` is in-place has one consequence worth carrying: a filtered list is a SNAPSHOT, and an agent can move between owners between two polls.) `launcher`, `prompt` and `mcpServers` were consumed when the agent was spawned — the launcher IS the running process, the prompt has already been read, and .mcp.json is read once at boot — so changing one of those under a running agent is REFUSED (`refused: 'restart-required'`), naming each attribute and its reason, with the agent left running and untouched. The remedy is in the response and it is yours to take, not ours: crabcast_deactivate_agent, then this call, then crabcast_activate_agent. There is deliberately no force flag — a reconciler that quietly discards an agent's conversation to satisfy a config diff is the failure this rule exists to prevent, and a force flag is that path with a label on it. IT IS ALSO ATOMIC: a refused call applies NOTHING, including knobs that could have changed in place, because applying half of one desired-state document leaves an agent half-new and half-old, which no retry converges out of. So the response reports PER KNOB rather than a bare success — `outcomes` maps every attribute to one of `unchanged`, `applied`, `applied-in-place`, `refused-restart-required` or `withheld` (in-place-capable, not applied because the call was refused whole), alongside `changed`, `applied`, `withheld` and `attributes`. It is also refused as `unverifiable` when a restart-only knob is asked to move, herdr cannot be reached and the record says the agent is active: an empty census from an unreachable herdr is silence, not evidence that nothing is running there. THAT REFUSAL IS A *RE*CONFIGURATION'S, AND A FIRST CONFIGURE IS ANSWERED EVEN OVER A LIVE PANE. A path with no record yet has no prior configuration to preserve and no conversation being spent, so there is nothing for the refusal to protect — and refusing would strand the path, since activation requires a configure first. That state is reachable (a registry lost while herdr's panes survived, or a forget over an agent that kept running), so it is REPORTED rather than adopted quietly: the response carries `unrecordedPane`, naming the pane and saying that NOTHING was applied to the process running in it. The knobs you just froze are what the NEXT activation will use; they do not describe what is running there now, so they read `applied` and never `applied-in-place`. Note what that means for your next call: crabcast_activate_agent ADOPTS that pane rather than starting one, and would answer `alreadyRunning: true` over a configuration no process has ever read. Stand it down and activate again if you want an agent really running what you configured.",
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
            owner: {
              type: "string",
              description:
                "Optional. WHOSE AGENT THIS IS, in your own word for yourself, so that your application can find its own agents with crabcast_list_agents' `owner` filter instead of parsing agent names. IT IS NOT A PERMISSION BOUNDARY AND HIDES NOTHING — read this before anything else about it, because a field called `owner` reads like access control to nearly everybody who meets one. Any caller that can reach this daemon's socket can list EVERY agent on this machine, whatever its owner, simply by omitting the filter; that is deliberate and intended behaviour rather than a leak. The only auth boundary CrabCast has is the socket's own file permission (0600 in a 0700 directory). Setting an owner buys you a narrower QUESTION, never a smaller ANSWER, and a consumer that relies on filtering to conceal anything from anybody has a claim this mechanism does not support. OPAQUE, AND MATCHED EXACTLY: CrabCast compares it and never parses, splits, case-folds or namespaces it, and no value has any special meaning to this daemon — so `owner` is whatever string you already call yourself, and no format is expected or reserved. There is no prefix match, no glob and no hierarchy, because the first prefix match invites a namespace and a namespace is vocabulary CrabCast would then owe you compatibility on. OMITTING IT LEAVES THE AGENT UNOWNED, WHICH IS A REAL STATE AND NOT A WILDCARD: an unowned agent is matched by NO owner filter — not one for the empty string, not one for anything — and is reachable only by a read that passes no filter at all. Every agent configured before this field existed is in exactly that state. The empty string is REFUSED rather than stored, because it is what an unset variable looks like on the wire and storing it would make an agent no real filter can find. Like `label` it changes IN PLACE on a running agent, and like every other knob it is part of one desired-state document — so a later crabcast_configure_agent that omits `owner` REMOVES the owner rather than keeping it.",
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
          "Makes an agent stop existing: removes its record from the durable registry. REFUSES while an agent is running there, and there is deliberately no force flag — no call that is not named 'stop it' may terminate an agent as a side effect, and a force flag is that path with a label on it. Deactivate first, then forget: two calls leave two decisions in the append-only log instead of one flag nobody can audit. It also refuses when herdr cannot be reached and the record says the agent should be running, because silence is not evidence that nothing is there. On a path that was never configured it SUCCEEDS with existed: false — its postcondition is the absence of a record, and that already holds. It also UNDOES what CrabCast wrote outside its own data directory: the .mcp.json keys it added (deleting the file only if CrabCast created it and nothing else is left in it), the folder-trust entry in ~/.claude.json but ONLY if CrabCast added it rather than finding it already accepted, CrabCast's keys in the antigravity CLI's GLOBAL MCP config but ONLY when no other agy agent's record still claims them (that file is shared and has no per-agent equivalent, so a key still in use is LEFT and the response names the agent it is waiting on; a count that cannot be established — records unreadable — also leaves it, because an unremoved key is disclosed residue and a wrongly removed one silently breaks a running agent), and CrabCast's own sidecar. It removes exactly what it recorded writing — a key edited since is left alone — and `removed` and `left` name both halves, the second with reasons, including what a removal RESTED ON rather than only that it happened. This deletes NO directory of yours: CrabCast does not create the directory an agent runs in and does not delete one, and nothing here removes anything recursively.",
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
          "Sends a message to a running agent's terminal as if a human typed it — interrupts any partially typed input, types the message, presses Enter — AND THEN READS THE PANE BACK TO SEE WHETHER THE AGENT ACTUALLY GOT IT. Use this to give a still-running agent new instructions (e.g. review feedback) without attaching to its terminal. READ `verdict`, NOT JUST `success`. It is on EVERY response, so what happened is read rather than inferred from a missing field. THREE OF ITS WORDS ARE DELIVERY VERDICTS, and each is a statement about a pane that was actually looked at: `delivered` — the message was seen in the agent's transcript as submitted output that was not there before, which is a claim about the agent rather than about our keystrokes; `not-delivered` — the pane was read and the message is not in it, so the agent does not have it (most often the Enter did not take and the text is sitting UNSUBMITTED in the composer, which is why a glance at the terminal shows the message and looks like success — `evidence.inComposer` says when that is what happened); `unverifiable` — the pane could not be read, so whether it landed is UNKNOWN. THE FOURTH WORD IS NOT A DELIVERY VERDICT: `refused` means the request never became a send at all — a path that does not resolve, or an empty message — so no pane was read and nothing was typed at anybody. `refused` names which, and it is a bug in the call rather than a fact about the agent. Treat the two middle ones differently, because they license opposite actions: resend on `not-delivered`; on `unverifiable` do NOT resend blindly and do NOT record the message as lost — read the agent with crabcast_tail_agent once herdr is answering and decide then. `evidence` carries what the verdict was read from — the pane tail, the before/after counts of this message as submitted output, and `interrupts`, which is never more than 1 because a second Ctrl+C is how Claude Code quits. THIS CALL INTERRUPTS THE RECIPIENT. Its first keystroke is a Ctrl+C, and if the agent is mid-tool-call that tool call is TERMINATED — a pane sent to while running a command is left reading `Interrupted · What should Claude do instead?`. That is the cost of typing at a running agent and there is no version of this that avoids it, so treat a send as disruptive and decide it is worth interrupting before you call. What is bounded is the retry, not the call: the retry only presses Enter again, so one call never interrupts twice — but a SECOND call is a second interrupt, which matters because the contract above tells you to resend on `not-delivered`. TWO LIMITS OF CONFIRMING BY PANE ECHO, disclosed rather than left to be discovered: (1) `delivered` means the text appeared as submitted output, which is NOT the same as arriving intact — two sends in quick succession can be submitted as a single concatenated line, and both correctly report `delivered` while the agent acts only on the first. This is not theoretical: it bit CrabCast's own delivery proof in the pull request that documented it, concatenating a setup instruction with the message that depended on it. So leave time between sends to the same agent rather than pipelining them, and if something depends on the first having landed, wait for evidence of THAT rather than for this call's `delivered`; (2) the interrupt makes Claude Code restore its own in-flight prompt into the composer, and this call's text is appended after it, so a delivered message can arrive with the recipient's interrupted text in front of it.",
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
          "Reads the recent terminal output of an agent without attaching to it. Use this to find out what an agent is actually doing — or why it stopped — when its reported status alone is not enough. AN EMPTY ANSWER IS A REAL ANSWER, AND IT IS NOT THE SAME AS A FAILED READ: herdr is asked through more than one read source and `text` comes back empty only when EVERY source was asked and every one of them returned nothing, which is reported as `source: null` with `sourcesTried` listing them. `source` names which source answered when there was text. If the pane could not be read at all you get `success: false` with an error and NO claim about what is on the pane — do not read that as an idle agent. This distinction is load-bearing rather than cosmetic: one of herdr's sources returns \"\" for a pane that is alive and plainly has text on it (it windows the last N ROWS OF THE GRID, and the rows below a short pane's cursor are blank), so a single-source read once reported a working agent's terminal as blank.",
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
          "Reports everything this daemon knows about ONE agent, by directory. Two halves, and the response says which is which in its `provenance` block. THE DURABLE HALF is the configuration frozen onto the agent's record and echoed back verbatim: `config` (priority, refusable, chargeable, preemptable, launcher, prompt, mcpServers, label, owner — `owner` being who the configuring caller said this agent belongs to, which is filterable on crabcast_list_agents and is NOT a permission boundary), `configVersion` — a per-agent counter that increases on every accepted crabcast_configure_agent, so it is the token to compare when you want to know whether your view is current — and `configuredAt`. Read these rather than keeping your own copy of what you asked for: a second copy is the one that is wrong after somebody reconfigures. THE OBSERVED HALF was read from herdr for this call and is true only as of provenance.observedAt: paneId (never durable — herdr renumbers panes whenever any pane closes, so do not store one), herdrStatus, sessionId, createdAt, status, sessionless. `state` is the category: running, missing, standby, unstarted, preempted or unconfigured — the same word crabcast_list_agents puts the agent's row under. It SUCCEEDS for an agent that is configured and not running: `success: false` here means neither a record nor a pane exists, which is the only case that means you mistyped a path. `configEchoContract` says what the echoed `config` above is allowed to contain and what THIS response actually carried, and it is the same block on the same declaration that crabcast_list_agents carries — `declared` is every knob, `verbatim` names the one knob whose interior is deliberately not examined because it holds your own bytes (`mcpServers`), and `undeclared` names by path (e.g. `config.telemetry`) anything on this response that is not one of them. `drops` is FALSE here as it is there: an undeclared field is reported AND still delivered, where the event path drops what it names. `undeclared: []` means the sweep ran and found nothing; the block is on EVERY response including the refusals, so an absent block means an older daemon that never swept rather than a clean one. Do not key behaviour off an undeclared field — it has not been designed for you and can change or vanish.",
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
          "Lists every running agent, from herdr's view of what exists joined against the durable registry rather than the daemon's session map — so agents that outlived a daemon restart are still listed. Each entry carries sessionless: true when the daemon is not attached to it, in which case the session-only fields (sessionId, createdAt, status) are null. ALSO CHECK missingAgents: agents recorded as active that are not running at all — their work has silently stopped while still looking staffed, so treat a non-empty missingAgents as work that needs re-activating or deliberately standing down. ALSO CHECK preemptedAgents: agents stood down to free capacity for higher-priority work, listed until somebody puts them back. Their work was interrupted rather than finished, so whoever supervises each one owes it a decision: re-activate it (which resumes the conversation it was stopped in) or stand it down for good. standbyAgents is NOT a problem to fix: agents somebody switched off on purpose whose directory is still there, listed so they can be started again with crabcast_activate_agent. foreignPanes are live panes this daemon did not start; a row whose `occupies` is set is sitting in a directory you have configured, and activating that agent WILL be refused until it is gone. unstartedAgents are agents that exist and have NEVER run — configured, never activated. unreadableRecords is the one list here that is NOT agents: registry rows this daemon could not read, and therefore agents that are absent from every category above without being missing, standby or unstarted. Empty is the ordinary answer; non-empty means the fleet you are reading is short by that many rows and every other list is silent about it. Each carries `line`, `problem`, `reason`, `claimsPath` and the row's `raw` bytes; `unreadableRecordsTotal` is never clipped even though the list is bounded. Nothing has been deleted — repair the named line. They are deliberately not standby, and the difference is behavioural rather than cosmetic: activating a standby agent resumes the conversation it was stopped in, while activating an unstarted one starts a fresh conversation from the prompt on its record. unbackedPanes are our own panes with nothing running behind them. EVERY ROW IN EVERY ONE OF THESE CATEGORIES carries the agent's frozen configuration read back from the durable record — `config`, `configVersion`, `configuredAt` and `everActivated` — so you never need to keep a shadow copy of what you asked for; compare `configVersion` to find out whether your view is current. (On a foreignPanes row that block is nested under `occupiedAgent`, because a foreign pane is not ours and has no configuration of its own — what is described there is the agent it is BLOCKING.) EVERY ROW IN `agents` ALSO CARRIES `statusSince`: when THIS DAEMON first observed that agent in the `herdrStatus` beside it, or null. It is the one fact that separates an agent which has finished its work and is waiting for you from one that is wedged at a prompt nobody will answer — both report `herdrStatus: 'idle'` and nothing else in this response tells them apart. It is a FACT AND NOT A DIAGNOSIS: this daemon does not know what your runtime's dialogs mean and will never say 'stuck', so 'idle since four hours ago while my own records still show it mid-task' is a judgement YOU make out of this field and what you know about the work — and an agent quietly waiting on a human looks identical and is fine. It is NOT a heartbeat and NOT a liveness probe; it says nothing about health. `null` IS AN ANSWER, not a gap: it means this daemon has not watched that agent's status change, which is true of every agent on a freshly started daemon and of one whose status changed in the seconds between the last fleet sweep and this call. The value is held in memory by the daemon process and does NOT survive a restart — if you need a window longer than one daemon's life, keep your own, the same answer this daemon gives for down-time. AND THE RESTART WINDOW IS THE ONE YOU MOST WANT THIS FIELD IN, which is worth knowing before you rely on it: a daemon comes back at the same moment its fleet does — after a crash, a reboot, a power cut — and that is exactly when agents are sitting in states nobody watched them enter, so the field reads null across the whole fleet precisely in the window where the condition it exists to expose is most likely. That is not a gap waiting to be filled; it is what an in-memory observation IS (KAN-189: a value read back off disk would claim to have witnessed a change nobody watched), and it is why keeping your own record is the answer rather than a workaround. BUT THE NULL IS NOW READABLE, which is a different thing from being filled: this response carries `startedAt`, the moment THIS DAEMON'S PROCESS began, so you can tell the two cases apart instead of guessing between them. A fleet of nulls on a daemon that started ninety seconds ago means your observer is new — ignore the column and use your own record. The same page of nulls on a daemon that has been up for a day means the column is meaningful and nothing is moving. Those call for opposite responses and until KAN-214 nothing on this response separated them. `startedAt` bounds how long this daemon COULD have been watching; it is NOT a claim that the daemon is healthy, and it says nothing about whether any agent's status is meaningful. Rows in the not-running categories do not carry the field at all, because the observation is dropped as soon as an agent stops appearing in a census. The response's `provenance` block names which fields are durable, which were observed from herdr just now, which this daemon computed, and — a fourth bucket, `remembered` — which are this process's own accumulated observation held in memory: `statusSince` is the one, and it is deliberately not filed under `observed`, which promises a value read from herdr for THIS response. paneId is observed and never durable, because herdr renumbers panes whenever any pane closes. `configEchoContract` says what an echoed `config` is allowed to contain and what this response actually carried: `declared` is every knob, `undeclared` names by path (e.g. `standbyAgents[2].config.telemetry`) anything on THIS response that is not one of them, and `verbatim` names the one knob whose interior is deliberately not examined because it holds your own bytes (`mcpServers`). It is the same declaration the event notifications are projected against, so the two surfaces cannot disagree about what a config is — but the behaviours differ and `drops` says which you are reading: on this response `drops` is FALSE, so an undeclared field is reported AND still delivered, whereas the event path drops what it names. `undeclared: []` means the sweep ran and found nothing; the block is on every response, so an absent block means an older daemon that never swept rather than a clean one. Do not key behaviour off an undeclared field — it has not been designed for you and can change or vanish. THE FIVE LISTS missingAgents, preemptedAgents, standbyAgents, unstartedAgents and foreignPanes ARE PAGED, newest-first, 25 rows by default — so a default read of a large category leaves out the rows that have been waiting LONGEST, which for standby is the agent nobody has switched back on for a week. On a missingAgents row, `since` is when the agent was last recorded ACTIVATED and NOT when it went missing — nothing records that, and that is a settled decision rather than a gap waiting to be filled — so do not read the order of that category, or the age of a row in it, as how long the agent has been down. If you need down-time, keep the time of the first `agent.lost` you saw for a path, or of the first poll it appeared in, and drop it when the path leaves the category; that window is yours and this daemon does not keep one. Do not treat one response as the whole category: read `pages.<category>.nextCursor` and, when it is not null, call again with category set to that name and after set to that cursor, repeating until it comes back null. `pages.<category>` also carries returned, total, limit and remaining. `agents` and `unbackedPanes` are never paged and are always complete.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["missingAgents", "preemptedAgents", "standbyAgents", "unstartedAgents", "foreignPanes"],
              description:
                "Which paged category `after`/`limit` apply to. Omit for the ordinary fleet read, where every category returns its first page.",
            },
            after: {
              type: "string",
              description:
                "A `pages.<category>.nextCursor` from a previous call, to get the next page of that category. Opaque: pass it back unchanged rather than parsing it. An invented cursor is refused rather than answered from the beginning.",
            },
            limit: {
              type: "number",
              description:
                "Rows in that category's page, 1-200 (default 25). This is not how you get a whole category — follow nextCursor until it is null, whatever the page size.",
            },
            owner: {
              type: "string",
              description:
                "Optional. Return only agents whose crabcast_configure_agent `owner` is EXACTLY this string — how an application finds its own agents without parsing their names. THIS IS NOT A PERMISSION BOUNDARY AND HIDES NOTHING, which is the first thing to know about it: any caller that can reach this socket lists every agent on this machine by leaving this out, deliberately and by design, and the only auth boundary CrabCast has is the socket's own file permission (0600 in a 0700 directory). A filter is a narrower QUESTION, never a smaller ANSWER — do not build anything on the assumption that it conceals an agent from anybody. Matched EXACTLY: no prefix, no glob, no hierarchy, no case-folding, and no value means anything special to this daemon. AN AGENT WITH NO OWNER IS MATCHED BY NO FILTER. Absence is a real state and never a wildcard: every agent configured before `owner` existed, and every one configured since without it, is unowned, is returned by NO filtered read whatever you pass, and is reachable only by omitting this argument. That asymmetry is deliberate and it is the safety-critical half — if you are a reconciler whose last step is 'anything running that is not in my desired list → off', you MUST be able to tell 'not mine' from 'unknown to me', and a filter that silently matched the unowned would hand you other people's agents as candidates to stand down. WHAT IS AND IS NOT NARROWED, because a filtered response otherwise reads as a complete one: `agents`, `missingAgents`, `preemptedAgents`, `standbyAgents` and `unstartedAgents` are filtered, and their `*Total`s and `pages.<category>` counts describe the FILTERED set, so paging stays correct under it. `unbackedPanes` and `foreignPanes` are NOT — they have no record and therefore no owner — and neither are `priorities`, which is a fact about the machine rather than about you, nor `unreadableRecords`, which cannot be filtered because the row could not be parsed and may well be YOUR agent. The response carries an `ownerFilter` block naming all of that, present only when you pass this argument. Passing an explicit null is REFUSED rather than treated as no filter, because a null is what an unset variable serialises to and answering it with the whole fleet is how a reconciler ends up acting on agents that were never its own.",
            },
          },
          required: [],
        },
      },
      // LAST, and about the DAEMON rather than about an agent — which is why it
      // sits after the nine rather than beside `crabcast_capacity`, the other
      // call that asks about the machine. It is a MIRROR of the `daemon_status`
      // action the socket and the CLI have always had (KAN-227): same action,
      // same field names, same shapes, nothing subsetted and nothing renamed,
      // so there is exactly one `daemon_status` and now two ways to reach it.
      {
        name: "crabcast_daemon_status",
        description:
          "Answers WHICH CRABCAST IS RUNNING — the question no amount of looking at the filesystem can answer, because the filesystem is the thing that lies. A daemon started before a rebuild goes on executing the old `dist/` while the checkout on disk has moved on and looks perfectly current; every filesystem check reads healthy and the fleet misbehaves anyway. Only the process knows what it was loaded from, and this is where it says so. Ask it when a fleet is behaving in a way the code you are reading does not explain. `build` is what the RUNNING PROCESS was built from, read out of the `dist/` it actually loaded: `commit` (never abbreviated), `clean` (whether that checkout was clean AT BUILD TIME, which is not a claim about now), `builtAt`, `gitRoot`, `distDir`, `stampPath`, `stampPresent` and `stampUsable`. THOSE LAST TWO ARE NOT THE SAME QUESTION: a stamp that is present and NOT usable means there is a file sitting in that directory naming a commit which this daemon refused to believe — because `dist/` was rewritten under it without re-stamping (`tsc` run by hand does exactly this), or because it is a format this daemon does not read. A confidently wrong provenance is worse than an absent one, so it is demoted rather than reported. `freshness` compares that against what is on disk RIGHT NOW: `state` is one of `current`, `process-predates-build` (the daemon is not running the build on disk — restart it), `build-predates-sources` (the build is older than `src/` — rebuild, then restart) or `unknown`, with a `summary` sentence naming the remedy, plus `processIsCurrentBuild`, `sourcesNewerThanBuild` and `basis`. READ `basis`: `build-stamp` identifies the build, while `file-times` merely dates it and cannot tell 'nobody rebuilt this' from 'somebody rebuilt it and landed on the same newest mtime with the same file count'. `unknown` MAPS A FIELD NAME TO WHY IT IS NULL, everywhere on this response, and a non-empty `unknown` is NOT a clean bill of health — `state: 'unknown'` is deliberately not `current`, because a check that reports success when it could not run is worse than no check. WHAT THIS RESPONSE DOES NOT ESTABLISH, said plainly because the fields above read like a health check and are not one: a green `freshness` IS NOT A HEALTHY DAEMON. It says the running code matches the code on disk — nothing about whether that code is correct, whether the daemon can reach herdr, whether any agent is alive, or whether the fleet is doing what you asked. An agent that has silently stopped, a herdr that is not answering and a registry that failed to write all sit behind a `state: 'current'`. Use crabcast_list_agents for the fleet and crabcast_capacity for the machine; this call is about the process serving you and nothing else. `clean` is about build time and says nothing about your working tree now, and `commit` is what was BUILT, not what is checked out. It also carries the process facts: `pid`, `configPath`, `dataDir`, `registryPath`, `configuredAgents` (how many agents have records) and `expectedAgents` (how many of those records say activated — a COUNT OFF THE REGISTRY and not a census, so it is what SHOULD be running rather than what is; crabcast_list_agents' missingAgents is the difference). READ `unreadableRecordsTotal` BEFORE YOU BELIEVE THOSE TWO COUNTS: both are computed only from registry rows this daemon could PARSE, so a registry holding rows written by an older CrabCast reads `0 configured, 0 expected` — identical to an empty registry. When it is non-zero, `unreadableRecords` names each row: its `line` in the file, `problem` (`pre-migration`, `from-newer` or `unusable`), the `reason` naming what could not be read, `claimsPath` if it names a directory, and `raw`, the row's own bytes (a `prompt` is withheld and `promptRedacted` says so). THOSE AGENTS ARE NOT RUNNING AND NOTHING RESTORED THEM — but nothing was deleted either: the rows stay in the registry untouched and survive compaction, so a repair is editing the named line rather than discarding the file. The same two fields are on crabcast_list_agents. And `startedAt` and `bootId`, the same two fields crabcast_list_agents carries, from the same expression, so the two responses cannot disagree about when this daemon started. THE COST, because it is not free and this is where it is disclosed: `build` and `freshness` are recomputed on every call — two recursive directory walks, stat per file, over `dist/` and `src/` — which is why they are here, on a call somebody makes deliberately, rather than on the fleet read a poller hits continuously. Do not poll this.",
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
      const { category, after, limit, owner } = args as any;
      // The three arguments are one request field. `after`/`limit` without a
      // category are NOT silently dropped — a caller that meant to page and
      // forgot to say which category would otherwise get the default read back
      // and no sign that their cursor did nothing, which is the same silence
      // this paging exists to remove (KAN-163).
      if ((after !== undefined || limit !== undefined) && !category) {
        throw new Error(
          "`after` and `limit` apply to one category: pass `category` as well " +
          "(missingAgents, preemptedAgents, standbyAgents, unstartedAgents or foreignPanes)."
        );
      }
      // `owner` is INDEPENDENT of the three paging arguments and travels
      // whenever it was passed — including on a request that pages nothing.
      // Folding it into the `category ? …` branch above would have made a
      // filter silently do nothing unless the caller also happened to be
      // paging, which is the same class of silence KAN-163 removed.
      //
      // Sent only when the key was PRESENT, never as `owner: undefined`: the
      // daemon refuses an explicit null and reads an absent key as "no
      // filter", and those are the two answers this branch has to keep apart.
      const filter = owner !== undefined ? { owner } : {};
      const paging = category ? { pages: { [String(category)]: { after, limit } } } : {};
      const request = { ...paging, ...filter };
      const res = await callDaemonAPI('list_agents',
        Object.keys(request).length ? request : undefined);
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

    if (name === "crabcast_daemon_status") {
      // No arguments, and nothing between the caller and the action. Whatever
      // the daemon answers for `daemon_status` is what an MCP caller gets —
      // the same bytes a socket or CLI caller has always had. Anything this
      // branch selected, renamed or reshaped would make it a COPY of
      // `daemon_status` rather than a second way to reach the one there is,
      // and a copy is what goes stale (KAN-227). `verify-daemon-status-over-mcp`
      // asserts exactly that equality against a live daemon.
      const res = await callDaemonAPI('daemon_status');
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        // On `success: false` only. A daemon that is running a stale build
        // answered the question correctly, so `state: 'process-predates-build'`
        // is a true report and not a failed call — flagging it would tell a
        // caller their call broke when what it did was work.
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
