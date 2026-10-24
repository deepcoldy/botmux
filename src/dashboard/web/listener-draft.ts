import { resolveExcludeSenderKinds } from './listener-filters.js';
import { mergeListenerContentPolicy, type MessageListenerData } from './roles.js';

// Pure draft mutations + save normalization for the message-listener editor.
//
// MessageListenerEditor reports PARTIAL policy patches (e.g. only
// `{ excludeSelf }` or only `{ matchMode }`). They must be merged into the
// current draft: replacing the whole policy object silently drops the sender
// allow-list / sender types or the keyword list, and the backend reads those
// absences as "match everyone" — widening the listener on every group that
// inherits it.

type SenderPolicy = NonNullable<MessageListenerData['senderPolicy']>;
type MessagePolicy = NonNullable<MessageListenerData['messagePolicy']>;
type ContentPolicy = NonNullable<MessageListenerData['contentPolicy']>;
type SenderType = 'user' | 'bot';

export function patchListenerSenderPolicy(prev: MessageListenerData, patch: SenderPolicy): MessageListenerData {
  return { ...prev, senderPolicy: { ...(prev.senderPolicy ?? {}), ...patch } };
}

export function patchListenerMessagePolicy(prev: MessageListenerData, patch: MessagePolicy): MessageListenerData {
  return { ...prev, messagePolicy: { ...(prev.messagePolicy ?? {}), ...patch, scope: 'top_level' } };
}

export function patchListenerContentPolicy(prev: MessageListenerData, patch: ContentPolicy): MessageListenerData {
  return { ...prev, contentPolicy: mergeListenerContentPolicy(prev.contentPolicy, patch) };
}

// An empty type list is persisted as "no restriction" (all types), so the last
// checked type cannot be unchecked — that would flip "users only" into
// "users and bots".
export function toggleListenerSenderType(prev: MessageListenerData, type: SenderType, checked: boolean): MessageListenerData {
  const current = new Set(prev.senderPolicy?.includeSenderTypes ?? []);
  if (checked) current.add(type);
  else {
    if (current.size <= 1 && current.has(type)) return prev;
    current.delete(type);
  }
  return patchListenerSenderPolicy(prev, { includeSenderTypes: [...current] });
}

export function toggleListenerMsgType(prev: MessageListenerData, msgType: string, checked: boolean): MessageListenerData {
  const current = new Set(prev.messagePolicy?.includeMsgTypes ?? []);
  if (checked) current.add(msgType);
  else {
    if (current.size <= 1 && current.has(msgType)) return prev;
    current.delete(msgType);
  }
  return patchListenerMessagePolicy(prev, { includeMsgTypes: [...current] });
}

/**
 * The request body for save / preview / run-preview, so a preview can never
 * evaluate a different rule than the one that gets saved.
 *
 * Records the sender KIND of every excluded open_id (live roster first, then
 * the already-persisted kind — see resolveExcludeSenderKinds): without it the
 * runtime treats each exclusion as maybe-a-bot and fail-closes every
 * unverified third-party bot, which is exactly what all_except_excluded mode
 * exists to listen to.
 */
export function buildListenerSavePayload(
  listener: MessageListenerData,
  liveKindOf: (openId: string) => 'user' | 'bot' | 'unknown' | undefined,
): MessageListenerData {
  const senderPolicy = listener.senderPolicy ?? {};
  const messagePolicy = listener.messagePolicy ?? {};
  const mode = senderPolicy.mode === 'all_except_excluded' ? 'all_except_excluded' : 'include_only';
  const includeSenderOpenIds = [...new Set(senderPolicy.includeSenderOpenIds ?? [])].filter(Boolean);
  const excludeSenderOpenIds = [...new Set(senderPolicy.excludeSenderOpenIds ?? [])].filter(Boolean);
  const excludeSenderKinds = resolveExcludeSenderKinds(excludeSenderOpenIds, liveKindOf, senderPolicy.excludeSenderKinds);
  const includeSenderTypes = [...new Set(senderPolicy.includeSenderTypes ?? [])].filter((type): type is SenderType => type === 'user' || type === 'bot');
  // Not editable in the dashboard, but honored at runtime (e.g. hand-written in
  // bots.json): round-trip it so saving another field cannot drop an exclusion.
  const excludeSenderTypes = [...new Set(senderPolicy.excludeSenderTypes ?? [])].filter((type): type is SenderType => type === 'user' || type === 'bot');
  const includeMsgTypes = [...new Set(messagePolicy.includeMsgTypes ?? [])].filter(Boolean);
  // An all-empty keyword list is omitted so the listener keeps matching every
  // message (the legacy default) instead of persisting a dangling matchMode.
  const contentPolicy = (() => {
    const raw = listener.contentPolicy;
    if (!raw) return undefined;
    const includeKeywords = [...new Set((raw.includeKeywords ?? []).map(value => value.trim()).filter(Boolean))];
    if (includeKeywords.length === 0) return undefined;
    return {
      includeKeywords,
      ...(raw.matchMode === 'all' ? { matchMode: 'all' as const } : {}),
      ...(raw.resolveDocumentTitles === true ? { resolveDocumentTitles: true } : {}),
    };
  })();
  return {
    enabled: listener.enabled,
    // The daemon keeps this opt-in only when it is true; leaving it out of the
    // body would switch it off on every save.
    ...(listener.autoCloseAfterCompletion === true ? { autoCloseAfterCompletion: true } : {}),
    ...(listener.name?.trim() ? { name: listener.name.trim() } : {}),
    ...(listener.replyCardTitle?.trim() ? { replyCardTitle: listener.replyCardTitle.trim() } : {}),
    ...(listener.workingDir?.trim() ? { workingDir: listener.workingDir.trim() } : {}),
    prompt: listener.prompt.trim(),
    senderPolicy: {
      mode,
      // Persist ONLY the list relevant to the active mode so a later mode
      // switch never resurrects stale open_ids from the other list.
      ...(mode === 'include_only' && includeSenderOpenIds.length > 0 ? { includeSenderOpenIds } : {}),
      ...(mode === 'all_except_excluded' && excludeSenderOpenIds.length > 0 ? { excludeSenderOpenIds } : {}),
      ...(mode === 'all_except_excluded' && Object.keys(excludeSenderKinds).length > 0 ? { excludeSenderKinds } : {}),
      ...(includeSenderTypes.length > 0 ? { includeSenderTypes } : {}),
      ...(excludeSenderTypes.length > 0 ? { excludeSenderTypes } : {}),
      excludeSelf: senderPolicy.excludeSelf !== false,
    },
    messagePolicy: {
      ...(includeMsgTypes.length > 0 ? { includeMsgTypes } : {}),
      scope: 'top_level',
    },
    ...(contentPolicy ? { contentPolicy } : {}),
    replyPolicy: { mode: listener.replyPolicy?.mode === 'chat' ? 'chat' : 'thread', sessionMode: 'per_message' },
  };
}

