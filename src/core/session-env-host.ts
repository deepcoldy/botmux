/**
 * Daemon-side views of the session environment for the Dashboard
 * (「会话环境变量」): the inherited baseline preview, editing rows for the global
 * and bot scopes, both tmux servers' global env tables, a running session's
 * real env (/proc/<pid>/environ) and which running sessions still use an older
 * configuration.
 *
 * Values may be credentials. Every view masks them (maskEnvValue); the raw
 * value of a single key is only returned by the explicit `reveal*` helpers,
 * which the Dashboard serves to the local owner identity only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { BackendType } from '../adapters/backend/types.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../adapters/backend/tmux-socket.js';
import type { BotConfig } from '../bot-registry.js';
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import { readRawGlobalSessionEnv } from '../global-config.js';
import { readSessionEnvStamp } from '../services/session-env-stamp.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { buildSessionChildEnv, inheritBotEnv, type EnvPolicy } from './env-policy.js';
import { identityWrapperEnvKeys, reservedSessionEnvKeys, sessionEnvLock, type SessionEnvLockContext } from './per-bot-env.js';
import { resolvePairedSpawnBackendType } from './persistent-backend.js';
import { isRemoteBackendId } from './remote-cli-ids.js';
import {
  botEnvLayer,
  buildSessionEnvRows,
  conflictingEnvLayerKeys,
  ENV_NAME_RE,
  globalEnvLayer,
  isSessionEnvName,
  maskEnvValue,
  sessionEnvRowRawValue,
  type EnvLayer,
  type MaskedEnvValue,
  type SessionEnvRow,
} from './session-env.js';
import { sessionEnvLockContextForBot, sessionEnvOverlayApplies } from './session-env-resolve.js';
import type { DaemonSession } from './types.js';
import { listActiveSessions, resolveSessionEnvForSession, sessionEnvWorkerBase } from './worker-pool.js';

export interface SessionEnvViewOptions {
  /** Viewer without reveal rights: mask every value, not just credentials. */
  maskAll?: boolean;
}

function masker(opts: SessionEnvViewOptions): (key: string, value: string) => MaskedEnvValue {
  return (key, value) => maskEnvValue(key, value, { maskAll: opts.maskAll });
}

// ─── Baseline ───────────────────────────────────────────────────────────────

export interface SessionEnvBaseline {
  /** What a session inherits before any layer (botmux-reserved names excluded). */
  baseline: Record<string, string>;
  /** Host variables botmux never hands to a session (names only). */
  redactedHostKeys: string[];
  /** Strict inheritance: host variables outside the allowlist (names only). */
  notInheritedKeys: string[];
}

/**
 * The worker's own input → `buildSessionChildEnv`, i.e. the env a NEW session
 * of a bot with `policy` starts from on this daemon. tmux/zellij/zmx panes add
 * the terminal server's global env and the login shell's rcfile on top; the
 * live-session view shows those.
 */
export function sessionEnvBaseline(policy?: EnvPolicy): SessionEnvBaseline {
  const reserved = (key: string) => sessionEnvLock(key) === 'reserved';
  const child = buildSessionChildEnv(sessionEnvWorkerBase(policy), policy);
  const baseline: Record<string, string> = {};
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined && !reserved(key)) baseline[key] = value;
  }
  const inherited = inheritBotEnv(process.env, policy);
  const redactedHostKeys = Object.keys(inherited).filter(k => !(k in child) && !reserved(k)).sort();
  const notInheritedKeys = policy?.mode === 'strict'
    ? Object.keys(process.env).filter(k => !(k in inherited) && !reserved(k)).sort()
    : [];
  return { baseline, redactedHostKeys, notInheritedKeys };
}

function effectiveBackendType(bot: BotConfig): BackendType {
  return resolvePairedSpawnBackendType(bot.cliId, undefined, bot.backendType, config.daemon.backendType);
}

// ─── Editing views ──────────────────────────────────────────────────────────

export interface SessionEnvScopeView {
  scope: 'global' | 'bot';
  rows: SessionEnvRow[];
  reserved: { keys: string[]; prefixes: string[] };
  redactedHostKeys: string[];
  /** Hand-edited layer lists a name in both set and unset (set wins). */
  conflicts: string[];
}

export interface BotSessionEnvView extends SessionEnvScopeView {
  scope: 'bot';
  larkAppId: string;
  inherit: EnvPolicy;
  notInheritedKeys: string[];
  backendType: BackendType;
  /** riff / mojo keep the bot-`env`-only contract (session-env-resolve.ts). */
  overlayApplies: boolean;
  /** Names an active identity wrapper owns for this bot, and the bot `env`
   *  entries that therefore no longer take effect. */
  identityLockedKeys: string[];
  identityIgnoredKeys: string[];
  sessions: SessionEnvSessionInfo[];
}

