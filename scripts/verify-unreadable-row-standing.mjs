#!/usr/bin/env node
// KAN-344: an unreadable registry row says whether it MATTERS, not only why it
// could not be read — and the two values behind that verdict are the row's own,
// quoted rather than interpreted.
//
// WHAT FAILURE THIS WOULD CATCH: a build in which `unreadableRecords[]` goes
// back to carrying only the line number and the reason — `standing` frozen to
// one value, or either `claims*` field stuck at null — so that a consumer
// meeting `unreadableRecordsTotal: 1` is back to being unable to tell a
// nine-day-old tombstone from a row claiming an agent nothing restored. It also
// catches the two quieter ways the same disclosure goes wrong: the two quotes
// being read off the CLIPPED `raw` instead of the parsed row, which makes
// `claimsAt: null` mean two different things on a long line; and this daemon
// reading a `from-newer` row's event vocabulary as though it were its own,
// which contradicts that row's own stated reason in the same response.
//
// AND SINCE KAN-358, ONE MORE THAT IS NOT ABOUT THE DISCLOSURE'S CONTENT: a
// build in which a SECOND rendering of a row has been written back into
// `classifyLog`, where the raw `parsed` line is in scope. That is the shape the
// deleted `scan.samples` had — a one-liner derived from `parsed` rather than
// from the record, free to disagree with the notice about what a row said, and
// read by nobody so that nothing would ever have shown the disagreement.
//
// ---------------------------------------------------------------------------
// WHY THE FIXTURES ARE WRITTEN BY THE DAEMON AND THE EXPECTATIONS COME FROM THE
// DOCUMENT — neither is a literal in this file, and that is load-bearing twice.
//
// THE ROWS are produced by a real `AgentRegistry.record()` and then perturbed:
// `v` deleted for a pre-migration row, `v + 1` for a from-newer one, a required
// `config` field removed for an unusable one. So the readable baseline is
// whatever this daemon actually writes today — if the row format moves, these
// fixtures move with it, where a pasted JSON literal would go on testing the
// format of the afternoon it was pasted. §2's control row is the proof that the
// baseline really is readable: a fixture that was unreadable for a reason this
// file did not intend would make every case below pass for the wrong reason.
//
// THE EXPECTED CLASSIFICATION is parsed out of the `rowStanding` table in
// `docs/read-path-contract.md`, and the event vocabulary out of the daemon's own
// refusal text. Those are two independent sources, and neither is the classifier
// under test — so §1 is a genuine reconciliation rather than the code agreeing
// with a copy of itself. A fifth `AgentEvent` classified in code and left out of
// the document is red here; so is a documented event the daemon does not know.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITS OWN INPUT FOR, AND WHO COVERS THE REST.
//
// Every registry in this file is one this script wrote. So it does not test
// that a row of any of these shapes ever reaches a registry in production — it
// tests what the daemon does with one that has. Two things cover that gap and
// neither is inside CI:
//
//   * The real specimen, on the real machine, is in the pull request body: the
//     row that commissioned KAN-302 and KAN-344, read off
//     `~/.local/share/crabcast/agents.jsonl` through the running daemon, before
//     and after. CI starts from an empty directory and cannot own that half.
//   * `verify-registry-survives-retired-rows.mjs` is the sibling that owns
//     PRESERVATION — that the row survives a boot and a compaction at all. §4
//     here asserts only the narrower thing this ticket adds (the three new
//     fields answer the same after a rewrite) and deliberately does not restate
//     the guarantee: two scripts asserting one property is how the property ends
//     up owned by neither.
//
// UNDEFENDED, named rather than left to be discovered: nothing here proves a
// consumer ACTS on `standing`. It proves the field arrives, on both surfaces,
// with the value the document says. Whether Butchr branches on it is Butchr's
// tree and no script in this repository can see it.
//
// AND ONE SEAM INSIDE THIS FILE, because the obvious reading of §5 is generous
// to it. THIS PARAGRAPH IS THE ONE THAT CAUGHT KAN-358 and it is kept rather
// than deleted with what it disclosed — what changed is which sentence in it is
// true, so the sentence is replaced and the habit is not.
//
// WHAT IT USED TO SAY. §5 had two halves against two different surfaces: the
// notice `describeUnreadableLog` returns, which `src/daemon.ts` writes to
// stderr and to `daemon.log`, and `scan.samples`, a list of one-liners that
// NOTHING IN THE DAEMON CONSUMED. §5b and §6d held a real anti-drift property
// over a value with no reader, and this paragraph said so — "they must not be
// read as evidence that an operator sees anything" — and filed KAN-358.
//
// WHAT IS TRUE NOW. KAN-358 deleted the field, and §5 is one surface: the
// notice, which is read. The anti-drift property did not go with it. It is
// carried by the type instead — `describeUnreadableLog(scan: LogVersionScan)`
// cannot name the raw `parsed` row, and `classifyLog`, the one function where
// `parsed` is in scope, no longer renders any text — so the second derivation
// is unrepresentable rather than merely unobserved, and no assertion here is
// standing in for it. §6d starves the notice's own two renders instead, which
// is coverage this file did not have before.
//
// SO THE LIMIT THAT REPLACES THE OLD ONE, in the same spirit: everything §5
// asserts is about the STRING this function returns. That `src/daemon.ts` calls
// it, and that the string therefore reaches stderr and `daemon.log`, is read
// off two call sites and not exercised here; and no script in this repository
// establishes that an operator ever opens that log. §3 is the surface with a
// consumer this file can actually reach, and it is the wire rather than the
// notice.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const docPath = path.join(repoRoot, 'docs', 'read-path-contract.md');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const report = {
  pass: (label, detail) => check(true, label, detail),
  fail: (label, detail) => check(false, label, detail)
};

