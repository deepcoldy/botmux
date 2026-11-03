import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import {
  reconcilePrincipalLaneRecovery,
  terminalizePrincipalLaneAttemptingHead,
} from '../src/core/principal-lane-recovery.js';

const caller = {
  requestUserOpenId: 'ou_b',
  requestLarkAppId: 'app',
  senderType: 'user' as const,
};

function laneSession(): Session {
  return {
    sessionId: 'lane-session',
    chatId: 'oc_group',
    rootMessageId: 'om_root',
    status: 'active',
    createdAt: '2026-09-22T00:00:00.000Z',
    principalLane: {
      version: 1,
      sourceSessionId: 'source-session',
      laneId: 'lane-b',
      sessionId: 'lane-session',
      principalKey: 'user:open:ou_b',
      principal: { kind: 'open_id', openId: 'ou_b' },
      routingAnchor: 'principal-lane:source-session:lane-b',
      displayTarget: { kind: 'chat', chatId: 'oc_group' },
      workspaceEpoch: 1,
      phase: 'active',
      revision: 1,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    },
    principalLaneQueuedTurns: [
      {
        version: 1,
        turnId: 'om_attempting',
        caller,
        userPrompt: 'first',
        title: 'first',
        cliInput: { content: 'first', resources: [] },
        createdAt: '2026-09-22T00:00:01.000Z',
        resume: true,
        dispatchState: 'attempting',
      },
      {
        version: 1,
        turnId: 'om_next',
        caller,
        userPrompt: 'next',
        title: 'next',
        cliInput: { content: 'next', resources: [] },
        createdAt: '2026-09-22T00:00:02.000Z',
        resume: true,
        dispatchState: 'queued',
      },
    ],
  } as Session;
}

describe('principal lane boot recovery', () => {
  it('atomically removes only the attempting head and persists a separate notice', () => {
    const session = laneSession();
    const result = reconcilePrincipalLaneRecovery(session, '2026-09-22T01:00:00.000Z');

    expect(result).toMatchObject({ changed: true, quarantined: false });
    expect(session.principalLaneQueuedTurns).toMatchObject([
      { turnId: 'om_next', dispatchState: 'queued' },
    ]);
    expect(session.principalLaneDispatchUnknownNotices).toMatchObject([
      { turnId: 'om_attempting', noticePending: true },
    ]);
    expect(result.notices).toMatchObject([
      { kind: 'principal_lane_dispatch_unknown', turnId: 'om_attempting' },
    ]);

    const second = reconcilePrincipalLaneRecovery(session, '2026-09-22T02:00:00.000Z');
    expect(second.changed).toBe(false);
    expect(second.notices).toHaveLength(1);
    expect(session.principalLaneQueuedTurns).toHaveLength(1);
  });

  it('refuses an attempting record outside the FIFO head', () => {
    const session = laneSession();
    session.principalLaneQueuedTurns![0]!.dispatchState = 'queued';
    session.principalLaneQueuedTurns![1]!.dispatchState = 'attempting';

    const result = reconcilePrincipalLaneRecovery(session, '2026-09-22T01:00:00.000Z');
    expect(result.quarantined).toBe(true);
    expect(session.restoreQuarantinedAt).toBe('2026-09-22T01:00:00.000Z');
    expect(session.principalLaneQueuedTurns).toHaveLength(2);
  });

  it('does not terminalize a stale or mismatched turn id', () => {
    const session = laneSession();
    expect(terminalizePrincipalLaneAttemptingHead(
      session,
      'om_stale',
      '2026-09-22T01:00:00.000Z',
    )).toBeUndefined();
    expect(session.principalLaneQueuedTurns?.[0]?.turnId).toBe('om_attempting');
    expect(session.principalLaneDispatchUnknownNotices).toBeUndefined();
  });
});
