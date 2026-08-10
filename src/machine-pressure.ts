// How much wall-clock time this machine is losing to waiting, as opposed to
// how much of it is working (KAN-216).
//
// THE GAP THIS FILE FILLS. KAN-208 replaced the load-average headroom term with
// cores actually in use. That was right, and it removed a protection nobody
// named at the time: `load1` counts TASK_UNINTERRUPTIBLE alongside
// TASK_RUNNING, so a machine thrashing on swap or stalled on a failing disk
// showed a high load with idle cores and the old gate refused there — for the
// wrong reason, with the right outcome. machine-cpu.ts deliberately counts
// iowait as NOT busy, which is correct for a CPU term and leaves I/O saturation
// bounded by nothing at all. Both files named the seam in their headers; this
// one closes it.
//
// ---------------------------------------------------------------------------
// THE INSTRUMENT, AND WHY NOT THE OBVIOUS ONE
// ---------------------------------------------------------------------------
//
// The obvious candidate is /proc/stat's `iowait`, and it is the wrong one. It
// is a PER-CPU bucket: a jiffy counts as iowait only when that CPU is idle and
// has at least one task on it blocked on I/O. Two consequences, both fatal for
// a gate:
//
//   - It is divided by the core count. One task fully blocked reads as 25%
//     iowait on a 4-core box and 1.6% on a 64-core one. A threshold on it
//     measures the hardware as much as the saturation.
//   - It goes to ZERO precisely when the machine is busiest. If the CPUs have
//     other runnable work, blocked tasks charge nothing to iowait at all — so
//     the number collapses exactly in the case a gate exists to catch.
//
// The first of those was measured here rather than repeated from folklore, and
// the second is carried from the extraction source with its limit marked.
//
// MEASURED HERE, 2026-08-10, 4-core machine, 4 × `dd bs=4k oflag=direct,dsync`
// for 30s. `io full avg10` peaked at 30.48% while /proc/stat's iowait over the
// same 1s windows read 19.11% — a consistent 1.6–1.85x understatement across
// the whole induced phase, never once an agreement. So iowait is demonstrably
// the wrong scale on this machine even in the case that most favours it.
//
// NOT REPRODUCED HERE, and named because the difference matters: the extraction
// source measured iowait falling to 0.00% under an 8-way load while PSI read
// 21% (KAN-218, `c18d837`, same machine, 2026-08-08). That collapse needs the
// CPUs to have other runnable work, and this slice did not induce CPU
// saturation alongside the I/O — a shared box running a live fleet is not
// somewhere to stage one. What is established here is the understatement and
// its direction; the collapse is the extraction source's measurement, cited as
// evidence and not re-derived. Either finding alone disqualifies iowait.
//
// So: PRESSURE STALL INFORMATION, /proc/pressure/{io,memory}, which measures
// the quantity directly — the share of wall-clock time tasks spent stalled,
// machine-wide, independent of core count and of whether the CPUs had other
// work to do.
//
// `full` AND NOT `some`. `some avg10` is "at least one task was stalled", which
// one honest `dd` puts above zero on a perfectly healthy machine. `full avg10`
// is "every non-idle task was stalled" — the share of the last ten seconds in
// which the machine made no forward progress at all. That is the quantity a
// capacity gate is entitled to refuse on.
//
// `avg10` AND NOT `avg60`. Admission is a question about now. Preferring a
// smoother, more-lagging average is the mistake KAN-208 catalogued; ten seconds
// is the same order as the CPU term's window.
//
// BOTH FILES, BECAUSE SWAP THRASH IS NOT FILED UNDER I/O. The ticket's headline
// case is a machine thrashing on swap, and an io-only term would miss it: the
// kernel accounts a task waiting on swap-in as a MEMORY stall, alongside direct
// reclaim and cache thrashing, not an I/O one. This term reads both files,
// takes the worse of the two, and reports which. It is not folded into the
// existing memory term for the same reason: `availableBytes` asks *is there
// room*, and this asks *is the machine stalling to make room*. They disagree
// exactly when it matters.
//
// ---------------------------------------------------------------------------
// "I DON'T KNOW" IS A STATE, NOT A ZERO — AND IT IS THREE STATES, NOT TWO
// ---------------------------------------------------------------------------
//
// This is the part of this file that is load-bearing, and it is where this
// slice deliberately departs from the extraction source it took the instrument
// from. An unreadable pressure file MUST NOT read as 0.00%, because 0.00% is an
// all-clear: it is the difference between "the machine is fine" and "nothing
// looked at the machine", and a gate that says the first when it means the
// second has quietly deleted itself while every report still prints a figure.
// That is this epic's single most-repeated defect and a stall term is an
// unusually easy place to commit it.
//
// The extraction source models a reading as `number | null`. That makes the
// all-clear unrepresentable, which is the important half — but it collapses two
// genuinely different facts into one `null`:
//
//   - ABSENT: there is no /proc/pressure on this machine. Pre-4.20 kernels,
//     kernels built without CONFIG_PSI, and everything that is not Linux. This
//     is expected, permanent, and not a problem with this machine — the answer
//     is "this kernel cannot tell you", and nothing here is broken.
//   - UNREADABLE: the file is THERE and we could not get a figure out of it. A
//     permission error, a restricted container, a truncated or malformed read.
//     This is not expected, it may be transient, and it means an instrument
//     that this machine is supposed to have is not answering.
//
// Those want different responses from whoever reads the derivation — the first
// is a hardware fact to accept, the second is something to go and look at — and
// a single `null` cannot ask for either. So {@link PressureReading} is a
// three-way discriminated union, the same distinction KAN-98 landed for tail
// reads (`text` / `genuinely empty` / `could not look`), and for its reason.
//
// The invariant every one of these shapes exists to enforce: A FIGURE IS
// PRESENT ONLY WHEN IT WAS MEASURED. There is no field a caller can read as a
// percentage without first having gone through the discriminant, so the
// "unreadable reads as 0" defect cannot be written here by accident.
//
// AND THERE IS NO FALLBACK INSTRUMENT, ON PURPOSE. `procs_blocked` from
// /proc/stat is available everywhere and was considered and declined: it is an
// instantaneous count of tasks in uninterruptible sleep, one `dd` puts it at 1
// on a healthy machine, and without a rate and a window there is no threshold
// separating healthy from thrashing. A fabricated instrument that refuses
// activations on a healthy machine is worse than a named hole. So the hole is
// named: on a machine without PSI, I/O saturation is bounded by nothing, and
// the derivation says exactly that in words rather than printing a reassuring
// number.
//
// WHY THERE IS NO WINDOW AND NO SAMPLER HERE, unlike machine-cpu.ts. PSI is
// already an average the kernel maintains over the last ten seconds, so a
// single read answers, and the first call answers as well as the thousandth.
// There is no baseline to hold, nothing to publish on a timer, and no staleness
// to enforce on read — which is why this file is a reader and not an
// instrument with a lifecycle.

