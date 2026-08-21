#!/usr/bin/env node
// KAN-512: sweep docs/ for an ILLUSTRATIVE BLOCK that lists a declared set.
//
// WHAT FAILURE THIS WOULD CATCH: a fenced example in docs/ carrying a list of
// names that ought to track a declaration in code, with nothing comparing the
// two. `docs/event-contract.md`'s `configEchoContract` example lost `owner`
// — added to `CONFIG_FIELDS` by KAN-193 — and read as a complete, authoritative
// knob list for at least one release. It was found by `task/KAN-504` happening
// to edit the same block for another reason, and by nothing mechanical.
//
// THIS FILE IS THE SURVEY, NOT THE GATE. It reports; it fails no build on
// drift. `verify-doc-example-sets.mjs` is the gate, and it rules on the blocks
// a `<!-- contract-example: … -->` marker attributes. The two are deliberately
// separate, for the reason `kan530-doc-count-sweep.mjs` gives about its own
// pair: the gate must be narrow enough to be trusted in CI, and a survey wants
// RECALL — so this script reports the loose population the gate declines to
// rule on, which is what a human should read.
//
// ⚠ THE ONE THING THIS SEES THAT THE GATE STRUCTURALLY CANNOT. The gate's
// discovery half attributes an unmarked block only when its names are EXACTLY a
// declared set. That is sound — a threshold would fail toward silence — but it
// means a block that has ALREADY drifted matches nothing and is invisible to
// it. This sweep attributes by OVERLAP, so a block missing two of ten names
// still reports. That is the state KAN-512 was filed about, and it is the one
// state the gate cannot detect.
//
// WHAT IT CANNOT SEE, stated because the shape looks exhaustive:
//   - A set named entirely in prose with no fence and no table. §4 reports
//     backticked runs, but its precision is poor and it says so; treat that
//     section as a reading list, not as findings.
//   - A block whose names were never a declared set and never will be —
//     indistinguishable, from here, from one that has drifted past the
//     threshold. §3 prints the threshold rather than hiding it.
//   - A set declared somewhere `dist/` does not export. The instrument is §1's
//     module list; a declaration outside it cannot be matched against.
//   - VALUES. Names only, exactly as the gate.
//
// Needs a build: it reads declarations from `dist/`. Prints a report and exits
// 0 unless the CONTROL fails — a sweep whose instrument cannot find a planted
// disagreement has measured its own search and not the tree.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const distDir = path.join(repoRoot, 'dist');

const argv = new Set(process.argv.slice(2));
const showAll = argv.has('--all');

// ------------------------------------------------------- §1 the instrument --

const MODULES = ['events.js', 'router.js', 'read-contract.js', 'send-contract.js', 'capacity.js'];

/** Every declared name-set `dist/` exports, flattened one level into shapes. */
const declarations = [];
for (const file of MODULES) {
  let mod;
  try {
    mod = await import(path.join(distDir, file));
  } catch (e) {
    console.error(`could not import dist/${file} — run \`npm run build\` first. ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
  const alias = file.replace(/\.js$/, '');
  for (const [name, value] of Object.entries(mod)) {
    if (Array.isArray(value) && value.every((x) => typeof x === 'string') && value.length > 1) {
      declarations.push({ spec: `${alias}.${name}`, names: value.slice() });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 1) declarations.push({ spec: `${alias}.${name}`, names: keys });
      // One level in, so `BLOCK_SHAPES.ConfigEcho` is reachable the way the
      // `contract-table:` markers already name it.
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue && typeof subValue === 'object' && !Array.isArray(subValue)) {
          const subKeys = Object.keys(subValue);
          if (subKeys.length > 1) declarations.push({ spec: `${alias}.${name}.${sub}`, names: subKeys });
        }
      }
    }
  }
}

/** How close a doc list has to be to a declaration before it is worth printing. */
const OVERLAP = 0.6;
const MIN_NAMES = 3;

console.log('=== §1 the instrument ===');
console.log(`  modules read: ${MODULES.join(', ')}`);
console.log(`  declarations available: ${declarations.length}`);
console.log(`  a doc list is attributed at ${MIN_NAMES}+ names and ${Math.round(OVERLAP * 100)}% overlap`);

// ---------------------------------------------------------- §2 the corpus ---

function fencesOf(text) {
  const lines = text.split('\n');
  const out = [];
  let open = null;
  lines.forEach((line, i) => {
    const f = /^\s*```(.*)$/.exec(line);
    if (!f) return;
    if (!open) open = { info: f[1].trim() || '(none)', first: i + 1 };
    else {
      out.push({ ...open, body: lines.slice(open.first, i).join('\n'), above: lines.slice(Math.max(0, open.first - 4), open.first - 1) });
      open = null;
    }
  });
  return out;
}

