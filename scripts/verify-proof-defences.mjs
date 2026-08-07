#!/usr/bin/env node
// KAN-195: what defends each proof's central assertion — counted, in the
// repository, and checkable.
//
// WHAT FAILURE THIS WOULD CATCH: a proof added to this suite whose central
// assertion has only ever been observed passing, with nothing anywhere
// recording that. Not a proof that is WRONG — a proof about which nobody has
// asked the question. KAN-190 is the case that commissioned this file:
// `verify-restart-survival` §2 was the only CI-side assertion of what its own
// header calls "the single most expensive behaviour in this codebase", it
// passed continuously, and nothing established it could fail. It took a passing
// remark in another ticket's investigation to notice. The gap was not hidden;
// it was simply never enumerated.
//
// So this file enumerates it. Every tracked `scripts/verify-*.mjs` has exactly
// one entry below saying which of three things stands behind its central
// assertion, and a proof in neither this register nor the repository fails BY
// NAME — the same rule `verify-proof-registry` enforces for the CI list, for
// the same reason: a register that drifts silently reproduces the defect it
// documents.
//
// ---------------------------------------------------------------------------
// THE QUESTION THIS REGISTER ANSWERS, stated narrowly on purpose
// ---------------------------------------------------------------------------
//
// For each proof: **is there anything IN THE FILE that would produce a FAIL if
// its central assertion stopped measuring?**
//
//   'mutation'  the proof deliberately breaks the thing it guards — the
//               compiled build, a sibling script, a tracked file, the page or
//               the artifacts it asserts on — and requires the assertion to go
//               red. The strongest, because it exercises the failure path.
//
//   'guard'     no deliberate break, but something establishes the assertion is
//               measuring: a PRECONDITION that fails if the state the section
//               needs did not obtain; a NEGATIVE CASE where the same predicate
//               must return the opposite verdict; a VACUITY check; or a CANARY
//               that shows the instrument responds.
//
//   'none'      neither. Every assertion has only ever been observed passing,
//               and nothing in the file establishes it could do otherwise.
//
// "HAS A MUTATION" IS NOT THE SAME PROPERTY AS "CANNOT PASS VACUOUSLY", and
// this register is built on that distinction rather than around it. KAN-190's
// §6 has no mutation and does have a precondition that caught a false pass;
// `verify-refuses-occupied-directory` has no mutation and runs the same
// activation through a case that must refuse and a case that must proceed,
// which is a stronger statement about that predicate than any single mutation
// would be. Ranking the three would invite exactly the blanket policy the
// ticket that commissioned this file explicitly refused.
//
// WHAT 'guard' DELIBERATELY DOES NOT MEAN. A measurement that COULD fail is not
// a guard. `verify-tab-per-agent` used to be the example: it reads a real column
// width off a real pane and the number could be anything, but nothing in it
// established that the two reads it compares could have DIFFERED, so it was
// 'none' and said why. KAN-198 closed it — two canaries that force the number to
// move and require it to — and it is a 'guard' now. The example is kept because
// the distinction it draws is the whole basis of this register: what moved that
// entry was not "the assertion is more likely to be right", it was "there is now
// something in the file that goes red when the instrument stops measuring". The
// bar for 'guard' is a mechanism in the file, cited by an `anchor` this script
// requires to still be there.
//
// AND WHAT NONE OF THE THREE MEAN: that the proof is good. This register
// answers one question about each file. It says nothing about whether the
// central assertion is the RIGHT one, whether the behaviour matters, or whether
// the proof's subject is what its header says. Those are read like code.
//
// ---------------------------------------------------------------------------
// WHAT IS MECHANICAL HERE AND WHAT IS JUDGEMENT — the boundary, up front
// ---------------------------------------------------------------------------
//
// MECHANICAL (this script fails on all of it):
//
//   - every tracked proof has exactly one entry, and every entry names a
//     tracked proof — in both directions, by name (§1)
//   - a proof that goes through `scripts/mutation.mjs` is registered
//     'mutation', and one registered 'mutation' either goes through the helper
//     or is in the small MUTATES_WITHOUT_THE_HELPER register with a reason (§2).
//     That half is a SWEEP: whoever adds the next mutating proof is caught by
//     it without having remembered anything.
//   - every 'guard' and every registered non-helper 'mutation' cites an
//     `anchor` — literal text that must still appear in that file. Delete the
//     precondition, rename the canary, drop the mutation section, and the entry
//     goes red rather than going quietly stale (§3).
//   - every 'none' names the behaviour it leaves undefended and classifies the
//     cost, and 'expensive' carries a ticket key (§4)
//
// JUDGEMENT (reviewed like code, and this script cannot check it):
//
//   - whether the `central` sentence is really what the proof is about
//   - whether the mechanism the `anchor` points at defends THAT sentence. An
//     anchor proves a precondition still exists; it cannot prove the
//     precondition is load-bearing for the assertion beside it.
//   - whether 'none' should have been 'guard' — i.e. whether the reader missed
//     a defence that is there. Each 'none' entry names what it looked for.
//
// That boundary is the same one `verify-proof-registry` §2 and
// `verify-mutation-harness` §4b draw around their own registers, and it is
// drawn here for the same reason: a register whose reasons look checked, and
// are not, is worse than one that says which half is which.
//
// ---------------------------------------------------------------------------
// THE POLICY QUESTION THIS WAS COMMISSIONED TO INFORM, AND ITS ANSWER
// ---------------------------------------------------------------------------
//
// KAN-190's task agent asked whether "every assertion in every proof carries a
// mutation" should be policy. The numbers, now that they exist — 45 proofs,
// this file included:
//
//   21 carry a mutation.  23 carry a non-mutation guard.
//    1 carries nothing, and it names what that leaves undefended.
//
// (18 / 21 / 3 when this register was first counted. KAN-197 closed the worst
// of the three — see finding 3 below — and KAN-198 closed `verify-tab-per-agent`,
// which was the expensive one: the count moved twice because the work happened,
// which is what a register is for. The intervening 20 / 21 / 2 is what KAN-206
// left behind when it added `verify-proof-verdicts`, 20 / 22 / 1 is what
// KAN-200 arrived at before adding `verify-status-since`, and 21 / 22 / 1 is
// what KAN-208 arrived at before adding `verify-cpu-headroom`.)
//
// The answer this file's author gives, with those numbers in hand: **no, and
// the register is the better instrument.** Three findings support it, and none
// of them was visible before the count.
//
//   1. THE SUITE IS BETTER DEFENDED THAN ANYONE SAID. The ticket that
//      commissioned this named six proofs with mutations and said "for the
//      other ~35, nobody has looked". It is 17 of the 41 that existed, and 21
//      of the remainder carry a real guard. A blanket rule would have been
//      written against a picture that was wrong by a factor of nearly three.
//
//   2. THE 'none' ENTRIES ARE NOT WHERE A BLANKET RULE WOULD HAVE LOOKED. Two
//      of the three were LIVE proofs CI cannot run — the half a blanket rule
//      cannot reach, because the machine it needs is the reason they are
//      excluded. The third (`verify-prompt-is-not-a-template`) is an absence
//      check that a one-line vacuity guard fixes, and a mutation would be
//      ceremony over it. The rule would have generated work in exactly the
//      places that did not need it and none in the place that does.
//
//      KAN-198 IS THE EVIDENCE FOR THAT, and it landed after this was written.
//      Closing `verify-tab-per-agent` needed no mutation — it needed two
//      canaries — and building them turned up that the proof's central number
//      is a CONSTANT on any machine with no herdr app rendering, which is every
//      machine an agent runs on. So the pre-fix code passed it too. A blanket
//      mutation rule would have demanded a mutation of a build for a proof whose
//      actual defect was that its instrument was not connected to anything, and
//      would not have found it. What found it was running the thing and looking.
//
//   3. THE WORST THING FOUND WAS NOT A MISSING MUTATION.
//      `verify-spawn-failure-legibility` had no assertions at all and exited 0
//      unconditionally (KAN-197). A mutation policy would not have found it;
//      counting what defends each central assertion did, on the first pass,
//      because the question "what would make this go red" has no answer for a
//      file that cannot go red. It is now 'mutation': the same predicates its
//      §1 asserts are run against a build with the KAN-24 fix removed and
//      required to fail. THE FINDING STANDS AFTER THE FIX — what found it was
//      the question, not the policy, and closing it needed the machine a
//      blanket rule could never have reached.
//
// So: no blanket mutation rule. What is proposed instead is what this file
// already enforces — every proof answers the question, 'none' is a permitted
// answer that names its gap, and the expensive gaps are tickets. The epic owns
// that decision; this is the recommendation with the numbers under it.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER, said plainly because the gap between two
// honest mechanisms is where this epic keeps finding defects
// ---------------------------------------------------------------------------
//
// IT SUPPLIES ITS OWN INPUT IN §5. The red demonstration mutates a COPY of this
// file's own register and runs it, so it proves the checks in §1-§4 report
// correctly about a register it was handed — NOT that the register committed
// here is TRUE. Nothing mechanical can own that second thing: an entry saying
// 'guard' with an anchor that exists is checkable; whether that anchor's
// mechanism defends the sentence next to it is a reading. What covers it is a
// reviewer reading the entries, and the entries are written to be read that way
// — each names the specific mechanism, not the category.
//
// IT STILL DOES NOT ASSERT THAT A PROOF HAS A VERDICT AT ALL. That absence is
// how KAN-197 existed: `verify-spawn-failure-legibility` ended `process.exit(0)`
// with no assertion anywhere above it, and no check in this repository noticed.
// KAN-197 fixed THAT FILE; it did not build the instrument. The sweep is still
// not here — but the reason it was not written has gone. When this register was
// first counted, a sweep for verdict-derived exits would have gone red on that
// one file immediately, and closing a gap under the time pressure of a check
// that had just started failing was the opposite of what the ticket was for.
// The suite is now clean by that measure, so the sweep can be added on a green
// tree and would hold the line rather than announce a backlog. Filed as
// KAN-206. Whoever builds it should read KAN-197 first: passing such a sweep is
// necessary and nowhere near sufficient — it proves a script CAN report failure,
// never that its assertions can be false, which is still §5's question one level
// down.
//
// IT DISAGREES WITH `verify-mutation-harness` ABOUT ONE FILE, ON PURPOSE. That
// script's `USES_HELPER` is `/from\s+['"]\.\/mutation\.mjs['"]/`, which does not
// match `await import('./mutation.mjs')` — the form
// `verify-agent-power-controls` uses. Nothing goes wrong there today (its
// sweeps are `detector && !USES_HELPER`, and that file trips neither detector),
// but the arm is wrong, and this file's detector covers both forms rather than
// reproducing the miss for consistency's sake. Filed as KAN-199.
//
// Needs no daemon, no herdr, no network and no build: it asks git what is
// tracked and reads the files. It spawns copies of ITSELF in §5 and nothing
// else. Exits non-zero on any failure so a reviewer can re-run it against the
// PR head.
//
// Usage:
//   node scripts/verify-proof-defences.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMutator } from './mutation.mjs';

