#!/usr/bin/env node
// KAN-392: run the CI proof array LOCALLY the way CI runs it — one scratch
// `$HOME` per proof — so a hand-run stops writing folder-trust entries into the
// operator's own `~/.claude.json`.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
//
// The `claude` launcher records folder trust by writing
// `projects[<workDir>].hasTrustDialogAccepted` into `claudeConfigPath()`, which
// is `path.join(os.homedir(), '.claude.json')`. Both of its call sites —
// `setup` and `preSpawnCheck` in src/launchers.ts — call
// `trustClaudeWorkspace(workDir)` with no `configPath`, so both land there. Any
// proof that activates a `claude` agent therefore adds one key per scratch
// directory to whatever `HOME` it is running under, and a scratch directory is
// gone by the time anybody reads the file.
//
// CI was never affected: `.github/workflows/ci.yml` gives every proof
// `home="$RUNNER_TEMP/verify-home-$s"`. The cost is local. Measured on the
// machine this was written on, 230 such keys had accumulated, of which 0 named
// a directory that still existed — `node scripts/claude-config-residue.mjs`
// re-takes that measurement.
//
// So this file is the local half of a mechanism CI already had. It is not a new
// idea about isolation; it is the same three lines, off the runner.
//
// ---------------------------------------------------------------------------
// WHY IT READS ci.yml INSTEAD OF CARRYING ITS OWN LIST
// ---------------------------------------------------------------------------
//
// A second copy of the proof list is a second place to forget, and this
// repository has already paid for that once — the array in ci.yml is the line
// concurrent slices conflict on, and `verify-proof-registry` exists because a
// resolution that takes one side silently retires the other side's proof. A
// runner with its own list would be a third list nothing reconciles, so it
// parses the array through `readVerifyArray` in ci-workflow.mjs, which is the
// same function `verify-proof-registry` audits it with.
//
// That is also what answers "which proofs may this isolate?" — and the answer
// is not a policy written here, it is the array. A proof in the EXCLUSIONS
// register of scripts/verify-proof-registry.mjs is NOT NAMEABLE at this
// command line, and §4 below refuses it by name rather than running it. See the
// next block for why that matters.
//
// ---------------------------------------------------------------------------
// ⚠ TWO PROOFS MUST NOT BE ISOLATED, AND ONE OF THEM IS NOT DOCUMENTED AS SUCH
// ---------------------------------------------------------------------------
//
// `verify-interrupt-at-dialog-live` says so in its own header: it uses the real
// `$HOME` deliberately, because `claude` needs the operator's credentials to
// start at all and a scratch HOME would measure a login screen. Running it
// under this runner would break it.
//
// `verify-send-confirms-delivery-live` has the same requirement and says
// nothing about it — measured on 2026-08-14, it is the only one of the six
// residue-producing proofs that neither mentions `HOME` nor could survive a
// scratch one: its header records that it "COSTS ONE CLAUDE AGENT for the
// length of the run", and a real Claude Code that cannot authenticate does not
// draw the composer marker §0 reads. Its exclusion entry now says so.
//
// Both are in EXCLUSIONS and therefore out of the array, so this runner cannot
// reach either. That is deliberate and it is structural rather than a check:
// the population is derived from the list of proofs CI runs under a scratch
// HOME, so "isolatable" and "in the array" are the same set by construction and
// cannot drift apart. Their residue — 26 of the 230 keys — is the cost of
// running a real agent by hand and is NOT what this runner fixes.
//
// ---------------------------------------------------------------------------
// WHAT THIS RUNNER DOES NOT COVER — read this before trusting it
// ---------------------------------------------------------------------------
//
// Nothing compels anybody to use it. Every proof's own header documents
// `node scripts/verify-<name>.mjs` as the way to run it, and that route still
// writes to the real `~/.claude.json`. This runner accepts individual names for
// exactly that reason — it is meant to be a one-for-one replacement for the
// documented route, not only a whole-array command — but a route being
// available is not a route being taken. The register-shaped alternative
// (a sweep holding every `launcher.setup`-reaching proof to redirecting HOME or
// declaring why it need not) is what would close that, and it was weighed and
// deferred on KAN-392.
//
// What this file DOES guarantee it is not lying about: §3 refuses to run
// anything until the SHIPPED `claudeConfigPath()` has been observed answering
// from inside a scratch directory, and §6 counts the real config's keys on both
// sides of the run and FAILS on a delta. Setting an environment variable is not
// evidence that anything reads it, and a run that reports isolation it did not
// achieve is worse than no runner at all.
//
// Usage:
//   npm run build
//   node scripts/run-verify.mjs                      # every proof in ci.yml's array
//   node scripts/run-verify.mjs verify-restart-survival [more...]
//   node scripts/run-verify.mjs --list
//
//   --root <dir>   where the scratch homes go (default: a fresh mkdtemp)
//   --keep         leave the scratch homes on disk afterwards
//   --dist <dir>   the build to hand each proof (default: ./dist)

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readVerifyArray } from './ci-workflow.mjs';
import { mintedPrefixes, residueAt } from './claude-config-residue.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');

