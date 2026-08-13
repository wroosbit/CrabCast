# Moving baselines — the sweep, and what it found

**The question (KAN-361).** `verify-ci-wiring-guards` §2 was baselined against
`origin/main`. It was correct when written, and stopped being correct the moment
`origin/main` moved past the commit it was chosen for. KAN-354 pinned it. This
document is the answer to the question that ticket was really for: **is any other
proof in this repository baselined against something that can move?**

Everything below was measured at `69793df8` unless it says otherwise. Where a
claim is inferred rather than measured, it says so in the sentence.

---

## The class, stated so it can be enumerated

A proof has a moving baseline when **it acquires a second version of something to
compare against, and the identifier it uses to acquire that version is not
immutable.**

Three failure shapes, and §2 showed two of them:

* **It goes quiet.** The guard stops matching, the section prints `NOT RUN`, and
  it asserts nothing inside a green job. Nobody learns this from a passing build.
* **It goes wrong.** The baseline drifts into carrying the fix, and the section
  asserts the fixed thing is still broken — misattributing the cause to an
  innocent ticket.
* **It goes tautological.** The baseline catches up entirely and the comparison
  compares a thing against itself.

The sweep found a fourth, which is set out under Finding 2. Taking the decision
Finding 2 left open (KAN-363) found a fifth underneath it, which is set out under
Finding 4 — and which is **not** a moving-baseline failure at all, but the reason
one of them cannot be repaired by pinning.

---

## How this was enumerated

**Not by grepping for `origin/main`.** That finds the instance you were told
about and nothing else. The enumeration is over **acquisition channels**: to
compare against a second version, a script has to *obtain* it, and in a Node
script under `scripts/` there are only so many ways to do that. Each channel was
swept across all 70 `verify-*.mjs` plus the six helper scripts.

| # | Channel | What was searched for |
|---|---|---|
| 1 | `git` subprocess with a revision argument | `execFileSync/spawnSync/execSync` with `git`; then every revision-shaped literal and variable reaching `show`/`diff`/`log`/`rev-parse`/`merge-base`/`clone` |
| 2 | Network | `fetch`, `https.get`, `curl`, `wget`, `npm view/install`, `registry.npmjs`, `api.github`, `gh api`, `dist-tags`, `@latest` |
| 3 | Reads outside the repo working tree | `os.homedir()`, `process.env.HOME`, `~/`, `/home/`, `.local/share`, `/etc/`, `/usr/`, `/var/` |
| 4 | Build output against source | every `dist/` reference, and whether any script asserts a *relationship* between `dist` and `src` rather than importing `dist` as its subject |
| 5 | A running process | `crabcast.service`, `systemctl`, `net.connect`, socket paths, "already running" |
| 6 | Installed versus declared versions | `herdr` version reads, `node_modules/*/package.json`, dependency ranges |
| 7 | Time | `Date.now()` comparisons, `new Date()`, `Date.parse`, `mtime` |

**Would this method have found §2 without knowing about it?** Yes, and by
construction rather than by luck: §2 acquires its baseline with
`execFileSync('git', ['show', ...])`, which channel 1 enumerates whatever ref it
passes. The channel is defined by *how content is obtained*, not by what the ref
is called, so a section using `HEAD~1`, a tag, or a branch nobody has thought of
lands in the same net.

### What this method can miss — named at its nearest point

* **A moving baseline reached through an indirection the greps do not follow** —
  a ref read out of a file, an environment variable, or built by string
  concatenation several call-frames from the `git` invocation. Channel 1 finds
  the *invocation*; the sweep then read each one to find its ref, and that read
  is manual. The nearest real case is `verify-ci-proof-residue-is-legible`'s
  `git()` helper, whose refs are supplied by three different callers. **That one
  file now checks its own refs at the helper (KAN-369), which is the only place
  the ref that actually arrives is visible — see Finding 1. The weakness in the
  *method* is unchanged: every other script is still covered by a manual read.**
* **A baseline that is not a second *version* but a second *machine*.** Channel 5
  covers a live daemon; it does not cover anything that would differ between this
  machine and a GitHub runner without being a version of anything. Finding 3 is
  an instance, and it was found through channel 1 rather than channel 5 — which
  is evidence that the channels overlap, not that they are complete.
