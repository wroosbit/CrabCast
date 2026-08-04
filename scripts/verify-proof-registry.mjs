#!/usr/bin/env node
// Proof for KAN-141: a verify script cannot be retired without a red check.
//
// THE DEFECT. Every slice that adds a proof adds a line to the `scripts=(...)`
// array in the `verify` job of `.github/workflows/ci.yml`. That array is the
// one line every concurrent slice touches, and it has already conflicted twice
// in one evening (PR #15 and PR #17, both against the same entry). Resolving
// such a hunk by taking one side rather than the union silently and
// permanently retires whichever proof lost. There is no error and no red
// check: the script stays in `scripts/`, looking exactly like coverage, and
// nothing anywhere compares the directory to the list.
//
// That is this suite's own founding failure one level up — a check that is not
// run is indistinguishable from a check that passes, and the thing that would
// have noticed is the thing that was dropped.
//
// THE RULE. Every tracked `scripts/verify-*.mjs` must be exactly one of:
//
//   (a) an entry in the CI array, so CI runs it; or
//   (b) an entry in the EXCLUSIONS register below, with the reason it cannot
//       run on a GitHub runner.
//
// Anything in neither fails this check BY NAME. So does an array entry whose
// file has gone, an exclusion whose file has gone, and a script that is
// somehow both.
//
// WHY NOT A GLOB. Generating the array from `scripts/verify-*.mjs` would be
// shorter and wrong. Seven of these scripts need a real herdr server and real
// terminal panes; a glob would either run them on a runner that has neither —
// producing a red check about the runner rather than about the code — or be
// written so defensively it silently ran nothing. The list stays explicit and
// deliberate. This check is what makes forgetting loud.
//
// WHY THE EXCLUSIONS MOVED HERE. They used to be prose in a `#` comment in
// ci.yml, which is a form no check can read, and prose drifts. They are data
// now, and section 2 holds them to the same standard verify-cli-parity holds
// its own register to: a reason a future reader can act on, and a citation.
//
// Needs no daemon, no herdr, no network and no build: it reads `ci.yml` and
// asks git what is tracked. Exits non-zero on any failure so a reviewer can
// re-run it against the PR head.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = path.join('.github', 'workflows', 'ci.yml');
const workflowPath = path.join(repoRoot, workflow);

/** This script's own basename, which section 3 accounts for separately. */
const SELF = path.basename(fileURLToPath(import.meta.url), '.mjs');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * The live half of this suite: proofs that are absent from CI on purpose.
 *
 * Each needs a real herdr server and real terminal panes, which no GitHub
 * runner has (herdr's public availability is itself an open question on this
 * project). They are run by hand on a machine with herdr and their output goes
 * on the PR.
 *
 * `reason` is what a future reader actually arrives wanting — not "is this
 * known?", which a bare name answers, but "why doesn't CI run this?".
 * `evidence` points at the line in the script itself that the reason rests on,
 * so the claim is checkable rather than asserted.
 *
 * Adding a name here is the escape hatch from the rule above, so it is meant
 * to cost something: the reason is reviewed like code, and an entry naming a
 * script that no longer exists fails section 2 rather than sitting here
 * rotting.
 */
