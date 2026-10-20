import { mockCleanupRelease } from './helpers/codex-cleanup-release.js';
import { captureCodexCleanupRelease } from '../src/services/codex-cleanup-release.js';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as pool from '../src/core/worker-pool.js';
import * as store from '../src/services/session-store.js';
import * as globalConfig from '../src/global-config.js';
import { setCodexAppThreadArchived } from '../src/services/codex-app-threads.js';
import type { Session } from '../src/types.js';
vi.mock('../src/core/daemon-ipc-session-auth.js', async original => ({
  ...await original<typeof import('../src/core/daemon-ipc-session-auth.js')>(),
  authorizeSessionScopedIpc: vi.fn(() => ({ ok: true })),
}));
vi.mock('../src/services/codex-app-threads.js', async original => ({
  ...await original<typeof import('../src/services/codex-app-threads.js')>(),
  setCodexAppThreadArchived: vi.fn(async () => undefined),
}));
let handle: IpcServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; vi.restoreAllMocks(); vi.mocked(setCodexAppThreadArchived).mockReset(); });

async function close(idleCleanup: boolean, enabled: boolean, patch: Partial<Session> = {}, fail = false, worker?: any) {
  const row = { sessionId: 'mock-cleanup', status: 'active', cliId: 'codex', backendType: 'pty', larkAppId: 'mock-bot',
    cliSessionId: 'mock-native', codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-codex', codexBin: '/tmp/mock-codex-bin' },
    ...patch } as Session;
  vi.spyOn(pool, 'findActiveBySessionId').mockReturnValue({ session: row, larkAppId: row.larkAppId, worker } as any);
  vi.spyOn(store, 'getSession').mockReturnValue(row);
  vi.spyOn(store, 'getOwnedSession').mockReturnValue(row);
  vi.spyOn(store, 'updateSession').mockImplementation(() => {});
  vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: enabled } });
  vi.spyOn(pool, 'closeSession').mockImplementation(async (_id, opts) => {
    row.status = 'closed';
    const ticket = worker ? captureCodexCleanupRelease(worker, { sessionId: row.sessionId, threadId: row.cliSessionId!, workerGeneration: 1 })
      : { request: mockCleanupRelease(row), released: Promise.resolve(mockCleanupRelease(row)) };
    (worker as any)?.once('review-native-released', () => worker.emit('message', { type: 'codex_cleanup_released', ...ticket.request, released: true }));
    opts?.onCodexCleanupRelease?.(ticket);
    return { ok: true, alreadyClosed: false, outcome: 'closed' } as any;
  });
  if (fail) vi.mocked(setCodexAppThreadArchived).mockRejectedValueOnce(new Error('mock archive error'));
  else vi.mocked(setCodexAppThreadArchived).mockResolvedValue(undefined);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/mock-cleanup/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idleCleanup }),
  });
  return { row, response, body: await response.json() };
}
describe('daemon close idle-cleanup intent', () => {
  it.each([false, true])('archives only after explicit/idle close commits (%s)', async intent => {
    const result = await close(intent, true);
    expect(result.body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'mock-native', archived: true }));
    expect(result.row.codexCleanupArchive?.state).toBe('archived');
  });
  it.each([[false, false], [true, false]])('setting off does not archive (%s/%s)', async (intent, enabled) => {
    expect((await close(intent, enabled)).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('supports owned codex-app threads with the same cleanup intent', async () => {
    expect((await close(true, true, { cliId: 'codex-app' })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledWith(expect.objectContaining({ archived: true, codexBin: '/tmp/mock-codex-bin' }));
  });
  it('reports the observed legacy codex-app case without issuing any native write', async () => {
    const result = await close(true, true, { cliId: 'codex-app', backendType: undefined, codexCleanupTarget: undefined });
    expect(result.body).toMatchObject({ ok: true, archiveError: 'codex_archive_target_unverified' });
    expect(result.row.codexCleanupArchive).toBeUndefined();
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('archives a legacy codex-app row after its worker has proved the target', async () => {
    expect((await close(true, true, { cliId: 'codex-app', backendType: undefined })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).toHaveBeenCalledOnce();
  });
  it.each([false, true])('skips adopted external sessions (%s)', async intent => {
    expect((await close(intent, true, { adoptedFrom: { cwd: '/tmp' } })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps local close and recoverable failure (%s)', async intent => {
    const result = await close(intent, true, {}, true);
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, archiveError: 'mock archive error' });
    expect(result.row.status).toBe('closed');
    expect(result.row.codexCleanupArchive?.state).toBe('pending');
  });
  it('does not backfill previously closed historical rows on explicit close', async () => {
    expect((await close(false, true, { status: 'closed' })).body.ok).toBe(true);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('retries pending explicit close and skips an already archived journal', async () => {
    await close(false, true, { status: 'closed', codexCleanupArchive: { threadId: 'mock-native', state: 'pending', release: mockCleanupRelease({ sessionId: 'mock-cleanup', cliSessionId: 'mock-native' }) } });
    expect(setCodexAppThreadArchived).toHaveBeenCalledOnce();
    await handle?.close(); handle = undefined;
    vi.mocked(setCodexAppThreadArchived).mockClear();
    await close(false, true, { status: 'closed', codexCleanupArchive: { threadId: 'mock-native', state: 'archived' } });
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });

  it.each([false, true])('IPC close also waits for original Worker exit and fails closed on abnormal exit (%s)', async abnormal => {
    const worker = Object.assign(new EventEmitter(), { killed: false });
    const closing = close(false, true, {}, false, worker);
    try {
      await vi.waitFor(() => expect(pool.closeSession).toHaveBeenCalled());
      expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
      if (!abnormal) worker.emit('review-native-released');
      worker.emit('exit', abnormal ? null : 0, abnormal ? 'SIGKILL' : null);
      const result = await closing;
      expect(result.body.ok).toBe(true);
      if (abnormal) {
        expect(result.body.archiveError).toBe('codex_native_release_unverified');
        expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
      } else expect(setCodexAppThreadArchived).toHaveBeenCalledOnce();
    } finally { worker.emit('exit', 0, null); await closing; }
  });

  it('does not infer release for a legacy pending journal', async () => {
    const result = await close(false, true, { status: 'closed', codexCleanupArchive: { threadId: 'mock-native', state: 'pending' } });
    expect(result.body.archiveError).toBe('codex_native_release_unverified');
    expect(vi.mocked(setCodexAppThreadArchived).mock.calls.length).toBe(0);
  });

});
