import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_driveNextXpiSharedCwdTurn as driveNextTurn,
  __testOnly_finalizeClosedXpiSharedCwdMember as finalizeClosedMember,
  __testOnly_notifyXpiSharedCwdDispatchUnknown as notifyDispatchUnknown,
  __testOnly_onXpiSharedCwdTurnTerminal as onTurnTerminal,
  __testOnly_onXpiSharedCwdWorkerExit as onWorkerExit,
} from '../src/daemon.js';
import * as sessionStore from '../src/services/session-store.js';
import { logger } from '../src/utils/logger.js';
import { enqueueXpiSharedCwdTurn, xpiSharedCwdQueuedTurnId } from '../src/core/xpi-shared-cwd-admission.js';

let dataDir: string;
let previousDataDir: string;

registerBot({
  larkAppId: 'app-xpi-callbacks',
  larkAppSecret: 'synthetic-secret',
  cliId: 'claude-code',
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-xpi-callbacks-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  sessionStore.init('app-xpi-callbacks');
  activeSessions.clear();
});

afterEach(() => {
  activeSessions.clear();
  vi.restoreAllMocks();
  config.session.dataDir = previousDataDir;
  sessionStore.init();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const coordinator = sessionStore.createSession('chat-a', 'root-a', 'Coordinator', 'group');
  const member = sessionStore.createSession('chat-b', 'root-b', 'Member', 'group');
  for (const row of [coordinator, member]) {
    row.larkAppId = 'app-xpi-callbacks';
    row.xpiSharedCwdAdmissionGroupId = 'xpi-admission:callback-test';
    row.xpiSharedCwdAdmissionCoordinatorSessionId = coordinator.sessionId;
  }
  member.workerGeneration = 6;
  member.xpiSharedCwdQueuedTurns = [{
    version: 1,
    id: xpiSharedCwdQueuedTurnId(member.sessionId, 'turn-current'),
    turnId: 'turn-current',
    caller: {
      requestLarkAppId: 'app-xpi-callbacks',
      requestUserOpenId: 'ou_synthetic',
      senderType: 'user',
    },
    userPrompt: 'queued then accepted',
    cliInput: { content: 'queued then accepted' },
    resume: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    dispatchState: 'attempting',
  }];
  coordinator.xpiSharedCwdAdmissionLease = {
    version: 1,
    groupId: 'xpi-admission:callback-test',
    holderSessionId: member.sessionId,
    turnId: 'turn-current',
    workerGeneration: 6,
    acquiredAt: '2026-01-01T00:00:00.000Z',
  };
  sessionStore.updateSession(coordinator);
  sessionStore.updateSession(member);
  const ds = {
    session: member,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app-xpi-callbacks',
    chatId: member.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    workerGeneration: 6,
    activeInteractiveTurn: {
      turnId: 'turn-current',
      caller: {
        requestLarkAppId: 'app-xpi-callbacks',
        requestUserOpenId: 'ou_synthetic',
        senderType: 'user',
      },
    },
  } as DaemonSession;
  return { coordinator, member, ds };
}

describe('daemon XPI shared-cwd lifecycle callbacks', () => {
  it('dispatches a queued turn as at-most-once so a worker crash scans but cannot replay it', async () => {
    const { coordinator, member, ds } = fixture();
    coordinator.xpiSharedCwdAdmissionLease = undefined;
    member.xpiSharedCwdQueuedTurns![0]!.dispatchState = 'queued';
    sessionStore.updateSession(coordinator);
    sessionStore.updateSession(member);

    const send = vi.fn();
    ds.worker = { killed: false, connected: true, send } as unknown as DaemonSession['worker'];
    activeSessions.set('xpi-callback-driver', ds);

    expect(await driveNextTurn('xpi-admission:callback-test')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0] as {
      type: string;
      content: string;
      turnId?: string;
      dispatchAttempt?: number;
      atMostOnce?: true;
    };
    expect(message.type).toBe('message');

    // Exercise the worker's real crash-replay policy with the exact daemon IPC
    // envelope. The plain sibling proves that a restart replay scan occurred;
    // only the XPI turn is fenced from a second execution.
    const tracker = new InflightInputTracker();
    tracker.onWrite({ content: 'plain sibling', turnId: 'plain-turn' });
    tracker.onWrite({
      content: message.content,
      turnId: message.turnId,
      dispatchAttempt: message.dispatchAttempt,
      ...(message.atMostOnce ? { noReplay: true } : {}),
    });
    expect(tracker.onCliExit(item => item.dispatchAttempt === undefined && !item.noReplay)).toBe(1);
    expect(tracker.takeCarryOver()).toEqual([{
      content: 'plain sibling',
      turnId: 'plain-turn',
    }]);
  });

  it('re-forks a dead adopt queue head and then dispatches the next group member', async () => {
    const coordinator = sessionStore.createSession('chat-adopt-coordinator', 'root-adopt-coordinator', 'Coordinator', 'group');
    const adopted = sessionStore.createSession('chat-adopted', 'root-adopted', 'Adopted', 'group');
    const follower = sessionStore.createSession('chat-follower', 'root-follower', 'Follower', 'group');
    for (const row of [coordinator, adopted, follower]) {
      row.larkAppId = 'app-xpi-callbacks';
      row.xpiSharedCwdAdmissionGroupId = 'xpi-admission:adopt-progress';
      row.xpiSharedCwdAdmissionCoordinatorSessionId = coordinator.sessionId;
    }
    enqueueXpiSharedCwdTurn({
      session: adopted,
      turnId: 'turn-adopted-first',
      caller: {
        requestLarkAppId: 'app-xpi-callbacks',
        requestUserOpenId: 'ou_synthetic',
        senderType: 'user',
      },
      userPrompt: 'adopted first',
      cliInput: { content: 'bridge formatted adopted first' },
      resume: true,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    enqueueXpiSharedCwdTurn({
      session: follower,
      turnId: 'turn-follower-second',
      caller: {
        requestLarkAppId: 'app-xpi-callbacks',
        requestUserOpenId: 'ou_synthetic',
        senderType: 'user',
      },
      userPrompt: 'follower second',
      cliInput: { content: 'follower second' },
      resume: true,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    for (const row of [coordinator, adopted, follower]) sessionStore.updateSession(row);

    const adoptedDs = {
      session: adopted,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: 'app-xpi-callbacks',
      chatId: adopted.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 1,
      cliVersion: 'test',
      lastMessageAt: 1,
      hasHistory: true,
      adoptedFrom: { source: 'tmux', tmuxTarget: 'synthetic:1', cwd: dataDir },
    } as DaemonSession;
    const followerSend = vi.fn();
    const followerDs = {
      session: follower,
      worker: { killed: false, connected: true, send: followerSend },
      workerPort: null,
      workerToken: null,
      larkAppId: 'app-xpi-callbacks',
      chatId: follower.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 1,
      cliVersion: 'test',
      lastMessageAt: 1,
      hasHistory: true,
      workerGeneration: 12,
    } as unknown as DaemonSession;
    follower.workerGeneration = 12;
    sessionStore.updateSession(follower);
    activeSessions.set('xpi-adopted', adoptedDs);
    activeSessions.set('xpi-follower', followerDs);

    const forkAdopt = vi.fn((target: DaemonSession, opts?: {
      onWorkerGenerationReserved?: (workerGeneration: number) => void;
    }) => {
      target.workerGeneration = 11;
      target.session.workerGeneration = 11;
      opts?.onWorkerGenerationReserved?.(11);
      return 'accepted' as const;
    });
    const dependencies = {
      forkAdoptWorker: forkAdopt,
      notifyQuarantine: vi.fn(async () => {}),
    };

    expect(await driveNextTurn('xpi-admission:adopt-progress', dependencies)).toBe(true);
    expect(forkAdopt).toHaveBeenCalledWith(adoptedDs, expect.objectContaining({
      prompt: 'bridge formatted adopted first',
      turnId: 'turn-adopted-first',
      atMostOnce: true,
    }));
    expect(onTurnTerminal(adoptedDs, { turnId: 'turn-adopted-first' }, { workerGeneration: 11 }))
      .toBe(true);

    expect(await driveNextTurn('xpi-admission:adopt-progress', dependencies)).toBe(true);
    expect(followerSend).toHaveBeenCalledTimes(1);
    expect(followerSend.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      type: 'message',
      turnId: 'turn-follower-second',
      atMostOnce: true,
    }));
  });

  it('parks a restore-quarantined queue head with notice before sending the healthy follower', async () => {
    const coordinator = sessionStore.createSession('chat-park-coordinator', 'root-park-coordinator', 'Coordinator', 'group');
    const blocked = sessionStore.createSession('chat-park-blocked', 'root-park-blocked', 'Blocked', 'group');
    const follower = sessionStore.createSession('chat-park-follower', 'root-park-follower', 'Follower', 'group');
    for (const row of [coordinator, blocked, follower]) {
      row.larkAppId = 'app-xpi-callbacks';
      row.xpiSharedCwdAdmissionGroupId = 'xpi-admission:restore-progress';
      row.xpiSharedCwdAdmissionCoordinatorSessionId = coordinator.sessionId;
    }
    blocked.restoreQuarantinedAt = '2026-01-01T00:00:00.000Z';
    enqueueXpiSharedCwdTurn({
      session: blocked,
      turnId: 'turn-parked-first',
      caller: { requestLarkAppId: 'app-xpi-callbacks', requestUserOpenId: 'ou_synthetic', senderType: 'user' },
      userPrompt: 'parked first',
      cliInput: { content: 'parked first' },
      resume: true,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    enqueueXpiSharedCwdTurn({
      session: follower,
      turnId: 'turn-runnable-second',
      caller: { requestLarkAppId: 'app-xpi-callbacks', requestUserOpenId: 'ou_synthetic', senderType: 'user' },
      userPrompt: 'runnable second',
      cliInput: { content: 'runnable second' },
      resume: true,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    follower.workerGeneration = 21;
    for (const row of [coordinator, blocked, follower]) sessionStore.updateSession(row);

    const send = vi.fn();
    const followerDs = {
      session: follower,
      worker: { killed: false, connected: true, send },
      workerPort: null,
      workerToken: null,
      larkAppId: 'app-xpi-callbacks',
      chatId: follower.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 1,
      cliVersion: 'test',
      lastMessageAt: 1,
      hasHistory: true,
      workerGeneration: 21,
    } as unknown as DaemonSession;
    activeSessions.set('xpi-restore-follower', followerDs);
    const notifyQuarantine = vi.fn(async () => {});

    expect(await driveNextTurn('xpi-admission:restore-progress', {
      forkAdoptWorker: vi.fn(() => 'rejected' as const),
      notifyQuarantine,
    })).toBe(true);
    expect(notifyQuarantine).toHaveBeenCalledWith(
      'app-xpi-callbacks',
      expect.objectContaining({
        sessionId: blocked.sessionId,
        reason: 'restore_quarantined_member',
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ turnId: 'turn-runnable-second' }));
    expect(sessionStore.getOwnedSession(blocked.sessionId)).toEqual(expect.objectContaining({
      xpiSharedCwdQuarantine: expect.objectContaining({ reason: 'restore_quarantined_member' }),
      xpiSharedCwdAdmissionGroupId: undefined,
    }));
  });

  it('keeps a durable dispatch-unknown notice pending until delivery and store cleanup both succeed', async () => {
    const { member } = fixture();
    member.xpiSharedCwdDispatchUnknownNotices = [{
      version: 1,
      id: 'record-unknown',
      turnId: 'turn-unknown',
      caller: {
        requestLarkAppId: 'app-xpi-callbacks',
        requestUserOpenId: 'ou_synthetic',
        senderType: 'user',
      },
      detectedAt: '2026-01-02T00:00:00.000Z',
      noticePending: true,
    }];
    sessionStore.updateSession(member);
    const notice = {
      sessionId: member.sessionId,
      recordId: 'record-unknown',
      turnId: 'turn-unknown',
    };

    const failedReply = vi.fn(async () => { throw new Error('transport unavailable'); });
    await notifyDispatchUnknown('app-xpi-callbacks', notice, failedReply);
    expect(sessionStore.getOwnedSession(member.sessionId)?.xpiSharedCwdDispatchUnknownNotices)
      .toEqual([expect.objectContaining({ id: 'record-unknown', noticePending: true })]);

    const deliveredReply = vi.fn(async () => 'om_notice');
    await notifyDispatchUnknown('app-xpi-callbacks', notice, deliveredReply);
    expect(sessionStore.getOwnedSession(member.sessionId)?.xpiSharedCwdDispatchUnknownNotices)
      .toBeUndefined();
  });

  it('terminal callback rejects stale turn/generation and releases only the exact lease', () => {
    const { coordinator, ds } = fixture();

    expect(onTurnTerminal(ds, { turnId: 'turn-old' }, { workerGeneration: 6 })).toBe(false);
    expect(onTurnTerminal(ds, { turnId: 'turn-current' }, { workerGeneration: 5 })).toBe(false);
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeDefined();
    expect(sessionStore.getOwnedSession(ds.session.sessionId)?.xpiSharedCwdQueuedTurns).toHaveLength(1);

    expect(onTurnTerminal(ds, { turnId: 'turn-current' }, { workerGeneration: 6 })).toBe(true);
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(sessionStore.getOwnedSession(ds.session.sessionId)?.xpiSharedCwdQueuedTurns).toBeUndefined();
    expect(ds.activeInteractiveTurn?.turnId).toBe('turn-current');
  });

  it('worker-exit callback is the SIGKILL-capable release path and fences by generation', () => {
    const { coordinator, ds } = fixture();

    expect(onWorkerExit(ds, { workerGeneration: 5 })).toBe(false);
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeDefined();
    expect(sessionStore.getOwnedSession(ds.session.sessionId)?.xpiSharedCwdQueuedTurns).toHaveLength(1);
    expect(onWorkerExit(ds, { workerGeneration: 6 })).toBe(true);
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(sessionStore.getOwnedSession(ds.session.sessionId)?.xpiSharedCwdQueuedTurns).toBeUndefined();
  });

  it('fails fast on SQLite contention and retries the exact worker-exit release after yielding', async () => {
    const { coordinator, ds } = fixture();
    const writer = new DatabaseSync(
      join(dataDir, 'session-stores', 'app-xpi-callbacks', 'sessions.db'),
    );
    writer.exec('PRAGMA busy_timeout = 0;');
    writer.exec('BEGIN IMMEDIATE;');
    const startedAt = performance.now();
    try {
      expect(onWorkerExit(ds, { workerGeneration: 6 })).toBe(false);
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeDefined();
    } finally {
      writer.exec('ROLLBACK;');
      writer.close();
    }

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline
      && sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeUndefined();
  });

  it('escalates sustained busy to a slow retry without quarantining healthy data, then recovers', async () => {
    const { coordinator, member, ds } = fixture();
    const escalationLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const writer = new DatabaseSync(
      join(dataDir, 'session-stores', 'app-xpi-callbacks', 'sessions.db'),
    );
    writer.exec('PRAGMA busy_timeout = 0;');
    writer.exec('BEGIN IMMEDIATE;');
    try {
      expect(onWorkerExit(ds, { workerGeneration: 6 })).toBe(false);
      const escalationDeadline = Date.now() + 4_500;
      while (Date.now() < escalationDeadline
        && !escalationLog.mock.calls.some(call => String(call[0]).includes('session_store_busy_escalated'))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(escalationLog).toHaveBeenCalledWith(expect.stringContaining('session_store_busy_escalated'));
      expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeDefined();
      expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdQuarantine).toBeUndefined();
      expect(sessionStore.getOwnedSession(member.sessionId)?.xpiSharedCwdQuarantine).toBeUndefined();
    } finally {
      writer.exec('ROLLBACK;');
      writer.close();
    }

    const recoveryDeadline = Date.now() + 6_500;
    while (Date.now() < recoveryDeadline
      && sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(sessionStore.getOwnedSession(coordinator.sessionId)?.xpiSharedCwdAdmissionLease).toBeUndefined();
    escalationLog.mockRestore();
  }, 15_000);

  it('production close callback atomically migrates coordinator state while preserving a surviving lease', async () => {
    const { coordinator, member } = fixture();
    coordinator.status = 'closed';
    coordinator.closedAt = new Date().toISOString();
    sessionStore.updateSession(coordinator);

    await finalizeClosedMember(coordinator, {
      workerGeneration: coordinator.workerGeneration,
      workerExitProven: true,
    });

    const durableCoordinator = sessionStore.getOwnedSession(coordinator.sessionId)!;
    const durableMember = sessionStore.getOwnedSession(member.sessionId)!;
    expect(durableCoordinator.xpiSharedCwdAdmissionGroupId).toBeUndefined();
    expect(durableCoordinator.xpiSharedCwdAdmissionCoordinatorSessionId).toBeUndefined();
    expect(durableCoordinator.xpiSharedCwdAdmissionLease).toBeUndefined();
    expect(durableMember.xpiSharedCwdAdmissionCoordinatorSessionId).toBe(member.sessionId);
    expect(durableMember.xpiSharedCwdAdmissionLease).toEqual(expect.objectContaining({
      holderSessionId: member.sessionId,
      turnId: 'turn-current',
      workerGeneration: 6,
    }));

    sessionStore.init('app-xpi-callbacks');
    expect(sessionStore.getOwnedSession(member.sessionId)?.xpiSharedCwdAdmissionCoordinatorSessionId)
      .toBe(member.sessionId);
    expect(sessionStore.getOwnedSession(member.sessionId)?.xpiSharedCwdAdmissionLease?.turnId)
      .toBe('turn-current');
  });
});
