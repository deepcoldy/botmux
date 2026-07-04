/**
 * seen-message-store.ts — 跨重启的入站消息去重（按 message_id 持久化）。
 *
 * 为什么需要它：飞书长连接 (WS) 是 at-least-once，且每个事件只回**一帧** ACK——
 * 一旦 ACK 没及时回达（主机内存压力把事件循环卡住超过 ~3s 预算 / 网络抖动把那帧
 * ACK 丢了），飞书就按 15s / 5min / 1h / 6h（最多 4 次）重推同一条消息事件。
 *
 * event-dispatcher 原有的内存去重 (`eventClaims`, key=event_id, TTL 2h) 有两个缺口：
 *   1. **纯内存** —— daemon 重启 / 崩溃循环 / 被 OOM 杀掉一次，去重表就清空，之后任何
 *      重推都当新消息重新触发；
 *   2. **2h TTL** —— 盖不住 6h 那一档重推。
 * 此外它 key 用 `event_id ?? message_id`：`event_id` 标识「一次投递事件」，跨连接重投
 * 可能变；`message_id` 标识「消息」本身，对同一条逻辑消息恒定不变。要做「同一条消息
 * 只处理一次」，`message_id` 才是正确且充分的幂等键。
 *
 * 本 store 因此按 `message_id` **落盘**去重，TTL 8h 覆盖整条重推梯度 + 余量，重启后
 * 仍能挡住旧消息重放。每个 larkAppId 一份文件（key 已隐含 app 维度，且多 bot 各自
 * 独立、无跨进程写竞争）。
 *
 * 同步落盘的理由：`claimMessageOnce` 必须**全同步**返回（event-dispatcher 在 ACK 前的
 * 同步段里调用它，且依赖「claim + setImmediate 之间不 await」来保住同 anchor 消息的
 * 到达序）。落盘走 `atomicWriteFileSync`（tmp + rename，崩溃安全、无半截读），只在
 * 见到**新** message_id 时写一次快照；重复命中直接返回、不写盘。聊天桥接是人类节奏，
 * 每条新消息一次小快照写（个位数 ms）远在 3s ACK 预算之内。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** 8h —— 覆盖飞书 15s/5min/1h/6h 的全部重推档，外加余量。 */
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
  return join(config.session.dataDir, 'dedup', `seen-messages-${larkAppId}.json`);
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
    logger.warn(`[seen-message-store] load failed (${file}): ${err}`);
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
    // 落盘失败不阻断处理：退化为「本进程内仍去重，但重启后这条不再被挡」，
    // 与未持久化前的旧行为一致，绝不因写盘失败丢消息。
    logger.warn(`[seen-message-store] persist failed (${file}): ${err}`);
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
 * 首次见到此 `messageId` → 记录 + 落盘，返回 `true`（调用方应处理这条消息）。
 * 8h 内重复命中（飞书重推 / at-least-once 重复）→ 返回 `false`（重投，应丢弃）。
 * 空 `messageId` 无法去重 → 永远 `true`（绝不因缺 id 而误吞真实消息）。
 */
export function claimMessageOnce(larkAppId: string, messageId: string, now = Date.now()): boolean {
  if (!messageId) return true;
  const cache = load(larkAppId);
  const exp = cache.map.get(messageId);
  if (exp && exp > now) return false; // 命中未过期记录 → 重投
  pruneAndCap(cache.map, now);
  cache.map.set(messageId, now + TTL_MS);
  persist(larkAppId, cache.map);
  return true;
}

/**
 * Test-only：清空进程内缓存（**不删盘**），用于模拟「daemon 重启」后从盘重新载入，
 * 验证去重跨重启仍生效。
 */
export function _resetCacheForTest(): void {
  caches.clear();
}
