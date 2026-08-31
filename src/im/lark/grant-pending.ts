/**
 * 授权申请的内存状态表（per bot:chat:target）。两个职责合一：
 *  - nonce 防旧卡重放：每次发卡生成 nonce，卡片按钮带它；处置时校验仍匹配。
 *  - 节流：pending 期间 / denied 冷却期间，不重复弹卡。
 * 纯内存，daemon 重启清空（重启后旧卡 nonce 自然失效，符合预期）。
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';

const DENY_COOLDOWN_MS = 10 * 60 * 1000;
/** pending 卡超过此窗口仍未处置即视作废弃（owner 一直没点），可回收。
 *  远大于一次正常授权交互所需时间，正常流程不会被误删。 */
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
/** 回收节流：每个表已无用条目（denied 冷却已过 / pending 已废弃）的清扫
 *  最多每分钟跑一次，避免在热路径上对全表做 O(n) 扫描。 */
const PRUNE_INTERVAL_MS = 60 * 1000;

type Entry = {
  state: 'pending' | 'denied';
  nonce?: string;
  ts: number;
  quota?: number;
  durationMs?: number;
  messageData?: any;
};
const table = new Map<string, Entry>();
let lastPrunedAt = 0;

const key = (a: string, c: string, t: string) => `${a}:${c}:${t}`;

/** 回收已无效条目，避免 table 随「不同未授权用户 × 群」无限增长。
 *  - denied：冷却已过 → 不再节流，纯属垃圾，删除（允许将来重新申请）。
 *  - pending：超过 STALE_PENDING_MS 仍未处置 → owner 已放弃，删除。
 *  按时间节流，最多每 PRUNE_INTERVAL_MS 全表扫一次（denied 的即时回收另由
 *  isThrottled 顺手做，这里兜住「再也没人 check」的残留条目）。 */
function pruneStale(now: number): void {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  for (const [k, e] of table) {
    if (e.state === 'denied' && now - e.ts >= DENY_COOLDOWN_MS) table.delete(k);
    else if (e.state === 'pending' && now - e.ts >= STALE_PENDING_MS) table.delete(k);
  }
}

/** 开一张待处置的卡，返回 nonce。`quota` 为可选的消息额度（已解析），落授权时透传给 grant-store。
 *  `messageData` 为触发本次授权申请的原始飞书消息事件，授权成功后可重放，让用户无需再 @ 一遍。 */
export function openPending(
  larkAppId: string,
  chatId: string,
  target: string,
  quota: number | undefined = DEFAULT_GRANT_QUOTA,
  messageData?: any,
  durationMs: number | undefined = DEFAULT_GRANT_DURATION_MS,
): string {
  return openPendingMulti(larkAppId, chatId, [target], quota, messageData, durationMs);
}

/** owner 一次 /grant 多个目标：同一张卡 → 多个 target 共用同一 nonce，
 *  owner 点一次范围即对全部目标生效。校验时每个 target 独立 checkNonce。
 *  `quota`（若有）对每个 target 各自生效（每人 N 条额度）。
 *  `messageData` 为触发本次授权申请的原始飞书消息事件，授权成功后可重放。 */
export function openPendingMulti(
  larkAppId: string,
  chatId: string,
  targets: string[],
  quota: number | undefined = DEFAULT_GRANT_QUOTA,
  messageData?: any,
  durationMs: number | undefined = DEFAULT_GRANT_DURATION_MS,
): string {
  const nonce = randomUUID();
  const ts = Date.now();
  pruneStale(ts);
  for (const target of targets) {
    table.set(key(larkAppId, chatId, target), { state: 'pending', nonce, ts, quota, durationMs, messageData });
  }
  return nonce;
}

/** 回读 pending 上挂的限制（owner 点授权按钮时用）。 */
export function getPendingGrantLimits(
  larkAppId: string,
  chatId: string,
  target: string,
): { quota?: number; durationMs?: number } | undefined {
  const e = table.get(key(larkAppId, chatId, target));
  return e && e.state === 'pending' ? { quota: e.quota, durationMs: e.durationMs } : undefined;
}

