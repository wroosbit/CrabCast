#!/usr/bin/env node
// Proof for KAN-175: the README's pasted output is still what the program
// prints.
//
// WHAT FAILURE THIS WOULD CATCH: a renderer grows a line — `config vN frozen`,
// `next activate:`, a whole `capacity:` block — and the README's pasted session
// stops showing it, so the page becomes a strict SUBSET of what a reader
// running the same commands sees. Nothing on the page is false; it is just
// less than the truth, which is why it has now happened twice (KAN-139 for the
// walkthrough, KAN-174 for four more blocks) and both times was found by
// somebody noticing, months of commits later.
//
// ---------------------------------------------------------------------------
// WHY THIS SHAPE AND NOT THE OTHER TWO
//
// KAN-175 named three candidates and asked for a deliberate choice.
//
//   1. A hand-run masked diff against a capture file. It is what KAN-139 wrote
//      to prove its own PR, and it works — but it runs only when somebody
//      remembers, which is the failure this ticket exists for. Rejected.
//   3. A field-inventory check: the renderers' emitted labels must be a subset
//      of the README's text, no session at all. Cheapest to keep green, and it
//      WOULD NOT HAVE CAUGHT KAN-139. That drift added the same five lines to
//      `list`'s rows and to `status`; a page updated for one and not the other
//      still contains every label, so a flat inventory over the whole document
//      is green while the `status` block is stale. That is not an argument on
//      paper: section 5 below builds the flat check, stales exactly that block,
//      and shows it stay green while this one goes red. Rejected, measurably.
//   2. Run the commands and compare per command. Taken.
//
// So this script drives the REAL CLI against a shimmed `herdr`, captures what
// each command printed, and requires every line of that — masked, so the
// figures that must differ between runs do — to appear IN THE PAGE'S BLOCK FOR
// THAT COMMAND, in order. Per command, because a label that exists somewhere
// else on the page is not the same fact as a block that shows it.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT COVER. Read this before citing it green.
//
// * IT CANNOT TELL A REAL CAPTURED SESSION FROM A FABRICATED ONE. It proves
//   the page shows every line the program prints; a page whose numbers, pane
//   ids and timestamps were invented by hand passes it just as well, because
//   those are exactly the values the mask removes. "Is this transcript real"
//   is answered by the reviewer re-running it against the PR head and by
//   nothing else in this repository — the same hole KAN-139's own proof
//   declared, still open, still nobody's.
//
// * IT SAYS NOTHING ABOUT WHETHER THE PAGE'S PROSE IS TRUE. Both defects
//   KAN-174 found were sentences, not missing output: a capacity recipe that
//   does not produce the refusal it promises (`CRABCAST_MAX_AGENTS` is read by
//   the daemon at boot, never by the CLI), and a `grep -c` census that could
//   only ever answer 0 or 1. A shape check is blind to both. Nobody covers
//   that; it is read by humans or it is not read.
//
// * ITS CENSUS IS WRITTEN TO MATCH THE PAGE. The foreign panes in the
//   walkthrough's `list` are the capturing machine's real fleet; the shim here
//   is told to report panes with those names so the rows line up. That is
//   supplying its own input, deliberately: what is under test is the RENDERER's
//   output for a census, not that this census ever existed. A row shape the
//   renderer grows still goes red; a foreign pane the page invented does not.
//
// * IT COVERS SIX OF THE PAGE'S THIRTEEN PROGRAM-OUTPUT BLOCKS. The other
//   seven are in UNCOVERED below, each with the reason it is not reproduced
//   here. Section 1 fails if a fenced block of program output is in neither
//   list, so the coverage cannot silently shrink — but it is coverage of six,
//   and a green run is not a statement about the other seven.
//
// * IT RUNS AGAINST A SHIM. Under CI there is no herdr, so the pane text a
//   `send` or `tail` quotes back is the shim's, not an agent's. Those lines
//   are excluded per scenario by `verbatimFrom`, which names the label they
//   start after; everything above the label is the renderer's and is checked.
//
// ---------------------------------------------------------------------------
// SIX SECTIONS
//
//   1. every fenced block of program output on the page is covered here or
//      registered as uncovered with a reason
//   2. the six covered blocks: every line the program printed is on the page
//   3. the detector is non-vacuous — four canaries, three that must go red and
//      one that must stay green because the mask is supposed to hide it
//   4. the page's own history: the check goes RED against the two revisions
//      that really had drifted (72db4cd, e7ffb58), which is the red run AC 2
//      asks for, wired in rather than pasted once
//   5. the rejected option 3, built and shown green on a page this one catches
//   6. the mask register: every rule, and what it costs
//
// Needs no herdr and no network. Needs `npm run build`. Section 4 needs git
// history and reports NOT RUN (a failure) rather than a pass if the revisions
// are unreachable, e.g. in a shallow clone.
//
// Usage:
//   npm run build
//   node scripts/verify-readme-is-current.mjs [distDir]

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));
const cliJs = path.join(distDir, 'cli.js');

const README = path.join(repoRoot, 'README.md');

