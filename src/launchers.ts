import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bootstrap prompt file, written into the agent's SIDECAR — never into the
 * caller's directory.
 *
 * It used to be `.crabcast-prompt.md` in the agent's own working directory,
 * which cost nothing when CrabCast allocated that directory itself. It does
 * not any more: the directory is the caller's, and a file we drop into it is a
 * file somebody has to remember to remove. The sidecar
 * (`<dataDir>/agents/<hash>/`, see identity.ts) is ours outright, so the
 * prompt lives there and every reference to it is an absolute path.
 */
export const PROMPT_FILENAME = 'prompt.md';

/**
 * What a cold-started agent is told to read. A function of the file's absolute
 * path now rather than a constant, because the file no longer sits in the
 * agent's cwd — a bare filename would name nothing.
 */
export function promptInstruction(promptFile: string): string {
  return `Please read and follow the instructions in ${promptFile} to begin.`;
}

// MCP server definitions CrabCast can attach to an agent workspace.
function mcpServerDefinitions(servers: string[], daemonConfigPath?: string): Record<string, any> {
  const defs: Record<string, any> = {};
  // Absolute commands: the agent spawns these with the *pane's* PATH, which
  // can be thinner than ours (a login-started herdr server has no nvm) and
  // resolve `node` to an ancient system install. The daemon rewrites this
  // file on every activation, so the baked paths never go stale.
  //
  // `crabcast` is the daemon's own MCP server — how agents inspect and steer
  // each other over the same unix socket. mcp.js finds that socket through
  // the config (the socket lives under the config's dataDir), and the pane
  // environment does not carry it, so the definition bakes this daemon's own
  // config path in as CRABCAST_CONFIG — the same variable mcp.js's config
  // resolution already reads. Without it, a server spawned inside a
  // workspace would fall back to the default data dir and could address a
  // different daemon than the one that provisioned it.
  if (servers.includes('crabcast')) {
    defs['crabcast'] = {
      command: process.execPath,
      args: [path.join(__dirname, 'mcp.js')],
      ...(daemonConfigPath ? { env: { CRABCAST_CONFIG: daemonConfigPath } } : {})
    };
  }
  return defs;
}

// Claude Code reads .mcp.json from the project root, and each session's
// workDir is its project — so MCP config is scoped to the workspace instead
// of being injected into the user's global ~/.claude.json.
export function writeWorkspaceMcpConfig(
  workDir: string,
  servers: string[],
  daemonConfigPath?: string
): void {
  const defs = mcpServerDefinitions(servers, daemonConfigPath);
  if (Object.keys(defs).length === 0) return;

  const configPath = path.join(workDir, '.mcp.json');
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      // CrabCast owns this file; a corrupt one is replaced, not preserved.
      console.error('[Launchers] Replacing unparseable workspace .mcp.json', e);
      config = {};
    }
  }
  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write workspace .mcp.json', e);
  }
}

// The antigravity CLI has no project-scoped equivalent, so its global config
// is merged into — and never written when the existing file cannot be parsed,
// which would otherwise replace the user's config with just our entries.
export function configureAgyMcp(servers: string[], configPath?: string): void {
  const defs = mcpServerDefinitions(servers);
  // Nothing to contribute: leave the user's global config alone entirely.
  if (Object.keys(defs).length === 0) return;

  const agyConfigPath = configPath ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp.json');
  const agyConfigDir = path.dirname(agyConfigPath);
  let config: any = {};
  if (fs.existsSync(agyConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(agyConfigPath, 'utf8'));
    } catch (e) {
      console.error('[Launchers] agy mcp.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write agy mcp.json', e);
  }
}

// WHAT USED TO BE HERE, AND WHY IT IS NOT
//
// `configureClaudeSettings` wrote `.claude/settings.local.json` into every
// agent's working directory, setting `enableAllProjectMcpServers` and a
// `bypassPermissions` default mode. That was defensible while CrabCast
// allocated the directory: it was a disposable, agent-owned workspace, and the
// file was ours to create.
//
// It is not defensible now. The directory is the caller's — their repository
// checkout, with their own `.claude/` in it — and this daemon writing a
// permission policy into somebody else's project is the single most invasive
// thing it could do there. Worse, it is invisible: a merged key in a settings
// file nobody opened, silently widening what an agent may do in a tree the
// caller thought they controlled.
//
// So it is deleted rather than made conditional. The one thing it bought that
// still matters — the agent not stopping at a permission prompt nobody is
// there to answer — is already on the launcher's own command line below
// (`--permission-mode bypassPermissions`), where it is visible in the process
// list and scoped to the process CrabCast started, rather than left behind on
// disk for every later `claude` a human runs in that directory.
//
// This is a pure removal: nothing replaces it, and nothing in a later slice is
// meant to bring it back.

