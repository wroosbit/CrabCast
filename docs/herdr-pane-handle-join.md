# The pane-handle join: what it rests on, what we asked herdr for, and what we decided

**KAN-385.** CrabCast attributes CPU cost to agents by joining a running process
to the pane it is sitting in. That join works, it is measured, **and the step in
the middle of it is a target form herdr's own help does not document.** This page
is the record: the measurement, the request we are making of herdr's maintainer,
and — the half a request cannot cover — what we do if the answer is no.

Nothing here is a defect in herdr. We built a join on top of what herdr exposes
and are asking for a published surface to replace an observed one.

---

## 1. The join

`src/agent-cost.ts` groups every process on the machine under its agent-runtime
tree root, then asks one question per tree: *is this tree a charged agent of
ours?* Answering it runs **process → pane → name**:

```
/proc/<tree root>/environ    HERDR_PANE_ID = p_252          <- what the process carries
herdr pane get p_252         label   = butchr-task-kan-385   <- the name CrabCast minted
                             pane_id = w65702dcc803d94-10    <- a DIFFERENT identifier
```

The name is then handed to `ourPaneIn` (`src/herdr.ts`), which is where ownership
has always been decided. The middle step is `HerdrBridge.paneNameForHandle`
(`src/herdr.ts`), and it is a lookup rather than a judgement: it answers *which
pane is that*, never *is it ours*.

**The environment handle is not the `pane_id`.** They are two different
identifiers on the same record. The join works because `herdr pane get` accepts
the `p_NNN` form.

---

## 2. Re-measured at our own head

All readings below are **herdr 0.6.4**, on the development machine, **2026-08-13**,
read-only commands only. Every probe carries a control that makes it move: an
absence is only a measurement if the same probe returns non-zero for something
that is present.

**They are re-runnable, and you should re-run them rather than trust the
numbers**: `node scripts/kan385-herdr-handle-survey.mjs` is this section, and its
exit code is the controls' verdict rather than the readings'. The fleet is live,
so pane and tree counts will differ from the run pasted here; what should not
differ is any control.

### 2.1 What `pane list` publishes

```
herdr pane list  ->  120 panes

key            how many panes carry it
  agent            7
  agent_status   120
  cwd            120
  focused        120
  label           25
  pane_id        120
  revision       120
  tab_id         120
  terminal_id    120
  workspace_id   120
```

`agent` and `label` are on a minority of panes; the other eight are on every one.

### 2.2 No pid, no tty, no process field, and no handle — across four commands

```
command     records  ABSENT /pid|tty|proc|handle|env/i   CONTROL /_id$/
pane list   120      0 []                                4 ["pane_id","tab_id","terminal_id","workspace_id"]
pane get    1        0 []                                4 ["pane_id","tab_id","terminal_id","workspace_id"]
agent list  18       0 []                                4 ["pane_id","tab_id","terminal_id","workspace_id"]
agent get   1        0 []                                4 ["pane_id","tab_id","terminal_id","workspace_id"]
```

The ABSENT column is 0 everywhere and the CONTROL column is non-zero everywhere,
so the zero is a reading rather than a broken grep.

### 2.3 The handle is not published anywhere in `pane list`

```
"p_252"               (the environment handle)  occurrences in pane list JSON:  0
"w65702dcc803d94-10"  (the published pane_id)   occurrences:                    1   CONTROL
"butchr-task-kan-385" (the label)               occurrences:                    1   CONTROL
any "p_<digits>" token anywhere:                                                0
```

### 2.4 Which target forms `pane get` accepts

```
p_252                  ->  butchr-task-kan-385           the environment handle
w65702dcc803d94-10     ->  butchr-task-kan-385           the published pane_id
butchr-task-kan-385    ->  UNRESOLVED (pane_not_found)   the label is not a target
p_2520                 ->  UNRESOLVED (pane_not_found)   CONTROL: one digit appended
definitely-not-a-pane  ->  UNRESOLVED (pane_not_found)   CONTROL: nonsense
```

