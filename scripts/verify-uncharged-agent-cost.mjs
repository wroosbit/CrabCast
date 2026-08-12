#!/usr/bin/env node
// KAN-275: the agents this daemon does not charge, in the two terms that were
// getting them wrong in opposite directions.
//
// WHAT FAILURE THIS WOULD CATCH: the capacity gate deriving a LARGER cap
// because the agents on the machine were cheap ones it does not charge. The
// sampler enumerates every agent-runtime process tree on the machine and groups
// them by process ancestry; nothing joins a tree to an agent record, so a
// mostly-idle supervisor — or another orchestrator's fleet entirely — is a
// sample in the figure this gate divides a budget for CHARGED agents by. A
// smaller divisor is a bigger cap, so the discount arrives as a permission to
// start more agents rather than as a saving. Measured on the machine this was
// written on, 2026-08-12: `0.135 core/agent` averaged over four trees, none of
// which this daemon managed, deriving `capByCpu 18` on a four-core box while
// the same report read `running: 0 charged agent(s)`.
//
// It would equally catch the mirror-image defect on the static ceiling, which
// is the one that had no term at all: `capByMemory` divides `totalBytes`, which
// nets out nothing, so an uncharged agent's ~0.9 GB was absent from that
// arithmetic entirely.
//
// AND IT WOULD CATCH THE OVER-CORRECTION, which is why §3 exists. The live
// memory term divides `availableBytes` (MemAvailable), from which the kernel
// has ALREADY taken every uncharged agent's resident memory. Subtracting a
// reserve there too would charge for the same memory twice. One reserve, on the
// static term only — a proof that asserted "the reserve is applied" without
// pinning where would pass just as well against the double charge.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT DOES NOT COVER, named because the gap is the whole reason
// KAN-275 stopped short of the fix it was commissioned for.
//
// The floor in §1 BOUNDS the damage from an unattributable divisor. It does not
// ATTRIBUTE anything, and nothing here tests that the sampler measures this
// daemon's agents rather than somebody else's — because the sampler cannot
// currently tell, and no code in `src/` claims to. The only handle on a running
// tree is its `cwd`, and `herdr.ts` records from a measured failure that
// ownership is never decided on `cwd`, since a process can `cd` and disown
// itself. Until a tree can be joined to an agent record, "the divisor is
// measured from OUR chargeable agents" is a sentence no script in this
// repository can make true. That work is KAN-275's open half; this file is
// honest about being the bound and not the fix.
//
// Every fixture below is DERIVED from the shipped constants and from this
// machine's own facts rather than written down (KAN-245: a hard-coded
// `9_999_999` expired silently). Each section also asserts that the branch it
// exists to exercise was actually taken — a floor that never engaged and a
// reserve that never moved a figure both look exactly like a passing test.
// ---------------------------------------------------------------------------

import {
  EXEMPT_AGENT_MEMORY_BYTES,
  MEASURED_AGENT_COST,
  computeCapacity,
  describeCapacity,
  flooredCost,
  readMachineFacts
} from '../dist/capacity.js';

const MIB = 1024 ** 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

// This machine, as the gate would read it — but with the two live instruments
// pinned out. `cpu` and `stall` are properties of whatever else is running on
// the box right now; leaving them in would make every figure below depend on
// what the rest of the fleet happened to be doing, which is the volatility this
// ticket is about rather than something to reproduce inside its proof.
const live = readMachineFacts();
const FACTS = {
  cores: live.cores,
  totalBytes: live.totalBytes,
  availableBytes: live.availableBytes,
  load1: 0.2,
  cpu: null,
  stall: null
};
console.log(
  `machine under test (derived, this box): ${FACTS.cores} cores, ` +
  `${(FACTS.totalBytes / 1024 ** 3).toFixed(1)} GiB RAM, ` +
  `${(FACTS.availableBytes / 1024 ** 3).toFixed(1)} GiB available`
);
console.log(
  `shipped constants: seed ${Math.round(MEASURED_AGENT_COST.residentBytes / MIB)} MB / ` +
  `${MEASURED_AGENT_COST.cores} core, uncharged-agent reserve ` +
  `${Math.round(EXEMPT_AGENT_MEMORY_BYTES / MIB)} MB`
);

// ---------------------------------------------------------------- 1. floor --
rule('1. THE DIVISOR FLOOR — a cheap measurement cannot buy a bigger cap');

