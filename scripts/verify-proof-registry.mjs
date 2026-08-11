#!/usr/bin/env node
// Proof for KAN-141: a verify script cannot be retired without a red check.
//
// THE DEFECT. Every slice that adds a proof adds a line to the `scripts=(...)`
// array in the `verify` job of `.github/workflows/ci.yml`. That array is the
// one line every concurrent slice touches, and it conflicted SIX times in one
// evening — four of them on the same PR:
//
//   #15 after T5, again after T9, a third time after KAN-136, a fourth after T2
//   #17 after T5, where ci.yml was the ONLY conflicting file in an otherwise
//       clean PR — a thirty-second resolution, which is exactly the kind
//       nobody slows down for
//   #16 after T9
//
// Resolving such a hunk by taking one side rather than the union silently and
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
// WHAT THIS DOES NOT SEE. The proof set comes from `git ls-files`, so a
// verify script that has never been `git add`ed is neither run nor flagged by
// this check. That is deliberate rather than overlooked: an uncommitted file
// is not part of the repository, it reaches no reviewer and no runner, and the
// hazard above is a merge resolution — which by definition only happens to
// tracked files. It is written down here so the boundary is a decision on the
// record instead of a gap somebody rediscovers.
//
// Needs no daemon, no herdr, no network and no build: it reads `ci.yml` and
// asks git what is tracked. Exits non-zero on any failure so a reviewer can
// re-run it against the PR head.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAnywhere, findRunInvocations } from './ci-workflow.mjs';

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
    script: 'verify-agy-reads-what-we-write',
    reason:
      'Needs a real `agy` binary, which no GitHub runner has and which cannot be installed on one ' +
      'unattended — it is distributed by Google and gated behind an account. The script fails ' +
      'rather than skipping when agy is absent, deliberately, so it can never go green on a ' +
      'machine that could not run it. WHY IT IS WORTH THE HAND-RUN: it is the only proof in this ' +
      'repository whose assertion CrabCast cannot satisfy by behaving correctly. Every other agy ' +
      'proof writes a file and reads it back, which is exactly how the write path stayed wrong ' +
      'through three merged slices (KAN-140, KAN-178 and their proofs were all green while every ' +
      'agy agent received nothing). This one asserts that a real agy STARTS a server CrabCast ' +
      'defined, so the evidence is a process another program chose to spawn. It also carries the ' +
      'sabotage run: the same steps against a build using the pre-KAN-235 path, where agy starts ' +
      'nothing. ' +
      'WHAT THE EXCLUSION COSTS, AND WHAT PARTIALLY COVERS IT — recorded here so this entry and ' +
      'its counterpart point AT each other rather than each assuming the other has it. Because ' +
      'nothing in the CI array runs a real agy, a silent revert of the path was invisible to CI: ' +
      'measured, with `agyMcpConfigPath` reverted, verify-agy-mcp-write-refusals and ' +
      'verify-agy-mcp-reversal both exited 0, ALL PASS. verify-agy-mcp-write-refusals §0 now ' +
      'closes that specific hole by comparing the path against a LITERAL typed into the proof, so ' +
      'a change to it goes red in CI. THAT GUARD DEPENDS ON THIS SCRIPT and does not replace it: ' +
      'it makes a path change loud, while only a real agy starting a real server can say the ' +
      'literal is RIGHT. A wrong path edited in both places at once passes the guard. So this ' +
      'exclusion is the reason that hand-run remains obligatory before merging any change to the ' +
      'path, and deleting this script would leave the literal an unverified assumption.',
    evidence:
      'scripts/verify-agy-reads-what-we-write.mjs:1 runs a real agy under a scratch $HOME; §1 exits non-zero when no agy is on PATH'
  },
  {
    script: 'verify-proof-verdicts',
    reason:
      'Runs from its own CI job (`proof-verdicts`) instead of this array, and the reason ' +
      'is §4\'s, applying here more directly than it does to this file. This array is not merely ' +
      'where that script would sit — it is part of that script\'s SUBJECT: it asserts that every ' +
      'tracked proof has a verdict-derived exit and a call site able to reach it, which is a claim ' +
      'about the same list. Listed among the proofs it audits, the one edit it exists to catch — a ' +
      'merge resolution dropping an entry — could drop the auditor with it, and the tree would go ' +
      'green with nothing watching. A separate named job is a separate region of ci.yml that the ' +
      'array\'s conflict hunk does not reach. WHAT MAKES THE EXCLUSION SAFE IS A PREMISE THIS ' +
      'REPOSITORY CANNOT VERIFY: that `proof-verdicts` is among the branch\'s required status ' +
      'checks. That list is GitHub branch-protection state (`required_status_checks.contexts`), ' +
      'not anything in this tree, so no check here can confirm or refute it — an earlier draft of ' +
      'this entry asserted it flatly and was false at the moment it was written. Excluded but ' +
      'non-gating, this job would run, go red, and leave the merge button green. Note the axis ' +
      'cuts the other way too: a required context can be removed by a settings toggle with no ' +
      'diff, no review and no artefact in the tree, which is a quieter edit than the array hunk ' +
      'this exclusion exists to survive. KAN-210 tracks that gap. Do not \'fix\' this by adding ' +
      'it to the array.',
    evidence: 'scripts/verify-proof-verdicts.mjs:7 asserts its own wiring — not in the array, own named job, job invokes it'
  },
  {
    script: 'verify-no-attach-steal',
    reason:
      'Attaches to a live agent. The KAN-16 property — a second spawnSession does not evict the ' +
      'first client — only exists where there is a real PTY still streaming to steal, so the ' +
      'assertion has no meaning against a stub. Since KAN-137 it also measures the machine on ' +
      'either side of itself, asserting that the herdr pane it spawned is gone at exit and that ' +
      'no butchr-* pane moved; that census is a real herdr\'s, which is a machine state and not ' +
      'a fixture.',
    evidence: 'scripts/verify-no-attach-steal.mjs:10 the failure it catches is a run that reports PASS while leaving a live herdr pane behind'
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
    script: 'verify-send-confirms-delivery-live',
    reason:
      'Needs a real herdr AND a real Claude Code agent, for two facts neither of which a stub ' +
      'can hold. (1) What a REAL composer looks like: COMPOSER_MARKERS is the load-bearing ' +
      'assumption of the whole delivery mechanism — everything else in delivery.ts is arithmetic ' +
      'over where that marker is — and its CI sibling cannot test it, because a shimmed pane ' +
      'renders the marker it is then checked against. (2) A GENUINELY CONTENDED RECIPIENT: the ' +
      'only state send_to_agent exists for. §1b drives all three — idle, mid-task, and blocked ' +
      'in a shell command — and a shim has no turn to be busy in, so the contended case cannot ' +
      'be reproduced on a runner at all. It also measures Claude Code\'s real hard-wrapping of ' +
      'the echo, which is why flattening exists, and that the interrupt TERMINATES an in-flight ' +
      'tool call, which is what the tool description\'s narrowed safety sentence rests on. It ' +
      'starts one Claude agent and closes it; its output goes on the PR (KAN-114).',
    evidence: 'scripts/verify-send-confirms-delivery-live.mjs:12 two facts a shimmed pane cannot hold: the real marker, and a recipient that is genuinely busy'
  },
  {
    script: 'verify-tail-source-boundary-live',
    reason:
      'Needs a real herdr server and a real terminal pane, for the one fact its CI sibling ' +
      'structurally cannot hold: THAT HERDR REALLY ANSWERS "" FOR A PANE WITH TEXT ON IT. ' +
      '`verify-tail-asks-every-source` shims herdr, so every empty read it asserts on is a read ' +
      'that script wrote — if the premise were false or had been fixed upstream, it would still ' +
      'pass every section while the fallback in `tailAgent` guarded nothing. That is the KAN-145 ' +
      'shape (two green scripts with the gap between them), and this exclusion is the reason the ' +
      'hand-run is obligatory rather than nice to have. It also needs a real pane for the two ' +
      'measurements no stub can supply: the GRID GEOMETRY that makes the boundary predictable ' +
      '(`tput lines` in the pane, boundary = rows - content rows, predicted before it is ' +
      'measured), and what herdr does to a pane whose process is KILLED — which is how the old ' +
      'docblock\'s claim that `recent-unwrapped` shows a dead agent\'s frozen last frame was ' +
      'refuted rather than argued with. Costs one shell pane and no tokens; output goes on the ' +
      'PR (KAN-98).',
    evidence: 'scripts/verify-tail-source-boundary-live.mjs:7 the premise its shimmed sibling cannot establish; §4 kills a pane process and reads all three sources'
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
    script: 'verify-pty-payload-refusal',
    reason:
      'Private herdr server plus a real PTY, and unlike its sibling it cannot degrade to a ' +
      'herdr-less mode. The payload check sits BEHIND the session check — a request wrong in both ' +
      'ways is still answered with the session refusal, as it always was — so the refusal this ' +
      'proof is about is unreachable until the daemon holds a session it really issued. Without ' +
      'herdr there is no session, nothing to refuse, and a "skipped" run would be a green one that ' +
      'checked the subject not at all; it exits non-zero instead. Its §6 also reads keystrokes ' +
      'back off a real pane, which is the check that separates "malformed payloads are refused" ' +
      'from "everything is refused", and a pane is the only thing that can answer it.',
    evidence:
      'scripts/verify-pty-payload-refusal.mjs:163 the payload refusal is unreachable without a real session, so §1 exits non-zero rather than skipping when no herdr is on PATH'
  },
  {
    script: 'verify-herdr-release',
    reason:
      'Needs a herdr release BINARY that the caller downloaded, named on the command line, plus a ' +
      'private server started from it and real panes. It is the only proof in this suite that runs ' +
      'against a herdr other than the one on PATH — which is the whole point of it, and which no ' +
      'runner can do: there is no herdr on a GitHub runner to be other than. It also takes an ' +
      'expected verdict (--expect supported|spawn-broken), so a single CI invocation would have to ' +
      'pick a release and an answer, and the answer is exactly what a human is running it to find ' +
      'out. Its output goes on the pull request that changes README.md\'s version table, because ' +
      'that table is the thing it is evidence for.',
    evidence: 'scripts/verify-herdr-release.mjs:63 the herdr on this machine\'s PATH is running a live fleet, so the release under test is downloaded and run out-of-place'
  },
  {
    script: 'verify-spawn-failure-legibility',
    reason:
      'Private herdr server, real panes and `prlimit`. The KAN-24 defect was that a REFUSED ' +
      '`herdr agent start` was reported as success, so the proof needs a real server that can ' +
      'genuinely refuse; a stub that returns a refusal shape is asserting the fixture, not the ' +
      'bridge. Since KAN-197 its §2 also runs the same refusal through a build with the fix taken ' +
      'out, which needs the refusal to be real for the same reason twice over — a mutant that ' +
      'reports nothing because nothing was refused looks exactly like one that swallowed a refusal.',
    evidence: 'scripts/verify-spawn-failure-legibility.mjs:68 runs against a private herdr server on its own socket'
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
//
// LIVE, not merely present. Round 1 asserted this with a regex over the raw
// file, which passed on a commented-out invocation (citing the comment's line
// as evidence) and on `if: false`. Neither is sabotage-shaped — commenting a
// job out to iterate and forgetting to restore it is an ordinary Tuesday — so
// the question is now asked structurally, via scripts/ci-workflow.mjs: is
// this the `run` value of a step that will actually execute?
//
// Since KAN-148 that question is asked PER BLOCK rather than per line. The
// run value is lexed and parsed as shell, and the invocation counts only when
// it is the command name of a simple command at the top level of the block —
// so a multi-line `if` guard, a heredoc body, an uncalled function, a
// `$( … )` capture or a subshell with a `|| true` after its closing paren are
// each reported as the kind of not-live they are, rather than read as
// coverage.
//
// What this still does not claim: that the job is a REQUIRED context in
// branch protection. That lives in repository settings, which no check in the
// tree can read. A live step proves this audit runs and can go red, not that
// a red one blocks a merge.
// ---------------------------------------------------------------------------

console.log('\n=== 4. This check runs in CI, from outside the list it audits ===\n');

const invocation = new RegExp(`node\\s+scripts/${SELF}\\.mjs`);
const outsideArray = (line) => !arrayRegion || line < arrayRegion.start || line > arrayRegion.end;
const invocations = findRunInvocations(yaml, invocation).filter((f) => outsideArray(f.line));
const live = invocations.filter((f) => f.position === 'command' && f.disabled.length === 0);
const disabled = invocations.filter((f) => f.position === 'command' && f.disabled.length > 0);
// A real command, but buried where it may not run or where its exit status
// cannot get out: a conditional or loop body, a function body, a `$( … )`
// capture (KAN-148).
const buried = invocations.filter((f) => f.position === 'nested');
// Mentioned but never executed — `echo "node …"`, `bash -c '…'`, a wrapper,
// a heredoc body.
const mentioned = invocations.filter((f) => f.position === 'argument');

// Diagnostic for the exact confusion round 1 shipped: the text is there, the
// step is not. Saying "not found" over a file that visibly contains the string
// sends a reader looking in the wrong place.
const textAt = findAnywhere(yaml, invocation).filter(outsideArray);

const cite = (rows) => `ci.yml:${rows.map((f) => f.line).join(', ci.yml:')}`;

check(
  live.length > 0,
  `${workflow} runs \`node scripts/${SELF}.mjs\` from a live step of its own`,
  live.length
    ? live.map((f) => `ci.yml:${f.line} in job '${f.job}'`).join(', ')
    : disabled.length
      ? `the invocation is at ${cite(disabled)} but does not gate CI — ` +
        `${disabled.flatMap((f) => f.disabled).join('; ')}.`
      : buried.length
        ? `at ${cite(buried)} the invocation is BURIED — ${buried.map((f) => f.note).join('; ')}. ` +
          'It has to begin a command at the top level of the `run:` block, so that it runs every ' +
          'time and its exit status reaches the build. Nothing in CI reliably executes this audit.'
        : mentioned.length
          ? `at ${cite(mentioned)} the name never begins a command — ${mentioned.map((f) => f.note).join('; ')}. ` +
            'Nothing in CI executes this audit.'
          : textAt.length
            ? `the text appears at ci.yml:${textAt.join(', ci.yml:')} but not as a step at all — ` +
              'commented out, or not a `run:` value. Nothing in CI executes this audit.'
            : 'nothing in CI runs this audit — it proves nothing where it matters'
);

// A disabled or buried invocation is a distinct failure from an absent one,
// and a worse one: the file still reads like the audit is wired.
check(
  disabled.length === 0 && buried.length === 0,
  'and nothing switches it off, swallows its exit status, or buries it in a construct that may not run',
  [
    ...disabled.map((f) => `ci.yml:${f.line} — ${f.disabled.join('; ')}`),
    ...buried.map((f) => `ci.yml:${f.line} — ${f.note}`)
  ].join(' | ')
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
