#!/usr/bin/env node
// KAN-208: live headroom bounds on cores actually in use, not on the length of
// the run queue.
//
// WHAT FAILURE THIS WOULD CATCH: the capacity gate refusing an activation on a
// machine that has the CPU to serve it, because the quantity it divides is the
// 1-minute load average — which on Linux counts uninterruptible sleep as
// running work. The refusal that produced this ticket read `headroom: 0, bound
// by load, load1 5.70` while ~1.4 of 4 cores were in use. §2 reconstructs that
// exact refusal from the arithmetic that produced it, and requires the shipped
// model to answer differently on the same figures.
//
// It would equally catch the OPPOSITE mistake, and that half matters more:
// a change of instrument that quietly widened the gate. §3 saturates the cores
// with the load average reading low and requires a refusal; §4 fills the count
// term and requires a refusal that is not about CPU at all.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF AND WHAT IT DOES NOT, up front
// ---------------------------------------------------------------------------
//
// Most of it supplies its own input, and says which parts: §2, §3 and §4 hand
// `computeCapacity` a `MachineFacts` object this file wrote, because the whole
// value of a pure function is being able to ask it about a machine nobody here
// owns — a 4-core box at load 5.70 with idle cores is not something a proof
// running on a shared machine may create on demand. Those sections prove the
// ARITHMETIC. They prove nothing about whether a real observation ever reaches
// it.
//
// That is the KAN-145 hole, named rather than left for the reader to find: a
// proof that constructs the record it then asserts on has not tested that the
// record arrives. Two things cover it here, and neither is these sections:
//
//   - §6 takes a REAL window off this machine's /proc/stat and pushes it
//     through `setObservedCpu` → `readMachineFacts` → `computeCapacity`, so the
//     whole path from the kernel's counters to a `headroomByCpu` runs at least
//     once with nothing hand-written in it. What it cannot assert is a
//     threshold: the number depends on what else is running.
//   - The DAEMON's sampler — the thing that actually calls `setObservedCpu` in
//     production — is covered by neither. Nothing in this file starts a daemon.
//     The evidence that a running daemon publishes an observation is an
//     observation of the running system, pasted into the KAN-208 pull request,
//     because no assertion here can hold it. If that ever silently stopped,
//     every section below would stay green and every capacity report would say
//     `cpu in use: not measured here` — which is at least loud in the output,
//     and is the reason `describeCapacity` says it in words rather than
//     omitting the line.
//
// ---------------------------------------------------------------------------
// SIX SECTIONS
//
//   1. the instrument   — /proc/stat parsed, with iowait NOT counted as busy
//   2. the defect       — the reported refusal, before and after, same figures
//   3. saturation       — cores genuinely full: still refused, and named cpu
//   4. the other bounds — count and memory unchanged, and still able to refuse
//   5. degradation      — no reading, a stale reading, a rejected window: the
//                         load average takes over and the report says so
//   6. live             — a real window on this machine, through the real path
//
// Run `npm run build` first. Usage: node scripts/verify-cpu-headroom.mjs [distDir]

import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const { computeCapacity, describeCapacity, capacityRefusal, readMachineFacts, GIB } =
  await import(path.join(distDir, 'capacity.js'));
