/**
 * Fetch the full history of a 普通群 topic — root + every reply before the
 * current @mention — and render it as a prompt-context block, so the bot sees
 * the *complete* topic context, not just the @-reply text.
 *
 * Why this is needed: a 普通群 topic is often started on an earlier message X
 * (X carries `thread_id` but no `root_id`, arrived as a top-level group
 * message without an @, and was ignored/never retained by the daemon). The
 * @-mention reply carries `root_id=X` + `thread_id` and routes to a session
 * anchored at X — yet without this fetch the bot only ever sees the @-reply.
 * Other humans may also have replied in the topic before the @; those too are
 * invisible unless we replay the thread.
 *
 * Called only on the first turn (handleNewTopic) when the inbound message is
 * a real-thread reply (`root_id` set and ≠ its own message_id). Subsequent
 * turns already carry the thread in the CLI's conversation history.
 *
 * Best-effort throughout: any failure (thread unavailable, withdrawn root, API
 * error) degrades to a root-only fetch, then to '' — the first turn is never
 * blocked, it simply falls back to the old behavior.
 */
import { getMessageDetail } from './client.js';
import { listThreadMessages } from './client.js';
import {
  parseApiMessage,
  extractResources,
  createImgNumberer,
  resolveMergedCardContent,
  type MessageResource,
} from './message-parser.js';
import { expandMergeForward } from './merge-forward.js';
import { downloadResources, formatAttachmentsHint } from '../../core/session-manager.js';
import { t, type Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

/** Render one raw API message into a { sender, body } pair (body already
 *  includes [图片 N]/[文件 N] placeholders + an <attachments> block). Best-effort
 *  per message: a failure returns null so one bad message can't sink the
 *  whole transcript. */
async function renderTopicMessage(
  larkAppId: string,
  rawMessage: any,
): Promise<{ sender: string; body: string } | null> {
  try {
    const numberer = createImgNumberer();
    // extractResources BEFORE parseApiMessage so [图片 N]/[文件 N] placeholders
    // align with the resource list (same contract as parseEventMessage /
    // renderQuotedMessage — extractTextContent only consults the cache, it does
    // not create entries for resources that haven't been declared yet).
    const resources: MessageResource[] = extractResources(
      rawMessage.msg_type ?? 'text',
      rawMessage.body?.content ?? '',
      numberer,
    );
    const parsed = parseApiMessage(rawMessage, numberer);

    if (parsed.msgType === 'merge_forward') {
      const { extraResources } = await expandMergeForward(larkAppId, parsed.messageId, parsed, numberer);
      resources.push(...extraResources);
    } else if (parsed.msgType === 'interactive') {
      // Re-resolve the card via dual im.message.get so the model sees the real
      // v2 body instead of Lark's "请升级客户端" fallback. Fresh numberer +
      // full content/resource replacement, matching renderQuotedMessage.
      const cardNumberer = createImgNumberer();
      const merged = await resolveMergedCardContent(larkAppId, parsed.messageId, cardNumberer).catch(() => null);
      if (merged) {
        parsed.content = merged.text;
        resources.length = 0;
        resources.push(...merged.resources);
      }
    }

    // Download this message's attachments into this bot's own bucket so a
    // sandboxed CLI can open them — same as the inbound-message path.
    const { attachments } = await downloadResources(larkAppId, parsed.messageId, resources);

    const sender = parsed.senderName ?? parsed.senderId ?? '';
    const text = parsed.content?.trim() ?? '';
    const attachmentBlock = formatAttachmentsHint(attachments);
    const body = text + (attachmentBlock ? `\n${attachmentBlock}` : '');
    if (!body) return null;
    return { sender: sender || 'unknown', body };
  } catch (err: any) {
    logger.debug(`[topic-thread] skip msg=${rawMessage?.message_id?.substring(0, 12)}: ${err?.message ?? err}`);
    return null;
  }
}

/** Render a single root message as a last-resort context block when the full
 *  thread list is unavailable. Mirrors renderTopicMessage but is tolerant of
 *  being called with just a root id. */
async function renderRootOnly(larkAppId: string, rootId: string, locale?: Locale): Promise<string> {
  try {
    const detail = await getMessageDetail(larkAppId, rootId, { userCardContent: false });
    const rawMessage = detail?.items?.[0];
    if (!rawMessage) return '';
    const rendered = await renderTopicMessage(larkAppId, rawMessage);
    if (!rendered) return '';
    return `${t('prompt.topic_context', { count: 1 }, locale)}\n${rendered.sender}: ${rendered.body}\n`;
  } catch (err: any) {
    logger.warn(`[topic-thread] root-only fallback failed root=${rootId.substring(0, 12)}: ${err?.message ?? err}`);
    return '';
  }
}

export async function buildTopicThreadContext(
  larkAppId: string,
  chatId: string,
  rootId: string,
  currentMessageId: string,
  locale?: Locale,
): Promise<string> {
  if (!rootId) return '';
  try {
    // listThreadMessages resolves the thread_id from the root, then lists root
    // + replies in ascending create-time order (with sender names). Up to 50
    // messages — plenty for a first-turn topic; long threads are capped.
    const items = await listThreadMessages(larkAppId, chatId, rootId);
    // Exclude the current @-reply: it is the user's prompt for this turn, not
    // context. (listThreadMessages includes it because it's a thread reply.)
    const prior = items.filter(m => m?.message_id && m.message_id !== currentMessageId);
    if (prior.length === 0) {
      // Thread list empty/unavailable — fall back to fetching just the root.
      return renderRootOnly(larkAppId, rootId, locale);
    }
    const rendered = (await Promise.all(prior.map(m => renderTopicMessage(larkAppId, m))))
      .filter((r): r is { sender: string; body: string } => r !== null);
    if (rendered.length === 0) {
      return renderRootOnly(larkAppId, rootId, locale);
    }
    const transcript = rendered.map(r => `${r.sender}: ${r.body}`).join('\n');
    return `${t('prompt.topic_context', { count: rendered.length }, locale)}\n${transcript}\n`;
  } catch (err: any) {
    logger.warn(`[topic-thread] list failed root=${rootId.substring(0, 12)}: ${err?.message ?? err}; trying root-only`);
    return renderRootOnly(larkAppId, rootId, locale);
  }
}
