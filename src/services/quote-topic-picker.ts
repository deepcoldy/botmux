/**
 * Collects the 话题 (Feishu threads) of a chat for the `/quote` picker.
 *
 * Why this exists: Feishu's quote-reply UI can only reference a SINGLE message
 * — there is no "quote this 话题" affordance. Users who wanted the bot to read
 * another 话题 in the same group had no way to point at it. `/quote` fills that
 * gap: it renders the chat's 话题 as a picker, and reading the chosen one is a
 * plain `im/v1/messages` call against the thread container.
 *
 * Discovery is deliberately derived from the CHAT tail rather than any per-bot
 * session registry, because the whole point is to reach 话题 the bot has no
 * session in — including 话题 driven by a different bot, or by humans only.
 * The bot's membership in the chat is the entire authorization boundary: Lark
 * refuses `im/v1/messages` with 230002 ("Bot/User can NOT be out of the chat")
 * for anything else, so there is no separate permission model to maintain here.
 *
 * Grouping rule (verified against live `im/v1/messages` output):
 *   • A 话题 root message carries `thread_id` (`omt_…`) and NO `root_id`.
 *   • Its replies carry the SAME `thread_id` plus a `root_id` pointing at the
 *     root message.
 *   • A 普通群 reply chain (not a 话题) has `root_id` but NO `thread_id`.
 *   • A flat top-level message has neither.
 * So the group key is `thread_id ?? root_id`, and messages with neither are
 * top-level chatter that belongs to no 话题 — excluded, since there is nothing
 * to "pick".
 */
import { listChatMessages } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';

export interface QuoteTopicEntry {
  /** Container id to read the 话题 with. `omt_…` for a real 话题 (thread
   *  container); `om_…` for a 普通群 reply chain (root-message container). */
  containerId: string;
  /** Which container type `containerId` addresses — the reader dispatches on
   *  this instead of sniffing the id prefix. */
  containerKind: 'thread' | 'root';
  /** First line of the 话题's opening message, already truncated for display. */
  title: string;
  /** Display name of whoever opened the 话题, when Lark resolved one. */
  starterName?: string;
  /** Number of messages seen in the scanned window — a lower bound, since the
   *  scan only covers the chat tail. Rendered as "N+ 条" to avoid implying it
   *  is the true total. */
  seenCount: number;
  /** Epoch ms of the most recent message seen in this 话题. Sort key. */
  lastMessageAt?: number;
}

/** How far back into the chat tail we scan for 话题. Lark caps a single
 *  `im/v1/messages` page at 50, so this pages a few times. Deep enough that a
 *  busy group still surfaces its recent 话题; shallow enough to stay one quick
 *  round-trip in the common case. */
export const QUOTE_TOPIC_SCAN_LIMIT = 200;

/** Longest title we render in a picker row before ellipsizing. */
const TITLE_MAX_CHARS = 60;

function firstLine(text: string): string {
  const line = text.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
}

/**
 * Group a raw `im/v1/messages` page list into 话题 entries, newest 话题 first.
 *
 * Exported separately from the fetch so the grouping rules can be tested
 * against recorded API shapes without a network call.
 *
 * @param excludeContainerIds 话题 to leave out — the one the caller is already
 *   sitting in. Quoting your own 话题 into itself is a no-op that would only
 *   duplicate context, so the picker never offers it. Takes a LIST because a
 *   session identifies its own 话题 by two different ids depending on how it
 *   was created: a real 话题 buckets under `thread_id` (`omt_…`) while a 普通群
 *   reply chain buckets under its root message id (`om_…`). Passing only the
 *   session's `rootMessageId` would silently fail to exclude any real 话题,
 *   since that id is not the bucket key.
 */
