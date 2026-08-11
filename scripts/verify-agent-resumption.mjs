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
// conversation, (section 5) that reconciliation delivers that framing
// end-to-end through the real activation path, and (section 8) what a
// mid-restore herdr blip does to the agents it lands on.
//
// Section 8 is KAN-124's carried item 1, answered here rather than in another
// design round: `activate` can now refuse as unverifiable, and this loop
// restores N agents over N x 3 seconds, so a herdr that stalls for ten of them
// hits some agents and not others.
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
const { paneNameFor, canonicalizeOrNull } = await import(path.join(dist, 'identity.js'));

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

/**
 * The knobs a caller freezes onto an agent; `configure` requires the first two.
 *
 * `refusable: false` IS DELIBERATE AND IT IS NEW (KAN-263). Boot restoration
 * used to activate with `override: true`, so the capacity gate returned no
 * verdict at all and reconcile respawned whatever it was asked to regardless of
 * the machine. It does not any more — a restore the machine has no room for is
 * DEFERRED — and this file's subject is what an agent is TOLD when it comes
 * back, not whether there was room for it.
 *
 * Left refusable, the section that asserts "a herdr blip that CLEARS costs one
 * extra pass rather than an agent" is decided by the runner's load average
 * instead: with no daemon in this process there is no CPU sampler, so the gate
 * falls back to `os.loadavg()[0]` — the pre-KAN-208 instrument production does
 * not use — and on a machine at load 3.2 of 4 cores it defers the retry and
 * this file reports a resumption failure that is nothing of the kind. Observed
 * exactly that way before this line was changed.
 *
 * Nothing else about the path changes: `capacityGate` returns early on this
 * flag, and the spawn, the resume decision and the nudge are all untouched. The
 * gate's own behaviour under a restore sequence is asserted where it is the
 * subject rather than the weather — scripts/verify-restore-admission.mjs.
 */
const knobs = (over = {}) => ({
  priority: 1, refusable: false, chargeable: true, preemptable: true,
  launcher: 'claude', ...over
});

/** A directory a caller owns. Every address in this file is one. */
const dirFor = (name) => {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
};

// A durable record is a path, its configuration, and who activated it. Under
// the type model most of it could be looked up again from config; it cannot
// now, so the row IS the agent — which is why section 1 checks the whole thing
// round-trips.
//
// `activatedBy: null` is written rather than left off (KAN-113): the registry
// normalizes every row on both edges, so a record built without the field comes
// back WITH it, and the round-trip assertion below is a deep equality. Saying
// it here keeps that assertion honest in the strong direction — it now checks
// that parentage round-trips too, rather than being relaxed to ignore it.
const record = (name, over = {}, activatedBy = null) => ({
  path: dirFor(name), config: knobs(over), activatedBy
});

// ---------------------------------------------------------------------------
section('1. The registry records intent, not history');

check('an activated agent is expected', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-1'));
  assert.deepStrictEqual(reg.expected().map((r) => r.path), [dirFor('kan-1')]);
});

check('a configured agent EXISTS but is not expected — nobody asked for it to run', () => {
  // The event the compaction preserve set had to learn about. It is the whole
  // reason `configure` is a separate verb: an agent can exist without running.
  const reg = new AgentRegistry(registryFile);
  reg.recordConfigured(record('kan-1b'));
  assert.ok(reg.intents().has(dirFor('kan-1b')), 'the agent does not exist');
  assert.ok(!reg.expected().some((r) => r.path === dirFor('kan-1b')),
    'a configured-never-activated agent must not be restored at boot');
});

check('a deactivated agent is NOT expected — a stand-down stays down', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  reg.recordDeactivated(record('kan-2'));
  const expected = reg.expected().map((r) => r.path);
  assert.ok(!expected.includes(dirFor('kan-2')), `still expected: ${expected.join(', ')}`);
});

check('re-activating after a deactivate brings it back', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2'));
  assert.ok(reg.expected().some((r) => r.path === dirFor('kan-2')));
});

check('a forgotten agent stops existing entirely — not merely stops being expected', () => {
  const reg = new AgentRegistry(registryFile);
  reg.recordActivated(record('kan-2c'));
  reg.recordForgotten(record('kan-2c'));
  assert.ok(!reg.intents().has(dirFor('kan-2c')), 'the record survived a forget');
  assert.ok(!reg.expected().some((r) => r.path === dirFor('kan-2c')));
});

