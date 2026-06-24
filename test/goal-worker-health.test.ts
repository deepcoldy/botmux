import { describe, expect, it } from 'vitest';
import { classifyGoalWorkerHealth } from '../src/core/goal-worker-health.js';

describe('classifyGoalWorkerHealth', () => {
  it('treats an active live worker with an existing backing session as live', () => {
    expect(classifyGoalWorkerHealth({
      sessionStatus: 'active',
      worker: { killed: false },
      persistentProbe: 'exists',
    })).toEqual({ session: 'live', workerProcess: 'live' });
  });

  it('treats a missing persistent backing session as a dead worker even when the process handle still exists', () => {
    expect(classifyGoalWorkerHealth({
      sessionStatus: 'active',
      worker: { killed: false },
      persistentProbe: 'missing',
    })).toEqual({ session: 'live', workerProcess: 'none' });
  });

  it('keeps cold-resume suspended sessions suspended when their backing state is not known missing', () => {
    expect(classifyGoalWorkerHealth({
      sessionStatus: 'active',
      suspendedColdResume: true,
      worker: null,
      persistentProbe: 'unknown',
    })).toEqual({ session: 'suspended', workerProcess: 'none' });
  });

  it('does not classify a cold-resume marker as suspended when the backing session is confirmed missing', () => {
    expect(classifyGoalWorkerHealth({
      sessionStatus: 'active',
      suspendedColdResume: true,
      worker: null,
      persistentProbe: 'missing',
    })).toEqual({ session: 'live', workerProcess: 'none' });
  });
});
