// Reconciles the import register against the PINNED CHECKOUT, and asserts the
// missing-socket disposition.
//
// KAN-519. Runs inside the `butchr-proofs` job, which is the only place the
// imported proofs exist. Three sections:
//
//   §1  every verify-crabcast-* proof at the pin is in exactly one list
//   §2  every entry's citation is that proof's own text, verbatim, exactly once
//   §3  THE MISSING-SOCKET DISPOSITION — a wired proof with no peer never exits 0
//
// WHAT FAILURE THIS WOULD CATCH: a wired proof whose live arm silently stops
// running — the gate downgrading to nothing while the build stays green. §3 is
// the one that catches it, and §1/§2 catch the register drifting away from the
// proofs it claims to describe (a new verify-crabcast-* at a bumped pin that
// nobody classified, or a reason quoting a file it is not about).
//
// ─────────────────────────────────────────────────────────────────────────────
// §3, AND WHY IT IS NOT A CHECK THAT COULD ONLY EVER PASS
//
// KAN-519 task 5 as written is obsolete and was re-aimed by story/KAN-117
// (comment 13132): KAN-373 merged, so `census-disclosure` no longer exits 0 on a
// missing socket. The contract now lives in Butchr's
// daemon/scripts/lib/verdict-exit.mjs and has three values — 0 every section ran
// and passed, 1 an assertion failed, 2 INCOMPLETE. The disposition to assert is
// therefore no longer "pick one of two disagreeing behaviours" but:
//
//        ⚠ A MISSING PEER MUST NEVER YIELD 0.
//
// That is the whole point. If it could, a CI misconfiguration — a peer that
// failed to start, a socket path that moved — would silently downgrade this
// job to nothing and the build would go green having proved that Butchr's
// source is still Butchr's source.
//
// AND THE ASSERTION HAS A LIVE NEGATIVE CONTROL, which is what stops it being a
// check with no reachable failing branch. `verify-crabcast-mcp-residue-cleared`
// really does exit 0 with its live sections skipped and no tally kept (KAN-595,
// and docs/butchr-proof-import.md measured both arms). §3 runs it too and
// requires it to come back 0 — so the section proves, on every CI run and
// against a real specimen rather than a hand mutation, that it can tell a
// script that honours the contract from one that does not. Invert the
// expectation on either arm and the section goes red; the arms disagree with
// each other, so no single expectation satisfies both.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { killScratchRootSync } from './scratch-processes.mjs';

import { WIRED, EXCLUDED, ABSENT_AT_THESE_REFS } from './butchr-proof-import-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = process.env.BUTCHR_PROOF_CHECKOUT ?? path.join(repoRoot, '.butchr-proofs');
const proofDir = path.join(checkout, 'daemon', 'scripts');

// Every scratch $HOME §3 hands to a harness run, so an interrupted run can take
// its daemons with it. See the teardown note below.
const scratchHomes = [];

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL-PATH TEARDOWN. §3 runs the harness four times, and each of those may
// start a CrabCast daemon; on SIGINT the ordinary cleanup at the foot of this
// script is never reached. These roots ARE under the system temp directory and
// each is a mkdtemp leaf, so the real sweeper applies here — it SIGKILLs any
// process whose argv carries the root, which is what catches a daemon that
// outlived the harness that started it.
//
// ⚠ The same spawnSync caveat as the harness: while a child is running this
// process is blocked and a JS handler cannot run. A terminal ^C reaches the
// whole group and this runs on the way out; a signal aimed at this pid alone
// lands after the current child returns.
const sweepScratchHomes = (why) => {
  let killed = 0;
  for (const root of scratchHomes) {
    try { killed += killScratchRootSync(root); } catch { /* not sweepable / already gone */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (why) console.log(`\n[butchr-proof-reconcile] ${why} — killed ${killed} process(es) and removed ${scratchHomes.length} scratch home(s)`);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    sweepScratchHomes(signal);
    process.exit(130);
  });
}

