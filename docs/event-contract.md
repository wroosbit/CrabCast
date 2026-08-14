# The CrabCast event contract

CrabCast announces fleet changes to every connected client. This document is
what a consumer builds against. Its executable half is `src/events.ts`, which
both the daemon and the MCP server import — the table below and the allowlist
in that file are the same table, and the MCP forwarder enforces it field by
field, so the two cannot drift apart quietly.

Before this contract existed the surface was an internal convention: the daemon
broadcast whatever action name the emitting site happened to write, and the MCP
forwarder decided what to pass on by testing whether the name ended in
`_event`. Reading an internal broadcast over somebody's shoulder is not
something a consumer can build on, and both halves of that arrangement failed
the way conventions fail — silently.

---

## 1. The events

**Nine.** The arithmetic is worth stating because the ticket that commissioned
this work says ten: "ten" counted *broadcast sites* at `59ba420` (deactivated
alone had three), not distinct event names. Against `main` before this change
there were nine names at eleven sites; this change removes one name
(`agent_preempted_event`, merged) and adds one (`agent.status_changed`). Nine
names, and the design's own contract table has nine rows. Nothing was dropped.

Every event carries the envelope — `action`, `at`, `seq`, `bootId` — plus the
payload below.

| event | was | fires | payload |
| --- | --- | --- | --- |
| `agent.configured` | `agent_configured_event` **(breaking)** | `configure` accepted. The record write is **attempted before this is sent and reported in `durable`** — it is not asserted | `path`, `config`, `configVersion`, `configuredAt`, `changed[]`, `outcomes`, `durable`; `durabilityError` when `durable` is false |
| `agent.activated` | `agent_activated_event` **(breaking)** | an activation confirmed against herdr's census — a fresh spawn, or this daemon re-taking the terminal of an agent that outlived it | `path`, `paneName`, `paneId`, `sessionId`, `status`, `configVersion`, `durable`; `durabilityError` when `durable` is false |
| `agent.deactivated` | `agent_deactivated_event` **(breaking)**, with `agent_preempted_event` **merged in** | a stand-down confirmed | `path`, `reason` (`requested` \| `preempted`), `durable`; `paneName`, `sessionId`, `preemption` when they exist; `durabilityError` when `durable` is false |
| `agent.forgotten` | `agent_forgotten_event` **(breaking)** | `forget` accepted | `path`, `removed[]` |
| `agent.status_changed` | — **(new)** | the fleet sweep observed a different herdr status than it last observed | `path`, `paneName`, `paneId`, `from`, `to` |
| `agent.lost` | `agent_lost_event` **(breaking)** | an agent the registry records as active has no live agent in its directory | `path`, `paneName`, `label`, `config`, `configVersion`, `configuredAt`, `everActivated`, `activatedBy`, `since`, `reason` |
| `agent.detached` | `agent_detached_event` **(breaking)** | a PTY this daemon held died | `path`, `paneName`, `sessionId`, `reason`, `exitCode` |
| `capacity.overridden` | `capacity_override_event` **(breaking)** | an activation started past the capacity gate on an explicit override | `what`, `capacity` — **no `path`** |
| `registry.degraded` | `registry_degraded_event` **(breaking)** | a durable registry write failed | `what`, `error`, `consequence` — **no `path`** |

`agent_reset_event` is **gone**, removed with the `reset` verb in T1 (KAN-124).

### Two payload notes a renderer must not get wrong

**`capacity.overridden` and `registry.degraded` carry no `path`.** Their subject
is the machine and the daemon respectively, and it is named by `what`. A
renderer that assumes `path` on every event prints `undefined` on these two —
which is precisely what the retired MCP format string did, for three of the
events, before this change.

**`agent.lost` names its evidence `reason`, not `evidence`.** The design table
called the field `evidence`; the shipped name is `reason`, because these rows
are the same objects `list_agents` publishes under `missingAgents` and renaming
the field there would break a read that shipped in T3 for cosmetic gain. It is
prose explaining why the daemon says the agent is absent. `agent.deactivated`'s
`reason` is a different field on a different event and takes one of two words.

### `durable` on the three lifecycle events, and why it is never absent

`agent.configured`, `agent.activated` and `agent.deactivated` sit on the durable
write path, and **all three carry `durable`, always, both values.**

> **`durable: true`** — the daemon's durable record agrees with this event. A
> restart will see what this event describes.
>
> **`durable: false`** — the operation happened and the registry write did not.
> The event is true about the world; **the disk does not know it**, and a
> restart will not. `durabilityError` carries the reason, and a
> `registry.degraded` also fires.

That sentence is deliberately about the relationship between **this event and
the record**, not about this daemon or this transport. If these events are ever
carried somewhere else, it is already true there.

**Read `durable: false` as work that is live and unrecorded**, and the three
events say three different things by it: a configuration this daemon will honour
and the next one will not have; an agent that is running, verified, and outside
the set a restart restores; a stand-down that a restart will try to undo. In all
three the daemon is telling you the truth about a gap it cannot close on its own
— re-issuing the operation once the data directory is writable is what closes
it, and for `agent.activated` specifically, calling `activate` again is the
documented repair (it converges the record and answers `recordReconciled: true`).

