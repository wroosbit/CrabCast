#!/usr/bin/env node
// KAN-392: the `claude` launcher's folder-trust write follows `$HOME` — from
// BOTH of its call sites — so redirecting HOME is a real isolation and not a
// hopeful one.
//
// WHAT FAILURE THIS WOULD CATCH: `claudeConfigPath()` ceasing to resolve from
// `os.homedir()`, or one of the two trust call sites acquiring a path of its
// own. Either would leave `scripts/run-verify.mjs` and
// `.github/workflows/ci.yml` setting a `HOME` that nothing consults — every
// proof writing folder-trust entries into the operator's real `~/.claude.json`
// while both mechanisms reported that they had prevented exactly that. The
// runner refuses to start when it sees this (its §0), but only for whoever runs
// the runner; this file is the half that goes red for everybody.
//
// ---------------------------------------------------------------------------
// WHY BOTH CALL SITES, NAMED SEPARATELY
// ---------------------------------------------------------------------------
//
// KAN-392's ticket named one: `setup`. There are two. `preSpawnCheck` also
// calls `trustClaudeWorkspace(workDir)` with no `configPath`, and it runs later
// — as late as the daemon can run anything before the spawn. A fix that
// threaded a scratch path into `setup` alone would leave the spawn path writing
// to the real config, and every measurement taken at `setup` would say the
// problem was solved.
//
// So §2 and §3 drive them SEPARATELY, with DIFFERENT work directories. That is
// not tidiness: with one directory, the second call would find the first call's
// entry already true, return `attempts: 0` without writing, and the section
// would pass having exercised nothing. Two directories is what makes §3 a claim
// about `preSpawnCheck` rather than a claim about §2.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER
// ---------------------------------------------------------------------------
//
// It says the write FOLLOWS `$HOME`. It does not say anybody redirects it. Two
// tracked proofs deliberately run under the operator's real `$HOME` and must
// keep doing so — `verify-interrupt-at-dialog-live` and
// `verify-send-confirms-delivery-live`, both of which start a real `claude`
// that reads its credentials from there — and nothing here or anywhere else
// holds the remaining hand-run routes to using the runner. That gap is named on
// KAN-392 and in `scripts/run-verify.mjs`'s header; this file does not close it
// and does not imply it is closed.
//
// It also touches no real config. It reads `~/.claude.json`'s key COUNT before
// and after itself (§5) and never its contents — see
// `scripts/claude-config-residue.mjs` for why counting is the whole discipline.
//
// Needs the compiled build and nothing else: no daemon, no herdr, no network.
//
// Usage:
//   npm run build
//   node scripts/verify-trust-write-follows-home.mjs [distDir]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeMutator, FIX_THE_MUTATION } from './mutation.mjs';
import { mintedPrefixes, residueAt } from './claude-config-residue.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};
const finish = () => {
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
};

if (!fs.existsSync(path.join(distDir, 'launchers.js'))) {
  // A setup guard, not a verdict: there is nothing to measure.
  console.error(`no build at ${distDir} — run \`npm run build\` first`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan392-trusthome-'));
const realHome = process.env.HOME;
const realConfig = path.join(os.homedir(), '.claude.json');
const detector = mintedPrefixes(repoRoot);
const before = residueAt(realConfig, detector);

// ===========================================================================
// 1. The redirect reaches the SHIPPED path.
//
//    Everything after this asserts about a file at a path the build chose. If
//    the build had stopped choosing it from $HOME, those sections would still
//    pass — against the real config — so this one runs first and stops the run.
// ===========================================================================

console.log('=== 1. the shipped claudeConfigPath() answers from $HOME ===\n');

const scratchHome = path.join(tmp, 'home');
fs.mkdirSync(scratchHome, { recursive: true });
process.env.HOME = scratchHome;

const launchers = await import(pathToFileURL(path.join(distDir, 'launchers.js')).href);
const { claudeConfigPath, trustKeyFor, AGENT_LAUNCHERS } = launchers;
const scratchConfig = claudeConfigPath();

console.log(`  real HOME:    ${realHome}`);
console.log(`  scratch HOME: ${scratchHome}`);
console.log(`  it answers:   ${scratchConfig}\n`);

const redirected =
  scratchConfig.startsWith(scratchHome + path.sep) &&
  path.resolve(scratchConfig) !== path.resolve(realHome ?? '/nonexistent', '.claude.json');
check(
  redirected,
  'claudeConfigPath() resolves INSIDE this run\'s scratch home',
  redirected
    ? 'so the two call sites below write where this script can see them, and nowhere else'
    : `it answers ${scratchConfig}. REFUSING TO CONTINUE: the sections below would drive real ` +
      `trust writes at a path this script does not own.`
);
if (!redirected) finish();

/** Trust keys present in one config. Counts and membership only — never printed. */
const trustedIn = (file, workDir) => {
  if (!fs.existsSync(file)) return false;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return cfg.projects?.[trustKeyFor(workDir)]?.hasTrustDialogAccepted === true;
};
const keyCount = (file) =>
  fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}).length : 0;

