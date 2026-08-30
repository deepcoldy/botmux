/**
 * 「已通知过的待审版本」记录 —— 给 `app_under_review` 那条管理员提醒做去重。
 *
 * 为什么必须落盘（不能放内存）：发这条提醒的 `checkRequiredScopes` **只在 daemon
 * 启动时被调用一次**。内存态每次重启就清零，而「卡在审核中」是个会持续很多天的
 * 状态 —— 线上实测有卡 18 天、23 天的。那样节流等于没做：卡 N 天 ≈ 重启 N 次 ≈
 * 照样 N 条一模一样的 DM，**恰好把这次要消灭的刷屏换个文案请回来**。
 *
 * key 用**待审版本的 versionId**而不是时间窗：它对齐的是「事情有没有变化」而不是
 * 「过了多久」。同一个版本还卡着 → 不再打扰；换了新版本（人撤回重提过了）→ 该说。
 *
 * ⚠️ 写入时机是**DM 发送成功之后**，绝不能先记后发（见 `markPendingReviewNotified`
 * 的调用方）：反了的话一次网络失败就把这个 versionId 永久节流掉，人再也收不到提醒，
 * 而且是**零信号**的静默丢失，比刷屏更难发现。
 *
 * 文件按 app 隔离（`under-review-notified-<larkAppId>.json`），与 doc-subs-store
 * 同款约束：写者只有 daemon 进程本身（单写者），原子写（唯一 tmp + rename）即可，
 * 无需跨进程锁。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

interface NotifiedRecord {
  /** 已通知过的待审版本 id。 */
  versionId: string;
  /** 通知时间（仅诊断用，不参与判定 —— 判定只看 versionId 是否相同）。 */
  notifiedAt: number;
}

function filePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `under-review-notified-${larkAppId}.json`);
}

function readFile(dataDir: string, larkAppId: string): NotifiedRecord | undefined {
  const fp = filePath(dataDir, larkAppId);
  if (!existsSync(fp)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.versionId === 'string') {
      return parsed as NotifiedRecord;
    }
  } catch { /* corrupt — 当没通知过处理：宁可多提醒一次，不静默漏掉 */ }
  return undefined;
}

/**
 * 这个待审版本是否已经通知过管理员了。
 *
 * `versionId` 为 undefined 时**恒返回 false**（即「没通知过、该发」）：那对应
 * 「撞了 10046 但版本列表里找不到审核中版本」这个异常分支，它的含义是**我们的模型
 * 与飞书实际状态不一致**，每次出现都是新信息（可能是刚提交的版本还没进列表、写锁
 * 释放延迟，也可能是我们判据本身有 bug）。最后那种可能性正是不该节流的决定性理由：
 * 如果是我们的 bug，节流会把唯一的信号掐掉。
 */
export function wasPendingReviewNotified(
  dataDir: string,
  larkAppId: string,
  versionId: string | undefined,
): boolean {
  if (!versionId) return false;
  return readFile(dataDir, larkAppId)?.versionId === versionId;
}

/**
 * 记下「这个待审版本已经通知过了」。**只在 DM 确认发送成功后调用。**
 *
 * `versionId` 为 undefined 时不写任何东西（那条异常分支不节流，见
 * {@link wasPendingReviewNotified}）。
 */
export function markPendingReviewNotified(
  dataDir: string,
  larkAppId: string,
  versionId: string | undefined,
): void {
  if (!versionId) return;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const record: NotifiedRecord = { versionId, notifiedAt: Date.now() };
  atomicWriteFileSync(filePath(dataDir, larkAppId), JSON.stringify(record, null, 2) + '\n');
}
