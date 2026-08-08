#!/usr/bin/env node
// Live proof for KAN-178: the WRITE into the antigravity CLI's GLOBAL MCP
// config keeps the two disciplines the per-directory `.mcp.json` already had —
// a failed write refuses the activation, and a server key that is already the
// USER'S is refused rather than taken over.
//
// WHAT FAILURE THIS WOULD CATCH: the user losing their own `mcpServers` entry
// from `~/.gemini/antigravity-cli/mcp.json` entirely, through a sequence in
// which every individual step looks correct. CrabCast overwrites their key
// because the merge never asked whose it was; it records the key as its own
// because it did write those bytes; and a later `crabcast forget` removes it
// because its record says it is ours and the bytes on disk match. Three
// defensible steps composing into deletion of somebody else's data, in a file
// CrabCast does not own. §1 runs that whole sequence and requires their entry
// to survive it; §7a runs the SAME sequence against a build with the refusal
// backed out and watches the entry be destroyed, which is the only reason to
// believe §1 is measuring anything.
//
// It also catches the quieter half: an agy agent started when its MCP servers
// could not be written at all, so its runtime comes up with none of the tools
// it was configured with and the caller is told `success: true`.
//
// WHY THE SECOND HALF WAS NOT SIMPLY COPIED FROM `provisionMcpConfig`. That
// function answers "does CrabCast have a record of writing this key" from ONE
// agent's sidecar, which is exactly right for a per-directory file: one
// directory, one agent. The agy config is GLOBAL and shared by every agy agent
// this daemon runs, so the same reading would refuse the SECOND agent over the
// FIRST agent's key — an activation blocked by state the agent does not own.
// The rule is "CrabCast has no record", not "I have no record", so the evidence
// is the whole fleet's records. §4 is that distinction, proven: a sibling's key
// merges, and only a key predating every CrabCast record refuses.
//
// THE SECTIONS:
//
//   1. THE DATA-LOSS SEQUENCE, END TO END: a user's own key is in the global
//      config BEFORE CrabCast sees it; activate; `forget`; their entry — their
//      exact bytes — is still there
//   2. the refusal says WHICH key, WHOSE it is, and WHAT TO DO about it
//   3. positive control: a key CRABCAST wrote does not refuse (re-activation)
//   4. positive control: a SIBLING's key does not refuse (the shared-file case)
//   5. ownership that cannot be ESTABLISHED refuses, and names what it could
//      not read
//   6. a write that FAILS refuses the activation
//   7. every refusal above can actually fail (mutation, via scripts/mutation.mjs)
//
// §3 AND §4 ARE NOT DECORATION. A check that refuses everything passes every
// refusal assertion in this file. Those two are what make §1, §2, §5 and §6
// evidence of a guard rather than evidence of a wall.
//
// HOW REAL IT IS, AND WHERE IT SUPPLIES ITS OWN INPUT — said plainly, because
// "a proof that supplies its own input has not tested that the input arrives"
// is the defect this epic keeps re-finding. Everything on the daemon side is
// real: the real MessageRouter, the real HerdrBridge including `initPty`, the
// real launcher table, the real provisioning, a real config through the real
// loader, a real on-disk registry. Agents are configured and activated through
// the ordinary verbs, so every provenance record asserted on here is a record
// THE DAEMON PRODUCED — no section hands itself a provenance file and then
// measures it. Only the external `herdr` binary is replaced, by a shim on PATH
// answering in herdr's own JSON shapes, and $HOME is scratched per section so
// the `~/.gemini/…` config written here is this script's own.
//
// What IS a fixture, in each case necessarily:
//
//   - THE USER'S PRE-EXISTING KEY (§1, §2, §7a). It has to be written by this
//     script, because "an entry that was the user's before CrabCast arrived" is
//     by definition not something CrabCast can produce. Everything downstream
//     of it — the collision, the refusal, the record, the removal — is the
//     daemon's own behaviour.
//   - THE CORRUPTED SIBLING RECORD (§5). The corruption is the fixture; the
//     record it corrupts is a real one the daemon wrote.
//   - THE UNWRITABLE PATH (§6). A regular file at `$HOME/.gemini`, so the
//     `mkdir` fails deterministically rather than depending on the uid the
//     suite happens to run as.
//
// WHAT THIS FILE DOES NOT COVER, and who does:
//
//   - THE REVERSAL. That a `forget` removes our key only when no sibling still
//     claims it is `verify-agy-mcp-reversal`, and this file does not re-prove
//     it. §1 uses `forget` as the last step of the data-loss sequence, not as
//     its subject.
//   - THE DISCLOSURE HALF. That a write which did not happen is neither
//     disclosed nor recorded is that same file's §7. KAN-178 changed that
//     section's first assertion — the activation is now REFUSED rather than
//     silently succeeding — and the section is still where that property lives.
//   - A REAL `agy` BINARY. No proof in this repository runs one. That the
//     antigravity CLI reads this file, at this path, in this shape is an
//     assumption carried from the launcher's original author and is tested
//     nowhere. The shared-ownership hazard has an owner for its bookkeeping
//     (this file and its sibling) and none at all for its runtime behaviour.
//
// Usage:
//   npm run build
//   node scripts/verify-agy-mcp-write-refusals.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const section = (title) => console.log(`\n${title}\n${'='.repeat(title.length)}`);
const block = (value) =>
  JSON.stringify(value ?? null, null, 2).split('\n').map((l) => `      ${l}`).join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan178-agy-'));
