#!/usr/bin/env node
// KAN-524 RED DRIVE — does `verify-launcher-args.mjs` §6 actually notice a
// proof that wrote into the live fleet's registry, or has it only ever passed?
//
// WHAT FAILURE THIS WOULD CATCH: a SAFETY section whose registry check cannot
// report anything. Two shapes of that, and §6 has held both:
//
//   THE VACUOUS GREEN. The check reads a file that does not exist on the
//   machine it runs on, so it is true whatever the world does. That is §6 on a
//   CI runner — the `verify` job hands every proof a scratch `$HOME`, so there
//   is no registry under it and there never can be. Green forever, and green
//   for a reason that has nothing to do with the fleet.
//
//   THE FALSE RED. The check reads something the proof does not control, so it
//   fires on somebody else's correct behaviour. That was §6 on a developer's
//   machine until KAN-524: it compared the live registry's MTIME against a
//   baseline, and the live daemon writes that file all day for its own reasons.
//   Its message says *this proof touched the running fleet*, so a reader meets
//   an alarm about a proof spawning into production and goes hunting for one.
//
// ⚠ BOTH SHAPES ARE SILENT BY CONSTRUCTION, and they hide in opposite places:
// the vacuous green is invisible exactly where CI looks, and the false red is
// invisible exactly where CI does not. Neither is observable from one run on
// one machine, which is why this file stages the world instead of waiting for
// it.
//
// ---------------------------------------------------------------------------
// THE ARMS
// ---------------------------------------------------------------------------
//
//   0. CONTROL        the unmutated proof against a staged registry that
//                     nobody writes during the run. §6 must be GREEN, and (d)
//                     must have READ that registry — asserted on its byte
//                     count, because a (d) that took its "no registry here"
//                     branch would also be green and would make every arm
//                     below a measurement of nothing.
//
//   1. ⚠ CONTAMINATION  a row carrying THIS RUN'S OWN SCRATCH ROOT appended to
//      — THE TICKET'S  the staged registry WHILE THE PROOF IS MID-FLIGHT, by a
//      ITEM 3          writer that discovers the root the same way an accident
//                      would leave it there. (d) must go RED; every other check
//                      in §6 must stay GREEN. This is the demonstration KAN-524
//                      asked for: the replacement fails when something really
//                      does write into the registry it guards.
//
//   2. ⚠ THE RETIRED   the same world twice, with the registry merely TOUCHED
//      IDIOM, BOTH     mid-run — mtime moves, no row appended, which is exactly
//      WAYS ROUND      what the live daemon does. The RETIRED predicate must go
//                      RED (the false red, reproduced deterministically instead
//                      of waited for) and the CURRENT one must stay GREEN in
//                      the identical world. One arm, two runs, because "the fix
//                      fixed it" is a claim about the difference between them
//                      and neither run alone can carry it.
//
//   3. THE CONTROLS   §6's two detector controls, driven red on purpose.
//      ARE GATES      (3a) the detector forced to never fire: (d-control +)
//                     must go RED while (d) stays green. (3b) forced to always
//                     fire: (d) and (d-control −) must go RED while
//                     (d-control +) stays green. Without this arm the controls
//                     are decoration — two lines that print PASS and would
//                     print PASS against any detector at all.
//
// ⚠ EVERY ARM ASSERTS WHAT WENT RED **AND** WHAT STAYED GREEN. An arm that
// required only its own line to fail would pass against a mutant that broke the
// whole script, and would report that as a success.
//
// ⚠ AN ABSENT LINE IS NOT A PASS. `verdictOf` returns `null` when a label is
// not in the output at all, and every assertion here compares against the
// string 'PASS' or 'FAIL' rather than testing truthiness — so a renamed or
// deleted check fails this drive by name instead of quietly satisfying it.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVES AND WHAT IT DOES NOT — the seam, stated rather than left to
// be assumed away.
// ---------------------------------------------------------------------------
//
// THIS DRIVE SUPPLIES ITS OWN CONTAMINATION. The row naming this run's scratch
// root is appended by the harness, not produced by CrabCast — so what arm 1
// establishes is that §6's DETECTOR fires on a registry carrying this run's
// footprint. It does NOT establish that CrabCast could ever put such a row
// there; that is the boundary §6 exists to guard and the whole point is that it
// has never been crossed. WHO COVERS THAT: nobody, and nobody can — a proof
// that demonstrated the real daemon writing a real row would be the accident
// itself. Named here so no reader infers a coverage that does not exist.
//
// THE WORKING TREE IS NEVER TOUCHED: arms 2 and 3 run against COPIES of the
// proof under this drive's own scratch root, and every mutation asserts it
// replaced exactly one occurrence — an anchor that has drifted fails loudly
// here rather than silently running an unmutated copy and reporting its green.
//
// THE RUNNING FLEET IS NEVER TOUCHED: every proof run here gets a staged $HOME
// under this drive's scratch root, which is the same mechanism CI uses, so the
// registry all six runs read is one this file created. §4 asserts that the real
// one carries no row this drive put there, by the same attributable question
// §6 itself now asks.
//
// Usage:
//   npm run build
//   node scripts/kan524-red-drive.mjs

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distDir = path.join(repoRoot, 'dist');
const PROOF = path.join(scriptDir, 'verify-launcher-args.mjs');

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

