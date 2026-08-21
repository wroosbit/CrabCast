#!/usr/bin/env node
// KAN-585: what the `verify` job's wall-clock duration actually distributes
// like, over a window wide enough to tell a tail from a second mode.
//
// WHY THIS EXISTS. KAN-585 was filed on twelve consecutive runs in which
// eleven sat in a 65-second band (13m29s-14m34s) and one sat at 17m49s, under
// a `timeout-minutes: 20` hard cancellation. Twelve runs with an n=1 tail
// cannot distinguish "the runner occasionally draws badly" from "there is a
// second, slower mode this suite enters". The ceiling that is defensible
// differs between those two answers, so the distribution is the load-bearing
// input and not the argument about the number.
//
// WHAT IT DOES. Walks every run of `.github/workflows/ci.yml`, asks each run
// for its jobs, and takes the job named `verify` -- its `started_at` and
// `completed_at`, which is the job's own clock rather than the run's. Prints
// the distribution per day (the suite GREW across this window, so a pooled
// figure answers the wrong question), a histogram, the upper tail by name, and
// the headroom arithmetic against the ceiling read out of the workflow.
//
// ---------------------------------------------------------------------------
// TWO WAYS THIS SURVEY CAN LIE, BOTH OF WHICH IT LIED IN BEFORE BEING FIXED.
// Both fail toward the comfortable answer, which is why they are named here
// rather than left as parameters.
//
// (1) FILTERING ON SUCCESS. The failure this ticket is about is a
//     *cancellation*: a healthy run that draws badly, crosses the ceiling and
//     is killed. A survey restricted to `conclusion=success` cannot contain a
//     single instance of the event it is surveying for -- its maximum is
//     bounded by the ceiling BY CONSTRUCTION, and it reads as reassurance.
//     This survey applies no conclusion filter.
//
// (2) READING ONLY THE LATEST ATTEMPT. `GET /actions/runs/<id>/jobs` returns
//     the CURRENT attempt. Re-running a job REPLACES that record, so a run
//     that timed out and was later re-run reports the re-run's duration and
//     conclusion, and the original cancellation is not in the answer at all.
//     This is not hypothetical and it is the reason this file was rewritten:
//     run 32406501749 (PR #127) timed out at 20m21s on 2026-08-20, was re-run
//     on 2026-08-21, and the first version of this survey consequently
//     reported "runs at or over the 20m ceiling ....... 0" -- a false negative
//     about the exact event it was built to find. Attempts are now walked via
//     `/attempts/<n>/jobs` for every run whose `run_attempt` exceeds 1.
//
// (3) COUNTING A QUEUED JOB AS A SLOW JOB. A job that never got a runner is
//     returned with `steps: []` and `started_at === created_at`, so
//     `completed_at - started_at` is the time it spent WAITING, not the time
//     `verify` ran. Five such rows are in this repository's history, all on
//     2026-08-06, and they read as 15m01s / 15m02s / 15m02s / 15m03s and
//     33m59s -- the last of which is longer than the ceiling and would
//     otherwise appear as a `verify` run that somehow outran its own timeout.
//     They are excluded from the duration distribution and reported separately.
//     This one fails toward ALARM rather than reassurance, which is why it
//     survived the first two fixes: nothing about it looked comfortable.
// ---------------------------------------------------------------------------
//
// CLASSIFYING A CANCELLATION. `conclusion: "cancelled"` does not say who did
// it. GitHub annotates a job it killed on time with the literal text
// "has exceeded the maximum execution time", so this survey reads the
// annotations of every non-successful `verify` job and separates
// `timed-out` from `cancelled` rather than inferring from the duration.
//
// USAGE
//   node scripts/kan585-verify-duration-survey.mjs            # live query
//   node scripts/kan585-verify-duration-survey.mjs --control  # + control checks
//   node scripts/kan585-verify-duration-survey.mjs --cache F  # reuse/save raw
//   node scripts/kan585-verify-duration-survey.mjs --since D  # era cut, YYYY-MM-DD
//
// This is a survey, not a proof. It has no verdict and does not gate anything,
// which is why it is named `kan585-` rather than `verify-` -- the same
// convention as `kan530-doc-count-sweep.mjs` and `kan578-src-count-sweep.mjs`,
// and the reason `verify-proof-registry` does not need an exclusion for it.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = 'wroosbit/CrabCast'
const WORKFLOW = 'ci.yml'
const JOB_NAME = 'verify'
const TIMEOUT_ANNOTATION = 'has exceeded the maximum execution time'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const WORKFLOW_FILE = join(repoRoot, '.github', 'workflows', 'ci.yml')

