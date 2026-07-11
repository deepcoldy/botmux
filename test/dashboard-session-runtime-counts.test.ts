import { describe, expect, it } from 'vitest';
import { sessionRuntimeCounts } from '../src/dashboard/web/sessions.js';

describe('dashboard session residency summary', () => {
  it('separates logical, resident, and dormant sessions', () => {
    expect(sessionRuntimeCounts([
      { sessionId: 'live-idle', status: 'idle', workerPid: 101 },
      { sessionId: 'live-working', status: 'working', workerPid: 102 },
      { sessionId: 'sleeping', status: 'dormant', workerPid: null },
      { sessionId: 'closed', status: 'closed', workerPid: null },
    ])).toEqual({ logical: 3, resident: 2, dormant: 1 });
  });

  it('does not mislabel a process-less queued row as dormant', () => {
    expect(sessionRuntimeCounts([
      { sessionId: 'queued', status: 'idle', queued: true },
    ])).toEqual({ logical: 1, resident: 0, dormant: 0 });
  });
});