const {
  parseCpuTicks,
  startCpuWindow,
  finishCpuWindow,
  setObservedCpu,
  freshObservedCpu,
  MAX_OBSERVATION_AGE_MS,
  MIN_WINDOW_SECONDS
} = await import(path.join(distDir, 'machine-cpu.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

let failures = 0;
const flag = (ok) => {
  if (!ok) failures += 1;
  return ok;
};
const verdict = (ok, yes, no) => {
  console.log(flag(ok) ? `  → ${yes}` : `  → ${no}`);
  return ok;
};

// --------------------------------------------------------- 1. instrument --
rule('1. THE INSTRUMENT — /proc/stat, and where iowait lands');

// Hand-written /proc/stat lines, because the one thing that cannot be arranged
// on a real machine to order is a kernel spending 90% of its time in iowait.
// The columns are proc(5)'s: user nice system idle iowait irq softirq steal
// guest guest_nice.
const TICK_FIXTURES = [
  [
    'a busy machine (most non-idle time is system+user)',
    'cpu  10000 0 5000 5000 100 0 0 0 0 0\n',
    { busy: 15000, idle: 5100 }
  ],
  [
    'THE KAN-208 MACHINE: idle cores, enormous iowait',
    'cpu  1000 0 400 2000 12000 0 0 0 0 0\n',
    { busy: 1400, idle: 14000 }
  ],
  [
    'a VM losing time to its host (steal counts as busy — it is gone either way)',
    'cpu  1000 0 500 8000 0 0 0 2500 0 0\n',
    { busy: 4000, idle: 8000 }
  ],
  [
    'guest columns present (already inside user/nice — must not double-count)',
    'cpu  9000 100 500 4000 0 0 0 0 7000 50\n',
    { busy: 9600, idle: 4000 }
  ],
  [
    'an old kernel with only the five required columns',
    'cpu  100 10 20 300 40\n',
    { busy: 130, idle: 340 }
  ],
  [
    'per-cpu lines present; the aggregate line is the one taken',
    'cpu  200 0 100 700 0 0 0 0\ncpu0 999999 0 999999 0 0 0 0 0\n',
    { busy: 300, idle: 700 }
  ]
];

for (const [label, text, expected] of TICK_FIXTURES) {
  const got = parseCpuTicks(text);
  const ok = got && got.busy === expected.busy && got.idle === expected.idle;
  console.log(
    `  ${label}\n    → busy ${got?.busy}, idle ${got?.idle} ` +
    `(expected busy ${expected.busy}, idle ${expected.idle})${flag(ok) ? '' : '  — CHECK THIS'}`
  );
}

// Rejected, not guessed at. A parser that returns a plausible number from
// rubbish is how a gate ends up dividing by noise.
const BAD_FIXTURES = [
  ['no cpu line at all', 'intr 1 2 3\nctxt 44\n'],
  ['too few columns', 'cpu  1 2 3\n'],
  ['a non-numeric column', 'cpu  1 2 three 4 5\n'],
  ['a negative column', 'cpu  1 2 -3 4 5\n'],
  ['a negative optional column', 'cpu  1 2 3 4 5 -6 0 0\n'],
  ['empty input', '']
];
console.log('');
let allRejected = true;
for (const [label, text] of BAD_FIXTURES) {
  const got = parseCpuTicks(text);
  allRejected &&= got === null;
  console.log(`  ${label.padEnd(28)} → ${got === null ? 'null (rejected)' : JSON.stringify(got) + ' — CHECK THIS'}`);
}
verdict(
  allRejected,
  'every malformed line rejects to null rather than producing a number.',
  'SOMETHING MALFORMED PARSED TO A NUMBER — CHECK THIS.'
);

// The fixture that is the whole ticket, restated as the ratio the gate uses.
{
  const before = parseCpuTicks('cpu  1000 0 400 2000 12000 0 0 0 0 0\n');
  const after = parseCpuTicks('cpu  1100 0 440 2400 14400 0 0 0 0 0\n');
  const busyDelta = after.busy - before.busy;
  const totalDelta = busyDelta + (after.idle - before.idle);
  const busyCoresOn4 = (busyDelta / totalDelta) * 4;
  console.log(
    `\n  the same machine sampled twice: busy +${busyDelta} ticks, total +${totalDelta} ticks\n` +
    `  → ${busyCoresOn4.toFixed(2)} of 4 cores in use, while 2400 of those 2540 ticks were iowait`
  );
  verdict(
    busyCoresOn4 < 1,
    'iowait is on the idle side of the ratio, so a machine blocked on a disk\n' +
    '    reads as having cores free — which it does. The load average reads the\n' +
    '    same machine as saturated, and that difference is this ticket.',
    'IOWAIT IS BEING COUNTED AS BUSY — CHECK THIS. If it were, this measurement\n' +
    '    would be the load average with extra steps.'
  );
}

// ------------------------------------------------------------- 2. defect --
rule('2. THE DEFECT — the refusal that was reported, run through both models');

// The figures are the ones on the ticket, measured on a 4-core machine on
// 2026-08-06: an activation refused at load1 5.70 with ~1.4 cores in use.
const REPORTED = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(9.4 * GIB),
  load1: 5.7,
  cpu: { busyCores: 1.4, windowSeconds: 30, sampledAt: Date.parse('2026-08-06T21:00:00Z') }
};

// The OLD model, reconstructed from the two lines it was: capacity.ts:341-342
// at 27bd4248, before this change. It is recomputed here rather than re-run
// because that code no longer exists in the tree — the same technique
// verify-agent-capacity §2 uses for the removed supervisor reservation.
//
//   const loadBudget     = machine.cores - reservedCores - machine.load1;
//   const headroomByLoad = Math.max(0, Math.floor(loadBudget / cost.cores));
//
const reconstructOldHeadroom = (facts, running, cap, reservedCores, costCores, headroomByMemory) => {
  const headroomByCap = Math.max(0, cap - running);
  const headroomByLoad = Math.max(
    0,
    Math.floor((facts.cores - reservedCores - facts.load1) / costCores)
  );
  const headroom = Math.min(headroomByCap, headroomByLoad, headroomByMemory);
  return {
    headroom,
    headroomByLoad,
    boundBy:
      headroomByCap <= headroomByLoad && headroomByCap <= headroomByMemory
        ? 'cap'
        : headroomByLoad <= headroomByMemory
          ? 'load'
          : 'memory'
  };
};

const now = computeCapacity(REPORTED, 1);
const then = reconstructOldHeadroom(
  REPORTED,
  1,
  now.cap,
  now.reservedForHuman.cores,
  now.cost.cores,
  now.headroomByMemory
);

console.log(
  `the machine as reported: ${REPORTED.cores} cores, load1 ${REPORTED.load1}, ` +
  `${REPORTED.cpu.busyCores} cores actually in use, 1 charged agent running\n`
);
console.log(
  `  before (load-bound, reconstructed)  headroom ${then.headroom}  ` +
  `(load allows ${then.headroomByLoad}: (4 − 1 reserved − 5.70 load) ÷ ${now.cost.cores}; bound by ${then.boundBy})`
);
console.log(
  `  after  (cpu-bound, live code)       headroom ${now.headroom}  ` +
  `(cpu allows ${now.headroomByCpu}: (4 − 1 reserved − 1.40 in use) ÷ ${now.cost.cores}; ` +
  `bound by ${now.headroomBoundBy})`
);
console.log('\nthe live derivation, with both terms printed and one of them binding:\n');
console.log(describeCapacity(now));
console.log('\nand what the old model told the caller, in the words it used:\n');
console.log(
  `  Refusing to activate task/KAN-99: load too high — the load average is 5.70, ` +
  `against the 3.0 cores this machine leaves to agents.`
);
console.log('\nagainst what the same call answers now:\n');
console.log(
  `  ${now.atCapacity ? capacityRefusal(now, 'task/KAN-99').split('\n')[0] : 'no refusal — the activation proceeds'}`
);

verdict(
  then.headroom === 0 && then.boundBy === 'load',
  'the old arithmetic refuses: two and a half cores idle, work turned away.',
  'THE RECONSTRUCTED OLD MODEL DID NOT REFUSE — CHECK THIS. If it does not\n' +
  '    refuse, this section is comparing the new model against nothing.'
);
verdict(
  now.headroom > 0 && !now.atCapacity && now.headroomBoundBy !== 'load',
  `the shipped model allows ${now.headroom} more, and the load average — still 5.70,\n` +
  '    still printed on every line above — is no longer what decides.',
  'THE SHIPPED MODEL STILL REFUSES ON THESE FIGURES — CHECK THIS.'
);
verdict(
  now.headroomByLoad === then.headroomByLoad && now.headroomByLoad === 0,
  'and the load term still computes to 0 and still says so. It was not deleted,\n' +
  '    it was demoted — a reader can see exactly what the old gate would have done.',
  'THE LOAD TERM IS NO LONGER COMPUTED OR NO LONGER AGREES WITH THE OLD ONE —\n' +
  '    CHECK THIS.'
);

// --------------------------------------------------------- 3. saturation --
rule('3. SATURATION — cores genuinely full, load average low: still refused');

// The direction that matters most. A change of instrument that only ever
// admitted more work would be indistinguishable in every section above from
// deleting the gate.
//
// The load average here is 0.30 — a machine that looks idle by the OLD
// instrument — while the cores are full. That combination is not exotic: it is
// the first thirty seconds of any sudden burst, before the 1-minute average has
// caught up. The old model would have started agents into it.
const SATURATED = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(9.4 * GIB),
  load1: 0.3,
  cpu: { busyCores: 3.9, windowSeconds: 30, sampledAt: Date.parse('2026-08-06T21:00:00Z') }
};
const full = computeCapacity(SATURATED, 0);
const wouldHaveAllowed = reconstructOldHeadroom(
  SATURATED,
  0,
  full.cap,
  full.reservedForHuman.cores,
  full.cost.cores,
  full.headroomByMemory
);

