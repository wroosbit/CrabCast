#!/usr/bin/env node
// Live proof for KAN-123 as decided on KAN-124: CrabCast accepts a RENDERED
// prompt and does not interpolate. There is no placeholder syntax, no variable
// set, and no template resolution left in the daemon.
//
// WHAT WAS DELETED AND WHY, because a check that only asserts absence reads as
// arbitrary a year later.
//
// `PromptLoader` rendered doubled-brace KEY and URL placeholders out of a
// workspace type's `promptFile`. Deleting `key` left that substitution with no
// source, and there were two ways out: keep rendering with caller-supplied
// variables, or stop rendering. Rendering was wrong twice over. It makes the
// placeholder syntax and the variable set into API — a consumer whose
// supervision depends on a KEY reaching its agent breaks SILENTLY when either
// changes, because the agent still starts, reads the placeholder as literal
// text, and works on nothing. And that KEY was a Jira ticket key: the whole
// point of deleting `type`, `key` and the parseable agent name was that
// CrabCast stop carrying its consumer's vocabulary, and an interpolator whose
// variables are named after another system's concepts is the same artifact
// wearing a hat.
//
// Three sections:
//
//   1. deletion    — src/prompt.ts is gone, no doubled brace survives anywhere
//                    in src/, and nothing exports a renderer
//   2. verbatim    — a prompt containing literal placeholder syntax reaches the
//                    sidecar and the launcher's command line BYTE FOR BYTE
//   3. the bound   — an over-large prompt is REFUSED by configure, naming the
//                    limit and the actual size, on a connection that survives;
//                    and the largest accepted prompt still round-trips
//
// Section 3 is not belt-and-braces. A prompt travels inline over the socket
// now, and `onJsonLines` gives up on a line past MAX_LINE_CHARS and DESTROYS
// the connection (ipc.ts). That is right for its own job — at that point there
// is no message to answer — but it is the wrong thing for a caller to meet,
// and a prompt that silently truncated would be an agent acting on half its
// instructions, which is the same uninstructed-agent failure through a
// different door.
//
// Usage:
//   npm run build
//   node scripts/verify-prompt-is-not-a-template.mjs [distDir]

import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = process.argv[2] ?? path.join(repoRoot, 'dist');

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter, MAX_PROMPT_CHARS } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { MAX_LINE_CHARS } = await import(path.join(distDir, 'ipc.js'));
const { sidecarDirFor, paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { PROMPT_FILENAME } = await import(path.join(distDir, 'launchers.js'));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan123-prompt-'));
const realPath = process.env.PATH;
const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

// ---------------------------------------------------------------------------
console.log('=== 1. The interpolator is gone (AC 10) ===\n');
// ---------------------------------------------------------------------------
{
  check(
    'src/prompt.ts does not exist',
    !fs.existsSync(path.join(repoRoot, 'src', 'prompt.ts'))
  );
  check(
    'and neither does the built dist/prompt.js — a stale build artifact is still an export',
    !fs.existsSync(path.join(distDir, 'prompt.js'))
  );

  // The grep the acceptance criterion names, run here so it is a CHECK rather
  // than something a reviewer has to remember. Comments in src/ describe the
  // old placeholder syntax rather than writing it out, precisely so this grep
  // stays mechanical: one somebody has to eyeball to confirm the hits are only
  // comments is one that has stopped working.
  const srcDir = path.join(repoRoot, 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const text = fs.readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('{' + '{')) offenders.push(`${path.relative(repoRoot, full)}:${i + 1}`);
      });
    }
  };
  walk(srcDir);
  check(
    'a grep for a doubled brace across src/ returns nothing',
    offenders.length === 0,
    offenders.join(', ')
  );

  // And the library surface no longer offers one, which is the half a grep
  // cannot see: an embedder importing the package must not find a renderer.
  const surface = await import(path.join(distDir, 'index.js'));
  check(
    'the package surface exports no PromptLoader',
    !('PromptLoader' in surface)
  );

  // The router takes no prompt-rendering dependency at all. Checked against the
  // built source rather than the type, because RouterDeps is erased at runtime.
  const routerSource = fs.readFileSync(path.join(repoRoot, 'src', 'router.ts'), 'utf8');
  check(
    'src/router.ts names no promptLoader — the variable supply is gone, not merely unused',
    !/promptLoader/.test(routerSource)
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. A prompt reaches the agent byte for byte (AC 10) ===\n');
// ---------------------------------------------------------------------------

// A herdr stub that records its argv, so the launcher's command line can be
// read back and checked for the prompt file it was told to point at.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const ARGV_LOG = path.join(tmp, 'herdr-argv.log');
const CENSUS = path.join(tmp, 'census.json');
fs.writeFileSync(CENSUS, JSON.stringify({ result: { type: 'agent_list', agents: [] } }));
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ARGV_LOG)}
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then cat ${JSON.stringify(CENSUS)}; exit 0; fi
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then
  echo '{"error":{"code":"agent_not_found","message":"no such agent"}}'
  exit 1
fi
echo '{"result":{}}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;