// ---------------------------------------------------------------------------
console.log('\n=== 0. Preconditions — a verdict read off a stale build is evidence about code nobody wrote ===');
// ---------------------------------------------------------------------------
//
// The first is a SETUP GUARD and exits: with no build there is nothing to
// import and every section below would fail for one uninteresting reason. The
// second is a COUNTED FAILURE, because a `dist` older than `src` produces a
// perfectly plausible run against the previous build — the outcome that misleads
// in both directions, and the one this epic has been caught by twice.
//
// AND THIS FILE'S EXIT CODE IS A BLEND, which is worth knowing before anybody
// reads a verdict off it (KAN-358). Every section except §5b imports from
// `dist` and is therefore evidence about the BUILD. §5b reads
// `src/agent-registry.ts` as text and is evidence about the TREE. So on a run
// where the build is stale the guard above goes red and §5b's verdict is still
// good, while everything else is about code nobody in this tree wrote. Read the
// section, not the exit code.
const daemonJs = path.join(distDir, 'daemon.js');
if (!fs.existsSync(daemonJs)) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(1);
}

const newest = (dir) => {
  let latest = 0;
  let file = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const p = path.join(entry.parentPath ?? entry.path, entry.name);
    const m = fs.statSync(p).mtimeMs;
    if (m > latest) { latest = m; file = p; }
  }
  return { latest, file };
};
const srcNewest = newest(path.join(repoRoot, 'src'));
const distNewest = newest(distDir);
check(
  distNewest.latest >= srcNewest.latest,
  'dist is not older than src, so what follows is a verdict about the code in this tree',
  `newest src ${path.basename(srcNewest.file)} @${new Date(srcNewest.latest).toISOString()}; ` +
    `newest dist @${new Date(distNewest.latest).toISOString()}`
);

const registryMod = await import(path.join(distDir, 'agent-registry.js'));
// `describeUnreadableLog` is deliberately NOT destructured here: §5 reaches it
// through the module it was handed, so the identical assertion set runs against
// a starved build in §6d. A convenient top-level binding is how half a section
// ends up testing the real build while the other half tests the mutant.
const { AgentRegistry, scanLogVersions, UNREADABLE_RAW_LIMIT } = registryMod;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan344-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// The mutants in §6 import `node-pty` and the MCP SDK by bare specifier from a
// directory outside this repository, where node's upward resolution finds
// nothing. Without this they die on an unresolved import and produce exactly
// what a correctly-starved build produces — nothing — which is the failure mode
// scripts/mutation.mjs warns every caller about.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch { /* already there, or unsupported; §6's preconditions will say so */ }

const mutate = makeMutator({ distDir, scratch: tmp, report }).mutate;

// ---------------------------------------------------------------------------
// The fixtures, derived. Nothing below is a pasted row.
// ---------------------------------------------------------------------------

const GOOD_CONFIG = {
  priority: 5,
  refusable: true,
  chargeable: true,
  preemptable: true,
  launcher: 'shell'
};

/**
 * One genuine registry line, written by the daemon's own writer.
 *
 * A FRESH DIRECTORY PER CALL, counted rather than named: two calls that shared
 * one appended to the same file, and the second read back two lines as one row.
 */
let written = 0;
function writtenRow(event, { at = '2026-08-03T20:37:38.900Z', dir = 'writer' } = {}) {
  const home = path.join(tmp, `${dir}-${event}-${written++}`);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'agents.jsonl');
  const reg = new AgentRegistry(file);
  const outcome = reg.record(
    event,
    { path: `/tmp/kan344/${event}`, config: GOOD_CONFIG, activatedBy: null },
    undefined,
    at
  );
  if (!outcome.ok) throw new Error(`the daemon's own writer refused a ${event} row: ${outcome.error}`);
  const line = fs.readFileSync(file, 'utf8').trim();
  return JSON.parse(line);
}

/** The four perturbations, each expressed against a row the daemon wrote. */
const asPreMigration = (row) => {
  const { v, path: p, ...rest } = row;
  // The retired vocabulary, as the real specimen carries it: addressed by
  // <type>/<key>, with the directory in `workDir` and no `v` at all.
  return { agentName: 'crabcast-shell-demo', type: 'shell', key: 'demo', workDir: p, ...rest };
};
const asFromNewer = (row) => ({ ...row, v: row.v + 1 });
const asUnusable = (row) => ({ ...row, config: { ...row.config, priority: undefined } });

/** Seed a registry with these row objects and classify it, in file order. */
function classify(name, rows) {
  const dir = path.join(tmp, `case-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { file, dir, scan: scanLogVersions(file), seeded: rows.length };
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. The classification agrees with the DOCUMENT, over the daemon\'s own vocabulary ===');
// ---------------------------------------------------------------------------
//
// Two independent sources, neither of them the classifier: the set of events
// comes from the daemon's refusal text, and which standing each one carries
// comes from the published table. A mapping that exists only in code is red.

/** The events this daemon knows, read out of its own complaint about a bad one. */
function knownEventsFromDaemon() {
  const bad = classify('vocabulary', [{ ...writtenRow('activated'), event: 'not-an-event' }]);
  const reason = bad.scan.unreadable[0]?.reason ?? '';
  const m = /"event" must be one of ([^;]+)/.exec(reason);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The document's rowStanding table, as a map from standing to the events it
 * claims. Pure, so §1b can run it against a doctored copy of the same text.
 */
function docStandingTable(text, knownEvents) {
  const marker = '<!-- contract-values: rowStanding -->';
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const table = {};
  for (const line of text.slice(start + marker.length).split('\n')) {
    const row = /^\|\s*`([a-z-]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!row) {
      if (Object.keys(table).length) break; // the table ended
      continue;
    }
    table[row[1]] = [...row[2].matchAll(/`([a-z-]+)`/g)]
      .map((m) => m[1])
      .filter((w) => knownEvents.includes(w));
  }
  return table;
}