* **A pinned ref whose *expected verdict* drifts.** Not a moving baseline under
  the definition above, because the identifier is immutable. Discussed under
  `verify-readme-is-current` below, because it fails the same way.

---

## Results, per channel

**Channel 1 — git.** 23 invocation sites. Most are `git ls-files` (enumerating
tracked files — that reads the tree under test, not a baseline) or
`git status --porcelain` / `git rev-parse HEAD` (reading the current tree). Four
sites acquire a *second version* of a file:

| Site | Ref | Immutable? |
|---|---|---|
| `verify-ci-wiring-guards` §2 | `dff24229…` (`77ea91f^`) | **yes** — pinned by KAN-354 |
| `verify-readme-is-current` HISTORY | `72db4cd`, `e7ffb58`, `0edd2c1` | **yes** |
| `verify-daemon-provenance` | `e7ffb58`, `0edd2c1` | **yes** |
| `verify-ci-proof-residue-is-legible` §4 | ~~`['origin/main', 'main']`~~ — **the read is gone (KAN-369)** | **n/a** — see Finding 1 |

**Every host-side revision in that script is now immutable by construction, not
by review.** KAN-369 deleted §4's ambient read and put the rule in the `git()`
helper itself: a revision named against `repoRoot` must be a full 40-character
object name or `HEAD`, and anything else is refused and recorded. That closes
this table's own stated weak point for the one file it named — see *What this
method can miss*, first bullet, which singles out this helper because "its refs
are supplied by three different callers". The greps still find the invocation;
the helper now checks the ref, so an ambient read assembled through an
indirection is caught where a manual read of the call site might not be.

`kan114-send-before-and-after.mjs` also uses `origin/main`, and is a one-off
demonstration script rather than a proof: it is not in the CI array, nothing
gates on it, and it prints a before/after rather than asserting. Recorded here
so the next sweep does not have to re-derive that.
`kan369-red-drive.mjs` is the same kind of thing — the mutations behind §4d,
run one at a time, for a pull request rather than for a gate. Neither is a
standing guard and neither should be counted as one.

**If you are here to repin `verify-ci-wiring-guards` §2, read this first
(KAN-363).** `verify-ci-proof-residue-is-legible` §4c pins the same commit
`dff24229` for its own pre-fix arm, and **it does not depend on §2's pin** — it
reads nothing from that file. The two coincide because KAN-354 chose the pre-fix
point as §2's baseline, which is a reason and not a dependency. A first draft of
§4c asserted the two still agreed; **measured, that assertion could only ever
emit a false red** — repin §2 to current `main` and the target still exits 0,
§4c's arms still read 11 and 0, guard 2 still passes, and the proof goes 52/53 on
that one assertion alone. It was removed rather than reworded. **So repin §2
freely: §4c is not downstream of it, and nothing in this table is.**

**Channel 2 — network. Nothing.** No proof fetches anything at run time: no
`fetch`, no HTTP client, no `npm view`, no registry read, no GitHub API. The one
match was an error string telling the reader to run `npm install`. This is the
boring answer and it is worth having: there is no "latest of anything" in this
suite.

**Channel 3 — outside the working tree.** Every hit is *fixture construction* —
`process.env.HOME` reassigned to a `mkdtemp` directory, and literal paths like
`/home/someone/.local/share/crabcast/...` used as test data. No proof reads a
real home directory, and none reads `~/.local/share/crabcast/agents.jsonl`.

**Channel 4 — `dist` against `src`.** 20 sites reference `dist/`. In every one,
`dist` is **the subject under test** — the built artifact the proof is asserting
about — not a baseline it is compared against. No script asserts a relationship
between `dist` and `src`, so no script can go quiet or wrong when `dist` moves;
a stale `dist` makes a proof test the wrong code, which is a different defect
with a different owner (the build-freshness discipline, not this sweep).

**Channel 5 — a running process.** No proof touches `crabcast.service` or the
real socket. The three `-live` scripts each `mkdtemp` a scratch `dataDir` and
spawn their own daemon against it. The live wire is never a baseline.