function arm(title) {
  console.log(`\n${title}\n${'='.repeat(title.length)}`);
}

if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error('dist/daemon.js not found — run `npm run build` first');
  process.exit(1);
}

// ------------------------------------------------------------------ scratch
//
// ONE ROOT, so §4 can assert the whole footprint is inside it and remove it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabcast-kan524-drive-'));

/**
 * The live fleet's registry, read BEFORE this drive does anything.
 *
 * Not a gate and not an mtime — this drive is the file that argues mtime is the
 * wrong question, so using it here would be the defect wearing the fix's
 * clothes. §4 asks the attributable question instead.
 */
const realAgentsLog = path.join(os.homedir(), '.local', 'share', 'crabcast', 'agents.jsonl');

function cleanUp() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on('SIGINT', () => { cleanUp(); process.exit(130); });
process.on('SIGTERM', () => { cleanUp(); process.exit(143); });

/**
 * A staged $HOME with a registry in it that looks like a fleet's.
 *
 * The rows name data dirs that have nothing to do with any run of the proof, so
 * a detector that fired on them would be reporting registry traffic rather than
 * this run — which is the distinction (d-control −) exists to hold.
 */
function stageHome(name) {
  const home = path.join(tmp, name);
  const dataDir = path.join(home, '.local', 'share', 'crabcast');
  fs.mkdirSync(dataDir, { recursive: true });
  const registry = path.join(dataDir, 'agents.jsonl');
  fs.writeFileSync(
    registry,
    [
      { key: 'task/KAN-1', dataDir: '/home/somebody/.local/share/crabcast', status: 'running' },
      { key: 'epic/KAN-2', dataDir: '/home/somebody/.local/share/crabcast', status: 'idle' }
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
  return { home, registry };
}

/**
 * Run a copy of the proof under a staged $HOME, optionally with a writer
 * touching the staged registry while it runs.
 *
 * `distDir` is passed EXPLICITLY. A copy placed under the scratch root would
 * otherwise resolve `../dist` relative to itself and find nothing, and the
 * resulting failure would look like a mutation this drive was crediting itself
 * with.
 */
function runProof(scriptFile, home, onTick) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptFile, distDir], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = onTick ? setInterval(() => { try { onTick(); } catch {} }, 100) : null;
    child.on('exit', (code) => {
      if (timer) clearInterval(timer);
      resolve({ code, out });
    });
  });
}

/**
 * The verdict printed for the check whose label contains `needle`.
 *
 * `null` when no such line was printed — a THIRD outcome, deliberately not
 * folded into `false`. A check that has been renamed away has not passed and
 * has not failed; it is gone, and every caller here compares against 'PASS' or
 * 'FAIL' explicitly so that `null` satisfies neither.
 */
function verdictOf(out, needle) {
  for (const line of out.split('\n')) {
    const m = /^ {2}(PASS|FAIL) {2}(.*)$/.exec(line);
    if (m && m[2].includes(needle)) return m[1];
  }
  return null;
}