**Why it is required rather than present-only-on-failure.** Reading durability
out of an *absence* is the defect this field exists to remove, not a shorter way
to spell it. An absent `durable` is already produced for two reasons that have
nothing to do with a successful write: a daemon of an older vintage that never
published the field — which you *will* meet, because §2's `bootId` exists
precisely for the reconnect where the daemon on the other end is not the one you
were talking to — and the MCP projection, which carries exactly the fields this
section declares and drops anything it does not. So it is on every one of these
events, `true` or `false`, and never inferred.

**The responses are asymmetric with this, on purpose.** `configure_response`,
`activate_response` and `deactivate_response` still carry `durable: false` only
when the write failed. A response answers a call you can simply make again, so
an absence there is recoverable by asking; an event is **at-most-once with no
second copy and no way to re-request it** (§2), so an absence on the wire cannot
be allowed to mean anything. The two surfaces now *agree on the answer* — which
is the property that was missing — without being obliged to agree on the shape.

Historically this is one defect, found twice. KAN-72 recorded it against the
response surface: *"the durable record and the response must agree; a swallowed
registry write behind `verified: true` is restart-amnesia re-entering through the
error path."* The event path was built afterwards and did not inherit it — the
events fired identically whether or not the write landed, while this table's own
sentence for `agent.configured` said "and the record written". KAN-165 ported the
lesson rather than the line, which is why all three events changed and not the
one a consumer happened to be reading.

**`registry.degraded` is not a substitute for this field, and that is why this
field exists.** It fires on the same failure, but it deliberately carries no
`path` — only `what`, which is free prose like `configured /home/you/svc` — and
ordering is total *per path* (§2), which puts this event on no path at all.
Correlating a degradation back to the operation it invalidates therefore means
parsing prose and assuming an ordering this document explicitly does not promise.
`registry.degraded` remains the machine-level alarm: something is wrong with the
data directory. `durable` is the per-operation answer.

### `agent.configured`'s `changed` and `outcomes`

`changed` is the attribute names this `configure` moved — the whole set on a
first configure, the diff on a reconfiguration. `outcomes` is every knob with
what this call did to it: `unchanged`, `applied`, `applied-in-place`,
`withheld`, or `refused-restart-required`. Together they are why a reconciler
diffing per path does not have to re-read after seeing this event to find out
whether it touched anything it cares about.

Both were added by the reconfiguration slice and were **not** in this table
until the drift check caught them — declared nowhere, they were reaching socket
subscribers and being dropped on the MCP path, which is the asymmetry §4 exists
to make legible. Named here now, and required rather than optional, because the
emitting site sends both unconditionally.

### `agent.deactivated`'s `reason` is NOT optional, and this is the one to read twice

`reason` is on **every** `agent.deactivated`, always, and takes exactly one of
`requested` or `preempted`. It is not a flag that appears when true and it is
never absent.

That matters more here than it would elsewhere, because of what this merge did.
`agent_preempted_event` used to be its own event: the distinction lived in the
event **name**, where it could not be dropped. Merging it into
`agent.deactivated` moved that distinction into a **field**, where it can. And
the two are not shades of the same thing — in the consumer's words:

> **preempted means the machine took this and owes it back.**

A subscriber that keeps preempted and standby as distinct states — which is the
correct thing to do, because one is a debt somebody owes and the other is a
decision somebody made — distinguishes them **by this field alone**. An absent
`reason` would not fail loudly at such a subscriber; it would quietly render
work the machine seized as work someone chose to switch off. So: not optional,
declared required in `src/events.ts`, and `verify-event-contract.mjs` audits
every emission site statically rather than trusting the sites it happens to
exercise.

### `agent.deactivated`'s `preemption` block

Present exactly when `reason === 'preempted'`. It carries everything the
retired `agent_preempted_event` carried:

```json
{
  "at": "2026-08-04T06:11:03.114Z",
  "by": { "path": "…/hotfix", "paneName": "crabcast-hotfix-…", "priority": 2 },
  "priority": 1,
  "herdrStatus": "idle",
  "derivation": "cap: 3 … (the capacity arithmetic that made the slot necessary)",
  "capacity": { "…": "the full capacity report at the moment of the decision" }
}
```

The victim is the event's own `path`. The old pair named the same agent twice —
`victim.path` on one event and `path` on the other — and left a subscriber to
correlate two frames describing one stand-down.

---

## 2. Delivery guarantees

### Ordering

**Total per path. Not guaranteed across paths.** A global sequencer is not
something this daemon has, and Butchr has confirmed (KAN-59 comment 10548) that
they reconcile per agent and never across, so per-path is the granularity that
is actually consumed. `seq` happens to be globally monotonic today because
there is one broadcaster; **do not build on that** — it is an implementation
detail of having one process, and the contract promises the weaker property.

### Delivery: at-most-once, best-effort, no buffering, no replay

Events go to whoever is connected when they are emitted. A subscriber that is
disconnected, slow, or not yet started misses them and they are not kept.
Buffering means unbounded memory for a subscriber that went away; a replay log
is a second durable store beside the registry. This is weaker than at-least-once
and it is stated rather than implied.

### **The obligation this places on you.** Read this one twice.

