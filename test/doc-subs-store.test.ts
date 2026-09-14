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
