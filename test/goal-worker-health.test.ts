import { describe, expect, it } from 'vitest';
import { classifyGoalWorkerHealth, parseGoalWorkerHealthProbe } from '../src/core/goal-worker-health.js';

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

describe('parseGoalWorkerHealthProbe', () => {
  it('accepts an explicit empty entry list as a conclusive probe', () => {
    expect(parseGoalWorkerHealthProbe({ entries: [] })).toEqual({ probeOk: true, entries: [] });
  });

  it.each([
    null,
    {},
    { entries: null },
    { entries: [{}] },
    { entries: [{ larkAppId: 'cli_worker', session: 'live', workerProcess: 'bogus' }] },
  ])('treats a malformed 2xx body as inconclusive: %j', (body) => {
    expect(parseGoalWorkerHealthProbe(body)).toEqual({ probeOk: false, entries: [] });
  });

  it('accepts fully-shaped worker health entries', () => {
    const entry = {
      larkAppId: 'cli_worker',
      sessionId: 'session-1',
      session: 'live' as const,
      workerProcess: 'live' as const,
      lastActivityAt: '2026-07-26T00:00:00.000Z',
      title: 'worker',
    };
    expect(parseGoalWorkerHealthProbe({ entries: [entry] }, 'cli_worker')).toEqual({ probeOk: true, entries: [entry] });
    expect(parseGoalWorkerHealthProbe({ entries: [entry] }, 'cli_other')).toEqual({ probeOk: false, entries: [] });
  });
});
