import { nativeReleaseWorker } from './helpers/codex-cleanup-release.js';
import { EventEmitter } from 'node:events';
import * as globalConfig from '../src/global-config.js';
import { setCodexAppThreadArchived } from '../src/services/codex-app-threads.js';
import { restoreCodexCleanupArchive } from '../src/services/codex-cleanup-archive.js';
vi.mock('../src/services/codex-app-threads.js', async original => ({ ...await original<typeof import('../src/services/codex-app-threads.js')>(), setCodexAppThreadArchived: vi.fn(async () => undefined) }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as botRegistry from '../src/bot-registry.js';
import * as larkClient from '../src/im/lark/client.js';
import * as sessionStore from '../src/services/session-store.js';
import * as docSubsStore from '../src/services/doc-subs-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { handleCommand } from '../src/core/command-handler.js';
import { activeSessionKey, sessionAnchorId, type DaemonSession } from '../src/core/types.js';

let dataDir: string;
let previousDataDir: string;
beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-command-'));
  config.session.dataDir = dataDir;
  sessionStore.init('app-close-command');
  vi.spyOn(docSubsStore, 'listDocSubscriptionsForSession').mockReturnValue([]);
});
afterEach(() => {
  workerPool.setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('app-close-command');
  vi.mocked(setCodexAppThreadArchived).mockReset();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(options: {
  scope?: 'chat' | 'thread'; streamCardId?: string; privateCard?: boolean;
  disableStreamingCard?: boolean; noCardChats?: string[]; apiOnly?: boolean;
} = {}) {
  const bot = {
    config: { cliId: 'claude-code', larkAppId: 'app-close-command', ...options },
    resolvedAllowedUsers: ['ou_owner'], resolvedBlockedUsers: [],
  };
  vi.spyOn(botRegistry, 'getBot').mockReturnValue(bot as any);
  const session = sessionStore.createSession('oc_close', 'om_root', 'close command', 'group');
  session.larkAppId = 'app-close-command';
  session.cliId = 'claude-code';
  session.scope = options.scope ?? 'thread';
  sessionStore.updateSession(session);
  const ds = {
    session, worker: null, larkAppId: session.larkAppId, chatId: session.chatId,
    chatType: 'group', scope: session.scope, hasHistory: true,
    streamCardId: options.streamCardId,
  } as DaemonSession;
  const activeSessions = new Map([[activeSessionKey(ds), ds]]);
  workerPool.setActiveSessionsRegistry(activeSessions);
  const patch = vi.spyOn(larkClient, 'updateMessage').mockResolvedValue(undefined as any);
  const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
  const reply = vi.fn(async (..._args: any[]) => 'om_reply');
  const close = () => handleCommand('/close', sessionAnchorId(ds), {
    messageId: 'om_command', rootId: sessionAnchorId(ds), senderId: 'ou_operator',
    senderType: 'user', msgType: 'text', content: '/close', createTime: String(Date.now()),
  }, {
    activeSessions, sessionReply: reply, getActiveCount: () => activeSessions.size,
    lastRepoScan: new Map(),
  }, ds.larkAppId);
  return { ds, patch, ephemeral, reply, close };
}

describe('/close card delivery through the real session lifecycle', () => {
  it.each([true, false])('/close honors the archive toggle (%s) and reopening restores', async enabled => {
    const f = fixture({ streamCardId: 'om_live' });
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    f.ds.worker = nativeReleaseWorker() as any; f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: enabled } });
    const nativeWorker = f.ds.worker as any;
    await f.close();
    if (!enabled) expect(nativeWorker.send.mock.calls[0]?.[0]?.codexCleanupRelease).toBeUndefined();
    expect(f.ds.session.status).toBe('closed');
    if (enabled) {
      expect(setCodexAppThreadArchived).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
      const row = sessionStore.getOwnedSession(f.ds.session.sessionId)!;
      await restoreCodexCleanupArchive(row, sessionStore.updateSession);
      expect(setCodexAppThreadArchived).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }));
    } else expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('/close reports archive failure without losing the successful close or recovery journal', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    f.ds.worker = nativeReleaseWorker() as any; f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    vi.mocked(setCodexAppThreadArchived).mockRejectedValueOnce(new Error('mock RPC failed'));
    await f.close();
    expect(sessionStore.getOwnedSession(f.ds.session.sessionId)).toMatchObject({ status: 'closed', codexCleanupArchive: { state: 'pending' } });
    expect(f.reply.mock.calls.some(args => String(args[1]).includes('Codex 归档失败'))).toBe(true);
  });
  it('card-style close returns before slow archive RPC and serializes reopening', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    f.ds.worker = nativeReleaseWorker() as any; f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(setCodexAppThreadArchived).mockImplementationOnce(async () => { await gate; });
    const notify = vi.fn(async () => undefined);
    const result = await workerPool.closeSession(f.ds.session.sessionId, {
      awaitWorkerExit: false, explicitClose: true, onArchiveError: notify,
    });
    expect(result.ok).toBe(true);
    const row = sessionStore.getOwnedSession(f.ds.session.sessionId)!;
    const reopen = restoreCodexCleanupArchive(row, sessionStore.updateSession, undefined,
      () => sessionStore.getOwnedSession(f.ds.session.sessionId));
    release();
    await reopen;
    expect(setCodexAppThreadArchived).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }));
    expect(row.codexCleanupArchive).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])('card ACK waits neither Worker nor RPC; reopen waits for release and handles archive failure (%s)', async fail => {
    const f = fixture({ streamCardId: 'om_live' });
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    const worker = Object.assign(new EventEmitter(), { killed: false, send: vi.fn((..._args: any[]) => {}), kill: vi.fn() });
    f.ds.worker = worker as any;
    f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    const notify = vi.fn(async () => undefined);
    const nativeCalls: boolean[] = [];
    vi.mocked(setCodexAppThreadArchived).mockImplementation(async opts => {
      nativeCalls.push(opts.archived);
      if (fail && opts.archived) throw new Error('mock archive failure after release');
    });
    let reopen: Promise<void> | undefined;
    try {
      const result = await workerPool.closeSession(f.ds.session.sessionId, {
        awaitWorkerExit: false, explicitClose: true, onArchiveError: notify,
      });
      expect(result.ok).toBe(true);
      const staleRow = sessionStore.getOwnedSession(f.ds.session.sessionId)!;
      reopen = restoreCodexCleanupArchive(staleRow, sessionStore.updateSession, undefined,
        () => sessionStore.getOwnedSession(f.ds.session.sessionId));
      await new Promise(resolve => setImmediate(resolve));
      expect(nativeCalls).toEqual([]);
      const request = worker.send.mock.calls[0]?.[0] as any;
      worker.emit('message', { type: 'codex_cleanup_released', ...request.codexCleanupRelease, released: true });
      worker.emit('exit', 0, null);
      await reopen;
      expect(nativeCalls).toEqual([true, false]);
      expect(sessionStore.getOwnedSession(f.ds.session.sessionId)?.codexCleanupArchive).toBeUndefined();
      if (fail) await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('mock archive failure after release'));
      else expect(notify).not.toHaveBeenCalled();
    } finally { worker.emit('exit', 0, null); await reopen; }
  });
  it('does not archive after an abnormal Worker exit and reports unverified teardown', async () => {
    const f = fixture();
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    const worker = Object.assign(new EventEmitter(), { killed: false, send: vi.fn((..._args: any[]) => {}), kill: vi.fn() });
    f.ds.worker = worker as any; f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    const notify = vi.fn(async () => undefined);
    try {
      expect((await workerPool.closeSession(f.ds.session.sessionId, {
        awaitWorkerExit: false, explicitClose: true, onArchiveError: notify,
      })).ok).toBe(true);
      worker.emit('exit', null, 'SIGKILL');
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('codex_native_release_unverified'));
      expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
      expect(sessionStore.getOwnedSession(f.ds.session.sessionId)?.codexCleanupArchive).toBeUndefined();
    } finally { worker.emit('exit', 0, null); }
  });
  it('background close leaves native Codex untouched even with the switch on', async () => {
    const f = fixture();
    Object.assign(f.ds.session, { cliId: 'codex', backendType: 'pty', cliSessionId: 'mock-native',
      codexCleanupTarget: { threadId: 'mock-native', codexHome: '/tmp/mock-home', codexBin: '/tmp/mock-bin' } });
    sessionStore.updateSession(f.ds.session);
    f.ds.worker = nativeReleaseWorker() as any; f.ds.initConfig = { backendType: 'pty' } as any;
    vi.spyOn(globalConfig, 'readGlobalConfig').mockReturnValue({ sessionCleanup: { archiveCodex: true } });
    await workerPool.closeSession(f.ds.session.sessionId);
    expect(setCodexAppThreadArchived).not.toHaveBeenCalled();
  });
  it('patches a thread live card once without posting a second closed card', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    await f.close();
    expect(f.patch).toHaveBeenCalledExactlyOnceWith('app-close-command', 'om_live', expect.stringContaining('会话已关闭'), { beforeWrite: expect.any(Function) });
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.ephemeral).not.toHaveBeenCalled();
    expect(sessionStore.getSession(f.ds.session.sessionId)?.status).toBe('closed');
  });

  it.each([
    { name: 'missing live card' },
    { name: 'in-flight card POST', streamCardId: workerPool.CARD_POSTING_SENTINEL },
    { name: 'disabled streaming cards', streamCardId: 'om_old', disableStreamingCard: true },
    { name: 'no-card chat', streamCardId: 'om_old', noCardChats: ['oc_close'] },
    { name: 'API-only transport', streamCardId: 'om_synthetic', apiOnly: true },
  ])('keeps the reply fallback for $name', async options => {
    const f = fixture(options);
    await f.close();
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledExactlyOnceWith('om_root', expect.stringContaining('会话已关闭'), 'interactive', 'app-close-command', 'om_command');
    expect(f.ephemeral).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps private close cards owner-only (delivery fails: %s)', async fails => {
    const f = fixture({ streamCardId: 'om_live', privateCard: true });
    if (fails) f.ephemeral.mockRejectedValue(new Error('ephemeral unavailable'));
    await f.close();
    expect(f.ephemeral).toHaveBeenCalledExactlyOnceWith('app-close-command', 'oc_close', 'ou_owner', expect.stringContaining('会话已关闭'));
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('keeps the chat-scope operator confirmation alongside the live-card patch', async () => {
    const f = fixture({ streamCardId: 'om_live', scope: 'chat' });
    await f.close();
    expect(f.patch).toHaveBeenCalledTimes(1);
    expect(f.ephemeral).toHaveBeenCalledExactlyOnceWith('app-close-command', 'oc_close', 'ou_operator', expect.stringContaining('会话已关闭'));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it('does not post a duplicate while the closing patch waits behind an in-flight update', async () => {
    const f = fixture({ streamCardId: 'om_live' });
    let release!: () => void;
    f.patch.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }) as any);
    try {
      workerPool.scheduleCardPatch(f.ds, 'working');
      await f.close();
      expect(f.patch).toHaveBeenCalledTimes(1);
      expect(f.reply).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(f.patch).toHaveBeenCalledTimes(2));
      expect(f.patch).toHaveBeenLastCalledWith('app-close-command', 'om_live', expect.stringContaining('会话已关闭'), { beforeWrite: expect.any(Function) });
      expect(workerPool.scheduleCardPatch(f.ds, 'late working')).toBe(false);
    } finally {
      release?.();
    }
  });
});