/**
 * The prompt under test, and every part of it is deliberate.
 *
 * It contains the exact placeholder syntax the deleted interpolator would have
 * substituted, a couple more that were never variables, JSON metacharacters
 * (the prompt crosses the socket as a JSON string), a backslash sequence bash
 * would eat if the launcher's command line were ever built by concatenation,
 * and a non-ASCII character to catch an encoding round-trip. If ANY of this
 * comes back changed, something is still inspecting the bytes.
 */
const PROMPT = [
  '# Task {' + '{KEY}}',
  '',
  'You are working on {' + '{KEY}} at {' + '{URL}}, in {' + '{PATH}}.',
  'Unrendered placeholders like {' + '{ NOT_A_VARIABLE }} must survive too.',
  'Quotes "like these", a backslash \\n that is NOT a newline, and a tab\tcharacter.',
  'Non-ASCII: café — ✓',
  ''
].join('\n');

let caseNo = 0;
function newCase() {
  return {
    agentRegistry: new AgentRegistry(path.join(tmp, `agents-${++caseNo}.jsonl`)),
    bridge: new HerdrBridge(config.dataDir, config.configPath),
    events: []
  };
}
function invoke(deps, request) {
  return new Promise((resolve) => {
    new MessageRouter({
      config,
      herdrBridge: deps.bridge,
      daemonStartedAt: new Date(),
      agentRegistry: deps.agentRegistry,
      send: resolve,
      broadcast: (m) => deps.events.push(m)
    }).handle(request);
  });
}

const KNOBS = { priority: 1, launcher: 'shell' };

