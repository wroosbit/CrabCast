#!/usr/bin/env node
/**
 * `crabcast` — the command line for the daemon.
 *
 * THE CLI IS A CLIENT, NOT A SECOND BRAIN (KAN-92 constraint 1). Everything
 * below is argument parsing, one socket round trip, and rendering. It never
 * computes capacity, decides preemption, or infers whether an agent is alive:
 * the daemon owns all of that, and a CLI that reproduced any of it would be a
 * second copy of a rule — the copy that is wrong after the daemon changes.
 *
 * IT NEVER INVENTS SUCCESS (constraint 2). What is printed is what the daemon
 * said. The renderers below read the response through {@link ResponseReader},
 * which tracks every field they touch and prints whatever they did not, so a
 * field this daemon grows tomorrow surfaces instead of vanishing. Capacity
 * derivations are printed verbatim and unindented — the figures are the
 * product (KAN-71), and text a reader cannot paste back into an argument has
 * already been summarised away.
 *
 * `--json` prints the daemon's response exactly as it arrived, including the
 * `id` this invocation used to correlate it. Nothing is dropped, renamed,
 * reordered or added: a script parsing that output is looking at the wire.
 *
 * Exit codes are part of the contract (constraint 5), because a shell script
 * has to tell a refusal from a daemon it could not reach — see {@link EXIT}.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ConfigError,
  DEFAULT_DATA_DIR,
  loadConfig,
  resolveConfigSource
} from './config.js';
import {
  SPAWN_ERR_FILENAME,
  connectToDaemon,
  onJsonLines,
  socketPathFor,
  writeJsonLine
} from './ipc.js';
import { HERDR_VERSION_NOTICE_FIELD } from './herdr-health.js';
import { MAX_PROMPT_CHARS } from './router.js';

// ---------------------------------------------------------------- exit codes

/**
 * What the shell learns from `$?`.
 *
 * The distinction that matters most is 1 against 3: "the daemon considered
 * this and said no" and "there was nobody to ask" are different facts, and a
 * script that retries the second must not retry the first. 4 is split out
 * from 3 for the same reason one step earlier — a config that would not load
 * never reached a socket at all, and telling an operator their daemon is
 * unreachable when their config has a typo sends them to the wrong file.
 */
export const EXIT = {
  /** The daemon answered `success: true`. */
  OK: 0,
  /** The daemon answered `success: false` — a refusal, an error, a miss. */
  REFUSED: 1,
  /** Bad arguments: unknown command, missing operand, malformed flag. */
  USAGE: 2,
  /** Could not reach or spawn the daemon; nothing was asked of it. */
  TRANSPORT: 3,
  /** A config that was named would not load. Nothing was attempted. */
  CONFIG: 4
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

class UsageError extends Error {}
class TransportError extends Error {}

// --------------------------------------------------------- the command table

/** One positional operand of a command. */
export interface PositionalSpec {
  name: string;
  required: boolean;
  /**
   * Joins every remaining operand with a single space, and **stops flag
   * parsing** where it begins — see {@link restStartsAt}. Only `send`'s
   * message uses it, so `crabcast send demo run the tests` does what it looks
   * like it does, and so does `crabcast send demo --help`, which sends the
   * text `--help`.
   *
   * The consequence, and it is the whole trade: a flag written *after* the
   * message is message text. `crabcast send demo hi --type shell` sends
   * "hi --type shell". Flags for a `rest` command go before the operands
   * (`crabcast send --type shell demo hi`), the help says so, and a message
   * that contains something spelled like one of that command's own flags gets
   * a note on stderr rather than being silently mistaken for one.
   *
   * Quoting does **not** help with a leading dash — `"--help"` reaches the
   * parser as `--help`, quotes consumed by the shell. That is why the stop
   * rule exists rather than a documented workaround; `--` also still works
   * and is documented in `--help`.
   */
  rest?: boolean;
  help: string;
}

/**
 * One flag of a command.
 *
 * `boolean` flags are `--flag` (true) or `--flag=true|false`, and nothing
 * else. `--override=yes` is a usage error rather than a guess: the router
 * refuses a non-boolean `override`/`preempt` before it looks anything up
 * (invalidFlag, router.ts), because both flags decide what happens to agents
 * other than this one, and a CLI that guesses at them is exactly the client
 * that check exists to catch.
 */
export interface FlagSpec {
  name: string;
  kind: 'string' | 'number' | 'boolean';
  /** Placeholder shown in help for value-taking flags. */
  value?: string;
  help: string;
}

/** Everything parsed off the command line for one invocation. */
export interface ParsedInvocation {
  positionals: string[];
  flags: Record<string, string | number | boolean>;
}

export interface CommandSpec {
  /** The subcommand as typed. */
  name: string;
  /** The `action` sent over the socket. */
  action: string;
  /**
   * The `action` the daemon puts on its reply, or null when it sets none.
   *
   * Recorded rather than used: this client correlates by `id` and nothing else
   * (see {@link DaemonClient}). Every reply carries a label as of KAN-122 —
   * `daemon_status` was the last one that did not — and correlating on those
   * labels would still be wrong, because the same socket also carries
   * unsolicited broadcasts (`agent.lost`, `agent.detached`) and
   * nothing about an action name distinguishes somebody's answer from
   * somebody else's event. The field is here for the parity check, which
   * verifies each recorded label against the router that sends it.
   */
  responseAction: string | null;
  summary: string;
  positionals: PositionalSpec[];
  flags: FlagSpec[];
  /**
   * Whether this command will start a daemon that is not running.
   *
   * Mutating commands do; read-only commands do not. Spawning the daemon runs
   * its boot reconcile (reconcile.ts), which re-activates every agent the
   * durable registry expects to be running — a real fleet-sized side effect,
   * and not one anybody asked for by typing `crabcast list`. The mutating
   * commands are already asking the machine to change, and refusing to stand
   * an agent down because the daemon died — while the agent itself is very
   * much alive in its herdr pane — would be the worse answer.
   *
   * A no-spawn command also answers immediately when there is no daemon:
   * connectToDaemon's retry budget is 0 without `spawnIfMissing` (KAN-88), so
   * the first refused connect is the final answer rather than five seconds of
   * re-asking a question nobody is going to change the answer to.
   */
  spawnsDaemon: boolean;
  /** Build the request payload (without `action` or `id`). */
  build(input: ParsedInvocation): Record<string, unknown>;
  /**
   * Render the daemon's response for a human.
   *
   * `request` is what this invocation asked, and it is used for one thing
   * only: naming the agent in the heading when the response does not repeat
   * the address back (`reset_response` does not, and a failed `agent_status`
   * cannot). That is the CLI reporting its own question, never the daemon's
   * answer — every claim about the world below the heading comes from the
   * reader and nowhere else.
   */
  render(reader: ResponseReader, request: Record<string, unknown>): string;
}

// ------------------------------------------------------------ reading a reply

/**
 * A response, read field by field, with the leftovers kept.
 *
 * Renderers pull what they know how to show through `take`. Whatever is left
 * when they are done is printed anyway, under a heading that says where it
 * came from. This is the structural answer to "print what the daemon said":
 * a field nobody wrote a renderer for is *visible* rather than silently
 * dropped, and the day the daemon starts sending `durabilityError` on a path
 * that never sent one, the human running the CLI sees it.
 */
export class ResponseReader {
  private readonly unread = new Set<string>();

  constructor(public readonly res: Record<string, any>) {
    for (const key of Object.keys(res)) this.unread.add(key);
    // Framing rather than content: `id` is this invocation's own correlation
    // token echoed back, `action` names the handler that answered, and
    // `success` is rendered by every renderer's first line.
    for (const framing of ['id', 'action', 'success']) this.unread.delete(framing);
  }

  take<T = any>(key: string): T {
    this.unread.delete(key);
    return this.res[key] as T;
  }

  /** Mark a field handled without reading it (it was shown some other way). */
  seen(...keys: string[]): void {
    for (const key of keys) this.unread.delete(key);
  }

  has(key: string): boolean {
    return this.res[key] !== undefined;
  }

  get success(): boolean {
    return this.res.success === true;
  }

  leftovers(): Array<[string, unknown]> {
    return [...this.unread].map((key) => [key, this.res[key]] as [string, unknown]);
  }
}

// ------------------------------------------------------------------ rendering

const INDENT = '  ';

function lines(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

function indent(text: string, prefix = INDENT): string {
  return text
    .split('\n')
    .map((l) => (l.length ? prefix + l : l))
    .join('\n');
}

function field(label: string, value: unknown, width = 14): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${INDENT}${(label + ':').padEnd(width)} ${String(value)}`;
}

/**
 * The agent this invocation is about, for a heading.
 *
 * The response's own path wins whenever it carries one — it is the daemon
 * saying which agent it acted on, and it is the CANONICAL form, which is not
 * always what the caller typed (a relative path, a symlink, a trailing slash).
 * The request fills the gap only when the daemon sent none, which is a refusal
 * that never got as far as resolving one.
 */
function addressed(reader: ResponseReader, request: Record<string, unknown>): string {
  const p = reader.take('path') ?? request.path;
  return typeof p === 'string' && p ? p : '(no path)';
}

/**
 * A block of daemon-authored prose, printed verbatim and unindented.
 *
 * Unindented deliberately. A capacity derivation is arithmetic somebody is
 * meant to be able to check by hand and quote back — into a ticket, into an
 * argument about a cap — and shifting every line by two spaces makes the
 * printed text differ from the text the daemon produced. Verbatim means the
 * bytes, not the gist.
 */
function verbatim(label: string, text: unknown): string | null {
  if (typeof text !== 'string' || !text.length) return null;
  return `\n${label}\n${text}`;
}

/** The `durable: false` pair, wherever it appears. Never a plain success. */
function durability(reader: ResponseReader): string | null {
  const durable = reader.take('durable');
  const error = reader.take('durabilityError');
  if (durable !== false && error === undefined) return null;
  return lines(
    `\n! NOT DURABLY RECORDED — the daemon's registry write failed.`,
    `${INDENT}${error ?? '(no reason given)'}`,
    `${INDENT}The agent is as reported right now; a daemon restart will not know about it.`
  );
}

/**
 * Everything CrabCast wrote outside its own data directory, printed at the
 * person whose directory it is.
 *
 * NOT OPTIONAL AND NOT ABBREVIATED. The whole argument for writing anything
 * into somebody's repository is that they are told about it in the same breath;
 * a renderer that dropped this to save four lines would make the daemon's
 * disclosure true and the product's disclosure false. `forget` is named per
 * artifact rather than once at the bottom, because a pre-existing trust entry
 * is NOT undone by it and printing one blanket sentence would claim otherwise.
 */
function provisionedBlock(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  return lines(
    `\nwritten outside CrabCast's own data directory:`,
    ...value.flatMap((a: any) => [
      `${INDENT}${a.file}`,
      `${INDENT}  ${a.detail}`,
      `${INDENT}  ${a.origin === 'crabcast' ? 'written by CrabCast' : 'ALREADY THERE — not ours'}; undo: ${a.reversal}`
    ])
  );
}

/** Whatever the renderer above did not claim. */
function residue(reader: ResponseReader): string | null {
  const rest = reader.leftovers();
  if (!rest.length) return null;
  return lines(
    `\nother fields in the daemon's response:`,
    ...rest.map(([key, value]) => `${INDENT}${key}: ${compact(value)}`)
  );
}

function compact(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value, null, 2);
  return json === undefined ? String(value) : indent(json, INDENT).trimStart();
}

/** The first line of any failed response, and the daemon's own error text. */
function failure(reader: ResponseReader, what: string): string {
  const error = reader.take<string>('error');
  return lines(
    `FAILED: ${what}`,
    error ? `\n${error}` : `${INDENT}(the daemon reported failure without an error message)`
  );
}

// ------------------------------------------------------------ capacity blocks

/**
 * The capacity DTO, rendered as figures. The derivation is separate and
 * verbatim; this is the summary line a reader skims first.
 */
/**
 * Every field of `capacityDto` (router.ts), so this block can be checked
 * against the object it is handed and so the flat `capacity_response` can
 * mark exactly these read.
 */
const CAPACITY_FIELDS = [
  'cap', 'running', 'exemptAgents', 'headroom', 'atCapacity', 'capBoundBy',
  'headroomBoundBy', 'reason', 'cores', 'load1', 'totalMb', 'availableMb',
  'agentMemoryMb', 'agentCores', 'agentMemorySource', 'agentCoresSource',
  'measuredAt', 'measuredWindowSeconds', 'measuredAgentTrees', 'capByCpu',
  'capByMemory', 'headroomByCap', 'headroomByLoad', 'headroomByMemory', 'summary'
] as const;