const realPath = process.env.PATH;
const realHome = process.env.HOME;

// ---------------------------------------------------------------------------
// The herdr shim. Same shape as `verify-agy-mcp-reversal`'s: it records every
// argv and makes an activation VERIFY, because a refusal has to be told apart
// from an activation that failed for some unrelated reason. It reports `agy` as
// the runtime, these being anti-gravity agents.
const shimState = path.join(tmp, 'shim');
const shimDir = path.join(tmp, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN178_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN178_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.paneId, agent: 'agy', agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: 'no such agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  const seqFile = path.join(state, 'seq');
  const seq = (fs.existsSync(seqFile) ? Number(fs.readFileSync(seqFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(seqFile, String(seq));
  started.push({
    name: args[2],
    paneId: 'p-' + seq,
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: 'p-' + seq } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({
    name: s.name, pane_id: s.paneId, agent: 'agy', cwd: s.cwd, agent_status: 'working'
  })) } });
}
if (a === 'pane' && b === 'close') {
  const index = started.findIndex((s) => s.paneId === args[2]);
  if (index === -1) {
    process.stderr.write(JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } }));
    process.exit(1);
  }
  started.splice(index, 1);
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: {} });
}
if (a === 'agent' && b === 'read') out({ result: { read: { text: 'ready\\n> ', truncated: false } } });
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'tab' && b === 'create') out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
else if (a === 'pane' && b === 'list') out({ result: { panes: [] } });
else out({ result: {} });
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${realPath}`;

/**
 * Load one build of the daemon.
 *
 * PARAMETERISED BY BUILD, which is what lets §7 run the data-loss sequence
 * END TO END against a mutant rather than poking at one function of it. The
 * defect this file is about is a SEQUENCE — write, record, remove — spread
 * across the launcher and the provisioning module, so a mutant exercised at one
 * of those seams would demonstrate a step rather than the damage.
 */
async function loadDaemon(distDir) {
  const [herdr, router, registry, config, identity, launchers] = await Promise.all([
    import(path.join(distDir, 'herdr.js')),
    import(path.join(distDir, 'router.js')),
    import(path.join(distDir, 'agent-registry.js')),
    import(path.join(distDir, 'config.js')),
    import(path.join(distDir, 'identity.js')),
    import(path.join(distDir, 'launchers.js'))
  ]);
  return {
    HerdrBridge: herdr.HerdrBridge,
    MessageRouter: router.MessageRouter,
    AgentRegistry: registry.AgentRegistry,
    loadConfig: config.loadConfig,
    agentsDirFor: identity.agentsDirFor,
    sidecarDirFor: identity.sidecarDirFor,
    agyMcpConfigPath: launchers.agyMcpConfigPath
  };
}

const realBuild = await loadDaemon(dist);

// ---------------------------------------------------------------------------
// Scaffolding.

/** Read a file that may legitimately be absent. `null` fails a check; it does not throw. */
const readIfPresent = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const parseIfPresent = (file) => {
  const text = readIfPresent(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Every PTY this script opens, so none is left running. */
const bridges = [];
let worldNumber = 0;

/**
 * A self-contained daemon world: its own $HOME (so its own global agy config),
 * its own dataDir (so its own set of provenance records), its own registry.
 *
 * ONE WORLD PER SECTION, and the dataDir is why: the ownership question scans
 * every sidecar under `<dataDir>/agents`, so two sections sharing a dataDir
 * would have each other's agents as claimants and would silently stop being
 * about what they say they are about.
 */
function newWorld(label, build = realBuild) {
  const n = ++worldNumber;
  const home = path.join(tmp, `home-${n}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;

  const dataDir = path.join(tmp, `data-${n}-${label}`);
  const configPath = path.join(tmp, `crabcast-${n}-${label}.config.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const config = build.loadConfig(configPath);
  const agyFile = build.agyMcpConfigPath();

  const world = {
    label,
    home,
    dataDir,
    config,
    agyFile,
    agentsDir: build.agentsDirFor(dataDir),
    /** The `mcpServers` map currently in the global agy config, or null. */
    agyServers: () => parseIfPresent(agyFile)?.mcpServers ?? null,
    sidecarOf: (dir) => build.sidecarDirFor(dataDir, dir),
    /** A directory the caller already owns. */
    ownedDir: (name, seed = {}) => {
      const dir = path.join(tmp, 'owned', `${n}-${label}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(seed)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
      return fs.realpathSync(dir);
    },
    /**
     * Put an entry in the global agy config that is the USER'S — written before
     * CrabCast has seen this $HOME at all, which is the one thing in these
     * scenarios that cannot come from the daemon.
     */
    seedTheirKey: (name, definition, extra = {}) => {
      fs.mkdirSync(path.dirname(agyFile), { recursive: true });
      const body = { ...extra, mcpServers: { [name]: definition } };
      fs.writeFileSync(agyFile, JSON.stringify(body, null, 2));
      return JSON.stringify(definition);
    }
  };

  const agentRegistry = new build.AgentRegistry(path.join(tmp, `agents-${n}-${label}.jsonl`));
  const bridge = new build.HerdrBridge(config.dataDir, config.configPath);
  bridges.push(bridge);
  const events = [];

  world.invoke = (request) =>
    new Promise((resolve) => {
      const router = new build.MessageRouter({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: (msg) => events.push(msg)
      });
      router.handle(request);
    });

  /** Configure + activate an anti-gravity agent, past the capacity gate. */
  world.bringUp = async (dir, knobs = {}) => {
    const configured = await world.invoke({
      action: 'configure_agent',
      path: dir,
      ...AGY,
      mcpServers: { crabcast: 'builtin' },
      ...knobs
    });
    if (!configured.success) return { configured, activated: null };
    const activated = await world.invoke({ action: 'activate_agent', path: dir, override: true });
    return { configured, activated };
  };

  /** Stand down, then forget — `forget` refuses a running agent, deliberately. */
  world.standDownAndForget = async (dir) => {
    await world.invoke({ action: 'deactivate_agent', path: dir });
    return world.invoke({ action: 'forget_agent', path: dir });
  };

  return world;
}