let failures = 0;
const check = (ok, claim, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`);

// ===========================================================================
// The page, parsed.
// ===========================================================================

/** Every fenced block in a markdown document, with the heading it sits under. */
function fencedBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let heading = '(top)';
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      if (!open) open = { info: fence[1], heading, start: i + 2 };
      else {
        blocks.push({ ...open, end: i, body: lines.slice(open.start - 1, i) });
        open = null;
      }
      return;
    }
    if (!open && /^#{1,6} /.test(line)) heading = line.trim();
  });
  return blocks;
}

/**
 * A block is program output when it contains a shell prompt driving this
 * program, or a line the program itself begins. Everything else on the page is
 * an install snippet, a config document or a command menu, and no renderer
 * emits it.
 */
const isProgramOutput = (block) =>
  block.body.some((l) => /^\$ (crabcast|herdr|export )/.test(l) || /^crabcast: /.test(l)) ||
  block.body.some((l) => /^build — what THIS process was loaded from/.test(l));

/**
 * A block split into `$ command` / output pairs. Lines before the first
 * command belong to no command and are returned under a null command, which
 * is how the freshness block (all output, no prompt) is still addressable.
 */
function segmentsOf(body) {
  const segments = [];
  let current = { command: null, output: [] };
  for (const line of body) {
    if (line.startsWith('$ ')) {
      if (current.command !== null || current.output.length) segments.push(current);
      current = { command: line.slice(2), output: [] };
    } else current.output.push(line);
  }
  segments.push(current);
  return segments.filter((s) => s.command !== null || s.output.length);
}

// ===========================================================================
// The mask. Every rule is a value that MUST differ between two runs, and each
// one is a hole in what this check can see — section 6 prints the register.
// ===========================================================================

const MASKS = [
  {
    id: 'TIME',
    re: /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,
    to: '<TIME>',
    why: 'an ISO timestamp. Two runs never share one.',
    costs: 'a renderer that printed the WRONG timestamp — a stale read, a boot time where a read time belongs — is invisible here.'
  },
  {
    id: 'UUID',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    to: '<UUID>',
    why: "the daemon's bootId, minted at every start.",
    costs: 'two different boots are indistinguishable, so a stale bootId reads the same as a fresh one.'
  },
  {
    id: 'ID',
    re: /\b[0-9a-f]{16}\b/g,
    to: '<ID>',
    why: "the 16-hex digest `identity.ts` derives a pane name from. It is a function of the directory, and this check's directory is a scratch one.",
    costs: 'two different agents\u2019 pane names are indistinguishable after masking, so a row attributed to the wrong agent still passes.'
  },
  {
    id: 'PANE',
    re: /\bw[0-9a-f]+-\d+\b/g,
    to: '<PANE>',
    why: "a herdr pane id. It is a position in herdr's pane list and moves whenever any pane anywhere closes.",
    costs: 'a pane id printed where a different pane id belongs reads the same.'
  },
  {
    id: 'MS',
    re: /\b\d+ms\b/g,
    to: '<MS>',
    why: 'a millisecond duration of a real wait.',
    costs: 'nothing about durations is checked at all.'
  },
  {
    id: 'BOUND',
    re: /bound by (cpu|memory|load|cap|configured|floor|count)\b/g,
    to: 'bound by <TERM>',
    why: 'which capacity term binds is a fact about the machine the command ran on. A GitHub runner and a ThinkPad do not agree, and neither is wrong.',
    costs: 'a capacity report that named the wrong binding constraint would pass. `verify-agent-capacity` owns that arithmetic; this check owns the page.'
  },
  {
    id: 'SOURCE',
    re: /\((seed|measured|override)\)/g,
    to: '(<SOURCE>)',
    why: 'whether the agent-cost figures are the seed constants, a live measurement or an operator override depends on how long the daemon has been up (the sampler fires at 60s) and on the environment.',
    costs: 'a page claiming measured figures where the program says seed would pass.'
  },
  {
    id: 'NUM',
    re: /\b\d+(\.\d+)?\b/g,
    to: '<NUM>',
    why: 'every bare number: counts, sizes, load averages, character totals, versions.',
    costs: 'THE WIDEST RULE HERE. A page showing `priority 1` where the program prints `priority 9` passes. Numbers are values; this check is about lines.'
  }
];

const maskLine = (line) => MASKS.reduce((s, m) => s.replace(m.re, m.to), line);

/**
 * Lines that legitimately have two shapes, because the branch taken depends on
 * the machine rather than on the code. A captured line matches the page when
 * the page shows EITHER member of its group.
 */
const VARIANTS = [
  {
    why: 'the agent-cost provenance line. With no live measurement the renderer prints the seed disclaimer; once the daemon\u2019s 60s sampler has fired it prints the measurement instead. A run slow enough to cross that boundary must not turn red.',
    shapes: [
      '  no live measurement; seed figures are the <NUM>-<NUM>-<NUM> constants, not a measurement of this fleet',
      /^ {2}measured \(damped\): /
    ]
  },
  {
    why: 'the capacity summary headline gains an `at capacity: ` prefix when headroom is zero, which on a busy runner it may be and on the capturing machine it was not.',
    shapes: [/^ {2}(at capacity: )?<NUM>\/<NUM> charged agents/]
  }
];

/** Does `pageShape` satisfy `captured`, allowing for a declared variant? */
function shapesMatch(captured, pageShape) {
  if (captured === pageShape) return true;
  for (const group of VARIANTS) {
    const hit = (s) => group.shapes.some((m) => (typeof m === 'string' ? m === s : m.test(s)));
    if (hit(captured) && hit(pageShape)) return true;
  }
  return false;
}

// ===========================================================================
// The scratch, the shim, and the CLI driver.
// ===========================================================================

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kan175-readme-')));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

function cleanup() {
  // Every daemon this script started lives in a scratch dataDir; ask each to
  // stop through its own pidfile rather than leaving one holding a socket in a
  // directory that is about to vanish.
  for (const dataDir of daemonDataDirs) {
    const pidFile = path.join(dataDir, 'daemon.pid');
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
const daemonDataDirs = new Set();
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}

const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimDir, { recursive: true });

// A stateful `herdr`: `agent start` really adds a pane, `pane close` really
// removes one, a pane has a transcript and a composer and only Enter moves
// text from one to the other. Pane ids are herdr-shaped (`w<hex>-<n>`) because
// that shape is what the PANE mask keys off — a shim that invented `100` would
// leave those lines comparing an unmasked number against a masked pane id.
const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.CRABCAST_README_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const file = path.join(state, 'panes.json');
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
const save = (l) => fs.writeFileSync(file, JSON.stringify(l, null, 2));
const foreign = () => {
  const f = path.join(state, 'foreign.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
};
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const paneId = (n) => 'w65702dcc803d94-' + (10 + n);
const [a, b] = args;

if (a === '--version') { process.stdout.write('herdr 0.6.4\\n'); process.exit(0); }

if (a === 'agent' && b === 'start') {
  const panes = load();
  const cwdIdx = args.indexOf('--cwd');
  const pane = {
    name: args[2],
    pane_id: paneId(panes.length),
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    agent: null,
    agent_status: 'unknown',
    transcript: 'Please read and follow the instructions in the prompt to begin.',
    composer: ''
  };
  // A \`shell\` launcher is a bash prompt with no runtime behind it, which is
  // exactly what herdr reports for one; anything else gets a runtime.
  const sep = args.indexOf('--');
  const argv = sep === -1 ? [] : args.slice(sep + 1);
  if (!argv.join(' ').match(/bash|sh$/)) pane.agent = 'claude';
  panes.push(pane);
  save(panes);
  out({ result: { agent: { name: pane.name, pane_id: pane.pane_id } } });
}

if (a === 'agent' && b === 'list') {
  out({
    result: {
      agents: [...load(), ...foreign()].map((p) => ({
        name: p.name,
        pane_id: p.pane_id,
        cwd: p.cwd,
        ...(p.agent ? { agent: p.agent } : {}),
        agent_status: p.agent_status ?? 'unknown'
      }))
    }
  });
}

if (a === 'agent' && b === 'get') {
  const found = [...load(), ...foreign()].find((p) => p.name === args[2]);
  if (found) {
    out({ result: { agent: {
      name: found.name, pane_id: found.pane_id, cwd: found.cwd,
      ...(found.agent ? { agent: found.agent } : {}),
      agent_status: found.agent_status ?? 'unknown'
    } } });
  }
  process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: 'no such agent' } }));
  process.exit(1);
}

const byName = (name) => load().find((p) => p.name === name);
const byPane = (id) => load().find((p) => p.pane_id === id);
const put = (pane) => save(load().map((p) => (p.pane_id === pane.pane_id ? pane : p)));

if (a === 'agent' && b === 'read') {
  const p = byName(args[2]);
  if (!p) {
    process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: 'no such agent' } }));
    process.exit(1);
  }
  out({ result: { read: { text: p.transcript + '\\n\u276f ' + p.composer, truncated: false } } });
}
if (a === 'pane' && b === 'send-text') {
  const p = byPane(args[2]);
  if (p) { p.composer = args[3] ?? ''; put(p); }
  out({ result: {} });
}
if (a === 'pane' && b === 'send-keys') {
  const p = byPane(args[2]);
  if (p) {
    if (args[3] === 'Enter') {
      if (p.composer) p.transcript += '\\n\u276f ' + p.composer;
      p.composer = '';
    } else if (args[3] === 'C-c') p.composer = '';
    put(p);
  }
  out({ result: {} });
}
if (a === 'pane' && b === 'close') {
  save(load().filter((p) => p.pane_id !== args[2]));
  out({ result: {} });
}
if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
}
if (a === 'pane' && b === 'list') out({ result: { panes: [] } });
// A real \`agent attach\` holds the terminal for as long as the client wants it.
// A shim that returned immediately would have every session die the moment it
// was created, and \`list\` would report every agent \`sessionless\` — which is a
// true rendering of a state this scenario is not in.
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else out({ result: {} });
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);

let scenarioSeq = 0;

/**
 * One scenario's world: its own demo root, its own shim state, its own daemon.
 *
 * `pagePath` is the directory prefix the README shows. Every capture has the
 * real scratch prefix rewritten to it before comparison — a substitution, not
 * a mask, so a path the renderer got WRONG still shows up as a difference.
 */
function world(pagePath, env = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, `w${++scenarioSeq}-`)));
  const state = path.join(root, 'shim-state');
  fs.mkdirSync(state, { recursive: true });
  // The demo directory's BASENAME is the page's, because a pane name is
  // `crabcast-<basename>-<digest>` and only the digest is masked. A scratch
  // directory called `demo` would print `crabcast-demo-…` against the page's
  // `crabcast-notes-…` and report drift that is this harness's own.
  const demo = path.join(root, path.basename(pagePath));
  fs.mkdirSync(demo, { recursive: true });
  const dataDir = path.join(demo, '.crabcast');
  daemonDataDirs.add(dataDir);
  const configPath = path.join(demo, 'crabcast.config.json');
  fs.writeFileSync(configPath, '{ "dataDir": ".crabcast" }\n');
  return {
    demo,
    dataDir,
    state,
    pagePath,
    /** Tell the shim which panes it did not start but must report. */
    setForeign(panes) {
      fs.writeFileSync(path.join(state, 'foreign.json'), JSON.stringify(panes, null, 2));
    },
    env: {
      ...process.env,
      HOME: fakeHome,
      SHELL: '/bin/bash',
      PATH: `${shimDir}:/usr/local/bin:/usr/bin:/bin`,
      CRABCAST_README_SHIM_STATE: state,
      CRABCAST_CONFIG: undefined,
      CRABCAST_MAX_AGENTS: undefined,
      CRABCAST_AGENT_CORES: undefined,
      CRABCAST_AGENT_MEMORY_MB: undefined,
      ...env
    },
    /** Rewrite this world's real paths to the ones the page shows. */
    toPage(text) {
      return text.split(demo).join(pagePath);
    },
    /** And the other way, for building a command line out of the page's. */
    fromPage(text) {
      return text.split(pagePath).join(demo);
    }
  };
}

/** Run the CLI the way a reader would, from inside the demo directory. */
function crabcast(w, argv, extraEnv = {}) {
  const r = spawnSync(process.execPath, [cliJs, ...argv], {
    cwd: w.demo,
    env: { ...w.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 120_000
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, text };
}

/**
 * One `$ ` line of a block, captured.
 *
 * `command` is written exactly as the page writes it, with this world's real
 * paths substituted back out — so section 2 matches segments by the command
 * line itself rather than by position, and a command the page does not show at
 * all is a failure rather than an off-by-one.
 */
function ran(w, pageCommand, opts = {}) {
  const { exitLine = false, alwaysExitLine = false, verbatimFrom = null } = opts;
  const argv = opts.argv ?? splitArgs(w.fromPage(pageCommand)).slice(1);
  const { code, text } = crabcast(w, argv);
  let out = w.toPage(text).replace(/\n$/, '').split('\n');
  if (exitLine && (alwaysExitLine || code !== 0)) out.push(`[exit ${code}]`);
  // Everything from `verbatimFrom` on is a pane's own text quoted back, not a
  // line any renderer composed. Under a shim that text is the shim's, so it is
  // dropped here and said so — this is a boundary of the check, not a filter
  // for convenience.
  if (verbatimFrom) {
    const at = out.findIndex((l) =>
      typeof verbatimFrom === 'string' ? l === verbatimFrom : verbatimFrom.test(l));
    if (at >= 0) out = out.slice(0, at + 1);
  }
  return { command: pageCommand, output: out, recipeOnly: opts.recipeOnly === true };
}

/** Enough shell splitting for the command lines this page contains. */
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ===========================================================================
// The scenarios: one per covered block, each reproducing that block's commands.
// ===========================================================================

/**
 * Capacity figures that vary with the machine are pinned where the block is
 * not ABOUT capacity: a cap the operator set and per-agent costs small enough
 * that neither load nor memory can bind. Every value these change is inside a
 * masked token (`<NUM>`, `bound by <TERM>`, `(<SOURCE>)`), so what is bought is
 * determinism on a busy runner and nothing else is spent.
 */
const PINNED_CAPACITY = {
  CRABCAST_MAX_AGENTS: '3',
  CRABCAST_AGENT_CORES: '0.001',
  CRABCAST_AGENT_MEMORY_MB: '1'
};

const WALKTHROUGH_PROMPT = `You are a CrabCast agent working in the notes directory.

This prompt was rendered by the CALLER and handed to CrabCast as finished
text. CrabCast wrote these bytes verbatim and never looked at them — a literal
{{KEY}} would have survived unchanged.
`;

/** The capturing machine's own fleet, as the page's \`list\` block shows it. */
const PAGE_FOREIGN_PANES = [
  ['butchr-task-kan-39', 'w65702dcc803d94-8', '/home/brooswit/.local/share/butchr/workspaces/task/kan-39', 'done'],
  ['butchr-task-kan-139', 'w65702dcc803d94-9', '/home/brooswit/.local/share/butchr/workspaces/task/kan-139', 'working'],
  ['butchr-story-kan-103', 'w65702dcc803d94-7', '/home/brooswit/.local/share/butchr/workspaces/story/kan-103', 'done'],
  ['butchr-epic-kan-59', 'w65702dcc803d94-6', '/home/brooswit/.local/share/butchr/workspaces/epic/kan-59', 'done'],
  ['butchr-epic-kan-39', 'w65702dcc803d94-5', '/home/brooswit/.local/share/butchr/workspaces/epic/kan-39', 'done']
].map(([name, pane_id, cwd, agent_status]) => ({ name, pane_id, cwd, agent: 'claude', agent_status }));

const SCENARIOS = [
  {
    id: 'walkthrough',
    heading: '## Walkthrough: CrabCast on a directory you already own',
    index: 0,
    async run() {
      const w = world('/tmp/ac1-demo', PINNED_CAPACITY);
      const notes = path.join(w.demo, 'notes');
      fs.mkdirSync(notes, { recursive: true });
      fs.writeFileSync(path.join(w.demo, 'prompt.txt'), WALKTHROUGH_PROMPT);
      w.setForeign(PAGE_FOREIGN_PANES);

      const N = '/tmp/ac1-demo/notes';
      const out = [];
      out.push(ran(w, 'crabcast list', { exitLine: true }));
      out.push(ran(w,
        `crabcast configure ${N} --priority 1 --launcher shell --prompt-file prompt.txt --label "the notes agent"`));
      out.push(ran(w, `crabcast activate ${N}`));
      out.push(ran(w, 'crabcast list'));
      out.push(ran(w, `crabcast status ${N}`));
      // The sidecar path carries the identity digest, which is a function of
      // the directory — so this one command is built rather than substituted.
      const sidecar = path.join(w.dataDir, 'agents');
      const digest = fs.readdirSync(sidecar)[0];
      out.push(ran(w,
        `crabcast send ${N} cat /tmp/ac1-demo/.crabcast/agents/31e31d1b7540dabf/prompt.md`,
        { argv: ['send', notes, 'cat', path.join(sidecar, digest, 'prompt.md')],
          verbatimFrom: '  pane the verdict was read from:' }));
      out.push(ran(w, `crabcast tail ${N} --lines 20`, { verbatimFrom: /^pane text for / }));
      out.push(ran(w, `crabcast deactivate ${N}`));
      out.push(ran(w, `crabcast forget ${N}`));
      return out;
    }
  },
  {
    id: 'occupied-directory',
    heading: '### When the directory is already occupied, `activate` refuses',
    index: 0,
    async run() {
      // The page configures a directory an unrelated fleet's agent is sitting
      // in. Here the shim reports that pane; the guard reads the census it is
      // given, which is the whole of what it consults.
      const target = '/home/brooswit/.local/share/butchr/workspaces/task/kan-39';
      const w = world(target, PINNED_CAPACITY);
      w.setForeign([{
        name: 'butchr-task-kan-39',
        pane_id: 'w65702dcc803d94-8',
        cwd: w.demo,
        agent: 'claude',
        agent_status: 'done'
      }]);
      return [
        ran(w, `crabcast configure ${target} --priority 1 --launcher shell`),
        ran(w, `crabcast activate ${target}`, { exitLine: true })
      ];
    }
  },
  {
    id: 'idempotent-activate',
    heading: '### Calling a verb again is safe, and that is a contract',
    index: 0,
    async run() {
      // The page's daemon was spawned with CRABCAST_MAX_AGENTS=0 exported, so
      // it is at a cap of zero for every line of the block: call #1 needs
      // --override and the repeats do not.
      const w = world('/tmp/kan174/idem', { CRABCAST_MAX_AGENTS: '0' });
      const a = path.join(w.demo, 'probe-a');
      fs.mkdirSync(a, { recursive: true });
      const P = '/tmp/kan174/idem/probe-a';
      const conf = ran(w, `crabcast configure ${P} --priority 1 --launcher shell`);
      if (conf.output.join('\n').includes('FAILED')) return [conf];
      const out = [];
      out.push(ran(w, `crabcast activate ${P} --override      # call #1`,
        { argv: ['activate', a, '--override'] }));
      out.push(ran(w, `crabcast activate ${P}                 # call #2, no --override`,
        { argv: ['activate', a] }));
      out.push(ran(w, `crabcast activate ${P}                 # call #3, no --override`,
        { argv: ['activate', a] }));
      out.push(ran(w, `crabcast activate ${P} --json`));
      return out;
    }
  },
  {
    id: 'idempotent-deactivate',
    heading: '### Calling a verb again is safe, and that is a contract',
    index: 1,
    async run() {
      const w = world('/tmp/kan174/idem', { CRABCAST_MAX_AGENTS: '0' });
      const a = path.join(w.demo, 'probe-a');
      const b = path.join(w.demo, 'probe-b');
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      const A = '/tmp/kan174/idem/probe-a';
      const B = '/tmp/kan174/idem/probe-b';
      ran(w, `crabcast configure ${A} --priority 1 --launcher shell`);
      ran(w, `crabcast configure ${B} --priority 1 --launcher shell`);
      ran(w, `crabcast activate ${A} --override`);
      return [
        ran(w, `crabcast deactivate ${A}      # it was running`, { argv: ['deactivate', a] }),
        ran(w, `crabcast deactivate ${A}      # and again`,
          { argv: ['deactivate', a], exitLine: true, alwaysExitLine: true }),
        ran(w, `crabcast deactivate ${B}      # configured, never activated`,
          { argv: ['deactivate', b], exitLine: true, alwaysExitLine: true })
      ];
    }
  },
  {
    id: 'capacity-refusal',
    heading: '### When the machine is full, `activate` refuses',
    index: 0,
    async run() {
      const w = world('/tmp/kan174/cap', { CRABCAST_MAX_AGENTS: '0' });
      const notes = path.join(w.demo, 'notes');
      fs.mkdirSync(notes, { recursive: true });
      const N = '/tmp/kan174/cap/notes';
      return [
        // The page's `export` line and its `configure` are the recipe rather
        // than the output — the variable has to reach the process that SPAWNS
        // the daemon, which is what this world's env does.
        ran(w, `crabcast configure ${N} --priority 1 --launcher shell   # spawns the daemon, which reads it here`,
          { argv: ['configure', notes, '--priority', '1', '--launcher', 'shell'], recipeOnly: true }),
        ran(w, `crabcast activate ${N}`, { exitLine: true })
      ];
    }
  },
  {
    id: 'refused-config',
    heading: '### Editing the config after the daemon is running',
    index: 0,
    async run() {
      const w = world('/tmp/kan175/badconfig');
      fs.writeFileSync(
        path.join(w.demo, 'bad.json'),
        JSON.stringify({ workspaceTypes: { task: { priority: 1 } } }, null, 2)
      );
      const r = ran(w, 'crabcast --config bad.json list');
      // The page renders this one's exit as `exit=4` rather than `[exit 4]`,
      // which is the block's own convention and not the renderer's.
      return [{ ...r, output: [...r.output, 'exit=4'] }];
    }
  }
];

