/**
 * 群秘书「手动盯」登记：秘书在会话里用 `botmux secretary watch <话题根>` 登记要定期回访的话题，
 * daemon 的秘书运行时按间隔生成 check_in 事件。CLI 与 daemon 是不同进程，所以落盘共享：
 * `${dataDir}/group-secretary-watches-${appId}.json`，tmp + rename 原子写，每次读都读盘（量很小）。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { SecretaryManualWatch } from './group-secretary-engine.js';

export const MIN_WATCH_INTERVAL_MS = 2 * 60_000;
export const MAX_WATCHES_PER_APP = 50;
export const DEFAULT_WATCH_TTL_MS = 24 * 3_600_000;

function filePath(larkAppId: string, dataDir = config.session.dataDir): string {
  return join(dataDir, `group-secretary-watches-${larkAppId}.json`);
}

export function listSecretaryWatches(larkAppId: string, dataDir?: string): SecretaryManualWatch[] {
  const path = filePath(larkAppId, dataDir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const list = Array.isArray(raw?.watches) ? raw.watches : [];
    return list.filter((w: any) => typeof w?.chatId === 'string' && w.chatId.startsWith('oc_')
      && typeof w?.threadRoot === 'string' && w.threadRoot.startsWith('om_')
      && Number.isFinite(w?.everyMs) && w.everyMs >= MIN_WATCH_INTERVAL_MS
      && Number.isFinite(w?.createdAt))
      .map((w: any) => ({
        chatId: w.chatId, threadRoot: w.threadRoot, everyMs: w.everyMs, createdAt: w.createdAt,
        // 旧登记没有到期时间：按登记后 24 小时到期。
        expiresAt: Number.isFinite(w.expiresAt) ? w.expiresAt : w.createdAt + DEFAULT_WATCH_TTL_MS,
        ...(typeof w.note === 'string' && w.note ? { note: w.note.slice(0, 500) } : {}),
      }))
      .filter((w: SecretaryManualWatch) => w.expiresAt! > Date.now());
  } catch {
    return [];
  }
}

function save(larkAppId: string, watches: SecretaryManualWatch[], dataDir?: string): void {
  const path = filePath(larkAppId, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ version: 1, watches }, null, 2));
}

/** 同一话题重复登记 = 更新间隔与备注（不重复计）。 */
export function upsertSecretaryWatch(larkAppId: string, watch: SecretaryManualWatch, dataDir?: string): SecretaryManualWatch[] {
  if (watch.everyMs < MIN_WATCH_INTERVAL_MS) throw new Error(`间隔不能小于 ${MIN_WATCH_INTERVAL_MS / 60_000} 分钟`);
  const rest = listSecretaryWatches(larkAppId, dataDir)
    .filter(w => !(w.chatId === watch.chatId && w.threadRoot === watch.threadRoot));
  if (rest.length >= MAX_WATCHES_PER_APP) throw new Error(`最多同时盯 ${MAX_WATCHES_PER_APP} 个话题`);
  const next = [...rest, watch];
  save(larkAppId, next, dataDir);
  return next;
}

export function removeSecretaryWatch(larkAppId: string, chatId: string, threadRoot: string, dataDir?: string): boolean {
  const all = listSecretaryWatches(larkAppId, dataDir);
  const next = all.filter(w => !(w.chatId === chatId && w.threadRoot === threadRoot));
  if (next.length === all.length) return false;
  save(larkAppId, next, dataDir);
  return true;
}

/** 解析 `10m` / `1h` / `90s` / 纯数字（分钟）。 */
export function parseWatchInterval(raw: string | undefined, fallbackMs = 10 * 60_000): number {
  if (!raw) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(raw.trim());
  if (!m) throw new Error(`无法解析间隔：${raw}（例：10m、1h）`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.round(n * (unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : 60_000));
}
