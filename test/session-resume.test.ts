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

// Shared holder so the mocked worker-pool can reach the SAME activeSessions
// Map a test passes into resumeSession. In production, worker-pool's
// closeSession evicts from the daemon-registered activeSessionsRegistry,
// which IS the same Map object resumeSession receives — so the mock here
// faithfully reproduces "closeSession deletes the entry from the live Map"
// rather than relying on the downstream set() overwrite to hide the scratch.
const wp = vi.hoisted(() => ({ registry: null as Map<string, any> | null }));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  restoreUsageLimitRuntimeState: vi.fn(),
  // Faithful: mirror the real setActiveSessionSafe — if a DIFFERENT entry
  // already holds the key, evict it (close) before setting, instead of a
  // bare overwrite that would mask a lingering occupant.
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, key: string, ds: any) => {
    const prev = map.get(key);
    if (prev && prev !== ds) {
      for (const [k, v] of map) { if (v === prev) { map.delete(k); break; } }
    }
    map.set(key, ds);
  }),
  // Real predicate (same logic as production): worker OR persisted CLI markers.
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
  // Faithful closeSession: actually evict the entry from the live Map (by
  // sessionId, as the real one does via activeSessionsRegistry) AND mark the
  // persisted row closed — so tests verify the eviction MECHANISM, not just
  // the end state.
  closeSession: vi.fn(async (sid: string) => {
    const reg = wp.registry;
    if (reg) {
      for (const [k, v] of reg) {
        if (v?.session?.sessionId === sid) { reg.delete(k); break; }
      }
    }
    const store = await import('../src/services/session-store.js');
    const s = store.getSession(sid);
    if (s && s.status !== 'closed') store.closeSession(sid);
    return { ok: true, alreadyClosed: false };
  }),
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
  validateAdoptTargetState: vi.fn(() => 'alive'),
  adoptTargetLabel: vi.fn(() => 'test-pane'),
}));

vi.mock('../src/core/session-activity.js', () => ({
  announceSessionRow: vi.fn(),
  markSessionActivity: vi.fn(),
}));

