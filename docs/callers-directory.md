# The caller's directory

An agent is a directory, and that directory is **yours**. CrabCast runs an agent
in a checkout you made, in a tree you own, next to work you care about. This
document is the whole of what that means for what appears in there.

## The principle

> The consumer's directory is theirs; CrabCast's state lives in CrabCast's
> directory; the only exceptions are artifacts another program will read from
> nowhere else — and each exception is **opted into**, **merged rather than
> replaced**, **named in the activation response**, and **reversible**.

Four properties, and all four have to hold. Any one of them alone is the version
that goes wrong: opted into but silent, or disclosed but unremovable, or
reversible but written over something of yours.

## Why this needed deciding at all

CrabCast used to allocate the directory an agent ran in — `<dataDir>/workspaces/
<type>/<key>` — so writing into it cost nobody anything. It was a disposable,
agent-owned scratch directory, and files dropped there were CrabCast's own.

Path identity deleted that. Every directory now arrives from the caller, so
every one of those writes became an edit to somebody's repository. There were
**four** of them, and the two nobody had counted were the more serious kind —
not file drops but **privilege changes inside the consumer's own configuration**:

| # | artifact | what it was |
| --- | --- | --- |
| 1 | `.crabcast-prompt.md` in the working directory | a file, rewritten on **every** activation |
| 2 | `.mcp.json` in the working directory | a file |
| 3 | `bypassPermissions` merged into `.claude/settings.local.json` | **a privilege change**, in your repo |
| 4 | a trust entry in your **global** `~/.claude.json` | **a privilege change**, not even scoped to the directory |

(3) was the sharp one. `bypassPermissions` in your own repository means the
*next* Claude Code session **you** start there runs with no permission gate at
all — and it was invisible, a merged key in a settings file nobody opened.

## What happens to each of the four

**1. The bootstrap prompt: moved out entirely.** It lives in the agent's sidecar,
`<dataDir>/agents/<hash>/prompt.md`, which is CrabCast's outright. The launcher
is handed its absolute path. This was the highest-value single change here,
because it was the file rewritten on every activation and therefore the likeliest
to show up as a spurious diff or be committed by accident.

**2. `.mcp.json`: the named exception.** It has to stay in the directory —
Claude Code reads MCP configuration from the project root and from nowhere else,
so there is no sidecar it would look in. So it is the one artifact that gets the
full four-property treatment; see below.

**3. `.claude/settings.local.json`: never written.** Deleted rather than made
conditional. CrabCast has no standing to set your permission posture in your own
repository. The one thing it bought that still matters — the agent not stopping
at a permission prompt nobody is there to answer — is on the launcher's command
line instead (`--permission-mode bypassPermissions`), where it is visible in the
process list and scoped to the process CrabCast started, rather than left behind
on disk for every later `claude` you run there.

**4. The `~/.claude.json` trust entry: still written, and disclosed.** It has to
be: it is the sole alternative to a human accepting Claude Code's folder-trust
dialog, and the alternative is an agent wedged on that dialog behind a success
answer — a failure this project has already paid for. What changed is that it is
no longer silent. See below.

## `mcpServers` is definitions, not names

`configure` takes the command, args and env that spawn each server, keyed by the
name the agent's runtime will see, and CrabCast **writes each value into
`.mcp.json` verbatim**. It resolves nothing, renames nothing, reorders nothing,
and never inspects a definition's interior.

```json
{
  "atlassian": { "command": "npx", "args": ["-y", "mcp-remote", "https://…"], "env": { "TOKEN": "…" } },
  "crabcast":  "builtin"
}
```

**Why not names.** A consumer assembles their server set at activation time from
whichever integrations are enabled *and hold a valid credential* — runtime state
that lives on their side of the boundary and never crosses it. So a name is not a
thing they can send: there is nothing here for it to name. `"atlassian"` is the
consumer's vocabulary in exactly the way a Jira ticket key was, and this daemon
gave up the right to hold either. Requiring a name would also require the
name-resolution table consumers have already deleted on their own side.

