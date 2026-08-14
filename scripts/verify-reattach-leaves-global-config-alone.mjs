#!/usr/bin/env node
// KAN-173 item 2: a re-attach writes nothing into the user's GLOBAL config —
// the one place a re-provisioning would land that no directory-scoped
// assertion can see.
//
// WHAT FAILURE THIS WOULD CATCH: a restart that routes a surviving agent
// through the SPAWN path instead of the attach path, re-running
// `launcher.setup` for an agent that has been working for an hour. For the
// `claude` launcher that setup writes a folder-trust entry into
// `~/.claude.json` — `projects[<workDir>].hasTrustDialogAccepted` — and it is
// the ONLY artifact of a re-provisioning that lands outside both the agent's
// own directory and CrabCast's sidecar.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS SEPARATELY FROM `verify-restart-survival` §6
// ---------------------------------------------------------------------------
//
// §6 of that file makes exactly this claim about files and observes the bytes
// to prove it — and its own header says what it does not reach:
//
//     "It watches the agent's directory and CrabCast's sidecar. A
//      `launcher.setup` that writes into the user's GLOBAL config — the claude
//      launcher's folder-trust entry is the live example — is outside both, and
//      this section runs the `shell` launcher, which has no such write. Nothing
//      covers that one today."
//
// That was an honest bound, recorded by KAN-170 rather than left implied, and
// this file is the answer to it. TWO things had to change and both are the
// reason it is a separate file rather than a §6b: it runs the CLAUDE launcher
// (the shell launcher has no global write, so §6's own agent could not exercise
// this at all), and it REDIRECTS `HOME` (see the refusal below), which §6 does
// not and must not be made to — every one of its other sections would then be
// asserting about a different machine than the one it was written against.
//
// ---------------------------------------------------------------------------
// ⚠ IT REFUSES TO RUN AGAINST A REAL HOME, AND THAT IS §0
// ---------------------------------------------------------------------------
//
// A proof of "nothing was written to the user's global config" that writes to
// the user's global config to find out is the defect wearing the words of the
// check. `claudeConfigPath()` is `path.join(os.homedir(), '.claude.json')` and
// `os.homedir()` reads `$HOME`, so §0 redirects it into a scratch directory and
// then ASSERTS that the redirection took — by asking the shipped function where
// it now thinks the file is, not by trusting that setting the variable worked.
// A run that cannot establish that stops before it activates anything.
//
// This is not a hypothetical precaution. Measured on this machine on
// 2026-08-14: the user's real `~/.claude.json` carries 701 project keys, 277 of
// them under `/tmp`, and among those are `kan136-restart-*/owned/survivor-claude`,
// `kan127-idem-*/owned/claude/*` and `kan125-*/owned/s3/*` — scratch
// directories left by LOCAL runs of this suite's own proofs, whose scratch
// trees were deleted years of machine-time ago and whose trust entries were
// not. CI is unaffected: `.github/workflows/ci.yml` gives every proof its own
// `$HOME`. The residue is a local-run cost, it is filed rather than fixed here,
// and this file's §0 is what stops this proof adding to it.
//
// ---------------------------------------------------------------------------
// WHAT IS ASSERTED, AND WHY EACH HALF IS NEEDED
// ---------------------------------------------------------------------------
//
//   §1  THE SPAWN WRITES IT. Without this, "the re-attach wrote nothing" is
//       trivially true of a file nobody ever writes — the vacuity that §6 of
//       verify-restart-survival calls its load-bearing precondition. The trust
//       key must be ABSENT before and PRESENT after, so the same run watches
//       the artifact appear.
//   §2  THE RE-ATTACH WRITES NOTHING. Bytes identical AND mtime unchanged, with
//       the mtime backdated an hour first so an idempotent rewrite — which
//       produces identical bytes by construction — cannot hide inside mtime
//       granularity. Preconditioned on the re-attach having HAPPENED: the argv
//       log must show `agent attach` and must show no second `agent start`.
//   §2b THE SAME CLAIM WITH ONE OF ITS TWO DEFENCES REMOVED, and this section
//       is here because of what the red drive measured rather than because it
//       was planned. §2 is held by TWO independent mechanisms — the attach path
//       not provisioning, AND `trustClaudeWorkspace` reading before it writes —
//       so §2 alone cannot show the first is doing anything. §2b deletes the
//       trust entry while the agent runs, which takes the second out of play,
//       and asserts the re-attach does not put it back. THAT is the section
//       this file's subject actually lives in.
//   §3  THE INSTRUMENT MOVES. A second agent is activated at a second
//       directory and the same file must gain a key and a new mtime. Without
//       this, §2 is two readings of an instrument nothing has shown can report
//       a difference — and "unchanged" is the answer a frozen detector gives.
//   §4  THE RED DRIVE. `dist/herdr.js` is mutated so `attachSession` calls
//       `initPty` where it called `attachPty` — one line, and it is the whole
//       separation, because `launcher.setup` is called from `initPty`. Under
//       that mutant §2b must go RED and §2 must stay GREEN: the pair is what
//       says which mechanism holds which claim. A first attempt mutated
//       `reconcile.js` instead, on the recipe `src/reconcile.ts` writes down
//       for itself, and the mutant PASSED — recorded in §4 rather than
//       quietly replaced, because the plausible mutation was the wrong one.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER
// ---------------------------------------------------------------------------
//
//   1. THE HERDR IS A STUB this file writes, as every CI-runnable proof here
//      uses. It says nothing about what a real herdr does with an attach.
//      `verify-fleet-switch-live` §3 is the only thing that does.
//   2. IT WATCHES ONE GLOBAL FILE — the claude launcher's. A launcher added
//      tomorrow that writes some other global path is outside this, and
//      nothing enumerates global writes: `LauncherSetupContext.note` is the
//      declaration a launcher makes about what it wrote, and no proof holds a
//      launcher to declaring one. Named here rather than left to be inferred;
//      it is not covered by anything.
//   3. IT SUPPLIES ITS OWN INPUT in the sense KAN-145 warns about — this
//      script configures the agent whose provisioning it then watches. What it
//      does NOT supply is the write: §1 requires the shipped `launcher.setup`
//      to produce the trust entry, and a build in which it did not would fail
//      §1 rather than sail through §2.
//
// Usage:
//   npm run build
//   node scripts/verify-reattach-leaves-global-config-alone.mjs [distDir]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const finish = () => {
  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan173-globalcfg-'));
