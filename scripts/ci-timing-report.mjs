#!/usr/bin/env node
// KAN-331: what the `verify` job's twelve-and-a-half minutes are SPENT ON.
//
// Not a proof — a reporter, run by the `verify` job after its loop. It is
// listed here rather than under a `verify-` name deliberately: it asserts
// nothing about the daemon, and `verify-timing-attribution.mjs` is the proof
// that this file works. See that script's header for what defends it.
//
// THE DEFECT IT ADDRESSES, and it is worth being precise because the obvious
// reading is wrong. The per-script numbers were ALREADY BEING MEASURED: every
// `::group::` line in the job log carries a timestamp, so anyone who downloads
// the raw log and diffs the markers can attribute the whole loop. KAN-331's
// author took fourteen wall-clock readings over four days, wrote "nobody will
// be able to say which script moved it without bisecting by hand" three times,
// and never did that derivation — not through carelessness, but because
// "available if you download and post-process the artifact" is what having no
// attribution actually looks like from the inside.
//
// So this file adds NO MEASUREMENT. It moves an existing measurement from a
// place nobody looks to a place people already are. That is the whole change,
// and the honest size of it.
//
// WHAT IT WILL NOT DO: fail. Nothing here compares a number to a threshold,
// because the job's verdict belongs to the proofs and not to the clock — the
// reasoning is in docs/verify-cost.md and it is a recorded decision rather
// than an omission. The one thing this exits non-zero for is being unable to
// report at all (no input), because a reporter that silently produces nothing
// looks exactly like a job that had nothing to report.

import fs from 'node:fs';

/**
 * Printed in BOTH renderings, and asserted by verify-timing-attribution §1.
 *
 * It is here because the table is at its most persuasive when it is least
 * reliable: a single column of numbers reads as a measurement of each script,
 * and it is one sample of each script. The named case is real and was measured
 * on unchanged code across four consecutive `main` runs — the range is wider
 * than most of the deltas anyone would want to read out of this table.
 */
const ONE_RUN_CAVEAT =
  'One run. These timings cannot tell a slow script from an unlucky one: ' +
  'verify-ci-proof-residue-is-legible measured 18.3s and 44.6s on unchanged code ' +
  '(four consecutive main runs, 2026-08-12). Compare against another run before ' +
  'concluding that anything moved.';

/**
 * The recorded position, carried in the output rather than only in the doc.
 *
 * A reader who meets this table for the first time will ask what happens when
 * a number gets big. The answer is "nothing, deliberately", and a reader who
 * has to go and find that out is a reader who assumes the opposite.
 */
const NO_BUDGET =
  'No budget: nothing here fails on a number, by decision — see docs/verify-cost.md. ' +
  '`timeout-minutes` on this job is a hang bound, not a budget.';

const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);

/**
 * The hang bound, READ FROM THE WORKFLOW rather than written down here.
 *
 * WHY IT IS READ AND NOT A CONSTANT. This started as a comment in ci.yml
 * predicting that the bound "silently becomes a budget whose number nobody
 * chose" as the loop grows into it. That sentence is this epic's signature
 * failure — a claim that outlives the evidence that made it true, because
 * nothing measures the change it predicts (KAN-345; the `~1%` comment on #80
 * is the same shape). The fix is not a better sentence: it is to put the ratio
 * on the page every run, so the day it reads 90% the reviewer sees it rather
 * than re-reading a comment nobody re-reads.
 *
 * Duplicating the number here would have reintroduced the same class one layer
 * down — two numbers that agree until they do not. So it is parsed out of the
 * `verify` job, and an unreadable bound is REPORTED as unreadable rather than
 * defaulted, because a plausible denominator is worse than a missing one.
 *
 * @returns {{minutes: number}|{error: string}}
 */
function hangBound(workflowPath = '.github/workflows/ci.yml') {
  let text;
  try {
    text = fs.readFileSync(workflowPath, 'utf8');
  } catch (err) {
    return { error: `could not read ${workflowPath} (${err?.code ?? err?.message ?? err})` };
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}verify:\s*$/.test(l));
  if (start < 0) return { error: `no \`verify:\` job found in ${workflowPath}` };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }
  const hits = lines
    .slice(start, end)
    .map((l) => l.match(/^\s*timeout-minutes:\s*(\d+)\s*$/))
    .filter(Boolean);
  if (hits.length !== 1) {
    return { error: `expected exactly 1 \`timeout-minutes:\` in the verify job, found ${hits.length}` };
  }
  return { minutes: Number(hits[0][1]) };
}

/**
 * `name<TAB>startEpochMs<TAB>endEpochMs<TAB>verdict` per line.
 *
 * THE SUBTRACTION HAPPENS HERE RATHER THAN IN THE WORKFLOW, and that is not a
 * preference: `$(( … ))` is not understood by scripts/ci-workflow.mjs's shell
 * reader, and one arithmetic expansion anywhere in the `run:` block fails the
 * whole block to "could not be read as shell" — after which every CI-wiring
 * guard reports every command in it as not-live. It fails closed, so the
 * result is a red check with a misleading message rather than a silent hole,
 * but a trap that costs an afternoon is still a trap. Doing the arithmetic in
 * a place that has tests is better than doing it in a place that has a lexer.
 * KAN-354 carries the lexer gap itself.
 */
