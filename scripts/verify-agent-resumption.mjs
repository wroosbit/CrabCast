#!/usr/bin/env node
// Ported from the extraction source's KAN-21 proof: the parts of restart
// survival that can be checked without rebooting the host.
//
// The reboot proof is the one this cannot stand in for, and the original
// ticket said so explicitly: a simulated daemon restart is not evidence for a
// power cut. What this DOES establish is every property the reboot proof
// depends on — that the registry survives an unclean death, that a torn tail
// does not destroy it, that intent is honoured rather than history, that the
// resume framing differs correctly between a restorable and an unrestorable
// conversation, and (section 5) that reconciliation delivers that framing
// end-to-end through the real activation path.
//
// Usage:
//   npm run build
//   node scripts/verify-agent-resumption.mjs [distDir]

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.resolve(scriptDir, '../dist');

// A private HOME, before any dist import: the claude launcher's trust write
// and the transcript probe both resolve os.homedir() at call time, and
// section 5 plants transcripts there.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan21-'));
const fakeHome = path.join(scratchRoot, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

const { AgentRegistry } = await import(path.join(dist, 'agent-registry.js'));
const {
  hasRestorableConversation,
  claudeTranscriptDir,
  degradedResumePrompt,
  resumeNudge,
  RESUME_ENV
} = await import(path.join(dist, 'resume.js'));
const { AGENT_LAUNCHERS, PROMPT_FILENAME } = await import(path.join(dist, 'launchers.js'));

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message.split('\n').join('\n        ')}`);
  }
}

async function checkAsync(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message.split('\n').join('\n        ')}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan21-work-'));
const registryFile = path.join(tmp, 'agents.jsonl');
const record = (key, extra = {}) => ({
  agentName: `crabcast-task-${key}`,
  type: 'task',
  key,
  workDir: path.join(tmp, 'workspaces', 'task', key),
  ...extra
});

// ---------------------------------------------------------------------------
section('1. The registry records intent, not history');

check('an activated agent is expected', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-1'));
  assert.deepStrictEqual(
    reg.expected().map((r) => r.agentName),
    ['crabcast-task-kan-1']
  );
});

check('a deactivated agent is NOT expected — a stand-down stays down', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  reg.recordDeactivated(record('kan-2'));
  const expected = reg.expected().map((r) => r.agentName);
  assert.ok(!expected.includes('crabcast-task-kan-2'), `still expected: ${expected.join(', ')}`);
});

check('re-activating after a deactivate brings it back', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  assert.ok(reg.expected().some((r) => r.agentName === 'crabcast-task-kan-2'));
});

check('the full activation argument list round-trips', () => {
  const reg = new AgentRegistry(registryFile);
  const original = record('kan-3', {
    url: 'https://example.invalid/kan-3',
    defaultAgent: 'claude',
    mcpServers: ['crabcast']
  });
  reg.recordActivated(original);
  const restored = reg.expected().find((r) => r.agentName === 'crabcast-task-kan-3');
  assert.deepStrictEqual(restored, original);
});

check('a preemption annotation makes the stand-down a debt, and re-activation clears it', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-4'));
  reg.recordDeactivated(record('kan-4'), {
    byAgentName: 'crabcast-epic-kan-59',
    byType: 'epic',
    byKey: 'kan-59',
    byPriority: 10,
    priority: 1,
    herdrStatus: 'working',
    derivation: 'cap 2, running 2 — the slot had to come from somewhere'
  });
  assert.strictEqual(reg.preempted().length, 1, 'the preemption is owed');
  assert.ok(reg.preemptionFor('crabcast-task-kan-4'), 'preemptionFor sees the debt');
  assert.ok(!reg.expected().some((r) => r.agentName === 'crabcast-task-kan-4'),
    'a preempted agent must NOT be expected — a reboot must not overturn the decision');
  reg.recordActivated(record('kan-4'));
  assert.strictEqual(reg.preempted().length, 0, 'the list empties itself on re-activation');
  assert.strictEqual(reg.preemptionFor('crabcast-task-kan-4'), undefined);
});

// ---------------------------------------------------------------------------
section('2. The on-disk format survives an unclean shutdown');

check('every record is fsync-durable and readable by a fresh reader', () => {
  const fresh = new AgentRegistry(registryFile);
  const names = fresh.expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, [
    'crabcast-task-kan-1', 'crabcast-task-kan-2', 'crabcast-task-kan-3', 'crabcast-task-kan-4'
  ]);
});

check('a torn final line loses only the record that was in flight', () => {
  const torn = path.join(tmp, 'torn.jsonl');
  const reg = new AgentRegistry(torn);
  reg.recordActivated(record('kan-10'));
  reg.recordActivated(record('kan-11'));
  reg.recordActivated(record('kan-12'));

  // Exactly what a power cut mid-write leaves: a partial final record.
  const text = fs.readFileSync(torn, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const half = lines[lines.length - 1].slice(0, Math.floor(lines[lines.length - 1].length / 2));
  fs.writeFileSync(torn, lines.slice(0, -1).join('\n') + '\n' + half);

  const names = new AgentRegistry(torn).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(
    names,
    ['crabcast-task-kan-10', 'crabcast-task-kan-11'],
    'the two complete records before the tear must survive intact'
  );
});

check('a torn DEACTIVATE leaves the agent expected — it fails safe, not silent', () => {
  const torn = path.join(tmp, 'torn-deactivate.jsonl');
  const reg = new AgentRegistry(torn);
  reg.recordActivated(record('kan-20'));
  reg.recordDeactivated(record('kan-20'));

  const lines = fs.readFileSync(torn, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(torn, lines[0] + '\n' + lines[1].slice(0, 20));

  const names = new AgentRegistry(torn).expected().map((r) => r.agentName);
  assert.deepStrictEqual(
    names,
    ['crabcast-task-kan-20'],
    'losing a stand-down must leave the agent visible as expected, never vanish it'
  );
});

check('garbage in the middle of the log does not discard the records around it', () => {
  const messy = path.join(tmp, 'messy.jsonl');
  const reg = new AgentRegistry(messy);
  reg.recordActivated(record('kan-30'));
  const body = fs.readFileSync(messy, 'utf8');
  fs.writeFileSync(messy, body + '{ not json at all\n');
  const reg2 = new AgentRegistry(messy);
  reg2.recordActivated(record('kan-31'));
  const names = new AgentRegistry(messy).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, ['crabcast-task-kan-30', 'crabcast-task-kan-31']);
});

check('a missing registry file is an empty fleet, not an error', () => {
  assert.deepStrictEqual(new AgentRegistry(path.join(tmp, 'nope.jsonl')).expected(), []);
});

check('compaction preserves intent and drops the history', () => {
  const busy = path.join(tmp, 'busy.jsonl');
  const reg = new AgentRegistry(busy);
  for (let i = 0; i < 20; i++) {
    reg.recordActivated(record('kan-40'));
    reg.recordDeactivated(record('kan-40'));
  }
  reg.recordActivated(record('kan-41'));
  const before = fs.readFileSync(busy, 'utf8').split('\n').filter(Boolean).length;
  reg.compact();
  const after = fs.readFileSync(busy, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(after < before, `compaction did not shrink the log (${before} → ${after})`);
  assert.deepStrictEqual(
    new AgentRegistry(busy).expected().map((r) => r.agentName),
    ['crabcast-task-kan-41']
  );
});

// A real SIGKILL, so no exit hook, no flush, no cleanup — the unclean-shutdown
// proof, in miniature and reproducibly.
check('SIGKILL mid-life leaves every acknowledged record on disk', () => {
  const killed = path.join(tmp, 'killed.jsonl');
  const script = `
    import { AgentRegistry } from ${JSON.stringify(path.join(dist, 'agent-registry.js'))};
    const reg = new AgentRegistry(${JSON.stringify(killed)});
    for (let i = 0; i < 5; i++) {
      reg.recordActivated({ agentName: 'crabcast-task-kan-5' + i, type: 'task', key: 'kan-5' + i, workDir: '/tmp/w' + i });
    }
    import * as fs from 'fs';
    fs.writeFileSync(${JSON.stringify(path.join(tmp, 'killer.ready'))}, 'ok');
    setInterval(() => {}, 1000);
  `;
  const scriptPath = path.join(tmp, 'killer.mjs');
  const marker = path.join(tmp, 'killer.ready');
  fs.writeFileSync(scriptPath, script);

  // The wait-then-kill runs entirely inside one shell rather than in this
  // process: a synchronous poll here would block the event loop that has to
  // deliver the child's readiness, and the check would hang forever.
  execFileSync(
    'bash',
    [
      '-c',
      `"$1" "$2" >/dev/null 2>&1 & pid=$!; ` +
        `for _ in $(seq 1 200); do [ -f "$3" ] && break; sleep 0.1; done; ` +
        `kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 0`,
      'bash',
      process.execPath,
      scriptPath,
      marker
    ],
    { timeout: 60_000 }
  );

  assert.ok(fs.existsSync(marker), 'child never reported its writes');

  const names = new AgentRegistry(killed).expected().map((r) => r.agentName).sort();
  assert.deepStrictEqual(names, [
    'crabcast-task-kan-50', 'crabcast-task-kan-51', 'crabcast-task-kan-52',
    'crabcast-task-kan-53', 'crabcast-task-kan-54'
  ]);
});

// ---------------------------------------------------------------------------
section('3. Resume framing differs by whether a conversation survived');

const withHistory = path.join(tmp, 'ws-with-history');
const withoutHistory = path.join(tmp, 'ws-without-history');
fs.mkdirSync(withHistory, { recursive: true });
fs.mkdirSync(withoutHistory, { recursive: true });

check('a workspace with no transcript has nothing to restore', () => {
  assert.strictEqual(hasRestorableConversation(withoutHistory), false);
});

check('a workspace with a non-empty transcript has something to restore', () => {
  const dir = claudeTranscriptDir(withHistory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), '{"type":"user"}\n');
  try {
    assert.strictEqual(hasRestorableConversation(withHistory), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('an empty transcript file does not count as restorable', () => {
  const dir = claudeTranscriptDir(withHistory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), '');
  try {
    assert.strictEqual(hasRestorableConversation(withHistory), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("the transcript path matches Claude Code's own mangling", () => {
  assert.strictEqual(
    claudeTranscriptDir('/home/someone/.local/share/crabcast/workspaces/task/kan-21'),
    path.join(
      os.homedir(),
      '.claude/projects/-home-someone--local-share-crabcast-workspaces-task-kan-21'
    )
  );
});

check('the degraded prompt tells the agent it lost its memory and points at its work', () => {
  const prompt = degradedResumePrompt('task', 'KAN-21');
  for (const phrase of ['NO memory', 'KAN-21', PROMPT_FILENAME, 'not restart the task']) {
    assert.ok(prompt.includes(phrase), `degraded prompt is missing ${JSON.stringify(phrase)}`);
  }
});

check('the nudge frames the interruption and forbids starting over', () => {
  const nudge = resumeNudge('task', 'KAN-21');
  for (const phrase of ['interrupted mid-work', 'KAN-21', 'Do not start over']) {
    assert.ok(nudge.includes(phrase), `nudge is missing ${JSON.stringify(phrase)}`);
  }
  assert.ok(!nudge.includes('\n'), 'the nudge is typed into a TUI and must be one line');
});

check("a preempted agent is told it was a decision, not a crash", () => {
  const nudge = resumeNudge('task', 'KAN-21', 'preempted');
  assert.ok(/deliberately stood down/.test(nudge), nudge);
  assert.ok(!/restarted/.test(nudge), 'a preemption resume must not claim a machine crash');
});

// ---------------------------------------------------------------------------
section('4. The launcher carries the resume framing into the pane');

check('the claude launcher still tries --continue first', () => {
  const command = AGENT_LAUNCHERS.claude.command();
  assert.ok(command.startsWith('claude --permission-mode bypassPermissions --continue ||'), command);
});

check('a degraded prompt reaches the fallback, correctly quoted', () => {
  const prompt = degradedResumePrompt('task', 'KAN-21');
  const command = AGENT_LAUNCHERS.claude.command(prompt);
  assert.ok(command.includes("'"), 'the prompt must be single-quoted for bash');
  const quoted = command.slice(command.indexOf('||') + 2);
  assert.ok(quoted.includes('NO memory'), 'the degraded framing did not reach the fallback');
});

check('a prompt containing a single quote cannot break out of the quoting', () => {
  const command = AGENT_LAUNCHERS.claude.command(`don't; rm -rf /`);
  // Everything after the fallback's flags must be one quoted word; the escape
  // sequence for an embedded quote is close-escape-reopen.
  assert.ok(command.includes(`'don'\\''t; rm -rf /'`), command);
});

