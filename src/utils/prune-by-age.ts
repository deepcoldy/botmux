/**
 * 目录级 TTL 回收：清理「每 key 一个文件、只写不删」类存储中的过期文件。
 *
 * 多个诊断/快照/账本目录（mcp-gateway 诊断、pid 标记、tmp 工作目录……）历史上
 * 只创建不删除，长跑下随会话/崩溃次数线性增长。统一用本工具做有界回收：
 *  - 按 mtime 判定年龄，超过 maxAgeMs 删除（不依赖文件名里的时间戳）；
 *  - 可同时给出 retainMin：即使全部过期也至少保留最新的 N 个，避免误删正在
 *    被读取的当前文件；
 *  - 任何单个文件的删除失败都跳过，不影响其余文件；
 *  - 不存在的目录视为空，直接返回 0。
 *
 * 调用时机：新一次写入时顺手 prune（低频、摊薄成本），或 daemon 启动 sweep。
 */
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface PruneByAgeOptions {
  dir: string;
  maxAgeMs: number;
  /** 至少保留最新的几个文件（按 mtime 倒序），默认 1。 */
  retainMin?: number;
  /** 只处理此后缀（含点，如 '.json'）；默认处理全部文件。 */
  suffix?: string;
  now?: () => number;
}

export function pruneFilesByAge(options: PruneByAgeOptions): number {
  const { dir, maxAgeMs, suffix, now = () => Date.now() } = options;
  const retainMin = Math.max(0, options.retainMin ?? 1);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && (!suffix || e.name.endsWith(suffix)))
      .map(e => e.name);
  } catch {
    return 0;
  }
  if (names.length <= retainMin) return 0;

  const aged = names
    .map(name => ({ name, mtime: statSafe(join(dir, name)) }))
    .filter((x): x is { name: string; mtime: number } => x.mtime !== undefined)
    .sort((a, b) => b.mtime - a.mtime); // 新→旧

  let removed = 0;
  const cutoff = now() - maxAgeMs;
  // 前 retainMin 个无论多旧都保留；其余超过年龄的删除。
  for (let i = retainMin; i < aged.length; i += 1) {
    if (aged[i].mtime >= cutoff) continue;
    try {
      rmSync(join(dir, aged[i].name), { force: true });
      removed += 1;
    } catch {
      /* 单个文件删除失败不阻断其余回收 */
    }
  }
  return removed;
}

function statSafe(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
