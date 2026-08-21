#!/usr/bin/env node
// KAN-512: an illustrative JSON block that lists a declared set is reconciled
// against that set.
//
// WHAT FAILURE THIS WOULD CATCH: `docs/event-contract.md`'s `configEchoContract`
// example losing `owner` from its `declared` array while `CONFIG_FIELDS` in
// `src/events.ts` still declares it. That is not hypothetical — it is what
// happened. `owner` was added by KAN-193, the example was never updated, and
// the loss survived at least one release until `task/KAN-504` happened to be
// editing the same block to add `args` and noticed. Every check in this
// repository was green throughout, because nothing anywhere opened a fenced
// block in `docs/` and compared it to anything. Measured at 662d18f, before
// this file existed: `verify-approval-marker.mjs` and
// `verify-readme-is-current.mjs` are the only two proofs that parse a fence at
// all, and both read `README.md` or a PR body. `docs/` was unread.
//
// ⚠ NOTE THE ASYMMETRY THAT MAKES IT WORTH A GATE. A knob MISSING from the
// example is invisible — the block still reads as a complete, authoritative
// list. A knob PRESENT in it is believed. So this drift always degrades toward
// a reader trusting a stale list, and it does so while looking finished.
//
// ---------------------------------------------------------------------------
// THE RULE, AND WHY IT IS A MARKER RATHER THAN A REGISTER IN THIS FILE
//
// A comment immediately above a fenced JSON block attributes part of that block
// to a declaration in code:
//
//     <!-- contract-example: configEchoContract.declared = events.CONFIG_FIELDS -->
//
// The left side is a dotted path INTO the parsed block; `.` is the block's own
// root. The right side names an export, optionally through a derivation. The
// names the block carries at that path must then be the names the declaration
// carries — checked in both directions, so a knob the doc invents is as red as
// one it drops.
//
// This is the `<!-- contract-table: … -->` convention `docs/read-path-contract.md`
// and `docs/send-contract.md` already use, applied to fences instead of tables.
// A register inside this script would have worked too and is rejected
// deliberately: the attribution would then sit hundreds of lines from the thing
// it attributes, in a file the doc's author is not editing, which is the same
// two-copies-that-drift shape this epic keeps filing. Next to the block, the
// marker is visible to whoever is rewriting the block.
//
// WHY THE AUTHORITY IS `events.CONFIG_FIELDS` AND NOT THE READ CONTRACT'S
// `config`. ⚠ These are two different things one level apart, and anchoring to
// the wrong one would be this ticket's own defect reproduced inside its fix.
// `docs/read-path-contract.md`'s `config` is a SINGLE field of bucket `durable`
// — its interior is deliberately not that document's business, and that
// document says so: "`config`'s own knobs are declared by `CONFIG_FIELDS` in
// `src/events.ts`". The interior is the event contract's, so the event
// contract's declaration is what an example of the interior is measured
// against. KAN-504 established the distinction; this comment is it being
// obeyed.
//
// ⚠ AND `router.RECONFIGURATION_COST` HAS THE SAME TEN KEYS TODAY, which is
// exactly why the marker names its declaration instead of the gate guessing.
// It is a different declaration about a different question — what
// reconfiguring a knob COSTS, not what publication declares — and the two are
// free to diverge. A gate that matched whichever declaration happened to fit
// would silently follow the wrong one the day they did.
//
// ---------------------------------------------------------------------------
// TWO DIRECTIONS, AND THE SECOND IS THE ONE THAT ANSWERS "DO NOT CLOSE THE
// CATEGORY BY FIXING ONLY THIS INSTANCE"
//
//   §5 MARKED BLOCKS MUST AGREE. Drift in a block somebody registered.
//   §6 AN UNMARKED BLOCK THAT ALREADY MATCHES A DECLARATION MUST BE MARKED.
//      A new illustrative block is detectable exactly once — at the moment it
//      is added, when it is still correct — and §6 is what spends that moment.
//      After it drifts it no longer matches anything and no detector can
//      attribute it.
//
// ⚠ §6 IS NOT A COMPLETENESS CLAIM AND MUST NOT BE READ AS ONE. It cannot see a
// block added already-wrong, a set named by prose instead of by JSON, or a
// fence this script cannot parse. `scripts/kan512-doc-example-sweep.mjs` is the
// wider survey over the same corpus — it asserts nothing, and it is where that
// population is measured rather than guessed at. Neither script owns the gap
// between them; this comment is where the edge of mine is marked.
//
// WHAT THIS DOES NOT COVER, named because the mechanism looks complete:
//   1. A fence that does not parse as JSON. `docs/read-path-contract.md` has
//      one — a bare `…` where a value belongs. §4 DECLINES it out loud and
//      prints it; a marker pointed at it is a failure, not a skip.
//   2. Prose. "the ten knobs are `priority`, `refusable`, …" is a list of names
//      in a sentence, and this gate needs a fence to attach to. KAN-530's
//      `verify-doc-set-counts.mjs` holds prose COUNTS against gated sets; it
//      does not hold prose MEMBERSHIP, and nothing does.
//   3. VALUES. This compares names only. `"priority": 2` in an example is not
//      checked against anything, and an example whose values are impossible
//      would pass here.
//   4. A set with fewer than MIN_DISCOVERY names is invisible to §6 (though
//      still checked by §5 if marked). Two-name sets collide with too much to
//      attribute by membership; the threshold is stated below with its cost.
//
// Needs a build — the declarations are imported from `dist/`. No daemon, no
// herdr, no PTY, no network. Exits non-zero on any failure so a reviewer can
// re-run it against the PR head.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const distDir = path.join(repoRoot, 'dist');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function rule(title) {
  console.log(`\n${'='.repeat(76)}\n${title}\n${'='.repeat(76)}`);
}