/**
 * Fenced blocks of program output this check does NOT reproduce, and why.
 *
 * The rule section 1 enforces is the one `verify-proof-registry` enforces for
 * proofs: a block is covered by a scenario or it is named here with a reason a
 * reader can act on. A check that quietly covered a third of the page would be
 * this epic's own defect wearing this ticket's clothes.
 */
const UNCOVERED = [
  {
    heading: '### Which herdr releases have actually been run',
    index: 0,
    reason:
      'The herdr version notice for 0.7.5, emitted only when the herdr on PATH is not 0.6.x. ' +
      'Reproducing it needs a shim pretending to be 0.7.5, which would be a second shim with a ' +
      'second version story running against the same daemon. scripts/verify-herdr-version-notice.mjs ' +
      'already produces this exact string from the real code path; what nobody checks is that the ' +
      'PAGE still shows what that script produces.'
  },
  {
    heading: '### Which herdr releases have actually been run',
    index: 1,
    reason:
      'The same notice for 0.8.0 (KAN-181), and uncovered for the same reason as the 0.7.5 one ' +
      'above it: it needs a shim reporting a third version. Its section-4 sibling in ' +
      'scripts/verify-herdr-version-notice.mjs asserts this exact sentence out of checkHerdrVersion ' +
      'and out of a real daemon’s stderr, so the STRING is covered and only its presence on this ' +
      'page is not. That is the same gap the entry above declares, now twice — which is the ' +
      'argument for covering both at once rather than a reason either is fine.'
  },
  {
    heading: "### Changing an agent's knobs never costs it its conversation",
    index: 0,
    reason:
      'DELIBERATELY ELIDED on the page: the configure response in it is cut with a `…` line. A ' +
      'completeness check over a block the author truncated on purpose would be red forever, and ' +
      'switched off within a week.'
  },
  {
    heading: "### Changing an agent's knobs never costs it its conversation",
    index: 1,
    reason:
      'The restart-required refusal, followed by a `send` and a `tail` whose output is a REAL ' +
      'agent pane echoing a string back. Reproducible in principle; not reproduced here, and the ' +
      'reason is honest rather than technical — this scenario needs its own two-agent world and ' +
      'the six blocks below were the budget. scripts/verify-reconfiguration-refuses.mjs drives the ' +
      'same refusal, so the BEHAVIOUR is covered; the PAGE is not.'
  },
  {
    heading: "### Changing an agent's knobs never costs it its conversation",
    index: 2,
    reason: 'DELIBERATELY ELIDED: two `…` lines stand in for the rest of the configure response.'
  },
  {
    heading: "### Changing an agent's knobs never costs it its conversation",
    index: 3,
    reason:
      'DELIBERATELY ELIDED, and its command line is elided too — the page writes ' +
      '`crabcast configure … --priority 11`, with a literal ellipsis where the directory goes.'
  },
  {
    heading: '### Which build is running',
    index: 0,
    reason:
      'Four command lines with NO output pasted under them: the block is the recipe for reaching ' +
      'PROCESS-PREDATES-BUILD, not a transcript. There are no printed lines for this check to ' +
      'find missing.'
  },
  {
    heading: '### Which build is running',
    index: 1,
    reason:
      'The build/freshness block. Reaching PROCESS-PREDATES-BUILD needs a real `npm run build` ' +
      'in the middle of the run, under a live daemon — a minute of tsc inside a check that ' +
      'otherwise takes seconds, and a second build tree to rebuild. NOBODY COVERS THIS PAGE ' +
      'BLOCK. scripts/verify-daemon-provenance.mjs produces the state and asserts the daemon’s ' +
      'answer, but it never looks at README.md. Filed as KAN-180.'
  }
];

