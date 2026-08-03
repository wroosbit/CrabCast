import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The daemon is auto-spawned by whichever client needs it first — a CLI, an
// MCP server, another agent — and it is long-lived. Whatever PATH it inherits
// becomes the PATH of every herdr pane and therefore every agent, so a client
// with a thin environment would silently break tool lookup (herdr, claude,
// gh, npx) for the whole session. Normalize it at startup instead of trusting
// the inherited value.

const EXTRA_DIRS = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/local/sbin',
  '/usr/sbin',
  '/sbin',
  '/snap/bin'
];

function loginShellPath(): string | null {
  const shell = process.env.SHELL || '/bin/bash';
  try {
    // -lic so both login files (.profile, .zprofile) and interactive ones
    // (.bashrc, config.fish) are sourced; users put PATH edits in either.
    const out = execFileSync(shell, ['-lic', 'env'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const line = out.split('\n').find((l) => l.startsWith('PATH='));
    return line ? line.slice('PATH='.length).trim() : null;
  } catch {
    // Shell missing, slow, or non-cooperative: fall back to known locations.
    return null;
  }
}

export function resolveUserPath(): string {
  const entries: string[] = [];
  const add = (value?: string | null) => {
    if (!value) return;
    for (const part of value.split(':')) {
      if (part && !entries.includes(part)) entries.push(part);
    }
  };

  add(loginShellPath());
  add(process.env.PATH);
  add(path.join(os.homedir(), '.local', 'bin'));
  add(path.join(os.homedir(), 'bin'));
  // The node running this daemon, so npx-based MCP servers resolve.
  add(path.dirname(process.execPath));
  for (const dir of EXTRA_DIRS) add(dir);

  return entries.join(':');
}

/** Resolve a command against a PATH, mirroring execvp lookup. */
export function which(cmd: string, searchPath = process.env.PATH || ''): string | null {
  for (const dir of searchPath.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
