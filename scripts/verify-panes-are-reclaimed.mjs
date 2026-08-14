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
//   1. THE DETECTORS ARE FOUR FORMS, and a pane opened by a fifth spelling is
//      invisible here. Three of them find a pane opened DIRECTLY:
//      `spawnSession(`, `startAgentInOwnTab(` and the `'agent', 'start'` verb —
//      the three calls that reach `herdr agent start`, which is where the pane
//      is actually created (`startAgentInOwnTab`, herdr.ts). `activate_agent` is
//      deliberately NOT one of them: an activation reaches `spawnSession`
//      through the router, so every activating proof would be a site, and 60 of
//      the 70 proofs activate. A PROOF THAT OPENS A PANE ONLY BY ACTIVATING
//      THROUGH A REAL DAEMON IS OUTSIDE THIS SWEEP, and nothing here can say so.
//
//      THE FOURTH (KAN-404) finds a pane opened INDIRECTLY, by driving another
//      proof that opens one. This was boundary 1's own hypothetical until
//      `verify-pane-reclaim-when-interrupted` instantiated it — three real panes
//      per run, matching none of the three above, and unregisterable because an
//      entry for a script with no sites fails §3's reverse direction. The
//      detector is keyed on the TARGET LITERAL and not on the spawn; the
//      measurement that forced that choice is beside `driveSites` below, and the
//      short version is that a spawn-argv detector finds this case ZERO times.
//
//   6. THE FOURTH DETECTOR IS NON-TRANSITIVE AND SILENT ABOUT IT. Its target set
//      is proofs with DIRECT sites, so a proof driving a proof that drives a
//      pane-opening proof is one hop past it. That population is currently zero;
//      nothing here would notice it becoming one, and no register entry would be
//      possible for the middle link — which is KAN-404's own defect, one level
//      up. Filed rather than merely noted: KAN-410, and the population is
//      PRINTED by §5 on every run so that "currently zero" stays re-derivable
//      rather than becoming a sentence somebody trusts.
//
//   7. IT CANNOT TELL A DRIVE FROM A QUOTED DESCRIPTION OF ONE, and the tree
//      contains the case. `verify-mutation-harness` embeds a four-line fake
//      source reproducing a real driver's line CHARACTER FOR CHARACTER, as a
//      fixture for its own detector. No refinement of the pattern separates
//      them, so it carries a `text-match` entry and §1 pins the behaviour as a
//      fixture rather than describing it. Same class as a proof that asserts a
//      marker versus one that merely shows it inside a fence.
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
//   5. THE IMMUNISATION PREDICATE IS FOOLED BY A FILE THAT ONLY MENTIONS BOTH
//      VERBS, and THIS FILE IS SUCH A FILE. Its detector regexes and its §1
//      fixtures contain `closeAgentByPath(`, `'pane', 'close'` and
//      `'agent', 'start'` as data, so the whole-file predicate reads it as
//      carrying the discipline when it opens nothing at all. That is the
//      false-green direction, and it is closed by ORDER rather than by a
//      cleverer predicate: §3 consults the REGISTER FIRST and only asks about
//      immunisation for a script the register does not cover. So this file
//      carries a `text-match` entry for every one of its own sites, like
//      `verify-scaffolding-past-the-gate` does for its nineteen.
//
//      A PREDICATE COULD NOT HAVE FIXED IT. Reclamation genuinely lives inside
//      string bodies — `herdr(['pane', 'close', id])` is the real call — so a
//      rule that skipped strings would delete the detector, and one that chased
//      regex literals is the "regex shipped as a guard" this design exists to
//      avoid. The register is where a reading goes.
//
//      THE ORDER IS ITSELF ASSERTED, and it was not until somebody broke it.
//      Reviewing this PR, `epic/KAN-59` mutated `claimed === 0 &&
//      immunised(src)` back to `immunised(src)` and the check stayed SILENT:
//      eighteen sites left the register's accounting and the run printed
//      `5 immunised / 13 registered`, exit 0, no red. Leak detection was never
//      at risk — the UNCLASSIFIED branch reads `claimed` — but §5's numbers had
//      become a fiction, which is precisely what the comment beside `isImmune`
//      predicted and nothing checked. §5 now asserts that the census it PRINTED
//      is the register it READ, and `kan173-red-drive`'s `precedence-order` arm
//      drives it. A load-bearing property nobody exercises is the thing this
//      whole suite exists to notice, and it was in this file.
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

