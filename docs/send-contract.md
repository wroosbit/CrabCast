# The CrabCast send contract

CrabCast lets one agent type at another's terminal — `send_to_agent` — and
answers with a **verdict**: whether the message actually landed, whether it
demonstrably did not, whether that could not be established, or whether the
request never became a send at all. This document is what a consumer builds
against. Its executable half is `src/send-contract.ts`, and
`scripts/verify-send-contract.mjs` reconciles the two against a **real daemon's
responses** in both directions, so they cannot drift apart quietly.

**It exists because the verdict was a closed vocabulary a consumer must branch
on, with no published member list.** It was typed in `src/delivery.ts`, argued
for at length there, and proven behaviourally by
`verify-send-confirms-delivery.mjs` and `-live.mjs` — and published in no
document and no value set. A fifth member could have been added and nothing
anywhere would have gone red. Butchr branches on this field more than on
anything else CrabCast emits.

**This document does not replace [`docs/read-path-contract.md`](read-path-contract.md);
it sits beside it.** That contract answers *"what is true about an agent now"*
and its [§10](read-path-contract.md#10-the-boundary--which-responses-this-contract-covers-and-which-it-does-not)
names this document as where `send_to_agent` is covered. A send verdict is not a
fact about an agent — it is the outcome of a write to somebody else's terminal —
which is why it is published here rather than as a twelfth section there.

**A note on how to read the tables.** Every field table below is preceded by an
HTML comment naming the declaration it is bound to, and the proof matches them
by that name rather than by position — so a table that moves is still found, and
one added for a declaration that does not exist is caught. The second column is
the field's **provenance bucket**, the same four
[the read-path contract defines](read-path-contract.md#3-provenance-the-four-buckets-and-what-an-absence-means),
followed by `, optional` where the field can be absent from a response.

---

## 1. The stability statement, and the version

**There is no compatibility guarantee below 1.0.** What there is instead is the
same notice promise the read path makes:

> **Any change to a field or a vocabulary documented in the send contract gets a
> consumer notice before or with the merge that changes it, naming the field,
> the old and new behaviour, and what a caller should do.** Below 1.0 we do not
> promise a field will not change. We promise you will not find out by breaking.

**The version of this document is not on the wire, and that is the one place
this contract is held more weakly than the read path.**
`daemon_status.contractVersion` tells you which revision of the *read-path*
contract the answering process implements. There is no equivalent field for this
one, so **you cannot ask a daemon which revision of this document it
implements.** You get the notice promise and the table below, and nothing
machine-readable.

That is a boundary rather than an oversight. Adding a second version integer
means a new field on `daemon_status` — a change to the wire, made to carry a
description of the wire — and KAN-329 was scoped to publish what `send_to_agent`
already returns rather than to change it. It is a decision for whoever needs it.

**What the version is still worth without a wire field:** the digest below is
computed from `sendContractCanonical()` in `src/send-contract.ts`, so a silent
change to any declaration stops the row matching and the proof goes red.

### Version history

<!-- send-versions -->

| version | date | what changed | digest |
| --- | --- | --- | --- |
| 1 | 2026-08-12 | initial publication (KAN-329) — the four-member response vocabulary with the three-member send vocabulary inside it, `send_to_agent_response` field by field over five branches, the [evidence](#4-the-evidence-block) block, and the version itself. **Additive on the wire: not one byte of any response changed** — this version describes a surface that was already there and was published nowhere | `b9a57b9b49d4` |

The digest is `sha256(sendContractCanonical())`, first 12 hex characters. **What
it buys:** changing a documented field, member or branch changes the digest, the
row stops matching, and the proof goes red — so a silent change is loud. **What
it does not buy:** it does not *force* the version to increment. A change can be
landed by rewriting this row's digest instead of adding one, and that is a diff
a reviewer sees rather than an omission they do not.

---

## 2. The vocabulary — three verdicts, four values

**A value you do not recognise must be handled as an unknown rather than errored
on.** This is the same must-ignore clause the read-path contract's §9 and the
event contract's §4 state, and here is what "handled as an unknown" means for
this field specifically: **treat it as `unverifiable`.** That is the
conservative posture — it licenses waiting and asking, and it does *not* license
the resend that `not-delivered` licenses.

### The trap, before the tables: three is not four

There are **two** sets, they are not two names for one thing, and the difference
is what catches a consumer:

* **`SendVerdict` has three members.** It is what a send that *happened* can
  conclude, and **every one of the three is a statement about a pane that was
  looked at.**
* **`SendResponseVerdict` has four.** It is what the wire can carry: those three
  plus `refused`, for a request that never became a send and therefore read no
  pane.

**`refused` is not a fourth thing a send can do.** It is the answer when there
was no send. Those requests read no pane, so they may not borrow
`not-delivered`, whose whole content is *"the pane was read and it is not in
it"* — that would be true in outcome and false in its basis.

**So a consumer switching exhaustively on `delivered` / `not-delivered` /
`unverifiable` meets the fourth as a default case.** The ticket that
commissioned this document was itself written expecting a three-way verdict.
Nothing in the type alias `SendResponseVerdict = SendVerdict | 'refused'` says
this out loud, which is exactly why it is said here.

<a id="sendverdict"></a>
### `SendVerdict` — what a send can conclude

<!-- send-values: sendVerdict -->

| value | what it means |
| --- | --- |
| `delivered` | the pane was read and this message appeared in it as submitted output that was not there before. A claim about the agent, and see [§7](#7-what-delivered-does-not-mean) for its exact limits |
| `not-delivered` | the pane was read, and the message is not in it as submitted output. **Evidence of absence** — you may act on it, resend, or route around |
| `unverifiable` | the pane could not be read, so nothing may be concluded. **The absence of evidence**, which is a different fact. The message may well have arrived |

<a id="sendresponseverdict"></a>
### `send_to_agent_response.verdict` — what the wire carries

<!-- send-values: sendResponseVerdict -->

| value | what it means |
| --- | --- |
| `delivered` | as above |
| `not-delivered` | as above |
| `unverifiable` | as above — **and answered by two branches with different shapes.** See [§5](#5-the-five-branches) |
| `refused` | the request never became a send: an address that resolves to no configured agent, or a message that is missing, not a string, or only whitespace. **No pane was read and no keystroke was issued** |

<a id="sendrefused"></a>
### `send_to_agent_response.refused` — why a request never became a send

**On the refusal branch only.** Do not read its absence as *"not refused"* —
`verdict` is the field that says that, and it is on every branch.

<!-- send-values: sendRefused -->

| value | what it means |
| --- | --- |
| `invalid-request` | the caller's request could not be turned into a send. Both refusals share it, because they are the same fact about the caller and the repair for both is the same: fix the request and call again |

**One member today**, published as a set rather than described as a constant,
for the reason `activate_response.refusedBy` gives for its own single member:
*"the only value it takes"* is exactly the kind of claim that stops being true
without anybody noticing.

---

## 3. `send_to_agent_response`, field by field

`optional` means **absent on at least one branch**; [§5](#5-the-five-branches)
gives the exact key set of each. An optional field is not a nullable one, and on
this surface the distinction has teeth: `evidence.landedBefore` is always
*present* and is `null` when the baseline read failed, whereas `evidence` itself
is genuinely *absent* on two branches. The first is an answer; the second is a
different shape of response.

<!-- send-table: SEND_RESPONSE_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `action` | derived | the response frame. Always `send_to_agent_response` |
| `path` | durable, optional | the agent this was addressed to, canonicalised. **Absent on the refusal branch — including when the path resolved perfectly well and it was the message that was rejected** |
| `success` | derived | `true` for `delivered` and nothing else |
| `delivered` | derived | the same fact as `success`, carried so that neither has to be inferred from the other's absence |
| `verdict` | derived | the four-member vocabulary of [§2](#2-the-vocabulary--three-verdicts-four-values). **On every branch, both outcomes** |
| `refused` | derived, optional | why the request never became a send. Refusal branch only |
| `interrupts` | derived, optional | Ctrl+C keystrokes this send issued. **Never more than 1, by construction** — a second is how Claude Code quits. Absent where nothing was typed |
| `submits` | derived, optional | Enter keystrokes this send issued: `2` means the confirm-and-retry fired, and **`0` means the submit was WITHHELD** — see [§6.1](#61-when-the-submit-is-withheld-submits-0) |
| `retried` | derived, optional | whether the Enter-only retry ran |
| `evidence` | observed, optional | the pane state the verdict was read from — [SendEvidence](#4-the-evidence-block). **Absent on two branches** |
| `error` | derived, optional | **absent if and only if the verdict is `delivered`** |

### What the four buckets mean on a response that is not a read

They were defined for state reads, and they are applied here deliberately rather
than by habit — the same argument `activate_response` makes for itself:

* **`observed`** keeps its exact meaning and is the honest home for everything
  in the evidence block that came off the pane. True when the reading was taken
  and not one moment longer.
* **`derived`** carries this daemon's account of its own actions and its
  conclusion from them. **`verdict` is derived and not observed, on purpose:**
  it is a judgement made from the counts in `evidence`, and putting it in the
  bucket that means *"read off the world"* would be the small dishonesty this
  whole surface exists to avoid.
* **`durable`** means what it always means. Exactly one field: `path`.
* **`remembered`** has no field here. Named rather than omitted, so its absence
  is a fact rather than a gap.

**And no legend checks any of it.** This response carries no `provenance` block
— neither does `activate_response`, and the read-path contract says so about
itself in the same words. The buckets above are held by this document against
`src/send-contract.ts` and by nothing on the wire. Adding a legend would change
the response, which is a decision rather than a description, and version 1 does
not make it.

---

## 4. The evidence block

**The verdict is auditable rather than merely asserted**, and this is what makes
it so: the before/after counts, whether the text was seen sitting in the
composer, how long it waited, and the tail it was read from. A verdict a caller
cannot audit is a verdict they have to trust, which is what the old
`success: true` asked of them.

**Seven fields are always present and two are conditional**, and that is a
property of one constructor rather than of eight call sites — `sendToAgent`
builds every outcome through a single helper that spreads defaults under
whatever the branch supplies. It is why this block cannot lose a field on a
branch somebody adds later.

<!-- send-table: SEND_EVIDENCE_FIELDS -->

| field | bucket | what it is |
| --- | --- | --- |
| `readable` | observed | whether the pane could be read at the moment the verdict was decided |
| `landedBefore` | observed | submitted copies of this message before anything was typed. **`null` means the baseline read failed**, and a `null` baseline is why a send herdr accepted can still be `unverifiable`: without knowing what the pane already held, a later match cannot be attributed to this send |
| `landedAfter` | observed | submitted copies at the verdict; `null` if the pane could not be read |
| `inComposer` | observed | whether the message was seen sitting **unsubmitted** in the composer. This is the witnessed failure, named as a state |
| `checks` | derived | how many times the pane was read while waiting |
| `waitedMs` | derived | how long the confirmation waited, in milliseconds |
| `tail` | observed | the tail the verdict was read from, capped at 4000 characters; `null` if the pane could not be read |
| `tailSource` | observed, optional | which herdr read source answered. **Present only where a read succeeded**, and `null` there means every source was asked and every one was empty — which makes an empty pane a finding rather than a failed look. A `not-delivered` carrying `tailSource: null` is asserting that more than one source agreed there was nothing there |
| `readError` | derived, optional | why the pane could not be read. **Present only where one could not be** |

**Why a count and not a boolean.** *"Is the message there?"* is the wrong
question when the same text may have been sent before — a notice about one agent
shares its opening with the notice about the next, and a supervisor's pane
legitimately holds both. What proves *this* send landed is that the count went
**up**, which is why there is a baseline at all.

---

## 5. The five branches

**Five branches and four verdicts**, and the arithmetic is the thing to read
twice: **`unverifiable` is answered by two branches with different shapes.** So
`verdict` does **not** tell you whether `evidence` is present.

These are **exact key sets, not minimums.** Every field on this surface is
decided by the branch, so knowing the branch tells you the keys, and the proof
asserts equality against a real daemon rather than a bound. (`activate_response`
needs two lists per branch because nine of its fields are spread conditionally;
this surface happens to be tidier, and saying so as one list is the stronger
statement.)

<!-- send-branches: SEND_RESPONSE_BRANCHES -->

| branch | verdict | exactly these keys |
| --- | --- | --- |
| `delivered` | `delivered` | `action` `path` `success` `delivered` `verdict` `interrupts` `submits` `retried` `evidence` |
| `not-delivered` | `not-delivered` | `action` `path` `success` `delivered` `verdict` `interrupts` `submits` `retried` `evidence` `error` |
| `unverifiable` | `unverifiable` | `action` `path` `success` `delivered` `verdict` `interrupts` `submits` `retried` `evidence` `error` |
| `unconfirmable` | `unverifiable` | `action` `path` `success` `delivered` `verdict` `error` |
| `refused` | `refused` | `action` `success` `delivered` `verdict` `refused` `error` |

### The two asymmetries, stated because a type alias will not state them

1. **`unconfirmable` answers `unverifiable` with no evidence block at all.** It
   is the branch where the bridge itself rejected — our own confirmation threw,
   which is a bug on this side rather than a fact about the agent. It carries no
   evidence and no keystroke counts, because the code that assembles evidence is
   the code that threw. **This is documented rather than repaired**: synthesising
   an evidence block there would mean reporting a reading nobody took. A
   consumer reading `evidence.readError` off every `unverifiable` meets
   `undefined` here.
2. **The refusal carries no `path`, even when the path was fine.** Both refusals
   — an unresolvable address and a blank message — go through the same site, and
   that site answers before the address is echoed. So a blank message sent to a
   perfectly good agent comes back without naming it.

Both are true of the code as it stands. Either could be changed; changing either
changes what `send_to_agent` returns, which is a decision rather than a
description, and version 1 makes neither.

---

## 6. What to DO with each verdict

This is the half a member list alone does not give you, and it is contract
rather than advice: **`not-delivered` and `unverifiable` license opposite
actions.**

| verdict | the safe action | why |
| --- | --- | --- |
| `delivered` | nothing — but read [§7](#7-what-delivered-does-not-mean) before depending on it | the strongest claim available from a pane, and it is weaker than "the work is under way" |
| `not-delivered` | **resend, or route around** | the pane was read and it is not there. Acting on it is what the evidence supports. **Read `submits` before you resend** — `0` means nothing was pressed at the pane ([§6.1](#61-when-the-submit-is-withheld-submits-0)) |
| `unverifiable` | **wait and look again; do not resend blindly** | the message may well have arrived. Resending types a duplicate at an agent that may already be working on the first copy — and every send begins with a Ctrl+C |
| `refused` | **fix the request** | nothing was typed at anybody. Read `refused`, not the absence of `evidence` |

**A caller that wants another attempt calls again**, and that is a fresh send
with its own single Ctrl+C. The daemon does not retry what it cannot see: an
unreadable pane answers `unverifiable` and stops, because typing again at an
agent nobody can observe is how a bounded retry becomes a loop of interrupts at
somebody's working agent.

<a id="61-when-the-submit-is-withheld-submits-0"></a>
### 6.1 When the submit is withheld — `submits: 0`

**A send presses Enter only when it can see the text it typed.** Where the typed
text does not appear on the pane, no Enter is issued, and **`submits: 0` is the
field that says so.** No field was added for this: a count that can be zero
already said it.

**Why an unpressed Enter is the safe one, and a pressed one is not neutral.**
Enter confirms whatever the pane currently has selected. If our text is not on
the pane, Enter cannot submit our message — so the only thing it can still do is
answer somebody else's prompt. Measured against a real Claude Code (KAN-383):

| the pane | what `send-text` did | what Enter would have done |
| --- | --- | --- |
| startup trust dialog, highlight left at option 1 | echoed **nowhere**; frame byte-identical | confirmed *"Yes, I trust this folder"* — folder trust granted |
| the same dialog, highlight moved to option 2 first | echoed **nowhere** | confirmed *"No, exit"* — **`claude` exited with status 1** |
| tool-permission dialog, highlight moved to option 2 | echoed **nowhere** | **ran the command** and granted the standing permission |

Option 2 was neither the default position nor the conservative answer in either
run. Its only property was being highlighted, which is what makes the mechanism
*"Enter confirms whatever is highlighted"* rather than *"resolves to option 1"*.

**What the daemon does NOT do, stated because the obvious design is the wrong
one: it does not detect dialogs.** Nothing reads their wording, their footer or
their shape. Two dialog kinds measured on the same afternoon render their
footers differently — *"Enter to confirm · Esc to cancel"* against *"Esc to
cancel · Tab to amend"* — so a detector tuned to either misses the other, and
both belong to a TUI that CrabCast does not own and cannot version-pin. The
condition read is about **our own message**: is the thing we just typed on the
pane? That is an observation rather than a guess, and it stays true however
Claude Code chooses to redraw itself.

**The consequences for a caller, which are the point of documenting it:**

* **`submits: 0` with `verdict: not-delivered`** — the pane was read, the text
  never appeared, nothing was pressed. **The pane was left exactly as it was
  found**, so **resending is safe** and does the same harmless thing. This is
  the state a send addressed to an agent sitting at a dialog now reaches.
* **`submits: 0` with `verdict: unverifiable`** — the pane could not be read
  after typing, so the submit was withheld rather than pressed blind. *"We could
  not tell"* does not resolve to *"press it anyway"*.
* **`interrupts` is unchanged and is still `1`.** The Ctrl+C is **measured inert
  at a dialog** — not dismissed, not cancelled, highlight unmoved, with a `Down`
  keystroke immediately afterwards proving the pane was listening. It is
  untouched here because it is not what damages a pane at a dialog, and its own
  justification is real: at a shell with a half-typed line one Ctrl+C clears it
  and the command does not run.

**Why this is not `refused`, since that is the value a reader expects here.**
`refused` means *the request never became a send* — [§2](#2-the-vocabulary--three-verdicts-four-values)
defines it as *"no pane was read and no keystroke was issued"*, and its branch
carries neither `interrupts` nor `submits`. By the time a submit is withheld a
pane **has** been read and a Ctrl+C **has** been issued, so `refused` would be
true in outcome and false in its basis — the one thing the four-member
vocabulary exists to prevent. **No vocabulary member was added and no field was
added**; the contract digest is unchanged, and an exhaustive consumer switch
gains no new case.

**The limit of the check, because a caller should not have to infer it.** *"Is
our message on the pane"* is only as sharp as the fingerprint asking it, and the
fingerprint has no minimum length — a one-character message asks a
one-character question. The count is taken over the **composer region** rather
than the whole pane precisely so that unrelated redraws cannot answer it, and
that closes the case found in review (an ordinary streaming line inflating the
count for `y` until the submit went out at a live dialog). **It does not close
the class:** a redraw inside the composer region could still inflate a short
needle, and the residual failure is a submit that should have been withheld.
**No minimum length is imposed** — `y`, `ok` and `go` must stay sendable — so
this is a named gap rather than a fixed one.

**And the cost, stated rather than hidden.** A withheld submit can leave a
message typed-and-unsubmitted in a composer — which is precisely the KAN-114
failure the delivery confirmation was built to catch. That is the deliberate
trade: an unsubmitted message is visible, recoverable, and **reported**
(`submits: 0`, plus `error`), while an answered consent dialog is none of the
three.

---

## 7. What `delivered` does not mean

Three limits. They are contract, not caveats, and a consumer that reads
`delivered` as *"the agent received this message alone and acted on it"* is
wrong in three separate ways.

**1. `delivered` means SUBMITTED, not ARRIVED INTACT.** The claim is that this
message's fingerprint appeared above the composer more times than before. It is
not that the agent received this message *by itself*. **Two sends in quick
succession can be submitted as one concatenated line** — the second's text is
typed into a composer the first is still sitting in — and both correctly report
`delivered` while the agent acts only on the first. This bit the fixture that
was written to demonstrate it, about an hour after it was first written down.
**The mitigation is the caller's and it is real work:** leave the recipient time
to swallow one message before sending the next, and if something downstream
depends on the first having landed, wait for evidence of *that* rather than for
this verdict.

**2. A delivered message can arrive with somebody else's text in front of it.**
The interrupt makes Claude Code restore its own in-flight prompt into the
composer, and this send's text is appended after it, so what is submitted is
`<their interrupted prompt><our message>`. The confirmation is unaffected — the
fingerprint is looked for anywhere in the submitted region — but the recipient
reads both.

**3. Nothing here is evidence the agent understood or acted on it.** The
strongest claim available from a pane is that the recipient's TUI cleared its
input buffer and committed the line. That is materially stronger than *"bytes
were typed"*, and materially weaker than *"the work is under way"*.

**And one limit on the mechanism itself:** on a pane with no recognised composer
marker — a bare shell, or a pane mid-scroll — submitted output cannot be
separated from unsent text, so presence anywhere in the pane is the only
evidence available. A `shell` agent's send is therefore confirmed **more weakly**
than a `claude` agent's. The alternative, calling every unrecognised pane
undeliverable, would report the failure this exists to catch on panes where it
did not happen.

> These four are restated from the argument in `src/delivery.ts`, which is where
> the reasoning and the witnessed incidents live. **Nothing reconciles the two
> prose copies** — the tables above are checked in both directions and this
> section is not. It is here because a consumer of a contract should not have to
> read TypeScript to find out what the strongest verdict promises.

---

## 8. The boundary — what this contract covers, and what it does not

**Covered:** the `send_to_agent_response` frame — every field in
[§3](#3-send_to_agent_response-field-by-field), the evidence block in
[§4](#4-the-evidence-block), the five branches in [§5](#5-the-five-branches),
and the three vocabularies in [§2](#2-the-vocabulary--three-verdicts-four-values).
That is document ↔ declaration ↔ a real daemon's responses, reconciled
pairwise in both directions.

**Not covered, and none of it has a notice promise:**

* **The request.** `path` and `message` are what a caller sends; this document
  describes what comes back.
* **The CLI's rendering** of a send, and the **MCP tool's `isError` mapping**.
  Both are downstream of `success`, and both can change without a field
  changing.
* **`SendVerdict` used internally.** `src/nudge.ts` carries one on its own
  record; that is not on this wire and nothing here describes it.
* **Timing.** How long a confirmation waits, how often it polls, the retry's
  existence, and **whether a given send presses Enter at all** are behaviour
  rather than shape. `verify-send-confirms-delivery.mjs` and
  `verify-submit-withheld-at-dialog.mjs` hold them. The *observable trace* of
  the last one is not behaviour and is contracted: it is `submits`, whose `0`
  is documented in [§6.1](#61-when-the-submit-is-withheld-submits-0).
* **Whether `COMPOSER_MARKERS` matches a real Claude Code pane.** That is the
  load-bearing assumption under every verdict on this page, and no shape
  contract can reach it. `verify-send-confirms-delivery-live.mjs` is what runs
  the same code against a real pane nobody wrote. **And it matches more than it
  was meant to:** a dialog's highlight caret is `❯`, so `splitAtComposer` finds
  a "composer" at `❯ 1. Yes` and reports the selected option as the input line.
  That is measured (KAN-383) and it is why the submit precondition in
  [§6.1](#61-when-the-submit-is-withheld-submits-0) does not rely on the marker.
* **The keystrokes a send issues, and what they do to a pane that is not at an
  ordinary prompt.** Those are behaviour rather than shape, so they are not on
  this contract's wire and carry no digest — but they are what a caller most
  often needs, so they are written down in
  [§10](#10-the-keystrokes-a-send-issues-and-why-the-interrupt-is-unconditional)
  rather than left in `src/herdr.ts`.

**This section is prose, and the read-path contract's §10 is data.** That is a
real difference and it is stated rather than smoothed over: the list above can
rot, and nothing will go red. What *is* data is the cross-document half — the
read-path contract declares `CONTRACTED_ELSEWHERE`, naming this document as
`send_to_agent`'s home, and its proof holds that to its own §10 in both
directions. So *"which document covers this surface"* cannot drift; *"what this
document declines to cover"* can.

---

## 9. How this is enforced, and where it stops

`scripts/verify-send-contract.mjs` is the proof. It reconciles three artifacts —
this document, `src/send-contract.ts`, and a **real daemon's**
`send_to_agent_response` read over a real unix socket — and drives four of the
five branches out of a real router by making them happen.

**What is bound at BUILD time, and is therefore not introducible at all:**

* The three vocabularies are `Exact<>`-bound to `SendVerdict`,
  `SendResponseVerdict` and `SendRefusal`. **A member added to a union without a
  line in `SEND_VALUE_SETS` does not compile.**
* `SendResponse` — the union of the three shapes the router can answer with — is
  asserted to have exactly the four response verdicts. **A branch answering a
  fifth word does not compile**, and neither does removing a word from the union
  while a branch still answers it.
* The field tables are bound to `SendOutcome` and `SendEvidence`. **A field
  added to either without a row does not compile.**

**What only the proof catches:**

* A member or a field that has a declaration but no row in *this document*.
  Compile-time binding reaches the code and cannot read markdown.
* The branch key sets, against what a real daemon actually answers.
* The digest, against the version table.

**Where it stops, named rather than left to be inferred:**

* **A `respond({…})` site that builds its object inline is invisible to the
  compiler**, because `Respond` is `(msg: any) => void`. The two off-outcome
  branches are built through typed constructors in `src/delivery.ts` precisely
  so they are not inline, and the proof scans the handler for bare `verdict:`
  literals — but that scan is a text search over one function, and a new handler
  elsewhere would be outside it.
* **One of the five branches cannot be produced by asking a healthy daemon
  nicely.** `unconfirmable` requires the bridge to reject, and the bridge is
  written never to throw. The proof produces it by mutating the compiled build
  so that it does, which is a real router answering a real socket — but the
  throw is manufactured, and that is said at the assertion rather than here
  only.
* **Nothing here is evidence about a real Claude Code pane.** Every branch below
  is produced against a herdr shim. See the last bullet of [§8](#8-the-boundary--what-this-contract-covers-and-what-it-does-not).

---

## 10. The keystrokes a send issues, and why the interrupt is unconditional

**This section is behaviour, not shape.** Nothing in it is on the wire, so it
carries no digest and no version row. It is here because a caller cannot read
`src/herdr.ts`, and because the first thing every consumer asks about this
surface is why their agent gets interrupted.

### What a send actually types

A `send_to_agent` that reaches a pane issues exactly three things, in order:

| # | keystroke | why |
| --- | --- | --- |
| 1 | one `Ctrl+C` | clears a partially typed line, so the message cannot be concatenated onto stray input |
| 2 | the message text | the payload |
| 3 | `Enter` | submits it — **only when the pane shows the text step 2 typed.** See [§6.1](#61-when-the-submit-is-withheld-submits-0) |

**Step 3 is conditional and steps 1 and 2 are not**, which is the whole of the
difference between this section and [§6.1](#61-when-the-submit-is-withheld-submits-0).
Read them together: that one says when the submit is withheld, this one says why
the interrupt in front of it is not.

A confirmation follows, and **the retry presses `Enter` only** — it never types
again and never interrupts again. **Exactly one `Ctrl+C` exists for the whole
call including its retry**, because a second is how Claude Code quits and would
kill the agent the caller is trying to reach.

### The decision: the interrupt stays unconditional (KAN-375)

**Decided 2026-08-13, on measurement rather than on argument.** The interrupt is
not conditioned on anything, there is no opt-out flag, and there is no plan to
add one.

**The measurement is `scripts/verify-interrupt-at-dialog-live.mjs`**, which
drives a real `claude` at a real startup dialog and reports:

* **One `Ctrl+C` at a Claude Code selection dialog does nothing at all.** The
  dialog is not dismissed, not cancelled, and its highlight does not move. This
  is asserted **with a control that can fail** — a `Down` sent immediately
  afterwards on the same pane *does* move the highlight, so the pane was
  demonstrably listening. Without that control the finding would be
  indistinguishable from a dead keystroke channel.
* **At a shell with a half-typed line, one `Ctrl+C` clears it and the command
  does not run.** The interrupt's stated justification is real and load-bearing.

**So the interrupt is exonerated, and this is worth stating plainly because the
opposite claim is written down elsewhere.** A consumer ticket records that
CrabCast's send *"opens with a Ctrl+C, which is the one thing a startup dialog
must not receive."* **Measured, that is false.** The Ctrl+C is the one thing such
a dialog demonstrably does not care about. Anyone repeating the claim should run
the probe before acting on it.

### The options not taken, and why

* **Condition it on something observable.** Rejected. The read that would drive
  it cannot cheaply tell the state apart: `COMPOSER_MARKERS` is `['❯', '│ >']`,
  and **`❯` is also the glyph a Claude Code dialog draws its selection cursor
  with** — so `splitAtComposer` reads a dialog cursor as a composer. Worse than
  that, `splitAtComposer` takes the **furthest** marker by `lastIndexOf`, so on
  a dialog frame it locks onto the **selected option** and identifies it as the
  input line about to be typed into.

  Telling a dialog from a composer therefore needs Claude-Code-specific chrome,
  and **that does not work either — measured, on KAN-383.** The trust dialog's
  footer is `Enter to confirm · Esc to cancel`; the tool-permission dialog's is
  `Esc to cancel · Tab to amend · ctrl+e to explain`. **A detector keyed on the
  obvious string misses the permission dialog completely, and a missed dialog is
  the whole defect back.** Any such detector also inherits Claude Code's redraw
  schedule as a dependency, on a daemon that drives `shell` agents too. That
  buys a new failure mode — a guess wrong in either direction — to condition a
  keystroke measured to be inert. **A wrong guess is worse than honest
  bluntness.**
* **Make it a caller's flag.** Rejected, and the default is why. The honest
  default is "send the interrupt", since that is what protects the common case;
  a flag defaulting that way changes nothing for anyone who does not set it,
  and a caller has no reliable way to know whether it wants the other value —
  it would have to read the pane, which is the option above with the work moved
  onto the caller.
* **Remove it.** Rejected. It reintroduces the silent concatenation §1 of the
  probe demonstrates it prevents.

### What a caller with a dialog open should do instead — and what the daemon now does for them

**The honest answer when this decision was taken was "not send", because the
hazard at a dialog was never the interrupt:**

> **The `Enter` at step 3 confirms whatever option is highlighted.** Measured
> twice, with the discriminator: with the highlight left at its default the
> dialog resolved to option 1; with the highlight moved to option 2 first, the
> same sequence resolved to **option 2** — an option that was neither the
> default position nor the conservative answer, and whose only property was
> being highlighted. The message text itself is swallowed and echoed nowhere.

**That was KAN-383, and it has since landed**, which changes this answer rather
than leaving it as advice. The submit is now **earned**: the pane is read between
step 2 and step 3, and the `Enter` goes out only when this message's own text is
visible. A dialog destroys the text, so the text is not visible, so **no `Enter`
is issued and the dialog is not answered.** `submits: 0` is what the response
carries, and [§6.1](#61-when-the-submit-is-withheld-submits-0) is where that
branch is specified.

**So the caller-facing answer is now: send, and read `submits`.** A send to a
pane at a dialog costs that pane nothing — one inert `Ctrl+C` and some text the
dialog discards — and reports that it did not land. The advice this section used
to give (establish the pane is not at a dialog first, with `tail_agent`) is no
longer required, and is kept nowhere but this sentence so that a reader arriving
from an older copy can see it was superseded rather than forgotten.

**What did not change is the reason this section exists.** The interrupt is
still unconditional, and the measurement above is still why: it is inert at the
dialog, so it was never the thing that needed conditioning. **KAN-383 conditioned
the keystroke that was.**

### Where this is enforced

`scripts/verify-interrupt-at-dialog-live.mjs`, excluded from CI (it needs a real
herdr, a real pane and an authenticated `claude`) and registered in
`scripts/verify-proof-registry.mjs`'s `EXCLUSIONS`. Its §0 pins the three
keystrokes above to `src/herdr.ts` by exact occurrence count, and its §6 pins the
`❯` collision this section's reasoning rests on — so both go red if the code
moves underneath them. `scripts/kan375-red-drive.mjs` is the demonstration that
they can: four mutations, each required to turn its named section red, including
one that breaks §2's own control.

**What §0 does not reach, said here because the table above invites the wrong
reading.** It pins the **call sites and their order**, not whether each one is
**reachable**. A guard placed above the `Enter` — which is exactly what KAN-383
landed — leaves all four calls textually intact, so §0 stays green while the
third keystroke becomes conditional. **Measured against KAN-383's branch before
it merged, and again on the merged tree: green both times.** That is the pin's
limit, not a defect in it.

**So the table above describes what a send issues when nothing withholds it, and
`submits` on the response is what tells a caller how many actually went out.**
