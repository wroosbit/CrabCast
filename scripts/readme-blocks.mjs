// The README's program-output blocks, and the mask that makes two runs of the
// same command comparable. Shared by the two scripts that check the page.
//
// WHY THIS FILE EXISTS (KAN-180). It used to live entirely inside
// scripts/verify-readme-is-current.mjs, which was right while that script was
// the only thing that read the page. It is not any more: KAN-180 put the
// assertion for the `build`/`freshness` block into
// scripts/verify-daemon-provenance.mjs §3b, where the state that block
// describes already exists — a daemon that predates its own build — rather than
// paying a second time to construct it.
//
// So two scripts now compare captured output against pasted output, and the
// alternative to this module is TWO COPIES OF THE MASK. That is the defect this
// epic keeps re-finding, and it is worth being explicit about the shape it would
// take here: a mask is a list of things the check is deliberately blind to, and
// a second copy free to drift from the first would mean the two scripts were
// blind to different things while both reporting "the README is current". The
// register printed by verify-readme-is-current.mjs §6 would be describing one
// copy and silently not the other.
//
// NOTHING HERE RUNS ANYTHING. It is parsing and comparison only — no daemon, no
// filesystem beyond the caller's own read of README.md — which is what lets
// verify-daemon-provenance.mjs import it without inheriting a second script's
// worth of setup. That is also why the extraction is this module rather than a
// guarded `main` inside verify-readme-is-current.mjs: importing that file would
// run six scenarios and a fleet of daemons as a side effect of wanting one regex.

// ===========================================================================
// The page, parsed.
// ===========================================================================

/** Every fenced block in a markdown document, with the heading it sits under. */
export function fencedBlocks(markdown) {
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
export const isProgramOutput = (block) =>
  block.body.some((l) => /^\$ (crabcast|herdr|export )/.test(l) || /^crabcast: /.test(l)) ||
  block.body.some((l) => BUILD_BLOCK_FIRST_LINE.test(l));

/**
 * A block split into `$ command` / output pairs. Lines before the first
 * command belong to no command and are returned under a null command, which
 * is how the freshness block (all output, no prompt) is still addressable.
 */
export function segmentsOf(body) {
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

/**
 * Locate a block on a page by the heading it sits under and its position.
 *
 * `index` is the nth fenced block under that heading, counting only blocks of
 * program output — so an install snippet appearing under the same heading does
 * not shift the numbering.
 */
export function blockFor(blocks, heading, index) {
  const under = blocks.filter((b) => b.heading === heading && isProgramOutput(b));
  return under[index] ?? null;
}

/** The line that opens the `daemon-status` build block, wherever it is pasted. */
export const BUILD_BLOCK_FIRST_LINE = /^build — what THIS process was loaded from/;

/**
 * The README's `build`/`freshness` block, found BY CONTENT rather than by
 * heading and index — or `null` if the page has no such block.
 *
 * NOT `blockFor('### Which build is running', 1)`, and the difference is load
 * bearing rather than stylistic. That block's index under its heading is a fact
 * about the REST of the page: today a recipe block sits above it and it is #1,
 * at e7ffb58 there was no recipe and the same block was #0, and a future edit
 * that adds or removes a sibling moves it again. verify-daemon-provenance.mjs
 * §3b audits historical revisions of this page on purpose, so an index would
 * make it silently compare the wrong block — or find none — on precisely the
 * revisions the demonstration depends on.
 *
 * Ambiguity is an error rather than a first-match, because two such blocks would
 * mean the page grew a second one and the caller would be asserting against
 * whichever happened to be first.
 */
export function buildFreshnessBlock(markdown) {
  const found = fencedBlocks(markdown).filter((b) => b.body.some((l) => BUILD_BLOCK_FIRST_LINE.test(l)));
  if (found.length === 1) return found[0];
  if (found.length === 0) return null;
  throw new Error(
    `the page has ${found.length} blocks opening with \`build — what THIS process was loaded ` +
    `from\` (README.md lines ${found.map((b) => b.start).join(', ')}). buildFreshnessBlock ` +
    `identifies THE build/freshness block by that line, so a second one makes the identification ` +
    `ambiguous — name them by heading and index instead, and update §3b to say which it means.`
  );
}

// ===========================================================================
// The mask. Every rule is a value that MUST differ between two runs, and each
// one is a hole in what the checks can see — verify-readme-is-current.mjs §6
// prints the register.
// ===========================================================================

export const MASKS = [
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
    id: 'SHA',
    re: /\b[0-9a-f]{40}\b/g,
    to: '<SHA>',
    why: 'a git commit id (KAN-180). The build block names the commit its build was made from, and verify-daemon-provenance §3b captures it from a fixture repository committed fresh on every run — so it cannot be the commit the page was captured at, and never will be.',
    costs: 'the `commit:` line is checked for SHAPE and not for value: a build block naming a commit that is not the one the build was made from reads the same as a correct one. What the commit means is verify-daemon-provenance §1\'s, which compares the stamp against `git rev-parse HEAD` in the fixture; this mask is why that assertion has to live there and not here.'
  },
  {
    id: 'ID',
    re: /\b[0-9a-f]{16}\b/g,
    to: '<ID>',
    why: "the 16-hex digest `identity.ts` derives a pane name from. It is a function of the directory, and this check's directory is a scratch one.",
    costs: 'two different agents’ pane names are indistinguishable after masking, so a row attributed to the wrong agent still passes.'
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
    id: 'SOURCEFILE',
    re: /\([\w.-]+\.ts\)/g,
    to: '(<SOURCEFILE>)',
    why: 'the basename the freshness block names as the newest file in `src/` (KAN-180). Which file that is depends on what was edited last, and in verify-daemon-provenance’s fixture every source shares one pinned mtime, so the winner among equals is whatever the filesystem enumerated first.',
    costs: 'the `newest source:` line is checked for shape and not for which file it names — a freshness report blaming the wrong source file would pass. Nothing covers that; it is a value, and this is a check about lines.'
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

export const maskLine = (line) => MASKS.reduce((s, m) => s.replace(m.re, m.to), line);

/**
 * Lines that legitimately have two shapes, because the branch taken depends on
 * the machine rather than on the code. A captured line matches the page when
 * the page shows EITHER member of its group.
 */
export const VARIANTS = [
  {
    why: 'the agent-cost provenance line. With no live measurement the renderer prints the seed disclaimer; once the daemon’s 60s sampler has fired it prints the measurement instead. A run slow enough to cross that boundary must not turn red.',
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
export function shapesMatch(captured, pageShape) {
  if (captured === pageShape) return true;
  for (const group of VARIANTS) {
    const hit = (s) => group.shapes.some((m) => (typeof m === 'string' ? m === s : m.test(s)));
    if (hit(captured) && hit(pageShape)) return true;
  }
  return false;
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
export function compareSegment(captured, pasted) {
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
