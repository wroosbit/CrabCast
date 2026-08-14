#!/usr/bin/env node
// KAN-385: the survey behind docs/herdr-pane-handle-join.md, re-runnable.
//
// It is NOT a proof of CrabCast and is deliberately not named `verify-*`: every
// assertion here is about the installed herdr, which is somebody else's binary
// and not something this repository's CI has any business gating on. It exists
// so the reader of that page — and the reviewer of the pull request that added
// it — can reproduce every figure on it rather than taking the numbers on
// trust. Run it and compare; the page names herdr 0.6.4 on 2026-08-13.
//
// WHAT IT MEASURES
//   1. What `herdr pane list` publishes, key by key.
//   2. That no pid/tty/process/handle field exists on any of four read
//      commands.
//   3. That the environment handle is published nowhere in `pane list`.
//   4. Which target forms `herdr pane get` accepts.
//   5. That every agent-runtime tree on this machine joins, and that the
//      resolver discriminates.
//   6. Which identifiers herdr puts into a pane's environment.
//   7. What `pane --help` and `agent --help` document.
//   8. What the join costs per sampling window.
//
// EVERY PROBE CARRIES A CONTROL, AND THE CONTROLS ARE THE VERDICT. An absence
// is only a measurement if the same probe returns something for a thing that is
// present, so a failed CONTROL voids the reading it belongs to and this script
// exits non-zero. A changed READING does not: herdr may legitimately grow a
// field or a fleet may be a different size, and this script's job is to show
// you the difference, not to fail the build over it. Read the output.
//
// READ-ONLY. `pane list`, `pane get`, `agent list`, `agent get`, `--help`, and
// /proc. It starts nothing, sends nothing, renames nothing and closes nothing.
// It never touches ~/.local/share/crabcast, and it prints key names, labels and
// identifiers only — never a whole record and never a config block.
//
// WHAT IT DOES NOT COVER
//   * ONE MACHINE, ONE HERDR, ONE MOMENT. Nothing here says what any other
//     release does. That is `verify-herdr-release.mjs`'s question.
//   * IT DOES NOT TEST THE DAEMON. The join it surveys lives in
//     `paneHandleOf` (src/agent-cost.ts) and `paneNameForHandle`
//     (src/herdr.ts); this script re-implements the walk rather than importing
//     it, so agreement here is not evidence that those two functions agree with
//     it. `verify-agent-cost-attribution.mjs` is what covers them, and it
//     supplies its own handles rather than reading a real herdr — so THE GAP
//     BETWEEN THAT SCRIPT AND THIS ONE IS UNOWNED, and it is the gap where a
//     herdr that stopped resolving `p_NNN` would sit unnoticed. KAN-386 closed
//     it on 2026-08-14: `verify-herdr-release.mjs` §4b now makes that
//     assertion against the release under test, so the gap is owned for the
//     one moment it can change — a version move. It is still unowned in CI, by
//     the same decision (docs/herdr-pane-handle-join.md §4), and §4b does not
//     run on `--expect spawn-broken`.
//   * IT READS THE HELP TEXT, NOT A CONTRACT. §7's claim is about what these
//     binaries print.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

let controlFailures = 0;

