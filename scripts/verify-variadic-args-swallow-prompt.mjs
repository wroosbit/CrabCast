#!/usr/bin/env node
// KAN-514: a caller's VARIADIC argument written as two elements eats the
// prompt, the `=` form does not, and every surface that documents `args` says
// so.
//
// WHAT FAILURE THIS WOULD CATCH: the `args` documentation losing the warning —
// a rewritten MCP description, a tidied `--help` line, a README paragraph
// trimmed — while the argv layout that makes the warning necessary is
// unchanged. The next caller then writes `["--flag", "value"]`, which is the
// obvious form and the one the surfaces recommended until this ticket, and
// EVERY spawn for that agent wedges with an error that blames the prompt's
// content. That is what happened to KAN-504's first consumer, off KAN-504's
// own published ordering. §4 is the section that would go red.
//
// It would also catch the other half, which is the half that makes the first
// half true: the LAYOUT changing so that the documented hazard no longer
// exists (§1, §2). A page warning about a swallow that can no longer happen is
// not harmless — it is an instruction to write `=` for a reason that has gone,
// and the next reader cannot tell that from a live one. Both directions are
// red here, deliberately, which is what makes this a claim with a checker
// rather than a phrase this repository happens to contain.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT IS MEASURED HERE, AND WHAT IS A STAND-IN. Read this before the
// verdict, because the distinction is the whole of what this proof is worth.
// ---------------------------------------------------------------------------
//
//   MEASURED, from the kernel: the argv of the process CrabCast actually
//     started, read out of `/proc/self/cmdline` by that process itself. That
//     is CrabCast's whole half of the mechanism — the caller's args sit
//     between CrabCast's flags and the prompt, and the prompt is a BARE
//     OPERAND carrying no flag of its own.
//
//   A STAND-IN: the parser. The `claude` on this proof's PATH is a fixture,
//     and its variadic option implements the ordinary rule — take following
//     arguments until one begins with `-`, or until argv ends. CrabCast cannot
//     prove what the real Claude Code binary does with an argv, and no script
//     in this repository could; that is the runtime's behaviour.
//
//   MEASURED ELSEWHERE, ON THE REAL BINARY, and quoted rather than re-run
//     here: `task/KAN-496` reproduced this against real `claude`, and KAN-514's
//     author reproduced it again on Claude Code 2.1.234 under a PTY — the
//     two-element form dies with `--dangerously-load-development-channels
//     entries must be tagged: say hi`, naming the PROMPT as the malformed
//     entry, and the `=` form starts the client with the prompt intact. That
//     transcript is in the pull request. It is not in CI because the real
//     binary is not on a runner.
//
// ⚠ SO THE STAND-IN MUST NOT BE THE EXPLANATION OF THE DIFFERENCE, and §3 is
// what stops it being one. Every arm below runs the SAME fixture, the SAME
// daemon and the SAME command, with ONE variable changed. §3 additionally
// shows the fixture starting cleanly with no args at all, with a FIXED-ARITY
// flag written the two-element way, and with the variadic flag when no operand
// follows it — three ways for the fixture to have been rigged toward failure,
// all of which come back green. What is left is the argument form.
//
// ---------------------------------------------------------------------------
// IT MUST NOT TOUCH THE RUNNING FLEET, and §5 is where it says so rather than
// where it hopes so. Every daemon, socket, data dir, HOME, PATH and process
// here is scratch and under one temp root.
//
// Needs node and bash. No real herdr, no real claude, no network, no PTY.
//
// Usage:
//   npm run build
//   node scripts/verify-variadic-args-swallow-prompt.mjs [distDir] [pagesDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { sweepScratchRoot, killScratchRootSync, describe } from './scratch-processes.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));
/**
 * Where §4 reads the PAGES from — `README.md` and `docs/launcher-args.md`.
 *
 * A PARAMETER FOR THE SAME REASON `distDir` IS ONE, and not for a reason of
 * its own: §4 asserts that four surfaces carry a warning, and a section that
 * has only ever been observed passing is a section nobody has shown to be a
 * gate. Two of the four live in the compiled build and `kan514-red-drive.mjs`
 * reddens them by mutating it; the other two are files in the repository, and
 * without this seam nothing could redden them at all. Defaults to the real
 * repository, so an ordinary run reads the real pages.
 */
const pagesRoot = path.resolve(process.argv[3] ?? repoRoot);

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

