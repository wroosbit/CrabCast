#!/usr/bin/env node
// KAN-530: a prose COUNT about a gated set is reconciled against the set.
//
// WHAT FAILURE THIS WOULD CATCH: `docs/read-path-contract.md` asserting `the
// five fields` about `BLOCK_SHAPES.ConfigEcho` while that table has six
// members. KAN-528 added `promptChars` and moved the arity from 5 to 6; the
// sentence introducing the table stayed at "five" in SIX places, and every
// check in this repository stayed green — because `verify-read-contract.mjs`
// reconciles WHICH fields the table lists, and every field name on the page
// was present and correct. A membership check has no member to match a number
// against. A person reading the page found it (KAN-512); nothing mechanical
// could have.
//
// This is the sharp form of the epic's shape — a claim that outruns the thing
// under it. The table below the sentence IS gated, and the gate's existence is
// what makes the ungated sentence above it credible: a reader who has learned
// that these tables are checked reads their introductions as equally held.
//
// ---------------------------------------------------------------------------
// WHY A DEFINITE ARTICLE IS PART OF THE RULE
//
// `the five fields [above](#configecho)` is a claim about the SIZE OF THE SET.
// `five fields added to \`capacity\`` — the form every row of a version-history
// table uses — is a DELTA, and reconciling it against the arity would be
// nonsense. The article is what separates them, and it is not a heuristic
// dressed up: "the N Xs" is definite reference to a whole, "N Xs" is a
// quantity of some. Measured on this repository at 234243d, requiring it took
// the linked-subject population from 22 candidates (16 of them version-history
// deltas) to 6, with no false positive and no missed instance of the defect.
//
// WHY ATTRIBUTION RUNS THROUGH ANCHORS, NOT PROXIMITY
//
// The ticket proposed parsing a count "near a `contract-table:` marker". That
// finds ONE of the six occurrences. The other five sit hundreds of lines away
// inside unrelated tables and name their subject with a link — `the five
// fields [above](#configecho)`. So the anchor link is the attribution, and
// proximity is only the fallback for the heading that introduces a table.
//
// WHAT THIS DOES NOT COVER, named because the mechanism looks complete:
//   - A count whose subject is in a different sentence or line ("Five branches
//     and four verdicts" two lines under the heading that names the set).
//   - A count in a section that declares more than one marker: §4 declines to
//     rule rather than guessing which set is meant, and PRINTS every one it
//     declined so the population is visible instead of silently empty.
//   - A noun outside NOUNS, or a number above twenty spelled out.
//   - Any set no marker names — that is KAN-512's class, not this one.
// `scripts/kan530-doc-count-sweep.mjs` is the wider-recall survey over the same
// corpus, and it reports the loose population this gate declines to rule on.
// Neither script owns the gap between them; this comment is where its edge is
// marked.
//
// Needs a build (arities come from `dist/`), no daemon, no network.

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

// ------------------------------------------------------------------ §1 the rule

const NUMBERS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20]
]);

const NOUNS = [
  'fields', 'field', 'members', 'member', 'keys', 'key', 'rows', 'row',
  'values', 'value', 'branches', 'branch', 'shapes', 'shape',
  'categories', 'entries', 'columns', 'column'
];

const NUM = [...NUMBERS.keys()].join('|');

/** `the five fields` — the definite article is required. See the header. */
const SIZE_CLAIM = new RegExp(String.raw`\bthe\s+(${NUM}|\d{1,3})[\s\-](${NOUNS.join('|')})\b`, 'gi');

/**
 * The count phrase, then at most this many characters that are not brackets,
 * then a markdown link to an anchor. `the five fields [above](#configecho)`
 * and `the five fields in [the config echo](#configecho)` both qualify; `three
 * fields added to [UnreadableRecord](#unreadablerecord)` does not reach here
 * at all, because it has no article.
 */
const LINK_REACH = 12;
const ADJACENT_LINK = new RegExp(String.raw`^[^\[\]]{0,${LINK_REACH}}\[[^\]]*\]\(#([a-z0-9._-]+)\)`, 'i');

/**
 * `the five-field config echo` — a claim whose subject is the section's own
 * NAME rather than a link to it. Attribution here is exact: the words after
 * the count are normalised to letters and digits and must EQUAL an anchor the
 * document already publishes. Nothing fuzzy, and no substring matching.
 *
 * ⚠ It is deliberately this tight because of what sits next to it in the
 * corpus. `the one row shape here that is …`, `the one field a consumer is
 * meant to branch on`, `the one row it …` — three occurrences in two files
 * where **"the one X" means "the ONLY X"** and is not a count at all.
 * Reconciling those against an arity would be a false red on correct prose, so
 * every one of them must fail to name an anchor, and does: `rowshape`,
 * `fieldaconsumer` and `rowit` are not anchors in these documents.
 */