const control = (label, ok, detail) => {
  if (!ok) controlFailures++;
  console.log(`   CONTROL ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// BOTH STREAMS, ALWAYS, AND THAT IS NOT A DETAIL — IT IS THIS SCRIPT'S OWN
// WORKED EXAMPLE OF THE THING THE PAGE IS ABOUT. herdr puts its error JSON on
// STDERR with a non-zero exit, and its `--help` text on STDERR with an exit of
// ZERO. Two drafts of this reader died on that, differently:
//
//   1. `execFileSync` returning stdout only. Every unresolved target came back
//      as an empty string, so `pane_not_found` and "the command said nothing"
//      became the same value — and a MUTATED handle therefore scored as
//      RESOLVED. §4 and §5 reported their controls at 7/7 where the truth is
//      0/7.
//   2. Catching the throw and joining the streams there. That fixes the errors
//      and NOT the help pages, because `pane --help` exits 0: the success path
//      returns stdout, which is empty, and §7 read both help pages as absent
//      while claiming to have checked what they document.
//
// Both were caught by CONTROLS and by nothing else, and note which way each
// failed: draft 1 turned a real absence into a false presence, draft 2 turned a
// real presence into a false absence. An instrument that cannot see reports the
// same shape as the finding you were hoping for. spawnSync, both streams,
// unconditionally.
const herdr = (...args) => {
  const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: 15_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};
const herdrJson = (...args) => {
  const raw = herdr(...args);
  const start = raw.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
};

/**
 * Did this target resolve, and to what? A record-or-error, never a bare string,
 * so "resolved to a pane with no label" and "did not resolve" cannot collapse
 * into each other — 102 of the panes here carry no `label`, so they would.
 */
const resolve = (cmd, target) => {
  const d = herdrJson(...cmd, target);
  const rec = d?.result?.pane ?? d?.result?.agent;
  if (rec) return { ok: true, name: rec.label ?? rec.name ?? '(no label)' };
  return { ok: false, name: d?.error?.code ?? 'no answer' };
};

const section = (n, title) => console.log(`\n${'='.repeat(78)}\n§${n}  ${title}\n${'='.repeat(78)}`);

const version = herdr('--version').trim();
console.log(`herdr: ${version}`);
console.log(`node:  ${process.version}`);

// ---------------------------------------------------------------- §1 pane list
section(1, 'What `herdr pane list` publishes');
const panes = herdrJson('pane', 'list')?.result?.panes ?? [];
console.log(`panes: ${panes.length}`);
const paneKeyCounts = new Map();
for (const p of panes) for (const k of Object.keys(p)) paneKeyCounts.set(k, (paneKeyCounts.get(k) ?? 0) + 1);
for (const [k, v] of [...paneKeyCounts].sort()) console.log(`  ${k.padEnd(14)} ${v}`);
control('pane list returned panes', panes.length > 0, `${panes.length} panes`);

// ------------------------------------------------- §2 no pid on four commands
section(2, 'No pid / tty / process field / handle, across four read commands');
const ABSENT = /pid|tty|proc|handle|env/i;
const PRESENT = /_id$/;
const myHandle = (() => {
  // Our own tree root is found in §5; for §2 any resolvable handle will do, and
  // this one is read from our own process ancestry below. Deferred until §5 has
  // run would reorder the output, so it is computed here.
  let pid = process.pid;
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    const h = handleOf(pid).handle;
    if (h) return h;
    pid = ppidOf(pid);
    if (!pid) break;
  }
  return null;
})();
console.log(`(resolving with this process's own handle: ${myHandle ?? 'NONE FOUND'})`);
const sources = {
  'pane list': panes,
  'pane get': myHandle ? [herdrJson('pane', 'get', myHandle)?.result?.pane].filter(Boolean) : [],
  'agent list': herdrJson('agent', 'list')?.result?.agents ?? [],
  'agent get': myHandle ? [herdrJson('agent', 'get', myHandle)?.result?.agent].filter(Boolean) : []
};
console.log(`\n${'command'.padEnd(12)}${'records'.padEnd(9)}${'ABSENT /pid|tty|proc|handle|env/i'.padEnd(36)}CONTROL /_id$/`);
for (const [name, recs] of Object.entries(sources)) {
  const keys = new Set(recs.flatMap((r) => Object.keys(r)));
  const absent = [...keys].filter((k) => ABSENT.test(k)).sort();
  const present = [...keys].filter((k) => PRESENT.test(k)).sort();
  console.log(
    `${name.padEnd(12)}${String(recs.length).padEnd(9)}${`${absent.length} ${JSON.stringify(absent)}`.padEnd(36)}${present.length} ${JSON.stringify(present)}`
  );
  control(`${name}: the probe can move (a key matching /_id$/ exists)`, present.length > 0);
}

// ---------------------------------------------- §3 the handle is not published
section(3, 'The environment handle is published nowhere in `pane list`');
const paneListRaw = herdr('pane', 'list');
const myPane = myHandle ? herdrJson('pane', 'get', myHandle)?.result?.pane : null;
const occurrences = (needle) => paneListRaw.split(`"${needle}"`).length - 1;
if (myHandle && myPane) {
  console.log(`  "${myHandle}" (the environment handle)   occurrences in pane list JSON: ${occurrences(myHandle)}`);
  console.log(`  "${myPane.pane_id}" (the published pane_id)  occurrences: ${occurrences(myPane.pane_id)}`);
  console.log(`  "${myPane.label}" (the label)               occurrences: ${occurrences(myPane.label)}`);
  console.log(`  any "p_<digits>" token anywhere:               ${(paneListRaw.match(/"p_\d+"/g) ?? []).length}`);
  control('the handle does not appear in pane list', occurrences(myHandle) === 0);
  control('CONTROL — but the pane_id does', occurrences(myPane.pane_id) > 0);
  control('CONTROL — and so does the label', occurrences(myPane.label) > 0);
} else {
  control('a handle and a pane were available for §3', false, 'no resolvable handle on this process tree');
}

// ------------------------------------------------ §4 which target forms resolve
section(4, 'Which target forms `herdr pane get` accepts');
if (myHandle && myPane) {
  const targets = [
    [myHandle, 'the environment handle'],
    [myPane.pane_id, 'the published pane_id'],
    [myPane.label, 'the label'],
    [`${myHandle}0`, 'CONTROL: the handle with one digit appended'],
    ['definitely-not-a-pane', 'CONTROL: nonsense']
  ];
  for (const [t, why] of targets) {
    const r = resolve(['pane', 'get'], t);
    console.log(`  ${String(t).padEnd(24)} -> ${(r.ok ? r.name : `UNRESOLVED (${r.name})`).padEnd(30)} ${why}`);
  }
  // Positive equality, not "the answer lacks the word not_found" — the failing
  // draft is described at `herdr` above.
  control('the handle resolves to this pane', resolve(['pane', 'get'], myHandle).name === myPane.label);
  control('the published pane_id resolves to it too', resolve(['pane', 'get'], myPane.pane_id).name === myPane.label);
  control('CONTROL — a mutated handle does not resolve', resolve(['pane', 'get'], `${myHandle}0`).ok === false);
  control('CONTROL — nonsense does not resolve', resolve(['pane', 'get'], 'definitely-not-a-pane').ok === false);
  control('CONTROL — the label is not a target either', resolve(['pane', 'get'], myPane.label).ok === false);
}

// ------------------------------------------------------------ §5 every tree joins
section(5, 'Every agent-runtime tree on this machine, joined');
const COMMS = new Set(
  [...fs.readFileSync(new URL('../src/launchers.ts', import.meta.url), 'utf8').matchAll(/runtimeComm:\s*'([^']+)'/g)].map(
    (m) => m[1]
  )
);
console.log(`AGENT_RUNTIME_COMMS, read from src/launchers.ts rather than assumed: ${[...COMMS].sort().join(', ')}`);
control('the launcher table was readable and non-empty', COMMS.size > 0);

function ppidOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return 0;
  }
}
function commOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
  } catch {
    return null;
  }
}
// Only HERDR_PANE_ID is ever taken out of environ — the same rule
// `paneHandleOf` states in src/agent-cost.ts, for the same reason.
function handleOf(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return { handle: null, unreadable: true };
  }
  for (const entry of raw.split('\0')) {
    if (entry.startsWith('HERDR_PANE_ID=')) {
      const v = entry.slice('HERDR_PANE_ID='.length);
      return { handle: v || null, unreadable: false };
    }
  }
  return { handle: null, unreadable: false };
}

