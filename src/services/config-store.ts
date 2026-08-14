/**
 * 共享的 bots.json 读改写原语：跨进程文件锁 + 原子 rename。
 * oncall-store 与 grant-store 共用，保证对同一 bots.json 的并发写不丢更新。
 */
import { promises as fsp } from 'node:fs';
import { getLoadedConfigPath } from '../bot-registry.js';
import { withFileLock } from '../utils/file-lock.js';
import { stampConfigGenerations } from './config-gen.js';

export async function readRawConfig(path: string): Promise<any[]> {
  const raw = JSON.parse(await fsp.readFile(path, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`Config file is not a JSON array: ${path}`);
  return raw;
}

/**
 * Single write choke point for bots.json.
 *
 * Stamps the monotonic per-bot generation here rather than at each call site, so
 * no writer can bypass it. The previous rows are read from disk (every caller is
 * already inside the file lock), which is what makes the counter impossible to
 * roll back even if a caller round-tripped through a shape that dropped it.
 */
export async function writeRawConfigAtomic(path: string, raw: any[]): Promise<void> {
  let prevRows: any[] = [];
  try {
    prevRows = await readRawConfig(path);
  } catch {
    // No readable predecessor (first write, or a corrupt file being replaced):
    // stampConfigGenerations then treats every row as changed, so generations
    // still only move forward.
  }
  stampConfigGenerations(prevRows, raw);
  const tmp = path + '.tmp.' + process.pid;
  // bots.json 含 appSecret —— 临时文件即以 0o600 写入，rename 后保持私有权限。
  await fsp.writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tmp, path);
}

export function findEntryIndex(raw: any[], larkAppId: string): number {
  return raw.findIndex((e: any) => e?.larkAppId === larkAppId);
}

export function requireConfigPath(): string {
  const p = getLoadedConfigPath();
  if (!p) throw new Error('Bot config path unknown — cannot persist config changes');
  return p;
}

/**
 * 在跨进程锁内对某个 bot 条目做 read-modify-write。`mutate` 拿到最新磁盘快照决定
 * 写什么；返回 `{ write:false }` 表示不写。沿用 oncall-store 原有语义。
 */
export async function rmwBotEntry<T>(
  larkAppId: string,
  mutate: (entry: any, raw: any[]) => { write: boolean; result: T } | T,
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  const path = requireConfigPath();
  return withFileLock(path, async () => {
    const raw = await readRawConfig(path);
    const idx = findEntryIndex(raw, larkAppId);
    if (idx < 0) return { ok: false, reason: 'bot_not_in_config' };
    const entry = raw[idx];
    const out = mutate(entry, raw);
    if (out && typeof out === 'object' && 'write' in (out as any)) {
      const wrap = out as { write: boolean; result: T };
      if (wrap.write) await writeRawConfigAtomic(path, raw);
      return { ok: true, result: wrap.result };
    }
    await writeRawConfigAtomic(path, raw);
    return { ok: true, result: out as T };
  });
}
