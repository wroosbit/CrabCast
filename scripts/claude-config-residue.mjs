#!/usr/bin/env node
// KAN-392: how many folder-trust entries this suite's proofs have left in a
// Claude Code global config — counted, never quoted.
//
// This is a READ-ONLY REPORTER, not a proof and not a gate. It opens the config
// for reading, counts, and exits 0 whether the number is 0 or 700. It is the
// instrument the KAN-392 measurement is taken with, committed so the reviewer
// can re-take it rather than read a number somebody typed.
//
// ---------------------------------------------------------------------------
// ⚠ WHY IT COUNTS AND NEVER PRINTS
// ---------------------------------------------------------------------------
//
// The file it reads is the OPERATOR'S. On the machine this was written on it
// holds 701 project keys of which 471 have nothing to do with CrabCast — other
// repositories, other people's work, paths that disclose things a PR body has
// no business carrying. So this script prints counts, and the prefixes it
// matched, and nothing else: no key, no path out of the config, not even a
// truncated one. Everything printed here is either an integer or a string that
// came out of THIS REPOSITORY's own source.
//
// It also never writes. Not to the config, not beside it. Deleting entries from
// the operator's file was considered and refused on KAN-392 — that file is
// theirs, and removing entries from it is a write nobody authorised.
//
// ---------------------------------------------------------------------------
// THE DETECTOR, AND WHAT IT DOES NOT REACH
// ---------------------------------------------------------------------------
//
// "Ours" is not a property of the config — nothing in `~/.claude.json` records
// who wrote a key. It is inferred: a key is attributed to this suite when it
// sits under the system temp dir AND begins with a scratch prefix that some
// tracked `scripts/*.mjs` mints via `mkdtempSync`. The prefixes are read out of
// the scripts at run time rather than typed here, so a proof that changes its
// prefix is followed and a new proof is picked up without anybody remembering.
//
// ⚠ IT IS A LITERAL READ OF SOURCE TEXT, AND THAT IS ITS LIMIT. It matches
// three forms — `mkdtempSync(path.join(os.tmpdir(), '<lit>'))`,
// `mkdtempSync(path.join(tmpdir(), '<lit>'))` and `mkdtempSync('/tmp/<lit>')` —
// and a prefix assembled at run time (a template literal, a variable, a name
// built from a counter) is invisible to it. No control can catch that, because
// there is nothing for a control to compare against: the count would simply be
// low and look fine. So the report prints how many `mkdtempSync(` sites exist
// in total and how many the literal forms reached, and the difference is the
// part of the answer this instrument cannot give. Sites nested inside a scratch
// root that IS matched (`mkdtempSync(path.join(scratchRoot, 'agent-'))`) are
// covered by the parent prefix and are not a gap.
//
// So read a zero here as "my search found nothing", never as "nothing is
// there".
//
// Usage:
//   node scripts/claude-config-residue.mjs                  # the real $HOME's config
//   node scripts/claude-config-residue.mjs --config <path>  # any other config
//   node scripts/claude-config-residue.mjs --json           # machine-readable

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `run-verify.mjs` imports `mintedPrefixes` and `residueOf` to measure its own
// isolation, so the report below must not run as a side effect of that import.
const RUN_AS_SCRIPT =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = RUN_AS_SCRIPT ? process.argv.slice(2) : [];
let configPath = path.join(os.homedir(), '.claude.json');
let asJson = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--config') {
    configPath = argv[i + 1];
    i += 1;
    if (!configPath) {
      console.error('--config needs a path');
      process.exit(2);
    }
  } else if (argv[i] === '--json') asJson = true;
  else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
}
configPath = path.resolve(configPath);

// ---------------------------------------------------------------------------
// The detector: scratch prefixes this repository's scripts mint.
// ---------------------------------------------------------------------------

/**
 * Every `mkdtempSync` prefix a tracked script names as a literal, with the
 * script that names it.
 *
 * Three forms, and they are written out rather than folded into one regex so
 * that the shape each one reaches is legible to a reader deciding whether a
 * fourth has appeared.
 */
