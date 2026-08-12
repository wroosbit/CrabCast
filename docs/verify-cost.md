# What the `verify` job costs, and why nothing fails on that number

**Status: a decision, not a placeholder.** KAN-331 asked for a stated position
on a budget for the `verify` job — a number and a consequence, or a written
decision that there is none and why. This is the second of those. It is written
down so the next person inherits a decision rather than an absence, which was
the ticket's actual complaint.

Proof: `scripts/verify-timing-attribution.mjs`. It reconciles the numbers in
this document against the workflow, so the two cannot drift apart.

---

## The decision

**There is no budget on the `verify` job's runtime. Nothing in this repository
fails, warns, or turns amber because the loop got slower.**

**What ships instead is attribution**: every run prints what each script cost,
sorted, on the run's own summary page.

**The one number that exists is `timeout-minutes: 20`, and it is a hang bound
rather than a budget.** Its consequence is real — GitHub kills the job and the
check goes red — but the thing it exists to catch is a proof waiting forever on
a socket, not a suite that grew. The alternative is the runner's six-hour
ceiling.

**A bound the loop grows into stops being purely a hang bound**, and this
document does not ask anyone to remember that. The reporter reads the number
out of the workflow and prints the loop as a percentage of it on every run, so
the day it reads 90% the reviewer sees it on the page. That is deliberate:
a sentence saying "someone should notice when this changes" is a claim
outliving its evidence the moment nothing measures the change — the failure
KAN-345 recorded, and the reason this is a printed ratio rather than a comment.

**The percentage is not a budget being spent**, and the reporter says so where
it prints it. It is the distance to a bound that exists for a different reason,
and the point of printing it is that "there is still headroom" should be a
reading rather than a belief.

---

## Why not a budget

Not a preference. The measurement is what argues against it.

Across eleven consecutive `main` runs (2026-08-11 15:12Z → 2026-08-12 14:41Z)
the loop went from **607.8s to 740.7s**. That +132.9s decomposes exactly:

| | |
| --- | --- |
| six scripts added | **+100.5s** |
| drift in the 40 present in both runs | **+32.5s** |
| **total** | **+132.9s** (observed: +132.9s) |

**The +100.5s is six new proofs doing real work** — `verify-restore-admission`
66.5s, `verify-send-contract` 26.8s, `verify-channel-enabled` 3.3s,
`verify-registry-survives-retired-rows` 2.2s, `verify-daemon-foreground` 1.7s,
`verify-uncharged-agent-cost` 0.0s. Each was individually justified when it
landed. That is the register working, not a regression.

**And +24.3s of the +32.5s "drift" is one script's variance, not growth.**
`verify-ci-proof-residue-is-legible` measured **18.3 / 20.5 / 44.6 / 44.2s**
across four runs on unchanged code.

So over exactly the window that prompted the question, a threshold on the total
would have fired on legitimate growth and on run-to-run noise,
indistinguishably, and never on a defect. **The response to a check that fires
for reasons unrelated to the change is to raise the check.** A gate people
raise is a gate people route around, which is the failure KAN-331 was filed to
prevent — arriving as its fix.

**A per-script budget fails for a sharper version of the same reason.** A
2.4x-swinging script would need a ceiling set above its unlucky case, which is
above its typical case by more than any regression worth catching.

### What would change this

A budget becomes the right instrument when there is something to compare
against — a per-script baseline from repeated runs, so a threshold can be set
on a distribution rather than on a sample. Nothing here builds that, and the
cost of building it (repeat runs of a twelve-minute job) is the thing the
ticket is worried about. If it is wanted, it should be a ticket with that
trade-off stated in it, not a number added quietly here.

---

## Who reads the attribution, and when

**The reviewer, at approval.** This epic's gate requires the reviewer to check
CI and re-run the ticket's proofs before approving, which puts them on the run
page already. The table renders there — in the step summary, not inside a
collapsed log group — so it is on the page they land on rather than behind a
suspicion.

**What is not claimed: that anything forces them to read it.** Nothing does. It
is a table on a page, and this section would be dishonest if it implied a
mechanism. The improvement over what existed is precise and small: the numbers
were always in the `::group::` timestamps of the raw log, recoverable by
downloading the artifact and diffing markers. KAN-331's author took fourteen
wall-clock readings across four days, wrote "nobody will be able to say which
script moved it without bisecting by hand" three times, and never did that
derivation. **"Available if you post-process the artifact" is what having no
attribution looks like from the inside.** Moving it to the summary page does
not make anyone read it; it removes the step that stopped them.

---

## Measured versus projected

**Measured.** Everything in this document. Per-script timings derived from
`::group::`/`##[endgroup]` timestamps in the raw logs of eleven `main` runs;
job wall clock from the runs API (`started_at` → `completed_at`, two readings
per elapsed time).

**Projected: nothing.** No trend is asserted here. The suite is larger than it
was and the loop is longer than it was, and this document claims only the
decomposition above — which attributes the whole of the change to named causes
and leaves no residue for a slope to live in.

**The instrument's own limit, stated because the table is most persuasive where
it is least reliable: one run cannot tell a slow script from an unlucky one.**
A single column of numbers reads as a measurement of each script and is one
sample of each script. `verify-ci-proof-residue-is-legible`'s 18.3–44.6s range
is wider than most deltas anyone would want to read out of it. The reporter
prints that caveat in its own output, next to the numbers, rather than only
here.

---

## The largest line item, which is not growth

**`verify-status-since` is ~191s — about 26% of the loop on its own**, and it
has been there throughout the window above. Four readings: 190.6 / 190.9 /
191.1 / 191.1s. Deterministic, not flaky. It contains two `await sleep(35_000)`
calls waiting out real daemon sweep intervals, so the cost is honest and this
document is not an argument for changing it.

It is recorded because it is the answer to "which of 46 scripts", nobody could
state it before, and the first thing anyone will ask of the new table is what
the biggest number is.
