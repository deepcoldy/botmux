import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
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

      const pending = workerPool.closeSession(session.sessionId);

      // closeSession has reached the first await (unsubscribeDocFile), but the
      // logical close barrier must already be fully visible.
      expect(active.has(activeSessionKey(ds))).toBe(false);
      expect(sessionStore.getSession(session.sessionId)?.status).toBe('closed');

      releaseCleanup();
      await expect(pending).resolves.toEqual({ ok: true, alreadyClosed: false });
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
});
