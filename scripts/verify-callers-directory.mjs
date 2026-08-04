#!/usr/bin/env node
// Live proof for KAN-111: an agent's directory belongs to the CALLER, so
// everything CrabCast puts in it is opted into, merged rather than replaced,
// named in the activation response, and reversible.
//
// THE PRINCIPLE THIS EXISTS TO PROVE, stated once so the cases below read as
// answers rather than as arbitrary scenarios:
//
//   The consumer's directory is theirs; CrabCast's state lives in CrabCast's
//   directory; the only exceptions are artifacts another program will read from
//   nowhere else — and each exception is opted into, merged rather than
//   replaced, named in the activation response, and reversible.
//
// Under path identity every agent runs in a directory somebody else owns, so
// the four things activation used to write there stopped being housekeeping in
// a disposable workspace and became edits to a repository. Two of them were not
// file drops at all but PRIVILEGE CHANGES: `bypassPermissions` merged into the
// consumer's own `.claude/settings.local.json`, and a trust entry in their
// GLOBAL `~/.claude.json`.
//
// The sections map to the ticket's acceptance criteria:
//
//   1. what appears in a caller's directory — full before/after, dotfiles
//      included, plus their .claude/settings.local.json and ~/.claude.json
//   2. an existing .mcp.json is MERGED, not replaced
//   3. the trust entry is disclosed in the activation response and reversible
//   4. forget removes exactly what we wrote, reports it, leaves the rest
//   5. the resume hazard — a human's own conversation is NOT resumed
//   6. failure to provision REFUSES the activation
//   7. the checks above can actually fail (mutation)
//
// Section 5 is the one to read first. It is the criterion that would otherwise
// silently leak a human's session into an agent: Claude Code keys transcripts
// on the working directory, so anyone who has ever run it in their own
// repository has a conversation sitting at exactly the key an agent activated
// there would resume from.
//
// Everything on the daemon side is real: the real MessageRouter, the real
// HerdrBridge (initPty and all), the real provisioning, a real config through
// the real loader, a real on-disk registry. Only the external `herdr` binary is
// replaced — a shim on PATH answering in herdr's own JSON shapes and RECORDING
// every argv, so "the pane was started without --continue" is evidence rather
// than inference. $HOME is scratched, so the ~/.claude.json written here is
// this script's own.
//
// Usage:
//   npm run build
//   node scripts/verify-callers-directory.mjs [distDir]

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const section = (title) => console.log(`\n${title}\n${'='.repeat(title.length)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111-callers-'));
const realPath = process.env.PATH;
const realHome = process.env.HOME;

// A scratch $HOME. The trust entry goes into ~/.claude.json, and this script
// asserts on that file's exact contents — running against a real home would
// both read somebody's state and write to it.
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
const claudeJson = path.join(home, '.claude.json');

// ---------------------------------------------------------------------------
// The shim. Records every argv, and — unlike a pure refusal stub — makes an
// activation VERIFY, because these criteria are about the response a successful
// activation returns.
const shimState = path.join(tmp, 'shim');
const shimDir = path.join(tmp, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN111_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN111_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

// One pane id per started agent, stable across subcommands and REAL enough
// that closing it takes the agent out of the census. Without that a stand-down
// would leave the pane live in every later read, and \`forget\` would correctly
// refuse — the shim's fault, wearing the daemon's clothes.
if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.paneId, agent: 'claude', agent_status: 'working' } } });
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
    name: s.name, pane_id: s.paneId, agent: 'claude', cwd: s.cwd, agent_status: 'working'
  })) } });
}
if (a === 'pane' && b === 'close') {
  const index = started.findIndex((s) => s.paneId === args[2]);
  if (index === -1) {
    process.stderr.write(JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } }));
    process.exit(1);
  }
  // Kept under a separate key so a closed pane's command line is still
  // assertable after the stand-down.
  const closedFile = path.join(state, 'closed.json');
  const closed = fs.existsSync(closedFile) ? JSON.parse(fs.readFileSync(closedFile, 'utf8')) : [];
  closed.push(started[index]);
  fs.writeFileSync(closedFile, JSON.stringify(closed, null, 2));
  started.splice(index, 1);
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: {} });
}
if (a === 'agent' && b === 'read') out({ result: { read: { text: 'bypass permissions on\\n❯ ', truncated: false } } });
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
const { paneNameFor } = await import(path.join(dist, 'identity.js'));
const { claudeTranscriptDir } = await import(path.join(dist, 'resume.js'));
const { AGENT_LAUNCHERS } = await import(path.join(dist, 'launchers.js'));

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** Everything under a directory, dotfiles included, as sorted relative paths. */
function listing(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs).sort()) {
      const child = rel ? path.join(rel, entry) : entry;
      const stat = fs.lstatSync(path.join(dir, child));
      out.push(stat.isDirectory() ? `${child}/` : child);
      if (stat.isDirectory()) walk(child);
    }
  };
  walk('');
  return out;
}

const show = (label, rows) =>
  console.log(`    ${label}\n${rows.length ? rows.map((r) => `      ${r}`).join('\n') : '      (empty)'}`);

/** A directory the caller already owns, seeded with files that are theirs. */
function ownedDir(name, seed = {}) {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return fs.realpathSync(dir);
}

/** Forget every shim call and every started pane, so a case stands alone. */
function resetShim() {
  fs.writeFileSync(path.join(shimState, 'invocations.jsonl'), '');
  fs.writeFileSync(path.join(shimState, 'started.json'), '[]');
  fs.writeFileSync(path.join(shimState, 'closed.json'), '[]');
}
const invocations = () => {
  const file = path.join(shimState, 'invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const agentStartIssued = () => invocations().some((a) => a[0] === 'agent' && a[1] === 'start');
/**
 * The exact shell command the pane was started with. The whole truth about
 * what would have run, read back from the shim rather than from our own
 * intentions — including for a pane that has since been closed.
 */
function startedCommandFor(paneName) {
  const read = (file) => {
    const full = path.join(shimState, file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : [];
  };
  const record = [...read('started.json'), ...read('closed.json')].find((s) => s.name === paneName);
  return record ? record.command.join(' ') : null;
}

// Every session this script opens a PTY for, so none is left running. A verify
// script that leaks a process is a verify script whose next run is a flake.
const bridges = [];
let caseNumber = 0;
function newCase(seed = () => {}) {
  const agentRegistry = new AgentRegistry(path.join(tmp, `agents-${++caseNumber}.jsonl`));
  seed(agentRegistry);
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  bridges.push(bridge);
  return { agentRegistry, bridge, events: [] };
}
function invoke(deps, request) {
  return new Promise((resolve) => {
    const router = new MessageRouter({
      config,
      herdrBridge: deps.bridge,
      daemonStartedAt: new Date(),
      agentRegistry: deps.agentRegistry,
      send: (msg) => resolve(msg),
      broadcast: (msg) => deps.events.push(msg)
    });
    router.handle(request);
  });
}

/** Configure + activate, past the capacity gate (which is not this script's subject). */
async function bringUp(deps, dir, knobs) {
  const configured = await invoke(deps, { action: 'configure_agent', path: dir, ...knobs });
  if (!configured.success) return { configured, activated: null };
  const activated = await invoke(deps, { action: 'activate_agent', path: dir, override: true });
  return { configured, activated };
}

const CLAUDE = { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'claude' };

// ===========================================================================
section('1. What appears in a caller\'s directory after activation (AC 1)');

// 1a. An agent that opted into nothing. The directory must come out
//     BYTE-FOR-BYTE as it went in.
console.log('\n  1a. an agent configured with no provisioning at all');
{
  const dir = ownedDir('ac1-nothing', {
    'README.md': '# their project\n',
    'src/main.ts': 'export const theirs = true;\n',
    '.env': 'THEIR_SECRET=1\n',
    '.claude/settings.local.json': '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n'
  });
  const before = listing(dir);
  const theirSettings = fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8');
  const homeBefore = fs.existsSync(claudeJson) ? fs.readFileSync(claudeJson, 'utf8') : '(no file)';
  show('BEFORE (dotfiles included):', before);

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, CLAUDE);
  const after = listing(dir);
  show('AFTER:', after);

  check('the activation succeeded and was verified', activated.success === true && activated.verified === true,
    activated.error);
  check(
    'the directory is UNCHANGED — nothing was written into it at all',
    JSON.stringify(before) === JSON.stringify(after),
    `added: ${JSON.stringify(after.filter((f) => !before.includes(f)))}`
  );
  check(
    'no .mcp.json appeared — it is written only when the caller supplies the servers that go ' +
      'in it, which is the act that consents to it',
    !fs.existsSync(path.join(dir, '.mcp.json'))
  );
  check(
    "their own .claude/settings.local.json is byte-identical — CrabCast never writes a " +
      'permission policy into somebody\'s repository',
    fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8') === theirSettings
  );
  check('and the bootstrap prompt is in CrabCast\'s sidecar, not here',
    !fs.existsSync(path.join(dir, '.crabcast-prompt.md')));

  // The global file. It DID change — the trust entry — and that is the one
  // artifact this agent did not opt into, because without it the agent wedges
  // on a dialog nobody is there to accept. It is disclosed instead.
  console.log(`    ~/.claude.json BEFORE: ${homeBefore.trim()}`);
  console.log(`    ~/.claude.json AFTER:  ${fs.readFileSync(claudeJson, 'utf8').trim()}`);
  const claudeConfig = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  check('the ONLY thing outside the directory that changed is the folder-trust entry',
    claudeConfig.projects?.[dir]?.hasTrustDialogAccepted === true &&
      Object.keys(claudeConfig).join() === 'projects' &&
      Object.keys(claudeConfig.projects[dir]).join() === 'hasTrustDialogAccepted',
    JSON.stringify(claudeConfig));
  check(
    'and it is DISCLOSED in the activation response rather than left to be found',
    (activated.provisioned ?? []).some((a) => a.artifact === 'folder-trust' && a.file === claudeJson),
    JSON.stringify(activated.provisioned)
  );
}

// 1b. An agent that DID opt in. Exactly one file appears, and it is the one
//     that was consented to.
console.log('\n  1b. an agent that opted into .mcp.json');
{
  const dir = ownedDir('ac1-optin', { 'README.md': '# theirs\n' });
  const before = listing(dir);
  show('BEFORE:', before);

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE,
    mcpServers: { crabcast: 'builtin' }
  });
  const after = listing(dir);
  show('AFTER:', after);
  console.log('    the activation response\'s disclosure:');
  console.log(JSON.stringify(activated.provisioned, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));

  const added = after.filter((f) => !before.includes(f));
  check('exactly one file appeared, and it is the one that was opted into',
    JSON.stringify(added) === JSON.stringify(['.mcp.json']), JSON.stringify(added));
  check('every artifact is named in the activation response, with how to undo it',
    (activated.provisioned ?? []).length >= 2 &&
      activated.provisioned.every((a) => a.file && a.detail && a.reversal && a.origin));
  check('including the .mcp.json, named by absolute path',
    activated.provisioned.some((a) => a.artifact === 'mcp-config' && a.file === path.join(dir, '.mcp.json')));
}

// ===========================================================================
section('2. An existing .mcp.json is MERGED, not replaced (AC 2)');
{
  // Their file: their own server, and a top-level key that is nothing to do
  // with us. Both must survive.
  const theirs = {
    mcpServers: {
      'their-linter': { command: '/usr/bin/their-linter', args: ['--stdio'] }
    },
    somethingElseEntirely: { theyUseThis: true }
  };
  const dir = ownedDir('ac2-merge', { '.mcp.json': JSON.stringify(theirs, null, 2) + '\n' });
  console.log('    THEIR .mcp.json, before:');
  console.log(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').split('\n').map((l) => `      ${l}`).join('\n'));

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE, mcpServers: { crabcast: 'builtin' }
  });
  const merged = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  console.log('    AFTER activation:');
  console.log(JSON.stringify(merged, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));

  check('the activation succeeded', activated.success === true, activated.error);
  check('THEIR server is still there, byte-for-byte',
    JSON.stringify(merged.mcpServers['their-linter']) === JSON.stringify(theirs.mcpServers['their-linter']));
  check('OURS is there too', typeof merged.mcpServers.crabcast?.command === 'string');
  check("and their unrelated top-level key survived — the file was merged, not rebuilt from our half",
    JSON.stringify(merged.somethingElseEntirely) === JSON.stringify(theirs.somethingElseEntirely));
  check('the disclosure says it merged into an existing file rather than creating one',
    activated.provisioned.some((a) => a.artifact === 'mcp-config' && /merged into your existing/.test(a.detail)),
    JSON.stringify(activated.provisioned?.map((a) => a.detail)));

  // And forget takes only ours back out. (Stand down first: `forget` refuses a
  // running agent, deliberately and with no force flag.)
  await invoke(deps, { action: 'deactivate_agent', path: dir });
  const forgotten = await invoke(deps, { action: 'forget_agent', path: dir });
  check('forget succeeded', forgotten.success === true, forgotten.error);

  // SURVIVAL IS ASSERTED BEFORE THE FILE IS READ, and the order is the point.
  // Reading first meant a deleted file crashed this section with an ENOENT
  // before the assertion written for exactly that case ever ran: the suite went
  // red, which is the right colour, but for the wrong reason and from the wrong
  // line. "Never remove a file we did not create" would have been caught by a
  // stack trace rather than by the check that names it — and a refactor moving
  // the crash would have left the property unguarded with nothing looking
  // different.
  const mcpPath = path.join(dir, '.mcp.json');
  const survives = fs.existsSync(mcpPath);
  check(
    'the file itself survives, because CrabCast did not create it',
    survives && forgotten.success === true,
    survives ? undefined : `${mcpPath} was deleted — a file CrabCast merged into is not ours to remove`
  );

  // Guarded for the same reason: a missing file must not turn the two
  // assertions below into a crash that pre-empts them.
  const afterForget = survives ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')) : {};
  const afterServers = afterForget.mcpServers ?? {};
  check('after forget, THEIR server and THEIR key are still there',
    JSON.stringify(afterServers['their-linter']) === JSON.stringify(theirs.mcpServers['their-linter']) &&
      JSON.stringify(afterForget.somethingElseEntirely) === JSON.stringify(theirs.somethingElseEntirely),
    JSON.stringify(afterForget));
  check('and ours is gone', afterServers.crabcast === undefined, JSON.stringify(afterServers));
}

// ===========================================================================
section('3. The trust entry is disclosed and reversible (AC 3)');
{
  const dir = ownedDir('ac3-trust', { 'README.md': '# theirs\n' });
  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, CLAUDE);

  const disclosure = (activated.provisioned ?? []).find((a) => a.artifact === 'folder-trust');
  console.log('    the activation response, on the trust entry:');
  console.log(JSON.stringify(disclosure, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));

  check('the response names the FILE it was written to', disclosure?.file === claudeJson);
  check('and the exact KEY, as a human would look for it',
    /hasTrustDialogAccepted/.test(disclosure?.detail ?? '') && (disclosure?.detail ?? '').includes(dir),
    disclosure?.detail);
  check('it says the entry is OUTSIDE the agent\'s directory, which is the part that surprises',
    /OUTSIDE/.test(disclosure?.detail ?? '') || /global/.test(disclosure?.detail ?? ''));
  check('it says CrabCast wrote it', disclosure?.origin === 'crabcast');
  check('and it says how to remove it', /forget/.test(disclosure?.reversal ?? ''), disclosure?.reversal);
  check('the entry really is on disk',
    JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects?.[dir]?.hasTrustDialogAccepted === true);

  // The reversal.
  await invoke(deps, { action: 'deactivate_agent', path: dir });
  const forgotten = await invoke(deps, { action: 'forget_agent', path: dir });
  console.log('    forget:');
  console.log(JSON.stringify(forgotten, null, 2)
    .split('\n').map((l) => `      ${l}`).join('\n'));
  const afterConfig = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  check('after forget, the trust entry is GONE', afterConfig.projects?.[dir] === undefined,
    JSON.stringify(afterConfig));
  check('and forget reported removing it by name',
    (forgotten.removed ?? []).some((r) => r.includes(claudeJson) && r.includes('hasTrustDialogAccepted')),
    JSON.stringify(forgotten.removed));

  // The other direction, which is the one that keeps forget honest: an entry
  // the human accepted THEMSELVES is theirs and is never removed.
  const mine = ownedDir('ac3-preexisting', { 'README.md': '# theirs\n' });
  const preexisting = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  preexisting.projects = { ...preexisting.projects, [mine]: { hasTrustDialogAccepted: true, theirOtherKey: 7 } };
  fs.writeFileSync(claudeJson, JSON.stringify(preexisting, null, 2));

  const deps2 = newCase();
  resetShim();
  const second = await bringUp(deps2, mine, CLAUDE);
  const theirDisclosure = (second.activated.provisioned ?? []).find((a) => a.artifact === 'folder-trust');
  check('an entry the human accepted themselves is disclosed as NOT ours',
    theirDisclosure?.origin === 'preexisting', JSON.stringify(theirDisclosure));
  check('and its "reversal" says there is nothing to undo rather than offering one',
    /nothing to undo/.test(theirDisclosure?.reversal ?? ''), theirDisclosure?.reversal);

  await invoke(deps2, { action: 'deactivate_agent', path: mine });
  const forgot2 = await invoke(deps2, { action: 'forget_agent', path: mine });
  const stillThere = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  check('forget LEAVES it — removing it would take away something we never gave',
    stillThere.projects?.[mine]?.hasTrustDialogAccepted === true &&
      stillThere.projects[mine].theirOtherKey === 7);
  check('and says so, with the reason',
    (forgot2.left ?? []).some((l) => l.includes('already there before CrabCast')),
    JSON.stringify(forgot2.left));
}

// ===========================================================================
section('4. forget removes exactly what we wrote, and nothing else (AC 4)');
{
  const dir = ownedDir('ac4-forget', {
    'README.md': '# their project\n',
    'src/main.ts': 'export const theirs = true;\n',
    '.env': 'THEIR_SECRET=1\n',
    '.gitignore': 'node_modules\n'
  });
  // A git working tree, so the exclude-line artifact is exercised too.
  execSync('git init -q && git config user.email v@v && git config user.name v', { cwd: dir });
  const before = listing(dir).filter((f) => !f.startsWith('.git/'));
  show('BEFORE (their files; .git/ internals elided):', before);

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE, mcpServers: { crabcast: 'builtin' }
  });
  const during = listing(dir).filter((f) => !f.startsWith('.git/'));
  show('WITH THE AGENT RUNNING:', during);
  const excludeFile = path.join(dir, '.git', 'info', 'exclude');
  check('.mcp.json was created', fs.existsSync(path.join(dir, '.mcp.json')));
  check('and excluded from their git status, so it is not a spurious untracked change',
    fs.existsSync(excludeFile) && fs.readFileSync(excludeFile, 'utf8').split('\n').some((l) => l.trim() === '.mcp.json'));
  check('git agrees it is ignored — asserted against git itself, not against our own write',
    execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).includes('.mcp.json') === false,
    execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim());

  const sidecar = path.join(dataDir, 'agents', fs.readdirSync(path.join(dataDir, 'agents'))
    .find((h) => fs.existsSync(path.join(dataDir, 'agents', h, 'provisioned.json')) &&
      JSON.parse(fs.readFileSync(path.join(dataDir, 'agents', h, 'provisioned.json'), 'utf8')).path === dir));

  await invoke(deps, { action: 'deactivate_agent', path: dir });
  const forgotten = await invoke(deps, { action: 'forget_agent', path: dir });
  console.log('    forget:');
  console.log(JSON.stringify(forgotten, null, 2)
    .split('\n').map((l) => `      ${l}`).join('\n'));
  const after = listing(dir).filter((f) => !f.startsWith('.git/'));
  show('AFTER forget:', after);

  check('the directory is back exactly as it was', JSON.stringify(before) === JSON.stringify(after),
    `difference: ${JSON.stringify(after.filter((f) => !before.includes(f)))}`);
  check('every one of their files is still there and unread-modified',
    fs.readFileSync(path.join(dir, '.env'), 'utf8') === 'THEIR_SECRET=1\n' &&
      fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8') === 'export const theirs = true;\n');
  check('THE DIRECTORY ITSELF IS UNTOUCHED — CrabCast never created one, so it never deletes one',
    fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  check('their git repository is intact', fs.existsSync(path.join(dir, '.git', 'HEAD')));
  // Existence asserted before the read, for the same reason as §2: a cleanup
  // that deleted the caller's whole exclude file rather than one line from it
  // must fail THIS check, not crash before reaching it.
  const excludeSurvives = fs.existsSync(excludeFile);
  check('their exclude file itself survives — we added a line to it, not created it',
    excludeSurvives, excludeFile);
  check('and our exclude line is gone from it',
    excludeSurvives &&
      !fs.readFileSync(excludeFile, 'utf8').split('\n').some((l) => l.trim() === '.mcp.json'));
  check('CrabCast\'s own sidecar is gone too — it is ours, inside our own data dir',
    !fs.existsSync(sidecar), sidecar);
  check('forget REPORTED what it removed rather than doing it silently',
    (forgotten.removed ?? []).length >= 3 && forgotten.removed.includes('record'),
    JSON.stringify(forgotten.removed));
  check('and left nothing behind unexplained', (forgotten.left ?? []).length === 0,
    JSON.stringify(forgotten.left));

  // The rule that keeps this from being a delete-everything-we-touched: a key
  // edited since we wrote it is somebody's change, and is left alone.
  const edited = ownedDir('ac4-edited', {});
  const deps2 = newCase();
  resetShim();
  await bringUp(deps2, edited, { ...CLAUDE, mcpServers: { crabcast: 'builtin' } });
  const mcpFile = path.join(edited, '.mcp.json');
  const tampered = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  tampered.mcpServers.crabcast.args = ['/somebody/changed/this.js'];
  fs.writeFileSync(mcpFile, JSON.stringify(tampered, null, 2));

  await invoke(deps2, { action: 'deactivate_agent', path: edited });
  const forgot = await invoke(deps2, { action: 'forget_agent', path: edited });
  check(
    'a server key EDITED since CrabCast wrote it is left in place — removing it would destroy ' +
      "somebody's change rather than undo ours",
    fs.existsSync(mcpFile) &&
      JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.crabcast?.args[0] === '/somebody/changed/this.js'
  );
  check('and forget says so, with the reason',
    (forgot.left ?? []).some((l) => /edited since CrabCast wrote it/.test(l)),
    JSON.stringify(forgot.left));

  // AND IT DOES NOT REWRITE THE FILE IT TOOK NOTHING OUT OF. Found by reading
  // the removal path rather than by a failing case: when every recorded key
  // turns out to be edited or already gone, the cleanup used to fall through to
  // the write anyway and re-serialize the caller's file — reformatting it,
  // collapsing its whitespace — on a `forget` that removed none of its content.
  // A cleanup that leaves a diff behind is the thing this whole file exists to
  // avoid, so the bytes are asserted rather than the keys.
  const untouched = ownedDir('ac4-untouched', {});
  const deps3 = newCase();
  resetShim();
  await bringUp(deps3, untouched, { ...CLAUDE, mcpServers: { crabcast: 'builtin' } });
  const untouchedFile = path.join(untouched, '.mcp.json');
  // Their own formatting: four-space indent, their key order, a trailing blank
  // line — none of which a re-serialize would preserve.
  const theirFormatting =
    '{\n    "mcpServers": {\n        "crabcast": { "command": "THEIRS NOW" }\n    }\n}\n\n';
  fs.writeFileSync(untouchedFile, theirFormatting);
  await invoke(deps3, { action: 'deactivate_agent', path: untouched });
  await invoke(deps3, { action: 'forget_agent', path: untouched });
  check(
    'a forget that removes nothing from the file leaves it BYTE-IDENTICAL, formatting and all',
    fs.readFileSync(untouchedFile, 'utf8') === theirFormatting,
    JSON.stringify(fs.readFileSync(untouchedFile, 'utf8'))
  );
}

// ===========================================================================
section('5. THE RESUME HAZARD IS CLOSED (AC 5)');

// THE BUG. Claude Code keys transcripts on the working directory, so a human
// who has ever run `claude` in their own repository has a conversation of
// THEIRS at exactly the key an agent activated there would resume from. The
// launcher's command was `claude --continue || claude <prompt>` unconditionally
// — so the FIRST activation in their directory would restore their session into
// an agent pane and then nudge it to carry on with work it never started.
{
  const dir = ownedDir('ac5-their-conversation', { 'README.md': '# theirs\n' });

  // A human's own prior conversation, at the path, in Claude Code's own layout.
  const transcripts = claudeTranscriptDir(dir);
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, 'a-humans-session.jsonl'),
    JSON.stringify({ type: 'user', message: 'my private notes about the salary review' }) + '\n');
  console.log(`    a human's conversation is on disk at:\n      ${transcripts}/a-humans-session.jsonl`);

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, CLAUDE);
  const command = startedCommandFor(paneNameFor(dir));
  console.log(`    the command the pane was actually started with:\n      ${command}`);

  check('the activation succeeded', activated.success === true, activated.error);
  check(
    'THE PANE WAS STARTED WITHOUT --continue — asserted against the herdr shim\'s own recorded ' +
      "argv, so it is what would have run rather than what we meant to run",
    command !== null && !command.includes('--continue'),
    command
  );
  check("and the human's transcript was not read, moved or touched",
    fs.readFileSync(path.join(transcripts, 'a-humans-session.jsonl'), 'utf8').includes('salary review'));
  check('the response says so in words: a NEW conversation was started',
    activated.resumedExistingConversation === false);

  // And the other half of the rule: once CrabCast HAS run here, the
  // conversation is its own and resuming is right.
  await invoke(deps, { action: 'deactivate_agent', path: dir });
  resetShim();
  const second = await invoke(deps, { action: 'activate_agent', path: dir, override: true });
  const secondCommand = startedCommandFor(paneNameFor(dir));
  console.log(`    the SECOND activation's command:\n      ${secondCommand}`);
  check(
    'the second activation DOES resume — the rule is "has CrabCast run here", not "never resume"',
    secondCommand !== null && secondCommand.includes('--continue'),
    secondCommand
  );
  check('and says so', second.resumedExistingConversation === true);

  // A never-run agent has no conversation to restore, which is the same
  // question asked about the other half of the fleet (T3's unstartedAgents).
  const unstarted = ownedDir('ac5-unstarted', {});
  const deps3 = newCase((reg) => reg.recordConfigured({ path: unstarted, config: CLAUDE }));
  check('a configured-but-never-run agent has no prior activation on its record',
    deps3.agentRegistry.ranBefore(unstarted) === false);

  // And the marker survives compaction, which is where it would otherwise be
  // lost silently — in the safe direction, which is why nobody would notice.
  const compacted = ownedDir('ac5-compaction', {});
  const reg = new AgentRegistry(path.join(tmp, 'compaction.jsonl'));
  reg.recordConfigured({ path: compacted, config: CLAUDE });
  reg.recordActivated({ path: compacted, config: CLAUDE });
  reg.recordDeactivated({ path: compacted, config: CLAUDE });
  reg.compact();
  check(
    'everActivated survives compaction — a stood-down agent that HAS run must not be turned ' +
      'into a never-run one by housekeeping',
    reg.ranBefore(compacted) === true
  );
  const rows = fs.readFileSync(path.join(tmp, 'compaction.jsonl'), 'utf8').trim().split('\n');
  check('and it is on the carried row rather than re-derived from history that is now gone',
    rows.length === 1 && JSON.parse(rows[0]).everActivated === true, rows.join(' | '));
}