console.log(`${SATURATED.cores} cores, ${SATURATED.cpu.busyCores} of them in use, load average only ${SATURATED.load1}, nothing running\n`);
console.log(
  `  before (load-bound, reconstructed)  headroom ${wouldHaveAllowed.headroom} ` +
  `(load allows ${wouldHaveAllowed.headroomByLoad}; bound by ${wouldHaveAllowed.boundBy})`
);
console.log(
  `  after  (cpu-bound, live code)       headroom ${full.headroom} ` +
  `(cpu allows ${full.headroomByCpu}; bound by ${full.headroomBoundBy})`
);
console.log(`\n${capacityRefusal(full, 'task/KAN-99')}\n`);

verdict(
  full.headroom === 0 && full.atCapacity && full.headroomBoundBy === 'cpu',
  'refused, and the refusal names cpu. The gate did not get weaker; it got\n' +
  '    pointed at the right quantity.',
  'A MACHINE WITH 3.9 OF 4 CORES IN USE WAS NOT REFUSED — CHECK THIS. This is\n' +
  '    criterion 5 and it is the one that must never go quietly.'
);
verdict(
  wouldHaveAllowed.headroom > 0,
  `and the OLD model would have allowed ${wouldHaveAllowed.headroom} here, because the load\n` +
  '    average had not caught up yet. The change refuses work the old gate let\n' +
  '    through as well as admitting work it turned away.',
  'the old model also refused this machine, so this row shows only that the new\n' +
  '    one agrees — which is worth less than it looks. Not counted as a failure;\n' +
  '    read the figures above.'
);

