#!/usr/bin/env node
// KAN-179: every activation a proof makes is past the capacity gate, or
// classified in the register below with a reason a reader can act on.
//
// WHAT FAILURE THIS WOULD CATCH: a proof added to this suite whose SCAFFOLDING
// activations go through the capacity gate bare. It is green on a quiet GitHub
// runner and red on a busy laptop, and — this is the part that costs the time —
// it is red ABOUT THE LAPTOP while wearing the words of a statement about the
// code. KAN-171 is the measured case: `verify-config-echo-contract`, a REQUIRED
// check, failed 8 runs out of 8 at load 2.6-2.8 and passed 2 of 2 quiet, saying
// "drift not proven" on every one of them. KAN-138 item 2 was the same shape in
// `verify-cli-refusal` before it. Fixing each instance closes the instance; this
// is what notices the next one.
//
// ---------------------------------------------------------------------------
// WHAT THIS CHECK CANNOT DECIDE — up front, because the whole design follows
// ---------------------------------------------------------------------------
//
// WHETHER A BARE ACTIVATION IS A DEFECT DEPENDS ON WHETHER IT IS SCAFFOLDING OR
// SUBJECT, AND THAT IS INTENT. It is not in the text and no sweep can read it:
//
//   - `verify-agent-capacity` and `verify-agent-preemption` activate bare ON
//     PURPOSE. The refusal is the result. Immunising them would delete the
//     proof.
//   - `verify-state-read-echoes-config` activates bare and never reaches the
//     gate, because it seeds the census first and the already-running branch
//     returns before the gate is consulted. Nothing in the call says so.
//
// Two call sites that are textually identical are therefore a defect in one
// file and correct in the other. So the intent lives in a REGISTER, which is a
// list somebody must update — the cost this design pays on purpose, because the
// thing being remembered is intent and intent cannot be derived. KAN-179's
// commissioning decision names `verify-proof-registry`'s EXCLUSIONS as the
// model and that is what this is.
//
// A SITE IN NEITHER IS REPORTED AS **UNCLASSIFIED**, NOT AS A DEFECT. "I do not
// know about this one" is the honest verdict, and it is still a red — the point
// is to make forgetting loud, not to accuse. The failure detail says so in
// those words.
//
// ---------------------------------------------------------------------------
// WHAT IS MECHANICAL HERE AND WHAT IS JUDGEMENT
// ---------------------------------------------------------------------------
//
// MECHANICAL (this script fails on all of it):
//
//   - the sites are FOUND by three detectors and the enclosing call expression
//     is extracted by a bracket walk, both self-tested in §1 against fixtures
//     that must be accepted AND fixtures that must be rejected
//   - a site whose call carries `override: true`, or spreads a `const` declared
//     in the same file as an object with `override: true`, is IMMUNISED and
//     needs no entry (§1)
//   - every remaining site is accounted for by the register, per script, BY
//     EXACT COUNT — so a new bare site in an already-registered script is a red
//     rather than a silent adoption of somebody else's reason (§3)
//   - every entry names a tracked proof, carries a classification from a CLOSED
//     vocabulary, a reason, and an `evidence` anchor that must still appear in
//     that file (§2)
//   - the census is non-zero on every axis it reports, so a sweep that matched
//     nothing cannot pass trivially (§4)
//
// JUDGEMENT (reviewed like code, and this script cannot check it):
//
//   - whether a `classification` is TRUE of the site it covers. An entry saying
//     `census-seeded` with an anchor that exists is checkable; whether the
//     census really is seeded before that call is a reading.
//   - whether a site classified `text-match` really is text rather than a call.
//     Three of them here are `console.log` lines showing a reader what a client
//     would send, which is indistinguishable from a call to any sweep.
//
// That boundary is `verify-proof-registry` §2's and `verify-proof-defences`'s,
// drawn here for the same reason: a register whose reasons look checked and are
// not is worse than one that says which half is which.
//
// ---------------------------------------------------------------------------
// WHY `evidence` IS TEXT AND NOT A LINE NUMBER — measured, not preferred
// ---------------------------------------------------------------------------
//
// KAN-179's own ticket cites `router.ts:3611` (the already-running branch
// returning before the gate), `:3614` (the occupied refusal) and `:3662` (the
// gate). Those were EXACTLY RIGHT at b058fda, KAN-171's merge, and at 973d5ce —
// nine days later, one commit after — the same three lines are `:4880`, `:4894`
// and `:4931`. A citation is a claim about a file at a commit, and a line number
// is the part of it that rots silently: nothing goes red, the number simply
// starts pointing at unrelated code. So every `evidence` field here is LITERAL
// TEXT this script requires to still be in the file it names. Renaming the
// mechanism reddens the entry; moving it does not.
//
// The router line numbers quoted in the reasons below are dated 973d5ce for the
// same reason, and are there to be re-derived rather than trusted.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT SEE — the boundary, stated because "everything is caught"
// has been wrong in this repository four times
// ---------------------------------------------------------------------------
//
//   1. THE DETECTORS ARE THREE LITERALS. An activation reached by a form none
//      of them matches is invisible here. This is not hypothetical and it is
//      why detector 2 is wider than KAN-171's sweep: that sweep matched
//      `action: 'activate_agent'`, which misses `client.request('activate_
//      agent', …)`, `call('activate_agent', …)`, `client.ask('activate_agent',
//      …)` and `raw(sock, 'activate_agent', …)`. Measured at 973d5ce: KAN-171's
//      three detectors find 125 sites; widening the second to the bare quoted
//      action finds 154, and the extra 29 include SEVEN bare sites in
//      `verify-path-problem` and two in `verify-read-contract` that its sweep
//      never flagged because it never saw them. A proof that reaches the daemon
//      by some fourth spelling is still invisible, and nothing here can say so.
//   2. IT READS ONE FILE AT A TIME. A fixture in a shared module that activates
//      on a proof's behalf is attributed to the module, and modules are not
//      swept — only `scripts/verify-*.mjs` are.
//   3. IT CANNOT SEE AN OVERRIDE ARRIVING THROUGH A VARIABLE. `activate(args)`
//      where the caller supplies `override: true` is reported as bare; that is
//      the `immunised-indirectly` classification, and it is a register entry
//      rather than a widened predicate on purpose — a predicate that chased
//      values through variables is the "regex shipped as a guard" this ticket
//      exists to avoid.
//   4. IT SAYS NOTHING ABOUT WHETHER A REGISTERED SITE'S REASON IS TRUE, which
//      is the JUDGEMENT half above and is the register's own limit.
//
// ---------------------------------------------------------------------------
// WHAT §5 SUPPLIES ITSELF, and what that leaves uncovered
// ---------------------------------------------------------------------------
//
// §5 WRITES THE PROOF IT THEN CATCHES. It copies `scripts/` to a scratch
// repository, adds a scratch proof carrying one bare activation, and requires
// this check to go red naming that file — then adds a register entry for it and
// requires green. That proves the SWEEP AND THE REGISTER REPORT CORRECTLY ABOUT
// A TREE THEY WERE HANDED. It does NOT prove that the register committed here
// is TRUE, and it cannot: whether `census-seeded` is the right word for
// `verify-owner-filter:265` is a reading, not a computation.
//
// WHO COVERS THAT: a reviewer reading the entries, which is why each names the
// specific mechanism and the branch it returns at rather than the category. And
// `scripts/capacity-disclosure.mjs` is the backstop for the case where the
// reading was WRONG — a site registered under a classification that does not
// hold still goes red on a loaded machine, and the disclosure makes that run
// say `refusedBy: 'capacity'` instead of leaving the reader to guess. §6
// requires that module to exist and to have at least one adopter, so it cannot
// rot into dead code that reads like coverage. Neither half covers the other,
// and the gap between them — a proof that neither registers correctly NOR
// prints the disclosure — is uncovered by both and is named here rather than
// left for a reader to infer.
//
// Needs no daemon, no herdr, no network and no build: it asks git what is
// tracked and reads the files. It spawns copies of ITSELF in §5 and nothing
// else. Exits non-zero on any failure so a reviewer can re-run it against the
// PR head.
//
// Usage:
//   node scripts/verify-scaffolding-past-the-gate.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';
import { capacityDisclosure } from './capacity-disclosure.mjs';

