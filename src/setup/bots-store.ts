/**
 * `bots.json` 原子读写. Codex review 边界 #2 + #3:
 * - tmp 文件必须和 `bots.json` 同目录, 保证 `renameSync` 在同 fs 下原子覆盖
 * - 任意写入失败不留半截 JSON (renameSync 之前一切失败都不影响旧文件)
 * - 文件权限 0o600 (只有用户自己能读), secret 不外泄给同机器人其它用户
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';

export function writeBotsJsonAtomic(botsJsonPath: string, bots: any[]): void {
  // 注意: tmp 必须在同一目录下 (同 fs), 否则 rename 可能跨文件系统失败.
  const tmp = botsJsonPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(bots, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, botsJsonPath);
}

export function readBotsJsonOrEmpty(botsJsonPath: string): any[] {
  if (!existsSync(botsJsonPath)) return [];
  try {
    return JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
  } catch {
    return [];
  }
}