/** Outcome of recording folder trust; `ok: false` must refuse the activation. */
export interface TrustResult {
  ok: boolean;
  /** Write attempts made; 0 when the entry was already present on first read. */
  attempts: number;
  error?: string;
}

/**
 * Synchronous sleep. initPty is deliberately synchronous from resolveLauncher
 * to the spawn — no await for another activation to interleave into — and the
 * trust write below must stay inside that property, so its settle delay cannot
 * be a Promise.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How many times a clobbered trust entry is rewritten before the activation is
 * refused, and how long each write is given to be overwritten before it is
 * believed. Verifying in the same tick as the write proves nothing — the file
 * would still hold our own bytes even mid-race — so each attempt waits
 * TRUST_SETTLE_MS first, long enough for a competing writer's write-back to
 * land where the re-read can still see and repair it. Three attempts is not
 * tuning: a writer that outruns two repairs is rewriting the file continuously,
 * and no bounded retry beats that — refusing honestly does.
 */
const TRUST_WRITE_ATTEMPTS = 3;
const TRUST_SETTLE_MS = 60;

// Folder trust has no project-scoped setting — Claude Code only reads it from
// `projects[<dir>].hasTrustDialogAccepted` in the user's global ~/.claude.json
// (its own untrusted-workspace error names that key as the sole alternative to
// accepting the dialog by hand). That file holds unrelated user state, so this
// is add-only: bail if unparseable, write nothing if already trusted, and touch
// no key but this workspace's. The trust check walks parent directories, so
// trusting workDir also covers any repository the agent clones inside it.
//
// The write is racing Claude Code itself, and that fact picked the mechanism
// (KAN-54, in the extraction source). Live incident, 2026-08-02: four agents
// activated within ~7s; the last one's trust entry was missing from
// ~/.claude.json when its claude booted, and it sat wedged on the trust dialog
// behind a `success: true, verified: true` answer. Two candidate writers were
// named and tested:
//
//   1. A second briefly-coexisting daemon (the connectToDaemon spawn race in
//      ipc.ts). Ruled out structurally: the loser daemon hits EADDRINUSE,
//      probes the winner's socket and exits *without ever listening*
//      (daemon.ts). A daemon that never serves never writes.
//
//   2. The spawned `claude` processes themselves. Reproduced with the real
//      binary on 2026-08-02: claude reads ~/.claude.json at boot and writes
//      the whole file back from memory moments later; a trust entry injected
//      between that read and write-back (t+0.45s into boot, present on disk at
//      t+0.47s) was gone at t+0.48s and stayed gone. A sibling booting for an
//      earlier workspace erases entries written after its read — the incident
//      shape exactly, down to the *last*-activated workspace being the victim.
//
// So the racing writer lives in another process, and the rejected alternative
// follows: an in-daemon mutex or per-file promise chain serialises only this
// daemon, which — initPty being synchronous end-to-end — already cannot
// interleave with itself. What works against an external rewriter is what this
// function does: write atomically (temp-then-rename in the same directory, so
// a mid-write reader never parses a torn file), then re-read after a settle
// delay and repair a clobbered entry, bounded, and report failure instead of
// letting the caller spawn an agent into an untrusted folder. The residual
// window — a sibling's write-back landing after the last verify here but
// before the new claude reads the file — closes at the pre-spawn re-check
// (herdr.ts) and cannot be closed entirely from this side of the spawn;
// watching agents past their startup dialogs was explicitly deferred (KAN-49).
export function trustClaudeWorkspace(workDir: string, configPath?: string): TrustResult {
  const claudeConfigPath = configPath ?? path.join(os.homedir(), '.claude.json');
  // Claude Code keys projects by the normalized absolute path, nothing more.
  const trustKey = path.normalize(path.resolve(workDir));

  const read = (): { config: any } | { unreadable: string } => {
    if (!fs.existsSync(claudeConfigPath)) return { config: {} };
    try {
      return { config: JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')) };
    } catch (e: any) {
      return {
        unreadable:
          `${claudeConfigPath} exists but is unparseable; refusing to overwrite it ` +
          `(${e?.message ?? String(e)})`
      };
    }
  };
  const trusted = (config: any): boolean =>
    config.projects?.[trustKey]?.hasTrustDialogAccepted === true;

  for (let attempt = 1; attempt <= TRUST_WRITE_ATTEMPTS; attempt++) {
    const current = read();
    if ('unreadable' in current) {
      // Not retried: an unparseable file is user state we must not replace,
      // and it does not become parseable by waiting. (Our own writes can no
      // longer tear it — the rename below is atomic — so this is either a
      // torn write from an older Claude Code or genuine corruption.)
      console.error(`[Launchers] ${current.unreadable}`);
      return { ok: false, attempts: attempt - 1, error: current.unreadable };
    }
    if (trusted(current.config)) {
      if (attempt > 1) {
        console.log(
          `[Launchers] Trust entry for ${trustKey} stuck after ${attempt - 1} write attempt(s)`
        );
      }
      return { ok: true, attempts: attempt - 1 };
    }

    const config = current.config;
    config.projects = {
      ...config.projects,
      [trustKey]: { ...config.projects?.[trustKey], hasTrustDialogAccepted: true }
    };

    // Same directory as the target so the rename cannot cross filesystems and
    // stays atomic; pid + attempt keeps concurrent daemons off each other's
    // temp files.
    const tmpPath = `${claudeConfigPath}.crabcast-${process.pid}-${attempt}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, claudeConfigPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const error =
        `Failed to record workspace trust in ${claudeConfigPath}: ${e?.message ?? String(e)}`;
      console.error(`[Launchers] ${error}`);
      return { ok: false, attempts: attempt, error };
    }

    sleepSync(TRUST_SETTLE_MS);
    // Loop rather than return on a good re-read: the top of the next iteration
    // is the same check, and going around once more costs nothing when the
    // entry is present (the `trusted` early-return fires with attempts intact).
    const after = read();
    if (!('unreadable' in after) && trusted(after.config)) {
      return { ok: true, attempts: attempt };
    }
    console.error(
      `[Launchers] Trust entry for ${trustKey} was clobbered after write ` +
      `${attempt}/${TRUST_WRITE_ATTEMPTS} — a concurrent writer rewrote ${claudeConfigPath}`
    );
  }

  const error =
    `Trust entry for ${trustKey} in ${claudeConfigPath} would not stick after ` +
    `${TRUST_WRITE_ATTEMPTS} attempts; a concurrent writer keeps rewriting the file. ` +
    `Starting claude now would wedge it on the folder-trust dialog.`;
  console.error(`[Launchers] ${error}`);
  return { ok: false, attempts: TRUST_WRITE_ATTEMPTS, error };
}

/**
 * Wrap a string so bash sees exactly these bytes, newlines and all.
 *
 * The launcher command is handed to `bash -c`, and the prompt inside it can be
 * generated text (the degraded-resume framing) rather than a fixed literal, so
 * it must be quoted rather than interpolated. Single quotes disable every form
 * of bash expansion; the only character that needs work is a single quote
 * itself, which is closed, escaped and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface AgentLauncher {
  /**
   * Shell command run inside the herdr pane (via bash -c).
   *
   * A function rather than a constant because the prompt is not always the
   * same sentence: an agent being restored after a reboot whose conversation
   * could not be recovered must be told that, not greeted as if it were
   * starting fresh. `promptCommand` is what to say when there is no
   * conversation to continue.
   *
   * `undefined` is a real case rather than a default: `prompt` is an optional
   * `configure` parameter, and an agent configured without one is started with
   * no opening instruction at all. Substituting a generic one would be this
   * daemon inventing an instruction nobody wrote.
   */
  command: (promptCommand?: string) => string;
  /**
   * Optional pre-launch setup, e.g. CLI-specific MCP config. Throwing refuses
   * the activation: initPty answers with session.spawnError + terminated, the
   * same channel as an unknown launcher, so setup that did not stick is never
   * papered over with `success: true`.
   */
  setup?: (workDir: string, mcpServers: string[]) => void;
  /**
   * Re-run immediately before the pane spawn, after everything between setup
   * and the spawn (prompt write, `herdr agent get`) has had time to happen —
   * time in which another process can undo what setup wrote (KAN-54). Throws
   * to refuse the activation through the same spawnError channel.
   */
  preSpawnCheck?: (workDir: string) => void;
  /**
   * The process name (`comm` in /proc) of the agent runtime this launcher
   * starts, when it starts one. Absent for `shell`, which starts no runtime —
   * a bare bash prompt is its delivered product.
   *
   * This is what the cost sampler (agent-cost.ts) groups process trees under:
   * an agent's cost is the whole tree rooted at this process. Declared here,
   * next to the command that spawns it, so the sampler's notion of "agent
   * tree root" is derived from the launcher table rather than being a second
   * copy of it that drifts when a launcher is added.
   */
  runtimeComm?: string;
  /**
   * Whether this launcher's command restores a prior conversation when its
   * workspace has one (claude's `--continue`). This is what decides whether a
   * restored agent needs the interrupted-work nudge: a runtime that came back
   * remembering everything sits at an empty prompt with no turn to take,
   * while one that starts fresh got its instructions on the command line and
   * is already working. In the extraction source this was a hardcoded
   * `defaultAgent !== 'claude'` guard inside the nudge; a launcher declares
   * it here instead, so a new launcher is not silently assumed to behave
   * like Claude. Omitted means false: no restore, no nudge.
   */
  restoresConversation?: boolean;
  /**
   * Pane text that is evidence this launcher's runtime has finished starting
   * and is listening for input. Read off the pane tail by the nudge machinery
   * (see nudge.ts) before anything is typed at a restored agent — a nudge
   * sent earlier would go to the bash that is still starting the runtime.
   * Only consulted when {@link restoresConversation} is true.
   */
  readyMarkers?: string[];
}

// The only agents CrabCast will launch. `launcher` arrives as a required
// `configure` parameter; it selects from this table and is never itself
// executed as shell.
//
// The resolution rule (KAN-53), now one step shorter: the caller's `launcher`
// wins, and only a bridge-level caller with no configured agent in hand ever
// reaches DEFAULT_AGENT. The middle step — a workspace type's
// `defaultLauncher` — is gone with the types, and nothing replaces it: an
// agent's launcher is a value its caller froze onto its record, so there is no
// second place for it to come from and therefore no chance of the two
// disagreeing. An unknown name at either step refuses the activation.
// Nothing resolves to `shell` unless someone asked for `shell` by name: the
// extraction source's old rule was `name || 'shell'` plus a
// warn-and-fall-back for unknown names, and both halves were the same trap —
// an activation that omitted or misspelled the field got a bare bash prompt
// wearing an agent's name, reported `success: true, verified: true` because a
// pane by that name did exist, and executed send_to_agent messages as shell
// commands (live incident, 2026-08-02 — an agent was a shell for twenty
// minutes).
//
// `shell` stays in the table because it is a legitimate *explicit* request —
// verify scripts activate it as a fixture, and a type may declare it as its
// defaultLauncher on purpose — but it is reachable only by name, never by
// fallback from an unknown one.
export const AGENT_LAUNCHERS: Record<string, AgentLauncher> = {
  shell: {
    // A bare prompt with no runtime behind it is this launcher's delivered
    // product, so there is nothing here to *instruct* — but a prompt that was
    // configured must not simply vanish. It used to be written into the
    // agent's own working directory, where a human in the pane would at least
    // trip over it; it now lives in CrabCast's sidecar, which nobody browsing
    // that shell would ever find. Printing it once at start-up is the whole of
    // the fix: the instruction reaches the pane it was written for, and the
    // shell that follows is unchanged.
    //
    // `exec` so the shell is still PID 1 of the pane and closing it closes the
    // pane, exactly as `bash` alone did.
    command: (promptCommand) =>
      promptCommand ? `printf '%s\\n' ${shellQuote(promptCommand)}; exec bash` : 'bash'
  },
  claude: {
    // Interactive session: resume if a conversation exists, else start one
    // seeded with the bootstrap prompt. (`claude -p` would run one headless
    // turn and exit, leaving a dead pane.)
    // --permission-mode backs up the settings file on the --continue path,
    // where a resumed session could otherwise carry a stale mode forward.
    //
    // The `||` is load-bearing and was measured: `claude --continue` in a
    // directory with no history exits 1 with "No conversation found to
    // continue", so the fallback is reached exactly when there is nothing to
    // restore — which is what makes it the right place to put the degraded
    // resume prompt.
    command: (promptCommand) =>
      `claude --permission-mode bypassPermissions --continue || ` +
      `claude --permission-mode bypassPermissions${promptCommand ? ' ' + shellQuote(promptCommand) : ''}`,
    setup: (workDir) => {
      const trust = trustClaudeWorkspace(workDir);
      if (!trust.ok) {
        throw new Error(`Refusing to start claude in an untrusted workspace: ${trust.error}`);
      }
    },
    // trustClaudeWorkspace is its own verifier: present-and-true returns fast
    // with no write, a clobbered entry is rewritten, and only an entry that
    // will not stick throws. So the pre-spawn check is simply setup's trust
    // half again, run as late as the daemon can run anything (KAN-54).
    preSpawnCheck: (workDir) => {
      const trust = trustClaudeWorkspace(workDir);
      if (!trust.ok) {
        throw new Error(`Refusing to spawn claude: ${trust.error}`);
      }
    },
    runtimeComm: 'claude',
    // The `--continue` branch of the command above is what makes this true;
    // hasRestorableConversation (resume.ts) is what predicts whether it fires.
    restoresConversation: true,
    // The two things Claude Code puts on screen once its input box exists —
    // the permission-mode footer and the prompt caret. Measured off real
    // panes in the extraction source, not guessed.
    readyMarkers: ['bypass permissions', 'for shortcuts', '❯']
  },
  'anti-gravity': {
    command: (promptCommand) =>
      `agy --continue || agy${promptCommand ? ' -i ' + shellQuote(promptCommand) : ''}`,
    setup: (_workDir, mcpServers) => configureAgyMcp(mcpServers),
    runtimeComm: 'agy'
    // No restoresConversation, deliberately, despite the `--continue` above:
    // the restore *predictor* (hasRestorableConversation in resume.ts) reads
    // Claude Code's transcript directory and knows nothing about agy's, so a
    // "restored" verdict for this launcher would be an answer about the wrong
    // program. Declaring restore support here requires bringing the evidence
    // — a readyMarkers list and a transcript probe for agy — not just the flag.
  }
};

/**
 * Every agent-runtime process name the launcher table can start. The cost
 * sampler treats a process with one of these comms (and no such ancestor) as
 * the root of an agent tree; everything under it is that agent's cost.
 */
export const AGENT_RUNTIME_COMMS: ReadonlySet<string> = new Set(
  Object.values(AGENT_LAUNCHERS)
    .map((launcher) => launcher.runtimeComm)
    .filter((comm): comm is string => typeof comm === 'string')
);

/**
 * What resolveLauncher falls back to for a bridge-level caller that names no
 * launcher. Not reachable from `activate`: `configure` requires one.
 */
export const DEFAULT_AGENT = 'claude';

/** Every launcher name a caller may `configure`. */
export function knownLaunchers(): string[] {
  return Object.keys(AGENT_LAUNCHERS);
}

/**
 * Map a requested launcher name to its launcher.
 *
 * An unknown name throws, and the message names the valid launchers — the rule
 * set for pty_init's unknown sessionId (KAN-25): refuse rather than substitute
 * something plausible. initPty turns the throw into session.spawnError, the
 * channel activate already answers `success: false` from, so the refusal
 * reaches the caller without new vocabulary.
 */
export function resolveLauncher(name?: string): { name: string; launcher: AgentLauncher } {
  const requested = name?.trim() || DEFAULT_AGENT;
  const launcher = AGENT_LAUNCHERS[requested];
  if (!launcher) {
    throw new Error(
      `Unknown launcher '${requested}'. Valid launchers: ${knownLaunchers().join(', ')}. ` +
      `Pass one of these as \`launcher\` to configure.`
    );
  }
  return { name: requested, launcher };
}
