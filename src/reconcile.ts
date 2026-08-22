// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import { AgentRegistry } from './agent-registry.js';
import { HerdrBridge, ourPaneIn } from './herdr.js';
import { MessageRouter } from './router.js';
import { paneNameFor } from './identity.js';
import { ResumeCause } from './resume.js';
import { delay, monotonicNow, nudgeResumedAgent } from './nudge.js';

/**
 * Bringing the fleet back after the machine came back.
 *
 * This is the step that did not exist. On the extraction source's KAN-21
 * outage the daemon restarted (eventually), herdr restarted, and neither of
 * them had any opinion about the two agents that had been working ninety
 * seconds earlier — because nothing had written down that they existed. With
 * the registry doing that, restoration is this file: read the intent, ask
 * herdr what is really there, and start what is missing.
 *
 * NOTHING HERE NEEDS A CLIENT, which is the point. Activation was already a
 * daemon-side operation that clients merely *call*; a client never owned the
 * lifecycle, it triggered it. So restoration goes through the very same
 * `handleActivate` a CLI or MCP call uses, with nobody connected at all.
 *
 * AND SO PARENTAGE IS RESTORED RATHER THAN RE-DERIVED. `activatedBy` is on the
 * durable record, and the record is what these calls carry forward — so an
 * agent comes back after a power cut still knowing which supervisor put it
 * there, without anything here having to remember it. Note what this pass
 * deliberately does NOT do: it passes no caller identity, so `parentFor` takes
 * its carry-forward branch and nothing is minted. That matters, because a
 * restoration is the one activation with no supervisor behind it — the machine
 * came back, nobody decided anything — and a boot that stamped a fresh parent
 * on every agent would rewrite the fleet's org chart to say the daemon is
 * everyone's supervisor. The two sources being separable is what makes that
 * distinction expressible; see `parentFor` in router.ts.
 */

/** How long to keep waiting for herdr's server before giving up on it. */
const HERDR_READY_TIMEOUT_MS = 60_000;
const HERDR_POLL_INTERVAL_MS = 1_000;

/**
 * Gap between restores. Agent startup is the expensive part of a boot — each
 * one is a node process, an MCP server or two and a model connection — and
 * starting six at once on a machine that is also finishing its own boot is how
 * a restoration turns into the thing that makes the machine unusable.
 */
const RESTORE_STAGGER_MS = 3_000;

/**
 * How long a mid-restore herdr blip is given to clear before the deferred
 * agents are tried again. Shorter than {@link HERDR_READY_TIMEOUT_MS} because
 * herdr answered at the start of this pass — the question is whether a
 * momentary stall has passed, not whether the server is coming up at all.
 */
const DEFERRED_RETRY_WAIT_MS = 15_000;