/**
 * THE FOURTH DETECTOR (KAN-404): a proof that opens a pane by DRIVING ANOTHER
 * PROOF that opens one.
 *
 * WHY IT IS NOT ANCHORED ON THE SPAWN, which is where KAN-404's ticket and the
 * epic's brief both expected it. Measured on this tree at
 * `76788c425efc56f990a63627f7a4ea577202e307`, a detector reading
 * `spawn`/`spawnSync` argv finds the case ZERO TIMES:
 *
 *   - 225 spawn-family call sites in tracked `scripts/*.mjs`
 *   - 6 have argv that textually resolves to a tracked `verify-*.mjs`, and NONE
 *     of the 6 is a proof driving another proof: 5 are in `kan*-red-drive.mjs`
 *     helpers, which are not `scripts/verify-*.mjs` and so are never swept, and
 *     the 6th is `verify-proof-verdicts` naming ITSELF
 *   - 86 pass `process.execPath` with a VARIABLE target, which no text can follow
 *   - and the one instance the ticket is about spawns from
 *     `scripts/interrupt-probe.mjs:120` — `spawn(process.execPath, [target, …])`
 *     in a SHARED MODULE, which boundary 2 says this sweep does not read at all
 *
 * So the spawn is in the wrong file AND its argv is a parameter: two independent
 * reasons the sketched shape is empty rather than merely awkward.
 *
 * WHAT IS DECIDABLE IS THE TARGET LITERAL, because a proof that drives a sibling
 * has to NAME it, and both real drivers do so identically — a quoted
 * `verify-<name>.mjs` handed to `path.join`. That is text, it sits in the
 * driving file, and it does not depend on following a value into a callee.
 *
 * NARROWED TO PANE-OPENING TARGETS, and that narrowing is substantive rather
 * than cosmetic: driving a proof that opens no pane cannot open a pane, and this
 * sweep is about panes. Naming ANY tracked proof would fire on 36 of 73 files —
 * half the suite, nearly all of it prose cross-references — which is the
 * instrument the epic's requirement 4 forbids. Naming a PANE-OPENING proof in
 * non-comment text fires on 3.
 *
 * NOT A PURE FUNCTION OF ONE FILE, unlike the three detectors above, so the set
 * is a PARAMETER rather than read from the tree here — which is what keeps §1
 * able to fixture-test it in isolation, on names that need not exist.
 *
 * NON-TRANSITIVE, deliberately: `targets` is built from DIRECT sites only, so a
 * proof that drives a proof that drives a pane-opening proof is one hop past
 * this. That population is currently zero and nothing here would say if it
 * stopped being — boundary 6.
 */
