import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { addTurnNotice } from '../src/services/ordinary-recovery-notice.js';
import type { RuntimeExecutionContinuationFailure } from '../src/services/session-contract.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

function fixture() {
  const session: any = { sessionId: 'notice-session' };
  const ds = { larkAppId: 'cli_notice_test', session };
  const events: string[] = [];
  const snapshots: any[] = [];
  const updateSession = vi.fn(() => {
    events.push('persist');
    snapshots.push(structuredClone(session));
  });
  const resume = vi.fn(() => { events.push('resume'); });
  const enqueue = loadWorkerPoolFunction<(session: typeof ds, failure: RuntimeExecutionContinuationFailure) => void>(
    'enqueueContinuationFailureNotice',
    { createHash, addTurnNotice, sessionStore: { updateSession }, resumeTurnNotices: resume },
  );
  const failure: RuntimeExecutionContinuationFailure = {
    bindingId: 'replacement',
    continuation: {
      reason: 'traex-auto-model', execution: { executionId: 'execution-one', turnId: 'turn-one' },
      from: { runtimeId: 'source', epoch: 1 }, nativeSessionId: 'native',
    },
    notice: 'continuation stopped',
  };
  return { ds, events, snapshots, updateSession, resume, enqueue, failure };
}

describe('continuation failure notice outbox', () => {
  it('persists an exact-turn notice before allowing the existing outbox to send', () => {
    const state = fixture();
    state.enqueue(state.ds, state.failure);
    expect(state.events).toEqual(['persist', 'resume']);
    expect(state.snapshots[0].turnNotices).toHaveLength(1);
    expect(state.snapshots[0].turnNotices[0]).toMatchObject({
      kind: 'user_notify', turnId: state.failure.continuation.execution.turnId,
      content: state.failure.notice, msgType: 'text', delivery: { state: 'pending', attempts: 0 },
    });
    expect(state.snapshots[0].turnNotices[0].delivery.uuid).toEqual(expect.any(String));
  });

  it('deduplicates retries, including an already-delivered outbox record', () => {
    const state = fixture();
    state.enqueue(state.ds, state.failure);
    const uuid = state.ds.session.turnNotices[0].delivery.uuid;
    state.enqueue(state.ds, state.failure);
    state.ds.session.turnNotices[0].delivery.state = 'delivered';
    state.enqueue(state.ds, state.failure);
    expect(state.updateSession).toHaveBeenCalledOnce();
    expect(state.ds.session.turnNotices).toHaveLength(1);
    expect(state.ds.session.turnNotices[0].delivery.uuid).toBe(uuid);
  });

  it('restores memory after a failed persistence write and retries with the same uuid', () => {
    const state = fixture();
    let failedUuid: string | undefined;
    state.updateSession.mockImplementationOnce(() => {
      failedUuid = state.ds.session.turnNotices[0].delivery.uuid;
      throw new Error('notice_store_failed');
    });
    expect(() => state.enqueue(state.ds, state.failure)).toThrow('notice_store_failed');
    expect(state.ds.session.turnNotices).toBeUndefined();
    expect(state.resume).not.toHaveBeenCalled();
    state.enqueue(state.ds, state.failure);
    expect(state.ds.session.turnNotices[0].delivery.uuid).toBe(failedUuid);
    expect(state.resume).toHaveBeenCalledOnce();
  });

  it('keeps different executions distinct and ignores absent notices', () => {
    const state = fixture();
    state.enqueue(state.ds, { ...state.failure, notice: undefined });
    expect(state.updateSession).not.toHaveBeenCalled();
    state.enqueue(state.ds, state.failure);
    state.enqueue(state.ds, {
      ...state.failure,
      continuation: { ...state.failure.continuation, execution: { executionId: 'execution-two', turnId: 'turn-two' } },
    });
    expect(state.ds.session.turnNotices).toHaveLength(2);
    expect(new Set(state.ds.session.turnNotices.map((notice: any) => notice.delivery.uuid)).size).toBe(2);
  });

  it('admits only a receipt without granting executor control on another runtime', () => {
    const current = { runtimeId: 'current', epoch: 2 };
    expect(admitSessionCommand('continuation_failure_ack', undefined, current).allowed).toBe(true);
    expect(admitSessionCommand('message', undefined, current).allowed).toBe(false);
  });
});
