/**
 * Synchronous hc calls for HcBackend.spawn(): SessionBackend.spawn is
 * synchronous, and the worker reads isReattach and commits read isolation as
 * soon as it returns, so the terminal must already be created or verified by
 * then. Each call spawns the discovered binary with the control env.
 */
import { spawnSync } from 'node:child_process';
import { HC_MIN_VERSION, compareHcVersion, parseHcSemver, probeHcAvailability } from '../../../setup/ensure-hc.js';
import {
  ensureHcConfig,
  hcControlEnv,
  hcCorePaths,
  hcRuntimeDirError,
  parseHcCliError,
  type HcCoreAddress,
} from './core.js';

/** Above hc's own 15 s wait for a starting core, so hc reports its failure first. */
export const HC_SYNC_START_TIMEOUT_MS = 20_000;
const HC_SYNC_MAX_BUFFER = 1024 * 1024;

/**
 * Retry delays for startup-time hc calls, as TmuxPipeBackend spaces its own:
 * every daemon of a uid shares one core, and a restore or a post-outage
 * restart herd can stall it past a single call's deadline.
 */
export const HC_STARTUP_RETRY_DELAYS_MS = [1_000, 3_000];

/** Blocking, like TmuxPipeBackend's: SessionBackend.spawn is synchronous. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let startupRetrySleepFn: (ms: number) => void = sleepSyncMs;

export function sleepHcStartupRetry(ms: number): void {
  startupRetrySleepFn(ms);
}

/** Test seam: Atomics.wait ignores fake timers. Pass null to restore the real sleep. */
export function setHcStartupRetrySleepForTests(fn: ((ms: number) => void) | null): void {
  startupRetrySleepFn = fn ?? sleepSyncMs;
}

/** No answer from hc, or hc could not reach a core: the same call may succeed later. */
export function isTransientHcFailure(kind: string | null): boolean {
  return kind === null || kind === 'unavailable';
}

export interface HcSyncCore {
  bin: string;
  env: NodeJS.ProcessEnv;
  socket: string;
}

export type HcSyncReply<T> =
  | { ok: true; value: T }
  /** `kind` is hc's error kind (not_found, name_taken, ...), null when hc gave no answer. */
  | { ok: false; kind: string | null; message: string };

/** The binary and control env for a frozen core; throws a readable reason when no hc call may run. */
export function prepareHcSyncCore(core: HcCoreAddress, base: NodeJS.ProcessEnv = process.env): HcSyncCore {
  const availability = probeHcAvailability({ env: base });
  if (!availability.ok) throw new Error(availability.reason);
  const paths = hcCorePaths(base, { core });
  const noRuntimeDir = hcRuntimeDirError(paths);
  if (noRuntimeDir) throw new Error(noRuntimeDir);
  ensureHcConfig(paths.configHome);
  return { bin: availability.bin, env: hcControlEnv(base, paths), socket: paths.socket };
}

/** One hc CLI run with the core's control env; `kind` as in {@link HcSyncReply}. */
export function runHcSync(
  core: HcSyncCore,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
  maxBuffer: number = HC_SYNC_MAX_BUFFER,
): { ok: true; stdout: string } | { ok: false; kind: string | null; message: string } {
  const label = `hc ${args.filter(arg => arg !== '--json').join(' ')}`;
  const result = spawnSync(core.bin, args, {
    env: core.env,
    cwd: '/',
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      kind: null,
      message: code === 'ETIMEDOUT' ? `${label} 超过 ${timeoutMs}ms 未返回` : `${label} 无法执行：${result.error.message}`,
    };
  }
  if (result.status === 0) return { ok: true, stdout: result.stdout };
  const error = parseHcCliError(result.stderr);
  if (error) return { ok: false, kind: error.kind, message: `${label}：${error.message}` };
  const detail = result.stderr.trim().split('\n')[0];
  return {
    ok: false,
    kind: null,
    message: `${label} 失败（${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}）${detail ? `：${detail}` : ''}`,
  };
}

/**
 * `server start`: joins the running core, or starts one from the control env
 * when nothing listens. Throws when there is none afterwards, or when it runs
 * below HC_MIN_VERSION (stopping it would end its terminals).
 */
export function startHcCoreSync(core: HcSyncCore, timeoutMs: number = HC_SYNC_START_TIMEOUT_MS): { version: string; pid: number } {
  let started = runHcSync(core, ['--json', 'server', 'start'], undefined, timeoutMs);
  for (let attempt = 0; !started.ok && isTransientHcFailure(started.kind) && attempt < HC_STARTUP_RETRY_DELAYS_MS.length; attempt++) {
    process.stderr.write(
      `[hc] server start failed (attempt ${attempt + 1}/${HC_STARTUP_RETRY_DELAYS_MS.length + 1}); retrying: ${started.message}\n`,
    );
    sleepHcStartupRetry(HC_STARTUP_RETRY_DELAYS_MS[attempt]!);
    started = runHcSync(core, ['--json', 'server', 'start'], undefined, timeoutMs);
  }
  if (!started.ok) throw new Error(`hc core 启动失败（${core.socket}）：${started.message}`);
  let status: { version?: unknown; pid?: unknown };
  try {
    status = JSON.parse(started.stdout);
  } catch {
    throw new Error(`hc core（${core.socket}）的 server start 输出无法解析`);
  }
  const { version, pid } = status;
  if (typeof version !== 'string' || typeof pid !== 'number') {
    throw new Error(`hc core（${core.socket}）的 server start 输出缺少 version/pid`);
  }
  const parsed = parseHcSemver(version);
  if (!parsed || compareHcVersion(parsed, HC_MIN_VERSION) < 0) {
    throw new Error(
      `hc core（${core.socket}，pid ${pid}）运行的版本 ${version} 低于 ${HC_MIN_VERSION.join('.')}；`
      + 'botmux 不会自动重启它（停掉它会结束其中的终端），请先停掉这个 core 再重试',
    );
  }
  return { version, pid };
}

/** One JSON-RPC call through `hc connect`. */
export function hcCallSync<T>(core: HcSyncCore, method: string, params: object, timeoutMs: number): HcSyncReply<T> {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const ran = runHcSync(core, ['connect'], `${request}\n`, timeoutMs);
  if (!ran.ok) return ran;
  const line = ran.stdout.split('\n').find(l => l.trim().length > 0);
  if (line === undefined) return { ok: false, kind: null, message: `hc ${method} 没有应答` };
  let reply: { result?: unknown; error?: { message?: unknown; data?: { kind?: unknown } } };
  try {
    reply = JSON.parse(line);
  } catch {
    return { ok: false, kind: null, message: `hc ${method} 的应答无法解析` };
  }
  if (reply.error) {
    const message = typeof reply.error.message === 'string' ? reply.error.message : 'refused';
    const kind = typeof reply.error.data?.kind === 'string' ? reply.error.data.kind : 'rpc';
    return { ok: false, kind, message: `hc ${method}：${message}` };
  }
  return { ok: true, value: reply.result as T };
}