/** The detail line printed under the check whose label contains `needle`. */
function detailOf(out, needle) {
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(?:PASS|FAIL) {2}(.*)$/.exec(lines[i]);
    if (m && m[1].includes(needle)) return (lines[i + 1] ?? '').trim();
  }
  return '';
}

/** The scratch root the proof reported in (a)'s detail: `used <root>/data`. */
function scratchRootOf(out) {
  const m = /used (\S*crabcast-kan504-[^\s/]+)\/data/.exec(out);
  return m ? m[1] : null;
}

/** Copy the proof and apply one anchored replacement, or die saying so. */
function mutateProof(name, from, to) {
  const src = fs.readFileSync(PROOF, 'utf8');
  const occurrences = src.split(from).length - 1;
  if (occurrences !== 1) {
    console.error(
      `\nMUTATION ANCHOR DRIFTED for '${name}': expected 1 occurrence, found ${occurrences}.\n` +
        `This drive REFUSES to run an unmutated copy and report its green.\n` +
        `The anchor was:\n${from}\n`
    );
    cleanUp();
    process.exit(1);
  }
  const file = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(file, src.replace(from, to));
  return file;
}

// The labels §6 prints. Substrings, because the full labels wrap in source.
const D = '(d) [measurement] the live fleet';
const D_PLUS = '(d-control +)';
const D_MINUS = '(d-control −)';
const A = '(a) [disclosure]';
const B = '(b) [disclosure]';
const C = '(c) [disclosure]';
const E = '(e) [measurement]';
const RETIRED = "the live fleet's own agents.jsonl was not written";

/** Every §6 check other than the ones an arm expects to redden. */
function requireGreenExcept(out, red) {
  for (const label of [A, B, C, D, D_PLUS, D_MINUS, E]) {
    if (red.includes(label)) continue;
    check(
      verdictOf(out, label) === 'PASS',
      `      and '${label}…' stayed GREEN`,
      `verdict ${verdictOf(out, label) ?? 'ABSENT — the check is gone, which is not a pass'}`
    );
  }
}

// ===========================================================================
arm('0. CONTROL — the unmutated proof, staged registry, nobody writing it');
// ===========================================================================
//
// Without this every red below could be the harness rather than the mutation:
// a staged world that was simply broken would redden all of them and read as
// four successes.
{
  const { home } = stageHome('arm0-home');
  const { code, out } = await runProof(PROOF, home);
  check(code === 0, 'the whole proof exits 0 against an untouched staged registry', `exit ${code}`);
  check(verdictOf(out, D) === 'PASS', `'${D}…' is GREEN`, `verdict ${verdictOf(out, D) ?? 'ABSENT'}`);
  // ⚠ THE PRECONDITION THAT MAKES ARM 0 WORTH ANYTHING. (d) is also green when
  // it found no registry at all, and that green is the thing this ticket was
  // filed about. So the byte count is required: it is printed only on the
  // branch that actually read a file.
  const detail = detailOf(out, D);
  check(
    /^\d+ bytes, no occurrence of /.test(detail),
    "PRECONDITION: (d) READ the staged registry — it is not reporting its 'no registry here' branch",
    detail || '(no detail printed)'
  );
  requireGreenExcept(out, []);
}