// ----------------------------------------------------- 4. the other bounds --
rule('4. THE OTHER BOUNDS — count and memory are untouched, and still refuse');

// An idle fleet at its cap is the case NO CPU instrument can see: most of an
// agent's life is spent waiting on an API, so a machine carrying its maximum
// can read as almost entirely free. If the count term had been weakened —
// or if `headroomByCpu` had been allowed to raise the answer rather than only
// lower it — this is where it would show.
const IDLE_BUT_FULL = {
  cores: 8,
  totalBytes: 32 * GIB,
  availableBytes: 24 * GIB,
  load1: 0.2,
  cpu: { busyCores: 0.1, windowSeconds: 30, sampledAt: Date.parse('2026-08-06T21:00:00Z') }
};
const atCap = computeCapacity(IDLE_BUT_FULL, computeCapacity(IDLE_BUT_FULL, 0).cap);
console.log(
  `${atCap.running} agents against a cap of ${atCap.cap}, on a machine using ` +
  `${IDLE_BUT_FULL.cpu.busyCores} of ${IDLE_BUT_FULL.cores} cores:\n`
);
console.log(`  ${capacityRefusal(atCap, 'task/KAN-99').split('\n')[0]}`);
console.log(
  `  count allows ${atCap.headroomByCap}, cpu allows ${atCap.headroomByCpu}, ` +
  `memory allows ${atCap.headroomByMemory}; bound by ${atCap.headroomBoundBy}\n`
);
verdict(
  atCap.atCapacity && atCap.headroomBoundBy === 'cap' && atCap.headroomByCpu > 0,
  'refused by count while the CPU term says there is room, which is exactly\n' +
  '    right: an idle agent still holds memory and a slot. A CPU measurement\n' +
  '    cannot replace the count term and is not being asked to.',
  'A FULL FLEET WAS NOT REFUSED BY COUNT — CHECK THIS.'
);

