import { describe, expect, it } from 'vitest';
import {
  buildCanonicalFinalReplyCard,
  buildMarkdownCard,
  buildReplyCardFooter,
} from '../src/im/lark/md-card.js';
import type { Locale } from '../src/i18n/index.js';

const examples = [
  { ms: 0, zh: '0.0 秒', en: '0.0s' },
  { ms: 49, zh: '0.0 秒', en: '0.0s' },
  { ms: 50, zh: '0.1 秒', en: '0.1s' },
  { ms: 4300, zh: '4.3 秒', en: '4.3s' },
  { ms: 59949, zh: '59.9 秒', en: '59.9s' },
  { ms: 59950, zh: '1 分', en: '1m' },
  { ms: 60000, zh: '1 分', en: '1m' },
  { ms: 61500, zh: '1 分 1.5 秒', en: '1m 1.5s' },
  { ms: 1195600, zh: '19 分 55.6 秒', en: '19m 55.6s' },
  { ms: 3599950, zh: '1 小时', en: '1h' },
  { ms: 3600000, zh: '1 小时', en: '1h' },
  { ms: 3601500, zh: '1 小时 1.5 秒', en: '1h 1.5s' },
  { ms: 3661500, zh: '1 小时 1 分 1.5 秒', en: '1h 1m 1.5s' },
];

describe.each<Locale>(['zh', 'en'])('adaptive reply timing (%s)', locale => {
  it.each(examples)('uses readable units for $ms ms in every timing segment', example => {
    const duration = example[locale];
    for (const timing of [
      { waitingDurationMs: example.ms },
      { executionDurationMs: example.ms },
      { executionDurationMs: example.ms, executionInProgress: true },
    ]) {
      const footer = buildReplyCardFooter({ brand: '', locale, presentation: { timing } });
      expect(footer?.content).toContain(duration);
    }
  });

  it('applies identical units to direct sends and canonical final replies', () => {
    const presentation = {
      timing: { waitingDurationMs: 61500, executionDurationMs: 1195600 },
    };
    for (const card of [
      buildCanonicalFinalReplyCard({ markdown: 'BODY', brand: '', locale, presentation }),
      buildMarkdownCard('BODY', undefined, '', locale, undefined, 'filesystem', undefined, presentation),
    ]) {
      const parsed = JSON.parse(card);
      const output = JSON.stringify(parsed);
      expect(output).toContain(examples[7][locale]);
      expect(output).toContain(examples[8][locale]);
      expect(output).toContain('BODY');
    }
    expect(presentation.timing).toEqual({
      waitingDurationMs: 61500,
      executionDurationMs: 1195600,
    });
  });

  it.each([-1, NaN, Infinity, -Infinity])('omits invalid timing %s', ms => {
    expect(buildReplyCardFooter({
      brand: '',
      locale,
      executionDurationMs: ms,
      waitingDurationMs: ms,
    })).toBeNull();
  });
});