/**
 * Identity of a draft for unsaved-change checks: the normalized body minus the
 * derived sender kinds (filled in from the roster at save time, so a freshly
 * saved draft and its reloaded copy would otherwise never compare equal).
 */
export function listenerDraftKey(listener: MessageListenerData): string {
  const payload = buildListenerSavePayload(listener, () => undefined);
  const { excludeSenderKinds: _kinds, ...senderPolicy } = payload.senderPolicy ?? {};
  return JSON.stringify({ ...payload, senderPolicy });
}

export type ListenerWidening =
  | 'enable'
  | 'allSenders'
  | 'moreSenders'
  | 'senderTypes'
  | 'includeSelf'
  | 'msgTypes'
  | 'keywords'
  | 'replyChat';

const ALL_SENDER_TYPES: readonly SenderType[] = ['user', 'bot'];

function added(before: readonly string[], after: readonly string[]): boolean {
  const known = new Set(before);
  return after.some(value => !known.has(value));
}

// Keywords match case-insensitively: "any" fires on one hit, "all" needs every
// keyword. Compared as sets, the new filter lets through more messages when:
//   any → any: a keyword was added      all → all: a keyword was dropped
//   all → any: always                   any → all: no keyword in common
function keywordFilterWidened(before: ContentPolicy | undefined, after: ContentPolicy | undefined): boolean {
  if (!before) return false;
  if (!after) return true;
  if (!before.resolveDocumentTitles && after.resolveDocumentTitles) return true;
  const lower = (list: readonly string[] | undefined) => (list ?? []).map(value => value.toLowerCase());
  const b = lower(before.includeKeywords);
  const a = lower(after.includeKeywords);
  const bAll = before.matchMode === 'all';
  const aAll = after.matchMode === 'all';
  if (bAll && !aAll) return true;
  if (!bAll && !aAll) return added(b, a);
  if (bAll && aAll) return added(a, b);
  return !a.some(keyword => b.includes(keyword));
}

/**
 * How saving `after` over `before` makes the rule fire on more messages (or
 * reply more visibly). Empty when the change only narrows, rewords, or the rule
 * ends up disabled — those need no "affects N groups" confirmation.
 */
export function describeListenerWidening(
  before: MessageListenerData,
  after: MessageListenerData,
  allMsgTypes: readonly string[],
): ListenerWidening[] {
  const b = buildListenerSavePayload(before, () => undefined);
  const a = buildListenerSavePayload(after, () => undefined);
  if (!a.enabled) return [];
  if (!b.enabled) return ['enable'];
  const reasons = new Set<ListenerWidening>();
  const bs = b.senderPolicy ?? {};
  const as = a.senderPolicy ?? {};
  if (bs.mode === 'include_only' && as.mode === 'all_except_excluded') reasons.add('allSenders');
  else if (as.mode === 'include_only' && added(bs.includeSenderOpenIds ?? [], as.includeSenderOpenIds ?? [])) reasons.add('moreSenders');
  else if (as.mode === 'all_except_excluded' && added(as.excludeSenderOpenIds ?? [], bs.excludeSenderOpenIds ?? [])) reasons.add('moreSenders');
  // An absent type list means every type.
  const typesOf = (list: readonly SenderType[] | undefined) => (list?.length ? list : ALL_SENDER_TYPES);
  if (added(typesOf(bs.includeSenderTypes), typesOf(as.includeSenderTypes))
    || added(as.excludeSenderTypes ?? [], bs.excludeSenderTypes ?? [])) reasons.add('senderTypes');
  if (bs.excludeSelf !== false && as.excludeSelf === false) reasons.add('includeSelf');
  const msgTypesOf = (list: readonly string[] | undefined) => (list?.length ? list : allMsgTypes);
  if (added(msgTypesOf(b.messagePolicy?.includeMsgTypes), msgTypesOf(a.messagePolicy?.includeMsgTypes))) reasons.add('msgTypes');
  if (keywordFilterWidened(b.contentPolicy, a.contentPolicy)) reasons.add('keywords');
  if (b.replyPolicy?.mode !== 'chat' && a.replyPolicy?.mode === 'chat') reasons.add('replyChat');
  return [...reasons];
}
