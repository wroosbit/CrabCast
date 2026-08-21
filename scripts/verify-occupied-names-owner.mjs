#!/usr/bin/env node
// Live proof (KAN-596) that the `occupied` refusal says WHOSE the directory it
// is refusing to spawn into is recorded as being — and says it in a way that
// cannot be read as more than the record supports.
//
// WHAT FAILURE THIS WOULD CATCH: a refusal that renders "no owner recorded" as
// "not yours". `owner` is unset on every agent configured before its caller
// began declaring one, so on a fleet part-way through adopting the knob that
// reading is wrong about MOST of the fleet — and it is wrong in the direction
// whose remedy is the damage, since the reader's response to "not mine" is to
// stand the pane down and take the directory. It would also catch the two
// silent regressions either side of it: the refusal losing the owner
// altogether, and CrabCast growing a second wording of the hedge that says
// what the pane IS rather than what the record SAYS.
//
// THE THREE STATES, WHICH IS THE WHOLE POINT — and §1 exercises them against a
// real router rather than describing them:
//
//   a. an owner is recorded, and it is the reader's        -> named verbatim
//   b. an owner is recorded, and it is somebody else's     -> named verbatim
//   c. NO owner was ever recorded                          -> NOT RECOGNISED,
//                                                             and never
//                                                             "somebody else's"
//
// (c) IS THE CASE TO READ FIRST. It is the one a passing fleet does not
// exercise: every agent that carries an owner reaches (a) or (b), so a
// regression in (c) is invisible to any check that only asserts the happy
// path. It is also the majority state of a real fleet today.
//
// ⚠ WHAT THIS SCRIPT WRITES AND THEREFORE DOES NOT TEST. It configures the
// three records itself, so it does NOT test that an owner a caller passed
// survives the trip from `configure` into the registry — that is
// `verify-owner-filter.mjs`, which reads the stored value back through a
// filtered `list`. What is asserted here begins at "the record holds this" and
// ends at "the refusal says this", and the seam before it is that script's.
// The seam AFTER it — that the CLI prints what the daemon composed rather than
// a wording of its own — is §5, which drives the real renderer.
//
// Only the external `herdr` binary is replaced: a stub on PATH answering in
// herdr's own JSON shapes. The router, the bridge, the registry and the CLI
// renderer are the real compiled code.
//
// Usage:
//   npm run build
//   node scripts/verify-occupied-names-owner.mjs [distDir]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const srcDir = path.join(scriptDir, '..', 'src');

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { loadConfig } = await import(path.join(distDir, 'config.js'));
const { COMMANDS, commandNamed, ResponseReader } = await import(path.join(distDir, 'cli.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan596-owner-'));
const realPath = process.env.PATH;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

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

const KNOBS = { priority: 1, refusable: true, chargeable: true, preemptable: true, launcher: 'shell' };

let caseNumber = 0;

/**
 * One `activate` against a directory a foreign pane is sitting in, with the
 * record carrying `owner` or deliberately not carrying it.
 *
 * `owner` is passed through `configure`'s own knob table rather than written
 * into the registry by hand, so the value under test travels the path a caller's
 * would. Omitting the key entirely is how the absent case is produced -- which
 * is what a record predating the knob looks like, and is not the same document
 * as one carrying an empty string.
 */
async function refusalFor(label, owner) {
  const target = path.join(tmp, 'owned', label);
  fs.mkdirSync(target, { recursive: true });
  const dir = fs.realpathSync(target);
  fs.writeFileSync(
    CENSUS_FILE,
    JSON.stringify({
      id: 'cli:agent:list',
      result: {
        type: 'agent_list',
        agents: [
          {
            name: 'butchr-epic-kan-203',
            pane_id: '%41',
            agent: 'claude',
            agent_status: 'done',
            cwd: dir
          }
        ]
      }
    })
  );
  const agentRegistry = new AgentRegistry(path.join(tmp, `agents-${++caseNumber}.jsonl`));
  const bridge = new HerdrBridge(config.dataDir, config.configPath);
  const send = (request) =>
    new Promise((resolve) => {
      const router = new MessageRouter({
        config,
        herdrBridge: bridge,
        daemonStartedAt: new Date(),
        agentRegistry,
        send: (msg) => resolve(msg),
        broadcast: () => {}
      });
      router.handle(request);
    });

  const configured = await send({
    action: 'configure_agent',
    path: dir,
    ...KNOBS,
    ...(owner === undefined ? {} : { owner })
  });
  if (configured.success !== true) {
    throw new Error(`GATE FAULT: configure failed for ${label}: ${configured.error}`);
  }
  const activated = await send({ action: 'activate_agent', path: dir });
  return { dir, configured, activated };
}

