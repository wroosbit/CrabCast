import * as fs from 'fs';
import * as path from 'path';

/**
 * Everything CrabCast writes OUTSIDE its own data directory, and how each of
 * those writes is taken back.
 *
 * THE GOVERNING PRINCIPLE, which is the whole of this file's reason to exist:
 *
 *   The consumer's directory is theirs; CrabCast's state lives in CrabCast's
 *   directory; the only exceptions are artifacts another program will read
 *   from nowhere else — and each exception is opted into, merged rather than
 *   replaced, named in the activation response, and reversible.
 *
 * Under path identity every agent runs in a directory somebody else owns, so
 * the four things activation used to write there stopped being housekeeping in
 * a disposable workspace and became edits to somebody's repository. Two of them
 * were not file drops at all but PRIVILEGE CHANGES: `bypassPermissions` merged
 * into the consumer's own `.claude/settings.local.json`, and a trust entry in
 * their GLOBAL `~/.claude.json`, which is not even scoped to the directory.
 *
 * Two of the four were pure removals and are already gone: the bootstrap prompt
 * moved to the sidecar (`identity.ts`), and `.claude/settings.local.json` is
 * never written at all (`launchers.ts` keeps the note explaining why). What is
 * left is the two that CANNOT be expressed as simply not doing it, because
 * another program reads them from nowhere else:
 *
 *   `.mcp.json`      Claude Code reads MCP config from the project root and
 *                    from nowhere else. There is no sidecar it would look in.
 *   `~/.claude.json` Folder trust has no project-scoped setting; the global
 *                    `projects[<dir>].hasTrustDialogAccepted` key is the sole
 *                    alternative to a human accepting a dialog nobody is there
 *                    to accept.
 *
 * AND A THIRD, which is the awkward one and the reason this file grew a census
 * (KAN-140):
 *
 *   `~/.gemini/config/mcp_config.json`
 *                    The antigravity CLI reads MCP config from its GLOBAL
 *                    config and has no project-scoped equivalent at all — so
 *                    unlike the two above, this artifact is not merely outside
 *                    the agent's directory, it is SHARED BY EVERY AGY AGENT
 *                    THIS DAEMON RUNS. One file, many owners.
 *
 *                    THIS PATH WAS WRONG UNTIL KAN-235 — it read
 *                    `~/.gemini/antigravity-cli/mcp.json`, which agy has been
 *                    measured never to open. The census below is older than the
 *                    correction, so for three merged slices it was careful
 *                    bookkeeping over a file nothing read. It was not wrong,
 *                    only inert; it is load-bearing now. See `agyMcpConfigPath`
 *                    in launchers.ts for the measurement.
 *
 * That last property is what made "reversible" hard rather than tedious.
 * Removing our key when one agent is forgotten would take the servers away from
 * every sibling still using it, so the reversal is REFERENCE-COUNTED: it reads
 * every agent's provenance record and removes the key only when nothing else
 * claims it. The count introduces a claim of its own — "no other agent needs
 * this" — so every case where that claim cannot be established leaves the key
 * and says what it could not establish. See {@link countAgyClaims} and
 * `removeOurAgyKeys`.
 *
 * So they are written — and the four properties above are what makes that
 * acceptable rather than merely convenient. This file implements all four.
 *
 * PROVENANCE, NOT GUESSWORK. `forget` removes exactly what CrabCast wrote,
 * which means CrabCast has to have written down what it wrote. That record is
 * {@link Provenance}, and it lives in the agent's SIDECAR — inside our own data
 * directory, because a provenance file dropped in the caller's directory would
 * itself be an unrecorded artifact, and the first thing it could not account
 * for is itself.
 *
 * NOTE WHAT THIS FILE NEVER DOES: it never deletes a directory. `configure` may
 * not `mkdir` (see identity.ts), so the set of directories CrabCast created is
 * empty by construction — never-delete-what-we-did-not-create is structural
 * here rather than a rule anyone has to remember. Nor does it ever remove
 * anything recursively: every removal below names one file, or one key inside
 * one file, and anything it did not expect to find is REPORTED rather than
 * swept away.
 */

/** The provenance file's own format version, for the same reason the log has one. */
export const PROVENANCE_VERSION = 1;

/** Where the provenance record lives inside an agent's sidecar. */
export const PROVENANCE_FILENAME = 'provisioned.json';

/** The one filename Claude Code reads project-scoped MCP configuration from. */
export const MCP_CONFIG_FILENAME = '.mcp.json';

/** Where the antigravity CLI reads MCP configuration, and it is GLOBAL. */
export const AGY_MCP_ARTIFACT = 'agy-mcp-config';

/**
 * Which artifact a disclosure or a removal is about. A closed set on purpose:
 * a fifth artifact is a decision somebody has to make in this file, not a
 * string a caller can invent.
 *
 * THE FIFTH ONE IS HERE, and it is that decision rather than a name somebody
 * slipped in (KAN-140). `agy-mcp-config` is the antigravity CLI's GLOBAL MCP
 * config, which used to be disclosed under `mcp-config` — the same kind as the
 * per-directory `.mcp.json`, from which it differs in the one way that decides
 * what `forget` may do: it is SHARED between every agy agent, so removing our
 * key from it is a claim about the whole fleet rather than about one agent. Two
 * artifacts with opposite removal rules sharing one kind is how a reader — or a
 * later `filter(a => a.artifact === 'mcp-config')` — comes to the wrong
 * conclusion about which one they are holding.
 */
export type ArtifactKind = 'mcp-config' | 'git-exclude' | 'folder-trust' | typeof AGY_MCP_ARTIFACT;

/**
 * Who put an artifact there.
 *
 * `preexisting` is the case that keeps `forget` honest: a human who accepted
 * Claude Code's trust dialog themselves, months ago, has an entry that is
 * theirs. Removing it because we happened to rely on it would be taking away
 * something we never gave.
 */
export type ArtifactOrigin = 'crabcast' | 'preexisting';

/** What was written into the caller's `.mcp.json`, precisely enough to undo it. */
export interface McpConfigProvenance {
  /** Absolute path to the file. */
  file: string;
  /**
   * Our server keys, each mapped to the EXACT JSON we last wrote for it.
   *
   * The value is kept, not just the key name, so removal can tell our own
   * definition from one a consumer has since edited — see
   * {@link removeProvisionedArtifacts}, which leaves an edited key alone.
   */
  keys: Record<string, string>;
  /** Whether CrabCast created the file itself, or merged into an existing one. */
  fileCreated: boolean;
}

/**
 * What was merged into the antigravity CLI's GLOBAL MCP config for this agent.
 *
 * SAME SHAPE AS {@link McpConfigProvenance}, MINUS `fileCreated`, and the
 * absence is a decision. That flag exists so a `.mcp.json` CrabCast created can
 * be deleted once the last of its servers goes. This file is the user's global
 * CLI config: an empty one is not residue anybody has to care about, and
 * deciding a shared file is "empty enough to delete" from inside one agent's
 * `forget` is exactly the kind of fleet-wide judgement this record exists to
 * avoid making. Our keys come out; the file stays.
 *
 * PRESENCE OF THIS SECTION IS A CLAIM ON THE KEYS, and it is what the census in
 * {@link countAgyClaims} counts. So it is written only after the write really
 * landed — see `AgyMcpResult`.
 */
