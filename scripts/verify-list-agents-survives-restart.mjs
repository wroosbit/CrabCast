// Ported from the extraction source's KAN-28 proof: `list_agents` must answer
// from what exists, not from the daemon's session map — which a restart
// empties while the herdr panes keep running.
//
// The live proof for that is on the PR: a real daemon restart with real
// agents. What a live run *cannot* show is the two edge cases, because a
// working machine always has agents and always has a herdr. Those are covered
// here by putting a stub `herdr` first on PATH and driving the real
// MessageRouter and the real HerdrBridge — only the external binary is
// replaced, no part of the code under test is mocked.
//
// Cases:
//   1. herdr reports no agents at all, no sessions  -> agents: [] (regression:
//      an empty board must stay an empty array, not an error), and every
//      registry-derived category is present-and-empty rather than absent
//   2. herdr is missing/broken entirely             -> agents: [], no throw
//   3. herdr reports live agents, no sessions       -> every configured one
//      listed, all sessionless, session-only fields null, our runtime-less
//      panes reported as unbacked, strangers' panes reported as foreign
//
// WHAT CHANGED WITH PATH IDENTITY: "one of ours" used to be a pane name that
// started with `crabcast-` and parsed back into a type and key. It is now a
// pane whose canonical `cwd` is a directory the durable registry holds a
// record for AND whose name is the one that directory derives — so section 3
// configures its agents first, and a pane sitting in an unregistered directory
// is a foreign pane rather than an invisible one.
//
// Usage:
//   npm run build
//   node scripts/verify-list-agents-survives-restart.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan28-'));
const realPath = process.env.PATH;

// A real config through the real loader, so the router's deps are the shapes
// the daemon builds. It declares nothing but a dataDir now — there is no type
// table left to declare.
const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'prompts', 'task.md'), 'KAN-28 proof {{PATH}}.\n');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

/** Two directories a caller already owns, and their derived pane names. */
const mkdir = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
};
const alpha = mkdir('alpha');
const beta = mkdir('beta');
const stranger = mkdir('stranger');

/** Put a `herdr` on PATH that prints `payload` for every invocation. */
function stubHerdr(payload) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'herdr'),
    `#!/bin/sh\ncat <<'EOF'\n${payload}\nEOF\n`,
    { mode: 0o755 }
  );
  process.env.PATH = `${bin}:${realPath}`;
}

/** Remove herdr from PATH entirely, as on a machine that has never had one. */
function noHerdr() {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
}

let registryFile = 0;
/**
 * `list_agents` through the real router.
 *
 * `configured` is the set of directories to write `configured` rows for before
 * the call. It is not decoration: under path identity the registry is what
 * decides which panes are ours, so a census with nothing configured is
 * correctly a census of strangers.
 */
function listAgents(configured = []) {
  let response;
  const registryPath = path.join(tmp, `agents-${++registryFile}.jsonl`);
  const agentRegistry = new AgentRegistry(registryPath);
  for (const dir of configured) {
    agentRegistry.recordConfigured({
      path: dir,
      config: { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'claude' }
    });
  }
  const router = new MessageRouter({
    config,
    // A fresh bridge holds no sessions — exactly the state a daemon restart
    // leaves behind, which is the whole point of the proof.
    herdrBridge: new HerdrBridge(config.dataDir),
    daemonStartedAt: new Date(),
    agentRegistry,
    send: (msg) => { response = msg; },
    broadcast: () => {}
  });
  router.handle({ action: 'list_agents' });
  return response;
}

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// --- 1. an empty board -------------------------------------------------------
stubHerdr('{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}');
let res = listAgents();
console.log('\n== 1. herdr knows no agents, daemon holds no sessions ==');
console.log(JSON.stringify(res, null, 2));
check('empty board answers success', res.success === true);
check('empty board answers agents: []', Array.isArray(res.agents) && res.agents.length === 0);
check('empty board answers unbackedPanes: []', Array.isArray(res.unbackedPanes) && res.unbackedPanes.length === 0);
check(
  'the registry-derived categories are present-and-empty, never absent — a caller ' +
  'cannot tell "nothing is missing" from "nobody tracks that" via a missing field',
  Array.isArray(res.missingAgents) && res.missingAgents.length === 0 &&
    Array.isArray(res.preemptedAgents) && res.preemptedAgents.length === 0 &&
    Array.isArray(res.standbyAgents) && res.standbyAgents.length === 0 &&
    res.standbyTotal === 0
);

// --- 2. no herdr at all ------------------------------------------------------
noHerdr();
res = listAgents();
console.log('\n== 2. herdr is not installed ==');
console.log(JSON.stringify(res, null, 2));
check('missing herdr does not throw', res && res.success === true);
check('missing herdr answers agents: []', Array.isArray(res.agents) && res.agents.length === 0);

// --- 3. agents that outlived the daemon --------------------------------------
stubHerdr(JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      // Ours: registered directory, and the pane wears the name that
      // directory derives.
      { name: paneNameFor(alpha), pane_id: 'p1', agent: 'claude', agent_status: 'working', cwd: alpha },
      { name: paneNameFor(beta), pane_id: 'p2', agent: 'claude', agent_status: 'idle', cwd: beta },
      // Ours, but nothing behind it: an unbacked pane.
      { name: paneNameFor(stranger), pane_id: 'p3', agent_status: 'unknown', cwd: stranger },
      // A live pane in a directory we hold no record for: foreign, and not
      // silently dropped the way the old prefix filter dropped it.
      { name: 'butchr-task-kan-77', pane_id: 'p4', agent: 'claude', agent_status: 'working', cwd: os.tmpdir() }
    ]
  }
}));
res = listAgents([alpha, beta, stranger]);
console.log('\n== 3. four herdr panes, no sessions (post-restart) ==');
console.log(JSON.stringify(res, null, 2));

const paths = res.agents.map(a => a.path).sort();
check(
  'both claude-backed agents are listed',
  JSON.stringify(paths) === JSON.stringify([alpha, beta].sort()),
  paths.join(', ')
);
check('every entry is marked sessionless', res.agents.every(a => a.sessionless === true));
check(
  'session-only fields are null, not fabricated',
  res.agents.every(a => a.sessionId === null && a.createdAt === null && a.status === null)
);
check(
  'the address IS the directory — recovered from the pane cwd joined against the registry, ' +
  'not parsed out of the pane name',
  res.agents.some(a => a.path === alpha && a.paneName === paneNameFor(alpha))
);
check(
  'our pane with no runtime is reported as unbacked, not counted as an agent',
  res.unbackedPanes.length === 1 && res.unbackedPanes[0].path === stranger,
  res.unbackedPanes.map(p => p.paneName).join(', ')
);
check(
  "a stranger's live pane is reported as foreign rather than silently dropped",
  res.foreignPanes.length === 1 && res.foreignPanes[0].paneName === 'butchr-task-kan-77',
  JSON.stringify(res.foreignPanes)
);
check(
  'and it does not claim to occupy one of our directories, because it is not in one',
  res.foreignPanes[0]?.occupies === null
);

process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures.length
  ? `\n${failures.length} FAILED: ${failures.join(', ')}`
  : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
