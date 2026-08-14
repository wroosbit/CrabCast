#!/usr/bin/env node
// KAN-173: every pane a proof in this suite opens is reclaimed by that proof,
// or classified in the register below with a reason a reader can act on.
//
// WHAT FAILURE THIS WOULD CATCH: a proof added to this suite that opens a herdr
// pane and does not put it back. It reports PASS, it leaves no trace in its own
// output, and the pane outlives it — for ever, because nothing in this fleet
// reclaims one. THREE SUCH PANES HAVE BEEN UP SINCE 2026-08-05 and were still
// up when this file was written nine days later:
//
//   crabcast-kan16-dtll-d810af87
//   crabcast-kan16-lx8a-6dca2d30dc1d7cf9
//   crabcast-second-18610fdbc65e0934
//
// KAN-137 fixed ONE script's leak by counting panes around it. This is what
// notices the next one, before it runs rather than nine days after.
//
// ---------------------------------------------------------------------------
// WHY A REGISTER AND NOT A PREDICATE — the same reason KAN-179 gives, arrived
// at from the other side
// ---------------------------------------------------------------------------
//
// WHETHER A PANE-OPENING CALL LEAKS DEPENDS ON WHETHER IT REACHES A REAL HERDR,
// AND THAT IS NOT IN THE TEXT. Two textually identical `spawnSync('herdr',
// ['agent', 'start', …])` calls sit in this suite: one in
// `verify-tail-asks-every-source`, which wrote a stub named `herdr` into a
// scratch directory and put it on `PATH` four lines earlier, and one in
// `verify-tail-source-boundary-live`, which deliberately did not, because a
// herdr nobody in the process wrote is the whole point of that file. The first
// opens nothing; the second opens a real pane on the operator's machine.
//
// A PREDICATE COULD ALMOST DECIDE THAT, AND ALMOST IS THE DANGEROUS PART. "Does
// the script install a file named `herdr` on PATH" is one grep, and it is WRONG
// IN THE DIRECTION THAT COSTS: `verify-send-confirms-delivery-live` and
// `verify-pretrust-survives-concurrency` both install a file named `herdr` —
// a wrapper and a symlink respectively, both of which EXEC THE REAL BINARY.
// A sweep immunising on that grep would mark the two scripts that most
// certainly reach a real herdr as the ones that cannot. So the shim question
// is a CLASSIFICATION, carrying a reason naming which kind of `herdr` was
// installed, and a reader checks it. That is the cost this design pays on
// purpose.
//
// A SCRIPT IN NEITHER THE IMMUNISED SET NOR THE REGISTER IS REPORTED AS
// **UNCLASSIFIED**, NOT AS A LEAK. "Nobody has said what this one is" is the
// honest verdict and it is still a red; the failure detail says so in those
// words.
//
// ---------------------------------------------------------------------------
// WHAT IS MECHANICAL HERE AND WHAT IS JUDGEMENT
// ---------------------------------------------------------------------------
//
// MECHANICAL (this script fails on all of it):
//
//   - pane-opening sites are FOUND by three detectors and a lexer that excludes
//     comments, self-tested in §1 against fixtures that must be ACCEPTED and
//     fixtures that must be REJECTED
//   - a script carrying BOTH halves of the discipline — a census read AND a
//     reclamation call — is IMMUNISED and needs no entry (§1, §3)
//   - every remaining script is accounted for by the register BY EXACT COUNT,
//     so a new pane-opening site inside an already-registered script is a red
//     rather than a silent adoption of somebody else's reason (§3)
//   - every entry names a tracked proof, carries a classification from a CLOSED
//     vocabulary, a reason, and an `evidence` anchor that must still appear in
//     that file (§2)
//   - the census reader is held to fixtures whose answers CANNOT be produced by
//     the two accidents that have already happened here, and is required to
//     distinguish "zero panes" from "I could not read this" (§4)
//   - the sweep is non-zero on every axis it reports, so a run that matched
//     nothing cannot pass trivially (§5)
//
// JUDGEMENT (reviewed like code, and this script cannot check it):
//
//   - whether a `classification` is TRUE of the script it covers. An entry
//     saying `herdr-is-shimmed` with an anchor that exists is checkable;
//     whether the file that anchor names really is a stub rather than a wrapper
//     around the real binary is a reading — and it is exactly the reading the
//     paragraph above says a predicate must not be trusted to make.
//   - whether a site classified `text-match` really is text rather than a call.
//     Two of them here are `console.log` lines printing what a call returned.
//
// ---------------------------------------------------------------------------
// WHY `evidence` IS TEXT AND NOT A LINE NUMBER — inherited, and measured
// ---------------------------------------------------------------------------
//
// KAN-179 measured this file's neighbour: three line numbers exactly right at
// one commit were pointing 1,270 lines away nine days later, with nothing red
// in between. A citation is a claim about a file at a commit, and a line number
// is the half of it that rots silently. Every `evidence` field here is LITERAL
// TEXT this script requires to still be in the file it names. Renaming the
// mechanism reddens the entry; moving it does not.
//
// ---------------------------------------------------------------------------
// WHY THE COUNTER IS A SEPARATE SECTION WITH ITS OWN CANARY (§4)
// ---------------------------------------------------------------------------
//
// KAN-173's own ticket carries the warning, and the agent that wrote the
// warning then walked into it TWICE while checking the premise:
//
//   - `herdr pane list | wc -l` reported `1` panes, and `grep -c crabcast`
//     reported `1` crabcast panes. The true numbers are 119 and 3. `herdr pane
//     list` is ONE LINE of JSON, so every line-counter answers `1` whatever is
//     in it — before a leak and after one.
//   - a first pass at parsing it guessed the keys (`panes`, `data`, a bare
//     array) and reported **0 panes from a 26 KB file**. The real shape is
//     `result.panes`.
//
// BOTH WRONG ANSWERS CAME FROM COMMANDS THAT EXITED CLEANLY, and the second is
// the worse one: a counter that answers `0` when it cannot read its input is
// indistinguishable from a machine with no panes on it, which is the answer a
// reclamation check most wants to hear. So `readPaneCensus` NEVER RETURNS A
// BARE NUMBER. It returns `{ ok: true, panes }` or `{ ok: false, reason }`, and
// an unreadable census is therefore not merely detected but UNREPRESENTABLE as
// a count — the caller cannot add it up without first destructuring past `ok`.
// §4 holds it to fixtures where the right answer is a triple no line-counter
// and no key-guesser could have produced, and to a doctored input it must
// REFUSE rather than round down.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT SEE — the boundary, stated because "everything is caught"
// has been wrong in this repository five times
// ---------------------------------------------------------------------------
//
//   1. THE DETECTORS ARE THREE FORMS. A pane opened by a fourth spelling is
//      invisible here. `activate_agent` is deliberately NOT one of them: an
//      activation reaches `spawnSession` through the router, so every activating
//      proof would be a site, and 60 of the 70 proofs activate. The detectors
//      are the three calls that reach `herdr agent start` directly, which is
//      where the pane is actually created (`startAgentInOwnTab`, herdr.ts).
//      A PROOF THAT OPENS A PANE ONLY BY ACTIVATING THROUGH A REAL DAEMON IS
//      OUTSIDE THIS SWEEP, and nothing here can say so.
//   2. IT READS ONE FILE AT A TIME. A fixture in a shared module that opens a
//      pane on a proof's behalf is attributed to the module, and modules are not
//      swept — only tracked `scripts/verify-*.mjs` are.
//   3. IT CANNOT SEE WHETHER A RECLAMATION RUNS. `closeAgentByPath` in a
//      `finally` and `closeAgentByPath` after an early `process.exit` are the
//      same text. The immunisation this file grants is "the script contains
//      both halves of the discipline", never "the script performs them on every
//      path". `verify-no-attach-steal` §4 is what asserts that property for one
//      script, by reading the census back; nothing asserts it for the others,
//      and KAN-169 is the interrupted-path half of the same question.
//   4. IT IS STATIC. It reads text. It opens no pane, closes no pane, and needs
//      no herdr. §6 reads a live census when one is reachable and reports it as
//      a DIAGNOSTIC — it is not a gate, because a check whose verdict depends on
//      what happens to be running on the operator's machine is a check that goes
//      red about the machine.
//
// ---------------------------------------------------------------------------
// WHAT §7 SUPPLIES ITSELF, and what that leaves uncovered
// ---------------------------------------------------------------------------
//
// §7 WRITES THE PROOF IT THEN CATCHES. It copies `scripts/` to a scratch
// repository, adds a scratch proof that opens a pane and reclaims nothing, and
// requires this check to go red naming that file — then adds a register entry
// for it and requires green. That proves THE SWEEP AND THE REGISTER REPORT
// CORRECTLY ABOUT A TREE THEY WERE HANDED. It does NOT prove that the register
// committed here is TRUE, and it cannot: whether the `herdr` that
// `verify-tail-asks-every-source` puts on `PATH` is a stub is a reading.
//
// WHO COVERS THAT: a reviewer reading the entries, which is why each names the
// specific mechanism rather than the category — the line that writes the stub,
// the line that closes the pane. There is NO runtime backstop for a reading
// that was wrong, and that is the honest state rather than an omission: the
// pane would simply be left, on the operator's machine, silently, exactly as
// the three named at the top of this file were. §6's live diagnostic is the
// nearest thing to one and it is a report, not a gate. Said here rather than
// left for a reader to infer.
//
// Needs no daemon, no herdr, no network and no build: it asks git what is
// tracked and reads the files. It spawns copies of ITSELF in §7 and nothing
// else. Exits non-zero on any failure so a reviewer can re-run it against the
// PR head.
//
// Usage:
//   node scripts/verify-panes-are-reclaimed.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const selfPath = fileURLToPath(import.meta.url);
const SELF = path.basename(selfPath, '.mjs');

