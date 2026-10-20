import { describe, it, expect } from 'vitest';
import { buildReplyCardFooter, buildReplyCardFooterElements, buildCanonicalFinalReplyCard, buildMarkdownCard, cardUsageRuntimeSegment, type CardUsageSnapshot } from '../src/im/lark/md-card.js';
import { normalizeReplyCardRenderSnapshot } from '../src/cli/reply-card-render-normalize.js';
import { measureReplyTiming } from '../src/services/reply-card-render.js';
import { normalizeCardUsageSnapshot } from '../src/cli/card-usage-normalize.js';
import { REPLY_FOOTER_KEYS } from '../src/services/reply-footer.js';

const facts: CardUsageSnapshot = {
  context: { usedTokens: 100, windowTokens: 1000 }, tokens: { in: 10, out: 20 },
  model: 'gpt-6.1-sol', reasoningEffort: 'medium', modelBackendVariant: 'max',
};
const opts = { brand: 'SIGNATURE', recipientOpenIds: ['ou_test'], executionDurationMs: 5000, waitingDurationMs: 1000, locale: 'en' as const };

describe('reply footer display policy', () => {
  it('master off removes every footer block and its divider, preserving body and runtime facts', () => {
    const usage = facts;
    const presentation = { footerPreferences: { replyFooterEnabled: false } };
    expect(buildReplyCardFooter({ ...opts, usage, presentation })).toBeNull();
    for (const card of [
      buildCanonicalFinalReplyCard({ markdown: 'BODY', ...opts, usage, presentation }),
      buildMarkdownCard('BODY', 'ou_test', 'SIGNATURE', 'en', undefined, 'filesystem', usage, presentation),
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
      const footer = buildReplyCardFooter({ ...opts, usage: facts, presentation: { footerPreferences: { [key]: false } } });
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
    expect(buildReplyCardFooter({ brand: 'SIGNATURE', recipientOpenIds: ['ou_test'], usage: facts, presentation: { footerPreferences: replyFooter } })).toBeNull();
    expect(buildReplyCardFooter({ brand: '', usage: { context: null, tokens: null } })).toBeNull();
  });

  it('normalizes the independent render contract without contaminating usage facts', () => {
    const snapshot = normalizeReplyCardRenderSnapshot({ usage: facts, footerPreferences: { replyFooterEnabled: false, replyFooterModel: 'false', injected: false }, timing: { executionDurationMs: 5000, waitingDurationMs: -1, executionInProgress: true } });
    expect(snapshot?.footerPreferences).toEqual({ replyFooterEnabled: false });
    expect(snapshot?.timing).toEqual({ executionDurationMs: 5000, executionInProgress: true });
    expect(snapshot?.usage).not.toHaveProperty('replyFooter');
    expect(buildReplyCardFooter({ ...opts, usage: snapshot!.usage, presentation: JSON.parse(JSON.stringify(snapshot)) })).toBeNull();
    expect(normalizeCardUsageSnapshot({ ...facts, replyFooter: { replyFooterEnabled: false } })).not.toHaveProperty('replyFooter');
    expect(normalizeReplyCardRenderSnapshot({ footerPreferences: {} })).toBeNull();
    expect(REPLY_FOOTER_KEYS).toContain('replyFooterEnabled');
  });

  it('one composer applies the master to text, divider and voice actions', () => {
    const voiceButton = { tag: 'button', text: { tag: 'plain_text', content: 'VOICE' } };
    expect(buildReplyCardFooterElements({ ...opts, usage: facts, voiceButton, presentation: { footerPreferences: { replyFooterEnabled: false } } })).toEqual([]);
    expect(JSON.stringify(buildReplyCardFooterElements({ ...opts, usage: facts, voiceButton, presentation: { footerPreferences: { replyFooterVoice: false } } }))).not.toContain('VOICE');
    const voiceOnly = buildReplyCardFooterElements({ brand: '', voiceButton });
    expect(voiceOnly[0]).toEqual({ tag: 'hr' });
    expect(JSON.stringify(voiceOnly)).toContain('VOICE');
    expect(buildReplyCardFooterElements({ brand: '', voiceButton, presentation: { footerPreferences: { replyFooterVoice: false } } })).toEqual([]);
  });

  it('measures waiting separately and labels partial execution honestly', () => {
    expect(measureReplyTiming({ startedAtMs: 3000, receivedAtMs: 1000, nowMs: 8000, completed: false })).toEqual({ executionDurationMs: 5000, waitingDurationMs: 2000, executionInProgress: true });
    expect(measureReplyTiming({ nowMs: 8000, completed: false })).toBeUndefined();
    expect(measureReplyTiming({ startedAtMs: 9000, receivedAtMs: 1000, nowMs: 8000, completed: false })).toBeUndefined();
    const timing = measureReplyTiming({ startedAtMs: 3000, receivedAtMs: 1000, nowMs: 8000, completed: true, durationMs: 4000 });
    expect(timing).toEqual({ executionDurationMs: 4000, waitingDurationMs: 2000 });
    expect(buildReplyCardFooter({ brand: '', locale: 'en', presentation: { footerPreferences: {}, timing: { executionDurationMs: 5000, executionInProgress: true } } })?.content).toContain('Execution until reply 5.0s');
  });
});
