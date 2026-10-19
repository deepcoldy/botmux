import { describe, it, expect } from 'vitest';
import { buildReplyCardFooter, buildCanonicalFinalReplyCard, buildMarkdownCard, cardUsageRuntimeSegment, type CardUsageSnapshot } from '../src/im/lark/md-card.js';
import { normalizeCardUsageSnapshot } from '../src/cli/card-usage-normalize.js';
import { REPLY_FOOTER_KEYS } from '../src/services/reply-footer.js';

const facts: CardUsageSnapshot = {
  context: { usedTokens: 100, windowTokens: 1000 }, tokens: { in: 10, out: 20 },
  model: 'gpt-6.1-sol', reasoningEffort: 'medium', modelBackendVariant: 'max',
};
const opts = { brand: 'SIGNATURE', recipientOpenIds: ['ou_test'], executionDurationMs: 5000, waitingDurationMs: 1000, locale: 'en' as const };

describe('reply footer display policy', () => {
  it('master off removes every footer block and its divider, preserving body and runtime facts', () => {
    const usage = { ...facts, replyFooter: { replyFooterEnabled: false } };
    expect(buildReplyCardFooter({ ...opts, usage })).toBeNull();
    for (const card of [
      buildCanonicalFinalReplyCard({ markdown: 'BODY', ...opts, usage }),
      buildMarkdownCard('BODY', 'ou_test', 'SIGNATURE', 'en', undefined, 'filesystem', usage),
    ]) {
      expect(card).toContain('BODY');
      expect(card).not.toContain('botmux_reply_footer');
      expect(card).not.toContain('"tag":"hr"');
      expect(card).not.toContain('gpt-6.1-sol');
      expect(card).not.toContain('ou_test');
    }
    // Streaming formatter and accounting data remain usable.
    expect(cardUsageRuntimeSegment(usage)).toContain('gpt-6.1-sol');
    expect(usage.tokens).toEqual(facts.tokens);
  });

  it('independently hides brand, model/effort/variant, usage and footer notifications', () => {
    for (const [key, absent, present] of [
      ['replyFooterBrand', 'SIGNATURE', 'gpt-6.1-sol'],
      ['replyFooterModel', 'gpt-6.1-sol', 'SIGNATURE'],
      ['replyFooterUsage', '↑', 'gpt-6.1-sol'],
      ['replyFooterRecipients', '<at', 'SIGNATURE'],
    ] as const) {
      const footer = buildReplyCardFooter({ ...opts, usage: { ...facts, replyFooter: { [key]: false } } });
      expect(footer?.content).not.toContain(absent);
      expect(footer?.content).toContain(present);
      if (key === 'replyFooterModel') {
        expect(footer?.content).not.toContain('medium');
        expect(footer?.content).not.toContain('Max');
      }
    }
  });

  it('omits the empty footer when all available blocks are disabled', () => {
    const replyFooter = { replyFooterBrand: false, replyFooterModel: false, replyFooterUsage: false, replyFooterRecipients: false };
    expect(buildReplyCardFooter({ brand: 'SIGNATURE', recipientOpenIds: ['ou_test'], usage: { ...facts, replyFooter } })).toBeNull();
    expect(buildReplyCardFooter({ brand: '', usage: { context: null, tokens: null } })).toBeNull();
  });

  it('whitelists footer booleans through IPC and preserves off values in retry snapshots', () => {
    const usage = normalizeCardUsageSnapshot({ ...facts, replyFooter: { replyFooterEnabled: false, replyFooterModel: 'false', injected: false } });
    expect(usage?.replyFooter).toEqual({ replyFooterEnabled: false });
    expect(buildReplyCardFooter({ ...opts, usage: JSON.parse(JSON.stringify(usage)) })).toBeNull();
    expect(normalizeCardUsageSnapshot({ ...facts, replyFooter: [] })?.replyFooter).toBeUndefined();
    expect(REPLY_FOOTER_KEYS).toContain('replyFooterEnabled');
  });
});
