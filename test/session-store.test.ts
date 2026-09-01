/**
 * Unit tests for services/session-store.
 *
 * Uses a real temp directory for each test to exercise the actual
 * file-based persistence without mocking fs.
 *
 * Run:  pnpm vitest run test/session-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Mocks ────────────────────────────────────────────────────────────────

const fsControl = vi.hoisted(() => ({ failSessionWrite: false, failReaddir: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failSessionWrite && String(args[0]).includes('sessions.json.')) {
        throw new Error('simulated session repair write failure');
      }
      return actual.writeFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      // Simulates the CLI file sandbox: per-bot files readable, data dir
      // enumeration denied (EPERM-like failure).
      if (fsControl.failReaddir) throw new Error('simulated readdir denial');
      return actual.readdirSync(...args);
    },
  };
});

// Mock config so we can point session.dataDir at a temp directory
let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

// Mock logger to suppress output
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock frozen-card-store (deleteFrozenCards is called on close)
const mockDeleteFrozenCards = vi.fn();
vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: (...args: any[]) => mockDeleteFrozenCards(...args),
}));

// Import the module under test after mocks are set up
import {
  __testOnly_setBeforeRowPersist,
  init,
  createSession,
  getSession,
  getOwnedSession,
  listSessions,
  listSessionsStrict,
  SessionStoreUnavailableError,
  beginMojoCloseJournal,
  markMojoClosePrepared,
  finishMojoCloseAbort,
  closeSession,
  reactivateClosedSession,
  updateSession,
  updateSessionPid,
  persistActiveRemoteLineageExact,
  persistActiveRemoteLineagesExactBatch,
  findActiveSessionsByRoot,
  repairMissingChatScope,
  loadAllSessionsSnapshot,
  mutateSessionRowOffline,
  readSessionRowFromDisk,
  readSessionRowCopiesAcrossStores,
} from '../src/services/session-store.js';
import { seedPersistedSessionRows, readPersistedSessionRows, sessionStorePath } from './helpers/session-store-disk.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

// db-else-json 读盘夹具：引擎替换后，daemon store 的持久化状态落在 sessions*.db
// （既有 JSON 冻结不再更新）；混合窗口场景仍可能只有 .json。读断言统一走这里。
import { DatabaseSync } from 'node:sqlite';

function persistedStorePath(dir: string, appId?: string): string | undefined {
  const dbPath = appId ? join(dir, 'session-stores', appId, 'sessions.db') : join(dir, 'sessions.db');
  if (existsSync(dbPath)) return dbPath;
  const jsonPath = join(dir, appId ? `sessions-${appId}.json` : 'sessions.json');
  return existsSync(jsonPath) ? jsonPath : undefined;
}

function persistedStoreExists(dir: string, appId?: string): boolean {
  return persistedStorePath(dir, appId) !== undefined;
}

function readPersistedRows(dir: string, appId?: string): Record<string, any> {
  const path = persistedStorePath(dir, appId);
  if (!path) throw new Error(`no persisted session store in ${dir} (appId=${appId ?? 'legacy'})`);
  if (path.endsWith('.db')) {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT session_id, row FROM sessions').all() as { session_id: string; row: string }[];
      return Object.fromEntries(rows.map(r => [r.session_id, JSON.parse(r.row)]));
    } finally {
      db.close();
    }
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = makeTempDir();
  fsControl.failSessionWrite = false;
  __testOnly_setBeforeRowPersist(undefined);
  mockDeleteFrozenCards.mockReset();
  // Reset module state for each test
  init();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── init() ───────────────────────────────────────────────────────────────

describe('init()', () => {
  it('keeps cross-file discovery read-only and exposes owner-scoped lookup separately', () => {
    init('app-A');
    const ownedByA = createSession('chat1', 'root1', 'Bot A');

    init('app-B');
    expect(getSession(ownedByA.sessionId)?.sessionId).toBe(ownedByA.sessionId);
    expect(getOwnedSession(ownedByA.sessionId)).toBeUndefined();
  });

  it('should create the data directory on first operation if it does not exist', () => {
    const subDir = join(tempDir, 'nested', 'data');
    tempDir = subDir;
    init();
    // The directory is created lazily on first load (e.g. createSession)
    createSession('chat1', 'root1', 'Test');
    expect(existsSync(subDir)).toBe(true);
  });

  it('should load existing sessions from disk', () => {
    // Write a session file manually
    mkdirSync(tempDir, { recursive: true });
    const session = {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r1',
        title: 'Pre-existing',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify(session));

    // Re-init to pick up the file
    init();
    const loaded = getSession('s1');
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Pre-existing');
    expect(loaded!.status).toBe('active');
  });

  it('repairs only the scope-less oc_=root chat corruption signature', () => {
    mkdirSync(tempDir, { recursive: true });
    const records = {
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      legacyThread: {
        sessionId: 'legacyThread',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        title: 'Legacy thread',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify(records));

    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('legacyThread')?.scope).toBeUndefined();
    const persisted = readPersistedRows(tempDir);
    expect(persisted.broken.scope).toBe('chat');
    expect(persisted.legacyThread.scope).toBeUndefined();
  });

  it('ignores malformed entries while repairing healthy sessions', () => {
    mkdirSync(tempDir, { recursive: true });
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify({
      missingChatId: { sessionId: 'missing-chat-id' },
      primitive: 'not-a-session',
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      healthy: {
        sessionId: 'healthy',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        scope: 'thread',
        title: 'Healthy thread',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    }));

    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('healthy')?.title).toBe('Healthy thread');
    expect(listSessions()).toHaveLength(4);
  });

  it('repairs the corruption signature through the shared deserialization helper', () => {
    const record: Record<string, unknown> = {
      sessionId: 'broken',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
    };

    expect(repairMissingChatScope(record)).toBe(true);
    expect(record.scope).toBe('chat');
    expect(repairMissingChatScope(record)).toBe(false);
    expect(repairMissingChatScope(null)).toBe(false);
    expect(repairMissingChatScope({ sessionId: 'malformed' })).toBe(false);
  });

  it('keeps loaded sessions available when persisting a scope repair fails', () => {
    mkdirSync(tempDir, { recursive: true });
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, JSON.stringify({
      broken: {
        sessionId: 'broken',
        chatId: 'oc_chat',
        rootMessageId: 'oc_chat',
        title: 'Broken repo switch',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      healthy: {
        sessionId: 'healthy',
        chatId: 'oc_chat',
        rootMessageId: 'om_thread',
        scope: 'thread',
        title: 'Healthy thread',
        status: 'active',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    }));

    fsControl.failSessionWrite = true;
    init();

    expect(getSession('broken')?.scope).toBe('chat');
    expect(getSession('healthy')?.title).toBe('Healthy thread');
    expect(listSessions()).toHaveLength(2);
    expect(JSON.parse(readFileSync(fp, 'utf-8')).broken.scope).toBeUndefined();
  });

  it('should reset state when called again', () => {
    createSession('chat1', 'root1', 'Session A');
    expect(listSessions()).toHaveLength(1);

    // Re-init without appId clears in-memory state; because we have no file
    // for a different appId context, it starts fresh
    init('different-app');
    expect(listSessions()).toHaveLength(0);
  });
});

// ─── createSession() ─────────────────────────────────────────────────────

describe('createSession()', () => {
  it('should create a session with correct fields', () => {
    const session = createSession('chat1', 'root1', 'My Title', 'group');
    expect(session.sessionId).toBeDefined();
    expect(session.chatId).toBe('chat1');
    expect(session.rootMessageId).toBe('root1');
    expect(session.title).toBe('My Title');
    expect(session.chatType).toBe('group');
    expect(session.status).toBe('active');
    expect(session.createdAt).toBeDefined();
    expect(session.closedAt).toBeUndefined();
  });

  it('should assign unique session IDs', () => {
    const s1 = createSession('chat1', 'root1', 'A');
    const s2 = createSession('chat2', 'root2', 'B');
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('should persist session to disk', () => {
    const session = createSession('chat1', 'root1', 'Persisted');
    expect(persistedStoreExists(tempDir)).toBe(true);
    const data = readPersistedRows(tempDir);
    expect(data[session.sessionId]).toBeDefined();
    expect(data[session.sessionId].title).toBe('Persisted');
  });

  it('should default chatType to undefined when not provided', () => {
    const session = createSession('chat1', 'root1', 'No ChatType');
    expect(session.chatType).toBeUndefined();
  });
});

// ─── getSession() ─────────────────────────────────────────────────────────

describe('getSession()', () => {
  it('should retrieve an existing session by sessionId', () => {
    const created = createSession('chat1', 'root1', 'Findable');
    const found = getSession(created.sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Findable');
  });

  it('should return undefined for a non-existent sessionId', () => {
    const found = getSession('nonexistent-id');
    expect(found).toBeUndefined();
  });

  it('should find a session stored in a different appId file (cross-file lookup)', () => {
    // Create a session under appId "app-A"
    init('app-A');
    const session = createSession('chat1', 'root1', 'Cross-file');

    // Switch to appId "app-B"
    init('app-B');

    // Should still find the session from app-A's file
    const found = getSession(session.sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Cross-file');
  });
});

// ─── listSessions() ──────────────────────────────────────────────────────

describe('listSessions()', () => {
  it('should return all sessions', () => {
    createSession('c1', 'r1', 'A');
    createSession('c2', 'r2', 'B');
    createSession('c3', 'r3', 'C');
    const all = listSessions();
    expect(all).toHaveLength(3);
  });

  it('should return an empty array when no sessions exist', () => {
    expect(listSessions()).toEqual([]);
  });

  it('should include both active and closed sessions', () => {
    const s1 = createSession('c1', 'r1', 'Active');
    createSession('c2', 'r2', 'Will Close');
    const all = listSessions();
    closeSession(all.find(s => s.title === 'Will Close')!.sessionId);

    const afterClose = listSessions();
    expect(afterClose).toHaveLength(2);
    const statuses = afterClose.map(s => s.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('closed');
  });
});

describe('listSessionsStrict()', () => {
  it('returns a healthy empty projection when no store exists', () => {
    expect(listSessionsStrict()).toEqual([]);
  });

  it('rejects a malformed store instead of treating it as safely empty', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '{not-json');
    init();

    // Preserve the compatibility reader for non-transactional callers.
    expect(listSessions()).toEqual([]);
    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
    expect(() => listSessionsStrict()).toThrow(/session store is unavailable/i);
  });

  it('stays unhealthy until an explicit init reloads the repaired projection', () => {
    const fp = join(tempDir, 'sessions.json');
    writeFileSync(fp, '{not-json');
    init();

    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
    writeFileSync(fp, '{}');
    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);

    init();
    expect(listSessionsStrict()).toEqual([]);
  });

  it('rejects a malformed legacy projection during per-bot migration', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '{broken-legacy');
    init('app-A');

    expect(() => listSessionsStrict()).toThrow(SessionStoreUnavailableError);
  });

  it('rejects a JSON value that is not a session-record projection', () => {
    writeFileSync(join(tempDir, 'sessions.json'), '[]');
    init();

    expect(() => listSessionsStrict()).toThrow(/invalid sessions projection/i);
  });
});

// ─── closeSession() ──────────────────────────────────────────────────────

describe('write health gate', () => {
  const corruptCurrentStore = (): { session: ReturnType<typeof createSession>; fp: string } => {
    const session = createSession('chat-write-gate', 'root-write-gate', 'Write Gate');
    session.backendType = 'mojo';
    updateSession(session);
    // Close the live SQLite connection before overwriting the active store;
    // corrupting the frozen JSON would not trip the engine now in use.
    init();
    const fp = persistedStorePath(tempDir);
    if (!fp) throw new Error('expected a persisted store after createSession');
    writeFileSync(fp, '{not-json');
    init();
    return { session, fp };
  };

  it.each([
    ['createSession', (_session: ReturnType<typeof createSession>) => {
      createSession('chat-new', 'root-new', 'Must Not Create');
    }],
    ['updateSession', (session: ReturnType<typeof createSession>) => {
      updateSession({ ...session, title: 'Must Not Update' });
    }],
    ['updateSessionPid', (session: ReturnType<typeof createSession>) => {
      updateSessionPid(session.sessionId, 12345);
    }],
    ['closeSession', (session: ReturnType<typeof createSession>) => {
      closeSession(session.sessionId);
    }],
    ['reactivateClosedSession', (session: ReturnType<typeof createSession>) => {
      reactivateClosedSession(session.sessionId);
    }],
    ['Mojo close journal', (session: ReturnType<typeof createSession>) => {
      beginMojoCloseJournal(session.sessionId, 'request-write-gate');
    }],
    ['single Riff lineage CAS', (session: ReturnType<typeof createSession>) => {
      persistActiveRemoteLineageExact(session.sessionId, 'task-next');
    }],
    ['batch Riff lineage CAS', (session: ReturnType<typeof createSession>) => {
      persistActiveRemoteLineagesExactBatch([{
        sessionId: session.sessionId,
        taskId: null,
        owner: { pid: null, larkAppId: null, backendType: 'mojo' },
        targetTaskId: 'task-next',
        expectedCurrentTaskIds: [null],
      }]);
    }],
  ])('rejects %s after a malformed current store load without changing disk or cache', (_name, mutate) => {
    const { session, fp } = corruptCurrentStore();

    expect(() => mutate(session)).toThrow(SessionStoreUnavailableError);
    expect(readFileSync(fp, 'utf-8')).toBe('{not-json');
    expect(listSessions()).toEqual([]);
  });

  it('keeps the write fence sticky after external repair until init reloads the store', () => {
    const { fp } = corruptCurrentStore();
    expect(() => createSession('chat-blocked', 'root-blocked', 'Blocked')).toThrow(
      SessionStoreUnavailableError,
    );

    rmSync(fp, { force: true });
    new DatabaseSync(fp).close();
    expect(() => createSession('chat-still-blocked', 'root-still-blocked', 'Still Blocked')).toThrow(
      SessionStoreUnavailableError,
    );
    expect(existsSync(fp)).toBe(true);

    init();
    expect(createSession('chat-reloaded', 'root-reloaded', 'Reloaded').status).toBe('active');
  });

  it('does not create a per-bot projection after malformed legacy migration input', () => {
    const legacyFp = join(tempDir, 'sessions.json');
    const botFp = join(tempDir, 'sessions-app-A.json');
    writeFileSync(legacyFp, '{broken-legacy');
    init('app-A');

    expect(() => createSession('chat-app-a', 'root-app-a', 'App A')).toThrow(
      SessionStoreUnavailableError,
    );
    expect(readFileSync(legacyFp, 'utf-8')).toBe('{broken-legacy');
    expect(existsSync(botFp)).toBe(false);
  });

  it('rejects writes after a valid JSON value that is not a session projection', () => {
    const session = createSession('chat-array', 'root-array', 'Array Projection');
    init();
    const fp = persistedStorePath(tempDir);
    if (!fp) throw new Error('expected a persisted store after createSession');
    writeFileSync(fp, '[]');
    init();

    expect(() => updateSession({ ...session, title: 'Must Not Overwrite Array' })).toThrow(
      SessionStoreUnavailableError,
    );
    expect(readFileSync(fp, 'utf-8')).toBe('[]');
  });
});

describe('closeSession()', () => {
  it('should set status to closed and add closedAt timestamp', () => {
    const session = createSession('chat1', 'root1', 'To Close');
    closeSession(session.sessionId);

    const closed = getSession(session.sessionId);
    expect(closed!.status).toBe('closed');
    expect(closed!.closedAt).toBeDefined();
  });

  it('should persist the closed state to disk', () => {
    const session = createSession('chat1', 'root1', 'Persist Close');
    closeSession(session.sessionId);

    // Re-init and reload from disk
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded!.status).toBe('closed');
    expect(reloaded!.closedAt).toBeDefined();
  });

  it('clears Riff lineage atomically with the durable closed row', () => {
    const session = createSession('chat1', 'root1', 'Close Riff');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task-prepared';
    updateSession(session);

    closeSession(session.sessionId, { clearRiffParentTaskId: true });
    init();

    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('restores Riff close state in memory when the atomic save fails', () => {
    const session = createSession('chat1', 'root1', 'Close Riff Save Failure');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task-retry';
    updateSession(session);
    // SQLite 行写不经过 node:fs，失败注入改走 store 的 test-only 钩子。
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'riff-task-retry',
    });
    expect(mockDeleteFrozenCards).not.toHaveBeenCalled();

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'riff-task-retry',
    });
  });

  // `previewTarget` is the literal loopback (host, port) an agent registered
  // with `botmux preview <port>`; the dashboard proxy dials it by host/port
  // alone. A closed session owns no port any more, and the OS may hand that
  // number to an unrelated local server — so it must not survive in the row.
  it('clears the registered preview target from the closed row data', () => {
    const session = createSession('chat1', 'root1', 'Close Preview');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);

    closeSession(session.sessionId);

    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.previewTarget).toBeUndefined();

    // Atomic with status='closed': neither the parsed row nor the raw file
    // (read by offline/cross-store row readers) may still carry the target.
    init();
    expect(getSession(session.sessionId)?.previewTarget).toBeUndefined();
    const persisted = readPersistedRows(tempDir)[session.sessionId];
    expect(persisted.previewTarget).toBeUndefined();
    const raw = JSON.stringify(persisted);
    expect(raw).not.toContain('previewTarget');
    expect(raw).not.toContain('4173');
  });

  it('keeps the preview target in memory when the atomic close save fails', () => {
    const session = createSession('chat1', 'root1', 'Close Preview Save Failure');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(session.sessionId))
      .toThrow(/simulated session repair write failure/);

    // The close did not happen, so the still-active session keeps proxying its
    // own live port — rollback must restore the field with the rest of the row.
    expect(getSession(session.sessionId)).toMatchObject({ status: 'active' });
    expect(getSession(session.sessionId)?.previewTarget).toEqual({
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it('parks an uncancellable mojo lineage in the same transaction as the close', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Park');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-1';
    updateSession(session);

    closeSession(session.sessionId, {
      parkMojoLineage: 'mojo-sid-1',
      clearRiffParentTaskId: true,
    });

    expect(getSession(session.sessionId)).toMatchObject({
      status: 'closed',
      mojoQuarantinedLineage: 'mojo-sid-1',
      mojoQuarantineNoticePending: true,
    });
    // The active slot is cleared in the same write; the parked slot is the handle.
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
  });

  it('keeps BOTH ids when a different lineage was already parked', () => {
    // Each id is the only handle left for manual cleanup of its own remote
    // session, so the second must not overwrite the first.
    const session = createSession('chat1', 'root1', 'Close Mojo Park Merge');
    session.backendType = 'mojo';
    session.mojoQuarantinedLineage = 'mojo-old';
    session.riffParentTaskId = 'mojo-new';
    updateSession(session);

    closeSession(session.sessionId, {
      parkMojoLineage: 'mojo-new',
      clearRiffParentTaskId: true,
    });

    expect(getSession(session.sessionId)?.mojoQuarantinedLineage).toBe('mojo-old,mojo-new');
  });

  it('restores the mojo park fields when the atomic save fails', () => {
    // The rollback is the whole point of doing the park inside this transaction:
    // a FAILED close must not leave the row parked, or the next turn treats a
    // still-live remote session as quarantined and silently starts a new one.
    const session = createSession('chat1', 'root1', 'Close Mojo Save Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-retry';
    updateSession(session);
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { parkMojoLineage: 'mojo-sid-retry', clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);

    const inMemory = getSession(session.sessionId);
    expect(inMemory).toMatchObject({ status: 'active', riffParentTaskId: 'mojo-sid-retry' });
    expect(inMemory?.mojoQuarantinedLineage).toBeUndefined();
    expect(inMemory?.mojoQuarantineNoticePending).toBeUndefined();

    // ...and the same must be true of what is actually on disk.
    __testOnly_setBeforeRowPersist(undefined);
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded).toMatchObject({ status: 'active', riffParentTaskId: 'mojo-sid-retry' });
    expect(reloaded?.mojoQuarantinedLineage).toBeUndefined();
    expect(reloaded?.mojoQuarantineNoticePending).toBeUndefined();
  });

  it('journals Mojo prepare/proof and clears it atomically with close', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Journal');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);

    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });
    markMojoClosePrepared(session.sessionId, 'request-1', 'mojo-sid-journal');
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'prepared',
      taskId: 'mojo-sid-journal',
    });

    closeSession(session.sessionId, { clearRiffParentTaskId: true });
    init();
    expect(getSession(session.sessionId)).toMatchObject({ status: 'closed' });
    expect(getSession(session.sessionId)?.riffParentTaskId).toBeUndefined();
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('never accepts a Mojo close journal as authority for another backend', () => {
    const session = createSession('chat1', 'root1', 'Non Mojo Journal');
    session.backendType = 'riff';
    session.riffParentTaskId = 'riff-task';
    updateSession(session);

    expect(() => beginMojoCloseJournal(
      session.sessionId,
      'request-1',
      'riff-task',
    )).toThrow(/non-Mojo session/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      backendType: 'riff',
      riffParentTaskId: 'riff-task',
    });
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
  });

  it('keeps a prepared Mojo journal in memory and on disk when close commit fails', () => {
    const session = createSession('chat1', 'root1', 'Close Mojo Journal Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    markMojoClosePrepared(session.sessionId, 'request-1', 'mojo-sid-journal');
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => closeSession(
      session.sessionId,
      { clearRiffParentTaskId: true },
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-journal',
      mojoCloseJournal: { phase: 'prepared', requestId: 'request-1' },
    });

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)).toMatchObject({
      status: 'active',
      riffParentTaskId: 'mojo-sid-journal',
      mojoCloseJournal: { phase: 'prepared', requestId: 'request-1' },
    });
  });

  it('rolls back a failed journal transition without publishing false proof', () => {
    const session = createSession('chat1', 'root1', 'Mojo Journal Transition Failure');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-sid-journal';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-sid-journal');
    __testOnly_setBeforeRowPersist(() => { throw new Error('simulated session repair write failure'); });

    expect(() => markMojoClosePrepared(
      session.sessionId,
      'request-1',
      'mojo-sid-journal',
    )).toThrow(/simulated session repair write failure/);
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });

    __testOnly_setBeforeRowPersist(undefined);
    init();
    expect(getSession(session.sessionId)?.mojoCloseJournal).toMatchObject({
      phase: 'preparing',
      requestId: 'request-1',
    });
  });

  it('never rewrites a prepared proof to a different remote lineage', () => {
    const session = createSession('chat1', 'root1', 'Mojo Journal Lineage CAS');
    session.backendType = 'mojo';
    session.riffParentTaskId = 'mojo-original';
    updateSession(session);
    beginMojoCloseJournal(session.sessionId, 'request-1', 'mojo-original');

    expect(() => markMojoClosePrepared(
      session.sessionId,
      'request-1',
      'mojo-different',
    )).toThrow(/journal lineage/);
    expect(getSession(session.sessionId)).toMatchObject({
      riffParentTaskId: 'mojo-original',
      mojoCloseJournal: {
        phase: 'preparing',
        requestId: 'request-1',
        taskId: 'mojo-original',
      },
    });
  });

  it('clears a failed prepare only after admission restore, otherwise persists uncertainty', () => {
    const session = createSession('chat1', 'root1', 'Abort Mojo Journal');
    session.backendType = 'mojo';
    updateSession(session);

    beginMojoCloseJournal(session.sessionId, 'request-1');
    finishMojoCloseAbort(session.sessionId, 'request-1', {
      admissionRestored: false,
      taskId: 'mojo-late-id',
    });
    expect(getSession(session.sessionId)).toMatchObject({
      riffParentTaskId: 'mojo-late-id',
      mojoCloseJournal: { phase: 'uncertain', taskId: 'mojo-late-id' },
    });

    finishMojoCloseAbort(session.sessionId, 'request-1', {
      admissionRestored: true,
      taskId: 'mojo-late-id',
    });
    expect(getSession(session.sessionId)?.mojoCloseJournal).toBeUndefined();
    expect(getSession(session.sessionId)?.riffParentTaskId).toBe('mojo-late-id');
  });

  it('should call deleteFrozenCards with the sessionId', () => {
    const session = createSession('chat1', 'root1', 'Frozen');
    closeSession(session.sessionId);
    expect(mockDeleteFrozenCards).toHaveBeenCalledWith(session.sessionId);
  });

  it('should be a no-op for a non-existent sessionId', () => {
    // Should not throw
    closeSession('nonexistent-id');
    expect(mockDeleteFrozenCards).not.toHaveBeenCalled();
  });

  it('should handle double close without error', () => {
    const session = createSession('chat1', 'root1', 'Double Close');
    closeSession(session.sessionId);
    const firstClosedAt = getSession(session.sessionId)!.closedAt;

    // Close again
    closeSession(session.sessionId);
    const secondClosedAt = getSession(session.sessionId)!.closedAt;

    // closedAt gets updated on second close
    expect(secondClosedAt).toBeDefined();
    expect(getSession(session.sessionId)!.status).toBe('closed');
  });
});

describe('reactivateClosedSession()', () => {
  it('sanitizes queued/setup state left on a legacy closed row', () => {
    const session = createSession('chat1', 'root1', 'Legacy Closed Queue');
    closeSession(session.sessionId);
    const legacy = getSession(session.sessionId)!;
    legacy.queued = true;
    legacy.queuedPrompt = 'legacy backlog';
    legacy.pendingRepoSetup = { mode: 'picker', prompt: 'legacy picker' };
    legacy.queuedActivationPending = true;
    legacy.queuedActivationToken = 'legacy-token';
    legacy.queuedActivationInput = { content: 'legacy head' };
    legacy.queuedActivationTail = [{
      id: 'legacy-tail', order: 1, userPrompt: 'tail', cliInput: { content: 'legacy tail' }, turnId: 'tail-turn',
    }];
    legacy.queuedActivationTailNextOrder = 2;
    updateSession(legacy);

    const result = reactivateClosedSession(session.sessionId);
    expect(result.ok).toBe(true);
    init();

    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.status).toBe('active');
    expect(reloaded.closedAt).toBeUndefined();
    expect(reloaded.queued).toBeUndefined();
    expect(reloaded.pendingRepoSetup).toBeUndefined();
    expect(reloaded.queuedActivationPending).toBeUndefined();
    expect(reloaded.queuedActivationToken).toBeUndefined();
    expect(reloaded.queuedActivationInput).toBeUndefined();
    expect(reloaded.queuedActivationTail).toBeUndefined();
  });

  it('does not revive a preview target left on a legacy closed row', () => {
    const session = createSession('chat1', 'root1', 'Legacy Closed Preview');
    closeSession(session.sessionId);
    // Rows closed by a build older than the close-path cleanup still carry the
    // target on disk. Resume starts a new worker generation that has registered
    // no port, so reactivation must not hand the proxy the old host/port.
    const legacy = getSession(session.sessionId)!;
    legacy.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(legacy);

    const result = reactivateClosedSession(session.sessionId);
    expect(result.ok).toBe(true);

    init();
    const reloaded = getSession(session.sessionId)!;
    expect(reloaded.status).toBe('active');
    expect(reloaded.previewTarget).toBeUndefined();
  });
});

// ─── updateSession() ─────────────────────────────────────────────────────

describe('updateSession()', () => {
  it('should update a session in place', () => {
    const session = createSession('chat1', 'root1', 'Original');
    session.title = 'Updated Title';
    session.workingDir = '/tmp/work';
    updateSession(session);

    const found = getSession(session.sessionId);
    expect(found!.title).toBe('Updated Title');
    expect(found!.workingDir).toBe('/tmp/work');
  });

  it('should persist updates to disk', () => {
    const session = createSession('chat1', 'root1', 'Will Update');
    session.webPort = 9999;
    updateSession(session);

    // Re-init to reload from disk
    init();
    const reloaded = getSession(session.sessionId);
    expect(reloaded!.webPort).toBe(9999);
  });

  it('persists the explicitly registered preview target across a store restart', () => {
    const session = createSession('chat1', 'root1', 'Preview target');
    session.previewTarget = {
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    };
    updateSession(session);

    init();
    expect(getSession(session.sessionId)?.previewTarget).toEqual({
      host: '127.0.0.1',
      port: 4173,
      registeredAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it('skips the disk write when an update produces byte-identical content', () => {
    // 行级写落在 WAL（append-only），每次 REAL write 都让 sessions.db-wal 变长；
    // 被跳过的冗余写不开事务，WAL 长度保持不变。
    const walFp = join(tempDir, 'sessions.db-wal');
    const session = createSession('chat1', 'root1', 'NoChange');
    const walAfterCreate = statSync(walFp).size;

    // A redundant update with no field change → must be skipped (WAL stable).
    updateSession(session);
    expect(statSync(walFp).size).toBe(walAfterCreate);
    updateSession(session); // and again — still no write
    expect(statSync(walFp).size).toBe(walAfterCreate);

    // A real change → the row is rewritten (WAL grows).
    session.title = 'Changed';
    updateSession(session);
    expect(statSync(walFp).size).toBeGreaterThan(walAfterCreate);

    // Content is still correct after the skip/write sequence.
    init();
    expect(getSession(session.sessionId)!.title).toBe('Changed');
  });

  it('should allow adding a new session via updateSession', () => {
    const newSession = {
      sessionId: 'manual-id',
      chatId: 'chat-x',
      rootMessageId: 'root-x',
      title: 'Manually Added',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    };
    updateSession(newSession);

    const found = getSession('manual-id');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Manually Added');
  });
});

// ─── updateSessionPid() ──────────────────────────────────────────────────

describe('updateSessionPid()', () => {
  it('should set the pid on a session', () => {
    const session = createSession('chat1', 'root1', 'PID Test');
    updateSessionPid(session.sessionId, 12345);

    const found = getSession(session.sessionId);
    expect(found!.pid).toBe(12345);
  });

  it('should clear the pid when passed null', () => {
    const session = createSession('chat1', 'root1', 'PID Clear');
    updateSessionPid(session.sessionId, 42);
    updateSessionPid(session.sessionId, null);

    const found = getSession(session.sessionId);
    expect(found!.pid).toBeUndefined();
  });

  it('should be a no-op for a non-existent sessionId', () => {
    // Should not throw
    updateSessionPid('nonexistent-id', 123);
  });
});

// ─── Multi-bot isolation (appId scoping) ─────────────────────────────────

describe('Multi-bot isolation', () => {
  it('should store sessions in separate files per appId', () => {
    init('app-alpha');
    createSession('c1', 'r1', 'Alpha Session');

    init('app-beta');
    createSession('c2', 'r2', 'Beta Session');

    expect(persistedStoreExists(tempDir, 'app-alpha')).toBe(true);
    expect(persistedStoreExists(tempDir, 'app-beta')).toBe(true);
  });

  it('should only list sessions belonging to the current appId', () => {
    init('app-alpha');
    createSession('c1', 'r1', 'Alpha 1');
    createSession('c1', 'r1', 'Alpha 2');

    init('app-beta');
    createSession('c2', 'r2', 'Beta 1');

    // Only beta sessions should be visible
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0].title).toBe('Beta 1');

    // Switch back to alpha
    init('app-alpha');
    expect(listSessions()).toHaveLength(2);
  });

  it('should use legacy sessions.json when no appId is set', () => {
    init();
    createSession('c1', 'r1', 'Legacy');
    expect(persistedStoreExists(tempDir)).toBe(true);
    expect(readPersistedRows(tempDir)).not.toEqual({});
  });

  it('should migrate matching sessions from legacy file to per-bot file', () => {
    // Write a legacy sessions.json with sessions from two different apps
    mkdirSync(tempDir, { recursive: true });
    const legacyData = {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r1',
        title: 'App A Session',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: 'app-A',
      },
      s2: {
        sessionId: 's2',
        chatId: 'c2',
        rootMessageId: 'r2',
        title: 'App B Session',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        larkAppId: 'app-B',
      },
    };
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify(legacyData));

    // Init with app-A; should migrate only app-A sessions
    init('app-A');
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('App A Session');
    expect(persistedStoreExists(tempDir, 'app-A')).toBe(true);
  });
});

// ─── findActiveSessionsByRoot() — cross-bot lookup ───────────────────────

describe('findActiveSessionsByRoot()', () => {
  it('finds active sessions across per-bot files for the same rootMessageId', () => {
    // Bot A pins workdir for thread root-x
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Bot A');
    sA.workingDir = '/repo/foo';
    sA.larkAppId = 'app-A';
    updateSession(sA);

    // Bot B pins different workdir for the same thread
    init('app-B');
    const sB = createSession('chat1', 'root-x', 'Bot B');
    sB.workingDir = '/repo/bar';
    sB.larkAppId = 'app-B';
    updateSession(sB);

    // From Bot C's perspective, both peers should be visible
    init('app-C');
    const found = findActiveSessionsByRoot('root-x');
    expect(found.map(s => s.sessionId).sort()).toEqual([sA.sessionId, sB.sessionId].sort());
    expect(found.find(s => s.sessionId === sA.sessionId)?.workingDir).toBe('/repo/foo');
    expect(found.find(s => s.sessionId === sB.sessionId)?.workingDir).toBe('/repo/bar');
  });

  it('skips closed sessions', () => {
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Bot A');
    closeSession(sA.sessionId);

    init('app-B');
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toEqual([]);
  });

  it('skips sessions for unrelated threads', () => {
    init('app-A');
    createSession('chat1', 'root-x', 'Match');
    createSession('chat1', 'root-y', 'No Match');

    init('app-B');
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('Match');
  });

  it('also returns sessions from the current bot file', () => {
    init('app-A');
    const sA = createSession('chat1', 'root-x', 'Self');
    // Don't switch — stay on app-A
    const found = findActiveSessionsByRoot('root-x');
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe(sA.sessionId);
  });

  it('returns empty when no session matches the root', () => {
    init('app-A');
    createSession('chat1', 'root-x', 'A');
    init('app-B');
    expect(findActiveSessionsByRoot('root-nonexistent')).toEqual([]);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('should handle corrupted JSON gracefully', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), 'NOT VALID JSON!!!');

    init();
    // Should not throw, should start with empty sessions
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('should survive multiple inits without data loss (same appId)', () => {
    init();
    createSession('c1', 'r1', 'First');
    createSession('c2', 'r2', 'Second');

    init(); // re-init loads from disk
    expect(listSessions()).toHaveLength(2);
  });

  it('should handle atomic writes (tmp file rename)', () => {
    const session = createSession('c1', 'r1', 'Atomic');
    // The .tmp file should not persist after save
    const tmpFp = join(tempDir, 'sessions.json.tmp');
    expect(existsSync(tmpFp)).toBe(false);
  });
});

// ─── legacy field sanitization ───────────────────────────────────────────────

describe('import-time convergence', () => {
  it('strips pendingResponseCard* fields while importing, so no written row carries them', () => {
    // A session persisted before the「处理中」placeholder card was removed still
    // carries the three legacy fields. The import drops them once; nothing can
    // reintroduce them (the fields no longer exist on `Session`), which is why
    // the write paths no longer re-check.
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify({
      s1: {
        sessionId: 's1', chatId: 'c1', rootMessageId: 'r1', title: 'Legacy',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        pendingResponseCardId: 'om_old', pendingResponseCardState: 'open',
        lastPatchedResponseCardId: 'om_prev',
      },
    }));

    init();
    const loaded = getSession('s1')!;
    updateSession({ ...loaded, title: 'Touched' });

    const onDisk = readPersistedRows(tempDir);
    expect(onDisk.s1.title).toBe('Touched');
    expect(onDisk.s1).not.toHaveProperty('pendingResponseCardId');
    expect(onDisk.s1).not.toHaveProperty('pendingResponseCardState');
    expect(onDisk.s1).not.toHaveProperty('lastPatchedResponseCardId');
  });

  it('never lets a duplicate-sessionId ghost overwrite the live row', () => {
    // Two entries can carry the SAME sessionId under different file keys.
    // Importing under `row.sessionId` would collapse them and let whichever
    // comes last win — a stale closed ghost silently replacing the live row,
    // irreversibly (the import runs once, the JSON is frozen afterwards).
    // Rows are imported under their own file key; a mis-keyed row stays inert.
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'sessions.json'), JSON.stringify({
      realId: {
        sessionId: 'realId', chatId: 'c1', rootMessageId: 'r1', title: 'CURRENT',
        status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
      },
      wrongKey: {
        sessionId: 'realId', chatId: 'c1', rootMessageId: 'r1', title: 'STALE-DUP',
        status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
      },
    }));

    init();
    expect(getSession('realId')?.title).toBe('CURRENT');
    expect(getSession('realId')?.status).toBe('active');
    const onDisk = readPersistedRows(tempDir);
    expect(onDisk.realId.title).toBe('CURRENT');
    expect(onDisk.wrongKey.title).toBe('STALE-DUP');
  });
});

// ─── cross-process offline access ────────────────────────────────────────────
// The absorbed CLI-side persistence (formerly cli.ts loadSessions /
// mutateSessionOffline / saveSession) and the daemon/provenance direct reads.

/** Pre-SQLite JSON — an IMPORT SOURCE only; the store never reads it at runtime. */
function seedFile(name: string, rows: Record<string, unknown>): void {
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, name), JSON.stringify(rows, null, 2));
}