// ===========================================================================
section('6. Failure to provision REFUSES the activation (AC 6)');

// KAN-84's lesson: a swallowed prompt-file write once let an uninstructed agent
// start behind `verified: true`. Every provisioning failure here refuses.

console.log('\n  6a. an unparseable .mcp.json of the caller\'s');
{
  const junk = '{ this is not json, it is their notes file for some reason';
  const dir = ownedDir('ac6-unparseable', { '.mcp.json': junk });
  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE, mcpServers: { crabcast: 'builtin' }
  });
  check('the activation is REFUSED', activated.success === false);
  check('and NO agent was started — asserted against the shim\'s argv log',
    agentStartIssued() === false, JSON.stringify(invocations()));
  check('THEIR FILE WAS NOT REPLACED — this is the behaviour that changed',
    fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8') === junk);
  check('the refusal says the file was not replaced, rather than just failing',
    /NOT REPLACED/i.test(activated.error ?? ''), activated.error);
}

console.log('\n  6b. a server key that is already theirs');
{
  const theirs = { mcpServers: { crabcast: { command: '/their/own/crabcast-thing' } } };
  const dir = ownedDir('ac6-collision', { '.mcp.json': JSON.stringify(theirs, null, 2) });
  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE, mcpServers: { crabcast: 'builtin' }
  });
  check('the activation is REFUSED rather than taking the key over', activated.success === false);
  check('their definition is untouched',
    JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.crabcast.command ===
      '/their/own/crabcast-thing');
  check('and the refusal names the colliding server', /'crabcast'/.test(activated.error ?? ''),
    activated.error);
  check('no agent was started', agentStartIssued() === false);

  // THE SIBLING OF THE `__proto__` BUG, and the one that destroys THEIR data
  // rather than losing ours. Found by probing for relatives of the round-1
  // blocker rather than by anything failing.
  //
  // The guard above asked "have we written this key before?" as
  // `priorKeys[key] === undefined`. For a server named `toString` — or
  // `constructor`, `valueOf`, `hasOwnProperty` — that lookup inherits a
  // function from Object.prototype, so it is never `undefined`, so the key
  // answered as OURS and was silently overwritten. Exactly backwards: the
  // caller's own server, taken over by the guard written to prevent that.
  const theirsNamedToString = { mcpServers: { toString: { command: '/their/own/thing' } } };
  const protoDir = ownedDir('ac6-collision-prototype', {
    '.mcp.json': JSON.stringify(theirsNamedToString, null, 2)
  });
  const protoDeps = newCase();
  resetShim();
  const protoRes = await bringUp(protoDeps, protoDir, {
    ...CLAUDE,
    // Built through JSON.parse for the same reason §8's cases are: a literal
    // here would not faithfully carry a prototype-shaped key.
    mcpServers: JSON.parse('{"toString": {"command": "/ours"}}')
  });
  check(
    "a server named `toString` that is ALREADY THEIRS is refused, not taken over — the " +
      'prototype family blinds a membership test written as `map[key] === undefined`',
    protoRes.activated.success === false,
    JSON.stringify(protoRes.activated).slice(0, 240)
  );
  check(
    'and THEIR definition is untouched on disk',
    JSON.parse(fs.readFileSync(path.join(protoDir, '.mcp.json'), 'utf8'))
      .mcpServers.toString.command === '/their/own/thing'
  );
  check('nothing was started for it', agentStartIssued() === false);
}