check('the whole configuration round-trips — it is the only copy there is', () => {
  const reg = new AgentRegistry(registryFile);
  const original = record('kan-3', {
    launcher: 'claude', mcpServers: { crabcast: 'builtin' }, label: 'a label', prompt: 'finished text'
  });
  reg.recordActivated(original);
  const restored = reg.expected().find((r) => r.path === dirFor('kan-3'));
  assert.deepStrictEqual(restored, original);
});

check('a preemption annotation makes the stand-down a debt, and re-activation clears it', () => {
  const reg = new AgentRegistry(registryFile);
  const boss = dirFor('kan-59-boss');
  reg.recordActivated(record('kan-4'));
  reg.recordDeactivated(record('kan-4'), {
    byPath: boss,
    byPaneName: paneNameFor(boss),
    byPriority: 10,
    priority: 1,
    herdrStatus: 'working',
    derivation: 'cap 2, running 2 — the slot had to come from somewhere'
  });
  assert.strictEqual(reg.preempted().length, 1, 'the preemption is owed');
  assert.ok(reg.preemptionFor(dirFor('kan-4')), 'preemptionFor sees the debt');
  assert.ok(!reg.expected().some((r) => r.path === dirFor('kan-4')),
    'a preempted agent must NOT be expected — a reboot must not overturn the decision');
  reg.recordActivated(record('kan-4'));
  assert.strictEqual(reg.preempted().length, 0, 'the list empties itself on re-activation');
  assert.strictEqual(reg.preemptionFor(dirFor('kan-4')), undefined);
});

// ---------------------------------------------------------------------------
section('2. The on-disk format survives an unclean shutdown');

check('every record is fsync-durable and readable by a fresh reader', () => {
  const fresh = new AgentRegistry(registryFile);
  const paths = fresh.expected().map((r) => r.path).sort();
  assert.deepStrictEqual(paths, ['kan-1', 'kan-2', 'kan-3', 'kan-4'].map(dirFor).sort());
});

check('and every row carries the on-disk version marker, per row rather than per file', () => {
  // Per-row rather than a header, and the reasoning is on-disk-format rather
  // than aesthetic: appends are O_APPEND so there is nowhere to put a header,
  // concatenating two logs must not let one file's version claim the other's
  // rows, and compaction rewrites rows rather than files.
  const rows = new AgentRegistry(registryFile).readLog();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.v === 1), 'a row is missing its version marker');
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

  const paths = new AgentRegistry(torn).expected().map((r) => r.path).sort();
  assert.deepStrictEqual(
    paths,
    [dirFor('kan-10'), dirFor('kan-11')].sort(),
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

  const paths = new AgentRegistry(torn).expected().map((r) => r.path);
  assert.deepStrictEqual(
    paths,
    [dirFor('kan-20')],
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
  const paths = new AgentRegistry(messy).expected().map((r) => r.path).sort();
  assert.deepStrictEqual(paths, [dirFor('kan-30'), dirFor('kan-31')].sort());
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
    new AgentRegistry(busy).expected().map((r) => r.path),
    [dirFor('kan-41')]
  );
});

