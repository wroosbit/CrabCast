#!/usr/bin/env node
// Live proof for KAN-329: `send_to_agent`'s verdict is a PUBLISHED contract —
// `docs/send-contract.md`, `src/send-contract.ts`, and a real daemon's
// `send_to_agent_response`, reconciled pairwise in both directions.
//
// WHAT FAILURE THIS WOULD CATCH: a member added to the verdict vocabulary — or
// a field added to the response — with nothing saying so, on the field Butchr
// branches on more than anything else CrabCast emits. Before this ticket the
// vocabulary was a TypeScript union in `src/delivery.ts` with careful prose
// around it and no published member list: `grep -rn unverifiable docs/` found
// it in exactly one place, the read-path contract's §10, saying it was
// published nowhere. A fifth verdict could be added and NOTHING went red — not
// a document, not a value set, not a proof. A consumer holding a three-way
// switch would have met the fourth value as a default case, which is not
// hypothetical: the ticket that commissioned this file was written expecting
// three.
//
// It would also catch the narrower thing that makes this surface worth its own
// proof: `unverifiable` is answered by TWO branches with different shapes, one
// carrying a full evidence block and one carrying none. A consumer reading
// `evidence.readError` off every `unverifiable` meets `undefined` on one of
// them. §2 asserts the exact key set of every branch against a real daemon, so
// that asymmetry cannot quietly become three branches or quietly be repaired.
//
// ---------------------------------------------------------------------------
// THE THREE ARTIFACTS, AND WHY IT TAKES THREE
//
//   docs/send-contract.md      what a consumer reads
//   src/send-contract.ts       the same tables as data
//   a REAL daemon's responses  what actually goes on the wire
//
// Checking any two leaves the third free to be wrong, and the pairs fail
// differently: document against declaration is two files agreeing with each
// other about a daemon neither has spoken to; declaration against the wire is a
// machine-readable contract nobody can read.
//
// ---------------------------------------------------------------------------
// SECTIONS
//
//   1. document ↔ declaration — every table names a declaration that exists and
//      every declaration has exactly one table; the field sets are equal in
//      both directions; the buckets and optionality agree; the three
//      vocabularies agree member for member; the five branches agree key for
//      key; every branch's documented verdict is a member of the response
//      vocabulary. A PURE FUNCTION of (declaration, document text), which is
//      what lets §7 hand it mutated inputs and watch the same code go red.
//
//   2. declaration ↔ a REAL daemon — four of the five branches PRODUCED on a
//      real daemon over a real unix socket, and their EXACT key sets asserted.
//      A key on the wire that nothing declares is red; a declared field missing
//      from a branch that should carry it is red.
//
//   3. the fifth branch, which a healthy daemon cannot be asked for. The bridge
//      is documented never to throw, so `unconfirmable` needs one that does:
//      the compiled build is mutated to reject, a real daemon is started from
//      it, and the branch is read off a real socket. Named as manufactured
//      rather than counted as if it fell out of ordinary use.
//
//   4. the version and its digest — the document's table has a row for the
//      declared version whose digest matches `sendContractCanonical()`.
//
//   5. the handler carries no bare verdict literal. The two off-outcome
//      branches are built through typed constructors in `src/delivery.ts`
//      precisely so the compiler sees them; this is the check that notices a
//      third one appearing inline, which the compiler cannot, because `Respond`
//      is `(msg: any) => void`.
//
//   6. THE COMPILE-TIME HALF, WATCHED REFUSING. `Exact<>` bindings make an
//      undocumented member unrepresentable rather than merely detectable — and
//      a binding nobody has watched refuse anything is a binding nobody has
//      shown to be load-bearing. A copy of `src/` gets a fifth verdict added to
//      the union ALONE, `tsc` is run over it, and the failure is required to
//      name `src/send-contract.ts`.
//
//   7. THE RED HALF — five mutations of §1's inputs, each watched going red BY
//      NAME: a member added to the declaration without a document row; a member
//      deleted from a document table; a field deleted from a document table; a
//      branch's key set altered in the document; and the declared version
//      bumped without a row. Both DIRECTIONS are covered — added and removed —
//      which is the question the ticket asks explicitly.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// A proof that supplies its own input has not tested that the input arrives, so
// here is the line in this one.
//
// THE PANE IS SUPPLIED. `herdr` is a shim written by this file, and the pane it
// models — a transcript, a `❯` caret, a composer after it — is this file's
// idea of what Claude Code draws. The fixture decides WHICH branch happens: it
// drops an Enter to produce `not-delivered`, stops answering reads to produce
// `unverifiable`, sends a blank message to produce `refused`.
//
// WHAT IT DOES NOT SUPPLY IS ANYTHING IT ASSERTS ON. The key sets come from a
// real daemon computing a real response and writing it down a real socket; the
// verdicts are decided by the real `HerdrBridge` and the real `MessageRouter`.
// No assertion here reads a value this script wrote.
//
// NOT COVERED HERE — that a REAL Claude Code pane looks like what this shim
// draws. Every verdict on this page is produced against a marker this file
// rendered. WHO COVERS IT — `verify-send-confirms-delivery-live.mjs`, against a
// real herdr and a real agent, in the live half of this suite. A green run of
// THIS file is not evidence about a real composer, and neither is a green run
// of `verify-send-confirms-delivery.mjs`, which shares the same shim.
//
// AND NOT COVERED BY ANYTHING: whether `docs/send-contract.md` and
// `docs/read-path-contract.md` agree about where each other stop. §10 of the
// read path declares `send_to_agent` as contracted here, and
// `verify-read-contract.mjs` checks that this document and this script EXIST —
// but no check reads one contract's boundary against the other's. Two documents
// each honest about what they cover can still leave a hole between them, and
// that is where the edge of this one is.
//
// Usage:
//   npm run build
//   node scripts/verify-send-contract.mjs [distDir]

import { execFileSync, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));
const CONTRACT_DOC = path.join(repoRoot, 'docs', 'send-contract.md');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}

function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/**
 * A reconciliation reported as ONE verdict naming everything it found.
 *
 * The problems array is what the mutations in §7 read: a mutation is required
 * not merely to make this red but to make it red WITH A PARTICULAR SENTENCE in
 * it, so a mutation that goes red for an unrelated reason is not credited.
 */
