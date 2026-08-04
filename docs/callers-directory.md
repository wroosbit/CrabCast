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
spawned. This is not defensiveness; it is a lesson with a receipt. A swallowed
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

`scripts/verify-activated-by.mjs` covers the `CRABCAST_AGENT_PATH` half, and it
is deliberately arranged so that it cannot pass without the identity genuinely
arriving: it reads the `.mcp.json` the daemon wrote, spawns the real MCP server
with the environment **out of that file**, and lets two agents build a
three-level chain. Nothing in that section types an identity in — because a
proof that supplies its own input has not tested that the input arrives, which
is precisely how this feature shipped broken elsewhere.