const procs = new Map();
for (const e of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(e)) continue;
  const pid = Number(e);
  const comm = commOf(pid);
  if (comm !== null) procs.set(pid, { comm, ppid: ppidOf(pid) });
}
const rootOf = new Map();
const resolveRoot = (pid, seen = new Set()) => {
  if (rootOf.has(pid)) return rootOf.get(pid);
  const p = procs.get(pid);
  if (!p || seen.has(pid)) return null;
  seen.add(pid);
  const parentRoot = p.ppid > 1 ? resolveRoot(p.ppid, seen) : null;
  const root = parentRoot ?? (COMMS.has(p.comm) ? pid : null);
  rootOf.set(pid, root);
  return root;
};
const roots = [...new Set([...procs.keys()].map((p) => resolveRoot(p)).filter((r) => r !== null))].sort((a, b) => a - b);
console.log(`agent-runtime tree roots: ${roots.length}\n`);
console.log(`${'root pid'.padStart(9)}  ${'comm'.padEnd(8)}${'handle'.padEnd(9)}${'pane get -> label'.padEnd(28)}agent get -> name`);
let paneResolved = 0;
let agentResolved = 0;
let mutatedResolved = 0;
for (const r of roots) {
  const { handle, unreadable } = handleOf(r);
  const comm = procs.get(r).comm;
  if (!handle) {
    console.log(`${String(r).padStart(9)}  ${comm.padEnd(8)}${'-'.padEnd(9)}${(unreadable ? '(environ unreadable)' : '(no handle)').padEnd(28)}`);
    continue;
  }
  const pg = resolve(['pane', 'get'], handle);
  const ag = resolve(['agent', 'get'], handle);
  const mut = resolve(['pane', 'get'], `${handle}0`);
  if (pg.ok) paneResolved++;
  if (ag.ok) agentResolved++;
  if (mut.ok) mutatedResolved++;
  console.log(
    `${String(r).padStart(9)}  ${comm.padEnd(8)}${handle.padEnd(9)}${(pg.ok ? pg.name : `UNRESOLVED (${pg.name})`).padEnd(28)}${ag.ok ? ag.name : `UNRESOLVED (${ag.name})`}`
  );
}
console.log(`\n  pane get resolved: ${paneResolved}/${roots.length}   agent get resolved: ${agentResolved}/${roots.length}`);
control('CONTROL — the same resolver, every handle with one digit appended', mutatedResolved === 0, `${mutatedResolved}/${roots.length} resolved`);