**Channel 6 — versions.** `verify-herdr-version-notice` looks like it reads an
installed version and does not: it installs a **fake `herdr` shim** whose output
is set from `CRABCAST_VERIFY_SHIM_VERSION`, and drives it through eleven literal
version strings. That is a controlled fixture table, not a read of whatever is
installed.

**Channel 7 — time.** All `Date.now()` uses are timeouts and deadlines. No proof
compares against a wall-clock baseline.

---

## Finding 1 — `verify-ci-proof-residue-is-legible` §4 is on a moving ref, and has been dormant for 43 merged pull requests

> **Status (KAN-369, 2026-08-13): CLOSED — the read is deleted and the deletion
> is held by a mechanism.** §4 no longer acquires a baseline at all, so it no
> longer has a moving one. Dormancy is now a property of the file rather than a
> verdict read off the host, `git()` refuses any host-side revision that is not
> a full object name or `HEAD`, and §4d makes the removed read on every run and
> asserts it is refused. **The unreachable-ref red KAN-363 added is gone with
> it** — that reversal is argued below rather than assumed, because it undoes a
> decision taken one ticket earlier. See *CLOSED by KAN-369* at the end of this
> section; the paragraphs between here and there are kept as they were written.
>
> **Status (KAN-363, 2026-08-12): decided.** §4 stays dormant and is no longer
> silent about it — the dormancy is stated in the file, the unreachable-ref case
> is now red, the pointer at §5 is a checked assertion, and §4c demonstrates with
> a fixture why pinning is refused. **Re-measured at `2dd39eb`: 44 merged pull
> requests**, up one from the 43 below. The reasoning is under Finding 4.

`preFixTarget()` asks `['origin/main', 'main']` for the pre-fix
`verify-ci-wiring-guards.mjs`. Since KAN-172 merged at `13a247d`, `origin/main`
has carried the fix, so on a clean tree the section prints
`NOT RUN — origin/main already carries this fix` and asserts nothing. Measured:
43 merged pull requests between `13a247d` and `69793df8`.

**It does not misfire, and the reason is worth keeping rather than
congratulating.** §2's only guard was byte-equality against the working tree, so
editing `ci-workflow.mjs` broke the equality and woke it into eleven
misattributed `FAIL`s. §4 has a **second, semantic** guard —
`text.includes(REFUSAL)` — which asks whether the loaded baseline already carries
the fix rather than whether it differs from the tree. Measured: with the target
mutated by one appended comment line, §4 falls through to that guard, prints
`NOT RUN — origin/main's copy already refuses over a dirty ci.yml`, and the run
exits 0 with zero `FAIL` lines. **A content guard degrades quietly where a
byte-equality guard degrades loudly and wrongly.**

**What it stopped asserting is covered, deliberately, by §5 of the same file** —
"the durable half", which backs the fix out of the *current* code and makes the
same two observations. §5 was measured live and asserting. So the dormancy cost
coverage of "the defect as it actually shipped" and did not leave the property
unguarded.

### CLOSED by KAN-369 — all three outcomes of the read were wrong or useless

**Re-measured at `451aba4` before anything was changed**, because two tickets on
this epic have had their premise move underneath them: `preFixTarget()` still
read the host's `['origin/main', 'main']` with `cwd` defaulting to `repoRoot`,
and §4 was still dormant on this machine — `58/58`, printing
`DORMANT — origin/main already carries this fix`. The ticket was live.

**The finding that decided it is only visible once KAN-363 has already ruled that
§4 must stay dormant.** Given that ruling, each of the read's three outcomes is
independently indefensible:

| Outcome | When | Verdict |
|---|---|---|
| **Dormant** | the host's ref carries the fix — every honest clone | **A tautology.** `main` has carried the fix since `13a247d` and cannot stop having done so, so the read asked a moving ref a question whose true answer is a constant. |
| **Live** | the host's ref predates `13a247d` — an old clone, a fork, a bisect, a mirror that stopped fetching | **The revival Finding 4 forbids.** By Finding 4 every red a revived §4 can emit is a false one. The file's own header said *"nothing can make it live again"*, and **that sentence was false while this read existed.** |
| **Red** | neither ref is reachable | **A false red.** Measured by `task/KAN-364` in a constructed detached-HEAD checkout with every host ref deleted: `57/58`, the single red being the reachability assertion, in an environment that was in every respect fine for the work §4 actually does. |

