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
// THE ONLY PROOF HERE THAT PARSES TYPESCRIPT, and §5b's header says why: the
// property it holds is "no string-building use of a row", which has no common
// surface form to grep for. A devDependency `npm ci` already installs.
import ts from 'typescript';
import { makeMutator } from './mutation.mjs';
import { READ_CONTRACT_VERSION } from '../dist/read-contract.js';

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
    // WAS `=== 7`, AND THAT LITERAL EXPIRED (KAN-338). The version this row
    // shape was introduced at is 7, and the wire has to carry it — but the
    // contract is additive, so ANY later slice that adds a field bumps it and
    // this check went red for a change that touched nothing here. It was found
    // by exactly that: KAN-338 added `measuredTreesSeen` to `capacity`, took
    // the contract to 8, and this line failed in CI while every assertion below
    // it passed. That is the KAN-245 shape — a hard-coded number that expires
    // silently — except this one expires LOUDLY and at the wrong file.
    //
    // TWO ASSERTIONS REPLACE IT, and neither is the tautology `wire === wire`:
    //   - the wire must equal what src DECLARES, which catches a daemon
    //     publishing a version its own code does not claim;
    //   - and the declared version must be at least 7, which is what keeps
    //     this check about THIS row shape — a rollback below the version that
    //     introduced `standing`/`claimsAt`/`claimsEvent` still goes red here.
    // Reconciling the version against the document and its digest is
    // verify-read-contract's job and is not duplicated.
    check(
      status.contractVersion === READ_CONTRACT_VERSION && READ_CONTRACT_VERSION >= 7,
      'the wire reports the read-contract version src declares, and it is at least the 7 this row shape belongs to',
      `wire=${status.contractVersion} declared=${READ_CONTRACT_VERSION}`
    );

    // AND IT IS NOT A TAUTOLOGY, DRIVEN RATHER THAN ARGUED. The obvious
    // objection to comparing the wire against the constant the wire is built
    // from is that it may assert nothing. It asserts that the ROUTER publishes
    // that constant, unmodified, on that field — so a daemon publishing a
    // literal, a stale copy, or nothing at all goes red here. This block is
    // what shows it: a second daemon, spawned from a build whose router
    // publishes a different number, and the same predicate evaluated against
    // its answer.
    versionRedDrive: {
      const mutantDist = mutate(
        'contract-version-on-the-wire',
        'router.js',
        'contractVersion: READ_CONTRACT_VERSION,',
        'contractVersion: 0,'
      );
      if (!mutantDist) break versionRedDrive;
      const mutantDir = path.join(tmp, 'wire-mutant');
      fs.mkdirSync(mutantDir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(dir, 'agents.jsonl'), path.join(mutantDir, 'agents.jsonl'));
      const mutantCfg = path.join(tmp, 'wire-mutant.config.json');
      fs.writeFileSync(mutantCfg, JSON.stringify({ dataDir: mutantDir }));
      const mutantSocket = path.join(mutantDir, 'crabcast.sock');
      const mutantChild = spawn(
        process.execPath,
        [path.join(mutantDist, 'daemon.js'), mutantCfg],
        { stdio: ['ignore', 'ignore', 'pipe'], env }
      );
      process.on('exit', () => { try { mutantChild.kill(); } catch {} });
      const mutantUp = await (async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const ok = await new Promise((resolve) => {
            const probe = net.connect(mutantSocket);
            probe.once('connect', () => { probe.end(); resolve(true); });
            probe.once('error', () => resolve(false));
          });
          if (ok) return true;
          await sleep(100);
        }
        return false;
      })();
      // PRECONDITION, for the reason §6's starves carry one: a mutant that
      // never came up produces an absence, and an absence is not a red.
      check(mutantUp, 'contract-version-on-the-wire: the mutated daemon came up and is answering');
      if (!mutantUp) break versionRedDrive;
      const mutantStatus = await new Promise((resolve, reject) => {
        const sock = net.connect(mutantSocket);
        let buf = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out')); }, 10000);
        sock.on('connect', () => sock.write(JSON.stringify({ action: 'daemon_status', id: 3 }) + '\n'));
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
      check(
        mutantStatus.success === true &&
          !(mutantStatus.contractVersion === READ_CONTRACT_VERSION && READ_CONTRACT_VERSION >= 7),
        'RED: the same predicate FAILS against a daemon whose router publishes a different version — so it is about the wire, not about itself',
        `mutant wire=${mutantStatus.contractVersion} declared=${READ_CONTRACT_VERSION}`
      );
      try { mutantChild.kill(); } catch {}
    }

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
// `src/agent-registry.ts` rather than `dist`, so its verdict is about the code
// in this tree — a stale or failed build can neither redden nor green it, which
// is the opposite of every section above and is why this script's exit code
// must not be read as a single kind of evidence. It is also the only section
// that CAN hold this property, because the property is an absence and an
// absence has no runtime behaviour to assert on.
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
//
// ---------------------------------------------------------------------------
// WHY THIS PARSES RATHER THAN GREPS, and it is a finding on this PR rather than
// a preference (review of #84).
//
// The first version of this section was a regex — `/\$\{(?:parsed|bad)\b…\}/g`
// — and its assertion read "interpolates no row value into any string" while
// its header claimed the property above: exactly one rendering. The reviewer
// starved the gap between those two sentences and it opened. A
// `console.error('[AgentRegistry] line ' + bad.line + ': ' + bad.identity)`
// inserted into the loop is a second rendering, writes a row to stderr, and
// contains no `${` at all — so the run stayed GREEN. **The guard erected to
// stop a false comment recurring could not see that comment coming true**: the
// sentence this whole ticket exists because of claimed those values were
// "written to stderr once, at boot", and stderr concatenation is the one shape
// the predicate did not cover.
//
// AND THE NEGATIVE CASE DID NOT REACH IT EITHER, which is the more instructive
// half. It re-inserted the render as a TEMPLATE — the one shape the predicate
// already matched — so it proved the predicate worked on its own vocabulary and
// said nothing about coverage. A negative case drawn from the predicate it is
// checking is the grep-that-has-only-found-nothing problem one level up. So
// {@link DOCTORED} below carries four shapes, three of which the old regex
// would have missed, and the section asserts that miss explicitly rather than
// leaving the reader to take the widening on trust.
//
// ---------------------------------------------------------------------------
// AND THE PREDICATE IS AN ALLOWLIST, NOT A LIST OF SINKS — which is the epic's
// own rule applied to its own review, and the second thing this section got
// wrong before it got right.
//
// KAN-59: "do not close a category by adding the reviewer's named examples.
// 'Your check misses A, B and C' is answered by closing the category, not by
// adding three tests." The review named concatenation. The obvious fix — and
// the one drafted first — was to enumerate the ways a row can become a string:
// template span, `+`, `String`, `JSON.stringify`, `console.*`, `.join()`. That
// is wider, and it is still a list of examples. **It has a residue and the
// residue is nameable**: `emit(bad)`, where `emit` is any helper that
// stringifies internally, walks through an enumeration of sinks exactly as
// `console.error('…' + bad.line)` walked through the regex. Writing that
// residue down honestly would have satisfied the reviewer and left the same
// defect one step further out.
//
// SO THE QUESTION IS INVERTED. Rather than asking "is this one of the ways a
// row becomes a string?", which can never be complete, it asks "is this one of
// the handful of things `classifyLog` is allowed to do with a row?", which is
// small, closed and legible: SEVEN calls, in `ALLOWED_CALLEES` below, and a
// short list of read-only positions beside it — a comparison, a `typeof`, a
// negation, a condition, an assignment target, and a spread into one of those
// seven calls. Both lists are literals a reader can count, and the run reports
// how many row references it checked them against rather than leaving that to
// a number in a comment. Any other use of `parsed`, `bad` or `trimmed` is a failure,
// including one through a helper that does not exist yet. A future author who
// needs a new one adds it to `ALLOWED_CALLEES` deliberately, in a diff, where
// it is reviewable — instead of the guard silently not applying.
//
// A TEXT PREDICATE CANNOT EXPRESS EITHER FORMULATION, which is why this parses
// with the compiler that already builds this repository. `typescript` is a
// devDependency, `npm ci` installs it, and this is the first proof here to use
// it; the alternative was a wider regex, which is how the first version got
// this wrong in the first place.
//
// ---------------------------------------------------------------------------
// WHAT IS STILL NOT COVERED — stated at its NEAREST point, which is the lesson
// both rounds of this review taught rather than a formality.
//
// A residue paragraph is worth nothing if it points further away than the real
// edge. This one has been wrong that way twice. v1's said the property was
// "exactly one rendering" while the mechanism saw `${…}`; v2's named "a helper
// that stringifies internally", a whole-program problem, when the actual
// nearest evasion was `const who = bad.identity` — two lines, no indirection,
// inside the function the section reads. **Both times the paragraph made the
// edge sound more exotic than it was, which is worse than saying nothing**,
// because a reader takes the near cases as covered. So, precisely:
//
//   * THIS PARAGRAPH WAS WRONG A THIRD TIME AND THE THIRD IS THE SHARPEST. It
//     named "one call out" as the nearest edge while `console.error('row: ' +
//     lines[i])` — no call, no indirection, an INDEX — rendered a whole raw row
//     and passed, because the reassurance about `lines` was sitting next to
//     `ROW_ROOTS` rather than here. `lines` is now a root with its two
//     structural uses named. Read the pattern rather than the three instances:
//     every time this paragraph has been wrong it pointed FURTHER OUT than the
//     truth, and twice the real edge was in a comment that read as coverage.
//   * THE NEAREST UNCOVERED CASE IS ONE CALL OUT. A row handed to an
//     `ALLOWED_CALLEES` entry is trusted, and this section reads ONE function,
//     so if `classifyRow`, `toActivatedBy`, `toChannelEnabled` or the `push`
//     rendered a row, nothing here would see it. `classifyRow` is the live one:
//     it takes the whole `parsed` row and the raw line. Its own output IS the
//     record, so it is the sanctioned reader — but "sanctioned" is a fact about
//     today's body, not a guarantee, and no assertion holds it.
//   * ADDING TO `ALLOWED_CALLEES` DEFEATS THIS ENTIRELY, by design. The
//     protection is that doing so is an edit to this file, in a diff, next to
//     this paragraph — not that it is impossible.
//   * ONLY `classifyLog` IS READ. That is the whole scope where a raw `parsed`
//     row is reachable, which is why it is the whole scope that needs reading;
//     it is not a claim about the rest of the file.
//
// What is NOT in this list, because it is now closed: aliasing to a local, and
// aliasing through an object spread. Both are refused at the binding rather
// than chased through it, which is why this is an allowlist and not a dataflow
// analysis — the reviewer asked for the residue named and would have rejected
// the clever version, and taking a permission away was cheaper than either.
{
  const registrySrc = fs.readFileSync(path.join(repoRoot, 'src', 'agent-registry.ts'), 'utf8');

  /** The identifiers inside `classifyLog` that hold a row, or part of one. */
  const ROW_ROOTS = new Set(['parsed', 'bad', 'trimmed', 'lines']);
  // `lines` IS one, and the reasoning that kept it out was the same mistake
  // this section keeps making one level down (review of #84, third finding).
  // The old comment said `lines` was excluded because the loop indexes and
  // measures it structurally — TRUE — and then that "`trimmed` is
  // `lines[i].trim()`, so the raw bytes are covered one step later". THAT HALF
  // WAS A CLAIM ABOUT THE FUTURE. `trimmed` covers the bytes only for a render
  // that reaches them THROUGH `trimmed`; `console.error('row: ' + lines[i])`
  // never becomes a use of `trimmed` and was never seen. It renders a whole raw
  // row to stderr, and it passed. The sentence was true of today's body, which
  // is the one thing this section exists not to rely on.
  //
  // The false-positive problem it was avoiding is real and the inversion solves
  // it the same way it solved aliasing: name the TWO structural uses rather
  // than the unbounded set of bad ones. See LINES_SHAPES.

  /**
   * The ONLY calls `classifyLog` may hand a row to. Every one is a call that
   * consumes the row structurally rather than rendering it: the parser that
   * creates it, the type guard, the classifier, the two field normalizers, and
   * the push onto the disclosure. `console.*`, `String`, `JSON.stringify` and
   * every helper nobody has written yet are absent, and absent is the default.
   */
  const ALLOWED_CALLEES = new Set([
    'JSON.parse', 'Array.isArray', 'classifyRow', 'toActivatedBy', 'toChannelEnabled',
    'scan.unreadable.push', 'entries?.push'
  ]);

  /**
   * Every use of a row value inside a named function that is NOT on the
   * allowlist.
   *
   * Pure, and it takes the source as an argument, so the negative cases below
   * run the IDENTICAL predicate over doctored copies — the §1b arrangement, and
   * the only thing that stops an assertion about an absence passing because its
   * anchor drifted rather than because the absence holds.
   *
   * @returns {{hits: Array<{why: string, code: string}>, body: string}|null}
   */
  function rowRenderingsIn(text, fnName) {
    const sf = ts.createSourceFile(`${fnName}.ts`, text, ts.ScriptTarget.ES2022, true);
    let fn = null;
    const findFn = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) fn = n;
      else if (!fn) ts.forEachChild(n, findFn);
    };
    ts.forEachChild(sf, findFn);
    if (!fn?.body) return null;

    const K = ts.SyntaxKind;
    /** `===`, `!==`, `==`, `!=`, `&&`, `||`, `??`, `instanceof`, `in` — reading a row, never rendering it. */
    const TEST_OPERATORS = new Set([
      K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken,
      K.ExclamationEqualsToken, K.AmpersandAmpersandToken, K.BarBarToken,
      K.QuestionQuestionToken, K.InstanceOfKeyword, K.InKeyword
    ]);

    const hits = [];
    // COUNTED, because "no use is off the allowlist" is trivially true of a
    // body the walker never reached — a renamed identifier, a refactor that
    // moved the loop, or a parse that found the wrong function. The number goes
    // in the verdict rather than in a comment, so it cannot drift.
    let refs = 0;
    const flag = (node, why) =>
      hits.push({ why, code: node.getText().replace(/\s+/g, ' ').slice(0, 60) });

    /** Climb `parsed` up through `.a.b`, `(x as T)`, `x!`, `(x)` to the whole row expression. */
    const outermost = (id) => {
      let node = id;
      while (
        node.parent &&
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent) ||
         ts.isNonNullExpression(node.parent) || ts.isParenthesizedExpression(node.parent) ||
         ts.isAsExpression(node.parent)) &&
        node.parent.expression === node
      ) node = node.parent;
      return node;
    };

    const walk = (n) => {
      if (ts.isIdentifier(n) && ROW_ROOTS.has(n.text)) {
        const p0 = n.parent;
        // A declaration's NAME, or a property that merely shares the spelling
        // (`x.parsed`, `{ parsed: … }`), is not a reference to a row.
        const isDeclName =
          (ts.isVariableDeclaration(p0) && p0.name === n) ||
          (ts.isParameter(p0) && p0.name === n) ||
          (ts.isPropertyAccessExpression(p0) && p0.name === n) ||
          (ts.isPropertyAssignment(p0) && p0.name === n);
        if (!isDeclName) {
          refs += 1;
          const node = outermost(n);
          const p = node.parent;
          const calleeOf = (c) => c.expression.getText().replace(/\s+/g, '');
          if (n.text === 'lines') {
            // LINES_SHAPES — the only two things the loop does with the array.
            // `lines.length` is a COUNT and carries no row bytes at all;
            // `lines[i].trim()` is the single sanctioned way a row's bytes
            // leave it, and what they become is `trimmed`, which the allowlist
            // above then governs. A bare `lines[i]` anywhere else is a raw row
            // in the open and fails.
            const okLines =
              (ts.isPropertyAccessExpression(node) && node.name.text === 'length') ||
              (ts.isPropertyAccessExpression(node) && node.name.text === 'trim' &&
                ts.isElementAccessExpression(node.expression) &&
                ts.isCallExpression(node.parent) && node.parent.expression === node);
            if (!okLines) {
              flag(node, '`lines` may only be `lines.length` or `lines[i].trim()` — a raw row in the open');
            }
            ts.forEachChild(n, walk);
            return;
          }
          // NOTE WHAT IS ABSENT: `const who = bad.identity` — a row value bound
          // to a local. Nothing in `classifyLog` needs it (`const bad = …` and
          // `let parsed` are declaration NAMES, skipped above, and the two rows
          // it reads go straight into a call or a comparison), so the
          // permission is not granted, and the cheapest evasion of a sink list
          // — alias first, render the alias — is refused at the binding instead
          // of chased through it. That is the review's residue closed by
          // TAKING A PERMISSION AWAY rather than by adding dataflow analysis,
          // which is the thing the reviewer said they would reject and which
          // this deliberately is not.
          const allowed =
            // `parsed = JSON.parse(trimmed)`
            (ts.isBinaryExpression(p) && p.operatorToken.kind === K.EqualsToken && p.left === node) ||
            // `bad.problem === 'from-newer'`, `!parsed || …`
            (ts.isBinaryExpression(p) && TEST_OPERATORS.has(p.operatorToken.kind)) ||
            (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken) ||
            ts.isTypeOfExpression(p) ||
            // `if (bad)`, `bad ? … : …`
            (ts.isIfStatement(p) && p.expression === node) ||
            (ts.isConditionalExpression(p) && p.condition === node) ||
            (ts.isWhileStatement(p) && p.expression === node) ||
            // `entries?.push({ ...(parsed as AgentLogEntry) })` — a spread, and
            // ONLY into an object literal that is itself an argument to an
            // allowed call. `const copy = { ...bad }` is the same evasion as the
            // alias wearing a spread, so the object it spreads into has to be
            // going somewhere sanctioned.
            (ts.isSpreadAssignment(p) &&
              ts.isObjectLiteralExpression(p.parent) &&
              ts.isCallExpression(p.parent.parent ?? {}) &&
              p.parent.parent.arguments.includes(p.parent) &&
              ALLOWED_CALLEES.has(calleeOf(p.parent.parent))) ||
            // an argument to one of the calls named above, and only those
            (ts.isCallExpression(p) && p.arguments.includes(node) && ALLOWED_CALLEES.has(calleeOf(p)));
          if (!allowed) {
            const why = ts.isCallExpression(p) && p.arguments.includes(node)
              ? `passed to ${calleeOf(p)}(), which is not on the allowlist`
              : ts.isVariableDeclaration(p)
                ? 'bound to a local — aliasing a row is not on the allowlist'
                : `${ts.SyntaxKind[p.kind]} — not one of the uses \`classifyLog\` is allowed`;
            flag(node, why);
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(fn.body);
    return { hits, refs, body: fn.body.getText() };
  }

  // THE TWO PREDICATES THIS SECTION USED TO BE, kept executable rather than
  // described, so that every negative case below reports which designs it
  // defeats. A claim that a rewrite widened coverage is exactly the kind of
  // sentence this epic keeps finding unsupported; these two make it measured.

  /** v1: a regex over `${…}`. Review of #84 walked a concatenation through it. */
  const V1_REGEX = (body) => [...body.matchAll(/\$\{(?:parsed|bad)\b[^}]*\}/g)].map((m) => m[0]);

  /** v2: an enumeration of string sinks. The alias case walked through THIS one. */
  const V2_SINKS = (body) => {
    const sf = ts.createSourceFile('v2.ts', `function f(){${body}}`, ts.ScriptTarget.ES2022, true);
    const STRINGIFIERS = new Set(['String', 'JSON.stringify']);
    const EMITTERS = new Set([
      'console.log', 'console.error', 'console.warn', 'console.info', 'console.debug',
      'process.stderr.write', 'process.stdout.write'
    ]);
    const STRING_METHODS = new Set(['toString', 'join', 'concat', 'padStart', 'padEnd', 'repeat']);
    const rootOf = (n) => {
      let c = n;
      while (
        ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) ||
        ts.isNonNullExpression(c) || ts.isParenthesizedExpression(c) || ts.isAsExpression(c)
      ) c = c.expression;
      return ts.isIdentifier(c) ? c.text : null;
    };
    // v2 never rooted `lines` — that is the whole of the third finding, so the
    // replay must not silently acquire it.
    const V2_ROOTS = new Set(['parsed', 'bad', 'trimmed']);
    const isRow = (n) => V2_ROOTS.has(rootOf(n) ?? '');
    const out = [];
    const walk = (n) => {
      if (ts.isTemplateSpan(n) && isRow(n.expression)) out.push(n.expression.getText());
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        if (isRow(n.left)) out.push(n.left.getText());
        if (isRow(n.right)) out.push(n.right.getText());
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText().replace(/\s+/g, '');
        if (STRINGIFIERS.has(callee) || EMITTERS.has(callee)) {
          for (const a of n.arguments) if (isRow(a)) out.push(a.getText());
        }
        if (
          ts.isPropertyAccessExpression(n.expression) &&
          STRING_METHODS.has(n.expression.name.text) && isRow(n.expression.expression)
        ) out.push(n.expression.expression.getText());
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return out;
  };

  const found = rowRenderingsIn(registrySrc, 'classifyLog');
  check(
    Boolean(found) && found.body.includes('scan.unreadable.push(bad)'),
    "5b: the parsed body really is `classifyLog`'s — a renamed function would otherwise make the check below pass over nothing",
    found ? `${found.body.length} chars` : 'no `function classifyLog` in src/agent-registry.ts'
  );
  check(
    Boolean(found) && found.refs > 0,
    '5b: vacuity — the walker actually reached row references inside `classifyLog`, so the allowlist below is checked against something',
    found ? `${found.refs} reference(s) to \`parsed\`/\`bad\`/\`trimmed\`/\`lines\`` : 'body not found'
  );
  check(
    Boolean(found) && found.hits.length === 0,
    '5b: every use of `parsed`, `bad`, `trimmed` and `lines` in `classifyLog` is on the allowlist — parse, guard, classify, normalize, spread into a sanctioned push, and `lines` only as `lines.length` or `lines[i].trim()`. Anything else, INCLUDING BINDING A ROW TO A LOCAL OR READING A RAW LINE OUT OF THE ARRAY, is a failure, so the notice stays the only rendering',
    found ? found.hits.map((h) => `${h.why}: ${h.code}`).join(' ; ') || `${found.refs} row reference(s) examined, none off-allowlist` : 'body not found'
  );

  // THE NEGATIVE CASES, and the point of the last two columns is that each one
  // names WHICH DESIGN IT DEFEATS. `concatenation` is verbatim the mutation the
  // reviewer of #84 used to walk through v1; `alias` is verbatim the one they
  // used to walk through v2, at the head where v2 had just been declared a fix.
  const DOCTORED = [
    {
      name: 'template',
      code: "    scan.notes.push(`line ${bad.line}: ${parsed.event ?? 'no event'}`);\n",
      v1Sees: true, v2Sees: true
    },
    {
      name: 'concatenation',
      code: "    console.error('[AgentRegistry] line ' + bad.line + ': ' + bad.identity + ' — ' + parsed.event);\n",
      v1Sees: false, v2Sees: true
    },
    {
      name: 'stringify-sink',
      code: '    console.error(JSON.stringify(parsed));\n',
      v1Sees: false, v2Sees: true
    },
    {
      name: 'bare-emit',
      code: '    console.error(bad.identity);\n',
      v1Sees: false, v2Sees: true
    },
    {
      // THE REVIEWER'S SECOND MUTATION, verbatim. Two lines, no helper, no
      // indirection — by the time a sink sees them the values are `who` and
      // `when`, and nothing rooted at a row reaches a `+` or an emitter.
      name: 'alias',
      code:
        '    const who = bad.identity;\n' +
        '    const when = parsed.at;\n' +
        "    console.error('[AgentRegistry] ' + who + ' at ' + when);\n",
      v1Sees: false, v2Sees: false
    },
    {
      // THE REVIEWER'S THIRD MUTATION, verbatim. No call, no indirection, no
      // alias — an INDEX. It reaches the row's raw bytes without ever touching
      // `parsed`, `bad` or `trimmed`, which is why `lines` had to become a root
      // with its two structural uses named rather than stay excluded.
      name: 'raw-line',
      code: "    console.error('[AgentRegistry] offending row: ' + lines[i]);\n",
      v1Sees: false, v2Sees: false
    },
    {
      // The same evasion wearing a spread, which is the one shape the allowlist
      // has to permit for `entries?.push`. Permitted only INTO a sanctioned
      // call, so this is refused where the real one is not.
      name: 'spread-alias',
      code:
        '    const copy = { ...bad };\n' +
        "    console.error('[AgentRegistry] ' + copy.identity);\n",
      v1Sees: false, v2Sees: false
    }
  ];

  const ANCHOR = '    scan.unreadable.push(bad);\n';
  for (const d of DOCTORED) {
    const doctored = registrySrc.replace(ANCHOR, ANCHOR + d.code);
    check(
      doctored !== registrySrc,
      `5b/${d.name}: the doctored source differs from the real one, so this case tests a re-inserted render rather than a copy`
    );
    const after = rowRenderingsIn(doctored, 'classifyLog');
    check(
      Boolean(after) && after.hits.length > 0,
      `5b/${d.name}: and the check goes RED when this shape of second rendering is put back inside the loop`,
      after
        ? after.hits.map((h) => `${h.why}: ${h.code}`).join(' ; ') ||
          'it stayed GREEN, so §5b would not notice this rendering'
        : 'body not found'
    );
    // What makes these six cases evidence about COVERAGE rather than six
    // restatements of one predicate: what the two earlier designs would have
    // said about each. Two of the six defeat BOTH of them.
    const v1 = after ? V1_REGEX(after.body) : [];
    const v2 = after ? V2_SINKS(after.body) : [];
    check(
      (v1.length > 0) === d.v1Sees && (v2.length > 0) === d.v2Sees,
      `5b/${d.name}: and the two designs this replaced — the \`\${…}\` regex, then the sink enumeration — ${d.v1Sees ? 'saw' : 'did NOT see'} / ${d.v2Sees ? 'saw' : 'did NOT see'} it`,
      `v1 ${v1.length} hit(s), v2 ${v2.length} hit(s)`
    );
  }
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
