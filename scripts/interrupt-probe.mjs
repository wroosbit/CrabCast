// KAN-169: drive a proof as a subprocess, interrupt it, and count what
// survived — with THE THING BEING COUNTED as a parameter.
//
// This is a module, not a proof. It has no verdict of its own and exits
// nothing; the scripts that import it own their assertions. It is here because
// `verify-proof-cleans-up-when-interrupted` had exactly the right shape and
// exactly one subject: daemons, found by filtering `dist/daemon.js` off the
// process table. The word "pane" did not appear in that file. A herdr pane
// leaked by an interrupted run was therefore invisible to the one script in
// this suite whose whole job is to notice what an interrupted run leaves
// behind.
//
// ---------------------------------------------------------------------------
// WHY A SUBPROCESS AT ALL — inherited from the script this generalises
// ---------------------------------------------------------------------------
//
// A SCRIPT CANNOT MEANINGFULLY INTERRUPT ITSELF. The only way to find out what
// a process leaves behind when it is killed is to be a different process, kill
// it, and count. That is why the interrupted path is the one hole
// `verify-no-attach-steal` §4 cannot close from the inside, however carefully
// it reads the census back: §4 only ever runs on the path where the run
// reaches its verdict.
//
// ---------------------------------------------------------------------------
// THE COUNTER CONTRACT — a result, never a bare number
// ---------------------------------------------------------------------------
//
// A `count` is `(ctx) => { ok: true, survivors: [...] } | { ok: false, reason }`
// and it may NOT return a number. This is KAN-173's rule applied to a second
// instrument, and it is the whole reason this module can carry two counters
// without one of them being quietly worse than the other:
//
//   "a count is a shape that cannot say 'I did not understand the input'."
//
// A census that cannot be read must not read as zero. Every wrong answer this
// repository has recorded on this axis — `wc -l` answering 1, a key-guess
// answering 0 off a 26 KB file, keying on `name` where the shape publishes
// `label` — was a COUNT, produced by a command that exited cleanly, and each
// was indistinguishable from the answer a reclamation check most wants to
// hear. So the survivors cannot be read until `ok` has been destructured past,
// and an unreadable census is not merely detected but unrepresentable as a
// count. The two counters below are held to that by their callers' canaries;
// this module supplies the shape, not the confidence.
//
// ---------------------------------------------------------------------------
// HOW A RUN IS MADE ATTRIBUTABLE, and why this is not a courtesy
// ---------------------------------------------------------------------------
//
// Each driven run gets its OWN TMPDIR, which `os.tmpdir()` honours. For a
// daemon that makes its config path — and therefore its line on the process
// table — unique to that run. For a pane it does more work than it looks:
// `verify-no-attach-steal` derives its probe directory from `os.tmpdir()` and
// its pane name from that directory via `paneNameFor`, so a private TMPDIR
// yields a pane name no other run on the machine can be holding.
//
// THAT IS WHAT MAKES REAPING SAFE. A proof that interrupts things on a live
// fleet machine must never close a pane it cannot prove is its own — three
// `crabcast-*` panes on this machine are held open by an explicit decision on
// KAN-173 and several `butchr-*` panes are live supervisors. "Mine" here is
// not a heuristic over names: it is a name derived from a directory this
// process minted seconds earlier, and {@link reapPaneByName} re-checks the
// pane's own `cwd` against that directory before it closes anything.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// THE DRIVER
// ===========================================================================

/**
 * Run `target`, wait until the thing being counted actually EXISTS, interrupt
 * it, and report what was there at each point.
 *
 * WAITING FOR EXISTENCE BEFORE INTERRUPTING IS THE PRECONDITION THAT KEEPS
 * THIS HONEST. Killing the target before it has created anything would leave
 * nothing behind whatever its handlers do, and the section using this would
 * pass against a script with no cleanup at all.
 *
 * @param {object} o
 * @param {string}   o.target     absolute path to the script to drive
 * @param {string[]} [o.argv]     operands passed after the script path
 * @param {string}   o.root       scratch root; this run's dirs are made under it
 * @param {string}   o.label      names this run's directories, and the mutant's
 *                                pane apart from the pristine run's
 * @param {(ctx: {runTmp: string, home: string, label: string}) => object} o.count
 *                                the counter contract above
 * @param {object}   [o.env]      extra environment for the child
 * @param {number}   [o.settleMs] how long to let the machine settle after the
 *                                interrupt before counting survivors
 * @param {number}   [o.timeoutMs] how long to wait for the counted thing
 * @param {number}   [o.pollMs]   how often to ask the counter
 */