const EXCLUSIONS = [
  {
    script: 'verify-no-attach-steal',
    reason:
      'Attaches to a live agent. The KAN-16 property — a second spawnSession does not evict the ' +
      'first client — only exists where there is a real PTY still streaming to steal, so the ' +
      'assertion has no meaning against a stub. It takes the directory of an agent herdr already ' +
      'has running with nothing attached to it, which is a machine state, not a fixture.',
    evidence: 'scripts/verify-no-attach-steal.mjs:12 requires a directory herdr already has a live agent in'
  },
  {
    script: 'verify-tab-per-agent',
    reason:
      'Needs real tabs and real panes. What it measures is COLUMN WIDTH — that an agent\'s width ' +
      'does not shrink as the fleet grows — and width is produced by a terminal app laying out a ' +
      'rendered tab. A shimmed herdr has no layout to measure, so the one assertion that fails on ' +
      'the old code could not fail here.',
    evidence: 'scripts/verify-tab-per-agent.mjs:1 live check against a real herdr, at the HerdrBridge level'
  },
  {
    script: 'verify-fleet-switch-live',
    reason:
      'Uses `herdr agent list` as the ground truth for whether an agent is running, across daemon ' +
      'SIGKILL and restart. The whole point is that the census comes from something other than the ' +
      'daemon under test; against a stub the daemon would be checking its own homework, which is ' +
      'the failure mode these restart sequences exist to rule out.',
    evidence: 'scripts/verify-fleet-switch-live.mjs:2 takes `herdr agent list` as ground truth'
  },
  {
    script: 'verify-activate-verified-existence',
    reason:
      'Real herdr 0.6.x and real panes. It proves `activate` reports success only for an agent that ' +
      'verifiably exists, and separates that from herdr-said-no and herdr-did-not-answer. The ' +
      'version-specific behaviour of a real 0.6.x server is the subject, not the scaffolding.',
    evidence: 'scripts/verify-activate-verified-existence.mjs:22 runs against a real herdr 0.6.x with real panes'
  },
  {
    script: 'verify-pretrust-survives-concurrency',
    reason:
      'Private herdr server plus real panes. The KAN-54 property is that a pre-trust write to ' +
      '~/.claude.json survives concurrent activations against a competing writer, and concurrency ' +
      'between real spawned processes is what it has to survive — serialised stub calls would pass ' +
      'it trivially and prove nothing.',
    evidence: 'scripts/verify-pretrust-survives-concurrency.mjs:8 runs against a private herdr server and real panes'
  },
  {
    script: 'verify-pty-init-rejects-unknown-session',
    reason:
      'Private herdr server plus real PTYs. It asserts a daemon refuses a PTY request naming a ' +
      'session it does not have, rather than substituting one or spawning a default shell — a ' +
      'refusal about PTY plumbing, which needs the plumbing. It also has a load-dependent ' +
      'keystroke-delivery stage that was the source of a CI flake (KAN-88 item 11).',
    evidence: 'scripts/verify-pty-init-rejects-unknown-session.mjs:7 isolates a real daemon by HERDR_SOCKET_PATH'
  },
  {
    script: 'verify-spawn-failure-legibility',
    reason:
      'Private herdr server. The KAN-24 defect was that a REFUSED `herdr agent start` was reported ' +
      'as success, so the proof needs a real server that can genuinely refuse; a stub that returns ' +
      'a refusal shape is asserting the fixture, not the bridge.',
    evidence: 'scripts/verify-spawn-failure-legibility.mjs:11 runs against a private herdr server on its own socket'
  }
];

// ---------------------------------------------------------------------------
// 1. The CI array, read mechanically from the workflow.
// ---------------------------------------------------------------------------

console.log(`=== 1. The proof list, read from ${workflow} ===\n`);

const yaml = fs.readFileSync(workflowPath, 'utf8');
const yamlLines = yaml.split('\n');

