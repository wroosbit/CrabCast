# How CrabCast obtains Butchr's crabcast-facing proofs

**KAN-518.** This is the acquisition-and-perimeter decision. It does not wire
anything: the CI job, and the exclusions that job needs, are KAN-519.

**Refs every measurement below was taken against** — a finding quoted without
its ref is not evidence:

| repo | ref |
| --- | --- |
| `wroosbit/butchr` | `e8729f53353280a6cb395aeac00c994e72a7aa11` |
| `wroosbit/crabcast` | `927df07dfd898f862b922be423a4134a1e87c89d` |

⚠ Butchr's `origin/main` advanced to `17a5672` (KAN-552) *while this work was in
progress* — inside one working session. That commit touched
`verify-crabcast-priority-roundtrip.mjs`, one of the seven scripts swept below;
it was re-read, it adds `owner` assertions, and it leaves the skip/exit shape
untouched, so the sweep's verdict holds there too. **This is not an aside. It is
the staleness problem happening on the day the staleness policy was written**,
and it is why that policy is what it is.

---

## The decision

**Mechanism — a pinned checkout, not a vendored copy and not a published
fixture.** CrabCast CI clones `wroosbit/butchr` at the full 40-character SHA
recorded in `.butchr-proof-pin.json` and runs the proofs **in Butchr's own
tree**.

**Placement — outside the guard perimeter, into an untracked CI-time
directory.** The imported proofs are never `git add`ed to CrabCast.

**What audits them — nothing, and that is the accepted cost.** It is recorded
here and in the pin file rather than left to be discovered. A CrabCast-owned
proof at the flat path can audit *the pin*; nothing can audit *the proofs*.

---

## Why vendoring is not a choice on the table

The ticket framed this as *the tidy option does not land inside the perimeter*.
The measurement is stronger than that: **the tidy option does not run at all.**

Every one of the ten CI-runnable proofs computes its own repo root from its own
location —

```
verify-crabcast-channel-startup-supervision.mjs:68   const repoRoot = path.resolve(here, '..', '..');
verify-crabcast-adopt-launcher-vocabulary.mjs:114    const repoRoot = path.resolve(scriptDir, '..', '..');
verify-crabcast-census-disclosure.mjs:105            const repoRoot = path.resolve(scriptDir, '..', '..');
verify-crabcast-session-restore.mjs:103              const repoRoot = path.resolve(scriptDir, '..', '..');
```

— and then reads `<repoRoot>/daemon/src/*.ts` as text, imports
`<repoRoot>/daemon/dist/*.js`, or both. A file copied to
`crabcast/scripts/verify-crabcast-*.mjs` resolves `repoRoot` to a tree that has
no `daemon/` at all.

**Measured: all ten copied flat into `crabcast/scripts/` and run.**

| script | vendored-flat exit |
| --- | --- |
| `verify-crabcast-channel-startup-supervision` (hand-run, not in CI) | **2** — `Missing runtime at …/daemon/src/crabcast-runtime.ts — this script reads the tree, not a build.` |
| `verify-crabcast-reconnect-resync` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` (`../dist/crabcast-link.js`) |
| `verify-crabcast-runtime-switch` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |
| `verify-crabcast-adopt-launcher-vocabulary` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` (`./lib/verdict-exit.mjs`) |
| `verify-crabcast-census-disclosure` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |
| `verify-crabcast-mcp-residue-cleared` (hand-run, not in CI) | **1** — `node:fs` throw |
| `verify-crabcast-priority-roundtrip` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |
| `verify-crabcast-session-restore` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |
| `verify-crabcast-standing` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |
| `verify-crabcast-supervisor-exemption` (hand-run, not in CI) | **1** — `ERR_MODULE_NOT_FOUND` |

Every row is marked **hand-run, not in CI** because that is literally true of
all of them and is half this document's point: these are Butchr's proofs,
CrabCast's `verify` array runs none of them, and after this decision it still
will not — a pinned checkout runs them in Butchr's tree, outside anything
CrabCast's CI array or its exclusion register describes. Read the mark here as
*CrabCast's CI does not run this*, which is the only sense in which any row of
this table could be misread as covered.