**Why a map.** The destination is a map — Claude Code reads
`{"mcpServers": {"<name>": {…}}}` — so a map is the shape that lets "written
verbatim" be literally true: the value written under key K is the value supplied
under key K, with no step in between that could rename or reorder anything. A
list of `{name, …}` records would have to be reshaped here, which is the exact
work this field promises not to do. It also makes one whole class of mistake
unrepresentable — you cannot both supply your own definition for a name and ask
for CrabCast's builtin under it, because one key holds one value.

**The one exception: `"builtin"`.** Exactly one server has a definition that
depends on facts about *this daemon* rather than about you — `crabcast`, whose
entry bakes in `CRABCAST_CONFIG` so a server spawned inside a workspace addresses
the daemon that provisioned it. You could not write it correctly, so CrabCast
does. Asking for a builtin it does not have is **refused**, naming what it has.

That entry also carries **`CRABCAST_AGENT_PATH`: the agent's own canonical
path**, and it is worth knowing what that is for. It is how an agent identifies
itself when it calls CrabCast, which is the whole input to `activatedBy` — the
supervisor of record. When an agent configures or activates another agent, the
daemon records *which* agent did it, so a fleet has an org chart rather than a
flat list.

It is here rather than in the pane's environment on purpose. This file is the
one artifact that is both **specific to one agent** and **outside that agent's
power to write**, so an identity placed in it is one CrabCast *issued*, not one a
caller *asserted* — and there is no `activatedBy` parameter on any verb, so
parentage cannot be claimed, only observed. A pane environment variable would be
inherited by every process the agent ever spawns, which is a different and much
looser thing.

Two consequences, stated because neither is obvious:

- An agent configured **without** the `crabcast` builtin is never identified —
  but it also has no way to reach the daemon, so it cannot activate anything.
- The **CLI is never identified**. A human at a shell has no supervisor of
  record, and `activatedBy: null` says so explicitly rather than by omission.

## Who becomes the supervisor of record, exactly

> **Only two calls may establish parentage: the `configure` that brings an agent
> into existence, and the `activate` that actually STARTS one.** Every other
> call carries the existing value forward.

`activatedBy` means *who stood this agent up*. So the calls that do not stand
anything up do not get to answer the question:

| call | mints? | why |
| --- | --- | --- |
| `configure` on a path with no record | **yes** | the agent comes into existence here |
| `activate` that starts a stopped agent | **yes** | this call is what put it there |
| `activate` on an agent already running | no | it re-attaches a terminal and repairs a record |
| `configure` on an existing agent | no | changing a knob is not standing it up |
| `deactivate` | no | stopping an agent is not activating it |
| boot-time restoration | no | the machine came back; nobody decided anything |

**This is not a refinement, it is a defect class.** Identity taken from whoever
is *converging on* or *attached to* an agent answers "who is looking at this",
which coincides with "who started it" often enough to pass a casual test and
diverges the moment anyone touches a pane they did not create. A reconciler that
polls `activate` to hold desired state would otherwise become the supervisor of
record for every agent in the fleet, and the org chart would redraw itself to
say so.

An agent may not be its own supervisor. Under the rule above a self-claim is
structurally unreachable — an agent must be running to call anything, and
neither minting call can come from an agent already up at the path it names — so
the guard that refuses it is defence in depth against a future third mint site.

**The residual, named rather than left to be discovered.** A stand-down followed
by a start **does** re-parent, because the start is a genuine start:

```
A activates X          → X.activatedBy = A
B activates X (up)     → X.activatedBy = A     ← converge; no re-parenting
B deactivates X
B activates X (down)   → X.activatedBy = B     ← B stood it up this time
```

So **whichever caller most recently started an agent is its supervisor of
record, and a caller that stops and restarts agents becomes the supervisor of
every agent it restarts.** That follows from the rule rather than qualifying it,
and it is written here because it is the kind of property that changes silently
when somebody refactors the thing that calls `activate`.

**This document does not say which callers that makes safe.** It states what the
daemon does; whether a given consumer's design collides with it depends on
decisions on their side of the boundary — how they converge, and whether one
component is the sole writer — which are not facts this repository holds. A
sentence here declaring some caller unaffected would be exactly the kind of
claim this project keeps filing against itself: a property asserted about a
category on the strength of knowing one path through it.

