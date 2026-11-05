import { describe, expect, it } from 'vitest';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackSurface, defaultFeedbackTemplate, validateFeedbackTemplate } from '../src/services/feedback-template.js';
import { renderFeedbackSurfaceState } from '../src/services/feedback-surface-delivery.js';

describe('feedback template', () => {
  it('allows a ratings-only template but requires an action slot when actions are rendered', () => {
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.filter(element => element.slot !== 'actionButtons');
    expect(() => validateFeedbackTemplate(template)).not.toThrow();
    expect(() => buildFeedbackSurface({ template, policy: normalizeFeedbackPolicy({ enabled: true }), round: 1,
      answerUrl: 'https://example.com', preview: true, actions: [{ id: 'help', label: 'Help' }] })).toThrow('action_slot');
  });
  it('restores arbitrary feedback-details placement from the template snapshot', () => {
    const policy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true })!;
    const template = defaultFeedbackTemplate();
    template.elements = [{ slot: 'status' }, { slot: 'feedbackDetails' }, { tag: 'markdown', content: 'middle' },
      { slot: 'answerReference' }, { slot: 'actionButtons' }, { slot: 'feedbackButtons', layout: 'vertical' }];
    const binding = { template, answerUrl: 'https://example.com/answer', round: 1, actions: [],
      card: buildFeedbackSurface({ template, policy, round: 1, answerUrl: 'https://example.com/answer', preview: false }) };
    const card = renderFeedbackSurfaceState(binding, policy, { result: policy.buttons[2].key });
    const elements = (card.body as any).elements;
    expect(elements.findIndex((element: any) => element.element_id === 'botmux_feedback_status')).toBeLessThan(
      elements.findIndex((element: any) => element.content === 'middle'));
    expect(elements.at(-1).columns).toHaveLength(1);
  });
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