**10 of 10 fail, and — worth saying, because it is the good news — none of them
lies.** Not one produced a green having done nothing. `BUTCHR_DIST` redirects
the `dist` import on the four scripts that read it; **no script anywhere has an
override for `repoRoot` or for the `daemon/src` reads**, so there is no env-var
route to a working vendored copy either.

The `./lib/verdict-exit.mjs` dependency that `story/KAN-117` flagged (comment
`13135`) is real and confirmed — six scripts carry it — but it is **not the
binding constraint**. Vendoring the library alongside the proofs fixes the
`ERR_MODULE_NOT_FOUND` rows and changes nothing: those scripts then fail one
line later, on `daemon/src`, exactly as the seventh row already does.

**These are not portable test files. They are assertions about Butchr's own
source and build**, and the only place they can make those assertions is in
Butchr's tree. That settles the mechanism.

---

## The perimeter, re-derived at today's refs

Both guards scope to a flat path and nothing else — unchanged from the ticket's
own reading, at the same line numbers:

```
scripts/verify-proof-registry.mjs:612   git ls-files scripts
                              :617   /^scripts\/verify-[^/]*\.mjs$/   <- [^/] excludes subdirectories
scripts/verify-proof-verdicts.mjs:474   git ls-files 'scripts/verify-*.mjs'

flat proofs tracked today: 84  (was 78 at 5a8d864)
nested paths under scripts/: 0
```

### AC2, both arms

**Arm A — the positive control: the guards CAN go red, by name.** A flat,
tracked, unaccounted-for `scripts/verify-kan518-perimeter-probe.mjs`:

```
verify-proof-registry   EXIT=1
  FAIL  scripts/verify-kan518-perimeter-probe.mjs is accounted for — NOT in the CI
        array and NOT in the exclusion register — add it to one or the other.
  verify-kan518-perimeter-probe               UNACCOUNTED FOR
  85 proof(s): 67 run by the CI array, 16 excluded, 1 run by its own job, 1 unaccounted for.
  1 CHECK(S) FAILED

verify-proof-verdicts   EXIT=1
  FAIL  every tracked proof can report failure through its exit code — 1 cannot:
        scripts/verify-kan518-perimeter-probe.mjs
  FAIL  every tracked proof has somewhere that can make its verdict negative — 1 do
        not: scripts/verify-kan518-perimeter-probe.mjs (traced through: nothing)

after `git rm --cached` of that one file:
  REGISTRY_EXIT_AFTER=0     VERDICTS_EXIT_AFTER=0
```

**Arm B — the chosen placement: unaccounted-for files leave both guards green.**
Three *real* imported proofs plus their shared library, tracked at
`scripts/butchr/` — the tidiest possible vendoring, and the one a careful
reviewer would ask for:

```
tracked under scripts/butchr/: 4
  scripts/butchr/verify-crabcast-census-disclosure.mjs
  scripts/butchr/verify-crabcast-standing.mjs
  scripts/butchr/verify-crabcast-priority-roundtrip.mjs
  scripts/butchr/lib/verdict-exit.mjs

verify-proof-registry   EXIT=0
verify-proof-verdicts   EXIT=0
mentions of "crabcast" or "verdict-exit" in either output: 0 and 0
  84 proof(s): 67 run by the CI array, 16 excluded, 1 run by its own job, 0 unaccounted for.
```

**84 — the same count as with the four files absent.** Both guards are blind to
them, and Arm A is what makes that a reading of the world rather than a reading
of a broken search: the identical commands named a file fifteen seconds earlier.

The chosen placement is weaker still than Arm B, deliberately: an untracked
CI-time checkout is not a path `git ls-files` returns at all, so there is
nothing for either guard to be blind *to*.

**Recorded as the accepted cost:** the imported proofs are outside the
perimeter, permanently and by construction, and no placement puts them inside
it. The pin file can be brought inside it by KAN-519. The proofs cannot.

---

## Inventory, re-derived (Task 3)