Proved by `scripts/verify-activated-by.mjs` §5, including the control that a
genuine restart by another supervisor *does* re-parent — without which
"parentage never changes" would satisfy the whole section.

```bash
crabcast configure /home/you/code/thing \
  --priority 5 --launcher claude \
  --mcp crabcast --mcp-config ./their-servers.json
```

`--mcp` names builtins. `--mcp-config` reads your own definitions from a file and
puts its **bytes** on the wire, for the same reason `--prompt-file` does: the
daemon never learns a path existed and never has to decide whose filesystem it
meant. A name in both is a usage error rather than a precedence rule.

## `.mcp.json`, property by property

**Opted into — by supplying the definitions.** There is no separate consent flag,
and its absence is a decision.

An earlier revision of this design required `provision: { mcpConfig: true }`
beside `mcpServers`, on the grounds that asking for a *capability* is a different
act from agreeing to a *file* appearing in your repository. That was right about
names. Definitions dissolve it: supplying definitions is handing over the literal
bytes of the `mcpServers` block, and there is no gap left between "here are the
exact contents" and "please write them". A flag beside them would not be a second
decision, only a second chance to forget one.

And forgetting it would not have been loud where it mattered. A consumer cutting
a whole fleet over at once, whose agents reach their issue tracker *through* MCP,
would have needed the flag on every activation to get any tools at all — and
would have found out agent by agent. One field cannot be half-supplied, so that
failure has no path here.

What the flag was buying — you *learning* that CrabCast writes into your
directory — is bought better by the `configure` response, which names the file
and the keys it will write, before anything is written:

```
$ crabcast configure /home/you/code/thing --priority 5 --launcher claude --mcp crabcast
configured /home/you/code/thing
  …
  mcp servers:   crabcast
  will write:    /home/you/code/thing/.mcp.json — crabcast at activation
                 Merged into your file if you have one; never replacing it. …
```

Being told the consequence beats being asked to assert it.

**All of them or none.** Every server you asked for must be writable, or the
activation is **refused** with nothing written and nothing started. Asking for two
and getting one is worse than getting neither: a `.mcp.json` that EXISTS looks
like success — the agent comes up, its runtime finds a config, and the missing
server surfaces only as work it quietly cannot do.

This is the shape of a defect that was real here. `mcpServers` was validated as
"an array of strings" and no further; the resolver kept the one name it
recognised and dropped the rest without a word; and the write early-returned on
the resulting empty map, so no file appeared at all. Three individually
defensible steps composing into a guard that read as a check and was not one:
`{"mcpServers": ["atlassian"]}` produced a running agent, with no tools, and
`success: true`. Definitions remove most of that by construction, and what is
left is counted rather than filtered — the empty case now means "you asked for
nothing", and can no longer also mean "your request was dropped one frame
earlier".

**Merged, never replaced.** Your existing file keeps everything in it; CrabCast's
server keys are merged in. Three things refuse the activation rather than
proceeding:

- an **unparseable** existing file — it is yours, and replacing a file we cannot
  read would destroy whatever it holds. (The old code replaced it, on the stated
  grounds that "CrabCast owns this file". It does not.)
- a **server key already there that CrabCast has no record of writing** — that
  key is yours, and quietly redirecting a server your own tooling depends on is
  not worth the convenience of not asking.
- a **write that fails** — you asked for those servers, and an agent started
  without them is one quietly missing what it was promised.

**Named in the activation response.** Every artifact appears under `provisioned`,
with the file, exactly what changed inside it, whether it was ours, and how to
undo it. The CLI prints all of it.

**Reversible.** `forget` removes exactly the keys CrabCast recorded writing, and
deletes the file only if CrabCast created it *and* nothing else is left in it.

One more write comes with this: when CrabCast creates the `.mcp.json` and the
directory is a git working tree, `.mcp.json` is added to that repository's
private `info/exclude`, so the file CrabCast made is not a spurious untracked
change in your `git status`. It is tracked and removed by `forget` like anything
else. It is the one write here whose failure does **not** refuse the activation —
it is tidiness on your behalf rather than something the agent needs, and failing
an activation over a read-only `info/` directory would be this daemon failing a
job nobody asked it to do.

