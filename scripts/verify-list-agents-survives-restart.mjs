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
//   3. herdr reports live agents, no sessions       -> every one listed, all
//      sessionless, session-only fields null, shell panes not counted
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
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan28-'));
const realPath = process.env.PATH;

// A real config through the real loader, so the router's deps are the shapes
// the daemon builds. The dataDir keeps the bridge and the registry inside the
// scratch.
const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'prompts', 'task.md'), 'KAN-28 proof {{KEY}}.\n');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: 'task', priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'claude' }
  ]
}, null, 2));
const config = loadConfig(configPath);

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
function listAgents() {
  let response;
  const router = new MessageRouter({
    registry: new WorkspaceRegistry(config.workspaceTypes),
    config,
    promptLoader: new PromptLoader(config.baseDir),
    // A fresh bridge holds no sessions — exactly the state a daemon restart
    // leaves behind, which is the whole point of the proof.
    herdrBridge: new HerdrBridge(config.dataDir),
    daemonStartedAt: new Date(),
    // A fresh registry file per call: this script is about the census, and an
    // empty registry keeps the categories out of the way (they are proved in
    // verify-agent-resumption and verify-agent-power-controls).
    agentRegistry: new AgentRegistry(path.join(tmp, `agents-${++registryFile}.jsonl`)),
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
      { name: 'crabcast-task-kan-28', agent: 'claude', agent_status: 'working', cwd: '/w/task/kan-28' },
      { name: 'crabcast-epic-kan-39', agent: 'claude', agent_status: 'idle', cwd: '/w/epic/kan-39' },
      { name: 'crabcast-default-workspace', agent_status: 'unknown', cwd: '/w/default/workspace' },
      { name: 'crabcast-cto-agent-story-st-8fbd6dac', agent_status: 'unknown', cwd: '/home/u' },
      { name: 'not-a-crabcast-agent', agent: 'claude', agent_status: 'working', cwd: '/elsewhere' }
    ]
  }
}));
res = listAgents();
console.log('\n== 3. five herdr agents, no sessions (post-restart) ==');
console.log(JSON.stringify(res, null, 2));

const names = res.agents.map(a => a.agentName).sort();
check(
  'both claude-backed agents are listed',
  JSON.stringify(names) === JSON.stringify(['crabcast-epic-kan-39', 'crabcast-task-kan-28']),
  names.join(', ')
);
check('every entry is marked sessionless', res.agents.every(a => a.sessionless === true));
check(
  'session-only fields are null, not fabricated',
  res.agents.every(a =>
    a.sessionId === null && a.url === null && a.createdAt === null && a.status === null)
);
check(
  'the address is recovered from the agent name',
  res.agents.some(a => a.type === 'task' && a.key === 'kan-28')
);
check(
  'shell panes are reported, not counted as agents',
  res.unbackedPanes.length === 2 &&
    res.unbackedPanes.every(p => p.agentName.startsWith('crabcast-')),
  res.unbackedPanes.map(p => p.agentName).join(', ')
);
check(
  'a non-crabcast agent is neither listed nor reported',
  !JSON.stringify(res).includes('not-a-crabcast-agent')
);

process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures.length
  ? `\n${failures.length} FAILED: ${failures.join(', ')}`
  : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
