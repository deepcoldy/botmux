import { describe, expect, it } from 'vitest';
import { normalizeFeedbackPresentation, resolveFeedbackPresentation } from '../src/services/feedback-presentation.js';

describe('feedback presentation rules', () => {
  const scope = { botAppId: 'app-example', chatId: 'chat-example', sourceMessageId: 'question-example', round: 3 };
  it('resolves question overrides without depending on rule order', () => {
    const rules = [
      { id: 'question', match: { chatId: scope.chatId, sourceMessageId: scope.sourceMessageId }, rounds: [1, 3], templateId: 'detailed' },
      { id: 'chat', match: { chatId: scope.chatId }, enabled: true, rounds: [1], mode: 'separate', templateId: 'compact', actionIds: ['help'] },
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      const config = normalizeFeedbackPresentation({ default: { enabled: false }, rules: ordered });
      expect(resolveFeedbackPresentation(config, scope)).toEqual({
        enabled: true, rounds: [1, 3], mode: 'separate', templateId: 'detailed', actionIds: ['help'],
        matched: true, ruleIds: ['chat', 'question'],
      });
    }
  });
  it('preserves disabled defaults and nonmatching rounds', () => {
    expect(resolveFeedbackPresentation(normalizeFeedbackPresentation(undefined), scope).matched).toBe(false);
    const config = normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1], templateId: 'compact' } });
    expect(resolveFeedbackPresentation(config, scope).matched).toBe(false);
    expect(resolveFeedbackPresentation(config, { ...scope, round: 1 }).matched).toBe(true);
  });
  it('supports explicit disable and replaces action lists rather than appending', () => {
    const config = normalizeFeedbackPresentation({
      default: { enabled: true, rounds: [1], templateId: 'compact', actionIds: ['help'] },
      rules: [{ id: 'disabled', match: { chatId: scope.chatId }, enabled: false, actionIds: [] }],
    });
    expect(resolveFeedbackPresentation(config, { ...scope, round: 1 })).toMatchObject({ enabled: false, matched: false, actionIds: [] });
  });
  it.each([
    { default: { rounds: [0] } },
    { default: { rounds: [1, 1] } },
    { default: { rounds: [3, 1] } },
    { default: { rounds: [] } },
    { default: { rounds: [1.2] } },
    { default: { enabled: 'false' } },
    { default: { buttons: [] } },
    { default: { actionIds: ['review.v1'] } },
    { default: { actionIds: ['review\u0000admin'] } },
    { rules: [{ id: 'bad', match: { sourceMessageId: 'question' } }] },
    { rules: [{ id: 'bad', match: { chatId: 'chat' }, mode: 'popup' }] },
    { rules: [{ id: 'a', match: { chatId: 'chat' } }, { id: 'b', match: { chatId: 'chat' } }] },
    { rules: [{ id: 'a', match: { chatId: 'chat1' } }, { id: 'a', match: { chatId: 'chat2' } }] },
  ])('rejects invalid or ambiguous rules: %j', input => {
    expect(() => normalizeFeedbackPresentation(input)).toThrow(/feedbackPresentation/);
  });
  it('does not mutate caller arrays or normalized snapshots', () => {
    const input = { default: { enabled: true, rounds: [1], templateId: 'compact' } };
    const config = normalizeFeedbackPresentation(input);
    input.default.rounds.push(5);
    const result = resolveFeedbackPresentation(config, { ...scope, round: 1 });
    result.rounds.push(8);
    expect(resolveFeedbackPresentation(config, scope).rounds).toEqual([1]);
  });
});