// ---------------------------------------------------------------------------
rule('1. THE THREE STATES, from a real router');
// ---------------------------------------------------------------------------

// A value engineered to be mangled by anything that interprets it: it carries a
// separator, mixed case and a trailing segment, so a prefix match, a split or a
// case-fold would all show up as a difference rather than needing to be
// searched for.
const MINE = 'butchr';
const THEIRS = 'Acme-Scheduler/eu-west-1';

const mine = await refusalFor('mine', MINE);
const theirs = await refusalFor('theirs', THEIRS);
const absent = await refusalFor('absent', undefined);

for (const [label, r] of [['mine', mine], ['theirs', theirs], ['absent', absent]]) {
  check(
    `${label}: activate is REFUSED as occupied -- the branch this field rides`,
    r.activated.success === false && r.activated.refused === 'occupied',
    `success=${r.activated.success} refused=${r.activated.refused}`
  );
  check(
    `${label}: the refusal carries occupantOwnership`,
    r.activated.occupantOwnership !== undefined &&
      typeof r.activated.occupantOwnership.reading === 'string',
    JSON.stringify(r.activated.occupantOwnership)
  );
}

console.log('\nmine   :', JSON.stringify(mine.activated.occupantOwnership, null, 2));
console.log('theirs :', JSON.stringify(theirs.activated.occupantOwnership, null, 2));
console.log('absent :', JSON.stringify(absent.activated.occupantOwnership, null, 2));

check(
  'a recorded owner is reported as `recorded` and carried VERBATIM',
  mine.activated.occupantOwnership.recognition === 'recorded' &&
    mine.activated.occupantOwnership.owner === MINE,
  JSON.stringify(mine.activated.occupantOwnership.owner)
);
check(
  'and verbatim means byte for byte -- separator, case and all segments survive, which is\n' +
    '        what "matched exactly and never interpreted" has to mean at this end too',
  theirs.activated.occupantOwnership.owner === THEIRS,
  `sent ${JSON.stringify(THEIRS)}, got ${JSON.stringify(theirs.activated.occupantOwnership.owner)}`
);
check(
  'a record with NO owner is reported as `none-recorded` with a null owner -- an absence\n' +
    '        with a name, rather than a missing key each consumer resolves for itself',
  absent.activated.occupantOwnership.recognition === 'none-recorded' &&
    absent.activated.occupantOwnership.owner === null,
  JSON.stringify(absent.activated.occupantOwnership.recognition)
);

// ---------------------------------------------------------------------------
rule('2. THREE DISTINGUISHABLE ANSWERS, NOT TWO');
// ---------------------------------------------------------------------------

const readings = {
  mine: mine.activated.occupantOwnership.reading,
  theirs: theirs.activated.occupantOwnership.reading,
  absent: absent.activated.occupantOwnership.reading
};
for (const [a, b] of [['mine', 'theirs'], ['mine', 'absent'], ['theirs', 'absent']]) {
  check(
    `${a} and ${b} are different answers`,
    readings[a] !== readings[b],
    `${readings[a].slice(0, 40)}... vs ${readings[b].slice(0, 40)}...`
  );
}
check(
  'and the two RECORDED answers differ by naming their own owner rather than by a verdict\n' +
    '        this daemon reached -- `mine` names the reader\'s string, `theirs` names theirs',
  readings.mine.includes(JSON.stringify(MINE)) &&
    readings.theirs.includes(JSON.stringify(THEIRS)) &&
    !readings.mine.includes(THEIRS) &&
    !readings.theirs.includes(MINE)
);

// ---------------------------------------------------------------------------
rule('3. THE ABSENT CASE -- the one a passing fleet does not exercise');
// ---------------------------------------------------------------------------

check(
  'it says NOT RECOGNISED',
  readings.absent.includes('NOT RECOGNISED'),
  readings.absent.slice(0, 60)
);
check(
  'it says in as many words that this is NOT the same as somebody else\'s',
  /NOT THE SAME AS SOMEBODY ELSE/i.test(readings.absent)
);
check(
  'and it names why absence is expected rather than anomalous -- a reader who is not told\n' +
    '        that most of a fleet is in this state will read a bare "none" as a finding',
  /before its caller began declaring an owner/i.test(readings.absent)
);