const realHome = process.env.HOME;
const realPath = process.env.PATH;

// ===========================================================================
// 0. THE REFUSAL. Redirect HOME, then make the SHIPPED function say where it
//    now believes the global config is. Setting the variable is not evidence
//    that anything reads it.
// ===========================================================================

console.log('=== 0. Nothing runs until the real HOME is provably out of reach ===\n');

const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

const { claudeConfigPath, trustKeyFor } = await import(path.join(distDir, 'launchers.js'));
const GLOBAL_CONFIG = claudeConfigPath();

console.log(`  real HOME:      ${realHome}`);
console.log(`  scratch HOME:   ${fakeHome}`);
console.log(`  claudeConfigPath() now answers: ${GLOBAL_CONFIG}\n`);

const redirected =
  GLOBAL_CONFIG.startsWith(fakeHome + path.sep) &&
  path.resolve(GLOBAL_CONFIG) !== path.resolve(realHome ?? '/nonexistent', '.claude.json');
check(
  redirected,
  'the shipped claudeConfigPath() resolves INSIDE this run\'s scratch home',
  redirected
    ? 'so every write below lands in a directory this script created and removes'
    : `it answers ${GLOBAL_CONFIG}, which is not under ${fakeHome}. REFUSING TO CONTINUE: this ` +
      `proof would otherwise write folder-trust entries into a real user's global config, which ` +
      `is the defect it exists to measure.`
);
if (!redirected) finish();

