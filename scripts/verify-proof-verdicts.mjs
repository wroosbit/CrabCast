// KAN-206: every tracked proof must have a verdict, and something able to reach it.
//
// WHAT FAILURE THIS WOULD CATCH: a `scripts/verify-*.mjs` that cannot report
// failure — no verdict-derived exit at all, only setup guards, or a verdict
// whose counter nothing in the file can ever make non-zero. KAN-197 is the
// concrete case: `verify-spawn-failure-legibility.mjs` was 136 lines with zero
// assertions ending `process.exit(0)`. It was in the `scripts=(` array. It was
// in the proof registry. It was green. It proved nothing for as long as it
// existed, and nothing in this repository noticed.
//
// TWO PROPERTIES, BOTH MECHANICAL (§3 and §4)
//
//   1. An exit whose value comes from an accumulated verdict —
//      `process.exit(failures ? 1 : 0)`, `if (failures) process.exit(1)`, or a
//      `process.exitCode` set from a check. A literal `process.exit(1)`
//      guarding "dist/daemon.js not found" is a SETUP GUARD, not a verdict.
//   2. At least one call site that can produce a FAIL. A verdict-shaped exit is
//      not yet a reachable one: `let failures = 0; … exit(failures ? 1 : 0)`
//      satisfies property 1 completely while nothing increments `failures`, and
//      so does a `check()` helper that is defined and never called. Both are
//      scripts that print their own success and exit 0 forever.
//
// WHY IT DOES NOT GREP FOR `check(`
//
// This suite's verdict helpers disagree with each other. `verify-restart-
// survival.mjs:107` is `check(name, ok, detail)`; `verify-spawn-failure-
// legibility.mjs:127` is `check(ok, claim, whenFalse, whenTrue)` — the same
// name with the arguments in the opposite order — and `verify-agent-capacity`
// uses `verdict(ok, yes, no)` instead. A detector keyed to a name or a
// signature is wrong here on day one, and its wrongness is SILENT: a detector
// that recognises nothing reports the same all-clear as one that recognises
// everything, because every script trivially has "no unreached helper".
//
// So helpers are found by WHAT THEIR BODIES MUTATE. §4 walks back from each
// verdict exit, through the declarations feeding it, to the accumulator
// underneath; finds the places that make that accumulator negative; and where
// such a place sits inside a named function, counts that function's CALL SITES
// rather than its body. A helper nobody calls contributes nothing. Argument
// order never enters into it.
//
// Three guards on the detector, none of them optional:
//
//   (a) It FAILS CLOSED. Zero recognised sites in a file is a failure, never a
//       skip. The bug class being hunted is "the thing that silently reports
//       nothing", so a detector that silently reports nothing has become the
//       bug it is looking for.
//   (b) It SELF-TESTS BEFORE IT SWEEPS (§2), against fixtures that must be
//       accepted and fixtures that must be rejected — the second kind is the
//       one that matters.
//   (c) §5 asserts the detector matched something across the real tree, the way
//       `verify-proof-defences` §2 asserts its helper detector does.
//
// Three of §2's fixtures exist because this detector was wrong first, each time
// with entirely convincing output: masking that mishandled `${…}` nested inside
// a template literal blanked the remainder of every file and found ZERO helpers
// across the whole suite; a regex assembled by string concatenation ended in a
// trailing `|`, whose empty alternative matches every line, and found 141 sites
// in one 600-line script; and a destructured parameter default
// (`function f({ activated = [] })`) read as a mutation made every call to the
// enclosing function a FAIL site. None of the three looked wrong in the output.
//
// WHAT THIS DOES NOT PROVE — the seam, stated here because a reader who
// conflates the two will trust this proof for something it never checked
//
// This establishes that a script CAN report failure. It says NOTHING about
// whether that script's assertions can ever be FALSE. `check(true, …)` is a
// call site by every measure applied here, and a suite of them would pass §4
// completely while asserting nothing. "Every proof can fail" is true and useful
// and will be misread as "every proof is checking something".
//
// The question one level down — what defends each proof's central assertion —
// is `verify-proof-defences`'s, and it is answered by mutating the behaviour
// under test and watching the proof go red. These two proofs are adjacent and
// they DO NOT COVER EACH OTHER. The gap between two honest mechanisms is where
// this epic keeps finding defects; this paragraph is the edge of mine.
//
// WHY THIS IS NOT IN THE `scripts=(` ARRAY (see §6)
//
// The array is not merely where this script would sit — it is part of this
// script's SUBJECT. A sweep asserting that every proof has a reachable verdict,
// listed in the array it audits, can be removed by the very edit it exists to
// catch, and the tree would go green with nothing watching. That is
// `verify-proof-registry` §4's argument, and it applies here more directly than
// it does there. This runs from its own required CI job instead, and is
// recorded in that script's EXCLUSIONS register with this reason.
//
// Usage: node scripts/verify-proof-verdicts.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeMutator } from './mutation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

