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

/**
 * Which artifact a disclosure or a removal is about. A closed set on purpose:
 * a fifth artifact is a decision somebody has to make in this file, not a
 * string a caller can invent.
 */
export type ArtifactKind = 'mcp-config' | 'git-exclude' | 'folder-trust';

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
 * KAN-84's lesson, and this daemon has paid for it once: a swallowed
 * prompt-file write let an uninstructed agent start behind `verified: true`.
 * Every failure in this file therefore throws rather than logging — the one
 * exception is the git exclude line, which is a courtesy rather than a
 * requirement and is reported instead (see {@link addGitExclude}).
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
 * What we have recorded writing for this agent, or `null` when we have
 * recorded nothing.
 *
 * An unreadable or unparseable provenance file answers `null`, and that is the
 * safe direction rather than the convenient one: `null` means "we cannot show
 * that we wrote this", and every removal below is gated on a positive record.
 * The failure mode is therefore leaving an artifact behind and saying so, not
 * deleting something we cannot account for.
 */
export function readProvenance(sidecarDir: string): Provenance | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(provenanceFileIn(sidecarDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.path !== 'string') return null;
    return parsed as Provenance;
  } catch {
    return null;
  }
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
 *
 * Failures do not throw. `forget`'s postcondition is the absence of a record,
 * and refusing the whole call because one file was read-only would leave the
 * caller with both the record AND the residue.
 */
export function removeProvisionedArtifacts(options: {
  agentPath: string;
  sidecarDir: string;
}): RemovalReport {
  const { agentPath, sidecarDir } = options;
  const removed: string[] = [];
  const left: string[] = [];
  const provenance = readProvenance(sidecarDir);

  if (provenance?.mcpConfig) {
    removeOurMcpKeys(provenance.mcpConfig, removed, left);
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
