// Live proof for KAN-280: a real CrabCast daemon REFUSES a PTY request whose
// payload it cannot act on, in its own words, and a caller can tell that
// refusal from the unknown-session one without reading either sentence.
//
// WHAT FAILURE THIS WOULD CATCH: a PTY handler that hands an unvalidated
// payload to node-pty. That single absent check produced THREE defects failing
// in three different directions, and this file keeps them named and sectioned
// apart rather than collapsing them into "payloads are validated now" — they
// are different failures with different remedies, and a future reader needs all
// three names.
//
//   DEFECT 1 — THE LEAKED TYPE ERROR (§2, §3). `pty_input` with no `data`
//   answered with the dependency's own sentence, `The first argument must be of
//   type string or an instance of Buffer … Received undefined`, reaching the
//   caller from the daemon's catch-all with NO `action` field on it at all. A
//   Node type error reads like an internal fault, so the caller's correct
//   response — fix my payload — is the one the message does not suggest, and a
//   caller cannot tell "I sent a malformed request" from "CrabCast broke". The
//   missing `action` is the sharper half: a client that dispatches on `action`
//   cannot route the error to the request it belongs to.
//
//   DEFECT 2 — THE SILENT FALSE SUCCESS (§4). `pty_resize` with no `cols`/`rows`
//   answered `success: true` for a resize it never attempted. `resizePty` guards
//   with `cols > 0 && rows > 0`; `undefined > 0` is false, so the guard written
//   to skip a meaningless resize silently became a filter that skipped a
//   malformed one and reported success anyway. Nothing threw and nothing leaked.
//
//   DEFECT 3 — THE ACCEPTED ARRAY (§2). `pty_input` with `data: ["a"]` was
//   ACCEPTED — `success: true` — because node-pty takes Array-likes, and
//   `Buffer.from(['a'])` is a NUL byte. The daemon wrote a NUL into somebody's
//   terminal and called it success.
//
// WHICH OF THE THREE A CALLER COULD HAVE FOUND, which is the pattern worth
// recording: only DEFECT 1. It came back as an error, and the first real
// consumer to build against this socket duly reported it. DEFECTS 2 AND 3 both
// answered `success: true` — invisible from the wire, detectable only by
// watching a terminal that did not resize or reading a NUL nobody prints. The
// reported defect was the visible one; the two worse ones were silent.
//
// DEFECT 3 WAS FOUND BY RUNNING THE RED, NOT BY READING THE HANDLER. No amount
// of reading `writePty` reveals that node-pty accepts an Array-like or that
// `Buffer.from(['a'])` is a NUL — it surfaced because this script was pointed at
// a pre-fix build and one case came back green when every sibling came back
// red. That is the argument for demonstrating a failure rather than describing
// one.
//
// ---------------------------------------------------------------------------
// WHAT DEFENDS THE CENTRAL ASSERTION — a negative/positive pair on one predicate
// ---------------------------------------------------------------------------
//
// The vacuous version of this proof asserts "a refusal came back" and passes
// against a build that refuses EVERYTHING, valid input included. Three things
// in here go red on such a build:
//
//   1. §5 requires the two refusals to carry DIFFERENT `refusal` values —
//      `invalid_payload` for a bad payload, `unknown_session` for a bad id. A
//      daemon that refuses uniformly fails this even though both are refusals.
//   2. §6 requires a WELL-FORMED pty_input to succeed AND its keystrokes to
//      arrive in the real terminal, read back off the pane. Success alone would
//      not do: `success: true` for something that never happened is the exact
//      defect §4 covers on the resize path, and a proof that accepted it here
//      would be making the mistake it is checking for elsewhere.
//   3. §4 requires a well-formed resize to succeed.
//
// So "refuses" is never asserted on its own: every refusal in here is paired
// with a case that must NOT be refused, and with the value that says which
// refusal it is.
//
// DEMONSTRATING IT GOING RED. This script takes `--dist`, so the recipe is two
// runs rather than an argument:
//
//   git worktree add /tmp/kan280-prefix <merge-base>
//   cd /tmp/kan280-prefix && ln -s <this-checkout>/node_modules . && npx tsc
//   node scripts/verify-pty-payload-refusal.mjs --dist /tmp/kan280-prefix/dist   # RED
//   node scripts/verify-pty-payload-refusal.mjs                                  # GREEN
//
// The red run is not a stack trace escaping the script: the pre-fix daemon
// answers, and §3 reports the dependency sentence it answered with.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT PROVE — the edge of this file, marked so nobody infers past it
// ---------------------------------------------------------------------------
//
//   - It drives the daemon over its real socket and asserts on what comes back,
//     so it covers the handler and the wire. It does NOT construct a response
//     and assert on that, which is the shape that proves only that the test
//     author can build an object.
//   - §4 asserts a well-formed resize is ACCEPTED. It does not observe the
//     terminal actually changing width, so "a valid resize still resizes" is
//     not established here — only that it is not refused. Nothing else in this
//     suite covers it either. That gap is pre-existing rather than opened by
//     KAN-280, whose change is confined to which payloads are refused, and it
//     is written down because an unstated gap reads as coverage.
//   - The `data` values it sends are the ones JSON can carry. A Buffer cannot
//     cross this socket, so "a Buffer payload is accepted" is not a claim this
//     proof makes or that the handler makes.
//
// Everything here runs against real processes, isolated exactly as its sibling
// `verify-pty-init-rejects-unknown-session.mjs` is: by $HOME, an explicit
// scratch dataDir, and HERDR_SOCKET_PATH, so no agent started here can appear
// on — or disturb — the live fleet. The live daemon at ~/.local/share/crabcast
// is never contacted.
//
// Usage:
//   npm run build
//   node scripts/verify-pty-payload-refusal.mjs [--dist <dir>]
//
//   --dist <dir>  run a different compiled daemon than this checkout's dist.
//
// Exit code 0 means every check passed.

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
const scratch = mkdtempSync('/tmp/kan280-');
const fakeHome = path.join(scratch, 'home');
const herdrSocket = path.join(scratch, 'h.sock');
const herdrState = path.join(scratch, 'herdr-state');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(herdrState, { recursive: true });

