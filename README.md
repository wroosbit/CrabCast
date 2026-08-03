# CrabCast

CrabCast is standalone agent orchestration for terminal AI agents: one long-lived daemon per machine, a CLI, and a fleet UI, with capacity, priority, and honesty built in. The daemon spawns each agent in its own terminal pane with its own workspace directory, prompt, and MCP tools; refuses work the machine cannot carry, with figures the reader can reproduce; preempts by priority but never automatically; and reports the fleet honestly — including the agents that died, were stood down, or were preempted. CrabCast is a management layer only: it never embeds a terminal, and apps built on top of it may bring their own.

**What exists today:** the daemon and the CLI, which is the whole system — everything below is driveable from a shell with no browser anywhere. The fleet UI named above is designed but not built, and nothing in this README depends on it.

## Requirements

### Node.js 20+

Matches the `engines` field in `package.json`.

### herdr 0.6.4

**herdr is a hard prerequisite.** Every agent CrabCast starts is a herdr pane; with no `herdr` on `PATH`, every activation fails. herdr is a terminal workspace for running many shells at once — [`herdrdev/herdr`](https://github.com/herdrdev/herdr), Apache-2.0 (compatible with CrabCast's MIT), homepage <https://herdr.dev>.

**Install 0.6.4 specifically**, from that release's pinned assets:

```bash
# Pick the asset for your platform. Available for v0.6.4:
#   herdr-linux-x86_64   herdr-linux-aarch64   herdr-macos-x86_64   herdr-macos-aarch64
curl -fsSL -o herdr https://github.com/herdrdev/herdr/releases/download/v0.6.4/herdr-linux-x86_64
chmod +x herdr
mkdir -p ~/.local/bin && mv herdr ~/.local/bin/herdr    # or anywhere on PATH
herdr --version                                          # herdr 0.6.4
```

**0.6.4 is the version CrabCast is verified against — and "not 0.6.x" is not one situation but two.** They rest on different amounts of evidence, so they get different answers. The daemon draws the same three bands, checking the installed herdr at startup:

| herdr | what is known | what it rests on |
| --- | --- | --- |
| **0.6.x** | **Supported.** Every proof in this repository was produced on 0.6.4. | run, repeatedly |
| **0.7.x** | **A known break — do not use it.** 0.7.0 redesigned `agent start`: it no longer creates a pane but attaches an agent kind to an existing one (`--kind`/`--pane`), and it dropped `--cwd`, `--tab`, `--no-focus` and the trailing `-- <argv>`. CrabCast's spawn path passes all four, so **every activation fails** with `unknown option: --cwd`. | observed, on 0.7.5, on a clean machine |
| **0.8 and above** | **Untested — a genuine unknown.** Nobody has run CrabCast on it. It may well work; this is not a prediction that it will fail. | nothing, and that is the point |

**Install something other than 0.6.x and the daemon tells you which band you are in**, once, before the answer to whatever you typed. It reports rather than vetoes — it will not refuse to run for you — but on 0.7.x the activation itself still dies at herdr, so the notice is the warning and not a reprieve:

```
crabcast: note: herdr 0.7.5 is the line that redesigned 'agent start': it takes --kind/--pane and no longer accepts --cwd, which CrabCast's spawn path passes on every activation — so activations fail with 'unknown option: --cwd'. Observed on herdr 0.7.5, on a clean machine (KAN-33). Install a 0.6.x herdr (0.6.4 is the release CrabCast is verified against).
```

Adapting the spawn path to 0.7's API, and validating 0.8, are both planned after launch. Until then, pinning is what lets this README say only what it has actually seen.

**The pin is more friction than it should be, and pretending otherwise would waste your time.** Current herdr is 0.8.0, so `brew install herdr` — or any other "get the latest" route — gets you a version CrabCast has never been run against, and a route that happens to land on 0.7.x gets you one where nothing will start at all. Downloading a release asset, `chmod +x`, and putting it on `PATH` yourself is the price of being on the tested version, and there is no one-liner that does it.

**Do not run `npm install herdr`.** There is a package by that name on npm, at version `0.0.0`, published by an unrelated third party and self-described as a reserved name. It is not herdr, and installing it gets you nothing that CrabCast can use.

## Install

```bash
git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install        # installs dependencies AND compiles dist/
npm install -g .   # puts `crabcast` on PATH
cd ..              # from here on nothing needs the clone
crabcast --help    # every command it lists exists
```

**You never run a build step by hand.** `package.json` declares `"prepare": "tsc"`, and npm runs `prepare` as part of `npm install` — so the first command leaves you with a compiled `dist/`, and the second packs and installs it. `npm run build` exists, but it is for contributors iterating on the source, not a step in this sequence.

**Both commands are needed, in that order.** `npm install -g .` on a clone that has never had `npm install` run in it fails with `sh: 1: tsc: not found`: installing a directory globally does not install that directory's devDependencies, so `prepare` has no compiler to call. That is a real limitation of this install path rather than a step worth skipping.

**The package stays `"private": true` and is deliberately not published to npm.** That follows the project decision that there is no publish until there is something to publish, and `private` blocks only `npm publish` — installing from a directory, as above, is unaffected. The consequence for you is the `git clone` in the first line: there is no `npm install -g crabcast`, and any package by that name on the registry is not this one.

If you have previously run `npm link` from a CrabCast clone, remove that link first (`npm rm -g crabcast`). npm cannot replace the symlink a link leaves behind with a real directory, and the install fails with `ENOTDIR ... rename`.

## Walkthrough: CrabCast on a project that is not this one

A new project directory, no prior state: declare a workspace type, activate an agent, watch it, stand it down. Every command below is one that was run, and the output is what it printed; the long paths are the machine it was run on, and yours will be your own directory.

Five things worth knowing before reading it:

* **The first `activate` may be refused, and that is the system working rather than the walkthrough failing.** CrabCast asks whether this machine can carry another agent *before* it starts one, and on a machine already under load the answer is no. It happened to the first person who followed this document — refused at a load average of 2.99 against the 3.0 cores reserved for agents. The refusal names the binding constraint and shows every term it used; there is a worked example [below](#when-the-machine-is-full-activate-refuses). Two ways past it: wait for the machine to quieten and run the same command again, or pass `--override` to start the agent anyway and have the bypass recorded with the figures it bypassed. Waiting is the better answer on a machine you are also trying to use.

* **Nothing starts a daemon by hand.** `activate`, `deactivate`, `reset` and `send` spawn one when none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` refuse with exit 3 instead of starting a fleet nobody asked for. The first `crabcast list` below is that refusal, on purpose.
* **This config declares `"dataDir": ".crabcast"`**, which puts the socket, the log, the durable registry and the agents' workspaces inside the project directory, so the whole demo is removable with one `rm -rf`. Omit `dataDir` and CrabCast uses `~/.local/share/crabcast` instead.
* **The `notes` type below launches `shell`** — a bash prompt in a pane, and the launcher that keeps this walkthrough dependent on nothing but herdr. It is reachable only by asking for it by name. The other launchers in the table are `claude` and `anti-gravity`, and this walkthrough does not exercise them.
* **The `sleep 25` is in the sequence because it was needed**, and the reason is worth knowing before you think something is broken. `tail` asks herdr for the pane's *recent* output, and a freshly spawned pane is not readable straight away — measured on herdr 0.6.4, this one first returned text about 21 seconds after `activate`. Until then `tail` reports the pane as empty, which is honest (herdr read it and it was empty) but is not the pane. So the walkthrough gives the agent a long-running command and reads it mid-flight, which is what `tail` is for: watching without attaching.

```
$ mkdir -p /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/prompts

$ cd /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo

$ pwd
/home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo

$ cat > crabcast.config.json <<'EOF'
{
  "dataDir": ".crabcast",
  "workspaceTypes": [
    {
      "name": "notes",
      "priority": 1,
      "promptFile": "prompts/notes.md",
      "defaultLauncher": "shell",
      "mcpServers": [],
      "gateExempt": false
    }
  ]
}
EOF

$ cat > prompts/notes.md <<'EOF'
# Notes workspace {{KEY}}

You are working in the `notes` workspace `{{KEY}}`. If the caller supplied a
URL as metadata, it is: {{URL}}

Everything you do must stay inside this workspace directory — it is what gets
cleaned up when the workspace is reset.
EOF

$ crabcast list
crabcast: Could not reach the CrabCast daemon at /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/crabcast.sock: connect ENOENT /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/crabcast.sock
This command does not start a daemon (see `crabcast --help`). Run any of
  activate, deactivate, reset, send
and one is spawned if none is running. From a repository checkout you can also
run one in the foreground: node dist/daemon.js [configPath]
If one failed to start earlier, its stderr is in /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/daemon-spawn.err.
[exit 3]

$ crabcast activate notes demo
activated notes/demo
  session:       notes-demo-1785799631989 (active)
  workdir:       /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/workspaces/notes/demo
  created:       2026-08-03T23:27:11.990Z
  priority:      1
  verified:      true

$ crabcast list
agents (1)
  notes/demo  [unknown]  runtime (none reported)
    session notes-demo-1785799631989 (active), created 2026-08-03T23:27:11.990Z
    workdir /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/workspaces/notes/demo

missing agents (0)
  (none)

preempted agents (0)
  (none)

standby agents (0)
  (none)

capacity:
  1/3 charged agents, room for 1 more (4 cores, load 1.60, 6.2 GiB available; bound by load)
  cap 3 (bound by cpu) · running 1 · exempt 0 · headroom 1 (bound by load)
  reason: the load average is 1.60, against the 3.0 cores this machine leaves to agents
  cap terms: cpu allows 3, memory allows 20  ·  headroom terms: count allows 2, load allows 1, memory allows 6
  machine: 4 cores, load 1.6, 6395 MB available of 15737 MB
  agent cost: 650 MB (seed), 0.75 core (seed)

priorities — what an activation would have to strictly outrank:
  notes/demo  priority 1  [unknown]  crabcast-notes-demo

herdr health: 754/65536 open files (1%), room for about 12956 more panes (pid 875)

$ crabcast send --type notes demo 'for i in $(seq 1 40); do echo tick $i; sleep 1; done'
sent to demo — the message was typed into its terminal and Enter pressed

$ sleep 25

$ crabcast tail demo --type notes --lines 8
pane text for demo:
tick 20
tick 21
tick 22
tick 23
tick 24
tick 25
tick 26

$ crabcast status demo --type notes
notes/demo — unknown
  agent name:    crabcast-notes-demo
  session:       notes-demo-1785799631989
  status:        active
  created:       2026-08-03T23:27:11.990Z
  workdir:       /home/brooswit/.local/share/butchr/workspaces/task/kan-100/demo/.crabcast/workspaces/notes/demo

$ crabcast deactivate demo --type notes
deactivated notes/demo
  session:       notes-demo-1785799631989

$ crabcast list
agents (0)
  (none)

missing agents (0)
  (none)

preempted agents (0)
  (none)

standby agents (1) — switched off on purpose, workspace still on disk
  notes/demo — since 2026-08-03T23:27:38.018Z
    Switched off deliberately. Its workspace is still on disk, so switching it back on resumes the conversation it was stopped in rather than starting a new one.

capacity:
  0/3 charged agents, room for 1 more (4 cores, load 1.64, 6.6 GiB available; bound by load)
  cap 3 (bound by cpu) · running 0 · exempt 0 · headroom 1 (bound by load)
  reason: the load average is 1.64, against the 3.0 cores this machine leaves to agents
  cap terms: cpu allows 3, memory allows 20  ·  headroom terms: count allows 3, load allows 1, memory allows 6
  machine: 4 cores, load 1.64, 6770 MB available of 15737 MB
  agent cost: 650 MB (seed), 0.75 core (seed)

herdr health: 746/65536 open files (1%), room for about 12958 more panes (pid 875)

$ crabcast reset notes demo
reset notes/demo — workspace directory deleted
  agent closed:  false
  the agent's own complaint: agent target crabcast-notes-demo not found
```

Two lines in that session are worth reading twice, because both are CrabCast declining to round an answer up:

* **After `deactivate`, `list` reports the agent under `standby agents`, not as gone.** Being switched off deliberately and having died are different facts, and the workspace is still on disk — so the row says which one this is, and says the workspace is still there.
* **`reset` reports `agent closed: false` and quotes herdr's own complaint** (`agent target crabcast-notes-demo not found`). The pane was already closed by the `deactivate` on the line above, so there was nothing left to close. `reset`'s job — deleting the workspace directory — is done and it says so, and it still does not claim to have closed a pane it did not close. Run `reset` without a prior `deactivate` and it closes the pane itself.

### When the machine is full, `activate` refuses

A capacity refusal is a normal outcome, not a malfunction, and it is the same command with a different answer. This is a real refusal of that same `activate`, from that same directory, on a busier moment of the same machine:

```
$ crabcast activate notes demo
FAILED: activate notes/demo

Refusing to activate notes/demo: load too high — the load average is 3.41, against the 3.0 cores this machine leaves to agents.
machine: 4 cores, 15.4 GiB RAM (6.5 GiB available), load average 3.41
agent cost: 650 MB resident (seed), 0.75 core while active (seed)
  no live measurement; seed figures are the 2026-07-31 constants, not a measurement of this fleet
reserved for you: 1 core(s), 2.3 GiB
cap: 3 charged agents — CPU allows 3 ((4 cores − 1 reserved − 0.5 for herdr) ÷ 0.75 core/agent), memory allows 20 ((15.4 GiB − 2.3 GiB) ÷ 650 MB/agent); bound by cpu
running: 0 charged agent(s)
headroom: 0 more — count allows 3 (3 cap − 0 running), load allows 0 ((4 cores − 1 reserved − 3.41 load) ÷ 0.75), memory allows 6 ((6.5 GiB available − 2.3 GiB reserved) ÷ 650 MB); bound by load
Deactivate an agent to make room, or pass override: true to start it anyway (the override is recorded with these numbers).
```

Every term is reproducible by hand, and the headline names the *binding* constraint — here the load average, not the count and not memory. Wait for room, stand something down, or pass `--override` and have the bypass recorded with the figures it bypassed.

### Editing the config after the daemon is running

The daemon reads `crabcast.config.json` once, at boot. After adding or changing a workspace type, restart it: `crabcast daemon-status` reports the pid, `kill` it, and the next activating command spawns a fresh one that reads the new file.

There is no `crabcast daemon` that runs one in the foreground, and nothing above needed one. A config the daemon would refuse never reaches the daemon: the CLI loads it first and refuses with the reason, having attempted nothing.

```
$ crabcast --config bad.json activate my-notes demo
crabcast: refusing to run: workspace type "my-notes": "name" must not contain a dash — agent names are <prefix>-<type>-<key> and the type is recovered by splitting at the first dash, so a dashed type breaks addressing silently
exit=4
```

## The CLI

`crabcast` drives the daemon from a shell, so the system is complete with no browser anywhere.

```bash
crabcast activate notes demo     # start an agent  (--url, --agent, --override, --preempt)
crabcast list                    # the whole fleet, plus capacity
crabcast status demo --type notes
crabcast tail demo --lines 40    # its recent pane text, without attaching
crabcast send --type notes demo 'run the tests'
crabcast deactivate demo --type notes
crabcast reset notes demo        # stand down AND delete the workspace
crabcast capacity                # how many more this machine can carry, and why
crabcast daemon-status           # pid, uptime, the config it loaded, the types it knows
```

The CLI is a client, not a second brain: it parses arguments, sends one action, and renders the answer. It never computes capacity, decides preemption, or infers whether an agent is alive — the daemon owns all of that. What it prints is what the daemon said, and a capacity derivation is printed **verbatim and unindented**, because the figures are the product.

* **`--json`** prints the daemon's response exactly as it arrived — every field, including the `id` the invocation used to correlate it. Nothing is dropped, renamed or reordered. Human-readable output is the default; anything the renderers do not recognise is printed anyway rather than swallowed.
* **Exit codes** are part of the contract: `0` success · `1` the daemon answered `success: false` (a capacity refusal lands here) · `2` usage error · `3` could not reach or spawn the daemon · `4` a config that was named would not load.
* **Config resolution** is `--config <path>`, else `$CRABCAST_CONFIG`, else `./crabcast.config.json` — the same rule the daemon and the MCP server use, from the same function. A config that was *named* and will not load is a refusal, never a silent fallback onto some other daemon.
* **Which commands start a daemon:** `activate`, `deactivate`, `reset` and `send` spawn one if none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` do not, and exit `3` instead. Spawning the daemon runs its boot reconcile, which re-activates every agent the durable registry expects — a fleet-sized side effect nobody asked for by typing `crabcast list`.
* **Messages that start with a dash are messages.** Flag parsing stops where `send`'s `<message...>` begins, so `crabcast send demo --help` types the text `--help` into the agent rather than printing this help and sending nothing. Quoting does not help with a leading dash — the shell eats the quotes — which is why the rule is in the parser rather than in a note. The trade is that a flag written *after* the message is message text (`crabcast send demo hi --type shell` sends `hi --type shell`, and says so on stderr); put flags before the operands. `--` still ends flag parsing for the commands with no trailing message, e.g. `crabcast status -- -odd-key`.
* **Capacity arithmetic:** `capacity` and a refused `activate` carry the daemon's derivation and print it verbatim. `list_agents` ships no derivation, so `list` prints the same figures as numbers — the cap and headroom terms and the machine they were read off — rather than dropping them.

`crabcast --help` is rendered from the command table exported by `src/cli.ts`, so every command it lists exists. `node scripts/verify-cli-refusal.mjs` is the live proof of the refusal, the exit codes, `--json`, and the `--override`/`--preempt` round trip.

## The daemon

One long-lived daemon per machine, listening on a Unix socket (`<dataDir>/crabcast.sock`, newline-delimited JSON, id-correlated). Nothing needs to start it: the CLI spawns a detached one on first need. From a repository checkout it can also be run in the foreground:

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

A type is data, not code — adding one is editing this file. Validation refuses rather than repairs: `priority` is required (a silently-defaulted priority would be preemptable by everything), and a type `name` must not contain a dash (agent names are `<prefix>-<type>-<key>`, split at the first dash after the prefix). `mcpServers` defaults to `[]` and `gateExempt` to `false`; `promptFile` paths resolve relative to the config file's directory. A `dataDir` whose socket path would exceed 104 characters is refused too: a unix socket address is a fixed buffer and an over-long path is silently *truncated*, so the daemon would bind outside its own data directory, fail to chmod or unlink what it bound, and leave the next daemon reporting a stale socket file in a directory that is empty.

Exactly one daemon owns the socket: a second daemon that finds a live socket exits 0; a stale socket file left by a crash is unlinked and reclaimed. `node scripts/daemon-status.mjs` round-trips a `daemon_status` request over the socket, and `node scripts/verify-config-and-socket.mjs` is the live proof of all of the above.

## Development setup

```bash
gh repo clone wroosbit/crabcast   # or: git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install         # runs `prepare`, so this already builds dist/
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```

The verify scripts under `scripts/` are the live proofs of this daemon's behavioural invariants. The isolatable ones run in CI (the `verify` check) against a shimmed `herdr`; the rest need a real herdr and real panes and are run by hand, with their output going on the pull request. See the comments in `.github/workflows/ci.yml` for which are which and why.
