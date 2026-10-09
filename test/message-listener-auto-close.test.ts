import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { canAutoCloseMessageListenerSession } from '../src/core/message-listener-auto-close.js';

/** Build an idle listener session with positive, exact-turn completion evidence. */
function session(): DaemonSession {
  return {
    session: { sessionId: 'listener', status: 'active', messageListenerAutoClose: true },
    currentTurnId: 'turn-1',
    currentReplyTarget: { turnId: 'turn-1' },
    messageListenerCompletedTurnId: 'turn-1',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

describe('message listener auto-close', () => {
  it('allows only a successfully completed idle listener session', () => {
    expect(canAutoCloseMessageListenerSession(session(), 'turn-1')).toBe(true);
  });

  it.each(['ordinary', 'failed', 'new-turn', 'new-reply', 'working', 'closed', 'attention', 'queued', 'raw-input', 'follow-up', 'initial-start'])(
    'retains a session with %s state', kind => {
      const ds = session();
      if (kind === 'ordinary') ds.session.messageListenerAutoClose = undefined;
      if (kind === 'failed') ds.messageListenerCompletedTurnId = undefined;
      if (kind === 'new-turn') ds.currentTurnId = 'turn-2';
      if (kind === 'new-reply') ds.currentReplyTarget!.turnId = 'turn-2';
      if (kind === 'working') ds.lastScreenStatus = 'working';
      if (kind === 'closed') ds.session.status = 'closed';
      if (kind === 'attention') ds.agentAttention = { kind: 'decision', reason: 'approval', at: 1 };
      if (kind === 'queued') ds.session.queuedActivationPending = true;
      if (kind === 'raw-input') ds.pendingRawInput = 'next';
      if (kind === 'follow-up') ds.pendingFollowUps = ['next'];
      if (kind === 'initial-start') ds.initialStartPending = true;
      expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
    },
  );

  it('does not infer success from idle or unknown lineage after restart', () => {
    const ds = session();
    ds.messageListenerCompletedTurnId = undefined;
    expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
    ds.messageListenerCompletedTurnId = 'turn-1';
    ds.currentTurnId = undefined;
    expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
  });
});