console.log('\n`agent get` is strictly narrower than `pane get` — the coverage cost of moving the join:');
const agentPaneIds = new Set((herdrJson('agent', 'list')?.result?.agents ?? []).map((a) => a.pane_id));
const unregistered = panes.filter((p) => !agentPaneIds.has(p.pane_id));
console.log(`  panes: ${panes.length}   agent registrations: ${agentPaneIds.size}   panes with no registration: ${unregistered.length}`);
if (unregistered.length) {
  const one = unregistered[0].pane_id;
  const pg = resolve(['pane', 'get'], one);
  const ag = resolve(['agent', 'get'], one);
  console.log(`  ${one}: pane get -> ${pg.ok ? 'OK' : `UNRESOLVED (${pg.name})`} | agent get -> ${ag.ok ? 'OK' : `UNRESOLVED (${ag.name})`}`);
  control('an unregistered pane resolves under pane get', pg.ok === true);
  control('CONTROL — and does NOT under agent get', ag.ok === false, ag.name);
  const registered = [...agentPaneIds][0];
  const rp = resolve(['pane', 'get'], registered);
  const ra = resolve(['agent', 'get'], registered);
  console.log(`  ${registered}: pane get -> ${rp.ok ? 'OK' : 'UNRESOLVED'} | agent get -> ${ra.ok ? 'OK' : 'UNRESOLVED'}   (a REGISTERED pane, the control)`);
  control('CONTROL — a registered pane resolves under both', rp.ok && ra.ok);
}