function rule(title) {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

/**
 * The live fleet's registry mtime, taken BEFORE this proof does anything.
 *
 * At the top rather than in §5: a baseline read afterwards would be a
 * comparison against a value this run could already have moved, which is a
 * check that cannot fail. `null` when there is no live CrabCast here, and §5
 * says so in words rather than reporting a vacuous pass as a measurement.
 */
const realAgentsLog = path.join(os.homedir(), '.local', 'share', 'crabcast', 'agents.jsonl');
const realAgentsLogMtimeAtStart = (() => {
  try { return fs.statSync(realAgentsLog).mtimeMs; } catch { return null; }
})();

// --------------------------------------------------------------- the scratch
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan514-'));
const home = path.join(tmp, 'home');
const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
const shimState = path.join(tmp, 'shim-state');
const records = path.join(tmp, 'records');
const bin = path.join(tmp, 'bin');
for (const d of [home, shimState, records, bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));

/**
 * The fake `claude` spawns this script makes by hand.
 *
 * ⚠ THIS IS NO LONGER WHAT §5 ASSERTS ON, and the distinction is the whole of
 * KAN-529. The sections above genuinely want it — "this arm produced a live
 * process" is a claim about a pid — but as a TEARDOWN population it was wrong
 * in two directions at once: it missed the scratch daemon and its `herdr agent
 * attach` children entirely, and it did not even hold every fake `claude`,
 * because the pid a fixture reports is not the pid of the `bash` wrapper that
 * `exec`s toward it. §5 asks the machine instead. See `scratch-processes.mjs`.
 */
const spawnedPids = new Set();

/**
 * ⚠ SYNCHRONOUS, and `killScratchRootSync` says why: a signal handler that
 * awaited would reach `process.exit` before the sweep it started had finished,
 * so the polite wave would be the only one that ever ran.
 */
function cleanUp() {
  let swept = 0;
  try { swept = killScratchRootSync(tmp); } catch {}
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return swept;
}
// Handlers as well as the ordinary path: a Ctrl+C or a CI timeout skips §5
// entirely, and a proof whose failure mode is `sleep` processes left on a
// shared machine is a proof that gets switched off.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    // The count comes from the sweep rather than from `spawnedPids.size`,
    // which is what this line used to print and which named a population that
    // was never the one being cleaned up.
    const swept = cleanUp();
    console.log(`\n[verify-variadic-args-swallow-prompt] ${signal} — killed ${swept} ` +
      `process(es) carrying ${tmp} and removed it`);
    process.exit(130);
  });
}

/**
 * The stand-in consumer, on PATH as `claude`.
 *
 * ⚠ ITS PARSER IS THE STAND-IN AND ITS ARGV IS NOT. Before it decides anything
 * it copies `/proc/$$/cmdline` — the kernel's own record of what it was
 * started with — into the record file. Every assertion in §1 and §2 about the
 * COMMAND LINE reads those bytes; only the assertions about what a variadic
 * option would DO with them read the parse below.
 *
 * The variadic rule implemented here is the ordinary one: after
 * `--dangerously-load-development-channels`, take arguments until one begins
 * with `-` or argv ends. `--flag=value` binds its value and takes nothing
 * further. `--tag` is the fixed-arity control — exactly one value, whatever
 * follows it — and §3 is what it is for.
 *
 * A BASH SCRIPT AND NOT AN `exec`: it stays the process it was started as, so
 * `/proc/$$/cmdline` holds the argv the launcher built rather than something
 * else's.
 *
 * `--continue` exits 1 unless a marker file exists, which is what the real
 * claude does in a directory with no history and what makes the launcher's
 * `||` fallback reachable. Every arm here wants the fallback: the prompt is on
 * that branch.
 */
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
# ⚠ THE --continue INVOCATION FAILS BEFORE IT RECORDS ANYTHING, and that is
# deliberate rather than incidental. The launcher builds
# \`claude … --continue || claude … '<prompt>'\`, so both halves may run; if the
# first recorded, the second's record would race it and every section below
# would be reading whichever won. This is also what the real claude does in a
# directory with no history, and it is what makes the \`||\` fallback — the
# branch that carries the prompt — the branch under test.
for a in "$@"; do
  if [ "$a" = "--continue" ]; then
    if [ ! -f "$CRABCAST_KAN514_CONVERSATION" ]; then
      echo "No conversation found to continue" >&2
      exit 1
    fi
  fi
done

# The arm is the agent's own directory name; one daemon serves every arm, so
# there is no per-arm environment to read this from.
arm=$(basename "$PWD")
rec="$CRABCAST_KAN514_RECORDS/$arm"

# THE KERNEL'S COPY, taken before this script has looked at a single argument.
tr '\\0' '\\n' < /proc/$$/cmdline > "$rec.cmdline"

# NUL-separated, appended as they are parsed: no arrays, no JSON, no quoting
# rule of this fixture's own that could be the thing a section is measuring.
: > "$rec.entries"
: > "$rec.operands"
: > "$rec.tags"

V=--dangerously-load-development-channels

