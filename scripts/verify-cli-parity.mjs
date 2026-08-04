#!/usr/bin/env node
// Live proof for KAN-94 / KAN-92 AC 1: the CLI covers the daemon's socket API,
// and the next action added to the router cannot ship without either a command
// or a recorded reason for not having one.
//
// The point of this script is that it does NOT hold a hand-copied list of
// actions. A hand-copied list is exactly the failure it exists to prevent: it
// agrees with the CLI forever, including on the day somebody adds an action to
// the router and forgets the command. So the action set is re-derived from
// `src/router.ts` on every run, and the only lists written down here are the
// two things a machine genuinely cannot derive — which actions are absent on
// purpose, and why.
//
// Needs no daemon, no herdr and no network: it reads source and (once the CLI
// exists) imports the built command table. Exits non-zero on any failure so a
// reviewer can re-run it against the PR head.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routerTs = path.join(repoRoot, 'src', 'router.ts');
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * Actions the CLI deliberately does not wrap, each with the reason a future
 * reader needs — not a list of names, because a name alone answers "is this
 * known?" and the question a reader actually arrives with is "why isn't there
 * a command for this?".
 *
 * Adding a name here is the escape hatch from the parity rule, so it is meant
 * to cost something: the reason is reviewed like code, and an entry naming an
 * action the router no longer dispatches fails this check rather than sitting
 * here rotting (see section 2).
 */
const EXCLUSIONS = [
  {
    action: 'pty_init',
    reason:
      'Terminal attach. CrabCast is a management layer and never embeds a terminal — a ' +
      'settled product boundary, not a deferral (KAN-59 decision 4, KAN-92 constraint 6). ' +
      '`tail` is how the CLI reads a pane; it does not stream one.',
    evidence: 'src/router.ts:2416 handlePtyInit registers a data listener that streams pty_output frames'
  },
  {
    action: 'pty_input',
    reason:
      'Terminal attach, write half. Same boundary as pty_init: keystrokes into a live PTY are ' +
      'an embedded terminal by another name. The CLI steers agents with `send`, which the daemon ' +
      'delivers as a whole message, not as a keystroke stream.',
    evidence: 'src/router.ts:2455 handlePtyInput writes raw data to a PTY by session id'
  },
  {
    action: 'pty_resize',
    reason:
      'Terminal attach, geometry half. Only meaningful to a client that is drawing the PTY, ' +
      'which by the boundary above CrabCast never is.',
    evidence: 'src/router.ts:2472 handlePtyResize sets cols/rows on a PTY by session id'
  },
  {
    action: 'deactivate',
    reason:
      'Session-addressed stand-down. Addressing in this system is the canonical path of the ' +
      'directory an agent runs in; a sessionId is transport-internal — it is minted by the daemon ' +
      'that holds the attach and dies with it. The path-addressed form is the human-facing one and ' +
      'is a strict superset: it resolves through the session map when there is one, falls back to ' +
      "herdr's pane when there is not, and still records the stand-down for an agent that has " +
      'already died. The session form can address none of those. Concretely, every agent that ' +
      'outlived a daemon restart is reported with sessionId: null, so a ' +
      '`crabcast deactivate --session <id>` would be unusable in precisely the case a human most ' +
      'often needs it. It also cannot answer the state question the path form does — unstarted vs ' +
      'standby — because a configured-but-never-run agent has no session to name. The MCP server, ' +
      'the only other client of this socket, uses deactivate_agent.',
    evidence:
      'src/router.ts:1582 handleDeactivateSession requires data.sessionId and looks up the session ' +
      'map only; src/router.ts:1644 handleDeactivateAgent resolves by canonical path, falls back to ' +
      'closeAgentByPath and to the registry for a dead agent; src/router.ts:2228 sessionless rows ' +
      'carry sessionId: null; src/mcp.ts:423 crabcast_deactivate_agent calls deactivate_agent'
  }
];

// ---------------------------------------------------------------------------
// 1. Enumerate the router's dispatch, mechanically, from source.
// ---------------------------------------------------------------------------

/** Skip a '…' or "…" literal; returns the index just past the closing quote. */
function skipQuoted(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error(`unterminated ${quote} literal at offset ${i}`);
}

/**
 * Skip a `…` template literal, including any `${ … }` substitutions, which may
 * themselves contain braces and nested literals. The router's default case
 * holds one (`Unknown action: ${…}`), and a scanner that counted its braces as
 * block structure would lose the end of the switch.
 */
