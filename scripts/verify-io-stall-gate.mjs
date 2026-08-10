#!/usr/bin/env node
// KAN-216: a machine that is stalled admits nothing, and says which resource.
//
// WHAT FAILURE THIS WOULD CATCH: the capacity gate starting agents on a machine
// that is making no forward progress — a failing disk, a hung NFS or FUSE
// mount, a queue nothing drains — because all three of its terms are blind to
// it. Cores read idle (correctly: machine-cpu.ts counts iowait as NOT busy),
// MemAvailable reads plentiful, and the count term knows nothing about any of
// it. §3 puts a stalled machine through the shipped model and requires a
// refusal that the same machine, unstalled, does not get.
//
// AND IT WOULD EQUALLY CATCH THE OPPOSITE MISTAKE, which for this term is the
// more likely one and is the reason §2 exists: a pressure file that cannot be
// read rendering as 0.00%, which is an ALL-CLEAR FROM AN INSTRUMENT THAT NEVER
// LOOKED. That would silently disable this gate on every machine where PSI is
// absent or restricted, while every report went on printing a reassuring
// figure. It is this epic's most-repeated defect and a stall term is an
// unusually easy place to commit it.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT IT THEREFORE CANNOT ESTABLISH
// ---------------------------------------------------------------------------
//
// Said up front, because a proof that supplies its own input has not tested
// that the input arrives, and two green scripts with a hole between them is how
// KAN-145 got `activatedBy: null` into production past two passing proofs.
//
// SUPPLIED HERE: the stalled machine. §3–§6 hand `computeCapacity` a
// `MachineFacts` this file built, because a machine spending half its wall
// clock with every task stalled is not something a proof running on a shared
// box may create on demand — and inducing one hard enough to cross the shipped
// threshold is a thing the ticket explicitly forbids ("do not thrash this
// machine to get a red"). Those sections prove the ARITHMETIC and the WORDS.
//
// NOT SUPPLIED HERE, and this is the half that closes the KAN-145 seam: §1
// drives the REAL PARSER against REAL FILES on disk — including a real ENOENT
// and a real EACCES produced by chmod, not simulated — and §7 reads THIS
// MACHINE's actual /proc/pressure through `readMachineFacts()` into a real
// `Capacity`, so the whole path from the kernel's bytes to a reported state
// runs at least once with nothing hand-written in it.
//
// WHAT NOTHING HERE ESTABLISHES, named rather than left for a reader to
// discover: NO PROOF IN THIS REPOSITORY DRIVES THE REAL GATE TO A REAL REFUSAL
// ON A REAL STALL. It would need `io full avg10` at or above
// STALL_REFUSE_PERCENT on this machine, and the load that produced the highest
// reading anyone here has induced (four synchronous direct writers, 2026-08-10)
// peaked at 30.48% against a threshold of 50 — deliberately, since the
// threshold is set to sit above heavy legitimate work, and heavy legitimate
// work is the most this machine may safely be asked to do. Two things cover
// part of it and neither closes it:
//
//   - the measured induced-load figures are pasted into the PR as an
//     observation of the running system, which is what establishes that the
//     instrument moves at all on real load, and by how much;
//   - §7 establishes that a real reading reaches a real `Capacity` with the
//     right state on it.
//
// The seam between those two — a real reading ABOVE the threshold driving a
// real refusal — is covered by nobody. It is the honest residual and it is on
// the ticket rather than hidden here.
//
// A SECOND THING NOTHING HERE COVERS: the memory half is unexercised by
// observation. `memory full avg10` never left 0.00% through every measurement
// taken for this slice, because this machine has never swapped. The memory
// branch below is driven entirely by fixtures, and that it is the branch the
// ticket's HEADLINE case (thrashing on swap) would take is exactly why it is
// said out loud.
//
// ---------------------------------------------------------------------------
// EIGHT SECTIONS
//
//   1. the instrument   — the real parser on real files: measured, absent and
//                         unreadable are three states, and only one is a number
//   2. the all-clear    — an unreadable file must never read as 0.00%, must
//                         never refuse, and must say which kind of silence
//   3. the veto         — a stalled machine admits nothing, on figures derived
//                         from the shipped threshold rather than typed in
//   4. which resource   — io vs memory, worse-of-two, ties, partial instrument
//   5. the tie rule     — a stalled machine with a full board still says `cap`
//   6. the refusal      — headline, arithmetic, and NO victim offered
//   7. live             — this machine's own /proc/pressure, end to end
//   8. what is not covered — printed, not merely commented
//
// Run `npm run build` first. Usage: node scripts/verify-io-stall-gate.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const {
  computeCapacity,
  describeCapacity,
  capacityHeadline,
  capacityReason,
  capacityRefusal,
  preemptionCanHelp,
  readMachineFacts,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const {
  readPressureFull,
  readStallFacts,
  worstStall,
  stallInstrument,
  STALL_REFUSE_PERCENT
} = await import(path.join(distDir, 'machine-pressure.js'));

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

