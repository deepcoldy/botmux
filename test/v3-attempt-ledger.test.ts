import { describe, expect, it } from 'vitest';

import { openV3WorkerAttempts } from '../src/workflows/v3/attempt-ledger.js';
import type { StoredEvent, V3Event } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';

function stored(ts: number, event: V3Event): StoredEvent {
  return { ...event, ts } as StoredEvent;
}

describe('v3 attempt resource ledger', () => {
  it('only a post-close verdict or nodeAttemptDrained closes a dispatched attempt', () => {
    const events: StoredEvent[] = [
      stored(1, { type: 'runStarted', runId: 'ledger' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'early', instanceId: 'early#001', attemptId: 'early#001/attempts/001' }),
      stored(3, { type: 'nodeWorkerFenceArmed', nodeId: 'early', instanceId: 'early#001', attemptId: 'early#001/attempts/001' }),
      stored(4, { type: 'nodeCancelled', nodeId: 'early', instanceId: 'early#001', attemptId: 'early#001/attempts/001', reason: 'earlyReleaseLoser', byNodeId: 'merge' }),
      stored(5, { type: 'nodeDispatched', nodeId: 'old', instanceId: 'old#001', attemptId: 'old#001/attempts/001' }),
      stored(6, { type: 'nodeInstanceSuperseded', nodeId: 'old', instanceId: 'old#001', byNodeId: 'root', reason: 'refresh' }),
      stored(7, { type: 'nodeDispatched', nodeId: 'done', instanceId: 'done#001', attemptId: 'done#001/attempts/001' }),
      stored(8, { type: 'nodeSucceeded', nodeId: 'done', instanceId: 'done#001', attemptId: 'done#001/attempts/001', manifestPath: '/tmp/manifest.json' }),
      stored(9, { type: 'nodeAttemptDrained', nodeId: 'old', instanceId: 'old#001', attemptId: 'old#001/attempts/001', reason: 'obsoleteAttempt' }),
    ];

    expect(openV3WorkerAttempts(events)).toEqual([{
      nodeId: 'early',
      instanceId: 'early#001',
      attemptId: 'early#001/attempts/001',
    }]);
  });

  it('does not let an out-of-order close proof bless a later dispatch', () => {
    const attemptId = 'peer/attempts/001';
    expect(openV3WorkerAttempts([
      stored(1, { type: 'nodeFailed', nodeId: 'peer', attemptId, errorClass: 'workerError' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', attemptId }),
    ])).toEqual([{ nodeId: 'peer', attemptId }]);
  });

  it('fails closed when the first post-open close changes attempt identity', () => {
    const attemptId = 'peer#001/attempts/001';
    expect(() => openV3WorkerAttempts([
      stored(1, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId }),
      stored(2, { type: 'nodeAttemptDrained', nodeId: 'other', instanceId: 'other#001', attemptId, reason: 'terminalPeer' }),
    ])).toThrow(`close identity changed for ${attemptId}`);

    // Once the matching close committed, duplicate projection noise is not a
    // new resource claim and cannot reinterpret the already-closed identity.
    expect(openV3WorkerAttempts([
      stored(1, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId }),
      stored(2, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId, reason: 'terminalPeer' }),
      stored(3, { type: 'nodeSucceeded', nodeId: 'other', instanceId: 'other#001', attemptId, manifestPath: '/tmp/duplicate.json' }),
    ])).toEqual([]);
  });

  it('nodeAttemptDrained resets only the exact current running attempt', () => {
    const running = materialize([
      stored(1, { type: 'runStarted', runId: 'drained-running' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(3, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'terminalPeer' }),
    ]);
    expect(running.nodes.get('peer')).toMatchObject({ status: 'pending', effectiveInstanceId: 'peer#001' });
    expect(running.instances.get('peer#001')?.status).toBe('pending');

    const superseded = materialize([
      stored(1, { type: 'runStarted', runId: 'drained-old' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(3, { type: 'nodeInstanceSuperseded', nodeId: 'peer', instanceId: 'peer#001', byNodeId: 'root', reason: 'refresh' }),
      stored(4, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'obsoleteAttempt' }),
    ]);
    expect(superseded.instances.get('peer#001')?.status).toBe('superseded');
    expect(superseded.nodes.get('peer')?.status).toBe('pending');

    const stale = materialize([
      stored(1, { type: 'runStarted', runId: 'drained-stale' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(3, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/002' }),
      stored(4, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'orphanRecovery' }),
    ]);
    expect(stale.instances.get('peer#001')?.status).toBe('running');
    expect(stale.nodes.get('peer')?.status).toBe('running');
  });

  it('cleanup after a run terminal is audit-only', () => {
    const snap = materialize([
      stored(1, { type: 'runStarted', runId: 'legacy-terminal-open' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(3, { type: 'runFailed', failedNodeId: 'fatal' }),
      stored(4, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'orphanRecovery' }),
    ]);
    expect(snap.runStatus).toBe('failed');
    expect(snap.nodes.get('peer')?.status).toBe('running');
  });

  it('cleanup beneath a legacy runBlocked resets the exact peer but preserves the block', () => {
    const snap = materialize([
      stored(1, { type: 'runStarted', runId: 'legacy-blocked-open' }),
      stored(2, { type: 'nodeBlocked', nodeId: 'root', attemptId: 'root/attempts/001', errorClass: 'resultInvalid' }),
      stored(3, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(4, { type: 'runBlocked', blockedNodeId: 'root' }),
      stored(5, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'terminalPeer' }),
    ]);
    expect(snap.runStatus).toBe('blocked');
    expect(snap.blockedNodeId).toBe('root');
    expect(snap.nodes.get('peer')?.status).toBe('pending');
  });

  it('accepts an attempt-scoped runCancelled node verdict as historical close proof', () => {
    const attemptId = 'peer#001/attempts/001';
    expect(openV3WorkerAttempts([
      stored(1, { type: 'runStarted', runId: 'cancel-history' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId }),
      stored(3, { type: 'runCancelRequested', cancelRequestId: 'cancel-1', by: 'ou_user' }),
      stored(4, { type: 'nodeCancelled', nodeId: 'peer', instanceId: 'peer#001', attemptId, reason: 'runCancelled', cancelRequestId: 'cancel-1' }),
      stored(5, { type: 'runCancelled', cancelRequestId: 'cancel-1', by: 'ou_user' }),
    ])).toEqual([]);
  });

  it('allows AttemptDrained after the cancellation cut without resetting state', () => {
    const attemptId = 'peer#001/attempts/001';
    const snap = materialize([
      stored(1, { type: 'runStarted', runId: 'cancel-drained' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId }),
      stored(3, { type: 'runCancelRequested', cancelRequestId: 'cancel-1', by: 'ou_user' }),
      stored(4, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId, reason: 'runCancellation' }),
    ]);
    expect(snap.runStatus).toBe('cancelling');
    expect(snap.nodes.get('peer')?.status).toBe('running');
  });
});
