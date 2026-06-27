/**
 * Restore-time zombie-close decision for persistent backends (tmux/zellij/herdr).
 *
 * On daemon restart, restoreActiveSessions() re-registers every persisted active
 * session and then, for persistent backends, probes whether the backing
 * pane/agent survived. PR #98 made a *missing* backing session trigger a
 * permanent closeSession(). The hazard the gate caught: a transient probe
 * failure (herdr server slow-start / list timeout / CLI hiccup) used to fold
 * into the same `false` as "genuinely gone", so one flaky probe could close a
 * still-alive session for good (context lost, pane leaked, store row closed →
 * no lazy recovery).
 *
 * The fix upgrades the probe to tri-state (exists | missing | unknown). These
 * tests pin the decision boundary:
 *   - missing  → closeSession (Map eviction + store closed), no fork
 *   - unknown  → keep the active record (no close, no fork) for lazy recovery
 *   - exists   → auto-fork to re-attach, no close
 *
 * Heavy collaborators are mocked at the module boundary; the session-store runs
 * for real against a temp dir, and the worker-pool mock faithfully reproduces
 * closeSession's eviction-from-the-live-Map + store-close mechanism (mirrors
 * session-resume.test.ts) so we assert the real eviction, not just end state.
 *
 * Run:  pnpm vitest run test/restore-zombie-close.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

// Mutable probe verdict the mocked TmuxBackend returns this test run.
const probe = vi.hoisted(() => ({ result: 'exists' as 'exists' | 'missing' | 'unknown' }));
// Mutable tmux-SERVER liveness the mocked TmuxBackend returns this test run.
// Default 'running' so a bare 'missing' is read as a solo zombie (server up).
const server = vi.hoisted(() => ({ state: 'running' as 'running' | 'down' | 'unknown' }));

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
    // Persistent backend ⇒ the close/fork decision path under test runs.
    // recoveryForkBatchSize/DelayMs feed staggeredRecoveryFork (delay 0 = no waits in test).
    daemon: { backendType: 'tmux', recoveryForkBatchSize: 5, recoveryForkDelayMs: 0, workingDir: '~', workingDirs: ['~'] },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  deleteFrozenCards: vi.fn(),
}));

// Shared holder so the mocked worker-pool's closeSession evicts from the SAME
// Map the test passes into restoreActiveSessions — production's closeSession
// evicts from activeSessionsRegistry, which IS that Map.
const wp = vi.hoisted(() => ({ registry: null as Map<string, any> | null }));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, key: string, ds: any) => {
    const prev = map.get(key);
    if (prev && prev !== ds) {
      for (const [k, v] of map) { if (v === prev) { map.delete(k); break; } }
    }
    map.set(key, ds);
  }),
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
  // Faithful: evict the matching entry from the live Map (as production does via
  // activeSessionsRegistry) AND mark the persisted row closed.
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

// TmuxBackend mock: probeSession returns the per-test verdict; hasSession mirrors
// production's delegation (probeSession === 'exists'). Keeping the old boolean
// behaviour here is what makes the "unknown" case a true RED before the fix:
// pre-fix restore calls hasSession() → false on unknown → wrongly closes.
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: {
    sessionName: vi.fn((id: string) => `bmx-${id.slice(0, 8)}`),
    probeSession: vi.fn(() => probe.result),
    hasSession: vi.fn(() => probe.result === 'exists'),
    serverState: vi.fn(() => server.state),
    killSession: vi.fn(),
  },
}));

vi.mock('../src/core/session-discovery.js', () => ({
  validateAdoptTarget: vi.fn(() => true),
  validateAdoptTargetState: vi.fn(() => 'alive'),
  adoptTargetLabel: vi.fn(() => 'target'),
}));

vi.mock('../src/core/session-activity.js', () => ({
  announceSessionRow: vi.fn(),
  markSessionActivity: vi.fn(),
}));

import { restoreActiveSessions } from '../src/core/session-manager.js';
import { forkWorker, closeSession } from '../src/core/worker-pool.js';
import { announceSessionRow } from '../src/core/session-activity.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'restore-zombie-test-'));
  sessionStore.init();
  wp.registry = null;
  probe.result = 'exists';
  server.state = 'running';
  vi.mocked(closeSession).mockClear();
  vi.mocked(forkWorker).mockClear();
  vi.mocked(announceSessionRow).mockClear();
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeActivePersistentSession(rootMessageId: string) {
  const s = sessionStore.createSession('oc_chat1', rootMessageId, 'Topic', 'group');
  s.larkAppId = 'app_test';
  s.workingDir = '/tmp/proj';
  s.cliId = 'claude-code';
  s.scope = 'thread';
  // Real tmux sessions now carry their backend stamped at spawn time
  // (Session.backendType); getSessionPersistentBackendType reads it back rather
  // than re-deriving from the daemon default. Stamp it so this fixture models a
  // genuine tmux-backed session.
  s.backendType = 'tmux';
  sessionStore.updateSession(s);
  return s; // left active
}

describe('restoreActiveSessions — persistent-backend zombie-close decision', () => {
  it('"missing" → closes the zombie (Map eviction + store closed), does not fork', async () => {
    probe.result = 'missing';
    const s = makeActivePersistentSession('om_missing');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).toHaveBeenCalledTimes(1);
    expect(announceSessionRow).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ sessionId: s.sessionId }),
    }));
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect([...map.values()].some(v => v.session.sessionId === s.sessionId)).toBe(false);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"missing" + server DOWN (host reboot) → keeps the active record, does NOT close', async () => {
    // The reboot bug: tmux server is gone, so every bmx-* pane probes 'missing'.
    // Closing them all wiped a full dashboard. With the server-state gate, a
    // down server means "keep for lazy resume" (CLI transcript on disk is still
    // resumable), exactly like a pty session.
    probe.result = 'missing';
    server.state = 'down';
    const s = makeActivePersistentSession('om_reboot');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
    const ds = map.get(sessionKey('om_reboot', 'app_test'));
    expect(ds).toBeDefined();              // active record retained…
    expect(ds!.worker).toBeNull();         // …worker-less, resumes on next message
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active'); // NOT closed
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"missing" + server DOWN → keeps ALL sessions (no mass-close after reboot)', async () => {
    probe.result = 'missing';
    server.state = 'down';
    const a = makeActivePersistentSession('om_reboot_a');
    const b = makeActivePersistentSession('om_reboot_b');
    const c = makeActivePersistentSession('om_reboot_c');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).toHaveBeenCalledTimes(3);
    expect(closeSession).not.toHaveBeenCalled();
    for (const s of [a, b, c]) {
      expect(map.get(sessionKey(s.rootMessageId, 'app_test'))).toBeDefined();
      expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
    }
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"missing" + server UP but session was cap-suspended → keeps active for cold-resume (NOT a zombie)', async () => {
    // The idle-worker sweeper deliberately kills a session's backing pane + CLI
    // over the per-bot cap. The server stays up (only one pane was killed), so
    // without the suspend-intent marker this looks exactly like a solo zombie
    // and would be wrongly closed — losing a session that should lazily
    // cold-resume on the next message.
    probe.result = 'missing';
    server.state = 'running';
    const s = makeActivePersistentSession('om_cap_suspended');
    s.suspendedColdResume = true;
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    const ds = map.get(sessionKey('om_cap_suspended', 'app_test'));
    expect(ds).toBeDefined();              // active record retained…
    expect(ds!.worker).toBeNull();         // …worker-less, cold-resumes on next message
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active'); // NOT closed
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"missing" + server state UNKNOWN → closes (conservative, server may be up)', async () => {
    probe.result = 'missing';
    server.state = 'unknown';
    const s = makeActivePersistentSession('om_missing_unknown_server');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"unknown" → keeps the active record (no close, no fork) for lazy recovery', async () => {
    probe.result = 'unknown';
    const s = makeActivePersistentSession('om_unknown');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    const ds = map.get(sessionKey('om_unknown', 'app_test'));
    expect(ds).toBeDefined();              // active record retained…
    expect(ds!.worker).toBeNull();         // …worker-less, resumes on next message
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active'); // NOT closed
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('"exists" → auto-forks to re-attach, does not close', async () => {
    probe.result = 'exists';
    const s = makeActivePersistentSession('om_exists');
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalled();
    expect(vi.mocked(forkWorker).mock.calls[0]![0].session.sessionId).toBe(s.sessionId);
    expect(map.get(sessionKey('om_exists', 'app_test'))).toBeDefined();
  });
});
