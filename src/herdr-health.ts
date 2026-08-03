import * as fs from 'fs';

/**
 * Why an agent failed to spawn, in words a human can act on.
 *
 * herdr reports spawn failures as a bare code — `ghostty error -2` is the one
 * that cost an afternoon in the extraction source (KAN-24) — and that daemon
 * used to discard even that, attaching to an agent that did not exist and
 * reporting success. The point of this module is that whatever we say when a
 * spawn fails must name a cause and a next step, because the alternative is a
 * mystery outage.
 *
 * It lives outside herdr.ts deliberately: that file is contended by several
 * concurrent tickets, and none of this needs to be in it.
 */

/**
 * Open `/dev/ptmx` descriptors the herdr server holds per pane. Measured on
 * herdr 0.6.4, and it is exactly 5 — one pty master plus four dup()s of the
 * same open file description (portable_pty hands out a reader clone and a
 * writer clone; herdr keeps a further dup for its live-handoff path).
 *
 * It is a constant, not a leak: closing a pane returns all five. It is used
 * here only to turn an fd count into a number of panes, which is the unit a
 * human reasons in.
 */
export const PTMX_FDS_PER_PANE = 5;

/**
 * Fraction of the soft limit above which fd usage is worth mentioning
 * unprompted. Below this, quoting descriptor counts at someone debugging an
 * unrelated failure is just noise.
 */
export const FD_PRESSURE_WARN_RATIO = 0.75;

/**
 * The default open-file soft limit on Linux, which is also `FD_SETSIZE` — the
 * largest descriptor `select(2)` can represent. A herdr server left here is
 * capped at {@link PTMX_FDS_PER_PANE} descriptors per pane, i.e. ~205 panes,
 * after which every `agent start` fails.
 *
 * This constant exists so a machine whose limit was never raised says so at
 * startup instead of discovering it as an outage — which is exactly how it
 * went the first time in the extraction source (KAN-24, KAN-33).
 */
export const FD_SETSIZE = 1024;

/**
 * True when herdr is running on the stock ceiling, i.e. the nofile limit was
 * never raised for it or the raise was lost to a restart. Distinct from
 * {@link isFdPressureHigh}: that fires when the limit is nearly *reached*,
 * this fires the moment the limit is known to be too low, whether or not
 * anything is close to it yet.
 */
export function isFdCeilingUnraised(usage: FdUsage): boolean {
  return usage.softLimit <= FD_SETSIZE;
}

/** One line naming the ceiling in panes, and how to raise it. */
export function describeFdCeiling(usage: FdUsage): string {
  return (
    `herdr server (pid ${usage.pid}) has an open-file soft limit of ${usage.softLimit}, the stock default. ` +
    `At ${PTMX_FDS_PER_PANE} descriptors per pane that caps it at ~${Math.floor(usage.softLimit / PTMX_FDS_PER_PANE)} ` +
    `panes, after which every 'herdr agent start' fails. Raise the nofile limit for the herdr ` +
    `server permanently (e.g. a systemd drop-in setting LimitNOFILE=65536 for its service, or ` +
    `your init system's equivalent), or for the running server: ` +
    `prlimit --pid ${usage.pid} --nofile=65536:1048576`
  );
}

/** How close the herdr server is to its open-file ceiling. */
export interface FdUsage {
  pid: number;
  openFds: number;
  softLimit: number;
  /** Further panes the remaining descriptors could support. */
  headroomPanes: number;
  /** openFds / softLimit, 0..1. */
  ratio: number;
}

/** {@link FdUsage} plus the pty-master breakdown, which costs a scan to get. */
export interface FdPressure extends FdUsage {
  ptmxFds: number;
  /** Panes the ptmx count implies, at the measured cost per pane. */
  estimatedPanes: number;
}

/**
 * The pid of the running herdr server, or undefined if we cannot find one.
 *
 * Read from /proc rather than by shelling out to pgrep: this runs on a failure
 * path that is already slow and already unhappy, and it must not add a process
 * spawn to a machine that may be out of descriptors.
 *
 * CrabCast talks to one herdr server, so the first match is the right one. If
 * a second server is running (a scratch instance on its own HERDR_SOCKET_PATH,
 * as the verify scripts start), which of the two this finds is unspecified —
 * acceptable because the result is only ever used to enrich an error message.
 */
