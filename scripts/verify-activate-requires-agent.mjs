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
// HerdrBridge (initPty and all), the real WorkspaceRegistry and PromptLoader,
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
// The real loader loads a real config: a `task` type whose defaultLauncher is
// `claude`, which is what section 1's omitted-field activation must resolve
// to. dataDir points into the scratch, so workspaces land there and nowhere
// else.
const dataDir = path.join(scratch, 'data');
const configPath = path.join(scratch, 'crabcast.config.json');
fs.mkdirSync(path.join(scratch, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'prompts', 'task.md'), 'KAN-53 proof workspace {{KEY}}.\n');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: TYPE, priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'claude' },
    // A second type for section 5: two types sharing one key are two agents.
    { name: 'sidecar', priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'claude' }
  ]
}, null, 2));

// ------------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { AGENT_LAUNCHERS, DEFAULT_AGENT, PROMPT_FILENAME } = await import(path.join(distDir, 'launchers.js'));

const config = loadConfig(configPath);
const bridge = new HerdrBridge(config.dataDir);
let sent;
const router = new MessageRouter({
  registry: new WorkspaceRegistry(config.workspaceTypes),
  config,
  promptLoader: new PromptLoader(config.baseDir),
  herdrBridge: bridge,
  daemonStartedAt: new Date(),
  send: (msg) => { sent = msg; },
  broadcast: () => {}
});

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function activate(key, extra = {}) {
  sent = undefined;
  await router.handleActivateByKey(
    { action: 'activate_by_key', type: TYPE, key, ...extra },
    (msg) => { sent = msg; }
  );
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
console.log(`type '${TYPE}' declares defaultLauncher: "claude"`);

// ------------------------------------------------- 1. omitted defaultAgent --

rule('1. activate_by_key with NO defaultAgent — resolves to the type\'s defaultLauncher');

const omitted = await activate('KAN-53-OMIT');
show('activate_by_key response:', omitted);

const omittedStarts = startsIn(invocations());
const omittedName = agentNameFor(TYPE, 'KAN-53-OMIT');
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
  `an omitted defaultAgent launched the type's declared 'claude' — the pane runs claude, not a shell`,
  'the omitted-field activation did not produce a claude launch'
);

// ------------------------------------------------------ 2. unknown refuses --

rule("2. defaultAgent: 'zzz' — refused, naming the valid launchers");

const invocationsBeforeZzz = invocations().length;
const zzz = await activate('KAN-53-ZZZ', { defaultAgent: 'zzz' });
show('activate_by_key response:', zzz);

const zzzName = agentNameFor(TYPE, 'KAN-53-ZZZ');
const zzzStarts = startsIn(invocations()).filter((argv) => argv[2] === zzzName);
const zzzWorkspace = path.join(dataDir, 'workspaces', TYPE, 'kan-53-zzz');
const zzzPromptWritten = fs.existsSync(path.join(zzzWorkspace, PROMPT_FILENAME));
console.log(`\n   herdr invocations during the refusal: ${invocations().length - invocationsBeforeZzz}`);
console.log(`   agent start invocations for ${zzzName}: ${zzzStarts.length}`);
console.log(`   ${PROMPT_FILENAME} written into the refused workspace: ${zzzPromptWritten}`);

verdict(
  zzz?.success === false &&
    typeof zzz?.error === 'string' &&
    zzz.error.includes("Unknown agent 'zzz'") &&
    Object.keys(AGENT_LAUNCHERS).every((name) => zzz.error.includes(name)),
  'success: false, and the error names every valid launcher',
  'the unknown name was not refused, or the refusal does not name the launchers'
);
verdict(
  zzzStarts.length === 0 && !zzzPromptWritten,
  'nothing was started or provisioned for the refused activation',
  'the refusal left something behind'
);

console.log('\n   the same key again, with a valid launcher — a refusal must not latch:\n');
const retry = await activate('KAN-53-ZZZ', { defaultAgent: 'claude' });
show('activate_by_key response:', { success: retry?.success, verified: retry?.verified, sessionId: retry?.sessionId });
verdict(
  retry?.success === true,
  'the earlier refusal locked nothing out',
  'the refused activation poisoned the session map'
);

