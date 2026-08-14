#!/usr/bin/env node
// Live proof for KAN-277 and KAN-287: the READ PATH is a published contract —
// `list_agents`, `agent_status` and `activate_response`, field by field, with a
// provenance bucket per field, a version on the wire in exactly one place, and a
// stability statement that is a NOTICE promise rather than a freeze.
//
// WHAT FAILURE THIS WOULD CATCH: a field appearing on, or disappearing from, a
// read response with nothing saying so — the shape a consumer builds against
// moving underneath them silently. `docs/event-contract.md` publishes nine
// events field by field and makes an authoritative `list_agents` poll a
// CORRECTNESS requirement for every consumer of those events, and then
// described none of the shape that poll returns. Butchr, the first consumer,
// asserted our response shape in THEIR repository — which means it was not our
// contract, and a field added here would have been found by their reconciler
// breaking rather than by anything on this side.
//
// It would also catch the second half of that, which is the half a document
// alone never has: the document and the code drifting apart. A table nobody
// checks is prose, and this epic has paid for that distinction repeatedly.
//
// ---------------------------------------------------------------------------
// THE THREE ARTIFACTS, AND WHY IT TAKES THREE
//
//   docs/read-path-contract.md   what a consumer reads
//   src/read-contract.ts         the same tables as data
//   a REAL daemon's responses    what actually goes on the wire
//
// Checking any two of those leaves the third free to be wrong, and the pairs
// fail differently. Document against declaration alone is two files agreeing
// with each other about a daemon neither has spoken to. Declaration against the
// wire alone is a machine-readable contract nobody can read. So all three are
// reconciled, pairwise, in both directions.
//
// ---------------------------------------------------------------------------
// SECTIONS
//
//   1. document ↔ declaration — every table names a declaration that exists and
//      every declaration has exactly one table; the field sets are equal in
//      both directions; the buckets and optionality agree; every `rows`/`block`
//      reference resolves; the four `agent_status` branches agree; the eight
//      closed vocabularies agree. Static — no daemon. (AC 1, AC 4)
//
//   2. declaration ↔ a REAL daemon — a fleet with EVERY category populated,
//      through real lifecycle calls, read back over the real MCP tools and the
//      real socket. A key on the wire that nothing declares is red; a
//      non-optional declared field missing from the wire is red. All four
//      `agent_status` branches are produced and their EXACT key sets asserted,
//      refusals included, and so is a refused `list_agents`. §2d does the same
//      for `activate_response`'s eleven branches — ten produced, one named as
//      unproducible rather than skipped. (AC 1, AC 2)
//
//   3. the version, in ONE place — document, declaration and wire carry the
//      same integer; the version table has a row for it whose digest matches
//      the declaration; and `list_agents`, `agent_status` and `capacity` carry
//      NO version field, so "one place" is measured rather than claimed. (AC 3)
//
//   4. buckets against the LIVE legend — every ROW field's bucket in the
//      document is byte-identical to the bucket the response's own `provenance`
//      block puts it in, in both directions. This is the one join neither side
//      owns, and it is the reason this proof does not duplicate
//      `verify-state-read-echoes-config.mjs` §7. (AC 1)
//
//   5. the stability statement, verbatim — the promise and all four of the
//      things it explicitly does NOT promise. (AC 4)
//
//   6. THE RED HALF — five mutations, each watched going red BY NAME:
//        6a. a field added to a real `list_agents` payload and not documented
//            (this is AC 5's "add a field to a response without documenting
//            it, show the failure, restore" — run against a mutated build, so
//            the failure is produced rather than described)
//        6b. a field removed from a document table
//        6c. the declared version bumped without its table row
//        6d. a field added to a real `activate_response` and not documented —
//            the same experiment on the surface KAN-287 added, which nothing
//            checked at all before it
//        6e. a CONDITIONAL `activate_response` field documented as GUARANTEED.
//            No field is added or removed, so every check that compares field
//            sets stays green; only the two-list branch table sees it
//        6f. a covered surface deleted from §10's boundary table — the starve
//            the reviewer ran, which printed ALL CHECKS PASSED before the
//            boundary was data on both sides
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// A proof that supplies its own input has not tested that the input arrives, so
// here is the line in this one.
//
// The FIXTURE is supplied: this script configures, activates, preempts and
// stands down agents to put a row in every category, and injects two panes into
// the herdr shim (a foreign one, and one of ours with no runtime behind it) so
// `foreignPanes` and `unbackedPanes` are non-empty. What it does NOT supply is
// anything it asserts on. The field sets come from a real daemon computing a
// real response and writing it down a real socket; the buckets come from that
// response's own legend; the version comes off the wire. The fixture decides
// WHICH rows exist. It does not decide what shape they have, and no assertion
// here reads a value this script wrote.
//
// EVERY CATEGORY IS ASSERTED NON-EMPTY BEFORE IT IS ASSERTED CORRECT. A
// completeness check over an empty array passes vacuously and proves nothing,
// and "every field of every row is declared" over zero rows is exactly that
// shape. The non-emptiness checks are `given`s: a fleet that did not build is a
// failure of the RUN, reported as one, rather than an empty category three
// sections later.
//
// THE FIXTURE GOES PAST THE CAPACITY GATE, and that is a measured decision
// rather than a convenience. KAN-171 recorded `verify-config-echo-contract`
// going red about the LAPTOP: above a load average of ~2.25 the gate refused its
// activations, every row landed in `unstartedAgents`, and the script reported a
// statement about the runner in the words of a statement about the code. Every
// activation here passes `override`, exactly as that script's PAST_THE_GATE
// does, and the load average is PRINTED rather than compared against. Nothing
// in this file is a claim about the gate.
//
// The one row that could not be produced that way is `preemptedAgents`, and
// what this script supplies for it — and what that leaves uncovered — is
// written down at the call site rather than here, beside the thing it is about.
//
// ---------------------------------------------------------------------------
// WHAT NOTHING HERE COVERS, named rather than left to be inferred
//
//   * `capacity`'s NUMBERS. This asserts the fields exist, are declared and are
//     classified. Whether `headroom` is arithmetically right is
//     `verify-agent-capacity.mjs`, `verify-cpu-headroom.mjs` and
//     `verify-io-stall-gate.mjs`.
//   * The `config` echo's INTERIOR — `verify-config-echo-contract.mjs`.
//   * Whether a bucket is the RIGHT bucket. §4 asserts this document agrees
//     with the legend the daemon publishes; that the legend's `durable` really
//     survives a restart and its `observed` really moves with the census is
//     `verify-state-read-echoes-config.mjs` §7, which demonstrates each bucket's
//     claimed property. These two proofs are adjacent and DO NOT COVER EACH
//     OTHER: if the legend and this document were wrong in the SAME way, §4
//     would be green and §7 would be the thing that noticed.
//   * Whether the version number was INCREMENTED when it should have been. The
//     digest in the version table makes a change to a documented field loud —
//     §6c is that going red — but a human still has to add the row. Said in the
//     document under "What nothing here covers" as well, in the same words.
//   * Whether a consumer notice was actually SENT. §1 of the document is a
//     promise kept by people; §5 here checks only that the sentence is still
//     there, which makes deletion loud and claims nothing further.
//   * `herdrHealth`, when the runner has no herdr server process to read
//     descriptors from. The block is declared optional and its absence is
//     legitimate, so §2 reports which of the two happened rather than asserting
//     over nothing — see the note it prints.
//   * `activate_response`'s `attach-error` BRANCH. It needs `pty.spawn` to throw
//     in the parent process, and nothing this harness can do to herdr produces
//     that — a refused `agent attach` fails in the CHILD, where the catch that
//     records it is not. §2d names it in its output rather than passing over it,
//     and its key set is held by §1 against the declaration and by nothing on
//     the wire. NO SIBLING SCRIPT COVERS IT EITHER: `verify-spawn-failure-
//     legibility.mjs` drives spawn failures and is excluded from CI, and it
//     asserts `spawnError`'s wording rather than this response's key set. So the
//     honest answer to "who covers this branch on the wire" is NOBODY, and that
//     is written here rather than left to be inferred from a count.
//   * `activate_response`'s BUCKETS against a live legend. There is no legend:
//     that response carries no `provenance` block, so §4's join does not exist
//     for it and its classification is held by §1 alone. The document says the
//     same thing in §8, in the same words.
//
// Everything on the daemon side is real: a real daemon process, real router,
// bridge, registry and config loader, real NDJSON over a real unix socket, a
// real MCP server over real stdio. What is faked is the `herdr` binary — a shim
// on PATH answering in herdr's own JSON shapes, whose pane set this script can
// change from underneath a running daemon. Isolation is a scratch dataDir and a
// scratch $HOME with a system-only PATH.
//
// Usage:
//   npm run build
//   node scripts/verify-read-contract.mjs [distDir]

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// The dist dir is the first POSITIONAL argument. Flags are filtered out
// deliberately (KAN-376): reading `process.argv[2]` directly would resolve
// `--static-only` as a directory path, and the failure that produces is a
// contract proof importing from a dist that does not exist — a red about the
// invocation wearing the clothes of a red about the contract.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const distDir = path.resolve(positional[0] ?? path.join(scriptDir, '..', 'dist'));
const repoRoot = path.join(scriptDir, '..');
const CONTRACT_DOC = path.join(repoRoot, 'docs', 'read-path-contract.md');

const LAUNCHER = 'shell';
/** A launcher that expects a runtime, so a pane with none is UNBACKED. `shell` cannot be one. */
const RUNTIME_LAUNCHER = 'claude';

// --------------------------------------------------------------- the harness --

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => {
  const body = value === undefined ? '(undefined)' : JSON.stringify(value, null, 2);
  console.log(`   ${label}\n${String(body).replace(/^/gm, '     ')}`);
};
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
/**
 * A PRECONDITION, reported apart from a verdict.
 *
 * A completeness check over an empty list passes vacuously, so the things this
 * script asserts ON have to be asserted to EXIST first, and a failure here is a
 * failure of the run rather than of the code under test.
 */
