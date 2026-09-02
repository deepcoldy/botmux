import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeFeedbackPolicyLayer,
  resolveEffectiveFeedbackPolicy,
  resolveFeedbackPolicyForDelivery,
  traceFeedbackPolicyForDelivery,
} from '../src/services/feedback-policy-resolver.js';
import { createTeam, setTeamFeedbackPolicy } from '../src/services/team-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';

const enabled = { enabled: true } as const;

describe('feedback policy layered resolution', () => {
  it('is disabled when no layer explicitly enables it', () => {
    expect(resolveEffectiveFeedbackPolicy({})).toBeUndefined();
  });

  it('inherits normalized defaults from an enabled team layer', () => {
    expect(resolveEffectiveFeedbackPolicy({ team: enabled })).toMatchObject({
      enabled: true,
      audience: 'requester',
      visibleSemantics: ['positive', 'progress', 'negative'],
      allowReselect: false,
    });
  });

  it('merges bot scalar and nested comment fields without losing team fields', () => {
    const policy = resolveEffectiveFeedbackPolicy({
      team: {
        enabled: true,
        allowReselect: true,
        negativeFollowup: { comment: { enabled: false, placeholder: 'team text' } },
      },
      bot: { negativeFollowup: { comment: { enabled: true, required: true } } },
    });
    expect(policy).toMatchObject({
      allowReselect: true,
      negativeFollowup: { comment: { enabled: true, required: true, placeholder: 'team text' } },
    });
  });

  it('applies chat last, including disable and explicit re-enable', () => {
    expect(resolveEffectiveFeedbackPolicy({ team: enabled, bot: { enabled: false }, chat: {} })).toBeUndefined();
    expect(resolveEffectiveFeedbackPolicy({ team: enabled, chat: { enabled: false } })).toBeUndefined();
    expect(resolveEffectiveFeedbackPolicy({ team: enabled, bot: { enabled: false }, chat: { enabled: true } })).toMatchObject({ enabled: true });
  });

  it('replaces arrays atomically rather than concatenating them', () => {
    const buttons = [
      { key: 'yes', label: 'Yes', semantic: 'positive', style: 'primary' },
      { key: 'no', label: 'No', semantic: 'negative', style: 'danger' },
    ] as const;
    const policy = resolveEffectiveFeedbackPolicy({
      team: enabled,
      bot: { visibleSemantics: ['positive', 'negative'], buttons: [...buttons] },
      chat: { negativeFollowup: { reasons: [{ key: 'wrong', label: 'Wrong' }] } },
    });
    expect(policy?.buttons.map(button => button.key)).toEqual(['yes', 'no']);
    expect(policy?.negativeFollowup.reasons).toEqual([{ key: 'wrong', label: 'Wrong' }]);
  });

  it('rejects unknown keys and malformed atomic arrays during layer validation', () => {
    expect(() => normalizeFeedbackPolicyLayer({ enabled: true, mystery: 1 })).toThrow(/unknown/);
    expect(() => normalizeFeedbackPolicyLayer({ buttons: { key: 'not-an-array' } })).toThrow(/buttons/);
    expect(() => normalizeFeedbackPolicyLayer({ buttons: [{ key: 'broken' }] })).toThrow(/buttons/);
    expect(() => normalizeFeedbackPolicyLayer({ visibleSemantics: ['positive', 'bogus'] })).toThrow(/visibleSemantics/);
  });

  it('keeps enabled partial layers partial so inherited fields survive persistence and restart', async () => {
    const { parseBotConfigsFromText } = await import('../src/bot-registry.js');
    const [bot] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'app', larkAppSecret: 'secret', cliId: 'claude',
      feedback: { enabled: true, allowReselect: true },
      chatFeedbackPolicies: { chat: { enabled: true, negativeFollowup: { comment: { required: true } } } },
    }]));
    expect(bot.feedback).toEqual({ enabled: true, allowReselect: true });
    expect(bot.chatFeedbackPolicies?.chat).toEqual({
      enabled: true, negativeFollowup: { comment: { required: true } },
    });
    expect(resolveEffectiveFeedbackPolicy({
      team: { enabled: true, negativeFollowup: { comment: { placeholder: 'inherited' } } },
      bot: bot.feedback,
      chat: bot.chatFeedbackPolicies?.chat,
    })).toMatchObject({
      allowReselect: true,
      negativeFollowup: { comment: { required: true, placeholder: 'inherited' } },
    });
  });

  it('always disables api-only bots and returns a deep snapshot', () => {
    const layer: any = { enabled: true, negativeFollowup: { comment: { placeholder: 'before' } } };
    expect(resolveEffectiveFeedbackPolicy({ bot: layer, apiOnly: true })).toBeUndefined();
    const policy = resolveEffectiveFeedbackPolicy({ bot: layer })!;
    layer.negativeFollowup.comment.placeholder = 'after';
    expect(policy.negativeFollowup.comment.placeholder).toBe('before');
  });

  it('uses only explicit local chat bindings and fails closed on multi-team ambiguity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'feedback-resolution-'));
    const a = createTeam(dataDir, 'A');
    const b = createTeam(dataDir, 'B');
    setTeamFeedbackPolicy(dataDir, a.id, { enabled: true, allowReselect: true });
    setTeamFeedbackPolicy(dataDir, b.id, { enabled: true });

    expect(resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: 'app', chatId: 'ordinary', bot: {} })).toBeUndefined();
    recordTeamGroup(dataDir, a.id, 'chat-a');
    expect(resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: 'app', chatId: 'chat-a', bot: {} })).toMatchObject({ allowReselect: true });
    recordTeamGroup(dataDir, b.id, 'chat-a');
    expect(resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: 'app', chatId: 'chat-a', bot: enabled })).toBeUndefined();
  });

  it('scopes chat overrides by bot app id', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'feedback-resolution-'));
    const botA = { feedback: enabled, chatFeedbackPolicies: { sameChat: { enabled: false } } };
    const botB = { feedback: enabled, chatFeedbackPolicies: { sameChat: { allowReselect: true } } };
    expect(resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: 'appA', chatId: 'sameChat', bot: botA })).toBeUndefined();
    expect(resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: 'appB', chatId: 'sameChat', bot: botB })).toMatchObject({ allowReselect: true });
  });

  it('merges a reviewers allowlist across layers and fails closed on an invalid merged whole', () => {
    // audience and reviewers may legitimately arrive from different layers.
    expect(resolveEffectiveFeedbackPolicy({
      team: { enabled: true },
      bot: { audience: 'reviewers' },
      chat: { reviewers: ['ou_alice', 'on_bob'] },
    })).toMatchObject({ enabled: true, audience: 'reviewers', reviewers: ['ou_alice', 'on_bob'] });

    // A later layer atomically replaces the allowlist rather than concatenating.
    expect(resolveEffectiveFeedbackPolicy({
      team: { enabled: true, audience: 'reviewers', reviewers: ['ou_alice'] },
      chat: { reviewers: ['ou_carol'] },
    })).toMatchObject({ audience: 'reviewers', reviewers: ['ou_carol'] });

    // Individually-valid layers can merge into an invalid whole (reviewers
    // audience with an empty allowlist, or an allowlist without the audience) —
    // fail closed instead of shipping a dead or mis-gated button.
    expect(resolveEffectiveFeedbackPolicy({ team: { enabled: true, audience: 'reviewers' } })).toBeUndefined();
    expect(resolveEffectiveFeedbackPolicy({ team: { enabled: true, reviewers: ['ou_alice'] } })).toBeUndefined();
  });

  it('format-validates a reviewers layer but leaves the audience coupling to the merged whole', () => {
    // A partial layer may carry reviewers without audience (the coupling is only
    // enforced once merged), but the entries must still be verifiable ids.
    expect(normalizeFeedbackPolicyLayer({ reviewers: ['ou_alice', 'on_bob'] })).toMatchObject({ reviewers: ['ou_alice', 'on_bob'] });
    expect(() => normalizeFeedbackPolicyLayer({ reviewers: ['alice@example.com'] })).toThrow(/open_id or on_ union_id/);
    expect(() => normalizeFeedbackPolicyLayer({ reviewers: 'ou_alice' })).toThrow(/reviewers/);
    expect(() => normalizeFeedbackPolicyLayer({ audience: 'anyone' })).toThrow(/audience/);
  });

  it('traces the effective source chain and reports ambiguous local team bindings', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'feedback-trace-'));
    const a = createTeam(dataDir, 'A');
    const b = createTeam(dataDir, 'B');
    setTeamFeedbackPolicy(dataDir, a.id, { enabled: true, allowReselect: true });
    recordTeamGroup(dataDir, a.id, 'chat');
    const traced = traceFeedbackPolicyForDelivery({
      dataDir, larkAppId: 'app', chatId: 'chat',
      bot: { feedback: { allowReselect: false }, chatFeedbackPolicies: { chat: { enabled: false } } },
    });
    expect(traced).toMatchObject({
      teamId: a.id,
      layers: { team: { enabled: true }, bot: { allowReselect: false }, chat: { enabled: false } },
      effective: null,
      reason: 'disabled',
      sources: { enabled: 'chat', allowReselect: 'bot' },
    });
    recordTeamGroup(dataDir, b.id, 'chat');
    expect(traceFeedbackPolicyForDelivery({ dataDir, larkAppId: 'app', chatId: 'chat', bot: {} })).toMatchObject({
      effective: null, reason: 'ambiguous_team', teamId: null,
    });
  });
});