/**
 * Set on the children §7 spawns, so a child does not run §7 and spawn children
 * of its own for ever. A recursion guard rather than a switch: §1-§6 all still
 * run in the child, which is the whole point of spawning it.
 */
const IS_CHILD = process.env.CRABCAST_PANE_SWEEP_CHILD === '1';

/**
 * A child audits a scratch tree, so it cannot find the repository by walking up
 * from its own path. §7 hands it the root; nothing else sets this, and a run
 * with it unset behaves exactly as before it existed.
 */
const repoRoot = process.env.CRABCAST_PANE_SWEEP_REPO ?? path.resolve(path.dirname(selfPath), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

// ===========================================================================
// THE SWEEP
//
// Everything in this block is a pure function of a file's text, which is what
// lets §1 self-test it on fixtures rather than only on the tree it happens to
// be run against.
// ===========================================================================

/**
 * Per-index flag: is this character inside a comment?
 *
 * Comments only, and the asymmetry is deliberate. A detector match inside a
 * COMMENT is prose about a call, never a call. A match inside a STRING is
 * usually the call itself — `'agent', 'start'` is how the herdr CLI verb is
 * spelled, so a sweep that skipped string bodies would find almost nothing and
 * report a clean tree. The two `spawnSession(` matches that really are text
 * (`console.log` lines printing what a call returned) are handled by the
 * register's `text-match` classification, where a reader can see them, rather
 * than by a lexer rule that would also delete the `agent start` detector.
 */
function lexComments(src) {
  const comment = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      comment.fill(1, i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      comment.fill(1, i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      // Strings are not flagged, but they must still be SKIPPED, or a `//`
      // inside one ("http://…") would comment out the rest of the file.
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j += 1;
      }
      i = Math.min(j + 1, src.length);
    } else i += 1;
  }
  return comment;
}

/**
 * The three ways a proof in this suite reaches `herdr agent start` — the call
 * that actually creates a pane.
 *
 * `activate_agent` is NOT here; see boundary 1 in the header for why.
 */