const args = process.argv.slice(2)
const wantControl = args.includes('--control')
const cacheIdx = args.indexOf('--cache')
const cacheFile = cacheIdx >= 0 ? args[cacheIdx + 1] : null
const sinceIdx = args.indexOf('--since')
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null

// ---------------------------------------------------------------------------
// The ceiling is READ, never carried. docs/verify-cost.md and
// verify-timing-attribution.mjs both depend on there being exactly one copy of
// this number in the repository; a survey that hard-coded 20 would be a second
// copy able to disagree with the first.
// ---------------------------------------------------------------------------
function readCeilingMinutes() {
  const text = readFileSync(WORKFLOW_FILE, 'utf8')
  const lines = text.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*timeout-minutes:\s*(\d+)\s*$/)
    if (m) hits.push({ line: i + 1, value: Number(m[1]), text: lines[i].trim() })
  }
  if (hits.length !== 1) {
    console.error(`FATAL: expected exactly one timeout-minutes line in ci.yml, found ${hits.length}`)
    console.error('       This survey reads the ceiling rather than carrying it; more than one')
    console.error('       source means the number it reports could disagree with the workflow.')
    for (const h of hits) console.error(`       line ${h.line}: ${h.text}`)
    process.exit(2)
  }
  return hits[0]
}