function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [name, t0, t1, verdict] = line.split('\t');
    const a = Number(t0);
    const b = Number(t1);
    // A row this reporter cannot read is named rather than dropped: a silently
    // skipped script is a script the table implies does not exist.
    if (!name || !Number.isFinite(a) || !Number.isFinite(b) || b < a) {
      rows.push({ name: name || '(unnamed)', s: NaN, verdict: verdict ?? '?', malformed: true });
      continue;
    }
    rows.push({ name, s: (b - a) / 1000, verdict: (verdict ?? '').trim() || '?', malformed: false });
  }
  return rows;
}

function render(rows) {
  const good = rows.filter((r) => !r.malformed);
  const total = good.reduce((a, r) => a + r.s, 0);
  const sorted = [...good].sort((a, b) => b.s - a.s);
  const malformed = rows.filter((r) => r.malformed);

  let cum = 0;
  const ranked = sorted.map((r, i) => {
    cum += r.s;
    return {
      rank: i + 1,
      ...r,
      share: total > 0 ? (r.s / total) * 100 : 0,
      cumShare: total > 0 ? (cum / total) * 100 : 0
    };
  });

  const failed = rows.filter((r) => r.verdict === 'FAILED');
  const top = ranked[0];
  const headline =
    `${rows.length} scripts, ${fmt(total)} in the loop` +
    (top ? ` — slowest ${top.name} ${top.s.toFixed(1)}s (${top.share.toFixed(1)}%)` : '');

  // The ratio, so "there is still headroom" is a reading rather than a belief.
  const bound = hangBound();
  const boundLine =
    'minutes' in bound
      ? `Loop is ${fmt(total)}, which is ${((total / (bound.minutes * 60)) * 100).toFixed(0)}% of the ` +
        `${bound.minutes}-minute hang bound on this job. That bound catches a proof that hangs; ` +
        'it is not a cost limit, and this percentage is not a budget being spent.'
      : `Hang-bound ratio unavailable: ${bound.error}. The percentage this line exists to print ` +
        'is therefore missing rather than estimated.';

  // ---- stdout: the log rendering, for someone already in the log ----------
  const out = [];
  out.push('');
  out.push(`=== verify cost: ${headline} ===`);
  out.push('');
  out.push('  rank  seconds   share    cum  script');
  for (const r of ranked) {
    out.push(
      `  ${String(r.rank).padStart(4)}  ${r.s.toFixed(1).padStart(7)}  ` +
        `${r.share.toFixed(1).padStart(5)}%  ${r.cumShare.toFixed(0).padStart(3)}%  ${r.name}` +
        (r.verdict === 'FAILED' ? '   [FAILED]' : '')
    );
  }
  if (malformed.length) {
    out.push('');
    out.push(`  ${malformed.length} row(s) could not be read: ${malformed.map((r) => r.name).join(', ')}`);
  }
  out.push('');
  out.push(`  ${boundLine}`);
  out.push(`  ${ONE_RUN_CAVEAT}`);
  out.push(`  ${NO_BUDGET}`);
  out.push('');

  // ---- step summary: the rendering on the page a reviewer lands on --------
  const topN = ranked.slice(0, 10);
  const topShare = topN.reduce((a, r) => a + r.share, 0);
  const row = (r) =>
    `| ${r.rank} | \`${r.name}\`${r.verdict === 'FAILED' ? ' **FAILED**' : ''} | ${r.s.toFixed(1)} | ` +
    `${r.share.toFixed(1)}% | ${r.cumShare.toFixed(0)}% |`;
  const head = ['| # | script | seconds | share | cumulative |', '| --: | --- | --: | --: | --: |'];

  const md = [];
  md.push(`### verify cost — ${rows.length} scripts, ${fmt(total)}`);
  md.push('');
  if (top) {
    md.push(
      `**Slowest: \`${top.name}\` at ${top.s.toFixed(1)}s (${top.share.toFixed(1)}% of the loop).** ` +
        `The top ${topN.length} are ${topShare.toFixed(0)}% of it.`
    );
    md.push('');
  }
  if (failed.length) {
    md.push(`**${failed.length} script(s) FAILED:** ${failed.map((r) => `\`${r.name}\``).join(', ')}`);
    md.push('');
  }
  md.push(...head, ...topN.map(row));
  md.push('');
  if (ranked.length > topN.length) {
    md.push('<details><summary>all ' + ranked.length + ' scripts</summary>');
    md.push('');
    md.push(...head, ...ranked.map(row));
    md.push('');
    md.push('</details>');
    md.push('');
  }
  if (malformed.length) {
    md.push(`**${malformed.length} row(s) could not be read:** ${malformed.map((r) => r.name).join(', ')}`);
    md.push('');
  }
  md.push(`_${boundLine}_`);
  md.push('');
  md.push(`_${ONE_RUN_CAVEAT}_`);
  md.push('');
  md.push(`_${NO_BUDGET}_`);
  md.push('');

  return { stdout: out.join('\n'), markdown: md.join('\n'), total, ranked };
}

const input = fs.readFileSync(0, 'utf8');
const rows = parse(input);

if (rows.length === 0) {
  console.error(
    'ci-timing-report: no timing rows on stdin. The verify loop either ran nothing or its ' +
      'timing capture is not reaching this reporter — either way there is no attribution for ' +
      'this run, and reporting nothing would be indistinguishable from a clean one.'
  );
  process.exit(1);
}

const { stdout, markdown } = render(rows);
process.stdout.write(stdout + '\n');

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  fs.appendFileSync(summary, markdown + '\n');
} else {
  // Local runs have no summary file, and that is normal rather than a fault.
  process.stdout.write('(no GITHUB_STEP_SUMMARY set — step-summary rendering skipped)\n');
}