const AGY = { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'anti-gravity' };

/** The definition a user might plausibly have under the name we also want. */
const THEIR_DEFINITION = {
  command: '/usr/local/bin/my-own-crabcast',
  args: ['--not-the-daemons'],
  env: { MINE: 'yes' }
};

/** Whether the global agy config still holds the USER'S bytes under `crabcast`. */
const theirKeyIntact = (world, expected) =>
  JSON.stringify(world.agyServers()?.crabcast) === expected;

// ===========================================================================
section('1. THE DATA-LOSS SEQUENCE, END TO END — their entry survives it (AC 1)');

// THIS IS THE SECTION THE TICKET IS FOR. Every other one is either a control
// for it or a second refusal that falls out of the same change.
//
// The sequence, and why each step was individually defensible before KAN-178:
//
//   1. The user has their own `crabcast` server in their GLOBAL agy config.
//      Nothing about that is unusual — it is their file and their choice of
//      name, and CrabCast has never seen this machine.
//   2. An agy agent activates. `configureAgyMcp` merged with
//      `{ ...config.mcpServers, ...defs }`, which overwrote their value. It was
//      not malicious and it was not a bug in the merge: the merge was simply
//      never asked whose key it was writing over.
//   3. The write is recorded as provenance, correctly — CrabCast really did
//      write those bytes.
//   4. `crabcast forget` removes the key, correctly by its own record: the
//      bytes on disk are the bytes it wrote, so the "somebody edited this"
//      guard does not fire. The bytes guard protects a key edited AFTER we
//      wrote it. This key was theirs BEFORE.
//
// End state: their entry is gone from their own file, and no single step did
// anything it was not designed to do. KAN-140 is what made step 4 possible, so
// the reversal that was added to make CrabCast more honest is what turned a
// clobber into a deletion.
const w1 = newWorld('their-key');
const a1 = w1.ownedDir('agent-a', { 'README.md': '# theirs\n' });
{
  const theirBytes = w1.seedTheirKey('crabcast', THEIR_DEFINITION, {
    // Something of theirs that is not ours, so "the file survived" is a claim
    // about the whole file and not only about the one key.
    theirOwnSetting: 'do not lose this either'
  });
  console.log('    their global agy config, before CrabCast has seen this machine:');
  console.log(block(parseIfPresent(w1.agyFile)));

  const { configured, activated } = await w1.bringUp(a1);
  check('(precondition) the agent really was configured, so the activation is what refused',
    configured?.success === true, configured?.error);

  console.log(`    the activation:\n      ${JSON.stringify({ success: activated?.success })}`);
  console.log(`      ${activated?.error}`);

  check(
    'STEP 2 NEVER HAPPENS: the activation is REFUSED rather than overwriting a key that is ' +
      'already the user\'s',
    activated?.success === false,
    JSON.stringify({ success: activated?.success, error: activated?.error })
  );
  check(
    'their entry is untouched — their exact bytes, not merely a key of that name',
    theirKeyIntact(w1, theirBytes),
    JSON.stringify(w1.agyServers())
  );
  check(
    'and the rest of their file with it',
    parseIfPresent(w1.agyFile)?.theirOwnSetting === 'do not lose this either',
    JSON.stringify(parseIfPresent(w1.agyFile))
  );
  check(
    'STEP 3 NEVER HAPPENS: nothing is recorded as ours. A provenance record here is what would ' +
      'license the removal in step 4',
    parseIfPresent(path.join(w1.sidecarOf(a1), 'provisioned.json'))?.agyMcp === undefined,
    JSON.stringify(parseIfPresent(path.join(w1.sidecarOf(a1), 'provisioned.json')))
  );
  check(
    'and nothing is DISCLOSED about the global config either — a response naming a merge that ' +
      'was refused would be the same false sentence in the other direction',
    !(activated?.provisioned ?? []).some((d) => d.artifact === 'agy-mcp-config'),
    JSON.stringify(activated?.provisioned)
  );

  // WHAT THE REFUSAL DOES *NOT* UNDO, asserted rather than left to be inferred.
  //
  // `configureAgyMcp` runs from the launcher's `setup`, which is later than
  // `provisionMcpConfig` — so by the time this refuses, the agent's own
  // `.mcp.json` has already been written into the caller's directory and
  // recorded. The refusal message therefore scopes its "nothing was written" to
  // the global config and says so; these two checks are what stop that sentence
  // from quietly becoming false again.
  //
  // It is residue rather than damage BECAUSE it is recorded — the last check
  // below is the difference between the two.
  const callerMcp = path.join(a1, '.mcp.json');
  check(
    'the refusal does NOT undo the agent\'s own `.mcp.json` — it was provisioned before `setup` ' +
      'ran, and this is true of every setup-stage refusal including the claude launcher\'s',
    fs.existsSync(callerMcp),
    JSON.stringify(fs.readdirSync(a1))
  );
  check(
    'and the refusal SAYS so rather than claiming the whole activation left nothing behind — the ' +
      'unqualified "NOTHING WAS WRITTEN" would be a false sentence about the caller\'s disk',
    /about the global config only/.test(activated?.error ?? '') &&
      /NOTHING WAS WRITTEN TO IT/.test(activated?.error ?? ''),
    activated?.error
  );
  check(
    '(precondition) and it is RECORDED, which is what makes it residue `forget` can take back ' +
      'out rather than something found months later',
    parseIfPresent(path.join(w1.sidecarOf(a1), 'provisioned.json'))?.mcpConfig?.file === callerMcp
  );

  // STEP 4, run for real. The point is not that `forget` behaves — it is that
  // the sequence reaches its last step and their data is still there.
  const forgotten = await w1.standDownAndForget(a1);
  console.log('    `forget`, the step that used to delete their entry:');
  console.log(block({ removed: forgotten.removed, left: forgotten.left }));

  check(
    'and `forget` really does take that residue back out, so the refusal leaves the caller\'s ' +
      'directory as it found it once the agent is retired',
    !fs.existsSync(callerMcp),
    JSON.stringify(fs.readdirSync(a1))
  );
  check(
    'STEP 4 REMOVES NOTHING FROM THEIR FILE — and says nothing about it, having never touched it',
    !(forgotten.removed ?? []).some((r) => r.includes(w1.agyFile)) &&
      !(forgotten.left ?? []).some((l) => l.includes(w1.agyFile)),
    JSON.stringify({ removed: forgotten.removed, left: forgotten.left })
  );
  check(
    'THE WHOLE SEQUENCE RAN AND THEIR ENTRY IS STILL THERE, byte for byte. This is the assertion ' +
      'the ticket exists for: it describes damage, not policy',
    theirKeyIntact(w1, theirBytes),
    JSON.stringify(w1.agyServers())
  );
}

