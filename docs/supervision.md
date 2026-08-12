# Supervision: keeping the daemon alive across a reboot

**The decision (KAN-322): CrabCast ships a foreground daemon command and does
not supervise itself.** `crabcast daemon` runs the daemon in the foreground so
that systemd, launchd, a container runtime or any other process manager can own
it. CrabCast does not install a unit, does not enable anything, and does not
start at boot on its own. This page is the supported way to get a daemon that
outlives a reboot, and the unit below is a template you install, not something
the package does to your machine.

## The gap this answers

CrabCast starts a daemon in exactly one way: a **client** spawns one, detached,
on demand. Only the five write verbs do it — `configure`, `activate`,
`deactivate`, `forget`, `send` — and the read verbs (`list`, `status`, `tail`,
`capacity`, `daemon-status`) refuse with exit 3 rather than starting a fleet
nobody asked for. That is a deliberate design with real advantages, and the
README states it as a promise: *nothing starts a daemon by hand.*

The promise has no counterpart for the machine restarting, and three separate
things have to be true at once for that to matter — all three are:

1. **After a reboot there is no client.** Nothing runs, so nothing spawns.
2. **With no config named, no verb will spawn one either.** `resolveTarget`
   (`src/cli.ts`) falls back to the default data dir when nothing was named and
   sets `maySpawn: false`, deliberately — a daemon spawned without a config
   refuses to boot, so spawning there could only manufacture a confusing
   half-failure. The consequence is that even a *write* verb does not bring the
   socket back unless it is pointed at a loadable config.
3. **No consumer will do it.** A library client such as Butchr's `CrabCastLink`
   connects and retries; it has no spawn path at all, and its own refusal text
   tells the operator to go and run a write verb.

Put together: **after a reboot the socket is absent until a human notices, and
nothing says so.** The failure mode is silence, not an error. On the machine
this was found on, it lasted eight days.

## Why a foreground command rather than the alternatives

Four options were on the table (KAN-322). The reasoning, so that a later reader
can disagree with the decision rather than re-derive it:

* **Ship a foreground command — taken.** It is the smallest change that closes
  the gap and the only one that does not require CrabCast to have an opinion
  about anybody's init system. A supervisor of any kind can own the process.
* **Ship a systemd unit and an installer — not taken as code.** It buys a
  Linux-only answer, puts CrabCast in the business of writing into
  `~/.config/systemd`, and still needs the foreground command underneath. The
  unit ships here as a **documented template** instead, which costs a user one
  copy-paste and costs the project no install path to maintain.
* **Let a read verb spawn, or make the default data dir spawnable — rejected.**
  It would close the same gap by making `crabcast list` start a fleet, which is
  the ergonomics promise the read verbs exist to keep, and it would still not
  help after a reboot, because after a reboot nobody runs `crabcast list`
  either.
* **Declare that CrabCast does not supervise itself and stop — partly taken.**
  It is half the answer and it is written into the README, but on its own it
  leaves the operator with `node dist/daemon.js`, a path inside a checkout or
  inside a global `node_modules`. Documenting a gap is not the same as leaving
  somebody able to close it.

**What did not change.** Clients behave exactly as before: read verbs refuse,
write verbs spawn on demand, and the unnamed-config fallback still never spawns
into the default data dir. `crabcast daemon` adds a way to ask for a daemon *on
purpose*; it does not make one appear by accident.

**`node dist/daemon.js [configPath]` still works** and is the same program. It
remains the right thing from a checkout with no installed binary. The command
exists because that path is not reachable by name for anybody who installed
CrabCast normally — which is precisely the reader who needs a supervisor.

## The command

```
crabcast daemon [--config <path>]
```

It does not return. It serves until SIGINT or SIGTERM, and removes its socket on
the way out. Its exit status is the **daemon's**, not the CLI's client
exit-code table: `0` for a clean shutdown, non-zero for a refusal to boot. A
config that will not load is refused **before** the socket is created, so a
supervisor sees a failure rather than a daemon that came up serving nothing.

Running a second one against a data dir that already has a daemon is safe and
quiet: the loser detects the incumbent, says so on stderr, and exits `0` without
taking the socket. That behaviour is load-bearing for the restart policy below.

## A systemd user unit

A template. Replace the paths — `%h` is your home directory, and the two
absolute paths must be real on the machine you install this on.

**`ExecStart` needs an absolute path**, and where `crabcast` lives depends on
how node is installed: `~/.local/bin/crabcast` for some setups, somewhere under
`~/.nvm/versions/node/<version>/bin/` if you use nvm, `/usr/local/bin` for a
system node. Find yours and paste that:

```bash
command -v crabcast
```

Do not rely on a bare `crabcast` in `ExecStart` — systemd does not search a
shell `PATH` to resolve it.

```ini
[Unit]
Description=CrabCast daemon — shared agent orchestration
Documentation=https://github.com/wroosbit/crabcast
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/crabcast daemon --config %h/.config/crabcast/crabcast.config.json
# If node is not in one of those PATH entries — nvm is the common case — add its
# bin directory to PATH above. The `crabcast` shim starts `#!/usr/bin/env node`.
Restart=on-failure
RestartSec=2
SyslogIdentifier=crabcast

[Install]
WantedBy=default.target
```

Save it as `~/.config/systemd/user/crabcast.service` (create the directory if it
does not exist), then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now crabcast.service
loginctl enable-linger "$USER"     # so it starts at boot, not at first login
systemctl --user status crabcast
crabcast daemon-status             # the socket answers, not just "the unit is active"
```

