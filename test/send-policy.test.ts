import { describe, it, expect, vi } from 'vitest';
import {
  resolveQuoteTarget,
  shouldDropAfterTheFactTopicQuote,
  validateMentionDecision,
  classifyMentionIdentifiers,
  outsidersForMembership,
  mentionBackAmbiguity,
  mentionBackAmbiguityError,
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

describe('mentionBackAmbiguity (turn-window participants + completeness)', () => {
  it('zero or one counterpart in a COMPLETE window → unambiguous, allow --mention-back', () => {
    expect(mentionBackAmbiguity({ chatType: 'group', participants: [], incomplete: false })).toEqual({ ambiguous: false, candidates: [], incomplete: false });
    expect(mentionBackAmbiguity({ chatType: 'group', participants: [{ openId: 'ou_a' }], incomplete: false })).toEqual({ ambiguous: false, candidates: [], incomplete: false });
  });

  it('a bot-only 1v1 complete window stays unambiguous (bot→bot handoff @-back is exact)', () => {
    // The reported footgun path: 1 human + N idle bots, a bot triggers — the
    // turn window has just that one bot, so --mention-back is allowed and @s it.
    expect(mentionBackAmbiguity({ chatType: 'group', participants: [{ openId: 'ou_bot_a', isBot: true }], incomplete: false }).ambiguous).toBe(false);
  });

  it('2+ distinct counterparts → ambiguous, list them as --mention candidates', () => {
    const r = mentionBackAmbiguity({
      chatType: 'group',
      participants: [{ openId: 'ou_human', name: '张三' }, { openId: 'ou_bot', name: 'Codex', isBot: true }],
      incomplete: false,
    });
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map(c => c.openId)).toEqual(['ou_human', 'ou_bot']);
  });

  it('INCOMPLETE window is ambiguous even with ≤1 known candidate (hidden counterpart may exist)', () => {
    // e.g. "human sender + @OtherBot(app_id-form)": only the human resolves to an
    // open_id, but the unresolved bot mention set incomplete → must not auto-@.
    const r = mentionBackAmbiguity({ chatType: 'group', participants: [{ openId: 'ou_human', name: '张三' }], incomplete: true });
    expect(r.ambiguous).toBe(true);
    expect(r.incomplete).toBe(true);
    expect(r.candidates.map(c => c.openId)).toEqual(['ou_human']); // the one we CAN list
  });

  it('INCOMPLETE window with zero known candidates is still ambiguous (old session, no participants)', () => {
    expect(mentionBackAmbiguity({ chatType: 'group', participants: [], incomplete: true }).ambiguous).toBe(true);
  });

  it('p2p DM is never ambiguous regardless of participants/incomplete', () => {
    expect(mentionBackAmbiguity({ chatType: 'p2p', participants: [{ openId: 'ou_a' }, { openId: 'ou_b' }], incomplete: true }))
      .toEqual({ ambiguous: false, candidates: [], incomplete: false });
  });

  it('ignores participant entries without an open_id when counting', () => {
    expect(mentionBackAmbiguity({ chatType: 'group', participants: [{ openId: 'ou_a' }, { openId: '' }], incomplete: false }).ambiguous).toBe(false);
  });
});