> Events are a **latency optimisation over an authoritative poll**. A
> subscriber that does not independently poll `list` on a timer **is not
> entitled to the convergence property**. For a subscriber that does poll, a
> missed event costs slower convergence. For a subscriber with no timer, it
> costs **correctness** — divergence that persists until something unrelated
> happens to wake it.

This is written as an obligation you take on, not as a property CrabCast
provides, because the true statement is joint and the daemon cannot make it
alone. An earlier version of this argument made the opposite claim:

<!-- refuted-claim:start
     A REJECTED CLAIM, QUOTED SO IT STAYS REJECTED. `verify-event-contract.mjs`
     strips this region before scanning the document for unilateral-guarantee
     phrasing, and scans everything outside it. Nothing normative may live in
     here, and the check caps its length so it cannot become a hiding place. -->
> "A missed event degrades to slower convergence, never to divergence — that
> property is provable on our side and does not depend on your reconciler."
<!-- refuted-claim:end -->

**That was false**, and Butchr was right to correct it. It holds only if the
consumer polls. A consumer that treats events as its *trigger* — reconciling on
event, plus on start, plus on config change, which is a perfectly natural
reading — has no timer at all, and for that consumer a dropped event is
permanent divergence. Written the old way, a consumer could satisfy this
contract in full and still diverge.

So: **an authoritative `list` sweep on a timer is a correctness requirement for
any consumer of these events, not a nicety.**

### The poll we just made a correctness requirement is PAGED. Read this beside the clause above — they were shipped apart, and that was the bug

`list_agents` does not return whole categories by default. Five of them are
**newest-first and carry 25 rows a page**:

| paged | not paged |
| --- | --- |
| `missingAgents`, `preemptedAgents`, `standbyAgents`, `unstartedAgents`, `foreignPanes` | `agents`, `unbackedPanes` — built from the herdr census, bounded by what is running, complete in every response |

**Newest-first means the row that falls off has been waiting longest.** For a
level-triggered reconciler — which is what the clause above instructs you to
build — that is not slower convergence, it is **starvation of precisely the
wrong rows**: an agent switched off long enough becomes permanently invisible
to the thing responsible for restoring it, while every poll looks healthy.
Butchr measured it on their real fleet: **89 standby agents, 25 returned, 72%
invisible.**

**The remedy, in the same breath as the requirement.** Every response carries a
`pages` block, one entry per paged category:

```json
"pages": {
  "standbyAgents": { "returned": 25, "total": 89, "limit": 25, "remaining": 64,
                     "nextCursor": "eyJ3IjoiMjAyNi0…" }
}
```

Pass that cursor back to get the next page, and keep going **until
`nextCursor` is null**:

```json
{ "action": "list_agents", "pages": { "standbyAgents": { "after": "eyJ3IjoiMjAyNi0…" } } }
```

* On the CLI: `crabcast list --category standbyAgents --after <cursor>`. A
  truncated category prints its own next command under its heading.
* On MCP: `crabcast_list_agents` takes `category`, `after` and `limit`.
* `limit` is 1–200 and defaults to 25. **It is not the mechanism.** A bigger
  page moves the cliff; the cursor is what removes it, at any page size.

Four things that are contract rather than advice, because each is a way to
believe you have a whole category when you do not:

1. **`nextCursor === null` is the only "you have everything" signal.**
   `returned < limit` is not — a page can land short. Neither is
   `returned === total`: `total` is the size of the category, and a cursored
   page is a window into it rather than a prefix of it.
2. **`*Total` was never a remedy.** `standbyTotal` says how many rows are
   missing and never which, and it is still there for the same reason it always
   was: so a reader can see the size of what one page left out.
3. **The cursor is opaque and is a POSITION, not a row id.** Pass it back
   unchanged. A row vanishing between pages — an agent switched back on —
   shifts nothing, because the next page resumes from the sort key rather than
   from an index. An invented or corrupted cursor is **refused**, not answered
   from the beginning: a cursor that silently reset would turn an enumeration
   into a loop over its first page, which is this defect wearing a new coat.
4. **A page walk is not a transaction.** Each page is answered from its own
   read of the registry and its own census. A row created while you page can
   arrive ahead of your cursor and be missed by *this* walk, and a row whose
   timestamp moves can repeat. That is what the timer is for: the next sweep
   sees it. Reconcile on the union of what you observe, not on the assumption
   that one walk is a snapshot.

**For the record, since it is the whole reason this section exists:** the clip
shipped, and this document described the poll as a correctness requirement
without mentioning it. Each sentence was true; the composition was false — we
told a consumer that polling `list` is what makes them correct, and `list` did
not return the fleet. `scripts/verify-fleet-enumeration.mjs` is where the fix
is proven, and it asserts this section names the limit, so the number above and
`FLEET_CATEGORY_LIMIT` in `src/router.ts` cannot drift apart quietly.

### The `config` on that poll is declared by the same list the events are, and this surface REPORTS where the event path DROPS

Read this beside §4, which says the same thing about the other surface. They
were **one day apart**, and that gap is the reason this subsection exists rather
than a footnote in §4.

`list_agents` echoes each agent's frozen `config` on **every** row of **every**
category — the block `verify-state-read-echoes-config.mjs` exists for, and the
whole reason a consumer does not have to keep a shadow copy of what it asked
for. It is the same `AgentConfig` object §1 publishes on `agent.configured` and
`agent.lost`. KAN-164 made the MCP event projection walk that object's interior;
for one day the poll response carried it unexamined, which put **the half you
are told to depend on for correctness** on the wrong side of the guard.

