// Live proof (ported from the extraction source's KAN-25): a real CrabCast
// daemon refuses a PTY request that names a session it does not have, instead
// of substituting an arbitrary session or spawning a default shell nobody
// asked for.
//
// Everything here runs against real processes. Isolation is by $HOME, an
// explicit scratch dataDir in the config, and HERDR_SOCKET_PATH: the daemon
// gets its own socket, its own log and its own workspaces root; a private
// herdr server on its own socket means no agent started here can appear on —
// or disturb — the live one. The live daemon at ~/.local/share/crabcast is
// never contacted.
//
// Usage:
//   npm run build
//   node scripts/verify-pty-init-rejects-unknown-session.mjs [--dist <dir>]
//
//   --dist <dir>  run a different compiled daemon than this checkout's dist.
//
// Exit code 0 means every stage passed.

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

const argv = process.argv.slice(2);
const distIdx = argv.indexOf('--dist');
const distDir = distIdx === -1 ? path.join(packageDir, 'dist') : path.resolve(argv[distIdx + 1]);

if (!existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`${distDir}/daemon.js is missing — run \`npm run build\` first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, env) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

// The socket path must fit in sockaddr_un.sun_path (~108 bytes), which rules
// out a long TMPDIR — hence /tmp rather than mkdtemp's default.
const scratch = mkdtempSync('/tmp/kan25-');
const fakeHome = path.join(scratch, 'home');
const herdrSocket = path.join(scratch, 'h.sock');
const herdrState = path.join(scratch, 'herdr-state');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(herdrState, { recursive: true });

// The daemon under test loads a real config: one `task` type running the
// `shell` launcher, dataDir inside the scratch.
const dataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const configPath = path.join(fakeHome, 'crabcast.config.json');
mkdirSync(path.join(fakeHome, 'prompts'), { recursive: true });
writeFileSync(path.join(fakeHome, 'prompts', 'task.md'), 'KAN-25 proof workspace {{KEY}}.\n');
writeFileSync(configPath, JSON.stringify({
  dataDir,
  workspaceTypes: [
    { name: 'task', priority: 1, promptFile: 'prompts/task.md', defaultLauncher: 'shell' }
  ]
}, null, 2));

const isolatedEnv = {
  HOME: fakeHome,
  CRABCAST_CONFIG: configPath,
  HERDR_SOCKET_PATH: herdrSocket,
  XDG_CONFIG_HOME: path.join(herdrState, 'config'),
  XDG_STATE_HOME: path.join(herdrState, 'state')
};
mkdirSync(isolatedEnv.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(isolatedEnv.XDG_STATE_HOME, { recursive: true });

let daemon;
let herdrServer;
process.on('exit', () => {
  daemon?.kill('SIGKILL');
  herdrServer?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

const workspacesRoot = path.join(dataDir, 'workspaces');
const socketPath = path.join(dataDir, 'crabcast.sock');

// --- a private herdr, so a spawn cannot reach the live server -----------------
let herdrAvailable = false;
try {
  execFileSync('which', ['herdr'], { stdio: 'ignore' });
  herdrAvailable = true;
} catch {
  console.log('herdr is not on PATH: the regression stage will be skipped.\n');
}

if (herdrAvailable) {
  try {
    run('herdr', ['pane', 'list'], isolatedEnv);
    console.error(`something is already answering on ${herdrSocket} — refusing to run`);
    process.exit(1);
  } catch {
    // Nothing listening, which is what we want.
  }
  console.log(`starting a private herdr server on ${herdrSocket}`);
  herdrServer = spawn('herdr', ['server'], {
    env: { ...process.env, ...isolatedEnv },
    detached: true,
    stdio: 'ignore'
  });
  for (let i = 0; i < 20; i++) {
    try {
      run('herdr', ['pane', 'list'], isolatedEnv);
      break;
    } catch {
      await sleep(500);
    }
  }
  try {
    run('herdr', ['pane', 'list'], isolatedEnv);
  } catch {
    console.log('the private herdr server did not come up: the regression stage will be skipped.\n');
    herdrAvailable = false;
  }
}

const herdrAgentNames = () => {
  if (!herdrAvailable) return [];
  try {
    const parsed = JSON.parse(run('herdr', ['agent', 'list'], isolatedEnv));
    return (parsed?.result?.agents ?? []).map((a) => a.name).sort();
  } catch {
    return [];
  }
};

// --- the daemon under test ---------------------------------------------------
console.log(`starting a real daemon from ${distDir} with HOME=${fakeHome}`);
daemon = spawn(process.execPath, [path.join(distDir, 'daemon.js')], {
  env: { ...process.env, ...isolatedEnv },
  stdio: ['ignore', 'ignore', 'inherit']
});

for (let i = 0; i < 60 && !existsSync(socketPath); i++) await sleep(250);
if (!existsSync(socketPath)) {
  console.error('daemon never claimed its socket');
  process.exit(1);
}

const socket = net.connect(socketPath);
await new Promise((resolve) => socket.once('connect', resolve));

let buffer = '';
const pending = new Map();
const unsolicited = [];
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    } else {
      unsolicited.push(msg);
    }
  }
});
let nextId = 0;
const call = (action, data = {}) =>
  new Promise((resolve) => {
    const id = `kan25-${++nextId}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

const banner = (title) => {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
};

/** The agent census exactly as `list_agents` reports it. */
const census = async () => {
  const { agents = [], unbackedPanes = [] } = await call('list_agents');
  return { agents, unbackedPanes };
};

const workspaceTree = () => {
  if (!existsSync(workspacesRoot)) return [];
  const out = [];
  for (const type of readdirSync(workspacesRoot)) {
    const typeDir = path.join(workspacesRoot, type);
    let keys = [];
    try {
      keys = readdirSync(typeDir);
    } catch {
      keys = [];
    }
    for (const key of keys) out.push(`${type}/${key}`);
    if (keys.length === 0) out.push(`${type}/`);
  }
  return out.sort();
};

const results = [];
const record = (name, passed, note) => {
  results.push({ name, passed, note });
  console.log(`\n  ${passed ? 'PASS' : 'FAIL'}: ${name}${note ? ` — ${note}` : ''}`);
};

const FABRICATED = 'task-kan-25-1753900000000';

// --- 1. before ---------------------------------------------------------------
banner('1. before — what this daemon has (list_agents)');
const before = await census();
const beforeWorkspaces = workspaceTree();
const beforeHerdr = herdrAgentNames();
console.log(JSON.stringify(before, null, 2));
console.log(`\nworkspaces under ${workspacesRoot}: ${JSON.stringify(beforeWorkspaces)}`);
console.log(`herdr agents on the private server: ${JSON.stringify(beforeHerdr)}`);

// --- 2. the rejection --------------------------------------------------------
banner(`2. pty_init with a fabricated sessionId: '${FABRICATED}'`);
const rejection = await call('pty_init', { sessionId: FABRICATED });
console.log(JSON.stringify(rejection, null, 2));
record(
  'pty_init refuses an unknown sessionId',
  rejection.success === false && typeof rejection.error === 'string' && rejection.error.includes(FABRICATED),
  rejection.success === false ? 'error names the id' : `answered success=${rejection.success}`
);
record(
  'the refusal carries no buffer',
  rejection.buffer === undefined,
  rejection.buffer === undefined ? undefined : `buffer of ${String(rejection.buffer).length} chars returned`
);

// A listener registered against the fabricated id would stream some other
// session's output at us. Give any such stream a moment to arrive.
await sleep(500);
const strayOutput = unsolicited.filter((m) => m.action === 'pty_output');
record(
  'no pty_output arrives for a session that was refused',
  strayOutput.length === 0,
  strayOutput.length === 0 ? undefined : `${strayOutput.length} pty_output message(s) received`
);

// --- 3. no session created, none attached to ---------------------------------
banner('3. after — nothing was created, nothing was attached to');
const after = await census();
const afterWorkspaces = workspaceTree();
const afterHerdr = herdrAgentNames();
console.log(JSON.stringify(after, null, 2));
console.log(`\nworkspaces under ${workspacesRoot}: ${JSON.stringify(afterWorkspaces)}`);
console.log(`herdr agents on the private server: ${JSON.stringify(afterHerdr)}`);

record(
  'the agent census is unchanged',
  JSON.stringify(after) === JSON.stringify(before),
  JSON.stringify(after) === JSON.stringify(before) ? undefined : 'census differs — see above'
);
record(
  'no default/workspace directory was created',
  !afterWorkspaces.some((w) => w.startsWith('default/')),
  afterWorkspaces.some((w) => w.startsWith('default/')) ? 'a phantom workspace appeared' : undefined
);
record(
  'no phantom agent appeared on herdr',
  JSON.stringify(afterHerdr) === JSON.stringify(beforeHerdr),
  herdrAvailable ? undefined : '(herdr unavailable; directory evidence only)'
);

// --- 4. the other two PTY actions --------------------------------------------
banner('4. the same id at the other two PTY entry points');
const input = await call('pty_input', { sessionId: FABRICATED, data: 'echo this must not reach a terminal\n' });
console.log('pty_input  →', JSON.stringify(input, null, 2));
const resize = await call('pty_resize', { sessionId: FABRICATED, cols: 100, rows: 40 });
console.log('pty_resize →', JSON.stringify(resize, null, 2));
record('pty_input refuses an unknown sessionId', input.success === false);
record('pty_resize refuses an unknown sessionId', resize.success === false);

const missing = await call('pty_init', {});
console.log('\npty_init with no sessionId at all →', JSON.stringify(missing, null, 2));
record('pty_init refuses a request with no sessionId', missing.success === false);

// --- 5. regression: a real session still works -------------------------------
banner('5. regression — a genuine session, and a re-init of it');
if (!herdrAvailable) {
  console.log('SKIPPED: no herdr to start an agent with.');
} else {
  // `shell` explicitly: what this stage needs is a PTY the daemon genuinely
  // holds a session for — a bare shell, not a coding agent. `override: true`
  // with it: the capacity gate measures the real machine, and whether this
  // box is busy is not what is being proved. The override is recorded with
  // the figures at the time, as it is for anyone.
  const activated = await call('activate_by_key', {
    type: 'task',
    key: 'KAN-25-VERIFY',
    defaultAgent: 'shell',
    override: true
  });
  console.log('activate_by_key →', JSON.stringify({ ...activated, id: undefined }, null, 2));

  if (!activated.success) {
    record('a real session could be started', false, activated.error);
  } else {
    await sleep(1500);
    const good = await call('pty_init', { sessionId: activated.sessionId });
    console.log(`\npty_init with the real id '${activated.sessionId}' →`);
    console.log(JSON.stringify({ ...good, buffer: `<${(good.buffer ?? '').length} chars>` }, null, 2));
    record(
      'pty_init accepts a session this daemon holds',
      good.success === true && typeof good.buffer === 'string',
      good.success === true ? undefined : good.error
    );

    // The reconnect shape: a client re-inits the same id after its transport
    // reconnects. It must keep working, and replace the old listener rather
    // than stacking a second one.
    unsolicited.length = 0;
    const reinit = await call('pty_init', { sessionId: activated.sessionId });
    record(
      're-init of the same live session still succeeds (the reconnect shape)',
      reinit.success === true,
      reinit.success === true ? undefined : reinit.error
    );

    const marker = 'kan25-round-trip';

    // Typed only once the shell is provably listening, and this is the fix for
    // a real flake (KAN-88 item 11): this used to type after a flat 1500ms
    // sleep, which is a guess about how long bash and herdr's TUI take to
    // finish starting. On a quiet machine the guess held; in a back-to-back
    // suite run it did not, the keystrokes were delivered to a pane whose
    // shell had not yet started reading, and they were simply lost — after
    // which the six seconds of polling below could only ever confirm that the
    // marker never arrived. The failure printed as "input reaches the real
    // PTY" failing with a buffer that had only just finished drawing its
    // prompt, which is the tell.
    //
    // Waiting for evidence instead of for a duration is the same discipline
    // the nudge machinery uses on a resumed agent (nudge.ts's readyMarkers):
    // the prompt on screen is the shell saying it is ready for input.
    const deescape = (text) => text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
    let promptReady = false;
    let promptTail = '';
    for (let i = 0; i < 60 && !promptReady; i++) {
      const snapshot = await call('pty_init', { sessionId: activated.sessionId });
      const text = deescape(typeof snapshot.buffer === 'string' ? snapshot.buffer : '');
      promptTail = text.slice(-120);
      // A bash prompt at the end of the drawn screen: `…user@host:dir$ ` with
      // nothing typed after it.
      promptReady = /\$\s*$/.test(text.trimEnd() + ' ');
      if (!promptReady) await sleep(500);
    }
    console.log(
      promptReady
        ? `\n  the shell drew its prompt before anything was typed: ${JSON.stringify(promptTail.slice(-40))}`
        : `\n  WARNING: no shell prompt after 30s; typing anyway. tail: ${JSON.stringify(promptTail)}`
    );

    await call('pty_input', { sessionId: activated.sessionId, data: `echo ${marker}\n` });

    // Two separate facts, checked separately. The stream is live if anything
    // at all comes back on the listener the re-init registered; the input
    // landed if the marker turns up in the session's own buffer. Grepping the
    // streamed chunks for the marker would conflate them — a full-screen TUI
    // repaints in fragments and can split a short string across two writes.
    let streamed = [];
    let seen = false;
    let tail = '';
    for (let i = 0; i < 12 && !seen; i++) {
      await sleep(500);
      streamed = unsolicited.filter((m) => m.action === 'pty_output' && m.sessionId === activated.sessionId);
      const snapshot = await call('pty_init', { sessionId: activated.sessionId });
      const text = typeof snapshot.buffer === 'string' ? snapshot.buffer : '';
      tail = text.slice(-400);
      // herdr's TUI draws a character at a time, each preceded by an explicit
      // cursor move, so the marker is never a contiguous substring of the raw
      // buffer. Escapes out, order preserved, and the text reads normally.
      seen = text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').includes(marker);
    }
    if (!seen) {
      console.log('\n  last 400 chars of the session buffer (escapes shown), for diagnosis:');
      console.log('  ' + JSON.stringify(tail));
    }
    record(
      "the re-init's listener is live — output streams back on it",
      streamed.length > 0,
      `${streamed.length} pty_output message(s) received`
    );
    record(
      'input reaches the real PTY',
      seen,
      seen ? `'${marker}' echoed into the session buffer` : `'${marker}' never appeared in the buffer`
    );

    await call('deactivate', { sessionId: activated.sessionId });
  }
}

// --- verdict -----------------------------------------------------------------
banner('verdict');
for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? ` (${r.note})` : ''}`);
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

socket.end();
process.exit(failed.length === 0 ? 0 : 1);
