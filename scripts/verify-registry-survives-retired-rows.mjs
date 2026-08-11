#!/usr/bin/env node
// KAN-302: one row an older CrabCast wrote does not take the daemon off the
// machine, and what it costs instead is disclosed rather than deleted.
//
// WHAT FAILURE THIS WOULD CATCH: a build in which an unreadable registry row
// stops the daemon starting, or in which it starts and says nothing — either
// the refusal coming back, or the disclosure being dropped so that a
// half-loaded registry becomes silent again. Both directions, because the two
// are opposite mistakes and a proof against only one of them licenses the
// other. It would also catch the quiet one underneath both: a compaction that
// carries the loadable rows and discards the unreadable ones, which turns
// "skip the row" into "delete the record" on a 500-record timer.
//
// THE SPECIMEN IS REAL AND IS PASTED IN BELOW, byte for byte. It came off
// `~/.local/share/crabcast/agents.jsonl` on the machine where this was found —
// 131 bytes, one row, written 2026-08-03 by a CrabCast that addressed agents
// by <type>/<key>. The agent it names had ALREADY been deactivated. On
// `origin/main` at 6e92d05 that row was enough to stop the daemon binding its
// socket at all, and the first remedy the refusal printed was "delete
// /home/brooswit/.local/share/crabcast/agents.jsonl and `configure` the fleet
// again" — every other agent record discarded to recover from one dead line.
//
// WHAT THIS SCRIPT SUPPLIES ITS OWN INPUT FOR, AND WHAT THAT LEAVES UNCOVERED
// (the disclosure `prompts/task.md` asks for, and it is not a formality here).
// Every registry in this file is one this script WROTE. So it does not test
// that a row of this shape ever reaches a registry in production — it tests
// what the daemon does with one that has. That gap is covered by observation
// rather than by a sibling script, and the observation is in the pull request:
// the real file on the real machine, run against the real daemon, before and
// after. Nothing in CI can own that half, because the specimen is eight days of
// somebody else's history and CI starts from an empty directory.
//
// §6 mutates the compiled build to restore the refusal and requires §1 to go
// red. That is this file's own answer to "has this assertion ever failed" —
// and it is the weaker of the two available answers. The stronger one is in
// the PR: the same registry file, the same command, run against a build of
// origin/main, which is the behaviour this replaces rather than a re-creation
// of it.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const daemonJs = path.join(distDir, 'daemon.js');
if (!fs.existsSync(daemonJs)) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(1);
}

const { AgentRegistry, describeUnreadableLog, scanLogVersions } = await import(
  path.join(distDir, 'agent-registry.js')
);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};

// Short, because a unix socket address holds 104 characters and a data dir
// under a long temp root silently truncates it — the config loader refuses
// such a dir outright, which would fail every section here for the wrong
// reason.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan302-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// §6 spawns a mutated copy of `dist/` from under this directory, and
// `dist/daemon.js` imports `node-pty` and the MCP SDK by bare specifier. Node
// resolves those by walking UP from the importing file, which from a temp
// directory finds nothing — so without this the mutant dies on an unresolved
// import and produces "the daemon did not come up", which is the evidence §6
// is looking for and would have been meaningless. §6's precondition catches
// that, and this is what stops it happening in the first place. A symlink
// rather than a copy: it is 115 MB, and nothing here writes to it.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (err) {
  console.error(`could not link node_modules into the scratch dir: ${err?.message ?? err}`);
}

/**
 * THE SPECIMEN. Off the real machine, unedited. Kept as a literal string
 * rather than built from an object so that a field order or a spelling
 * changing here is a visible diff rather than a re-derivation.
 */
const SPECIMEN =
  '{"agentName":"crabcast-shell-demo","type":"shell","key":"demo","workDir":"",' +
  '"event":"deactivated","at":"2026-08-03T20:37:38.900Z"}';

