#!/usr/bin/env node
// KAN-285: what an agent tree's resident set does over the first seconds of its
// life — the measurement `starts-in-flight.ts` said this model did not have.
//
// WHY IT IS NOT NAMED `verify-*`. It measures a machine rather than asserting
// anything about CrabCast, so there is no verdict for CI to gate on: run it on
// an idle box and it correctly reports that nothing started. The `kanNNN-`
// naming follows `kan385-herdr-handle-survey.mjs`, which is the same kind of
// artifact — a figure quoted in a source comment, kept re-runnable so the next
// reader can reproduce it rather than trust it.
//
// WHAT IT MEASURES. Every agent-runtime tree on the machine, sampled every
// `--interval-ms` for `--seconds`, split into two populations:
//
//   * BASELINE — trees already present at the first sample. These are the
//     CONTROL: a settled tree's RSS should sit roughly flat across the window,
//     and if it does not, the instrument is measuring noise rather than a ramp
//     and no reading below means anything.
//   * NEW — trees whose root pid was absent from the first sample. These are
//     the ramp, and t=0 for each is the sample it first appeared in.
//
// IT USES THE DAEMON'S OWN WALKER — `sampleProcesses`, `groupByAgent` and
// `paneHandleOf` are imported from `dist/agent-cost.js` rather than
// re-implemented, so a tree here is a tree by exactly the definition the
// capacity model divides by. That is the ticket's instruction and it is also
// the only way the figure is quotable in `capacity.ts`: a second walker would
// produce a number about a different thing.
//
// SO IT IMPORTS FROM `dist` AND IS GOVERNED BY THE STALE-BUILD RULE. A reading
// taken over a `dist` older than `src` is a reading about code you did not
// write. The freshness of the build is asserted below rather than left to the
// operator, and the script refuses to sample over a stale one.
//
// WHOSE TREES. Each tree's `HERDR_PANE_ID` is resolved through `herdr pane get`
// and the pane's label is printed verbatim. CrabCast names its panes
// `crabcast-*` and butchr names its `butchr-*`, so the population of every
// reading is legible rather than assumed — which is the whole of KAN-275's and
// KAN-338's complaint about the figures this one is meant to replace.
//
// RSS IS SUMMED ACROSS A TREE, WHICH DOUBLE-COUNTS SHARED PAGES. That is not a
// defect to fix here: `finishMeasurement` sums it exactly the same way, so this
// figure and `MEASURED_AGENT_COST.residentBytes` are the same quantity, which
// is the only property that makes comparing them legitimate.
//
// READ-ONLY. /proc, and `herdr pane get`. It starts no agent, sends nothing,
// and never touches the registry or the daemon. Whoever runs it starts the
// agents whose ramp it is meant to catch.
//
// VACUITY. A ramp measurement over a window in which nothing started measures
// nothing, and would print a clean report saying so. Exit code 4 is that case,
// stated as an exit rather than a sentence, because a green run over an empty
// fleet is exactly the "proof that supplies its own input" shape this epic
// keeps re-finding.
//
// usage: node scripts/kan285-start-ramp.mjs [--seconds N] [--interval-ms N]
//                                           [--json <file>] [--allow-stale-dist]

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIB = 1024 ** 2;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const seconds = Number(flag('--seconds', '45'));
const intervalMs = Number(flag('--interval-ms', '1000'));
const jsonOut = flag('--json', null);
const allowStaleDist = argv.includes('--allow-stale-dist');

/**
 * The stale-`dist` guard, run before anything is sampled.
 *
 * A setup guard rather than a verdict — it says the instrument cannot be
 * trusted, not that the machine failed a check — which is why it exits 2 and
 * the vacuity verdict below exits 4.
 */
