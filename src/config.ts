import { networkInterfaces } from 'node:os';
import type { BackendType } from './adapters/backend/types.js';
import { resolveBotmuxDataDir } from './core/data-dir.js';
import { resolveWorkerHttpHost } from './utils/worker-http.js';
import {
  globalVcMeetingAgentListenerBotAppId,
  isGlobalVcMeetingAgentEnabled,
  readGlobalConfig,
} from './global-config.js';

/** Get the first non-loopback IPv4 address, fallback to localhost. */
function getLocalIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function nonBlankHost(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** A wildcard bind (0.0.0.0 / :: / '') isn't a reachable address, so a link must
 *  resolve it to a concrete IP; a specific host is advertised verbatim. */
export function isWildcardBindHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

const configuredWebExternalHost = nonBlankHost(process.env.WEB_EXTERNAL_HOST);
const configuredDashboardExternalHost =
  nonBlankHost(process.env.BOTMUX_DASHBOARD_EXTERNAL_HOST) ?? configuredWebExternalHost;
const configuredDashboardBindHost = nonBlankHost(process.env.BOTMUX_DASHBOARD_HOST);

export function getWebExternalHost(): string {
  return configuredWebExternalHost ?? getLocalIp();
}

export function getDashboardExternalHost(): string {
  // Explicit external host → the actual (non-wildcard) listen host → LAN IP.
  // A 127.0.0.1 bind must link to 127.0.0.1, not a LAN IP nothing listens on.
  if (configuredDashboardExternalHost) return configuredDashboardExternalHost;
  if (configuredDashboardBindHost && !isWildcardBindHost(configuredDashboardBindHost)) {
    return configuredDashboardBindHost;
  }
  return getLocalIp();
}

/**
 * Default session backend: always tmux (PTY 退役).
 *
 * PTY is no longer an automatic fallback. It used to be picked here whenever
 * the tmux functional probe failed, which meant hosts with a broken/missing
 * tmux silently ran on PTY — and then hit PTY's whole problem set (no survival
 * across daemon restart, scrollback-relay quirks, …) without the user ever
 * knowing they'd been downgraded. Now the default is tmux unconditionally; if
 * tmux isn't functional the worker hard-gates the session with an actionable
 * card (see decideBackendGate). PTY remains reachable only via an explicit
 * BACKEND_TYPE=pty (or per-bot backendType:'pty') opt-in.
 */
function detectDefaultBackend(): Exclude<BackendType, 'herdr'> {
  return 'tmux';
}

// The fallback data dir used when SESSION_DATA_DIR is not set. Resolved through
// the CANONICAL resolver (core/data-dir.ts), which is HOME-based:
//   explicit SESSION_DATA_DIR → ~/.botmux/.data-dir breadcrumb → ~/.botmux/data
// and never returns an install-relative path.
//
// It used to be `new URL('../data', import.meta.url)` — the INSTALL directory's
// sibling. That was wrong in two ways and only stayed hidden because pm2's
// ecosystem config baked SESSION_DATA_DIR into every managed app's env, so the
// `??` branch was effectively dead in production:
//   1. It pointed at a directory that does not exist and is not shipped
//      (package.json `files` has no `data/`), so any reader that fell through
//      here silently used a DIFFERENT store than the CLI's own
//      resolveBotmuxDataDir() — cross-store drift for the ~389 readers of
//      config.session.dataDir (broken /pair codes, hubsSynced:0, …).
//   2. Inside a `bun build --compile` binary the install root is the read-only
//      virtual `/$bunfs`, so writers hit EACCES (observed: the codex-notifier
//      worker lease failing to mkdir '/$bunfs/data').
// The built-in supervisor replaced pm2 and does not bake that env for free, so
// the fallback has to be correct on its own. It is still read through the lazy
// getter below so a SESSION_DATA_DIR set AFTER this module is first imported
// (e.g. cli.ts subcommands doing `process.env.SESSION_DATA_DIR ??= …`) still wins.
//
// MEMOISED because the getter is on a HOT path: ~389 call sites read
// `config.session.dataDir`, some in loops, and resolveBotmuxDataDir() performs up
// to four filesystem syscalls (lstat + readFile + existsSync + stat) probing the
// `~/.botmux/.data-dir` breadcrumb. Measured: 6.27µs per uncached call vs 0.50µs
// for the env-set early return — 12.5×. The previous code computed its (wrong,
// install-relative) fallback exactly once at module load, so making it lazy must
// not also make it repeat the I/O on every read.
//
// Safe to cache: the fallback is only consulted when SESSION_DATA_DIR is unset,
// and it derives from HOME plus a breadcrumb that the daemon writes at startup —
// neither changes within a process's lifetime. A process that sets
// SESSION_DATA_DIR later never reaches this function at all, because the getter
// checks the env first.
let cachedFallbackDataDir: string | undefined;
function fallbackDataDir(): string {
  return (cachedFallbackDataDir ??= resolveBotmuxDataDir());
}

export interface ChatBotDiscoveryConfig {
  listBotsApiEnabled: boolean;
  listBotsApiTimeoutMs: number;
}

export interface HerdrTraexPluginRuntimeConfig {
  enabled: boolean;
  source: string;
  ref: string;
}

/** Startup-only handoff for a local companion process.
 *
 * This is deliberately a path, not a secret value: Botmux does not read,
 * validate, log, or fall back to the Dashboard/internal HMAC secret. */
export interface CompanionStartupConfig {
  secretFile: string | undefined;
}

/** The sole supported private secret-file configuration input. */
export const COMPANION_SECRET_FILE_ENV = 'BOTMUX_COMPANION_SECRET_FILE';

/** Resolve the fixed scoped startup handoff without touching the secret file. */
export function resolveCompanionStartupConfig(env: NodeJS.ProcessEnv = process.env): CompanionStartupConfig {
  return { secretFile: nonBlankHost(env[COMPANION_SECRET_FILE_ENV]) };
}

/**
 * Current-chat bot discovery via Lark `/members/bots`.
 *
 * Enabled by default; the dashboard Settings toggle persists the choice in
 * `~/.botmux/config.json` (`dashboard.chatBotDiscovery`). An explicit
 * `BOTMUX_LARK_LIST_BOTS_API_ENABLED` env var still overrides the persisted
 * value — the worker injects it into child panes so `botmux bots list` matches
 * the daemon's `<available_bots>`, and it doubles as an escape hatch.
 *
 * The endpoint is not public API, so every caller must keep the legacy
 * discovery path as fallback.
 */
export function resolveChatBotDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): ChatBotDiscoveryConfig {
  const envFlag = env.BOTMUX_LARK_LIST_BOTS_API_ENABLED;
  const listBotsApiEnabled =
    envFlag != null && envFlag !== ''
      ? envFlag.toLowerCase() === 'true'
      : readGlobalConfig().dashboard?.chatBotDiscovery !== false; // default ON
  return {
    listBotsApiEnabled,
    listBotsApiTimeoutMs: Number(env.BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS) || 3_000,
  };
}