const dataDir = path.join(fakeHome, '.local', 'share', 'crabcast');
const configPath = path.join(fakeHome, 'crabcast.config.json');
writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

/** The directory this proof's one agent is. CrabCast creates none of its own. */
const AGENT_DIR = path.join(fakeHome, 'owned', 'kan-280-verify');
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

const socketPath = path.join(dataDir, 'crabcast.sock');

const results = [];
const record = (name, passed, note) => {
  results.push({ name, passed, note });
  console.log(`\n  ${passed ? 'PASS' : 'FAIL'}: ${name}${note ? ` — ${note}` : ''}`);
};

const banner = (title) => {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
};

// --- a private herdr, so a spawn cannot reach the live server -----------------
//
// A REAL SESSION IS A PRECONDITION HERE, NOT A CONVENIENCE, and that is why
// this proof cannot degrade to a herdr-less mode the way its sibling can. The
// payload check sits BEHIND the session check by design — a request that is
// wrong in both ways is still answered with the session refusal, as it always
// was — so the payload refusal is unreachable without a session the daemon
// genuinely holds. No herdr means no session means nothing to prove, and
// saying "skipped" would be a green run that checked the subject not at all.
let herdrAvailable = false;
try {
  execFileSync('which', ['herdr'], { stdio: 'ignore' });
  herdrAvailable = true;
} catch {}

if (!herdrAvailable) {
  console.error(
    'herdr is not on PATH. This proof needs a real PTY session: the payload refusal is only\n' +
    'reachable once a session exists, so there is nothing here to check without one.'
  );
  process.exit(1);
}

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
let herdrUp = false;
for (let i = 0; i < 20; i++) {
  try {
    run('herdr', ['pane', 'list'], isolatedEnv);
    herdrUp = true;
    break;
  } catch {
    await sleep(500);
  }
}
if (!herdrUp) {
  console.error('the private herdr server did not come up');
  process.exit(1);
}

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
    }
  }
});

let nextId = 0;
// EVERY REQUEST CARRIES AN `id`. The PTY acks are correlated-only — a streaming
// client that sends no id gets no ack, so that a terminal does not receive one
// message per keystroke — and a proof that sent none would wait forever for a
// refusal the daemon was never going to address to it.
const call = (action, data = {}) =>
  new Promise((resolve) => {
    const id = `kan280-${++nextId}`;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ action, ...data, id }) + '\n');
  });

