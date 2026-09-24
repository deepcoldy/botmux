import { describe, expect, it } from 'vitest';
import {
  enqueueXpiSharedCwdTurn,
  finalizeXpiSharedCwdMemberClose,
  MAX_XPI_SHARED_CWD_QUEUED_TURNS,
  reconcileXpiSharedCwdRecovery,
  releaseXpiSharedCwdAdmission,
  selectNextXpiSharedCwdTurn,
  tryAcquireXpiSharedCwdAdmission,
  xpiSharedCwdQueuedTurnId,
} from '../src/core/xpi-shared-cwd-admission.js';
import type { CrossPrincipalInterruption, Session, TrustedCaller } from '../src/types.js';

const caller: TrustedCaller = {
  requestLarkAppId: 'cli_test_app',
  requestUserOpenId: 'ou_synthetic_user',
  requestUserUnionId: 'on_synthetic_user',
  senderType: 'user',
};

function session(id: string, createdAt = '2026-01-01T00:00:00.000Z'): Session {
  return {
    sessionId: id,
    chatId: `chat_${id}`,
    rootMessageId: `root_${id}`,
    title: `synthetic ${id}`,
    status: 'active',
    createdAt,
  };
}

function group(...members: Session[]): Session[] {
  for (const member of members) {
    member.xpiSharedCwdAdmissionGroupId = 'xpi-admission:test';
    member.xpiSharedCwdAdmissionCoordinatorSessionId = members[0]!.sessionId;
  }
  return members;
}

