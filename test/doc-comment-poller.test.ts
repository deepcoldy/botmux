import { describe, expect, it } from 'vitest';
import type { DocComment } from '../src/im/lark/doc-comment.js';
import {
  advanceDocCommentCursor,
  docCommentRepliesAfterCursor,
  flattenDocCommentReplies,
  latestDocCommentPollCursor,
  type PolledDocReply,
} from '../src/core/doc-comment-poller.js';

const comments: DocComment[] = [
  {
    commentId: 'comment-1',
    isSolved: false,
    quote: '选中的正文',
    isWhole: false,
    replies: [
      { replyId: '100', userId: 'ou_a', text: '历史问题', mentions: [], createdAt: 10 },
      { replyId: '102', userId: 'ou_b', text: '同秒的新回复', mentions: [], createdAt: 20 },
    ],
  },
  {
    commentId: 'comment-2',
    isSolved: false,
    isWhole: true,
    replies: [
      { replyId: '101', userId: 'ou_c', text: '普通评论，不含 @', mentions: [], createdAt: 20 },
      { replyId: '103', userId: 'ou_c', text: '最后一条', mentions: [], createdAt: 21 },
    ],
  },
];

describe('doc comment polling cursor', () => {
  it('orders replies by timestamp and numeric reply id while preserving thread context', () => {
    const replies = flattenDocCommentReplies(comments);
    expect(replies.map(reply => reply.replyId)).toEqual(['100', '101', '102', '103']);
    expect(replies.find(reply => reply.replyId === '102')?.priorReplies).toEqual([
      { authorOpenId: 'ou_a', text: '历史问题' },
    ]);
    expect(replies.find(reply => reply.replyId === '101')?.mentions).toEqual([]);
  });

  it('returns only replies after the persisted cursor, including same-second ids', () => {
    expect(docCommentRepliesAfterCursor(comments, { createdAt: 20, replyId: '101' })
      .map(reply => reply.replyId)).toEqual(['102', '103']);
    expect(latestDocCommentPollCursor(comments)).toMatchObject({ createdAt: 21, replyId: '103' });
  });
});

describe('advanceDocCommentCursor', () => {
  const fresh: PolledDocReply[] = [
    { commentId: 'c1', replyId: '100', createdAt: 10, isWhole: false, text: 'r1', mentions: [], priorReplies: [] },
    { commentId: 'c2', replyId: '101', createdAt: 11, isWhole: false, text: 'r2', mentions: [], priorReplies: [] },
    { commentId: 'c3', replyId: '102', createdAt: 12, isWhole: false, text: 'r3', mentions: [], priorReplies: [] },
  ];

  it('advances the cursor to every reply in order when all deliver', async () => {
    const committed: string[] = [];
    await advanceDocCommentCursor(fresh, async () => true, reply => { committed.push(reply.replyId); });
    expect(committed).toEqual(['100', '101', '102']);
  });

  it('stops at the first failed delivery and never advances past it (regression: dropped comment)', async () => {
    // r1 succeeds, r2 FAILS (e.g. a transient handleDocComment error), r3 would succeed.
    // The buggy loop advanced the cursor to r3 on its success, skipping r2 forever.
    const committed: string[] = [];
    const delivered: string[] = [];
    await advanceDocCommentCursor(
      fresh,
      async reply => { delivered.push(reply.replyId); return reply.replyId !== '101'; },
      reply => { committed.push(reply.replyId); },
    );
    // r3 is never even delivered — the round stops at the failed r2.
    expect(delivered).toEqual(['100', '101']);
    // Cursor only advanced through r1; r2 stays un-committed so the next poll retries it.
    expect(committed).toEqual(['100']);
  });

  it('does not advance when the very first reply fails', async () => {
    const committed: string[] = [];
    await advanceDocCommentCursor(fresh, async () => false, reply => { committed.push(reply.replyId); });
    expect(committed).toEqual([]);
  });
});
