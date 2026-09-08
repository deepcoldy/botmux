import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  putDocSubscription,
  getDocSubscription,
  removeDocSubscription,
  listDocSubscriptionsForSession,
  listAllDocSubscriptions,
  setCommentTriggerMode,
  recordDocWatchActivity,
  setDocTitle,
  asDocWatchOutcome,
  DOC_WATCH_LAST_ERROR_MAX,
  type DocSubscription,
} from '../src/services/doc-subs-store.js';

let dataDir = '';
const APP_A = 'cli_appA';
const APP_B = 'cli_appB';

function sub(over: Partial<DocSubscription> = {}): DocSubscription {
  return {
    fileToken: 'doccnFILE1',
    fileType: 'docx',
    sessionAnchor: 'om_anchor1',
    scope: 'thread',
    chatId: 'oc_chat1',
    commentTriggerMode: 'mention-only',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-doc-subs-')); });
afterEach(() => { if (dataDir) { rmSync(dataDir, { recursive: true, force: true }); dataDir = ''; } });

describe('doc-subs-store', () => {
  it('returns null / empty when nothing stored', () => {
    expect(getDocSubscription(dataDir, APP_A, 'doccnX')).toBeNull();
    expect(listAllDocSubscriptions(dataDir, APP_A)).toEqual([]);
    expect(listDocSubscriptionsForSession(dataDir, APP_A, 'om_x')).toEqual([]);
  });

  it('put → get round-trips', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')).toMatchObject({ fileToken: 'doccnFILE1', fileType: 'docx', sessionAnchor: 'om_anchor1' });
  });

  it('one document binds to one session: re-put rebinds and reports previous', () => {
    putDocSubscription(dataDir, APP_A, sub({ sessionAnchor: 'om_old' }));
    const { previous } = putDocSubscription(dataDir, APP_A, sub({ sessionAnchor: 'om_new' }));
    expect(previous?.sessionAnchor).toBe('om_old');
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.sessionAnchor).toBe('om_new');
    // single key — not duplicated
    expect(listAllDocSubscriptions(dataDir, APP_A)).toHaveLength(1);
  });

  it('lists a session\'s subscriptions; one session can hold many docs', () => {
    putDocSubscription(dataDir, APP_A, sub({ fileToken: 'd1', sessionAnchor: 'om_s' }));
    putDocSubscription(dataDir, APP_A, sub({ fileToken: 'd2', sessionAnchor: 'om_s' }));
    putDocSubscription(dataDir, APP_A, sub({ fileToken: 'd3', sessionAnchor: 'om_other' }));
    const forS = listDocSubscriptionsForSession(dataDir, APP_A, 'om_s').map(s => s.fileToken).sort();
    expect(forS).toEqual(['d1', 'd2']);
  });

  it('remove returns the removed entry then it is gone', () => {
    putDocSubscription(dataDir, APP_A, sub());
    const removed = removeDocSubscription(dataDir, APP_A, 'doccnFILE1');
    expect(removed?.fileToken).toBe('doccnFILE1');
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')).toBeNull();
    expect(removeDocSubscription(dataDir, APP_A, 'doccnFILE1')).toBeUndefined();
  });

  it('setCommentTriggerMode flips an existing sub; misses return false', () => {
    putDocSubscription(dataDir, APP_A, sub({ commentTriggerMode: 'mention-only' }));
    expect(setCommentTriggerMode(dataDir, APP_A, 'doccnFILE1', 'all')).toBe(true);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.commentTriggerMode).toBe('all');
    expect(setCommentTriggerMode(dataDir, APP_A, 'missing', 'all')).toBe(false);
  });

  it('per-app isolation: APP_B never sees APP_A entries', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(getDocSubscription(dataDir, APP_B, 'doccnFILE1')).toBeNull();
    expect(listAllDocSubscriptions(dataDir, APP_B)).toEqual([]);
  });
});