// ===========================================================================
// THE DETECTOR
// ===========================================================================

/**
 * Blank out comments and the CONTENTS of strings and template literals, so that
 * brace depth, `;` and identifiers mean what they say.
 *
 * The `${…}` handling is the part that matters. An interpolation returns to
 * code — with its own brace depth, so the `}` closing it is the one seen at
 * depth 0 — and that `}` returns to template text. Getting this wrong raises no
 * error: the unclosed backtick swallows the rest of the file, every identifier
 * disappears, and the sweep reports that no proof in the suite has a helper.
 * Fixture `mask-survives-interpolation` in §2 exists for exactly that hour.
 */
function codeMask(src) {
  const n = src.length;
  const out = new Array(n);
  const blank = (i) => { out[i] = src[i] === '\n' ? '\n' : ' '; };

  const interps = [];
  let mode = 'code';
  let i = 0;
  // The last significant code character, and the last identifier, so that `/`
  // can be told apart from division. `x` stands in for "a value ended here"
  // after a string, template or regex, because a `/` after a value is division.
  let lastSig = '';
  let lastWord = '';
  const REGEX_MAY_FOLLOW = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do',
    'else', 'yield', 'await', 'instanceof'
  ]);
  const startsRegex = () =>
    lastSig === '' ||
    '(,=:[!&|?{};+-*%~^<>'.includes(lastSig) ||
    REGEX_MAY_FOLLOW.has(lastWord);

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
      if (c === '/' && d === '*') {
        blank(i++); blank(i++);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
        if (i < n) { blank(i++); blank(i++); }
        continue;
      }
      // A REGEX LITERAL, which is not division. Without this the `'` inside a
      // character class such as /['"`][^'"`]*\d+/ opens a string and the mask
      // eats the remainder of the file. Two real proofs in this suite —
      // verify-herdr-version-notice and verify-proof-defences — carry exactly
      // that shape, and both came back as "no verdict exit, traced through
      // nothing" until this branch existed. The seven fixtures in §2 could not
      // have found it: none of them contained a regex literal, and a fixture
      // set cannot notice its own omission (KAN-199 §4d). The real tree did.
      if (c === '/' && startsRegex()) {
        blank(i++);
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') { blank(i++); if (i < n) blank(i++); continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { blank(i++); break; }
          else if (src[i] === '\n') break;
          blank(i++);
        }
        while (i < n && /[a-z]/.test(src[i])) blank(i++);
        lastSig = 'x'; lastWord = '';
        continue;
      }
      if (c === "'" || c === '"') {
        blank(i++);
        while (i < n && src[i] !== c) { if (src[i] === '\\') blank(i++); if (i < n) blank(i++); }
        if (i < n) blank(i++);
        lastSig = 'x'; lastWord = '';
        continue;
      }
      if (c === '`') { blank(i++); mode = 'tpl'; continue; }
      if (c === '{' && interps.length) interps[interps.length - 1].depth++;
      if (c === '}' && interps.length) {
        if (interps[interps.length - 1].depth === 0) { interps.pop(); blank(i++); mode = 'tpl'; continue; }
        interps[interps.length - 1].depth--;
      }
      out[i] = c;
      if (!/\s/.test(c)) {
        lastSig = c;
        lastWord = /[A-Za-z_$0-9]/.test(c) ? lastWord + c : '';
      }
      i++;
      continue;
    }
    if (c === '\\') { blank(i++); if (i < n) blank(i++); continue; }
    if (c === '`') { blank(i++); mode = 'code'; lastSig = 'x'; lastWord = ''; continue; }
    if (c === '$' && d === '{') { blank(i++); blank(i++); interps.push({ depth: 0 }); mode = 'code'; continue; }
    blank(i++);
  }
  return out.join('');
}

