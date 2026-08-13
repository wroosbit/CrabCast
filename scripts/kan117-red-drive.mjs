#!/usr/bin/env node
// KAN-117 RED DRIVE — does Butchr's live proof actually go red when CrabCast
// breaks, and does it NAME the behaviour?
//
// WHAT FAILURE THIS WOULD CATCH: `verify-crabcast-runtime-live.mjs` is the one
// script in Butchr's tree that drives a real CrabCast daemon, and KAN-117 is
// about wiring it in as a REQUIRED check on our PRs. A required check that
// cannot fail is the specific outcome that ticket exists to prevent — "a green
// check that cannot fail is worse than no check". This drive breaks CrabCast in
// three ways that script claims to catch and asserts each one turns a PASSING
// check into a FAILING one. If an arm stays green, that arm of the gate is
// hollow and the drive says so.
//
// THIS IS NOT A PROOF AND IT IS NOT IN THE CI ARRAY, exactly like
// `kan369-red-drive.mjs` and `kan114-send-before-and-after.mjs`: it is a one-off
// demonstration whose output belongs in a pull request rather than in a gate. It
// needs a real herdr and spawns real panes, so it could not run on a CI runner
// anyway — `verify-crabcast-runtime-live.mjs:15` says `CI-RUNNABLE: no` and
// means it.
//
// ── WHAT THIS DRIVE DOES *NOT* COVER, named rather than left to inference ───
//
// KAN-117's AC1 asks for the job to run "from a runner with no herdr
// installed". THIS DRIVE IS NOT EVIDENCE FOR THAT. It runs on a developer
// machine, with a real herdr, against a daemon it starts by hand. Whether the
// same red appears on a CI runner against a CI-built daemon is a different
// environment and nothing here observes it. **A red seen locally is not the gate
// going red.** That join belongs to KAN-117's Task 3 and is currently unowned.
//
// It also supplies its own peer: the daemon under test is one this script
// starts. So it does not test that CI would start one correctly, which is the
// same class of gap as a proof that supplies its own input.
//
// ── WHY IT NEVER TOUCHES THE RUNNING SERVICE ───────────────────────────────
//
// Every daemon it starts gets its own `dataDir`, hence its own socket and its
// own `agents.jsonl`. `crabcast.service` is never stopped, restarted or
// reconfigured, and `~/.local/share/crabcast/agents.jsonl` is never read or
// written by this script. Each daemon also gets a scratch `$HOME`, so the panes
// it spawns cannot collide with the live fleet's.
//
// Usage:
//   npm run build
//   node scripts/kan117-red-drive.mjs                      # control + every arm
//   node scripts/kan117-red-drive.mjs --list               # names, run nothing
//   node scripts/kan117-red-drive.mjs --only detach-renamed
//   node scripts/kan117-red-drive.mjs --butchr /path/to/butchr
//
// `--only` exists because each arm costs a full run of the proof (~60-90s) and
// the whole drive is several minutes; a reviewer re-running one arm should not
// have to pay for all of them. The full drive is what the pull request pastes.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx === -1 ? null : argv[onlyIdx + 1];
const butchrIdx = argv.indexOf('--butchr');
const BUTCHR = butchrIdx === -1
  ? path.join(os.homedir(), 'code/wroosbit/butchr')
  : path.resolve(argv[butchrIdx + 1]);
const PROOF = path.join(BUTCHR, 'daemon/scripts/verify-crabcast-runtime-live.mjs');

let failures = 0;
const notes = [];

/**
 * The one check every mutant reds for free — see the note at the end of each
 * arm. Named here so the drive can say so rather than let a reader count it as
 * evidence the mutation produced.
 */
const COLLATERAL = 'the peer identified its build over the wire';