// ===========================================================================
arm('1. CONTAMINATION — a row naming THIS RUN\'s scratch root, written mid-flight');
// ===========================================================================
//
// The writer discovers the proof's scratch root the same way anything else on
// the machine could: by watching `os.tmpdir()` for roots that were not there
// when this arm started. Every new one is written, not just the first — another
// agent on this machine may be running the same proof concurrently, and an arm
// that guessed which root was ours would be a flake wearing a measurement's
// clothes. Ours is certainly among them, and the precondition below is what
// establishes that rather than assuming it.
{
  const { home, registry } = stageHome('arm1-home');
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('crabcast-kan504-'))
  );
  const injected = new Set();
  const contaminate = () => {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!n.startsWith('crabcast-kan504-') || before.has(n) || injected.has(n)) continue;
      injected.add(n);
      const root = path.join(os.tmpdir(), n);
      fs.appendFileSync(
        registry,
        JSON.stringify({
          key: 'injected/KAN-524-red-drive',
          dataDir: path.join(root, 'data'),
          status: 'running'
        }) + '\n'
      );
    }
  };

  const { code, out } = await runProof(PROOF, home, contaminate);

  // ⚠ PRECONDITION FIRST: the red below is only evidence about (d) if the row
  // this arm wrote actually names the root the proof used. Without it, a run
  // whose root was never discovered would go red for some unrelated reason and
  // this arm would credit itself with the catch.
  const root = scratchRootOf(out);
  check(
    root !== null && injected.has(path.basename(root)),
    "PRECONDITION: a row naming the proof's OWN scratch root reached the staged registry",
    root === null
      ? '(a) printed no scratch root to match against'
      : `proof used ${root}; rows injected for ${[...injected].join(', ') || '(none)'}`
  );

  check(
    verdictOf(out, D) === 'FAIL',
    `⚠ '${D}…' goes RED — the replacement fails when something really does write into the ` +
      'registry it guards',
    `verdict ${verdictOf(out, D) ?? 'ABSENT — the check is gone, which is not a red'}`
  );
  check(code !== 0, '      and the proof exits non-zero, so CI would see it', `exit ${code}`);
  requireGreenExcept(out, [D]);
}

// ===========================================================================
arm('2. THE RETIRED IDIOM — mtime moved by somebody else, both predicates run');
// ===========================================================================
//
// The false red KAN-524 was filed for, reproduced deterministically. The
// registry is TOUCHED and nothing is appended, which is what the live daemon
// does to it all day: mtime moves, no row this run caused appears.
//
// The mutation restores the retired PREDICATE and LABEL. It deliberately does
// not restore the retired detail string — the detail is not what the verdict
// rests on, and a mutation that rewrote more than the gate would blur what this
// arm is attributing the red to.
{
  const retired = mutateProof(
    'arm2-retired',
    '    !carriesOurRows(realRegistry),\n' +
      '    "(d) [measurement] the live fleet\'s own agents.jsonl carries no row this proof put ' +
      'there",',
    '    realMtimeNow === realAgentsLogMtimeAtStart,\n' +
      `    ${JSON.stringify(RETIRED)},`
  );

  for (const [label, script, expectRetiredRed] of [
    ['RETIRED predicate', retired, true],
    ['CURRENT predicate', PROOF, false]
  ]) {
    const { home, registry } = stageHome(`arm2-home-${expectRetiredRed ? 'old' : 'new'}`);
    const mtimeBefore = fs.statSync(registry).mtimeMs;
    const touch = () => {
      const now = new Date();
      fs.utimesSync(registry, now, now);
    };
    const { code, out } = await runProof(script, home, touch);
    const mtimeAfter = fs.statSync(registry).mtimeMs;

    // PRECONDITION: the world this arm claims to have staged really obtained.
    check(
      mtimeAfter !== mtimeBefore,
      `[${label}] PRECONDITION: the staged registry's mtime really MOVED during the run`,
      `${mtimeBefore} -> ${mtimeAfter}`
    );

    if (expectRetiredRed) {
      check(
        verdictOf(out, RETIRED) === 'FAIL',
        `⚠ [${label}] goes RED on a registry nothing wrote a row into — this is the FALSE RED, ` +
          "and it is somebody else's correct behaviour being reported as this proof touching " +
          'production',
        `verdict ${verdictOf(out, RETIRED) ?? 'ABSENT'} — ${detailOf(out, RETIRED)}`
      );
      check(code !== 0, `      and it takes the whole proof non-zero with it`, `exit ${code}`);
    } else {
      check(
        verdictOf(out, D) === 'PASS',
        `⚠ [${label}] stays GREEN in the IDENTICAL world — which is the fix, stated as the ` +
          'difference between these two runs rather than as either one alone',
        `verdict ${verdictOf(out, D) ?? 'ABSENT'} — ${detailOf(out, D)}`
      );
      check(code === 0, '      and the whole proof exits 0', `exit ${code}`);
      check(
        verdictOf(out, RETIRED) === null,
        '      and the retired label is nowhere in the output — the mtime gate is gone rather ' +
          'than softened',
        `verdict ${verdictOf(out, RETIRED) ?? 'ABSENT (correct)'}`
      );
      requireGreenExcept(out, []);
    }
  }
}