const lineAt = (masked, index) => masked.slice(0, index).split('\n').length;

/** Identifiers a proof accumulates failures into. */
const COUNTER = /\b(failures?|failed|problems|errors|violations|leaks|bad)\b/i;

/** Every `process.exit(...)` / `process.exitCode = ...`, read off masked source. */
function exitPaths(masked) {
  const found = [];
  masked.split('\n').forEach((line, i) => {
    const call = line.match(/process\.exit\s*\(([^;]*)\)/);
    if (call) found.push({ line: i + 1, kind: 'exit', expr: call[1].trim() });
    const code = line.match(/process\.exitCode\s*=\s*([^;]+)/);
    if (code) found.push({ line: i + 1, kind: 'exitCode', expr: code[1].trim() });
  });
  return found;
}

/**
 * The condition controlling an exit, when a nearby `if` supplies one.
 * `exit(1)` says nothing alone: `if (failures) process.exit(1)` is a verdict and
 * `if (!fs.existsSync(daemonJs)) process.exit(1)` is a guard, and the whole
 * difference is on the line above.
 */
function controllingCondition(masked, lineNumber) {
  const lines = masked.split('\n');
  for (let i = lineNumber - 1; i >= Math.max(0, lineNumber - 6); i--) {
    const m = lines[i].match(/\bif\s*\((.*)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Verdict, or guard?
 *
 * `process.exit(2)` is this suite's settled spelling for "cannot run at all"
 * (`verify-no-attach-steal`, `verify-pretrust-survives-concurrency`,
 * `verify-tab-per-agent`, `verify-herdr-release`, `verify-spawn-failure-
 * legibility`), so it is never a verdict. A bare `exit(1)` is judged by the
 * condition that reaches it, because that is where the meaning lives.
 */
function classifyExit(entry, masked) {
  const { kind, expr, line } = entry;
  if (kind === 'exit' && /^2$/.test(expr)) {
    return { verdict: false, why: 'exit(2) — the suite\'s setup-guard spelling' };
  }
  const condition = controllingCondition(masked, line);
  if (kind === 'exit' && condition && COUNTER.test(condition)) {
    return { verdict: true, why: `reached only when \`${condition.trim().slice(0, 40)}\`` };
  }
  if (kind === 'exitCode') {
    return {
      verdict: COUNTER.test(expr) || /\?/.test(expr) || (condition != null && COUNTER.test(condition)),
      why: 'exitCode assignment'
    };
  }
  if (COUNTER.test(expr) || /\?/.test(expr)) {
    return { verdict: true, why: 'exit value derived from an accumulated verdict' };
  }
  return { verdict: false, why: 'literal exit — a setup guard or a usage error' };
}

/** Every NAMED function, with the line range of its body. */
function functionSpans(masked) {
  const spans = [];
  const re = new RegExp(
    String.raw`function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{` + '|' +
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{` + '|' +
      String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{`,
    'g'
  );
  let m;
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    for (; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') { depth--; if (depth === 0) break; }
    }
    spans.push({
      name: m[1] || m[2] || m[3],
      defLine: lineAt(masked, m.index),
      startLine: lineAt(masked, open),
      endLine: lineAt(masked, j)
    });
  }
  return spans;
}

const JS_WORDS = new Set([
  'const', 'let', 'var', 'if', 'else', 'return', 'true', 'false', 'null',
  'undefined', 'new', 'typeof', 'await', 'async', 'function', 'of', 'in',
  'process', 'exit', 'exitCode', 'Number', 'String', 'Boolean', 'Math', 'JSON',
  'Object', 'Array'
]);

/**
 * Bare identifiers in an expression. `.property` accesses and the parameters of
 * any inline arrow are stripped first — without the latter,
 * `results.filter((r) => !r.passed)` puts `r` into the closure and every
 * unrelated `r = …` in the file starts to read as a way to fail.
 */
function identifiers(expr) {
  const bare = expr
    .replace(/\([^)]*\)\s*=>/g, ' ')
    .replace(/\b[A-Za-z_$][\w$]*\s*=>/g, ' ')
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, ' ');
  return [...new Set(bare.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])].filter((n) => !JS_WORDS.has(n));
}

/** The RHS of a top-level `const|let|var NAME = …;`, if one exists. */
function declarationOf(masked, name) {
  const re = new RegExp(String.raw`(?:^|\n)\s*(?:const|let|var)\s+${name}\s*=\s*`, 'g');
  const m = re.exec(masked);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = masked.indexOf(';', from);
  return { rhs: masked.slice(from, end === -1 ? masked.length : end), line: lineAt(masked, from) };
}

/** What an exit's value is named after; the controlling `if` only when the expression is a bare literal. */
function verdictSeed(masked, entry) {
  if (identifiers(entry.expr).length) return entry.expr;
  const condition = controllingCondition(masked, entry.line);
  if (condition == null) return entry.expr;
  let depth = 0;
  for (let i = 0; i < condition.length; i++) {
    if (condition[i] === '(') depth++;
    else if (condition[i] === ')') { if (depth === 0) return condition.slice(0, i); depth--; }
  }
  return condition;
}

/**
 * The names an exit depends on, followed back through declarations — two hops,
 * not unlimited. `failed → results` is one hop; `ok → the values ok is computed
 * from` is one. Following further walks the whole program and every `=` near
 * any of it starts to look like a way for the proof to fail.
 */
function sinkClosure(masked, seeds) {
  const MAX_DEPTH = 2;
  const closure = new Set();
  const queue = seeds.flatMap(identifiers).map((name) => ({ name, depth: 0 }));
  while (queue.length && closure.size < 24) {
    const { name, depth } = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    if (depth >= MAX_DEPTH) continue;
    const decl = declarationOf(masked, name);
    if (decl) queue.push(...identifiers(decl.rhs).map((n) => ({ name: n, depth: depth + 1 })));
  }
  return closure;
}

const FALSIFIABLE = /===|!==|==|!=|<|>|(?<![!=<>])!(?!=)|&&|\|\||\.(includes|some|every|test|match|startsWith|endsWith)\s*\(/;

/**
 * Is the assignment at `index` a statement, or nested inside a parameter list or
 * a call's arguments? Parentheses only, deliberately: braces would also reject
 * `if (!ok) { failures += 1; }`, which is a real mutation written on one line.
 */
function statementLevel(text, index) {
  let parens = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '(') parens++;
    else if (text[i] === ')') parens--;
  }
  return parens <= 0;
}

