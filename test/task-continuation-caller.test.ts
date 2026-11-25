import { describe, expect, it } from 'vitest';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import {
  buildTaskContinuationCaller,
  reforkActivationTrustedCaller,
  taskContinuationSourceOpenId,
} from '../src/core/task-continuation-caller.js';

const APP_ID = 'cli_continuation';
const HUMAN = 'ou_original_human';

function sourceSession(senderOpenId = HUMAN, isBot = false): any {
  const session: any = {
    sessionId: 'source-session',
    status: 'active',
    chatId: 'oc_source',
    rootMessageId: 'om_root',
    scope: 'thread',
  };
  const ds: any = { scope: 'thread', chatId: 'oc_source', session };
  beginReplyTargetTurn(ds, undefined, 'om_source_turn', '2026-11-25T00:00:00.000Z', {
    senderOpenId,
    participants: [{ openId: senderOpenId, isBot }],
    sourceMessageId: 'om_source_turn',
  });
  return ds.session;
}

const botCaller = {
  requestLarkAppId: APP_ID,
  requestUserOpenId: 'ou_reply_bot',
  requestUserUnionId: 'on_reply_bot',
  senderType: 'bot' as const,
};

const humanPrincipal = {
  requestLarkAppId: APP_ID,
  requestUserOpenId: HUMAN,
  requestUserUnionId: 'on_original_human',
  verifiedEmail: 'human@bytedance.com',
  senderType: 'user' as const,
};

describe('cross-chat task continuation caller', () => {
  it('keeps the reply bot as actor and attaches the exact source-turn human separately', () => {
    const session = sourceSession();
    expect(taskContinuationSourceOpenId(session, 'om_source_turn')).toBe(HUMAN);
    expect(buildTaskContinuationCaller({
      rawCaller: botCaller,
      sourcePrincipal: humanPrincipal,
      larkAppId: APP_ID,
      sourceSession: session,
      sourceTurnId: 'om_source_turn',
    })).toEqual({
      ...botCaller,
      taskContinuation: {
        appId: APP_ID,
        openId: HUMAN,
        unionId: 'on_original_human',
        verifiedEmail: 'human@bytedance.com',
        sourceSessionId: 'source-session',
        sourceTurnId: 'om_source_turn',
      },
    });
  });

  it.each([
    ['source turn is missing', sourceSession(), 'om_missing', botCaller, humanPrincipal],
    ['source turn was opened by a bot', sourceSession(HUMAN, true), 'om_source_turn', botCaller, humanPrincipal],
    ['source session is closed', { ...sourceSession(), status: 'closed' }, 'om_source_turn', botCaller, humanPrincipal],
    ['source principal is another human', sourceSession(), 'om_source_turn', botCaller,
      { ...humanPrincipal, requestUserOpenId: 'ou_other_human' }],
    ['current actor is not a bot', sourceSession(), 'om_source_turn',
      { ...botCaller, senderType: 'user' as const }, humanPrincipal],
  ])('fails closed when %s', (_label, session, sourceTurnId, rawCaller, sourcePrincipal) => {
    expect(buildTaskContinuationCaller({
      rawCaller,
      sourcePrincipal,
      larkAppId: APP_ID,
      sourceSession: session,
      sourceTurnId,
    })).toBeUndefined();
  });

  it('does not authenticate synthetic, recovered, cross-chat, or pruned source turns', () => {
    const synthetic = sourceSession();
    synthetic.replyTargets['schedule:task'] = synthetic.replyTargets.om_source_turn;
    expect(taskContinuationSourceOpenId(synthetic, 'schedule:task')).toBeUndefined();

    const recovered = sourceSession();
    recovered.ordinaryTurnRecovery = {
      logicalTurnId: 'om_original',
      currentTurnId: 'om_source_turn',
    };
    expect(taskContinuationSourceOpenId(recovered, 'om_source_turn')).toBeUndefined();

    const crossChat = sourceSession();
    crossChat.replyTargets.om_source_turn.crossChatOrigin = {
      sourceChatId: 'oc_a', followedChatId: 'oc_b', followedRootMessageId: 'om_b',
    };
    expect(taskContinuationSourceOpenId(crossChat, 'om_source_turn')).toBeUndefined();

    const pruned = sourceSession();
    delete pruned.replyTargets.om_source_turn;
    expect(taskContinuationSourceOpenId(pruned, 'om_source_turn')).toBeUndefined();
  });

  it('keeps a continuation on its durable follower instead of copying it onto an older queued head', () => {
    const continuation = buildTaskContinuationCaller({
      rawCaller: botCaller,
      sourcePrincipal: humanPrincipal,
      larkAppId: APP_ID,
      sourceSession: sourceSession(),
      sourceTurnId: 'om_source_turn',
    });
    expect(reforkActivationTrustedCaller({
      threadCaller: undefined,
      continuationCaller: continuation,
      queuedHasDurableTail: true,
    })).toBeUndefined();
    expect(reforkActivationTrustedCaller({
      threadCaller: undefined,
      continuationCaller: continuation,
      queuedHasDurableTail: false,
    })).toBe(continuation);
    expect(reforkActivationTrustedCaller({
      threadCaller: humanPrincipal,
      continuationCaller: continuation,
      queuedHasDurableTail: true,
    })).toBe(humanPrincipal);
  });
});
