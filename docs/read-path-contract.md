# The CrabCast read-path contract

CrabCast answers two questions about agent state: `list_agents` for the fleet
and `agent_status` for one agent. This document is what a consumer builds
against. Its executable half is `src/read-contract.ts`, which the router
imports — the tables below and the declarations in that file are the same
tables, and `scripts/verify-read-contract.mjs` reconciles them against a **real
daemon's responses** in both directions, so the two cannot drift apart quietly.

Before this contract existed the read path was a surface people had read off
the wire. [`docs/event-contract.md`](event-contract.md) published nine events
field by field and made an authoritative `list_agents` poll a **correctness
requirement** for every consumer of those events — and then described none of
the shape that poll returns. Butchr, the first consumer, asserted our response
shape in *their* repository, which means it was not our contract at all. The
guarantee a consumer needed most was on the path the document did not describe.

**This document does not replace `docs/event-contract.md`; it sits beside it.**
Events are the latency optimisation, `list_agents` is the authoritative read,
and everything that document says about delivery, ordering, resync and the
`config` echo's declared-field behaviour is still said there and is not repeated
here. Where this document needs one of those facts it points at the section
rather than restating it — two copies of a rule is how the copy that is wrong
gets written.

**A note on how to read the tables.** Every field table below is preceded by an
HTML comment naming the declaration it is bound to, and the proof matches them
by that name rather than by position — so a table that moves, or one that is
added for a declaration that does not exist, is caught rather than silently
skipped. The second column is the field's **provenance bucket** (§3), followed
by `, optional` where the field can be absent. A row reading *config echo*
stands for the five fields in [the config echo](#configecho), and the proof
expands it; it is a shorthand for readability, not a hole.

---

## 1. The stability statement

**There is no compatibility guarantee below 1.0.** What there is instead is a
notice promise, and it is this:

> **Any change to a field documented in the read-path contract gets a consumer
> notice before or with the merge that changes it, naming the field, the old and
> new behaviour, and what a caller should do.** Below 1.0 we do not promise a
> field will not change. We promise you will not find out by breaking.

### What it does NOT promise, stated so nobody reads more into it

* **Not that fields will not change.** They will.
* **Not that a change will be backward compatible.**
* **Not a deprecation period.** A field can go in the merge that announces it.
* **Not that the notice arrives before you have already pulled.** "Before or
  with the merge" is a promise about our side of the boundary, not about your
  update schedule.

**A consumer pinning to a commit is still the consumer's own safety mechanism.**
Nothing here substitutes for it.

### Why this and not a freeze

A compatibility promise made today would be a promise about how much we stop
improving, and the last week is the argument against it. KAN-227 added a tenth
MCP tool; KAN-235 moved a config path that had never worked; KAN-98 changed
`tailAgent`'s return shape; KAN-168 added a block to `agent_status`; KAN-216
added a refusal reason. **Every one of those made the product better and four of
them were defects.** Freezing the surface then would have preserved the defects.

### Why the notice promise is not a dodge

It is what already happens — every one of those changes shipped with a notice on
KAN-39 the same day. This makes an existing practice into a stated commitment,
which costs nothing new and is the honest version of what a 0.x consumer can
actually rely on. It is also the one promise that is *cheap to keep and
expensive to break*, which is the only kind worth writing down.

---

## 2. The version on the wire

**`daemon_status.contractVersion` is an integer naming the revision of this
document that the answering process implements.** It is on that response and on
no other, and `crabcast daemon-status` prints it as `read contract`.

<!-- contract-table: DAEMON_STATUS_CONTRACT_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `contractVersion` | derived | the revision of this document the answering process implements. An integer, incrementing by one |
| `unreadableRecords` | durable | registry rows this daemon could not read — [UnreadableRecord](#unreadablerecord) rows, the same shape `list_agents` carries |
| `unreadableRecordsTotal` | derived | how many there are, whatever this response carried |

```json
{ "action": "daemon_status_response", "success": true,
  "pid": 81234, "bootId": "…", "eventSeq": 41, "startedAt": "…",
  "contractVersion": 4,
  "configuredAgents": 0, "expectedAgents": 0,
  "unreadableRecords": [ … ], "unreadableRecordsTotal": 1,
  "build": { … }, "freshness": { … } }
```

The rest of `daemon_status` is out of this contract's scope on purpose: it is
about the **daemon** rather than about an agent's state, and it has its own
proofs (`verify-daemon-provenance.mjs`, `verify-daemon-status-over-mcp.mjs`).

**The two `unreadable*` fields are an exception to that, and it is argued for
rather than assumed.** They are not facts about the daemon; they qualify
`configuredAgents` and `expectedAgents` sitting beside them on that same
response. Both of those count only rows that *parsed* — so on the machine
KAN-302 was found on they read `0` and `0`, which is exactly what an empty
registry reads, on a registry that had a row in it. A count that silently
excludes what it could not read is the whole defect, one field to the left.
They are the same shape `list_agents` carries, deliberately: a consumer that
branches on one must be able to branch on the other.

**How to read it: once per boot.** The version is a property of the *process*,
and a process change is announced by **`bootId`**, which rides every
`list_agents` response and every event. So:

1. Call `daemon_status` and keep `contractVersion` beside the `bootId` you saw.
2. When a `bootId` on any response differs from the one you hold — which
   [§2 of the event contract](event-contract.md) already requires you to notice,
   because your `seq` watermark is meaningless across it — ask again.

**One place, and why not the other two.** `daemon_status` is already the "which
CrabCast am I talking to" response: it carries `pid`, `startedAt`, `build` and
`freshness`, and KAN-227 made it the tenth MCP tool, so it is reachable from the
socket, the CLI and MCP alike. There is **no hello** on this socket — it is
request/response NDJSON with no handshake — and inventing one to carry an
integer would be a protocol change made for a field. And it is **not on every
response** because the signal that invalidates it is already on every response:
N copies per poll of a fact that cannot change without `bootId` changing too
would be N chances for the copy that goes stale.

### Version history

<!-- contract-versions -->

| version | date | what changed | digest |
| --- | --- | --- | --- |
| 1 | 2026-08-11 | initial publication (KAN-277) — `list_agents` and `agent_status` field by field, the four provenance buckets, the closed vocabularies, and the version itself | `810f3da2b106` |
| 2 | 2026-08-11 | KAN-263 — five fields added to `capacity`: `startsCharged`, `startsConsidered`, `startsChargeCores`, `startsChargeBasis`, `startsChargeBecause`, and a new closed vocabulary [startsChargeBasis](#startschargebasis). **Additive: no documented field changed meaning, was removed, or changed type.** They carry what the CPU-side reading could not have contained — the term that makes `cpuBusyCores` and `headroomByCpu` reconcile. A consumer that ignores them reads the same numbers it read at version 1 and is not wrong, only unable to explain a refusal | `c17cf3570018` |
| 3 | 2026-08-11 | KAN-281 — one field added to `agent_status`: [channelEnabled](#channelenabled), on three of its four branches, saying whether the spawn an agent is running from was channel-enabled. **Additive: no documented field changed meaning, was removed, or changed type.** `durable`, sourced from the activation that made the decision rather than recomputed from config at response time, so it survives a restart. The same field is on `activate_response`, which this document does not otherwise cover — the field's own section says so and names what holds that half. Note `null` there means *no spawn to be about*, never *no channel* | `264ecca9f603` |
| 4 | 2026-08-11 | KAN-302 — one row shape added, [UnreadableRecord](#unreadablerecord), and two fields carrying it on each of `list_agents` and `daemon_status`: `unreadableRecords` and `unreadableRecordsTotal`. **Additive on the wire: no documented field changed meaning, was removed, or changed type.** What changed is BEHAVIOUR the document did not previously describe — a registry row this daemon cannot read used to stop it starting, and now it starts, skips the row and publishes it here. A consumer that ignores both fields reads exactly what it read at version 3, and is not wrong; it is unable to tell a registry that is wholly readable from one that is not, which before this version no consumer could do at all | `f8716f6b789e` |

The digest is `sha256(readContractCanonical())`, first 12 hex characters, over
`src/read-contract.ts`'s declarations. **What it buys:** changing a documented
field changes the digest, the row above stops matching, and
`verify-read-contract.mjs` goes red — so a silent change is loud. **What it does
not buy, so nobody reads it as more:** it does not *force* the version to
increment. A change can be landed by rewriting this row's digest instead of
adding a row, and that is a diff a reviewer sees rather than an omission they do
not. The bump is a human step, exactly as the notice is.

---

## 3. Provenance: the four buckets, and what an absence means

Every field below carries one of four buckets. They are the same four the
responses themselves carry in their `provenance` block, and they are the thing
that tells you whether an absence means **"not known"** or **"not true"**.

| bucket | where it came from | what it survives | reading a null |
| --- | --- | --- | --- |
| **durable** | the append-only agent registry | a daemon restart, unchanged — it never lived in memory | the record says so. `config: null` means *no record backs this row*, not *unknown* |
| **observed** | the census or session that answered **this** call | nothing — true as of `provenance.observedAt` and not one moment longer | herdr had nothing to say for this row *now*. Check `provenance.censusReachable` before reading it as absence |
| **derived** | computed by this daemon from the two above, or from the identity | as much as its inputs | a derivation that could not be made |
| **remembered** | this process's own accumulated observation | **nothing.** Gone on a restart, and null until this daemon has watched the thing happen | **an answer, not a gap** — this daemon has not watched it |

Three consequences that are contract rather than advice:

1. **`provenance.censusReachable: false` means every `observed` field is a last
   resort rather than a reading.** An empty census from an unreachable herdr is
   silence, not evidence. Do not read an absent pane as proof an agent is down —
   that is what the `state: 'unknown'` value exists for.
2. **A nullable field is emitted as an explicit `null`, never omitted.** Over
   JSON an absent key reads as "not answered", and these are answered. Where a
   field really is absent from a response it is marked `optional` in the tables
   below, and the condition is stated.
3. **`remembered` is one field today** — `statusSince`, and only on
   `list_agents.agents[]` rows. Neither `agent_status` nor the four not-running
   categories carry one, because the memory is keyed on the sweep's census of
   *live* agents. The legend announces the bucket on responses that have no
   field in it, deliberately: a bucket that appeared and disappeared would be
   worse than one that is always there.

**The `provenance` block on the wire classifies ROW fields.** The buckets this
document gives for **response-level** fields (`bootId`, `capacity`, `pages`, …)
are the same four definitions applied one level up, and the wire legend does not
name them. `verify-read-contract.mjs` §4 asserts that every **row** field's
bucket here is identical to the live legend's, in both directions; for the
response-level ones it holds this document to `src/read-contract.ts` and stops
there. That is the edge of the check, and it is here rather than left to be
found.

---

## 4. `list_agents`

The authoritative read. [§2 of the event contract](event-contract.md) is where
its **delivery** obligations live — that a consumer of our events must poll this
on a timer, and that five of its categories are **paged** and must be walked to
`nextCursor: null`. This section is its **shape**.

### The success response, field by field

<!-- contract-table: LIST_AGENTS_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `action` | derived | `"list_agents_response"` |
| `success` | derived | `true` here |
| `agents` | derived | every live agent — [ListedAgent](#listedagent) rows. **Never paged**: built from the herdr census, so it is bounded by what is running and complete in every response |
| `unbackedPanes` | derived | our panes with nothing behind them — [UnbackedPane](#unbackedpane) rows. **Never paged**, same reason |
| `missingAgents` | derived | recorded active, absent anyway — [MissingAgent](#missingagent) rows. **Paged** |
| `preemptedAgents` | derived | stood down to make room — [PreemptedAgent](#preemptedagent) rows. **Paged** |
| `standbyAgents` | derived | switched off, and it has run — [StandbyAgent](#standbyagent) rows. **Paged** |
| `unstartedAgents` | derived | configured, never run — [UnstartedAgent](#unstartedagent) rows. **Paged** |
| `foreignPanes` | derived | live panes that are not ours — [ForeignPane](#foreignpane) rows. **Paged** |
| `missingTotal` | derived | rows in the whole category, cursor or no cursor |
| `preemptedTotal` | derived | as above |
| `standbyTotal` | derived | as above |
| `unstartedTotal` | derived | as above |
| `foreignPanesTotal` | derived | as above |
| `unreadableRecords` | durable | rows in the durable registry this daemon **could not read** — [UnreadableRecord](#unreadablerecord) rows. Present-and-empty on a wholly readable registry. **Not paged**: bounded at 25, and `unreadableRecordsTotal` is never clipped |
| `unreadableRecordsTotal` | derived | how many there are, whatever this response carried |
| `pages` | derived | one [FleetPage](#fleetpage) per paged category, keyed by category name |
| `bootId` | remembered | this daemon's boot identity. A different one means your `seq` watermark is meaningless and this response is your new baseline |
| `eventSeq` | remembered | the highest sequence number stamped so far. Ahead of your last `seq` under the same `bootId` means you missed events |
| `startedAt` | remembered | when this **process** started. It bounds how long this daemon *could* have been watching; what it actually watched is `statusSince` |
| `provenance` | derived | the legend — [Provenance](#provenance) |
| `capacity` | derived | what this machine can carry and why — [Capacity](#capacity) |
| `priorities` | derived | what each running agent is worth, and therefore what a would-be activation would have to outrank — [PriorityRow](#priorityrow) rows |
| `herdrHealth` | observed, optional | [HerdrHealth](#herdrhealth). **Absent** when this daemon could not read its own descriptor usage |
| `configEchoContract` | derived | the declared-field report — [ConfigEchoContract](#configechocontract) |

**`*Total` was never a remedy for paging and is not one now.** It says how many
rows are missing and never which. `pages.<category>.nextCursor` is the handle,
and `null` is the only "you have everything" signal — not `returned < limit`,
which stops early on a page that landed short, and not `returned === total`,
because a cursored page is a window into a category rather than a prefix of it.

<a id="the-refusal-response"></a>
### The refusal response

A refused `list_agents` — an invented or corrupted cursor, an out-of-range
`limit`, a category nobody publishes — is a **different and much smaller
object**:

<!-- contract-table: LIST_AGENTS_REFUSAL_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `action` | derived | `"list_agents_response"` |
| `success` | derived | `false` |
| `error` | derived | what was wrong with the request, by name |

**Three fields, and no `configEchoContract` — which is an asymmetry with
`agent_status`, and it is documented here rather than repaired.** §2 of the
event contract says the echo contract rides *every* `agent_status` response
including its refusals, so that "nothing was there" and "nobody looked" stay
distinguishable; `handleListAgents` refuses before it builds any row, so a
refused fleet read carries no block at all. It also carries no echo for a block
to be *about*, which is why this has never been a defect anybody met. Whether
the two surfaces should nonetheless agree is a decision, and it is
[KAN-279](https://wroosbit.atlassian.net/browse/KAN-279) rather than a quiet fix
inside the ticket that documented the surface.

**A cursor is refused, never answered from the beginning.** A cursor that
silently reset would turn an enumeration into a loop over its first page.

---

## 5. The rows

Every shape here carries the **config echo** except `ForeignPane` and
`PriorityRow`, and both say why below. The echo is the durable record
**verbatim**, which is the whole reason a consumer does not have to keep a
shadow copy of what it asked for; [§2 of the event
contract](event-contract.md) is where its declared-field behaviour lives, and
`config`'s own knobs are declared by `CONFIG_FIELDS` in `src/events.ts`.

<a id="configecho"></a>
### The config echo — the five fields a *config echo* row stands for

<!-- contract-table: BLOCK_SHAPES.ConfigEcho -->

| field | bucket | what it is |
| --- | --- | --- |
| `config` | durable | `configure`'s argument list, exactly as it was frozen onto the record. **`null` — explicitly, never omitted — when no record backs this row at all.** Every consumer of this block has to handle null rather than assuming a shape |
| `configVersion` | durable | the compare-and-set token. Null with `config` |
| `configuredAt` | durable | when that version was frozen. Null on a pre-field row, and with `config` |
| `everActivated` | durable | whether activating this agent **resumes** a conversation or starts a fresh one. **`false` beside `state: 'running'` is not a contradiction** — it is our log being behind a live agent, which is a real state with a real repair, and the only signal that it happened |
| `activatedBy` | durable | the canonical path of the agent that activated this one, or `null` when nobody did. A human-initiated activation has no supervisor, and that is a fact rather than a gap |

<a id="listedagent"></a>
### `agents[]` — ListedAgent

Two kinds of entry share this shape, told apart by `sessionless`.

<!-- contract-table: ROW_SHAPES.ListedAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `sessionless` | observed | `false` — this daemon holds the agent's terminal attach. `true` — the agent is alive in herdr but no session of ours describes it, which is every surviving agent after a daemon restart. **The session-only fields are null because there is no session, not because the agent is impaired** |
| `state` | derived | see [state](#state). `running` on every row in this category |
| `configured` | durable | whether a durable record backs this row. `false` means `config` is null and the three gate flags are the **safe reading of an unknown** rather than anybody's configuration |
| *config echo* | durable | the five fields [above](#configecho) |
| `path` | durable | the canonical directory this agent **is**. The address; nothing else is |
| `paneName` | derived | the opaque herdr token for that path. **Nothing parses it back out** |
| `paneId` | observed | **never store this.** herdr pane ids are positions in a list that compacts whenever any pane anywhere closes, so one stored as configuration goes stale when an unrelated agent finishes. Null when the census had nothing |
| `sessionId` | observed | our session's id, or null on a sessionless row |
| `createdAt` | observed | when our session was created, or null |
| `status` | observed | our session's lifecycle — see [sessionStatus](#sessionstatus) — or null |
| `herdrStatus` | observed | herdr's word for what the pane is doing — see [herdrStatus](#herdrstatus) |
| `statusSince` | remembered | when **this daemon** first observed the agent in the `herdrStatus` beside it, or null. See the caveats below |
| `agentRuntime` | observed | herdr's `agent` field: the CLI running in the pane, null for a shell |
| `label` | durable | display only. **Never parsed, never an address** |
| `refusable` | durable | whether the capacity gate may refuse this agent |
| `chargeable` | durable | whether it occupies a charged slot |
| `preemptable` | durable | whether anything may stand it down to make room |

**`statusSince`, and what it is not.** [§3 of the event
contract](event-contract.md) is the full account and it is worth reading before
you build on it. In short: it is a fact and **not a diagnosis** — CrabCast will
never say "stuck"; it is **not a heartbeat or a liveness probe**; `null` is an
answer rather than a gap, and it is null for *every* agent on a freshly started
daemon; and it does not survive a restart. "Idle for four hours while its ticket
says In Progress" is a judgement the **caller** makes out of this field and its
own knowledge, which is the half this daemon does not have.

**The three gate flags are sent because a client cannot derive them.** They live
on the agent's own record, and re-deriving them anywhere else would be a second
copy of a rule — the copy that is wrong after somebody reconfigures.

<a id="unbackedpane"></a>
### `unbackedPanes[]` — UnbackedPane

A pane sitting in one of our directories with nothing running in it. Reported
rather than dropped: it is not an agent — there is nothing to message, tail or
supervise — and counting it would give a supervisor a number it cannot act on.

<!-- contract-table: ROW_SHAPES.UnbackedPane -->

| field | bucket | what it is |
| --- | --- | --- |
| `paneName` | derived | |
| `paneId` | observed | |
| `path` | durable | |
| `herdrStatus` | observed | |
| *config echo* | durable | it **is** one of ours, so a reader deciding what to do about an empty pane can see what was supposed to be in it |
| `reason` | derived | a sentence saying what was found |

<a id="missingagent"></a>
### `missingAgents[]` — MissingAgent

The registry says this should be running and herdr does not have it. A **loss**.

<!-- contract-table: ROW_SHAPES.MissingAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | derived | |
| `label` | durable | |
| *config echo* | durable | the row a supervisor most needs the configuration on: the decision it prompts is "re-activate or stand down", and both halves need to know what would come back |
| `since` | durable | **ACTIVE SINCE, NOT MISSING SINCE.** When the registry last recorded this agent as *activated*. An agent activated last Tuesday that died a minute ago carries a `since` of last Tuesday, exactly like one that died last Tuesday |
| `reason` | derived | which of the two losses this is: never came back, or died while this daemon held its session |

**Nothing records when it went, and KAN-189 decided nothing will.** If you want
down-time, keep the first `at` you saw on the matching `agent.lost` event (or
the first poll the row appeared in) and clear it when the path leaves the
category. You are already required to poll on a timer, so you have both halves.
A durable copy of that observation would be this daemon claiming a duration it
was not watching for.

<a id="preemptedagent"></a>
### `preemptedAgents[]` — PreemptedAgent

Stood down so something more important could run. A **debt**, and a queue of
decisions still owed rather than a log of events — the moment one is
re-activated it leaves the list. **Nothing here restarts them, deliberately: a
preemption queue that restarts its own entries is a scheduler, and preemption
must never be automatic.**

<!-- contract-table: ROW_SHAPES.PreemptedAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | derived | |
| `label` | durable | |
| *config echo* | durable | what it would come back as, and what it would have to outrank |
| `at` | durable | when the slot was taken |
| `priority` | durable | what this agent was worth |
| `herdrStatusWhenPreempted` | durable | what herdr said it was doing at that moment. **A plain string, not the `herdrStatus` vocabulary** — the annotation stores whatever herdr said, and a status this daemon's union does not know about is still what happened |
| `by` | durable | who took it — [PreemptedBy](#preemptedby) |
| `reason` | derived | a sentence. **Its work was interrupted, not finished**, and until it is re-activated its work should not be read as in progress |
| `derivation` | durable | the capacity arithmetic that made the slot necessary |

<a id="standbyagent"></a>
### `standbyAgents[]` — StandbyAgent

Somebody switched it off, and it **has** run: activating it resumes the
conversation it was stopped in.

<!-- contract-table: ROW_SHAPES.StandbyAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | derived | |
| `label` | durable | |
| `launcher` | durable | which launcher it last ran, so it comes back as what it was |
| *config echo* | durable | |
| `since` | durable | when the registry recorded the stand-down |
| `wasPreempted` | durable, optional | **present only** on a row that reached this list through preemption-annotation compaction — its work was taken, not switched off. Absent means somebody chose to stop it. A client rendering an On button treats both the same; a human reading *why* it is off does not |
| `reason` | derived | |

**Membership is not "the last event was `deactivated`".** Reconfiguring a
stopped agent writes a `configured` row, so an agent that ran, was switched off
and was then reconfigured has `configured` as its last event while its
conversation is still on disk. The test is: not running, not preempted,
directory present, and it has ever been activated.

<a id="unstartedagent"></a>
### `unstartedAgents[]` — UnstartedAgent

Configured and **never** run. Activating it starts a fresh conversation.

<!-- contract-table: ROW_SHAPES.UnstartedAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | derived | |
| `label` | durable | |
| `launcher` | durable | which launcher it will run when first activated |
| *config echo* | durable | |
| `since` | durable | when it was configured. This category has no later event to report |
| `reason` | derived | |

**Why this is not standby, and it is behavioural rather than taxonomic.** Every
standby row promises that switching it back on *resumes the conversation it was
stopped in*. An agent that has never run has nothing to continue, so the same
call starts fresh. Folding the two together does not merely blur a label; it
makes the standby list's own promise false for half its members.

The four not-running categories — missing, preempted, standby, unstarted — are
**disjoint on purpose**, so no agent grows two switches.

<a id="foreignpane"></a>
### `foreignPanes[]` — ForeignPane

A live pane that is not ours. herdr hosts more than CrabCast. These are reported
rather than dropped because one of them is the reason `activate` refuses:
`occupies` is non-null exactly when a stranger's agent is sitting in a directory
we hold a record for, which is the state that would otherwise put two agents in
one directory. **A reader can see the refusal coming rather than meeting it.**

<!-- contract-table: ROW_SHAPES.ForeignPane -->

| field | bucket | what it is |
| --- | --- | --- |
| `paneName` | derived | |
| `paneId` | observed | |
| `workDir` | observed | herdr's `cwd`, as herdr reported it |
| `occupies` | derived | set when that cwd is a directory **we** hold a record for; null otherwise |
| `herdrStatus` | observed | |
| `agentRuntime` | observed | |
| `occupiedAgent` | durable | **our** agent for the directory this pane is sitting in — the one whose `activate` will be refused until the pane is gone — or null. [OccupiedAgent](#occupiedagent) |

**There is no bare `config` on this row, and the nesting is the point.** A
foreign pane is not ours: it has no CrabCast configuration, and a bare `config`
here would say it did. What the nested block describes is the agent this pane is
**blocking**.

<a id="priorityrow"></a>
### `priorities[]` — PriorityRow

What each running agent is worth. *"There is no room"* and *"there is no room
**for you**"* are different answers, and a supervisor deciding whether to staff
something needs both.

<!-- contract-table: ROW_SHAPES.PriorityRow -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | derived | |
| `priority` | durable | |
| `herdrStatus` | observed | |

No config echo: this row is an ordering, not a state read.

<a id="unreadablerecord"></a>
### `unreadableRecords[]` — UnreadableRecord

**A line in the durable registry that this daemon could not read.** On
`list_agents` and on `daemon_status`, and it is the one row shape here that is
not an agent: it has no path you can act on, no state, no pane, and no config to
echo — because it describes a record that was *not* read, which is precisely the
claim every other category is structurally unable to make.

**Why it exists** ([KAN-302](https://wroosbit.atlassian.net/browse/KAN-302)). A
row written by an older CrabCast used to stop the daemon booting outright, and
the first remedy it printed was *delete the registry and configure the fleet
again* — every other agent record discarded to recover from one line. The daemon
now **skips the row and starts**, which is only honest if something says what
was skipped: a fleet surface built from rows that parsed cannot report a row that
did not, and the operator who first met this had every dashboard green. This is
that something. The rows themselves are left in the file untouched and are
carried across compaction verbatim.

<!-- contract-table: ROW_SHAPES.UnreadableRecord -->

| field | bucket | what it is |
| --- | --- | --- |
| `line` | derived | 1-based line number in the registry file — what `sed -n '<n>p'` takes. Moves when compaction rewrites the file |
| `problem` | derived | `pre-migration` (an older `<type>/<key>` row), `from-newer` (a newer daemon wrote it; you downgraded), or `unusable` (this version, and still malformed — almost always a hand-edit) |
| `identity` | durable | however the row names itself: its `agentName`, else `<type>/<key>`, else its `path`. **In the row's own vocabulary**, because an old row does not know the word `path` |
| `reason` | derived | what could not be read about *this* row, naming fields. On `unusable` it names the exact field that is wrong rather than listing what a row needs |
| `raw` | durable | the row's own bytes, so the operator need not open the file. Clipped at 2048 characters, and see `promptRedacted` |
| `rawTruncated` | derived | whether `raw` was clipped |
| `promptRedacted` | derived | whether a `prompt` was removed from `raw` before publishing it. `config.prompt` is the one configured field the ordinary config echo does **not** carry, so publishing it here would widen the surface by the back door. When true, `raw` is re-serialized with a marker naming the withheld length; every other field survives, so the row is still repairable from the disclosure |
| `claimsPath` | durable | a directory this row names — its `path`, else the retired `workDir` — or null when it names none. **A skipped row's path is not claimed by anything**, so `configure` on that directory will now succeed and create a second record for it; this field is what lets a caller see that coming |

**What this list is not.** It is a fault report, not an inventory, so it is
bounded at 25 rather than paged — the five paged categories grow with the fleet
and have to be walkable, and this one is bounded by how badly one file has been
hand-edited. `unreadableRecordsTotal` is never clipped, and `daemon.log` carries
the full detail for whoever is repairing them.

**A torn final line is not one of these.** A power cut can leave a partial
record at the end of the log; that is expected, it is dropped, and reporting it
here would make an ordinary crash look like data loss. Only lines that parse as
JSON objects and are still unreadable appear.

---

## 6. The blocks

<a id="capacity"></a>
### `capacity` — Capacity

Flat and named rather than nested, because the caller most likely to read it is
a language model deciding whether to staff another agent, and the fields it
needs should not be at the end of a path. **`summary` is the same figures in a
sentence: a caller that ignores every number still cannot ignore that one.**

<!-- contract-table: BLOCK_SHAPES.Capacity -->

| field | bucket | what it is |
| --- | --- | --- |
| `cap` | derived | how many charged agents this machine will carry |
| `running` | derived | how many are |
| `exemptAgents` | derived | how many are running uncharged |
| `headroom` | derived | how many more, after every term including the stall veto |
| `atCapacity` | derived | |
| `capBoundBy` | derived | which term set the cap — [capBoundBy](#capboundby) |
| `headroomBoundBy` | derived | which term set headroom — [headroomBoundBy](#headroomboundby). **This is the value that gained a fifth member on 2026-08-11; read the must-ignore clause in §8** |
| `reason` | derived | the one sentence a UI with a single line to spare renders. On every capacity payload, not only on refusals |
| `cores` | observed | |
| `load1` | observed | the 1-minute load average. **Reported, and no longer what gates anything wherever `cpuBusyCores` is non-null** — a machine where the two diverge is a machine worth looking at |
| `cpuBusyCores` | observed | cores observed in use, or **null where nothing measured** — in which case `headroomBoundBy: 'load'` says the load average stood in |
| `cpuWindowSeconds` | observed | so a caller can date the figure without asking again |
| `cpuObservedAt` | observed | |
| `totalMb` | observed | |
| `availableMb` | observed | |
| `agentMemoryMb` | observed | what one agent is assumed to cost |
| `agentCores` | observed | |
| `agentMemorySource` | derived | where that figure came from — [costSource](#costsource) |
| `agentCoresSource` | derived | as above |
| `measuredAt` | observed | the sample's metadata, when a measurement was consulted. Null otherwise |
| `measuredWindowSeconds` | observed | |
| `measuredAgentTrees` | observed | |
| `capByCpu` | derived | the terms, so the arithmetic is inspectable rather than asserted |
| `capByMemory` | derived | |
| `headroomByCap` | derived | |
| `headroomByCpu` | derived | |
| `headroomByLoad` | derived | |
| `headroomByMemory` | derived | |
| `stallPercent` | observed | the worst pressure stall. **`null` when nothing measured — never `0`** |
| `stallSource` | observed | which pressure was worst — [stallSource](#stallsource). Null with `stallPercent` |
| `stallInstrument` | observed | which kind of nothing a null is — [stallInstrument](#stallinstrument). **A caller that reads a percentage without reading this field can be misled**, which is why it is on the wire rather than in prose |
| `stalled` | derived | whether the veto fired |
| `stallRefusePercent` | derived | the threshold it fired against |
| `headroomBeforeStall` | derived | what the counting terms allowed before the veto zeroed them. Equal to `headroom` unless `stalled` |
| `startsCharged` | derived | agents that started too recently for the CPU-side reading to contain them, and were therefore charged against it. **`0` is a settled fleet, not an instrument that stopped** — read it beside `startsConsidered`. **Added 2026-08-11 (KAN-263)** |
| `startsConsidered` | derived | how many starts the ledger held at all. A daemon that keeps starting agents while this stays `0` has a ledger that has stopped being written to, which is the one failure the charge cannot report about itself |
| `startsChargeCores` | derived | cores subtracted from the CPU-side budget for those starts. **This is the term that makes the subtraction come out**: a caller rendering `cpuBusyCores` against `headroomByCpu` without it is showing arithmetic that does not add up |
| `startsChargeBasis` | derived | which instrument's blind spot it was measured against — [startsChargeBasis](#startschargebasis) |
| `startsChargeBecause` | derived | the derivation in one sentence, with the window's own edges in it, so the charge is reproducible by hand from the response alone |
| `summary` | derived | |

<a id="fleetpage"></a>
### `pages.<category>` — FleetPage

One entry per paged category, on **every** response rather than only on a
truncated one — so a consumer that checks it is doing the ordinary thing rather
than handling an exception.

<!-- contract-table: BLOCK_SHAPES.FleetPage -->

| field | bucket | what it is |
| --- | --- | --- |
| `returned` | derived | rows in **this** page |
| `total` | derived | rows in the whole category, cursor or no cursor |
| `limit` | derived | the page size this response used, asked for or defaulted (**25**; 1–200) |
| `remaining` | derived | rows after this page. Zero exactly when `nextCursor` is null |
| `nextCursor` | derived | pass back as `pages.<category>.after`. **`null` is the only "you have everything" signal** |

**The cursor is opaque and is a POSITION, not a row id.** Pass it back
unchanged. A row vanishing between pages shifts nothing, because the next page
resumes from the sort key rather than from an index. **A page walk is not a
transaction**: a row created while you page can arrive ahead of your cursor and
be missed by *this* walk, and a row whose timestamp moves can repeat. That is
what your timer is for — reconcile on the union of what you observe.

Asking for the next page:

```json
{ "action": "list_agents", "pages": { "standbyAgents": { "after": "eyJ3IjoiMjAyNi0…" } } }
```

<a id="provenance"></a>
### `provenance` — Provenance

The legend, **on the response rather than only in this document**, because
conflating durable state with a live observation is exactly the ambiguity the
config echo exists to remove.

<!-- contract-table: BLOCK_SHAPES.Provenance -->

| field | bucket | what it is |
| --- | --- | --- |
| `durable` | derived | the row field names in that bucket |
| `observed` | derived | |
| `derived` | derived | |
| `remembered` | derived | |
| `observedAt` | observed | when the census behind every `observed` field answered |
| `censusReachable` | observed | **whether herdr answered at all.** `false` means every `observed` field is a last resort rather than a reading |
| `note` | derived | the same four definitions in prose, for a human holding one response |

**The four bucket arrays are exhaustive over every key any row carries**, and
`verify-state-read-echoes-config.mjs` §7 is what holds them to it — a field
added later and left unclassified fails there rather than quietly joining
whichever bucket a reader assumed.

<a id="configechocontract"></a>
### `configEchoContract` — ConfigEchoContract

On **every** `list_agents` success response and **every** `agent_status`
response including its refusals. [§2 of the event
contract](event-contract.md) is where its behaviour is specified — this table is
only its shape.

<!-- contract-table: BLOCK_SHAPES.ConfigEchoContract -->

| field | bucket | what it is |
| --- | --- | --- |
| `declared` | derived | every knob `CONFIG_FIELDS` declares. The list, not a copy of it |
| `verbatim` | derived | knobs declared to travel **whole**, whose interiors this sweep does not examine. Today: `mcpServers`, and §4 of the event contract says why |
| `drops` | derived | **always `false`** on both read paths: an undeclared field is **reported and still delivered**. The MCP *event* path's answer is the other one |
| `undeclared` | derived | undeclared fields found on **this** response, by full path. `[]` means the sweep ran and found nothing — never that it did not run |
| `note` | derived | |

**An absent `configEchoContract` is an older daemon**, not a clean one — except
on a refused `list_agents`, where it has never been present at all
([above](#the-refusal-response), and
[KAN-279](https://wroosbit.atlassian.net/browse/KAN-279)).

**Do not key behaviour off an undeclared field.** It is an internal value that
has not been designed for you and can change or vanish without this document
changing.

<a id="herdrhealth"></a>
### `herdrHealth` — HerdrHealth (optional)

Descriptor headroom, reported where somebody looking at agents will see it, and
expressed in **panes** because that is the unit a reader can act on. **The whole
block is absent** when this daemon could not read its own descriptor usage.

<!-- contract-table: BLOCK_SHAPES.HerdrHealth -->

| field | bucket | what it is |
| --- | --- | --- |
| `pid` | observed | |
| `openFds` | observed | |
| `softLimit` | observed | |
| `headroomPanes` | derived | roughly how many more panes fit |
| `fdPressure` | derived | the ratio, to two places |
| `warning` | derived, optional | present only above the pressure threshold |

<a id="preemptedby"></a>
### `preemptedAgents[].by` — PreemptedBy

<!-- contract-table: BLOCK_SHAPES.PreemptedBy -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | |
| `paneName` | durable | |
| `priority` | durable | |

<a id="occupiedagent"></a>
### `foreignPanes[].occupiedAgent` — OccupiedAgent

<!-- contract-table: BLOCK_SHAPES.OccupiedAgent -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | the directory both are in |
| `state` | derived | **asked properly rather than assumed stopped** — ours and a stranger can be live in the same directory, which is the case this row exists to make visible |
| *config echo* | durable | the five fields [above](#configecho) |

---

## 7. `agent_status`

The same question about one agent, from the same census, through the same
derivation. **`state` here and the category a row lands in over there cannot
disagree**, because both call one function.

### `success` is about the QUESTION, not the agent

**A record is an answer.** `success: false` means *the read failed*, not *the
agent is down* — liveness is what `state`, `sessionless` and `herdrStatus` are
for. A configured-and-stopped agent **succeeds**. Only a path with neither a
record nor a pane fails, and only that one means the caller mistyped.

### The four branches, and exactly what each carries

<!-- contract-branches: AGENT_STATUS_BRANCHES -->

| branch | when | keys |
| --- | --- | --- |
| `live-session` | `success: true`, this daemon holds the session | `action` `success` `sessionless` `path` `paneName` `paneId` `sessionId` `createdAt` `status` `herdrStatus` `label` `configured` `state` `config` `configVersion` `configuredAt` `everActivated` `activatedBy` `channelEnabled` `provenance` `configEchoContract` |
| `sessionless` | `success: true`, no session of ours — every agent that outlived a daemon restart, and every stopped one | `action` `success` `sessionless` `path` `paneName` `paneId` `sessionId` `createdAt` `status` `workDir` `herdrStatus` `label` `configured` `state` `config` `configVersion` `configuredAt` `everActivated` `activatedBy` `channelEnabled` `provenance` `configEchoContract` |
| `no-record-no-pane` | `success: false` — nothing here has ever been an agent | `action` `success` `error` `path` `paneName` `configured` `state` `config` `configVersion` `configuredAt` `everActivated` `activatedBy` `channelEnabled` `provenance` `configEchoContract` |
| `bad-address` | `success: false` — the address itself was rejected (relative, empty, not a directory) | `action` `success` `error` `configEchoContract` |

**`workDir` appears on the sessionless branch and nowhere else**, and on that
branch `sessionId`, `createdAt` and `status` are explicit nulls. A field marked
`optional` in the table below is *optional over the union of the four* — it is
**required** on the branch it belongs to, and you know which branch you are
holding from `success`, `configured` and `sessionless`.

**The no-record-no-pane refusal still carries the echo (all nulls), the legend
and the contract block.** A refusal that said nothing about *where it looked*
would be indistinguishable from a daemon that did not look — and its `error`
distinguishes two things a caller must not conflate: *"nothing here has ever
been an agent"* and *"herdr did not answer, so whether a pane is running there
could not be checked"*. An empty census from an unreachable herdr is silence,
not evidence.

### Field by field

<!-- contract-table: AGENT_STATUS_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `action` | derived | `"agent_status_response"` |
| `success` | derived | |
| `error` | derived, optional | refusals only |
| `sessionless` | observed, optional | absent on both refusals |
| `path` | durable, optional | the canonical path. Absent on **bad-address**, where nothing was resolved |
| `paneName` | derived, optional | |
| `paneId` | observed, optional | **never store it** — see [ListedAgent](#listedagent) |
| `sessionId` | observed, optional | null on the sessionless branch |
| `createdAt` | observed, optional | null on the sessionless branch |
| `status` | observed, optional | [sessionStatus](#sessionstatus). Null on the sessionless branch |
| `workDir` | observed, optional | **sessionless branch only** |
| `herdrStatus` | observed, optional | `unknown` when the census had no pane |
| `label` | durable, optional | |
| `configured` | durable, optional | |
| `state` | derived, optional | [state](#state) |
| *config echo* | durable, optional | the five fields [above](#configecho) |
| `channelEnabled` | durable, optional | whether the spawn this agent is running from was **channel-enabled** — see [below](#channelenabled). Absent on **bad-address** only |
| `provenance` | derived, optional | [Provenance](#provenance) |
| `configEchoContract` | derived | **every branch**, refusals included |

### `channelEnabled` — was this spawn channel-enabled

**Three values, and `false` and `null` are different claims.**

| value | what it means |
| --- | --- |
| `true` | the spawn this agent is running from was given the channel |
| `false` | it was **not** — this agent cannot reach CrabCast |
| `null` | **there is no spawn to be about**: no record at this path, or an agent that has been configured and never activated. It is *not* a way of saying "no channel" |

**What the channel is here.** It is the `crabcast` builtin MCP server being
provisioned into the agent — not a command-line switch, because CrabCast has
none for it. An agent configured without that server has no channel and
therefore no identity: it cannot reach this daemon, so it cannot activate
anything and has nothing to be the parent of. `channelEnabled` is the published
form of that one fact.

**Where the value comes from, and why it is `durable`.** It is written by the
activation that made the decision, read off the resolution's own output at the
moment `builtinMcpServer` supplies the server — not recomputed later by asking
`config.mcpServers` again. It then lives on the agent registry, so it survives a
daemon restart unchanged and `agent_status` answers the same value afterwards
that the spawn recorded.

That choice is what makes the field safe on the branch you are most likely to
read it on. Every agent that outlived a restart answers on the **sessionless**
branch, where this daemon holds no session for it and never watched it start; a
value kept in process memory would be `null` for the entire surviving fleet, and
one read from the live session object would be `false` — indistinguishable from
an agent genuinely spawned without a channel. A wrong `false` is the only value
here that is actively damaging, because `false` is what you would branch on to
conclude the channel is unavailable.

**It does not change while the agent runs.** A `configure` that moves a knob on
a running agent carries the value forward rather than recomputing it, and an
idempotent `activate` on an already-running agent does not overwrite it — that
call did not spawn anything, so it has no verdict to record. The value changes
only when the agent is genuinely spawned again.

**It is also on `activate_response`, which this document does not otherwise
cover.** That surface is outside the contract — §4 and §7 describe `list_agents`
and `agent_status`, and nothing here enumerates `activate_response`'s fields —
so read the following as a statement about behaviour rather than as a row this
document's machinery holds:

* `activate_response` carries `channelEnabled` on **both** successful branches,
  the one that spawns and the idempotent one that finds the agent already
  running, with the same three-value meaning as above.
* Both surfaces answer it from the same durable record, so they agree for the
  same agent. `activate_response` exists for the case a poll cannot serve: it
  tells you about *the spawn you just made*, where a later `agent_status` could
  be describing a different one.
* **What holds it:** `scripts/verify-channel-enabled.mjs` asserts the value on
  both surfaces and that they agree. **`verify-read-contract.mjs` does not** — it
  reconciles this document against `list_agents` and `agent_status` only. So a
  future change to `channelEnabled` on `activate_response` is caught by the
  first script and by no document check. That asymmetry is named here rather
  than left to be discovered, in the same spirit as §9's *"where it stops"*.

**No `statusSince` here, and that is deliberate rather than an omission.** The
memory is keyed on the sweep's census of our *live* agents, so this response
would carry a field structurally incapable of being anything but null. The
legend still announces the `remembered` bucket, the same way it announces
`workDir` on responses that do not carry one.

---

## 8. The closed vocabularies

**A value you do not recognise must be handled as an unknown rather than errored
on.** This is the same clause §4 of the event contract states for actions and
fields, and it is the one that matters most here, because these sets grow:
`headroomBoundBy` gained `stall` on 2026-08-11 (KAN-216), and every consumer
holding a four-way switch met a fifth value. The safe reading is *"something
bound headroom and it is not one of the terms I know"* — which is true, and
enough to render.

<a id="state"></a>
### `state`

On `agents[]`, `agent_status`, and `foreignPanes[].occupiedAgent`.

<!-- contract-values: state -->

| value | what it means |
| --- | --- |
| `running` | live, by the single ownership test |
| `missing` | the record says activated; the census has no such agent. A loss |
| `preempted` | stood down so something else could run. A debt |
| `standby` | stood down, and it has run: activating it **resumes** |
| `unstarted` | configured and never activated: activating it starts **fresh** |
| `unconfigured` | no record at all. Not an agent; nothing to echo |
| `unknown` | a record that has run, and **a census that did not answer**. Saying `missing` because herdr was down would hand you our own outage as the report of your agent's death |

<a id="herdrstatus"></a>
### `herdrStatus`

herdr's own vocabulary for what a pane is doing. **CrabCast does not interpret
it** — learning to recognise one runtime's modal would rot the first time that
tool changed a word.

<!-- contract-values: herdrStatus -->

| value | what it means |
| --- | --- |
| `idle` | |
| `working` | |
| `blocked` | |
| `done` | |
| `unknown` | herdr had nothing to say, or the census did not answer |

<a id="sessionstatus"></a>
### `status` — sessionStatus

**Our session's** lifecycle, not the agent's. Null wherever there is no session
of ours.

<!-- contract-values: sessionStatus -->

| value | what it means |
| --- | --- |
| `initializing` | |
| `active` | |
| `terminated` | |

<a id="capboundby"></a>
### `capacity.capBoundBy`

<!-- contract-values: capBoundBy -->

| value | what it means |
| --- | --- |
| `cpu` | |
| `memory` | |
| `floor` | the cap would have been zero, and the floor lifted it |
| `configured` | somebody set it explicitly |

<a id="headroomboundby"></a>
### `capacity.headroomBoundBy`

<!-- contract-values: headroomBoundBy -->

| value | what it means |
| --- | --- |
| `cap` | |
| `cpu` | measured busy cores |
| `load` | `cpuBusyCores` was null and the load average stood in |
| `memory` | |
| `stall` | the veto: the counting terms allowed room and pressure vetoed it. `headroomBeforeStall` is what they allowed. **Added 2026-08-11 (KAN-216)** |

<a id="startschargebasis"></a>
### `capacity.startsChargeBasis`

<!-- contract-values: startsChargeBasis -->

| value | what it means |
| --- | --- |
| `cpu-window` | charged against the observed CPU window's own edges — a start is weighted by the share of the window it was **absent** for, so a start after the window closed costs a whole agent and one at its opening edge costs nothing |
| `load1-period` | nothing measured CPU, so the load average stands in and anything started inside the minute it means over is charged in full. **Not a second way of saying which term bound**: this names the instrument filling the CPU-side slot, so it reads `load1-period` even when count or memory is what refused |

<a id="costsource"></a>
### `capacity.agentMemorySource`, `capacity.agentCoresSource`

<!-- contract-values: costSource -->

| value | what it means |
| --- | --- |
| `override` | somebody set the figure. **The only one of the three that is durable** |
| `measured` | observed from a real agent tree |
| `seed` | the built-in starting estimate; nothing has been measured yet |

<a id="stallsource"></a>
### `capacity.stallSource`

Null when nothing measured.

<!-- contract-values: stallSource -->

| value | what it means |
| --- | --- |
| `io` | |
| `memory` | |

<a id="stallinstrument"></a>
### `capacity.stallInstrument`

**`absent` and `unreadable` are different kinds of nothing**, and a null
`stallPercent` means neither "quiet" nor the same thing in both cases.

<!-- contract-values: stallInstrument -->

| value | what it means |
| --- | --- |
| `measured` | |
| `absent` | a kernel without PSI |
| `unreadable` | a machine whose PSI would not answer |

---

## 9. How this is enforced, and where it stops

`scripts/verify-read-contract.mjs` is the live proof. It builds a real fleet on
a real daemon — every category populated, through real lifecycle calls — reads
both responses over the real MCP tools and the real socket, and asserts:

1. **This document against `src/read-contract.ts`, in both directions.** Every
   field in a table above is declared, and every declared field appears in a
   table, with the same bucket and the same optionality. Every declaration has
   exactly one table and every table names a declaration that exists.
2. **The declaration against a real response, in both directions.** A key on the
   wire that nothing declares is red; a non-optional declared field missing from
   the wire is red. Each `agent_status` branch is produced and its **exact** key
   set asserted, refusals included.
3. **The version, in one place.** Document, declaration and wire carry the same
   integer; the version table has a row for it whose digest matches the
   declaration; and `list_agents`, `agent_status` and `capacity` carry **no**
   version field, so "one place" is measured rather than claimed.
4. **This document's row-field buckets against the live `provenance` legend**, in
   both directions — the one join neither side owns.
5. **The stability statement, verbatim**, including all four of what it does not
   promise — a presence check, which makes deletion loud and claims nothing
   further.
6. **The red half.** The proof is watched failing: a field is added to a real
   response builder without a document line, a field is removed from a document
   table, and the declared version is bumped without its table row. Each runs
   against a mutated build and is required to go red **by name**.

### What is bound at BUILD time, and what only by the proof

`src/router.ts` asserts `Exact<keyof ListedAgent, keyof ROW_SHAPES.ListedAgent>`
and one of those for each **named** shape — every row type, the config echo,
`FleetPage`, `Provenance`, `ConfigEchoContract`, `PreemptedBy`, `OccupiedAgent`
— plus the closed vocabularies against their TypeScript unions. Those do not
compile when they drift.

**The response objects themselves have no such type.** They are assembled inline
and spread into `respond({…})`, and TypeScript has no exact type for an object
literal — so the top-level field sets of both responses, the four
`agent_status` branches, `herdrHealth` and `priorities` are held by the proof
and by nothing else. That is the weaker of the two mechanisms and it is named
here rather than left to be assumed. It is also the only one available for them,
and it asserts against a **real** response rather than a constructed one.

### What nothing here covers

* **`capacity`'s numbers are not checked for correctness by this proof** — only
  that the fields exist, are declared and are classified. The arithmetic is
  `verify-agent-capacity.mjs`, `verify-cpu-headroom.mjs` and
  `verify-io-stall-gate.mjs`.
* **The `config` echo's interior** is `verify-config-echo-contract.mjs`'s, and
  the row-field bucket classification's *correctness* — durable fields really
  surviving a restart, observed fields really moving with the census — is
  `verify-state-read-echoes-config.mjs` §7's. This proof asserts that this
  document **agrees** with that legend; it does not re-derive it.
* **Whether the version number was incremented** when it should have been. See
  §2 — the digest makes the change loud, and a human still has to bump.
* **Whether a notice was actually sent.** §1 is a promise kept by people, and
  no check in this repository can observe it. What is checked is that the
  sentence is still here.
* **Nothing here is a compatibility layer, a version negotiation, or a
  deprecation policy**, and none of the three is coming below 1.0. §1 is the
  whole of what is promised.