function capacityBlock(capacity: any): string | null {
  if (!capacity || typeof capacity !== 'object') return null;
  const numbers =
    `${INDENT}cap ${capacity.cap} (bound by ${capacity.capBoundBy}) · ` +
    `running ${capacity.running} · exempt ${capacity.exemptAgents} · ` +
    `headroom ${capacity.headroom} (bound by ${capacity.headroomBoundBy})` +
    (capacity.atCapacity ? ' · AT CAPACITY' : '');

  // The terms behind the two bound-by verdicts, and the machine they were
  // read off. `activate` refusals and `capacity` also carry a derivation that
  // spells this out in prose, but `list_agents` ships no derivation — so on
  // `crabcast list` these nine figures were reaching nobody: this block was
  // handed the whole object, which marked it read, so the residue guard could
  // not surface what the block itself left out. A guard that can be silenced
  // by the code it guards is not a guard.
  const terms = `${INDENT}cap terms: cpu allows ${capacity.capByCpu}, memory allows ${capacity.capByMemory}` +
    `  ·  headroom terms: count allows ${capacity.headroomByCap}, ` +
    `load allows ${capacity.headroomByLoad}, memory allows ${capacity.headroomByMemory}`;
  const machine =
    `${INDENT}machine: ${capacity.cores} cores, load ${capacity.load1}, ` +
    `${capacity.availableMb} MB available of ${capacity.totalMb} MB`;

  // Anything capacityDto grows that this block has not been taught. Nested
  // objects are outside the top-level reader's reach, so they get their own
  // leftovers pass rather than none.
  const unknown = Object.keys(capacity).filter(
    (key) => !(CAPACITY_FIELDS as readonly string[]).includes(key)
  );

  return lines(
    capacity.summary ? `${INDENT}${capacity.summary}` : null,
    numbers,
    capacity.reason ? `${INDENT}reason: ${capacity.reason}` : null,
    terms,
    machine,
    `${INDENT}agent cost: ${capacity.agentMemoryMb} MB (${capacity.agentMemorySource}), ` +
      `${capacity.agentCores} core (${capacity.agentCoresSource})` +
      (capacity.measuredAt
        ? `, measured over ${capacity.measuredWindowSeconds}s across ` +
          `${capacity.measuredAgentTrees} tree(s) ending ${capacity.measuredAt}`
        : ''),
    ...unknown.map((key) => `${INDENT}${key}: ${compact(capacity[key])}`)
  );
}

function priorityRows(priorities: any): string | null {
  if (!Array.isArray(priorities) || !priorities.length) return null;
  return lines(
    `\npriorities — what an activation would have to strictly outrank:`,
    ...priorities.map(
      (p: any) => `${INDENT}${p.path}  priority ${p.priority}  [${p.herdrStatus}]`
    )
  );
}

/** The `preemption` offer that rides on a capacity refusal. */
function preemptionOffer(offer: any): string | null {
  if (!offer || typeof offer !== 'object') return null;
  return lines(
    `\npreemption available — this activation outranks a running agent:`,
    field('agent', offer.path),
    field('pane', offer.paneName),
    field('priority', `${offer.priority} against this activation's ${offer.incomingPriority}`),
    field('herdr status', offer.herdrStatus),
    // The daemon's own sentence about what would be stood down and what
    // authorises it. This is what a client turns into a named button, and
    // the presence of it in the payload is what the consent rule is
    // satisfied by — paraphrasing it would be answering for the human.
    offer.offer ? `${INDENT}${offer.offer}` : null,
    `${INDENT}Pass --preempt to authorise it. Its uncommitted work is interrupted.`
  );
}

// ------------------------------------------------------------- fleet sections

/**
 * A clipped fleet list with its unclipped total.
 *
 * The total is printed whether or not it exceeds the list, and when it does
 * the difference is spelled out. A list that silently stopped at the cap
 * reads as "that is all of them", which is the one conclusion a reader must
 * not draw wrongly about work that has stopped without anyone noticing —
 * which is exactly what `missingAgents` is.
 */
function categoryHeading(label: string, rows: unknown, total: unknown, gloss: string): string {
  const shown = Array.isArray(rows) ? rows.length : 0;
  const count = typeof total === 'number' ? total : shown;
  const clipped = count > shown ? ` — showing ${shown}, ${count - shown} older not shown` : '';
  return `\n${label} (${count})${clipped}${count ? ` — ${gloss}` : ''}`;
}

/** The three gate flags, printed only where they differ from the safe default. */
function gateFlags(a: any): string {
  const off = (['refusable', 'chargeable', 'preemptable'] as const).filter((f) => a[f] === false);
  return off.length ? `  ${off.map((f) => `not-${f}`).join(' ')}` : '';
}

/**
 * Every field of a `config` block (types.ts, AgentConfig), so this renderer can
 * be checked against the object it is handed.
 *
 * The same guard `CAPACITY_FIELDS` exists for, and for a sharper reason: this
 * block is the whole point of the state read, so a knob `configure` grows that
 * nothing here prints would be a field the CLI silently drops from the one
 * surface a human uses to check what an agent is running with. The top-level
 * residue guard cannot see it — nested objects are outside its reach — so the
 * block does its own leftovers pass.
 */
const CONFIG_FIELDS = [
  'priority', 'refusable', 'chargeable', 'preemptable', 'launcher',
  'prompt', 'mcpServers', 'label'
] as const;

/**
 * The MCP server names on a config block, with the builtin ones marked.
 *
 * Tolerates the shape it is handed rather than assuming one: `mcpServers` was
 * an array of names and is now a map of definitions (KAN-111), and a renderer
 * that assumed either would print nothing for the other — silently, which is
 * the one outcome the config echo must not produce. Empty string means there
 * is nothing to print, which is different from a shape this did not recognise.
 */
function mcpServerNames(servers: unknown): string {
  if (!servers || typeof servers !== 'object') return '';
  if (Array.isArray(servers)) return servers.map((s) => String(s)).join(', ');
  return Object.entries(servers as Record<string, unknown>)
    .map(([name, spec]) => (spec === 'builtin' ? `${name} (builtin)` : name))
    .join(', ');
}

/**
 * An agent's frozen configuration, as read back from the durable record.
 *
 * `null` is printed rather than skipped: a row with no record is saying
 * something, and a renderer that prints nothing for it looks identical to one
 * that has not been taught about the field.
 */
function configBlock(row: any, pad = INDENT + INDENT): string | null {
  const config = row?.config;
  if (config === undefined) return null;
  if (config === null) {
    return `${pad}config: (none — no durable record backs this row)`;
  }

  const unknown = Object.keys(config).filter(
    (key) => !(CONFIG_FIELDS as readonly string[]).includes(key)
  );

  return lines(
    `${pad}config v${row.configVersion ?? '?'}` +
      (row.configuredAt ? ` frozen ${row.configuredAt}` : ' (configured before versions were recorded)') +
      `: priority ${config.priority}, launcher ${config.launcher}, ` +
      `refusable ${config.refusable}, chargeable ${config.chargeable}, ` +
      `preemptable ${config.preemptable}`,
    // The size, not the text: a prompt is finished bytes of arbitrary length
    // and reprinting it here would bury every other field.
    typeof config.prompt === 'string'
      ? `${pad}prompt: ${config.prompt.length} characters`
      : `${pad}prompt: (none — it starts at its runtime's own prompt)`,
    // A MAP of definitions keyed by name, not the array of names it used to
    // be (KAN-111). Rendered as the names plus which of them CrabCast builds
    // itself, because the definitions are the caller's own JSON and printing
    // them in full would bury every other field — `crabcast status --json` and
    // the agent's own `.mcp.json` are where the bytes can be read.
    //
    // The `Array.isArray` this replaced would have gone quietly false against
    // the new shape and printed NOTHING, which is the failure this whole block
    // exists to prevent: a field the daemon answered and the CLI dropped.
    mcpServerNames(config.mcpServers)
      ? `${pad}mcp servers: ${mcpServerNames(config.mcpServers)}`
      : null,
    config.label !== undefined ? `${pad}label: ${config.label}` : null,
    // The fact that decides what the next activation does. Only where the
    // daemon answered it: absent is not `false`, and printing anything for a
    // field nobody sent would be inventing the answer.
    //
    // PHRASED AS A STATEMENT ABOUT THE RECORD, not about the world. It used to
    // read "this agent has never run", which is a claim the record cannot
    // support: `everActivated` is whether CRABCAST'S LOG carries an activation
    // at this path, and a live agent whose durable write failed has run without
    // the log knowing. The old wording put that agent's row under a sentence
    // that was simply false about it.
    typeof row.everActivated === 'boolean'
      ? `${pad}next activate: ${row.everActivated
          ? 'RESUMES the conversation it was stopped in (this path has a recorded activation)'
          : 'starts FRESH — no activation recorded at this path'}`
      : null,
    ...unknown.map((key) => `${pad}${key}: ${compact(config[key])}`)
  );
}

/**
 * {@link configBlock} over a whole response, marking the four fields it read.
 *
 * The pairing is the point: a renderer that printed the block and forgot to
 * mark the fields would print each of them twice — once here and once in the
 * residue — and one that marked them without printing would hide them
 * entirely, which is precisely what the residue guard exists to prevent.
 */
function configBlockSeen(reader: ResponseReader, pad?: string): string | null {
  const block = configBlock(reader.res, pad);
  reader.seen('config', 'configVersion', 'configuredAt', 'everActivated');
  return block;
}

/**
 * Which of the fields above the daemon holds on disk and which it read a
 * moment ago.
 *
 * Printed rather than dropped because it is the answer to a question a reader
 * of this output will otherwise answer wrongly: `pane id` looks exactly as
 * durable as `priority` on a terminal, and it is not — herdr renumbers panes
 * whenever any pane anywhere closes. A reader who copies one into a script has
 * copied a value with a shelf life.
 */
function provenanceBlock(p: any): string | null {
  if (!p || typeof p !== 'object') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '(none)');
  return lines(
    `\nwhere these fields came from — read at ${p.observedAt}` +
      (p.censusReachable === false
        ? ', and herdr DID NOT ANSWER, so every observed field below is unread rather than false'
        : ''),
    `${INDENT}durable  (from the registry, survives a restart): ${list(p.durable)}`,
    `${INDENT}observed (read from herdr just now):              ${list(p.observed)}`,
    `${INDENT}derived  (computed from the two):                 ${list(p.derived)}`
  );
}

function agentRow(a: any): string {
  const head =
    `${INDENT}${a.path}  [${a.herdrStatus}]` +
    (a.agentRuntime ? `  runtime ${a.agentRuntime}` : '  runtime (none reported)') +
    gateFlags(a);
  const session = a.sessionless
    ? `${INDENT}${INDENT}no session held by this daemon (sessionless) — pane ${a.paneName}`
    : `${INDENT}${INDENT}session ${a.sessionId} (${a.status}), created ${a.createdAt}`;
  return lines(
    head,
    session,
    // The label is not printed here: it is part of the configuration, and
    // `configBlock` prints the whole of that. Two identical lines is how a
    // reader learns to skim past one of them.
    a.paneId ? `${INDENT}${INDENT}pane ${a.paneName} (${a.paneId})` : null,
    configBlock(a)
  );
}

// -------------------------------------------------------------- the renderers

