export type TopicMessageLookup = (appId: string, messageId: string) => Promise<{
  items?: { message_id?: string; deleted?: boolean }[];
}>;

export class TopicSendError extends Error {
  constructor(public readonly code: 'TOPIC_SEND_BLOCKED' | 'TOPIC_SEND_CHECK_FAILED', message: string, options?: ErrorOptions) {
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

/** Opt-in protection: legacy skips lookup; stop forbids escaping an unavailable source topic. */
export async function assertSendTopicsAvailable(
  appId: string,
  roots: readonly (string | undefined | null)[],
  getMessage: TopicMessageLookup,
  policy: 'legacy' | 'stop' = 'legacy',
): Promise<void> {
  if (policy !== 'stop') return;
  for (const root of new Set(roots.filter((id): id is string => !!id))) {
    let detail;
    try {
      detail = await getMessage(appId, root);
    } catch (cause) {
      const error = cause as { name?: string; code?: unknown; response?: { data?: { code?: unknown } } };
      if (error?.name === 'MessageWithdrawnError' || (error?.response?.data?.code ?? error?.code) === 230011) {
        throw new TopicSendError('TOPIC_SEND_BLOCKED', `原话题 ${root} 已撤回，停止发送。不要重试或改发其他位置。`, { cause });
      }
      throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', `查询原话题 ${root} 失败，暂停发送。这不代表话题已失效；可重试原话题查询，不要改发顶层、跨群或新建话题。`, { cause });
    }
    const message = detail?.items?.find(item => item.message_id === root);
    if (message?.deleted === true) {
      throw new TopicSendError('TOPIC_SEND_BLOCKED', `原话题 ${root} 已撤回，停止发送。不要重试或改发顶层、跨群、新话题。`);
    }
    if (!message || message.deleted !== false) {
      throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', `原话题 ${root} 的状态无法确认，暂停发送。这不代表话题已失效；可重试原话题查询，不要改发顶层、跨群或新建话题。`);
    }
  }
}