let failures = 0;
const check = (ok, what, detail = '') => {
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
  }
  return ok;
};
const rule = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);

// A SETUP GUARD, NOT A VERDICT.
if (!fs.existsSync(proofDir)) {
  console.error(`SETUP: no pinned checkout at ${proofDir}. Nothing was measured.`);
  process.exit(65);
}

const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, '.butchr-proof-pin.json'), 'utf8'));
console.log(`pin:      ${pin.ref}`);
console.log(`checkout: ${proofDir}`);

// ───────────────────────────────────────────────────────────────────────────
rule('§1  Every verify-crabcast-* proof at the pin is in exactly one list');

const onDisk = fs
  .readdirSync(proofDir)
  .filter((f) => /^verify-crabcast-.*\.mjs$/.test(f))
  .map((f) => path.basename(f, '.mjs'))
  .sort();

check(onDisk.length > 0, 'the pinned checkout carries verify-crabcast-* proofs', `${onDisk.length} found`);

const wiredNames = new Set(WIRED.map((e) => e.script));
const excludedNames = new Set(EXCLUDED.map((e) => e.script));

check(
  wiredNames.size === WIRED.length && excludedNames.size === EXCLUDED.length,
  'no proof is listed twice within a list'
);

const both = [...wiredNames].filter((n) => excludedNames.has(n));
check(both.length === 0, 'no proof is both wired and excluded', both.join(', '));

for (const name of onDisk) {
  const inWired = wiredNames.has(name);
  const inExcluded = excludedNames.has(name);
  check(
    inWired || inExcluded,
    `${name} is accounted for`,
    inWired || inExcluded
      ? ''
      : 'NOT wired and NOT excluded — classify it in scripts/butchr-proof-import-registry.mjs. ' +
        'A proof that appeared at a bumped pin and was never classified is exactly what this catches.'
  );
}

// The other direction: an entry naming a proof that is not there. Stale is not
// harmless — it is a reason nobody re-reads, standing beside reasons that are
// still load-bearing.
const diskSet = new Set(onDisk);
for (const e of [...WIRED, ...EXCLUDED]) {
  check(
    diskSet.has(e.script),
    `register entry '${e.script}' names a proof that exists at the pin`,
    diskSet.has(e.script) ? '' : `no ${e.script}.mjs at the pin — remove the entry or bump the pin deliberately`
  );
}