/** What §1 asserts, as a function, so §1b can require it to FAIL. */
function reconcile(table, knownEvents) {
  const problems = [];
  if (!table) return ['no rowStanding table in the document'];
  const classified = [...(table.retired ?? []), ...(table['claims-an-agent'] ?? [])];
  for (const e of knownEvents) {
    const times = classified.filter((c) => c === e).length;
    if (times !== 1) problems.push(`event \`${e}\` is named by ${times} standing(s), not exactly 1`);
  }
  for (const e of classified) {
    if (!knownEvents.includes(e)) problems.push(`the document classifies \`${e}\`, which is not an event`);
  }
  if ((table.unknown ?? []).length) {
    problems.push(`\`unknown\` claims event(s) ${table.unknown.join(', ')}; it must claim none`);
  }
  return problems;
}

const KNOWN_EVENTS = knownEventsFromDaemon();
check(
  KNOWN_EVENTS.length >= 2,
  "the daemon named its own event vocabulary, so the reconciliation has something to reconcile",
  KNOWN_EVENTS.join(', ') || '(the refusal text did not name any — the regex has drifted)'
);

const docText = fs.readFileSync(docPath, 'utf8');
const DOC_TABLE = docStandingTable(docText, KNOWN_EVENTS);
const problems = reconcile(DOC_TABLE, KNOWN_EVENTS);
check(
  problems.length === 0,
  'every event this daemon knows is classified exactly once by the published table, and it classifies nothing else',
  problems.length
    ? problems.join('; ')
    : Object.entries(DOC_TABLE).map(([k, v]) => `${k}:[${v.join('|')}]`).join(' ')
);

/** standing → events, from the DOCUMENT. Every expectation below reads this. */
const EXPECTED = new Map();
for (const [standing, events] of Object.entries(DOC_TABLE ?? {})) {
  for (const e of events) EXPECTED.set(e, standing);
}