// A scratch directory of real files. The parser takes a path precisely so that
// it can be driven this way: a fixture that is a string in this file would
// exercise the parsing and skip the reading, and "the file was not there" and
// "the file was there and would not open" are facts about READING.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan216-'));
const writeFixture = (name, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
};
/** A whole /proc/pressure file, with `full avg10` set to `full`. */
const pressureFile = (some, full) =>
  `some avg10=${some.toFixed(2)} avg60=1.11 avg300=0.98 total=537036752\n` +
  `full avg10=${full.toFixed(2)} avg60=0.18 avg300=0.24 total=313582439\n`;

// --------------------------------------------------------- 1. instrument --
rule('1. THE INSTRUMENT — three states, and only one of them is a number');

{
  const good = writeFixture('io-good', pressureFile(2.27, 0.01));
  const r = readPressureFull(good);
  verdict(
    r.state === 'measured' && r.fullAvg10Percent === 0.01,
    `a well-formed file reads as measured 0.01% (\`full avg10\`, not \`some\` — ` +
      `\`some\` on the same file is 2.27)`,
    `A WELL-FORMED FILE DID NOT PARSE — got ${JSON.stringify(r)} — CHECK THIS.`
  );

  // `full`, not `some`. Pinned to a literal because it is the one substitution
  // that would leave every state, every type and every sentence in this file
  // correct while gating on a figure one honest `dd` puts above zero.
  const swapped = writeFixture('io-some-high', pressureFile(97.5, 3.25));
  const s = readPressureFull(swapped);
  verdict(
    s.state === 'measured' && s.fullAvg10Percent === 3.25,
    'a file with `some avg10=97.50` and `full avg10=3.25` reads 3.25 — the term takes\n' +
      '    `full` (the machine stopped), never `some` (something waited).',
    `THE PARSER TOOK THE WRONG LINE — got ${JSON.stringify(s)} — CHECK THIS.`
  );
}

{
  // A real ENOENT, not a simulated one.
  const missing = path.join(tmp, 'nope', 'io');
  const r = readPressureFull(missing);
  verdict(
    r.state === 'absent',
    'a file that does not exist is `absent` — this kernel has no PSI, which is a\n' +
      '    fact about the machine and not a fault on it.',
    `A MISSING FILE DID NOT READ AS absent — got ${JSON.stringify(r)} — CHECK THIS.`
  );
}

{
  // A real EACCES, produced by chmod rather than described. Skipped when running
  // as root, which can read anything — and the skip is LOUD, because a silently
  // skipped case is a case nobody knows was not run.
  const denied = writeFixture('io-denied', pressureFile(1, 1));
  fs.chmodSync(denied, 0o000);
  const readableAnyway = (() => {
    try {
      fs.readFileSync(denied);
      return true;
    } catch {
      return false;
    }
  })();
  if (readableAnyway) {
    console.log(
      '  SKIPPED: this process can read a 000 file (running as root?), so EACCES\n' +
        '    cannot be produced here. The unreadable state is still exercised by the\n' +
        '    malformed fixtures below, which reach it without needing permissions.'
    );
  } else {
    const r = readPressureFull(denied);
    verdict(
      r.state === 'unreadable' && /EACCES/.test(r.detail),
      `a file that exists and will not open is \`unreadable\`, and says why: "${r.detail}"`,
      `AN UNOPENABLE FILE DID NOT READ AS unreadable — got ${JSON.stringify(r)} — CHECK THIS.`
    );
    verdict(
      r.state !== 'absent',
      'and it is NOT `absent` — "no PSI here" and "PSI is here and would not answer"\n' +
        '    are different facts with different remedies, which is why they are\n' +
        '    different states rather than one null.',
      'unreadable COLLAPSED INTO absent — CHECK THIS. That is the distinction this\n' +
        '    module exists for.'
    );
  }
  fs.chmodSync(denied, 0o644);
}