export interface AgyMcpProvenance {
  /** Absolute path to the global config. */
  file: string;
  /** Our keys, each mapped to the EXACT JSON we last wrote for it. */
  keys: Record<string, string>;
}

/** The one line added to a repository's private exclude file. */
export interface GitExcludeProvenance {
  file: string;
  line: string;
}

/** The global folder-trust entry, and whether it was ours to begin with. */
export interface TrustProvenance {
  file: string;
  /** The dotted key, written out as a human would look for it. */
  key: string;
  origin: ArtifactOrigin;
}

/**
 * What CrabCast has written for one agent, outside its own data directory.
 *
 * A missing section means nothing of that kind was written. Presence is the
 * permission to remove; absence is the reason not to.
 */
export interface Provenance {
  v: number;
  path: string;
  mcpConfig?: McpConfigProvenance;
  agyMcp?: AgyMcpProvenance;
  gitExclude?: GitExcludeProvenance;
  trust?: TrustProvenance;
}

/**
 * One artifact, described for the activation response.
 *
 * Silence is what made file-dropping unacceptable; the fix is not to stop
 * writing, it is to stop being silent. Every field here exists to be printed
 * at somebody: what was touched, where it is, what exactly changed inside it,
 * whether it was ours, and how to undo it.
 */
export interface ArtifactDisclosure {
  artifact: ArtifactKind;
  file: string;
  /** What changed inside that file, named the way a human would grep for it. */
  detail: string;
  origin: ArtifactOrigin;
  /** How to undo it — or, for a pre-existing artifact, why there is nothing to undo. */
  reversal: string;
}

/**
 * Provisioning that did not stick, raised so the activation is REFUSED.
 *
 * KAN-84's lesson (in the extraction source; see docs/ported-lineage.md), and
 * this daemon has paid for it once: a swallowed prompt-file write let an
 * uninstructed agent start behind `verified: true`. Every failure in this file
 * therefore throws rather than logging — the one exception is the git exclude
 * line, which is a courtesy rather than a requirement and is reported instead
 * (see {@link addGitExclude}).
 */
