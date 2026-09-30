/** Opt-in protection: legacy skips lookup; stop forbids escaping an unavailable source topic. */
export async function assertSendTopicsAvailable(
  appId: string,
  roots: readonly (string | undefined | null)[],
  getMessage: (appId: string, messageId: string) => Promise<{ items?: { message_id?: string; deleted?: boolean }[] }>,
  policy: 'legacy' | 'stop' = 'legacy',
): Promise<void> {
  if (policy !== 'stop') return;
  for (const root of new Set(roots.filter((id): id is string => !!id))) {
    let detail;
    try {
      detail = await getMessage(appId, root);
    } catch (cause) {
      throw new Error(`TOPIC_SEND_CHECK_FAILED: 查询原话题 ${root} 失败，暂停发送。这不代表话题已失效；可重试原话题查询，不要改发顶层、跨群或新建话题。`, { cause });
    }
    const message = detail?.items?.find(item => item.message_id === root);
    if (message?.deleted === true) {
      throw new Error(`TOPIC_SEND_BLOCKED: 原话题 ${root} 已撤回，停止发送。不要重试或改发顶层、跨群、新话题。`);
    }
    if (!message || message.deleted !== false) {
      throw new Error(`TOPIC_SEND_CHECK_FAILED: 原话题 ${root} 的状态无法确认，暂停发送。这不代表话题已失效；可重试原话题查询，不要改发顶层、跨群或新建话题。`);
    }
  }
}
