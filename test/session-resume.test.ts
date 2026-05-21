/**
 * Unit tests for resumeSession (src/core/session-manager.ts).
 *
 * Uses a real temp directory + real session-store (no mocking of fs) so the
 * persistence-conflict path (`anchor_occupied` against on-disk records) is
 * exercised end-to-end. Heavy collaborators (worker-pool fork, bot-registry,
 * message-queue) are mocked at the module boundary because resumeSession only
 * touches a small slice of them.
 *
 * Run:  pnpm vitest run test/session-resume.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
    daemon: { backendType: 'pty', workingDir: '~', workingDirs: ['~'] },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', cliId: 'claude-code', workingDir: '~', workingDirs: ['~'] },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  })),
  getAllBots: vi.fn(() => [{
    config: { larkAppId: 'app_test', cliId: 'claude-code' },
    botName: 'TestBot',
    botOpenId: 'ou_test',
    resolvedAllowedUsers: [],
  }]),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: vi.fn((id: string) => `bmx-${id.slice(0, 8)}`), hasSession: vi.fn(() => false) },
}));

vi.mock('../src/core/session-discovery.js', () => ({
  validateAdoptTarget: vi.fn(() => true),
}));

vi.mock('../src/core/session-activity.js', () => ({
  markSessionActivity: vi.fn(),
}));

import { resumeSession } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-resume-test-'));
  sessionStore.init();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeClosedSession(overrides: Partial<Parameters<typeof sessionStore.createSession>[0]> & {
  scope?: 'thread' | 'chat'; larkAppId?: string; workingDir?: string; cliId?: any;
} = {}): ReturnType<typeof sessionStore.createSession> {
  const s = sessionStore.createSession(
    overrides.chatId ?? 'oc_chat1',
    overrides.rootMessageId ?? 'om_root1',
    overrides.title ?? 'Test Topic',
    'group',
  );
  s.larkAppId = overrides.larkAppId ?? 'app_test';
  s.workingDir = overrides.workingDir ?? '/tmp/proj';
  s.cliId = overrides.cliId ?? 'claude-code';
  s.scope = overrides.scope ?? 'thread';
  sessionStore.updateSession(s);
  sessionStore.closeSession(s.sessionId);
  return s;
}

describe('resumeSession', () => {
  describe('error branches', () => {
    it('returns not_found for an unknown session id', () => {
      const r = resumeSession('no-such-id', new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('not_found');
    });

    it('returns not_closed when the session is still active', () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'active topic');
      const r = resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('not_closed');
    });

    it('returns adopt_unsupported for adopt-titled sessions', () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'Adopt: my-pane');
      sessionStore.closeSession(s.sessionId);
      const r = resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adopt_unsupported');
    });

    it('returns adopt_unsupported when adoptedFrom metadata is set', () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'normal title');
      s.adoptedFrom = { tmuxTarget: 'foo', originalCliPid: 1, cwd: '/tmp' };
      sessionStore.updateSession(s);
      sessionStore.closeSession(s.sessionId);
      const r = resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adopt_unsupported');
    });

    it('returns anchor_occupied when the in-memory Map already owns the anchor', () => {
      const closed = makeClosedSession({ rootMessageId: 'om_thread_X' });
      const map = new Map<string, DaemonSession>();
      const occupant: any = {
        session: { sessionId: 'occupant-id' },
        chatId: 'oc_chat1', scope: 'thread', larkAppId: 'app_test',
      };
      map.set(sessionKey('om_thread_X', 'app_test'), occupant);

      const r = resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('anchor_occupied');
        expect(r.activeSessionId).toBe('occupant-id');
      }
    });

    it('returns anchor_occupied when persisted store has an active sibling at the same anchor', () => {
      // A second active session pinned to the same (larkAppId, scope, anchor)
      // — simulates "user kept typing after /close, a fresh session was created
      // and persisted, but our in-memory Map didn't catch up" (cross-process or
      // partial-restore scenarios).
      const closed = makeClosedSession({ rootMessageId: 'om_thread_Y' });
      const sibling = sessionStore.createSession('oc_chat1', 'om_thread_Y', 'New session');
      sibling.larkAppId = 'app_test';
      sibling.scope = 'thread';
      sessionStore.updateSession(sibling);

      const r = resumeSession(closed.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('anchor_occupied');
        expect(r.activeSessionId).toBe(sibling.sessionId);
      }
    });

    it('does NOT flag conflict when persisted sibling is at a different scope', () => {
      // chat-scope sibling at anchor=chatId shouldn't block thread-scope
      // resume at anchor=rootMessageId, even when chatId would coincidentally
      // match rootMessageId in some odd dataset.
      const closed = makeClosedSession({ rootMessageId: 'om_threadZ', scope: 'thread' });
      const chatSibling = sessionStore.createSession('oc_chat1', 'msg_other', 'chat-scope peer');
      chatSibling.larkAppId = 'app_test';
      chatSibling.scope = 'chat';
      sessionStore.updateSession(chatSibling);

      const r = resumeSession(closed.sessionId, new Map());
      expect(r.ok).toBe(true);
    });
  });

  describe('success path', () => {
    it('flips status back to active, clears closedAt, and registers in the Map (thread-scope)', () => {
      const closed = makeClosedSession({ rootMessageId: 'om_threadA' });
      (closed as any).lastUserPrompt = '继续修复限额后的任务';
      (closed as any).lastCliInput = '<user_message>继续修复限额后的任务</user_message>';
      sessionStore.updateSession(closed);
      sessionStore.closeSession(closed.sessionId);
      const map = new Map<string, DaemonSession>();

      const r = resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const persisted = sessionStore.getSession(closed.sessionId)!;
      expect(persisted.status).toBe('active');
      expect(persisted.closedAt).toBeUndefined();

      expect(map.size).toBe(1);
      const ds = map.get(sessionKey('om_threadA', 'app_test'))!;
      expect(ds).toBeDefined();
      expect(ds.session.sessionId).toBe(closed.sessionId);
      expect(ds.scope).toBe('thread');
      expect(ds.hasHistory).toBe(true);
      expect(ds.workingDir).toBe('/tmp/proj');
      expect(ds.worker).toBeNull();
      expect(ds.larkAppId).toBe('app_test');
      expect(ds.lastUserPrompt).toBe('继续修复限额后的任务');
      expect(ds.lastCliInput).toBe('<user_message>继续修复限额后的任务</user_message>');
    });

    it('uses chatId as the routing anchor for chat-scope sessions', () => {
      const closed = makeClosedSession({ chatId: 'oc_chatB', scope: 'chat' });
      const map = new Map<string, DaemonSession>();

      const r = resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      const ds = map.get(sessionKey('oc_chatB', 'app_test'));
      expect(ds).toBeDefined();
      expect(ds!.scope).toBe('chat');
    });

    it('preserves cliId / workingDir / ownerOpenId from the persisted record', () => {
      const closed = makeClosedSession({ cliId: 'codex', workingDir: '/srv/app' });
      closed.ownerOpenId = 'ou_owner';
      sessionStore.updateSession(closed);
      // Re-close — updateSession above flipped status back to active
      sessionStore.closeSession(closed.sessionId);

      const map = new Map<string, DaemonSession>();
      const r = resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ds.session.cliId).toBe('codex');
      expect(r.ds.workingDir).toBe('/srv/app');
      expect(r.ds.ownerOpenId).toBe('ou_owner');
    });
  });
});