/**
 * The dependency's own sentence, which is what must NOT come back.
 *
 * Matched loosely on purpose: node-pty's wording varies by what it received
 * ("Received undefined", "Received type number (42)"), and the part that
 * identifies it as a leaked internal error is the stem.
 */
const NODE_TYPE_ERROR = 'must be of type string or an instance of Buffer';

// --- 1. a real session, which everything below is measured against -----------
banner('1. a real session — the precondition the payload path sits behind');

// `shell` explicitly: what this needs is a PTY the daemon genuinely holds a
// session for, not a coding agent. `override: true` with it — the capacity gate
// measures the real machine, and whether this box is busy is not the subject.
await call('configure_agent', { path: AGENT_DIR, priority: 1, launcher: 'shell' });
const activated = await call('activate_agent', { path: AGENT_DIR, override: true });
console.log('activate_agent →', JSON.stringify({ success: activated.success, sessionId: activated.sessionId, error: activated.error }, null, 2));

if (!activated.success) {
  console.error('\nno session could be started, so nothing below would be measuring anything.');
  console.error(activated.error);
  process.exit(1);
}

const SESSION = activated.sessionId;
let ready;
for (let i = 0; i < 40; i++) {
  ready = await call('pty_init', { sessionId: SESSION });
  if (ready.success === true) break;
  await sleep(250);
}
record(
  'the daemon holds a real session to test against',
  ready?.success === true,
  ready?.success === true ? SESSION : ready?.error
);
if (ready?.success !== true) {
  banner('verdict');
  console.log('  FAIL  the precondition did not hold; no payload claim was measured.');
  process.exit(1);
}

// --- 2. the reported defect --------------------------------------------------
banner('2. DEFECT 1 (the leaked type error) and DEFECT 3 (the accepted array) — pty_input payloads');

const MALFORMED = [
  { label: 'no `data` field at all', payload: {} },
  { label: 'data: null', payload: { data: null } },
  { label: 'data: 42 (a number)', payload: { data: 42 } },
  { label: 'data: {} (an object)', payload: { data: {} } },
  // DEFECT 3 lives in this row. On the pre-fix build it is the ONE case here
  // that came back success: true — node-pty accepts an Array-like, and
  // Buffer.from(['a']) is a NUL byte written into a real terminal. §2b asserts
  // it by name so that it cannot regress back into "one of five malformed
  // payloads", which is how it stayed invisible in the first place.
  { label: 'data: ["a"] (an array)', payload: { data: ['a'] } }
];

const inputRefusals = [];
for (const { label, payload } of MALFORMED) {
  const res = await call('pty_input', { sessionId: SESSION, ...payload });
  console.log(`\n  ${label} →`);
  console.log('  ' + JSON.stringify(res));
  inputRefusals.push({ label, res });
}

record(
  'DEFECT 1/3: every malformed pty_input is refused (success: false)',
  inputRefusals.every(({ res }) => res.success === false),
  inputRefusals.filter(({ res }) => res.success !== false).map(({ label }) => label).join(', ') || undefined
);
record(
  'DEFECT 1: each refusal is addressed as a pty_input_response — not the daemon\'s catch-all',
  inputRefusals.every(({ res }) => res.action === 'pty_input_response'),
  inputRefusals.filter(({ res }) => res.action !== 'pty_input_response').map(({ label, res }) => `${label}: action=${JSON.stringify(res.action)}`).join(', ') || undefined
);
record(
  'DEFECT 1: each refusal names the field and what was expected',
  inputRefusals.every(({ res }) => typeof res.error === 'string' && res.error.includes('`data`') && res.error.includes('string')),
  inputRefusals.filter(({ res }) => !(typeof res.error === 'string' && res.error.includes('`data`') && res.error.includes('string'))).map(({ label }) => label).join(', ') || undefined
);

