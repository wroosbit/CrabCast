import { HerdrBridge } from './herdr.js';
import { ResumeCause, resumeNudge } from './resume.js';
import { resolveLauncher } from './launchers.js';

/**
 * Telling a restored agent to carry on.
 *
 * The extraction source's KAN-21 established the finding this exists for: an
 * agent whose conversation *was* restored has all of its memory and no turn to
 * take, because Claude Code resumes at an empty prompt and waits indefinitely.
 * On the day that ticket was filed, two agents sat like that until a human
 * retyped their instructions.
 *
 * Its KAN-37 made the same thing happen on a path that has nothing to do with
 * booting: a preempted agent, re-activated by its supervisor, restores its
 * conversation and then sits silent. A preemption whose victim comes back and
 * idles is a work-shredder with extra steps, so both callers — boot-time
 * reconciliation and the router's re-activation path — go through here and
 * cannot drift apart.
 *
 * WHAT MOVED IN THE PORT: the extraction source hardcoded Claude Code's
 * readiness markers here and guarded on `defaultAgent !== 'claude'`. Both were
 * knowledge of one launcher living in generic machinery, so they became
 * per-launcher properties — {@link AgentLauncher.readyMarkers} and
 * {@link AgentLauncher.restoresConversation} — and a new launcher declares its
 * own readiness evidence instead of inheriting Claude's.
 */

/** How long an agent gets to reach its prompt before a nudge is typed at it. */
const AGENT_READY_TIMEOUT_MS = 120_000;
const AGENT_READY_POLL_MS = 2_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Elapsed time that does not count time the machine spent asleep.
 *
 * These budgets exist to bound *waiting*, and `Date.now()` does not measure
 * waiting — it measures the wall clock, which keeps running through a suspend
 * while nothing here does. This is not hypothetical: on the reboot that proved
 * the extraction source's KAN-21, the laptop suspended 1.5 seconds into
 * restoring the first agent and woke five hours and forty minutes later. The
 * 120-second budget below had expired without a single poll ever being taken
 * after the machine came back, so a restored agent that was very probably
 * sitting at a healthy prompt was written off as "never reached a prompt
 * within 120s" and never nudged — the exact idle-forever failure this exists
 * to prevent — and the second agent waited out the whole suspend behind it.
 *
 * `performance.now()` is CLOCK_MONOTONIC on Linux, which excludes suspended
 * time. So the budget means what it says: 120 seconds of the machine actually
 * being awake, whenever those seconds happen to occur.
 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * Wait until an agent's pane looks like a prompt rather than a launching shell.
 * Returns false on timeout, which is a reason not to type at it rather than a
 * reason to fail the restore — the agent is up either way.
 *
 * `readyMarkers` is the launcher's own evidence that its runtime has finished
 * starting and is listening — read off the pane rather than asked of herdr
 * because herdr's `agent_status` reports what its hooks last told it, which on
 * a freshly spawned agent is nothing. A nudge typed before a marker appears
 * would go to the bash that is still starting the runtime.
 */
export async function waitForAgentReady(
  herdrBridge: HerdrBridge,
  key: string,
  type: string,
  readyMarkers: string[]
): Promise<boolean> {
  const deadline = monotonicNow() + AGENT_READY_TIMEOUT_MS;
  for (;;) {
    const tail = herdrBridge.tailAgent(key, type, 40);
    if (tail.success && typeof tail.text === 'string') {
      const text = tail.text.toLowerCase();
      if (readyMarkers.some((marker) => text.includes(marker.toLowerCase()))) return true;
    }
    if (monotonicNow() >= deadline) return false;
    await delay(AGENT_READY_POLL_MS);
  }
}

/** What the nudge did, for the log and for the caller's outcome record. */
export interface NudgeResult {
  nudged: boolean;
  error?: string;
}

/**
 * Wait for a restored agent's prompt and tell it, in words, that it was
 * interrupted and what to do about it.
 *
 * Only for agents whose conversation actually came back. The other branch needs
 * no message: its prompt went in on the command line (the degraded-resume
 * framing) and it is already working. Never throws — every caller is either a
 * boot-time sweep or a fire-and-forget from a request handler that has already
 * answered.
 */
export async function nudgeResumedAgent(opts: {
  herdrBridge: HerdrBridge;
  type: string;
  key: string;
  cause: ResumeCause;
  /** Which launcher the caller asked for, when it named one. */
  defaultAgent?: string;
  /** The workspace type's `defaultLauncher` from config, for the fallback. */
  typeDefaultLauncher?: string;
  log: (...args: any[]) => void;
}): Promise<NudgeResult> {
  const { herdrBridge, type, key, cause, defaultAgent, typeDefaultLauncher, log } = opts;
  const label = `${type}/${key}`;

  // The same resolution order the spawn used, so the launcher judged here is
  // the launcher that actually ran. An unresolvable name cannot be nudged and
  // says so, rather than guessing at a launcher it might have been.
  let launcher;
  try {
    ({ launcher } = resolveLauncher(defaultAgent, typeDefaultLauncher));
  } catch (e: any) {
    const error = e?.message ?? String(e);
    log(`[nudge] ${label} has no resolvable launcher; not nudging: ${error}`);
    return { nudged: false, error };
  }

  if (!launcher.restoresConversation) {
    // This launcher came up fresh; there is nothing to nudge it about.
    return { nudged: false };
  }

  try {
    if (!(await waitForAgentReady(herdrBridge, key, type, launcher.readyMarkers ?? []))) {
      log(
        `[nudge] ${label} restored its conversation but never reached a prompt within ` +
        `${AGENT_READY_TIMEOUT_MS / 1000}s; not typing at it. It will sit idle until nudged.`
      );
      return { nudged: false, error: 'agent did not reach a prompt in time' };
    }

    const sent = await herdrBridge.sendToAgent(key, resumeNudge(type, key, cause), type);
    log(
      `[nudge] ${label} restored its conversation; ` +
      (sent.success
        ? 'sent it the interrupted-work message.'
        : `could NOT send the interrupted-work message: ${sent.error}. It will sit idle.`)
    );
    return { nudged: sent.success, ...(sent.success ? {} : { error: sent.error }) };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    log(`[nudge] ${label} could not be nudged: ${error}`);
    return { nudged: false, error };
  }
}
