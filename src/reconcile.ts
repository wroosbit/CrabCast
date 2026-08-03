import { AgentRegistry } from './agent-registry.js';
import { HerdrBridge } from './herdr.js';
import { MessageRouter } from './router.js';
import { WorkspaceRegistry } from './registry.js';
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
 * lifecycle, it triggered it. So restoration can go through the very same
 * `handleActivateByKey` a CLI or MCP call uses, with nobody connected at all.
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

/** What one agent's restoration did, for the log and for the caller. */
export interface RestoreOutcome {
  agentName: string;
  type: string;
  key: string;
  /** 'already-running' | 'restored' | 'failed' */
  result: 'already-running' | 'restored' | 'failed';
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
async function waitForHerdr(herdrBridge: HerdrBridge): Promise<boolean> {
  const deadline = monotonicNow() + HERDR_READY_TIMEOUT_MS;
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
 */
export async function reconcileAgents(opts: {
  registry: AgentRegistry;
  herdrBridge: HerdrBridge;
  router: MessageRouter;
  /** The workspace-type config, for each type's `defaultLauncher` fallback. */
  workspaceTypes: WorkspaceRegistry;
  cause: ResumeCause;
  log: (...args: any[]) => void;
}): Promise<ReconcileResult> {
  const { registry, herdrBridge, router, workspaceTypes, cause, log } = opts;

  const expected = registry.expected();
  if (expected.length === 0) {
    log('[reconcile] The agent registry records no agents that should be running.');
    return { expected: 0, outcomes: [] };
  }

  log(`[reconcile] Registry expects ${expected.length} agent(s) to be running.`);

  if (!(await waitForHerdr(herdrBridge))) {
    log(
      `[reconcile] herdr did not become reachable within ${HERDR_READY_TIMEOUT_MS / 1000}s; ` +
      `skipping restoration rather than starting a second copy of a fleet that may already exist. ` +
      `The ${expected.length} expected agent(s) will be reported as missing.`
    );
    return { expected: expected.length, outcomes: [] };
  }

  // herdr's own view, taken once: what actually survived.
  const alive = new Set(
    herdrBridge.listHerdrAgents().filter((agent) => agent.agentRuntime).map((agent) => agent.name)
  );

  const outcomes: RestoreOutcome[] = [];
  let restored = 0;

  for (const record of expected) {
    const { agentName, type, key } = record;

    if (alive.has(agentName)) {
      log(`[reconcile] ${agentName} is already running; leaving it alone.`);
      outcomes.push({ agentName, type, key, result: 'already-running' });
      continue;
    }

    // Not the first one: stagger between *starts*, not before the first.
    if (restored > 0) await delay(RESTORE_STAGGER_MS);
    restored++;

    log(`[reconcile] Restoring ${agentName} (${type}/${key}) in ${record.workDir}`);

    let response: any = null;
    try {
      await router.handleActivateByKey(
        {
          type,
          key,
          url: record.url,
          defaultAgent: record.defaultAgent,
          resume: cause,
          // These agents were being carried when the power went out, so the
          // machine has already demonstrated it can hold them. Refusing them at
          // boot on a load average that is high *because the machine is
          // booting* would recreate exactly the silent loss the registry
          // exists to remove. The override is still recorded and broadcast, so
          // over-staffing stays deliberate and visible.
          override: true
        },
        (msg: any) => {
          response = msg;
        }
      );
    } catch (e: any) {
      const error = e?.message ?? String(e);
      log(`[reconcile] Restoring ${agentName} threw: ${error}`);
      outcomes.push({ agentName, type, key, result: 'failed', error });
      continue;
    }

    if (!response?.success) {
      const error = response?.error ?? 'activation returned no response';
      log(`[reconcile] Could not restore ${agentName}: ${error}`);
      outcomes.push({ agentName, type, key, result: 'failed', error });
      continue;
    }

    const outcome: RestoreOutcome = {
      agentName,
      type,
      key,
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
      const nudge = await nudgeResumedAgent({
        herdrBridge,
        type,
        key,
        cause,
        defaultAgent: record.defaultAgent,
        typeDefaultLauncher: workspaceTypes.get(type)?.defaultLauncher,
        log
      });
      outcome.nudged = nudge.nudged;
      if (nudge.error) outcome.error = nudge.error;
    } else {
      log(
        `[reconcile] ${agentName} had no conversation to restore; ` +
        `it started with the degraded-resume prompt and is already working.`
      );
    }

    outcomes.push(outcome);
  }

  return { expected: expected.length, outcomes };
}