{
  const MALFORMED = [
    ['no `full` line at all', 'some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n'],
    ['a `full` line with no avg10 field', 'full avg60=0.18 avg300=0.24 total=1\n'],
    ['a non-numeric avg10', 'full avg10=banana avg60=0.18 total=1\n'],
    ['a negative avg10', 'full avg10=-3.00 avg60=0.18 total=1\n'],
    ['an avg10 above 100 (cannot be a share of wall time)', 'full avg10=155.00 avg60=0.18 total=1\n'],
    ['an empty file', '']
  ];
  let allUnreadable = true;
  let anyNumber = false;
  console.log('');
  for (const [label, body] of MALFORMED) {
    const r = readPressureFull(writeFixture(`bad-${label.replace(/\W+/g, '-')}`, body));
    allUnreadable &&= r.state === 'unreadable';
    anyNumber ||= 'fullAvg10Percent' in r;
    console.log(`  ${label.padEnd(48)} → ${r.state}`);
  }
  verdict(
    allUnreadable,
    'every malformed file is `unreadable` rather than a plausible number.',
    'SOMETHING MALFORMED PRODUCED A STATE OTHER THAN unreadable — CHECK THIS.'
  );
  // The structural claim, asserted rather than trusted: on no failing branch is
  // there a percentage field to read at all. This is what makes "unreadable
  // renders as 0.00%" unwritable rather than merely unwritten.
  verdict(
    !anyNumber,
    'and none of them carries a percentage FIELD at all — the defect in §2 is not\n' +
      '    merely avoided here, it is unrepresentable.',
    'A FAILED READ CARRIED A PERCENTAGE FIELD — CHECK THIS.'
  );
}

// ---------------------------------------------------------- 2. all-clear --
rule('2. THE ALL-CLEAR THAT MUST NOT HAPPEN — silence is not 0.00%');

// A machine with plenty of everything, so that nothing but the stall term could
// possibly refuse. Derived from the real machine's core count so it stays a
// sane shape wherever this runs.
const roomyMachine = (stall) => ({
  cores: 4,
  totalBytes: 16 * GIB,
  availableBytes: 12 * GIB,
  load1: 0.2,
  cpu: { busyCores: 0.2, windowSeconds: 30, sampledAt: Date.now() },
  stall
});

{
  const CASES = [
    [
      'no PSI on this machine (both files absent)',
      {
        io: { state: 'absent', detail: '/proc/pressure/io does not exist' },
        memory: { state: 'absent', detail: '/proc/pressure/memory does not exist' }
      },
      'absent'
    ],
    [
      'PSI present and unreadable (both files EACCES)',
      {
        io: { state: 'unreadable', detail: '/proc/pressure/io could not be read: EACCES' },
        memory: { state: 'unreadable', detail: '/proc/pressure/memory could not be read: EACCES' }
      },
      'unreadable'
    ],
    [
      'the stall facts missing entirely (a caller that never looked)',
      null,
      'absent'
    ]
  ];

  for (const [label, stall, expectedInstrument] of CASES) {
    const c = computeCapacity(roomyMachine(stall), 0);
    const derivation = describeCapacity(c);
    console.log(`\n  ${label}`);
    verdict(
      c.stallPercent === null,
      'stallPercent is null — nobody looked, and null is what that is.',
      `stallPercent WAS ${c.stallPercent}, NOT null — CHECK THIS.`
    );
    verdict(
      c.stalled === false && c.headroom > 0,
      `stalled is false and headroom is ${c.headroom} — an instrument that did not\n` +
        '    look refuses nothing. The gap is left open, which is the honest answer.',
      'A MACHINE NOBODY MEASURED WAS REFUSED — CHECK THIS. An absent instrument must\n' +
        '    not refuse; that is a fabricated protection.'
    );
    verdict(
      c.stallInstrument === expectedInstrument,
      `and it says WHICH silence: \`${c.stallInstrument}\`.`,
      `stallInstrument WAS ${c.stallInstrument}, EXPECTED ${expectedInstrument} — CHECK THIS.`
    );
    // The assertion this whole section exists for.
    const stallSentence = derivation.split('\n').find((l) => l.startsWith('io/memory stall:'));
    verdict(
      stallSentence !== undefined && !/0\.00%/.test(stallSentence),
      `the derivation's stall line contains NO figure at all:\n    "${stallSentence?.slice(0, 96)}…"`,
      `THE DERIVATION PRINTED A FIGURE FOR A MACHINE NOBODY MEASURED:\n    "${stallSentence}"\n` +
        '    THIS IS THE DEFECT. 0.00% is an all-clear and nothing measured this machine.'
    );
    verdict(
      /INERT/.test(stallSentence ?? ''),
      'and it says the term is INERT in words, so a reader cannot mistake silence\n' +
        '    for protection.',
      'THE DERIVATION DID NOT SAY THE TERM WAS INERT — CHECK THIS. A gate that is\n' +
        '    quiet while inert is a gate a reader assumes is protecting them.'
    );
  }
}