**`pane get` accepts the published `pane_id` too — and that does not help us**,
because the environment only ever hands us the `p_NNN` form. Going the other way
is the direction we need and the one that is not available.

### 2.5 Every one of our trees joins, and the resolver discriminates

```
 root pid  comm     handle   pane get -> label          agent get -> name
  1066654  claude   p_138    butchr-epic-kan-39         butchr-epic-kan-39
  1078097  claude   p_140    butchr-task-kan-117        butchr-task-kan-117
  1080524  claude   p_142    butchr-story-kan-117       butchr-story-kan-117
  2797886  claude   p_252    butchr-task-kan-385        butchr-task-kan-385
  2803191  claude   p_254    butchr-task-kan-378        butchr-task-kan-378
  4017075  claude   p_118    butchr-epic-kan-203        butchr-epic-kan-203
  4017324  claude   p_120    butchr-epic-kan-59         butchr-epic-kan-59

  7 agent-runtime tree roots; pane get resolved 7/7; agent get resolved 7/7

CONTROL — the same resolver on each handle with one digit appended:  0/7 resolved

`agent get` is strictly narrower — the coverage cost of moving the join there:
  panes: 120   agent registrations: 18   panes with no registration: 102
  w653d4428991b51-1:  pane get -> OK  |  agent get -> UNRESOLVED (agent_not_found)
  w655e9455ae9491-2:  pane get -> OK  |  agent get -> OK            CONTROL, a registered pane
```

`AGENT_RUNTIME_COMMS` was read out of `src/launchers.ts` rather than assumed, so
the measurement and the daemon cannot disagree about what an agent is.

**The controls in this section are not decoration, and the evidence for that is
that they failed.** Two drafts of the survey script were wrong in ways nothing
else would have caught, because herdr puts its error JSON on **stderr** with a
non-zero exit and its `--help` text on **stderr with an exit of 0**:

* Draft 1 read stdout only, so `pane_not_found` and *"the command said nothing"*
  became the same empty string — and a **mutated handle scored as resolved**.
  The line above would have read `7/7` instead of `0/7`.
* Draft 2 joined both streams inside the error handler, which fixes the errors
  and not the help pages: §2.7 read both as absent while reporting that it had
  checked what they document.

Note which way each failed. **Draft 1 turned a real absence into a false
presence; draft 2 turned a real presence into a false absence.** An instrument
that cannot see produces the same shape as the finding you were hoping for,
which is the whole argument for pairing every probe with a control — and it
turned up inside the instrument written to make that argument.

### 2.6 `HERDR_PANE_ID` is the only identifier herdr puts in a pane

```
HERDR_* names in an agent runtime's environ:  HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH
  CONTROL, a name that must be absent:        HERDR_DEFINITELY_NOT_SET -> 0
```

No published-form identifier (`pane_id`, `terminal_id`, `workspace_id`) reaches a
process. **That is the gap in one sentence: herdr publishes `pane_id` in
`pane list` and puts `p_NNN` in the environment, and neither side carries the
other's form.**

### 2.7 Where the form is, and is not, documented

```
herdr pane --help    herdr pane get <pane_id>

herdr agent --help   targets accept terminal ids, unique agent names,
                     detected/reported agent labels, and legacy pane ids
```

**This is the sharpest statement of the dependency, and it is sharper than the
one KAN-385 was filed with.** `pane --help` documents the parameter as
`<pane_id>`, and `p_252` is not a `pane_id` — §2.1 and §2.4 show the two forms
are different and both accepted. The phrase that covers `p_NNN`, *"legacy pane
ids"*, appears only in `agent --help`'s target list. So the call our join makes
today passes a form that **the help for that subcommand does not list**.

### 2.8 What the join costs

```
herdr pane get <handle>    n=15  median 2 ms
herdr agent list           n=15  median 3 ms   (the census we already take)

cadence: COST_SAMPLE_INTERVAL_MS = 60_000 (src/daemon.ts) — one census plus one
`pane get` per agent-runtime tree, once a minute. 7 trees -> ~15 ms/min
(the figure moves between runs on a busy machine; the order is what matters).
```