// The words a refusal must not use ABOUT AN UNRECOGNISED OCCUPANT. Each one
// asserts a relationship the record does not establish, and each is a plausible
// thing for a later author to reach for while tightening the prose.
const VERDICT_WORDS = ['foreign', 'unrelated', 'stranger', 'not yours', 'not your'];
for (const word of VERDICT_WORDS) {
  check(
    `the absent answer never calls the occupant ${JSON.stringify(word)}`,
    !readings.absent.toLowerCase().includes(word),
    readings.absent
  );
}
// The control, without which the check above is a claim about the search rather
// than about the text: the same test run against a string that DOES contain
// those words has to fail.
const CONTROL = 'this pane is foreign and unrelated -- not yours';
check(
  'CONTROL: that same test goes red on a text that does contain them, so a green above is\n' +
    '        a fact about the reading rather than about a substring search that cannot match',
  VERDICT_WORDS.some((w) => CONTROL.toLowerCase().includes(w))
);

// ---------------------------------------------------------------------------
rule('4. THE MIGRATION PATH, and the cost of taking it');
// ---------------------------------------------------------------------------

for (const [label, reading] of Object.entries(readings)) {
  check(
    `${label}: the answer names the way out of an occupied directory`,
    /stand that pane down, then `?activate`?/i.test(reading),
    reading.slice(-160)
  );
  check(
    `${label}: and names what taking it costs -- that the first activation starts a NEW\n` +
      '        conversation, which is the half of the ordering that cannot be undone',
    /starts a NEW one/.test(reading) && /not recoverable/.test(reading)
  );
}

// ---------------------------------------------------------------------------
rule('5. THE CLI PRINTS THE DAEMON\'S SENTENCE, and composes none of its own');
// ---------------------------------------------------------------------------

const activateSpec = COMMANDS.find((c) => c.name === 'activate');
check(
  'the renderer driven here is the one the CLI resolves for `activate`',
  commandNamed('activate') === activateSpec
);

for (const [label, r] of [['mine', mine], ['theirs', theirs], ['absent', absent]]) {
  const rendered = activateSpec.render(new ResponseReader({ ...r.activated, id: 'cli-1-1' }), {
    path: r.dir
  });
  console.log(`\n--- rendered, ${label} ---\n${rendered}`);
  check(
    `${label}: the rendered refusal carries the daemon's reading as one contiguous block,\n` +
      '        modulo the wrapping this renderer applies to prose',
    rendered.replace(/\s+/g, ' ').includes(r.activated.occupantOwnership.reading.replace(/\s+/g, ' '))
  );
  check(
    `${label}: and prints the owner value on a line of its own, so it is readable without\n` +
      '        parsing the sentence around it',
    /recorded owner:\s+\S/.test(rendered),
    rendered.split('\n').find((l) => l.includes('recorded owner:'))
  );
  check(
    `${label}: no residue -- every field the daemon sent was rendered or deliberately seen`,
    !/unrendered|residue/i.test(rendered) || !/occupantOwnership/.test(rendered),
    rendered.split('\n').filter((l) => /residue|unrendered/i.test(l)).join(' | ')
  );
}

// ---------------------------------------------------------------------------
rule('5b. THE SAME BLOCK ON `configure`, HOURS BEFORE THE OCCUPANT BITES');
// ---------------------------------------------------------------------------

// `configure` does not refuse an occupied directory -- it succeeds and reports
// the occupant as advisory, which is what makes the adopting caller's ordering
// discoverable on day one instead of at the activation that fails. So it is
// also the cheapest place to learn that the pane you are about to stand down is
// recorded as yours. THERE IS NO `error` ON A SUCCESS, so this is the branch
// where the block itself has to carry the sentence, and the check below is
// what says it does rather than assuming §5's suppression is branch-local.
const configureSpec = COMMANDS.find((c) => c.name === 'configure');
check(
  'the renderer driven here is the one the CLI resolves for `configure`',
  commandNamed('configure') === configureSpec
);
for (const [label, r] of [['mine', mine], ['absent', absent]]) {
  const rendered = configureSpec.render(new ResponseReader({ ...r.configured, id: 'cli-1-1' }), {
    path: r.dir
  });
  console.log(`\n--- configure rendered, ${label} ---\n${rendered}`);
  check(
    `${label}: configure's advisory block carries the WHOLE reading, not just the value --\n` +
      '        there is no `error` here for it to have been printed in',
    rendered.replace(/\s+/g, ' ').includes(r.configured.occupantOwnership.reading.replace(/\s+/g, ' ')),
    JSON.stringify(r.configured.occupantOwnership?.recognition)
  );
}

// ---------------------------------------------------------------------------
rule('6. NO PANE-NAME PARSING WAS INTRODUCED');
// ---------------------------------------------------------------------------

// The design this replaces would have had CrabCast recognise its callers by the
// shape of the pane names they choose. That is refused on CrabCast's own
// recorded principle -- a derived pane name is not API, and the first prefix
// match invites a namespace this daemon would then owe compatibility on -- so
// the absence of one caller's prefix from src/ is the regression control.
const sources = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(srcDir, f), 'utf8') }));