// ===========================================================================
// The comparison. One captured segment against one pasted segment.
// ===========================================================================

/**
 * Locate a scenario's or an exclusion's block on a page.
 *
 * `index` is the nth fenced block under that heading, counting only blocks of
 * program output — so an install snippet appearing under the same heading does
 * not shift the numbering.
 */
function blockFor(blocks, heading, index) {
  const under = blocks.filter((b) => b.heading === heading && isProgramOutput(b));
  return under[index] ?? null;
}

/**
 * Every line the program printed, in order, must appear in the page's segment
 * for that command — as a SUBSEQUENCE, not as a set.
 *
 * Set membership is the weak form and it fails in a specific way KAN-174 hit
 * from the other direction: a line satisfied by an occurrence somewhere else
 * entirely. Requiring order means a line that only appears BEFORE the one
 * already matched does not count, so a block whose lines were shuffled or
 * whose section was pasted from a different command is still caught. Extra
 * lines on the page are allowed: the page is a real session and may show
 * values this shimmed run does not produce.
 */
function compareSegment(captured, pasted) {
  const want = captured.output.map(maskLine);
  const have = pasted.output.map(maskLine);
  const missing = [];
  let cursor = 0;
  for (let i = 0; i < want.length; i += 1) {
    let at = -1;
    for (let j = cursor; j < have.length; j += 1) {
      if (shapesMatch(want[i], have[j])) { at = j; break; }
    }
    if (at === -1) missing.push({ line: captured.output[i], shape: want[i] });
    else cursor = at + 1;
  }
  return missing;
}