/** Refuse loudly. Exit 2 is "the runner could not run", never a proof verdict. */
function refuse(...lines) {
  for (const l of lines) console.error(l);
  process.exit(2);
}

// ===========================================================================
// 1. Arguments
// ===========================================================================

const argv = process.argv.slice(2);
const named = [];
let listOnly = false;
let keep = false;
let rootArg = null;
let distArg = null;

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--list') listOnly = true;
  else if (a === '--keep') keep = true;
  else if (a === '--root') rootArg = argv[++i] ?? refuse('--root needs a directory');
  else if (a === '--dist') distArg = argv[++i] ?? refuse('--dist needs a directory');
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/run-verify.mjs [--list] [--keep] [--root <dir>] [--dist <dir>] [name...]');
    process.exit(0);
  } else if (a.startsWith('-')) refuse(`unknown option: ${a}`);
  else named.push(a.replace(/\.mjs$/, ''));
}

// ===========================================================================
// 2. The population, read out of ci.yml
// ===========================================================================

const yaml = fs.readFileSync(workflowPath, 'utf8');
const array = readVerifyArray(yaml);

if (array.opens !== 1) {
  refuse(
    `${workflowPath} declares ${array.opens} \`scripts=(\` arrays; this runner needs exactly one.`,
    'Running a guess at which one is the proof list would isolate a population nobody chose.'
  );
}
// A short read is the failure that would look like success: it would run a
// PREFIX of the array and print a clean verdict over proofs it never started.
if (!array.closed) {
  refuse(
    `the \`scripts=(\` array in ${workflowPath} is not closed — the read ran off the end.`,
    `Refusing to run a prefix of the list (${array.entries.length} entries were read).`
  );
}

const arrayNames = array.entries.map((e) => e.name);
const arraySet = new Set(arrayNames);

if (listOnly) {
  console.log(`${arrayNames.length} proof(s) in the ci.yml array:`);
  for (const e of array.entries) console.log(`  ci.yml:${e.line}  ${e.name}`);
  process.exit(0);
}

// ===========================================================================
// 3. A name this runner may not run is refused BY NAME
// ===========================================================================

const unknown = named.filter((n) => !arraySet.has(n));
if (unknown.length) {
  const detail = unknown.map((n) => {
    const file = path.join(repoRoot, 'scripts', `${n}.mjs`);
    if (!fs.existsSync(file)) return `  ${n} — no such script`;
    return (
      `  ${n} — tracked, but NOT in the ci.yml array. It is one of the live proofs, ` +
      `registered in the EXCLUSIONS register of scripts/verify-proof-registry.mjs with the ` +
      `reason CI cannot run it. Some of them — verify-interrupt-at-dialog-live and ` +
      `verify-send-confirms-delivery-live — need the operator's REAL $HOME, because the ` +
      `\`claude\` they start reads its credentials from it. Isolating those would not clean ` +
      `them up, it would break them. Run it directly: node scripts/${n}.mjs`
    );
  });
  refuse('this runner runs the ci.yml array and nothing else:', ...detail);
}

const toRun = named.length ? named : arrayNames;

// ===========================================================================
// 4. §0 — the shipped path must be observed answering from a scratch HOME
//
//    Setting HOME is not evidence that anything reads it. Everything below
//    would run identically against a build that had stopped consulting
//    os.homedir(), and would report a clean isolation it had not performed.
//    This is the KAN-173 refusal, applied to the runner instead of to one
//    proof, and it is the only thing standing between this file and a check
//    that goes green forever.
// ===========================================================================

const distDir = path.resolve(distArg ?? path.join(repoRoot, 'dist'));
const launchersJs = path.join(distDir, 'launchers.js');
if (!fs.existsSync(launchersJs)) {
  refuse(
    `${launchersJs} is missing — run \`npm run build\` first.`,
    'Without it the isolation below cannot be verified, and an unverified redirect is not one.'
  );
}

const runRoot = rootArg
  ? path.resolve(rootArg)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'kan392-run-verify-'));
fs.mkdirSync(runRoot, { recursive: true });

const probeHome = path.join(runRoot, 'probe-home');
fs.mkdirSync(probeHome, { recursive: true });