**Order-of-ten milliseconds a minute is the whole of the efficiency argument,
and it is not an argument.** KAN-385 ranked the first ask partly on it removing
a `pane get` per tree; measured, that saving is negligible and should not be
offered as a reason. The ask stands entirely on the contract, which is what §3
leads with.

---

## 3. The proposal to herdr's maintainer

*The section below is written to be sent as it stands.*

> **Subject: a request — publish a pane's environment handle in `pane list`, and ideally a pid**
>
> We run CrabCast, a daemon that supervises a fleet of coding agents in herdr
> panes — 120 panes on the machine this was measured on, herdr 0.6.4. This is a
> feature request, not a bug report: everything described here works today.
>
> **What we do.** We measure what each agent costs the machine by grouping every
> process under its agent-runtime tree root and attributing the tree to a pane.
> The attribution runs from the process outward: we read `HERDR_PANE_ID` from
> `/proc/<pid>/environ`, then call `herdr pane get <that value>` and take the
> pane's `label`.
>
> **What we are asking for, ranked.**
>
> **1. Publish the environment handle as a field in `pane list` (and `pane get`,
> `agent list`, `agent get`).** The same token herdr puts in the pane's
> environment — `p_252` on our panes — as, say, `env_pane_id`.
>
> *Why this one first.* `pane list` publishes `pane_id` (`w65702dcc803d94-10`);
> the environment carries `p_252`; neither identifier appears on the other side.
> `herdr pane get` accepts both forms, which is what makes our join possible —
> but `herdr pane --help` documents the parameter as `<pane_id>`, and the phrase
> that covers the `p_NNN` form, *"legacy pane ids"*, appears only in
> `herdr agent --help`'s list of accepted targets. So we are relying on a
> subcommand accepting a target form its own help does not list. Publishing the
> handle would let us join on a field you document instead, and would collapse
> N lookups into the census read we already make. To be straight about the
> second half: we measured it at roughly 15 ms per minute of subprocess work
> across seven agent trees, so the efficiency is real and trivial. **The contract
> is the ask.**
>
> **2. A pid per pane — the ideal rather than the minimum.** No `pane list`,
> `pane get`, `agent list` or `agent get` record carries a pid, tty or any other
> process field (we probed all four; a control probe for `*_id` keys returns four
> matches on each, so the empty result is a reading and not a broken grep).
>
> *Why it is strictly better.* It would let us drop the environment leg
> altogether, **which is the only way to make the attribution unforgeable**. An
> environment variable is inherited by every process an agent spawns and can be
> set by anything that can `export`, so any process on the machine can claim to
> be one of ours. We bound that today with a floor on our own cost divisor rather
> than by preventing it. A pid comes from the kernel and cannot be claimed.
>
> **What we are not asking for.** We are not asking you to keep accepting
> `p_NNN` forever; that is a compatibility burden we would rather not put on you,
> and ask 1 is precisely the thing that would let us stop depending on it.
>
> **One piece of context about our end, so this is not a request you fill for a
> consumer who cannot use it.** CrabCast is currently pinned to herdr 0.6.x: the
> 0.7 redesign of `agent start` (`--kind`/`--pane`, no `--cwd`) breaks our spawn
> path, and our migration is not written yet. So a field shipped on the current
> line is something we would consume only when we move, not immediately. We are
> asking anyway, because ask 1 is small and the sooner it exists the sooner our
> join stops resting on an observed behaviour — but you should weigh it knowing
> the consumer is a version behind and says so.
>
> Happy to supply the measurements behind any of the above.

---

## 4. Our decision if the answer is no

Two options were on the table when KAN-385 was filed: **keep the dependence and
disclose it**, or **pin the behaviour with a check that fails loudly if
`pane get` stops accepting `p_NNN`**. The measurement produced a third, and the
decision takes the third.

