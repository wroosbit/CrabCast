#!/usr/bin/env node
// KAN-619 — the re-measurement, taken at the time of the work rather than
// quoted from the ticket, with the query named and a control on both sides.
//
// WHAT FAILURE THIS WOULD CATCH: `daemon_status` counting a registry record
// whose directory is gone under `expectedAgents` — "expected to be running" —
// while `list_agents`, on the same head and the same registry, reports that
// same record under `strandedAgents`. Two instruments, one registry, different
// answers about one row.
//
// ⚠ THIS IS A MEASUREMENT, NOT A GATE. It prints what the two instruments say
// and exits on whether they AGREE, so it is red before the fix and green after
// it. `verify-daemon-status-accounts-for-stranded.mjs` is the proof that goes
// in CI; this is the reading the ticket asked to be re-taken, kept because a
// figure quoted without its instrument and its host is not a measurement.
//
// THE CONTROL IS ON BOTH SIDES, and it is the point rather than decoration:
//   * BEFORE the directory is deleted, both records are real, and the two
//     instruments must already agree (2 expected, 0 stranded). A run that
//     printed the "after" numbers without this would not have shown that the
//     deletion is what moved them.
//   * ONE RECORD IS NEVER DELETED. A build that reported every record as
//     stranded, or none, would satisfy an assertion that only counts the
//     deleted one.
//
// ⚠ AND THE ANCHOR IS OUTSIDE THE ROOT UNDER TEST. KAN-594's task agent
// measured `~/.local/share/crabcast/agents.jsonl` where `~` was
// `/home/wroosbit`, found nothing, and reported *population 0* about a registry
// that was alive under `/home/brooswit` on another host — a `~`-rooted control
// cannot detect a wrong `~`. So this prints the hostname and the absolute
// registry path it actually wrote, and every figure below is about THAT file.
//
// Usage:
//   npm run build
//   node scripts/kan619-red-drive.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { paneNameFor } = await import(path.join(distDir, 'identity.js'));
const { snapshotBuild } = await import(path.join(distDir, 'provenance.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan619-'));
const realPath = process.env.PATH;
function cleanup() {
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

const setCensus = (panes) =>
  fs.writeFileSync(
    CENSUS_FILE,
    JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: panes } })
  );
const ourPane = (dir, paneId) => ({
  name: paneNameFor(dir), pane_id: paneId, agent: 'claude', agent_status: 'working', cwd: dir
});
// Before the first `configure`, which reads the census: an absent file is a
// parse error in the bridge, not an empty fleet.
setCensus([]);

const REGISTRY = path.join(tmp, 'fleet.jsonl');
// What `daemon.ts` hands the router at boot. `daemon_status` recomputes
// freshness per request off this, and the whole response throws without it.
const bootBuild = snapshotBuild();

// EVERY READ IS THROUGH A FRESH ROUTER over the same registry file, so no
// session of ours can mask the state and neither instrument is answering out of
// something the other one warmed up.
function invoke(request) {
  return new Promise((resolve) => {
    new MessageRouter({
      config,
      herdrBridge: new HerdrBridge(config.dataDir, config.configPath),
      daemonStartedAt: new Date(),
      agentRegistry: new AgentRegistry(REGISTRY),
      bootBuild,
      send: (msg) => resolve(msg),
      broadcast: () => {}
    }).handle(request);
  });
}