**The reversal of KAN-363's reachability red, argued rather than asserted.**
KAN-363 made an unreachable ref red on `verify-daemon-provenance`'s reasoning —
*"a shallow clone that cannot reach these revisions has demonstrated nothing"* —
and that reasoning is sound **where the ref is the comparand of a live
demonstration**: reach it and something is demonstrated, miss it and nothing is.
KAN-363 simultaneously decided that nothing may ever be demonstrated in §4 again.
Once both hold, the ref is loaded on no path the section permits, and the red
announced that you had failed to reach a baseline it must not use. **The
principle is not abandoned, its subject is:** §4c keeps its own reachability
precondition and must, because §4c genuinely *loads* the bytes it pins.

**The options weighed, including do-nothing.**

| Option | Verdict | Why |
|---|---|---|
| **Pin `preFixTarget()` to `PRE_FIX_TARGET_REV`** | rejected | Self-defeating rather than merely wrong. `0edd2c1` is *by definition* the pre-fix target, so its text never equals the current one and never carries the refusal — the pinned read returns bytes on every machine and §4 goes permanently **live**. That does not pin the dormancy decision, it abolishes dormancy. The ticket warned that conflating the two questions would get this wrong; the literal reading of its own first option is the instance. |
| **Pin it to `KAN172_MERGE`** | rejected | It *does* yield dormancy deterministically — `13a247d`'s copy carries the refusal. Rejected as ceremony: an elaborate way of computing a constant, costing a git read that can only fail on a shallow clone, which reintroduces outcome 3's false red to answer a question with one possible answer. |
| **Do nothing; argue the exposure is cheaper** | rejected | On outcome 2. The cost is not the tautology — it is that an ordinary environment silently converts §4 into the false-red generator its own header spends sixty lines refusing to become. |
| **Delete the read and the branch it fed** | **chosen** | Dormancy stops being measured and becomes a property of the code. **This is not "delete §4"**, which KAN-363 rejected and which stays rejected: the dormancy statement, the §4c fixture and the checked pointer at §5 are all still there. What went is the dead live branch and the ambient read that was the only thing that could wake it. |

**What holds it, because a deletion cannot go red.** `git()` now enforces the
rule this document defines: a host-side revision must be a full 40-character
object name — immutable by construction — or `HEAD`, which is the *subject*
rather than a comparand and so is allowed by Finding 4's own rule. A violation is
**thrown and recorded**; the ledger exists because the code that was deleted
wrapped its read in `try { … } catch { continue; }`, so a refusal that only threw
would be turned back into silence by exactly the kind of caller an ambient read
tends to have. §4d then makes the removed read on every run and asserts all four
properties: it is refused, the pinned read still works, the sandbox is not
reached, and nothing else in the run made one.

**Measured after the change at `451aba4`:** the proof runs `62/62`, exit 0 — one
assertion removed (the reachability red), five added (§4d), and the seven
assertions of the deleted live branch were already never running. Every mechanism
was driven red alone by `scripts/kan369-red-drive.mjs`, each mutation asserted
applied with an exact occurrence count of 1: neutering the guard's call site
reddens `refused`, `cloneRef` and `ledger`; removing the ledger write reddens
`ledger` and `cloneRef`, with `refused` still green — **which is the
swallowing-caller case demonstrated**; allow-listing `origin/main` as a subject
revision reddens `refused` and `ledger`; reintroducing the deleted read inside the
same `catch` reddens `ledger` alone; re-exempting `clone` reddens `cloneRef` and
`ledger`; and refusing an immutable revision reddens `pinned`, which is what stops
that arm being vacuous.

### The `clone` exemption — found in review, and it is the interesting one

