#!/usr/bin/env node
// Live proof for KAN-140: CrabCast's key in the antigravity CLI's GLOBAL MCP
// config is reversible by `forget` — reference-counted, so it comes out only
// when no other agy agent still needs it.
//
// WHAT FAILURE THIS WOULD CATCH: a `forget` that removes CrabCast's key from
// `~/.gemini/config/mcp_config.json` while another agy agent is still using
// it. That file is GLOBAL and has no project-scoped equivalent, so one agent's
// cleanup reaches into every sibling's configuration. The removal would be
// silent and the damage would surface later and elsewhere — the sibling simply
// starts with no MCP servers, and nothing anywhere connects that to a `forget`
// somebody ran on a different agent. It also catches the same failure arriving
// through the census rather than the removal: a sibling record that cannot be
// read counted as "claims nothing", which is how an unreadable file becomes a
// removal nobody authorised.
//
// THE ARTIFACT, AND WHY IT IS THE AWKWARD ONE. `docs/callers-directory.md`
// requires every write outside CrabCast's own data directory to be opted into,
// merged rather than replaced, named in the activation response, and
// REVERSIBLE. This artifact had the first three. It did not have the fourth,
// and that was a decision rather than an oversight: the file is shared by every
// agy agent this daemon runs, so removing the key when the first agent is
// forgotten takes the servers away from the second. Disclosure without a
// reversal it could not honestly perform was chosen over a reversal that breaks
// a sibling.
//
// Reference-counting earns the fourth property instead of trading it away.
// `forget` reads every agent's provenance record and removes the key only when
// nothing else claims it — which introduces a CLAIM OF ITS OWN, "no other agent
// needs this", resting on records that can be incomplete. So the interesting
// half of this file is not section 3 (it removes) but sections 2, 4, 5 and 6
// (every way it declines, and what it says while declining).
//
// THE SECTIONS:
//
//   1. two agy agents, really configured and really activated; the key is in
//      the global file and the activation response discloses it
//   2. `forget` the first — the key SURVIVES, and the report names the agent
//      that still claims it, by path
//   3. `forget` the second — the key is REMOVED, and the report says what the
//      removal RESTED ON rather than only that it happened
//   4. a sibling record that cannot be read does NOT remove
//   5. a census that cannot be taken at all does NOT remove
//   6. a key whose bytes are not the ones we recorded is left — and (6b) the
//      no-human case that used to produce that residue is now CLOSED, so the
//      section proves an absence where it used to prove a presence (KAN-235)
//   7. a write that did NOT happen is neither disclosed nor recorded
//   8. every check above can actually fail (mutation, via scripts/mutation.mjs)
//
// HOW REAL IT IS, and where the edges are. Everything on the daemon side is
// real: the real MessageRouter, the real HerdrBridge including `initPty`, the
// real launcher table, the real provisioning, a real config through the real
// loader, a real on-disk registry. The agents in sections 1-3 and 6 are
// configured and activated through the ordinary verbs, so the provenance
// records this file asserts on are records THE DAEMON PRODUCED — this proof
// does not hand itself the input it then measures. Only the external `herdr`
// binary is replaced, by a shim on PATH answering in herdr's own JSON shapes.
// $HOME is scratched per section, so the `~/.gemini/…` config written here is
// this script's own.
//
// WHERE IT DOES SUPPLY ITS OWN INPUT, said plainly because that is the defect
// this epic keeps re-finding: section 4 CORRUPTS a real record (the corruption
// is the fixture; the record it corrupts is real), and section 5 calls
// `removeProvisionedArtifacts` directly with the census pointed somewhere it
// cannot read (the sidecar, the provenance and the global file are all real;
// only the census location is redirected, because the router always supplies a
// valid one and there is no other way to reach that branch). Both are named
// here rather than left to be inferred.
//
// AND WHAT THIS FILE DOES NOT COVER: it does not run a real `agy` binary. The
// global config is written by CrabCast and read back by CrabCast here, so every
// assertion below would hold just as well if no other program on the machine
// ever opened the file — WHICH IS EXACTLY WHAT WAS TRUE until KAN-235. This
// suite was green for three slices while the path in it was wrong, and it could
// not have been otherwise: its input was its own output.
//
// THAT GAP HAS AN OWNER NOW: `verify-agy-reads-what-we-write.mjs` runs a real
// `agy` and requires agy to START a server CrabCast defined. It covers delivery
// and says nothing about reference counting; this file covers reference counting
// and says nothing about delivery. Neither covers the other, and the hole
// between them is what KAN-145 and KAN-235 were both about — so it is named
// here rather than left to be inferred from two green runs.
//
// Usage:
//   npm run build
//   node scripts/verify-agy-mcp-reversal.mjs [distDir]

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan140-agy-'));
const realPath = process.env.PATH;
const realHome = process.env.HOME;