// ===========================================================================
section('2. The refusal says WHICH key, WHOSE it is, and WHAT TO DO (AC 2)');

// A refusal the caller cannot act on is a log line that stops an activation.
// `provisionMcpConfig`'s wording is the precedent and is deliberately reused
// rather than reinvented — one vocabulary for one rule, across both files.
const w2 = newWorld('refusal-wording');
const a2 = w2.ownedDir('agent-a');
{
  w2.seedTheirKey('crabcast', THEIR_DEFINITION);
  const { activated } = await w2.bringUp(a2);
  const error = activated?.error ?? '';
  console.log(`    the refusal:\n      ${error}`);

  check('it refused', activated?.success === false, JSON.stringify(activated));
  check("it names the KEY, so the reader knows which entry to look at", /'crabcast'/.test(error), error);
  check('it names the FILE, by absolute path', error.includes(w2.agyFile), error);
  check(
    'it says WHOSE the key is, in the vocabulary `provisionMcpConfig` already uses for this ' +
      'refusal — "no record of writing them", "not ours to take over"',
    /no record of writing them/.test(error) && /not ours to take over/.test(error),
    error
  );
  check(
    'it says the file is the user\'s GLOBAL config, which is what makes this worse here than at ' +
      'a per-directory `.mcp.json`',
    /GLOBAL/.test(error),
    error
  );
  check(
    'it names the CONSEQUENCE that motivated the ticket — that a later `forget` would remove ' +
      'their entry outright',
    /forget/.test(error) && /remove it outright/.test(error),
    error
  );
  check(
    'and it says what to DO: rename or remove the entry, or configure the agent without the ' +
      'colliding server',
    /Rename or remove/.test(error) && /without the colliding server/.test(error),
    error
  );
  check(
    'and that nothing was written TO IT and nothing was started — the caller needs to know the ' +
      'file is unchanged, not just that the agent is absent',
    /NOTHING WAS WRITTEN TO IT/.test(error) && /nothing was started/i.test(error),
    error
  );
  check(
    'and the claim is SCOPED to that file rather than to the whole activation, because the ' +
      'agent\'s own `.mcp.json` was already provisioned by the time this refused. An unqualified ' +
      '"nothing was written" here would be a false sentence about the caller\'s disk',
    /about the global config only/.test(error) && /crabcast forget/.test(error),
    error
  );
}

