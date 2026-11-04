import type { CompatibleFeedbackStore } from './feedback-storage-types.js';

export function surfaceFeedbackStore(store: CompatibleFeedbackStore, binding: {
  appId: string; surfaceMessageId: string; answerMessageId: string; card: Record<string, unknown>;
}): CompatibleFeedbackStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'findDeliveryByPlatformMessage') return async (platform: string, appId: string, messageId: string) => {
        const mapped = platform === 'lark' && appId === binding.appId && messageId === binding.surfaceMessageId;
        const delivery = await target.findDeliveryByPlatformMessage(platform, appId, mapped ? binding.answerMessageId : messageId);
        return mapped && delivery ? { ...delivery, baseCard: binding.card } : delivery;
      };
      if (property === 'recordFeedback') return (input: Parameters<CompatibleFeedbackStore['recordFeedback']>[0]) => target.recordFeedback({
        ...input, platformMessageId: input.platform === 'lark' && input.platformAppId === binding.appId
          && input.platformMessageId === binding.surfaceMessageId ? binding.answerMessageId : input.platformMessageId,
      });
      const method = Reflect.get(target, property);
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
}
