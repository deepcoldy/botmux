import { captureCodexCleanupRelease } from '../src/services/codex-cleanup-release.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { archiveCodexForCleanup } from '../src/services/codex-cleanup-archive.js';
import { withBotTurnAdmission, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import { startIpcServer } from '../src/core/dashboard-ipc-server.js';
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function row(): Session { return { sessionId: 'review-boundary-local', status: 'closed', cliId: 'codex', backendType: 'pty',
  larkAppId: 'review-boundary-bot', cliSessionId: 'mock-native',
  codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/fake-home', codexBin: '/tmp/fake-bin' } } as Session; }
afterEach(() => { vi.restoreAllMocks(); vi.mocked(setCodexAppThreadArchived).mockReset(); __testOnly_resetBotTurnMutationGates(); });

describe('review: original native-process release and gate generation boundaries', () => {
  it.each(['verified', 'legacy', 'timeout'])('requires native proof with real RPC engine and delayed child (%s)', async mode => {
    const legacy = mode !== 'verified';
    const home = mkdtempSync(join(tmpdir(), 'botmux-review-native-'));
    let nativePid: number | undefined;
    const worker = spawnTsScript(resolve('test/fixtures/codex-cleanup-release-worker.ts'),
      [resolve('test/fixtures/fake-delayed-codex-rpc-server.mjs'), mode], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: home, TMPDIR: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    let errorText = ''; worker.stderr?.on('data', b => { errorText += String(b); });
    try {
      const ready = await new Promise<any>((resolveReady, reject) => {
        worker.once('message', resolveReady); worker.once('error', reject);
        worker.once('exit', code => { if (nativePid === undefined) reject(new Error(`early exit ${code}: ${errorText}`)); });
      });
      nativePid = ready.nativePid; expect(nativePid).toBeGreaterThan(0);
      const nativeRow = row(); nativeRow.cliSessionId = ready.threadId; nativeRow.codexCleanupTarget!.threadId = ready.threadId;
      const ticket = captureCodexCleanupRelease(worker, { sessionId: nativeRow.sessionId, threadId: ready.threadId, workerGeneration: 1 });
      let nativeAliveAtArchive: boolean | undefined;
      const rpc = vi.fn(async () => { nativeAliveAtArchive = alive(nativePid!); });
      const archive = archiveCodexForCleanup(nativeRow, true, () => {}, rpc, () => ticket.released);
      worker.send({ type: 'close', codexCleanupRelease: ticket.request });
      const archiveError = await archive;
      console.log('native release observation', { workerExitCode: worker.exitCode, nativeAliveAtArchive });
      if (worker.exitCode == null && worker.signalCode == null) await new Promise(resolve => worker.once('exit', resolve));
      expect(worker.exitCode).toBe(0);
      if (legacy) { expect(archiveError).toBe('codex_native_release_unverified'); expect(rpc.mock.calls.length).toBe(0); }
      else { expect(archiveError).toBeUndefined(); expect(nativeAliveAtArchive).toBe(false); }
    } finally {
      if (worker.exitCode == null && worker.signalCode == null) worker.kill('SIGKILL');
      if (nativePid) {
        try { await vi.waitFor(() => expect(alive(nativePid!)).toBe(false), { timeout: 4000, interval: 100 }); }
        finally { if (alive(nativePid)) { try { process.kill(-nativePid, 'SIGKILL'); } catch {} } }
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  it.each(['old-to-new', 'none-to-new'])('does not archive the current Worker using the pre-gate %s snapshot', async mode => {
    const persisted = row(); persisted.status = 'active';
    const oldWorker = Object.assign(new EventEmitter(), { killed: false });
    const newWorker = Object.assign(new EventEmitter(), { killed: false });
    let current: any = { session: persisted, larkAppId: persisted.larkAppId, worker: mode === 'old-to-new' ? oldWorker : undefined };
    const find = vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(() => current);
    vi.spyOn(store, 'getSession').mockReturnValue(persisted);
    vi.spyOn(store, 'getOwnedSession').mockReturnValue(persisted);
    vi.spyOn(store, 'updateSession').mockImplementation(() => {});
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    let actualClosedWorker: unknown;
    let ticket: ReturnType<typeof captureCodexCleanupRelease> | undefined;
    const close = vi.spyOn(pool, 'closeSession').mockImplementation(async (_id, opts) => {
      actualClosedWorker = current.worker; persisted.status = 'closed';
      ticket = captureCodexCleanupRelease(current.worker, { sessionId: persisted.sessionId, threadId: persisted.cliSessionId!, workerGeneration: 2 });
      opts?.onCodexCleanupRelease?.(ticket);
      return { ok: true, alreadyClosed: false, known: true, outcome: 'closed' };
    });
    vi.mocked(setCodexAppThreadArchived).mockResolvedValue(undefined);
    let releaseAdmission!: () => void;
    let admissionStarted!: () => void;
    const entered = new Promise<void>(r => { admissionStarted = r; });
    const admission = withBotTurnAdmission(persisted.larkAppId!, async () => {
      admissionStarted(); await new Promise<void>(r => { releaseAdmission = r; });
    });
    await entered;
    const server = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const request = fetch(`http://127.0.0.1:${server.port}/api/sessions/${persisted.sessionId}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    try {
      await vi.waitFor(() => expect(find).toHaveBeenCalled());
      expect(close).not.toHaveBeenCalled();
      current = { ...current, worker: newWorker };
      oldWorker.emit('exit', 0, null);
      releaseAdmission(); await admission;
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      await new Promise(resolve => setImmediate(resolve));
      console.log('gate release observation', { mode, actualClosedNewWorker: actualClosedWorker === newWorker,
        archiveCallsBeforeNewWorkerExit: vi.mocked(setCodexAppThreadArchived).mock.calls.length });
      expect(actualClosedWorker).toBe(newWorker);
      expect(vi.mocked(setCodexAppThreadArchived).mock.calls.length).toBe(0);
    } finally {
      releaseAdmission(); oldWorker.emit('exit', 0, null);
      if (ticket) newWorker.emit('message', { type: 'codex_cleanup_released', ...ticket.request, released: true });
      newWorker.emit('exit', 0, null);
      await admission; await request; await server.close();
    }
  });
});
