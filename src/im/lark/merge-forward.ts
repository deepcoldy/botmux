import { getMessageDetail } from './client.js';
import {
  parseApiMessage,
  extractResources,
  createImgNumberer,
  unwrapUserDslContent,
  cardContentHasUpgradeFallback,
  isPureCardUpgradeFallback,
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
  // Pass userCardContent:true so interactive sub-cards return their real v2
  // body (schema/body/elements) instead of the simplified "请升级至最新版本"
  // fallback. This combo 500s (Lark code 2200) on many merge_forward parents —
  // still does as of Jun 2026 — so fall back to userCardContent:false on any
  // error rather than dropping the whole forward tree. The false path returns
  // rich cards as the placeholder shell; the per-sub recovery pass below then
  // restores their real bodies for same-tenant subs (cross-tenant subs 232010
  // and stay as the placeholder).
  let detail: any;
  try {
    detail = await getMessageDetail(larkAppId, rootMessageId, { userCardContent: true });
  } catch (err) {
    logger.debug(`[merge_forward] userCardContent:true failed for ${rootMessageId}, falling back to false: ${describeAxiosErr(err)}`);
    detail = await getMessageDetail(larkAppId, rootMessageId, { userCardContent: false });
  }
  const allItems: any[] = detail?.items ?? [];
  const extraResources: MessageResource[] = [];

  // Recover degraded interactive sub-cards. The parent fetch with
  // userCardContent:true above 500s on many merge_forward parents (Lark
  // server-side, code 2200) — we fall back to userCardContent:false, which
  // returns RICH reply cards (long agent answers) as a bare "请升级至最新版本
  // 客户端" placeholder + a single img. A PER-SUB refetch with
  // userCardContent:true on the sub-message's OWN message_id recovers the full
  // v2 body for SAME-tenant forwards (the common case — verified live: the bulk
  // false call returns a 173-byte fallback shell, the per-sub true call returns
  // the 6KB real body, code=0). Cross-tenant subs throw 232010 on the
  // single-message endpoint — caught per-sub so we keep the simplified shape
  // instead of dropping the card. Only subs that actually carry the fallback are
  // refetched, so a successful true-first parent fetch costs zero extra calls.
  await Promise.all(
    allItems
      .filter(m => m?.msg_type === 'interactive' && cardContentHasUpgradeFallback(m.body?.content ?? ''))
      .map(async m => {
        try {
          const real = await getMessageDetail(larkAppId, m.message_id, { userCardContent: true });
          const content = real?.items?.[0]?.body?.content;
          if (content && !isPureCardUpgradeFallback(content)) {
            m.body = { ...(m.body ?? {}), content };
          }
        } catch (err) {
          logger.debug(`[merge_forward] per-sub card refetch failed for ${m.message_id}: ${describeAxiosErr(err)}`);
        }
      }),
  );

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

      // userCardContent:true above usually delivers the real card. Fallback
      // path (false) leaves the simplified shape; we still try user_dsl
      // unwrap on the off-chance it's there, but don't refetch — see above.
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
