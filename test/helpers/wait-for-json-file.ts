import { existsSync, readFileSync } from 'node:fs';

const POLL_INTERVAL_MS = 20;

export interface WaitForJsonOptions {
  timeoutMs?: number;
  /**
   * 每轮轮询前调用；返回 true 时停止等待并按当前状态报错。用于在生产方
   * （通常是 spawn 出来的子进程）已退出时提前失败，而不是空转到超时。
   */
  shouldStop?: () => boolean;
}

/**
 * 等到 `path` 上的文件能被完整解析成 JSON 再返回解析结果。
 *
 * `existsSync` 为真不代表内容已经写完：`writeFileSync` 在 create/truncate
 * 之后、内容 flush 完成之前文件就已存在，此刻 `readFileSync` 会读到空或半截
 * 内容，`JSON.parse` 抛 `Unexpected EOF`。高负载 CI 上这个窗口被放大，表现为
 * 偶发 flake（#3692：worker-reply-delivery-env 只等 existsSync 就读，撞上空文件）。
 *
 * 因此「文件不存在」和「文件存在但暂时解析不了」都在 deadline 内重试，直到
 * 解析成功；超时或 `shouldStop` 中止时抛出带最后一次错误的明确异常。
 */
export async function waitForJsonFile<T = unknown>(
  path: string,
  opts: WaitForJsonOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (opts.shouldStop?.()) break;
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch (err) {
        // 文件已创建但写入未完成（空 / 截断），下一轮重读。
        lastErr = err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const reason = lastErr
    ? `最后一次解析错误：${String((lastErr as Error)?.message ?? lastErr)}`
    : '文件始终不存在';
  throw new Error(`waitForJsonFile 在 ${timeoutMs}ms 内未能从 ${path} 读到完整 JSON（${reason}）`);
}