const NAMED_SUBJECT_WORDS = 3;

const MARKER = /<!--\s*(?:contract-table|contract-values|contract-branches|contract-activate-branches|send-table|send-values|send-branches):\s*([A-Za-z0-9_.]+)\s*-->/g;

/** Anchors and prose names compare with punctuation and spacing removed. */
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADING = /^(#{1,6})\s+(.*)$/;

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
const slugify = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

// --------------------------------------------------------- §2 the declarations

const readContract = await import(path.join(distDir, 'read-contract.js'));
const sendContract = await import(path.join(distDir, 'send-contract.js'));

function arityOf(name) {
  for (const mod of [readContract, sendContract]) {
    let node = mod;
    let ok = true;
    for (const part of name.split('.')) {
      if (node && typeof node === 'object' && part in node) node = node[part];
      else { ok = false; break; }
    }
    if (ok && node && typeof node === 'object') return Object.keys(node).length;
  }
  return null;
}

// ------------------------------------------------------------- §3 the document

/**
 * Split a document into sections at its headings, and record every name a
 * reader could reach a section by: the heading's generated slug, and any
 * explicit `<a id="…">` sitting in it or immediately above its heading.
 */
function sectionsOf(lines) {
  const sections = [];
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) sections.push({ start: i, end: lines.length, heading: line, slugs: new Set([slugify(h[2])]) });
  });
  sections.forEach((s, i) => { if (sections[i + 1]) s.end = sections[i + 1].start; });

  const sectionAt = (i) => sections.find((s) => i >= s.start && i < s.end) ?? null;

  lines.forEach((line, i) => {
    for (const m of line.matchAll(/<a\s+id="([^"]+)"/g)) {
      // An anchor sitting immediately above a heading names that heading's
      // section, which is how this repository's documents are written.
      const target = sectionAt(i + 1) ?? sectionAt(i);
      if (target) target.slugs.add(m[1].toLowerCase());
    }
  });

  for (const s of sections) {
    s.markers = [];
    for (let i = s.start; i < s.end; i += 1) {
      MARKER.lastIndex = 0;
      let m;
      while ((m = MARKER.exec(lines[i])) !== null) s.markers.push(m[1]);
    }
  }
  return sections;
}

// ---------------------------------------------------------- §4 the reconciliation

/**
 * Every size claim in one document, with the set it names — or the reason no
 * set could be named. Returns rulings AND declines; §5 prints both, because a
 * gate that silently drops what it cannot rule on reports the same all-clear
 * as one that found nothing wrong.
 */
function claimsIn(rel, text) {
  const lines = text.split('\n');
  const sections = sectionsOf(lines);
  const bySlug = new Map();
  for (const s of sections) for (const slug of s.slugs) bySlug.set(slug, s);

  const rulings = [];
  const declines = [];

  lines.forEach((line, i) => {
    SIZE_CLAIM.lastIndex = 0;
    let m;
    while ((m = SIZE_CLAIM.exec(line)) !== null) {
      const word = m[1].toLowerCase();
      const stated = NUMBERS.get(word) ?? Number(word);
      const quote = m[0];
      const at = `${rel}:${i + 1}`;
      const rest = line.slice(m.index + m[0].length);

      // (a) the claim names its subject with a link.
      const link = ADJACENT_LINK.exec(rest);
      if (link) {
        const section = bySlug.get(link[1].toLowerCase());
        if (!section) { declines.push({ at, quote, why: `link #${link[1]} names no section` }); continue; }
        if (section.markers.length !== 1) {
          declines.push({ at, quote, why: `section for #${link[1]} declares ${section.markers.length} markers` });
          continue;
        }
        rulings.push({ at, quote, stated, set: section.markers[0], how: 'linked' });
        continue;
      }

      // (b) the claim names its subject by the section's own published name.
      const words = rest.match(/^[ \t]*([A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z][A-Za-z0-9]*){0,2})/);
      if (words) {
        const parts = words[1].split(/[ \t]+/);
        let named = null;
        for (let n = NAMED_SUBJECT_WORDS; n >= 1 && !named; n -= 1) {
          const candidate = normalise(parts.slice(0, n).join(''));
          if (!candidate) continue;
          for (const [slug, section] of bySlug) {
            if (normalise(slug) === candidate) { named = { slug, section }; break; }
          }
        }
        if (named) {
          if (named.section.markers.length === 1) {
            rulings.push({ at, quote, stated, set: named.section.markers[0], how: 'named' });
          } else {
            declines.push({ at, quote, why: `section named "${named.slug}" declares ${named.section.markers.length} markers` });
          }
          continue;
        }
      }

      // (c) the claim is in the heading that introduces exactly one table.
      const h = HEADING.exec(line);
      if (h) {
        const section = sections.find((s) => s.start === i);
        if (section && section.markers.length === 1) {
          rulings.push({ at, quote, stated, set: section.markers[0], how: 'heading' });
          continue;
        }
        declines.push({ at, quote, why: `heading's section declares ${section ? section.markers.length : 0} markers` });
        continue;
      }

      declines.push({ at, quote, why: 'no linked or heading subject' });
    }
  });

  return { rulings, declines };
}