// Memory, the same way: the dimension that kills rather than slows.
const STARVED = {
  cores: 8,
  totalBytes: 32 * GIB,
  availableBytes: Math.round(2.4 * GIB),
  load1: 0.2,
  cpu: { busyCores: 0.1, windowSeconds: 30, sampledAt: Date.parse('2026-08-06T21:00:00Z') }
};
const outOfMemory = computeCapacity(STARVED, 0);
console.log(`  ${capacityRefusal(outOfMemory, 'task/KAN-99').split('\n')[0]}`);
console.log(
  `  count allows ${outOfMemory.headroomByCap}, cpu allows ${outOfMemory.headroomByCpu}, ` +
  `memory allows ${outOfMemory.headroomByMemory}; bound by ${outOfMemory.headroomBoundBy}\n`
);
verdict(
  outOfMemory.atCapacity && outOfMemory.headroomBoundBy === 'memory',
  'and a machine out of memory is still refused for memory, with idle cores\n' +
  '    and a quiet load average. Three terms, three reasons, one min.',
  'A MACHINE WITH 2.4 GiB AVAILABLE WAS NOT REFUSED FOR MEMORY — CHECK THIS.'
);

// -------------------------------------------------------- 5. degradation --
rule('5. DEGRADATION — no reading, a stale reading, a window that proves nothing');

// Whatever breaks, capacity still answers. Here that means: it answers on the
// load average, and the answer SAYS it is answering on the load average —
// because "CPU is quiet" and "nobody measured CPU" would otherwise be the same
// sentence, and they are the two facts a reader most needs apart.
const unmeasured = computeCapacity({ ...REPORTED, cpu: null }, 1);
console.log('the KAN-208 machine again, with nothing having measured its CPU:\n');
console.log(describeCapacity(unmeasured));
console.log('');
verdict(
  unmeasured.headroomByCpu === null &&
    unmeasured.headroom === 0 &&
    unmeasured.headroomBoundBy === 'load' &&
    describeCapacity(unmeasured).includes('not measured here'),
  'the pre-KAN-208 answer comes back — refused, load-bound — and the derivation\n' +
  '    says in words that nothing measured CPU. Degrading to the old behaviour is\n' +
  '    the conservative direction; degrading to it SILENTLY was never acceptable.',
  'THE UNMEASURED CASE DID NOT FALL BACK TO THE LOAD AVERAGE, OR DID NOT SAY SO\n' +
  '    — CHECK THIS.'
);

// Staleness is enforced on read, so an instrument that dies without clearing
// itself expires on its own. This is the failure mode that fails in the
// DANGEROUS direction: a four-minute-old "0.1 cores in use" would hold the gate
// open on a machine nobody is watching.
const staleAt = Date.parse('2026-08-06T21:00:00Z');
const fresh = { busyCores: 0.1, windowSeconds: 30, sampledAt: staleAt };
setObservedCpu(fresh);
const justInTime = freshObservedCpu(staleAt + MAX_OBSERVATION_AGE_MS);
const tooOld = freshObservedCpu(staleAt + MAX_OBSERVATION_AGE_MS + 1);
setObservedCpu(null);
console.log(
  `  an observation ${MAX_OBSERVATION_AGE_MS / 1000}s old  → ${justInTime ? 'still believed' : 'expired'}\n` +
  `  an observation ${MAX_OBSERVATION_AGE_MS / 1000 + 0.001}s old → ${tooOld ? 'still believed — CHECK THIS' : 'expired'}\n` +
  `  after setObservedCpu(null)     → ${freshObservedCpu(staleAt) ? 'still believed — CHECK THIS' : 'expired'}\n`
);
verdict(
  justInTime !== null && tooOld === null && freshObservedCpu(staleAt) === null,
  'the age bound is enforced where the figure is READ, so a sampler that stopped\n' +
  '    without clearing itself cannot leave the gate divided by an old number.',
  'A STALE OBSERVATION WAS STILL BELIEVED — CHECK THIS.'
);

// And a window that closed without meaning anything is rejected rather than
// published. The counters here go BACKWARDS, which is what a container hopping
// hosts or a reset cgroup looks like.
const impossible = [
  ['counters moved backwards', { ticks: { busy: 9_999_999, idle: 9_999_999 }, startedAt: Date.now() - 60_000 }],
  ['no time passed at all', { ticks: { busy: 0, idle: 0 }, startedAt: Date.now() }],
  [`shorter than MIN_WINDOW_SECONDS (${MIN_WINDOW_SECONDS}s)`, { ticks: { busy: 0, idle: 0 }, startedAt: Date.now() - 200 }]
];
console.log('');
let windowsRejected = true;
for (const [label, start] of impossible) {
  const got = finishCpuWindow(start);
  windowsRejected &&= got === null;
  console.log(`  ${label.padEnd(42)} → ${got === null ? 'null (rejected)' : JSON.stringify(got) + ' — CHECK THIS'}`);
}
verdict(
  windowsRejected,
  'a window that cannot mean anything produces no observation, and no\n' +
  '    observation means the load average takes over — labelled, as above.',
  'A MEANINGLESS WINDOW PRODUCED AN OBSERVATION — CHECK THIS.'
);

