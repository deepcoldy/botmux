import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSkillFeedbackCardAction } from '../src/im/lark/skill-feedback-card.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('skill feedback callback trust boundary', () => {
  it('looks up delivery by verified message, app and operator, ignoring forged identities and ids in action.value', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_real', content: 'answer' });
    const delivery = store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_test', platformMessageId: 'om_real', level: 'L0' });

    const result = await handleSkillFeedbackCardAction({
      context: { open_message_id: 'om_real' },
      operator: { open_id: 'ou_real', union_id: 'on_real' },
      action: { value: {
        action: 'skill_feedback_submit', result: 'helpful',
        delivery_id: 'del_forged', session_id: 'sid_forged', open_id: 'ou_forged', union_id: 'on_forged',
      } },
    }, 'app_test', { store });

    expect(result.toast.type).toBe('success');
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'on_real')).toHaveLength(1);
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'on_forged')).toHaveLength(0);
    store.close();
  });

  it('fails closed without verified platform message or operator identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const result = await handleSkillFeedbackCardAction({
      action: { value: { action: 'skill_feedback_submit', result: 'usable', delivery_id: 'forged' } },
    }, 'app_test', { store });
    expect(result.toast.type).toBe('error');
    store.close();
  });

  it('rejects results outside the delivery level and arbitrary reasons', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_invalid', content: 'answer' });
    const delivery = store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_test', platformMessageId: 'om_invalid', level: 'L0' });
    for (const value of [{ result: 'completed' }, { result: 'helpful', reason_key: 'forged' }]) {
      const result = await handleSkillFeedbackCardAction({
        context: { open_message_id: 'om_invalid' }, operator: { open_id: 'ou_real', union_id: 'on_real' },
        action: { value: { action: 'skill_feedback_submit', ...value } },
      }, 'app_test', { store });
      expect(result.toast.type).toBe('error');
    }
    expect(store.listFeedbackRevisions(delivery.deliveryId, 'on_real')).toHaveLength(0);
    store.close();
  });

  it('fails closed on malformed verified union id and cross-app message collision', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_closed', content: 'answer' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same', level: 'L0' });
    const malformed = await handleSkillFeedbackCardAction({
      context: { open_message_id: 'om_same' }, operator: { open_id: 'ou_real', union_id: 'bad' },
      action: { value: { action: 'skill_feedback_submit', result: 'helpful' } },
    }, 'app_a', { store });
    const crossApp = await handleSkillFeedbackCardAction({
      context: { open_message_id: 'om_same' }, operator: { open_id: 'ou_real', union_id: 'on_real' },
      action: { value: { action: 'skill_feedback_submit', result: 'helpful' } },
    }, 'app_b', { store });
    expect(malformed.toast.type).toBe('error');
    expect(crossApp.toast.type).toBe('error');
    store.close();
  });
});
