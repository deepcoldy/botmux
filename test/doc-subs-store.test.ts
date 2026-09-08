import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('asDocWatchOutcome', () => {
  it('收窄已知值，拒绝未知/非字符串（跨版本读旧文件）', () => {
    expect(asDocWatchOutcome('dispatched')).toBe('dispatched');
    expect(asDocWatchOutcome('poll-failed')).toBe('poll-failed');
    expect(asDocWatchOutcome('from-a-future-version')).toBeUndefined();
    expect(asDocWatchOutcome(undefined)).toBeUndefined();
    expect(asDocWatchOutcome(42)).toBeUndefined();
  });
});
