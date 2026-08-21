import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSkillFeedbackCardAction } from '../src/im/lark/skill-feedback-card.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

async function setup(overrides: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-')); dirs.push(dataDir);
  const store = await SkillFeedbackStore.open(dataDir);
  const policy = normalizeFeedbackPolicy({ enabled: true, negativeFollowup: { reasons: [{ key: 'wrong_result', label: '结论错误' }], comment: { enabled: true, ...overrides } } });
  const response = store.createResponse({ interactionId: 'int', content: 'answer' });
  const baseCard = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer' }, { tag: 'column_set', element_id: 'botmux_feedback' }] } };
  const delivery = store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'om', policy, baseCard, requesterSubjectId: 'ou_user' });
  return { store, delivery };
}

function event(action: Record<string, unknown>, operator = 'ou_user', formValue?: unknown, unionId?: string) {
  return { context: { open_message_id: 'om' }, operator: { open_id: operator, ...(unionId ? { union_id: unionId } : {}) }, action: { value: action, form_value: formValue } } as any;
}

describe('feedback callback state machine', () => {
  it('rebuilds a callback card from the platform card while the persisted template contains no answer', async () => {
    const { store } = await setup();
    const delivery = store.findDeliveryByPlatformMessage('lark', 'app', 'om')!;
    expect(JSON.stringify(delivery.baseCard)).not.toContain('answer');
    const platformCard = { schema: '2.0', body: { elements: [
      { tag: 'markdown', content: 'answer from platform' },
      { tag: 'column_set', element_id: 'botmux_feedback' },
    ] } };
    const result = await handleSkillFeedbackCardAction(
      event({ action: 'feedback_submit', result: 'conclusive_usable' }),
      'app',
      { store, loadBaseCard: async () => platformCard },
    );
    expect(JSON.stringify(result.card.data)).toContain('answer from platform');
    expect(JSON.stringify(result.card.data)).toContain('已选择：**结论可用**');
    store.close();
  });

  it('falls back to the content-free template when the platform card cannot be fetched', async () => {
    const { store } = await setup();
    const result = await handleSkillFeedbackCardAction(
      event({ action: 'feedback_submit', result: 'conclusive_usable' }),
      'app',
      { store, loadBaseCard: async () => { throw new Error('platform unavailable'); } },
    );
    expect(JSON.stringify(result.card.data)).toContain('已选择：**结论可用**');
    expect(JSON.stringify(result.card.data)).not.toContain('answer');
    store.close();
  });

  it('records a negative primary choice and defers the complex card update', async () => {
    const { store, delivery } = await setup();
    const result = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'incorrect' }), 'app', { store });
    expect(result.toast).toBeUndefined();
    expect(result.card).toBeUndefined();
    expect(result.deferredCard).toMatchObject({ type: 'raw' });
    expect(JSON.stringify(result.deferredCard.data)).toContain('结论错误');
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ result: 'incorrect' });
    store.close();
  });

  it('accepts the requester when delivery stores open_id but the callback also carries a union_id', async () => {
    const { store, delivery } = await setup();
    const result = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }, 'ou_user', undefined, 'on_user'), 'app', { store });
    expect(result.card).toMatchObject({ type: 'raw' });
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ result: 'conclusive_usable' });
    expect(store.getLatestFeedback(delivery.deliveryId, 'on_user')).toBeUndefined();
    store.close();
  });

  it('rejects non-requesters and forged result/reason without mutation', async () => {
    const { store, delivery } = await setup();
    for (const input of [
      event({ action: 'feedback_submit', result: 'conclusive_usable' }, 'on_other'),
      event({ action: 'feedback_submit', result: 'forged' }),
      event({ action: 'feedback_reason', reason_key: 'forged' }),
    ]) expect((await handleSkillFeedbackCardAction(input, 'app', { store })).toast.type).toBe('error');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_user')).toHaveLength(0);
    store.close();
  });

  it('records reason against latest negative result and renders selection', async () => {
    const { store, delivery } = await setup();
    await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'incorrect' }), 'app', { store });
    const result = await handleSkillFeedbackCardAction(event({ action: 'feedback_reason', reason_key: 'wrong_result' }), 'app', { store });
    expect(JSON.stringify(result.card.data)).toContain('✓ 结论错误');
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ result: 'incorrect', reasonKey: 'wrong_result' });
    store.close();
  });

  it('validates required comments and never coerces non-string values', async () => {
    const { store, delivery } = await setup({ required: true, maxLength: 5 });
    await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'incorrect' }), 'app', { store });
    for (const value of [{ comment: '   ' }, { comment: {} }, { comment: '123456' }]) {
      const result = await handleSkillFeedbackCardAction(event({ action: 'feedback_comment' }, 'ou_user', value), 'app', { store });
      expect(result.toast.type).toBe('warning');
    }
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'ou_user')).toHaveLength(1);
    const ok = await handleSkillFeedbackCardAction(event({ action: 'feedback_comment' }, 'ou_user', { comment: ' ok ' }), 'app', { store });
    expect(JSON.stringify(ok.card.data)).toContain('已补充说明');
    expect(JSON.stringify(ok.card.data)).not.toContain('ok');
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ comment: 'ok' });
    store.close();
  });

  it('keeps the first primary choice when re-selection is disabled by default', async () => {
    const { store, delivery } = await setup();
    const first = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }), 'app', { store });
    const second = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'incorrect' }), 'app', { store });
    expect(JSON.stringify(first.card.data)).toContain('已选择：**结论可用**');
    expect(second).toEqual(first);
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ result: 'conclusive_usable', revision: 1 });
    store.close();
  });

  it('allows changing away and back only when re-selection is configured', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-')); dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const policy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true });
    const response = store.createResponse({ interactionId: 'int-reselect', content: 'answer' });
    const baseCard = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer' }, { tag: 'column_set', element_id: 'botmux_feedback' }] } };
    const delivery = store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'om', policy, baseCard, requesterSubjectId: 'ou_user' });
    await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }), 'app', { store });
    await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'incorrect' }), 'app', { store });
    const back = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }), 'app', { store });
    expect(JSON.stringify(back.card.data)).toContain('已选择：**结论可用**');
    expect(store.getLatestFeedback(delivery.deliveryId, 'ou_user')).toMatchObject({ result: 'conclusive_usable', revision: 3 });
    store.close();
  });

  it('returns a stable card for duplicate callbacks', async () => {
    const { store } = await setup();
    const first = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }), 'app', { store });
    const duplicate = await handleSkillFeedbackCardAction(event({ action: 'feedback_submit', result: 'conclusive_usable' }), 'app', { store });
    expect(duplicate).toEqual(first);
    store.close();
  });
});