// --- 2b. DEFECT 3, asserted by name ------------------------------------------
banner('2b. DEFECT 3 — an array payload is REFUSED, not written to the terminal as a NUL');
const arrayCase = inputRefusals.find(({ label }) => label.startsWith('data: ["a"]'));
console.log('\n  ' + JSON.stringify(arrayCase.res));
console.log(
  '\n  On the pre-fix build this row answered success: true — node-pty accepts an Array-like,\n' +
  "  and Buffer.from(['a']) is a NUL byte. It is asserted separately from its four siblings\n" +
  '  because it failed in the opposite direction to them: they leaked an error, this one\n' +
  '  reported success for a write nobody could see.'
);
record(
  'DEFECT 3: an array payload is refused rather than silently written as a NUL byte',
  arrayCase.res.success === false && arrayCase.res.refusal === 'invalid_payload',
  arrayCase.res.success === false ? undefined : 'ACCEPTED — a NUL byte reached the terminal'
);

// --- 3. no dependency text reaches the caller --------------------------------
banner('3. DEFECT 1 — the dependency\'s own error text must not reach the caller');
const leaked = inputRefusals.filter(({ res }) => typeof res.error === 'string' && res.error.includes(NODE_TYPE_ERROR));
for (const { label, res } of leaked) {
  console.log(`\n  LEAKED on ${label}:`);
  console.log('  ' + JSON.stringify(res.error));
}
if (leaked.length === 0) console.log('\n  none of the refusals carry node-pty\'s type error.');
record(
  'DEFECT 1: no refusal carries node-pty\'s internal type error',
  leaked.length === 0,
  leaked.length === 0 ? undefined : `${leaked.length} of ${inputRefusals.length} leaked it`
);

// --- 4. the siblings ---------------------------------------------------------
banner('4. DEFECT 2 — pty_resize answered success: true for a resize it never attempted');

const resizeBad = await call('pty_resize', { sessionId: SESSION });
console.log('\n  no cols/rows →');
console.log('  ' + JSON.stringify(resizeBad));
const resizeStrings = await call('pty_resize', { sessionId: SESSION, cols: 'wide', rows: 'tall' });
console.log('\n  cols/rows as strings →');
console.log('  ' + JSON.stringify(resizeStrings));
const resizeZero = await call('pty_resize', { sessionId: SESSION, cols: 0, rows: 0 });
console.log('\n  cols/rows of zero →');
console.log('  ' + JSON.stringify(resizeZero));

record(
  'DEFECT 2: a resize carrying no dimensions is REFUSED, not answered success: true',
  resizeBad.success === false && resizeBad.action === 'pty_resize_response',
  resizeBad.success === false ? undefined : 'answered success: true for a resize it never attempted'
);
record(
  'DEFECT 2: a resize whose dimensions are not numbers is refused',
  resizeStrings.success === false,
  resizeStrings.success === false ? undefined : 'answered success: true'
);
record(
  'DEFECT 2: a resize of zero cells is refused',
  resizeZero.success === false,
  resizeZero.success === false ? undefined : 'answered success: true'
);
record(
  'DEFECT 2: the resize refusal names both fields and says the session was not resized',
  typeof resizeBad.error === 'string' &&
    resizeBad.error.includes('`cols`') &&
    resizeBad.error.includes('`rows`') &&
    /not resized/i.test(resizeBad.error),
  typeof resizeBad.error === 'string' ? undefined : 'no error text at all'
);

// POSITIVE HALF of §4 — a well-formed resize must still be accepted. Without
// this the three checks above pass against a daemon that refuses every resize.
const resizeGood = await call('pty_resize', { sessionId: SESSION, cols: 100, rows: 40 });
console.log('\n  a well-formed resize (100x40) →');
console.log('  ' + JSON.stringify(resizeGood));
record(
  'a well-formed resize is still accepted',
  resizeGood.success === true,
  resizeGood.success === true ? undefined : resizeGood.error
);

banner('4b. pty_init — the third sibling, checked and reported either way');
// pty_init carries no payload beyond `sessionId`, which `ptySessionId` has
// always validated and which §5 exercises. There is no second field to be
// malformed, so it has no equivalent of the gap above — reported here because
// an unreported look and an unperformed one are indistinguishable later.
const initGood = await call('pty_init', { sessionId: SESSION });
console.log('\n  pty_init on the real session →');
console.log('  ' + JSON.stringify({ ...initGood, buffer: `<${(initGood.buffer ?? '').length} chars>` }));
record(
  'pty_init takes no payload beyond sessionId, and still accepts a real session',
  initGood.success === true,
  'no second field exists on this action to be malformed'
);