18 `verify-crabcast-*` scripts at `e8729f5`, classified by their own
`CI-RUNNABLE:` header — **3 `yes`, 7 `partial`, 8 `no`**, the same aggregate the
ticket carried, now with the membership named:

| class | scripts |
| --- | --- |
| **yes** (3) | `channel-startup-supervision`, `reconnect-resync`, `runtime-switch` |
| **partial** (7) | `adopt-launcher-vocabulary`, `census-disclosure`, `mcp-residue-cleared`, `priority-roundtrip`, `session-restore`, `standing`, `supervisor-exemption` |
| **no** (8) | `brief-reachable-live`, `claude-launcher-live`, `confirm-present-name-join`, `peer-restart-live`, `reconnect-live`, `rude-death-live`, `runtime-live`, `second-activation-resumes` |

### ⚠ The finding that matters more than the counts

**Ask what would have to be true for this check to pass while CrabCast is
broken.** Read what the CI-runnable sections actually assert *about*:

- the three `yes` scripts read Butchr's `daemon/src/*.ts` as text, import
  Butchr's `daemon/dist/*.js`, or answer **their own** Unix socket;
- the CI-side sections of the seven `partial` scripts do the same.

Against a **pinned** Butchr, every one of those inputs is a constant. **A
required check built from them cannot change its answer in response to anything
in CrabCast** — it would run, cost twenty minutes, and gate nothing. That is
this story's own defect class wearing the import as a costume.

The sections that *can* notice a CrabCast change are exactly the live ones —
and those are exactly the ones that skip on a runner. `census-disclosure` says
so about its own §8: *"the ONLY cover for 'does the field arrive'. Skipped is
not passed."*

**There is a way through, and it is CrabCast's to give.** CrabCast's `verify`
job already stands up real CrabCast daemons on a runner — a shimmed `herdr`
binary on PATH answering herdr's own JSON shapes, a scratch `$HOME` and
dataDir, everything else real compiled code (`.github/workflows/ci.yml:186-190`).
Pointing `BUTCHR_CRABCAST_SOCKET` at such a daemon turns the socket-only live
sections from skips into checks that gate on **CrabCast's** behaviour, which is
the entire point of the import. Sections that spawn real agents through real
panes (`supervisor-exemption` §5–§8, `session-restore` §5) still cannot run.

**That is a recommendation to KAN-519, not a decision taken here**, and it is
flagged for `story/KAN-117` because it bears on whether the story's goal is
reachable as written.

---

## The `partial` sweep (Task 4 / AC3)

Task 4 as written is obsolete — KAN-373 is Done and merged, and
`verify-crabcast-census-disclosure.mjs` no longer has the `:139`/`:650`/`:725`
shape. The live question is the one `story/KAN-117` restated and
`lib/verdict-exit.mjs` names against itself: *"NOTHING covers a script that does
not tally at all."*

**Each of the seven, by name, under the true CI condition** — no CrabCast socket
at the default path, no CrabCast checkout:

| script | skips? | tallies the skip? | exit under CI condition |
| --- | --- | --- | --- |
| `adopt-launcher-vocabulary` | yes, 3 sites | yes → `reportAndExit` | **2** INCOMPLETE |
| `census-disclosure` | yes, 2 sites | yes → `reportAndExit` | **2** INCOMPLETE |
| **`mcp-residue-cleared`** | **yes, §3–§8** | ⚠ **NO — it keeps no tally** | ⚠ **0** |
| `priority-roundtrip` | yes, 3 sites | yes → `reportAndExit` | **2** INCOMPLETE |
| `session-restore` | yes, 1 site | yes → `reportAndExit` | **2** INCOMPLETE |
| `standing` | yes, 1 site | yes → `reportAndExit` | **2** INCOMPLETE |
| `supervisor-exemption` | yes, 4 sites | yes → `reportAndExit` | **2** INCOMPLETE |

Six of seven are clean, and clean in the strong sense: every `return` past a
section is preceded by a tallied `skip()`, a `check(false)`, or a `bad()` — a
missing fixture is a **failure**, not a skip (`standing:511`, `:598`), and a
peer that answers wrongly is a failure, not a skip. Two of them
(`priority-roundtrip`, `supervisor-exemption`) can exit 0 with sections skipped
**only** under an explicit `--static-only`, which is the caller saying so out
loud and is exactly what `verdict-exit.mjs` designed `allowSkipped` for.