function globalLayerWithConflicts(): { layer: EnvLayer; conflicts: string[] } {
  const raw = readRawGlobalSessionEnv() as { set?: unknown; unset?: unknown } | undefined;
  return { layer: globalEnvLayer(raw), conflicts: conflictingEnvLayerKeys(raw?.set, raw?.unset) };
}

export function globalSessionEnvView(opts: SessionEnvViewOptions = {}): SessionEnvScopeView & { scope: 'global' } {
  const { baseline, redactedHostKeys } = sessionEnvBaseline();
  const { layer, conflicts } = globalLayerWithConflicts();
  return {
    scope: 'global',
    rows: buildSessionEnvRows({ baseline, layers: [{ source: 'global', layer }], mask: masker(opts) }),
    reserved: reservedSessionEnvKeys(),
    redactedHostKeys,
    conflicts,
  };
}

export function botSessionEnvView(bot: BotConfig, opts: SessionEnvViewOptions = {}): BotSessionEnvView {
  const ctx = sessionEnvLockContextForBot(bot);
  const { baseline, redactedHostKeys, notInheritedKeys } = sessionEnvBaseline(bot.envPolicy);
  const { layer: global } = globalLayerWithConflicts();
  const identityLockedKeys = identityWrapperEnvKeys(ctx);
  const backendType = effectiveBackendType(bot);
  return {
    scope: 'bot',
    larkAppId: bot.larkAppId,
    inherit: bot.envPolicy ?? { mode: 'inherit' },
    rows: buildSessionEnvRows({
      baseline,
      layers: [{ source: 'global', layer: global }, { source: 'bot', layer: botEnvLayer(bot) }],
      ctx,
      mask: masker(opts),
    }),
    reserved: reservedSessionEnvKeys(),
    redactedHostKeys,
    notInheritedKeys,
    // Both lists come from bot.config, normalized at load: no conflicts left.
    conflicts: [],
    backendType,
    overlayApplies: sessionEnvOverlayApplies(backendType),
    identityLockedKeys,
    identityIgnoredKeys: identityLockedKeys.filter(k => bot.env?.[k] !== undefined),
    sessions: sessionEnvSessions().filter(s => s.larkAppId === bot.larkAppId),
  };
}

/** Raw value behind one row of the global (`bot` undefined) or bot view. */
export function revealSessionEnvValue(key: string, bot?: BotConfig): string | undefined {
  if (!ENV_NAME_RE.test(key)) return undefined;
  const { baseline } = sessionEnvBaseline(bot?.envPolicy);
  const { layer: global } = globalLayerWithConflicts();
  return sessionEnvRowRawValue({
    key,
    baseline,
    layers: bot ? [{ layer: global }, { layer: botEnvLayer(bot) }] : [{ layer: global }],
    ctx: bot ? sessionEnvLockContextForBot(bot) : undefined,
  });
}

// ─── tmux servers ───────────────────────────────────────────────────────────

export interface TmuxServerEnvView {
  /** `null` = the default server. */
  socket: string | null;
  /** New managed (`bmx-*`) sessions are created on this server. */
  managed: boolean;
  /** A server is running on this socket. */
  found: boolean;
  vars: Array<{ key: string; value: string; masked?: boolean }>;
}

/** The default server plus the socket new managed sessions use (tmux-socket.ts). */
export function sessionEnvTmuxSockets(): Array<{ socket: string | null; managed: boolean }> {
  const preferred = preferredManagedTmuxSocket() ?? null;
  return preferred === null
    ? [{ socket: null, managed: true }]
    : [{ socket: null, managed: false }, { socket: preferred, managed: true }];
}