// ============================================================ §1 the marker --

rule('1. THE MARKER — what attributes a block to a declaration');

/**
 * `<!-- contract-example: <path-in-block> = <declaration> -->`
 *
 * Deliberately a DIFFERENT token from `contract-table:`. The two attach to
 * different things (a fence, a table) and are read by different scripts, and a
 * shared token would mean each script silently ignoring the other's markers —
 * which reads, from either side, exactly like a marker nobody wrote.
 */
const MARKER = /<!--\s*contract-example:\s*([A-Za-z0-9_.]+)\s*=\s*([A-Za-z0-9_.()-]+)\s*-->/;

/**
 * How far above a fence a marker may sit and still attribute it. One blank line
 * is allowed so the marker does not have to be jammed against the fence; more
 * than that and "immediately above" stops being true.
 */
const MARKER_REACH = 2;

/**
 * The smallest set §6 will try to attribute by membership alone.
 *
 * ⚠ THE COST OF THIS NUMBER, stated rather than left as a constant nobody
 * chose: a genuine two-name illustrative set is invisible to discovery. Two
 * names collide across this codebase's declarations often enough that
 * attribution by membership is guessing — `["action", "success"]` is the head
 * of six declared response shapes. Three is where a match stops being a
 * coincidence. A two-name block is still fully checked by §5 the moment
 * somebody marks it; what it loses is being FOUND.
 */
const MIN_DISCOVERY = 3;

console.log(`   marker syntax: <!-- contract-example: <path-in-block> = <declaration> -->`);
console.log(`   a marker may sit up to ${MARKER_REACH} line(s) above its fence`);
console.log(`   §6 attributes an unmarked set only at ${MIN_DISCOVERY}+ names`);

// ====================================================== §2 the declarations --

rule('2. THE DECLARATIONS — resolved from dist/, and the closed derivation list');

const MODULES = {
  events: 'events.js',
  router: 'router.js',
  'read-contract': 'read-contract.js',
  'send-contract': 'send-contract.js',
  capacity: 'capacity.js'
};

const loaded = new Map();
for (const [alias, file] of Object.entries(MODULES)) {
  try {
    loaded.set(alias, await import(path.join(distDir, file)));
  } catch (e) {
    console.log(`   ${alias}: NOT LOADED — ${e.message.split('\n')[0]}`);
  }
}
console.log(`   modules loaded: ${[...loaded.keys()].join(', ')}`);

/**
 * The derivations a marker may name. A CLOSED list: an unknown one is a
 * failure, never a silent pass-through. `verbatim(X)` is here because the
 * `configEchoContract` block publishes two name lists off one declaration —
 * every knob, and the subset the sweep does not examine — and a gate that could
 * only hold the first would leave the second reading as though it were held.
 */
const DERIVATIONS = {
  keys: (v) => (Array.isArray(v) ? v.slice() : Object.keys(v)),
  verbatim: (v) =>
    Object.entries(v)
      .filter(([, shape]) => shape && typeof shape === 'object' && shape.kind === 'verbatim')
      .map(([name]) => name)
};