// -------------------------------------------------------------- 3. veto --
rule('3. THE VETO — a stalled machine admits nothing');

// DERIVED FROM THE SHIPPED CONSTANT, NEVER TYPED IN. KAN-245 closed on a
// fixture whose absolute literal expired as the machine changed underneath it.
// The same discipline here means these figures follow STALL_REFUSE_PERCENT if
// anyone ever moves it: a threshold change cannot leave this section asserting
// against a number that is no longer the boundary, and it cannot leave the
// "saturated" case quietly below it.
const OVER = Math.min(100, STALL_REFUSE_PERCENT + 5);
const AT = STALL_REFUSE_PERCENT;
const UNDER = Math.max(0, STALL_REFUSE_PERCENT - 5);
console.log(
  `  the shipped threshold is ${STALL_REFUSE_PERCENT}%, so this section uses ` +
  `${UNDER}% / ${AT}% / ${OVER}%\n  — derived from it, so they follow it if it moves.`
);

// The vacuity guard. Every one of these must be observed by the end of the
// section; a fixture that has stopped being a fixture produces a clean pass
// otherwise, which is KAN-197's shape exactly.
const seen = { admitted: false, refusedOver: false, refusedAt: false, vetoHadSomethingToVeto: false };

{
  const io = (full) => ({
    io: { state: 'measured', fullAvg10Percent: full },
    memory: { state: 'measured', fullAvg10Percent: 0 }
  });

  const healthy = computeCapacity(roomyMachine(io(UNDER)), 0);
  seen.admitted = healthy.headroom > 0 && healthy.stalled === false;
  verdict(
    seen.admitted,
    `at ${UNDER}% the machine is admitted: headroom ${healthy.headroom}, ` +
      `bound by ${healthy.headroomBoundBy}.`,
    `A MACHINE UNDER THE THRESHOLD WAS REFUSED — CHECK THIS.`
  );

  const over = computeCapacity(roomyMachine(io(OVER)), 0);
  seen.refusedOver = over.headroom === 0 && over.stalled === true;
  // The veto must have had something to veto — otherwise this asserts nothing
  // more than that a full machine is full.
  seen.vetoHadSomethingToVeto = over.headroomBeforeStall > 0;
  verdict(
    seen.refusedOver,
    `at ${OVER}% it admits nothing: headroom 0, stalled true, bound by ` +
      `${over.headroomBoundBy}.`,
    `A STALLED MACHINE WAS ADMITTED — CHECK THIS. This is the gap the ticket is about.`
  );
  verdict(
    seen.vetoHadSomethingToVeto,
    `and the veto actually vetoed something: the three counting terms allowed ` +
      `${over.headroomBeforeStall} on the same machine, and the stall zeroed them.`,
    'THE COUNTING TERMS ALLOWED 0 ANYWAY, so this section proved nothing about the\n' +
      '    veto — CHECK THIS. The fixture has stopped being a fixture.'
  );

  // The boundary, pinned. `>=` versus `>` is a one-character mistake that no
  // other assertion here would catch, and it decides the behaviour of every
  // machine sitting exactly on the number.
  const at = computeCapacity(roomyMachine(io(AT)), 0);
  seen.refusedAt = at.stalled === true;
  verdict(
    seen.refusedAt,
    `AT exactly ${AT}% it refuses — the comparison is >=, so the threshold is the ` +
      `first refusing value and not the last admitting one.`,
    `A MACHINE EXACTLY AT ${AT}% WAS ADMITTED — CHECK THIS. The comparison has ` +
      `become >, which moves the boundary by one machine's worth of behaviour.`
  );

  // The counterfactual the ticket asks for: the same machine, same everything,
  // with only the stall removed. Without this the refusal above could be caused
  // by anything.
  const withoutTerm = computeCapacity(roomyMachine(null), 0);
  verdict(
    withoutTerm.headroom > 0 && over.headroom === 0,
    `and the SAME machine with the stall reading removed admits ` +
      `${withoutTerm.headroom} — so it is this term refusing, not the machine.`,
    'REMOVING THE STALL READING DID NOT CHANGE THE ANSWER — CHECK THIS. Something\n' +
      '    else was refusing and this section is measuring it.'
  );
}