const given = (ok, what, detail) => {
  console.log(`   ${ok ? 'given' : 'GIVEN FAILED'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  console.log(`   (timed out after ${ms}ms waiting for ${what})`);
  return false;
};

// ================================================== THE DOCUMENT PARSER ======
//
// The document is read by ANCHOR rather than by position: every field table is
// preceded by `<!-- contract-table: NAME -->`, and NAME is the declaration in
// `src/read-contract.ts` it is bound to. A table that moves is still found; a
// table for a declaration that does not exist is caught by name; and a
// declaration with no table is caught the other way. A positional parser would
// have silently produced an empty field set for a section that had been
// renamed, and every completeness check over it would have passed.
//
// PARSED IN A PURE FUNCTION OF THE TEXT, so §6b can hand it a MUTATED document
// and watch the same code go red. A checker that can only be run against the
// real file cannot be shown to fail.

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
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
    rows.push(cells);
  }
  // Drop the header row and the `---` separator.
  return rows.slice(2);
}

/**
 * Every `<!-- contract-table: NAME -->` in the document, as
 * `NAME -> { field -> { bucket, optional } }`.
 *
 * A row whose first cell reads `config echo` is EXPANDED into the five fields
 * of `BLOCK_SHAPES.ConfigEcho`, carrying that row's bucket and optionality. The
 * shorthand exists so eight tables do not each repeat five rows; the expansion
 * is what keeps it from being a hole, and the document says so where the
 * shorthand is introduced.
 */
function parseTables(text, echoFields) {
  const tables = new Map();
  const re = /<!--\s*contract-table:\s*([A-Za-z0-9_.]+)\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const fields = {};
    for (const cells of tableAfter(text, m.index + m[0].length)) {
      const first = plain(cells[0] ?? '');
      if (!first) continue;
      const spec = plain(cells[1] ?? '');
      const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
      const bucket = parts[0] ?? '';
      const optional = parts.includes('optional');
      const names = first === 'config echo' ? echoFields : [first];
      for (const f of names) fields[f] = { bucket, optional };
    }
    if (tables.has(name)) tables.set(name, null); // duplicate: caught by §1a
    else tables.set(name, fields);
  }
  return tables;
}

/** `<!-- contract-branches: … -->` — branch name to its exact key list. */
function parseBranches(text) {
  const m = /<!--\s*contract-branches:\s*([A-Za-z0-9_]+)\s*-->/.exec(text);
  if (!m) return null;
  const branches = {};
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const name = plain(cells[0] ?? '');
    if (!name) continue;
    branches[name] = [...(cells[2] ?? '').matchAll(/`([A-Za-z0-9_]+)`/g)].map((k) => k[1]);
  }
  return branches;
}

/**
 * `<!-- contract-activate-branches: … -->` — branch name to its TWO key lists
 * (KAN-287).
 *
 * A SECOND PARSER RATHER THAN A FLAG ON THE FIRST, because the tables carry
 * genuinely different information and merging them would have meant the branch
 * parser returning a shape whose second half is empty for one caller. On
 * `agent_status` a branch has an EXACT key set; on `activate_response` nine
 * fields are spread conditionally, so it has a guaranteed set and a permitted
 * set. See ACTIVATE_RESPONSE_BRANCHES for why that is a property of the surface
 * rather than of the documentation.
 *
 * An em-dash in the `sometimes` cell means "none" and yields an empty list —
 * the regex simply finds no backticked names in it, so nothing special is done
 * for it here. That is deliberate: a cell a human left blank and a cell reading
 * `—` must not differ, or the document grows a way to say the same thing twice.
 */
function parseActivateBranches(text) {
  const m = /<!--\s*contract-activate-branches:\s*([A-Za-z0-9_]+)\s*-->/.exec(text);
  if (!m) return null;
  const branches = {};
  const keys = (cell) => [...(cell ?? '').matchAll(/`([A-Za-z0-9_]+)`/g)].map((k) => k[1]);
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const name = plain(cells[0] ?? '');
    if (!name) continue;
    branches[name] = { always: keys(cells[2]), sometimes: keys(cells[3]) };
  }
  return branches;
}

/**
 * §10's two boundary tables — the first backticked name in each row (KAN-287,
 * hardened on review).
 *
 * WHY THIS PARSER EXISTS AT ALL. §10 says *"a contract that does not say where
 * it stops is a claim outrunning its mechanism"*, and in the first draft it was
 * one: four rows of prose no check read. Deleting the `agent_status` row from
 * the Covered table left this entire proof green. The section is now data on
 * both sides and this is the half that reads the document.
 */
function parseBoundary(text, anchor) {
  const m = new RegExp(`<!--\\s*contract-${anchor}-surfaces\\s*-->`).exec(text);
  if (!m) return null;
  const names = [];
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const found = /`([A-Za-z0-9_]+)`/.exec(cells[0] ?? '');
    if (found) names.push(found[1]);
  }
  return names;
}

/** Every `<!-- contract-values: NAME -->` — the first column of the table under it. */
function parseValueSets(text) {
  const sets = {};
  const re = /<!--\s*contract-values:\s*([A-Za-z0-9_]+)\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    sets[m[1]] = tableAfter(text, m.index + m[0].length)
      .map((cells) => plain(cells[0] ?? ''))
      .filter(Boolean);
  }
  return sets;
}

/** `<!-- contract-versions -->` — version number to the digest recorded for it. */
function parseVersions(text) {
  const m = /<!--\s*contract-versions\s*-->/.exec(text);
  if (!m) return null;
  const rows = [];
  for (const cells of tableAfter(text, m.index + m[0].length)) {
    const version = Number(plain(cells[0] ?? ''));
    if (!Number.isInteger(version)) continue;
    rows.push({ version, digest: plain(cells[3] ?? '') });
  }
  return rows;
}

// ---------------------------------------------------------- the declaration --

const contract = await import(path.join(distDir, 'read-contract.js'));
const {
  READ_CONTRACT_VERSION,
  ROW_SHAPES,
  BLOCK_SHAPES,
  LIST_AGENTS_FIELDS,
  LIST_AGENTS_REFUSAL_FIELDS,
  AGENT_STATUS_FIELDS,
  AGENT_STATUS_BRANCHES,
  ACTIVATE_RESPONSE_FIELDS,
  ACTIVATE_RESPONSE_BRANCHES,
  COVERED_SURFACES,
  UNCOVERED_SURFACES,
  DAEMON_STATUS_CONTRACT_FIELDS,
  VALUE_SETS,
  readContractCanonical
} = contract;

/** Every declared field table, by the name a document anchor uses for it. */
function declarationsOf(mod) {
  const decls = new Map([
    ['LIST_AGENTS_FIELDS', mod.LIST_AGENTS_FIELDS],
    ['LIST_AGENTS_REFUSAL_FIELDS', mod.LIST_AGENTS_REFUSAL_FIELDS],
    ['AGENT_STATUS_FIELDS', mod.AGENT_STATUS_FIELDS],
    ['ACTIVATE_RESPONSE_FIELDS', mod.ACTIVATE_RESPONSE_FIELDS],
    ['DAEMON_STATUS_CONTRACT_FIELDS', mod.DAEMON_STATUS_CONTRACT_FIELDS]
  ]);
  for (const [name, table] of Object.entries(mod.ROW_SHAPES)) {
    decls.set(`ROW_SHAPES.${name}`, table);
  }
  for (const [name, table] of Object.entries(mod.BLOCK_SHAPES)) {
    decls.set(`BLOCK_SHAPES.${name}`, table);
  }
  return decls;
}

const digestOf = (canonical) => createHash('sha256').update(canonical).digest('hex').slice(0, 12);

/**
 * The row shapes REACHABLE FROM THE TWO READ RESPONSES, computed rather than
 * listed (KAN-287).
 *
 * §4 joins the contract's row-field buckets against the `provenance` legend a
 * real response publishes. That legend describes the rows of `list_agents` and
 * `agent_status` — `activate_response` carries no legend at all — so the join
 * has to be taken over exactly the shapes those two responses carry, and
 * `ROW_SHAPES` is now wider than that.
 *
 * COMPUTED FROM THE FIELD TABLES, NOT WRITTEN OUT, because a hand-kept list is
 * the thing that goes stale: a row shape added to `list_agents` tomorrow joins
 * this set for free, and one that is only ever reached from `activate_response`
 * stays out of it without anybody deciding to exclude it. Writing the exclusion
 * by name would have been a second copy of the read path's shape, which is the
 * drift `src/read-contract.ts` exists to remove.
 */
function readPathRowShapes(mod) {
  const rows = new Set();
  const blocksSeen = new Set();
  const visit = (table) => {
    for (const spec of Object.values(table ?? {})) {
      if (spec.rows && !rows.has(spec.rows)) {
        rows.add(spec.rows);
        visit(mod.ROW_SHAPES[spec.rows]);
      }
      if (spec.block && !blocksSeen.has(spec.block)) {
        blocksSeen.add(spec.block);
        visit(mod.BLOCK_SHAPES[spec.block]);
      }
    }
  };
  visit(mod.LIST_AGENTS_FIELDS);
  visit(mod.AGENT_STATUS_FIELDS);
  visit(mod.DAEMON_STATUS_CONTRACT_FIELDS);
  return rows;
}

/**
 * THE RECONCILIATION, as a pure function of (declaration, document text).
 *
 * Returns a list of problems, each a sentence naming the field and the
 * direction. §1 asserts it is empty against the real pair; §6b hands it a
 * mutated document and asserts the problem it expects is IN it, by name — which
 * is what makes §1 a check rather than a description.
 */
function reconcile(mod, docText) {
  const problems = [];
  const decls = declarationsOf(mod);
  const echoFields = Object.keys(mod.BLOCK_SHAPES.ConfigEcho);
  const tables = parseTables(docText, echoFields);

  for (const [name, fields] of tables) {
    if (fields === null) problems.push(`document: two tables claim to be ${name}`);
    else if (!decls.has(name)) problems.push(`document: table names ${name}, which is not declared`);
  }
  for (const name of decls.keys()) {
    if (!tables.has(name)) problems.push(`document: ${name} is declared and has no table`);
  }

  for (const [name, declared] of decls) {
    const documented = tables.get(name);
    if (!documented) continue;
    for (const field of Object.keys(declared)) {
      if (!(field in documented)) {
        problems.push(`${name}.${field}: declared, absent from the document`);
        continue;
      }
      const d = declared[field];
      const t = documented[field];
      if (d.bucket !== t.bucket) {
        problems.push(
          `${name}.${field}: declared '${d.bucket}', documented '${t.bucket}'`
        );
      }
      if (Boolean(d.optional) !== t.optional) {
        problems.push(
          `${name}.${field}: declared ${d.optional ? 'optional' : 'required'}, ` +
            `documented ${t.optional ? 'optional' : 'required'}`
        );
      }
    }
    for (const field of Object.keys(documented)) {
      if (!(field in declared)) {
        problems.push(`${name}.${field}: documented, not declared`);
      }
    }
  }

  // Referential integrity. A `rows:`/`block:` naming a shape that does not
  // exist would make every completeness check over that shape run against
  // nothing — the vacuous pass this whole file is shaped against.
  for (const [name, declared] of decls) {
    for (const [field, spec] of Object.entries(declared)) {
      if (spec.rows && !(spec.rows in mod.ROW_SHAPES)) {
        problems.push(`${name}.${field}: rows: '${spec.rows}' names no shape`);
      }
      if (spec.block && !(spec.block in mod.BLOCK_SHAPES)) {
        problems.push(`${name}.${field}: block: '${spec.block}' names no block`);
      }
    }
  }

  // The four branches, and the two things a branch table can get wrong.
  const docBranches = parseBranches(docText);
  if (!docBranches) problems.push('document: no contract-branches table');
  else {
    const declaredBranches = mod.AGENT_STATUS_BRANCHES;
    for (const b of Object.keys(declaredBranches)) {
      if (!(b in docBranches)) problems.push(`branch ${b}: declared, absent from the document`);
    }
    for (const b of Object.keys(docBranches)) {
      if (!(b in declaredBranches)) problems.push(`branch ${b}: documented, not declared`);
    }
    for (const [b, keys] of Object.entries(declaredBranches)) {
      const documented = docBranches[b];
      if (!documented) continue;
      const a = [...keys].sort().join(',');
      const c = [...documented].sort().join(',');
      if (a !== c) problems.push(`branch ${b}: key sets differ (declared ${a} / documented ${c})`);
      for (const k of keys) {
        if (!(k in mod.AGENT_STATUS_FIELDS)) {
          problems.push(`branch ${b}: key '${k}' is on no agent_status field table`);
        }
      }
    }
    // A field the union calls REQUIRED must be on every branch, or the word
    // means nothing on this response.
    for (const [field, spec] of Object.entries(mod.AGENT_STATUS_FIELDS)) {
      if (spec.optional) continue;
      for (const [b, keys] of Object.entries(declaredBranches)) {
        if (!keys.includes(field)) {
          problems.push(`agent_status.${field} is required and branch ${b} does not carry it`);
        }
      }
    }
  }

  // The eleven `activate_response` branches (KAN-287). Four things a two-list
  // branch table can get wrong that a one-list one cannot, and all four are
  // checked here rather than left to the wire — the wire can only ever show
  // what one call happened to answer.
  const docActivate = parseActivateBranches(docText);
  if (!docActivate) problems.push('document: no contract-activate-branches table');
  else {
    const declaredActivate = mod.ACTIVATE_RESPONSE_BRANCHES;
    for (const b of Object.keys(declaredActivate)) {
      if (!(b in docActivate)) {
        problems.push(`activate branch ${b}: declared, absent from the document`);
      }
    }
    for (const b of Object.keys(docActivate)) {
      if (!(b in declaredActivate)) {
        problems.push(`activate branch ${b}: documented, not declared`);
      }
    }
    for (const [b, spec] of Object.entries(declaredActivate)) {
      const documented = docActivate[b];
      if (!documented) continue;
      for (const list of ['always', 'sometimes']) {
        const a = [...spec[list]].sort().join(',');
        const c = [...documented[list]].sort().join(',');
        if (a !== c) {
          problems.push(
            `activate branch ${b}.${list}: key sets differ (declared ${a || '(none)'} / ` +
              `documented ${c || '(none)'})`
          );
        }
      }
      // Every key named must be a field of the response, or the branch table
      // is describing a field nothing else in the contract knows about.
      for (const k of [...spec.always, ...spec.sometimes]) {
        if (!(k in mod.ACTIVATE_RESPONSE_FIELDS)) {
          problems.push(`activate branch ${b}: key '${k}' is on no activate_response field table`);
        }
      }
      // A key in BOTH lists is a contradiction rather than a redundancy: it
      // says the field is guaranteed and conditional at once, and the wire
      // check below would then pass whatever the response did.
      for (const k of spec.always) {
        if (spec.sometimes.includes(k)) {
          problems.push(`activate branch ${b}: '${k}' is in both always and sometimes`);
        }
      }
    }
    // The same rule the union/branch pair obeys on `agent_status`: a field the
    // union calls REQUIRED must be guaranteed by every branch, or the word means
    // nothing on this response.
    for (const [field, spec] of Object.entries(mod.ACTIVATE_RESPONSE_FIELDS)) {
      if (spec.optional) continue;
      for (const [b, branch] of Object.entries(declaredActivate)) {
        if (!branch.always.includes(field)) {
          problems.push(
            `activate_response.${field} is required and branch ${b} does not always carry it`
          );
        }
      }
    }
    // And the converse, which is the one that would otherwise rot quietly: a
    // field NO branch mentions is declared for nothing. It cannot be caught on
    // the wire — no response carries it, so every key check passes.
    const named = new Set(
      Object.values(declaredActivate).flatMap((s) => [...s.always, ...s.sometimes])
    );
    for (const field of Object.keys(mod.ACTIVATE_RESPONSE_FIELDS)) {
      if (!named.has(field)) {
        problems.push(`activate_response.${field}: declared, and on no branch`);
      }
    }
  }

  // §10's BOUNDARY, in both directions and against the declarations (KAN-287,
  // hardened on review). Three separate failures are possible and all three are
  // checked, because the first draft of this section could lose a whole surface
  // in silence.
  const RESPONSE_DECLS = [
    'LIST_AGENTS_FIELDS',
    'LIST_AGENTS_REFUSAL_FIELDS',
    'AGENT_STATUS_FIELDS',
    'ACTIVATE_RESPONSE_FIELDS',
    'DAEMON_STATUS_CONTRACT_FIELDS'
  ];
  for (const [anchor, declared] of [
    ['covered', Object.keys(mod.COVERED_SURFACES)],
    ['uncovered', [...mod.UNCOVERED_SURFACES]],
    // KAN-329's third value. A surface published in a SIBLING contract is
    // neither covered here nor described by nothing, and both of the two
    // existing rows would have been a false statement about it.
    ['elsewhere', Object.keys(mod.CONTRACTED_ELSEWHERE ?? {})]
  ]) {
    const documented = parseBoundary(docText, anchor);
    if (!documented) {
      problems.push(`document: no contract-${anchor}-surfaces table`);
      continue;
    }
    for (const s of declared) {
      if (!documented.includes(s)) {
        problems.push(`boundary ${anchor}: '${s}' is declared and absent from §10's table`);
      }
    }
    for (const s of documented) {
      if (!declared.includes(s)) {
        problems.push(`boundary ${anchor}: §10's table lists '${s}', which is not declared`);
      }
    }
  }

  // THE THREE LISTS ARE PAIRWISE DISJOINT (KAN-329). Without this, a surface
  // could sit in two of them and each table would independently reconcile —
  // "covered here" and "covered elsewhere" are contradictory answers, and the
  // membership checks above compare each list to its own table and would see
  // nothing wrong.
  {
    const lists = {
      covered: Object.keys(mod.COVERED_SURFACES),
      uncovered: [...mod.UNCOVERED_SURFACES],
      elsewhere: Object.keys(mod.CONTRACTED_ELSEWHERE ?? {})
    };
    const names = Object.keys(lists);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        for (const s of lists[names[i]]) {
          if (lists[names[j]].includes(s)) {
            problems.push(
              `boundary: '${s}' is in both ${names[i]} and ${names[j]} — a surface has exactly one`
            );
          }
        }
      }
    }
  }

  // A SIBLING CONTRACT'S DOCUMENT AND PROOF MUST EXIST. A row that sends a
  // reader to another document is worth what the promise being checked is
  // worth: without this, deleting `docs/send-contract.md` leaves §10 pointing
  // at nothing and every membership check above still green.
  for (const [surface, where] of Object.entries(mod.CONTRACTED_ELSEWHERE ?? {})) {
    for (const [kind, rel] of [['document', where.document], ['proof', where.proof]]) {
      if (!rel) {
        problems.push(`boundary elsewhere: ${surface} names no ${kind}`);
        continue;
      }
      if (!fs.existsSync(path.join(repoRoot, rel))) {
        problems.push(`boundary elsewhere: ${surface}'s ${kind} '${rel}' is not a file that exists`);
      }
    }
  }

  // Every response-level declaration is claimed by exactly ONE covered surface,
  // and every declaration a surface names exists. This is the leg that makes
  // "add a response and forget §10" red rather than merely untidy — without it
  // the two lists could agree with each other while both ignoring a new surface.
  const claimed = new Map();
  for (const [surface, decls] of Object.entries(mod.COVERED_SURFACES)) {
    for (const d of decls) {
      if (!decls.length) continue;
      if (!(d in mod)) {
        problems.push(`boundary covered: ${surface} names declaration '${d}', which does not exist`);
      }
      if (claimed.has(d)) {
        problems.push(
          `boundary covered: declaration '${d}' is claimed by both ${claimed.get(d)} and ${surface}`
        );
      }
      claimed.set(d, surface);
    }
  }
  for (const d of RESPONSE_DECLS) {
    if (!claimed.has(d)) {
      problems.push(`boundary covered: declaration '${d}' is on no surface in §10 — a response the contract covers and the boundary does not mention`);
    }
  }

  // The closed vocabularies.
  const docValues = parseValueSets(docText);
  for (const [name, values] of Object.entries(mod.VALUE_SETS)) {
    const documented = docValues[name];
    if (!documented) {
      problems.push(`values ${name}: declared, absent from the document`);
      continue;
    }
    const a = [...values].sort().join(',');
    const c = [...documented].sort().join(',');
    if (a !== c) problems.push(`values ${name}: declared [${a}], documented [${c}]`);
  }
  for (const name of Object.keys(docValues)) {
    if (!(name in mod.VALUE_SETS)) problems.push(`values ${name}: documented, not declared`);
  }

  // THE REFUSAL-KIND RULE ITSELF, WHICH NOTHING HELD UNTIL NOW (KAN-376).
  //
  // §8 note 2 states a rule rather than a count: `refused` is on the PRE-FLIGHT
  // refusals, and the members of `activateRefused` are named after exactly those
  // branches. Three mechanisms already existed around it and none of them was
  // this one — the compiler binds the union to `VALUE_SETS`, the check above
  // binds `VALUE_SETS` to §9's table, and §2d asserts each branch's key set
  // against a real response. Every one of those can be satisfied while the rule
  // is false: add `'doctored'` to the union, to `VALUE_SETS` and to §9 and all
  // three stay green, because no branch has to carry it and nothing compares the
  // two sets.
  //
  // So this asserts the join: THE BRANCHES WHOSE `always` CARRIES `refused` ARE
  // EXACTLY THE MEMBERS OF `activateRefused`. A tenth branch that quietly gains
  // the field is red; a member published for a branch that does not carry it is
  // red. Static, because both sides are declarations — the WIRE half of the same
  // claim is §2d, and neither subsumes the other.
  //
  // `refusedBy` deliberately gets the SAME treatment with a different join: its
  // members name subsystems rather than branches, so the set is checked against
  // the branches carrying `refusedBy` by COUNT rather than by name — one member,
  // one branch. Naming them would encode `capacity`-the-branch and
  // `capacity`-the-subsystem as the same fact, which they are not.
  const branchesCarrying = (field) =>
    Object.entries(mod.ACTIVATE_RESPONSE_BRANCHES)
      .filter(([, spec]) => spec.always.includes(field))
      .map(([name]) => name)
      .sort();

  const carryRefused = branchesCarrying('refused');
  const declaredKinds = [...mod.VALUE_SETS.activateRefused].sort();
  if (carryRefused.join(',') !== declaredKinds.join(',')) {
    problems.push(
      `the refusal-kind rule (§8 note 2): branches carrying \`refused\` are ` +
        `[${carryRefused.join(',')}], activateRefused publishes [${declaredKinds.join(',')}] — ` +
        `these must be the same set, because the members are named after the branches`
    );
  }

  const carryRefusedBy = branchesCarrying('refusedBy');
  if (carryRefusedBy.length !== mod.VALUE_SETS.activateRefusedBy.length) {
    problems.push(
      `the refusal-kind rule (§8 note 2): ${carryRefusedBy.length} branch(es) carry ` +
        `\`refusedBy\` [${carryRefusedBy.join(',')}] but activateRefusedBy publishes ` +
        `${mod.VALUE_SETS.activateRefusedBy.length} member(s) ` +
        `[${mod.VALUE_SETS.activateRefusedBy.join(',')}]`
    );
  }

  // Every bucket named anywhere must be one of the four. A typo would
  // otherwise ride through every comparison above intact.
  for (const [name, fields] of tables) {
    if (!fields) continue;
    for (const [field, spec] of Object.entries(fields)) {
      if (!BUCKETS.includes(spec.bucket)) {
        problems.push(`${name}.${field}: documented bucket '${spec.bucket}' is not one of the four`);
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------- the scratch --

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan277-read-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// ------------------------------------------------------------------ the shim --
//
// One fake `herdr`, first on a PATH that otherwise holds only system dirs. Two
// things beyond the usual, and both are what make the fleet below complete:
//
//   - an INJECT list, so a pane can exist that no `agent start` created. That
//     is the only way to produce a FOREIGN pane (a name that is not the one our
//     path derives) and an UNBACKED one (our name, with no runtime behind it).
//   - a VANISHED list, so a pane can disappear without the daemon being told,
//     which is what an agent dying really looks like from here.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });

const injectedFile = path.join(shimState, 'injected.json');
const vanishedFile = path.join(shimState, 'vanished.json');
/**
 * KAN-287: a MODES file, so herdr can be made to fail one subcommand at a time
 * from underneath a running daemon.
 *
 * This is what produces the refusal branches of `activate_response` that are
 * otherwise unreachable: `unverifiable` needs `agent list` to fail, `spawn-error`
 * needs `agent start` to fail, and `confirm-failed` needs `agent start` to
 * SUCCEED and leave nothing behind — a shape no error can produce and only a
 * lying herdr can. Each is set immediately before the one call it is for and
 * cleared immediately after, so no other section runs against a broken herdr.
 */
const modesFile = path.join(shimState, 'modes.json');
fs.writeFileSync(injectedFile, JSON.stringify([]));
fs.writeFileSync(vanishedFile, JSON.stringify([]));
fs.writeFileSync(modesFile, JSON.stringify({}));

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN277_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const load = () => readJson(startedFile, []);
const save = (list) => fs.writeFileSync(startedFile, JSON.stringify(list, null, 2));
const injected = () => readJson(path.join(state, 'injected.json'), []);
const vanished = () => readJson(path.join(state, 'vanished.json'), []);
const modes = () => readJson(path.join(state, 'modes.json'), {});
const visible = () => [...load(), ...injected()].filter((s) => !vanished().includes(s.name));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const die = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
};
const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }
// KAN-287. Each mode fails ONE subcommand, and they are read per invocation so
// the harness can turn one on for the duration of a single call.
if (a === 'agent' && b === 'list' && modes().failList) {
  die('unavailable', 'herdr server is not answering (KAN-287 failList)');
}
if (a === 'agent' && b === 'start' && modes().failStart) {
  die('start_refused', 'refusing to start: no terminal available (KAN-287 failStart)');
}
if (a === 'agent' && b === 'attach' && modes().failAttach) {
  die('attach_refused', 'refusing to attach (KAN-287 failAttach)');
}
// THE LIAR. \`agent start\` reports success and records nothing, so the pane is
// absent from every later census — which is exactly the shape confirmActivation
// exists to catch and the only way to reach the \`confirm-failed\` branch.
if (a === 'agent' && b === 'start' && modes().startInvisible) {
  out({ result: { agent: { name: args[2], pane_id: '999' } } });
}
if (a === 'agent' && b === 'get') {
  const found = visible().find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane_id } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const started = load();
  const sep = args.indexOf('--');
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    pane_id: String(100 + started.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    agent: 'shell',
    command: sep === -1 ? [] : args.slice(sep + 1)
  });
  save(started);
  out({ result: { agent: { name: args[2], pane_id: started[started.length - 1].pane_id } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: visible().map((s) => {
    const row = { name: s.name, cwd: s.cwd, pane_id: s.pane_id, agent_status: s.agent_status ?? 'working' };
    // An UNBACKED pane is one herdr reports with no runtime behind it, which
    // is an ABSENT key rather than a null one — the same shape herdr really
    // sends. Setting it to null would be this shim inventing a third state.
    if (s.agent !== null && s.agent !== undefined) row.agent = s.agent;
    return row;
  }) } });
}
if (a === 'agent' && b === 'read') {
  const found = visible().find((s) => s.name === args[2]);
  if (!found) {
    process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
    process.exit(1);
  }
  out({ result: { read: { text: \`$ KAN-277 pane text for \${args[2]}\\n$\`, truncated: false } } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'pane' && b === 'close') {
  save(load().filter((s) => s.pane_id !== args[2]));
  out({ result: {} });
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else if (a !== 'agent') {
  out({ result: {} });
}
`);
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

let injectedPaneId = 900;
/** A pane no `agent start` created. `agent: null` means herdr reports no runtime. */
const injectPane = (name, cwd, agent) => {
  const all = JSON.parse(fs.readFileSync(injectedFile, 'utf8'));
  all.push({ name, cwd, agent, pane_id: String(injectedPaneId++), agent_status: 'working' });
  fs.writeFileSync(injectedFile, JSON.stringify(all, null, 2));
};
const vanish = (paneName) => {
  const all = JSON.parse(fs.readFileSync(vanishedFile, 'utf8'));
  all.push(paneName);
  fs.writeFileSync(vanishedFile, JSON.stringify(all));
};

/**
 * Run one call with herdr broken in one named way, and put it back afterwards
 * WHATEVER HAPPENS.
 *
 * The `finally` is not defensive tidiness: a mode left on leaks into every
 * later section through a shim file the daemon re-reads on each invocation, and
 * the failure it would produce — a green section followed by unrelated red ones
 * — is the kind that gets debugged in the wrong place.
 */
const withMode = async (mode, fn) => {
  fs.writeFileSync(modesFile, JSON.stringify({ [mode]: true }));
  try {
    return await fn();
  } finally {
    fs.writeFileSync(modesFile, JSON.stringify({}));
  }
};

const childEnv = {
  ...process.env,
  HOME: fakeHome,
  SHELL: '/bin/bash',
  PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
  KAN277_SHIM_STATE: shimState,
  CRABCAST_CONFIG: undefined
};

/** A directory the caller owns. CrabCast never creates one. */
function owned(name) {
  const dir = path.join(scratch, 'owned', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

const { socketPathFor } = await import(path.join(distDir, 'ipc.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));

// ------------------------------------------------------- mutated builds --

try {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}

const { mutate: mutatedBuild, mutationsSkipped } = makeMutator({
  distDir,
  scratch,
  report: {
    pass: (label, detail) => verdict(true, `${label}${detail ? ` — ${detail}` : ''}`, ''),
    fail: (label, detail) => verdict(false, '', `${label} — ${detail}`)
  }
});

// -------------------------------------------------------- daemons & clients --

const daemons = [];
const clients = [];
const openSockets = [];

function makeConfig(name) {
  const dataDir = path.join(scratch, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(scratch, `crabcast-${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
  return { name, dataDir, configPath };
}

async function startDaemon(cfg, dist, label, env = {}) {
  const errFile = path.join(cfg.dataDir, `spawn-${label}.err`);
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js'), cfg.configPath], {
    env: { ...childEnv, ...env },
    detached: true,
    stdio: ['ignore', 'ignore', errFd]
  });
  child.unref();
  fs.closeSync(errFd);
  const sock = socketPathFor(cfg.dataDir);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) break;
    await sleep(100);
  }
  if (!fs.existsSync(sock)) {
    throw new Error(
      `daemon ${label} never opened its socket. stderr:\n${fs.readFileSync(errFile, 'utf8')}`
    );
  }
  const client = await new SocketClient(cfg, `${label}-probe`).ready();
  const status = await client.request('daemon_status');
  client.close();
  daemons.push({ pid: status.pid, label });
  return status;
}

function stopDaemon(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/** A raw socket client: requests, and the broadcasts that arrive without an id. */
class SocketClient {
  constructor(cfg, label) {
    this.label = label;
    this.events = [];
    this.nextId = 0;
    this.pending = new Map();
    this.socket = net.connect(socketPathFor(cfg.dataDir));
    openSockets.push(this.socket);
    this.socket.on('error', () => {});
    let buf = '';
    this.socket.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.id === undefined) {
          this.events.push(msg);
        }
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve(this));
      this.socket.once('error', reject);
    });
  }
  request(action, data = {}) {
    const id = `${this.label}-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out on ${action}`));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      this.socket.write(JSON.stringify({ action, ...data, id }) + '\n');
    });
  }
  close() { try { this.socket.end(); } catch {} }
}

/** MCP over stdio is newline-delimited JSON-RPC 2.0. Hand-rolled on purpose. */
class McpClient {
  constructor(label, { dist = distDir, config, env = {} }) {
    this.label = label;
    this.child = spawn(process.execPath, [path.join(dist, 'mcp.js'), config], {
      env: { ...childEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    clients.push(this);
    this.nextId = 0;
    this.pending = new Map();
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${this.label}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
      }
    });
  }
  request(method, params = {}, timeoutMs = 40_000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async initialize() {
    let r;
    try {
      r = await this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: `verify-read-contract (${this.label})`, version: '0.0.0' }
      });
    } catch (err) {
      throw new Error(`${err.message}\n--- ${this.label} stderr ---\n${this.stderr}`);
    }
    this.notify('notifications/initialized');
    return r;
  }
  callTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  kill() { try { this.child.kill(); } catch {} }
}

const parsedText = (toolResult) => {
  const text = toolResult?.content?.find((c) => c.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { unparseable: text }; }
};

function cleanup() {
  for (const c of clients) c.kill();
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  for (const d of daemons) stopDaemon(d.pid);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
// A proof that cleans up only when it FINISHES is not a proof that cleans up.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

console.log(`dist under test: ${distDir}`);
console.log(`document:        ${CONTRACT_DOC}`);
console.log(`fake herdr:      ${path.join(shimDir, 'herdr')} (state ${shimState})`);
console.log(`scratch:         ${scratch}`);

const docText = fs.readFileSync(CONTRACT_DOC, 'utf8');

// ========================== 1. DOCUMENT ↔ DECLARATION, IN BOTH DIRECTIONS ====

rule('1. THE DOCUMENT AGAINST THE DECLARATION — every field, both directions');

{
  const decls = declarationsOf(contract);
  const tables = parseTables(docText, Object.keys(BLOCK_SHAPES.ConfigEcho));

  console.log(`   declarations: ${decls.size}`);
  for (const [name, table] of decls) {
    console.log(`     ${name.padEnd(34)} ${Object.keys(table).length} field(s)`);
  }
  console.log(`\n   tables found in the document: ${tables.size}`);

  // NON-VACUITY FIRST. A parser whose anchor syntax had drifted would find zero
  // tables, reconcile an empty map against the declaration, and report every
  // field as "declared, absent from the document" — which is loud. The
  // dangerous direction is the other one: a document that lost its anchors
  // while the declaration also emptied would agree perfectly about nothing. So
  // both sides are asserted non-trivial before they are compared.
  const totalDocumented = [...tables.values()]
    .filter(Boolean)
    .reduce((n, t) => n + Object.keys(t).length, 0);
  const totalDeclared = [...decls.values()].reduce((n, t) => n + Object.keys(t).length, 0);
  given(
    decls.size >= 12 && tables.size >= 12 && totalDeclared > 100 && totalDocumented > 100,
    'both sides are non-trivial, so the reconciliation below is not an agreement about nothing',
    `${decls.size} declarations / ${totalDeclared} declared fields, ` +
      `${tables.size} tables / ${totalDocumented} documented fields`
  );

  const problems = reconcile(contract, docText);
  if (problems.length) {
    console.log('\n   problems:');
    for (const p of problems) console.log(`     ! ${p}`);
  } else {
    console.log('\n   (no disagreement in either direction)');
  }

  const docBranches = parseBranches(docText);
  console.log(`\n   agent_status branches: ${Object.keys(AGENT_STATUS_BRANCHES).join(', ')}`);
  for (const [b, keys] of Object.entries(AGENT_STATUS_BRANCHES)) {
    console.log(`     ${b.padEnd(20)} ${keys.length} keys, document says ${docBranches?.[b]?.length ?? '(no row)'}`);
  }
  console.log(`\n   closed vocabularies: ${Object.keys(VALUE_SETS).length}`);
  for (const [name, values] of Object.entries(VALUE_SETS)) {
    console.log(`     ${name.padEnd(18)} ${values.join(' · ')}`);
  }

  verdict(
    problems.length === 0,
    'every documented field is declared and every declared field is documented, with the same\n' +
    '    bucket and the same optionality; every table names a declaration that exists and every\n' +
    '    declaration has exactly one table; the four branches, their key sets and the eight closed\n' +
    '    vocabularies agree — in both directions',
    `${problems.length} disagreement(s): ${problems.slice(0, 6).join('; ')}` +
      (problems.length > 6 ? ` … and ${problems.length - 6} more` : '')
  );
}

// `--static-only` STOPS HERE (KAN-376). §1 is the only section that needs no
// daemon, and a caller that wants exactly it — `scripts/kan376-red-drive.mjs`
// drives §1 four times over four mutated trees — would otherwise pay for a full
// fleet lifecycle each time and then have to attribute a red among every other
// section's assertions.
//
// ⚠ THE VERDICT THIS PRINTS IS ABOUT §1 AND NOTHING ELSE, and the line says so
// rather than leaving a reader to notice the sections are missing. A partial run
// reporting "ALL CHECKS PASSED" is precisely the artifact-claims-more-than-its-
// mechanism defect this proof exists to catch, so the wording is part of the flag.
if (process.argv.includes('--static-only')) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(
    failures === 0
      ? 'SECTION 1 PASSED — document ↔ declaration only. Sections 2-6 were NOT run.'
      : `${failures} CHECK(S) FAILED in section 1. Sections 2-6 were NOT run.`
  );
  console.log('='.repeat(78));
  process.exit(failures ? 1 : 0);
}

// ================ 2. THE DECLARATION AGAINST A REAL DAEMON'S RESPONSES ======

rule('2. A REAL DAEMON — every key on the wire is declared, and every declared key is on the wire');

const main = makeConfig('main');
const mainStatus = await startDaemon(main, distDir, 'main');
console.log(`   daemon: pid ${mainStatus.pid}, bootId ${mainStatus.bootId}, dataDir ${main.dataDir}`);
console.log(
  `   load average while this fleet was built: ` +
  `${fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ')} ` +
  `(reported, never asserted on — every activation below passes \`override\`)`
);

const mcp = new McpClient('mcp', { config: main.configPath });
await mcp.initialize();
const sock = await new SocketClient(main, 'sock').ready();

const call = async (tool, args) => parsedText(await mcp.callTool(tool, args));

// ---- the fleet: one row in every category, through real lifecycle calls ----
//
// EVERY ACTIVATION PASSES `override`, and that is a measured decision rather
// than a convenience. KAN-171 recorded a sibling proof going red about the
// LAPTOP: above a load average of ~2.25 the gate refused its activations, every
// row landed in `unstartedAgents`, and the script reported a statement about the
// machine in the words of a statement about the code. Pinning
// `CRABCAST_MAX_AGENTS` does not fix it — the cap is one of four terms, and
// load, CPU, memory and the stall veto each bind independently — so the fixture
// goes past the gate exactly as `verify-config-echo-contract`'s PAST_THE_GATE
// does. Nothing here is a claim about the gate.
const runner = owned('runner');
const standby = owned('standby');
const preempted = owned('preempted');
const unstarted = owned('unstarted');
const lost = owned('lost');
const unbacked = owned('unbacked');
const occupied = owned('occupied');

const steps = [];
const step = async (what, tool, args) => {
  const r = await call(tool, args);
  steps.push([what, r]);
  return r;
};
const socketStep = async (what, action, args) => {
  const { id, ...r } = await sock.request(action, args);
  steps.push([what, r]);
  return r;
};

// FIRST, so its stale-session window runs while the rest of the fixture does. A
// vanished pane does not make an agent `missing` immediately: this daemon keeps
// trusting a session it has just spawned until RUNTIME_CONFIRM_TIMEOUT_MS has
// passed, because a freshly spawned agent legitimately shows no runtime for a
// moment. The wait below is that window, observed rather than slept through.
await step('configure lost', 'crabcast_configure_agent', { path: lost, priority: 1, launcher: LAUNCHER });
await step('activate lost', 'crabcast_activate_agent', { path: lost, override: true });
vanish(paneNameFor(lost)); // the pane disappears without the daemon being told

await step('configure runner', 'crabcast_configure_agent', { path: runner, priority: 9, launcher: LAUNCHER });
await step('activate runner', 'crabcast_activate_agent', { path: runner, override: true });

await step('configure standby', 'crabcast_configure_agent', { path: standby, priority: 1, launcher: LAUNCHER });
await step('activate standby', 'crabcast_activate_agent', { path: standby, override: true });
await step('deactivate standby', 'crabcast_deactivate_agent', { path: standby });

// PREEMPTED: a stand-down carrying a preemption annotation, through the REAL
// `deactivate_agent` path — the same one the gate itself uses, because
// preemption reuses it rather than tearing an agent down its own way.
//
// THE ANNOTATION IS SUPPLIED BY THIS SCRIPT, AND HERE IS WHAT THAT LEAVES
// UNCOVERED. Producing one from the gate means filling the machine, and a full
// machine derived from the real cap is the load-dependence the paragraph above
// exists to remove — the stall veto in particular has no override by design
// (KAN-216), so there is no environment in which that route is deterministic.
// So this proves the SHAPE of a `preemptedAgents` row, on a record written by
// the real registry through the real stand-down. It does NOT prove that the
// capacity gate produces such a record; that is
// `verify-agent-preemption.mjs`'s, and nothing here substitutes for it.
await step('configure preempted', 'crabcast_configure_agent', { path: preempted, priority: 1, launcher: LAUNCHER });
await step('activate preempted', 'crabcast_activate_agent', { path: preempted, override: true });
await socketStep('deactivate preempted (with annotation)', 'deactivate_agent', {
  path: preempted,
  preemption: {
    byPath: runner,
    byPaneName: paneNameFor(runner),
    byPriority: 9,
    priority: 1,
    herdrStatus: 'working',
    derivation: 'cap: 1 charged agent; running 1; headroom 0 (bound by cap)'
  }
});

await step('configure unstarted', 'crabcast_configure_agent', { path: unstarted, priority: 1, launcher: LAUNCHER, label: 'never run' });

// UNBACKED: a registered path whose derived pane name is in the census with NO
// runtime behind it. Only a runtime-bearing launcher can have one — for
// `shell`, an empty pane is the delivered product and `ourPaneIn` claims it.
await step('configure unbacked (claude)', 'crabcast_configure_agent', { path: unbacked, priority: 1, launcher: RUNTIME_LAUNCHER });
injectPane(paneNameFor(unbacked), unbacked, null);

// FOREIGN: a live pane whose name is NOT the one our path derives, sitting in a
// directory we hold a record for — which is what makes `occupies` and
// `occupiedAgent` non-null, and what an `activate` there would be refused by.
await step('configure occupied', 'crabcast_configure_agent', { path: occupied, priority: 1, launcher: LAUNCHER });
injectPane('somebody-elses-pane', occupied, 'claude');

const why = (r) => String(r?.error ?? JSON.stringify(r)).split('\n')[0].slice(0, 160);
const refused = steps.filter(([, r]) => r?.success !== true);
for (const [what, r] of refused) console.log(`   ${what} → REFUSED: ${why(r)}`);
given(
  refused.length === 0,
  'every lifecycle call the fixture makes succeeded, so the categories below are what the ' +
    'daemon produced rather than what the machine refused',
  refused.length === 0
    ? `${steps.length} calls`
    : `${refused.length} of ${steps.length} refused — ${refused.map(([w]) => w).join(', ')}`
);

// OBSERVED, NOT SLEPT THROUGH. `RUNTIME_CONFIRM_TIMEOUT_MS` is a constant in the
// daemon and a hardcoded sleep here would couple this script to it — the exact
// coupling `verify-event-contract` had to remove when a slower daemon made its
// timing assumption false. So the transition is waited FOR.
const lostAppeared = await waitFor(
  async () => {
    const l = await call('crabcast_list_agents');
    return (l.missingAgents ?? []).some((m) => m.path === lost);
  },
  60_000,
  `${path.basename(lost)} to be reported missing (its session has to age past the ` +
    `runtime-confirm window before a vanished pane counts as a loss)`
);
console.log(`   ${path.basename(lost)} reported missing: ${lostAppeared}`);

const listed = await call('crabcast_list_agents');

// ---- 2a. list_agents ----

/**
 * Compare one object's keys against a declared field table, both ways.
 *
 * `optional` is one-directional by design: a declared-optional field that is
 * absent is fine, and one that is PRESENT must still be declared. An undeclared
 * key is always a problem, whichever direction it came from.
 */
function keyProblems(where, obj, declared) {
  const problems = [];
  for (const key of Object.keys(obj)) {
    if (!(key in declared)) problems.push(`${where}.${key} is on the wire and not declared`);
  }
  for (const [key, spec] of Object.entries(declared)) {
    if (!(key in obj) && !spec.optional) {
      problems.push(`${where}.${key} is declared non-optional and absent from the wire`);
    }
  }
  return problems;
}

{
  const categories = {
    agents: 'ListedAgent',
    unbackedPanes: 'UnbackedPane',
    missingAgents: 'MissingAgent',
    preemptedAgents: 'PreemptedAgent',
    standbyAgents: 'StandbyAgent',
    unstartedAgents: 'UnstartedAgent',
    foreignPanes: 'ForeignPane',
    priorities: 'PriorityRow'
  };
  console.log('\n   the fleet this response describes:');
  for (const [name] of Object.entries(categories)) {
    console.log(`     ${name.padEnd(18)} ${(listed[name] ?? []).length} row(s)`);
  }

  // EVERY CATEGORY NON-EMPTY, or the row checks below pass over nothing.
  for (const [name] of Object.entries(categories)) {
    given(
      Array.isArray(listed[name]) && listed[name].length > 0,
      `${name} has at least one row, so asserting on its shape is not vacuous`,
      `${(listed[name] ?? []).length} row(s)`
    );
  }

  const problems = keyProblems('list_agents', listed, LIST_AGENTS_FIELDS);

  for (const [name, shape] of Object.entries(categories)) {
    (listed[name] ?? []).forEach((row, i) => {
      problems.push(...keyProblems(`${name}[${i}]`, row, ROW_SHAPES[shape]));
    });
  }

  // The nested blocks, each read off the response rather than assumed.
  for (const [name, block] of [
    ['provenance', 'Provenance'],
    ['capacity', 'Capacity'],
    ['configEchoContract', 'ConfigEchoContract']
  ]) {
    problems.push(...keyProblems(name, listed[name] ?? {}, BLOCK_SHAPES[block]));
  }
  for (const [category, page] of Object.entries(listed.pages ?? {})) {
    problems.push(...keyProblems(`pages.${category}`, page, BLOCK_SHAPES.FleetPage));
  }
  (listed.preemptedAgents ?? []).forEach((row, i) => {
    problems.push(...keyProblems(`preemptedAgents[${i}].by`, row.by ?? {}, BLOCK_SHAPES.PreemptedBy));
  });

  // `occupiedAgent` is nullable, and a null one would make the check below pass
  // over nothing — so the non-null case is asserted to exist rather than hoped
  // for. It is the whole reason the fixture injects a pane into an OCCUPIED
  // directory rather than an empty one.
  const withOccupied = (listed.foreignPanes ?? []).filter((f) => f.occupiedAgent);
  given(
    withOccupied.length > 0,
    'at least one foreign pane occupies a directory we hold a record for, so occupiedAgent is a ' +
      'block rather than a null',
    `${withOccupied.length} of ${(listed.foreignPanes ?? []).length}`
  );
  withOccupied.forEach((row, i) => {
    problems.push(
      ...keyProblems(`foreignPanes[${i}].occupiedAgent`, row.occupiedAgent, BLOCK_SHAPES.OccupiedAgent)
    );
  });

  // `herdrHealth` is declared OPTIONAL and its absence is legitimate — there is
  // no herdr server process on a shimmed runner to read descriptors from. Which
  // of the two happened is REPORTED rather than asserted, because a verdict
  // either way would be about the machine.
  if (listed.herdrHealth) {
    problems.push(...keyProblems('herdrHealth', listed.herdrHealth, BLOCK_SHAPES.HerdrHealth));
    console.log('\n   herdrHealth: PRESENT on this response, and checked field by field');
  } else {
    console.log(
      '\n   herdrHealth: ABSENT on this response — legitimate (no herdr server process to read\n' +
      '     descriptors from behind the shim), declared optional, and therefore NOT checked here.\n' +
      '     Its field set is held by §1 against the declaration and by nothing on the wire.'
    );
  }

  show('list_agents keys:', Object.keys(listed).sort());
  show('one agents[] row:', listed.agents?.[0]);
  show('one preemptedAgents[] row:', listed.preemptedAgents?.[0]);
  show('one foreignPanes[] row:', listed.foreignPanes?.[0]);
  show('one unbackedPanes[] row:', listed.unbackedPanes?.[0]);
  show('pages:', listed.pages);
  if (problems.length) {
    console.log('\n   problems:');
    for (const p of problems) console.log(`     ! ${p}`);
  }

  verdict(
    problems.length === 0,
    'every key of a real `list_agents` response — the top level, all eight row categories, and\n' +
    '    every nested block — is declared by the contract, and every non-optional declared field\n' +
    '    is on the wire',
    `${problems.length} problem(s): ${problems.slice(0, 8).join('; ')}`
  );
}

// ---- 2b. the refused list_agents ----

{
  const refusal = await sock.request('list_agents', {
    pages: { standbyAgents: { after: 'not-a-cursor-anybody-issued' } }
  });
  const { id, ...body } = refusal;
  show('a refused list_agents (invented cursor):', body);

  const keys = Object.keys(body).sort();
  const declaredKeys = Object.keys(LIST_AGENTS_REFUSAL_FIELDS).sort();
  const exact = JSON.stringify(keys) === JSON.stringify(declaredKeys);

  console.log(`   on the wire: ${keys.join(', ')}`);
  console.log(`   declared:    ${declaredKeys.join(', ')}`);
  // THE FIELD THIS ASSERTION EXISTS FOR SINCE KAN-279 (v9). A refused
  // `list_agents` used to carry three fields and no block, where every
  // `agent_status` refusal carried one — including `bad-address`, which
  // resolves nothing and carries no echo. Both directions of that are held by
  // the exact key-set comparison below: the router moving without the
  // declaration reads [action,configEchoContract,error,success] against three
  // declared, and the declaration moving without the router reads the reverse.
  const sweptOnRefusal = 'configEchoContract' in body;
  console.log(
    `   carries configEchoContract: ${sweptOnRefusal} ` +
    `(v9 — the sweep rides refusals on BOTH read surfaces; KAN-279)`
  );
  console.log(
    `   its undeclared[]: ${JSON.stringify(body.configEchoContract?.undeclared)} ` +
    `— always empty here, because a refusal carries no rows to sweep. That is the block\n` +
    `     saying the sweep RAN, which is the distinction an absent block cannot make`
  );

  verdict(
    body.success === false && typeof body.error === 'string' && exact && sweptOnRefusal,
    'a refused `list_agents` carries EXACTLY the four fields the contract declares for it,\n' +
    '    `configEchoContract` among them — so the block rides every response on BOTH read\n' +
    '    surfaces rather than on one and a half, and a change to that cannot be silent',
    `success=${body.success}, configEchoContract present=${sweptOnRefusal}, ` +
    `keys on the wire [${keys}] against declared [${declaredKeys}]`
  );
}

// ---- 2c. agent_status, all four branches ----

{
  const branchResponses = {
    // Live session: this daemon spawned it and holds the attach.
    'live-session': await call('crabcast_agent_status', { path: runner }),
    // Sessionless: configured and stopped, so no session of ours describes it.
    sessionless: await call('crabcast_agent_status', { path: standby }),
    // Neither a record nor a pane.
    'no-record-no-pane': await call('crabcast_agent_status', { path: owned('never-an-agent') }),
    // The address itself refused, before anything was looked up.
    // OVER THE RAW SOCKET, and it has to be. The MCP tool resolves its `path`
    // argument against the calling process's cwd before it sends anything, so a
    // relative path reaches the daemon already absolute and lands on the
    // no-record-no-pane branch instead. This branch is the daemon's own address
    // refusal, and the socket is the only surface that can produce it.
    'bad-address': await (async () => {
      const { id, ...body } = await sock.request('agent_status', { path: 'a/relative/path' });
      return body;
    })()
  };

  const problems = [];
  for (const [branch, res] of Object.entries(branchResponses)) {
    show(`agent_status · ${branch}:`, res);
    const declared = [...AGENT_STATUS_BRANCHES[branch]].sort();
    const actual = Object.keys(res).sort();
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      problems.push(
        `${branch}: declared [${declared.join(' ')}] against the wire [${actual.join(' ')}]`
      );
    }
    problems.push(...keyProblems(`agent_status(${branch})`, res, AGENT_STATUS_FIELDS));
    for (const [name, block] of [['provenance', 'Provenance'], ['configEchoContract', 'ConfigEchoContract']]) {
      if (res[name]) problems.push(...keyProblems(`${branch}.${name}`, res[name], BLOCK_SHAPES[block]));
    }
  }

  // The branches must be TOLD APART by what the document says tells them apart,
  // or "which branch am I holding" is not answerable by a consumer.
  const b = branchResponses;
  const distinguishable =
    b['live-session'].success === true && b['live-session'].sessionless === false &&
    b.sessionless.success === true && b.sessionless.sessionless === true &&
    b['no-record-no-pane'].success === false && b['no-record-no-pane'].configured === false &&
    b['bad-address'].success === false && !('configured' in b['bad-address']);
  console.log(`\n   the four are distinguishable by success/sessionless/configured: ${distinguishable}`);

  if (problems.length) {
    console.log('\n   problems:');
    for (const p of problems) console.log(`     ! ${p}`);
  }

  verdict(
    problems.length === 0 && distinguishable,
    'all four `agent_status` branches were PRODUCED on a real daemon and each carries EXACTLY the\n' +
    '    keys the contract declares for it — refusals included, and the block rides every one of\n' +
    '    them — and a consumer can tell which branch it is holding from the fields the document\n' +
    '    names',
    problems.length
      ? `${problems.length} problem(s): ${problems.slice(0, 6).join('; ')}`
      : 'the four branches are not distinguishable by the fields the document says distinguish them'
  );
}

// ---- 2d. activate_response, every branch that can be produced (KAN-287) ----
//
// ELEVEN BRANCHES, TEN OF THEM DRIVEN HERE. Each is produced by making the
// daemon meet the condition rather than by constructing a response — a refusal
// this script assembled itself would assert only that this script can type.
//
// THE ONE THAT IS NOT PRODUCED IS `attach-error`, AND IT IS REPORTED RATHER
// THAN SKIPPED. It needs `pty.spawn` to throw in the PARENT process: the branch
// exists because `attachPty` catches that and records it as a `spawnError`
// (src/herdr.ts, the KAN-23 second false success). A herdr that refuses `agent
// attach` does not reach it — node-pty forks successfully and the CHILD exits,
// so nothing throws where the catch is. Everything this harness can do to herdr
// is done to the child. What holds that branch is therefore §1 alone: its key
// set is reconciled between the document and the declaration, and NOTHING here
// asserts it against the wire. That is weaker than the other ten and it is said
// out loud, because a reader counting eleven branches in the document would
// otherwise assume eleven were exercised.
{
  const spawned = owned('act-spawned');
  const refusedNotConfigured = owned('act-never-configured');
  const spawnFails = owned('act-spawn-fails');
  const confirmFails = owned('act-confirm-fails');

  // OVER THE RAW SOCKET, for the same reason §2c's `bad-address` is: the MCP
  // tool resolves `path` against the calling process's cwd before it sends
  // anything, and it validates the flags — so neither the address refusal nor
  // the bad-flag refusal can be produced through it. The socket is the daemon's
  // own surface and the only one that reaches those branches.
  const activate = async (args) => {
    const { id, ...body } = await sock.request('activate_agent', args);
    return body;
  };

  await call('crabcast_configure_agent', { path: spawned, priority: 5, launcher: LAUNCHER });
  await call('crabcast_configure_agent', { path: spawnFails, priority: 5, launcher: LAUNCHER });
  await call('crabcast_configure_agent', { path: confirmFails, priority: 5, launcher: LAUNCHER });

  // THE CAPACITY REFUSAL GETS ITS OWN DAEMON, and this is the one place in this
  // file that goes THROUGH the gate rather than past it. `CRABCAST_MAX_AGENTS=0`
  // sets the cap outright and skips the derivation (`src/capacity.ts` documents
  // zero as legitimate: "run no charged agents"), so the refusal is deterministic
  // on any machine — which is what the fixture's own PAST_THE_GATE note says is
  // otherwise unavailable. The agent is left `refusable` and no `override` is
  // passed, because both are what make the gate answer at all.
  const gateCfg = makeConfig('capacity-gate');
  await startDaemon(gateCfg, distDir, 'capacity-gate', { CRABCAST_MAX_AGENTS: '0' });
  const gateSock = await new SocketClient(gateCfg, 'capacity-gate').ready();
  const gated = owned('act-capacity');
  await gateSock.request('configure_agent', {
    path: gated, priority: 1, launcher: LAUNCHER, refusable: true
  });

  const produced = {};
  produced.spawned = await activate({ path: spawned, override: true });
  produced['already-running'] = await activate({ path: spawned, override: true });
  produced['bad-address'] = await activate({ path: 'a/relative/path' });
  produced['bad-flag'] = await activate({ path: spawned, override: 'yes' });
  produced['not-configured'] = await activate({ path: refusedNotConfigured });
  produced.occupied = await activate({ path: occupied, override: true });
  produced.unverifiable = await withMode('failList', () =>
    activate({ path: spawnFails, override: true })
  );
  produced['spawn-error'] = await withMode('failStart', () =>
    activate({ path: spawnFails, override: true })
  );
  produced['confirm-failed'] = await withMode('startInvisible', () =>
    activate({ path: confirmFails, override: true })
  );
  produced.capacity = await (async () => {
    const { id, ...body } = await gateSock.request('activate_agent', { path: gated });
    return body;
  })();

  const problems = [];
  const missing = [];

  for (const [branch, spec] of Object.entries(ACTIVATE_RESPONSE_BRANCHES)) {
    const res = produced[branch];
    if (!res) {
      missing.push(branch);
      continue;
    }
    show(`activate_response · ${branch}:`, res);

    // `always` IS AN EQUALITY — every one of these keys, and no other key that
    // is not on the `sometimes` list.
    const keys = Object.keys(res);
    const absent = spec.always.filter((k) => !keys.includes(k));
    const permitted = new Set([...spec.always, ...spec.sometimes]);
    const unexpected = keys.filter((k) => !permitted.has(k));
    if (absent.length) {
      problems.push(`${branch}: declared always and absent from the wire — ${absent.join(' ')}`);
    }
    if (unexpected.length) {
      problems.push(
        `${branch}: on the wire and on neither list for this branch — ${unexpected.join(' ')}`
      );
    }
    // And the union, which catches a key that is legal on SOME branch appearing
    // on one the table does not list it for.
    problems.push(...keyProblems(`activate(${branch})`, res, ACTIVATE_RESPONSE_FIELDS));

    // The nested shapes, each read off the response rather than assumed.
    for (const [field, shape] of [['occupiedBy', 'PaneOccupant'], ['provisioned', 'ProvisionedArtifact']]) {
      (res[field] ?? []).forEach((row, i) => {
        problems.push(...keyProblems(`${branch}.${field}[${i}]`, row, ROW_SHAPES[shape]));
      });
    }
    for (const [field, block] of [
      ['capacity', 'Capacity'],
      ['preemption', 'PreemptionOffer'],
      ['preempted', 'Preempted'],
      ['capacityOverride', 'CapacityOverride']
    ]) {
      if (res[field]) problems.push(...keyProblems(`${branch}.${field}`, res[field], BLOCK_SHAPES[block]));
    }
  }

  // THE VALUES OF THE TWO NEW VOCABULARIES, on the wire rather than only in the
  // document. A published member list that no response is checked against is a
  // list of guesses.
  for (const [branch, field, set] of [
    ['not-configured', 'refused', 'activateRefused'],
    ['unverifiable', 'refused', 'activateRefused'],
    ['occupied', 'refused', 'activateRefused'],
    ['capacity', 'refusedBy', 'activateRefusedBy']
  ]) {
    const value = produced[branch]?.[field];
    if (value !== undefined && !VALUE_SETS[set].includes(value)) {
      problems.push(`${branch}.${field} is '${value}', which ${set} does not publish`);
    }
  }

  // THE TWO CLAIMS THE BRANCH TABLE MAKES THAT A KEY SET CANNOT: `started` on
  // every branch, and `alreadyRunning` never `false` ON A REFUSAL.
  //
  // THE SECOND ONE IS SCOPED, AND THE FIRST DRAFT OF IT WAS NOT — it asserted
  // "never `false` anywhere" and went red against a correct daemon on the
  // `spawned` branch, where `false` is not merely allowed but is the whole
  // content of the field: this call started the agent. The rule being encoded is
  // the one the compiler holds in `ActivateRefusalFields` (`alreadyRunning?:
  // true`), and it has always been about refusals. The over-broad version would
  // have made a correct response look like a defect, which is the failure mode
  // an over-strong assertion has instead of missing one.
  const startedEverywhere = Object.entries(produced).filter(([, r]) => !('started' in r));
  const falseAlreadyRunning = Object.entries(produced).filter(
    ([, r]) => r.success === false && r.alreadyRunning === false
  );
  if (startedEverywhere.length) {
    problems.push(
      `started is declared on every branch and is absent from — ` +
        `${startedEverywhere.map(([b]) => b).join(' ')}`
    );
  }
  if (falseAlreadyRunning.length) {
    problems.push(
      `alreadyRunning is never false on a REFUSAL and reads false on — ` +
        `${falseAlreadyRunning.map(([b]) => b).join(' ')}`
    );
  }

  console.log(`\n   branches produced on a real daemon: ${Object.keys(produced).length} of ` +
    `${Object.keys(ACTIVATE_RESPONSE_BRANCHES).length}`);
  if (missing.length) {
    console.log(
      `   NOT PRODUCED, and held by §1 alone: ${missing.join(', ')} — see this section's header\n` +
      `     for why, and docs/read-path-contract.md §8 for the same statement to a consumer.`
    );
  }
  console.log(`   \`started\` present on all ${Object.keys(produced).length}: ${startedEverywhere.length === 0}`);
  console.log(
    `   \`alreadyRunning\` never false on a refusal: ${falseAlreadyRunning.length === 0} ` +
    `(false on \`spawned\` is correct and is the field's whole content there: ` +
    `${produced.spawned?.alreadyRunning === false})`
  );
  if (problems.length) {
    console.log('\n   problems:');
    for (const p of problems) console.log(`     ! ${p}`);
  }

  // THE PRECONDITION, SEPARATE FROM THE VERDICT. A branch that silently stopped
  // being produced would leave the checks above passing over what remained and
  // reporting a completeness that was not achieved — the vacuous pass this whole
  // file is shaped against.
  //
  // WRITTEN AS "WHICH ONE IS MISSING" RATHER THAN "HOW MANY" (the KAN-263 lesson
  // about literal anchors, one instrument over). A count of 10 goes red the day
  // somebody makes `attach-error` producible, which is coverage IMPROVING — and
  // a check that fails on improvement is a check people learn to edit rather
  // than read. Naming the exception passes when the hole is closed and fails
  // when a different one opens.
  const unexpectedlyMissing = missing.filter((b) => b !== 'attach-error');
  given(
    unexpectedlyMissing.length === 0,
    'every branch except `attach-error` was produced by a real daemon meeting a real condition, ' +
      'so the assertions above are about responses rather than about fixtures',
    `${Object.keys(produced).length} produced; unexpectedly absent: ${unexpectedlyMissing.join(', ')}`
  );

  verdict(
    problems.length === 0,
    'every `activate_response` branch this harness can produce carries EXACTLY the keys its\n' +
    '    `always` list declares, carries nothing outside `always` + `sometimes`, classifies every\n' +
    '    nested row and block by the contract, and answers only published members of the two new\n' +
    '    vocabularies — with `started` on every branch and `alreadyRunning` never `false` on a\n' +
    '    REFUSAL (it is `false` on `spawned`, where that is the whole content of the field)',
    `${problems.length} problem(s): ${problems.slice(0, 8).join('; ')}`
  );

  gateSock.close();
}

// ============================ 3. THE VERSION, IN EXACTLY ONE PLACE ==========

rule('3. THE VERSION — one integer, one place on the wire, and a digest that notices a change');

{
  const status = await sock.request('daemon_status');
  const viaMcp = await call('crabcast_daemon_status');
  const versions = parseVersions(docText);
  const current = versions?.find((v) => v.version === READ_CONTRACT_VERSION);
  const digest = digestOf(readContractCanonical());

  console.log(`   declared READ_CONTRACT_VERSION : ${READ_CONTRACT_VERSION}`);
  console.log(`   daemon_status (socket)         : ${status.contractVersion}`);
  console.log(`   daemon_status (MCP)            : ${viaMcp.contractVersion}`);
  console.log(`   document version table rows    : ${versions?.map((v) => v.version).join(', ')}`);
  console.log(`   digest of the declaration      : ${digest}`);
  console.log(`   digest recorded for v${READ_CONTRACT_VERSION}          : ${current?.digest ?? '(no row)'}`);

  // ONE PLACE, MEASURED. "It is only on daemon_status" is the claim, and the
  // only way to check a claim about absence is to look at the responses it is
  // absent from.
  const capacity = await call('crabcast_capacity');
  const statusRes = await call('crabcast_agent_status', { path: runner });
  const versionish = (obj) =>
    Object.keys(obj).filter((k) => /^(contractVersion|readContractVersion|contract)$/.test(k));
  const strays = [
    ['list_agents', versionish(listed)],
    ['agent_status', versionish(statusRes)],
    ['capacity', versionish(capacity)]
  ].filter(([, keys]) => keys.length > 0);
  console.log(
    `   other responses carrying a version field: ` +
    `${strays.length ? strays.map(([r, k]) => `${r}(${k})`).join(', ') : '(none)'}`
  );

  // The declaration's own table must name it too, so the contract says where
  // its version lives rather than only the code doing it.
  const declaresTheField = 'contractVersion' in DAEMON_STATUS_CONTRACT_FIELDS;

  verdict(
    status.contractVersion === READ_CONTRACT_VERSION &&
      viaMcp.contractVersion === READ_CONTRACT_VERSION &&
      Number.isInteger(READ_CONTRACT_VERSION) &&
      declaresTheField &&
      Boolean(current) && current.digest === digest &&
      strays.length === 0,
    'the version is one integer, identical in the declaration, on the socket and over MCP; the\n' +
    '    document\'s version table has a row for it whose digest matches the declaration; and no\n' +
    '    other read response carries a version field, so "exactly one place" is measured',
    `declared=${READ_CONTRACT_VERSION} socket=${status.contractVersion} mcp=${viaMcp.contractVersion} ` +
    `declaresTheField=${declaresTheField} row=${current ? `digest ${current.digest}` : 'MISSING'} ` +
    `computed=${digest} strays=${JSON.stringify(strays)}`
  );
}

// ================ 4. THE DOCUMENT'S BUCKETS AGAINST THE LIVE LEGEND =========

rule('4. THE BUCKETS — the document against the legend the daemon actually publishes');

// THE ONE JOIN NEITHER SIDE OWNS, and the reason this proof does not duplicate
// `verify-state-read-echoes-config.mjs` §7. That section asserts the legend
// CLASSIFIES every row key and that each bucket demonstrates the property it
// claims. This asserts the DOCUMENT says the same thing the legend does. Two
// honest mechanisms with a gap between them is where this epic keeps finding
// defects; this section is that gap, closed.
{
  const legend = listed.provenance;
  const byField = new Map();
  for (const bucket of BUCKETS) {
    for (const field of legend?.[bucket] ?? []) byField.set(field, bucket);
  }
  given(
    byField.size > 15,
    'the live legend classifies a non-trivial number of fields, so comparing against it is not ' +
      'comparing against an empty map',
    `${byField.size} field(s) classified`
  );

  // Only ROW fields: the legend is about rows, and this document says so. The
  // response-level buckets are this contract's own and are checked against the
  // declaration in §1 and against nothing else — which is stated in the
  // document under §3 rather than left to be discovered.
  //
  // AND ONLY THE ROWS THE READ RESPONSES CARRY (KAN-287). `activate_response`
  // publishes no `provenance` block, so its two row shapes have no legend to be
  // joined against and asserting over them here would fail for the RIGHT reason
  // in the WRONG place — reporting "the legend does not classify `artifact`"
  // about a legend that was never asked to. Their buckets are held by §1, and
  // both the document (§8) and this file's header say that is weaker.
  const readPathRows = readPathRowShapes(contract);
  const rowFields = new Map();
  for (const [shape, table] of Object.entries(ROW_SHAPES)) {
    if (!readPathRows.has(shape)) continue;
    for (const [field, spec] of Object.entries(table)) {
      rowFields.set(field, { bucket: spec.bucket, shape });
    }
  }

  const problems = [];
  for (const [field, { bucket, shape }] of rowFields) {
    const live = byField.get(field);
    if (!live) {
      problems.push(`${field} (${shape}) is a declared row field the live legend does not classify`);
    } else if (live !== bucket) {
      problems.push(`${field} (${shape}): contract says '${bucket}', the legend says '${live}'`);
    }
  }
  for (const [field, bucket] of byField) {
    if (!rowFields.has(field)) {
      problems.push(`${field}: the legend classifies it '${bucket}' and no row shape declares it`);
    }
  }

  console.log(`   row shapes the read responses carry: ${[...readPathRows].sort().join(', ')}`);
  console.log(
    `   row shapes excluded (activate_response only, no legend to join): ` +
    `${Object.keys(ROW_SHAPES).filter((s) => !readPathRows.has(s)).sort().join(', ') || '(none)'}`
  );
  console.log(`   row fields declared by the contract: ${rowFields.size}`);
  console.log(`   fields classified by the live legend: ${byField.size}`);
  console.log(`   remembered, on the wire: ${JSON.stringify(legend?.remembered)}`);
  if (problems.length) {
    console.log('\n   problems:');
    for (const p of problems) console.log(`     ! ${p}`);
  }

  verdict(
    problems.length === 0,
    'every row field the contract documents is in the same bucket the daemon\'s own `provenance`\n' +
    '    legend puts it in, and the legend classifies nothing the contract does not document —\n' +
    '    both directions, against a legend read off a real response',
    `${problems.length} disagreement(s): ${problems.slice(0, 6).join('; ')}`
  );
}

// ===================== 5. THE STABILITY STATEMENT, VERBATIM =================

rule('5. THE STABILITY STATEMENT — the promise, and all four of the things it does NOT promise');

// A PRESENCE CHECK, and it says so. It makes DELETION loud, which is how this
// text is actually at risk — the same standard `verify-event-contract` §1 sets
// for §3's `statusSince` bullets, and with the same limit: an edit that keeps
// these sentences and adds a contradicting one elsewhere passes here.
{
  const CLAIMS = [
    ['the promise, verbatim',
      /\*\*Any change to a field documented in the read-path contract gets a consumer\s*\n?>?\s*notice before or with the merge that changes it, naming the field, the old and\s*\n?>?\s*new behaviour, and what a caller should do\.\*\*/],
    ['below 1.0 we do not promise a field will not change',
      /Below 1\.0 we do not promise a\s*\n?>?\s*field will not change\./],
    ['you will not find out by breaking',
      /We promise you will not find out by breaking\./],
    ['NOT that fields will not change', /\*\*Not that fields will not change\.\*\*/],
    ['NOT that a change will be backward compatible',
      /\*\*Not that a change will be backward compatible\.\*\*/],
    ['NOT a deprecation period', /\*\*Not a deprecation period\.\*\*/],
    ['NOT that the notice arrives before you have already pulled',
      /\*\*Not that the notice arrives before you have already pulled\.\*\*/],
    ['pinning is still the consumer\'s own safety mechanism',
      /\*\*A consumer pinning to a commit is still the consumer's own safety mechanism\.\*\*/],
    ['and it says there is no compatibility guarantee below 1.0',
      /\*\*There is no compatibility guarantee below 1\.0\.\*\*/]
  ];
  const missing = CLAIMS.filter(([, re]) => !re.test(docText));
  for (const [what, re] of CLAIMS) console.log(`     ${re.test(docText) ? '·' : '!'} ${what}`);

  verdict(
    missing.length === 0,
    'the stability statement is in the document verbatim — the promise, its two qualifying\n' +
    '    sentences, and all four of the things it explicitly does not promise. A PRESENCE check:\n' +
    '    it makes deletion loud and claims nothing about a contradiction added elsewhere',
    `${missing.length} missing: ${missing.map(([w]) => w).join('; ')}`
  );
}

// ============================== 6. THE RED HALF ============================

rule('6. THE RED HALF — the checks above, watched failing');

// A PROOF THAT HAS ONLY EVER PASSED IS EVIDENCE OF NOTHING. Each mutation below
// breaks one of the three artifacts and requires the matching check to go red
// BY NAME — not merely to fail, which a broken harness also does.

// ---- 6a. a field added to a real response and not documented (AC 5) ----
//
// THE ACCEPTANCE CRITERION'S OWN EXPERIMENT, run rather than described: a field
// is added to the real `list_agents` payload in a compiled build, a real daemon
// is started on it, and its response is checked against the UNMUTATED
// declaration — which is exactly what CI does to a pull request that added a
// field and forgot the document.
{
  const mutant = mutatedBuild('undocumented-field', 'router.js',
    'capacity: capacityDto(capacity),',
    "capacity: capacityDto(capacity),\n            /* KAN-277: a field a future slice added and forgot to document */\n            queueDepth: 7,");

  if (mutant) {
    const cfg = makeConfig('undocumented');
    await startDaemon(cfg, mutant, 'undocumented');
    const client = new McpClient('undocumented', { dist: mutant, config: cfg.configPath });
    await client.initialize();
    const res = parsedText(await client.callTool('crabcast_list_agents'));

    const problems = keyProblems('list_agents', res, LIST_AGENTS_FIELDS);
    console.log(`   the mutated daemon's list_agents carries queueDepth: ${res.queueDepth}`);
    for (const p of problems) console.log(`     ! ${p}`);

    verdict(
      res.queueDepth === 7 &&
        problems.some((p) => p.includes('queueDepth') && p.includes('not declared')),
      '§2 goes red BY NAME on a field added to a real response and left undocumented — the field\n' +
      '    is on the wire (so the mutation really applied) and the check names it',
      `queueDepth on the wire=${JSON.stringify(res.queueDepth)}, ` +
      `problems=${JSON.stringify(problems.slice(0, 4))}`
    );
  }
}

// ---- 6b. a field removed from a document table ----
//
// The other direction, and it needs no daemon: the reconciliation is a pure
// function of (declaration, document text), so the document is mutated IN
// MEMORY and handed to the same function §1 ran. A checker that could only be
// pointed at the real file could not be shown to fail.
{
  const line = /^\| `statusSince` \| remembered \|.*$/m;
  const applied = line.test(docText);
  const mutatedDoc = docText.replace(line, '');
  const problems = reconcile(contract, mutatedDoc);
  const named = problems.filter((p) => p.includes('statusSince'));
  console.log(`   removed the \`statusSince\` row from ROW_SHAPES.ListedAgent's table: ${applied}`);
  for (const p of named) console.log(`     ! ${p}`);

  verdict(
    applied && named.length > 0 && named.some((p) => p.includes('absent from the document')),
    '§1 goes red BY NAME on a field deleted from a document table, and the deleted field is the\n' +
    '    one it names',
    applied
      ? `${problems.length} problem(s), ${named.length} naming statusSince`
      : 'the anchor line did not match, so the document was NOT mutated and this section proved nothing'
  );
}

// ---- 6c. the version bumped without its table row ----
{
  // THE ANCHOR IS DERIVED FROM THE SHIPPED VERSION, not written as a literal
  // (KAN-263). It was `= 1;` → `= 2;`, which meant the first real version bump
  // this contract ever took broke its own proof: the mutation stopped applying,
  // §6c did not run, and the failure named itself rather than the contract.
  // That is the exact-count guard in scripts/mutation.mjs working — it refused
  // to hand back an unmutated build — but the friction is unnecessary, because
  // "one past whatever is current" is what this section actually means and can
  // be computed. Now a bump costs nothing here.
  const nextVersion = READ_CONTRACT_VERSION + 1;
  const mutant = mutatedBuild('bumped-version', 'read-contract.js',
    `export const READ_CONTRACT_VERSION = ${READ_CONTRACT_VERSION};`,
    `export const READ_CONTRACT_VERSION = ${nextVersion};`);

  if (mutant) {
    const bumped = await import(path.join(mutant, 'read-contract.js'));
    const versions = parseVersions(docText);
    const row = versions?.find((v) => v.version === bumped.READ_CONTRACT_VERSION);
    console.log(`   the mutated build declares version ${bumped.READ_CONTRACT_VERSION}`);
    console.log(`   the document's table has rows for: ${versions?.map((v) => v.version).join(', ')}`);
    console.log(`   row for the declared version: ${row ? row.digest : '(none)'}`);

    // `=== nextVersion` rather than `=== 2`, for the reason above and for one
    // more: this conjunct is not decoration. It is the precondition that the
    // MUTANT is what is being asked, not the original — without it a build that
    // silently failed to mutate would satisfy `!row` only by accident, and the
    // section would report the strongest available result having tested nothing.
    verdict(
      bumped.READ_CONTRACT_VERSION === nextVersion && !row,
      '§3 goes red on a version bumped without a row in the document\'s version table — so a\n' +
      '    version can be raised, but not silently',
      `declared=${bumped.READ_CONTRACT_VERSION}, expected=${nextVersion}, row=${JSON.stringify(row)}`
    );
  }
}

// ---- 6d. a field added to a real activate_response and not documented ----
//
// AC 2 OF KAN-287, RUN RATHER THAN DESCRIBED, and the same experiment §6a runs
// one surface over. It is not redundant with §6a: that one mutates
// `list_agents`, whose top-level field set was already held. This one asks
// whether the NEW surface is held — and before this ticket the honest answer was
// no, because nothing checked `activate_response` at all.
{
  const mutant = mutatedBuild('undocumented-activate-field', 'router.js',
    'resumedExistingConversation: session.mayResume === true,',
    "resumedExistingConversation: session.mayResume === true,\n      /* KAN-287: a field a future slice added and forgot to document */\n      spawnAttempts: 3,");

  if (mutant) {
    const cfg = makeConfig('undocumented-activate');
    await startDaemon(cfg, mutant, 'undocumented-activate');
    const client = new SocketClient(cfg, 'undocumented-activate');
    await client.ready();
    const dir = owned('act-mutant');
    await client.request('configure_agent', { path: dir, priority: 5, launcher: LAUNCHER });
    const { id, ...res } = await client.request('activate_agent', { path: dir, override: true });

    const problems = keyProblems('activate_response', res, ACTIVATE_RESPONSE_FIELDS);
    const branchProblem = !ACTIVATE_RESPONSE_BRANCHES.spawned.always.includes('spawnAttempts') &&
      !ACTIVATE_RESPONSE_BRANCHES.spawned.sometimes.includes('spawnAttempts') &&
      'spawnAttempts' in res;

    console.log(`   the mutated daemon's activate_response carries spawnAttempts: ${res.spawnAttempts}`);
    console.log(`   the branch table lists it on neither list: ${branchProblem}`);
    for (const p of problems) console.log(`     ! ${p}`);

    verdict(
      res.spawnAttempts === 3 &&
        branchProblem &&
        problems.some((p) => p.includes('spawnAttempts') && p.includes('not declared')),
      '§2d goes red BY NAME on a field added to a real `activate_response` and left undocumented\n' +
      '    — the field is on the wire (so the mutation really applied), the field table names it,\n' +
      '    and the branch table lists it on neither `always` nor `sometimes`',
      `spawnAttempts on the wire=${JSON.stringify(res.spawnAttempts)}, ` +
      `branchProblem=${branchProblem}, problems=${JSON.stringify(problems.slice(0, 4))}`
    );
    client.close();
  }
}

// ---- 6e. a conditional field promoted to guaranteed in the document ----
//
// THE FAILURE THE TWO-LIST BRANCH TABLE EXISTS TO CATCH, and it has no analogue
// on the other two surfaces. `always` is a PROMISE and `sometimes` is a
// PERMISSION, so moving a key from the second list to the first strengthens what
// the contract claims without changing which fields exist — and a consumer that
// believed it would branch on a field that is legitimately absent. No key set
// changes, no field appears or disappears, and every check that compares field
// SETS stays green. Only the two-list comparison sees it.
{
  // `durable` on the spawning branch: conditional, because it rides only a
  // FAILED registry write. Promoting it to `always` is the exact defect above.
  //
  // DONE ON THE ROW'S CELLS RATHER THAN BY A REGEX OVER THE WHOLE LINE. The
  // first draft of this was one substitution with three capture groups, and it
  // was unreadable enough that whether it had moved the key or merely deleted it
  // could not be settled by reading it. Splitting the row is the same edit with
  // the question answerable.
  const rowIndex = docText.split('\n').findIndex((l) => l.startsWith('| `spawned` |'));
  const applied = rowIndex !== -1;
  let mutatedDoc = docText;
  if (applied) {
    const lines = docText.split('\n');
    const cells = lines[rowIndex].split('|');
    // cells: ['', ' `spawned` ', ' when ', ' always ', ' sometimes ', '']
    cells[3] = `${cells[3].trimEnd()} \`durable\` `;
    cells[4] = cells[4].replace('`durable` ', '');
    lines[rowIndex] = cells.join('|');
    mutatedDoc = lines.join('\n');
  }

  // The mutation is only meaningful if it actually MOVED the key rather than
  // duplicating or deleting it, so both halves are checked rather than assumed —
  // an edit that silently matched nothing would hand `reconcile` the untouched
  // document and this section would report the strongest available result having
  // tested nothing.
  const before = parseActivateBranches(docText)?.spawned;
  const after = parseActivateBranches(mutatedDoc)?.spawned;
  const moved =
    Boolean(after) &&
    after.always.includes('durable') &&
    !after.sometimes.includes('durable') &&
    !before.always.includes('durable');

  const problems = reconcile(contract, mutatedDoc);
  const named = problems.filter((p) => p.includes('spawned') && p.includes('durable'));
  console.log(`   promoted \`durable\` from sometimes to always on the \`spawned\` branch: ${moved}`);
  for (const p of named.slice(0, 4)) console.log(`     ! ${p}`);

  verdict(
    applied && moved && named.length > 0,
    '§1 goes red BY NAME when a CONDITIONAL field is documented as GUARANTEED — the failure the\n' +
    '    two-list branch table exists to catch, invisible to every check that compares field sets\n' +
    '    because no field was added or removed',
    applied
      ? `moved=${moved}, ${problems.length} problem(s), ${named.length} naming spawned/durable`
      : 'the anchor row did not match, so the document was NOT mutated and this section proved nothing'
  );
}

// ---- 6f. a covered surface deleted from §10's boundary table ----
//
// THE REVIEWER'S OWN STARVE, KEPT. Reviewing this ticket, `epic/KAN-59` deleted
// the `agent_status` row from §10's Covered table and reported
// `MUTANT_PROOF_EXIT=0, ALL CHECKS PASSED` — the section whose entire purpose is
// to stop a reader inferring the boundary could silently disagree with it, and
// nothing noticed. That is this ticket's thesis applied to its own deliverable.
//
// The experiment that found the hole is now the experiment that guards it. It is
// run against a document mutated IN MEMORY, for the reason §6b gives: the
// reconciliation is a pure function of (declaration, document text), so the
// check that fails here is the same code §1 runs rather than a copy of it.
{
  const before = parseBoundary(docText, 'covered');
  const rowIndex = docText.split('\n').findIndex((l) => l.startsWith('| `agent_status` |'));
  const applied = rowIndex !== -1;
  let mutatedDoc = docText;
  if (applied) {
    const lines = docText.split('\n');
    lines.splice(rowIndex, 1);
    mutatedDoc = lines.join('\n');
  }
  const after = parseBoundary(mutatedDoc, 'covered');
  const starved =
    Boolean(before) && Boolean(after) &&
    before.includes('agent_status') && !after.includes('agent_status');

  const problems = reconcile(contract, mutatedDoc);
  const named = problems.filter((p) => p.includes('boundary') && p.includes('agent_status'));
  console.log(`   deleted the \`agent_status\` row from §10's Covered table: ${starved}`);
  console.log(`   §10 Covered, before: ${before?.join(', ')}`);
  console.log(`   §10 Covered, after : ${after?.join(', ')}`);
  for (const p of named) console.log(`     ! ${p}`);

  verdict(
    applied && starved && named.length > 0,
    '§1 goes red BY NAME when a covered surface is deleted from §10\'s boundary table — the\n' +
    '    exact starve that found this hole in review, when it printed ALL CHECKS PASSED. The\n' +
    '    section that says where the contract stops is now held by the same round trip as the\n' +
    '    fields it is about',
    applied
      ? `starved=${starved}, ${problems.length} problem(s), ${named.length} naming the boundary`
      : 'the anchor row did not match, so the document was NOT mutated and this section proved nothing'
  );

  // THE OTHER DIRECTION, WATCHED TOO — because the guard has two legs and one of
  // them going red proves nothing about the other. Above, the DOCUMENT loses a
  // surface. Here the DECLARATION does: a `read-contract.ts` that covers a
  // response its boundary section never mentions, which is what "somebody adds a
  // fourth response next quarter" actually looks like.
  //
  // The module is cloned with one surface dropped rather than mutating a build,
  // because `reconcile` is a pure function of (declaration, document) — the same
  // property §6b relies on, used here on the declaration side instead.
  const withoutOne = { ...contract, COVERED_SURFACES: { ...contract.COVERED_SURFACES } };
  delete withoutOne.COVERED_SURFACES.activate_response;
  const orphaned = reconcile(withoutOne, docText);
  const namesOrphan = orphaned.filter((p) => p.includes('ACTIVATE_RESPONSE_FIELDS'));
  console.log(`   dropped \`activate_response\` from COVERED_SURFACES (declaration side)`);
  for (const p of namesOrphan) console.log(`     ! ${p}`);

  verdict(
    namesOrphan.length > 0,
    '§1 also goes red BY NAME on the declaration side — a response this contract covers whose\n' +
    '    declaration no §10 surface claims. Both legs of the boundary guard are watched failing,\n' +
    '    because one of them working says nothing about the other',
    `${orphaned.length} problem(s), ${namesOrphan.length} naming the unclaimed declaration`
  );
}

// A mutation whose anchor drifted is a section that proved nothing, and the
// helper counts it — this line is what makes that visible in the summary rather
// than only in the middle of the log.
if (mutationsSkipped().length) {
  console.log(`\n  NOTE: ${mutationsSkipped().length} mutation(s) did not apply: ${mutationsSkipped().join(', ')}`);
}

// ================================== verdict ================================

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