// --- 1b. and the reconciliation can fail --------------------------------------
{
  // The doctored copy drops `forgotten` from the retired row — the shape of a
  // real omission: somebody adds or moves an event and edits the code only.
  const doctored = docText.replace(
    /(\|\s*`retired`\s*\|[^\n]*?)`forgotten`,?\s*/,
    '$1'
  );
  const applied = doctored !== docText;
  check(applied, 'the doctored document differs from the real one, so 1b tests a mutation rather than a copy');
  const after = reconcile(docStandingTable(doctored, KNOWN_EVENTS), KNOWN_EVENTS);
  check(
    applied && after.length > 0,
    'and §1 goes RED when an event this daemon knows loses its row in the table — the check is not vacuous',
    after.join('; ') || 'it stayed green, which means §1 would not notice an unclassified event'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. One row per case: the quotes are the row\'s, the verdict is ours ===');
// ---------------------------------------------------------------------------

/** Every fixture row, with what the wire must say about it. Order is file order. */
const CASES = [];
for (const event of KNOWN_EVENTS) {
  CASES.push({
    name: `pre-migration/${event}`,
    row: asPreMigration(writtenRow(event)),
    problem: 'pre-migration',
    standing: EXPECTED.get(event),
    claimsEvent: event,
    claimsAt: '2026-08-03T20:37:38.900Z'
  });
}
CASES.push({
  name: 'from-newer/deactivated',
  row: asFromNewer(writtenRow('deactivated', { dir: 'newer' })),
  problem: 'from-newer',
  // THE ABSTENTION. The word is one we know and we decline to read it anyway.
  standing: 'unknown',
  claimsEvent: 'deactivated',
  claimsAt: '2026-08-03T20:37:38.900Z'
});
CASES.push({
  name: 'unusable/toString',
  // A word that is a property of `Object.prototype`. On a plain-object lookup
  // this resolves to a FUNCTION, which is truthy and which `JSON.stringify`
  // then drops — the response would carry no `standing` key at all.
  row: { ...asUnusable(writtenRow('activated', { dir: 'proto' })), event: 'toString' },
  problem: 'unusable',
  standing: 'unknown',
  claimsEvent: 'toString',
  claimsAt: '2026-08-03T20:37:38.900Z'
});
CASES.push({
  name: 'unusable/no-at-no-event',
  row: (() => {
    const { at, event, ...rest } = asUnusable(writtenRow('activated', { dir: 'bare' }));
    return { ...rest, event: 'configured' };
  })(),
  problem: 'unusable',
  standing: EXPECTED.get('configured'),
  claimsEvent: 'configured',
  claimsAt: null
});
CASES.push({
  name: 'unusable/non-string-at-and-event',
  row: { ...asUnusable(writtenRow('activated', { dir: 'numeric' })), at: 12345, event: 67890 },
  problem: 'unusable',
  standing: 'unknown',
  claimsEvent: null,
  claimsAt: null
});
// THE THIRD INPUT THAT MEANS "NAMES NOTHING", and it had no fixture until the
// review starved the guard and this file did not notice. `''` IS A STRING, so
// the `typeof` half passes and only `&& parsed.at.length` sends it to null —
// which makes that clause a decision rather than an idiom, and an undefended
// decision is one a later author deletes with every check still green. It is
// not hypothetical either: the live specimen carries `"workDir": ""`, which is
// why `claimsPath` grew the same treatment first.
CASES.push({
  name: 'unusable/empty-string-at-and-event',
  row: { ...asUnusable(writtenRow('activated', { dir: 'empty' })), at: '', event: '' },
  problem: 'unusable',
  standing: 'unknown',
  claimsEvent: null,
  claimsAt: null
});

// THE TRUNCATION CASE, and it is the one that distinguishes reading the parsed
// row from reading the disclosure. `at` is the LAST key of a row padded past
// UNREADABLE_RAW_LIMIT, so a `claimsAt` taken off `raw` would be null for a row
// that plainly names a time — a null meaning two things, which is this ticket's
// own defect one field over.
const LONG_AT = '2026-08-04T01:02:03.456Z';
const longRow = (() => {
  const base = asPreMigration(writtenRow('deactivated', { dir: 'long', at: LONG_AT }));
  const { at, ...rest } = base;
  return { ...rest, padding: 'x'.repeat(UNREADABLE_RAW_LIMIT + 512), at: LONG_AT };
})();
CASES.push({
  name: 'pre-migration/at-past-the-raw-limit',
  row: longRow,
  problem: 'pre-migration',
  standing: EXPECTED.get('deactivated'),
  claimsEvent: 'deactivated',
  claimsAt: LONG_AT,
  expectTruncated: true
});

// A readable row, first in the file. It is the vacuity guard's other half: if
// the daemon's own writer produced something this daemon cannot read, every
// case above would be passing for a reason this file did not intend.
const CONTROL = writtenRow('configured', { dir: 'control' });

/**
 * Run every case through one registry and return the assertions, so §6 can run
 * the identical set against a starved build and require named ones to fail.
 */
function assertCases(mod, label) {
  const rows = [CONTROL, ...CASES.map((c) => c.row)];
  const dir = path.join(tmp, `run-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agents.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const scan = mod.scanLogVersions(file);

  const results = [];
  const say = (ok, name, detail) => results.push({ ok, name, detail });

  // --- the vacuity guard, before any per-case assertion ---------------------
  // Without these three, every assertion below could be true of an empty list.
  say(
    scan.unreadable.length === CASES.length,
    'vacuity: the unreadable branch ran once per fixture and not at all for the control',
    `${scan.unreadable.length} disclosed, ${CASES.length} expected, ${rows.length} rows seeded`
  );
  say(
    scan.rows === rows.length,
    'vacuity: every seeded row parsed, so nothing was skipped as a torn line',
    `parsed ${scan.rows} of ${rows.length}`
  );
  say(
    !scan.unreadable.some((u) => u.line === 1),
    'vacuity: the CONTROL row was readable — the fixtures are unreadable by construction, not by accident',
    scan.unreadable.map((u) => u.line).join(',')
  );
  // THE FOURTH GUARD, AND IT WAS FOUND BY RUNNING THIS FILE AGAINST THE
  // PRE-FIX BUILD RATHER THAN BY READING IT. `EXPECTED` is derived from the
  // document's table, so on a tree where that table does not exist it is EMPTY
  // — and every per-case standing comparison below silently became
  // `undefined === undefined` and PASSED. Four assertions reported "standing is
  // undefined — standing=undefined" as a pass. §1 still went red, so the run
  // failed; but the section that is supposed to hold the classifier was hollow,
  // which is this epic's own defect sitting inside its proof.
  const underived = CASES.filter((c) => typeof c.standing !== 'string' || !c.standing.length);
  say(
    underived.length === 0,
    'vacuity: every case carries a standing EXPECTATION derived from the document — an absent table must not turn these into undefined === undefined',
    underived.length ? `${underived.length} case(s) with no expectation: ${underived.map((c) => c.name).join(', ')}` : `${CASES.length} expectations`
  );

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const got = scan.unreadable[i] ?? {};
    say(got.problem === c.problem, `${c.name}: classified ${c.problem}`, `problem=${got.problem}`);
    say(
      got.standing === c.standing,
      `${c.name}: standing is ${c.standing}`,
      `standing=${JSON.stringify(got.standing)}`
    );
    say(
      got.claimsEvent === c.claimsEvent,
      `${c.name}: claimsEvent quotes ${JSON.stringify(c.claimsEvent)}`,
      `claimsEvent=${JSON.stringify(got.claimsEvent)}`
    );
    say(
      got.claimsAt === c.claimsAt,
      `${c.name}: claimsAt quotes ${JSON.stringify(c.claimsAt)}`,
      `claimsAt=${JSON.stringify(got.claimsAt)}`
    );
    if (c.expectTruncated) {
      say(got.rawTruncated === true, `${c.name}: raw really was clipped`, `rawTruncated=${got.rawTruncated}`);
      say(
        typeof got.raw === 'string' && !got.raw.includes(c.claimsAt),
        `${c.name}: and the timestamp is NOT in the clipped raw — so claimsAt came off the parsed row`,
        `raw is ${got.raw?.length} chars`
      );
    }
  }

  // The abstention, stated as its own assertion rather than left implicit in a
  // table row: the disagreement between the quote and the verdict is the point.
  const newer = scan.unreadable.find((u) => u.problem === 'from-newer');
  say(
    newer?.claimsEvent === 'deactivated' && newer?.standing === 'unknown',
    'from-newer: the quote and the verdict DISAGREE legibly — the word travels, the reading is withheld',
    `claimsEvent=${JSON.stringify(newer?.claimsEvent)} standing=${JSON.stringify(newer?.standing)}`
  );
  return results;
}

const baseline = assertCases(registryMod, 'baseline');
for (const r of baseline) check(r.ok, r.name, r.detail);

// ---------------------------------------------------------------------------
console.log('\n=== 3. On the wire — both surfaces, from a real daemon over its socket ===');
// ---------------------------------------------------------------------------
//
// The classifier being right is not the claim a consumer cares about; the claim
// is that the values ARRIVE. `list_agents` and `daemon_status` are asserted
// together and against each other, because publishing on one and not the other
// is how two surfaces come to disagree about the same registry.
{
  const dir = path.join(tmp, 'wire');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'agents.jsonl'),
    [CONTROL, ...CASES.map((c) => c.row)].map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
  const cfg = path.join(tmp, 'wire.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ dataDir: dir }));
  const socket = path.join(dir, 'crabcast.sock');

  // Isolated from the host's herdr the way the sibling does it, and for the
  // same reason: `resolveUserPath()` rebuilds PATH from the login shell and
  // `~/.local/bin`, so pinning PATH alone would still have found the real one
  // and this run would have been a statement about the developer's fleet.
  const bin = path.join(tmp, 'bin');
  const fakeHome = path.join(tmp, 'wire-home', '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  const shim = path.join(bin, 'herdr');
  fs.writeFileSync(
    shim,
    '#!/bin/bash\n' +
      'if [ "$1" = "--version" ]; then echo "herdr 0.6.4"; exit 0; fi\n' +
      'if [ "$1" = "agent" ] && [ "$2" = "list" ]; then echo \'{"result":{"agents":[]}}\'; exit 0; fi\n' +
      'if [ "$1" = "pane" ] && [ "$2" = "list" ]; then echo \'{"result":{"panes":[]}}\'; exit 0; fi\n' +
      'echo \'{"result":{}}\'\n',
    { mode: 0o755 }
  );
  fs.copyFileSync(shim, path.join(fakeHome, 'herdr'));
  fs.chmodSync(path.join(fakeHome, 'herdr'), 0o755);
  const env = {
    ...process.env,
    HOME: path.join(tmp, 'wire-home'),
    SHELL: '/bin/bash',
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`
  };

  const child = spawn(process.execPath, [daemonJs, cfg], { stdio: ['ignore', 'ignore', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  process.on('exit', () => { try { child.kill(); } catch {} });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const up = await (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const probe = net.connect(socket);
        probe.once('connect', () => { probe.end(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (ok) return true;
      await sleep(100);
    }
    return false;
  })();
  check(up, 'the daemon came up on a registry of rows it cannot read', up ? socket : stderr.slice(0, 400));

  const ask = (request) => new Promise((resolve, reject) => {
    const sock = net.connect(socket);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out')); }, 10000);
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

  if (up) {
    const status = await ask({ action: 'daemon_status', id: 1 });
    const list = await ask({ action: 'list_agents', id: 2 });

    check(status.success === true && list.success === true, 'both surfaces answered');
    check(
      status.contractVersion === 7,
      'the wire reports read-contract version 7 — the version this row shape belongs to',
      `contractVersion=${status.contractVersion}`
    );

    for (const [name, res] of [['daemon_status', status], ['list_agents', list]]) {
      const rows = res.unreadableRecords ?? [];
      check(
        res.unreadableRecordsTotal === CASES.length,
        `${name}: discloses all ${CASES.length} unreadable rows`,
        `total=${res.unreadableRecordsTotal}`
      );
      const carried = rows.every(
        (r) => 'standing' in r && 'claimsAt' in r && 'claimsEvent' in r
      );
      check(carried, `${name}: every disclosed row carries the three new keys`,
        `first=${JSON.stringify(rows[0] ?? null).slice(0, 160)}`);
      const tombstone = rows.find((r) => r.claimsEvent === 'deactivated' && r.problem === 'pre-migration');
      check(
        tombstone?.standing === 'retired' && tombstone?.claimsAt === '2026-08-03T20:37:38.900Z',
        `${name}: the tombstone case reads as a dated, retired row — the sentence KAN-39 could not get`,
        `standing=${tombstone?.standing} claimsAt=${tombstone?.claimsAt}`
      );
    }

    // The two surfaces must AGREE. A disclosure published twice from two reads
    // is two chances to answer differently about one line.
    const key = (r) => `${r.line}|${r.problem}|${r.standing}|${r.claimsEvent}|${r.claimsAt}`;
    check(
      JSON.stringify((status.unreadableRecords ?? []).map(key)) ===
        JSON.stringify((list.unreadableRecords ?? []).map(key)),
      'and the two surfaces say exactly the same thing about the same rows'
    );
  }

  child.kill();
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Compaction rewrites the file and the three fields do not move ===');
// ---------------------------------------------------------------------------
//
// PRESERVATION ITSELF IS NOT THIS FILE'S CLAIM — it is KAN-302's, and
// `verify-registry-survives-retired-rows.mjs` §3 owns it. What is asserted here
// is only what this ticket added: after the rewrite, the same rows answer the
// same three values. A compaction that carried the bytes but re-derived the
// verdict differently would satisfy the sibling and fail here.
{
  const c = classify('compaction', [CONTROL, ...CASES.map((x) => x.row)]);
  const before = c.scan.unreadable.map((u) => `${u.identity}|${u.standing}|${u.claimsEvent}|${u.claimsAt}`);
  const reg = new AgentRegistry(c.file);
  const outcome = reg.compact();
  check(outcome.ok, 'compaction ran', outcome.ok ? '' : outcome.error);
  const after = scanLogVersions(c.file).unreadable.map(
    (u) => `${u.identity}|${u.standing}|${u.claimsEvent}|${u.claimsAt}`
  );
  check(
    before.length === CASES.length && JSON.stringify(before) === JSON.stringify(after),
    'every unreadable row answers the same standing and the same two quotes after the file was rewritten',
    `${before.length} before, ${after.length} after`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. The boot notice is rendered FROM the record, not derived a second time ===');
// ---------------------------------------------------------------------------
//
// Before KAN-344 the notice re-read `parsed.event` and `parsed.at` for itself,
// which made two derivations of one fact — the arrangement `classifyRow`'s own
// header argues against. The fixture that separates them is the row whose `at`
// and `event` are NUMBERS: the record quotes only strings, so it says "no event"
// where a second derivation off `parsed` would print `67890`.
//
// ONE SURFACE NOW, AND IT IS THE CONSUMED ONE (KAN-358). This section used to
// have a second half asserting the same property over `scan.samples`, a list of
// pre-rendered one-liners that nothing in the daemon read. That field is gone,
// and the property has not been dropped with it — it has moved from an
// assertion to the type. `describeUnreadableLog` takes a `LogVersionScan`, in
// which the raw `parsed` row is not nameable, and `classifyLog` — the one place
// `parsed` IS in scope — now renders no text at all. So the re-derivation the
// old §6d starved cannot be written any more, which is why §6d below starves
// something else: the two values this notice DOES render, neither of which had
// ever been shown capable of going missing.
//
// WHY THE EVENT IS NOT ASSERTED HERE, kept from the draft that got it wrong:
// `describeUnreadableLog` never prints `claimsEvent` at all, so a check that
// the event is absent from the notice could not fail. `claimsEvent` is held by
// §2 (the record) and §3 (both wire surfaces), which is where it is consumed.
//
// The assertions are a function so §6d can run the identical set against a
// starved build and require NAMED ones to fail, exactly as §6 does with §2's.
function assertNotice(mod, label) {
  const dir = path.join(tmp, `notice-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agents.jsonl');
  const rows = [CONTROL, ...CASES.map((x) => x.row)];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const scan = mod.scanLogVersions(file);
  const notice = mod.describeUnreadableLog(scan);

  const results = [];
  const say = (ok, name, detail) => results.push({ ok, name, detail });

  // --- the vacuity guards, before any assertion about the text --------------
  // Every negative check below ("the notice does not say X") is satisfied for
  // free by a notice that reached no row, so what the rows are has to be
  // established first — and separately, so a starve that broke the fixtures
  // rather than the render cannot credit itself with the red.
  const numeric = scan.unreadable.find((u) => u.claimsEvent === null && u.claimsAt === null);
  const dated = scan.unreadable.find((u) => u.claimsAt);
  const retired = scan.unreadable.find((u) => u.standing === 'retired');
  say(
    scan.unreadable.length === CASES.length,
    'vacuity: the notice was built over every fixture row',
    `${scan.unreadable.length} disclosed, ${CASES.length} expected`
  );
  say(Boolean(numeric), 'vacuity: the numeric-fields fixture reached the notice', `identity=${numeric?.identity}`);
  say(Boolean(dated), 'vacuity: a row naming a STRING date reached the notice', `claimsAt=${dated?.claimsAt}`);
  say(Boolean(retired), 'vacuity: a retired row reached the notice', `identity=${retired?.identity}`);
  say(
    notice.split('\n').filter((l) => /^ {2}line \d+:/.test(l)).length === CASES.length,
    'vacuity: the notice printed one per-row line per fixture, so the greps below are over text that exists',
    `${notice.split('\n').filter((l) => /^ {2}line \d+:/.test(l)).length} row line(s) of ${CASES.length}`
  );

  say(
    !notice.includes('12345'),
    'notice: it does not date a row whose `at` is a NUMBER — it renders `claimsAt`, which quoted nothing',
    'a second derivation off `parsed` would have printed 12345'
  );
  say(
    Boolean(dated) && notice.includes(`the row dates itself ${dated.claimsAt}`),
    'notice: and it DOES date a row that names a string, so the check above is about the quoting rule rather than an empty notice',
    dated ? `looked for "${dated.claimsAt}"` : 'no dated row to look for'
  );
  say(
    Boolean(retired) && notice.includes(`(${retired.problem}, ${retired.standing})`),
    "notice: it carries the standing on the operator's line, where it decides whether to read further",
    retired ? `looked for "(${retired.problem}, ${retired.standing})"` : 'no retired row to look for'
  );
  say(
    !/\bdelete\b/i.test(notice),
    "notice: and KAN-302's rule still holds — no remedy this notice offers destroys a record"
  );
  return results;
}

for (const r of assertNotice(registryMod, 'baseline')) check(r.ok, r.name, r.detail);

// --- 5b. and there is exactly ONE rendering of a row --------------------------
//
// THE ONE STATIC SECTION IN THIS FILE, and both halves of that matter. It reads
// `src/agent-registry.ts` as TEXT, so its verdict is about the code in this
// tree rather than about `dist` — a stale or failed build can neither redden
// nor green it, which is the opposite of every section above and is why this
// script's exit code must not be read as a single kind of evidence. It is also
// the only section that CAN hold this property, because the property is an
// absence and an absence has no runtime behaviour to assert on.
//
// WHAT IT DEFENDS, narrowly, because the obvious version of the sentence
// overclaims and this epic is about sentences that outrun their mechanism:
//
//   * `describeUnreadableLog` cannot re-derive a row — it takes a
//     `LogVersionScan`, in which `parsed` is not nameable. TRUE BY
//     CONSTRUCTION, true before KAN-358, and not this check's business.
//   * The file holds exactly ONE rendering of a row, so there is nothing for
//     that rendering to drift against. TRUE ONLY WHILE `classifyLog` STAYS
//     EMPTY OF TEXT. That loop is the only scope a raw `parsed` row is
//     reachable from, nothing in the type system stops a second render being
//     written there, and until KAN-358 there WAS one — the `scan.samples`
//     one-liner, which §5b and §6d used to defend precisely because it could
//     drift. This is the assertion that replaces them.
//
// IT MATCHES `bad` AS WELL AS `parsed`, AND THAT STRICTNESS IS DELIBERATE. A
// second render built from the RECORD cannot disagree with the notice about
// what a row said — KAN-344 had already fixed the deleted line that far — so on
// the drift argument alone `${bad.…}` would be harmless. It is matched anyway,
// because the property this section holds is "exactly one rendering" and not
// "no re-derivation": a second one is a second reader to keep in step, a second
// place for a comment to claim an audience it does not have, and the whole of
// what KAN-358 found. A render that must exist belongs in
// `describeUnreadableLog`, where it is reachable and where §5 and §6d hold it.
{
  const registrySrc = fs.readFileSync(path.join(repoRoot, 'src', 'agent-registry.ts'), 'utf8');

  /**
   * `classifyLog`'s body, sliced to the next top-level declaration. Pure, so
   * the negative case below can run the identical predicate over a doctored
   * copy and require it to FAIL — the §1b arrangement, and the only thing that
   * stops a grep-shaped assertion passing because its anchor drifted.
   */
  function renderingsInClassifyLog(text) {
    const start = text.indexOf('function classifyLog(');
    if (start === -1) return null;
    const rest = text.slice(start + 1);
    const next = /^(?:export )?(?:function|const|interface|type|class) /m.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    // `${...}` interpolations of a row's own values — the parsed line, or the
    // record built from it. A `${i + 1}` line number is not a rendering of a
    // row and is deliberately not matched.
    return { body, hits: [...body.matchAll(/\$\{(?:parsed|bad)\b[^}]*\}/g)].map((m) => m[0]) };
  }

  const found = renderingsInClassifyLog(registrySrc);
  check(
    Boolean(found) && found.body.includes('scan.unreadable.push(bad)'),
    '5b: the slice really is `classifyLog`\'s body — a drifted anchor would make the check below pass over nothing',
    found ? `${found.body.length} chars` : 'no `function classifyLog(` in src/agent-registry.ts'
  );
  check(
    Boolean(found) && found.hits.length === 0,
    '5b: `classifyLog` interpolates no row value into any string — the notice is the only rendering, so there is nothing for it to drift against',
    found ? found.hits.join(' ; ') || 'no interpolation of `parsed` or `bad`' : 'body not found'
  );

  // THE NEGATIVE CASE. Re-insert the rendering KAN-358 deleted, in the shape a
  // later author would most plausibly write it, and require the same predicate
  // to catch it. Without this, §5b is a grep that has only ever been observed
  // finding nothing — which is the register's own definition of undefended, and
  // exactly what this reviewer starves.
  const doctored = registrySrc.replace(
    '    scan.unreadable.push(bad);\n',
    '    scan.unreadable.push(bad);\n' +
      '    scan.notes.push(`line ${bad.line}: ${parsed.event ?? \'no event\'}`);\n'
  );
  check(
    doctored !== registrySrc,
    '5b: the doctored source differs from the real one, so the negative case tests a re-inserted render rather than a copy'
  );
  const after = renderingsInClassifyLog(doctored);
  check(
    Boolean(after) && after.hits.length > 0,
    '5b: and the check goes RED when a second rendering is put back inside the loop — it is not a grep that has only ever found nothing',
    after ? after.hits.join(' ; ') || 'it stayed green, so §5b would not notice a re-derivation' : 'body not found'
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Starve each field, and require a NAMED assertion to go red ===');
// ---------------------------------------------------------------------------
//
// One mutation per published field, each leaving the extraction in place and
// no-opping only what reaches the caller — which is the review this PR was
// promised, applied by the author first. A section that merely observed "the
// run went red" would be satisfied by a mutant that died on startup, so each
// reports WHICH assertions failed and requires them to be the expected ones.
const STARVES = [
  {
    name: 'standing-constant',
    find: '\n        claimsEvent,\n        standing\n    };',
    replace: "\n        claimsEvent,\n        standing: 'retired'\n    };",
    expect: /standing is unknown|standing is claims-an-agent|verdict DISAGREE/
  },
  {
    name: 'claimsAt-null',
    find: '\n        claimsAt,\n',
    replace: '\n        claimsAt: null,\n',
    expect: /claimsAt quotes/
  },
  {
    name: 'claimsEvent-null',
    find: '\n        claimsEvent,\n',
    replace: '\n        claimsEvent: null,\n',
    expect: /claimsEvent quotes/
  },
  {
    // THE EMPTY-STRING GUARD, starved on its own. `typeof x === 'string'` alone
    // lets `''` through, so this mutant quotes an empty string back as though
    // the row had named a time. Two edits rather than one, because the two
    // fields are separate expressions and a mutation that hit only one would
    // leave the other's guard untested while the section reported it defended.
    name: 'empty-string-guard-dropped',
    edits: [
      {
        file: 'agent-registry.js',
        find: "typeof parsed.at === 'string' && parsed.at.length ? parsed.at : null",
        replace: "typeof parsed.at === 'string' ? parsed.at : null"
      },
      {
        file: 'agent-registry.js',
        find: "typeof parsed.event === 'string' && parsed.event.length ? parsed.event : null",
        replace: "typeof parsed.event === 'string' ? parsed.event : null"
      }
    ],
    expect: /empty-string-at-and-event: claims(At|Event) quotes/
  }
];

for (const s of STARVES) {
  starve: {
    const dir = s.edits
      ? mutate(s.name, s.edits)
      : mutate(s.name, 'agent-registry.js', s.find, s.replace);
    if (!dir) break starve;
    const mod = await import(path.join(dir, 'agent-registry.js'));
    // PRECONDITION: the mutant really loaded and really answers. Without this a
    // mutant that died on an unresolved import produces the same observation a
    // starved one does — an absence — and the section would credit itself.
    const alive = typeof mod.scanLogVersions === 'function';
    check(alive, `${s.name}: the mutated build loaded and is answering`);
    if (!alive) break starve;

    const results = assertCases(mod, s.name);
    const failed = results.filter((r) => !r.ok);
    const named = failed.filter((r) => s.expect.test(r.name));
    check(
      named.length > 0,
      `${s.name}: a NAMED assertion goes red when the field is starved — the field is defended`,
      named.length
        ? `${named.length} of ${failed.length} failures matched, e.g. "${named[0].name}" (${named[0].detail})`
        : `nothing matching ${s.expect} failed; ${failed.length} other failure(s). THE FIELD IS UNDEFENDED.`
    );
    // The vacuity guards must NOT be what caught it: a starve that broke the
    // fixture count rather than the field would be a different experiment.
    check(
      failed.every((r) => !r.name.startsWith('vacuity:')),
      `${s.name}: and the row set is unchanged, so what went red is the field and not the fixtures`,
      failed.filter((r) => r.name.startsWith('vacuity:')).map((r) => r.name).join('; ') || 'no vacuity guard fired'
    );
  }
}

// --- 6d. and the notice's own renders, starved the same way -------------------
//
// TWO STARVES OVER ONE SURFACE, REPLACING ONE OVER A SURFACE NOBODY READ
// (KAN-358). What stood here mutated the `scan.samples` line back to
// re-deriving the event off `parsed` and required the two renderings to
// disagree. That line is gone: `describeUnreadableLog` cannot re-derive,
// because `parsed` is not in its scope and `classifyLog` renders nothing — the
// property is now carried by the type rather than by this mutation, which is
// the trade §5's header states in full.
//
// So what is starved instead is what the property was always FOR: that the two
// values the notice renders reach the operator's line. Neither had ever been
// starved. §5 asserted both and nothing established either assertion could
// fail, which is the condition `verify-proof-defences` exists to name — and it
// bites hardest on the negative one, because "the notice does not print 12345"
// is satisfied by a notice that prints no date at all. `notice-drops-date` is
// what stops that pair from being a check and its own alibi.
const NOTICE_STARVES = [
  {
    name: 'notice-drops-date',
    find: '(row.claimsAt ? ` — the row dates itself ${row.claimsAt}` : \'\')',
    replace: "''",
    expect: /notice: and it DOES date a row/
  },
  {
    name: 'notice-drops-standing',
    find: '`  line ${row.line}: ${row.identity} (${row.problem}, ${row.standing})`',
    replace: '`  line ${row.line}: ${row.identity} (${row.problem})`',
    expect: /notice: it carries the standing/
  }
];

for (const s of NOTICE_STARVES) {
  starve: {
    const dir = mutate(s.name, 'agent-registry.js', s.find, s.replace);
    if (!dir) break starve;
    const mod = await import(path.join(dir, 'agent-registry.js'));
    // THE SAME PRECONDITION §6 CARRIES, and for the same reason: a mutant that
    // died on an unresolved import produces an absence, and an absence is what
    // a correctly-starved render produces too.
    const alive =
      typeof mod.scanLogVersions === 'function' && typeof mod.describeUnreadableLog === 'function';
    check(alive, `${s.name}: the mutated build loaded and is answering`);
    if (!alive) break starve;

    const results = assertNotice(mod, s.name);
    const failed = results.filter((r) => !r.ok);
    const named = failed.filter((r) => s.expect.test(r.name));
    check(
      named.length > 0,
      `${s.name}: a NAMED assertion goes red when the render is starved — the render is defended`,
      named.length
        ? `${named.length} of ${failed.length} failures matched, e.g. "${named[0].name}" (${named[0].detail})`
        : `nothing matching ${s.expect} failed; ${failed.length} other failure(s). THE RENDER IS UNDEFENDED.`
    );
    check(
      failed.every((r) => !r.name.startsWith('vacuity:')),
      `${s.name}: and the notice still reached every row, so what went red is the render and not the fixtures`,
      failed.filter((r) => r.name.startsWith('vacuity:')).map((r) => r.name).join('; ') || 'no vacuity guard fired'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n==============================================================================');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('==============================================================================');
process.exit(failures ? 1 : 0);
