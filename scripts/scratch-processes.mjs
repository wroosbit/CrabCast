// EVERY PROCESS A PROOF CAUSED — not merely the ones it spawned by hand.
//
// WHY THIS FILE EXISTS, stated as what was measured rather than as what is
// tidy. `verify-variadic-args-swallow-prompt.mjs` and `verify-launcher-args.mjs`
// each ended with a check labelled
//
//     every process this proof started is gone
//
// and each went GREEN on every run while leaving a daemon and a handful of
// `herdr agent attach` processes alive on the machine. The check was not lying;
// its LABEL was. It iterated a `Set` of pids the script had added by hand at
// four call sites — the fake `claude` spawns — and the two populations it
// missed are the two nobody adds by hand:
//
//   * THE SCRATCH DAEMON, which no line of either proof spawns. The first CLI
//     call auto-spawns it, detached, and it reparents to init — so it is not a
//     child, it is not in any process group the proof holds, and it never
//     passed through a call site where a pid could have been recorded.
//   * EVERY `herdr agent attach` THE DAEMON THEN SPAWNS, which are the
//     daemon's children and not the proof's. The shim's attach branch is
//     `setInterval(() => {}, 60000)`, so each one idles forever.
//
// MEASURED ON THIS MACHINE, 2026-08-18, on a `verify-launcher-args` run that
// printed `53/53 checks passed` and `every process this proof started is gone
// — 3 ended`. Four processes carrying that run's own scratch root were still
// alive when it exited:
//
//   dist/daemon.js /tmp/<root>/crabcast.config.json
//   /bin/bash      /tmp/<root>/bin/claude --permission-mode …
//   herdr-shim.mjs agent attach crabcast-cold-30421bb68fc98466  --takeover
//   herdr-shim.mjs agent attach crabcast-denied-982d5ac5a3507f9b --takeover
//
// ⚠ NOTE THE SECOND ROW, because it is the one that shows the pid set was not
// merely INCOMPLETE but MISALIGNED. That is a fake `claude` — the population
// the set exists to hold — and it survived anyway: what the fixture reports,
// and therefore what the proof records, is the pid of the process that writes
// the record, while the `bash` wrapper that `exec`s toward it is a different
// pid nobody ever held. A set fed by hand cannot be audited against the
// machine, which is the general form of the defect and the reason the fix is
// not "add two more `spawnedPids.add`".
//
// ---------------------------------------------------------------------------
// WHAT REPLACES THE SET: ASK THE MACHINE, KEYED ON THE ONE UNFORGEABLE STRING
// ---------------------------------------------------------------------------
//
// Every process in that list carries the scratch root's absolute path in its
// own argv — the daemon in its config path, the shim and the fixture in the
// path they were executed from. The root comes from `mkdtempSync`, so its final
// segment carries six random characters that exist nowhere else on the machine
// and did not exist before this run started. That makes it the same
// attributable key `verify-variadic-args-swallow-prompt` §5 already uses to ask
// whether the live fleet's registry carries a row this proof put there: a
// process bearing it was caused by this run and nothing else could be.
//
// So the question changes from "did the processes I remembered exit?" — which
// the proof can answer without learning anything — to "does ANY process on this
// machine still carry my scratch root?", which it cannot answer wrongly and
// still look clean.
//
// ---------------------------------------------------------------------------
// ⚠ WHY THE PREVIOUS TEARDOWN COULD NOT HAVE WORKED, AND WHY NOBODY SAW IT
// ---------------------------------------------------------------------------
//
// Both proofs called `crabcast(['daemon', 'stop'])` immediately before the
// check and neither read its status. THERE IS NO SUCH COMMAND. `crabcast
// daemon` BECOMES a daemon (`cli.ts`: "There is no stop or restart either — no
// such action exists, and `pid` below is what `kill` needs"), so the call is a
// usage error:
//
//   $ node dist/cli.js --config <path> daemon stop
//   crabcast: `crabcast daemon` takes no arguments, and got "stop". …
//   EXIT=2
//
// An exit 2 nobody reads, in front of a check that could not see what the
// command failed to stop. The two defects hid each other perfectly: the
// teardown looked like it had a mechanism, and the assertion looked like it had
// been checked.
//
// ---------------------------------------------------------------------------
// THE SAFETY PROPERTY, because a sweep that kills by string match is a loaded
// instrument pointed at a shared machine
// ---------------------------------------------------------------------------
//
// This machine runs the live fleet. A sweep keyed on a root that is short,
// relative, or a prefix of somewhere real would match — and SIGKILL — agents
// doing somebody else's work. `assertSweepableRoot` is therefore a refusal
// rather than a warning, and it runs on every entry point here rather than at
// the call sites, so a caller cannot reach the kill without passing it. It
// requires an absolute path, strictly under the system temp directory, whose
// final segment is long enough to carry `mkdtemp`'s randomness — which the
// roots a proof can legitimately hand it always are, and which `/tmp`,
// `/tmp/x`, `''` and `/` never are.
//
// A NOTE ON WHAT THIS IS NOT: it is not a process-group kill. That was the
// other candidate and it does not reach the population above — the daemon
// detaches precisely so that it OUTLIVES the CLI call that started it, which
// puts it in its own session by design. Killing the group kills the proof's own
// children and leaves the exact four processes this file exists for.
//
// Linux only, deliberately: it reads `/proc`, which is the same instrument the
// proofs' own `livePid` already reads, so this adds no portability constraint
// that the callers did not already have.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How long to let a signalled process actually leave the table. */
const SETTLE_MS = 400;

