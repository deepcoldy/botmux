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
  docCommentThreadAnchor,
  isDocNativeWatchSubscription,
  commitDocCommentPollCursor,
  normalizeDocNativeWatchSubscription,
  settleDocCommentWsDelivery,
  isPollingDocTriggerMode,
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

  it('derives one virtual session anchor per document comment thread', () => {
    expect(docCommentThreadAnchor('doccnFILE1', 'comment-1')).toBe('doc:doccnFILE1:comment-1');
    expect(docCommentThreadAnchor('doccnFILE1', 'comment-2')).toBe('doc:doccnFILE1:comment-2');
  });

  it('persists rejected mention-only WS delivery and clears it after acceptance', () => {
    putDocSubscription(dataDir, APP_A, sub({
      managedBy: 'watch-comment',
      commentTriggerMode: 'mention-only',
    }));
    const delivery = {
      commentId: 'comment-1',
      replyId: 'reply-1',
      text: 'question',
      authorOpenId: 'ou_author',
      queuedAt: 1,
    };

    expect(settleDocCommentWsDelivery(dataDir, APP_A, 'doccnFILE1', delivery, false)).toBe('queued');
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toEqual([delivery]);

    // A later explicit rebind must not erase the unaccepted WS turn.
    putDocSubscription(dataDir, APP_A, sub({ sessionAnchor: 'om_rebound' }));
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toEqual([delivery]);

    expect(settleDocCommentWsDelivery(dataDir, APP_A, 'doccnFILE1', delivery, true)).toBe('accepted');
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toBeUndefined();
  });

  it('preserves pending retry ownership when mode switches to all', () => {
    const delivery = {
      commentId: 'comment-1', replyId: 'reply-1', text: 'question', queuedAt: 1,
    };
    putDocSubscription(dataDir, APP_A, sub({
      managedBy: 'watch-comment',
      commentTriggerMode: 'mention-only',
      pendingDocCommentDeliveries: [delivery],
    }));

    expect(setCommentTriggerMode(dataDir, APP_A, 'doccnFILE1', 'all')).toBe(true);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toEqual([delivery]);
  });

  it('persists rejected --all WS delivery until the retry loop or list cursor accepts it', () => {
    putDocSubscription(dataDir, APP_A, sub({
      managedBy: 'watch-comment',
      commentTriggerMode: 'all',
    }));
    const delivery = { commentId: 'comment-1', replyId: 'reply-1', text: 'question', queuedAt: 1 };

    expect(settleDocCommentWsDelivery(dataDir, APP_A, 'doccnFILE1', delivery, false)).toBe('queued');
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toEqual([delivery]);
  });

  it('keeps an accepted --all marker across restart until cursor commit retires it atomically', () => {
    putDocSubscription(dataDir, APP_A, sub({
      managedBy: 'watch-comment',
      commentTriggerMode: 'all',
      pollBaselineReady: true,
      pollCursorAt: 10,
      pollCursorReplyId: '100',
    }));
    const delivery = { commentId: 'comment-1', replyId: '101', text: 'question', queuedAt: 1 };
    // First-attempt success has no pre-existing pending row; it must still
    // create a durable accepted marker until the cursor commits.
    expect(settleDocCommentWsDelivery(dataDir, APP_A, 'doccnFILE1', delivery, true)).toBe('accepted');

    const accepted = getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries?.[0];
    expect(accepted).toMatchObject({ replyId: '101', acceptedAt: expect.any(Number) });

    expect(commitDocCommentPollCursor(
      dataDir, APP_A, 'doccnFILE1', { createdAt: 11, replyId: '101' },
    )).toBe(true);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')).toMatchObject({
      pollCursorAt: 11,
      pollCursorReplyId: '101',
      pollBaselineReady: true,
    });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.pendingDocCommentDeliveries).toBeUndefined();
  });

  it('normalizes legacy document-native watches without retaining one session binding', () => {
    const legacy = sub({
      sessionAnchor: 'doc:doccnFILE1',
      sessionId: 'legacy-session',
      scope: 'chat',
      chatId: 'doc:doccnFILE1',
      managedBy: 'watch-comment',
    });

    expect(isDocNativeWatchSubscription(legacy)).toBe(true);
    expect(normalizeDocNativeWatchSubscription(legacy)).toEqual({
      ...legacy,
      sessionAnchor: 'doc:doccnFILE1:watch',
      sessionId: undefined,
      chatId: 'doc:doccnFILE1:watch',
    });
  });
});

describe('asDocWatchOutcome（跨版本收窄）', () => {
  it('收已知值，拒绝未知/非字符串', () => {
    expect(asDocWatchOutcome('dispatched')).toBe('dispatched');
    expect(asDocWatchOutcome('poll-failed')).toBe('poll-failed');
    expect(asDocWatchOutcome('from-a-future-version')).toBeUndefined();
    expect(asDocWatchOutcome(undefined)).toBeUndefined();
    expect(asDocWatchOutcome(42)).toBeUndefined();
  });
});