// ===========================================================================
// The harness: a stateful herdr stub, and the daemon pieces under test.
// ===========================================================================

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** A directory the caller already owns, outside any CrabCast data dir. */
function ownedDir(name) {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
const ARGV_LOG = path.join(tmp, 'herdr-argv.log');
const PANE_SEQ = path.join(tmp, 'pane-seq');

// The stub, modelled on `verify-restart-survival`'s and carrying the two
// properties a restart proof needs: `agent start` records a RUNTIME behind the
// pane when the command runs `claude` (that field is the whole difference
// between the launchers as far as `ourPaneIn` is concerned), and `agent attach`
// HOLDS the terminal instead of exiting, so the session does not go
// 'terminated' milliseconds later and take the proof with it.
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/usr/bin/env node
const fs = require('fs');
const CENSUS = ${JSON.stringify(CENSUS_FILE)};
const ARGV_LOG = ${JSON.stringify(ARGV_LOG)};
const PANE_SEQ = ${JSON.stringify(PANE_SEQ)};
const argv = process.argv.slice(2);

// Appended BEFORE any dispatch, so a refused call is as visible in the log as a
// served one. This log is the evidence for "no second \`agent start\` was
// issued across the restart" — asserted, not inferred from a response.
fs.appendFileSync(ARGV_LOG, argv.join(' ') + '\\n');

const panes = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const save = () => fs.writeFileSync(CENSUS, JSON.stringify(panes));
const ok = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const err = (code, message) => {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};

if (argv[0] === 'agent' && argv[1] === 'list') ok({ type: 'agent_list', agents: panes });

if (argv[0] === 'agent' && argv[1] === 'get') {
  const found = panes.find((p) => p.name === argv[2]);
  if (!found) err('agent_not_found', 'no such agent');
  ok({ agent: found });
}

if (argv[0] === 'agent' && argv[1] === 'start') {
  const name = argv[2];
  if (panes.some((p) => p.name === name)) err('agent_name_taken', 'agent name is taken');
  const cwdFlag = argv.indexOf('--cwd');
  const sep = argv.indexOf('--');
  const command = sep === -1 ? '' : argv.slice(sep + 1).join(' ');
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    agent_status: 'working',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1],
    ...(/\\bclaude\\b/.test(command) ? { agent: 'claude' } : {})
  });
  save();
  ok({});
}

if (argv[0] === 'pane' && argv[1] === 'close') {
  const at = panes.findIndex((p) => p.pane_id === argv[2]);
  if (at === -1) err('pane_not_found', 'no such pane');
  panes.splice(at, 1);
  save();
  ok({});
}

if (argv[0] === 'agent' && argv[1] === 'attach') {
  setInterval(() => {}, 60000);
} else if (argv[0] === 'tab' && argv[1] === 'create') {
  ok({ result: undefined, tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } });
} else if (argv[0] === 'pane' && argv[1] === 'list') {
  ok({ panes: [] });
} else {
  ok({});
}
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;
fs.writeFileSync(PANE_SEQ, '0');
fs.writeFileSync(CENSUS_FILE, '[]');
fs.writeFileSync(ARGV_LOG, '');