console.log('\n  6c. a server CrabCast cannot supply — FEWER SERVERS THAN REQUESTED (KAN-121)');
{
  // THE DEFECT THIS IS ABOUT, and it was three defensible steps composing into
  // a guard that read as a check and was not one:
  //
  //   config validated `mcpServers` as "an array of strings" and no further;
  //   the resolver kept the one name it recognised and DROPPED the rest without
  //   a word; and the write early-returned on the resulting empty map, so no
  //   file appeared at all. `{"mcpServers": ["atlassian"]}` therefore produced
  //   a running agent, with no tools, no .mcp.json, and `success: true`.
  const dir = ownedDir('ac6-unsupplied', {});
  const deps = newCase();
  resetShim();
  const configured = await invoke(deps, {
    action: 'configure_agent', path: dir, ...CLAUDE,
    // Two servers. One CrabCast can build; one it has never heard of.
    mcpServers: { crabcast: 'builtin', atlassian: 'builtin' }
  });
  check('configure REFUSES rather than keeping the half it understood',
    configured.success === false);
  check('and names the one it cannot supply', /'atlassian'/.test(configured.error ?? ''),
    configured.error);
  check('while telling the caller what to send instead — a definition, not a name',
    /"command"/.test(configured.error ?? ''));
  check('no record was created — configure is all-or-nothing',
    deps.agentRegistry.intents().size === 0);
  check('and nothing was written to the directory', listing(dir).length === 0);

  // The same shortfall reaching the BRIDGE from a record on disk. This is the
  // frame where the old early-return lived, and where "asked for nothing" and
  // "the request was dropped one frame earlier" used to be indistinguishable.
  const deps2 = newCase((reg) => reg.recordConfigured({
    path: dir, config: { ...CLAUDE, mcpServers: { crabcast: 'builtin', atlassian: 'builtin' } }
  }));
  resetShim();
  const activated = await invoke(deps2, { action: 'activate_agent', path: dir, override: true });
  check('the bridge refuses it too — a record from disk cannot slip past the first gate',
    activated.success === false, activated.error);
  check(
    'NO `agent start` was issued — asserted against the herdr shim\'s own argv log, so ' +
      '"fewer servers than requested never starts an agent" is evidence rather than inference',
    agentStartIssued() === false,
    `herdr calls: ${JSON.stringify(invocations())}`
  );
  check(
    'and NO PARTIAL .mcp.json was left behind: a file holding only what could be written is a ' +
      'file whose PRESENCE LOOKS LIKE SUCCESS',
    !fs.existsSync(path.join(dir, '.mcp.json'))
  );
  check('the refusal says why a partial file would be worse than none',
    /looks like success/i.test(activated.error ?? ''), activated.error);

  // And the distinction the old early-return could not draw: asking for
  // NOTHING is not the same as having your request dropped.
  const none = ownedDir('ac6-asked-for-nothing', {});
  const deps3 = newCase();
  resetShim();
  const fine = await bringUp(deps3, none, CLAUDE);
  check(
    'an agent that asked for NO servers starts normally — the empty case is still the empty ' +
      'case, which is the half of the old early-return that was always correct',
    fine.activated.success === true && agentStartIssued() === true,
    fine.activated.error
  );
  check('and writes no .mcp.json', !fs.existsSync(path.join(none, '.mcp.json')));
}