function skipTemplate(src, i) {
  i += 1; // past the opening backtick
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1);
      continue;
    }
    i += 1;
  }
  throw new Error('unterminated template literal');
}

/** Skip a brace-balanced region starting at the '{' at `i`. */
function skipBalanced(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated block comment'); i = e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  throw new Error('unbalanced braces');
}

const CASE_RE = /^case\s+(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*:/;

/**
 * Read `case '<action>':` labels from the body of the router's action switch.
 *
 * Labels are collected only at the switch's own nesting level, so a `case` in
 * a nested switch inside a handler could never be mistaken for an action, and
 * the closing brace is found by balancing rather than by pattern — a truncated
 * read would end without ever seeing `default:`, which section 1 asserts.
 */
function readDispatch(src, bodyOpenIdx) {
  let i = bodyOpenIdx + 1;
  let depth = 0;
  const actions = [];
  let sawDefault = false;
  // Each label closes the previous one's body, so section 4 can read a single
  // case's code without re-parsing or guessing where it ends.
  const closeBody = (at) => {
    if (actions.length) actions[actions.length - 1].bodyEnd ??= at;
  };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated block comment'); i = e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') {
      if (depth === 0) { closeBody(i); return { actions, sawDefault }; }
      depth -= 1; i += 1; continue;
    }
    // Word-boundary guard: only try the label patterns at the start of an
    // identifier, so `case` inside `lowercase:` can never match.
    if (depth === 0 && (c === 'c' || c === 'd') && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? ' ')) {
      const rest = src.slice(i, i + 64);
      const m = CASE_RE.exec(rest);
      if (m) {
        closeBody(i);
        actions.push({
          action: m[2],
          line: src.slice(0, i).split('\n').length,
          bodyStart: i + m[0].length,
          bodyEnd: undefined
        });
        i += m[0].length;
        continue;
      }
      if (/^default\s*:/.test(rest)) {
        closeBody(i);
        sawDefault = true;
        i += rest.indexOf(':') + 1;
        continue;
      }
    }
    i += 1;
  }
  throw new Error('switch body was not terminated');
}

/**
 * The source of one `case` arm, for section 4.
 *
 * Answers null when the arm does not reply inline — a `case` that delegates to
 * a handler puts its `action:` (or its absence) somewhere this cannot see, and
 * "I could not find one here" must not read as "there is none".
 */