/**
 * TraeX ↔ herdr plugin bootstrap is a machine-wide opt-in because the plugin
 * writes host-level `~/.trae` hooks. There is intentionally no default plugin
 * source in botmux; operators provide a `source` (owner/repo[/subdir]) they trust
 * plus an optional pinned `ref` (tag/branch/SHA) via dashboard Settings or env.
 */
export function resolveHerdrTraexPluginConfig(env: NodeJS.ProcessEnv = process.env): HerdrTraexPluginRuntimeConfig {
  const envEnabled = env.BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED;
  const dashboardCfg = readGlobalConfig().dashboard?.herdrTraexPlugin;
  const enabled = envEnabled != null && envEnabled !== ''
    ? envEnabled.toLowerCase() === 'true'
    : dashboardCfg?.enabled === true; // default OFF
  // One-cycle compatibility for review deployments of the old `spec` schema.
  // `owner/repo#ref` was never valid herdr argv; split it into the real fields.
  const legacySpec = (env.BOTMUX_HERDR_TRAEX_PLUGIN_SPEC ?? '').trim();
  const legacyHash = legacySpec.lastIndexOf('#');
  const legacySource = legacyHash > 0 ? legacySpec.slice(0, legacyHash) : legacySpec;
  const legacyRef = legacyHash > 0 ? legacySpec.slice(legacyHash + 1) : '';
  const usesLegacySpec = env.BOTMUX_HERDR_TRAEX_PLUGIN_SOURCE == null && !!legacySource;
  const source = (env.BOTMUX_HERDR_TRAEX_PLUGIN_SOURCE ?? (legacySource || dashboardCfg?.source) ?? '').trim();
  const ref = (env.BOTMUX_HERDR_TRAEX_PLUGIN_REF ?? (usesLegacySpec ? legacyRef : dashboardCfg?.ref) ?? '').trim();
  return { enabled, source, ref };
}

/** Machine-wide VC meeting listener kill-switch.
 *
 * Missing means ON for backwards compatibility. This is intentionally separate
 * from per-bot vcMeetingAgent.enabled: the global setting allows the host to
 * stop accepting/restoring VC meeting listeners without editing each bot.
 */
export function isVcMeetingAgentGloballyEnabled(): boolean {
  return isGlobalVcMeetingAgentEnabled();
}

export function vcMeetingAgentGlobalListenerBotAppId(): string | undefined {
  return globalVcMeetingAgentListenerBotAppId();
}

const DEFAULT_FORWARD_FOLLOWUP_WAIT_MS = 1_500;
const MAX_FORWARD_FOLLOWUP_WAIT_MS = 10_000;

/**
 * Grace period for coalescing a newly forwarded topic with the user's
 * immediate root-linked clarification. Zero is an explicit kill switch.
 */