const arrayOpens = [...yaml.matchAll(/^\s*scripts=\(\s*$/gm)];
check(
  arrayOpens.length === 1,
  `${workflow} declares exactly one \`scripts=(\` array`,
  `found ${arrayOpens.length}` +
    (arrayOpens.length > 1 ? ' — two lists is two places to forget; fold them into one' : '')
);

/** Line numbers (1-based, inclusive) spanned by the array literal. */
let arrayRegion = null;
let ciScripts = [];

if (arrayOpens.length === 1) {
  const openLine = yaml.slice(0, arrayOpens[0].index).split('\n').length;
  let closeLine = -1;
  const entries = [];
  for (let n = openLine + 1; n <= yamlLines.length; n += 1) {
    const raw = yamlLines[n - 1];
    const text = raw.replace(/#.*$/, '').trim();
    if (text === '') continue;
    if (text === ')') { closeLine = n; break; }
    entries.push({ name: text, line: n });
  }

  // A read that ran off the end would take the entries it never saw with it and
  // then report an all-clear over the remainder — the exact shape this script
  // exists to make impossible.
  check(closeLine > 0, 'the array literal is closed — the whole list was read, not a prefix of it');

  if (closeLine > 0) {
    arrayRegion = { start: openLine, end: closeLine };
    ciScripts = entries;

    const malformed = entries.filter((e) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name));
    check(
      malformed.length === 0,
      'every entry is a bare script name',
      malformed.length ? malformed.map((e) => `ci.yml:${e.line} ${JSON.stringify(e.name)}`).join(', ') : ''
    );

    const seen = new Map();
    const dupes = [];
    for (const e of entries) {
      if (seen.has(e.name)) dupes.push(`${e.name} (ci.yml:${seen.get(e.name)} and ci.yml:${e.line})`);
      else seen.set(e.name, e.line);
    }
    check(dupes.length === 0, 'no script is listed twice', dupes.join('; '));
  }
}

// The array is inert unless something iterates it. A list that is present but
// no longer consumed runs nothing while reading, to every reviewer, exactly
// like a list that does.
check(
  /for\s+s\s+in\s+"\$\{scripts\[@\]\}"/.test(yaml),
  'the array is iterated by the verify job'
);
check(
  /node\s+"scripts\/\$s\.mjs"/.test(yaml),
  'and each entry is run as `node "scripts/$s.mjs"`'
);

console.log(`\n  ${ciScripts.length} script(s) in the CI array:`);
for (const e of ciScripts) console.log(`    ci.yml:${e.line}  ${e.name}`);
console.log('');

// ---------------------------------------------------------------------------
// 2. The exclusion register, held to the standard it is an escape hatch from.
// ---------------------------------------------------------------------------

console.log('=== 2. Recorded exclusions ===\n');

const excludedNames = new Set(EXCLUSIONS.map((e) => e.script));
check(excludedNames.size === EXCLUSIONS.length, 'no script is excluded twice');

for (const e of EXCLUSIONS) {
  const file = path.join('scripts', `${e.script}.mjs`);
  const exists = fs.existsSync(path.join(repoRoot, file));
  // An exclusion for a script that is gone is stale, and stale is not
  // harmless: it is a reason nobody re-reads, standing next to reasons that
  // are still load-bearing.
  check(exists, `excluded '${e.script}' still exists`, exists ? '' : `${file} is gone — remove the entry`);
  check(
    typeof e.reason === 'string' && e.reason.trim().length >= 40,
    `excluded '${e.script}' carries a reason, not just a name`
  );
  // The citation names the script's own source and a line that is really in
  // it, so an entry cannot cite evidence from a file it is not about.
  const m = /^scripts\/([A-Za-z0-9._-]+\.mjs):(\d+)\b/.exec(e.evidence ?? '');
  const cited = m && m[1] === `${e.script}.mjs`;
  const inRange =
    cited && exists &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n').length;
  check(
    Boolean(inRange),
    `excluded '${e.script}' cites a line of its own source`,
    inRange ? '' : `bad citation: ${JSON.stringify(e.evidence ?? null)}`
  );
}

console.log('');
for (const e of EXCLUSIONS) {
  console.log(`  ${e.script}`);
  console.log(`    why:      ${e.reason.replace(/\s+/g, ' ')}`);
  console.log(`    evidence: ${e.evidence.replace(/\s+/g, ' ')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 3. The reconciliation: scripts/ against the two lists.
//
// This is the section the ticket is about. Everything above exists so that
// this comparison is between two things that were both read rather than
// believed.
// ---------------------------------------------------------------------------

console.log('=== 3. Every proof is run, or excluded with a reason ===\n');

const tracked = execFileSync('git', ['ls-files', 'scripts'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const proofs = tracked
  .filter((f) => /^scripts\/verify-[^/]*\.mjs$/.test(f))
  .map((f) => path.basename(f, '.mjs'))
  .sort();

check(proofs.length > 0, 'git tracks at least one scripts/verify-*.mjs', `${proofs.length} found`);

const ciNames = new Set(ciScripts.map((e) => e.name));
const rows = [];

for (const name of proofs) {
  if (name === SELF) {
    // This script is a proof too, and it is deliberately NOT in the array —
    // see section 4 for where it runs and why there. It is accounted for by
    // that check rather than by this one.
    rows.push({ name, state: 'self' });
    continue;
  }
  const inCi = ciNames.has(name);
  const excluded = excludedNames.has(name);
  rows.push({ name, state: inCi ? 'ci' : excluded ? 'excluded' : 'UNACCOUNTED' });

  check(
    inCi || excluded,
    `scripts/${name}.mjs is accounted for`,
    inCi
      ? 'runs in CI'
      : excluded
        ? 'excluded, with a recorded reason'
        : 'NOT in the CI array and NOT in the exclusion register — add it to one or the other. ' +
          'If it vanished from ci.yml in a merge, this is the entry that was dropped.'
  );
  // Both at once means the two halves of the register disagree about the same
  // script, and nobody can read them and come away right.
  check(
    !(inCi && excluded),
    `scripts/${name}.mjs is not both run and excluded`
  );
}

// The other direction: a name in the array with no file behind it. The CI loop
// would fail on it too, but it would fail as `node: cannot find module`, which
// reads like infrastructure rather than like a missing proof.
const proofSet = new Set(proofs);
for (const e of ciScripts) {
  check(
    proofSet.has(e.name),
    `CI array entry '${e.name}' is a tracked scripts/verify-*.mjs`,
    proofSet.has(e.name) ? '' : `ci.yml:${e.line} names scripts/${e.name}.mjs, which git does not track`
  );
}

// ---------------------------------------------------------------------------
// 4. This check's own wiring — the one thing it cannot take on faith.
//
// A guard that lives inside the thing it guards is not a guard. If this script
// were an entry in `scripts=(...)`, the very merge resolution it exists to
// catch could drop IT, and the tree would go green with the audit gone. So it
// is wired as its own JOB in ci.yml, in a region of the file the array's
// conflict hunk does not reach, and asserts that wiring here.
//
// The pairing that closes the loop: verify-cli-parity §6 asserts that this
// job still exists, and verify-cli-parity is itself an array entry that
// section 3 above requires. Neither can be dropped without the other going
// red.
// ---------------------------------------------------------------------------

console.log('\n=== 4. This check runs in CI, from outside the list it audits ===\n');

const invocation = new RegExp(`node\\s+scripts/${SELF}\\.mjs`, 'g');
const wiredAt = [...yaml.matchAll(invocation)]
  .map((m) => yaml.slice(0, m.index).split('\n').length)
  .filter((line) => !arrayRegion || line < arrayRegion.start || line > arrayRegion.end);

check(
  wiredAt.length > 0,
  `${workflow} runs \`node scripts/${SELF}.mjs\` from a step of its own`,
  wiredAt.length ? `ci.yml:${wiredAt.join(', ci.yml:')}` : 'nothing in CI runs this audit — it proves nothing where it matters'
);

// And it must NOT be an array entry: that would make the audit droppable by
// the same edit as everything it audits.
check(
  !ciNames.has(SELF),
  `${SELF} is not itself an entry in the array it reads`,
  ciNames.has(SELF) ? 'move it back out to its own step — inside the list it guards nothing' : ''
);

// ---------------------------------------------------------------------------

console.log('\n=== The proof register ===\n');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(w)}  ${
      r.state === 'ci'
        ? 'CI'
        : r.state === 'excluded'
          ? 'EXCLUDED — see section 2 for the reason'
          : r.state === 'self'
            ? 'CI (own job) — see section 4'
            : 'UNACCOUNTED FOR'
    }`
  );
}
console.log(
  `\n  ${rows.length} proof(s): ${rows.filter((r) => r.state === 'ci').length} run by the CI array, ` +
    `${rows.filter((r) => r.state === 'excluded').length} excluded with a recorded reason, ` +
    `${rows.filter((r) => r.state === 'self').length} run by its own job, ` +
    `${rows.filter((r) => r.state === 'UNACCOUNTED').length} unaccounted for.`
);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