import * as fs from 'fs';

/**
 * One /proc/pressure file, read.
 *
 * Three states rather than two, and a percentage that exists in exactly one of
 * them — see the header. `absent` is a machine that cannot answer; `unreadable`
 * is a machine that would not.
 */
export type PressureReading =
  | { state: 'measured'; fullAvg10Percent: number }
  | { state: 'absent'; detail: string }
  | { state: 'unreadable'; detail: string };

/** The two files this term reads. `io` is the disk; `memory` is where the
 *  kernel files a task waiting on swap-in. */
export type StallSource = 'io' | 'memory';

/**
 * How stalled this machine is, from both pressure files, each carrying its own
 * three-way outcome.
 *
 * Both readings are kept even though only the worse one can bind, so a
 * derivation can print the one that did not — and so that "io said 0.3% and
 * memory could not be read" is a sentence the report is able to say.
 */
export interface StallFacts {
  io: PressureReading;
  memory: PressureReading;
}

/**
 * The share of wall time at or above which no agent is admitted, whatever the
 * counting terms say.
 *
 * A DECISION, NOT A MEASUREMENT, and this file is careful enough about that
 * distinction elsewhere to say so here. No observed outage calibrated it: this
 * gap has no observed instance — the machine that motivated the ticket has
 * never swapped and does not wait on I/O (KAN-216, measured over ~4 hours).
 *
 * WHAT WAS MEASURED HERE, 2026-08-10, on the 4-core machine this runs on:
 *
 *   - ORDINARY WORK PRODUCES NOTHING AT ALL. Over a 4.6-minute passive record
 *     spanning a live agent fleet and a full TypeScript build, `io full avg10`
 *     read 0.00% in 104 of 139 samples, and every single non-zero sample in the
 *     record belongs to the induced window below. The build itself — the
 *     heaviest ordinary thing this repo does — moved it not at all, because a
 *     compile is CPU-bound and the page cache absorbs its writes.
 *   - A DELIBERATE STRESS REACHES ~30%. Four concurrent `dd bs=4k
 *     oflag=direct,dsync` writers for 30s: `io full avg10` mean 20.76%, peak
 *     30.48%, with `load1` climbing 2.28 → 4.83 (which is the KAN-208 story
 *     from the other side — the queue inflates while the cores stay free).
 *   - `memory full avg10` NEVER LEFT 0.00% in any of it. This machine has 2 GB
 *     of swap against 15.4 GB of RAM and has never thrashed, so the memory half
 *     of this term is, here, entirely unexercised by observation.
 *
 * WHY 50 AND NOT SOMETHING NEAR THE STRESS PEAK. Because the expensive failure
 * in this epic's history is the FALSE REFUSAL, not the missed one. KAN-191,
 * KAN-194 and an eight-hour intermittency hunt came out of a gate that refused
 * healthy machines, and KAN-208 exists to have removed it; the ticket that
 * commissioned this term says in terms that restoring the old proxy would
 * "reinstate every false positive to recover one true one". A threshold set
 * just above a synthetic stress inherits exactly that risk, and its number
 * would be an artefact of the `dd` flags somebody happened to choose. So this
 * errs the other way, and the residual gap below is named rather than papered
 * over.
 *
 * 50% is also the one figure here that describes itself without reference to
 * any stress test: for more than half of the last ten seconds, EVERY non-idle
 * task on this machine was stalled. That is a machine that is not running, and
 * it is the condition — a failing disk, a hung NFS or FUSE mount, a device
 * queue nothing drains — that this term exists for. Such a device does not
 * produce 30%; it produces 60–100%, sustained.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, stated so it is a decision and not a
 * discovery: moderate saturation. The 30% stress measured above does NOT trip
 * this gate, and that is the intended behaviour — a machine writing hard is
 * working, not failing. Between roughly 5% and 50% this term admits agents onto
 * a machine that is losing real time to I/O, and nothing else bounds that
 * either. If an actual incident is ever observed, THIS NUMBER SHOULD BE
 * RE-DERIVED FROM IT rather than defended: it is calibrated only from below,
 * against a machine that has never once been sick.
 *
 * THERE IS NO ENVIRONMENT OVERRIDE FOR THIS, and that is deliberate rather than
 * an omission — see the KAN-216 section of capacity.ts. An operator who needs
 * an agent onto a stalled machine passes `override: true` on the activation,
 * which is recorded with the arithmetic that refused it.
 */
