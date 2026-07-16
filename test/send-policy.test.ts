import { describe, it, expect, vi } from 'vitest';
import {
  resolveQuoteTarget,
  validateMentionDecision,
  parseAttentionFlag,
  attentionUsageError,
  managedVcQuoteError,
  managedVcCustomCardError,
  managedVcSendControlError,
  managedVcSendPayloadError,
  containsLarkAtTag,
  neutralizeLarkAtTags,
} from '../src/services/send-policy.js';

describe('resolveQuoteTarget', () => {
  const base = { isChatScope: true, sendTopLevel: false, noQuote: false };

  it('chat scope defaults to session quote target', () => {
    expect(resolveQuoteTarget({ ...base, sessionQuoteTargetId: 'om_a' })).toBe('om_a');
  });

  it('--quote overrides session target', () => {
    expect(resolveQuoteTarget({ ...base, explicitQuote: 'om_b', sessionQuoteTargetId: 'om_a' })).toBe('om_b');
  });

  it('--no-quote forces plain send', () => {
    expect(resolveQuoteTarget({ ...base, noQuote: true, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });

  it('no target available → plain send', () => {
    expect(resolveQuoteTarget({ ...base })).toBeNull();
    expect(resolveQuoteTarget({ ...base, sessionQuoteTargetId: '  ' })).toBeNull();
  });

  it('thread scope never quotes', () => {
    expect(resolveQuoteTarget({ ...base, isChatScope: false, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });

  it('--top-level never quotes', () => {
    expect(resolveQuoteTarget({ ...base, sendTopLevel: true, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });
});

describe('managedVcQuoteError', () => {
  it('rejects a durable cross-chat quote before any provider call', () => {
    const providerCall = vi.fn();
    const error = managedVcQuoteError({
      managed: true,
      durableDelivery: true,
      explicitQuote: 'om_message_in_other_chat',
    });
    if (!error) providerCall();

    expect(error).toMatch(/durable delivery/);
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('allows only the exact routed message for an explicit IM turn', () => {
    expect(managedVcQuoteError({
      managed: true,
      durableDelivery: false,
      explicitImMessageId: 'om_current',
      explicitQuote: 'om_current',
    })).toBeNull();
    expect(managedVcQuoteError({
      managed: true,
      durableDelivery: false,
      explicitImMessageId: 'om_current',
      explicitQuote: 'om_other_chat',
    })).toMatch(/精确路由/);
  });

  it('does not change ordinary-session quote behavior', () => {
    expect(managedVcQuoteError({
      managed: false,
      durableDelivery: false,
      explicitQuote: 'om_any',
    })).toBeNull();
  });
});

describe('managedVcCustomCardError', () => {
  it('rejects custom card JSON before a managed VC provider call', () => {
    const providerCall = vi.fn();
    const error = managedVcCustomCardError(true, true);
    if (!error) providerCall();

    expect(error).toMatch(/card-json/);
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('keeps ordinary custom cards and botmux-owned managed cards available', () => {
    expect(managedVcCustomCardError(false, true)).toBeNull();
    expect(managedVcCustomCardError(true, false)).toBeNull();
  });
});

describe('managedVcSendControlError', () => {
  const safe = {
    managed: true,
    sendTopLevel: false,
    attentionRequested: false,
    explicitMentionCount: 0,
    mentionBack: false,
    noMention: true,
  };

  it('freezes routing and attention before a provider call', () => {
    const providerCall = vi.fn();
    for (const input of [
      { ...safe, sendTopLevel: true },
      { ...safe, overrideChatId: 'oc_other' },
      { ...safe, sendInto: 'om_other' },
      { ...safe, attentionRequested: true },
    ]) {
      const error = managedVcSendControlError(input);
      if (!error) providerCall();
      expect(error).toBeTruthy();
    }
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('requires --no-mention and rejects both explicit mention forms', () => {
    expect(managedVcSendControlError({ ...safe, noMention: false })).toMatch(/--no-mention/);
    expect(managedVcSendControlError({ ...safe, explicitMentionCount: 1 })).toMatch(/--mention/);
    expect(managedVcSendControlError({ ...safe, mentionBack: true })).toMatch(/--mention-back/);
    expect(managedVcSendControlError(safe)).toBeNull();
  });

  it('does not change ordinary send controls', () => {
    expect(managedVcSendControlError({
      ...safe,
      managed: false,
      sendTopLevel: true,
      attentionRequested: true,
      explicitMentionCount: 1,
      mentionBack: true,
      noMention: false,
    })).toBeNull();
  });
});

describe('managedVcSendPayloadError', () => {
  const safe = {
    managed: true,
    asVoice: false,
    hasBodyText: true,
    imageCount: 0,
    fileCount: 0,
    videoCount: 0,
    containsNativeAtTag: false,
  };

  it('rejects every provider-upload shape before provider work', () => {
    const providerCall = vi.fn();
    for (const input of [
      { ...safe, fileCount: 1 },
      { ...safe, imageCount: 1 },
      { ...safe, asVoice: true },
      { ...safe, videoCount: 2, hasBodyText: false },
      { ...safe, videoCount: 1 },
      { ...safe, videoCount: 1, hasBodyText: false, imageCount: 1 },
      { ...safe, videoCount: 1, asVoice: true },
    ]) {
      const error = managedVcSendPayloadError(input);
      if (!error) providerCall();
      expect(error).toBeTruthy();
    }
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('allows only ordinary managed text cards', () => {
    expect(managedVcSendPayloadError(safe)).toBeNull();
  });

  it('rejects native Lark at tags in managed card text', () => {
    expect(containsLarkAtTag('hello <at id="ou_x"></at>')).toBe(true);
    expect(containsLarkAtTag('hello <atlas>')).toBe(false);
    expect(managedVcSendPayloadError({ ...safe, containsNativeAtTag: true })).toMatch(/<at/);
  });

  it('neutralizes native mention controls without changing ordinary text', () => {
    expect(neutralizeLarkAtTags('hello <at id="ou_x">Alice</at>!'))
      .toBe('hello ＜at id="ou_x">Alice＜/at＞!');
    expect(containsLarkAtTag(neutralizeLarkAtTags('<AT>bot</AT>'))).toBe(false);
    expect(neutralizeLarkAtTags('hello <atlas>')).toBe('hello <atlas>');
  });

  it('does not change ordinary attachment behavior', () => {
    expect(managedVcSendPayloadError({
      ...safe,
      managed: false,
      fileCount: 2,
      videoCount: 3,
      containsNativeAtTag: true,
    })).toBeNull();
  });
});

describe('validateMentionDecision', () => {
  const base = {
    enabled: true,
    sendTopLevel: false,
    hasMentionArgs: false,
    mentionBack: false,
    noMention: false,
    hasQuoteTargetSender: true,
  };

  it('passes when --mention given', () => {
    expect(validateMentionDecision({ ...base, hasMentionArgs: true }).ok).toBe(true);
  });

  it('passes when --mention-back given (with sender)', () => {
    expect(validateMentionDecision({ ...base, mentionBack: true }).ok).toBe(true);
  });

  it('passes when --no-mention given', () => {
    expect(validateMentionDecision({ ...base, noMention: true }).ok).toBe(true);
  });

  it('fails (no decision) with content-based guidance (not human-vs-bot)', () => {
    const r = validateMentionDecision({ ...base });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('实质结论');
    expect(r.error).toContain('--mention-back');
    expect(r.error).toContain('--no-mention');
  });

  it('rejects --no-mention combined with --mention', () => {
    const r = validateMentionDecision({ ...base, noMention: true, hasMentionArgs: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能与');
  });

  it('rejects --mention-back with no known sender', () => {
    const r = validateMentionDecision({ ...base, mentionBack: true, hasQuoteTargetSender: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无可 @ 对象');
  });

  it('disabled gate always passes', () => {
    expect(validateMentionDecision({ ...base, enabled: false }).ok).toBe(true);
  });

  it('--top-level exempt from gate', () => {
    expect(validateMentionDecision({ ...base, sendTopLevel: true }).ok).toBe(true);
  });
});

describe('parseAttentionFlag', () => {
  it('absent → not requested, default kind', () => {
    expect(parseAttentionFlag(['hello'])).toEqual({ requested: false, kind: 'blocked' });
  });
  it('bare --attention does NOT eat the next arg as kind/value', () => {
    // the message ("我卡住了") must remain a positional, not become the flag value
    const r = parseAttentionFlag(['--attention', '我卡住了']);
    expect(r).toEqual({ requested: true, kind: 'blocked' });
  });
  it('--attention=kind parses the kind', () => {
    expect(parseAttentionFlag(['--attention=authz'])).toEqual({ requested: true, kind: 'authz' });
    expect(parseAttentionFlag(['--attention=decision'])).toEqual({ requested: true, kind: 'decision' });
  });
  it('unknown kind falls back to blocked (never fail over a typo)', () => {
    expect(parseAttentionFlag(['--attention=bogus'])).toEqual({ requested: true, kind: 'blocked' });
    expect(parseAttentionFlag(['--attention='])).toEqual({ requested: true, kind: 'blocked' });
  });
});

describe('attentionUsageError', () => {
  const ok = { requested: true, sendTopLevel: false, hasText: true };
  it('not requested → null', () => {
    expect(attentionUsageError({ requested: false, sendTopLevel: true, hasText: false })).toBeNull();
  });
  it('valid current-session reply with text → null', () => {
    expect(attentionUsageError(ok)).toBeNull();
  });
  it('rejects --top-level / --chat-id / --into (clear-on-reply would bind wrong anchor)', () => {
    expect(attentionUsageError({ ...ok, sendTopLevel: true })).toMatch(/--top-level/);
    expect(attentionUsageError({ ...ok, overrideChatId: 'oc_x' })).toMatch(/--chat-id/);
    expect(attentionUsageError({ ...ok, sendInto: 'om_x' })).toMatch(/--into/);
  });
  it('rejects --voice (voice path returns before attention state can be raised)', () => {
    expect(attentionUsageError({ ...ok, asVoice: true })).toMatch(/--voice/);
  });
  it('rejects no-text (dashboard needs a reason)', () => {
    expect(attentionUsageError({ ...ok, hasText: false })).toMatch(/reason/);
  });
});