function assertFreshDist() {
  const newestUnder = (dir, ext) => {
    let newest = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(ext)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
      }
    };
    walk(dir);
    return newest;
  };
  const distDir = path.join(REPO, 'dist');
  if (!fs.existsSync(distDir)) {
    console.error('dist/ is missing — run `npm run build` first.');
    process.exit(2);
  }
  const srcNewest = newestUnder(path.join(REPO, 'src'), '.ts');
  const distNewest = newestUnder(distDir, '.js');
  const stale = srcNewest > distNewest;
  console.log(
    `build freshness: newest src ${new Date(srcNewest).toISOString()}, ` +
      `newest dist ${new Date(distNewest).toISOString()} — ${stale ? 'STALE' : 'ok'}`
  );
  if (stale && !allowStaleDist) {
    console.error(
      'REFUSING TO SAMPLE over a dist older than src: every figure below would be\n' +
        'about code that was not built. Run `npm run build`, or pass\n' +
        '--allow-stale-dist if you mean to measure the older build deliberately.'
    );
    process.exit(2);
  }
}

assertFreshDist();

const { sampleProcesses, groupByAgent, paneHandleOf } = await import(
  path.join(REPO, 'dist', 'agent-cost.js')
);

/** The pane a handle names, or null. One `herdr pane get` per tree, once. */
function paneLabelFor(handle) {
  if (!handle) return null;
  const r = spawnSync('herdr', ['pane', 'get', handle], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const pane = JSON.parse(r.stdout)?.result?.pane ?? JSON.parse(r.stdout)?.result;
    return { label: pane?.label ?? null, cwd: pane?.cwd ?? null, paneId: pane?.pane_id ?? null };
  } catch {
    return null;
  }
}

/**
 * Which fleet a pane label belongs to. A prefix test and nothing cleverer: it
 * is how the daemon's own ownership test reads a pane (`ourPaneIn`, herdr.ts),
 * and a reader can check it against `herdr pane list` by eye.
 */
const fleetOf = (label) =>
  label === null || label === undefined
    ? 'unlabelled'
    : label.startsWith('crabcast-')
      ? 'crabcast'
      : label.startsWith('butchr-')
        ? 'butchr'
        : 'other';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

const samples = [];
const totalSamples = Math.max(2, Math.round((seconds * 1000) / intervalMs) + 1);
console.log(
  `sampling ${totalSamples} times at ${intervalMs}ms (${seconds}s) — ` +
    `started ${new Date().toISOString()}`
);

for (let i = 0; i < totalSamples; i++) {
  const at = Date.now();
  const procs = sampleProcesses();
  const groups = groupByAgent(procs);
  const trees = new Map();
  for (const [root, pids] of groups) {
    let rss = 0;
    for (const pid of pids) rss += procs.get(pid)?.rssBytes ?? 0;
    trees.set(root, { rss, processes: pids.length, comm: procs.get(root)?.comm ?? '?' });
  }
  samples.push({ at, trees });
  if (i < totalSamples - 1) await sleep(Math.max(0, intervalMs - (Date.now() - at)));
}

const t0 = samples[0].at;
const baselineRoots = new Set(samples[0].trees.keys());

/** Every root the window ever saw, with the sample index it first appeared in. */
const firstSeen = new Map();
for (let i = 0; i < samples.length; i++) {
  for (const root of samples[i].trees.keys()) if (!firstSeen.has(root)) firstSeen.set(root, i);
}

const seriesFor = (root) =>
  samples
    .map((s, i) => ({ i, ms: s.at - t0, ...(s.trees.get(root) ?? {}) }))
    .filter((p) => p.rss !== undefined);

function summarise(root) {
  const series = seriesFor(root);
  const rssMb = series.map((p) => p.rss / MIB);
  const max = Math.max(...rssMb);
  const min = Math.min(...rssMb);
  const first = series[0];
  const crossing = (frac) => {
    const hit = series.find((p) => p.rss / MIB >= frac * max);
    return hit ? (hit.ms - first.ms) / 1000 : null;
  };
  const tail = rssMb.slice(-3);
  const settled = tail.length === 3 && Math.max(...tail) - Math.min(...tail) <= 0.02 * max;
  return {
    root,
    comm: first.comm,
    firstSampleIndex: firstSeen.get(root),
    firstMs: first.ms,
    samples: series.length,
    firstRssMb: rssMb[0],
    lastRssMb: rssMb[rssMb.length - 1],
    minRssMb: min,
    maxRssMb: max,
    spreadPercentOfMax: ((max - min) / max) * 100,
    t50: crossing(0.5),
    t90: crossing(0.9),
    t95: crossing(0.95),
    settledAtEnd: settled,
    processesFirst: first.processes,
    processesLast: series[series.length - 1].processes,
    series: series.map((p) => ({ s: (p.ms - first.ms) / 1000, rssMb: p.rss / MIB, procs: p.processes }))
  };
}