### ⚠ `verify-crabcast-mcp-residue-cleared.mjs` — the surviving instance

It has **no `skipped` variable**, does not import `lib/verdict-exit.mjs`, and
ends its skip branch on `process.exit(failures ? 1 : 0)` (`:282`). Its skip
condition is `!fs.existsSync(path.join(CRABCAST_CHECKOUT, '.git'))` (`:267`)
where `CRABCAST_CHECKOUT` is `~/code/wroosbit/crabcast` (`:87`).

**That condition IS the CI condition.** Measured, two arms differing only in
`HOME`:

```
ARM A  checkout PRESENT (this machine)
  EXIT=0    occurrences of "SKIP  no CrabCast checkout": 0
  OK — the real CrabCast refusal fires on a herdr-written workspace, …

ARM B  checkout ABSENT (the CI condition)
  EXIT=0    SKIP  no CrabCast checkout at …/fakehome/code/wroosbit/crabcast
  OK — static sections only (§1–§2). The live sections were skipped, not passed.
```

**Same exit code, opposite worlds.** §3–§8 are the sections that drive
CrabCast's *real* `provisionMcpConfig` out of the peer source — the only part of
this script that could ever notice CrabCast — and on a runner they announce
themselves skipped and hand back a 0.

The script is honest in prose and silent in its exit code, which is the whole
defect: **a caller reads the exit code.**

**And Butchr's own sweep passes it.** `node daemon/scripts/sweep-verify-exit-paths.mjs`
exits **0** and gives it a clean row —

```
script                                           verdict exits  guards  header
verify-crabcast-mcp-residue-cleared              3              2       yes
```

— because the sweep's skip check reads *"each of the 10 that tally skips names
that tally at an exit"*, and this script is not one of the ten. It has no tally
to find. **Its row is indistinguishable from that of a script with no skip at
all**, which is the same *present-is-not-required* confusion `story/KAN-117`
corrected itself on in comment `13260`, one level down.

**Consequence for this ticket:** `mcp-residue-cleared` is the single worst
candidate in the `partial` set to import, and it must not be wired as a gate
without `--allow-skipped`-equivalent handling that does not exist in it. Filed
as a follow-up for Butchr's tree; **not patched here** — that tree is
`epic/KAN-39`'s.

### Two live-peer observations, taken once, with their timestamp

Recorded because they bear on what is safe to recommend, and quoted as single
readings rather than as standing facts (2026-08-21, ~15:40–16:10Z, against the
CrabCast daemon live on this machine):

- **`census-disclosure` §8 passed** — `EXIT=0`, `agents=25
  unreadableRecordsTotal=1 peerContractVersion=13 pinned=8`. **KAN-554's
  reported symptom did not reproduce**: the peer is at v13 and the field read as
  a number. One run; KAN-555's nondeterministic-skip claim is untouched by it.
- **`supervisor-exemption` failed 5 assertions against the live peer**, all in
  its §8 cleanup — `forget_agent` refused with *"an agent is running in it"* for
  a workspace `deactivate` had just reported `alreadyGone: true`. **It leaves
  live panes behind when that happens.** This run left two; six earlier
  `/tmp/kan492-*` panes from other runs were already there. The two this work
  created were closed and their records forgotten; the pre-existing six were
  left alone, being other agents' business.

---

## What this decision does not cover

- **Wiring the job, and registering exclusions** — KAN-519. Nothing in this
  change edits `.github/workflows/ci.yml` or
  `scripts/verify-proof-registry.mjs`, so the coordination hold on those two
  files was not needed.
- **Making the check required** — Task 4 / AC3 of KAN-117, ruled still blocked
  by `epic/KAN-59`: a branch-protection write on a fleet reporting
  `admin: false`. Not built toward, not reported on.
- **Fixing anything in Butchr's tree** — `epic/KAN-39`'s. Read and cited, never
  patched.
