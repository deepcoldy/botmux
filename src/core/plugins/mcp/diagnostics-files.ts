/**
 * mcp-gateway 诊断快照目录的读取侧：列出最新的若干个快照文件名。
 *
 * 写侧（gateway.ts）在每次落盘时按 TTL prune 这个目录，所以「列目录」和
 * 「逐个 stat 取 mtime」之间文件可能正好被删掉。stat 失败的条目必须跳过：
 * 排序比较器里抛 ENOENT 会让整个插件页的诊断信息全部空白，而代价本来只是
 * 少展示一个并发消失的文件。
 */
import { readdirSync, statSync, type Dirent, type Stats } from 'node:fs';
import { join } from 'node:path';

export interface DiagnosticsDirReader {
  readdirSync(path: string, opts: { withFileTypes: true }): Dirent[];
  statSync(path: string): Stats;
}

const defaultReader: DiagnosticsDirReader = { readdirSync, statSync };

export function listLatestDiagnosticFiles(
  dir: string,
  limit: number,
  suffix: string = '.json',
  fs: DiagnosticsDirReader = defaultReader,
): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
      .map(entry => entry.name);
  } catch {
    return []; // 目录不存在/不可读：与旧实现一致，返回空集合
  }

  const dated: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    try {
      dated.push({ name, mtime: fs.statSync(join(dir, name)).mtimeMs });
    } catch {
      // 文件在 readdir 与 stat 之间被 TTL prune 删掉：跳过这一条即可，
      // 不能让整页诊断为空。
    }
  }
  return dated
    .sort((a, b) => b.mtime - a.mtime) // 新→旧
    .slice(0, Math.max(0, limit))
    .map(entry => entry.name);
}
