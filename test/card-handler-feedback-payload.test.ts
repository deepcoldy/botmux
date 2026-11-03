import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { buildFeedbackElement, handleSkillFeedbackCardAction } from '../src/im/lark/skill-feedback-card.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { getSkillFeedbackStore, __testOnly_closeSkillFeedbackStores } from '../src/services/skill-feedback-store.js';

vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  getMessageDetail: vi.fn(async () => ({ items: [{ body: { content: JSON.stringify({
    schema: '2.0', body: { elements: [
      { tag: 'markdown', content: '原回答正文' },
      { tag: 'column_set', element_id: 'botmux_feedback' },
    ] },
  }) } }] })),
  resolveUserUnionId: vi.fn(async () => ({})),
}));

afterEach(__testOnly_closeSkillFeedbackStores);

const deps = { activeSessions: new Map(), lastRepoScan: new Map(), sessionReply: vi.fn() } as any;
const policy = normalizeFeedbackPolicy({ enabled: true });
const button = (buildFeedbackElement(policy) as any).columns[0].elements[0];
const value = button.behaviors[0].value;
const actionShapes = [
  ['object value', { value }],
  ['JSON string value', { value: JSON.stringify(value) }],
  ['Card 2.0 callback behavior', { behaviors: button.behaviors }],
  ['JSON string callback behavior', { behaviors: [{ type: 'callback', value: JSON.stringify(value) }] }],
] as const;

async function setup(deliveryPolicy = policy) {
  const store = await getSkillFeedbackStore(config.session.dataDir);
  const messageId = `om_${randomUUID()}`;
  const response = store.createResponse({ interactionId: messageId, content: '原回答正文' });
  const delivery = store.createDelivery({
    responseId: response.responseId, platform: 'lark', platformAppId: 'cli_test',
    platformMessageId: messageId, requesterSubjectId: 'ou_requester', policy: deliveryPolicy,
    baseCard: { schema: '2.0', body: { elements: [
      { tag: 'markdown', content: '原回答正文' },
      { tag: 'column_set', element_id: 'botmux_feedback' },
    ] } },
  });
  return { store, delivery, context: { open_message_id: messageId }, operator: { open_id: 'ou_requester' } };
}

describe('feedback payload through the public card handler', () => {
  it('routes a generated four-button policy using its frozen accurate_complete key', async () => {
    const customPolicy = normalizeFeedbackPolicy({ enabled: true, buttons: [
      { key: 'accurate_complete', label: '准确完整', semantic: 'positive', style: 'primary' },
      { key: 'accurate_partial', label: '准确但不完整', semantic: 'progress', style: 'default' },
      { key: 'incorrect', label: '结论有误', semantic: 'negative', style: 'danger' },
      { key: 'not_completed', label: '未完成', semantic: 'negative', style: 'danger' },
    ] });
    const { store, delivery, context, operator } = await setup(customPolicy);
    const generated = (buildFeedbackElement(customPolicy) as any).columns[0].elements[0];
    const result = await handleCardAction({ context, operator, action: generated }, deps, 'cli_test');
    expect(JSON.stringify(result.card.data)).toContain('已选择：**准确完整**');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toMatchObject([
      { result: 'accurate_complete', semantic: 'positive' },
    ]);
  });

  it('preserves feedback versions and form data across negative follow-up payloads', async () => {
    const customPolicy = normalizeFeedbackPolicy({ enabled: true, negativeFollowup: {
      reasons: [{ key: 'wrong_result', label: '结论错误' }], comment: { enabled: true },
    } });
    const { store, delivery, context, operator } = await setup(customPolicy);
    const negative = await handleCardAction({ context, operator, action: {
      value: JSON.stringify({ action: 'feedback_submit', result: 'incorrect' }),
    } }, deps, 'cli_test');
    expect(negative.deferredCard.type).toBe('raw');
    const reasonButton = negative.deferredCard.data.body.elements
      .find((element: any) => element.element_id === 'botmux_feedback_reasons').columns[0].elements[0];
    const reason = await handleCardAction({ context, operator, action: reasonButton }, deps, 'cli_test');
    const form = reason.card.data.body.elements.find((element: any) => element.tag === 'form');
    const submit = form.elements.find((element: any) => element.action_type === 'form_submit');
    const result = await handleCardAction({ header: { event_id: 'evt_comment' }, event: {
      context, operator, action: { value: JSON.stringify(submit.value), form_value: { comment: '补充细节' } },
    } }, deps, 'cli_test');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toMatchObject([
      { revision: 1, result: 'incorrect' },
      { revision: 2, reasonKey: 'wrong_result' },
      { revision: 3, reasonKey: 'wrong_result', comment: '补充细节' },
    ]);
    expect(JSON.stringify(result.card.data)).toContain('已补充说明');
    expect(JSON.stringify(result.card.data)).not.toContain('补充细节');
  });

  it.each(actionShapes)('records and updates a feedback click with %s', async (_name, action) => {
    const { store, delivery, context, operator } = await setup();
    const result = await handleCardAction({ context, operator, action } as any, deps, 'cli_test');
    expect(result?.card?.type).toBe('raw');
    expect(JSON.stringify(result.card.data)).toContain('原回答正文');
    expect(JSON.stringify(result.card.data)).toContain('已选择：**结论可用**');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toMatchObject([
      { result: 'conclusive_usable', revision: 1 },
    ]);
    await handleCardAction({ context, operator, action } as any, deps, 'cli_test');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toHaveLength(1);
  });

  it('accepts the complete card.action.trigger envelope without losing identity or message context', async () => {
    const { store, delivery, context, operator } = await setup();
    const result = await handleCardAction({
      schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'evt_feedback' },
      event: { context, operator, action: { tag: 'button', value: JSON.stringify(value) } },
    } as any, deps, 'cli_test');
    expect(result?.card?.type).toBe('raw');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toHaveLength(1);
  });

  it('keeps requester authorization when identity fields are supplied in a callback value', async () => {
    const { store, delivery, context } = await setup();
    const result = await handleCardAction({ context, operator: { open_id: 'ou_other' }, action: {
      behaviors: [{ type: 'callback', value: { ...value, open_id: 'ou_requester', operator: { open_id: 'ou_requester' } } }],
    } } as any, deps, 'cli_test');
    expect(result?.toast?.content).toBe('仅本次提问者可反馈');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toHaveLength(0);
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_other')).toHaveLength(0);
  });

  it('normalizes the direct feedback handler as well as the shared entry point', async () => {
    const { store, delivery, context, operator } = await setup();
    const result = await handleSkillFeedbackCardAction({ context, operator, action: {
      value: JSON.stringify(value),
    } } as any, 'cli_test', { store });
    expect(result?.card?.type).toBe('raw');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_requester')).toHaveLength(1);
  });
});
