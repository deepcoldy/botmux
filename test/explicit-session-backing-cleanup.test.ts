import { describe, expect, it, vi } from 'vitest';
import { cleanupExplicitSessionBacking, proveRiffThreadStopped } from '../src/core/explicit-session-backing-cleanup.js';

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

  it('passes the exact owner session id when destroying ZMX', async () => {
    const killPersistent = vi.fn();
    const probePersistent = vi.fn(() => 'missing' as const);

    await expect(cleanupExplicitSessionBacking(
      { sessionId: SID, backendType: 'zmx' },
      { killPersistent, probePersistent },
    )).resolves.toEqual({
      ok: true,
      kind: 'destroyed_persistent',
      backendType: 'zmx',
      name: 'bmx-abcd1234',
    });
    expect(killPersistent).toHaveBeenCalledWith('zmx', 'bmx-abcd1234', SID);
  });

  it('destroys a tmux row on the server its pane was frozen onto', async () => {
    const target = { backendType: 'tmux' as const, sessionName: 'bmx-abcd1234', socketName: 'botmux' };
    const killPersistent = vi.fn();
    const probePersistent = vi.fn(() => 'missing' as const);
    const killTarget = vi.fn();
    // Alive on the dedicated socket: a name-only probe of the default server
    // would have read 'missing' and reported a live pane as destroyed.
    const probeTarget = vi.fn(() => 'exists' as const);
    const result = await cleanupExplicitSessionBacking(
      { sessionId: SID, backendType: 'tmux', persistentBackendTarget: target },
      { killPersistent, probePersistent, killTarget, probeTarget },
    );
    expect(result).toMatchObject({ ok: false, kind: 'persistent_destroy_failed', error: 'backing_session_still_exists' });
    expect(killTarget).toHaveBeenCalledWith(target, SID);
    expect(probeTarget).toHaveBeenCalledWith(target);
    expect(killPersistent).not.toHaveBeenCalled();
    expect(probePersistent).not.toHaveBeenCalled();
  });

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


describe('proving a Riff thread has nothing left running', () => {
  const riffConfig = { baseUrl: 'https://riff.invalid', jwt: 'test' };
  const task = (id: string, status: string) => ({
    id,
    status,
    terminal: ['completed', 'failed', 'cancelled', 'timeout'].includes(status),
  });
  const listings = (...rounds: Array<Array<ReturnType<typeof task>>>) => {
    const queue = [...rounds];
    return vi.fn(async () => ({ ok: true as const, tasks: queue.shift() ?? [] }));
  };
  const sleep = vi.fn(async () => undefined);

  it('proves an all-terminal thread without cancelling anything', async () => {
    const queryThread = listings([task('task-a', 'cancelled'), task('task-b', 'completed')]);
    const cancelRiffTask = vi.fn(async () => true);
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig },
      { queryThread, cancelRiffTask, sleep },
    )).toEqual({ ok: true, cancelledTaskIds: [] });
    expect(queryThread).toHaveBeenCalledWith(riffConfig, SID);
    expect(cancelRiffTask).not.toHaveBeenCalled();
  });

  it('cancels a task the session never recorded and proves only once a new listing shows it stopped', async () => {
    const queryThread = listings(
      [task('task-a', 'cancelled'), task('task-late', 'running')],
      [task('task-a', 'cancelled'), task('task-late', 'running')],
      [task('task-a', 'cancelled'), task('task-late', 'cancelled')],
    );
    const cancelRiffTask = vi.fn(async () => true);
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig },
      { queryThread, cancelRiffTask, sleep, attempts: 3 },
    )).toEqual({ ok: true, cancelledTaskIds: ['task-late'] });
    expect(cancelRiffTask.mock.calls.map(call => call[1])).toEqual(['task-late', 'task-late']);
    expect(queryThread).toHaveBeenCalledTimes(3);
  });

  it('is not proof while a task is still running after the last listing', async () => {
    const queryThread = listings(
      [task('task-late', 'running')],
      [task('task-late', 'creating_session')],
    );
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig },
      { queryThread, cancelRiffTask: vi.fn(async () => true), sleep, attempts: 2 },
    )).toMatchObject({ ok: false, kind: 'riff_thread_still_running', taskId: 'task-late' });
  });

  it('is not proof when the thread cannot be listed', async () => {
    const queryThread = vi.fn(async () => ({ ok: false as const, error: 'tasks query HTTP 503' }));
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig },
      { queryThread, cancelRiffTask: vi.fn(async () => true), sleep },
    )).toEqual({ ok: false, kind: 'riff_thread_query_failed', error: 'tasks query HTTP 503' });
  });

  it('is not proof when a running task cannot be cancelled', async () => {
    const queryThread = listings([task('task-late', 'running')]);
    const cancelRiffTask = vi.fn(async () => false);
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig },
      { queryThread, cancelRiffTask, sleep },
    )).toEqual({ ok: false, kind: 'riff_cancel_failed', taskId: 'task-late' });
  });

  it('does not take a listing that is missing a task known to be in the thread (wrong identity reads as empty)', async () => {
    const queryThread = listings([]);
    const cancelRiffTask = vi.fn(async () => true);
    expect(await proveRiffThreadStopped(
      { threadId: SID, riffConfig, knownTaskIds: ['task-a'] },
      { queryThread, cancelRiffTask, sleep },
    )).toMatchObject({ ok: false, kind: 'riff_thread_listing_incomplete', taskId: 'task-a' });
    expect(cancelRiffTask).not.toHaveBeenCalled();
  });

  it('needs the bot riff config', async () => {
    const queryThread = vi.fn();
    expect(await proveRiffThreadStopped({ threadId: SID }, { queryThread }))
      .toEqual({ ok: false, kind: 'riff_config_missing' });
    expect(queryThread).not.toHaveBeenCalled();
  });
});