// ------------------------------------------------- §6 what herdr puts in a pane
section(6, "Which identifiers herdr puts into a pane's environment");
{
  let pid = process.pid;
  let found = null;
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    if (handleOf(pid).handle) {
      found = pid;
      break;
    }
    pid = ppidOf(pid);
  }
  if (found) {
    const names = [
      ...new Set(
        fs
          .readFileSync(`/proc/${found}/environ`, 'latin1')
          .split('\0')
          .map((e) => e.match(/^(HERDR_[A-Z0-9_]+)=/)?.[1])
          .filter(Boolean)
      )
    ].sort();
    console.log(`  HERDR_* names (names only, never values): ${names.join(', ')}`);
    control('HERDR_PANE_ID is among them', names.includes('HERDR_PANE_ID'));
    control('CONTROL — a name that must be absent', !names.includes('HERDR_DEFINITELY_NOT_SET'));
    control(
      'no published-form identifier reaches the process',
      !names.some((n) => /PANE_LABEL|TERMINAL_ID|WORKSPACE_ID|TAB_ID/.test(n))
    );
  } else {
    control('a process carrying a handle was found for §6', false);
  }
}

// ------------------------------------------------------ §7 what the help documents
section(7, 'What the help text documents');
const paneHelp = herdr('pane', '--help');
const agentHelp = herdr('agent', '--help');
const paneGetLine = paneHelp.split('\n').find((l) => l.includes('pane get')) ?? '(NOT FOUND)';
const targetsLine = agentHelp.split('\n').find((l) => l.includes('targets accept')) ?? '(NOT FOUND)';
console.log(`  pane  --help:  ${paneGetLine.trim()}`);
console.log(`  agent --help:  ${targetsLine.trim()}`);
control('both help pages were actually read', paneHelp.length > 0 && agentHelp.length > 0);
control('`pane --help` documents its parameter as <pane_id>', /pane get <pane_id>/.test(paneGetLine));
control('`pane --help` does NOT mention legacy ids', !/legacy/i.test(paneHelp));
control('CONTROL — `agent --help` does', /legacy pane ids/i.test(agentHelp));

// -------------------------------------------------------------- §8 what it costs
section(8, 'What the join costs');
const timeMs = (fn, n = 15) => {
  const ts = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return ts.sort((a, b) => a - b)[Math.floor(n / 2)];
};
if (myHandle) {
  const perGet = timeMs(() => herdr('pane', 'get', myHandle));
  const perCensus = timeMs(() => herdr('agent', 'list'));
  console.log(`  herdr pane get <handle>   median ${perGet.toFixed(0)} ms`);
  console.log(`  herdr agent list          median ${perCensus.toFixed(0)} ms   (the census we already take)`);
  console.log(
    `\n  cadence: COST_SAMPLE_INTERVAL_MS = 60_000 (src/daemon.ts) — one census plus one\n` +
      `  \`pane get\` per agent-runtime tree, once a minute. ${roots.length} trees -> ~${(roots.length * perGet).toFixed(0)} ms/min,\n` +
      `  which is the whole of the efficiency argument for publishing the handle, and it is\n` +
      `  not an argument. See docs/herdr-pane-handle-join.md §2.8.`
  );
  control('the timing loop actually ran', perGet > 0);
}

console.log(`\n${'='.repeat(78)}`);
if (controlFailures) {
  console.log(`${controlFailures} CONTROL(S) FAILED — the readings above are void, not merely different.`);
} else {
  console.log('ALL CONTROLS PASSED — the readings above are measurements.');
}
console.log(`${'='.repeat(78)}`);
process.exit(controlFailures ? 1 : 0);