/** Seed a real store on disk — what "another bot's daemon already wrote" means. */
function seedStore(appId: string | undefined, rows: Record<string, unknown>): string {
  return seedPersistedSessionRows(tempDir, appId, rows);
}

function row(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, chatId: 'oc_chat', rootMessageId: `om_${sessionId}`, title: sessionId,
    status: 'active', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

describe('loadAllSessionsSnapshot()', () => {
  it('merges the legacy store + per-bot stores, per-bot wins duplicates and gets larkAppId stamped', () => {
    seedStore(undefined, {
      legacy1: row('legacy1'),
      dup: row('dup', { title: 'legacy copy' }),
    });
    seedStore('appA', {
      dup: row('dup', { title: 'per-bot copy' }),
      a1: row('a1'),
    });

    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect(snapshot.size).toBe(3);
    expect(snapshot.get('legacy1')?.larkAppId).toBeUndefined();
    expect(snapshot.get('dup')?.title).toBe('per-bot copy');
    expect(snapshot.get('dup')?.larkAppId).toBe('appA');
    expect(snapshot.get('a1')?.larkAppId).toBe('appA');
  });

  it('skips malformed rows', () => {
    seedStore(undefined, {
      broken: { notASession: true },
      ok: row('ok'),
    });
    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect([...snapshot.keys()]).toEqual(['ok']);
  });

  it('falls back to the exact per-bot store when the data dir cannot be enumerated', () => {
    seedStore('appB', { b1: row('b1') });
    seedStore('appC', { c1: row('c1') });
    fsControl.failReaddir = true;
    try {
      const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir, fallbackAppId: 'appB' });
      // The sandboxed fallback loads only the injected bot's own store.
      expect([...snapshot.keys()]).toEqual(['b1']);
      expect(snapshot.get('b1')?.larkAppId).toBe('appB');
    } finally {
      fsControl.failReaddir = false;
    }
  });

  it('never creates a store it was only asked to read', () => {
    mkdirSync(tempDir, { recursive: true });
    expect(loadAllSessionsSnapshot({ dataDir: tempDir }).size).toBe(0);
    // A read-write SQLite open would have CREATED this file, and its mere
    // existence disables the owning daemon's one-shot JSON import.
    expect(existsSync(sessionStorePath(tempDir))).toBe(false);
  });

  it('still reads a store whose owning daemon has not imported it yet', () => {
    // Upgrade window: npm already replaced dist and repointed the launcher, but
    // the daemon that owns these rows still runs the pre-SQLite build and keeps
    // writing the JSON. Every live session's `botmux send` resolves itself
    // through here — going db-only would leave the agent unable to reply until
    // someone restarts the daemon, which nothing forces them to do.
    seedFile('sessions-appB.json', { b1: row('b1') });
    seedStore('appA', { a1: row('a1') });
    const snapshot = loadAllSessionsSnapshot({ dataDir: tempDir });
    expect([...snapshot.keys()].sort()).toEqual(['a1', 'b1']);
    expect(snapshot.get('b1')?.larkAppId).toBe('appB');
  });
});