describe('recordDocWatchActivity（运行态诊断）', () => {
  it('记下结局与时刻；dispatched 额外累加计数并推进 lastDispatchAt', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched', at: 5_000 })).toBe(true);
    let row = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(row.lastOutcome).toBe('dispatched');
    expect(row.lastActivityAt).toBe(5_000);
    expect(row.lastDispatchAt).toBe(5_000);
    expect(row.dispatchCount).toBe(1);

    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched', at: 6_000 });
    row = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(row.dispatchCount).toBe(2);
    expect(row.lastDispatchAt).toBe(6_000);
  });

  it('非 dispatched 结局推进 lastActivityAt 但不动投递计数/时刻', () => {
    putDocSubscription(dataDir, APP_A, sub());
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched', at: 1_000 });
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'not-mentioned', at: 2_000 });
    const row = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(row.lastActivityAt).toBe(2_000);
    expect(row.lastDispatchAt).toBe(1_000);   // 没被后来的正常丢弃冲掉
    expect(row.dispatchCount).toBe(1);
    expect(row.lastOutcome).toBe('not-mentioned');
  });

  it('⭐成功后清掉上一次的 lastError（否则修好的旧报错会永远挂在界面上）', () => {
    putDocSubscription(dataDir, APP_A, sub());
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed', error: 'boom' });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toBe('boom');
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched' });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toBeUndefined();
  });

  it('lastError 超长被截断（订阅表不该被一条报错撑大）', () => {
    putDocSubscription(dataDir, APP_A, sub());
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed', error: 'x'.repeat(5_000) });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toHaveLength(DOC_WATCH_LAST_ERROR_MAX);
  });

  it('⭐订阅不存在时不写（绝不能把已被回滚/退订的订阅复活）', () => {
    expect(recordDocWatchActivity(dataDir, APP_A, 'ghost', { outcome: 'dispatched' })).toBe(false);
    expect(getDocSubscription(dataDir, APP_A, 'ghost')).toBeNull();
    expect(listAllDocSubscriptions(dataDir, APP_A)).toEqual([]);
  });

  /**
   * ⭐「绝不抛」是这个函数的核心契约，却一度**零覆盖**：把它的 try/catch 整个剥掉，
   * 全部 66 条用例照样全绿。而这个契约承的东西很重 —— `processCommentEvent` 的
   * 7 个出口都裸调它，一旦它能抛，一次磁盘故障就会把「记不下诊断日志」升级成
   * 「这条真实评论投递失败」，即可观测特性自己变成新的故障源。
   *
   * 🔴 造这条覆盖时踩过两个坑，记下来免得后人重演：
   *  ① 「把 dataDir 指向一个同名文件」**打不到 catch**：那样订阅文件不存在 →
   *     `readFile` 返回 {} → 行不存在 → 在写之前就 `return false` 了。读必须成功、
   *     写才会被执行到，所以坏点得放在**写**上而不是路径上。
   *  ② `chattr +i` 能在 root 下造出 EPERM，但依赖 ext4 且容器/CI 里可能直接失败 ——
   *     用它就把这条用例变成环境相关的间歇红。
   *
   * 最终手法：mock 掉 `atomicWriteFileSync` 让它抛。这确实是「mock 抛了被抓住」，
   * 但这里恰好是对的口径 —— 要证的命题就是「**写入抛异常时**本函数不外抛」，
   * 而异常来源（ENOSPC / EPERM / EIO）对这条契约无差别。真实 I/O 故障没法在
   * 单测里可移植地造出来。
   */
  it('⭐写入抛异常时返回 false 而不外抛（processCommentEvent 全靠这条契约）', async () => {
    putDocSubscription(dataDir, APP_A, sub());
    const atomic = await import('../src/utils/atomic-write.js');
    const spy = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(() => recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched' })).not.toThrow();
      expect(recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched' })).toBe(false);
      // setDocTitle 同样不能外抛（它也在 best-effort 路径上被裸调）
      expect(() => setDocTitle(dataDir, APP_A, 'doccnFILE1', '新标题')).not.toThrow();
      expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', '新标题')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('store 内容损坏时按空表处理，不外抛', () => {
    writeFileSync(join(dataDir, `doc-subscriptions-${APP_A}.json`), '{ this is not json');
    expect(() => recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed' })).not.toThrow();
    expect(recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed' })).toBe(false);
  });

  it('⭐读后写：不会用调用方的旧快照覆盖别处刚改的字段', () => {
    putDocSubscription(dataDir, APP_A, sub({ commentTriggerMode: 'mention-only' }));
    // 模拟：调用方手里还是 mention-only 的旧快照，期间 dashboard 改成了 all
    setCommentTriggerMode(dataDir, APP_A, 'doccnFILE1', 'all');
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched' });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.commentTriggerMode).toBe('all');
  });
});

describe('setDocTitle', () => {
  it('写入标题；标题未变时不重复写（返回 false）', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', ' 需求文档 ')).toBe(true);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.docTitle).toBe('需求文档');
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', '需求文档')).toBe(false);
  });

  it('空标题与未知 token 都不写', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', '   ')).toBe(false);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.docTitle).toBeUndefined();
    expect(setDocTitle(dataDir, APP_A, 'ghost', 'x')).toBe(false);
  });
});