## The trust entry

CrabCast writes `projects["<your directory>"].hasTrustDialogAccepted = true` into
your **global** `~/.claude.json`. This is outside the agent's directory, and it is
the one artifact here that is not opted into, because without it the agent stops
on a dialog nobody is there to accept and reports success while doing it.

What it is not is silent. It appears in the activation response naming the file,
the exact key, and how to remove it. And it is attributed:

> The trust entry is CrabCast's only if CrabCast observed it **absent** and wrote
> it. Decided once, at the first activation for that path, and never revised.

If you had already accepted the dialog yourself, the entry is **yours** —
disclosed as pre-existing, and `forget` will never touch it. If CrabCast wrote
it, `forget` removes that key and nothing else in the file.

## The antigravity CLI's global config — the shared one

An agent on the `anti-gravity` launcher gets its MCP servers merged into
`~/.gemini/antigravity-cli/mcp.json`. The antigravity CLI reads MCP config from
there and has **no project-scoped equivalent at all**, so unlike everything
above, this artifact is not merely outside the agent's directory:

> **One file, many owners.** Every agy agent this daemon runs has its servers
> written into the same file. There is no per-agent version of it to write
> instead.

That is what made "reversible" hard rather than merely tedious. Removing the key
when the first agent is forgotten takes the servers away from every sibling still
using it — so for a while this artifact had three of the four properties and said
so, on the grounds that a disclosed residue beats a reversal that breaks
somebody else's agent.

**It is reference-counted now.** `forget` reads every agent's provenance record
and removes CrabCast's key only when nothing else claims it. That buys the fourth
property, and it introduces a claim of its own — *"no other agent needs this"* —
which rests on records that can be incomplete. So the rule is asymmetric on
purpose:

> **An unremoved key is residue that was disclosed twice. A wrongly removed one
> silently breaks a running agent.** Those costs are not comparable, so anything
> the count cannot establish leaves the key and says what it could not establish.

Four things are checked, and only the last is about our own bytes:

| what | if it does not hold |
| --- | --- |
| the census could be taken at all | **left** — "I could not look" is not "there is nobody" |
| every sibling record was readable | **left** — an unreadable record may be exactly the agent that needs it |
| no other agent claims the key | **left**, naming the claimants **by path** |
| the value is still the one we recorded | **left** — removing it would destroy a change rather than undo ours |

And when it *does* remove, the response says **what that rested on** — that no
other agent's record claimed it, and how many records were read to find out. A
reader told only "removed" cannot tell a reference-counted removal from a blind
one, and those two differ by whether a sibling has just been broken.

### What the count cannot see

Stated here because a census read as complete is worse than one read as partial.

- **Another daemon's agents.** The scan covers one `dataDir`. Two CrabCast
  daemons with different data directories write the same global file and are
  invisible to each other.
- **Keys written by hand**, or by any agy user who is not CrabCast. Those are not
  claims and are not counted — the byte comparison is what protects them here,
  and the write-side refusal below is what now stops one becoming ours in the
  first place.
- **A write whose record never landed.** The file is written and the provenance
  recorded immediately after; a crash between the two leaves a key with no
  claimant.
- **Whether a claimant is running.** A configured-but-stopped agy agent still
  claims, deliberately: it will need the key when it starts, and `forget` is what
  retires a claim.

### The residue this leaves in the ordinary case

The `crabcast` builtin's definition carries **the agent's own path**, and this
file holds one value per key — so a second agy agent's activation overwrites the
first's definition. When the last remaining agent is finally forgotten, the value
on disk is often one *another CrabCast agent* wrote, which its own record does not
describe. It leaves the key, and reports it.