**One declaration, both surfaces.** `CONFIG_FIELDS` in `src/events.ts` is the
only list of what an `AgentConfig` contains, and both paths import it. A knob
added there is honoured by the event projection and by the poll sweep with no
second edit, and a knob added to `AgentConfig` without a line there does not
compile.

**What the two surfaces do with an undeclared field is deliberately different,
and the response says which you are reading:**

| | an undeclared field inside `config` |
| --- | --- |
| **MCP event notification** | **dropped** before it leaves, and named in the daemon's own log by its path |
| **`list_agents` response** | **reported and still delivered.** `configEchoContract.drops` is `false` |
| **`agent_status` response** | **the same**: reported by path, still delivered, `drops` is `false` (KAN-168) |

```json
"configEchoContract": {
  "declared": ["priority", "refusable", "chargeable", "preemptable", "launcher", "prompt", "mcpServers", "label"],
  "verbatim": ["mcpServers"],
  "drops": false,
  "undeclared": ["standbyAgents[2].config.telemetry"],
  "note": "…"
}
```

Three reasons the poll path reports rather than drops, stated because a surface
behaving one way while a sentence implies another is the failure this project
keeps filing:

1. **The echo promises the durable record verbatim.** Dropping part of it would
   make the echo a *projection* of the record while still calling itself the
   record — the drift detector becoming the drift, which is the exact failure
   the echo was built to remove.
2. **A response can be asked again; an event cannot.** An event is at-most-once
   with no second copy, so what is not on that wire is gone — which is why the
   projection there is safe. This is the same asymmetry §1 draws for `durable`.
3. **`list` is the authoritative read.** If it dropped fields it would carry
   *less* than the latency optimisation over it, inverting the relationship this
   whole document rests on.

Four things that are contract rather than advice:

* **`undeclared: []` means the sweep ran and found nothing.** The block is on
  every response, empty or not, so "nothing was there" and "nobody looked" are
  distinguishable — which they are not from an absent field.
* **An absent `configEchoContract` is an older daemon**, not a clean one. §2's
  `bootId` exists because you *will* meet daemons of different vintages.
* **`verbatim` names what the sweep does not examine.** Today that is
  `mcpServers` alone, and for the reason §4 gives: its keys and values are your
  own bytes, written into `.mcp.json` verbatim and never read by this daemon. An
  undeclared key in there is not drift and is not reported.
* **Do not key behaviour off an undeclared field**, exactly as §4 says for the
  socket. It is an internal value that has not been designed for you and can
  change or vanish without this document changing.

**Both read surfaces, one declaration.** `crabcast_agent_status` echoes the same
`config` for one agent, through the same function, and carries the same
`configEchoContract` built from the same `CONFIG_FIELDS` — no second list of
knobs exists anywhere (KAN-168). Its paths are relative to the one row it
answers about (`config.telemetry`) where `list_agents`'s name the row
(`standbyAgents[2].config.telemetry`).

**The block rides every response on both surfaces, refusals included** — so
"nothing was there" and "nobody looked" stay distinguishable, which is the whole
of what it is for. Every branch of both handlers answers through one swept
responder per handler, which is what makes that a property of the handler rather
than of call sites that happen to agree today.