function reportProblems(label, problems) {
  check(problems.length === 0, label, problems.join('\n'));
  return problems;
}

// ===========================================================================
// The document, parsed as a pure function of its text
// ===========================================================================
//
// PURE, so §7 can hand it a MUTATED document and watch the same parser and the
// same reconciler go red. A checker that can only be run against the real file
// cannot be shown to fail — which is the defect this whole suite is about, one
// level in.

const BUCKETS = ['durable', 'observed', 'derived', 'remembered'];

/** Strip markdown emphasis and code ticks from a cell. */
const plain = (cell) => cell.replace(/[`*_]/g, '').trim();

/** The rows of the first markdown table after `at`, as arrays of raw cells. */
function tableAfter(text, at) {
  const lines = text.slice(at).split('\n');
  const rows = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    rows.push(trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|'));
  }
  // Drop the header row and the `---` separator.
  return rows.slice(2);
}

/** Every `<!-- send-table: NAME -->` as `NAME -> { field -> {bucket, optional} }`. */
function parseTables(text) {
  const tables = new Map();
  const re = /<!--\s*send-table:\s*([A-Za-z0-9_]+)\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fields = {};
    for (const cells of tableAfter(text, m.index + m[0].length)) {
      const field = plain(cells[0] ?? '');
      if (!field) continue;
      const parts = plain(cells[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      fields[field] = { bucket: parts[0] ?? '', optional: parts.includes('optional') };
    }
    // A duplicated marker is caught rather than silently overwriting: two
    // tables for one declaration means one of them is unread by anybody.
    if (tables.has(m[1])) tables.set(m[1], null);
    else tables.set(m[1], fields);
  }
  return tables;
}

/** Every `<!-- send-values: NAME -->` — the first column of the table under it. */
function parseValueSets(text) {
  const sets = {};
  const re = /<!--\s*send-values:\s*([A-Za-z0-9_]+)\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    sets[m[1]] = tableAfter(text, m.index + m[0].length)
      .map((cells) => plain(cells[0] ?? ''))
      .filter(Boolean);
  }
  return sets;
}

/**
 * `<!-- send-branches: NAME -->` — branch, its verdict, and its exact key list.
 *
 * Three columns rather than two, because the join between a branch and the
 * verdict it answers with is the thing this surface is most likely to be
 * misread on: two branches answer `unverifiable`, and a table that did not
 * carry the verdict could not say so.
 */
function parseBranches(text) {
  const m = /<!--\s*send-branches:\s*([A-Za-z0-9_]+)\s*-->/.exec(text);
  if (!m) return null;
  const branches = {};
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const name = plain(cells[0] ?? '');
    if (!name) continue;
    branches[name] = {
      verdict: plain(cells[1] ?? ''),
      keys: [...(cells[2] ?? '').matchAll(/`([A-Za-z0-9_]+)`/g)].map((k) => k[1])
    };
  }
  return branches;
}

/** `<!-- send-versions -->` — version number to the digest recorded for it. */
function parseVersions(text) {
  const m = /<!--\s*send-versions\s*-->/.exec(text);
  if (!m) return null;
  const rows = [];
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const version = Number(plain(cells[0] ?? ''));
    if (!Number.isInteger(version)) continue;
    rows.push({ version, digest: plain(cells[3] ?? '') });
  }
  return rows;
}

// ===========================================================================
// The reconcilers, as pure functions of (declaration, document)
// ===========================================================================

const setsEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * §1's whole comparison, so §7 can run it against doctored inputs.
 *
 * @returns {string[]} every disagreement found, named individually. An empty
 *   array is the pass; the array is what a mutation is required to appear in.
 */
function reconcileDocument(mod, docText) {
  const problems = [];

  // --- the field tables, in both directions -------------------------------
  const DOC_TABLES = {
    SEND_RESPONSE_FIELDS: mod.SEND_RESPONSE_FIELDS,
    SEND_EVIDENCE_FIELDS: mod.SEND_EVIDENCE_FIELDS
  };
  const parsed = parseTables(docText);
  for (const [name, declared] of Object.entries(DOC_TABLES)) {
    const documented = parsed.get(name);
    if (documented === undefined) {
      problems.push(`table ${name}: declared, and no <!-- send-table: ${name} --> in the document`);
      continue;
    }
    if (documented === null) {
      problems.push(`table ${name}: the document has more than one table for it`);
      continue;
    }
    for (const [field, spec] of Object.entries(declared)) {
      const row = documented[field];
      if (!row) {
        problems.push(`${name}.${field}: declared, absent from the document`);
        continue;
      }
      if (row.bucket !== spec.bucket) {
        problems.push(
          `${name}.${field}: document says bucket '${row.bucket}', declaration says '${spec.bucket}'`
        );
      }
      if (row.optional !== Boolean(spec.optional)) {
        problems.push(
          `${name}.${field}: document says ${row.optional ? 'optional' : 'always'}, ` +
            `declaration says ${spec.optional ? 'optional' : 'always'}`
        );
      }
    }
    for (const field of Object.keys(documented)) {
      if (!(field in declared)) {
        problems.push(`${name}.${field}: in the document, declared nowhere`);
      }
    }
  }
  for (const name of parsed.keys()) {
    if (!(name in DOC_TABLES)) {
      problems.push(`table ${name}: the document has a table for a declaration that does not exist`);
    }
  }

  // --- every bucket is one of the four ------------------------------------
  //
  // Cheap, and it catches the typo that would otherwise make a bucket
  // disagreement look like agreement on both sides at once.
  for (const [name, declared] of Object.entries(DOC_TABLES)) {
    for (const [field, spec] of Object.entries(declared)) {
      if (!BUCKETS.includes(spec.bucket)) {
        problems.push(`${name}.${field}: bucket '${spec.bucket}' is not one of the four`);
      }
    }
  }

  // --- every `block` reference resolves -----------------------------------
  for (const [name, declared] of Object.entries(DOC_TABLES)) {
    for (const [field, spec] of Object.entries(declared)) {
      if (spec.block && !(spec.block in mod.SEND_BLOCK_SHAPES)) {
        problems.push(`${name}.${field}: names block '${spec.block}', which is not a shape`);
      }
    }
  }

  // --- the three vocabularies, member for member --------------------------
  const docValues = parseValueSets(docText);
  for (const [name, values] of Object.entries(mod.SEND_VALUE_SETS)) {
    const documented = docValues[name];
    if (!documented) {
      problems.push(`values ${name}: declared, absent from the document`);
      continue;
    }
    for (const v of values) {
      if (!documented.includes(v)) {
        problems.push(`values ${name}: '${v}' is declared and not in the document's table`);
      }
    }
    for (const v of documented) {
      if (!values.includes(v)) {
        problems.push(`values ${name}: the document lists '${v}', which is not declared`);
      }
    }
  }
  for (const name of Object.keys(docValues)) {
    if (!(name in mod.SEND_VALUE_SETS)) {
      problems.push(`values ${name}: in the document, declared nowhere`);
    }
  }

  // --- the branches, key for key ------------------------------------------
  const docBranches = parseBranches(docText);
  if (!docBranches) {
    problems.push('document: no <!-- send-branches: … --> table');
  } else {
    for (const [branch, keys] of Object.entries(mod.SEND_RESPONSE_BRANCHES)) {
      const row = docBranches[branch];
      if (!row) {
        problems.push(`branch ${branch}: declared, absent from the document`);
        continue;
      }
      if (!setsEqual([...keys].sort(), [...row.keys].sort())) {
        problems.push(
          `branch ${branch}: document says [${[...row.keys].sort().join(' ')}], ` +
            `declaration says [${[...keys].sort().join(' ')}]`
        );
      }
      const declaredVerdict = mod.SEND_BRANCH_VERDICTS[branch];
      if (row.verdict !== declaredVerdict) {
        problems.push(
          `branch ${branch}: document says it answers '${row.verdict}', ` +
            `declaration says '${declaredVerdict}'`
        );
      }
    }
    for (const branch of Object.keys(docBranches)) {
      if (!(branch in mod.SEND_RESPONSE_BRANCHES)) {
        problems.push(`branch ${branch}: in the document, declared nowhere`);
      }
    }
  }

  // --- the joins between the declarations themselves ----------------------
  //
  // These need no document at all, and they are the checks that stop the
  // declaration being internally incoherent in a way both tables would then
  // agree about.
  for (const [branch, verdict] of Object.entries(mod.SEND_BRANCH_VERDICTS)) {
    if (!mod.SEND_VALUE_SETS.sendResponseVerdict.includes(verdict)) {
      problems.push(`branch ${branch}: answers '${verdict}', which is not a response verdict`);
    }
    if (!(branch in mod.SEND_RESPONSE_BRANCHES)) {
      problems.push(`branch ${branch}: has a verdict and no key set`);
    }
  }
  for (const [branch, keys] of Object.entries(mod.SEND_RESPONSE_BRANCHES)) {
    if (!(branch in mod.SEND_BRANCH_VERDICTS)) {
      problems.push(`branch ${branch}: has a key set and no verdict`);
    }
    for (const k of keys) {
      if (!(k in mod.SEND_RESPONSE_FIELDS)) {
        problems.push(`branch ${branch}: carries '${k}', which is not a declared field`);
      }
    }
  }
  // A field on NO branch is declared for nothing, and cannot be caught on the
  // wire: no response carries it, so every key check passes.
  const onSomeBranch = new Set(Object.values(mod.SEND_RESPONSE_BRANCHES).flat());
  for (const field of Object.keys(mod.SEND_RESPONSE_FIELDS)) {
    if (!onSomeBranch.has(field)) {
      problems.push(`field ${field}: declared, and on no branch`);
    }
  }
  // A non-optional field must be on EVERY branch, or `optional` means nothing.
  for (const [field, spec] of Object.entries(mod.SEND_RESPONSE_FIELDS)) {
    if (spec.optional) continue;
    for (const [branch, keys] of Object.entries(mod.SEND_RESPONSE_BRANCHES)) {
      if (!keys.includes(field)) {
        problems.push(`field ${field}: declared as always present, and not on branch ${branch}`);
      }
    }
  }

  return problems;
}