export class ProvisioningError extends Error {
  constructor(
    readonly artifact: ArtifactKind,
    message: string
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

// --------------------------------------------------------------- provenance

/**
 * Whether `object` has `key` as its OWN property.
 *
 * ONE FUNCTION RATHER THAN THE IDIOM SPELLED OUT AT EACH SITE, because every
 * key in this file is a server name a caller chose, and JavaScript objects
 * answer questions about names they never held. `map[key] === undefined` is
 * false for `toString`; `key in map` is true for `constructor`; and assigning
 * `__proto__` into a plain literal stores nothing at all. Each of those three
 * has already been a defect here — two found in review, one found looking for
 * its siblings — and they are the same defect wearing different names.
 *
 * So: build every caller-keyed map with a null prototype, and ask about
 * membership through this.
 */
function ownKey(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function provenanceFileIn(sidecarDir: string): string {
  return path.join(sidecarDir, PROVENANCE_FILENAME);
}

/**
 * Reading one agent's provenance file, with the THREE outcomes distinguished.
 *
 * `absent` and `unreadable` are the same answer to "what did this agent write"
 * — nothing we can act on — and OPPOSITE answers to "did this agent claim the
 * shared agy key". That distinction did not exist before KAN-140 because
 * nothing needed it: {@link readProvenance} collapses both to `null`, which is
 * exactly right when the question is about the agent's OWN artifacts, since a
 * record we cannot read is a permission we do not have.
 *
 * It is exactly wrong when the question is about a SIBLING. A corrupt
 * `provisioned.json` collapsed to `null` reads as "this agent claims nothing",
 * which is the dangerous direction: `forget` would then take the key away from
 * an agy agent that is still using it. So the census below reads through this
 * and refuses to count rather than counting a record it could not read.
 */
type ProvenanceRead =
  | { provenance: Provenance }
  /** No record. This agent wrote nothing outside our data directory. */
  | { absent: true }
  /** A record exists and could not be believed. Says why. */
  | { unreadable: string };

function readProvenanceOutcome(sidecarDir: string): ProvenanceRead {
  const file = provenanceFileIn(sidecarDir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { absent: true };
    return { unreadable: `${file} could not be read (${e?.message ?? String(e)})` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { unreadable: `${file} is not valid JSON (${e?.message ?? String(e)})` };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.path !== 'string') {
    return { unreadable: `${file} is not a provenance record (no \`path\`)` };
  }
  return { provenance: parsed as Provenance };
}

/**
 * What we have recorded writing for this agent, or `null` when we have
 * recorded nothing.
 *
 * An unreadable or unparseable provenance file answers `null`, and that is the
 * safe direction rather than the convenient one: `null` means "we cannot show
 * that we wrote this", and every removal below is gated on a positive record.
 * The failure mode is therefore leaving an artifact behind and saying so, not
 * deleting something we cannot account for.
 *
 * THAT REASONING HOLDS ONLY FOR OUR OWN RECORD. See {@link ProvenanceRead} for
 * why a sibling's unreadable record must not be read through this function.
 */
export function readProvenance(sidecarDir: string): Provenance | null {
  const outcome = readProvenanceOutcome(sidecarDir);
  return 'provenance' in outcome ? outcome.provenance : null;
}

/**
 * Record what we wrote, before the caller is told the activation succeeded.
 *
 * Atomic (temp then rename in the same directory) for the ordinary reason: a
 * torn provenance file reads as `null`, which would strand every artifact it
 * was describing.
 */
export function writeProvenance(sidecarDir: string, provenance: Provenance): void {
  fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
  const file = provenanceFileIn(sidecarDir);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(provenance, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (e: any) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw new ProvisioningError(
      'mcp-config',
      `Could not record what was written into ${provenance.path} (${file}: ` +
        `${e?.message ?? String(e)}). Nothing may be written into a caller's directory that ` +
        `cannot be written down, because the record is the only thing that lets \`forget\` ` +
        `remove exactly what we put there and nothing else.`
    );
  }
}

function emptyProvenance(agentPath: string): Provenance {
  return { v: PROVENANCE_VERSION, path: agentPath };
}

// ------------------------------------------------------------- .mcp.json

/**
 * Merge CrabCast's MCP server definitions into the caller's `.mcp.json`.
 *
 * MERGE, NEVER REPLACE, and the three refusals below are what that sentence
 * means in code:
 *
 *  1. An UNPARSEABLE existing file is refused rather than replaced. The
 *     previous code said "CrabCast owns this file" and overwrote it, which was
 *     true of a workspace CrabCast allocated and is false of a consumer's
 *     repository. The right answer was already in this codebase one function
 *     over — `configureAgyMcp` refuses to overwrite a config it cannot parse —
 *     and this is now the same answer in both places.
 *  2. A server key that is ALREADY THERE and that we have no record of writing
 *     is the consumer's, and is refused rather than silently taken over. The
 *     name collision is unlikely; quietly redirecting a server the consumer's
 *     own tooling depends on is not a risk worth the convenience of not asking.
 *  3. A write that fails refuses the activation. The caller asked for these
 *     servers; an agent started without them is an agent that is missing
 *     something it was promised, behind a success answer.
 *
 * Every key we own is REWRITTEN on each activation, deliberately: the
 * definitions bake absolute paths (this daemon's own `node` and `mcp.js`, and
 * its config path) so an agent spawned into a thin login PATH resolves the same
 * tools we do. A stale definition would point a fresh agent at a previous
 * install.
 */
export function provisionMcpConfig(options: {
  agentPath: string;
  sidecarDir: string;
  definitions: Record<string, unknown>;
}): ArtifactDisclosure[] {
  const { agentPath, sidecarDir, definitions } = options;
  const file = path.join(agentPath, MCP_CONFIG_FILENAME);
  const provenance = readProvenance(sidecarDir) ?? emptyProvenance(agentPath);
  // Null-prototype, and read below with `hasOwnProperty` rather than by
  // comparing against `undefined`. See {@link ownKey} — the plain-literal
  // version of this made the foreign-key refusal blind to a whole family of
  // server names.
  const priorKeys: Record<string, string> = Object.assign(
    Object.create(null),
    provenance.mcpConfig?.keys ?? {}
  );

  const existed = fs.existsSync(file);
  let config: any = {};
  if (existed) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e: any) {
      throw new ProvisioningError(
        'mcp-config',
        `Could not read ${file} (${e?.message ?? String(e)}). It is the caller's file and it ` +
          `is merged rather than replaced, so an unreadable one refuses the activation instead ` +
          `of being overwritten. NOTHING WAS WRITTEN and nothing was started.`
      );
    }
    try {
      config = JSON.parse(text);
    } catch (e: any) {
      throw new ProvisioningError(
        'mcp-config',
        `${file} exists but is not valid JSON (${e?.message ?? String(e)}), so CrabCast's MCP ` +
          `servers cannot be merged into it. IT WAS NOT REPLACED: this is the caller's file, ` +
          `in the caller's directory, and replacing it would destroy whatever it holds. Fix or ` +
          `move the file and activate again. NOTHING WAS STARTED.`
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ProvisioningError(
        'mcp-config',
        `${file} exists but its top level is ${Array.isArray(config) ? 'an array' : typeof config}, ` +
          `not a JSON object, so there is no \`mcpServers\` map to merge into. It was NOT ` +
          `replaced. NOTHING WAS STARTED.`
      );
    }
  }

  // NULL-PROTOTYPE, because every key in here is caller-controlled and one of
  // them has a setter on Object.prototype. `servers['__proto__'] = definition`
  // on an ordinary literal throws nothing and stores nothing — see the note in
  // router.ts's `parseAgentConfig` for the end-to-end failure that produces.
  //
  // `Object.assign` onto a null-prototype target is safe for the same reason
  // the plain literal is not: with no prototype there is no setter to hit, so
  // every key becomes an own property.
  const servers: Record<string, unknown> = Object.assign(
    Object.create(null),
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {}
  );

  // THE SECOND BUG OF THE PROTOTYPE FAMILY — found by probing for siblings of
  // the `__proto__` one rather than by anything failing.
  //
  // A server named `toString` (or `constructor`, `valueOf`, `hasOwnProperty`)
  // that the caller already has in their file, and that CrabCast has never
  // written, used to answer this test as OURS: `priorKeys['toString']` inherits
  // a function from Object.prototype, so it is not `undefined`, so the key was
  // filtered out of `foreign` and quietly overwritten. That is the precise
  // opposite of the property this guard exists for — do not take over a key
  // that is the caller's — and it failed silently, in the direction of
  // clobbering their file.
  //
  // Worse than the `__proto__` case in one way: that one dropped OUR key and
  // the agent noticed by having no tools. This one destroys THEIRS.
  //
  // TWO INDEPENDENT FIXES, and both are kept deliberately — measured, not
  // assumed. Building `priorKeys` with a null prototype closes it on its own
  // (there is no inherited `toString` to find), and asking through `ownKey`
  // closes it on its own (it ignores the prototype chain whatever the map's
  // shape). Reverting either one alone leaves the proof green; reverting both
  // turns it red, which is how the two were told apart. Keeping both means a
  // future refactor that reconstructs this map from a plain object, or copies
  // the membership idiom to a new site, does not silently reopen it.
  const foreign = Object.keys(definitions).filter(
    (key) => ownKey(servers, key) && !ownKey(priorKeys, key)
  );
  if (foreign.length) {
    throw new ProvisioningError(
      'mcp-config',
      `${file} already defines the MCP server(s) ${foreign.map((k) => `'${k}'`).join(', ')}, and ` +
        `CrabCast has no record of writing them — so they are the caller's, and they are not ` +
        `ours to take over. NOTHING WAS WRITTEN and nothing was started. Rename or remove ` +
        `those entries, or configure this agent without the colliding server.`
    );
  }

  // Null-prototype for the same reason: `written` is keyed by server name too,
  // and it is what `forget` later reads back to decide what it may remove. A
  // key that vanished here would be a key CrabCast wrote and could never take
  // back out.
  const written: Record<string, string> = Object.assign(Object.create(null), priorKeys);
  for (const [key, definition] of Object.entries(definitions)) {
    servers[key] = definition;
    written[key] = JSON.stringify(definition);
  }
  config.mcpServers = servers;

  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  } catch (e: any) {
    throw new ProvisioningError(
      'mcp-config',
      `Could not write ${file} (${e?.message ?? String(e)}). The agent was configured with MCP ` +
        `servers and Claude Code reads them from that file and nowhere else, so starting now ` +
        `would deliver an agent quietly missing what it was promised. NOTHING WAS STARTED.`
    );
  }

  const mcpConfig: McpConfigProvenance = {
    file,
    keys: written,
    // Sticky: once we created the file, we created it. A later activation
    // merging into the file we made must not decide it was the caller's.
    fileCreated: provenance.mcpConfig?.fileCreated ?? !existed
  };
  writeProvenance(sidecarDir, { ...provenance, mcpConfig });

  const disclosures: ArtifactDisclosure[] = [
    {
      artifact: 'mcp-config',
      file,
      detail:
        `mcpServers.${Object.keys(definitions).join(', mcpServers.')}` +
        (mcpConfig.fileCreated ? ' (file created by CrabCast)' : ' (merged into your existing file)'),
      origin: 'crabcast',
      reversal: mcpConfig.fileCreated
        ? `crabcast forget ${agentPath} — removes those keys and deletes the file if nothing else is left in it`
        : `crabcast forget ${agentPath} — removes those keys and leaves the rest of your file alone`
    }
  ];

  // Only for a file we created: one that was already there is already however
  // the caller wants it tracked, and adding an exclude line for it would be a
  // second unasked-for opinion about their repository.
  if (mcpConfig.fileCreated) {
    const excluded = addGitExclude(agentPath, sidecarDir, MCP_CONFIG_FILENAME);
    if (excluded) disclosures.push(excluded);
  }

  return disclosures;
}

// -------------------------------------------------- the global agy config

/**
 * Record what was merged into the antigravity CLI's global MCP config, and
 * describe it.
 *
 * `keys` is `null` when the write did not happen, and then NOTHING is recorded
 * and `null` is returned — no provenance, no disclosure. That is the whole
 * reason `configureAgyMcp` stopped returning `void`: a disclosure for a write
 * that did not land is a false sentence in the response, and a provenance
 * record for one would point `forget` at a key CrabCast never wrote.
 *
 * REWRITTEN ON EVERY ACTIVATION, like the per-directory keys and for the same
 * reason: the definitions bake absolute paths, so the recorded bytes have to be
 * the bytes currently on disk or the removal check below would read every key
 * as edited-by-somebody-else.
 */
export function noteAgyMcpConfig(options: {
  agentPath: string;
  sidecarDir: string;
  file: string;
  keys: Record<string, string> | null;
  /**
   * CrabCast's own servers that this launcher could not write (KAN-235). These
   * are disclosed EVEN WHEN NOTHING WAS WRITTEN, which is why they are handled
   * before the early return below.
   */
  omittedBuiltins?: readonly string[];
}): ArtifactDisclosure | null {
  const { agentPath, sidecarDir, file, keys } = options;
  const omitted = options.omittedBuiltins ?? [];

  // WHAT THE AGENT DOES NOT GET, SAID EVEN THOUGH NOTHING WAS WRITTEN.
  //
  // The early return below is right about writes: a disclosure for a write that
  // did not land is a false sentence. An OMISSION is the opposite case — there
  // is no file change to describe, and that is exactly the thing the caller
  // needs told. An agy agent configured with `crabcast` comes up unable to call
  // `send_to_agent` or `list_agents`, which is a capability difference between
  // launchers, and a capability removed silently is worse than one refused
  // loudly.
  const omissionNote = omitted.length
    ? ` CrabCast's own server(s) ${omitted.map((k) => `'${k}'`).join(', ')} were NOT written and ` +
      `cannot be: they carry this agent's identity (CRABCAST_AGENT_PATH), and every antigravity ` +
      `MCP scope is global, so writing one agent's identity here would hand it to every agy agent ` +
      `on this machine. THIS AGENT THEREFORE CANNOT CALL CRABCAST AT ALL — no send_to_agent, no ` +
      `list_agents, no participation in the fleet the way a claude agent has. Nothing is wrong ` +
      `and nothing was lost; agy agents never received these. Use the claude launcher for an ` +
      `agent that must steer other agents.`
    : '';

  if (!keys || Object.keys(keys).length === 0) {
    if (!omitted.length) return null;
    // NO PROVENANCE IS RECORDED HERE, deliberately. Provenance is what `forget`
    // removes by, and nothing was written to remove. A record naming these keys
    // would aim a later reversal at whatever the USER's `crabcast` entry is.
    return {
      artifact: AGY_MCP_ARTIFACT,
      file,
      detail:
        `NOTHING WAS WRITTEN to your GLOBAL antigravity CLI config.${omissionNote}`,
      origin: 'preexisting',
      reversal: `Nothing to undo — CrabCast did not modify ${file}.`
    };
  }

  const provenance = readProvenance(sidecarDir) ?? emptyProvenance(agentPath);
  const agyMcp: AgyMcpProvenance = { file, keys };
  writeProvenance(sidecarDir, { ...provenance, agyMcp });

  const names = Object.keys(keys);
  return {
    artifact: AGY_MCP_ARTIFACT,
    file,
    detail:
      `mcpServers.${names.join(', mcpServers.')} — this is your GLOBAL antigravity CLI config, ` +
      `OUTSIDE ${agentPath}. The antigravity CLI has no project-scoped equivalent, so there is ` +
      `no per-agent file to put these in. It is therefore SHARED with every other agy agent this ` +
      `daemon runs.${omissionNote}`,
    origin: 'crabcast',
    reversal:
      `crabcast forget ${agentPath} — removes those keys, but ONLY when no other agent's ` +
      `provisioning record still claims them; the file is shared, so taking the key out while a ` +
      `sibling is using it would break that agent. When a sibling still claims it, or when the ` +
      `records cannot be read, \`forget\` LEAVES the key and names what it is waiting on. The ` +
      `file itself is never deleted — it is yours. By hand: delete the \`mcpServers\` entries ` +
      `named above from ${file}.`
  };
}

/**
 * Who else still claims CrabCast's keys in the shared agy config.
 *
 * THE ONE NEW CLAIM THIS SLICE MAKES is "no other agent needs this key", and
 * this function is the whole of the evidence for it. So it answers in three
 * parts rather than with a number: who claims (by path), what could not be read,
 * and how many records were consulted. A count alone cannot be argued with, and
 * `forget`'s report has to be able to say what it rested on.
 *
 * THE READ IS DELIBERATELY NARROW. It asks one question of each sibling record —
 * does it claim any of these keys in this file — and reads nothing else out of
 * them. `forget` does not otherwise reason about other agents, and the ticket
 * flagged that boundary as the thing to be careful about.
 *
 * WHAT IT CANNOT SEE, stated here because a census that is read as complete is
 * worse than one that is read as partial:
 *
 *  - **Another daemon's agents.** The scan is one `dataDir`. Two CrabCast
 *    daemons with different data directories write the same global agy file and
 *    are invisible to each other, so the last claimant under THIS daemon can
 *    remove a key the other daemon's agent is using.
 *  - **A key written by hand**, or by any agy user who is not CrabCast. Those
 *    are not claims and are not counted — but the byte comparison at the
 *    removal site is what actually protects them, not this.
 *  - **A write whose record never landed.** `configureAgyMcp` writes the file
 *    and `writeProvenance` records it afterwards; a crash between the two
 *    leaves a key with no claimant. It is then removable by the next `forget` —
 *    residue in the other direction, and the same window `provisionMcpConfig`
 *    already has.
 *  - **Whether a claimant is RUNNING.** A configured-but-stopped agy agent
 *    still claims, and that is deliberate: it will need the key when it starts,
 *    and `forget` is what retires a claim.
 */
export interface AgyClaimCensus {
  /** Paths of OTHER agents whose provenance still claims one of these keys. */
  claimants: string[];
  /**
   * Each sibling claim in full — which agent, which key, and the EXACT bytes
   * that agent recorded writing for it (KAN-235).
   *
   * `claimants` answers "may this key be removed"; this answers "can the shared
   * file honour this key for two agents at once", which needs the value and not
   * just the name. See {@link classifyAgyKeys}.
   */
  claims: Array<{ path: string; key: string; value: string }>;
  /** Records that exist and could not be believed, with the reason for each. */
  unreadable: string[];
  /** How many sibling sidecars were consulted, so "none claim it" has a size. */
  consulted: number;
  /** Set when the census could not be taken at all. Nothing may be removed. */
  failed?: string;
}

export function countAgyClaims(options: {
  agentsDir: string | undefined;
  /** Our own sidecar, excluded — we are the claim being retired. */
  ownSidecarDir: string;
  file: string;
  keys: string[];
}): AgyClaimCensus {
  const { agentsDir, ownSidecarDir, file, keys } = options;
  const empty = { claimants: [], claims: [], unreadable: [], consulted: 0 };

  if (!agentsDir) {
    return {
      ...empty,
      failed:
        `no agents directory was supplied, so the other agents' provisioning records could not ` +
        `be consulted at all`
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (e: any) {
    return {
      ...empty,
      failed: `${agentsDir} could not be listed (${e?.message ?? String(e)})`
    };
  }

  const own = path.resolve(ownSidecarDir);
  const claimants: string[] = [];
  const claims: Array<{ path: string; key: string; value: string }> = [];
  const unreadable: string[] = [];
  let consulted = 0;

  for (const entry of entries) {
    const sidecar = path.join(agentsDir, entry);
    if (path.resolve(sidecar) === own) continue;
    const outcome = readProvenanceOutcome(sidecar);
    // No record at all is not a claim, and is not a doubt either: an agent that
    // wrote nothing outside our data directory has nothing to claim with.
    if ('absent' in outcome) continue;
    consulted += 1;
    if ('unreadable' in outcome) {
      unreadable.push(outcome.unreadable);
      continue;
    }
    const claim = outcome.provenance.agyMcp;
    if (!claim || claim.file !== file) continue;
    const matched = keys.filter((key) => ownKey(claim.keys, key));
    if (!matched.length) continue;
    claimants.push(outcome.provenance.path);
    for (const key of matched) {
      claims.push({ path: outcome.provenance.path, key, value: claim.keys[key] });
    }
  }

  return { claimants, claims, unreadable, consulted };
}

/**
 * Whether the keys we are about to write into the SHARED agy config are ours to
 * write (KAN-178).
 *
 * THE QUESTION `provisionMcpConfig` ASKS ONE FILE OVER, ASKED OF A FILE WITH
 * MANY OWNERS. Its rule is that a server key already present that CrabCast has
 * no record of writing is the caller's, and is refused rather than taken over.
 * It answers that from ONE sidecar, which is exactly right for `.mcp.json`:
 * one directory, one agent, so our own record is the whole of CrabCast's
 * memory of that file.
 *
 * THAT READING WOULD BE WRONG HERE, and getting it wrong costs an activation.
 * The agy config is shared, so a key written by a SIBLING is CrabCast's key
 * too — refusing over it would block an agent because of state it does not own
 * and never touched. The rule is "CrabCast has no record", not "I have no
 * record", so the evidence has to be the whole fleet's records: our own, plus
 * every sibling's, which is what {@link countAgyClaims} already reads for
 * `forget`. Storage is per-agent; the QUESTION is fleet-wide, and this is
 * where the two are reconciled.
 *
 * THREE ANSWERS, NOT TWO, because the census can fail:
 *
 *  - **ours** — recorded by us or by a sibling. Merged, exactly as before.
 *  - **foreign** — present, and no CrabCast record anywhere accounts for it.
 *    The user's. Refused.
 *  - **indeterminate** — the records could not be read, so ownership was never
 *    established. Also refused, and `doubt` says what could not be read.
 *
 * WHY INDETERMINATE REFUSES, when the removal side leaves the key instead. The
 * two are the same principle pointing at opposite actions. `removeOurAgyKeys`
 * is deciding whether to TAKE something away, so the unestablished case must
 * not remove; this is deciding whether to WRITE OVER something, so the
 * unestablished case must not overwrite. Both resolve to "do not touch what you
 * cannot account for".
 *
 * AND IT IS CHEAP BECAUSE IT IS RARE. Nothing here runs unless a key we are
 * about to write is ALREADY IN THE FILE. An activation with no collision — the
 * ordinary case, including every re-activation of an agent whose own record
 * explains its keys — consults no census at all and cannot be refused by this.
 *
 * The per-key census loop is deliberate: `countAgyClaims` answers about a SET,
 * and a refusal has to name the individual key it is about. Colliding keys
 * number one or two in practice, and the loop only runs on the collision path.
 */
export interface AgyKeyOwnership {
  /** Keys in the file that no CrabCast record accounts for — the user's. */
  foreign: string[];
  /** Keys in the file whose ownership could not be established either way. */
  indeterminate: string[];
  /** What could not be read. Present exactly when `indeterminate` is non-empty. */
  doubt?: string;
  /**
   * Keys a SIBLING agent records writing with a DIFFERENT definition than the
   * one we are about to write (KAN-235).
   *
   * Ours, in the ownership sense — a CrabCast record accounts for them, so they
   * are not the user's and `foreign` is the wrong answer. But one file cannot
   * hold two values for one key, so writing ours takes the sibling's server
   * away from it. Named with the sibling so the refusal can say who.
   */
  conflicting: Array<{ key: string; sibling: string; theirs: string; ours: string }>;
}

export function classifyAgyKeys(options: {
  /** The global config, for matching against the file each record names. */
  file: string;
  /** The `mcpServers` value currently in that file, exactly as parsed. */
  existing: unknown;
  /** The key names we are about to write. */
  writing: string[];
  /**
   * The definitions we are about to write, for the differing-definition
   * comparison (KAN-235). Omitting it disables that check only — ownership is
   * still classified, so an older caller keeps its previous behaviour rather
   * than silently getting a weaker answer it cannot tell apart.
   */
  definitions?: Record<string, unknown>;
  agentsDir?: string;
  /** Our own sidecar. Its absence is a doubt, not an all-clear. */
  ownSidecarDir?: string;
}): AgyKeyOwnership {
  const { file, existing, writing, definitions, agentsDir, ownSidecarDir } = options;
  const nothing: AgyKeyOwnership = { foreign: [], indeterminate: [], conflicting: [] };

  // NULL-PROTOTYPE AND `ownKey`, for the reason spelled out at the equivalent
  // read in `provisionMcpConfig`: every name here is caller-chosen, and a user's
  // own server called `toString` answered the plain-literal version of this test
  // as OURS — inheriting a function from Object.prototype rather than being
  // absent — which is this guard failing in the exact direction it exists to
  // prevent. Building the map with no prototype and asking through `ownKey` each
  // close it independently, and both are kept for the same reason they are kept
  // there.
  const servers: Record<string, unknown> = Object.assign(
    Object.create(null),
    existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  );
  const colliding = writing.filter((key) => ownKey(servers, key));
  if (!colliding.length) return nothing;

  // Our own record first: it is the cheapest evidence and it explains the
  // commonest collision by far — this same agent activating again over the keys
  // it wrote last time.
  const ownClaim = ownSidecarDir ? readProvenance(ownSidecarDir)?.agyMcp : undefined;
  const ownKeys: Record<string, string> = Object.assign(
    Object.create(null),
    ownClaim && ownClaim.file === file ? ownClaim.keys : {}
  );
  const unexplained = colliding.filter((key) => !ownKey(ownKeys, key));

  if (!ownSidecarDir) {
    return {
      foreign: [],
      indeterminate: unexplained,
      conflicting: [],
      doubt:
        `no sidecar directory was supplied, so CrabCast's own record of what it has written to ` +
        `${file} could not be read at all`
    };
  }

  const foreign: string[] = [];
  const indeterminate: string[] = [];
  const conflicting: AgyKeyOwnership['conflicting'] = [];
  const doubts: string[] = [];
  // EVERY COLLIDING KEY, NOT ONLY THE UNEXPLAINED ONES (KAN-235). Ownership only
  // ever needed the keys our own record could not explain — re-activating over
  // your own key is nobody else's business. The differing-definition question is
  // not about ownership and does not have that shortcut: a key OUR record
  // explains can still be claimed by a sibling with different bytes, and writing
  // ours would take that sibling's server away. So the loop widened.
  //
  // The cost is one census per colliding key on a re-activation that previously
  // took none. It is still bounded by there being a collision at all, which
  // means the key is already in the shared file, and a census is a readdir plus
  // one small JSON read per sibling.
  for (const key of colliding) {
    const explainedByUs = ownKey(ownKeys, key);
    const census = countAgyClaims({ agentsDir, ownSidecarDir, file, keys: [key] });
    if (census.failed) {
      if (!explainedByUs) {
        indeterminate.push(key);
        doubts.push(census.failed);
      }
      continue;
    }
    // A record that exists and cannot be believed may be the very one that
    // wrote this key, so it is a doubt rather than a non-claim — the same
    // reading `removeOurAgyKeys` gives it, and for the same reason.
    if (census.unreadable.length) {
      if (!explainedByUs) {
        indeterminate.push(key);
        doubts.push(...census.unreadable);
      }
      continue;
    }
    if (!explainedByUs && !census.claimants.length) {
      foreign.push(key);
      continue;
    }

    // A CrabCast record accounts for this key, so it is not the user's. The
    // remaining question is whether the ONE value this file can hold is the
    // same value the sibling is relying on. If it is not, merging does not
    // share the key — it takes it.
    if (!definitions || !ownKey(definitions, key)) continue;
    const ours = JSON.stringify(definitions[key]);
    for (const claim of census.claims) {
      if (claim.value === ours) continue;
      conflicting.push({ key, sibling: claim.path, theirs: claim.value, ours });
      break;
    }
  }

  return {
    foreign,
    indeterminate,
    conflicting,
    ...(doubts.length ? { doubt: [...new Set(doubts)].join('; ') } : {})
  };
}

// ------------------------------------------------------------ git exclude

/**
 * The private exclude file git reads for this working tree, or `null` when the
 * directory is not the root of one.
 *
 * `.git` is a DIRECTORY in an ordinary clone and a FILE in a linked worktree,
 * and the exclude file lives in the COMMON directory in the second case — the
 * per-worktree gitdir has no `info/exclude` that git consults. Both are handled
 * because a caller adopting a fleet of task worktrees hits the second one every
 * time, and getting it wrong would silently write an exclude file nothing reads.
 */
export function gitExcludeFileFor(dir: string): string | null {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return path.join(dotGit, 'info', 'exclude');
  if (!stat.isFile()) return null;

  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) return null;
    const gitDir = path.resolve(dir, match[1].trim());
    // A linked worktree's own gitdir holds a `commondir` pointing at the
    // repository everything is shared from; `info/` lives there.
    try {
      const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      if (common) return path.join(path.resolve(gitDir, common), 'info', 'exclude');
    } catch {}
    return path.join(gitDir, 'info', 'exclude');
  } catch {
    return null;
  }
}

/**
 * Add one line to the repository's private exclude file, so a file CrabCast
 * created does not surface as a spurious untracked change in the caller's tree.
 *
 * NOT FATAL, and this is the one place in this file where a failure does not
 * refuse the activation. The distinction is real rather than convenient: the
 * `.mcp.json` write is something the agent NEEDS — Claude Code reads its
 * servers from there and nowhere else — while this line is tidiness on the
 * caller's behalf. An activation refused because a repository's `info/`
 * directory was read-only would be this daemon failing a job nobody asked it to
 * do. It is reported either way; `null` simply means there was nothing to add.
 */
function addGitExclude(
  agentPath: string,
  sidecarDir: string,
  line: string
): ArtifactDisclosure | null {
  const file = gitExcludeFileFor(agentPath);
  if (!file) return null;

  const provenance = readProvenance(sidecarDir) ?? emptyProvenance(agentPath);
  if (provenance.gitExclude) {
    // Already ours from a previous activation. Re-adding it would duplicate the
    // line; saying nothing would drop it out of the disclosure.
    return {
      artifact: 'git-exclude',
      file: provenance.gitExclude.file,
      detail: `the line \`${provenance.gitExclude.line}\` (added by a previous activation)`,
      origin: 'crabcast',
      reversal: `crabcast forget ${agentPath} — removes exactly that line`
    };
  }

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') return null;
  }
  // Already excluded by the caller, by any means. Their line, not ours, so it
  // is neither recorded nor ever removed.
  if (existing.split('\n').some((l) => l.trim() === line)) return null;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (existing.length && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
  } catch {
    return null;
  }

  writeProvenance(sidecarDir, { ...provenance, gitExclude: { file, line } });
  return {
    artifact: 'git-exclude',
    file,
    detail: `the line \`${line}\`, so the file CrabCast created is not a spurious untracked change`,
    origin: 'crabcast',
    reversal: `crabcast forget ${agentPath} — removes exactly that line`
  };
}

// ----------------------------------------------------------- folder trust

/**
 * Record who the global folder-trust entry belongs to, and describe it.
 *
 * `wroteIt` is the answer to "did CrabCast find this entry ABSENT and put it
 * there" — `trustClaudeWorkspace` reports `attempts: 0` when the entry was
 * already true on its first read, and anything above zero means it wrote one.
 *
 * DECIDED ONCE, AT THE FIRST ACTIVATION, AND NEVER REVISED. The second
 * activation always finds the entry present (we wrote it), so re-deciding would
 * flip every agent's trust entry to `preexisting` and make it permanently
 * unremovable. And the other direction matters more: a human who accepted the
 * dialog themselves has an entry that is theirs, and a later repair write by us
 * must not turn it into ours to delete.
 */
export function noteTrustEntry(options: {
  agentPath: string;
  sidecarDir: string;
  file: string;
  trustKey: string;
  wroteIt: boolean;
}): ArtifactDisclosure {
  const { agentPath, sidecarDir, file, trustKey, wroteIt } = options;
  const provenance = readProvenance(sidecarDir) ?? emptyProvenance(agentPath);
  const key = `projects[${JSON.stringify(trustKey)}].hasTrustDialogAccepted`;

  const trust: TrustProvenance =
    provenance.trust ?? { file, key, origin: wroteIt ? 'crabcast' : 'preexisting' };
  if (!provenance.trust) writeProvenance(sidecarDir, { ...provenance, trust });

  return {
    artifact: 'folder-trust',
    file: trust.file,
    detail:
      `${trust.key} = true — this is OUTSIDE ${agentPath}, in your global Claude Code ` +
      `configuration. Claude Code offers no project-scoped setting for folder trust, and ` +
      `without this key it stops on a trust dialog nobody is there to accept.`,
    origin: trust.origin,
    reversal:
      trust.origin === 'crabcast'
        ? `crabcast forget ${agentPath} — removes that key and nothing else in ${trust.file}. ` +
          `By hand: delete the \`hasTrustDialogAccepted\` entry for this directory.`
        : `nothing to undo — the entry was already there before CrabCast saw this directory, ` +
          `so it is yours and \`forget\` will not touch it`
  };
}

/**
 * Remove one project's trust entry from the global Claude Code config.
 *
 * Add-only in reverse, with the same discipline the write has: an unparseable
 * file is left alone rather than repaired (it holds unrelated user state), the
 * write is atomic so a concurrent reader never parses a torn file, and no key
 * but this project's is touched. An empty project entry left behind by the
 * removal is dropped too — it is a record of nothing.
 */
function removeTrustEntry(file: string, trustKey: string): { removed: boolean; error?: string } {
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { removed: false, error: `${file} no longer exists` };
    return {
      removed: false,
      error: `${file} could not be read or parsed (${e?.message ?? String(e)}); it holds ` +
        `unrelated Claude Code state and is not ours to rewrite blind`
    };
  }
  const project = config?.projects?.[trustKey];
  if (!project || typeof project !== 'object') return { removed: false };
  if (project.hasTrustDialogAccepted === undefined) return { removed: false };