const selfPath = fileURLToPath(import.meta.url);
const SELF = path.basename(selfPath, '.mjs');

/**
 * Set on the children §5 spawns, so a child does not run §5 and spawn children
 * of its own for ever. A recursion guard rather than a switch: §1-§4 and §6 all
 * still run in the child, which is the whole point of spawning it.
 */
const IS_CHILD = process.env.CRABCAST_GATE_SWEEP_CHILD === '1';

/**
 * A child audits a scratch tree, so it cannot find the repository by walking up
 * from its own path. §5 hands it the root; nothing else sets this, and a run
 * with it unset behaves exactly as before it existed.
 */
const repoRoot = process.env.CRABCAST_GATE_SWEEP_REPO ?? path.resolve(path.dirname(selfPath), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

// ===========================================================================
// THE SWEEP
//
// Three detectors, one span extractor, one immunisation predicate. Everything
// below is a pure function of a file's text, which is what lets §1 self-test it
// on fixtures rather than only on the tree it happens to be run against.
// ===========================================================================

/**
 * Per-index flags for a source file: is this character inside a comment, and is
 * it inside a string body?
 *
 * The two are needed separately, and collapsing them would be wrong in both
 * directions. A detector match inside a COMMENT is not a call site — it is
 * prose about one. A detector match inside a STRING usually IS the call site:
 * `'activate_agent'` and `'crabcast_activate_agent'` are how the wire action
 * and the MCP tool are named, so a sweep that skipped string bodies would find
 * almost nothing and report a clean tree.
 *
 * Bracket balancing, on the other hand, must skip both — a `)` inside a string
 * closes nothing.
 */
function lex(src) {
  const comment = new Uint8Array(src.length);
  const string = new Uint8Array(src.length);
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
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j += 1;
      }
      string.fill(1, i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
    } else i += 1;
  }
  return { comment, string };
}

const isCode = (f, i) => !f.comment[i] && !f.string[i];

/**
 * The three ways a proof in this suite reaches `handleActivate`.
 *
 * `openAt: 'end'` means the match itself ends on the call's own `(`;
 * `'before'` means the match is an ARGUMENT, so the call's `(` is the nearest
 * unbalanced one to its left.
 */
