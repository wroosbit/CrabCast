// THE REGISTER FOR THE IMPORTED BUTCHR PROOFS — which of them gate CrabCast,
// which do not, and why, each with a citation from the proof's own source.
//
// KAN-519. This is data, not a proof: `scripts/verify-butchr-proof-pin.mjs`
// audits its internal consistency on every CI run, and
// `scripts/butchr-proof-reconcile.mjs` reconciles it against the pinned
// checkout inside the `butchr-proofs` job, where the proofs actually exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS INSTEAD OF AN ENTRY IN verify-proof-registry.mjs
//
// KAN-519 task 4 says to register every excluded script in that file's
// EXCLUSIONS. That is structurally impossible for these, and the impossibility
// is in that register's own checks rather than in anybody's preference:
//
//   verify-proof-registry.mjs:547  check(exists, `excluded '${e.script}' still exists`)
//                                  -> resolves scripts/<name>.mjs IN CRABCAST'S TREE
//   verify-proof-registry.mjs:568  quotes text found exactly once in ITS OWN SOURCE
//
// Both bind an entry to a tracked CrabCast file. The imported proofs are
// neither tracked nor CrabCast's — they live in an untracked CI-time checkout
// of `wroosbit/butchr` at the pin (KAN-518, docs/butchr-proof-import.md). An
// entry there would fail the register it was added to.
//
// So the DISCIPLINE is carried over rather than the location: every entry below
// names a reason and quotes its own source verbatim, and a script that is in
// neither list is a failure by name — the same three properties EXCLUSIONS has.
//
// ⚠ `verify-mcp-assembly`, which KAN-519 requires be held excluded, DOES NOT
// EXIST in either tree at these refs — not in CrabCast's `scripts/` and not
// among the 18 `verify-crabcast-*` proofs at the pin. It is recorded in
// ABSENT_AT_THESE_REFS below rather than silently dropped, because "excluded"
// and "not there" are different facts and a register that collapses them is
// lying about its own coverage. The other required hold,
// `verify-activate-verified-existence`, IS a CrabCast file and was already in
// EXCLUSIONS (verify-proof-registry.mjs:349) before this ticket; it is left
// exactly as it stands.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WIRED — run by the `butchr-proofs` job, and each one is here because it was
 * MEASURED to go red on a deliberate CrabCast change, herdr-free.
 *
 * `consumerBehaviour` is what KAN-519 task 3 requires of the failure output:
 * the job names WHICH CONSUMER BEHAVIOUR broke, never which script exited
 * non-zero. A reader of a red build should not have to open the proof.
 *
 * `redDrive` records the mutation that was actually applied to CrabCast and
 * what it produced. A proof that has only ever passed is evidence of nothing,
 * so no proof is wired here on the strength of a green alone.
 */