/**
 * §2's comparison: what a real daemon answered, against the declaration.
 *
 * Separated from the transport for the same reason §1 is separated from the
 * file: §7 hands it the SAME captured responses with a doctored declaration,
 * and the failure it produces is about the declaration rather than about a
 * daemon somebody had to start again.
 */
function reconcileWire(mod, samples) {
  const problems = [];
  for (const [branch, body] of Object.entries(samples)) {
    if (!body) {
      problems.push(`branch ${branch}: no response was captured`);
      continue;
    }
    const declared = mod.SEND_RESPONSE_BRANCHES[branch];
    if (!declared) {
      problems.push(`branch ${branch}: a response was produced for a branch nothing declares`);
      continue;
    }
    const onWire = Object.keys(body).filter((k) => k !== 'id').sort();
    const expected = [...declared].sort();
    if (!setsEqual(onWire, expected)) {
      const extra = onWire.filter((k) => !expected.includes(k));
      const missing = expected.filter((k) => !onWire.includes(k));
      problems.push(
        `branch ${branch}: wire carries [${onWire.join(' ')}], declaration says ` +
          `[${expected.join(' ')}]` +
          (extra.length ? `; undeclared on the wire: ${extra.join(' ')}` : '') +
          (missing.length ? `; declared and missing: ${missing.join(' ')}` : '')
      );
    }
    const expectedVerdict = mod.SEND_BRANCH_VERDICTS[branch];
    if (body.verdict !== expectedVerdict) {
      problems.push(
        `branch ${branch}: wire says verdict '${body.verdict}', declaration says '${expectedVerdict}'`
      );
    }
    if (!mod.SEND_VALUE_SETS.sendResponseVerdict.includes(body.verdict)) {
      problems.push(`branch ${branch}: wire verdict '${body.verdict}' is not in the vocabulary`);
    }
    if (body.refused !== undefined && !mod.SEND_VALUE_SETS.sendRefused.includes(body.refused)) {
      problems.push(`branch ${branch}: wire refused '${body.refused}' is not in the vocabulary`);
    }
    // The evidence block, where the branch carries one.
    if (body.evidence !== undefined) {
      const evOnWire = Object.keys(body.evidence).sort();
      for (const k of evOnWire) {
        if (!(k in mod.SEND_EVIDENCE_FIELDS)) {
          problems.push(`branch ${branch}: evidence carries undeclared field '${k}'`);
        }
      }
      for (const [k, spec] of Object.entries(mod.SEND_EVIDENCE_FIELDS)) {
        if (!spec.optional && !evOnWire.includes(k)) {
          problems.push(`branch ${branch}: evidence is missing declared field '${k}'`);
        }
      }
    }
    // The invariant the document states as `error` being absent iff delivered.
    const shouldHaveError = body.verdict !== 'delivered';
    if (shouldHaveError !== (body.error !== undefined)) {
      problems.push(
        `branch ${branch}: verdict '${body.verdict}' with error ` +
          `${body.error === undefined ? 'absent' : 'present'} — the document says error is ` +
          `absent if and only if the verdict is delivered`
      );
    }
  }
  for (const branch of Object.keys(mod.SEND_RESPONSE_BRANCHES)) {
    if (!(branch in samples)) {
      problems.push(`branch ${branch}: declared, and no response was produced for it`);
    }
  }
  return problems;
}

