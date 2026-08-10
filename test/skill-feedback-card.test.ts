import { describe, expect, it } from 'vitest';
import {
  buildCanonicalFinalReplyCard,
  buildContextualReplyCard,
  buildMarkdownCard,
} from '../src/im/lark/md-card.js';
import { readFileSync } from 'node:fs';

function feedbackCodes(cardJson: string): string[] {
  const card = JSON.parse(cardJson);
  return (card.body?.elements ?? [])
    .filter((element: any) => element.element_id === 'botmux_skill_feedback')
    .flatMap((element: any) => element.columns ?? [])
    .flatMap((column: any) => column.elements ?? [])
    .map((action: any) => action.behaviors?.[0]?.value?.result)
    .filter(Boolean);
}

describe('canonical final reply feedback card', () => {
  it.each([
    ['L0', ['helpful', 'incomplete', 'incorrect']],
    ['L1', ['usable', 'progress', 'wrong']],
    ['L2', ['completed', 'partial', 'blocked', 'wrong']],
  ] as const)('renders %s action set before the footer', (level, expected) => {
    const cardJson = buildCanonicalFinalReplyCard({
      markdown: 'final answer',
      feedback: { level },
      brand: 'botmux',
    });
    expect(feedbackCodes(cardJson)).toEqual(expected);

    const elements = JSON.parse(cardJson).body.elements;
    const feedbackIndex = elements.findIndex((element: any) => element.element_id === 'botmux_skill_feedback');
    const footerIndex = elements.findIndex((element: any) => element.element_id === 'botmux_reply_footer');
    expect(feedbackIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThan(feedbackIndex);
  });

  it('defaults to L1 only when level is absent', () => {
    expect(feedbackCodes(buildCanonicalFinalReplyCard({
      markdown: 'final answer',
      feedback: {},
    }))).toEqual(['usable', 'progress', 'wrong']);
  });

  it('ordinary markdown cards remain feedback-free unless explicitly canonical', () => {
    expect(buildMarkdownCard('streaming or progress')).not.toContain('botmux_skill_feedback');
  });

  it('ordinary botmux send stays feedback-free and only explicit feedback level opts in', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const workerPool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
    expect(cli).toContain('if (feedbackLevel)');
    expect(cli).toContain("argValue(rest, '--feedback-level')");
    expect(cli).toContain("feedback: { level: feedbackLevel }, brand: ''");
    expect(workerPool).toContain('buildCanonicalFinalReplyCard');
  });

  it('contextual cards are feedback-free unless explicitly requested', () => {
    const plain = JSON.parse(buildContextualReplyCard({ title: 'local', assistantText: 'done', assistantLabel: 'bot' }));
    const final = JSON.parse(buildContextualReplyCard({ title: 'local', assistantText: 'done', assistantLabel: 'bot', feedback: { level: 'L2' } }));
    expect(JSON.stringify(plain)).not.toContain('botmux_skill_feedback');
    expect(JSON.stringify(final)).toContain('botmux_skill_feedback');
  });
});
