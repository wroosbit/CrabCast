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
// The round-trip stage asserts DELIVERY rather than assuming it: it sends,
// checks the echo came back, and resends a bounded number of times before
// failing. Keystrokes written to a pane whose shell has not yet reached its
// `read` are dropped by the terminal, which is load-dependent and was the
// cause of this script's flake (KAN-88 item 11) — a retry costs a second and
// removes a red check that was never about CrabCast.
//
// Usage:
//   npm run build
//   node scripts/verify-pty-init-rejects-unknown-session.mjs [--dist <dir>]
//
//   --dist <dir>  run a different compiled daemon than this checkout's dist.
//
// Environment:
//   KAN25_DROP_FIRST_SENDS=<n>  drop the first n sends without writing them,
//                               modelling exactly those lost keystrokes. With
//                               n < the attempt budget the run must still pass
//                               (the retry recovers); with n >= it, the run
//                               must still FAIL (the retry has not been turned
//                               into a check that cannot fail). Both are how
//                               the retry itself is tested.
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

// The daemon under test loads a real config: a dataDir inside the scratch and
// nothing else, because there is no type table left to declare.
const dataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const configPath = path.join(fakeHome, 'crabcast.config.json');
writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

/** The directory this proof's one agent is. CrabCast creates none of its own. */
const AGENT_DIR = path.join(fakeHome, 'owned', 'kan-25-verify');
mkdirSync(AGENT_DIR, { recursive: true });

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

// What a refused PTY request must not have created. `<dataDir>/workspaces` is
// gone with the type model — CrabCast allocates no directory at all now — so
// the two places a phantom could appear are the SIDECAR root, which is the
// only tree this daemon writes into, and the caller's own directory, which it
// must never write into.
const sidecarRoot = path.join(dataDir, 'agents');
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

/**
 * Every directory this daemon has created for an agent, plus the contents of
 * the caller's own directory.
 *
 * This replaced a walk of `<dataDir>/workspaces`, which this PR deleted from
 * the product — so it returned `[]` unconditionally and the assertion built on
 * it could not fail. Deleting the tree was right; leaving the check pointed at
 * it was not.
 */
