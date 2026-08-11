// LINEAGE. "The extraction source" in this file is wroosbit/butchr, daemon/src,
// read at 928743a — a frozen commit, not a tree to stay in sync with. What came
// across, what has diverged since and why, and which modules nobody has examined:
// docs/ported-lineage.md. Read it before you change behaviour here.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { AGY_MCP_ARTIFACT, ProvisioningError, classifyAgyKeys } from './provisioning.js';

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
/**
 * THE ONE SERVER THAT IS THE CHANNEL, named once so that "is this spawn
 * channel-enabled" and "what does `builtinMcpServer` supply" cannot drift apart
 * (KAN-281).
 *
 * It is a constant rather than a second predicate deliberately. The consumer
 * that asked for the boolean was avoiding exactly one thing — "a second read of
 * a switch that anything may have rewritten in between" — and a *second copy of
 * the decision* is that hazard in its other form: two places that agree today
 * and are edited once. So the resolution below and the field on the wire are
 * both written in terms of this name, and there is no path by which one can say
 * channel-enabled while the other declines to supply the server.
 *
 * WHY THE CHANNEL IS AN MCP SERVER AND NOT A FLAG, since the requesting
 * consumer's own runtime reads a command line for this: CrabCast has no
 * command-line switch for it. The capability IS this server being provisioned —
 * see the note on `builtinMcpServer` below, and the paragraph above it about an
 * agent configured without it having no channel and therefore no identity. That
 * is why the field can be sourced from the decision rather than pattern-matched
 * out of an argv.
 */
export const CHANNEL_MCP_SERVER = 'crabcast';

