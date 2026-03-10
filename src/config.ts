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
    defaultChatId: process.env.LARK_DEFAULT_CHAT_ID ?? '',
  },
  session: {
    dataDir: process.env.SESSION_DATA_DIR ?? new URL('../data', import.meta.url).pathname,
  },
  daemon: {
    model: process.env.LARK_BRIDGE_MODEL ?? 'opus',
    maxTurns: Number(process.env.LARK_BRIDGE_MAX_TURNS ?? '500'),
    claudePath: process.env.CLAUDE_PATH ?? 'claude',
    workingDir: process.env.CLAUDE_WORKING_DIR ?? '~',
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    projectScanDir: process.env.PROJECT_SCAN_DIR ?? '',
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    externalHost: process.env.WEB_EXTERNAL_HOST ?? getLocalIp(),
  },
} as const;

export function validateConfig(opts?: { requireChatId?: boolean }): void {
  if (!config.lark.appId) throw new Error('LARK_APP_ID is required');
  if (!config.lark.appSecret) throw new Error('LARK_APP_SECRET is required');
  if (opts?.requireChatId !== false && !config.lark.defaultChatId) {
    throw new Error('LARK_DEFAULT_CHAT_ID is required');
  }
}