// ===========================================================================
section('3. POSITIVE CONTROL: a key CRABCAST wrote does not refuse (AC 3)');

// WITHOUT THIS THE GUARD IS INDISTINGUISHABLE FROM A WALL. Every refusal
// asserted above would also pass against a `configureAgyMcp` that threw
// unconditionally, and the suite would be green while no agy agent could ever
// start.
//
// The commonest collision by far, and the one that must not refuse: the same
// agent activating again over the key it wrote last time.
const w3 = newWorld('our-own-key');
const a3 = w3.ownedDir('agent-a');
{
  const first = await w3.bringUp(a3);
  check('the first activation succeeds against a config with no collision in it',
    first.activated?.success === true, first.activated?.error);
  const ourBytes = JSON.stringify(w3.agyServers()?.crabcast);
  check('and our key really is in the file, so the second activation is a genuine collision',
    typeof ourBytes === 'string' && ourBytes !== 'undefined', JSON.stringify(w3.agyServers()));
  check(
    '(precondition) it was recorded, which is the record the second activation will read to ' +
      'recognise the key as ours',
    parseIfPresent(path.join(w3.sidecarOf(a3), 'provisioned.json'))?.agyMcp !== undefined
  );

  await w3.invoke({ action: 'deactivate_agent', path: a3 });
  const second = await w3.invoke({ action: 'activate_agent', path: a3, override: true });
  check(
    'RE-ACTIVATION OVER OUR OWN KEY IS NOT REFUSED — the refusal fires on the user\'s keys, not ' +
      'on every key that is already present',
    second?.success === true,
    second?.error
  );
  check(
    'and it still discloses the merge, so the second activation is a real write rather than a ' +
      'skipped one that happens not to refuse',
    (second?.provisioned ?? []).some((d) => d.artifact === 'agy-mcp-config'),
    JSON.stringify((second?.provisioned ?? []).map((d) => d.artifact))
  );
}

// ===========================================================================
section('4. POSITIVE CONTROL: a SIBLING\'s key does not refuse (AC 3, shared file)');

// THE SCOPING WORRY THE TICKET RAISED, settled by measurement. The agy config
// is shared, so if "CrabCast has no record of writing this key" were read as
// "*I* have no record", the second agy agent would be refused because of the
// first agent's key — an activation blocked over state the agent does not own
// and never touched.
//
// It is not read that way: the ownership question consults every agent's
// provenance record, the same census `forget` reference-counts with. A
// sibling's key is CrabCast's key.
const w4 = newWorld('siblings');
const a4 = w4.ownedDir('agent-a');
const b4 = w4.ownedDir('agent-b');
{
  const first = await w4.bringUp(a4);
  check('agent A activated', first.activated?.success === true, first.activated?.error);
  check('(precondition) A left its key in the shared file, so B faces a real collision',
    w4.agyServers()?.crabcast !== undefined, JSON.stringify(w4.agyServers()));
  check(
    '(precondition) and B has NO record of its own for that key — so if the question were asked ' +
      'of B\'s sidecar alone, B would be refused here',
    parseIfPresent(path.join(w4.sidecarOf(b4), 'provisioned.json'))?.agyMcp === undefined
  );

  const second = await w4.bringUp(b4);
  check(
    'AGENT B IS NOT REFUSED over agent A\'s key. The rule is "CrabCast has no record", not "I ' +
      'have no record", and this is the difference between them',
    second.activated?.success === true,
    second.activated?.error
  );
  check(
    'and B recorded the key too, so both agents claim it and the reference count stays correct',
    parseIfPresent(path.join(w4.sidecarOf(b4), 'provisioned.json'))?.agyMcp !== undefined
  );
}