export function builtinMcpServer(
  name: string,
  daemonConfigPath?: string,
  agentPath?: string
): Record<string, unknown> | null {
  if (name !== CHANNEL_MCP_SERVER) return null;
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
// AND THE WRITE REFUSES NOW TOO (KAN-178), which is the other half of that
// sentence and was missing while only the removal was careful. The reference
// count made `forget` able to remove a key — so a key of the USER'S that we had
// overwritten and recorded as ours became a key `forget` would delete outright.
// Clobbering their value was already wrong; clobbering it and then taking the
// entry away entirely is data loss in a file CrabCast does not own, and the
// byte comparison at the removal site does not catch it, because it protects a
// key edited AFTER we wrote it rather than one that was theirs BEFORE. The
// refusal below is what stops that sequence at its first step.
//
// (The per-directory `.mcp.json` has no such problem: one directory, one agent,
// so removal is unambiguous. See provisioning.ts.)
//
// THE PATH WAS WRONG UNTIL KAN-235, AND EVERYTHING ABOVE WAS BOOKKEEPING OVER A
// FILE NOTHING READ. This used to return `~/.gemini/antigravity-cli/mcp.json`.
// The antigravity CLI does not read that path — it reads the one below, and it
// never opens ours. So every agy agent was activated, had its servers resolved,
// merged, disclosed and recorded, and RECEIVED NONE OF THEM, behind
// `success: true`. Nothing anywhere went red, because every check in this
// repository asked whether CrabCast had written its own file correctly, and it
// always had.
//
// The reference counting and the refusals above were never wrong. They encode
// rules that are still right — a key that is already the user's is not ours to
// take over, a failed write must refuse, ownership that cannot be established
// is not an all-clear — and they now point at a file that is actually read.
// What was wrong was that their claims were larger than their effect.
//
// MEASURED, NOT READ OFF A DOCUMENT (KAN-235, agy 1.1.11, re-verified from
// scratch before this line was changed):
//
//   - A real `agy` session OPENS AND READS `~/.gemini/config/mcp_config.json`
//     three times. It performs no operation of any kind on the old path, with a
//     valid config sitting at it — the strong form of the negative, not
//     "absent, so of course unread".
//   - A stdio server defined in that file IS SPAWNED BY AGY. That is the
//     assertion that matters: not that our bytes are on disk where we put them,
//     but that agy read them and started the process they describe.
//   - `strings` on the agy binary contains ZERO occurrences of the old path.
//   - `~/.gemini/config/.migrated` exists, so agy's layout migration has already
//     run and will not run again. A file at the old path would never be adopted
//     later. There is no waiting it out.
//
// WHAT THIS FUNCTION STILL CANNOT PROMISE, because the bound that caught this
// is worth keeping rather than replacing with a new unfalsifiable sentence:
// agy's own shipped documentation is wrong about agy in at least two places
// (see docs/callers-directory.md), so the doc naming this path is not why we
// believe it. `scripts/verify-agy-reads-what-we-write.mjs` is why — it runs a
// real agy binary and asserts on what agy DOES. If that script is ever deleted
// or stubbed, this path goes back to being a claim carried from an author.
export function agyMcpConfigPath(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

/**
 * What {@link configureAgyMcp} did, rather than what it was asked to do.
 *
 * IT USED TO RETURN `void`, AND THAT WAS A DEFECT WITH A NAME. Every early
 * return — nothing asked for, an unparseable config, a failed write — was
 * indistinguishable from success to the caller, and `herdr.ts` pushed the
 * activation disclosure UNCONDITIONALLY. So an agy agent activated against an
 * unparseable global config was told, in the response, that CrabCast had merged
 * its servers into a file it had not touched.
 *
 * That was survivable while nothing could be undone. It is not survivable now:
 * provenance is what `forget` removes by, so a record written for a write that
 * never happened would point the reversal at somebody else's key.
 *
 * `keys` IS NULL FOR EXACTLY ONE CASE NOW (KAN-178): nothing was asked for. The
 * other two non-writes used to return `null` and log; they THROW, because a
 * silent non-write hands back an agent missing what it was promised behind
 * `success: true`. So `reason` describes the one benign non-write, and every
 * other outcome is either a completed write or a refusal.
 */
export interface AgyMcpResult {
  /** The global config this was about, whether or not it was written. */
  file: string;
  /**
   * Our keys mapped to the EXACT JSON written for each, or `null` when the
   * caller asked for no servers at all. The bytes, not just the names, for the
   * reason `McpConfigProvenance.keys` keeps them: removal can then tell our own
   * definition from one somebody has since edited.
   */
  keys: Record<string, string> | null;
  /** Why nothing was written. Present exactly when `keys` is `null`. */
  reason?: string;
  /**
   * CrabCast's own builtin servers that were NOT written, because this file is
   * shared and they carry per-agent identity (KAN-235).
   *
   * NOT AN ERROR AND NOT A REFUSAL. The caller's servers were delivered; this
   * names the one thing that could not be. Empty for every launcher and every
   * activation that asked for no builtin.
   */
  omittedBuiltins: string[];
}

/**
 * Merge CrabCast's MCP server definitions into the antigravity CLI's GLOBAL
 * config — under the same three refusals `provisionMcpConfig` applies to the
 * per-directory `.mcp.json` (KAN-178).
 *
 * THEY DO THE SAME JOB UNDER THE SAME PRINCIPLE AND USED TO DISAGREE ABOUT
 * WHEN TO STOP. Both merge rather than replace, and both already refused an
 * unparseable file — but where `provisionMcpConfig` THREW, this logged and
 * returned, so the agent started anyway. The three that now match, in the order
 * they are reached:
 *
 *  1. An UNPARSEABLE (or unreadable, or non-object) existing file refuses. It
 *     is never replaced: it is the user's global CLI config and replacing it
 *     would destroy whatever it holds. This one already refused to WRITE; what
 *     is new is that it refuses the ACTIVATION rather than starting an agy
 *     agent whose runtime will find none of the servers it was promised.
 *  2. A server key ALREADY THERE that no CrabCast record accounts for is the
 *     user's, and is refused rather than taken over. See {@link classifyAgyKeys}
 *     for why "no CrabCast record" has to be asked of the whole fleet here and
 *     not just of this agent's sidecar.
 *  3. A write that FAILS refuses. Same reasoning as (1) at the other end.
 *
 * WHAT DID NOT CHANGE, deliberately: an empty `defs` is not a refusal. The
 * caller asked for nothing, so there is nothing that could be missing — and
 * `defs` is the already-resolved set, so an empty one cannot mean a resolution
 * step silently dropped something (KAN-121; a name this daemon cannot supply
 * refuses the activation before reaching here).
 *
 * THE COST OF (2), STATED BECAUSE IT IS REAL: this file is shared, so a refusal
 * here can be caused by state this agent never touched. It is bounded by being
 * asked only of keys already present — a sibling's key is CrabCast's key and
 * merges as before, and only a key predating every CrabCast record refuses.
 */
/**
 * What a refusal HERE cannot claim about the rest of the activation, appended to
 * every one of them.
 *
 * FOUND BY ASKING WHAT WOULD HAVE TO BE TRUE FOR THE PROOF TO PASS WHILE THE
 * SENTENCE WAS WRONG. These refusals first read "NOTHING WAS WRITTEN and nothing
 * was started", copied from `provisionMcpConfig`, where it is exactly true — that
 * function refuses BEFORE it writes anything, and it is the first thing the
 * activation does. This one runs from the launcher's `setup`, which is LATER: by
 * the time it refuses, `provisionMcpConfig` has already written the agent's own
 * `.mcp.json` and recorded it. Measured, not assumed — the caller's directory
 * held `.mcp.json` after a refusal, with a provenance record naming it.
 *
 * So the unqualified sentence was a claim about the caller's disk that was not
 * true, in a message whose entire job is to say what state they were left in.
 * The claim is scoped to this file and the rest is stated, which is the honest
 * version of the same sentence.
 *
 * NOT A NEW RESIDUE, and not this ticket's to remove: any `setup` that refuses
 * lands here, and the claude launcher's folder-trust refusal has had this
 * property since it was written. It is recorded, so `forget` takes it back out —
 * which is what makes it residue rather than damage.
 */
const PARTIAL_PROVISIONING_NOTE =
  ` (The agent's own \`.mcp.json\` is provisioned before this point and is recorded, so ` +
  `\`crabcast forget <path>\` removes it; this refusal is about the global config only.)`;

export function configureAgyMcp(
  defs: Record<string, unknown>,
  options: {
    configPath?: string;
    /** This agent's sidecar, for reading our own record of what we wrote. */
    sidecarDir?: string;
    /** Every agent's sidecar, so a sibling's key is not mistaken for the user's. */
    agentsDir?: string;
    /**
     * CrabCast's own definitions among `defs`, which this function will NOT
     * write. See the omission argument in the doc comment above.
     */
    builtinNames?: readonly string[];
  } = {}
): AgyMcpResult {
  const agyConfigPath = options.configPath ?? agyMcpConfigPath();

  // THE OMISSION, AND IT HAPPENS BEFORE ANYTHING ELSE (KAN-235).
  //
  // `builtinMcpServer` bakes CRABCAST_AGENT_PATH into the `crabcast` definition,
  // and that is the entire supply of caller identity in this system: the daemon
  // knows which agent is calling because it wrote that agent's own path into a
  // file only it could write. That reasoning holds for a PER-AGENT file. It
  // collapses at this one, because every agy agent reads the same one.
  //
  // Write it here and the last agent to activate sets the identity for all of
  // them. `send_to_agent` from agy agent A would arrive attributed to agy agent
  // B — not a missing feature but a FABRICATED one, and never fabricate is
  // absolute. Note that this is the defect the corrected path CREATES: while we
  // were writing a file nothing read, the overwrite was inert. Correcting the
  // path without this would take a harmless bug and make it live, which is why
  // the two land together.
  //
  // NO PER-AGENT CHANNEL EXISTS TO PUT IT SOMEWHERE ELSE, and this was settled
  // by measurement rather than assumed: agy 1.1.11 has three MCP scopes and all
  // three are global. No env var carries one (the binary's string table was
  // enumerated for `AGY_*`/`ANTIGRAVITY_*`), `--project` has no MCP file, and a
  // valid workspace-scoped plugin fixture — accepted by `agy plugin validate` —
  // was never launched in a real session.
  //
  // SO THE CAPABILITY IS GENUINELY ABSENT, and that is bigger than it sounds: an
  // agy agent with no `crabcast` server cannot call `send_to_agent`, cannot call
  // `list_agents`, and cannot take part in the fleet the way a claude agent
  // does. It is not a regression — agy agents received nothing at all before —
  // but it is a real difference between launchers, and `omittedBuiltins` is how
  // the activation says so instead of leaving it to be discovered as work the
  // agent quietly cannot do.
  const builtinNames = new Set(options.builtinNames ?? []);
  const omittedBuiltins = Object.keys(defs).filter((name) => builtinNames.has(name));
  const writable: Record<string, unknown> = Object.create(null);
  for (const [name, definition] of Object.entries(defs)) {
    if (!builtinNames.has(name)) writable[name] = definition;
  }

  // Nothing to contribute: leave the user's global config alone entirely.
  //
  // REACHED BY A SECOND ROUTE NOW — an agent whose only server was the builtin.
  // The file is untouched either way, so it is the same non-write, but the
  // reason has to distinguish them: "you asked for nothing" and "the one thing
  // you asked for is the one thing this launcher cannot deliver" leave the
  // caller in very different positions.
  if (Object.keys(writable).length === 0) {
    return {
      file: agyConfigPath,
      keys: null,
      omittedBuiltins,
      reason: omittedBuiltins.length
        ? `the only MCP server(s) configured for this agent were CrabCast's own ` +
          `(${omittedBuiltins.map((k) => `'${k}'`).join(', ')}), which cannot be written to the ` +
          `antigravity CLI's shared global config`
        : 'no MCP servers were configured for this agent'
    };
  }

  const agyConfigDir = path.dirname(agyConfigPath);
  let config: any = {};
  if (fs.existsSync(agyConfigPath)) {
    let text: string;
    try {
      text = fs.readFileSync(agyConfigPath, 'utf8');
    } catch (e: any) {
      throw new ProvisioningError(
        AGY_MCP_ARTIFACT,
        `Could not read ${agyConfigPath} (${e?.message ?? String(e)}). It is your GLOBAL ` +
          `antigravity CLI config and it is merged rather than replaced, so an unreadable one ` +
          `refuses the activation instead of being overwritten. NOTHING WAS WRITTEN TO IT and nothing ` +
          `was started.` + PARTIAL_PROVISIONING_NOTE
      );
    }
    try {
      config = JSON.parse(text);
    } catch (e: any) {
      throw new ProvisioningError(
        AGY_MCP_ARTIFACT,
        `${agyConfigPath} exists but is not valid JSON (${e?.message ?? String(e)}), so ` +
          `CrabCast's MCP servers cannot be merged into it. IT WAS NOT REPLACED: it is your ` +
          `global antigravity CLI config and replacing it would destroy whatever it holds. ` +
          `Starting anyway would deliver an agy agent whose runtime finds none of the servers ` +
          `it was configured with. NOTHING WAS WRITTEN TO IT and nothing was started. Fix or move the ` +
          `file and activate again.` + PARTIAL_PROVISIONING_NOTE
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ProvisioningError(
        AGY_MCP_ARTIFACT,
        `${agyConfigPath} exists but its top level is ` +
          `${Array.isArray(config) ? 'an array' : typeof config}, not a JSON object, so there is ` +
          `no \`mcpServers\` map to merge into. It was NOT replaced and nothing was started.` +
          PARTIAL_PROVISIONING_NOTE
      );
    }
  }

  // REFUSAL 2. The property the per-directory `.mcp.json` had and this file did
  // not: a key that is already the user's is not ours to take over. Asked of
  // every CrabCast record rather than only this agent's, because the file is
  // shared — see `classifyAgyKeys`.
  // `writable`, NOT `defs` — the builtin is not being written, so it cannot
  // collide with anything and must not be able to refuse an activation over a
  // key this function has already decided to leave alone.
  const ownership = classifyAgyKeys({
    file: agyConfigPath,
    existing: config.mcpServers,
    writing: Object.keys(writable),
    definitions: writable,
    agentsDir: options.agentsDir,
    ownSidecarDir: options.sidecarDir
  });
  if (ownership.foreign.length) {
    throw new ProvisioningError(
      AGY_MCP_ARTIFACT,
      `${agyConfigPath} already defines the MCP server(s) ` +
        `${ownership.foreign.map((k) => `'${k}'`).join(', ')}, and CrabCast has no record of ` +
        `writing them — so they are yours, and they are not ours to take over. This is your ` +
        `GLOBAL antigravity CLI config: overwriting an entry here would redirect a server your ` +
        `own tooling depends on, and a later \`crabcast forget\` would then remove it outright. ` +
        `NOTHING WAS WRITTEN TO IT and nothing was started. Rename or remove those entries in ` +
        `${agyConfigPath}, or configure this agent without the colliding server.` +
        PARTIAL_PROVISIONING_NOTE
    );
  }
  if (ownership.indeterminate.length) {
    throw new ProvisioningError(
      AGY_MCP_ARTIFACT,
      `${agyConfigPath} already defines the MCP server(s) ` +
        `${ownership.indeterminate.map((k) => `'${k}'`).join(', ')}, and CrabCast could not ` +
        `establish whether it wrote them: ${ownership.doubt}. An entry that cannot be shown to ` +
        `be ours is treated as yours — overwriting it would redirect a server that may be your ` +
        `own, and this file is shared, so the mistake would not be confined to this agent. ` +
        `NOTHING WAS WRITTEN TO IT and nothing was started. Fix the unreadable record(s) named ` +
        `above, or configure this agent without the colliding server.` + PARTIAL_PROVISIONING_NOTE
    );
  }

  // REFUSAL 4, AND IT IS THE ONE THE CORRECTED PATH CREATES (KAN-235).
  //
  // Ownership says these keys are CrabCast's — a sibling recorded writing them,
  // so they are not the user's and refusal 2 correctly lets them through. But
  // the sibling recorded DIFFERENT BYTES, and one file holds one value per key.
  // Merging ours does not share the key with that agent, it TAKES the key from
  // it: the sibling's server silently becomes ours, pointed at our command,
  // while the sibling goes on believing it has what it was promised.
  //
  // THIS WAS INERT UNTIL TODAY AND IS NOT ANY MORE, which is why it could not be
  // a later slice. While CrabCast wrote a file nothing read, every collision in
  // it was harmless — B overwriting A's key took nothing from A, because A had
  // never received it either. Correcting the path is exactly what converts this
  // class from harmless to harmful, so the correction and this refusal are one
  // change or the correction makes things worse.
  //
  // A SIBLING WITH THE SAME DEFINITION IS NOT A CONFLICT and still merges. That
  // is the ordinary shared-server case the reference count exists to support,
  // and refusing it would make the second agy agent on a machine unstartable.
  if (ownership.conflicting.length) {
    const detail = ownership.conflicting
      .map(
        (c) =>
          `'${c.key}' (claimed by ${c.sibling}, which recorded ${c.theirs}; this agent would ` +
          `write ${c.ours})`
      )
      .join('; ');
    throw new ProvisioningError(
      AGY_MCP_ARTIFACT,
      `${agyConfigPath} is SHARED by every agy agent this daemon runs, and it holds only one ` +
        `definition per server name. Another agent already claims ${detail}. Writing ours would ` +
        `not share that server, it would REDIRECT the sibling's — that agent would keep running, ` +
        `believing it has the server it was configured with, while its tool calls went somewhere ` +
        `else. NOTHING WAS WRITTEN TO IT and nothing was started. Give this agent's server a ` +
        `different name, configure it with the same definition the sibling uses, or ` +
        `\`crabcast forget\` the sibling first.` + PARTIAL_PROVISIONING_NOTE
    );
  }

  // NULL-PROTOTYPE TARGET, not a spread. `{ ...a, ...b }` builds an ordinary
  // literal, and assigning a server named `__proto__` into one stores nothing
  // at all — our key would silently fail to be written while `keys` below still
  // reported it as written, which is a provenance record for a key that is not
  // in the file. Same reasoning, and the same fix, as `provisionMcpConfig`.
  const servers: Record<string, unknown> = Object.assign(
    Object.create(null),
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {}
  );
  for (const [name, definition] of Object.entries(writable)) servers[name] = definition;
  config.mcpServers = servers;

  // THE REFUSAL BELOW USED TO SAY "and nowhere else", AND IT WAS FALSE. The CLI
  // read a DIFFERENT file, not no other file, and that sentence is what made the
  // defect invisible for three merged slices — it asserted the stakes of a write
  // that had no stakes. What it says now is the narrower claim the measurement
  // supports: this is a path agy has been observed to read and spawn from.
  //
  // (The comment sits ABOVE the `try` rather than inside the `catch`, because
  // `verify-agy-mcp-write-refusals`'s `swallow-the-failed-write` mutation
  // anchors on the compiled `catch (e) {\n        throw new ProvisioningError`.
  // A comment emitted between those two lines silently stops the mutation
  // applying, and a mutation that does not apply is a section that never runs.)
  try {
    fs.mkdirSync(agyConfigDir, { recursive: true });
    fs.writeFileSync(agyConfigPath, JSON.stringify(config, null, 2));
  } catch (e: any) {
    throw new ProvisioningError(
      AGY_MCP_ARTIFACT,
      `Could not write ${agyConfigPath} (${e?.message ?? String(e)}). The agent was configured ` +
        `with MCP servers and this is the file the antigravity CLI reads them from, so ` +
        `starting now would deliver an agent quietly missing what it was promised. NOTHING WAS ` +
        `STARTED.` + PARTIAL_PROVISIONING_NOTE
    );
  }

  // `writable` again, and this is the load-bearing one for `forget`. Provenance
  // is what the reversal removes BY, so recording the builtin here would point a
  // later `crabcast forget` at a key this function never wrote — and, with the
  // path corrected, at whatever the user's own `crabcast` entry happens to be.
  const keys: Record<string, string> = {};
  for (const [name, definition] of Object.entries(writable)) keys[name] = JSON.stringify(definition);
  return { file: agyConfigPath, keys, omittedBuiltins };
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
// watching agents past their startup dialogs was explicitly deferred (KAN-49,
// in the extraction source).
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
   * Which of {@link mcpServers} are CrabCast's OWN definitions rather than the
   * caller's — the names the caller asked for as `'builtin'` and the daemon
   * filled in itself.
   *
   * ADDED BY KAN-235, AND ONLY THE AGY LAUNCHER NEEDS IT. The distinction did
   * not matter while every launcher wrote a per-agent file: a definition is a
   * definition, and `builtinMcpServer` had already baked this agent's identity
   * into it. It matters at a SHARED file, because CrabCast's builtin is the one
   * definition that carries WHO THE AGENT IS. Writing it into a file every agy
   * agent reads would give every one of them the identity of whichever agent
   * activated last.
   *
   * So the launcher has to be able to tell the two apart, and `mcpServers`
   * alone cannot: by the time it arrives the builtin has been resolved into an
   * ordinary-looking `{command, args, env}` and is indistinguishable from a
   * caller-supplied server that happens to look similar. Matching on the name
   * `crabcast` would be a guess about a name the caller chooses. This is the
   * daemon stating what it knows rather than the launcher inferring it.
   */
  builtinMcpNames?: readonly string[];
  /**
   * This agent's sidecar, where CrabCast's record of what it has written for
   * this agent lives.
   *
   * ADDED FOR THE AGY WRITE REFUSAL (KAN-178), and optional for the reason the
   * removal side's `agentsDir` is: a caller that cannot say where the records
   * are has not established that a colliding key is ours, and the refusal reads
   * that as a reason to stop rather than as an all-clear. Passing it is
   * therefore what makes the ordinary re-activation work, not an optimisation.
   */
  sidecarDir?: string;
  /**
   * Where EVERY agent's sidecar lives, so a key written by a SIBLING is
   * recognised as CrabCast's rather than mistaken for the user's.
   *
   * The agy config is shared; without this, the second agy agent to activate
   * would be refused over the first agent's key. See `classifyAgyKeys`.
   */
  agentsDir?: string;
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
      | {
          kind: 'agy-mcp';
          file: string;
          keys: Record<string, string> | null;
          reason?: string;
          /**
           * CrabCast's own servers that this launcher DELIBERATELY did not
           * write, and cannot write, because the file is shared and they carry
           * per-agent identity (KAN-235).
           *
           * Separate from `keys: null`, which means nothing was written at all.
           * This is a write that happened and was INCOMPLETE BY DESIGN, and the
           * caller has to be told which capability the agent therefore does not
           * have. A capability removed silently is worse than one refused
           * loudly; this is the channel that keeps it from being silent.
           */
          omittedBuiltins?: readonly string[];
        }
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
   * time in which another process can undo what setup wrote (KAN-54, in the
   * extraction source). Throws to refuse the activation through the same
   * spawnError channel.
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
// The resolution rule (KAN-53, in the extraction source), now one step
// shorter: the caller's `launcher` wins, and only a bridge-level caller with
// no configured agent in hand ever reaches DEFAULT_AGENT. The middle step — a
// workspace type's `defaultLauncher` — is gone with the types, and nothing
// replaces it: an agent's launcher is a value its caller froze onto its
// record, so there is no second place for it to come from and therefore no
// chance of the two disagreeing. An unknown name at either step refuses the
// activation. Nothing resolves to `shell` unless someone asked for `shell` by
// name: the extraction source's old rule was `name || 'shell'` plus a
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
    // half again, run as late as the daemon can run anything (KAN-54, in the
    // extraction source).
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
    // A REFUSAL NOW WHEN THE WRITE DOES NOT LAND, AND WHEN THE KEY IS THE
    // USER'S (KAN-178). KAN-140 left both alone on purpose — it was about the
    // reversal, and both of these change who GETS an agent rather than who gets
    // it back — and taking that decision here is this ticket's whole subject.
    // `configureAgyMcp` throws; `setup` throwing is the launcher contract's
    // refusal channel, the same one the claude launcher uses for folder trust,
    // and `initPty` renders it as spawnError + terminated.
    //
    // The two directories are what make the foreign-key half answerable: the
    // file is shared, so "CrabCast has no record of this key" is a question
    // about every agent's record, not just this one's.
    //
    // AND CRABCAST'S OWN BUILTIN IS NOT WRITTEN AT ALL (KAN-235). The file is
    // shared by every agy agent, so a definition carrying one agent's identity
    // would hand that identity to all of them. `builtinMcpNames` is how the
    // daemon says which definitions are its own; the omission is reported
    // through the same `note` channel as the write, because an agent that
    // cannot call `send_to_agent` needs to be told so at activation rather than
    // discover it as work it silently cannot do.
    setup: ({ mcpServers, builtinMcpNames, note, sidecarDir, agentsDir }) => {
      const outcome = configureAgyMcp(mcpServers, {
        sidecarDir,
        agentsDir,
        builtinNames: builtinMcpNames
      });
      note?.({
        kind: 'agy-mcp',
        file: outcome.file,
        keys: outcome.keys,
        reason: outcome.reason,
        omittedBuiltins: outcome.omittedBuiltins
      });
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
 * runtime" — a name registration over a dead pane must not verify (KAN-58, in
 * the extraction source) — and for `shell` the name is all there is to see.
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
 * set for pty_init's unknown sessionId (KAN-25, in the extraction source):
 * refuse rather than substitute something plausible. initPty turns the throw
 * into session.spawnError, the channel activate already answers `success:
 * false` from, so the refusal reaches the caller without new vocabulary.
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