/**
 * The fewest characters a scratch root's final segment may have.
 *
 * `mkdtempSync` appends exactly six random characters to the prefix it is
 * given, so any root a proof here can produce is comfortably longer. The bound
 * exists to refuse the roots a BUG produces — an empty string joined onto
 * `os.tmpdir()`, a prefix variable that was never assigned — which are the ones
 * that would match half the process table.
 */
const MIN_LEAF = 8;

/**
 * Refuse a root this module must not sweep on.
 *
 * Throws rather than returning false, and is called from every export below:
 * the dangerous state is one where a caller reached `process.kill` with a root
 * it never validated, so there is no path here that skips it.
 *
 * @param {string} root
 * @returns {string} the same root, resolved
 */
export function assertSweepableRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error(`scratch root must be a non-empty string, got ${JSON.stringify(root)}`);
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `scratch root must be absolute, got ${JSON.stringify(root)} — a relative root would be ` +
        `matched against every argv on the machine as a bare substring.`
    );
  }
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  if (resolved === tmp || !resolved.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(
      `scratch root must be strictly under ${tmp}, got ${resolved} — this sweep SIGKILLs what ` +
        `it matches, and this machine runs the live fleet.`
    );
  }
  const leaf = path.basename(resolved);
  if (leaf.length < MIN_LEAF) {
    throw new Error(
      `scratch root's final segment ${JSON.stringify(leaf)} is shorter than ${MIN_LEAF} ` +
        `characters, so it is not a mkdtemp root and would match too much.`
    );
  }
  return resolved;
}

/** This process and every ancestor of it, which a sweep must never signal. */
function selfAndAncestors() {
  const chain = new Set();
  let pid = process.pid;
  // Bounded rather than `while (pid > 1)`: a /proc that answers something
  // unexpected must not spin here.
  for (let hop = 0; hop < 64 && pid > 0; hop += 1) {
    chain.add(pid);
    let ppid = 0;
    try {
      // `stat`'s field 4, read past the comm field — comm may itself contain
      // spaces and parentheses, so the split is on the LAST ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      ppid = Number(after[1]);
    } catch {
      break;
    }
    if (!Number.isInteger(ppid) || ppid <= 0 || chain.has(ppid)) break;
    pid = ppid;
  }
  return chain;
}

/**
 * Every live process whose own argv mentions `root`.
 *
 * Reads `/proc/<pid>/cmdline` — the kernel's record of what each process was
 * started with — rather than shelling out to `ps`, so there is no output format
 * to mis-parse and no truncation to notice.
 *
 * @param {string} root an absolute mkdtemp scratch root
 * @returns {{pid: number, argv: string[]}[]} newest-first is not promised;
 *          order is whatever /proc enumerates.
 */
export function processesUnder(root) {
  const resolved = assertSweepableRoot(root);
  const exclude = selfAndAncestors();
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (err) {
    throw new Error(`cannot read /proc, so this sweep cannot answer: ${err?.message ?? err}`);
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || exclude.has(pid)) continue;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      // Gone between readdir and read, or not ours to look at. Either way it
      // is not a process this sweep can or should act on.
      continue;
    }
    if (!raw.includes(resolved)) continue;
    found.push({ pid, argv: raw.split('\0').filter((s) => s.length) });
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill everything carrying `root` in its argv, then look again and report.
 *
 * TERM first and KILL second, in two waves, because the daemon is worth asking
 * politely: given the chance it closes its socket and reaps its own children.
 * The second wave is what makes the outcome not depend on its cooperation.
 *
 * ⚠ THE RETURN VALUE IS THE POINT. This returns what it FOUND and what it could
 * not kill, so the caller can assert on both. A sweeper that returned nothing
 * would leave its caller asserting `true`, which is the shape of check this
 * whole module exists to replace.
 *
 * @param {string} root
 * @param {{log?: (line: string) => void, settleMs?: number}} [opts]
 * @returns {Promise<{found: {pid: number, argv: string[]}[],
 *                   survivors: {pid: number, argv: string[]}[]}>}
 */
export async function sweepScratchRoot(root, { log, settleMs = SETTLE_MS } = {}) {
  const resolved = assertSweepableRoot(root);
  const found = processesUnder(resolved);

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const alive = processesUnder(resolved);
    if (alive.length === 0) break;
    for (const { pid } of alive) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone, or never ours. `processesUnder` below is what decides
        // the verdict, so a failed signal is not itself a result.
      }
    }
    await sleep(settleMs);
  }

  const survivors = processesUnder(resolved);
  if (log && found.length) {
    log(
      `[scratch-processes] ${found.length} process(es) carried ${resolved}; ` +
        `${found.length - survivors.length} ended, ${survivors.length} survived`
    );
  }
  return { found, survivors };
}

/**
 * The signal-handler form: SIGKILL everything carrying `root`, synchronously.
 *
 * ⚠ A SEPARATE FUNCTION RATHER THAN AN OPTION ON THE ONE ABOVE, because a
 * signal handler cannot await. `process.on('SIGINT', …)` that starts a promise
 * and then calls `process.exit(130)` exits BEFORE the promise settles, so the
 * polite wave would be the only one that ran and the kill wave would never
 * happen — a teardown that looks thorough in the source and does half the work
 * at the only moment it matters. There is no settle and no politeness here on
 * purpose: the process is leaving now.
 *
 * @param {string} root
 * @returns {number} how many processes were signalled
 */
export function killScratchRootSync(root) {
  const resolved = assertSweepableRoot(root);
  const alive = processesUnder(resolved);
  for (const { pid } of alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone. Nothing to report: the caller is on its way out.
    }
  }
  return alive.length;
}

/** One line per process, for a check's detail string. */
export function describe(procs) {
  return procs.map(({ pid, argv }) => `${pid} ${argv.join(' ')}`).join('\n          ');
}