Two corrections are worth carrying, because this sentence has been wrong in both
directions. Until KAN-168 this paragraph said the opposite, and the asymmetry it
recorded was real: the guard was on the fleet read and absent from the
single-agent read from KAN-166 (#29, 2026-08-04) until KAN-168 closed it. Until
KAN-279 it named only `agent_status`'s refusals, and a **refused `list_agents`**
carried no block at all — its two refusal paths returned before the sweep. The
justification on record was that a refusal carries no echo, so there is nothing
for the block to be about; that was true of `agent_status`'s `no-record-no-pane`
branch and **false of its `bad-address` branch**, which resolves nothing, carries
no echo and carried the block anyway. The surfaces were never divided by whether
an echo was present, and read-contract version 9 made this sentence true of both.

**What is still NOT covered, said here rather than left to be found.**
`list_agents`'s other blocks (`capacity`, `provenance`, `pages`, the `*Total`s)
are not swept: they are contract by this document and by their own proofs, not
by a declared-field check. The same is true of everything on an `agent_status`
response outside the echo. Both surfaces are proven in
`scripts/verify-config-echo-contract.mjs`.

### Across a daemon restart

Subscriptions die with the socket and nothing is replayed. The signal is
**`bootId`**: a per-boot identifier on every event, and — so a reconnecting
subscriber does not have to wait for an event that may not come for an hour —
on the `list_agents` and `daemon_status` responses as well, alongside
`eventSeq`, the highest sequence number stamped so far.

The resync path, in full:

1. Reconnect.
2. Call `list_agents`. Compare its `bootId` to the last one you saw.
3. A **different** `bootId` means a different daemon boot: your `seq` watermark
   is meaningless and the state in that response is your new baseline.
4. The **same** `bootId` with `eventSeq` ahead of your last `seq` means you
   missed events. The same response is again your new baseline.

`list_agents` is authoritative and every row carries `configVersion`, which is
what makes the resync cheap: you can tell in one round trip whether the
configuration you are looking at is the one you wrote.

One consequence worth stating because it looks like a bug otherwise: the
missing-agent latch (`announcedMissing`) is in-memory, so a restart
**re-announces** agents that are still missing. That is consistent with
at-most-once and with the resync above.

#### How long has it been down? That is yours to keep, and here is why

`agent.lost` is latched per path and carries the envelope's `at`, so **the
moment this daemon first observed a loss is published exactly once, with a time
on it.** It is not *stored*. The `since` on the row — and on the matching
`missingAgents` row from the poll — is when the agent was last recorded
**activated**, not when it went. Nothing here records the second, and
**KAN-189 decided that nothing will**: the reasoning is on `MissingAgent.since`
in `src/router.ts`, and the short version is that a durable copy of an
observation would be this daemon claiming a duration it was not watching for,
and would be the replay log this section declines, narrowed to one field.

So if you want down-time, keep the first `at` you saw for a path (or the first
poll it appeared in) and clear it when the path leaves the category. You are
already required to poll on a timer, so you have both halves.

**The part of this that is a real cost, stated rather than implied:** a
subscriber that connects to a daemon which has been running for a week cannot
find out how old an already-missing agent is. The daemon observed it and does
not say. If that bites you, say so on the epic — the remedy is a decision made
with you, not a field added quietly.

### Latency

| event | bound |
| --- | --- |
| `agent.configured`, `agent.activated`, `agent.deactivated`, `agent.forgotten`, `capacity.overridden`, `registry.degraded` | immediate — emitted synchronously with the operation |
| `agent.detached` | immediate — the PTY's own exit |
| `agent.lost` | **≤ 30 s** plus one census read (the fleet sweep) |
| `agent.status_changed` | **≤ 30 s** plus one census read (the same sweep) |

---

## 3. `agent.status_changed`, in detail

The one event Butchr needs that did not exist. The design specified the event
and left the detection mechanism to this slice; here is the decision, so a
consumer can test against a number rather than against a promise.

**Mechanism: a poll, on the fleet sweep that already runs.** Every 30 seconds
the daemon takes one herdr census to find agents that have gone missing. That
same census now also answers "what is each live agent doing", and the daemon
compares it against the last status it observed for that path. A change is
broadcast.

**Cost: zero additional herdr invocations.** That is why the cadence is the
sweep's rather than a second one of its own. Butchr has said (KAN-59 comment
10548) that nothing in their supervision model needs sub-poll latency to be
*correct*; if a human watching a UI ever needs seconds, that is solved by
polling `agent_status` harder on their side, not by CrabCast pushing faster.

**What that buys, and what it does not:**

* A transition is reported **within 30 seconds plus one census read**.
* **A transition that occurs and reverses inside one sweep window is not
  reported at all.** `working → blocked → working` between two ticks looks
  identical to no change. This is inherent to polling, and it is contract
  rather than a caveat: `agent.status_changed` tells you the status is
  different from the last one you were told about, never that it took a
  particular route to get there.

  The consumer was asked whether this needed a different mechanism and declined,
  with a better reason than the one offered: their reconciler compares desired
  against actual **as observed now**, so a flap that resolved itself changed
  neither — and for supervision, not being woken about a child that unblocked
  itself in thirty seconds is a filter rather than a gap.

  **The sharper form of this limit, which is worth knowing before it bites: an
  agent flapping faster than the sample rate looks like it is steadily working,
  forever.** Not "you miss one transition" — you get a steady reading that is
  never true. That is a property of sampling rather than of this design, and any
  poll on any timer has it identically; catching it would need something
  watching *progress* rather than *status*, which this daemon does not do and
  does not claim to.
* **A first sighting is not a transition.** A freshly activated agent, or one
  that came back after disappearing, seeds the daemon's memory silently. There
  is no `from` that anybody observed, and inventing one would be a claim about
  a change nobody watched.
* **Silence is not a status.** When herdr does not answer, its census comes
  back empty and every row this daemon still reports from its own session map
  reads `herdrStatus: 'unknown'`. Publishing that as a transition would
  broadcast `working → unknown` for the whole fleet on any herdr blip, and the
  reverse when it recovered — events describing CrabCast's blindness as the
  agents' behaviour. So when the census does not answer, **nothing is
  compared, nothing is recorded and nothing is announced**. A status of
  `unknown` from a herdr that *did* answer is a real observation and is
  published as one.
* **A daemon restart forgets the last-observed statuses**, so the first sweep
  after a boot reports no transitions. A subscriber crossing that restart is
  told to resync by the new `bootId`.

Statuses are herdr's vocabulary: `idle`, `working`, `blocked`, `done`,
`unknown`.

### The same observation, readable without subscribing: `statusSince`

**This adds no event.** The sweep above already knows *when* it saw a status
change and used to throw that away, so the moment is now kept beside the status
and published as `statusSince` on every row in `list_agents`' `agents` — the
same memory the event is derived from, read twice rather than computed twice.
Nothing about the nine events changes.