function legacyRecord(overrides: Partial<CrossPrincipalInterruption> = {}): CrossPrincipalInterruption {
  return {
    version: 1,
    id: 'xpi_synthetic_record',
    ownerTurnId: 'turn_owner',
    owner: caller,
    proposer: { ...caller, requestUserOpenId: 'ou_synthetic_proposer' },
    phase: 'awaiting_classification',
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [{
      turnId: 'turn_proposal',
      text: 'synthetic public input',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    ...overrides,
  };
}

describe('narrow XPI shared-cwd admission', () => {
  it('contains an expired legacy XPI record to its own session while healthy rows remain recoverable', () => {
    const stale = session('stale');
    stale.crossPrincipalInterruptions = [legacyRecord({ classificationDeadlineAt: 1 })];
    const healthy = session('healthy');

    const result = reconcileXpiSharedCwdRecovery([stale, healthy], 2);

    expect([...result.quarantinedSessionIds]).toEqual(['stale']);
    expect(stale.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'session',
      reason: 'stale_legacy_xpi_record',
      noticePending: true,
    });
    expect(stale.restoreQuarantinedAt).toBeDefined();
    expect(healthy.xpiSharedCwdQuarantine).toBeUndefined();
  });

  it('keeps a session-local quarantine contained across repeated group recovery', () => {
    const [staleCoordinator, healthyMember] = group(session('stale'), session('healthy'));
    staleCoordinator!.crossPrincipalInterruptions = [legacyRecord({ classificationDeadlineAt: 1 })];

    const first = reconcileXpiSharedCwdRecovery([staleCoordinator!, healthyMember!], 2);

    expect([...first.quarantinedSessionIds]).toEqual(['stale']);
    expect(staleCoordinator!.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'session',
      reason: 'stale_legacy_xpi_record',
    });
    expect(staleCoordinator!.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(healthyMember!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('healthy');

    const second = reconcileXpiSharedCwdRecovery([staleCoordinator!, healthyMember!], 3);
    expect([...second.quarantinedSessionIds]).toEqual(['stale']);
    expect(healthyMember!.xpiSharedCwdQuarantine).toBeUndefined();
    expect(healthyMember!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('healthy');
  });

  it('contains one malformed queued record without quarantining its healthy group peer', () => {
    const [badCoordinator, healthyMember] = group(session('bad'), session('healthy'));
    badCoordinator!.xpiSharedCwdQueuedTurns = [{
      version: 1,
      id: 'not-the-derived-id',
      turnId: 'turn_bad',
      caller,
      userPrompt: 'bad',
      cliInput: { content: 'bad' },
      resume: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    }];

    const result = reconcileXpiSharedCwdRecovery([badCoordinator!, healthyMember!], Date.now());

    expect([...result.quarantinedSessionIds]).toEqual(['bad']);
    expect(badCoordinator!.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'session',
      reason: 'malformed_queue',
    });
    expect(badCoordinator!.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(healthyMember!.xpiSharedCwdQuarantine).toBeUndefined();
    expect(healthyMember!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('healthy');
  });

  it('contains ambiguous authority to one explicit group without quarantining unrelated sessions', () => {
    const [coordinator, member] = group(session('coordinator'), session('member'));
    const unrelated = session('unrelated');
    coordinator!.workerGeneration = 4;
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'member',
      turnId: 'turn_inflight',
      workerGeneration: 9,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = reconcileXpiSharedCwdRecovery([coordinator!, member!, unrelated], Date.now());

    expect([...result.quarantinedSessionIds].sort()).toEqual(['coordinator', 'member']);
    expect(unrelated.xpiSharedCwdQuarantine).toBeUndefined();
  });

  it('terminalizes an exact accepted journal on restart without freezing the healthy group', () => {
    const [coordinator, member] = group(session('coordinator'), session('member'));
    member!.workerGeneration = 9;
    const { record } = enqueueXpiSharedCwdTurn({
      session: member!,
      turnId: 'turn_inflight',
      caller,
      userPrompt: 'retained until exact terminal release',
      cliInput: { content: 'retained until exact terminal release' },
      resume: false,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    record.dispatchState = 'attempting';
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'member',
      turnId: 'turn_inflight',
      workerGeneration: 9,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = reconcileXpiSharedCwdRecovery([coordinator!, member!], Date.now());

    expect([...result.quarantinedSessionIds]).toEqual([]);
    expect(coordinator!.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(coordinator!.xpiSharedCwdQuarantine).toBeUndefined();
    expect(member!.xpiSharedCwdQuarantine).toBeUndefined();
    expect(member!.xpiSharedCwdQueuedTurns).toBeUndefined();
    expect(member!.xpiSharedCwdDispatchUnknownNotices).toEqual([expect.objectContaining({
      id: xpiSharedCwdQueuedTurnId('member', 'turn_inflight'),
      turnId: 'turn_inflight',
      noticePending: true,
    })]);
    expect(result.dispatchUnknownNotices).toEqual([expect.objectContaining({
      sessionId: 'member',
      turnId: 'turn_inflight',
    })]);
  });

  it('releases only the exact holder generation and exact terminal turn', () => {
    const [coordinator, member] = group(session('coordinator'), session('member'));
    const members = [coordinator!, member!];
    const acquired = tryAcquireXpiSharedCwdAdmission({
      sessions: members,
      member: member!,
      turnId: 'turn_new',
      workerGeneration: 12,
      now: '2026-01-01T00:00:01.000Z',
    });
    expect(acquired.status).toBe('acquired');

    expect(releaseXpiSharedCwdAdmission({
      sessions: members,
      member: member!,
      turnId: 'turn_new',
      workerGeneration: 11,
      reason: 'terminal',
    }).released).toBe(false);
    expect(releaseXpiSharedCwdAdmission({
      sessions: members,
      member: member!,
      turnId: 'turn_old',
      workerGeneration: 12,
      reason: 'terminal',
    }).released).toBe(false);
    expect(coordinator!.xpiSharedCwdAdmissionLease).toBeDefined();

    expect(releaseXpiSharedCwdAdmission({
      sessions: members,
      member: member!,
      turnId: 'turn_new',
      workerGeneration: 12,
      reason: 'terminal',
    }).released).toBe(true);
    expect(coordinator!.xpiSharedCwdAdmissionLease).toBeUndefined();
  });

  it('lets a proven worker exit release by generation without borrowing route authority', () => {
    const [coordinator, member] = group(session('coordinator'), session('member'));
    const routeRecord = legacyRecord({ phase: 'awaiting_owner', ownerDeadlineAt: 99_999 });
    member!.crossPrincipalInterruptions = [routeRecord];
    tryAcquireXpiSharedCwdAdmission({
      sessions: [coordinator!, member!],
      member: member!,
      turnId: 'turn_crashed',
      workerGeneration: 7,
      now: '2026-01-01T00:00:01.000Z',
    });

    expect(releaseXpiSharedCwdAdmission({
      sessions: [coordinator!, member!],
      member: member!,
      workerGeneration: 7,
      reason: 'worker_exit',
    }).released).toBe(true);
    expect(member!.crossPrincipalInterruptions).toEqual([routeRecord]);
  });

  it('selects one durable queue head at a time in global FIFO order', () => {
    const [coordinator, laterSession] = group(
      session('coordinator', '2026-01-01T00:00:00.000Z'),
      session('later', '2026-01-01T00:00:01.000Z'),
    );
    enqueueXpiSharedCwdTurn({
      session: laterSession!,
      turnId: 'turn_later',
      caller,
      userPrompt: 'later',
      cliInput: { content: 'later' },
      resume: true,
      createdAt: '2026-01-01T00:00:03.000Z',
    });
    enqueueXpiSharedCwdTurn({
      session: coordinator!,
      turnId: 'turn_first',
      caller,
      userPrompt: 'first',
      cliInput: { content: 'first' },
      resume: true,
      createdAt: '2026-01-01T00:00:02.000Z',
    });

    expect(selectNextXpiSharedCwdTurn([laterSession!, coordinator!], 'xpi-admission:test')?.record.turnId)
      .toBe('turn_first');
  });

  it('parks a restore-quarantined FIFO head visibly before advancing the healthy group', () => {
    const [blocked, healthy] = group(session('blocked'), session('healthy'));
    blocked!.restoreQuarantinedAt = '2026-01-01T00:00:01.000Z';
    enqueueXpiSharedCwdTurn({
      session: blocked!,
      turnId: 'turn_blocked',
      caller,
      userPrompt: 'park me visibly',
      cliInput: { content: 'park me visibly' },
      resume: true,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    enqueueXpiSharedCwdTurn({
      session: healthy!,
      turnId: 'turn_healthy',
      caller,
      userPrompt: 'still runnable',
      cliInput: { content: 'still runnable' },
      resume: true,
      createdAt: '2026-01-01T00:00:03.000Z',
    });

    const result = reconcileXpiSharedCwdRecovery(
      [blocked!, healthy!],
      Date.now(),
      { containRestoreQuarantinedSessionIds: new Set(['blocked']) },
    );

    expect(blocked!.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'session',
      reason: 'restore_quarantined_member',
      noticePending: true,
    });
    expect(result.notices).toEqual([expect.objectContaining({
      sessionId: 'blocked',
      reason: 'restore_quarantined_member',
      detail: expect.stringContaining('1 queued turn(s)'),
    })]);
    expect(blocked!.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(blocked!.xpiSharedCwdQueuedTurns?.[0]?.turnId).toBe('turn_blocked');
    expect(healthy!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('healthy');
    expect(selectNextXpiSharedCwdTurn([blocked!, healthy!], 'xpi-admission:test')?.record.turnId)
      .toBe('turn_healthy');
  });

  it('does not preempt a restore-quarantined member before restore has tried to reclaim it', () => {
    const [member, peer] = group(session('reclaimable'), session('peer'));
    member!.restoreQuarantinedAt = '2026-01-01T00:00:01.000Z';

    const result = reconcileXpiSharedCwdRecovery([member!, peer!], Date.now());

    expect(result.quarantinedSessionIds.size).toBe(0);
    expect(member!.xpiSharedCwdQuarantine).toBeUndefined();
    expect(member!.xpiSharedCwdAdmissionGroupId).toBe('xpi-admission:test');
  });

  it('rejects a new grouped turn once the durable per-session FIFO is full', () => {
    const member = session('bounded');
    member.xpiSharedCwdQueuedTurns = Array.from(
      { length: MAX_XPI_SHARED_CWD_QUEUED_TURNS },
      (_, index) => ({
        version: 1 as const,
        id: xpiSharedCwdQueuedTurnId(member.sessionId, `turn_${index}`),
        turnId: `turn_${index}`,
        caller,
        userPrompt: `queued ${index}`,
        cliInput: { content: `queued ${index}` },
        resume: true,
        createdAt: new Date(index).toISOString(),
        dispatchState: 'queued' as const,
      }),
    );

    const before = structuredClone(member.xpiSharedCwdQueuedTurns);
    const duplicate = enqueueXpiSharedCwdTurn({
      session: member,
      turnId: 'turn_0',
      caller,
      userPrompt: 'a retry must remain idempotent even while full',
      cliInput: { content: 'a retry must remain idempotent even while full' },
      resume: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(duplicate.inserted).toBe(false);
    expect(member.xpiSharedCwdQueuedTurns).toEqual(before);

    expect(() => enqueueXpiSharedCwdTurn({
      session: member,
      turnId: 'turn_overflow',
      caller,
      userPrompt: 'must not be silently accepted',
      cliInput: { content: 'must not be silently accepted' },
      resume: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })).toThrow('XPI shared-cwd queue is full');
    expect(member.xpiSharedCwdQueuedTurns).toEqual(before);
  });

  it('migrates a closed coordinator only after its exact holder generation is proven exited', () => {
    const [coordinator, successor] = group(
      session('coordinator', '2026-01-01T00:00:00.000Z'),
      session('successor', '2026-01-01T00:00:01.000Z'),
    );
    coordinator!.status = 'closed';
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'coordinator',
      turnId: 'turn_closing',
      workerGeneration: 4,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = finalizeXpiSharedCwdMemberClose({
      sessions: [coordinator!, successor!],
      closedSessionId: 'coordinator',
      closedWorkerGeneration: 4,
      workerExitProven: true,
      now: Date.now(),
    });

    expect(result.quarantinedSessionIds.size).toBe(0);
    expect(successor!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('successor');
    expect(successor!.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(coordinator!.xpiSharedCwdAdmissionGroupId).toBeUndefined();
  });

  it('clears a centralized lease when its non-coordinator holder closes with exact exit proof', () => {
    const [coordinator, holder] = group(session('coordinator'), session('holder'));
    holder!.status = 'closed';
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'holder',
      turnId: 'turn_holder',
      workerGeneration: 3,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = finalizeXpiSharedCwdMemberClose({
      sessions: [coordinator!, holder!],
      closedSessionId: 'holder',
      closedWorkerGeneration: 3,
      workerExitProven: true,
      now: Date.now(),
    });

    expect(result.quarantinedSessionIds.size).toBe(0);
    expect(coordinator!.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(holder!.xpiSharedCwdAdmissionGroupId).toBeUndefined();
  });

  it('quarantines the remaining group instead of electing when close proof is for another generation', () => {
    const [coordinator, successor] = group(session('coordinator'), session('successor'));
    coordinator!.status = 'closed';
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'coordinator',
      turnId: 'turn_closing',
      workerGeneration: 5,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = finalizeXpiSharedCwdMemberClose({
      sessions: [coordinator!, successor!],
      closedSessionId: 'coordinator',
      closedWorkerGeneration: 4,
      workerExitProven: true,
      now: Date.now(),
    });

    expect([...result.quarantinedSessionIds]).toEqual(['successor']);
    expect(successor!.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'group',
      reason: 'close_migration_unproven',
    });
    expect(successor!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('coordinator');
  });

  it('quarantines instead of electing when the generation matches but worker exit is unproven', () => {
    const [coordinator, successor] = group(session('coordinator'), session('successor'));
    coordinator!.status = 'closed';
    coordinator!.xpiSharedCwdAdmissionLease = {
      version: 1,
      groupId: 'xpi-admission:test',
      holderSessionId: 'coordinator',
      turnId: 'turn_closing',
      workerGeneration: 5,
      acquiredAt: '2026-01-01T00:00:01.000Z',
    };

    const result = finalizeXpiSharedCwdMemberClose({
      sessions: [coordinator!, successor!],
      closedSessionId: 'coordinator',
      closedWorkerGeneration: 5,
      workerExitProven: false,
      now: Date.now(),
    });

    expect([...result.quarantinedSessionIds]).toEqual(['successor']);
    expect(successor!.xpiSharedCwdQuarantine).toMatchObject({
      scope: 'group',
      reason: 'close_migration_unproven',
    });
    expect(successor!.xpiSharedCwdAdmissionCoordinatorSessionId).toBe('coordinator');
  });
});