// ===========================================================================
// Scratch, the shim, and the cleanup that does not trust its own bookkeeping
// ===========================================================================

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan329-'));
const fakeHome = path.join(scratchRoot, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const shimState = path.join(scratchRoot, 'shim-state');
const shimDir = path.join(scratchRoot, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

// The shim is the one from `verify-send-confirms-delivery.mjs`, reduced to what
// this proof needs: a pane that can lose an Enter and can stop answering reads.
// Deliberately NOT imported from that file — it is not an exported module, and
// copying it is what keeps this proof runnable if that one is rewritten. The
// cost is that the two can drift; the thing they would drift about is the shape
// of a pane, which neither file is evidence about anyway (see the header).
const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_KAN329_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const startedFile = path.join(state, 'started.json');
const load = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const save = (l) => fs.writeFileSync(startedFile, JSON.stringify(l, null, 2));

const paneFileFor = (name) => path.join(state, 'pane-' + Buffer.from(name).toString('hex') + '.json');
const readPane = (name) => fs.existsSync(paneFileFor(name))
  ? JSON.parse(fs.readFileSync(paneFileFor(name), 'utf8'))
  : { transcript: 'bypass permissions on\\n❯ hello, agent\\n  I am working on it.', composer: '' };
const writePane = (name, p) => fs.writeFileSync(paneFileFor(name), JSON.stringify(p));
const render = (p) => p.transcript + '\\n❯ ' + p.composer;
const nameOfPane = (id) => (load().find((s) => s.pane_id === id) || {}).name;

const dropFile = path.join(state, 'drop-enters');
const takeDrop = () => {
  if (!fs.existsSync(dropFile)) return false;
  const left = Number(fs.readFileSync(dropFile, 'utf8')) || 0;
  if (left <= 0) return false;
  fs.writeFileSync(dropFile, String(left - 1));
  return true;
};

const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (a === 'agent' && b === 'start') {
  const started = load();
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: 'p' + (100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1]
  });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'get') {
  const found = load().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id } } });
  fail('agent_not_found', "no agent '" + args[2] + "'");
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: load().map((s) => ({
    name: s.name, pane_id: s.pane_id, agent: 'claude', cwd: s.cwd, agent_status: 'working'
  })) } });
}
if (a === 'agent' && b === 'read') {
  if (fs.existsSync(path.join(state, 'unreadable'))) {
    fail('herdr_unreachable', 'could not connect to the herdr server');
  }
  const found = load().find((s) => s.name === args[2]);
  if (!found) fail('agent_not_found', "no agent '" + args[2] + "'");
  out({ result: { read: { text: render(readPane(args[2])), truncated: false } } });
}
if (a === 'pane' && b === 'send-text') {
  const name = nameOfPane(args[2]);
  if (name) { const p = readPane(name); p.composer = args[3] || ''; writePane(name, p); }
  out({ result: {} });
}
if (a === 'pane' && b === 'send-keys') {
  const name = nameOfPane(args[2]);
  if (name) {
    const p = readPane(name);
    if (args[3] === 'Enter') {
      if (!takeDrop() && p.composer) { p.transcript += '\\n❯ ' + p.composer; p.composer = ''; }
    } else if (args[3] === 'C-c') {
      p.composer = '';
    }
    writePane(name, p);
  }
  out({ result: {} });
}
if (a === 'pane' && b === 'close') { save(load().filter((s) => s.pane_id !== args[2])); out({ result: {} }); }
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else { out({ result: {} }); }
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

const dropEnters = (n) => fs.writeFileSync(path.join(shimState, 'drop-enters'), String(n));
const setUnreadable = (on) => {
  const f = path.join(shimState, 'unreadable');
  if (on) fs.writeFileSync(f, '1');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
};

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  CRABCAST_KAN329_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined,
  CRABCAST_MAX_AGENTS: undefined
};

/** Whether the process table answered at all. A zero read off a `ps` that failed is not a zero. */
function psWorks() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').length > 5;
  } catch {
    return false;
  }
}

/**
 * EVERY process whose command line mentions this run's scratch root — not just
 * the daemons.
 *
 * TWO THINGS THIS IS DELIBERATELY WIDER THAN, and KAN-323 closed exactly this
 * defect on a sibling script:
 *
 *   1. NOT a set of pids this script wrote down. The pid is recorded AFTER the
 *      spawn, so an interrupt in that window finds the set empty and kills
 *      nothing. A cleanup that tidies only what it happens to have noted is the
 *      same defect as one that runs only on the happy path.
 *   2. NOT only `daemon.js`. The herdr shim's `agent attach` runs a `setInterval`
 *      forever, and the daemon spawns it — so the grandchildren are the
 *      survivors most likely to be missed by a sweep written around the process
 *      this script meant to start.
 *
 * `mkdtemp` makes the match narrow enough that this can never kill a process it
 * did not cause: no other process on the machine can have this path in its
 * arguments.
 */
function processesUnderScratch() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(scratchRoot))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

const sleepSync = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberate: usable from an `exit` handler */ }
};

/**
 * SIGTERM everything under the scratch root, then SIGKILL what is left.
 *
 * Returns whatever is STILL running, so the caller asserts on a measurement
 * rather than on the reaper having been called.
 */