That is the safe direction, and it is disclosed rather than discovered. But it
means the ordinary multi-agent case ends in reported residue rather than a clean
removal. The cause is upstream of the reversal — **a shared file cannot carry
per-agent identity** — and has a second consequence worth knowing about while it
is open: every agy agent also reads whichever agent's `CRABCAST_AGENT_PATH` was
written last, so `activatedBy` for an agy fleet is decided by activation order.
Tracked separately rather than papered over here.

### And the write into it refuses the same three ways

For a while it did not, and the gap ran in one direction: this file's **removal**
was careful and its **write** was not. The same three refusals the `.mcp.json`
write has now apply here — an unparseable (or unreadable, or non-object) config,
a **key that is already yours**, and a write that fails.

The middle one is why this mattered more than a missing symmetry:

> Reference-counting made `forget` able to **remove** the key. So overwriting an
> entry of yours no longer merely clobbered its value — CrabCast recorded the
> key as its own, and a later `forget` then deleted it. **The byte comparison
> does not catch this**: it protects a key edited *after* we wrote it, not one
> that was yours *before*.

Every step in that sequence did exactly what it was designed to do, and the end
of it was your entry gone from your own file. The refusal stops it at step one.

**Whose key is it? Asked of every CrabCast record, not just this agent's.** The
file is shared, so reading the rule as *"I have no record"* would refuse the
**second** agy agent over the **first** agent's key — blocking an activation over
state that agent does not own. The question is *"CrabCast has no record"*, and
the evidence is the same fleet-wide census the reversal reference-counts with. A
sibling's key merges exactly as before; only a key that predates every CrabCast
record is yours, and only that one refuses.

**And there is a third answer.** The census can fail — a missing agents
directory, an unreadable sibling record — and an unestablished answer is not an
all-clear. It refuses too, naming what it could not read. That is the same
principle the removal side applies, pointing at the opposite action:

| deciding whether to… | when ownership cannot be established |
| --- | --- |
| **remove** a key (`forget`) | leave it — it may be one somebody still needs |
| **write over** a key (activation) | refuse — it may be one of yours |

Both are *do not touch what you cannot account for*. Only the verb differs.

This is bounded by being asked **only of keys already in the file**. An
activation with no collision — which includes every re-activation whose own
record explains its keys — consults no census and cannot be refused by any of it.

## `forget` — what comes back out

`forget` is the verb that makes an agent stop existing, and it is where every
write above is undone. Four rules, each a refusal wearing behaviour's clothes:

- **Exactly what we wrote.** Every removal is gated on a positive entry in
  CrabCast's own provenance record (`<dataDir>/agents/<hash>/provisioned.json`).
  No record, no removal.
- **Never a recursive delete, and never a directory of yours.** CrabCast cannot
  have created your directory — `configure` may not `mkdir` — so it never deletes
  one. The only directory removed anywhere is the agent's own sidecar, and even
  that is emptied file-by-file and then `rmdir`'d, so anything unexpected inside
  stops the removal and gets reported instead of swept away.
- **Nothing edited since we wrote it.** A server key whose current bytes differ
  from the bytes CrabCast recorded is somebody's change; removing it would
  destroy work rather than undo ours. It is left, and said so.
- **Everything is reported.** `removed` and `left` are both in the response, and
  `left` carries the reason. Residue is a sentence you read, not something found
  months later.
- **And a fifth, for the one artifact that is SHARED.** CrabCast's key in the
  antigravity CLI's global config comes out only when no other agent's record
  still claims it, and a count that cannot be established is a reason to leave
  rather than a reason to proceed. `removed` says what the removal rested on.
  See above.

## The resume rule

> CrabCast resumes a conversation at a path only when its **own durable record**
> shows CrabCast previously ran an agent there. Everywhere else the launcher
> starts a new session and no `--continue` is passed.

Claude Code keys its transcripts on the working directory. Under path identity
that directory is yours — so if you have ever run `claude` in
`/home/you/code/thing`, there is a conversation of **yours** sitting at exactly
the key an agent activated there would resume from. Without this rule, the first
activation in your repository runs `claude --continue`, restores your session
into an agent pane, and then nudges it to carry on with work it never started:
an agent reading your private conversation, having been told it is its own.

