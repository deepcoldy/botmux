import { describe, expect, it, vi } from 'vitest';
import {
  updateAndRestartBotmux,
  updateResponseNeedsRestart,
  updateActionErrorCode,
  formatBytes,
  binaryDownloadFraction,
  binaryProgressRingValue,
  binaryProgressText,
  classifyOtherUpdate,
  observedInstallCompleted,
  pollUpdateStatus,
  type BinaryUpdateStatus,
} from '../src/dashboard/web/update-action.js';

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

describe('dashboard update and restart action', () => {
  it('installs first, then restarts with the installed version delta', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.0.0',
        newVersion: '3.1.0',
        changed: true,
      }))
      .mockResolvedValueOnce(json(202, { ok: true }));
    const phases: string[] = [];

    await expect(updateAndRestartBotmux(fetchImpl, phase => phases.push(phase))).resolves.toEqual({
      oldVersion: '3.0.0',
      newVersion: '3.1.0',
      changed: true,
      restarted: true,
    });
    expect(phases).toEqual(['updating', 'restarting']);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/update/run', { method: 'POST' });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/update/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update: { oldVersion: '3.0.0', newVersion: '3.1.0' } }),
    });
  });

  it('still restarts when another updater already installed the latest version', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.1.0',
        newVersion: '3.1.0',
        changed: false,
      }))
      .mockResolvedValueOnce(json(202, { ok: true }));

    await expect(updateAndRestartBotmux(fetchImpl)).resolves.toMatchObject({
      changed: false,
      restarted: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('installs an allow-listed rollback version before restarting', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(202, {
      ok: true,
      oldVersion: '3.1.0',
      newVersion: '3.0.0',
      changed: true,
    }));
    const phases: string[] = [];

    await expect(updateAndRestartBotmux(fetchImpl, phase => phases.push(phase), '3.0.0')).resolves.toMatchObject({
      oldVersion: '3.1.0',
      newVersion: '3.0.0',
      restarted: true,
    });
    expect(phases).toEqual(['updating', 'restarting']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/update/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '3.0.0' }),
    });
  });

  it('rejects a rollback response that did not install the requested version', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(202, {
      ok: true,
      oldVersion: '3.1.0',
      newVersion: '3.1.0',
      changed: false,
    }));

    await expect(updateAndRestartBotmux(fetchImpl, undefined, '3.0.0'))
      .rejects.toThrow('Invalid rollback response');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never restarts after an install failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(500, {
      ok: false,
      error: 'install_failed',
      detail: 'registry unavailable',
    }));

    await expect(updateAndRestartBotmux(fetchImpl)).rejects.toThrow('registry unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns restarted:false when the restart handoff is rejected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.0.0',
        newVersion: '3.1.0',
        changed: true,
      }))
      .mockResolvedValueOnce(json(500, { ok: false, error: 'restart_failed' }));

    await expect(updateAndRestartBotmux(fetchImpl)).resolves.toEqual({
      oldVersion: '3.0.0',
      newVersion: '3.1.0',
      changed: true,
      restarted: false,
      restartError: 'restart_failed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a protocol-bootstrap 409 as a generic restart failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.0.0',
        newVersion: '3.1.0',
        changed: true,
      }))
      .mockResolvedValueOnce(json(409, {
        ok: false,
        error: 'bootstrap_shutdown_protocol_required',
      }));

    await expect(updateAndRestartBotmux(fetchImpl)).resolves.toEqual({
      oldVersion: '3.0.0',
      newVersion: '3.1.0',
      changed: true,
      restarted: false,
      restartError: 'bootstrap_shutdown_protocol_required',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed successful update response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { ok: true }));

    await expect(updateAndRestartBotmux(fetchImpl)).rejects.toThrow('Invalid update response');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('carries the server error code on rejection so 409 update_in_flight is detectable', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(409, { ok: false, error: 'update_in_flight' }));

    const error = await updateAndRestartBotmux(fetchImpl)
      .then(() => null, (e: unknown) => e);
    expect(updateActionErrorCode(error)).toBe('update_in_flight');
    expect(error).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a busy lock must not trigger the restart call
  });
});

describe('updateResponseNeedsRestart', () => {
  it('requires a restart when the version changed (generic npm/pnpm/bun path)', () => {
    expect(updateResponseNeedsRestart({ changed: true })).toBe(true);
  });

  it('requires a restart when restartRequired is set even if changed is false', () => {
    // The core local-dev regression: a build-only update (HEAD unchanged →
    // changed:false) still regenerated dist/ and MUST restart to apply it.
    expect(updateResponseNeedsRestart({ changed: false, restartRequired: true })).toBe(true);
  });

  it('does not restart when nothing changed and no restart is required', () => {
    expect(updateResponseNeedsRestart({ changed: false })).toBe(false);
    expect(updateResponseNeedsRestart({})).toBe(false);
  });
});

