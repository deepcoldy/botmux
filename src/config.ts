import { networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** Resolve a command name to its absolute path via a login-shell `which`.
 *  pm2 inherits a minimal PATH that may miss user-installed CLIs,
 *  so we run `which` inside a login shell to pick up the full profile PATH. */
function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  // Try shells in order: user's default shell, then zsh, then bash
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  for (const sh of shells) {
    try {
      return execSync(`${sh} -lc 'which ${cmd}'`, { encoding: 'utf-8', timeout: 5_000 }).trim();
    } catch { /* try next shell */ }
  }
  return cmd;
}

/** Get the first non-loopback IPv4 address, fallback to localhost. */
function getLocalIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

export const config = {
  lark: {
    appId: process.env.LARK_APP_ID ?? '',
    appSecret: process.env.LARK_APP_SECRET ?? '',
  },
  session: {
    dataDir: process.env.SESSION_DATA_DIR ?? new URL('../data', import.meta.url).pathname,
  },
  daemon: {
    model: process.env.LARK_BRIDGE_MODEL ?? 'opus',
    maxTurns: Number(process.env.LARK_BRIDGE_MAX_TURNS ?? '500'),
    claudePath: resolveCommand(process.env.CLAUDE_PATH ?? 'claude'),
    workingDir: process.env.CLAUDE_WORKING_DIR ?? '~',
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    projectScanDir: process.env.PROJECT_SCAN_DIR ?? '',
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    externalHost: process.env.WEB_EXTERNAL_HOST ?? getLocalIp(),
  },
} as const;

export function validateConfig(): void {
  if (!config.lark.appId) throw new Error('LARK_APP_ID is required');
  if (!config.lark.appSecret) throw new Error('LARK_APP_SECRET is required');
}