function rule(title) {
  console.log(`\n${'━'.repeat(76)}\n${title}\n${'━'.repeat(76)}`);
}
function pass(label, detail) {
  console.log(`  PASS  ${label}${detail ? `\n        ${detail}` : ''}`);
}
function fail(label, detail) {
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the arms ───────────────────────────────────────────────────────────────
//
// Each arm names the CONSUMER BEHAVIOUR it breaks and the check in Butchr's
// proof that must notice. Every mutation is a RENAME rather than a deletion:
// the daemon still starts, still answers, still spawns a real agent, and the
// only thing that changed is a name a consumer reads. A crash would red any
// check at all and would prove nothing about this one.

const ARMS = [
  {
    name: 'detach-renamed',
    behaviour: 'a dead agent stops rendering as a live one',
    file: 'daemon.js',
    // MUTATED AT THE BROADCAST FUNNEL RATHER THAN AT THE ONE EMIT SITE, and
    // the first attempt at this arm is why. Renaming only
    // `broadcast({ action: 'agent.detached', … })` in `daemon.js` left the arm
    // GREEN — not because the gate is hollow but because
    // `crabcast-runtime.ts:1442` fires the consumer's listener on EITHER
    // `agent.detached` OR `agent.deactivated`, and the proof's §5 reaches
    // teardown through `terminateSession`, which emits the second. The
    // mutation applied perfectly and landed on a redundant path — exactly the
    // case `mutation.mjs` warns it cannot detect and hands to the caller.
    // Renaming both at the funnel is what makes this arm answer the question
    // it was written to ask.
    find: `const broadcast = (msg) => {
    const { onContract, frame } = events.stamp(msg);`,
    replace: `const broadcast = (msg) => {
    if (typeof msg?.action === 'string' && msg.action.startsWith('agent.de')) msg = { ...msg, action: \`\${msg.action}.v2\` };
    const { onContract, frame } = events.stamp(msg);`,
    expect: 'setSessionEndedListener fired',
    wire: {
      gone: ['agent.detached', 'agent.deactivated'],
      arrived: ['agent.detached.v2', 'agent.deactivated.v2']
    }
  },
  {
    name: 'tail-source-renamed',
    behaviour: "the tail's read-source vocabulary stays the one the consumer knows",
    file: 'herdr.js',
    // MUTATED AT THE REPORTED VALUE RATHER THAN AT `TAIL_SOURCES`, for the same
    // reason as the arm above. Renaming the first entry of
    // `TAIL_SOURCES = ['recent-unwrapped', 'visible']` left the arm GREEN:
    // herdr refuses the unknown source, the loop falls through to `visible` —
    // which Butchr DOES recognise — and the reported vocabulary never actually
    // diverged. The fallback is correct behaviour and the mutation was simply
    // testing the wrong thing. Renaming the value on the way out keeps the read
    // succeeding with real pane text and diverges only the name, which is the
    // contract drift this check exists to catch.
    find: `                    source,
                    sourcesTried: [...tried]`,
    replace: `                    source: \`\${source}-v2\`,
                    sourcesTried: [...tried]`,
    expect: 'source names one of OUR two read sources'
  },
  {
    name: 'channel-verdict-dropped',
    behaviour: "the spawn's channel verdict arrives on activate_response",
    file: 'router.js',
    find: `            // reporting a decision no later call will be able to confirm.
            channelEnabled: channelEnabledOf(this.deps.agentRegistry.intents().get(agentPath)),`,
    replace: `            // reporting a decision no later call will be able to confirm.
            channelEnabledRenamed: channelEnabledOf(this.deps.agentRegistry.intents().get(agentPath)),`,
    // THE SHARPEST OF THE THREE. Butchr's own §4b says this surface sits
    // OUTSIDE CrabCast's read-path contract, so CrabCast's CI can stay green
    // through exactly this change. If any arm justifies the gate, it is this
    // one: nothing on our side would catch it.
    expect: 'the field ARRIVED'
  }
];

if (listOnly) {
  for (const a of ARMS) console.log(`${a.name.padEnd(26)} ${a.behaviour}`);
  process.exit(0);
}

// ── setup guards (NOT verdicts) ────────────────────────────────────────────
if (!fs.existsSync(distDir)) {
  console.error(`setup: no build at ${distDir}. Run \`npm run build\` first. Nothing was attempted.`);
  process.exit(1);
}
if (!fs.existsSync(PROOF)) {
  console.error(
    `setup: Butchr's proof is not at ${PROOF}.\n` +
      `Pass --butchr <path to a butchr checkout>. Nothing was attempted.`
  );
  process.exit(1);
}

// A build older than the source it came from would make every verdict below
// evidence about code nobody wrote. Cheap to check, and the reason it is here
// is that a stale `dist` produces a completely plausible run.
{
  const distStamp = fs.statSync(path.join(distDir, 'daemon.js')).mtimeMs;
  const stale = fs
    .readdirSync(path.join(repoRoot, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => fs.statSync(path.join(repoRoot, 'src', f)).mtimeMs > distStamp);
  if (stale.length) {
    console.error(
      `setup: ${stale.length} source file(s) are NEWER than dist/daemon.js ` +
        `(${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''}).\n` +
        `The drive would run against a build that does not contain them. Run \`npm run build\`.`
    );
    process.exit(1);
  }
}

// Short root: a unix socket address holds at most 104 characters and
// `config.ts` refuses a dataDir that would overrun it. `os.tmpdir()` keeps the
// path short enough; the repo tree would not.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan117-'));

// A MUTANT MUST BE ABLE TO RESOLVE `node-pty`, and this is the second thing
// that went wrong writing this drive rather than a precaution. Copied outside
// the repo, the mutant build died at import with ERR_MODULE_NOT_FOUND — which
// looks, from the outside, exactly like a well-behaved mutant that changed
// nothing. The symlink is why the mutants may live outside the tree at all.
fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: { pass: (l, d) => pass(l, d), fail: (l, d) => fail(l, d) }
});