  delete project.hasTrustDialogAccepted;
  // The entry existed only to hold that key: leaving `{}` behind would be
  // residue of exactly the kind this whole file exists to avoid.
  if (Object.keys(project).length === 0) delete config.projects[trustKey];

  const temp = `${file}.crabcast-forget-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2));
    fs.renameSync(temp, file);
  } catch (e: any) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    return { removed: false, error: `could not rewrite ${file}: ${e?.message ?? String(e)}` };
  }
  return { removed: true };
}

// ---------------------------------------------------------------- reversal

/** What `forget` took back, and what it deliberately did not. */
export interface RemovalReport {
  /** One line per artifact removed, naming the file and what changed in it. */
  removed: string[];
  /** One line per artifact left behind, WITH THE REASON. */
  left: string[];
}

/**
 * Undo every write this agent's provenance record accounts for.
 *
 * THE RULES, all four of which are refusals dressed as behaviour:
 *
 *  - **Exactly what we wrote.** Every removal below is gated on a positive
 *    provenance entry. No record, no removal — a directory CrabCast never
 *    provisioned is left untouched, and so is a key we cannot show we wrote.
 *  - **Never a recursive delete, and never a directory of the caller's.** The
 *    only directory removed anywhere here is the agent's own sidecar, inside
 *    CrabCast's data dir, and even that is emptied file-by-file and then
 *    `rmdir`'d — so anything unexpected inside it stops the removal and gets
 *    reported rather than swept away.
 *  - **Nothing is removed that has been edited since we wrote it.** A server
 *    key whose current bytes differ from the bytes we recorded is somebody's
 *    change, and taking it out would destroy work rather than clean up after
 *    ourselves.
 *  - **Everything is reported.** What could not be removed is named with its
 *    reason, so residue is a sentence in the response rather than something
 *    found months later.
 *  - **And a fifth for the one SHARED artifact:** the global agy config's keys
 *    come out only when no other agent's record claims them, and a count that
 *    cannot be established is a reason to leave rather than a reason to
 *    proceed. `removed` says what the removal rested on, not just that it
 *    happened.
 *
 * Failures do not throw. `forget`'s postcondition is the absence of a record,
 * and refusing the whole call because one file was read-only would leave the
 * caller with both the record AND the residue.
 */
export function removeProvisionedArtifacts(options: {
  agentPath: string;
  sidecarDir: string;
  /**
   * Where every agent's sidecar lives, so the shared agy key can be
   * reference-counted (KAN-140). OPTIONAL, and its absence is not treated as
   * "nobody else claims it": a caller that cannot say where the records are
   * gets the same answer as one whose records are unreadable — the key is LEFT,
   * with that stated as the reason. `identity.ts`'s `agentsDirFor` is what
   * produces it.
   */
  agentsDir?: string;
}): RemovalReport {
  const { agentPath, sidecarDir, agentsDir } = options;
  const removed: string[] = [];
  const left: string[] = [];
  const provenance = readProvenance(sidecarDir);

  if (provenance?.mcpConfig) {
    removeOurMcpKeys(provenance.mcpConfig, removed, left);
  }

  if (provenance?.agyMcp) {
    removeOurAgyKeys(provenance.agyMcp, { agentsDir, ownSidecarDir: sidecarDir }, removed, left);
  }

  if (provenance?.gitExclude) {
    const { file, line } = provenance.gitExclude;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const index = lines.findIndex((l) => l.trim() === line);
      if (index === -1) {
        left.push(`${file}: the line \`${line}\` was already gone`);
      } else {
        lines.splice(index, 1);
        fs.writeFileSync(file, lines.join('\n'));
        removed.push(`${file}: the line \`${line}\``);
      }
    } catch (e: any) {
      left.push(`${file}: the line \`${line}\` could not be removed (${e?.message ?? String(e)})`);
    }
  }

  if (provenance?.trust) {
    const { file, key, origin } = provenance.trust;
    if (origin !== 'crabcast') {
      left.push(`${file}: ${key} — it was already there before CrabCast saw this directory, so it is yours`);
    } else {
      const outcome = removeTrustEntry(file, agentPath);
      if (outcome.removed) removed.push(`${file}: ${key}`);
      else left.push(`${file}: ${key} — ${outcome.error ?? 'it was already gone'}`);
    }
  }

  removeSidecar(sidecarDir, removed, left);
  return { removed, left };
}

