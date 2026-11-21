import { readFileSync } from 'node:fs';

const POLL_INTERVAL_MS = 20;

export interface WaitForJsonOptions {
  timeoutMs?: number;
  /**
   * 每轮「尝试读取之后」调用；返回 true 时停止轮询并按当前状态报错。用于在生产方
   * （通常是 spawn 出来的子进程）已退出时提前失败，而不是空转到超时。
   *
   * 调用时机在 read/parse 之后：即使生产方已退出，只要文件里已经是完整 JSON，
   * 仍会先成功返回，不会把已落盘的结果丢掉。每轮最多调用一次，结果存入局部
   * 变量供失败诊断复用，不会重复回调。
   */
  shouldStop?: () => boolean;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; err: unknown };

/** 这类系统错误意味着目标永远不会变成合法 JSON，重试无意义，立即抛出。 */
function isFatalReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EISDIR' || code === 'EACCES' || code === 'ENOTDIR';
}

/** 文件还没创建（readFileSync 抛 ENOENT），可重试；其余读取错误说明文件已出现。 */
function isNotCreatedError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function tryReadJson<T>(path: string): ReadResult<T> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch (err) {
    return { ok: false, err };
  }
}

function describeFailure(path: string, timeoutMs: number, sawFile: boolean, stopped: boolean, lastErr: unknown): Error {
  const prefix = stopped ? '生产方已停止等待' : `等待 ${timeoutMs}ms 超时`;
  const detail = !sawFile
    ? '文件始终未创建'
    : `文件已出现但内容始终无法完整解析（最后一次错误：${String((lastErr as Error)?.message ?? lastErr)}）`;
  return new Error(`waitForJsonFile ${prefix}，未能从 ${path} 读到完整 JSON：${detail}`);
}

/**
 * 等到 `path` 上的文件能被完整解析成 JSON 再返回解析结果。
 *
 * 不做 `existsSync` 预检——直接 read/parse：`existsSync` 为真不代表内容写完
 * （writeFileSync 在 create/truncate 后、flush 完成前文件已存在，立刻读会拿到
 * 空/半截内容，JSON.parse 抛 Unexpected EOF，高负载 CI 上被放大成 flake，#3692）；
 * 而且 existsSync 对 ENOTDIR 这类永久错误只返回 false，会让立即失败退化成空等超时。
 *
 * 每轮：read/parse（成功即返回，fatal 系统错误立即抛）→ 记录停止状态（shouldStop
 * 只调一次）→ sleep 轮询。循环因 deadline 退出后**再读一次**，兜住 writer 在最后
 * 一轮 sleep 期间刚写完的边界，避免「抛错时文件其实已完整」的漏读。
 */
export async function waitForJsonFile<T = unknown>(
  path: string,
  opts: WaitForJsonOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let sawFile = false;
  let stopped = false;

  while (Date.now() < deadline) {
    const attempt = tryReadJson<T>(path);
    if (attempt.ok) return attempt.value;
    lastErr = attempt.err;
    if (isFatalReadError(attempt.err)) throw attempt.err; // EISDIR/EACCES/ENOTDIR：重试也不会变好
    if (!isNotCreatedError(attempt.err)) sawFile = true; // 非 ENOENT 说明文件已出现（空/截断等）

    if (opts.shouldStop?.()) { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // deadline 到期 / 提前停止后补读一次：writer 可能在最后一轮等待期间刚写完。
  const finalAttempt = tryReadJson<T>(path);
  if (finalAttempt.ok) return finalAttempt.value;
  if (isFatalReadError(finalAttempt.err)) throw finalAttempt.err;
  lastErr = finalAttempt.err;
  if (!isNotCreatedError(finalAttempt.err)) sawFile = true;

  throw describeFailure(path, timeoutMs, sawFile, stopped, lastErr);
}