// Derived from the seed, not written down: a quarter of it is unambiguously
// "cheaper", and it follows the seed if the seed ever moves.
const CHEAP = {
  residentBytes: MEASURED_AGENT_COST.residentBytes / 4,
  cores: MEASURED_AGENT_COST.cores / 4,
  sampledAt: Date.parse('2026-08-12T00:00:00Z'),
  windowSeconds: 60,
  agentTrees: 4
};
const DEAR = {
  residentBytes: MEASURED_AGENT_COST.residentBytes * 2,
  cores: MEASURED_AGENT_COST.cores * 2,
  sampledAt: Date.parse('2026-08-12T00:00:00Z'),
  windowSeconds: 60,
  agentTrees: 4
};

const seeded = computeCapacity(FACTS, 0);
const cheap = computeCapacity(FACTS, 0, { measured: CHEAP });
const dear = computeCapacity(FACTS, 0, { measured: DEAR });

console.log(`\nseed:  cap ${seeded.cap} (cpu ${seeded.capByCpu}, memory ${seeded.capByMemory})`);
console.log(`cheap: cap ${cheap.cap} (cpu ${cheap.capByCpu}, memory ${cheap.capByMemory})`);
console.log(`dear:  cap ${dear.cap} (cpu ${dear.capByCpu}, memory ${dear.capByMemory})`);

check(
  cheap.cap === seeded.cap,
  'a measurement cheaper than the seed leaves the cap where the seed put it',
  `${seeded.cap} → ${cheap.cap}`
);
check(
  cheap.cost.cores === MEASURED_AGENT_COST.cores &&
    cheap.cost.residentBytes === MEASURED_AGENT_COST.residentBytes,
  'both dimensions divide by the seed, not by the cheap measurement'
);
// VACUITY GUARD. Everything above would also pass if the measurement had simply
// been ignored, or if `pick()` never consulted it — the cap would sit at the
// seed's answer either way. This is the assertion that the FLOOR is what put it
// there: the pre-floor figure must be the measurement we supplied.
check(
  cheap.flooredDimensions.length === 2 &&
    cheap.costBeforeFloor.cores === CHEAP.cores &&
    cheap.costBeforeFloor.residentBytes === CHEAP.residentBytes,
  'VACUITY: the floor is what bound — the measurement reached the arithmetic and was raised',
  `pre-floor ${cheap.costBeforeFloor.cores} core → ${cheap.cost.cores}`
);
// The other side. A floor asserted only where it bites would be satisfied by a
// clamp that pinned the divisor to the seed unconditionally, which would delete
// the measurement entirely.
check(
  dear.cap < seeded.cap && dear.flooredDimensions.length === 0 && dear.cost.cores === DEAR.cores,
  'a measurement DEARER than the seed is still believed in full',
  `${seeded.cap} → ${dear.cap}, floored dimensions: ${dear.flooredDimensions.length}`
);
// An operator who typed a number has decided; the floor must not argue with
// them. Same precedence rule as `startingAgentCores`.
const overridden = computeCapacity(FACTS, 0, {
  measured: CHEAP,
  overrides: { cores: CHEAP.cores }
});
check(
  overridden.cost.cores === CHEAP.cores && !overridden.flooredDimensions.includes('cores'),
  'an explicit operator override is honoured outright, not raised to the seed'
);

// ------------------------------------------------------------- 2. reserve --
rule('2. THE UNCHARGED RESERVE — the static ceiling nets out agents it does not charge');

// Derived so the branch cannot be vacuous: enough uncharged agents that the
// reserve is guaranteed to be worth at least one whole slot of the divisor in
// force, whatever this machine's memory happens to be.
const EXEMPT_N = Math.ceil(MEASURED_AGENT_COST.residentBytes / EXEMPT_AGENT_MEMORY_BYTES) + 1;
const withNone = computeCapacity(FACTS, 0, { exemptRunning: 0 });
const withExempt = computeCapacity(FACTS, 0, { exemptRunning: EXEMPT_N });

console.log(
  `\n${EXEMPT_N} uncharged agent(s) reserve ` +
  `${(withExempt.exemptReserveBytes / 1024 ** 3).toFixed(1)} GiB off the static ceiling`
);
console.log(`capByMemory      ${withNone.capByMemory} → ${withExempt.capByMemory}`);
console.log(`headroomByMemory ${withNone.headroomByMemory} → ${withExempt.headroomByMemory}`);