while [ $# -gt 0 ]; do
  case "$1" in
    "$V")
      shift
      # VARIADIC: keep taking arguments until one looks like an option, or
      # until argv ends. The prompt is neither.
      while [ $# -gt 0 ]; do
        case "$1" in
          -*) break ;;
          *) printf '%s\\0' "$1" >> "$rec.entries"; shift ;;
        esac
      done
      ;;
    "$V"=*)
      # BOUND: the value came attached, so nothing further is read.
      printf '%s\\0' "\${1#*=}" >> "$rec.entries"
      shift
      ;;
    --tag)
      # FIXED ARITY: exactly one value, then stop. §3(b)'s control.
      shift
      printf '%s\\0' "$1" >> "$rec.tags"
      shift
      ;;
    --permission-mode)
      shift
      shift
      ;;
    -*)
      shift
      ;;
    *)
      printf '%s\\0' "$1" >> "$rec.operands"
      shift
      ;;
  esac
done

# THE TAGGING CHECK, in the real binary's own words. An untagged entry is
# refused — and when the prompt has been swallowed, the PROMPT is the untagged
# entry, so this is the message a caller actually meets.
while IFS= read -r -d '' e; do
  case "$e" in
    server:*|plugin:*) ;;
    *)
      echo "--dangerously-load-development-channels entries must be tagged: $e" > "$rec.err"
      exit 1
      ;;
  esac
done < "$rec.entries"

echo $$ > "$rec.pid"
sleep 600
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);

/**
 * The herdr shim — it REALLY STARTS what it is handed.
 *
 * A shim that acknowledged the start without running it would leave every
 * assertion below about a string CrabCast composed rather than a process it
 * created, which is the schema check this proof exists to rule out.
 */
