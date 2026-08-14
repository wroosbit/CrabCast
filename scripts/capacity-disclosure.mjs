// KAN-179: when a proof's SCAFFOLDING activation is refused by the capacity
// gate, say so in the proof's own output.
//
// WHY THIS EXISTS, and it is the backstop rather than the guard. The guard is
// `scripts/verify-scaffolding-past-the-gate.mjs`: a register that goes red
// BEFORE the flake, on the pull request that adds an unclassified bare
// activation. This file is what catches the case the register cannot — a site
// that IS registered, under a classification that is wrong. There the proof
// still goes red on a loaded machine, and the question the reader arrives with
// is "this required check is red and I do not know why".
//
// KAN-171 is the worked case and the cost is measured: `verify-config-echo-
// contract` failed 8 runs out of 8 at load 2.6-2.8 and passed 2 of 2 quiet,
// reporting "drift not proven" — a statement about the laptop wearing the words
// of a statement about the echo. The daemon had said `refusedBy: 'capacity'` in
// its response the whole time. Nothing printed it.
//
// SO THIS IS A PRINT, NOT AN ASSERTION, and deliberately: a proof whose
// scaffolding is refused by capacity is in a state its author did not intend,
// and what it needs first is to say which state that is. Whether that should
// also FAIL the run is the caller's decision — `verify-config-echo-contract`
// already answers it both ways in one file (its `given` for ordinary callers,
// its §6 for the section that asks for the refusals).
//
// WHAT THIS DOES NOT COVER, said here because the gap between two honest
// mechanisms is where this epic keeps finding defects:
//
//   - It discloses a refusal that REACHED THE CALLER. A fixture that drops the
//     response on the floor discloses nothing, and no module can make it.
//   - It reads `refusedBy`, which is the daemon's own word (`src/router.ts`,
//     the `refusedBy: 'capacity'` branch of `handleActivate`). If that field
//     stopped riding the refusal this returns null and says nothing — the
//     contract check for the field's presence is `verify-read-contract`, and
//     that a bad `override` flag is refused BEFORE the gate is reached at all
//     is `verify-idempotent-lifecycle`. Neither covers the other.
//   - There is NO SHARED FIXTURE in this suite to install it in — measured at
//     973d5ce: `scripts/` holds three shared modules (`ci-workflow.mjs`,
//     `mutation.mjs`, `readme-blocks.mjs`) and not one of them is a harness.
//     Every proof builds its own `invoke`/`callTool`/`harness`. So adoption is
//     per-proof and opt-in, and the sweep prints which proofs have adopted it
//     rather than requiring any of them to.
//
// Not named `verify-*`, so the proof registry neither runs it nor demands a
// register entry (KAN-141) — it is a module. It is nonetheless held to a proof:
// `verify-scaffolding-past-the-gate.mjs` §6 requires this file to export the
// function and requires at least one tracked proof to import it, so it cannot
// become dead code that reads like coverage.

/**
 * The one line a reader most needs when a scaffolding activation was refused
 * because the machine was busy, or null when this response is not that.
 *
 * @param {unknown} response an `activate_response` as the caller received it
 * @returns {string|null}
 */
export function capacityDisclosure(response) {
  if (!response || typeof response !== 'object') return null;
  const r = /** @type {Record<string, any>} */ (response);
  if (r.refusedBy !== 'capacity') return null;

  const parts = [`refusedBy: 'capacity'`];
  if (typeof r.reason === 'string' && r.reason) parts.push(`reason: ${r.reason}`);
  const c = r.capacity;
  if (c && typeof c === 'object') {
    parts.push(
      `cap=${c.cap} headroom=${c.headroom} running=${c.running} boundBy=${c.headroomBoundBy}`
    );
  }
  if (typeof r.derivation === 'string' && r.derivation) {
    parts.push(r.derivation.split('\n')[0].slice(0, 160));
  }
  return (
    `THE MACHINE REFUSED THIS ACTIVATION, NOT THE CODE UNDER TEST — ${parts.join(' · ')}. ` +
    `If this activation is SCAFFOLDING rather than the subject, it belongs past the gate: ` +
    `see PAST_THE_GATE in scripts/verify-config-echo-contract.mjs and the register in ` +
    `scripts/verify-scaffolding-past-the-gate.mjs.`
  );
}