process.on('exit', () => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

// ── one run of Butchr's proof against an isolated daemon of a given build ───

/** @returns {{checks: Map<string, boolean>, exit: number|null, status: object|null, error?: string}} */
async function runProofAgainst(buildDir, label) {
  const runRoot = path.join(scratch, `run-${label}`);
  const dataDir = path.join(runRoot, 'd');
  const scratchHome = path.join(runRoot, 'h');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(scratchHome, { recursive: true });

  const configPath = path.join(runRoot, 'crabcast.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const sock = path.join(dataDir, 'crabcast.sock');
  const errFile = path.join(runRoot, 'daemon.err');

  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(buildDir, 'daemon.js'), configPath], {
    env: { ...process.env, HOME: scratchHome },
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !fs.existsSync(sock)) await sleep(150);

  if (!fs.existsSync(sock)) {
    return {
      checks: new Map(),
      exit: null,
      status: null,
      error:
        `the daemon never opened its socket, so this build never ran.\n` +
        fs.readFileSync(errFile, 'utf8').slice(0, 1200)
    };
  }

  // THE PRECONDITION THAT THIS BUILD REALLY RAN. `mutation.mjs` warns that a
  // mutant which dies produces exactly the observation a well-behaved one
  // produces — nothing happened — so every section that spawns one owes an
  // assertion that it is really there. Note `action`, not `type`: sending
  // `type` returns `Unknown action: undefined`, a frame that parses, carries
  // the right id and answers nothing.
  let status = null;
  try {
    status = await new Promise((resolve, reject) => {
      const s = net.connect(sock);
      let buf = '';
      s.on('error', reject);
      s.on('connect', () => s.write(JSON.stringify({ id: 1, action: 'daemon_status' }) + '\n'));
      s.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) { s.end(); resolve(msg); }
        }
      });
      setTimeout(() => { s.destroy(); reject(new Error('daemon_status timed out')); }, 15_000);
    });
  } catch (err) {
    status = { success: false, error: String(err?.message ?? err) };
  }

  if (!status || status.success === false || status.error) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    return {
      checks: new Map(),
      exit: null,
      status,
      error: `daemon_status did not answer: ${JSON.stringify(status)}`
    };
  }

  // A WIRE WITNESS, so "the mutation took effect" is OBSERVED rather than
  // inferred from having edited a file. `broadcast` writes every event to every
  // connected socket, so an idle connection is a complete record of what this
  // daemon published while the proof ran. Without this, an arm that stays green
  // has two explanations — the gate is hollow, or the mutation never reached the
  // wire — and reading the source cannot tell them apart.
  const actionsSeen = new Set();
  const witness = net.connect(sock);
  witness.on('error', () => {});
  {
    let wbuf = '';
    witness.on('data', (c) => {
      wbuf += c.toString();
      let i;
      while ((i = wbuf.indexOf('\n')) !== -1) {
        const line = wbuf.slice(0, i);
        wbuf = wbuf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line);
          if (typeof f.action === 'string') actionsSeen.add(f.action);
        } catch {}
      }
    });
  }

  // ASYNC `spawn`, NOT `spawnSync`, AND THE WITNESS IS THE REASON. `spawnSync`
  // blocks the event loop for the whole run, so the socket above would never
  // process a byte and would report "no events published" for a daemon that
  // published plenty. That is what the first version of this did, and the
  // wire assertion is the only reason it was caught rather than written up.
  const proof = await new Promise((resolve) => {
    const p = spawn(process.execPath, [PROOF], {
      cwd: BUTCHR,
      env: {
        ...process.env,
        BUTCHR_CRABCAST_SOCKET: sock,
        KAN278_PROBE_KEY: `kan-117-${label}`,
        HOME: scratchHome
      }
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 300_000);
    p.on('close', (code) => { clearTimeout(killer); resolve({ status: code, stdout, stderr }); });
  });

  try { witness.destroy(); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  await sleep(800);
  try { process.kill(child.pid, 'SIGKILL'); } catch {}

  const out = `${proof.stdout ?? ''}\n${proof.stderr ?? ''}`;
  fs.writeFileSync(path.join(scratch, `proof-${label}.log`), out);

  // `PASS`/`FAIL` are emitted by the proof's own `check()`; the label is the
  // rest of the line.
  const checks = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s{2,}(PASS|FAIL)\s{2}(.+?)\s*$/.exec(line);
    if (m) checks.set(m[2], m[1] === 'PASS');
  }
  return { checks, exit: proof.status, status, actions: actionsSeen };
}