It is enforced on the **launcher's command line** rather than in the resume
predictor, and that distinction is the whole of the fix. Suppressing only the
predictor would change which prompt the agent is handed and nothing else — the
`--continue` in front of it still runs and still restores the transcript. So
`mayResume: false` drops that branch entirely.

The same rule answers a second question: an agent configured but never started
has no conversation to restore either, so the "switching this back on resumes the
conversation it was stopped in" promise is not made about it.

What it costs, stated rather than glossed: an agent whose CrabCast record has
been forgotten and re-configured starts fresh even though its own prior
conversation is on disk. That is the safe direction. The other failure — handing
somebody's session to an agent — is not one anybody recovers from by noticing
afterwards.

## Failure to provision refuses the activation

Every provisioning failure above refuses, with `started: false` and nothing
spawned. (This sentence was here before it was true of all of them: the write
into the shared agy config used to log and return, and the agent started. It is
true as written now — that was KAN-178 — and it is worth naming, because a
blanket sentence covering one launcher less than it claimed is exactly the shape
of defect this document keeps finding elsewhere.) This is not defensiveness; it
is a lesson with a receipt. A swallowed
prompt-file write once let an agent start with no instructions at all, behind
`success: true, verified: true` — a check rendering its own failure as an
all-clear. An agent that is quietly missing what it was promised is worse than an
activation that was refused and said why.

## What proves it

`scripts/verify-callers-directory.mjs`, which runs in CI. It asserts the before
and after of a caller's directory including dotfiles, that an existing
`.mcp.json` survives with its own servers intact, that the trust entry is
disclosed and reversed, that `forget` removes what CrabCast wrote and nothing
else, that a human's own conversation at the path is not resumed, that a
provisioning failure refuses the activation rather than starting a blind agent,
that a definition with awkward args, env and quoting arrives byte-for-byte with
its key order intact, and that **every** way of supplying definitions either
writes all of them or refuses — enumerated rather than illustrated, so "there is
no silent path" is a result rather than a claim.

"Nothing was started" is asserted against the herdr stub's own recorded argv
throughout, so it is evidence about what would have run rather than inference
from a response.

It also proves it can **fail**: the last section mutates the things it guards and
asserts the checks go red, because a check that cannot fail is not a check.

`scripts/verify-agy-mcp-reversal.mjs`, also in CI, covers the shared global agy
config: two agy agents really configured and really activated, the key surviving
the first `forget` with the remaining claimant named by path, the key going with
the last one, and every way the count can fail to be established leaving it
instead — each asserted on the diagnostic text as well as on the file, because
"removed" and "removed because nothing else claimed it" are different claims. Its
last section backs each behaviour out of a copy of the build and shows the checks
go red.

`scripts/verify-agy-mcp-write-refusals.mjs`, also in CI, covers the **write** end
of that same file. Its first section runs the data-loss sequence end to end — a
key of yours in the global config before CrabCast has seen the machine, an
activation, a `forget` — and requires your entry to still be there, byte for
byte, at the end of it. Its last section runs **the same sequence** against a
build with the refusal backed out and watches your entry be **deleted**, so the
first section is a measurement of something that really can happen rather than a
description of it. Two positive controls sit between them — a key CrabCast wrote
(re-activation) and a **sibling's** key (the shared-file case) — because every
refusal assertion in that file would also pass against a write that refused
everything, and a guard indistinguishable from a wall has not been shown to be a
guard.

**What no proof in this repository covers**, said here rather than left as an
assumption: nothing runs a real `agy` binary or a real agy fleet. That the
antigravity CLI reads this file, at this path, in this shape is carried from the
launcher's original author and is tested nowhere. The bookkeeping has an owner;
the runtime behaviour does not.

`scripts/verify-activated-by.mjs` covers the `CRABCAST_AGENT_PATH` half, and it
is deliberately arranged so that it cannot pass without the identity genuinely
arriving: it reads the `.mcp.json` the daemon wrote, spawns the real MCP server
with the environment **out of that file**, and lets two agents build a
three-level chain. Nothing in that section types an identity in — because a
proof that supplies its own input has not tested that the input arrives, which
is precisely how this feature shipped broken elsewhere.
