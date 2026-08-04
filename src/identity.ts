import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * An agent is a directory. This file is the whole of what that means.
 *
 * WHY THE PATH AND NOT A NAME
 *
 * The previous model addressed agents as `<type>/<key>` and encoded that pair
 * into the herdr pane name, which four different functions then parsed back
 * out. Two agents could collide on one key; a dash in a type name broke
 * addressing silently; and the daemon had to own a directory-allocation rule
 * (`<dataDir>/workspaces/<type>/<key>`) that no caller could opt out of. The
 * path removes all of it at once: it is unique by construction, it is the
 * thing a caller already has, and the filesystem — not this daemon — is what
 * answers whether it exists.
 *
 * CANONICALIZATION IS THE IDENTITY
 *
 * `path.resolve` then `fs.realpathSync`, in that order, and realpath is doing
 * the load-bearing work: it resolves symlinks, so a symlink and its target are
 * ONE agent rather than two records that would each spawn a pane into the same
 * directory. Both sides of every comparison in this daemon are canonicalized
 * before they are compared — herdr reports a pane's `cwd` as an arbitrary
 * string, and a symlinked pane cwd would otherwise compare unequal to the
 * directory it actually occupies.
 *
 * NOTHING PARSES THE PANE NAME BACK OUT
 *
 * herdr still needs *a* token per agent, so {@link paneNameFor} makes one — and
 * it is one-way by construction rather than by policy. The slug is lowercased,
 * punctuation-collapsed and truncated (all lossy) and the hash is a digest.
 * There is no inverse to write, and that is the point.
 *
 * The name IS compared, though, and the distinction matters: `ourPaneIn`
 * (herdr.ts) decides whether a pane is ours by computing `paneNameFor(path)`
 * forward and testing equality. That is not parsing — nothing is recovered
 * from the string — and it is what makes ownership a stable, forward-computed
 * fact rather than a lookup in something that can move. Which is why the hash
 * width below is load-bearing rather than cosmetic.
 */

/** The prefix every pane name this daemon creates carries. */
export const PANE_NAME_PREFIX = 'crabcast-';

/**
 * How much of the path digest rides in a pane name and a sidecar directory.
 *
 * SIXTEEN, not eight, and the reason changed with the ownership test. At 32
 * bits two directories collide at around the tens-of-thousands mark — fine
 * when a collision only meant a shared sidecar. It is not fine now: the pane
 * name is what decides whether a pane is OURS, so two paths sharing one would
 * mean each agent's `activate` recognising the other's pane as its own, and
 * `forget` refusing on it. 64 bits puts that past any fleet, any machine and
 * any amount of time this daemon will see, for eight characters.
 */
const HASH_CHARS = 16;

/** How much of the directory's own name survives into the pane name. */
const SLUG_CHARS = 24;

/** A path that is not usable as an agent identity, with the reason. */
export class PathError extends Error {}

/**
 * The canonical real path of a caller-supplied directory, or a refusal.
 *
 * Refuses a path that does not exist, and that refusal is the whole of the
 * mkdir decision: `configure` may not create a directory, so the filesystem is
 * what catches a mistyped path. Under the old model a typo produced a
 * wrong-but-contained directory inside CrabCast's own tree; under this one it
 * would scatter junk directories through a caller's source tree, and nothing
 * else is in a position to notice.
 */