console.log('\n  6d. the directory cannot be written to at all');
{
  const dir = ownedDir('ac6-readonly', {});
  fs.chmodSync(dir, 0o500);
  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, {
    ...CLAUDE, mcpServers: { crabcast: 'builtin' }
  });
  fs.chmodSync(dir, 0o755);
  check('the activation is REFUSED rather than starting an agent missing its servers',
    activated.success === false, JSON.stringify(activated).slice(0, 300));
  check('nothing was started', agentStartIssued() === false);
  check('and the refusal says nothing was started, in the response as well as the message',
    /NOTHING WAS STARTED/i.test(activated.error ?? ''), activated.error);
}

// ===========================================================================
section('7. Definitions are written through byte-for-byte (KAN-120)');

// WHY DEFINITIONS AND NOT NAMES. A consumer assembles their server set at
// activation time from whichever integrations are enabled AND hold a valid
// credential — runtime state on their side of the boundary. A name is not a
// thing they can send, because there is nothing here for it to name.
//
// So the promise is exact: whatever JSON arrives under a key is the JSON that
// appears in the file. Nothing resolved, renamed or reordered. This case sends
// a definition designed to break a daemon that quietly normalises anything.
{
  const dir = ownedDir('ac7-verbatim', {});
  const theirDefinition = {
    // Deliberately awkward: a command with spaces, args carrying quotes,
    // braces, a doubled-brace sequence that a template engine would eat, unicode
    // and a trailing empty string; env with an empty value and a key whose case
    // a normaliser would flatten; and unknown top-level fields CrabCast has no
    // opinion about.
    command: '/opt/their tools/bin/mcp server',
    args: [
      '--config={"nested":"json","q":"a \\"quoted\\" thing"}',
      "--filter='single quoted'",
      '--template={{KEY}}',
      '--unicode=café→🦀',
      '--trailing-space= ',
      ''
    ],
    env: { Their_Mixed_Case: 'kept', EMPTY: '', WITH_NEWLINE: 'a\nb' },
    somethingCrabcastHasNeverHeardOf: { deeply: { nested: [1, 2, { three: true }] } },
    cwd: '/their/place'
  };
  // Two more, to prove ORDER survives: a map's keys come out in the order they
  // went in, so a daemon that rebuilt or sorted the map would show here.
  const supplied = {
    zzz_last: { command: 'z' },
    atlassian: theirDefinition,
    aaa_first: { command: 'a' },
    crabcast: 'builtin'
  };
  console.log('    the definition supplied for `atlassian`:');
  console.log(JSON.stringify(theirDefinition, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));

  const deps = newCase();
  resetShim();
  const { activated } = await bringUp(deps, dir, { ...CLAUDE, mcpServers: supplied });
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  console.log('    what appeared in .mcp.json for `atlassian`:');
  console.log(JSON.stringify(written.mcpServers.atlassian, null, 2).split('\n').map((l) => `      ${l}`).join('\n'));

  check('the activation succeeded', activated.success === true, activated.error);
  check(
    'the definition is byte-for-byte what was supplied — nothing resolved, renamed or dropped, ' +
      'including fields CrabCast has never heard of',
    JSON.stringify(written.mcpServers.atlassian) === JSON.stringify(theirDefinition),
    JSON.stringify(written.mcpServers.atlassian)
  );
  check(
    'the KEY ORDER of the map survives — a daemon that rebuilt or sorted it would show here',
    JSON.stringify(Object.keys(written.mcpServers)) ===
      JSON.stringify(['zzz_last', 'atlassian', 'aaa_first', 'crabcast']),
    JSON.stringify(Object.keys(written.mcpServers))
  );
  check(
    'the one entry CrabCast builds itself IS built — and it bakes in this daemon\'s config path, ' +
      'which is why a caller could not have written it',
    written.mcpServers.crabcast?.env?.CRABCAST_CONFIG === configPath,
    JSON.stringify(written.mcpServers.crabcast)
  );
  check("the doubled-brace sequence survived — nothing here interpolates anything",
    written.mcpServers.atlassian.args.includes('--template={{KEY}}'));

  // Order also survives the round trip through the durable record, which is
  // where a reconfigure or a restart would read it from.
  const stored = deps.agentRegistry.intents().get(dir)?.record.config.mcpServers;
  check('and survives the durable record, which is what a restart reads back',
    JSON.stringify(stored) === JSON.stringify(supplied));
}