check(
  withExempt.exemptReserveBytes === EXEMPT_N * EXEMPT_AGENT_MEMORY_BYTES,
  'the reserve is exactly `exempt × EXEMPT_AGENT_MEMORY_BYTES`'
);
check(
  withExempt.capByMemory < withNone.capByMemory,
  'uncharged agents lower the STATIC memory ceiling',
  `${withNone.capByMemory} → ${withExempt.capByMemory}`
);
// VACUITY GUARD for this section: with zero uncharged agents the term must be
// inert and visibly so. A reserve that fired on an empty fleet would be
// charging for agents that do not exist.
check(
  withNone.exemptReserveBytes === 0 && withNone.capByMemory === computeCapacity(FACTS, 0).capByMemory,
  'VACUITY: with no uncharged agents the reserve is zero and changes nothing'
);

// ------------------------------------------------------ 3. no double charge --
rule('3. ONE RESERVE, ONE TERM — the live memory term must NOT be reserved against');

// This is the over-correction guard, and it is the reason the reserve is not
// simply subtracted everywhere memory appears. `availableBytes` is
// MemAvailable: the kernel has already stopped offering the memory those agents
// hold. Charging them again here would refuse activations twice for one fact.
check(
  withExempt.headroomByMemory === withNone.headroomByMemory,
  'the LIVE memory term is untouched by the reserve — MemAvailable already nets them out',
  `${withNone.headroomByMemory} → ${withExempt.headroomByMemory}`
);
// And the numerator it actually used, stated so the reader can check the two
// terms really do divide different bases rather than being asserted to.
check(
  withExempt.machine.availableBytes === FACTS.availableBytes &&
    withExempt.machine.totalBytes === FACTS.totalBytes,
  'the two terms divide different numerators: availableBytes (live) and totalBytes (static)'
);

// -------------------------------------------------------- 4. derivation ----
rule('4. THE DERIVATION STILL TELLS THE TRUTH');

const text = describeCapacity(cheap);
console.log(text);

check(
  text.includes('raised to the seed floor'),
  'a floored dimension is not reported as though the measurement divided',
  'KAN-44: a figure nobody measured on this fleet must not be labelled as one'
);
check(
  text.includes('floored (KAN-275)') && text.includes(`${CHEAP.cores} core would have divided`),
  'the report says what would have divided and what floored it, so the arithmetic is checkable'
);
// The contradiction this ticket was found by: `4 tree(s)` printed one line
// above `running: 0 charged agent(s)`, as though the trees were this daemon's
// fleet. The count is still printed — it is real and it is evidence — but it
// may never again be presented as a count of our agents.
check(
  text.includes('not necessarily this daemon') && text.includes('agent-runtime tree(s) found ON THIS MACHINE'),
  'the tree count is not presented as a count of this daemon\'s agents'
);

const reserveText = describeCapacity(withExempt);
check(
  reserveText.includes('uncharged agent(s)') && reserveText.includes('held off the static memory ceiling'),
  'the reserve appears in the cap arithmetic and in the running line'
);

// --------------------------------------------------------- 5. pure unit ----
rule('5. flooredCost IS ONE-SIDED AND PER-DIMENSION');

// Exercised directly, because a rule that is only ever observed through
// `computeCapacity` is a rule whose edges nothing pins. Mixed sources on the
// two dimensions is the case `pick()` exists for and the one most likely to rot.
const mixed = flooredCost(
  { residentBytes: MEASURED_AGENT_COST.residentBytes / 2, cores: MEASURED_AGENT_COST.cores * 3 },
  { residentBytes: 'measured', cores: 'measured' }
);
check(
  mixed.residentBytes === MEASURED_AGENT_COST.residentBytes &&
    mixed.cores === MEASURED_AGENT_COST.cores * 3,
  'the cheap dimension is raised and the dear one is left alone, independently'
);
const overrideBoth = flooredCost(
  { residentBytes: 1, cores: 0.0001 },
  { residentBytes: 'override', cores: 'override' }
);
check(
  overrideBoth.residentBytes === 1 && overrideBoth.cores === 0.0001,
  'an override is never raised, however far below the seed it sits'
);

console.log(
  failures
    ? `\n== ${failures} CHECK(S) FAILED ==`
    : '\n== done: the floor bounds an unattributable divisor, and the reserve lands on exactly one term =='
);
process.exit(failures ? 1 : 0);