function renderActivate(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);

  if (!reader.success) {
    // The refusal fields, each one named because a client that shows none of
    // this leaves the user at a dead switch (router.ts). `error` already
    // contains the derivation for a capacity refusal; the block below prints
    // it a second time only when it does not, so the guarantee holds whatever
    // the daemon puts in `error`.
    const error = reader.res.error;
    const derivation = reader.take<string>('derivation');
    const alreadyInError =
      typeof error === 'string' && typeof derivation === 'string' && error.includes(derivation);
    const capacity = capacityBlock(reader.take('capacity'));
    return lines(
      failure(reader, `activate ${what}`),
      field('refused by', reader.take('refusedBy') ?? reader.take('refused')),
      field('reason', reader.take('reason')),
      field('priority', reader.take('priority')),
      reader.take('started') === false
        ? `${INDENT}started:       false — NOTHING was spawned`
        : null,
      reader.take('verified') === false
        ? `${INDENT}verified:      false — the daemon could not confirm the agent exists`
        : null,
      occupiedBlock(reader.take('occupiedBy')),
      missingKnobs(reader.take('missing')),
      alreadyInError ? null : verbatim('derivation:', derivation),
      capacity ? `\ncapacity:\n${capacity}` : null,
      preemptionOffer(reader.take('preemption')),
      durability(reader),
      residue(reader)
    );
  }

  const preempted = reader.take('preempted');
  const override = reader.take('capacityOverride');
  if (reader.take('alreadyRunning') === true) {
    // Not an error and not a second pane: the agent this call asked for is
    // running, which is what the caller wanted. Said in words because
    // "activated" would claim something happened.
    reader.take('started');
    return lines(
      `${what} is already running — nothing was started`,
      field('pane', `${reader.take('paneName')} (${reader.take('paneId')})`),
      field('verified', reader.take('verified')),
      // What this call did NOT change, read back from the record: the
      // idempotent activation is the read a reconciler makes most often, so
      // it prints the same block the spawning branch does rather than being
      // the one answer that says less.
      configBlockSeen(reader, INDENT),
      // The one thing this call DID change. Printed, because a repair the
      // user cannot see is indistinguishable from no repair at all.
      reader.take('recordReconciled') === true
        ? `${INDENT}record:        reconciled — the durable record did not say this agent was ` +
          `running and now does, so a restart will restore it`
        : null,
      durability(reader),
      // A stranger sharing the directory does not make this a refusal, but it
      // is never swallowed: two agents in one directory is what the whole
      // occupancy guard exists to make visible.
      occupiedBlock(reader.take('occupiedBy')),
      (() => {
        const note = reader.take<string>('note');
        return note ? `\n${note}` : null;
      })(),
      residue(reader)
    );
  }
  reader.take('started');
  const echo = configBlockSeen(reader, INDENT);
  return lines(
    `activated ${what}`,
    field('session', `${reader.take('sessionId')} (${reader.take('status')})`),
    field('pane', `${reader.take('paneName')} (${reader.take('paneId')})`),
    field('created', reader.take('createdAt')),
    field('priority', reader.take('priority')),
    field('launcher', reader.take('launcher')),
    echo,
    // `verified: true` is the difference between this response and a false
    // success (KAN-23): the agent was found in herdr's census before the
    // daemon answered. Printed rather than assumed.
    field('verified', reader.take('verified')),
    field('resumed', reader.has('resume')
      ? `${reader.take('resume')} (conversation restored: ${reader.take('resumedConversation')})`
      : null),
    // THE RESUME RULE, said out loud on every activation rather than only when
    // it bites. "started a new conversation" is the sentence that tells a
    // person their own session in this directory was left alone — and the
    // absence of that sentence is what would have hidden the opposite.
    field('conversation', reader.take('resumedExistingConversation') === true
      ? 'continued the one CrabCast last ran here'
      : 'started a NEW one — CrabCast has not run an agent in this directory before, so ' +
        'nothing on disk here was continued'),
    provisionedBlock(reader.take('provisioned')),
    durability(reader),
    // `preempted` is `{ at, victim, derivation }` — the victim named, not
    // just a count. Whose work this activation ended is the part a caller
    // most needs and the part it is easiest to render away.
    preempted
      ? lines(
          `\npreempted to make room — somebody else's work was interrupted:`,
          `${INDENT}${preempted.victim?.path} ` +
            `(${preempted.victim?.paneName}), priority ${preempted.victim?.priority}, ` +
            `herdr status ${preempted.victim?.herdrStatus} — stood down at ${preempted.at}`,
          preempted.victim?.offer ? `${INDENT}${preempted.victim.offer}` : null,
          `${INDENT}It is reported as preempted by \`crabcast list\` until somebody puts it back.`,
          verbatim('the capacity figures that justified it:', preempted.derivation)
        )
      : null,
    override
      ? lines(
          `\nstarted past the cap on purpose (--override) at ${override.at} —`,
          `${INDENT}the machine is now carrying more than it says it can. Recorded with these figures:`,
          capacityBlock(override.capacity),
          verbatim('the derivation the override bypassed:', override.derivation)
        )
      : null,
    residue(reader)
  );
}

function renderDeactivate(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);
  const alreadyGone = reader.take('alreadyGone');
  const wasRunning = reader.take('wasRunning');
  const state = reader.take('state');
  const note = reader.take('note');
  if (!reader.success) {
    return lines(
      failure(reader, `deactivate ${what}`),
      field('refused', reader.take('refused')),
      durability(reader),
      residue(reader)
    );
  }
  return lines(
    // Never a bare "deactivated": the daemon distinguishes an agent it stopped
    // from one that was already down and from one that never ran, and
    // flattening the three here would answer a question the daemon refused to.
    wasRunning === false
      ? `${what} was not running${state ? ` — ${state}` : ''}`
      : `deactivated ${what}${state ? ` — now ${state}` : ''}`,
    note ? `${INDENT}${note}` : null,
    field('pane', reader.take('paneName')),
    field('session', reader.take('sessionId')),
    alreadyGone ? `${INDENT}alreadyGone:   true` : null,
    reader.take('preempted') ? `${INDENT}preempted:     true (stood down to free capacity)` : null,
    durability(reader),
    residue(reader)
  );
}

/** The advisory/refusal list of panes sitting in the target directory. */
function occupiedBlock(occupants: unknown): string | null {
  if (!Array.isArray(occupants) || !occupants.length) return null;
  return lines(
    `\nlive panes already in that directory (${occupants.length}):`,
    ...occupants.map(
      (o: any) =>
        `${INDENT}pane_id ${o.paneId ?? '(not reported)'}  name ${o.name}  ` +
        `[${o.agentStatus}]${o.workDir ? `  cwd ${o.workDir}` : ''}`
    )
  );
}

/** Which `configure` knobs the daemon says are missing. */
function missingKnobs(missing: unknown): string | null {
  if (!Array.isArray(missing) || !missing.length) return null;
  return `${INDENT}missing:       ${missing.join(', ')}`;
}

/**
 * What this call did to each knob, one line each.
 *
 * PRINTED IN FULL, INCLUDING THE UNCHANGED ONES, and that is the point rather
 * than verbosity. `configure` takes one desired-state document, so a reader
 * asking "did my change land" is really asking about every field they sent —
 * and the answer that matters most is the one this task exists to make
 * impossible to fake: a knob that was REFUSED beside one that was WITHHELD
 * beside one that was applied. Printing only the interesting ones would let a
 * half-applied call look like a clean one at a glance, which is the defect.
 */
const OUTCOME_GLOSS: Record<string, string> = {
  'unchanged': 'unchanged — the value sent is the value it already had',
  'applied-in-place': 'APPLIED IN PLACE — live now, nothing was respawned',
  'applied': 'applied — takes effect at the next activate',
  'refused-restart-required': 'REFUSED — cannot change under a running agent',
  'withheld': 'withheld — would have applied in place; nothing was, this call is atomic'
};

function outcomesBlock(outcomes: unknown): string | null {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) return null;
  const rows = Object.entries(outcomes as Record<string, string>);
  if (!rows.length) return null;
  const width = Math.max(...rows.map(([name]) => name.length));
  return lines(
    '\nper knob:',
    ...rows.map(
      ([name, outcome]) =>
        `${INDENT}${name.padEnd(width)}  ${OUTCOME_GLOSS[outcome] ?? outcome}`
    )
  );
}

function renderConfigure(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);
  if (!reader.success) {
    const attributes = reader.take<string[]>('attributes');
    const withheld = reader.take<string[]>('withheld');
    // Read rather than rendered a second time: the daemon's error already
    // names each attribute and its reason, in a sentence a caller can act on.
    reader.seen('reasons', 'changed');
    return lines(
      failure(reader, `configure ${what}`),
      field('refused', reader.take('refused')),
      missingKnobs(reader.take('missing')),
      field('attributes', Array.isArray(attributes) ? attributes.join(', ') : null),
      reader.take('applied') !== undefined
        ? `${INDENT}applied:       nothing — configure is all-or-nothing`
        : null,
      // NAMED SEPARATELY FROM THE REFUSED ONES. These could have moved and did
      // not, and a caller who cannot tell the two apart cannot tell whether
      // re-sending the in-place knobs alone would work.
      field('withheld', Array.isArray(withheld) && withheld.length ? withheld.join(', ') : null),
      // UNCHANGED, and said so: nothing was applied, so the version the caller
      // already holds is still current.
      field(
        'version',
        reader.take('configVersion') === undefined
          ? null
          : `${reader.res.configVersion} — unchanged, because nothing was applied`
      ),
      configBlockSeen(reader, INDENT),
      field('pane', reader.take('paneId')),
      outcomesBlock(reader.take('outcomes')),
      // The three calls that would do what the caller asked, verbatim from the
      // daemon. The CLI does not compose this sentence: which verbs undo a
      // restart-required change is the daemon's rule, and a copy here is the
      // copy that is wrong after it changes.
      reader.take('remedy') ? `\nremedy: ${reader.res.remedy}` : null,
      durability(reader),
      residue(reader)
    );
  }
  const config = reader.take<any>('config') ?? {};
  const occupied = reader.take('occupiedBy');
  const note = reader.take('note');
  const version = reader.take('configVersion');
  const previous = reader.take('previousConfigVersion');
  const changed = reader.take<string[]>('changed');
  const appliedInPlace = reader.take('appliedInPlace');
  // `applied` duplicates `changed` on this path and `withheld` is empty by
  // construction; the per-knob block below says both, per knob.
  reader.seen('applied', 'withheld', 'running');
  const reconfigured = reader.take('reconfigured');
  return lines(
    `${reconfigured ? 'reconfigured' : 'configured'} ${what}`,
    field('pane name', reader.take('paneName')),
    // WHAT MOVED, on a success. An empty list is the useful answer rather than
    // a boring one: it says the document sent was already the configuration.
    //
    // On a FIRST configure the daemon reports every knob — there was no record,
    // so all of it was written — and naming all eight there would be noise
    // rather than information, so this says what that list means instead. The
    // per-knob block below still prints each one, and `--json` carries the
    // array either way: the summary is shortened, never the response.
    Array.isArray(changed)
      ? field(
          'changed',
          !reconfigured
            ? 'every knob — this call created the record'
            : changed.length
              ? `${changed.join(', ')}${appliedInPlace ? ' — IN PLACE, on the running agent' : ''}`
              : 'nothing — this document was already the configuration'
        )
      : null,
    field('pane', reader.take('paneId')),
    // The compare-and-set token, on the call that minted it. A caller
    // reconciling against this daemon needs it without a second read.
    field(
      'version',
      version === undefined
        ? null
        : `${version}${previous !== undefined ? ` (was ${previous})` : ''}` +
          `, frozen ${reader.take('configuredAt') ?? '(not reported)'}`
    ),
    field('priority', config.priority),
    field('launcher', config.launcher),
    field('gate', `refusable ${config.refusable}, chargeable ${config.chargeable}, preemptable ${config.preemptable}`),
    // The size, not the text. A prompt is finished bytes of arbitrary length
    // and reprinting it here would bury every other field; the sidecar is
    // where it can be read in full.
    field('prompt', typeof config.prompt === 'string'
      ? `${config.prompt.length} characters (written to the agent's sidecar verbatim)`
      : null),
    // NAMES ONLY. The definitions are the caller's own command lines and can
    // carry credentials in `env`; echoing them into a terminal — and into
    // whatever scrollback or CI log it lands in — is not something this
    // command needs to do to be useful.
    field('mcp servers', Object.keys(config.mcpServers ?? {}).join(', ') || null),
    field('label', config.label),
    // What activation will write into the caller's directory, said BEFORE
    // anything is written. This is what stands in for a consent flag: the
    // caller is told the consequence rather than asked to assert it.
    ...(reader.take<any[]>('willWrite') ?? []).map(
      (w) => `${INDENT}will write:    ${w.file} — ${w.keys.join(', ')} ${w.when}\n` +
             `${INDENT}               ${w.note}`
    ),
    reader.take('occupancyUnknown')
      ? `${INDENT}occupancy:     UNKNOWN — herdr did not answer, so nothing was checked`
      : null,
    occupiedBlock(occupied),
    outcomesBlock(reader.take('outcomes')),
    // OURS BY NAME, AND UNKNOWN TO THE RECORD. Printed above the daemon's
    // `note` rather than folded into it: it is the one thing on a successful
    // `configure` that changes what the NEXT command will do, and a caller who
    // reads it at `activate` instead has already adopted a pane they did not
    // mean to. The sentence is the daemon's, verbatim — which pane state means
    // what is its rule, and a copy here is the copy that goes stale.
    unrecordedPaneBlock(reader.take('unrecordedPane')),
    note ? `\n${note}` : null,
    durability(reader),
    residue(reader)
  );
}

function unrecordedPaneBlock(pane: unknown): string | null {
  if (!pane || typeof pane !== 'object') return null;
  const p = pane as any;
  return lines(
    `\nA LIVE PANE OF OURS IS ALREADY THERE, and nothing had been configured for it:`,
    `${INDENT}pane name:     ${p.paneName ?? '(not reported)'}` +
      (p.paneId ? `  (${p.paneId})` : ''),
    indent(String(p.meaning ?? ''), INDENT),
    p.remedy ? `${INDENT}remedy:        ${p.remedy}` : null
  );
}

