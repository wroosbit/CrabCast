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

## The CLI

`crabcast` drives the daemon from a shell, so the system is complete with no browser anywhere. The package is `private: true` and has no install path yet, so it is invoked either as `node dist/cli.js …` after `npm run build`, or as `crabcast …` after `npm link` (which puts the `bin` entry on `PATH`).

```bash
npm run build
node dist/cli.js --help          # or: npm link && crabcast --help

crabcast activate shell demo     # start an agent  (--url, --agent, --override, --preempt)
crabcast list                    # the whole fleet, plus capacity
crabcast status demo             # one agent       (--type)
crabcast tail demo --lines 40    # its recent pane text, without attaching
crabcast send demo 'run the tests'
crabcast deactivate demo --type shell
crabcast reset shell demo        # stand down AND delete the workspace
crabcast capacity                # how many more this machine can carry, and why
```

The CLI is a client, not a second brain: it parses arguments, sends one action, and renders the answer. It never computes capacity, decides preemption, or infers whether an agent is alive — the daemon owns all of that. What it prints is what the daemon said, and a capacity derivation is printed **verbatim and unindented**, because the figures are the product.

* **`--json`** prints the daemon's response exactly as it arrived — every field, including the `id` the invocation used to correlate it. Nothing is dropped, renamed or reordered. Human-readable output is the default; anything the renderers do not recognise is printed anyway rather than swallowed.
* **Exit codes** are part of the contract: `0` success · `1` the daemon answered `success: false` (a capacity refusal lands here) · `2` usage error · `3` could not reach or spawn the daemon · `4` a config that was named would not load.
* **Config resolution** is `--config <path>`, else `$CRABCAST_CONFIG`, else `./crabcast.config.json` — the same rule the daemon and the MCP server use, from the same function. A config that was *named* and will not load is a refusal, never a silent fallback onto some other daemon.
* **Which commands start a daemon:** `activate`, `deactivate`, `reset` and `send` spawn one if none is running; `list`, `status`, `tail` and `capacity` do not, and exit `3` instead. Spawning the daemon runs its boot reconcile, which re-activates every agent the durable registry expects — a fleet-sized side effect nobody asked for by typing `crabcast list`.

`crabcast --help` is rendered from the command table exported by `src/cli.ts`, so every command it lists exists. `node scripts/verify-cli-refusal.mjs` is the live proof of the refusal, the exit codes, `--json`, and the `--override`/`--preempt` round trip.