export const STALL_REFUSE_PERCENT = 50;

/**
 * `full avg10` out of one /proc/pressure file.
 *
 * The file looks like this, and both lines are present on `io` and `memory`
 * (only /proc/pressure/cpu lacks a meaningful `full` at system level):
 *
 *     some avg10=2.27 avg60=2.32 avg300=1.98 total=537036752
 *     full avg10=0.01 avg60=0.18 avg300=0.24 total=313582439
 *
 * ENOENT is `absent` — this kernel has no PSI, which is a fact about the
 * machine. Every other failure is `unreadable` — the file is there and did not
 * yield a figure — and each carries the detail that a reader would otherwise
 * have to guess at. Neither produces a number, so neither can be mistaken for
 * a quiet machine.
 *
 * A figure outside 0..100 is `unreadable` rather than clamped: `full` is a
 * percentage of wall time and cannot exceed 100, so a value that does means the
 * file is not what this parser thinks it is, and guessing at it is how a gate
 * ends up dividing noise.
 *
 * The path is a parameter so the proof can drive the real parser from fixture
 * files rather than constructing {@link StallFacts} by hand. That is not
 * convenience: a gate whose arithmetic is verified on facts the test supplied
 * has not been shown to receive real ones (the KAN-145 hole), and pointing this
 * function at a file holding a real stalled machine's bytes is what closes the
 * seam between the parse and the arithmetic.
 */