/**
 * Match a captured command line to a pasted one, masked, AT OR AFTER `from`.
 *
 * The cursor is not decoration. The walkthrough runs `crabcast list` twice —
 * once with no daemon (a refusal) and once over a live fleet — and a search
 * that always returned the first match would compare the second run's 60 lines
 * against the refusal's five and report the whole fleet listing as missing
 * from a page that shows every line of it.
 */
function findSegment(pasted, command, from = 0) {
  const target = maskLine(command);
  for (let i = from; i < pasted.length; i += 1) {
    if (pasted[i].command !== null && maskLine(pasted[i].command) === target) return i;
  }
  return -1;
}

/**
 * Run every scenario against a given README text and report what is missing.
 * `captures` is computed once and reused, because running the fleet six times
 * over is the expensive half and the page is the only thing that changes.
 */
function auditPage(markdown, captures) {
  const blocks = fencedBlocks(markdown);
  const report = [];
  for (const scenario of SCENARIOS) {
    const block = blockFor(blocks, scenario.heading, scenario.index);
    if (!block) {
      report.push({ scenario: scenario.id, blockMissing: true, missing: [], unmatched: [] });
      continue;
    }
    const pasted = segmentsOf(block.body);
    const missing = [];
    const unmatched = [];
    let cursor = 0;
    for (const captured of captures[scenario.id]) {
      const at = findSegment(pasted, captured.command, cursor);
      if (at === -1) { unmatched.push(captured.command); continue; }
      cursor = at + 1;
      // A command the page shows with no output under it is a recipe line —
      // the page is telling a reader what to type, not what it printed. There
      // is nothing there to be missing from.
      if (captured.recipeOnly) {
        // The declaration is checked, not trusted: if the page later pastes
        // output under this command, this flag would silently stop checking it.
        if (pasted[at].output.some((l) => l.trim() !== '')) {
          missing.push({
            command: captured.command,
            line: '(this command is declared output-free, and the page now pastes output under it)',
            shape: ''
          });
        }
        continue;
      }
      for (const m of compareSegment(captured, pasted[at])) {
        missing.push({ command: captured.command, ...m });
      }
    }
    report.push({ scenario: scenario.id, blockMissing: false, missing, unmatched });
  }
  return report;
}

