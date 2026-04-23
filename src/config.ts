import { networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';

/** Get the first non-loopback IPv4 address, fallback to localhost. */
function getLocalIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function detectDefaultBackend(): 'pty' | 'tmux' {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return 'tmux';
  } catch {
    return 'pty';
  }
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
    backendType: (process.env.BACKEND_TYPE ?? detectDefaultBackend()) as 'pty' | 'tmux',
    workingDir: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean)[0] || '~',
    workingDirs: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean),
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    projectScanDir: process.env.PROJECT_SCAN_DIR ?? '',
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    externalHost: process.env.WEB_EXTERNAL_HOST ?? getLocalIp(),
  },
  screenAnalyzer: {
    enabled: (process.env.SCREEN_ANALYZER_ENABLED ?? '').toLowerCase() === 'true',
    baseUrl: process.env.SCREEN_ANALYZER_BASE_URL ?? '',
    apiKey: process.env.SCREEN_ANALYZER_API_KEY ?? '',
    model: process.env.SCREEN_ANALYZER_MODEL ?? '',
    /** Snapshot polling interval in ms */
    intervalMs: Number(process.env.SCREEN_ANALYZER_INTERVAL_MS) || 2_000,
    /** Consecutive unchanged snapshots required before calling AI */
    stableCount: Number(process.env.SCREEN_ANALYZER_STABLE_COUNT) || 6,
    /** Max characters to send from snapshot */
    snapshotMaxChars: Number(process.env.SCREEN_ANALYZER_SNAPSHOT_MAX_CHARS) || 8_000,
    /** Extra headers for the API request (JSON string, e.g. '{"X-Custom":"value"}') */
    extraHeaders: (() => {
      try { return JSON.parse(process.env.SCREEN_ANALYZER_EXTRA_HEADERS ?? '{}'); }
      catch { return {}; }
    })() as Record<string, string>,
    /** Extra body params for the API request (JSON string, e.g. '{"thinking":{"type":"disabled"}}') */
    extraBody: (() => {
      try { return JSON.parse(process.env.SCREEN_ANALYZER_EXTRA_BODY ?? '{}'); }
      catch { return {}; }
    })() as Record<string, unknown>,
  },
};

// allowedUsers is mutable — daemon resolves email prefixes to open_ids at startup
export type Config = typeof config;