export function resolveForwardFollowupWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOTMUX_FORWARD_FOLLOWUP_WAIT_MS?.trim();
  if (!raw) return DEFAULT_FORWARD_FOLLOWUP_WAIT_MS;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_FORWARD_FOLLOWUP_WAIT_MS;
  if (value === 0) return 0;
  return Math.min(MAX_FORWARD_FOLLOWUP_WAIT_MS, Math.max(1, Math.trunc(value)));
}

export const config = {
  lark: {
    appId: process.env.LARK_APP_ID ?? '',
    appSecret: process.env.LARK_APP_SECRET ?? '',
  },
  session: {
    get dataDir() { return process.env.SESSION_DATA_DIR ?? fallbackDataDir(); },
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
    forwardFollowupWaitMs: resolveForwardFollowupWaitMs(),
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
     *  require the current token. Opt out with
     *  BOTMUX_DASHBOARD_PUBLIC_READONLY=false.
     *
     *  NOTE: this env value is only the DEFAULT. Once the toggle is changed on
     *  the dashboard Settings page, `~/.botmux/config.json` holds the value and
     *  permanently takes precedence over this env var（UI 接管后改 env 不再生效；
     *  要回到 env 控制需删掉 config.json 里的 dashboard.publicReadOnly）. */
    publicReadOnly: (process.env.BOTMUX_DASHBOARD_PUBLIC_READONLY ?? 'true').toLowerCase() !== 'false',
  },
  // A local companion process consumes this typed handoff. Keep it separate
  // from dashboard/daemon HMAC configuration: there is intentionally no
  // default path and therefore no credential reuse.
  companion: resolveCompanionStartupConfig(),
  stuckDetector: {
    /**
     * Lightweight, AI-free fallback that warns the user when a written input
     * has not produced a completed turn within `timeoutMs`. Currently targets
     * the Codex PreToolUse hook-review blocking state (level 1 hooks browser
     * and level 2 per-hook review). Generic [Y/n]/permission/Press-to-continue
     * prompts are intentionally NOT handled — they cannot be safely inferred
     * from a regex and belong in a follow-up. Enabled by default because it
     * has no external dependencies and only fires when the worker confirms the
     * turn is genuinely stalled AND the snapshot matches a known hook screen.
     */
    enabled: (process.env.STUCK_DETECTOR_ENABLED ?? 'true').toLowerCase() !== 'false',
    /** Milliseconds after a write before the detector checks whether the turn
     *  is still unresolved. */
    timeoutMs: Number(process.env.STUCK_DETECTOR_TIMEOUT_MS) || 45_000,
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
  // Live getter: re-reads the dashboard toggle (~/.botmux/config.json, 2s
  // cached) on each access so a Settings change takes effect without a daemon
  // restart. The daemon's listChatBotMembers reads this per call.
  get chatBotDiscovery() { return resolveChatBotDiscoveryConfig(); },
  get herdrTraexPlugin() { return resolveHerdrTraexPluginConfig(); },
  // Live getter (like chatBotDiscovery): re-reads the experimental global toggle
  // so a Settings change enables/disables RPC input mode for new codex-family
  // sessions without a daemon restart. The daemon ORs this with each bot's own
  // `codexRpcInput` flag when building the worker init message.
  // Default OFF (absent ⇒ disabled): the hybrid RPC pane lifecycle (resume
  // respawn + ready-gate) must be live-verified before the fleet default flips
  // ON. A per-bot codexRpcInput:true still force-enables; the dashboard toggle
  // sets this global explicitly.
  get codexRpcInputDefault(): boolean { return readGlobalConfig().dashboard?.codexRpcInput === true; },
  // Live getter (like codexRpcInputDefault): re-reads the experimental global
  // toggle that gates the "no visible output" anti-resend guidance in the botmux
  // routing hints, so a Settings change takes effect on the next session without
  // a daemon restart. Default OFF (absent ⇒ disabled): the guidance mainly helps
  // when Claude Code (≥2.1.212) drives a non-Claude backend model that misreads a
  // thinking-only nudge as a send failure; it is harmless but unnecessary for the
  // common all-Claude setup, so operators opt in explicitly.
  get noVisibleOutputHint(): boolean { return readGlobalConfig().dashboard?.noVisibleOutputHint === true; },
  // Live getter: whether to auto-bypass Codex's interactive hook-trust gate for
  // Codex-family plain-TUI launches. Re-read per spawn so a Settings toggle takes
  // effect on the next session without a daemon restart (existing panes keep their
  // argv — argv can't be hot-swapped). Default ON (absent ⇒ true): only an explicit
  // stored `false` disables it. The daemon ANDs this with each bot's
  // `!disableCliBypass` before handing it to the adapter (see worker init).
  get bypassCodexHookTrust(): boolean { return readGlobalConfig().dashboard?.bypassCodexHookTrust !== false; },
};

// allowedUsers is mutable — daemon resolves email prefixes to open_ids at startup
export type Config = typeof config;
