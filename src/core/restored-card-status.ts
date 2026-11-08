/**
 * Restart-time status check for a surviving streaming card.
 *
 * A card's status lives only in its header text (「🖥️ Claude · 标题 — 工作中」);
 * the daemon does not persist it. After a restart the header is read back from
 * Lark, and only a card whose header still claims the CLI is running is
 * reconciled. Pure helpers — worker-pool owns the I/O.
 */
import { SUPPORTED_LOCALES, t } from '../i18n/index.js';

/** Header labels of the statuses that say "the CLI is running this turn". */
const WORKING_STATUS_KEYS = [
  'card.status.starting',
  'card.status.working',
  'card.status.analyzing',
  'card.status.stalled',
] as const;

let workingLabels: Set<string> | undefined;

function workingStatusLabels(): Set<string> {
  if (!workingLabels) {
    workingLabels = new Set(
      SUPPORTED_LOCALES.flatMap(locale => WORKING_STATUS_KEYS.map(key => t(key, undefined, locale))),
    );
  }
  return workingLabels;
}

function titleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return undefined;
}

/** Header title of a card message as returned by `GET /im/v1/messages/:id`:
 *  the original card JSON (`user_card_content`) or Lark's simplified
 *  `{ title, elements }` form. Undefined for a withdrawn or non-card message. */
export function cardMessageTitle(detail: unknown): string | undefined {
  const item = (detail as { items?: unknown[] } | undefined)?.items?.[0] as
    { deleted?: unknown; msg_type?: unknown; body?: { content?: unknown } } | undefined;
  if (!item || item.deleted === true) return undefined;
  if (item.msg_type !== undefined && item.msg_type !== 'interactive') return undefined;
  const raw = item.body?.content;
  if (typeof raw !== 'string') return undefined;
  let card: any;
  try { card = JSON.parse(raw); } catch { return undefined; }
  if (!card || typeof card !== 'object') return undefined;
  return titleText(card.header?.title) ?? titleText(card.title);
}

/** True when `title` is a botmux streaming card whose status label says the
 *  CLI is still running (启动中 / 工作中 / 正在分析 / 长时间无进展, any locale). */
export function streamingCardTitleClaimsWork(title: string | undefined): boolean {
  if (!title || !title.startsWith('🖥️')) return false;
  const sep = title.lastIndexOf(' — ');
  if (sep < 0) return false;
  return workingStatusLabels().has(title.slice(sep + ' — '.length).trim());
}

/** The message was sent by this bot. Lark labels a bot sender `app` in message
 *  lists, but other surfaces of the same API have said `bot`; accept either, or
 *  an app_id-typed id (as deferred-topic-claim does). The fence that matters is
 *  equality with this bot's own app id. */
function isOwnAppSender(sender: Record<string, any> | undefined, larkAppId: string): boolean {
  if (!sender || sender.id !== larkAppId) return false;
  const idType = sender.id_type ?? sender.sender_id_type;
  return sender.sender_type === 'app' || sender.sender_type === 'bot' || idType === 'app_id';
}

/** Streaming cards in a listed message window (Lark `im/v1/messages` items)
 *  that this bot posted before `postedBefore` and that still claim work while
 *  being no session's live card. Older builds left these behind: a type-ahead
 *  turn whose card was never parked, or a frozen-card list overwritten after a
 *  restart — nothing tracks them, so nothing would ever withdraw them. */
export function staleWorkingCardIds(
  messages: readonly unknown[],
  opts: { larkAppId: string; liveCardIds: ReadonlySet<string>; postedBefore: number },
): string[] {
  const ids: string[] = [];
  for (const m of messages as Array<Record<string, any> | null | undefined>) {
    if (!m || m.deleted === true || m.msg_type !== 'interactive') continue;
    if (!isOwnAppSender(m.sender, opts.larkAppId)) continue;
    const id = m.message_id;
    if (typeof id !== 'string' || !id || opts.liveCardIds.has(id)) continue;
    const createdAt = Number(m.create_time);
    if (!Number.isFinite(createdAt) || createdAt >= opts.postedBefore) continue;
    if (streamingCardTitleClaimsWork(cardMessageTitle({ items: [m] }))) ids.push(id);
  }
  return ids;
}