// -------------------------------------------------------- 4. which file --
rule('4. WHICH RESOURCE — io, memory, the worse of the two, and a partial instrument');

{
  const facts = (ioState, memState) => ({ io: ioState, memory: memState });
  const m = (v) => ({ state: 'measured', fullAvg10Percent: v });
  const unreadable = { state: 'unreadable', detail: 'could not be read: EACCES' };
  const absent = { state: 'absent', detail: 'does not exist' };

  const memoryBound = computeCapacity(roomyMachine(facts(m(1), m(OVER))), 0);
  verdict(
    memoryBound.stalled && memoryBound.stallSource === 'memory',
    `io 1% and memory ${OVER}% → bound by memory. This is the ticket's HEADLINE ` +
      `case:\n    the kernel files a task waiting on swap-in as a MEMORY stall, so an ` +
      `io-only\n    term would have missed a machine thrashing on swap entirely.`,
    `THE MEMORY FILE DID NOT BIND — got source ${memoryBound.stallSource} — CHECK THIS.`
  );
  verdict(
    /thrash|memory/.test(capacityHeadline(memoryBound)),
    `and the refusal names it: "${capacityHeadline(memoryBound).slice(0, 88)}…"`,
    'THE REFUSAL DID NOT NAME MEMORY — CHECK THIS. "your disk is stalling" and "you\n' +
      '    are thrashing on swap" are different problems with different remedies.'
  );

  const worse = computeCapacity(roomyMachine(facts(m(OVER), m(OVER - 1))), 0);
  verdict(
    worse.stallSource === 'io' && worse.stallPercent === OVER,
    `with both measured the WORSE binds (${OVER}% io beats ${OVER - 1}% memory).`,
    `THE WORSE OF THE TWO DID NOT WIN — CHECK THIS.`
  );

  const tie = computeCapacity(roomyMachine(facts(m(OVER), m(OVER))), 0);
  verdict(
    tie.stallSource === 'io',
    'a tie goes to io — arbitrary between equal figures, but stable, and io is the\n' +
      '    one an operator can go and look at.',
    'THE TIE DID NOT RESOLVE TO io — CHECK THIS.'
  );

  // A partial instrument still gates. The alternative — refusing to act on a
  // figure that was actually taken because a second file was unavailable —
  // turns one broken file into a disabled gate.
  const partial = computeCapacity(roomyMachine(facts(m(OVER), unreadable)), 0);
  verdict(
    partial.stalled && partial.stallSource === 'io' && partial.stallInstrument === 'measured',
    `io ${OVER}% with memory UNREADABLE still refuses, on io's figure — a reading ` +
      `that\n    was taken is not made less true by a second file being unavailable.`,
    'A PARTIAL INSTRUMENT DISABLED THE GATE — CHECK THIS. One unreadable file must\n' +
      '    not discard a figure the other file actually produced.'
  );

  const partialQuiet = computeCapacity(roomyMachine(facts(m(UNDER), absent)), 0);
  verdict(
    partialQuiet.stalled === false && partialQuiet.stallPercent === UNDER,
    `and the same shape under the threshold admits, reporting ${UNDER}% from the one ` +
      `file that answered.`,
    'A PARTIAL INSTRUMENT UNDER THE THRESHOLD REFUSED — CHECK THIS.'
  );

  // worstStall drives the null/number boundary directly, because a max() over
  // two optional readings is exactly the thing that quietly answers 0 on the day
  // a file disappears — and that failure disables the gate while every report
  // still prints a figure.
  verdict(
    worstStall(facts(unreadable, absent)) === null &&
      worstStall(null) === null &&
      worstStall(facts(m(0), absent))?.percent === 0,
    'worstStall returns null when nothing was measured and 0 when 0 was measured —\n' +
      '    two different answers, which is the entire point of the module.',
    'worstStall CONFLATED "nothing measured" WITH "measured zero" — CHECK THIS.'
  );
  verdict(
    stallInstrument(facts(unreadable, absent)) === 'unreadable' &&
      stallInstrument(facts(absent, absent)) === 'absent',
    'and when the two files disagree about WHY they are silent, `unreadable` wins —\n' +
      '    it is the one that asks somebody to do something.',
    'THE INSTRUMENT STATE DID NOT PREFER unreadable — CHECK THIS.'
  );
}

