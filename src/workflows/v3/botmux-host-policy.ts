import type {
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