describe('readSessionRowFromDisk()', () => {
  it('prefers the owning per-bot store and falls back to legacy', () => {
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    seedStore('appA', { s1: row('s1', { title: 'per-bot' }) });
    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.title).toBe('per-bot');
    expect(readSessionRowFromDisk('s1', 'appMissing', tempDir)?.title).toBe('legacy');
    expect(readSessionRowFromDisk('s1', undefined, tempDir)?.title).toBe('legacy');
    expect(readSessionRowFromDisk('nope', 'appA', tempDir)).toBeUndefined();
  });

  it('skips a corrupt per-bot store and still reads the legacy copy', () => {
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'), 'not a database');
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    expect(readSessionRowFromDisk('s1', 'appA', tempDir)?.title).toBe('legacy');
  });
});

describe('readSessionRowCopiesAcrossStores()', () => {
  it('returns one entry per store that holds the id', () => {
    seedStore(undefined, { s1: row('s1', { title: 'legacy' }) });
    seedStore('appA', { s1: row('s1', { title: 'per-bot' }) });
    seedStore('appB', { other: row('other') });
    const copies = readSessionRowCopiesAcrossStores('s1', tempDir);
    expect(copies.map(c => c.title).sort()).toEqual(['legacy', 'per-bot']);
    expect(readSessionRowCopiesAcrossStores('other', tempDir)).toHaveLength(1);
    expect(readSessionRowCopiesAcrossStores('missing', tempDir)).toHaveLength(0);
  });

  it('skips corrupt stores and key-mismatched rows without failing the scan', () => {
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(tempDir, 'session-stores', 'appA', 'sessions.db'), 'not a database');
    seedStore('appB', { s1: row('someOtherId') }); // key ≠ row.sessionId
    seedStore(undefined, { s1: row('s1') });
    const copies = readSessionRowCopiesAcrossStores('s1', tempDir);
    expect(copies).toHaveLength(1);
  });

  it('a frozen pre-SQLite JSON is not a second copy of an imported store', () => {
    // The identity scan authorises only when a row resolves EXACTLY once. The
    // frozen import source must not read as a second store, or every migrated
    // session would be refused as ambiguous.
    seedFile('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    init('appA');
    listSessions(); // import → .db, JSON frozen in place
    init();
    expect(readSessionRowCopiesAcrossStores('s1', tempDir)).toHaveLength(1);
  });

  it('throws when the data dir itself cannot be listed (fail-closed identity scan)', () => {
    expect(() => readSessionRowCopiesAcrossStores('s1', join(tempDir, 'no-such-dir')))
      .toThrow();
  });
});