/**
 * Places that can make the outcome negative, expressed as CALL SITES.
 *
 * A mutation of an accumulator is a site where it stands, unless it sits inside
 * a named function — in which case the sites are that function's call sites,
 * and a function nobody calls yields none. That substitution is the whole
 * check: it separates a `check()` helper that is wired up from one merely
 * present.
 */
function failSites(masked, verdictSeeds) {
  const closure = sinkClosure(masked, verdictSeeds);
  const spans = functionSpans(masked);
  const lines = masked.split('\n');

  const mutations = [];
  lines.forEach((text, idx) => {
    const line = idx + 1;
    const isDeclaration = /^\s*(const|let|var)\s/.test(text);
    for (const name of closure) {
      // Alternatives are assembled into a list and joined. Building this by
      // string concatenation once left a trailing `|`, and an empty alternative
      // matches every line — which is how an early run of this detector found
      // 141 sites in a 600-line script and called the suite clean.
      const alternatives = [
        String.raw`\b${name}\s*\.\s*(push|add|set|unshift)\s*\(`,
        String.raw`\b${name}\s*(\+\+|\+=)`,
        String.raw`\+\+\s*${name}\b`
      ];
      let hit = new RegExp(alternatives.join('|')).exec(text);
      // A re-assignment is a mutation; the declaration introducing the name is
      // not, or `const failures = []` would be its own way to fail. Nor is a
      // default inside a parameter list: `function f({ activated = [] })` is a
      // signature, and reading it as a mutation made every call to `f` a site.
      if (!hit && !isDeclaration) {
        const assign = new RegExp(String.raw`\b${name}\s*=\s*(?!=)`).exec(text);
        if (assign && statementLevel(text, assign.index)) hit = assign;
      }
      if (hit) { mutations.push({ line, name }); break; }
    }
    if (/process\s*\.\s*exitCode\s*=\s*(?!0\s*;?\s*$)/.test(text)) {
      mutations.push({ line, name: 'process.exitCode' });
    }
  });

  const sites = [];
  for (const mut of mutations) {
    // `>=`, not `>`: `const check = (ok) => { if (!ok) failures += 1; };` opens
    // and closes its body on one line, and a mutation there is inside it.
    const owner = spans.find((s) => mut.line >= s.startLine && mut.line <= s.endLine);
    if (!owner) { sites.push({ line: mut.line, via: 'direct' }); continue; }
    const callRe = new RegExp(String.raw`\b${owner.name}\s*\(`, 'g');
    let c;
    while ((c = callRe.exec(masked))) {
      const line = lineAt(masked, c.index);
      if (spans.some((s) => s.name === owner.name && line >= s.defLine && line <= s.endLine)) continue;
      if (!sites.some((s) => s.line === line && s.via === owner.name)) {
        sites.push({ line, via: owner.name });
      }
    }
  }

  // No accumulator anywhere in the closure: the proof may still be the
  // `const ok = a === b && c.length === 0` shape, where the declaration itself
  // is the thing that can be false. Runs ONLY when there is nothing to mutate,
  // so it can never rescue a helper that exists and is never called.
  if (!mutations.length) {
    for (const name of closure) {
      const decl = declarationOf(masked, name);
      if (decl && FALSIFIABLE.test(decl.rhs)) sites.push({ line: decl.line, via: 'expression' });
    }
  }

  return { sites, closure: [...closure], mutationCount: mutations.length };
}