const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `import(${JSON.stringify(pathToFileURL(launchersJs).href)})` +
      `.then((m) => console.log(m.claudeConfigPath()))`
  ],
  { env: { ...process.env, HOME: probeHome }, encoding: 'utf8' }
);
const probeAnswer = (probe.stdout ?? '').trim();
const isolated = probeAnswer.startsWith(probeHome + path.sep);

console.log('=== 0. the shipped claudeConfigPath() must answer from a scratch HOME ===\n');
console.log(`  real HOME:      ${process.env.HOME}`);
console.log(`  probe HOME:     ${probeHome}`);
console.log(`  it answers:     ${probeAnswer || `(nothing — ${(probe.stderr ?? '').trim().split('\n')[0] ?? 'no output'})`}`);
if (!isolated) {
  refuse(
    '',
    'REFUSING TO RUN. The build in ' + distDir + ' does not resolve its global config from $HOME,',
    'so redirecting HOME would isolate nothing and every proof below would write into the',
    "operator's real ~/.claude.json while this runner reported that it had not."
  );
}
console.log('  → HOME redirection reaches the shipped path. Proceeding.\n');

// ===========================================================================
// 5. The run. One at a time, one scratch $HOME each — ci.yml's mechanism.
// ===========================================================================

const detector = mintedPrefixes(repoRoot);
const realConfig = path.join(os.homedir(), '.claude.json');
const before = residueAt(realConfig, detector);

console.log(`=== 1. ${toRun.length} proof(s), serially, one scratch HOME each ===`);
console.log(`  scratch root:   ${runRoot}`);
console.log(`  dist:           ${distDir}`);
console.log(`  real config:    ${before.total} project key(s) before the run\n`);

const results = [];
for (const s of toRun) {
  const home = path.join(runRoot, `verify-home-${s}`);
  fs.mkdirSync(home, { recursive: true });

  console.log(`--- ${s} ---`);
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [path.join('scripts', `${s}.mjs`), distDir], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    stdio: 'inherit'
  });
  const ms = Date.now() - t0;
  const verdict = run.status === 0 ? 'PASSED' : 'FAILED';
  const landed = residueAt(path.join(home, '.claude.json'), detector);
  results.push({ s, verdict, ms, status: run.status, landed: landed.total, home });
  console.log(
    `--- ${s} ${verdict} in ${ms}ms — ${landed.total} trust key(s) landed in its scratch HOME\n`
  );
}

// ===========================================================================
// 6. Did the real config move? Counted on both sides, never quoted.
// ===========================================================================

const after = residueAt(realConfig, detector);
const delta = after.total - before.total;
const deltaOurs = after.matched - before.matched;

console.log('=== 2. the operator\'s own config, on both sides of the run ===\n');
console.log(`  ${realConfig}`);
console.log(`  project keys                 : ${before.total} before, ${after.total} after (delta ${delta >= 0 ? '+' : ''}${delta})`);
console.log(`  of those, this suite's scratch: ${before.matched} before, ${after.matched} after (delta ${deltaOurs >= 0 ? '+' : ''}${deltaOurs})\n`);

let isolationFailed = false;
if (deltaOurs !== 0) {
  isolationFailed = true;
  console.log(
    `  FAIL  ${deltaOurs} key(s) matching this suite's scratch prefixes appeared in the real config\n` +
      '        during this run. Either a proof reached the global config by a route that does not\n' +
      '        go through $HOME, or ANOTHER local proof run on this machine wrote them — this\n' +
      '        machine runs a fleet, and that race is real. Re-run alone before concluding.\n' +
      '        `node scripts/claude-config-residue.mjs` names which prefixes moved.'
  );
} else {
  console.log('  PASS  no key matching this suite\'s scratch prefixes was added to it.');
  console.log(
    `        The instrument that says so counted ${before.matched} such keys already there, and\n` +
      `        counted ${results.reduce((n, r) => n + r.landed, 0)} landing in the scratch HOMEs above — so it is a\n` +
      '        measurement that can see these writes, not one blind to all of them.\n'
  );
}

// ===========================================================================
// 7. Verdict
// ===========================================================================

const failed = results.filter((r) => r.verdict === 'FAILED');
console.log(`\nran ${results.length} script(s); ${failed.length} failed`);
for (const r of results) console.log(`  ${r.verdict.padEnd(6)} ${r.s} (${r.ms}ms)`);
if (failed.length) console.log(`FAILED: ${failed.map((r) => r.s).join(' ')}`);

if (keep) {
  console.log(`\nscratch homes kept at ${runRoot}`);
} else {
  fs.rmSync(runRoot, { recursive: true, force: true });
  console.log(`\nscratch homes removed (${runRoot}); pass --keep to retain them`);
}

process.exit(failed.length || isolationFailed ? 1 : 0);
