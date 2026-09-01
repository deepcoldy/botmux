import { describe, expect, it } from 'bun:test';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { renderFeedbackCard } from '../src/im/lark/skill-feedback-card.js';

const json = (value: unknown) => JSON.stringify(value);
const elements = (card: any) => card.body.elements as any[];
const buttons = (card: any) => json(card).match(/"tag":"button"/g)?.length ?? 0;

function fixture(input: Record<string, unknown> = {}) {
  const policy = normalizeFeedbackPolicy({
    enabled: true,
    buttons: [
      { key: 'helpful', label: '有帮助', semantic: 'positive', style: 'primary' },
      { key: 'incomplete', label: '不完整', semantic: 'progress', style: 'default' },
      { key: 'incorrect', label: '不正确', semantic: 'negative', style: 'danger' },
    ],
    negativeFollowup: {
      reasons: [
        { key: 'missing_context', label: '缺少关键信息' },
        { key: 'wrong_result', label: '结论错误' },
      ],
      comment: { enabled: true, required: false, placeholder: '可以补充哪里需要改进', maxLength: 1000 },
    },
    ...input,
  });
  const base = JSON.parse(buildCanonicalFinalReplyCard({ markdown: '真实回答正文', feedback: { policy } }));
  return { policy, base };
}

describe('feedback regression matrix from 2026-08-11 live failures', () => {
  it('never exposes response-kind control values as reply body', () => {
    const { base } = fixture();
    expect(json(base)).toContain('真实回答正文');
    expect(elements(base)[0].content).not.toBe('final');
    expect(elements(base)[0].content).not.toBe('progress');
  });

  it('first positive selection preserves body/footer/buttons and shows selected value', () => {
    const { policy, base } = fixture();
    const card = renderFeedbackCard(base, policy, { result: 'helpful' });
    expect(json(card)).toContain('真实回答正文');
    expect(json(card)).toContain('botmux_reply_footer');
    expect(buttons(card)).toBe(3);
    expect(json(card)).toContain('已选择：**有帮助**');
    expect(json(card)).not.toContain('feedback_comment_form');
  });

  it('first negative selection preserves primary buttons and expands reasons plus a valid form', () => {
    const { policy, base } = fixture({ allowReselect: true });
    const card = renderFeedbackCard(base, policy, { result: 'incorrect' });
    const body = json(card);
    expect(buttons(card)).toBe(6); // 3 primary + 2 reasons + submit
    expect(body).toContain('已选择：**不正确**');
    expect(body).toContain('botmux_feedback_reasons');
    expect(body).toContain('feedback_comment_form');
    expect(body).toContain('"input_type":"multiline_text"');
    expect(body).toContain('"action_type":"form_submit"');
    expect(body).toContain('"value":{"action":"feedback_comment"}');
    expect(body).not.toContain('"behaviors":[{"type":"callback","value":{"action":"feedback_comment"}}]');
    expect(body).not.toContain('"max_length"');
  });

  it('progress selection is terminal and does not expose negative follow-up', () => {
    const { policy, base } = fixture();
    const card = renderFeedbackCard(base, policy, { result: 'incomplete' });
    expect(json(card)).toContain('已选择：**不完整**');
    expect(json(card)).not.toContain('botmux_feedback_reasons');
    expect(json(card)).not.toContain('feedback_comment_form');
  });

  it('locks all primary buttons by default but leaves negative follow-up usable', () => {
    const { policy, base } = fixture();
    const card = renderFeedbackCard(base, policy, { result: 'incorrect' });
    const primary = elements(card).find(e => e.element_id === 'botmux_feedback');
    expect(primary.columns.every((column: any) => column.elements[0].disabled === true)).toBe(true);
    const reasons = elements(card).find(e => e.element_id === 'botmux_feedback_reasons');
    expect(reasons.columns.every((column: any) => column.elements[0].disabled === false)).toBe(true);
  });

  it('keeps primary buttons enabled only when allowReselect is true', () => {
    const { policy, base } = fixture({ allowReselect: true });
    const card = renderFeedbackCard(base, policy, { result: 'incorrect' });
    const primary = elements(card).find(e => e.element_id === 'botmux_feedback');
    expect(primary.columns.every((column: any) => column.elements[0].disabled === false)).toBe(true);
  });

  it('switching negative to positive removes stale reasons/form without losing controls', () => {
    const { policy, base } = fixture({ allowReselect: true });
    const negative = renderFeedbackCard(base, policy, { result: 'incorrect' });
    const positive = renderFeedbackCard(negative, policy, { result: 'helpful' });
    expect(buttons(positive)).toBe(3);
    expect(json(positive)).toContain('已选择：**有帮助**');
    expect(json(positive)).not.toContain('botmux_feedback_reasons');
    expect(json(positive)).not.toContain('feedback_comment_form');
  });
});