/** `tmux show-environment -g`: the env a server froze when it started (plus later set-environment -g). */
export function readTmuxServerGlobalEnv(socket: string | null): { found: boolean; vars: Record<string, string> } {
  let output: string;
  try {
    output = execFileSync('tmux', [...tmuxSocketArgs(socket ?? undefined), 'show-environment', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: tmuxEnv(),
    });
  } catch {
    return { found: false, vars: {} };
  }
  const vars: Record<string, string> = {};
  for (const line of String(output).split('\n')) {
    // `-NAME` marks an explicitly removed entry; it holds no value.
    if (!line || line.startsWith('-')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (ENV_NAME_RE.test(key)) vars[key] = line.slice(eq + 1);
  }
  return { found: true, vars };
}

export function tmuxServersEnvView(opts: SessionEnvViewOptions = {}): TmuxServerEnvView[] {
  const mask = masker(opts);
  return sessionEnvTmuxSockets().map(({ socket, managed }) => {
    const { found, vars } = readTmuxServerGlobalEnv(socket);
    return {
      socket,
      managed,
      found,
      vars: Object.keys(vars).sort().map(key => {
        const m = mask(key, vars[key]!);
        return { key, value: m.value, ...(m.masked ? { masked: true } : {}) };
      }),
    };
  });
}

function knownTmuxSocket(socket: string | null): boolean {
  return sessionEnvTmuxSockets().some(s => s.socket === socket);
}

export function revealTmuxServerEnvValue(socket: string | null, key: string): string | undefined {
  if (!knownTmuxSocket(socket) || !ENV_NAME_RE.test(key)) return undefined;
  return readTmuxServerGlobalEnv(socket).vars[key];
}

/**
 * Remove one variable from a server's global env (`set-environment -g -u`).
 * A one-off repair: panes created afterwards stop inheriting it, running
 * panes keep theirs, and a server started later freezes its own env again.
 */
export function removeTmuxServerGlobalEnv(
  socket: string | null,
  key: string,
): { ok: true; removed: boolean } | { ok: false; error: 'unknown_socket' | 'invalid_key' | 'server_not_running' | 'tmux_failed' } {
  if (!knownTmuxSocket(socket)) return { ok: false, error: 'unknown_socket' };
  if (!isSessionEnvName(key)) return { ok: false, error: 'invalid_key' };
  const before = readTmuxServerGlobalEnv(socket);
  if (!before.found) return { ok: false, error: 'server_not_running' };
  if (!(key in before.vars)) return { ok: true, removed: false };
  try {
    execFileSync('tmux', [...tmuxSocketArgs(socket ?? undefined), 'set-environment', '-g', '-u', key], {
      stdio: 'ignore',
      timeout: 3000,
      env: tmuxEnv(),
    });
  } catch {
    return { ok: false, error: 'tmux_failed' };
  }
  return { ok: true, removed: true };
}

// ─── Running sessions ───────────────────────────────────────────────────────

export interface SessionEnvSessionInfo {
  sessionId: string;
  larkAppId: string;
  title: string;
  chatId: string;
  backendType: BackendType;
  /** tmux sessions: the server it lives on (`null` = default server). */
  tmuxSocket?: string | null;
  /** Launched with a different configured env than the current one; `null` =
   *  launched before stamps existed (unknown). */
  stale: boolean | null;
}

function isAdoptedSession(ds: DaemonSession): boolean {
  return !!ds.adoptedFrom || ds.initConfig?.adoptMode === true;
}

function sessionBackendType(ds: DaemonSession): BackendType {
  return ds.initConfig?.backendType ?? ds.session.backendType ?? 'pty';
}

/** Sessions of this daemon whose CLI is running now (botmux-launched only). */
export function sessionEnvSessions(): SessionEnvSessionInfo[] {
  const out: SessionEnvSessionInfo[] = [];
  for (const ds of listActiveSessions()) {
    if (!ds.worker || ds.worker.killed || isAdoptedSession(ds)) continue;
    let bot: BotConfig;
    try { bot = getBot(ds.larkAppId).config; } catch { continue; }
    const stamp = readSessionEnvStamp(config.session.dataDir, ds.session.sessionId);
    const target = ds.session.persistentBackendTarget;
    out.push({
      sessionId: ds.session.sessionId,
      larkAppId: ds.larkAppId,
      title: ds.session.title || ds.session.sessionId,
      chatId: ds.chatId,
      backendType: sessionBackendType(ds),
      ...(target?.backendType === 'tmux' ? { tmuxSocket: target.socketName ?? null } : {}),
      stale: stamp === undefined ? null : stamp !== resolveSessionEnvForSession(ds, bot).fingerprint,
    });
  }
  return out;
}

export type LiveSessionEnvSource = 'reserved' | 'bot' | 'global' | 'host' | 'tmux-server' | 'other';

export interface LiveSessionEnvRow {
  key: string;
  value: string;
  masked?: boolean;
  /** Best-effort attribution by value against the CURRENT configuration. */
  source: LiveSessionEnvSource;
  /** The current configuration would remove / change this variable. */
  drift?: 'unset' | 'changed';
}

export type LiveSessionEnvResult =
  | {
    ok: true;
    sessionId: string;
    pid: number;
    backendType: BackendType;
    tmuxSocket?: string | null;
    stale: boolean | null;
    rows: LiveSessionEnvRow[];
    /** Variables the current configuration sets that this process lacks. */
    missingSetKeys: string[];
  }
  | { ok: false; error: 'not_running' | 'adopted' | 'remote_backend' | 'unsupported_platform' | 'no_pid' | 'process_gone' | 'unreadable' };

type LiveEnvRead =
  | { ok: true; pid: number; env: Record<string, string> }
  | { ok: false; error: Exclude<LiveSessionEnvResult, { ok: true }>['error'] };

/**
 * The CLI's real environment. The pid comes from the worker's trusted IPC
 * attestation and must still have the attested start identity before AND
 * after the read, so a recycled pid can never be shown as this session.
 */
function readLiveSessionEnv(ds: DaemonSession): LiveEnvRead {
  if (isAdoptedSession(ds)) return { ok: false, error: 'adopted' };
  if (!ds.worker || ds.worker.killed) return { ok: false, error: 'not_running' };
  if (isRemoteBackendId(sessionBackendType(ds))) return { ok: false, error: 'remote_backend' };
  if (process.platform !== 'linux') return { ok: false, error: 'unsupported_platform' };
  const att = ds.localProcessAttestation;
  const pid = att?.cliPid;
  if (!att || !pid || (att.workerGeneration !== undefined && ds.workerGeneration !== undefined
    && att.workerGeneration !== ds.workerGeneration)) {
    return { ok: false, error: 'no_pid' };
  }
  const startedAs = () => readProcessStartIdentity(pid);
  const before = startedAs();
  if (!before || (att.cliProcStart && before !== att.cliProcStart)) return { ok: false, error: 'process_gone' };
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return { ok: false, error: 'unreadable' }; }
  if (startedAs() !== before) return { ok: false, error: 'process_gone' };
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return { ok: true, pid, env };
}