export function groupChatMessagesIntoTopics(
  rawMessages: any[],
  excludeContainerIds: readonly (string | undefined)[] = [],
): QuoteTopicEntry[] {
  const excluded = new Set(excludeContainerIds.filter((id): id is string => !!id));
  interface Bucket {
    containerId: string;
    containerKind: 'thread' | 'root';
    /** The 话题's opening message, once we see it. Identified structurally
     *  (`message_id === containerId` for a root container, or `!root_id`
     *  inside a thread) rather than by position, because the scan window may
     *  start mid-话题 and the oldest message we see is then NOT the root. */
     rootMsg?: any;
    /** Oldest message seen, used as the title fallback when the real root
     *  fell outside the scan window. */
    oldestMsg?: any;
    seenCount: number;
    lastMessageAt?: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const m of rawMessages) {
    const threadId = typeof m?.thread_id === 'string' ? m.thread_id : '';
    const rootId = typeof m?.root_id === 'string' ? m.root_id : '';
    // Neither field → flat top-level chatter, belongs to no 话题.
    if (!threadId && !rootId) continue;
    const containerId = threadId || rootId;
    const containerKind: 'thread' | 'root' = threadId ? 'thread' : 'root';
    if (excluded.has(containerId)) continue;

    let b = buckets.get(containerId);
    if (!b) {
      b = { containerId, containerKind, seenCount: 0 };
      buckets.set(containerId, b);
    }
    b.seenCount++;
    const createdMs = Number(m?.create_time);
    if (Number.isFinite(createdMs)) {
      if (b.lastMessageAt === undefined || createdMs > b.lastMessageAt) b.lastMessageAt = createdMs;
      const oldestMs = Number(b.oldestMsg?.create_time);
      if (!b.oldestMsg || !Number.isFinite(oldestMs) || createdMs < oldestMs) b.oldestMsg = m;
    } else if (!b.oldestMsg) {
      b.oldestMsg = m;
    }
    // The opening message: for a thread container it is the one with no
    // root_id; for a root container it is the message whose own id IS the
    // container. Both are exact — no reliance on scan ordering.
    const isRoot = containerKind === 'thread' ? !rootId : m?.message_id === containerId;
    if (isRoot) b.rootMsg = m;
  }

  const entries: QuoteTopicEntry[] = [];
  for (const b of buckets.values()) {
    const titleMsg = b.rootMsg ?? b.oldestMsg;
    if (!titleMsg) continue;
    const parsed = parseApiMessage(titleMsg);
    entries.push({
      containerId: b.containerId,
      containerKind: b.containerKind,
      title: firstLine(parsed.content) || '(无文本内容)',
      ...(parsed.senderName ? { starterName: parsed.senderName } : {}),
      seenCount: b.seenCount,
      ...(b.lastMessageAt !== undefined ? { lastMessageAt: b.lastMessageAt } : {}),
    });
  }
  // Most recently active 话题 first — that is overwhelmingly what the user
  // means when they say "the other 话题". Undated buckets sink to the bottom.
  entries.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  return entries;
}

/** Fetch the chat tail and group it into pickable 话题. */
export async function collectQuoteTopics(
  larkAppId: string,
  chatId: string,
  excludeContainerIds: readonly (string | undefined)[] = [],
  scanLimit: number = QUOTE_TOPIC_SCAN_LIMIT,
): Promise<QuoteTopicEntry[]> {
  const raw = await listChatMessages(larkAppId, chatId, scanLimit);
  return groupChatMessagesIntoTopics(raw, excludeContainerIds);
}

// ─── Pending follow-up instructions (`/quote <指令>`) ────────────────────────
//
// In one-round mode the user's instruction is typed with the command but only
// becomes actionable once they pick a 话题 from the card. It has to survive
// that gap.
//
// It is NOT carried inside the card's action value: Feishu caps that payload,
// and an instruction long enough to blow the cap would either break the card
// or have to be silently truncated — turning "summarize X but ignore Y" into
// "summarize X". Instead the value carries a short opaque token and the text
// stays here in the daemon.
//
// Entries expire so an abandoned picker (user never clicks) doesn't pin the
// string forever. An expired token degrades to two-round mode rather than
// failing the click — the 话题 still gets read, the user just re-states what
// they wanted.
const FOLLOW_UP_TTL_MS = 30 * 60 * 1000;
const pendingFollowUps = new Map<string, { text: string; expiresAt: number }>();
let followUpSeq = 0;

function sweepExpiredFollowUps(now: number): void {
  for (const [token, entry] of pendingFollowUps) {
    if (entry.expiresAt <= now) pendingFollowUps.delete(token);
  }
}

/** Park a follow-up instruction and return the token to bake into the card. */
export function stashQuoteFollowUp(text: string): string {
  const now = Date.now();
  sweepExpiredFollowUps(now);
  const token = `q${now.toString(36)}${(followUpSeq++).toString(36)}`;
  pendingFollowUps.set(token, { text, expiresAt: now + FOLLOW_UP_TTL_MS });
  return token;
}

/** Retrieve and consume a parked follow-up. Returns undefined when the token
 *  is unknown or expired — callers fall back to two-round mode. */
export function takeQuoteFollowUp(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const now = Date.now();
  sweepExpiredFollowUps(now);
  const entry = pendingFollowUps.get(token);
  if (!entry) return undefined;
  pendingFollowUps.delete(token);
  return entry.text;
}

