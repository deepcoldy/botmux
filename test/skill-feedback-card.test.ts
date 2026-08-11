import { describe, expect, it } from 'vitest';
import { buildCanonicalFinalReplyCard, buildMarkdownCard } from '../src/im/lark/md-card.js';
import { renderFeedbackCard } from '../src/im/lark/skill-feedback-card.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';

const policy = normalizeFeedbackPolicy({
  enabled: true,
  negativeFollowup: { reasons: [{ key: 'missing_context', label: '缺少关键信息' }] },
});
const baseCard = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'final answer', feedback: { policy }, brand: 'botmux' }));

function visible(card: unknown): string { return JSON.stringify(card); }

describe('final answer feedback card state machine', () => {
  it('renders configured initial actions before the footer without internal levels', () => {
    expect(visible(baseCard)).toContain('结论可用');
    expect(visible(baseCard)).toContain('有效推进');
    const elements = baseCard.body.elements;
    expect(elements.findIndex((element: any) => element.element_id === 'botmux_feedback')).toBeLessThan(elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer'));
    expect(visible(baseCard)).not.toMatch(/L0|L1|L2/);
  });

  it('keeps button components, shows the selected label, and locks re-selection by default', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'conclusive_usable' });
    expect(visible(card)).toContain('已选择：**结论可用**');
    expect(visible(card)).toContain('"disabled":true');
    expect(visible(card)).not.toContain('missing_context');
    expect((card as any).body.elements.filter((element: any) => element.element_id === 'botmux_feedback')).toHaveLength(1);
  });

  it('keeps buttons enabled only when re-selection is configured', () => {
    const reselectPolicy = normalizeFeedbackPolicy({ enabled: true, allowReselect: true });
    const reselectBase = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'answer', feedback: { policy: reselectPolicy } }));
    const card = renderFeedbackCard(reselectBase, reselectPolicy, { result: 'conclusive_usable' });
    expect(visible(card)).toContain('已选择：**结论可用**');
    expect(visible(card)).toContain('"disabled":false');
  });

  it('preserves all non-feedback elements when the card has no footer', () => {
    const noFooter = structuredClone(baseCard);
    noFooter.body.elements = noFooter.body.elements.filter((element: any) =>
      element.element_id !== 'botmux_reply_footer' && element.tag !== 'hr');
    noFooter.body.elements.push({ tag: 'markdown', element_id: 'after_feedback', content: 'keep me' });
    const card = renderFeedbackCard(noFooter, policy, { result: 'conclusive_usable' });
    const elements = (card as any).body.elements;
    expect(elements).toContainEqual(expect.objectContaining({ element_id: 'after_feedback', content: 'keep me' }));
    expect(elements.filter((element: any) => element.element_id === 'botmux_feedback')).toHaveLength(1);
  });

  it('expands reasons and comment form for a negative choice', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'incorrect' });
    expect(visible(card)).toContain('已选择：**结论有误**');
    expect(visible(card)).toContain('缺少关键信息');
    expect(visible(card)).toContain('可以补充哪里需要改进');
    expect(visible(card)).toContain('提交补充');
    expect(visible(card)).toContain('form_submit');
  });

  it('renders selected reason and completed comment without echoing text', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'incorrect', reasonKey: 'missing_context', comment: 'private detail' });
    expect(visible(card)).toContain('✓ 缺少关键信息');
    expect(visible(card)).toContain('已补充说明');
    expect(visible(card)).not.toContain('private detail');
  });

  it('collapses negative follow-up after changing to positive', () => {
    const card = renderFeedbackCard(baseCard, policy, { result: 'conclusive_usable', reasonKey: 'missing_context', comment: 'old' });
    expect(visible(card)).not.toContain('缺少关键信息');
    expect(visible(card)).not.toContain('已补充说明');
  });

  it('ordinary markdown cards remain feedback-free', () => {
    expect(buildMarkdownCard('streaming or progress')).not.toContain('botmux_feedback');
  });
});