// ---------------------------------------------------------- 5. tie rule --
rule('5. THE TIE RULE — a stalled machine with a full board still says `cap`');

{
  const io = { io: { state: 'measured', fullAvg10Percent: OVER }, memory: { state: 'measured', fullAvg10Percent: 0 } };
  // Same stalled machine, but the board is full too: `running` at the cap.
  const full = computeCapacity(roomyMachine(io), 99, { configuredCap: 1 });
  verdict(
    full.stalled === true && full.headroomBoundBy === 'cap',
    'stalled AND full → bound by `cap`, not `stall`. The reader can close an agent\n' +
      '    and cannot hurry a disk, so the refusal names the thing they can act on.',
    `A FULL STALLED BOARD NAMED ${full.headroomBoundBy} — CHECK THIS.`
  );
  verdict(
    full.stalled === true,
    'and `stalled` is still true on it — the veto is reported even when it is not\n' +
      '    the headline, so a reader is never told a machine is merely full when it\n' +
      '    is also stalled.',
    'THE STALL WAS HIDDEN BY THE COUNT TERM — CHECK THIS.'
  );
}

// ----------------------------------------------------------- 6. refusal --
rule('6. THE REFUSAL — the words, the arithmetic, and no victim offered');

{
  const stalled = computeCapacity(
    roomyMachine({
      io: { state: 'measured', fullAvg10Percent: OVER },
      memory: { state: 'measured', fullAvg10Percent: 0 }
    }),
    0
  );
  const headline = capacityHeadline(stalled);
  const reason = capacityReason(stalled);
  const derivation = describeCapacity(stalled);
  const refusal = capacityRefusal(stalled, '/tmp/example/agent');

  console.log(`  headline: ${headline}`);

  // Pinned to a literal. A new binding constraint that renders as one of the
  // existing headlines is a refusal that points at the wrong instrument, which
  // is the defect KAN-60 exists to have fixed — and `cpu too busy` on a machine
  // with idle cores would send a reader to the wrong place entirely.
  verdict(
    headline.startsWith('machine stalled on io — '),
    'the headline is `machine stalled on io`, distinct from `cpu too busy`, `load\n' +
      '    too high`, `not enough memory` and `at capacity`.',
    `THE HEADLINE WAS "${headline.slice(0, 60)}" — CHECK THIS. A fifth constraint\n` +
      '    must not render as one of the other four.'
  );
  verdict(
    !/cpu too busy|load too high|not enough memory/.test(headline),
    'and it is not any of the other four, which name instruments that did not refuse.',
    'THE STALL HEADLINE CONTAINS ANOTHER CONSTRAINT\'S NAME — CHECK THIS.'
  );

  // Reproducible by hand: the figure, the file it came from, the window it was
  // measured over, and the threshold it was compared against.
  const reproducible = [
    [`the figure (${OVER.toFixed(2)}%)`, reason.includes(`${OVER.toFixed(2)}%`)],
    ['the file it came from (/proc/pressure/io)', reason.includes('/proc/pressure/io')],
    ['the field and window (`full avg10`, 10 seconds)', /full avg10/.test(reason) && /10 seconds/.test(reason)],
    [`the threshold (${STALL_REFUSE_PERCENT}%)`, reason.includes(`${STALL_REFUSE_PERCENT}%`)],
    ['what the other terms allowed', /had room for \d+/.test(reason)]
  ];
  console.log('');
  for (const [what, ok] of reproducible) {
    console.log(`  ${flag(ok) ? '✓' : '✗ MISSING'} the reason names ${what}`);
  }
  verdict(
    reproducible.every(([, ok]) => ok),
    'a reader can reproduce this refusal by hand out of /proc/pressure.',
    'THE REFUSAL CANNOT BE CHECKED BY HAND — CHECK THIS. A refusal whose figures a\n' +
      '    reader cannot re-derive is one they have to take on trust.'
  );

  verdict(
    /those three terms allowed \d+, zeroed by the stall veto/.test(derivation),
    'the derivation prints what the counting terms allowed before the veto — so the\n' +
      '    veto\'s effect is visible, instead of looking like a machine that was full.',
    'THE DERIVATION DID NOT SHOW THE VETO\'S EFFECT — CHECK THIS.'
  );

  // The no-preemption decision, asserted directly. It is a pure function of the
  // capacity precisely so that it can be — inline in the router it could only
  // be reached by constructing a stalled machine under a live daemon, which is
  // the thing nothing here can do.
  verdict(
    preemptionCanHelp(stalled) === false,
    'no agent is offered for preemption on a stall: standing one down frees a SLOT,\n' +
      '    and slots are not what this machine is short of. It would destroy an agent\'s\n' +
      '    work and start its replacement onto the same stalled disk.',
    'PREEMPTION WAS OFFERED ON A STALL — CHECK THIS.'
  );
  const cpuBound = computeCapacity(
    { cores: 4, totalBytes: 16 * GIB, availableBytes: 12 * GIB, load1: 0.2,
      cpu: { busyCores: 3.9, windowSeconds: 30, sampledAt: Date.now() }, stall: null },
    0
  );
  verdict(
    preemptionCanHelp(cpuBound) === true && cpuBound.headroomBoundBy === 'cpu',
    'and it is still offered on every other refusal — a cpu-bound machine DOES get\n' +
      '    room back when an agent stops, so suppressing it everywhere would be a\n' +
      '    regression dressed as caution.',
    'PREEMPTION WAS SUPPRESSED ON A NON-STALL REFUSAL — CHECK THIS.'
  );

  verdict(
    refusal.includes('override: true'),
    'and the refusal still points at the override — a veto with no way out is not\n' +
      '    something this gate is entitled to add.',
    'THE STALL REFUSAL OFFERED NO WAY THROUGH — CHECK THIS.'
  );
}