/** `events.CONFIG_FIELDS` / `verbatim(events.CONFIG_FIELDS)` -> a list of names, or null. */
function declarationNames(spec) {
  const call = /^([A-Za-z_][\w]*)\((.*)\)$/.exec(spec);
  const derivation = call ? call[1] : 'keys';
  const dotted = call ? call[2] : spec;
  if (!(derivation in DERIVATIONS)) return { names: null, why: `unknown derivation \`${derivation}()\`` };

  const parts = dotted.split('.');
  const alias = parts[0];
  const mod = loaded.get(alias);
  if (!mod) return { names: null, why: `no module \`${alias}\`` };

  let node = mod;
  for (const part of parts.slice(1)) {
    if (node && typeof node === 'object' && part in node) node = node[part];
    else return { names: null, why: `\`${dotted}\` resolves to nothing` };
  }
  if (!node || typeof node !== 'object') return { names: null, why: `\`${dotted}\` is not a set` };
  return { names: DERIVATIONS[derivation](node), why: null };
}

console.log(`   derivations: ${Object.keys(DERIVATIONS).map((d) => `${d}()`).join(', ')} (closed — an unknown one fails)`);

// ========================================================= §3 the detector ---

rule('3. THE DETECTOR — self-tested before it is trusted');

/** Every fenced block, with its info string and the lines above it. */
function fencesOf(text) {
  const lines = text.split('\n');
  const out = [];
  let open = null;
  lines.forEach((line, i) => {
    const f = /^\s*```(.*)$/.exec(line);
    if (!f) return;
    if (!open) open = { info: f[1].trim(), first: i + 1 };
    else {
      out.push({ ...open, last: i, body: lines.slice(open.first, i).join('\n') });
      open = null;
    }
  });
  return { fences: out, lines };
}

/**
 * A fence's body as JSON. Several of these blocks are FRAGMENTS — they open at
 * `"configEchoContract": {` because the surrounding response is not what the
 * section is about — so a fragment is wrapped before parsing. Returns null when
 * it cannot be read, and the caller must report that rather than skip it.
 */
function parseFence(body) {
  const t = body.trim();
  const wrapped = t.startsWith('{') || t.startsWith('[') ? t : `{${t}}`;
  try {
    return JSON.parse(wrapped);
  } catch {
    return null;
  }
}

/** `.` -> the root; `configEchoContract.declared` -> that node. */
function at(doc, pointer) {
  if (pointer === '.') return doc;
  let node = doc;
  for (const part of pointer.split('.')) {
    if (node && typeof node === 'object' && part in node) node = node[part];
    else return undefined;
  }
  return node;
}

/** The names a node carries: an array of strings as-is, an object as its keys. */
function namesOf(node) {
  if (Array.isArray(node)) return node.every((x) => typeof x === 'string') ? node.slice() : null;
  if (node && typeof node === 'object') return Object.keys(node);
  return null;
}

/**
 * Every name-set inside a parsed block, by pointer. Walks objects and their
 * string-array values; this is what §6 attributes and what §5's pointers land
 * in.
 */
function nameSetsOf(doc, prefix = '.', out = new Map()) {
  const here = namesOf(doc);
  if (here) out.set(prefix, here);
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc)) {
      const p = prefix === '.' ? k : `${prefix}.${k}`;
      if (Array.isArray(v) || (v && typeof v === 'object')) nameSetsOf(v, p, out);
    }
  }
  return out;
}

// -- the self-test. Guard (b) of verify-proof-verdicts' three: a detector that
// -- recognises nothing reports the same all-clear as one that recognises
// -- everything, so it is exercised on fixtures that must be ACCEPTED and
// -- fixtures that must be REJECTED before it is pointed at the real tree.
const FIXTURE_ACCEPT = `text\n<!-- contract-example: a.b = events.CONFIG_FIELDS -->\n\`\`\`json\n{ "a": { "b": ["x", "y", "z"] } }\n\`\`\`\n`;
const FIXTURE_NO_MARKER = `text\n\`\`\`json\n{ "a": { "b": ["x", "y", "z"] } }\n\`\`\`\n`;
const FIXTURE_FAR = `<!-- contract-example: a.b = events.CONFIG_FIELDS -->\n\n\n\ntext\n\`\`\`json\n{ "a": 1 }\n\`\`\`\n`;
const FIXTURE_UNPARSEABLE = `<!-- contract-example: . = events.CONFIG_FIELDS -->\n\`\`\`json\n{ "a": … }\n\`\`\`\n`;

/**
 * Markers attached to fences in one document.
 *
 * A fence may carry SEVERAL markers, because one block can publish more than
 * one declared set — `configEchoContract` carries both every knob and the
 * subset the sweep leaves alone. So the walk collects every marker in the run
 * of marker-or-blank lines immediately above the fence, and stops at the first
 * line that is neither. At most MARKER_REACH blank lines may appear in that
 * run; beyond that the markers are no longer "immediately above" anything.
 */
function markedFences(text) {
  const { fences, lines } = fencesOf(text);
  const out = [];
  for (const f of fences) {
    const markers = [];
    let blanks = 0;
    for (let back = 1; ; back += 1) {
      const line = lines[f.first - 1 - back];
      if (line === undefined) break;
      const m = MARKER.exec(line);
      if (m) { markers.unshift({ pointer: m[1], declaration: m[2], text: line.trim() }); continue; }
      if (line.trim() === '') { blanks += 1; if (blanks > MARKER_REACH) break; continue; }
      break;
    }
    out.push({ ...f, markers });
  }
  return out;
}

const selfAccept = markedFences(FIXTURE_ACCEPT);
const selfNoMarker = markedFences(FIXTURE_NO_MARKER);
const selfFar = markedFences(FIXTURE_FAR);
const selfUnparseable = markedFences(FIXTURE_UNPARSEABLE);

const FIXTURE_TWO = `<!-- contract-example: a = events.CONFIG_FIELDS -->\n<!-- contract-example: b = events.PREEMPTION_FIELDS -->\n\`\`\`json\n{ "a": 1 }\n\`\`\`\n`;
const selfTwo = markedFences(FIXTURE_TWO);

check(
  selfAccept.length === 1 && selfAccept[0].markers.length === 1 &&
    selfAccept[0].markers[0].pointer === 'a.b' &&
    selfAccept[0].markers[0].declaration === 'events.CONFIG_FIELDS',
  'self-test: a marker directly above a fence is attached to it',
  JSON.stringify(selfAccept[0]?.markers ?? null)
);
check(
  selfTwo.length === 1 && selfTwo.length === 1 && selfTwo[0].markers.length === 2 &&
    selfTwo[0].markers.map((m) => m.pointer).join(',') === 'a,b',
  'self-test: TWO markers above one fence both attach, in order',
  'one block can publish more than one declared set'
);
check(
  selfNoMarker.length === 1 && selfNoMarker[0].markers.length === 0,
  'self-test: an unmarked fence is reported unmarked, not silently attributed'
);
check(
  selfFar.length === 1 && selfFar[0].markers.length === 0,
  `self-test: a marker more than ${MARKER_REACH} blank line(s) above does NOT attach — REJECTED`,
  'this is the fixture that must fail to match'
);
check(
  parseFence(selfUnparseable[0].body) === null,
  'self-test: a fence that is not JSON parses to null rather than to an empty object',
  'an empty object would make every set in it vacuously agree'
);
check(
  JSON.stringify([...nameSetsOf({ a: { b: ['x', 'y'] }, c: 1 }).keys()]) === JSON.stringify(['.', 'a', 'a.b']),
  'self-test: the walker finds nested name-sets by pointer'
);
check(
  declarationNames('nosuch(events.CONFIG_FIELDS)').names === null &&
    declarationNames('events.NOT_A_THING').names === null,
  'self-test: an unknown derivation and an unresolvable name both REFUSE',
  'closed list — neither passes through as "nothing to check"'
);
const verbatimProbe = declarationNames('verbatim(events.CONFIG_FIELDS)');
check(
  Array.isArray(verbatimProbe.names) && verbatimProbe.names.length > 0,
  'self-test: verbatim() derives a non-empty subset from the real declaration',
  JSON.stringify(verbatimProbe.names)
);

// ============================================== §4 the corpus, and declines --

rule('4. THE CORPUS — every JSON fence under docs/, including what cannot be read');

const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();

/**
 * Which fences are candidates, and the recall cost of the answer.
 *
 * A fence LABELLED `json` or `jsonc` is one the author says is JSON, so failing
 * to parse it is worth reporting — §4 prints it, and a marker on it is a
 * failure. An UNLABELLED fence is attempted too, and kept only if it parses:
 * most of them are shell transcripts and pane dumps, and reporting 29 of those
 * as "not read as JSON" every run would bury the one decline that means
 * something.
 *
 * ⚠ THE COST, which is a real hole and not a rounding: an unlabelled fence that
 * is MEANT to be JSON and does not parse is invisible here — it is silently in
 * the same bucket as a shell transcript. Labelling it `json` is what makes it
 * visible. `scripts/kan512-doc-example-sweep.mjs` counts that population rather
 * than leaving it to be assumed empty.
 */
const DECLARED_JSON = new Set(['json', 'jsonc']);

const blocks = [];
const unreadable = [];
let unlabelledSkipped = 0;
for (const f of docFiles) {
  const rel = path.join('docs', f);
  const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  for (const fence of markedFences(text)) {
    const labelled = DECLARED_JSON.has(fence.info);
    if (!labelled && fence.info !== '') continue;
    const doc = parseFence(fence.body);
    const opening = fence.body.trim().split('\n')[0].trim();
    if (doc === null) {
      if (labelled || fence.markers.length) unreadable.push({ rel, fence, opening });
      else unlabelledSkipped += 1;
      continue;
    }
    blocks.push({ rel, fence, doc, opening, sets: nameSetsOf(doc) });
  }
}

console.log(`   ${docFiles.length} file(s) under docs/; ${blocks.length} readable JSON fence(s), ` +
  `${unreadable.length} declared-JSON fence(s) that would not parse, ` +
  `${unlabelledSkipped} unlabelled fence(s) that are not JSON (shell transcripts and the like)`);

// A fence this script cannot read is printed rather than dropped. It is not
// green — it is outside the gate, and the header says so.
for (const u of unreadable) {
  console.log(`   NOT READ AS JSON  ${u.rel}  opening \`${u.opening}\`` +
    `${u.fence.markers.length ? '  ⚠ AND IT CARRIES A MARKER' : ''}`);
  for (const m of u.fence.markers) {
    check(false, `${u.rel} — marker on a fence that is not JSON`,
      `\`${m.text}\` — the marker claims a check that cannot run`);
  }
}

// ==================================================== §5 marked blocks agree --

rule('5. MARKED BLOCKS — the names in the block are the names in the declaration');

const marked = blocks.flatMap((b) => b.fence.markers.map((marker) => ({ ...b, marker })));

// FAIL CLOSED. Zero markers is not a clean sweep; it is this gate having been
// disconnected from the corpus it audits while still printing a verdict.
check(
  marked.length > 0,
  'the gate is attached to something in the real tree',
  `${marked.length} marked name-set(s)`
);

for (const b of marked) {
  const { pointer, declaration, text } = b.marker;
  const where = `${b.rel} \`${text}\``;

  const node = at(b.doc, pointer);
  if (node === undefined) {
    check(false, where, `the block has nothing at \`${pointer}\``);
    continue;
  }
  const docNames = namesOf(node);
  if (!docNames) {
    check(false, where, `\`${pointer}\` is not a name-set (neither an object nor an array of strings)`);
    continue;
  }
  const { names: declaredNames, why } = declarationNames(declaration);
  if (!declaredNames) {
    check(false, where, `${why} — NOT CHECKED`);
    continue;
  }

  const missing = declaredNames.filter((n) => !docNames.includes(n));
  const invented = docNames.filter((n) => !declaredNames.includes(n));

  // ORDER IS HELD FOR AN ARRAY AND NOT FOR AN OBJECT'S KEYS, deliberately. An
  // array in one of these blocks is a value on the wire — `declared` is
  // literally `Object.keys(CONFIG_FIELDS)` — so its order is part of what the
  // example is showing. An object's key order is how the author laid the
  // example out, and reordering it for readability changes nothing a consumer
  // can observe.
  const ordered = Array.isArray(node);
  const orderOk = !ordered || JSON.stringify(docNames) === JSON.stringify(declaredNames);

  console.log(`\n   ${b.rel}  \`${pointer}\` = ${declaration}`);
  console.log(`     block   (${docNames.length}): ${JSON.stringify(docNames)}`);
  console.log(`     declared(${declaredNames.length}): ${JSON.stringify(declaredNames)}`);

  check(
    missing.length === 0 && invented.length === 0 && orderOk,
    `${where} — \`${pointer}\` matches ${declaration}`,
    missing.length === 0 && invented.length === 0 && orderOk
      ? `${declaredNames.length} name(s)${ordered ? ', in order' : ''}`
      : [
          missing.length ? `MISSING FROM THE DOC: ${missing.join(', ')} — the block is stale and reads as complete` : '',
          invented.length ? `IN THE DOC AND NOT DECLARED: ${invented.join(', ')} — the block names something ${declaration} does not` : '',
          !orderOk && !missing.length && !invented.length
            ? `same names, WRONG ORDER: block ${JSON.stringify(docNames)} vs ${JSON.stringify(declaredNames)}` : ''
        ].filter(Boolean).join('; ')
  );
}

// ============================== §6 an unmarked block that already matches --

rule('6. DISCOVERY — an unmarked block whose names ARE a declared set must say so');

/**
 * Every declared set discovery can attribute against — exports, AND one level
 * inside them.
 *
 * ⚠ THE SECOND LEVEL IS NOT TIDINESS. Without it this half enumerated only
 * top-level exports and reported the tree clean, while
 * `scripts/kan512-doc-example-sweep.mjs` — which always walked one level in —
 * found two ungated blocks in `docs/event-contract.md` it could not see:
 * `pages.standbyAgents` against `read-contract.BLOCK_SHAPES.FleetPage`, and the
 * `configEchoContract` block's own key set against
 * `read-contract.BLOCK_SHAPES.ConfigEchoContract`. A shallower enumeration
 * fails toward the comfortable answer, which is the whole defect class this
 * gate exists for. One level is also exactly how the `contract-table:` markers
 * already name these things (`BLOCK_SHAPES.ConfigEcho`), so the depth is the
 * repository's convention rather than a number picked here.
 */
const allDeclarations = [];
for (const [alias, mod] of loaded) {
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object') continue;
    const names = DERIVATIONS.keys(value);
    if (names.length >= MIN_DISCOVERY && names.every((n) => typeof n === 'string')) {
      allDeclarations.push({ spec: `${alias}.${name}`, names });
    }
    if (Array.isArray(value)) continue;
    for (const [sub, subValue] of Object.entries(value)) {
      if (!subValue || typeof subValue !== 'object' || Array.isArray(subValue)) continue;
      const subNames = Object.keys(subValue);
      if (subNames.length >= MIN_DISCOVERY) {
        allDeclarations.push({ spec: `${alias}.${name}.${sub}`, names: subNames });
      }
    }
  }
}
console.log(`   ${allDeclarations.length} declaration(s) of ${MIN_DISCOVERY}+ names available to attribute against`);

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

let discovered = 0;
for (const b of blocks) {
  for (const [pointer, docNames] of b.sets) {
    if (docNames.length < MIN_DISCOVERY) continue;
    // A pointer one of the block's own markers already covers is not a discovery.
    if (b.fence.markers.some((m) => m.pointer === pointer)) continue;
    const hits = allDeclarations.filter((d) => sameSet(docNames, d.names));
    if (hits.length === 0) continue;
    discovered += 1;
    check(
      false,
      `${b.rel} — unmarked \`${pointer}\` in the fence opening \`${b.opening}\``,
      `its ${docNames.length} names are exactly ${hits.map((h) => h.spec).join(' / ')} — ` +
        `add a contract-example marker naming which, or change the block so it is not a declared set`
    );
  }
}
if (discovered === 0) {
  console.log(`   no unmarked block carries a declared set — every one that does is marked`);
}

// §6 has to be able to find something, or its silence means nothing. This is
// the positive control for the discovery half, run against a fixture rather
// than against the tree, so it holds even once the tree is clean.
const controlNames = allDeclarations[0]?.names ?? [];
const controlDoc = parseFence(JSON.stringify({ example: controlNames }));
const controlSets = nameSetsOf(controlDoc);
check(
  controlNames.length >= MIN_DISCOVERY &&
    [...controlSets.values()].some((names) => allDeclarations.some((d) => sameSet(names, d.names))),
  'CONTROL: the discovery half finds a planted declared set',
  `planted ${allDeclarations[0]?.spec} (${controlNames.length} names) into a synthetic fence and it was attributed`
);

// ================================================================ verdict ---

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
