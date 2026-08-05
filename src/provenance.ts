import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * What the RUNNING PROCESS was built from — and whether it still matches the
 * tree it was built from (KAN-122).
 *
 * WHY THIS EXISTS. CrabCast is consumed as `file:../crabcast`: a linked local
 * checkout, no published artifact, no version string, and — by the consumer's
 * own decision — no pinned commit on their side either. So when a fleet
 * misbehaves, "which CrabCast is running?" had no answer at all. `daemon_status`
 * answered `startedAt`, which dates the PROCESS and says nothing about the CODE.
 *
 * WHY IT CANNOT BE ANSWERED FROM THE FILESYSTEM ALONE, which is the whole
 * point. A consumer can read our checkout themselves — commit, dirty, `dist/`
 * against `src/` — and ours does. What no amount of looking at the disk can
 * tell them is what the process that is currently serving them was loaded
 * from: a daemon started before a rebuild is still executing the old `dist/`,
 * while the checkout on disk has moved on and looks perfectly current. Every
 * filesystem check says fine; the fleet misbehaves anyway. Only the process
 * knows, because only the process knows when it was loaded.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS OBTAINED, AND WHY THIS WAY
 *
 * A JSON stamp emitted into `dist/` at build time (`scripts/stamp-build.mjs`,
 * wired as npm's `postbuild`), read ONCE at daemon boot, out of the very
 * directory this module was loaded from.
 *
 * Three alternatives were on the table and each fails a case this one gets
 * right:
 *
 *   - READ `git` AT BOOT. Answers "what does the checkout say right now",
 *     which is a different question. Commit on top of a `dist/` nobody
 *     rebuilt, restart the daemon, and it reports the new commit while
 *     executing the old code — a confident, plausible lie, and precisely the
 *     failure this ticket exists to remove. It also spawns a process on a
 *     path that must work on a machine with no git.
 *
 *   - BAKE A CONSTANT INTO A GENERATED `.ts`. Puts a build artifact in `src/`,
 *     which dirties the tree the stamp is trying to describe, and makes
 *     `git status --porcelain` report a change caused by the act of building.
 *
 *   - STAMP NOTHING AND COMPARE mtimes ONLY. Answers freshness but never
 *     identity: it can say "you are not running what is on disk" and never
 *     "you are running 5657bfb".
 *
 * The stamp travels inside `dist/` — the same directory that holds the code it
 * describes — so a copied, moved or relinked build carries its own provenance,
 * and `import.meta.url` resolution below means the answer is about the `dist/`
 * that was actually loaded rather than about whatever tree happens to be the
 * cwd.
 *
 * ABSENT DATA STAYS ABSENT. Every field is `null` with a recorded reason when
 * it could not be determined: no stamp (someone ran `tsc` directly), no `.git`
 * (a tarball or an export), no `git` binary. `null` is never rendered as a
 * default and must never be mistakable for "clean" — see the `unknown` maps,
 * which name the field and say why, and are what the CLI prints instead of a
 * blank line.
 *
 * AND THE STAMP ITSELF IS DISTRUSTED WHEN THE CODE BESIDE IT IS NEWER. `tsc`
 * run by hand rewrites `dist/*.js` and leaves the previous stamp sitting
 * there, at which point the stamp names a commit the loaded code does not come
 * from. That is caught here (see {@link STAMP_STALENESS_TOLERANCE_MS}) and
 * demoted to `unknown`, because a stamp that is confidently wrong is worse
 * than no stamp at all.
 */

/** The stamp file `scripts/stamp-build.mjs` writes, inside `dist/`. */
export const BUILD_STAMP_FILENAME = 'build-stamp.json';

/**
 * The stamp format this daemon can read.
 *
 * A stamp from a future version is read as UNKNOWN rather than best-effort:
 * the fields are the whole product here, and guessing at a shape whose meaning
 * has changed is the same class of error as reporting "clean" for a build
 * nothing was known about.
 */
export const BUILD_STAMP_VERSION = 1;

/**
 * How far `dist/` may be newer than its own stamp before the stamp is
 * disbelieved.
 *
 * The stamp is written after `tsc` has finished, so in a stamped build every
 * compiled file is OLDER than `builtAt`. A compiled file that is newer means
 * something rewrote `dist/` without re-stamping — `tsc` or `npx tsc` run
 * directly, which is a perfectly ordinary thing to do — and the stamp beside
 * it now describes a build that no longer exists.
 *
 * Two seconds rather than zero: `builtAt` comes from the clock and mtimes come
 * from the filesystem, and coarse mtime granularity (HFS+ at 1s, some network
 * filesystems worse) would otherwise make a perfectly good build accuse itself.
 */
export const STAMP_STALENESS_TOLERANCE_MS = 2000;

/** The on-disk stamp, exactly as written. */
export interface BuildStampFile {
  stampVersion: number;
  commit: string | null;
  clean: boolean | null;
  builtAt: string | null;
  gitRoot: string | null;
  /** field name → why that field is null. Empty when everything is known. */
  unknown: Record<string, string>;
}

/** What one `dist/` (or `src/`) looked like at one instant. */
export interface DirFingerprint {
  dir: string;
  /** Regular files found, at any depth. */
  files: number;
  newestFile: string | null;
  newestAt: string | null;
  /** Epoch ms of {@link newestAt}; the field the comparisons actually use. */
  newestMs: number | null;
  /** Why this directory could not be read. Null when it was. */
  error: string | null;
}

/** The provenance of one build, as read out of its own `dist/`. */
export interface BuildProvenance {
  /** The commit `dist/` was built at, or null. Never abbreviated. */
  commit: string | null;
  /** Whether that checkout was clean AT BUILD TIME, or null. */
  clean: boolean | null;
  builtAt: string | null;
  /** The git working tree the build was made in, for the "built where" question. */
  gitRoot: string | null;
  /** The `dist/` this answer is about — the one the process loaded. */
  distDir: string;
  stampPath: string;
  /** Is there a stamp file at all? */
  stampPresent: boolean;
  /**
   * Was it believed? Present-and-not-believed is its own situation — a stamp
   * whose `dist/` was rewritten under it, or one from a format this daemon
   * does not read — and reporting it as merely absent would hide the fact that
   * there is a file sitting there naming a commit, which is what a person
   * looking at the directory will see.
   */
  stampUsable: boolean;
  /** When this snapshot was taken. For the boot snapshot, the daemon's boot. */
  readAt: string;
  /** field name → why it is null. EMPTY MEANS KNOWN; non-empty is not "clean". */
  unknown: Record<string, string>;
}

/** A `dist/` and its stamp, frozen at one instant. */
export interface BuildSnapshot {
  provenance: BuildProvenance;
  /** Everything in `dist/`, including the stamp: what a rebuild changes. */
  dist: DirFingerprint;
  /** `dist/` minus the stamp: the compiled code the stamp claims to describe. */
  code: DirFingerprint;
}

/** Where the running daemon stands relative to what is on disk right now. */
export interface FreshnessReport {
  state: 'current' | 'process-predates-build' | 'build-predates-sources' | 'unknown';
  /** One sentence a human can act on. Names the state and what to do about it. */
  summary: string;
  /** Is the process executing the build that is on disk? Null when unmeasurable. */
  processIsCurrentBuild: boolean | null;
  /** Is `src/` newer than `dist/`? Null when unmeasurable. */
  sourcesNewerThanBuild: boolean | null;
  /** What the process-against-disk comparison actually rested on. */
  basis: 'build-stamp' | 'file-times' | 'none';
  /** The build this process is executing (from the boot stamp). */
  runningBuiltAt: string | null;
  runningCommit: string | null;
  /** The build that is on disk NOW. Differs from the above in state (b). */
  onDiskBuiltAt: string | null;
  onDiskCommit: string | null;
  distNewestAt: string | null;
  sourceDir: string;
  sourceNewestAt: string | null;
  sourceNewestFile: string | null;
  /** field name → why it is null. Same rule as everywhere else here. */
  unknown: Record<string, string>;
}

// ---------------------------------------------------------------- the scan

interface ScannedFile {
  rel: string;
  mtimeMs: number;
}

/**
 * Every regular file under `dir`, with its mtime. Recursive, because nothing
 * says `dist/` stays flat, and a nested output directory whose files this
 * missed would make a rebuild invisible to the comparison below.
 */
function scanDir(dir: string): { files: ScannedFile[]; error: string | null } {
  const files: ScannedFile[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Symlinks are followed by `statSync`, deliberately: a linked build is
      // still the build this process loaded, and its mtime is the one that
      // changes when it is rebuilt.
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      try {
        files.push({ rel: childRel, mtimeMs: fs.statSync(childAbs).mtimeMs });
      } catch {
        // A file that vanished mid-scan. Skipping it is right — it is not part
        // of the build any more — and it is not worth failing the whole read.
      }
    }
  };
  try {
    walk(dir, '');
  } catch (err: any) {
    return { files, error: err?.message ?? String(err) };
  }
  return { files, error: null };
}