function driveSites(src, targets, selfName) {
  const comment = lexComments(src);
  const out = [];
  const re = /['"`]([A-Za-z0-9._/-]*verify-[a-z0-9-]+)\.mjs['"`]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (comment[m.index]) continue;
    const base = path.basename(m[1]);
    if (base === selfName || !targets.has(base)) continue;
    out.push({ detector: 'drives-a-pane-opening-proof', index: m.index, line: lineOf(src, m.index), target: base });
  }
  return out;
}

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
  'text-match',
  // KAN-404: this proof opens no pane itself. It SPAWNS ANOTHER PROOF that
  // does, so the pane is real and the discipline that reclaims it lives partly
  // in the driven script and partly here. The reason must say which end holds
  // which half, because no predicate can: the drive goes through a shared
  // module and neither end's text carries both.
  'drives-another-proof'
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

  {
    script: 'verify-mutation-harness',
    classification: 'text-match',
    sites: 1,
    reason:
      'THE FALSE POSITIVE, found in the tree rather than invented for the occasion, and the reason ' +
      'the fourth detector cannot be trusted without a register. Its `privateScriptMutator` is a ' +
      'FIXTURE: a four-line fake source, written to be caught by that file\'s own detector, which ' +
      'reproduces `verify-proof-cleans-up-when-interrupted`\'s real drive line CHARACTER FOR ' +
      'CHARACTER. So the text a drive detector keys on is identical in the real driver and in a ' +
      'string describing one, and no refinement of the pattern can separate them — the difference ' +
      'is that this one is data inside a quoted fixture. It drives nothing: its only subprocess ' +
      'call is `git ls-files`, and it reaches its siblings with `readFileSync`. Same class as a ' +
      'proof asserting a marker versus merely showing one inside a fence.',
    evidence: 'const privateScriptMutator ='
  },

  {
    script: 'verify-panes-are-reclaimed',
    classification: 'text-match',
    sites: 20,
    reason:
      'THIS FILE, and it is here rather than immunised because the whole-file predicate gets it ' +
      'WRONG — see boundary 5 in the header. It opens no pane and needs no herdr: every one of ' +
      'its matches is data. They are the three detector regexes, the §1 fixture sources (which ' +
      'are the instrument\'s own test inputs, written as strings), the scratch proof §7 writes ' +
      'into a temporary tree, and the prose of this register. The predicate reads the same file ' +
      'as carrying the discipline, because it also mentions the reclamation verbs it detects. An ' +
      'entry beats a predicate, which is why §3 reads the register first. TWO OF THE TWENTY ARE ' +
      'KAN-404\'s: the scratch DRIVER §7 writes, whose source names a pane-opening proof and so ' +
      'trips the fourth detector on this file exactly as it trips it on that one. The count moved ' +
      '18 -> 20 when that arm was added, and it went red first — which is the exact-count rule ' +
      'doing its job on the author who wrote it.',
    evidence: 'const OPEN_DETECTORS = ['
  },

  // -------------------------------------------------------------------------
  // drives-another-proof — opens no pane itself; spawns a proof that does
  // -------------------------------------------------------------------------
  {
    script: 'verify-pane-reclaim-when-interrupted',
    classification: 'drives-another-proof',
    sites: 1,
    reason:
      'THE INSTANCE KAN-404 WAS FILED ABOUT, and it opens THREE REAL PANES on the operator\'s ' +
      'machine per run — more than any other proof here. It opens none of them itself: it names ' +
      '`verify-no-attach-steal` as its default `--target` and drives it through ' +
      '`driveAndInterrupt` in `interrupt-probe`, so the pane is created by the DRIVEN script. ' +
      'It does carry both halves of the discipline, but through that same module rather than in ' +
      'its own text — its §3 reaps the interrupted run\'s leaked pane by name and its §4 asserts ' +
      'the machine census on either side — which is exactly why the whole-file immunisation ' +
      'predicate scores it 0 reclaim / 0 census and cannot immunise it. Measured, not assumed: ' +
      'see the PR and boundary 7.',
    evidence: 'reapPaneByName'
  },
  {
    script: 'verify-proof-cleans-up-when-interrupted',
    classification: 'drives-another-proof',
    sites: 1,
    reason:
      'The same shape as the entry above and a DIFFERENT verdict, which is why the population is ' +
      'two here and one in the ticket. It names `verify-send-confirms-delivery` as its target and ' +
      'drives it through the same `driveAndInterrupt` helper — but that target is registered ' +
      '`herdr-is-shimmed`: it writes a stub named `herdr` onto `PATH` before its `agent start`, ' +
      'and it does so inside its own process, so the stub still holds when it is driven as a ' +
      'subprocess. No pane is created on any machine. This entry exists so that the day its ' +
      'target stops being shimmed, the reason standing here is visibly wrong rather than absent.',
    evidence: 'driveAndInterrupt, reapDaemons'
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

// --- the fourth detector, self-tested the same way (KAN-404) ----------------
//
// Its target set is a PARAMETER, so these fixtures name proofs that do not
// exist. That is the point: the detector is tested as a function of (text, set)
// rather than against whatever this repository happens to contain today, and
// these fixture names cannot make THIS file a driver of anything real.

/** `[label, source, targets, expected drive sites]` */
const DRIVE_FIXTURES = [
  [
    'naming a pane-opening proof in code is a drive site',
    `const TARGET = path.join(scriptDir, 'verify-fixture-opener.mjs');`,
    ['verify-fixture-opener'], 1
  ],
  [
    // The narrowing that keeps this off 36 of 73 files.
    'naming a proof that opens NO pane is not a site',
    `const TARGET = path.join(scriptDir, 'verify-fixture-quiet.mjs');`,
    ['verify-fixture-opener'], 0
  ],
  [
    'a proof named only in a COMMENT is not a site',
    `// see verify-fixture-opener.mjs for the live half\n` +
      `/* driven by 'verify-fixture-opener.mjs' */`,
    ['verify-fixture-opener'], 0
  ],
  [
    // The detector keys on the literal, never on the identifier holding it, so
    // a driver that calls its target anything at all is still found.
    'the variable the target is held in does not matter',
    `const WHATEVER = path.join(dir, 'verify-fixture-opener.mjs');`,
    ['verify-fixture-opener'], 1
  ],
  [
    'a relative or absolute path to the target still resolves',
    `run('./scripts/verify-fixture-opener.mjs');\n` +
      `run("/abs/scripts/verify-fixture-opener.mjs");`,
    ['verify-fixture-opener'], 2
  ],
  [
    // THE KNOWN FALSE POSITIVE, pinned as a fixture so the limit is asserted
    // rather than described: `verify-mutation-harness` embeds a fake source
    // that reproduces a real drive line exactly, and this detector counts it.
    // The register is what covers it, and §2 requires that entry to exist.
    'a drive line quoted INSIDE a fixture string is counted — the detector cannot tell',
    `const fake =\n` +
      `  "const TARGET = path.join(scriptDir, 'verify-fixture-opener.mjs');\\n";`,
    ['verify-fixture-opener'], 1
  ]
];

for (const [label, src, targets, expected] of DRIVE_FIXTURES) {
  // The self-name is one no fixture uses, so only the explicit self case above
  // exercises that branch.
  const found = driveSites(src, new Set(targets), 'verify-panes-are-reclaimed');
  check(
    found.length === expected,
    `drive fixture: ${label}`,
    `${found.length} site(s) (expected ${expected})` +
      (found.length ? ` — targets: ${found.map((s) => s.target).join(', ')}` : '')
  );
}

// The self-exclusion branch, which the fixtures above cannot reach without
// pretending to BE the file under test.
check(
  driveSites(`const SELF = path.join(d, 'verify-fixture-opener.mjs');`,
    new Set(['verify-fixture-opener']), 'verify-fixture-opener').length === 0,
  'drive fixture: a file naming its OWN filename is excluded',
  'a proof that spawns copies of itself — §7 below does — is not driving another proof'
);

const driveFixtureSites = DRIVE_FIXTURES.reduce((n, [, , , e]) => n + e, 0);
check(
  driveFixtureSites > 0 && DRIVE_FIXTURES.some(([, , , e]) => e === 0),
  'the drive fixtures exercise both verdicts',
  `${driveFixtureSites} site(s) across ${DRIVE_FIXTURES.length} fixtures, and at least one must ` +
    `find nothing — a detector that matched everything would pass the accept cases alone`
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

/**
 * The proofs that open a pane DIRECTLY — the fourth detector's target set.
 *
 * Built from the three original detectors only, which is what makes the drive
 * detector non-transitive (boundary 6) and what stops it feeding on itself: a
 * driver never enters this set, so nothing becomes a site merely by naming one.
 */
const directOpeners = new Set(proofs.filter((n) => openSites(sourceOf(n)).length > 0));

let totalOpens = 0;
let totalImmunisedScripts = 0;
let totalRegisteredSites = 0;
let totalDriveSites = 0;
const driverRows = [];
const rows = [];

for (const name of proofs) {
  const src = sourceOf(name);
  const drives = driveSites(src, directOpeners, name);
  const opens = [...openSites(src), ...drives].sort((a, b) => a.index - b.index);
  if (drives.length > 0) {
    totalDriveSites += drives.length;
    driverRows.push({ name, targets: [...new Set(drives.map((d) => d.target))] });
  }
  if (opens.length === 0) continue;

  const claimed = registeredBy.get(name) ?? 0;
  // Same precedence as the reconciliation below, so the census this run prints
  // is the one it actually reasoned with. A row counted as immunised while its
  // register entry did the work would make §5's vacuity numbers a fiction.
  const isImmune = claimed === 0 && immunised(src);
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

  // THE REGISTER IS CONSULTED FIRST, and the order is load-bearing (boundary 5).
  // A script that merely MENTIONS both verbs — this file does, in its detector
  // regexes and its fixtures — would otherwise immunise itself into silence
  // while opening nothing. An explicit entry always wins over the predicate, so
  // an author can classify rather than be classified.
  if (claimed === 0) {
    if (isImmune) continue;
  } else if (opens.length === claimed) {
    continue;
  }

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

// ---------------------------------------------------------------------------
// AND THE CENSUS ABOVE IS THE ONE §3 REASONED WITH.
//
// The vacuity guards fire at ZERO, which is a real backstop and a distant one:
// they catch a total collapse and not an erosion. THE PRECEDENCE ORDER — the
// register before the predicate, boundary 5 — is what keeps the two columns
// honest, and it was load-bearing and undriven until `epic/KAN-59` mutated it
// at this file's head and watched NOTHING happen: flipping
// `claimed === 0 && immunised(src)` back to `immunised(src)` restored this
// file's self-immunisation, moved eighteen sites out of the register's
// accounting, and printed `5 immunised / 13 registered` with no red anywhere.
//
// Leak detection was never at risk — the UNCLASSIFIED branch reads `claimed`
// and not `isImmune`, so a nineteenth site here would still redden. What
// degraded is exactly what the comment beside `isImmune` says it would: §5's
// numbers become a fiction. So the invariant is asserted rather than described.
//
// It holds by arithmetic when §3 is green: every registered script is
// non-immune under the correct order, and §3 requires its site count to be
// exact, so the sites this run counted as registered are precisely the sites
// the register claims. Break the order and the two diverge with §3 still green,
// which is the only way this line can fail — and `kan173-red-drive`'s
// `precedence-order` arm is what drives it.
// ---------------------------------------------------------------------------
const registerSum = [...registeredBy]
  .filter(([name]) => proofSet.has(name))
  .reduce((n, [, claimed]) => n + claimed, 0);
check(
  totalRegisteredSites === registerSum,
  'the census this run PRINTED is the register it READ',
  totalRegisteredSites === registerSum
    ? `${totalRegisteredSites} site(s) counted as registered, and the register claims ` +
      `${registerSum} across ${registeredBy.size} script(s)`
    : `${totalRegisteredSites} site(s) were counted as registered but the register claims ` +
      `${registerSum}. A script carrying an entry was reported as immunised instead, so the ` +
      `immunised/registered split above is a fiction — the register is being read for the ` +
      `verdict and ignored for the count. Check that §3 consults the register BEFORE the ` +
      `immunisation predicate (boundary 5).`
);

// ---------------------------------------------------------------------------
// THE POPULATION, RE-DERIVED ON EVERY RUN RATHER THAN ASSERTED HERE.
//
// KAN-404's closing line asked for exactly this: "the population is currently
// one, and that is a fact somebody should be able to re-derive rather than
// trust." So the number is PRINTED from the sweep rather than written down, and
// the only claim this file makes about it is that it is not zero — a drive
// detector that had stopped matching would otherwise report a clean tree in the
// same words it uses when everything works.
//
// AND THE TICKET'S "ONE" IS TWO UNDER THIS DETECTOR, which is the finding
// rather than a discrepancy: the ticket counts proofs that drive a proof
// opening a REAL pane, and there is still exactly one of those
// (`verify-pane-reclaim-when-interrupted`). This counts proofs that drive a
// pane-opening proof at all, and the second — `verify-proof-cleans-up-when-
// interrupted` — drives one whose `herdr` is shimmed, so it opens nothing. Both
// numbers are worth having and neither is the other, so both are printed.
// ---------------------------------------------------------------------------

console.log('');
check(
  totalDriveSites > 0,
  'the fourth detector (drives-another-proof) matched something',
  `${totalDriveSites} drive site(s) across ${driverRows.length} proof(s) — a detector that ` +
    `matched NOTHING would report this tree clean in the same words it uses when it works, ` +
    `which is the defect KAN-404 was filed about`
);
// A target whose classification says its `herdr` never reaches a real one opens
// no pane, so driving it opens none either.
const OPENS_NOTHING = ['herdr-is-shimmed', 'private-herdr-server', 'text-match'];
const classificationOf = (script) =>
  PANE_OPENERS.filter((e) => e.script === script).map((e) => e.classification);
const targetOpensRealPane = (t) => {
  const cls = classificationOf(t);
  return cls.length === 0 || cls.some((c) => !OPENS_NOTHING.includes(c));
};

console.log('\n  what the fourth detector matched, and what the register says each one IS:');
let realDrivers = 0;
let genuineDrives = 0;
for (const d of driverRows) {
  // The DRIVER's own entry is the verdict. A `text-match` entry here is the
  // register saying "the detector fired on a quoted fixture, not on a call" —
  // which is a limit of the instrument, printed rather than hidden inside a
  // green.
  const isGenuine = classificationOf(d.name).includes('drives-another-proof');
  const real = isGenuine && d.targets.some(targetOpensRealPane);
  if (isGenuine) genuineDrives += 1;
  if (real) realDrivers += 1;
  console.log(
    `     ${d.name}  ->  ${d.targets.join(', ')}\n` +
      `        ${isGenuine
        ? real
          ? 'DRIVES IT, and the target opens a REAL pane on this machine'
          : 'DRIVES IT, but the target opens no pane (its herdr is shimmed or private)'
        : 'NOT A DRIVE — a false positive the register classifies; the literal is data'}`
  );
}
console.log(
  `\n  population: ${genuineDrives} proof(s) genuinely drive a pane-opening proof, of which ` +
    `${realDrivers} drive one that opens a REAL pane. ` +
    `${driverRows.length - genuineDrives} further match(es) are false positives the register names.`
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
    if (!check(
      green.status === 0,
      'GREEN: with the site classified, the same tree passes',
      green.status === 0
        ? 'the register is what moved the verdict — nothing else in the tree changed'
        : `exited ${green.status}. Last lines: ${green.out.trim().split('\n').slice(-8).join(' / ')}`
    )) break redDrive;

    // --- KAN-404: the FOURTH detector, driven the same way ------------------
    //
    // The arm above proves the sweep notices a proof that opens a pane
    // DIRECTLY. It says nothing about one that opens a pane by driving another
    // proof, which is the whole of what KAN-404 is about — and the tree is
    // green at this point, so this red is attributable to this scratch proof
    // alone. It carries NO direct pane-opening site: its only match is the
    // target literal, so a red here is the fourth detector or nothing.
    const DRIVER = 'verify-kan404-scratch-driver';
    fs.writeFileSync(
      path.join(tree, 'scripts', `${DRIVER}.mjs`),
      `#!/usr/bin/env node\n` +
      `// KAN-404 SCRATCH DRIVER — written by §7 into a scratch tree, never committed.\n` +
      `// It stands for the proof somebody adds tomorrow that opens a pane by SPAWNING a\n` +
      `// proof that opens one. It contains no spawnSession, no startAgentInOwnTab and no\n` +
      `// 'agent','start' — the three original detectors are blind to it by construction.\n` +
      `//\n` +
      `// WHAT FAILURE THIS WOULD CATCH: nothing. It is the defect, not a check.\n` +
      `import { driveAndInterrupt } from './interrupt-probe.mjs';\n` +
      `const TARGET = path.join(scriptDir, 'verify-no-attach-steal.mjs');\n` +
      `await driveAndInterrupt({ target: TARGET, root, label: 'x', count: c });\n`
    );
    execFileSync('git', ['add', '-A'], { cwd: tree });

    // Belt and braces: assert the three ORIGINAL detectors really are blind to
    // it, or a red below would prove nothing about the fourth.
    const driverSrc = fs.readFileSync(path.join(tree, 'scripts', `${DRIVER}.mjs`), 'utf8');
    check(
      openSites(driverSrc).length === 0,
      'KAN-404 RED: the scratch driver is INVISIBLE to the three original detectors',
      `${openSites(driverSrc).length} direct site(s) — must be 0, or the red below is the old ` +
        `detectors catching it and the fourth is untested`
    );
    check(
      driveSites(driverSrc, new Set(['verify-no-attach-steal']), DRIVER).length === 1,
      'KAN-404 RED: and the fourth detector DOES see it',
      'one drive site, naming a proof that opens a real pane'
    );

    const drivenRed = runChild('kan404-red');
    check(
      drivenRed.status !== 0,
      'KAN-404 RED: a proof that opens a pane by DRIVING another proof fails the check',
      drivenRed.status !== 0
        ? `exited ${drivenRed.status}`
        : 'exited 0 — this is exactly the invisibility KAN-404 was filed about, still present'
    );
    const drivenLine = drivenRed.out
      .split('\n')
      .find((l) => l.startsWith('FAIL') && l.includes(`${DRIVER}.mjs`));
    check(
      Boolean(drivenLine),
      'KAN-404 RED: it fails BY NAME',
      drivenLine ? drivenLine.trim().slice(0, 200) : 'no FAIL line mentioned the scratch driver'
    );

    const driverEntry =
      `  {\n` +
      `    script: '${DRIVER}',\n` +
      `    classification: 'drives-another-proof',\n` +
      `    sites: 1,\n` +
      `    reason:\n` +
      `      'Written by §7 into a scratch tree to demonstrate that the fourth detector can be ` +
      `answered by the register like any other site. It is never committed and this entry never ` +
      `reaches the repository.',\n` +
      `    evidence: 'KAN-404 SCRATCH DRIVER'\n` +
      `  },\n`;
    const classifiedDriver = mutator.mutateScript(
      'register-the-scratch-driver',
      path.join(tree, 'scripts', `${SELF}.mjs`),
      [{ find: ANCHOR, replace: ANCHOR + driverEntry }]
    );
    if (!classifiedDriver) break redDrive;
    fs.copyFileSync(classifiedDriver, path.join(tree, 'scripts', `${SELF}.mjs`));

    const drivenGreen = runChild('kan404-green');
    check(
      drivenGreen.status === 0,
      'KAN-404 GREEN: with the drive site classified, the same tree passes',
      drivenGreen.status === 0
        ? 'the escape hatch KAN-404 reported as UNAVAILABLE is available once the site exists'
        : `exited ${drivenGreen.status}. Last lines: ${
          drivenGreen.out.trim().split('\n').slice(-8).join(' / ')}`
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