const roots = [...firstSeen.keys()];
const attribution = new Map();
for (const root of roots) {
  const h = paneHandleOf(root);
  const pane = h.unreadable ? null : paneLabelFor(h.handle);
  attribution.set(root, {
    handle: h.handle,
    unreadable: h.unreadable,
    label: pane?.label ?? null,
    cwd: pane?.cwd ?? null,
    fleet: h.unreadable ? 'handle-unreadable' : h.handle === null ? 'no-handle' : fleetOf(pane?.label)
  });
}

const baseline = [...baselineRoots].map(summarise);
const fresh = roots.filter((r) => !baselineRoots.has(r)).map(summarise);

const line = (s, a) =>
  `  pid ${String(s.root).padStart(7)}  ${s.comm.padEnd(8)} ` +
  `${a.fleet.padEnd(17)} ${(a.label ?? '—').padEnd(34)} ` +
  `first ${s.firstRssMb.toFixed(0).padStart(4)} MB → max ${s.maxRssMb.toFixed(0).padStart(4)} MB ` +
  `(spread ${s.spreadPercentOfMax.toFixed(1).padStart(5)}% of max), ` +
  `procs ${s.processesFirst}→${s.processesLast}`;

console.log('\n§1 BASELINE — trees already present at the first sample (the control).');
console.log('   A settled tree should be roughly flat: a large spread here means the');
console.log('   window caught it doing work, and every ramp figure below is that much');
console.log('   less separable from ordinary variation.');
if (baseline.length === 0) console.log('  (none — no agent-runtime tree existed when sampling began)');
for (const s of baseline.sort((a, b) => b.maxRssMb - a.maxRssMb)) {
  console.log(line(s, attribution.get(s.root)));
}

console.log('\n§2 NEW — trees that appeared during the window. THIS IS THE RAMP.');
if (fresh.length === 0) {
  console.log('  (none)');
} else {
  for (const s of fresh.sort((a, b) => a.firstMs - b.firstMs)) {
    const a = attribution.get(s.root);
    console.log(line(s, a));
    console.log(
      `           appeared ${(s.firstMs / 1000).toFixed(1)}s into the window; ` +
        `reached 50% of its own max at ${s.t50 === null ? 'n/a' : s.t50.toFixed(1) + 's'}, ` +
        `90% at ${s.t90 === null ? 'n/a' : s.t90.toFixed(1) + 's'}, ` +
        `95% at ${s.t95 === null ? 'n/a' : s.t95.toFixed(1) + 's'}; ` +
        `${s.settledAtEnd ? 'flat over the last 3 samples' : 'STILL MOVING at the last sample'}`
    );
    console.log(
      '           series (s, MB, procs): ' +
        s.series.map((p) => `${p.s.toFixed(0)}:${p.rssMb.toFixed(0)}/${p.procs}`).join(' ')
    );
  }
}

console.log('\n§3 POPULATIONS SEEN');
const byFleet = {};
for (const root of roots) {
  const f = attribution.get(root).fleet;
  byFleet[f] = (byFleet[f] ?? 0) + 1;
}
for (const [f, n] of Object.entries(byFleet).sort()) console.log(`  ${f.padEnd(18)} ${n}`);
console.log(
  `  of the ${fresh.length} tree(s) that appeared during the window, ` +
    `${fresh.filter((s) => attribution.get(s.root).fleet === 'crabcast').length} were CrabCast's.`
);

if (jsonOut) {
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        takenAt: new Date(t0).toISOString(),
        seconds,
        intervalMs,
        samples: samples.length,
        baseline,
        fresh,
        attribution: Object.fromEntries([...attribution].map(([k, v]) => [k, v]))
      },
      null,
      2
    )
  );
  console.log(`\nraw series written to ${jsonOut}`);
}

if (fresh.length === 0) {
  console.error(
    '\nVACUOUS: no agent-runtime tree started during this window, so nothing here is a\n' +
      'measurement of a ramp. Start an agent while this runs.'
  );
  process.exit(4);
}
process.exit(0);