function renderForget(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);
  if (!reader.success) {
    return lines(
      failure(reader, `forget ${what}`),
      field('refused', reader.take('refused')),
      field('pane', reader.take('paneId')),
      durability(reader),
      residue(reader)
    );
  }
  const existed = reader.take('existed');
  const removed = reader.take<string[]>('removed') ?? [];
  const left = reader.take<string[]>('left') ?? [];
  const note = reader.take('note');
  return lines(
    existed ? `forgot ${what}` : `${what} was not configured — nothing to forget`,
    removed.length ? `${INDENT}removed:       ${removed.join(', ')}` : null,
    // What was deliberately NOT removed, named rather than left for somebody
    // to find later.
    ...left.map((l) => `${INDENT}left in place: ${l}`),
    note ? `\n${note}` : null,
    durability(reader),
    residue(reader)
  );
}

function renderList(reader: ResponseReader): string {
  if (!reader.success) return lines(failure(reader, 'list agents'), residue(reader));

  const agents = reader.take<any[]>('agents') ?? [];
  const unbacked = reader.take<any[]>('unbackedPanes') ?? [];
  const foreign = reader.take<any[]>('foreignPanes') ?? [];
  const foreignTotal = reader.take('foreignPanesTotal');
  const missing = reader.take<any[]>('missingAgents') ?? [];
  const missingTotal = reader.take('missingTotal');
  const preempted = reader.take<any[]>('preemptedAgents') ?? [];
  const preemptedTotal = reader.take('preemptedTotal');
  const standby = reader.take<any[]>('standbyAgents') ?? [];
  const standbyTotal = reader.take('standbyTotal');
  const unstarted = reader.take<any[]>('unstartedAgents') ?? [];
  const unstartedTotal = reader.take('unstartedTotal');
  const provenance = reader.take('provenance');
  const capacity = reader.take('capacity');
  const priorities = reader.take('priorities');
  const health = reader.take('herdrHealth');

  return lines(
    `agents (${agents.length})`,
    ...(agents.length ? agents.map(agentRow) : [`${INDENT}(none)`]),

    unbacked.length
      ? lines(
          `\nunbacked panes (${unbacked.length}) — our panes, nothing behind them:`,
          ...unbacked.map((p: any) =>
            lines(
              `${INDENT}${p.path} (${p.paneName}) [${p.herdrStatus}] — ${p.reason}`,
              configBlock(p)
            )
          )
        )
      : null,

    // Live panes that are not ours. The rows carrying `occupies` are the ones
    // that will REFUSE an activation, so they are called out rather than left
    // for the refusal to introduce.
    foreign.length
      ? lines(
          categoryHeading(
            'foreign panes',
            foreign,
            foreignTotal,
            'live agents this daemon did not start'
          ),
          ...foreign.map((p: any) =>
            lines(
              `${INDENT}${p.paneName} [${p.herdrStatus}]  runtime ${p.agentRuntime}` +
                (p.paneId ? `  pane_id ${p.paneId}` : ''),
              p.workDir ? `${INDENT}${INDENT}cwd ${p.workDir}` : null,
              p.occupies
                ? `${INDENT}${INDENT}OCCUPIES ${p.occupies} — activating that agent will be refused ` +
                  `until this pane is gone`
                : null,
              // OUR agent for that directory, named as such. This pane has no
              // CrabCast configuration of its own and the block must not read
              // as though it did.
              p.occupiedAgent
                ? lines(
                    `${INDENT}${INDENT}the agent it is blocking (${p.occupiedAgent.state}):`,
                    configBlock(p.occupiedAgent, INDENT + INDENT + INDENT)
                  )
                : null
            )
          )
        )
      : null,

    // Always printed, even at zero: "no agents are missing" and "this daemon
    // does not track that" are different answers, and a reader cannot tell
    // them apart from a heading that was suppressed.
    lines(
      categoryHeading(
        'missing agents',
        missing,
        missingTotal,
        'recorded active, not running: their work has stopped while still looking staffed'
      ),
      ...(missing.length
        ? missing.map((m: any) =>
            lines(
              `${INDENT}${m.path} — since ${m.since}` + (m.label ? ` (${m.label})` : ''),
              `${INDENT}${INDENT}${m.reason}`,
              configBlock(m)
            )
          )
        : [`${INDENT}(none)`])
    ),

    lines(
      categoryHeading(
        'preempted agents',
        preempted,
        preemptedTotal,
        'stood down to free capacity, still owed a decision'
      ),
      ...(preempted.length
        ? preempted.map((p: any) =>
            lines(
              `${INDENT}${p.path} — at ${p.at}, priority ${p.priority}, ` +
                `for ${p.by?.path} (priority ${p.by?.priority})`,
              `${INDENT}${INDENT}${p.reason}`,
              configBlock(p),
              p.derivation ? verbatim(`the capacity figures that took it (${p.path}):`, p.derivation) : null
            )
          )
        : [`${INDENT}(none)`])
    ),

    lines(
      categoryHeading(
        'standby agents',
        standby,
        standbyTotal,
        'switched off on purpose, workspace still on disk'
      ),
      ...(standby.length
        ? standby.map((s: any) =>
            lines(
              `${INDENT}${s.path} — since ${s.since}` +
                (s.launcher ? `, launcher ${s.launcher}` : '') +
                (s.wasPreempted ? ' [its work was taken, not switched off]' : ''),
              `${INDENT}${INDENT}${s.reason}`,
              configBlock(s)
            )
          )
        : [`${INDENT}(none)`])
    ),

    // The fifth answer to "not running", and the one that used to appear
    // nowhere. Printed always, even at zero, for the same reason the others
    // are: a suppressed heading and an empty category look identical.
    lines(
      categoryHeading(
        'unstarted agents',
        unstarted,
        unstartedTotal,
        'configured and never run — activating one starts a FRESH conversation, ' +
          'unlike standby, where it resumes'
      ),
      ...(unstarted.length
        ? unstarted.map((u: any) =>
            lines(
              `${INDENT}${u.path} — configured ${u.since}` +
                (u.launcher ? `, launcher ${u.launcher}` : '') +
                (u.label ? ` (${u.label})` : ''),
              `${INDENT}${INDENT}${u.reason}`,
              configBlock(u)
            )
          )
        : [`${INDENT}(none)`])
    ),

    provenanceBlock(provenance),

    capacity ? lines('\ncapacity:', capacityBlock(capacity)) : null,
    priorityRows(priorities),

    health
      ? lines(
          `\nherdr health: ${health.openFds}/${health.softLimit} open files ` +
            `(${Math.round((health.fdPressure ?? 0) * 100)}%), room for about ` +
            `${health.headroomPanes} more panes (pid ${health.pid})`,
          // The warning is the whole reason this block is on a fleet list.
          health.warning ? `${INDENT}WARNING: ${health.warning}` : null
        )
      : null,

    residue(reader)
  );
}

function renderStatus(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);
  if (!reader.success) {
    // The record is on the refusal too, when there is one. `status` only fails
    // now for a path with neither a record nor a pane, so this branch is
    // ordinarily empty of config — but printing it when it is there is what
    // keeps "configured and not running" distinguishable from "no such agent".
    const echo = configBlockSeen(reader, INDENT);
    return lines(
      failure(reader, `status ${what}`),
      field('state', reader.take('state')),
      field('configured', reader.take('configured')),
      field('pane name', reader.take('paneName')),
      echo,
      // Rendered here too, not only on the success branch. It was landing in
      // the residue instead, which dumped twenty lines of raw JSON under
      // "other fields in the daemon's response" — the guard doing its job, and
      // the job it was pointing at was mine.
      provenanceBlock(reader.take('provenance')),
      residue(reader)
    );
  }

  const sessionless = reader.take('sessionless');
  const echo = configBlockSeen(reader, INDENT);
  return lines(
    `${what} — ${reader.take('herdrStatus')}`,
    // The category, first, because it is what a reader is asking for: running,
    // missing, standby, unstarted or preempted are five different situations
    // and only one of them is "fine".
    field('state', reader.take('state')),
    field('pane name', reader.take('paneName')),
    field('pane id', reader.take('paneId')),
    field('configured', reader.take('configured')),
    // `label` is inside the block below rather than on a line of its own: it
    // is one of the knobs, and printing it twice teaches a reader to skim.
    (reader.seen('label'), echo),
    // The sessionless shape is not a degraded answer, and must not read as
    // one: the agent is alive in herdr and this daemon simply does not hold
    // its session — which is every agent that outlived a daemon restart, and
    // exactly the agent a supervisor most needs to look at.
    sessionless
      ? `${INDENT}session:       none held by this daemon (sessionless: true — the agent outlived it, ` +
        `or was never ours). The session-only fields below are null because there is no session.`
      : null,
    field('session', reader.take('sessionId')),
    field('status', reader.take('status')),
    field('created', reader.take('createdAt')),
    field('pane cwd', reader.take('workDir')),
    // What herdr said when it was asked and had nothing. Evidence for the
    // second half of "configured and not running", rather than an error.
    field('herdr', reader.take('herdrNote')),
    provenanceBlock(reader.take('provenance')),
    residue(reader)
  );
}

function renderTail(reader: ResponseReader, request: Record<string, unknown>): string {
  const key = addressed(reader, request);
  if (!reader.success) return lines(failure(reader, `tail ${key}`), residue(reader));
  const text = reader.take<string>('text');
  const truncated = reader.take('truncated');
  return lines(
    `pane text for ${key}${truncated ? ' (truncated by herdr)' : ''}:`,
    // Verbatim: this is somebody's terminal, and a renderer that reflows it
    // is answering a different question than the one asked. An empty read is
    // said in words — an empty pane and a renderer that printed nothing look
    // identical otherwise, and only one of them is an answer.
    typeof text === 'string' && text.length
      ? text
      : `${INDENT}(the pane returned no text — herdr read it and it was empty)`,
    residue(reader)
  );
}

/**
 * The outcome of a send, WHICH IS NOT THE SAME SENTENCE AS BEFORE.
 *
 * This used to print "the message was typed into its terminal and Enter
 * pressed" on `success: true` — an accurate description of what the daemon did
 * and a description of nothing at all about the agent. The daemon now answers
 * with a verdict read off the pane, so this prints the verdict.
 *
 * `unverifiable` gets its own branch rather than being folded into the failure
 * line, because a human reading "FAILED" reaches for the resend and that is the
 * wrong move: the message may already be in front of the agent.
 */
function renderSend(reader: ResponseReader, request: Record<string, unknown>): string {
  const key = addressed(reader, request);
  const verdict = reader.take<string>('verdict');
  const delivered = reader.take<boolean>('delivered');
  const evidence = reader.take<Record<string, any>>('evidence');
  const interrupts = reader.take<number>('interrupts');
  const submits = reader.take<number>('submits');
  const retried = reader.take<boolean>('retried');

  // Read off the same fields the verdict lines quote, so a delivery field the
  // daemon grew and this CLI has not been taught still lands in the residue.
  const detail = lines(
    field('read from', evidence
      ? `${evidence.checks} pane read(s) over ${evidence.waitedMs}ms` +
        (evidence.landedBefore === null ? '' : `; submitted copies ${evidence.landedBefore} → ${evidence.landedAfter}`)
      : null),
    field('keystrokes', typeof interrupts === 'number'
      ? `${interrupts} interrupt (Ctrl+C), ${submits} submit (Enter)${retried ? ' — the second was the confirm-and-retry' : ''}`
      : null),
    evidence?.tail
      ? lines(`${INDENT}pane the verdict was read from:`, indent(String(evidence.tail), INDENT + INDENT))
      : null
  );

  // A request that never became a send says so, rather than being printed as a
  // delivery that did not happen. The daemon's own error already names what was
  // wrong with the call, so this is the ordinary failure line.
  if (verdict === 'refused') {
    return lines(
      failure(reader, `send to ${key} — REFUSED, nothing was typed at any agent`),
      field('refused by', reader.take('refused')),
      residue(reader)
    );
  }
  if (verdict === 'unverifiable') {
    return lines(
      `UNVERIFIABLE: send to ${key} — the message was typed, and whether it landed is UNKNOWN.`,
      reader.take<string>('error') ?? '',
      detail,
      residue(reader)
    );
  }
  if (!reader.success || delivered === false) {
    return lines(failure(reader, `send to ${key} — NOT DELIVERED`), detail, residue(reader));
  }
  return lines(
    `delivered to ${key} — the message was seen in its transcript as submitted output`,
    detail,
    residue(reader)
  );
}

