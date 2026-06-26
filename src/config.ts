import { networkInterfaces } from 'node:os';
import type { BackendType } from './adapters/backend/types.js';
import { probeTmuxFunctional } from './setup/ensure-tmux.js';
import { resolveWorkerHttpHost } from './utils/worker-http.js';

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
function detectDefaultBackend(): Exclude<BackendType, 'herdr'> {
  return probeTmuxFunctional().ok ? 'tmux' : 'pty';
}

// Computed once: the packaged fallback data dir. The effective dir is read
// lazily (getter below) so that a SESSION_DATA_DIR set *after* this module is
// first imported — e.g. cli.ts subcommands doing
// `process.env.SESSION_DATA_DIR ??= resolveDataDir()` — is still honored. A
// static value would freeze the packaged default at import time and make those
// readers (resolveTeamRoleFile / getBotCapability / …) silently look in the
// wrong directory. Mirrors the web/dashboard externalHost getters below.
const packagedDataDir = new URL('../data', import.meta.url).pathname;

export const config = {
  lark: {
    appId: process.env.LARK_APP_ID ?? '',
    appSecret: process.env.LARK_APP_SECRET ?? '',
  },
  session: {
    get dataDir() { return process.env.SESSION_DATA_DIR ?? packagedDataDir; },
    // Writable for back-compat: callers/tests historically assigned
    // `config.session.dataDir = ...`. Map writes onto SESSION_DATA_DIR so the
    // getter reflects them and the old assignable contract is preserved.
    set dataDir(value: string) { process.env.SESSION_DATA_DIR = value; },
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
    backendType: (process.env.BACKEND_TYPE ?? detectDefaultBackend()) as BackendType,
    /** Auto-recovery throttle: on restart every surviving persistent-backend
     *  session is eagerly re-forked to re-attach its pane. With dozens of
     *  sessions per daemon (and many daemons on one box) firing them all at
     *  once spikes CPU/IO, so the re-fork is staggered: spawn `batchSize`
     *  workers, wait `delayMs`, repeat. Tune via BOTMUX_RECOVERY_FORK_BATCH /
     *  BOTMUX_RECOVERY_FORK_DELAY_MS. */
    recoveryForkBatchSize: Math.max(1, Number(process.env.BOTMUX_RECOVERY_FORK_BATCH) || 5),
    recoveryForkDelayMs: Math.max(0, Number(process.env.BOTMUX_RECOVERY_FORK_DELAY_MS ?? 250)),
    workingDir: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean)[0] || '~',
    workingDirs: (process.env.WORKING_DIR ?? '~').split(',').map(s => s.trim()).filter(Boolean),
    allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },
  web: {
    host: process.env.WEB_HOST ?? '0.0.0.0',
    workerHost: resolveWorkerHttpHost(),
    get externalHost() { return getWebExternalHost(); },
    // Single reverse-proxy port per daemon that fronts every session's web
    // terminal under `/s/{sessionId}`. Lets dev-machine users forward one port
    // (`proxyBasePort + botIndex`) instead of one per topic. See terminal-proxy.ts.
    proxyBasePort: Number(process.env.BOTMUX_WEB_PROXY_BASE_PORT) || 8800,
    // Port advertised in terminal links, overriding the local proxy port so a
    // relay/transit host can front the terminal on a DIFFERENT port number than
    // botmux binds locally (the relay forwards externalPort → local proxy port).
    // Like proxyBasePort it is a BASE: the daemon advertises `externalPort +
    // botIndex` (see daemon.ts), keeping each bot distinct since every bot daemon
    // shares this env and differs only by BOTMUX_BOT_INDEX. 0 = unset → links use
    // the local proxy port (relay must forward the same port number).
    externalPort: Number(process.env.WEB_EXTERNAL_PORT) || 0,
  },
  dashboard: {
    host: process.env.BOTMUX_DASHBOARD_HOST ?? '0.0.0.0',
    port: Number(process.env.BOTMUX_DASHBOARD_PORT) || 7891,
    get externalHost() { return getDashboardExternalHost(); },
    // Daemon IPC servers bind 127.0.0.1 at ipcBasePort + botIndex. This base MUST
    // stay clear of the dashboard's wildcard probe-fallback range [port, port +
    // listenWithProbe maxProbe (20)] = [7891, 7911]. When they overlapped (old
    // default 7892, adjacent to 7891), a restart race let the dashboard bind
    // 0.0.0.0:7892 while an IPC server held 127.0.0.1:7892 — on macOS both
    // coexist, loopback routes to the IPC server, and the dashboard was 404 on the
    // port it wrote to ~/.botmux/.dashboard-port. 7950 leaves a clean gap below
    // the web-terminal proxy base (8800). The port is advertised per-daemon via
    // the daemon descriptor (daemon.ts → desc.ipcPort), so nothing assumes it.
    // Guarded by test/dashboard-ipc-port-range.test.ts.
    ipcBasePort: Number(process.env.BOTMUX_DAEMON_IPC_BASE_PORT) || 7950,
    /** Public read-only mode (default ON): GET/HEAD surfaces — sessions,
     *  schedules, SSE — are reachable WITHOUT a token, so a stale dashboard
     *  link degrades to read-only browsing instead of a dead "link expired"
     *  wall. Write actions (POST/PATCH/DELETE) and the raw PTY log always
     *  require the rotated token. Opt out with
     *  BOTMUX_DASHBOARD_PUBLIC_READONLY=false.
     *
     *  NOTE: this env value is only the DEFAULT. Once the toggle is changed on
     *  the dashboard Settings page, `~/.botmux/config.json` holds the value and
     *  permanently takes precedence over this env var（UI 接管后改 env 不再生效；
     *  要回到 env 控制需删掉 config.json 里的 dashboard.publicReadOnly）. */
    publicReadOnly: (process.env.BOTMUX_DASHBOARD_PUBLIC_READONLY ?? 'true').toLowerCase() !== 'false',
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
  worktreeSlugAI: {
    /**
     * Optional AI slugger for `/repo wt` auto branch/worktree naming. Disabled
     * by default because it sends the topic title / first prompt to the
     * configured OpenAI-compatible endpoint. When disabled or misconfigured,
     * botmux falls back to deterministic local slugification.
     */
    enabled: (process.env.BOTMUX_WORKTREE_SLUG_AI_ENABLED ?? '').toLowerCase() === 'true',
    baseUrl: process.env.BOTMUX_WORKTREE_SLUG_AI_BASE_URL ?? '',
    apiKey: process.env.BOTMUX_WORKTREE_SLUG_AI_API_KEY ?? '',
    model: process.env.BOTMUX_WORKTREE_SLUG_AI_MODEL ?? '',
    timeoutMs: Number(process.env.BOTMUX_WORKTREE_SLUG_AI_TIMEOUT_MS) || 5_000,
    /** Extra headers for the API request (JSON string). */
    extraHeaders: (() => {
      try { return JSON.parse(process.env.BOTMUX_WORKTREE_SLUG_AI_EXTRA_HEADERS ?? '{}'); }
      catch { return {}; }
    })() as Record<string, string>,
    /** Extra body params for the API request (JSON string). */
    extraBody: (() => {
      try { return JSON.parse(process.env.BOTMUX_WORKTREE_SLUG_AI_EXTRA_BODY ?? '{}'); }
      catch { return {}; }
    })() as Record<string, unknown>,
  },
};

// allowedUsers is mutable — daemon resolves email prefixes to open_ids at startup
export type Config = typeof config;