const claude = AGENT_LAUNCHERS.claude;
check(typeof claude?.setup === 'function', 'the claude launcher has a setup');
check(typeof claude?.preSpawnCheck === 'function', 'the claude launcher has a preSpawnCheck');
if (typeof claude?.setup !== 'function' || typeof claude?.preSpawnCheck !== 'function') finish();

// ===========================================================================
// 2. Call site one: `setup`.
// ===========================================================================

console.log('\n=== 2. setup writes into the redirected config ===\n');

const dirSetup = path.join(tmp, 'work-setup');
fs.mkdirSync(dirSetup, { recursive: true });

check(!trustedIn(scratchConfig, dirSetup), 'before: the scratch config has no entry for this directory');

const notes = [];
claude.setup({ workDir: dirSetup, mcpServers: {}, note: (a) => notes.push(a) });

check(trustedIn(scratchConfig, dirSetup), 'after: the scratch config has one', `keys now: ${keyCount(scratchConfig)}`);
const trustNote = notes.find((n) => n.kind === 'folder-trust');
check(!!trustNote, 'setup declared a folder-trust artifact');
check(
  trustNote?.file === scratchConfig,
  'and the file it declares is the redirected one',
  trustNote ? `declared ${trustNote.file}` : ''
);
check(trustNote?.wroteIt === true, 'and it says CrabCast wrote the entry rather than finding it');

// ===========================================================================
// 3. Call site two: `preSpawnCheck` — the one the ticket did not name.
//
//    A DIFFERENT directory, deliberately: at the same one, trustClaudeWorkspace
//    would return `attempts: 0` without writing and this section would pass
//    having proved nothing about this call site.
// ===========================================================================

console.log('\n=== 3. preSpawnCheck writes into the redirected config too ===\n');

const dirSpawn = path.join(tmp, 'work-prespawn');
fs.mkdirSync(dirSpawn, { recursive: true });

check(dirSpawn !== dirSetup, 'this section uses a directory §2 never touched');
check(!trustedIn(scratchConfig, dirSpawn), 'before: no entry for it');

claude.preSpawnCheck(dirSpawn);

check(trustedIn(scratchConfig, dirSpawn), 'after: preSpawnCheck put one there', `keys now: ${keyCount(scratchConfig)}`);

// ===========================================================================
// 4. The negative case. Without it, §2 and §3 are satisfied by a `trustedIn`
//    that answers true for anything.
// ===========================================================================

console.log('\n=== 4. and only for directories that were passed in ===\n');

const dirUntouched = path.join(tmp, 'work-untouched');
fs.mkdirSync(dirUntouched, { recursive: true });
check(
  !trustedIn(scratchConfig, dirUntouched),
  'a directory neither call site saw has NO entry',
  'so §2 and §3 are reading the key they named, not any key'
);
check(keyCount(scratchConfig) === 2, 'the scratch config holds exactly the two entries', `${keyCount(scratchConfig)} found`);

// ===========================================================================
// 5. The real config did not move.
// ===========================================================================

console.log('\n=== 5. the operator\'s own config was not written ===\n');

process.env.HOME = realHome;
const after = residueAt(realConfig, detector);
check(
  after.matched === before.matched,
  'no key matching this suite\'s scratch prefixes was added to the real config',
  `${before.matched} before, ${after.matched} after` +
    (after.matched === before.matched
      ? ` — an instrument that counted ${before.matched} of them, so not one blind to the class`
      : ' — note that another local proof run on this machine can also add keys; re-run alone')
);
process.env.HOME = scratchHome;

// ===========================================================================
// 6. THE RED DRIVE. §1 is the assertion everything else rests on, so break the
//    thing it watches and require it to fail.
//
//    The mutant answers a FIXED path inside this script's own scratch — never
//    the real home — so a mutant build that did write could only write where
//    this run cleans up.
// ===========================================================================

console.log('\n=== 6. §1 goes red against a build whose path ignores $HOME ===\n');

const mutate = makeMutator({ distDir, scratch: tmp, report }).mutate;
const decoy = path.join(tmp, 'decoy-home', '.claude.json');

mutation: {
  const mutantDir = mutate(
    'config-path-ignores-home',
    'launchers.js',
    `return path.join(os.homedir(), '.claude.json');`,
    `return ${JSON.stringify(decoy)};`
  );
  if (!mutantDir) break mutation;

  const mutant = await import(pathToFileURL(path.join(mutantDir, 'launchers.js')).href);
  const mutantAnswer = mutant.claudeConfigPath();
  const mutantRedirected = mutantAnswer.startsWith(scratchHome + path.sep);

  check(
    !mutantRedirected,
    '§1\'s predicate FAILS against the mutant',
    mutantRedirected
      ? `it still answered ${mutantAnswer} from inside the scratch home, so §1 would have passed ` +
        `against a build that ignores $HOME. ${FIX_THE_MUTATION}`
      : `it answers ${mutantAnswer}, which is outside ${scratchHome} — so §1 is a predicate that ` +
        `can be false, and its PASS above is a measurement rather than a constant`
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
process.env.HOME = realHome;
finish();
