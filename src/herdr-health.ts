// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

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

/**
 * The herdr release CrabCast has actually been run against, named in every
 * verdict so a reader knows what "supported" is grounded in rather than
 * inferring it from a version range.
 *
 * It is the release every other proof in `scripts/` that needs a REAL herdr
 * runs on, because it is what is installed on the machine they run against.
 * {@link VERIFIED_HERDR_RELEASES} is the full list of releases anybody has
 * started a pane on.
 */
export const VERIFIED_HERDR_RELEASE = '0.6.4';

/**
 * Every 0.6.x release CrabCast has been RUN against, in order.
 *
 * This list is the reason the README does not say "0.6.x is supported". Eleven
 * releases exist in that line (0.6.0 through 0.6.10); two of them have had a
 * pane started on them. The other nine are neither known-good nor known-bad,
 * and a range is a claim about every member of it.
 *
 *   0.6.4   every proof in scripts/, repeatedly, on the machine they run on
 *   0.6.10  `scripts/verify-herdr-release.mjs <bin> --expect supported`
 *           (KAN-181, 2026-08-05): configure → activate → herdr's own census →
 *           status → tail → deactivate → forget, on a private server
 *
 * Adding a release here means somebody ran that script against that binary and
 * put the output on a pull request. Nothing enforces that from inside the
 * process, which is why the list is short and its provenance is written down.
 */
export const VERIFIED_HERDR_RELEASES = ['0.6.4', '0.6.10'] as const;

/**
 * Releases ABOVE the supported line that were run and observed to fail, and
 * what was seen.
 *
 * KAN-102 removed a message that told a 0.8 user their activations *would* fail
 * on evidence taken from 0.7.5 — a prediction stated as a finding. This map is
 * the other half of that discipline: 0.8.0 has since been run (KAN-181), it
 * fails identically, and continuing to call it "an unknown — it may well work"
 * would be the same defect pointing the other way.
 *
 * Keyed by the EXACT release, never by a range. 0.8.1 is not in here; nobody
 * has run it.
 *
 * 0.7.5 is listed even though the 0.7.x band has its own message and never
 * reads this map for its own verdict: what it is read for there is the
 * ENUMERATION handed to a user on an untested release above the line, and
 * leaving out one of the two releases that were run would make that list a
 * smaller prior than the evidence supports.
 */
export const HERDR_RELEASES_OBSERVED_BROKEN: Readonly<Record<string, string>> = {
  '0.7.5': 'observed on a clean machine (KAN-33)',
  '0.8.0': 'run on 2026-08-05 against a private server (KAN-181)'
};

/**
 * The line where `agent start` was redesigned — see the docblock above. It is
 * a separate constant from {@link SUPPORTED_HERDR_MAJOR_MINOR} because the two
 * facts have different evidence behind them, and {@link checkHerdrVersion}
 * says different things on either side of it (KAN-102).
 */
export const HERDR_AGENT_START_REDESIGN_MAJOR_MINOR = '0.7';

/**
 * The wire field a version verdict travels on, from the daemon that computed
 * it at startup to the client that renders it.
 *
 * The daemon computes; the CLI renders (KAN-92 constraint 1). A client that
 * ran its own comparison would be a second copy of {@link checkHerdrVersion} —
 * the copy that is wrong after this one changes — so the verdict crosses the
 * socket as finished prose and the field name is shared rather than spelled
 * twice.
 */
export const HERDR_VERSION_NOTICE_FIELD = 'herdrVersionNotice';