describe('binary update progress helpers', () => {
  const downloading = (received: number, total: number | null): BinaryUpdateStatus => ({
    version: '3.41.0', phase: 'download', bytesReceived: received, bytesTotal: total,
  });

  it('formats byte sizes in B/KB/MB/GB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(Math.round(1.5 * 1024 * 1024))).toBe('1.5 MB');
    expect(formatBytes(174 * 1024 * 1024)).toBe('174 MB');
  });

  it('maps a live download onto the install half of the ring', () => {
    expect(binaryProgressRingValue(downloading(0, 100))).toBe(5);
    expect(binaryProgressRingValue(downloading(50, 100))).toBe(25);
    expect(binaryProgressRingValue(downloading(100, 100))).toBe(45);
    // Never exceed the download segment even if the server miscounts.
    expect(binaryProgressRingValue(downloading(500, 100))).toBe(45);
    // Post-download stages hold just below the restart segment.
    expect(binaryProgressRingValue({ ...downloading(100, 100), phase: 'checksum' })).toBe(46);
    expect(binaryProgressRingValue({ ...downloading(100, 100), phase: 'probe' })).toBe(47);
    expect(binaryProgressRingValue({ ...downloading(100, 100), phase: 'swap' })).toBe(48);
  });

  it('falls back to no ring value without a Content-Length total', () => {
    expect(binaryDownloadFraction(downloading(1234, null))).toBeNull();
    expect(binaryProgressRingValue(downloading(1234, null))).toBeNull();
  });

  it('renders measured progress text, and stage labels past 100%', () => {
    const vars: Array<Record<string, string | number>> = [];
    const fakeT = (key: string, params?: Record<string, string | number>): string => {
      vars.push(params ?? {});
      return `${key}|${JSON.stringify(params ?? {})}`;
    };
    const text = binaryProgressText(downloading(50 * 1024 * 1024, 100 * 1024 * 1024), fakeT);
    expect(text).toContain('update.downloadProgress');
    expect(text).toContain('"percent":50');
    expect(binaryProgressText(downloading(1234, null), fakeT)).toContain('update.downloadProgressUnknown');
    expect(binaryProgressText({ ...downloading(100, 100), phase: 'checksum' }, fakeT)).toContain('update.binaryChecksum');
    expect(vars.every(v => v.version === 'v3.41.0')).toBe(true);
  });
});

describe('classifyOtherUpdate after a 409', () => {
  it('exposes live progress when the blocking update is in this dashboard process', () => {
    const binary = { version: '3.41.0', phase: 'download', bytesReceived: 1, bytesTotal: 100 } as const;
    expect(classifyOtherUpdate({ current: '3.40.0', latest: '3.41.0', updateInFlight: true, binaryUpdate: binary }))
      .toBe('progress');
  });

  it('reports busy for an in-process npm/local-dev update that has no byte progress', () => {
    expect(classifyOtherUpdate({ current: '3.40.0', latest: '3.41.0', updateInFlight: true }))
      .toBe('busy');
  });

  it('never claims completion from the in-process flag alone — a cross-process lock holder leaves it false', () => {
    // The regression shape: CLI/maintenance holds the lock; this dashboard's
    // flag stays false and versions are still behind.
    expect(classifyOtherUpdate({ current: '3.40.0', latest: '3.41.0', behind: true, updateInFlight: false }))
      .toBe('waiting');
  });

  it('detects completion only from version state', () => {
    expect(classifyOtherUpdate({ current: '3.41.0', latest: '3.41.0', behind: false, updateInFlight: false }))
      .toBe('completed');
  });
});

describe('observedInstallCompleted — install state, never a reload gate', () => {
  it('update: completed once behind clears', () => {
    expect(observedInstallCompleted(
      { current: '3.40.0', latest: '3.41.0', behind: false }, '3.40.0', false,
    )).toBe(true);
  });

  it('update: still behind with the in-process flag false is NOT completed (cross-process lock holder)', () => {
    expect(observedInstallCompleted(
      { current: '3.40.0', latest: '3.41.0', behind: true, updateInFlight: false }, '3.40.0', false,
    )).toBe(false);
  });

  it('update: a moved current also completes even when latest is unknown', () => {
    expect(observedInstallCompleted(
      { current: '3.41.0', latest: null, behind: true }, '3.40.0', false,
    )).toBe(true);
  });

  it('rollback: completes only when current moves to the rolled-back version', () => {
    expect(observedInstallCompleted(
      { current: '3.41.0', latest: '3.41.0', behind: false }, '3.41.0', true,
    )).toBe(false);
    expect(observedInstallCompleted(
      { current: '3.40.0', latest: '3.41.0', behind: true }, '3.41.0', true,
    )).toBe(true);
  });

  it('rollback ignores the update-style behind=false signal while current has not moved', () => {
    expect(observedInstallCompleted(
      { current: '3.41.0', latest: '3.40.0', behind: false }, '3.41.0', true,
    )).toBe(false);
  });
});

describe('pollUpdateStatus', () => {
  it('pushes parsed status snapshots until stopped', async () => {
    const snapshots: unknown[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      current: '3.40.0', latest: '3.41.0', updateInFlight: true,
    }));
    const stop = pollUpdateStatus(fetchImpl, s => snapshots.push(s), 5);
    await new Promise(resolve => setTimeout(resolve, 20));
    stop();
    const callsAfterStop = fetchImpl.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(snapshots.length).toBeGreaterThan(0);
    expect((snapshots[0] as { updateInFlight: boolean }).updateInFlight).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterStop);
  });

  it('fires the timeout even when every request fails, then stops polling', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
      const onTimeout = vi.fn();
      const stop = pollUpdateStatus(fetchImpl, () => {}, 1000, 10_000, onTimeout);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // Timeout is terminal: the poller stopped itself.
      const callsAtTimeout = fetchImpl.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl.mock.calls.length).toBe(callsAtTimeout);
      stop(); // stopping again is a no-op, not a second timeout
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires the timeout while the server keeps answering non-200 (no successful snapshot)', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
      const onStatus = vi.fn();
      const onTimeout = vi.fn();
      pollUpdateStatus(fetchImpl, onStatus, 1000, 5_000, onTimeout);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(onStatus).not.toHaveBeenCalled();
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires the timeout after an explicit stop (update finished normally)', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(Response.json({
        current: '3.40.0', latest: '3.41.0', behind: false,
      }));
      const onTimeout = vi.fn();
      const stop = pollUpdateStatus(fetchImpl, () => {}, 1000, 10_000, onTimeout);
      await vi.advanceTimersByTimeAsync(2_000);
      stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
