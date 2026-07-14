import { execFile } from 'node:child_process';
import { copyFile, open, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const DEFAULT_LOG_ROTATE_MAX_SIZE_MB = 100;
export const DEFAULT_LOG_ROTATE_KEEP = 3;

export interface LogRotationConfig {
  enabled: boolean;
  maxSizeBytes: number;
  keep: number;
}

export interface LogFileFact {
  path: string;
  size: number;
}

export type LogRotationAction =
  | { kind: 'remove'; path: string }
  | { kind: 'rename'; from: string; to: string; active: boolean };

export interface LogFileRotationPlan {
  path: string;
  size: number;
  actions: LogRotationAction[];
}

export interface LogRotationResult {
  oversized: number;
  rotated: string[];
  copyTruncated: string[];
  pendingReloads: string[];
  errors: Array<{ path: string; message: string }>;
  reloaded: boolean;
}

export interface LogRotationIo {
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  truncate(path: string): Promise<void>;
  touch(path: string): Promise<void>;
}

const productionIo: LogRotationIo = {
  remove: (path) => rm(path, { force: true }),
  rename,
  copyFile,
  truncate: (path) => truncate(path, 0),
  touch: async (path) => {
    const handle = await open(path, 'a');
    await handle.close();
  },
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Environment overrides are an emergency/operator escape hatch; rotation is on by default. */
export function resolveLogRotationConfig(env: NodeJS.ProcessEnv = process.env): LogRotationConfig {
  const enabledValue = env.BOTMUX_LOG_ROTATE_ENABLED?.trim().toLowerCase();
  const enabled = enabledValue !== '0' && enabledValue !== 'false' && enabledValue !== 'off';
  const maxSizeMb = positiveNumber(env.BOTMUX_LOG_ROTATE_MAX_SIZE_MB, DEFAULT_LOG_ROTATE_MAX_SIZE_MB);
  const keep = Math.min(positiveInteger(env.BOTMUX_LOG_ROTATE_KEEP, DEFAULT_LOG_ROTATE_KEEP), 20);
  return { enabled, maxSizeBytes: Math.max(1, Math.floor(maxSizeMb * 1024 * 1024)), keep };
}

export function botmuxLogDir(home: string = homedir()): string {
  return join(home, '.botmux', 'logs');
}

/** Pure plan: file facts in, deterministic rotation operations out. */
export function planLogRotation(
  files: readonly LogFileFact[],
  config: Pick<LogRotationConfig, 'maxSizeBytes' | 'keep'>,
): LogFileRotationPlan[] {
  return files
    .filter((file) => file.path.endsWith('.log') && file.size >= config.maxSizeBytes)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const actions: LogRotationAction[] = [{ kind: 'remove', path: `${file.path}.${config.keep}` }];
      for (let index = config.keep - 1; index >= 1; index--) {
        actions.push({ kind: 'rename', from: `${file.path}.${index}`, to: `${file.path}.${index + 1}`, active: false });
      }
      actions.push({ kind: 'rename', from: file.path, to: `${file.path}.1`, active: true });
      return { ...file, actions };
    });
}

export interface LogDirectorySnapshot {
  files: LogFileFact[];
  /** PM2 logs renamed on a previous tick whose reload failed before base recreation. */
  pendingReloads: string[];
}

function isPm2ManagedLogName(name: string): boolean {
  return /^(?:daemon(?:-\d+)?-(?:out|error)|dashboard-(?:out|error))\.log$/.test(name);
}

function isPm2ManagedLogPath(path: string): boolean {
  return isPm2ManagedLogName(basename(path));
}

export async function inspectLogDirectory(logDir: string): Promise<LogDirectorySnapshot> {
  let entries;
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { files: [], pendingReloads: [] };
    throw error;
  }
  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map(async (entry): Promise<LogFileFact | undefined> => {
      const path = join(logDir, entry.name);
      try {
        return { path, size: (await stat(path)).size };
      } catch (error) {
        // A concurrent manual cleanup may remove a file between readdir/stat.
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    }));
  const pendingReloads = [...fileNames]
    .filter((name) => name.endsWith('.log.1'))
    .map((name) => name.slice(0, -2))
    .filter((base) => isPm2ManagedLogName(base) && !fileNames.has(base))
    .sort()
    .map((base) => join(logDir, base));
  return {
    files: files.filter((fact): fact is LogFileFact => fact !== undefined),
    pendingReloads,
  };
}

