import { describe, expect, it, vi } from 'vitest';
import { cleanupExplicitSessionBacking } from '../src/core/explicit-session-backing-cleanup.js';

const SID = 'abcd1234-1111-2222-3333-444444444444';

describe('offline explicit session backing cleanup', () => {
  for (const backendType of ['tmux', 'herdr', 'zellij'] as const) {
    it(`confirms ${backendType} is absent before reporting cleanup success`, async () => {
      const killPersistent = vi.fn();
      const probePersistent = vi.fn(() => 'missing' as const);
      const result = await cleanupExplicitSessionBacking(
        { sessionId: SID, backendType },
        { killPersistent, probePersistent },
      );

      expect(result).toEqual({
        ok: true,
        kind: 'destroyed_persistent',
        backendType,
        name: 'bmx-abcd1234',
      });
      expect(killPersistent).toHaveBeenCalledWith(backendType, 'bmx-abcd1234');
      expect(probePersistent).toHaveBeenCalledWith(backendType, 'bmx-abcd1234');
    });
  }

  it('does not report success when a persistent backend still exists after kill', async () => {
    const result = await cleanupExplicitSessionBacking(
      { sessionId: SID, backendType: 'tmux' },
      {
        killPersistent: vi.fn(),
        probePersistent: vi.fn(() => 'exists'),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'persistent_destroy_failed',
      error: 'backing_session_still_exists',
    });
  });

  it('cancels Riff using the supplied authoritative bot config and returns the exact task id', async () => {
    const cancelRiffTask = vi.fn(async () => true);
    const result = await cleanupExplicitSessionBacking(
      {
        sessionId: SID,
        backendType: 'riff',
        riffParentTaskId: 'riff-task-1',
        riffConfig: { baseUrl: 'https://riff.example', jwt: 'token' },
      },
      { cancelRiffTask },
    );
    expect(cancelRiffTask).toHaveBeenCalledWith(
      { baseUrl: 'https://riff.example', jwt: 'token' },
      'riff-task-1',
    );
    expect(result).toEqual({ ok: true, kind: 'cancelled_riff', taskId: 'riff-task-1' });
  });

  it('fails closed on Riff cancel failure so the caller can preserve its task id', async () => {
    const record = {
      sessionId: SID,
      backendType: 'riff' as const,
      riffParentTaskId: 'riff-task-retry',
      riffConfig: { baseUrl: 'https://riff.example' },
    };
    const result = await cleanupExplicitSessionBacking(record, {
      cancelRiffTask: vi.fn(async () => false),
    });
    expect(result).toEqual({
      ok: false,
      kind: 'riff_cancel_failed',
      backendType: 'riff',
      taskId: 'riff-task-retry',
    });
    expect(record.riffParentTaskId).toBe('riff-task-retry');
  });

  it('fails closed when current Riff config is unavailable', async () => {
    expect(await cleanupExplicitSessionBacking({
      sessionId: SID,
      backendType: 'riff',
      riffParentTaskId: 'riff-task-no-config',
    })).toEqual({
      ok: false,
      kind: 'riff_config_missing',
      backendType: 'riff',
      taskId: 'riff-task-no-config',
    });
  });

  it('never destroys an adopted user-owned pane', async () => {
    const killPersistent = vi.fn();
    const probePersistent = vi.fn();
    expect(await cleanupExplicitSessionBacking(
      { sessionId: SID, backendType: 'tmux', adopted: true },
      { killPersistent, probePersistent: probePersistent as any },
    )).toEqual({ ok: true, kind: 'skipped_adopted' });
    expect(killPersistent).not.toHaveBeenCalled();
    expect(probePersistent).not.toHaveBeenCalled();
  });

  it('does not guess a persistent backend for an unstamped legacy row', async () => {
    const killPersistent = vi.fn();
    const probePersistent = vi.fn();
    expect(await cleanupExplicitSessionBacking(
      { sessionId: SID },
      { killPersistent, probePersistent: probePersistent as any },
    )).toEqual({ ok: true, kind: 'no_backing' });
    expect(killPersistent).not.toHaveBeenCalled();
    expect(probePersistent).not.toHaveBeenCalled();
  });
});