/**
 * Take our server keys back out of the caller's `.mcp.json`, and delete the
 * file only if we created it and nothing else is left in it.
 */
function removeOurMcpKeys(
  provenance: McpConfigProvenance,
  removed: string[],
  left: string[]
): void {
  const { file, keys, fileCreated } = provenance;
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return; // Already gone. Nothing owed.
    left.push(
      `${file}: CrabCast's server key(s) ${Object.keys(keys).join(', ')} could not be removed ` +
        `(${e?.message ?? String(e)}) — the file is the caller's and is not rewritten blind`
    );
    return;
  }

  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return;

  const taken: string[] = [];
  for (const [key, written] of Object.entries(keys)) {
    if (!ownKey(servers, key)) continue;
    if (JSON.stringify(servers[key]) !== written) {
      left.push(
        `${file}: the server \`${key}\` has been edited since CrabCast wrote it, so it was left ` +
          `in place — removing it would destroy somebody's change rather than undo ours`
      );
      continue;
    }
    delete servers[key];
    taken.push(key);
  }
  // NOTHING WAS TAKEN, SO NOTHING IS WRITTEN. Falling through here would
  // re-serialize the caller's file — reformatting it, collapsing its
  // whitespace, reordering nothing but touching everything — on a `forget` that
  // removed none of its content. A cleanup that rewrites a file it took nothing
  // out of is a cleanup leaving a diff behind, which is the whole thing this
  // file exists to avoid.
  if (!taken.length) return;

  const otherServers = Object.keys(servers).length;
  const otherTopLevel = Object.keys(config).filter((k) => k !== 'mcpServers').length;

  try {
    // Only a file we created, holding nothing but what we put in it, is
    // deleted. A file the caller had before us keeps existing, minus our keys.
    if (fileCreated && otherServers === 0 && otherTopLevel === 0) {
      fs.unlinkSync(file);
      removed.push(`${file} (created by CrabCast; removed with the last of its servers)`);
      return;
    }
    if (otherServers === 0) delete config.mcpServers;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    if (taken.length) {
      removed.push(
        `${file}: the server key(s) ${taken.join(', ')}` +
          (fileCreated ? '' : ' — the file is yours and was left in place')
      );
    }
  } catch (e: any) {
    left.push(`${file}: could not be rewritten (${e?.message ?? String(e)})`);
  }
}

