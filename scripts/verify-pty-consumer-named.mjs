#!/usr/bin/env node
// KAN-394: §10 names the pty triple's live consumer, and naming it contracts nothing.
//
// WHAT FAILURE THIS WOULD CATCH: a later edit that "tidies" `pty_init`,
// `pty_input` or `pty_resize` out of `UNCOVERED_SURFACES` — or quietly promotes
// one into `COVERED_SURFACES` / `CONTRACTED_ELSEWHERE` — and, the direction
// this ticket actually feared, an edit that keeps the named consumer while
// deleting the sentence saying that naming it promises nothing. That last one
// is the dangerous shape: it leaves a contract document naming a downstream
// consumer with no disclaimer beside it, which is a promise in everything but
// wording, and it is one careless edit away at all times because the
// disclaimer reads like throat-clearing to somebody tightening prose.
//
// WHY THIS IS A SEPARATE SCRIPT FROM verify-read-contract.mjs, WHICH ALREADY
// HOLDS §10. That proof reconciles `UNCOVERED_SURFACES` against §10's table in
// both directions — which means a deletion from BOTH sides reconciles
// perfectly and stays green. Membership consistency cannot pin membership.
// Something has to name these three literally, and that is this file.
//
// SO THIS SCRIPT HAND-NAMES THREE STRINGS ON PURPOSE, against the
// derive-don't-hand-maintain rule (KAN-245), and the exception is the point
// rather than an oversight: the assertion IS "these specific three are still
// uncovered". Everything else here is derived — the rest of the list is never
// restated, so the seven cannot drift against a copy kept here. If a fourth
// pty action appears, this script says nothing about it, and that is correct.
//
// WHAT IT READS, AND WHY THAT CHOICE MATTERS FOR HOW YOU READ ITS VERDICT.
// It reads `src/read-contract.ts` and `docs/read-path-contract.md` AS TEXT. It
// imports nothing from `dist/`, starts no daemon and needs no build — so its
// verdict is about the source you actually edited, and a stale or failed build
// cannot make it pass or fail for the wrong reason. The cost is that it says
// NOTHING about the built artifact or the wire: that `UNCOVERED_SURFACES`
// compiles, is exported, matches a real daemon's responses and sits in the
// version digest is `verify-read-contract.mjs`'s job, and this script does not
// duplicate or replace one line of it. Two honest mechanisms, and the seam
// between them is here in writing: nothing checks that the CONSUMER NAMED
// BELOW IS STILL A CONSUMER. Butchr could retire its sidepanel terminal
// tomorrow and every assertion here would stay green while the document's
// claim quietly became false. That is not covered by anything in this
// repository and cannot be — it is a fact about another tree. KAN-394's "what
// would reopen this" says so, and this comment is the edge of what is
// mechanised.
//
// VACUITY. Every parse below fails LOUDLY and in ITS OWN WORDS when its input
// is empty or unfindable, because this epic has twice had a check report a
// tree clean on an input that had silently emptied. "I could not find the
// list" and "the list is missing pty_init" are different findings and never
// print the same sentence.
//
// Exits non-zero on any failure so a reviewer can re-run it against the PR
// head. No daemon, no herdr, no network, no build.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');
const SRC = path.join(repoRoot, 'src', 'read-contract.ts');
const DOC = path.join(repoRoot, 'docs', 'read-path-contract.md');

/** The three this ticket is about. Named literally — see the header. */
const PTY_ACTIONS = ['pty_init', 'pty_input', 'pty_resize'];

let failures = 0;

function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A parse that came back empty is a broken instrument, not a finding. */
function vacuity(ok, what) {
  if (!ok) {
    console.log(`FAIL  VACUITY: ${what}`);
    console.log('      This is a broken instrument, NOT a finding about the tree.');
    console.log('      Nothing below it has been measured. Fix the parse before reading any verdict.');
    failures += 1;
  }
  return ok;
}

const srcText = fs.readFileSync(SRC, 'utf8');
const docText = fs.readFileSync(DOC, 'utf8');

console.log('reading (as text, no build needed):');
console.log(`  ${path.relative(repoRoot, SRC)}`);
console.log(`  ${path.relative(repoRoot, DOC)}`);

// ---------------------------------------------------------------- §1 the list
console.log('\n§1  the three are still declared uncovered in src/read-contract.ts');

/** The string members of an `export const NAME = [...] as const;` array. */
function declaredList(name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`).exec(srcText);
  if (!m) return null;
  return [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

/** The top-level keys of an `export const NAME = { ... } as const;` object. */
function declaredKeys(name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*as const;`).exec(srcText);
  if (!m) return null;
  return [...m[1].matchAll(/^\s{2}([A-Za-z0-9_]+)\s*:/gm)].map((x) => x[1]);
}

const uncovered = declaredList('UNCOVERED_SURFACES');

if (vacuity(uncovered !== null, 'UNCOVERED_SURFACES was not found in src/read-contract.ts at all')) {
  vacuity(uncovered.length > 0, 'UNCOVERED_SURFACES parsed to an EMPTY list');
}