export const WIRED = [
  {
    script: 'verify-crabcast-census-disclosure',
    consumerBehaviour:
      "CrabCast's list_agents census carries `unreadableRecordsTotal` to Butchr — the count of " +
      'registry rows CrabCast could not read. Butchr reports its fleet as short by that many rows; ' +
      'if the field stops arriving, Butchr silently under-counts the fleet and nothing says so.',
    gatingSection: '§8 LIVE — the fields actually arrive from a real CrabCast',
    evidence: {
      quote: 'CI-RUNNABLE: partial — sections 1-7 assert in CI. They stand up their own',
      note: 'sections 1-7 replay a capture and are constant against a pinned Butchr; §8 is the arm that reads a live peer, and it is the only reason this script is wired'
    },
    redDrive: {
      mutation: "src/router.ts:6449 `unreadableRecordsTotal:` renamed to `unreadableRecordsTotalRENAMED:` on the list_agents response",
      result: 'BUILD_EXIT=0, PROOF_EXIT=1 — §8 FAIL "a live v14 peer sends unreadableRecordsTotal, and we read it as a number: got null", §1-§7 still green'
    }
  },
  {
    script: 'verify-crabcast-priority-roundtrip',
    consumerBehaviour:
      'CrabCast stores and reports back the `priority` Butchr sent with configure_agent, and ' +
      'discriminates between the three values. Butchr decides what a full machine stands down; a ' +
      'priority CrabCast accepts and does not keep makes every agent equally preemptable, and ' +
      'configure_agent answers success either way.',
    gatingSection: '§6 ON THE WIRE — CrabCast reports back the value Butchr sent',
    evidence: {
      quote: 'CI-RUNNABLE: partial — §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports',
      note: '§1-§5 are constant against a pinned Butchr; §6 asks a live peer to report the value back, which is the arm that can notice CrabCast'
    },
    redDrive: {
      mutation: "src/router.ts configEcho() made to echo `{ ...intent.record.config, priority: 99 }`",
      result: 'BUILD_EXIT=0, PROOF_EXIT=1 — 4 FAILs in §6 including "agent_status reports config.priority 3 for epic — IT ROUND-TRIPPED" and the three-distinct-values check'
    }
  },
  {
    script: 'verify-crabcast-supervisor-exemption',
    consumerBehaviour:
      "CrabCast round-trips the three gate flags Butchr sends (`refusable`, `chargeable`, " +
      "`preemptable`) AND its capacity gate acts on them — an exempt supervisor moves the exempt " +
      'count and does not consume a running slot. If the flags are dropped, Butchr\'s supervisors ' +
      'start being charged against a cap they were exempted from and the fleet quietly stops staffing.',
    gatingSection: '§6 ON THE WIRE / §7 THEIR GATE ACTS ON IT',
    evidence: {
      quote: 'CI-RUNNABLE: partial — §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports',
      note: '§1-§5 are constant against a pinned Butchr; §6 and §7 drive a live peer and its real capacity gate'
    },
    redDrive: {
      mutation: "src/router.ts configEcho() made to echo `chargeable: !intent.record.config.chargeable`",
      result: 'BUILD_EXIT=0, PROOF_EXIT=1 — 3 FAILs in §6, one per agent type: "agent_status reports config.chargeable = false for epic — IT ROUND-TRIPPED"'
    }
  }
];

/**
 * EXCLUDED — not run by the job, each with the reason it cannot gate CrabCast
 * and a citation from its own source.
 *
 * `class` is the script's own `CI-RUNNABLE:` classification, kept because it is
 * the vocabulary KAN-117 and KAN-518 both reason in. It is NOT the reason for
 * exclusion: two `partial` scripts are wired above and four are excluded here,
 * so the class predicts nothing on its own and the per-arm measurement is what
 * decides. That is KAN-519's "per-arm evaluation is mandatory, not a nicety".
 */
