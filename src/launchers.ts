// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

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

/**
 * Every MCP server CrabCast can construct itself. A CLOSED SET OF EXACTLY ONE,
 * and it earns its place rather than heading a list somebody is expected to
 * extend.
 *
 * A caller supplies their own servers as definitions — the command, args and
 * env that spawn them — because the set they want depends on which of their
 * integrations hold a live credential, which is runtime state on their side of
 * the boundary. CrabCast resolves none of it and holds no table of names.
 *
 * This one is different in kind, not in degree: its definition depends on facts
 * only THIS DAEMON has, so a caller could not write it correctly if they tried.
 */
export const BUILTIN_MCP_SERVERS = ['crabcast'] as const;

/**
 * The definition for a server CrabCast builds itself, or `null` for a name it
 * does not know.
 *
 * `null` rather than an empty map, and the difference is the whole of KAN-121:
 * an empty result used to mean both "nothing was asked for" and "everything
 * asked for was silently dropped", and the caller could not tell which. One
 * name in, one answer out — so a name this daemon cannot supply is a fact the
 * caller is told rather than a gap in a map nobody counted.
 *
 * Absolute commands: the agent spawns these with the *pane's* PATH, which can
 * be thinner than ours (a login-started herdr server has no nvm) and resolve
 * `node` to an ancient system install. The daemon rewrites its own keys on
 * every activation, so the baked paths never go stale.
 *
 * `crabcast` is the daemon's own MCP server — how agents inspect and steer each
 * other over the same unix socket. mcp.js finds that socket through the config
 * (the socket lives under the config's dataDir), and the pane environment does
 * not carry it, so the definition bakes this daemon's own config path in as
 * CRABCAST_CONFIG — the same variable mcp.js's config resolution already reads.
 * Without it, a server spawned inside a workspace would fall back to the default
 * data dir and could address a different daemon than the one that provisioned
 * it. That is why this is the one definition CrabCast owns: the caller has no
 * way to know which daemon they are being provisioned by.
 *
 * IT ALSO BAKES IN WHO THE AGENT IS, as CRABCAST_AGENT_PATH, and that is what
 * makes a supervisor of record possible at all.
 *
 * The reasoning is the same one sentence further on. This definition is written
 * per-agent, by the daemon, into that one agent's `.mcp.json` — it is the only
 * artifact in this system that is BOTH specific to one agent and outside that
 * agent's power to write. So an identity placed here is one the daemon issued,
 * not one a caller asserted, and every request from the server it spawns can
 * carry it (`mcp.ts`). The daemon then knows which agent is calling, which is
 * the whole input to `activatedBy`.
 *
 * THE ALTERNATIVES, AND WHY NOT THEM. The pane's environment would identify a
 * CLI run inside an agent too, and was rejected: it is inherited by every
 * process the agent ever spawns, including ones that are not it, so it would
 * turn a fact this daemon issued into ambient authority lying around in a shell.
 * A caller-supplied field on `configure`/`activate` was rejected outright —
 * parentage a caller can name is parentage a caller can invent, and the field's
 * entire value to a consumer is that nobody chose it.
 *
 * WHAT THAT LEAVES UNIDENTIFIED, said plainly because it is a real hole and not
 * a small one: an agent configured WITHOUT the `crabcast` builtin has no channel
 * and therefore no identity — but it also has no way to reach this daemon, so it
 * cannot activate anything and has nothing to be the parent of. And the CLI is
 * never identified, deliberately: a human at a shell has no supervisor of
 * record, and that is the case `activatedBy: null` exists to state.
 *
 * The paths are absolute and rewritten on every activation, like the two above,
 * so a directory that moves does not leave an agent claiming its old identity.
 */
export function builtinMcpServer(
  name: string,
  daemonConfigPath?: string,
  agentPath?: string
): Record<string, unknown> | null {
  if (name !== 'crabcast') return null;
  const env: Record<string, string> = {
    ...(daemonConfigPath ? { CRABCAST_CONFIG: daemonConfigPath } : {}),
    ...(agentPath ? { CRABCAST_AGENT_PATH: agentPath } : {})
  };
  return {
    command: process.execPath,
    args: [path.join(__dirname, 'mcp.js')],
    ...(Object.keys(env).length ? { env } : {})
  };
}