/** 同一张多目标卡共用一组限制；nonce 不匹配时拒绝暂存。 */
export function updatePendingGrantLimits(
  larkAppId: string,
  chatId: string,
  targets: string[],
  nonce: string,
  patch: { quota?: number | null; durationMs?: number | null },
): boolean {
  const entries = targets.map(target => table.get(key(larkAppId, chatId, target)));
  if (entries.some(e => !e || e.state !== 'pending' || e.nonce !== nonce)) return false;
  for (const e of entries as Entry[]) {
    if ('quota' in patch) {
      if (patch.quota === null || patch.quota === undefined) delete e.quota;
      else e.quota = patch.quota;
    }
    if ('durationMs' in patch) {
      if (patch.durationMs === null || patch.durationMs === undefined) delete e.durationMs;
      else e.durationMs = patch.durationMs;
    }
  }
  return true;
}

/** 回读 pending 上挂的原始消息事件（授权成功后重放，让用户无需再 @ 一遍）。无 / 非 pending → undefined。 */
export function getPendingMessage(larkAppId: string, chatId: string, target: string): any {
  const e = table.get(key(larkAppId, chatId, target));
  return e && e.state === 'pending' ? e.messageData : undefined;
}

/** 卡片处置前校验：必须仍 pending 且 nonce 匹配。 */
export function checkNonce(larkAppId: string, chatId: string, target: string, nonce: string): boolean {
  const e = table.get(key(larkAppId, chatId, target));
  return !!e && e.state === 'pending' && e.nonce === nonce;
}

/** 授权成功 / revoke → 清除，允许将来重新申请。 */
export function clearPending(larkAppId: string, chatId: string, target: string): void {
  table.delete(key(larkAppId, chatId, target));
}

/** 拒绝 → 转 denied 冷却态（不清除），旧 nonce 失效，冷却期内不再弹卡。 */
export function markDenied(larkAppId: string, chatId: string, target: string): void {
  const now = Date.now();
  pruneStale(now);
  table.set(key(larkAppId, chatId, target), { state: 'denied', ts: now });
}

/** 入口 A 节流判断：pending 中、或 denied 冷却未过 → true（静默不发卡）。
 *  只需要「要不要发卡」的布尔（对话路径静默丢弃，无需区分原因）；要给用户回话、
 *  需要区分「等 owner 处理」和「已被拒绝」时用 throttleReason。 */
export function isThrottled(larkAppId: string, chatId: string, target: string): boolean {
  return throttleReason(larkAppId, chatId, target) !== null;
}

/**
 * 节流原因（null = 未节流，可发卡）。
 *
 * 与 isThrottled 的关系：后者是本函数的布尔化封装。拆开是因为两者的**消费方式**不同——
 * 对话路径（maybeSendGrantRequestCard）节流时静默 return，用户看不到任何反馈，所以
 * pending 与 denied 混成一个 true 无害；而 ask 卡片点击必须回一句 toast，混用会在
 * owner **已经拒绝**后仍告诉点击者「等 owner 处理」，把已决事项说成待决（pi review F1）。
 *
 * 顺带回收无效条目（与旧 isThrottled 行为一致，不能丢）：废弃的 pending 过 24h、
 * 冷却已过的 denied，都即时删除，让同一发送方能重新申请。
 */
export function throttleReason(
  larkAppId: string,
  chatId: string,
  target: string,
): 'pending' | 'denied' | null {
  const k = key(larkAppId, chatId, target);
  const e = table.get(k);
  if (!e) return null;
  if (e.state === 'pending') {
    // 废弃 pending（owner 一直没处置，或发卡失败残留）过 stale 窗口 → 本 key 即时回收，
    // 让同一发送方能重新申请。否则只有「别的 target 触发全表 prune」或 daemon 重启才会清，
    // 单一发送方反复 @ 会被永久静默压死、owner 永远看不到卡片。与下面 denied 的回收同构。
    if (Date.now() - e.ts < STALE_PENDING_MS) return 'pending';
    table.delete(k);
    return null;
  }
  // 冷却已过的 denied 不再节流，且无任何用途 → 顺手删除，避免「每个被拒用户」永久占位。
  if (Date.now() - e.ts < DENY_COOLDOWN_MS) return 'denied';
  table.delete(k);
  return null;
}

export function _resetForTest(): void { table.clear(); lastPrunedAt = 0; }
export function _tableSizeForTest(): number { return table.size; }