// ===========================================================================
section('5. Ownership that cannot be ESTABLISHED refuses, and says what it could not read');

// THE THIRD ANSWER. A census can fail — an unreadable sibling record may be
// exactly the one that wrote the key — and an unestablished answer is not an
// all-clear.
//
// The direction is the same principle the removal side applies, pointing at the
// opposite action. `removeOurAgyKeys` will not TAKE a key it cannot account
// for; this will not WRITE OVER one. Both are "do not touch what you cannot
// account for", and the asymmetry in the verbs is why they look opposite.
const w5 = newWorld('indeterminate');
const a5 = w5.ownedDir('agent-a');
const b5 = w5.ownedDir('agent-b');
{
  const first = await w5.bringUp(a5);
  check('(precondition) agent A activated and left its key in the shared file',
    first.activated?.success === true && w5.agyServers()?.crabcast !== undefined,
    first.activated?.error);

  // The fixture: A's record — a real one the daemon wrote — is corrupted. The
  // key in the file is genuinely CrabCast's; what is destroyed is the evidence.
  const aRecord = path.join(w5.sidecarOf(a5), 'provisioned.json');
  fs.writeFileSync(aRecord, '{ not json at all');
  check('(precondition) A\'s provenance record is now unreadable', parseIfPresent(aRecord) === null);

  const second = await w5.bringUp(b5);
  const error = second.activated?.error ?? '';
  console.log(`    the refusal:\n      ${error}`);

  check(
    'B IS REFUSED: with A\'s record unreadable, nothing establishes that the key in the file is ' +
      'CrabCast\'s, and an entry that cannot be shown to be ours is treated as the user\'s',
    second.activated?.success === false,
    JSON.stringify({ success: second.activated?.success, error })
  );
  check(
    'and the refusal says it could not ESTABLISH ownership rather than claiming the key is the ' +
      'user\'s — the two are different facts and the caller acts on them differently',
    /could not establish whether it wrote them/.test(error),
    error
  );
  check(
    'and it names the unreadable record, so the caller can fix the thing that is actually broken',
    error.includes(aRecord),
    error
  );
  check(
    'their file is untouched, as with every other refusal here',
    w5.agyServers()?.crabcast !== undefined && parseIfPresent(w5.agyFile) !== null
  );
}

// ===========================================================================
section('6. A write that FAILS refuses the activation (AC 1, the other half)');

// THE QUIETER HALF OF THE TICKET. `provisionMcpConfig` throws and `initPty`
// turns that into spawnError + terminated, on the stated grounds that "an agent
// started without them is an agent that is missing something it was promised,
// behind a success answer". `configureAgyMcp` logged and returned, and the
// agent started.
//
// THE FIXTURE IS A REGULAR FILE AT `$HOME/.gemini`, chosen so the failure is
// deterministic: `mkdirSync` hits ENOTDIR whatever uid the suite runs as. A
// chmod-based fixture would silently stop failing under root and the section
// would go green having tested nothing.
const w6 = newWorld('unwritable');
const a6 = w6.ownedDir('agent-a');
{
  const blocker = path.join(w6.home, '.gemini');
  fs.writeFileSync(blocker, 'a regular file where the config directory would go\n');
  check('(precondition) the config directory cannot be created', fs.statSync(blocker).isFile());

  const { activated } = await w6.bringUp(a6);
  const error = activated?.error ?? '';
  console.log(`    the refusal:\n      ${error}`);

  check(
    'THE ACTIVATION IS REFUSED. It used to log and start the agent, whose runtime would then come ' +
      'up with none of the MCP servers it was configured with',
    activated?.success === false,
    JSON.stringify({ success: activated?.success, error })
  );
  check(
    'and the refusal explains WHY that matters — the antigravity CLI reads its servers from that ' +
      'file and nowhere else',
    /nowhere else/.test(error) && /quietly missing what it was promised/.test(error),
    error
  );
  check('and says nothing was started', /NOTHING WAS STARTED/i.test(error), error);
  check(
    'nothing was recorded for a write that did not land',
    parseIfPresent(path.join(w6.sidecarOf(a6), 'provisioned.json'))?.agyMcp === undefined
  );
  check('and their file was not created behind the failure', !fs.existsSync(w6.agyFile));
}