// WHAT USED TO BE HERE: `writeWorkspaceMcpConfig`.
//
// It wrote `.mcp.json` into the agent's working directory, merging our servers
// in — and, when the existing file could not be parsed, REPLACING it, on the
// stated grounds that "CrabCast owns this file". That was true of a workspace
// CrabCast allocated. The directory is the caller's now, the file is theirs,
// and both halves of the old behaviour were wrong under that: it wrote without
// being asked, and it destroyed a file it could not read.
//
// It moved to `provisioning.ts`, which is where writing outside CrabCast's own
// data directory now lives, and gained the four properties that make an
// exception to "the consumer's directory is theirs" acceptable: it is opted
// into, merged rather than replaced, named in the activation response, and
// reversible by `forget`. The definitions themselves stay here, next to the
// launchers that need them — see `mcpServerDefinitions` above.

// The antigravity CLI has no project-scoped equivalent, so its global config
// is merged into — and never written when the existing file cannot be parsed,
// which would otherwise replace the user's config with just our entries.
//
// GLOBAL, and therefore SHARED between every agent this daemon runs under this
// launcher. Two agents both have it written on their behalf, so removing the
// key when the first is forgotten would take the second's servers away. That
// used to be the end of the argument: `forget` left the key, and the disclosure
// said so.
//
// IT IS REFERENCE-COUNTED NOW (KAN-140). `forget` removes CrabCast's key only
// when no OTHER agent's provenance record still claims it, and says which
// records it read to decide — see `removeOurAgyKeys` in provisioning.ts. What
// made that possible is the record this function now RETURNS: the exact keys
// and the exact bytes written, which the caller stores as provenance. A key
// nobody recorded writing is a key nothing may remove.
//
// (The per-directory `.mcp.json` has no such problem: one directory, one agent,
// so removal is unambiguous. See provisioning.ts.)
export function agyMcpConfigPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp.json');
}

/**
 * What {@link configureAgyMcp} did, rather than what it was asked to do.
 *
 * IT USED TO RETURN `void`, AND THAT WAS A DEFECT WITH A NAME. Every early
 * return above — nothing asked for, an unparseable config, a failed write — was
 * indistinguishable from success to the caller, and `herdr.ts` pushed the
 * activation disclosure UNCONDITIONALLY. So an agy agent activated against an
 * unparseable global config was told, in the response, that CrabCast had merged
 * its servers into a file it had not touched.
 *
 * That was survivable while nothing could be undone. It is not survivable now:
 * provenance is what `forget` removes by, so a record written for a write that
 * never happened would point the reversal at somebody else's key.
 *
 * `keys` is `null` for every non-write, with `reason` saying which one.
 */
export interface AgyMcpResult {
  /** The global config this was about, whether or not it was written. */
  file: string;
  /**
   * Our keys mapped to the EXACT JSON written for each, or `null` when nothing
   * was written. The bytes, not just the names, for the reason
   * `McpConfigProvenance.keys` keeps them: removal can then tell our own
   * definition from one somebody has since edited.
   */
  keys: Record<string, string> | null;
  /** Why nothing was written. Present exactly when `keys` is `null`. */
  reason?: string;
}

