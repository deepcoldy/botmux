import { postCanonicalMentionOrder } from '../im/lark/message-parser.js';

/** Pure structural predicates shared by journal readers and prompt rendering. */
export interface GroupContextContentRecord {
  senderType: 'user' | 'bot' | 'unknown';
  msgType: string;
  text: string;
  /** Version 1 identifies canonical conversational content, already projected from the card. */
  cardContentVersion?: number;
  resourceRefs?: readonly unknown[];
  deleted?: boolean;
}

// Match the producer's first body status line, optionally after its authored
// card title. A phase word inside normal prose is not a runtime envelope.
const LEGACY_TURN_STATUS = /^(?:\[卡片: [^\r\n]+\]\r?\n)?(?:\[标签: [^\r\n]+\]\r?\n)*(?:⏳ \*\*(?:等待执行|等待响应|Queued|Waiting for a response)|💭 \*\*(?:处理中|Working)|🙋 \*\*(?:等待你确认|Waiting for your response)|⏹️? \*\*(?:正在停止|已停止|Stopping|Stopped)|✅ \*\*(?:已完成|Completed)|❌ \*\*(?:执行失败|Failed)|⚠️? \*\*(?:执行状态待确认|Interrupted))(?: · \d+(?:\.\d+)?s)?\*\*(?:\r?\n|$)/u;
const LEGACY_DESKTOP_STATUS = /^\[卡片: 🖥️ [^\r\n]+ — (?:启动中…|工作中|等待输入|已处理 · 判定无需回复|已完成|正在分析…|长时间无进展|已中断|限额已达|可重试|Starting…|Working|Awaiting input|Handled · no reply needed|Completed|Analyzing…|No recent progress|Interrupted|Limit reached|Ready to retry)\](?:\r?\n|$)/u;

function hasCanonicalCardContent(record: GroupContextContentRecord): boolean {
  return record.cardContentVersion === 1;
}

function isLegacyRuntimeEnvelope(record: GroupContextContentRecord): boolean {
  return record.senderType === 'bot' && record.msgType === 'interactive' && !hasCanonicalCardContent(record)
    && (LEGACY_TURN_STATUS.test(record.text.trim()) || LEGACY_DESKTOP_STATUS.test(record.text.trim()));
}

/** Presentation-only: deleted records must still be persisted to prevent resurrection. */
export function isGroupContextNoise(record: GroupContextContentRecord): boolean {
  const text = record.text.trim();
  if (record.deleted && record.senderType !== 'user' && (!text || text === '[卡片]') && !record.resourceRefs?.length) return true;
  if (record.senderType !== 'bot') return false;
  if (record.msgType === 'post' && (text === 'Working' || text === 'Completed') && !record.resourceRefs?.length) return true;
  return Boolean(record.deleted && isLegacyRuntimeEnvelope(record))
    || record.msgType === 'interactive' && !hasCanonicalCardContent(record) && text.startsWith('[卡片: 🖥️')
      && ['打开 Web 终端', 'Web terminal', '获取操作链接', '关闭会话'].some((action) => text.includes(action));
}

export function isUnavailableGroupContextCard(record: GroupContextContentRecord): boolean {
  return !record.deleted && record.senderType !== 'user' && record.msgType === 'interactive'
    && (isLegacyRuntimeEnvelope(record)
      || /^(?:\[图片\s+1\]\s*)?请升级至最新版本客户端(?:[，,]以查看内容)?[。.!！]?$/.test(record.text.trim()));
}

