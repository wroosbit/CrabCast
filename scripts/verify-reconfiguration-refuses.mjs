#!/usr/bin/env node
// Live proof for KAN-126: reconfiguration is answered PER ATTRIBUTE, and where
// a respawn would be required the API REFUSES rather than performing it.
//
// THE SENTENCE THIS SCRIPT EXISTS TO KEEP TRUE is the customer's own:
//
//   "a reconciler that quietly discards conversation history to satisfy a
//    config diff is the worst bug this design could have. I would rather have
//    an honest 'cannot change X in place' than a convenient one that costs me
//    an agent's memory."
//
// So the question "if the configs differ, change them" gets an answer that is
// NOT UNIFORM ACROSS ATTRIBUTES:
//
//   priority, refusable, chargeable, preemptable, label  ->  IN PLACE. The
//     daemon reads them out of the record at the moment a capacity or
//     preemption decision is made. Nothing in the pane holds a copy.
//   launcher, prompt, mcpServers                         ->  REFUSED. They
//     were consumed at spawn — the launcher IS the process, the prompt has
//     been read, .mcp.json is read once at boot — so applying them under a
//     live agent would change the record without changing the agent.
//
// A SILENT DEFER IS NOT AN ACCEPTABLE MIDDLE, and section 3 is where that is
// asserted rather than asserted-about: accepting the change and applying it at
// next start leaves configuration and reality disagreeing behind a
// `success: true`, which is the same failure in a quieter costume.
//
// THE TRAP THIS SCRIPT IS BUILT AGAINST. A refusal is the easiest thing in the
// world to assert vacuously: a daemon that refused EVERYTHING would pass a
// suite that only checks `success === false`. So every refusal here is
// asserted against POSITIVE evidence that the world is unchanged, taken from
// outside the response:
//
//   * the pane count and the pane id are COUNTED from a stub census that
//     really gains a pane on `agent start` and really loses one on
//     `pane close` — a silent destroy-and-recreate is precisely a changed
//     paneId, and that is what section 8 asserts across every section;
//   * `agent start` and `pane close` are counted from the stub's own ARGV LOG,
//     so "nothing was respawned" is evidence rather than inference;
//   * the conversation on disk is hashed before and after;
//   * the DURABLE RECORD is read off the log rather than off the response,
//     because a response can say "unchanged" over a row that changed;
//   * and section 1's in-place change is proven by a DECISION FLIPPING — the
//     same activation that was offered a victim before is refused a victim
//     after — rather than by a status read agreeing with itself.
//
// Sections:
//   1. IN PLACE, PROVEN LIVE   — priority changes on a RUNNING agent and the
//                                capacity gate's next decision reads the new
//                                value. No respawn, no touched conversation.
//   2. THE REFUSAL             — a respawn-requiring change is refused, names
//                                the attribute and why, and the agent is still
//                                running with its conversation intact.
//   3. PER KNOB, ATOMIC        — a call mixing the two reports each outcome
//                                distinctly and applies NOTHING. A call that
//                                applies half and reports a bare success is
//                                the defect this task exists to prevent.
//   4. EVERY KNOB, BOTH WAYS   — each of the eight, one at a time, against the
//                                classification table. Exhaustive because a
//                                knob nobody classified is the silent failure.
//   5. THE REMEDY WORKS        — deactivate, reconfigure, activate: the new
//                                value is in effect and step 1's transcript is
//                                still on disk. The caller chose the respawn.
//   6. SILENCE IS NOT EVIDENCE — herdr unreachable + a record that says active
//                                refuses the restart-only knobs as
//                                unverifiable, and still applies the in-place
//                                ones.
//   7. THE TOKEN               — configVersion moves on acceptance and NEVER
//                                on a refusal.
//   8. THE PANE NEVER MOVED    — the assertion that proves the requirement:
//                                one pane id across every section above.
//   9. THE CHECKS CAN FAIL     — the compiled daemon is mutated four ways and
//                                the assertions go red.
//  10. THE SURFACES            — the same behaviour through the real CLI and
//                                the real MCP server against a real daemon.
//
// Only the external `herdr` binary is replaced. The router, bridge, registry,
// config loader, CLI and MCP server are the real compiled code.
//
// Usage:
//   npm run build
//   node scripts/verify-reconfiguration-refuses.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter, RECONFIGURATION_COST } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor, sidecarDirFor } = await import(path.join(distDir, 'identity.js'));
const { claudeTranscriptDir } = await import(path.join(distDir, 'resume.js'));
const { connectToDaemon, onJsonLines, writeJsonLine, socketPathFor } =
  await import(path.join(distDir, 'ipc.js'));