const resetArgvLog = () => fs.writeFileSync(ARGV_LOG, '');
const herdrCalls = () => {
  try {
    return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const callsMatching = (re) => herdrCalls().filter((l) => re.test(l));

/**
 * The attach is the one herdr call this daemon makes through `pty.spawn`
 * rather than `execSync`, so it lands in the log milliseconds after the call
 * that issued it resolves. Bounded, so a missing call FAILS rather than hangs.
 */
async function waitForCall(re, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (callsMatching(re).length > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The capacity gate reads the real machine, and this file is about a global
 * config file. A proof that depends on the runner's load average is a proof
 * that goes red about the runner.
 */
const PAST_THE_GATE = { override: true };

const openBridges = [];
function newBridge() {
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  openBridges.push(bridge);
  return bridge;
}
function killPtys(bridge) {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
}
function invoke(bridge, registry, events, request) {
  return new Promise((resolve) => {
    new MessageRouter({
      config,
      herdrBridge: bridge,
      daemonStartedAt: new Date(),
      agentRegistry: registry,
      send: (msg) => resolve(msg),
      broadcast: (msg) => events.push(msg)
    }).handle(request);
  });
}

const KNOBS = { priority: 1, refusable: true, chargeable: true, preemptable: true };
const AS_CLAUDE = { ...KNOBS, launcher: 'claude' };

/** The global config as bytes + mtime, or `null` when it is not there at all. */
function snapshotGlobal() {
  if (!fs.existsSync(GLOBAL_CONFIG)) return null;
  const st = fs.statSync(GLOBAL_CONFIG);
  return { bytes: fs.readFileSync(GLOBAL_CONFIG, 'utf8'), mtimeMs: st.mtimeMs };
}
const trustedIn = (snap, dir) => {
  if (!snap) return false;
  try {
    return JSON.parse(snap.bytes)?.projects?.[trustKeyFor(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};

// ===========================================================================
// 1. THE SPAWN WRITES IT — the precondition that keeps §2 from being vacuous.
// ===========================================================================

console.log('\n=== 1. The SPAWN writes the folder-trust entry ===\n');

const dir = ownedDir('survivor-claude');
const paneName = paneNameFor(dir);
const registryFile = path.join(tmp, 'agents.jsonl');

const before = snapshotGlobal();
check(
  !trustedIn(before, dir),
  'the trust key is ABSENT before the agent is activated',
  before === null ? 'the global config does not exist yet' : `key: ${trustKeyFor(dir)}`
);

const registry1 = new AgentRegistry(registryFile);
const bridge1 = newBridge();
registry1.recordConfigured({ path: dir, config: AS_CLAUDE });
resetArgvLog();

const started = await invoke(bridge1, registry1, [], {
  action: 'activate_agent', path: dir, ...PAST_THE_GATE
});

const afterSpawn = snapshotGlobal();
check(
  started.success === true && started.started === true,
  'the agent started under the claude launcher',
  `success=${started.success} started=${started.started} error=${started.error ?? '(none)'}`
);
check(
  trustedIn(afterSpawn, dir),
  'and `launcher.setup` wrote hasTrustDialogAccepted into the GLOBAL config — without this ' +
    'the assertion below would be about a file nobody ever writes to',
  afterSpawn === null
    ? 'the global config still does not exist'
    : `${GLOBAL_CONFIG} — key ${trustKeyFor(dir)}`
);

// ===========================================================================
// 2. THE RE-ATTACH WRITES NOTHING.
// ===========================================================================

console.log('\n=== 2. The RE-ATTACH leaves it byte-for-byte and mtime-for-mtime ===\n');

// Backdated so a rewrite CANNOT hide inside mtime granularity: an idempotent
// rewrite produces identical bytes by construction, so the mtime is the whole
// detector and pushing it an hour into the past makes any write unmissable.
const backdated = new Date(Date.now() - 3_600_000);
fs.utimesSync(GLOBAL_CONFIG, backdated, backdated);
const beforeRestart = snapshotGlobal();

killPtys(bridge1);
const registry2 = new AgentRegistry(registryFile);
const bridge2 = newBridge();
const events = [];
const router2 = new MessageRouter({
  config,
  herdrBridge: bridge2,
  daemonStartedAt: new Date(),
  agentRegistry: registry2,
  send: () => {},
  broadcast: (msg) => events.push(msg)
});
resetArgvLog();

const reconciled = await reconcileAgents({
  registry: registry2, herdrBridge: bridge2, router: router2, cause: 'reboot', log: () => {}
});
const attached = await waitForCall(new RegExp(`^agent attach ${paneName}\\b`));

// PRECONDITION. "Nothing was written" is trivially true of an operation that
// did not happen, so the re-attach has to be shown to have happened first.
const outcome = reconciled.outcomes.find((o) => o.path === dir);
check(
  attached && outcome !== undefined,
  'PRECONDITION: the restart really did re-attach to the surviving pane',
  `attach seen=${attached}; outcome=${JSON.stringify(outcome ?? null)}; ` +
    `log=${JSON.stringify(herdrCalls())}`
);
check(
  callsMatching(/^agent start\b/).length === 0,
  'PRECONDITION: and it did NOT start a second agent',
  `starts=${callsMatching(/^agent start\b/).length}: ${JSON.stringify(herdrCalls())}`
);

const afterRestart = snapshotGlobal();
check(
  afterRestart !== null && beforeRestart !== null && afterRestart.bytes === beforeRestart.bytes,
  'the global config is byte-identical across the restart',
  afterRestart === null
    ? 'it is gone'
    : `${afterRestart.bytes.length} bytes (was ${beforeRestart.bytes.length})`
);
check(
  afterRestart !== null && beforeRestart !== null && afterRestart.mtimeMs === beforeRestart.mtimeMs,
  'and its mtime is untouched — so not even an idempotent rewrite happened',
  afterRestart === null
    ? 'it is gone'
    : `${new Date(afterRestart.mtimeMs).toISOString()} (backdated to ` +
      `${backdated.toISOString()}; anything later is a write)`
);

// ===========================================================================
// 2b. THE SAME CLAIM WITH THE IDEMPOTENCE GUARD TAKEN OUT OF PLAY.
//
// §2 is held by TWO independent mechanisms and it cannot tell them apart:
//
//   1. `attachSession` performs no provisioning, so `launcher.setup` never
//      runs — the separation `src/reconcile.ts` documents;
//   2. `trustClaudeWorkspace` READS BEFORE IT WRITES — `if (trusted(
//      current.config)) return { ok: true, attempts: attempt - 1 }` — so even a
//      re-provisioning writes nothing when the entry is already there.
//
// EITHER ALONE MAKES §2 PASS, WHICH MEANS §2 ALONE CANNOT SHOW THAT MECHANISM
// 1 IS DOING ANYTHING. Measured rather than reasoned: the first red drive here
// mutated `attachSession` to provision, and the mutant reached §2 and PASSED —
// mechanism 2 caught it. That is a real defence and it is not the one this file
// is about.
//
// So this section removes mechanism 2 from the board by DELETING THE TRUST KEY
// while the agent is running — which is also a thing that happens: Claude Code
// rewrites the whole file from memory moments after boot, and the retry loop in
// `trustClaudeWorkspace` exists because that has clobbered our entry before.
// With the key absent, a re-provisioning MUST write, so what remains between
// this file and a write is mechanism 1 and nothing else.
//
// The claim is therefore narrow and true: A RE-ATTACH DOES NOT RESTORE A TRUST
// ENTRY THAT IS NOT THERE, because a re-attach does not provision.
// ===========================================================================

console.log('\n=== 2b. And with the trust entry deleted, so only the attach path can hold ===\n');

{
  const parsed = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
  delete parsed.projects[trustKeyFor(dir)];
  fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(parsed, null, 2));
  const clobberBackdate = new Date(Date.now() - 3_600_000);
  fs.utimesSync(GLOBAL_CONFIG, clobberBackdate, clobberBackdate);
  const clobbered = snapshotGlobal();

  check(
    !trustedIn(clobbered, dir),
    'SETUP: the trust entry is deleted while the agent is running, so the read-before-write ' +
      'guard in trustClaudeWorkspace cannot be what holds the line below',
    `key ${trustKeyFor(dir)} removed; ${clobbered.bytes.length} bytes`
  );

  killPtys(bridge2);
  const registry3 = new AgentRegistry(registryFile);
  const bridge3 = newBridge();
  const events3 = [];
  const router3 = new MessageRouter({
    config,
    herdrBridge: bridge3,
    daemonStartedAt: new Date(),
    agentRegistry: registry3,
    send: () => {},
    broadcast: (msg) => events3.push(msg)
  });
  resetArgvLog();

  const again = await reconcileAgents({
    registry: registry3, herdrBridge: bridge3, router: router3, cause: 'reboot', log: () => {}
  });
  const attachedAgain = await waitForCall(new RegExp(`^agent attach ${paneName}\\b`));
  const outcomeAgain = again.outcomes.find((o) => o.path === dir);

  check(
    attachedAgain && outcomeAgain !== undefined,
    'PRECONDITION: the second restart really did re-attach',
    `attach seen=${attachedAgain}; outcome=${JSON.stringify(outcomeAgain ?? null)}; ` +
      `log=${JSON.stringify(herdrCalls())}`
  );

  const afterClobberRestart = snapshotGlobal();
  check(
    afterClobberRestart !== null && afterClobberRestart.bytes === clobbered.bytes,
    'the re-attach did NOT restore the deleted trust entry — byte-identical',
    afterClobberRestart === null
      ? 'the file is gone'
      : `${afterClobberRestart.bytes.length} bytes (was ${clobbered.bytes.length}); ` +
        `key present now=${trustedIn(afterClobberRestart, dir)}`
  );
  check(
    afterClobberRestart !== null && afterClobberRestart.mtimeMs === clobbered.mtimeMs,
    'and its mtime is untouched — the re-attach ran no provisioning at all',
    afterClobberRestart === null
      ? 'the file is gone'
      : `${new Date(afterClobberRestart.mtimeMs).toISOString()} (backdated to ` +
        `${clobberBackdate.toISOString()}; anything later is a write)`
  );
}

// ===========================================================================
// 3. THE INSTRUMENT MOVES — or §2 is two readings of a frozen detector.
// ===========================================================================

console.log('\n=== 3. The same instrument reports a write when there is one ===\n');

const beforeCanary = snapshotGlobal();
const second = ownedDir('second-claude');
const registryC = new AgentRegistry(registryFile);
const bridgeC = newBridge();
registryC.recordConfigured({ path: second, config: AS_CLAUDE });
resetArgvLog();
const started2 = await invoke(bridgeC, registryC, [], {
  action: 'activate_agent', path: second, ...PAST_THE_GATE
});
const afterSecond = snapshotGlobal();

check(
  started2.success === true,
  'CANARY: a second agent is activated at a second directory',
  `success=${started2.success} error=${started2.error ?? '(none)'}`
);
check(
  afterSecond !== null && beforeCanary !== null && afterSecond.bytes !== beforeCanary.bytes &&
    trustedIn(afterSecond, second),
  'CANARY: the bytes MOVED and the new key is there — the comparison in §2/§2b can report a change',
  afterSecond === null
    ? 'the global config is gone'
    : `${afterSecond.bytes.length} bytes (was ${beforeCanary?.bytes.length}); ` +
      `key ${trustKeyFor(second)} present=${trustedIn(afterSecond, second)}`
);
check(
  afterSecond !== null && beforeCanary !== null && afterSecond.mtimeMs !== beforeCanary.mtimeMs,
  'CANARY: and the mtime MOVED — the mtime comparison in §2/§2b can report a change too',
  afterSecond === null ? 'gone' : `${new Date(afterSecond.mtimeMs).toISOString()}`
);

// ===========================================================================
// 4. THE RED DRIVE.
//
// The mutation is the one `src/reconcile.ts` writes down for itself: drop the
// `getSessionByPath` conjunct and the survivor stops being recognised, so the
// restart goes through `activate` — the verb that can spawn — and
// `launcher.setup` runs again. This is KAN-134 reproduced on purpose.
//
// It runs in a CHILD PROCESS against a mutated copy of `dist`, because the
// module graph in THIS process is already loaded and cannot be re-imported
// with different bytes.
// ===========================================================================

console.log('\n=== 4. Watched failing: a restart that re-provisions rewrites it ===\n');

for (const bridge of openBridges) killPtys(bridge);

const CHILD = process.env.CRABCAST_GLOBALCFG_CHILD === '1';
if (!CHILD) {
  const mutScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan173-globalcfg-mut-'));
  // A mutant build sits outside the repository, so Node's bare-specifier walk
  // never reaches the repo's `node_modules` and `dist/herdr.js`'s `node-pty`
  // import dies with ERR_MODULE_NOT_FOUND. That failure is the dangerous kind:
  // the arm exits non-zero and reads as a successful red drive. It was
  // observed on the first run of this file and is why the RED arm below
  // asserts the mutant REACHED §2 rather than only that it exited non-zero.
  // One symlink beside the mutant closes it.
  try {
    fs.symlinkSync(
      path.join(path.dirname(distDir), 'node_modules'),
      path.join(mutScratch, 'node_modules'),
      'dir'
    );
  } catch {}
  const mutator = makeMutator({
    distDir,
    scratch: mutScratch,
    report: {
      pass: (label, detail) => check(true, label, detail),
      fail: (label, detail) => check(false, label, detail)
    }
  });

  redDrive: try {
    const runChild = (label, dist) => {
      const r = execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), dist],
        {
          env: { ...process.env, HOME: realHome, PATH: realPath, CRABCAST_GLOBALCFG_CHILD: '1' },
          encoding: 'utf8',
          // A non-zero exit is the expected outcome of the mutant arm, so the
          // throw is caught rather than allowed to end the run.
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      return { status: 0, out: r, label };
    };
    const runChildAllowingFailure = (label, dist) => {
      try {
        return runChild(label, dist);
      } catch (err) {
        return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, label };
      }
    };

    // --- the false-positive control ---------------------------------------
    const control = runChildAllowingFailure('control', distDir);
    const controlRan = control.out.includes('=== 2. The RE-ATTACH leaves it');
    if (!check(
      control.status === 0 && controlRan,
      'CONTROL: the unmutated build passes §1-§3 in a child, so the red below is the mutation',
      control.status === 0 && controlRan
        ? ''
        : `exit ${control.status}, reached §2=${controlRan}. Last lines: ` +
          `${control.out.trim().split('\n').slice(-6).join(' / ')}`
    )) break redDrive;

    // --- RED --------------------------------------------------------------
    // THE MUTATION IS `attachSession` GOING THROUGH `initPty`, AND THE FIRST
    // ONE WAS WRONG — recorded because the wrong one is the plausible one.
    // `src/reconcile.ts` names its own recipe — "deleting the
    // `getSessionByPath` conjunct below reproduces KAN-134" — and that is a
    // true recipe for the wrong failure HERE: the survivor stops being
    // recognised and the restart goes through `activate`, but `handleActivate`
    // then finds the pane already running and returns on its already-running
    // branch, re-attaching without provisioning. The mutant ran, reached §2 and
    // PASSED, which is the honest answer: dropping that conjunct does not
    // re-provision anything, so it is not the defect this section guards.
    //
    // `launcher.setup` is called from `initPty`, and `initPty` is what
    // `spawnSession` calls where `attachSession` calls `attachPty`. That ONE
    // line is the whole separation the section asserts, so that one line is
    // what is mutated.
    const mutant = mutator.mutate('the-re-attach-provisions', [{
      file: 'herdr.js',
      find:
        'Nothing is being started.`);\n' +
        '        this.sessions.set(session.sessionId, session);\n' +
        '        this.attachPty(session);',
      replace:
        'Nothing is being started.`);\n' +
        '        this.sessions.set(session.sessionId, session);\n' +
        '        this.initPty(session, { priority: 1, refusable: true, chargeable: true, ' +
        'preemptable: true, launcher });'
    }]);
    if (!mutant) break redDrive;

    const red = runChildAllowingFailure('red', mutant);
    const redReached = red.out.includes('=== 2b. And with the trust entry deleted');
    check(
      redReached,
      'RED: the mutant RAN and reached §2b — a red from a build that never got there is evidence ' +
        'about the harness',
      redReached ? '' : `exit ${red.status}. Last lines: ${red.out.trim().split('\n').slice(-8).join(' / ')}`
    );
    check(
      red.status !== 0,
      'RED: a restart that re-provisions makes this proof fail',
      red.status !== 0 ? `exit ${red.status}` : 'exit 0 — the proof did not notice'
    );
    const redLines = red.out.split('\n').filter((l) => l.startsWith('FAIL'));
    const restored = redLines.find((l) => /did NOT restore the deleted trust entry/.test(l));
    check(
      Boolean(restored),
      'RED: and it fails ON §2b — the re-attach restored a trust entry it should not have',
      restored
        ? restored.trim().slice(0, 200)
        : `no FAIL line named the restored entry. FAILs: ${redLines.join(' | ').slice(0, 300)}`
    );
    // §2 must survive the mutation, because the read-before-write guard still
    // holds it. This is what makes the pair of sections evidence about WHICH
    // mechanism is doing the work rather than about "something is".
    const stillGreen = !redLines.some((l) => /byte-identical across the restart/.test(l));
    check(
      stillGreen,
      'RED: and §2 stays GREEN under the same mutation — the read-before-write guard is real, ' +
        'and §2b is the section that isolates the attach/spawn separation',
      stillGreen
        ? 'two independent mechanisms, and breaking one leaves the other holding §2'
        : `§2 also failed: ${redLines.filter((l) => /byte-identical/.test(l)).join(' | ')}`
    );
  } finally {
    fs.rmSync(mutScratch, { recursive: true, force: true });
  }
} else {
  console.log('  SKIPPED — this is a child spawned by §4.\n');
}

// ---------------------------------------------------------------------------

for (const bridge of openBridges) killPtys(bridge);
process.env.HOME = realHome;
process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });
finish();
