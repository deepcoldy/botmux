import { networkInterfaces } from 'node:os';

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
    cliId: (process.env.CLI_ID ?? 'claude-code') as import('./adapters/cli/types.js').CliId,
    cliPathOverride: process.env.CLI_PATH,
    backendType: (process.env.BACKEND_TYPE ?? 'pty') as 'pty' | 'tmux',
    workingDir: process.env.WORKING_DIR ?? '~',
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    projectScanDir: process.env.PROJECT_SCAN_DIR ?? '',
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    externalHost: process.env.WEB_EXTERNAL_HOST ?? getLocalIp(),
  },
};

// allowedUsers is mutable — daemon resolves email prefixes to open_ids at startup
export type Config = typeof config;

export function validateConfig(): void {
  if (!config.lark.appId) throw new Error('LARK_APP_ID is required');
  if (!config.lark.appSecret) throw new Error('LARK_APP_SECRET is required');
}