// A real SIGKILL, so no exit hook, no flush, no cleanup — the unclean-shutdown
// proof, in miniature and reproducibly.
check('SIGKILL mid-life leaves every acknowledged record on disk', () => {
  const killed = path.join(tmp, 'killed.jsonl');
  const script = `
    import { AgentRegistry } from ${JSON.stringify(path.join(dist, 'agent-registry.js'))};
    const reg = new AgentRegistry(${JSON.stringify(killed)});
    const config = { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'claude' };
    for (let i = 0; i < 5; i++) {
      reg.recordActivated({ path: '/tmp/kan21-killed-' + i, config });
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

  const paths = new AgentRegistry(killed).expected().map((r) => r.path).sort();
  assert.deepStrictEqual(paths, [0, 1, 2, 3, 4].map((i) => '/tmp/kan21-killed-' + i));
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
  // Addressed by the directory it is, and pointed at its bootstrap prompt by
  // ABSOLUTE path — that file lives in CrabCast's sidecar now, so a bare
  // filename would name nothing from the agent's cwd.
  const sidecarPrompt = `/data/agents/abc12345/${PROMPT_FILENAME}`;
  const prompt = degradedResumePrompt('/home/someone/work', 'reboot', sidecarPrompt);
  for (const phrase of ['NO memory', '/home/someone/work', sidecarPrompt, 'not restart the task']) {
    assert.ok(prompt.includes(phrase), `degraded prompt is missing ${JSON.stringify(phrase)}`);
  }
});

check('an agent configured without a prompt is not pointed at a file that does not exist', () => {
  // `prompt` is optional, so the degraded framing must not invent one.
  const prompt = degradedResumePrompt('/home/someone/work', 'reboot');
  assert.ok(prompt.includes('NO memory'));
  assert.ok(!prompt.includes(PROMPT_FILENAME), `it named a prompt file anyway: ${prompt}`);
});

check('the nudge frames the interruption and forbids starting over', () => {
  const nudge = resumeNudge('/home/someone/work');
  for (const phrase of ['interrupted mid-work', '/home/someone/work', 'Do not start over']) {
    assert.ok(nudge.includes(phrase), `nudge is missing ${JSON.stringify(phrase)}`);
  }
  assert.ok(!nudge.includes('\n'), 'the nudge is typed into a TUI and must be one line');
});

check("a preempted agent is told it was a decision, not a crash", () => {
  const nudge = resumeNudge('/home/someone/work', 'preempted');
  assert.ok(/deliberately stood down/.test(nudge), nudge);
  assert.ok(!/restarted/.test(nudge), 'a preemption resume must not claim a machine crash');
});

// ---------------------------------------------------------------------------
section('4. The launcher carries the resume framing into the pane');

check('the claude launcher tries --continue first WHEN RESUMING IS PERMITTED', () => {
  const command = AGENT_LAUNCHERS.claude.command({ mayResume: true });
  assert.ok(command.startsWith('claude --permission-mode bypassPermissions --continue ||'), command);
});

check('and drops --continue entirely when it is NOT — the resume rule (KAN-111)', () => {
  // THE HAZARD THIS IS ABOUT. Claude Code keys transcripts on the working
  // directory, and under path identity that directory is the caller's. Anyone
  // who has ever run `claude` in their own repository has a conversation of
  // THEIRS sitting at exactly the key an agent activated there would resume
  // from. Suppressing only the predictor would have changed which prompt the
  // fallback got and nothing else — the `--continue` in front of it still runs
  // and still restores the transcript — so the rule has to reach the command
  // line, which is here.
  const command = AGENT_LAUNCHERS.claude.command({ mayResume: false });
  assert.ok(!command.includes('--continue'), `--continue survived the rule: ${command}`);
  assert.ok(!command.includes('||'), `the resume branch survived the rule: ${command}`);
  assert.strictEqual(command, 'claude --permission-mode bypassPermissions');
});

check('anti-gravity obeys the same rule — it is about the path, not the runtime', () => {
  // agy keeps its own per-directory session, so `agy --continue` at a
  // caller-owned path has the same problem for the same reason. The rule binds
  // every launcher that can continue anything.
  assert.ok(AGENT_LAUNCHERS['anti-gravity'].command({ mayResume: true }).includes('--continue'));
  assert.ok(!AGENT_LAUNCHERS['anti-gravity'].command({ mayResume: false }).includes('--continue'));
});

check('a degraded prompt reaches the fallback, correctly quoted', () => {
  const prompt = degradedResumePrompt('/home/someone/work', 'reboot');
  const command = AGENT_LAUNCHERS.claude.command({ promptCommand: prompt, mayResume: true });
  assert.ok(command.includes("'"), 'the prompt must be single-quoted for bash');
  const quoted = command.slice(command.indexOf('||') + 2);
  assert.ok(quoted.includes('NO memory'), 'the degraded framing did not reach the fallback');
});

check('and reaches the command directly when resuming is not permitted', () => {
  const prompt = degradedResumePrompt('/home/someone/work', 'reboot');
  const command = AGENT_LAUNCHERS.claude.command({ promptCommand: prompt, mayResume: false });
  assert.ok(command.includes('NO memory'), `the framing was lost with the resume branch: ${command}`);
});

check('a prompt containing a single quote cannot break out of the quoting', () => {
  const command = AGENT_LAUNCHERS.claude.command({
    promptCommand: `don't; rm -rf /`,
    mayResume: true
  });
  // Everything after the fallback's flags must be one quoted word; the escape
  // sequence for an embedded quote is close-escape-reopen.
  assert.ok(command.includes(`'don'\\''t; rm -rf /'`), command);
});