// ===========================================================================
section('8. The opt-in and the definitions are ONE decision');

// THE INTERACTION THAT MADE THIS URGENT. An opt-in defaulting off, plus a
// definitions change landing separately, would produce a fleet of agents with
// no tools and nothing anywhere saying why — at cutover, across every agent at
// once, for a consumer whose agents reach their issue tracker THROUGH MCP.
//
// The resolution is structural rather than careful: supplying `mcpServers` IS
// the consent. There is no second field, so there is no path where definitions
// are supplied and silently not written.
{
  const dir = ownedDir('ac8-one-call', {});
  const deps = newCase();
  resetShim();

  // THE SINGLE CALL a consumer makes. One configure, one activate, no flag.
  const configured = await invoke(deps, {
    action: 'configure_agent', path: dir, ...CLAUDE,
    mcpServers: { atlassian: { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'] } }
  });
  console.log('    configure — the ONLY call carrying consent, and it carries the definitions:');
  console.log(JSON.stringify({ willWrite: configured.willWrite }, null, 2)
    .split('\n').map((l) => `      ${l}`).join('\n'));

  check('configure succeeds with no consent flag anywhere in the call', configured.success === true,
    configured.error);
  check(
    'and the response NAMES the file and keys it will write, before anything is written — this ' +
      'is what replaces the flag: the caller is told the consequence rather than asked to assert it',
    Array.isArray(configured.willWrite) &&
      configured.willWrite[0]?.file === path.join(dir, '.mcp.json') &&
      configured.willWrite[0]?.keys.includes('atlassian'),
    JSON.stringify(configured.willWrite)
  );

  const activated = await invoke(deps, { action: 'activate_agent', path: dir, override: true });
  check('and activation writes them, with no second step',
    activated.success === true &&
      JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.atlassian?.command === 'npx',
    activated.error);

  // THE PROOF THAT THERE IS NO SILENT PATH. Exhaustive rather than
  // illustrative: every outcome of supplying definitions is enumerated, and
  // "written" and "refused" are the only two.
  const outcomes = [];
  const attempt = async (label, servers, seed = {}) => {
    const at = ownedDir(`ac8-${label}`, seed);
    const d = newCase();
    resetShim();
    const c = await invoke(d, { action: 'configure_agent', path: at, ...CLAUDE, mcpServers: servers });
    if (!c.success) return outcomes.push({ label, outcome: 'REFUSED at configure' });
    const a = await invoke(d, { action: 'activate_agent', path: at, override: true });
    if (!a.success) return outcomes.push({ label, outcome: 'REFUSED at activate' });
    const file = path.join(at, '.mcp.json');
    const on = fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {}) : [];
    const asked = Object.keys(servers);
    outcomes.push({
      label,
      outcome: asked.every((k) => on.includes(k)) ? 'WRITTEN, all of them' : `STARTED with only ${on.join(', ')}`
    });
  };

  await attempt('their-definition', { atlassian: { command: 'npx', args: [] } });
  await attempt('builtin', { crabcast: 'builtin' });
  await attempt('both', { crabcast: 'builtin', atlassian: { command: 'npx', args: [] } });
  await attempt('unknown-builtin', { atlassian: 'builtin' });
  await attempt('into-their-file', { atlassian: { command: 'npx', args: [] } },
    { '.mcp.json': JSON.stringify({ mcpServers: { theirs: { command: 't' } } }) });
  await attempt('into-their-broken-file', { atlassian: { command: 'npx', args: [] } },
    { '.mcp.json': 'not json' });

  // PROTOTYPE-SHAPED NAMES. This enumeration read as exhaustive and was not:
  // a server named `__proto__` assigned into an ordinary object literal hits
  // Object.prototype's setter, stores nothing, throws nothing, and the request
  // simply loses the key. The whole chain then behaved impeccably about a
  // definition it could no longer see — `configure` succeeded with an empty
  // `willWrite`, the record stored `{}`, `activate` succeeded, and `agent
  // start` was issued for an agent with no tools.
  //
  // An enumeration that misses a case is worse than an illustration, because
  // it reads as exhaustive. So the case is in the enumeration now, and the two
  // NON-dropping prototype names are here beside it — `constructor` and
  // `hasOwnProperty` round-trip through a plain literal correctly, so the fix
  // has to be structural rather than a special case for the one name a reader
  // happened to think of.
  //
  // Built through JSON.parse rather than as a literal, and that is not a
  // detail: `{ __proto__: … }` written in THIS file would lose the key before
  // the request was even sent, and the case would silently become a different,
  // weaker one. JSON.parse creates it as an own property, which is also
  // exactly what the real socket path does.
  const parsed = (text) => JSON.parse(text);
  await attempt('proto-shaped-alone',
    parsed('{"__proto__": {"command": "npx", "args": []}}'));
  await attempt('proto-shaped-mixed',
    parsed('{"__proto__": {"command": "npx"}, "atlassian": {"command": "npx"}}'));
  await attempt('constructor-named',
    parsed('{"constructor": {"command": "npx", "args": []}}'));
  await attempt('hasownproperty-named',
    parsed('{"hasOwnProperty": {"command": "npx", "args": []}}'));

  console.log('    every way of supplying definitions, and what happened:');
  for (const o of outcomes) console.log(`      ${o.label.padEnd(22)} ${o.outcome}`);

  check(
    'EVERY path either writes all of them or refuses — there is no outcome where definitions ' +
      'are supplied and an agent starts without them',
    outcomes.every((o) => o.outcome === 'WRITTEN, all of them' || o.outcome.startsWith('REFUSED')),
    JSON.stringify(outcomes)
  );
  check(
    'and the enumeration is not vacuous: it contains both outcomes, so "no silent path" is a ' +
      'result rather than an artefact of only trying the happy cases',
    outcomes.some((o) => o.outcome.startsWith('REFUSED')) &&
      outcomes.some((o) => o.outcome === 'WRITTEN, all of them'),
    JSON.stringify(outcomes.map((o) => o.outcome))
  );
}

// ===========================================================================
section('9. The checks above can actually fail (mutation)');

// A CHECK THAT CANNOT FAIL IS NOT A CHECK, and this suite keeps relearning it.
// Each mutation below reconstructs the state the PRE-FIX code would have
// produced and asserts the same predicate the section above used goes red on
// it. Without this, every PASS above is consistent with the assertions being
// tautologies.

{
  // 5's predicate: "the started command contains no --continue". Fed the
  // command the old unconditional launcher built, it must go red.
  const oldStyle = AGENT_LAUNCHERS.claude.command({ promptCommand: 'go', mayResume: true });
  check(
    'the resume check goes RED against the command the pre-fix launcher built',
    oldStyle.includes('--continue') === true,
    `if this line ever reads "no --continue", section 5 has stopped testing anything: ${oldStyle}`
  );
}

{
  // 2's, 4's and 7's predicates, exercised against artifacts REAL CODE
  // produced — not against literals written two lines up.
  //
  // WHY THIS BLOCK WAS REWRITTEN, since it is the more interesting half. The
  // first version of these three "mutations" compared two script-local literals
  // to each other and imported nothing from `dist`. They were green, they
  // looked like mutation tests, and they proved nothing: §9 exists to show that
  // §2/§4/§7 are not tautologies, and for these three the proof was itself one.
  // The properties did hold — mutating the production code really did turn
  // those sections red — but a proof that a proof means something has to run
  // the thing it is talking about.
  //
  // So each predicate below is applied to output from the REAL
  // `provisionMcpConfig` and the REAL `listing()`, under conditions where it
  // must come back false.
  const { provisionMcpConfig } = await import(path.join(dist, 'provisioning.js'));

  // 2's predicate: "their server survived the merge". Provision into a
  // directory that never had their server; the same predicate must say so.
  const noTheirs = ownedDir('mutation-merge', {});
  provisionMcpConfig({
    agentPath: noTheirs,
    sidecarDir: path.join(tmp, 'mutation-merge-sidecar'),
    definitions: { crabcast: { command: 'node' } }
  });
  const merged = JSON.parse(fs.readFileSync(path.join(noTheirs, '.mcp.json'), 'utf8'));
  check(
    'the merge check goes RED on a real written file that does not carry their server — the ' +
      'predicate discriminates rather than always agreeing',
    merged.mcpServers['their-linter'] === undefined && merged.mcpServers.crabcast !== undefined,
    JSON.stringify(merged.mcpServers)
  );

  // 4's predicate: "the directory came back exactly as it was", over the same
  // `listing()` §4 uses. A real provisioning write must make it false.
  const residueDir = ownedDir('mutation-residue', { 'README.md': '# theirs\n' });
  const beforeReal = listing(residueDir);
  provisionMcpConfig({
    agentPath: residueDir,
    sidecarDir: path.join(tmp, 'mutation-residue-sidecar'),
    definitions: { crabcast: { command: 'node' } }
  });
  const afterReal = listing(residueDir);
  check(
    'the residue check goes RED against a directory a real write left a file in',
    JSON.stringify(beforeReal) !== JSON.stringify(afterReal),
    `${JSON.stringify(beforeReal)} vs ${JSON.stringify(afterReal)}`
  );

  // 7's predicate: "the written definition equals the supplied one". Provision
  // one definition, then compare the REAL written bytes against both it and a
  // normalised version — the predicate must agree with one and not the other.
  const verbatimDir = ownedDir('mutation-verbatim', {});
  const suppliedDef = { command: 'x', args: [], somethingCrabcastHasNeverHeardOf: { a: 1 } };
  provisionMcpConfig({
    agentPath: verbatimDir,
    sidecarDir: path.join(tmp, 'mutation-verbatim-sidecar'),
    definitions: { theirs: suppliedDef }
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(verbatimDir, '.mcp.json'), 'utf8'))
    .mcpServers.theirs;
  const normalised = { command: 'x', args: [] };
  check(
    'the verbatim check AGREES with the real written file and DISAGREES with a normalised ' +
      'version of it — both directions, so it measures the file rather than always passing',
    JSON.stringify(onDisk) === JSON.stringify(suppliedDef) &&
      JSON.stringify(onDisk) !== JSON.stringify(normalised),
    JSON.stringify(onDisk)
  );
}

{
  // 6c's predicate: "no `agent start` was issued". The argv log is what makes
  // that evidence rather than inference, so the detector itself is exercised
  // here — against an activation deliberately allowed to succeed. Without this,
  // a reader that never saw anything would make every "nothing was started"
  // above pass for the wrong reason.
  //
  // Self-contained on purpose: reading whatever the previous section happened
  // to leave in the log would make this check depend on the order the cases ran
  // in, which is exactly the kind of accident it exists to rule out.
  const started = ownedDir('mutation-really-starts', {});
  const deps = newCase();
  resetShim();
  check('the argv log reads EMPTY before anything is activated', agentStartIssued() === false);
  await bringUp(deps, started, CLAUDE);
  check(
    'and reads `agent start` once something really was started — so every "nothing was started" ' +
      'above is a measurement rather than a reader that never sees anything',
    agentStartIssued() === true,
    `herdr calls: ${JSON.stringify(invocations())}`
  );

  // 3's predicate, and the sharpest one: forget must remove OUR trust entry and
  // leave a pre-existing one. A removal that ignored provenance would take both
  // — so the check has to distinguish them, and here it is fed both.
  const { removeProvisionedArtifacts, writeProvenance } = await import(path.join(dist, 'provisioning.js'));
  const file = path.join(tmp, 'mutation-claude.json');
  const oursPath = path.join(tmp, 'mutation-ours');
  const theirsPath = path.join(tmp, 'mutation-theirs');
  fs.mkdirSync(oursPath, { recursive: true });
  fs.mkdirSync(theirsPath, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    projects: {
      [oursPath]: { hasTrustDialogAccepted: true },
      [theirsPath]: { hasTrustDialogAccepted: true }
    }
  }, null, 2));

  const sidecarOurs = path.join(tmp, 'mutation-sidecar-ours');
  const sidecarTheirs = path.join(tmp, 'mutation-sidecar-theirs');
  writeProvenance(sidecarOurs, {
    v: 1, path: oursPath,
    trust: { file, key: 'projects[…].hasTrustDialogAccepted', origin: 'crabcast' }
  });
  writeProvenance(sidecarTheirs, {
    v: 1, path: theirsPath,
    trust: { file, key: 'projects[…].hasTrustDialogAccepted', origin: 'preexisting' }
  });

  removeProvisionedArtifacts({ agentPath: oursPath, sidecarDir: sidecarOurs });
  removeProvisionedArtifacts({ agentPath: theirsPath, sidecarDir: sidecarTheirs });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('provenance-blind removal is what this would look like — ours goes',
    after.projects[oursPath] === undefined);
  check(
    'and the check is not vacuous: the pre-existing one, in the SAME file and the SAME shape, ' +
      'survives. A removal that ignored provenance would have taken both',
    after.projects[theirsPath]?.hasTrustDialogAccepted === true,
    JSON.stringify(after)
  );
}

