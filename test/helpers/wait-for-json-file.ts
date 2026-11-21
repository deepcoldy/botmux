import { existsSync, readFileSync } from 'node:fs';

const POLL_INTERVAL_MS = 20;

export interface WaitForJsonOptions {
  timeoutMs?: number;
  /**
   * 每轮「尝试读取之后」调用；返回 true 时停止等待并按当前状态报错。用于在生产方
   * （通常是 spawn 出来的子进程）已退出时提前失败，而不是空转到超时。
   *
   * 注意调用时机在 read/parse 之后：即使生产方已退出，只要文件里已经是完整 JSON，
   * 仍会先成功返回，不会把已落盘的结果丢掉。
   */
  shouldStop?: () => boolean;
}

interface FailureContext {
  /** 是否至少见到文件出现过（区分「始终没创建」与「出现了但一直不完整」）。 */
  sawFile: boolean;
  /** 最近一次读取/解析错误，用于诊断。 */
  lastErr: unknown;
}

/** readFileSync 的这类系统错误意味着目标永远不会变成合法 JSON，重试无意义，立即抛出。 */
function isFatalReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EISDIR' || code === 'EACCES' || code === 'ENOTDIR';
}

function describeFailure(path: string, timeoutMs: number, ctx: FailureContext, stopped: boolean): Error {
  const prefix = stopped ? '生产方已停止等待' : `等待 ${timeoutMs}ms 超时`;
  const detail = !ctx.sawFile
    ? '文件始终未创建'
    : ctx.lastErr
      ? `文件已出现但内容始终无法完整解析（最后一次错误：${String((ctx.lastErr as Error)?.message ?? ctx.lastErr)}）`
      : '文件已出现但内容无法解析';
  return new Error(`waitForJsonFile ${prefix}，未能从 ${path} 读到完整 JSON：${detail}`);
}

/**
 * 等到 `path` 上的文件能被完整解析成 JSON 再返回解析结果。
 *
 * `existsSync` 为真不代表内容已经写完：`writeFileSync` 在 create/truncate
 * 之后、内容 flush 完成之前文件就已存在，此刻 `readFileSync` 会读到空或半截
 * 内容，`JSON.parse` 抛 `Unexpected EOF`。高负载 CI 上这个窗口被放大，表现为
 * 偶发 flake（#3692：worker-reply-delivery-env 只等 existsSync 就读，撞上空文件）。
 *
 * 每轮顺序固定为「先读 → 读不到合法 JSON 才查 shouldStop → 再 sleep」，因此：
 *   - 完整文件即使在生产方退出后才被轮询到，也能成功返回；
 *   - 文件不存在、或存在但暂时解析不了（空/截断）都在 deadline 内重试；
 *   - EISDIR/EACCES/ENOTDIR 这类永久错误立即抛出，不空转到超时；
 *   - 超时或 shouldStop 中止时，按「文件从未出现 / 出现了但不完整」分别给诊断。
 */
export async function waitForJsonFile<T = unknown>(
  path: string,
  opts: WaitForJsonOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const ctx: FailureContext = { sawFile: false, lastErr: undefined };
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      ctx.sawFile = true;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch (err) {
        if (isFatalReadError(err)) throw err; // 永久错误，重试也不会变好
        ctx.lastErr = err; // 空 / 截断（SyntaxError）或瞬态读错误，下一轮重读
      }
    }
    // 本轮没拿到合法 JSON：生产方已退出就提前停止，否则继续等到 deadline。
    if (opts.shouldStop?.()) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw describeFailure(path, timeoutMs, ctx, opts.shouldStop?.() === true);
}
