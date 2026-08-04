// Live proof (ported from the extraction source's KAN-53): activating without
// a defaultAgent starts the workspace type's declared defaultLauncher — never
// a silent shell — and an unknown defaultAgent refuses, naming the valid
// launchers.
//
// The original ticket's symptom: `resolveLauncher` treated an omitted name as
// `shell` and warned-then-fell-back on an unknown one, so an activation
// without the field "staffed" a ticket with a bare bash prompt that answered
// `success: true, verified: true` and executed send_to_agent messages as
// shell commands. CrabCast generalizes the fix: the fallback order is the
// caller's defaultAgent, then the type's `defaultLauncher` from
// crabcast.config.json, then DEFAULT_AGENT — and unknown names refuse at
// every step.
//
// Six sections:
//
//   1. omitted    — activate with no defaultAgent: the type's launcher
//                   (claude), not a shell
//   2. unknown    — defaultAgent: 'zzz' refuses, names the valid launchers,
//                   starts nothing, provisions nothing, and does not latch
//   3. explicit   — defaultAgent: 'shell' still works: shell is a legitimate
//                   *explicit* request (verify fixtures use it), only the
//                   implicit paths to it are gone
//   4. audit      — across sections 1 and 2, no bash-launching command was
//                   ever constructed
//   5. cross-type — activating a second type on a key another type already
//                   holds spawns its own agent and leaves the first session
//                   untouched (a key-only session lookup would reuse the
//                   first session, fail existence against the second type's
//                   name, and tear the first agent's PTY down)
//   6. unwritable — a workspace whose prompt file cannot be written refuses
//                   the activation naming the file, instead of spawning an
//                   instruction-less agent behind success: true
//
// Everything on the daemon side is real: the real MessageRouter, the real
// HerdrBridge (initPty and all), a real on-disk AgentRegistry,
// a real config loaded by the real loader. What is faked is the `herdr`
// binary itself: a shim on PATH that records every invocation — argv-exact,
// including the launcher command handed to `agent start` — and answers in
// herdr's own JSON shapes without spawning anything. The recorded argv is
// therefore the whole truth about what would have run, which is what lets
// section 4 say "no bash launch was constructed" rather than inferring it.
//
// Isolation is by a scratch dataDir in the config AND by a scratch $HOME —
// the `claude` launcher's setup records folder trust in ~/.claude.json, and
// os.homedir() reads $HOME at call time, so the temp HOME (set before any
// dist import) keeps those writes out of the real user file. No real herdr —
// live or private — is ever contacted.
//
// Usage:
//   npm run build
//   node scripts/verify-activate-requires-agent.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const TYPE = 'task';

// A private HOME, before any dist import: the claude launcher's trust write
// targets os.homedir()/.claude.json, which reads $HOME at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan53-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH. Every invocation is appended, argv-exact,
// to invocations.jsonl; `agent start` additionally remembers the agent so
// `agent get` / `agent list` — and through them the verified-existence check —
// see exactly the agents that were started and nothing else. `agent attach`
// holds its terminal open the way a real attach does, and is killed on exit.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN53_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN53_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: '9' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: '9' } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
// A wrapper with this process's node baked in, so the shim never depends on
// what PATH resolves `node` to.
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const startsIn = (calls) => calls.filter((argv) => argv[0] === 'agent' && argv[1] === 'start');
/** The command a recorded `agent start` would have run inside the pane: the
 *  argv after `--` is `env PATH=... [RESUME_ENV...] bash -c <payload>`, so the
 *  payload — the launcher command itself — is the final element. */
const launcherCommandOf = (startArgv) => startArgv[startArgv.length - 1];