check('the resume modal thresholds are raised past any real conversation', () => {
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES) > 70 * 1000);
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD) > 100_000 * 1000);
});

check('the launcher table declares who restores conversations, not the nudge', () => {
  // The port moved the extraction source's hardcoded `defaultAgent !== 'claude'`
  // guard and AGENT_READY_MARKERS behind the launcher interface: a launcher
  // that restores a conversation must say so and bring its own readiness
  // evidence, and one that does not is never nudged.
  assert.strictEqual(AGENT_LAUNCHERS.claude.restoresConversation, true);
  assert.ok(Array.isArray(AGENT_LAUNCHERS.claude.readyMarkers) &&
    AGENT_LAUNCHERS.claude.readyMarkers.length > 0);
  assert.ok(!AGENT_LAUNCHERS.shell.restoresConversation, 'a shell restores nothing');
});

// ---------------------------------------------------------------------------
section('5. Reconciliation delivers the framing end-to-end (shim herdr)');

// Everything on the daemon side is real: the real reconcileAgents, the real
// MessageRouter, the real HerdrBridge (initPty and all), a real config through
// the real loader, a real on-disk registry. What is faked is the `herdr`
// binary — a shim on PATH that records every invocation argv-exact and answers
// in herdr's own JSON shapes without spawning anything. The recorded argv is
// therefore the whole truth about what would have run in each pane.