export async function driveAndInterrupt({
  target,
  argv = [],
  root,
  label,
  count,
  env = {},
  settleMs = 2000,
  timeoutMs = 180_000,
  pollMs = 500
}) {
  const runTmp = path.join(root, `tmp-${label}`);
  const home = path.join(root, `home-${label}`);
  fs.mkdirSync(runTmp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const ctx = { runTmp, home, label };

  // stdout AND stderr are captured rather than ignored, because the caller
  // needs to assert on WHAT THE TARGET HAD REACHED at the moment it was
  // interrupted. An interrupt that lands after the target's happy-path
  // teardown has already run measures the happy path — and reports the same
  // clean absence the interrupted path reports when it works. See
  // `outputAtInterrupt`.
  const child = spawn(process.execPath, [target, ...argv], {
    env: { ...process.env, HOME: home, TMPDIR: runTmp, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  // ATTACHED BEFORE THE WAIT LOOP, so a child that exits during the loop is
  // still awaited correctly. Attaching it after — as the script this
  // generalises once did — waits forever for an event that has already fired,
  // which node reports as exit code 13 and no output at all.
  const exited = new Promise((resolve) => child.on('exit', resolve));

  let during = { ok: false, reason: 'the wait loop never asked' };
  let diedEarly = false;
  let waitedMs = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    during = count(ctx);
    // A REFUSAL STOPS THE LOOP RATHER THAN LOOKING LIKE "NOT YET". A counter
    // that cannot read its input would otherwise be indistinguishable from a
    // target that has not got there, and this would spend the whole timeout
    // before reporting a precondition failure that says nothing about why.
    if (!during.ok) break;
    if (during.survivors.length > 0) break;
    if (child.exitCode !== null || child.signalCode !== null) { diedEarly = true; break; }
    await sleep(pollMs);
    waitedMs += pollMs;
  }

  const outputAtInterrupt = output;
  child.kill('SIGINT');
  await exited;
  // A handler that reclaims and re-raises needs a moment for what it killed to
  // actually go.
  await sleep(settleMs);

  return {
    ctx,
    runTmp,
    home,
    during,
    after: count(ctx),
    diedEarly,
    waitedMs,
    outputAtInterrupt,
    output,
    exitCode: child.exitCode,
    signalCode: child.signalCode
  };
}

// ===========================================================================
// COUNTER 1 — DAEMONS, off the process table
// ===========================================================================

/**
 * Daemons whose config path is under this run's TMPDIR, as pids.
 *
 * THE READABILITY CANARY IS FOLDED IN rather than standing beside it. The
 * script this generalises asserted `psWorks()` once, at the top, as its own
 * check — which is correct and is one reading earlier than the readings it
 * licences. Here a `ps` that answers nothing, or answers something too short
 * to be a process table, is a REFUSAL at the point of counting, so "no daemons
 * survived" can never be read off a failed `ps` however far apart in time the
 * canary and the count are.
 */
export function daemonCounter({ marker = 'dist/daemon.js' } = {}) {
  return ({ runTmp }) => {
    let out;
    try {
      out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    } catch (err) {
      return { ok: false, reason: `\`ps\` did not answer: ${err?.message ?? err}` };
    }
    const lines = out.split('\n');
    if (lines.length <= 5) {
      return {
        ok: false,
        reason:
          `\`ps\` answered ${lines.length} line(s), which is not a process table this counter ` +
          `will report a zero from. Refusing rather than reporting "no survivors".`
      };
    }
    return {
      ok: true,
      survivors: lines
        .filter((line) => line.includes(marker) && line.includes(runTmp))
        .map((line) => Number(line.trim().split(/\s+/)[0]))
        .filter((pid) => Number.isFinite(pid))
    };
  };
}

/** SIGKILL whatever the subject left running, so this proof is not itself a leak. */
export function reapDaemons(pids) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// ===========================================================================
// COUNTER 2 — PANES, off `herdr agent list`
// ===========================================================================

/**
 * Read `herdr agent list` output into a census, or refuse.
 *
 * `name`, NOT `label`, AND THE DIFFERENCE HAS ALREADY COST SOMEBODY A ZERO.
 * `herdr agent list` publishes an agent's herdr name under `name`; `herdr pane
 * list` publishes the same string under `label`. Reading the wrong one yields
 * `undefined` for every row and a crabcast count of zero on a machine carrying
 * several — measured on this machine on 2026-08-14, and recorded on KAN-173.
 * This reader is the `agent list` half; `readPaneCensus` in
 * `verify-panes-are-reclaimed.mjs` is the `pane list` half, and they are two
 * readers rather than one because they read two different shapes.
 *
 * RETURNS A DISCRIMINATED RESULT, NEVER A NUMBER — see the counter contract in
 * this file's header.
 */
export function readAgentCensus(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty output — herdr answered nothing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not JSON: ${err.message}` };
  }
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) {
    return {
      ok: false,
      reason:
        `no array at result.agents (top-level keys: ${
          parsed && typeof parsed === 'object' ? Object.keys(parsed).join(', ') || '(none)' : typeof parsed
        }). Refusing to report a count for a shape this reader does not know — a guess here ` +
        `answers 0 and reads as a machine with nothing on it.`
    };
  }
  const named = agents.filter((a) => a && typeof a.name === 'string' && a.name !== '');
  return {
    ok: true,
    agents: named.map((a) => ({
      name: a.name,
      paneId: typeof a.pane_id === 'string' && a.pane_id ? a.pane_id : null,
      cwd: typeof a.cwd === 'string' ? a.cwd : null
    })),
    total: agents.length,
    names: named.map((a) => a.name).sort()
  };
}

/** `herdr agent list`, as a human would type it, through the reader above. */
export function liveAgentCensus() {
  let out;
  try {
    out = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (err) {
    return { ok: false, reason: `\`herdr agent list\` did not answer: ${err?.message ?? err}` };
  }
  return readAgentCensus(out);
}

/**
 * Panes belonging to THIS run, by the exact name derived from its own TMPDIR.
 *
 * `paneNameOf` is the caller's, because deriving the name means knowing how the
 * target names its probe — which is the target's business and not this
 * module's. What this owns is that the answer is a result rather than a count,
 * and that a herdr which has stopped answering is a refusal rather than an
 * empty machine.
 */
export function paneCounter({ paneNameOf }) {
  return (ctx) => {
    const census = liveAgentCensus();
    if (!census.ok) return census;
    const wanted = paneNameOf(ctx);
    return {
      ok: true,
      wanted,
      survivors: census.agents.filter((a) => a.name === wanted),
      censusSize: census.names.length,
      names: census.names
    };
  };
}

/**
 * Close a pane by name — and only one this run can prove it created.
 *
 * THE MUTANT SECTION OF A PROOF LIKE THIS DELIBERATELY LEAKS, so reaping is not
 * housekeeping: without it the proof becomes the thing it exists to catch, on a
 * live machine, once per run, unbounded. That is `verify-no-attach-steal`'s own
 * history (KAN-137) and there is no reason this script would be spared it.
 *
 * Three gates, because "close only what we created" is the rule this epic
 * breaks least forgivingly and one condition is one place to be wrong:
 *
 *   1. the name must be the one derived from a directory THIS PROCESS minted,
 *      and must carry the CrabCast prefix;
 *   2. it must not be a `butchr-*` name — several of those are live
 *      supervisors, and the epic's standing rules forbid touching them;
 *   3. the pane's own `cwd`, as herdr reports it, must resolve to the directory
 *      this run spawned into. A name collision that got past (2) still cannot
 *      get past a pane sitting somewhere else.
 *
 * PANE IDS ARE POSITIONS AND THEY RENUMBER whenever any pane anywhere closes,
 * so the id is read immediately before the close and never carried.
 */
export function reapPaneByName({ name, prefix, expectCwd, log = console.log }) {
  if (!name.startsWith(prefix) || name.startsWith('butchr-')) {
    log(`  [reap] REFUSING to close ${name}: not a name this script may close`);
    return { closed: false, why: 'name-refused' };
  }

  let record;
  try {
    const out = execFileSync('herdr', ['agent', 'get', name], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    record = JSON.parse(out)?.result?.agent;
  } catch (err) {
    log(`  [reap] ${name}: herdr does not know it (${err?.message ?? err})`);
    return { closed: false, why: 'not-found' };
  }

  const paneId = record?.pane_id;
  if (typeof paneId !== 'string' || !paneId) {
    log(`  [reap] ${name}: no pane id — nothing to close`);
    return { closed: false, why: 'no-pane-id' };
  }

  const paneCwd = typeof record.cwd === 'string' ? record.cwd : null;
  let resolved = null;
  try {
    resolved = paneCwd ? fs.realpathSync(paneCwd) : null;
  } catch { /* the directory may have gone with the scratch root; resolved stays null */ }
  if (resolved !== null && expectCwd !== null && resolved !== expectCwd) {
    log(
      `  [reap] REFUSING to close ${name} (pane ${paneId}): its cwd is ${resolved}, not the ` +
      `${expectCwd} this run spawned into. Leaving it alone.`
    );
    return { closed: false, why: 'cwd-refused' };
  }

  try {
    execFileSync('herdr', ['pane', 'close', paneId], { stdio: 'ignore', timeout: 15_000 });
    log(`  [reap] closed ${name} (pane ${paneId})`);
    return { closed: true, paneId };
  } catch (err) {
    log(`  [reap] could not close ${name} (pane ${paneId}): ${err?.message ?? err}`);
    return { closed: false, why: 'close-failed', paneId };
  }
}