export function findHerdrServerPid(): number | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // the process exited between readdir and read, or isn't ours
    }
    // argv is NUL-separated; `herdr server` is argv[0] ending in herdr plus a
    // literal `server`. Matching the parts avoids catching this daemon itself
    // or an `herdr agent attach` client.
    const argv = cmdline.split('\0').filter(Boolean);
    if (argv.length >= 2 && /(^|\/)herdr$/.test(argv[0]) && argv[1] === 'server') {
      return Number(entry);
    }
  }
  return undefined;
}

function readSoftFdLimit(pid: number): number | undefined {
  let limits: string;
  try {
    limits = fs.readFileSync(`/proc/${pid}/limits`, 'utf8');
  } catch {
    return undefined;
  }
  // "Max open files            65536                1048576              files"
  const line = limits.split('\n').find(l => l.startsWith('Max open files'));
  const soft = line?.trim().split(/\s{2,}/)[1];
  const value = Number(soft);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFdNames(pid: number): string[] | undefined {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return undefined; // not ours to inspect, or it exited
  }
}

/**
 * How close the herdr server is to its open-file ceiling, or undefined when
 * that cannot be read (no herdr server, or a platform without /proc).
 *
 * Two syscalls and a directory listing, because this is on the `list_agents`
 * path clients poll. Never throws.
 */
export function readFdUsage(pid = findHerdrServerPid()): FdUsage | undefined {
  if (pid === undefined) return undefined;

  const softLimit = readSoftFdLimit(pid);
  if (softLimit === undefined) return undefined;

  const fdNames = readFdNames(pid);
  if (fdNames === undefined) return undefined;

  const openFds = fdNames.length;
  return {
    pid,
    openFds,
    softLimit,
    headroomPanes: Math.max(0, Math.floor((softLimit - openFds) / PTMX_FDS_PER_PANE)),
    ratio: openFds / softLimit
  };
}

/**
 * {@link readFdUsage} plus how many descriptors are pty masters. This one
 * readlink()s every descriptor, so it belongs on failure paths rather than on
 * anything polled.
 */
export function readFdPressure(pid = findHerdrServerPid()): FdPressure | undefined {
  const usage = readFdUsage(pid);
  if (!usage) return undefined;

  const fdNames = readFdNames(usage.pid) ?? [];
  let ptmxFds = 0;
  for (const fd of fdNames) {
    try {
      if (fs.readlinkSync(`/proc/${usage.pid}/fd/${fd}`) === '/dev/ptmx') ptmxFds++;
    } catch {
      // fd closed mid-scan; the count is a diagnostic, not an audit
    }
  }

  return {
    ...usage,
    ptmxFds,
    estimatedPanes: Math.round(ptmxFds / PTMX_FDS_PER_PANE)
  };
}

/** One line a human can read, in panes rather than raw descriptors. */
export function describeFdPressure(p: FdPressure): string {
  const percent = Math.round(p.ratio * 100);
  return (
    `herdr server (pid ${p.pid}) holds ${p.openFds}/${p.softLimit} open files (${percent}% of the soft limit); ` +
    `${p.ptmxFds} are pty masters, ≈${p.estimatedPanes} panes at ${PTMX_FDS_PER_PANE} fds/pane, ` +
    `room for ≈${p.headroomPanes} more panes`
  );
}

/** True when fd usage is high enough to be worth reporting on its own. */
export function isFdPressureHigh(p: FdUsage): boolean {
  return p.ratio >= FD_PRESSURE_WARN_RATIO;
}

/**
 * The herdr line CrabCast's spawn path is written against.
 *
 * herdr 0.7.0 redesigned `agent start`: it no longer creates a pane, it
 * attaches a *named agent kind* to an existing one (`--kind`/`--pane`), and it
 * dropped `--cwd`, `--tab`, `--no-focus` and the trailing `-- <argv>` command.
 * `startAgentInOwnTab` in herdr.ts passes all of those, so on 0.7.x every
 * activation dies with `unknown option: --cwd` — found on the extraction
 * source's clean-machine run (KAN-33), where the then-current installer handed
 * a new user 0.7.5.
 *
 * Adapting the spawn path to the new API is real work in a contended file and
 * is tracked separately. What belongs here is that the incompatibility names
 * itself, rather than surfacing as a stray getopt error.
 */
export const SUPPORTED_HERDR_MAJOR_MINOR = '0.6';