// ===========================================================================
arm('3. THE CONTROLS ARE GATES — §6\'s own detector, driven red both ways');
// ===========================================================================
//
// (d-control +) and (d-control −) are what stop (d) being a search that comes
// back empty whatever the world holds. But a control nobody has watched fail is
// exactly the thing this ticket is about, so they get the same treatment.
{
  const DETECTOR = '  const carriesOurRows = (registry) => registry !== null && ' +
    'registry.includes(tmp);';

  // 3a — the detector forced to NEVER fire. (d) is still green, and that is the
  // point: (d) alone cannot tell a working detector from a dead one.
  {
    const script = mutateProof('arm3a-never', DETECTOR, '  const carriesOurRows = () => false;');
    const { home } = stageHome('arm3a-home');
    const { code, out } = await runProof(script, home);
    check(
      verdictOf(out, D_PLUS) === 'FAIL',
      `⚠ [detector never fires] '${D_PLUS}' goes RED`,
      `verdict ${verdictOf(out, D_PLUS) ?? 'ABSENT'}`
    );
    check(
      verdictOf(out, D) === 'PASS',
      `      while '${D}…' stays GREEN — a dead detector is invisible to the gate itself, ` +
        'which is why the control is not decoration',
      `verdict ${verdictOf(out, D) ?? 'ABSENT'}`
    );
    check(
      verdictOf(out, D_MINUS) === 'PASS',
      `      and '${D_MINUS}' stays GREEN`,
      `verdict ${verdictOf(out, D_MINUS) ?? 'ABSENT'}`
    );
    check(code !== 0, '      and the proof exits non-zero', `exit ${code}`);
  }

  // 3b — the detector forced to ALWAYS fire, which is the opposite failure: an
  // instrument that reports contamination it cannot have seen.
  {
    const script = mutateProof('arm3b-always', DETECTOR, '  const carriesOurRows = () => true;');
    const { home } = stageHome('arm3b-home');
    const { code, out } = await runProof(script, home);
    check(
      verdictOf(out, D) === 'FAIL',
      `⚠ [detector always fires] '${D}…' goes RED`,
      `verdict ${verdictOf(out, D) ?? 'ABSENT'}`
    );
    check(
      verdictOf(out, D_MINUS) === 'FAIL',
      `      and '${D_MINUS}' goes RED — which is the control that names the direction, since a ` +
        'detector firing on anything would make every (d) red look attributable',
      `verdict ${verdictOf(out, D_MINUS) ?? 'ABSENT'}`
    );
    check(
      verdictOf(out, D_PLUS) === 'PASS',
      `      while '${D_PLUS}' stays GREEN — the two controls disagree, which is how the mutant ` +
        'is told apart from real contamination',
      `verdict ${verdictOf(out, D_PLUS) ?? 'ABSENT'}`
    );
    check(code !== 0, '      and the proof exits non-zero', `exit ${code}`);
  }
}

// ===========================================================================
arm('4. the RUNNING FLEET was never touched by THIS DRIVE either');
// ===========================================================================
//
// The same attributable question §6 now asks, asked about this file. Every proof
// run above was handed a staged $HOME under this drive's scratch root, so the
// registry all six read is one this file created — but that is a disclosure of
// configuration, and the check below is the measurement.
{
  const realRegistry = (() => {
    try { return fs.readFileSync(realAgentsLog, 'utf8'); } catch { return null; }
  })();
  const carriesOurRows = (registry) => registry !== null && registry.includes(tmp);
  check(
    !carriesOurRows(realRegistry),
    "[measurement] the live fleet's own agents.jsonl carries no row THIS DRIVE put there",
    realRegistry === null
      ? `(no registry at ${realAgentsLog} — nothing was measured here, and this is the disclosure ` +
        'of that rather than a pass)'
      : `${realRegistry.length} bytes, no occurrence of ${tmp}`
  );
  check(
    carriesOurRows(`{"dataDir":${JSON.stringify(path.join(tmp, 'probe'))}}\n`),
    '(control +) and the same detector fires on a row carrying this drive\'s scratch root',
    `probe row names ${path.join(tmp, 'probe')}`
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log('='.repeat(78));

cleanUp();

process.exit(failures ? 1 : 0);