check('the resume modal thresholds are raised past any real conversation', () => {
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES) > 70 * 1000);
  assert.ok(Number(RESUME_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD) > 100_000 * 1000);
});

check('an agent configured with no prompt gets no invented instruction', () => {
  // `command(undefined)` is a real case now, not a default: `prompt` is
  // optional on `configure`, and substituting a generic instruction would be
  // this daemon inventing one nobody wrote.
  const command = AGENT_LAUNCHERS.claude.command({ mayResume: true });
  assert.ok(command.endsWith('bypassPermissions'), command);
  assert.ok(!command.includes("'"), `something was quoted into an empty prompt: ${command}`);
});

check('a shell agent given a prompt still receives it', () => {
  // `shell` delivers a bare prompt with no runtime, so there is nothing to
  // instruct — but a configured prompt must not simply vanish. It used to be
  // written into the agent's own cwd, where a human would trip over it; it now
  // lives in a sidecar nobody browsing that shell would find.
  const withPrompt = AGENT_LAUNCHERS.shell.command({
    promptCommand: 'read /sidecar/prompt.md',
    mayResume: false
  });
  assert.ok(withPrompt.includes('/sidecar/prompt.md'), withPrompt);
  assert.ok(withPrompt.includes('exec bash'), `the shell itself must still be the pane: ${withPrompt}`);
  assert.strictEqual(AGENT_LAUNCHERS.shell.command({ mayResume: false }), 'bash');
  // A bare shell has no conversation either way, so the rule changes nothing
  // for it — asserted rather than assumed, since "mayResume is ignored here"
  // is exactly the kind of claim that rots.
  assert.strictEqual(AGENT_LAUNCHERS.shell.command({ mayResume: true }), 'bash');
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
  // A DOWN marker makes herdr unreachable without taking it off PATH, which
  // is a different failure. Section 8 uses it to blip mid-restore.
  if (fs.existsSync(path.join(state, 'herdr-down'))) {
    process.stderr.write('herdr: could not connect to the herdr server');
    process.exit(1);
  }
  out({ result: { agents: started.map((s) => ({
    name: s.name, pane_id: 'p-' + s.name.slice(-6), agent: 'claude', cwd: s.cwd, agent_status: 'working'
  })) } });
}
// THE PANE IS STATEFUL NOW, and that is what makes 'nudged' mean anything.
// It used to answer a fixed string, so \`sendToAgent\` could report success
// having typed into a pane that never changed — the check below asserted
// \`nudged: true\` and would have gone on asserting it if the Enter were
// dropped, because 'nudged' meant 'keystrokes dispatched'. It now means
// 'confirmed on the pane' (KAN-114), so the pane has to be able to show the
// difference: text typed sits after the caret, and only Enter moves it above.
const paneFile = path.join(state, 'pane.json');
const readPane = () => fs.existsSync(paneFile)
  ? JSON.parse(fs.readFileSync(paneFile, 'utf8'))
  : { transcript: 'bypass permissions on', composer: '' };
const writePane = (p) => fs.writeFileSync(paneFile, JSON.stringify(p));
/** What herdr would show: the transcript, then the composer after the caret. */
const renderPane = (p) => \`\${p.transcript}\\n❯ \${p.composer}\`;

if (a === 'agent' && b === 'read') {
  out({ result: { read: { text: renderPane(readPane()), truncated: false } } });
}
if (a === 'pane' && b === 'send-text') {
  const p = readPane();
  p.composer = args[3] ?? '';
  writePane(p);
  out({ result: {} });
}
if (a === 'pane' && b === 'send-keys') {
  const p = readPane();
  if (args[3] === 'Enter') {
    // Submitting moves the composer into the transcript, which is the ONLY
    // way text gets above the caret — exactly the distinction the delivery
    // check reads. A shim that dropped this line reproduces the witnessed
    // lost-Enter failure; section 5's own mutation does not need it, but
    // verify-send-confirms-delivery is built on it.
    if (p.composer) p.transcript += \`\\n❯ \${p.composer}\`;
    p.composer = '';
  } else if (args[3] === 'C-c') {
    p.composer = '';
  }
  writePane(p);
  out({ result: {} });
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
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

const { HerdrBridge } = await import(path.join(dist, 'herdr.js'));
const { MessageRouter } = await import(path.join(dist, 'router.js'));
const { loadConfig } = await import(path.join(dist, 'config.js'));
const { reconcileAgents } = await import(path.join(dist, 'reconcile.js'));

const config = loadConfig(configPath);
const bridge = new HerdrBridge(config.dataDir);
const reconcileRegistry = new AgentRegistry(path.join(dataDir, 'agents.jsonl'));
const router = new MessageRouter({
  config,
  herdrBridge: bridge,
  daemonStartedAt: new Date(),
  agentRegistry: reconcileRegistry,
  send: () => {},
  broadcast: () => {}
});

/** A directory the caller owns, for section 5 onwards. */
const ownedDir = (name) => {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
};

// Two agents the registry expects: one whose workspace has a restorable
// conversation, one with genuinely no history. Exactly the daemon-died-
// under-the-fleet state, minus the reboot.
const histDir = ownedDir('res-hist');
const freshDir = ownedDir('res-fresh');
reconcileRegistry.recordActivated({ path: histDir, config: knobs() });
reconcileRegistry.recordActivated({ path: freshDir, config: knobs() });

// A third, for KAN-88 finding B8: a non-claude launcher in a workspace that
// has a *Claude* transcript on disk. `hasRestorableConversation` reads Claude
// Code's transcript directory and knows nothing about agy's, so asking it
// unconditionally answered a question about the wrong program — this agent was
// framed as having its memory back and the nudge machinery was told to wait
// for a prompt it would never recognise, while agy had in fact started fresh.
const agyDir = ownedDir('res-agy');
reconcileRegistry.recordActivated({ path: agyDir, config: knobs({ launcher: 'anti-gravity' }) });

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
  cause: 'reboot',
  log: (...args) => reconcileLog.push(args.join(' '))
});
for (const line of reconcileLog) console.log(`    ${line}`);

const starts = invocations().filter((argv) => argv[0] === 'agent' && argv[1] === 'start');
const startFor = (name) => starts.find((argv) => argv[2] === name);
const paneCommandOf = (argv) => argv[argv.length - 1];
const outcomeFor = (dir) => result.outcomes.find((o) => o.path === dir);

await checkAsync('every expected agent was restored through the real activation path', async () => {
  assert.strictEqual(result.expected, 3);
  assert.strictEqual(outcomeFor(histDir)?.result, 'restored');
  assert.strictEqual(outcomeFor(freshDir)?.result, 'restored');
  assert.strictEqual(outcomeFor(agyDir)?.result, 'restored');
});

await checkAsync('a restored conversation resumes and gets the interrupted-work nudge typed at it', async () => {
  const outcome = outcomeFor(histDir);
  assert.strictEqual(outcome.resumedConversation, true, JSON.stringify(outcome));
  assert.strictEqual(outcome.nudged, true, `not nudged: ${JSON.stringify(outcome)}`);

  // The pane command tried --continue with the ordinary fallback — NOT the
  // degraded framing; this agent has its memory.
  const command = paneCommandOf(startFor(paneNameFor(histDir)));
  assert.ok(command.includes('--continue'), command);
  assert.ok(!command.includes('NO memory'), 'a restorable conversation must not get the degraded prompt');

  // And the nudge really went to the pane: herdr was told to type the
  // interrupted-work message and press Enter.
  const sent = invocations().find((argv) => argv[0] === 'pane' && argv[1] === 'send-text');
  assert.ok(sent, 'no pane send-text was ever issued');
  assert.ok(sent[3].includes('interrupted mid-work'), sent[3]);
  assert.ok(sent[3].includes(histDir), sent[3]);
});

await checkAsync('a workspace with no history starts with the degraded-resume prompt as its argv prompt', async () => {
  const outcome = outcomeFor(freshDir);
  assert.strictEqual(outcome.resumedConversation, false, JSON.stringify(outcome));
  assert.ok(outcome.nudged === undefined, 'the degraded branch needs no nudge — it is already working');

  const command = paneCommandOf(startFor(paneNameFor(freshDir)));
  assert.ok(command.includes('NO memory'), `degraded framing missing from: ${command}`);
  assert.ok(command.includes('restarted with NO memory') || command.includes('NO memory'), command);

  // Only one nudge was ever typed — at the restored agent, not this one.
  const sends = invocations().filter((argv) => argv[0] === 'pane' && argv[1] === 'send-text');
  assert.strictEqual(sends.length, 1, JSON.stringify(sends.map((s) => s[3])));
});

await checkAsync(
  'KAN-88 B8: a non-claude launcher is not framed by Claude\'s transcript directory',
  async () => {
    const outcome = outcomeFor(agyDir);

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
    const command = paneCommandOf(startFor(paneNameFor(agyDir)));
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
function routerWith({ sessions, herdr, reachable = true, registry, onAbandon }) {
  const herdrBridge = {
    listActiveSessions: () => sessions,
    listHerdrAgentsChecked: () => ({ reachable, agents: herdr }),
    listHerdrAgents: () => herdr,
    listHerdrStatuses: () => new Map(herdr.map((a) => [a.name, a.herdrStatus])),
    abandonSession: (sessionId, error) => onAbandon?.(sessionId, error)
  };
  return new MessageRouter({
    config,
    herdrBridge,
    daemonStartedAt: new Date(),
    agentRegistry: registry,
    send: () => {},
    broadcast: () => {}
  });
}

const session = (name, expectsRuntime = true) => ({
  sessionId: `${name}-1`,
  path: dirFor(name),
  paneName: paneNameFor(dirFor(name)),
  createdAt: new Date(0),
  status: 'active',
  expectsRuntime
});

// The census entry for one of our agents. `canonicalWorkDir` is what the
// registry join compares against — the real bridge computes it once, here it
// is supplied, and it is the only field the join reads.
const herdrAgent = (name, agentRuntime = 'claude') => ({
  name: paneNameFor(dirFor(name)),
  paneId: `p-${name}`,
  agentRuntime,
  workDir: dirFor(name),
  canonicalWorkDir: canonicalizeOrNull(dirFor(name)),
  herdrStatus: 'working'
});

function registryExpecting(...names) {
  const file = path.join(tmp, `reg-${names.join('-')}-${Math.random()}.jsonl`);
  const reg = new AgentRegistry(file);
  for (const name of names) reg.recordActivated(record(name));
  return reg;
}

check('an agent herdr no longer has is missing, even while its session lingers', () => {
  const missing = routerWith({
    sessions: [session('kan-21')],
    herdr: [], // herdr answered, and it has never heard of this agent
    registry: registryExpecting('kan-21')
  }).findMissingAgents();

  assert.strictEqual(missing.length, 1, `expected 1 missing, got ${JSON.stringify(missing)}`);
  assert.strictEqual(missing[0].path, dirFor('kan-21'));
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
  routerWith({
    sessions: [stale],
    herdr: [],
    registry: registryExpecting('kan-21'),
    onAbandon: (sessionId, error) => { released = { sessionId, error }; }
  }).findMissingAgents();
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
  // herdr answered: the pane exists, nothing runs in it yet — a booting agent,
  // indistinguishable on this evidence from a dead one.
  const missing = routerWith({
    sessions: [fresh],
    herdr: [herdrAgent('kan-21', null)],
    registry: registryExpecting('kan-21'),
    onAbandon: (sessionId, error) => { released = { sessionId, error }; }
  }).findMissingAgents();
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

check('a shell agent with no runtime is working as asked, not missing', () => {
  // The one case where an empty pane is the product rather than the failure.
  // Reporting it would be a false alarm about something doing its job.
  const file = path.join(tmp, 'reg-shell.jsonl');
  const reg = new AgentRegistry(file);
  reg.recordActivated(record('kan-21', { launcher: 'shell' }));

  const missing = routerWith({
    sessions: [session('kan-21', false)],
    herdr: [herdrAgent('kan-21', null)],
    registry: reg
  }).findMissingAgents();

  assert.deepStrictEqual(missing, [], 'a shell agent must not be reported dead');
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
  reg.recordDeactivated(record('kan-21'));

  const missing = routerWith({ sessions: [], herdr: [], registry: reg }).findMissingAgents();
  assert.deepStrictEqual(missing, [], 'a stand-down must stay down, not become an alarm');
});


// ---------------------------------------------------------------------------
section('8. A mid-restore herdr blip is deferred, never a loss and never a skip');

// KAN-124's carried item 1, answered here rather than in another design round.
//
// `activate` can now refuse as UNVERIFIABLE: herdr did not answer the
// occupancy census, so it will not spawn into a directory it cannot see. That
// is right at the activation layer, and it raises a question one layer up —
// reconcile restores N agents over N x 3 seconds, so a herdr that stalls for
// ten of those seconds hits some of them and not others.
//
// All three of the obvious answers are wrong:
//
//   * marked FAILED  — a transient refusal becomes a permanent verdict in the
//                      line a human reads at boot, and "failed" next to a
//                      perfectly restorable agent is how somebody concludes it
//                      is gone
//   * silently SKIPPED — the fleet comes back short and the summary says
//                      nothing. That is the KAN-21 shape exactly
//   * retried FOREVER — a herdr that is genuinely down keeps boot hanging, and
//                      boot is the one place a daemon must not hang
//
// So: deferred, retried once, and NOTHING IS WRITTEN. The agent's last event
// is still `activated`, so it stays in expected() — a transient refusal cannot
// become a permanent "this agent is gone", because the only thing that could
// say so is a durable row and none is appended. What is still deferred after
// the retry is named in the summary AND picked up by the missing-agent sweep.

{
  const blipScratch = path.join(scratchRoot, 'blip');
  const blipData = path.join(blipScratch, 'data');
  const blipConfigPath = path.join(blipScratch, 'crabcast.config.json');
  fs.mkdirSync(blipScratch, { recursive: true });
  fs.writeFileSync(blipConfigPath, JSON.stringify({ dataDir: blipData }, null, 2));
  const blipConfig = loadConfig(blipConfigPath);

  const blipDir = path.join(blipScratch, 'owned');
  fs.mkdirSync(blipDir, { recursive: true });
  const one = fs.realpathSync(blipDir);

  const blipRegistry = new AgentRegistry(path.join(blipData, 'agents.jsonl'));
  blipRegistry.recordActivated({ path: one, config: knobs() });
  const logBefore = blipRegistry.readLog().length;

  // The blip that does not clear. herdr answers the OUTER readiness probe —
  // reconcile waits for that before deciding anything — and then stops
  // answering the census, which is exactly "it was up when the pass started".
  let startsIssued = 0;
  let readyProbes = 0;
  const downBridge = {
    herdrReachable: () => ++readyProbes === 1,
    listHerdrAgentsChecked: () => ({ reachable: false, agents: [] }),
    listHerdrAgents: () => [],
    listHerdrStatuses: () => new Map(),
    listActiveSessions: () => [],
    getSessionByPath: () => undefined,
    abandonSession: () => {},
    occupancyOf: (census) => (census.reachable ? { reachable: true, occupants: [], ours: false } : { reachable: false }),
    spawnSession: () => { startsIssued++; throw new Error('nothing may be spawned on an unverifiable census'); }
  };
  const blipRouter = new MessageRouter({
    config: blipConfig,
    herdrBridge: downBridge,
    daemonStartedAt: new Date(),
    agentRegistry: blipRegistry,
    send: () => {},
    broadcast: () => {}
  });

  const blipLog = [];
  const blipResult = await reconcileAgents({
    registry: blipRegistry,
    herdrBridge: downBridge,
    router: blipRouter,
    cause: 'reboot',
    log: (...args) => blipLog.push(args.join(' '))
  });
  for (const line of blipLog) console.log(`    ${line}`);

  const outcome = blipResult.outcomes[0];

  check('the refusal is DEFERRED, not failed', () => {
    assert.strictEqual(outcome?.result, 'deferred', JSON.stringify(blipResult.outcomes));
  });

  check('and nothing was started — the occupancy guard held all the way down', () => {
    assert.strictEqual(startsIssued, 0, 'a spawn was attempted on an unverifiable census');
  });

  check('NOTHING was written to the registry — a transient refusal cannot become a loss', () => {
    assert.strictEqual(
      blipRegistry.readLog().length, logBefore,
      'reconcile appended a row for an agent it never decided anything about'
    );
    assert.strictEqual(blipRegistry.intents().get(one)?.event, 'activated');
  });

  check('so it is STILL EXPECTED, and one call away from coming back', () => {
    assert.deepStrictEqual(blipRegistry.expected().map((r) => r.path), [one]);
  });

  check('and it is not a silent skip: the missing-agent sweep reports it', () => {
    // The second channel. `list_agents` reports it on every poll and the 30s
    // sweep broadcasts it — so a deferred agent is visible in two independent
    // places until somebody acts, which is the difference between "deferred"
    // and "quietly dropped".
    const missing = new MessageRouter({
      config: blipConfig,
      herdrBridge: {
        ...downBridge,
        listHerdrAgentsChecked: () => ({ reachable: true, agents: [] }),
        listHerdrAgents: () => []
      },
      daemonStartedAt: new Date(),
      agentRegistry: blipRegistry,
      send: () => {}, broadcast: () => {}
    }).findMissingAgents();
    assert.strictEqual(missing.length, 1, JSON.stringify(missing));
    assert.strictEqual(missing[0].path, one);
  });

  check('the reconcile log names the deferred agents rather than counting them away', () => {
    const joined = blipLog.join('\n');
    assert.ok(/[Dd]eferring/.test(joined), joined);
    assert.ok(joined.includes(one), `the deferred agent is not named: ${joined}`);
    assert.ok(
      /left expected and unrestored|NOT marked lost/.test(joined),
      `the log does not say what state they were left in: ${joined}`
    );
  });

  // And the other half: a blip that CLEARS costs one extra pass, not an agent.
  {
    const clearScratch = path.join(scratchRoot, 'blip-clears');
    const clearData = path.join(clearScratch, 'data');
    fs.mkdirSync(clearScratch, { recursive: true });
    const clearConfigPath = path.join(clearScratch, 'crabcast.config.json');
    fs.writeFileSync(clearConfigPath, JSON.stringify({ dataDir: clearData }, null, 2));
    const clearConfig = loadConfig(clearConfigPath);
    const clearDir = path.join(clearScratch, 'owned');
    fs.mkdirSync(clearDir, { recursive: true });
    const target = fs.realpathSync(clearDir);

    const clearRegistry = new AgentRegistry(path.join(clearData, 'agents.jsonl'));
    clearRegistry.recordActivated({ path: target, config: knobs() });

    // Down until reconcile announces the retry, then up. Flipped from the log
    // callback rather than counted, so the fixture cannot drift out of step
    // with how many census reads the restore path happens to take.
    let censusDown = true;
    const spawned = [];
    const flakyBridge = {
      herdrReachable: () => true,
      listHerdrAgentsChecked: () => (censusDown
        ? { reachable: false, agents: [] }
        : { reachable: true, agents: [] }),
      listHerdrAgents: () => [],
      listHerdrStatuses: () => new Map(),
      listActiveSessions: () => [],
      getSessionByPath: () => undefined,
      abandonSession: () => {},
      occupancyOf: (census) => (census.reachable
        ? { reachable: true, occupants: [], ours: false }
        : { reachable: false }),
      spawnSession: (p) => {
        spawned.push(p);
        return {
          sessionId: 'stub', path: p, paneName: paneNameFor(p),
          createdAt: new Date(), status: 'active', ptyBuffer: '', onDataListeners: []
        };
      },
      confirmAgentPresent: async () => ({ present: true, paneId: '%1', waitedMs: 0, checks: 1 })
    };

    const clearRouter = new MessageRouter({
      config: clearConfig, herdrBridge: flakyBridge, daemonStartedAt: new Date(),
      agentRegistry: clearRegistry, send: () => {}, broadcast: () => {}
    });
    const clearLog = [];
    const clearResult = await reconcileAgents({
      registry: clearRegistry, herdrBridge: flakyBridge, router: clearRouter,
      cause: 'reboot',
      log: (...a) => {
        const line = a.join(' ');
        clearLog.push(line);
        if (/retrying them once/.test(line)) censusDown = false;
      }
    });

    check('a blip that CLEARS costs one extra pass rather than an agent', () => {
      assert.strictEqual(clearResult.outcomes[0]?.result, 'restored',
        JSON.stringify(clearResult.outcomes));
      assert.deepStrictEqual(spawned, [target]);
      assert.ok(clearLog.join('\n').includes('retrying them once'),
        'the retry was never announced');
    });
  }
}

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