/**
 * WHETHER A RESTORE WHOSE PATH CANNOT RESOLVE SHOULD STOP BEING ATTEMPTED —
 * KAN-619's question 2, decided here rather than inherited.
 *
 * THE RULING: **it keeps being attempted, and it stops being called `failed`.**
 * The retry is unchanged; only the word and the log line are new.
 *
 * WHY IT WAS A REAL QUESTION. KAN-594 settled that ONE FILESYSTEM READ IS NOT
 * ENOUGH EVIDENCE TO DELETE A RECORD — "your agent stopped existing because a
 * mount was slow" is not a trade anybody offered, so `strandedAgents` reports
 * and never retires. Whether one read is enough to stop RETRYING a restore is a
 * strictly weaker claim, and a weaker claim can go the other way. It is not
 * settled by the first, and inheriting it would have been assuming the answer.
 *
 * WHY IT GOES THE SAME WAY ANYWAY, WHICH IS THE PART THAT IS NOT OBVIOUS. The
 * mount-late argument is not merely as strong here as it was there — it is
 * STRONGER, because of WHEN this pass runs. This is boot. A machine that has
 * just come back is precisely the machine whose mounts are still arriving, so
 * the one moment a stranded path is most likely to be a slow mount rather than
 * a deleted directory is the moment this code executes. A rule that stopped
 * retrying on one `ENOENT` would be at its most wrong exactly where it fires.
 *
 * AND STOPPING BUYS NOTHING THAT IS ACTUALLY WANTED. The attempt is one refused
 * call against a path that does not resolve: no process is spawned, no
 * provisioning runs, no pane is touched, nothing is written. The cost is a log
 * line. What "stop retrying" would have to mean to be worth anything is
 * recording something durable — and that is the delete KAN-594 refused, reached
 * by a different door.
 *
 * ⚠ SO WHAT WAS ACTUALLY WRONG WAS THE REPORTING, AND THAT IS FIXED INSTEAD.
 * Before this, a vanished path came back `result: 'failed'` — the same word a
 * genuine restoration failure gets — carrying `canonicalPath`'s admission
 * message, which ends *"create it first, then configure it."* That advice is
 * right for the typo at `configure` time it was written for and WRONG for this
 * record, whose only remaining verb is `forget`. So the boot summary reported
 * the ordinary residue of finished workspaces as a fleet that came back short,
 * and named a remedy that would resurrect an agent nobody wanted back. It is
 * the shape KAN-382 named one layer down: five conditions with three different
 * remedies arriving as one undifferentiated refusal.
 *
 * WHAT THIS DOES NOT CHANGE, said plainly because the new word could be read as
 * more than it is: nothing is recorded, the record's last event is still
 * `activated`, it is still in `expected()`, and it is still attempted on the
 * next boot. `stranded` is a NAME for an outcome that already happened, not a
 * new behaviour and not a durable state. The record is retired by `forget` and
 * by nothing else.
 *
 * ⚠ AND IT IS NOT RETRIED BY THE DEFERRED PASS, which is a deliberate boundary
 * rather than an oversight. That pass exists for a herdr blip or a busy machine
 * — conditions measured in seconds, which is why retrying once behind a fresh
 * wait is worth the wall-clock. A mount that is going to arrive does not arrive
 * in the seconds between the main pass and the deferred one, and putting a
 * stranded path in that retry would spend the pass on the one condition it
 * cannot clear. Its retry is the NEXT BOOT, which is the interval a late mount
 * is actually measured against.
 */
const RECONCILE_STRANDED = Symbol('KAN-619: the ruling above');
void RECONCILE_STRANDED;

/** What one agent's restoration did, for the log and for the caller. */
export interface RestoreOutcome {
  path: string;
  paneName: string;
  /**
   * `restored` — nothing was there and this pass started it.
   * `reattached` — the PANE survived and this pass took its terminal back.
   *   The agent never stopped, so there is nothing to resume and nothing to
   *   nudge; what was missing was this daemon's grip on it.
   * `already-running` — running AND already attached, so there was nothing to
   *   do. At boot this is unreachable by construction: a daemon that has just
   *   started holds no sessions.
   * `stranded` — its DIRECTORY IS GONE, so `activate` refused the path and
   *   there was never anything to start. See {@link RECONCILE_STRANDED} for
   *   why that is its own word rather than `failed`, and for why this pass goes
   *   on attempting it.
   */
  result: 'already-running' | 'reattached' | 'restored' | 'failed' | 'deferred' | 'stranded';
  /**
   * Which of the two things a deferral was about, present only on `deferred`.
   *
   * `herdr` — the occupancy census went unanswered, so nothing could be
   *   verified. Waiting is the whole remedy.
   * `capacity` — the machine has no room for it right now. Waiting may be the
   *   remedy and standing something else down may be; the log line carries the
   *   gate's derivation so the reader can tell which.
   *
   * A DISCRIMINATOR RATHER THAN TWO RESULTS, because everything downstream of
   * `deferred` — nothing recorded, still `expected()`, retried once, swept
   * afterwards — is identical for both, and a second result value would be a
   * second thing every `switch` on this union has to remember to handle in
   * order to behave the same way.
   */
  deferredBy?: 'herdr' | 'capacity';
  /** True when the agent's prior conversation was there to continue. */
  resumedConversation?: boolean;
  /** Whether the interrupted-work message was delivered, and why not. */
  nudged?: boolean;
  error?: string;
}