export function configureAgyMcp(
  defs: Record<string, unknown>,
  configPath?: string
): AgyMcpResult {
  const agyConfigPath = configPath ?? agyMcpConfigPath();

  // Nothing to contribute: leave the user's global config alone entirely.
  // Safe here in a way it was NOT safe at the workspace `.mcp.json` (KAN-121):
  // `defs` is the ALREADY-RESOLVED set, so an empty one means the caller asked
  // for nothing rather than that a resolution step dropped what they asked for.
  // The dropping cannot happen any more — a name this daemon cannot supply
  // refuses the activation before reaching here.
  if (Object.keys(defs).length === 0) {
    return { file: agyConfigPath, keys: null, reason: 'no MCP servers were configured for this agent' };
  }

  const agyConfigDir = path.dirname(agyConfigPath);
  let config: any = {};
  if (fs.existsSync(agyConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(agyConfigPath, 'utf8'));
    } catch (e: any) {
      const reason =
        `${agyConfigPath} exists but is not valid JSON (${e?.message ?? String(e)}), so ` +
        `CrabCast's MCP servers were NOT merged into it. It was not replaced: it is your ` +
        `global antigravity CLI config and replacing it would destroy whatever it holds.`;
      console.error(`[Launchers] ${reason}`);
      return { file: agyConfigPath, keys: null, reason };
    }
  }

  // WE MAY BE OVERWRITING A KEY OF THE USER'S, and this is the one property the
  // per-directory `.mcp.json` has that this file does not: `provisionMcpConfig`
  // refuses a server key it has no record of writing, because that key is the
  // caller's. Nothing refuses here, and it is a pre-existing behaviour rather
  // than one KAN-140 introduced — but reversal makes it sharper, so the removal
  // side compensates by leaving any key whose bytes are not the bytes we
  // recorded. See `removeOurAgyKeys`. The refusal itself is KAN-178, filed
  // rather than smuggled into this ticket: it changes who gets an agent.
  config.mcpServers = { ...config.mcpServers, ...defs };

  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e: any) {
    const reason = `could not write ${agyConfigPath} (${e?.message ?? String(e)})`;
    console.error(`[Launchers] Failed to write agy mcp.json: ${reason}`);
    return { file: agyConfigPath, keys: null, reason };
  }

  const keys: Record<string, string> = {};
  for (const [name, definition] of Object.entries(defs)) keys[name] = JSON.stringify(definition);
  return { file: agyConfigPath, keys };
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
/**
 * The user's global Claude Code configuration — the ONLY file folder trust can
 * be recorded in.
 *
 * Exported so the activation response can name it without a second copy of the
 * path, and so `forget` removes the entry from the same file the write went to.
 */
export function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** Claude Code keys projects by the normalized absolute path, nothing more. */
export function trustKeyFor(workDir: string): string {
  return path.normalize(path.resolve(workDir));
}

