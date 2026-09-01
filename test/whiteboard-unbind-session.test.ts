import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedPersistedSessionRows, readPersistedSessionRows } from './helpers/session-store-disk.js';

const ipc = vi.hoisted(() => ({
  daemon: null as { larkAppId: string; ipcPort: number } | null,
  status: 200,
  throws: false,
  fetches: [] as Array<{ port: number; path: string; body: unknown }>,
}));

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: () => ({ whiteboard: { enabled: true } }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/utils/daemon-discovery.js', () => ({
  findOnlineDaemon: (larkAppId: string) => (
    ipc.daemon?.larkAppId === larkAppId ? ipc.daemon : null
  ),
}));

vi.mock('../src/core/daemon-ipc-auth.js', () => ({
  loadDaemonIpcSecret: () => 'test-secret',
  fetchDaemonIpc: async (port: number, path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    ipc.fetches.push({ port, path, body });
    if (ipc.throws) throw new Error('connect ECONNREFUSED');
    return { ok: ipc.status >= 200 && ipc.status < 300, status: ipc.status, json: async () => ({}) };
  },
}));

import { createWhiteboard, deleteWhiteboard } from '../src/services/whiteboard-store.js';

function seedBoundSession(appId: string | undefined, boardId: string): void {
  seedPersistedSessionRows(tempDir, appId, {
    s1: {
      sessionId: 's1',
      chatId: 'c1',
      rootMessageId: 'r',
      title: 's',
      status: 'active',
      createdAt: new Date().toISOString(),
      ...(appId ? { larkAppId: appId } : {}),
      whiteboardId: boardId,
    },
  });
}

describe('deleteWhiteboard session unbind', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-wb-unbind-'));
    mkdirSync(join(tempDir, 'whiteboards'), { recursive: true });
    ipc.daemon = null;
    ipc.status = 200;
    ipc.throws = false;
    ipc.fetches = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the row offline when no owning daemon is visible', async () => {
    const board = createWhiteboard({ id: 'delete_offline', title: 't', larkAppId: 'app1', chatId: 'c1' });
    seedBoundSession('app1', board.id);

    const result = await deleteWhiteboard(board.id);
    expect(result).toEqual({ ok: true, id: board.id, clearedSessions: 1, unresolvedSessions: 0 });
    expect(ipc.fetches).toEqual([]);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBeUndefined();
  });

  it('clears via owning-daemon IPC and does not write the row behind a live cache', async () => {
    const board = createWhiteboard({ id: 'delete_ipc', title: 't', larkAppId: 'app1', chatId: 'c1' });
    seedBoundSession('app1', board.id);
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };

    const result = await deleteWhiteboard(board.id);
    expect(result).toMatchObject({ clearedSessions: 1, unresolvedSessions: 0 });
    expect(ipc.fetches).toEqual([{
      port: 18765,
      path: '/api/sessions/s1/whiteboard',
      // Compare-and-set: the daemon may have rebound the session to a fresh
      // board the moment this one left the index.
      body: { whiteboardId: null, expectWhiteboardId: board.id },
    }]);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBe(board.id);
  });

  it('leaves a session the daemon rebound alone (IPC 409) and never falls back to a write', async () => {
    const board = createWhiteboard({ id: 'delete_rebound', title: 't', larkAppId: 'app1', chatId: 'c1' });
    seedBoundSession('app1', board.id);
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };
    ipc.status = 409;

    const result = await deleteWhiteboard(board.id);
    // Neither cleared (the daemon owns a different binding now) nor unresolved
    // (nothing failed) — and the offline path must not try to overrule it.
    expect(result).toMatchObject({ clearedSessions: 0, unresolvedSessions: 0 });
    expect(ipc.fetches).toHaveLength(1);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBe(board.id);
  });

  it('reports the session as unresolved when a daemon is visible but IPC fails', async () => {
    const board = createWhiteboard({ id: 'delete_abort', title: 't', larkAppId: 'app1', chatId: 'c1' });
    seedBoundSession('app1', board.id);
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };
    ipc.throws = true;

    const result = await deleteWhiteboard(board.id);
    // The liveness re-probe inside the store aborts the offline write, so the
    // row is untouched — and the count says so instead of a bare 0.
    expect(result).toMatchObject({ clearedSessions: 0, unresolvedSessions: 1 });
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBe(board.id);
  });

  it('writes a legacy row that carries no larkAppId without probing any daemon', async () => {
    const board = createWhiteboard({ id: 'delete_legacy', title: 't', larkAppId: 'app1', chatId: 'c1' });
    // Pre-per-bot row in the flat store: no daemon runs a store without an
    // appId, so there is no owner to defer to.
    seedBoundSession(undefined, board.id);
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };

    const result = await deleteWhiteboard(board.id);
    expect(result).toMatchObject({ clearedSessions: 1, unresolvedSessions: 0 });
    expect(ipc.fetches).toEqual([]);
    expect(readPersistedSessionRows(tempDir).s1.whiteboardId).toBeUndefined();
  });
});