function caseBodyFor(dispatch, action) {
  const arm = dispatch.find((d) => d.action === action);
  if (!arm || arm.bodyEnd === undefined) return null;
  const body = source.slice(arm.bodyStart, arm.bodyEnd);
  return /\brespond\s*\(\s*\{/.test(body) ? body : null;
}

console.log('=== 1. The router\'s dispatch, read from src/router.ts ===');

const source = fs.readFileSync(routerTs, 'utf8');
const SWITCH_RE = /switch\s*\(\s*data\.action\s*\)\s*\{/g;
const switchMatches = [...source.matchAll(SWITCH_RE)];

check(
  switchMatches.length === 1,
  'src/router.ts dispatches actions from exactly one `switch (data.action)`',
  `found ${switchMatches.length}`
);

let dispatched = [];
if (switchMatches.length === 1) {
  const openIdx = switchMatches[0].index + switchMatches[0][0].length - 1;
  const switchLine = source.slice(0, switchMatches[0].index).split('\n').length;
  const read = readDispatch(source, openIdx);
  dispatched = read.actions;

  // The whole switch, not a prefix of it: a read that stopped early would take
  // its missing actions with it and report an all-clear over the remainder.
  check(read.sawDefault, 'read the whole switch — its `default:` (unknown-action) arm was reached');
  check(dispatched.length > 0, 'the dispatch is non-empty', `${dispatched.length} action(s)`);

  const names = dispatched.map((d) => d.action);
  check(new Set(names).size === names.length, 'no action is dispatched twice');

  console.log(`\n  switch (data.action) at src/router.ts:${switchLine} — ${dispatched.length} action(s):`);
  for (const d of dispatched) console.log(`    router.ts:${d.line}  ${d.action}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 2. The exclusion register, checked against what the router actually serves.
// ---------------------------------------------------------------------------

console.log('=== 2. Recorded exclusions ===\n');

const dispatchedNames = new Set(dispatched.map((d) => d.action));
const excludedNames = new Set(EXCLUSIONS.map((e) => e.action));

check(
  excludedNames.size === EXCLUSIONS.length,
  'no action is excluded twice'
);

for (const e of EXCLUSIONS) {
  // An exclusion for an action the router no longer dispatches is stale, and
  // stale is not harmless: it is a reason nobody re-reads, standing next to
  // reasons that are still load-bearing. It fails here so the register stays
  // an account of the current dispatch rather than an archive.
  check(
    dispatchedNames.has(e.action),
    `excluded action '${e.action}' is still dispatched by the router`,
    dispatchedNames.has(e.action) ? '' : 'stale entry — remove it, or the router lost an action'
  );
  check(
    typeof e.reason === 'string' && e.reason.trim().length >= 40,
    `excluded action '${e.action}' carries a reason, not just a name`
  );
  check(
    typeof e.evidence === 'string' && /router\.ts:\d+|mcp\.ts:\d+/.test(e.evidence),
    `excluded action '${e.action}' cites the source its reason rests on`
  );
}

console.log('');
for (const e of EXCLUSIONS) {
  console.log(`  ${e.action}`);
  console.log(`    why:      ${e.reason.replace(/\s+/g, ' ')}`);
  console.log(`    evidence: ${e.evidence.replace(/\s+/g, ' ')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 3. Command coverage: every dispatched action is a CLI command or excluded.
// ---------------------------------------------------------------------------

console.log('=== 3. Command coverage ===\n');

// A missing build is a hard failure, not a skip. Everything below rests on the
// built table; skipping it would leave sections 1 and 2 printing PASS lines
// under a heading that promised coverage, which is the same all-clear-over-a-
// check-that-never-ran this script exists to make impossible.
if (!fs.existsSync(cliJs)) {
  console.error(
    'FAIL  dist/cli.js not found — run `npm run build` first. This check compares the router\n' +
    '      against the BUILT command table; it will not report on coverage it did not measure.'
  );
  process.exit(1);
}

const { COMMANDS } = await import(cliJs);
check(Array.isArray(COMMANDS) && COMMANDS.length > 0, 'dist/cli.js exports a non-empty COMMANDS table');

const byAction = new Map();
for (const c of COMMANDS ?? []) {
  if (!byAction.has(c.action)) byAction.set(c.action, []);
  byAction.get(c.action).push(c.name);
}

const coverage = [];
for (const d of dispatched) {
  const commands = byAction.get(d.action);
  const excluded = excludedNames.has(d.action);
  coverage.push({ action: d.action, commands, excluded });
  check(
    Boolean(commands) || excluded,
    `action '${d.action}' is covered`,
    commands
      ? `command: ${commands.map((n) => `crabcast ${n}`).join(', ')}`
      : excluded
        ? 'excluded, with a recorded reason'
        : 'NO CLI command and NO recorded exclusion — add one or the other'
  );
  // Both at once means the two halves of this register disagree about the same
  // action. Whichever is wrong, nobody can read it and come away right.
  check(
    !(commands && excluded),
    `action '${d.action}' is not both a command and an exclusion`
  );
}

// A command aimed at an action the router does not serve fails at runtime with
// the router's "Unknown action", in front of a user, and no amount of green
// elsewhere would have caught it.
for (const c of COMMANDS ?? []) {
  check(
    dispatchedNames.has(c.action),
    `command 'crabcast ${c.name}' targets an action the router dispatches`,
    dispatchedNames.has(c.action) ? c.action : `'${c.action}' is NOT in the dispatch`
  );
}

// ---------------------------------------------------------------------------
// 4. `responseAction` against the router, because the client correlates by id.
//
// KAN-93 records what each reply is labelled with but does not key on it — the
// client correlates by `id`, precisely because daemon_status answers with no
// `action` at all. Recorded-but-unused is exactly the field that rots, so it is
// checked here against the source rather than believed.
// ---------------------------------------------------------------------------

console.log('\n=== 4. Reply labels, checked against the router ===\n');

for (const c of COMMANDS ?? []) {
  if (!dispatchedNames.has(c.action)) continue; // already failed above
  if (c.responseAction === null || c.responseAction === undefined) {
    // The claim is that the handler sets no `action` on its reply. Verified
    // against the case body rather than assumed: this is the one shape in the
    // API that a client keyed on action names would hang on forever, so a
    // command that recorded it wrongly would be a hang waiting to happen.
    const body = caseBodyFor(dispatched, c.action);
    check(
      body !== null && !/\baction:/.test(body),
      `'${c.action}' really does reply without an action field — 'crabcast ${c.name}' records null`,
      body === null
        ? 'this arm does not reply inline, so the claim cannot be checked here — verify it by hand or record the label'
        : ''
    );
  } else {
    check(
      typeof c.responseAction === 'string' &&
        source.includes(`action: '${c.responseAction}'`),
      `'crabcast ${c.name}' records reply label '${c.responseAction}', which router.ts sends`
    );
  }
}

// ---------------------------------------------------------------------------
// 5. The source tree holds nothing the compiler cannot see.
//
// This section exists because a stale copy of `src/router.ts` shipped in a
// commit under the name `src/.ts` — a file whose entire name is the extension
// — and all three required checks went green over it.
//
// Nothing here was careless twice: `tsconfig.json` has `"include": ["src"]`,
// and TypeScript's wildcard expansion SKIPS dot-prefixed files. So the file
// was never compiled, never imported, and never rendered by `ls`. What it did
// do is answer every future grep, code search and reader with a 2,586-line
// near-copy of this daemon's largest file, 23 lines out of date on the
// ownership test — which is how it was found.
//
// The lesson is the one this suite keeps relearning: a check that cannot fail
// is not a check. The compiler's blindness here is deliberate and correct for
// its own job, so the audit belongs somewhere that looks at the tree rather
// than at the build — and this script is already the one that reads `src/`
// mechanically and starts nothing.
// ---------------------------------------------------------------------------

console.log('\n=== 5. Nothing in src/ is invisible to the compiler ===\n');

const gitFiles = execFileSync('git', ['ls-files', 'src', 'scripts'], {
  cwd: repoRoot,
  encoding: 'utf8'
}).split('\n').filter(Boolean);

const invisible = gitFiles.filter((f) => path.basename(f).startsWith('.'));
const wrongExt = gitFiles.filter((f) => {
  const b = path.basename(f);
  if (b.startsWith('.')) return false;              // reported above
  if (f.startsWith('src/')) return !b.endsWith('.ts');
  return !b.endsWith('.mjs');
});

console.log(`  tracked under src/ and scripts/: ${gitFiles.length} file(s)`);
check(
  invisible.length === 0,
  'no tracked file under src/ or scripts/ has a dot-prefixed name',
  invisible.length
    ? `INVISIBLE TO tsc AND TO \`ls\`: ${invisible.join(', ')} — a wildcard include skips ` +
      `these, so nothing compiles or lints them`
    : ''
);
check(
  wrongExt.length === 0,
  'every tracked file has the extension its directory expects (src/*.ts, scripts/*.mjs)',
  wrongExt.length ? wrongExt.join(', ') : ''
);

// And the compiler really does see every source file, rather than this being
// an argument about wildcards: compare what git tracks against what tsc emits.
const distDir = path.join(repoRoot, 'dist');
if (fs.existsSync(distDir)) {
  const emitted = new Set(
    fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))
  );
  const unemitted = gitFiles
    .filter((f) => f.startsWith('src/') && f.endsWith('.ts'))
    .map((f) => path.basename(f, '.ts'))
    .filter((name) => !emitted.has(name));
  check(
    unemitted.length === 0,
    'and every tracked src/*.ts was actually emitted to dist/ — measured, not assumed',
    unemitted.length ? `never compiled: ${unemitted.join(', ')}` : `${emitted.size} module(s)`
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== The parity table ===\n');
const w = Math.max(...coverage.map((c) => c.action.length));
for (const c of coverage) {
  console.log(
    `  ${c.action.padEnd(w)}  ${
      c.commands
        ? `crabcast ${c.commands.join(', ')}`
        : c.excluded
          ? 'EXCLUDED — see section 2 for the reason'
          : 'UNCOVERED'
    }`
  );
}
console.log(
  `\n  ${dispatched.length} action(s): ${coverage.filter((c) => c.commands).length} with a command, ` +
    `${coverage.filter((c) => !c.commands && c.excluded).length} excluded with a recorded reason, ` +
    `${coverage.filter((c) => !c.commands && !c.excluded).length} unaccounted for.`
);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