export function mintedPrefixes(root = repoRoot) {
  const tracked = execFileSync('git', ['-C', root, 'ls-files', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.mjs'));

  const forms = [
    /mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*(['"])([^'"]+)\1/g,
    /mkdtempSync\(\s*path\.join\(\s*tmpdir\(\)\s*,\s*(['"])([^'"]+)\1/g,
    /mkdtempSync\(\s*(['"])\/tmp\/([^'"]+)\1/g
  ];

  const byPrefix = new Map();
  let literalSites = 0;
  let allSites = 0;

  for (const rel of tracked) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    allSites += (text.match(/mkdtempSync\(/g) ?? []).length;
    const script = path.basename(rel, '.mjs');
    for (const form of forms) {
      for (const m of text.matchAll(form)) {
        literalSites += 1;
        const prefix = m[2];
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
        byPrefix.get(prefix).add(script);
      }
    }
  }

  return {
    trackedScripts: tracked.length,
    allSites,
    literalSites,
    unreachedSites: allSites - literalSites,
    prefixes: [...byPrefix]
      .map(([prefix, scripts]) => ({ prefix, scripts: [...scripts].sort() }))
      .sort((a, b) => (a.prefix < b.prefix ? -1 : 1))
  };
}

// ---------------------------------------------------------------------------
// The count.
// ---------------------------------------------------------------------------

/**
 * Attribute the `projects` keys of one config to this suite's scratch prefixes.
 *
 * Returns counts only. The keys themselves never leave this function — that is
 * the whole discipline of this file, so it is enforced by the shape of the
 * return value rather than by everybody downstream remembering.
 */
export function residueOf(config, detector, tmpRoot = os.tmpdir()) {
  const keys = Object.keys(config?.projects ?? {});
  const tmpPrefix = path.resolve(tmpRoot) + path.sep;

  // Longest prefix first, so `kan173-globalcfg-mut-` is not swallowed by
  // `kan173-globalcfg-`.
  const ordered = [...detector.prefixes].sort((a, b) => b.prefix.length - a.prefix.length);

  const tally = new Map(ordered.map((p) => [p.prefix, { matched: 0, stillOnDisk: 0 }]));
  let underTmp = 0;
  let matched = 0;
  let stillOnDisk = 0;

  for (const key of keys) {
    if (!key.startsWith(tmpPrefix)) continue;
    underTmp += 1;
    const leaf = key.slice(tmpPrefix.length);
    const hit = ordered.find((p) => leaf.startsWith(p.prefix));
    if (!hit) continue;
    matched += 1;
    const row = tally.get(hit.prefix);
    row.matched += 1;
    if (fs.existsSync(key)) {
      row.stillOnDisk += 1;
      stillOnDisk += 1;
    }
  }

  return {
    total: keys.length,
    underTmp,
    matched,
    stillOnDisk,
    byPrefix: ordered
      .map((p) => ({ prefix: p.prefix, scripts: p.scripts, ...tally.get(p.prefix) }))
      .filter((r) => r.matched > 0)
      .sort((a, b) => b.matched - a.matched || (a.prefix < b.prefix ? -1 : 1))
  };
}

/** Read one config and count its residue. Returns counts; never the keys. */
export function residueAt(configFile, detector = mintedPrefixes()) {
  let cfg = {};
  let unreadable = null;
  const exists = fs.existsSync(configFile);
  if (exists) {
    try {
      cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      unreadable = e?.message ?? String(e);
    }
  }
  return { configPath: configFile, exists, unreadable, ...residueOf(cfg, detector) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (!RUN_AS_SCRIPT) {
  // Imported for its exports. Nothing below runs.
} else {

const detector = mintedPrefixes();

let config = {};
let exists = fs.existsSync(configPath);
let unreadable = null;
if (exists) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    unreadable = e?.message ?? String(e);
    config = {};
  }
}

const result = residueOf(config, detector);

if (asJson) {
  console.log(
    JSON.stringify(
      { configPath, exists, unreadable, detector: { ...detector, prefixes: undefined }, ...result },
      null,
      2
    )
  );
} else {
  console.log(`config: ${configPath}`);
  console.log(`        ${exists ? (unreadable ? `UNREADABLE (${unreadable})` : 'exists') : 'does not exist'}`);
  console.log(
    `detector: ${detector.prefixes.length} literal mkdtemp prefixes from ${detector.trackedScripts} tracked scripts/*.mjs`
  );
  console.log(
    `          ${detector.literalSites} of ${detector.allSites} mkdtempSync( sites are of a literal form; ` +
      `${detector.unreachedSites} are not reached (see this file's header)`
  );
  console.log('');
  const W = 42;
  const line = (label, n, tail = '') =>
    console.log(`${label.padEnd(W)}: ${String(n).padStart(4)}${tail}`);
  line('project keys total', result.total);
  line(`under ${path.resolve(os.tmpdir())}`, result.underTmp);
  line('matching a scratch prefix this suite mints', result.matched);
  line('still on disk', result.stillOnDisk, ` of ${result.matched}`);
  // Named rather than netted out: the difference is not zero and it is not
  // ours to claim either way. Other repositories on this machine mint their own
  // `kanNNN-` scratch roots, so a key under the temp dir that this detector does
  // not attribute is as likely to be somebody else's proof as a prefix this
  // detector failed to read.
  line('under the temp dir, unattributed', result.underTmp - result.matched);
  if (result.byPrefix.length) {
    console.log('\nby producing script:');
    for (const row of result.byPrefix) {
      console.log(
        `  ${row.prefix.padEnd(24)} ${String(row.matched).padStart(4)}   ${row.scripts.join(', ')}`
      );
    }
  }
  console.log('');
}

}