// ----------------------------------------------------- 3. explicit 'shell' --

rule("3. defaultAgent: 'shell' — explicit shell still works, and only explicit");

const shell = await activate('KAN-53-SHELL', { defaultAgent: 'shell' });
show('activate_by_key response:', { success: shell?.success, verified: shell?.verified, sessionId: shell?.sessionId });

const shellStart = startsIn(invocations()).find((argv) => argv[2] === agentNameFor(TYPE, 'KAN-53-SHELL'));
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
  (argv) => launcherCommandOf(argv) === 'bash' && argv[2] !== agentNameFor(TYPE, 'KAN-53-SHELL')
);
verdict(
  accidentalShells.length === 0,
  "no bash-launching command was ever constructed except the one that asked for 'shell' by name",
  `${accidentalShells.length} bash launch(es) were constructed without being asked for`
);

// ------------------------------------------------- 5. cross-type isolation --

rule('5. cross-type isolation — a second type on the same key leaves the first alone');

console.log('   The session lookup in activate_by_key must be by full address, not by key');
console.log('   alone: a key-only match would hand sidecar/SHARED the task/SHARED session,');
console.log('   confirm existence against the sidecar agent name — absent — and abandon the');
console.log("   task agent's live PTY. A mistyped type must never destroy an unrelated agent.\n");

const SHARED = 'KAN-70-SHARED';
const first = await activate(SHARED);
const firstSession = bridge.getSession(first?.sessionId);
show('first activation (task/SHARED):', {
  success: first?.success, verified: first?.verified, sessionId: first?.sessionId
});

const second = await activate(SHARED, { type: 'sidecar' });
show('second activation (sidecar/SHARED):', {
  success: second?.success, verified: second?.verified, sessionId: second?.sessionId
});

const firstAfter = bridge.getSession(first?.sessionId);
const sharedStarts = startsIn(invocations()).map((argv) => argv[2]);
console.log(`\n   task session after the sidecar activation: status=${firstAfter?.status}, ` +
  `spawnError ${firstAfter?.spawnError ? 'set' : 'unset'}`);
console.log(`   agents started for the shared key: ` +
  `${JSON.stringify(sharedStarts.filter((n) => n.endsWith('-kan-70-shared')))}`);

verdict(
  first?.success === true &&
    second?.success === true &&
    typeof second?.sessionId === 'string' &&
    second.sessionId !== first?.sessionId &&
    firstAfter?.status === 'active' &&
    !firstAfter?.spawnError &&
    sharedStarts.includes(agentNameFor(TYPE, SHARED)) &&
    sharedStarts.includes(agentNameFor('sidecar', SHARED)),
  'two types on one key are two agents, and the first session survived untouched',
  'the second type reused or destroyed the first session'
);

// ---------------------------------------------- 6. unwritable prompt file --

rule('6. a prompt file that cannot be written refuses the activation');

console.log("   The agent's first instruction is to read the prompt file, so an activation");
console.log('   whose prompt write failed must refuse — spawning anyway would start an agent');
console.log('   with no instructions behind a success: true, verified: true answer.\n');

const RO_KEY = 'KAN-70-READONLY';
const roDir = path.join(dataDir, 'workspaces', TYPE, RO_KEY.toLowerCase());
fs.mkdirSync(roDir, { recursive: true });
fs.chmodSync(roDir, 0o500); // read + traverse, no write: the prompt write must fail

const readonly = await activate(RO_KEY, { defaultAgent: 'shell' });
fs.chmodSync(roDir, 0o755); // restored so cleanup can remove the scratch

show('activate_by_key response:', readonly);
const roStarts = startsIn(invocations()).filter((argv) => argv[2] === agentNameFor(TYPE, RO_KEY));
console.log(`\n   agent start invocations for ${agentNameFor(TYPE, RO_KEY)}: ${roStarts.length}`);

verdict(
  readonly?.success === false &&
    typeof readonly?.error === 'string' &&
    readonly.error.includes(PROMPT_FILENAME) &&
    roStarts.length === 0,
  'refused naming the prompt file, and nothing was started for the broken workspace',
  'a failed prompt write did not refuse the activation'
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
