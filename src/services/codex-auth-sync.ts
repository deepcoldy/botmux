import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';

export type CodexAuthSyncMode = 'shared' | 'isolated';

export interface ProvisionCodexAuthOptions {
  botHome: string;
  mode?: CodexAuthSyncMode;
  globalCodexHome?: string;
  log(message: string): void;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

/** Resolve a private Codex directory without following a bot-planted leaf symlink. */
function secureCodexHome(botHome: string): string {
  if (existsSync(botHome)) {
    const stat = lstatSync(botHome);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('per-bot home is not a regular directory');
    }
  } else {
    mkdirSync(botHome, { recursive: true, mode: 0o700 });
  }
  const canonicalBotHome = realpathSync(botHome);
  const codexHome = join(canonicalBotHome, 'codex');
  if (existsSync(codexHome)) {
    const stat = lstatSync(codexHome);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('per-bot Codex home is not a regular directory');
    }
  } else {
    mkdirSync(codexHome, { mode: 0o700 });
  }
  const canonicalCodexHome = realpathSync(codexHome);
  if (!isInside(canonicalBotHome, canonicalCodexHome)) {
    throw new Error('per-bot Codex home escapes BOT_HOME');
  }
  if (process.platform !== 'win32') chmodSync(canonicalCodexHome, 0o700);
  return canonicalCodexHome;
}

/** Apply the policy without ever logging or returning credential contents. */
export function provisionCodexAuth(options: ProvisionCodexAuthOptions): string {
  const mode = options.mode ?? 'shared';
  const codexHome = secureCodexHome(options.botHome);
  const authDst = join(codexHome, 'auth.json');

  if (mode === 'isolated') {
    let present = false;
    try {
      if (existsSync(authDst)) {
        const stat = lstatSync(authDst);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
          throw new Error('per-bot Codex auth is not a private regular file');
        }
        if (process.platform !== 'win32') chmodSync(authDst, 0o600);
      }
      present = readSecureHostFileSync(authDst) !== null;
    } catch (error) {
      throw new Error(`unsafe per-bot Codex auth file: ${(error as Error).message}`);
    }
    options.log(`[read-isolation] Codex auth policy=isolated path=${authDst} credential=${present ? 'present' : 'missing'}`);
    if (!present) {
      options.log(
        `[read-isolation] WARN Codex auth policy=isolated has no credential at ${authDst}; `
        + `run CODEX_HOME=${codexHome} codex login --with-api-key before starting this bot`,
      );
    }
    return codexHome;
  }

  const globalCodexHome = options.globalCodexHome ?? join(homedir(), '.codex');
  const authSrc = join(globalCodexHome, 'auth.json');
  const sourcePresent = existsSync(authSrc);
  options.log(`[read-isolation] Codex auth policy=shared source=${authSrc} destination=${authDst} credential=${sourcePresent ? 'present' : 'missing'}`);
  if (!sourcePresent) return codexHome;

  const raw = readFileSync(authSrc, 'utf8');
  const body = raw.endsWith('\n') ? raw : `${raw}\n`;
  let current: string | null = null;
  let forceReplace = false;
  try {
    if (existsSync(authDst)) {
      const stat = lstatSync(authDst);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('per-bot Codex auth is not a regular file');
      }
      // Repair old leaves created under a permissive mode before the strict
      // reader validates them. Do not chmod hard links: replacing them below is
      // safe, mutating their shared inode is not.
      forceReplace = stat.nlink !== 1;
      if (process.platform !== 'win32' && !forceReplace) chmodSync(authDst, 0o600);
    }
    current = readSecureHostFileSync(authDst);
  } catch (error) {
    throw new Error(`unsafe per-bot Codex auth file: ${(error as Error).message}`);
  }
  if (forceReplace || current?.trim() !== raw.trim()) writeSecureHostFileSync(authDst, body);
  else if (process.platform !== 'win32') chmodSync(authDst, 0o600);
  return codexHome;
}