function gh(path) {
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

function fetchRuns() {
  const runs = []
  let page = 1
  for (;;) {
    const r = gh(`repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`)
    if (!r.workflow_runs || r.workflow_runs.length === 0) break
    for (const run of r.workflow_runs) {
      runs.push({
        id: run.id,
        run_number: run.run_number,
        run_attempt: run.run_attempt ?? 1,
        head_branch: run.head_branch,
        head_sha: run.head_sha,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
      })
    }
    if (runs.length >= r.total_count) break
    page++
    if (page > 20) break
  }
  return runs
}

// One row PER ATTEMPT, not per run. See hazard (2) in the header.
function fetchVerifyAttempts(runs) {
  const rows = []
  let n = 0
  for (const run of runs) {
    n++
    if (n % 25 === 0) process.stderr.write(`  ... ${n}/${runs.length} runs\n`)
    const attempts = run.run_attempt > 1
      ? [...Array(run.run_attempt - 1).keys()].map((i) => i + 1).concat([null])
      : [null] // null = the default (latest-attempt) endpoint
    for (const a of attempts) {
      const path = a === null
        ? `repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`
        : `repos/${REPO}/actions/runs/${run.id}/attempts/${a}/jobs?per_page=100`
      let jobs
      try {
        jobs = gh(path)
      } catch {
        rows.push({ ...run, attempt: a ?? run.run_attempt, verify: null, note: 'jobs-unreadable' })
        continue
      }
      const job = (jobs.jobs || []).find((j) => j.name === JOB_NAME)
      if (!job) {
        rows.push({ ...run, attempt: a ?? run.run_attempt, verify: null, note: 'no-verify-job' })
        continue
      }
      rows.push({
        ...run,
        attempt: a ?? run.run_attempt,
        verify: {
          job_id: job.id,
          status: job.status,
          conclusion: job.conclusion,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          // A job that never got a runner has NO steps, and its `started_at`
          // falls back to `created_at` -- so completed_at - started_at is the
          // time it spent QUEUED, not the time `verify` ran. See hazard (3).
          steps: (job.steps || []).length,
        },
      })
    }
  }
  return rows
}

// Ask GitHub why a job ended, rather than inferring it from how long it ran.
function classifyNonSuccess(rows) {
  for (const r of rows) {
    if (!r.verify) continue
    if (r.verify.conclusion === 'success' || r.verify.conclusion == null) continue
    try {
      const anns = gh(`repos/${REPO}/check-runs/${r.verify.job_id}/annotations`)
      const hit = (anns || []).find((a) => (a.message || '').includes(TIMEOUT_ANNOTATION))
      r.verify.kind = hit ? 'timed-out' : r.verify.conclusion
      if (hit) r.verify.timeoutMessage = hit.message
    } catch {
      r.verify.kind = `${r.verify.conclusion} (annotations unreadable)`
    }
  }
}

function seconds(row) {
  const v = row.verify
  if (!v || !v.started_at || !v.completed_at) return null
  const s = Date.parse(v.started_at)
  const e = Date.parse(v.completed_at)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null
  return Math.round((e - s) / 1000)
}

function fmt(sec) {
  if (sec == null) return '  --  '
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// ---------------------------------------------------------------------------

const ceiling = readCeilingMinutes()
const ceilingSec = ceiling.value * 60

console.log('KAN-585 -- `verify` job wall-clock duration survey')
console.log('='.repeat(78))
console.log()
console.log('CEILING, read from the workflow rather than carried:')
console.log(`  ${WORKFLOW_FILE.replace(repoRoot + '/', '')} line ${ceiling.line}: ${ceiling.text}`)
console.log(`  = ${ceilingSec}s`)
console.log()
console.log('QUERY -- stated so it can be re-run and disagreed with:')
console.log(`  1. gh api repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=N`)
console.log('     -- every run, ALL conclusions, no status filter, walked to total_count')
console.log(`  2. for each run: gh api repos/${REPO}/actions/runs/<id>/jobs?per_page=100`)
console.log(`     PLUS .../attempts/<n>/jobs for every prior attempt when run_attempt > 1`)
console.log(`     -- the job named "${JOB_NAME}"; duration = completed_at - started_at`)
console.log(`  3. for each non-success verify job: gh api repos/${REPO}/check-runs/<job_id>/annotations`)
console.log('     -- a job GitHub killed on time is annotated; that is how timed-out is')
console.log('        separated from cancelled, rather than guessing from the duration.')
console.log()
console.log('  Neither a conclusion filter nor a latest-attempt-only read. Both are')
console.log('  named in this file\'s header as the two ways this survey lied before.')
console.log()

let rows
if (cacheFile && existsSync(cacheFile)) {
  console.log(`(reading raw rows from cache ${cacheFile})`)
  rows = JSON.parse(readFileSync(cacheFile, 'utf8'))
} else {
  process.stderr.write('Fetching run list...\n')
  const runs = fetchRuns()
  const reruns = runs.filter((r) => r.run_attempt > 1)
  process.stderr.write(`  ${runs.length} runs of ${WORKFLOW}; ${reruns.length} with >1 attempt\n`)
  process.stderr.write('Fetching per-attempt jobs...\n')
  rows = fetchVerifyAttempts(runs)
  process.stderr.write('Classifying non-success jobs from annotations...\n')
  classifyNonSuccess(rows)
  if (cacheFile) {
    writeFileSync(cacheFile, JSON.stringify(rows, null, 2))
    process.stderr.write(`  cached to ${cacheFile}\n`)
  }
}

const withJob = rows.filter((r) => r.verify)
const clocked = withJob.map((r) => ({ ...r, sec: seconds(r) })).filter((r) => r.sec != null)
// Hazard (3): a job with no steps never ran. Its clock is queue time.
const neverRan = clocked.filter((r) => r.verify.steps === 0)
let timed = clocked.filter((r) => r.verify.steps > 0)
if (since) timed = timed.filter((r) => r.created_at >= since)

const dates = timed.map((r) => r.created_at).sort()
console.log('WINDOW')
console.log(`  run-attempts of ${WORKFLOW} examined ...... ${rows.length}`)
console.log(`  of which have a "${JOB_NAME}" job .......... ${withJob.length}`)
console.log(`  of which have a usable clock ......... ${clocked.length}`)
console.log(`  MINUS jobs that never got a runner ... ${neverRan.length}  (steps=0; queue time, not run time)`)
console.log(`  = duration sample ..................... ${timed.length}`)
if (since) console.log(`  era cut applied: created_at >= ${since}`)
if (dates.length) {
  console.log(`  oldest run created ................... ${dates[0]}`)
  console.log(`  newest run created ................... ${dates[dates.length - 1]}`)
}
console.log()

if (neverRan.length) {
  console.log('EXCLUDED -- `verify` jobs that never got a runner (hazard 3)')
  console.log('  Their clock is time spent QUEUED. None of these is a duration of the suite.')
  for (const r of [...neverRan].sort((a, b) => b.sec - a.sec)) {
    console.log(
      `  ${fmt(r.sec)}  run ${r.id} att${r.attempt}  ${r.verify.conclusion}  ` +
        `${r.created_at}  ${r.head_branch}`
    )
  }
  console.log()
}

const byKind = new Map()
for (const r of timed) {
  const c = r.verify.kind ?? r.verify.conclusion ?? r.verify.status ?? 'unknown'
  byKind.set(c, (byKind.get(c) || 0) + 1)
}
console.log('`verify` OUTCOMES IN THE WINDOW (annotation-classified)')
for (const [c, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padEnd(20)} ${String(n).padStart(4)}`)
}
console.log()

// THE SUITE GREW. A pooled percentile over the whole window mixes a 38-second
// suite with a 14-minute one and answers a question nobody asked. Per-day is
// what shows the growth and what makes an era cut arguable rather than picked.
console.log('PER-DAY DISTRIBUTION -- the suite grew across this window')
console.log('  date         n     min      p50      max   worst outcome')
const byDay = new Map()
for (const r of timed) {
  const d = r.created_at.slice(0, 10)
  if (!byDay.has(d)) byDay.set(d, [])
  byDay.get(d).push(r)
}
for (const d of [...byDay.keys()].sort()) {
  const set = byDay.get(d)
  const secs = set.map((r) => r.sec).sort((a, b) => a - b)
  const worst = set.some((r) => r.verify.kind === 'timed-out')
    ? 'TIMED OUT'
    : set.some((r) => r.verify.conclusion !== 'success')
      ? 'non-success'
      : ''
  console.log(
    `  ${d}  ${String(secs.length).padStart(3)}  ${fmt(secs[0])}  ` +
      `${fmt(Math.round(quantile(secs, 0.5)))}  ${fmt(secs[secs.length - 1])}   ${worst}`
  )
}
console.log()

function summarise(label, set) {
  if (set.length === 0) {
    console.log(`${label}: none in window`)
    console.log()
    return null
  }
  const secs = set.map((r) => r.sec).sort((a, b) => a - b)
  const min = secs[0]
  const max = secs[secs.length - 1]
  const mean = Math.round(secs.reduce((a, b) => a + b, 0) / secs.length)
  const p50 = Math.round(quantile(secs, 0.5))
  const p90 = Math.round(quantile(secs, 0.9))
  const p95 = Math.round(quantile(secs, 0.95))
  const p99 = Math.round(quantile(secs, 0.99))
  console.log(`${label} (n=${set.length})`)
  console.log(`  min ${fmt(min)}   p50 ${fmt(p50)}   p90 ${fmt(p90)}   p95 ${fmt(p95)}   p99 ${fmt(p99)}   max ${fmt(max)}`)
  console.log(`  mean ${fmt(mean)}`)
  console.log(`  max as % of ceiling ......... ${((max / ceilingSec) * 100).toFixed(1)}%`)
  console.log(`  headroom at observed max .... ${fmt(Math.max(0, ceilingSec - max))} (${ceilingSec - max}s)`)
  console.log()
  return { min, max, mean, p50, p90, p95, p99, secs }
}

const sAll = summarise('ALL `verify` ATTEMPTS WITH A CLOCK', timed)

console.log('HISTOGRAM -- one-minute buckets, all attempts with a clock')
if (sAll) {
  const lo = Math.floor(sAll.min / 60)
  const hi = Math.floor(sAll.max / 60)
  for (let m = lo; m <= hi; m++) {
    const n = timed.filter((r) => Math.floor(r.sec / 60) === m).length
    const succ = timed.filter((r) => Math.floor(r.sec / 60) === m && r.verify.conclusion === 'success').length
    const bar = '#'.repeat(Math.min(n, 60))
    const mark = m * 60 >= ceilingSec ? '  <- AT/OVER CEILING' : ''
    console.log(
      `  ${String(m).padStart(3)}m-${String(m + 1).padStart(2)}m ${String(n).padStart(4)} ${bar}${mark}` +
        (n !== succ ? `   (${n - succ} not success)` : '')
    )
  }
}
console.log()

console.log('UPPER TAIL -- every attempt at or above p90 of all attempts, newest first')
if (sAll) {
  const cut = sAll.p90
  const tail = timed
    .filter((r) => r.sec >= cut)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  console.log(`  (cut = p90 = ${fmt(cut)}; ${tail.length} attempts)`)
  for (const r of tail) {
    const kind = r.verify.kind ?? r.verify.conclusion ?? r.verify.status
    console.log(
      `  ${fmt(r.sec)}  ${String(r.id).padEnd(12)} att${r.attempt} ${String(kind).padEnd(12)} ` +
        `${r.created_at}  ${r.head_branch}`
    )
  }
}
console.log()

// ---------------------------------------------------------------------------
// CONTROL. A null result is a claim about the instrument until the instrument
// is shown able to produce the other answer.
// ---------------------------------------------------------------------------
if (wantControl) {
  console.log('CONTROL -- could this query have found a slow / killed run had one been there?')
  console.log('-'.repeat(78))
  const band = timed.filter((r) => r.sec >= 13 * 60 && r.sec <= 14 * 60 + 34)
  const aboveBand = timed.filter((r) => r.sec > 14 * 60 + 34)
  const atOrOverCeiling = timed.filter((r) => r.sec >= ceilingSec)
  const timedOut = timed.filter((r) => r.verify.kind === 'timed-out')
  console.log(`  attempts inside the filing's 13m29s-14m34s band .... ${band.length}`)
  console.log(`  attempts ABOVE that band ........................... ${aboveBand.length}`)
  console.log(`  attempts at or over the ${ceiling.value}m ceiling ................ ${atOrOverCeiling.length}`)
  console.log(`  attempts GitHub killed for exceeding the ceiling ... ${timedOut.length}`)
  console.log()

  let failed = false

  // (a) can it see above the band at all?
  if (aboveBand.length === 0) {
    console.log('  ⚠ CONTROL A FAILED: no attempt above the band. That is not evidence the')
    console.log('    suite is fast; it is evidence this survey cannot see slow runs.')
    failed = true
  } else {
    console.log('  ✓ CONTROL A -- the query returns attempts above the band. Slowest five:')
    for (const r of [...aboveBand].sort((a, b) => b.sec - a.sec).slice(0, 5)) {
      const kind = r.verify.kind ?? r.verify.conclusion
      console.log(`      ${fmt(r.sec)}  ${r.id} att${r.attempt}  ${kind}  ${r.head_branch}`)
    }
  }
  console.log()

  // (b) the positive control that matters: a real ceiling hit is in the answer.
  if (timedOut.length === 0) {
    console.log('  ⚠ CONTROL B FAILED: the survey reports that the ceiling has never fired.')
    console.log('    Before believing that, check the attempt walk is working -- the')
    console.log('    latest-attempt-only read produced exactly this answer while a 20m21s')
    console.log('    timeout sat in attempt 1 of run 32406501749. See header hazard (2).')
    failed = true
  } else {
    console.log('  ✓ CONTROL B -- the ceiling HAS fired, and this query finds it by name:')
    for (const r of timedOut) {
      console.log(`      ${fmt(r.sec)}  run ${r.id} attempt ${r.attempt}  ${r.created_at}  ${r.head_branch}`)
      console.log(`        GitHub's annotation: "${r.verify.timeoutMessage}"`)
    }
    console.log('    A survey that could not produce this row could not have found the')
    console.log('    event this ticket exists for, whatever else it printed.')
  }
  console.log()

  // (c) the counterfactual that shows WHY the naive query was wrong.
  console.log('  CONTROL C -- what the two naive queries would have reported instead:')
  const succOnly = timed.filter((r) => r.verify.conclusion === 'success')
  const latestOnly = timed.filter((r) => r.attempt === r.run_attempt)
  console.log(`      max over ALL attempts, all conclusions ....... ${fmt(sAll.max)}`)
  console.log(
    `      max if filtered to conclusion=success ........ ` +
      `${fmt(succOnly.length ? Math.max(...succOnly.map((r) => r.sec)) : null)}`
  )
  console.log(
    `      max if only the LATEST attempt were read ..... ` +
      `${fmt(latestOnly.length ? Math.max(...latestOnly.map((r) => r.sec)) : null)}`
  )
  const hiddenByLatest = timedOut.filter((r) => r.attempt !== r.run_attempt)
  console.log(`      ceiling hits invisible to a latest-attempt read: ${hiddenByLatest.length}`)
  for (const r of hiddenByLatest) {
    console.log(`        ${fmt(r.sec)}  run ${r.id} attempt ${r.attempt} (run is now on attempt ${r.run_attempt})`)
  }
  console.log()

  // (d) the exclusion in hazard (3) is load-bearing in the OTHER direction --
  // it removes a false alarm rather than a false reassurance. Shown because an
  // exclusion nobody can see the effect of is indistinguishable from a filter
  // quietly dropping inconvenient rows.
  console.log('  CONTROL D -- what the never-ran exclusion changes, in both directions:')
  const naiveMax = clocked.length ? Math.max(...clocked.map((r) => r.sec)) : null
  console.log(`      max INCLUDING jobs that never got a runner ... ${fmt(naiveMax)}`)
  console.log(`      max over jobs that actually ran .............. ${fmt(sAll ? sAll.max : null)}`)
  console.log(`      rows removed ................................. ${neverRan.length}`)
  if (naiveMax != null && naiveMax > ceilingSec && (!sAll || sAll.max <= naiveMax)) {
    console.log('      ^ the unexcluded figure is ABOVE the ceiling, which would read as a')
    console.log('        `verify` run that outran its own timeout. It is a queued job.')
  }
  console.log()

  if (failed) process.exitCode = 1
}

console.log('MEASURED vs INFERRED')
console.log('  MEASURED: every duration above, from the job\'s own started_at/completed_at')
console.log('            via the runs/jobs API. The ceiling, read from ci.yml. Which')
console.log('            cancellations were the timeout firing, from GitHub\'s own')
console.log('            annotation text rather than from their duration.')
console.log('  INFERRED: nothing in this output. No trend, rate or cause is asserted here.')
console.log('            The per-day table SHOWS growth; it does not project any, and this')
console.log('            survey takes no position on where an era boundary belongs.')