function reapScratchProcesses(waitMs = 5_000) {
  let pids = processesUnderScratch();
  if (pids.length === 0) return [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    pids = processesUnderScratch();
    if (pids.length === 0) return [];
    sleepSync(100);
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  sleepSync(500);
  return processesUnderScratch();
}

const startedPids = new Set();
let cleanedUp = false;
function cleanUp() {
  if (cleanedUp) return;
  cleanedUp = true;
  // Reap BEFORE removing the scratch root. Removing it first unlinks the
  // sockets and leaves a live daemon holding a path nothing on disk can find —
  // measured on a sibling script, where `rmSync` succeeded and the daemon went
  // on listening.
  try { reapScratchProcesses(2_000); } catch { /* best effort */ }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// `npm ci` lives beside the real dist; a mutant copy under scratch needs to
// resolve the same modules.
try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratchRoot, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));

function makeConfig(name) {
  const dataDir = path.join(scratchRoot, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratchRoot, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

const openSockets = [];

/** One request, one reply, over the real socket. */
function request(cfg, action, data = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPathFor(cfg.dataDir));
    openSockets.push(socket);
    socket.on('error', reject);
    const id = `kan329-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out on ${action}`));
    }, 40_000);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        socket.end();
        resolve(msg);
      }
    });
    socket.on('connect', () => socket.write(JSON.stringify({ action, ...data, id }) + '\n'));
  });
}

