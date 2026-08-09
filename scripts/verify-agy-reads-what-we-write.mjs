#!/usr/bin/env node
// Live proof for KAN-235: an agy agent's MCP servers land where the antigravity
// CLI ACTUALLY READS THEM, asserted by running a real `agy` binary.
//
// WHAT FAILURE THIS WOULD CATCH: CrabCast writing its agy MCP config to a path
// no agy ever opens, so every `anti-gravity` agent is activated with its servers
// resolved, merged, disclosed and recorded — and receives none of them, behind
// `success: true`. That is not hypothetical. It is what this repository did for
// three merged slices: the launcher wrote `~/.gemini/antigravity-cli/mcp.json`
// and the CLI reads `~/.gemini/config/mcp_config.json`.
//
// WHY NOTHING CAUGHT IT, WHICH IS THE POINT OF THIS FILE. There were two careful
// proofs over that write — `verify-agy-mcp-reversal` and
// `verify-agy-mcp-write-refusals` — with mutation sections, positive controls
// and end-to-end damage demonstrations. Both were green throughout. Neither
// could have failed, because THE INPUT TO EVERY ASSERTION IN THEM WAS CRABCAST'S
// OWN OUTPUT: they wrote a file and read it back. A file nobody else opens reads
// back exactly the same as one everybody opens.
//
// So the rule this file exists to obey: NO ASSERTION HERE MAY READ A FILE
// CRABCAST WROTE. The evidence is a process `agy` chose to start.
//
// ---------------------------------------------------------------------------
// HOW IT ASSERTS, since "agy read the file" is not directly observable
//
// A stdio MCP server is a COMMAND agy spawns. So the config CrabCast writes
// defines a server whose command touches a sentinel file and then blocks. If the
// sentinel appears, agy parsed our bytes and executed what they described. The
// sentinel is written by a process agy started — not by this script, and not by
// the daemon.
//
// That is the whole design, and it is why this proof is worth more than its
// siblings despite being shorter: the assertion cannot be satisfied by CrabCast
// behaving correctly. It can only be satisfied by another program acting on
// CrabCast's output.
//
// THE SECTIONS:
//
//   1. preflight: a real agy, its version on the record
//   2. THE ASSERTION: the real `configureAgyMcp` writes a server, a real agy
//      session STARTS it
//   3. RED AGAINST THE PRE-FIX BUILD: the same steps against a build whose
//      `agyMcpConfigPath` is the old one — agy starts nothing
//   4. POSITIVE CONTROL for §3: the pre-fix build really did WRITE its file, so
//      §3's silence is agy ignoring it rather than nothing having been written
//   5. NEGATIVE CONTROL: a sentinel this script never puts in any config is
//      never touched, so §2 is not passing on ambient noise
//   6. the identity check: nothing in the file agy reads carries an agent path
//
// §3 IS THE SABOTAGE RUN THE TICKET ASKS FOR, and §4 is what makes it mean
// anything. "agy did not start our server" would also be true of a build that
// wrote nothing at all, and a check that passes because the feature was deleted
// is the failure mode this epic is named after.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER, and who does
//
//   - REFERENCE COUNTING, REFUSALS, DISCLOSURE, PROVENANCE. None of it. This
//     file asks one question — does agy read what we write — and answers it.
//     `verify-agy-mcp-reversal` and `verify-agy-mcp-write-refusals` own all of
//     that, and between them they own the bookkeeping this file ignores.
//   - THAT AN AGY AGENT CANNOT REACH THE DAEMON. §6 checks the identity is
//     absent from the FILE. Whether the resulting agent genuinely cannot call
//     `send_to_agent` is a property of a running agent talking to a running
//     daemon, and nothing here starts either. NOBODY COVERS THAT TODAY. It is
//     stated rather than implied, because the omission is disclosed to callers
//     as a capability difference and a disclosure nothing checks is exactly the
//     shape of defect this ticket is about.
//   - AGY'S OWN DOCUMENTATION. Deliberately unread as evidence. agy's shipped
//     docs are wrong about agy in at least two places — `plugins.md` says
//     plugins are discovered from workspace customization roots (measured never
//     to happen) and `AGY_CLI_DISABLE_AUTO_UPDATE=1` did not prevent an
//     auto-update. A document is not a mechanism. This file only believes the
//     spawn.
//   - THIS SCRIPT WRITES THE CONFIG IT THEN ASSERTS ON — through the real
//     `configureAgyMcp`, but the ACTIVATION that would normally call it is not
//     run here. So it proves the launcher's path is one agy reads; it does not
//     prove an activation reaches the launcher. `verify-agy-mcp-write-refusals`
//     drives real activations through the ordinary verbs and is what covers
//     that half. Neither script covers the other, and KAN-145 is the standing
//     reminder that the gap between two honest proofs is where defects live.
//
// WHY IT IS NOT IN CI: no GitHub runner has an `agy` binary, and installing one
// needs a Google account. It is registered in the EXCLUSIONS list in
// `verify-proof-registry.mjs` and run by hand, with its output pasted on the PR.
//
// Hermetic: it runs agy under a SCRATCH $HOME, so it never reads or writes the
// operator's real `~/.gemini`. Verified — a fresh $HOME does not relocate the
// config; agy uses the path below directly.
//
// Usage:
//   npm run build
//   node scripts/verify-agy-reads-what-we-write.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const section = (title) => console.log(`\n${title}\n${'='.repeat(title.length)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan235-agy-'));
const realHome = process.env.HOME;

