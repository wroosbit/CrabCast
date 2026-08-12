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

The sweep found a fourth, which is set out under Finding 2.

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
  `git()` helper, whose refs are supplied by three different callers.
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
| `verify-ci-proof-residue-is-legible` §4 | `['origin/main', 'main']` | **no** — Finding 1 |

`kan114-send-before-and-after.mjs` also uses `origin/main`, and is a one-off
demonstration script rather than a proof: it is not in the CI array, nothing
gates on it, and it prints a before/after rather than asserting. Recorded here
so the next sweep does not have to re-derive that.

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

## Finding 3 — the residue sandbox's `origin/main` is a per-machine artifact, and the script's own disclosure of it is false

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