for (const a of ABSENT_AT_THESE_REFS) {
  const present = diskSet.has(a.script) || fs.existsSync(path.join(repoRoot, 'scripts', `${a.script}.mjs`));
  check(
    !present,
    `'${a.script}' is still absent from both trees, as recorded`,
    present
      ? 'it has ARRIVED. It is required to be held out — classify it in the register rather than ' +
        'leaving it described as absent, because the two are different facts.'
      : ''
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule("§2  Every entry's citation is that proof's own text, verbatim, exactly once");

// The file is DERIVED from the entry's own `script` rather than named beside
// it, so "cites evidence from a file it is not about" is a state this register
// cannot express — the same discipline verify-proof-registry.mjs applies to
// CrabCast's own exclusions, carried over deliberately.
for (const e of [...WIRED, ...EXCLUDED]) {
  const file = path.join(proofDir, `${e.script}.mjs`);
  if (!fs.existsSync(file)) continue; // already failed in §1
  const quote = e.evidence?.quote;
  const wellFormed = typeof quote === 'string' && quote.trim().length > 0;
  if (!check(wellFormed, `'${e.script}' carries a quoted citation`, JSON.stringify(e.evidence ?? null))) continue;

  const src = fs.readFileSync(file, 'utf8');
  let count = 0;
  let idx = src.indexOf(quote);
  while (idx !== -1) {
    count += 1;
    idx = src.indexOf(quote, idx + 1);
  }
  check(
    count === 1,
    `'${e.script}' quotes text found exactly once in its own source`,
    count === 0
      ? `not in ${e.script}.mjs — the quote must be that file's text verbatim: ${JSON.stringify(quote)}`
      : count > 1
        ? `${count} matches — lengthen it so it names ONE place`
        : ''
  );

  const reason = e.reason ?? e.consumerBehaviour;
  check(
    typeof reason === 'string' && reason.trim().length >= 40,
    `'${e.script}' carries a reason, not just a name`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§3  THE MISSING-SOCKET DISPOSITION — a wired proof with no peer never exits 0');

const harness = path.join(repoRoot, 'scripts', 'butchr-proof-harness.mjs');

/**
 * Run one proof with NO peer and return its exit code.
 *
 * Its own command, never bundled behind another — an exit status read off the
 * wrong process is how a check reports the world when it measured a pipeline.
 */
const exitWithNoPeer = (name) => {
  // Under the system temp dir rather than inside the repo: a scratch $HOME in
  // the working tree is residue a failed run leaves behind in somebody's
  // checkout, and it would need a .gitignore entry to stay invisible.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'butchr-proof-disposition-'));
  scratchHomes.push(scratch);
  const r = spawnSync(process.execPath, [harness, name, '--no-peer'], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, HOME: scratch },
  });
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* swept below */ }
  return { status: r.status, signal: r.signal, tail: (r.stdout ?? '').split('\n').slice(-6).join('\n') };
};

for (const e of WIRED) {
  const { status, signal, tail } = exitWithNoPeer(e.script);
  console.log(`  ${e.script}: no-peer exit = ${status}${signal ? ` (signal ${signal})` : ''}`);
  check(
    status !== 0,
    `${e.script} does NOT exit 0 with no peer — the gate cannot silently become nothing`,
    status === 0
      ? 'IT EXITED 0. Its live arm did not run and it said so with a zero, which means a CI ' +
        'misconfiguration would downgrade this job to nothing and the build would stay green. ' +
        `Do not wire it.\n${tail}`
      : ''
  );
  check(
    status === 2,
    `${e.script} exits 2 INCOMPLETE with no peer — nothing failed, something did not run`,
    status === 2 ? '' : `got ${status}; the 0/1/2 contract is lib/verdict-exit.mjs at the pin`
  );
}

// THE NEGATIVE CONTROL. A real specimen that violates the contract, so this
// section demonstrably CAN go red rather than only ever agreeing with itself.
const CONTROL = 'verify-crabcast-mcp-residue-cleared';
console.log('');
console.log(`  negative control — ${CONTROL} is KNOWN to exit 0 with its live sections skipped (KAN-595).`);
console.log('  If it comes back non-zero, that defect has been fixed upstream and the control');
console.log('  above has stopped discriminating — read the checks above as unproven until a new');
console.log('  control is chosen. This is not a CrabCast failure.');
if (fs.existsSync(path.join(proofDir, `${CONTROL}.mjs`))) {
  const { status } = exitWithNoPeer(CONTROL);
  console.log(`  ${CONTROL}: no-peer exit = ${status}`);
  check(
    status === 0,
    `the control still exits 0 — so §3's assertion has a reachable failing branch`,
    `got ${status}. See the note directly above: this means the control has changed, not that CrabCast broke.`
  );
} else {
  check(false, `the negative control ${CONTROL} is present at the pin`, 'it is not — §3 is unproven without it');
}

// The ordinary path. The signal path above does the same thing when this is
// never reached.
sweepScratchHomes(null);

// ───────────────────────────────────────────────────────────────────────────
console.log('');
console.log(
  `${onDisk.length} proof(s) at the pin: ${WIRED.length} wired, ${EXCLUDED.length} excluded, ` +
    `${onDisk.length - WIRED.length - EXCLUDED.length} unaccounted for.`
);
if (failures) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed');
process.exit(0);
