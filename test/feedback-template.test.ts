import { describe, expect, it } from 'vitest';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildFeedbackSurface, defaultFeedbackTemplate, validateFeedbackTemplate } from '../src/services/feedback-template.js';
import { renderFeedbackSurfaceState } from '../src/services/feedback-surface-delivery.js';

describe('feedback template', () => {
  it('renders without a reference and preserves feedback controls after an update', () => {
    const policy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true })!;
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.filter(element => element.slot !== 'answerReference');
    const card = buildFeedbackSurface({ template, policy, round: 1, answerUrl: 'https://example.com/answer',
      preview: false, actions: [{ id: 'help', label: 'Help' }] });
    const updated = renderFeedbackSurfaceState({ template, answerUrl: 'https://example.com/answer',
      round: 1, actions: [{ id: 'help', label: 'Help' }], card }, policy, { result: policy.buttons[2].key });
    expect(JSON.stringify(updated)).not.toContain('https://example.com/answer');
    expect(JSON.stringify(updated)).toContain('feedback_submit');
    expect(JSON.stringify(updated)).toContain('feedback_custom_action');
  });
  it('uses custom reference text and fixed variables in previews and feedback updates', () => {
    const policy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true })!;
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.map(element => element.slot === 'answerReference'
      ? { ...element, content: 'Answer {round}: [Read]({answerUrl})' } : element);
    const answerUrl = 'https://example.com/answer(3)';
    for (const preview of [true, false]) {
      const card = buildFeedbackSurface({ template, policy, round: 3, answerUrl, preview });
      const updated = renderFeedbackSurfaceState({ template, answerUrl, round: 3, actions: [], card },
        policy, { result: policy.buttons[2].key });
      expect((card.body as any).elements[0].content).toBe('Answer 3: [Read](https://example.com/answer%283%29)');
      expect((updated.body as any).elements[0].content).toBe('Answer 3: [Read](https://example.com/answer%283%29)');
    }
  });
  it.each([
    ['mention', '<at id=all>all</at>'], ['image', '![image](https://example.com/a)'],
    ['variable', '{unknown}'], ['oversized', 'a'.repeat(4001)],
  ])('rejects %s reference content', (_name, content) => {
      const template = defaultFeedbackTemplate();
      template.elements = template.elements.map(element => element.slot === 'answerReference' ? { ...element, content } : element);
      expect(() => validateFeedbackTemplate(template)).toThrow();
    });
  it.each(['feedbackButtons', 'feedbackDetails', 'status', 'actionButtons'])(
    'rejects content attached to the non-reference %s slot', slot => {
      const template = defaultFeedbackTemplate();
      template.elements = template.elements.map(element => element.slot === slot ? { ...element, content: 'not allowed' } : element);
      expect(() => validateFeedbackTemplate(template)).toThrow('feedback_template_reference_invalid');
    });
  it.each([
    ['number', 123], ['array', ['text']], ['object', { text: 'x' }], ['boolean', true], ['nullish', null],
  ] as [string, unknown][])(
    'rejects non-string reference content: %s', (_name, content) => {
      const template = defaultFeedbackTemplate();
      template.elements = template.elements.map(element => element.slot === 'answerReference'
        ? { ...element, content: content as any } : element);
      expect(() => validateFeedbackTemplate(template)).toThrow('feedback_template_reference_invalid');
    });
  it.each(['Review this answer', ''])('renders literal reference content without adding a default link: %s', content => {
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.map(element => element.slot === 'answerReference' ? { ...element, content } : element);
    const card = buildFeedbackSurface({ template, policy: normalizeFeedbackPolicy({ enabled: true }), round: 2,
      answerUrl: 'https://example.com/answer', preview: false });
    expect(JSON.stringify(card)).not.toContain('https://example.com/answer');
    expect((card.body as any).elements.some((element: any) => element.content === 'Review this answer')).toBe(!!content);
  });
  it.each(['', '   ', '\n\t '])('omits the reference element when its content is blank: %s', content => {
    const template = defaultFeedbackTemplate();
    template.elements = template.elements.map(element => element.slot === 'answerReference' ? { ...element, content } : element);
    const card = buildFeedbackSurface({ template, policy: normalizeFeedbackPolicy({ enabled: true }), round: 1,
      answerUrl: 'https://example.com/answer', preview: false });
    const markdown = (card.body as any).elements.filter((element: any) => element.tag === 'markdown');
    expect(markdown).toHaveLength(1);
    expect(markdown[0].content).toBe(' ');
    expect((card.body as any).elements.some((element: any) => element.content === content)).toBe(false);
  });
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