// --- 5. the two refusals are distinguishable by VALUE ------------------------
banner('5. "wrong payload" and "wrong session" are told apart without string-matching');

const wrongSession = await call('pty_input', { sessionId: 'kan-280-no-such-session', data: 'x' });
console.log('\n  unknown session →');
console.log('  ' + JSON.stringify(wrongSession));
const wrongPayload = inputRefusals[0].res;
console.log('\n  malformed payload →');
console.log('  ' + JSON.stringify(wrongPayload));

record(
  'the unknown-session refusal carries refusal: unknown_session',
  wrongSession.success === false && wrongSession.refusal === 'unknown_session',
  `refusal=${JSON.stringify(wrongSession.refusal)}`
);
record(
  'the malformed-payload refusal carries refusal: invalid_payload',
  wrongPayload.success === false && wrongPayload.refusal === 'invalid_payload',
  `refusal=${JSON.stringify(wrongPayload.refusal)}`
);
// THE ASSERTION THE TICKET IS ABOUT. Both are refusals and both carry an
// `error` written for a human; what a caller acts on is that these two values
// DIFFER. A daemon that refused everything with one code would pass every
// "was it refused?" check above and fail this one.
record(
  'the two refusals differ by value, so no caller has to match on the message text',
  wrongSession.refusal !== wrongPayload.refusal &&
    typeof wrongSession.refusal === 'string' &&
    typeof wrongPayload.refusal === 'string',
  `${JSON.stringify(wrongSession.refusal)} vs ${JSON.stringify(wrongPayload.refusal)}`
);
record(
  'a malformed payload does NOT report the session as the problem',
  wrongPayload.refusal !== 'unknown_session' && !/does not have/.test(wrongPayload.error ?? ''),
  'the session named was valid, and the refusal says so'
);

// --- 5b. THE PRECEDENCE, asserted rather than described ----------------------
banner('5b. a request wrong in BOTH ways reports the SESSION — the dangerous condition wins');

// WHY THIS SECTION EXISTS, AND IT WAS ADDED IN REVIEW. The handlers carry a
// comment saying the session is checked first and that validating the payload
// first "would have quietly swapped which of the two a caller is told about".
// That paragraph names the exact refactor that breaks the property — and until
// this section, nothing went red when somebody performed it. The reviewer of
// PR #72 did perform it, by adding `&& this.ptyInputRefusal(data) === null` to
// the session-check condition, and this proof stayed green at 19/19. A comment
// warning about a change, with no assertion behind the warning, is a claim
// outrunning its mechanism, which is the defect this whole suite is organised
// against.
//
// AND THE CONSEQUENCE IS NOT COSMETIC. Under the swap, a caller who sends a
// fabricated session id AND a malformed payload is told the PAYLOAD is wrong.
// They fix the payload, retry, and are still writing at a session that does not
// exist — which is the condition `handlePtyInput`'s own comment calls the most
// dangerous of the three, because keystrokes sent to a session picked on the
// client's behalf land in some other agent's terminal. The precedence exists so
// that the dangerous condition is the one reported, and it is exactly the one
// that goes unreported under the swap.
//
// Asserted for BOTH handlers. `handlePtyResize` carries the same precedence by
// reference ("Session first, for the reason given in handlePtyInput above"), so
// a proof that pinned it on only one of them would leave the sibling free to
// drift — which is the AC 3 lesson of this ticket applied to its own proof.
const bothWrongInput = await call('pty_input', { sessionId: 'kan-280-no-such-session' });
console.log('\n  pty_input, fabricated session AND no `data` →');
console.log('  ' + JSON.stringify(bothWrongInput));
const bothWrongResize = await call('pty_resize', { sessionId: 'kan-280-no-such-session' });
console.log('\n  pty_resize, fabricated session AND no cols/rows →');
console.log('  ' + JSON.stringify(bothWrongResize));