/** The whole judgement for one source text. */
function analyse(source) {
  const masked = codeMask(source);
  const exits = exitPaths(masked).map((e) => ({ ...e, ...classifyExit(e, masked) }));
  const verdicts = exits.filter((e) => e.verdict);
  const reach = failSites(masked, verdicts.map((v) => verdictSeed(masked, v)));
  return { exits, verdicts, ...reach };
}

// ===========================================================================
// 1. The tracked proofs
// ===========================================================================

console.log('=== 1. The proofs this check is responsible for ===\n');

const tracked = execFileSync('git', ['ls-files', 'scripts/verify-*.mjs'], {
  cwd: repoRoot,
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean);

check(tracked.length > 0, 'git reports tracked proofs', `${tracked.length} files`);
check(
  tracked.includes('scripts/verify-proof-verdicts.mjs'),
  'this check is itself tracked and therefore swept by its own rules',
  'a sweep that exempts itself is the first place the next unreachable verdict would go'
);

const sourceOf = new Map(tracked.map((rel) => [rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8')]));

// ===========================================================================
// 2. SELF-TEST — the detector must be shown to accept AND to reject
// ===========================================================================

console.log('\n=== 2. The detector self-tests before it judges anything ===\n');

const FIXTURES = [
  {
    name: 'helper wired up',
    accept: true,
    source: `let failures = 0;
const check = (ok, why) => { if (!ok) failures += 1; };
check(1 === 1, 'a claim');
process.exit(failures ? 1 : 0);`
  },
  {
    name: 'counter never incremented',
    accept: false,
    source: `let failures = 0;
console.log('everything looks fine');
process.exit(failures ? 1 : 0);`
  },
  {
    name: 'helper defined but never called',
    accept: false,
    source: `const failures = [];
const check = (ok, why) => { if (!ok) failures.push(why); };
console.log('everything looks fine');
process.exit(failures.length ? 1 : 0);`
  },
  {
    name: 'argument order reversed — must be judged identically',
    accept: true,
    source: `const failures = [];
const check = (name, ok, detail) => { if (!ok) failures.push(name); };
check('a claim', 1 === 1, '');
process.exit(failures.length ? 1 : 0);`
  },
  {
    name: 'results array behind a record helper',
    accept: true,
    source: `const results = [];
const record = (name, passed) => { results.push({ name, passed }); };
record('a claim', 1 === 1);
const failed = results.filter((r) => !r.passed);
process.exit(failed.length === 0 ? 0 : 1);`
  },
  {
    name: 'a parameter default is not a way to fail',
    accept: false,
    source: `const failures = [];
function harness({ failures = [] }) { return failures.length; }
harness({});
process.exit(failures.length ? 1 : 0);`
  },
  {
    // Added AFTER the real tree found what the fixtures had missed: a regex
    // character class containing quote characters. Both proofs carrying this
    // shape read as "no verdict exit" until codeMask learned regex literals.
    // The division case is here too, so the fix cannot over-trigger and start
    // eating arithmetic instead.
    name: 'regex literal holding quotes, and division that is not one',
    accept: true,
    source: `let failures = 0;
const QUOTED = /['"\`][^'"\`]*\\d+/;
const half = failures / 2 / 1;
const check = (ok, why) => { if (!ok) failures += 1; };
check(QUOTED.test("'v1.2'") && half === 0, 'a claim');
process.exit(failures ? 1 : 0);`
  },
  {
    name: 'mask-survives-interpolation',
    accept: true,
    source: `let failures = 0;
const check = (ok, why) => { if (!ok) failures += 1; };
console.log(\`result: \${1 === 1 ? '{yes}' : "{no}"} and \${JSON.stringify({ a: 1 })}\`);
check(1 === 1, 'a claim');
process.exit(failures ? 1 : 0);`
  }
];

for (const f of FIXTURES) {
  const { verdicts, sites } = analyse(f.source);
  const accepted = verdicts.length > 0 && sites.length > 0;
  check(
    accepted === f.accept,
    `fixture "${f.name}" is ${f.accept ? 'accepted' : 'REJECTED'}`,
    `${verdicts.length} verdict exit(s), ${sites.length} FAIL site(s)`
  );
}

check(
  FIXTURES.some((f) => !f.accept),
  '(setup) the fixture set contains cases that MUST be rejected — a self-test made only of ' +
    'passing cases proves the detector says yes, which was never in doubt'
);

// ===========================================================================
// 3. PROPERTY ONE — a verdict-derived exit
// ===========================================================================

console.log('\n=== 3. Every proof has an exit derived from an accumulated verdict ===\n');

const analysed = new Map(tracked.map((rel) => [rel, analyse(sourceOf.get(rel))]));

const noVerdict = tracked.filter((rel) => analysed.get(rel).verdicts.length === 0);
check(
  noVerdict.length === 0,
  'every tracked proof can report failure through its exit code',
  noVerdict.length
    ? `${noVerdict.length} cannot: ${noVerdict.join(', ')}`
    : `all ${tracked.length} checked; exit(2) and bare literal guards correctly not counted`
);

// ===========================================================================
// 4. PROPERTY TWO — something that can reach it
// ===========================================================================

console.log('\n=== 4. Every proof has at least one call site that can produce a FAIL ===\n');

const unreachable = tracked.filter((rel) => analysed.get(rel).sites.length === 0);
check(
  unreachable.length === 0,
  'every tracked proof has somewhere that can make its verdict negative',
  unreachable.length
    ? `${unreachable.length} do not: ${unreachable
        .map((r) => `${r} (traced through: ${analysed.get(r).closure.join(', ') || 'nothing'})`)
        .join('; ')}`
    : `all ${tracked.length} checked`
);

if (verbose) {
  for (const rel of tracked) {
    const a = analysed.get(rel);
    const helpers = [...new Set(a.sites.map((s) => s.via))].join(', ');
    console.log(`      ${path.basename(rel, '.mjs').padEnd(46)} ${String(a.verdicts.length).padEnd(3)} verdict  ${String(a.sites.length).padEnd(4)} sites  via ${helpers}`);
  }
}

// ===========================================================================
// 5. The detector matched something, on the real tree
// ===========================================================================

console.log('\n=== 5. The detector recognises this suite, not just its fixtures ===\n');

const viaNames = new Set();
for (const rel of tracked) for (const s of analysed.get(rel).sites) viaNames.add(s.via);
const helperNames = [...viaNames].filter((v) => v !== 'direct' && v !== 'expression');

check(
  helperNames.length >= 2,
  '(setup) the helper detector matches something, and more than one spelling of it — a detector ' +
    'that matched nothing would report the same all-clear as one that matched everything',
  `recognised: ${helperNames.sort().join(', ') || 'NOTHING'}`
);

const totalMutations = tracked.reduce((n, rel) => n + analysed.get(rel).mutationCount, 0);
check(
  totalMutations >= tracked.length,
  '(setup) accumulator mutations were found at roughly suite scale — a mask that blanked every ' +
    'file would leave this at zero while every other check above still passed',
  `${totalMutations} mutation site(s) across ${tracked.length} proofs`
);

// ===========================================================================
// 6. Shown able to fail — against a real proof, mutated into the KAN-197 shape
// ===========================================================================

console.log('\n=== 6. The sweep goes red on a real proof broken two ways ===\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan206-'));
const { mutateScript, mutationsSkipped } = makeMutator({
  distDir: path.join(repoRoot, 'dist'),
  scratch,
  report: {
    pass: (label, detail) => check(true, label, detail),
    fail: (label, detail) => check(false, label, detail)
  }
});

const TARGET = path.join(repoRoot, 'scripts', 'verify-config-and-socket.mjs');

// KAN-197's exact shape: the verdict exit replaced by an unconditional success.
strippedVerdict: {
  const variant = mutateScript('strip-the-verdict', TARGET, [
    { find: 'process.exit(failures === 0 ? 0 : 1);', replace: 'process.exit(0);' }
  ]);
  if (!variant) break strippedVerdict;
  const a = analyse(fs.readFileSync(variant, 'utf8'));
  check(
    a.verdicts.length === 0,
    '§3 catches a proof whose verdict exit was replaced by exit(0)',
    `${a.verdicts.length} verdict exit(s) found in the mutant`
  );
}

// The subtler one, and the reason §4 exists: the verdict exit is untouched and
// still reads `exit(failures === 0 ? 0 : 1)`. Only the increment is gone, so
// `failures` is 0 forever. §3 alone would clear this.
orphanedCounter: {
  const variant = mutateScript('orphan-the-counter', TARGET, [
    { find: '  if (!ok) failures += 1;', replace: '  /* KAN-206: increment removed */' }
  ]);
  if (!variant) break orphanedCounter;
  const a = analyse(fs.readFileSync(variant, 'utf8'));
  check(
    a.verdicts.length > 0,
    'PRECONDITION: the orphaned-counter mutant still has its verdict exit — otherwise §4 would be ' +
      'credited with a catch that §3 had already made',
    `${a.verdicts.length} verdict exit(s)`
  );
  check(
    a.sites.length === 0,
    '§4 catches a proof whose verdict is intact but whose counter nothing can increment',
    `${a.sites.length} FAIL site(s) found in the mutant`
  );
}

check(
  mutationsSkipped().length === 0,
  'every mutation in this section actually applied',
  mutationsSkipped().join('; ') || 'none skipped'
);

fs.rmSync(scratch, { recursive: true, force: true });

// ===========================================================================
// 7. This check's own wiring — the one thing it cannot take on faith
// ===========================================================================

console.log('\n=== 7. This check runs from outside the list it audits ===\n');

const ciYml = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const arrayBlock = ciYml.slice(ciYml.indexOf('scripts=('), ciYml.indexOf(')', ciYml.indexOf('scripts=(')));

check(
  !arrayBlock.includes('verify-proof-verdicts'),
  'this script is NOT an entry in the `scripts=(` array it audits',
  'a guard inside the thing it guards is not a guard (verify-proof-registry §4): the array is part ' +
    'of this script\'s subject, so listing it there lets the one edit it exists to catch remove it'
);
check(
  /^\s*proof-verdicts:\s*$/m.test(ciYml),
  'it has its own named CI job',
  'deleting a whole named job is an edit a reviewer sees, not a conflict hunk they resolve'
);
check(
  ciYml.includes('node scripts/verify-proof-verdicts.mjs'),
  'that job actually invokes this script'
);

// ===========================================================================
// Verdict
// ===========================================================================

console.log('');
if (failures === 0) {
  console.log(
    `ALL PASS — all ${tracked.length} tracked proofs have a verdict-derived exit and at least one\n` +
      'call site that can make it negative, and this sweep was watched catching a real proof\n' +
      'broken in both of those ways.\n\n' +
      'This does NOT establish that any of their assertions can be false. `check(true, …)` is a\n' +
      'call site by every measure applied here. That is verify-proof-defences\' question, one\n' +
      'level down, and these two proofs do not cover each other.'
  );
} else {
  console.log(`${failures} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
