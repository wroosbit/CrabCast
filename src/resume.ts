import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROMPT_FILENAME } from './launchers.js';

/**
 * Bringing an agent back after the machine died under it.
 *
 * Re-spawning is the easy half. The half the extraction source's KAN-21 was
 * actually about is that an agent which comes back with no instruction *idles
 * forever*, and that this looks identical to an agent that has finished. Both
 * of the paths below therefore end with the agent being told, in words, that
 * it was interrupted and what to do about it.
 *
 * WHAT WAS MEASURED, because the ticket's premise turned out to be wrong
 *
 * Claude Code 2.1.220 was tested on this host in a real PTY. Its transcript
 * (`~/.claude/projects/<mangled cwd>/<sessionId>.jsonl`) is written *eagerly*,
 * per event; it survives SIGKILL with no shutdown hook; a deliberately torn
 * final record still resumes; and `--continue` restores the prior turns.
 * `--continue` against a directory with genuinely no history exits 1 with
 * "No conversation found to continue", which is what makes the launcher's
 * `||` fallback correct.
 *
 * So conversation restoration was never the broken part. The two things that
 * genuinely stop an unattended resume are handled here and in launchers.ts:
 * the resume modal (see RESUME_ENV) and the missing instruction (see below).
 */

/**
 * Environment that keeps a resume from stopping to ask a question nobody is
 * there to answer.
 *
 * Claude Code offers "Resume from summary / Resume full session as-is / Don't
 * ask me again" when a resumed conversation is **both** older than
 * `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) **and** larger than
 * `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100000). That is the exact
 * profile of an agent that has been working all afternoon — which is why it
 * was hit twice on the day this was written, and never by a fresh agent.
 * Unattended, the modal is a hang: the pane sits on a menu until a human
 * happens to look.
 *
 * Both thresholds are read from the environment by the CLI itself, so raising
 * them past any real conversation is a supported configuration rather than a
 * trick. The consequence is deliberate and worth stating: suppressing the
 * prompt means always taking the "full session" branch, which is the more
 * expensive of the two. For an unattended agent that is the right default —
 * its context is the thing being restored — but it is a real cost, not a free
 * win.
 */
export const RESUME_ENV: Record<string, string> = {
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '525600', // one year of minutes
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '1000000000'
};

/**
 * Claude Code's transcript directory for a working directory.
 *
 * The CLI keys history on the cwd with every non-alphanumeric character
 * replaced by a dash — verified against directories this machine had already
 * accumulated, e.g. `/home/user/.local/share/crabcast/workspaces/shell/demo`
 * → `-home-user--local-share-crabcast-workspaces-shell-demo` (the doubled
 * dash is the `/` and the `.` of `/.local`).
 *
 * This is knowledge of another program's internals, so it is isolated here and
 * used for exactly one decision — see {@link hasRestorableConversation} — that
 * is safe to get wrong.
 */
export function claudeTranscriptDir(workDir: string): string {
  const key = path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', key);
}

/**
 * Whether `claude --continue` will have something to restore in this
 * workspace.
 *
 * Used to choose which resume framing the agent gets, and deliberately not
 * used for anything that would break if it were wrong:
 *
 * - a false positive (we think there is history, there is none) means the
 *   launcher's fallback runs with resume framing anyway, and the nudge arrives
 *   at an agent that is already reading its instructions — harmless
 *   duplication;
 * - a false negative (history exists, we miss it) means `--continue` restores
 *   the conversation and no nudge is sent, leaving an idle-but-remembering
 *   agent — which is the case fleet reporting exists to surface.
 *
 * Zero-length files do not count: an empty transcript is what a session that
 * died before its first write leaves behind, and `--continue` finds nothing in
 * it either.
 */
export function hasRestorableConversation(workDir: string): boolean {
  const dir = claudeTranscriptDir(workDir);
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .some((name) => {
        try {
          return fs.statSync(path.join(dir, name)).size > 0;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * Why an agent is being brought back, which decides how it is addressed.
 *
 * `preempted` is the one that is nobody's accident. The other two are failures
 * — a machine or a daemon died — and the agent is told so. A preempted agent
 * was stopped on purpose, by a person, to let more important work run, and
 * telling it that its machine crashed would be a lie about its own history that
 * it would then act on. Preemption without resumption is destruction, and the
 * framing below is the difference.
 */
export type ResumeCause = 'reboot' | 'daemon-restart' | 'preempted';

function causeSentence(cause: ResumeCause): string {
  if (cause === 'reboot') {
    return 'The machine you were running on restarted (a reboot or a power cut), which destroyed your terminal mid-task.';
  }
  if (cause === 'preempted') {
    return (
      'You were deliberately stood down to free capacity for higher-priority work, ' +
      'which ended your terminal mid-task. This was a decision, not a crash: nothing ' +
      'was wrong with what you were doing, and you are being brought back to finish it.'
    );
  }
  return 'The CrabCast daemon restarted, which destroyed your terminal mid-task.';
}

/**
 * What a restored agent is told when its conversation *did* come back.
 *
 * It has its memory but no turn to take: Claude Code resumes at an empty
 * prompt and waits — indefinitely, unattended. This message is the manual
 * "carry on" a supervising human would otherwise have to type, automated.
 *
 * It says "check what you already did" rather than "carry on" because the
 * agent's last remembered turn may have completed after its final transcript
 * write; the workspace is the ground truth, not its memory of it.
 */
export function resumeNudge(type: string, key: string, cause: ResumeCause = 'reboot'): string {
  return [
    `[crabcast] You were interrupted mid-work. ${causeSentence(cause)}`,
    `You have been restored automatically and this conversation is your own history — but your last remembered action may not have finished, and nothing has been done on your behalf since.`,
    `Do not start over. First establish what already exists: check this workspace and, if you have a repository checkout here, its status, diff, branch, commits and whether your work is already published. Re-check ${key} for anything recorded there while you were gone.`,
    `Then continue the task from wherever that evidence says you actually got to, and say in one line what state you found before you resume work.`
  ].join(' ');
}

/**
 * The prompt an agent gets when its conversation could **not** be restored.
 *
 * This goes in as the launcher's argv prompt rather than as a message typed
 * afterwards, so the agent starts working the moment the pane opens and does
 * not depend on anything else being delivered. That is the difference between
 * this and {@link resumeNudge}: a nudge that fails leaves an idle agent, and
 * an agent with no memory at all is the one that can least afford to idle.
 *
 * It is deliberately not the cold-start prompt. A cold start would have the
 * agent claim its work and begin as though nothing had happened, silently
 * redoing — or worse, conflicting with — work already committed and pushed.
 */
export function degradedResumePrompt(
  type: string,
  key: string,
  cause: ResumeCause = 'reboot'
): string {
  return [
    `You are a CrabCast agent for ${type} ${key}, and you have just been restarted with NO memory of your previous session.`,
    causeSentence(cause),
    `Your prior conversation could not be recovered, so treat everything you would normally remember as lost — but assume work was already done.`,
    ``,
    `Before doing anything else, find out what you already did:`,
    `1. Read ${PROMPT_FILENAME} in this directory for your original instructions.`,
    `2. Inspect this workspace. If it contains a repository checkout, check its branch, status, diff, log, and whether your work is already published or in review.`,
    `3. Re-check ${key} — including any notes your previous self may have left.`,
    ``,
    `Then state in a few lines what you found and what remains, and continue from there. Do not restart the task from scratch, and do not duplicate work that is already committed or already in review.`
  ].join('\n');
}