/** The proof's labels are long; match on the distinctive fragment each arm names. */
function findCheck(checks, fragment) {
  for (const [label, ok] of checks) if (label.includes(fragment)) return { label, ok };
  return null;
}

// ── 0. control ─────────────────────────────────────────────────────────────
rule('0. CONTROL — the unmutated build, so every arm has a baseline to move');

const control = await runProofAgainst(distDir, 'control');
if (control.error) {
  fail('the control run produced a usable result', control.error);
  console.log('\nAbandoning: with no baseline, no arm below could be interpreted.\n');
  process.exit(1);
}

console.log(
  `  peer contractVersion=${control.status.contractVersion} pid=${control.status.pid}\n` +
    `  proof exit=${control.exit}, ${control.checks.size} checks parsed`
);

// THE CONTROL'S WIRE, printed because it is the comparison that makes the
// detach arm's verdict readable. If an event never appears here, no arm that
// renames it can be expected to change anything — and a check that passes
// anyway was never reading that event.
console.log(`  events published by the UNMUTATED daemon: ${JSON.stringify([...control.actions])}`);

if (control.checks.size === 0) {
  fail('the control run produced parseable checks', 'no PASS/FAIL lines were found in the output');
  process.exit(1);
}
pass('the control run produced parseable checks', `${control.checks.size} of them`);

const baselineRed = [...control.checks].filter(([, ok]) => !ok).map(([l]) => l);
if (baselineRed.length) {
  console.log(`\n  NOTE — ${baselineRed.length} check(s) are ALREADY RED unmutated:`);
  for (const l of baselineRed) console.log(`         · ${l}`);
  console.log(
    `  These are pre-existing and are NOT evidence produced by this drive. Each arm\n` +
      `  below is judged only on a check that was GREEN in this control run.`
  );
  notes.push(
    `${baselineRed.length} check(s) fail against an unmutated build: ${baselineRed.join(' | ')}`
  );
}