// ===========================================================================
section('7. The refusals above can actually fail (mutation)');

// A CHECK THAT CANNOT FAIL IS NOT A CHECK, and a refusal is the easiest kind of
// assertion to write in a way that cannot fail. Each mutation below backs one
// refusal out of a COPY of the compiled daemon and requires the property the
// section above asserted to go red against it.
//
// §7a IS THE IMPORTANT ONE and it is not merely "the check goes red": it runs
// §1's whole sequence end to end against a build without the foreign-key
// refusal and watches the user's entry be DELETED. That is the damage this
// ticket exists to prevent, observed rather than described — the pre-fix
// behaviour, reproduced.
//
// Through `scripts/mutation.mjs`, so a mutation whose anchor has drifted is a
// counted FAIL naming what to fix rather than a throw that takes the rest of
// the file with it.

const mutantScratch = path.join(tmp, 'mutants');
fs.mkdirSync(mutantScratch, { recursive: true });

// A MUTANT HERE IS LOADED WHOLE, not one leaf module of it, and that is what
// makes this symlink necessary. `verify-agy-mcp-reversal` imports only
// `provisioning.js` from its mutants — a file whose imports are `fs` and `path`
// — so a mutant sitting in /tmp resolves fine. This file imports `herdr.js`,
// which imports `node-pty` by bare specifier, and Node resolves that by walking
// `node_modules` up from the importing file: from /tmp there is nothing to
// find. Linking the repository's `node_modules` in beside the mutants puts one
// on that walk.
//
// In /tmp rather than in the repository deliberately: `verify-ci-wiring-guards`
// exits non-zero on a dirty tree, so a scratch directory inside the checkout
// would make this proof break an unrelated one.
const mutantModules = path.join(mutantScratch, 'node_modules');
const repoModules = path.join(scriptDir, '..', 'node_modules');
if (fs.existsSync(repoModules) && !fs.existsSync(mutantModules)) {
  fs.symlinkSync(repoModules, mutantModules, 'dir');
}
const { mutate, mutationsSkipped } = makeMutator({
  distDir: dist,
  scratch: mutantScratch,
  report: {
    pass: (label, detail) => check(label, true, detail),
    fail: (label, detail) => check(label, false, detail)
  }
});

mutationForeignKey: {
  // The pre-KAN-178 world: the merge never asks whose key it is writing over.
  const mutant = mutate(
    'no-foreign-key-refusal',
    'launchers.js',
    'if (ownership.foreign.length) {',
    'if (false && ownership.foreign.length) { // MUTANT: the user\'s key is taken over'
  );
  if (!mutant) break mutationForeignKey;

  const build = await loadDaemon(mutant).catch((e) => ({ threw: e?.message ?? String(e) }));
  check('(precondition) the mutant loaded rather than dying on import', build.threw === undefined,
    build.threw);
  if (build.threw) break mutationForeignKey;

  const w = newWorld('mutant-foreign', build);
  const a = w.ownedDir('agent-a');
  const theirBytes = w.seedTheirKey('crabcast', THEIR_DEFINITION);

  const { activated } = await w.bringUp(a);
  check(
    '(precondition) against the mutant the activation SUCCEEDS — so what follows is the sequence ' +
      'running to completion, not an activation that failed for some other reason',
    activated?.success === true,
    activated?.error
  );
  check(
    '§1\'s first property goes RED: their key has been overwritten with ours',
    !theirKeyIntact(w, theirBytes),
    JSON.stringify(w.agyServers())
  );
  check(
    'and it was recorded as OURS — which is what licenses the removal, and is the step that ' +
      'turns a clobber into a deletion',
    parseIfPresent(path.join(w.sidecarOf(a), 'provisioned.json'))?.agyMcp !== undefined,
    JSON.stringify(parseIfPresent(path.join(w.sidecarOf(a), 'provisioned.json'))?.agyMcp)
  );

  const forgotten = await w.standDownAndForget(a);
  console.log('    the mutant\'s `forget`:');
  console.log(block({ removed: forgotten.removed, left: forgotten.left }));

  check(
    'AND THEIR ENTRY IS GONE. The whole sequence, against a build without the refusal: the user ' +
      'has lost their own `crabcast` server from their own global config, and every step that ' +
      'did it behaved exactly as designed. THIS is what §1 measures',
    w.agyServers()?.crabcast === undefined,
    JSON.stringify(w.agyServers())
  );
  check(
    'and `forget` reports it as an ordinary reference-counted removal — so a reader of the ' +
      'RESPONSE could not have caught this either. Only the file can, which is why §1 asserts on ' +
      'the file',
    (forgotten.removed ?? []).some((r) => r.includes(w.agyFile)),
    JSON.stringify(forgotten.removed)
  );
}

