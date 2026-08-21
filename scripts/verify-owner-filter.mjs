#!/usr/bin/env node
// Proof for KAN-193: an application can find ITS OWN agents without parsing
// their names, and an agent that belongs to nobody is not handed to whoever
// asks first.
//
// WHAT FAILURE THIS WOULD CATCH: a filter that treats ABSENCE AS A WILDCARD.
// Every agent configured before `owner` existed carries none, and a filter
// written with a truthy test — `!row.config?.owner || row.config.owner === x`,
// or a `?? wanted`, either of which reads as tidying up the unconfigured row —
// returns every one of them to the first caller that asks for its own. The
// named caller for this field is a reconciler whose last step is *"anything
// running that is not in my desired list → off"*, so that filter does not
// over-report a listing: it stands down other people's agents. §2 is the
// section that would go red, and it goes red in both directions, because
// "matches nothing" and "matches everything" are the two ways to get `undefined`
// wrong and they look identical in a demo where every agent happens to be owned.
//
// It would also catch the four smaller ways this can be got wrong, each with
// its own section: a filter applied to some categories and not others (§3), a
// filter applied AFTER paging so that `total` and `nextCursor` describe a set
// the caller cannot see (§4), an exact match that has quietly become a prefix
// match (§8), and an `owner` that has reached the capacity gate (§6).
//
// THE STATE IS PRODUCED, NOT DESCRIBED. §1 stands agents up through
// `configure_agent`, `activate_agent` and `deactivate_agent` on the real router
// against a herdr stub — the same verbs a supervisor calls — and only then reads
// them back. Nothing here builds a registry row carrying an `owner` and then
// asserts that the daemon carries `owner`, which is the KAN-145 shape: a proof
// that supplies its own input has not tested that the input arrives.
//
// THE ONE PLACE THIS SCRIPT WRITES A RECORD DIRECTLY, named so no reader has to
// infer a coverage that is not here: §1 produces its `preemptedAgents` rows with
// `AgentRegistry.recordDeactivated(record, preemption)` rather than by driving a
// real preemption. A real one needs the machine to be AT capacity, and the cap
// is derived from the runner's own cores and memory — so a proof that produced
// one would be a proof whose fixture size depends on the hardware. What this
// costs is stated rather than hidden: that category's rows are written, so what
// §§2-4 prove about `preemptedAgents` is that THE FILTER reads an owner off a
// row correctly, and NOT that a real preemption preserves one. The second is
// `verify-agent-preemption.mjs`'s subject and it is not asserted here. Every
// other category in every section is verb-produced.
//
// WHAT THIS SCRIPT DOES NOT COVER, and who does:
//
//   * A REAL herdr. Every section replaces the `herdr` binary with a stub, so
//     what is proven is the daemon's own filtering over a census.
//   * A REAL PREEMPTION — see the paragraph above, and
//     `verify-agent-preemption.mjs`.
//
// AND THE ONE THAT USED TO BE HERE, because how it closed is the point. This
// list carried "THE MCP AND CLI SURFACES — §9 reads their descriptions and
// nothing joins the argument to this handler", which was true and was the
// KAN-145 shape sitting in plain sight: every other section drives
// `MessageRouter` in-process, so all of them stay green against a CLI that
// drops `--owner` and an MCP tool that never puts `owner` on the request.
// `verify-cli-parity.mjs` does not close it — it reconciles ACTIONS against
// commands and says nothing about a command's arguments. §11 closes it instead
// of declaring it: the real `dist/cli.js` and the real `dist/mcp.js` against a
// real daemon the CLI itself spawns. Writing the gap down was what made it
// obvious it could be closed, and running the CLI by hand to draft that section
// is what found the duplicated `owner:` line §11 now guards.
//   * WHETHER ANY CONSUMER SETS AN OWNER. Nothing does yet — that was the
//     substance of the deferral this ticket sat under, and it is unchanged by
//     shipping the field. What is proven here is that the mechanism is correct
//     and, in particular, that it is correct for the nullable case that the
//     absence of a consumer makes UNIVERSAL: today every agent in production is
//     unowned, so §2 is not an edge case, it is the whole fleet.
//
// Usage:
//   npm run build
//   node scripts/verify-owner-filter.mjs [distDir]

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { makeMutator } from './mutation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
// §11 drives the two published surfaces against a REAL daemon, so it needs the
// socket to find and stop the one the CLI spawns.
const { connectToDaemon, onJsonLines, writeJsonLine } =
  await import(path.join(distDir, 'ipc.js'));

// --------------------------------------------------------------- the harness

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

const failures = [];
const check = (ok, claim, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures.push(claim);
  return ok;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan193-'));
const realPath = process.env.PATH;
/** Daemons and MCP servers §11 started, so none is left behind. */
const spawned = { daemons: new Set(), children: new Set() };
function cleanup() {
  for (const child of spawned.children) { try { child.kill(); } catch {} }
  for (const pid of spawned.daemons) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

const dataDir = path.join(tmp, 'data');
const configPath = path.join(tmp, 'crabcast.config.json');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }, null, 2));
const config = loadConfig(configPath);

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });
const CENSUS_FILE = path.join(tmp, 'census.json');
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat ${JSON.stringify(CENSUS_FILE)}
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then
  echo '{"error":{"code":"agent_not_found","message":"no such agent"}}'
  exit 1
fi
echo '{"result":{}}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${bin}:${realPath}`;

function setCensus(panes) {
  fs.writeFileSync(
    CENSUS_FILE,
    JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: panes } })
  );
}
setCensus([]);

const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
const foreignPane = (dir, paneId, name) => ({
  name, pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});

/**
 * A router over a named registry file. `RouterCtor`/`RegistryCtor` are
 * parameters so a mutation section can stand the SAME fleet up against a
 * mutated build — see §10, where every mutant is driven through this.
 */
