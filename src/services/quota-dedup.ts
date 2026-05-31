/**
 * 消息额度扣费去重：飞书事件可能重投、WSClient 重连后同一 message_id 可能再次进来，
 * 硬额度若按事件次数扣会被重复扣。这里用一个有界的 message_id 状态表做幂等。
 *
 * pending/done 两态（codex review 修订）：
 *  - markChargedOnce 把 id 标成 **pending**（"扣费进行中"），不是"已扣定论"。
 *  - 扣费**成功** → commitCharge 转 done；后续同 id 重投命中 done → 跳过扣费、放行。
 *  - 扣费**失败**（consumeQuota throw / fail-closed drop）→ abortCharge 删除 pending，
 *    让后续重投重新走扣费，避免"先 mark 后失败 → 重投跳过扣费 → 硬上限被绕过"的 fail-open。
 *
 * 纯内存：重投是近期行为（秒~分钟级），daemon 重启后再收到旧 message_id 概率极低，
 * 额度近似安全（最坏边界多放行一两条），不值得持久化。
 */

const MAX_ENTRIES = 5000;
type State = 'pending' | 'done';
const table = new Map<string, { state: State; seq: number }>(); // key=`${larkAppId}:${messageId}`
let seq = 0;

const key = (larkAppId: string, messageId: string) => `${larkAppId}:${messageId}`;

/**
 * 首次见 (larkAppId, messageId) → 标记为 pending，返回 true（应继续扣费）。
 * 已在表里（pending 或 done）→ 返回 false（跳过扣费，调用方放行，避免重复扣 / fail-open）。
 * 空 messageId 无法去重 → 返回 true（按"可扣"处理；commit/abort 对它是 no-op）。
 */
export function markChargedOnce(larkAppId: string, messageId: string): boolean {
  if (!messageId) return true;
  const k = key(larkAppId, messageId);
  if (table.has(k)) return false;
  table.set(k, { state: 'pending', seq: ++seq });
  evict();
  return true;
}

/** 扣费成功：pending → done（定论，后续重投会被跳过）。 */
export function commitCharge(larkAppId: string, messageId: string): void {
  if (!messageId) return;
  const e = table.get(key(larkAppId, messageId));
  if (e) e.state = 'done';
}

/** 扣费失败 / fail-closed drop：删除 pending 标记，让后续重投重新尝试扣费（保硬上限不被绕过）。 */
export function abortCharge(larkAppId: string, messageId: string): void {
  if (!messageId) return;
  table.delete(key(larkAppId, messageId));
}

/** 有界淘汰：超限时按插入序删最旧（Map 迭代序即插入序）。pending 短命，极少被淘汰。 */
function evict(): void {
  if (table.size <= MAX_ENTRIES) return;
  const drop = table.size - MAX_ENTRIES;
  let i = 0;
  for (const oldKey of table.keys()) {
    table.delete(oldKey);
    if (++i >= drop) break;
  }
}

export function _resetForTest(): void { table.clear(); seq = 0; }