const reportIsClean = (report) =>
  report.every((r) => !r.blockMissing && !r.missing.length && !r.unmatched.length);

function printReport(report, { limit = 8 } = {}) {
  for (const r of report) {
    if (r.blockMissing) { console.log(`    ${r.scenario}: THE BLOCK IS NOT ON THE PAGE`); continue; }
    if (!r.missing.length && !r.unmatched.length) { console.log(`    ${r.scenario}: complete`); continue; }
    console.log(`    ${r.scenario}: ${r.missing.length} line(s) the program printed that the page does not show` +
      (r.unmatched.length ? `, ${r.unmatched.length} command(s) the page does not show at all` : ''));
    for (const c of r.unmatched) console.log(`      no such command on the page: $ ${c}`);
    for (const m of r.missing.slice(0, limit)) {
      console.log(`      under \`$ ${m.command}\`:`);
      console.log(`        ${JSON.stringify(m.line)}`);
    }
    if (r.missing.length > limit) console.log(`      … and ${r.missing.length - limit} more`);
  }
}

// ===========================================================================
// Run everything.
// ===========================================================================

const readme = fs.readFileSync(README, 'utf8');
const blocks = fencedBlocks(readme);

// ---------------------------------------------------------------------------
rule('1. Every fenced block of program output is covered here, or registered');
// ---------------------------------------------------------------------------

const programBlocks = blocks.filter(isProgramOutput);
check(programBlocks.length > 0, 'the page has blocks of program output', `${programBlocks.length} found`);

const claimed = new Map();
const claim = (heading, index, owner) => {
  const b = blockFor(blocks, heading, index);
  if (!b) return null;
  claimed.set(b.start, owner);
  return b;
};

for (const s of SCENARIOS) {
  const b = claim(s.heading, s.index, `scenario ${s.id}`);
  check(Boolean(b), `scenario '${s.id}' names a block that is on the page`,
    b ? `README.md:${b.start}-${b.end} under ${s.heading}` : `${s.heading} #${s.index} is gone`);
}
for (const u of UNCOVERED) {
  const b = claim(u.heading, u.index, 'registered as uncovered');
  check(Boolean(b), `exclusion for '${u.heading}' #${u.index} names a block that is on the page`,
    b ? '' : 'the block is gone — remove the entry, or it is a reason nobody re-reads');
  check(typeof u.reason === 'string' && u.reason.trim().length >= 60,
    `that exclusion carries a reason, not just a name`);
}

for (const b of programBlocks) {
  check(claimed.has(b.start),
    `README.md:${b.start}-${b.end} (${b.heading}) is accounted for`,
    claimed.get(b.start) ??
      'NOT reproduced by a scenario and NOT in the UNCOVERED register — add it to one or the other');
}

console.log(`\n  ${programBlocks.length} program-output block(s): ` +
  `${SCENARIOS.length} reproduced, ${UNCOVERED.length} registered as uncovered.\n`);
for (const u of UNCOVERED) {
  const b = blockFor(blocks, u.heading, u.index);
  console.log(`  UNCOVERED  ${u.heading} #${u.index}${b ? ` (README.md:${b.start}-${b.end})` : ''}`);
  console.log(`    ${u.reason.replace(/\s+/g, ' ')}\n`);
}

// ---------------------------------------------------------------------------
rule('2. Every line the program printed has a counterpart on the page');
// ---------------------------------------------------------------------------

const captures = {};
for (const s of SCENARIOS) {
  captures[s.id] = await s.run();
  const lines = captures[s.id].reduce((n, c) => n + c.output.length, 0);
  console.log(`  captured ${s.id}: ${captures[s.id].length} command(s), ${lines} line(s) of output`);
}
console.log('');

const live = auditPage(readme, captures);
for (const r of live) {
  check(!r.blockMissing && !r.missing.length && !r.unmatched.length,
    `${r.scenario}: the page shows every line this run printed`,
    r.blockMissing
      ? 'the block is not on the page'
      : `${r.missing.length} missing line(s), ${r.unmatched.length} missing command(s)`);
}
if (!reportIsClean(live)) { console.log(''); printReport(live, { limit: 40 }); }

// ===========================================================================
// Editing a copy of the page, for the canaries and for section 5.
// ===========================================================================

/** Replace one block's body on a copy of the page. Returns null if it is gone. */
function withBlockBody(markdown, heading, index, transform) {
  const lines = markdown.split('\n');
  const under = fencedBlocks(markdown).filter((b) => b.heading === heading && isProgramOutput(b));
  const b = under[index];
  if (!b) return null;
  const body = transform(lines.slice(b.start - 1, b.end));
  if (!body) return null;
  return [...lines.slice(0, b.start - 1), ...body, ...lines.slice(b.end)].join('\n');
}

/** The half-open range of output lines under `$ command` inside a block body. */
function segmentRange(body, command) {
  const at = body.indexOf(`$ ${command}`);
  if (at === -1) return null;
  let end = at + 1;
  while (end < body.length && !body[end].startsWith('$ ')) end += 1;
  return [at + 1, end];
}

/** Apply `edit` to one command's pasted output on a copy of the page. */
function editSegment(markdown, heading, index, command, edit) {
  return withBlockBody(markdown, heading, index, (body) => {
    const range = segmentRange(body, command);
    if (!range) return null;
    const [from, to] = range;
    const edited = edit(body.slice(from, to));
    if (!edited) return null;
    return [...body.slice(0, from), ...edited, ...body.slice(to)];
  });
}