const scratch = path.join(scratchRoot, 'reconcile');
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN72_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN72_SHIM_STATE;
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
if (a === 'agent' && b === 'read') {
  // A pane already at its prompt: the readiness marker the nudge waits for.
  out({ result: { read: { text: 'bypass permissions on\\n❯ ', truncated: false } } });
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
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${shimDir}:${realPath}`;

const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const dataDir = path.join(scratch, 'data');
const configPath = path.join(scratch, 'crabcast.config.json');
fs.mkdirSync(path.join(scratch, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'prompts', 'task.md'), 'KAN-72 proof workspace {{KEY}}.\n');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: 'task', priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'claude' }
  ]
}, null, 2));

const { HerdrBridge, workspaceDirFor } = await import(path.join(dist, 'herdr.js'));
const { MessageRouter } = await import(path.join(dist, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(dist, 'registry.js'));
const { PromptLoader } = await import(path.join(dist, 'prompt.js'));
const { loadConfig } = await import(path.join(dist, 'config.js'));
const { reconcileAgents } = await import(path.join(dist, 'reconcile.js'));

const config = loadConfig(configPath);
const bridge = new HerdrBridge(config.dataDir);
const workspaceTypes = new WorkspaceRegistry(config.workspaceTypes);
const reconcileRegistry = new AgentRegistry(path.join(dataDir, 'agents.jsonl'));
const router = new MessageRouter({
  registry: workspaceTypes,
  config,
  promptLoader: new PromptLoader(config.baseDir),
  herdrBridge: bridge,
  daemonStartedAt: new Date(),
  agentRegistry: reconcileRegistry,
  send: () => {},
  broadcast: () => {}
});

// Two agents the registry expects: one whose workspace has a restorable
// conversation, one with genuinely no history. Exactly the daemon-died-
// under-the-fleet state, minus the reboot.
const HIST_KEY = 'res-hist';
const FRESH_KEY = 'res-fresh';
const histDir = workspaceDirFor(config.dataDir, 'task', HIST_KEY);
const freshDir = workspaceDirFor(config.dataDir, 'task', FRESH_KEY);
fs.mkdirSync(histDir, { recursive: true });
fs.mkdirSync(freshDir, { recursive: true });
reconcileRegistry.recordActivated({
  agentName: `crabcast-task-${HIST_KEY}`, type: 'task', key: HIST_KEY,
  workDir: histDir, defaultAgent: 'claude'
});
reconcileRegistry.recordActivated({
  agentName: `crabcast-task-${FRESH_KEY}`, type: 'task', key: FRESH_KEY,
  workDir: freshDir, defaultAgent: 'claude'
});

// A third, for KAN-88 finding B8: a non-claude launcher in a workspace that
// has a *Claude* transcript on disk. `hasRestorableConversation` reads Claude
// Code's transcript directory and knows nothing about agy's, so asking it
// unconditionally answered a question about the wrong program — this agent was
// framed as having its memory back and the nudge machinery was told to wait
// for a prompt it would never recognise, while agy had in fact started fresh.
const AGY_KEY = 'res-agy';
const agyDir = workspaceDirFor(config.dataDir, 'task', AGY_KEY);
fs.mkdirSync(agyDir, { recursive: true });
reconcileRegistry.recordActivated({
  agentName: `crabcast-task-${AGY_KEY}`, type: 'task', key: AGY_KEY,
  workDir: agyDir, defaultAgent: 'anti-gravity'
});

// The conversations that survived, where Claude Code would have left them —
// including in the agy agent's workspace, which is the trap.
for (const dir of [histDir, agyDir]) {
  const transcripts = claudeTranscriptDir(dir);
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, 'session.jsonl'), '{"type":"user"}\n');
}
const transcriptDir = claudeTranscriptDir(histDir);

const reconcileLog = [];
const result = await reconcileAgents({
  registry: reconcileRegistry,
  herdrBridge: bridge,
  router,
  workspaceTypes,
  cause: 'reboot',
  log: (...args) => reconcileLog.push(args.join(' '))
});
for (const line of reconcileLog) console.log(`    ${line}`);

const starts = invocations().filter((argv) => argv[0] === 'agent' && argv[1] === 'start');
const startFor = (name) => starts.find((argv) => argv[2] === name);
const paneCommandOf = (argv) => argv[argv.length - 1];
const outcomeFor = (key) => result.outcomes.find((o) => o.key === key);

await checkAsync('every expected agent was restored through the real activation path', async () => {
  assert.strictEqual(result.expected, 3);
  assert.strictEqual(outcomeFor(HIST_KEY)?.result, 'restored');
  assert.strictEqual(outcomeFor(FRESH_KEY)?.result, 'restored');
  assert.strictEqual(outcomeFor(AGY_KEY)?.result, 'restored');
});

await checkAsync('a restored conversation resumes and gets the interrupted-work nudge typed at it', async () => {
  const outcome = outcomeFor(HIST_KEY);
  assert.strictEqual(outcome.resumedConversation, true, JSON.stringify(outcome));
  assert.strictEqual(outcome.nudged, true, `not nudged: ${JSON.stringify(outcome)}`);

  // The pane command tried --continue with the ordinary fallback — NOT the
  // degraded framing; this agent has its memory.
  const command = paneCommandOf(startFor(`crabcast-task-${HIST_KEY}`));
  assert.ok(command.includes('--continue'), command);
  assert.ok(!command.includes('NO memory'), 'a restorable conversation must not get the degraded prompt');

  // And the nudge really went to the pane: herdr was told to type the
  // interrupted-work message and press Enter.
  const sent = invocations().find((argv) => argv[0] === 'pane' && argv[1] === 'send-text');
  assert.ok(sent, 'no pane send-text was ever issued');
  assert.ok(sent[3].includes('interrupted mid-work'), sent[3]);
  assert.ok(sent[3].includes(HIST_KEY), sent[3]);
});

await checkAsync('a workspace with no history starts with the degraded-resume prompt as its argv prompt', async () => {
  const outcome = outcomeFor(FRESH_KEY);
  assert.strictEqual(outcome.resumedConversation, false, JSON.stringify(outcome));
  assert.ok(outcome.nudged === undefined, 'the degraded branch needs no nudge — it is already working');

  const command = paneCommandOf(startFor(`crabcast-task-${FRESH_KEY}`));
  assert.ok(command.includes('NO memory'), `degraded framing missing from: ${command}`);
  assert.ok(command.includes('restarted with NO memory') || command.includes('NO memory'), command);

  // Only one nudge was ever typed — at the restored agent, not this one.
  const sends = invocations().filter((argv) => argv[0] === 'pane' && argv[1] === 'send-text');
  assert.strictEqual(sends.length, 1, JSON.stringify(sends.map((s) => s[3])));
});

await checkAsync(
  'KAN-88 B8: a non-claude launcher is not framed by Claude\'s transcript directory',
  async () => {
    const outcome = outcomeFor(AGY_KEY);

    // The trap is live: Claude's transcript directory for this workspace does
    // hold a conversation, so the old unconditional probe would have said yes.
    assert.ok(
      hasRestorableConversation(agyDir),
      'the fixture is wrong — there is no Claude transcript to be misled by'
    );

    // And the answer is nonetheless no, because the launcher does not declare
    // that it restores conversations.
    assert.strictEqual(
      outcome.resumedConversation,
      false,
      `an anti-gravity agent was framed by Claude's transcripts: ${JSON.stringify(outcome)}`
    );

    // So it starts already working, with the degraded framing on its command
    // line, and nothing waits on a prompt marker it would never print.
    const command = paneCommandOf(startFor(`crabcast-task-${AGY_KEY}`));
    assert.ok(command.startsWith('agy '), `not the agy launcher: ${command}`);
    assert.ok(command.includes('NO memory'), `degraded framing missing from: ${command}`);
    assert.ok(outcome.nudged === undefined, `it was nudged anyway: ${JSON.stringify(outcome)}`);
  }
);