function renderCapacity(reader: ResponseReader): string {
  if (!reader.success) return lines(failure(reader, 'capacity'), residue(reader));
  // capacityDto is spread flat into this response rather than nested, so the
  // whole response *is* the capacity object.
  const dto = { ...reader.res };
  delete dto.derivation;
  delete dto.priorities;
  delete dto.fleetPriorities;
  // Exactly the fields capacityBlock renders, and no others: a capacity field
  // this CLI has not been taught stays unread and lands in the residue.
  reader.seen(...CAPACITY_FIELDS);
  return lines(
    'capacity:',
    capacityBlock(dto),
    verbatim('derivation:', reader.take('derivation')),
    priorityRows(reader.take('priorities')),
    verbatim('fleet priorities:', reader.take('fleetPriorities')),
    residue(reader)
  );
}

// ------------------------------------------------------- build provenance

/**
 * Every field of the `build` object (provenance.ts), so the block below can be
 * checked against the object it is handed. Same rule as CAPACITY_FIELDS and
 * for the same reason: a nested object is out of the top-level reader's reach,
 * so anything this renderer has not been taught would vanish rather than land
 * in the residue.
 */
const BUILD_FIELDS = [
  'commit', 'clean', 'builtAt', 'gitRoot', 'distDir', 'stampPath', 'stampPresent',
  'stampUsable', 'readAt', 'unknown'
] as const;

const FRESHNESS_FIELDS = [
  'state', 'summary', 'processIsCurrentBuild', 'sourcesNewerThanBuild', 'basis',
  'runningBuiltAt', 'runningCommit', 'onDiskBuiltAt', 'onDiskCommit', 'distNewestAt',
  'sourceDir', 'sourceNewestAt', 'sourceNewestFile', 'unknown'
] as const;

/** Whatever a nested block was not taught to print. */
function unknownKeysOf(obj: any, known: readonly string[]): string[] {
  return Object.keys(obj ?? {})
    .filter((key) => !known.includes(key))
    .map((key) => `${INDENT}${key}: ${compact(obj[key])}`);
}

/**
 * A field that may be unknown, and must say so out loud.
 *
 * `field()` prints nothing for null, which is right for a field that is merely
 * absent and catastrophic for these: a `commit` line silently missing from a
 * status reads as an unremarkable status, and the whole point of KAN-122 is
 * that "I don't know what I am running" must be impossible to mistake for
 * "everything is fine". So null prints the word, in capitals, and the reason
 * follows in the block underneath.
 */
function knownOrUnknown(label: string, value: unknown, width: number): string {
  if (value === undefined || value === null || value === '') {
    return `${INDENT}${(label + ':').padEnd(width)} UNKNOWN`;
  }
  return `${INDENT}${(label + ':').padEnd(width)} ${String(value)}`;
}

/**
 * The reasons behind every UNKNOWN above, under a heading that refuses to be
 * read as an all-clear.
 */
function unknownReasons(unknown: any, what: string): string | null {
  const entries = Object.entries(unknown ?? {});
  if (!entries.length) return null;
  return lines(
    `\n! ${what} COULD NOT BE ESTABLISHED — this is absent data, NOT a clean result:`,
    ...entries.map(([f, reason]) => `${INDENT}${f} — ${reason}`)
  );
}

const PROVENANCE_WIDTH = 16;

/**
 * What the running process was built from (KAN-122).
 *
 * Read at the daemon's boot, not now: a daemon whose `dist/` was rebuilt
 * underneath it is still executing what it loaded, and this block is the only
 * place that fact is visible. The freshness block below is what compares it to
 * the tree as it stands.
 */
function buildBlock(build: any): string | null {
  // A daemon that answers nothing here is itself the finding, and the loudest
  // one this command can report: build provenance has been on every reply
  // since KAN-122, so a daemon without it was started from a `dist/` that
  // predates this CLI — which is the exact "the running process is not what
  // you think it is" that the field exists to expose.
  if (build === undefined || build === null) {
    return lines(
      `\n! THIS DAEMON REPORTS NO BUILD PROVENANCE.`,
      `${INDENT}Every daemon that carries it answers a \`build\` object here (KAN-122). This one`,
      `${INDENT}did not, so it was started from a dist/ older than this CLI — you are talking to a`,
      `${INDENT}CrabCast that is not the one in this checkout. Restart the daemon.`
    );
  }
  if (typeof build !== 'object') return null;
  return lines(
    `\nbuild — what THIS process was loaded from, read when it started:`,
    knownOrUnknown('commit', build.commit, PROVENANCE_WIDTH),
    // Spelled out rather than printed as a bare boolean, because `false` and
    // "could not tell" are a sentence apart and one character apart.
    knownOrUnknown(
      'checkout',
      build.clean === true
        ? 'clean when this build was made'
        : build.clean === false
          ? 'DIRTY when this build was made — it contains uncommitted edits'
          : null,
      PROVENANCE_WIDTH
    ),
    knownOrUnknown('built', build.builtAt, PROVENANCE_WIDTH),
    field('git root', build.gitRoot, PROVENANCE_WIDTH),
    field('loaded from', build.distDir, PROVENANCE_WIDTH),
    // Three situations, not two: no stamp, a stamp that answered, and a stamp
    // sitting right there that was NOT believed. The last one matters most to
    // whoever is looking at that directory — they can see a file naming a
    // commit, and need to know this daemon read it and put it aside.
    field(
      'stamp',
      build.stampPresent
        ? build.stampUsable
          ? build.stampPath
          : `${build.stampPath} — PRESENT BUT NOT BELIEVED (see below)`
        : `absent (${build.stampPath})`,
      PROVENANCE_WIDTH
    ),
    field('read at', build.readAt, PROVENANCE_WIDTH),
    unknownReasons(build.unknown, 'THE BUILD THIS DAEMON IS RUNNING'),
    ...unknownKeysOf(build, BUILD_FIELDS)
  );
}

/** Whether that build is still the one on disk, and whether it is up to date. */
function freshnessBlock(freshness: any): string | null {
  // Silent when the build block above has already said the daemon predates
  // this field; saying it twice is noise, and saying nothing at all is what
  // this block must never do.
  if (freshness === undefined || freshness === null) return null;
  if (typeof freshness !== 'object') return null;
  const yesNo = (v: unknown) => (v === true ? 'yes' : v === false ? 'no' : 'UNKNOWN');
  return lines(
    `\nfreshness: ${String(freshness.state ?? 'unknown').toUpperCase()}`,
    freshness.summary ? indent(String(freshness.summary)) : null,
    knownOrUnknown('running the build on disk', yesNo(freshness.processIsCurrentBuild), 26),
    knownOrUnknown('sources newer than build', yesNo(freshness.sourcesNewerThanBuild), 26),
    field('compared by', freshness.basis, 26),
    field('build on disk', freshness.onDiskBuiltAt, 26),
    field('newest in dist/', freshness.distNewestAt, 26),
    field('sources', freshness.sourceDir, 26),
    field(
      'newest source',
      freshness.sourceNewestAt
        ? `${freshness.sourceNewestAt}${freshness.sourceNewestFile ? ` (${freshness.sourceNewestFile})` : ''}`
        : null,
      26
    ),
    unknownReasons(freshness.unknown, 'FRESHNESS'),
    // Read off the build block above; repeating them here would be two copies
    // of one fact on one screen.
    ...unknownKeysOf(freshness, FRESHNESS_FIELDS)
  );
}

/**
 * The daemon itself, rather than any agent it is running.
 *
 * It used to print the config's workspace-type table, because that answered
 * the question people actually arrive with: not "is a daemon up" but "is the
 * daemon up with the config I just edited". There are no types any more — an
 * agent is a directory plus the knobs `configure` froze onto it — so the same
 * question is now about the durable registry, which is the only place an
 * agent's configuration exists. `crabcast list` is what shows the agents
 * themselves; this shows where they are kept.
 *
 * It now also answers WHICH CRABCAST IS RUNNING (KAN-122). CrabCast is
 * consumed as a linked local checkout with no published artifact and no pinned
 * commit, so a consumer whose fleet misbehaves had no way to name the build
 * that did it — and the case that matters most is invisible from the
 * filesystem, because a daemon that predates a rebuild goes on serving the old
 * `dist/` while the tree on disk looks entirely current.
 */
function renderDaemonStatus(reader: ResponseReader): string {
  if (!reader.success) return lines(failure(reader, 'daemon status'), residue(reader));
  return lines(
    'daemon: running',
    field('pid', reader.take('pid')),
    field('started', reader.take('startedAt')),
    field('config', reader.take('configPath')),
    field('data dir', reader.take('dataDir')),
    field('registry', reader.take('registryPath')),
    field('agents', `${reader.take('configuredAgents')} configured, ` +
      `${reader.take('expectedAgents')} expected to be running`),
    // The event stream's identity, for a human asking the question a
    // subscriber asks programmatically: is this the same daemon boot I was
    // talking to? A different `bootId` means every sequence number anyone held
    // is meaningless and the fleet must be re-read from `list`.
    field('events', `bootId ${reader.take('bootId')}, ` +
      `${reader.take('eventSeq')} published since boot`),
    buildBlock(reader.take('build')),
    freshnessBlock(reader.take('freshness')),
    residue(reader)
  );
}

// ------------------------------------------------------------------ the table

/**
 * The one operand every agent-addressing command takes.
 *
 * It replaced `<type> <key>` and a `--type` disambiguator, and the thing worth
 * saying about it is what it removes rather than what it adds: there is no
 * ambiguity left to disambiguate. Two agents could share a key and be told
 * apart only by a type flag a caller had to remember; two agents cannot share
 * a directory.
 */
const PATH_ARG: PositionalSpec = {
  name: 'path',
  required: true,
  help: 'the directory the agent runs in — its whole address. Must already exist.'
};

/**
 * The path operand, resolved against THIS process's working directory.
 *
 * Resolved here rather than in the daemon, and that is not a style choice. The
 * daemon is spawned detached by whichever client first needed it, so its cwd
 * is some other shell's from some other day; `crabcast configure ./svc` run
 * from two different projects would resolve to the same directory there, and
 * which one would depend on where the daemon happened to be started. The only
 * cwd that answers the caller's question is the caller's, and this process is
 * the only one that has it.
 *
 * This is not the CLI computing anything the daemon owns — it is the CLI
 * supplying a fact only it possesses, the same way `--prompt-file` reads a
 * file the daemon cannot see. The daemon refuses a relative path outright, so
 * a client that skipped this gets told rather than silently misrouted.
 */
function agentPathOf(positionals: string[]): string {
  return path.resolve(positionals[0]);
}

/**
 * `configure`'s knobs.
 *
 * Nothing here is validated by the CLI beyond its own type. `priority` and
 * `launcher` are required by the daemon, not by this table, and that is on
 * purpose: a required-flag check here would be a second copy of a rule the
 * daemon already owns, and the copy is the one that is wrong after the daemon
 * changes. Omitting them produces the daemon's refusal, which names them and
 * says why — a better answer than anything this file could print.
 *
 * THE `(in place)` / `(RESTART)` MARKS ARE A CONVENIENCE, NOT THE RULE. The
 * table that decides it is `RECONFIGURATION_COST` in router.ts, which is a
 * total map over the configuration and therefore cannot omit a knob. These
 * marks exist so `--help` answers the question a caller is about to ask, and
 * the daemon's refusal — which names the attribute and the mechanical reason —
 * is what they get if they ask anyway.
 */
const CONFIGURE_FLAGS: FlagSpec[] = [
  { name: 'priority', kind: 'number', value: '<n>', help: 'what this agent outranks when the machine is full (required; changes in place)' },
  { name: 'launcher', kind: 'string', value: '<name>', help: 'the runtime to run in the pane, e.g. claude (required; RESTART: it IS the process)' },
  { name: 'prompt', kind: 'string', value: '<text>', help: "the agent's bootstrap prompt, as literal text (RESTART: read once, at spawn)" },
  { name: 'prompt-file', kind: 'string', value: '<file>', help: 'read the prompt from this file; its BYTES cross the wire, not the path (RESTART)' },
  { name: 'mcp', kind: 'string', value: '<a,b>', help: 'comma-separated MCP servers CrabCast builds itself (crabcast) (RESTART: .mcp.json is read at boot)' },
  { name: 'mcp-config', kind: 'string', value: '<file>', help: 'JSON file of your own server DEFINITIONS, {"name":{"command":…}}; its bytes cross the wire and are written verbatim (RESTART)' },
  { name: 'label', kind: 'string', value: '<text>', help: 'display text; never parsed, never an address, duplicates fine (changes in place)' },
  { name: 'refusable', kind: 'boolean', help: 'may the capacity gate refuse it (default true; --refusable=false to exempt; changes in place)' },
  { name: 'chargeable', kind: 'boolean', help: 'does it occupy a charged slot (default true; changes in place)' },
  { name: 'preemptable', kind: 'boolean', help: 'may it be stood down to make room (default true; changes in place)' },
  { name: 'gate-exempt', kind: 'boolean', help: 'shorthand for all three of the above false; refused alongside any of them' }
];