const GOOD_CONFIG = {
  priority: 5, launcher: 'shell', refusable: true, chargeable: true, preemptable: true
};
const goodRow = (p, event = 'activated', at = '2026-08-01T10:00:00.000Z') =>
  JSON.stringify({ v: 1, event, path: p, config: GOOD_CONFIG, activatedBy: null, at });

function makeCase(name, lines) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const registry = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(registry, lines.join('\n') + '\n');
  const cfg = path.join(tmp, `${name}.config.json`);
  fs.writeFileSync(cfg, JSON.stringify({ dataDir: dir }));
  return { dir, registry, cfg, socket: path.join(dir, 'crabcast.sock') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(socketPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

function ask(socketPath, request, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const running = [];
function startDaemon(cfg, dist = distDir) {
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  running.push(child);
  return { child, stderr: () => stderr };
}
process.on('exit', () => { for (const c of running) { try { c.kill(); } catch {} } });

// ---------------------------------------------------------------------------
console.log('\n=== 1. The specimen alone: the daemon starts, and says what it could not read ===');
// ---------------------------------------------------------------------------
{
  const c = makeCase('specimen', [SPECIMEN]);
  const before = fs.readFileSync(c.registry);

  const d = startDaemon(c.cfg);
  const up = await waitForSocket(c.socket);
  check(up, 'the daemon bound its socket on a registry whose only row it cannot read',
    up ? c.socket : `stderr: ${d.stderr().slice(0, 400)}`);

  if (up) {
    const status = await ask(c.socket, { action: 'daemon_status', id: 1 });

    // THE CENTRAL ASSERTION of this file, and §6 is what shows it can fail.
    check(status.success === true, 'daemon_status answers over the socket');
    check(
      status.unreadableRecordsTotal === 1,
      'and the fleet read DISCLOSES the row — on the wire, not only in a log line',
      `unreadableRecordsTotal=${status.unreadableRecordsTotal}`
    );

    const row = status.unreadableRecords?.[0] ?? {};
    check(row.line === 1, 'the disclosure names the LINE, which is what makes a repair targeted',
      `line=${row.line}`);
    check(row.problem === 'pre-migration', 'classified as pre-migration rather than as a hand-edit',
      `problem=${row.problem}`);
    check(
      row.identity === 'crabcast-shell-demo',
      "identified in the row's OWN vocabulary — an old row does not know the word `path`",
      `identity=${row.identity}`
    );
    check(row.raw === SPECIMEN, 'and carries the row verbatim, so the operator need not open the file');
    check(
      typeof row.reason === 'string' && /workspaceTypes/.test(row.reason),
      'saying what could not be read about it, rather than only that something could not'
    );
    check(
      row.claimsPath === null,
      'and reports that this row names no directory — its `workDir` is the empty string',
      `claimsPath=${JSON.stringify(row.claimsPath)}`
    );

    // The counts beside it are the reason the disclosure has to be HERE. Both
    // read zero, which is exactly what an empty registry reads.
    check(
      status.configuredAgents === 0 && status.expectedAgents === 0,
      'the agent counts are zero — indistinguishable from an empty registry, which is why ' +
        'the disclosure sits beside them rather than somewhere else',
      `${status.configuredAgents} configured, ${status.expectedAgents} expected`
    );

    const fleet = await ask(c.socket, { action: 'list_agents', id: 2 });
    check(
      fleet.success === true && fleet.unreadableRecordsTotal === 1 &&
        fleet.unreadableRecords?.[0]?.raw === SPECIMEN,
      'the same disclosure is on `list_agents`, so the two surfaces cannot disagree'
    );
  }

  d.child.kill();
  await sleep(300);
  check(
    Buffer.compare(before, fs.readFileSync(c.registry)) === 0,
    'THE REGISTRY IS BYTE-IDENTICAL: nothing was deleted, migrated or rewritten to achieve this'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. One bad row among good ones: the good ones survive ===');
// ---------------------------------------------------------------------------
{
  // All three unreadable classes at once, so a build that handles one and
  // refuses on another is caught here rather than by whoever meets it.
  const alive = path.join(tmp, 'agent-a');
  const stood = path.join(tmp, 'agent-b');
  fs.mkdirSync(alive, { recursive: true });
  fs.mkdirSync(stood, { recursive: true });
  const { chargeable, ...missingOne } = GOOD_CONFIG;

  const c = makeCase('mixed', [
    goodRow(alive, 'activated'),                                     // line 1
    SPECIMEN,                                                        // line 2  pre-migration
    goodRow(stood, 'deactivated', '2026-08-01T11:00:00.000Z'),       // line 3
    JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan302-handedit',
      config: missingOne, at: '2026-08-01T12:00:00.000Z' }),         // line 4  unusable
    JSON.stringify({ v: 99, event: 'activated', path: '/tmp/kan302-future',
      config: GOOD_CONFIG, at: '2026-08-01T13:00:00.000Z' })         // line 5  from-newer
  ]);
  const before = fs.readFileSync(c.registry);

  const d = startDaemon(c.cfg);
  const up = await waitForSocket(c.socket);
  check(up, 'the daemon starts with three unreadable rows of three different kinds',
    up ? '' : `stderr: ${d.stderr().slice(0, 400)}`);

  if (up) {
    const status = await ask(c.socket, { action: 'daemon_status', id: 3 });
    check(
      status.configuredAgents === 2,
      'BOTH readable agents survived — the valid rows were loaded, not discarded with the file',
      `configuredAgents=${status.configuredAgents}`
    );
    check(status.expectedAgents === 1, 'and the one expected agent is still expected',
      `expectedAgents=${status.expectedAgents}`);

    check(status.unreadableRecordsTotal === 3, 'all three unreadable rows are disclosed',
      `total=${status.unreadableRecordsTotal}`);
    const byLine = Object.fromEntries((status.unreadableRecords ?? []).map((r) => [r.line, r]));
    check(byLine[2]?.problem === 'pre-migration', 'line 2 is named pre-migration');
    check(byLine[4]?.problem === 'unusable', 'line 4 is named unusable — a hand-edit, not a migration');
    check(
      /config\.chargeable/.test(byLine[4]?.reason ?? ''),
      'and names the EXACT field that was dropped, which is the only useful sentence for a ' +
        'hand-edit: the operator already believes they supplied them all',
      byLine[4]?.reason?.slice(0, 90)
    );
    check(byLine[5]?.problem === 'from-newer', 'line 5 is named from-newer — downgrading, not migrating');
    check(
      /downgrading/.test(byLine[5]?.reason ?? ''),
      'and points at the downgrade rather than at a repair that would not help'
    );
    check(
      byLine[4]?.claimsPath === '/tmp/kan302-handedit',
      'a row that DOES name a directory reports it, so a caller can see a collision coming',
      `claimsPath=${byLine[4]?.claimsPath}`
    );

    const fleet = await ask(c.socket, { action: 'list_agents', id: 4 });
    const known = [
      ...(fleet.standbyAgents ?? []), ...(fleet.unstartedAgents ?? []),
      ...(fleet.missingAgents ?? []), ...(fleet.agents ?? [])
    ].map((r) => r.path);
    check(known.includes(stood), 'the stood-down agent is offered on the fleet read as usual',
      known.join(', ') || '(none)');
    check(
      !known.includes('/tmp/kan302-future') && !known.includes('/tmp/kan302-handedit'),
      'and NO unreadable row is reported as an agent — disclosed as unreadable, never half-loaded'
    );
  }

  d.child.kill();
  await sleep(300);
  check(
    Buffer.compare(before, fs.readFileSync(c.registry)) === 0,
    'the registry is byte-identical after a full daemon lifecycle'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Compaction carries the unreadable rows — the 500-record trap ===');
// ---------------------------------------------------------------------------
{
  // THE SECTION THIS FILE EXISTS FOR AS MUCH AS §1. Compaction rewrites the log
  // from the rows it could LOAD, so skipping an unreadable row does not hide it
  // — it schedules its deletion at the 500th record, silently, long after
  // anybody is watching. Without this, "we never delete your registry" is true
  // of the boot and false of the daemon.
  const dir = path.join(tmp, 'compaction');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agents.jsonl');
  const handEdit = JSON.stringify({ v: 1, event: 'activated', path: '/tmp/kan302-he', config: {} });
  fs.writeFileSync(file, [SPECIMEN, handEdit].join('\n') + '\n');

  const registry = new AgentRegistry(file);
  const scanBefore = scanLogVersions(file);
  check(scanBefore.unreadable.length === 2, 'two unreadable rows to start with',
    `${scanBefore.unreadable.length}`);

  // Past COMPACT_AFTER_RECORDS (500) so `record()` triggers a real compaction —
  // and over a SMALL set of paths, deliberately. 520 distinct paths would write
  // 520 rows that compaction has to keep (one per agent), so the file would not
  // shrink and "did a compaction happen?" would be unanswerable from its size.
  // Ten paths churned 52 times each collapses to ten rows, which makes the
  // rewrite observable — and observing the rewrite is the whole precondition
  // for this section, since a compaction that never ran would preserve the
  // unreadable rows trivially and prove nothing.
  const AGENTS = 10;
  for (let i = 0; i < 520; i++) {
    registry.record(i % 2 ? 'activated' : 'configured', {
      path: path.join(tmp, 'compaction', `a${i % AGENTS}`), config: GOOD_CONFIG, activatedBy: null
    });
  }

  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  check(
    lines.length < 100,
    'PRECONDITION: a compaction really happened — the log collapsed to roughly one row per ' +
      'agent, so this section is reading a REWRITTEN file rather than an untouched one',
    `${lines.length} lines from 520 records`
  );
  check(
    lines.includes(SPECIMEN),
    'THE SPECIMEN SURVIVED COMPACTION, byte for byte. This is the assertion that stops ' +
      '"skip the row" from becoming "delete the record" 500 records later.'
  );
  check(lines.includes(handEdit), 'and so did the hand-edit casualty');

  const after = scanLogVersions(file);
  check(after.unreadable.length === 2, 'the rewritten log still discloses both',
    `${after.unreadable.length}`);
  check(
    registry.intents().size === AGENTS,
    'while every readable agent is still there',
    `${registry.intents().size} intents`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. A prompt in an unreadable row is not published by the back door ===');
// ---------------------------------------------------------------------------
{
  // `config.prompt` is the one field a caller freezes onto an agent that the
  // ordinary config echo does NOT carry. Publishing an unreadable row's bytes
  // unfiltered would hand it back on the same response that withholds it one
  // field to the left, which is a surface widening nobody asked for.
  const secret = 'BOOTSTRAP-TEXT-THAT-MUST-NOT-APPEAR-' + 'x'.repeat(40);
  const dir = path.join(tmp, 'redact');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    v: 1, event: 'activated', path: '/tmp/kan302-prompt',
    config: { ...GOOD_CONFIG, launcher: '', prompt: secret }
  }) + '\n');

  const rows = scanLogVersions(file).unreadable;
  check(rows.length === 1, 'the row is unreadable (its launcher is empty)', `${rows.length}`);
  check(rows[0]?.promptRedacted === true, 'and the disclosure says a prompt was withheld');
  check(!rows[0]?.raw.includes(secret), 'the prompt is NOT in the published bytes');
  check(
    /prompt withheld/.test(rows[0]?.raw ?? ''),
    'the withholding is marked in place rather than the field silently vanishing',
    rows[0]?.raw?.slice(0, 120)
  );
  // A redaction that also broke the repair would be a poor trade: everything
  // else about the row still has to be there for the operator to fix it.
  check(
    /"launcher":""/.test(rows[0]?.raw ?? ''),
    'and every other field survives, so the row is still repairable from the disclosure'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. No repair the daemon offers destroys the durable record ===');
// ---------------------------------------------------------------------------
{
  // The text this replaces named "Delete <registry> and `configure` the fleet
  // again" as remedy 1 and called it "the right answer for every real
  // deployment". On a machine with a fleet that is every agent record thrown
  // away to recover from one row. This section is a grep, and it is deliberate
  // that it is a grep: the failure it guards against is a sentence coming back.
  const scan = scanLogVersions(path.join(tmp, 'specimen', 'agents.jsonl'));
  const text = describeUnreadableLog(scan);
  console.log('--- the notice, verbatim ---\n' + text + '\n---');

  check(scan.unreadable.length === 1, 'the notice is about the real specimen', `${scan.unreadable.length}`);
  check(
    !/\bDelete\b|\bdelete\b|\brm\b|\btruncate\b|start from an empty log/.test(text),
    'THE NOTICE NEVER TELLS THE OPERATOR TO DESTROY THE REGISTRY — no "delete", no "rm", ' +
      'no "start from an empty log", at any severity'
  );
  check(/line 1/.test(text), 'it names the offending LINE');
  check(/crabcast-shell-demo/.test(text), 'and the offending row');
  check(
    /repair a row, edit THAT LINE/.test(text) && /every other record in this file is fine/.test(text),
    'and the repair it offers is per-row, stating that every other record is untouched'
  );
  check(
    !/refusing to start/.test(text),
    'and it no longer claims to be refusing, because it is not'
  );
  check(
    /HAVE NOT BEEN RESTORED/.test(text),
    'while still saying plainly that the agents in those rows are NOT running — starting is ' +
      'not the same as pretending the rows were readable'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. MUTATION: restore the refusal, and require §1 to go red ===');
// ---------------------------------------------------------------------------
{
  const { mutate } = makeMutator({
    distDir, scratch: path.join(tmp, 'mutants'), report
  });

  // Restores exactly the pre-KAN-302 behaviour: notice, then exit(1). The
  // fingerprint is what the precondition below reads, so that a mutant which
  // died on an unresolved import cannot be mistaken for one that refused.
  const mutantDist = mutate(
    'refuse-on-unreadable-row',
    'daemon.js',
    'const unreadableAtBoot = logScan.preMigration + logScan.fromNewer + logScan.unusable;',
    'const unreadableAtBoot = logScan.preMigration + logScan.fromNewer + logScan.unusable;\n' +
      'if (unreadableAtBoot > 0) { process.stderr.write("MUTANT-REFUSED: pre-KAN-302 boot ' +
      'refusal restored\\n"); process.exit(1); }'
  );

  if (mutantDist) {
    const c = makeCase('mutant', [SPECIMEN]);
    const result = spawnSync(process.execPath, [path.join(mutantDist, 'daemon.js'), c.cfg], {
      encoding: 'utf8', timeout: 15000
    });

    // THE PRECONDITION `scripts/mutation.mjs` demands of every caller. "The
    // daemon did not come up" is trivially true of a mutant that died on
    // startup, which would produce this section's evidence while proving
    // nothing at all. So the mutant is caught doing the one thing only the
    // mutant does, as a positive fact, before anything below is read.
    check(
      /MUTANT-REFUSED/.test(result.stderr ?? ''),
      'PRECONDITION: the mutant ran and took its own branch — this is the mutant refusing, ' +
        'not a mutant that failed to load',
      (result.stderr ?? '').split('\n')[0]?.slice(0, 80)
    );
    check(result.status === 1, 'the mutated build EXITS 1 where the real one starts',
      `exit ${result.status}`);
    check(
      !fs.existsSync(c.socket),
      "and binds no socket — §1's central assertion goes red against it, which is what makes " +
        '§1 a measurement rather than an observation that has only ever passed'
    );
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