// ── the arms ───────────────────────────────────────────────────────────────
const selected = only ? ARMS.filter((a) => a.name === only) : ARMS;
if (only && selected.length === 0) {
  console.error(`\nno arm named "${only}". Known: ${ARMS.map((a) => a.name).join(', ')}`);
  process.exit(1);
}

const summary = [];

for (const arm of selected) {
  rule(`ARM "${arm.name}" — breaks: ${arm.behaviour}`);

  const before = findCheck(control.checks, arm.expect);

  // AN ARM WHOSE TARGET WAS ALREADY RED PROVES NOTHING, and silently counting
  // it as a success is the inversion this whole ticket is about.
  if (!before) {
    fail(
      `${arm.name}: the proof has a check matching "${arm.expect}"`,
      `no check in the control run matched. The proof may have been rewritten; this arm ` +
        `cannot be interpreted and is NOT a pass.`
    );
    summary.push({ arm: arm.name, verdict: 'UNINTERPRETABLE' });
    continue;
  }
  if (!before.ok) {
    fail(
      `${arm.name}: its target check is GREEN before mutating`,
      `"${before.label}" is already red unmutated, so turning it red proves nothing. ` +
        `Pick a different check for this arm.`
    );
    summary.push({ arm: arm.name, verdict: 'NO BASELINE' });
    continue;
  }
  pass(`${arm.name}: its target check is GREEN before mutating`, `"${before.label}"`);

  const mutantDir = mutate(arm.name, arm.file, arm.find, arm.replace);
  if (!mutantDir) {
    // Already counted by the mutator, which also explains what to fix.
    summary.push({ arm: arm.name, verdict: 'MUTATION DID NOT APPLY' });
    continue;
  }

  const run = await runProofAgainst(mutantDir, arm.name);
  if (run.error) {
    fail(
      `${arm.name}: the mutant daemon ran`,
      `${run.error}\nA mutant that dies looks exactly like one that changed nothing, so this ` +
        `is counted as a failure of the drive rather than as a red.`
    );
    summary.push({ arm: arm.name, verdict: 'MUTANT DID NOT RUN' });
    continue;
  }
  pass(`${arm.name}: the mutant daemon ran`, `pid=${run.status.pid}, ${run.checks.size} checks`);

  // THE MUTATION REACHED THE WIRE — asserted for arms that name a wire effect,
  // because a green arm is uninterpretable without it. `wire.gone` must have
  // stopped appearing and `wire.arrived` must have started.
  if (arm.wire) {
    const seen = [...run.actions];
    const goneStill = seen.filter((a) => arm.wire.gone.includes(a));
    const arrived = seen.filter((a) => arm.wire.arrived.includes(a));
    const controlHadIt = arm.wire.gone.some((a) => control.actions.has(a));
    if (arrived.length && !goneStill.length) {
      pass(
        `${arm.name}: the rename is OBSERVED on the wire, not merely edited into a file`,
        `published ${JSON.stringify(arrived)}; none of ${JSON.stringify(arm.wire.gone)} appeared`
      );
    } else if (!controlHadIt) {
      // NOT A FAILURE OF THE MUTATION — a fact about the scenario, and the more
      // interesting of the two. The unmutated daemon never published this event
      // either, so the proof's teardown never involved it. Renaming something
      // that is never emitted cannot change an outcome, which means a check
      // that passes here was never reading this event at all.
      pass(
        `${arm.name}: the wire is WITNESSED, and it explains the arm`,
        `neither the control nor the mutant published any of ${JSON.stringify(arm.wire.gone)}.\n` +
          `        control published ${JSON.stringify([...control.actions])}\n` +
          `        mutant  published ${JSON.stringify(seen)}\n` +
          `        So this scenario never carries that event, and any check that passes\n` +
          `        through it is satisfied WITHOUT CrabCast's participation.`
      );
      notes.push(
        `${arm.name}: the events ${JSON.stringify(arm.wire.gone)} were never published by ` +
          `EITHER build during the proof's teardown; the target check is satisfied locally.`
      );
    } else {
      fail(
        `${arm.name}: the rename is OBSERVED on the wire`,
        `arrived=${JSON.stringify(arrived)} still-present=${JSON.stringify(goneStill)}. ` +
          `Without this the arm's verdict cannot be read: a green check could mean the gate ` +
          `is hollow OR that the mutation never took effect.\n        ` +
          `actions published this run: ${JSON.stringify(seen)}`
      );
    }
  }

  const after = findCheck(run.checks, arm.expect);
  if (!after) {
    fail(`${arm.name}: the target check still ran`, `nothing matched "${arm.expect}" in the mutant run`);
    summary.push({ arm: arm.name, verdict: 'CHECK VANISHED' });
    continue;
  }

  // THE ASSERTION THIS SCRIPT EXISTS FOR.
  if (after.ok) {
    fail(
      `${arm.name}: THE GATE STAYED GREEN THROUGH A DELIBERATE BREAK`,
      `"${after.label}" still passed with ${arm.behaviour} broken.\n        ` +
        `This arm of the gate is HOLLOW — report it loudly rather than quietly re-rolling.`
    );
    summary.push({ arm: arm.name, verdict: 'STAYED GREEN — HOLLOW' });
  } else {
    pass(
      `${arm.name}: the gate went RED, and the failing check NAMES the behaviour`,
      `"${after.label}"`
    );
    summary.push({ arm: arm.name, verdict: 'RED', label: after.label });
  }

  // Exit code is a separate claim from the check line: a proof can print FAILED
  // and still exit 0, which is the defect KAN-117's own comments catalogue.
  if (run.exit === 0) {
    fail(
      `${arm.name}: the proof's EXIT CODE reports the failure`,
      `a check failed and the script exited 0 — a human reading the output sees a failure ` +
        `while any automated read sees success. A required check is read by exit code.`
    );
  } else {
    pass(`${arm.name}: the proof's EXIT CODE reports the failure`, `exit=${run.exit}`);
  }

  // A break that reds EVERYTHING is a crash, not a contract drift, and it would
  // make this drive look better than it is.
  const newlyRed = [...run.checks]
    .filter(([l, ok]) => !ok && control.checks.get(l) === true)
    .map(([l]) => l);
  console.log(`        newly-red checks (${newlyRed.length}): ${newlyRed.join(' | ') || 'none'}`);

  // COLLATERAL, DISCLOSED RATHER THAN QUIETLY ENJOYED. Every mutant reds
  // "the peer identified its build over the wire", and it is not this arm's
  // doing: `mutate` rewrites a file inside the copied build, which makes that
  // file NEWER than the `build-stamp.json` beside it, and `provenance.ts`
  // deliberately disbelieves a stamp whose code has been overwritten. So
  // CrabCast correctly disowns the mutant's provenance and answers no commit.
  // That is our own honesty machinery firing, working exactly as designed —
  // and it means this one red is available to EVERY arm for free. No arm is
  // judged on it: each is judged only on the specific check it named.
  if (newlyRed.includes(COLLATERAL) && !newlyRed.filter((l) => l !== COLLATERAL).length) {
    console.log(
      `        NOTE: the only newly-red check is the build-provenance one, which every\n` +
        `        mutant reds by construction. This arm produced no red of its own.`
    );
  }
}

// ── verdict ────────────────────────────────────────────────────────────────
rule('SUMMARY');
for (const s of summary) console.log(`  ${s.arm.padEnd(26)} ${s.verdict}`);
if (mutationsSkipped().length) console.log(`\n  mutations skipped: ${JSON.stringify(mutationsSkipped())}`);
for (const n of notes) console.log(`\n  NOTE: ${n}`);

console.log(
  `\n${failures ? `FAILED — ${failures} check(s)` : 'OK — every arm turned a green check red, and the exit code said so'}\n`
);
process.exit(failures ? 1 : 0);
