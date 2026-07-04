/**
 * 消息额度扣费去重：飞书事件可能重投、WSClient 重连后同一 message_id 可能再次进来，
 * 硬额度若按事件次数扣会被重复扣。这里用一个有界的 message_id 状态表做幂等。
 *
 * 三态去重（codex review 二轮收紧，修 fail-open）：
 *  - beginCharge 首次见 id → 记 **pending**（"扣费进行中"，非定论），返回 'fresh'：调用方继续扣费。
 *  - 扣费**成功** → commitCharge 转 **done**；后续同 id 重投命中 done → 返回 'done'：跳过扣费、放行
 *    （同一条消息只扣一次）。
 *  - 扣费**失败 / 被拒**（consumeQuota throw、或 allow=false 这种 fail-closed drop）→ abortCharge
 *    删除标记，让后续重投**重新走扣费判定**，避免「先 mark 后失败/被拒 → 重投命中标记被放行 →
 *    硬上限被绕过」的 fail-open。**关键**：被拒消息绝不能留成 done，否则重投会被直接放行。
 *  - 重投撞上仍 **pending**（前一投扣费 in-flight 未定论）→ 返回 'pending'：调用方按 **fail-closed
 *    drop** 处理（不放行、不扣），绝不在扣费定论前放行第二投。第一投走完会照常扣费+投递。
 *
 * 纯内存：重投是近期行为（秒~分钟级），daemon 重启后再收到旧 message_id 概率极低，
 * 额度近似安全，不值得持久化。
 */

const MAX_ENTRIES = 5000;
type State = 'pending' | 'done';
/** beginCharge 的结果：见 beginCharge 文档。 */
export type ChargeOutcome = 'fresh' | 'pending' | 'done';
const table = new Map<string, { state: State; seq: number }>(); // key=`${larkAppId}:${messageId}`
let seq = 0;

const key = (larkAppId: string, messageId: string) => `${larkAppId}:${messageId}`;

/**
 * 标记/查询一次扣费，返回三态：
 *  - 'fresh'   首次见此 id（已记 pending）：调用方应继续扣费。
 *  - 'pending' 已有 in-flight 扣费尚未定论：调用方应 **fail-closed drop**（不放行、不扣）。
 *  - 'done'    已成功扣费定论：调用方放行（跳过扣费，不重复扣）。
 * 空 messageId 无法去重 → 永远 'fresh'（commit/abort 对它是 no-op）。
 */
export function beginCharge(larkAppId: string, messageId: string): ChargeOutcome {
  if (!messageId) return 'fresh';
  const k = key(larkAppId, messageId);
  const e = table.get(k);
  if (e) return e.state === 'done' ? 'done' : 'pending';
  table.set(k, { state: 'pending', seq: ++seq });
  evict();
  return 'fresh';
}

/** 扣费成功：pending → done（定论，后续重投会被跳过+放行）。 */
export function commitCharge(larkAppId: string, messageId: string): void {
  if (!messageId) return;
  const e = table.get(key(larkAppId, messageId));
  if (e) e.state = 'done';
}

/** 扣费失败 / 被拒（fail-closed drop）：删除标记，让后续重投重新判定（保硬上限不被绕过）。 */
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
