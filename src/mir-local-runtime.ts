// Local-runtime helpers for the mir adapter (driving local mircli -p).
// Adapted from shunminli (李舜民)'s PR #245 (src/mira-local-runtime.ts) — credit to author.
// Folded into the `mir` adapter per Plan A (mira stays Web API, mir = local mircli).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isExecutable, locateExecutable } from './utils/executable.js';
import { withFileLockSync } from './utils/file-lock.js';
import { logger } from './utils/logger.js';

/** Synchronous sleep without busy-spin (used only for short startup polling). */
function syncSleep(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable */ }
}

type JsonObject = Record<string, any>;

export interface MiraRuntimePaths {
  cwd: string;
  home: string;
  logicalCwd?: string;
  allowedPathCandidates: string[];
}

export interface MiramcpPatchResult {
  configPath: string;
  changed: boolean;
  added: string[];
  skipped?: string;
}

export type MiramcpAutostartStatus =
  | 'started'
  | 'started_pending'
  | 'already_running'
  | 'disabled'
  | 'missing_device_id'
  | 'missing_bin'
  | 'missing_config'
  | 'invalid_config'
  | 'spawn_failed';

export interface MiramcpAutostartResult {
  status: MiramcpAutostartStatus;
  configPath: string;
  pidFile: string;
  deviceId?: string;
  binPath?: string;
  pid?: number;
  error?: string;
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    detached: true;
    stdio: 'ignore';
    env: NodeJS.ProcessEnv;
  },
) => { pid?: number; unref?: () => void; once?: (event: 'error' | 'exit', listener: (...args: any[]) => void) => unknown };

type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    stdio: 'pipe';
  },
) => { stdout?: string | Buffer | null; error?: unknown };

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const STARTUP_PENDING_PID_GRACE_MS = 30_000;
const STARTUP_TIMEOUT_ERROR = 'miramcp did not bind port 9801 during startup';
const PENDING_PORT_ERROR = 'miramcp pid is still starting; port 9801 is not listening yet';

export interface MiramcpAutostartOptions {
  configPath?: string;
  pidFile?: string;
  binPath?: string;
  mircliBin?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
  spawnSyncImpl?: SpawnSyncLike;
  processExists?: (pid: number) => boolean;
  startupTimeoutMs?: number;
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function isSubpath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function deriveHomeLogicalCwd(cwd: string, home: string, realHome?: string): string | undefined {
  if (!realHome || realHome === home) return undefined;
  const resolvedCwd = resolve(cwd);
  const resolvedRealHome = resolve(realHome);
  if (!isSubpath(resolvedCwd, resolvedRealHome)) return undefined;
  const suffix = relative(resolvedRealHome, resolvedCwd);
  return suffix ? join(home, suffix) : home;
}

function pathStartsWithRawPrefix(path: string, prefix: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedPrefix = resolve(prefix);
  if (normalizedPath === normalizedPrefix) return true;
  const withSep = normalizedPrefix.endsWith(sep) ? normalizedPrefix : `${normalizedPrefix}${sep}`;
  return normalizedPath.startsWith(withSep);
}

export function getMiraRuntimePaths(opts: {
  cwd?: string;
  home?: string;
  envPwd?: string;
  realHome?: string;
} = {}): MiraRuntimePaths {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = resolve(opts.home ?? homedir());
  const envPwd = opts.envPwd && isAbsolute(opts.envPwd) ? resolve(opts.envPwd) : undefined;
  const realHome = opts.realHome ?? safeRealpath(home);
  const logicalCwd = deriveHomeLogicalCwd(cwd, home, realHome);
  const allowedPathCandidates = unique([
    cwd,
    logicalCwd,
    envPwd,
  ].filter((path): path is string => !!path));

  return { cwd, home, logicalCwd, allowedPathCandidates };
}

function miramcpConfigPath(): string {
  return process.env.MIRAMCP_CONFIG_PATH || join(homedir(), '.miramcp', 'config.json');
}

function miraConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIRA_CONFIG_PATH || join(homedir(), '.mira', 'config.json');
}

function miramcpPidFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIRAMCP_PID_FILE || join(homedir(), '.mira', 'miramcp', 'miramcp.pid');
}

function findMiraLocalMcp(config: JsonObject): JsonObject | undefined {
  const mcps = Array.isArray(config.mcps) ? config.mcps : [];
  return mcps.find((mcp: unknown): mcp is JsonObject =>
    !!mcp && typeof mcp === 'object' && (mcp as JsonObject).id === 'mira_local',
  );
}

export function ensureMiramcpSandboxAllows(paths: string[], configPath = miramcpConfigPath()): MiramcpPatchResult {
  if (!existsSync(configPath)) {
    return { configPath, changed: false, added: [], skipped: 'missing_config' };
  }
  // Lock the whole read-modify-write so concurrent mir sessions can't clobber
  // each other's write_allow_paths additions (see withFileLockSync).
  return withFileLockSync(configPath, () => patchMiramcpSandbox(paths, configPath));
}

