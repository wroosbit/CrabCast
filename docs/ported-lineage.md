# The ported lineage

Most of this daemon did not start here. It was extracted from another codebase
over five commits in August 2026, and the modules that came across still carry
decisions made before CrabCast existed — including some the extraction did not
notice it was carrying.

This document is the record of that. It is **a CrabCast document about
CrabCast's own history**, and it exists to answer exactly one question, asked at
exactly one moment:

> You are about to change a ported module. Is the behaviour you are changing
> something CrabCast decided, something it inherited, or something nobody has
> ever looked at?

## Read this when you edit a ported module. Not on a schedule.

KAN-209 asked whether ported-lineage divergence should be detected on a cadence
— a recurring job comparing this tree against the one it came from — and
decided **no**. The reasoning is on that ticket in full; two sentences of it
matter here.

**A cadence would not have found the defect that prompted the question.**
KAN-208 (a capacity gate bounded on the load average, which counts I/O wait as
if it were CPU) was found by someone who had recently fixed the same defect
elsewhere and recognised the shape. A diff of the two trees would have produced
hundreds of differences, nearly all of them intentional. The finding was never
"these differ"; it was "*this* difference is a defect, and I know that because I
have seen what it costs."

**And the interesting event is a decision, not a drift.** A clock fires when
nothing has happened. An edit fires exactly when the question is live. So the
trigger for this document is an edit to one of the modules in the table below.

### The rule this document must not break

> **Another tree may be evidence, never a specification.**

CrabCast decides its own behaviour. Nothing here creates an obligation to
justify differing from the source — a divergence needs no defence, and "we
decided to" is a complete answer. Where a row records a difference, it records
it as *CrabCast's history*, not as a deviation from an authority.

One structural reason that holds: **the extraction source is referenced at a
frozen commit, and a frozen commit cannot become a reference implementation,
because it does not move.** There is nothing to stay in sync with. The source
named below is a historical fact about where this code came from, in the same
way a commit date is.

## The boundary

**Extraction source:** `wroosbit/butchr`, path `daemon/src/`, at commit
`928743a` (2026-08-03), read-only. No change ever landed there.

**Owning story:** KAN-68 — *"Daemon core: extract Butchr's orchestration engine
behind config-declared workspace types"*, under epic KAN-59 (CrabCast).

**The port is five commits, not one:**

| Task | Commit | PR | What it brought |
|---|---|---|---|
| KAN-69 | `1723d09` | #2 | Daemon skeleton — config, types, IPC, registry, prompt, env, daemon spine |
| KAN-70 | `375080d` | #3 | herdr bridge, launchers, herdr-health, resume |
| KAN-73 | `05c6527` | #4 | MCP server |
| KAN-71 | `45288bb` | #5 | Capacity, agent cost, damping, priority/preemption |
| KAN-72 | `e659e93` | #6 | Durable agent registry, reconcile, nudge (partial) |

> **A correction to the record.** KAN-209 was filed saying the port happened "at
> KAN-71". KAN-71 is one of the five, and it is the one that brought capacity,
> priority and preemption — which is why it was the one remembered. Anything
> citing KAN-71 as *the* port anchor is citing a task for a story.

### The source tree accounts for exactly, with nothing left over

`daemon/src/` held **24 files** at `928743a`. Every one is accounted for:

**Ported (19):** `agent-cost-damping.ts`, `agent-cost.ts`, `agent-registry.ts`,
`capacity.ts`, `daemon.ts`, `env.ts`, `herdr-health.ts`, `herdr.ts`, `ipc.ts`,
`launchers.ts`, `mcp.ts`, `nudge.ts`, `priority.ts`, `prompt.ts`,
`reconcile.ts`, `registry.ts`, `resume.ts`, `router.ts`, `types.ts`

