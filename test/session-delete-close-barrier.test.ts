import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import * as docComment from '../src/im/lark/doc-comment.js';
import * as workerPool from '../src/core/worker-pool.js';
import { activeSessionKey } from '../src/core/types.js';
import * as docSubsStore from '../src/services/doc-subs-store.js';
import * as sessionStore from '../src/services/session-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  workerPool.setActiveSessionsRegistry(new Map());
  sessionStore.init();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('daemon close barrier used by botmux delete', () => {
  it('evicts activeSessions and persists closed before awaited doc cleanup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-barrier-'));
    tempDirs.push(dataDir);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-delete-barrier');

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    vi.spyOn(docSubsStore, 'listDocSubscriptionsForSession').mockReturnValue([{
      fileToken: 'doc-delete-barrier',
      fileType: 'docx',
      managedBy: 'subscribe-lark-doc',
    }] as any);
    vi.spyOn(docSubsStore, 'removeDocSubscription').mockImplementation(() => true);
    vi.spyOn(docComment, 'unsubscribeDocFile').mockImplementation(() => cleanupGate);

    try {
      const session = sessionStore.createSession(
        'oc_delete_barrier',
        'om_delete_barrier',
        'delete barrier',
        'group',
      );
      session.larkAppId = 'app-delete-barrier';
      sessionStore.updateSession(session);
      const markerDir = join(dataDir, 'turn-sends');
      const markerPath = join(markerDir, `${session.sessionId}.jsonl`);
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'private closed reply',
      })}\n`);
      const ds = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        workerViewToken: null,
        larkAppId: 'app-delete-barrier',
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
        adoptedFrom: { source: 'tmux', tmuxTarget: 'user:1.0', cwd: '/repo' },
      } as any;
      const active = new Map([[activeSessionKey(ds), ds]]);
      workerPool.setActiveSessionsRegistry(active);
      const dashboardEvents: DashboardEvent[] = [];
      const stopDashboardEvents = dashboardEventBus.subscribe(event => dashboardEvents.push(event));

      const pending = workerPool.closeSession(session.sessionId);

      // closeSession has reached the first await (unsubscribeDocFile), but the
      // logical close barrier must already be fully visible.
      expect(active.has(activeSessionKey(ds))).toBe(false);
      expect(sessionStore.getSession(session.sessionId)?.status).toBe('closed');
      expect(existsSync(markerPath)).toBe(false);

      releaseCleanup();
      await expect(pending).resolves.toEqual({ ok: true, alreadyClosed: false, known: true });
      stopDashboardEvents();
      const closePatch = dashboardEvents.find(event =>
        event.type === 'session.update'
        && event.body.sessionId === session.sessionId
        && event.body.patch.status === 'closed'
      );
      expect(closePatch).toEqual({
        type: 'session.update',
        body: {
          sessionId: session.sessionId,
          patch: expect.objectContaining({
            status: 'closed',
            previewUserText: null,
            previewBotText: null,
            previewUserFullText: null,
            previewBotFullText: null,
            previewUserAt: null,
            previewBotAt: null,
            previewBotState: null,
          }),
        },
      });
      expect(docSubsStore.removeDocSubscription).toHaveBeenCalledWith(
        dataDir,
        'app-delete-barrier',
        'doc-delete-barrier',
      );
    } finally {
      releaseCleanup();
      config.session.dataDir = previousDataDir;
    }
  });

  it('keeps bridge send markers until the live worker acknowledges close', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-fence-'));
    tempDirs.push(dataDir);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-fence');

    try {
      const session = sessionStore.createSession(
        'oc_close_fence',
        'om_close_fence',
        'close fence',
        'group',
      );
      session.larkAppId = 'app-close-fence';
      sessionStore.updateSession(session);
      const markerDir = join(dataDir, 'turn-sends');
      const markerPath = join(markerDir, `${session.sessionId}.jsonl`);
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'already sent answer',
      })}\n`);

      const worker = Object.assign(new EventEmitter(), {
        killed: false,
        send: vi.fn(),
      });
      const ds = {
        session,
        worker,
        workerPort: 12345,
        workerToken: 'write-token',
        workerViewToken: 'view-token',
        larkAppId: 'app-close-fence',
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
        initConfig: { backendType: 'tmux' },
      } as any;
      const active = new Map([[activeSessionKey(ds), ds]]);
      workerPool.setActiveSessionsRegistry(active);

      const pending = workerPool.closeSession(session.sessionId);

      expect(worker.send).toHaveBeenCalledWith({ type: 'close' });
      expect(active.has(activeSessionKey(ds))).toBe(false);
      expect(sessionStore.getSession(session.sessionId)?.status).toBe('closed');
      expect(existsSync(markerPath)).toBe(true);

      worker.emit('exit');
      await expect(pending).resolves.toEqual({ ok: true, alreadyClosed: false, known: true });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      config.session.dataDir = previousDataDir;
    }
  });

  it('defers default session-store marker cleanup after killWorker already nulled the live worker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-kill-then-close-'));
    tempDirs.push(dataDir);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-kill-then-close');

    try {
      const session = sessionStore.createSession(
        'oc_kill_then_close',
        'om_kill_then_close',
        'kill then close',
        'group',
      );
      session.larkAppId = 'app-kill-then-close';
      sessionStore.updateSession(session);
      const markerDir = join(dataDir, 'turn-sends');
      const markerPath = join(markerDir, `${session.sessionId}.jsonl`);
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'sent before slash close',
      })}\n`);

      const worker = Object.assign(new EventEmitter(), {
        killed: false,
        send: vi.fn(),
      });
      const ds = {
        session,
        worker,
        workerPort: 12345,
        workerToken: 'write-token',
        workerViewToken: 'view-token',
        larkAppId: 'app-kill-then-close',
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
        initConfig: { backendType: 'tmux' },
      } as any;

      workerPool.killWorker(ds);
      expect(ds.worker).toBeNull();

      sessionStore.closeSession(session.sessionId);
      expect(existsSync(markerPath)).toBe(true);

      worker.emit('exit');
      await Promise.resolve();
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      config.session.dataDir = previousDataDir;
    }
  });

  it('does not clean markers on the close-fence warning timer while the worker is still alive', async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-fence-timeout-'));
    tempDirs.push(dataDir);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-fence-timeout');

    try {
      const session = sessionStore.createSession(
        'oc_close_fence_timeout',
        'om_close_fence_timeout',
        'close fence timeout',
        'group',
      );
      session.larkAppId = 'app-close-fence-timeout';
      sessionStore.updateSession(session);
      const markerDir = join(dataDir, 'turn-sends');
      const markerPath = join(markerDir, `${session.sessionId}.jsonl`);
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'sent before slow close',
      })}\n`);

      const worker = Object.assign(new EventEmitter(), {
        killed: false,
        send: vi.fn(),
      });
      const ds = {
        session,
        worker,
        workerPort: 12345,
        workerToken: 'write-token',
        workerViewToken: 'view-token',
        larkAppId: 'app-close-fence-timeout',
        chatId: session.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
        initConfig: { backendType: 'pty' },
      } as any;

      workerPool.killWorker(ds);
      sessionStore.closeSession(session.sessionId);
      expect(existsSync(markerPath)).toBe(true);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(existsSync(markerPath)).toBe(true);

      worker.emit('exit');
      await Promise.resolve();
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      vi.useRealTimers();
      config.session.dataDir = previousDataDir;
    }
  });

  it('creates an independent fence when a repo switch reuses the DaemonSession for a new session generation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-fence-generation-'));
    tempDirs.push(dataDir);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-fence-generation');

    try {
      const oldSession = sessionStore.createSession(
        'oc_generation',
        'om_generation_old',
        'old generation',
        'group',
      );
      oldSession.larkAppId = 'app-close-fence-generation';
      oldSession.workerGeneration = 1;
      sessionStore.updateSession(oldSession);
      const newSession = sessionStore.createSession(
        'oc_generation',
        'om_generation_new',
        'new generation',
        'group',
      );
      newSession.larkAppId = 'app-close-fence-generation';
      newSession.workerGeneration = 2;
      sessionStore.updateSession(newSession);

      const markerDir = join(dataDir, 'turn-sends');
      const oldMarkerPath = join(markerDir, `${oldSession.sessionId}.jsonl`);
      const newMarkerPath = join(markerDir, `${newSession.sessionId}.jsonl`);
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(oldMarkerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'old generation send',
      })}\n`);
      writeFileSync(newMarkerPath, `${JSON.stringify({
        sentAtMs: Date.now(),
        previewText: 'new generation send',
      })}\n`);

      const oldWorker = Object.assign(new EventEmitter(), {
        killed: false,
        send: vi.fn(),
      });
      const newWorker = Object.assign(new EventEmitter(), {
        killed: false,
        send: vi.fn(),
      });
      const ds = {
        session: oldSession,
        worker: oldWorker,
        workerPort: 12345,
        workerToken: 'write-token',
        workerViewToken: 'view-token',
        larkAppId: 'app-close-fence-generation',
        chatId: oldSession.chatId,
        chatType: 'group',
        scope: 'thread',
        spawnedAt: Date.now(),
        cliVersion: 'test',
        lastMessageAt: Date.now(),
        hasHistory: true,
        workerGeneration: 1,
        initConfig: { backendType: 'pty' },
      } as any;

      workerPool.killWorker(ds);
      expect(ds.worker).toBeNull();
      sessionStore.closeSession(oldSession.sessionId);
      expect(existsSync(oldMarkerPath)).toBe(true);

      // Repo/card switch reuses the same DaemonSession object for a new
      // Session + worker generation while the old worker close fence is still
      // unresolved. The new close must NOT reuse the old fence: it needs a
      // fence registered under newSession.sessionId, otherwise default
      // sessionStore.closeSession() would unlink the new marker immediately.
      ds.session = newSession;
      ds.worker = newWorker;
      ds.workerPort = 23456;
      ds.workerGeneration = 2;

      workerPool.killWorker(ds);
      sessionStore.closeSession(newSession.sessionId);
      expect(existsSync(oldMarkerPath)).toBe(true);
      expect(existsSync(newMarkerPath)).toBe(true);

      oldWorker.emit('exit');
      await Promise.resolve();
      expect(existsSync(oldMarkerPath)).toBe(false);
      expect(existsSync(newMarkerPath)).toBe(true);

      newWorker.emit('exit');
      await Promise.resolve();
      expect(existsSync(newMarkerPath)).toBe(false);
    } finally {
      config.session.dataDir = previousDataDir;
    }
  });
});