const { mutate, mutationsSkipped } = makeMutator({
  distDir: dist,
  scratch: path.join(tmp, 'mutants'),
  report: {
    pass: (label) => check(label, true),
    fail: (label, detail) => check(label, false, detail)
  }
});

/**
 * Run a real agy session under `home`, and wait for `sentinel` to appear.
 *
 * KILLED AS SOON AS THE SENTINEL LANDS rather than run to completion: the MCP
 * servers are started during agy's startup, well before any model reply, so
 * waiting for the reply would add a network round trip and an auth dependency to
 * a proof that needs neither. On the negative path there is nothing to wait for,
 * so it runs to `waitMs` and is then killed — that timeout IS the measurement,
 * which is why it is generous rather than tight.
 */
async function runAgy({ home, sentinel, waitMs = 45_000, label }) {
  const child = spawn('agy', ['--print', 'reply with the single word pong'], {
    env: { ...process.env, HOME: home },
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const started = Date.now();
  let appeared = false;
  while (Date.now() - started < waitMs) {
    if (fs.existsSync(sentinel)) {
      appeared = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log(
    `    ${label}: sentinel ${appeared ? 'APPEARED' : 'did NOT appear'} after ` +
      `${Math.round((Date.now() - started) / 1000)}s`
  );
  return { appeared, out };
}

/** A scratch $HOME plus the paths this script cares about inside it. */
function newHome(label) {
  const home = path.join(tmp, `home-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * A server definition whose command announces that AGY started it.
 *
 * `exec cat` after the touch so the process stays alive: a stdio server that
 * exits immediately can be torn down and retried, and a proof should not depend
 * on how a dependency handles a crashing child.
 */
const spawnMarker = (sentinel) => ({
  command: '/bin/sh',
  args: ['-c', `touch ${JSON.stringify(sentinel)}; exec cat`]
});

// ===========================================================================
section('1. Preflight — a real agy, and which one');

let agyVersion = '';
try {
  agyVersion = execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim();
} catch (e) {
  agyVersion = '';
}
check(
  'a real `agy` binary is on PATH. THIS PROOF IS MEANINGLESS WITHOUT ONE and fails rather than ' +
    'skipping — a proof that quietly does nothing is the defect this suite is named after',
  agyVersion !== '',
  agyVersion || 'agy --version produced nothing'
);
if (!agyVersion) {
  console.log('\nNOT RUN: no agy on PATH. Install it or run this on a machine that has it.');
  process.exit(1);
}
console.log(`    agy version: ${agyVersion}`);

const { agyMcpConfigPath, configureAgyMcp } = await import(path.join(dist, 'launchers.js'));

// ===========================================================================
section('2. THE ASSERTION — a real agy STARTS a server CrabCast defined');

const home2 = newHome('real');
const sentinel2 = path.join(tmp, 'SPAWNED-real');
let realFile = '';
{
  process.env.HOME = home2;
  realFile = agyMcpConfigPath();
  console.log(`    CrabCast writes: ${realFile.replace(home2, '$HOME')}`);

  // THE REAL LAUNCHER CODE decides the path and does the merge. Nothing here
  // hand-writes a config: if `agyMcpConfigPath` is wrong, this section is wrong
  // with it, which is the entire point.
  const outcome = configureAgyMcp({ 'kan235-probe': spawnMarker(sentinel2) });
  check('(precondition) the real configureAgyMcp reported writing our server',
    outcome.keys?.['kan235-probe'] !== undefined, JSON.stringify(outcome));

  const { appeared } = await runAgy({ home: home2, sentinel: sentinel2, label: 'real build' });
  check(
    'A REAL AGY SESSION STARTED THE SERVER. Not "the bytes are on disk where we put them" — agy ' +
      'parsed CrabCast\'s config and executed the command in it. This is the assertion no proof ' +
      'in this repository could make before, and its absence is why the path stayed wrong ' +
      'through three merged slices',
    appeared,
    appeared ? undefined : `no ${sentinel2}; agy never started what CrabCast wrote`
  );
}

// ===========================================================================
section('3. RED AGAINST THE PRE-FIX BUILD — the sabotage run');

// The build being replaced, reproduced rather than described: `agyMcpConfigPath`
// returns the path KAN-235 corrected. Everything else — the merge, the refusals,
// the provenance — is untouched and behaves perfectly. That is the shape of this
// defect: the mechanism was never broken, it was aimed at the wrong file.
const sentinel3 = path.join(tmp, 'SPAWNED-prefix');
let preFixFile = '';
let preFix = null;
mutationPreFix: {
  const mutant = mutate(
    'the-pre-fix-path',
    'launchers.js',
    "return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');",
    "return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp.json'); // MUTANT: the pre-KAN-235 path"
  );
  if (!mutant) break mutationPreFix;

  const home3 = newHome('prefix');
  process.env.HOME = home3;
  preFix = await import(path.join(mutant, 'launchers.js'));
  preFixFile = preFix.agyMcpConfigPath();
  console.log(`    the pre-fix build writes: ${preFixFile.replace(home3, '$HOME')}`);

  check(
    '(precondition) the mutant really is the old path — otherwise this section is a second run ' +
      'of §2 wearing a different name',
    preFixFile.endsWith(path.join('antigravity-cli', 'mcp.json')),
    preFixFile
  );

  const outcome = preFix.configureAgyMcp({ 'kan235-probe': spawnMarker(sentinel3) });
  check('(precondition) the pre-fix build reported writing our server, exactly as it always did',
    outcome.keys?.['kan235-probe'] !== undefined, JSON.stringify(outcome));

  const { appeared } = await runAgy({ home: home3, sentinel: sentinel3, label: 'pre-fix build' });
  check(
    'AGY STARTS NOTHING. The pre-fix build reported success, recorded provenance, and would have ' +
      'disclosed a merge to the caller — and the agent receives no server at all. This is the ' +
      'defect, observed rather than argued',
    !appeared,
    appeared ? 'the sentinel appeared, so the old path IS read after all — stop and re-measure' : undefined
  );

  // ===========================================================================
  section('4. POSITIVE CONTROL for §3 — the pre-fix build really did write a file');

  // Without this, §3 passes against a build that writes nothing, refuses
  // everything, or crashed before it got there. "agy started nothing" is only
  // evidence about the PATH if there was something at that path to ignore.
  const wrote = fs.existsSync(preFixFile);
  check(
    'the old path exists on disk — the pre-fix build was working, not broken',
    wrote,
    preFixFile
  );
  const body = wrote ? JSON.parse(fs.readFileSync(preFixFile, 'utf8')) : {};
  check(
    'and it holds OUR server, in the right shape, under the right key. So §3 measured a file agy ' +
      'declined to read, not an absence of work',
    JSON.stringify(body?.mcpServers?.['kan235-probe']) === JSON.stringify(spawnMarker(sentinel3)),
    JSON.stringify(body)
  );
  // NOT "the read path does not exist" — an earlier draft asserted that and was
  // wrong: AGY ITSELF creates `~/.gemini/config/mcp_config.json` on first run.
  // Its existence is agy's doing, which is incidentally more evidence that this
  // is the file agy cares about. What must be absent is OUR SERVER.
  const readPath = path.join(path.dirname(path.dirname(preFixFile)), 'config', 'mcp_config.json');
  const readPathBody = fs.existsSync(readPath) ? fs.readFileSync(readPath, 'utf8') : '';
  check(
    'and our server is NOWHERE in the file agy actually reads — which is the whole geometry of ' +
      'the defect in one line: CrabCast wrote a real config, correctly, into a file that plays no ' +
      'part in anything',
    !readPathBody.includes('kan235-probe'),
    readPathBody || '(the read path does not exist under the pre-fix home)'
  );
}

// ===========================================================================
section('5. NEGATIVE CONTROL — a sentinel no config mentions is never touched');

// Guards the shape of §2's assertion rather than its subject. If something in
// this harness were creating sentinels — a stray shell, a reused path, an `fs`
// call in the wrong branch — §2 would pass without agy doing anything at all.
{
  const unused = path.join(tmp, 'SPAWNED-never-configured');
  check(
    'nothing created a sentinel that appears in no MCP config, so §2 is measuring agy and not ' +
      'this script',
    !fs.existsSync(unused),
    unused
  );
}

// ===========================================================================
section('6. The file agy reads carries NO agent identity (KAN-235)');

// The other half of the decision. Correcting the path is what would have made
// `CRABCAST_AGENT_PATH` in a shared file dangerous, so the corrected path must
// never carry one. Asserted HERE, against the file agy actually reads, because
// this is the only script that knows which file that is.
{
  const text = fs.existsSync(realFile) ? fs.readFileSync(realFile, 'utf8') : '';
  check(
    'no CRABCAST_AGENT_PATH anywhere in the file agy reads. Every agy MCP scope is global, so an ' +
      'identity here would be issued to every agy agent on the machine — a fabricated supervisor ' +
      'of record, not merely a leaked one',
    text !== '' && !text.includes('CRABCAST_AGENT_PATH'),
    text || 'the file agy reads does not exist'
  );
}

// ---------------------------------------------------------------------------
process.env.HOME = realHome;
fs.rmSync(tmp, { recursive: true, force: true });

// A mutation that did not apply means §3 and §4 never ran, and §3 is the only
// section that shows this proof can go red. Reported by name rather than left
// for a reader to notice the missing output.
const skipped = mutationsSkipped();
console.log(
  (failures ? `\n${failures} FAILED` : '\nALL PASS') +
    (skipped.length
      ? `\n(${skipped.length} mutation(s) did not apply, so their sections never ran: ${skipped.join(', ')})`
      : '')
);
process.exit(failures ? 1 : 0);