mutationIndeterminate: {
  // Back out the third answer: ownership that cannot be established is read as
  // an all-clear, which is how an unreadable record becomes an overwrite.
  const mutant = mutate(
    'indeterminate-is-an-all-clear',
    'launchers.js',
    'if (ownership.indeterminate.length) {',
    'if (false && ownership.indeterminate.length) { // MUTANT: unestablished is treated as ours'
  );
  if (!mutant) break mutationIndeterminate;

  const build = await loadDaemon(mutant).catch((e) => ({ threw: e?.message ?? String(e) }));
  check('(precondition) the mutant loaded rather than dying on import', build.threw === undefined,
    build.threw);
  if (build.threw) break mutationIndeterminate;

  const w = newWorld('mutant-indeterminate', build);
  const a = w.ownedDir('agent-a');
  const b = w.ownedDir('agent-b');
  await w.bringUp(a);
  fs.writeFileSync(path.join(w.sidecarOf(a), 'provisioned.json'), '{ not json at all');

  const second = await w.bringUp(b);
  check(
    '§5\'s property goes RED: with the doubt branch removed, B writes over a key whose ownership ' +
      'nothing could establish',
    second.activated?.success === true,
    second.activated?.error
  );
}

mutationFailedWrite: {
  // The pre-KAN-178 world for the other half: the failed write is swallowed and
  // the agent starts anyway.
  const mutant = mutate(
    'swallow-the-failed-write',
    'launchers.js',
    'catch (e) {\n        throw new ProvisioningError(AGY_MCP_ARTIFACT, `Could not write ${agyConfigPath}',
    'catch (e) {\n        return { file: agyConfigPath, keys: null, reason: `MUTANT: swallowed ${e?.message}` };\n        throw new ProvisioningError(AGY_MCP_ARTIFACT, `Could not write ${agyConfigPath}'
  );
  if (!mutant) break mutationFailedWrite;

  const build = await loadDaemon(mutant).catch((e) => ({ threw: e?.message ?? String(e) }));
  check('(precondition) the mutant loaded rather than dying on import', build.threw === undefined,
    build.threw);
  if (build.threw) break mutationFailedWrite;

  const w = newWorld('mutant-failed-write', build);
  const a = w.ownedDir('agent-a');
  fs.writeFileSync(path.join(w.home, '.gemini'), 'a regular file\n');

  const { activated } = await w.bringUp(a);
  check(
    '§6\'s property goes RED: the agent starts even though its MCP servers could not be written, ' +
      'behind a success answer — which is exactly what this half of the ticket is about',
    activated?.success === true,
    activated?.error
  );
  check(
    'and nothing in the response says so, so the caller would have to read the daemon\'s log to ' +
      'find out',
    !(activated?.provisioned ?? []).some((d) => d.artifact === 'agy-mcp-config'),
    JSON.stringify(activated?.provisioned)
  );
}

// ---------------------------------------------------------------------------
// Cleanup, PROVEN rather than assumed. A verify script that leaks a PTY is a
// verify script whose next run is a flake.
//
// The bracketed `[m]js` is not cosmetic: `pgrep -f` matches the pattern against
// the `sh -c` this execSync spawns, which contains the pattern verbatim, so the
// naive form always finds one survivor — a leak check that always reports a
// leak reports nothing.
const shimPattern = shimImpl.replace(/mjs$/, '[m]js');
const survivors = () =>
  Number(execSync(`pgrep -fc ${JSON.stringify(shimPattern)} || true`, { encoding: 'utf8' }).trim() || 0);

const aliveBefore = survivors();
for (const bridge of bridges) {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
}
await new Promise((r) => setTimeout(r, 750));
const aliveAfter = survivors();
check(
  `every PTY this script opened is gone (${aliveBefore} alive before cleanup, ${aliveAfter} after)`,
  aliveAfter === 0,
  'a verify script that leaks a process is a verify script whose next run is a flake'
);
check(
  'and the count was non-zero before cleanup, so the check is measuring something',
  aliveBefore > 0,
  'if this reads 0, the survivor count has stopped seeing the shim at all and the line above ' +
    'passes for the wrong reason'
);

process.env.PATH = realPath;
process.env.HOME = realHome;
fs.rmSync(tmp, { recursive: true, force: true });

const skipped = mutationsSkipped();
console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(', ')}` +
      (skipped.length
        ? `\n(${skipped.length} mutation(s) did not apply, so their sections never ran: ${skipped.join(', ')})`
        : '')
    : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