/**
 * The `mcpServers` map this invocation is sending, assembled from the two
 * flags that can contribute to it.
 *
 * TWO FLAGS BECAUSE THERE ARE TWO KINDS OF ENTRY, and the split is the same one
 * the daemon's value type draws:
 *
 *  - `--mcp crabcast` names a server CRABCAST builds itself. A name works here
 *    precisely because the definition depends on facts about this daemon, so
 *    there is nothing for the caller to write.
 *  - `--mcp-config <file>` carries the caller's OWN definitions. It is a file
 *    rather than a flag value for the reason `--prompt-file` is: the bytes are
 *    read here and put on the wire, so the daemon never learns a path existed
 *    and never has to decide whose filesystem it meant. Arbitrary JSON also
 *    does not survive a comma-separated list.
 *
 * A name in both is a usage error rather than a precedence rule — which one won
 * would be a silent choice about what an agent's tooling actually is.
 */
function mcpServers(
  flags: Record<string, string | number | boolean>
): Record<string, unknown> | undefined {
  const builtins = typeof flags.mcp === 'string'
    ? flags.mcp.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const file = flags['mcp-config'];

  let supplied: Record<string, unknown> = {};
  if (typeof file === 'string') {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e: any) {
      throw new UsageError(
        `could not read --mcp-config ${file}: ${e?.message ?? String(e)}. Nothing was sent.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new UsageError(
        `--mcp-config ${file} is not valid JSON (${e?.message ?? String(e)}). It is written into ` +
          `your agent's .mcp.json verbatim, so it has to be JSON before it leaves here. Nothing ` +
          `was sent.`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError(
        `--mcp-config ${file} must hold an object keyed by server name, e.g. ` +
          `{"atlassian": {"command": "npx", "args": ["-y", "mcp-remote", "…"]}}. Nothing was sent.`
      );
    }
    // A file wrapped as `{"mcpServers": {…}}` is what somebody copying an
    // existing .mcp.json will have. Accepted at its own top level, because
    // refusing it would be pedantry about a shape the caller obviously meant —
    // and it is unwrapped rather than nested, which a silent pass-through
    // would get wrong by writing an `mcpServers` server.
    const record = parsed as Record<string, unknown>;
    const inner = record.mcpServers;
    supplied = (Object.keys(record).length === 1 && inner && typeof inner === 'object' && !Array.isArray(inner))
      ? (inner as Record<string, unknown>)
      : record;
  }

  const collisions = builtins.filter((name) => Object.prototype.hasOwnProperty.call(supplied, name));
  if (collisions.length) {
    throw new UsageError(
      `${collisions.map((c) => `'${c}'`).join(', ')} appears in both --mcp and --mcp-config. Pass ` +
        `it once: which definition won would be a silent choice about what the agent's tooling is.`
    );
  }

  if (!builtins.length && typeof file !== 'string') return undefined;
  // Builtins first, then the caller's, and the caller's order preserved within
  // their own half.
  return { ...Object.fromEntries(builtins.map((name) => [name, 'builtin'])), ...supplied };
}

/**
 * The prompt text this invocation is sending.
 *
 * `--prompt-file` reads the file HERE and puts its bytes on the wire; the
 * daemon never learns a path existed. That is the whole shape of the
 * hand-off: CrabCast takes finished text and does not interpolate, resolve or
 * inspect it, so a path crossing the socket would be a template system
 * smuggled back in — the daemon would have to open the file, and then it would
 * have to decide whose filesystem the path meant.
 *
 * Reading it in the client also puts the failure where it belongs: a file that
 * is not there is this shell's problem, reported by this process, before
 * anything is asked of the daemon.
 *
 * Both flags at once is a usage error rather than a precedence rule. Which one
 * won would be a silent choice about the instructions an agent is about to
 * act on.
 */
function promptText(flags: Record<string, string | number | boolean>): string | undefined {
  const literal = flags.prompt;
  const file = flags['prompt-file'];
  if (literal !== undefined && file !== undefined) {
    throw new UsageError(
      '--prompt and --prompt-file both name the agent\'s bootstrap prompt. Pass one: ' +
        'which of them won would be a silent choice about the instructions the agent acts on.'
    );
  }
  let text: string;
  if (typeof literal === 'string') {
    text = literal;
  } else if (typeof file === 'string') {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err: any) {
      throw new UsageError(
        `--prompt-file ${JSON.stringify(file)} could not be read: ${err?.message ?? String(err)}. ` +
          `The file is read here and its bytes are what cross the wire, so nothing was sent.`
      );
    }
  } else {
    return undefined;
  }

  // Checked HERE as well as in the daemon, because this flag is the one that
  // can produce an over-large prompt by accident — a caller types a filename
  // and the size is whatever the file happens to be. The daemon's refusal is
  // the real one and says the same thing; this one just means a 4 MB file is
  // answered by the process that read it instead of being pushed at a socket
  // whose framing bound would answer with something about line lengths.
  if (text.length > MAX_PROMPT_CHARS) {
    throw new UsageError(
      `the prompt is ${text.length} characters and the limit is ${MAX_PROMPT_CHARS}` +
        (typeof file === 'string' ? ` (read from ${file})` : '') +
        `. It travels inline over the daemon socket, so an over-large one cannot be ` +
        `delivered. NOTHING WAS SENT and nothing was truncated — an agent given half its ` +
        `instructions is worse than one that was refused.`
    );
  }
  return text;
}

/**
 * Command → action → argument spec → one-line help.
 *
 * A NAMED EXPORT ON PURPOSE, and the seam between this task and KAN-94.
 *
 * What it does today: `--help` renders from this table, so the help cannot
 * describe a command that does not exist.
 *
 * What it is FOR, and what now exists: `scripts/verify-cli-parity.mjs`
 * (KAN-94) imports this table from `dist/cli.js` rather than re-deriving the
 * command set, enumerates the router's dispatch mechanically from
 * `src/router.ts`, and fails when an action has neither a command here nor a
 * recorded exclusion. So a router action gaining no command is now a red
 * check rather than something nobody notices. It runs in CI's `verify` job,
 * which is a required check.
 *
 * This paragraph was written in the future tense while that was true, and is
 * changed to the present in the same PR that lands the check — a comment
 * claiming a check that does not exist is how the next reader stops checking,
 * and a comment still promising one that does exist is how they stop
 * believing the comments. `verify-cli-refusal` remains a different check with
 * a different job: it compares `--help` against this table and never reads
 * `router.ts`.
 *
 * Either way, inlining any of this into the help text would make the help
 * honest by accident rather than by construction, and would leave the coming
 * parity check reading prose.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: 'configure',
    action: 'configure_agent',
    responseAction: 'configure_response',
    summary:
      'make an agent exist, or change its knobs — priority and the gate flags change under a ' +
      'running agent, launcher/prompt/mcp are REFUSED rather than costing it a respawn',
    positionals: [PATH_ARG],
    flags: CONFIGURE_FLAGS,
    spawnsDaemon: true,
    build: ({ positionals, flags }) => ({
      path: agentPathOf(positionals),
      priority: flags.priority,
      launcher: flags.launcher,
      prompt: promptText(flags),
      mcpServers: mcpServers(flags),
      label: flags.label,
      // Booleans or absent, never the strings the shell handed us: the daemon
      // refuses a non-boolean here rather than reading it for truthiness.
      refusable: flags.refusable,
      chargeable: flags.chargeable,
      preemptable: flags.preemptable,
      gateExempt: flags['gate-exempt']
    }),
    render: renderConfigure
  },
  {
    name: 'activate',
    action: 'activate_agent',
    responseAction: 'activate_response',
    summary: 'start a configured agent (or report that it is already running)',
    positionals: [PATH_ARG],
    // No inline options, deliberately: everything an agent IS comes from its
    // record, so there is nothing here a caller could pass that might disagree
    // with what the agent already is. These two are not attributes of the
    // agent — they are decisions about the machine.
    flags: [
      { name: 'override', kind: 'boolean', help: 'start it even at capacity — recorded with the figures it bypassed' },
      { name: 'preempt', kind: 'boolean', help: 'make room by standing down an agent this one STRICTLY outranks; destructive' }
    ],
    spawnsDaemon: true,
    build: ({ positionals, flags }) => ({
      path: agentPathOf(positionals),
      override: flags.override,
      preempt: flags.preempt
    }),
    render: renderActivate
  },
  {
    // `deactivate_agent`, not the bare `deactivate` the router also
    // dispatches (router.ts). Both spellings exist and they are different
    // handlers: the bare one requires a `sessionId` and resolves through the
    // session map alone, so it cannot address any agent that outlived a
    // daemon restart — `sessionId` is null on every `sessionless: true` row,
    // which is exactly the agent a human most needs to stand down.
    // `deactivate_agent` is a strict superset and is what `src/mcp.ts` uses,
    // so the by-session form gets no CLI command. That is a deliberate
    // omission rather than an oversight, recorded formally in
    // `scripts/verify-cli-parity.mjs`.
    name: 'deactivate',
    action: 'deactivate_agent',
    responseAction: 'deactivate_response',
    summary: 'stop an agent and record that it should not come back; the record survives',
    positionals: [PATH_ARG],
    flags: [],
    spawnsDaemon: true,
    build: ({ positionals }) => ({ path: agentPathOf(positionals) }),
    render: renderDeactivate
  },
  {
    // Where `reset` used to be. `reset` was a stand-down plus a directory
    // delete; CrabCast no longer creates the directory an agent runs in, so
    // the set of directories it may delete is empty by construction and what
    // was left was `deactivate` with extra words. `forget` is the other half
    // it never had: removing the RECORD.
    name: 'forget',
    action: 'forget_agent',
    responseAction: 'forget_response',
    summary: 'make an agent stop existing: remove its record. Refuses while it is running.',
    positionals: [PATH_ARG],
    flags: [],
    spawnsDaemon: true,
    build: ({ positionals }) => ({ path: agentPathOf(positionals) }),
    render: renderForget
  },
  {
    name: 'list',
    action: 'list_agents',
    responseAction: 'list_agents_response',
    summary: 'the whole fleet: running, missing, preempted, on standby, foreign panes, plus capacity',
    positionals: [],
    flags: [],
    spawnsDaemon: false,
    build: () => ({}),
    render: renderList
  },
  {
    name: 'status',
    action: 'agent_status',
    responseAction: 'agent_status_response',
    summary: 'everything known about one agent',
    positionals: [PATH_ARG],
    flags: [],
    spawnsDaemon: false,
    build: ({ positionals }) => ({ path: agentPathOf(positionals) }),
    render: renderStatus
  },
  {
    name: 'tail',
    action: 'tail_agent',
    responseAction: 'tail_agent_response',
    summary: "read an agent's recent terminal output without attaching to it",
    positionals: [PATH_ARG],
    flags: [
      { name: 'lines', kind: 'number', value: '<n>', help: 'trailing lines to return (daemon default 40, max 200)' }
    ],
    spawnsDaemon: false,
    build: ({ positionals, flags }) => ({
      path: agentPathOf(positionals),
      lines: flags.lines
    }),
    render: renderTail
  },
  {
    name: 'send',
    action: 'send_to_agent',
    responseAction: 'send_to_agent_response',
    summary: "type a message into a running agent's terminal, as a human would",
    positionals: [
      PATH_ARG,
      {
        name: 'message',
        required: true,
        rest: true,
        help: 'the message; remaining arguments are joined with single spaces'
      }
    ],
    flags: [],
    spawnsDaemon: true,
    build: ({ positionals }) => ({
      path: agentPathOf(positionals),
      message: positionals[1]
    }),
    render: renderSend
  },
  {
    name: 'capacity',
    action: 'capacity',
    responseAction: 'capacity_response',
    summary: 'how many more agents this machine can carry, and the arithmetic behind it',
    positionals: [],
    flags: [],
    spawnsDaemon: false,
    build: () => ({}),
    render: renderCapacity
  },
  {
    // One word, not `daemon status`. Every other command in this table is a
    // single token and the parser resolves exactly one (parseArgv), so a
    // two-word name would mean teaching it a second shape for one command.
    //
    // The whole of the CLI's daemon handling, deliberately (KAN-94 task 3,
    // answering KAN-92's open question). There is no `crabcast daemon` that
    // runs one in the foreground: `connectToDaemon` already spawns a detached
    // daemon on the first failed connect, so nothing needs starting by hand,
    // and `node dist/daemon.js [configPath]` is the documented foreground
    // path already. There is no stop or restart either — no such action
    // exists, and `pid` below is what `kill` needs.
    name: 'daemon-status',
    action: 'daemon_status',
    // It used to be the one handler in the API that answered with no `action`
    // at all, and this said `null`. KAN-122 gave it one, so the value here is
    // a label like every other command's — and the parity check now verifies
    // that label against `router.ts` rather than verifying an absence.
    responseAction: 'daemon_status_response',
    summary:
      'the daemon itself: pid, uptime, the config it loaded, where the registry lives, ' +
      'and WHICH BUILD it is running',
    positionals: [],
    flags: [],
    // Never. This is the command whose entire question is "is a daemon
    // running?", and a command that starts one to answer it has destroyed the
    // only thing it was asked. Exit 3 against no daemon IS the answer here,
    // which is why it is also the command to reach for when a fleet is
    // behaving oddly.
    spawnsDaemon: false,
    build: () => ({}),
    render: renderDaemonStatus
  }
];

export function commandNamed(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// ---------------------------------------------------------------- global flags

const GLOBAL_FLAGS: FlagSpec[] = [
  {
    name: 'config',
    kind: 'string',
    value: '<path>',
    help: 'daemon config to address; else $CRABCAST_CONFIG, else ./crabcast.config.json'
  },
  { name: 'json', kind: 'boolean', help: "print the daemon's response exactly as it arrived" },
  { name: 'timeout', kind: 'number', value: '<ms>', help: `how long to wait for a reply (default ${60_000})` },
  { name: 'help', kind: 'boolean', help: 'this help, or a command\'s help after the command name' }
];

const DEFAULT_TIMEOUT_MS = 60_000;

// --------------------------------------------------------------------- help

function usageLine(spec: CommandSpec): string {
  const args = spec.positionals
    .map((p) => (p.rest ? `<${p.name}...>` : p.required ? `<${p.name}>` : `[${p.name}]`))
    .join(' ');
  const flags = spec.flags.map((f) => `[--${f.name}${f.value ? ' ' + f.value : ''}]`).join(' ');
  return `crabcast ${spec.name}${args ? ' ' + args : ''}${flags ? ' ' + flags : ''}`;
}

function flagHelp(flags: FlagSpec[]): string[] {
  const label = (f: FlagSpec) => `--${f.name}${f.value ? ' ' + f.value : ''}`;
  const width = Math.max(0, ...flags.map((f) => label(f).length));
  return flags.map((f) => `${INDENT}${label(f).padEnd(width)}  ${f.help}`);
}

export function renderCommandHelp(spec: CommandSpec): string {
  const rest = spec.positionals.find((p) => p.rest);
  return lines(
    usageLine(spec),
    `\n${INDENT}${spec.summary}`,
    spec.positionals.length ? '\narguments:' : null,
    ...spec.positionals.map((p) => `${INDENT}${p.name.padEnd(10)}  ${p.help}`),
    rest
      ? lines(
          `\n${INDENT}<${rest.name}...> takes every remaining argument, joined with single spaces,`,
          `${INDENT}and flag parsing STOPS where it begins. \`crabcast ${spec.name} … --help\` sends the`,
          `${INDENT}text "--help"; it does not print this. Put flags BEFORE the ${rest.name}:`,
          `${INDENT}  ${usageLine(spec)}`,
          `${INDENT}A ${rest.name} written after a flag-looking word gets a note on stderr saying`,
          `${INDENT}it was sent as text.`
        )
      : null,
    spec.flags.length ? '\nflags:' : null,
    ...flagHelp(spec.flags),
    `\nsocket action: ${spec.action}` +
      (spec.responseAction ? ` → ${spec.responseAction}` : ' (the reply carries no action field)'),
    spec.spawnsDaemon
      ? 'starts the daemon if none is running.'
      : 'does NOT start the daemon: it fails with exit 3 when none is running.'
  );
}

/**
 * The whole help, rendered from {@link COMMANDS} — so every command listed
 * exists and works, by construction rather than by anyone remembering to
 * update prose (KAN-92 AC 4).
 */
