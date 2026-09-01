import { describe, expect, it } from 'vitest';
import {
  daemonHeartbeatStatus,
  workerHeartbeatStalled,
} from '../src/core/liveness-watchdog.js';

describe('event-loop liveness watchdog decisions', () => {
  it('marks a worker stalled only after its heartbeat lease is strictly stale', () => {
    expect(workerHeartbeatStalled({ nowMs: 20_000, lastHeartbeatAtMs: 10_000, staleMs: 10_000 })).toBe(false);
    expect(workerHeartbeatStalled({ nowMs: 20_001, lastHeartbeatAtMs: 10_000, staleMs: 10_000 })).toBe(true);
  });

  it('gives a newly spawned daemon a startup grace before requiring a matching heartbeat', () => {
    expect(daemonHeartbeatStatus({
      nowMs: 10_000,
      startedAtMs: 0,
      expectedPid: 123,
      heartbeat: null,
      startupGraceMs: 10_000,
      staleMs: 5_000,
    })).toBe('starting');
    expect(daemonHeartbeatStatus({
      nowMs: 10_001,
      startedAtMs: 0,
      expectedPid: 123,
      heartbeat: null,
      startupGraceMs: 10_000,
      staleMs: 5_000,
    })).toBe('stalled');
  });

  it('rejects a fresh heartbeat left by the previous daemon pid', () => {
    expect(daemonHeartbeatStatus({
      nowMs: 20_000,
      startedAtMs: 0,
      expectedPid: 222,
      heartbeat: { pid: 111, atMs: 19_999 },
      startupGraceMs: 10_000,
      staleMs: 5_000,
    })).toBe('stalled');
  });

  it('distinguishes a fresh matching daemon heartbeat from a stale one', () => {
    expect(daemonHeartbeatStatus({
      nowMs: 20_000,
      startedAtMs: 0,
      expectedPid: 222,
      heartbeat: { pid: 222, atMs: 15_000 },
      startupGraceMs: 10_000,
      staleMs: 5_000,
    })).toBe('healthy');
    expect(daemonHeartbeatStatus({
      nowMs: 20_001,
      startedAtMs: 0,
      expectedPid: 222,
      heartbeat: { pid: 222, atMs: 15_000 },
      startupGraceMs: 10_000,
      staleMs: 5_000,
    })).toBe('stalled');
  });
});
