/**
 * triggered-message-store.ts — 记录「已经触发过任务」的入站消息（按 message_id
 * 持久化），专供 im.message.updated_v1（消息编辑）路径做幂等。
 *
 * 背景：用户发出一条**未 @ 机器人**的群消息后，可用飞书的「修改」功能补 @ 机器人，
 * 飞书会推送 im.message.updated_v1（message_id 与原消息相同）。botmux 据此把
 * 编辑后的消息当作一次延迟的首次 @ 来触发任务。但同一条消息可能被编辑多次，
 * 而任何正常触发过任务的消息（首次就 @、p2p、免@ 策略等）都不应因一次编辑再
 * 触发一遍——本 store 就是那道「这条消息触发过了吗」的持久记录。
 *
 * 与 seen-message-store（投递层去重，挡同 event/message 的 at-least-once 重推）
 * 正交：编辑事件是一个**新事件**（新 event_id），绝不能走 claimMessageOnce——
 * 原消息到达时该 message_id 已被 claim，编辑事件必被误吞。二者各自独立。
 *
 * 实现/落盘/TTL 与 seen-message-store 同构（每 larkAppId 一份文件、同步原子写、
 * 有界淘汰）；TTL 取 8h：覆盖一条消息「发出 → 事后才想起补 @」的现实窗口，
 * 与 seen 去重梯度一致。重启后仍能挡住重复触发。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** 8h —— 与 seen-message-store 的重推覆盖窗口对齐。 */
const TTL_MS = 8 * 60 * 60_000;
/** 有界：超限按最旧（Map 迭代序即插入序）淘汰，防文件无界增长。 */
const MAX_ENTRIES = 5000;

interface AppCache {
  /** message_id → 过期时间戳（ms）。 */
  map: Map<string, number>;
  loaded: boolean;
}
const caches = new Map<string, AppCache>();

function fileFor(larkAppId: string): string {
  return join(config.session.dataDir, 'dedup', `triggered-messages-${larkAppId}.json`);
}

/** 懒加载：进程内首次用到某 app 时从盘载入（已过期的条目载入时即丢弃）。 */
function load(larkAppId: string): AppCache {
  const existing = caches.get(larkAppId);
  if (existing?.loaded) return existing;

  const map = new Map<string, number>();
  const file = fileFor(larkAppId);
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      // 兜底：只接受 `{ key: number }` 形态；数组/损坏内容当空表，绝不抛。
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const now = Date.now();
        for (const [k, exp] of Object.entries(parsed)) {
          if (typeof exp === 'number' && exp > now) map.set(k, exp);
        }
      }
    }
  } catch (err) {
    logger.warn(`[triggered-message-store] load failed (${file}): ${err}`);
  }

  const cache: AppCache = { map, loaded: true };
  caches.set(larkAppId, cache);
  return cache;
}

function persist(larkAppId: string, map: Map<string, number>): void {
  const file = fileFor(larkAppId);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of map) obj[k] = v;
    atomicWriteFileSync(file, JSON.stringify(obj));
  } catch (err) {
    // 落盘失败不阻断消息触发：退化为「本进程内仍幂等，重启后这条可能重复触发
    // 一次」，绝不因写盘失败把用户补 @ 的任务吞掉。
    logger.warn(`[triggered-message-store] persist failed (${file}): ${err}`);
  }
}

/** 删过期 + 超限淘汰最旧，保持 map / 文件有界。 */
function pruneAndCap(map: Map<string, number>, now: number): void {
  for (const [k, exp] of map) if (exp <= now) map.delete(k);
  if (map.size > MAX_ENTRIES) {
    let drop = map.size - MAX_ENTRIES;
    for (const k of map.keys()) {
      map.delete(k);
      if (--drop <= 0) break;
    }
  }
}

/**
 * 这条消息是否已经触发过任务（且记录未过期）。
 * 空 `messageId` 无法判定 → 返回 `false`（绝不因缺 id 而误吞真实的补 @ 触发）。
 */
export function hasTriggeredMessage(larkAppId: string, messageId: string, now = Date.now()): boolean {
  if (!messageId) return false;
  const cache = load(larkAppId);
  const exp = cache.map.get(messageId);
  return typeof exp === 'number' && exp > now;
}

/**
 * 标记一条消息「已触发任务」。幂等：重复标记只刷新 TTL，不重复落盘内容。
 * 在消息**已确定进入任务派发**之后调用（而非入站即标记），这样被权限闸/@ 闸
 * 丢弃的消息不会被记成「已触发」——用户之后补 @ 仍能正常触发。
 */
export function markMessageTriggered(larkAppId: string, messageId: string, now = Date.now()): void {
  if (!messageId) return;
  const cache = load(larkAppId);
  pruneAndCap(cache.map, now);
  cache.map.set(messageId, now + TTL_MS);
  persist(larkAppId, cache.map);
}

/**
 * Test-only：清空进程内缓存（**不删盘**），用于模拟「daemon 重启」后从盘重新载入。
 */
export function _resetCacheForTest(): void {
  caches.clear();
}