That last line is the check worth actually running. `active` means systemd
started a process; it does not mean the daemon bound its socket, and the two
come apart exactly in the cases this page is about — a config it could not load,
or a `PATH` without `herdr` on it.

To undo all of it:

```bash
systemctl --user disable --now crabcast.service
rm ~/.config/systemd/user/crabcast.service
systemctl --user daemon-reload
```

`enable-linger` is not optional if you want this at boot. Without it a user
manager starts at your first login and stops at your last logout, which on a
headless machine means the daemon comes back when you ssh in — the failure this
page exists to prevent, arriving a few minutes later.

### `Restart=on-failure`, and why not `Restart=always`

This is the setting most likely to be "improved" by somebody who has not met the
race, so the reasoning is here rather than the value alone.

The CLI auto-spawns a daemon of its own. So two processes can contend for one
socket: a supervised daemon and one a client spawned a moment earlier. CrabCast
resolves that correctly by itself — the loser detects the winner's socket and
**exits 0**, cleanly, having changed nothing.

`Restart=always` restarts a clean exit. It would therefore restart that loser,
every `RestartSec`, forever, against a socket it can never win — manufacturing
exactly the thrash the race-resolution avoids, and doing it **invisibly**, since
nothing here is failing. `on-failure` leaves a clean exit alone.

`StartLimitBurst=5` / `StartLimitIntervalSec=60` bound the other direction: a
daemon that genuinely cannot start gives up into `failed` where `systemctl
status` shows it, instead of retrying quietly until somebody happens to look. **A
supervisor that silently restarts a broken thing is another green light over a
failure**, which is worse than no supervisor at all.

Measured rather than reasoned, on 2026-08-11 (KAN-320) and again on 2026-08-12
(KAN-322, `scripts/verify-daemon-foreground.mjs` §5): starting a second daemon
while an incumbent held the socket produced `Result=success`,
`ExecMainStatus=0`, `NRestarts=0` — a clean exit-0 loser, with the incumbent
still serving.

### `Environment=PATH=`, and why it is load-bearing

`PATH` has to carry two different things here, and they fail differently.

**`herdr`, and this is the silent one.** The daemon resolves `herdr` off `PATH`
**at startup**, and every agent it spawns is a herdr pane. A unit that inherits
an unexpected `PATH` therefore comes up **looking perfectly healthy and fails
every activation** — the daemon is running, the socket answers, `systemctl
status` is green, and nothing is wrong until you try to start an agent. This is
not hygiene; it was found the hard way (KAN-320).

**`node`, which fails loudly and immediately.** The installed `crabcast` is a
shim beginning `#!/usr/bin/env node`, so the directory holding `node` must be on
the pinned `PATH` as well. Miss it and the unit dies at once with a
`203/EXEC`-shaped failure — annoying, but it tells you. The template's `PATH`
covers a system node; **if you use nvm, node is under
`~/.nvm/versions/node/<version>/bin` and you must add it.**

Pin `PATH` to one that contains both, and check it with `crabcast daemon-status`
after install — then actually start an agent, because that is the only thing
that exercises the `herdr` half.

## What is predicted and what is observed

Stated plainly, because the distinction is easy to lose and this page would
otherwise read as a guarantee.

**Observed**, by `scripts/verify-daemon-foreground.mjs` on every CI run:

* `crabcast daemon` starts a daemon in the foreground and the socket answers —
  and the process answering is the foreground process itself, not a detached
  spawn.
* SIGTERM stops it with status 0 and releases the socket.
* A second daemon on the same data dir exits 0, says so, and leaves the
  incumbent serving.
* A config that will not load is refused non-zero before the socket exists.
* The `ExecStart` in this document names a command the CLI actually has.

**Observed once, on 2026-08-12, and not a guarantee:** that a machine with this
unit installed and `linger` enabled comes back with a working socket **after an
actual reboot**. Until that date this paragraph read "predicted, not observed",
and it named the two commands that would turn the prediction into an
observation. Somebody rebooted for their own reasons, those commands were run,
and they answered.

The machine went down cleanly at 03:52 PDT and came back up at 03:53:11.
`crabcast.service` was active again at 03:53:22 — eleven seconds later, with
nobody logged in and nothing started by hand. `systemctl --user show
crabcast.service` reported `ActiveState=active`, `MainPID=872` and
`NRestarts=0`: the unit fired at boot and had not been restarted since, so the
socket present at `~/.local/share/crabcast/crabcast.sock` was the one that unit
created. It was seen independently from the other side in the same window — a
peer's census found the socket reachable in 2259 ms on its first attempt, with
no errno.

**What that one observation does not establish.** It is one reboot, on one
machine, on one distribution and init — systemd user units with `linger`
enabled. It was a clean `shutdown`, so it says nothing about a machine coming
back from a crash or a power cut, which is the case where a stale socket file
is left behind for the new daemon to trip over. And nothing in CI observes any
of it: a GitHub runner has no user session bus, so no check in this repository
fires a reboot and none can. Do not let one observation harden into "handled" —
it is evidence, and it stays evidence until somebody records the second one.

If you install this and then reboot for your own reasons, `systemctl --user
status crabcast` and `crabcast daemon-status` afterwards are still the two
commands worth running, and the result is still worth adding here.
