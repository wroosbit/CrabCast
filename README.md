# CrabCast

CrabCast is standalone agent orchestration for terminal AI agents: one long-lived daemon per machine, a CLI, and a fleet UI, with capacity, priority, and honesty built in. The daemon spawns each agent in its own terminal pane, in a directory **you** already own; refuses work the machine cannot carry, with figures the reader can reproduce; preempts by priority but never automatically; and reports the fleet honestly — including the agents that died, were stood down, or were preempted. CrabCast is a management layer only: it never embeds a terminal, and apps built on top of it may bring their own.

**An agent is a directory plus a few knobs.** That is the whole addressing model. There are no workspace types, no keys and no names to remember: you `configure` a directory with what the agent should be worth and what should run in it, and from then on the directory's path *is* the address for every read and every verb. CrabCast never creates that directory and never deletes it — which is what lets it be your repository checkout rather than a scratch space CrabCast hands you.

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

**You never run a build step by hand.** `package.json` declares `"prepare": "npm run build"` — `tsc`, then a `postbuild` step that writes `dist/build-stamp.json` so the daemon can say which build it is running (see [Which build is running](#which-build-is-running)) — and npm runs `prepare` as part of `npm install`. So the first command leaves you with a compiled, stamped `dist/`, and the second packs and installs it. `npm run build` exists, but it is for contributors iterating on the source, not a step in this sequence.

**Both commands are needed, in that order.** `npm install -g .` on a clone that has never had `npm install` run in it fails with `sh: 1: tsc: not found`: installing a directory globally does not install that directory's devDependencies, so `prepare` has no compiler to call. That is a real limitation of this install path rather than a step worth skipping.

**The package stays `"private": true` and is deliberately not published to npm.** That follows the project decision that there is no publish until there is something to publish, and `private` blocks only `npm publish` — installing from a directory, as above, is unaffected. The consequence for you is the `git clone` in the first line: there is no `npm install -g crabcast`, and any package by that name on the registry is not this one.

If you have previously run `npm link` from a CrabCast clone, remove that link first (`npm rm -g crabcast`). npm cannot replace the symlink a link leaves behind with a real directory, and the install fails with `ENOTDIR ... rename`.

## Walkthrough: CrabCast on a directory you already own

A directory with no prior CrabCast state: configure an agent into it, activate it, watch it, address it by path, stand it down, forget it. Every command below is one that was run and the output is what it printed; the paths are the machine it was run on, and yours will be your own.

Five things worth knowing before reading it:

* **The first `activate` may be refused, and that is the system working rather than the walkthrough failing.** CrabCast asks whether this machine can carry another agent *before* it starts one, and on a machine already under load the answer is no. The refusal names the binding constraint and shows every term it used; there is a worked example [below](#when-the-machine-is-full-activate-refuses). Two ways past it: wait for the machine to quieten and run the same command again, or pass `--override` to start the agent anyway and have the bypass recorded with the figures it bypassed. Waiting is the better answer on a machine you are also trying to use — **and this transcript is what the second answer looks like**: the machine it was captured on was running ten other agents at load 3.47, so the `activate` below carries `--override` and prints the derivation it bypassed. On a quiet machine the bare `crabcast activate <path>` is the whole command.
* **Nothing starts a daemon by hand.** `configure`, `activate`, `deactivate`, `forget` and `send` spawn one when none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` refuse with exit 3 instead of starting a fleet nobody asked for. The first `crabcast list` below is that refusal, on purpose.
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
and one is spawned if none is running. From a repository checkout you can also
run one in the foreground: node dist/daemon.js [configPath]
If one failed to start earlier, its stderr is in /tmp/ac1-demo/.crabcast/daemon-spawn.err.
[exit 3]

$ crabcast configure /tmp/ac1-demo/notes --priority 1 --launcher shell --prompt-file prompt.txt --label "the notes agent"
configured /tmp/ac1-demo/notes
  pane name:     crabcast-notes-31e31d1b7540dabf
  priority:      1
  launcher:      shell
  gate:          refusable true, chargeable true, preemptable true
  prompt:        250 characters (written to the agent's sidecar verbatim)
  label:         the notes agent

$ crabcast activate /tmp/ac1-demo/notes --override
activated /tmp/ac1-demo/notes
  session:       crabcast-notes-31e31d1b7540dabf-1785829987483 (active)
  pane:          crabcast-notes-31e31d1b7540dabf (w65702dcc803d94-15)
  created:       2026-08-04T07:53:07.483Z
  priority:      1
  launcher:      shell
  verified:      true
  conversation:  started a NEW one — CrabCast has not run an agent in this directory before, so nothing on disk here was continued

started past the cap on purpose (--override) at 2026-08-04T07:53:07.480Z —
  the machine is now carrying more than it says it can. Recorded with these figures:
  load too high — the load average is 3.47, against the 3.0 cores this machine leaves to agents; 0/3 charged agents, room for 0 more (4 cores, load 3.47, 6.7 GiB available; bound by load)
  cap 3 (bound by cpu) · running 0 · exempt 0 · headroom 0 (bound by load) · AT CAPACITY
  … the full derivation the override bypassed follows, elided here

$ crabcast list
agents (1)
  /tmp/ac1-demo/notes  [unknown]  runtime (none reported)
    session crabcast-notes-31e31d1b7540dabf-1785829987483 (active), created 2026-08-04T07:53:07.483Z
    label the notes agent
    pane crabcast-notes-31e31d1b7540dabf (w65702dcc803d94-15)

foreign panes (10) — live agents this daemon did not start
  butchr-task-kan-125 [working]  runtime claude  pane_id w65702dcc803d94-12
    cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-125
  butchr-task-kan-111 [working]  runtime claude  pane_id w65702dcc803d94-11
    cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-111
  … eight more

$ crabcast status /tmp/ac1-demo/notes
/tmp/ac1-demo/notes — unknown
  pane name:     crabcast-notes-31e31d1b7540dabf
  pane id:       w65702dcc803d94-15
  label:         the notes agent
  configured:    true
  session:       crabcast-notes-31e31d1b7540dabf-1785829987483
  status:        active
  created:       2026-08-04T07:53:07.483Z

$ crabcast send /tmp/ac1-demo/notes cat /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf/prompt.md
sent to /tmp/ac1-demo/notes — the message was typed into its terminal and Enter pressed

$ crabcast tail /tmp/ac1-demo/notes --lines 20
pane text for /tmp/ac1-demo/notes:
bcast/agents/31e31d1b7540dabf/prompt.md
You are a CrabCast agent working in the notes directory.

This prompt was rendered by the CALLER and handed to CrabCast as finished
text. CrabCast wrote these bytes verbatim and never looked at them — a literal
{{KEY}} would have survived unchanged.
brooswit@kchb-ThinkPad-X1-Carbon-5th:/tmp/ac1-demo/notes$

$ crabcast deactivate /tmp/ac1-demo/notes
deactivated /tmp/ac1-demo/notes — now standby
  pane:          crabcast-notes-31e31d1b7540dabf
  session:       crabcast-notes-31e31d1b7540dabf-1785829987483

$ crabcast forget /tmp/ac1-demo/notes
forgot /tmp/ac1-demo/notes
  removed:       record, /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf (CrabCast's own sidecar: the rendered prompt and this record)

The record is gone and so is everything CrabCast wrote outside its own data directory that it could account for. /tmp/ac1-demo/notes itself was NOT touched: CrabCast never created it — `configure` may not `mkdir` — so it never deletes it, and nothing here removes anything recursively.

$ ls -a /tmp/ac1-demo/notes
.  ..

$ ls -a /tmp/ac1-demo/.crabcast/agents
.  ..
```

Five things in that session are worth reading twice, because each is CrabCast declining to round an answer up:

* **`configure` and `activate` are two verbs, and `activate` takes no attributes.** Everything the agent *is* lives on its record, so there is nothing an activation could pass that might disagree with it — and `activate` on a directory nobody configured refuses, naming what is missing, rather than inventing a priority and a launcher.
* **`list` reports ten `foreign panes`** — live agents this daemon did not start, which on this machine are its own unrelated fleet. They used to be invisible: "one of ours" was a pane name that started with `crabcast-`, so anything else was silently dropped. It is now a question the durable registry answers, and a foreign pane sitting in a directory you have configured is the thing that will make your next `activate` refuse. Better to see it coming.
* **The literal `{{KEY}}` reached the pane unchanged.** There is no interpolator. Render your prompt however you like — conditionals, loops, your own syntax — and hand over the result; CrabCast never looks at the bytes.
* **After the whole lifecycle, `/tmp/ac1-demo/notes` is empty.** Not "tidied up": nothing was ever written into it. The prompt went to the sidecar, this agent asked for no MCP servers so no `.mcp.json` was written, and `forget` removed the record and CrabCast's own sidecar — naming both rather than deleting quietly. The directory itself was never touched: CrabCast did not create it, so it does not delete it. [`docs/callers-directory.md`](docs/callers-directory.md) is the whole of what can appear in a directory you own, and how each of it comes back out.
* **`activate` says which conversation the agent got.** `started a NEW one` is CrabCast declining to resume whatever Claude Code history happens to sit at that path — because at a directory you own, that history is very often *yours*. It resumes only where its own record shows it ran before.

### When the directory is already occupied, `activate` refuses

Two agents in one directory is how work gets overwritten with neither of them finding out, so `activate` checks the directory before it spawns — and the check is a *separate question* from "is this pane ours". A freshly-configured agent has no pane recorded yet, so "not ours" is true of every pane in the world; reading that as "nothing is there" is exactly the bug this guard exists for.

This is a real refusal against a live agent from an unrelated fleet on the same machine:

```
$ crabcast configure /home/brooswit/.local/share/butchr/workspaces/task/kan-79 --priority 1 --launcher shell
configured /home/brooswit/.local/share/butchr/workspaces/task/kan-79
  pane name:     crabcast-kan-79-b9c315e8
  priority:      1
  launcher:      shell
  gate:          refusable true, chargeable true, preemptable true

live panes already in that directory (1):
  pane_id w65702dcc803d94-8  name butchr-task-kan-79  [done]  cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-79

Something is already running in /home/brooswit/.local/share/butchr/workspaces/task/kan-79. The record is written, but activate will REFUSE until that pane is gone — stand it down, then activate.

$ crabcast activate /home/brooswit/.local/share/butchr/workspaces/task/kan-79
FAILED: activate /home/brooswit/.local/share/butchr/workspaces/task/kan-79

Refusing to activate /home/brooswit/.local/share/butchr/workspaces/task/kan-79: 1 live pane(s) are already running in that directory and none of them is ours.
  pane_id w65702dcc803d94-8, name 'butchr-task-kan-79', agent_status done, cwd /home/brooswit/.local/share/butchr/workspaces/task/kan-79
NOTHING WAS STARTED. Two agents in one directory is how work gets overwritten and neither of them finds out. Stop the pane above, or point CrabCast at a different directory. This is not a claim on that pane: CrabCast never closes a pane it did not start.
  refused by:    occupied
  started:       false — NOTHING was spawned
[exit 1]
```

**`configure` reports the occupant; only `activate` refuses on it.** That asymmetry is deliberate and load-bearing: adopting a fleet of directories that already have agents in them means configuring them all, standing your own panes down, then activating. A `configure` that inherited the guard would fail every call on day one and make the required ordering undiscoverable.

**There is a third answer, and it is the one that would otherwise fail silently.** If herdr does not answer at all, the census comes back empty — which looks identical to "the directory is free". `activate` refuses that too, as *unverifiable*, and starts nothing: a check that renders its own failure as an all-clear would spawn into an occupied directory precisely when it cannot see it.

### Changing an agent's knobs never costs it its conversation

A supervisor that holds desired state will eventually find a configuration that differs from ours, and "if they differ, change them" needs an answer. **The answer is not uniform across attributes,** because the attributes are not the same kind of thing:

| attribute | on a **running** agent | why |
| --- | --- | --- |
| `priority` | **in place** | read out of the record at the moment a capacity or preemption decision is made |
| `refusable` / `chargeable` / `preemptable` | **in place** | census arithmetic only; nothing in the pane sees them |
| `label` | **in place** | nothing parses it |
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

```
$ crabcast activate /tmp/kan127/probe-a --override      # call #1
activated /tmp/kan127/probe-a
  session:       crabcast-probe-a-67445f2bd34e946a-1785828149851 (active)
  pane:          crabcast-probe-a-67445f2bd34e946a (w65702dcc803d94-14)
  verified:      true

$ crabcast activate /tmp/kan127/probe-a                 # call #2, no --override
/tmp/kan127/probe-a is already running — nothing was started
  pane:          crabcast-probe-a-67445f2bd34e946a (w65702dcc803d94-14)
  verified:      true

$ crabcast activate /tmp/kan127/probe-a                 # call #3, no --override
/tmp/kan127/probe-a is already running — nothing was started
  pane:          crabcast-probe-a-67445f2bd34e946a (w65702dcc803d94-14)
  verified:      true

$ crabcast activate /tmp/kan127/probe-a --json
{
  "action": "activate_response",
  "success": true,
  "path": "/tmp/kan127/probe-a",
  "paneName": "crabcast-probe-a-67445f2bd34e946a",
  "alreadyRunning": true,
  "started": false,
  "paneId": "w65702dcc803d94-14",
  "verified": true
}

$ herdr agent list | grep -c '"cwd": "/tmp/kan127/probe-a"'
1
```

**One pane, counted in herdr rather than assumed.** And the first call needed `--override` while the second and third did not: that machine was at capacity throughout, so a repeat activation that consulted the gate would have been refused. It does not consult it, because **an agent already running is already counted** — charging it a second slot would make a supervisor's idle poll look like a fleet twice the size.

**`alreadyRunning` and `started` are on every successful activation**, `true` or `false`. A field that appears only when true asks the caller to read meaning into an absence.

`deactivate` is the mirror, and it never answers a bare success:

```
$ crabcast deactivate /tmp/kan127/probe-a      # it was running
deactivated /tmp/kan127/probe-a — now standby

$ crabcast deactivate /tmp/kan127/probe-a      # and again
/tmp/kan127/probe-a was not running — standby
  No agent was running and its stand-down was already recorded. Nothing changed.
  alreadyGone:   true
[exit 0]

$ crabcast deactivate /tmp/kan127/probe-b      # configured, never activated
/tmp/kan127/probe-b was not running — unstarted
  This agent is configured but has never been activated. Nothing was running and nothing was
  recorded — a stand-down row would put it on the standby list, which promises that switching
  it back on resumes the conversation it was stopped in.
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

A capacity refusal is a normal outcome, not a malfunction, and it is the same command with a different answer. This is a real one, forced with `CRABCAST_MAX_AGENTS=0` so the transcript is reproducible on any machine:

```
$ crabcast activate /tmp/cap-demo/notes
FAILED: activate /tmp/cap-demo/notes

Refusing to activate /tmp/cap-demo/notes: at capacity — 0 charged agents are already running against a cap of 0.
machine: 4 cores, 15.4 GiB RAM (7.5 GiB available), load average 0.93
agent cost: 650 MB resident (seed), 0.75 core while active (seed)
  no live measurement; seed figures are the 2026-07-31 constants, not a measurement of this fleet
reserved for you: 1 core(s), 2.3 GiB
cap: 0 charged agents (set by CRABCAST_MAX_AGENTS, derivation skipped)
running: 0 charged agent(s)
headroom: 0 more — count allows 0 (0 cap − 0 running), load allows 2 ((4 cores − 1 reserved − 0.93 load) ÷ 0.75), memory allows 8 ((7.5 GiB available − 2.3 GiB reserved) ÷ 650 MB); bound by cap
Deactivate an agent to make room, or pass override: true to start it anyway (the override is recorded with these numbers).
Nothing running is below priority 1, so there is nothing this activation may stand down. Running: nothing is running that could be stood down. Preemption is strictly-greater: an agent may not displace one of its own priority.
  refused by:    capacity
  reason:        0 charged agents are already running against a cap of 0
  priority:      1
  started:       false — NOTHING was spawned
[exit 1]
```

Every term is reproducible by hand, and the headline names the *binding* constraint. An unforced refusal on a busy machine names the load average instead, and shows the same terms. Wait for room, stand something down, or pass `--override` and have the bypass recorded with the figures it bypassed.

**What an agent is worth is its own `priority`,** frozen on by `configure` — it used to be a property of its workspace type. And the single `gateExempt` flag that type carried is now three: `refusable` (may the gate refuse this agent), `chargeable` (does it occupy a slot), `preemptable` (may anything take it). They were always three different decisions, and bundling them meant you could not have an agent that costs a slot but can never be taken.

### Editing the config after the daemon is running

The daemon reads `crabcast.config.json` once, at boot — but there is very little in it now, and nothing about any agent: everything an agent is arrives through `configure`, at runtime, and takes effect without a restart. The only reason to restart is a changed `dataDir`, which is a different daemon.

There is no `crabcast daemon` that runs one in the foreground, and nothing above needed one. A config the daemon would refuse never reaches the daemon: the CLI loads it first and refuses with the reason, having attempted nothing.

```
$ crabcast --config bad.json list
crabcast: refusing to run: bad.json: "workspaceTypes" is no longer a config key — workspace types are gone: an agent is a directory plus the knobs a caller freezes onto it with `configure`. priority, prompt, launcher, mcpServers and the gate flags are now per-agent `configure` parameters rather than per-type config, so this declaration has no consumer. Remove the key; there is nothing to move it to in this file.
exit=4
```

A config still declaring `workspaceTypes` is **refused rather than ignored**. Dropping it silently would start a daemon that agrees with the file about nothing, and the first evidence would be an activation refused for a knob nobody knew had moved.

## The CLI

`crabcast` drives the daemon from a shell, so the system is complete with no browser anywhere.

```bash
crabcast configure <dir> --priority 1 --launcher claude   # make an agent EXIST, or change one
crabcast activate <dir>          # run it  (--override, --preempt; no other options)
crabcast list                    # the whole fleet, plus capacity
crabcast status <dir>
crabcast tail <dir> --lines 40   # its recent pane text, without attaching
crabcast send <dir> 'run the tests'
crabcast deactivate <dir>        # stop it; the record survives
crabcast forget <dir>            # make it stop EXISTING; deletes no directory
crabcast capacity                # how many more this machine can carry, and why
crabcast daemon-status           # pid, uptime, config, registry — and WHICH BUILD is running
```

Every agent-addressing command takes exactly one operand: the directory. There is nothing to disambiguate — two agents cannot share a directory the way they could share a key — so there is no `--type` flag and no ambiguity to resolve.

`configure`'s flags are `--priority` and `--launcher` (both required, neither defaulted), plus `--prompt <text>` or `--prompt-file <path>`, `--mcp a,b` and `--mcp-config <file>`, `--label`, and the gate triple `--refusable`/`--chargeable`/`--preemptable` (all default true, `--gate-exempt` is shorthand for all three false). It is also how an agent that already exists is **changed** — per attribute, refusing rather than respawning; see [above](#changing-an-agents-knobs-never-costs-it-its-conversation).

MCP servers arrive as **definitions rather than names** — the command, args and env that spawn each one — and are written into the agent's `.mcp.json` verbatim: `--mcp-config` reads them from a JSON file here and puts its *bytes* on the wire, the same hand-off `--prompt-file` makes. `--mcp` is for the one server CrabCast builds itself (`crabcast`), whose definition depends on facts about this daemon rather than about you. Supplying either **is** the consent to a `.mcp.json` appearing in your directory; there is no second flag, `configure`'s response names the file and keys it will write before anything is written, and `forget` takes them back out. Every server you asked for must be writable or the activation is refused — a `.mcp.json` holding only half of what you asked for is a file whose presence looks like success. [`docs/callers-directory.md`](docs/callers-directory.md) is the whole of what CrabCast writes into a directory you own, and how each of it comes back out.

The CLI is a client, not a second brain: it parses arguments, sends one action, and renders the answer. It never computes capacity, decides preemption, or infers whether an agent is alive — the daemon owns all of that. What it prints is what the daemon said, and a capacity derivation is printed **verbatim and unindented**, because the figures are the product.

* **`--json`** prints the daemon's response exactly as it arrived — every field, including the `id` the invocation used to correlate it. Nothing is dropped, renamed or reordered. Human-readable output is the default; anything the renderers do not recognise is printed anyway rather than swallowed.
* **Exit codes** are part of the contract: `0` success · `1` the daemon answered `success: false` (a capacity refusal lands here) · `2` usage error · `3` could not reach or spawn the daemon · `4` a config that was named would not load.
* **Config resolution** is `--config <path>`, else `$CRABCAST_CONFIG`, else `./crabcast.config.json` — the same rule the daemon and the MCP server use, from the same function. A config that was *named* and will not load is a refusal, never a silent fallback onto some other daemon.
* **Which commands start a daemon:** `configure`, `activate`, `deactivate`, `forget` and `send` spawn one if none is running; `list`, `status`, `tail`, `capacity` and `daemon-status` do not, and exit `3` instead. Spawning the daemon runs its boot reconcile, which re-activates every agent the durable registry expects — a fleet-sized side effect nobody asked for by typing `crabcast list`.
* **Messages that start with a dash are messages.** Flag parsing stops where `send`'s `<message...>` begins, so `crabcast send demo --help` types the text `--help` into the agent rather than printing this help and sending nothing. Quoting does not help with a leading dash — the shell eats the quotes — which is why the rule is in the parser rather than in a note. The trade is that a flag written *after* the message is message text (`crabcast send <dir> hi --timeout 5000` sends `hi --timeout 5000`); put flags before the operands. `--` still ends flag parsing for the commands with no trailing message, e.g. `crabcast status -- -odd-path`.
* **Capacity arithmetic:** `capacity` and a refused `activate` carry the daemon's derivation and print it verbatim. `list_agents` ships no derivation, so `list` prints the same figures as numbers — the cap and headroom terms and the machine they were read off — rather than dropping them.

`crabcast --help` is rendered from the command table exported by `src/cli.ts`, so every command it lists exists. `node scripts/verify-cli-refusal.mjs` is the live proof of the refusal, the exit codes, `--json`, and the `--override`/`--preempt` round trip.

## The daemon

One long-lived daemon per machine, listening on a Unix socket (`<dataDir>/crabcast.sock`, newline-delimited JSON, id-correlated). Nothing needs to start it: the CLI spawns a detached one on first need. From a repository checkout it can also be run in the foreground:

```bash
npm run build
node dist/daemon.js [configPath]
```

The config path is the first CLI argument, else the `CRABCAST_CONFIG` environment variable, else `crabcast.config.json` in the current directory. The whole of it is an optional `dataDir` — default `~/.local/share/crabcast`, and the socket, the log, the durable registry and each agent's sidecar live under it:

```json
{}
```

That is a complete, working config, and this repository ships exactly it. It used to declare a table of workspace types, each with a priority, a prompt file, a launcher and a gate flag; those are per-agent values a caller freezes on with `configure`, so there is nothing left for a config file to say about an agent.

Validation still refuses rather than repairs, on the two things that remain. A config declaring the retired `workspaceTypes` is refused by name (see above). And a `dataDir` whose socket path would exceed 104 characters is refused: a unix socket address is a fixed buffer and an over-long path is silently *truncated*, so the daemon would bind outside its own data directory, fail to chmod or unlink what it bound, and leave the next daemon reporting a stale socket file in a directory that is empty.

**The daemon also refuses to start against a durable registry it cannot fully read.** Records written before agents were addressed by path carry a `type` and a `key` and no path, and their priority, gate flags and prompt lived in the deleted `workspaceTypes` — so there is nowhere to get them from. Converting such a row would mean inventing values nobody decided, and loading the file part-way would mean some agents silently ceasing to exist. So the daemon names the file, the count and two remedies (delete the log, or hand-edit it) and stops.

Exactly one daemon owns the socket: a second daemon that finds a live socket exits 0; a stale socket file left by a crash is unlinked and reclaimed. `node scripts/daemon-status.mjs` round-trips a `daemon_status` request over the socket, and `node scripts/verify-config-and-socket.mjs` is the live proof of all of the above.

### Which build is running

`crabcast daemon-status` answers what the **running process** was built from — not what is in the directory it was started from. CrabCast is consumed as a linked local checkout (`file:../crabcast`), so there is no published artifact and no version string to ask for; without this, a fleet that misbehaves has nothing that can name the build that did it.

```
build — what THIS process was loaded from, read when it started:
  commit:          5657bfbb87bb8ddd3605c47d87643784b0bbfd0f
  checkout:        clean when this build was made
  built:           2026-08-04T07:44:47.072Z

freshness: PROCESS-PREDATES-BUILD
  THE RUNNING DAEMON IS NOT THE BUILD ON DISK. …/dist was rebuilt after this process loaded
  it, and the process is still executing what it read at boot … restart the daemon.
```

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