const withPrefix = sources.filter((s) => s.text.includes('butchr-'));
check(
  'zero occurrences of a `butchr-` agent-name prefix anywhere in src/',
  withPrefix.length === 0,
  withPrefix.map((s) => s.file).join(', ')
);
// Without this the check above is satisfied by a grep that cannot match: the
// occupant's name in this very script is `butchr-epic-kan-203`, so the string is
// findable, and `crabcast-` is present in src/ to prove the search reaches it.
const withOwnPrefix = sources.filter((s) => s.text.includes('crabcast-'));
check(
  'CONTROL: the same search finds `crabcast-` in src/, so the green above is a fact about\n' +
    '        the sources rather than about a search that could not have matched',
  withOwnPrefix.length > 0,
  `${withOwnPrefix.length} file(s): ${withOwnPrefix.map((s) => s.file).join(', ')}`
);

// ---------------------------------------------------------------------------
rule('7. THE CONCLUSION IS WRITABLE AT EXACTLY ONE SITE');
// ---------------------------------------------------------------------------

// A hedge that exists in two wordings is a hedge one of them will lose, on the
// copy nobody re-reads. These are FRAGMENTS OF THE EMITTED SENTENCES rather
// than the ideas in them, and each must occur exactly once in the whole of
// src/ -- so a second surface reporting ownership has to reach the one function
// rather than write its own wording of the same hedge.
//
// LONG FRAGMENTS, DELIBERATELY. A short key phrase ("NOT RECOGNISED") is the
// sort of thing a doc comment legitimately quotes while explaining the rule,
// and a check that goes red on its own documentation is a check somebody
// deletes rather than obeys. These carry enough of the sentence that a second
// occurrence is a second WORDING and not a mention of the first.
const ONCE = [
  'NOT RECOGNISED \u2014 no `owner` was ever recorded',
  'most likely your own agent under another runtime',
  'stand that pane down, then `activate`',
  'NOT WHO IS RUNNING IN'
];
// SOURCE-LEVEL CONCATENATION IS NOT A DIFFERENT SENTENCE, and counting raw text
// would say it was: a sentence written across four `'...' +` lines contains none
// of the fragments below, so every count would come back 0 and every check would
// go green on an emitted string that is right there. The seams are removed
// first. This can only ever JOIN text that the compiler joins too, so it cannot
// manufacture a match across two unrelated literals -- and the CONTROL at the
// end of this section is what says the fragments are still the live wording
// rather than strings nothing emits any more.
const seamless = (text) => text.replace(/['"`]\s*\+\s*\n?\s*['"`]/g, '');
const allSource = sources.map((s) => seamless(s.text)).join('\n');
for (const phrase of ONCE) {
  const count = allSource.split(phrase).length - 1;
  const where = sources.filter((s) => seamless(s.text).includes(phrase)).map((s) => s.file);
  check(
    `${JSON.stringify(phrase.slice(0, 44))} occurs exactly once in src/`,
    count === 1,
    `${count} occurrence(s) in ${where.join(', ') || '(nowhere)'}`
  );
}
check(
  'and that one site is router.ts, where the composing function lives',
  ONCE.every((phrase) =>
    sources.every((s) => !seamless(s.text).includes(phrase) || s.file === 'router.ts')
  ),
  sources
    .filter((s) => s.file !== 'router.ts' && ONCE.some((p) => seamless(s.text).includes(p)))
    .map((s) => s.file)
    .join(', ')
);
// The renderer is the surface most likely to grow its own copy, because it is
// where the text is finally seen -- so it is named rather than left to the
// check above.
const cli = sources.find((s) => s.file === 'cli.ts');
check(
  'cli.ts writes none of them: it prints the daemon\'s sentence and does not own it',
  ONCE.every((phrase) => !seamless(cli.text).includes(phrase))
);
// CONTROL. Without it the four greens above are satisfied by a search that
// cannot match -- a renamed constant, a reflowed string literal, a phrase this
// list has fallen behind. This one is drawn from the RESPONSE rather than from
// the source, so it can only pass if the fragments are still the text the
// daemon actually emitted.
check(
  'CONTROL: every fragment above is present in a reading this run produced, so the counts\n' +
    '        are about live text rather than about strings nothing emits any more',
  ONCE.every((phrase) => Object.values(readings).some((r) => r.includes(phrase))),
  ONCE.filter((phrase) => !Object.values(readings).some((r) => r.includes(phrase))).join(' | ')
);

// ---------------------------------------------------------------------------
console.log(`\n${failures.length ? `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}` : 'ALL PASS'}`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} finally {
  process.env.PATH = realPath;
}
process.exit(failures.length ? 1 : 0);
