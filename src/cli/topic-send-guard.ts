export interface TopicMessageDetail {
  items?: { message_id?: string; deleted?: boolean; root_id?: string }[];
}

export type TopicMessageLookup = (appId: string, messageId: string) => Promise<TopicMessageDetail>;

export class TopicSendError extends Error {
  constructor(readonly code: 'TOPIC_SEND_BLOCKED' | 'TOPIC_SEND_CHECK_FAILED', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'TopicSendError';
  }
}

/** One delivery owns this cache; failed/unknown/deleted lookups are never cached. */
export function createTopicMessageLookupCache(getMessage: TopicMessageLookup, ttlMs = 1000) {
  const cache = new Map<string, { at: number; detail: Awaited<ReturnType<TopicMessageLookup>> }>();
  return {
    clear: () => cache.clear(),
    lookup: async (appId: string, root: string) => {
      const key = JSON.stringify([appId, root]);
      const prior = cache.get(key);
      if (prior && Date.now() - prior.at < ttlMs) return prior.detail;
      const detail = await getMessage(appId, root);
      if (detail?.items?.find(item => item.message_id === root)?.deleted === false) {
        cache.set(key, { at: Date.now(), detail });
      } else cache.delete(key);
      return detail;
    },
  };
}

/** Opt-in protection: legacy skips lookup; stop never changes the destination. */
export async function assertSendTopicsAvailable(
  appId: string,
  roots: readonly (string | undefined | null)[],
  getMessage: (appId: string, messageId: string) => Promise<TopicMessageDetail>,
  policy: 'legacy' | 'stop' = 'legacy',
): Promise<void> {
  if (policy !== 'stop') return;
  for (const root of new Set(roots.filter((id): id is string => !!id))) {
    await assertMessageTopicAvailable(appId, root, getMessage);
  }
}

async function readAvailableMessage(
  appId: string, messageId: string,
  getMessage: (appId: string, messageId: string) => Promise<TopicMessageDetail>,
) {
  let detail: TopicMessageDetail;
  try { detail = await getMessage(appId, messageId); }
  catch (cause) {
    const error = cause as { name?: string; code?: unknown; response?: { data?: { code?: unknown } } };
    if (error?.name === 'MessageWithdrawnError' || (error?.response?.data?.code ?? error?.code) === 230011) {
      throw new TopicSendError('TOPIC_SEND_BLOCKED', `原话题 ${messageId} 已撤回，停止发送。不要重试或改发其他位置。`, { cause });
    }
    throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', `查询原话题 ${messageId} 失败，暂停发送；不要改发顶层、跨群或新建话题。`, { cause });
  }
  const matches = detail?.items?.filter(item => item.message_id === messageId) ?? [];
  const message = matches.length === 1 ? matches[0] : undefined;
  if (message?.deleted === true) {
    throw new TopicSendError('TOPIC_SEND_BLOCKED', `原话题 ${messageId} 已撤回，停止发送；不要改发顶层、跨群或新建话题。`);
  }
  if (!message || message.deleted !== false) {
    throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', `原话题 ${messageId} 的状态无法确认，暂停发送；不要更换目标。`);
  }
  return message;
}

/** A PATCH/CardKit target can survive its withdrawn root. Verify both using
 * fresh provider data; never cache an available result across queued writes. */
export async function assertMessageTopicAvailable(
  appId: string, messageId: string | undefined,
  getMessage: (appId: string, messageId: string) => Promise<TopicMessageDetail>,
): Promise<void> {
  if (!messageId) throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', '缺少原消息依据，暂停发送。');
  const message = await readAvailableMessage(appId, messageId, getMessage);
  if (message.root_id != null && typeof message.root_id !== 'string') {
    throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', '原话题身份无法确认，暂停发送。');
  }
  if (message.root_id && message.root_id !== messageId) {
    await readAvailableMessage(appId, message.root_id, getMessage);
  }
}