import { restoreActiveSessions, resumeSession } from '../src/core/session-manager.js';
import { restoreUsageLimitRuntimeState, closeSession, forkAdoptWorker } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-resume-test-'));
  sessionStore.init();
  wp.registry = null;
  vi.mocked(closeSession).mockClear();
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
    it('returns not_found for an unknown session id', async () => {
      const r = await resumeSession('no-such-id', new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('not_found');
    });

    it('returns not_closed when the session is still active', async () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'active topic');
      const r = await resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('not_closed');
    });

    it('returns adopt_unsupported for adopt-titled sessions', async () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'Adopt: my-pane');
      sessionStore.closeSession(s.sessionId);
      const r = await resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adopt_unsupported');
    });

    it('returns adopt_unsupported when adoptedFrom metadata is set', async () => {
      const s = sessionStore.createSession('oc_chat', 'om_root', 'normal title');
      s.adoptedFrom = { tmuxTarget: 'foo', originalCliPid: 1, cwd: '/tmp' };
      sessionStore.updateSession(s);
      sessionStore.closeSession(s.sessionId);
      const r = await resumeSession(s.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adopt_unsupported');
    });

    it('returns anchor_occupied when a REAL in-memory session owns the anchor', async () => {
      const closed = makeClosedSession({ rootMessageId: 'om_thread_X' });
      const map = new Map<string, DaemonSession>();
      // Occupant must look real (persisted cliId) — otherwise the scratch
      // carve-out below would treat it as a throwaway and evict it.
      const occupant: any = {
        session: { sessionId: 'occupant-id', cliId: 'claude-code' },
        worker: {} /* live */, chatId: 'oc_chat1', scope: 'thread', larkAppId: 'app_test',
      };
      map.set(sessionKey('om_thread_X', 'app_test'), occupant);

      const r = await resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('anchor_occupied');
        expect(r.activeSessionId).toBe('occupant-id');
      }
    });

    it('returns anchor_occupied when a REAL persisted sibling owns the same anchor', async () => {
      // A second active session pinned to the same (larkAppId, scope, anchor)
      // — simulates "user kept typing after /close, a fresh session was created
      // and persisted, but our in-memory Map didn't catch up" (cross-process or
      // partial-restore scenarios). cliId marks it as a real CLI-backed session.
      const closed = makeClosedSession({ rootMessageId: 'om_thread_Y' });
      const sibling = sessionStore.createSession('oc_chat1', 'om_thread_Y', 'New session');
      sibling.larkAppId = 'app_test';
      sibling.scope = 'thread';
      sibling.cliId = 'claude-code';
      sessionStore.updateSession(sibling);

      const r = await resumeSession(closed.sessionId, new Map());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('anchor_occupied');
        expect(r.activeSessionId).toBe(sibling.sessionId);
      }
    });

    it('does NOT flag conflict when persisted sibling is at a different scope', async () => {
      // chat-scope sibling at anchor=chatId shouldn't block thread-scope
      // resume at anchor=rootMessageId, even when chatId would coincidentally
      // match rootMessageId in some odd dataset.
      const closed = makeClosedSession({ rootMessageId: 'om_threadZ', scope: 'thread' });
      const chatSibling = sessionStore.createSession('oc_chat1', 'msg_other', 'chat-scope peer');
      chatSibling.larkAppId = 'app_test';
      chatSibling.scope = 'chat';
      chatSibling.cliId = 'claude-code';
      sessionStore.updateSession(chatSibling);

      const r = await resumeSession(closed.sessionId, new Map());
      expect(r.ok).toBe(true);
    });

    // ── Scratch carve-out (王皓's resume-after-/relay bug) ────────────────────

    it('does NOT block on an in-memory daemon-command scratch — evicts it and resumes', async () => {
      // Repro: chat has bot's session → /close → /relay (picker, daemon parks
      // a worker:null scratch at the chat anchor) → never confirm → click
      // resume. Before the fix the scratch was reported as anchor_occupied.
      const closed = makeClosedSession({ chatId: 'oc_scratch_chat', scope: 'chat' });
      const map = new Map<string, DaemonSession>();
      const key = sessionKey('oc_scratch_chat', 'app_test');
      // Scratch: no worker, no persisted CLI markers, not pendingRepo.
      const scratch: any = {
        session: { sessionId: 'scratch-2716f0f8', cliId: undefined, lastCliInput: undefined },
        worker: null, pendingRepo: false, chatId: 'oc_scratch_chat', scope: 'chat', larkAppId: 'app_test',
      };
      map.set(key, scratch);
      // Wire the shared registry so the faithful closeSession mock evicts from
      // THIS map — lets us assert the eviction mechanism, not just end state.
      wp.registry = map;

      const r = await resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      // Eviction mechanism: closeSession was actually invoked on the scratch
      // (not silently overwritten by the downstream set).
      expect(closeSession).toHaveBeenCalledWith('scratch-2716f0f8');
      // The scratch is gone from the live Map…
      expect([...map.values()].some(v => v.session.sessionId === 'scratch-2716f0f8')).toBe(false);
      // …and the resumed session now owns the anchor.
      if (r.ok) expect(map.get(key)!.session.sessionId).toBe(closed.sessionId);
    });

    it('STILL blocks on a pendingRepo occupant (deliberate setup, not a throwaway)', async () => {
      // A pendingRepo session is worker:null too, but represents real intent
      // (user picking a repo). Resuming the old session must not clobber it.
      const closed = makeClosedSession({ chatId: 'oc_pending_chat', scope: 'chat' });
      const map = new Map<string, DaemonSession>();
      const pending: any = {
        session: { sessionId: 'pending-id', cliId: undefined, lastCliInput: undefined },
        worker: null, pendingRepo: true, chatId: 'oc_pending_chat', scope: 'chat', larkAppId: 'app_test',
      };
      map.set(sessionKey('oc_pending_chat', 'app_test'), pending);

      const r = await resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('anchor_occupied');
        expect(r.activeSessionId).toBe('pending-id');
      }
    });

    it('does NOT block on a persisted scratch sibling (no cliId / lastCliInput) — closes it and resumes', async () => {
      const closed = makeClosedSession({ rootMessageId: 'om_scratch_thread' });
      // Store-only scratch sibling: active, same anchor, but never ran a CLI.
      const scratch = sessionStore.createSession('oc_chat1', 'om_scratch_thread', '/relay');
      scratch.larkAppId = 'app_test';
      scratch.scope = 'thread';
      scratch.cliId = undefined as any;
      scratch.lastCliInput = undefined as any;
      sessionStore.updateSession(scratch);

      const r = await resumeSession(closed.sessionId, new Map());
      expect(r.ok).toBe(true);
      // Scratch store row should now be closed.
      expect(sessionStore.getSession(scratch.sessionId)!.status).toBe('closed');
    });
  });

  describe('success path', () => {
    it('restores usage-limit runtime state for active sessions after daemon restart', async () => {
      const s = sessionStore.createSession('oc_chat_limit', 'om_limit', 'Limited topic');
      s.larkAppId = 'app_test';
      s.scope = 'thread';
      s.usageLimit = {
        limited: true,
        kind: 'usage',
        retryAtMs: Date.now() + 60_000,
        retryLabel: '10:36 PM',
        retryReady: false,
      };
      sessionStore.updateSession(s);
      const map = new Map<string, DaemonSession>();

      // restoreActiveSessions is async (became so when setActiveSessionSafe
      // landed) — without await the post-restore Map lookup below races
      // ahead of the for-of body that populates the map.
      await restoreActiveSessions(map);

      const ds = map.get(sessionKey('om_limit', 'app_test'));
      expect(ds).toBeDefined();
      expect(restoreUsageLimitRuntimeState).toHaveBeenCalledWith(ds);
    });

    it('restores ownerOpenId for a regular active session after daemon restart', async () => {
      const s = sessionStore.createSession('oc_owner', 'om_owner', 'Owned topic');
      s.larkAppId = 'app_test';
      s.scope = 'thread';
      s.cliId = 'claude-code';
      s.workingDir = '/tmp/owned';
      s.ownerOpenId = 'ou_persisted_owner';
      sessionStore.updateSession(s);

      const map = new Map<string, DaemonSession>();
      await restoreActiveSessions(map);

      expect(map.get(sessionKey('om_owner', 'app_test'))?.ownerOpenId).toBe('ou_persisted_owner');
    });

    it('restores ownerOpenId before re-forking an adopt session', async () => {
      const s = sessionStore.createSession('oc_adopt_owner', 'om_adopt_owner', 'Adopt: test-pane');
      s.larkAppId = 'app_test';
      s.scope = 'thread';
      s.cliId = 'claude-code';
      s.ownerOpenId = 'ou_adopt_owner';
      s.adoptedFrom = {
        source: 'tmux',
        tmuxTarget: 'test:0.0',
        originalCliPid: 12345,
        cliId: 'claude-code',
        cwd: '/tmp/adopted',
      };
      sessionStore.updateSession(s);
      vi.mocked(forkAdoptWorker).mockClear();

      const map = new Map<string, DaemonSession>();
      await restoreActiveSessions(map);

      const restored = map.get(sessionKey('om_adopt_owner', 'app_test'));
      expect(restored?.ownerOpenId).toBe('ou_adopt_owner');
      expect(forkAdoptWorker).toHaveBeenCalledWith(
        expect.objectContaining({ ownerOpenId: 'ou_adopt_owner' }),
        { restoredFromMetadata: true },
      );
    });

    it('restores the persisted clean sidecar for a long-running Codex App session', async () => {
      const closed = makeClosedSession({
        chatId: 'oc_codex_restore',
        rootMessageId: 'om_codex_restore',
        cliId: 'codex-app',
      });
      closed.lastUserPrompt = '第 27 轮继续分析';
      closed.lastCliInput = '<user_message>第 27 轮继续分析</user_message>';
      closed.lastCodexAppInput = {
        text: '第 27 轮继续分析',
        clientUserMessageId: 'om_round_27',
        additionalContext: {
          botmux_sender: { kind: 'untrusted', value: '<sender name="晓雪" />' },
          botmux_role: { kind: 'application', value: '<role>reviewer</role>' },
        },
      };
      sessionStore.updateSession(closed);
      sessionStore.closeSession(closed.sessionId);

      const map = new Map<string, DaemonSession>();
      const result = await resumeSession(closed.sessionId, map);

      expect(result.ok).toBe(true);
      const restored = map.get(sessionKey('om_codex_restore', 'app_test'))!;
      expect(restored.lastUserPrompt).toBe('第 27 轮继续分析');
      expect(restored.lastCliInput).toContain('<user_message>');
      expect(restored.lastCodexAppInput).toEqual(closed.lastCodexAppInput);
      expect(restored.session.lastCodexAppInput).toEqual(closed.lastCodexAppInput);
    });

    it('flips status back to active, clears closedAt, and registers in the Map (thread-scope)', async () => {
      const closed = makeClosedSession({ rootMessageId: 'om_threadA' });
      (closed as any).lastUserPrompt = '继续修复限额后的任务';
      (closed as any).lastCliInput = '<user_message>继续修复限额后的任务</user_message>';
      sessionStore.updateSession(closed);
      sessionStore.closeSession(closed.sessionId);
      const map = new Map<string, DaemonSession>();

      const r = await resumeSession(closed.sessionId, map);
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

    it('uses chatId as the routing anchor for chat-scope sessions', async () => {
      const closed = makeClosedSession({ chatId: 'oc_chatB', scope: 'chat' });
      const map = new Map<string, DaemonSession>();

      const r = await resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      const ds = map.get(sessionKey('oc_chatB', 'app_test'));
      expect(ds).toBeDefined();
      expect(ds!.scope).toBe('chat');
    });

    it('preserves cliId / workingDir / ownerOpenId from the persisted record', async () => {
      const closed = makeClosedSession({ cliId: 'codex', workingDir: '/srv/app' });
      closed.ownerOpenId = 'ou_owner';
      sessionStore.updateSession(closed);
      // Re-close — updateSession above flipped status back to active
      sessionStore.closeSession(closed.sessionId);

      const map = new Map<string, DaemonSession>();
      const r = await resumeSession(closed.sessionId, map);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ds.session.cliId).toBe('codex');
      expect(r.ds.workingDir).toBe('/srv/app');
      expect(r.ds.ownerOpenId).toBe('ou_owner');
    });
  });
});