describe('putDocSubscription inheritRuntime', () => {
  // 这一组钉的是「两组字段策略相反」这件事本身。它容易被后人顺手统一成「都继承」
  // 或「都不继承」，而两种统一各自会坏掉下面一半的用例。
  const runtimeRow = (over: Partial<DocSubscription> = {}): DocSubscription => ({
    fileToken: 'tok', fileType: 'docx', sessionAnchor: 'doc:tok', scope: 'chat',
    chatId: 'doc:tok', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
    createdAt: 1,
    lastActivityAt: 900, lastOutcome: 'dispatched', lastDispatchAt: 900, dispatchCount: 3,
    autoCreated: true, autoCreatedBy: 'ou_stranger', autoCreatedAt: 100,
    ...over,
  });

  it('默认（不传 opts）保持整行覆盖语义 —— 四个调用方都依赖它', () => {
    putDocSubscription(dataDir, APP_A, runtimeRow());
    putDocSubscription(dataDir, APP_A, runtimeRow({
      lastActivityAt: undefined, lastOutcome: undefined, lastDispatchAt: undefined,
      dispatchCount: undefined, autoCreated: undefined, autoCreatedBy: undefined,
      autoCreatedAt: undefined,
    }));
    const after = getDocSubscription(dataDir, APP_A, 'tok');
    expect(after?.dispatchCount).toBeUndefined();
    expect(after?.autoCreated).toBeUndefined();
  });

  it('⭐inheritRuntime 只补运行态五项，**不**碰溯源三项', () => {
    putDocSubscription(dataDir, APP_A, runtimeRow());
    // owner 用 /watch-comment 接管：字面量不写溯源（这条不再是 auto-sub），
    // 也不写运行态（它不该关心，交给 inheritRuntime 延续）。
    putDocSubscription(dataDir, APP_A, {
      fileToken: 'tok', fileType: 'docx',
      sessionAnchor: 'om_ownerThread', sessionId: 'sess-owner', scope: 'thread',
      chatId: 'oc_ownerGroup', commentTriggerMode: 'all', managedBy: 'watch-comment',
      ownerOpenId: 'ou_the_owner', createdAt: 1,
    }, { inheritRuntime: true });
    const after = getDocSubscription(dataDir, APP_A, 'tok');
    // 运行态延续：换绑定不代表这篇文档的投递历史归零。
    expect(after?.dispatchCount).toBe(3);
    expect(after?.lastOutcome).toBe('dispatched');
    expect(after?.lastActivityAt).toBe(900);
    // 溯源清掉：owner 主动接管后这条**不再是**陌生人 @ 出来的。若继承，界面会
    // 一直挂着「自动创建 · 触发者 ou_stranger」这条已经不成立的审计结论 ——
    // 比字段丢失更糟（丢失是少一条信息，这是显示一条错的信息）。
    expect(after?.autoCreated).toBeUndefined();
    expect(after?.autoCreatedBy).toBeUndefined();
    expect(after?.autoCreatedAt).toBeUndefined();
  });

  it('inheritRuntime 不覆盖调用方显式给出的运行态值', () => {
    putDocSubscription(dataDir, APP_A, runtimeRow());
    putDocSubscription(dataDir, APP_A, runtimeRow({ dispatchCount: 0, lastOutcome: 'poll-failed' }), { inheritRuntime: true });
    const after = getDocSubscription(dataDir, APP_A, 'tok');
    expect(after?.dispatchCount).toBe(0);
    expect(after?.lastOutcome).toBe('poll-failed');
  });

  it('inheritRuntime 在没有旧行时是纯新增（不造出空字段）', () => {
    putDocSubscription(dataDir, APP_A, {
      fileToken: 'tok', fileType: 'docx', sessionAnchor: 'doc:tok', scope: 'chat',
      chatId: 'doc:tok', commentTriggerMode: 'mention-only', managedBy: 'watch-comment',
      createdAt: 1,
    }, { inheritRuntime: true });
    const after = getDocSubscription(dataDir, APP_A, 'tok');
    expect(after?.dispatchCount).toBeUndefined();
    expect(after?.lastOutcome).toBeUndefined();
  });
});

describe('asDocWatchOutcome', () => {
  it('收窄已知值，拒绝未知/非字符串（跨版本读旧文件）', () => {
    expect(asDocWatchOutcome('dispatched')).toBe('dispatched');
    expect(asDocWatchOutcome('poll-failed')).toBe('poll-failed');
    expect(asDocWatchOutcome('from-a-future-version')).toBeUndefined();
    expect(asDocWatchOutcome(undefined)).toBeUndefined();
    expect(asDocWatchOutcome(42)).toBeUndefined();
  });
});