export const EXCLUDED = [
  // ── measured against a live scratch peer and found unable to gate ─────────
  {
    script: 'verify-crabcast-mcp-residue-cleared',
    class: 'partial',
    reason:
      'A LIVE LYING GREEN, and the worst candidate in the set. §3-§8 are the only sections that ' +
      'could notice CrabCast, their skip condition is a CrabCast checkout at ~/code/wroosbit/crabcast ' +
      'which no runner has, and the script keeps NO skip tally and does not import lib/verdict-exit.mjs ' +
      '— so it announces the skip in prose and hands back EXIT=0. Reproduced under this ticket at ' +
      'the refs below: peer present, §3 skipped, EXIT=0. Filed as KAN-595 against Butchr; not patched ' +
      'here, that tree is epic/KAN-39\'s.',
    evidence: {
      quote: 'CI-RUNNABLE: partial — §1 and §2 read `daemon/src/*.ts` as text and assert in',
      note: 'its own header claims §1-§2 as the CI half; what it does not say is that the other six sections hand back a zero when they are skipped'
    }
  },
  {
    script: 'verify-crabcast-standing',
    class: 'partial',
    reason:
      'Its live §6 needs a peer already serving real agent rows to join against. Measured against a ' +
      'scratch peer it FAILS 2 assertions ("every live row yields a real verdict", "the live reading ' +
      'agrees with the committed v8 capture") — a red about the fixture rather than about CrabCast, ' +
      'which is precisely the unrelated red this job must not import.',
    evidence: {
      quote: 'CI-RUNNABLE: partial — sections 1-5 assert in CI. They import the built',
      note: 'sections 1-5 are constant against a pinned Butchr, and the live section that is not constant cannot be satisfied by a peer this job stands up clean'
    }
  },
  {
    script: 'verify-crabcast-adopt-launcher-vocabulary',
    class: 'partial',
    reason:
      'Its live §6 SKIPS against a peer this job stands up — "the peer is serving no row that adoption ' +
      'would reach" — so it exits 2 INCOMPLETE. Honest, and it gates nothing: an adoption vocabulary ' +
      'check needs a peer with an adoptable row, which a scratch peer does not have. Wiring it would ' +
      'add twenty minutes and an INCOMPLETE to every build.',
    evidence: {
      quote: 'CI-RUNNABLE: partial — §1-§5 assert in CI. They read source as text and stand',
      note: 'the sections it claims for CI are the constant ones; the arm that reads a peer has no row to read on a runner'
    }
  },
  {
    script: 'verify-crabcast-session-restore',
    class: 'partial',
    reason:
      'Its live §5 needs a REAL pty. Measured against a scratch peer behind the herdr shim it FAILS ' +
      '"the mirror filled from a real pty_init snapshot" — the shim starts no terminal, so the failure ' +
      'is about the runner and not about CrabCast. A red check about the runner is the thing KAN-117 ' +
      'exists to avoid.',
    evidence: {
      quote: 'CI-RUNNABLE: partial — sections 1-4 assert in CI. They stand up their own',
      note: 'sections 1-4 answer their own frames and are constant against a pinned Butchr; §5 is the live arm and it needs a pty no runner supplies'
    }
  },

  // ── the `yes` class: CI-runnable, and constant against a pinned Butchr ────
  //
  // These are the original lying-green-check, now by name (KAN-519's own
  // table). They run perfectly well on a runner and read Butchr's source,
  // Butchr's dist, or their own socket — every one of which is FIXED at the
  // pin. A CrabCast PR cannot change their answer.
  {
    script: 'verify-crabcast-channel-startup-supervision',
    class: 'yes',
    reason:
      'Reads Butchr\'s own `daemon/src/*.ts` as text. Against a PINNED Butchr that text is a constant, ' +
      'so this check cannot change its answer in response to anything in CrabCast. It would run, cost ' +
      'minutes, and gate nothing — a required check built from constants is the defect this story is about.',
    evidence: {
      quote: 'CI-RUNNABLE: yes — reads `daemon/src/*.ts` as TEXT and asserts against them in',
      note: 'its own header names the input, and at a pinned ref that input never varies'
    }
  },
  {
    script: 'verify-crabcast-reconnect-resync',
    class: 'yes',
    reason:
      'Stands up its OWN Unix socket and answers its OWN frames. The peer it talks to is the script ' +
      'itself, so no CrabCast code is on the path at all and no CrabCast change can redden it.',
    evidence: {
      quote: 'CI-RUNNABLE: yes — stands up its own Unix socket and answers its own frames',
      note: 'the peer is the script itself — the clearest case in the set of a check whose input is not CrabCast'
    }
  },
  {
    script: 'verify-crabcast-runtime-switch',
    class: 'yes',
    reason:
      "Imports Butchr's built `daemon/dist/*.js` and asserts against it. At the pin that build is a " +
      'constant, so the assertion is about Butchr at e8729f5 and never about CrabCast.',
    evidence: {
      quote: 'CI-RUNNABLE: yes — imports the built daemon modules and asserts against them',
      note: "the built modules are Butchr's own, frozen at the pin"
    }
  },

  // ── the `no` class: cannot run herdr-free ────────────────────────────────
  //
  // Real herdr, real panes, or the `crabcast` binary driving real terminals.
  // The shimmed herdr this job uses answers herdr's JSON shapes and starts no
  // terminal, which is enough for a census and a capacity gate and is not
  // enough for these. Running them would produce a red about the runner.
  {
    script: 'verify-crabcast-brief-reachable-live',
    class: 'no',
    reason:
      'Needs a live CrabCast daemon with real capacity and a real pane to deliver a brief into. ' +
      'AC1 of KAN-117 asks for a runner with no herdr installed, and this script cannot run there — ' +
      'its failure on a runner would describe the runner.',
    evidence: {
      quote: 'CI-RUNNABLE: no — it needs a live CrabCast daemon on a Unix socket, room in',
      note: 'self-disclosed as not CI-runnable, and the reason it gives is capacity and a real pane'
    }
  },
  {
    script: 'verify-crabcast-claude-launcher-live',
    class: 'no',
    reason:
      'Needs a real CrabCast daemon with room for another agent and a real `claude` launcher behind a ' +
      'real pane. The shim starts no terminal and there is no launcher to drive on a runner.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs a real CrabCast daemon, real capacity for one more',
      note: 'self-disclosed, and the launcher it drives is a real interactive process'
    }
  },
  {
    script: 'verify-crabcast-confirm-present-name-join',
    class: 'no',
    reason:
      'Needs a real CrabCast daemon at BUTCHR_CRABCAST_SOCKET serving a fleet whose pane names it can ' +
      'join against. A scratch peer has no such fleet, so the join has nothing to confirm.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`',
      note: 'self-disclosed; the join is against a populated fleet rather than a peer standing up clean'
    }
  },
  {
    script: 'verify-crabcast-peer-restart-live',
    class: 'no',
    reason:
      'Needs the `crabcast` binary, a real herdr and a real pty, and restarts the peer underneath ' +
      'itself. None of the three is available to a runner behind a JSON shim.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs the `crabcast` binary, a real herdr and a real pty. It',
      note: 'self-disclosed, and it names all three of the things a runner has not got'
    }
  },
  {
    script: 'verify-crabcast-reconnect-live',
    class: 'no',
    reason:
      'Needs a real CrabCast daemon it can disconnect from and reconnect to while real agents keep ' +
      'running behind real panes. The shim has no panes to keep alive across the break.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`,',
      note: 'self-disclosed; what it reconnects to has to have survived, which requires real panes'
    }
  },
  {
    script: 'verify-crabcast-rude-death-live',
    class: 'no',
    reason:
      'Needs the `crabcast` binary on PATH and kills it rudely to watch what survives. A runner has no ' +
      'such binary installed, and the script says every setup failure of that kind is a failure rather ' +
      'than a skip — so on a runner it is a guaranteed red about the runner.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs the `crabcast` binary on PATH. Every setup failure',
      note: 'self-disclosed, and it deliberately refuses to skip its way out of a missing binary'
    }
  },
  {
    script: 'verify-crabcast-runtime-live',
    class: 'no',
    reason:
      'Needs a real CrabCast daemon and drives real agents through real panes. It exits 1 rather than 2 ' +
      'on a missing socket, deliberately, because none of its assertions can run at all — nothing was ' +
      'attempted, as against attempted-and-partially-proved (KAN-373). On a runner that 1 is a red about ' +
      'the runner.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`;',
      note: 'self-disclosed; its missing-socket exit of 1 is correct for it and is not a verdict about CrabCast'
    }
  },
  {
    script: 'verify-crabcast-second-activation-resumes',
    class: 'no',
    reason:
      'Needs a real CrabCast daemon with real capacity and a real conversation to resume — the property ' +
      'is that a second activation resumes rather than restarts, which is only observable against a real ' +
      'agent process in a real pane.',
    evidence: {
      quote: 'CI-RUNNABLE: no — needs a real CrabCast daemon, real capacity for one agent,',
      note: 'self-disclosed; a resumed conversation is the subject, and the shim has no conversation'
    }
  }
];

/**
 * Named because "excluded" and "not there" are different facts.
 *
 * KAN-519 task 4 requires `verify-mcp-assembly` be held out. It is not a
 * CrabCast script and it is not one of the 18 `verify-crabcast-*` proofs at
 * the pin, so there is nothing for either register to exclude. Recording it
 * here keeps the requirement visible instead of leaving a reader to infer a
 * coverage decision from an absence.
 */
export const ABSENT_AT_THESE_REFS = [
  {
    script: 'verify-mcp-assembly',
    requiredBy: 'KAN-519 task 4, quoting KAN-117: "failed under a scratch HOME, cause unconfirmed — out until proven, not until assumed"',
    finding:
      'No such file in CrabCast\'s scripts/ and no such proof among the 18 verify-crabcast-* at the pin. ' +
      'The hold is honoured vacuously: nothing runs it, because it does not exist at these refs. If it ' +
      'lands later it must be classified before it is wired, and it is NOT covered by any entry above.'
  }
];

/** Every `verify-crabcast-*` proof at the pin must appear in exactly one list. */
export const EXPECTED_PROOF_COUNT = WIRED.length + EXCLUDED.length;
