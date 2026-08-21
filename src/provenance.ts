import { spawnSync } from 'child_process';
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
 *
 * ---------------------------------------------------------------------------
 * AND SINCE KAN-592, A THIRD QUESTION: IS THAT COMMIT ON A RELEASED LINE?
 *
 * The two questions above are both about CONSISTENCY — is the process running
 * the build on disk, is that build newer than `src/`. Both can be true of a
 * build made from a branch nobody merged, and on 2026-08-20 both were: the
 * fleet served `c730a98` for roughly 24 hours while `daemon-status` reported
 * `freshness: CURRENT`, `running the build on disk: yes` and
 * `checkout: clean when this build was made`. Every one of those was TRUE.
 * `c730a98` was on `incident/kan-552-herdr-0.8-port` and on no release line at
 * all, and nothing here asked.
 *
 * That is this epic's recurring shape — an artifact whose sentence claims more
 * than its mechanism covers — sitting inside the instrument built to catch it.
 * `CURRENT` means *consistent with the local checkout*; an operator reads it as
 * *this is a build somebody released*. So the fix is not a fourth line under
 * the greens, which nobody would read. It is a new value of `state`
 * ({@link FreshnessReport.state}'s `off-release-line`), so the HEADLINE stops
 * saying `CURRENT` for a build that is not on a released line.
 *
 * HOW IT IS ANSWERED, AND WHY IT TOUCHES NO NETWORK. `git merge-base
 * --is-ancestor <the commit the stamp names> <a LOCAL ref>`, run in the package
 * root this `dist/` was loaded from. Nothing here fetches, and nothing here may
 * ever fetch: `daemon-status` has to work on a machine with no route out, and a
 * check that reached the network would turn every offline run into a hang or a
 * false answer. The refs it will accept are {@link RELEASE_REF_CANDIDATES}, and
 * the one that answered is named on the wire beside the verdict.
 *
 * WHY IT IS COMPUTED HERE AND NOT STAMPED INTO `dist/`. The commit is
 * immutable, which is what makes stamping it right. "Is it released" is not:
 * the same commit is off the line on Monday and on it on Tuesday. Freezing a
 * time-varying answer into an immutable artifact would be the same defect one
 * layer down — a stamp that goes on asserting Monday's answer for the life of
 * the build.
 *
 * ⚠ THE BOUND, AND IT IS ASYMMETRIC — WHICH IS WHY ONLY ONE BRANCH CARRIES A
 * CAVEAT. The release ref is whatever this clone last fetched, so it can be
 * behind the remote. That does not weaken a `yes`: reachability is monotonic
 * under fast-forward, so a commit reachable from the release tip at any past
 * moment stays reachable from every later one, and a stale ref can only ever
 * make a `yes` late — never wrong. It DOES weaken a `no`: the commit may have
 * landed since the last fetch. So the `no` says so in its own summary and tells
 * the reader to fetch and ask again, and the `yes` does not carry a caveat it
 * has not earned. (The one thing that can retract a `yes` is a history rewrite
 * of the release branch — a force-push — which is a different event and is
 * named in {@link readReleaseLine}.)
 *
 * ⚠ AND "CANNOT TELL" IS A FIRST-CLASS THIRD ANSWER, distinguishable from
 * `yes` and from `no`, for the same reason every other field here is: no `git`
 * on the machine, a `dist`-only install with no working tree, a clone holding
 * none of the candidate refs, a repository that does not contain the commit at
 * all. Each is `onReleaseLine: null` with its reason in the `unknown` map, and
 * each demotes `state` to `unknown` rather than to `current` — because an
 * unanswerable release-line question reporting `CURRENT` is exactly the defect
 * this section exists to remove, recreated one layer down.
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

/**
 * The refs this daemon will read as "the release line", most authoritative
 * first. The first one that RESOLVES is used, and it is named on the wire.
 *
 * All three are LOCAL. Nothing here fetches — see the header — so each is only
 * as current as whoever last ran `git fetch` in that clone, and the verdict
 * says which one it rested on so a reader can judge that for themselves.
 *
 * WHY THESE THREE, IN THIS ORDER:
 *
 *   `refs/remotes/origin/HEAD`  the remote's OWN idea of its default branch,
 *                               so a repository that renames `main` is still
 *                               answered correctly without editing this list.
 *                               Not present in every clone — `git clone` sets
 *                               it, `git init` plus `git remote add` does not.
 *   `refs/remotes/origin/main`  what this repository actually protects and
 *                               merges into. The ordinary answer.
 *   `refs/heads/main`           the local branch, for a clone with no remote
 *                               at all. Weakest of the three, because nothing
 *                               says a local `main` tracks anything — and it
 *                               is last for that reason rather than omitted,
 *                               because a fixture, an air-gapped mirror and a
 *                               fresh `git init` all have only this.
 *
 * ⚠ THIS LIST IS A CLAIM ABOUT WHAT "RELEASED" MEANS HERE, and it is
 * deliberately not configurable. A knob would let a machine be pointed at a ref
 * that makes any build look released, which is the failure this whole check
 * exists to prevent, dressed as a setting. If this repository's release line
 * ever stops being `main`, this constant is the edit — one place, in a diff a
 * reviewer sees.
 */
export const RELEASE_REF_CANDIDATES = [
  'refs/remotes/origin/HEAD',
  'refs/remotes/origin/main',
  'refs/heads/main'
] as const;

/**
 * How long any one `git` invocation below may take before it is abandoned as
 * unanswerable.
 *
 * The same 10s `scripts/stamp-build.mjs` gives its own git calls. These run on
 * a `daemon_status` request rather than at build time, so the bound is doing
 * real work: a repository on a wedged network filesystem must make this command
 * SLOW AND HONEST rather than hung, and a timeout arrives as `onReleaseLine:
 * null` with the reason naming the timeout — never as a `no`.
 */
export const RELEASE_LINE_GIT_TIMEOUT_MS = 10_000;

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

/**
 * Where the running daemon stands relative to what is on disk right now — and,
 * since KAN-592, whether what it is running was ever released.
 */
export interface FreshnessReport {
  /**
   * ⚠ `current` IS THE ONLY CLEAN VALUE AND IT NOW ASSERTS THREE THINGS, not
   * two: the process is running the build on disk, that build is newer than
   * `src/`, AND the commit it was built from is on the release line. Anything
   * short of all three is one of the other four, deliberately — see
   * `off-release-line`, which exists because the first two were true of a
   * fleet running an unmerged incident branch for 24 hours (KAN-592).
   */
  state:
    | 'current'
    | 'process-predates-build'
    | 'build-predates-sources'
    | 'off-release-line'
    | 'unknown';
  /** One sentence a human can act on. Names the state and what to do about it. */
  summary: string;
  /** Is the process executing the build that is on disk? Null when unmeasurable. */
  processIsCurrentBuild: boolean | null;
  /** Is `src/` newer than `dist/`? Null when unmeasurable. */
  sourcesNewerThanBuild: boolean | null;
  /**
   * Is {@link runningCommit} reachable from {@link releaseRefCommit}?
   *
   * `null` is "could not tell" and is NOT a `no`: the reason is in `unknown`
   * under this field's own name, and it demotes `state` to `unknown` rather
   * than letting an unanswered question read as `current`.
   */
  onReleaseLine: boolean | null;
  /** Which of {@link RELEASE_REF_CANDIDATES} answered. Null when none did. */
  releaseRef: string | null;
  /**
   * The commit that ref pointed at — and the object the ancestry test was
   * ACTUALLY run against, so the verdict and this field cannot describe two
   * different tips.
   */
  releaseRefCommit: string | null;
  /** When {@link releaseRefCommit} was committed. Dates the line, not the fetch. */
  releaseRefCommittedAt: string | null;
  /** The working tree the question was asked of. May differ from `build.gitRoot`. */
  releaseLineRepo: string | null;
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

// ---------------------------------------------------------- the release line

/** What {@link readReleaseLine} established, and why it could not. */
export interface ReleaseLineAnswer {
  /** True, false, or null for "could not tell". Never a `false` standing in for null. */
  onReleaseLine: boolean | null;
  ref: string | null;
  refCommit: string | null;
  refCommittedAt: string | null;
  /** The git working tree that answered — `--show-toplevel`, not the path asked. */
  repo: string | null;
  /** Why {@link onReleaseLine} is null. Null exactly when it is not. */
  reason: string | null;
}

/** One local git question. Never a shell, never a fetch, always bounded. */
function git(cwd: string, args: string[]) {
  const run = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: RELEASE_LINE_GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: String(run.stderr ?? '').trim(),
    error: run.error as NodeJS.ErrnoException | undefined
  };
}

/**
 * Turn a git invocation that did not answer into a sentence a reader can act
 * on. The failure shapes are told apart because they send a reader to three
 * different places — the same three `scripts/stamp-build.mjs` distinguishes,
 * for the same reason.
 */
function gitFailureReason(
  run: ReturnType<typeof git>,
  what: string,
  where: string
): string {
  if (run.error?.code === 'ENOENT') {
    return (
      `there is no \`git\` on PATH on the machine this daemon is running on, so ${what} could ` +
      `not be asked of ${where}. NOTHING WAS FETCHED and nothing could have been — this check ` +
      `never reaches the network. A missing \`git\` is a missing ANSWER, not a "no"`
    );
  }
  if (run.error?.code === 'ETIMEDOUT') {
    return (
      `\`git\` did not answer ${what} in ${where} within ${RELEASE_LINE_GIT_TIMEOUT_MS}ms and ` +
      `was abandoned. A repository on a wedged filesystem makes this command slow and honest ` +
      `rather than hung, and an abandoned question is unanswered rather than answered "no"`
    );
  }
  if (run.error) {
    return `\`git\` could not be run in ${where}: ${run.error.message}`;
  }
  if (/not a git repository|does not appear to be a git repository/i.test(run.stderr)) {
    return (
      `${where} is not inside a git working tree, so there is no history to walk and ${what} ` +
      `cannot be asked. A \`dist\`-only install, a tarball or an export looks exactly like ` +
      `this, and none of them is evidence that the build is released`
    );
  }
  return `${what} could not be asked of ${where}: ${run.stderr || `git exited ${run.status}`}`;
}

/**
 * Is `commit` reachable from this clone's release ref?
 *
 * THREE `git` INVOCATIONS, ALL LOCAL AND ALL READ-ONLY: `rev-parse
 * --show-toplevel` to find the tree, `for-each-ref` to resolve the candidates
 * in ONE call, and `merge-base --is-ancestor` for the verdict. No `fetch`, no
 * `ls-remote`, no network of any kind — see this module's header for why that
 * is a rule rather than an optimisation.
 *
 * ⚠ THE ANCESTRY TEST IS RUN AGAINST THE RESOLVED OBJECT, never against the
 * refname. `refs/remotes/origin/HEAD` is a symbolic ref, and testing the name
 * while REPORTING the object would let the two describe different tips if the
 * ref moved between the calls. This way {@link ReleaseLineAnswer.refCommit} is
 * by construction the thing the verdict is about.
 *
 * `builtInGitRoot` is the tree the STAMP says the build was made in, and is
 * used only to write a better sentence when this repository turns out not to
 * contain the commit — the commonest cause of which is that the build came
 * from somewhere else entirely.
 */
export function readReleaseLine(
  packageRoot: string,
  commit: string | null,
  builtInGitRoot: string | null = null
): ReleaseLineAnswer {
  const nothing = (reason: string): ReleaseLineAnswer => ({
    onReleaseLine: null,
    ref: null,
    refCommit: null,
    refCommittedAt: null,
    repo: null,
    reason
  });

  if (!commit) {
    return nothing(
      `the build this process is running names no commit, so there is nothing to look for on ` +
        `the release line. WHY it names none is the \`build\` block's own \`unknown\` map, ` +
        `directly above this one — this field is absent BECAUSE that one is, and repeating its ` +
        `reason here would be a second copy that could disagree with the first`
    );
  }

  const top = git(packageRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) {
    return nothing(gitFailureReason(top, 'whether this build is on the release line', packageRoot));
  }
  const repo = top.stdout.trim();

  // ONE call for every candidate. `for-each-ref` answers about the refs that
  // EXIST and says nothing about the ones that do not, which is exactly the
  // question — and it returns them in refname order rather than in the order
  // they were asked for, so the precedence below is applied here and not
  // inferred from git's output.
  const refs = git(repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)',
    ...RELEASE_REF_CANDIDATES
  ]);
  if (refs.status !== 0) {
    return nothing(gitFailureReason(refs, 'which ref is the release line', repo));
  }

  const resolved = new Map<string, { objectName: string; committedAt: string }>();
  for (const line of refs.stdout.split('\n')) {
    const [refname, objectName, committedAt] = line.split('\t');
    if (refname && objectName) resolved.set(refname, { objectName, committedAt: committedAt ?? '' });
  }

  const ref = RELEASE_REF_CANDIDATES.find((candidate) => resolved.has(candidate)) ?? null;
  if (!ref) {
    return nothing(
      `${repo} holds none of the refs this daemon reads as the release line ` +
        `(${RELEASE_REF_CANDIDATES.join(', ')}), so there is no line to be on or off. A clone ` +
        `that has never fetched \`origin\`, a repository whose remote is named something else, ` +
        `and a shallow single-branch CI checkout all look like this. NOTHING WAS FETCHED to ` +
        `find out — this check never reaches the network, so an absent ref is an absent ANSWER ` +
        `rather than a "no"`
    );
  }

  const tip = resolved.get(ref)!;
  const committedMs = Date.parse(tip.committedAt);
  const refCommittedAt = Number.isFinite(committedMs)
    ? new Date(committedMs).toISOString()
    : null;

  const ancestry = git(repo, ['merge-base', '--is-ancestor', commit, tip.objectName]);
  const evidence = { ref, refCommit: tip.objectName, refCommittedAt, repo };

  // 0 and 1 are `--is-ancestor`'s two ANSWERS; anything else is git declining
  // to answer, and the two must never be collapsed. The commonest decline is
  // exit 128 for a commit this repository has never heard of, which reads as a
  // plain "not an ancestor" to any check that only tests for zero — and would
  // report a released build as unreleased.
  if (ancestry.status === 0) return { onReleaseLine: true, ...evidence, reason: null };
  if (ancestry.status === 1) return { onReleaseLine: false, ...evidence, reason: null };

  if (/not a valid|bad object|unknown revision|no such/i.test(ancestry.stderr)) {
    return {
      onReleaseLine: null,
      ...evidence,
      reason:
        `${repo} does not contain ${commit}, the commit this process was built from, so whether ` +
        `it is on ${ref} cannot be answered here` +
        (builtInGitRoot && builtInGitRoot !== repo
          ? ` — the stamp says this build was made in ${builtInGitRoot}, which is a different ` +
            `tree from the one beside the \`dist/\` that was loaded`
          : ` — the build was made somewhere this repository cannot see, or its history has ` +
            `been rewritten since`) +
        `. Git said: ${ancestry.stderr}`
    };
  }

  return {
    onReleaseLine: null,
    ...evidence,
    reason: gitFailureReason(ancestry, `whether ${commit} is reachable from ${ref}`, repo)
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

  // ------------------------------------- is that commit on a released line?
  //
  // Asked of the RUNNING build's commit — `boot.provenance`, not `now` — for
  // the same reason every other question here is: the thing an operator needs
  // named is what this process is serving, and a `dist/` rebuilt underneath it
  // from a different branch would otherwise have this field describe code that
  // is not executing.
  const releaseLine = readReleaseLine(
    packageRootFor(distDir),
    boot.provenance.commit,
    boot.provenance.gitRoot
  );
  if (releaseLine.reason) unknown.onReleaseLine = releaseLine.reason;

  // ---------------------------------------------------------------- the state
  //
  // Precedence, not a summary: a process that predates the build on disk is
  // the failure a fleet actually hits — every filesystem check reads healthy
  // while the running code is something else — so it is named first when both
  // are true. ALL THREE flags are on the report either way, so nothing is lost
  // to the precedence.
  //
  // `off-release-line` SITS THIRD, AND THAT IS A DECISION (KAN-592). The two
  // above it name a remedy the reader can perform in one command — restart,
  // rebuild — and both are about a tree that is INTERNALLY inconsistent, which
  // is the sharper failure. Being off the release line is a fact about a build
  // that is entirely self-consistent; it is what `current` was silently
  // absorbing, and it displaces `current` rather than the two loud states.
  //
  // ⚠ AND IT IS RANKED ABOVE `current` BUT BELOW `unknown`'s CAUSES BY
  // CONSTRUCTION: the `current` branch requires all three answered and good, so
  // an unanswerable release-line question falls through to `unknown` rather
  // than to `current`. That fall-through is the whole of task 2 on the ticket —
  // an unreachable answer reporting `CURRENT` would recreate the defect this
  // state exists to remove, one layer down.
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
  } else if (releaseLine.onReleaseLine === false) {
    state = 'off-release-line';
    summary =
      `THE RUNNING BUILD IS NOT ON THE RELEASE LINE. This daemon is running the build on disk ` +
      `and that build is consistent with ${sourceDir}, but the commit it was built from ` +
      `(${boot.provenance.commit}) is NOT reachable from ${releaseLine.ref} ` +
      `(${releaseLine.refCommit}) in ${releaseLine.repo} — so what is running here was built ` +
      `from a branch that has not landed. THIS IS NOT A STALENESS PROBLEM AND REBUILDING WILL ` +
      `NOT CLEAR IT: the tree is entirely self-consistent, which is why every other check on ` +
      `this response is green. Find out why that branch is deployed before changing it — ` +
      `checking the tree out onto the release line and rebuilding would change what this daemon ` +
      `serves, with no deploy step and no announcement. NOTHING WAS FETCHED to establish this: ` +
      `${releaseLine.ref} is this clone's own copy, as of whoever last fetched it, so a commit ` +
      `that landed on the remote since then still reads as off the line here. \`git fetch\` and ` +
      `ask again before treating it as final.`;
  } else if (
    processIsCurrentBuild === true &&
    sourcesNewerThanBuild === false &&
    releaseLine.onReleaseLine === true
  ) {
    state = 'current';
    summary =
      `This daemon is running the build that is on disk, that build is newer than ` +
      `${sourceDir}, and the commit it was built from is on the release line ` +
      `(${releaseLine.ref}). Evidence: ${comparison}.`;
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
    if (releaseLine.onReleaseLine === true) {
      known.push(`the commit it was built from is on ${releaseLine.ref}`);
    }
    summary =
      `FRESHNESS UNKNOWN — ` +
      (known.length ? `${known.join(', and ')}. ` : '') +
      // The evidence behind whatever IS known, carried here as well as in the
      // `current` branch (KAN-592). Until this state started being reachable
      // for a build that is perfectly consistent — an unstamped one, which
      // names no commit and so cannot be placed on the release line — the
      // `file-times` fallback's bound sentence appeared ONLY under `current`,
      // and demoting that build silently deleted the one clause telling a
      // reader what "running the build on disk: yes" was resting on. A state
      // that reports less about what it DID establish is a worse answer, not a
      // more cautious one.
      (comparison ? `Evidence for what is known: ${comparison}. ` : '') +
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
      onReleaseLine: releaseLine.onReleaseLine,
      releaseRef: releaseLine.ref,
      releaseRefCommit: releaseLine.refCommit,
      releaseRefCommittedAt: releaseLine.refCommittedAt,
      releaseLineRepo: releaseLine.repo,
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