function patchMiramcpSandbox(paths: string[], configPath: string): MiramcpPatchResult {
  if (!existsSync(configPath)) {
    return { configPath, changed: false, added: [], skipped: 'missing_config' };
  }

  let config: JsonObject;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { configPath, changed: false, added: [], skipped: 'invalid_config' };
  }

  const mcp = findMiraLocalMcp(config);
  if (!mcp) {
    return { configPath, changed: false, added: [], skipped: 'missing_mira_local' };
  }

  const sandbox = (mcp.sandbox && typeof mcp.sandbox === 'object') ? mcp.sandbox as JsonObject : {};
  mcp.sandbox = sandbox;
  const writeAllowPaths = Array.isArray(sandbox.write_allow_paths) ? sandbox.write_allow_paths : [];
  sandbox.write_allow_paths = writeAllowPaths;

  const existing = writeAllowPaths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  const added: string[] = [];
  for (const candidate of unique(paths.map(path => resolve(path)))) {
    if (!isAbsolute(candidate)) continue;
    if (existing.some(allowed => pathStartsWithRawPrefix(candidate, allowed))) continue;
    writeAllowPaths.push(candidate);
    existing.push(candidate);
    added.push(candidate);
  }

  if (added.length === 0) {
    return { configPath, changed: false, added: [] };
  }

  const tmpPath = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, configPath);
  return { configPath, changed: true, added };
}

function detectMiramcpBin(opts: MiramcpAutostartOptions, env: NodeJS.ProcessEnv): string | undefined {
  const explicit = locateExecutable(opts.binPath || env.MIRAMCP_BIN, env);
  if (explicit) return explicit;

  const candidates: string[] = [];
  const mircliBin = opts.mircliBin || env.MIRCLI_BIN;
  if (mircliBin && isAbsolute(mircliBin)) {
    candidates.push(join(dirname(mircliBin), 'miramcp'), join(dirname(mircliBin), 'mira_cli'));
  }
  candidates.push(
    join(homedir(), '.local', 'bin', 'miramcp'),
    join(homedir(), '.local', 'bin', 'mira_cli'),
  );
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return locateExecutable('miramcp', env) || locateExecutable('mira_cli', env) || undefined;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPidFromFile(pidFile: string, processExists: (pid: number) => boolean): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && processExists(pid)) return pid;
  } catch {
    // ignore invalid pid file
  }
  try { unlinkSync(pidFile); } catch { /* best effort */ }
  return undefined;
}

function removePidFileIfMatches(pidFile: string, pid: number): void {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(pid)) unlinkSync(pidFile);
  } catch {
    // Best-effort cleanup; a later turn re-checks pid + port before reuse.
  }
}

function pidFileAgeMs(pidFile: string): number | undefined {
  try {
    return Date.now() - statSync(pidFile).mtimeMs;
  } catch {
    return undefined;
  }
}

function portHasListener(spawnSyncImpl: SpawnSyncLike): boolean | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const result = spawnSyncImpl('lsof', ['-ti:9801'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: 'pipe',
    });
    if (result.error) return undefined;
    return Boolean((result.stdout || '').toString().trim());
  } catch {
    return undefined;
  }
}

function startupTimeoutMs(opts: MiramcpAutostartOptions): number {
  const raw = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_STARTUP_TIMEOUT_MS;
}