record(
  'PRECEDENCE: pty_input wrong in both ways reports unknown_session, not invalid_payload',
  bothWrongInput.success === false && bothWrongInput.refusal === 'unknown_session',
  bothWrongInput.refusal === 'unknown_session'
    ? undefined
    : `got refusal=${JSON.stringify(bothWrongInput.refusal)} — the payload check has been moved in front of the session check, and a caller with a dead session is being told to fix its payload`
);
record(
  'PRECEDENCE: pty_resize wrong in both ways reports unknown_session, not invalid_payload',
  bothWrongResize.success === false && bothWrongResize.refusal === 'unknown_session',
  bothWrongResize.refusal === 'unknown_session'
    ? undefined
    : `got refusal=${JSON.stringify(bothWrongResize.refusal)} — same swap on the sibling handler`
);
// The refusal must also SAY the session is the problem, not merely be tagged
// with it: a swap that moved the code but kept the tag would pass the two
// checks above while telling the caller to fix its payload in prose.
record(
  'PRECEDENCE: and the doubly-wrong refusal names the session in its text, not the payload',
  /does not have/.test(bothWrongInput.error ?? '') && !/`data`/.test(bothWrongInput.error ?? ''),
  /does not have/.test(bothWrongInput.error ?? '') ? undefined : `error was ${JSON.stringify(bothWrongInput.error)}`
);

// --- 6. the positive control: valid input still reaches the terminal ---------
banner('6. a well-formed pty_input still works, and its keystrokes really arrive');

const deescape = (text) => text.replace(/\[[0-9;?]*[a-zA-Z]/g, '');
const paneText = async () => {
  const tailed = await call('tail_agent', { path: AGENT_DIR, lines: 200 });
  return typeof tailed.text === 'string' ? tailed.text : '';
};

const marker = 'kan280-round-trip';
// DELIVERY IS ASSERTED, NOT ASSUMED, and it is retried for the reason the
// sibling proof documents at length (KAN-88 item 11): keystrokes written to a
// pane whose shell has not yet reached its `read` are dropped by the terminal,
// which is load-dependent and was the source of a real CI flake. A resend costs
// a second; a PTY that genuinely never delivers still fails.
const SEND_ATTEMPTS = 8;
const WAIT_PER_ATTEMPT_MS = 3000;
let seen = false;
let attemptsUsed = 0;
let lastAck;
let tail = '';
for (let attempt = 1; attempt <= SEND_ATTEMPTS && !seen; attempt++) {
  attemptsUsed = attempt;
  lastAck = await call('pty_input', { sessionId: SESSION, data: `echo ${marker}\n` });
  const deadline = Date.now() + WAIT_PER_ATTEMPT_MS;
  while (Date.now() < deadline && !seen) {
    await sleep(250);
    const text = await paneText();
    tail = text.slice(-400);
    seen = deescape(text).includes(marker);
  }
}

console.log(`\n  well-formed pty_input → ${JSON.stringify(lastAck)}`);
console.log(
  `  round trip: '${marker}' ${seen ? 'echoed' : 'NEVER appeared'} after ${attemptsUsed} ` +
  `send attempt(s) of at most ${SEND_ATTEMPTS} (${WAIT_PER_ATTEMPT_MS}ms each)`
);
if (!seen) {
  console.log('\n  last 400 chars of the pane (escapes shown), for diagnosis:');
  console.log('  ' + JSON.stringify(tail));
}

record(
  'a well-formed pty_input is accepted',
  lastAck?.success === true,
  lastAck?.success === true ? undefined : lastAck?.error
);
// The strongest of the anti-vacuity checks, and the one that makes the refusals
// above mean something: the fix refuses malformed payloads WITHOUT having
// quietly stopped writing the well-formed ones. `success: true` would not be
// enough on its own — that is precisely the claim §4 caught the resize path
// making falsely.
record(
  'and its keystrokes reach the real terminal — the refusal did not widen to everything',
  seen,
  seen ? `'${marker}' echoed back after ${attemptsUsed} send attempt(s)` : `'${marker}' never appeared`
);
// An empty string is a legitimate no-op write, and refusing it would be this
// handler inventing a constraint the terminal does not have.
const emptyWrite = await call('pty_input', { sessionId: SESSION, data: '' });
console.log(`\n  pty_input with data: '' → ${JSON.stringify(emptyWrite)}`);
record(
  'an empty string is a write of nothing, not a malformed payload',
  emptyWrite.success === true,
  emptyWrite.success === true ? undefined : emptyWrite.error
);

await call('deactivate', { sessionId: SESSION });

// --- verdict -----------------------------------------------------------------
banner('verdict');
for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? ` (${r.note})` : ''}`);
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

socket.end();
process.exit(failed.length === 0 ? 0 : 1);
