import { networkInterfaces } from 'node:os';
import { probeTmuxFunctional } from './setup/ensure-tmux.js';

/** Get the first non-loopback IPv4 address, fallback to localhost. */
function getLocalIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

const configuredWebExternalHost = process.env.WEB_EXTERNAL_HOST;
const configuredDashboardExternalHost =
  process.env.BOTMUX_DASHBOARD_EXTERNAL_HOST ?? process.env.WEB_EXTERNAL_HOST;

export function getWebExternalHost(): string {
  return configuredWebExternalHost ?? getLocalIp();
}

export function getDashboardExternalHost(): string {
  return configuredDashboardExternalHost ?? getLocalIp();
}

/**
 * Pick the session backend. tmux is preferred (enables /adopt + per-client
 * Web terminal attach) but only if it can actually start a server. The old
 * check was `tmux -V`, which passes on machines where tmux is installed but
 * broken (perms / config / linkage) and leaves the worker spamming "error
 * connecting to /tmp/tmux-UID/default" forever. The functional probe filters
 * those out so we silently fall back to PTY.
 */
function detectDefaultBackend(): 'pty' | 'tmux' {
  return probeTmuxFunctional().ok ? 'tmux' : 'pty';
}

export const config = {
  lark: {
    appId: process.env.LARK_APP_ID ?? '',
    appSecret: process.env.LARK_APP_SECRET ?? '',
  },
  session: {
    dataDir: process.env.SESSION_DATA_DIR ?? new URL('../data', import.meta.url).pathname,
  },
  send: {
    /** @ hard-gate: every model-initiated `botmux send` reply must explicitly
     *  choose --mention / --mention-back / --no-mention. Set
     *  BOTMUX_REQUIRE_MENTION_DECISION=false to disable (kill-switch if the
     *  gate misfires in production). */
    requireMentionDecision: (process.env.BOTMUX_REQUIRE_MENTION_DECISION ?? 'true').toLowerCase() !== 'false',
  },
  daemon: {
    cliId: (process.env.CLI_ID ?? 'claude-code') as import('./adapters/cli/types.js').CliId,
    cliPathOverride: process.env.CLI_PATH,
    backendType: (process.env.BACKEND_TYPE ?? detectDefaultBackend()) as 'pty' | 'tmux',
    workingDir: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean)[0] || '~',
    workingDirs: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean),
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    get externalHost() { return getWebExternalHost(); },
  },
  dashboard: {
    host: process.env.BOTMUX_DASHBOARD_HOST ?? '0.0.0.0',
    port: Number(process.env.BOTMUX_DASHBOARD_PORT) || 7891,
    get externalHost() { return getDashboardExternalHost(); },
    ipcBasePort: Number(process.env.BOTMUX_DAEMON_IPC_BASE_PORT) || 7892,
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