const dropLine = (needle) => (out) => {
  const at = out.findIndex((l) => l.includes(needle));
  return at === -1 ? null : [...out.slice(0, at), ...out.slice(at + 1)];
};
const rewordLine = (needle, from, to) => (out) => {
  const at = out.findIndex((l) => l.includes(needle));
  return at === -1 || !out[at].includes(from)
    ? null
    : out.map((l, i) => (i === at ? l.replace(from, to) : l));
};
const swapAdjacent = (first, second) => (out) => {
  const a = out.findIndex((l) => l.includes(first));
  const b = out.findIndex((l) => l.includes(second));
  if (a === -1 || b !== a + 1) return null;
  const next = out.slice();
  [next[a], next[b]] = [next[b], next[a]];
  return next;
};

const WALK = '## Walkthrough: CrabCast on a directory you already own';
const ACTIVATE = 'crabcast activate /tmp/ac1-demo/notes';
const STATUS = 'crabcast status /tmp/ac1-demo/notes';
const CONFIGURE =
  'crabcast configure /tmp/ac1-demo/notes --priority 1 --launcher shell ' +
  '--prompt-file prompt.txt --label "the notes agent"';

/**
 * A canary is a page altered on purpose, with a verdict this check must reach.
 *
 * `expect: 'red'` is the ticket's requirement: a masked diff whose mask is too
 * wide passes against anything, and only a page altered in a way the mask must
 * NOT hide can tell the difference between a detector and a constant.
 *
 * `expect: 'green'` is the same question asked from the other side, and it is
 * not padding. Each one is a real defect this check cannot see, produced and
 * confirmed invisible rather than described — because a reader who knows what
 * the mask hides can go and look, and one who has only been told it hides
 * "volatile values" cannot.
 */
const CANARIES = [
  {
    id: 'a-line-deleted',
    expect: 'red',
    what: 'one line removed from the `status` block — the KAN-139 drift, by hand',
    page: (md) => editSegment(md, WALK, 0, STATUS, dropLine('state:         running'))
  },
  {
    id: 'a-line-reworded',
    expect: 'red',
    what: 'one WORD changed in a sentence the mask does not touch (`stopped` → `left`)',
    page: (md) =>
      editSegment(md, WALK, 0, ACTIVATE,
        rewordLine('next activate: RESUMES', 'it was stopped in', 'it was left in'))
  },
  {
    id: 'two-lines-swapped',
    expect: 'red',
    what: 'two adjacent lines swapped — both still present, so a SET check cannot see it',
    page: (md) =>
      editSegment(md, WALK, 0, STATUS, swapAdjacent('pane name:', 'pane id:'))
  },
  {
    id: 'a-line-moved-to-another-block',
    expect: 'red',
    what:
      "a line cut from `status` and pasted into `list` — present on the page, absent from the " +
      'block that has to show it. This is KAN-174’s trap in this direction.',
    page: (md) => {
      const cut = editSegment(md, WALK, 0, STATUS, dropLine('state:         running'));
      return cut === null
        ? null
        : editSegment(cut, WALK, 0, 'crabcast list', (out) => [...out, '  state:         running']);
    }
  },
  {
    id: 'timestamps-and-pane-ids-rewritten',
    expect: 'green',
    what:
      'every timestamp and pane id on the page replaced with a different one. GREEN BY DESIGN: ' +
      'these are the values two runs cannot share, so hiding them is what makes the check ' +
      'runnable at all — and the cost is that a WRONG one reads the same as a right one.',
    page: (md) =>
      withBlockBody(md, WALK, 0, (body) =>
        body.map((l) =>
          l.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '2019-01-01T00:00:00.000Z')
            .replace(/\bw[0-9a-f]+-\d+\b/g, 'w1111111111111-99')))
  },
  {
    id: 'a-number-changed',
    expect: 'green',
    what:
      "the configure block's `priority:      1` changed to `9`. GREEN BY DESIGN, and this is " +
      'the widest rule in the mask: `<NUM>` swallows every bare number, so a page stating a ' +
      'priority, a count or a size the program never printed passes. This check is about lines, ' +
      'not values; nothing here covers values.',
    page: (md) =>
      editSegment(md, WALK, 0, CONFIGURE, rewordLine('priority:      1', 'priority:      1', 'priority:      9'))
  }
];

// ---------------------------------------------------------------------------
rule('3. The detector is a measurement, not a constant');
// ---------------------------------------------------------------------------

for (const canary of CANARIES) {
  const page = canary.page(readme);
  if (!check(page !== null, `canary '${canary.id}' could be applied to the page`,
    page === null ? 'the line or block it edits is gone — the canary is stale, not the page' : '')) {
    continue;
  }
  const report = auditPage(page, captures);
  const clean = reportIsClean(report);
  const got = clean ? 'green' : 'red';
  check(got === canary.expect,
    `canary '${canary.id}' is ${canary.expect.toUpperCase()} — ${canary.what.replace(/\s+/g, ' ')}`,
    got === canary.expect ? '' : `this check went ${got.toUpperCase()}`);
  if (canary.expect === 'red' && !clean) {
    const found = report.flatMap((r) => r.missing).length;
    console.log(`          reported ${found} line(s) the page no longer shows`);
  }
}

// ---------------------------------------------------------------------------
rule('4. The page’s own history: red where it really had drifted');
// ---------------------------------------------------------------------------

/**
 * AC 2 asks for the check to be watched going red against a page that was
 * really stale. Two such pages are in this repository's history and neither is
 * synthetic:
 *
 *   72db4cd  the last README before KAN-139 re-ran the walkthrough
 *   e7ffb58  the last README before KAN-174 re-ran the four other blocks
 *
 * Wired in rather than pasted into a pull request once, because a red run
 * nobody can re-run is a claim rather than a check. The direction matters as
 * much as the redness: e7ffb58's WALKTHROUGH is expected green, because
 * KAN-139 had already fixed it. A detector that reported every older page as
 * red would be measuring the calendar.
 *
 * THE KIND OF RED IS ASSERTED, NOT JUST THE REDNESS. There are two, and they
 * are not equally strong evidence:
 *
 *   'lines'    — the page shows this command and does NOT show lines the
 *                program prints under it. This is the drift the ticket is
 *                about, and the only kind that demonstrates the comparison
 *                working.
 *   'commands' — the page's block runs different commands entirely, which at
 *                e7ffb58 is true of two blocks because KAN-174 recaptured them
 *                in new demo directories. That is a real difference and a weak
 *                demonstration: any path change produces it. Asserted by name
 *                so it cannot be read as the strong kind.
 */