// -------------------------------------------------------------- the config --
//
// The real loader loads a real config, which now declares a dataDir and
// nothing else — there is no type table left to carry a defaultLauncher, so
// the launcher this script is about is a per-agent `configure` parameter.
const dataDir = path.join(scratch, 'data');
const configPath = path.join(scratch, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

// ------------------------------------------------------------- the harness --

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { AGENT_LAUNCHERS, DEFAULT_AGENT, PROMPT_FILENAME } = await import(path.join(distDir, 'launchers.js'));
const { paneNameFor, sidecarDirFor } = await import(path.join(distDir, 'identity.js'));

const config = loadConfig(configPath);
const bridge = new HerdrBridge(config.dataDir);
const agentRegistry = new AgentRegistry(path.join(dataDir, 'agents.jsonl'));
let sent;
const router = new MessageRouter({
  config,
  herdrBridge: bridge,
  daemonStartedAt: new Date(),
  agentRegistry,
  send: (msg) => { sent = msg; },
  broadcast: () => {}
});

/** A directory a caller owns. Every address in this script is one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** configure(path, knobs) — mandatory now, and the only place a launcher lives. */
function configure(dir, over = {}) {
  let out;
  const r = new MessageRouter({
    config, herdrBridge: bridge, daemonStartedAt: new Date(), agentRegistry,
    send: (msg) => { out = msg; }, broadcast: () => {}
  });
  r.handle({
    action: 'configure_agent', path: dir,
    priority: 1, launcher: 'claude', prompt: 'KAN-53 proof.', ...over
  });
  return out;
}

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

// The capacity gate reads the real machine, and whether this box is busy is
// not what is being proved here. The override path is real, recorded, and
// what [Start anyway] sends; verify-agent-capacity.mjs proves the gate.
const PAST_THE_GATE = { override: true };

/**
 * configure-then-activate, which is the only sequence there is: `activate`
 * takes no attributes, so the launcher under test arrives through `configure`.
 */
async function activate(name, knobs = {}) {
  const dir = owned(name);
  const configured = configure(dir, knobs);
  if (configured?.success === false) return { ...configured, action: 'activate_response' };
  sent = undefined;
  await router.handleActivate({ path: dir, ...PAST_THE_GATE }, (msg) => { sent = msg; });
  return sent;
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

console.log(`fake herdr: ${path.join(shimDir, 'herdr')} (records to ${shimState})`);
console.log(`config for this run: ${configPath} (dataDir ${dataDir})`);
console.log(`valid launchers in the built table: ${JSON.stringify(Object.keys(AGENT_LAUNCHERS))}`);
console.log(`DEFAULT_AGENT (bridge-level fallback): ${JSON.stringify(DEFAULT_AGENT)}`);
console.log(`the launcher is a \`configure\` parameter now — there is no type to declare one`);

// ------------------------------------------------- 1. omitted defaultAgent --

rule('1. configure names the launcher, and activate runs exactly that');

const omitted = await activate('KAN-53-OMIT');
show('activate response:', omitted);

const omittedStarts = startsIn(invocations());
const omittedName = paneNameFor(owned('KAN-53-OMIT'));
const omittedStart = omittedStarts.find((argv) => argv[2] === omittedName);
console.log(`\n   agent start invocations so far: ${omittedStarts.length}`);
if (omittedStart) {
  console.log(`   the command herdr was told to run for ${omittedName}:`);
  console.log(`     ${JSON.stringify(launcherCommandOf(omittedStart))}`);
}

verdict(
  omitted?.success === true &&
    omitted?.verified === true &&
    omittedStart !== undefined &&
    launcherCommandOf(omittedStart).startsWith('claude ') &&
    launcherCommandOf(omittedStart) !== 'bash',
  `the configured 'claude' is what the pane runs — never a shell. There is no longer a\n` +
  `    middle step for it to fall through: the launcher is on the agent's own record, so\n` +
  `    there is no second place for it to come from and no chance of the two disagreeing`,
  'the activation did not produce a claude launch'
);

// ------------------------------------------------------ 2. unknown refuses --

rule("2. launcher: 'zzz' — refused at CONFIGURE, naming the valid launchers");

console.log('   The refusal moved one verb earlier, and that is a strict improvement: an');
console.log('   unknown launcher used to be caught at the first activation, in front of');
console.log('   whoever was waiting on the agent. It is now caught by the call that wrote');
console.log('   the mistake, and no record is created at all.\n');

const invocationsBeforeZzz = invocations().length;
const zzz = await activate('KAN-53-ZZZ', { launcher: 'zzz' });
show('configure response:', zzz);

const zzzDir = owned('KAN-53-ZZZ');
const zzzName = paneNameFor(zzzDir);
const zzzStarts = startsIn(invocations()).filter((argv) => argv[2] === zzzName);
const zzzSidecar = sidecarDirFor(dataDir, zzzDir);
const zzzPromptWritten = fs.existsSync(path.join(zzzSidecar, PROMPT_FILENAME));
console.log(`\n   herdr invocations during the refusal: ${invocations().length - invocationsBeforeZzz}`);
console.log(`   agent start invocations for ${zzzName}: ${zzzStarts.length}`);
console.log(`   a prompt written into the refused agent's sidecar: ${zzzPromptWritten}`);
console.log(`   a record written for it: ${agentRegistry.intents().has(zzzDir)}`);

verdict(
  zzz?.success === false &&
    typeof zzz?.error === 'string' &&
    zzz.error.includes("Unknown launcher 'zzz'") &&
    Object.keys(AGENT_LAUNCHERS).every((name) => zzz.error.includes(name)),
  'success: false, and the error names every valid launcher',
  'the unknown name was not refused, or the refusal does not name the launchers'
);
verdict(
  zzzStarts.length === 0 && !zzzPromptWritten && !agentRegistry.intents().has(zzzDir),
  'nothing was started, provisioned or recorded for the refused agent',
  'the refusal left something behind'
);

console.log('\n   the same directory again, with a valid launcher — a refusal must not latch:\n');
const retry = await activate('KAN-53-ZZZ', { launcher: 'claude' });
show('activate response:', { success: retry?.success, verified: retry?.verified, sessionId: retry?.sessionId });
verdict(
  retry?.success === true,
  'the earlier refusal locked nothing out',
  'the refused activation poisoned the session map'
);

// ----------------------------------------------------- 3. explicit 'shell' --

rule("3. launcher: 'shell' — explicit shell still works, and only explicit");

const shellDir = owned('KAN-53-SHELL');
// No prompt: `shell` with one prints it into the pane before exec'ing bash,
// which is right but would make the command below something other than the
// bare `bash` this section is checking for.
const shell = await activate('KAN-53-SHELL', { launcher: 'shell', prompt: undefined });
show('activate response:', { success: shell?.success, verified: shell?.verified, sessionId: shell?.sessionId });

const shellStart = startsIn(invocations()).find((argv) => argv[2] === paneNameFor(shellDir));
if (shellStart) {
  console.log(`\n   the command herdr was told to run: ${JSON.stringify(launcherCommandOf(shellStart))}`);
}
verdict(
  shell?.success === true && shellStart !== undefined && launcherCommandOf(shellStart) === 'bash',
  "asking for 'shell' by name still gets one — the fixture path verify scripts use is intact",
  'the explicit shell request no longer works'
);

// ----------------------------------------------------------- 4. the audit --

rule('4. the audit — every command constructed while defaultAgent was absent or wrong');

const allStarts = startsIn(invocations());
for (const argv of allStarts) {
  console.log(`   ${argv[2]}  →  ${JSON.stringify(launcherCommandOf(argv))}`);
}
const accidentalShells = allStarts.filter(
  (argv) => launcherCommandOf(argv) === 'bash' && argv[2] !== paneNameFor(owned('KAN-53-SHELL'))
);
verdict(
  accidentalShells.length === 0,
  "no bash-launching command was ever constructed except the one that asked for 'shell' by name",
  `${accidentalShells.length} bash launch(es) were constructed without being asked for`
);

// -------------------------------------------- 5. same-basename isolation --

rule('5. two directories with the same basename are two agents, start to finish');

console.log('   This used to be "cross-type isolation": two workspace TYPES sharing one key');
console.log('   were two agents, and a key-only session lookup would hand the second one the');
console.log('   first\'s session, confirm existence against a name that was absent, and abandon');
console.log('   the first agent\'s live PTY. A mistyped type destroyed an unrelated agent.\n');
console.log('   The collision it guarded against cannot be expressed now — the address IS the');
console.log('   directory — so what is proved here is that the guard\'s PROPERTY survives the');
console.log('   deletion of the thing it guarded: two agents whose directories share a');
console.log('   basename are independent, down to the pane names herdr sees.\n');

const sharedA = owned(path.join('shared', 'alpha', 'KAN-70-SHARED'));
const sharedB = owned(path.join('shared', 'beta', 'KAN-70-SHARED'));
configure(sharedA);
configure(sharedB);

sent = undefined;
await router.handleActivate({ path: sharedA, ...PAST_THE_GATE }, (m) => { sent = m; });
const first = sent;
const firstSession = bridge.getSession(first?.sessionId);
show('first activation (alpha/KAN-70-SHARED):', {
  success: first?.success, verified: first?.verified, sessionId: first?.sessionId
});

sent = undefined;
await router.handleActivate({ path: sharedB, ...PAST_THE_GATE }, (m) => { sent = m; });
const second = sent;
show('second activation (beta/KAN-70-SHARED):', {
  success: second?.success, verified: second?.verified, sessionId: second?.sessionId
});

const firstAfter = bridge.getSession(first?.sessionId);
const sharedStarts = startsIn(invocations()).map((argv) => argv[2]);
console.log(`\n   alpha session after the beta activation: status=${firstAfter?.status}, ` +
  `spawnError ${firstAfter?.spawnError ? 'set' : 'unset'}`);
console.log(`   the two pane names herdr was given:`);
console.log(`     ${paneNameFor(sharedA)}`);
console.log(`     ${paneNameFor(sharedB)}`);

verdict(
  first?.success === true &&
    second?.success === true &&
    typeof second?.sessionId === 'string' &&
    second.sessionId !== first?.sessionId &&
    firstAfter?.status === 'active' &&
    !firstAfter?.spawnError &&
    paneNameFor(sharedA) !== paneNameFor(sharedB) &&
    sharedStarts.includes(paneNameFor(sharedA)) &&
    sharedStarts.includes(paneNameFor(sharedB)),
  'two directories sharing a basename are two agents with two pane names, and the first\n' +
  '    session survived untouched — there is nothing left for a --type flag to resolve',
  'the second activation reused or destroyed the first session'
);

// ---------------------------------------------- 6. unwritable prompt file --

rule('6. a prompt that cannot be written refuses the activation');

console.log("   The agent's first instruction is to read the prompt file, so an activation");
console.log('   whose prompt write failed must refuse — spawning anyway would start an agent');
console.log('   with no instructions behind a success: true, verified: true answer.\n');
console.log('   The file is in CrabCast\'s own SIDECAR now rather than in the agent\'s working');
console.log('   directory, which is why this section seals the sidecar rather than the');
console.log('   caller\'s tree: nothing is written into a caller\'s directory to be sealed.\n');

const roDir = owned('KAN-70-READONLY');
configure(roDir, { launcher: 'shell', prompt: 'instructions that will not land' });

// The sidecar's PARENT, so the agent's own sidecar directory cannot be created.
const sidecarRoot = path.join(dataDir, 'agents');
fs.mkdirSync(sidecarRoot, { recursive: true });
fs.chmodSync(sidecarRoot, 0o500);

sent = undefined;
await router.handleActivate({ path: roDir, ...PAST_THE_GATE }, (m) => { sent = m; });
const readonly = sent;
fs.chmodSync(sidecarRoot, 0o755); // restored so cleanup can remove the scratch

show('activate response:', readonly);
const roStarts = startsIn(invocations()).filter((argv) => argv[2] === paneNameFor(roDir));
console.log(`\n   agent start invocations for ${paneNameFor(roDir)}: ${roStarts.length}`);
console.log(`   files written into the caller's directory: ` +
  `${JSON.stringify(fs.readdirSync(roDir))}`);

verdict(
  readonly?.success === false &&
    typeof readonly?.error === 'string' &&
    readonly.error.includes('bootstrap prompt') &&
    roStarts.length === 0 &&
    fs.readdirSync(roDir).length === 0,
  'refused naming the prompt, nothing was started, and nothing was left in the\n' +
  '    caller\'s directory on the way out',
  'a failed prompt write did not refuse the activation'
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
