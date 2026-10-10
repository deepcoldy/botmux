import type { OutboundMessageOptions } from '../../im/lark/client.js';
import { assertMessageTopicAvailable, TopicSendError } from '../../cli/topic-send-guard.js';
import type {
  ExecutionContextSnapshot,
  HostExecutorPolicy,
  HostExecutorPolicyRequest,
} from './runtime-host-contract.js';

/**
 * Botmux's legacy/default host policy: effects may target only the chat
 * identity frozen into the authorized run context.
 */
export const authorizeChatBoundHostExecution: HostExecutorPolicy = (
  request: HostExecutorPolicyRequest,
): void => {
  const { nodeId, executor, input, executionContext } = request;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`v3 runtime: host node "${nodeId}" parsed input is not an object`);
  }
  const context = executionContext?.context;
  if (!context) {
    throw new Error(
      `v3 runtime: host node "${nodeId}" requires an authorized chat context; ` +
      'standalone arbitrary-target host effects are not supported',
    );
  }
  const value = input as Record<string, unknown>;
  const expected: Array<[string, string | undefined]> =
    executor === 'feishu-send'
      ? [['larkAppId', context.larkAppId], ['chatId', context.chatId]]
    : executor === 'feishu-reply'
      ? [['larkAppId', context.larkAppId], ['rootMessageId', context.rootMessageId]]
    : [
        ['larkAppId', context.larkAppId],
        ['chatId', context.chatId],
        ['chatType', context.chatType],
        ...(Object.prototype.hasOwnProperty.call(value, 'rootMessageId')
          ? [['rootMessageId', context.rootMessageId] as [string, string | undefined]]
          : []),
      ];
  for (const [field, expectedValue] of expected) {
    if (!expectedValue || value[field] !== expectedValue) {
      throw new Error(
        `v3 runtime: host node "${nodeId}" ${field} does not match the authorized run context`,
      );
    }
  }
};


/** Reuse the run's already authorized, persisted identity for every IM attempt.
 * Copy primitive source values now: later context/session mutation must not
 * retarget a queued call or the reconciler's idempotent submission. */
export function chatBoundWorkflowWriteOptions(snapshot?: ExecutionContextSnapshot, operation: 'send' | 'reply' = 'send'): OutboundMessageOptions {
  const appId = snapshot?.context.larkAppId;
  const chatId = snapshot?.context.chatId;
  const rootMessageId = snapshot?.context.rootMessageId;
  return { beforeWrite: async () => {
    if (!appId || (operation === 'send' ? !chatId : !rootMessageId)) throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', '缺少已授权 workflow 的原会话依据。');
    const { getBot } = await import('../../bot-registry.js');
    if (getBot(appId).config.topicUnavailablePolicy !== 'stop' || rootMessageId === undefined) return;
    if (typeof rootMessageId !== 'string' || !rootMessageId) {
      throw new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'workflow 原话题依据无效。');
    }
    const { getMessageDetail } = await import('../../im/lark/client.js');
    await assertMessageTopicAvailable(appId, rootMessageId,
      (app, id) => getMessageDetail(app, id, { userCardContent: false, timeoutMs: 10000 }));
  } };
}
