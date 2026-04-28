import { getMessageDetail } from './client.js';
import {
  parseApiMessage,
  extractResources,
  createImgNumberer,
  unwrapUserDslContent,
  type MessageResource,
} from './message-parser.js';
import { renderForwardedXml, type ForwardedNode } from './forwarded-renderer.js';
import type { LarkMessage } from '../../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Extract a useful one-liner from an AxiosError / generic error.
 * Lark's SDK rethrows AxiosError whose default toString just says
 * "Request failed with status code 400" — hiding the actual server reason.
 */
export function describeAxiosErr(err: any): string {
  const detail = err?.response?.data ?? err?.message ?? String(err);
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

/**
 * Build a tree of ForwardedNode + collect attachment resources from a
 * merge_forward message. Lark's im.v1.message.get returns ALL descendants
 * in one shot via the `items` array, each with `upper_message_id` pointing
 * to its parent — so we make exactly one API call per top-level expand and
 * walk the tree purely in memory. Recursing per nested merge_forward via
 * separate API calls fails (Lark 230002 "Bot/User can NOT be out of the chat")
 * because the bot may be in the outer chat but not in the original chat the
 * nested merge_forward came from. The single-call design sidesteps that.
 */
export async function buildForwardedTree(
  larkAppId: string,
  rootMessageId: string,
  numberer: ReturnType<typeof createImgNumberer>,
  maxDepth: number,
): Promise<{ nodes: ForwardedNode[]; extraResources: MessageResource[] }> {
  // user_card_content combined with merge_forward triggers HTTP 500 — keep
  // it off. Sub-messages come back in the simplified "Format A" card shape
  // which extractCardContent already handles.
  const detail = await getMessageDetail(larkAppId, rootMessageId, { userCardContent: false });
  const allItems: any[] = detail?.items ?? [];
  const extraResources: MessageResource[] = [];

  // Index children by upper_message_id for O(1) lookup during the walk.
  const childrenByParent = new Map<string, any[]>();
  for (const msg of allItems) {
    const parent = msg.upper_message_id ?? '';
    if (!parent) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(msg);
    childrenByParent.set(parent, list);
  }

  function walk(parentId: string, depth: number): ForwardedNode[] {
    const children = childrenByParent.get(parentId) ?? [];
    const nodes: ForwardedNode[] = [];
    for (const msg of children) {
      const senderType: ForwardedNode['senderType'] =
        msg.sender?.sender_type === 'app' ? 'app'
        : msg.sender?.sender_type === 'user' ? 'user'
        : 'unknown';
      const senderOpenId = msg.sender?.id ?? '';

      // Interactive sub-messages arrive via REST as a simplified fallback.
      // Lark's im.message.get never returns user_dsl (even for the bot's own
      // messages), so we can only unwrap when a user_dsl somehow got through.
      // For third-party cards whose simplified form is the "请升级至最新版本"
      // fallback, the real body is unrecoverable from REST.
      if (msg.msg_type === 'interactive') {
        const unwrapped = unwrapUserDslContent(msg.body?.content ?? '');
        if (unwrapped !== null) {
          msg.body = { ...(msg.body ?? {}), content: unwrapped };
        }
      }

      // Resources first so the numberer assigns [图片 N] in attachment order;
      // text extraction below reuses those numbers. Do NOT override messageId —
      // Lark requires the parent merge_forward's message_id to download
      // resources (error 234003 if sub-message ID is used).
      const subResources = extractResources(msg.msg_type ?? 'text', msg.body?.content ?? '', numberer);
      extraResources.push(...subResources);

      if (msg.msg_type === 'merge_forward' && depth < maxDepth) {
        const inner = walk(msg.message_id, depth + 1);
        nodes.push({ senderOpenId, senderType, children: inner });
      } else {
        const sub = parseApiMessage(msg, numberer);
        nodes.push({ senderOpenId, senderType, content: sub.content });
      }
    }
    return nodes;
  }

  return { nodes: walk(rootMessageId, 0), extraResources };
}

/**
 * Expand a merge_forward message by fetching sub-messages via Lark API.
 * Replaces parsed.content with an XML-rendered forward tree (deduplicated
 * participants, alias-referenced messages) and collects additional resources.
 */
export async function expandMergeForward(
  larkAppId: string, messageId: string, parsed: LarkMessage,
  numberer = createImgNumberer(),
): Promise<{ extraResources: MessageResource[] }> {
  const MAX_DEPTH = 5;
  try {
    const { nodes, extraResources } = await buildForwardedTree(larkAppId, messageId, numberer, MAX_DEPTH);
    if (nodes.length === 0) return { extraResources };
    parsed.content = renderForwardedXml(nodes);
    parsed.msgType = 'merge_forward_expanded';
    return { extraResources };
  } catch (err) {
    logger.warn(`Failed to expand merge_forward ${messageId}: ${describeAxiosErr(err)}`);
    return { extraResources: [] };
  }
}