const HISTORY = [
  {
    rev: '72db4cd',
    note: 'before KAN-139 re-ran the walkthrough (PR #36, measuring differently, counted 78)',
    expect: [{ id: 'walkthrough', kind: 'lines' }],
    green: []
  },
  {
    rev: 'e7ffb58',
    note: 'before KAN-174 re-ran the blocks outside the walkthrough (PR #39)',
    expect: [
      { id: 'occupied-directory', kind: 'lines' },
      { id: 'idempotent-activate', kind: 'commands' },
      { id: 'capacity-refusal', kind: 'commands' }
    ],
    green: ['walkthrough']
  }
];

for (const h of HISTORY) {
  const show = spawnSync('git', ['show', `${h.rev}:README.md`], {
    cwd: repoRoot, encoding: 'utf8'
  });
  // NOT RUN is a failure, not a pass. A shallow clone that cannot reach these
  // revisions has not demonstrated anything, and saying so is the difference
  // between the demonstration happening and it being announced as absent.
  if (!check(show.status === 0 && show.stdout.length > 0,
    `${h.rev} README.md is reachable`,
    show.status === 0 ? '' : 'NOT RUN — git could not read that revision (a shallow clone?)')) {
    continue;
  }
  const report = auditPage(show.stdout, captures);
  const byId = new Map(report.map((r) => [r.scenario, r]));
  const dirty = (id) => {
    const r = byId.get(id);
    return Boolean(r && (r.blockMissing || r.missing.length || r.unmatched.length));
  };
  console.log(`\n  ${h.rev} — ${h.note}`);
  for (const { id, kind } of h.expect) {
    const r = byId.get(id);
    const got = !r ? 'none' : r.missing.length ? 'lines' : r.unmatched.length || r.blockMissing ? 'commands' : 'none';
    check(got === kind,
      `${h.rev}: '${id}' is RED, and red of the '${kind}' kind`,
      got === kind
        ? kind === 'lines'
          ? `${r.missing.length} line(s) the program printed that page did not show`
          : `${r.unmatched.length} command(s) that page does not run at all`
        : `expected '${kind}', got '${got}'`);
  }
  for (const id of h.green) {
    check(!dirty(id), `${h.rev}: '${id}' is GREEN — it had already been fixed`,
      dirty(id) ? 'went red, so this check is measuring age rather than drift' : '');
  }
  console.log('');
  printReport(report.filter((r) => h.expect.some((e) => e.id === r.scenario)), { limit: 6 });
}

// ---------------------------------------------------------------------------
rule('5. The option this ticket asked to be compared against, built and run');
// ---------------------------------------------------------------------------

/**
 * Option 3 from KAN-175: assert the renderers' emitted LABELS are a subset of
 * the README's text, with no session and no per-command scoping. It is the
 * cheapest of the three and it is the one that would not have caught the
 * defect this ticket exists for.
 */
function flatInventoryCheck(markdown, allCaptures) {
  const page = markdown.split('\n').map(maskLine);
  const pageSet = new Set(page);
  const missing = [];
  for (const [id, commands] of Object.entries(allCaptures)) {
    for (const c of commands) {
      if (c.recipeOnly) continue;
      for (const line of c.output) {
        if (line.trim() === '') continue;
        const shape = maskLine(line);
        const anywhere =
          pageSet.has(shape) || page.some((p) => shapesMatch(shape, p));
        if (!anywhere) missing.push({ scenario: id, line });
      }
    }
  }
  return missing;
}

// KAN-139's real drift, reproduced on one block only: the five lines KAN-125
// added arrived in `list`'s rows AND in `status`, so a page updated for one and
// not the other still contains every one of them somewhere.
const KAN125_LINES = [
  'config v1 frozen',
  'prompt: 250 characters',
  'label: the notes agent',
  'next activate: RESUMES',
  'activated by: none'
];
let staled = readme;
for (const needle of KAN125_LINES) {
  const next = editSegment(staled, WALK, 0, STATUS, dropLine(needle));
  if (next !== null) staled = next;
}

const flatOnCurrent = flatInventoryCheck(readme, captures);
check(flatOnCurrent.length === 0,
  'the flat inventory check agrees with this one on the CURRENT page (both green)',
  flatOnCurrent.length ? `${flatOnCurrent.length} line(s) it could not find anywhere` : '');

const flatOnStaled = flatInventoryCheck(staled, captures);
const thisOnStaled = auditPage(staled, captures);
check(flatOnStaled.length === 0,
  "option 3 is GREEN on a page whose `status` block lost KAN-125's five lines",
  `it found ${flatOnStaled.length} missing — every one of them is still on the page, under \`list\``);
check(!reportIsClean(thisOnStaled),
  'and this check is RED on the same page',
  `${thisOnStaled.flatMap((r) => r.missing).length} line(s) missing from the block that has to show them`);
console.log('');
printReport(thisOnStaled.filter((r) => r.missing.length), { limit: 6 });
console.log(
  '\n  That is the reason for the shape chosen, as a measurement rather than an opinion:\n' +
  '  the cheapest option is green on the exact drift this ticket was filed for.\n'
);

// ---------------------------------------------------------------------------
rule('6. The mask register — every rule, and what it costs');
// ---------------------------------------------------------------------------

console.log(
  '  Each rule below removes something two runs of the same command cannot share.\n' +
  '  Each one is therefore a class of defect this check is blind to, named here so\n' +
  '  the blindness is on the record rather than in the regexes.\n'
);
for (const m of MASKS) {
  console.log(`  <${m.id}>  ${String(m.re)}`);
  console.log(`    why:   ${m.why.replace(/\s+/g, ' ')}`);
  console.log(`    costs: ${m.costs.replace(/\s+/g, ' ')}\n`);
}
console.log('  Declared variants — one line, two shapes, chosen by the machine:\n');
for (const v of VARIANTS) {
  console.log(`    ${v.shapes.map((s) => (typeof s === 'string' ? JSON.stringify(s) : String(s))).join('  |  ')}`);
  console.log(`      ${v.why.replace(/\s+/g, ' ')}\n`);
}

// ---------------------------------------------------------------------------

console.log('='.repeat(78));
console.log(
  failures
    ? `\n${failures} CHECK(S) FAILED`
    : '\nALL CHECKS PASSED — every line the six covered blocks’ commands printed is on the page,\n' +
      'and the check that says so has been shown able to say otherwise.'
);
console.log(
  '\nRemember what a green run does NOT say: that the pasted sessions are real, that the\n' +
  'page’s prose is true, or anything at all about the seven blocks in the UNCOVERED\n' +
  'register above.\n'
);
process.exit(failures ? 1 : 0);