export interface ReconcileResult {
  expected: number;
  outcomes: RestoreOutcome[];
}

/**
 * Wait for herdr's server to answer before deciding anything.
 *
 * `listHerdrAgents` returns an empty list both when herdr has no agents and
 * when herdr could not be reached at all — a distinction that does not matter
 * to a status display and matters enormously here, because "herdr is not up
 * yet" would otherwise read as "every agent is missing" and start a second copy
 * of a fleet that was about to appear. At boot this is not hypothetical: a
 * service manager ordering the daemon after herdr says herdr was *launched*
 * first, not that its socket is accepting.
 */
async function waitForHerdr(herdrBridge: HerdrBridge, timeoutMs: number): Promise<boolean> {
  const deadline = monotonicNow() + timeoutMs;
  for (;;) {
    if (herdrBridge.herdrReachable()) return true;
    if (monotonicNow() >= deadline) return false;
    await delay(HERDR_POLL_INTERVAL_MS);
  }
}

/**
 * Restore every agent the registry says should be running and herdr does not
 * have. Never throws: this runs at daemon startup, and a daemon that refuses to
 * come up because a restore failed is strictly worse than one that comes up and
 * says so.
 *
 * WHAT A MID-RESTORE HERDR BLIP DOES, decided here rather than discovered.
 *
 * `activate` can now answer refuse-unverifiable: herdr did not answer the
 * occupancy census, so it will not spawn into a directory it cannot see. That
 * is right at the activation layer, and it raises a question one layer up —
 * this loop restores N agents over N×3 seconds, so a herdr that stalls for ten
 * of those seconds hits some of them and not others. The three wrong answers
 * were all available:
 *
 *  - **Marked failed.** A transient refusal would become a permanent verdict
 *    in the log line a human reads at boot, and the word "failed" next to an
 *    agent that is perfectly restorable is how somebody concludes it is gone.
 *  - **Silently skipped.** The worst: the fleet comes back short and the
 *    summary says nothing, which is the KAN-21 (in the extraction source)
 *    shape exactly.
 *  - **Retried forever.** A herdr that is genuinely down would keep boot
 *    hanging, and boot is the one place a daemon must not hang.
 *
 * So: **deferred**, retried once, and never recorded.
 *
 *  1. A refuse-unverifiable outcome is `deferred`, which is its own result
 *     rather than a flavour of `failed`.
 *  2. **NOTHING IS WRITTEN TO THE REGISTRY.** The agent's last event is still
 *     `activated`, so it stays in `expected()` — a transient refusal cannot
 *     turn into a permanent "this agent is gone", because the only thing that
 *     could say so is a durable row and none is appended.
 *  3. After the main pass, the deferred set is retried once, behind a fresh
 *     wait for herdr. A blip that has cleared costs one extra pass.
 *  4. Anything still deferred is named in the summary AND — because it is
 *     still `expected()` and still absent — is picked up by the missing-agent
 *     sweep, broadcast as `agent.lost`, and reported in every
 *     `list_agents` poll. So it cannot be a silent skip either: two
 *     independent channels report it until somebody acts.
 *
 * A SECOND REFUSAL NOW ARRIVES HERE, AND IT TOOK THE SAME ANSWER (KAN-263).
 * This pass used to activate with `override: true`, which made `capacityGate`
 * return no verdict at all — so a restore sequence could admit any number of
 * agents onto a machine that could carry three. The override is gone (see the
 * call site for the two lapsed premises behind it), which means a restore can
 * now be refused for CAPACITY, and the three wrong answers enumerated above are
 * wrong about that refusal for word-for-word the same reasons. So it is
 * `deferred` too, with `deferredBy` saying which of the two it was, and
 * everything from point 2 down applies to it unchanged.
 *
 * THE SHAPE OF THE ORIGINAL DEFECT, because it is worth stating once where the
 * loop is rather than only in capacity.ts: this pass restores serially, awaited,
 * and staggered by `RESTORE_STAGGER_MS`, and every one of those restores IS
 * gated. That is not enough. The gate's CPU term divides an observation the
 * daemon refreshes every 30 seconds, and at a 3-second stagger roughly ten
 * restores happen between two samples — each measured against a reading taken
 * before any of them existed. True alone, false in composition. A stagger
 * spaces starts; it does not make the instrument notice them, and the fix is in
 * `starts-in-flight.ts` rather than in a longer stagger here.
 */
