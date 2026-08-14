# The CrabCast read-path contract

CrabCast answers two questions about agent state — `list_agents` for the fleet
and `agent_status` for one agent — and one about an agent's *arrival*:
`activate_response`, which is the only surface that can tell you about the spawn
you just made. This document is what a consumer builds against. Its executable
half is `src/read-contract.ts`, which the router imports — the tables below and
the declarations in that file are the same tables, and
`scripts/verify-read-contract.mjs` reconciles them against a **real daemon's
responses** in both directions, so the two cannot drift apart quietly.

**It covers those three responses and three fields of a fourth, and
[§10](#10-the-boundary--which-responses-this-contract-covers-and-which-it-does-not)
names every surface it does not cover.** Read that section before assuming a
response you are consuming is described here — several are not, and the ones
that are not have no notice promise.

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
| 5 | 2026-08-11 | KAN-287 — **a third response is now covered**: [activate_response](#8-activate_response), field by field over eleven branches, with two new row shapes ([PaneOccupant](#paneoccupant), [ProvisionedArtifact](#provisionedartifact)), three new blocks ([PreemptionOffer](#preemptionoffer), [Preempted](#preempted), [CapacityOverride](#capacityoverride)) and five new closed vocabularies ([activateRefused](#activaterefused), [activateRefusedBy](#activaterefusedby), [resumeCause](#resumecause), [artifactKind](#artifactkind), [artifactOrigin](#artifactorigin)). **Additive on the wire: not one byte of any response changed** — this version describes a surface that was already there and was published nowhere. What is new is the document's own [§10](#10-the-boundary--which-responses-this-contract-covers-and-which-it-does-not), which states which responses this contract covers **and which it does not**, so the boundary is readable rather than inferred from what happens to be listed. A consumer that ignores all of it reads exactly what it read at version 4. **§10's two tables are themselves declared and reconciled** — `COVERED_SURFACES` / `UNCOVERED_SURFACES` — so the boundary cannot drift from the contract it describes | `0af7ded4dafc` |
| 6 | 2026-08-12 | KAN-329 — **the boundary gains a third value.** `send_to_agent` was published in a document of its own ([`docs/send-contract.md`](send-contract.md)), so it moved out of §10's Not-covered table into a new [Covered by a sibling contract](#covered-by-a-sibling-contract--described-and-reconciled-but-not-here) table, declared as `CONTRACTED_ELSEWHERE` and reconciled in both directions with the other two. **Additive on the wire: not one byte of any response changed, and no documented field changed meaning, was removed, or changed type.** Nothing this document covers grew or shrank — what changed is what it says about a surface it does not cover, which stopped being *"described by nothing"* and became *"described over there"*. Those are different answers and version 5 had no way to say the second. A consumer that ignores it reads exactly what it read at version 5 | `75d526b6f7ee` |
| 7 | 2026-08-12 | KAN-344 — three fields added to [UnreadableRecord](#unreadablerecord), and therefore to `unreadableRecords[]` on both `list_agents` and `daemon_status`: `claimsAt` and `claimsEvent` (`durable`, the row's own bytes quoted) and `standing` (`derived`, this daemon's verdict), with a new closed vocabulary [rowStanding](#rowstanding). **Additive: no documented field changed meaning, was removed, or changed type**, and no behaviour changed — the same rows are skipped, disclosed and carried across compaction as at version 4. What changed is that the disclosure now says whether a row MATTERS as well as why it could not be read. A consumer that ignores all three reads exactly what it read at version 6 and is not wrong; it is unable to tell a nine-day-old tombstone from a row claiming an agent, which is the question a real consumer asked and could not answer from the wire | `4d9c017c196c` |
| 8 | 2026-08-13 | KAN-338 — one field added to `capacity`: `measuredTreesSeen`, beside the `measuredAgentTrees` it reframes. **Additive: no documented field changed meaning, was removed, or changed type** — but one changed POPULATION, and that is why this row is not a formality. `measuredAgentTrees` was every agent-runtime process tree on the machine, whoever started it; the divisor is now measured only from trees joined to a chargeable agent of this daemon, so the same field now counts a subset. `measuredTreesSeen` is the population it was drawn from, and the pair is what lets a consumer tell a divisor averaged over 2 of 9 trees from one averaged over 2 of 2. A consumer that ignores the new field reads a number that is smaller than it was and means something better — which is exactly the change a version exists to announce, because it cannot be seen by comparing field sets. **The old quantity is recoverable rather than lost: `measuredTreesSeen` IS the pre-v8 population of `measuredAgentTrees`** — every agent-runtime tree on the machine, whoever started it — so a v7 consumer that wants the number it was reading before this version reads that field and gets it exactly | `80fe941b363b` |
| 9 | 2026-08-13 | KAN-279 — one field added to the **refused** `list_agents` response: `configEchoContract`, the same block a successful read carries, taking that refusal from three fields to four. No successful response changed, and no documented field changed meaning, was removed, or changed type. **What changed is that the two read surfaces stopped answering the same situation two different ways.** §2 of the [event contract](event-contract.md) states that the block rides *every* response so `undeclared: []` and "nobody looked" stay distinguishable; `agent_status` honoured that on all four branches — including `bad-address`, which resolves nothing and carries **no echo** and carried the block anyway — while a refused `list_agents` carried no block at all. The justification on record for that gap was "a refusal carries no echo, so there is nothing for the block to be about", which was true of `agent_status`'s `no-record-no-pane` branch and false of its `bad-address` branch; the surfaces were never divided by whether an echo was present, only by a wrapped responder against a bare `respond`. **What ignoring the new field costs a consumer:** it keeps the branch this version exists to remove — special-casing `list_agents` when reading the echo contract off whatever CrabCast answered, rather than one code path across both surfaces — and a consumer probing daemon vintage by the block's presence, which `crabcast_list_agents`'s own tool description tells it to do, read a **current** daemon as an older one off any refusal before this version | `4002acfc7a49` |
| 10 | 2026-08-14 | KAN-382 — one field added to the `bad-address` branch of **both** `activate_response` and `agent_status`: [pathProblem](#pathproblem), a new closed vocabulary of five members saying **why** an address was refused. The daemon already computed it — `canonicalPath` throws a `PathError` carrying `PathProblem` — and `MessageRouter.addressOfRequest` discarded it at the boundary, so five conditions with **three different remedies** arrived as one undifferentiated refusal. No other branch changed and no documented field changed meaning, was removed, or changed type. **It is MANDATORY on that branch, not optional, and that is the substance of this version rather than a detail.** An optional discriminator would mean both *"not a path problem"* and *"an older daemon"* — the `undefined`-on-`refused` ambiguity [§8 note 2](#three-things-about-this-surface-that-will-catch-you) discloses, minted a second time on a new field. Present always, it instead **removes** an ambiguity: `bad-address` was previously distinguishable only by the **absence** of `path`, and a consumer now identifies the branch positively by a key that is there. **What ignoring it costs a consumer:** exactly what it cost before this version — a directory deleted under a configured agent (`does-not-exist`, which `addressOfRequest`'s own header calls *"the normal way an agent ends"*) is indistinguishable from a caller that passed a relative path, so the remedy — recreate the directory or `forget_agent`, versus fix your own code — cannot be chosen from the response, and a reconciler reports an ordinary end-of-life as a hard failure. A consumer that keeps branching on the absence of `path` still works and still cannot tell those two apart | `6076769dba77` |

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

<a id="an-unreadable-row-never-clears-by-itself"></a>
### An unreadable row never clears by itself

**`unreadableRecordsTotal` does not fall on its own — and that one fact is what
makes both halves of the rule true at once. Read them together; neither is safe
to remember alone:**

1. **A steady value is expected and is not an alarm.** An unreadable row survives
   compaction by design — carried across verbatim rather than rewritten — nothing
   ages it out, and the only thing that removes one is a human repairing that
   line. So a non-zero count is the ordinary state of any registry ever written
   by another version of this daemon, and it may sit at the same number for
   months. A `1` that has been `1` since August is not a fault nobody got round
   to.
2. **And precisely because it never falls, ANY INCREASE IS AN ALARM.** This
   number moves upward only when a row this daemon cannot read has *arrived* —
   there is no churn under it, no window it is sampling, and nothing that can
   push it up transiently. **So a `1` becoming a `2` is a real event even though
   the `1` never was**, and it is worth reading every time.

**Both, or the sentence defeats itself.** A reader who keeps only *"not an
alarm"* has been taught to skip the field a second time, by the paragraph written
to stop them skipping it the first — which is the very defect this section
exists to describe, arriving one level up.

**Then read the row, not the number.** An increment whose new row is
[`standing: "retired"`](#rowstanding) is still boring; one whose new row is
`claims-an-agent`, with that `identity` absent from every readable category, is
the case the disclosure exists for.

**A sanctioned way to retire a row** — so the count *could* legitimately reach
zero — was considered for version 7 and deferred to
[KAN-356](https://wroosbit.atlassian.net/browse/KAN-356). It is a write against
the one file the preservation guarantee exists to protect, it needs a human at
the keyboard, and it answers a different question from *"does this row matter?"*.

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
| `configEchoContract` | derived | the [config echo contract](#configechocontract) block, exactly as on a successful read. `undeclared` is always `[]` here — a refusal carries no rows to sweep, and the block is the sweep saying so |

**Four fields since version 9, and the asymmetry with `agent_status` is gone.**
Versions 1 to 8 carried three, with no `configEchoContract`, and the
justification on record was that a refusal carries no rows and therefore no
echo, so there was nothing for the block to be *about*.

**That was true of one of `agent_status`'s two refusal branches and false of the
other.** `no-record-no-pane` does carry an echo, all nulls. `bad-address` —
`action`, `success`, `error`, `configEchoContract` — resolves nothing, looks
nothing up, carries no echo, and carries the block anyway. So the two surfaces
were never divided by whether an echo was present: they answered the **identical
situation**, an echo-less refusal, two different ways, and what actually
differed was a wrapped responder against a bare `respond`. §2 of the event
contract states the rule the broad way — the block rides *every* response, so
`undeclared: []` and "nobody looked" stay distinguishable — and
[KAN-279](https://wroosbit.atlassian.net/browse/KAN-279) made that sentence true
of both surfaces rather than one and a half.

**What a consumer that ignores the new field keeps.** The branch this was filed
about: it must special-case `list_agents` when reading the echo contract off
whatever CrabCast answered, and cannot write one code path across the two read
surfaces. A consumer that probed daemon vintage by the presence of the block —
which [`crabcast_list_agents`'s own tool description](../src/mcp.ts) tells it to
do, saying an absent block means an older daemon that never swept — got a
**wrong answer** off a refusal before version 9 and gets a right one after.

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
| `claimsAt` | durable | the timestamp the row gives for **itself** — its `at` — or null when it names none. **When the row was WRITTEN, not when it became unreadable**: a `from-newer` row became unreadable the moment somebody downgraded, which may be minutes ago on a row written last month. Quoted, never parsed or normalised |
| `claimsEvent` | durable | the row's own `event`, verbatim, or null when it names none. **In the row's own vocabulary** — a word this daemon does not know comes back as the word it is, not as a null. This is the evidence under `standing`, and on a `from-newer` row it is the only thing a consumer has to make its own call with |
| `standing` | derived | whether this row could be hiding something the list should have carried — [rowStanding](#rowstanding). This daemon's reading of `claimsEvent`; **`unknown` on every `from-newer` row even when the word is one we know** |

**Three of these are version 7's**
([KAN-344](https://wroosbit.atlassian.net/browse/KAN-344)), and they exist
because [an unreadable row never clears by itself](#an-unreadable-row-never-clears-by-itself)
— read that section first, because it is what makes the count the wrong thing to
watch and these rows the right one.

**Why a verdict AND its evidence, rather than either alone.** `standing` is this
daemon's reading; `claimsEvent` is the word it read. Shipping only the evidence
would make our event vocabulary load-bearing for every consumer, who would each
reimplement the mapping and then drift apart silently. Shipping only the verdict
would hide its basis — **an interpretation nobody can compare against the
underlying quote is one nobody can catch being wrong.** Together, a disagreement
between this daemon and its reader is *detectable rather than latent*, which is
the same reason `problem` ships with `reason` and `stallInstrument` with
`stalled`.

**`claimsAt` is a quotation, not a timestamp, and it is typed `string` on
purpose.** A field typed as a date that sometimes is not one is worse than a
string, because the type asserts something the value cannot honour — this row
came off a line nobody could read, and a hand-edited one may hold anything at
all.

**`standing` is about the ROW, not the agent**, and the obvious reading is the
wrong one. The registry is append-only and a row is one *event*, so a later
readable row may supersede this one entirely. `claims-an-agent` says **this line
asserts an agent**; it is not a claim that anything is running now, and the
daemon cannot make that claim — the line it would have to read is the line it
could not read.

**Which is what turns `claims-an-agent` into a branch rather than a number to
squint at.** The row is published beside a whole fleet read, so a consumer can
ask whether anything readable already covers the agent this line mentions.

**Join on `claimsPath` first, and fall back to `identity` knowing what it is.**
An agent **is** a canonical path, so `claimsPath` matches `path` in every
category directly. `identity` is deliberately *the row's own vocabulary* — it is
`agentName`, else `<type>/<key>`, else `path` — because its job is letting a
human find the line in the file. **On a pre-migration row it is very often
`<type>/<key>`, which matches nothing in a list keyed on paths, and the wire does
not say which form you are holding.** Reading a failed match of that as *"absent,
therefore lost"* would manufacture an alarm that never clears.

| `claims-an-agent`, and the join… | what it means | what to do |
| --- | --- | --- |
| **matched** — the path (or identity) appears in a readable category | a later readable row superseded this line. The fleet already knows about that agent | nothing. This is the boring case |
| **ran and found nothing** — `claimsPath` is a path and no category carries it | nothing readable supersedes it, so this row is the only thing that mentions that agent, **and it was not restored** | go and look. This is the case the disclosure exists for |
| **could not run** — `claimsPath` is `null`, and `identity` is in a vocabulary the categories are not keyed on | **the question was not answered.** This is not evidence either way, and it is the state of the specimen that commissioned this section | read `raw` and decide by hand, or repair the line. Do not record it as either of the rows above |

**The third row is not a hedge, and leaving it out was a real defect in an
earlier draft of this section.** *"We could not join it"* and *"we joined it and
found nothing"* are different answers, and collapsing them puts a permanently
unjoinable row into the *go and look* bucket for ever — an alarm that never
clears, which is the failure this whole section exists to describe. It is the
same distinction §3 draws between *not known* and *not true*.

`retired` needs none of this: nothing was going to be restored from it either
way. All three readings are the consumer's to make from one response — no second
call is needed, and none of them is a guess.

**Both `claims*` fields are read from the row's parsed object, never from
`raw`** — which by then may have been re-serialized to withhold a prompt and is
clipped at 2048 characters. So a row that names its `at` beyond that limit still
reports it. **And a line that does not parse as JSON never becomes one of these
rows at all** (see *A torn final line* below), so **`null` has exactly one
meaning: the row parsed and named none.** It never means *we could not see it*,
which is what makes it safe to branch on.

**On the daemon parsing what a consumer is told not to.** These two fields *are*
CrabCast reading the same bytes it publishes as `raw` — the difference is the
rule, and it is published: the daemon quotes **two named top-level keys,
verbatim, with no validation**, and says so here. A consumer parsing `raw` is
guessing at a shape this document has never promised and that `promptRedacted`
and `rawTruncated` are both allowed to change.

**What this list is not.** It is a fault report, not an inventory, so it is
bounded at 25 rather than paged — the five paged categories grow with the fleet
and have to be walkable, and this one is bounded by how badly one file has been
hand-edited. `unreadableRecordsTotal` is never clipped, and `daemon.log` carries
the full detail for whoever is repairing them.

**A torn final line is not one of these.** A power cut can leave a partial
record at the end of the log; that is expected, it is dropped, and reporting it
here would make an ordinary crash look like data loss. Only lines that parse as
JSON objects and are still unreadable appear.

<a id="paneoccupant"></a>
### `occupiedBy[]` — PaneOccupant

**On `activate_response` only** ([§8](#8-activate_response)) — the `occupied`
refusal, and a successful idempotent activation that found a co-occupant. `null`
never appears here: an empty list is not sent, the field is absent instead.

**All four are `observed`, and this is the clearest case of that bucket on any
surface.** It is one census read, quoted. Nothing is on a record — these panes
are very often not ours at all, which is the whole reason the refusal names them
— and nothing is re-checked after the response is sent.

<!-- contract-table: ROW_SHAPES.PaneOccupant -->

| field | bucket | what it is |
| --- | --- | --- |
| `paneId` | observed | herdr's id for the pane, or null when herdr named none |
| `name` | observed | the pane's name, as herdr reports it. **Not derived from a path** — that is the point of the row: this pane's name is very often not one any path of ours derives |
| `agentStatus` | observed | what herdr says the pane is doing — [herdrStatus](#herdrstatus) |
| `workDir` | observed | herdr's own cwd for the pane, or null |

**This is not a claim on the pane.** CrabCast never closes a pane it did not
start; naming one here is so that a human can decide about it.

<a id="provisionedartifact"></a>
### `provisioned[]` — ProvisionedArtifact

**On `activate_response`'s spawning branch only.** Every artifact the activation
wrote or relied on **outside CrabCast's own data directory**: what, where,
whether it was ours, and how to undo it. **Empty for an agent that opted into
nothing** — an empty array, not an absent field.

**`derived` throughout, and not `durable`, which is the classification most
likely to look wrong.** Every row describes a file on somebody's disk, so
`durable` is the tempting answer — but the bucket does not mean *persists*, it
means **read from the append-only agent registry**, and none of this is. It is
this daemon's account, composed during the call, of writes it had just
performed, and it is not re-read before being sent. `provisioned.json` is the
durable record of the same facts; this is the response's copy of them.

<!-- contract-table: ROW_SHAPES.ProvisionedArtifact -->

| field | bucket | what it is |
| --- | --- | --- |
| `artifact` | derived | which kind — [artifactKind](#artifactkind) |
| `file` | derived | the absolute path written or relied on |
| `detail` | derived | what changed inside that file, named the way a human would grep for it |
| `origin` | derived | `crabcast` or `preexisting` — [artifactOrigin](#artifactorigin) |
| `reversal` | derived | how to undo it — or, for a pre-existing artifact, why there is nothing to undo |

**Silence is what made writing into somebody's repository unacceptable; the fix
is not to stop writing, it is to stop being silent.** That is what this list is
for, and it is why it rides the response rather than only a log.

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
| `headroomBoundBy` | derived | which term set headroom — [headroomBoundBy](#headroomboundby). **This is the value that gained a fifth member on 2026-08-11; read the must-ignore clause in §9** |
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
| `measuredAgentTrees` | observed | trees attributed to this daemon's chargeable agents — what the divisor was averaged over |
| `measuredTreesSeen` | observed | agent-runtime trees the window saw on the machine, ours or not. This is what `measuredAgentTrees` counted before v8, so a consumer reading the old population reads this |
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

<a id="preemptionoffer"></a>
### `activate_response.preemption` — PreemptionOffer

**An offer, on a refusal. Nothing has been stood down.** It rides the `capacity`
branch when — and only when — there is something this activation outranks, and
it names what asking again with `preempt` would cost. Absent when there is
nothing to preempt.

<!-- contract-table: BLOCK_SHAPES.PreemptionOffer -->

| field | bucket | what it is |
| --- | --- | --- |
| `path` | durable | the agent that would be stood down |
| `paneName` | durable | its pane |
| `priority` | durable | what it is worth |
| `herdrStatus` | observed | what it was doing, from the census this refusal read — [herdrStatus](#herdrstatus) |
| `incomingPriority` | derived | what the refused activation is worth, for the comparison |
| `offer` | derived | one sentence naming what would be stood down and what authorises it |

**Named so a client can offer a button that says whose work it ends.** A client
that renders none of this leaves the user at a dead switch, which is the state
this block exists to prevent.

<a id="preempted"></a>
### `activate_response.preempted` — Preempted

**An event, on a success. This did happen.** It rides the spawning branch when
the activation freed its slot by standing something down.

**The difference from [PreemptionOffer](#preemptionoffer) is tense, and it is
the one confusion on this surface with a real cost.** Mistaking the offer for
the event reports an interruption that never occurred; mistaking the event for
the offer hides one that did. **No field name separates them — the branch
does**, and `success` is what tells you which branch you are holding.

<!-- contract-table: BLOCK_SHAPES.Preempted -->

| field | bucket | what it is |
| --- | --- | --- |
| `at` | derived | when the gate **decided**, not when the teardown finished |
| `victim` | derived | who lost the slot — a [PreemptionOffer](#preemptionoffer) block, the same shape the offer uses |
| `derivation` | derived | the capacity arithmetic that made the slot necessary |

<a id="capacityoverride"></a>
### `activate_response.capacityOverride` — CapacityOverride

Present **only** when the activation proceeded because the caller passed
`override` — that is, when the gate would otherwise have refused. Absent on an
activation that had room.

<!-- contract-table: BLOCK_SHAPES.CapacityOverride -->

| field | bucket | what it is |
| --- | --- | --- |
| `at` | derived | when the override was applied |
| `derivation` | derived | the arithmetic the gate **would have refused on**, kept so the override is auditable rather than merely permitted |
| `capacity` | derived | the full [Capacity](#capacity) report as it stood |

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
| `bad-address` | `success: false` — the address itself was rejected (relative, empty, not a directory). `pathProblem` says **which** | `action` `success` `error` `pathProblem` `configEchoContract` |

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
| `pathProblem` | derived, optional | **why** the address was refused — [pathProblem](#pathproblem). On **bad-address** only, and on every response taking it. `does-not-exist` cannot appear here: this verb resolves it lexically instead |
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

**It is also on `activate_response`, and as of version 5 that surface is
documented here too** — see [§8](#8-activate_response). It carries
`channelEnabled` on **both** successful branches, the one that spawns and the
idempotent one that finds the agent already running, with the same three-value
meaning as above. Both surfaces answer it from the same durable record, so they
agree for the same agent; `activate_response` exists for the case a poll cannot
serve, telling you about *the spawn you just made* where a later `agent_status`
could be describing a different one.

**What holds it, now that two things do.** `scripts/verify-channel-enabled.mjs`
asserts the *value* on both surfaces and that they agree — that is the check
that would catch this field answering wrongly. `verify-read-contract.mjs` asserts
that both surfaces *declare and document* it, in both directions. **Neither
substitutes for the other**, and the split is worth carrying: a field that is
documented and lying is caught by the first and not the second, and a field that
is correct and undocumented is caught by the second and not the first.

> **This paragraph used to say the opposite, and the change is the whole of
> KAN-287.** Until version 5 it read *"that surface is outside the contract …
> nothing here enumerates `activate_response`'s fields"*, and named the
> asymmetry rather than closing it. That was honest and it was still the defect:
> a guarantee holding for two responses and silently not for a third is worse
> than one holding for none, because a consumer cannot see where it stops. §10
> is now where the boundary is stated, and it is stated for every response
> rather than only for the one that happened to be noticed.

**No `statusSince` here, and that is deliberate rather than an omission.** The
memory is keyed on the sweep's census of our *live* agents, so this response
would carry a field structurally incapable of being anything but null. The
legend still announces the `remembered` bucket, the same way it announces
`workDir` on responses that do not carry one.

---

## 8. `activate_response`

**The one response that tells you what a call *did* rather than what is *true*.**
`list_agents` and `agent_status` answer questions you may ask again; this one
answers a question that has already happened, and asking again gets you a
different call's answer. That is why it is here: **it is the only surface that
can tell you about the spawn you just made**, where a later poll could be
describing a different one.

It is covered as of **version 5** (KAN-287). Before that it was consumed,
branched on by a real consumer, and described by none of the three artifacts —
while the two responses beside it were fully published. **The asymmetry was the
defect rather than the absence**: a consumer who has read this far reasonably
assumes a documented surface is the norm, and a guarantee that holds for two
responses and silently not for a third is worse than one that holds for none,
because the boundary is invisible. [§10](#10-the-boundary--which-responses-this-contract-covers-and-which-it-does-not)
is where every boundary is now stated at once.

### What the buckets mean on a response that is not a read

The four buckets in [§3](#3-provenance-the-four-buckets-and-what-an-absence-means)
were defined for *state reads*. They are applied here deliberately rather than
by habit, and one seam is worth stating before the table:

* **`observed` keeps its exact meaning, and it is the honest home for
  `verified`.** `verified: true` means the agent was found in herdr's census
  **before this response was sent** — a read, not a promise. `observed` is
  precisely the bucket that says *true when it was taken and not one moment
  longer*, so the strong word is qualified by the classification rather than by
  a footnote. Nothing re-checks it afterwards, and nothing here claims to.
* **`derived` carries this daemon's account of its own actions** — `started`,
  `reattached`, `recordReconciled`, `provisioned`, `durable`. These are not
  re-readable from anywhere. They are a report about a moment that has passed.
* **`durable` means what it always means** — on the registry, and answering the
  same after a restart. It is `path` (the registry's own key), `priority`,
  `launcher`, the five-field config echo and `channelEnabled`: the only fields
  here that outlive the process that sent them. Everything else on this response
  describes either a census read that has already expired or an action that has
  already finished.

**And one thing no bucket on this surface can tell you: `activate_response`
carries no `provenance` block.** Both read responses carry the legend that names
`observedAt` and `censusReachable`; this one does not. So the buckets below are
held by this document against `src/read-contract.ts` and by nothing on the wire
— they are **not** cross-checked against a live legend the way §11's check 4
does it for the row fields, because there is no legend here to check against.
**That is the one place this surface is held more weakly than the other two.**
Adding a legend would change the response, which is a decision rather than a
description, and this version does not make it.

### Field by field

`optional` means **absent on at least one branch**, exactly as on `agent_status`.
Only three fields ride all eleven: `action`, `success` and **`started`**. The
last is not an accident of drafting — it is on every refusal deliberately, so
that a caller can read *"nothing was spawned"* without first knowing which kind
of refusal it is holding.

<!-- contract-table: ACTIVATE_RESPONSE_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `action` | derived | always `activate_response` |
| `success` | derived | whether an agent is running at that path **because of or despite this call**. Not whether this call started it — that is `started` |
| `started` | derived | **on all eleven branches.** Whether *this call* spawned the agent. `false` on every refusal, and on the idempotent success |
| `error` | derived, optional | the whole refusal, in prose. On the nine refusals |
| `pathProblem` | derived, optional | **why** the address was refused — [pathProblem](#pathproblem). On **bad-address** only, and on every response taking it. All five members are reachable here, `does-not-exist` included |
| `path` | durable, optional | the agent's identity — its directory, resolved. Absent only on `bad-address`, where nothing was resolved |
| `paneName` | derived, optional | the pane name this path derives |
| `alreadyRunning` | observed, optional | `true` — it was already up; `false` — **this call started it**, on `spawned` and nowhere else; **absent** — a refusal that never reached the question. **Never `false` on a refusal**, and the compiler holds that half — see the note below |
| `paneId` | observed, optional | herdr's id for the pane, from the census that answered this call |
| `sessionId` | observed, optional | this daemon's handle for the agent's terminal. **On both successful branches**, so a caller can reach the agent it just asked about without a second call |
| `status` | observed, optional | our session's lifecycle — [sessionStatus](#status--sessionstatus) |
| `createdAt` | observed, optional | when the session was created |
| `verified` | observed, optional | **the agent was found in herdr's census before this was sent.** `true` on both successes; `false` on the three refusals that looked and could not confirm; absent on the refusals that never looked. Success is never reported without it |
| `priority` | durable, optional | from the frozen record. On the spawning branch and the `capacity` refusal. **A duplicate of `config.priority` wherever the echo is also present** — which is both successful branches. On `capacity` there is no echo, so it is the only copy and the only branch where it is load-bearing |
| `launcher` | durable, optional | from the frozen record. **On the spawning branch only, and a duplicate of `config.launcher`** — which the echo carries on both successful branches. Its absence from the idempotent branch removes no information from that response. Read the echo, and see the first note below |
| *config echo* | durable, optional | the five fields [above](#configecho), **re-read after the activation's own durable write** rather than taken from the intent this call opened with — which is how `everActivated` can read `true` here and remain a purely durable fact |
| `channelEnabled` | durable, optional | whether this spawn was channel-enabled — [channelEnabled](#channelenabled--was-this-spawn-channel-enabled). Answered from the record, not from the session, so this surface and `agent_status` agree **by construction** |
| `resume` | derived, optional | which cause the resume prompt was written for — [resumeCause](#resumecause). Only on a restore |
| `resumedConversation` | observed, optional | whether a conversation was there to hand back. `true` means the agent is sitting at an empty prompt and needs a nudge; `false` means it came up with the degraded-resume prompt and is already working. Only on a restore |
| `resumedExistingConversation` | derived, optional | **the resume rule, reported rather than merely obeyed.** `false` says this agent started a *new* session and did not continue whatever conversation the directory holds — at a caller-owned path, the difference between an agent starting work and an agent reading a human's private session |
| `provisioned` | derived, optional | [ProvisionedArtifact](#provisionedartifact) rows. **Empty rather than absent** for an agent that opted into nothing |
| `durable` | derived, optional | **present only when the registry write FAILED.** `verified` answers *does this agent exist*; this answers *will a restart know it does* |
| `durabilityError` | derived, optional | why it failed. With `durable` |
| `reattached` | derived, optional | present only when **this call** took the terminal back — the agent was running and unreachable, and now is not. Silent on the steady-state no-op |
| `recordReconciled` | derived, optional | present only when the disk disagreed with the world and this call settled it |
| `occupiedBy` | observed, optional | [PaneOccupant](#paneoccupant) rows — live panes here that are **not ours** |
| `note` | derived, optional | prose for a human, beside a co-occupancy that was **reported and not refused** |
| `refused` | derived, optional | the machine-readable kind — [activateRefused](#activaterefused). **On the pre-flight refusals**, by the rule in note 2 below; read that note before branching on its absence |
| `refusedBy` | derived, optional | which subsystem refused — [activateRefusedBy](#activaterefusedby). On the `capacity` refusal only — so a consumer branching on `refused` alone reads `undefined` on the **most actionable refusal this surface has**. See note 2 |
| `missing` | derived, optional | what `configure` would have to supply. On `not-configured` |
| `reason` | derived, optional | the capacity refusal in one sentence |
| `derivation` | derived, optional | the capacity arithmetic behind it |
| `capacity` | derived, optional | the full [Capacity](#capacity) report the refusal was made on |
| `preemption` | derived, optional | an **offer** — [PreemptionOffer](#preemptionoffer). Nothing has been stood down |
| `preempted` | derived, optional | an **event** — [Preempted](#preempted). Something has |
| `capacityOverride` | derived, optional | [CapacityOverride](#capacityoverride) — the activation proceeded only because the caller said so |

### The eleven branches, and exactly what each carries

**Two lists per branch, and the second is not a hedge.** On `agent_status` a
branch has an *exact* key set: every nullable field is emitted as an explicit
`null`, so the branch tells you the keys. **On `activate_response` that is not
true and cannot be made true without changing the surface** — nine fields are
spread conditionally, so the same branch legitimately answers with different key
sets on different calls. Collapsing that into one list would force a choice
between two lies: listing conditionals as always-present, or omitting them so a
real response carries keys the branch does not declare.

So **`always` is an equality** — exactly these keys, on every call taking that
branch — and **`sometimes` is a bound**: these may also appear, each under the
condition named above, and nothing else may.

<!-- contract-activate-branches: ACTIVATE_RESPONSE_BRANCHES -->

| branch | when | always | sometimes |
| --- | --- | --- | --- |
| `spawned` | `success: true`, `started: true` — this call started the agent | `action` `success` `path` `paneName` `alreadyRunning` `started` `paneId` `sessionId` `status` `createdAt` `priority` `launcher` `config` `configVersion` `configuredAt` `everActivated` `activatedBy` `channelEnabled` `verified` `resumedExistingConversation` `provisioned` | `durable` `durabilityError` `resume` `resumedConversation` `preempted` `capacityOverride` |
| `already-running` | `success: true`, `started: false` — it was already up | `action` `success` `path` `paneName` `alreadyRunning` `started` `paneId` `sessionId` `status` `createdAt` `verified` `config` `configVersion` `configuredAt` `everActivated` `activatedBy` `channelEnabled` | `reattached` `recordReconciled` `durable` `durabilityError` `occupiedBy` `note` |
| `bad-address` | the address was rejected — relative, empty, not a directory, or **gone**. `pathProblem` says which | `action` `success` `started` `error` `pathProblem` | — |
| `bad-flag` | `override` or `preempt` was not a boolean | `action` `success` `started` `error` `path` | — |
| `not-configured` | no `configure` has ever run for this path | `action` `success` `started` `error` `path` `refused` `missing` | — |
| `unverifiable` | herdr did not answer `agent list`, so occupancy could not be checked | `action` `success` `started` `error` `path` `refused` `verified` | — |
| `occupied` | live panes here and **none of them ours** | `action` `success` `started` `error` `path` `refused` `verified` `occupiedBy` | — |
| `capacity` | the capacity gate refused | `action` `success` `started` `error` `path` `refusedBy` `reason` `derivation` `capacity` `priority` | `preemption` |
| `spawn-error` | herdr refused the spawn | `action` `success` `started` `error` `path` | — |
| `attach-error` | the pane is ours and live, and taking its terminal back failed | `action` `success` `started` `error` `path` `paneName` `paneId` `alreadyRunning` | `recordReconciled` |
| `confirm-failed` | herdr reported success and left no agent behind | `action` `success` `started` `error` `path` `verified` | — |

**Ten of those eleven rows are checked against a real response. `attach-error`
is not, and you are told rather than left to assume it.** The proof produces
every other branch by making a real daemon meet a real condition; that one needs
`pty.spawn` to throw in the daemon's own process, and a herdr that refuses
`agent attach` fails in the *child*, where the code that records it is not. So
its row is reconciled between this document and `src/read-contract.ts` and is
**held by nothing on the wire** — and no sibling proof covers it either, which
is the part worth saying plainly: the honest answer to *"who checks this
branch's shape"* is **nobody**. `verify-read-contract.mjs` §2d prints the same
sentence in its own output rather than reporting eleven branches when it
exercised ten.

### Three things about this surface that will catch you

**1. The two successful branches are not symmetric — and for two of the four
fields the asymmetry is in a *duplicate*, not in the information.**
`priority`, `launcher`, `provisioned` and `resumedExistingConversation` ride the
**spawning** branch and not the idempotent one. A reconciling caller's ordinary
call is `activate` on an agent that is already up, so the response a reconciler
sees most often is the one missing those four keys.

[KAN-328](https://wroosbit.atlassian.net/browse/KAN-328) was staffed to decide,
per field, whether that is a defect. **The decision is that no field moves**, and
the reasoning is recorded here for all four rather than only for the two that
were ever in doubt — because a reader who finds two fields absent and no argument
will file this again.

* **`priority` and `launcher` are absent from the idempotent branch, and the
  information is not.** Both are read from the frozen record, and the record's
  whole `config` object is echoed on **both** successful branches — so
  `config.priority` and `config.launcher` answer the same question on the branch
  the top-level pair is missing from. Adding them would not close a gap; it would
  publish a second copy of a value already on that response, on the branch a
  reconciler reads most, forever. The pair predates the echo rather than
  complementing it: they arrived with `activate` itself (KAN-124), and the echo
  that subsumed them arrived one slice later (KAN-125). **Read `config.priority`
  and `config.launcher` on both branches** and the asymmetry never reaches your
  code.
* **`provisioned` and `resumedExistingConversation` stay off because what the
  idempotent branch *could* answer from is a different fact — not because
  nothing durable exists.** Something durable exists for each of them, and it is
  named here rather than left for a reader to find and conclude the argument was
  careless:
  * **`provisioned` is `session.provisioned` — every artifact *this activation*
    wrote.** A durable record of what exists *for the agent* is kept separately,
    in the agent's sidecar (`provisioned.json`, read by the exported
    `readProvenance` in `src/provisioning.ts`). **They answer different
    questions.** Publishing the durable one under this field's name would make
    one field mean *"what this call wrote"* on one branch and *"what is there"*
    on the other — which is worse than an absence, because an absence is legible
    and a silent change of meaning is not. Emitting `[]` instead asserts *"this
    activation wrote nothing"*: true of the call, false of the agent, since an
    earlier activation may have written plenty.
  * **`resumedExistingConversation` is `session.mayResume` — the resume decision
    *this spawn made*.** Its durable *input* is `everActivated`, which is already
    on both branches inside the echo; the decision itself is recorded nowhere.
    And it cannot be recovered from `everActivated` afterwards, because the
    activation that made the decision **sets `everActivated` to `true`** — so a
    later read of the record answers with the post-activation value rather than
    the one the resume rule actually saw.
  * And the idempotent branch may hold a session obtained by `attachSession`,
    which decides neither of them.

**The `channelEnabled` precedent is cited for the distinction it draws, not as a
rule this contradicts.** KAN-281 put that field on both branches with the
argument that *"a field present only on the spawning branch would be absent
exactly when it is asked for most"*, and that argument is right and applies here.
It is satisfied for `priority` and `launcher` by the echo. It cannot be satisfied
for the other two, and the reason is sharper than *"nothing is durable"*:
`channelEnabled`'s durable value answers **the same question the field asks**,
whereas the durable neighbours of these two answer **different ones**. A field
that changes meaning by branch is not the symmetry KAN-281 was arguing for.

**What would change this.** If the config echo ever stopped riding the idempotent
branch, `priority` and `launcher` would become genuinely absent rather than
merely un-duplicated, and this decision would be wrong the moment that happened.
`ACTIVATE_RESPONSE_BRANCHES` in `src/read-contract.ts` lists the echo's fields on
both branches, and `verify-read-contract.mjs` §2d asserts each branch's `always`
set as an **equality against a real response** — so that change cannot land
quietly. It was watched going red in both directions rather than assumed; see
`scripts/kan328-red-drive.mjs`.

**2. Which refusals carry a machine-readable kind is a RULE, not a count.**

This note used to say *"four of the nine refusals carry no discriminator"* and
leave it there. A count rots: it is wrong the day a tenth branch lands, and it
tells an author adding a refusal nothing about where theirs belongs. The rule
([KAN-376](https://wroosbit.atlassian.net/browse/KAN-376)):

> **`refused` names a condition CrabCast CHECKED AND FOUND before it attempted
> anything. It is not a stage label for an attempt that lost.**

**The pre-flight refusals carry a kind.** `not-configured`, `unverifiable` and
`occupied` carry `refused`; `capacity` carries `refusedBy`, because it names a
*subsystem* rather than a condition. On all four, nothing was spawned, nothing
was charged and nothing needed unwinding — and each has a remedy a caller can
**choose between** without reading prose: call `configure` (and `missing` says
with what), bring herdr up, stop the pane named in `occupiedBy`, or wait /
`override` / `preempt` with `preemption` naming whose work would end.

**The post-attempt failures carry none, for two reasons rather than by
omission.** Each of `spawn-error`, `attach-error` and `confirm-failed` ran an
attempt and then had to settle what it left behind: `spawn-error` and
`confirm-failed` unwind the start charge (`forgetAgentStart`), and
`attach-error` leaves the record it converged on the way in. Their remedy is
**identical**: retry or escalate. A
discriminator would let a consumer branch on a distinction that changes nothing
it can do. And `spawn-error`'s prose is **herdr's own string**, not CrabCast's,
so publishing it as a kind would make one field mean both *"the daemon declined
for reason X"* and *"an attempt failed at stage Y"*.

**`bad-flag` is in neither category, and that is a conclusion rather than an
omission.** The request never became a request about an agent: `override` and
`preempt` are written by the caller's own code, so a non-boolean is a bug fixed
by editing that code, never by branching at runtime.

**Do not read the absence of `refused` as "not refused"** — read `success:
false`.

#### What this rule leaves lossy, disclosed rather than left to be inferred

**Eight of the nine are machine-distinguishable and one pair is not.**
`attach-error` is the only refusal carrying `paneName`+`paneId`+`alreadyRunning`,
`confirm-failed` the only one carrying `verified` without `refused`, and
`bad-address` the only one carrying `pathProblem`.

* **`bad-flag` and `spawn-error` have *identical* key sets — the only such pair
  on this surface — and their remedies are opposite.** One means *your code is
  wrong* and is fixed by editing the caller; the other means *herdr refused or
  died* and is fixed by retrying or escalating. Only the prose in `error`
  separates them. **That the other eight are separable is what makes this one
  worth naming** rather than filing under "some refusals are vague".

**Two further items stood in this list until version 10 and both are now closed
by one field.** They are recorded rather than deleted, because what they say
about *how* they were closed is the part worth keeping:

* **`bad-address` used to be distinguishable only by the ABSENCE of `path`** —
  branching on an absence, which is the discipline this daemon refuses
  everywhere else, in those words. It now carries `pathProblem` on every
  response taking the branch, so the test is a key that is **there**.
* **`bad-address` used to flatten five causes into one prose string, while the
  daemon already computed the discriminator it dropped.** `canonicalPath` throws
  a `PathError` carrying `PathProblem`; `MessageRouter.addressOfRequest`
  returned `{ error: e?.message ?? String(e) }` and the cause went no further.
  **At least two of the five are reachable by a *correct* caller against a
  changing world** — `does-not-exist`, which `addressOfRequest`'s own header
  calls *"the normal way an agent ends"*, and `uninspectable`, a race or a
  permission wall — and their remedy is not the remedy a caller bug has. That is
  what [KAN-382](https://wroosbit.atlassian.net/browse/KAN-382) published, as
  [pathProblem](#pathproblem).

**Neither was closed by publishing a new `refused` member, and the reasoning is
here because the rule above nearly admits them.** Read literally, all five
`PathProblem` causes *are* conditions CrabCast checked and found before it
attempted anything, so the rule does not exclude them. What excludes them is
**granularity**: `refused` answers *"why did CrabCast decline this REQUEST?"* —
`occupied`, `not-configured`, `unverifiable` — and `PathProblem` answers *"what
is wrong with this one FIELD?"* Putting five path-validation members on `refused`
would make one field carry request-level reasons and field-level validation
detail at once, and a consumer switching on it would be switching across two
categories. `refused` gained no members at version 10.

**And `capacity`'s discriminator is on the other field.** The split is right —
`refused` answers *what condition*, `refusedBy` answers *which subsystem* — but
the consequence is easy to miss and is stated here rather than left to be
discovered: `capacity` is the ordinary refusal in a busy fleet and the one with
the most distinct remedies, and **a consumer that branches on `refused` alone
reads `undefined` there.**

**3. `alreadyRunning` is never `false` *on a refusal*, and the absence is
load-bearing.** On a **success** all three states are ordinary: `true` means it
was already up, and `false` — on `spawned` and nowhere else — means this call
started it. On a **refusal** only `true` and *absent* occur. `false` there would
read as *"we looked, and it is not running"*, which no refusal has established:
the `occupied` branch in particular knows only that the pane it found is not
ours. And reporting `true` there is the opposite failure, the swallow that turns
a safety refusal into a silent success.

**Each half is held by whichever instrument can actually hold it.**
`src/router.ts` types the refusal field `?: true`, so the compiler refuses the
dangerous value outright. Its **absence** on the `occupied` branch cannot be
typed — the same value is legitimate one branch over — so
`verify-idempotent-lifecycle.mjs` asserts the key is not present at all
(`!('alreadyRunning' in first)`, deliberately rather than `!== true`, which a
literal `false` would satisfy), and asserts `true` at the idempotent site that
earns it.

---

## 9. The closed vocabularies

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

<a id="activaterefused"></a>
### `activate_response.refused`

The machine-readable kind of refusal. **It is on the pre-flight refusals — those
naming a condition CrabCast checked and found before it attempted anything** —
and the rule, with the reasoning per refusal, is note 2 of
[§8](#three-things-about-this-surface-that-will-catch-you). Do not read its
absence as *"not refused"*: read `success: false`.

**What `undefined` means here, and the instrument that separates the two facts.**
An absent `refused` is **two different facts wearing the same clothes**: *"this
refusal has no kind"* and *"this daemon predates the field"*. The set is closed
and partial by the rule above, so the ambiguity is real rather than
hypothetical, and this section states which fact it is claiming rather than
leaving a consumer to guess.

**It is resolved by `contractVersion`, and the cost is a second call to a
different surface.** `refused` arrived at version 5. A consumer that has read
`contractVersion` **≥ 5** knows the field exists, so `undefined` from then on
means unambiguously *"this refusal has no kind"* — one fact, not two. ⚠ **But
`contractVersion` is published on `daemon_status` and nowhere else**
([§2](#2-the-version-on-the-wire), which says so in those words) — not on
`activate_response` and not on `list_agents` — so a
consumer holding an `activate_response` in its hand **cannot date it from that
response**. Read `daemon_status` once at connect and keep the answer; there is
no way to do it from this response alone.

**[activateRefusedBy](#activaterefusedby) has the identical shape with one
member and the identical ambiguity**, resolved the same way.

<!-- contract-values: activateRefused -->

| value | what it means |
| --- | --- |
| `not-configured` | no `configure` has ever run for this path, so there is nothing to activate |
| `unverifiable` | herdr did not answer, so whether anything is already running there could not be checked. **Silence, not evidence** |
| `occupied` | live panes are in that directory and none of them is ours |

<a id="activaterefusedby"></a>
### `activate_response.refusedBy`

Which subsystem refused. **One member today**, published as a set rather than
described as a constant — *"the only value it takes"* is exactly the kind of
claim that stops being true without anybody noticing.

<!-- contract-values: activateRefusedBy -->

| value | what it means |
| --- | --- |
| `capacity` | the capacity gate. The only branch carrying `reason`, `derivation` and the full [Capacity](#capacity) report |

<a id="pathproblem"></a>
### `pathProblem` — why an address was refused

On the **`bad-address`** branch of `activate_response` **and** `agent_status`,
and on no other branch of either. **Mandatory there**: every response taking that
branch carries it, so *"carries `pathProblem`"* identifies the branch positively
rather than by the absence of `path`.

**Why it is not optional, which is the substance of version 10.** An optional
discriminator would be absent for two unrelated reasons — *"not a path problem"*
and *"an older daemon"* — which is the `undefined`-on-`refused` ambiguity §8
note 2 discloses, minted a second time on a new field. Present always, it
removes an ambiguity instead of adding one.

<!-- contract-values: pathProblem -->

| value | what it means |
| --- | --- |
| `not-a-string` | the `path` argument was missing, not a string, or empty. **Your code** |
| `not-absolute` | relative. An agent is addressed by an absolute path: this daemon runs detached and its working directory belongs to whichever client first spawned it, so resolving a relative path here would answer a different question. **Your code** — resolve against your own cwd first |
| `does-not-exist` | absolute and well-formed, and nothing is there. **Not your code**: a deleted directory is *"the normal way an agent ends"*, and the record outlives it. Recreate the directory, or `forget_agent` the record |
| `uninspectable` | it resolved and could not be `stat`'d — a race or a permission wall. **Not your code**: retry, or fix the permission |
| `not-a-directory` | it exists and is a file, a socket, something. An agent runs in a directory. **Your code** |

**Three remedies across five members, and that is the whole reason this field
exists.** Before version 10 all five arrived as one refusal, so *"recreate the
directory"* and *"fix your argument"* were indistinguishable from the response —
and only one of them is a bug.

**Which members a surface can emit differs, and the vocabulary does not.**
`activate` requires the directory to exist (it is about to spawn into it), so all
five are reachable there. `agent_status`, `deactivate` and `forget` must keep
working *after* the directory is gone — that is exactly when *"stop expecting
this"* is asked — so they resolve `does-not-exist` lexically and answer about the
record instead. **`does-not-exist` therefore never appears on `agent_status`.**
One published list rather than two: the difference is a property of the verb's
strictness, and a second list would be wrong the day a verb changed it.

**There is no `unknown` member and there will not be one by accident.** A sixth
cause is a version bump with a notice — `src/read-contract.ts` binds this list to
`PathProblem` with `Exact<>`, so a member added to the type and not to the
contract does not compile. What the compiler cannot hold is *this table*; that
join is `verify-read-contract.mjs` §1.

<a id="resumecause"></a>
### `activate_response.resume`

Why a restore was a restore. **Only on a restore** — absent on an ordinary
activation, which is not an interrupted one.

<!-- contract-values: resumeCause -->

| value | what it means |
| --- | --- |
| `reboot` | the machine restarted and destroyed the terminal mid-task |
| `daemon-restart` | this daemon restarted; the pane did not survive with it |
| `preempted` | the agent was deliberately stood down to free capacity, and is being brought back |

<a id="artifactkind"></a>
### `provisioned[].artifact`

<!-- contract-values: artifactKind -->

| value | what it means |
| --- | --- |
| `mcp-config` | an MCP server configuration written for the agent |
| `git-exclude` | a line added to a repository's exclude file. **A courtesy rather than a requirement** — the one provisioning step that reports a failure instead of refusing the activation |
| `folder-trust` | a runtime's folder-trust record |
| `agy-mcp-config` | the `crabcast` builtin MCP server — the channel, and therefore the agent's identity. See [channelEnabled](#channelenabled--was-this-spawn-channel-enabled) |

<a id="artifactorigin"></a>
### `provisioned[].origin`

<!-- contract-values: artifactOrigin -->

| value | what it means |
| --- | --- |
| `crabcast` | this activation created it, and `reversal` says how to undo it |
| `preexisting` | it was already there and was relied on rather than written. **`reversal` then says why there is nothing to undo** — removing somebody else's file is not ours to do |

<a id="rowstanding"></a>
### `unreadableRecords[].standing`

Whether a row this daemon could not read could be hiding something the fleet
list should have carried. **This daemon's verdict on the row's own
`claimsEvent`**, which travels beside it so the verdict can be checked.

<!-- contract-values: rowStanding -->

| value | what it means |
| --- | --- |
| `retired` | the row records the agent being **switched off or removed** (`deactivated`, `forgotten`). Nothing was going to be restored from it, so the list is not short of anything that was ever going to run |
| `claims-an-agent` | the row records the agent being **configured or started** (`configured`, `activated`). It could be hiding a row the list should have carried — **this is the one to go and look at** |
| `unknown` | we will not say. The row names no event, or names something that is not one of ours — **or it is `from-newer`**, where the vocabulary is not this daemon's to read at all |

**The must-ignore clause bites harder here than anywhere else on this surface.**
The safe reading of a member you do not recognise is the one `unknown` already
has — *we will not say* — and **a consumer must never collapse an unfamiliar
value to `retired`**. Reading *"not a word I know"* as *"harmless"* is precisely
the wrong-conclusion-from-a-short-list this field exists to prevent, arriving one
level further up.

**Why `from-newer` abstains even when the word is one we know.** That
`problem`'s own `reason` says this daemon *"cannot know what a newer row means"*.
Reading its event vocabulary anyway would contradict that sentence in the same
response, on the one field a consumer is meant to branch on. The word still
travels in `claimsEvent`, for a consumer willing to make the assumption this
daemon is not.

---

## 10. The boundary — which responses this contract covers, and which it does not

**A contract that does not say where it stops is a claim outrunning its
mechanism.** Everything above describes three responses. CrabCast answers more
than three, several of them consumed today, and this section exists so that a
reader can tell which is which **without inferring it from what happens to be
listed**. That inference is what went wrong before version 5: `activate_response`
was consumed and undescribed, and nothing said so.

### Covered — documented here, declared in `src/read-contract.ts`, and reconciled against a real daemon by `verify-read-contract.mjs`

<!-- contract-covered-surfaces -->

| response | where | held how |
| --- | --- | --- |
| `list_agents` | [§4](#4-list_agents), rows in [§5](#5-the-rows), blocks in [§6](#6-the-blocks) | document ↔ declaration ↔ wire, both directions; row buckets also checked against the live `provenance` legend |
| `agent_status` | [§7](#7-agent_status) | the same, plus an **exact** key set asserted per branch |
| `activate_response` | [§8](#8-activate_response) | the same, with `always`/`sometimes` per branch — and **no legend cross-check**, because this response carries no `provenance` block |
| `daemon_status` | [§2](#2-the-version-on-the-wire) — **three fields only** | `contractVersion`, `unreadableRecords`, `unreadableRecordsTotal`. The rest of that response is out of scope on purpose and has its own proofs |

### Not covered — consumed, and described by nothing here

**These are surfaces a caller reads today. Nothing in this document, in
`src/read-contract.ts`, or in `verify-read-contract.mjs` describes them, and no
notice promise applies to them.** They are listed rather than left silent
because the listing is the only thing that makes the covered half readable as a
boundary rather than as a habit.

<!-- contract-uncovered-surfaces -->

| response | what a consumer does with it | what holds it instead |
| --- | --- | --- |
| `deactivate_response` | reads `wasRunning` and `state` to tell a stand-down from a no-op | `verify-idempotent-lifecycle.mjs` — behaviour, not shape |
| `configure_response` | reads the echo back and `configVersion` for compare-and-set | `verify-config-echo-contract.mjs`, `verify-reconfiguration-refuses.mjs` |
| `forget_response` | reads the refusal when a live pane blocks the forget | `verify-refuses-occupied-directory.mjs` |
| `pty_init` | a terminal client opens a session | `verify-pty-init-rejects-unknown-session.mjs` |
| `pty_input` | writes to it | `verify-pty-payload-refusal.mjs` |
| `pty_resize` | resizes it | `verify-pty-payload-refusal.mjs` |
| `tail_agent` | reads the tail and which source answered | `verify-tail-asks-every-source.mjs` |

**The rest of `daemon_status` is uncovered too** — `pid`, `build`, `freshness` and the agent counts — and it is not a row above because three of its fields *are* covered, which no single row can say. `verify-daemon-provenance.mjs` and `verify-daemon-status-over-mcp.mjs` hold it.

### Covered by a sibling contract — described and reconciled, but not here

**These surfaces have the full round trip; it is just not this document's.**
Each row names the document a consumer should read and the proof that holds it.

<!-- contract-elsewhere-surfaces -->

| response | where it is published | held how |
| --- | --- | --- |
| `send_to_agent` | [`docs/send-contract.md`](send-contract.md) | `scripts/verify-send-contract.mjs` — document ↔ `src/send-contract.ts` ↔ a real daemon's responses, in both directions, with the vocabularies bound to their unions at compile time |

**Why this table exists at all, rather than a note on a Not-covered row.**
Until version 6, `send_to_agent` sat in the Not-covered table with the note
*"published nowhere: no document, no `VALUE_SETS`, nothing reconciled"* — which
was true, and stopped being true when [KAN-329](https://wroosbit.atlassian.net/browse/KAN-329)
published it. It then had two places to go, and **both of them lie.** Leaving it
under a heading reading *"described by nothing here"* with a footnote saying it
is described elsewhere makes the heading false. Moving it to Covered makes *this*
document claim a surface it does not describe and its proof does not reconcile.

**"Covered by nothing" and "covered somewhere else" are different answers to the
only question this section exists to answer**, and a reader who cannot tell them
apart either goes hunting for a document that does not exist or gives up on one
that does. So the boundary is three-valued. `CONTRACTED_ELSEWHERE` is the
declaration, this is its table, and the proof holds them to each other in both
directions, requires the three lists to be pairwise disjoint, and requires every
named document and proof to exist as a file.

**Read that table for what it says and not for more.** Every one of those
surfaces has a proof, and several have better prose than some of what is
documented here. What they do **not** have is the document↔code↔wire round trip:
a field can be added to any of them, and nothing goes red. That is the
difference this contract is about, and it is the whole of the difference.

**`send_to_agent`'s verdict was the one flagged deliberately, and version 6 is
where it stops being flagged.** Version 5 named it a **closed vocabulary a
consumer must branch on, with no published member list** — the exact hazard
[§9](#9-the-closed-vocabularies)'s must-ignore clause exists to manage on the
surfaces that do publish theirs. [KAN-329](https://wroosbit.atlassian.net/browse/KAN-329)
published it, in a document of its own rather than as a twelfth section here,
and the row moved to the third table above rather than being deleted. **The
reason it is not a section here is worth carrying**: this document's subject is
what is true about an agent *now*, and a send verdict is the outcome of a write
to somebody else's terminal. Filing it here because the `VALUE_SETS` machinery
and the digest happen to live here would be putting a thing where the tooling is
rather than where it belongs.

### All three tables above are checked, and here is exactly what that check is worth

**The three tables are not prose.** `src/read-contract.ts` declares
`COVERED_SURFACES`, `UNCOVERED_SURFACES` and `CONTRACTED_ELSEWHERE`, and
`verify-read-contract.mjs` §1 holds them to the tables above in both directions.
So:

* **Deleting a row from any of the three is red.** That is not hypothetical — the
  first draft of this section *was* prose, and deleting the `agent_status` row
  from the Covered table left the whole proof green. The section whose purpose
  is to stop a reader inferring the boundary could silently disagree with it.
* **Adding a response to `src/read-contract.ts` without a row here is red**, in
  both directions: every response-level declaration must be claimed by exactly
  one Covered surface, and every declaration a surface names must exist.
* **A surface in two tables at once is red**, and so is a sibling contract whose
  document or proof is not a file that exists. A row promising a reader another
  document is worth exactly what the promise being checked is worth.
* **The boundary is in the version digest** — all three lists — so coverage
  cannot change without the digest moving and the version table noticing.

**And here is what it is NOT, stated because this is the section where a
sentence outrunning its mechanism would be worst.** The Not-covered table is
checked for *membership consistency* — the list and the document agree — and
**not for completeness**. Nothing enumerates every response CrabCast can emit,
so a ninth uncovered surface could exist tomorrow and nothing here would go red.
The Covered half is the half that is mechanically complete, and it is the half a
consumer is trusting. Read the Not-covered table as *"these are known to be
uncovered"*, never as *"these are the only ones."*

**The same limit applies to the sibling table, one level out.** That
`send_to_agent` is covered by `docs/send-contract.md` is checked here; that
`docs/send-contract.md` covers everything IT claims to is that document's own
proof's job, and nothing in this repository reconciles the two contracts'
boundaries against each other. Two documents that are each honest about what
they cover can still leave a hole between them, and this is where the edge of
this one is.

### The rule for what belongs here

A response earns a section when **a caller outside this repository branches on
it**. That is the test KAN-277 applied to the read path and KAN-287 applied to
`activate_response`, and it is the reason the rest of `daemon_status` is not
here while three of its fields are. Widening for its own sake is the
compatibility-surface creep this contract was scoped against; widening because
somebody is already depending on it is not a widening at all — it is
publishing what was already true.

---

## 11. How this is enforced, and where it stops

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
   set asserted, refusals included, and each `activate_response` branch is
   produced and its `always` set asserted as an **equality** with its
   `sometimes` set as a **bound**.
3. **The version, in one place.** Document, declaration and wire carry the same
   integer; the version table has a row for it whose digest matches the
   declaration; and `list_agents`, `agent_status` and `capacity` carry **no**
   version field, so "one place" is measured rather than claimed.
4. **This document's row-field buckets against the live `provenance` legend**, in
   both directions — the one join neither side owns. **`list_agents` and
   `agent_status` only**: `activate_response` carries no legend, and §8 says so.
5. **The stability statement, verbatim**, including all four of what it does not
   promise — a presence check, which makes deletion loud and claims nothing
   further.
6. **The red half.** The proof is watched failing: a field is added to a real
   response builder without a document line, a field is removed from a document
   table, a field is moved from an `activate_response` branch's `sometimes` list
   to its `always` list, and the declared version is bumped without its table
   row. Each runs against a mutated build or a mutated document and is required
   to go red **by name**.

### What is bound at BUILD time, and what only by the proof

`src/router.ts` asserts `Exact<keyof ListedAgent, keyof ROW_SHAPES.ListedAgent>`
and one of those for each **named** shape — every row type, the config echo,
`FleetPage`, `Provenance`, `ConfigEchoContract`, `PreemptedBy`, `OccupiedAgent`,
and `activate_response`'s five composites (`PaneOccupant`,
`ProvisionedArtifact`, `PreemptionOffer`, `Preempted`, `CapacityOverride`) —
plus the closed vocabularies against their TypeScript unions. Those do not
compile when they drift.

**Two of those unions were made unions by KAN-287 in order to be bound.**
`refused` and `refusedBy` were bare string literals written out at nine `fail`
sites, which is the shape that grows a tenth member silently; they are
`ActivateRefusalKind` and `ActivateRefusedBy` now. **Prefer the type to the
assertion where the choice exists** — an assertion can be deleted by a later
author and the build still passes, while an unrepresentable state cannot be
introduced at all. It earned its keep immediately: the first draft of the
`artifactKind` list guessed `agy-mcp` for a constant whose value is
`agy-mcp-config`, and the binding refused to compile rather than shipping a
document that was wrong.

⚠ **This paragraph used to end *"so a new refusal kind does not compile until it
has a line in the declaration and a row in §9"*, and the second half of that was
false** — corrected by measurement rather than by reading
([KAN-376](https://wroosbit.atlassian.net/browse/KAN-376)). **The compiler cannot
see this document.** Driven at `d4a851f`: adding a fourth member to
`ActivateRefusalKind` alone fails `tsc` at the `Exact<>` binding in
`src/router.ts`; adding it to **both** the union **and**
`VALUE_SETS.activateRefused`, with no row in §9, **typechecks clean**. Two
different mechanisms hold the two halves, and calling both *"a compile error"*
is the overclaim this section exists to prevent one level down:

| what moves | what stops it |
| --- | --- |
| the union drifts from `VALUE_SETS` | **the compiler**, `Exact<>` in `src/router.ts` |
| `VALUE_SETS` drifts from §9's table | **the proof**, `verify-read-contract.mjs` §1 |
| a branch gains or loses `refused` against the union | **the proof**, `verify-read-contract.mjs` §1 — added by KAN-376, because nothing held the rule itself |

`scripts/kan376-red-drive.mjs` drives all three and a false-positive control.

**The response objects themselves have no such type.** They are assembled inline
and spread into `respond({…})`, and TypeScript has no exact type for an object
literal — so the top-level field sets of all three responses, the four
`agent_status` branches, the eleven `activate_response` branches, `herdrHealth`
and `priorities` are held by the proof and by nothing else. That is the weaker
of the two mechanisms and it is named here rather than left to be assumed. It is
also the only one available for them, and it asserts against a **real** response
rather than a constructed one.

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