const shimImpl = path.join(bin, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
const state = process.env.CRABCAST_KAN514_SHIM_STATE;
const args = process.argv.slice(2);
const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const [a, b] = args;
if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
if (a === 'agent' && b === 'get') {
  const f = load().find((s) => s.name === args[2]);
  if (f) out({ result: { agent: { name: f.name, pane_id: f.pane_id, cwd: f.cwd, agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx === -1 ? process.cwd() : args[cwdIdx + 1];
  const sep = args.indexOf('--');
  const argv = sep === -1 ? [] : args.slice(sep + 1);
  let pid = null;
  if (argv.length) {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid;
  }
  const rec = { name: args[2], pane_id: String(100 + started.length), cwd, argv, pid };
  started.push(rec);
  save(started);
  out({ result: { agent: { name: rec.name, pane_id: rec.pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a !== 'agent') { out({ result: {} }); }
`);
fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(bin, 'herdr'), 0o755);

const conversationMarker = path.join(tmp, 'conversation-exists');

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
  PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_KAN514_SHIM_STATE: shimState,
  CRABCAST_KAN514_RECORDS: records,
  CRABCAST_KAN514_CONVERSATION: conversationMarker,
  CRABCAST_CONFIG: undefined
};

const cliJs = path.join(distDir, 'cli.js');
const mcpJs = path.join(distDir, 'mcp.js');
const crabcast = (argv) =>
  spawnSync(process.execPath, [cliJs, '--config', configPath, ...argv], {
    env, encoding: 'utf8', timeout: 120_000
  });

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(name) {
  const dir = path.join(tmp, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a record file this arm's consumer writes, up to `ms`. */
async function awaitFile(file, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(100);
  }
  return false;
}

const readRecord = (arm, ext) => {
  const f = path.join(records, `${arm}.${ext}`);
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
};
const cmdlineOf = (arm) => {
  const raw = readRecord(arm, 'cmdline');
  return raw === null ? null : raw.split('\n').filter((s) => s.length);
};
/** A NUL-separated record written by the fixture, or null when it never ran. */
const nulList = (arm, ext) => {
  const raw = readRecord(arm, ext);
  return raw === null ? null : raw.split('\0').filter((s) => s.length);
};
/** What the fixture's parse produced for this arm: the three lists together. */
const parseOf = (arm) => {
  const entries = nulList(arm, 'entries');
  if (entries === null) return null;
  return { entries, operands: nulList(arm, 'operands') ?? [], tags: nulList(arm, 'tags') ?? [] };
};
const livePid = (arm) => {
  const raw = readRecord(arm, 'pid');
  if (raw === null) return null;
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { fs.readFileSync(`/proc/${pid}/cmdline`); } catch { return null; }
  return pid;
};

const VARIADIC = '--dangerously-load-development-channels';
const PROMPT_RE = /^Please read and follow the instructions in .* to begin\.$/;

/**
 * Run one arm: configure an agent with these `args`, activate it, and wait for
 * the consumer to have written its record.
 *
 * `--override` on every activation: the capacity gate is not this proof's
 * subject and a busy machine refusing an activation would redden a section
 * about something else. (`verify-launcher-args` §5 learned that one the
 * expensive way.)
 */
async function runArm(arm, args) {
  const dir = ownedDir(arm);
  const configured = crabcast([
    'configure', dir, '--priority', '5', '--launcher', 'claude',
    ...(args.length ? ['--args-json', JSON.stringify(args)] : []),
    '--prompt', 'go'
  ]);
  check(configured.status === 0, `[${arm}] configure accepts ${JSON.stringify(args)}`,
    (configured.stderr || configured.stdout || '').trim().split('\n')[0]);

  const activated = crabcast(['activate', dir, '--override']);
  check(activated.status === 0, `[${arm}] the agent activates`,
    (activated.stderr || activated.stdout || '').trim().split('\n').slice(-1)[0]);

  // The consumer writes `.cmdline` first thing, so this is the precondition
  // that the spawn really happened. Without it a section could report on a
  // `null` record as though it had measured something.
  const ran = await awaitFile(path.join(records, `${arm}.cmdline`));
  check(ran, `[${arm}] (precondition) the consumer really ran and recorded its own argv`,
    ran ? '' : 'no .cmdline record — nothing below this line measured anything');
  // Give the parse/err/pid files a moment behind the cmdline write.
  await sleep(400);
  return dir;
}

// ===========================================================================
rule('0. THE LAYOUT — the prompt is the last argument and it is a BARE OPERAND');
// ===========================================================================
//
// Before any process: the launcher table's own command strings. This is the
// cheap half and it does not stand in for §1/§2 — it can be wrong in exactly
// the way a schema check can be wrong. What it does establish is the STRUCTURAL
// fact the documentation rests on, in a form a reader can see.
const { AGENT_LAUNCHERS } = await import(path.join(distDir, 'launchers.js'));

{
  const twoElement = AGENT_LAUNCHERS.claude.command({
    args: [VARIADIC, 'server:butchr'], promptCommand: 'THE-PROMPT', mayResume: false
  });
  const joined = AGENT_LAUNCHERS.claude.command({
    args: [`${VARIADIC}=server:butchr`], promptCommand: 'THE-PROMPT', mayResume: false
  });
  console.log(`\n   two-element form:\n     ${twoElement}`);
  console.log(`   \`=\` form:\n     ${joined}\n`);

  check(
    twoElement.trimEnd().endsWith("'THE-PROMPT'") && joined.trimEnd().endsWith("'THE-PROMPT'"),
    'the prompt is the FINAL argument on both forms — the ordering is unchanged and this ' +
      'proof is not about moving it'
  );
  check(
    twoElement.includes(`'${VARIADIC}' 'server:butchr' 'THE-PROMPT'`),
    "⚠ two-element: a BARE OPERAND ('server:butchr') sits between the variadic flag and the " +
      'prompt, and nothing option-looking separates them — so a flag still counting values ' +
      'reaches the prompt',
    twoElement
  );
  check(
    joined.includes(`'${VARIADIC}=server:butchr' 'THE-PROMPT'`),
    '⚠ `=` form: the value is BOUND to the flag, so no bare word stands between the flag and ' +
      'the prompt',
    joined
  );

  // THE CONTRAST THAT SHOWS THE PROPERTY IS ABOUT BINDING RATHER THAN ABOUT
  // ORDER. anti-gravity's prompt rides on `-i`, so an option token always sits
  // between a caller's args and the prompt and no variadic flag can reach it.
  const agy = AGENT_LAUNCHERS['anti-gravity'].command({
    args: [VARIADIC, 'server:butchr'], promptCommand: 'THE-PROMPT', mayResume: false
  });
  console.log(`   anti-gravity, same args:\n     ${agy}\n`);
  check(
    agy.includes("-i 'THE-PROMPT'"),
    "anti-gravity binds its prompt to `-i`, so its prompt is not a bare operand — the same " +
      'binding `=` performs, on the launcher whose runtime offers a flag to do it with',
    agy
  );
}

// ===========================================================================
rule('1. THE TWO-ELEMENT FORM — the prompt is eaten, live, on a scratch daemon');
// ===========================================================================
{
  const arm = 'two-element';
  await runArm(arm, [VARIADIC, 'server:butchr']);

  const cmdline = cmdlineOf(arm);
  const parsed = parseOf(arm);
  console.log(`\n   /proc/<pid>/cmdline, as the kernel held it:\n     ${JSON.stringify(cmdline)}`);
  console.log(`   what a variadic option collected:\n     ${JSON.stringify(parsed)}\n`);

  // The kernel's half: the prompt is on the command line, last, and unsplit.
  check(
    cmdline !== null && PROMPT_RE.test(cmdline[cmdline.length - 1] ?? ''),
    'CrabCast did put the prompt on the command line, last and as exactly one argument — ' +
      'nothing is wrong on this side of the boundary',
    `last element = ${JSON.stringify(cmdline?.[cmdline.length - 1] ?? null)}`
  );

  // The consequence.
  check(
    parsed !== null && Array.isArray(parsed.entries) &&
      parsed.entries.some((e) => PROMPT_RE.test(e)),
    '⚠ THE PROMPT WAS TAKEN AS A VALUE OF THE FLAG — it is in the variadic option\'s own ' +
      'collected entries',
    `entries = ${JSON.stringify(parsed?.entries ?? null)}`
  );
  check(
    parsed !== null && Array.isArray(parsed.operands) && parsed.operands.length === 0,
    '⚠ and the consumer received NO prompt at all — its operand list is empty',
    `operands = ${JSON.stringify(parsed?.operands ?? null)}`
  );
  check(
    (readRecord(arm, 'err') ?? '').includes('entries must be tagged:'),
    'the consumer refuses, and its complaint is about an ENTRY',
    (readRecord(arm, 'err') ?? '(no stderr recorded)').trim()
  );
  check(
    PROMPT_RE.test(((readRecord(arm, 'err') ?? '').split('entries must be tagged:')[1] ?? '').trim()),
    "⚠ AND THE THING IT NAMES AS A MALFORMED ENTRY IS THE PROMPT ITSELF — which is why a " +
      'reader goes and edits the prompt',
    (readRecord(arm, 'err') ?? '').trim()
  );
  check(
    livePid(arm) === null,
    'the spawn is dead — this wedges the agent rather than degrading it',
    livePid(arm) === null ? 'no live process' : `pid ${livePid(arm)} still alive`
  );
}

// ===========================================================================
rule('2. THE `=` FORM — one variable changed, and the prompt arrives');
// ===========================================================================
{
  const arm = 'equals-form';
  await runArm(arm, [`${VARIADIC}=server:butchr`]);

  const cmdline = cmdlineOf(arm);
  const parsed = parseOf(arm);
  console.log(`\n   /proc/<pid>/cmdline, as the kernel held it:\n     ${JSON.stringify(cmdline)}`);
  console.log(`   what a variadic option collected:\n     ${JSON.stringify(parsed)}\n`);

  check(
    cmdline !== null && cmdline.includes(`${VARIADIC}=server:butchr`),
    'the joined element arrived as exactly ONE argument on the live command line',
    `cmdline = ${JSON.stringify(cmdline)}`
  );
  check(
    parsed !== null && JSON.stringify(parsed.entries) === JSON.stringify(['server:butchr']),
    '⚠ the flag took its value and STOPPED — entries is exactly what the caller meant',
    `entries = ${JSON.stringify(parsed?.entries ?? null)}`
  );
  check(
    parsed !== null && Array.isArray(parsed.operands) && parsed.operands.length === 1 &&
      PROMPT_RE.test(parsed.operands[0]),
    '⚠ AND THE PROMPT REACHED THE CONSUMER, as its one operand',
    `operands = ${JSON.stringify(parsed?.operands ?? null)}`
  );
  check(
    (readRecord(arm, 'err') ?? '') === '',
    'no tagging complaint — nothing was malformed',
    JSON.stringify(readRecord(arm, 'err'))
  );
  const pid = livePid(arm);
  check(pid !== null, 'and the spawn is ALIVE', pid !== null ? `pid ${pid}` : 'no live process');
  if (pid !== null) spawnedPids.add(pid);
}

// ===========================================================================
rule('3. CONTROLS — three ways the fixture could have been the explanation');
// ===========================================================================
//
// ⚠ THE SECTION THAT MAKES §1 ATTRIBUTABLE. §1 ran a fixture written for this
// proof; on its own it establishes that this fixture refuses that argv. These
// three arms run the SAME fixture through the SAME daemon and must all come
// back clean, which leaves the argument form as the only thing that differed.
{
  const arm = 'control-no-args';
  await runArm(arm, []);
  const parsed = parseOf(arm);
  console.log(`\n   no args at all:\n     ${JSON.stringify(parsed)}\n`);
  check(
    parsed !== null && parsed.operands?.length === 1 && PROMPT_RE.test(parsed.operands[0]),
    '(a) with NO args the prompt arrives — the fixture is not simply broken',
    `operands = ${JSON.stringify(parsed?.operands ?? null)}`
  );
  const pid = livePid(arm);
  check(pid !== null, '(a) and it starts', pid !== null ? `pid ${pid}` : 'no live process');
  if (pid !== null) spawnedPids.add(pid);
}
{
  const arm = 'control-fixed-arity';
  await runArm(arm, ['--tag', 'a b']);
  const parsed = parseOf(arm);
  console.log(`\n   a FIXED-ARITY flag, written the two-element way:\n     ${JSON.stringify(parsed)}\n`);
  check(
    parsed !== null && JSON.stringify(parsed.tags) === JSON.stringify(['a b']) &&
      parsed.operands?.length === 1 && PROMPT_RE.test(parsed.operands[0]),
    '⚠ (b) two elements are NOT the hazard — a fixed-arity flag written that way takes its one ' +
      'value and the prompt arrives. The hazard is VARIADIC + two elements, which is why ' +
      'CrabCast cannot refuse the shape',
    `tags = ${JSON.stringify(parsed?.tags ?? null)}, operands = ${JSON.stringify(parsed?.operands ?? null)}`
  );
  const pid = livePid(arm);
  check(pid !== null, '(b) and it starts', pid !== null ? `pid ${pid}` : 'no live process');
  if (pid !== null) spawnedPids.add(pid);
}
{
  // The variadic flag itself, with its value, and NOTHING for it to over-read:
  // configured with no prompt at all, so the launcher builds no trailing
  // operand. If the fixture simply hated this flag, this would fail too.
  const arm = 'control-no-operand';
  const dir = ownedDir(arm);
  const configured = crabcast([
    'configure', dir, '--priority', '5', '--launcher', 'claude',
    '--args-json', JSON.stringify([VARIADIC, 'server:butchr'])
  ]);
  check(configured.status === 0, `[${arm}] configure (no prompt, so no trailing operand)`,
    (configured.stderr || configured.stdout || '').trim().split('\n')[0]);
  const activated = crabcast(['activate', dir, '--override']);
  check(activated.status === 0, `[${arm}] the agent activates`,
    (activated.stderr || activated.stdout || '').trim().split('\n').slice(-1)[0]);
  const ran = await awaitFile(path.join(records, `${arm}.cmdline`));
  check(ran, `[${arm}] (precondition) the consumer really ran`);
  await sleep(400);

  const parsed = parseOf(arm);
  console.log(`\n   the same two-element flag with no operand after it:\n     ${JSON.stringify(parsed)}\n`);
  check(
    parsed !== null && JSON.stringify(parsed.entries) === JSON.stringify(['server:butchr']),
    '⚠ (c) the flag written two-element is HARMLESS when nothing follows it — so §1 is the ' +
      'flag reaching the PROMPT, not the fixture rejecting the flag',
    `entries = ${JSON.stringify(parsed?.entries ?? null)}`
  );
  const pid = livePid(arm);
  check(pid !== null, '(c) and it starts', pid !== null ? `pid ${pid}` : 'no live process');
  if (pid !== null) spawnedPids.add(pid);
}

// ===========================================================================
rule('4. THE SURFACES — every place `args` is documented warns about this');
// ===========================================================================
//
// ⚠ WHY THIS IS NOT AN HONESTY PHRASE. A check that goes green because a
// sentence is present is a check a sentence can silence. This one is joined to
// §0-§3: the warning must be there AND the thing it warns about must be true,
// and both are red. What the surfaces claim is measured a hundred lines above,
// against the argv of a process that ran.
//
// Matched on SUBSTANCE rather than on wording: each surface must recommend the
// `=` form, name the swallow, and say the error blames the prompt. A rewrite
// that keeps all three passes; one that drops any of them is exactly the loss
// this section exists for.
{
  const claims = [
    { key: 'shows the safe form, `--flag=value`', re: /--flag=value/ },
    { key: 'names VARIADIC as the condition', re: /variadic/i },
    { key: 'names the swallow', re: /swallow/i },
    {
      key: 'says the failure blames the prompt rather than the arguments',
      re: /blames? (the|your) prompt|prompt'?s content|malformed (value|entry)|complain\w*[^.]{0,40}prompt/i
    }
  ];

  const surfaces = [];

  // (i) THE CLI, from a real invocation of the built binary.
  const help = crabcast(['configure', '--help']);
  surfaces.push({
    name: 'crabcast configure --help',
    text: (help.stdout || '') + (help.stderr || ''),
    precondition: () => help.status === 0 && /--args-json/.test((help.stdout || '') + (help.stderr || ''))
  });

  // (ii) THE MCP TOOL SCHEMA, read the way a caller receives it: over the wire
  // from the built server, not off the source file.
  const mcpDescription = await (async () => {
    const child = spawn(process.execPath, [mcpJs, configPath], {
      env, stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    const pending = new Map();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg.result);
        }
      }
    });
    let nextId = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out on ${method}`)); }, 30_000);
      pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-variadic-args-swallow-prompt', version: '0.0.0' }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      const { tools } = await request('tools/list');
      const tool = tools.find((t) => t.name === 'crabcast_configure_agent');
      return tool?.inputSchema?.properties?.args?.description ?? '';
    } catch {
      return '';
    } finally {
      try { child.kill(); } catch {}
    }
  })();
  surfaces.push({
    name: "crabcast_configure_agent's `args` description, over MCP",
    text: mcpDescription,
    precondition: () => mcpDescription.length > 200
  });

  // (iii) and (iv) THE PAGES.
  const readmePath = path.join(pagesRoot, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  surfaces.push({
    name: 'README.md',
    // The whole page would pass on sentences about other things, so this reads
    // the paragraph that documents the flag.
    text: readme.split('\n').filter((l) => /args-json|launcher-args\.md/.test(l)).join('\n'),
    precondition: () => /--args-json/.test(readme)
  });

  const pagePath = path.join(pagesRoot, 'docs', 'launcher-args.md');
  const page = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : '';
  surfaces.push({
    name: 'docs/launcher-args.md',
    text: page,
    precondition: () => page.length > 500
  });

  for (const surface of surfaces) {
    check(surface.precondition(), `(precondition) ${surface.name} was read at all`,
      surface.precondition() ? `${surface.text.length} chars` :
        'EMPTY OR UNREADABLE — the claim checks below would have failed for the wrong reason');
    for (const claim of claims) {
      check(claim.re.test(surface.text), `${surface.name} — ${claim.key}`,
        claim.re.test(surface.text) ? '' : `no match for ${claim.re}`);
    }
  }

  // THE OTHER DIRECTION: no surface may still hold out the two-element form as
  // the example to copy. This is the specific edit KAN-514 came from — the
  // help text, the two CLI refusals and the router's refusal all read
  // `["--flag","value"]`, which is the form that wedges.
  //
  // ⚠ THE FORM MAY APPEAR — it has to, to be warned about. What it may not do
  // is appear UNMARKED. The window is the matching line and the one before it,
  // because that is where a mark a reader would see has to be: a negation two
  // paragraphs away is not one they will read in time.
  const BAD_EXAMPLE = /\[\s*"--flag"\s*,\s*"value"\s*\]/;
  const MARKED = /never|not\b|rather than|instead of|⚠|wrong|✅|swallow/i;
  for (const surface of surfaces) {
    const lines = surface.text.split('\n');
    const offending = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => BAD_EXAMPLE.test(line))
      .filter(({ line, i }) => !MARKED.test(line) && !MARKED.test(lines[i - 1] ?? ''));
    check(offending.length === 0,
      `${surface.name} — never shows ["--flag","value"] unmarked`,
      offending.length === 0
        ? 'either absent, or marked where it appears'
        : `unmarked at line(s) ${offending.map((o) => o.i + 1).join(', ')}: ` +
          JSON.stringify(offending[0].line.slice(0, 160)));
  }

  // AND THE ROUTER'S OWN REFUSAL, which is a surface a caller meets by getting
  // it wrong rather than by reading. Driven, not read off the source.
  const badShape = crabcast([
    'configure', ownedDir('shape-refusal'), '--priority', '5', '--launcher', 'claude',
    '--args-json', '["--flag", 7]'
  ]);
  const refusalText = (badShape.stderr || '') + (badShape.stdout || '');
  console.log(`\n   the shape refusal, as a caller sees it:\n     ${refusalText.trim().split('\n')[0]}\n`);
  check(badShape.status !== 0, 'a non-string element is still refused', `exit ${badShape.status}`);
  check(
    !BAD_EXAMPLE.test(refusalText),
    'and the refusal does not teach the two-element form on its way out',
    refusalText.trim().split('\n')[0]
  );
}

// ===========================================================================
rule('5. the RUNNING FLEET was never touched');
// ===========================================================================
{
  const realDataDir = path.join(os.homedir(), '.local', 'share', 'crabcast');
  check(
    !dataDir.startsWith(realDataDir) && dataDir.startsWith(tmp),
    "the data dir this proof drove is scratch, not the fleet's",
    `used ${dataDir}`
  );
  check(
    env.HOME === home && home.startsWith(tmp),
    'HOME was scratch, so no real ~/.claude.json trust entry or transcript was read or written',
    `HOME = ${env.HOME}`
  );
  check(
    env.PATH.startsWith(bin),
    'PATH put the shim first, so no real herdr and no real claude binary was ever invoked',
    `PATH = ${env.PATH}`
  );
  // ⚠ THE GATE IS THE CONTENT, NOT THE MTIME, AND THIS DIVERGES FROM
  // `verify-launcher-args` §6 DELIBERATELY.
  //
  // That sibling asserts the live registry's mtime is unchanged, and on a
  // clean runner — where there is no live registry at all — it is vacuously
  // true. On the machine this was written on it is simply WRONG: a real
  // CrabCast is serving a real fleet, other agents activate while this proof
  // runs, and the daemon writes that file for its own reasons. Measured while
  // writing this proof: the mtime moved during a 20-second run in which
  // nothing here went near it, and the check reported `the live fleet's own
  // agents.jsonl was not written` as a FAILURE. A safety check that fires on
  // somebody else's correct behaviour teaches its reader to ignore it, which
  // is worse than not having it.
  //
  // The attributable question is whether THIS RUN wrote into it, and the scratch
  // root's name is unique to this process — so a row this proof caused would
  // carry it and nothing else could. That is what is asserted. The mtime is
  // printed beside it as information, with the reason it is not the gate.
  const realRegistry = (() => {
    try { return fs.readFileSync(realAgentsLog, 'utf8'); } catch { return null; }
  })();
  const realMtimeNow = fs.existsSync(realAgentsLog) ? fs.statSync(realAgentsLog).mtimeMs : null;
  check(
    realRegistry === null || !realRegistry.includes(tmp),
    "the live fleet's own agents.jsonl carries no row this proof put there",
    realRegistry === null
      ? '(no live registry on this machine — vacuously true, and stated so it is not read as a measurement)'
      : `${realRegistry.length} bytes, no occurrence of ${tmp}; mtime ` +
        `${realMtimeNow === realAgentsLogMtimeAtStart ? 'also unchanged' :
          'MOVED during this run — the live fleet writing its own registry, which is why mtime is not the gate here'}`
  );

  // -------------------------------------------------------------------------
  // EVERY PROCESS CARRYING THIS RUN'S SCRATCH ROOT, ENDED (KAN-529)
  // -------------------------------------------------------------------------
  //
  // This block used to kill `spawnedPids`, call `crabcast(['daemon', 'stop'])`
  // and assert that the pids it remembered were gone. All three parts were
  // wrong together, which is why it went green while leaking:
  //
  //   * `crabcast daemon stop` IS NOT A COMMAND. It exits 2 with a usage error
  //     ("`crabcast daemon` takes no arguments, and got \"stop\"") and stops
  //     nothing. The status was never read.
  //   * `spawnedPids` never held the scratch daemon — nothing here spawns it;
  //     the first CLI call does, detached — nor any `herdr agent attach` the
  //     daemon then spawns. Measured on this machine before the fix: 202
  //     orphaned processes across 38 already-deleted scratch roots, holding
  //     the live fleet at zero headroom.
  //   * and it did not hold every fake `claude` either: the pid the fixture
  //     reports is the process that writes the record, not the `bash` wrapper
  //     that `exec`s toward it.
  //
  // ⚠ THE POPULATION IS NOW READ OFF THE MACHINE rather than remembered, keyed
  // on this run's scratch root — six random characters from `mkdtempSync` that
  // exist nowhere else — so a process this run caused carries it and nothing
  // else can. It is the same attributable key the registry check directly
  // above uses, for the same reason.
  //
  // `found` is reported beside the verdict because a sweep that matched
  // nothing and a sweep that cleaned up correctly are the same verdict with
  // different evidence, and only one of them means the instrument is working.
  const { found, survivors } = await sweepScratchRoot(tmp);

  // ⚠ THE PRECONDITION, AND IT IS NOT CEREMONY. Without it the check below
  // passes when the sweep found NOTHING TO SWEEP, which is not the same fact as
  // "nothing leaked" and reads identically. `epic/KAN-59` met it while reviewing
  // KAN-529: a long `TMPDIR` pushed the daemon's socket path past 104
  // characters, the daemon refused to start, no agent ever ran — and this
  // section printed `PASS … 0 swept`. That run went red for other reasons, so
  // nothing was hidden that day; on a run where it did not, the boundary
  // section would have reported a clean teardown for a proof that never
  // started anything.
  //
  // Every arm above activates an agent, so a completed run always has a daemon
  // and at least one consumer to sweep. Zero here means the run did not happen.
  check(
    found.length > 0,
    '(precondition) the sweep had something to sweep — so the verdict below is about a ' +
      'teardown rather than about a run that never started',
    `${found.length} process(es) carried ${tmp}`
  );
  check(
    survivors.length === 0,
    'every process carrying this run\'s scratch root is gone — the daemon and its ' +
      'attaches included, not merely the pids this script remembered',
    survivors.length
      ? `still alive:\n          ${describe(survivors)}`
      : `${found.length} swept (${found.length - spawnedPids.size} of them never in spawnedPids)`
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

process.exit(failures ? 1 : 0);