// Release the shim's PTY attaches before the census sections below.
for (const session of bridge.listActiveSessions()) {
  try { session.ptyProcess?.kill(); } catch {}
}
process.env.PATH = realPath;

// ---------------------------------------------------------------------------
section('6. A session is not proof that an agent is alive');

// The defect these cover was found in the extraction source, by the reboot its
// registry was written for. An agent was restored at boot, died later, and
// `list_agents` went on reporting it `active` with `missingAgents: []` —
// because the census counted any session the daemon held, without asking herdr
// whether the agent behind it still existed. A dead agent that reports as
// healthy is the silent loss the registry exists to remove.

/** A router wired to a herdr that says exactly what a test wants it to say. */
function routerWith({ sessions, herdr, reachable = true, registry }) {
  const herdrBridge = {
    listActiveSessions: () => sessions,
    listHerdrAgentsChecked: () => ({ reachable, agents: herdr }),
    listHerdrAgents: () => herdr,
    listHerdrStatuses: () => new Map(herdr.map((a) => [a.name, a.herdrStatus])),
    abandonSession: () => {}
  };
  return new MessageRouter({
    registry: workspaceTypes,
    config,
    promptLoader: new PromptLoader(config.baseDir),
    herdrBridge,
    daemonStartedAt: new Date(),
    agentRegistry: registry,
    send: () => {},
    broadcast: () => {}
  });
}