// ------------------------------------------------------------- §5 the self-test
//
// Before sweeping the real tree, require the detector to accept a fixture it
// must accept and reject one it must reject. Guard (b) of verify-proof-
// verdicts' three, for the same reason: the failure being hunted is a check
// that quietly matches nothing, and such a check reports a clean sweep.

const ACCEPTED = [
  '<a id="fx"></a>',
  '### The fixture — the two fields it stands for',
  '<!-- contract-table: BLOCK_SHAPES.Preempted -->',
  '',
  '| *x* | durable | the two fields [above](#fx) |'
].join('\n');

const REJECTED = [
  '<a id="fx"></a>',
  '### The fixture',
  '<!-- contract-table: BLOCK_SHAPES.Preempted -->',
  '',
  '| 7 | KAN-1 — three fields added to [the fixture](#fx) |'
].join('\n');

const acc = claimsIn('fixture-accept.md', ACCEPTED);
check(
  acc.rulings.length === 2 && acc.rulings.every((r) => r.set === 'BLOCK_SHAPES.Preempted' && r.stated === 2),
  'self-test: a size claim in a heading AND in a linked cell are both attributed',
  `${acc.rulings.length} ruling(s): ${acc.rulings.map((r) => `${r.how}/${r.stated}`).join(', ') || 'NONE'}`
);

const rej = claimsIn('fixture-reject.md', REJECTED);
check(
  rej.rulings.length === 0,
  'self-test: an article-less delta ("three fields added to …") is NOT ruled on',
  `${rej.rulings.length} ruling(s)`
);

// A detector that accepts everything would pass the first test and fail this
// one; a detector that accepts nothing would pass the second and fail the
// first. Neither test alone says anything.

// ---------------------------------------------------------------- §6 the sweep

const docs = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();

const allRulings = [];
const allDeclines = [];
for (const f of docs) {
  const { rulings, declines } = claimsIn(path.join('docs', f), fs.readFileSync(path.join(docsDir, f), 'utf8'));
  allRulings.push(...rulings);
  allDeclines.push(...declines);
}

console.log(`\nswept ${docs.length} files under docs/ — ${allRulings.length} size claim(s) attributed to a gated set\n`);

// FAIL CLOSED. Zero subjects is not a clean sweep; it is this detector having
// become the defect it hunts. Guard (a) of verify-proof-verdicts' three.
check(
  allRulings.length > 0,
  'the detector matched something in the real tree',
  `${allRulings.length} attributed claim(s)`
);

for (const r of allRulings) {
  const arity = arityOf(r.set);
  if (arity === null) {
    check(false, `${r.at}  "${r.quote}"`, `${r.set} resolves to no declaration — NOT CHECKED`);
    continue;
  }
  check(
    arity === r.stated,
    `${r.at}  "${r.quote}"  [${r.how}]`,
    arity === r.stated
      ? `${r.set} has ${arity}`
      : `the page says ${r.stated}, ${r.set} has ${arity} — the prose and the table disagree`
  );
}

if (allDeclines.length > 0) {
  console.log(`\ndeclined to rule on ${allDeclines.length} count phrase(s) — no unambiguous subject:`);
  for (const d of allDeclines) console.log(`  ${d.at}  "${d.quote}"  (${d.why})`);
  console.log('\nThese are NOT green. They are outside this gate, and the header says so.');
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
