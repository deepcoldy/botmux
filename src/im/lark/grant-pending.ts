/**
 * 授权申请的内存状态表（per bot:chat:target）。两个职责合一：
 *  - nonce 防旧卡重放：每次发卡生成 nonce，卡片按钮带它；处置时校验仍匹配。
 *  - 节流：pending 期间 / denied 冷却期间，不重复弹卡。
 * 纯内存，daemon 重启清空（重启后旧卡 nonce 自然失效，符合预期）。
 */
import { randomUUID } from 'node:crypto';

const DENY_COOLDOWN_MS = 10 * 60 * 1000;

type Entry = { state: 'pending' | 'denied'; nonce?: string; ts: number; quota?: number };
const table = new Map<string, Entry>();

const key = (a: string, c: string, t: string) => `${a}:${c}:${t}`;

/** 开一张待处置的卡，返回 nonce。`quota` 为可选的消息额度（已解析），落授权时透传给 grant-store。 */
export function openPending(larkAppId: string, chatId: string, target: string, quota?: number): string {
  return openPendingMulti(larkAppId, chatId, [target], quota);
}

/** owner 一次 /grant 多个目标：同一张卡 → 多个 target 共用同一 nonce，
 *  owner 点一次范围即对全部目标生效。校验时每个 target 独立 checkNonce。
 *  `quota`（若有）对每个 target 各自生效（每人 N 条额度）。 */
export function openPendingMulti(larkAppId: string, chatId: string, targets: string[], quota?: number): string {
  const nonce = randomUUID();
  const ts = Date.now();
  for (const target of targets) table.set(key(larkAppId, chatId, target), { state: 'pending', nonce, ts, quota });
  return nonce;
}

/** 回读 pending 上挂的额度（owner 点授权按钮时用）。无 / 非 pending → undefined。 */
export function getPendingQuota(larkAppId: string, chatId: string, target: string): number | undefined {
  const e = table.get(key(larkAppId, chatId, target));
  return e && e.state === 'pending' ? e.quota : undefined;
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
  table.set(key(larkAppId, chatId, target), { state: 'denied', ts: Date.now() });
}

/** 入口 A 节流判断：pending 中、或 denied 冷却未过 → true（静默不发卡）。 */
export function isThrottled(larkAppId: string, chatId: string, target: string): boolean {
  const e = table.get(key(larkAppId, chatId, target));
  if (!e) return false;
  if (e.state === 'pending') return true;
  return Date.now() - e.ts < DENY_COOLDOWN_MS;
}

export function _resetForTest(): void { table.clear(); }