/**
 * Take our server keys back out of the SHARED antigravity CLI config — but only
 * when this agent is the last one recorded as needing them (KAN-140).
 *
 * THE ASYMMETRY THAT DECIDES EVERY BRANCH BELOW. An unremoved key is residue,
 * and it is residue that was disclosed at activation and is named again here.
 * A wrongly removed key silently breaks a running agy agent — its servers are
 * simply gone the next time it starts, with nothing anywhere saying why. Those
 * costs are not comparable, so every case that cannot be established REFUSES TO
 * REMOVE and says what it was unable to establish.
 *
 * Four things are therefore checked, and only the fourth is about our own bytes:
 *
 *  1. **The census was takeable at all.** No agents directory, or one that
 *     cannot be listed, means the question was never asked. Leave everything.
 *  2. **Every sibling record was readable.** One corrupt `provisioned.json`
 *     leaves the count unknown in the dangerous direction — an unreadable record
 *     may be exactly the agent that needs the key — so a single unreadable
 *     record stops the whole removal rather than being skipped.
 *  3. **No other agent claims the key.** A claimant is named by PATH in the
 *     report, because "somebody else needs it" is not actionable and
 *     "/home/you/code/thing needs it" is.
 *  4. **The bytes are still ours.** Same rule as the per-directory keys: a value
 *     that is not the value we recorded is somebody's change and is left.
 *
 * THE KNOWN RESIDUE, named rather than discovered later: (4) fires in the
 * ordinary multi-agent case, not only when a human edits the file. Two agy
 * agents write the same key with DIFFERENT bytes — `builtinMcpServer` bakes each
 * agent's own path in — so the second activation overwrites the first's value.
 * The last claimant to leave then finds bytes its own record does not describe,
 * and leaves the key. That is the safe direction and it is reported, but it
 * means the common fleet case ends in disclosed residue rather than a clean
 * removal. The underlying cause is that a shared file cannot carry per-agent
 * identity at all, which is a defect in the WRITE rather than in this reversal
 * — KAN-177, filed with the observation that produced it.
 */