const OPEN_DETECTORS = [
  { name: 'bridge-spawnSession', re: () => /spawnSession\s*\(/g },
  { name: 'bridge-own-tab', re: () => /startAgentInOwnTab\s*\(/g },
  { name: 'herdr-agent-start', re: () => /['"]agent['"]\s*,\s*['"]start['"]/g }
];

/**
 * The two halves of the discipline KAN-173 decided to require, each detected
 * separately because a script with one and not the other is exactly the case
 * the register exists to make somebody explain.
 *
 * RECLAIM is "something here closes a pane". CENSUS is "something here reads
 * the pane population", which is what `baseline+1` needs and what makes a
 * reclamation assertable rather than merely performed.
 */
const RECLAIM_DETECTORS = [
  { name: 'close-by-path', re: () => /closeAgentByPath\s*\(/g },
  { name: 'terminate-session', re: () => /terminateSession\s*\(/g },
  { name: 'herdr-pane-close', re: () => /['"]pane['"]\s*,\s*['"]close['"]/g }
];

const CENSUS_DETECTORS = [
  { name: 'bridge-census', re: () => /listHerdrAgents\w*\s*\(/g },
  { name: 'herdr-agent-list', re: () => /['"]agent['"]\s*,\s*['"]list['"]/g },
  { name: 'herdr-pane-list', re: () => /['"]pane['"]\s*,\s*['"]list['"]/g }
];

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

/** Every match of `detectors` in `src` that is not inside a comment. */
function sitesFor(src, detectors) {
  const comment = lexComments(src);
  const out = [];
  for (const d of detectors) {
    const re = d.re();
    let m;
    while ((m = re.exec(src)) !== null) {
      if (comment[m.index]) continue;
      out.push({ detector: d.name, index: m.index, line: lineOf(src, m.index) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const openSites = (src) => sitesFor(src, OPEN_DETECTORS);
const reclaimSites = (src) => sitesFor(src, RECLAIM_DETECTORS);
const censusSites = (src) => sitesFor(src, CENSUS_DETECTORS);

/**
 * The immunisation predicate: a script carrying BOTH halves needs no entry.
 *
 * Deliberately a whole-file property and not a per-site one, because
 * reclamation IS a whole-file property — it lives in a `finally` or a signal
 * handler, not beside the call it undoes. What that buys and what it does not
 * is boundary 3 in the header: this says the discipline is PRESENT, never that
 * it runs on every path.
 */
function immunised(src) {
  return reclaimSites(src).length > 0 && censusSites(src).length > 0;
}

// ===========================================================================
// THE CENSUS READER
//
// One function, exported to §4's fixtures and to §6's live read. It is the
// thing KAN-173's ticket says must be "shown to be a measurement rather than a
// constant", and it is written so that its two known failure modes cannot be
// reported as counts.
// ===========================================================================

/** The prefix CrabCast names its own panes with (`PANE_NAME_PREFIX`, identity.ts). */
const CRABCAST_PREFIX = 'crabcast-';

/**
 * Read `herdr pane list` output into a census, or refuse.
 *
 * RETURNS A DISCRIMINATED RESULT, NEVER A NUMBER. `{ ok: false }` and "zero
 * panes" are different answers and a caller cannot conflate them by accident,
 * because there is no count to read until `ok` has been checked. That is the
 * whole design: the two wrong answers this repository has already produced
 * (`1` from a line count, `0` from a key guess) were both COUNTS, and a count
 * is a shape that cannot say "I did not understand the input".
 *
 * `label` rather than `name`: `herdr pane list` publishes a pane's herdr agent
 * name under `label`, and `herdr agent list` publishes the same string under
 * `name`. Reading `name` off a pane list yields undefined for every row and a
 * crabcast count of zero on a machine carrying three — measured 2026-08-14.
 */
export function readPaneCensus(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty output — herdr answered nothing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not JSON: ${err.message}` };
  }
  const panes = parsed?.result?.panes;
  if (!Array.isArray(panes)) {
    return {
      ok: false,
      reason:
        `no array at result.panes (top-level keys: ${
          parsed && typeof parsed === 'object' ? Object.keys(parsed).join(', ') || '(none)' : typeof parsed
        }). Refusing to report a count for a shape this reader does not know — ` +
        `a guess here answers 0 and reads as an empty machine.`
    };
  }
  const labelled = panes.filter((p) => typeof p?.label === 'string' && p.label !== '');
  return {
    ok: true,
    panes,
    total: panes.length,
    labelled: labelled.map((p) => p.label),
    crabcast: labelled.map((p) => p.label).filter((l) => l.startsWith(CRABCAST_PREFIX))
  };
}

// ===========================================================================
// THE REGISTER
//
// One entry per (script, classification). Fields:
//
//   script          basename, no extension
//   classification  one of CLASSIFICATIONS below — the CLOSED vocabulary
//   sites           EXACT number of pane-opening sites in that script with this
//                   classification. An exact count, not a floor: adding a site
//                   to a registered script must go red rather than be adopted
//                   by somebody else's reason.
//   reason          why this does not leak a pane, in terms a reader can CHECK
//                   — the mechanism and where it is, never "exempt"
//   evidence        literal text that must still appear in that file
//
// WHY THE KEY IS (script, classification) AND NOT (script, site). A per-site
// register needs a per-site IDENTITY and there is no honest one: a line number
// rots silently and the call text is not unique — three of the five sites in
// `verify-spawn-failure-legibility` are the identical string. So the key is
// what CAN be checked and the count is what makes forgetting loud. When a
// script has two classifications — `verify-state-read-echoes-config` does —
// the reasons say which sites they cover, in prose, and this script cannot
// check that they got it right. That limit is the JUDGEMENT half above.
// ===========================================================================

/**
 * The vocabulary, closed.
 *
 * The value is not a verdict on the proof. It is the ANSWER TO ONE QUESTION:
 * why does this pane-opening site not leave a pane on the machine?
 */
const CLASSIFICATIONS = new Set([
  // A stub named `herdr` is on PATH before the call runs, so `agent start`
  // reaches a script this proof wrote and no pane is created anywhere.
  'herdr-is-shimmed',
  // The herdr is real but PRIVATE: the proof started its own server on its own
  // socket, and the panes die with it.
  'private-herdr-server',
  // The pane is real and the proof closes it by `pane_id`, without reading a
  // census — half the discipline, present and named.
  'reclaims-by-pane-id',
  // Not a call at all: a `console.log` printing what a call returned, a table
  // of verb names, prose in a template literal.
  'text-match'
]);

const PANE_OPENERS = [
  // -------------------------------------------------------------------------
  // herdr-is-shimmed — `agent start` reaches a stub this proof wrote
  // -------------------------------------------------------------------------
  {
    script: 'verify-send-confirms-delivery',
    classification: 'herdr-is-shimmed',
    sites: 1,
    reason:
      'Its one `spawnSync(\'herdr\', [\'agent\', \'start\', …])` runs after the file has written a ' +
      'stub into `shimDir` and prepended it to `PATH`. The stub is `#!/bin/bash exec node ' +
      '<shimImpl>` — it execs THIS REPOSITORY\'S OWN shim implementation, never the herdr binary — ' +
      'so the call creates a row in a JSON file and no pane on any machine.',
    evidence: "fs.writeFileSync(path.join(shimDir, 'herdr')"
  },
  {
    script: 'verify-submit-withheld-at-dialog',
    classification: 'herdr-is-shimmed',
    sites: 1,
    reason:
      'Same shape and the same stub: `path.join(shimDir, \'herdr\')` is written as a bash exec of ' +
      'this repository\'s shim implementation and `PATH` is rewritten to find it first, three ' +
      'dozen lines before the `agent start`. The dialog this file is about is one the shim renders, ' +
      'so a real herdr would defeat the proof rather than merely cost a pane.',
    evidence: "process.env.PATH = `${shimDir}:${process.env.PATH}`"
  },
  {
    script: 'verify-tail-asks-every-source',
    classification: 'herdr-is-shimmed',
    sites: 1,
    reason:
      'The stub is the SUBJECT here, not scaffolding: this file drives the three read sources ' +
      'through a herdr it wrote so it can make one of them answer `""` on demand, which no real ' +
      'herdr can be asked to do. Its live sibling `verify-tail-source-boundary-live` is the one ' +
      'that reaches a real herdr, and that one carries its own entry below.',
    evidence: "process.env.PATH = `${shimDir}:${process.env.PATH}`"
  },
  {
    script: 'verify-state-read-echoes-config',
    classification: 'herdr-is-shimmed',
    sites: 2,
    reason:
      'Two real `bridge.spawnSession(…)` calls, both reaching a stub: the file writes ' +
      '`path.join(bin, \'herdr\')` and sets `process.env.PATH` to find it first during setup, and ' +
      'restores the real `PATH` only in its teardown. The pane those two calls open exists in the ' +
      'stub\'s JSON census and nowhere else.',
    evidence: "process.env.PATH = `${bin}:${realPath}`"
  },

  // -------------------------------------------------------------------------
  // text-match — not a call
  // -------------------------------------------------------------------------
  {
    script: 'verify-state-read-echoes-config',
    classification: 'text-match',
    sites: 2,
    reason:
      'Two of its four `spawnSession(` matches are inside a template literal in a `console.log` ' +
      'that prints what the two real calls above returned — `spawnSession(<dir>).resumedConversation ' +
      '= …`. They open nothing. They are matched because this file\'s lexer deliberately does not ' +
      'skip string bodies (a detector that did would lose the `agent start` verb entirely), and ' +
      'they are here rather than predicated away so a reader can see the decision.',
    evidence: 'resumedConversation ='
  },

  // -------------------------------------------------------------------------
  // private-herdr-server — real herdr, and it dies with the run
  // -------------------------------------------------------------------------
  {
    script: 'verify-spawn-failure-legibility',
    classification: 'private-herdr-server',
    sites: 5,
    reason:
      'The most panes any proof here opens, and none of them is on the operator\'s herdr: this ' +
      'file sets `HERDR_SOCKET_PATH` to a socket inside its own scratch directory and starts a ' +
      'herdr server against it, so every `agent start` and every `spawnSession` lands in a server ' +
      'whose whole state is that directory. The five sites are one `agent start` anchor plus four ' +
      '`spawnSession` calls (geometry, control, mutant, fdlimit). Reclamation would be closing ' +
      'panes in a server that is about to be killed.',
    evidence: "process.env.HERDR_SOCKET_PATH = path.join(runDir, 'h.sock')"
  },

  // -------------------------------------------------------------------------
  // reclaims-by-pane-id — real pane, closed by id, no census read
  // -------------------------------------------------------------------------
  {
    script: 'verify-tail-source-boundary-live',
    classification: 'reclaims-by-pane-id',
    sites: 1,
    reason:
      'A REAL pane on the operator\'s herdr — deliberately, because a herdr nobody in this process ' +
      'wrote is what the file exists to read. It closes that pane by `pane_id` in its teardown, ' +
      'which is the reclamation half of the discipline. It does NOT read a census on either side, ' +
      'so it cannot assert baseline+1 and cannot report a pane that failed to close; that is why ' +
      'it is here rather than immunised.',
    evidence: "herdr(['pane', 'close', id])"
  }
];

// ===========================================================================

console.log(`=== 0. What is being audited ===\n`);
console.log(`  repository root: ${repoRoot}`);
console.log(`  role:            ${IS_CHILD ? 'CHILD (§7 skipped)' : 'parent'}\n`);

// ---------------------------------------------------------------------------
// 1. The detectors, self-tested.
//
// A detector that recognises nothing reports the same all-clear as one that
// recognises everything, so the instrument is tested before it is used —
// against fixtures that must be ACCEPTED and, more importantly, fixtures that
// must be REJECTED.
// ---------------------------------------------------------------------------

console.log('=== 1. The instrument, before it is pointed at anything ===\n');

/** `[label, source, expected open sites, expected immunised]` */
const FIXTURES = [
  [
    'a bridge spawn is a pane-opening site',
    `const s = bridge.spawnSession(dir, CONFIG);`,
    1, false
  ],
  [
    'the herdr verb is found however the array is spaced',
    `herdr(['agent','start', name]);\n` +
      `spawnSync('herdr', [ 'agent' , 'start' , other ]);`,
    2, false
  ],
  [
    'startAgentInOwnTab is a site',
    `bridge.startAgentInOwnTab(name, dir, command);`,
    1, false
  ],
  [
    // The direction that matters most: a file that talks ABOUT opening panes.
    'a commented-out spawn is not a site',
    `// const s = bridge.spawnSession(dir, CONFIG);\n` +
      `/* herdr(['agent', 'start', name]); */`,
    0, false
  ],
  [
    'a block comment does not swallow the code after it',
    `/* prose about spawnSession( */\n` +
      `const s = bridge.spawnSession(dir, CONFIG);`,
    1, false
  ],
  [
    // A `//` inside a string used to comment out the rest of the file.
    'a URL in a string does not comment out the rest of the file',
    `const url = 'https://example.invalid/x';\n` +
      `const s = bridge.spawnSession(dir, CONFIG);`,
    1, false
  ],
  [
    'both halves present immunises',
    `const before = bridge.listHerdrAgents();\n` +
      `const s = bridge.spawnSession(dir, CONFIG);\n` +
      `bridge.closeAgentByPath(dir);`,
    1, true
  ],
  [
    'the herdr CLI spelling of both halves also immunises',
    `const before = herdr(['pane', 'list']);\n` +
      `herdr(['agent', 'start', name]);\n` +
      `herdr(['pane', 'close', id]);`,
    1, true
  ],
  [
    // Half the discipline is not the discipline — this is the case
    // verify-tail-source-boundary-live is in, and it must need an entry.
    'reclamation WITHOUT a census read does not immunise',
    `herdr(['agent', 'start', name]);\n` +
      `herdr(['pane', 'close', id]);`,
    1, false
  ],
  [
    'a census read WITHOUT reclamation does not immunise',
    `const before = bridge.listHerdrAgents();\n` +
      `const s = bridge.spawnSession(dir, CONFIG);`,
    1, false
  ],
  [
    // The false-green direction: prose about cleaning up must not immunise.
    'a COMMENT promising reclamation does not immunise',
    `const before = bridge.listHerdrAgents();\n` +
      `const s = bridge.spawnSession(dir, CONFIG);\n` +
      `// the finally below calls closeAgentByPath(dir) on every path`,
    1, false
  ],
  [
    'a file with no pane-opening site at all is not a subject',
    `const before = bridge.listHerdrAgents();\n` +
      `bridge.closeAgentByPath(dir);`,
    0, true
  ]
];

for (const [label, src, expectOpens, expectImmune] of FIXTURES) {
  const opens = openSites(src);
  const immune = immunised(src);
  check(
    opens.length === expectOpens && immune === expectImmune,
    `fixture: ${label}`,
    `${opens.length} site(s) (expected ${expectOpens}), immunised=${immune} (expected ${expectImmune})` +
      (opens.length ? ` — detectors: ${opens.map((s) => s.detector).join(', ')}` : '')
  );
}

// A fixture set that recognised nothing would pass every line above with the
// same words it uses when everything works.
const fixtureOpens = FIXTURES.reduce((n, [, , o]) => n + o, 0);
const fixtureImmune = FIXTURES.filter(([, , , i]) => i).length;
check(
  fixtureOpens > 0 && fixtureImmune > 0 && fixtureImmune < FIXTURES.length,
  'the fixtures exercise both verdicts',
  `${fixtureOpens} site(s) across ${FIXTURES.length} fixtures; ${fixtureImmune} must immunise and ` +
    `${FIXTURES.length - fixtureImmune} must not`
);

// ---------------------------------------------------------------------------
// 2. The register, held to the standard it is an escape hatch from.
// ---------------------------------------------------------------------------

console.log('\n=== 2. The register ===\n');

const tracked = execFileSync('git', ['ls-files', 'scripts'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const proofs = tracked
  .filter((f) => /^scripts\/verify-[^/]*\.mjs$/.test(f))
  .map((f) => path.basename(f, '.mjs'))
  .sort();
const proofSet = new Set(proofs);
const sourceOf = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', `${name}.mjs`), 'utf8');

const pairs = new Set();
for (const e of PANE_OPENERS) {
  const key = `${e.script} :: ${e.classification}`;
  check(!pairs.has(key), `no duplicate entry for ${e.script} / ${e.classification}`);
  pairs.add(key);

  check(
    CLASSIFICATIONS.has(e.classification),
    `'${e.script}' uses a classification from the closed vocabulary`,
    CLASSIFICATIONS.has(e.classification)
      ? e.classification
      : `${JSON.stringify(e.classification)} is not one of ${[...CLASSIFICATIONS].join(', ')}`
  );

  const exists = proofSet.has(e.script);
  // An entry for a script that is gone is stale, and stale is not harmless: it
  // is a reason nobody re-reads, standing next to reasons that are still
  // load-bearing.
  check(exists, `registered '${e.script}' is a tracked scripts/verify-*.mjs`,
    exists ? '' : 'the file is gone — remove the entry');

  check(
    Number.isInteger(e.sites) && e.sites > 0,
    `'${e.script}' / ${e.classification} claims a positive site count`,
    String(e.sites)
  );

  check(
    typeof e.reason === 'string' && e.reason.trim().length >= 80,
    `'${e.script}' / ${e.classification} carries a reason, not just a name`
  );

  // The anchor is the whole reason this register can be re-read. A line number
  // rots silently (see the header); text goes red when the mechanism it names
  // is renamed or deleted.
  if (exists) {
    const text = sourceOf(e.script);
    const found = typeof e.evidence === 'string' && e.evidence.length > 0 &&
      text.includes(e.evidence);
    check(
      found,
      `'${e.script}' / ${e.classification} cites text that is still in that file`,
      found ? '' : `not found: ${JSON.stringify(e.evidence ?? null)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The reconciliation — the section the ticket is about.
// ---------------------------------------------------------------------------

console.log('\n=== 3. Every pane opened is reclaimed, or classified ===\n');

const registeredBy = new Map();
for (const e of PANE_OPENERS) {
  registeredBy.set(e.script, (registeredBy.get(e.script) ?? 0) + e.sites);
}

let totalOpens = 0;
let totalImmunisedScripts = 0;
let totalRegisteredSites = 0;
const rows = [];

for (const name of proofs) {
  const src = sourceOf(name);
  const opens = openSites(src);
  if (opens.length === 0) continue;

  const isImmune = immunised(src);
  const claimed = registeredBy.get(name) ?? 0;
  totalOpens += opens.length;
  if (isImmune) totalImmunisedScripts += 1;
  else totalRegisteredSites += opens.length;

  rows.push({
    name,
    opens: opens.length,
    reclaims: reclaimSites(src).length,
    census: censusSites(src).length,
    immune: isImmune,
    claimed
  });

  if (isImmune) {
    // An immunised script must NOT also be registered: two reasons for one
    // script is how a stale entry survives a file that changed underneath it.
    check(
      claimed === 0,
      `scripts/${name}.mjs — immunised by construction, so it carries no register entry`,
      claimed === 0
        ? ''
        : `the register claims ${claimed} site(s) for a script that now reads a census AND ` +
          `reclaims. Remove the entry — a reason nobody re-reads is the thing this register is ` +
          `for making loud.`
    );
    continue;
  }

  if (opens.length === claimed) continue;

  const where = opens.map((s) => `:${s.line} (${s.detector})`);
  check(
    false,
    `scripts/${name}.mjs — ${opens.length} pane-opening site(s), ${claimed} registered`,
    (opens.length > claimed
      ? `${opens.length - claimed} UNCLASSIFIED. This is "nobody has said what these are", not ` +
        `"these leak": add each to PANE_OPENERS in ${SELF}.mjs with a classification and a reason, ` +
        `or give the script both halves of the discipline — a census read AND a reclamation call — ` +
        `if the pane is real and the script should be putting it back. `
      : `the register claims ${claimed - opens.length} more than are there — an entry has gone ` +
        `stale, which is a reason nobody re-reads standing next to reasons that still hold. `) +
      `Sites: ${where.join(' | ')}`
  );
}

// The other direction: a register entry for a script with no sites left.
for (const [name, claimed] of registeredBy) {
  if (!proofSet.has(name)) continue;
  const row = rows.find((r) => r.name === name);
  check(
    Boolean(row),
    `registered '${name}' still has pane-opening sites`,
    row ? '' : `the register claims ${claimed} site(s) and the sweep finds none — remove the entry`
  );
}

// ---------------------------------------------------------------------------
// 4. The counter, and the canary that shows it is a measurement.
//
// KAN-173 criterion 3: "Any pane counter is shown non-vacuous by a canary, not
// merely written." The two accidents the ticket records are reproduced here as
// fixtures the reader must NOT fall into, and the right answer to the first is
// a triple that no line-counter and no key-guesser could have produced.
// ---------------------------------------------------------------------------

console.log('\n=== 4. The census reader, held to a canary ===\n');

/**
 * The canary. 41 panes on ONE LINE of JSON, of which 23 carry a label and 7 of
 * those are `crabcast-*`.
 *
 * EVERY NUMBER IS ARBITRARY AND NONE IS ROUND, which is the point: `wc -l`
 * answers 1, a key-guesser answers 0, a reader that counts panes instead of
 * labels answers 41, and one that counts labels instead of the prefix answers
 * 23. Only a reader doing the actual job answers 7.
 */
const CANARY_TOTAL = 41;
const CANARY_LABELLED = 23;
const CANARY_CRABCAST = 7;

function canaryCensusText() {
  const panes = [];
  for (let i = 0; i < CANARY_TOTAL; i += 1) {
    const pane = { pane_id: `w1-${i}`, cwd: '/home/nobody', agent_status: 'unknown' };
    if (i < CANARY_CRABCAST) pane.label = `crabcast-probe${i}-0123456789abcdef`;
    else if (i < CANARY_LABELLED) pane.label = `butchr-probe-${i}`;
    panes.push(pane);
  }
  // One line, exactly as `herdr pane list` prints it.
  return JSON.stringify({ id: 'cli:pane:list', result: { panes } });
}

const canaryText = canaryCensusText();
check(
  canaryText.split('\n').length === 1,
  'the canary is ONE line, so a line counter cannot accidentally be right',
  `${canaryText.length} bytes on ${canaryText.split('\n').length} line(s) — ` +
    `\`wc -l\` on this answers 1, which is the wrong answer this ticket was written about`
);

const canary = readPaneCensus(canaryText);
check(canary.ok === true, 'the reader accepts a well-formed census');
check(
  canary.ok && canary.total === CANARY_TOTAL,
  `it counts ${CANARY_TOTAL} panes`,
  canary.ok ? `got ${canary.total}` : canary.reason
);
check(
  canary.ok && canary.labelled.length === CANARY_LABELLED,
  `it counts ${CANARY_LABELLED} labelled panes — not the ${CANARY_TOTAL} total`,
  canary.ok ? `got ${canary.labelled.length}` : canary.reason
);
check(
  canary.ok && canary.crabcast.length === CANARY_CRABCAST,
  `it counts ${CANARY_CRABCAST} crabcast-* panes — not the ${CANARY_LABELLED} labelled`,
  canary.ok ? `got ${canary.crabcast.length}: ${canary.crabcast.join(', ')}` : canary.reason
);

// --- the doctored input: the reader must MOVE when the census does ----------
//
// Three right answers on one fixture is still three readings of one input. A
// counter frozen on that input would produce them for ever. So the same reader
// is handed a census with ONE crabcast pane removed and must say so.
const doctored = JSON.parse(canaryText);
const removed = doctored.result.panes.findIndex((p) => String(p.label ?? '').startsWith(CRABCAST_PREFIX));
doctored.result.panes.splice(removed, 1);
const afterDoctoring = readPaneCensus(JSON.stringify(doctored));
check(
  afterDoctoring.ok &&
    afterDoctoring.crabcast.length === CANARY_CRABCAST - 1 &&
    afterDoctoring.total === CANARY_TOTAL - 1,
  'DOCTORED: remove one crabcast pane and the reader reports one fewer, on both axes',
  afterDoctoring.ok
    ? `${afterDoctoring.total} panes, ${afterDoctoring.crabcast.length} crabcast ` +
      `(was ${CANARY_TOTAL}/${CANARY_CRABCAST})`
    : afterDoctoring.reason
);

// --- the refusals: "I could not read this" is not "there is nothing here" ---
const REFUSALS = [
  ['the shape a first pass guessed — a bare `panes` key at top level',
    JSON.stringify({ panes: [{ label: 'crabcast-x-1' }] })],
  ['a bare array, the other guess', JSON.stringify([{ label: 'crabcast-x-1' }])],
  ['a `data` key, the third guess', JSON.stringify({ data: { panes: [] } })],
  ['herdr answering nothing at all', ''],
  ['herdr answering an error string', 'herdr: connection refused'],
  ['a result with no panes array', JSON.stringify({ id: 'x', result: {} })]
];
for (const [label, text] of REFUSALS) {
  const r = readPaneCensus(text);
  check(
    r.ok === false && typeof r.reason === 'string' && r.reason.length > 0,
    `REFUSES: ${label}`,
    r.ok ? `it answered ok with ${r.total} pane(s) — that is the 0-from-a-26KB-file defect` : r.reason
  );
}

// And the case that must NOT be a refusal, or the refusals above prove nothing:
// a machine with genuinely no panes is a real, readable answer.
const genuinelyEmpty = readPaneCensus(JSON.stringify({ id: 'x', result: { panes: [] } }));
check(
  genuinelyEmpty.ok === true && genuinelyEmpty.total === 0 && genuinelyEmpty.crabcast.length === 0,
  'and an EMPTY census is read as zero rather than refused',
  genuinelyEmpty.ok
    ? 'zero panes and unreadable are different answers, and both are reachable'
    : genuinelyEmpty.reason
);

// ---------------------------------------------------------------------------
// 5. Vacuity.
//
// A sweep that matched zero sites would pass §3 trivially and print a clean
// tree. Every axis is required to be non-zero, because each of them failing
// means a different part of the instrument stopped working.
// ---------------------------------------------------------------------------

console.log('\n=== 5. The sweep found something ===\n');

check(proofs.length > 0, 'git tracks at least one scripts/verify-*.mjs', `${proofs.length} tracked`);
check(rows.length > 0, 'at least one proof opens a pane', `${rows.length} do`);
check(totalOpens > 0, 'the detectors matched something at all', `${totalOpens} site(s)`);
check(
  totalImmunisedScripts > 0,
  'the immunisation predicate recognises something',
  `${totalImmunisedScripts} script(s) carry both halves — a predicate that recognised NOTHING ` +
    `would send every script to the register and read as a huge backlog rather than as a broken ` +
    `instrument`
);
check(
  totalRegisteredSites > 0,
  'the register is exercised',
  `${totalRegisteredSites} site(s) need a classification — a sweep whose every script was ` +
    `immunised would never read an entry, and a stale register would pass unnoticed`
);

console.log('');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(w)}  ${String(r.opens).padStart(2)} open  ` +
      `${String(r.reclaims).padStart(2)} reclaim  ${String(r.census).padStart(2)} census  ` +
      `${r.immune ? 'IMMUNISED' : `registered ${r.claimed}`}`
  );
}
console.log(
  `\n  ${totalOpens} pane-opening site(s) across ${rows.length} proof(s): ` +
    `${totalImmunisedScripts} proof(s) immunised by construction, ` +
    `${totalRegisteredSites} site(s) classified in the register.`
);

const byClassification = new Map();
for (const e of PANE_OPENERS) {
  byClassification.set(e.classification, (byClassification.get(e.classification) ?? 0) + e.sites);
}
console.log('');
for (const c of CLASSIFICATIONS) {
  console.log(`  ${c.padEnd(22)} ${byClassification.get(c) ?? 0}`);
}

// ---------------------------------------------------------------------------
// 6. The live diagnostic — a REPORT, never a gate.
//
// The ticket's premise is a population on a machine, and a check that read it
// and went red would be a check that goes red about whatever is running on the
// operator's laptop. So this prints and never fails: it is here so that a run
// of this proof answers "what is on this machine now" in the same output as
// "what does the tree promise".
//
// IT CLOSES NOTHING. KAN-173's own standing rules forbid closing a
// `crabcast-*` pane that cannot be proven abandoned, and no static sweep can
// prove that.
// ---------------------------------------------------------------------------

console.log('\n=== 6. The machine this ran on (diagnostic — never a verdict) ===\n');
{
  const r = spawnSync('herdr', ['pane', 'list'], { encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) {
    console.log(
      `  no herdr reachable here (${r.error ? r.error.code ?? r.error.message : `exit ${r.status}`}) — ` +
      `nothing to report. This is the ordinary case on a CI runner and is not a failure.`
    );
  } else {
    const live = readPaneCensus(r.stdout);
    if (!live.ok) {
      console.log(`  herdr answered something this reader will not count: ${live.reason}`);
    } else {
      console.log(`  ${live.total} pane(s), ${live.labelled.length} labelled, ` +
        `${live.crabcast.length} named \`${CRABCAST_PREFIX}*\`:`);
      for (const l of live.crabcast) console.log(`     ${l}`);
      if (live.crabcast.length === 0) console.log('     (none)');
      console.log(
        `\n  KAN-173 named three of these on 2026-08-05 and they were still up on 2026-08-14.\n` +
        `  This section does not close panes and must not be made to: see the ticket's standing\n` +
        `  rules, and \`verify-no-attach-steal\` §4 for what reclaiming one's OWN pane looks like.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 7. The red drive — this check has been watched failing.
//
// A gate nobody has watched fail has not been shown to be a gate. The sequence
// is: an unmutated copy must PASS (a red drive on a broken baseline measures
// the runner), then a scratch proof that opens a pane and reclaims nothing must
// make it go red BY NAME, then a register entry for that proof must make it
// green again.
//
// IT SUPPLIES ITS OWN INPUT, and the header says what that leaves uncovered.
// ---------------------------------------------------------------------------

if (!IS_CHILD) {
  console.log('\n=== 7. Watched failing: an unreclaimed pane goes red by name ===\n');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan173-pane-sweep-'));
  const mutator = makeMutator({
    // Only `mutateScript` is used below — this check mutates a SOURCE FILE (a
    // copy of its own register), never a compiled build — so `distDir` is
    // required by the helper's signature and never read. It is pointed at
    // `scripts/` rather than at `dist/` so that a future caller reaching for
    // `mutate` here has to change it deliberately rather than inherit a path
    // that happens to exist.
    distDir: path.join(repoRoot, 'scripts'),
    scratch,
    report: {
      pass: (label, detail) => check(true, label, detail),
      fail: (label, detail) => check(false, label, detail)
    }
  });

  redDrive: try {
    const tree = path.join(scratch, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'scripts'), path.join(tree, 'scripts'), { recursive: true });
    // `git ls-files` is how §2 and §3 find the proofs, and running the child
    // through a different code path would prove something about that path
    // rather than about this one.
    execFileSync('git', ['init', '-q'], { cwd: tree });
    execFileSync('git', ['add', '-A'], { cwd: tree });

    const runChild = (label) => {
      const r = spawnSync(process.execPath, [path.join(tree, 'scripts', `${SELF}.mjs`)], {
        env: {
          ...process.env,
          CRABCAST_PANE_SWEEP_CHILD: '1',
          CRABCAST_PANE_SWEEP_REPO: tree
        },
        encoding: 'utf8'
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      console.log(`   [${label}] child exited ${r.status}`);
      return { status: r.status, out };
    };

    // --- the false-positive control -----------------------------------------
    const control = runChild('control');
    if (!check(
      control.status === 0,
      'CONTROL: the unmutated tree passes, so the red below is the mutation and not the copy',
      control.status === 0
        ? ''
        : `exited ${control.status} — a red drive on a broken baseline measures the runner. ` +
          `Last lines: ${control.out.trim().split('\n').slice(-6).join(' / ')}`
    )) break redDrive;

    // --- RED: a scratch proof that opens a pane and puts nothing back -------
    const SCRATCH = 'verify-kan173-scratch';
    const scratchProof =
      `#!/usr/bin/env node\n` +
      `// KAN-173 SCRATCH PROOF — written by §7 of ${SELF}.mjs into a scratch tree and never\n` +
      `// committed. It stands for the proof somebody adds tomorrow that opens a herdr pane on\n` +
      `// the operator's machine and never closes it.\n` +
      `//\n` +
      `// WHAT FAILURE THIS WOULD CATCH: nothing. It is the defect, not a check.\n` +
      `let failures = 0;\n` +
      `const session = bridge.spawnSession(dir, CONFIG);\n` +
      `if (!session) failures += 1;\n` +
      `process.exit(failures ? 1 : 0);\n`;
    fs.writeFileSync(path.join(tree, 'scripts', `${SCRATCH}.mjs`), scratchProof);
    execFileSync('git', ['add', '-A'], { cwd: tree });

    const red = runChild('red');
    check(
      red.status !== 0,
      'RED: an unclassified pane-opening site fails the check',
      red.status !== 0 ? `exited ${red.status}` : 'exited 0 — the check did not notice'
    );
    const namedLine = red.out
      .split('\n')
      .find((l) => l.startsWith('FAIL') && l.includes(`${SCRATCH}.mjs`));
    check(
      Boolean(namedLine),
      'RED: it fails BY NAME — the failing line names the file, not just a total',
      namedLine ? namedLine.trim().slice(0, 200) : 'no FAIL line mentioned the scratch proof'
    );
    check(
      Boolean(namedLine) && red.out.includes('UNCLASSIFIED'),
      'RED: and it says UNCLASSIFIED rather than accusing the proof of leaking',
      red.out.includes('UNCLASSIFIED') ? '' : 'the failure detail did not use the word'
    );

    // --- GREEN: classify it and the same tree passes ------------------------
    //
    // Through `mutateScript` for its exact-occurrence guarantee: an anchor that
    // has drifted would otherwise leave this half asserting on an unmutated
    // copy of the register, which is the green that means nothing.
    const entry =
      `  {\n` +
      `    script: '${SCRATCH}',\n` +
      `    classification: 'herdr-is-shimmed',\n` +
      `    sites: 1,\n` +
      `    reason:\n` +
      `      'Written by §7 into a scratch tree to demonstrate that classifying a site turns this ` +
      `check green again. It is never committed and this entry never reaches the repository.',\n` +
      `    evidence: 'KAN-173 SCRATCH PROOF'\n` +
      `  },\n`;
    const ANCHOR = 'const PANE_OPENERS = [\n';
    const classified = mutator.mutateScript(
      'register-the-scratch-proof',
      path.join(tree, 'scripts', `${SELF}.mjs`),
      [{ find: ANCHOR, replace: ANCHOR + entry }]
    );
    if (!classified) break redDrive;
    fs.copyFileSync(classified, path.join(tree, 'scripts', `${SELF}.mjs`));

    const green = runChild('green');
    check(
      green.status === 0,
      'GREEN: with the site classified, the same tree passes',
      green.status === 0
        ? 'the register is what moved the verdict — nothing else in the tree changed'
        : `exited ${green.status}. Last lines: ${green.out.trim().split('\n').slice(-8).join(' / ')}`
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.log('\n=== 7. SKIPPED — this is a child spawned by §7 ===\n');
}

// ---------------------------------------------------------------------------

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
