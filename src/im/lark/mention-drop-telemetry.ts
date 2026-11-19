/**
 * mention-drop-telemetry.ts — 群里「找本 bot」的人类消息在入口被丢弃、却没有任何可见回执时，
 * 给每个丢弃出口打一条 WARN，并按原因累计计数。
 *
 * 为什么需要：这些出口过去只打 DEBUG（线上默认不开）或什么都不打。用户反馈「@ 了没反应」时，
 * 本机队列、日志、卡片里都找不到这条消息，分不清「事件从未入站」和「入站后被闸门忽略」。
 * 有了这条 WARN，搜 `mention-drop` 就能定位后者及其原因。
 *
 * 只记「有 @ 本 bot 迹象」的群消息，普通群聊照旧不打日志：
 *  - explicit：快照里的 mentions / at 节点能确认 @ 的就是本 bot；
 *  - unresolved：正文里有 `@_user_N` 占位符，但 mentions 里没有对应且带身份的条目——飞书在
 *    消息发出后才把 mention 解析完，WS 快照先到时就是这个形态，无法判断 @ 的是谁；
 *  - open_id_unknown：本 bot 的 open_id 还没探测到，带 @ 的消息无从判断是不是在找本 bot。
 *    这种情况只在消息入口记一次（reason=open_id_unknown），下游各出口不再重复记。
 *
 * 日志只带群 / 消息 / 发送方 ID 的 12 位前缀、原因和计数，绝不带正文。
 *
 * 依赖只用 event-dispatcher 本来就在用的 message-parser 导出：单测里对它们做局部 mock 的
 * 文件不会因为本模块多出一个导入而连不上。
 */
import { logger } from '../../utils/logger.js';
import { extractMentionIdentities, messageMentionsBot } from './message-parser.js';

export type MentionEvidence = 'explicit' | 'unresolved' | 'open_id_unknown';

/** 丢弃出口。WARN 里的 reason 就是这个值，便于搜索和按原因统计。 */
export type MentionDropReason =
  /** 本 bot open_id 未知，@ 判定失效，消息会被当成没 @ 处理。 */
  | 'open_id_unknown'
  /** dispatcher 层斜杠命令处理器认不出 @ 本 bot，吞掉消息且不回复。 */
  | 'command_gate'
  /** 替身模式的四个让路出口：认不出 @ 本 bot，按「只 @ 了替身对象」让路。 */
  | 'substitute_excluded_chat'
  | 'substitute_chat_off'
  | 'substitute_keyword_miss'
  | 'substitute_topic_backoff'
  /** 发送方在黑名单。 */
  | 'sender_blocked'
  /** 发送方没有对话权限，授权申请卡也没发出去。 */
  | 'grant_cards_off'
  | 'grant_no_admin'
  | 'grant_no_sender'
  | 'grant_card_failed'
  | 'grant_throttled';

const PLACEHOLDER_RE = /@_user_\d+/g;
const PLACEHOLDER_EXACT_RE = /^@_user_\d+$/;

/** 正文里的 `@_user_N` 占位符（text 正文里的内联 token、post 的 at 节点），以及 post 里 at 节点的个数。 */
function scanMentionTokens(message: any): { placeholders: Set<string>; atNodes: number } {
  const placeholders = new Set<string>();
  let atNodes = 0;
  const raw = message?.content ?? message?.body?.content;
  if (typeof raw !== 'string' || !raw) return { placeholders, atNodes };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { placeholders, atNodes };
  }
  if (typeof parsed?.text === 'string') {
    for (const m of parsed.text.matchAll(PLACEHOLDER_RE)) placeholders.add(m[0]);
    return { placeholders, atNodes };
  }
  if (!parsed || typeof parsed !== 'object') return { placeholders, atNodes };
  // post：正文直接是 { content } 或按语言包一层（zh_cn / en_us / …）。
  const bodies = Array.isArray(parsed.content) ? [parsed] : Object.values(parsed);
  for (const body of bodies) {
    const paragraphs = (body as any)?.content;
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const node of paragraph) {
        if (node?.tag !== 'at') continue;
        atNodes += 1;
        if (typeof node.user_id === 'string' && PLACEHOLDER_EXACT_RE.test(node.user_id)) placeholders.add(node.user_id);
      }
    }
    break;
  }
  return { placeholders, atNodes };
}

/**
 * 这条消息有没有「@ 本 bot」的迹象，迹象有多确定。undefined = 没有（普通群聊，或只 @ 了
 * 身份已经解析出来的其他成员）。
 */
export function classifyMentionEvidence(
  message: any,
  larkAppId: string,
  botOpenId: string | undefined,
): MentionEvidence | undefined {
  // open_id 未知时仍能按 app_id 形态认出本 bot。
  if (messageMentionsBot(message, larkAppId, botOpenId)) return 'explicit';
  const { placeholders, atNodes } = scanMentionTokens(message);
  const identities = extractMentionIdentities(message);
  if (!botOpenId) {
    const anyMention = identities.length > 0 || atNodes > 0 || placeholders.size > 0;
    return anyMention ? 'open_id_unknown' : undefined;
  }
  if (placeholders.size === 0) return undefined;
  const resolvedKeys = new Set(identities
    .filter(m => m.key && (m.openId || m.appId || m.userId || m.unionId))
    .map(m => m.key));
  for (const key of placeholders) {
    if (!resolvedKeys.has(key)) return 'unresolved';
  }
  return undefined;
}

const counts = new Map<string, number>();

function idPrefix(id: unknown): string {
  return typeof id === 'string' && id ? id.substring(0, 12) : '-';
}

/**
 * 在一个丢弃出口调用：有 @ 本 bot 迹象的群消息计数 +1 并打 WARN，其它消息什么都不做。
 * 观测代码绝不能打断消息处理：内部任何异常都吃掉。
 */
export function reportMentionDrop(input: {
  larkAppId: string;
  /** 本 bot 的 open_id；未知时只接受 reason=open_id_unknown（见文件头注）。 */
  botOpenId: string | undefined;
  message: any;
  reason: MentionDropReason;
  senderOpenId?: string;
}): void {
  try {
    const { larkAppId, botOpenId, message, reason } = input;
    if (message?.chat_type === 'p2p') return;
    if (!botOpenId !== (reason === 'open_id_unknown')) return;
    const evidence = classifyMentionEvidence(message, larkAppId, botOpenId);
    if (!evidence) return;
    const key = `${larkAppId}\u0000${reason}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const what = reason === 'open_id_unknown'
      ? '本 bot open_id 未知，无法判断群消息里的 @ 是否指向本 bot，需 @ 的消息会被当作未 @ 忽略'
      : '群消息疑似在找本 bot，但在入口被丢弃且没有可见回执';
    logger.warn(
      `[mention-drop:${larkAppId}] ${what} ` +
      `reason=${reason} mention=${evidence} chat=${idPrefix(message?.chat_id)} ` +
      `msg=${idPrefix(message?.message_id)} sender=${idPrefix(input.senderOpenId)} count=${count}`,
    );
  } catch (err) {
    logger.debug(`[mention-drop:${input.larkAppId}] report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test-only：清空进程内计数。 */
export function _resetMentionDropCountsForTest(): void {
  counts.clear();
}
