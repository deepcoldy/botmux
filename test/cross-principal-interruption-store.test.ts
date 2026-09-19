import { describe, expect, it } from 'vitest';
import {
  CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD,
  continueCrossPrincipalOwnerWait,
  crossPrincipalInterruptionId,
  crossPrincipalOwnerWaitDisposition,
  markCrossPrincipalSuggestionWaiting,
  noteCrossPrincipalProposer,
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
});

describe('bot↔bot auto-reply circuit breaker', () => {
  const botA: TrustedCaller = {
    requestUserOpenId: 'ou_bot_a',
    requestUserUnionId: 'on_bot_a',
    requestLarkAppId: 'app_test',
    senderType: 'bot',
  };
  const botC: TrustedCaller = {
    requestUserOpenId: 'ou_bot_c',
    requestUserUnionId: 'on_bot_c',
    requestLarkAppId: 'app_test',
    senderType: 'bot',
  };
  const human: TrustedCaller = { ...owner, senderType: 'user' };

  it('never suppresses a human proposer and keeps every tally at zero', () => {
    const source = session();
    for (let i = 0; i < CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD + 5; i++) {
      const guard = noteCrossPrincipalProposer(source, human);
      expect(guard.suppressAckPrompt).toBe(false);
      expect(guard.consecutiveBotInterruptions).toBe(0);
    }
    expect(source.crossPrincipalBotInterruptionCounts).toBeFalsy();
  });

  it('suppresses only after more than the threshold interruptions from the same bot', () => {
    const source = session();
    for (let n = 1; n <= CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD; n++) {
      const guard = noteCrossPrincipalProposer(source, botA);
      expect(guard.consecutiveBotInterruptions).toBe(n);
      expect(guard.suppressAckPrompt).toBe(false);
    }
    const tripped = noteCrossPrincipalProposer(source, botA);
    expect(tripped.consecutiveBotInterruptions).toBe(CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD + 1);
    expect(tripped.suppressAckPrompt).toBe(true);
    // Stays tripped while the same bot keeps interrupting.
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(true);
  });

  it('a human proposer clears the tally so the next storm gets full runway again', () => {
    const source = session();
    for (let n = 0; n <= CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD; n++) noteCrossPrincipalProposer(source, botA);
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(true);

    // A person messaging mid-storm clears it.
    expect(noteCrossPrincipalProposer(source, human).suppressAckPrompt).toBe(false);
    expect(source.crossPrincipalBotInterruptionCounts).toBeFalsy();

    // The next bot interruption is treated as the start of a fresh sequence.
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(false);
  });

  // The defect this fix targets (高志坤, 2026-09-18): with a single session-wide
  // counter, an unrelated bot's FIRST legitimate interruption was suppressed
  // merely because a different bot had already interrupted. Per-proposer keying
  // must let bot C through on its first interruption even after bot A has
  // tripped its own breaker.
  it('does not penalise a second, distinct bot for the first bot\'s tally', () => {
    const source = session();
    // Bot A storms until it is suppressed.
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(false);
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(true);
    // Bot C interrupts for the first time — must still get its one prompt.
    const cFirst = noteCrossPrincipalProposer(source, botC);
    expect(cFirst.consecutiveBotInterruptions).toBe(1);
    expect(cFirst.suppressAckPrompt).toBe(false);
    // C's own second interruption is suppressed (C is now the one looping);
    // A remains suppressed independently.
    expect(noteCrossPrincipalProposer(source, botC).suppressAckPrompt).toBe(true);
    expect(noteCrossPrincipalProposer(source, botA).suppressAckPrompt).toBe(true);
  });

  // A bot proposer with no id at all collapses to a shared `unknown` bucket:
  // still throttled (conservative), but never keyed as an identifiable bot.
  it('throttles unattributable bot proposers via a shared unknown bucket', () => {
    const source = session();
    const anonBot: TrustedCaller = { requestLarkAppId: 'app_test', senderType: 'bot' };
    expect(noteCrossPrincipalProposer(source, anonBot).suppressAckPrompt).toBe(false);
    expect(noteCrossPrincipalProposer(source, anonBot).suppressAckPrompt).toBe(true);
  });

  // Pins the ratified threshold independently of the constant. The other cases
  // in this block loop over CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD, so they self-
  // adapt and stay green at any value; these literals fail if the threshold
  // drifts off 1. Product decision (2026-09-18): the first interruption from a
  // given bot gets exactly one prompt, every later one is silenced until a
  // human breaks the run — larger values only emit noise cards.
  it('threshold is pinned to 1: prompt on the first bot interruption, suppress from the second', () => {
    expect(CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD).toBe(1);
    const source = session();
    const first = noteCrossPrincipalProposer(source, botA);
    expect(first.consecutiveBotInterruptions).toBe(1);
    expect(first.suppressAckPrompt).toBe(false); // one prompt goes out
    const second = noteCrossPrincipalProposer(source, botA);
    expect(second.consecutiveBotInterruptions).toBe(2);
    expect(second.suppressAckPrompt).toBe(true); // silenced from here on
  });
});