export async function reconcileAgents(opts: {
  registry: AgentRegistry;
  herdrBridge: HerdrBridge;
  router: MessageRouter;
  cause: ResumeCause;
  log: (...args: any[]) => void;
}): Promise<ReconcileResult> {
  const { registry, herdrBridge, router, cause, log } = opts;

  const expected = registry.expected();
  if (expected.length === 0) {
    log('[reconcile] The agent registry records no agents that should be running.');
    return { expected: 0, outcomes: [] };
  }

  log(`[reconcile] Registry expects ${expected.length} agent(s) to be running.`);

  if (!(await waitForHerdr(herdrBridge, HERDR_READY_TIMEOUT_MS))) {
    log(
      `[reconcile] herdr did not become reachable within ${HERDR_READY_TIMEOUT_MS / 1000}s; ` +
      `skipping restoration rather than starting a second copy of a fleet that may already exist. ` +
      `The ${expected.length} expected agent(s) will be reported as missing.`
    );
    return { expected: expected.length, outcomes: [] };
  }

  // herdr's own view, taken once: what actually survived.
  //
  // Through the SAME ownership test everything else uses. Joining on the
  // pane's cwd alone — which this did — treats any live pane in an agent's
  // directory as that agent: a stranger's pane in a directory we hold a record
  // for would mark our agent "already running", reconcile would leave it
  // alone, and the fleet would come back short with a line in the log saying
  // it did not.
  //
  // AND ATTACHED, WHICH IS A SECOND FACT (KAN-136). "Leave it alone" is only
  // right about an agent this daemon can still reach, and a daemon that just
  // booted can reach nothing: herdr owns the panes, the session map died with
  // the process that held it. Built on ownership alone, this set contained
  // every surviving agent at boot — so reconcile skipped the whole fleet, no
  // terminal was attached, and restart survival, the one behaviour this file
  // exists for, was a log line saying the agents were fine and nothing else.
  //
  // At boot the session map is empty, so this reduces to "re-attach
  // everything", which is the intent. It stays meaningful for any later caller
  // — an agent we are already carrying is genuinely nothing to do.
  //
  // WHY BOTH PROPERTIES, RATHER THAN A CHOICE BETWEEN THEM (KAN-134). That
  // ticket found `verify-fleet-switch-live` section 3 red on `main` and framed
  // two defensible readings, saying they needed deciding rather than patching:
  // either not spawning a second copy is the whole point and the script's
  // assertion is out of date, or a daemon that holds no attach to an agent it
  // supervises is a different fleet from the one that script was written
  // against. BOTH are right about what they defend and NEITHER is the fix,
  // because they are answers to the two different questions named above. The
  // decision is to hold both: recognise the survivor — nothing is spawned,
  // unchanged — and then attach to it.
  //
  // The `shell` launcher is where this surfaced, and not by coincidence. T1
  // widened `ourPaneIn` so a bare prompt counts as its own agent, which is
  // correct — for that launcher the prompt IS the delivered product. The
  // consequence was that a surviving `shell` pane became recognisable for the
  // first time, so ownership alone started answering "leave it alone" for the
  // case it had previously answered by accident. KAN-134 records that account:
  // before T1 a `shell` probe had no runtime, failed the ownership test, was
  // therefore not in this set, and got restored through `activate` — which
  // re-attached. The re-attach was real and nothing in the design had asked for
  // it, so widening ownership took it away without touching anything that named
  // it. Stating it is this conjunct.
  //
  // WHAT MAKES ATTACHING HERE SAFE, rather than a smaller version of "restore
  // it through `activate`" — which is the verb that accident used and the wrong
  // one, because it can spawn: `attachSession` performs no provisioning. No
  // prompt file is rewritten, no `launcher.setup` runs, no `.mcp.json` is
  // touched. That is asserted as FILES rather than as calls, by
  // `verify-restart-survival` section 6 (KAN-170 item 12), and the assertion is
  // load-bearing rather than defensive: a re-attach that re-provisioned would
  // rewrite the working directory of an agent that has been in it for an hour,
  // and doing so idempotently is exactly what would keep it invisible.
  //
  // WHAT HOLDS THIS, and the seam between the two, because neither proof covers
  // the other's half and no third thing covers the gap:
  //
  //   * `verify-restart-survival` — in the CI array. Runs BOTH launchers
  //     through the whole sequence, counts panes and counts `agent start` from
  //     a stub's argv log. It proves this daemon's half exhaustively, and the
  //     herdr it proves it against is one this suite wrote.
  //   * `verify-fleet-switch-live` section 3 — hand-run, deliberately excluded
  //     from CI. SIGKILLs a real daemon and takes `herdr agent list` as ground
  //     truth, so it is the only thing that establishes a real herdr 0.6.x
  //     honours `agent attach --takeover` over the attach slot a dead daemon's
  //     PTY still holds. Nothing on a runner can establish that.
  //
  // Deleting the `getSessionByPath` conjunct below reproduces KAN-134 in both,
  // and the recipe is written here rather than left to be rediscovered: the
  // first fails every assertion in its section 2 for BOTH launchers (15 in
  // total the run this was written from), the second prints
  // `row=false panes=1 missing=0` — the line the ticket was filed with — under
  // a reconcile log reading `is already running; leaving it alone.` That has
  // been run, on herdr 0.6.4, rather than reasoned about.
  const census = herdrBridge.listHerdrAgentsChecked();
  const alive = new Set(
    expected
      .filter(
        (r) =>
          ourPaneIn(census, r.path, r.config.launcher) !== null &&
          herdrBridge.getSessionByPath(r.path) !== undefined
      )
      .map((r) => r.path)
  );

  const outcomes: RestoreOutcome[] = [];
  let started = 0;

  /** One restore attempt through the real activation path. */
  const restore = async (agentPath: string): Promise<RestoreOutcome> => {
    const paneName = paneNameFor(agentPath);
    let response: any = null;
    try {
      await router.handleActivate(
        {
          path: agentPath,
          resume: cause
          // NO `override` HERE, AND THAT IS THE CHANGE (KAN-263). It used to be
          // `override: true`, on this reasoning:
          //
          //   "These agents were being carried when the power went out, so the
          //    machine has already demonstrated it can hold them. Refusing them
          //    at boot on a load average that is high *because the machine is
          //    booting* would recreate exactly the silent loss the registry
          //    exists to remove."
          //
          // Both halves of that have lapsed, and neither lapsed quietly.
          //
          // THE INSTRUMENT IT FEARED IS NO LONGER THE INSTRUMENT THAT GATES.
          // When it was written the CPU-side bound WAS `os.loadavg()[0]`, which
          // is inflated at boot by every service starting at once and by
          // uninterruptible sleep besides. Since KAN-208 the load average does
          // not bind wherever CPU was observed, and daemon.ts opens a
          // deliberately short first window (CPU_FIRST_WINDOW_MS = 3s) exactly
          // so that boot-time activations are decided by a measurement rather
          // than by the fallback. This pass additionally waits up to 60s for
          // herdr before its first restore, so by the time anything is started
          // the sampler has published. The residual case is a machine with no
          // readable /proc/stat, where the load average still stands in — and
          // there the argument above is still true, which is why it is quoted
          // rather than deleted.
          //
          // AND THE PREMISE IS ABOUT A MACHINE THAT IS GONE. "It has already
          // demonstrated it can hold them" is a claim about the machine before
          // the event that made this pass necessary. A hard power-off is the
          // machine demonstrating the opposite, and a fleet that was over
          // capacity is a plausible reason for the reboot rather than an
          // exception to it.
          //
          // WHAT THE OVERRIDE ACTUALLY BOUGHT was not a relaxed gate: with it
          // set, `capacityGate` returns `refusal: null` unconditionally
          // (router.ts, the `if (!override)` branch), so the number of agents a
          // restore pass could admit was bounded by NOTHING. That is the shape
          // of the incident this ticket was filed after.
          //
          // The occupancy guard is untouched by any of this and always was:
          // `override` is a decision about the machine's capacity, never a
          // licence to put a second agent into a directory somebody else's is
          // working in.
        },
        (msg: any) => {
          response = msg;
        }
      );
    } catch (e: any) {
      const error = e?.message ?? String(e);
      log(`[reconcile] Restoring ${agentPath} threw: ${error}`);
      return { path: agentPath, paneName, result: 'failed', error };
    }

    if (!response?.success) {
      const error = response?.error ?? 'activation returned no response';
      // The refusals that are about US rather than about this agent. See the
      // header: they are deferred, not failed, and nothing is recorded.
      if (response?.refused === 'unverifiable') {
        log(
          `[reconcile] Deferring ${agentPath}: herdr did not answer the occupancy check, so ` +
          `nothing was started. Its record still says it should be running.`
        );
        return { path: agentPath, paneName, result: 'deferred', deferredBy: 'herdr', error };
      }

      // THE MACHINE, NOT THE AGENT (KAN-263). Since the override came off this
      // pass, a restore can be refused for capacity — and it belongs on the
      // same branch as the herdr refusal, for the same three reasons the header
      // gives. Calling it `failed` would put the word "failed" beside an agent
      // that is perfectly restorable and will restore itself the moment the
      // machine has room; recording anything would take it out of `expected()`
      // and turn a busy minute into a permanent disappearance.
      //
      // WHAT MAKES THIS SAFE TO DEFER RATHER THAN A SILENT SHORTFALL, and it is
      // the whole reason the override could be removed at all: nothing is
      // written, so the agent stays `expected()`; the deferred pass retries it
      // once; and anything still unrestored afterwards is reported by the
      // missing-agent sweep every 30s and in every `list_agents` poll. Two
      // independent channels keep saying so until somebody acts. The override's
      // fear was silent loss, and the answer to loss is retry-and-say-so, not a
      // gate that cannot refuse.
      //
      // THE GATE'S OWN WORDS GO IN THE LOG, VERBATIM, rather than a summary of
      // them or a re-assembly from the pieces. `error` is what `capacityRefusal`
      // produced: the binding constraint as a HEADLINE (`cpu too busy`, `not
      // enough memory`, `machine stalled on io`) followed by the whole
      // derivation. A reader looking at a boot that came back three agents short
      // needs the headline to know what to do and the arithmetic to check that
      // it is true, and quoting the gate is the only way those two cannot drift
      // from what the gate actually decided.
      if (response?.refusedBy === 'capacity') {
        log(
          `[reconcile] Deferring ${agentPath}: this machine has no room for it right now. ` +
          `Nothing was started and nothing was recorded, so it is still expected and will be ` +
          `retried; if it is still refused it is reported as missing every 30s rather than ` +
          `forgotten.\n${error}`
        );
        return { path: agentPath, paneName, result: 'deferred', deferredBy: 'capacity', error };
      }

      // ITS DIRECTORY IS GONE (KAN-619). Named rather than folded into
      // `failed`, and still attempted rather than skipped — {@link
      // RECONCILE_STRANDED} is the whole argument, including why the retry
      // stays.
      //
      // The test is the refusal the daemon actually gave, not a second
      // `existsSync` taken here. A stat of our own would be a SECOND reading of
      // the filesystem, taken at a different instant from the one that decided
      // the refusal, and the two could disagree across exactly the late mount
      // this outcome exists to keep waiting for — at which point this pass
      // would label an agent stranded that `activate` refused for some other
      // reason, or the reverse. `pathProblem` is the daemon's own verdict on
      // the address it was given (KAN-382, and it is on this branch precisely
      // so a caller need not re-derive it), so the classification and the
      // refusal cannot come apart.
      if (response?.pathProblem === 'does-not-exist') {
        log(
          `[reconcile] ${agentPath} is stranded: its directory no longer exists, so there is ` +
          `nothing to restore into and \`activate\` refused the path. Nothing was recorded, so ` +
          `its record still says it should be running and this pass will try again at the next ` +
          `boot — a directory can also be absent because a mount is late. If the directory is ` +
          `gone for good, \`crabcast forget\` is what retires the record; nothing here removes ` +
          `it for you. It is reported under \`strandedAgents\` on every \`list_agents\`.`
        );
        return { path: agentPath, paneName, result: 'stranded', error };
      }

      log(`[reconcile] Could not restore ${agentPath}: ${error}`);
      return { path: agentPath, paneName, result: 'failed', error };
    }

    // THE PANE WAS STILL THERE, and `activate` re-attached to it rather than
    // starting anything (KAN-136). Told apart from a restore by the response's
    // own `alreadyRunning`, not guessed at: an agent whose process never died
    // has all of its memory, is mid-turn on whatever it was doing, and has
    // nothing to resume. Nudging it would type "carry on with your work" at an
    // agent that never stopped — and calling it `restored` would put a line in
    // the boot summary claiming this daemon started something it did not.
    if (response.alreadyRunning === true) {
      // THE POSTCONDITION, CHECKED RATHER THAN ASSUMED. What went wrong here
      // is precisely that a survivor was reported fine while this daemon held
      // no terminal for it, so "the response said alreadyRunning" is not the
      // fact worth logging — a session id coming back is. `activate` answers
      // `success: false` when it cannot attach, so this branch is unreachable
      // today; it is here so that if it ever becomes reachable again the boot
      // log SAYS SO instead of printing a re-attach that did not happen.
      if (typeof response.sessionId !== 'string') {
        const error =
          `${agentPath} is running and this daemon holds no terminal for it: activate ` +
          `reported it already running but returned no session id, so nothing can read it, ` +
          `type at it, or notice it dying except the 30s sweep.`;
        log(`[reconcile] ${error}`);
        return { path: agentPath, paneName, result: 'failed', error };
      }

      log(
        `[reconcile] ${agentPath} survived with its pane intact; re-attached to it ` +
        `(session ${response.sessionId}). Nothing was started and it has nothing to resume.`
      );
      return { path: agentPath, paneName, result: 'reattached' };
    }

    const outcome: RestoreOutcome = {
      path: agentPath,
      paneName,
      result: 'restored',
      resumedConversation: response.resumedConversation === true
    };

    // The half of a resume that is not respawning. An agent whose conversation
    // came back has all of its memory and no turn to take: Claude Code resumes
    // at an empty prompt and waits, which is precisely how two agents sat idle
    // on the day the extraction source's KAN-21 was filed, until a human
    // retyped their instructions. The other branch needs no message — its
    // prompt went in on the command line and it is already working.
    if (outcome.resumedConversation) {
      const record = registry.intents().get(agentPath);
      const nudge = await nudgeResumedAgent({
        herdrBridge,
        path: agentPath,
        cause,
        launcher: record?.record.config.launcher,
        log
      });
      outcome.nudged = nudge.nudged;
      if (nudge.error) outcome.error = nudge.error;
    } else {
      log(
        `[reconcile] ${agentPath} had no conversation to restore; ` +
        `it started with the degraded-resume prompt and is already working.`
      );
    }

    return outcome;
  };

  for (const record of expected) {
    const agentPath = record.path;

    if (alive.has(agentPath)) {
      log(`[reconcile] ${agentPath} is already running; leaving it alone.`);
      outcomes.push({ path: agentPath, paneName: paneNameFor(agentPath), result: 'already-running' });
      continue;
    }

    // Not the first one: stagger between *starts*, not before the first.
    if (started > 0) await delay(RESTORE_STAGGER_MS);
    started++;

    log(`[reconcile] Restoring ${agentPath}`);
    outcomes.push(await restore(agentPath));
  }

  // The deferred pass. One retry, behind a fresh wait, and only for agents
  // whose refusal was about herdr rather than about them.
  const deferred = outcomes.filter((o) => o.result === 'deferred');
  if (deferred.length) {
    // Counted by reason, because "3 deferred" reads as one condition and is
    // two: a herdr blip clears on its own and a full machine may not.
    const byHerdr = deferred.filter((o) => o.deferredBy !== 'capacity').length;
    const byCapacity = deferred.filter((o) => o.deferredBy === 'capacity').length;
    const reasons = [
      byHerdr ? `${byHerdr} because herdr could not confirm their directories were free` : '',
      byCapacity ? `${byCapacity} because this machine had no room for them` : ''
    ].filter(Boolean).join(', and ');
    log(
      `[reconcile] ${deferred.length} agent(s) were deferred — ${reasons}. Waiting up to ` +
      `${DEFERRED_RETRY_WAIT_MS / 1000}s for herdr to answer, then retrying them once — a ` +
      `restore needs herdr whichever refused it. Nothing has been recorded for them, so they ` +
      `are still expected either way.`
    );
    if (await waitForHerdr(herdrBridge, DEFERRED_RETRY_WAIT_MS)) {
      for (const entry of deferred) {
        await delay(RESTORE_STAGGER_MS);
        const retried = await restore(entry.path);
        // REPLACED in place, not merged. `Object.assign` left the first
        // attempt's `error` on an outcome the retry had succeeded — so a
        // restored agent came back carrying "herdr did not answer the
        // occupancy check", which reads as a failure that did not happen.
        // Every key of an outcome belongs to one attempt.
        for (const key of Object.keys(entry)) delete (entry as any)[key];
        Object.assign(entry, retried);
      }
    } else {
      log(
        `[reconcile] herdr still did not answer. The deferred agent(s) are left expected and ` +
        `unrestored — NOT marked lost, because nothing here established that they are gone. ` +
        `The missing-agent sweep will report them every 30s and \`list_agents\` on every poll, ` +
        `so this is visible rather than silent, and re-activating them is one call.`
      );
    }
  }

  // THE SHORTFALL, SAID OUT LOUD (KAN-263). Before the override came off, this
  // pass restored everything it was asked to and had nothing to report. It can
  // now come back short on purpose, and a boot that quietly returns three of ten
  // agents is indistinguishable — from the log, which is all anybody reads at
  // boot — from a machine that had room for ten and only ever had three. So the
  // count is named, with the reason beside it, at the one moment a reader is
  // looking. Silence here would be the KAN-21 shape this whole file exists to
  // remove, reintroduced by its own fix.
  const stillDeferred = outcomes.filter((o) => o.result === 'deferred');
  if (stillDeferred.length) {
    const heldForCapacity = stillDeferred.filter((o) => o.deferredBy === 'capacity');
    log(
      `[reconcile] ${outcomes.filter((o) => o.result === 'restored').length} restored, ` +
      `${outcomes.filter((o) => o.result === 'reattached').length} re-attached, ` +
      `${stillDeferred.length} still deferred of ${expected.length} expected` +
      (heldForCapacity.length
        ? ` — ${heldForCapacity.length} of them held back because this machine had no room: ` +
          `${heldForCapacity.map((o) => o.path).join(', ')}. They are still expected, nothing ` +
          `was recorded against them, and the missing-agent sweep reports them every 30s. ` +
          `Stand an agent down or wait for the machine to quieten, then re-activate.`
        : '.')
    );
  }

  return { expected: expected.length, outcomes };
}