// -------------------------------------------------------------- 7. live --
rule('7. LIVE — this machine\'s own /proc/pressure, end to end');

{
  // Nothing hand-written from here down: the real reader, the real files, into
  // a real Capacity. This is the section that establishes a reading ARRIVES —
  // §3–§6 prove only what the model does with one it was handed.
  const facts = readStallFacts();
  const live = computeCapacity(readMachineFacts(), 0);
  const stallSentence = describeCapacity(live).split('\n').find((l) => l.startsWith('io/memory stall:'));

  console.log(`  /proc/pressure/io     → ${facts.io.state}` +
    (facts.io.state === 'measured' ? ` ${facts.io.fullAvg10Percent.toFixed(2)}%` : ` (${facts.io.detail})`));
  console.log(`  /proc/pressure/memory → ${facts.memory.state}` +
    (facts.memory.state === 'measured' ? ` ${facts.memory.fullAvg10Percent.toFixed(2)}%` : ` (${facts.memory.detail})`));
  console.log(`  reported instrument   → ${live.stallInstrument}`);
  console.log(`  reported percent      → ${live.stallPercent === null ? 'null' : live.stallPercent.toFixed(2) + '%'}`);
  console.log(`  stall line            → ${stallSentence}`);

  // The state the report carries must be the state the files are actually in.
  // This is the assertion that a reading arrives AND survives the trip: a field
  // that is present, correctly typed and permanently wrong is KAN-200's shape.
  const expected = stallInstrument(facts);
  verdict(
    live.stallInstrument === expected,
    `the Capacity's instrument state (${live.stallInstrument}) is the one the real ` +
      `files are in.`,
    `THE REPORTED STATE (${live.stallInstrument}) DISAGREES WITH THE FILES ` +
      `(${expected}) — CHECK THIS.`
  );
  verdict(
    (live.stallPercent === null) === (live.stallInstrument !== 'measured'),
    'and a percentage is present exactly when something was measured — never on a\n' +
      '    machine nobody could read.',
    'A PERCENTAGE WAS PRESENT WITHOUT A MEASUREMENT, OR ABSENT WITH ONE — CHECK THIS.'
  );

  if (live.stallInstrument === 'measured') {
    verdict(
      live.stallPercent >= 0 && live.stallPercent <= 100,
      `the live figure (${live.stallPercent.toFixed(2)}%) is a share of wall time in 0..100.`,
      `THE LIVE FIGURE WAS ${live.stallPercent} — CHECK THIS.`
    );
    // Not a threshold assertion: what this machine reads depends on what else is
    // running, and a proof that goes red when the box is busy is worse than no
    // proof (KAN-218 learned this the expensive way). The claim is only that the
    // real path produced a real, in-range number and the gate agreed with it.
    verdict(
      live.stalled === (live.stallPercent >= STALL_REFUSE_PERCENT),
      `and \`stalled\` (${live.stalled}) is exactly the comparison of that figure ` +
        `against ${STALL_REFUSE_PERCENT}% — no second reading to disagree with.`,
      'THE LIVE VERDICT DOES NOT FOLLOW FROM THE LIVE FIGURE — CHECK THIS.'
    );
  } else {
    console.log(
      `\n  NOTE: PSI is ${live.stallInstrument} on this machine, so the gate is INERT here\n` +
        '  and I/O saturation is bounded by nothing. That is the named hole, not a\n' +
        '  failure — and the assertions above are what make it a REPORTED hole.'
    );
  }
}