async function startDaemon(cfg, dist, label) {
  const errFile = path.join(cfg.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg.configPath], {
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !fs.existsSync(sock)) await sleep(100);
  if (!fs.existsSync(sock)) {
    throw new Error(
      `daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const status = await request(cfg, 'daemon_status');
  startedPids.add(status.pid);
  return status;
}

/** Configure and activate one agent, through the real verbs. */
async function fixtureAgent(cfg, dist, label) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, `agent-${label}-`));
  const agentPath = fs.realpathSync(dir);
  const configured = await request(cfg, 'configure_agent', {
    path: agentPath, priority: 5, launcher: 'claude'
  });
  if (!configured.success) throw new Error(`configure failed: ${JSON.stringify(configured)}`);
  // `override` past the capacity gate, for the reason `verify-read-contract`
  // gives: KAN-171 recorded a proof going red about the LAPTOP's load average
  // rather than about the code. Nothing here is a claim about the gate.
  const activated = await request(cfg, 'activate_agent', { path: agentPath, override: true });
  if (!activated.success) throw new Error(`activate failed: ${JSON.stringify(activated)}`);
  return agentPath;
}

const { mutate, mutationsSkipped } = makeMutator({
  distDir,
  scratch: scratchRoot,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

// ===========================================================================
rule('SETUP — the declaration, the document, and what is under test');
// ===========================================================================

const mod = await import(path.join(distDir, 'send-contract.js'));
const docText = fs.readFileSync(CONTRACT_DOC, 'utf8');

console.log(`   dist under test    : ${distDir}`);
console.log(`   document           : ${path.relative(repoRoot, CONTRACT_DOC)}`);
console.log(`   declared version   : ${mod.SEND_CONTRACT_VERSION}`);
console.log(`   vocabularies       : ${Object.keys(mod.SEND_VALUE_SETS).join(', ')}`);
console.log(`   branches           : ${Object.keys(mod.SEND_RESPONSE_BRANCHES).join(', ')}`);
console.log(`   load average       : ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);

// A GIVEN, not an assertion about the code: a declaration that imported as an
// empty object would make every completeness check below pass vacuously.
check(
  Object.keys(mod.SEND_VALUE_SETS ?? {}).length === 3 &&
    Object.keys(mod.SEND_RESPONSE_BRANCHES ?? {}).length > 0 &&
    Object.keys(mod.SEND_RESPONSE_FIELDS ?? {}).length > 0,
  'given: the declaration imported with all three vocabularies, the branches and the fields',
  JSON.stringify(Object.keys(mod))
);

// ===========================================================================
rule('1. DOCUMENT ↔ DECLARATION — the tables, the vocabularies and the branches agree, both ways');
// ===========================================================================

reportProblems(
  'every field, bucket, vocabulary member and branch key set agrees in both directions',
  reconcileDocument(mod, docText)
);

// The trap the ticket names, asserted as a fact rather than left to the tables:
// the two vocabularies are NOT the same set, and the difference is exactly
// `refused`.
{
  const send = mod.SEND_VALUE_SETS.sendVerdict;
  const wire = mod.SEND_VALUE_SETS.sendResponseVerdict;
  const extra = wire.filter((v) => !send.includes(v));
  check(
    send.length === 3 && wire.length === 4 && extra.length === 1 && extra[0] === 'refused',
    'the send vocabulary is three and the response vocabulary is four, differing by `refused`',
    `send=[${send.join(' ')}] wire=[${wire.join(' ')}]`
  );
  check(
    Object.values(mod.SEND_BRANCH_VERDICTS).filter((v) => v === 'unverifiable').length === 2,
    'and two branches answer `unverifiable`, which is why the verdict does not tell a consumer ' +
      'whether `evidence` is present',
    JSON.stringify(mod.SEND_BRANCH_VERDICTS)
  );
}

// ===========================================================================
rule('2. DECLARATION ↔ A REAL DAEMON — four branches produced, and their EXACT key sets asserted');
// ===========================================================================

const samples = {};
const main = makeConfig('main');
{
  const status = await startDaemon(main, distDir, 'main');
  console.log(`   daemon pid ${status.pid}, contract v${status.contractVersion} (read path)`);

  dropEnters(0);
  setUnreadable(false);
  const agentPath = await fixtureAgent(main, distDir, 'wire');

  // --- delivered ----------------------------------------------------------
  samples.delivered = await request(main, 'send_to_agent', {
    path: agentPath, message: 'kan329: a message that lands'
  });

  // --- not-delivered: the Enter is accepted and does nothing ---------------
  dropEnters(99);
  samples['not-delivered'] = await request(main, 'send_to_agent', {
    path: agentPath, message: 'kan329: the enter does not take'
  });
  dropEnters(0);

  // --- unverifiable: the pane cannot be read at all ------------------------
  setUnreadable(true);
  samples.unverifiable = await request(main, 'send_to_agent', {
    path: agentPath, message: 'kan329: cannot be observed'
  });
  setUnreadable(false);

  // --- refused: a blank message to an agent that resolves perfectly well ---
  //
  // CHOSEN OVER A BAD PATH DELIBERATELY. Both refusals go through the same
  // site, and this one is the case that demonstrates the second asymmetry the
  // document states: the response carries no `path` even though the path was
  // never in question.
  samples.refused = await request(main, 'send_to_agent', {
    path: agentPath, message: '   '
  });

  for (const [branch, body] of Object.entries(samples)) {
    const shown = body.evidence
      ? { ...body, evidence: { ...body.evidence, tail: '…' } }
      : body;
    console.log(`   ${branch}:`);
    console.log(JSON.stringify(shown, null, 2).replace(/^/gm, '     '));
  }

  // GIVENS before the completeness checks, so a fixture that did not build is
  // reported as a failure of the RUN rather than as four vacuous passes.
  check(
    samples.delivered.verdict === 'delivered' &&
      samples['not-delivered'].verdict === 'not-delivered' &&
      samples.unverifiable.verdict === 'unverifiable' &&
      samples.refused.verdict === 'refused',
    'given: the fixture produced one response on each of four distinct branches',
    Object.entries(samples).map(([k, v]) => `${k}=${v.verdict}`).join(' ')
  );
  check(
    samples.refused.path === undefined && samples.refused.evidence === undefined,
    'a blank message to a PERFECTLY RESOLVABLE agent comes back with no `path` and no `evidence`',
    JSON.stringify(samples.refused)
  );
  check(
    samples.unverifiable.evidence !== undefined &&
      samples.unverifiable.evidence.readable === false,
    'and the `unverifiable` a send produces DOES carry evidence, with `readable: false`',
    JSON.stringify(samples.unverifiable.evidence)
  );
}

// ===========================================================================
rule('3. THE FIFTH BRANCH — manufactured, because a healthy bridge never throws');
// ===========================================================================
//
// `unconfirmable` is the branch where `HerdrBridge.sendToAgent`'s promise
// REJECTS. That method is written never to throw — its own doc comment says so,
// and the caller is a request handler that owes its client a response either
// way — so this branch cannot be produced by asking a healthy daemon nicely.
//
// NAMED AS MANUFACTURED RATHER THAN COUNTED AS ORDINARY. What follows is a real
// daemon, a real router and a real socket; what is not real is the rejection,
// which is inserted. That makes this evidence about the ROUTER's handling of a
// rejection and not evidence that a rejection ever happens.

manufactured: {
  const dir = mutate(
    'bridge-rejects',
    'herdr.js',
    'const confirmTimeoutMs = opts.confirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;',
    'if (message.includes("kan329-force-reject")) throw new Error("injected bridge failure");\n' +
      '        const confirmTimeoutMs = opts.confirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;'
  );
  if (!dir) break manufactured; // already a counted failure

  const cfg = makeConfig('reject');
  const status = await startDaemon(cfg, dir, 'reject');
  console.log(`   mutant daemon pid ${status.pid}, from ${path.relative(scratchRoot, dir)}`);

  dropEnters(0);
  setUnreadable(false);
  const agentPath = await fixtureAgent(cfg, dir, 'reject');

  // PRECONDITION: the same daemon answers an ordinary send normally, so this
  // section is exercising the rejection rather than a broken build.
  const ordinary = await request(cfg, 'send_to_agent', {
    path: agentPath, message: 'kan329: ordinary send against the mutant'
  });
  check(
    ordinary.verdict === 'delivered',
    'precondition: the mutant daemon still delivers an ordinary message, so only the injected ' +
      'rejection is different',
    JSON.stringify({ verdict: ordinary.verdict, error: ordinary.error })
  );

  samples.unconfirmable = await request(cfg, 'send_to_agent', {
    path: agentPath, message: 'kan329-force-reject: the bridge throws'
  });
  console.log('   unconfirmable:');
  console.log(JSON.stringify(samples.unconfirmable, null, 2).replace(/^/gm, '     '));

  check(
    samples.unconfirmable.verdict === 'unverifiable' &&
      samples.unconfirmable.evidence === undefined,
    'THE ASYMMETRY, ON THE WIRE: a rejecting bridge answers `unverifiable` with NO evidence ' +
      'block, unlike every other `unverifiable` on this surface',
    JSON.stringify(samples.unconfirmable)
  );
  check(
    samples.unconfirmable.path !== undefined,
    'and it does carry `path`, which is what separates its key set from the refusal\'s',
    JSON.stringify(samples.unconfirmable)
  );
}

// The reconciliation over everything produced, including the manufactured one.
reportProblems(
  'every branch on the wire carries EXACTLY the keys the declaration gives it, with the ' +
    'declared verdict, a vocabulary-member `refused`, a fully-declared evidence block, and ' +
    '`error` absent if and only if delivered',
  reconcileWire(mod, samples)
);

// ===========================================================================
rule('4. THE VERSION AND ITS DIGEST');
// ===========================================================================

const canonical = mod.sendContractCanonical();
const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
const versions = parseVersions(docText);

console.log(`   declared SEND_CONTRACT_VERSION : ${mod.SEND_CONTRACT_VERSION}`);
console.log(`   digest of the declaration      : ${digest}`);
console.log(`   rows in the version table      : ${versions?.map((v) => v.version).join(', ')}`);

{
  const current = versions?.find((v) => v.version === mod.SEND_CONTRACT_VERSION);
  check(
    Boolean(current),
    'the version table has a row for the declared version',
    `declared v${mod.SEND_CONTRACT_VERSION}, rows: ${versions?.map((v) => v.version).join(', ')}`
  );
  check(
    current?.digest === digest,
    'and the digest recorded for it matches the declaration, so a silent change is loud',
    `row says ${current?.digest ?? '(no row)'}, declaration hashes to ${digest}`
  );
  check(
    versions?.every((v, i) => i === 0 || v.version === versions[i - 1].version + 1),
    'and the versions increment by one with no gaps',
    versions?.map((v) => v.version).join(', ')
  );
}

// ===========================================================================
rule('5. NO BARE VERDICT LITERAL IN THE HANDLER — the half the compiler cannot see');
// ===========================================================================
//
// `Respond` is `(msg: any) => void`, so an object literal spread into
// `respond({…})` is not type-checked against anything. That is why the two
// off-outcome branches are built through `refusedSend` and `unconfirmableSend`
// in `src/delivery.ts`, where the vocabulary is declared and the compiler
// checks them.
//
// WHAT THIS SCAN IS AND IS NOT. It is a text search over ONE function in one
// file, so it catches the case it is written for — somebody adding a third
// respond site to this handler with the verdict typed out — and it does not
// reach a new handler elsewhere. Said here rather than in the document only.

{
  const routerSrc = fs.readFileSync(path.join(repoRoot, 'src', 'router.ts'), 'utf8');
  const start = routerSrc.indexOf('private handleSendToAgent(');
  const end = routerSrc.indexOf('\n  private ', start + 10);
  check(start !== -1 && end > start, 'given: `handleSendToAgent` was located in src/router.ts',
    `start=${start} end=${end}`);
  const handler = routerSrc.slice(start, end === -1 ? undefined : end);

  const bare = [...handler.matchAll(/verdict\s*:\s*'([^']*)'/g)].map((m) => m[1]);
  check(
    bare.length === 0,
    'the handler contains no bare `verdict:` string literal — every verdict it answers with is ' +
      'built through a typed constructor the compiler checks',
    bare.length ? `found: ${bare.map((v) => `'${v}'`).join(', ')}` : ''
  );
  // VACUITY GUARD: if the handler were ever found empty or renamed, the check
  // above would pass on nothing at all.
  check(
    /refusedSend\(/.test(handler) && /unconfirmableSend\(/.test(handler),
    'and it does call both typed constructors, so the check above is not passing over an empty ' +
      'or renamed function',
    handler.slice(0, 200)
  );
}

// ===========================================================================
rule('6. THE COMPILE-TIME BINDING, WATCHED REFUSING — a fifth verdict does not build');
// ===========================================================================
//
// THIS IS THE STRONGEST HALF OF THE CONTRACT AND IT IS THE HALF NOBODY CAN SEE
// PASS. `Exact<>` makes an undocumented member unrepresentable rather than
// detectable — but a binding that has only ever been observed compiling has not
// been shown to bind anything. So a copy of `src/` gets a fifth verdict added
// to the UNION ALONE, and `tsc` is required to refuse it and to name
// `src/send-contract.ts` when it does.
//
// AND THIS IS WHY THE MUTATIONS IN §7 ADD THE MEMBER TO BOTH THE UNION AND THE
// DECLARATION: a mutation that only touches the union does not compile, so a
// proof importing from `dist/` would run against the previous build and report
// on code that was never mutated. The two halves catch different things and
// each is run against the input it can actually see.

typecheck: {
  const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscBin)) {
    check(false, 'given: typescript is installed, so the compile-time binding can be exercised',
      `no compiler at ${tscBin}`);
    break typecheck;
  }

  const tcRoot = path.join(scratchRoot, 'typecheck');
  fs.mkdirSync(tcRoot, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'src'), path.join(tcRoot, 'src'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'tsconfig.json'), path.join(tcRoot, 'tsconfig.json'));
  // `package.json` TOO, and it is load-bearing rather than tidy: under
  // `module: NodeNext` the compiler reads the nearest package.json to decide
  // whether a file is ESM, so a copy without one builds as CommonJS and every
  // `import.meta` in the tree is an error. The first run of this section hit
  // exactly that — four unrelated TS1470s, and BOTH mutation checks below would
  // have passed on them while the binding under test was never reached. The
  // precondition is what caught it, which is the argument for having one.
  fs.cpSync(path.join(repoRoot, 'package.json'), path.join(tcRoot, 'package.json'));
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tcRoot, 'node_modules'), 'dir');
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }

  const runTsc = () =>
    spawnSync(process.execPath, [tscBin, '-p', tcRoot, '--noEmit'], {
      encoding: 'utf8', timeout: 180_000
    });

  // PRECONDITION: the unmutated copy compiles. Without it a red below could be
  // a copy that never built, and the section would credit the binding for a
  // failure it had nothing to do with.
  const clean = runTsc();
  check(clean.status === 0, 'precondition: the copied source compiles before it is mutated',
    `${clean.status}\n${clean.stdout}\n${clean.stderr}`);

  const target = path.join(tcRoot, 'src', 'delivery.ts');
  const before = fs.readFileSync(target, 'utf8');
  const anchor = "export type SendVerdict = 'delivered' | 'not-delivered' | 'unverifiable';";
  const occurrences = before.split(anchor).length - 1;
  check(occurrences === 1, 'given: the union to mutate is at exactly one place in delivery.ts',
    `found ${occurrences}`);
  if (occurrences !== 1) break typecheck;

  fs.writeFileSync(
    target,
    before.replace(
      anchor,
      "export type SendVerdict = 'delivered' | 'not-delivered' | 'unverifiable' | 'queued';"
    )
  );
  const mutated = runTsc();
  const output = `${mutated.stdout}${mutated.stderr}`;
  console.log('   tsc, with `queued` added to SendVerdict and to no table:');
  for (const line of output.trim().split('\n').slice(0, 6)) console.log(`     ${line}`);

  check(
    mutated.status !== 0,
    'a fifth verdict added to the union alone is a BUILD FAILURE — the undocumented value cannot ' +
      'be introduced at all, rather than being caught after the fact',
    `tsc exited ${mutated.status}`
  );
  check(
    /send-contract\.ts/.test(output),
    'and the failure names src/send-contract.ts, so it is the CONTRACT binding refusing it and ' +
      'not some unrelated type error',
    output.slice(0, 800)
  );
}

