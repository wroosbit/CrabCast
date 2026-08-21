# CrabCast

CrabCast is standalone agent orchestration for terminal AI agents: one long-lived daemon per machine, a CLI, and a fleet UI, with capacity, priority, and honesty built in. The daemon spawns each agent in its own terminal pane, in a directory **you** already own; refuses work the machine cannot carry, with figures the reader can reproduce; preempts by priority but never automatically; and reports the fleet honestly — including the agents that died, were stood down, or were preempted. CrabCast is a management layer only: it never embeds a terminal, and apps built on top of it may bring their own.

**An agent is a directory plus a few knobs.** That is the whole addressing model. There are no workspace types, no keys and no names to remember: you `configure` a directory with what the agent should be worth and what should run in it, and from then on the directory's path *is* the address for every read and every verb. CrabCast never creates that directory and never deletes it — which is what lets it be your repository checkout rather than a scratch space CrabCast hands you.

**What exists today:** the daemon and the CLI, which is the whole system — everything below is driveable from a shell with no browser anywhere. The fleet UI named above is designed but not built, and nothing in this README depends on it.

## Requirements

### Node.js 20+

Matches the `engines` field in `package.json`.

### herdr 0.6.4

**herdr is a hard prerequisite.** Every agent CrabCast starts is a herdr pane; with no `herdr` on `PATH`, every activation fails. herdr is a terminal workspace for running many shells at once — [`herdrdev/herdr`](https://github.com/herdrdev/herdr), Apache-2.0 (compatible with CrabCast's MIT), homepage <https://herdr.dev>.

**Install 0.6.4 specifically**, from that release's pinned assets. Change the first line to your platform and paste the rest as it stands — on Linux or macOS this is the whole of it:

```bash
# Four assets exist for v0.6.4. Pick yours; nothing else in this block changes.
#   herdr-linux-x86_64     Linux, Intel/AMD
#   herdr-linux-aarch64    Linux, ARM
#   herdr-macos-x86_64     macOS, Intel
#   herdr-macos-aarch64    macOS, Apple silicon
ASSET=herdr-linux-x86_64

curl -fsSL -o herdr "https://github.com/herdrdev/herdr/releases/download/v0.6.4/$ASSET"
chmod +x herdr
mkdir -p ~/.local/bin && mv herdr ~/.local/bin/herdr    # or anywhere on PATH
herdr --version                                          # herdr 0.6.4
```

That last line is the check that matters, and it is worth actually reading rather than scrolling past: if it prints anything but `herdr 0.6.4`, another herdr is earlier on your `PATH`, and that one is what CrabCast will spawn into.

**Windows is not covered.** herdr publishes Windows binaries in preview builds only, so there is no stable asset to pin, and CrabCast has never been run there.

**The pin is more friction than it should be, and pretending otherwise would waste your time.** herdr's current release is 0.8.0 — which was run here and **starts nothing** (see the table below) — so `brew install herdr`, `herdr update`, or any other "get the latest" route lands you somewhere CrabCast cannot work. Downloading a release asset, `chmod +x`, and putting it on `PATH` yourself is the price of being on the tested version, and there is no one-liner that does it.

**Do not run `npm install herdr`.** The `herdr` package on npm is a **name reservation by the project's own author**, not an impostor. It sits at version `0.0.0`, describes itself as *"Reserved package name for Herdr, a terminal workspace manager for AI coding agents."*, and its sole maintainer is `ogulcancelik` — the account whose `github.com/ogulcancelik/herdr` now redirects to `herdrdev/herdr`, which is what GitHub does after a repository is transferred, and the URL the package's own `repository` field still names. So the rule is unchanged and the reason is not: there is **nothing in that package to install**. It ships two files and no binary. herdr reaches your machine as the release asset above or not at all.

### Which herdr releases have actually been run

**Four: 0.6.4 and 0.6.10, which work, and 0.7.5 and 0.8.0, which do not.** A version table is a claim about every release it covers, so this one names the releases somebody started a pane on, keeps the untried ones in a row of their own, and says in the right-hand column what each row rests on:

| herdr | what is known | what it rests on |
| --- | --- | --- |
| **0.6.4** | **Supported.** It is what the machine this project is developed on has installed, so every proof in `scripts/` that needs a *real* herdr — a live server, real panes — has only ever run against it. (The rest run in CI against a shim modelled on it, which is a statement about CrabCast and not about any herdr.) | run, repeatedly |
| **0.6.10** | **Run once, end to end, and it worked.** The top of the 0.6 line at the time of writing. | `node scripts/verify-herdr-release.mjs <0.6.10 binary> --expect supported`, 2026-08-05 (KAN-181): configure → activate → **herdr's own census** → status → tail → deactivate → forget, against a private 0.6.10 server |
| **0.6.0 – 0.6.3, 0.6.5 – 0.6.9** | **Untried.** Nine of the eleven releases in the 0.6 line. They exist, they download, nobody has started a pane on any of them. They are very likely fine — and "likely" is the entire content of this row. | nothing |
| **0.7.x** | **A known break — do not use it.** 0.7.0 redesigned `agent start`: it no longer creates a pane but attaches an agent kind to an existing one (`--kind`/`--pane`), and it dropped `--cwd`, `--tab`, `--no-focus` and the trailing `-- <argv>`. CrabCast's spawn path passes all four, so **every activation fails** with `unknown option: --cwd`. | observed on 0.7.5 on a clean machine (KAN-33), and reproduced by `verify-herdr-release.mjs … --expect spawn-broken` |
| **0.8.0** | **Broken the same way.** 0.8 kept the redesign: `herdr agent start` still takes `--kind`/`--pane` and still has no `--cwd`. Activation fails identically, and nothing is half-started. | run, 2026-08-05 (KAN-181), same script, `--expect spawn-broken` |
| **above 0.8.0** | **Untested.** Nobody has run one. Given the two above it is not a good bet, but that is a prior and not a finding. | nothing, and that is the point |

**The daemon draws the same bands, checking the installed herdr at startup**, and tells you which one you are in — once, before the answer to whatever you typed. It reports rather than vetoes: it will not refuse to run for you. On 0.7 and 0.8 the activation still dies at herdr, so the notice is the warning and not a reprieve:

```
crabcast: note: herdr 0.7.5 is the line that redesigned 'agent start': it takes --kind/--pane and no longer accepts --cwd, which CrabCast's spawn path passes on every activation — so activations fail with 'unknown option: --cwd'. Observed on herdr 0.7.5, on a clean machine (KAN-33). Install a 0.6.x herdr (0.6.4 is the release CrabCast is verified against).
```

```
crabcast: note: herdr 0.8.0 was RUN against CrabCast and every activation failed with 'unknown option: --cwd' — run on 2026-08-05 against a private server (KAN-181). 0.7 redesigned 'agent start' to attach a --kind to an existing --pane, dropping the --cwd this spawn path passes, and 0.8 kept that redesign. Install a 0.6.x herdr (0.6.4 and 0.6.10 are the releases CrabCast has been run against).
```

**The daemon is silent for every 0.6.x, including the nine nobody has run, and that is deliberate.** A notice fired at a user whose herdr is probably fine is the same overclaim pointing the other way, and a diagnostic that cries wolf for the supported configuration teaches people to ignore the one that matters. The place for "two of the eleven were run" is this table, where you are choosing a version — not a warning on every command after you have chosen.

**You can check any release yourself, without replacing the herdr you are using.** `scripts/verify-herdr-release.mjs` takes a downloaded binary and an expected verdict, runs it as a private server on its own socket, and drives a real CrabCast daemon through the lifecycle against it. It is how both new rows above were produced, and it is the honest way to add a third:

```bash
curl -fsSL -o /tmp/herdr-0.6.9 \
  https://github.com/herdrdev/herdr/releases/download/v0.6.9/herdr-linux-x86_64
chmod +x /tmp/herdr-0.6.9

# --expect is the verdict you are TESTING FOR, not one you are asserting.
# For an untried release, ask for `supported` and let it answer: green earns
# that release a row, and red earns it a different one.
node scripts/verify-herdr-release.mjs /tmp/herdr-0.6.9 --expect supported
```

It never writes to an installed herdr: the release under test is symlinked into a scratch directory, served by a private herdr server on its own socket, and the daemon it drives has its own data directory. The herdr running your own fleet is not touched, which is what makes checking 0.7 or 0.8 something you can just do.

#### Decision: CrabCast stays pinned to 0.6.x, and does not follow 0.7/0.8

This is a decision, not an omission, and it is recorded here rather than only in a ticket because this table is where a reader meets its consequences.

* **Following 0.7+ is not a flag change.** `agent start` was redesigned from "create a pane running this argv" into "attach one of a fixed list of agent kinds to a pane that already exists at a shell prompt". CrabCast's spawn path would have to create the pane, wait for its prompt, then attach — and `shell`, the launcher this README's walkthrough uses, is not one of the kinds 0.8 will attach at all. That is a slice with its own proofs, and it is not documentation work.
* **We have a verified, still-downloadable version.** v0.6.4 is published with all four platform assets and nothing in the 0.6 line has been yanked. Pinning costs a reader the block above; the alternative costs an unproven rewrite of the spawn path.
* **Being two minor versions behind a dependency that is pushed daily is a real risk, and pinning does not remove it — it makes it visible.** That is the trade, taken deliberately.

The migration is tracked as **KAN-182**. Until it lands, this page says only what has been run.

## Install

**[`docs/SETUP.md`](docs/SETUP.md) is the install document** — the same sequence as below, plus the config, a daemon that survives a reboot, the checks that say it is actually serving, how to point Butchr at it, and how to upgrade. This section is the short form for a reader who already knows the shape; that page is what to follow on a machine that has none of our state, and it says what breaks at each step when it is skipped.

```bash
git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install        # installs dependencies AND compiles dist/
npm install -g .   # puts `crabcast` on PATH
cd ..              # from here on nothing needs the clone
crabcast --help    # every command it lists exists
```

**You never run a build step by hand.** `package.json` declares `"prepare": "npm run build"` — `tsc`, then a `postbuild` step that writes `dist/build-stamp.json` so the daemon can say which build it is running (see [Which build is running](#which-build-is-running)) — and npm runs `prepare` as part of `npm install`. So the first command leaves you with a compiled, stamped `dist/`, and the second packs and installs it. `npm run build` exists, but it is for contributors iterating on the source, not a step in this sequence.

**Both commands are needed, in that order.** `npm install -g .` on a clone that has never had `npm install` run in it fails with `sh: 1: tsc: not found`: installing a directory globally does not install that directory's devDependencies, so `prepare` has no compiler to call. That is a real limitation of this install path rather than a step worth skipping.

**The package stays `"private": true` and is deliberately not published to npm.** That follows the project decision that there is no publish until there is something to publish, and `private` blocks only `npm publish` — installing from a directory, as above, is unaffected. The consequence for you is the `git clone` in the first line: there is no `npm install -g crabcast`, and any package by that name on the registry is not this one.

If you have previously run `npm link` from a CrabCast clone, remove that link first (`npm rm -g crabcast`). npm cannot replace the symlink a link leaves behind with a real directory, and the install fails with `ENOTDIR ... rename`.

## Walkthrough: CrabCast on a directory you already own

A directory with no prior CrabCast state: configure an agent into it, activate it, watch it, address it by path, stand it down, forget it. Every command below is one that was run and the output is what it printed; the paths are the machine it was run on, and yours will be your own.

Five things worth knowing before reading it:

* **The first `activate` may be refused, and that is the system working rather than the walkthrough failing.** CrabCast asks whether this machine can carry another agent *before* it starts one, and on a machine already under load the answer is no. The refusal names the binding constraint and shows every term it used; there is a worked example [below](#when-the-machine-is-full-activate-refuses). Two ways past it: wait for the machine to quieten and run the same command again, or pass `--override` to start the agent anyway and have the bypass recorded with the figures it bypassed. Waiting is the better answer on a machine you are also trying to use — **and this transcript is what the unrefused case looks like**: the machine it was captured on had room, so the `activate` below is the bare command, nothing was bypassed, and no derivation was printed because none was refused. The `capacity` block inside the `list` that follows is that machine's real arithmetic at the moment it ran, and those are the figures the gate had just used.
* **No client starts a daemon by hand.** `configure`, `activate`, `deactivate`, `forget` and `send` spawn one when none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` refuse with exit 3 instead of starting a fleet nobody asked for. The first `crabcast list` below is that refusal, on purpose. **This is a promise about clients, and it never covered the machine restarting** — after a reboot there is no client, so nothing spawns anything and the socket stays absent until somebody notices. Giving the daemon a supervisor is the part you do yourself: see [Surviving a reboot](#surviving-a-reboot).
* **This config declares `"dataDir": ".crabcast"`**, which puts the socket, the log, the durable registry and each agent's sidecar inside the project directory, so the whole demo is removable with one `rm -rf`. Omit `dataDir` and CrabCast uses `~/.local/share/crabcast` instead. Note what is *not* in there: the agent's working directory, which is yours.
* **`--launcher shell`** is a bash prompt in a pane, and the launcher that keeps this walkthrough dependent on nothing but herdr. It is reachable only by asking for it by name. The other launchers are `claude` and `anti-gravity`, and this walkthrough does not exercise them.
* **The prompt is finished text, not a template.** `--prompt-file` reads the file *in the CLI* and puts its bytes on the wire; CrabCast writes them into the agent's sidecar verbatim and never inspects them. The file below contains a literal `{{KEY}}` on purpose — watch it arrive at the pane unchanged.

```
$ mkdir -p /tmp/ac1-demo/notes && cd /tmp/ac1-demo

$ echo '{ "dataDir": ".crabcast" }' > crabcast.config.json

$ cat > prompt.txt <<'EOF'
You are a CrabCast agent working in the notes directory.

This prompt was rendered by the CALLER and handed to CrabCast as finished
text. CrabCast wrote these bytes verbatim and never looked at them — a literal
{{KEY}} would have survived unchanged.
EOF

$ crabcast list
crabcast: Could not reach the CrabCast daemon at /tmp/ac1-demo/.crabcast/crabcast.sock: connect ENOENT /tmp/ac1-demo/.crabcast/crabcast.sock
This command does not start a daemon (see `crabcast --help`). Run any of
  configure, activate, deactivate, forget, send
and one is spawned if none is running. To run one in the foreground — which is
what a supervisor such as systemd should own — run:
  crabcast daemon [--config <path>]
If one failed to start earlier, its stderr is in /tmp/ac1-demo/.crabcast/daemon-spawn.err.
[exit 3]

$ crabcast configure /tmp/ac1-demo/notes --priority 1 --launcher shell --prompt-file prompt.txt --label "the notes agent"
configured /tmp/ac1-demo/notes
  pane name:     crabcast-notes-31e31d1b7540dabf
  changed:       every knob — this call created the record
  version:       1, frozen 2026-08-05T13:01:25.211Z
  activated by:  none — no supervisor of record (you created it)
  priority:      1
  launcher:      shell
  gate:          refusable true, chargeable true, preemptable true
  prompt:        250 characters (written to the agent's sidecar verbatim)
  label:         the notes agent

per knob:
  priority     applied — takes effect at the next activate
  refusable    applied — takes effect at the next activate
  chargeable   applied — takes effect at the next activate
  preemptable  applied — takes effect at the next activate
  label        applied — takes effect at the next activate
  owner        applied — takes effect at the next activate
  launcher     applied — takes effect at the next activate
  prompt       applied — takes effect at the next activate
  mcpServers   applied — takes effect at the next activate
  args         applied — takes effect at the next activate

$ crabcast activate /tmp/ac1-demo/notes
activated /tmp/ac1-demo/notes
  session:       crabcast-notes-31e31d1b7540dabf-1785934891515 (active)
  pane:          crabcast-notes-31e31d1b7540dabf (w65702dcc803d94-10)
  created:       2026-08-05T13:01:31.515Z
  priority:      1
  launcher:      shell
  config v1 frozen 2026-08-05T13:01:25.211Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
  prompt: 250 characters
  label: the notes agent
  next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
  activated by: none — no supervisor of record (nothing identified activated it)
  verified:      true
  conversation:  started a NEW one — CrabCast has not run an agent in this directory before, so nothing on disk here was continued

other fields in the daemon's response:
  promptChars: 250
  channelEnabled: false

$ crabcast list
agents (1)
  /tmp/ac1-demo/notes  [unknown]  runtime (none reported)
    session crabcast-notes-31e31d1b7540dabf-1785934891515 (active), created 2026-08-05T13:01:31.515Z
    pane crabcast-notes-31e31d1b7540dabf (w65702dcc803d94-10)
    [unknown] since: not observed — this daemon has not seen this agent's status change (it is null after a restart)
    config v1 frozen 2026-08-05T13:01:25.211Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
    prompt: 250 characters
    label: the notes agent
    next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
    activated by: none — no supervisor of record (nothing identified activated it)

foreign panes (5) — live agents this daemon did not start
  butchr-task-kan-39 [done]  runtime claude  pane_id w65702dcc803d94-8
    cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-39
  butchr-task-kan-139 [working]  runtime claude  pane_id w65702dcc803d94-9
    cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-139
  butchr-story-kan-103 [done]  runtime claude  pane_id w65702dcc803d94-7
    cwd /home/brooswit/.local/share/butchr/workspaces/story/kan-103
  butchr-epic-kan-59 [done]  runtime claude  pane_id w65702dcc803d94-6
    cwd /home/brooswit/.local/share/butchr/workspaces/epic/kan-59
  butchr-epic-kan-39 [done]  runtime claude  pane_id w65702dcc803d94-5
    cwd /home/brooswit/.local/share/butchr/workspaces/epic/kan-39

missing agents (0)
  (none)

preempted agents (0)
  (none)

standby agents (0)
  (none)

unstarted agents (0)
  (none)

where these fields came from — read at 2026-08-05T13:01:36.686Z
  durable  (from the registry, survives a restart): path, config, configVersion, configuredAt, everActivated, activatedBy, configured, promptChars, label, refusable, chargeable, preemptable, launcher, priority, since, at, wasPreempted, by, derivation, herdrStatusWhenPreempted, occupiedAgent, identity, raw, claimsPath, claimsAt, claimsEvent
  observed (read from herdr just now):              paneId, herdrStatus, agentRuntime, status, sessionId, createdAt, sessionless, workDir, occupiedBy
  derived  (computed from the two):                 paneName, state, occupies, reason, line, problem, rawTruncated, promptRedacted, standing
  remembered (this daemon's memory, not durable):   statusSince

config echo: every knob echoed on this response is declared (priority, refusable, chargeable, preemptable, launcher, args, prompt, mcpServers, label, owner)

capacity:
  1/3 charged agents, room for 2 more (4 cores, load 1.47, 9.5 GiB available; bound by cap)
  cap 3 (bound by cpu) · running 1 · exempt 0 · headroom 2 (bound by cap)
  reason: 1 charged agent is already running against a cap of 3
  cap terms: cpu allows 2500, memory allows 13376  ·  headroom terms: count allows 2, cpu allows 1698, load would allow 1570 (reported only), memory allows 6895
  io/memory stall: 0% io (worst of /proc/pressure io and memory, `full avg10`) against a 50% threshold — under, so it does not bind
  machine: 4 cores, 1.3 in use over 3s to 2026-08-07T22:47:54.292Z, load 1.43, 9256 MB available of 15737 MB
  agent cost: 800 MB (seed), 0.75 core (seed)
  starts in flight: 1 of 1 charged against the CPU window, costing 0 core(s)
    1 of 1 start(s) began after the CPU window opened at 2026-08-11T15:40:52.657Z (3s, closed 2026-08-11T15:40:55.658Z), so the 1.86 cores it observed cannot contain 1 agent(s) of work — weighted by the share of the window each was absent for, and charged 1 × 0.001 core/agent = 0 cores

priorities — what an activation would have to strictly outrank:
  /tmp/ac1-demo/notes  priority 1  [unknown]

herdr health: 724/65536 open files (1%), room for about 12962 more panes (pid 844)

other fields in the daemon's response:
  bootId: 6e3b7c3a-8f0a-45b1-be63-29f2fddd2425
  eventSeq: 2
  startedAt: 2026-08-07T22:47:51.104Z

$ crabcast status /tmp/ac1-demo/notes
/tmp/ac1-demo/notes — unknown
  state:         running
  pane name:     crabcast-notes-31e31d1b7540dabf
  pane id:       w65702dcc803d94-10
  configured:    true
  config v1 frozen 2026-08-05T13:01:25.211Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
  prompt: 250 characters
  label: the notes agent
  next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
  activated by: none — no supervisor of record (nothing identified activated it)
  session:       crabcast-notes-31e31d1b7540dabf-1785934891515
  status:        active
  created:       2026-08-05T13:01:31.515Z

where these fields came from — read at 2026-08-05T13:01:42.798Z
  durable  (from the registry, survives a restart): path, config, configVersion, configuredAt, everActivated, activatedBy, configured, promptChars, label, refusable, chargeable, preemptable, launcher, priority, since, at, wasPreempted, by, derivation, herdrStatusWhenPreempted, occupiedAgent, identity, raw, claimsPath, claimsAt, claimsEvent
  observed (read from herdr just now):              paneId, herdrStatus, agentRuntime, status, sessionId, createdAt, sessionless, workDir, occupiedBy
  derived  (computed from the two):                 paneName, state, occupies, reason, line, problem, rawTruncated, promptRedacted, standing
  remembered (this daemon's memory, not durable):   statusSince

config echo: every knob echoed on this response is declared (priority, refusable, chargeable, preemptable, launcher, args, prompt, mcpServers, label, owner)

other fields in the daemon's response:
  promptChars: 250
  channelEnabled: false

$ crabcast send /tmp/ac1-demo/notes cat /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf/prompt.md
delivered to /tmp/ac1-demo/notes — the message was seen in its transcript as submitted output
  read from:     2 pane read(s) over 174ms; submitted copies 0 → 1
  keystrokes:    1 interrupt (Ctrl+C), 1 submit (Enter)
  pane the verdict was read from:
    Please read and follow the instructions in /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf/prompt.md to begin.
    brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/ac1-demo/notes$ ^C
    brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/ac1-demo/notes$ cat /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf/prompt.md
    You are a CrabCast agent working in the notes directory.

    This prompt was rendered by the CALLER and handed to CrabCast as finished
    text. CrabCast wrote these bytes verbatim and never looked at them — a literal
    {{KEY}} would have survived unchanged.
    brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/ac1-demo/notes$

$ crabcast tail /tmp/ac1-demo/notes --lines 20
pane text for /tmp/ac1-demo/notes (read from herdr's `recent-unwrapped`):
bcast/agents/31e31d1b7540dabf/prompt.md
You are a CrabCast agent working in the notes directory.

This prompt was rendered by the CALLER and handed to CrabCast as finished
text. CrabCast wrote these bytes verbatim and never looked at them — a literal
{{KEY}} would have survived unchanged.
brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/ac1-demo/notes$

$ crabcast deactivate /tmp/ac1-demo/notes
deactivated /tmp/ac1-demo/notes — now standby
  pane:          crabcast-notes-31e31d1b7540dabf
  session:       crabcast-notes-31e31d1b7540dabf-1785934891515

$ crabcast forget /tmp/ac1-demo/notes
forgot /tmp/ac1-demo/notes
  removed:       record, /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf (CrabCast's own sidecar: the rendered prompt and this record)

The record is gone and so is everything CrabCast wrote outside its own data directory that it could account for. /tmp/ac1-demo/notes itself was NOT touched: CrabCast never created it — `configure` may not `mkdir` — so it never deletes it, and nothing here removes anything recursively.

$ ls -a /tmp/ac1-demo/notes
.  ..

$ ls -a /tmp/ac1-demo/.crabcast/agents
.  ..
```

Six things in that session are worth reading twice, because each is CrabCast declining to round an answer up:

* **`configure` and `activate` are two verbs, and `activate` takes no attributes.** Everything the agent *is* lives on its record, so there is nothing an activation could pass that might disagree with it — and `activate` on a directory nobody configured refuses, naming what is missing, rather than inventing a priority and a launcher.
* **`list` reports five `foreign panes`** — live agents this daemon did not start, which on this machine are an unrelated fleet that happened to be running. They used to be invisible: "one of ours" was a pane name that started with `crabcast-`, so anything else was silently dropped. It is now a question the durable registry answers, and a foreign pane sitting in a directory you have configured is the thing that will make your next `activate` refuse. Better to see it coming.
* **The literal `{{KEY}}` reached the pane unchanged.** There is no interpolator. Render your prompt however you like — conditionals, loops, your own syntax — and hand over the result; CrabCast never looks at the bytes.
* **After the whole lifecycle, `/tmp/ac1-demo/notes` is empty.** Not "tidied up": nothing was ever written into it. The prompt went to the sidecar, this agent asked for no MCP servers so no `.mcp.json` was written, and `forget` removed the record and CrabCast's own sidecar — naming both rather than deleting quietly. The directory itself was never touched: CrabCast did not create it, so it does not delete it. [`docs/callers-directory.md`](docs/callers-directory.md) is the whole of what can appear in a directory you own, and how each of it comes back out.
* **`activate` says which conversation the agent got.** `started a NEW one` is CrabCast declining to resume whatever Claude Code history happens to sit at that path — because at a directory you own, that history is very often *yours*. It resumes only where its own record shows it ran before. The `next activate:` line just above it is the other half of the same sentence: *this* activation started a new conversation, which is precisely what makes the *following* one a resume.
* **Every state read echoes the configuration it is reporting on, and says where each field came from.** `activate`, `list` and `status` all print the same `config vN frozen <time>` line — the knobs as frozen, and the version they were frozen at — so a caller never has to infer what an agent is running with from what it last asked for. The fleet categories below it (`missing`, `preempted`, `standby`, `unstarted`) print **at zero**, because a heading that appears only when it is non-empty makes an empty answer and an unasked question look the same. And the `where these fields came from` legend splits every field three ways: durable (from the registry, survives a restart), observed (read off herdr just now), derived (computed from the two). A reader who wants to know which half of a row would survive the daemon dying has it on the page rather than in the source.

### When the directory is already occupied, `activate` refuses

Two agents in one directory is how work gets overwritten with neither of them finding out, so `activate` checks the directory before it spawns — and the check is a *separate question* from "is this pane ours". A freshly-configured agent has no pane recorded yet, so "not ours" is true of every pane in the world; reading that as "nothing is there" is exactly the bug this guard exists for.

This is a real refusal against a live agent from an unrelated fleet on the same machine — a `claude` runtime herdr reports in its own census, which CrabCast did not start and does not touch:

```
$ crabcast configure /home/brooswit/.local/share/butchr/workspaces/task/kan-39 --priority 1 --launcher shell
configured /home/brooswit/.local/share/butchr/workspaces/task/kan-39
  pane name:     crabcast-kan-39-7df1fd9dcf55944e
  changed:       every knob — this call created the record
  version:       1, frozen 2026-08-05T14:49:48.140Z
  activated by:  none — no supervisor of record (you created it)
  priority:      1
  launcher:      shell
  gate:          refusable true, chargeable true, preemptable true

live panes already in that directory (1):
  pane_id w65702dcc803d94-8  name butchr-task-kan-39  [done]  cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-39

per knob:
  priority     applied — takes effect at the next activate
  refusable    applied — takes effect at the next activate
  chargeable   applied — takes effect at the next activate
  preemptable  applied — takes effect at the next activate
  label        applied — takes effect at the next activate
  owner        applied — takes effect at the next activate
  launcher     applied — takes effect at the next activate
  prompt       applied — takes effect at the next activate
  mcpServers   applied — takes effect at the next activate
  args         applied — takes effect at the next activate

Something is already running in /home/brooswit/.local/share/butchr/workspaces/task/kan-39. The record is written, but activate will REFUSE until that pane is gone — stand it down, then activate.

$ crabcast activate /home/brooswit/.local/share/butchr/workspaces/task/kan-39
FAILED: activate /home/brooswit/.local/share/butchr/workspaces/task/kan-39

Refusing to activate /home/brooswit/.local/share/butchr/workspaces/task/kan-39: 1 live pane(s) are already running in that directory and none of them is ours.
  pane_id w65702dcc803d94-8, name 'butchr-task-kan-39', agent_status done, cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-39
NOTHING WAS STARTED. Two agents in one directory is how work gets overwritten and neither of them finds out. Stop the pane above, or point CrabCast at a different directory. This is not a claim on that pane: CrabCast never closes a pane it did not start.
  refused by:    occupied
  started:       false — NOTHING was spawned
  verified:      false — the daemon could not confirm the agent exists

live panes already in that directory (1):
  pane_id w65702dcc803d94-8  name butchr-task-kan-39  [done]  cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-39
[exit 1]
```

**`verified: false` there is not a second failure.** Nothing was spawned, so there is no agent of ours to confirm. Note also what the response does *not* carry: no `alreadyRunning`, in either direction. This branch found a pane that is **not** ours, so it established nothing about whether our agent is running — `true` would be the swallow that turns a safety refusal into a silent success, and `false` would claim a look that never happened.

**`configure` reports the occupant; only `activate` refuses on it.** That asymmetry is deliberate and load-bearing: adopting a fleet of directories that already have agents in them means configuring them all, standing your own panes down, then activating. A `configure` that inherited the guard would fail every call on day one and make the required ordering undiscoverable.

**There is a third answer, and it is the one that would otherwise fail silently.** If herdr does not answer at all, the census comes back empty — which looks identical to "the directory is free". `activate` refuses that too, as *unverifiable*, and starts nothing: a check that renders its own failure as an all-clear would spawn into an occupied directory precisely when it cannot see it.

### Changing an agent's knobs never costs it its conversation

A supervisor that holds desired state will eventually find a configuration that differs from ours, and "if they differ, change them" needs an answer. **The answer is not uniform across attributes,** because the attributes are not the same kind of thing:

| attribute | on a **running** agent | why |
| --- | --- | --- |
| `priority` | **in place** | read out of the record at the moment a capacity or preemption decision is made |
| `refusable` / `chargeable` / `preemptable` | **in place** | census arithmetic only; nothing in the pane sees them |
| `label` | **in place** | nothing parses it |
| `owner` | **in place** | read out of the record when a filtered `list` is answered; nothing in the pane sees it. The consequence is that a filtered list is a **snapshot** — an agent can move between owners between two polls |
| `launcher` | **refused** | it *is* the process running in the pane, resolved once at spawn |
| `prompt` | **refused** | written into the sidecar and handed over at spawn; the agent has already read it |
| `mcpServers` | **refused** | written into `.mcp.json`, which the runtime reads once, at boot |

On a **stopped** agent every attribute changes freely and takes effect at the next `activate`.

**In place means a decision changes, not that a field changes.** Here the machine is at a cap of one, and `beta` at priority 2 outranks the running `alpha` at priority 1 — so the gate offers `alpha` as a victim:

```
$ crabcast activate /tmp/kan126-live/owned/beta
Standing down /tmp/kan126-live/owned/alpha (priority 1, unknown) would make room: this activation is priority 2, which outranks it. That is not done automatically — pass preempt: true to authorise it, and its uncommitted work is interrupted.

$ crabcast configure /tmp/kan126-live/owned/alpha --priority 9 --launcher shell --prompt-file alpha-prompt.txt --label "the live agent"
reconfigured /tmp/kan126-live/owned/alpha
  changed:       priority — IN PLACE, on the running agent
  pane:          w65702dcc803d94-12
  version:       2 (was 1), frozen 2026-08-04T13:15:34.623Z

per knob:
  priority     APPLIED IN PLACE — live now, nothing was respawned
  refusable    unchanged — the value sent is the value it already had
  …
  mcpServers   unchanged — the value sent is the value it already had

$ crabcast activate /tmp/kan126-live/owned/beta          # the SAME call, nothing respawned
Nothing running is below priority 2, so there is nothing this activation may stand down. Running: /tmp/kan126-live/owned/alpha (priority 9, unknown). Preemption is strictly-greater: an agent may not displace one of its own priority.
```

Same pane, same session, and the gate's arithmetic changed underneath it.

**Where a respawn would be required, the API refuses and the caller decides.** It never stands an agent down to make configuration match — a reconciler that quietly discards conversation history to satisfy a config diff is the worst bug this design could have, and an honest *"cannot change X in place"* is worth more than a convenient one that costs an agent's memory:

```
$ crabcast configure /tmp/kan126-live/owned/alpha --priority 9 --launcher shell --prompt-file other-prompt.txt --label "the live agent"
FAILED: configure /tmp/kan126-live/owned/alpha

Refusing to reconfigure /tmp/kan126-live/owned/alpha: one attribute cannot change under a running agent, and standing it down to make it take effect would cost this agent its conversation.
  prompt — the prompt is written into the agent's sidecar and handed to it at spawn. The agent running there has already read it, so rewriting it now would change the record without changing the agent.
NOTHING WAS APPLIED. The agent is untouched and still running in pane w65702dcc803d94-12, and its configuration is still version 2.
Remedy: deactivate(…); configure(…, …); activate(…). There is no force flag, deliberately — one would be this destroy-and-recreate with a label on it, and the decision to spend a conversation is the caller's.
  refused:       restart-required
  attributes:    prompt
  applied:       nothing — configure is all-or-nothing
  version:       2 — unchanged, because nothing was applied
[exit 1]

$ crabcast send /tmp/kan126-live/owned/alpha "echo I-SURVIVED-THE-REFUSED-RECONFIGURATION"
$ crabcast tail /tmp/kan126-live/owned/alpha --lines 12
pane text for /tmp/kan126-live/owned/alpha:
I-SURVIVED-THE-REFUSED-RECONFIGURATION
brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/kan126-live/owned/alpha$
```

**The refusal is a *re*configuration's, and a *first* `configure` is answered even when a pane is live.** The refusal exists so a caller does not silently spend a running agent's conversation on a knob change; a first `configure` has no prior configuration to preserve and no conversation being spent, so there is nothing there for it to protect — and refusing would strand the path, because `activate` requires `configure` first. That case is reachable: a `forget` over an agent that kept running, or a registry lost while herdr's panes survived. Below, the record was deleted out from under a live agent and the directory configured again:

```
$ crabcast configure /tmp/kan153-live/owned/adopted --priority 5 --launcher shell --label "the adopted agent"
configured /tmp/kan153-live/owned/adopted
  pane name:     crabcast-adopted-5e306b396cd82470
  changed:       every knob — this call created the record
  pane:          w65702dcc803d94-12
  version:       1, frozen 2026-08-04T16:57:09.251Z
  …
per knob:
  priority     applied — takes effect at the next activate
  …

A LIVE PANE OF OURS IS ALREADY THERE, and nothing had been configured for it:
  pane name:     crabcast-adopted-5e306b396cd82470  (w65702dcc803d94-12)
  A pane named crabcast-adopted-5e306b396cd82470 is already live in /tmp/kan153-live/owned/adopted. It is OURS by name, but nothing was configured at this path until this call, so this daemon has no record of what that agent was started with — a registry lost while herdr's panes survived, or a `forget` over an agent that kept running. NOTHING WAS APPLIED TO IT: the configuration above was written and is what the NEXT activation will use, and it does not describe the process running there now. `activate` on this path ADOPTS that pane rather than starting one, so it would answer `alreadyRunning: true` over a configuration no process has ever read. Stand the pane down first if you want an agent that is really running what you just configured.
  remedy:        deactivate(/tmp/kan153-live/owned/adopted); activate(/tmp/kan153-live/owned/adopted)
```

**It is answered, but it is not adopted quietly**, and the difference is the block above. Recording the knobs and saying nothing about the pane would leave the caller to discover the state at `activate` — which reports `already running — nothing was started` and then echoes the configuration it *just* read from the record, over a process that was started before that record existed. The knobs read `applied`, never `applied-in-place`: a live pane of ours is not the same fact as a live *agent* of ours, and nothing here knows what that process was started with. Standing it down and activating again is what makes the two agree.

**A silent defer is not the middle ground it looks like.** Accepting the change and applying it "at next start" leaves the configuration and the world disagreeing behind a `success: true` — the same failure in a quieter costume, and it would make the config echo describe what was last *requested* rather than what the agent is *running with*. The refusal is what makes the echo honest.

**And `configure` is atomic, so the response reports per knob.** A call mixing an in-place change with a respawn-requiring one is refused whole, and says which knobs were refused and which were *withheld* — in-place-capable, and not applied anyway:

```
$ crabcast configure … --priority 11 --launcher claude --prompt-file other-prompt.txt --label renamed
NOTHING WAS APPLIED, including priority, label, which would have changed in place. `configure` takes one desired-state document: applying half of it would leave this agent half new and half old, which is a state nobody asked for and no retry converges out of.
  attributes:    launcher, prompt
  withheld:      priority, label

per knob:
  priority     withheld — would have applied in place; nothing was, this call is atomic
  label        withheld — would have applied in place; nothing was, this call is atomic
  launcher     REFUSED — cannot change under a running agent
  prompt       REFUSED — cannot change under a running agent
```

A call that applies half and reports a bare success is the defect this rule exists to prevent, so `applied`, `withheld` and `outcomes` are on **every** successful response — including the first `configure` on a path, where `applied` is every knob and `withheld` is empty — rather than something to infer from a missing field. Same rule as `alreadyRunning` and `started` on `activate`: a field that appears only sometimes asks the caller to read meaning into an absence, and a reconciler holding desired state has no second source to check it against.

**There is a third answer here too.** If a restart-only knob is asked to move, herdr cannot be reached and the record says the agent is active, the call is refused as *unverifiable*: an empty census from an unreachable herdr is silence, not evidence that nothing is running there. The in-place knobs still change, because their new value is correct whether the agent is up or down.

`node scripts/verify-reconfiguration-refuses.mjs` is the proof. Its refusals are asserted against evidence taken from outside the response — the pane id, herdr's own argv log, a hash of the conversation on disk — because a refusal is the easiest thing in this daemon to assert vacuously.

### Calling a verb again is safe, and that is a contract

A supervisor reconciles by diffing desired state against actual and calling the verbs to close the gap, which means calling them on things that are **already in the desired state**, constantly. So `activate` and `deactivate` are specified for that case rather than merely surviving it.

The daemon under this transcript was spawned with `CRABCAST_MAX_AGENTS=0` exported, so it is at a cap of zero and **at capacity for every line of it** — see [the capacity section](#when-the-machine-is-full-activate-refuses) for why the variable has to reach the daemon rather than the CLI. That is what makes the first call need `--override` and the repeats not.

```
$ crabcast activate /tmp/kan174/idem/probe-a --override      # call #1
activated /tmp/kan174/idem/probe-a
  session:       crabcast-probe-a-9eec866d8e3e12c7-1785941446744 (active)
  pane:          crabcast-probe-a-9eec866d8e3e12c7 (w65702dcc803d94-10)
  created:       2026-08-05T14:50:46.744Z
  priority:      1
  launcher:      shell
  config v1 frozen 2026-08-05T14:50:46.533Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
  prompt: (none — it starts at its runtime's own prompt)
  next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
  activated by: none — no supervisor of record (nothing identified activated it)
  verified:      true
  conversation:  started a NEW one — CrabCast has not run an agent in this directory before, so nothing on disk here was continued

started past the cap on purpose (--override) at 2026-08-05T14:50:46.743Z —
  the machine is now carrying more than it says it can. Recorded with these figures:
  at capacity: 0/0 charged agents, room for 0 more (4 cores, load 2.23, 9.4 GiB available; bound by cap)
  cap 0 (bound by configured) · running 0 · exempt 0 · headroom 0 (bound by cap) · AT CAPACITY
  reason: 0 charged agents are already running against a cap of 0
  cap terms: cpu allows 3, memory allows 16  ·  headroom terms: count allows 0, cpu allows 2, load would allow 2 (reported only), memory allows 8
  io/memory stall: 0% io (worst of /proc/pressure io and memory, `full avg10`) against a 50% threshold — under, so it does not bind
  machine: 4 cores, 1.33 in use over 3s to 2026-08-07T22:48:00.137Z, load 1.32, 9236 MB available of 15737 MB
  agent cost: 800 MB (seed), 0.75 core (seed)
  starts in flight: 0 of 0 charged against the CPU window, costing 0 core(s)

the derivation the override bypassed:
machine: 4 cores, 15.4 GiB RAM (9.0 GiB available), load average 1.32
cpu in use: 1.33 of 4 cores, measured over 3s ending 2026-08-07T22:48:00.137Z — this is the CPU-side bound; the load average above is reported and does not gate
starts in flight: 0 core(s) charged against the CPU window — no agent started after the CPU window opened at 2026-08-11T15:40:58.759Z, so this observation has already priced every agent it is being asked about
agent cost: 800 MB resident (seed), 0.75 core while active (seed)
  no live measurement; seed figures are constants re-derived on 2026-08-12, not a measurement of this fleet
io/memory stall: 0.00% io, 0.00% memory (/proc/pressure `full avg10`, the share of the last 10s in which every non-idle task was stalled); worst is 0.00% on io, against a 50% threshold — under, so this term does not bind
reserved for you: 1 core(s), 2.3 GiB
cap: 0 charged agents (set by CRABCAST_MAX_AGENTS, derivation skipped)
running: 0 charged agent(s)
headroom: 0 more — count allows 0 (0 cap − 0 running), cpu allows 2 ((4 cores − 1 reserved − 1.33 in use) ÷ 0.75), load would allow 2 ((4 cores − 1 reserved − 1.32 load) ÷ 0.75; reported, does not bind), memory allows 8 ((9.0 GiB available − 2.3 GiB reserved) ÷ 800 MB); bound by cap

other fields in the daemon's response:
  promptChars: null
  channelEnabled: false

$ crabcast activate /tmp/kan174/idem/probe-a                 # call #2, no --override
/tmp/kan174/idem/probe-a is already running — nothing was started
  pane:          crabcast-probe-a-9eec866d8e3e12c7 (w65702dcc803d94-10)
  verified:      true
  config v1 frozen 2026-08-05T14:50:46.533Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
  prompt: (none — it starts at its runtime's own prompt)
  next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
  activated by: none — no supervisor of record (nothing identified activated it)

other fields in the daemon's response:
  sessionId: crabcast-probe-a-9eec866d8e3e12c7-1785941446744
  status: active
  createdAt: 2026-08-05T14:50:46.744Z
  promptChars: null
  channelEnabled: false

$ crabcast activate /tmp/kan174/idem/probe-a                 # call #3, no --override
/tmp/kan174/idem/probe-a is already running — nothing was started
  pane:          crabcast-probe-a-9eec866d8e3e12c7 (w65702dcc803d94-10)
  verified:      true
  config v1 frozen 2026-08-05T14:50:46.533Z: priority 1, launcher shell, refusable true, chargeable true, preemptable true
  prompt: (none — it starts at its runtime's own prompt)
  next activate: RESUMES the conversation it was stopped in (this path has a recorded activation)
  activated by: none — no supervisor of record (nothing identified activated it)

other fields in the daemon's response:
  sessionId: crabcast-probe-a-9eec866d8e3e12c7-1785941446744
  status: active
  createdAt: 2026-08-05T14:50:46.744Z
  promptChars: null
  channelEnabled: false

$ crabcast activate /tmp/kan174/idem/probe-a --json
{
  "action": "activate_response",
  "success": true,
  "path": "/tmp/kan174/idem/probe-a",
  "paneName": "crabcast-probe-a-9eec866d8e3e12c7",
  "alreadyRunning": true,
  "started": false,
  "paneId": "w65702dcc803d94-10",
  "sessionId": "crabcast-probe-a-9eec866d8e3e12c7-1785941446744",
  "status": "active",
  "createdAt": "2026-08-05T14:50:46.744Z",
  "verified": true,
  "config": {
    "priority": 1,
    "refusable": true,
    "chargeable": true,
    "preemptable": true,
    "launcher": "shell"
  },
  "promptChars": null,
  "configVersion": 1,
  "configuredAt": "2026-08-05T14:50:46.533Z",
  "everActivated": true,
  "activatedBy": null,
  "channelEnabled": false,
  "id": "cli-1392266-1"
}

$ herdr agent list | grep -o '"cwd":"/tmp/kan174/idem/probe-a"' | wc -l
1
```

**One pane, counted in herdr rather than assumed** — `grep -o … | wc -l` counts *occurrences*, because `herdr agent list` prints the whole census on one line and a `grep -c` there could only ever answer 0 or 1 no matter how many panes were in that directory.

**The `--override` on call #1 is recorded, not merely permitted**, and the two blocks under it are that record: the figures at the moment of the bypass, and the derivation it went past. Calls #2 and #3 did not need it, and that is the point — **an agent already running is already counted**, so a repeat activation does not consult the gate at all. Charging it a second slot would make a supervisor's idle poll look like a fleet twice the size.

**`alreadyRunning` and `started` are on every successful activation**, `true` or `false`. A field that appears only when true asks the caller to read meaning into an absence.

`deactivate` is the mirror, and it never answers a bare success:

```
$ crabcast deactivate /tmp/kan174/idem/probe-a      # it was running
deactivated /tmp/kan174/idem/probe-a — now standby
  pane:          crabcast-probe-a-9eec866d8e3e12c7
  session:       crabcast-probe-a-9eec866d8e3e12c7-1785941446744

$ crabcast deactivate /tmp/kan174/idem/probe-a      # and again
/tmp/kan174/idem/probe-a was not running — standby
  No agent was running and its stand-down was already recorded. Nothing changed.
  pane:          crabcast-probe-a-9eec866d8e3e12c7
  alreadyGone:   true
[exit 0]

$ crabcast deactivate /tmp/kan174/idem/probe-b      # configured, never activated
/tmp/kan174/idem/probe-b was not running — unstarted
  This agent is configured but has never been activated. Nothing was running and nothing was recorded — a stand-down row would put it on the standby list, which promises that switching it back on resumes the conversation it was stopped in. The census agrees: no pane of ours is live there.
  pane:          crabcast-probe-b-07d65c32b0dd5c50
[exit 0]
```

Both are "not running", and they are **not the same answer**. `standby` has a conversation waiting; `unstarted` has none, so recording a stand-down for it would promise a caller something to come back to that does not exist. A supervisor polling "is it down" and a human who mistyped a path get different answers, which is the whole reason the distinction is in the response rather than in the prose.

The second stand-down also writes **no second row** and broadcasts **no second event**: a repeated row would say a decision was taken twice.

**Two things are deliberately *not* idempotent,** and both are the same rule seen twice — a verb may not report success about a world that does not exist:

* A **live foreign pane** in the directory refuses every time, `--override` included. That is somebody else's agent, not this one already running; overriding is a decision about the machine's capacity, never about another agent's directory. Turning that refusal into a quiet "already running" is how two agents end up sharing a directory.
* `deactivate` on a path that was **never configured** refuses, where `forget` on the same path succeeds. `forget`'s postcondition is the absence of a record, and that already holds; `deactivate`'s is a claim about an agent, and there is no agent to make a claim about.

One case where calling again does more than nothing: if a registry write failed after an activation, the record says the agent was never started while its pane is live — and the activate response said `durable: false` at the time. Calling `activate` again **converges the record** and says `recordReconciled: true`. A verb whose contract is "safe to call again" needs a second call that can actually repair, or "safe" only means "harmless".

`node scripts/verify-idempotent-lifecycle.mjs` is the proof, and it counts panes rather than counting errors that did not happen.

### When the machine is full, `activate` refuses

A capacity refusal is a normal outcome, not a malfunction, and it is the same command with a different answer. This is a real one, forced with `CRABCAST_MAX_AGENTS=0` so the transcript is reproducible on any machine.

**`CRABCAST_MAX_AGENTS` is read by the daemon, once, at boot — not by the CLI.** So it has to be in the environment of the command that *spawns* the daemon, which is why the export below comes before a `configure` in a data directory that has no daemon yet. Putting it in front of the `activate` instead — `CRABCAST_MAX_AGENTS=0 crabcast activate …` — sets it on a client that never reads it and leaves the running daemon's cap exactly where it was, so you get whatever that machine's real answer is rather than the forced one. If a daemon is already up for that `dataDir`, `crabcast deactivate` everything and stop it first, or use a fresh `dataDir`.

```
$ export CRABCAST_MAX_AGENTS=0
$ crabcast configure /tmp/kan174/cap/notes --priority 1 --launcher shell   # spawns the daemon, which reads it here
$ crabcast activate /tmp/kan174/cap/notes
FAILED: activate /tmp/kan174/cap/notes

Refusing to activate /tmp/kan174/cap/notes: at capacity — 0 charged agents are already running against a cap of 0.
machine: 4 cores, 15.4 GiB RAM (9.0 GiB available), load average 1.53
cpu in use: 1.40 of 4 cores, measured over 3s ending 2026-08-07T22:48:06.131Z — this is the CPU-side bound; the load average above is reported and does not gate
starts in flight: 0 core(s) charged against the CPU window — no agent started after the CPU window opened at 2026-08-11T15:41:05.081Z, so this observation has already priced every agent it is being asked about
agent cost: 800 MB resident (seed), 0.75 core while active (seed)
  no live measurement; seed figures are constants re-derived on 2026-08-12, not a measurement of this fleet
io/memory stall: 0.00% io, 0.00% memory (/proc/pressure `full avg10`, the share of the last 10s in which every non-idle task was stalled); worst is 0.00% on io, against a 50% threshold — under, so this term does not bind
reserved for you: 1 core(s), 2.3 GiB
cap: 0 charged agents (set by CRABCAST_MAX_AGENTS, derivation skipped)
running: 0 charged agent(s)
headroom: 0 more — count allows 0 (0 cap − 0 running), cpu allows 2 ((4 cores − 1 reserved − 1.40 in use) ÷ 0.75), load would allow 1 ((4 cores − 1 reserved − 1.53 load) ÷ 0.75; reported, does not bind), memory allows 8 ((9.0 GiB available − 2.3 GiB reserved) ÷ 800 MB); bound by cap
Deactivate an agent to make room, or pass override: true to start it anyway (the override is recorded with these numbers).
Nothing running is below priority 1, so there is nothing this activation may stand down. Running: nothing is running that could be stood down. Preemption is strictly-greater: an agent may not displace one of its own priority.
  refused by:    capacity
  reason:        0 charged agents are already running against a cap of 0
  priority:      1
  started:       false — NOTHING was spawned

capacity:
  at capacity: 0/0 charged agents, room for 0 more (4 cores, load 2.64, 9.3 GiB available; bound by cap)
  cap 0 (bound by configured) · running 0 · exempt 0 · headroom 0 (bound by cap) · AT CAPACITY
  reason: 0 charged agents are already running against a cap of 0
  cap terms: cpu allows 3, memory allows 16  ·  headroom terms: count allows 0, cpu allows 2, load would allow 1 (reported only), memory allows 8
  io/memory stall: 0% io (worst of /proc/pressure io and memory, `full avg10`) against a 50% threshold — under, so it does not bind
  machine: 4 cores, 1.4 in use over 3s to 2026-08-07T22:48:06.131Z, load 1.53, 9167 MB available of 15737 MB
  agent cost: 800 MB (seed), 0.75 core (seed)
  starts in flight: 0 of 0 charged against the CPU window, costing 0 core(s)
[exit 1]
```

Every term is reproducible by hand, and the headline names the *binding* constraint. What the forced cap buys is that `cap: 0` binds *first*, so the same headline and the same `refused by: capacity` come out of an idle machine too — only the machine figures differ. An unforced refusal names whichever term actually bound, and shows the same ones. Wait for room, stand something down, or pass `--override` and have the bypass recorded with the figures it bypassed.

**There are four headroom terms and the smallest wins**, which is why the derivation prints all of them and then says `bound by`. `count` is the cap minus what is running. `memory` is what the kernel says it could still hand out, less your reserve. `cpu` is **cores actually in use**, measured over a real window from `/proc/stat`. And `load` is the 1-minute load average, printed on every line and — since the transcript above — **not what gates**.

**And there is a fifth thing that is not a term at all — a veto.** `/proc/pressure` (Linux PSI) reports the share of the last ten seconds in which *every* non-idle task was stalled waiting on I/O or on memory reclaim. When that reaches **50%** no agent is admitted, whatever the four terms above computed, because a machine making no forward progress does not have room for a fraction of an agent — it has no room. It is a veto rather than a term precisely because there is no per-agent I/O cost to divide by, and inventing one would be the dimensional confusion the CPU change above exists to have removed. The derivation prints what the counting terms allowed before it fired, so the veto's effect is visible rather than looking like a machine that was simply full, and no agent is offered for preemption on a stall — standing one down frees a slot, and slots are not what a stalled machine is short of.

**Where there is no PSI, that term is inert and says so in words.** An absent or unreadable `/proc/pressure` is never reported as `0.00%`, which would be an all-clear from an instrument that never looked; the report distinguishes *no PSI on this machine* from *PSI is here and would not answer*, and on either the page says plainly that nothing is bounding I/O saturation. There is deliberately no environment override for the threshold — the escape hatch is `override: true` on the activation, which is recorded with the arithmetic that refused it.

That last split is worth a paragraph, because the figures can disagree loudly and the disagreement is the point. On Linux the load average counts processes blocked in uninterruptible sleep as well as processes running, so a machine grinding through disk I/O reports a high load with its cores sitting idle. CrabCast used to divide that number, and refused activations it had the capacity to serve — `load too high`, in figures that were internally consistent and about the wrong thing. It now divides observed CPU, and a report where `load would allow 0` sits beside `cpu allows 2` is a machine that is queued, not busy.

Two consequences to know about:

* **A refusal says which instrument refused it.** `machine stalled on io` (or `on memory`) means the machine is getting nothing done — its cores may well be idle — and is the one constraint that can refuse a machine every other term says has room. `cpu too busy` means the cores are full. `load too high` means *nothing measured this machine's CPU* and the load average is standing in — you will see it on anything without `/proc/stat`, and for the first few seconds of a daemon's life, because a window needs two readings separated in time. The derivation says `not measured here` in words for exactly that period.
* **The load average was accidentally a signal about more than CPU**, and dropping it as the bound gives that up. A machine thrashing on swap, or blocked on a disk that is dying, has a high load and idle cores — CrabCast will now start agents on it. Memory pressure is still caught by the memory term; I/O saturation on a machine with memory to spare is not caught by anything, and `load1` staying on every line is so you can see it yourself.

**What an agent is worth is its own `priority`,** frozen on by `configure` — it used to be a property of its workspace type. And the single `gateExempt` flag that type carried is now three: `refusable` (may the gate refuse this agent), `chargeable` (does it occupy a slot), `preemptable` (may anything take it). They were always three different decisions, and bundling them meant you could not have an agent that costs a slot but can never be taken.

### Editing the config after the daemon is running

The daemon reads `crabcast.config.json` once, at boot — but there is very little in it now, and nothing about any agent: everything an agent is arrives through `configure`, at runtime, and takes effect without a restart. The only reason to restart is a changed `dataDir`, which is a different daemon.

There is no `crabcast daemon` that runs one in the foreground, and nothing above needed one. A config the daemon would refuse never reaches the daemon: the CLI loads it first and refuses with the reason, having attempted nothing.

```
$ crabcast --config bad.json list
crabcast: refusing to run: /tmp/kan175/badconfig/bad.json: "workspaceTypes" is no longer a config key — workspace types are gone: an agent is a directory plus the knobs a caller freezes onto it with `configure`. priority, prompt, launcher, mcpServers and the gate flags are now per-agent `configure` parameters rather than per-type config, so this declaration has no consumer. Remove the key; there is nothing to move it to in this file.
exit=4
```

A config still declaring `workspaceTypes` is **refused rather than ignored**. Dropping it silently would start a daemon that agrees with the file about nothing, and the first evidence would be an activation refused for a knob nobody knew had moved.

## The CLI

`crabcast` drives the daemon from a shell, so the system is complete with no browser anywhere.

```bash
crabcast configure <dir> --priority 1 --launcher claude   # make an agent EXIST, or change one
crabcast activate <dir>          # run it  (--override, --preempt; no other options)
crabcast list                    # the whole fleet, plus capacity
crabcast list --owner butchr     # only agents configured with that owner (NOT a permission boundary)
crabcast status <dir>
crabcast tail <dir> --lines 40   # its recent pane text, without attaching
crabcast send <dir> 'run the tests'
crabcast deactivate <dir>        # stop it; the record survives
crabcast forget <dir>            # make it stop EXISTING; deletes no directory
crabcast capacity                # how many more this machine can carry, and why
crabcast daemon-status           # pid, uptime, config, registry — and WHICH BUILD is running
```

Every agent-addressing command takes exactly one operand: the directory. There is nothing to disambiguate — two agents cannot share a directory the way they could share a key — so there is no `--type` flag and no ambiguity to resolve.

`configure`'s flags are `--priority` and `--launcher` (both required, neither defaulted), plus `--prompt <text>` or `--prompt-file <path>`, `--args-json <json>`, `--mcp a,b` and `--mcp-config <file>`, `--label`, `--owner`, and the gate triple `--refusable`/`--chargeable`/`--preemptable` (all default true, `--gate-exempt` is shorthand for all three false). It is also how an agent that already exists is **changed** — per attribute, refusing rather than respawning; see [above](#changing-an-agents-knobs-never-costs-it-its-conversation).

`--args-json` carries **extra command-line arguments for the launcher's own process**, as a JSON array of strings — `--args-json '["--verbose"]'`. Each element becomes exactly one argument, shell-quoted, whatever it contains; there is no splitting and no expansion, which is also why it is JSON rather than a comma-separated list — any separator would be a quoting rule CrabCast invented and you had to escape around. They go on **every** invocation the launcher builds, which matters because a launcher that can resume builds two: `claude` runs `--continue` and falls back to a cold start, and the resumed one is the path every already-existing agent takes. A launcher that cannot carry arguments **refuses** rather than dropping them silently — `shell` is bash itself, so there is nothing underneath to pass a switch to — and because argv is fixed at process start, changing them under a running agent is refused like `launcher` and `prompt`. What you sent is readable afterwards in `list`, in `status`, and in a capacity refusal, so somebody denied a slot can still see what would have been spawned.

⚠ **Write an argument that carries a value as one element joined with `=`** — `'["--flag=value"]'`, never `'["--flag","value"]'`. The prompt is the last argument on the command line and it is a **bare operand**, carrying no flag of its own, so a **variadic** consumer flag written the two-element way does not stop at its own value: it keeps reading, and the next bare word is your prompt — it swallows it. That wedges every spawn for that agent, and the failure names nothing about arguments — the runtime reports your *prompt text* as a malformed value for the flag, which sends a reader off editing the prompt. `=` binds the value and there is no bare word left to take. CrabCast does not refuse the two-element form, because whether a flag is variadic is a fact about *your* program and the only detector available without it would refuse correct configurations; [`docs/launcher-args.md`](docs/launcher-args.md) argues that decision, shows both forms with what each produces, and is where to look when a spawn fails complaining about your prompt.

MCP servers arrive as **definitions rather than names** — the command, args and env that spawn each one — and are written into the agent's `.mcp.json` verbatim: `--mcp-config` reads them from a JSON file here and puts its *bytes* on the wire, the same hand-off `--prompt-file` makes. `--mcp` is for the one server CrabCast builds itself (`crabcast`), whose definition depends on facts about this daemon rather than about you. Supplying either **is** the consent to a `.mcp.json` appearing in your directory; there is no second flag, `configure`'s response names the file and keys it will write before anything is written, and `forget` takes them back out. Every server you asked for must be writable or the activation is refused — a `.mcp.json` holding only half of what you asked for is a file whose presence looks like success. [`docs/callers-directory.md`](docs/callers-directory.md) is the whole of what CrabCast writes into a directory you own, and how each of it comes back out.

The CLI is a client, not a second brain: it parses arguments, sends one action, and renders the answer. It never computes capacity, decides preemption, or infers whether an agent is alive — the daemon owns all of that. What it prints is what the daemon said, and a capacity derivation is printed **verbatim and unindented**, because the figures are the product.

* **`--json`** prints the daemon's response exactly as it arrived — every field, including the `id` the invocation used to correlate it. Nothing is dropped, renamed or reordered. Human-readable output is the default; anything the renderers do not recognise is printed anyway rather than swallowed.
* **Exit codes** are part of the contract: `0` success · `1` the daemon answered `success: false` (a capacity refusal lands here) · `2` usage error · `3` could not reach or spawn the daemon · `4` a config that was named would not load.
* **Config resolution** is `--config <path>`, else `$CRABCAST_CONFIG`, else `./crabcast.config.json` — the same rule the daemon and the MCP server use, from the same function. A config that was *named* and will not load is a refusal, never a silent fallback onto some other daemon.
* **Which commands start a daemon:** `configure`, `activate`, `deactivate`, `forget` and `send` spawn one if none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` do not, and exit `3` instead. Spawning the daemon runs its boot reconcile, which re-activates every agent the durable registry expects — a fleet-sized side effect nobody asked for by typing `crabcast list`.
* **Messages that start with a dash are messages.** Flag parsing stops where `send`'s `<message...>` begins, so `crabcast send demo --help` types the text `--help` into the agent rather than printing this help and sending nothing. Quoting does not help with a leading dash — the shell eats the quotes — which is why the rule is in the parser rather than in a note. The trade is that a flag written *after* the message is message text (`crabcast send <dir> hi --timeout 5000` sends `hi --timeout 5000`); put flags before the operands. `--` still ends flag parsing for the commands with no trailing message, e.g. `crabcast status -- -odd-path`.
* **Capacity arithmetic:** `capacity` and a refused `activate` carry the daemon's derivation and print it verbatim. `list_agents` ships no derivation, so `list` prints the same figures as numbers — the cap and headroom terms and the machine they were read off — rather than dropping them.

`crabcast --help` is rendered from the command table exported by `src/cli.ts`, so every command it lists exists. `node scripts/verify-cli-refusal.mjs` is the live proof of the refusal, the exit codes, `--json`, and the `--override`/`--preempt` round trip.

**What `--json` prints is a published shape.** `list` and `status` return the daemon's `list_agents` and `agent_status` responses unchanged, and **[`docs/read-path-contract.md`](docs/read-path-contract.md) is the contract**: every field, which of the four provenance buckets it is in, and what an absence means. `crabcast daemon-status` prints the revision of it the running daemon implements, as `read contract`.

## The daemon

One long-lived daemon per machine, listening on a Unix socket (`<dataDir>/crabcast.sock`, newline-delimited JSON, id-correlated). Nothing needs to start it: the CLI spawns a detached one on first need. To run it in the foreground instead — which is what a supervisor needs, and what [Surviving a reboot](#surviving-a-reboot) is about:

```bash
crabcast daemon [--config <path>]
```

It does not return; SIGINT or SIGTERM stops it and it removes its socket on the way out. Its exit status is the daemon's own — `0` for a clean shutdown, non-zero for a refusal to boot — rather than the CLI's client exit-code table, because nothing here asked a daemon anything. From a repository checkout with nothing installed, `node dist/daemon.js [configPath]` is the same program.

The config path is `--config`, else the first argument to `node dist/daemon.js`, else the `CRABCAST_CONFIG` environment variable, else `crabcast.config.json` in the current directory. The whole of it is an optional `dataDir` — default `~/.local/share/crabcast`, and the socket, the log, the durable registry and each agent's sidecar live under it:

```json
{}
```

That is a complete, working config, and this repository ships exactly it. It used to declare a table of workspace types, each with a priority, a prompt file, a launcher and a gate flag; those are per-agent values a caller freezes on with `configure`, so there is nothing left for a config file to say about an agent.

Validation still refuses rather than repairs, on the two things that remain. A config declaring the retired `workspaceTypes` is refused by name (see above). And a `dataDir` whose socket path would exceed 104 characters is refused: a unix socket address is a fixed buffer and an over-long path is silently *truncated*, so the daemon would bind outside its own data directory, fail to chmod or unlink what it bound, and leave the next daemon reporting a stale socket file in a directory that is empty.

**The daemon also refuses to start against a durable registry it cannot fully read.** Records written before agents were addressed by path carry a `type` and a `key` and no path, and their priority, gate flags and prompt lived in the deleted `workspaceTypes` — so there is nowhere to get them from. Converting such a row would mean inventing values nobody decided, and loading the file part-way would mean some agents silently ceasing to exist. So the daemon names the file, the count and two remedies (delete the log, or hand-edit it) and stops.

Exactly one daemon owns the socket: a second daemon that finds a live socket says so on stderr and exits 0, changing nothing; a stale socket file left by a crash is unlinked and reclaimed. `node scripts/daemon-status.mjs` round-trips a `daemon_status` request over the socket, and `node scripts/verify-config-and-socket.mjs` is the live proof of all of the above.

### Surviving a reboot

**CrabCast does not supervise itself, and does not start at boot.** It installs no service, enables nothing, and has no opinion about your init system. If you want a daemon that outlives a restart, you give it a supervisor — and `crabcast daemon` is the foreground entrypoint to point one at.

This is the counterpart to *no client starts a daemon by hand*, and the reason it needs saying: that promise is about clients, and after a reboot there are none. Nothing spawns a daemon, no read verb will do it, and — the part that surprises people — **no write verb will either unless it is pointed at a config it can load**, because with nothing named the CLI falls back to the default data dir and deliberately refuses to spawn into it. So the socket is absent, nothing reports it, and it stays that way until a human notices. On the machine this was found on, that was eight days.

**[`docs/supervision.md`](docs/supervision.md) is the whole of it**: the decision and the options it was chosen over, a systemd user unit template, and the two settings in it that are load-bearing rather than taste — `Restart=on-failure` (because the CLI's own auto-spawn means two daemons can race, the loser exits *cleanly*, and `Restart=always` would restart that clean loser forever against a socket it can never win) and a pinned `Environment=PATH` (because the daemon resolves `herdr` off `PATH` at startup, so the wrong one comes up looking healthy and fails every activation).

It also states, in the same words as here, what is **predicted rather than observed**: `scripts/verify-daemon-foreground.mjs` checks every link in CI — the foreground process serves, its pid is the one on the socket, SIGTERM releases it cleanly, a losing second daemon does no harm, a bad config refuses before the socket exists — but **nothing has watched the unit fire at an actual boot**, because the machine this was built on runs a live fleet. Do not read the green check as "reboot handled".

### Events

The daemon announces fleet changes to every connected client — nine of them, `agent.configured` through `registry.degraded` — on the socket and as structured MCP notifications. **[`docs/event-contract.md`](docs/event-contract.md) is the contract**: the events, their payloads, what an unrecognised action does, and the delivery guarantees.

Read the delivery section before you build on them. Events are **at-most-once** and are a latency optimisation over an authoritative `list` poll, never a replacement for one: **a subscriber that does not independently poll `list` on a timer is not entitled to convergence.** For a subscriber that polls, a missed event costs slower convergence; for one with no timer it costs correctness. `bootId` on every event — and on `list_agents` and `daemon_status`, so a reconnecting subscriber need not wait for an event — is how you find out the daemon restarted and your sequence watermark is meaningless.

`node scripts/verify-event-contract.mjs` is the live proof.

### The read path

The socket's two state reads — `list_agents` for the fleet and `agent_status` for one agent — plus **`activate_response`**, the one response that tells you about the spawn you just made rather than about what is true now, are published field by field in **[`docs/read-path-contract.md`](docs/read-path-contract.md)**, with the **provenance bucket** of every field: whether it came off the durable registry, was observed from herdr just now, was computed, or is this process's own memory. That is what tells you whether an absence means *not known* or *not true*.

**And the contract says where it stops.** §10 lists the responses it does *not* cover — `deactivate_response`, `configure_response`, `forget_response` and the pty responses are all consumed by somebody and described by none of it. It also names the one covered by a **sibling contract** rather than by nothing, because those are different answers: `send_to_agent` is published in [`docs/send-contract.md`](docs/send-contract.md), below. Read that section before assuming a response you depend on is covered; a boundary you have to infer from what happens to be listed is the defect it exists to remove.

Read it beside the event contract, not instead of it: events are the latency optimisation and `list_agents` is the authoritative read, so the delivery guarantees stay over there while the shape lives here.

Three things worth knowing before you build on it. **The stability statement is a notice promise, not a freeze**: below 1.0 no field is guaranteed not to change, and what is promised is that a change to a documented field arrives with a consumer notice naming it — *you will not find out by breaking*. **The version is on the wire in exactly one place**, `daemon_status.contractVersion`; read it once and re-read it when `bootId` moves. And **the document is checked against the code**: `node scripts/verify-read-contract.mjs` reconciles it, `src/read-contract.ts` and a real daemon's responses in both directions, so a field added to a response and not to the document goes red in CI. It drives ten of `activate_response`'s eleven branches on a real daemon to do it — and **names the eleventh as unproduced** rather than letting a count of branches in the document imply a count of branches exercised.

### Finding your own agents — the `owner` knob, and what it is not

Freeze an opaque `owner` on an agent at `configure`, and ask `list` for only
those:

```
crabcast configure /path/to/agent --priority 1 --launcher claude --owner butchr
crabcast list --owner butchr
```

It exists so an application can find **its own** agents without parsing their
names. CrabCast derives a pane name from the agent's path (`crabcast-<slug>-<hash>`);
that derivation is not API, and a consumer resting on it breaks silently the day
the rule changes — which is the parseable-name coupling this project deleted
everywhere else.

**It is not a permission boundary, and nothing about it hides anything.** Any
caller that can reach the daemon's socket lists **every** agent on the machine
by leaving the filter off, deliberately. The only auth boundary CrabCast has is
the socket's own file permission — `0600` in a `0700` directory. A filter is a
narrower **question**, never a smaller **answer**.

**It is matched exactly and never interpreted.** No prefix, no glob, no
hierarchy, no case-folding, and no value means anything to the daemon: it is
whatever string you already call yourself. The first prefix match would invite a
namespace, and a namespace is vocabulary CrabCast would then owe you
compatibility on.

**An agent with no owner is matched by no filter.** Absence is a real state, not
a wildcard. Every agent configured before this knob existed is unowned, is
returned by **no** filtered read whatever you pass, and is reachable only by
omitting the argument. The asymmetry is deliberate and it is the half that
matters: a false *match* over-includes a row in a listing, while a false
*non-match* can **stop an agent** — the caller this exists for is a reconciler
whose last step is *"anything running that is not in my desired list → off"*, and
such a caller has to be able to tell **not mine** from **unknown to me**.

**A filtered response says what it narrowed and what it did not.** `agents`,
`missingAgents`, `preemptedAgents`, `standbyAgents` and `unstartedAgents` are
narrowed, and their `*Total`s and `pages.<category>` counts describe the
**filtered** set — which is what keeps paging correct under it, and which means
the numbers alone cannot tell you a filter was applied. The `ownerFilter` block
on the response is the only thing that can, and it also names the four arrays
left **complete**: `unbackedPanes` and `foreignPanes` (no record, so no owner),
`priorities` (a fact about the machine, not about you) and `unreadableRecords`
(the row could not be parsed, and may well be yours).

It changes **in place** like `label`, with the consequence that a filtered list
is a snapshot. `node scripts/verify-owner-filter.mjs` is the proof.

### The send path

`send_to_agent` types at another agent's terminal and answers with a **verdict**, and **[`docs/send-contract.md`](docs/send-contract.md) is the contract**: what each verdict means, what a caller should *do* with it, the evidence block the verdict was read from, and the exact key set of each of the five branches.

**Read §2 before you write the switch, because three is not four.** A send that happened can conclude three things — `delivered`, `not-delivered`, `unverifiable`, each a statement about a pane that was looked at. The *response* carries a fourth, `refused`, for a request that never became a send and therefore read no pane. A consumer switching exhaustively on the three meets the fourth as a default case. And `not-delivered` and `unverifiable` license **opposite** actions: the first is evidence of absence and you may resend; the second is the absence of evidence, and resending types a duplicate at an agent that may already be working on the first copy.

`node scripts/verify-send-contract.mjs` is the live proof — document, declaration and a real daemon's responses, with the vocabularies bound to their TypeScript unions at compile time, so an undocumented verdict does not build.

### Which build is running

`crabcast daemon-status` answers what the **running process** was built from — not what is in the directory it was started from. CrabCast is consumed as a linked local checkout (`file:../crabcast`), so there is no published artifact and no version string to ask for; without this, a fleet that misbehaves has nothing that can name the build that did it.

Reaching the interesting state takes a rebuild in the middle of a session — the daemon is spawned out of the `dist/` that is on disk, and then that `dist/` is rebuilt underneath it while it keeps running:

```
$ crabcast configure /tmp/kan174/prov/notes --priority 1 --launcher shell   # spawns the daemon
$ crabcast daemon-status                                                    # freshness: CURRENT
$ touch /tmp/kan174/crabcast/src/router.ts && ( cd /tmp/kan174/crabcast && npm run build )
$ crabcast daemon-status
```

`crabcast daemon-status` opens with a daemon header — pid, uptime, config path, data dir, registry, events — and then prints the two blocks below. **Those two are reproduced here in full and verbatim; the header above them is the only thing left out**, and it is left out because it is about the process rather than about the build:

```
build — what THIS process was loaded from, read when it started:
  commit:          b058fda6d68d0282663961ca54e21185fc9d76bb
  checkout:        clean when this build was made
  built:           2026-08-05T14:47:59.617Z
  git root:        /tmp/kan174/crabcast
  loaded from:     /tmp/kan174/crabcast/dist
  stamp:           /tmp/kan174/crabcast/dist/build-stamp.json
  read at:         2026-08-05T14:51:59.463Z

freshness: PROCESS-PREDATES-BUILD
  THE RUNNING DAEMON IS NOT THE BUILD ON DISK. /tmp/kan174/crabcast/dist was rebuilt after this process loaded it, and the process is still executing what it read at boot (2026-08-05T14:47:59.617Z); the build on disk is 2026-08-05T14:52:04.764Z. Nothing on the filesystem shows this — restart the daemon to pick the new build up.
  running the build on disk: no
  sources newer than build:  no
  compared by:               build-stamp
  build on disk:             2026-08-05T14:52:04.764Z
  newest in dist/:           2026-08-05T14:52:04.763Z
  sources:                   /tmp/kan174/crabcast/src
  newest source:             2026-08-05T14:52:00.756Z (router.ts)
```

**The evidence tail is the answer, not decoration.** `built:` and `read at:` are what the *process* holds — the stamp it read at boot — and `build on disk:` is what is there *now*; the two disagreeing is the whole finding. `compared by: build-stamp` says which of the two comparisons was available: a `dist/` with no stamp is compared by file times instead, and that line then says so *and* names what file times cannot see — a weaker answer that must not look like this one.

`npm run build` writes `dist/build-stamp.json` (its `postbuild` step, `scripts/stamp-build.mjs`); the daemon reads it **once, at boot**, out of the `dist/` it was itself loaded from. Three freshness states are told apart, and each is measured rather than assumed:

* **`current`** — this daemon is running the build on disk, and that build is newer than `src/`.
* **`process-predates-build`** — somebody rebuilt under a live daemon. It is still serving the old `dist/`. **No filesystem check can see this**: the tree on disk looks entirely current, which is exactly why the process has to answer it.
* **`build-predates-sources`** — `src/` has changed since `dist/` was built. Run `npm run build`.

**"I don't know" is a first-class answer and never renders as "clean".** A tree with no `.git`, a `dist/` built by running `tsc` directly (no stamp), a stamp whose `dist/` was rewritten under it, a machine with no `git` — each reports `UNKNOWN` with the reason that made it unknown, under a heading that says so. A check that reports success when it could not run is worse than no check. `node scripts/verify-daemon-provenance.mjs` is the live proof, including that the unknowns are unknowns.

## Development setup

```bash
gh repo clone wroosbit/crabcast   # or: git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install         # runs `prepare`, so this already builds dist/
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/, then dist/build-stamp.json
```

`npm run build` is `tsc` plus a `postbuild` step (`scripts/stamp-build.mjs`) that records the commit, whether the checkout was clean, and the time into `dist/build-stamp.json`. Running `tsc` directly still works and is still a valid build — it just produces an *unstamped* one, which the daemon reports as `UNKNOWN` rather than guessing at.

The verify scripts under `scripts/` are the live proofs of this daemon's behavioural invariants. The isolatable ones run in CI (the `verify` check) against a shimmed `herdr`; the rest need a real herdr and real panes and are run by hand, with their output going on the pull request. See the comments in `.github/workflows/ci.yml` for which are which and why.

### Running the proofs locally

```bash
npm run verify                                  # the whole CI array, as CI runs it
npm run verify -- verify-restart-survival       # one of them
npm run verify -- --list                        # what the array holds
```

`npm run verify` is `node scripts/run-verify.mjs`, and **it is how these proofs should be run by hand.** Running one directly still works and still writes into your own `~/.claude.json`: the `claude` launcher records folder trust at `path.join(os.homedir(), '.claude.json')`, so every proof that activates a `claude` agent leaves one `hasTrustDialogAccepted` key per scratch directory behind — for a directory that is deleted moments later. CI never had this problem because `.github/workflows/ci.yml` gives each proof its own `$HOME`; the runner is the same three lines off the runner. It reads the proof list out of `ci.yml` rather than keeping a second copy, refuses to start unless it has watched the *shipped* `claudeConfigPath()` answer from inside a scratch directory, and counts your real config's keys on both sides of the run.

`node scripts/claude-config-residue.mjs` reports how many such keys are in a config already, by producing script. It is read-only and prints counts and never keys — the file is yours and most of it has nothing to do with this repository.

Two proofs are deliberately outside all of this and must keep running under your real `$HOME`: `verify-interrupt-at-dialog-live` and `verify-send-confirms-delivery-live` start a real Claude Code, which reads your credentials from there. Both are in the exclusion register in `scripts/verify-proof-registry.mjs`, so the runner cannot reach them and refuses them by name.

### Where this code came from

Nineteen modules under `src/` were extracted from another codebase over five commits in August 2026, and several still carry decisions made before CrabCast existed. [`docs/ported-lineage.md`](docs/ported-lineage.md) is the record: the extraction source and the commit it was read at, the exact file list and what was deliberately left behind, how each module has diverged since and whether that was on purpose, and — the part a list of stated purposes would miss — **what some of those mechanisms were incidentally doing beyond their stated job**. It also names the modules nobody has examined, rather than omitting them.

It is a document, not a proof: nothing enforces it, and it is meant to be read **when you edit a ported module**, not on a schedule. The modules in question say so in their first four lines.
