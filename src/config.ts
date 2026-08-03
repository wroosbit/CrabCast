import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceTypeConfig } from './types.js';

// The config file is the whole definition of what this daemon can run: an
// optional data directory and a list of workspace types. Validation refuses
// rather than repairs — a config the loader would have to guess about is a
// config whose author has not decided, and the failure modes of guessing
// (a silently-floored priority, a dashed name that breaks agent addressing)
// only surface after work has been destroyed.

export const DEFAULT_CONFIG_FILENAME = 'crabcast.config.json';
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'crabcast');

/** A refusal by the config loader; the message names the field and the type. */
export class ConfigError extends Error {}

export interface CrabcastConfig {
  /** Absolute path of the file this config was loaded from. */
  configPath: string;
  /** Directory of the config file; `promptFile` paths resolve from here. */
  baseDir: string;
  /** Absolute, `~`-expanded. Socket, logs, and workspaces live under it. */
  dataDir: string;
  workspaceTypes: WorkspaceTypeConfig[];
}

/**
 * Where the config comes from: an explicit path as the first CLI argument,
 * else the CRABCAST_CONFIG environment variable, else `crabcast.config.json`
 * in the current directory.
 */
export function resolveConfigPath(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicit = argv[2] || env.CRABCAST_CONFIG;
  return path.resolve(explicit || DEFAULT_CONFIG_FILENAME);
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

function parseWorkspaceType(entry: unknown, index: number): WorkspaceTypeConfig {
  if (!isPlainObject(entry)) {
    refuse(`workspaceTypes[${index}]: must be an object`);
  }

  const name = entry.name;
  if (typeof name !== 'string' || name.length === 0) {
    refuse(`workspaceTypes[${index}]: "name" is required and must be a non-empty string`);
  }
  const label = `workspace type "${name}"`;
  if (name.includes('-')) {
    // Agent names are `<prefix>-<type>-<key>` and are parsed by splitting at
    // the first dash after the prefix (keys routinely contain dashes; types
    // must not). A dashed type would not fail here — it would break agent
    // addressing silently, later, for someone else.
    refuse(
      `${label}: "name" must not contain a dash — agent names are ` +
        `<prefix>-<type>-<key> and the type is recovered by splitting at the ` +
        `first dash, so a dashed type breaks addressing silently`
    );
  }

  if (!('priority' in entry)) {
    refuse(
      `${label}: "priority" is required — a silently-defaulted priority would ` +
        `sit at the floor and be preemptable by everything, and nobody would ` +
        `find out until its work was destroyed`
    );
  }
  const priority = entry.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    refuse(`${label}: "priority" must be a finite number`);
  }

  const promptFile = entry.promptFile;
  if (typeof promptFile !== 'string' || promptFile.length === 0) {
    refuse(`${label}: "promptFile" is required and must be a non-empty string`);
  }

  const defaultLauncher = entry.defaultLauncher;
  if (typeof defaultLauncher !== 'string' || defaultLauncher.length === 0) {
    refuse(`${label}: "defaultLauncher" is required and must be a non-empty string`);
  }

  let mcpServers: string[] = [];
  if ('mcpServers' in entry && entry.mcpServers !== undefined) {
    const value = entry.mcpServers;
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
      refuse(`${label}: "mcpServers" must be an array of strings`);
    }
    mcpServers = value as string[];
  }

  let gateExempt = false;
  if ('gateExempt' in entry && entry.gateExempt !== undefined) {
    if (typeof entry.gateExempt !== 'boolean') {
      refuse(`${label}: "gateExempt" must be a boolean`);
    }
    gateExempt = entry.gateExempt;
  }

  return { name, priority, promptFile, defaultLauncher, mcpServers, gateExempt };
}

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

  if (!('workspaceTypes' in data) || !Array.isArray(data.workspaceTypes)) {
    refuse(`${configPath}: "workspaceTypes" is required and must be an array`);
  }
  const workspaceTypes = data.workspaceTypes.map(parseWorkspaceType);

  const seen = new Set<string>();
  for (const type of workspaceTypes) {
    if (seen.has(type.name)) {
      refuse(
        `workspace type "${type.name}": declared more than once — which ` +
          `declaration wins would be a silent choice`
      );
    }
    seen.add(type.name);
  }

  return { configPath, baseDir, dataDir, workspaceTypes };
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