// --------------------------------------------------------------- 6. live --
rule('6. LIVE — a real window on this machine, through the real path');

// The one section that does NOT supply its own input. Everything above hands
// `computeCapacity` figures this file wrote; here the kernel's counters go all
// the way to a headroom number, so the wiring between the instrument and the
// arithmetic runs at least once with nothing hand-written in it.
//
// It cannot assert a threshold — what this machine is doing while the proof
// runs is not this proof's business — so what it asserts is that a real
// observation was produced, that it is inside the only bounds it can be inside,
// and that `readMachineFacts()` picked it up. The figures are printed because
// on a busy machine they are the demonstration: load1 well above cores-in-use
// is the whole ticket, visible in one line.
const window = startCpuWindow();
if (!window) {
  console.log(
    '  /proc/stat is not readable here (not Linux, or /proc is not mounted).\n' +
    '  NOT RUN — and that is the same answer the daemon gives: with no instrument\n' +
    '  the load average is the CPU-side bound, which §5 covers.\n' +
    '  This is a skip, not a pass: nothing below ran.'
  );
} else {
  await new Promise((r) => setTimeout(r, 2000));
  const live = finishCpuWindow(window);
  const cores = readMachineFacts().cores;
  if (!live) {
    console.log('  the window closed without a usable reading — NOT RUN.');
    flag(false);
  } else {
    setObservedCpu(live);
    const facts = readMachineFacts();
    const c = computeCapacity(facts, 0);
    console.log(
      `  measured over ${live.windowSeconds.toFixed(1)}s: ` +
      `${live.busyCores.toFixed(2)} of ${cores} cores in use, ` +
      `load average ${facts.load1.toFixed(2)}\n`
    );
    console.log(describeCapacity(c));
    const picked =
      facts.cpu !== null &&
      facts.cpu.busyCores === live.busyCores &&
      c.headroomByCpu !== null &&
      Number.isFinite(c.headroomByCpu);
    console.log('');
    verdict(
      live.busyCores >= 0 && live.busyCores <= cores && live.windowSeconds >= MIN_WINDOW_SECONDS,
      `a real observation, inside [0, ${cores}] cores, over a window long enough to\n` +
      '    mean something.',
      'THE LIVE OBSERVATION WAS OUT OF BOUNDS — CHECK THIS.'
    );
    verdict(
      picked,
      'and readMachineFacts() picked it up, so computeCapacity divided a number\n' +
      '    that came from this kernel rather than from this file. That is the one\n' +
      '    claim the sections above cannot make about themselves.',
      'readMachineFacts() DID NOT PICK UP THE PUBLISHED OBSERVATION — CHECK THIS.\n' +
      '    Every other section would stay green with this broken, which is why it\n' +
      '    is asserted here.'
    );
    // Loud, not asserted: on a quiet machine the two agree and there is nothing
    // to see. On a busy one this line is the ticket in miniature.
    const oldWouldRefuse = facts.cores - c.reservedForHuman.cores - facts.load1 < c.cost.cores;
    console.log(
      oldWouldRefuse
        ? `  → NOTE: on this machine right now the OLD load-bound term answers ` +
          `${c.headroomByLoad}, so\n    the pre-KAN-208 gate would be refusing activations while ` +
          `${(cores - live.busyCores).toFixed(2)} cores sit idle.`
        : `  → this machine is quiet enough that both terms agree right now ` +
          `(load ${facts.load1.toFixed(2)},\n    ${live.busyCores.toFixed(2)} cores in use), so there is nothing to see in this line. ` +
          'It is not\n    an assertion; the divergence is arranged deliberately in §2.'
    );
    setObservedCpu(null);
  }
}

if (failures > 0) {
  console.log(`\n== ${failures} CHECK(S) FAILED ==`);
  process.exit(1);
}
console.log('\n== done ==');