describe('mutateSessionRowOffline()', () => {
  it('mutates the FRESH on-disk row, never the caller snapshot (stale-clobber regression)', () => {
    // The row gained a newer field on disk after the caller took its snapshot.
    // The old cli.ts saveSession() would have written the stale snapshot back,
    // erasing workerGeneration; the exclusive row mutation must preserve it.
    seedStore('appA', { s1: row('s1', { workerGeneration: 7, larkAppId: 'appA' }) });

    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => {
        current.status = 'closed';
        current.closedAt = '2026-08-13T00:00:00.000Z';
        return true;
      },
      { dataDir: tempDir },
    );

    expect(published?.status).toBe('closed');
    expect(published?.workerGeneration).toBe(7);
    const onDisk = readPersistedSessionRows(tempDir, 'appA');
    expect(onDisk.s1.status).toBe('closed');
    expect(onDisk.s1.workerGeneration).toBe(7);
  });

  it('returns the fresh row without writing when mutate declines', () => {
    seedStore('appA', { s1: row('s1', { larkAppId: 'appA' }) });
    const current = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      () => false,
      { dataDir: tempDir },
    );
    expect(current?.sessionId).toBe('s1');
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('returns undefined for a missing row', () => {
    seedStore('appA', { s1: row('s1') });
    expect(mutateSessionRowOffline(
      { sessionId: 'ghost', larkAppId: 'appA' },
      () => true,
      { dataDir: tempDir },
    )).toBeUndefined();
  });

  it('aborts untouched when abortIf trips at entry', () => {
    seedStore('appA', { s1: row('s1') });
    const result = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => true },
    );
    expect(result).toBeUndefined();
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('re-checks abortIf immediately before publication and leaves the row untouched', () => {
    // A daemon that appears during the read/decision phase becomes
    // authoritative — the second probe must catch it. SQLite's own locking
    // orders writers but cannot see a daemon holding a stale in-memory cache.
    seedStore('appA', { s1: row('s1') });
    let probes = 0;
    const result = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir, abortIf: () => ++probes > 1 },
    );
    expect(result).toBeUndefined();
    expect(probes).toBe(2);
    expect(readPersistedSessionRows(tempDir, 'appA').s1.status).toBe('active');
  });

  it('targets the legacy store when the row carries no larkAppId', () => {
    seedStore(undefined, { s1: row('s1') });
    const published = mutateSessionRowOffline(
      { sessionId: 's1' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );
    expect(published?.status).toBe('closed');
    expect(readPersistedSessionRows(tempDir).s1.status).toBe('closed');
  });

  it('never creates the store — an empty one would disable the daemon import gate', () => {
    // A read-write SQLite open CREATES the file. If an offline write planted an
    // empty store here, the owning daemon's `existsSync(db)` gate would skip
    // the one-shot JSON import and silently discard every pre-SQLite row.
    mkdirSync(join(tempDir, 'session-stores', 'appA'), { recursive: true });
    expect(mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      () => true,
      { dataDir: tempDir },
    )).toBeUndefined();
    expect(existsSync(sessionStorePath(tempDir, 'appA'))).toBe(false);
  });

  it('writes the JSON store while its owning daemon has not imported it yet', () => {
    // Upgrade window: the pre-SQLite daemon still owns these rows and reads the
    // JSON, so an offline close has to land there. Creating a .db here would
    // fork the two representations behind that daemon's back — and the empty
    // store would also disable its one-shot import gate.
    seedFile('sessions-appA.json', { s1: row('s1', { larkAppId: 'appA' }) });
    const published = mutateSessionRowOffline(
      { sessionId: 's1', larkAppId: 'appA' },
      current => { current.status = 'closed'; return true; },
      { dataDir: tempDir },
    );
    expect(published?.status).toBe('closed');
    expect(JSON.parse(readFileSync(join(tempDir, 'sessions-appA.json'), 'utf-8')).s1.status).toBe('closed');
    expect(existsSync(sessionStorePath(tempDir, 'appA'))).toBe(false);
  });
});
