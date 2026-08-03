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
   * Recorded rather than used: this client correlates by `id` and nothing
   * else (see {@link DaemonClient}), because `daemon_status` answers with no
   * `action` field at all (router.ts) and a client keyed on action names
   * would hang on it. The field is here for the parity check, which needs to
   * know what a command's reply looks like.
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

function address(type: unknown, key: unknown): string {
  const t = typeof type === 'string' && type ? type : '?';
  return `${t}/${String(key ?? '?')}`;
}

/**
 * The agent this invocation is about, for a heading.
 *
 * The response's own address wins whenever it carries one — it is the daemon
 * saying which agent it acted on, which is not always the one the caller
 * named (a bare key resolves through herdr). The request fills the gap:
 * `reset_response` sends no address at all, and a failed lookup has none to
 * send, and `?/?` in a heading helps nobody.
 */
function addressed(reader: ResponseReader, request: Record<string, unknown>): string {
  const type = reader.take('type') ?? request.type;
  const key = reader.take('key') ?? request.key;
  return address(type, key);
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
      (p: any) =>
        `${INDENT}${address(p.type, p.key)}  priority ${p.priority}  ` +
        `[${p.herdrStatus}]  ${p.agentName}`
    )
  );
}

/** The `preemption` offer that rides on a capacity refusal. */
function preemptionOffer(offer: any): string | null {
  if (!offer || typeof offer !== 'object') return null;
  return lines(
    `\npreemption available — this activation outranks a running agent:`,
    field('agent', offer.agentName),
    field('address', address(offer.type, offer.key)),
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

function agentRow(a: any): string {
  const head =
    `${INDENT}${address(a.type, a.key)}  [${a.herdrStatus}]` +
    (a.agentRuntime ? `  runtime ${a.agentRuntime}` : '  runtime (none reported)') +
    (a.gateExempt ? '  gate-exempt' : '');
  const session = a.sessionless
    ? `${INDENT}${INDENT}no session held by this daemon (sessionless) — agent name ${a.agentName}`
    : `${INDENT}${INDENT}session ${a.sessionId} (${a.status}), created ${a.createdAt}`;
  return lines(
    head,
    session,
    a.url ? `${INDENT}${INDENT}url ${a.url}` : null,
    a.workDir ? `${INDENT}${INDENT}workdir ${a.workDir}` : null
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
      field('refused by', reader.take('refusedBy')),
      field('reason', reader.take('reason')),
      field('priority', reader.take('priority')),
      field('url', reader.take('url')),
      reader.take('verified') === false
        ? `${INDENT}verified:      false — the daemon could not confirm the agent exists`
        : null,
      alreadyInError ? null : verbatim('derivation:', derivation),
      capacity ? `\ncapacity:\n${capacity}` : null,
      preemptionOffer(reader.take('preemption')),
      durability(reader),
      residue(reader)
    );
  }

  const preempted = reader.take('preempted');
  const override = reader.take('capacityOverride');
  return lines(
    `activated ${what}`,
    field('session', `${reader.take('sessionId')} (${reader.take('status')})`),
    field('workdir', reader.take('workDir')),
    field('url', reader.take('url')),
    field('created', reader.take('createdAt')),
    field('priority', reader.take('priority')),
    field('mcp servers', (reader.take<string[]>('mcpServers') ?? []).join(', ') || null),
    // `verified: true` is the difference between this response and a false
    // success (KAN-23): the agent was found in herdr's census before the
    // daemon answered. Printed rather than assumed.
    field('verified', reader.take('verified')),
    field('resumed', reader.has('resume')
      ? `${reader.take('resume')} (conversation restored: ${reader.take('resumedConversation')})`
      : null),
    durability(reader),
    // `preempted` is `{ at, victim, derivation }` — the victim named, not
    // just a count. Whose work this activation ended is the part a caller
    // most needs and the part it is easiest to render away.
    preempted
      ? lines(
          `\npreempted to make room — somebody else's work was interrupted:`,
          `${INDENT}${address(preempted.victim?.type, preempted.victim?.key)} ` +
            `(${preempted.victim?.agentName}), priority ${preempted.victim?.priority}, ` +
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
  const note = reader.take('note');
  if (!reader.success) {
    return lines(failure(reader, `deactivate ${what}`), durability(reader), residue(reader));
  }
  return lines(
    alreadyGone ? `deactivated ${what} — nothing was running` : `deactivated ${what}`,
    // The daemon's own words about why a stand-down of nothing is a success.
    note ? `${INDENT}${note}` : null,
    field('session', reader.take('sessionId')),
    reader.take('preempted') ? `${INDENT}preempted:     true (stood down to free capacity)` : null,
    durability(reader),
    residue(reader)
  );
}

function renderReset(reader: ResponseReader, request: Record<string, unknown>): string {
  const what = addressed(reader, request);
  const agentClosed = reader.take('agentClosed');
  const agentError = reader.take('agentError');
  if (!reader.success) {
    return lines(
      failure(reader, `reset ${what}`),
      field('agent closed', agentClosed),
      agentError ? `${INDENT}the agent's own complaint: ${agentError}` : null,
      durability(reader),
      residue(reader)
    );
  }
  return lines(
    `reset ${what} — workspace directory deleted`,
    field('agent closed', agentClosed),
    agentError ? `${INDENT}the agent's own complaint: ${agentError}` : null,
    durability(reader),
    residue(reader)
  );
}

function renderList(reader: ResponseReader): string {
  if (!reader.success) return lines(failure(reader, 'list agents'), residue(reader));

  const agents = reader.take<any[]>('agents') ?? [];
  const unbacked = reader.take<any[]>('unbackedPanes') ?? [];
  const missing = reader.take<any[]>('missingAgents') ?? [];
  const missingTotal = reader.take('missingTotal');
  const preempted = reader.take<any[]>('preemptedAgents') ?? [];
  const preemptedTotal = reader.take('preemptedTotal');
  const standby = reader.take<any[]>('standbyAgents') ?? [];
  const standbyTotal = reader.take('standbyTotal');
  const capacity = reader.take('capacity');
  const priorities = reader.take('priorities');
  const health = reader.take('herdrHealth');

  return lines(
    `agents (${agents.length})`,
    ...(agents.length ? agents.map(agentRow) : [`${INDENT}(none)`]),

    unbacked.length
      ? lines(
          `\nunbacked panes (${unbacked.length}) — named like agents, nothing behind them:`,
          ...unbacked.map(
            (p: any) =>
              `${INDENT}${address(p.type, p.key)} (${p.agentName}) [${p.herdrStatus}] — ${p.reason}`
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
              `${INDENT}${address(m.type, m.key)} — since ${m.since}`,
              `${INDENT}${INDENT}${m.reason}`,
              m.workDir ? `${INDENT}${INDENT}workdir ${m.workDir}` : null
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
              `${INDENT}${address(p.type, p.key)} — at ${p.at}, priority ${p.priority}, ` +
                `for ${address(p.by?.type, p.by?.key)} (priority ${p.by?.priority})`,
              `${INDENT}${INDENT}${p.reason}`,
              p.derivation ? verbatim(`the capacity figures that took it (${address(p.type, p.key)}):`, p.derivation) : null
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
              `${INDENT}${address(s.type, s.key)} — since ${s.since}` +
                (s.defaultAgent ? `, launcher ${s.defaultAgent}` : '') +
                (s.wasPreempted ? ' [its work was taken, not switched off]' : ''),
              `${INDENT}${INDENT}${s.reason}`
            )
          )
        : [`${INDENT}(none)`])
    ),

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
  if (!reader.success) return lines(failure(reader, `status ${what}`), residue(reader));

  const sessionless = reader.take('sessionless');
  return lines(
    `${what} — ${reader.take('herdrStatus')}`,
    field('agent name', reader.take('agentName')),
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
    field('url', reader.take('url')),
    field('created', reader.take('createdAt')),
    field('workdir', reader.take('workDir')),
    residue(reader)
  );
}

function renderTail(reader: ResponseReader, request: Record<string, unknown>): string {
  const key = reader.take('key') ?? request.key;
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

function renderSend(reader: ResponseReader, request: Record<string, unknown>): string {
  const key = reader.take('key') ?? request.key;
  if (!reader.success) return lines(failure(reader, `send to ${key}`), residue(reader));
  return lines(
    `sent to ${key} — the message was typed into its terminal and Enter pressed`,
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

/**
 * The daemon itself, rather than any agent it is running.
 *
 * The one response in the whole API with no `action` field (router.ts), which
 * costs this renderer nothing — ResponseReader already treats `action` as
 * framing — but is why the client correlates by `id` alone.
 *
 * `workspaceTypes` is the config's type table verbatim, and it is here rather
 * than summarized because it is the answer to the question people actually
 * arrive with: not "is a daemon up" but "is the daemon up with the config I
 * just edited". A count would answer neither.
 */
function renderDaemonStatus(reader: ResponseReader): string {
  if (!reader.success) return lines(failure(reader, 'daemon status'), residue(reader));
  const types = reader.take<any[]>('workspaceTypes') ?? [];
  return lines(
    'daemon: running',
    field('pid', reader.take('pid')),
    field('started', reader.take('startedAt')),
    field('config', reader.take('configPath')),
    field('data dir', reader.take('dataDir')),
    `\nworkspace types (${types.length}):`,
    ...(types.length
      ? types.map(
          (t) =>
            `${INDENT}${String(t?.name)}` +
            `  priority ${String(t?.priority)}` +
            `, launcher ${String(t?.defaultLauncher)}` +
            `, prompt ${String(t?.promptFile)}` +
            (t?.gateExempt ? ', gate-exempt' : '') +
            (Array.isArray(t?.mcpServers) && t.mcpServers.length
              ? `, mcp: ${t.mcpServers.join(' ')}`
              : '')
        )
      : // A daemon with no types is loadable and useless — it can activate
        // nothing. Said out loud, because an empty list and a renderer that
        // printed nothing look the same and only one of them is an answer.
        [`${INDENT}(none — this daemon can activate nothing; its config declares no types)`]),
    residue(reader)
  );
}

// ------------------------------------------------------------------ the table

const TYPE_ARG: PositionalSpec = {
  name: 'type',
  required: true,
  help: 'workspace type, as declared in the daemon config (e.g. shell)'
};
const KEY_ARG: PositionalSpec = {
  name: 'key',
  required: true,
  help: 'workspace key naming which workspace of that type (e.g. demo)'
};
const TYPE_FLAG: FlagSpec = {
  name: 'type',
  kind: 'string',
  value: '<type>',
  help: 'address the agent exactly; without it the key is resolved against herdr'
};

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
    name: 'activate',
    action: 'activate_by_key',
    responseAction: 'activate_response',
    summary: 'start an agent for a workspace type and key (or re-attach to one already running)',
    positionals: [TYPE_ARG, KEY_ARG],
    flags: [
      { name: 'url', kind: 'string', value: '<url>', help: 'opaque page URL to bind and interpolate into the prompt' },
      { name: 'agent', kind: 'string', value: '<launcher>', help: "agent runtime to launch (e.g. claude); default comes from the type" },
      { name: 'override', kind: 'boolean', help: 'start it even at capacity — recorded with the figures it bypassed' },
      { name: 'preempt', kind: 'boolean', help: 'make room by standing down an agent this one STRICTLY outranks; destructive' }
    ],
    spawnsDaemon: true,
    build: ({ positionals, flags }) => ({
      type: positionals[0],
      key: positionals[1],
      url: flags.url,
      defaultAgent: flags.agent,
      // Booleans or absent, never the strings the shell handed us: the router
      // refuses a non-boolean here before it looks anything up.
      override: flags.override,
      preempt: flags.preempt
    }),
    render: renderActivate
  },
  {
    // `deactivate_by_key`, not the bare `deactivate` the router also
    // dispatches (router.ts). Both spellings exist and they are different
    // handlers: the bare one requires a `sessionId` and resolves through the
    // session map alone, so it cannot address any agent that outlived a
    // daemon restart — `sessionId` is null on every `sessionless: true` row,
    // which is exactly the agent a human most needs to stand down.
    // `deactivate_by_key` is a strict superset and is what `src/mcp.ts` uses,
    // so the by-session form gets no CLI command. That is a deliberate
    // omission rather than an oversight; KAN-94 owns the mechanism that
    // records such exclusions formally, and this note is here so the gap is
    // not a silent one in the meantime.
    name: 'deactivate',
    action: 'deactivate_by_key',
    responseAction: 'deactivate_response',
    summary: 'stand an agent down, and record that it should not come back',
    positionals: [KEY_ARG],
    flags: [TYPE_FLAG],
    spawnsDaemon: true,
    build: ({ positionals, flags }) => ({ key: positionals[0], type: flags.type }),
    render: renderDeactivate
  },
  {
    name: 'reset',
    action: 'reset_by_key',
    responseAction: 'reset_response',
    summary: 'stand an agent down AND delete its workspace directory',
    positionals: [TYPE_ARG, KEY_ARG],
    flags: [],
    spawnsDaemon: true,
    build: ({ positionals }) => ({ type: positionals[0], key: positionals[1] }),
    render: renderReset
  },
  {
    name: 'list',
    action: 'list_agents',
    responseAction: 'list_agents_response',
    summary: 'the whole fleet: running, missing, preempted, on standby, plus capacity',
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
    positionals: [KEY_ARG],
    flags: [TYPE_FLAG],
    spawnsDaemon: false,
    build: ({ positionals, flags }) => ({ key: positionals[0], type: flags.type }),
    render: renderStatus
  },
  {
    name: 'tail',
    action: 'tail_agent',
    responseAction: 'tail_agent_response',
    summary: "read an agent's recent terminal output without attaching to it",
    positionals: [KEY_ARG],
    flags: [
      TYPE_FLAG,
      { name: 'lines', kind: 'number', value: '<n>', help: 'trailing lines to return (daemon default 40, max 200)' }
    ],
    spawnsDaemon: false,
    build: ({ positionals, flags }) => ({
      key: positionals[0],
      type: flags.type,
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
      KEY_ARG,
      {
        name: 'message',
        required: true,
        rest: true,
        help: 'the message; remaining arguments are joined with single spaces'
      }
    ],
    flags: [TYPE_FLAG],
    spawnsDaemon: true,
    build: ({ positionals, flags }) => ({
      key: positionals[0],
      message: positionals[1],
      type: flags.type
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
    // The only handler in the API that answers with no `action` field
    // (router.ts). Null rather than omitted: "answers without one" and "we
    // did not record what it answers with" are different facts, and the
    // parity check reads this one.
    responseAction: null,
    summary: 'the daemon itself: pid, uptime, the config it loaded, the types it knows',
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
      // Said out loud rather than guessed at. Flag parsing stops here by
      // design, so `send demo hi --type shell` sends the words "--type shell"
      // — which is right when they are the message and wrong when they were
      // meant as a flag, and the CLI cannot know which. It can say what it
      // did: a note on stderr, no change to what is sent and no change to the
      // exit code, because the message WAS delivered and reporting otherwise
      // would be its own lie.
      const mistakable = rest.filter((token) =>
        spec.flags.some((f) => token === `--${f.name}` || token.startsWith(`--${f.name}=`))
      );
      if (mistakable.length) {
        process.stderr.write(
          `crabcast: note: ${mistakable.join(' ')} is part of the ${p.name}, not a flag — ` +
            `everything after <${spec.positionals[i - 1]?.name ?? 'the operands'}> is ${p.name} text. ` +
            `Put flags before it: crabcast ${spec.name} --${spec.flags[0]?.name ?? 'flag'} … ` +
            `${spec.positionals.slice(0, i).map((q) => `<${q.name}>`).join(' ')} <${p.name}...>\n`
        );
      }
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
 * Correlation is by `id` and never by action name. `daemon_status` is the one
 * handler that replies with no `action` field at all (router.ts) — a client
 * that matched on action names would hang on it — and KAN-94 adds exactly
 * that command, so the rule is built in here before it is needed rather than
 * discovered by it.
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

  const payload = spec.build({ positionals: operands, flags });

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