export function trustClaudeWorkspace(workDir: string, configPath?: string): TrustResult {
  const claudeConfigFile = configPath ?? claudeConfigPath();
  const trustKey = trustKeyFor(workDir);

  const read = (): { config: any } | { unreadable: string } => {
    if (!fs.existsSync(claudeConfigFile)) return { config: {} };
    try {
      return { config: JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8')) };
    } catch (e: any) {
      return {
        unreadable:
          `${claudeConfigFile} exists but is unparseable; refusing to overwrite it ` +
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
    const tmpPath = `${claudeConfigFile}.crabcast-${process.pid}-${attempt}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, claudeConfigFile);
    } catch (e: any) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const error =
        `Failed to record workspace trust in ${claudeConfigFile}: ${e?.message ?? String(e)}`;
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
      `${attempt}/${TRUST_WRITE_ATTEMPTS} — a concurrent writer rewrote ${claudeConfigFile}`
    );
  }

  const error =
    `Trust entry for ${trustKey} in ${claudeConfigFile} would not stick after ` +
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

/**
 * What a launcher needs to know to build its command line.
 *
 * AN OBJECT RATHER THAN POSITIONAL ARGUMENTS, and `mayResume` is why: it
 * decides whether `--continue` appears at all, and a boolean that can be
 * omitted is a boolean that will be omitted. Every launcher below reads it, and
 * a launcher added later cannot get a resume by forgetting to ask about one.
 */
export interface LauncherCommandContext {
  /**
   * What to say to an agent that is starting fresh, or `undefined` when the
   * agent was configured without a prompt.
   *
   * `undefined` is a real case rather than a default: `prompt` is an optional
   * `configure` parameter, and an agent configured without one is started with
   * no opening instruction at all. Substituting a generic one would be this
   * daemon inventing an instruction nobody wrote.
   */
  promptCommand?: string;
  /**
   * WHETHER THIS LAUNCHER MAY RESUME A CONVERSATION AT THIS PATH. The resume
   * rule (see resume.ts) in the one place it has to be obeyed.
   *
   * `false` means the command must start a NEW session — no `--continue`, no
   * `--resume`, nothing that reads a transcript keyed by the directory. The
   * transcripts at a caller-owned path may be a HUMAN'S, and resuming one into
   * an agent pane hands their session to an agent that then acts on it.
   */
  mayResume: boolean;
}

/**
 * What a launcher's `setup` may report having written outside CrabCast's own
 * data directory, so the activation response can name it.
 *
 * The trust entry is the reason this exists: it is written by the claude
 * launcher, into the user's GLOBAL config, and neither the router nor the
 * bridge would otherwise know it happened.
 */
export interface LauncherSetupContext {
  workDir: string;
  /**
   * The RESOLVED server definitions — caller-supplied ones verbatim, plus any
   * builtin CrabCast filled in. Resolved before this is called, so a launcher
   * never sees a name it would have to look up, and an empty map means the
   * caller asked for nothing rather than that something was dropped.
   */
  mcpServers: Record<string, unknown>;
  /**
   * Called once per artifact this setup wrote or relied on.
   *
   * A DISCRIMINATED UNION RATHER THAN ONE SHAPE, because the two artifacts that
   * reach it are answered by different questions. For folder trust the question
   * is WHOSE IT IS — `wroteIt` is the difference between an entry CrabCast put
   * there and one that was already true, and that is what decides whether
   * `forget` may take it away again. For the agy config the question is WHETHER
   * IT HAPPENED AT ALL: `keys: null` means the write did not go through, and the
   * caller must then disclose nothing rather than disclose a write it did not
   * make.
   *
   * Both are called EVEN WHEN THERE IS NOTHING TO REMOVE. A `note` that fired
   * only on success would leave the caller unable to tell "no artifact" from
   * "the launcher never said", which is the ambiguity KAN-121 spent a slice
   * removing one file over.
   */
  note?: (
    artifact:
      | { kind: 'folder-trust'; file: string; trustKey: string; wroteIt: boolean }
      | { kind: 'agy-mcp'; file: string; keys: Record<string, string> | null; reason?: string }
  ) => void;
}

export interface AgentLauncher {
  /**
   * Shell command run inside the herdr pane (via bash -c).
   *
   * A function rather than a constant because neither half of it is fixed: an
   * agent being restored after a reboot whose conversation could not be
   * recovered must be told that rather than greeted as if it were starting
   * fresh, and an agent in a directory CrabCast has never run in before must
   * not be handed whatever conversation happens to be on disk there.
   */
  command: (context: LauncherCommandContext) => string;
  /**
   * Optional pre-launch setup, e.g. CLI-specific MCP config. Throwing refuses
   * the activation: initPty answers with session.spawnError + terminated, the
   * same channel as an unknown launcher, so setup that did not stick is never
   * papered over with `success: true`.
   */
  setup?: (context: LauncherSetupContext) => void;
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
    //
    // `mayResume` is not read here and nothing is missing: a bare shell has no
    // conversation to restore, so there is no resume to suppress.
    command: ({ promptCommand }) =>
      promptCommand ? `printf '%s\\n' ${shellQuote(promptCommand)}; exec bash` : 'bash'
  },
  claude: {
    // Interactive session: resume if a conversation exists AND resuming is
    // permitted, else start one seeded with the bootstrap prompt. (`claude -p`
    // would run one headless turn and exit, leaving a dead pane.)
    // --permission-mode backs up the settings file on the --continue path,
    // where a resumed session could otherwise carry a stale mode forward.
    //
    // The `||` is load-bearing and was measured: `claude --continue` in a
    // directory with no history exits 1 with "No conversation found to
    // continue", so the fallback is reached exactly when there is nothing to
    // restore — which is what makes it the right place to put the degraded
    // resume prompt.
    //
    // `mayResume: false` DROPS THE `--continue` BRANCH ENTIRELY, and that is
    // the resume rule's teeth. A predictor answering `false` would only have
    // changed which prompt was passed to the fallback — the `--continue` in
    // front of it would still have run and still have restored whatever
    // transcript the directory had. At a caller-owned path that transcript is
    // very often a HUMAN'S: Claude Code keys history on the working directory,
    // so anyone who has ever run it in their own repository has one waiting
    // there. Suppressing the flag is the only place this can be stopped, and it
    // is stopped here rather than upstream so a launcher cannot resume by
    // accident.
    command: ({ promptCommand, mayResume }) => {
      const fresh =
        `claude --permission-mode bypassPermissions` +
        (promptCommand ? ' ' + shellQuote(promptCommand) : '');
      return mayResume
        ? `claude --permission-mode bypassPermissions --continue || ${fresh}`
        : fresh;
    },
    setup: ({ workDir, note }) => {
      const trust = trustClaudeWorkspace(workDir);
      if (!trust.ok) {
        throw new Error(`Refusing to start claude in an untrusted workspace: ${trust.error}`);
      }
      // `attempts: 0` means the entry was already true on the first read, so
      // CrabCast did not put it there. Anything above zero means we wrote one.
      // That distinction is what `forget` needs: an entry a human accepted
      // themselves is theirs, and is never removed on our way out.
      note?.({
        kind: 'folder-trust',
        file: claudeConfigPath(),
        trustKey: trustKeyFor(workDir),
        wroteIt: trust.attempts > 0
      });
    },
    // trustClaudeWorkspace is its own verifier: present-and-true returns fast
    // with no write, a clobbered entry is rewritten, and only an entry that
    // will not stick throws. So the pre-spawn check is simply setup's trust
    // half again, run as late as the daemon can run anything (KAN-54).
    preSpawnCheck: (workDir: string) => {
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
    // Same resume rule as claude, and for the same reason rather than for
    // symmetry: `agy --continue` restores whatever session agy keeps for this
    // directory, and at a caller-owned path that session may be the human's.
    // The rule is about whose conversation lives at a path, which is a fact
    // about the directory rather than about any particular runtime — so it
    // binds every launcher that can continue anything.
    command: ({ promptCommand, mayResume }) => {
      const fresh = `agy${promptCommand ? ' -i ' + shellQuote(promptCommand) : ''}`;
      return mayResume ? `agy --continue || ${fresh}` : fresh;
    },
    // REPORTED THROUGH `note` NOW, like the claude launcher's trust entry, and
    // for the same reason: the bridge cannot see what this wrote, so anything
    // it says about the global agy config without being told is a guess. It
    // used to guess — `herdr.ts` pushed the disclosure whenever an agy agent
    // had definitions, whether or not `configureAgyMcp` had written anything —
    // and the guess was wrong for every non-write. `keys: null` now carries the
    // reason instead, and nothing is disclosed or recorded.
    //
    // Still not a refusal when the write fails, deliberately and narrowly: this
    // slice is about the reversal, and turning a logged failure into a refused
    // activation changes who gets an agent, which is a different decision from
    // who gets it back. KAN-178, filed rather than taken.
    setup: ({ mcpServers, note }) => {
      const outcome = configureAgyMcp(mcpServers);
      note?.({ kind: 'agy-mcp', file: outcome.file, keys: outcome.keys, reason: outcome.reason });
    },
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
 * Whether a launcher delivers a live agent RUNTIME behind its pane.
 *
 * False only for `shell`, where a bare prompt with nothing running in it is
 * the delivered product. Everywhere this daemon asks "does an agent exist
 * here?", the answer for every other launcher is "only if herdr reports a
 * runtime" — a name registration over a dead pane must not verify (KAN-58) —
 * and for `shell` the name is all there is to see.
 *
 * One function rather than a `!== 'shell'` at each site: `initPty` decides it
 * for a session, `confirmAgentPresent` is passed it, `ourPaneIn` needs it to
 * recognise a shell agent as ours, and the census's stale-session release
 * reads it back. Four places that must agree, and did not: `ourPaneIn`
 * originally required a runtime unconditionally, which made a `shell` agent
 * permanently unrecognisable as its own — the same class of always-false
 * ownership answer as the pane-id one, and found by running the live proof
 * rather than by reading.
 */
export function launcherDeliversRuntime(launcherName?: string): boolean {
  try {
    return resolveLauncher(launcherName).name !== 'shell';
  } catch {
    // An unresolvable launcher never starts anything, so nothing can be ours
    // under it. The strict reading is the safe one.
    return true;
  }
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