**The first version of this guard declared `clone` revision-free, and it was
wrong.** `epic/KAN-59`, reviewing [#89](https://github.com/wroosbit/CrabCast/pull/89),
measured `git clone --branch main` **completing** against the host with the guard
armed and returning `1f959175` — the shared clone's stale local `main`, the same
commit KAN-361, #87 and #88 each measured in turn. Finding 1's exact shape,
passing through the helper built to refuse Finding 1's exact shape, with the
ledger arm reading one refusal and the run green.

**Why that entry and no other.** Every other subcommand in `HOST_REVISION_ARGS`
names its revision *positionally*, so filtering out flags finds it. `clone`'s
positionals are **paths** — a `show`-shaped filter would flag `repoRoot` and the
destination as ambient revisions and break `buildSandbox` on the first call. So
`() => []` was the only entry of that shape that worked, and it silently also
exempted the place `clone`'s revision actually lives: the value of
`--branch`/`-b`. **The closed-by-default rule held for every undeclared
subcommand; `clone` was declared, and that is what opted it out.**

The entry now reads the option value in all three spellings (`-b x`,
`--branch x`, `--branch=x`), because covering two of them is how this class comes
back. A full object name is not a legal `--branch` argument, so this refuses every
`clone --branch` — the right answer rather than an awkward consequence, since the
sandbox's branch is *constructed* by `normaliseSandboxRefs`, and acquiring a host
branch by name is the ambient read §4 deleted.

**§4d's fifth arm holds it, and it asserts on the ledger and on the destination
rather than on the throw** — the reviewer's own correction adopted. Their first
probe keyed only on the refusal pattern, so a clone that failed for an unrelated
reason would have read identically to one the guard refused; they discarded it and
re-measured. A throw is therefore not sufficient evidence here: the ledger must
have grown **and** nothing must have been cloned.

**Not covered, and named rather than left to be assumed:** the ledger sees only
reads that reach the `git()` helper, so a direct `execFileSync('git', …)`
elsewhere in that file would bypass it. Nothing owns that — channel 1's manual
sweep below is what would find it, and this document already names that manual
step as the weakest link in its own method. And §4d's third arm cannot be driven
to a counted red: removing the host scope kills the run inside `buildSandbox`
before §4d executes, so its mechanism is demonstrably load-bearing but only by
killing the run, which the red drive reports as what it is.

## Finding 2 — pinning §4 does not fix it, because the pinned content is itself unpinned

The obvious fix is §2's fix: pin to `0edd2c1` (`13a247d^`, the last target that
absorbed residue). **It was tried and measured, and it makes the section red.**

The target at `0edd2c1` contains, at its own line 360,
`for (const ref of ['origin/main', 'main'])` — that commit predates KAN-354, so
the historical script *itself* reaches for a moving ref when executed. §4 loads
it and runs it, its nested §2 resolves `origin/main` to something post-KAN-148,
and it emits eleven `pre-fix:` `FAIL`s. §4's headline assertion —
"the shipped version ran to completion and reported ALL CHECKS PASSED" — then
fails on `exit 1`, for a reason that has nothing to do with residue. Six of §4's
seven assertions still pass; the contaminated one is the exit code.

**This is the fourth shape: a pinned baseline whose loaded content is itself
unpinned.** Pinning a ref pins the *bytes*; it does not pin what those bytes
*do* when executed, if they reach outside themselves at run time. It is the
reason this ticket does not carry the §4 pin: the one-line change makes a
dormant section into a red one, which is the worse of the two failure modes.

**The change was made, measured, and reverted.** The tree here carries no edit to
that script.

### KAN-363 correction — the one-line pin is not the only pin available

**Re-measured at `2dd39eb`, and the reproduction holds exactly**: pin §4 to
`0edd2c1` and the run goes 50/51, the single `FAIL` being §4's headline assertion
on `exit 1`, with eleven `pre-fix:` failures inside the loaded script. `gap: true`
appears 11 times in the historical target, so "eleven" is the case count and not a
coincidence.

**But the sentence above stops one measurement too early.** The loaded script's
moving ref is `origin/main` *as resolved inside the sandbox*, and the sandbox's
refs are this script's own to set. Measured at `2dd39eb`, running the historical
target over comment-only residue under three ref environments:

