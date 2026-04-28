/**
 * Unit tests for services/session-store.
 *
 * Uses a real temp directory for each test to exercise the actual
 * file-based persistence without mocking fs.
 *
 * Run:  pnpm vitest run test/session-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Mocks ────────────────────────────────────────────────────────────────

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
  init,
  createSession,
  getSession,
  listSessions,
  closeSession,
  updateSession,
  updateSessionPid,
  findActiveSessionsByRoot,
} from '../src/services/session-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = makeTempDir();
  mockDeleteFrozenCards.mockReset();
  // Reset module state for each test
  init();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── init() ───────────────────────────────────────────────────────────────

describe('init()', () => {
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
    const fp = join(tempDir, 'sessions.json');
    expect(existsSync(fp)).toBe(true);
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
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

// ─── closeSession() ──────────────────────────────────────────────────────

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

    expect(existsSync(join(tempDir, 'sessions-app-alpha.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'sessions-app-beta.json'))).toBe(true);
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
    expect(existsSync(join(tempDir, 'sessions.json'))).toBe(true);
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
    expect(existsSync(join(tempDir, 'sessions-app-A.json'))).toBe(true);
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