### Decided: disclose it, do not put a herdr check in CI, and add the assertion to the release gate instead

**1. No new CI check.** This epic has established that nothing in our CI tests
software we do not own, and that reason holds here. But it is not the decisive
one — **the decisive one is that the risk a CI check would guard against cannot
reach us without a deliberate act we already gate.** `pane get` can only stop
accepting `p_NNN` in a herdr release we do not have. We are pinned to 0.6.4;
moving is tracked as KAN-182 and is qualified by `scripts/verify-herdr-release.mjs`
against a downloaded binary on a private socket. A CI check would therefore run
every PR to re-confirm a behaviour of a binary that is not going to change under
it, and its verdict would depend on whatever herdr the runner happened to have.
That is a check that is green for the wrong reason.

**2. The assertion belongs in `scripts/verify-herdr-release.mjs`, and this is not
the same thing as "testing software we do not own".** That script's entire
charter is to qualify one named herdr release against CrabCast's needs. Resolving
a pane handle *is* one of CrabCast's needs of herdr, and the script already
spawns a real pane on a private server, so the handle is available where it runs.
It is hand-run and not in CI, so this costs the required check set nothing and
fires exactly when the risk is real — at the moment somebody proposes a new
release.

That script's own *"WHAT IT DOES NOT COVER"* section already warns that it is a
lifecycle and not the product, and it is right: **a release that stopped
accepting `p_NNN` on `pane get` would pass it today, green, and the cost
attribution would silently attribute every tree to nobody.** That gap is now
named in the script's header. Writing the assertion needs a red drive against a
real release, which is a slice with its own proof, so it is filed rather than
smuggled in here: **KAN-386**, linked `Relates` to KAN-385.

**3. Disclose it where a reader of the join lands.** Not on a ticket, and not
only on this page: the two docblocks a reader of the join actually reads —
`PANE_HANDLE_VAR` in `src/agent-cost.ts` and `paneNameForHandle` in
`src/herdr.ts` — now say that the form is undocumented for `pane get` and point
here. Those are comment-only changes.

### Considered and not taken

* **Move the join from `pane get` to `agent get`.** Tempting, because
  `agent --help` *documents* that targets accept legacy pane ids, so the same
  call on the other subcommand would rest on a documented form — and it resolved
  7/7 of our trees today (§2.5). **Rejected for now because it is strictly
  narrower and the narrowing is invisible when it bites**: `agent get` resolves
  only registered agents (18 of 120 panes here; the other 102 answer
  `agent_not_found`, control in §2.5). An agent-runtime tree of ours in a pane
  herdr has not registered would resolve to nothing and drop out of the charged
  sample — which under-counts our own cost, in the direction that looks like a
  quiet fleet. We believe that state is unreachable, because CrabCast names every
  pane it spawns and a named pane is an `agent list` row; *believe* is doing work
  in that sentence, and it needs its own proof before it changes a divisor. It is
  the second option on KAN-386 and the argument for it is recorded here so it is
  not re-derived from scratch.
* **Do nothing and say nothing.** Rejected: the join's docblocks read as though
  the only caveat is that the handle is measured rather than assumed. It is not —
  the target form is also undocumented for the subcommand we pass it to, and a
  reader had no way to learn that from the code.

---

## 5. What this page does not cover

* **One machine, one herdr, one day.** Every reading is 0.6.4 on the development
  machine on 2026-08-13. Nothing here says what 0.6.10 does, and §2.7's
  documentation reading is of the help text those binaries print, not of any
  published contract.
* **It does not tell you whether the maintainer replied.** If the answer arrives,
  it belongs on KAN-385 and then here.
* **The forgeability in ask 2 is stated, not fixed.** Until a pid exists, the
  environment handle remains claimable by anything that can `export`, and the
  KAN-275 divisor floor is what makes that tolerable. That floor therefore stays,
  and the note saying so in `src/agent-cost.ts` is not superseded by this page.