export function renderHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return lines(
    'crabcast — drive the CrabCast daemon from a shell.',
    '\nusage: crabcast <command> [arguments] [flags]',
    '\ncommands:',
    ...COMMANDS.map((c) => `${INDENT}${c.name.padEnd(width)}  ${c.summary}`),
    '\nglobal flags:',
    ...flagHelp(GLOBAL_FLAGS),
    '\nexit codes:',
    `${INDENT}${EXIT.OK}  success — the daemon answered success: true`,
    `${INDENT}${EXIT.REFUSED}  refused — the daemon answered success: false (a capacity refusal lands here)`,
    `${INDENT}${EXIT.USAGE}  usage   — unknown command, missing argument, malformed flag`,
    `${INDENT}${EXIT.TRANSPORT}  transport — could not reach or spawn the daemon; nothing was asked of it`,
    `${INDENT}${EXIT.CONFIG}  config  — a config that was named would not load; nothing was attempted`,
    '\nwhich commands start a daemon:',
    `${INDENT}start one if none is running:  ${COMMANDS.filter((c) => c.spawnsDaemon).map((c) => c.name).join(', ')}`,
    `${INDENT}refuse instead (exit 3):       ${COMMANDS.filter((c) => !c.spawnsDaemon).map((c) => c.name).join(', ')}`,
    `${INDENT}Starting the daemon runs its boot reconcile, which re-activates every agent the`,
    `${INDENT}durable registry expects — a side effect nobody asked for by typing \`crabcast list\`.`,
    '\nconfig:',
    `${INDENT}--config <path>, else $CRABCAST_CONFIG, else ./crabcast.config.json.`,
    `${INDENT}A config that was NAMED and will not load is a refusal (exit 4), never a silent`,
    `${INDENT}fallback onto some other daemon. With nothing named, the default data dir is used`,
    `${INDENT}and no daemon is ever spawned into it.`,
    '\narguments that start with a dash:',
    `${INDENT}\`--\` ends flag parsing: everything after it is an operand, however it is spelled.`,
    `${INDENT}Use it for a dashed operand — \`crabcast status -- -odd-key\`.`,
    `${INDENT}\`send\` does not need it: flag parsing stops where <message...> begins, so`,
    `${INDENT}\`crabcast send demo --help\` already sends the text "--help" — and a \`--\` typed`,
    `${INDENT}there is sent as part of the message, because that is what "stops" means.`,
    `${INDENT}The trade: a flag written AFTER the message is message text. Put flags first.`,
    `${INDENT}Quoting does not help: the shell eats the quotes, so "--help" arrives as --help.`,
    '\noutput:',
    `${INDENT}Human-readable by default. --json prints the daemon's response exactly as it`,
    `${INDENT}arrived — every field, including the \`id\` this invocation used to correlate it.`,
    `${INDENT}Capacity derivations print verbatim and unindented in both modes; \`capacity\` and`,
    `${INDENT}a refused \`activate\` carry one, \`list\` does not — it reports the same figures as`,
    `${INDENT}numbers instead. Anything a renderer does not recognise is printed anyway.`,
    `\nrun \`crabcast <command> --help\` for one command's arguments.`
  );
}

// ------------------------------------------------------------------- parsing

function flagSpecFor(name: string, spec: CommandSpec | null): FlagSpec | undefined {
  return (
    GLOBAL_FLAGS.find((f) => f.name === name) ??
    spec?.flags.find((f) => f.name === name)
  );
}

function parseBoolean(name: string, raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // The router's own rule, enforced one layer earlier so the message names the
  // flag the user typed rather than the JSON they never saw.
  throw new UsageError(
    `--${name} takes true or false, not ${JSON.stringify(raw)}. This flag is not read ` +
      `for truthiness — it changes whether an agent is started past capacity or another ` +
      `agent is stood down, so it must be said exactly. Use \`--${name}\` for true.`
  );
}

interface ParsedCommandLine {
  spec: CommandSpec | null;
  positionals: string[];
  flags: Record<string, string | number | boolean>;
  wantsHelp: boolean;
}

/**
 * The index at which a command stops having flags and starts having text.
 *
 * A `rest` positional consumes everything from its own index onward, and once
 * it has started, a token beginning with `-` is part of the message rather
 * than a flag. Without this, `crabcast send demo "--help"` was read as a
 * request for help: it printed the help, sent nothing, and exited 0 — a
 * success reported over work that never happened, which is the one failure
 * this epic has paid for most often.
 *
 * Returns Infinity for a command with no `rest` positional, so nothing about
 * the other seven changes.
 */
function restStartsAt(spec: CommandSpec | null): number {
  if (!spec) return Infinity;
  const index = spec.positionals.findIndex((p) => p.rest);
  return index === -1 ? Infinity : index;
}

export function parseArgs(argv: string[]): ParsedCommandLine {
  const flags: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  let spec: CommandSpec | null = null;
  let noMoreFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // Everything from the rest positional's index onward is text. Checked
    // before `--` as well as before the flag branch: a message that is
    // literally `--` is a message.
    if (positionals.length >= restStartsAt(spec)) {
      positionals.push(token);
      continue;
    }

    if (!noMoreFlags && token === '--') {
      noMoreFlags = true;
      continue;
    }

    if (!noMoreFlags && token.startsWith('-') && token !== '-') {
      if (token === '-h') {
        flags.help = true;
        continue;
      }
      if (!token.startsWith('--')) {
        throw new UsageError(`Unknown flag ${token}. Flags are spelled --like-this.`);
      }
      const eq = token.indexOf('=');
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq));
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const flag = flagSpecFor(name, spec);
      if (!flag) {
        throw new UsageError(
          spec
            ? `Unknown flag --${name} for \`crabcast ${spec.name}\`.`
            : `Unknown flag --${name}.`
        );
      }
      if (flag.kind === 'boolean') {
        flags[name] = inline === undefined ? true : parseBoolean(name, inline);
        continue;
      }
      const raw = inline !== undefined ? inline : argv[++i];
      if (raw === undefined) throw new UsageError(`--${name} needs a value.`);
      if (flag.kind === 'number') {
        // Plain decimal only. `Number()` alone reads `--lines 0x10` as 16 and
        // `--timeout 1e9` as a billion — a typo silently becoming a number
        // nobody typed, on flags that decide how much output comes back and
        // how long a caller waits for it.
        if (!/^-?(\d+|\d*\.\d+)$/.test(raw.trim())) {
          throw new UsageError(
            `--${name} takes a plain decimal number, not ${JSON.stringify(raw)}.`
          );
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new UsageError(`--${name} takes a number, not ${JSON.stringify(raw)}.`);
        }
        flags[name] = value;
      } else {
        flags[name] = raw;
      }
      continue;
    }

    if (!spec) {
      const found = commandNamed(token);
      if (!found) {
        throw new UsageError(
          `Unknown command ${JSON.stringify(token)}. Commands: ` +
            `${COMMANDS.map((c) => c.name).join(', ')}.`
        );
      }
      spec = found;
      continue;
    }

    positionals.push(token);
  }

  return { spec, positionals, flags, wantsHelp: flags.help === true };
}

/** Positional operands checked against the spec, with `rest` joined. */
function operandsFor(spec: CommandSpec, given: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < spec.positionals.length; i++) {
    const p = spec.positionals[i];
    if (p.rest) {
      const rest = given.slice(i);
      const joined = rest.join(' ');
      if (!joined && p.required) {
        throw new UsageError(`\`crabcast ${spec.name}\` needs <${p.name}...>.\n${usageLine(spec)}`);
      }
      // WHAT USED TO BE HERE, and why it is gone rather than merely unused.
      //
      // A note on stderr fired when a word inside the message matched one of
      // THIS COMMAND's own flags — `crabcast send <dir> hi --type shell` would
      // say "--type shell is part of the message, not a flag".
      //
      // `send` is the only command with a `rest` positional, and since the
      // re-key it has no flags of its own: `--type` was the disambiguator for
      // a key, and a path cannot be ambiguous. So `spec.flags` is empty here,
      // the filter can never match, and the branch was unreachable code
      // printing a note nobody could trigger.
      //
      // It is deleted rather than widened to global flags. Widening would make
      // `crabcast send <dir> --timeout 5000` — a perfectly ordinary message
      // that happens to contain a word — print a warning about a mistake the
      // caller did not make, and this CLI's rule is that what it prints is
      // what happened. The trade is documented where it is met: in `--help`,
      // and in the `rest` field's own doc comment.
      out.push(joined);
      return out;
    }
    const value = given[i];
    if (value === undefined) {
      if (p.required) {
        throw new UsageError(`\`crabcast ${spec.name}\` needs <${p.name}>.\n${usageLine(spec)}`);
      }
      break;
    }
    out.push(value);
  }
  if (given.length > spec.positionals.length) {
    throw new UsageError(
      `\`crabcast ${spec.name}\` takes ${spec.positionals.length} argument(s); got ` +
        `${given.length}: ${given.map((g) => JSON.stringify(g)).join(' ')}.\n${usageLine(spec)}`
    );
  }
  return out;
}

// -------------------------------------------------------------- socket client