export function canonicalPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new PathError(
      'Missing or invalid path: an agent is addressed by the directory it runs in, ' +
        'given as a non-empty string.'
    );
  }
  const raw = input.trim();
  // ABSOLUTE ONLY, and this is a refusal rather than a resolution.
  //
  // `path.resolve` on a relative path resolves against THIS process's cwd —
  // and this process is a daemon that was spawned detached by whichever client
  // happened to need it first, so its cwd is that client's, from possibly days
  // ago. `crabcast configure ./svc` from two different projects would then
  // address the same directory, and which one would depend on where the daemon
  // was started. A path is the identity here; an identity that means something
  // different depending on who is asking is not one.
  //
  // The clients resolve against their OWN cwd before the request goes on the
  // wire, which is the only cwd that answers the caller's question. What
  // arrives here is therefore already absolute, and anything that is not is a
  // caller that skipped that step — refused by name rather than silently
  // resolved somewhere plausible.
  if (!path.isAbsolute(raw)) {
    throw new PathError(
      `Path '${raw}' is not absolute. An agent is addressed by an absolute path: this ` +
        `daemon runs detached and its working directory belongs to whichever client first ` +
        `spawned it, so resolving a relative path here would answer a different question ` +
        `than the caller asked. Resolve it against your own working directory first.`
    );
  }
  const resolved = path.resolve(raw);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (e: any) {
    throw new PathError(
      `Path '${resolved}' does not exist or could not be resolved (${e?.message ?? String(e)}). ` +
        `CrabCast never creates a directory — create it first, then configure it. ` +
        `Requiring it to exist is what makes the filesystem the typo-checker: every path ` +
        `now comes from the caller, and nothing else here can tell a directory you meant ` +
        `from one you mistyped.`
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (e: any) {
    throw new PathError(`Path '${real}' could not be inspected (${e?.message ?? String(e)}).`);
  }
  if (!stat.isDirectory()) {
    throw new PathError(`Path '${real}' is not a directory. An agent runs in a directory.`);
  }
  return real;
}

/**
 * {@link canonicalPath} for a string that may legitimately fail to resolve —
 * herdr's report of some other pane's `cwd`, above all.
 *
 * `null` means "this could not be canonicalized", which is deliberately NOT
 * the same as "it is not our path": a pane whose cwd cannot be resolved is
 * never treated as an occupant, because our own path provably exists
 * (`configure` required it) and an unresolvable path is therefore not it.
 */
export function canonicalizeOrNull(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    // No absolute-path rule here: this canonicalizes strings herdr reports for
    // OTHER people's panes, which are whatever herdr says they are. A relative
    // one cannot be resolved meaningfully and simply is not an occupant.
    const raw = input.trim();
    return path.isAbsolute(raw) ? fs.realpathSync(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The digest half of a pane name and of a sidecar directory.
 *
 * ONE HASH FOR BOTH, deliberately (the design left this open as "mechanical;
 * pick one and document it"). Two hashes would mean two places to look when
 * matching a pane to its state on disk, and no property is bought by making
 * them differ.
 *
 * See {@link HASH_CHARS} for why it is 16 characters rather than 8: a
 * collision used to cost a shared sidecar and now costs a shared IDENTITY.
 */
export function pathHash(canonical: string): string {
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, HASH_CHARS);
}

/**
 * The herdr agent name for a path: `crabcast-<slug>-<hash8>`.
 *
 * NON-INVERTIBLE BY CONSTRUCTION. The slug is lowercased, collapsed and
 * truncated, and the hash is a digest — there is no function that recovers a
 * path from this string, and none may be written. The slug exists so a human
 * skimming herdr's tab bar can tell agents apart; the hash is what makes the
 * name unique. Anything that needs the path reads it from the durable registry
 * or from the pane's own `cwd`.
 */
export function paneNameFor(canonical: string): string {
  const slug =
    path
      .basename(canonical)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_CHARS) || 'agent';
  return `${PANE_NAME_PREFIX}${slug}-${pathHash(canonical)}`;
}

/**
 * Where CrabCast keeps its own state for an agent: the rendered prompt, and
 * anything later slices add.
 *
 * INSIDE OUR OWN dataDir, and that is the point. The caller's directory now
 * belongs to the caller, so the one place CrabCast may write freely — and, in
 * a later slice, delete freely — is this one. The bootstrap prompt lives here
 * rather than in the agent's cwd for exactly that reason.
 */
export function sidecarDirFor(dataDir: string, canonical: string): string {
  return path.join(dataDir, 'agents', pathHash(canonical));
}