// ===========================================================================
rule('7. THE RED HALF — the reconcilers are handed doctored inputs and must go red BY NAME');
// ===========================================================================
//
// Every mutation here runs the SAME functions the real sections ran, on altered
// inputs. Each one asserts three things: that the reconciler was green on the
// real inputs a moment ago, that it goes red on the doctored ones, and that the
// sentence it produces NAMES the thing that was changed — a mutation credited
// for an unrelated failure proves nothing about the check it was aimed at.

const named = (problems, needle) => problems.some((p) => p.includes(needle));

// --- 7a. a member added to the declaration and not to the document ---------
{
  const doctored = {
    ...mod,
    SEND_VALUE_SETS: {
      ...mod.SEND_VALUE_SETS,
      sendResponseVerdict: [...mod.SEND_VALUE_SETS.sendResponseVerdict, 'queued']
    }
  };
  const problems = reconcileDocument(doctored, docText);
  check(
    named(problems, "values sendResponseVerdict: 'queued' is declared and not in the document"),
    '7a: a fifth verdict added to the declaration with no row in the document is red, by name',
    problems.join('\n') || '(no problems reported)'
  );
}

// --- 7b. a member REMOVED from the document -------------------------------
//
// The other direction, which the ticket asks about explicitly. The set
// comparison is bidirectional, so BOTH are covered and this is the evidence.
{
  const doctoredDoc = docText.replace(
    '| `refused` | the request never became a send',
    '| ~~removed~~ | the request never became a send'
  );
  check(doctoredDoc !== docText, 'given: 7b\'s document mutation applied');
  const problems = reconcileDocument(mod, doctoredDoc);
  check(
    named(problems, "values sendResponseVerdict: 'refused' is declared and not in the document"),
    '7b: deleting a documented member while the declaration keeps it is red, by name — so the ' +
      'guard catches a value REMOVED as well as one added',
    problems.join('\n') || '(no problems reported)'
  );
}

