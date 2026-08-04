#!/usr/bin/env node
// Writes `dist/build-stamp.json` — what this build was made from (KAN-122).
//
// Wired as npm's `postbuild`, so `npm run build` stamps and a bare `tsc` does
// not. That asymmetry is deliberate: an unstamped build must be possible, and
// must report UNKNOWN rather than something plausible, because that is exactly
// what an install with no git metadata looks like and the daemon has to be
// honest about it (see src/provenance.ts).
//
// Usage:
//   node scripts/stamp-build.mjs [distDir]      # default: <repo>/dist
//
// The optional argument exists for the verify script, which builds fixture
// trees elsewhere and needs each stamped as if it had been built in place.
// Every git question below is asked of the PACKAGE ROOT beside that `dist/`,
// never of this script's own location or of the cwd, so stamping a copied tree
// asks about the copied tree.
//
// THIS SCRIPT NEVER GUESSES. Every field it cannot establish is written as
// null with a reason recorded beside it in `unknown`, and the daemon renders
// those reasons rather than a blank. No git binary, no `.git`, a detached
// HEAD that will not resolve — each is an answer, and none of them is "clean".
//
// It fails the build only if it cannot WRITE the stamp. A tree with no git in
// it is a supported case, not an error.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));
const packageRoot = path.dirname(distDir);

if (!fs.existsSync(distDir)) {
  console.error(
    `stamp-build: ${distDir} does not exist. This runs after \`tsc\` (npm postbuild) and ` +
      `stamps the output it produced; there is nothing here to stamp.`
  );
  process.exit(1);
}

// The one definition of the filename and the format version, imported from the
// build this script has just stamped rather than copied into a second constant
// here. A copy is the thing that is wrong the day the reader changes.
const { BUILD_STAMP_FILENAME, BUILD_STAMP_VERSION } = await import(
  path.join(distDir, 'provenance.js')
);

/**
 * One git question, answered or explained.
 *
 * The three failure shapes are told apart because they send a reader to three
 * different places: no binary is a machine problem, "not a working tree" is an
 * ordinary export or tarball, and anything else is git itself objecting.
 */
function git(args) {
  try {
    return {
      value: execFileSync('git', ['-C', packageRoot, ...args], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      reason: null
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        value: null,
        reason:
          `there is no \`git\` on PATH on the machine that built this, so nothing could be ` +
          `asked about ${packageRoot}`
      };
    }
    const stderr = String(err?.stderr ?? '').trim();
    if (/not a git repository|does not appear to be a git repository/i.test(stderr)) {
      return {
        value: null,
        reason:
          `${packageRoot} is not inside a git working tree — a tarball, an export or a copy ` +
          `carries no commit to report`
      };
    }
    return {
      value: null,
      reason: `\`git ${args.join(' ')}\` failed in ${packageRoot}: ${stderr || err?.message || String(err)}`
    };
  }
}

const unknown = {};

const head = git(['rev-parse', 'HEAD']);
const commit = head.value ? head.value.trim() : null;
if (!commit) unknown.commit = head.reason ?? '`git rev-parse HEAD` produced nothing';

// `--porcelain` and nothing else: tracked modifications and untracked files
// both count, because either can change what `tsc` just compiled. `dist/` and
// `node_modules/` are gitignored, so building does not make the tree look dirty
// to this check.
//
// Asked ONLY when HEAD resolved. A tree with no commit has no "clean" to
// report, and answering `clean: true` for it would be the exact fabrication
// this file exists to avoid — an empty `git status` in a directory git refuses
// to look at is not evidence of anything.
let clean = null;
if (commit) {
  const status = git(['status', '--porcelain']);
  if (status.value === null) {
    unknown.clean = status.reason ?? '`git status --porcelain` failed';
  } else {
    clean = status.value.trim().length === 0;
  }
} else {
  unknown.clean =
    `whether the checkout was clean was not asked, because HEAD did not resolve: ` +
    `${head.reason ?? 'no commit'}`;
}

const top = git(['rev-parse', '--show-toplevel']);
const gitRoot = top.value ? top.value.trim() : null;
if (!gitRoot) unknown.gitRoot = top.reason ?? '`git rev-parse --show-toplevel` produced nothing';

const stamp = {
  stampVersion: BUILD_STAMP_VERSION,
  commit,
  clean,
  builtAt: new Date().toISOString(),
  gitRoot,
  unknown
};

const stampPath = path.join(distDir, BUILD_STAMP_FILENAME);
try {
  fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
} catch (err) {
  console.error(`stamp-build: could not write ${stampPath}: ${err?.message ?? String(err)}`);
  process.exit(1);
}

const describe = commit
  ? `${commit.slice(0, 12)} (${clean === true ? 'clean' : clean === false ? 'DIRTY' : 'cleanliness unknown'})`
  : 'UNKNOWN commit';
console.log(`stamp-build: ${stampPath} — ${describe}, built ${stamp.builtAt}`);
for (const [field, reason] of Object.entries(unknown)) {
  console.log(`stamp-build:   ${field} is unknown — ${reason}`);
}
