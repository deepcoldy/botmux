// Local-runtime helpers for the mir adapter (driving local mircli -p --lean).
// Adapted from shunminli (李舜民)'s PR #245 (src/mira-local-runtime.ts) — credit to author.
// Folded into the `mir` adapter per Plan A (mira stays Web API, mir = local mircli).
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Synchronous sleep without busy-spin (used only for short lock backoff). */
function syncSleep(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable */ }
}

/**
 * Serialize a read-modify-write of a shared config file across concurrent mir
 * sessions via an O_EXCL lockfile. Without this, two sessions in different
 * workspaces each read the old config, add their own path, and the last
 * `renameSync` clobbers the other's addition. Stale locks (crashed holder) are
 * broken after STALE_MS; if the lock can't be taken within TIMEOUT_MS we run
 * unlocked (best-effort — the caller already wraps this in try/catch).
 */
function withFileLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const STALE_MS = 10_000, TIMEOUT_MS = 3_000, STEP_MS = 50;
  const deadline = Date.now() + TIMEOUT_MS;
  let fd: number | undefined;
  for (;;) {
    try { fd = openSync(lockPath, 'wx'); break; }
    catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) { unlinkSync(lockPath); continue; }
      } catch { continue; } // lock vanished between open and stat — retry immediately
      if (Date.now() >= deadline) return fn(); // give up locking, proceed best-effort
      syncSleep(STEP_MS);
    }
  }
  try { return fn(); }
  finally {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(lockPath); } catch { /* */ }
  }
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
  // each other's write_allow_paths additions (see withFileLock).
  return withFileLock(configPath, () => patchMiramcpSandbox(paths, configPath));
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
