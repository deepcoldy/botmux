/**
 * Readable answers for fleet commands (`botmux status / logs / start / stop /
 * restart / start-bot / stop-bot`) run from inside a botmux session sandbox.
 *
 * Every Linux sandbox flavour (oncall/scratch file sandbox, credential-only
 * bwrap) runs under `bwrap --unshare-pid` with a fresh /proc: the supervisor
 * and daemons are invisible, so `status` used to report "supervisor 未在运行" /
 * `dead?` and users or agents went on to "fix" a healthy fleet by restarting
 * it. `linuxIsolationDetected()` is the signal for that (an inherited seccomp
 * marker that survives `env -i`). `BOTMUX_SEND_RELAY` marks every sandbox
 * flavour including macOS, where processes stay visible but `~/.botmux` may
 * be sealed. `BOTMUX_SANDBOX` is NOT a signal: it is the host-side operator
 * override that also sits in the daemon's own environment.
 */
import { linuxIsolationDetected } from '../core/linux-isolation.js';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SandboxContext {
  /** Host processes are invisible (Linux PID namespace). */
  hostProcessesHidden: boolean;
  /** Running inside any botmux session sandbox. */
  inSandbox: boolean;
}

export function detectSandboxContext(
  env: NodeJS.ProcessEnv = process.env,
  detectLinuxIsolation: () => boolean = linuxIsolationDetected,
): SandboxContext {
  const hostProcessesHidden = detectLinuxIsolation();
  return {
    hostProcessesHidden,
    inSandbox: hostProcessesHidden || !!env.BOTMUX_SEND_RELAY?.trim(),
  };
}

export type FleetCommand = 'status' | 'logs' | 'start' | 'stop' | 'restart' | 'start-bot' | 'stop-bot';

/** Refusal shown instead of running a fleet command whose answer (status) or
 *  effect (start/stop/restart) would be wrong because host processes are not
 *  visible from here. */
export function hostOnlyCommandMessage(command: FleetCommand): string {
  return `ℹ️  当前在 botmux 沙盒内，看不到宿主上的 supervisor / daemon 进程，`
    + `\`botmux ${command}\` 在这里${command === 'status' ? '的结果不可信' : '无法正确执行'}。`
    + `\n   请在宿主终端执行 \`botmux ${command}\`（fleet 本身多半正常运行，不要据此重启）。`;
}

/** Appended to `status` output where processes are visible but host state
 *  files may not be readable (macOS sandbox). */
export const SANDBOX_STATUS_NOTE = 'ℹ️  当前在 botmux 沙盒内，可能读不到宿主的 fleet 状态；'
  + '若上面显示未运行，请在宿主终端执行 `botmux status` 确认后再处理。';

/** `logs` found nothing: inside the sandbox that means the host log dir is
 *  not mounted, not that the daemon never ran. */
export function sandboxLogsMissingMessage(logDir: string): string {
  return `ℹ️  当前在 botmux 沙盒内，读不到宿主日志目录（${logDir}）。请在宿主终端执行 \`botmux logs\`。`;
}

const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

/** Walk UP to the first ancestor that exists; true when it is not writable.
 *  Node's recursive mkdir reports ENOENT (not EROFS) when creating the first
 *  missing component on a read-only bind mount, while Bun reports EROFS — the
 *  nearest-ancestor probe is runtime-independent (same shape as the bytedcli
 *  login preflight's shell check). `isWritable` is injectable so the sealed
 *  case is testable without a read-only bind mount (a chmod 0555 dir does not
 *  deny root). */
export interface AncestorProbe {
  exists?: (path: string) => boolean;
  writable?: (dir: string) => boolean;
}

export function nearestExistingAncestorNotWritable(
  path: string,
  probe: AncestorProbe = {},
): boolean {
  const exists = probe.exists ?? existsSync;
  const isWritable = probe.writable ?? ((dir: string) => {
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
  let cur = dirname(path);
  while (true) {
    if (exists(cur)) return !isWritable(cur);
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** True when `candidate` is `dir` or a path below it (lexical; both sides are
 *  absolute error/config paths). Named distinctly from
 *  workflows/ops-projection's isPathInsideDir(parent, child), which resolves
 *  `..` segments and takes its arguments in the opposite order. */
export function isPathWithinOrEqual(candidate: string, dir: string): boolean {
  if (candidate === dir) return true;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return candidate.startsWith(prefix);
}

/**
 * A fleet mutation needs to write `~/.botmux` (config dir, watchdog marker,
 * fleet mutation lock). A read-only or masked home surfaces as a raw
 * `EROFS: read-only file system, open '…/pm2-fleet-mutation.lock'`; turn that
 * into what to do. Returns undefined for any other error (rethrow it as is):
 * an errno WITHOUT a path may still be the config-dir write, but a named path
 * outside the config dir is some other failure (e.g. EACCES spawning a
 * dependency binary) that must not be mislabelled "needs to write ~/.botmux".
 */
export function explainFleetWriteError(
  error: unknown,
  command: FleetCommand,
  context: SandboxContext,
  configDir: string,
  probe?: AncestorProbe,
): Error | undefined {
  const errnoError = error as NodeJS.ErrnoException | undefined;
  const code = errnoError?.code;
  const path = errnoError?.path;
  if (path && !isPathWithinOrEqual(path, configDir)) return undefined;
  const readOnlyErrno = code !== undefined && READ_ONLY_CODES.has(code);
  // Missing-dir mkdir on a sealed ancestor (Node reports ENOENT here).
  const sealedAncestor = code === 'ENOENT'
    && path !== undefined
    && nearestExistingAncestorNotWritable(path, probe);
  if (!readOnlyErrno && !sealedAncestor) return undefined;
  const reasonLabel = readOnlyErrno ? code : `${code}：最近的已存在目录只读`;
  const raw = error instanceof Error ? error.message : String(error);
  const where = context.inSandbox
    ? '当前在 botmux 沙盒内，宿主的 ~/.botmux 在这里不可写，请在宿主终端执行。'
    : '请确认用安装 botmux 的同一个用户执行，且 ~/.botmux 所在磁盘可写。';
  return new Error(
    `botmux ${command} 需要写 ~/.botmux${path ? `（${path}）` : ''}，但这里没有写权限（${reasonLabel}）。${where}`
    + `\n   原始错误：${raw}`,
  );
}