{
  const dir = path.join(tmp, 'owned');
  fs.mkdirSync(dir, { recursive: true });
  const agentPath = fs.realpathSync(dir);
  const deps = newCase();

  const configured = await invoke(deps, {
    action: 'configure_agent',
    path: agentPath,
    ...KNOBS,
    prompt: PROMPT
  });
  check('configure accepts the prompt as text', configured.success === true, configured.error);
  check(
    'and the record holds those bytes unchanged — nothing was trimmed, resolved or rendered',
    deps.agentRegistry.intents().get(agentPath)?.record.config.prompt === PROMPT
  );

  fs.writeFileSync(ARGV_LOG, '');
  await invoke(deps, { action: 'activate_agent', path: agentPath });

  // The sidecar, which is where the prompt actually lands.
  const sidecar = sidecarDirFor(config.dataDir, agentPath);
  const promptFile = path.join(sidecar, PROMPT_FILENAME);
  check(`the prompt was written to the sidecar (${path.relative(tmp, promptFile)})`,
    fs.existsSync(promptFile));
  const onDisk = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
  check(
    'BYTE FOR BYTE unchanged on disk — placeholders, quotes, backslashes and non-ASCII intact',
    onDisk === PROMPT,
    onDisk === PROMPT ? `${Buffer.byteLength(onDisk)} bytes` : JSON.stringify(onDisk.slice(0, 200))
  );
  console.log('\n--- the file the agent is pointed at ---');
  console.log(onDisk);
  console.log('--- end ---\n');

  check(
    'nothing was written into the caller\'s own directory',
    fs.readdirSync(agentPath).length === 0,
    fs.readdirSync(agentPath).join(', ')
  );

  // And the pane's command line names that file by absolute path, which is
  // what makes the sidecar reachable from a directory it does not sit in.
  const startLine = fs
    .readFileSync(ARGV_LOG, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('agent start '));
  check('the pane was started', Boolean(startLine));
  // The sidecar only works if the pane is told where it is: the file no longer
  // sits in the agent's cwd, so a bare filename would name nothing. Every
  // launcher that is handed a prompt puts its ABSOLUTE path on the command
  // line — `shell` prints it into the pane, `claude` passes it as the
  // instruction — and a launcher that quietly dropped it would be a configured
  // prompt reaching nobody.
  check(
    "and its command line points the agent at the sidecar file by absolute path",
    (startLine ?? '').includes(promptFile),
    startLine
  );
  check(
    'the pane name is derived from the path and carries none of the prompt',
    (startLine ?? '').includes(paneNameFor(agentPath))
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. The size bound is legible (AC 11) ===\n');
// ---------------------------------------------------------------------------
{
  console.log(`  MAX_PROMPT_CHARS = ${MAX_PROMPT_CHARS} (${MAX_PROMPT_CHARS / 1024} KiB)`);
  console.log(`  MAX_LINE_CHARS   = ${MAX_LINE_CHARS} (${MAX_LINE_CHARS / 1024} KiB) — the framing bound\n`);

  // The property that makes the two bounds a pair rather than a duplication:
  // JSON escaping can expand a string sixfold in the worst case (a control
  // byte becomes a six-character \\u00XX escape), so a prompt the daemon
  // ACCEPTS must still fit on the wire after escaping. If this ever stops
  // holding, there is a size that passes validation and then dies in the
  // framing — which is the silent failure the bound exists to prevent, one
  // layer down.
  check(
    'every accepted prompt is guaranteed deliverable: 6 × MAX_PROMPT_CHARS still fits ' +
      'inside MAX_LINE_CHARS with room for the rest of the request',
    MAX_PROMPT_CHARS * 6 < MAX_LINE_CHARS,
    `${MAX_PROMPT_CHARS * 6} worst-case escaped vs ${MAX_LINE_CHARS} bound`
  );

  const dir = path.join(tmp, 'sized');
  fs.mkdirSync(dir, { recursive: true });
  const agentPath = fs.realpathSync(dir);

  // Over the bound, through the router first — the refusal itself.
  const deps = newCase();
  const oversize = 'x'.repeat(MAX_PROMPT_CHARS + 1);
  const refused = await invoke(deps, {
    action: 'configure_agent', path: agentPath, ...KNOBS, prompt: oversize
  });
  console.log(`  refusal: ${refused.error}\n`);
  check('an over-large prompt is REFUSED', refused.success === false);
  check(
    'the message names the limit',
    (refused.error ?? '').includes(String(MAX_PROMPT_CHARS))
  );
  check(
    'and the actual size, so the caller knows how much to cut',
    (refused.error ?? '').includes(String(oversize.length))
  );
  check(
    'and states that nothing was truncated — a half-instructed agent is worse than a refusal',
    /NOTHING WAS TRUNCATED/.test(refused.error ?? '')
  );
  check(
    'and NOTHING was configured: the record does not exist',
    !deps.agentRegistry.intents().has(agentPath)
  );

  // Exactly at the bound is accepted, so the refusal is a bound rather than a
  // fence a caller has to guess the far side of.
  const atLimit = 'y'.repeat(MAX_PROMPT_CHARS);
  const accepted = await invoke(deps, {
    action: 'configure_agent', path: agentPath, ...KNOBS, prompt: atLimit
  });
  check(
    `a prompt of exactly ${MAX_PROMPT_CHARS} characters is ACCEPTED — the limit is inclusive`,
    accepted.success === true,
    accepted.error
  );
  check(
    'and survived intact',
    deps.agentRegistry.intents().get(agentPath)?.record.config.prompt === atLimit
  );
}

// The same two, over a real socket against a real daemon — because the whole
// point of AC 11 is that the CONNECTION SURVIVES, and a router driven in
// process cannot show that.
console.log('\n--- over a real socket, against a real daemon ---\n');
{
  const daemonJs = path.join(distDir, 'daemon.js');
  const daemon = spawn(process.execPath, [daemonJs, configPath], {
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const socketPath = path.join(dataDir, 'crabcast.sock');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline && !up) {
    up = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (!up) await sleep(100);
  }
  check('daemon is up', up);

  const dir = path.join(tmp, 'wire');
  fs.mkdirSync(dir, { recursive: true });
  const agentPath = fs.realpathSync(dir);

  // ONE connection for both requests. That is the assertion: the refusal must
  // leave the socket usable, unlike the framing bound, which answers and then
  // destroys it.
  const socket = net.connect(socketPath);
  const replies = [];
  const waiters = new Map();
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      replies.push(msg);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  socket.on('error', () => {});
  await new Promise((r) => socket.once('connect', r));

  const request = (payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply')), 15000);
      waiters.set(payload.id, (msg) => { clearTimeout(timer); resolve(msg); });
      socket.write(JSON.stringify(payload) + '\n');
    });

  const oversize = 'x'.repeat(MAX_PROMPT_CHARS + 1);
  const refused = await request({
    action: 'configure_agent', id: 1, path: agentPath, ...KNOBS, prompt: oversize
  });
  console.log(`  daemon said: ${refused.error}\n`);
  check('over the socket, the over-large prompt is refused', refused.success === false);
  check(
    'the reply names both the limit and the actual size',
    (refused.error ?? '').includes(String(MAX_PROMPT_CHARS)) &&
      (refused.error ?? '').includes(String(oversize.length))
  );
  check(
    'THE CONNECTION SURVIVED — unlike the framing bound, which answers and then destroys it',
    !socket.destroyed
  );

  // And it is still usable, which is the difference stated as a fact rather
  // than as the absence of a close event.
  const after = await request({
    action: 'configure_agent', id: 2, path: agentPath, ...KNOBS, prompt: 'a modest prompt'
  });
  check(
    'and the same connection serves the next request',
    after.success === true && after.id === 2,
    after.error
  );

  // The largest legal prompt really does cross the wire, which is the claim
  // the sizing arithmetic makes. ~128 KiB in one JSON line.
  const atLimit = 'z'.repeat(MAX_PROMPT_CHARS);
  const big = await request({
    action: 'configure_agent', id: 3, path: agentPath, ...KNOBS, prompt: atLimit
  });
  check(
    `a ${MAX_PROMPT_CHARS}-character prompt round-trips over the socket intact`,
    big.success === true,
    big.error
  );
  const stored = new AgentRegistry(path.join(dataDir, 'agents.jsonl'))
    .intents().get(agentPath)?.record.config.prompt;
  check(
    'and is what reached the durable registry, character for character',
    stored === atLimit,
    stored ? `${stored.length} characters` : 'nothing stored'
  );

  socket.destroy();
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.once('exit', r));
}

process.env.PATH = realPath;
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