/** Mask only session-control query values; preserve original UTF-16 source offsets. */
export function sanitizeGroupContextText(text: string): string {
  return text.replace(/([?&](?:amp;)?(?:viewToken|controlToken|operationToken)=)([^&#\s<>"'`)\]]*)/g,
    (_match, prefix: string, value: string) => prefix + '*'.repeat(value.length));
}

/** Structured mention evidence carried by a shared message representation
 * (from the live event or a history read that included `mentions`). */
export interface GroupContextMentionRef {
  key: string;
  name: string;
  openId?: string;
  appId?: string;
  userId?: string;
  unionId?: string;
}

function mentionIdentity(mention: GroupContextMentionRef): string {
  // A post `at` node names its target in the content itself; that id is the
  // identity on both observation paths, whatever id type a top-level list
  // attaches to it (the list only enriches display information).
  if (mention.key.startsWith('@_at:')) return `at:${mention.key.slice('@_at:'.length)}`;
  return mention.openId ? `open:${mention.openId}` : mention.unionId ? `union:${mention.unionId}`
    : mention.userId ? `user:${mention.userId}` : mention.appId ? `app:${mention.appId}` : `name:${mention.name}`;
}

const PLACEHOLDER = /@_user_\d+/g;

/** Placeholder keys in body order. The caller's known message type decides
 * how the canonical body is read: a text body carries `@_user_N`
 * placeholders (whatever its prose looks like, including JSON that resembles
 * an internal form); a post body is a typed node sequence whose `at` nodes
 * name their target. */
function placeholderKeysInOrder(rawText: string, msgType: string | undefined): string[] {
  if (msgType === 'post') return (postCanonicalMentionOrder(rawText) ?? []).map(target => `@_at:${target}`);
  return rawText.match(PLACEHOLDER) ?? [];
}

/** The mention semantics of a body: each placeholder occurrence in the raw
 * body, in order, bound to the identity its mention entry names. Swapping two
 * targets changes the bindings even though the identity set is unchanged.
 * Entries whose key never occurs in the body follow, sorted, so nothing an
 * event asserted is lost. Without a raw body only the sorted identity set is
 * known (legacy rows). */
export function groupContextMentionIdentities(mentions: readonly GroupContextMentionRef[] | undefined, rawText?: string, msgType?: string): string[] {
  if (!mentions?.length) return [];
  const byKey = new Map(mentions.map(mention => [mention.key, mentionIdentity(mention)] as const));
  if (rawText === undefined) return [...new Set(byKey.values())].sort();
  const bound: string[] = [];
  const used = new Set<string>();
  for (const match of placeholderKeysInOrder(rawText, msgType)) {
    const identity = byKey.get(match);
    if (identity === undefined) continue;
    bound.push(identity);
    used.add(match);
  }
  const unbound = [...byKey.entries()].filter(([key]) => !used.has(key)).map(([, identity]) => identity).sort();
  return [...bound, ...unbound];
}

/** Same mention semantics: identical ordered bindings when both raw bodies are
 * known, otherwise identical identity sets. */
export function sameGroupContextMentions(
  left: readonly GroupContextMentionRef[] | undefined, right: readonly GroupContextMentionRef[] | undefined,
  leftRaw?: string, rightRaw?: string, msgType?: string,
): boolean {
  if (!left?.length && !right?.length) return true;
  if (!left?.length || !right?.length) return false;
  const positional = leftRaw !== undefined && rightRaw !== undefined;
  const a = groupContextMentionIdentities(left, positional ? leftRaw : undefined, msgType);
  const b = groupContextMentionIdentities(right, positional ? rightRaw : undefined, msgType);
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export interface GroupContextRepresentation {
  /** The platform message type; it decides how `rawText` is read. */
  msgType?: string;
  text: string;
  /** Platform body with placeholders intact (text / post messages). */
  rawText?: string;
  mentions?: readonly GroupContextMentionRef[];
}

/** Two observations of one platform message version are the same content when
 * the platform body (placeholders intact) is identical and their mention
 * semantics do not conflict: both sides carry mentions → identical ordered
 * bindings (a changed or swapped target is a change even under the same
 * display names; a changed display name under the same identity is not); one
 * side carries none (a mention-less history read) → accepted. Literal `@Name`
 * prose stays part of the body. A row recorded before raw bodies existed has
 * no evidence beyond its display text, so only a byte-identical display text
 * matches it: no lossy name stripping, a conservative extra revision instead. */
export function groupContextRepresentationsMatch(left: GroupContextRepresentation, right: GroupContextRepresentation): boolean {
  const identitiesCompatible = !left.mentions?.length || !right.mentions?.length
    || sameGroupContextMentions(left.mentions, right.mentions, left.rawText, right.rawText, left.msgType ?? right.msgType);
  if (!identitiesCompatible) return false;
  if (left.rawText !== undefined && right.rawText !== undefined) return left.rawText === right.rawText;
  return left.text === right.text;
}

/** Both observations carry the same platform edit version, or one of them has
 * no version while the other proves the message was never edited
 * (update_time equal to create_time). Two unknown versions never match. */
export function sameGroupContextPlatformVersion(createTime: number, left: number | undefined, right: number | undefined): boolean {
  if (left !== undefined && right !== undefined) return left === right;
  if (left === undefined && right === undefined) return false;
  return (left ?? right) === createTime;
}
