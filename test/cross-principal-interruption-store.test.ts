import { describe, expect, it } from 'vitest';
import {
  cancelCrossPrincipalInterruptionsForFeatureDisable,
  continueCrossPrincipalOwnerWait,
  crossPrincipalInterruptionId,
  crossPrincipalOwnerWaitDisposition,
  markCrossPrincipalSuggestionWaiting,
  stageCrossPrincipalInterruptionRecord,
} from '../src/core/cross-principal-interruption-store.js';
import type { Session, TrustedCaller } from '../src/types.js';

const owner: TrustedCaller = {
  requestUserOpenId: 'ou_a',
  requestUserUnionId: 'on_a',
  requestLarkAppId: 'app_test',
  senderType: 'user',
};
const proposer: TrustedCaller = {
  requestUserOpenId: 'ou_b',
  requestUserUnionId: 'on_b',
  requestLarkAppId: 'app_test',
  senderType: 'user',
};

function session(): Session {
  return {
    sessionId: 'sid_source',
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    title: 'source',
    status: 'active',
    createdAt: '2026-09-09T00:00:00.000Z',
    chatType: 'group',
  };
}

describe('cross-principal interruption durable identity', () => {
  it('uses source session + turn only, independent of delivery generation or attempt', () => {
    expect(crossPrincipalInterruptionId('sid_source', 'om_turn'))
      .toBe(crossPrincipalInterruptionId('sid_source', 'om_turn'));
    expect(crossPrincipalInterruptionId('sid_other', 'om_turn'))
      .not.toBe(crossPrincipalInterruptionId('sid_source', 'om_turn'));
  });

  it('merges duplicate pre-admission rejects into one record and one executable message', () => {
    const source = session();
    const args = {
      session: source,
      ownerTurnId: 'om_a',
      owner,
      ownerUserPrompt: 'A original task',
      proposer,
      message: {
        turnId: 'om_b',
        text: 'B input',
        userPrompt: 'B input',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    };

    const first = stageCrossPrincipalInterruptionRecord(args);
    const duplicateAfterWorkerRestart = stageCrossPrincipalInterruptionRecord({
      ...args,
    });

    expect(first.inserted).toBe(true);
    expect(duplicateAfterWorkerRestart.inserted).toBe(false);
    expect(duplicateAfterWorkerRestart.record).toBe(first.record);
    expect(source.crossPrincipalInterruptions).toHaveLength(1);
    expect(source.crossPrincipalInterruptions?.[0]?.messages).toHaveLength(1);
    expect(source.crossPrincipalInterruptions?.[0]?.messages[0]?.turnId).toBe('om_b');
    expect(source.crossPrincipalInterruptions?.[0]?.ownerUserPrompt).toBe('A original task');
  });

  it('does not let a duplicate delivery replace the captured owner prompt', () => {
    const source = session();
    const base = {
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer,
      message: {
        turnId: 'om_b',
        text: 'B input',
        userPrompt: 'B input',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    };

    stageCrossPrincipalInterruptionRecord({ ...base, ownerUserPrompt: 'original A task' });
    const duplicate = stageCrossPrincipalInterruptionRecord({
      ...base,
      ownerUserPrompt: 'later unrelated task',
    });

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.ownerUserPrompt).toBe('original A task');
  });

  it('never defaults bot proposers to suggestion and does not start a pre-card deadline', () => {
    const source = session();
    const botProposer: TrustedCaller = { ...proposer, senderType: 'bot' };
    const { record } = stageCrossPrincipalInterruptionRecord({
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer: botProposer,
      message: {
        turnId: 'om_bot',
        text: 'review finding',
        userPrompt: 'review finding',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    });

    expect(record.phase).toBe('awaiting_classification');
    expect(record.classificationDeadlineAt).toBeUndefined();
    expect(record.ownerDeadlineAt).toBeUndefined();
  });

  it('keeps owner-turn waiting separate from the later confirmation timeout', () => {
    const source = session();
    const { record } = stageCrossPrincipalInterruptionRecord({
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer,
      message: {
        turnId: 'om_b_wait',
        text: 'suggestion',
        userPrompt: 'suggestion',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    });

    markCrossPrincipalSuggestionWaiting(record, 1_000, 10_000);
    expect(record.phase).toBe('awaiting_owner');
    expect(record.ownerWaitDeadlineAt).toBe(11_000);
    expect(record.ownerDeadlineAt).toBeUndefined();
    expect(crossPrincipalOwnerWaitDisposition(record, true, 10_999, 10_000)).toBe('waiting');
    expect(crossPrincipalOwnerWaitDisposition(record, true, 11_000, 10_000)).toBe('proposer_decision');
    expect(crossPrincipalOwnerWaitDisposition(record, false, 11_000, 10_000)).toBe('owner_ready');

    continueCrossPrincipalOwnerWait(record, 20_000, 10_000);
    expect(record.ownerWaitDeadlineAt).toBe(30_000);
    expect(record.waitDecisionRound).toBe(1);
  });

  it('fails closed on disable and keeps a bounded non-runnable audit trail', () => {
    const source = session();
    for (let i = 0; i < 55; i++) {
      stageCrossPrincipalInterruptionRecord({
        session: source,
        ownerTurnId: `om_owner_${i}`,
        owner,
        proposer,
        message: {
          turnId: `om_proposer_${i}`,
          text: `message ${i}`,
          userPrompt: `message ${i}`,
          createdAt: '2026-09-09T00:01:00.000Z',
        },
      });
    }

    const cancelled = cancelCrossPrincipalInterruptionsForFeatureDisable(
      source,
      '2026-09-16T10:00:00.000Z',
    );
    expect(cancelled).toHaveLength(55);
    expect(source.crossPrincipalInterruptions).toBeUndefined();
    expect(source.crossPrincipalInterruptionCancellations).toHaveLength(50);
    expect(source.crossPrincipalInterruptionCancellations?.[0]?.messageTurnIds)
      .toEqual(['om_proposer_5']);
    expect(source.crossPrincipalInterruptionCancellations?.at(-1)).toMatchObject({
      ownerTurnId: 'om_owner_54',
      cancelledAt: '2026-09-16T10:00:00.000Z',
      reason: 'feature_disabled',
    });
    expect(cancelCrossPrincipalInterruptionsForFeatureDisable(source)).toEqual([]);
  });
});
