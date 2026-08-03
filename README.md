# CrabCast

CrabCast is standalone agent orchestration for terminal AI agents: one long-lived daemon per machine, a CLI, and a fleet UI, with capacity, priority, and honesty built in. The daemon spawns each agent in its own terminal pane with its own workspace directory, prompt, and MCP tools; refuses work the machine cannot carry, with figures the reader can reproduce; preempts by priority but never automatically; and reports the fleet honestly — including the agents that died, were stood down, or were preempted. CrabCast is a management layer only: it never embeds a terminal, and apps built on top of it may bring their own.

## Development setup

```bash
gh repo clone wroosbit/crabcast   # or: git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```

Requires Node.js 20+.

## The daemon

One long-lived daemon per machine, listening on a Unix socket (`<dataDir>/crabcast.sock`, newline-delimited JSON, id-correlated). Start it with:

```bash
npm run build
node dist/daemon.js [configPath]
```

The config path is the first CLI argument, else the `CRABCAST_CONFIG` environment variable, else `crabcast.config.json` in the current directory. `crabcast.config.json` declares an optional `dataDir` (default `~/.local/share/crabcast`; socket, logs, and workspaces live under it) and the workspace types:

```json
{
  "workspaceTypes": [
    {
      "name": "shell",
      "priority": 1,
      "promptFile": "prompts/shell.md",
      "defaultLauncher": "shell",
      "mcpServers": [],
      "gateExempt": false
    }
  ]
}
```

A type is data, not code — adding one is editing this file. Validation refuses rather than repairs: `priority` is required (a silently-defaulted priority would be preemptable by everything), and a type `name` must not contain a dash (agent names are `<prefix>-<type>-<key>`, split at the first dash after the prefix). `mcpServers` defaults to `[]` and `gateExempt` to `false`; `promptFile` paths resolve relative to the config file's directory.

Exactly one daemon owns the socket: a second daemon that finds a live socket exits 0; a stale socket file left by a crash is unlinked and reclaimed. `node scripts/daemon-status.mjs` round-trips a `daemon_status` request over the socket, and `node scripts/verify-config-and-socket.mjs` is the live proof of all of the above.