function waitForMiramcpStartup(opts: {
  pid: number;
  processExists: (pid: number) => boolean;
  spawnSyncImpl: SpawnSyncLike;
  timeoutMs: number;
  asyncFailure: () => string | undefined;
}): { ok: true } | { ok: false; error: string } {
  const deadline = Date.now() + opts.timeoutMs;
  let portCheckUnknown = false;
  for (;;) {
    const asyncError = opts.asyncFailure();
    if (asyncError) return { ok: false, error: asyncError };
    if (!opts.processExists(opts.pid)) return { ok: false, error: 'miramcp exited during startup' };
    const portListening = portHasListener(opts.spawnSyncImpl);
    if (portListening === true) return { ok: true };
    if (portListening === undefined) portCheckUnknown = true;
    if (Date.now() >= deadline) {
      if (portCheckUnknown) return { ok: true };
      return { ok: false, error: STARTUP_TIMEOUT_ERROR };
    }
    syncSleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

function readMiraConfig(configPath: string): JsonObject | undefined | null {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

export function ensureMiramcpBridgeStarted(opts: MiramcpAutostartOptions = {}): MiramcpAutostartResult {
  const env = opts.env || process.env;
  const configPath = opts.configPath || miraConfigPath(env);
  const pidFile = opts.pidFile || miramcpPidFile(env);
  const preflightConfig = readMiraConfig(configPath);
  if (preflightConfig === undefined && !env.MIRA_DEVICE_ID) {
    return { status: 'missing_config', configPath, pidFile };
  }
  if (preflightConfig === null) {
    return { status: 'invalid_config', configPath, pidFile };
  }
  if (preflightConfig?.auto_start_bridge === false) {
    return { status: 'disabled', configPath, pidFile };
  }
  if (!String(env.MIRA_DEVICE_ID || preflightConfig?.device_id || '').trim()) {
    return { status: 'missing_device_id', configPath, pidFile };
  }

  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    return withFileLockSync(pidFile, () => ensureMiramcpBridgeStartedUnlocked(opts, env, configPath, pidFile));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: 'spawn_failed', configPath, pidFile, error };
  }
}

function ensureMiramcpBridgeStartedUnlocked(
  opts: MiramcpAutostartOptions,
  env: NodeJS.ProcessEnv,
  configPath: string,
  pidFile: string,
): MiramcpAutostartResult {
  const config = readMiraConfig(configPath);
  if (config === undefined && !env.MIRA_DEVICE_ID) {
    return { status: 'missing_config', configPath, pidFile };
  }
  if (config === null) {
    return { status: 'invalid_config', configPath, pidFile };
  }
  if (config?.auto_start_bridge === false) {
    return { status: 'disabled', configPath, pidFile };
  }

  const deviceId = String(env.MIRA_DEVICE_ID || config?.device_id || '').trim();
  if (!deviceId) {
    return { status: 'missing_device_id', configPath, pidFile };
  }

  const processExists = opts.processExists || defaultProcessExists;
  const spawnSyncImpl = opts.spawnSyncImpl || spawnSync;
  const pid = runningPidFromFile(pidFile, processExists);
  if (pid) {
    const portListening = portHasListener(spawnSyncImpl);
    if (portListening !== false) {
      return { status: 'already_running', configPath, pidFile, deviceId, pid };
    }
    const ageMs = pidFileAgeMs(pidFile);
    if (ageMs !== undefined && ageMs < STARTUP_PENDING_PID_GRACE_MS) {
      return { status: 'started_pending', configPath, pidFile, deviceId, pid, error: PENDING_PORT_ERROR };
    }
    removePidFileIfMatches(pidFile, pid);
    logger.warn(`[miramcp-autostart] pidfile ${pidFile} pointed at live pid ${pid}, but port 9801 is not listening; treating it as stale`);
  }

  if (portHasListener(spawnSyncImpl)) {
    return { status: 'already_running', configPath, pidFile, deviceId };
  }

  const binPath = detectMiramcpBin(opts, env);
  if (!binPath) {
    return { status: 'missing_bin', configPath, pidFile, deviceId };
  }

  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    const child = (opts.spawnImpl || spawn)(binPath, ['run', '--device-id', deviceId], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    let pidWritten = false;
    let asyncFailure: string | undefined;
    const cleanup = (reason: string): void => {
      asyncFailure ??= reason;
      if (child.pid && pidWritten) removePidFileIfMatches(pidFile, child.pid);
      logger.warn(`[miramcp-autostart] bridge process ended before/after startup: ${reason}`);
    };
    child.once?.('error', (err: Error) => {
      cleanup(`spawn error: ${err instanceof Error ? err.message : String(err)}`);
    });
    child.once?.('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
    child.unref?.();
    if (!child.pid) {
      return { status: 'spawn_failed', configPath, pidFile, deviceId, binPath, error: 'missing child pid' };
    }
    const timeoutMs = startupTimeoutMs(opts);
    const startup = waitForMiramcpStartup({
      pid: child.pid,
      processExists,
      spawnSyncImpl,
      timeoutMs,
      asyncFailure: () => asyncFailure,
    });
    if (!startup.ok) {
      if (startup.error === STARTUP_TIMEOUT_ERROR && processExists(child.pid)) {
        writeFileSync(pidFile, String(child.pid), 'utf8');
        pidWritten = true;
        logger.warn(`[miramcp-autostart] bridge pid ${child.pid} still starting after ${timeoutMs}ms; wrote pidfile to avoid duplicate autostarts`);
        return { status: 'started_pending', configPath, pidFile, deviceId, binPath, pid: child.pid, error: startup.error };
      }
      return { status: 'spawn_failed', configPath, pidFile, deviceId, binPath, pid: child.pid, error: startup.error };
    }
    writeFileSync(pidFile, String(child.pid), 'utf8');
    pidWritten = true;
    return { status: 'started', configPath, pidFile, deviceId, binPath, pid: child.pid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: 'spawn_failed', configPath, pidFile, deviceId, binPath, error };
  }
}
