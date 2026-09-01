import { describe, expect, it } from 'bun:test';
import { normalizeFeedbackPolicy, resolveFeedbackPolicy } from '../src/services/feedback-policy.js';

describe('feedback policy', () => {
  it('is disabled when absent or not explicitly enabled', () => {
    expect(resolveFeedbackPolicy(undefined)).toBeUndefined();
    expect(resolveFeedbackPolicy({ enabled: false })).toBeUndefined();
  });

  it('normalizes enabled policy with product defaults', () => {
    expect(normalizeFeedbackPolicy({ enabled: true })).toEqual({
      enabled: true,
      audience: 'requester',
      allowReselect: false,
      visibleSemantics: ['positive', 'progress', 'negative'],
      buttons: [
        { key: 'conclusive_usable', label: '结论可用', semantic: 'positive', style: 'primary' },
        { key: 'effective_progress', label: '有效推进', semantic: 'progress', style: 'default' },
        { key: 'incorrect', label: '结论有误', semantic: 'negative', style: 'danger' },
      ],
      negativeFollowup: {
        reasons: [],
        comment: { enabled: true, required: false, placeholder: '可以补充哪里需要改进', maxLength: 1000 },
      },
    });
  });

  it('defaults re-selection off and enables it only explicitly', () => {
    expect(normalizeFeedbackPolicy({ enabled: true }).allowReselect).toBe(false);
    expect(normalizeFeedbackPolicy({ enabled: true, allowReselect: true }).allowReselect).toBe(true);
  });

  it('preserves valid custom buttons and negative follow-up', () => {
    expect(normalizeFeedbackPolicy({
      enabled: true,
      buttons: [
        { key: 'yes', label: '解决了', semantic: 'positive' },
        { key: 'partial', label: '有进展', semantic: 'progress' },
        { key: 'no', label: '没解决', semantic: 'negative', style: 'danger' },
      ],
      negativeFollowup: {
        reasons: [{ key: 'missing_context', label: '缺少关键信息' }],
        comment: { enabled: true, required: true, placeholder: '请说明', maxLength: 1200 },
      },
    })).toMatchObject({
      buttons: [
        { key: 'yes', label: '解决了', semantic: 'positive', style: 'primary' },
        { key: 'partial', label: '有进展', semantic: 'progress', style: 'default' },
        { key: 'no', label: '没解决', semantic: 'negative', style: 'danger' },
      ],
      negativeFollowup: {
        reasons: [{ key: 'missing_context', label: '缺少关键信息' }],
        comment: { enabled: true, required: true, placeholder: '请说明', maxLength: 1200 },
      },
    });
  });

  it('migrates legacy sentiment input but emits only semantic', () => {
    const policy = normalizeFeedbackPolicy({
      enabled: true,
      visibleSemantics: ['positive', 'negative'],
      buttons: [
        { key: 'yes', label: '有帮助', sentiment: 'positive' },
        { key: 'no', label: '没帮助', sentiment: 'negative' },
      ],
    });
    expect(policy.buttons).toEqual([
      { key: 'yes', label: '有帮助', semantic: 'positive', style: 'primary' },
      { key: 'no', label: '没帮助', semantic: 'negative', style: 'default' },
    ]);
    expect(policy.buttons.every(button => !('sentiment' in button))).toBe(true);
  });

  it('allows a semantic to be omitted only when visibleSemantics explicitly hides it', () => {
    expect(() => normalizeFeedbackPolicy({
      enabled: true,
      buttons: [
        { key: 'yes', label: '好', semantic: 'positive' },
        { key: 'no', label: '差', semantic: 'negative' },
      ],
    })).toThrow(/progress/);

    expect(normalizeFeedbackPolicy({
      enabled: true,
      visibleSemantics: ['positive', 'negative'],
      buttons: [
        { key: 'yes', label: '好', semantic: 'positive' },
        { key: 'no', label: '差', semantic: 'negative' },
      ],
    }).visibleSemantics).toEqual(['positive', 'negative']);
  });

  it.each([
    [{ enabled: true, audience: 'all' }, /audience/],
    [{ enabled: true, buttons: [{ key: 'yes', label: '好', semantic: 'positive' }, { key: 'maybe', label: '中', semantic: 'progress' }, { key: 'no', label: '差', semantic: 'unknown' }] }, /semantic/],
    [{ enabled: true, visibleSemantics: ['positive', 'unknown'] }, /visibleSemantics/],
    [{ enabled: true, buttons: [{ key: 'Bad Key', label: '好', semantic: 'positive' }, { key: 'maybe', label: '中', semantic: 'progress' }, { key: 'no', label: '差', semantic: 'negative' }] }, /key/],
    [{ enabled: true, buttons: [{ key: 'yes', label: '好', semantic: 'positive' }] }, /2.*4/],
    [{ enabled: true, buttons: [{ key: 'yes', label: '好', semantic: 'positive' }, { key: 'yes', label: '中', semantic: 'progress' }, { key: 'no', label: '差', semantic: 'negative' }] }, /unique/],
    [{ enabled: true, buttons: [{ key: 'maybe', label: '中', semantic: 'progress' }, { key: 'no', label: '差', semantic: 'negative' }] }, /positive/],
    [{ enabled: true, negativeFollowup: { comment: { maxLength: 2001 } } }, /2000/],
  ])('rejects invalid policy %#', (input, error) => {
    expect(() => normalizeFeedbackPolicy(input)).toThrow(error);
  });

  it('never resolves feedback for api-only bots', () => {
    expect(resolveFeedbackPolicy({ enabled: true }, { apiOnly: true })).toBeUndefined();
  });
});