/** `herdr --version` output → a comparable `[major, minor]`, or undefined. */
export function parseHerdrVersion(versionOutput: string): [number, number] | undefined {
  const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(versionOutput);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/**
 * `herdr --version` output → the exact `major.minor.patch` release, or
 * undefined when the output does not carry one.
 *
 * Separate from {@link parseHerdrVersion} because the two answer different
 * questions and only one of them is a range: the band an installed herdr falls
 * into is a `[major, minor]` comparison, while "has anybody actually run this"
 * can only ever be asked of one exact release.
 */
export function parseHerdrRelease(versionOutput: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/**
 * The single version comparison in this codebase (KAN-102).
 *
 * A verdict on the herdr that is installed, or undefined when it is fine (or
 * unreadable — an unknown version is not evidence of a problem, and refusing
 * to run on one would break every future release). Never a refusal: it returns
 * words, and the caller decides where to put them.
 *
 * Four bands, because they rest on four different amounts of evidence and a
 * message that flattened them would be claiming more than anyone knows:
 *
 *   - **0.6.x** — the supported line. Nothing is said. A notice that fires for
 *     the configuration we tell people to install trains them to ignore the one
 *     that matters.
 *
 *     THIS SILENCE IS WIDER THAN THE EVIDENCE, DELIBERATELY. Two releases in
 *     that line have been run ({@link VERIFIED_HERDR_RELEASES}); the other nine
 *     have not. Saying something about those nine would mean firing a notice at
 *     a user whose herdr is probably fine, on no evidence either way — which is
 *     the same overclaim pointing the other way. The honest place for "two of
 *     the eleven were run" is the README's table, where a reader is choosing a
 *     version, and it says exactly that.
 *   - **0.7.x** — `agent start` was redesigned and `--cwd` is gone; the failure
 *     was *observed*, on 0.7.5, on the extraction source's clean-machine run
 *     (KAN-33). The specific claim is kept, with the version it was seen on.
 *   - **an exact release in {@link HERDR_RELEASES_OBSERVED_BROKEN}** — run here,
 *     failed here, said as a finding rather than a prediction. 0.8.0 is in that
 *     list since KAN-181: it fails at the same flag as 0.7.5, because 0.8 kept
 *     the redesign.
 *   - **anything else above 0.7, and everything below 0.6** — untested. The
 *     verdict says *untested against*, not *broken*: a definite prediction that
 *     turns out to be wrong is how a diagnostic loses the credibility the two
 *     evidenced messages above depend on. It does hand over the prior — the
 *     releases above the line that WERE run all failed the same way — because
 *     withholding that from someone on 0.9 would be its own kind of unhelpful.
 */
export function checkHerdrVersion(versionOutput: string): string | undefined {
  const parsed = parseHerdrVersion(versionOutput);
  if (!parsed) return undefined;

  const [major, minor] = parsed;
  // `herdr --version` already prints "herdr 0.7.5", so the name is not
  // prepended — doing so produced "herdr herdr 0.7.5" in the daemon log.
  const reported = versionOutput.trim();
  const [wantMajor, wantMinor] = SUPPORTED_HERDR_MAJOR_MINOR.split('.').map(Number);
  if (major === wantMajor && minor === wantMinor) return undefined;

  const [redesignMajor, redesignMinor] =
    HERDR_AGENT_START_REDESIGN_MAJOR_MINOR.split('.').map(Number);
  if (major === redesignMajor && minor === redesignMinor) {
    return (
      `${reported} is the line that redesigned 'agent start': it takes --kind/--pane and no ` +
      `longer accepts --cwd, which CrabCast's spawn path passes on every activation — so ` +
      `activations fail with 'unknown option: --cwd'. Observed on herdr 0.7.5, on a clean ` +
      `machine (KAN-33). Install a ${SUPPORTED_HERDR_MAJOR_MINOR}.x herdr ` +
      `(${VERIFIED_HERDR_RELEASE} is the release CrabCast is verified against).`
    );
  }

  if (major > wantMajor || (major === wantMajor && minor > wantMinor)) {
    const release = parseHerdrRelease(versionOutput);
    const observed = release ? HERDR_RELEASES_OBSERVED_BROKEN[release] : undefined;
    if (observed) {
      // A finding, not a forecast: this exact release was run and this is what
      // happened. The wording deliberately matches the 0.7 message's, because
      // the failure is the same failure.
      return (
        `${reported} was RUN against CrabCast and every activation failed with ` +
        `'unknown option: --cwd' — ${observed}. ${HERDR_AGENT_START_REDESIGN_MAJOR_MINOR} ` +
        `redesigned 'agent start' to attach a --kind to an existing --pane, dropping the --cwd ` +
        `this spawn path passes, and ${major}.${minor} kept that redesign. Install a ` +
        `${SUPPORTED_HERDR_MAJOR_MINOR}.x herdr (${VERIFIED_HERDR_RELEASES.join(' and ')} are ` +
        `the releases CrabCast has been run against).`
      );
    }
    return (
      `${reported} is above the herdr line CrabCast is verified against ` +
      `(${VERIFIED_HERDR_RELEASE}) and CrabCast has not been tested on it. That is an unknown, ` +
      `not a known breakage — nobody has run this release, so it may well work. What is known ` +
      `about its neighbours is not encouraging: every release above the line that HAS been run ` +
      `(${Object.keys(HERDR_RELEASES_OBSERVED_BROKEN).join(', ')}) failed at ` +
      `'herdr agent start' with 'unknown option: --cwd', which ` +
      `${HERDR_AGENT_START_REDESIGN_MAJOR_MINOR} dropped and nothing has restored. Installing ` +
      `${VERIFIED_HERDR_RELEASE} puts you on the tested path.`
    );
  }

  return (
    `${reported} is older than the ${SUPPORTED_HERDR_MAJOR_MINOR}.x line CrabCast is written ` +
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
