import { describe, expect, it } from 'vitest';
import {
  materializeFeedbackReviewers,
  normalizeFeedbackPolicy,
  resolveFeedbackPolicy,
} from '../src/services/feedback-policy.js';

describe('feedback policy', () => {
  it('is disabled when absent or not explicitly enabled', () => {
    expect(resolveFeedbackPolicy(undefined)).toBeUndefined();
    expect(resolveFeedbackPolicy({ enabled: false })).toBeUndefined();
  });

  it('normalizes enabled policy with product defaults', () => {
    expect(normalizeFeedbackPolicy({ enabled: true })).toEqual({
      enabled: true,
      audience: 'requester',
      reviewers: [],
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

  describe('reviewers audience', () => {
    it('normalizes a reviewers allowlist and emits it verbatim', () => {
      const policy = normalizeFeedbackPolicy({
        enabled: true,
        audience: 'reviewers',
        reviewers: ['ou_alice', 'on_bob'],
      });
      expect(policy.audience).toBe('reviewers');
      expect(policy.reviewers).toEqual(['ou_alice', 'on_bob']);
    });

    it('accepts a full email reviewer entry (resolved to an id at send time)', () => {
      const policy = normalizeFeedbackPolicy({
        enabled: true,
        audience: 'reviewers',
        reviewers: ['alice@example.com', 'on_bob'],
      });
      expect(policy.reviewers).toEqual(['alice@example.com', 'on_bob']);
    });

    it('fails closed when the reviewers audience has an empty allowlist', () => {
      expect(() => normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers' })).toThrow(/non-empty/);
      expect(() => normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers', reviewers: [] })).toThrow(/non-empty/);
    });

    it('rejects a reviewers allowlist paired with a non-reviewers audience', () => {
      expect(() => normalizeFeedbackPolicy({ enabled: true, reviewers: ['ou_alice'] })).toThrow(/reviewers/);
      expect(() => normalizeFeedbackPolicy({ enabled: true, audience: 'requester', reviewers: ['ou_alice'] })).toThrow(/reviewers/);
      expect(() => normalizeFeedbackPolicy({ enabled: true, audience: 'everyone', reviewers: ['ou_alice'] })).toThrow(/reviewers/);
    });

    it.each([
      [{ enabled: true, audience: 'reviewers', reviewers: ['alice'] }, /full email/],
      [{ enabled: true, audience: 'reviewers', reviewers: ['13011112222'] }, /full email/],
      [{ enabled: true, audience: 'reviewers', reviewers: [123] }, /must be a string/],
      [{ enabled: true, audience: 'reviewers', reviewers: ['ou_alice', 'ou_alice'] }, /unique/],
      [{ enabled: true, audience: 'reviewers', reviewers: 'ou_alice' }, /must be an array/],
    ])('rejects an unverifiable or malformed reviewers allowlist %#', (input, error) => {
      expect(() => normalizeFeedbackPolicy(input)).toThrow(error);
    });
  });

  describe('everyone audience', () => {
    it('normalizes the everyone audience with no allowlist', () => {
      const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'everyone' });
      expect(policy.audience).toBe('everyone');
      expect(policy.reviewers).toEqual([]);
    });
  });

  describe('materializeFeedbackReviewers', () => {
    it('resolves email to an id, keeps ou_/on_, and dedupes', async () => {
      const policy = normalizeFeedbackPolicy({
        enabled: true,
        audience: 'reviewers',
        reviewers: ['alice@example.com', 'ou_bob', 'carol@example.com'],
      });
      const frozen = await materializeFeedbackReviewers(policy, async entries => {
        expect(entries).toEqual(['alice@example.com', 'carol@example.com']);
        return new Map([['alice@example.com', 'ou_bob'], ['carol@example.com', 'ou_carol']]);
      });
      // alice resolves to ou_bob which is already listed → deduped to one.
      expect(frozen.reviewers).toEqual(['ou_bob', 'ou_carol']);
    });

    it('drops an unresolved email rather than shipping a dead entry', async () => {
      const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers', reviewers: ['ghost@example.com', 'ou_bob'] });
      const frozen = await materializeFeedbackReviewers(policy, async () => new Map());
      expect(frozen.reviewers).toEqual(['ou_bob']);
    });

    it('fails closed to an empty list when the resolver throws', async () => {
      const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers', reviewers: ['alice@example.com'] });
      const frozen = await materializeFeedbackReviewers(policy, async () => { throw new Error('network'); });
      expect(frozen.reviewers).toEqual([]);
    });

    it('never calls the resolver for pure-id, everyone or requester policies', async () => {
      const resolve = async () => { throw new Error('should not be called'); };
      const pureIds = normalizeFeedbackPolicy({ enabled: true, audience: 'reviewers', reviewers: ['ou_a', 'on_b'] });
      expect((await materializeFeedbackReviewers(pureIds, resolve)).reviewers).toEqual(['ou_a', 'on_b']);
      const everyone = normalizeFeedbackPolicy({ enabled: true, audience: 'everyone' });
      expect(await materializeFeedbackReviewers(everyone, resolve)).toBe(everyone);
      const requester = normalizeFeedbackPolicy({ enabled: true });
      expect(await materializeFeedbackReviewers(requester, resolve)).toBe(requester);
    });
  });
});
