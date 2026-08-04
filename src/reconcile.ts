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
   */
  result: 'already-running' | 'reattached' | 'restored' | 'failed' | 'deferred';
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
 *    summary says nothing, which is the KAN-21 shape exactly.
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
 *     sweep, broadcast as `agent_lost_event`, and reported in every
 *     `list_agents` poll. So it cannot be a silent skip either: two
 *     independent channels report it until somebody acts.
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
          resume: cause,
          // These agents were being carried when the power went out, so the
          // machine has already demonstrated it can hold them. Refusing them at
          // boot on a load average that is high *because the machine is
          // booting* would recreate exactly the silent loss the registry
          // exists to remove. The override is still recorded and broadcast, so
          // over-staffing stays deliberate and visible.
          //
          // It does NOT override the occupancy guard, and must not: `override`
          // is a decision about the machine's capacity, not a licence to put a
          // second agent into a directory somebody else's is working in.
          override: true
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
      // The one refusal that is about US rather than about this agent. See the
      // header: it is deferred, not failed, and nothing is recorded.
      if (response?.refused === 'unverifiable') {
        log(
          `[reconcile] Deferring ${agentPath}: herdr did not answer the occupancy check, so ` +
          `nothing was started. Its record still says it should be running.`
        );
        return { path: agentPath, paneName, result: 'deferred', error };
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
    log(
      `[reconcile] ${deferred.length} agent(s) were deferred because herdr could not confirm ` +
      `their directories were free. Waiting up to ${DEFERRED_RETRY_WAIT_MS / 1000}s for it to ` +
      `answer, then retrying them once. Nothing has been recorded for them, so they are still ` +
      `expected either way.`
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

  return { expected: expected.length, outcomes };
}
