import { homedir } from 'node:os';
import { join } from 'node:path';

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

function xdgRoot(envName: string, fallback: string): string {
  const value = process.env[envName]?.trim();
  return value ? expandHome(value) : join(homedir(), fallback);
}

function mimocodeXdgPath(envName: string, fallback: string): string {
  const value = process.env[envName]?.trim();
  return value ? join(expandHome(value), 'mimocode') : `~/${fallback}/mimocode`;
}

/** MiMoCode data root: XDG_DATA_HOME, or ~/.local/share/mimocode. */
export function mimocodeDataRoot(): string {
  return join(xdgRoot('XDG_DATA_HOME', '.local/share'), 'mimocode');
}

export function mimocodeConfigPath(): string {
  return mimocodeXdgPath('XDG_CONFIG_HOME', '.config');
}

export function mimocodeDataPath(): string {
  return mimocodeXdgPath('XDG_DATA_HOME', '.local/share');
}

export function mimocodeStatePath(): string {
  return mimocodeXdgPath('XDG_STATE_HOME', '.local/state');
}

export function mimocodeCachePath(): string {
  return mimocodeXdgPath('XDG_CACHE_HOME', '.cache');
}

/** MiMoCode's SQLite store, using the OpenCode V1 session schema. */
export function mimocodeDbPath(): string {
  return join(mimocodeDataRoot(), 'mimocode.db');
}
