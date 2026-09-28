import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { principalLaneDispatchUnknownNoticeId } from '../src/core/principal-lane-recovery.js';
import { __testOnly_notifyPrincipalLaneDispatchUnknown as notifyDispatchUnknown } from '../src/daemon.js';
import * as sessionStore from '../src/services/session-store.js';

let dataDir: string;
let previousDataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-principal-lane-callbacks-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  sessionStore.init('app-principal-lane-callbacks');
});

afterEach(() => {
  vi.restoreAllMocks();
  config.session.dataDir = previousDataDir;
  sessionStore.init();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const session = sessionStore.createSession(
    'chat-principal', 'root-principal', 'Principal lane', 'group', 'chat',
  );
  session.larkAppId = 'app-principal-lane-callbacks';
  session.ownerOpenId = 'ou_owner';
  session.principalLane = {
    version: 1,
    sourceSessionId: session.sessionId,
    laneId: 'source',
    sessionId: session.sessionId,
    principalKey: 'user:open:ou_owner',
    principal: { kind: 'open_id', openId: 'ou_owner' },
    routingAnchor: `principal-lane:${session.sessionId}:source`,
    displayTarget: { kind: 'chat', chatId: session.chatId },
    workspaceEpoch: 1,
    phase: 'active',
    revision: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
  const caller = {
    requestLarkAppId: 'app-principal-lane-callbacks',
    requestUserOpenId: 'ou_caller',
    senderType: 'user' as const,
  };
  const recordId = principalLaneDispatchUnknownNoticeId(session.sessionId, 'turn-unknown');
  session.principalLaneDispatchUnknownNotices = [{
    version: 1,
    id: recordId,
    turnId: 'turn-unknown',
    caller,
    detectedAt: '2026-09-22T00:00:01.000Z',
    noticePending: true,
  }];
  sessionStore.updateSession(session);
  return {
    session,
    notice: {
      kind: 'principal_lane_dispatch_unknown' as const,
      sessionId: session.sessionId,
      recordId,
      turnId: 'turn-unknown',
      caller,
      detail: 'synthetic dispatch-unknown notice',
    },
  };
}

describe('principal-lane dispatch-unknown notification', () => {
  it('keeps the durable notice after delivery failure and clears it only after success', async () => {
    const { session, notice } = fixture();
    const failedReply = vi.fn(async () => {
      throw new Error('synthetic delivery failure');
    });

    await notifyDispatchUnknown('app-principal-lane-callbacks', notice, failedReply as any);
    expect(sessionStore.getSession(session.sessionId)?.principalLaneDispatchUnknownNotices)
      .toMatchObject([{ id: notice.recordId, noticePending: true }]);

    const successfulReply = vi.fn(async () => 'om_notice');
    await notifyDispatchUnknown('app-principal-lane-callbacks', notice, successfulReply as any);
    expect(successfulReply).toHaveBeenCalledWith(
      session.chatId,
      expect.stringContaining('没有重放'),
      'text',
      'app-principal-lane-callbacks',
    );
    expect(sessionStore.getSession(session.sessionId)?.principalLaneDispatchUnknownNotices)
      .toBeUndefined();

    await notifyDispatchUnknown('app-principal-lane-callbacks', notice, successfulReply as any);
    expect(successfulReply).toHaveBeenCalledTimes(1);
  });
});
