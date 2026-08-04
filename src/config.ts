import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// For the socket-path length check below. One-way: ipc.ts imports nothing
// from here, so naming the socket in one place costs no cycle.
import { socketPathFor } from './ipc.js';

// The config file used to be the whole definition of what this daemon could
// run: a data directory plus a list of workspace types, each declaring a
// priority, a prompt, a launcher and a gate flag. Types are gone — an agent is
// a directory plus the knobs a caller froze onto it with `configure` — so what
// is left here is the data directory and nothing else.
//
// WHAT THAT DELETION TOOK WITH IT, so nobody restores half of it: the
// dash-in-a-type-name refusal existed only to protect a name parse that no
// longer happens; the duplicate-type check protected a lookup table that no
// longer exists; and the required-`priority` refusal moved rather than
// vanished — `configure` now refuses an agent with no priority, for the same
// reason and in the same words.
//
// The rule that stayed is the one that was never about types: this loader
// refuses rather than repairs. A config it would have to guess about is a
// config whose author has not decided.

export const DEFAULT_CONFIG_FILENAME = 'crabcast.config.json';
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'crabcast');

/**
 * The longest socket path this config may imply.
 *
 * A unix socket address is a fixed `sun_path` buffer — 108 bytes on Linux,
 * 104 on macOS and the BSDs — and a path past it is **truncated**, not
 * rejected. What that looks like from the outside is worth stating, because
 * it was found the hard way twice: the daemon logs a clean start and binds a
 * socket somewhere else entirely (outside the dataDir, and therefore outside
 * the `0700` directory that is this daemon's whole auth boundary), its
 * `chmod 0600` fails on a path that does not exist, its `unlinkSync` never
 * removes anything, and the next daemon exits with "Removing stale socket
 * file" against a directory that is brand new and empty. Two different long
 * dataDirs can even truncate to the *same* address and collide.
 *
 * 104 rather than 108, so a config that loads here loads on a Mac too: this
 * file's whole contract is that a config it accepts is a config the daemon
 * can run.
 *
 * Refused at load, with the figures, because that is what the rest of this
 * loader does — the alternative is a failure that surfaces as a message about
 * a file nobody touched. Fixing what the daemon does with an over-long path
 * once it is past this gate is KAN-97.
 */
export const MAX_SOCKET_PATH_CHARS = 104;

/** A refusal by the config loader; the message names the field and the type. */
export class ConfigError extends Error {}

export interface CrabcastConfig {
  /** Absolute path of the file this config was loaded from. */
  configPath: string;
  /** Directory of the config file; `promptFile` paths resolve from here. */
  baseDir: string;
  /** Absolute, `~`-expanded. Socket, logs, registry and sidecars live under it. */
  dataDir: string;
}

/**
 * Where a config came from, and whether anyone actually named it.
 *
 * `named` is the second half of the rule, and it is the half that decides
 * what a caller does when the file will not load. A config somebody named —
 * on the command line or in CRABCAST_CONFIG — that does not load is a
 * refusal: falling back would connect to a *different* daemon than the one
 * asked for, which is how a tool call steers the wrong fleet. A config nobody
 * named is a default that may simply not be there, and falling back to the
 * default data dir (without ever spawning a daemon into it) is reasonable.
 *
 * Returned together because every consumer needs both, and a consumer that
 * recomputes `named` from its own argv is a second copy of this rule.
 */
export interface ConfigSource {
  /** Absolute path the config will be read from. */
  path: string;
  /** True when a config path was named explicitly or via CRABCAST_CONFIG. */
  named: boolean;
}

/**
 * Where the config comes from: an explicit path the caller was given, else the
 * CRABCAST_CONFIG environment variable, else `crabcast.config.json` in the
 * current directory.
 *
 * The explicit path is a *parameter* rather than something read out of
 * `process.argv` here, and that is not a stylistic preference. This function
 * used to read `argv[2]` itself, which is the config path for the daemon and
 * the *subcommand* for the CLI — `crabcast list` would have gone looking for
 * a config file named `list`. There are three consumers of this rule now (the
 * daemon, the MCP server, the CLI) and only two of them have the path at
 * `argv[2]`; the rule belongs here and the argv position belongs to whoever
 * knows their own argv.
 */
