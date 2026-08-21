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

**The one number that exists is `timeout-minutes: 30`, and it is a hang bound
rather than a budget.** Its consequence is real — GitHub kills the job and the
check goes red — but the thing it exists to catch is a proof waiting forever on
a socket, not a suite that grew. The alternative is the runner's six-hour
ceiling.

It was **20 until 2026-08-21**, when the paragraph below it came true and the
number was raised to 30. That revision is recorded in *The bound moved, and
why* near the end of this document.

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

## The bound moved, and why

**2026-08-21 (KAN-585): `timeout-minutes` raised from 20 to 30.** The decision
above is unchanged — there is still no budget, and nothing still fails because
the loop got slower. What changed is the hang bound, and it changed because the
paragraph warning about it came true.

### What made it necessary

**20 was chosen on 2026-08-03, when the loop was 38 seconds.** It is now around
14m19s. A bound the loop grows into "stops being purely a hang bound and becomes
a budget whose number nobody chose" — this document's own sentence, and by
2026-08-21 it described the actual state: the reporter's ratio, built precisely
so this would be read rather than remembered, was printing **89.1%**.

### The measurement

`scripts/kan585-verify-duration-survey.mjs` walked every run of `ci.yml` —
**364 run-attempts that actually ran**, 2026-08-03 to 2026-08-21, with no
filter on conclusion and every prior attempt walked. Its own header names the
three ways such a survey lies, because it lied in two of them before being
fixed.

| | |
| --- | --- |
| current suite, non-incident branches since 2026-08-15 | n=45: p50 **14m01s**, p95 14m31s, max **17m49s** |
| where those 45 sit | 43 of them inside a 69-second band, 13m25s–14m34s |
| runner variance alone, on byte-identical content | **14m02s vs 17m49s** = **×1.270** |
| times the old bound had already fired | **twice**, run 32406501749 attempts 1 and 2 |

**The 17m49s is a tail and not a second mode**, which was the question worth
answering. Across all 364 attempts, only four reach 15m00s at all: **15m05s,
the 17m49s itself, and the two censored timeouts at 20m17s and 20m21s.** The
17m49s is therefore isolated — the nearest attempt below it is **2m44s** away,
and the only things above it are the two runs the bound cut off. There is no
slower cluster for it to belong to: one draw went long, and the empty-diff pair
says the runner did it, because between those two runs the diff *is* empty.

### The arithmetic the number comes from

The worst runner draw ever measured, landing on a typical run of today's suite:
**14m19s × 1.270 = 18m11s**, which left **1m49s** under the old bound. The
margin had become thinner than a single measured draw. At 30 minutes the same
draw does not reach the bound until the suite's p50 has grown by **65%**, to
23m37s.

### What it trades

**A genuinely hung job now burns up to ten more minutes of runner wall-clock
before it is killed.** That is the entire cost, it is bounded, and it is paid in
free runner time; 30 minutes remains about twelve times tighter than the
six-hour ceiling this bound exists to avoid. Set against it: **zero of the 364
attempts were killed for an actual hang**, so that cost has a measured rate of
zero, while the false-cancellation it prevents has a measured rate above zero
and rising as the suite grows.

### The part that is about signal rather than convenience

A bound sitting inside the healthy distribution's variance **destroys its own
meaning**. When the old one fired it produced 20m21s and 20m17s — two readings
*of the bound*, not of the job, so nothing could distinguish a hung branch from
a merely slow one. A cancellation is censored data: it says the job exceeded the
bound and nothing whatever about by how much. Moving the bound clear of the
distribution is what makes a firing informative again, and that is the argument
this revision actually rests on. Raising a threshold to stop it misfiring would
be routing around a gate; correcting a threshold set below the measured
distribution of a healthy job is repairing one.

### What this is not

**It is not permission to trim proofs**, and no proof was trimmed for it. It is
not a budget arriving by the back door: nothing fails, warns, or turns amber on
a duration, exactly as before. And it is not a claim that the suite will keep
growing — the per-day figures show growth to date and no trend is projected
from them here.

### Measured versus inferred, for this revision

**Measured.** Every duration above, from each job's own `started_at` and
`completed_at`. Which cancellations were the bound firing, from GitHub's own
annotation text rather than guessed from their length. That the ceiling had
already fired.

**Inferred.** That the branch whose two runs were cancelled is genuinely slower
than main rather than twice unlucky — suggestive at two-of-two against zero of
45, and **not established**, because both of its runs are censored by the bound
and no duration can be recovered from them.

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