// ---------------------------------------------------------------------------
// The herdr shim. Records every argv and makes an activation VERIFY, because
// every section here is about what a SUCCESSFUL activation wrote and what a
// later `forget` takes back out. It reports `agy` as the runtime rather than
// `claude`, since these are anti-gravity agents; the bridge only requires SOME
// runtime, but a shim that lies about which one would make the pane census
// disagree with the launcher for no reason.
const shimState = path.join(tmp, 'shim');
const shimDir = path.join(tmp, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN140_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN140_SHIM_STATE;
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

const { HerdrBridge } = await import(path.join(dist, 'herdr.js'));
const { MessageRouter } = await import(path.join(dist, 'router.js'));
const { AgentRegistry } = await import(path.join(dist, 'agent-registry.js'));
const { loadConfig } = await import(path.join(dist, 'config.js'));
const { agentsDirFor, sidecarDirFor } = await import(path.join(dist, 'identity.js'));
const { agyMcpConfigPath } = await import(path.join(dist, 'launchers.js'));
const { removeProvisionedArtifacts } = await import(path.join(dist, 'provisioning.js'));

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
 * ONE WORLD PER SECTION, and the dataDir is why. The census scans every sidecar
 * under `<dataDir>/agents`, so two sections sharing a dataDir would have each
 * other's agents as claimants and the sections would silently stop being about
 * what they say they are about.
 */
function newWorld(label) {
  const n = ++worldNumber;
  const home = path.join(tmp, `home-${n}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;

  const dataDir = path.join(tmp, `data-${n}-${label}`);
  const configPath = path.join(tmp, `crabcast-${n}-${label}.config.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  const config = loadConfig(configPath);
  const agyFile = agyMcpConfigPath();

  const world = {
    label,
    home,
    dataDir,
    config,
    agyFile,
    agentsDir: agentsDirFor(dataDir),
    /** The `mcpServers` map currently in the global agy config, or null. */
    agyServers: () => parseIfPresent(agyFile)?.mcpServers ?? null,
    sidecarOf: (dir) => sidecarDirFor(dataDir, dir),
    /** A directory the caller already owns. */
    ownedDir: (name, seed = {}) => {
      const dir = path.join(tmp, 'owned', `${n}-${label}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(seed)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
      return fs.realpathSync(dir);
    }
  };

  const agentRegistry = new AgentRegistry(path.join(tmp, `agents-${n}-${label}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  bridges.push(bridge);
  const events = [];

  world.invoke = (request) =>
    new Promise((resolve) => {
      const router = new MessageRouter({
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
      mcpServers: { crabcast: 'builtin', [SHARED_KEY]: OUR_DEFINITION },
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

/**
 * The CALLER-SUPPLIED server whose reference counting this file is about.
 *
 * IT USED TO BE THE `crabcast` BUILTIN, AND THAT STOPPED WORKING AT KAN-235.
 * The builtin carries this agent's identity and the agy config is shared by
 * every agy agent, so it is now deliberately not written there at all. A suite
 * whose subject is "the shared key survives one forget and goes with the last"
 * needs a key that actually reaches the shared file, and caller-supplied
 * servers are the ones that do.
 *
 * Agents here are configured with BOTH — the builtin and this — because that is
 * the ordinary production shape, and because it keeps §2's contrast honest: the
 * builtin still lands in the agent's own `.mcp.json` and is still removed from
 * it by the same `forget` that leaves the shared key alone.
 */
const SHARED_KEY = 'notes';

/** What the caller configures both agents with. Identical, so they may share it. */
const OUR_DEFINITION = {
  command: '/usr/local/bin/notes-mcp',
  args: ['--shared-by-both-agents'],
  env: { SOURCE: 'caller' }
};

/** Whether the global agy config still holds CrabCast's server key. */
const hasOurKey = (world) => world.agyServers()?.[SHARED_KEY] !== undefined;

const showForget = (label, response) => {
  console.log(`    ${label}`);
  console.log(block({ removed: response?.removed, left: response?.left }));
};

// ===========================================================================
section('1. Two agy agents, really configured and really activated (AC 1 setup)');

const w1 = newWorld('two-agents');
const a1 = w1.ownedDir('agent-a', { 'README.md': '# theirs\n' });
const b1 = w1.ownedDir('agent-b', { 'README.md': '# theirs\n' });
let up1;
let up2;
{
  console.log(`    the global agy config for this section:\n      ${w1.agyFile}`);
  check('it does not exist before anything is activated', !fs.existsSync(w1.agyFile), w1.agyFile);

  up1 = await w1.bringUp(a1);
  check('agent A activated', up1.activated?.success === true, up1.activated?.error ?? up1.configured?.error);

  up2 = await w1.bringUp(b1);
  check('agent B activated', up2.activated?.success === true, up2.activated?.error ?? up2.configured?.error);

  console.log('    the global agy config after both activations:');
  console.log(block(w1.agyServers()));

  check(
    "CrabCast's server really is in the user's GLOBAL antigravity config — the write is real, " +
      'not a fixture this script wrote for itself',
    hasOurKey(w1),
    JSON.stringify(w1.agyServers())
  );

  const disclosure = (up1.activated?.provisioned ?? []).find((d) => d.artifact === 'agy-mcp-config');
  console.log("    agent A's activation response, on the global config:");
  console.log(block(disclosure));

  check('the activation response names it, by absolute path', disclosure?.file === w1.agyFile);
  check(
    'and says it is OUTSIDE the agent\'s directory and SHARED with every other agy agent — the ' +
      'two facts that make its removal a fleet-wide question rather than a local one',
    /OUTSIDE/.test(disclosure?.detail ?? '') && /SHARED/.test(disclosure?.detail ?? ''),
    disclosure?.detail
  );
  check(
    'the reversal is CONDITIONAL and says on what — not "removed by forget", which would be a ' +
      'promise this cannot keep, and not "never removed", which is what it used to say',
    /forget/.test(disclosure?.reversal ?? '') &&
      /only when no other agent/i.test(disclosure?.reversal ?? '') &&
      /LEAVES/.test(disclosure?.reversal ?? ''),
    disclosure?.reversal
  );
  check(
    'it is its OWN artifact kind, not the per-directory .mcp.json\'s — two artifacts with ' +
      'opposite removal rules under one name is how a reader comes away holding the wrong one',
    disclosure?.artifact === 'agy-mcp-config' &&
      (up1.activated?.provisioned ?? []).some(
        (d) => d.artifact === 'mcp-config' && d.file === path.join(a1, '.mcp.json')
      ),
    JSON.stringify((up1.activated?.provisioned ?? []).map((d) => `${d.artifact} ${d.file}`))
  );

  // The provenance record is what every later section rests on, so it is
  // asserted here rather than assumed by them.
  const provA = parseIfPresent(path.join(w1.sidecarOf(a1), 'provisioned.json'));
  check(
    "agent A's provenance records the claim — the daemon wrote this, which is what makes the " +
      'sections below a test of the mechanism rather than of a record this script typed in',
    provA?.agyMcp?.file === w1.agyFile && typeof provA?.agyMcp?.keys?.[SHARED_KEY] === 'string',
    JSON.stringify(provA?.agyMcp)
  );
}

// ===========================================================================
section('2. `forget` the FIRST agent — the key survives, and it says who needs it (AC 1)');
{
  const forgotten = await w1.standDownAndForget(a1);
  showForget('forget(A):', forgotten);

  check('forget succeeded', forgotten.success === true, forgotten.error);
  check(
    'THE KEY IS STILL THERE — agent B is still using it, and this file has no per-agent ' +
      'equivalent, so removing it here would have taken B\'s servers away',
    hasOurKey(w1),
    JSON.stringify(w1.agyServers())
  );
  check(
    'and forget SAYS SO, naming the agent that still claims it BY PATH — "somebody else needs ' +
      'it" is not actionable; a path is',
    (forgotten.left ?? []).some((l) => l.includes(w1.agyFile) && l.includes(b1)),
    JSON.stringify(forgotten.left)
  );
  check(
    'the reason given is the CLAIM, not a generic failure — a reader has to be able to tell ' +
      '"deliberately left" from "could not be removed", and the reason is what proves the census ' +
      'is what stopped it rather than something further down',
    (forgotten.left ?? []).some((l) => l.includes(w1.agyFile) && /still claim/.test(l)),
    JSON.stringify(forgotten.left)
  );

  // A SECOND GUARD ALSO HOLDS HERE, and saying so is the difference between a
  // section that reports what it measured and one that lets a reader over-read
  // it. Forgetting the FIRST agent is protected twice: by the census (which is
  // what the reason above proves stopped it) and, underneath that, by the byte
  // comparison — agent B's activation rewrote the key with B's own definition,
  // so A's record no longer describes what is in the file and the removal would
  // have been declined even by a census that saw nothing.
  //
  // That is defence in depth rather than a flaw, but it means "the key survived"
  // ALONE is not evidence about the census in this order. Where the census is
  // the only thing standing between a claimed key and its removal is the other
  // order — the LAST writer being forgotten while an earlier agent still claims
  // it — and that is the order §4 and §8's mutations use, deliberately.
  //
  // AND THE SHARPER VERSION OF THE SAME POINT, measured against a build with
  // the reversal removed entirely: "THE KEY IS STILL THERE" PASSES on the
  // PRE-FIX daemon. Of course it does — the pre-fix `forget` never touched this
  // file, so the key survives everything. A section that asserted only the
  // file's state would have been green against the code this slice replaces,
  // which is the definition of a check that is not one. The checks that
  // discriminate are the ones on the REASON: they are why this section goes red
  // when the mechanism is absent rather than merely when it misbehaves.

  // THE CONTRAST THAT MAKES THE ABOVE A DISCRIMINATION RATHER THAN A REFUSAL TO
  // ACT. The same forget, in the same call, DID remove the per-directory key —
  // because that file has one owner. A `forget` that had simply failed would
  // have left both.
  check(
    "agent A's own .mcp.json key WAS removed by the same call — the conditional treatment is " +
      'about the SHARED file specifically, not about forget having given up',
    parseIfPresent(path.join(a1, '.mcp.json'))?.mcpServers?.crabcast === undefined &&
      (forgotten.removed ?? []).some((r) => r.includes(path.join(a1, '.mcp.json'))),
    `removed: ${JSON.stringify(forgotten.removed)}`
  );
}

// ===========================================================================
section('3. `forget` the LAST agent — the key goes, and it says what that rested on (AC 1, AC 3)');
{
  const forgotten = await w1.standDownAndForget(b1);
  showForget('forget(B):', forgotten);

  check('forget succeeded', forgotten.success === true, forgotten.error);
  check(
    'THE KEY IS GONE — the last agent that claimed it has been forgotten, so there is nothing ' +
      'left for it to break',
    !hasOurKey(w1),
    JSON.stringify(w1.agyServers())
  );
  check(
    'the file itself SURVIVES — it is the user\'s global antigravity config, and CrabCast\'s ' +
      'claim on it was one key',
    fs.existsSync(w1.agyFile),
    w1.agyFile
  );
  check(
    'the report says WHAT THE REMOVAL RESTED ON, not merely that it happened — a reader told ' +
      '"removed" cannot tell a reference-counted removal from a blind one, and those differ by ' +
      'whether a sibling has just been broken',
    (forgotten.removed ?? []).some(
      (r) => r.includes(w1.agyFile) && /removed BECAUSE no other agent/.test(r)
    ),
    JSON.stringify(forgotten.removed)
  );
  check(
    'and it says how many records that rested on — "nobody claimed it" out of zero records read ' +
      'is a different sentence from the same words out of three',
    (forgotten.removed ?? []).some((r) => r.includes(w1.agyFile) && /record\(s\) read/.test(r)),
    JSON.stringify(forgotten.removed)
  );
}

// ===========================================================================
section('4. A sibling record that CANNOT BE READ does not remove (AC 2)');

// THE DANGEROUS DIRECTION, and the reason `readProvenanceOutcome` exists. The
// pre-existing `readProvenance` collapses "no record" and "unreadable record"
// to `null`, which is exactly right when the question is about an agent's OWN
// artifacts — a record we cannot read is a permission we do not have — and
// exactly wrong when the question is about a SIBLING, where it reads as "that
// agent claims nothing" and authorises the removal.
//
// THE ORDER HERE IS CHOSEN SO THE CENSUS IS THE ONLY GUARD. The agent being
// forgotten is the LAST one to have written the key, so its recorded bytes are
// the bytes on disk and the byte comparison would permit the removal. Corrupt
// the OTHER agent's record and the census is the single thing left standing
// between a key somebody may need and its deletion — which is what this section
// is about, and what §8's mutation can therefore red without also having to
// defeat a second guard. (§2 has both guards; it says so.)
const w4 = newWorld('unreadable');
const a4 = w4.ownedDir('agent-a');
const b4 = w4.ownedDir('agent-b');
{
  await w4.bringUp(a4);
  await w4.bringUp(b4);
  check('two agy agents are up and the key is in the global config', hasOurKey(w4));

  // The CORRUPTION is the fixture; the record it corrupts is one the daemon
  // really wrote, at the path the daemon really chose.
  const victim = path.join(w4.sidecarOf(a4), 'provisioned.json');
  check(
    "setup precondition: agent A's provenance really exists to be corrupted",
    fs.existsSync(victim),
    victim
  );
  fs.writeFileSync(victim, '{ this was a provenance record until something truncated it');
  console.log(`    agent A's record, corrupted on disk:\n      ${victim}`);

  const forgotten = await w4.standDownAndForget(b4);
  showForget("forget(B) — the last writer, so its own bytes match — with A's record unreadable:", forgotten);

  check('forget still succeeded — an unreadable sibling is not a reason to refuse the whole call',
    forgotten.success === true, forgotten.error);
  check(
    'THE KEY SURVIVES. The unreadable record may be exactly the agent that needs it, and an ' +
      'unremoved key is disclosed residue while a wrongly removed one silently breaks a running ' +
      'agent — so the count is refused rather than guessed',
    hasOurKey(w4),
    JSON.stringify(w4.agyServers())
  );
  check(
    'and the reason names the UNREADABILITY, with the file — "left" with no reason would be the ' +
      'same output as a bug',
    (forgotten.left ?? []).some(
      (l) => l.includes(w4.agyFile) && /could not be read/.test(l) && l.includes(victim)
    ),
    JSON.stringify(forgotten.left)
  );
  check(
    'and says the claim is UNKNOWN rather than that somebody claims it — the two are different ' +
      'facts and only one of them is recoverable by forgetting another agent',
    (forgotten.left ?? []).some((l) => l.includes(w4.agyFile) && /UNKNOWN/.test(l)),
    JSON.stringify(forgotten.left)
  );
}

// ===========================================================================
section('5. A census that cannot be taken AT ALL does not remove (AC 2)');

// SUPPLIED INPUT, AND THIS IS THE ONE PLACE IT IS. The router always hands
// `removeProvisionedArtifacts` a valid agents directory, so the "we could not
// look" branch is unreachable through the ordinary verbs. Everything else here
// is real — a real activation wrote the global config and the provenance record
// this call reads — and only the census LOCATION is redirected.
const w5 = newWorld('no-census');
const a5 = w5.ownedDir('agent-a');
{
  await w5.bringUp(a5);
  check('the agent is up and the key is in the global config', hasOurKey(w5));
  await w5.invoke({ action: 'deactivate_agent', path: a5 });

  const sidecar = w5.sidecarOf(a5);
  const report = removeProvisionedArtifacts({
    agentPath: a5,
    sidecarDir: sidecar,
    agentsDir: path.join(w5.dataDir, 'a-directory-that-is-not-there')
  });
  showForget('removeProvisionedArtifacts with an unlistable agents directory:', report);

  check(
    'THE KEY SURVIVES even though this agent is in fact the only claimant — "I could not check" ' +
      'is not "there is nobody", and the mechanism must not treat its own blindness as an ' +
      'all-clear',
    hasOurKey(w5),
    JSON.stringify(w5.agyServers())
  );
  check(
    'and the reason says the COUNT could not be established, and why',
    (report.left ?? []).some(
      (l) => l.includes(w5.agyFile) && /could not be established/.test(l) && /could not be listed/.test(l)
    ),
    JSON.stringify(report.left)
  );

  // And the same for a caller that supplies no census location at all — a
  // distinct branch, because `undefined` could so easily have been read as
  // "skip the check" rather than as "you cannot have the removal".
  const w5b = newWorld('no-census-arg');
  const a5b = w5b.ownedDir('agent-a');
  await w5b.bringUp(a5b);
  await w5b.invoke({ action: 'deactivate_agent', path: a5b });
  const report2 = removeProvisionedArtifacts({ agentPath: a5b, sidecarDir: w5b.sidecarOf(a5b) });
  check(
    'a caller that supplies NO agents directory is refused the removal too, rather than having ' +
      'the check skipped',
    hasOurKey(w5b) &&
      (report2.left ?? []).some((l) => l.includes(w5b.agyFile) && /could not be established/.test(l)),
    JSON.stringify(report2.left)
  );
}

// ===========================================================================
section('6. A key whose bytes are not the ones we recorded is left (AC 1)');

console.log('\n  6a. edited by hand');
const w6 = newWorld('edited');
const a6 = w6.ownedDir('agent-a');
{
  await w6.bringUp(a6);
  const before = w6.agyServers();
  check('setup precondition: the key CrabCast wrote is on disk to be edited',
    before?.[SHARED_KEY] !== undefined, JSON.stringify(before));

  const tampered = parseIfPresent(w6.agyFile) ?? {};
  if (tampered?.mcpServers?.[SHARED_KEY]) {
    tampered.mcpServers[SHARED_KEY].args = ['/somebody/changed/this.js'];
    fs.writeFileSync(w6.agyFile, JSON.stringify(tampered, null, 2));
  }

  const forgotten = await w6.standDownAndForget(a6);
  showForget('forget, on a key somebody edited:', forgotten);

  check(
    'the edited key is LEFT — this agent is the last claimant, so the count permits removal, and ' +
      'the bytes are what stop it: removing them would destroy somebody\'s change rather than ' +
      'undo ours',
    w6.agyServers()?.[SHARED_KEY]?.args?.[0] === '/somebody/changed/this.js',
    JSON.stringify(w6.agyServers())
  );
  check(
    'and the reason names both ways that can happen — a human, or another CrabCast agy agent ' +
      'rewriting it after us — because this mechanism genuinely cannot tell them apart',
    (forgotten.left ?? []).some(
      (l) => l.includes(w6.agyFile) && /does not account for|not the definition/.test(l)
    ),
    JSON.stringify(forgotten.left)
  );
}

console.log('\n  6b. THE KNOWN RESIDUE IS CLOSED — CrabCast can no longer produce it (KAN-235)');

// WHAT THIS SECTION USED TO DO, AND WHY IT CANNOT ANY MORE.
//
// It demonstrated a residue: `builtinMcpServer` bakes each agent's OWN path into
// the `crabcast` definition, the global file holds one value per key, so the
// SECOND agy agent's activation overwrote the FIRST's definition. Forget the
// second and the survivor is the last claimant holding a record that no longer
// describes the file, so the key is left behind. Its setup precondition
// ASSERTED THE OVERWRITE — this suite depended on the defect happening.
//
// KAN-235 removed both halves of that precondition:
//
//   - The builtin is no longer written to the shared file at all, because
//     per-agent identity in a file every agent reads is fabricated identity.
//   - Two agents whose CALLER-SUPPLIED definitions differ under one name are now
//     REFUSED rather than merged, because merging redirects the sibling's server
//     rather than sharing it.
//
// So there is no longer a route by which one CrabCast agent silently rewrites
// another's key. THE ASSERTION HAD TO INVERT: what used to be proven present is
// now proven absent, and this section is where that is on the record rather than
// quietly deleted. The residue class §6 covers — a HUMAN editing the key — is
// untouched and is still proven above; this is only about the no-human case.
const w6b = newWorld('sibling-cannot-rewrite');
const a6b = w6b.ownedDir('agent-a');
const b6b = w6b.ownedDir('agent-b');
{
  await w6b.bringUp(a6b);
  const afterA = JSON.stringify(w6b.agyServers()?.[SHARED_KEY]);
  const fileAfterA = readIfPresent(w6b.agyFile) ?? '';
  await w6b.bringUp(b6b);
  const afterB = JSON.stringify(w6b.agyServers()?.[SHARED_KEY]);
  console.log(`    the key after A activated:\n      ${afterA}`);
  console.log(`    the key after B activated:\n      ${afterB}`);

  check(
    'THE OVERWRITE NO LONGER HAPPENS. Two agy agents activate over one shared key and the ' +
      'definition is unchanged — it is the caller\'s, identical for both, so there is nothing to ' +
      'fight over',
    afterA === afterB && afterA !== 'undefined',
    `${afterA}\n        vs\n        ${afterB}`
  );
  check(
    'and NEITHER agent\'s identity is in the shared file, which is what used to differ between ' +
      'the two writes and make them collide',
    !fileAfterA.includes(a6b) && !(readIfPresent(w6b.agyFile) ?? '').includes(b6b),
    readIfPresent(w6b.agyFile)
  );

  // The claim still has two owners, so the reference count is still doing work —
  // this section proves an overwrite is absent, not that sharing is absent.
  const forgotB = await w6b.standDownAndForget(b6b);
  check('forgetting B still leaves the key — A claims it, and that has not changed',
    hasOurKey(w6b) && (forgotB.left ?? []).some((l) => l.includes(w6b.agyFile) && l.includes(a6b)),
    JSON.stringify(forgotB.left));

  const forgotA = await w6b.standDownAndForget(a6b);
  showForget('forget(A), now the last claimant:', forgotA);
  check(
    'AND THE KEY IS NOW REMOVED RATHER THAN LEFT. This is the residue closing: the last claimant ' +
      'holds a record that still describes the file, because no sibling ever rewrote it, so the ' +
      'bytes guard permits the removal it used to have to block',
    !hasOurKey(w6b),
    JSON.stringify(w6b.agyServers())
  );
  check(
    'and the file itself survives — it is the user\'s global config',
    parseIfPresent(w6b.agyFile) !== null,
    readIfPresent(w6b.agyFile)
  );
}

// ===========================================================================
section('7. A write that did NOT happen is neither disclosed nor recorded');

// THE DEFECT THAT WAS SITTING IN THE GAP. `configureAgyMcp` refuses to
// overwrite a global config it cannot parse — correctly, and it says so on the
// daemon's log. The bridge then pushed the disclosure ANYWAY, built from the
// servers the agent was CONFIGURED with rather than from anything the launcher
// reported writing. So the activation response named a file, keys and a manual
// removal for an edit nobody had made. Nothing was wrong with either half; no
// code owned the space between them.
//
// It matters more now than it did: provenance is what `forget` removes by, so a
// record written for a write that never happened would point the reversal at
// somebody else's key.
//
// THE FIRST ASSERTION HERE INVERTED IN KAN-178, and the inversion is that
// ticket's whole point rather than drift in this one. This section used to
// check that the activation STILL SUCCEEDED, with the note "this slice did not
// change who gets an agent" — true of KAN-140, which was about the reversal and
// deliberately left the refusal decision unmade. KAN-178 made it: an agy agent
// whose servers could not be written is an agent missing what it was promised,
// so the activation is REFUSED instead of started silently.
//
// What the section is FOR is unchanged, and every other check below is
// untouched: a write that did not happen must be neither disclosed nor
// recorded. That property now holds through a stronger route — nothing is
// started at all — so these assertions are the same ones asked of a refusal.
const w7 = newWorld('unparseable');
const a7 = w7.ownedDir('agent-a');
{
  const theirs = '{ these are my own agy servers and this file is not valid json';
  fs.mkdirSync(path.dirname(w7.agyFile), { recursive: true });
  fs.writeFileSync(w7.agyFile, theirs);

  const { activated } = await w7.bringUp(a7);
  console.log('    the activation response\'s disclosures:');
  console.log(block((activated?.provisioned ?? []).map((d) => `${d.artifact} ${d.file}`)));
  console.log(`    the refusal:\n      ${activated?.error}`);

  check(
    'the activation is REFUSED (KAN-178) — an agy agent whose MCP servers could not be written ' +
      'is an agent quietly missing what it was promised, and it used to start anyway',
    activated?.success === false,
    JSON.stringify({ success: activated?.success, error: activated?.error })
  );
  check(
    'and the refusal names the file, says it was NOT replaced, and says nothing was started — a ' +
      'refusal the caller cannot act on is a log line with extra steps',
    typeof activated?.error === 'string' &&
      activated.error.includes(w7.agyFile) &&
      /NOT REPLACED/i.test(activated.error) &&
      /NOTHING WAS STARTED/i.test(activated.error),
    activated?.error
  );
  check(
    'THEIR FILE WAS NOT REPLACED — it is the user\'s global config and CrabCast cannot read it',
    readIfPresent(w7.agyFile) === theirs
  );
  check(
    'and NOTHING was disclosed about it. The response used to claim a merge into a file the ' +
      'daemon had not touched: a sentence that outran its mechanism, in the disclosure whose ' +
      'entire job is to be true',
    !(activated?.provisioned ?? []).some((d) => d.artifact === 'agy-mcp-config'),
    JSON.stringify(activated?.provisioned)
  );
  check(
    'nor recorded. A provenance entry for a write that never landed would make `forget` try to ' +
      'remove a key CrabCast never wrote — which, in a shared file, is somebody else\'s',
    parseIfPresent(path.join(w7.sidecarOf(a7), 'provisioned.json'))?.agyMcp === undefined,
    JSON.stringify(parseIfPresent(path.join(w7.sidecarOf(a7), 'provisioned.json')))
  );

  const forgotten = await w7.standDownAndForget(a7);
  check(
    'and `forget` says nothing about it either — no record, no removal, and no claim to have ' +
      'cleaned up something that was never there',
    !(forgotten.removed ?? []).some((r) => r.includes(w7.agyFile)) &&
      !(forgotten.left ?? []).some((l) => l.includes(w7.agyFile)),
    JSON.stringify({ removed: forgotten.removed, left: forgotten.left })
  );
  check('their file is STILL untouched after forget', readIfPresent(w7.agyFile) === theirs);
}

// ===========================================================================
section('8. The checks above can actually fail (mutation)');

// A CHECK THAT CANNOT FAIL IS NOT A CHECK. Each mutation below backs one
// behaviour out of a COPY of the compiled daemon and asserts that the predicate
// the section above used goes red against it. Without this, every PASS above is
// consistent with the assertions being tautologies.
//
// Through `scripts/mutation.mjs` (KAN-138/KAN-170), so a mutation whose anchor
// has drifted is a counted FAIL naming what to fix rather than a throw that
// takes the rest of the file with it.
//
// WHAT THE HELPER GUARANTEES AND WHAT IT DOES NOT: it guarantees the edit
// LANDED, never that it MATTERS. So each section below asserts the property
// goes red, not merely that the mutant differs — and each carries a precondition
// that the mutant really ran, since a mutant that died on import produces the
// same observation as one that behaved.

const mutantScratch = path.join(tmp, 'mutants');
fs.mkdirSync(mutantScratch, { recursive: true });
const { mutate, mutationsSkipped } = makeMutator({
  distDir: dist,
  scratch: mutantScratch,
  report: {
    pass: (label, detail) => check(label, true, detail),
    fail: (label, detail) => check(label, false, detail)
  }
});

/** Load a mutant's provisioning module and run its removal. `null` if it died. */
async function removeWithMutant(mutantDir, options) {
  try {
    const mod = await import(path.join(mutantDir, 'provisioning.js'));
    return mod.removeProvisionedArtifacts(options);
  } catch (e) {
    return { threw: e?.message ?? String(e) };
  }
}

mutationBlindCount: {
  // §2's predicate: "the key survives while another agent claims it". Back the
  // claim out of the census — the pre-fix world, where nothing counted at all —
  // and the same predicate must go red.
  const mutant = mutate(
    'blind-refcount',
    'provisioning.js',
    'claimants.push(outcome.provenance.path);',
    'void outcome; // MUTANT: a sibling\'s claim is never recorded'
  );
  if (!mutant) break mutationBlindCount;

  // The LAST WRITER is the one forgotten, for §4's reason: its own bytes are the
  // bytes on disk, so the byte comparison permits the removal and the census is
  // the only guard the mutation has to defeat. Forgetting the first agent
  // instead would leave the key even under this mutant — the second guard would
  // hold — and the section would report a green that was about the wrong
  // mechanism.
  const w = newWorld('mutant-blind');
  const a = w.ownedDir('agent-a');
  const b = w.ownedDir('agent-b');
  await w.bringUp(a);
  await w.bringUp(b);
  check('(precondition) two agents are up and the key is there', hasOurKey(w));

  // The control, against the REAL build: agent A's claim is what holds the key.
  // Without this the red below could be a mutant removing a key that the
  // unmutated daemon would also have removed.
  const real = removeProvisionedArtifacts({
    agentPath: b,
    sidecarDir: w.sidecarOf(b),
    agentsDir: w.agentsDir
  });
  check(
    '(control) the REAL build leaves the key here, because agent A still claims it — so the red ' +
      'below is the mutation and not the scenario',
    hasOurKey(w) && (real.left ?? []).some((l) => l.includes(w.agyFile) && l.includes(a)),
    JSON.stringify(real.left)
  );

  // A fresh world, because the control above consumed B's sidecar.
  const w2 = newWorld('mutant-blind-run');
  const a2 = w2.ownedDir('agent-a');
  const b2 = w2.ownedDir('agent-b');
  await w2.bringUp(a2);
  await w2.bringUp(b2);
  await w2.invoke({ action: 'deactivate_agent', path: b2 });
  const report = await removeWithMutant(mutant, {
    agentPath: b2,
    sidecarDir: w2.sidecarOf(b2),
    agentsDir: w2.agentsDir
  });
  check('(precondition) the mutant ran rather than dying on import', report?.threw === undefined,
    report?.threw);
  check(
    "§2's property goes RED against a build whose census records no claimants: the key is " +
      'removed while agent A is still using it. That is the failure this whole slice exists to ' +
      'prevent, and seeing it here is what makes the sections above measurements',
    hasOurKey(w2) === false,
    `the key is ${hasOurKey(w2) ? 'still there — the census has stopped being what holds it' : 'gone, as a blind removal would leave it'}`
  );
  check(
    "and the mutant's report still SAYS the removal rested on a count — so a reader of the " +
      'RESPONSE could not have caught this. Only the file can, which is why these sections ' +
      'assert on the file and not on the wording',
    (report.removed ?? []).some((r) => r.includes(w2.agyFile) && /no other agent/.test(r)),
    JSON.stringify(report.removed)
  );
}

mutationUnreadable: {
  // §4's predicate: "an unreadable sibling record does not remove". Restore the
  // old collapse of unreadable-to-absent and the same predicate must go red.
  const mutant = mutate(
    'unreadable-is-no-claim',
    'provisioning.js',
    'return { unreadable: `${file} is not valid JSON (${e?.message ?? String(e)})` };',
    'return { absent: true }; // MUTANT: an unparseable record reads as "claims nothing"'
  );
  if (!mutant) break mutationUnreadable;

  // §4's scenario exactly: corrupt the OTHER agent's record and forget the last
  // writer, so the census is the only guard in the way.
  const w = newWorld('mutant-unreadable');
  const a = w.ownedDir('agent-a');
  const b = w.ownedDir('agent-b');
  await w.bringUp(a);
  await w.bringUp(b);
  const victim = path.join(w.sidecarOf(a), 'provisioned.json');
  check('(precondition) two agents are up, the key is there, and A has a record',
    hasOurKey(w) && fs.existsSync(victim));
  fs.writeFileSync(victim, '{ truncated');

  await w.invoke({ action: 'deactivate_agent', path: b });
  const report = await removeWithMutant(mutant, {
    agentPath: b,
    sidecarDir: w.sidecarOf(b),
    agentsDir: w.agentsDir
  });
  check('(precondition) the mutant ran rather than dying on import', report?.threw === undefined,
    report?.threw);
  check(
    '§4 goes RED when an unreadable record is read as "claims nothing": the key is removed out ' +
      'from under agent A on the strength of a file nobody could parse',
    hasOurKey(w) === false,
    `the key is ${hasOurKey(w) ? 'still there — §4 has stopped testing anything' : 'gone, which is the pre-fix behaviour'}`
  );
  check(
    'and the mutant reports it as an ordinary reference-counted removal — the record it could ' +
      'not read is simply absent from the count it announces',
    (report.removed ?? []).some((r) => r.includes(w.agyFile) && /no other agent/.test(r)),
    JSON.stringify(report.removed)
  );
}

mutationSilentReport: {
  // §3's predicate is about the TEXT: the report must say what the removal
  // rested on. Strip that clause and the removal still happens correctly — only
  // the sentence changes — so this mutation isolates the diagnostic from the
  // behaviour, which is what AC 3 asks for.
  const mutant = mutate(
    'report-says-only-what-happened',
    'provisioning.js',
    [
      " — removed BECAUSE no other agent's ` +",
      "        `provisioning record claimed them (${census.consulted} other record(s) read under this ` +",
      "        `daemon's data directory, all readable). The file itself is your global antigravity CLI ` +",
      '        `config and was left in place.`);'
    ].join('\n'),
    '`);'
  );
  if (!mutant) break mutationSilentReport;

  const w = newWorld('mutant-silent');
  const a = w.ownedDir('agent-a');
  await w.bringUp(a);
  check('(precondition) one agent is up and the key is there', hasOurKey(w));

  await w.invoke({ action: 'deactivate_agent', path: a });
  const report = await removeWithMutant(mutant, {
    agentPath: a,
    sidecarDir: w.sidecarOf(a),
    agentsDir: w.agentsDir
  });
  check('(precondition) the mutant ran rather than dying on import', report?.threw === undefined,
    report?.threw);
  check(
    '(precondition) the mutant still REMOVED the key — so what follows is about the sentence ' +
      'alone, not about a removal that failed',
    hasOurKey(w) === false && (report.removed ?? []).some((r) => r.includes(w.agyFile)),
    JSON.stringify(report.removed)
  );
  check(
    '§3 goes RED against a report that says only what happened: the same correct removal, ' +
      'described in a way that a reader cannot distinguish from a blind one',
    !(report.removed ?? []).some((r) => /removed BECAUSE no other agent/.test(r)),
    JSON.stringify(report.removed)
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