function removeOurAgyKeys(
  provenance: AgyMcpProvenance,
  where: { agentsDir?: string; ownSidecarDir: string },
  removed: string[],
  left: string[]
): void {
  const { file, keys } = provenance;
  const names = Object.keys(keys);
  const named = names.join(', ');
  if (!names.length) return;

  const census = countAgyClaims({
    agentsDir: where.agentsDir,
    ownSidecarDir: where.ownSidecarDir,
    file,
    keys: names
  });

  // 1. The question was never asked.
  if (census.failed) {
    left.push(
      `${file}: the server key(s) ${named} — LEFT because the claim count could not be ` +
        `established (${census.failed}). This file is SHARED with every other agy agent, so a ` +
        `key is removed only when no other agent's provisioning record still claims it; without ` +
        `that count, removing could take the servers away from an agent that is still using them.`
    );
    return;
  }

  // 2. It was asked and came back partly unreadable.
  if (census.unreadable.length) {
    left.push(
      `${file}: the server key(s) ${named} — LEFT because ${census.unreadable.length} of the ` +
        `${census.consulted} other provisioning record(s) could not be read, so whether another ` +
        `agy agent still claims these keys is UNKNOWN: ${census.unreadable.join('; ')}. An ` +
        `unreadable record may be exactly the agent that needs them, and this file is shared, so ` +
        `the count is refused rather than guessed.`
    );
    return;
  }

  // 3. Somebody else still needs it.
  if (census.claimants.length) {
    left.push(
      `${file}: the server key(s) ${named} — LEFT because ${census.claimants.length} other agy ` +
        `agent(s) still claim them: ${census.claimants.join(', ')}. This file is shared and has ` +
        `no per-agent equivalent, so removing the key now would take those servers away from ` +
        `agents that are still using them. \`forget\` the last of them and the key goes with it.`
    );
    return;
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return; // Already gone. Nothing owed.
    left.push(
      `${file}: the server key(s) ${named} could not be removed (${e?.message ?? String(e)}) — ` +
        `it is your global antigravity CLI config and is not rewritten blind`
    );
    return;
  }

  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return;

  // 4. Ours by bytes, or not ours to take.
  const taken: string[] = [];
  for (const [key, written] of Object.entries(keys)) {
    if (!ownKey(servers, key)) continue;
    if (JSON.stringify(servers[key]) !== written) {
      left.push(
        `${file}: the server \`${key}\` is not the definition this agent's record accounts for — ` +
          `either you edited it, or another CrabCast agy agent rewrote it after us — so it was ` +
          `left in place rather than removed on a record that no longer describes it`
      );
      continue;
    }
    delete servers[key];
    taken.push(key);
  }
  // Nothing taken, nothing written — the caller's file is not re-serialized on a
  // removal that removed none of its content. Same rule, same reason, as
  // `removeOurMcpKeys`.
  if (!taken.length) return;

  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  } catch (e: any) {
    left.push(`${file}: could not be rewritten (${e?.message ?? String(e)})`);
    return;
  }

  // WHAT IT RESTED ON, not merely what happened. A reader who is told "removed"
  // cannot tell a reference-counted removal from a blind one, and those differ
  // by whether a sibling has just been broken.
  removed.push(
    `${file}: the server key(s) ${taken.join(', ')} — removed BECAUSE no other agent's ` +
      `provisioning record claimed them (${census.consulted} other record(s) read under this ` +
      `daemon's data directory, all readable). The file itself is your global antigravity CLI ` +
      `config and was left in place.`
  );
}

