# Setting up CrabCast

This is the whole of standing a CrabCast up on a machine that has none of our
state: prerequisites, install, config, a daemon that survives a reboot, the
checks that say it is actually serving, how to point Butchr at it, and how to
cross a version boundary afterwards.

**It is written for somebody who cannot read the source and has no one to ask.**
That is [KAN-546](https://wroosbit.atlassian.net/browse/KAN-546)'s standard, and
it decides the shape of this page rather than only its audience: for that reader
**a false green is worse than a crash** — a crash says stop, and a false green
says proceed. So every step that this document calls *required* is followed by
what breaks when it is skipped, in the words the machine actually printed. Where
a step could not be driven red here, the page says so and says why, rather than
leaving a claim standing on nobody's evidence.

**What this page is not.** It is not the tour — [`../README.md`](../README.md)
is, and it is where the walkthrough, the CLI reference, the capacity model and
the contracts live. This page cites it rather than restating it, because two
copies of an install sequence drift and the reader cannot tell which one is
current.

Everything below was run on **2026-08-21**, on Linux, Node **v20.20.2**, npm
**10.8.2**. Figures are readings with a date on them, not constants.

---

## 0. What you are installing

One long-lived **daemon** per machine, a **CLI** that drives it, and nothing
else. The daemon spawns each agent as a [herdr](https://herdr.dev) pane in a
directory you already own; CrabCast never creates that directory and never
deletes it.

There is **no service, no autostart and no init-system opinion in the package**.
CrabCast does not supervise itself — §4 is where you give it a supervisor, and
[`supervision.md`](supervision.md) is the decision behind that.

There is also **no published npm package**. `crabcast` on the registry is not
this project; the install is from a clone (§2), and `"private": true` in
`package.json` is what keeps it that way deliberately.

---

## 1. Prerequisites

### 1.1 Node.js 20 or newer

```bash
node --version      # v20.20.2 here
```

⚠ **Nothing enforces this, and that is the part worth knowing.** The bound lives
in `engines` in `package.json`, this repository ships no `.npmrc`, and
`npm config get engine-strict` reads `false` — so npm *warns* on an older Node
and installs anyway. There is no gate that will stop you; there is a compiled
`ES2022` target that will fail somewhere later, at a time and in a message that
has nothing to do with your Node version.

> **Not driven red here.** Doing so needs a second Node on the machine, and this
> one has only v20.20.2. What is established is the absence of the gate — the
> missing `.npmrc` and the `engine-strict false` reading above — not the
> behaviour past it.

### 1.2 herdr 0.6.4 — a hard prerequisite

**Every agent CrabCast starts is a herdr pane.** With no `herdr` on `PATH`,
every activation fails. Install **0.6.4 specifically**; the install block, the
four platform assets, and the reasoning behind the pin are in
[the README's Requirements section](../README.md#herdr-064), which is the single
copy of it.

The rule in one line: **do not "get the latest".** herdr 0.7 redesigned
`agent start` and dropped the `--cwd` this spawn path passes on every
activation; 0.7.5 and 0.8.0 were run against CrabCast and **every activation
failed**. `npm install herdr` installs nothing — that package is the author's
own name reservation and ships no binary.

```bash
herdr --version     # must print: herdr 0.6.4
```

**What breaks when you skip it — driven, on this machine.** This box has herdr
**0.8.2** installed, so the failure is not hypothetical here. The daemon draws
the version bands at startup and says so before it answers anything:

```
[2026-08-21T20:33:34.465Z] herdr version: herdr 0.8.2
[2026-08-21T20:33:34.465Z] WARNING: herdr 0.8.2 is above the herdr line CrabCast is
verified against (0.6.4) and CrabCast has not been tested on it. That is an unknown,
not a known breakage — nobody has run this release, so it may well work. What is known
about its neighbours is not encouraging: every release above the line that HAS been run
(0.7.5, 0.8.0) failed at 'herdr agent start' with 'unknown option: --cwd', which 0.7
dropped and nothing has restored. Installing 0.6.4 puts you on the tested path.
```

The same notice is printed above the answer to every CLI command, once, so it
cannot be missed by somebody who never reads a log.

⚠ **It reports; it does not veto.** The daemon will run for you on 0.8.2. The
socket answers, `daemon-status` is green, and the first thing that fails is an
activation — which is exactly the shape §5 asks you to guard against.

> **The `herdr`-missing-entirely case was not driven here**, and the reason is
> worth stating rather than eliding: `resolveUserPath()` (`src/env.ts`)
> unconditionally appends `~/.local/bin` to the PATH it builds, and this
> machine's herdr lives there — so producing that red would mean moving the
> binary a live fleet depends on. An undriveable leg named beats a leg broken to
> prove a point. What *is* driven is the version band above.

### 1.3 git, and a compiler you do not install

`git` is needed for the clone, and for the build stamp that lets the daemon say
which commit it is running (§5.2, §6). The TypeScript compiler arrives as a
devDependency — you never install it yourself, and §2 is where skipping that
step goes wrong.

---

## 2. Clone and install

```bash
git clone https://github.com/wroosbit/crabcast.git
cd crabcast
npm install        # installs dependencies AND compiles dist/
npm install -g .   # puts `crabcast` on PATH
crabcast --help    # every command it lists exists
```

**You never run a build step by hand.** `package.json` declares
`"prepare": "npm run build"`, and npm runs `prepare` as part of `npm install` —
so the first command leaves you with a compiled, *stamped* `dist/`. `npm run
build` exists for contributors iterating on the source; it is not a step in this
sequence.

**Both commands are required, in that order.** — driven:

```console
$ git clone <clone> freshclone && cd freshclone
$ npm install -g .                       # skipping `npm install`
npm error code 127
npm error command sh -c npm run build
npm error > crabcast@0.1.0 build
npm error > tsc
npm error sh: 1: tsc: not found
INSTALL_G_WITHOUT_NPM_INSTALL_EXIT=127
```

Installing a directory globally does not install that directory's
devDependencies, so `prepare` has no compiler to call. This is a real limitation
of this install path, not a step worth skipping.

If you have previously run `npm link` from a CrabCast clone, remove that link
first (`npm rm -g crabcast`) — npm cannot replace the symlink a link leaves
behind with a real directory, and the install fails with `ENOTDIR ... rename`.

⚠ **Read [§7](#7--the-clone-you-installed-from-is-the-deploy-artefact) before you
treat this clone as scratch.** On the npm measured here, `npm install -g .`
leaves a **symlink into this clone**, not a copy — so rebuilding it later is a
live deploy. That is a property of the supported install path, not of an unusual
one, and §7 is where it is measured and what to do about it.

---

## 3. Configure

### 3.1 The file

The whole config is an optional `dataDir`. This repository ships a complete,
working one:

```json
{}
```

With nothing set, `dataDir` is `~/.local/share/crabcast`, and the socket, the
log, the durable registry and each agent's sidecar live under it.

Config resolution is the same rule for the CLI, the daemon and the MCP server:
`--config <path>`, else `$CRABCAST_CONFIG`, else `./crabcast.config.json` in the
current directory.

For a supervised install (§4) put it somewhere the unit can name, e.g.:

```bash
mkdir -p ~/.config/crabcast
printf '{}\n' > ~/.config/crabcast/crabcast.config.json
```

### 3.2 ⚠ A config that was *named* and will not load is a refusal, never a fallback

This is the rule that stops a typo pointing you at somebody else's daemon. It
exits **4**, and it does so *before* a socket exists — which is what lets a
supervisor see a failure rather than a daemon serving nothing.

Two refusals you can meet on day one, both driven:

**A retired key.** Configs written before agents were addressed by path declare
`workspaceTypes`. It is refused by name rather than ignored:

```console
$ crabcast --config retired.config.json daemon-status
crabcast: refusing to run: …/retired.config.json: "workspaceTypes" is no longer a
config key — workspace types are gone: an agent is a directory plus the knobs a
caller freezes onto it with `configure`. … Remove the key; there is nothing to move
it to in this file.
EXIT=4
```

**A `dataDir` whose socket path is too long.** A unix socket address is a fixed
buffer and an over-long path is silently *truncated* — the daemon would bind
outside its own data directory, fail to chmod or unlink what it bound, and leave
the next daemon reporting a stale socket file in a directory that is empty. So
it is refused at load, with the arithmetic:

```console
$ crabcast --config toolong.config.json daemon-status
crabcast: refusing to run: …/toolong.config.json: "dataDir" is too long — its socket
path is 174 characters and a unix socket address holds at most 104 (108 on Linux, 104
on macOS; the smaller is used so a config that loads here loads there). … Shorten the
dataDir.
  dataDir: …/cc-scratch/xxxxxxxx…
  socket:  …/cc-scratch/xxxxxxxx…/crabcast.sock
EXIT=4
```

**104 is the budget for the whole socket path**, including the `dataDir`, a
separator and `crabcast.sock`. Check yours before you commit to it:

```bash
D=~/.local/share/crabcast
printf '%s/crabcast.sock' "$D" | wc -c      # must be <= 104
```

---

## 4. Run the daemon, and keep it running

### 4.1 The foreground command

```bash
crabcast daemon [--config <path>]
```

It does not return. It serves until SIGINT or SIGTERM and removes its socket on
the way out. **Its exit status is the daemon's own** — `0` for a clean shutdown,
non-zero for a refusal to boot — rather than the CLI's client exit-code table,
because nothing here asked a daemon anything.

From a checkout with nothing installed, `node dist/daemon.js [configPath]` is
the same program.

### 4.2 ⚠ Nothing starts it at boot, and the failure mode is silence

**CrabCast installs no service and starts nothing at boot.** That is deliberate
(it keeps CrabCast out of the business of having an opinion about your init
system), and it has a consequence that has cost real time:

1. After a reboot there is no client, so nothing spawns a daemon.
2. With no config *named*, no verb spawns one either — the CLI falls back to the
   default data dir and deliberately refuses to spawn into it.
3. A library consumer such as Butchr's `CrabCastLink` connects and retries; it
   has no spawn path at all.

**So after a reboot the socket is absent until a human notices, and nothing says
so.** On the machine this was found on, that lasted **eight days**.

**And the read verbs will not rescue you** — driven:

```console
$ crabcast --config …/crabcast.config.json daemon-status
crabcast: Could not reach the CrabCast daemon at …/data/crabcast.sock:
connect ENOENT …/data/crabcast.sock
This command does not start a daemon (see `crabcast --help`). Run any of
  configure, activate, deactivate, forget, send
and one is spawned if none is running. To run one in the foreground — which is
what a supervisor such as systemd should own — run:
  crabcast daemon [--config <path>]
EXIT=3
```

`list`, `status`, `tail`, `capacity` and `daemon-status` all exit `3` rather than
starting a fleet nobody asked for. Only `configure`, `activate`, `deactivate`,
`forget` and `send` spawn one.

### 4.3 Give it a supervisor

**[`supervision.md`](supervision.md) is the whole of this step** — the systemd
user unit template, `loginctl enable-linger`, the uninstall, and the two
settings in it that are load-bearing rather than taste. Do not paraphrase it
from memory; two of its settings look like preferences and are not:

* **`Restart=on-failure`, never `Restart=always`.** The CLI auto-spawns a daemon
  of its own, so two processes can contend for one socket. CrabCast resolves
  that correctly — the loser detects the incumbent and **exits 0**, cleanly.
  `Restart=always` would restart that clean loser forever against a socket it
  can never win, invisibly, because nothing is failing.

  Driven here:

  ```console
  $ crabcast --config …/crabcast.config.json daemon        # a second one
  crabcast: a daemon is already running on …/data/crabcast.sock and is serving;
  this one is exiting 0 without taking the socket. Nothing is wrong and nothing was
  changed — use `crabcast daemon-status` to see the one that is running.
  SECOND_DAEMON_EXIT=0
  ```

* **A pinned `Environment=PATH=`.** The daemon resolves `herdr` off `PATH` **at
  startup**. A unit that inherits an unexpected `PATH` comes up looking
  perfectly healthy and **fails every activation** — the socket answers,
  `systemctl status` is green, and nothing is wrong until you try to start an
  agent. The `node` half of the same variable fails loudly instead (`203/EXEC`),
  because the installed `crabcast` is a `#!/usr/bin/env node` shim.

**And SIGTERM releases the socket** — driven, so that a `systemctl restart` is
known to leave a clean rendezvous rather than a stale file:

```console
$ kill -TERM <pid>
socket after SIGTERM: ls: cannot access '…/data/crabcast.sock': No such file or directory
process: gone
```

---

## 5. Check that it worked

`systemctl status` reporting `active` means systemd started a process. It does
**not** mean the daemon bound its socket, and the two come apart exactly in the
cases §3.2 and §4.3 are about. These are the checks that can tell the
difference.

### 5.1 The socket answers

```bash
crabcast daemon-status
```

A serving daemon prints a header, a **build** block and a **freshness** block:

```
daemon: running
  pid:           613280
  started:       2026-08-21T20:33:34.488Z
  config:        …/cc-scratch/crabcast.config.json
  data dir:      …/cc-scratch/data
  registry:      …/cc-scratch/data/agents.jsonl
  agents:        0 configured, 0 expected to be running
  events:        bootId dcdabefd-5443-46ec-90dd-214af9792b69, 0 published since boot
  read contract: v14 (docs/read-path-contract.md)
```

⚠ **The failing branch of this check is `EXIT=3`, and it is reachable** — §4.2
is that same command against a machine with no daemon. That is what makes a
green here a reading rather than a formality.

### 5.2 The build block is the answer to "which code is running"

CrabCast is consumed as a local checkout, so there is no version string to ask
for. `daemon-status` answers what the **running process** was loaded from:

```
build — what THIS process was loaded from, read when it started:
  commit:          662d18fba869bc6985a3b68bb5c67d7d34c3b25d
  checkout:        clean when this build was made
  built:           2026-08-21T20:33:01.200Z
  loaded from:     …/crabcast/dist
  stamp:           …/crabcast/dist/build-stamp.json
  read at:         2026-08-21T20:33:34.503Z

freshness: CURRENT
  This daemon is running the build that is on disk, and that build is newer than
  …/crabcast/src.
  running the build on disk: yes
  sources newer than build:  no
  compared by:               build-stamp
```

`compared by: build-stamp` is the line that says which comparison was
*available*. A `dist/` with no stamp — one built by running `tsc` directly — is
compared by file times instead, and that line then says so. **"I don't know" is a
first-class answer here and never renders as "clean."**

### 5.3 A read verb round-trips

```bash
crabcast list
```

On a healthy empty install this prints `agents (0)` and a capacity block. ⚠ **On a
machine that is already running a herdr fleet it will also print a `foreign
panes` section listing every pane CrabCast did not start** — that is correct and
expected, not a sign that something has been adopted:

```
agents (0)
  (none)

foreign panes (17) — live agents this daemon did not start
  butchr-task-kan-603 [working]  runtime claude  pane_id w1:pE
    cwd /home/…/workspaces/task/kan-603
  …
```

### 5.4 Then actually start an agent

The three checks above all pass on a machine whose `PATH` has the wrong `herdr`
or none at all, because none of them spawns a pane. **Activation is the only
thing that exercises that half**, and it is the check §1.2 and §4.3 both point
at. Configure a throwaway directory you own, activate it, and read the result:

```bash
mkdir -p /tmp/cc-smoke
crabcast configure /tmp/cc-smoke --priority 1 --launcher shell
crabcast activate  /tmp/cc-smoke
crabcast status    /tmp/cc-smoke
crabcast deactivate /tmp/cc-smoke && crabcast forget /tmp/cc-smoke
```

> **Driven only as far as `configure` and `list` here**, both of which returned
> `EXIT=0` against a scratch daemon. `activate` was **not** run: this machine has
> herdr 0.8.2 (§1.2), where activation is expected to fail at `herdr agent
> start` — and it shares its herdr server with a live fleet, so producing that
> red would have spawned a pane into it. On a machine with 0.6.4 this sequence
> is the check that matters most.

---

## 6. Pointing Butchr at it

This section is the other side of a seam. **Butchr's own
[`docs/SETUP.md` §12](https://github.com/wroosbit/butchr/blob/main/docs/SETUP.md)**
covers the same boundary from its side; read them together, because the two
halves are in different repositories and neither install fetches the other.

**Butchr does not install, fetch or start CrabCast.** A Butchr install that
follows its own document end to end runs the **herdr** runtime — that is its
default and its supported path. CrabCast is selected deliberately, on the Butchr
side, by one environment variable read **once, at daemon construction**:

| variable | who reads it | effect |
| --- | --- | --- |
| `BUTCHR_AGENT_RUNTIME=crabcast` | Butchr's daemon | serve agents through CrabCast (`CrabCastRuntime`) instead of `HerdrBridge`. Unset, empty or misspelled falls back to herdr **and says so** |
| `BUTCHR_CRABCAST_SOCKET` | Butchr's daemon | which socket to reach CrabCast on. Defaults to `~/.local/share/crabcast/crabcast.sock` |

⚠ **If you changed `dataDir` in §3, you must set `BUTCHR_CRABCAST_SOCKET` to
match.** Butchr's default is the *stock* CrabCast socket path, not a value it
discovers — the two configurations are independent files in independent
repositories, and nothing reconciles them. A mismatch is a Butchr-side refusal
naming the leg that refused it, not a CrabCast fault.

Ask each machine rather than assuming, on both boxes:

```bash
# CrabCast side — is a daemon serving, and on which socket?
crabcast daemon-status

# Butchr side — which runtime did its daemon actually construct?
node daemon/scripts/butchr-doctor.mjs | grep -i runtime
ls ~/.config/systemd/user/butchr-daemon.service.d/
```

The drop-in directory is the part worth looking at directly: it is where a
deployment's real configuration accumulates, and **neither project's install
document writes anything into it**. Two machines that both followed both
documents to the letter can still be running different products because one has
a drop-in the other does not.

> **Measured on the machine this page was written on, 2026-08-21.**
> `butchr-doctor` reported `runtime herdr (from the default)`, there is no
> `crabcast.conf` drop-in, and `~/.local/share/crabcast/` does not exist — this
> box is a Butchr **worker** fleet on the herdr runtime, and no CrabCast daemon
> has ever run on it. The CrabCast-backed deployment referenced elsewhere on
> the board is a **different machine**. Do not read either machine's state as a
> fact about the fleet.

### What Butchr pins, and what it does with a mismatch

Butchr's adapter records the CrabCast commit and read-path contract version it
was proved against, reports both, and **logs a mismatch rather than refusing**.
Refusing would be Butchr pressuring CrabCast's release cadence, which its own
ticket forbids.

Read at `wroosbit/butchr@origin/main` on 2026-08-21, against CrabCast
`origin/main` at `662d18f`:

| | Butchr's adapter was proved against | CrabCast `main` serves today |
| --- | --- | --- |
| commit | `8d7348fa9820…` (`CRABCAST_PIN`) | `662d18fba869…` |
| read-path contract | `8` (`CRABCAST_CONTRACT_VERSION`) | **`v14`** |

Both differ, and **both are expected to differ** — that is the ordinary state of
a pin, and it is reported so an operator can see it rather than discover it.
What the pin buys is that a surprise is *legible*: Butchr logs

```
peer publishes read-path contract v<N>, this adapter was proved against v8.
Reporting, not refusing — and note the contract covers list_agents and
agent_status only, so a matching version is not a statement about
activate_response.
```

⚠ **A matching version number is not a compatibility guarantee.** CrabCast
publishes **no compatibility guarantee below 1.0**. What it promises instead is a
*notice*: a documented read-path field will not change without a consumer notice.
That promise explicitly does not cover fields not changing, backward
compatibility, a deprecation period, or the notice arriving before you have
already pulled.

---

## 7. ⚠ The clone you installed from is the deploy artefact

**Measured here, by construction, on npm 10.8.2 — not quoted.**

`npm install -g .` from a clone does **not** copy that clone. npm installs a
local directory specifier as a **symlink**, so the installed `crabcast` resolves
straight back into the directory you ran it from:

```console
$ ls -l <prefix>/lib/node_modules/
lrwxrwxrwx  crabcast -> ../../../../crabcast

$ readlink -f <prefix>/bin/crabcast
…/kan-601/crabcast/dist/cli.js
$ ls -Li "$(readlink -f <prefix>/bin/crabcast)"   # inode
1846358
$ ls -Li <clone>/dist/cli.js                      # inode
1846358                                           # ← the same file
```

`npm link` produces the identical result. **The positive control is what makes
that a reading rather than an artefact of the method** — the same measurement
against a packed tarball install gives a real directory and a different inode:

```console
$ npm pack && npm install -g crabcast-0.1.0.tgz
$ ls -l <prefix>/lib/node_modules/
drwxrwxr-x  crabcast                              # a real directory, not a link
$ ls -Li "$(readlink -f <prefix>/bin/crabcast)"
1978169                                           # ← different inode
```

### What follows from it

**`git checkout` + `npm run build` in that clone is a live deploy of every
subsequent `crabcast` invocation on the machine.** Not a staged one, not one that
needs a restart: the next command runs the new code.

**The running daemon is the exception, and it is the confusing half.** A daemon
holds the `dist/` it loaded at boot, so a rebuild underneath it changes the CLI
immediately and the daemon not at all — the two disagree, and nothing on the
filesystem shows it. That is what `freshness: PROCESS-PREDATES-BUILD` is for
(§8).

**If you want an install that does not redeploy when you touch the clone**,
install the packed tarball instead of the directory:

```bash
npm pack                                # → crabcast-0.1.0.tgz
npm install -g ./crabcast-0.1.0.tgz     # a real copy; rebuilding the clone
                                        # no longer changes what is installed
```

The cost is that upgrading is then a deliberate `pack` + `install` rather than a
`git pull` and a build — which is the point.

### Which ticket owns this

[KAN-463](https://wroosbit.atlassian.net/browse/KAN-463) is the ticket for the
dual-role clone, and it is **Butchr's**, not this one's: it covers
`~/code/wroosbit/butchr` being both the shared clone agents branch from and the
live deploy checkout the Butchr daemon executes. It puts
`~/code/wroosbit/crabcast` **explicitly out of scope** — *"CrabCast's own live
deploy checkout. Do not build it, do not `npm install` in it, do not document it
here. Not ours."*

So the CrabCast side of this hazard was owned by nobody, which is why it is
written down here rather than deferred. This section documents the property of
the install path; it changes no deploy mechanism and automates nothing.

---

## 8. Upgrading

An install that cannot cross a version boundary is
[KAN-546](https://wroosbit.atlassian.net/browse/KAN-546)'s first criterion, so
this section exists for the reader on day thirty rather than day one.

### 8.1 Which commit am I on

```bash
crabcast daemon-status        # `build:` block — the RUNNING process
git -C <clone> rev-parse HEAD # what is on disk
```

Read the first, not the second. The build block is the only thing that can tell
you what the running daemon was loaded from; the clone tells you what the next
`crabcast` invocation will run (§7), which is a different question and, in the
middle of an upgrade, a different answer.

### 8.2 The upgrade

```bash
cd <clone>
git pull
npm install            # runs `prepare`, so this rebuilds and re-stamps dist/
# then restart the daemon — see below
```

### 8.3 ⚠ Rebuilding does not upgrade a running daemon, and nothing on disk shows it

Driven, in both directions.

**Red** — rebuild under a live daemon:

```console
$ touch src/router.ts && npm run build          # REBUILD_EXIT=0
$ crabcast daemon-status
freshness: PROCESS-PREDATES-BUILD
  THE RUNNING DAEMON IS NOT THE BUILD ON DISK. …/crabcast/dist was rebuilt after this
  process loaded it, and the process is still executing what it read at boot
  (2026-08-21T20:33:01.200Z); the build on disk is 2026-08-21T20:34:11.798Z. Nothing on
  the filesystem shows this — restart the daemon to pick the new build up.
  running the build on disk: no
  sources newer than build:  no
  compared by:               build-stamp
```

**Green** — restart, and read it again:

```console
$ kill -TERM <pid> && crabcast daemon            # or: systemctl --user restart crabcast
$ crabcast daemon-status
freshness: CURRENT
  This daemon is running the build that is on disk, and that build is newer than
  …/crabcast/src. Evidence: the stamp in …/crabcast/dist (built
  2026-08-21T20:34:11.798Z) is the one this process read at boot.
  running the build on disk: yes
```

The third state, `build-predates-sources`, means `src/` has changed since `dist/`
was built — run `npm run build`.

⚠ **A restart is a fleet event, not a no-op.** Starting the daemon runs its boot
reconcile, which re-activates every agent the durable registry expects. Do the
upgrade when you are willing to have that happen.

### 8.4 What to check on the Butchr side afterwards

Re-read §6's table. Moving CrabCast moves the commit and may move the read-path
contract version out from under a Butchr adapter that was proved against an
older one — which Butchr **reports and does not refuse**, so it will not stop
you and will not stop itself. The Butchr daemon log at boot is where the pin
comparison is stated.

### 8.5 The upgrade that is not this one

**herdr.** Do not "get the latest" — §1.2. Crossing that boundary is
[KAN-182](https://wroosbit.atlassian.net/browse/KAN-182)'s work, not an upgrade
step, and until it lands the supported answer is 0.6.x. `scripts/verify-herdr-release.mjs`
is how a release earns a row in the README's table, and it never touches the
herdr you are running.

---

## 9. Uninstall

```bash
# if you supervised it (§4.3)
systemctl --user disable --now crabcast.service
rm -f ~/.config/systemd/user/crabcast.service
systemctl --user daemon-reload

npm rm -g crabcast              # removes the symlink or the copy (§7)
rm -rf ~/.local/share/crabcast  # socket, log, registry, sidecars — check first
```

`loginctl disable-linger "$USER"` if nothing else on the machine wants it.

**CrabCast created none of your agent directories and deletes none of them.**
What it wrote *into* them — a `.mcp.json`, where you asked for MCP servers — is
taken back out by `crabcast forget`, and
[`callers-directory.md`](callers-directory.md) is the whole of what it ever
writes there.

---

## 10. What is observed here, and what is not

Stated plainly, because this page would otherwise read as a guarantee.

**Observed on 2026-08-21, on this machine, and reproduced in the PR that added
this page:**

* `npm install -g .` from a clone that never ran `npm install` fails `127` at
  `tsc: not found`.
* A named config that will not load exits `4` before any socket exists — both
  the retired-key and the over-long-`dataDir` refusals.
* A read verb against a machine with no daemon exits `3` and starts nothing.
* `crabcast daemon` serves; `daemon-status` answers `EXIT=0`; `configure` and
  `list` round-trip.
* A second daemon on a live socket exits `0` without taking it.
* SIGTERM stops the daemon and removes the socket.
* A rebuild under a live daemon reads `PROCESS-PREDATES-BUILD`, and a restart
  returns it to `CURRENT`.
* The daemon's herdr band notice fires on herdr 0.8.2.
* `npm install -g .` and `npm link` both leave a symlink into the clone (same
  inode); a packed-tarball install does not (different inode) — positive control
  run.

**Not observed, and not claimed:**

* **A full install on a genuinely clean machine.** Every step above was run
  against a clone and a scratch data directory on a box that already has Node,
  git and a herdr. That rehearsal is
  [KAN-546](https://wroosbit.atlassian.net/browse/KAN-546)'s *"one check nobody
  has run"*, and it is still unrun.
* **An activation.** §5.4 — this machine's herdr is 0.8.2 and its herdr server is
  shared with a live fleet.
* **Anything about Node below 20** — §1.1.
* **A reboot.** [`supervision.md`](supervision.md) records the one clean-shutdown
  reboot that was observed, on one machine and one init, and says what that one
  observation does not establish. Nothing in this repository's CI fires a reboot
  and nothing can.
* **macOS or the BSDs.** The 104-character socket budget is chosen so a config
  that loads on Linux loads there; nobody has run this page on one.
* **Windows.** herdr publishes no stable Windows asset and CrabCast has never
  been run there.

If you follow this page on a machine it has not been run on, the findings are
worth adding here — including the ones where it was simply right.
