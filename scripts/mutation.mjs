// THE ONE WAY A PROOF IN THIS SUITE MUTATES THE COMPILED DAEMON (KAN-138).
//
// WHY THIS FILE EXISTS, stated as what was found rather than as what is nice.
//
// Eight scripts each carried their own copy of this helper —
// `verify-activated-by`, `verify-config-echo-contract`, `verify-event-contract`,
// `verify-event-durability`, `verify-fleet-enumeration`,
// `verify-reconfiguration-refuses`, `verify-send-confirms-delivery` and
// `verify-state-read-echoes-config` — under two different names
// (`mutantDist`, `mutatedBuild`), three different signatures, and four
// different wordings of the same error. KAN-138 was staffed to "adopt
// `mutatedBuild()`'s exact-count self-assertion across every mutation-based
// proof", and the survey found that **all eight already had it**. Every one
// counts occurrences and refuses to proceed on anything but exactly one.
//
// So the gap was not the assertion. It was what happens next.
//
// ALL EIGHT THREW. And a throw out of a mutation helper is the defect the
// ticket that commissioned this file is about — items 2, 12, 13, 15 and 18 are
// all "a check that stops measuring under exactly the conditions it exists
// for". A mutation whose anchor has drifted is the single most likely thing to
// go wrong in one of these scripts, because every unrelated slice that edits
// the daemon can move an anchor without touching the proof. When it happens,
// the throw kills the process: the mutation sections after it never run, the
// verdict line never prints, and a reader sees a stack trace from section 8
// with no signal at all that sections 9 and 10 were skipped. That was observed
// live — `verify-state-read-echoes-config` died at §8 during a review and §9,
// the section whose entire job is proving the other checks can fail, never
// executed.
//
// THE FOUR PROPERTIES, and the fourth is the one that is new here:
//
//   1. EXACT COUNT, not "at least one". `found 0` and `found 3` are both
//      failures. A mutation that hits three call sites is not the mutation you
//      designed, and one that hits none has produced an unmutated build that
//      the section will then report success about — the proof is not weak at
//      that moment, it is INVERTED, reporting the strongest available result
//      at the exact instant it tested nothing.
//
//   2. IT LIVES IN THE SHARED HELPER, which is the only path to a mutated
//      build, so it covers every section automatically. A guard bolted onto one
//      section while its siblings go unprotected is the usual shape of this
//      defect rather than the cure for it.
//
//   3. THE DIAGNOSIS NAMES WHICH THING IS BROKEN. "Fix the mutation, not this
//      check." Without that sentence the next person to hit it deletes the
//      guard, which is the outcome this whole file is trying to buy off.
//
//   4. A FAILED MUTATION IS A COUNTED VERDICT, NOT A THROW. `mutate` reports
//      the failure through the script's OWN `check()`, so it lands in the
//      failure list and the verdict goes red, and then RETURNS NULL so the
//      caller can skip its section and let the rest of the file run. The run
//      still fails — that is not softened — but it fails having told you
//      everything else it knows.
//
// AND ONE MORE THE OLD COPIES MOSTLY LACKED: a mutation whose `replace` equals
// its `find` is refused. "A mutation that changes nothing proves nothing" is a
// rule this epic learned twice from green runs left behind by edits that
// silently no-opped, and it costs one comparison to hold.
//
// HOW A CALLER USES IT, and why the shape is a labelled block. The sections
// that mutate are already `{ … }` blocks, so skipping one on a failed mutation
// takes two lines and no re-indentation:
//
//     mutationA: {
//       const dir = mutate('no-echo', 'router.js', FROM, TO);
//       if (!dir) break mutationA;
//       … the section, unchanged …
//     }
//
// WHAT THIS FILE DOES NOT DO, said here because the gap between two honest
// mechanisms is where this epic keeps finding defects. It guarantees that a
// build the caller receives WAS edited exactly as asked. It cannot know whether
// that edit changes any behaviour the section then asserts on — a mutation can
// apply perfectly and land on an idempotent safety net, and this helper will
// hand back a mutant that behaves exactly like the original. That is the
// caller's problem and it is a real one; `scripts/verify-mutation-harness.mjs`
// says so in its header too, and neither file should be read as covering it.
// The only defence against it is the one the sections already use: assert the
// property goes red, not merely that the mutant differs.
//
// Not named `verify-*`, so the proof-registry job neither runs it nor demands
// a register entry (KAN-141) — it is a module, like `ci-workflow.mjs`. It is
// nonetheless held to a proof: `scripts/verify-mutation-harness.mjs` exercises
// every branch below and sweeps the suite for anyone who stopped using it.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The sentence a reader most needs when a mutation stops applying, kept as a
 * constant because `verify-mutation-harness.mjs` asserts on the TEXT and not
 * merely on the failure. A helper that fails closed satisfies an exit-code
 * assertion while having lost its diagnosis entirely, so the diagnosis is
 * pinned separately from the verdict.
 */
