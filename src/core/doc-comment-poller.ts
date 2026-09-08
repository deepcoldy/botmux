// ⚠️ 必须保持 **type-only**：doc-comment.ts 反过来从本模块值导入
// `compareReplyIds`（补全后自排序要用）。type-only import 编译后被擦除，所以
// 现在不构成运行时循环；一旦这行改成值导入，两个模块就成真循环了。
import type { DocComment } from '../im/lark/doc-comment.js';

export interface DocCommentPollCursor {
  createdAt: number;
  replyId: string;
}

export interface PolledDocReply extends DocCommentPollCursor {
  commentId: string;
  isWhole: boolean;
  selectedText?: string;
  authorOpenId?: string;
  text: string;
  mentions: string[];
  priorReplies: Array<{ authorOpenId?: string; text: string }>;
}

/**
 * reply_id 按数值比大小（飞书 id 是雪花数，字符串序会把长度不同的排错）。
 * 无法解析成数字的 id 退化成字典序 —— 但注意空串不走这条路：`BigInt('')` 返回
 * `0n` 而不抛，所以空 id 会当 0 参与比较。实际无影响（空 id 的回复在
 * `flattenDocCommentReplies` 里已被过滤，事件链路也匹配不上）。
 */
export function compareReplyIds(a: string, b: string): number {
  try {
    const aa = BigInt(a);
    const bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

export function compareDocCommentPollCursor(a: DocCommentPollCursor, b: DocCommentPollCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return compareReplyIds(a.replyId, b.replyId);
}

export function flattenDocCommentReplies(comments: DocComment[]): PolledDocReply[] {
  return comments.flatMap(comment => comment.replies.map((reply, index) => ({
    commentId: comment.commentId,
    replyId: reply.replyId,
    createdAt: reply.createdAt ?? 0,
    isWhole: comment.isWhole === true,
    selectedText: comment.quote,
    authorOpenId: reply.userId,
    text: reply.text,
    mentions: reply.mentions,
    priorReplies: comment.replies.slice(0, index).map(previous => ({
      authorOpenId: previous.userId,
      text: previous.text,
    })),
  }))).filter(reply => reply.replyId && reply.createdAt > 0)
    .sort(compareDocCommentPollCursor);
}

export function latestDocCommentPollCursor(comments: DocComment[]): DocCommentPollCursor | undefined {
  return flattenDocCommentReplies(comments).at(-1);
}

export function docCommentRepliesAfterCursor(
  comments: DocComment[],
  cursor: DocCommentPollCursor,
): PolledDocReply[] {
  return flattenDocCommentReplies(comments).filter(reply => compareDocCommentPollCursor(reply, cursor) > 0);
}

/**
 * Walk `fresh` replies in ascending cursor order, delivering each and advancing
 * the persisted cursor **only** for a delivered reply. Stops at the first
 * `deliver` that returns false so a later success can never move the cursor past
 * an un-delivered earlier reply — that would drop it permanently, since the next
 * poll only fetches replies strictly after the cursor. The stopped reply is
 * retried from the same spot on the next poll (ordering is preserved).
 *
 * `deliver` returns true when the reply was handled (dispatched, or safely
 * skipped e.g. self-authored/empty so the cursor should move past it), and false
 * to stop the round without advancing (delivery failed, or the watch was removed
 * mid-loop). `commit` persists the cursor to the just-delivered reply.
 */
export async function advanceDocCommentCursor(
  fresh: PolledDocReply[],
  deliver: (reply: PolledDocReply) => Promise<boolean>,
  commit: (reply: PolledDocReply) => void | Promise<void>,
): Promise<void> {
  for (const reply of fresh) {
    const delivered = await deliver(reply);
    if (!delivered) return; // stop; retry from this reply on the next poll
    await commit(reply);
  }
}