It exists because `herdrStatus` alone cannot answer the question a supervisor
actually has. An agent that has finished its work and is waiting for you and an
agent wedged at a prompt nobody will answer both read `idle`, and until KAN-200
nothing this daemon published separated them; two agents sat at their runtime's
usage-limit dialog for hours looking exactly like agents that were done.

Five things about it, and each is the same rule this section already applies to
the event:

* **It is a fact, not a diagnosis.** CrabCast will never say "stuck". It does
  not know what your runtime's dialogs are, and learning one runtime's screen
  vocabulary would rot the first time that tool changed a word. "Idle since four
  hours ago, and I know that agent has work outstanding" is your judgement, from
  this field plus what only you know.
* **`null` is an answer.** It means this daemon has not observed that agent's
  status change — true of every agent on a freshly started daemon, of one whose
  status changed between the last sweep and your call, and of one that has just
  come back after disappearing. It is the same "a first sighting is not a
  transition" rule above, seen from the row.
* **It does not survive a restart**, for the reason the last bullet above gives
  and the reason KAN-189 gave for down-time: it is a fact about *this process's
  watching*, and a value read back off disk would describe a gap in which
  nothing was watching. If you need a window longer than one daemon's life,
  keep your own — the same answer this document already gives for how long an
  agent has been missing (§1).
* **And it is dark exactly when you most want it** — the sentence above says
  *that* you lose the value, this one says *when*, and they are not the same
  thing to a reader. A daemon comes back at the same moment its fleet does,
  after a crash, a reboot or a power cut, and that is precisely when agents come
  back in states nobody watched them enter: alive, reported healthy, and sitting
  at a screen they will sit at indefinitely. So the field is null across the
  whole fleet in the very window where the condition it exists to expose is most
  likely. **The loss is correlated with the thing you are detecting, not
  independent of it.** Nothing here is going to change that — it is what an
  in-memory observation is — so a consumer that needs to see across a restart
  keeps its own first-seen-in-this-status record, and treats a page of nulls as
  "this daemon is new" rather than as "this fleet just started work".
* **It is not a heartbeat or a liveness probe.** It says nothing about whether
  an agent is healthy, and an agent quietly waiting on a human is
  indistinguishable from one that is wedged. That is deliberate: telling them
  apart means interpreting a screen, which is how a confident wrong answer gets
  produced.

The response's `provenance` block files it under a fourth bucket, `remembered` —
not `observed`, which promises a value read from herdr for *that* response.

---

## 4. Something you do not recognise — an action, or a field

**On the socket:** the daemon emits only the names in §1, and **a subscriber
receiving an unrecognised action must ignore it and must not error.** That
clause is what makes adding an event later a non-breaking change, so it is part
of the contract rather than advice. `broadcast` filters nothing; matching is
yours.

**The same clause covers unrecognised FIELDS, and on the socket you need it.**
The two paths are deliberately asymmetric about payloads, and a consumer with
no fallback must not be left to assume whichever suits them:

| | what the payload contains |
| --- | --- |
| **socket** | **AT LEAST** the fields §1 declares. `broadcast` filters nothing, so a field this daemon happens to carry internally reaches you — at any depth, including inside a composite. |
| **MCP** | **EXACTLY** the fields §1 declares, **at every depth**. The forwarder projects recursively; anything undeclared is dropped before it leaves, whether it is a field of the event or a field inside `config`, `outcomes`, `preemption`, `capacity`, `changed[]` or `removed[]`. **One region is exempt and named below: the values of `config.mcpServers`.** |

So, as contract: **a socket subscriber receiving a field §1 does not declare
must ignore it and must not error**, exactly as it must for an unrecognised
action. Do not key behaviour off an undeclared field — it is an internal value
that has not been designed for you, and it can change or vanish without any of
this document changing.

### How deep "undeclared" goes, and the one place it stops

**This paragraph used to be one unqualified sentence, and it was true only at
depth 1** — the forwarder copied a declared field's *value* wholesale, so the
interior of every composite travelled unprojected *and* unreported. A field
added inside `config` reached an MCP subscriber and did not appear in the drift
warning that exists to catch exactly that (KAN-164). The claim was broader than
the mechanism under it.

The mechanism was widened rather than the sentence narrowed, because `config`'s
interior is what a consumer diffs to detect configuration drift and shrinking
the guarantee there would have been shrinking the useful half. So `src/events.ts`
now declares the interior of every composite field — every knob of `config`, the
same key set for `outcomes`, `preemption` and its nested `by` and `capacity`
blocks, the full capacity report, and the element type of `changed[]` and
`removed[]` — and the projection walks all of it. Concretely, on the MCP path:

* a field added **inside a composite** is dropped and reported by its path
  (`config.telemetryToken`), exactly as a top-level one is reported by its name;
* a declared field that grows an interior nobody wrote down is **also** dropped
  and reported, rather than silently reacquiring the old pass-through — the
  default for a declared field is "no interior", and forgetting is loud;
* `config` and `capacity` are held to their producing code **at compile time**,
  in both directions, so a knob added to `AgentConfig` or a field added to the
  capacity report fails the build rather than the wire.