export const FIX_THE_MUTATION = 'Fix the mutation, not this check.';

/**
 * Build a mutator bound to one script's dist, scratch directory and `check`.
 *
 * @param {object} opts
 * @param {string} opts.distDir  the compiled build to copy from
 * @param {string} opts.scratch  a directory the mutants may be written under
 * @param {(name: string, ok: boolean, detail?: string) => void} opts.check
 *        the SCRIPT'S OWN check function. Handed in rather than reimplemented,
 *        because property 4 means a failed mutation has to land in the same
 *        failure list every other assertion lands in — a private counter here
 *        would be a second verdict nobody reads.
 */
export function makeMutator({ distDir, scratch, check }) {
  if (typeof check !== 'function') {
    // Not a counted failure: there is nothing to count it into. A mutator
    // built without the script's verdict is the one error here that cannot be
    // reported the normal way, so it is loud.
    throw new Error(
      'makeMutator({ check }) needs the script\'s own check function — without it a failed ' +
        'mutation could not be counted into the verdict, which is the whole point of this helper.'
    );
  }

  /** Every mutation that did not apply, so the verdict can name what was skipped. */
  const skipped = [];

  /**
   * A copy of `distDir` with each edit applied, or NULL when any edit did not
   * apply exactly once — in which case the failure is already counted.
   *
   * `edits` is `[{ file, find, replace }]`. The single-edit call
   * `mutate(name, file, find, replace)` is accepted too, because that is the
   * shape most of the suite was already written in and rewriting call sites to
   * suit a helper is churn that buys nothing.
   *
   * @returns {string|null} the mutated module directory, or null
   */
  function mutate(name, ...rest) {
    const edits =
      rest.length === 1 && Array.isArray(rest[0])
        ? rest[0]
        : [{ file: rest[0], find: rest[1], replace: rest[2] }];

    const target = path.join(scratch, `mutant-${name}`);
    // Rebuilt from scratch every time: a mutant left over from an earlier call with
    // the same name would be handed back silently as though this call had made
    // it.
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(distDir, target, { recursive: true });

    for (const { file, find, replace } of edits) {
      const p = path.join(target, file);
      let before;
      try {
        before = fs.readFileSync(p, 'utf8');
      } catch (err) {
        return fail(
          name,
          `could not read ${file} in the copied build (${err?.message ?? err}). The build was ` +
            `NOT mutated, so the section using it would have proved nothing.`
        );
      }

      if (find === replace) {
        return fail(
          name,
          `its \`find\` and \`replace\` are identical, so applying it would change nothing and ` +
            `the section using it would pass against an unmutated build.`
        );
      }

      const count = before.split(find).length - 1;
      if (count !== 1) {
        return fail(
          name,
          `expected exactly 1 occurrence of ${JSON.stringify(find)} in ${file}, found ${count}. ` +
            `The build was NOT mutated, so the section using it would have proved nothing.`
        );
      }

      fs.writeFileSync(p, before.replace(find, replace));
    }

    check(
      `mutation "${name}" applied to a copy of the build`,
      true,
      edits.map((e) => `${e.file}: ${JSON.stringify(e.find).slice(0, 60)} → ${e.replace.length} chars`).join('; ')
    );
    return target;
  }

  function fail(name, why) {
    skipped.push(name);
    check(
      `mutation "${name}" DID NOT APPLY — the section that needed it did not run`,
      false,
      `${why} ${FIX_THE_MUTATION}`
    );
    return null;
  }

  /**
   * The names of the mutations that did not apply. Printed next to the verdict
   * so "3 FAILED" is not read as three ordinary assertion failures when what
   * actually happened is that three sections never executed.
   */
  const mutationsSkipped = () => [...skipped];

  return { mutate, mutationsSkipped };
}