const session = (key, expectsRuntime = true) => ({
  sessionId: `task-${key}-1`,
  type: 'task',
  key,
  url: null,
  createdAt: new Date(0),
  status: 'active',
  workDir: path.join(tmp, 'workspaces', 'task', key),
  expectsRuntime
});

const herdrAgent = (key, agentRuntime = 'claude') => ({
  name: `crabcast-task-${key}`,
  agentRuntime,
  workDir: path.join(tmp, 'workspaces', 'task', key),
  herdrStatus: 'working'
});

function registryExpecting(...keys) {
  const file = path.join(tmp, `reg-${keys.join('-')}-${Math.random()}.jsonl`);
  const reg = new AgentRegistry(file);
  for (const key of keys) reg.recordActivated(record(key));
  return reg;
}

check('an agent herdr no longer has is missing, even while its session lingers', () => {
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [], // herdr answered, and it has never heard of this agent
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.strictEqual(missing.length, 1, `expected 1 missing, got ${JSON.stringify(missing)}`);
  assert.strictEqual(missing[0].agentName, 'crabcast-task-kan-21');
});

check('the reason says it started and died, not that it never existed', () => {
  const [missing] = routerWith({
    sessions: [session('kan-21')],
    herdr: [],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.ok(/started and then died/.test(missing.reason), missing.reason);
});

check('the census releases the stale session instead of leaving the corpse active', () => {
  // The KAN-70 review's carry-over: the extraction source computed
  // staleSessions and discarded it, so a dead pane's session stayed `active`
  // and the next activate for that address reused the corpse — failing only
  // after a full confirm-timeout poll. Detection now releases the session.
  const stale = session('kan-21');
  let released = null;
  const herdrBridge = {
    listActiveSessions: () => [stale],
    listHerdrAgentsChecked: () => ({ reachable: true, agents: [] }),
    listHerdrAgents: () => [],
    listHerdrStatuses: () => new Map(),
    abandonSession: (sessionId, error) => { released = { sessionId, error }; }
  };
  const r = new MessageRouter({
    registry: workspaceTypes,
    config,
    promptLoader: new PromptLoader(config.baseDir),
    herdrBridge,
    daemonStartedAt: new Date(),
    agentRegistry: registryExpecting('kan-21'),
    send: () => {},
    broadcast: () => {}
  });
  r.findMissingAgents();
  assert.ok(released, 'the stale session was not released');
  assert.strictEqual(released.sessionId, stale.sessionId);
});

check('a session inside the runtime-confirm window is not condemned by an empty pane', () => {
  // The epic review's blocker on the release above: a freshly spawned agent
  // legitimately shows no runtime for up to RUNTIME_CONFIRM_TIMEOUT_MS —
  // that gap is exactly why confirmActivation polls — so a census taken
  // inside the window (any list_agents poll, the 30s sweep) must neither
  // abandon the session the in-flight activate is still confirming nor
  // report the agent missing. Only a session older than the window is fair
  // game for the verdict.
  const fresh = { ...session('kan-21'), createdAt: new Date() };
  let released = null;
  const herdrBridge = {
    listActiveSessions: () => [fresh],
    // herdr answered: the pane exists, nothing runs in it yet — a booting
    // agent, indistinguishable on this evidence from a dead one.
    listHerdrAgentsChecked: () => ({ reachable: true, agents: [herdrAgent('kan-21', null)] }),
    listHerdrAgents: () => [herdrAgent('kan-21', null)],
    listHerdrStatuses: () => new Map(),
    abandonSession: (sessionId, error) => { released = { sessionId, error }; }
  };
  const r = new MessageRouter({
    registry: workspaceTypes,
    config,
    promptLoader: new PromptLoader(config.baseDir),
    herdrBridge,
    daemonStartedAt: new Date(),
    agentRegistry: registryExpecting('kan-21'),
    send: () => {},
    broadcast: () => {}
  });
  const missing = r.findMissingAgents();
  assert.strictEqual(released, null, `the in-flight session was abandoned: ${JSON.stringify(released)}`);
  assert.deepStrictEqual(missing, [], 'a booting agent must not be reported missing');
});

check('a pane whose agent runtime has exited is missing too', () => {
  // herdr knows the name but nothing is running in the pane — the same
  // emptiness, reported one layer down.
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [herdrAgent('kan-21', null)],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.strictEqual(missing.length, 1, JSON.stringify(missing));
});

check('a shell workspace with no runtime is working as asked, not missing', () => {
  // The one case where an empty pane is the product rather than the failure.
  // Reporting it would be a false alarm about something doing its job.
  const file = path.join(tmp, 'reg-shell.jsonl');
  const reg = new AgentRegistry(file);
  reg.recordActivated(record('kan-21', { defaultAgent: 'shell' }));

  const missing = routerWith({
    sessions: [session('kan-21', false)],
    herdr: [herdrAgent('kan-21', null)],
    registry: reg
  }).findMissingAgents();

  assert.deepStrictEqual(missing, [], 'a shell workspace must not be reported dead');
});

check('a healthy agent is not reported missing', () => {
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [herdrAgent('kan-21')],
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.deepStrictEqual(missing, []);
});

check('an unreachable herdr condemns nobody — silence is not evidence of death', () => {
  // The trap: an unreachable herdr returns an empty census, which looks
  // identical to "every agent is gone". Acting on it would declare a whole
  // healthy fleet dead the moment herdr hiccups.
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [],
    reachable: false,
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.deepStrictEqual(missing, [], 'an unreachable herdr must not condemn a live agent');
});

check('a deliberately stood-down agent is not reported missing', () => {
  const file = path.join(tmp, 'reg-standdown.jsonl');
  const reg = new AgentRegistry(file);
  reg.recordActivated(record('kan-21'));
  reg.recordDeactivated({ agentName: 'crabcast-task-kan-21', type: 'task', key: 'kan-21', workDir: '' });

  const missing = routerWith({ sessions: [], herdr: [], registry: reg }).findMissingAgents();
  assert.deepStrictEqual(missing, [], 'a stand-down must stay down, not become an alarm');
});

// ---------------------------------------------------------------------------
section('7. Waiting budgets survive a suspend');

check('the restore wait is monotonic, so sleeping through it does not consume it', () => {
  // On the reboot the extraction source proved this with, the laptop suspended
  // 1.5s into the first restore and woke 5h40m later. A Date.now() deadline
  // had expired without a single poll after resume, so a restored agent was
  // written off as "never reached a prompt" and never nudged. CLOCK_MONOTONIC
  // excludes suspended time, which is the only reading of "120 seconds" that
  // means anything to an agent that was asleep for most of them.
  const src = ['reconcile.js', 'nudge.js']
    .map((file) => fs.readFileSync(path.join(dist, file), 'utf8'))
    .join('\n');
  // Matched on the deadline arithmetic rather than on any mention of the two
  // clocks, so that the comment explaining why the wall clock is wrong here
  // cannot itself fail the check.
  assert.ok(
    !/deadline\s*=\s*Date\.now\(\)/.test(src),
    'a wait deadline is still computed from the wall clock'
  );
  const monotonicDeadlines = src.match(/deadline\s*=\s*monotonicNow\(\)/g) ?? [];
  assert.strictEqual(
    monotonicDeadlines.length,
    2,
    `expected both wait budgets (herdr-ready, agent-ready) to be monotonic, found ${monotonicDeadlines.length}`
  );
  assert.ok(/performance\.now\(\)/.test(src), 'the waits do not use a monotonic clock');
});

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.log(`${failures} FAILED.`);
  process.exit(1);
}
