# `args`: write every value with `=`, and why a variadic one eats your prompt

**Status: a decision, not a placeholder.** KAN-514 asked whether CrabCast can
detect the failure below rather than only document it. The answer written here
is **no, and deliberately so** — the reasoning is in [Why CrabCast does not
detect it](#why-crabcast-does-not-detect-it), and it is on this page rather than
only on the ticket because the next person will ask the same question.

Proof: `scripts/verify-variadic-args-swallow-prompt.mjs`, in CI. It drives a
scratch daemon, spawns both forms, and reads the argv of the process it started
out of `/proc` — so the mechanism below is measured on every run rather than
asserted here. Red drive: `scripts/kan514-red-drive.mjs` (a hand-run, not in
CI).

---

## The rule

**An `args` element that carries a value is written as ONE element, joined with
`=`.**

```jsonc
"args": ["--flag=value"]          // ✅
"args": ["--flag", "value"]       // ⚠ may silently consume the prompt
```

The two-element form is not wrong in general — it is wrong exactly when the
consumer's flag is **variadic**, and you cannot always tell which of a
program's flags are. Writing `=` costs nothing and makes the question moot.

---

## The mechanism

CrabCast's `claude` launcher builds this, and the ordering is deliberate and
unchanged:

```
claude --permission-mode bypassPermissions <your args…> --continue
  || claude --permission-mode bypassPermissions <your args…> '<the prompt>'
```

**The prompt is the final argument and it is a BARE OPERAND** — it carries no
flag of its own. That is the property everything below turns on.

A flag that takes a **fixed** number of values takes exactly those and stops,
so anything after it is somebody else's argument. A **variadic** flag does not
stop counting: it keeps taking arguments until it meets one that looks like an
option, or until argv ends. The prompt is neither an option nor the end of a
list — it is one more bare word sitting where the flag is still reading. So the
flag **swallows** it.

```
args: ["--dangerously-load-development-channels", "server:butchr"]

  claude … --dangerously-load-development-channels server:butchr 'Please read and follow…'
                                                   └──────┬─────┘ └──────────┬──────────┘
                                                   the flag's values, both of them
```

```
args: ["--dangerously-load-development-channels=server:butchr"]

  claude … --dangerously-load-development-channels=server:butchr 'Please read and follow…'
           └───────────────────── one argument ─────────────────┘ └──────── the prompt ───┘
```

**`=` binds the value to the flag.** There is then no bare word after the flag
for it to keep reading, so the prompt is a prompt. That is the whole of the
fix, and it is why this is a preference for a **type over an assertion**: the
mistake is not detected and explained, it becomes unwritable.

---

## What it looks like when it happens, which is nothing like the truth

⚠ **The failure does not mention arguments, ordering, or CrabCast. It complains
about your prompt.**

Measured on Claude Code 2.1.234, on a PTY, with the prompt `say hi`:

```
$ claude --permission-mode bypassPermissions \
    --dangerously-load-development-channels server:butchr 'say hi'
--dangerously-load-development-channels entries must be tagged: say hi
  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)
  server:<name>                — manually configured MCP server
exit 1
```

Read that as a caller who has not read this page: the runtime is telling you
that **`say hi` is a malformed entry**. It names your prompt text, calls it an
entry, and prints the format entries are supposed to take. Every obvious next
move — retag it, quote it differently, rewrite the prompt — is a move on the
wrong file. Nothing anywhere says *your argument ordering ate your prompt.*

The same command with `=`, one variable changed:

```
$ claude --permission-mode bypassPermissions \
    --dangerously-load-development-channels=server:butchr 'say hi'
… the client starts, with the prompt intact
```

**Through CrabCast the report is thinner still.** The spawned process exits
about half a second in, so what the caller gets back is a failed activation:
the agent did not come up, and the reason is in a pane that has already gone.
It wedges **every** spawn for that agent, not an occasional one — argv is fixed
at process start and the same argv is rebuilt on every activation, including
the `--continue` one that every already-existing agent takes.

---

## Why CrabCast does not detect it

**It cannot, and the version of it that could would be worse.**

**1. Arity is the consumer's fact, and CrabCast does not hold it.** Whether
`--flag` is variadic, takes one value, or takes none is a property of the
program in the pane. `args` is *generic argv* precisely so that CrabCast does
not need a table of anyone's flags — the field exists because which arguments a
caller wants depends on their runtime and their build of it, and a table here
would be a guess that goes stale the day the consumer adds a flag.

**2. The heuristic that looks right refuses correct configurations.** The only
detector available without arity is *"a `--`-looking element followed by a
non-`--`-looking element"*, and that is a false positive on every fixed-arity
flag anyone writes. `["--tag", "a b"]` is a legitimate two-element form that
works exactly as intended — it is in `verify-launcher-args.mjs`'s own fixture —
and a refusal would break it to protect against a flag it knows nothing about.
Refusing correct input to warn about a hazard that may not exist is worse than
the hazard.

**3. A warning that fires on correct input is a warning nobody reads.** The
same detector emitting advice rather than a refusal degrades into noise on the
common case, which is how a real warning stops being seen.

**So the answer is documentation plus a form that makes the mistake
unrepresentable**, on the four surfaces a caller actually meets: the MCP tool
schema, `crabcast configure --help`, the README, and this page.

### The one structural fix, and why it is not taken

A `--` before the prompt — `claude <flags> <your args> -- '<prompt>'` — would
end option parsing and stop any variadic flag at the separator. It is rejected,
for two reasons rather than one:

- **It is parser-specific dressed as a general fix.** `--` as end-of-options is
  a convention, not a guarantee, and CrabCast would be relying on the argument
  parser of a program it deliberately knows nothing about — the same knowledge
  it just declined to hold in point 1, borrowed back under another name.
- **It changes the argv every consumer sees, for every agent, forever**, to
  defend against a mistake one line of documentation makes unwritable. The
  ordering is correct as it stands (KAN-514 scoped changing it out
  explicitly), and the prompt must stay final and stay exactly one argument —
  consumers depend on both.

### The launcher that is already immune, and what it shows

`anti-gravity` passes the prompt as `-i '<prompt>'`. The prompt is **bound to a
flag**, so a variadic argument stops at `-i` and never reaches it — the same
binding `=` performs, done on CrabCast's side because that launcher's runtime
offers a flag to bind it to.

`claude` takes its prompt as a positional operand and offers no equivalent, so
on that launcher the binding is only available **on your side, in how you write
the argument.** That asymmetry is the reason this page exists rather than a
patch: it is not a defect in either launcher, it is a difference in what the
two runtimes let a caller bind.

---

## Checklist

- Write `--flag=value`, always, whatever you believe the flag's arity to be.
- If a value genuinely cannot be attached with `=` — a flag whose parser
  rejects the joined form — then **no position in `args` is safe**, because the
  prompt follows all of them. Reordering does not help; establish that the flag
  is not variadic, or do not pass it this way.
- If a spawn fails with a message that blames your prompt's *content*, check
  the argument form before you touch the prompt.