// ------------------------------------------------------- 8. not covered --
rule('8. WHAT THIS PROOF DOES NOT ESTABLISH');

console.log(
  '  Printed rather than left in the header, because the reader who most needs it\n' +
  '  is the one reading a green run and deciding this area is covered.\n' +
  '\n' +
  `  1. NO REAL REFUSAL ON A REAL STALL. Nothing here drives the live gate over\n` +
  `     ${STALL_REFUSE_PERCENT}%. The hardest load induced for this slice — four synchronous\n` +
  '     direct writers, 2026-08-10 — peaked at 30.48%, and going harder on a shared\n' +
  '     machine running a live fleet was ruled out. §3-§6 are the arithmetic on a\n' +
  '     supplied machine; §7 is a real reading arriving. The seam between them is\n' +
  '     covered by NOBODY, and the induced-load measurements are on the PR.\n' +
  '\n' +
  '  2. THE MEMORY BRANCH IS FIXTURE-ONLY. `memory full avg10` never left 0.00%\n' +
  '     through every measurement taken here, because this machine has never\n' +
  '     swapped. §4 proves the model handles it; nothing proves the kernel ever\n' +
  '     puts a number there — and that is the ticket\'s headline case.\n' +
  '\n' +
  '  3. NOTHING HERE JUDGES THE THRESHOLD. That 50 is the right number is a\n' +
  '     DECISION, calibrated only from below against a machine that has never been\n' +
  '     sick. This proof would pass identically at 5 or at 95.\n'
);

// ------------------------------------------------------------- verdict ---
rule('VERDICT');

// The vacuity guard, held to the end. A section that stopped exercising its own
// fixture reports a clean pass; this is what makes that loud instead of silent.
const unexercised = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
if (unexercised.length) {
  failures += 1;
  console.log(
    `  ✗ VACUITY: §3 never observed ${unexercised.join(', ')} — the fixtures are no\n` +
    '    longer exercising the behaviour this file claims to check, whatever the\n' +
    '    other verdicts said.'
  );
} else {
  console.log('  ✓ §3 observed every branch it asserts on: admitted, refused-over, refused-at,');
  console.log('    and a veto that had non-zero headroom to cancel.');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\n  ALL CHECKS PASSED — a stalled machine admits nothing, an unmeasured one is\n' +
      '  not called quiet, and both say which they are.'
    : `\n  ${failures} CHECK(S) FAILED — see the lines marked CHECK THIS above.`
);
process.exit(failures ? 1 : 0);