export function resolveConfigSource(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): ConfigSource {
  const named = explicit || env.CRABCAST_CONFIG;
  return { path: path.resolve(named || DEFAULT_CONFIG_FILENAME), named: Boolean(named) };
}

/** {@link resolveConfigSource} when only the path is wanted. */
export function resolveConfigPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolveConfigSource(explicit, env).path;
}

function refuse(message: string): never {
  throw new ConfigError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * A key this loader used to understand and no longer does, with what to do
 * about it.
 *
 * Refused rather than ignored. A config still declaring `workspaceTypes` was
 * written against a model where those declarations decided an agent's
 * priority, prompt, launcher and gate exemption — silently dropping them would
 * start a daemon that agrees with the file about nothing, and the first
 * evidence would be an activation refused for a knob nobody knew had moved.
 */
const RETIRED_KEYS: Record<string, string> = {
  workspaceTypes:
    'workspace types are gone: an agent is a directory plus the knobs a caller freezes ' +
    'onto it with `configure`. priority, prompt, launcher, mcpServers and the gate flags ' +
    'are now per-agent `configure` parameters rather than per-type config, so this ' +
    'declaration has no consumer. Remove the key; there is nothing to move it to in ' +
    'this file.'
};

/** Parse and validate config text. Throws ConfigError on any refusal. */
export function parseConfig(raw: string, configPath: string): CrabcastConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    refuse(`${configPath}: not valid JSON: ${err?.message ?? String(err)}`);
  }
  if (!isPlainObject(data)) {
    refuse(`${configPath}: top level must be a JSON object`);
  }

  const baseDir = path.dirname(configPath);

  let dataDir = DEFAULT_DATA_DIR;
  if ('dataDir' in data && data.dataDir !== undefined) {
    if (typeof data.dataDir !== 'string' || data.dataDir.length === 0) {
      refuse(`${configPath}: "dataDir" must be a non-empty string`);
    }
    dataDir = path.resolve(baseDir, expandHome(data.dataDir));
  }

  // See MAX_SOCKET_PATH_CHARS. Checked on the default too, not only on a
  // dataDir somebody wrote: the default is under `os.homedir()`, and a home
  // directory long enough to blow the budget would produce exactly the same
  // unreadable failure with nothing in the config to point at.
  const socketPath = socketPathFor(dataDir);
  if (socketPath.length > MAX_SOCKET_PATH_CHARS) {
    refuse(
      `${configPath}: "dataDir" is too long — its socket path is ` +
        `${socketPath.length} characters and a unix socket address holds at most ` +
        `${MAX_SOCKET_PATH_CHARS} (108 on Linux, 104 on macOS; the smaller is used so a ` +
        `config that loads here loads there). Over the limit the address is ` +
        `silently truncated, so the daemon binds a socket somewhere other than ` +
        `its data directory, cannot chmod or unlink it, and the next daemon ` +
        `reports a stale socket file in a directory that is empty. Shorten the ` +
        `dataDir.\n  dataDir: ${dataDir}\n  socket:  ${socketPath}`
    );
  }

  for (const [key, why] of Object.entries(RETIRED_KEYS)) {
    if (key in data) refuse(`${configPath}: "${key}" is no longer a config key — ${why}`);
  }

  return { configPath, baseDir, dataDir };
}

/** Load and validate the config file at `configPath`. */
export function loadConfig(configPath: string): CrabcastConfig {
  const absolute = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, 'utf-8');
  } catch (err: any) {
    refuse(`cannot read config file ${absolute}: ${err?.message ?? String(err)}`);
  }
  return parseConfig(raw, absolute);
}