**Deliberately not ported (5):** `credentials.ts`, `jira.ts`, `native-host.ts`,
`staleness.ts`, `work-state.ts` — the consumer-specific half (tracker client,
browser native-messaging host, that consumer's notion of "work state").
KAN-68 named these; all five are absent from `src/` today, verified.

This is what makes the set knowable: it is not "roughly the orchestration
engine", it is a named file list against a named commit, and it closes.

**One deviation from the port plan, and it was deliberate.** KAN-68 listed
`nudge.ts` as *not* ported. KAN-72 ported its generic half anyway — delay,
suspend-proof `monotonicNow`, `waitForAgentReady`, `nudgeResumedAgent` — moving
the runtime-specific readiness markers behind `AgentLauncher` instead. The
commit calls this out as "the KAN-68 deviation". It is the only file whose
status differs from the plan.

### Not ported because it never existed there

`src/cli.ts`, `src/delivery.ts`, `src/events.ts`, `src/identity.ts`,
`src/machine-cpu.ts`, `src/provenance.ts`, `src/provisioning.ts` are CrabCast's
own. They are listed here only so a reader can tell "written here" from "came
across" without checking — the table below is the ported set, and these are not
in it.

## The inventory

"Divergence" counts commits touching the file after the port window closed
(`e659e93..HEAD`). **Every one of them carries a ticket key** — this repository
does not take untracked commits — so the deliberate/accidental question resolves
by reading the commit, and in this inventory it resolved the same way every
time: **no accidental divergence was found.** That is a finding about the commit
discipline, not a guarantee about the code.

| Module | Came in at | Δ since | Principal divergences | Deliberate? |
|---|---|---|---|---|
| `agent-cost.ts` | KAN-71 | **0** | none | — *never re-examined* |
| `agent-cost-damping.ts` | KAN-71 | **0** | none | — *never re-examined* |
| `env.ts` | KAN-69 | **0** | none | — *never re-examined* |
| `ipc.ts` | KAN-69 | 1 | KAN-88 hygiene | yes |
| `capacity.ts` | KAN-71 | 2 | KAN-124 re-key; **KAN-208** CPU bound replaces load average | yes |
| `priority.ts` | KAN-71 | 2 | KAN-124 re-key (type-priority → per-agent record, floor removed); KAN-128 events | yes |
| `types.ts` | KAN-69 | 2 | KAN-124 re-key; KAN-111 caller's directory | yes |
| `config.ts` | KAN-69 | 2 | KAN-93 CLI; KAN-124 re-key | yes |
| `resume.ts` | KAN-70 | 2 | KAN-111, KAN-124 | yes |
| `nudge.ts` | KAN-72 *(partial)* | 2 | KAN-114 delivery confirmation; KAN-124 | yes |
| `herdr-health.ts` | KAN-70 | 2 | KAN-102, KAN-181 herdr version verdict | yes |
| `launchers.ts` | KAN-70 | 4 | KAN-124, KAN-111, KAN-113, KAN-140 | yes |
| `reconcile.ts` | KAN-72 | 5 | KAN-136 re-attach, KAN-134, KAN-128, KAN-113, KAN-124 | yes |
| `daemon.ts` | KAN-69 | 9 | spine touched by most feature work | yes |
| `herdr.ts` | KAN-70 | 9 | KAN-136, KAN-125, KAN-114, KAN-113, KAN-140, … | yes |
| `agent-registry.ts` | KAN-72 | 10 | KAN-88, KAN-124, KAN-111, KAN-125, KAN-126, KAN-128, KAN-113, KAN-163, KAN-96 | yes |
| `mcp.ts` | KAN-73 | 18 | tracks every tool-surface change | yes |
| `router.ts` | KAN-69 | 24 | the most-changed file in the repository | yes |
| `registry.ts` | KAN-69 | **deleted** | KAN-124 deleted workspace types | yes |
| `prompt.ts` | KAN-69 | **deleted** | KAN-124 | yes |

**The largest single divergence is KAN-124** (*"T1 — an agent is a directory
plus a few knobs"*). It deleted the workspace-type concept the whole port was
organised around — `registry.ts` and `prompt.ts` with it — and re-keyed agents
onto filesystem paths. Ten of the nineteen ported modules were touched by that
one ticket. If a reader wonders why a ported module no longer resembles its
description in KAN-68, this is usually the answer.

## What these mechanisms were incidentally doing

**This is the section the inventory exists for**, and the reason a list of
stated purposes would have been no help.

KAN-208's load-average term was never *for* detecting I/O saturation. It was a
number that happened to move when I/O saturated, and every check asked only
whether it did what it *claimed* to do. Both projects that shipped this code
reviewed the change, ran proofs green and red, and missed it — because "does the
replacement do the old thing's stated job?" is the wrong question.

So: **what is this actually doing, not what is it for.**

### Verified — read against the code at `5153501`

**`capacity.ts` — the load average was an I/O-pressure signal nobody declared.**
Its stated job was bounding CPU headroom. It also, incidentally, refused
activations on a machine thrashing its disk, because uninterruptible sleep
counts toward Linux load. KAN-208 replaced the CPU-side bound with cores
actually in use and **kept the load term as a labelled fallback** — it still
binds where nothing has measured CPU, and is still printed on every line. The
incidental coverage was preserved knowingly; the decision record is in
`capacity.ts` beside the code. *This entry is the template for the rest.*

**`agent-cost.ts` — editing the launcher table silently moves the capacity
divisor.** Its stated job is measuring what one agent costs. It decides what
counts as an agent by importing `AGENT_RUNTIME_COMMS` from `launchers.ts`, so
the sampler and the spawner cannot disagree — which is the point, and is
documented. The under-declared consequence: **`launchers.ts` reads like a
spawn-time concern, and adding a runtime name to that table changes what
capacity measures across the whole fleet.** A `shell` agent starts no runtime
and is therefore invisible to the sampler; a fleet of only `shell` agents
measures nothing, and capacity falls back to its labelled seed.

**`agent-cost-damping.ts` — `MIN_MEASURED_CORES` is a divide-by-zero guard
wearing a damping constant's clothes.** Its stated job is asymmetric EWMA
smoothing. The 0.001 floor is not about smoothing at all: the daemon publishes
the estimate rounded to three decimals, an idle fleet can measure below 0.0005,
and a zero divisor turns `capByCpu` and `headroomByLoad` into `Infinity` —
disabling the CPU dimension while the report prints `÷ 0 core/agent`. This is
stated in the file. It is recorded here because **the guard lives in the damping
module and protects arithmetic in a different one**, which is exactly the shape
that gets dropped in a rewrite.

**`priority.ts` — the removed floor is safe only because of a rule kept
elsewhere.** The source had `WorkspaceRegistry.priorityFor` return the lowest
declared priority for an unregistered type, so a resolution failure could not
kill another agent's work. KAN-124 deleted it. That is safe **because `priority`
is a required `configure` parameter and an agent with no record cannot be
activated at all** — a precondition held in the router and the registry, not
here. Making priority optional anywhere would silently restore the failure the
floor existed to contain, and nothing would report it.

### Unverified — explicitly, rather than omitted

The remaining fifteen ported modules **have not had this analysis done.** Their
rows in the table above are real (the commit counts and ticket keys are read
from git); their incidental behaviour is **unknown, not empty**.

Unanalysed: `agent-registry.ts`, `config.ts`, `daemon.ts`, `env.ts`,
`herdr-health.ts`, `herdr.ts`, `ipc.ts`, `launchers.ts`, `mcp.ts`, `nudge.ts`,
`prompt.ts` *(deleted)*, `reconcile.ts`, `registry.ts` *(deleted)*,
`resume.ts`, `router.ts`, `types.ts`.

**`router.ts`, `mcp.ts` and `agent-registry.ts` are the ones to do next** — they
are the three most-changed ported modules, which means the most opportunity for
a mechanism to have quietly acquired a second job.

**Three modules have not been touched since the day they arrived** —
`agent-cost.ts`, `agent-cost-damping.ts`, `env.ts`. Untouched is not verified.
It means **unexamined**: no ticket has ever had reason to read them closely, so
whatever they are incidentally doing has never been stated by anyone.

## Where the extraction source is named

Twelve ported modules refer to *"the extraction source"* — 25 times — and until
this document existed **the tree never said what it was or at what commit.**
Those headers also cite ticket keys (KAN-21, KAN-24, KAN-34, KAN-36, KAN-41,
KAN-44, KAN-54, KAN-56) that are **not CrabCast tickets**: they belong to epic
KAN-39 (Butchr) in the same Jira project. They resolve correctly only because
the two projects share a tracker. This document is the referent for that phrase.

## What this document is not

It is **not a proof**, and nothing here is enforced. No check fails when it goes
stale, and it can be wrong without anything going red. It carries no entry in
the proof registry and adds nothing to the CI array, deliberately — it is a
document, and dressing it as a gate would be the claim-outrunning-its-mechanism
failure this repository keeps finding.

A guard — something that fails when a ported module is edited without this
being consulted — was **proposed on KAN-209 and not built**. It is a governance
mechanism, and that decision belongs to the epic. The honest difficulty is
stated there: "consulted" is not a thing a check can observe, so any such guard
would in practice assert that a *file* changed, which is not the same claim.