const selfPath = fileURLToPath(import.meta.url);

/**
 * Set on the children §5 spawns, so a mutant does not run §5 and spawn mutants
 * of its own for ever. A recursion guard rather than a switch: everything §1-§4
 * checks still runs in the child, which is the whole point of spawning it.
 */
const IS_CHILD = process.env.CRABCAST_PROOF_DEFENCES_CHILD === '1';

/**
 * A mutant runs from a scratch directory, so it cannot find the repository by
 * walking up from its own path the way an ordinary run does. §5 hands it the
 * root it must audit; nothing else sets this, and a run with it unset behaves
 * exactly as before it existed.
 */
const repoRoot =
  process.env.CRABCAST_PROOF_DEFENCES_REPO ?? path.resolve(path.dirname(selfPath), '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

// ===========================================================================
// THE REGISTER
//
// One entry per tracked scripts/verify-*.mjs. Fields:
//
//   script      basename, no extension
//   defence     'mutation' | 'guard' | 'none'
//   central     what this proof exists to assert, in one sentence — the thing
//               the defence is a defence OF
//   anchor      literal text that must still appear in the file, pointing at
//               the mechanism. Required for 'guard' and for a 'mutation' that
//               does not go through scripts/mutation.mjs; the helper import is
//               the handle for the rest.
//   undefended  ('none' only) the behaviour left with nothing behind it,
//               NAMED — not "no mutation", but what would still be green
//   cost        ('none' only) 'impossible' | 'expensive' | 'cheap'
//   ticket      ('none' + 'expensive') the ticket where closing it lives
//   note        optional: the boundary of what the defence covers
// ===========================================================================

const PROOF_DEFENCES = [
  // -------------------------------------------------------------------------
  // mutation — through scripts/mutation.mjs
  // -------------------------------------------------------------------------
  {
    script: 'verify-proof-verdicts',
    defence: 'mutation',
    central:
      'every tracked scripts/verify-*.mjs has an exit derived from an accumulated verdict, and at ' +
      'least one call site able to make that verdict negative.',
    note:
      'SEAM: this proves a proof CAN report failure. It says nothing about whether that proof\'s ' +
      'assertions can ever be FALSE — `check(true, …)` is a call site by every measure it applies. ' +
      'That is THIS file\'s question, one level down, and the two must not be read as covering ' +
      'each other. §6 mutates a real proof (verify-config-and-socket) two ways and requires the ' +
      'sweep to catch both: the KAN-197 shape, where the verdict exit becomes exit(0); and the ' +
      'subtler one where the verdict exit is left intact and only the counter\'s increment is ' +
      'removed, which the first property alone would clear. The second mutation is the reason the ' +
      'reachability half exists.'
  },
  {
    script: 'verify-activated-by',
    defence: 'mutation',
    central:
      '`activatedBy` is the supervisor of record on every fleet category and survives a restart — ' +
      'and the identity that sets it really reaches the daemon.',
    note:
      '§1 is the one section in this suite that exercises an activation PRODUCING a parent rather ' +
      'than asserting on a record that already had one. That distinction is the reason KAN-145 ' +
      'shipped `activatedBy: null` for every agent in production with two green proofs.'
  },
  {
    script: 'verify-agent-power-controls',
    defence: 'mutation',
    central:
      'a fleet client can make an agent exist, switch it off and back on, and make it stop ' +
      'existing — with the durable record, the compaction and the ordering answering rather than ' +
      'being discovered.',
    note:
      'Its §15b flips the `missingAgents` comparator and watches §15 go red, and §14 carries a ' +
      'separate precondition that the compaction really ran inside the call it counts reads for. ' +
      'It reaches the helper by `await import()`, which verify-mutation-harness\'s USES_HELPER ' +
      'does not match — KAN-199.'
  },
  {
    script: 'verify-agy-mcp-reversal',
    defence: 'mutation',
    central:
      "`forget` removes CrabCast's key from the antigravity CLI's GLOBAL mcp.json only when no " +
      'other agy agent still needs it — reference-counted, and an unreadable sibling record is ' +
      'never counted as "claims nothing".'
  },
  {
    script: 'verify-ci-proof-residue-is-legible',
    defence: 'mutation',
    central:
      'the one proof that edits a tracked file survives being SIGKILLed, leaves residue that says ' +
      'what put it there, and refuses to start over another run\'s residue rather than adopting it ' +
      'as its baseline.'
  },
  {
    script: 'verify-config-echo-contract',
    defence: 'mutation',
    central:
      'the `config` echo on the poll path is swept against the same declaration the event ' +
      'projection enforces, so a field cannot travel on `list_agents` with nothing looking at it.',
    note:
      'Its §1 is the claim over an unmutated build on a populated fleet; §2 supplies its own ' +
      'undeclared field, so together they say "drift WOULD be caught" and "none is present" ' +
      'separately. Its own header says nothing covers `agent_status`, which echoes the same object.'
  },
  {
    script: 'verify-event-contract',
    defence: 'mutation',
    central:
      'all nine published events are produced by real operations and received with structured ' +
      'payloads on both the socket and the MCP notification path.'
  },
  {
    script: 'verify-event-durability',
    defence: 'mutation',
    central:
      '`agent.configured`, `agent.activated` and `agent.deactivated` REPORT whether the registry ' +
      'write landed instead of asserting that it did.',
    note:
      'It injects the write failure by sealing the log to 0400 and proves the seal took, so it ' +
      'covers "a failed append is reported truthfully" and not "a full disk reaches this path".'
  },
  {
    script: 'verify-fleet-enumeration',
    defence: 'mutation',
    central:
      'a consumer can enumerate a fleet category COMPLETELY — the cursor reaches every row, ' +
      'refuses rather than resets, and survives ties and a moving fleet.'
  },
  {
    script: 'verify-mutation-harness',
    defence: 'mutation',
    central:
      'the shared mutation helper refuses to hand back a build it did not really edit, says WHY, ' +
      'and no proof in the suite mutates a build or a sibling script around it.'
  },
  {
    script: 'verify-proof-cleans-up-when-interrupted',
    defence: 'mutation',
    central:
      'a proof interrupted mid-run leaves no daemon and no scratch directory behind — teardown is ' +
      'not on the happy path.',
    note:
      'It mutates a SIBLING SCRIPT (strips the signal handler) and watches the leak come back, and ' +
      'it is the script in this suite that says PRECONDITION-that-the-mutant-ran out loud.'
  },
  {
    script: 'verify-reconfiguration-refuses',
    defence: 'mutation',
    central:
      'reconfiguration is answered PER ATTRIBUTE, and a change that would need a respawn is ' +
      'REFUSED rather than performed — so no reconciler can quietly cost an agent its conversation.',
    note:
      'Five mutations, including the exact bug the task exists to prevent. Its refusals are ' +
      'asserted against evidence taken from OUTSIDE the response: the pane id, the stub argv log, ' +
      'a hash of the conversation on disk, and the durable record read off the log.'
  },
  {
    script: 'verify-restart-survival',
    defence: 'mutation',
    central:
      'a fresh daemon over surviving panes RE-ATTACHES rather than re-spawning — for BOTH ' +
      'launchers, including the `claude` one the live proof cannot afford to run.',
    note:
      'The mutation is §7 and it arrived with KAN-190. Before that this behaviour had one CI-side ' +
      'assertion and nothing establishing it could fail; this register exists because of how that ' +
      'was noticed.'
  },
  {
    script: 'verify-send-confirms-delivery',
    defence: 'mutation',
    central:
      '`send_to_agent` reports whether a message LANDED rather than whether it was typed — three ' +
      'verdicts, distinctly, with the keystroke log as evidence.',
    note:
      'Its shim draws the composer marker it is then checked against, so COMPOSER_MARKERS itself ' +
      'is covered only by verify-send-confirms-delivery-live. Both headers say so.'
  },
  {
    script: 'verify-spawn-failure-legibility',
    defence: 'mutation',
    central:
      'a failed agent spawn is REPORTED rather than swallowed — the KAN-24 outage, where a refused ' +
      "`herdr agent start` produced a session marked 'active' and `success: true`.",
    note:
      'THE ENTRY THIS REGISTER WAS WORTH BUILDING FOR, and it read `none` until KAN-197: the file ' +
      'contained no assertion of any kind and ended `process.exit(0)`, so it was the only proof in ' +
      'the suite that could not go red. Its §2 now takes the SAME predicate set §1 uses, runs it ' +
      'against a copy of the build with the KAN-24 catch arm removed, and requires the four ' +
      'central rows to come back FALSE — with a control spawn on the real build in the same ' +
      'seconds, because a mutant that reports nothing because nothing was refused is ' +
      'indistinguishable from one that swallowed a refusal. What §2 does NOT establish is that ' +
      "`dist/` is the build CrabCast runs; §1 and §3 are the assertions about the real one. It is " +
      'excluded from CI and hand-run, so its NOT RUN is a counted failure rather than a third ' +
      'verdict — nothing runs it again.'
  },
  {
    script: 'verify-state-read-echoes-config',
    defence: 'mutation',
    central:
      'every fleet category echoes the agent\'s frozen configuration, `unstartedAgents` is distinct ' +
      'from standby, and the echo survives a daemon restart.',
    note: 'It PRODUCES every category before asserting completeness over it, which is a guard in its own right.'
  },
  {
    script: 'verify-status-since',
    defence: 'mutation',
    central:
      '`statusSince` on an agent row is when THIS DAEMON first observed that agent in the status ' +
      'beside it, is null when it has not watched it change, and is null for the whole fleet after ' +
      'a restart rather than invented from the boot time.',
    note:
      'SEAM: §1-§4 run a real daemon and let its OWN 30-second sweep produce every timestamp, ' +
      'which is the half KAN-145 was missing — a proof that supplies the record it asserts on has ' +
      'not tested that anything real produces it. §5-§6 drive the memory in-process with ' +
      'observations the script builds, because an unreachable census and an agent vanishing ' +
      'cannot be produced against the shim inside a 30-second sweep; those sections prove the ' +
      'FUNCTION and not the wiring, and the header says so. The distinction earned its keep: the ' +
      'field was first written as a router field, every in-process assertion passed, and §2 — the ' +
      'one that reads a timestamp back over a real socket — is what found that one router per ' +
      'connection made it permanently null. What NOTHING here covers is a real herdr: the shim ' +
      'reports the statuses it is told to.'
  },

  // -------------------------------------------------------------------------
  // mutation — not through the helper, because what they mutate is not a build
  // or a sibling script. Each is in MUTATES_WITHOUT_THE_HELPER below with the
  // reason, and each cites the section.
  // -------------------------------------------------------------------------
  {
    script: 'verify-callers-directory',
    defence: 'mutation',
    central:
      "everything CrabCast puts in the CALLER's directory is opted into, merged rather than " +
      'replaced, named in the activation response, and reversible.',
    anchor: 'the resume check goes RED against the command the pre-fix launcher built',
    note:
      'It mutates ARTIFACTS rather than a build: §9 reconstructs the state the pre-fix code would ' +
      'have produced — the old unconditional `--continue` command, a real written file without ' +
      'their server — and requires the same predicates the sections above used to go red on it.'
  },
  {
    script: 'verify-ci-wiring-guards',
    defence: 'mutation',
    central:
      'the two CI-wiring guards go red for every shape that stops the proof-list audit running, ' +
      'and stay green for every shape that genuinely runs it.',
    anchor: 'both guards fail by name',
    note:
      'It mutates the TRACKED `.github/workflows/ci.yml` one shape at a time and runs both guards ' +
      'against it as real processes. It also refuses to start over a dirty ci.yml, which is a ' +
      'precondition on top of the mutation — and the reason that refusal exists is KAN-172.'
  },
  {
    script: 'verify-readme-is-current',
    defence: 'mutation',
    central:
      "the README's pasted blocks still show what the program prints, per command, and every " +
      'fenced block of program output is covered or registered as uncovered with a reason.',
    anchor: 'got === canary.expect',
    note:
      'It mutates the PAGE: six canaries, four that must be caught and two that must NOT be, ' +
      'because a mask wide enough to pass against anything is this check\'s own way of ' +
      'overclaiming. §4 additionally runs it against the two revisions that really had drifted.'
  },

  // -------------------------------------------------------------------------
  // guard — a precondition, a negative case, a vacuity check or a canary
  // -------------------------------------------------------------------------
  {
    script: 'verify-activate-requires-agent',
    defence: 'guard',
    central:
      'activation starts the launcher that was declared and never a silent shell; an unknown ' +
      'launcher refuses at configure, naming the valid ones.',
    anchor: "asking for 'shell' by name still gets one — the fixture path verify scripts use is intact",
    note:
      'NEGATIVE CASE, both directions on one predicate: §2 requires an unknown launcher to be ' +
      'refused and §3 requires an explicit `shell` to still work, so a refusal that had widened to ' +
      'everything fails §3 and one that had narrowed to nothing fails §2. What is NOT guarded is ' +
      '§4\'s audit over every constructed command — an empty command log would satisfy it.'
  },
  {
    script: 'verify-activate-verified-existence',
    defence: 'guard',
    central:
      '`activate` reports success only for an agent that verifiably exists, and keeps ' +
      '"herdr said no", "herdr did not answer" and "the agent is not there" apart.',
    anchor: 'success: false, naming the agent that is not there',
    note:
      'NEGATIVE CASE on the central predicate: §1 requires `verified: true` from a real ' +
      'activation and §2 injects a herdr that reports success and starts nothing, requiring the ' +
      'same field to come back false. The verified flag is therefore observed moving.'
  },
  {
    script: 'verify-agent-capacity',
    defence: 'guard',
    central:
      'the concurrent-agent cap is derived from the hardware with reproducible arithmetic, moves ' +
      'with what the machine is actually doing, honours the gate triple, and refuses with the ' +
      'constraint that actually bound.',
    anchor: 'every bad window rejects to null',
    note:
      'NEGATIVE FIXTURES: §12 drives five measurement windows that must each be REJECTED (zero ' +
      'agent trees, negative cores, zero cores, absurd rss, zero-length window), so a sampler that ' +
      'had started believing anything fails. §4 additionally runs the same arithmetic against ' +
      'hardware this machine is not, with the answers written down. REVISITED BY KAN-208, which ' +
      'changed what the live CPU-side term measures (observed cores, not the load average) and ' +
      'therefore what "moves with" meant in the sentence above: §8 now runs four rows differing ' +
      'only in the CPU observation and requires the measured and unmeasured ones to DISAGREE, and ' +
      '§15b requires a cpu-bound refusal to name cpu on a machine whose load average would have ' +
      'allowed it. Both are new negative cases, so the defence is stronger than it was and is ' +
      'still a guard rather than a mutation. The instrument itself, and the whole path from ' +
      '/proc/stat to a headroom figure, is verify-cpu-headroom\'s subject, not this file\'s.'
  },
  {
    script: 'verify-cpu-headroom',
    defence: 'guard',
    central:
      'live headroom bounds on cores actually in use rather than on the 1-minute load average, so ' +
      'a machine with idle cores is not refused for looking busy — and a machine whose cores are ' +
      'genuinely full still is.',
    anchor: 'THE RECONSTRUCTED OLD MODEL DID NOT REFUSE',
    note:
      'NEGATIVE CASES IN BOTH DIRECTIONS, which is the whole point of this proof: §2 requires the ' +
      'RECONSTRUCTED pre-KAN-208 arithmetic to REFUSE the reported figures before it requires the ' +
      'shipped model to allow them, so a run where the old model also allowed would fail rather ' +
      'than look like a fix; §3 requires a refusal on 3.9-of-4 cores with the load average reading ' +
      '0.3, which no weakening of the gate could pass; §4 requires count- and memory-bound ' +
      'refusals to still happen and to still name their own constraint. §1 and §5 carry rejection ' +
      'fixtures — malformed /proc/stat lines, backwards counters, an expired observation — that ' +
      'must each produce null rather than a number. WHAT THIS ENTRY DOES NOT CLAIM: §2 through §5 ' +
      'construct the MachineFacts they assert on, so they defend the arithmetic and not the ' +
      'wiring; §6 is the section that takes a real /proc/stat window through readMachineFacts and ' +
      'requires it to arrive, and the daemon sampler that publishes it in production is covered by ' +
      'neither — see that file\'s header, which names the hole and where the evidence for it lives.'
  },
  {
    script: 'verify-agent-preemption',
    defence: 'guard',
    central:
      'a higher-priority agent can take a lower-priority one\'s slot — visibly, reversibly, and ' +
      'never automatically.',
    anchor: 'topOfScale === null &&',
    note:
      'NEGATIVE CASES on `selectVictim`: §6 requires it to choose NOTHING at the top of the scale ' +
      'and §7 requires a low-priority unpreemptable agent never to be offered, against §2 where it ' +
      'must choose a specific one. A selector that had started returning the first row fails both.'
  },
  {
    script: 'verify-agent-resumption',
    defence: 'guard',
    central:
      'the registry survives an unclean death and a torn tail, and reconciliation honours INTENT ' +
      'rather than history — a preempted agent stays down, a never-activated one is not started.',
    anchor: 'a preempted agent must NOT be expected — a reboot must not overturn the decision',
    note:
      'NEGATIVE CASES: the boot expectation set is asserted to EXCLUDE specific agents as well as ' +
      'to include others, so a reconciler that restored everything fails. Its own header is ' +
      'explicit that it cannot stand in for the reboot proof.'
  },
  {
    script: 'verify-cli-parity',
    defence: 'guard',
    central:
      'the CLI covers the daemon\'s socket API, and an action added to the router cannot ship ' +
      'without either a command or a recorded reason for not having one.',
    anchor: 'it will not report on coverage it did not measure.',
    note:
      'VACUITY, twice: the action set is re-derived from `src/router.ts` on every run rather than ' +
      'copied, and a missing `dist/cli.js` is a loud refusal to report rather than a section that ' +
      'passes over an empty table. `COMMANDS.length > 0` is asserted before it is used.'
  },
  {
    script: 'verify-cli-refusal',
    defence: 'guard',
    central:
      'a CLI refusal is legible and non-zero, `--json` is the daemon\'s response and nothing else, ' +
      'and the exit codes mean what `--help` says they mean.',
    anchor: "the daemon's own cwd IS ${daemonCwd} — so a daemon-side resolve would land on its victim",
    note:
      'PRECONDITION on §9: the daemon\'s inherited cwd is measured before the relative-path ' +
      'refusals are asserted, because every check below it would otherwise pass for the wrong ' +
      'reason. §2 also reproduces §1\'s derivation deterministically through the renderer, so the ' +
      'byte-for-byte claim is not resting on one live run.'
  },
  {
    script: 'verify-config-and-socket',
    defence: 'guard',
    central:
      'the daemon REFUSES a config it cannot honour rather than repairing it, and exactly one ' +
      'daemon owns the socket.',
    anchor: 'daemon came up and owns the socket',
    note:
      'NEGATIVE/POSITIVE PAIR on the loader: §1 requires four bad configs to exit 1 with the field ' +
      'named, §2 requires a good one to start and round-trip. A loader that refused everything ' +
      'fails §2; one that refused nothing fails §1.'
  },
  {
    script: 'verify-daemon-provenance',
    defence: 'guard',
    central:
      '`daemon_status` answers WHICH BUILD IS RUNNING and answers "I don\'t know" when it does ' +
      'not know — never something plausible.',
    anchor: 'PRECONDITION: dist/router.js really differs from what the daemon booted on',
    note:
      'PRECONDITIONS, nine of them, and they are the reason this file is 1100 lines: §3 runs TWO ' +
      'daemons off ONE tree at one instant and asserts the two builds really differ before asking ' +
      'them to disagree; §4b asserts `git` really cannot be spawned through the stripped PATH AND ' +
      'really can through the normal one, so the difference measured is the PATH.'
  },
  {
    script: 'verify-fleet-switch-live',
    defence: 'guard',
    central:
      'against a real herdr, `herdr agent list` agrees that an agent came up, went down, and came ' +
      'back across a daemon SIGKILL — a census taken from something other than the daemon under test.',
    anchor: '!baseline.includes(PROBE_AGENT)',
    note:
      'BASELINE: the machine is measured before anything is spawned and again at teardown, so §2\'s ' +
      '"a pane that was not there, and then is" is a difference rather than a presence, and a leak ' +
      'from a crashed run is visible to the next run\'s baseline.'
  },
  {
    script: 'verify-herdr-release',
    defence: 'guard',
    central:
      'what CrabCast does against ONE named herdr release, run out-of-place — so each version in ' +
      "the README's table is a version somebody actually ran.",
    anchor: 'and it is NOT the file the caller has installed',
    note:
      'PRECONDITION, and it is the whole proof: the binary under test must not BE the installed ' +
      'one, asserted before the lifecycle runs. Without it the script would report on the herdr ' +
      'already on PATH while claiming the downloaded release.'
  },
  {
    script: 'verify-herdr-version-notice',
    defence: 'guard',
    central:
      'the herdr version verdict reaches a PERSON on stderr rather than only a log file, and what ' +
      'it says is what the evidence supports.',
    anchor: 'stderr is EMPTY — nothing was said about the version at all',
    note:
      'NEGATIVE CASE: §3 requires a SUPPORTED release to produce no notice on stderr, no notice on ' +
      'stdout and no softened version of one, against §2 and §4 where the notice must arrive. A ' +
      'notice that had started firing unconditionally fails §3. §5 adds an exact-count structural ' +
      'check that only one version comparison exists in src/.'
  },
  {
    script: 'verify-idempotent-lifecycle',
    defence: 'guard',
    central:
      'calling `activate` and `deactivate` again is SAFE — one pane, no error, the two ways of not ' +
      'running stay distinct, and a FOREIGN occupant is still refused.',
    anchor: '(setup) THE SEAL TOOK',
    note:
      'PRECONDITIONS labelled `(setup)`, five of them, against the classic trap its header names: ' +
      '"nothing bad happened" and "nothing happened" are the same observation. The strongest is ' +
      'this one — the script attempts the append itself and requires it to throw, so a run as root ' +
      'fails loudly rather than exercising the healthy path. ITS MUTATIONS ARE IN A PR BODY, NOT ' +
      'IN THE FILE: the header records that each assertion was watched go red once, by hand, which ' +
      'is not something a re-run reproduces.'
  },
  {
    script: 'verify-list-agents-survives-restart',
    defence: 'guard',
    central:
      '`list_agents` answers from what EXISTS rather than from the daemon\'s session map, which a ' +
      'restart empties while the herdr panes keep running.',
    anchor: "a stranger's live pane is reported as foreign rather than silently dropped",
    note:
      'TOTAL PARTITION WITH EXACT COUNTS: §3 puts four panes in front of the router — two ours, ' +
      'one unbacked, one foreign — and requires each bucket to have exactly the right members. An ' +
      'over-broad filter fails one bucket and an over-narrow one fails another, so neither ' +
      'direction is a pass.'
  },
  {
    script: 'verify-mcp-tools',
    defence: 'guard',
    central:
      'the CrabCast MCP server serves the daemon\'s socket API as tools over real stdio against a ' +
      'really-running daemon, and a failure arrives FLAGGED rather than as ordinary text.',
    anchor: 'a failed deactivation is flagged isError',
    note:
      'NEGATIVE CASE on the isError mapping: §3 requires a successful round trip to come back ' +
      'unflagged and §6 requires a failed deactivation to come back `isError: true` with ' +
      '`success: false` inside it. A mapping stuck either way fails one of them.'
  },
  {
    script: 'verify-no-attach-steal',
    defence: 'guard',
    central:
      'a second activation of one agent returns the SAME session rather than opening a takeover ' +
      'attach that evicts the first client.',
    anchor: 'APPEARED in the census — the census reacts to this machine changing',
    note:
      'CANARY, and it is the model this register points other scripts at: the census is required ' +
      'to REACT to a pane this run created before §4 is allowed to conclude anything from the ' +
      'census, so "no butchr-* pane moved" is a measurement rather than an instrument that stopped ' +
      'answering. It reports the canary `[skipped]` by name when the run borrowed a pane instead ' +
      'of making one, rather than folding the skip into a pass.'
  },
  {
    script: 'verify-pretrust-survives-concurrency',
    defence: 'guard',
    central:
      'the pre-trust write to ~/.claude.json survives concurrent activations and a competing ' +
      'writer, and a clobber that will not repair REFUSES the activation instead of wedging an ' +
      'agent behind success: true.',
    anchor: 'the activation fails honestly: success is false, not a wedged agent behind success: true',
    note:
      'NEGATIVE CASE on the same activation predicate: a TRANSIENT clobber must still succeed ' +
      '(the write was retried) and a HOSTILE one must fail with the trust file named. A retry that ' +
      'had become infinite fails the second; one that had been removed fails the first. The ' +
      'clobber is also asserted to have really happened before either is read.'
  },
  {
    script: 'verify-proof-registry',
    defence: 'guard',
    central:
      'every tracked proof is either run by CI or excluded with a reason and a citation, and the ' +
      'audit that says so runs from a live step outside the list it audits.',
    anchor: 'the array literal is closed — the whole list was read, not a prefix of it',
    note:
      'SELF-CHECK plus VACUITY: a read that ran off the end of the `scripts=(` array would take ' +
      'the entries it never saw with it and report an all-clear over the remainder, so the close ' +
      'is asserted; and `proofs.length > 0` is asserted before the reconciliation. §4 asks ' +
      'structurally whether its own CI step is live rather than whether the text is present.'
  },
  {
    script: 'verify-pty-init-rejects-unknown-session',
    defence: 'guard',
    central:
      'a real daemon REFUSES a PTY request naming a session it does not have, instead of ' +
      'substituting one or spawning a default shell nobody asked for.',
    anchor: 'pty_init accepts a session this daemon holds',
    note:
      'NEGATIVE/POSITIVE PAIR: the fabricated session id must be refused by pty_init, pty_input ' +
      'and pty_resize, and a REAL session must be accepted — and re-accepted on a second init, ' +
      'which is the reconnect shape. A refusal that had widened to everything fails the positive.'
  },
  {
    script: 'verify-refuses-occupied-directory',
    defence: 'guard',
    central:
      '`activate` refuses to spawn into a directory somebody else\'s agent is working in, and ' +
      'refuses just as hard when it cannot find out — "not ours" and "nothing is there" are ' +
      'different facts.',
    anchor: 'from an unreachable herdr must not read as an all-clear',
    note:
      'NINE CASES ACROSS BOTH VERDICTS on one predicate: our own pane must PROCEED (c, c2, c3, ' +
      'c4), a foreign one must REFUSE (a, b), an unreachable herdr must refuse as `unverifiable` ' +
      '(d), and configure must REPORT rather than refuse (e, e2). Each refusal is asserted against ' +
      "the stub's own argv log, so \"no `agent start` was issued\" is evidence rather than inference."
  },
  {
    script: 'verify-send-confirms-delivery-live',
    defence: 'guard',
    central:
      'against a REAL Claude Code pane through a REAL herdr: COMPOSER_MARKERS names a caret the ' +
      'pane actually draws, and a genuinely contended recipient is still confirmed.',
    anchor: 'the pane is readable before the blackout (the precondition)',
    note:
      'PRECONDITION on the UNVERIFIABLE case: the pane is read successfully BEFORE the blackout is ' +
      'induced, so §4\'s "cannot be observed" verdict is caused by the blackout rather than by a ' +
      'pane that was never readable. §0 is the other half — the marker is read off a pane Claude ' +
      'Code drew, which is the one fact its CI sibling cannot hold.'
  },

  {
    script: 'verify-tab-per-agent',
    defence: 'guard',
    central:
      "an agent's COLUMN WIDTH does not shrink as the fleet grows — each agent lands in a tab of " +
      'its own, and a third arrival does not narrow the first two.',
    anchor: 'at least one deliberate change MOVED the width this run reads',
    note:
      'KAN-198, and it is TWO canaries plus a negative case rather than one mechanism. §3 resizes ' +
      "this run's own attach PTY and requires the read to follow it to the exact requested width " +
      'and back — that is the READ path (pane -> shell -> `herdr agent read` -> parse). §4 is the ' +
      'canary the ticket asked for: a second pane in the subject\'s own tab, the pre-fix placement ' +
      'in miniature, whose width must DROP — that is LAYOUT. The anchor cites the disjunction the ' +
      'two feed, because that is the load-bearing line: if NEITHER deliberate change moves the ' +
      'number, every width in the run is unfalsifiable and the run is a FAIL. Both canaries assert ' +
      'a positive fingerprint (smaller, still parsing as a width, and for §3 exactly the width ' +
      'requested) rather than "the number differed", which noise satisfies. §7 puts three synthetic ' +
      'censuses through `survivorVerdict` and requires pass / not-run / fail, so the vacuity ' +
      'verdict is reachable code rather than an unexecuted branch.\n' +
      'WHAT KAN-198 FOUND WHILE BUILDING IT, because it is larger than the gap it was filed for: ' +
      'width is produced by a terminal app laying out a RENDERED tab, and that is as true of a real ' +
      'herdr with no app attached as it is of the shimmed one in CI. On such a machine — every ' +
      'agent-driven run — every pane just reports its attach client\'s size, so the third spawn ' +
      'could not have narrowed anything and the PRE-FIX code passes this proof too. Measured: the ' +
      'pre-fix script with `widthOf` frozen at a constant exits 0 and prints PASS. §4 is what ' +
      'detects that state, and §5 then reports the central assertion NOT RUN (red) instead of ' +
      'passing it.\n' +
      'READ THIS BEFORE READING "guard" AS COVERAGE OF THE CENTRAL ASSERTION, BECAUSE IT IS NOT. ' +
      'What is defended everywhere is that the run cannot report a width nothing could have ' +
      'changed: §3 + §4 feed a disjunction that goes RED if neither deliberate change moves the ' +
      'number. THE CENTRAL ASSERTION ITSELF — a third arrival does not narrow the first two — is ' +
      'defended ONLY where §4 goes green, and on a headless machine §4 is itself NOT RUN, so there ' +
      'the central assertion still has nothing behind it. What the reclassification bought is that ' +
      'such a run now says so (§5 reports NOT RUN, red) instead of printing PASS. The gap moved ' +
      'from invisible to named; it did not close.\n' +
      'SEAMS. (a) The GREEN arm of §4 has never been observed — it needs a machine with the herdr ' +
      'app attached and rendering, and every run so far has been headless, so what is demonstrated ' +
      'is the canary firing, not the canary clearing. KAN-211. (b) Both canaries read the same way ' +
      'the assertions do, so a fault common to the forcing and the reading is invisible to both. ' +
      '(c) §7 supplies its own input: it covers the predicate, not the census, and only the ' +
      'populated arm is covered live. (d) Nothing here touches the KAN-32 THRESHOLD: the outage ' +
      'was at seven agents and this runs three.\n' +
      'THE OUTPUT RECORDS WHICH MACHINE IT RAN ON, on every run including a passing one — ' +
      '`layout: LIVE (…)` / `NONE (…)` / `UNKNOWN (…)`. That line is the fix for the defect shape ' +
      'this file found and had not been named before: VALIDITY CONTINGENT ON WHO RAN IT, with ' +
      'nothing in the output recording which mode it was in. This proof was valid exactly when a ' +
      'human ran it and vacuous exactly when an agent did, and for its whole life nothing said ' +
      'which. A verdict alone still would not.'
  },

  // -------------------------------------------------------------------------
  // none — and each names what that leaves undefended. This is the half the
  // ticket that commissioned this file was written for.
  // -------------------------------------------------------------------------
  {
    script: 'verify-prompt-is-not-a-template',
    defence: 'none',
    central:
      'CrabCast accepts a RENDERED prompt and does not interpolate — no placeholder syntax, no ' +
      'variable set, no template resolution left in the daemon — and an over-large prompt is ' +
      'refused legibly rather than truncated.',
    undefended:
      "§1's deletion assertions. It walks `src/`, collects every line containing a doubled brace, " +
      'and requires the list to be empty. Nothing establishes the walk visited anything: an ' +
      'emptied `src/` (or one whose files had all moved under a directory the walk does not reach) ' +
      'produces zero offenders and a PASS, in the same words the healthy run uses. `src/prompt.ts ' +
      'does not exist` and `dist/prompt.js does not exist` have the same property one level over — ' +
      'they are absence checks over paths nothing asserts should otherwise be populated. §2 (a ' +
      'prompt reaches the agent byte for byte) and §3 (the size bound refuses) are real ' +
      'measurements and are not what this entry is about.',
    cost: 'cheap',
    note:
      'ONE LINE CLOSES IT: count the files the walk read and assert it is non-zero, the way ' +
      'verify-mutation-harness asserts `tracked.length > 10` before sweeping. Not filed as a ' +
      'ticket because filing a ticket for a one-line vacuity guard is how a register becomes a ' +
      'backlog nobody reads; it is written down here so the next person to touch this file has it ' +
      'in front of them.'
  },

  // -------------------------------------------------------------------------
  // this file
  // -------------------------------------------------------------------------
  {
    script: 'verify-proof-defences',
    defence: 'mutation',
    central:
      'every tracked proof answers the question "what would make this go red", and a proof or an ' +
      'entry that drifts out of agreement with the other fails BY NAME.',
    note:
      'Its §5 mutates a COPY of this register and runs it as a child, requiring each sabotage to ' +
      'exit 1 with a named FAIL. That proves the checks report correctly about a register they are ' +
      'handed; it does not prove the register committed here is TRUE, and the header says so.'
  }
];

/**
 * Proofs registered 'mutation' that do NOT go through `scripts/mutation.mjs`,
 * with the reason. The same escape-hatch shape as
 * `verify-mutation-harness`'s COPIES_BUT_DOES_NOT_MUTATE, for the same reason:
 * the sweep in §2 is what has nothing to forget, and this list is what it costs
 * to be an exception.
 *
 * What §2 checks mechanically is that each entry names a real registered
 * 'mutation' that really does not import the helper. Whether the reason is TRUE
 * is reviewed like code.
 */
const MUTATES_WITHOUT_THE_HELPER = [
  {
    script: 'verify-callers-directory',
    reason:
      'It mutates ARTIFACTS, not a build: §9 reconstructs the launcher command the pre-fix code ' +
      'built and the file shape a real write leaves behind, and requires the sections above to go ' +
      'red on them. The helper copies a compiled build or a source file; there is no third entry ' +
      'point and inventing one for a reconstructed string would be ceremony.'
  },
  {
    script: 'verify-ci-wiring-guards',
    reason:
      'It mutates the TRACKED `.github/workflows/ci.yml` in place and restores it, which is a ' +
      'different hazard from copying a build — it needs a marker, a refusal to start over residue, ' +
      'and a byte-identical restore assertion, none of which the helper offers. Its own proof of ' +
      'those three is verify-ci-proof-residue-is-legible, which DOES use the helper.'
  },
  {
    script: 'verify-readme-is-current',
    reason:
      'Its canaries mutate the PAGE TEXT in memory — a string it read, altered six ways, handed to ' +
      'its own auditor — and never write a file or run a mutant. Two of the six must come back ' +
      'GREEN, which the helper has no notion of: it is built around "this edit must land", not ' +
      '"this edit must not be detected".'
  }
];

/**
 * Does this proof reach the shared mutation helper?
 *
 * Covers the static and the dynamic form. `verify-mutation-harness`'s
 * USES_HELPER covers only the static one, which misses
 * `verify-agent-power-controls` — see KAN-199 and this file's header. The
 * disagreement is deliberate; reproducing the miss for consistency would be
 * choosing the wrong half of a known defect.
 */
const USES_HELPER = /(?:from|import\s*\()\s*['"]\.\/mutation\.mjs['"]/;

const DEFENCES = ['mutation', 'guard', 'none'];
const COSTS = ['impossible', 'expensive', 'cheap'];

// ---------------------------------------------------------------------------
// 1. Reconciliation: scripts/ against the register, in both directions.
// ---------------------------------------------------------------------------

console.log('=== 1. Every proof has exactly one register entry ===\n');

const tracked = execFileSync('git', ['ls-files', 'scripts/verify-*.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean);

const proofs = tracked.map((f) => path.basename(f, '.mjs')).sort();

// A reconciliation over an empty set agrees with everything. Asserted rather
// than assumed, because that is the failure this whole file is about.
check(
  proofs.length > 10,
  '(setup) git tracks a proof suite to reconcile against — a run over an empty set would agree ' +
    'with any register at all',
  `${proofs.length} tracked proof(s)`
);

const byScript = new Map();
const duplicates = [];
for (const e of PROOF_DEFENCES) {
  if (byScript.has(e.script)) duplicates.push(e.script);
  else byScript.set(e.script, e);
}
check(duplicates.length === 0, 'no proof is registered twice', duplicates.join(', '));

for (const name of proofs) {
  check(
    byScript.has(name),
    `scripts/${name}.mjs has a register entry`,
    byScript.has(name)
      ? byScript.get(name).defence
      : 'NOT in PROOF_DEFENCES — add an entry saying what stands behind its central assertion. ' +
        "'none' is a permitted answer; it has to name the behaviour it leaves undefended."
  );
}

const proofSet = new Set(proofs);
for (const e of PROOF_DEFENCES) {
  check(
    proofSet.has(e.script),
    `register entry '${e.script}' names a tracked proof`,
    proofSet.has(e.script) ? '' : `scripts/${e.script}.mjs is not tracked by git — remove the entry`
  );
}

// The shape of every entry, before anything reads its fields.
for (const e of PROOF_DEFENCES) {
  check(
    DEFENCES.includes(e.defence),
    `entry '${e.script}' declares one of ${DEFENCES.join(' | ')}`,
    JSON.stringify(e.defence)
  );
  check(
    typeof e.central === 'string' && e.central.trim().length >= 40,
    `entry '${e.script}' says what the proof's central assertion IS`,
    'without it, "guard" and "none" are answers to a question nobody wrote down'
  );
}

// ---------------------------------------------------------------------------
// 2. THE SWEEP — the half with nothing to forget.
//
// The register above is a list, and a list is only as good as the thing that
// notices when it stops matching. This is that thing: it walks the proofs and
// asks each one whether it reaches `scripts/mutation.mjs`, then compares the
// answer to what the register claims. Whoever adds the next mutating proof is
// caught by it without having remembered anything, and — the direction that
// matters more — a proof whose mutation is DELETED stops matching the register
// that still says it has one.
// ---------------------------------------------------------------------------

console.log('\n=== 2. What the files say, against what the register claims ===\n');

const sourceOf = new Map(
  proofs.map((n) => [n, fs.readFileSync(path.join(repoRoot, 'scripts', `${n}.mjs`), 'utf8')])
);

const helperUsers = proofs.filter((n) => USES_HELPER.test(sourceOf.get(n)));
check(
  helperUsers.length > 0,
  '(setup) the helper detector matches something — a detector that matched nothing would report ' +
    'the same all-clear as one that matched everything',
  `${helperUsers.length} proof(s) reach scripts/mutation.mjs`
);

for (const name of helperUsers) {
  const e = byScript.get(name);
  check(
    e?.defence === 'mutation',
    `scripts/${name}.mjs goes through scripts/mutation.mjs and is registered 'mutation'`,
    e?.defence === 'mutation'
      ? ''
      : `registered '${e?.defence}' — it mutates a build or a sibling script, so the register is ` +
        'behind the file'
  );
}

const exempt = new Map(MUTATES_WITHOUT_THE_HELPER.map((x) => [x.script, x]));
for (const e of PROOF_DEFENCES.filter((x) => x.defence === 'mutation')) {
  const usesHelper = USES_HELPER.test(sourceOf.get(e.script) ?? '');
  check(
    usesHelper || exempt.has(e.script),
    `'${e.script}' is registered 'mutation' and its mutation is accounted for`,
    usesHelper
      ? 'through scripts/mutation.mjs'
      : exempt.has(e.script)
        ? 'in MUTATES_WITHOUT_THE_HELPER, with a reason'
        : "the file does not reach scripts/mutation.mjs and is not in MUTATES_WITHOUT_THE_HELPER. " +
          'Either the mutation was removed and this entry is now false, or it went around the helper.'
  );
}

// The exemption register is held to the standard it is an escape hatch from —
// the same shape verify-proof-registry §2 and verify-mutation-harness §4b use.
for (const x of MUTATES_WITHOUT_THE_HELPER) {
  const e = byScript.get(x.script);
  check(
    e?.defence === 'mutation',
    `exemption '${x.script}' names an entry registered 'mutation'`,
    e ? `registered '${e.defence}'` : 'no register entry at all — this exemption is stale'
  );
  check(
    !USES_HELPER.test(sourceOf.get(x.script) ?? ''),
    `exemption '${x.script}' still does NOT use the helper — otherwise it is stale and should go`
  );
  check(
    typeof x.reason === 'string' && x.reason.trim().length >= 120,
    `exemption '${x.script}' carries a reason a reader can act on, not just a name`
  );
}

// ---------------------------------------------------------------------------
// 3. Anchors — the defence is still in the file it is claimed from.
//
// An entry saying 'guard' is a claim about a mechanism. Without this, deleting
// the precondition, renaming the canary or dropping the mutation section leaves
// the register saying the proof is defended, in the same words it uses when the
// defence is there — which is this register becoming the thing it documents.
//
// WHAT AN ANCHOR PROVES AND WHAT IT DOES NOT: that the text is still there. It
// cannot prove the mechanism it names still defends the assertion beside it —
// a precondition can survive a refactor that moved the assertion out from under
// it. That is the reading half, and it is the reviewer's.
// ---------------------------------------------------------------------------

console.log('\n=== 3. Every claimed defence is still in the file ===\n');

for (const e of PROOF_DEFENCES) {
  const usesHelper = USES_HELPER.test(sourceOf.get(e.script) ?? '');
  const anchorRequired = e.defence === 'guard' || (e.defence === 'mutation' && !usesHelper);

  if (!anchorRequired) {
    if (e.anchor === undefined) continue;
    // An anchor on an entry that does not need one is still a claim, so it is
    // still checked rather than ignored.
  } else {
    check(
      typeof e.anchor === 'string' && e.anchor.length >= 12,
      `'${e.script}' cites an anchor for its ${e.defence}`,
      e.defence === 'guard'
        ? 'a guard with no citation is a category, not a mechanism'
        : 'a mutation outside the helper has no other handle on it'
    );
  }

  if (typeof e.anchor !== 'string' || e.anchor.length < 12) continue;
  const text = sourceOf.get(e.script) ?? '';
  const n = text.split(e.anchor).length - 1;
  const line = n ? text.slice(0, text.indexOf(e.anchor)).split('\n').length : 0;
  check(
    n >= 1,
    `'${e.script}' anchor is still in scripts/${e.script}.mjs`,
    n >= 1
      ? `scripts/${e.script}.mjs:${line}`
      : `${JSON.stringify(e.anchor.slice(0, 60))} is gone — either the defence went, in which ` +
        `case this entry is now false, or it was reworded, in which case move the anchor`
  );
}

// ---------------------------------------------------------------------------
// 4. 'none' is a permitted answer that has to say what it costs.
//
// The point of this register is to make a gap VISIBLE, not to close it. So
// 'none' fails nothing — but it names the behaviour left undefended, and it
// classifies the cost, and 'expensive' carries the ticket where closing it
// lives. That is the same discipline verify-readme-is-current's UNCOVERED
// register keeps for the page blocks nobody reproduces.
// ---------------------------------------------------------------------------

console.log('\n=== 4. Every gap names itself, and the expensive ones are filed ===\n');

for (const e of PROOF_DEFENCES.filter((x) => x.defence === 'none')) {
  check(
    typeof e.undefended === 'string' && e.undefended.trim().length >= 80,
    `'${e.script}' NAMES the behaviour it leaves undefended`,
    'not "no mutation" — what would still be green if the assertion stopped measuring'
  );
  check(
    COSTS.includes(e.cost),
    `'${e.script}' classifies the cost of closing it as ${COSTS.join(' | ')}`,
    JSON.stringify(e.cost)
  );
  if (e.cost === 'expensive') {
    check(
      typeof e.ticket === 'string' && /^KAN-\d+$/.test(e.ticket),
      `'${e.script}' is expensive, so it carries the ticket where closing it lives`,
      JSON.stringify(e.ticket ?? null)
    );
  }
  check(
    !USES_HELPER.test(sourceOf.get(e.script) ?? ''),
    `'${e.script}' really has no mutation — it does not reach scripts/mutation.mjs`
  );
}

// ---------------------------------------------------------------------------
// 5. THE CHECKS ABOVE CAN ACTUALLY FAIL.
//
// A register that has only ever been green is the thing this register is about,
// one level up. So each sabotage below is applied to a COPY of this file
// through `scripts/mutation.mjs`, the copy is RUN as a real process, and its
// exit status and its FAIL line are read.
//
// THE RECURSION GUARD: the child runs with CRABCAST_PROOF_DEFENCES_CHILD=1 and
// skips this section — everything §1-§4 checks still runs there, which is the
// reason for spawning it.
//
// WHAT THIS SECTION PROVES AND WHAT IT DOES NOT. It proves the checks report
// correctly about a register they are handed. It does NOT prove the register
// committed in this file is true — it supplies its own input, in the exact
// shape KAN-145's two scripts did. The header names who covers that (nobody
// mechanical; a reviewer reading the entries) rather than leaving the reader to
// infer a coverage that does not exist.
// ---------------------------------------------------------------------------

if (IS_CHILD) {
  console.log('\n=== 5. SKIPPED — this is a mutant spawned by a parent run ===\n');
} else {
  console.log('\n=== 5. The checks above go red when the register stops being true ===\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan195-defences-'));
  const { mutateScript, mutationsSkipped } = makeMutator({
    // Nothing here mutates a BUILD; `mutateScript` is the only entry point used.
    distDir: path.join(repoRoot, 'scripts'),
    scratch: tmp,
    report: {
      pass: (label, detail) => check(true, label, detail),
      fail: (label, detail) => check(false, label, detail)
    }
  });

  /**
   * Each sabotage is a real edit to a copy of the register, and each `find` is
   * text that appears exactly once in this file — the helper refuses anything
   * else, which is what stops a sabotage silently matching nothing and the row
   * then reporting on an unmutated copy.
   */
  const SABOTAGES = [
    {
      id: 'entry-removed',
      what: 'a proof loses its register entry',
      edits: [
        {
          find: "    script: 'verify-cli-refusal',\n    defence: 'guard',",
          replace: "    script: 'verify-cli-refusal-THAT-IS-NOT-TRACKED',\n    defence: 'guard',"
        }
      ],
      expect: /FAIL\s+scripts\/verify-cli-refusal\.mjs has a register entry/,
      because:
        'the proof is in scripts/ and in neither the register nor anywhere else — the reconciliation ' +
        'names it, and names the stale entry in the other direction too'
    },
    {
      id: 'mutation-downgraded',
      what: 'a proof that mutates is registered as having nothing',
      edits: [
        {
          find: "    script: 'verify-activated-by',\n    defence: 'mutation',",
          replace: "    script: 'verify-activated-by',\n    defence: 'none',"
        }
      ],
      expect: /FAIL\s+scripts\/verify-activated-by\.mjs goes through scripts\/mutation\.mjs and is registered 'mutation'/,
      because:
        'the SWEEP reads the file rather than the register, so a register that has fallen behind ' +
        'the code is caught without anyone having remembered to update anything'
    },
    {
      id: 'guard-fabricated',
      what: 'a guard is claimed with an anchor that is not in the file',
      edits: [
        {
          // TWO REASONS THIS IS BUILT BY CONCATENATION rather than written as
          // one literal, and both are the helper's exact-count rule doing its
          // job. The bare sentence appears in the register entry AND here, so
          // the `anchor: ` prefix is what narrows it to one occurrence — and
          // with the prefix written inline, THIS LINE would be the second
          // occurrence of the narrowed string. Splitting it means the value
          // matches the register and nothing matches this. Measured, not
          // reasoned: written as one literal it failed with `found 2`.
          find:
            'anchor: ' +
            "'PRECONDITION: dist/router.js really differs from what the daemon booted on',",
          replace: "anchor: 'PRECONDITION: a sentence nobody ever wrote in that file',"
        }
      ],
      expect: /FAIL\s+'verify-daemon-provenance' anchor is still in scripts\/verify-daemon-provenance\.mjs/,
      because:
        'this is the shape that matters most — the register says "defended" and the mechanism it ' +
        'names is not there. It fires identically when a real guard is deleted or reworded.'
    },
    {
      id: 'gap-unfiled',
      what: 'an expensive gap loses the ticket where closing it lives',
      // IT PROMOTES A CHEAP GAP RATHER THAN UNFILING AN EXPENSIVE ONE, and that
      // is a rewrite rather than the original. This sabotage used to delete
      // `ticket: 'KAN-198'` from `verify-tab-per-agent`'s 'none' entry — until
      // KAN-198 closed that gap, moved the entry to 'guard' and took the ticket
      // line with it, leaving this row's anchor matching nothing. The helper
      // caught it (`found 0`, a counted FAIL rather than a silent no-op) which
      // is the whole reason the exact-count rule exists.
      //
      // There is now NO 'expensive' entry in the register to unfile, so the
      // condition §4 checks has to be manufactured: promoting the one remaining
      // 'cheap' gap creates an expensive gap carrying no ticket, which is the
      // same state by a different road. If a future entry is 'expensive' again,
      // deleting its ticket is the more direct sabotage and should replace this.
      edits: [{ find: "    cost: 'cheap',\n", replace: "    cost: 'expensive',\n" }],
      expect: /FAIL\s+'verify-prompt-is-not-a-template' is expensive, so it carries the ticket/,
      because:
        'an expensive gap with no ticket is a gap that has been noticed and then put down, which ' +
        'reads on the page exactly like one that is being worked on'
    },
    {
      id: 'exemption-stale',
      what: 'a non-helper mutation loses its exemption entry',
      edits: [
        {
          find: "    script: 'verify-readme-is-current',\n    reason:",
          replace: "    script: 'verify-readme-is-current-GONE',\n    reason:"
        }
      ],
      expect: /FAIL\s+'verify-readme-is-current' is registered 'mutation' and its mutation is accounted for/,
      because:
        'the escape hatch has to cost something, or every entry takes it. An exemption that stops ' +
        'naming a real entry fails from both sides.'
    }
  ];

  const rows = [];
  for (const s of SABOTAGES) {
    sabotage: {
      const mutant = mutateScript(s.id, selfPath, s.edits, { deps: ['mutation.mjs'] });
      if (!mutant) break sabotage;

      const run = spawnSync(process.execPath, [mutant], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CRABCAST_PROOF_DEFENCES_CHILD: '1',
          CRABCAST_PROOF_DEFENCES_REPO: repoRoot
        },
        timeout: 120_000
      });
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;

      // PRECONDITION THAT THE MUTANT RAN. A mutant that died on startup
      // produces no FAIL line and no exit 0 either — but it also produces no
      // evidence, and `scripts/mutation.mjs` says in its own header that every
      // section spawning a mutant owes this. Without it, "the child exited 1"
      // is satisfied by a child that crashed before reading a single entry.
      const ran = /=== 1\. Every proof has exactly one register entry ===/.test(out);
      check(
        ran,
        `[${s.id}] the mutant really ran the register checks`,
        ran ? '' : `no section-1 banner in ${out.length} chars of output: ${out.slice(0, 300)}`
      );
      // And that it skipped this section rather than recursing.
      check(
        /=== 5\. SKIPPED/.test(out),
        `[${s.id}] and stopped before spawning mutants of its own`
      );

      const named = s.expect.test(out);
      check(
        run.status === 1,
        `[${s.id}] ${s.what} — the run goes RED`,
        `exit ${run.status}${run.signal ? ` (signal ${run.signal})` : ''}`
      );
      check(
        named,
        `[${s.id}] and it fails BY NAME rather than by count`,
        named
          ? (out.match(s.expect) ?? [''])[0].trim()
          : `no line matching ${s.expect} — a red run that does not say WHICH entry is wrong sends ` +
            'the reader through 42 of them'
      );
      rows.push({ ...s, code: run.status, named });
    }
  }

  console.log('\n  --- the matrix ---\n');
  const w = Math.max(...SABOTAGES.map((s) => s.id.length));
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(w)}  exit ${r.code}  ${r.named ? 'named' : 'NOT NAMED'}   ${r.what}`);
  }
  console.log('');
  for (const r of rows) console.log(`  ${r.id}: ${r.because.replace(/\s+/g, ' ')}`);

  const skipped = mutationsSkipped();
  if (skipped.length) {
    console.log(`\n  ${skipped.length} sabotage(s) DID NOT APPLY and their rows never ran: ${skipped.join(', ')}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The register, printed. This is the artifact — the checks above exist so it
// cannot quietly stop being true.
// ---------------------------------------------------------------------------

console.log('\n=== THE DEFENCE REGISTER ===\n');

const width = Math.max(...PROOF_DEFENCES.map((e) => e.script.length));
const order = { mutation: 0, guard: 1, none: 2 };
for (const e of [...PROOF_DEFENCES].sort(
  (a, b) => order[a.defence] - order[b.defence] || a.script.localeCompare(b.script)
)) {
  const helper = USES_HELPER.test(sourceOf.get(e.script) ?? '');
  const tag =
    e.defence === 'mutation'
      ? helper ? 'MUTATION (via mutation.mjs)' : 'MUTATION (registered exception)'
      : e.defence === 'guard'
        ? 'GUARD'
        : `NOTHING — ${e.cost}${e.ticket ? `, ${e.ticket}` : ''}`;
  console.log(`  ${e.script.padEnd(width)}  ${tag}`);
  if (e.anchor) console.log(`  ${' '.repeat(width)}    anchor: ${JSON.stringify(e.anchor)}`);
  if (e.undefended) console.log(`  ${' '.repeat(width)}    UNDEFENDED: ${e.undefended.replace(/\s+/g, ' ')}`);
}

const count = (d) => PROOF_DEFENCES.filter((e) => e.defence === d).length;
console.log(
  `\n  ${PROOF_DEFENCES.length} proof(s): ${count('mutation')} carry a mutation, ` +
    `${count('guard')} carry a non-mutation guard, ${count('none')} carry nothing.`
);
console.log(
  `  Of the ${count('none')} with nothing: ` +
    COSTS.map((c) => `${PROOF_DEFENCES.filter((e) => e.defence === 'none' && e.cost === c).length} ${c}`).join(', ') +
    '.'
);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