// ---------------------------------------------------------------------------
// Cleanup, and PROVE it worked rather than assuming it. A verify script that
// leaks a PTY is a verify script whose next run is a flake — measured here
// rather than trusted.
// The bracketed `[m]js` is not cosmetic: `pgrep -f <pattern>` matches the
// pattern against every cmdline INCLUDING the `sh -c` this execSync spawns,
// which contains the pattern verbatim — so the naive form always finds one
// survivor, and a leak check that always reports one leak reports nothing. The
// bracket makes the literal in the shell's cmdline not match the regex.
const shimPattern = shimImpl.replace(/mjs$/, '[m]js');
const survivors = () =>
  Number(execSync(`pgrep -fc ${JSON.stringify(shimPattern)} || true`, { encoding: 'utf8' }).trim() || 0);

const before = survivors();
for (const bridge of bridges) {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
}
await new Promise((r) => setTimeout(r, 750));
const after = survivors();
check(
  `every PTY this script opened is gone (${before} alive before cleanup, ${after} after)`,
  after === 0,
  'a verify script that leaks a process is a verify script whose next run is a flake'
);
check(
  'and the count was non-zero before cleanup, so the check is measuring something',
  before > 0,
  `if this reads 0, the survivor count has stopped seeing the shim at all and the line above ` +
    `passes for the wrong reason`
);

process.env.PATH = realPath;
process.env.HOME = realHome;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(', ')}`
    : '\nALL PASS'
);
process.exit(failures.length ? 1 : 0);
