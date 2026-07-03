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
 *   - CLI mismatch → closeSession, so a worker-less old session cannot lazy-resume
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
// Mutable bot-side wrapperCli for the wrapper-axis mismatch tests.
const bot = vi.hoisted(() => ({ wrapperCli: undefined as string | undefined }));

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
  getActiveSessionsRegistry: vi.fn(() => wp.registry ?? undefined),
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
    config: { larkAppId: 'app_test', cliId: 'claude-code', wrapperCli: bot.wrapperCli, workingDir: '~', workingDirs: ['~'] },
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

import { restoreActiveSessions, closeCliMismatchedSessionsForBot } from '../src/core/session-manager.js';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
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
  bot.wrapperCli = undefined;
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

  it('CLI mismatch on restore → closes the active record even when the backend server is down', async () => {
    // This is the config-switch case: the bot now points at a different CLI,
    // but an old active session still has its original cliId frozen. If restore
    // kept it worker-less for lazy resume, the next @mention would resurrect the
    // old CLI instead of creating a clean session with the current bot config.
    probe.result = 'missing';
    server.state = 'down';
    const s = makeActivePersistentSession('om_cli_mismatch');
    s.cliId = 'codex';
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(map.get(sessionKey('om_cli_mismatch', 'app_test'))).toBeUndefined();
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('wrapper mismatch on restore (same cliId) → closes the active record', async () => {
    // 'aiden x claude' and bare claude-code share cliId='claude-code' but are
    // distinct launch choices (selectionKeyForBot keys on cliId+wrapperCli).
    // A frozen wrapper snapshot that differs from the bot's current wrapper is
    // the same config-switch case as a cliId change and must close too.
    probe.result = 'missing';
    server.state = 'down';
    const s = makeActivePersistentSession('om_wrapper_mismatch');
    s.wrapperCli = 'aiden x claude';
    s.agentFrozen = true;
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(announceSessionRow).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(map.get(sessionKey('om_wrapper_mismatch', 'app_test'))).toBeUndefined();
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('frozen wrapper matching the bot wrapper → NOT a mismatch, session kept', async () => {
    probe.result = 'missing';
    server.state = 'down';
    bot.wrapperCli = 'aiden x claude';
    const s = makeActivePersistentSession('om_wrapper_match');
    s.wrapperCli = 'aiden x claude';
    s.agentFrozen = true;
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.get(sessionKey('om_wrapper_match', 'app_test'))).toBeDefined();
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
  });

  it('legacy unfrozen session survives a bot that gained a wrapper (back-fills on next fork)', async () => {
    // agentFrozen=false means the session predates agent freezing: its next
    // fork back-fills wrapper/model from the live bot config, so it launches
    // exactly what the bot is configured for — closing it would be a false
    // positive.
    probe.result = 'missing';
    server.state = 'down';
    bot.wrapperCli = 'aiden x claude';
    const s = makeActivePersistentSession('om_wrapper_legacy');
    sessionStore.updateSession(s);
    const map = new Map<string, DaemonSession>();
    wp.registry = map;

    await restoreActiveSessions(map);

    expect(closeSession).not.toHaveBeenCalled();
    expect(map.get(sessionKey('om_wrapper_legacy', 'app_test'))).toBeDefined();
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
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

// ─── Runtime hot-switch sweep (closeCliMismatchedSessionsForBot) ─────────────
//
// The dashboard PUT /api/bot-agent hot-swaps a bot's cliId/wrapperCli without a
// daemon restart, so the restore-time guard never runs; this sweep is its
// runtime counterpart. Same mismatch predicate, same exemptions (queued /
// adopt), scoped to one bot's larkAppId.
describe('closeCliMismatchedSessionsForBot — runtime CLI hot-switch sweep', () => {
  /** Register a minimal restored-style DaemonSession into wp.registry. */
  function registerDs(s: ReturnType<typeof makeActivePersistentSession>, larkAppId = 'app_test') {
    const ds = {
      session: s,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: s.chatId,
      chatType: 'group' as const,
      scope: 'thread' as const,
      spawnedAt: Date.now(),
      cliVersion: '1.0.0-test',
      lastMessageAt: Date.now(),
      hasHistory: true,
      workingDir: s.workingDir,
    } as unknown as DaemonSession;
    wp.registry!.set(sessionKey(s.rootMessageId, larkAppId), ds);
    return ds;
  }

  beforeEach(() => {
    wp.registry = new Map<string, DaemonSession>();
  });

  it('closes mismatched sessions of this bot, keeps matching ones', async () => {
    const stale = makeActivePersistentSession('om_rt_stale');
    stale.cliId = 'codex';
    sessionStore.updateSession(stale);
    registerDs(stale);
    const fresh = makeActivePersistentSession('om_rt_fresh');
    registerDs(fresh);

    const closed = await closeCliMismatchedSessionsForBot('app_test');

    expect(closed).toBe(1);
    expect(closeSession).toHaveBeenCalledWith(stale.sessionId);
    expect(sessionStore.getSession(stale.sessionId)!.status).toBe('closed');
    expect(wp.registry!.get(sessionKey('om_rt_stale', 'app_test'))).toBeUndefined();
    expect(sessionStore.getSession(fresh.sessionId)!.status).toBe('active');
    expect(wp.registry!.get(sessionKey('om_rt_fresh', 'app_test'))).toBeDefined();
  });

  it('closes wrapper-axis mismatches for frozen sessions', async () => {
    const s = makeActivePersistentSession('om_rt_wrapper');
    s.wrapperCli = 'aiden x claude';
    s.agentFrozen = true;
    sessionStore.updateSession(s);
    registerDs(s);

    expect(await closeCliMismatchedSessionsForBot('app_test')).toBe(1);
    expect(sessionStore.getSession(s.sessionId)!.status).toBe('closed');
  });

  it('exempts queued and adopt sessions, and other bots\' sessions', async () => {
    const queued = makeActivePersistentSession('om_rt_queued');
    queued.cliId = 'codex';
    queued.queued = true;
    sessionStore.updateSession(queued);
    registerDs(queued);

    const adopt = makeActivePersistentSession('om_rt_adopt');
    adopt.cliId = 'codex';
    adopt.title = 'Adopt: my-pane';
    adopt.adoptedFrom = { source: 'tmux', tmuxTarget: 'ext:0.0', cliId: 'codex', cwd: '/tmp' } as any;
    sessionStore.updateSession(adopt);
    registerDs(adopt);

    const otherBot = makeActivePersistentSession('om_rt_other');
    otherBot.cliId = 'codex';
    otherBot.larkAppId = 'app_other';
    sessionStore.updateSession(otherBot);
    registerDs(otherBot, 'app_other');

    expect(await closeCliMismatchedSessionsForBot('app_test')).toBe(0);
    expect(closeSession).not.toHaveBeenCalled();
    for (const s of [queued, adopt, otherBot]) {
      expect(sessionStore.getSession(s.sessionId)!.status).toBe('active');
    }
  });

  it('live-worker mismatch → closes gracefully WITHOUT pre-killing the backing pane', async () => {
    // With a live worker, closeSession's close IPC lets the worker tear down
    // its own backing session; a daemon-side hard kill first would race the
    // worker's exit handling. Pre-kill is reserved for worker-less records.
    const s = makeActivePersistentSession('om_rt_live');
    s.cliId = 'codex';
    sessionStore.updateSession(s);
    const ds = registerDs(s);
    (ds as any).worker = { killed: false };
    vi.mocked(TmuxBackend.killSession).mockClear();

    expect(await closeCliMismatchedSessionsForBot('app_test')).toBe(1);
    expect(closeSession).toHaveBeenCalledWith(s.sessionId);
    expect(TmuxBackend.killSession).not.toHaveBeenCalled();
  });

  it('returns 0 when the registry is not initialized', async () => {
    wp.registry = null;
    expect(await closeCliMismatchedSessionsForBot('app_test')).toBe(0);
  });
});
