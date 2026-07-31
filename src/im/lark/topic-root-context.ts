/**
 * Detect a 普通群 topic whose root the bot never retained, and inject a
 * lightweight *hint* (not the full transcript) telling the CLI it can pull the
 * topic history on demand via `botmux history`.
 *
 * Why this is needed: a 普通群 topic is often started on an earlier message X
 * (X carries `thread_id` but no `root_id`, arrived as a top-level group message
 * without an @, and was ignored/never retained by the daemon). The @-mention
 * reply carries `root_id=X` + `thread_id` and routes to a session anchored at X
 * — so on the first turn the bot only sees the @-reply and has no *signal* that
 * a topic root + prior replies even exist. That missing signal is the real gap
 * (contrast the quote path: the user's explicit quote already gives the bot a
 * `botmux quoted` hint).
 *
 * Why a hint, not an eager full replay: replaying the whole thread means (1) on
 * short topics, dumping every message as prompt noise regardless of relevance;
 * (2) on long topics, `listThreadMessages` caps at the *oldest* 50 (ByCreateTime
 * Asc + slice), so a late @mention would get the topic's opening and miss the
 * most-relevant recent messages; (3) downloading every historical image/file to
 * this bot's bucket up front, most of which won't be used. Instead we mirror the
 * quote mechanism: emit a one-line hint and let the CLI decide whether to run
 * `botmux history` (thread-scope by default → walks this very thread, with its
 * own `--limit` for count control and `botmux quoted` for any attachments).
 *
 * Called only on the first turn (handleNewTopic) when the inbound message is a
 * real-thread reply (`root_id` set and ≠ its own message_id). Subsequent turns
 * already carry the thread in the CLI's conversation history.
 *
 * Best-effort: the count is a single cheap metadata probe (one list call, no
 * per-message parsing, no card re-resolve, no attachment download). If it fails
 * we still emit the hint without a count — the gate already proved a root
 * exists, so the signal must never be lost.
 */
import { listThreadMessages } from './client.js';
import { t, type Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

export async function buildTopicThreadContext(
  larkAppId: string,
  chatId: string,
  rootId: string,
  currentMessageId: string,
  locale?: Locale,
): Promise<string> {
  if (!rootId) return '';
  let count = 0;
  try {
    // One lightweight metadata list (root + replies, asc). We only read the
    // *count* for the hint — no per-message render, no card re-resolve, no
    // attachment download. Capped at the default 50, which is fine as a floor
    // for a hint; the CLI's own `botmux history --limit` controls the real read.
    const items = await listThreadMessages(larkAppId, chatId, rootId);
    // Exclude the current @-reply: it is the user's prompt for this turn, not
    // prior context. (listThreadMessages includes it — it's a thread reply.)
    count = items.filter(m => m?.message_id && m.message_id !== currentMessageId).length;
  } catch (err: any) {
    // Best-effort: we still KNOW a root exists (gate: rootId ≠ messageId), so
    // fall through to a countless hint rather than dropping the signal entirely.
    logger.debug(`[topic-thread] count probe failed root=${rootId.substring(0, 12)}: ${err?.message ?? err}`);
  }
  return count > 0
    ? `${t('prompt.topic_context', { count }, locale)}\n`
    : `${t('prompt.topic_context_unknown', undefined, locale)}\n`;
}