// --- 7c. a field deleted from a document table ----------------------------
{
  const doctoredDoc = docText.replace(
    /\| `tailSource` \| observed, optional \|[^\n]*\n/,
    ''
  );
  check(doctoredDoc !== docText, 'given: 7c\'s document mutation applied');
  const problems = reconcileDocument(mod, doctoredDoc);
  check(
    named(problems, 'SEND_EVIDENCE_FIELDS.tailSource: declared, absent from the document'),
    '7c: deleting a field row from an evidence table is red, by name',
    problems.join('\n') || '(no problems reported)'
  );
}

// --- 7d. a branch's key set altered in the document ------------------------
//
// THE ONE A PROSE TABLE WOULD HAVE LET THROUGH. Nothing is added or removed
// anywhere else: the document simply claims the refusal carries a `path`, which
// is the exact misreading the second asymmetry exists to prevent.
{
  const doctoredDoc = docText.replace(
    '| `refused` | `refused` | `action` `success` `delivered` `verdict` `refused` `error` |',
    '| `refused` | `refused` | `action` `path` `success` `delivered` `verdict` `refused` `error` |'
  );
  check(doctoredDoc !== docText, 'given: 7d\'s document mutation applied');
  const problems = reconcileDocument(mod, doctoredDoc);
  check(
    named(problems, 'branch refused: document says'),
    '7d: claiming the refusal carries `path` when it does not is red, by name',
    problems.join('\n') || '(no problems reported)'
  );
}

// --- 7e. the version bumped without a row ----------------------------------
{
  const doctored = { ...mod, SEND_CONTRACT_VERSION: mod.SEND_CONTRACT_VERSION + 1 };
  const rows = parseVersions(docText);
  const row = rows?.find((v) => v.version === doctored.SEND_CONTRACT_VERSION);
  check(
    row === undefined,
    '7e: bumping the declared version without adding a table row leaves the version with no row, ' +
      'which is what §4 reports',
    `row for v${doctored.SEND_CONTRACT_VERSION}: ${JSON.stringify(row)}`
  );
}

// --- 7f. the WIRE reconciler goes red too ----------------------------------
//
// §2's leg needs its own mutation: everything above doctors the document, and a
// declaration that agrees with a document can still disagree with the daemon.
// Run against the responses ALREADY CAPTURED, so this is the same code judging
// the same real wire with one field's optionality changed.
{
  const doctored = {
    ...mod,
    SEND_RESPONSE_BRANCHES: {
      ...mod.SEND_RESPONSE_BRANCHES,
      delivered: [...mod.SEND_RESPONSE_BRANCHES.delivered, 'error']
    }
  };
  const problems = reconcileWire(doctored, samples);
  check(
    named(problems, 'branch delivered:'),
    '7f: declaring that a `delivered` response carries `error` is red against the REAL wire, ' +
      'which is a fact no document mutation could have established',
    problems.join('\n') || '(no problems reported)'
  );
}

// ===========================================================================
rule('8. THIS PROOF LEAVES NOTHING RUNNING — measured, not concluded from the code');
// ===========================================================================
//
// Two daemons and a herdr shim that attaches with a `setInterval` are started
// above, so the claim "it cleans up after itself" is one this file has to
// MEASURE. KAN-323 closed exactly this defect on a sibling script; its shape is
// stolen rather than rediscovered.

check(psWorks(), 'CANARY: the process table is readable, so a zero from it means zero');

// VACUITY PRECONDITION. A sweep for survivors over a run that never started
// anything passes with nothing behind it — which is the shape of a green that
// means nothing.
check(
  startedPids.size >= 2,
  'PRECONDITION: this run really did start daemons under its scratch root',
  `${startedPids.size} daemon(s): ${[...startedPids].join(', ')}`
);
{
  const before = processesUnderScratch();
  console.log(`   under the scratch root before the sweep: ${before.length} process(es)`);

  const survivors = reapScratchProcesses();
  check(
    survivors.length === 0,
    'REAPED: nothing under this run’s scratch root is left on the process table — daemons and ' +
      'the shim’s grandchildren alike',
    `survivors ${JSON.stringify(survivors)}`
  );

  const stillAnswering = [];
  for (const cfg of [main, ...(fs.existsSync(path.join(scratchRoot, 'crabcast-reject.json'))
    ? [{ dataDir: path.join(scratchRoot, 'data-reject') }]
    : [])]) {
    const sock = socketPathFor(cfg.dataDir);
    if (!fs.existsSync(sock)) continue;
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(sock);
        s.on('connect', () => { s.destroy(); reject(new Error('still answering')); });
        s.on('error', () => resolve());
      });
    } catch {
      stillAnswering.push(sock);
    }
  }
  check(
    stillAnswering.length === 0,
    'and nothing answers on any socket this run created',
    stillAnswering.join(', ')
  );
}

// ===========================================================================
rule('VERDICT');
// ===========================================================================

if (mutationsSkipped().length) {
  console.log(`   mutations that did not apply: ${mutationsSkipped().join(', ')}`);
}
console.log(`   ${checks} checks, ${failures} failed`);
console.log(
  failures === 0
    ? '\nALL CHECKS PASSED — the send contract is document, declaration and wire, reconciled.'
    : `\n${failures} CHECK(S) FAILED.`
);

process.exit(failures ? 1 : 0);