**The exemption, stated rather than left to be found: the `config.mcpServers`
map travels whole — both the server names and the definitions under them.**
They are the caller's own bytes, written into `.mcp.json` verbatim, and CrabCast
promises never to read, validate, resolve or reorder them; there is nothing
there for this contract to declare, and declaring it would be this daemon
claiming to know a shape it has promised not to look at. So an undeclared key
inside `config.mcpServers` **is delivered**. That is the whole of the exception:
one field, for that reason. `verify-event-contract.mjs` §7 asserts it arrives,
beside the field it asserts is dropped, so the hole is observable rather than
only described.

Nothing changed on the socket. `broadcast` still filters nothing at any depth,
which is why the must-ignore clause above is contract rather than advice.

**There is a third surface carrying the same object, and it behaves differently
on purpose: the `config` echo on `list_agents`.** It is swept against this same
declaration and **reports without dropping** — see §2, which states the
behaviour, the reasons and the `configEchoContract` block the response carries.
It is written there rather than here because it qualifies the polling obligation
in §2, and the last time a clause about `list` was shipped away from that
obligation each sentence was true and the composition was false.

Why not project on the socket too, and make both paths exhaustive? Because the
socket is this daemon's own multiplexed protocol, where `broadcast` filtering
nothing is a property other things rely on, while an MCP notification has a
declared payload shape and a projection is the natural place to enforce one.
The honest consequence is that **the drift check is a test-time guard, not a
runtime one**: `verify-event-contract.mjs` fails if a broadcast carries a field
this document does not publish, so drift is caught in CI — but nothing at
runtime stops an undeclared field from reaching a socket subscriber, which is
exactly why the clause above is contract rather than advice.

If this daemon ever emits an action that is not in §1, that is a defect on our
side and it says so in `daemon.log`:

```
WARNING: broadcasting an action that is not on the event contract: "agent.teleported". …
```

**On the MCP notification path:** the forwarder carries a **positive allowlist**
of the names in §1. An action not on it is **dropped** and logged on our side:

```
crabcast-mcp: dropping a broadcast whose action is not on the event contract: "agent.teleported". Nothing was forwarded to the MCP client. Published events: …
```

A positive allowlist rather than a repaired suffix test, deliberately. A suffix
test is a convention masquerading as a filter, and its failure mode is that a
new event either matches by accident or vanishes without trace. An allowlist's
failure mode is a warning naming the action nobody added.

**Socket requests are unchanged**: an unknown *request* action still answers
`Unknown action: <name>`. That is a caller's mistake coming back to them, and is
a different thing from a broadcast a subscriber does not recognise.

---

## 5. The two surfaces

**Socket (Unix domain, NDJSON).** Every connected client receives every
broadcast — there is no `subscribe` verb and no opt-in, because there is
nothing to opt into. A frame carrying an `id` answers a request; a frame with
an `action` and no `id` is an event.

**MCP.** Events arrive as `notifications/message` with `logger:
"crabcast.events"` and `data` set to **the event object**. Not a rendered
sentence — the payload is the event, projected onto exactly the fields §1
declares:

```json
{
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "crabcast.events",
    "data": {
      "action": "agent.activated",
      "at": "2026-08-04T06:11:02.881Z",
      "seq": 3,
      "bootId": "9f5b…",
      "path": "/home/you/work/svc",
      "paneName": "crabcast-svc-…",
      "paneId": "104",
      "sessionId": "crabcast-svc-…-1785…",
      "status": "active",
      "configVersion": 1
    }
  }
}
```

The projection is enforced in both directions and drift is logged either way: a
declared field the daemon did not send, and a field the daemon sent that this
document does not publish. The first is the `undefined/undefined` defect in its
general form. The second is an internal convention trying to ship again. **Both
run to the bottom of every composite** and name what they found by its path —
`config.launcher`, `preemption.by.host` — with the single exemption §4 states.

This projection is what makes the MCP payload **exhaustive** where the socket's
is a **minimum** — see §4, which states the difference as contract and tells a
socket subscriber what it owes as a result.

---

## 6. Migrating from the old names

**Every name changed. There is no dual emission and no parallel acceptance of
the old names.** Dual-emitting would make every subscriber see each event twice
and dedupe, which is worse than a clean break, and `bootId` already forces a
resync on reconnect. The rename landed at once and is logged once at daemon
boot:

```
Event contract: 9 published events — … BREAKING, this release: every event was renamed (…), agent_preempted_event was merged into agent.deactivated as reason: 'preempted', and `success` no longer appears on any event. The old names are GONE — not dual-emitted and not accepted in parallel. …
```

Three changes beyond the names:

1. **`agent_preempted_event` is merged** into `agent.deactivated` as `reason:
   'preempted'` with the `preemption` block. See §1.
2. **`agent_reset_event` is gone**, with the `reset` verb (T1).
3. **`success` no longer appears on any event.** An event is a statement that
   something happened, not an answer to a request; there was nothing for it to
   be about. It was `true` on eight events and `false` on the one whose entire
   meaning is a failure, and the MCP path never published it.

---

## 7. Where this is proven

`scripts/verify-event-durability.mjs` — the `durable` field above, proven by
**making the registry write genuinely fail**: it seals the log file and then
attempts the same append itself, requiring it to throw, so a run where the
sealing did not take is refused rather than quietly exercising the healthy path.
It drives all three lifecycle operations on a real daemon against a working
registry and then against a sealed one, asserts the answer on the socket **and**
on the MCP projection, and checks each event against **its own response** — the
agreement that was the whole point. Its static half scans every emission site in
`src/router.ts` and reports an uncovered one by name and line, so "all three, not
just the one somebody named" is a measurement. Three mutations are run and each
watched going red: the unconditional claim restored, the field removed, and one
site's spread deleted.

