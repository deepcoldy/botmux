/**
 * Unit tests for the daemon-side transient-startup-failure self-heal policy
 * (src/core/worker-startup-retry.ts).
 *
 * Pins the 2026-08-23 incident contract: a "spawnSync tmux ETIMEDOUT" (or any
 * connection-level / fd-pressure failure) from a worker's fatal startup error
 * is retried silently with bounded, decorrelated backoff instead of surfacing
 * "会话启动失败" to a chat nobody touched; deterministic install/config
 * failures keep the immediate user-visible card.
 *
 * Run:  pnpm vitest run test/worker-startup-retry.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_STARTUP_AUTO_RETRIES,
  isTransientStartupFailure,
  startupAutoRetryDelayMs,
  planSerialWorkerRecovery,
  projectSerialWorkerRecovery,
} from '../src/core/worker-startup-retry.js';

describe('isTransientStartupFailure', () => {
  it('classifies the 08-23 incident reason as transient', () => {
    expect(isTransientStartupFailure('spawnSync tmux ETIMEDOUT')).toBe(true);
  });

  it('classifies connection-level tmux failures as transient', () => {
    expect(isTransientStartupFailure(
      'Command failed: tmux pipe-pane -O -t bmx-x — error connecting to /tmp/tmux-0/default (Connection refused)',
    )).toBe(true);
    expect(isTransientStartupFailure('lost server')).toBe(true);
    expect(isTransientStartupFailure('server exited unexpectedly')).toBe(true);
    expect(isTransientStartupFailure('connect ECONNREFUSED /tmp/x.sock')).toBe(true);
  });

  it('classifies fd/process pressure as transient', () => {
    expect(isTransientStartupFailure('spawn EAGAIN')).toBe(true);
    expect(isTransientStartupFailure('EMFILE: too many open files')).toBe(true);
    expect(isTransientStartupFailure('ENFILE: file table overflow')).toBe(true);
  });

  it('keeps deterministic install/config failures user-visible (NOT transient)', () => {
    expect(isTransientStartupFailure('spawn codex ENOENT')).toBe(false);
    expect(isTransientStartupFailure('EACCES: permission denied')).toBe(false);
    expect(isTransientStartupFailure('tmux 后端在本机不可用')).toBe(false);
    expect(isTransientStartupFailure('usage: new-session [-AdDEPX] ...')).toBe(false);
    expect(isTransientStartupFailure(
      'durable raw activation was not accepted by the backend',
    )).toBe(false);
  });

  it('does not fire on substrings of longer identifiers (word boundaries)', () => {
    expect(isTransientStartupFailure('MY_ETIMEDOUT_FLAG missing')).toBe(false);
  });
});

describe('startupAutoRetryDelayMs', () => {
  it('is deterministic for the same (sessionId, attempt)', () => {
    const a = startupAutoRetryDelayMs('6241a223-3ce4-4f84-81a8-25397aecff81', 1);
    const b = startupAutoRetryDelayMs('6241a223-3ce4-4f84-81a8-25397aecff81', 1);
    expect(a).toBe(b);
  });

  it('stays within 75%-125% of the base for every attempt', () => {
    const bases = [15_000, 60_000, 180_000];
    for (let attempt = 1; attempt <= bases.length; attempt += 1) {
      for (const sid of ['6241a223', 'e50bbf26', '3d1baa9d', 'ad786ff6', '9f040c45']) {
        const d = startupAutoRetryDelayMs(sid, attempt);
        expect(d).toBeGreaterThanOrEqual(bases[attempt - 1] * 0.75);
        expect(d).toBeLessThanOrEqual(bases[attempt - 1] * 1.25);
      }
    }
  });

  it('decorrelates different sessions on the same attempt (storm must not re-storm)', () => {
    const delays = new Set(
      ['6241a223', 'e50bbf26', '3d1baa9d', 'ad786ff6', '9f040c45', '155ea63a', '50c8ecc9']
        .map(sid => startupAutoRetryDelayMs(sid, 1)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });

  it('clamps out-of-range attempts to the schedule bounds', () => {
    expect(startupAutoRetryDelayMs('sid', 0)).toBe(startupAutoRetryDelayMs('sid', 1));
    expect(startupAutoRetryDelayMs('sid', 99)).toBe(startupAutoRetryDelayMs('sid', 3));
  });

  it('exports a bounded retry budget', () => {
    expect(MAX_STARTUP_AUTO_RETRIES).toBeGreaterThan(0);
    expect(MAX_STARTUP_AUTO_RETRIES).toBeLessThanOrEqual(5);
  });
});

describe('durable serial worker recovery', () => {
  it('keeps the original budget and deadline across JSON persistence', () => {
    const first = planSerialWorkerRecovery('original-session', undefined, true, 1000);
    const restored = JSON.parse(JSON.stringify({ ...first, attempts: 2 }));
    const retry = planSerialWorkerRecovery('original-session', restored, true, 2000);
    expect(retry.attempts).toBe(2);
    expect(retry.nextRetryAt).toBe(2000 + startupAutoRetryDelayMs('original-session', 3));
    expect(retry.status).toBe('backoff');
    expect(planSerialWorkerRecovery('original-session', { ...retry, attempts: 3 }, true, 3000))
      .toMatchObject({ status: 'blocked', attempts: 3, reason: 'worker_recovery_exhausted' });
  });
  it('does not retry deterministic failures, but may re-probe unknown host liveness', () => {
    expect(planSerialWorkerRecovery('s', undefined, false).status).toBe('blocked');
    expect(isTransientStartupFailure('[read-isolation] refusing startup; liveness probe: unknown')).toBe(true);
    expect(isTransientStartupFailure('[read-isolation] confirmed foreign owner')).toBe(false);
  });
  it('reports the actual FIFO blocker for its tail without leaking into unrelated turns', () => {
    const head = { dispatchId: 'd1', turnId: 'first', executionPolicy: 'serial', state: 'accepted', content: 'x',
      workerRecovery: planSerialWorkerRecovery('s', undefined, false, 1000) } as const;
    const tail = { dispatchId: 'd2', turnId: 'second', executionPolicy: 'serial', state: 'accepted', content: 'y' } as const;
    expect(projectSerialWorkerRecovery([head, tail], 'second')).toMatchObject({
      status: 'blocked', blockedByTurnId: 'first', recoveryAction: 'repair_backend_and_wake_original_session',
    });
    expect(projectSerialWorkerRecovery([head, tail], 'unrelated')).toBeUndefined();
    expect(projectSerialWorkerRecovery([tail], 'second')).toBeUndefined();
  });
});