/**
 * One connection, one request, correlated by `id`.
 *
 * Correlation is by `id` and never by action name. It was built that way
 * because `daemon_status` used to reply with no `action` field at all, and a
 * client matching on names would have hung on it; KAN-122 gave it one, and the
 * rule is unchanged for the reason that outlives that case — the same socket
 * carries unsolicited broadcasts (`agent.lost`, `agent.detached`),
 * so an action name tells a client what a frame is ABOUT and never whose
 * request it answers. The `id === undefined` line below is that rule.
 */
class DaemonClient {
  private nextId = 0;
  private closeReason: Error | null = null;
  private framingError: Error | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  private constructor(private readonly socket: net.Socket) {
    onJsonLines(
      socket,
      (msg) => {
        if (msg?.id === undefined) return; // a broadcast event; not our answer
        const entry = this.pending.get(String(msg.id));
        if (!entry) return;
        this.pending.delete(String(msg.id));
        clearTimeout(entry.timer);
        entry.resolve(msg);
      },
      (err) => {
        // Both the per-line JSON parse failure and — the one that matters —
        // the MAX_LINE_CHARS overflow, which ends the connection from the
        // other side of ipc.ts. Keeping it means the close below explains
        // itself instead of the request timing out with no reason at all.
        this.framingError = err;
      }
    );

    // A socket 'error' is always followed by 'close', and it is the only place
    // the reason for the close exists (KAN-88's finding on the MCP client).
    // A handler is also mandatory: an unhandled 'error' on a socket throws.
    socket.on('error', (err: Error) => {
      this.closeReason = err;
    });
    socket.on('close', () => {
      const cause = this.closeReason ?? this.framingError;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new TransportError(
            cause
              ? `The daemon connection closed: ${cause.message}`
              : 'The daemon connection closed before it answered.'
          )
        );
      }
      this.pending.clear();
    });
  }

  static async open(
    dataDir: string,
    opts: { spawnIfMissing: boolean; configPath?: string }
  ): Promise<DaemonClient> {
    try {
      const socket = await connectToDaemon(dataDir, {
        spawnIfMissing: opts.spawnIfMissing,
        // Only when we are the one spawning: a daemon started for us must
        // load the config we resolved, not whatever it finds in its cwd.
        configPath: opts.spawnIfMissing ? opts.configPath : undefined
      });
      return new DaemonClient(socket);
    } catch (err: any) {
      throw new TransportError(
        describeUnreachable(dataDir, opts.spawnIfMissing, err?.message ?? String(err))
      );
    }
  }

  request(action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = `cli-${process.pid}-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new TransportError(
            `The daemon did not answer \`${action}\` within ${timeoutMs}ms.` +
              (this.framingError ? ` Last framing error: ${this.framingError.message}` : '') +
              `\nRaise the wait with --timeout <ms> if this action is simply slow.`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      // Undefined values are dropped by JSON.stringify, so an unset flag is
      // an absent field rather than a null the router would have to interpret.
      const wrote = writeJsonLine(this.socket, { action, ...payload, id });
      // The close-then-write race: the socket died after it was handed over,
      // the request was never sent, and nothing is coming back. Waiting out
      // the timeout would charge the caller a minute for a failure that is
      // already known here (mcp.ts).
      if (!wrote) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new TransportError(
            `The daemon connection closed before \`${action}\` could be sent` +
              (this.closeReason ? `: ${this.closeReason.message}` : '.')
          )
        );
      }
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

/**
 * Why there was no daemon, and where to look.
 *
 * A spawn that failed leaves its stderr in `<dataDir>/daemon-spawn.err`
 * (ipc.ts) — a daemon that dies during module load, or refuses its config,
 * crashes before its own log exists, and that file is the only place the
 * reason is written down. Naming it is the difference between "could not
 * connect" and an answer.
 */
function describeUnreachable(dataDir: string, spawned: boolean, cause: string): string {
  const socket = socketPathFor(dataDir);
  const errPath = path.join(dataDir, SPAWN_ERR_FILENAME);
  const parts = [
    `Could not reach the CrabCast daemon at ${socket}: ${cause}`
  ];
  if (spawned) {
    parts.push(
      `A daemon was spawned and did not come up. Its stderr, if it printed any, is in:`,
      `${INDENT}${errPath}`
    );
    const tail = tailFile(errPath, 20);
    if (tail) {
      parts.push(
        '',
        // The file is opened append-only (ipc.ts), so it accumulates across
        // spawns and this tail may belong to an earlier one. Said rather than
        // implied: attributing a previous run's stderr to this failure would
        // send a reader after a bug that was already fixed.
        `last ${tail.split('\n').length} line(s) of that file — it is APPEND-ONLY across`,
        `spawns, so these may be from an earlier attempt; check the timestamps:`,
        tail
      );
    }
  } else {
    // The instruction has to work for the reader who typed the command, and
    // since KAN-100 that reader may have `npm i -g`'d this package and have no
    // checkout at all — `node dist/daemon.js` lives inside their global
    // node_modules and is not a path anyone is going to find. So the primary
    // advice is the one that is true either way (run something that spawns
    // one), the command list is read off COMMANDS rather than retyped here,
    // and the foreground path is named as what it is: a checkout-only thing.
    const spawning = COMMANDS.filter((c) => c.spawnsDaemon).map((c) => c.name).join(', ');
    parts.push(
      `This command does not start a daemon (see \`crabcast --help\`). Run any of`,
      `${INDENT}${spawning}`,
      `and one is spawned if none is running. From a repository checkout you can also`,
      `run one in the foreground: node dist/daemon.js [configPath]`,
      `If one failed to start earlier, its stderr is in ${errPath}.`
    );
  }
  return parts.join('\n');
}

function tailFile(file: string, count: number): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd();
    if (!text) return null;
    return text.split('\n').slice(-count).join('\n');
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------- main

interface Resolved {
  dataDir: string;
  configPath: string;
  /** False on the unnamed-config fallback: never spawn into a data dir nobody chose. */
  maySpawn: boolean;
}

/**
 * The config resolution, and the refuse-vs-fallback rule that rides on it.
 *
 * Mirrored from the MCP server deliberately (mcp.ts): a config that was NAMED
 * and will not load is a refusal, never a silent fallback — connecting to some
 * other daemon than the one asked for is how a command steers the wrong fleet.
 * Only when nothing was named at all does this fall back to the default data
 * dir, and then it never spawns a daemon there: a daemon spawned without a
 * config refuses to boot, so the spawn could only manufacture a confusing
 * half-failure.
 */
function resolveTarget(explicitConfig: string | undefined): Resolved {
  const { path: configPath, named } = resolveConfigSource(explicitConfig);
  try {
    return { dataDir: loadConfig(configPath).dataDir, configPath, maySpawn: true };
  } catch (err: any) {
    if (named) {
      const why = err instanceof ConfigError ? err.message : (err?.message ?? String(err));
      const e = new Error(why);
      e.name = 'ConfigRefusal';
      throw e;
    }
    process.stderr.write(
      `crabcast: no loadable config at ${configPath}; using the default data dir ` +
        `${DEFAULT_DATA_DIR} and connecting only to an already-running daemon. Pass ` +
        `--config <path> or set CRABCAST_CONFIG to address a specific daemon.\n`
    );
    return { dataDir: DEFAULT_DATA_DIR, configPath, maySpawn: false };
  }
}

export async function main(argv: string[]): Promise<ExitCode> {
  let parsed: ParsedCommandLine;
  try {
    parsed = parseArgs(argv);
  } catch (err: any) {
    process.stderr.write(`crabcast: ${err.message}\n`);
    return EXIT.USAGE;
  }

  const { spec, positionals, flags, wantsHelp } = parsed;

  if (wantsHelp) {
    process.stdout.write((spec ? renderCommandHelp(spec) : renderHelp()) + '\n');
    return EXIT.OK;
  }
  if (!spec) {
    process.stdout.write(renderHelp() + '\n');
    return EXIT.USAGE;
  }

  let operands: string[];
  try {
    operands = operandsFor(spec, positionals);
  } catch (err: any) {
    process.stderr.write(`crabcast: ${err.message}\n`);
    return EXIT.USAGE;
  }

  let target: Resolved;
  try {
    target = resolveTarget(flags.config as string | undefined);
  } catch (err: any) {
    process.stderr.write(`crabcast: refusing to run: ${err.message}\n`);
    return EXIT.CONFIG;
  }

  const spawnIfMissing = spec.spawnsDaemon && target.maySpawn;
  const timeout = typeof flags.timeout === 'number' ? flags.timeout : DEFAULT_TIMEOUT_MS;

  // `build` can refuse: --prompt-file reads the file in this process, so a
  // missing file is a usage error here rather than a request the daemon has to
  // fail. Same channel as every other bad argument.
  let payload: Record<string, unknown>;
  try {
    payload = spec.build({ positionals: operands, flags });
  } catch (err: any) {
    process.stderr.write(`crabcast: ${err.message}\n`);
    return EXIT.USAGE;
  }

  let client: DaemonClient | null = null;
  let response: any;
  try {
    client = await DaemonClient.open(target.dataDir, {
      spawnIfMissing,
      configPath: target.configPath
    });
    response = await client.request(spec.action, payload, timeout);
  } catch (err: any) {
    process.stderr.write(`crabcast: ${err?.message ?? String(err)}\n`);
    return EXIT.TRANSPORT;
  } finally {
    client?.close();
  }

  // The daemon's verdict on the installed herdr, rendered — never computed
  // (constraint 1). The CLI does not know what 0.6 means and must not learn:
  // it prints the sentence the daemon wrote, or prints nothing because the
  // daemon sent nothing.
  //
  // On stderr, before the answer, and on every mode including `--json`:
  // `--json` is the wire and must stay parseable on stdout (it carries the
  // notice as a field there, like every other field the daemon sent), while a
  // human reading a terminal sees both streams interleaved in order.
  const versionNotice = response?.[HERDR_VERSION_NOTICE_FIELD];
  if (typeof versionNotice === 'string' && versionNotice.length > 0) {
    process.stderr.write(`crabcast: note: ${versionNotice}\n`);
  }

  try {
    if (flags.json) {
      // Exactly what arrived. Nothing dropped, nothing added.
      process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    } else {
      const reader = new ResponseReader(response);
      // Shown above rather than dropped, which is what `seen` is for: the
      // leftovers block exists so an unrendered field cannot vanish, and this
      // one has already been rendered on stderr.
      reader.seen(HERDR_VERSION_NOTICE_FIELD);
      process.stdout.write(spec.render(reader, payload) + '\n');
    }
  } catch (err: any) {
    // A bug in a renderer must not lose the daemon's answer, and must not be
    // reported as a failure to reach the daemon — which was reached, and
    // answered. Print what it said in the one form that cannot go wrong.
    process.stderr.write(
      `crabcast: could not render the response (${err?.message ?? String(err)}); ` +
        `printing it unmodified instead.\n`
    );
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
  }
  // The exit code follows the daemon's own verdict, and nothing else.
  return response?.success === true ? EXIT.OK : EXIT.REFUSED;
}

/**
 * Run only when this file is the program.
 *
 * KAN-94's parity check will import COMMANDS from `dist/cli.js`; without this
 * guard, importing the table would run the CLI.
 *
 * **It fails open, loudly.** `realpathSync` is what makes `npm link` work —
 * the bin is a symlink to `dist/cli.js`, so the two paths are only equal
 * after they are resolved — and it can throw (a deleted entry, a permission
 * wall, a broken link). Returning `false` there meant the CLI did nothing at
 * all: no output, no diagnostic, exit 0, which a shell script reads as the
 * command having worked. Silence indistinguishable from success is the exact
 * failure this whole file is written against, so when the question cannot be
 * answered the answer is to run and say why — a wrong run is visible, and a
 * silent no-op is not.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  // No program at all: an embedder ran this module with no script path. That
  // is not an unanswerable question, it is a definite "not the program".
  if (!entry) return false;

  const self = fileURLToPath(import.meta.url);
  const resolve = (p: string): string | null => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const realEntry = resolve(entry);
  const realSelf = resolve(self);
  if (realEntry !== null && realSelf !== null) return realEntry === realSelf;

  // One of them would not resolve. A plain comparison still answers the
  // common case (an entry that is not a symlink), and a match is a match.
  if (path.resolve(entry) === path.resolve(self)) return true;

  // Genuinely undecidable: the paths differ textually, but a symlink we
  // could not follow may still make them the same file. Run, and say so.
  process.stderr.write(
    `crabcast: could not resolve whether this file is the program being run ` +
      `(argv[1] is ${entry}, this module is ${self}; realpath failed for ` +
      `${realEntry === null ? entry : self}). Running the CLI rather than ` +
      `exiting silently — if you meant to import the command table, import it ` +
      `and ignore this.\n`
  );
  return true;
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`crabcast: ${err?.stack ?? String(err)}\n`);
      process.exitCode = EXIT.TRANSPORT;
    }
  );
}