One limit of that script, stated here rather than left to be discovered: **it
injects the write failure rather than encountering one.** It proves a failed
append is reported truthfully; it does not prove that a full disk, a quota
boundary or a short write reaches the same code path. The failure it does
reproduce faithfully is permissions, which is the one the daemon's own remedy
text names. And it says nothing about whether a *subscriber* acts on `durable:
false` — that is the consumer's half, and nobody on this side covers it.

`scripts/verify-event-contract.mjs` — a real daemon, a real MCP server over
real stdio, a real socket subscriber, against a herdr shim. It proves the
allowlist forwards the published events with structured payloads on both paths,
that the retired `endsWith('_event')` filter would have dropped every one of
them, that an off-allowlist action is dropped and logged on both sides, that
`agent.status_changed` fires on a real transition within the documented bound —
asserted at 32s, which is the 30s sweep plus census slack, so a sweep that
overran the bound in §2 fails rather than passing — and that a subscriber
reconnecting across a daemon restart sees a new `bootId` and recovers the
fleet. It also asserts `seq` is **contiguous** rather than merely increasing,
which is what makes "your `seq` jumped, so you missed events" mean anything.

Its §7 is the depth half of §4. It injects two undeclared fields at one real
emission site — one at the top level, one inside `config` — and rebuilds the
pre-fix depth-1 projector beside the current one, pointed at the same daemon:
the current forwarder drops and names both, the old one catches only the
shallow field, and the socket subscriber receives both because its payload is a
minimum. The `config.mcpServers` exemption is asserted the other way, as an
arrival.

**What §7 does not test, because it supplies its own input.** It proves an
undeclared field arriving at depth *is* caught; it does not prove none exists
today. That second claim is §2's, asserted over all nine events produced by
real operations on an unmutated build, where the drift report must be empty —
and §2 now reads the recursive projector, so a composite that really has grown
an undeclared field turns §2 red with §7 untouched. Two claims, two sections,
and neither stands in for the other.

`scripts/verify-config-echo-contract.mjs` — the poll half of §2's config-echo
subsection. It injects an undeclared knob at the **same real emission site**
KAN-164's depth proof uses — the place `configure` assembles the config object,
so the field travels parse → durable record → `list_agents` — and asserts the
response names it **by its full path** while still delivering it, on the real
MCP tool and on the socket. Two mutations are run and watched going red: the
sweep removed (the field travels unexamined and nothing on the response says
so, which is what `main` did before this) and the sweep left in place while the
warning is silenced, so the response's own report is shown to be what carries
the answer.

Its shared-declaration section is the one to read: a **single** edit adding that
knob to `CONFIG_FIELDS` makes the event path publish it *and* the poll path stop
reporting it, in the same build, with no second list touched. That is the claim
"one declaration, both surfaces" as a measurement rather than an assertion.

**What it does not test, because it supplies its own input.** It proves an
undeclared field in an echoed config *is* reported; it does not prove none
exists today. Its own no-drift section asserts that on an unmutated build over a
real fleet with every category populated, which is a different claim about a
different build.

**It covers `agent_status` as well as `list_agents`, on the same daemons**
(KAN-168). The knob injected once at the emission site is read back off both
surfaces in the same sections, so "one declaration, two surfaces" is measured on
one build rather than asserted twice; and its §3b removes the `agent_status`
sweep **alone**, leaving `list_agents` swept. That mutation is what stops the
single-agent read passing on the fleet read's evidence — the precise state this
repository was in from KAN-166 (#29, 2026-08-04) until KAN-168, and one that
every mutation removing shared machinery is blind to by construction.

Read that 32s figure against §2's bound, which is **30s plus one census read**
and not a flat 30s. The script's success line says so in full — "inside the
documented bound of 30s (the fleet sweep) plus one census read — asserted at
32.0s" — rather than the shorthand "the 30-second documented bound" it used to
print. That shorthand was honest only to a reader who came here: at a
31-second sweep it printed 30.9s beside the words "30-second bound", which
honours the real bound while contradicting itself on its face. A success
message is what somebody reads when nothing sent them looking, so it carries
the whole sentence.

One limit of that script, stated here rather than left to be discovered: its
guard against this document re-acquiring a unilateral convergence guarantee is
a **tripwire over known phrasings**, not a proof of absence — and the honest
summary is stronger than that. **It does not work on novel phrasings at all.**
Review attacked it with ten paraphrases the pattern list had never seen and
**all ten passed** — among them one that located the guarantee on the daemon's
side and denied it depended on the consumer at all, which is exactly the claim
§2 rejects. (The specimens are quoted in the script's own header comment rather
than here, so that widening a pattern later cannot turn this section red for
containing a sentence it is warning you about.) It catches the shapes the
mistake has actually taken, which are on file; it catches nothing else, and no
addition to that list will change the kind of thing it is, because "asserts
convergence unilaterally" is not a lexical property of English. **The real
defence is a reviewer trying to write the sentence** — that is what caught it
both times.