const { PROMPT_FILENAME } = await import(path.join(distDir, 'launchers.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => {
  const body = value === undefined ? '(undefined)' : JSON.stringify(value, null, 2);
  console.log(`   ${label}\n${String(body).replace(/^/gm, '     ')}`);
};

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan126-'));
const realPath = process.env.PATH;
const daemonPids = new Set();
process.on('exit', () => {
  for (const pid of daemonPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(...parts) {
  const dir = path.join(tmp, 'owned', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// ----------------------------------------------------------------- the stub
//
// STATEFUL, because half of this script's assertions are COUNTS. A fixed
// census could show that a refusal returned `success: false`; only a census
// that really gains a pane on `agent start` and really loses one on
// `pane close` can show that the refusal left the agent alone. Every argv is
// logged before dispatch, so a call herdr refused is as visible as one it
// served.

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
const ARGV_LOG = path.join(tmp, 'herdr-argv.log');
const PANE_SEQ = path.join(tmp, 'pane-seq');

fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/usr/bin/env node
const fs = require('fs');
const CENSUS = ${JSON.stringify(CENSUS_FILE)};
const ARGV_LOG = ${JSON.stringify(ARGV_LOG)};
const PANE_SEQ = ${JSON.stringify(PANE_SEQ)};
const argv = process.argv.slice(2);
fs.appendFileSync(ARGV_LOG, argv.join(' ') + '\\n');

if (argv[0] === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

const raw = fs.readFileSync(CENSUS, 'utf8');
if (raw.trim() === 'DOWN') {
  process.stderr.write('herdr: could not connect to the herdr server\\n');
  process.exit(1);
}
const panes = JSON.parse(raw);
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
  const seq = Number(fs.readFileSync(PANE_SEQ, 'utf8')) + 1;
  fs.writeFileSync(PANE_SEQ, String(seq));
  panes.push({
    name,
    pane_id: '%' + seq,
    // A LIVE RUNTIME. Every agent in this script launches \`shell\`, which
    // reports none — but occupancy and the ownership test both turn on the
    // runtime field, so the stub reports one and the proofs are about the
    // daemon's rules rather than about a launcher's quirk.
    agent: 'claude',
    agent_status: 'working',
    cwd: cwdFlag === -1 ? null : argv[cwdFlag + 1]
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
ok({});
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;
fs.writeFileSync(PANE_SEQ, '0');

const setCensus = (panes) =>
  fs.writeFileSync(CENSUS_FILE, panes === 'DOWN' ? 'DOWN' : JSON.stringify(panes));
const censusPanes = () => {
  const raw = fs.readFileSync(CENSUS_FILE, 'utf8');
  return raw.trim() === 'DOWN' ? [] : JSON.parse(raw);
};
/** Panes in a directory, whosever they are. THE measurement. */
const panesIn = (dir) => censusPanes().filter((p) => p.cwd === dir);
const paneIdIn = (dir) => panesIn(dir)[0]?.pane_id ?? null;

const resetArgvLog = () => fs.writeFileSync(ARGV_LOG, '');
/**
 * Every argv the stub was called with since the last reset.
 *
 * IT THROWS RATHER THAN ANSWERING `[]`. This used to swallow a read error, and
 * that turns every `startsIssued() === 0` assertion in this file into one that
 * cannot tell "nothing happened" from "I could not look" — a zero-assertion
 * that passes when its own evidence is missing. A broken harness should stop
 * the run loudly, not report the world it failed to observe as quiet.
 */
const herdrCalls = () => {
  try {
    return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    throw new Error(
      `could not read the stub's argv log at ${ARGV_LOG}: ${e?.message ?? e}. Every ` +
        `"nothing was spawned" assertion in this script is counted from it, so an unreadable ` +
        `log is a broken proof rather than a quiet one.`
    );
  }
};
const startsIssued = () => herdrCalls().filter((l) => /^agent start\b/.test(l)).length;
const closesIssued = () => herdrCalls().filter((l) => /^pane close\b/.test(l)).length;

/**
 * A router over a named registry file. One bridge per harness, because the
 * bridge's session map is part of what decides "is this agent running".
 */
function harness(logName, RouterCtor = MessageRouter, RegistryCtor = AgentRegistry) {
  const agentRegistry = new RegistryCtor(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const events = [];
  const invoke = (request) =>
    new Promise((resolve) => {
      const router = new RouterCtor({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: (msg) => events.push(msg)
      });
      router.handle(request);
    });
  return { agentRegistry, bridge, events, invoke };
}

/**
 * A conversation on disk at a path, in the place Claude Code actually keys it.
 *
 * Written under this process's own HOME, which the runner scratches per
 * script. It is the thing the customer's sentence is about, so "the
 * conversation is intact" is a hash of the real artifact rather than a
 * stand-in for one.
 */
function seedConversation(dir, text) {
  const t = claudeTranscriptDir(dir);
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'session.jsonl'), text);
  return t;
}
function conversationDigest(dir) {
  const t = claudeTranscriptDir(dir);
  try {
    return crypto
      .createHash('sha256')
      .update(
        fs
          .readdirSync(t)
          .sort()
          .map((n) => `${n}:${fs.readFileSync(path.join(t, n), 'utf8')}`)
          .join('\u0000')
      )
      .digest('hex')
      .slice(0, 16);
  } catch {
    return '(no conversation)';
  }
}

/** The bootstrap prompt an activation actually wrote, read off the sidecar. */
function sidecarPrompt(agentPath) {
  try {
    return fs.readFileSync(path.join(sidecarDirFor(dataDir, agentPath), PROMPT_FILENAME), 'utf8');
  } catch {
    return null;
  }
}

/** Cases that reach a spawn pass the capacity gate deliberately: see section 1. */
const PAST_THE_GATE = { override: true };

const BASE = {
  priority: 4,
  refusable: true,
  chargeable: true,
  preemptable: true,
  launcher: 'shell',
  prompt: 'KAN-126: you are the agent whose memory must not be spent on a config diff.',
  mcpServers: { crabcast: 'builtin' },
  label: 'the reconfigured agent'
};

/** Every pane id this script ever saw for the section-1..5 agent. See section 8. */
const paneIdsSeen = new Set();
const watchPane = (dir) => {
  const id = paneIdIn(dir);
  if (id) paneIdsSeen.add(id);
  return id;
};

// ===========================================================================
rule('1. IN PLACE, PROVEN BY A DECISION FLIPPING — priority on a RUNNING agent');
// ===========================================================================
//
// WHY A DECISION RATHER THAN A STATUS READ. `status` echoing the new priority
// proves the record changed; it does not prove anything USES it. The claim
// this task makes is that the value is read at decision time, so the proof is
// a decision: the same activation, against the same fleet, offered a victim
// before the change and refused one after it — with nothing respawned in
// between.
//
// The cap is pinned with CRABCAST_MAX_AGENTS so the arithmetic is this
// script's rather than the runner's load average.

const theAgent = ownedDir('s1', 'the-agent');
const newcomer = ownedDir('s1', 'newcomer');
const h1 = harness('s1');

process.env.CRABCAST_MAX_AGENTS = '1';

{
  seedConversation(theAgent, '{"role":"user","text":"remember this"}\n');
  const before = conversationDigest(theAgent);

  setCensus([]);
  resetArgvLog();
  await h1.invoke({ action: 'configure_agent', path: theAgent, ...BASE, priority: 1 });
  await h1.invoke({ action: 'activate_agent', path: theAgent, ...PAST_THE_GATE });
  await h1.invoke({ action: 'configure_agent', path: newcomer, ...BASE, priority: 2 });

  const pane = watchPane(theAgent);
  check(pane !== null && panesIn(theAgent).length === 1,
    '(setup) the agent is running in exactly one pane', `pane ${pane}`);

  // THE DECISION, BEFORE. Priority 2 outranks priority 1, so the gate offers
  // the running agent as a victim.
  const offerBefore = await h1.invoke({ action: 'activate_agent', path: newcomer });
  show('the capacity gate, with the running agent at priority 1:', {
    success: offerBefore.success,
    refusedBy: offerBefore.refusedBy,
    preemption: offerBefore.preemption
  });
  check(
    offerBefore.success === false && offerBefore.preemption?.path === theAgent &&
      offerBefore.preemption?.priority === 1,
    'BEFORE: the machine is full and the gate offers the running agent as the victim, ' +
      'priced at the priority on its record',
    `victim ${offerBefore.preemption?.path} at priority ${offerBefore.preemption?.priority}`
  );

  // THE CHANGE. In place, on a live agent.
  const bumped = await h1.invoke({ action: 'configure_agent', path: theAgent, ...BASE, priority: 9 });
  show('configure({priority: 9}) on the RUNNING agent:', {
    success: bumped.success, changed: bumped.changed, applied: bumped.applied,
    appliedInPlace: bumped.appliedInPlace, running: bumped.running, paneId: bumped.paneId,
    configVersion: bumped.configVersion, previousConfigVersion: bumped.previousConfigVersion,
    outcomes: bumped.outcomes, note: bumped.note
  });
  check(bumped.success === true, 'the in-place change is ACCEPTED on a running agent');
  check(
    bumped.appliedInPlace === true && bumped.changed?.join() === 'priority' &&
      bumped.outcomes?.priority === 'applied-in-place',
    'and it says so per knob: priority applied-in-place, and nothing else changed',
    `changed ${JSON.stringify(bumped.changed)} outcome ${bumped.outcomes?.priority}`
  );

  // THE DECISION, AFTER. Same call, same fleet, same daemon. Priority 2 no
  // longer outranks 9, so there is no victim to offer.
  const offerAfter = await h1.invoke({ action: 'activate_agent', path: newcomer });
  show('the capacity gate, immediately after, with NOTHING respawned:', {
    success: offerAfter.success,
    refusedBy: offerAfter.refusedBy,
    preemption: offerAfter.preemption,
    error: offerAfter.error?.split('\n')[0]
  });
  check(
    offerAfter.success === false && offerAfter.preemption === undefined,
    'AFTER: the SAME activation is refused with NO victim to offer — the gate read the new ' +
      'priority at decision time, which is what "in place" means',
    `preemption ${JSON.stringify(offerAfter.preemption)}`
  );
  check(
    /priority 9/.test(offerAfter.error ?? ''),
    'and the refusal prices the running agent at 9, so the new value is visible in the ' +
      'arithmetic rather than only in a status read'
  );

  // AND NOTHING WAS DESTROYED TO DO IT.
  check(paneIdIn(theAgent) === pane && panesIn(theAgent).length === 1,
    'the agent is in the SAME pane it started in — no respawn',
    `${pane} -> ${paneIdIn(theAgent)}`);
  check(startsIssued() === 1 && closesIssued() === 0,
    'exactly one `agent start` in the whole section and NO `pane close` — counted from the ' +
      "stub's own argv log",
    `starts ${startsIssued()}, closes ${closesIssued()}`);
  check(conversationDigest(theAgent) === before,
    'and the conversation on disk is byte-identical', `${before} -> ${conversationDigest(theAgent)}`);

  const echoed = await h1.invoke({ action: 'agent_status', path: theAgent });
  check(echoed.config?.priority === 9 && echoed.state === 'running',
    'the state read echoes the new priority on an agent that is still running',
    `priority ${echoed.config?.priority}, state ${echoed.state}`);

  // The durable half, read off the log rather than off a response.
  const onDisk = h1.agentRegistry.intents().get(theAgent);
  check(onDisk.record.config.priority === 9 && onDisk.event === 'activated',
    'and the RECORD carries the new priority while its last event is STILL `activated` — a ' +
      '`configured` row here would drop a live agent out of expected() and a daemon restart ' +
      'would silently not bring it back',
    `priority ${onDisk.record.config.priority}, event ${onDisk.event}`);
  check(h1.agentRegistry.expected().some((r) => r.path === theAgent),
    'so a restart WOULD still restore it: it is in expected()');
}

// ===========================================================================
rule('2. THE REFUSAL — a respawn-requiring change on a running agent');
// ===========================================================================
//
// The point of the task. Attempt `prompt` on the agent section 1 left running.

let versionBeforeRefusal;
{
  const before = conversationDigest(theAgent);
  // `conversationDigest` answers '(no conversation)' when it cannot read the
  // directory, so a transcript that vanished would make BOTH sides of the
  // comparison below equal and the assertion vacuous. Anchoring to "there is
  // something there to preserve" is what keeps it a measurement.
  check(before !== '(no conversation)',
    '(setup) there is a conversation on disk to preserve — otherwise "intact" compares ' +
      'nothing against nothing',
    before);
  const pane = watchPane(theAgent);
  const record = h1.agentRegistry.intents().get(theAgent);
  versionBeforeRefusal = record.configVersion;
  resetArgvLog();

  const no = await h1.invoke({
    action: 'configure_agent', path: theAgent, ...BASE, priority: 9,
    prompt: 'KAN-126: forget everything and start again.'
  });
  console.log('\n   the refusal, verbatim:\n' + JSON.stringify(no, null, 2).replace(/^/gm, '     '));

  check(no.success === false, 'the call is REFUSED');
  check(no.refused === 'restart-required',
    "labelled `restart-required` — a named refusal, not a bare failure", no.refused);
  check(Array.isArray(no.attributes) && no.attributes.join() === 'prompt',
    'and it NAMES THE ATTRIBUTE that forced it', JSON.stringify(no.attributes));
  check(/prompt/.test(no.error) && /already read it/.test(no.error),
    'and gives the mechanical REASON — the running agent has already read it');
  check(Array.isArray(no.applied) && no.applied.length === 0,
    'applied: [] — nothing was written', JSON.stringify(no.applied));
  check(typeof no.remedy === 'string' && /deactivate/.test(no.remedy) &&
    /configure/.test(no.remedy) && /activate/.test(no.remedy),
    'the REMEDY is in the response: deactivate, reconfigure, activate', no.remedy);
  check(!/force/.test(no.remedy ?? '') && /no force flag/.test(no.error),
    'and it says there is no force flag — a force flag is the silent destroy with a label on it');

  // THE AGENT IS UNTOUCHED. Asserted from outside the response.
  check(panesIn(theAgent).length === 1 && paneIdIn(theAgent) === pane,
    'THE AGENT IS STILL RUNNING, in the same pane', `${pane} -> ${paneIdIn(theAgent)}`);
  check(startsIssued() === 0 && closesIssued() === 0,
    'no `agent start` and no `pane close` were issued by the refused call',
    `calls: ${JSON.stringify(herdrCalls())}`);
  check(conversationDigest(theAgent) === before,
    'ITS CONVERSATION IS INTACT — hashed before and after', `${before} -> ${conversationDigest(theAgent)}`);

  // AND IT STILL RESPONDS. The daemon still holds the session, `status` still
  // reports it running, and a message still reaches it.
  const status = await h1.invoke({ action: 'agent_status', path: theAgent });
  check(status.success === true && status.state === 'running' && status.sessionless === false,
    'the daemon still holds a live session for it: state running, sessionless false',
    `state ${status.state}, sessionless ${status.sessionless}`);
  const sent = await h1.invoke({ action: 'send_to_agent', path: theAgent, message: 'still there?' });
  check(sent.success === true,
    'AND IT STILL ANSWERS THE VERBS: a message is delivered to the pane it is still in',
    `send: ${JSON.stringify({ success: sent.success, error: sent.error })}`);

  // THE ECHO STILL DESCRIBES WHAT IS RUNNING. This is the honesty interlock
  // requirement 1 depends on: the refusal is what makes the echoed config the
  // RUNNING config rather than the last thing requested.
  check(status.config?.prompt === BASE.prompt,
    'and `status` still echoes the OLD prompt — the echo describes what the agent is ' +
      'RUNNING with, which is exactly what the refusal buys',
    `echoed ${JSON.stringify(status.config?.prompt?.slice(0, 40))}`);
  check(status.configVersion === versionBeforeRefusal && no.configVersion === versionBeforeRefusal,
    'and the version did not move, on the record or in the refusal',
    `record v${status.configVersion}, refusal reported v${no.configVersion}`);
}

// ===========================================================================
rule('3. PER KNOB — a mixed call reports each outcome distinctly, and is ATOMIC');
// ===========================================================================
//
// "A call that applies half and reports a bare success is the defect this task
// exists to prevent." So this section asserts three separate things: that the
// call is refused, that the in-place half is reported DISTINCTLY from the
// refused half, and that the in-place half really did not land.

{
  const record = h1.agentRegistry.intents().get(theAgent);
  const priorityBefore = record.record.config.priority;
  const versionBefore = record.configVersion;
  const pane = watchPane(theAgent);
  resetArgvLog();

  const mixed = await h1.invoke({
    action: 'configure_agent', path: theAgent, ...BASE,
    priority: 11,                                  // in place, on its own
    label: 'renamed',                              // in place, on its own
    launcher: 'claude',                            // RESTART
    prompt: 'KAN-126: a different bootstrap entirely.'  // RESTART
  });
  console.log('\n   the mixed call, verbatim:\n' + JSON.stringify(mixed, null, 2).replace(/^/gm, '     '));

  check(mixed.success === false,
    'the mixed call is REFUSED WHOLE — not partially accepted');
  check(
    JSON.stringify(mixed.attributes?.slice().sort()) === JSON.stringify(['launcher', 'prompt']),
    'it names BOTH restart-requiring attributes', JSON.stringify(mixed.attributes));
  check(
    JSON.stringify(mixed.withheld?.slice().sort()) === JSON.stringify(['label', 'priority']),
    'and it names the in-place ones SEPARATELY, as WITHHELD — a caller that cannot tell ' +
      '"refused" from "would have worked" cannot tell whether re-sending them alone would',
    JSON.stringify(mixed.withheld));

  const o = mixed.outcomes ?? {};
  show('per-knob outcomes:', o);
  check(
    o.priority === 'withheld' && o.label === 'withheld' &&
      o.launcher === 'refused-restart-required' && o.prompt === 'refused-restart-required',
    'EACH KNOB CARRIES ITS OWN OUTCOME, and the two kinds are DIFFERENT STRINGS — the ' +
      'response cannot be read as a bare success or as a uniform failure',
    JSON.stringify(o));
  check(
    o.refusable === 'unchanged' && o.chargeable === 'unchanged' &&
      o.preemptable === 'unchanged' && o.mcpServers === 'unchanged',
    'and the knobs this call did not move are reported as unchanged rather than omitted',
    JSON.stringify(o));
  check(
    Object.keys(o).sort().join() === Object.keys(RECONFIGURATION_COST).sort().join(),
    'EVERY knob in the configuration appears in the map — a knob that fell out of the ' +
      'report is a knob whose fate a caller would have to guess at',
    `${Object.keys(o).length} of ${Object.keys(RECONFIGURATION_COST).length}`);

  // ATOMICITY, PROVEN AGAINST THE RECORD.
  const after = h1.agentRegistry.intents().get(theAgent);
  check(
    after.record.config.priority === priorityBefore && after.record.config.label === BASE.label,
    'AND NOTHING LANDED: priority and label are still what they were, read off the durable ' +
      'log rather than off the response',
    `priority ${after.record.config.priority} (asked for 11), label ${JSON.stringify(after.record.config.label)}`);
  check(after.configVersion === versionBefore,
    'the version did not move', `v${versionBefore} -> v${after.configVersion}`);
  check(after.record.config.launcher === BASE.launcher && after.record.config.prompt === BASE.prompt,
    'and neither did the restart-requiring knobs');
  check(panesIn(theAgent).length === 1 && paneIdIn(theAgent) === pane &&
    startsIssued() === 0 && closesIssued() === 0,
    'the agent is still in the same pane and nothing was spawned or closed',
    `pane ${paneIdIn(theAgent)}, starts ${startsIssued()}, closes ${closesIssued()}`);

  // AND THE IN-PLACE HALF WORKS WHEN SENT ALONE — so the refusal above is
  // about the restart-requiring knobs rather than about reconfiguration.
  const alone = await h1.invoke({
    action: 'configure_agent', path: theAgent, ...BASE, priority: 11, label: 'renamed'
  });
  check(alone.success === true && alone.outcomes?.priority === 'applied-in-place' &&
    alone.outcomes?.label === 'applied-in-place',
    'sending the in-place knobs ALONE succeeds and applies both in place — the refusal was ' +
      'about the attributes that needed a respawn, not about reconfiguring a live agent',
    JSON.stringify(alone.outcomes));
  check(h1.agentRegistry.intents().get(theAgent).record.config.priority === 11,
    'and this time the record really moved');
}

// ===========================================================================
rule('4. EVERY KNOB, ONE AT A TIME, AGAINST THE CLASSIFICATION TABLE');
// ===========================================================================
//
// EXHAUSTIVE, DERIVED FROM THE TABLE ITSELF. The failure this guards against
// is a knob nobody classified: a new spawn-time attribute that falls through
// to the permissive branch is written under a live agent and nothing says so.
// Iterating `RECONFIGURATION_COST` means a knob added without a case here
// fails this section rather than escaping it.

{
  /** A distinct, valid value for each knob, so "changed" is unambiguous. */
  const NEW_VALUE = {
    priority: 42,
    refusable: false,
    chargeable: false,
    // `chargeable: false` with `preemptable: true` is refused as incoherent,
    // so this knob's change is expressed the other way round: BASE has it true.
    preemptable: false,
    label: 'a different label',
    launcher: 'claude',
    prompt: 'KAN-126: a wholly different bootstrap.',
    mcpServers: {}
  };

  for (const [knob, cost] of Object.entries(RECONFIGURATION_COST)) {
    const dir = ownedDir('s4', knob);
    const h = harness(`s4-${knob}`);
    // The census is NOT reset here: section 1's agent is still running in it
    // and section 5 stands that same agent down. Every measurement below is
    // filtered by directory, so accumulating panes costs nothing — and wiping
    // them would silently un-run the agent the later sections are about.
    resetArgvLog();
    await h.invoke({ action: 'configure_agent', path: dir, ...BASE });
    const up = await h.invoke({ action: 'activate_agent', path: dir, ...PAST_THE_GATE });
    const pane = paneIdIn(dir);
    // WITHOUT THIS, `paneIdIn(dir) === pane` BELOW DEGRADES TO `null === null`.
    // Every claim in this loop is "…on a running agent, same pane"; if the
    // activate above ever no-opped, the loop would assert it about a world with
    // no agent in it and stay green. Sections 1 and 5 already guard their own
    // setups this way.
    check(up.success === true && up.started === true && pane !== null,
      `${knob.padEnd(11)} (setup) the agent really is running, in a pane this loop can name`,
      `success ${up.success}, started ${up.started}, pane ${pane}`);

    // `chargeable: false` needs `preemptable: false` alongside it or the
    // cross-field rule refuses the document for a reason that has nothing to
    // do with this task. Sent together, the diff is still the one knob.
    const extra = knob === 'chargeable' ? { preemptable: false } : {};
    const seed = knob === 'chargeable' ? { ...BASE, preemptable: false } : BASE;
    if (knob === 'chargeable') await h.invoke({ action: 'configure_agent', path: dir, ...seed });

    const res = await h.invoke({
      action: 'configure_agent', path: dir, ...seed, ...extra, [knob]: NEW_VALUE[knob]
    });
    const onDisk = h.agentRegistry.intents().get(dir).record.config;
    const landed = JSON.stringify(onDisk[knob] ?? null) === JSON.stringify(NEW_VALUE[knob] ?? null);

    if (cost === 'in-place') {
      check(
        res.success === true && res.outcomes?.[knob] === 'applied-in-place' && landed &&
          paneIdIn(dir) === pane && closesIssued() === 0,
        `${knob.padEnd(11)} is IN PLACE: accepted on a running agent, on the record, same pane, ` +
          `nothing closed`,
        `success ${res.success}, outcome ${res.outcomes?.[knob]}, landed ${landed}, ` +
          `pane ${pane} -> ${paneIdIn(dir)}`
      );
    } else {
      check(
        res.success === false && res.refused === 'restart-required' &&
          res.attributes?.join() === knob && res.outcomes?.[knob] === 'refused-restart-required' &&
          !landed && paneIdIn(dir) === pane && closesIssued() === 0,
        `${knob.padEnd(11)} is REFUSED: named, not applied, agent still in the same pane, ` +
          `nothing closed`,
        `success ${res.success}, refused ${res.refused}, named ${JSON.stringify(res.attributes)}, ` +
          `landed ${landed}, pane ${pane} -> ${paneIdIn(dir)}`
      );
    }

    // AND THE SAME KNOB CHANGES FREELY ONCE IT IS STOPPED. The rule is about
    // liveness, not about the attribute being immutable.
    //
    // WHICH KNOBS THIS CLAIM IS LIVE FOR, said rather than left to be worked
    // out: only the three RESTART-REQUIRED ones. For the five in-place knobs
    // the value already landed on the running agent above, so the value sent
    // here is the value on the record and the outcome is `unchanged` — the
    // `applied` half of the disjunction below cannot fail for them. They are
    // still run, because a knob that started REFUSING once stopped would be a
    // real regression and this is where it would surface; but the assertion
    // that carries weight is `launcher`, `prompt` and `mcpServers` moving from
    // `refused-restart-required` to `applied` across a stand-down.
    await h.invoke({ action: 'deactivate_agent', path: dir });
    const stopped = await h.invoke({
      action: 'configure_agent', path: dir, ...seed, ...extra, [knob]: NEW_VALUE[knob]
    });
    check(
      stopped.success === true &&
        (stopped.outcomes?.[knob] === 'applied' || stopped.outcomes?.[knob] === 'unchanged'),
      `${knob.padEnd(11)} changes freely on a STOPPED agent, and says it takes effect at the ` +
        `next activate`,
      `success ${stopped.success}, outcome ${stopped.outcomes?.[knob]}`
    );
  }
}

// ===========================================================================
rule('5. THE DOCUMENTED REMEDY ACTUALLY WORKS');
// ===========================================================================
//
// The refusal is only honest if the sentence it hands back is a road that
// leads somewhere. deactivate -> configure -> activate, and the new value in
// effect at the end — with section 1's conversation still on disk, because the
// CALLER chose the respawn and CrabCast destroyed nothing.

{
  const conversationBefore = conversationDigest(theAgent);
  check(conversationBefore !== '(no conversation)',
    '(setup) section 1\'s conversation is still readable, so "still on disk" below is a ' +
      'comparison rather than two absences agreeing',
    conversationBefore);
  const NEW_PROMPT = 'KAN-126: this is the prompt the caller chose to respawn for.';
  resetArgvLog();
  check(panesIn(theAgent).length === 1,
    '(setup) the agent sections 1 to 3 left running is still running',
    `panes ${panesIn(theAgent).length}`);

  const down = await h1.invoke({ action: 'deactivate_agent', path: theAgent });
  check(down.success === true && down.wasRunning === true && down.state === 'standby',
    'step 1 — deactivate: it was running, and it is now standby',
    JSON.stringify({ wasRunning: down.wasRunning, state: down.state }));

  const re = await h1.invoke({
    action: 'configure_agent', path: theAgent, ...BASE, priority: 11, label: 'renamed',
    prompt: NEW_PROMPT
  });
  check(re.success === true && re.outcomes?.prompt === 'applied' && re.appliedInPlace === false,
    'step 2 — the SAME change that was refused is now accepted, and says it takes effect at ' +
      'the next activate rather than claiming it is already live',
    JSON.stringify({ success: re.success, outcome: re.outcomes?.prompt, appliedInPlace: re.appliedInPlace }));

  const up = await h1.invoke({ action: 'activate_agent', path: theAgent, ...PAST_THE_GATE });
  check(up.success === true && up.started === true,
    'step 3 — activate starts it again', JSON.stringify({ success: up.success, started: up.started }));

  const newPane = paneIdIn(theAgent);
  check(newPane !== null && !paneIdsSeen.has(newPane),
    'and it is a NEW pane — which is exactly what a respawn looks like from outside, and ' +
      'exactly what did NOT happen in sections 1 to 3',
    `new pane ${newPane}, previously seen ${JSON.stringify([...paneIdsSeen])}`);
  check(sidecarPrompt(theAgent) === NEW_PROMPT,
    'the NEW prompt is what was written for it', JSON.stringify(sidecarPrompt(theAgent)?.slice(0, 40)));

  const status = await h1.invoke({ action: 'agent_status', path: theAgent });
  check(status.config?.prompt === NEW_PROMPT && status.config?.priority === 11 &&
    status.state === 'running',
    'the state read echoes the new value, in effect, on a running agent',
    `priority ${status.config?.priority}, state ${status.state}`);
  check(conversationDigest(theAgent) === conversationBefore,
    'AND SECTION 1\'S CONVERSATION IS STILL ON DISK — the caller spent the respawn ' +
      'deliberately, and CrabCast destroyed nothing on its own account',
    `${conversationBefore} -> ${conversationDigest(theAgent)}`);
  check(closesIssued() === 1 && startsIssued() === 1,
    'exactly one close and one start across the whole remedy — the caller asked for both',
    `closes ${closesIssued()}, starts ${startsIssued()}`);
}

// ===========================================================================
rule('6. SILENCE IS NOT EVIDENCE — an unreachable herdr over an active record');
// ===========================================================================
//
// `listHerdrAgentsChecked` returns an EMPTY census when herdr does not answer.
// A running-check built the obvious way reads its own failure as an all-clear
// — and then rewrites the prompt of an agent that is very much alive,
// precisely when it cannot see it. `activate` refuses that case as
// unverifiable and `forget` refuses it one verb over; so does this.
//
// AND IT GATES ONLY THE RESTART-ONLY KNOBS. A priority whose new value is
// correct whether the agent is up or down must not be held hostage to a census.

{
  const dir = ownedDir('s6', 'blind');
  const h = harness('s6');
  setCensus([]);
  await h.invoke({ action: 'configure_agent', path: dir, ...BASE });
  await h.invoke({ action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  const versionBefore = h.agentRegistry.intents().get(dir).configVersion;

  // The daemon's own session map is the other source of liveness, and a
  // restarted daemon has an empty one. Cleared so this section tests the case
  // it says it tests rather than passing through the session.
  h.bridge.getSessionByPath = () => undefined;
  setCensus('DOWN');
  resetArgvLog();

  const blind = await h.invoke({
    action: 'configure_agent', path: dir, ...BASE, prompt: 'rewritten while nobody was looking'
  });
  show('a restart-only change with herdr unreachable:', {
    success: blind.success, refused: blind.refused, attributes: blind.attributes,
    applied: blind.applied, configVersion: blind.configVersion
  });
  check(blind.success === false && blind.refused === 'unverifiable',
    'REFUSED AS UNVERIFIABLE — not applied on the strength of a census that could not answer',
    `${blind.success} / ${blind.refused}`);
  check(/silence, not evidence/.test(blind.error ?? ''),
    'and it says why in the words this daemon uses for the same mistake elsewhere');
  check(h.agentRegistry.intents().get(dir).record.config.prompt === BASE.prompt &&
    h.agentRegistry.intents().get(dir).configVersion === versionBefore,
    'nothing was written and the token did not move');

  const inPlace = await h.invoke({ action: 'configure_agent', path: dir, ...BASE, priority: 6 });
  check(inPlace.success === true && h.agentRegistry.intents().get(dir).record.config.priority === 6,
    'but the IN-PLACE knobs still change: their new value is correct whether the agent is up ' +
      'or down, so refusing them for want of a census would cost a caller a decision to buy ' +
      'nothing',
    `success ${inPlace.success}`);
  setCensus([]);
}

// ===========================================================================
rule('7. THE TOKEN — configVersion moves on acceptance and NEVER on a refusal');
// ===========================================================================

{
  const dir = ownedDir('s7', 'token');
  const h = harness('s7');
  setCensus([]);
  const v1 = await h.invoke({ action: 'configure_agent', path: dir, ...BASE });
  await h.invoke({ action: 'activate_agent', path: dir, ...PAST_THE_GATE });
  const v2 = await h.invoke({ action: 'configure_agent', path: dir, ...BASE, priority: 5 });
  const no = await h.invoke({ action: 'configure_agent', path: dir, ...BASE, priority: 5, launcher: 'claude' });
  const v3 = await h.invoke({ action: 'configure_agent', path: dir, ...BASE, priority: 6 });

  // THE THREE FIELDS ARE ON EVERY SUCCESS, INCLUDING THE FIRST ONE.
  //
  // This daemon's rule, stated for `activate` at mcp.ts and applied here: a
  // field that appears only sometimes asks the caller to read meaning into an
  // absence. Our consumer has no second source to fall back on, so a missing
  // field is exactly what this slice is trying to stop them inferring from —
  // and gating these on "is there a previous record" would make a first
  // configure and a reconfigure-that-changed-nothing look identical from
  // outside. Both silent, different worlds.
  for (const [when, res] of [['a FIRST configure', v1], ['a RECONFIGURE', v2]]) {
    check(
      Array.isArray(res.applied) && Array.isArray(res.withheld) &&
        res.outcomes && typeof res.outcomes === 'object' &&
        Object.keys(res.outcomes).sort().join() === Object.keys(RECONFIGURATION_COST).sort().join(),
      `${when} carries applied, withheld and a COMPLETE outcomes map — presence is never the ` +
        `signal`,
      `applied ${JSON.stringify(res.applied)}, withheld ${JSON.stringify(res.withheld)}, ` +
        `outcomes ${Object.keys(res.outcomes ?? {}).length} keys`
    );
  }
  check(
    v1.applied?.length === Object.keys(RECONFIGURATION_COST).length && v1.withheld?.length === 0 &&
      Object.values(v1.outcomes ?? {}).every((o) => o === 'applied'),
    'and on the FIRST configure every knob reads `applied` — there was no record, so this call ' +
      'wrote all of it, including the optional knobs the caller left out: the record now ' +
      'carries "no prompt", and this is the call that put it there',
    `${v1.applied?.length} applied, ${v1.withheld?.length} withheld`
  );

  check(v1.configVersion === 1 && v2.configVersion === 2 && v3.configVersion === 3,
    'each accepted configure moves it by one',
    `${v1.configVersion}, ${v2.configVersion}, ${v3.configVersion}`);
  check(no.configVersion === 2,
    'and the refusal reports the version STILL IN FORCE — a token that moved on a refusal ' +
      'would tell a compare-and-set caller its write landed when nothing was applied',
    `refusal said v${no.configVersion}, record held v2`);
  check(no.config?.priority === 5 && no.config?.launcher === BASE.launcher,
    'along with the configuration still in force, rather than the one that was refused',
    JSON.stringify({ priority: no.config?.priority, launcher: no.config?.launcher }));

  // AND AN IDENTICAL RESTATEMENT IS NOT A REFUSAL. A reconciler sends the whole
  // desired-state document every pass; if the document already IS the
  // configuration there is no change for a respawn to make take effect, and
  // refusing it would deadlock the caller against a difference that is not one.
  const same = await h.invoke({ action: 'configure_agent', path: dir, ...BASE, priority: 6 });
  check(same.success === true && same.changed?.length === 0,
    'restating the SAME document against a running agent is accepted with `changed: []` — ' +
      'there is nothing to refuse, and a reconciler must not deadlock on a no-op',
    `changed ${JSON.stringify(same.changed)}`);

  // AND THE TWO SHAPES THAT MEAN THE SAME THING. An agent configured with no
  // `mcpServers` at all, sent `{}` by a reconciler that always fills the field
  // in: neither writes a file, so there is no change for a respawn to make
  // take effect. Refusing it would deadlock that caller against a difference
  // with no consequence, and no number of deactivate/activate cycles would
  // clear it — the one failure mode a conservative refusal really can cause.
  const noMcp = ownedDir('s7', 'no-mcp');
  const { mcpServers: _dropped, ...WITHOUT_MCP } = BASE;
  await h.invoke({ action: 'configure_agent', path: noMcp, ...WITHOUT_MCP });
  await h.invoke({ action: 'activate_agent', path: noMcp, ...PAST_THE_GATE });
  const empty = await h.invoke({
    action: 'configure_agent', path: noMcp, ...WITHOUT_MCP, mcpServers: {}
  });
  check(empty.success === true && empty.outcomes?.mcpServers === 'unchanged',
    'an ABSENT `mcpServers` and an EMPTY one are the same thing on a running agent — a ' +
      'reconciler that always sends `{}` is not refused forever over a difference that writes ' +
      'no file either way',
    `success ${empty.success}, outcome ${empty.outcomes?.mcpServers}`);
  const real = await h.invoke({
    action: 'configure_agent', path: noMcp, ...WITHOUT_MCP, mcpServers: { crabcast: 'builtin' }
  });
  check(real.success === false && real.attributes?.join() === 'mcpServers',
    'while asking for a server it does NOT have is still refused — the normalization is about ' +
      'two spellings of nothing, not about widening the rule',
    `success ${real.success}, attributes ${JSON.stringify(real.attributes)}`);
}

// ===========================================================================
rule('8. THE PANE NEVER MOVED — the assertion that proves the requirement');
// ===========================================================================
//
// "A changed paneId is precisely what a silent destroy-and-recreate looks like
// from outside." Sections 1 to 3 performed an accepted in-place change, a
// refused restart-only change, a refused mixed change and a second accepted
// in-place change against ONE running agent. If any of them had quietly
// respawned it, this set would hold more than one id.

{
  // Section 5's remedy deliberately produced a second pane, and it is excluded
  // by construction rather than by hand: the set below is only ever added to
  // by `watchPane`, which sections 1 to 3 call and section 5 does not.
  check(paneIdsSeen.size === 1,
    'across every reconfiguration of sections 1 to 3 — accepted and refused — the agent was ' +
      'in exactly ONE pane',
    `pane ids seen: ${JSON.stringify([...paneIdsSeen])}`);
}

// ===========================================================================
rule('9. THE CHECKS CAN FAIL — the compiled daemon is mutated and they go red');
// ===========================================================================
//
// A check that cannot fail is not a check. Each mutation below is applied to a
// COPY of the compiled daemon, and the assertion is that the property this
// script asserts green goes red against it.

// The mutants live outside the package, so Node would not find `node-pty`
// walking up from them. One symlink at the scratch root puts the real
// dependencies on their resolution path without copying them.
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

function mutantDist(name, file, from, to) {
  const dir = path.join(tmp, `mutant-${name}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const target = path.join(dir, file);
  const before = fs.readFileSync(target, 'utf8');
  const occurrences = before.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${name}' expected exactly one occurrence of ${JSON.stringify(from)} in ` +
        `${file}, found ${occurrences}. The mutation target moved; fix this script rather ` +
        `than deleting the section — an un-mutatable check is an unproven one.`
    );
  }
  fs.writeFileSync(target, before.replace(from, to));
  return dir;
}

async function mutantHarness(dir, name) {
  const { MessageRouter: Broken } = await import(path.join(dir, 'router.js'));
  const { AgentRegistry: BrokenReg } = await import(path.join(dir, 'agent-registry.js'));
  return harness(name, Broken, BrokenReg);
}

/**
 * THE LIVENESS CONTROL, and this section does not work without it.
 *
 * Mutations A, C and D all claim "…under a RUNNING agent". Each of them would
 * ALSO pass against an unmutated daemon if the agent were not running:
 * configuring a stopped agent's prompt legitimately succeeds, and
 * `!expected().some(…)` is trivially true for an agent that never started. So
 * a setup that silently failed to spawn would turn each of these into a green
 * assertion about nothing — which is precisely the failure the whole section
 * exists to rule out, reappearing inside it. (B is self-guarding: its claim is
 * a refusal, which a stopped agent cannot produce.)
 *
 * So the precondition is asserted rather than assumed, from the census rather
 * than from the activate response.
 */
function liveControl(mutation, dir, res) {
  return check(
    res?.success === true && res?.started === true && panesIn(dir).length === 1,
    `${mutation} — CONTROL: the agent really is running before the mutation is exercised, ` +
      `so the claim below is about a live agent rather than a vacuous one`,
    `activate success ${res?.success}, started ${res?.started}, panes ${panesIn(dir).length}`
  );
}

{
  // MUTATION A: `prompt` is reclassified as in-place — the exact shape of the
  // bug this task exists to prevent, and the one a future knob would take by
  // accident if the table were not total.
  const dir = mutantDist(
    'prompt-in-place', 'router.js', "prompt: 'restart-required'", "prompt: 'in-place'"
  );
  const b = await mutantHarness(dir, 'm-a');
  const p = ownedDir('s9', 'a');
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: p, ...BASE });
  liveControl('MUTATION A', p, await b.invoke({ action: 'activate_agent', path: p, ...PAST_THE_GATE }));
  const res = await b.invoke({ action: 'configure_agent', path: p, ...BASE, prompt: 'rewritten' });
  check(res.success === true && b.agentRegistry.intents().get(p).record.config.prompt === 'rewritten',
    'MUTATION A — reclassifying `prompt` as in-place lets it be rewritten under a live agent, ' +
      'and section 2 is what goes red',
    `success ${res.success}`);
}

{
  // MUTATION B: atomicity removed — the in-place half of a refused call is
  // applied anyway. This is "applies half and reports a bare success", and it
  // is why section 3 reads the RECORD rather than the response.
  const dir = mutantDist(
    'not-atomic', 'router.js',
    'const inPlace = changed.filter((n) => RECONFIGURATION_COST[n] === \'in-place\');',
    'const inPlace = changed.filter((n) => RECONFIGURATION_COST[n] === \'in-place\');\n' +
      '        if (existing && inPlace.length) { this.deps.agentRegistry.recordConfigured({ ' +
      'path: agentPath, config: parsed.config, configVersion: existing.configVersion + 1, ' +
      'configuredAt: new Date().toISOString() }); }'
  );
  const b = await mutantHarness(dir, 'm-b');
  const p = ownedDir('s9', 'b');
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: p, ...BASE });
  await b.invoke({ action: 'activate_agent', path: p, ...PAST_THE_GATE });
  const res = await b.invoke({
    action: 'configure_agent', path: p, ...BASE, priority: 99, prompt: 'rewritten'
  });
  const landed = b.agentRegistry.intents().get(p).record.config.priority;
  check(res.success === false && landed === 99,
    'MUTATION B — a refusal that applies the in-place half anyway leaves the record at ' +
      'priority 99 behind a `success: false`, and section 3\'s record assertion is what ' +
      'catches it (the response alone would not have)',
    `refused ${res.success === false}, record priority ${landed}`);
}

{
  // MUTATION C: the running agent's row is written as `configured` rather than
  // carried as `activated` — the silent fleet loss. Nothing in the response
  // changes; the agent simply stops being restored.
  const dir = mutantDist(
    'loses-expected', 'router.js',
    "existing?.event === 'activated'\n            ? this.deps.agentRegistry.recordActivated(record, existing.at)\n            : this.deps.agentRegistry.recordConfigured(record)",
    'this.deps.agentRegistry.recordConfigured(record)'
  );
  const b = await mutantHarness(dir, 'm-c');
  const p = ownedDir('s9', 'c');
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: p, ...BASE });
  const up = await b.invoke({ action: 'activate_agent', path: p, ...PAST_THE_GATE });
  liveControl('MUTATION C', p, up);
  // AND THE RECORD SAYS SO, which is the half `liveControl` cannot see. The
  // claim is that a `configured` row DROPS this agent out of expected(); if it
  // were never in expected() the assertion would hold for the wrong reason.
  check(b.agentRegistry.expected().some((r) => r.path === p),
    'MUTATION C — CONTROL: and the mutant has it in expected() BEFORE the reconfigure, so the ' +
      'drop below is caused by this call rather than by it never having been there',
    JSON.stringify(b.agentRegistry.expected().map((r) => r.path)));
  const res = await b.invoke({ action: 'configure_agent', path: p, ...BASE, priority: 5 });
  check(res.success === true && !b.agentRegistry.expected().some((r) => r.path === p),
    'MUTATION C — writing a `configured` row over a RUNNING agent drops it out of expected() ' +
      'behind a `success: true`, so a daemon restart would not bring it back. Section 1\'s ' +
      'expected() assertion is the only thing anywhere that would notice',
    `expected: ${JSON.stringify(b.agentRegistry.expected().map((r) => r.path))}`);
}

{
  // MUTATION D: the unverifiable case reads its own blindness as an all-clear.
  const dir = mutantDist(
    'blind-is-clear', 'router.js',
    "if (!running && !occupancy.reachable && existing?.event === 'activated') {",
    'if (false) {'
  );
  const b = await mutantHarness(dir, 'm-d');
  const p = ownedDir('s9', 'd');
  setCensus([]);
  await b.invoke({ action: 'configure_agent', path: p, ...BASE });
  liveControl('MUTATION D', p, await b.invoke({ action: 'activate_agent', path: p, ...PAST_THE_GATE }));
  // The record has to say `activated` too: the branch this mutation removes is
  // gated on it, so an agent whose record said otherwise would take the
  // unmutated path and pass this section for the wrong reason.
  check(b.agentRegistry.intents().get(p)?.event === 'activated',
    'MUTATION D — CONTROL: and the record says `activated`, which is what the removed branch ' +
      'is gated on',
    b.agentRegistry.intents().get(p)?.event);
  b.bridge.getSessionByPath = () => undefined;
  setCensus('DOWN');
  const res = await b.invoke({ action: 'configure_agent', path: p, ...BASE, prompt: 'rewritten' });
  check(res.success === true && b.agentRegistry.intents().get(p).record.config.prompt === 'rewritten',
    'MUTATION D — dropping the unverifiable branch rewrites the prompt of an agent nobody ' +
      'could see, behind a `success: true`. Section 6 is what goes red',
    `success ${res.success}`);
  setCensus([]);
}

// ===========================================================================
rule('10. THE SURFACES — the real CLI and the real MCP server, on a real daemon');
// ===========================================================================
//
// Sections 1 to 9 drive the router in-process. This one starts an actual
// daemon and reaches it the two ways a caller does, because a rule that holds
// in the router and is lost in a surface is a rule the caller does not have.

delete process.env.CRABCAST_MAX_AGENTS;

const liveDir = path.join(tmp, 'live');
const liveHome = path.join(liveDir, 'home');
const liveData = path.join(liveDir, 'data');
const liveState = path.join(liveDir, 'state');
for (const d of [liveHome, liveData, liveState]) fs.mkdirSync(d, { recursive: true });
const liveConfigPath = path.join(liveDir, 'crabcast.config.json');
fs.writeFileSync(liveConfigPath, JSON.stringify({ dataDir: liveData }, null, 2));

const liveBin = path.join(liveDir, 'bin');
fs.mkdirSync(liveBin, { recursive: true });
const shimImpl = path.join(liveBin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.CRABCAST_VERIFY_SHIM_STATE;
const args = process.argv.slice(2);
const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const [a, b] = args;
if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (a === 'agent' && b === 'get') {
  const f = load().find((s) => s.name === args[2]);
  if (f) out({ result: { agent: { name: f.name, pane_id: f.pane_id, cwd: f.cwd, agent: 'claude', agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({ name: args[2], pane_id: '%' + (100 + started.length), cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1] });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, pane_id: s.pane_id, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(liveBin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(liveBin, 'herdr'), 0o755);

const liveEnv = {
  ...process.env,
  HOME: liveHome,
  SHELL: '/bin/bash',
  PATH: `${liveBin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_VERIFY_SHIM_STATE: liveState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

const livePath = (() => {
  const d = path.join(liveDir, 'owned', 'surfaced');
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync(d);
})();

const cliJs = path.join(distDir, 'cli.js');
const crabcast = (args) =>
  spawnSync(process.execPath, [cliJs, '--config', liveConfigPath, ...args], {
    env: liveEnv, encoding: 'utf8', timeout: 120_000
  });

async function raw(action, payload = {}) {
  const socket = await connectToDaemon(liveData, { spawnIfMissing: false });
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const id = `kan126-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no reply to ${action}`)); }, 20_000);
    onJsonLines(socket, (msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.end();
      resolve(msg);
    });
    writeJsonLine(socket, { action, id, ...payload });
  });
}
const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * THE PANES THE LIVE SHIM ACTUALLY STARTED, from the file it writes itself.
 *
 * Sections 1 to 9 assert "the agent never moved" from the census — a source
 * independent of the response. This section had been comparing one
 * `agent_status` response against another, which is the daemon agreeing with
 * itself and the one place this file departed from its own stated method. The
 * shim already records every spawn; this reads it.
 *
 * It throws rather than answering `[]` for the same reason `herdrCalls` does:
 * a count taken from a file we could not read is not a measurement.
 */
function livePanesStarted() {
  const file = path.join(liveState, 'started.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`could not read the live shim's spawn record at ${file}: ${e?.message ?? e}`);
  }
}

{
  const argv = [
    'configure', livePath,
    '--priority', String(BASE.priority),
    '--launcher', BASE.launcher,
    '--prompt', BASE.prompt,
    '--label', BASE.label
  ];
  const configured = crabcast(argv);
  console.log(`\n   $ crabcast ${argv.join(' ')}`);
  console.log(configured.stdout.replace(/^/gm, '     '));
  check(configured.status === 0, '(setup) the CLI configured the agent',
    configured.status === 0 ? undefined : configured.stderr?.slice(0, 400));

  const status0 = await raw('daemon_status');
  daemonPids.add(status0.pid);
  await waitFor(() => fs.existsSync(socketPathFor(liveData)), 20_000, 'the daemon socket');

  const activated = crabcast(['activate', livePath, '--override']);
  check(activated.status === 0, '(setup) and activated it against a real daemon',
    activated.status === 0 ? undefined : activated.stderr?.slice(0, 400));
  const paneBefore = (await raw('agent_status', { path: livePath })).paneId;
  // FROM THE SHIM, NOT FROM THE RESPONSE. This is the evidence the final
  // assertion in this section compares against.
  const spawnsBefore = livePanesStarted();
  check(spawnsBefore.length === 1 && spawnsBefore[0].cwd === livePath,
    '(setup) the live shim recorded exactly ONE spawn into that directory, which is the ' +
      'independent record the surfaces below are measured against',
    JSON.stringify(spawnsBefore));

  // --- surface 1: the CLI, in place ---------------------------------------
  const cliInPlace = crabcast([
    'configure', livePath, '--priority', '8', '--launcher', BASE.launcher,
    '--prompt', BASE.prompt, '--label', BASE.label
  ]);
  console.log(`\n   $ crabcast configure ${livePath} --priority 8 …`);
  console.log(cliInPlace.stdout.replace(/^/gm, '     '));
  check(
    cliInPlace.status === 0 &&
      /^ +changed: +priority — IN PLACE, on the running agent$/m.test(cliInPlace.stdout) &&
      /^ +priority +APPLIED IN PLACE — live now, nothing was respawned$/m.test(cliInPlace.stdout),
    'SURFACE 1/4 — `crabcast configure` renders the in-place change per knob, naming it as ' +
      'in place rather than as an undifferentiated success',
    `exit ${cliInPlace.status}`
  );

  // --- surface 2: the CLI, refused ----------------------------------------
  const cliRefused = crabcast([
    'configure', livePath, '--priority', '12', '--launcher', BASE.launcher,
    '--prompt', 'a different prompt', '--label', BASE.label
  ]);
  console.log(`\n   $ crabcast configure ${livePath} --priority 12 --prompt 'a different prompt'`);
  console.log(cliRefused.stdout.replace(/^/gm, '     '));
  if (cliRefused.stderr) console.log(cliRefused.stderr.replace(/^/gm, '     '));
  const cliMisses = [
    ['the refusal is named', /^ +refused: +restart-required$/m],
    ['the attribute is named', /^ +attributes: +prompt$/m],
    ['the withheld knob is named separately', /^ +withheld: +priority$/m],
    ['nothing was applied', /^ +applied: +nothing — configure is all-or-nothing$/m],
    ['the version is unchanged', /^ +version: +\d+ — unchanged, because nothing was applied$/m],
    ['the per-knob block distinguishes refused from withheld',
      /^ +prompt +REFUSED — cannot change under a running agent$/m],
    ['and names the withheld one as such',
      /^ +priority +withheld — would have applied in place; nothing was, this call is atomic$/m],
    ['the remedy is printed', /^remedy: deactivate\(.+\); configure\(.+\); activate\(.+\)$/m]
  ].filter(([, re]) => !re.test(cliRefused.stdout));
  check(cliRefused.status === 1 && cliMisses.length === 0,
    'SURFACE 2/4 — `crabcast configure` renders the refusal: the attribute, the reason, the ' +
      'withheld knobs, the unchanged version and the remedy — and exits 1, "the daemon said no"',
    cliMisses.length ? `missing: ${cliMisses.map(([n]) => n).join(', ')}` : `exit ${cliRefused.status}`);

  // --- surface 3: MCP -----------------------------------------------------
  //
  // A LONG-LIVED CHILD, RESOLVING PER REQUEST — the shape verify-mcp-tools
  // already uses, and the reason is a defect this script had until round 2.
  //
  // It used to drive the server with `spawnSync` and an `input` string. An MCP
  // server on stdio does not exit when its stdin closes: it waits, as it is
  // supposed to. So every call sat until spawnSync's 120-SECOND TIMEOUT, was
  // killed with SIGTERM, and had its stdout parsed out of the corpse — which
  // parsed fine, because the reply had arrived in the first few milliseconds.
  // Green assertions, correct values, and two minutes of dead wall-clock each,
  // hidden because nothing looked at the exit status. Checking the status is
  // what surfaced it; resolving on the reply is what fixes it.
  const mcpJs = path.join(distDir, 'mcp.js');
  const mcp = spawn(process.execPath, [mcpJs], {
    env: { ...liveEnv, CRABCAST_CONFIG: liveConfigPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let mcpStderr = '';
  let mcpExit = null;
  mcp.stderr.on('data', (d) => { mcpStderr += d.toString(); });
  mcp.on('exit', (code, signal) => { mcpExit = { code, signal }; });
  const mcpPending = new Map();
  let mcpBuffer = '';
  mcp.stdout.on('data', (chunk) => {
    mcpBuffer += chunk.toString();
    let idx;
    while ((idx = mcpBuffer.indexOf('\n')) !== -1) {
      const line = mcpBuffer.slice(0, idx);
      mcpBuffer = mcpBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiting = msg.id !== undefined && mcpPending.get(msg.id);
      if (waiting) {
        mcpPending.delete(msg.id);
        clearTimeout(waiting.timer);
        msg.error ? waiting.reject(new Error(JSON.stringify(msg.error))) : waiting.resolve(msg.result);
      }
    }
  });
  let mcpId = 0;
  const mcpRequest = (method, params = {}) => {
    // The server dying is checked on every request rather than only at the end:
    // a reply read out of a process that has already exited is a surface
    // assertion about a surface that fell over.
    if (mcpExit) {
      throw new Error(
        `the MCP server exited (${JSON.stringify(mcpExit)}) before ${method}: ` +
          mcpStderr.slice(0, 400)
      );
    }
    const id = ++mcpId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mcpPending.delete(id);
        reject(new Error(`timed out waiting for ${method}: ${mcpStderr.slice(0, 400)}`));
      }, 30_000);
      mcpPending.set(id, { resolve, reject, timer });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'kan126', version: '0' }
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const mcpCall = (name, args) => mcpRequest('tools/call', { name, arguments: args });

  const mcpRefused = await mcpCall('crabcast_configure_agent', {
    path: livePath, priority: 12, launcher: BASE.launcher,
    prompt: 'a different prompt again', label: BASE.label
  });
  const mcpBody = JSON.parse(mcpRefused.content[0].text);
  show('MCP crabcast_configure_agent, refused:', {
    success: mcpBody.success, refused: mcpBody.refused, attributes: mcpBody.attributes,
    withheld: mcpBody.withheld, applied: mcpBody.applied, outcomes: mcpBody.outcomes,
    configVersion: mcpBody.configVersion, remedy: mcpBody.remedy, isError: mcpRefused.isError
  });
  check(
    mcpRefused.isError === true && mcpBody.success === false &&
      mcpBody.refused === 'restart-required' && mcpBody.attributes?.join() === 'prompt' &&
      mcpBody.outcomes?.priority === 'withheld' &&
      mcpBody.outcomes?.prompt === 'refused-restart-required' &&
      typeof mcpBody.remedy === 'string',
    'SURFACE 3/4 — MCP carries the same refusal WITH `isError: true`, so a tool caller cannot ' +
      'read it as ordinary text and believe the change landed',
    `isError ${mcpRefused.isError}, refused ${mcpBody.refused}`);

  const mcpInPlace = await mcpCall('crabcast_configure_agent', {
    path: livePath, priority: 3, launcher: BASE.launcher, prompt: BASE.prompt, label: BASE.label
  });
  const mcpOk = JSON.parse(mcpInPlace.content[0].text);
  check(
    mcpInPlace.isError === false && mcpOk.success === true &&
      mcpOk.outcomes?.priority === 'applied-in-place' && mcpOk.appliedInPlace === true,
    'SURFACE 4/4 — and the in-place change through MCP, reported per knob',
    JSON.stringify({ isError: mcpInPlace.isError, outcome: mcpOk.outcomes?.priority }));

  // AND THE AGENT NEVER MOVED, across every surface.
  check(mcpExit === null,
    'the MCP server stayed up across both calls rather than being read out of a corpse',
    JSON.stringify(mcpExit));
  mcp.kill();

  const finalStatus = await raw('agent_status', { path: livePath });
  const spawnsAfter = livePanesStarted();
  check(
    spawnsAfter.length === 1 &&
      spawnsAfter[0].pane_id === spawnsBefore[0].pane_id &&
      finalStatus.paneId === paneBefore && finalStatus.state === 'running',
    'across the CLI and MCP, accepted and refused, the agent stayed in ONE pane and kept ' +
      'running — counted from the SHIM\'S OWN spawn record rather than from a second ' +
      'agent_status, so this is not the daemon agreeing with itself',
    `shim spawns ${spawnsBefore.length} -> ${spawnsAfter.length} ` +
      `(${JSON.stringify(spawnsAfter.map((x) => x.pane_id))}), ` +
      `status ${paneBefore} -> ${finalStatus.paneId}, state ${finalStatus.state}`);
  check(finalStatus.config?.prompt === BASE.prompt,
    'and its prompt is still the one it was started with — no surface let a refused change ' +
      'through',
    JSON.stringify(finalStatus.config?.prompt?.slice(0, 40)));
}

// ===========================================================================
console.log(
  failures.length
    ? `\n${failures.length} CHECK(S) FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