if (uncovered && uncovered.length > 0) {
  console.log(`      parsed ${uncovered.length} declared uncovered surface(s)`);
  for (const action of PTY_ACTIONS) {
    check(
      uncovered.includes(action),
      `'${action}' is in UNCOVERED_SURFACES`,
      uncovered.includes(action) ? '' : 'tidied out — the surface silently stopped being disclosed as uncovered'
    );
  }
}

// ------------------------------------------------------- §2 not promoted away
console.log('\n§2  and they have not been promoted into either of the other two lists');

const covered = declaredKeys('COVERED_SURFACES');
const elsewhere = declaredKeys('CONTRACTED_ELSEWHERE');

vacuity(covered !== null, 'COVERED_SURFACES was not found in src/read-contract.ts');
vacuity(elsewhere !== null, 'CONTRACTED_ELSEWHERE was not found in src/read-contract.ts');

for (const [listName, list] of [
  ['COVERED_SURFACES', covered],
  ['CONTRACTED_ELSEWHERE', elsewhere]
]) {
  if (!list) continue;
  for (const action of PTY_ACTIONS) {
    check(
      !list.includes(action),
      `'${action}' is NOT in ${listName}`,
      list.includes(action)
        ? 'promoted — naming a consumer was not authorisation to contract the surface (KAN-394, KAN-428)'
        : ''
    );
  }
}

// --------------------------------------------------------- §3 the doc's table
console.log("\n§3  and §10's Not-covered table still carries a row for each");

/**
 * The uncovered-surfaces table, read the way verify-read-contract.mjs reads it:
 * by ANCHOR, then the first markdown table after it, then the first backticked
 * name in column 0. Deliberately the same discipline rather than a second one —
 * a parser that disagreed with the real proof's would be its own defect.
 */
function boundaryRows(anchor) {
  const m = new RegExp(`<!--\\s*contract-${anchor}-surfaces\\s*-->`).exec(docText);
  if (!m) return null;
  const lines = docText.slice(m.index + m[0].length).split('\n');
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
  return rows.slice(2).map((cells) => {
    const found = /`([A-Za-z0-9_]+)`/.exec(cells[0] ?? '');
    return found ? found[1] : null;
  });
}

const documented = boundaryRows('uncovered');

if (vacuity(documented !== null, 'the contract-uncovered-surfaces anchor is not in the document')) {
  vacuity(documented.filter(Boolean).length > 0, "§10's Not-covered table parsed to ZERO named rows");
}

if (documented && documented.filter(Boolean).length > 0) {
  console.log(`      parsed ${documented.filter(Boolean).length} documented row(s)`);
  for (const action of PTY_ACTIONS) {
    check(documented.includes(action), `§10's Not-covered table has a '${action}' row`);
  }
}

// ------------------------------------------ §4 the consumer, and the refusal
console.log('\n§4  the section names the consumer AND refuses to promise anything by doing so');

/**
 * The Not-covered section body: the anchor through to the next `### ` heading.
 * Located structurally rather than by my own heading text, so renaming the
 * subsection I added does not break this and moving the disclaimer OUT of the
 * section does.
 */
function notCoveredSection() {
  const m = /<!--\s*contract-uncovered-surfaces\s*-->/.exec(docText);
  if (!m) return null;
  const rest = docText.slice(m.index);
  const end = /\n### /.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

const section = notCoveredSection();

if (vacuity(section !== null, 'could not locate the Not-covered section')) {
  vacuity(section.trim().length > 0, 'the Not-covered section is EMPTY');
}

if (section && section.trim().length > 0) {
  // (a) the consumer is named at all
  const namesButchr = /Butchr/.test(section);
  const namesSidepanel = /sidepanel/i.test(section);
  check(namesButchr, 'the section names Butchr as a consumer of the pty triple');
  check(namesSidepanel, 'the section says WHICH part of it — the sidepanel terminal');

  // (b) and the naming is disclaimed IN THE SAME SECTION.
  //
  // Both halves are required TOGETHER and this is the assertion the ticket was
  // actually written for. A named consumer with no disclaimer is the erosion:
  // it reads as a commitment, and the document's whole worth in this section is
  // that it commits to nothing.
  const disclaims = /does not change what this document promises/.test(section);
  const enumerated = /no compatibility promise/.test(section);
  check(disclaims, "the section states that naming a consumer does not change what the document promises");
  check(enumerated, 'and enumerates what is still not promised (no compatibility promise)');

  if ((namesButchr || namesSidepanel) && !(disclaims && enumerated)) {
    console.log('');
    console.log('      ^ READ THIS ONE CAREFULLY. A consumer is named in a contract document');
    console.log('        and the sentence refusing to promise them anything is GONE. That is not');
    console.log('        a tidy-up: an uncovered surface with a named downstream consumer and no');
    console.log('        disclaimer is a promise in everything but wording. Restore the sentence');
    console.log('        or remove the naming — KAN-394 exists because those go together.');
  }

  // (c) the CLI misreading is still corrected
  check(
    /no `crabcast` command does/.test(section) || /There is no such command/.test(section),
    'the section still says no first-party command drives these'
  );
}

// ------------------------------------------------------------------- §5 verdict
console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} problem(s) above.`);
} else {
  console.log('OK — the pty triple is still uncovered, still documented, and still disclaimed.');
}

process.exit(failures ? 1 : 0);