function parseFence(body) {
  const t = body.trim();
  const wrapped = t.startsWith('{') || t.startsWith('[') ? t : `{${t}}`;
  try {
    return JSON.parse(wrapped);
  } catch {
    return null;
  }
}

function namesOf(node) {
  if (Array.isArray(node)) return node.every((x) => typeof x === 'string') ? node.slice() : null;
  if (node && typeof node === 'object') return Object.keys(node);
  return null;
}

function nameSetsOf(doc, prefix = '.', out = new Map()) {
  const here = namesOf(doc);
  if (here) out.set(prefix, here);
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc)) {
      if (v && typeof v === 'object') nameSetsOf(v, prefix === '.' ? k : `${prefix}.${k}`, out);
    }
  }
  return out;
}

const MARKER = /<!--\s*contract-example:\s*([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.()-]+)\s*-->/;

/** The best declarations for a list of names, by overlap. */
function attribute(names) {
  const hits = [];
  for (const d of declarations) {
    const inBoth = names.filter((n) => d.names.includes(n)).length;
    if (inBoth < MIN_NAMES) continue;
    const score = inBoth / Math.max(names.length, d.names.length);
    if (score < OVERLAP) continue;
    hits.push({
      ...d,
      score,
      missing: d.names.filter((n) => !names.includes(n)),
      invented: names.filter((n) => !d.names.includes(n))
    });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();

let fenceTotal = 0;
let jsonReadable = 0;
let jsonRefused = 0;
const findings = [];

for (const f of docFiles) {
  const rel = path.join('docs', f);
  const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  for (const fence of fencesOf(text)) {
    fenceTotal += 1;
    const doc = parseFence(fence.body);
    if (doc === null) {
      if (fence.info === 'json' || fence.info === 'jsonc') jsonRefused += 1;
      continue;
    }
    jsonReadable += 1;
    const markers = fence.above.map((l) => MARKER.exec(l)).filter(Boolean).map((m) => m[1]);
    for (const [pointer, names] of nameSetsOf(doc)) {
      if (names.length < MIN_NAMES) continue;
      for (const hit of attribute(names)) {
        findings.push({
          rel,
          info: fence.info,
          opening: fence.body.trim().split('\n')[0].trim().slice(0, 64),
          pointer,
          names,
          hit,
          gated: markers.includes(pointer)
        });
      }
    }
  }
}

console.log('\n=== §2 the corpus ===');
console.log(`  ${docFiles.length} file(s) under docs/, ${fenceTotal} fence(s) of every language`);
console.log(`  ${jsonReadable} parsed as JSON; ${jsonRefused} labelled json/jsonc and would not parse`);

// ------------------------------------------------------ §3 what was found ---

console.log('\n=== §3 illustrative blocks carrying a declared set ===');
if (findings.length === 0) {
  console.log('  NONE. No fenced block under docs/ carries a name list attributable to a declaration.');
} else {
  for (const x of findings) {
    const exact = x.hit.missing.length === 0 && x.hit.invented.length === 0;
    console.log(
      `\n  ${x.rel}  [${x.info}]  \`${x.pointer}\`  ->  ${x.hit.spec}  ` +
      `(${Math.round(x.hit.score * 100)}% overlap)  ${x.gated ? 'GATED' : '⚠ NOT GATED'}`
    );
    console.log(`    opening: \`${x.opening}\``);
    console.log(`    block(${x.names.length}): ${JSON.stringify(x.names)}`);
    if (!exact) {
      console.log(`    ⚠ ALREADY DRIFTED — missing ${JSON.stringify(x.hit.missing)}, ` +
        `not declared ${JSON.stringify(x.hit.invented)}`);
    }
  }
  const ungated = findings.filter((x) => !x.gated);
  const drifted = findings.filter((x) => x.hit.missing.length || x.hit.invented.length);
  console.log(`\n  ${findings.length} attribution(s); ${ungated.length} not gated; ${drifted.length} already drifted`);
}

// ------------------------------------------- §4 the loose prose population --

console.log('\n=== §4 prose runs of backticked names (LOOSE — a reading list, not findings) ===');
console.log('  ⚠ Precision here is poor by construction: most hits are contract TABLES, which');
console.log('  `verify-read-contract.mjs` and `verify-send-contract.mjs` already hold. Printed');
console.log('  so the population is visible rather than assumed empty.');

let proseHits = 0;
for (const f of docFiles) {
  const rel = path.join('docs', f);
  let text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  for (const fence of fencesOf(text)) text = text.replace(fence.body, '');
  for (const para of text.split(/\n\s*\n/)) {
    if (/^\s*\|/.test(para)) continue; // a table; gated elsewhere
    const names = [...new Set([...para.matchAll(/`([a-zA-Z_][\w]*)`/g)].map((m) => m[1]))];
    if (names.length < MIN_NAMES) continue;
    for (const hit of attribute(names)) {
      proseHits += 1;
      if (!showAll && proseHits > 10) continue;
      console.log(`\n  ${rel} -> ${hit.spec} (${Math.round(hit.score * 100)}%)`);
      console.log(`    "${para.trim().replace(/\s+/g, ' ').slice(0, 150)}"`);
    }
  }
}
console.log(`\n  ${proseHits} loose prose hit(s)${!showAll && proseHits > 10 ? ' (10 shown; --all for the rest)' : ''}`);

// ---------------------------------------------------------- §5 the control --
//
// A sweep that reports "none" has said nothing until the same instrument is
// shown finding something. The planting is a DRIFTED block — one name removed
// from a real declaration — because that is the state §3 exists to surface and
// the one the gate cannot see.

console.log('\n=== §5 the control ===');
const target = declarations.find((d) => d.names.length >= 5) ?? declarations[0];
const plantedNames = target.names.slice(0, -1); // one name dropped: the KAN-193 shape
const plantedDoc = parseFence(JSON.stringify({ example: plantedNames }));
const plantedSets = nameSetsOf(plantedDoc);
const plantedHits = [...plantedSets.values()].flatMap((names) => attribute(names));
const best = plantedHits.find((h) => h.spec === target.spec) ?? null;
const caught = best !== null && best.missing.length === 1;

console.log(`  planted ${target.spec} with \`${target.names.at(-1)}\` REMOVED (${plantedNames.length} of ${target.names.length})`);
console.log(`  attribution: ${plantedHits.map((h) => `${h.spec}@${Math.round(h.score * 100)}%`).join(', ') || 'NOTHING'}`);
console.log(`  reported missing: ${best ? JSON.stringify(best.missing) : '(not attributed at all)'}`);
console.log(`  ${caught
  ? 'CAUGHT — the instrument can attribute a drifted block AND name the lost member'
  : 'MISSED — this sweep proves nothing'}`);

if (!caught) {
  console.error('\ncontrol failed: the sweep could not find a planted drift, so its report above is void.');
  process.exit(1);
}
process.exit(0);
