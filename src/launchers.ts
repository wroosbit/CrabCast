import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bootstrap prompt file written into every workspace. One constant, shared
 * by herdr.ts (which writes it), resume.ts (whose degraded-resume prompt tells
 * the agent to read it) and the launcher command below (which points a fresh
 * agent at it) — three call sites that must never disagree about the name.
 */
export const PROMPT_FILENAME = '.crabcast-prompt.md';

const PROMPT_CMD = `Please read and follow the instructions in ${PROMPT_FILENAME} to begin.`;

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

// Claude Code's per-project settings. `.claude/settings.local.json` sits in
// the workspace, so it is CrabCast's to create — but a resumed workspace may
// already hold keys Claude Code wrote itself (it records enabledMcpjsonServers
// there once a human approves the .mcp.json servers), so merge rather than
// replace, and bail on a file we cannot parse.
export function configureClaudeSettings(workDir: string): void {
  const settingsPath = path.join(workDir, '.claude', 'settings.local.json');
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error('[Launchers] workspace settings.local.json exists but is unparseable; refusing to overwrite it', e);
      return;
    }
  }

  // Auto-approves the workspace .mcp.json servers, so no approval prompt.
  settings.enableAllProjectMcpServers = true;
  // Full bypass, not acceptEdits: acceptEdits still routes Bash through the
  // permission classifier, which strands an unattended agent on commands a
  // human would have waved through. CrabCast workspaces are disposable and
  // agent-owned, so the agent runs without a prompt gate at all.
  settings.permissions = { ...settings.permissions, defaultMode: 'bypassPermissions' };

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[Launchers] Failed to write workspace settings.local.json', e);
  }
}

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
   * A function rather than a constant because the fallback prompt is not
   * always the same sentence: an agent being restored after a reboot whose
   * conversation could not be recovered must be told that, not greeted as if
   * it were starting fresh. `promptCommand` is what to say when there is no
   * conversation to continue; omitted, it is the ordinary cold start.
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
}

// The only agents CrabCast will launch. defaultAgent arrives from activation
// requests and MCP tool arguments; it selects from this table and is never
// itself executed as shell.
//
// The resolution rule (KAN-53, generalized for config-declared types): the
// caller's defaultAgent wins when present; an omitted one falls to the
// workspace type's `defaultLauncher` from crabcast.config.json; only when
// neither names anything is DEFAULT_AGENT consulted — which, the config
// loader requiring `defaultLauncher` on every type, means DEFAULT_AGENT is
// the fallback for bridge-level callers with no type config in hand, not for
// activations. An unknown name at any of the three steps refuses the
// activation. Nothing resolves to `shell` unless someone asked for `shell`
// by name: the extraction source's old rule was `name || 'shell'` plus a
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
    command: () => 'bash'
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
    command: (promptCommand = PROMPT_CMD) =>
      `claude --permission-mode bypassPermissions --continue || ` +
      `claude --permission-mode bypassPermissions ${shellQuote(promptCommand)}`,
    setup: (workDir) => {
      configureClaudeSettings(workDir);
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
    }
  },
  'anti-gravity': {
    command: (promptCommand = PROMPT_CMD) =>
      `agy --continue || agy -i ${shellQuote(promptCommand)}`,
    setup: (_workDir, mcpServers) => configureAgyMcp(mcpServers)
  }
};

/**
 * What resolveLauncher falls back to when neither the caller nor the type
 * config names a launcher. See the block above AGENT_LAUNCHERS.
 */
export const DEFAULT_AGENT = 'claude';

/**
 * Map a requested agent name to its launcher.
 *
 * The order is: the caller's `name`, else the workspace type's
 * `typeDefault` (its `defaultLauncher` from config), else DEFAULT_AGENT.
 * An unknown name at any step throws, and the message names the valid
 * launchers — the rule set for pty_init's unknown sessionId (KAN-25): refuse
 * rather than substitute something plausible. initPty turns the throw into
 * session.spawnError, the channel activate already answers `success: false`
 * from, so the refusal reaches the caller without new vocabulary.
 */
export function resolveLauncher(
  name?: string,
  typeDefault?: string
): { name: string; launcher: AgentLauncher } {
  const requested = name?.trim() || typeDefault?.trim() || DEFAULT_AGENT;
  const launcher = AGENT_LAUNCHERS[requested];
  if (!launcher) {
    throw new Error(
      `Unknown agent '${requested}'. Valid launchers: ${Object.keys(AGENT_LAUNCHERS).join(', ')}. ` +
      `Pass one of these as defaultAgent, or omit it to use the workspace type's defaultLauncher.`
    );
  }
  return { name: requested, launcher };
}
