import { mockCleanupRelease } from './helpers/codex-cleanup-release.js';
import { captureCodexCleanupRelease } from '../src/services/codex-cleanup-release.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import { archiveCodexForCleanup as archiveImpl, restoreCodexCleanupArchive } from '../src/services/codex-cleanup-archive.js';
import { cleanupIdleSessions } from '../src/dashboard/session-cleanup.js';
import { runAutoCleanupTick } from '../src/dashboard/auto-cleanup.js';

function archiveCodexForCleanup(...args: Parameters<typeof archiveImpl>) {
  args[4] ??= async () => mockCleanupRelease(args[0]);
  return archiveImpl(...args);
}
function session(patch: Partial<Session> = {}): Session {
  return { sessionId: 'local', status: 'closed', cliId: 'codex', backendType: 'tmux',
    cliSessionId: 'native', codexCleanupTarget: { threadId: 'native', codexHome: '/tmp/codex-home', codexBin: '/tmp/fake-codex' },
    ...patch } as Session;
}

describe('Codex idle cleanup archive journal', () => {
  it.each([false, undefined])('default/off leaves the native thread untouched (%s)', async enabled => {
    const row = session(); const persist = vi.fn(); const rpc = vi.fn();
    expect(await archiveCodexForCleanup(row, enabled === true, persist, rpc)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it.each([
    { adoptedFrom: { cwd: '/tmp' } }, { existingAppServerEndpoint: 'ws://external' },
    { creationSource: 'external' }, { codexCleanupTarget: undefined },
    { cliId: 'claude-code' }, { status: 'active', suspendedColdResume: true },
    { status: 'active' }, { backendType: 'remote-runner' }, { sandbox: 'scratch' },
    { wrapperCli: 'other' }, { cliSessionId: 'different' },
  ] as Partial<Session>[])('excludes adopt/history/other CLI/remote/suspend/restart: %j', async patch => {
    const rpc = vi.fn(); await archiveCodexForCleanup(session(patch), true, vi.fn(), rpc);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('reports a missing historical target instead of silently implying native archive success', async () => {
    const rpc = vi.fn(); const persist = vi.fn();
    expect(await archiveCodexForCleanup(session({ codexCleanupTarget: undefined, backendType: undefined }), true, persist, rpc)).toBe('codex_archive_target_unverified');
    expect(rpc).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('uses worker-proven targets for historical rows without persisted backendType', async () => {
    const row = session({ backendType: undefined }); const rpc = vi.fn().mockResolvedValue(undefined);
    expect(await archiveCodexForCleanup(row, true, vi.fn(), rpc)).toBeUndefined();
    expect(rpc).toHaveBeenCalledOnce();
    await restoreCodexCleanupArchive(row, vi.fn(), rpc);
    expect(row.codexCleanupArchive).toBeUndefined();
  });
  it('archives owned codex-app threads using the frozen native Codex executable', async () => {
    const row = session({ cliId: 'codex-app' }); const rpc = vi.fn().mockResolvedValue(undefined);
    await archiveCodexForCleanup(row, true, vi.fn(), rpc);
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ codexBin: '/tmp/fake-codex', threadId: 'native', archived: true }));
    await restoreCodexCleanupArchive(row, vi.fn(), rpc);
    expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }));
  });
  it('persists intent before RPC, pins the home and owner, and makes repeated close idempotent', async () => {
    const row = session({ ownerOpenId: 'ou_owner' }); const states: unknown[] = [];
    const persist = () => states.push(structuredClone(row.codexCleanupArchive));
    const rpc = vi.fn(async opts => {
      expect(states).toMatchObject([{ threadId: 'native', state: 'pending' }]);
      expect(opts.env).toMatchObject({ CODEX_HOME: '/tmp/codex-home', BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_owner' });
    });
    await archiveCodexForCleanup(row, true, persist, rpc);
    await archiveCodexForCleanup(row, true, persist, rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(row.codexCleanupArchive?.state).toBe('archived');
    expect(states).toHaveLength(2);
  });
  it('serializes concurrent cleanup and reopen so the final native state is restored', async () => {
    const row = session();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: boolean[] = [];
    const rpc = vi.fn(async opts => { calls.push(opts.archived); if (opts.archived) await gate; });
    const close = archiveCodexForCleanup(row, true, vi.fn(), rpc);
    await Promise.resolve(); await Promise.resolve();
    const reopen = restoreCodexCleanupArchive(row, vi.fn(), rpc);
    release();
    await Promise.all([close, reopen]);
    expect(calls).toEqual([true, false]);
    expect(row.codexCleanupArchive).toBeUndefined();
  });
  it('keeps uncertain failure recoverable and restores even when the setting is later off', async () => {
    const row = session(); const persist = vi.fn();
    expect(await archiveCodexForCleanup(row, true, persist, vi.fn().mockRejectedValue(new Error('RPC timeout')))).toBe('RPC timeout');
    expect(row.codexCleanupArchive?.state).toBe('pending');
    const rpc = vi.fn().mockResolvedValue(undefined);
    await restoreCodexCleanupArchive(row, persist, rpc);
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'native', archived: false }));
    expect(row.codexCleanupArchive).toBeUndefined();
    await restoreCodexCleanupArchive(row, persist, rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('retains the journal on unarchive failure and rejects a changed identity', async () => {
    const row = session({ codexCleanupArchive: { threadId: 'native', state: 'archived' } });
    await expect(restoreCodexCleanupArchive(row, vi.fn(), vi.fn().mockRejectedValue(new Error('failed')))).rejects.toThrow('failed');
    expect(row.codexCleanupArchive?.state).toBe('archived');
    row.cliSessionId = 'other'; const rpc = vi.fn();
    await expect(restoreCodexCleanupArchive(row, vi.fn(), rpc)).rejects.toThrow('identity changed');
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['manual', 'scheduled'])('%s cleanup closes rows and separately reports native archive failure', async mode => {
    const now = Date.now();
    const rows = [{ sessionId: 'local', status: 'idle', lastMessageAt: now - 25 * 3600000 }];
    const rpc = vi.fn().mockRejectedValue(new Error('archive failed'));
    const closeCandidate = async () => ({ sessionId: 'local', ok: true,
      archiveError: await archiveCodexForCleanup(session(), true, vi.fn(), rpc) });
    const result = mode === 'manual' ? await cleanupIdleSessions(rows, 24, closeCandidate, now)
      : await runAutoCleanupTick({ now: () => now, readConfig: () => ({ enabled: true, olderThanHours: 24 }),
        readLastRun: () => undefined, writeLastRun: vi.fn(), getSessions: () => rows, closeCandidate });
    expect(result).toMatchObject({ closed: 1, failed: 0, archiveFailed: 1 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('fails closed if the teardown fence cannot prove release, without issuing an archive RPC', async () => {
    const rpc = vi.fn(); const row = session();
    expect(await archiveCodexForCleanup(row, true, vi.fn(), rpc,
      async () => { throw new Error('teardown unverified'); })).toBe('teardown unverified');
    expect(rpc).not.toHaveBeenCalled();
    expect(row.codexCleanupArchive).toBeUndefined();
  });

  it('Worker exit 0 without native-release proof is rejected', async () => {
    const worker = Object.assign(new EventEmitter(), { killed: false, exitCode: null, signalCode: null });
    const ticket = captureCodexCleanupRelease(worker as any,
      { sessionId: 'test', threadId: 'native', workerGeneration: 1 });
    worker.emit('exit', 0, null);
    await expect(ticket.released).rejects.toThrow('codex_native_release_unverified');
  });

  it('requires proof for a fresh archive even when there is no live Worker', async () => {
    const rpc = vi.fn();
    expect(await archiveImpl(session(), true, vi.fn(), rpc)).toBe('codex_native_release_unverified');
    expect(rpc.mock.calls.length).toBe(0);
  });

  it('rejects a release receipt from another Worker generation', async () => {
    const row = session({ workerGeneration: 2 }); const rpc = vi.fn();
    expect(await archiveImpl(row, true, vi.fn(), rpc, async () => mockCleanupRelease(row)))
      .toBe('codex_native_release_unverified');
    expect(rpc.mock.calls.length).toBe(0);
  });

});
