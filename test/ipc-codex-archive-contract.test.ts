import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as botRegistry from '../src/bot-registry.js';
import * as globalConfig from '../src/global-config.js';
import * as sessionStore from '../src/services/session-store.js';
import * as docSubsStore from '../src/services/doc-subs-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession, type SessionController } from '../src/core/session-controller.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { setCodexAppThreadArchived } from '../src/services/codex-app-threads.js';
import { nativeReleaseWorker } from './helpers/codex-cleanup-release.js';

vi.mock('../src/core/daemon-ipc-session-auth.js', async original => ({
  ...await original<typeof import('../src/core/daemon-ipc-session-auth.js')>(),
  authorizeSessionScopedIpc: vi.fn(() => ({ ok: true })),
}));
vi.mock('../src/services/codex-app-threads.js', async original => ({
  ...await original<typeof import('../src/services/codex-app-threads.js')>(),
  setCodexAppThreadArchived: vi.fn(async () => undefined),
}));

let previousDataDir: string;
let dataDir: string;
let handle: IpcServerHandle | undefined;
let controller: SessionController | undefined;

beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-archive-contract-'));
  config.session.dataDir = dataDir;
  sessionStore.init('archive-contract');
  vi.spyOn(docSubsStore, 'listDocSubscriptionsForSession').mockReturnValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  await handle?.close(); handle = undefined;
  controller?.store.close(); controller = undefined;
  workerPool.setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('archive-contract');
  vi.mocked(setCodexAppThreadArchived).mockReset();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('archive policy across real IPC and contract close', () => {
  it.each([
    { scope: 'bot', nextEnabled: false }, { scope: 'global', nextEnabled: false },
    { scope: 'bot', nextEnabled: true }, { scope: 'global', nextEnabled: true },
  ])('uses one policy when $scope changes to $nextEnabled during contract persistence', async ({ scope, nextEnabled }) => {
    const bot = {
      config: { larkAppId: 'archive-contract', cliId: 'codex',
        ...(scope === 'bot' ? { archiveCodex: !nextEnabled } : {}) },
      resolvedAllowedUsers: [], resolvedBlockedUsers: [],
    };
    const settings = { sessionCleanup: { archiveCodex: scope === 'global' && !nextEnabled } };
    vi.spyOn(botRegistry, 'getBot').mockReturnValue(bot as any);
    vi.spyOn(globalConfig, 'readGlobalConfig').mockImplementation(() => settings);
    const session = sessionStore.createSession('oc_contract', 'om_contract', 'contract', 'group');
    Object.assign(session, { larkAppId: 'archive-contract', cliId: 'codex', backendType: 'pty',
      cliSessionId: 'contract-native', workerGeneration: 1,
      codexCleanupTarget: { threadId: 'contract-native', codexHome: dataDir, codexBin: '/tmp/mock-native-bin' } });
    sessionStore.updateSession(session);
    const worker = nativeReleaseWorker();
    const ds = { session, worker, larkAppId: session.larkAppId,
      chatId: session.chatId, chatType: 'group', scope: 'thread', workerGeneration: 1,
      initConfig: { backendType: 'pty' }, hasHistory: true } as unknown as DaemonSession;
    workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    controller = controllerForSession(ds, true)!;
    controller.bindWorker(1);
    const flushPrimary = controller.flushPrimary.bind(controller);
    vi.spyOn(controller, 'flushPrimary').mockImplementationOnce(() => {
      const flushing = flushPrimary();
      queueMicrotask(() => {
        if (scope === 'bot') bot.config.archiveCodex = nextEnabled;
        else settings.sessionCleanup.archiveCodex = nextEnabled;
      });
      return flushing;
    });
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.archiveError).toBeUndefined();
    expect(!!worker.send.mock.calls[0]?.[0]?.codexCleanupRelease).toBe(!nextEnabled);
    expect(vi.mocked(setCodexAppThreadArchived).mock.calls.length).toBe(nextEnabled ? 0 : 1);
  });
});