export function liveSessionEnvView(ds: DaemonSession, opts: SessionEnvViewOptions = {}): LiveSessionEnvResult {
  const read = readLiveSessionEnv(ds);
  if (!read.ok) return read;
  let bot: BotConfig | undefined;
  try { bot = getBot(ds.larkAppId).config; } catch { bot = undefined; }
  const ctx: SessionEnvLockContext = bot ? sessionEnvLockContextForBot(bot) : {};
  const composed = bot ? resolveSessionEnvForSession(ds, bot).composed : { set: {}, unset: [] };
  const botLayer = bot ? botEnvLayer(bot) : { set: {}, unset: [] };
  const { baseline } = sessionEnvBaseline(bot?.envPolicy);
  const target = ds.session.persistentBackendTarget;
  const tmuxSocket = target?.backendType === 'tmux' ? target.socketName ?? null : undefined;
  const serverVars = tmuxSocket !== undefined ? readTmuxServerGlobalEnv(tmuxSocket).vars : {};
  const mask = masker(opts);
  const rows: LiveSessionEnvRow[] = Object.keys(read.env).sort().map(key => {
    const value = read.env[key]!;
    const lock = sessionEnvLock(key, ctx);
    const source: LiveSessionEnvSource = lock === 'reserved' || lock === 'identity' ? 'reserved'
      : composed.set[key] === value ? (botLayer.set[key] === value ? 'bot' : 'global')
        : baseline[key] === value ? 'host'
          : serverVars[key] === value ? 'tmux-server'
            : 'other';
    const drift = composed.unset.includes(key) ? 'unset' as const
      : key in composed.set && composed.set[key] !== value ? 'changed' as const
        : undefined;
    const m = mask(key, value);
    return { key, value: m.value, ...(m.masked ? { masked: true } : {}), source, ...(drift ? { drift } : {}) };
  });
  const stamp = readSessionEnvStamp(config.session.dataDir, ds.session.sessionId);
  return {
    ok: true,
    sessionId: ds.session.sessionId,
    pid: read.pid,
    backendType: sessionBackendType(ds),
    ...(tmuxSocket !== undefined ? { tmuxSocket } : {}),
    stale: stamp === undefined || !bot ? null : stamp !== resolveSessionEnvForSession(ds, bot).fingerprint,
    rows,
    missingSetKeys: Object.keys(composed.set).filter(k => !(k in read.env)).sort(),
  };
}

export function revealLiveSessionEnvValue(ds: DaemonSession, key: string): string | undefined {
  if (!ENV_NAME_RE.test(key)) return undefined;
  const read = readLiveSessionEnv(ds);
  return read.ok ? read.env[key] : undefined;
}