function fingerprintOf(dir: string, files: ScannedFile[], error: string | null): DirFingerprint {
  let newest: ScannedFile | null = null;
  for (const f of files) {
    if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
  }
  return {
    dir,
    files: files.length,
    newestFile: newest ? newest.rel : null,
    newestAt: newest ? new Date(newest.mtimeMs).toISOString() : null,
    newestMs: newest ? newest.mtimeMs : null,
    error
  };
}

/** A directory read on its own — used for `src/`, which has no stamp. */
export function fingerprintDir(dir: string): DirFingerprint {
  const scan = scanDir(dir);
  return fingerprintOf(dir, scan.files, scan.error);
}

// -------------------------------------------------------------- the stamp

/**
 * The `dist/` this module was loaded from.
 *
 * From `import.meta.url` rather than from the cwd or from `process.argv`: the
 * daemon is spawned detached by whichever client needed it first, so its cwd
 * belongs to some other shell from some other day, and the only directory that
 * answers "what was I loaded from" is this file's own.
 */
export function loadedDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The package root beside a `dist/` — where `src/` and `.git` would be. */
export function packageRootFor(distDir: string): string {
  return path.dirname(distDir);
}

/** Where `src/` would be for a given `dist/`. Absent in a dist-only install. */
export function sourceDirFor(distDir: string): string {
  return path.join(packageRootFor(distDir), 'src');
}

