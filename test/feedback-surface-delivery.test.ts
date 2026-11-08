import { describe, expect, it } from 'vitest';
import { surfaceFeedbackStore } from '../src/services/feedback-surface-delivery.js';
import type { CompatibleFeedbackStore } from '../src/services/feedback-storage-types.js';

describe('surface feedback mapping', () => {
  it('maps a feedback surface to its original answer without inventing another delivery', async () => {
    const observed: string[] = [];
    const store = {
      findDeliveryByPlatformMessage: async (_platform: string, _app: string, messageId: string) => {
        observed.push(messageId);
        return { deliveryId: 'original', platformMessageId: messageId };
      },
      recordFeedback: async (input: { platformMessageId: string }) => { observed.push(input.platformMessageId); return { status: 'accepted' }; },
    } as unknown as CompatibleFeedbackStore;
    const mapped = surfaceFeedbackStore(store, { appId: 'app', surfaceMessageId: 'surface', answerMessageId: 'answer', card: { schema: '2.0' } });
    expect(await mapped.findDeliveryByPlatformMessage('lark', 'app', 'surface')).toMatchObject({ deliveryId: 'original' });
    await mapped.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'surface', operatorSubjectId: 'operator', result: 'positive', callbackKey: 'click' });
    expect(observed).toEqual(['answer', 'answer']);
  });
});
