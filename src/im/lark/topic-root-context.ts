/**
 * Build a lightweight *hint* (not the topic transcript) telling the CLI that
 * this first turn is a reply inside a 普通群 topic whose root the bot never
 * retained — and that it can pull the topic history on demand via
 * `botmux history`.
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
 * Why a pure hint with ZERO first-turn fetch: the earlier count-probe variant
 * was neither lightweight nor accurate. `listThreadMessages` first GETs the
 * root to resolve thread_id, then pulls up to 50 *full* message bodies — and
 * when thread_id can't be resolved it falls back to paging the *whole chat*
 * (potentially the entire large-group history) to filter by root_id. On top of
 * that, the 50-per-page cap means the "count" is only a floor (as of the
 * Desc-paging fix, the newest 50), so printing it as an exact total is
 * misleading. Since the daemon gate has
 * *already* proven this is a topic reply, we don't need a network call at all:
 * emit the hint unconditionally and let the CLI decide whether to run
 * `botmux history` (thread-scope by default → walks this very thread, with its
 * own `--limit` for count control and `botmux quoted` for any attachments).
 *
 * Called only on the first turn (handleNewTopic) when the inbound message is a
 * real-thread reply (`root_id` set and ≠ its own message_id). Subsequent turns
 * already carry the thread in the CLI's conversation history. The gate lives at
 * the call site; this function just renders the localized hint string.
 */
import { t, type Locale } from '../../i18n/index.js';

export function buildTopicThreadContext(locale?: Locale): string {
  return `${t('prompt.topic_context', undefined, locale)}\n`;
}
