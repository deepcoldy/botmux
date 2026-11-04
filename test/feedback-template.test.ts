import { describe, expect, it } from 'vitest';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackSurface, defaultFeedbackTemplate, validateFeedbackTemplate } from '../src/services/feedback-template.js';

describe('feedback template', () => {
  it('renders policy buttons without a separate label definition', () => {
    const policy = normalizeFeedbackPolicy({ enabled: true })!;
    policy.buttons[0].label = 'Custom verdict';
    const card = buildFeedbackSurface({ template: defaultFeedbackTemplate(), policy, round: 3, answerUrl: 'https://example.com/answer', preview: true });
    expect(JSON.stringify(card)).toContain('Custom verdict');
    expect(JSON.stringify(card)).toContain('https://example.com/answer');
    expect(JSON.stringify(card)).not.toContain('callback');
  });
  it('validates all required slots and rejects arbitrary callbacks', () => {
    const template = defaultFeedbackTemplate();
    expect(() => validateFeedbackTemplate({ ...template, elements: [{ slot: 'feedbackButtons' }] })).toThrow();
    expect(() => validateFeedbackTemplate({ ...template, elements: [...template.elements, { tag: 'button', value: { action: 'close' } }] })).toThrow();
    expect(() => validateFeedbackTemplate({ ...template, elements: [...template.elements, { slot: 'feedbackButtons' }] })).toThrow();
  });
  it('uses layout configuration without modifying the frozen policy', () => {
    const policy = normalizeFeedbackPolicy({ enabled: true })!;
    const before = structuredClone(policy);
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.map(element => element.slot === 'feedbackButtons' ? { ...element, layout: 'vertical' } : element);
    const card = buildFeedbackSurface({ template, policy, round: 1, answerUrl: 'https://example.com', preview: false });
    expect(policy).toEqual(before);
    expect(JSON.stringify(card)).toContain('feedback_submit');
  });
});