/** `herdr --version` output → a comparable `[major, minor]`, or undefined. */
export function parseHerdrVersion(versionOutput: string): [number, number] | undefined {
  const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(versionOutput);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/**
 * A warning when herdr is a line CrabCast cannot drive, or undefined when it
 * is fine (or unreadable — an unknown version is not evidence of a problem,
 * and refusing to run on one would break every future release).
 */
export function checkHerdrVersion(versionOutput: string): string | undefined {
  const parsed = parseHerdrVersion(versionOutput);
  if (!parsed) return undefined;

  const [major, minor] = parsed;
  const [wantMajor, wantMinor] = SUPPORTED_HERDR_MAJOR_MINOR.split('.').map(Number);
  if (major === wantMajor && minor === wantMinor) return undefined;

  // `herdr --version` already prints "herdr 0.7.5", so the name is not
  // prepended — doing so produced "herdr herdr 0.7.5" in the daemon log.
  if (major > wantMajor || (major === wantMajor && minor > wantMinor)) {
    return (
      `${versionOutput.trim()} is newer than the ${SUPPORTED_HERDR_MAJOR_MINOR}.x line CrabCast's spawn path ` +
      `is written against. herdr 0.7 redesigned 'agent start' — it takes --kind/--pane and no longer ` +
      `accepts --cwd — so every activation will fail with 'unknown option: --cwd'. Install a ` +
      `${SUPPORTED_HERDR_MAJOR_MINOR}.x herdr (0.6.4 is the release this line was verified against).`
    );
  }
  return (
    `${versionOutput.trim()} is older than the ${SUPPORTED_HERDR_MAJOR_MINOR}.x line CrabCast is written ` +
    `against; agent spawning may not work.`
  );
}

/**
 * Turn herdr's spawn error into something diagnosable.
 *
 * The message herdr gives is kept verbatim and first — it is the ground truth,
 * and a wrapper that paraphrases an error it does not recognise is how the
 * original gets lost. What we add is the known cause, when the code is one we
 * have actually traced to a mechanism.
 */
export function diagnoseSpawnFailure(herdrMessage: string): string {
  const notes: string[] = [];

  // Traced in the extraction source (KAN-24): libghostty refuses to build a
  // terminal with a zero dimension, and herdr sizes a new pane by splitting
  // the workspace layout. The layout is sized to attached clients, so one
  // client that attaches reporting a tiny window (a `script`-spawned pty with
  // no window size reports 1x1) shrinks the layout until a new pane's share
  // rounds to zero — after which every spawn fails until that client goes
  // away. Confirmed on an isolated herdr with two panes, so it is not a
  // resource problem.
  if (/ghostty error -2/i.test(herdrMessage)) {
    notes.push(
      'This is a pane-geometry failure, not a resource failure: herdr tried to create the pane ' +
      'with a zero-sized terminal. It happens when some client has attached to the herdr session ' +
      'reporting a tiny window (a pty opened without a window size reports 1x1), which shrinks the ' +
      'workspace layout until a new pane gets no room. Look for `rows=0 cols=0` on the ' +
      '`pane.spawn.start` line in ~/.config/herdr/herdr-server.log, and for a `client connected ' +
      'cols=1 rows=1` before it; detaching that client restores spawning.'
    );
  }

  // herdr 0.6.4 surfaces EMFILE from openpty as Rust's io::Error Debug form —
  // `failed to openpty: Os { code: 24, ..., message: "No file descriptors
  // available" }` — which says neither "EMFILE" nor "too many open files".
  // Matched here verbatim alongside the conventional spellings, because a
  // diagnosis that only recognises the textbook wording recognises nothing.
  if (/too many open files|no file descriptors available|EMFILE|ENFILE|openpty/i.test(herdrMessage)) {
    notes.push(
      'The herdr server is out of file descriptors. Each pane costs ' +
      `${PTMX_FDS_PER_PANE} of them (one pty master, dup'ed), so closing idle agents is what ` +
      'frees room; raising the soft limit with `prlimit --pid <pid> --nofile=` postpones the ' +
      'ceiling rather than removing it.'
    );
  }

  // Attach fd pressure whenever it is high, even for an unrecognised error:
  // a server near its ceiling misbehaves in ways that do not name the ceiling.
  const pressure = readFdPressure();
  if (pressure && isFdPressureHigh(pressure)) {
    notes.push(`Resource pressure at the time: ${describeFdPressure(pressure)}.`);
  }

  return notes.length ? `${herdrMessage} — ${notes.join(' ')}` : herdrMessage;
}