function harness(logName, Ctors = {}) {
  const Router = Ctors.MessageRouter ?? MessageRouter;
  const Registry = Ctors.AgentRegistry ?? AgentRegistry;
  const agentRegistry = new Registry(path.join(tmp, `${logName}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const invoke = (request) =>
    new Promise((resolve) => {
      new Router({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: () => {}
      }).handle(request);
    });
  return { agentRegistry, invoke };
}

/** A directory the caller already owns. An agent is one of these and nothing else. */
function ownedDir(...parts) {
  const dir = path.join(tmp, 'dirs', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// The two owners and the third state. `MINE` and `THEIRS` are deliberately not
// prefixes of one another, and §8 adds strings that ARE.
const MINE = 'butchr';
const THEIRS = 'someone-else';
const KNOBS = { priority: 1, launcher: 'shell' };

const paths = (rows) => (rows ?? []).map((r) => r.path);
const basenames = (rows) => paths(rows).map((p) => path.basename(p)).sort();
const has = (rows, dir) => paths(rows).includes(dir);

/** Every category a filter is supposed to narrow, in one place. */
const FILTERED = ['agents', 'missingAgents', 'preemptedAgents', 'standbyAgents', 'unstartedAgents',
  // KAN-594. Filtered like every other category built from a record: a
  // stranded row carries the owner its record was configured with, and the
  // directory going away does not un-own it.
  'strandedAgents'];
/** Every row-carrying array it is supposed to leave whole. */
const UNFILTERED = ['unbackedPanes', 'foreignPanes', 'priorities', 'unreadableRecords'];

/** Every filtered category's rows, flattened — "what did this read show me". */
const shown = (res) => FILTERED.flatMap((c) => res[c] ?? []);

// ===========================================================================
rule('1. THE FLEET, PRODUCED — every filtered category holding all three states');
// ===========================================================================
//
// THE PRECONDITION FOR EVERYTHING BELOW. Each of the five categories must
// really hold an agent owned by MINE, one owned by THEIRS and one owned by
// NOBODY, or the sections after it assert over categories that happen to be
// empty and report a completeness nobody achieved. That is the vacuous pass
// this suite is shaped against, and it is why this section's verdict is a
// PRECONDITION rather than a result: nothing here is the property, all of it is
// what makes the property measurable.

// TWO ROUTERS OVER ONE REGISTRY, and the second is not a convenience.
//
// `missing` means the record says activated and the census has no such agent.
// A router that performed the activation is still holding that agent's SESSION,
// and an agent this daemon is attached to is `running` whatever the census says
// — correctly, since the daemon can see it. So the state cannot be produced and
// then read by the same router: `s1produce` stands the fleet up, and `s1` is a
// FRESH daemon over the surviving registry, which is exactly the situation a
// missing agent arises in (a daemon restart over a fleet that did not come
// back). Reading through `s1` is therefore more realistic than a single router
// would have been, not less.
const s1produce = harness('s1');
const s1 = harness('s1');
const fleet = {};

/** §1's census, kept so a later section can put it back. See where it is set. */
let mainCensus = [];
/** Read `s1`'s fleet against §1's census whatever an intervening section did. */
const readS1 = async (request) => {
  setCensus(mainCensus);
  return s1.invoke(request);
};

{
  // Three owners × four verb-produced categories. `agents` is produced by
  // leaving them running; `standbyAgents` by standing them down;
  // `unstartedAgents` by never activating; `missingAgents` by activating and
  // then taking the pane out of the census, which is what a lost agent IS.
  const owners = [['mine', MINE], ['theirs', THEIRS], ['nobody', undefined]];
  let paneId = 100;

  for (const [tag, owner] of owners) {
    const withOwner = owner === undefined ? {} : { owner };

    // --- unstarted: configured, never activated
    const unstarted = ownedDir('unstarted', tag);
    await s1produce.invoke({ action: 'configure_agent', path: unstarted, ...KNOBS, ...withOwner });

    // --- running: configured and activated, pane still in the census at the end
    const running = ownedDir('running', tag);
    await s1produce.invoke({ action: 'configure_agent', path: running, ...KNOBS, ...withOwner });
    setCensus([ourPane(running, `%${paneId++}`)]);
    await s1produce.invoke({ action: 'activate_agent', path: running });

    // --- standby: activated, then stood down through the verb
    const standby = ownedDir('standby', tag);
    await s1produce.invoke({ action: 'configure_agent', path: standby, ...KNOBS, ...withOwner });
    setCensus([ourPane(standby, `%${paneId++}`)]);
    await s1produce.invoke({ action: 'activate_agent', path: standby });
    await s1produce.invoke({ action: 'deactivate_agent', path: standby });

    // --- missing: activated, and then the pane never comes back. It reads as
    //     `missing` through `s1`, the fresh daemon, and not through the one
    //     that activated it — see the note above the two harnesses.
    const missing = ownedDir('missing', tag);
    await s1produce.invoke({ action: 'configure_agent', path: missing, ...KNOBS, ...withOwner });
    setCensus([ourPane(missing, `%${paneId++}`)]);
    await s1produce.invoke({ action: 'activate_agent', path: missing });

    // --- preempted: WRITTEN, not produced. The header says why, and says what
    //     that leaves uncovered.
    const preempted = ownedDir('preempted', tag);
    await s1produce.invoke({ action: 'configure_agent', path: preempted, ...KNOBS, ...withOwner });
    setCensus([ourPane(preempted, `%${paneId++}`)]);
    await s1produce.invoke({ action: 'activate_agent', path: preempted });
    // `intentsFrom` rather than the raw log rows: it is what strips a row's
    // log fields back to the RECORD a later activation is rebuilt from, which
    // is exactly the shape `recordDeactivated` takes. Reading a raw entry here
    // would carry `v` and `event` into the stand-down row.
    const intent =
      AgentRegistry.intentsFrom(s1produce.agentRegistry.read().entries).get(preempted);
    s1produce.agentRegistry.recordDeactivated(intent.record, {
      byPath: running,
      byPaneName: paneNameFor(running),
      byPriority: 9,
      priority: 1,
      herdrStatus: 'working',
      derivation: 'written by verify-owner-filter.mjs §1; see its header'
    });

    // --- stranded: configured at a directory that EXISTED, which is then
    //     deleted with no `forget` (KAN-594). The owner is on the record and
    //     the directory going away does not un-own it, so this category is
    //     filtered like every other one built from a record — which is the
    //     property §§2-3 are about to assert over it.
    const stranded = ownedDir('stranded', tag);
    await s1produce.invoke({ action: 'configure_agent', path: stranded, ...KNOBS, ...withOwner });
    fs.rmSync(stranded, { recursive: true, force: true });

    fleet[tag] = { unstarted, running, standby, missing, preempted, stranded };
  }

  // The running agents are the census now, plus one pane that is NOT ours —
  // `foreignPanes` is a category the filter must leave alone, and it needs a
  // row for §3 to be able to say so.
  //
  // HELD IN A VARIABLE AND RE-APPLIED, not merely set once. The census is ONE
  // file shared by every harness in this script, so a later section that stands
  // its own fleet up overwrites it — §4 produces ninety agents and ends with an
  // empty census. The sections after it then read `s1` through whatever §4 left
  // behind, which on the first run silently emptied `agents` and made §6's
  // capacity comparison two zeroes agreeing and §7's config echo `undefined`.
  // §6's precondition is what caught it, which is what that precondition is for.
  const foreignDir = ownedDir('foreign', 'not-ours');
  mainCensus = [
    ourPane(fleet.mine.running, '%1'),
    ourPane(fleet.theirs.running, '%2'),
    ourPane(fleet.nobody.running, '%3'),
    foreignPane(foreignDir, '%9', 'somebody-elses-pane')
  ];
  setCensus(mainCensus);

  const all = await s1.invoke({ action: 'list_agents' });

  const populated = FILTERED.filter((c) => {
    const rows = all[c] ?? [];
    return ['mine', 'theirs', 'nobody'].every((tag) =>
      rows.some((r) => Object.values(fleet[tag]).includes(r.path))
    );
  });

  console.log(`   categories holding all three owner states: ${populated.join(', ') || '(none)'}`);
  for (const c of FILTERED) console.log(`   ${c}: ${basenames(all[c]).join(', ') || '(empty)'}`);
  console.log(`   foreignPanes: ${(all.foreignPanes ?? []).length} row(s)`);

  check(
    populated.length === FILTERED.length,
    'PRECONDITION — every one of the six filtered categories really holds an agent owned by ' +
      'each of the two owners AND one owned by nobody, so the sections below assert over ' +
      'populated categories rather than empty ones',
    `${populated.length}/${FILTERED.length}: ${populated.join(', ')}`
  );
  check(
    (all.foreignPanes ?? []).length > 0,
    'PRECONDITION — a foreign pane is in the census, so §3 can assert the filter LEAVES it ' +
      'rather than asserting over an empty list',
    `${(all.foreignPanes ?? []).length} row(s)`
  );
  check(
    all.ownerFilter === undefined,
    'an UNFILTERED read carries no `ownerFilter` block at all — absence is how a consumer ' +
      'tells the two apart, and it is what makes this field additive for a caller that never ' +
      'sends one',
    `ownerFilter: ${JSON.stringify(all.ownerFilter)}`
  );
}

// ===========================================================================
rule('2. ABSENCE IS NOT A WILDCARD — the unowned agent, from both directions');
// ===========================================================================
//
// CRITERION 3, AND THE SAFETY-CRITICAL ONE. Two halves, and a filter can pass
// either alone: the unowned agent must be EXCLUDED from a filter for any owner,
// and REACHABLE when no filter is passed. Excluded-only would be a filter that
// returns nothing; reachable-only would be a filter that returns everything.

{
  const unowned = Object.values(fleet.nobody);

  const forMine = await s1.invoke({ action: 'list_agents', owner: MINE });
  const forTheirs = await s1.invoke({ action: 'list_agents', owner: THEIRS });
  const forNobodyAtAll = await s1.invoke({ action: 'list_agents', owner: 'an-owner-nobody-has' });
  const unfiltered = await s1.invoke({ action: 'list_agents' });

  const leakedInto = (res, label) =>
    unowned.filter((dir) => has(shown(res), dir)).map((d) => `${label}:${path.basename(d)}`);
  const leaked = [
    ...leakedInto(forMine, MINE),
    ...leakedInto(forTheirs, THEIRS),
    ...leakedInto(forNobodyAtAll, 'an-owner-nobody-has')
  ];

  const reachable = unowned.filter((dir) => has(shown(unfiltered), dir));

  console.log(`   unowned agents produced      : ${unowned.map((d) => path.basename(d)).length}`);
  console.log(`   of those, in a FILTERED read : ${leaked.length ? leaked.join(', ') : 'none'}`);
  console.log(`   of those, in an UNFILTERED   : ${reachable.length}/${unowned.length}`);

  check(
    leaked.length === 0,
    'HALF ONE — an agent with NO owner is returned by NO filter, for any owner, in any ' +
      'category. Absence is a real state and never a match: a filter that said otherwise would ' +
      'hand a reconciler every legacy agent on the machine as a candidate to stand down',
    leaked.length ? `leaked: ${leaked.join(', ')}` : '0 of 5 categories × 3 filters leaked'
  );
  check(
    reachable.length === unowned.length,
    'HALF TWO (a CONTROL, and the one that stops half one being satisfied by a filter that ' +
      'returns nothing) — every one of them is REACHABLE by a read that passes no filter, so ' +
      '"excluded" means excluded from the FILTER rather than lost from the daemon',
    `${reachable.length}/${unowned.length} reachable unfiltered`
  );
  check(
    forMine.success === true && forTheirs.success === true && forNobodyAtAll.success === true &&
      Boolean(forNobodyAtAll.ownerFilter),
    'a filter that matches nothing SUCCEEDS with empty categories rather than refusing — ' +
      '"no agents of yours" is an answer, and a refusal there would be a caller mistake ' +
      'reported for a fleet state. It carries the `ownerFilter` block too, which is what ' +
      'separates "your filter ran and matched nothing" from "your filter was ignored"',
    `mine=${forMine.success} theirs=${forTheirs.success} nobody=${forNobodyAtAll.success} ` +
      `block=${Boolean(forNobodyAtAll.ownerFilter)}`
  );
  check(
    shown(forNobodyAtAll).length === 0 && forNobodyAtAll.unstartedTotal === 0,
    'and that empty answer is really empty — every filtered category AND its `*Total` is 0 ' +
      'for an owner nobody has, which is what makes the two halves above a partition rather ' +
      'than an overlap',
    `rows ${shown(forNobodyAtAll).length}, unstartedTotal ${forNobodyAtAll.unstartedTotal}`
  );
}

// ===========================================================================
rule('3. EVERY ROW-CARRYING CATEGORY — narrowed, or left whole and SAID SO');
// ===========================================================================
//
// DECISION 7. "Find all of X's agents" that silently omitted their MISSING ones
// would be worse than no filter, because it reads as a complete answer. The
// same defect points the other way too: a filtered response that quietly
// carried somebody else's pane would be read as X's.

{
  const mine = await s1.invoke({ action: 'list_agents', owner: MINE });
  const unfiltered = await s1.invoke({ action: 'list_agents' });

  const wrong = [];
  for (const category of FILTERED) {
    const rows = mine[category] ?? [];
    const foreignRows = rows.filter((r) => r.config?.owner !== MINE);
    const expected = (unfiltered[category] ?? []).filter((r) => r.config?.owner === MINE);
    if (foreignRows.length) wrong.push(`${category} carried ${foreignRows.length} not-mine`);
    if (rows.length !== expected.length) {
      wrong.push(`${category} carried ${rows.length}, unfiltered holds ${expected.length} of mine`);
    }
    console.log(`   ${category}: ${rows.length} row(s), all mine=${!foreignRows.length}`);
  }

  check(
    wrong.length === 0,
    `ALL FIVE narrowed — ${FILTERED.join(', ')} — each carrying exactly the rows of that owner ` +
      'and no others. Not four of five: the one left out is the one a caller never notices, ' +
      'because a category that is empty for the right reason and a category nobody filtered ' +
      'look identical until the day it is not empty',
    wrong.length ? wrong.join('; ') : 'five of five'
  );

  const keptWhole = [];
  const notKept = [];
  for (const category of UNFILTERED) {
    const before = (unfiltered[category] ?? []).length;
    const after = (mine[category] ?? []).length;
    (before === after ? keptWhole : notKept).push(`${category} ${before}→${after}`);
  }
  // THE DISCRIMINATION GUARD, and the reason it is here rather than assumed.
  // "These four did not change" is TRIVIALLY TRUE of a daemon that narrows
  // nothing at all — the pre-fix build passes it exactly as the fixed one does,
  // which `kan193-red-drive.mjs` measured rather than argued. So the claim is
  // only worth anything paired with evidence that something else in the SAME
  // pair of reads DID move.
  const narrowedAtAll = FILTERED.filter(
    (c) => (mine[c] ?? []).length < (unfiltered[c] ?? []).length
  );
  check(
    notKept.length === 0 && narrowedAtAll.length > 0,
    'and the four that are NOT narrowed are complete under the filter — while the filtered ' +
      'categories in the very same read DID shrink, so this is "left whole" rather than ' +
      '"nothing was filtered". `unbackedPanes` and `foreignPanes` have no record and therefore ' +
      'no owner, `priorities` is a fact about the MACHINE (decision 6), and `unreadableRecords` ' +
      'cannot be filtered because the row could not be parsed — and may well be the asking ' +
      'caller\'s own agent',
    `${notKept.length ? `CHANGED: ${notKept.join('; ')}` : keptWhole.join(', ')} | ` +
      `narrowed in the same read: ${narrowedAtAll.join(', ') || 'NONE'}`
  );

  // THE BLOCK IS THE ONLY THING ON THE WIRE THAT SAYS ANY OF THE ABOVE. Every
  // `*Total` beside it counts the filtered set, which is what keeps paging
  // correct — and it means the numbers alone cannot say a filter was applied.
  const block = mine.ownerFilter;
  check(
    Boolean(block) && block.owner === MINE,
    'the response carries an `ownerFilter` block echoing the owner asked for, EXACTLY as sent',
    `ownerFilter.owner=${JSON.stringify(block?.owner)}`
  );
  check(
    JSON.stringify(block?.filtered) === JSON.stringify(FILTERED) &&
      JSON.stringify(block?.unfiltered) === JSON.stringify(UNFILTERED),
    'and it NAMES both sets — what was narrowed and what was left whole — so a consumer reads ' +
      'the shape of the answer off the answer rather than off this document. A filtered ' +
      'response is otherwise indistinguishable from a complete one',
    `filtered=${JSON.stringify(block?.filtered)} unfiltered=${JSON.stringify(block?.unfiltered)}`
  );
  check(
    typeof block?.note === 'string' && /not a permission boundary/i.test(block.note),
    'and it carries the non-boundary sentence, on the wire, attached to the answer somebody ' +
      'would draw the mistaken conclusion from — the third of decision 5\'s homes for it and ' +
      'the cheapest of them to meet',
    `note: ${String(block?.note).slice(0, 70)}…`
  );
}

// ===========================================================================
rule('4. PAGING UNDER THE FILTER — the cursor walks the FILTERED category');
// ===========================================================================
//
// KAN-163's property, re-asserted under the new argument. The filter is applied
// BEFORE `pageFleetCategory`, so `total`, `remaining` and `nextCursor` all
// describe the filtered set by construction. Filtering a PAGE instead would
// leave `total` counting rows the caller cannot see and a cursor walking a
// sequence that thins unpredictably — 25 in, 3 out, and a consumer told to
// follow it until null with no way to know how far it has got.

const s4 = harness('s4');
const STANDBY_PER_OWNER = 30;

{
  let paneId = 500;
  const made = { [MINE]: [], [THEIRS]: [], unowned: [] };
  for (let i = 0; i < STANDBY_PER_OWNER; i += 1) {
    for (const [tag, owner] of [[MINE, MINE], [THEIRS, THEIRS], ['unowned', undefined]]) {
      const dir = ownedDir('paged', `${tag}-${String(i).padStart(2, '0')}`);
      await s4.invoke({
        action: 'configure_agent', path: dir, ...KNOBS,
        ...(owner === undefined ? {} : { owner })
      });
      setCensus([ourPane(dir, `%${paneId++}`)]);
      await s4.invoke({ action: 'activate_agent', path: dir });
      await s4.invoke({ action: 'deactivate_agent', path: dir });
      made[tag].push(dir);
    }
  }
  setCensus([]);

  /** The walk a consumer is told to make, under a filter. */
  async function walk(owner, category, limit) {
    const rows = [];
    let after = null;
    for (let n = 0; n <= 40; n += 1) {
      if (n === 40) return { rows, overran: true };
      const request = { action: 'list_agents', ...(owner ? { owner } : {}) };
      request.pages = { [category]: { ...(after !== null ? { after } : {}), limit } };
      const res = await s4.invoke(request);
      if (res.success !== true) return { rows, refused: res.error };
      rows.push(...(res[category] ?? []));
      const page = res.pages?.[category];
      if (!page) return { rows, missingPageBlock: true };
      if (page.nextCursor === null || page.nextCursor === undefined) {
        return { rows, overran: false, total: page.total };
      }
      after = page.nextCursor;
    }
    return { rows, overran: true };
  }

  const firstPage = await s4.invoke({ action: 'list_agents', owner: MINE });
  console.log(`   produced ${STANDBY_PER_OWNER} standby agents for each of ` +
    `${MINE}, ${THEIRS} and nobody (${STANDBY_PER_OWNER * 3} rows in the category)`);
  console.log(`   a default FILTERED read carries ${firstPage.standbyAgents.length}, ` +
    `standbyTotal ${firstPage.standbyTotal}`);
  console.log(`   pages.standbyAgents: ${JSON.stringify(firstPage.pages?.standbyAgents)}`);

  check(
    firstPage.standbyTotal === STANDBY_PER_OWNER,
    '`standbyTotal` under a filter counts the FILTERED category, not the whole one — the ' +
      'number a consumer sizes its walk against describes the set it is walking',
    `${firstPage.standbyTotal}, whole category is ${STANDBY_PER_OWNER * 3}`
  );
  check(
    firstPage.standbyAgents.length === 25 && firstPage.pages?.standbyAgents?.nextCursor !== null &&
      firstPage.pages?.standbyAgents?.total === STANDBY_PER_OWNER &&
      firstPage.pages?.standbyAgents?.remaining === STANDBY_PER_OWNER - 25,
    'a default filtered read is still ONE PAGE with a cursor past it, and the page block\'s own ' +
      '`total` and `remaining` describe the FILTERED category — filtering did not quietly turn ' +
      'a paged category into a complete one, and the page did not keep counting rows the ' +
      'caller cannot reach. Both would be ways to be wrong about completeness',
    `returned ${firstPage.standbyAgents.length}, total ${firstPage.pages?.standbyAgents?.total} ` +
      `(whole category ${STANDBY_PER_OWNER * 3}), remaining ` +
      `${firstPage.pages?.standbyAgents?.remaining}, nextCursor ` +
      `${firstPage.pages?.standbyAgents?.nextCursor === null ? 'null' : 'present'}`
  );

  const walked = await walk(MINE, 'standbyAgents', 7);
  const walkedPaths = new Set(paths(walked.rows));
  const strays = walked.rows.filter((r) => r.config?.owner !== MINE);

  console.log(`   walking pages.standbyAgents at limit 7 under owner=${MINE}: ` +
    `${walked.rows.length} row(s), overran=${walked.overran}`);

  check(
    walked.overran === false && !walked.refused,
    'CONTROL — the walk TERMINATES under a filter: `nextCursor` reaches null rather than ' +
      'cycling, which a cursor that silently reset would not do. It is a control rather than a ' +
      'result, and labelled one because it is true of any working pager, filter or no filter — ' +
      'what it buys is that the row counts below are a completed walk and not a truncated one',
    walked.refused ? `refused: ${walked.refused}` : `${walked.rows.length} rows`
  );
  check(
    walked.rows.length === STANDBY_PER_OWNER && walkedPaths.size === STANDBY_PER_OWNER,
    `the walk reaches EVERY one of the owner's ${STANDBY_PER_OWNER} rows, each exactly once — ` +
      'no row hidden by a page boundary and none handed over twice',
    `${walked.rows.length} rows, ${walkedPaths.size} distinct`
  );
  check(
    strays.length === 0 && made[MINE].every((d) => walkedPaths.has(d)),
    'and they are exactly that owner\'s rows: nobody else\'s appeared at any page boundary, ' +
      'and none of the owner\'s went missing at one',
    `${strays.length} stray(s); ${made[MINE].filter((d) => !walkedPaths.has(d)).length} missing`
  );

  const unfilteredWalk = await walk(null, 'standbyAgents', 7);
  check(
    unfilteredWalk.rows.length === STANDBY_PER_OWNER * 3,
    'CONTROL — the same walk with NO filter reaches all three owners\' rows, so the numbers ' +
      'above are the filter working rather than the pager losing rows',
    `${unfilteredWalk.rows.length} of ${STANDBY_PER_OWNER * 3}`
  );
}

// ===========================================================================
rule('5. NOT A SECURITY BOUNDARY — asserted as INTENDED, not tolerated');
// ===========================================================================
//
// CRITERION 4. A field called `owner` will be read as access control by
// somebody. This section is the one that keeps the claim from outrunning the
// mechanism: the SAME caller on the SAME socket reads another owner's agents,
// deliberately, and that is asserted to be correct behaviour rather than
// observed and left alone.

{
  const asMine = await readS1({ action: 'list_agents', owner: MINE });
  const asTheirs = await readS1({ action: 'list_agents', owner: THEIRS });
  const noFilter = await readS1({ action: 'list_agents' });

  const theirAgents = Object.values(fleet.theirs);
  const seenByTheSameCaller = theirAgents.filter((d) => has(shown(noFilter), d));
  const seenViaTheirFilter = theirAgents.filter((d) => has(shown(asTheirs), d));

  console.log(`   one caller, one socket, three reads: owner=${MINE}, owner=${THEIRS}, none`);
  console.log(`   ${THEIRS}'s agents visible to that caller unfiltered : ` +
    `${seenByTheSameCaller.length}/${theirAgents.length}`);

  check(
    seenByTheSameCaller.length === theirAgents.length,
    'INTENDED, and deliberately an assertion about an ABSENCE: a caller that has just ' +
      'filtered to its OWN owner reads every one of ANOTHER owner\'s agents by omitting the ' +
      'filter. Nothing authenticates and nothing is hidden. It is by nature true of a daemon ' +
      'that cannot filter at all — the CONTROL two checks down is what makes it a statement ' +
      'about a working filter — and it exists so a future reader cannot quietly start treating ' +
      'the filter as a boundary without a red check telling them otherwise',
    `${seenByTheSameCaller.length}/${theirAgents.length} of ${THEIRS}'s agents visible`
  );
  const myAgentsUnderTheirFilter = Object.values(fleet.mine)
    .filter((d) => has(shown(asTheirs), d));
  check(
    seenViaTheirFilter.length === theirAgents.length && myAgentsUnderTheirFilter.length === 0,
    'INTENDED: and it can ask for them BY NAME — a REAL filter for somebody else\'s owner, ' +
      'returning all of their agents and none of this caller\'s. `owner` is not a credential: ' +
      'passing somebody else\'s is an ordinary, successful query, because the only auth ' +
      'boundary CrabCast has is the socket\'s own file permission. (The second half is what ' +
      'keeps this from being satisfied by a daemon that returns everything to everybody, which ' +
      'is what a build with no filter in it does.)',
    `${seenViaTheirFilter.length}/${theirAgents.length} via owner=${THEIRS}; ` +
      `${myAgentsUnderTheirFilter.length} of mine leaked into it`
  );
  check(
    shown(asMine).length > 0 && !theirAgents.some((d) => has(shown(asMine), d)),
    'CONTROL — and the filter does still narrow, so the two assertions above are about a ' +
      'working filter rather than about one that returns everything to everybody',
    `owner=${MINE} showed ${shown(asMine).length} rows, none of them ${THEIRS}'s`
  );

  // THE TWO REFUSALS, which are the same defect from two sides: a filter
  // request that cannot be honoured must not degrade into an unfiltered read.
  const nulled = await readS1({ action: 'list_agents', owner: null });
  const empty = await readS1({ action: 'list_agents', owner: '' });
  const numbered = await readS1({ action: 'list_agents', owner: 7 });

  check(
    nulled.success === false && /omit/i.test(nulled.error ?? ''),
    'an explicit `owner: null` is REFUSED rather than read as "no filter". A null is what an ' +
      'unset variable serialises to, and answering it with the whole fleet is exactly how a ' +
      'reconciler ends up acting on agents that were never its own — the destructive direction',
    `success=${nulled.success} error=${String(nulled.error).slice(0, 60)}…`
  );
  check(
    empty.success === false && numbered.success === false,
    'so are the empty string and a non-string. No agent can carry an empty owner — `configure` ' +
      'refuses to store one — so a filter for it could only ever be a caller\'s mistake',
    `empty=${empty.success} number=${numbered.success}`
  );
  check(
    nulled.ownerFilter === undefined && nulled.agents === undefined,
    'and a refused filter carries NO rows and NO `ownerFilter` block: it did not quietly ' +
      'answer a different question',
    `ownerFilter=${JSON.stringify(nulled.ownerFilter)} agents=${JSON.stringify(nulled.agents)}`
  );
}

// ===========================================================================
rule('6. THE CAPACITY GATE DOES NOT KNOW ABOUT OWNERS');
// ===========================================================================
//
// CRITERION 6, and decision 6: the gate counts AGENTS, not owners. If owner
// ever influences who gets refused or stood down it has become policy, and that
// is a different ticket.

{
  const unfiltered = await readS1({ action: 'list_agents' });
  const filtered = await readS1({ action: 'list_agents', owner: MINE });

  const capacityFields = ['cap', 'headroom', 'running', 'exemptAgents', 'atCapacity',
    'capBoundBy', 'headroomBoundBy'];
  const differing = capacityFields.filter(
    (f) => JSON.stringify(unfiltered.capacity?.[f]) !== JSON.stringify(filtered.capacity?.[f])
  );

  console.log(`   unfiltered capacity: cap ${unfiltered.capacity?.cap}, ` +
    `headroom ${unfiltered.capacity?.headroom}, running ${unfiltered.capacity?.running}`);
  console.log(`   filtered   capacity: cap ${filtered.capacity?.cap}, ` +
    `headroom ${filtered.capacity?.headroom}, running ${filtered.capacity?.running}`);

  // THE SAME DISCRIMINATION GUARD §3 CARRIES, for the same measured reason: an
  // equality between a filtered and an unfiltered read is trivially true on a
  // daemon that does not filter, so it is only evidence when the two reads
  // really differ somewhere. Here the difference is the `agents` list itself.
  const reallyNarrowed =
    (filtered.agents ?? []).length < (unfiltered.agents ?? []).length;

  check(
    differing.length === 0 && reallyNarrowed,
    'an owner-filtered fleet read and an unfiltered one give the SAME cap, headroom, running ' +
      'count and bounds — while the `agents` list beside those numbers really is narrower, so ' +
      'this is the gate ignoring the filter rather than there being no filter to ignore. The ' +
      'gate counts agents on the machine, and an owner is not a fact about the machine',
    `${differing.length ? `differ: ${differing.join(', ')}` : capacityFields.join('/') + ' all equal'}` +
      ` | agents ${(unfiltered.agents ?? []).length}→${(filtered.agents ?? []).length}`
  );
  check(
    unfiltered.capacity?.running > 0,
    'PRECONDITION — there really are running agents for the gate to have counted, so the ' +
      'equality above is not two zeroes agreeing',
    `running ${unfiltered.capacity?.running}`
  );
  check(
    (filtered.priorities ?? []).length === (unfiltered.priorities ?? []).length &&
      (unfiltered.priorities ?? []).length > 0 && reallyNarrowed,
    '`priorities` is unchanged too — again while the `agents` list next to it shrank. What a ' +
      'would-be activation must outrank is whatever is running, not whatever is running AND ' +
      'shares your name; narrowing it would produce a number that is WRONG rather than partial',
    `${(filtered.priorities ?? []).length} vs ${(unfiltered.priorities ?? []).length}, ` +
      `agents really narrowed=${reallyNarrowed}`
  );
}

// ===========================================================================
rule('7. FROZEN ONTO THE RECORD — echoed, versioned, and survives a reload');
// ===========================================================================
//
// CRITERION 1. `owner` is a knob like any other: it appears in the config echo
// with the rest, it is declared, and it is durable rather than remembered.

{
  const listed = await readS1({ action: 'list_agents', owner: MINE });
  const row = (listed.agents ?? [])[0];

  check(
    row?.config?.owner === MINE,
    '`owner` is on the `config` echo of a row, verbatim, beside the other knobs — so a caller ' +
      'never needs a shadow copy of what it asked for',
    `config: ${JSON.stringify(row?.config)}`
  );
  check(
    (listed.configEchoContract?.declared ?? []).includes('owner') &&
      (listed.configEchoContract?.undeclared ?? []).length === 0,
    'and it is a DECLARED knob rather than an undeclared field riding along: it is in ' +
      '`configEchoContract.declared`, and the sweep found nothing undeclared on this response',
    `declared=${JSON.stringify(listed.configEchoContract?.declared)} ` +
      `undeclared=${JSON.stringify(listed.configEchoContract?.undeclared)}`
  );

  // A SECOND ROUTER OVER THE SAME LOG. The registry is append-only and nothing
  // about `owner` lives in memory, so a fresh reader is the durability test
  // that does not need a process restart — `verify-restart-survival.mjs` is
  // where a real daemon restart is driven.
  const reloaded = harness('s1');
  const afterReload = await reloaded.invoke({ action: 'list_agents', owner: MINE });
  const afterReloadAll = await reloaded.invoke({ action: 'list_agents' });
  const reloadedRows = shown(afterReload);
  check(
    reloadedRows.length === shown(listed).length && reloadedRows.length > 0 &&
      reloadedRows.every((r) => r.config?.owner === MINE) &&
      reloadedRows.length < shown(afterReloadAll).length,
    'a router that has only ever READ this registry — nothing of it in memory — answers the ' +
      'same filtered fleet, every row of it carrying the owner off the record, and NARROWER ' +
      'than its own unfiltered read. So `owner` is durable rather than remembered: it was ' +
      'read back off the append-only log by a process that never wrote it. (The narrowness is ' +
      'the half that matters — two reads agreeing is trivially true of a daemon that filters ' +
      'nothing.)',
    `${reloadedRows.length} rows after reload (${shown(listed).length} before), ` +
      `unfiltered reload ${shown(afterReloadAll).length}, ` +
      `all carry owner=${MINE}: ${reloadedRows.every((r) => r.config?.owner === MINE)}`
  );

  // RECONFIGURABLE IN PLACE, and the consequence: a filtered list is a snapshot.
  const moved = fleet.mine.unstarted;
  const move = await readS1({
    action: 'configure_agent', path: moved, ...KNOBS, owner: THEIRS
  });
  const nowMine = await readS1({ action: 'list_agents', owner: MINE });
  const nowTheirs = await readS1({ action: 'list_agents', owner: THEIRS });
  check(
    move.success === true && move.outcomes?.owner === 'applied' &&
      !has(shown(nowMine), moved) && has(shown(nowTheirs), moved),
    'an agent MOVES between owners on a reconfigure, in place, with `outcomes.owner` naming ' +
      'what happened — which is the property, and the reason a filtered list is a SNAPSHOT ' +
      'rather than a set the caller controls',
    `outcomes.owner=${move.outcomes?.owner}, moved out of ${MINE}=` +
      `${!has(shown(nowMine), moved)}, into ${THEIRS}=${has(shown(nowTheirs), moved)}`
  );

  // AND IT CAN BE REMOVED, because `configure` is one desired-state document.
  const cleared = await readS1({ action: 'configure_agent', path: moved, ...KNOBS });
  const afterClear = await readS1({ action: 'list_agents', owner: THEIRS });
  const unfilteredAfter = await readS1({ action: 'list_agents' });
  check(
    cleared.success === true && !has(shown(afterClear), moved) &&
      has(shown(unfilteredAfter), moved),
    'and a reconfigure that OMITS `owner` removes it — the agent becomes unowned, drops out of ' +
      'its old owner\'s filter and stays reachable unfiltered, exactly as `label` behaves. A ' +
      'desired-state document that silently kept a field nobody sent would be a knob no caller ' +
      'could ever clear',
    `still under ${THEIRS}=${has(shown(afterClear), moved)}, ` +
      `unfiltered=${has(shown(unfilteredAfter), moved)}`
  );
}

// ===========================================================================
rule('8. EXACT MATCH ONLY — no prefix, no glob, no case-folding, no hierarchy');
// ===========================================================================
//
// DECISION 4. The first prefix match invites a namespace, and a namespace is
// vocabulary CrabCast would then owe compatibility on — which is precisely what
// KAN-103 and KAN-123 deleted. So this section is not about convenience: it is
// the boundary that keeps `owner` an opaque value rather than a grammar.

const s8 = harness('s8');

{
  const exact = ownedDir('exact', 'agent');
  await s8.invoke({ action: 'configure_agent', path: exact, ...KNOBS, owner: 'acme/team' });

  const near = [
    ['acme', 'a prefix — the one that would invite a namespace'],
    ['acme/', 'a prefix with the separator, which is what a hierarchy would match on'],
    ['acme/team/sub', 'a longer path, as a hierarchy would resolve downward'],
    ['ACME/TEAM', 'the same value in another case'],
    ['acme/tea', 'a shorter prefix'],
    ['acme/team ', 'the same value with trailing whitespace'],
    [' acme/team', 'the same value with leading whitespace'],
    ['acme/*', 'a glob'],
    ['team', 'a suffix']
  ];

  const matched = [];
  for (const [candidate, why] of near) {
    const res = await s8.invoke({ action: 'list_agents', owner: candidate });
    const hit = has(shown(res), exact);
    console.log(`   owner=${JSON.stringify(candidate)} → ${hit ? 'MATCHED' : 'no match'}  (${why})`);
    if (hit) matched.push(candidate);
  }

  const hitExact = await s8.invoke({ action: 'list_agents', owner: 'acme/team' });

  check(
    matched.length === 0,
    'NONE of nine near-misses matches — not a prefix, not a prefix with the separator, not a ' +
      'longer path, not another case, not a glob, not a suffix, and not the same string with ' +
      'whitespace round it. Every one of those is a grammar somebody could later be asked to ' +
      'support, and each is refused by there being no grammar at all',
    matched.length ? `matched: ${matched.join(', ')}` : '0 of 9'
  );
  check(
    has(shown(hitExact), exact),
    'CONTROL — and the exact string DOES match, so the nine above are exactness rather than a ' +
      'filter that matches nothing whatever you pass it',
    `owner="acme/team" found ${path.basename(exact)}`
  );

  // The value is stored as sent, never normalised: trimming it here would be
  // this daemon deriving a value from the caller's bytes rather than matching
  // them, which is the line the whole field rests on.
  const padded = ownedDir('exact', 'padded');
  await s8.invoke({ action: 'configure_agent', path: padded, ...KNOBS, owner: ' spaced ' });
  const paddedHit = await s8.invoke({ action: 'list_agents', owner: ' spaced ' });
  const trimmedHit = await s8.invoke({ action: 'list_agents', owner: 'spaced' });
  check(
    has(shown(paddedHit), padded) && !has(shown(trimmedHit), padded),
    'an owner is stored and matched BYTE FOR BYTE — `" spaced "` is found by `" spaced "` and ' +
      'not by `"spaced"`. CrabCast does not trim, normalise or otherwise derive a value from ' +
      'what the caller sent, because deriving one is the thing this field must never do',
    `exact=${has(shown(paddedHit), padded)} trimmed=${has(shown(trimmedHit), padded)}`
  );
}

// ===========================================================================
rule('9. THE NON-BOUNDARY SENTENCE, WHERE A READER WILL BE STANDING');
// ===========================================================================
//
// DECISION 5, and its amendment: having the reasoning on KAN-193 is NOT
// sufficient, because a future reader meets the tool description, not the
// ticket. This section reads SOURCE — it is the one part of this file that is
// not about a running daemon — and it asserts the sentence is in each of the
// three places a reader can arrive at, not merely somewhere.

{
  const typesTs = fs.readFileSync(path.join(repoRoot, 'src', 'types.ts'), 'utf8');
  const mcpTs = fs.readFileSync(path.join(repoRoot, 'src', 'mcp.ts'), 'utf8');

  // The field's own documentation, for whoever reads the type.
  const ownerDoc = typesTs.slice(
    Math.max(0, typesTs.indexOf('owner?: string') - 4000),
    typesTs.indexOf('owner?: string')
  );
  check(
    /NOT A PERMISSION BOUNDARY/i.test(ownerDoc) && /0600/.test(ownerDoc) && /0700/.test(ownerDoc),
    '`AgentConfig.owner` in src/types.ts says on the FIELD ITSELF that it is not a permission ' +
      'boundary and names the socket permission that is the only one — so somebody reading the ' +
      'type meets it before they can build on the wrong reading',
    `boundary=${/NOT A PERMISSION BOUNDARY/i.test(ownerDoc)} perms=${/0600/.test(ownerDoc)}`
  );
  check(
    /MATCH .*MUST NEVER DERIVE MEANING|never derive meaning/i.test(ownerDoc),
    'and it carries the distinction the whole ticket rests on — CrabCast may MATCH an owner ' +
      'string and must never DERIVE MEANING from one — beside the field rather than only on ' +
      'the ticket',
    'src/types.ts, AgentConfig.owner'
  );

  // The two tool descriptions, for whoever reads the tool.
  //
  // SLICED ON `name: "…"` AND NOT ON THE BARE TOOL NAME, which is a trap this
  // section fell into on its first run and reported as a clean FAIL rather than
  // a clean pass — the useful direction, and the reason it is written down.
  // Every tool name also appears inside OTHER tools' prose (`crabcast_capacity`
  // names `crabcast_configure_agent` in its own description), so `indexOf` on
  // the bare name lands in a cross-reference and slices a window that contains
  // no tool definition at all. A window that is empty for the wrong reason
  // fails these checks — but a window that is merely misplaced could just as
  // easily have contained the sentence by accident and passed.
  const toolBlock = (name, next) =>
    mcpTs.slice(mcpTs.indexOf(`name: "${name}"`), mcpTs.indexOf(`name: "${next}"`));
  const configureDesc = toolBlock('crabcast_configure_agent', 'crabcast_activate_agent');
  const listDesc = toolBlock('crabcast_list_agents', 'crabcast_daemon_status');

  check(
    configureDesc.length > 1000 && listDesc.length > 1000 &&
      configureDesc.includes('owner') && listDesc.includes('owner'),
    'PRECONDITION — both slices really are the tool definitions and both mention `owner`, so ' +
      'the assertions below are about a tool description rather than about an empty window',
    `configure ${configureDesc.length} chars, list ${listDesc.length} chars`
  );

  for (const [where, text] of [['configure', configureDesc], ['list_agents', listDesc]]) {
    check(
      /NOT A PERMISSION BOUNDARY/i.test(text) && /0600/.test(text),
      `the \`owner\` documentation on the ${where} MCP tool says it is not a permission ` +
        'boundary and names the real one. A consumer reads this and never reads src/types.ts',
      `${where}: boundary=${/NOT A PERMISSION BOUNDARY/i.test(text)}`
    );
  }
  check(
    /matched by NO filter|matches no filter|MATCHED BY NO FILTER/i.test(listDesc),
    'and the list tool warns that an agent with NO owner is matched by no filter — the one ' +
      'behaviour a consumer cannot discover by trying it, because a filter that returns their ' +
      'own agents looks completely correct until an unowned one needed to be seen',
    'src/mcp.ts, crabcast_list_agents'
  );
}

// ===========================================================================
rule('10. THE MUTATIONS — every new behaviour, backed out, and required to go red');
// ===========================================================================
//
// EACH MUTATION HAS ONE SECTION IT MUST BREAK, named. A mutation that goes red
// somewhere else is not evidence about the section it was written for, and a
// mutation everything survives is a section that was never discriminating —
// which is the whole point of running the suite against the pre-fix build as
// well (`scripts/kan193-red-drive.mjs`).
//
// The anchors are DESCRIBED in prose and quoted only in the `mutate` calls
// themselves: this file is not compiled, but the habit is the one that keeps a
// comment from becoming a second occurrence of an anchor.

const mutationScratch = path.join(tmp, 'mutants');
fs.mkdirSync(mutationScratch, { recursive: true });

// A MUTANT LIVES OUTSIDE THE REPOSITORY AND STILL HAS TO RESOLVE `node-pty`.
// The compiled `router.js` imports `herdr.js`, which imports it, and Node walks
// up from the IMPORTING file — so a build copied to a scratch directory fails
// at load with ERR_MODULE_NOT_FOUND. That failure is the dangerous kind rather
// than the loud kind: a mutant that dies on startup produces the same
// observation a well-behaved one produces, which is why `mutation.mjs`'s own
// header says every section spawning a mutant still owes a precondition that it
// really ran. Here the section's assertion IS that precondition — each one
// requires the mutant to answer a `list_agents`, which a mutant that never
// loaded cannot do. `verify-fleet-enumeration.mjs` does the same thing for the
// same reason.
try {
  fs.symlinkSync(path.join(distDir, '..', 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
} catch (e) {
  if (e?.code !== 'EEXIST') throw e;
}
const { mutate } = makeMutator({
  distDir,
  scratch: mutationScratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

/**
 * Stand a small three-owner fleet up against a mutated build and read it back.
 *
 * The SAME fixture for every mutant, so what differs between sections is the
 * mutation and nothing else.
 */
async function fleetOn(mutantDir, tag) {
  const Router = (await import(path.join(mutantDir, 'router.js'))).MessageRouter;
  const Registry = (await import(path.join(mutantDir, 'agent-registry.js'))).AgentRegistry;
  const h = harness(`mut-${tag}`, { MessageRouter: Router, AgentRegistry: Registry });
  const dirs = {};
  let paneId = 900;
  for (const [name, owner] of [['mine', MINE], ['theirs', THEIRS], ['nobody', undefined]]) {
    const standby = ownedDir('mut', tag, `standby-${name}`);
    await h.invoke({
      action: 'configure_agent', path: standby, ...KNOBS,
      ...(owner === undefined ? {} : { owner })
    });
    setCensus([ourPane(standby, `%${paneId++}`)]);
    await h.invoke({ action: 'activate_agent', path: standby });
    await h.invoke({ action: 'deactivate_agent', path: standby });

    const running = ownedDir('mut', tag, `running-${name}`);
    await h.invoke({
      action: 'configure_agent', path: running, ...KNOBS,
      ...(owner === undefined ? {} : { owner })
    });
    dirs[name] = { standby, running };
  }
  setCensus([
    ourPane(dirs.mine.running, '%991'),
    ourPane(dirs.theirs.running, '%992'),
    ourPane(dirs.nobody.running, '%993')
  ]);
  // The running agents are configured but never activated above, so they land
  // in `unstartedAgents` — which is a filtered category and enough for the
  // sections below. `standbyAgents` is the other.
  return { h, dirs };
}

absenceIsAWildcard: {
  // §2's subject: the explicit `undefined` branch in `ownedBy` made to return
  // true, which is what a truthy test or a `?? wanted` would compile to.
  const dir = mutate('absence-is-a-wildcard', 'router.js',
    'if (owner === undefined)\n        return false;',
    'if (owner === undefined)\n        return true;');
  if (!dir) break absenceIsAWildcard;

  const { h, dirs } = await fleetOn(dir, 'wildcard');
  const filtered = await h.invoke({ action: 'list_agents', owner: MINE });
  const leaked = has(shown(filtered), dirs.nobody.standby);
  check(
    leaked,
    '§2 GOES RED against a build where absence is a wildcard: the unowned agent is returned ' +
      'by a filter for another owner. That is the reconciler stand-down defect, reproduced',
    `unowned agent in owner=${MINE}'s read: ${leaked}`
  );
}

exactBecomesPrefix: {
  // §8's subject: the equality test made into a prefix test — the single
  // smallest edit that turns an opaque value into a namespace.
  const dir = mutate('exact-becomes-prefix', 'router.js',
    'return owner === wanted;',
    'return owner.startsWith(wanted);');
  if (!dir) break exactBecomesPrefix;

  const { h, dirs } = await fleetOn(dir, 'prefix');
  const byPrefix = await h.invoke({ action: 'list_agents', owner: MINE.slice(0, 3) });
  const matched = has(shown(byPrefix), dirs.mine.standby);
  check(
    matched,
    `§8 GOES RED against a build that prefix-matches: owner=${JSON.stringify(MINE.slice(0, 3))} ` +
      `finds an agent owned by ${JSON.stringify(MINE)}. One character of code is the whole ` +
      'distance between an opaque value and a namespace',
    `prefix match: ${matched}`
  );
}

agentsUnfiltered: {
  // §3's subject, on the category that matters most: `agents` is what a
  // reconciler acts on, and it is the one category that is never paged — so a
  // filter that forgot it would be invisible to every paging assertion.
  const dir = mutate('agents-unfiltered', 'router.js',
    'agents: narrow(agents)',
    'agents: agents');
  if (!dir) break agentsUnfiltered;

  const { h, dirs } = await fleetOn(dir, 'agents');
  const filtered = await h.invoke({ action: 'list_agents', owner: MINE });
  const strays = (filtered.agents ?? []).filter((r) => r.config?.owner !== MINE);
  check(
    strays.length > 0,
    '§3 GOES RED against a build that narrows the four paged categories and forgets `agents`: ' +
      "the filtered read carries other owners' RUNNING agents. Four of five is the shape that " +
      'passes every test written about the fifth',
    `${strays.length} stray row(s) in \`agents\``
  );
}

standbyUnfiltered: {
  // §3 and §4 together: a paged category left unnarrowed keeps its whole-fleet
  // `total`, so this is also the mutation that shows paging is correct BECAUSE
  // the filter runs before the pager.
  const dir = mutate('standby-unfiltered', 'router.js',
    'narrow(this.standbyAgents(agents, intents))',
    'this.standbyAgents(agents, intents)');
  if (!dir) break standbyUnfiltered;

  const { h, dirs } = await fleetOn(dir, 'standby');
  const filtered = await h.invoke({ action: 'list_agents', owner: MINE });
  const strays = (filtered.standbyAgents ?? []).filter((r) => r.config?.owner !== MINE);
  check(
    strays.length > 0 && filtered.standbyTotal > 1,
    '§3 AND §4 GO RED against a build that leaves one paged category unnarrowed: the rows are ' +
      "other owners' AND `standbyTotal` counts the whole category, which is what a filter " +
      'applied after the pager would look like',
    `${strays.length} stray(s), standbyTotal ${filtered.standbyTotal}`
  );
}

nullIsNoFilter: {
  // §5's subject, and the destructive one. A build that reads an explicit null
  // as "no filter" answers a caller that meant to filter with the whole fleet.
  const dir = mutate('null-is-no-filter', 'router.js',
    'if (raw === undefined)\n        return { owner: null };',
    'if (raw === undefined || raw === null)\n        return { owner: null };');
  if (!dir) break nullIsNoFilter;

  const { h, dirs } = await fleetOn(dir, 'null');
  const nulled = await h.invoke({ action: 'list_agents', owner: null });
  const gotEverybody = nulled.success === true && has(shown(nulled), dirs.theirs.standby);
  check(
    gotEverybody,
    "§5 GOES RED against a build that reads `owner: null` as no filter: the caller's unset " +
      "variable is answered with another owner's agents. Nothing about that response says a " +
      'filter failed to apply — which is why the refusal is the behaviour rather than a nicety',
    `success=${nulled.success}, other owner's agent returned=${gotEverybody}`
  );
}

capacityFollowsTheFilter: {
  // §6's subject. `narrow` is in scope at the capacity call, so this is exactly
  // the edit an author "tidying up" would make — and it is the moment `owner`
  // stops being metadata and becomes policy.
  //
  // THE ANCHOR IS THE COMMENT THIS CHANGE ADDED, not the capacity call it sits
  // above, and that is a correction `kan193-red-drive.mjs` forced. Anchored on
  // the call alone, this mutation APPLIED CLEANLY to a build of the merge base
  // — text that predates the change — producing a "mutant" that referenced a
  // `narrow` no such build has. A mutation that can apply to a build without
  // the feature in it is not backing the feature out of anything.
  const dir = mutate('capacity-follows-the-filter', 'router.js',
    '// metadata and become policy — a different ticket (KAN-193 decision 6).\n' +
      '        const capacity = this.capacityOf(agents);',
    '// metadata and become policy — a different ticket (KAN-193 decision 6).\n' +
      '        const capacity = this.capacityOf(narrow(agents));');
  if (!dir) break capacityFollowsTheFilter;

  const { h } = await fleetOn(dir, 'capacity');
  const unfiltered = await h.invoke({ action: 'list_agents' });
  const filtered = await h.invoke({ action: 'list_agents', owner: MINE });
  const moved = unfiltered.capacity?.running !== filtered.capacity?.running;
  check(
    moved,
    '§6 GOES RED against a build where the filter reaches the capacity gate: a filtered read ' +
      'reports a different `running` count from an unfiltered one, which is the gate counting ' +
      'owners instead of agents — policy, and a different ticket',
    `running unfiltered=${unfiltered.capacity?.running} filtered=${filtered.capacity?.running}`
  );
}

blockHidesWhatItLeftWhole: {
  // §3's last subject. The block is the only thing on the wire saying which
  // arrays were narrowed; a block that names the narrowed set and hides the
  // untouched one is the half-truth that reads as a complete answer.
  const dir = mutate('block-hides-what-it-left-whole', 'router.js',
    'unfiltered: [...OWNER_UNFILTERED_ROWS]',
    'unfiltered: []');
  if (!dir) break blockHidesWhatItLeftWhole;

  const { h } = await fleetOn(dir, 'block');
  const filtered = await h.invoke({ action: 'list_agents', owner: MINE });
  const hidden = (filtered.ownerFilter?.unfiltered ?? []).length === 0;
  check(
    hidden,
    '§3 GOES RED against a build whose `ownerFilter` block names what it narrowed and NOT what ' +
      'it left whole: a consumer reading that block would take `foreignPanes` and `priorities` ' +
      'for its own',
    `ownerFilter.unfiltered=${JSON.stringify(filtered.ownerFilter?.unfiltered)}`
  );
}

// ===========================================================================
rule('11. THE TWO PUBLISHED SURFACES — the argument ARRIVES, through a real daemon');
// ===========================================================================
//
// THE JOIN NOTHING ELSE OWNS, and the reason this section exists rather than a
// paragraph saying it does not. Every section above drives `MessageRouter`
// in-process, so all of them would stay green against a CLI that dropped
// `--owner` on the floor and an MCP tool that never put `owner` on the request.
// That is KAN-145's shape exactly — *"a proof that supplies its own input has
// not tested that the input arrives"* — and `verify-cli-parity.mjs` does not
// close it, because it reconciles ACTIONS against commands and says nothing
// about a command's arguments.
//
// So this section supplies no request object at all. It runs the real
// `dist/cli.js` and the real `dist/mcp.js` against a real daemon that the CLI
// itself spawns, and asserts the narrowing arrives at the far end.
//
// THE HERDR STUB IS STILL A STUB. What is real here is the CLI, the MCP server,
// the socket and the daemon; the terminal multiplexer is not, and this section
// makes no claim about one.

{
  const liveHome = path.join(tmp, 'live-home');
  const liveData = path.join(tmp, 'live-data');
  const liveConfig = path.join(tmp, 'live.config.json');
  fs.mkdirSync(liveHome, { recursive: true });
  fs.writeFileSync(liveConfig, JSON.stringify({ dataDir: liveData }, null, 2));

  const env = {
    ...process.env,
    HOME: liveHome,
    SHELL: '/bin/bash',
    // The stub first, so the daemon the CLI spawns inherits it and cannot
    // rediscover a real herdr on this machine.
    PATH: `${bin}:${realPath}`,
    CRABCAST_CONFIG: undefined
  };
  const cliJs = path.join(distDir, 'cli.js');
  const crabcast = (...args) =>
    spawnSync(process.execPath, [cliJs, '--config', liveConfig, ...args],
      { env, encoding: 'utf8', timeout: 120_000 });

  const dirs = {};
  for (const [tag, owner] of [['mine', MINE], ['theirs', THEIRS], ['nobody', undefined]]) {
    const d = path.join(tmp, 'live-agents', tag);
    fs.mkdirSync(d, { recursive: true });
    dirs[tag] = fs.realpathSync(d);
    const r = crabcast('configure', dirs[tag], '--priority', '1', '--launcher', 'shell',
      ...(owner === undefined ? [] : ['--owner', owner]));
    if (r.status !== 0) {
      check(false, `PRECONDITION — \`crabcast configure\` for ${tag} failed, so §11 has no fleet`,
        `exit ${r.status}: ${String(r.stderr || r.stdout).slice(0, 200)}`);
    }
  }

  // Remember the daemon the CLI started so cleanup can stop it. A proof that
  // leaves a daemon behind is a proof that makes the NEXT one flake.
  try {
    const socket = await connectToDaemon(liveData, { spawnIfMissing: false });
    socket.on('error', () => {});
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 15_000);
      onJsonLines(socket, (msg) => {
        if (msg?.id !== 'kan193-live') return;
        clearTimeout(timer); socket.destroy(); resolve(msg);
      });
      writeJsonLine(socket, { action: 'daemon_status', id: 'kan193-live' });
    });
    if (typeof status?.pid === 'number') spawned.daemons.add(status.pid);
    check(
      typeof status?.pid === 'number',
      'PRECONDITION — a REAL daemon is running and answering on its socket, spawned by the ' +
        'CLI rather than constructed here. Everything below is a round trip through it',
      `pid ${status?.pid}, contractVersion ${status?.contractVersion}`
    );
  } catch (e) {
    check(false, 'PRECONDITION — could not reach the daemon the CLI spawned', String(e?.message));
  }

  // ------------------------------------------------------------------- CLI
  const cliFiltered = crabcast('list', '--owner', MINE);
  const cliAll = crabcast('list');
  const inCli = (out, tag) => out.includes(dirs[tag]);

  check(
    cliFiltered.status === 0 && inCli(cliFiltered.stdout, 'mine') &&
      !inCli(cliFiltered.stdout, 'theirs') && !inCli(cliFiltered.stdout, 'nobody'),
    '`crabcast list --owner` NARROWS: the flag reached the daemon, and the printed fleet is ' +
      'the owner\'s agent alone — not the other owner\'s, and not the unowned one',
    `exit ${cliFiltered.status}; mine=${inCli(cliFiltered.stdout, 'mine')} ` +
      `theirs=${inCli(cliFiltered.stdout, 'theirs')} nobody=${inCli(cliFiltered.stdout, 'nobody')}`
  );
  check(
    cliAll.status === 0 && ['mine', 'theirs', 'nobody'].every((t) => inCli(cliAll.stdout, t)),
    'CONTROL — and `crabcast list` with no flag prints all three, so the line above is the ' +
      'flag working rather than the CLI printing nothing',
    `mine/theirs/nobody = ${['mine', 'theirs', 'nobody'].map((t) => inCli(cliAll.stdout, t)).join('/')}`
  );
  check(
    /FILTERED to owner/.test(cliFiltered.stdout) &&
      /NOT narrowed/.test(cliFiltered.stdout) &&
      !/FILTERED to owner/.test(cliAll.stdout),
    'and a filtered `list` OPENS with a banner saying it is not the whole fleet and naming ' +
      'what it left complete, while an unfiltered one prints no banner at all. Every count ' +
      'below that banner describes the filtered set, so the banner is the only thing on the ' +
      'page that can say so',
    `banner on filtered=${/FILTERED to owner/.test(cliFiltered.stdout)}, ` +
      `on unfiltered=${/FILTERED to owner/.test(cliAll.stdout)}`
  );

  // THE DEFECT THIS CHECK EXISTS FOR, found by running the CLI by hand rather
  // than by reading it: `owner` was rendered by an explicit line in
  // `configBlock` AND by the undeclared-knob fallback underneath it, so every
  // row printed it twice. The fallback was working exactly as designed — it
  // makes an omission from `CONFIG_FIELDS` visible instead of silent — but
  // visible-as-a-duplicate is a defect a reviewer has to notice. `cli.ts` now
  // binds that list to `AgentConfig` at compile time, and this is the
  // behavioural half of that fix.
  const ownerLines = (cliFiltered.stdout.match(/^\s*owner: /gm) ?? []).length;
  check(
    ownerLines === 1,
    'and the row prints `owner:` EXACTLY ONCE — not twice, which is what an explicit render ' +
      'plus the undeclared-knob fallback produced before `CONFIG_FIELDS` in src/cli.ts was ' +
      'bound to `AgentConfig` at compile time',
    `${ownerLines} occurrence(s) of an owner line`
  );
  const nobodyRowHasOwner = /owner:/.test(
    (cliAll.stdout.split(dirs.nobody)[1] ?? '').split('\n').slice(0, 8).join('\n')
  );
  check(
    !nobodyRowHasOwner && ownerLines === 1,
    'and the UNOWNED agent\'s row prints no owner line at all — while an OWNED row in the ' +
      'same run prints exactly one, so this is a renderer that distinguishes the two rather ' +
      'than one that has never heard of the field. Decision 3: an unowned agent must not be ' +
      'rendered as though somebody owns it, and `owner: (none)` or an empty value would each ' +
      'be a string a reader could take for a name',
    `unowned row carries an owner line: ${nobodyRowHasOwner}; owned row printed ${ownerLines}`
  );

  const cliRefusal = crabcast('list', '--owner', '');
  check(
    cliRefusal.status !== 0 && /Invalid owner/.test(cliRefusal.stdout + cliRefusal.stderr),
    'and a refusal from the daemon reaches the CLI as a non-zero exit carrying the daemon\'s ' +
      'own sentence — the flag is not being swallowed on the way back either',
    `exit ${cliRefusal.status}`
  );

  // ------------------------------------------------------------------- MCP
  const mcp = spawn(process.execPath, [path.join(distDir, 'mcp.js')],
    { env: { ...env, CRABCAST_CONFIG: liveConfig }, stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.children.add(mcp);

  let mcpBuf = '';
  const mcpPending = new Map();
  let mcpId = 0;
  mcp.stdout.on('data', (chunk) => {
    mcpBuf += chunk.toString();
    let nl;
    while ((nl = mcpBuf.indexOf('\n')) !== -1) {
      const line = mcpBuf.slice(0, nl);
      mcpBuf = mcpBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && mcpPending.has(msg.id)) {
        const { resolve, timer } = mcpPending.get(msg.id);
        mcpPending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg.result ?? { error: msg.error });
      }
    }
  });
  const mcpRequest = (method, params = {}) => {
    const id = ++mcpId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { mcpPending.delete(id); resolve(null); }, 30_000);
      mcpPending.set(id, { resolve, timer });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const callTool = (name, args = {}) => mcpRequest('tools/call', { name, arguments: args });
  /** The daemon's JSON answer rides inside the tool result's text content. */
  const parsedText = (r) => {
    const text = r?.content?.find((c) => c.type === 'text')?.text ?? '';
    try { return JSON.parse(text); } catch { return { unparseable: text }; }
  };

  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'verify-owner-filter', version: '0.0.0' }
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const mcpFiltered = parsedText(await callTool('crabcast_list_agents', { owner: MINE }));
  const mcpAll = parsedText(await callTool('crabcast_list_agents'));
  const mcpPaths = (res) => FILTERED.flatMap((c) => (res?.[c] ?? []).map((r) => r.path));

  check(
    mcpFiltered?.success === true && mcpFiltered.ownerFilter?.owner === MINE &&
      mcpPaths(mcpFiltered).includes(dirs.mine) &&
      !mcpPaths(mcpFiltered).includes(dirs.theirs) &&
      !mcpPaths(mcpFiltered).includes(dirs.nobody),
    '`crabcast_list_agents { owner }` over MCP narrows too — the tool put the argument on the ' +
      'request, the daemon honoured it, and the response carries the `ownerFilter` block back',
    `ownerFilter.owner=${JSON.stringify(mcpFiltered?.ownerFilter?.owner)}, ` +
      `rows ${JSON.stringify(mcpPaths(mcpFiltered).map((p) => path.basename(p)))}`
  );
  check(
    mcpAll?.success === true && mcpAll.ownerFilter === undefined &&
      ['mine', 'theirs', 'nobody'].every((t) => mcpPaths(mcpAll).includes(dirs[t])),
    'CONTROL — the same tool with NO `owner` returns all three and carries no block, so an ' +
      'MCP caller that never passes one is unaffected. That is what "additive" means here',
    `block=${JSON.stringify(mcpAll?.ownerFilter)}, ` +
      `rows ${JSON.stringify(mcpPaths(mcpAll).map((p) => path.basename(p)))}`
  );

  // THE ARGUMENT MERGE, which is the one piece of real logic in `src/mcp.ts`:
  // `owner` and the three paging arguments are independent, and folding the
  // first into the second's branch would make a filter silently do nothing
  // unless the caller happened also to be paging.
  const mcpBoth = parsedText(await callTool('crabcast_list_agents',
    { owner: MINE, category: 'unstartedAgents', limit: 5 }));
  check(
    mcpBoth?.success === true && mcpBoth.ownerFilter?.owner === MINE &&
      mcpBoth.pages?.unstartedAgents?.limit === 5 &&
      (mcpBoth.unstartedAgents ?? []).every((r) => r.config?.owner === MINE),
    'and `owner` travels ALONGSIDE the paging arguments rather than instead of them: both ' +
      'applied in one call. Folding the filter into the paging branch would leave it silently ' +
      'inert for every caller that was not also paging',
    `owner=${JSON.stringify(mcpBoth?.ownerFilter?.owner)}, ` +
      `limit=${mcpBoth?.pages?.unstartedAgents?.limit}, ` +
      `rows=${(mcpBoth?.unstartedAgents ?? []).length}`
  );

  const mcpOnlyOwner = parsedText(await callTool('crabcast_list_agents', { owner: MINE }));
  check(
    mcpOnlyOwner?.ownerFilter?.owner === MINE,
    'and `owner` ALONE is accepted — the tool does not require a `category` beside it, which ' +
      'is the other half of the same independence',
    `ownerFilter=${JSON.stringify(mcpOnlyOwner?.ownerFilter?.owner)}`
  );

  mcp.kill();
  spawned.children.delete(mcp);
}

// ===========================================================================
rule('VERDICT');
// ===========================================================================

if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log('\nAll checks passed.');
}
process.exit(failures.length ? 1 : 0);