| sandbox `origin/main` | `pre-fix:` FAILs | verdict |
|---|---|---|
| as-is (`1f959175`, post-KAN-148) | 11 | exit 1, no `ALL CHECKS PASSED` |
| forced to `dff24229` (pre-KAN-148) | 0 | **exit 0, `ALL CHECKS PASSED`, 119 PASS** |
| both refs deleted | 0 (nested §2 `NOT RUN`) | exit 0, `ALL CHECKS PASSED`, 108 PASS |

So **pinning the ref *and* the ref environment does restore §4**, and the claim
that this shape has no pin is wrong. What is right is that it should not be
pinned anyway — for the reason in Finding 4, which is a better reason and a
different one.

## Finding 3 — the residue sandbox's `origin/main` is a per-machine artifact, and the script's own disclosure of it is false

> **STATUS: closed by KAN-364** (the disclosure half was corrected earlier by
> KAN-363/#87). The sandbox's ref environment is now constructed rather than
> inherited, and this finding's own claim about what a CI runner would supply
> turned out to be backwards. See *CLOSED by KAN-364* at the end of this section
> — the paragraphs between here and there are kept as they were written.

`verify-ci-proof-residue-is-legible` builds its sandbox with
`git clone <repoRoot> <sandbox>`, and its header discloses:

> the clone's `origin` is this working tree rather than GitHub, so it has no
> `main` ref and the target's own section 2 … reports `NOT RUN` there

**Measured: the clone does have `origin/main`.** Cloning this worktree produces
`refs/remotes/origin/main`, because the shared clone at `~/code/wroosbit/crabcast`
has a local `main` branch and a clone copies it. On this machine it resolves to
`1f959175` — the shared clone's **local** `main`, which is **19 commits behind**
`origin/main` and last moved on 2026-08-10.

So the sandbox's baseline is neither the repository's `main` nor nothing: it is
whatever local `main` branch happens to exist in the developer's shared clone,
and on a GitHub runner — a detached `actions/checkout` — it would be the real
`origin/main` instead. **The baseline differs between CI and every developer
machine, silently.**

Nothing is red today, and the reason is luck rather than design: KAN-354 pinned
the target's §2 a few hours before this sweep, so the target no longer consults
`origin/main` at all. Before that, the header's claim was **right in outcome and
wrong in mechanism** — §2 reported `NOT RUN` not because the ref was missing, but
because the stale local `main` happened to be post-KAN-148 and byte-equal to the
sandbox's copy.

This is left as a finding rather than a fix: making the sandbox's ref environment
deterministic is a change to the fixture with its own red-drive obligations, and
the epic agent reserves filing.

**KAN-363 re-measured it at `2dd39eb` and corrects one detail, in the direction
that makes the header's disclosure worse rather than better.** The sandbox's
`origin/main` is `1f959175` — now **20** commits behind — and `refs/heads/main`
is **absent**. So of the two things the header claimed, the ref it said was
missing is the one that exists. The header has been corrected in place; **the
mechanism has not been touched and this finding stays open.** Nothing in that
script depends on the ambient ref any more: §§5–7 drive the current target, whose
baseline KAN-354 pinned, and §4c pins both of its arms precisely so that it does
not inherit this.

### CLOSED by KAN-364 — and the inference in it was backwards

**Re-measured at `a869df8`:** the sandbox inherits **98** refs, 97 of them
remote-tracking; `origin/main` is `1f959175`, now **21** commits behind, and
`refs/heads/main` is absent. The number is not worth inheriting — it grows by one
with every merge, because `prompts/task.md` forbids `pull` and `checkout` in the
shared clone, so its local `main` is frozen at whenever that clone was made.

**The mechanic, which three tickets described without stating:** `git clone
<source>` maps the source's **local** `refs/heads/*` into the clone's
`refs/remotes/origin/*`. It does **not** copy the source's own remote-tracking
refs. That is why the sandbox's `origin/main` is the shared clone's *local*
`main` rather than the real one.

**So this finding's own CI claim was wrong, and in the opposite direction to the
one everybody assumed.** It said that on a runner "it would be the real
`origin/main` instead". By the mechanic above, a detached `actions/checkout` with
no local branches gives a clone with **no remote-tracking refs at all** —
measured directly, in a constructed repository: a source with a detached HEAD and
zero local heads produces a clone with **zero refs** and no `origin/main`. The
sandbox's baseline on a runner was therefore likely *absent*, not *real*.

**Fixed rather than disclosed.** `verify-ci-proof-residue-is-legible` now
**constructs** its sandbox's ref environment — one local branch,
`refs/heads/sandbox-baseline`, every inherited ref deleted — so `origin/main`
does not resolve inside the sandbox on any machine. Deletion rather than pinning,
because a pin lets an ambient read *succeed* against an arbitrary commit, which
is the same silent wrong answer one step removed. §0b holds it, and **reports**
the pre-normalisation state without a verdict, which is what makes the
CI-versus-laptop difference a measurement taken on every run instead of a
sentence. §0b names which of its arms can fail on a runner (the branch name) and
which is vacuous there (the absence of inherited refs).

**Still open and NOT closed by this:** §4's `preFixTarget()` reads the **host's**
`['origin/main', 'main']` to decide whether the historical demonstration is
dormant. That is a host-side ambient read, it is **Finding 1**, and it is
untouched — the table above is still accurate. KAN-364 changed the *sandbox's*
ref environment only.

> **That last paragraph was written by KAN-364 and is now spent: KAN-369 closed
> Finding 1** by deleting the host read rather than pinning it. Both ref
> environments this script touches are therefore constructed or immutable — the
> sandbox's by KAN-364, the host's by the `git()` guard. Kept as written because
> it is the sentence that correctly refused to claim more than it had done.

---

## Finding 4 — the fifth shape: a proof whose SUBJECT is immutable can only fail for reasons that are not its subject

**This is what taking Finding 2's decision turned up, and it is the part worth
keeping.** It is not a moving-baseline failure. It is the reason one of them must
not be repaired by pinning, and it generalises past this repository.

`verify-ci-proof-residue-is-legible` §4 loads a **frozen artifact** — the target
as it stood at `0edd2c1` — and asserts on what it does to a **seeded** residue.
Both inputs are constants. Its verdict is therefore a function of

> {frozen bytes} × {seeded residue} × {environment}

and the first two cannot move. **So nothing a future change does to the behaviour
under test can ever change what that section says.** Only environment drift can.
Every red it is capable of emitting is, by construction, a red about the
environment — which is to say a **false** red, misattributed to whoever last
touched the environment. That is precisely §2's failure mode, one level up, and
KAN-354 was filed to remove it.

Compare §5, which is why it is the durable half: its subject is *today's* code
with the fix backed out. Change the code and §5's verdict changes. It can go red
for a **true** reason.

**The rule that falls out, and it is a rule about proofs rather than about refs:**

> **Pin the comparand, never the subject.** A pinned revision is sound as
> something to *compare against* — `verify-daemon-provenance` and
> `verify-readme-is-current` both do it, and both stay live, because their
> subject is what the program does *today*. A pinned revision is unsound as the
> thing *under test*: once the subject is frozen the section has stopped being a
> guard and become a recording, and a recording that can still go red is strictly
> worse than one that cannot.

**And the corollary for `NOT RUN`, because two conditions spell themselves
identically and are opposite.** `verify-daemon-provenance` says, in its own
words, *"a shallow clone that cannot reach these revisions has demonstrated
nothing"*, and treats `NOT RUN` as a failure. That is right **there** and wrong in
§4, and the discriminator is not the wording:

* **`NOT RUN` because the environment is deficient** — a shallow clone, a missing
  ref — is a **fixable defect**, and red is the correct verdict. Somebody can act
  on it.
* **`NOT RUN` because the baseline has caught up** is the **permanent, expected
  consequence of the fix the section demonstrates**. Red there would mean CI is
  red for succeeding, for ever, with nothing anyone can do. Quiet is correct — but
  quiet **and stated**, which is what was missing.

§4 now makes exactly that distinction: the unreachable-ref case is a counted
assertion, the caught-up case is a stated dormancy.

### The decision, and the options rejected

**KAN-363 was filed as a decision ticket with four options. What was chosen is
the third — keep the dormancy — with the part that made it worth choosing added:
the dormancy is now *stated and partly asserted* rather than silently taken.**

| Option | Verdict | Why |
|---|---|---|
| **Pin, and neutralise the loaded script's own moving ref** | rejected | **Not because it fails — measured, it works** (the table under Finding 2). Rejected because a revived §4's subject would be frozen, so by Finding 4 every red it could emit would be a false one, misattributed to whoever last edited `ci.yml`. The historical script's setup guard needs exactly one `      - run: node scripts/verify-proof-registry.mjs` and one `  proof-registry:` line in a file edited **21 times** since `13a247d`. Measured: all 21 kept both. Surviving is not a mechanism. |
| **Delete §4 and rely on §5** | rejected | The dormancy statement is the only record of why the historical demonstration cannot be re-run; deleting the section deletes the explanation with it, and removes the home for the checked pointer at §5, which is new coverage. |
| **Keep the dormancy and document it precisely** | **chosen** | It is what §4 was already doing silently. Now: the file states what it stopped asserting, when, and what covers it; the unreachable-ref case is red; §4c proves the pin-refusal with a fixture; §5b checks the pointer. |
| **Assert something else** | adopted in part | §4c and §5b are both "something else", and both hold today's code. The pure form — replacing §4 outright — is rejected for the same reason as deleting it. |
| **`NOT RUN` is a failure** (`verify-daemon-provenance`'s answer) | **split** | Adopted for the unreachable-ref half, where it is true and where that file's reasoning applies exactly. Rejected for the caught-up half: it would make CI permanently red for succeeding. See the corollary above. |

**What was measured, and what was not.** Measured at `2dd39eb`: §4 dormant and
printing `NOT RUN — origin/main already carries this fix`; the semantic guard
still present; §5 live and asserting (5 checks); the pin reproducing KAN-361's
red at 50/51; the three-way ref table; 44 merged PRs and 21 `ci.yml` edits since
`13a247d`; the sandbox's `origin/main` at `1f959175`, 20 behind, with
`refs/heads/main` absent; and all three new mechanisms driven red one at a time.
**Inferred, not measured:** that the historical script's couplings to a moving
present will eventually break — 21 `ci.yml` edits have not broken them, and the
argument for Finding 4 does not rest on this happening.

---

## `verify-readme-is-current` — pinned, live, and carrying a number to watch

It pins `72db4cd`, `e7ffb58` and `0edd2c1`, and it is the healthiest proof in
this sweep: measured at `69793df8` it runs 84 checks, exit 0, and asserts in
**both** directions — six revisions expected RED *by kind* (`lines` vs
`commands`, asserted separately so a weak demonstration cannot read as a strong
one), and three expected GREEN.

Its header names the failure it is exposed to, and it is not a moving baseline —
the refs are immutable. It is the **expected verdicts** that drift: as the
program grows output, older pages go red for *age* rather than for *drift*, and
the `green` list shrinks. It has already gone 5 → 3 (KAN-200, then KAN-208). The
script says the fix is a newer revision, never a shorter list.

**Measured now: `green` is 3, and all three are still green.** The erosion has
not continued. That number is the one to watch, and this is where it was last
read.

---

## What this sweep does not cover

* **`src/`** was swept for the same channels and has no proof sections in it; the
  SHA-shaped literals there (`5657bfb`, `a888fdd`, `b808fda`, `c18d837`) are
  citations in comments, not refs passed to git. Verified by reading each.
* **Nothing here is a standing guard.** This document is a reading taken on
  2026-08-12, and a document is exactly the artifact that goes stale — which is
  the defect this epic keeps finding. A mechanical check that fails when a new
  moving baseline is introduced would replace it, and is proposed on KAN-361
  rather than built here.
* **The manual step in channel 1 is the weakest link**, as set out above: the
  greps find every `git` invocation, and a human read each one to find its ref.
