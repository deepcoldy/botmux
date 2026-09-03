/**
 * 「已通知过的待审版本」节流状态 —— 关键不变量：
 *   • 必须落盘（发提醒的 checkRequiredScopes 只在 daemon 启动时跑一次，内存态每次重启
 *     清零 ⟹ 卡 N 天就发 N 条一模一样的 DM，等于没节流）
 *   • key 是 versionId（对齐「事情有没有变化」而非「过了多久」）
 *   • versionId 缺失时**不节流**（那对应「撞 10046 却找不到待审版本」的异常分支）
 *   • 只在 DM 确认发送成功后才写（先记后发 = 一次网络失败就永久静默丢失）
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  wasPendingReviewNotified,
  markPendingReviewNotified,
} from '../src/services/under-review-notify-store.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'under-review-store-'));

describe('under-review 通知节流状态', () => {
  it('落盘后跨「进程重启」仍然有效（这正是不能放内存的原因）', () => {
    const dir = freshDir();
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v1')).toBe(false);
    markPendingReviewNotified(dir, 'cli_a', 'v1');
    // 同一个 versionId 再问 → 已通知过。读的是文件，所以等价于「重启后再问」：
    // 内存态实现在这一步会返回 false（清零），那就是「节流等于没做」。
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v1')).toBe(true);
    expect(existsSync(join(dir, 'under-review-notified-cli_a.json'))).toBe(true);
  });

  it('换了待审版本就该重新提醒（key 对齐「事情有没有变化」）', () => {
    const dir = freshDir();
    markPendingReviewNotified(dir, 'cli_a', 'v1');
    // 人撤回旧版、修完配置重提了新版本 → 这是新情况，必须再说一次
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v2')).toBe(false);
  });

  it('🔴 versionId 缺失时不节流（异常分支每次都值得说）', () => {
    const dir = freshDir();
    // 「撞了 10046 却找不到审核中版本」意味着模型与飞书实际状态不一致 —— 可能是刚提交
    // 的版本还没进列表、写锁释放延迟，**也可能是我们判据本身有 bug**。最后那种情况下
    // 节流会掐掉唯一的信号，所以这里恒为 false。
    expect(wasPendingReviewNotified(dir, 'cli_a', undefined)).toBe(false);
    markPendingReviewNotified(dir, 'cli_a', undefined);
    // 也不该因此写出任何文件（否则会污染真实 versionId 的判定）
    expect(existsSync(join(dir, 'under-review-notified-cli_a.json'))).toBe(false);
    expect(wasPendingReviewNotified(dir, 'cli_a', undefined)).toBe(false);
  });

  it('按 app 隔离：一个 bot 通知过不影响另一个', () => {
    const dir = freshDir();
    markPendingReviewNotified(dir, 'cli_a', 'v1');
    expect(wasPendingReviewNotified(dir, 'cli_b', 'v1')).toBe(false);
  });

  it('文件损坏时当作「没通知过」——宁可多提醒一次，不静默漏掉', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'under-review-notified-cli_a.json'), '{ not json');
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v1')).toBe(false);
    // 且还能正常写回去（不被坏文件卡死）
    markPendingReviewNotified(dir, 'cli_a', 'v1');
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v1')).toBe(true);
  });

  it('记录里带 notifiedAt 供诊断，但判定只看 versionId', () => {
    const dir = freshDir();
    markPendingReviewNotified(dir, 'cli_a', 'v1');
    const raw = JSON.parse(readFileSync(join(dir, 'under-review-notified-cli_a.json'), 'utf-8'));
    expect(raw.versionId).toBe('v1');
    expect(typeof raw.notifiedAt).toBe('number');
    // 把时间改成很久以前，判定不该变（不是时间窗节流）
    writeFileSync(
      join(dir, 'under-review-notified-cli_a.json'),
      JSON.stringify({ versionId: 'v1', notifiedAt: 0 }),
    );
    expect(wasPendingReviewNotified(dir, 'cli_a', 'v1')).toBe(true);
  });
});