export function readPressureFull(path: string): PressureReading {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (e: any) {
    // ENOENT is the expected shape of "this kernel has no PSI". Anything else —
    // EACCES in a restricted container, EIO on a sick /proc — is a machine that
    // has the file and would not give it to us, which is a different sentence.
    if (e?.code === 'ENOENT') {
      return { state: 'absent', detail: `${path} does not exist (no CONFIG_PSI, pre-4.20 kernel, or not Linux)` };
    }
    return { state: 'unreadable', detail: `${path} could not be read: ${e?.code ?? e?.message ?? String(e)}` };
  }

  const line = text.split('\n').find((l) => l.startsWith('full '));
  if (!line) return { state: 'unreadable', detail: `${path} has no \`full\` line` };

  const field = line.split(/\s+/).find((f) => f.startsWith('avg10='));
  if (!field) return { state: 'unreadable', detail: `${path}'s \`full\` line has no avg10= field` };

  const value = Number(field.slice('avg10='.length));
  if (!Number.isFinite(value)) {
    return { state: 'unreadable', detail: `${path} gave a non-numeric avg10 (${field})` };
  }
  if (value < 0 || value > 100) {
    return { state: 'unreadable', detail: `${path} gave avg10=${value}, which is outside 0..100` };
  }
  return { state: 'measured', fullAvg10Percent: value };
}

/**
 * How stalled this machine is, from both pressure files.
 *
 * `root` is a parameter for the same reason {@link readPressureFull}'s path is:
 * the proof points it at a directory of fixtures so that the reader, the
 * worst-of-two, the veto and the sentence are all exercised by one call.
 */
export function readStallFacts(root = '/proc/pressure'): StallFacts {
  return {
    io: readPressureFull(`${root}/io`),
    memory: readPressureFull(`${root}/memory`)
  };
}

/**
 * The worse of the two figures and which file it came from, or null when
 * NEITHER was measured.
 *
 * Null means the term cannot fire — not that the machine is quiet. The
 * distinction is the whole of this module and it is enforced by the return
 * type: there is no percentage to read on the null branch.
 *
 * A partial instrument still gates. If `io` measured 40% and `memory` could not
 * be read, this returns io's 40% and the machine is stalled: a figure that was
 * actually taken is not made less true by a second file being unavailable, and
 * refusing to act on it would turn one broken file into a disabled gate.
 *
 * Exported because the proof drives it directly: a max() over two optional
 * readings is exactly the kind of thing that quietly answers 0 instead of null
 * on the day a file disappears, and that failure would silently disable the
 * gate while every report still printed a figure.
 */
export function worstStall(
  stall: StallFacts | null | undefined
): { percent: number; source: StallSource } | null {
  if (!stall) return null;
  const candidates: Array<{ percent: number; source: StallSource }> = [];
  if (stall.io.state === 'measured') {
    candidates.push({ percent: stall.io.fullAvg10Percent, source: 'io' });
  }
  if (stall.memory.state === 'measured') {
    candidates.push({ percent: stall.memory.fullAvg10Percent, source: 'memory' });
  }
  if (candidates.length === 0) return null;
  // Ties go to io: it is the cheaper of the two to act on — a disk is a thing an
  // operator can go and look at — and a tie between two equal figures is
  // arbitrary anyway. `>` rather than `>=` keeps that stable.
  return candidates.reduce((worst, c) => (c.percent > worst.percent ? c : worst));
}

/**
 * Whether this machine can answer the question at all, as one word for a report
 * to lead with.
 *
 * `measured` — at least one file gave a figure, so the term can bind.
 * `absent`   — no PSI here at all; expected, and nothing bounds I/O saturation.
 * `unreadable` — PSI is present and did not answer; worth looking at.
 *
 * `unreadable` wins over `absent` when the two files disagree, because it is the
 * one that asks somebody to do something.
 */
export function stallInstrument(stall: StallFacts | null | undefined): 'measured' | 'absent' | 'unreadable' {
  if (!stall) return 'absent';
  if (stall.io.state === 'measured' || stall.memory.state === 'measured') return 'measured';
  if (stall.io.state === 'unreadable' || stall.memory.state === 'unreadable') return 'unreadable';
  return 'absent';
}

/**
 * One reading in words, for the derivation.
 *
 * Every branch is a sentence rather than a number-or-blank, because the line
 * this feeds is read by somebody asking why an agent was refused — or, more
 * dangerously, why one was not.
 */
export function describePressureReading(label: StallSource, reading: PressureReading): string {
  switch (reading.state) {
    case 'measured':
      return `${reading.fullAvg10Percent.toFixed(2)}% ${label}`;
    case 'absent':
      return `${label} not available`;
    case 'unreadable':
      return `${label} UNREADABLE (${reading.detail})`;
  }
}