describe('recordDocWatchActivity（运行态诊断，绝不抛）', () => {
  it('记结局/时刻；dispatched 累加计数并推进 lastDispatchAt', () => {
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
    expect(row.lastDispatchAt).toBe(1_000);
    expect(row.dispatchCount).toBe(1);
    expect(row.lastOutcome).toBe('not-mentioned');
  });

  it('成功后清掉旧 lastError；错误时截断到上限', () => {
    putDocSubscription(dataDir, APP_A, sub());
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed', error: 'boom' });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toBe('boom');
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'dispatched' });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toBeUndefined();
    recordDocWatchActivity(dataDir, APP_A, 'doccnFILE1', { outcome: 'poll-failed', error: 'x'.repeat(5_000) });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.lastError).toHaveLength(DOC_WATCH_LAST_ERROR_MAX);
  });

  it('订阅已不存在时不写（不复活被回滚/退订的行）', () => {
    expect(recordDocWatchActivity(dataDir, APP_A, 'ghost', { outcome: 'dispatched' })).toBe(false);
    expect(getDocSubscription(dataDir, APP_A, 'ghost')).toBeNull();
  });
});

describe('setDocTitle', () => {
  it('trim 后写入；与现值相同/空串/未知 token 不写', () => {
    putDocSubscription(dataDir, APP_A, sub());
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', ' 需求文档 ')).toBe(true);
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')?.docTitle).toBe('需求文档');
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', '需求文档')).toBe(false);
    expect(setDocTitle(dataDir, APP_A, 'doccnFILE1', '   ')).toBe(false);
    expect(setDocTitle(dataDir, APP_A, 'ghost', 'x')).toBe(false);
  });
});

describe('putDocSubscription inheritRuntime（运行态 vs 溯源，策略相反）', () => {
  const watchRow = (over: Partial<DocSubscription> = {}): DocSubscription => ({
    fileToken: 'doccnFILE1', fileType: 'docx',
    sessionAnchor: 'doc:doccnFILE1:watch', scope: 'chat', chatId: 'doc:doccnFILE1:watch',
    commentTriggerMode: 'mention-only', managedBy: 'watch-comment', createdAt: 1,
    lastActivityAt: 900, lastOutcome: 'dispatched', lastDispatchAt: 900, dispatchCount: 3,
    autoCreated: true, autoCreatedBy: 'ou_stranger', autoCreatedAt: 100,
    ...over,
  });

  it('默认整行覆盖：运行态与溯源都不带入（只保 pending 功能状态）', () => {
    putDocSubscription(dataDir, APP_A, watchRow());
    putDocSubscription(dataDir, APP_A, watchRow({
      lastActivityAt: undefined, lastOutcome: undefined, lastDispatchAt: undefined, dispatchCount: undefined,
      autoCreated: undefined, autoCreatedBy: undefined, autoCreatedAt: undefined,
    }));
    const after = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(after.dispatchCount).toBeUndefined();
    expect(after.autoCreated).toBeUndefined();
  });

  it('inheritRuntime 只补运行态五项，不碰溯源三项（owner 接管后不再是 auto-sub）', () => {
    putDocSubscription(dataDir, APP_A, watchRow());
    putDocSubscription(dataDir, APP_A, {
      fileToken: 'doccnFILE1', fileType: 'docx',
      sessionAnchor: 'om_ownerThread', sessionId: 'sess-owner', scope: 'thread',
      chatId: 'oc_ownerGroup', commentTriggerMode: 'all', managedBy: 'watch-comment',
      ownerOpenId: 'ou_owner', createdAt: 1,
    }, { inheritRuntime: true });
    const after = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(after.dispatchCount).toBe(3);
    expect(after.lastOutcome).toBe('dispatched');
    expect(after.lastActivityAt).toBe(900);
    expect(after.autoCreated).toBeUndefined();
    expect(after.autoCreatedBy).toBeUndefined();
    expect(after.autoCreatedAt).toBeUndefined();
  });

  it('inheritRuntime 不覆盖调用方显式给出的运行态值；无旧行时纯新增', () => {
    putDocSubscription(dataDir, APP_A, watchRow());
    putDocSubscription(dataDir, APP_A, watchRow({ dispatchCount: 0, lastOutcome: 'poll-failed' }), { inheritRuntime: true });
    expect(getDocSubscription(dataDir, APP_A, 'doccnFILE1')!.dispatchCount).toBe(0);
    removeDocSubscription(dataDir, APP_A, 'doccnFILE1');
    putDocSubscription(dataDir, APP_A, watchRow({ dispatchCount: undefined, lastOutcome: undefined }), { inheritRuntime: true });
    const fresh = getDocSubscription(dataDir, APP_A, 'doccnFILE1')!;
    expect(fresh.dispatchCount).toBeUndefined();
    expect(fresh.lastOutcome).toBeUndefined();
  });
});

describe('isPollingDocTriggerMode（哪些模式靠轮询而非 WS 推送）', () => {
  it('all 与 owner-mention 都走轮询；mention-only 不靠轮询', () => {
    expect(isPollingDocTriggerMode('all')).toBe(true);
    expect(isPollingDocTriggerMode('owner-mention')).toBe(true);
    expect(isPollingDocTriggerMode('mention-only')).toBe(false);
    expect(isPollingDocTriggerMode(undefined)).toBe(false);
  });
});