/**
 * Empty and remove the agent's sidecar — the one directory here that is
 * CrabCast's outright.
 *
 * FILE BY FILE AND THEN `rmdir`, never `rm -rf`. The sidecar holds files this
 * daemon wrote and nothing else, so the recursive form would be safe today and
 * would silently stay "safe" the first time something else appeared in there.
 * Removing the names we know and reporting whatever is left is the version that
 * cannot become wrong.
 */
function removeSidecar(sidecarDir: string, removed: string[], left: string[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(sidecarDir);
  } catch {
    return; // No sidecar. Nothing owed.
  }

  const ours = new Set([PROVENANCE_FILENAME, 'prompt.md']);
  const strangers: string[] = [];
  for (const entry of entries) {
    if (!ours.has(entry)) {
      strangers.push(entry);
      continue;
    }
    try {
      fs.unlinkSync(path.join(sidecarDir, entry));
    } catch (e: any) {
      strangers.push(entry);
      left.push(`${path.join(sidecarDir, entry)}: could not be removed (${e?.message ?? String(e)})`);
    }
  }

  if (strangers.length) {
    left.push(
      `${sidecarDir}: kept, because it still holds ${strangers.join(', ')} — files CrabCast did ` +
        `not write are not swept up by a cleanup that only knows its own`
    );
    return;
  }

  try {
    fs.rmdirSync(sidecarDir);
    removed.push(`${sidecarDir} (CrabCast's own sidecar: the rendered prompt and this record)`);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return;
    left.push(`${sidecarDir}: could not be removed (${e?.message ?? String(e)})`);
  }
}