export async function listLogFiles(logDir: string): Promise<LogFileFact[]> {
  return (await inspectLogDirectory(logDir)).files;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renameHistory(io: LogRotationIo, action: Extract<LogRotationAction, { kind: 'rename' }>): Promise<void> {
  try {
    await io.rename(action.from, action.to);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function rotateOne(plan: LogFileRotationPlan, io: LogRotationIo): Promise<'renamed' | 'copytruncate'> {
  const active = plan.actions.at(-1);
  if (!active || active.kind !== 'rename' || !active.active) throw new Error('invalid log rotation plan');

  for (const action of plan.actions.slice(0, -1)) {
    if (action.kind === 'remove') await io.remove(action.path);
    else await renameHistory(io, action);
  }

  try {
    await io.rename(active.from, active.to);
    return 'renamed';
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EBUSY' && code !== 'EPERM') throw error;
  }

  // Windows may refuse to rename a file while PM2 holds it open. Preserve the
  // current contents, then truncate the same inode so the writer can continue.
  await io.copyFile(active.from, active.to);
  try {
    await io.truncate(active.from);
  } catch (error) {
    await io.remove(active.to).catch(() => undefined);
    throw error;
  }
  return 'copytruncate';
}

/** Execute all planned rotations and ask PM2 to reopen logs exactly once. */
export async function executeLogRotation(
  plans: readonly LogFileRotationPlan[],
  deps: { io?: LogRotationIo; reloadLogs: () => Promise<void>; pendingReloads?: readonly string[] },
): Promise<LogRotationResult> {
  const io = deps.io ?? productionIo;
  const result: LogRotationResult = {
    oversized: plans.length,
    rotated: [],
    copyTruncated: [],
    pendingReloads: [...(deps.pendingReloads ?? [])],
    errors: [],
    reloaded: false,
  };
  const renamedPm2Bases: string[] = [];

  for (const plan of plans) {
    try {
      const mode = await rotateOne(plan, io);
      result.rotated.push(plan.path);
      if (mode === 'copytruncate') result.copyTruncated.push(plan.path);
      else if (isPm2ManagedLogPath(plan.path)) renamedPm2Bases.push(plan.path);
    } catch (error) {
      result.errors.push({ path: plan.path, message: errorMessage(error) });
    }
  }

  const reloadBases = [...new Set([...result.pendingReloads, ...renamedPm2Bases])];
  const pm2FilesRotated = result.rotated.some(isPm2ManagedLogPath);
  if (pm2FilesRotated || reloadBases.length > 0) {
    try {
      await deps.reloadLogs();
    } catch (error) {
      result.errors.push({ path: 'pm2:reloadLogs', message: errorMessage(error) });
      result.pendingReloads = reloadBases;
      return result;
    }
    result.reloaded = true;
    result.pendingReloads = [];
    // Running processes normally recreate these paths during reload. Touching
    // is harmless for them and prevents a stopped PM2 process from looking
    // like an unpaid reload debt forever.
    for (const path of reloadBases) {
      try {
        await io.touch(path);
      } catch (error) {
        result.errors.push({ path, message: errorMessage(error) });
      }
    }
  }
  return result;
}

/** PM2 keeps old file descriptors after rename; reloadLogs is required to reopen base paths. */
export function reloadPm2Logs(): Promise<void> {
  const pm2Script = require.resolve('pm2/bin/pm2');
  return execFileAsync(process.execPath, [pm2Script, 'reloadLogs'], {
    cwd: homedir(),
    env: {
      ...process.env,
      PM2_HOME: process.env.PM2_HOME ?? join(homedir(), '.botmux', 'pm2'),
    },
    timeout: 15_000,
  }).then(() => undefined);
}

export async function rotateBotmuxLogs(input: {
  logDir?: string;
  config?: LogRotationConfig;
  reloadLogs?: () => Promise<void>;
  io?: LogRotationIo;
} = {}): Promise<LogRotationResult> {
  const config = input.config ?? resolveLogRotationConfig();
  if (!config.enabled) return { oversized: 0, rotated: [], copyTruncated: [], pendingReloads: [], errors: [], reloaded: false };
  const snapshot = await inspectLogDirectory(input.logDir ?? botmuxLogDir());
  const plans = planLogRotation(snapshot.files, config);
  return executeLogRotation(plans, {
    io: input.io,
    reloadLogs: input.reloadLogs ?? reloadPm2Logs,
    pendingReloads: snapshot.pendingReloads,
  });
}
