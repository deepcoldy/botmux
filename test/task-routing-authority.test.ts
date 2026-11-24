import { describe, expect, it } from 'vitest';
import {
  authorizeTaskRoutingSessionAction,
  type TaskRoutingSessionAuthorityInput,
} from '../src/core/task-routing/authority.js';

function baseInput(
  overrides: Partial<TaskRoutingSessionAuthorityInput> = {},
): TaskRoutingSessionAuthorityInput {
  return {
    action: 'run',
    larkAppId: 'cli_bot1',
    chatId: 'oc_group_regular',
    chatType: 'group',
    scope: 'thread',
    session: {},
    transportDisabled: false,
    turnId: 'om_turn_1',
    adminOpenIds: ['ou_owner'],
    canOperate: openId => openId === 'ou_owner',
    ...overrides,
  };
}

describe('task-routing caller authority gate', () => {
  it('allows owner-initiated direct human turns for assign run', () => {
    const res = authorizeTaskRoutingSessionAction(baseInput({
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_owner',
        senderType: 'user',
      },
    }));
    expect(res).toEqual({ ok: true, callerKind: 'owner_turn', turnId: 'om_turn_1' });
  });

  it('rejects non-owner human turns in regular groups for assign run', () => {
    const res = authorizeTaskRoutingSessionAction(baseInput({
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_colleague',
        senderType: 'user',
      },
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('fails closed on open bots with empty adminOpenIds even when canOperate returns true', () => {
    const res = authorizeTaskRoutingSessionAction(baseInput({
      adminOpenIds: [],
      canOperate: () => true,
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_anyone',
        senderType: 'user',
      },
    }));
    expect(res.ok).toBe(false);
  });

  it('rejects bot-triggered, webhook, silent-listener, and recovery turns for assign run', () => {
    const botTurn = authorizeTaskRoutingSessionAction(baseInput({
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_peer_bot',
        senderType: 'bot',
      },
    }));
    expect(botTurn.ok).toBe(false);

    const listenerTurn = authorizeTaskRoutingSessionAction(baseInput({
      session: { messageListenerRun: { sourceMessageId: 'om_ml_1', replyMode: 'none' } },
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_owner',
        senderType: 'user',
      },
    }));
    expect(listenerTurn.ok).toBe(false);

    const recoveryTurn = authorizeTaskRoutingSessionAction(baseInput({
      session: {
        failedTurnRecovery: {
          turnId: 'om_turn_1',
          caller: { requestLarkAppId: 'cli_bot1', requestUserOpenId: 'ou_owner', senderType: 'user' },
        } as any,
      },
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_owner',
        senderType: 'user',
      },
    }));
    expect(recoveryTurn.ok).toBe(false);
  });

  it('allows steward sessions in the steward chat for owner batches and patrol schedules, but blocks non-owner humans or foreign groups', () => {
    const steward = { enabled: true, chatId: 'oc_steward_chat' };

    const batchTurn = authorizeTaskRoutingSessionAction(baseInput({
      chatId: 'oc_steward_chat',
      scope: 'chat',
      steward,
      turnId: 'board:cli_bot1:42',
    }));
    expect(batchTurn).toEqual({ ok: true, callerKind: 'steward_session', turnId: 'board:cli_bot1:42' });

    const patrolTurn = authorizeTaskRoutingSessionAction(baseInput({
      chatId: 'oc_steward_chat',
      scope: 'chat',
      steward,
      turnId: 'sched:patrol-1',
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_owner',
        senderType: 'user',
        source: 'schedule_creator',
      },
    }));
    expect(patrolTurn).toEqual({ ok: true, callerKind: 'steward_session', turnId: 'sched:patrol-1' });

    // Non-owner schedule_creator even inside steward chat must still be rejected!
    const nonOwnerSchedule = authorizeTaskRoutingSessionAction(baseInput({
      chatId: 'oc_steward_chat',
      scope: 'chat',
      steward,
      turnId: 'sched:patrol-2',
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_stranger',
        senderType: 'user',
        source: 'schedule_creator',
      },
    }));
    expect(nonOwnerSchedule.ok).toBe(false);

    // Non-owner human speaking even inside steward chat must still be rejected!
    const intruderInSteward = authorizeTaskRoutingSessionAction(baseInput({
      chatId: 'oc_steward_chat',
      scope: 'chat',
      steward,
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_stranger',
        senderType: 'user',
      },
    }));
    expect(intruderInSteward.ok).toBe(false);

    // Steward bot invoked by a non-owner in a regular group must NOT inherit steward privilege!
    const stewardInOtherGroup = authorizeTaskRoutingSessionAction(baseInput({
      chatId: 'oc_other_group',
      steward,
      liveTrustedCaller: {
        requestLarkAppId: 'cli_bot1',
        requestUserOpenId: 'ou_colleague',
        senderType: 'user',
      },
    }));
    expect(stewardInOtherGroup.ok).toBe(false);
  });

  it('allows read-only recommend/status/history in regular sessions while blocking receiver and assistant sessions', () => {
    for (const action of ['status', 'recommend', 'history'] as const) {
      const ok = authorizeTaskRoutingSessionAction(baseInput({
        action,
        liveTrustedCaller: {
          requestLarkAppId: 'cli_bot1',
          requestUserOpenId: 'ou_colleague',
          senderType: 'user',
        },
      }));
      expect(ok.ok).toBe(true);

      const receiverBlocked = authorizeTaskRoutingSessionAction(baseInput({
        action,
        session: { vcMeetingReceiver: { meetingId: 'm1' } as any },
      }));
      expect(receiverBlocked.ok).toBe(false);

      const assistantBlocked = authorizeTaskRoutingSessionAction(baseInput({
        action,
        session: { assistantOwnerOpenId: 'ou_someone' },
      }));
      expect(assistantBlocked.ok).toBe(false);
    }
  });
});