const agentTree = () => {
  const out = [];
  if (existsSync(sidecarRoot)) {
    for (const hash of readdirSync(sidecarRoot)) out.push(`sidecar/${hash}`);
  }
  if (existsSync(AGENT_DIR)) {
    for (const entry of readdirSync(AGENT_DIR)) out.push(`caller-dir/${entry}`);
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
const beforeWorkspaces = agentTree();
const beforeHerdr = herdrAgentNames();
console.log(JSON.stringify(before, null, 2));
console.log(`\nagent directories (sidecars + the caller's own): ${JSON.stringify(beforeWorkspaces)}`);
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
const afterWorkspaces = agentTree();
const afterHerdr = herdrAgentNames();
console.log(JSON.stringify(after, null, 2));
console.log(`\nagent directories (sidecars + the caller's own): ${JSON.stringify(afterWorkspaces)}`);
console.log(`herdr agents on the private server: ${JSON.stringify(afterHerdr)}`);

record(
  'the agent census is unchanged',
  JSON.stringify(after) === JSON.stringify(before),
  JSON.stringify(after) === JSON.stringify(before) ? undefined : 'census differs — see above'
);
record(
  'the refused request created no directory anywhere — not a sidecar, and nothing in ' +
    "the caller's own directory",
  JSON.stringify(afterWorkspaces) === JSON.stringify(beforeWorkspaces),
  JSON.stringify(afterWorkspaces) === JSON.stringify(beforeWorkspaces)
    ? undefined
    : `appeared: ${JSON.stringify(afterWorkspaces.filter((w) => !beforeWorkspaces.includes(w)))}`
);
record(
  'no phantom agent appeared on herdr',
  JSON.stringify(afterHerdr) === JSON.stringify(beforeHerdr),
  // The sibling claim used to say "directory evidence only" when herdr was
  // unavailable — which was untrue while the directory check was vacuous. It
  // is true again now, so it can be said again.
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
  await call('configure_agent', { path: AGENT_DIR, priority: 1, launcher: 'shell' });
  const activated = await call('activate_agent', { path: AGENT_DIR, override: true });
  console.log('activate_agent →', JSON.stringify({ ...activated, id: undefined }, null, 2));

  if (!activated.success) {
    record('a real session could be started', false, activated.error);
  } else {
    // Polled rather than slept. This used to be a flat 1500ms, which is a
    // guess about how long the daemon takes to have the session ready — and a
    // guess is exactly what the rest of this script exists to argue against.
    // `pty_init` on a session this daemon holds succeeds immediately, so the
    // first attempt normally is the last one.
    let good;
    for (let i = 0; i < 40; i++) {
      good = await call('pty_init', { sessionId: activated.sessionId });
      if (good.success === true) break;
      await sleep(250);
    }
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

    // DELIVERY IS ASSERTED, NOT ASSUMED — the second attempt at a real flake
    // (KAN-88 item 11, and its round-2 review).
    //
    // The original wrote once after a flat 1500ms sleep. Under load the
    // keystrokes reached a pane whose shell had not begun reading and were
    // silently dropped, and the polling that followed could only ever confirm
    // the marker never arrived — a red check about the machine, not the code.
    //
    // The first fix waited for a shell prompt before typing. Necessary, and
    // not sufficient: a drawn prompt proves the shell has *printed* something,
    // not that it has reached its `read`. Worse, the wait degraded — after 30s
    // it logged "typing anyway" and fell back to exactly the old racy write,
    // so the failure survived at roughly 1 run in 11 under 4-way concurrency
    // (reproduced on `main` at 273c18f before this change: 1 of 12). It also
    // assumed a default `PS1`, which is a fact about whoever runs the script
    // rather than about CrabCast.
    //
    // So: send, verify the echo came back, and if it did not, send again — a
    // bounded number of times before failing loudly. A keystroke that vanishes
    // into a not-yet-reading shell now costs one retry instead of a false
    // failure, and a PTY that genuinely never delivers still fails, which is
    // the property this check exists for. Look, do not assume — the same rule
    // the router applies to every other claim about the world.
    const deescape = (text) => text.replace(/\[[0-9;?]*[a-zA-Z]/g, '');

    // Reads go through `tail_agent`, the non-mutating way to ask what is on the
    // pane. The previous version polled with `pty_init`, which re-registers the
    // session's data listener on every call — ~60 registrations to answer a
    // question that changes nothing.
    const paneText = async () => {
      const tailed = await call('tail_agent', { path: AGENT_DIR, lines: 200 });
      return typeof tailed.text === 'string' ? tailed.text : '';
    };

    const SEND_ATTEMPTS = 8;
    const WAIT_PER_ATTEMPT_MS = 3000;

    // Fault injection, so the recovery above is demonstrated rather than
    // assumed. The condition it models — keystrokes written to a pane whose
    // shell has not reached its `read` and are therefore dropped — is real but
    // load-dependent, so it cannot be summoned on demand: a green run proves
    // the check passes, not that the retry works, and a retry nobody has ever
    // seen fire is a retry nobody has tested. Setting this makes the first N
    // attempts skip the write entirely, which is exactly what the shell not
    // reading looks like from here.
    const dropFirstSends = Number(process.env.KAN25_DROP_FIRST_SENDS ?? 0);
    if (dropFirstSends > 0) {
      console.log(
        `\n  [fault injection] KAN25_DROP_FIRST_SENDS=${dropFirstSends}: the first ` +
        `${dropFirstSends} send(s) will not be written, modelling keystrokes lost to a ` +
        `shell that is not yet reading`
      );
    }

    let seen = false;
    let attemptsUsed = 0;
    let tail = '';
    for (let attempt = 1; attempt <= SEND_ATTEMPTS && !seen; attempt++) {
      attemptsUsed = attempt;
      if (attempt > dropFirstSends) {
        await call('pty_input', { sessionId: activated.sessionId, data: `echo ${marker}\n` });
      }
      const deadline = Date.now() + WAIT_PER_ATTEMPT_MS;
      while (Date.now() < deadline && !seen) {
        await sleep(250);
        const text = await paneText();
        tail = text.slice(-400);
        // herdr's TUI draws a character at a time, each preceded by an explicit
        // cursor move, so the marker is never a contiguous substring of the raw
        // text. Escapes out, order preserved, and it reads normally.
        seen = deescape(text).includes(marker);
      }
    }

    // The stream is a separate fact from delivery and is checked separately:
    // anything at all arriving on the listener the re-init registered proves it
    // is live. Grepping the streamed chunks for the marker would conflate the
    // two — a full-screen TUI repaints in fragments and can split a short
    // string across two writes.
    const streamed = unsolicited.filter(
      (m) => m.action === 'pty_output' && m.sessionId === activated.sessionId
    );

    console.log(
      `\n  round trip: '${marker}' ${seen ? 'echoed' : 'NEVER appeared'} after ` +
      `${attemptsUsed} send attempt(s) of at most ${SEND_ATTEMPTS} ` +
      `(${WAIT_PER_ATTEMPT_MS}ms each)`
    );
    if (seen && attemptsUsed > 1) {
      console.log(
        '  (a resend was needed — the first keystrokes reached a shell that was not yet\n' +
        '   reading, which is the condition that used to fail this check outright)'
      );
    }
    if (!seen) {
      console.log('\n  last 400 chars of the pane (escapes shown), for diagnosis:');
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
      seen
        ? `'${marker}' echoed back after ${attemptsUsed} send attempt(s)`
        : `'${marker}' never appeared after ${SEND_ATTEMPTS} send attempts`
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