/**
 * Read `dist/build-stamp.json`, and answer `unknown` for anything it does not
 * establish — including when the stamp is present but the code beside it is
 * newer, which means it describes a build that has been overwritten.
 */
function readStamp(
  distDir: string,
  code: DirFingerprint
): { stamp: BuildStampFile | null; provenance: Omit<BuildProvenance, 'readAt'> } {
  const stampPath = path.join(distDir, BUILD_STAMP_FILENAME);
  /**
   * Nothing known, and why.
   *
   * `present` is carried separately from usability throughout: a stamp file
   * that exists and was disbelieved is a different thing to explain to whoever
   * is standing in that directory looking at it.
   */
  const unusable = (
    reason: string,
    present: boolean
  ): { stamp: null; provenance: Omit<BuildProvenance, 'readAt'> } => ({
    stamp: null,
    provenance: {
      commit: null,
      clean: null,
      builtAt: null,
      gitRoot: null,
      distDir,
      stampPath,
      stampPresent: present,
      stampUsable: false,
      // `gitRoot` is in this map for the same reason the other three are: the
      // CLI renders it with `knownOrUnknown` (KAN-170 item 10), so a null one
      // now prints the word UNKNOWN, and an UNKNOWN with no reason underneath
      // it is precisely the silent blank this module exists to prevent. It
      // used to be omitted here, which was invisible only because the CLI
      // dropped the line entirely.
      unknown: { commit: reason, clean: reason, builtAt: reason, gitRoot: reason }
    }
  });

  let raw: string;
  try {
    raw = fs.readFileSync(stampPath, 'utf8');
  } catch (err: any) {
    const missing = err?.code === 'ENOENT';
    return unusable(
      missing
        ? `there is no ${BUILD_STAMP_FILENAME} in ${distDir}. It is written by ` +
          `\`npm run build\` (postbuild → scripts/stamp-build.mjs); a \`tsc\` run by hand ` +
          `produces an honestly unstamped build, and this is what that looks like.`
        : `${stampPath} could not be read: ${err?.message ?? String(err)}`,
      !missing
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return unusable(`${stampPath} is not readable JSON: ${err?.message ?? String(err)}`, true);
  }

  if (parsed?.stampVersion !== BUILD_STAMP_VERSION) {
    return unusable(
      `${stampPath} is stamp version ${JSON.stringify(parsed?.stampVersion)}, and this daemon ` +
        `reads version ${BUILD_STAMP_VERSION}. Read as unknown rather than guessed at.`,
      true
    );
  }

  // The stamp is written last, after `tsc` has emitted everything. Compiled
  // output that is NEWER than the stamp means `dist/` was rebuilt without
  // re-stamping, so the commit in this file is not the commit the loaded code
  // came from. Demoted rather than reported: a confidently wrong provenance is
  // worse than an absent one.
  const builtAtMs = parsed.builtAt ? Date.parse(parsed.builtAt) : NaN;
  if (
    Number.isFinite(builtAtMs) &&
    code.newestMs !== null &&
    code.newestMs > builtAtMs + STAMP_STALENESS_TOLERANCE_MS
  ) {
    return unusable(
      `${stampPath} says the build was made at ${parsed.builtAt}, but ${code.newestFile} beside ` +
        `it was written at ${new Date(code.newestMs).toISOString()} — later. Something rewrote ` +
        `${distDir} without re-stamping it (\`tsc\` run directly does exactly this), so the ` +
        `stamp describes a build that is no longer there. Run \`npm run build\`.`,
      true
    );
  }

  const unknown: Record<string, string> = {
    ...(parsed.unknown && typeof parsed.unknown === 'object' ? parsed.unknown : {})
  };
  const commit = typeof parsed.commit === 'string' ? parsed.commit : null;
  const clean = typeof parsed.clean === 'boolean' ? parsed.clean : null;
  const builtAt = typeof parsed.builtAt === 'string' ? parsed.builtAt : null;
  const gitRoot = typeof parsed.gitRoot === 'string' ? parsed.gitRoot : null;

  // A null field with no reason recorded beside it would render as a blank —
  // which is the one thing that must never happen here. Fill the gap rather
  // than let the field go quiet.
  const unexplained = `the stamp recorded no value for this and gave no reason (${stampPath})`;
  if (commit === null && !unknown.commit) unknown.commit = unexplained;
  if (clean === null && !unknown.clean) unknown.clean = unexplained;
  if (builtAt === null && !unknown.builtAt) unknown.builtAt = unexplained;
  if (gitRoot === null && !unknown.gitRoot) unknown.gitRoot = unexplained;

  return {
    stamp: { stampVersion: parsed.stampVersion, commit, clean, builtAt, gitRoot, unknown },
    provenance: {
      commit,
      clean,
      builtAt,
      gitRoot,
      distDir,
      stampPath,
      stampPresent: true,
      stampUsable: true,
      unknown
    }
  };
}

/**
 * Freeze one `dist/` and its stamp.
 *
 * Called once by the daemon at boot — that snapshot is the answer to "what is
 * this process running" for the rest of its life — and again on each status
 * request, to see what is on disk now. The two are compared in
 * {@link buildProvenanceReport}.
 */
export function snapshotBuild(distDir: string = loadedDistDir()): BuildSnapshot {
  const scan = scanDir(distDir);
  const dist = fingerprintOf(distDir, scan.files, scan.error);
  const code = fingerprintOf(
    distDir,
    scan.files.filter((f) => f.rel !== BUILD_STAMP_FILENAME),
    scan.error
  );
  const { provenance } = readStamp(distDir, code);
  return {
    provenance: { ...provenance, readAt: new Date().toISOString() },
    dist,
    code
  };
}

// ----------------------------------------------------------- the comparison

/** Do two snapshots describe the same build? */
function sameBuild(
  boot: BuildSnapshot,
  now: BuildSnapshot
): { same: boolean; basis: 'build-stamp' | 'file-times'; why: string } {
  const bp = boot.provenance;
  const np = now.provenance;

  // A stamp on both sides is the strongest evidence available: it identifies
  // the build rather than merely dating it, so a rebuild that happened to
  // reproduce the same mtimes still shows up.
  if (bp.stampUsable && np.stampUsable) {
    const same = bp.commit === np.commit && bp.clean === np.clean && bp.builtAt === np.builtAt;
    return {
      same,
      basis: 'build-stamp',
      why: same
        ? `the stamp in ${np.distDir} (built ${np.builtAt}) is the one this process read at boot`
        : `the stamp in ${np.distDir} has changed since boot ` +
          `(${bp.commit ?? 'unknown commit'} built ${bp.builtAt ?? 'unknown'} → ` +
          `${np.commit ?? 'unknown commit'} built ${np.builtAt ?? 'unknown'})`
    };
  }

  // One side stamped and the other not is a change by itself — the stamp was
  // added or removed under a live daemon — and must not fall through to a
  // mtime comparison that could call it unchanged.
  if (bp.stampUsable !== np.stampUsable) {
    return {
      same: false,
      basis: 'build-stamp',
      why: bp.stampUsable
        ? `this process booted from a build whose stamp could be read, and the stamp in ` +
          `${np.distDir} can no longer be read or believed`
        : `this process booted from a build with no usable stamp, and ${np.distDir} now has one`
    };
  }

  // THE FALLBACK, AND THE BOUND IT CARRIES (KAN-170 item 11). Newest-mtime
  // equality plus file count is what is left when neither side has a usable
  // stamp, and it answers a weaker question than the stamped path above: it
  // cannot tell "nobody rebuilt this" from "somebody rebuilt it and the result
  // happened to land on the same newest mtime with the same number of files".
  // A rebuild inside one mtime tick, or one whose output was restored from a
  // tarball that preserved times, reads as the same build. That is not fixed
  // here — this is the fallback and it stays the fallback — but the `why`
  // below says it out loud, so a reader who acts on "same build" knows what
  // that sentence is resting on. `basis: 'file-times'` was already on the
  // reply; it named the evidence without naming what the evidence cannot see.
  const bootMs = boot.dist.newestMs;
  const nowMs = now.dist.newestMs;
  const same =
    bootMs !== null && nowMs !== null && bootMs === nowMs && boot.dist.files === now.dist.files;
  return {
    same,
    basis: 'file-times',
    why: same
      ? `no stamp to compare, but ${now.dist.dir} holds the same ${now.dist.files} file(s) with ` +
        `the same newest write (${now.dist.newestAt}) as at boot — unchanged as far as file times ` +
        `can tell, which cannot distinguish this from a rebuild that reproduced both the file ` +
        `count and the newest mtime`
      : `no stamp to compare; ${now.dist.dir} has changed since boot ` +
        `(${boot.dist.files} file(s) newest ${boot.dist.newestAt} → ` +
        `${now.dist.files} file(s) newest ${now.dist.newestAt})`
  };
}

/**
 * The two questions `daemon_status` grew for KAN-122, answered together:
 * what this process was built from, and whether that is still what is on disk.
 *
 * `boot` is the snapshot the daemon took when it started — it must be handed
 * in rather than recomputed, because recomputing it here would read the tree as
 * it is NOW and lose the only fact this whole module exists to keep.
 */
export function buildProvenanceReport(boot: BuildSnapshot): {
  build: BuildProvenance;
  freshness: FreshnessReport;
} {
  const distDir = boot.provenance.distDir;
  const now = snapshotBuild(distDir);
  const sourceDir = sourceDirFor(distDir);
  const src = fingerprintDir(sourceDir);
  const unknown: Record<string, string> = {};

  // ------------------------------------------------ is this the build on disk?
  let processIsCurrentBuild: boolean | null = null;
  let basis: 'build-stamp' | 'file-times' | 'none' = 'none';
  let comparison = '';

  if (boot.dist.error) {
    unknown.processIsCurrentBuild =
      `the boot snapshot of ${distDir} failed (${boot.dist.error}), so there is nothing to ` +
      `compare today's tree against`;
  } else if (now.dist.error) {
    unknown.processIsCurrentBuild =
      `${distDir} cannot be read now (${now.dist.error}), so whether this process is running ` +
      `what is there is unanswerable — the build it was loaded from may simply be gone`;
  } else if (boot.dist.newestMs === null || now.dist.newestMs === null) {
    unknown.processIsCurrentBuild =
      `${distDir} held no files to compare (boot: ${boot.dist.files}, now: ${now.dist.files})`;
  } else {
    const verdict = sameBuild(boot, now);
    processIsCurrentBuild = verdict.same;
    basis = verdict.basis;
    comparison = verdict.why;
  }

  // ------------------------------------------- is the build older than src/?
  let sourcesNewerThanBuild: boolean | null = null;
  if (src.error) {
    unknown.sourcesNewerThanBuild =
      `${sourceDir} could not be read (${src.error}) — a dist-only install has no sources to ` +
      `compare against, and an unread directory is not evidence of a current build`;
  } else if (src.newestMs === null) {
    unknown.sourcesNewerThanBuild = `${sourceDir} holds no files, so there is nothing to compare`;
  } else if (now.dist.newestMs === null) {
    unknown.sourcesNewerThanBuild =
      `${distDir} holds no files to date the build by, so `+
      `"are the sources newer" has no left-hand side`;
  } else {
    sourcesNewerThanBuild = src.newestMs > now.dist.newestMs;
  }

  // ---------------------------------------------------------------- the state
  //
  // Precedence, not a summary: a process that predates the build on disk is
  // the failure a fleet actually hits — every filesystem check reads healthy
  // while the running code is something else — so it is named first when both
  // are true. BOTH flags are on the report either way, so nothing is lost to
  // the precedence.
  let state: FreshnessReport['state'];
  let summary: string;

  const runningBuild = boot.provenance.builtAt ?? boot.dist.newestAt ?? '(unknown)';
  const diskBuild = now.provenance.builtAt ?? now.dist.newestAt ?? '(unknown)';

  if (processIsCurrentBuild === false) {
    state = 'process-predates-build';
    summary =
      `THE RUNNING DAEMON IS NOT THE BUILD ON DISK. ${distDir} was rebuilt after this process ` +
      `loaded it, and the process is still executing what it read at boot (${runningBuild}); ` +
      `the build on disk is ${diskBuild}. Nothing on the filesystem shows this — restart the ` +
      `daemon to pick the new build up.` +
      (sourcesNewerThanBuild === true
        ? ` The build on disk is itself older than ${sourceDir}, so build again before restarting.`
        : '');
  } else if (sourcesNewerThanBuild === true) {
    state = 'build-predates-sources';
    summary =
      `THE BUILD IS OLDER THAN ITS SOURCES. ${sourceDir} has changed since ${distDir} was built ` +
      `(newest source ${src.newestFile} at ${src.newestAt}, newest build output ` +
      `${now.dist.newestAt}). This daemon is running the build that is on disk, but that build ` +
      `does not include those edits. Run \`npm run build\`, then restart the daemon.`;
  } else if (processIsCurrentBuild === true && sourcesNewerThanBuild === false) {
    state = 'current';
    summary =
      `This daemon is running the build that is on disk, and that build is newer than ` +
      `${sourceDir}. Evidence: ${comparison}.`;
  } else {
    // Deliberately NOT 'current'. One of the two questions could not be
    // answered, and a check that reports success when it could not run is
    // worse than no check.
    state = 'unknown';
    const known: string[] = [];
    if (processIsCurrentBuild === true) {
      known.push('this daemon is running the build that is on disk');
    }
    if (sourcesNewerThanBuild === false) {
      known.push(`that build is newer than ${sourceDir}`);
    }
    summary =
      `FRESHNESS UNKNOWN — ` +
      (known.length ? `${known.join(', and ')}. ` : '') +
      `What could not be answered: ` +
      Object.values(unknown).join('; ') +
      `. This is not a clean bill of health: it is the part of the question that could not be ` +
      `answered here.`;
  }

  return {
    build: boot.provenance,
    freshness: {
      state,
      summary,
      processIsCurrentBuild,
      sourcesNewerThanBuild,
      basis,
      runningBuiltAt: boot.provenance.builtAt,
      runningCommit: boot.provenance.commit,
      onDiskBuiltAt: now.provenance.builtAt,
      onDiskCommit: now.provenance.commit,
      distNewestAt: now.dist.newestAt,
      sourceDir,
      sourceNewestAt: src.newestAt,
      sourceNewestFile: src.newestFile,
      unknown
    }
  };
}