const DETECTORS = [
  { name: 'mcp-tool-name', re: () => /crabcast_activate_agent/g, openAt: 'before' },
  { name: 'wire-action', re: () => /['"]activate_agent['"]/g, openAt: 'before' },
  { name: 'router-method', re: () => /handleActivate\s*\(/g, openAt: 'end' }
];

/** Walk back from `at` to the nearest unbalanced `(`, skipping strings and comments. */
function openParenBefore(src, f, at) {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    if (!isCode(f, i)) continue;
    const c = src[i];
    if (c === ')') depth += 1;
    else if (c === '(') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** The `)` matching an open paren, skipping strings and comments. */
function closeParenAfter(src, f, open) {
  let d = 0;
  for (let i = open; i < src.length; i += 1) {
    if (!isCode(f, i)) continue;
    const c = src[i];
    if (c === '(') d += 1;
    else if (c === ')') {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return -1;
}

/**
 * Names declared in this file as `const X = { … override: true … }`.
 *
 * ONE HOP AND NO MORE, deliberately. `PAST_THE_GATE` and `OVERRIDE` are the two
 * spellings the suite actually uses and both are plain top-level consts, so one
 * hop covers every real immunisation that is not a register entry. Chasing the
 * value further — through a parameter default, an object property, a function
 * return — is a dataflow analysis, and a dataflow analysis that is 90% right is
 * exactly the artifact whose sentence claims more than its mechanism covers.
 * The remaining cases are `immunised-indirectly` entries, which cost a line
 * each and can be read.
 */
function overrideConstants(src) {
  const names = new Set();
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^{}]*\boverride\s*:\s*true\b[^{}]*\}/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

const LITERAL_OVERRIDE = /\boverride\s*:\s*true\b/;

/**
 * Every activation site in one file, with the enclosing call's text and whether
 * that call is immunised.
 *
 * `span: null` means no enclosing call expression CONTAINING the match could be
 * found — a bare array element, or a match at the top level. That is reported
 * as needing classification rather than silently dropped: "there is no call
 * here" is a reading, and readings live in the register.
 */
export function activationSites(src) {
  const f = lex(src);
  const consts = overrideConstants(src);
  const spreadOfConst =
    consts.size > 0 ? new RegExp(`\\.\\.\\.\\s*(?:${[...consts].join('|')})\\b`) : null;

  const hits = [];
  for (const det of DETECTORS) {
    const re = det.re();
    let m;
    while ((m = re.exec(src))) hits.push({ at: m.index, len: m[0].length, det });
  }
  hits.sort((a, b) => a.at - b.at);

  const sites = [];
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.at)) continue;
    seen.add(h.at);
    const line = src.slice(0, h.at).split('\n').length;
    if (f.comment[h.at]) {
      sites.push({ line, detector: h.det.name, state: 'comment', span: null });
      continue;
    }
    const open = h.det.openAt === 'end' ? h.at + h.len - 1 : openParenBefore(src, f, h.at);
    const close = open === -1 ? -1 : closeParenAfter(src, f, open);
    // A span that does not CONTAIN the match is not this call's span: walking
    // back past a `{ … }` that is not inside a call finds the enclosing
    // FUNCTION's parameter list, whose `)` closes before the match. Reported as
    // no-span rather than used, because using it would read a neighbour's
    // `override: true` as this site's immunisation — a false green, which is
    // the one direction this file must not fail in.
    // `handleActivate(` ENDS on its own `(`, so the position the span must
    // contain is that paren rather than the start of the match — which is to
    // the LEFT of it. Comparing against `h.at` for both forms reported every
    // `handleActivate` site as no-span, which fails loud rather than silent and
    // is why it was caught by a fixture rather than in review.
    const probe = h.det.openAt === 'end' ? open : h.at;
    const usable = open !== -1 && close !== -1 && open <= probe && close > probe;
    if (!usable) {
      sites.push({ line, detector: h.det.name, state: 'no-span', span: null });
      continue;
    }
    const span = src.slice(open, close + 1);
    const immunised = LITERAL_OVERRIDE.test(span) || Boolean(spreadOfConst?.test(span));
    sites.push({
      line,
      detector: h.det.name,
      state: immunised ? 'immunised' : 'bare',
      span: span.replace(/\s+/g, ' ').slice(0, 140)
    });
  }
  return sites;
}

// ===========================================================================
// THE REGISTER
//
// One entry per (script, classification). Fields:
//
//   script          basename, no extension
//   classification  one of CLASSIFICATIONS below — the CLOSED vocabulary
//   sites           EXACT number of bare sites in that script with this
//                   classification. An exact count, not a floor: adding a bare
//                   site to a registered script must go red rather than be
//                   adopted by somebody else's reason.
//   reason          why this is not a defect, in terms a reader can CHECK —
//                   the mechanism and where it returns, never "exempt"
//   evidence        literal text that must still appear in that file
//
// WHY THE KEY IS (script, classification) AND NOT (script, site). A per-site
// register needs a per-site IDENTITY, and there is no honest one. A line number
// rots silently — the header measures the ticket's own three citations moving
// 1,270 lines in nine days — and the call text is not unique: seven sites in
// `verify-refuses-occupied-directory` are the identical string, as are four in
// `verify-owner-filter`. So the key is what CAN be checked, and the count is
// what makes forgetting loud. It buys the property the ticket asked for (a new
// bare site in a registered script is a red, by name, with every site listed in
// the detail) and it does NOT buy per-site attribution: when a script has two
// classifications — `verify-cli-refusal` and `verify-fleet-switch-live` both do
// — the reasons say which sites they cover, in prose, and this script cannot
// check that they got it right. That limit is the JUDGEMENT half above.
// ===========================================================================

/**
 * The vocabulary, closed. KAN-171's sweep found four categories by reading 34
 * flagged sites; three more are here because the widened detector reaches sites
 * that sweep never saw, and each names a DIFFERENT branch of `handleActivate`
 * that returns before the gate. They are not softenings of the original four —
 * `address-refusal-first` and `bad-flag-refusal-first` are the same fact as
 * `occupied-refusal-first` about two other early returns, and
 * `immunised-indirectly` is an immunisation this file's one-hop predicate
 * cannot follow rather than an exemption from one.
 *
 * The value is not a verdict on the proof. It is the ANSWER TO ONE QUESTION:
 * why does this bare activation not reach the capacity gate, or why is reaching
 * it correct?
 */
const CLASSIFICATIONS = new Set([
  // The refusal IS the result. Immunising these would delete the proof.
  'gate-is-the-subject',
  // `setCensus([ourPane(…)])` first, so `handleActivate` takes the
  // already-running branch and returns at router.ts:4880, before the gate at
  // :4931.
  'census-seeded',
  // A live pane that is not ours in the same directory: refused at
  // router.ts:4894, before the gate.
  'occupied-refusal-first',
  // A relative path, a file, a missing directory: refused at router.ts:4615,
  // before the gate.
  'address-refusal-first',
  // A non-boolean `override` or `preempt`: refused at router.ts:4625, before
  // the gate.
  'bad-flag-refusal-first',
  // The override is really there and arrives by a name this file's one-hop
  // predicate cannot follow — a parameter default, a caller's argument object.
  'immunised-indirectly',
  // Not an activation at all: a tool-name list, a `console.log` showing a
  // reader what a client would send, a table of action names.
  'text-match'
]);

const BARE_ACTIVATIONS = [
  // -------------------------------------------------------------------------
  // gate-is-the-subject — the refusal is the result
  // -------------------------------------------------------------------------
  {
    script: 'verify-agent-capacity',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'The capacity gate is this file\'s entire subject. Its one activation helper passes ' +
      '`override: incoming.override` — the flag comes from the CASE TABLE, because half the cases ' +
      'are "an override is honoured" and half are "a refusal happens", and a helper that forced ' +
      'the flag on could express neither. Immunising this site would delete the proof rather than ' +
      'stabilise it.',
    evidence: 'override: incoming.override'
  },
  {
    script: 'verify-agent-preemption',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'Preemption only exists AT capacity: the whole file drives a daemon to its cap and then ' +
      'asks what an incoming agent may end. Its activation helper spreads a per-case `extra`, so ' +
      'the cases that need to be refused are refused and the cases that need to preempt carry ' +
      '`preempt`. Past the gate there is nothing left to preempt.',
    evidence: 'handleActivate({ path: dir, ...extra }'
  },
  {
    script: 'verify-cli-refusal',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'KAN-138 item 2 — the FIRST instance of the shape KAN-179 is about, and it is ' +
      'gate-is-the-subject rather than a defect. §3 sends `activate_agent` over the raw socket to ' +
      'a daemon started at a deliberately small cap (`capped`) so the CLI\'s `--json` output can ' +
      'be compared field for field against the daemon\'s own refusal. An override here would ' +
      'produce a success and there would be nothing to compare.',
    evidence: 'const wire = await raw(capped,'
  },
  {
    script: 'verify-event-contract',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'One site, and it carries `preempt: true` rather than `override: true` BECAUSE THE EVENT IS ' +
      'THE SUBJECT: `agent.preempted` is only emitted when an incoming agent at capacity ends ' +
      'another, so an override would take the same call past the gate and emit nothing. Note that ' +
      '`preempt` is deliberately NOT treated as immunisation by this file — it gets past capacity ' +
      'only when something outranked is actually running, so a proof relying on it is still ' +
      'load-sensitive and still owes an entry here.',
    evidence: "{ path: PREEMPTOR, preempt: true }"
  },
  {
    script: 'verify-fleet-switch-live',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'An EXCLUDED live proof (see verify-proof-registry EXCLUSIONS) that runs against a real ' +
      'herdr on a machine already running a live fleet, so whether the cap refuses it is part of ' +
      'what the operator is finding out. Its §1 activation is bare on purpose and the very next ' +
      'line RETRIES with `override: true` when it was refused — the refusal is observed, then ' +
      'stepped past, which is a two-line sequence no immunisation predicate can express.',
    evidence: 'let started = await call('
  },
  {
    script: 'verify-read-contract',
    classification: 'gate-is-the-subject',
    sites: 1,
    reason:
      'The `capacity` branch of `activate_response` is one of the eleven branches this file must ' +
      'PRODUCE in order to reconcile the wire against `docs/read-path-contract.md`. It has its ' +
      'own socket to a capped daemon (`gateSock`) for exactly that, and the activation is bare ' +
      'because a refusal is the payload being read.',
    evidence: 'produced.capacity = await (async () => {'
  },
  {
    script: 'verify-reconfiguration-refuses',
    classification: 'gate-is-the-subject',
    sites: 2,
    reason:
      'Two sites in the section that establishes what a NEWCOMER meets when the fleet is full: ' +
      'the first must be refused by capacity and the second must be refused the same way after a ' +
      'reconfiguration, which is how the file shows that moving a knob did not quietly buy a ' +
      'slot. Both are the gate\'s own behaviour. The file\'s OTHER thirteen activations are ' +
      'scaffolding and every one of them carries `...PAST_THE_GATE`, which is the contrast worth ' +
      'reading: one file, both kinds, told apart by intent and not by text.',
    evidence: "const PAST_THE_GATE = { override: true };"
  },

  // -------------------------------------------------------------------------
  // census-seeded — the already-running branch returns before the gate
  // -------------------------------------------------------------------------
  {
    script: 'verify-activated-by',
    classification: 'census-seeded',
    sites: 4,
    reason:
      'Each of the four is preceded on the LINE BEFORE by `setCensus([ourPane(<the same dir>, …)])`, ' +
      'so the shimmed herdr reports a live pane in that directory and `handleActivate` takes the ' +
      'already-running branch — which returns at router.ts:4880 (973d5ce), before the gate is ' +
      'reached at :4931. The sections are about `activatedBy` on a converging activation, which ' +
      'is a branch that exists only when the agent is already up. An override would change ' +
      'nothing here except to hide that.',
    evidence: "setCensus([ourPane(selfish, '%70')]);"
  },
  {
    script: 'verify-fleet-enumeration',
    classification: 'census-seeded',
    sites: 1,
    reason:
      'One helper, and the seeding is the line above the call: `setCensus([ourPane(dir, paneId)])` ' +
      'then activate then `setCensus([])`. The file builds large fleets row by row and reaching ' +
      'the gate once per row would make paging behaviour a function of the load average.',
    evidence: 'setCensus([ourPane(dir, paneId)]);'
  },
  {
    script: 'verify-stranded-agents',
    classification: 'census-seeded',
    sites: 3,
    reason:
      'Three scaffolding activations, each preceded by `setCensus([ourPane(<the same dir>, …)])` ' +
      'so `handleActivate` takes the already-running branch and returns before the gate. Their ' +
      'only job is to put an `activated` or `deactivated` row in the registry, because the file\'s ' +
      'subject is what a record whose DIRECTORY IS LATER DELETED is reported as — one record per ' +
      'last event, which is the only reason it activates anything at all. Two are §1\'s fixture ' +
      '(`ranThenGone` stays activated, `stoodDown` is then deactivated through the verb) and the ' +
      'third is `fleetOn`, which stands the same shape up against each mutated build in §7. The ' +
      'capacity gate is not this file\'s subject and reaching it would make the fixture a ' +
      'function of the load average.',
    evidence: "setCensus([ourPane(ranThenGone, '%100'), ourPane(stoodDown, '%101')]);"
  },
  {
    script: 'verify-daemon-status-accounts-for-stranded',
    classification: 'census-seeded',
    sites: 3,
    reason:
      'Three scaffolding activations, each preceded by `setCensus([ourPane(<the same dir>, …)])` ' +
      'so the shimmed herdr reports a live pane there, `handleActivate` takes the ' +
      'already-running branch and returns before the gate. Their only job is to put an ' +
      '`activated` row in the registry, because this file\'s subject is whether `daemon_status` ' +
      'ACCOUNTS for records it counts and cannot start — which needs `activated`-last rows whose ' +
      'directories are then deleted, and needs them to differ from the `configured`- and ' +
      '`deactivated`-last ones so the two new counts can be shown to be two populations. §1 ' +
      'stands up the five-record fixture, §6 stands up the one record the reconcile ruling is ' +
      'demonstrated on, and §7\'s `statusOn` stands the same shape up against each mutated ' +
      'build. The capacity gate is not this file\'s subject, and reaching it would make a proof ' +
      'about arithmetic over a registry a function of the load average.',
    evidence: "setCensus([ourPane(goneActive, '%100'), ourPane(goneStandby, '%101'), ourPane(survivor, '%102')]);"
  },
  {
    script: 'verify-missing-agent-occupancy',
    classification: 'census-seeded',
    sites: 2,
    reason:
      'Two scaffolding activations, each on the line after `setCensus([ourPane(<the same dir>, ' +
      '…)])`, so both take the already-running branch and return at router.ts:4880 before the ' +
      'gate at :4931. Their only job is to put an `activated` row in the registry, because that ' +
      'is what makes the agent a LOSS once the census stops carrying its pane — which is the ' +
      'state the whole file is about. The census is then rewritten to hold a FOREIGN pane in ' +
      'that directory, and no activation happens after that point: the occupied-directory ' +
      'refusal is a thing this file asserts the rows SAY, never a thing it drives. Reaching the ' +
      'gate would make a fixture about one directory depend on the runner\'s load average.',
    evidence: "setCensus([ourPane(dir, '%100')]);"
  },
  {
    script: 'verify-owner-filter',
    classification: 'census-seeded',
    sites: 6,
    reason:
      'Six scaffolding activations, each on the line after `setCensus([ourPane(<the same dir>, ' +
      '`%${paneId++}`)])`, so every one takes the already-running branch and returns at ' +
      'router.ts:4880 before the gate at :4931. They exist to put rows into `runningAgents`, ' +
      '`standbyAgents`, `missingAgents` and `preemptedAgents` so the `owner` filter has something ' +
      'to filter; the gate is not in the subject at all.',
    evidence: 'setCensus([ourPane(preempted, `%${paneId++}`)]);'
  },
  {
    script: 'verify-state-read-echoes-config',
    classification: 'census-seeded',
    sites: 4,
    reason:
      'Four scaffolding activations, each preceded by `setCensus([ourPane(<the same dir>, …)])`. ' +
      'Two of them (`behind`) exist to drive the CONVERGING activate — the branch that repairs a ' +
      'record left saying `configured` while the pane is live — which is reachable only through ' +
      'the already-running path, so this classification is not merely true of them but forced.',
    evidence: "setCensus([ourPane(runningDir, '%10')]);"
  },

  // -------------------------------------------------------------------------
  // occupied-refusal-first — a foreign pane is refused before the gate
  // -------------------------------------------------------------------------
  {
    script: 'verify-refuses-occupied-directory',
    classification: 'occupied-refusal-first',
    sites: 8,
    reason:
      'The whole file is about the refusal that fires at router.ts:4894 (973d5ce) when a live ' +
      'pane in the directory is not ours — which is BEFORE the gate at :4931, so these seven ' +
      'never reach it. The file already carries `PAST_THE_GATE` and uses it on the three ' +
      'activations that are scaffolding rather than subject, which is why the count here is seven ' +
      'and not ten: the same author told the two kinds apart by hand, and this entry is that ' +
      'reading written down. The eighth (KAN-596) is `refuseOccupied`, the helper behind §f1-f5, ' +
      'and it is the same classification for the same reason: every one of its activations is ' +
      'driven into a directory holding a live foreign pane, so the occupied refusal fires first ' +
      'and the gate is never reached. It deliberately does NOT spread `PAST_THE_GATE` — that ' +
      'refusal IS its subject, and immunising it would delete what §f1-f5 measure.',
    evidence: 'const PAST_THE_GATE = { override: true };'
  },

  // -------------------------------------------------------------------------
  // address-refusal-first — a bad address is refused before the gate
  // -------------------------------------------------------------------------
  {
    script: 'verify-path-problem',
    classification: 'address-refusal-first',
    sites: 7,
    reason:
      'Every one of the seven supplies an address that cannot resolve — a relative path, a plain ' +
      'file, a directory deleted underneath the daemon — and `handleActivate` refuses at ' +
      'router.ts:4615 (973d5ce), which is well before the gate at :4931. `pathProblem` riding ' +
      'that refusal is the entire subject of the file. The two activations here that DO reach a ' +
      'real directory carry `override: true` already, so the split inside this file is itself the ' +
      'evidence that the seven are deliberate.',
    evidence: "['not-a-directory', { path: aFile }]"
  },
  {
    script: 'verify-cli-refusal',
    classification: 'address-refusal-first',
    sites: 1,
    reason:
      'A TABLE ENTRY rather than a call: the `activate` row of a list of verbs ' +
      'the loop below sends with `path: \'victim\'` — a relative path, refused by name at ' +
      'router.ts:4615 before the gate. The section is about universality (every verb refuses a ' +
      'relative path), so the row must stay bare.',
    evidence: 'refuses a relative path by name'
  },

  // -------------------------------------------------------------------------
  // bad-flag-refusal-first — an invalid flag is refused before the gate
  // -------------------------------------------------------------------------
  {
    script: 'verify-idempotent-lifecycle',
    classification: 'bad-flag-refusal-first',
    sites: 1,
    reason:
      'The one site in this file that does not carry `...PAST_THE_GATE` carries ' +
      '`override: \'yes\'` — a STRING, on purpose, because the section asserts that a non-boolean ' +
      'flag is refused by name at router.ts:4625 (973d5ce) rather than being coerced. It is ' +
      'therefore refused before the gate, and it is also the reason this file\'s immunisation ' +
      'predicate tests `override: true` and not `override:` — `override: \'yes\'` must NOT read ' +
      'as immunisation, and §1 has a fixture requiring exactly that.',
    evidence: "override: 'yes'"
  },

  // -------------------------------------------------------------------------
  // immunised-indirectly — the override is there, by a name one hop cannot see
  // -------------------------------------------------------------------------
  {
    script: 'verify-config-echo-contract',
    classification: 'immunised-indirectly',
    sites: 2,
    reason:
      'THE SCRIPT KAN-171 FIXED, and its two activations ARE past the gate — through ' +
      '`buildFleet(mcp, tag, { gate = PAST_THE_GATE })`, a destructured parameter default, which ' +
      'is one hop further than this file\'s `const` resolution follows. The indirection is not ' +
      'incidental: `gate` is the seam §6 uses to back the defence out (`{ gate: {} }`) and watch ' +
      'the KAN-171 failure come back at CRABCAST_MAX_AGENTS=0. Widening the predicate to chase ' +
      'parameter defaults would immunise the RED half of that section too, which is the opposite ' +
      'of what anyone wants.',
    evidence: 'async function buildFleet(mcp, tag, { gate = PAST_THE_GATE'
  },
  {
    script: 'verify-read-contract',
    classification: 'immunised-indirectly',
    sites: 1,
    reason:
      'The `activate` helper declaration itself — `sock.request(\'activate_agent\', args)` — where ' +
      '`args` is the caller\'s object. All three of its call sites in the section pass ' +
      '`override: true`; the helper cannot, because it exists to reach the branches the MCP tool ' +
      'cannot produce and one caller deliberately needs a refusal. The site is bare as text and ' +
      'immunised in fact, at every call.',
    evidence: 'activate({ path: spawnFails, override: true })'
  },

  // -------------------------------------------------------------------------
  // text-match — not an activation at all
  // -------------------------------------------------------------------------
  {
    script: 'verify-agent-power-controls',
    classification: 'text-match',
    sites: 1,
    reason:
      'A `console.log` printing, for the human reading the run, the exact frame a client would ' +
      'send from a standby row. The REAL activation is four lines below it and carries ' +
      '`...PAST_THE_GATE`, as do all twelve others in the file. This is the case that shows why ' +
      'the sweep cannot decide: the printed frame and a real call are the same characters.',
    evidence: 'takes no attributes at all'
  },
  {
    script: 'verify-fleet-switch-live',
    classification: 'text-match',
    sites: 1,
    reason:
      'The same shape as verify-agent-power-controls\': a `console.log` of the frame a client ' +
      'would send from the standby row it just printed, three lines above the real call. Counted ' +
      'separately from this file\'s gate-is-the-subject entry because they are different sites ' +
      'answering different questions, and one reason covering both would be true of neither.',
    evidence: 'a client sends, from that standby row'
  },
  {
    script: 'verify-mcp-tools',
    classification: 'text-match',
    sites: 2,
    reason:
      'Two: an element of the `EXPECTED_TOOLS` list, which is the tool NAMES this file requires ' +
      'the MCP server to publish, and a `show()` label — the activate tool\'s name with a colon ' +
      'after it — printing the response of the real call above it. That real call carries `override: true`. The first has ' +
      'no enclosing call expression at all and is reported as no-span, which is why it needs an ' +
      'entry rather than being dropped.',
    evidence: "const EXPECTED_TOOLS = ["
  },
  {
    script: 'verify-owner-filter',
    classification: 'text-match',
    sites: 1,
    reason:
      '`toolBlock()` names the configure tool and the activate tool and slices `src/mcp.ts` ' +
      'BETWEEN their two definitions, so the section can assert on the first one\'s description. ' +
      'The tool name is an index into a text file here, not a call.',
    evidence: 'const toolBlock = (name, next) =>'
  },
  {
    script: SELF,
    classification: 'text-match',
    sites: 19,
    reason:
      'THIS FILE SWEEPS ITSELF, and there is no exemption: it starts no daemon and performs no ' +
      'activation, so all nineteen are text. Eighteen are the §1 fixture sources and detector 2\'s ' +
      'own regex literal; the nineteenth is the scratch proof §5 writes into a temporary tree. ' +
      'THE REGISTER\'S REASONS AND ANCHORS ARE DELIBERATELY WORDED TO AVOID THE LITERAL — they ' +
      'name the mechanism (`const wire = await raw(capped,`) rather than quoting the wire action — ' +
      'because prose that swept as a site would make this count move on every rewording and put ' +
      'the words "activation needs a classification" on a change that touched no activation. That ' +
      'is the standing rule about a red accusing the right component, applied to this file first. ' +
      'What remains DOES move when a fixture is edited, and that is correct rather than a ' +
      'nuisance: a fixture added without a thought about what it demonstrates reddens the same ' +
      'check as a bare activation added anywhere else.',
    evidence: 'export function activationSites(src)'
  }
];

// ===========================================================================

console.log(`=== 0. What is being audited ===\n`);
console.log(`  repository root: ${repoRoot}`);
console.log(`  role:            ${IS_CHILD ? 'CHILD (§5 skipped)' : 'parent'}\n`);

// ---------------------------------------------------------------------------
// 1. The detector and the span extractor, self-tested.
//
// A detector that recognises nothing reports the same all-clear as one that
// recognises everything, so the instrument is tested before it is used —
// against fixtures that must be ACCEPTED and, more importantly, fixtures that
// must be REJECTED.
// ---------------------------------------------------------------------------

console.log('=== 1. The instrument, before it is pointed at anything ===\n');

/** `[label, source, expected number of BARE sites, expected total sites]` */
const FIXTURES = [
  [
    'a literal override immunises',
    `await invoke(deps, { action: 'activate_agent', path: dir, override: true });`,
    0, 1
  ],
  [
    'a spread of a const declared { override: true } immunises',
    `const PAST_THE_GATE = { override: true };\n` +
      `await invoke(deps, { action: 'activate_agent', path: dir, ...PAST_THE_GATE });`,
    0, 1
  ],
  [
    'the const may have any name',
    `const OVERRIDE = { override: true };\n` +
      `await router.handleActivate({ path: dir, ...OVERRIDE, ...extra }, cb);`,
    0, 1
  ],
  [
    'a bare call is flagged',
    `await invoke(deps, { action: 'activate_agent', path: dir });`,
    1, 1
  ],
  [
    // The reason the predicate is `override: true` and not `override:`.
    'a NON-BOOLEAN override is not immunisation',
    `await invoke(deps, { action: 'activate_agent', path: dir, override: 'yes' });`,
    1, 1
  ],
  [
    // preempt gets past capacity only when something outranked is running.
    'preempt is not immunisation',
    `await call('activate_agent', { path: dir, preempt: true });`,
    1, 1
  ],
  [
    'a spread of a const declared { override: false } is not immunisation',
    `const NOT_A_GATE = { override: false };\n` +
      `await invoke(deps, { action: 'activate_agent', path: dir, ...NOT_A_GATE });`,
    1, 1
  ],
  [
    // The false-green direction: a neighbour's override must not cover this one.
    'ADJACENCY — a bare call beside an immunised one is still flagged',
    `const PAST_THE_GATE = { override: true };\n` +
      `await inv(deps, { action: 'activate_agent', path: a, ...PAST_THE_GATE });\n` +
      `await inv(deps, { action: 'activate_agent', path: b });`,
    1, 2
  ],
  [
    'ADJACENCY — two calls as arguments to one outer call are still separate',
    `await Promise.all([\n` +
      `  inv({ action: 'activate_agent', path: a }),\n` +
      `  inv({ action: 'activate_agent', path: b, override: true })\n` +
      `]);`,
    1, 2
  ],
  [
    'a commented-out call is not a site to classify',
    `// await invoke(deps, { action: 'activate_agent', path: dir });`,
    0, 1
  ],
  [
    // Widening detector 2 past KAN-171's `action: 'activate_agent'` is what
    // reaches these; without it seven bare sites in verify-path-problem and two
    // in verify-read-contract are invisible.
    'the wire action is found through any helper, not only as `action:`',
    `const a = await client.ask('activate_agent', { path: relative });\n` +
      `const b = await sock.request('activate_agent', { path: gated });\n` +
      `const c = await raw(capped, 'activate_agent', { path: demoDir });`,
    3, 3
  ],
  [
    'an override that reaches the daemon through a variable reads as bare',
    `const activate = (args) => sock.request('activate_agent', args);`,
    1, 1
  ]
];

for (const [label, src, expectBare, expectTotal] of FIXTURES) {
  const sites = activationSites(src);
  const bare = sites.filter((s) => s.state === 'bare' || s.state === 'no-span');
  check(
    sites.length === expectTotal && bare.length === expectBare,
    `fixture: ${label}`,
    `${sites.length} site(s) (expected ${expectTotal}), ${bare.length} needing classification ` +
      `(expected ${expectBare})` +
      (sites.length ? ` — states: ${sites.map((s) => s.state).join(', ')}` : '')
  );
}

// A fixture set that recognised nothing would pass every line above with the
// same words it uses when everything works.
const fixtureTotal = FIXTURES.reduce((n, [, , , total]) => n + total, 0);
const fixtureBare = FIXTURES.reduce((n, [, , b]) => n + b, 0);
check(
  fixtureTotal > 0 && fixtureBare > 0 && fixtureTotal > fixtureBare,
  'the fixtures exercise both verdicts',
  `${fixtureTotal} site(s) across ${FIXTURES.length} fixtures, of which ${fixtureBare} must be ` +
    `flagged and ${fixtureTotal - fixtureBare} must not`
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

const pairs = new Set();
for (const e of BARE_ACTIVATIONS) {
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
    const text = fs.readFileSync(path.join(repoRoot, 'scripts', `${e.script}.mjs`), 'utf8');
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

console.log('\n=== 3. Every activation is past the gate, or classified ===\n');

const registeredBy = new Map();
for (const e of BARE_ACTIVATIONS) {
  registeredBy.set(e.script, (registeredBy.get(e.script) ?? 0) + e.sites);
}

let totalSites = 0;
let totalImmunised = 0;
let totalComment = 0;
let totalNeeding = 0;
const rows = [];

for (const name of proofs) {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts', `${name}.mjs`), 'utf8');
  const sites = activationSites(src);
  if (sites.length === 0) continue;
  const immunised = sites.filter((s) => s.state === 'immunised');
  const comments = sites.filter((s) => s.state === 'comment');
  const needing = sites.filter((s) => s.state === 'bare' || s.state === 'no-span');
  totalSites += sites.length;
  totalImmunised += immunised.length;
  totalComment += comments.length;
  totalNeeding += needing.length;

  const claimed = registeredBy.get(name) ?? 0;
  rows.push({ name, total: sites.length, immunised: immunised.length, needing: needing.length, claimed });

  if (needing.length === claimed) continue;

  const where = needing.map((s) => `:${s.line}${s.span ? ` ${s.span}` : ' (no enclosing call)'}`);
  check(
    false,
    `scripts/${name}.mjs — ${needing.length} activation(s) need a classification, ${claimed} registered`,
    (needing.length > claimed
      ? `${needing.length - claimed} UNCLASSIFIED. This is "nobody has said what these are", not ` +
        `"these are wrong": add each to BARE_ACTIVATIONS in ${SELF}.mjs with a classification and ` +
        `a reason, or pass \`override: true\` (or spread a \`const … = { override: true }\`) if ` +
        `the activation is SCAFFOLDING rather than the subject. `
      : `the register claims ${claimed - needing.length} more than are there — an entry has gone ` +
        `stale, which is a reason nobody re-reads standing next to reasons that still hold. `) +
      `Sites: ${where.join(' | ')}`
  );
}

// The other direction: a register entry for a script with no bare sites left.
for (const [name, claimed] of registeredBy) {
  if (!proofSet.has(name)) continue;
  const row = rows.find((r) => r.name === name);
  check(
    Boolean(row),
    `registered '${name}' still has activation sites`,
    row ? '' : `the register claims ${claimed} site(s) and the sweep finds none — remove the entry`
  );
}

// ---------------------------------------------------------------------------
// 4. Vacuity, and the census.
//
// A sweep that matched zero sites would pass §3 trivially and print a clean
// tree. Every axis it reports is required to be non-zero, because each of them
// failing means a different part of the instrument stopped working.
// ---------------------------------------------------------------------------

console.log('\n=== 4. The sweep found something ===\n');

check(proofs.length > 0, 'git tracks at least one scripts/verify-*.mjs', `${proofs.length} tracked`);
check(rows.length > 0, 'at least one proof contains an activation site', `${rows.length} do`);
check(totalSites > 0, 'the detectors matched something at all', `${totalSites} site(s)`);
check(
  totalImmunised > 0,
  'the immunisation predicate recognises something',
  `${totalImmunised} site(s) are past the gate — a predicate that recognised NOTHING would send ` +
    `every site to the register and read as a huge backlog rather than as a broken instrument`
);
check(
  totalNeeding > 0,
  'the register is exercised',
  `${totalNeeding} site(s) need a classification — a sweep whose every site was immunised would ` +
    `never read an entry, and a stale register would pass unnoticed`
);

console.log('');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(w)}  ${String(r.total).padStart(3)} site(s)  ` +
      `${String(r.immunised).padStart(3)} past the gate  ` +
      `${String(r.needing).padStart(3)} classified  ` +
      `${r.needing === r.claimed ? '' : `(register claims ${r.claimed})`}`
  );
}
console.log(
  `\n  ${totalSites} activation site(s) across ${rows.length} proof(s): ` +
    `${totalImmunised} past the gate, ${totalNeeding} classified in the register, ` +
    `${totalComment} in comments.`
);

const byClassification = new Map();
for (const e of BARE_ACTIVATIONS) {
  byClassification.set(e.classification, (byClassification.get(e.classification) ?? 0) + e.sites);
}
console.log('');
for (const c of CLASSIFICATIONS) {
  console.log(`  ${c.padEnd(24)} ${byClassification.get(c) ?? 0}`);
}

// ---------------------------------------------------------------------------
// 5. The red drive — this check has been watched failing.
//
// A gate nobody has watched fail has not been shown to be a gate. The sequence
// is: an unmutated copy must PASS (a red drive on a broken baseline measures the
// runner), then a scratch proof with one bare activation must make it go red BY
// NAME, then a register entry for that proof must make it green again.
//
// IT SUPPLIES ITS OWN INPUT, and the header says what that leaves uncovered.
// ---------------------------------------------------------------------------

if (!IS_CHILD) {
  console.log('\n=== 5. Watched failing: an unclassified bare activation goes red by name ===\n');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan179-gate-sweep-'));
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
          CRABCAST_GATE_SWEEP_CHILD: '1',
          CRABCAST_GATE_SWEEP_REPO: tree
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

    // --- RED: a scratch proof that activates scaffolding bare ---------------
    const SCRATCH = 'verify-kan179-scratch';
    const scratchProof =
      `#!/usr/bin/env node\n` +
      `// KAN-179 SCRATCH PROOF — written by §5 of ${SELF}.mjs into a scratch tree and never\n` +
      `// committed. It stands for the proof somebody adds tomorrow whose fixture activates\n` +
      `// scaffolding through the capacity gate bare.\n` +
      `//\n` +
      `// WHAT FAILURE THIS WOULD CATCH: nothing. It is the defect, not a check.\n` +
      `let failures = 0;\n` +
      `const res = await invoke(deps, { action: 'activate_agent', path: dir });\n` +
      `if (!res.success) failures += 1;\n` +
      `process.exit(failures ? 1 : 0);\n`;
    fs.writeFileSync(path.join(tree, 'scripts', `${SCRATCH}.mjs`), scratchProof);
    execFileSync('git', ['add', '-A'], { cwd: tree });

    const red = runChild('red');
    check(
      red.status !== 0,
      'RED: an unclassified bare activation fails the check',
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
      'RED: and it says UNCLASSIFIED rather than accusing the proof of a defect',
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
      `    classification: 'gate-is-the-subject',\n` +
      `    sites: 1,\n` +
      `    reason:\n` +
      `      'Written by §5 into a scratch tree to demonstrate that classifying a site turns this ` +
      `check green again. It is never committed and this entry never reaches the repository.',\n` +
      `    evidence: 'KAN-179 SCRATCH PROOF'\n` +
      `  },\n`;
    const ANCHOR = 'const BARE_ACTIVATIONS = [\n';
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
  console.log('\n=== 5. SKIPPED — this is a child spawned by §5 ===\n');
}

// ---------------------------------------------------------------------------
// 6. The backstop, and that it is not dead code.
//
// The register goes red BEFORE the flake, on the pull request. The disclosure
// is for the case the register cannot reach: a site registered under a
// classification that is not true. There the proof still goes red on a loaded
// machine, and this is what makes that run diagnose itself.
// ---------------------------------------------------------------------------

console.log('\n=== 6. The capacity disclosure ===\n');

check(
  typeof capacityDisclosure === 'function',
  'scripts/capacity-disclosure.mjs exports capacityDisclosure'
);

// A predicate that answered the same thing for every input would satisfy any
// adopter and disclose nothing.
const refusal = {
  success: false,
  refusedBy: 'capacity',
  reason: 'no-headroom',
  capacity: { cap: 0, headroom: 0, running: 3, headroomBoundBy: 'configuredCap' },
  derivation: 'cap 0 · headroom 0'
};
const disclosed = capacityDisclosure(refusal);
check(
  typeof disclosed === 'string' && /refusedBy: 'capacity'/.test(disclosed) &&
    disclosed.includes('no-headroom'),
  'it names the refusal and its reason on a capacity refusal',
  typeof disclosed === 'string' ? disclosed.slice(0, 120) : String(disclosed)
);
check(
  capacityDisclosure({ success: false, refused: 'occupied' }) === null &&
    capacityDisclosure({ success: true }) === null &&
    capacityDisclosure(null) === null,
  'and says nothing about a refusal that was not the gate, or a success',
  'three negative cases — a disclosure that fired on everything would be noise a reader learns ' +
    'to skip, which is the same as no disclosure'
);

const adopters = proofs.filter((name) =>
  fs.readFileSync(path.join(repoRoot, 'scripts', `${name}.mjs`), 'utf8')
    .includes("from './capacity-disclosure.mjs'")
);
check(
  adopters.length > 0,
  'at least one tracked proof imports it, so it is not dead code that reads like coverage',
  adopters.length
    ? `${adopters.length}: ${adopters.join(', ')}`
    : 'nothing imports it — a backstop nothing calls is a paragraph, not a mechanism'
);
console.log(
  `\n  ADOPTION IS OPT-IN AND PARTIAL, and that is the honest state rather than a plan: there is\n` +
  `  no shared fixture in this suite to install it in (three shared modules at 973d5ce, none a\n` +
  `  harness), so ${adopters.length} of ${rows.length} proof(s) with activation sites disclose a capacity\n` +
  `  refusal in their own output. The rest do not, and this check does not require them to.`
);

// ---------------------------------------------------------------------------

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
