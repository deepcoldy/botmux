import { describe, it, expect } from 'vitest';
import { resolveQuoteTarget, validateMentionDecision, parseAttentionFlag, attentionUsageError } from '../src/services/send-policy.js';

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