describe('mentionBackAmbiguityError', () => {
  it('lists each candidate open_id with three-state label (bot/人/未知) and name', () => {
    const msg = mentionBackAmbiguityError([
      { openId: 'ou_human', name: '张三', isBot: false },
      { openId: 'ou_bot', name: 'Codex', isBot: true },
      { openId: 'ou_unknown', name: '?' }, // isBot undefined → 未知
    ]);
    expect(msg).toContain('--mention <open_id>');
    expect(msg).toContain('ou_human（人 张三）');
    expect(msg).toContain('ou_bot（bot Codex）');
    expect(msg).toContain('ou_unknown（未知 ?）');
    expect(msg).toContain('--no-mention');
  });

  it('incomplete window: still lists the known sender + says there may be unresolved participants', () => {
    const msg = mentionBackAmbiguityError([{ openId: 'ou_human', name: '张三', isBot: false }], true);
    expect(msg).toContain('ou_human（人 张三）'); // known candidate still offered
    expect(msg).toContain('无法确定唯一'); // incomplete phrasing
  });

  it('incomplete window with no listable candidate still guides to explicit --mention/--no-mention', () => {
    const msg = mentionBackAmbiguityError([], true);
    expect(msg).toContain('--mention <open_id>');
    expect(msg).toContain('--no-mention');
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

describe('shouldDropAfterTheFactTopicQuote', () => {
  // 「顶层 @ 之后那条消息才被开成话题」的发送侧半边：quote 会继承被引用消息
  // **此刻**的话题归属，所以必须在这种情况下放弃 quote、改平铺。
  const base = { quoteTargetId: 'om_top_at' };

  it('顶层进来的轮次 + 该消息现在已属于话题 → 放弃 quote(改平铺)', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: false, currentThreadId: 'omt_after_fact',
    })).toBe(true);
  });

  it('顶层进来但该消息现在确认没有话题 → 照旧 quote', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: false, currentThreadId: null,
    })).toBe(false);
  });

  it('本轮就是从话题里进来的(inThread=true) → 照旧 quote,不碰真话题的锚定', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: true, currentThreadId: 'omt_genuine',
    })).toBe(false);
  });

  it('老会话行没有 inThread(undefined) → 按未知保持旧行为,绝不猜', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: undefined, currentThreadId: 'omt_x',
    })).toBe(false);
  });

  it('探测失败/未探测(currentThreadId undefined) → 保持 quote,不确定不改行为', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: false, currentThreadId: undefined,
    })).toBe(false);
  });

  it('--quote 是操作者显式指定 → 一律照办,不覆盖', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: false, currentThreadId: 'omt_after_fact', explicitQuote: 'om_top_at',
    })).toBe(false);
  });

  it('本来就不 quote → 无需判断', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      quoteTargetId: null, quotedTurnInThread: false, currentThreadId: 'omt_x',
    })).toBe(false);
  });

  it('空白 thread_id 不算话题(防把 "" / 空格当命中)', () => {
    expect(shouldDropAfterTheFactTopicQuote({
      ...base, quotedTurnInThread: false, currentThreadId: '   ',
    })).toBe(false);
  });
});

describe('classifyMentionIdentifiers', () => {
  const oid = { identifier: 'ou_abc', name: 'Alice' };
  const email = { identifier: 'bob@bytedance.com', name: 'Bob' };
  const union = { identifier: 'on_xyz', name: '' };

  it('passes literal open_ids through regardless of the switch', () => {
    const r = classifyMentionIdentifiers([oid], false);
    expect(r.ok).toBe(true);
    expect(r.openIdMentions).toEqual([oid]);
    expect(r.toResolve).toEqual([]);
  });

  it('rejects non-open_id identifiers when the switch is off', () => {
    const r = classifyMentionIdentifiers([oid, email], false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('allowArbitraryMention');
    expect(r.error).toContain('bob@bytedance.com');
    // open_ids are still surfaced so callers could partially proceed if desired
    expect(r.openIdMentions).toEqual([oid]);
  });

  it('routes non-open_id identifiers to resolution when the switch is on', () => {
    const r = classifyMentionIdentifiers([oid, email, union], true);
    expect(r.ok).toBe(true);
    expect(r.openIdMentions).toEqual([oid]);
    expect(r.toResolve).toEqual([email, union]);
  });

  it('is a no-op for an empty mention list', () => {
    const r = classifyMentionIdentifiers([], false);
    expect(r.ok).toBe(true);
    expect(r.openIdMentions).toEqual([]);
    expect(r.toResolve).toEqual([]);
  });
});

describe('outsidersForMembership', () => {
  const members = new Set(['ou_alice', 'ou_bob']);

  it('returns empty when every resolved open_id is a member (in-group passes)', () => {
    const out = outsidersForMembership(
      [{ identifier: 'a@x.com', openId: 'ou_alice' }, { identifier: 'b@x.com', openId: 'ou_bob' }],
      members,
    );
    expect(out).toEqual([]);
  });

  it('flags a resolved open_id that is NOT a member (out-of-group rejected)', () => {
    const out = outsidersForMembership(
      [{ identifier: 'a@x.com', openId: 'ou_alice' }, { identifier: 'c@x.com', openId: 'ou_carol' }],
      members,
    );
    expect(out).toEqual([{ identifier: 'c@x.com', openId: 'ou_carol' }]);
  });

  it('flags everyone when the member set is empty (gate has teeth)', () => {
    const out = outsidersForMembership(
      [{ identifier: 'a@x.com', openId: 'ou_alice' }],
      new Set<string>(),
    );
    expect(out).toHaveLength(1);
  });
});