function workspace(...parts) {
  const dir = path.join(tmp, 'dirs', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

console.log(`host                : ${os.hostname()}`);
console.log(`registry            : ${REGISTRY}`);
console.log(`dist                : ${distDir}`);
try {
  const stamp = JSON.parse(fs.readFileSync(path.join(distDir, 'build-stamp.json'), 'utf8'));
  console.log(`build               : ${stamp.commit} (${stamp.clean ? 'clean' : 'DIRTY'})`);
} catch { console.log('build               : (no stamp)'); }

const gone = workspace('deleted-with-no-forget');
const survivor = workspace('survivor');

for (const dir of [gone, survivor]) {
  const res = await invoke({ action: 'configure_agent', path: dir, priority: 1, launcher: 'shell' });
  if (!res.success) throw new Error(`fixture configure failed for ${dir}: ${res.error}`);
}
setCensus([ourPane(gone, '%100'), ourPane(survivor, '%101')]);
for (const dir of [gone, survivor]) {
  const res = await invoke({ action: 'activate_agent', path: dir });
  if (!res.success) throw new Error(`fixture activate failed for ${dir}: ${res.error}`);
}

async function reading(label) {
  const status = await invoke({ action: 'daemon_status' });
  const fleet = await invoke({ action: 'list_agents' });
  console.log(`\n--- ${label}`);
  const say = (k) => (k in status ? status[k] : '(field absent)');
  console.log(`    daemon_status : configuredAgents ${status.configuredAgents}   ` +
    `expectedAgents ${status.expectedAgents}   ` +
    `expectedStranded ${say('expectedStranded')}   strandedTotal ${say('strandedTotal')}`);
  console.log(`    list_agents   : strandedTotal ${fleet.strandedTotal}   ` +
    `stranded paths ${JSON.stringify((fleet.strandedAgents ?? []).map((r) => path.basename(r.path)))}`);
  return { status, fleet };
}

const before = await reading('BEFORE the directory is deleted (control: both records are real)');

setCensus([ourPane(survivor, '%101')]);
fs.rmSync(gone, { recursive: true, force: true });
console.log(`\n    deleted ${gone} with no \`forget\`; ${survivor} left in place`);
console.log(`    exists(gone)=${fs.existsSync(gone)}  exists(survivor)=${fs.existsSync(survivor)}`);

const after = await reading('AFTER one directory is deleted with no `forget`');

// ---------------------------------------------------------------- the verdict

const controlHolds =
  before.status.expectedAgents === 2 && before.fleet.strandedTotal === 0 &&
  after.fleet.strandedTotal === 1 && fs.existsSync(survivor);

// The disagreement, stated as the arithmetic a reader would do: how many
// records does `daemon_status` say should be running that `list_agents` says
// have nowhere to run?
const startable =
  after.status.expectedAgents -
  (('expectedStranded' in after.status) ? after.status.expectedStranded : 0);
// The disagreement is gone when BOTH hold: `daemon_status` accounts for the
// record it cannot start, AND its whole-registry figure is the same number
// `list_agents` publishes under the same name. Checking only the first would
// pass a build that disclosed the subset and left the two surfaces carrying
// differently-populated fields called the same thing.
const agree =
  startable === 1 &&
  after.status.strandedTotal === after.fleet.strandedTotal;

console.log(`\n${'='.repeat(78)}`);
if (!controlHolds) {
  console.log('CONTROL FAILED — the fixture did not reach the state under test, so nothing below');
  console.log('is a reading about the defect. Neither a red nor a green here means anything.');
  process.exit(2);
}
console.log('control            : BEFORE 2 expected / 0 stranded, AFTER 1 stranded, survivor alive — held');
console.log(`daemon_status says : ${after.status.expectedAgents} expected to be running`);
console.log(`list_agents says   : ${after.fleet.strandedTotal} of them has no directory to run in`);
console.log(`startable          : ${startable} (expectedAgents minus expectedStranded)`);
console.log(`cross-surface      : daemon_status.strandedTotal ${after.status.strandedTotal ?? '(absent)'} ` +
  `vs list_agents.strandedTotal ${after.fleet.strandedTotal}`);
console.log(
  agree
    ? 'VERDICT: the two instruments agree about this registry.'
    : 'VERDICT: THE TWO INSTRUMENTS DISAGREE. `daemon_status` counts a record as expected to be\n' +
      '         running and discloses nothing about the directory that is gone; `list_agents`, on\n' +
      '         the same head and the same registry, reports it stranded.'
);
process.exit(agree ? 0 : 1);
